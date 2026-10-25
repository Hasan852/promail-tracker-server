// background.js — MV3 service worker (v2.4.2).
//
// Jobs:
//   1. Track lifecycle: content.js generates track IDs instantly and injects
//      the pixel with zero server round-trip. The server record is created at
//      SEND time (commitTrack) with final metadata — the popup can never show
//      a track for an unsent mail.
//   2. Outbox: failed server writes are retried with exponential backoff and
//      a dead-letter record — nothing is silently lost.
//   3. Poll the server every 30s (chrome.alarms) with a BATCH sync
//      (GET /api/tracks?updatedSince=); fire a desktop notification only when
//      a NEW *unique* detection appears (duplicate proxy hits never notify).
//   4. Auto re-inject content.js into open Gmail tabs after install/update.
//   5. Keep an unread counter badge on the extension icon.
//   6. Google sign-in (v2.3.0): link this install's account to the user's
//      Google identity so tracking data survives extension reinstalls.
//
// Local storage is a CACHE; the server is the source of truth. On conflict,
// SERVER WINS.

const ALARM_NAME = 'pmt-poll';
// 30-second polling (Chrome's minimum supported recurring alarm interval;
// alarms may also be delayed, so nothing here promises real-time behavior).
const POLL_MINUTES = 0.5;

// Outbox: exponential backoff, bounded size, dead-letter record.
const OUTBOX_MAX_ATTEMPTS = 24;
const OUTBOX_MAX_ITEMS = 100;
const OUTBOX_BASE_DELAY_MS = 30 * 1000;
const OUTBOX_MAX_DELAY_MS = 60 * 60 * 1000;
const DEAD_LETTER_MAX = 20;

// Local cache cap (server keeps full history).
const DEFAULT_MAX_TRACKS = 500;
const KEEP_UNSENT_MS = 2 * 86400000; // composes that were never sent
const MAX_OWN_IDS = 3000;
const REQUEST_TIMEOUT_MS = 20000; // Render free tier can take ~30-50s to wake: don't give up at 8s
// The server clock decides what is "new". Re-asking for the last minute on every
// poll closes the gap between a query and its serverTime.
const SYNC_OVERLAP_MS = 60 * 1000;
// A detection younger than this may still be flagged as the sender's own view
// (the extension signals within a couple of seconds). Notifying is deferred
// to the next poll instead of risking a false alert.
const SETTLE_MS = 12 * 1000;

// Pre-configured server — works out of the box; the options page overrides it.
let DEFAULT_SERVER_URL = 'https://promail-tracker-server.onrender.com';
try { importScripts('config.js'); DEFAULT_SERVER_URL = PMT_DEFAULT_SERVER_URL; } catch (e) { /* tests / non-worker */ }

/* ================= pure helpers (unit-tested) ================= */

// v2.2.0 (pure): track-id format guard — only our own ids are trusted.
function isValidTrackId(id) {
  return /^trk_[A-Za-z0-9]{12}$/.test(id || '');
}

// v2.2.0 (pure): next retry delay with exponential backoff, capped.
function outboxNextDelayMs(attempts) {
  return Math.min(OUTBOX_BASE_DELAY_MS * 2 ** Math.max(0, attempts), OUTBOX_MAX_DELAY_MS);
}

// v2.2.0 (pure): append an item to the outbox, dropping the oldest when full.
function outboxPush(outbox, item, maxItems) {
  const next = (outbox || []).slice();
  next.push(item);
  while (next.length > maxItems) next.shift();
  return next;
}

// v2.2.0 (pure): builds the local track record stored in chrome.storage.
// Deferred tracks (compose opened, not yet sent) carry sent:0 so the popup
// hides them until the mail is actually sent.
function buildLocalTrack(subject, to, from, serverUrl, deferred) {
  return {
    subject: subject || '',
    recipient: to || '',
    sender: from || '',
    serverUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    analytics: null, // server-derived; null until first sync
    recentEvents: [], // capped cache of latest detection events
    lastUniqueNotified: 0,
    lastNotifiedAt: 0,
    sent: deferred ? 0 : 1,
  };
}

// v2.2.0 (pure): applies field updates to the local cached track.
function applyLocalUpdate(t, fields) {
  if (typeof fields.subject === 'string') t.subject = fields.subject;
  if (typeof fields.to === 'string') t.recipient = fields.to;
  if (typeof fields.from === 'string') t.sender = fields.from;
  if (fields.sent === 1 || fields.sent === 0) t.sent = fields.sent;
  t.updatedAt = new Date().toISOString();
  return t;
}

// v2.2.0 (pure): merge one server track into the local cache. SERVER WINS on
// every shared field. Returns how many NEW unique detections appeared.
function applyServerTrack(t, st) {
  const prevUnique = Math.max(t.lastUniqueNotified || 0, 0);
  if (st.subject !== undefined) t.subject = st.subject || '';
  if (st.recipient !== undefined) t.recipient = st.recipient || '';
  if (st.sender !== undefined) t.sender = st.sender || '';
  if (st.sent !== undefined) t.sent = st.sent ? 1 : 0;
  if (st.parent_track_id !== undefined) t.parent_track_id = st.parent_track_id || null;
  if (st.primary_recipient !== undefined) t.primary_recipient = st.primary_recipient || '';
  if (st.updated_at) t.updatedAt = st.updated_at;
  if (st.sent_at) t.sentAt = st.sent_at;
  if (st.analytics) t.analytics = st.analytics;
  if (Array.isArray(st.events)) {
    t.recentEvents = st.events.slice(-20).map((e) => ({
      received_at: e.received_at || e.opened_at || null,
      device: e.device || '',
      event_type: e.event_type || (e.is_gmail_proxy ? 'GMAIL_PROXY' : 'UNKNOWN'),
      is_suspected_self_view: !!e.is_suspected_self_view,
    }));
  } else if (Array.isArray(st.opens)) {
    // Legacy server shape: raw opens array.
    t.recentEvents = st.opens.slice(-20).map((o) => ({
      received_at: o.opened_at || null,
      device: o.device || '',
      event_type: o.is_gmail_proxy ? 'GMAIL_PROXY' : 'UNKNOWN',
      is_suspected_self_view: false,
    }));
    const raw = st.opens.length;
    t.analytics = t.analytics || {
      raw_event_count: raw,
      estimated_unique_events: raw,
      proxy_event_count: st.opens.filter((o) => o.is_gmail_proxy).length,
      direct_event_count: 0,
      first_detected_at: raw ? st.opens[0].opened_at : null,
      last_detected_at: raw ? st.opens[raw - 1].opened_at : null,
    };
  }
  const curUnique = Math.max((t.analytics && t.analytics.estimated_unique_events) || 0, 0);
  return { newUnique: Math.max(0, curUnique - prevUnique), curUnique };
}

// v2.2.0 (pure): migrate a v2.1 local track (opens array, counters) to the
// v2.2 shape without losing the notification baseline.
function migrateLocalTrack(t) {
  if (t && t.analytics) return t;
  const opens = Array.isArray(t.opens) ? t.opens : [];
  t.analytics = {
    raw_event_count: opens.length,
    estimated_unique_events: opens.length,
    proxy_event_count: opens.filter((o) => o.is_gmail_proxy).length,
    direct_event_count: 0,
    first_detected_at: opens.length ? opens[0].opened_at : null,
    last_detected_at: opens.length ? opens[opens.length - 1].opened_at : null,
  };
  t.recentEvents = opens.slice(-20).map((o) => ({
    received_at: o.opened_at || null,
    device: o.device || '',
    event_type: o.is_gmail_proxy ? 'GMAIL_PROXY' : 'UNKNOWN',
    is_suspected_self_view: false,
  }));
  t.lastUniqueNotified = t.lastOpenCount || opens.length;
  delete t.opens;
  delete t.lastOpenCount;
  return t;
}


// v2.4.2 (pure): upsert by (op,id) so a newer request replaces a stale one.
function outboxUpsert(outbox, item, maxItems) {
  const next = (outbox || []).filter((o) => !(o.op === item.op && o.id === item.id));
  next.push(item);
  while (next.length > maxItems) next.shift();
  return next;
}

// v2.4.2 (pure): remember ids of our own mails (the Gmail tab removes our own
// pixel from the sender's view). Bounded, most recent last.
function pushOwnId(ownIds, id, max) {
  const next = (ownIds || []).filter((x) => x !== id);
  next.push(id);
  while (next.length > max) next.shift();
  return next;
}

// v2.4.2 (pure): metadata merge that never blanks good values with empty ones
// (Gmail strips To chips at Send time).
function mergeMeta(t, fields) {
  if (typeof fields.subject === 'string' && fields.subject) t.subject = fields.subject;
  if (typeof fields.to === 'string' && fields.to) t.recipient = fields.to;
  if (typeof fields.from === 'string' && fields.from) t.sender = fields.from;
  t.updatedAt = new Date().toISOString();
  return t;
}

// v2.4.2 (pure): is the newest detection still inside the self-view settle window?
function isFreshDetection(lastDetectedAt, serverTimeMs) {
  const ms = Date.parse(lastDetectedAt || '');
  return Number.isFinite(ms) && serverTimeMs - ms < SETTLE_MS;
}

// v2.4.2 (pure): bounded local cache. Never-sent composes expire after 2 days
// (they used to accumulate forever); sent mails beyond the cap drop oldest first.
function pruneLocalTracks(tracks, maxTracks, nowMs) {
  for (const id of Object.keys(tracks)) {
    const t = tracks[id];
    const created = Date.parse(t.createdAt || '') || nowMs;
    if (t.sent === 0 && nowMs - created > KEEP_UNSENT_MS) delete tracks[id];
  }
  const ids = Object.keys(tracks);
  if (ids.length > maxTracks) {
    const sentIds = ids.filter((id) => tracks[id].sent !== 0)
      .sort((a, b) => String(tracks[a].updatedAt || '').localeCompare(String(tracks[b].updatedAt || '')));
    for (const id of sentIds.slice(0, ids.length - maxTracks)) delete tracks[id];
  }
  return tracks;
}

function recipientOnly(track) {
  // v2.4.0: prefer the server-computed primary recipient (automated
  // noreply-style addresses filtered out); fall back to the old join.
  if (track.primary_recipient) return track.primary_recipient;
  const sender = String(track.sender || '').trim().toLowerCase();
  return String(track.recipient || '').split(/[;,]/)
    .map((email) => email.trim())
    .filter((email) => email && (!sender || email.toLowerCase() !== sender))
    .join(', ') || '(unknown recipient)';
}

// Honest detection label for one event: proxy hides the real client.
function eventLabel(e) {
  if (!e) return 'Detected';
  if (e.event_type === 'GMAIL_PROXY') return 'Detected via Gmail';
  if (e.event_type === 'OTHER_PROXY') return 'Detected via proxy';
  const d = e.device || '';
  if (/mobile/i.test(d)) return 'Detected on Mobile';
  if (/tablet|ipad/i.test(d)) return 'Detected on Tablet';
  if (/desktop/i.test(d)) return 'Detected on Desktop';
  return 'Detected';
}

function latestRealEvent(t) {
  const evs = (t.recentEvents || []).filter((e) => !e.is_suspected_self_view);
  return evs.length ? evs[evs.length - 1] : null;
}

/* ================= storage / auth / lock ================= */

// One token per install, generated once. Memoised so concurrent first calls
// (bootstrap + poll at install time) can never mint two different tokens.
let tokenPromise = null;
function getAuthToken() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const d = await chrome.storage.local.get(['authToken']);
      if (d.authToken && /^pmt_[A-Za-z0-9_-]{32,128}$/.test(d.authToken)) return d.authToken;
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const token = 'pmt_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await chrome.storage.local.set({ authToken: token });
      return token;
    })().catch((e) => { tokenPromise = null; throw e; });
  }
  return tokenPromise;
}

async function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-PMT-Key': await getAuthToken() };
}

async function getStore() {
  const d = await chrome.storage.local.get([
    'serverUrl', 'tracks', 'unread', 'outbox', 'deadLetter',
    'lastSyncAt', 'timezone', 'notificationsEnabled', 'privacyMode', 'maxTracks',
    'googleAccount', 'ownIds',
  ]);
  const tracks = d.tracks || {};
  for (const id of Object.keys(tracks)) {
    try { migrateLocalTrack(tracks[id]); } catch (e) { /* keep going */ }
  }
  return {
    serverUrl: (d.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    tracks,
    unread: d.unread || 0,
    outbox: d.outbox || [],
    deadLetter: d.deadLetter || [],
    lastSyncAt: d.lastSyncAt || null,
    timezone: d.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    notificationsEnabled: d.notificationsEnabled !== false,
    privacyMode: d.privacyMode === true,
    maxTracks: Math.min(Math.max(parseInt(d.maxTracks, 10) || DEFAULT_MAX_TRACKS, 50), 5000),
    googleAccount: d.googleAccount || null,
    ownIds: d.ownIds || [],
  };
}

async function saveStore(patch) {
  await chrome.storage.local.set(patch);
}

// EVERY read-modify-write of tracks / outbox / unread goes through this lock.
// Network calls happen OUTSIDE it, and results are merged into a FRESH read
// inside it — a slow poll can no longer overwrite a track that was created or
// committed while it was waiting for the server (v2.4.1 lost mails this way).
let lockChain = Promise.resolve();
function locked(fn) {
  const run = lockChain.then(fn);
  lockChain = run.catch(() => {});
  return run;
}
// fn(store) -> { patch?, result? }. Never call update() from inside fn.
function update(fn) {
  return locked(async () => {
    const s = await getStore();
    const out = (await fn(s)) || {};
    if (out.patch) await saveStore(out.patch);
    return out.result;
  });
}

function api(path, serverUrl) {
  return serverUrl + path;
}

async function ensureServerAccount(serverUrl) {
  try {
    const res = await fetch(api('/api/bootstrap', serverUrl), {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    let j = {};
    try { j = await res.json(); } catch (e) { /* ignore */ }
    return { ok: true, privacyMode: typeof j.privacyMode === 'boolean' ? j.privacyMode : undefined };
  } catch (e) { return { ok: false }; }
}

/* ================= server calls ================= */

async function serverCreateTrack(serverUrl, payload, deferred) {
  const headers = await authHeaders();
  const res = await fetch(api('/api/tracks', serverUrl), {
    method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return { ok: true };
  if (res.status !== 404) throw new Error('server-error ' + res.status);
  // 404 = server older than v2.2 (no such route): LEGACY fallback.
  const q = 'id=' + encodeURIComponent(payload.id) +
    '&subject=' + encodeURIComponent(payload.subject || '') +
    '&to=' + encodeURIComponent(payload.to || '') +
    '&from=' + encodeURIComponent(payload.from || '') + (deferred ? '&deferred=1' : '');
  const r2 = await fetch(api('/api/create-track?' + q, serverUrl), {
    headers: { 'X-PMT-Key': headers['X-PMT-Key'] }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r2.ok) throw new Error('server-error ' + r2.status);
  return { ok: true, legacy: true };
}

// Commit = "this mail was sent". The v2.4.2 server creates the track here if it
// has never seen it, so a failed compose-time create can no longer lose the mail.
async function serverCommitTrack(serverUrl, payload) {
  const headers = await authHeaders();
  const res = await fetch(api('/api/tracks/' + encodeURIComponent(payload.id) + '/commit', serverUrl), {
    method: 'POST', headers,
    body: JSON.stringify({ subject: payload.subject, to: payload.to, from: payload.from }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return { ok: true };
  if (res.status !== 404) throw new Error('server-error ' + res.status);
  // 404 = server older than v2.2: LEGACY create-track WITHOUT deferred means "sent".
  const q = 'id=' + encodeURIComponent(payload.id) +
    '&subject=' + encodeURIComponent(payload.subject || '') +
    '&to=' + encodeURIComponent(payload.to || '') +
    '&from=' + encodeURIComponent(payload.from || '');
  const r2 = await fetch(api('/api/create-track?' + q, serverUrl), {
    headers: { 'X-PMT-Key': headers['X-PMT-Key'] }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r2.ok) throw new Error('server-error ' + r2.status);
  return { ok: true, legacy: true };
}

function queueOutbox(op, payload, err) {
  return update(async (s) => ({
    patch: {
      outbox: outboxUpsert(s.outbox, {
        op, id: payload.id, subject: payload.subject || '', to: payload.to || '', from: payload.from || '',
        attempts: 0, lastAttemptAt: 0, nextRetryAt: Date.now(), lastError: String((err && err.message) || err).slice(0, 200),
      }, OUTBOX_MAX_ITEMS),
    },
  }));
}

/* ================= track lifecycle ================= */

// Compose-time preparation — LOCAL record first (the pixel is already in the
// mail), then a best-effort server registration that never blocks Compose.
async function prepareTrack(id, subject, to, from) {
  if (!isValidTrackId(id)) return { ok: false };
  const res = await update(async (s) => {
    s.tracks[id] = buildLocalTrack(subject, to, from, s.serverUrl, true);
    pruneLocalTracks(s.tracks, s.maxTracks, Date.now());
    return {
      patch: { tracks: s.tracks, ownIds: pushOwnId(s.ownIds, id, MAX_OWN_IDS) },
      result: { ok: true, trackId: id, serverUrl: s.serverUrl },
    };
  });
  (async () => {
    try {
      await serverCreateTrack(res.serverUrl, { id, subject, to, from }, true);
    } catch (e) {
      await queueOutbox('create', { id, subject, to, from }, e);
    }
  })();
  return res;
}

// Send-time commit: the mail is really going out. Idempotent server-side, and
// self-healing client-side (works even if the local record was lost).
async function commitTrack(trackId, subject, to, from) {
  if (!isValidTrackId(trackId)) return { ok: false };
  const snap = await update(async (s) => {
    let t = s.tracks[trackId];
    if (!t) { t = buildLocalTrack('', '', '', s.serverUrl, false); s.tracks[trackId] = t; }
    mergeMeta(t, { subject, to, from });
    t.sent = 1;
    t.hidden = false;
    // A queued compose-time create is now obsolete — and must not overwrite the final metadata.
    const outbox = s.outbox.filter((o) => !(o.op === 'create' && o.id === trackId));
    return {
      patch: { tracks: s.tracks, outbox, ownIds: pushOwnId(s.ownIds, trackId, MAX_OWN_IDS) },
      result: { serverUrl: s.serverUrl, payload: { id: trackId, subject: t.subject, to: t.recipient, from: t.sender } },
    };
  });
  try {
    await serverCommitTrack(snap.serverUrl, snap.payload);
    return { ok: true };
  } catch (e) {
    await queueOutbox('commit', snap.payload, e);
    return { ok: true, queued: true };
  }
}

// Retry queued server requests with exponential backoff. Runs on every poll.
// Network happens outside the lock; results are merged into the CURRENT outbox
// so items queued meanwhile are never dropped.
async function flushOutbox() {
  const { serverUrl, outbox } = await getStore();
  if (!outbox || outbox.length === 0) return;
  const now = Date.now();
  const results = [];
  for (const item of outbox) {
    if (item.nextRetryAt && item.nextRetryAt > now) continue;
    let ok = false;
    let err = '';
    try {
      if ((item.op === 'create' || item.op === 'commit') && isValidTrackId(item.id)) {
        if (item.op === 'create') await serverCreateTrack(serverUrl, item, true);
        else await serverCommitTrack(serverUrl, item);
      }
      ok = true; // unknown ops are dropped, never retried forever
    } catch (e) { err = String((e && e.message) || e).slice(0, 200); }
    results.push({ op: item.op, id: item.id, ok, err });
  }
  if (!results.length) return;
  await update(async (s) => {
    const dead = (s.deadLetter || []).slice();
    const next = [];
    for (const item of s.outbox) {
      const r = results.find((x) => x.op === item.op && x.id === item.id);
      if (!r) { next.push(item); continue; }
      if (r.ok) continue;
      item.attempts = (item.attempts || 0) + 1;
      item.lastAttemptAt = now;
      item.lastError = r.err;
      if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
        dead.push({ op: item.op, id: item.id, subject: item.subject, attempts: item.attempts, lastError: r.err, at: new Date(now).toISOString() });
        while (dead.length > DEAD_LETTER_MAX) dead.shift();
      } else {
        item.nextRetryAt = now + outboxNextDelayMs(item.attempts);
        next.push(item);
      }
    }
    return { patch: { outbox: next, deadLetter: dead } };
  });
}

// Local-only metadata touch (debounced while typing).
async function touchTrack(trackId, subject, to, from) {
  if (!isValidTrackId(trackId)) return { ok: false };
  return update(async (s) => {
    const t = s.tracks[trackId];
    if (!t) return { result: { ok: false } };
    mergeMeta(t, { subject, to, from });
    return { patch: { tracks: s.tracks }, result: { ok: true } };
  });
}

// Sender viewed their own sent mail — tell the server (flag model).
async function selfView(trackId) {
  if (!/^trk_[A-Za-z0-9]+$/.test(trackId || '')) return { ok: false };
  const { serverUrl } = await getStore();
  const headers = await authHeaders();
  try {
    const res = await fetch(api('/api/tracks/' + encodeURIComponent(trackId) + '/self-view', serverUrl), {
      method: 'POST', headers, body: JSON.stringify({}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    if (res.status !== 404) return { ok: false };
  } catch (e) { return { ok: false }; }
  try { // LEGACY server
    const res = await fetch(api('/api/self-view/' + encodeURIComponent(trackId), serverUrl), {
      headers: { 'X-PMT-Key': headers['X-PMT-Key'] }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false };
  }
}

/* ================= Google sign-in (v2.3.0) ================= */

// chrome.identity returns a Google OAuth access token for the profile's Google
// account. Scopes are identity-only (openid, email, profile) — the extension
// never gets Gmail API access. The token is POSTed to the server ONCE for
// verification + account linking, then discarded; only the link (google_sub)
// persists server-side, which is what makes data survive a reinstall.
function identityToken() {
  return new Promise((resolve, reject) => {
    try {
      const p = chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(token || null);
      });
      // Promise-style API (Chrome 116+): resolves with the token string OR {token}.
      if (p && typeof p.then === 'function') {
        p.then((r) => resolve(typeof r === 'string' ? r : (r && r.token) || null), reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function googleSignIn() {
  const { serverUrl } = await getStore();
  if (!serverUrl) return { ok: false, error: 'no server configured' };
  let token;
  try {
    token = await identityToken();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  if (!token) return { ok: false, error: 'sign-in was cancelled' };
  try {
    const res = await fetch(api('/api/auth/google', serverUrl), {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ google_access_token: token }),
      signal: AbortSignal.timeout(15000),
    });
    let j = {};
    try { j = await res.json(); } catch (e) { /* ignore */ }
    try { await chrome.identity.removeCachedAuthToken({ token }); } catch (e) { /* ignore */ }
    if (!res.ok) return { ok: false, error: String((j && j.error) || ('server error ' + res.status)).slice(0, 200) };
    await saveStore({ googleAccount: { email: j.email || '', linkedAt: new Date().toISOString() } });
    // The sign-in may have merged this install into a previously linked
    // account — refresh the local cache under the merged account.
    await pollTracks();
    return { ok: true, email: j.email || '', mergedTracks: j.mergedTracks || 0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Sign-out is LOCAL ONLY: it clears this browser's Google session. The
// server-side link is intentionally kept, so reinstalling the extension and
// signing in again still restores the data.
async function googleSignOut() {
  try {
    const token = await new Promise((resolve) => {
      try {
        const p = chrome.identity.getAuthToken({ interactive: false }, (t) => {
          resolve(chrome.runtime.lastError ? null : (t || null));
        });
        if (p && typeof p.then === 'function') {
          p.then((r) => resolve(typeof r === 'string' ? r : (r && r.token) || null), () => resolve(null));
        }
      } catch (e) { resolve(null); }
    });
    if (token) {
      try { await chrome.identity.removeCachedAuthToken({ token }); } catch (e) { /* ignore */ }
      try {
        await fetch('https://accounts.google.com/o/oauth2/revoke?token=' + encodeURIComponent(token), {
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  await saveStore({ googleAccount: null });
  return { ok: true };
}

async function googleStatus() {
  const { googleAccount } = await getStore();
  return { ok: true, account: googleAccount };
}

/* ================= sync + notifications ================= */

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}

// Batch sync via updatedSince; falls back to per-track legacy calls.
async function fetchChangedTracks(serverUrl, headers, since, knownIds) {
  const url = api('/api/tracks?all=1&limit=500' + (since ? '&updatedSince=' + encodeURIComponent(since) : ''), serverUrl);
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    return { mode: 'offline' };
  }
  if (res.status === 404) {
    // Pre-2.2 server: per-track legacy sync.
    const tracks = [];
    for (const id of knownIds) {
      try {
        const r = await fetch(api('/api/status/' + encodeURIComponent(id), serverUrl), {
          headers: { 'X-PMT-Key': headers['X-PMT-Key'] }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!r.ok) continue;
        const st = await r.json();
        st.id = id;
        tracks.push(st);
      } catch (e) { /* server napping — next tick */ }
    }
    return { mode: 'legacy', tracks, serverTime: new Date().toISOString() };
  }
  if (!res.ok) return { mode: 'offline' };
  const body = await res.json();
  if (!body || !Array.isArray(body.tracks)) return { mode: 'offline' };
  return { mode: 'batch', tracks: body.tracks, serverTime: body.serverTime || new Date().toISOString() };
}

let pollInProgress = false;

async function pollTracks() {
  if (pollInProgress) return { skipped: true }; // never run two polls at once
  pollInProgress = true;
  try {
    return await pollTracksInner();
  } finally {
    pollInProgress = false;
  }
}

async function pollTracksInner() {
  const s0 = await getStore();
  const { serverUrl } = s0;
  const boot = await ensureServerAccount(serverUrl);
  await flushOutbox();

  const s1 = await getStore();
  const headers = await authHeaders();
  const since = s1.lastSyncAt ? new Date(Math.max(0, Date.parse(s1.lastSyncAt) - SYNC_OVERLAP_MS)).toISOString() : null;
  const fetched = await fetchChangedTracks(serverUrl, headers, since, Object.keys(s1.tracks));
  if (fetched.mode === 'offline') return { ok: false, offline: true };
  const serverNow = Date.parse(fetched.serverTime) || Date.now();

  // Merge into a FRESH read, under the lock (network is already done).
  const out = await update(async (s) => {
    const { tracks } = s;
    let newUnread = s.unread;
    let outbox = s.outbox;
    let ownIds = s.ownIds;
    const notes = [];

    for (const st of fetched.tracks) {
      if (!st || !isValidTrackId(st.id)) continue;
      let t = tracks[st.id];
      if (!t) {
        // On the server but not in this cache (another profile / reinstall /
        // pruned): adopt it — and remember it as ours so our own pixel is guarded.
        t = buildLocalTrack(st.subject, st.recipient, st.sender, serverUrl, false);
        tracks[st.id] = t;
        ownIds = pushOwnId(ownIds, st.id, MAX_OWN_IDS);
      }
      const localSent = t.sent;
      const { newUnique, curUnique } = applyServerTrack(t, st);
      // We know this mail was sent; the server hasn't caught up yet (commit still
      // in flight / queued). Never flip it back to "unsent" — and make sure a
      // commit is on its way (bounded).
      if (localSent === 1 && t.sent === 0) {
        t.sent = 1;
        const queued = outbox.some((o) => o.op === 'commit' && o.id === st.id);
        if (!queued && (t.recommits || 0) < 5) {
          t.recommits = (t.recommits || 0) + 1;
          outbox = outboxUpsert(outbox, {
            op: 'commit', id: st.id, subject: t.subject, to: t.recipient, from: t.sender,
            attempts: 0, lastAttemptAt: 0, nextRetryAt: Date.now(), lastError: 'server reports unsent',
          }, OUTBOX_MAX_ITEMS);
        }
      }
      // A detection this young could still be the sender's own view being
      // flagged: leave the baseline alone, the next poll (overlap window)
      // re-delivers it once it has settled.
      const fresh = newUnique > 0 && isFreshDetection(t.analytics && t.analytics.last_detected_at, serverNow);
      if (newUnique > 0 && !fresh && s.notificationsEnabled) {
        const latest = latestRealEvent(t);
        const label = eventLabel(latest);
        const subj = t.subject ? `“${t.subject}”` : 'your email';
        const when = latest && latest.received_at ? ` · ${fmtTime(latest.received_at)}` : '';
        notes.push({
          id: st.id,
          message: `To: ${recipientOnly(t)}\n${subj} — ${label.toLowerCase()}${when}${newUnique > 1 ? ` (+${newUnique - 1} more)` : ''}`,
        });
        newUnread += newUnique;
        t.lastNotifiedAt = Date.now();
        t.hidden = false; // a hidden (cleared) mail reappears when it is detected again
      }
      // Baseline follows the server (SERVER WINS). It may go DOWN when the
      // server flags a self-view — otherwise the next real detection would be
      // swallowed as "already notified".
      if (!fresh) t.lastUniqueNotified = curUnique;
    }

    pruneLocalTracks(tracks, s.maxTracks, Date.now());
    const patch = { tracks, unread: newUnread, outbox, ownIds, lastSyncAt: fetched.serverTime || new Date().toISOString() };
    if (boot.ok && typeof boot.privacyMode === 'boolean') patch.privacyMode = boot.privacyMode; // server wins
    return { patch, result: { notes, unread: newUnread } };
  });

  for (const n of out.notes) {
    try {
      await chrome.notifications.create('pmt-' + n.id + '-' + Date.now(), {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'Email detected', message: n.message,
      });
    } catch (e) { /* notifications blocked — badge still counts */ }
  }
  try {
    await chrome.action.setBadgeText({ text: out.unread > 0 ? String(Math.min(out.unread, 99)) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#0b7a55' });
  } catch (e) { /* ignore */ }
  return { ok: true, changed: fetched.tracks.length > 0 };
}

/* ================= wiring ================= */

try {
  chrome.notifications.onClicked.addListener((nid) => { chrome.notifications.clear(nid); });
  chrome.notifications.onButtonClicked.addListener((nid) => { chrome.notifications.clear(nid); });
} catch (e) { /* non-browser (tests) */ }

function scheduleAlarm() {
  try { chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES }); } catch (e) { /* tests */ }
}

// Also when the worker wakes without an install/startup event.
try {
  chrome.alarms.get(ALARM_NAME, (a) => { if (!a) scheduleAlarm(); });
} catch (e) { /* tests */ }

try {
  chrome.runtime.onInstalled.addListener(() => {
    scheduleAlarm();
    getStore().then((s) => ensureServerAccount(s.serverUrl));
    reinjectContentScripts();
    pollTracks();
  });
  chrome.runtime.onStartup.addListener(() => {
    scheduleAlarm();
    getStore().then((s) => ensureServerAccount(s.serverUrl));
    reinjectContentScripts();
    pollTracks();
  });
} catch (e) { /* tests */ }

// After install/update, content scripts in already-open Gmail tabs are dead
// ("Extension context invalidated"). Re-inject so the user never presses F5.
// content.js's __pmtBooted guard makes re-injection safe.
async function reinjectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e) { /* tab closing, privileged page, etc. */ }
    }
  } catch (e) { /* ignore */ }
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) pollTracks();
  });
} catch (e) { /* tests */ }

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'PMT_PREPARE_TRACK': return prepareTrack(msg.id, msg.subject, msg.to, msg.from);
    case 'PMT_TOUCH_TRACK': return touchTrack(msg.trackId, msg.subject, msg.to, msg.from);
    case 'PMT_COMMIT_TRACK': return commitTrack(msg.trackId, msg.subject, msg.to, msg.from);
    case 'PMT_SELF_VIEW': return selfView(msg.trackId);
    case 'PMT_POLL_NOW': await pollTracks(); return { ok: true };
    case 'PMT_CLEAR_BADGE':
      await update(async () => ({ patch: { unread: 0 } }));
      try { await chrome.action.setBadgeText({ text: '' }); } catch (e) { /* ignore */ }
      return { ok: true };
    case 'PMT_CLEAR_LIST': // hide rows in the popup; Gmail ticks, ownership and sync keep working
      return update(async (s) => {
        for (const id of Object.keys(s.tracks)) s.tracks[id].hidden = true;
        return { patch: { tracks: s.tracks, unread: 0 }, result: { ok: true } };
      });
    case 'PMT_GET_TICK_DATA': {
      // Tick marks in Gmail: detection analytics per track (server-synced).
      const { tracks } = await getStore();
      return {
        ok: true,
        tracks: Object.keys(tracks).map((id) => {
          const t = tracks[id];
          const a = t.analytics || {};
          const last = latestRealEvent(t);
          return {
            id,
            subject: t.subject || '',
            recipient: t.recipient || '',
            sender: t.sender || '',
            sent: t.sent === 0 ? 0 : 1,
            createdAt: t.createdAt || '',
            rawCount: a.raw_event_count || 0,
            uniqueCount: a.estimated_unique_events || 0,
            firstDetectedAt: a.first_detected_at || null,
            lastDetectedAt: a.last_detected_at || null,
            viaGmail: !!(last && last.event_type === 'GMAIL_PROXY'),
          };
        }),
      };
    }
    case 'PMT_GOOGLE_SIGNIN': return googleSignIn();
    case 'PMT_GOOGLE_SIGNOUT': return googleSignOut();
    case 'PMT_GOOGLE_STATUS': return googleStatus();
    default: return { ok: false };
  }
}

try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Always answer — a thrown error must never leave the Gmail tab waiting.
    handleMessage(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
    return true; // async response
  });
} catch (e) { /* tests */ }

// Exported for node:test (MV3 service workers have no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isValidTrackId, outboxNextDelayMs, outboxPush, outboxUpsert, pushOwnId, mergeMeta,
    isFreshDetection, pruneLocalTracks, buildLocalTrack,
    applyLocalUpdate, applyServerTrack, migrateLocalTrack,
    recipientOnly, eventLabel,
  };
}
