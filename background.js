// background.js — MV3 service worker (v2.3.0).
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

// Pre-configured server — works out of the box; the options page overrides it.
const DEFAULT_SERVER_URL = 'https://promail-tracker-server.onrender.com';

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
  if (st.updated_at) t.updatedAt = st.updated_at;
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

function recipientOnly(track) {
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

/* ================= storage / auth ================= */

async function getAuthToken() {
  const d = await chrome.storage.local.get(['authToken']);
  if (d.authToken && /^pmt_[A-Za-z0-9_-]{32,128}$/.test(d.authToken)) return d.authToken;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const token = 'pmt_' + raw;
  await chrome.storage.local.set({ authToken: token });
  return token;
}

async function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-PMT-Key': await getAuthToken() };
}

async function getStore() {
  const d = await chrome.storage.local.get([
    'serverUrl', 'tracks', 'unread', 'outbox', 'deadLetter',
    'lastSyncAt', 'timezone', 'notificationsEnabled', 'privacyMode', 'maxTracks',
    'googleAccount',
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
  };
}

async function saveStore(patch) {
  await chrome.storage.local.set(patch);
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
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (e) { return false; }
}

/* ================= server calls (POST first, legacy GET fallback) ================= */

async function serverCreateTrack(serverUrl, payload, deferred) {
  const headers = await authHeaders();
  try {
    const res = await fetch(api('/api/tracks', serverUrl), {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status !== 404) throw new Error('server-error ' + res.status);
  } catch (e) {
    if (!String(e && e.message).includes('404')) throw e;
  }
  // LEGACY fallback for pre-2.2 servers.
  const q = 'id=' + encodeURIComponent(payload.id) +
    '&subject=' + encodeURIComponent(payload.subject || '') +
    '&to=' + encodeURIComponent(payload.to || '') +
    '&from=' + encodeURIComponent(payload.from || '') + (deferred ? '&deferred=1' : '');
  const res = await fetch(api('/api/create-track?' + q, serverUrl), {
    headers: { 'X-PMT-Key': (await authHeaders())['X-PMT-Key'] },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('server-error ' + res.status);
  return { ok: true, legacy: true };
}

async function serverCommitTrack(serverUrl, payload) {
  const headers = await authHeaders();
  try {
    const res = await fetch(api('/api/tracks/' + encodeURIComponent(payload.id) + '/commit', serverUrl), {
      method: 'POST', headers,
      body: JSON.stringify({ subject: payload.subject, to: payload.to, from: payload.from }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status !== 404) throw new Error('server-error ' + res.status);
  } catch (e) {
    if (!String(e && e.message).includes('404')) throw e;
  }
  // LEGACY fallback: create-track without deferred=1 upserts with sent=1.
  const q = 'id=' + encodeURIComponent(payload.id) +
    '&subject=' + encodeURIComponent(payload.subject || '') +
    '&to=' + encodeURIComponent(payload.to || '') +
    '&from=' + encodeURIComponent(payload.from || '');
  const res = await fetch(api('/api/create-track?' + q, serverUrl), {
    headers: { 'X-PMT-Key': (await authHeaders())['X-PMT-Key'] },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('server-error ' + res.status);
  return { ok: true, legacy: true };
}

/* ================= track lifecycle ================= */

// Compose-time preparation — LOCAL ONLY, no blocking server round-trip.
// The pixel is already in the email with this id; the server learns about
// the track at send time (commitTrack).
async function prepareTrack(id, subject, to, from) {
  const { serverUrl, tracks } = await getStore();
  if (!serverUrl || !isValidTrackId(id)) return { ok: false };
  tracks[id] = buildLocalTrack(subject, to, from, serverUrl, true);
  await saveStore({ tracks });

  // Register the track in the background; never block Compose on it.
  // The server keeps sent=0, so early pixel hits can never become detections.
  (async () => {
    try {
      await serverCreateTrack(serverUrl, { id, subject, to, from }, true);
    } catch (e) {
      const latest = await getStore();
      const item = {
        op: 'create', id, subject: subject || '', to: to || '', from: from || '',
        attempts: 0, lastAttemptAt: 0, nextRetryAt: Date.now(), lastError: String((e && e.message) || e).slice(0, 200),
      };
      await saveStore({ outbox: outboxPush(latest.outbox, item, OUTBOX_MAX_ITEMS) });
    }
  })();
  return { ok: true, trackId: id, serverUrl };
}

// Send-time commit: the mail is really going out. Idempotent server-side.
async function commitTrack(trackId, subject, to, from) {
  const { serverUrl, tracks } = await getStore();
  const t = tracks[trackId];
  if (!t || !serverUrl || !isValidTrackId(trackId)) return { ok: false };
  applyLocalUpdate(t, { subject, to, from, sent: 1 });
  await saveStore({ tracks });
  try {
    await serverCommitTrack(serverUrl, { id: trackId, subject, to, from });
    return { ok: true };
  } catch (e) {
    const latest = await getStore();
    const item = {
      op: 'commit', id: trackId, subject: subject || '', to: to || '', from: from || '',
      attempts: 0, lastAttemptAt: 0, nextRetryAt: Date.now(), lastError: String((e && e.message) || e).slice(0, 200),
    };
    await saveStore({ outbox: outboxPush(latest.outbox, item, OUTBOX_MAX_ITEMS) });
    return { ok: true, queued: true };
  }
}

// Retry queued server requests with exponential backoff. Runs on every poll.
async function flushOutbox() {
  const { serverUrl, outbox, deadLetter } = await getStore();
  if (!outbox || outbox.length === 0) return;
  const now = Date.now();
  const remaining = [];
  const dead = (deadLetter || []).slice();
  for (const item of outbox) {
    if (item.nextRetryAt && item.nextRetryAt > now) { remaining.push(item); continue; }
    let ok = false;
    let err = '';
    try {
      if ((item.op === 'create' || item.op === 'commit') && isValidTrackId(item.id)) {
        if (item.op === 'create') await serverCreateTrack(serverUrl, item, true);
        else await serverCommitTrack(serverUrl, item);
        ok = true;
      } else {
        ok = true; // unknown ops are dropped, never retried forever
      }
    } catch (e) { err = String((e && e.message) || e).slice(0, 200); }
    if (!ok) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastAttemptAt = now;
      item.lastError = err;
      if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
        // Permanent failure — recorded, not silently discarded.
        dead.push({ op: item.op, id: item.id, subject: item.subject, attempts: item.attempts, lastError: err, at: new Date(now).toISOString() });
        while (dead.length > DEAD_LETTER_MAX) dead.shift();
      } else {
        item.nextRetryAt = now + outboxNextDelayMs(item.attempts);
        remaining.push(item);
      }
    }
  }
  await saveStore({ outbox: remaining, deadLetter: dead });
}

// Local-only metadata touch (debounced while typing).
async function touchTrack(trackId, subject, to, from) {
  const { tracks } = await getStore();
  const t = tracks[trackId];
  if (!t) return { ok: false };
  applyLocalUpdate(t, { subject, to, from });
  await saveStore({ tracks });
  return { ok: true };
}

// Sender viewed their own sent mail — tell the server (flag model, v2.2).
async function selfView(trackId) {
  const { serverUrl } = await getStore();
  if (!serverUrl || !/^trk_[A-Za-z0-9]+$/.test(trackId || '')) return { ok: false };
  const headers = await authHeaders();
  try {
    const res = await fetch(api('/api/tracks/' + encodeURIComponent(trackId) + '/self-view', serverUrl), {
      method: 'POST', headers, body: JSON.stringify({}), signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status !== 404) return { ok: false };
  } catch (e) { /* fall through to legacy */ }
  try {
    const res = await fetch(api('/api/self-view/' + encodeURIComponent(trackId), serverUrl), {
      headers: { 'X-PMT-Key': headers['X-PMT-Key'] }, signal: AbortSignal.timeout(8000),
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
async function fetchChangedTracks(serverUrl, headers, lastSyncAt, knownIds) {
  const url = api('/api/tracks?all=1&limit=500' + (lastSyncAt ? '&updatedSince=' + encodeURIComponent(lastSyncAt) : ''), serverUrl);
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { mode: 'offline' };
  }
  if (res.status === 404) {
    // Pre-2.2 server: per-track legacy sync.
    const tracks = [];
    for (const id of knownIds) {
      try {
        const r = await fetch(api('/api/status/' + encodeURIComponent(id), serverUrl), {
          headers: { 'X-PMT-Key': headers['X-PMT-Key'] }, signal: AbortSignal.timeout(8000),
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
  const store = await getStore();
  const { serverUrl } = store;
  if (!serverUrl) return { ok: false };
  await ensureServerAccount(serverUrl);
  await flushOutbox();

  const s2 = await getStore();
  const headers = await authHeaders();
  const knownIds = Object.keys(s2.tracks);
  const fetched = await fetchChangedTracks(serverUrl, headers, s2.lastSyncAt, knownIds);
  if (fetched.mode === 'offline') return { ok: false, offline: true };

  const { tracks, unread } = s2;
  let newUnread = unread;
  let changed = false;
  const notifOn = s2.notificationsEnabled;

  for (const st of fetched.tracks) {
    if (!st || !isValidTrackId(st.id)) continue;
    let t = tracks[st.id];
    if (!t) {
      // Track exists on server but not locally (another profile, or cache
      // pruned): adopt it as a local cache entry.
      t = buildLocalTrack(st.subject, st.recipient, st.sender, serverUrl, false);
      tracks[st.id] = t;
    }
    const { newUnique, curUnique } = applyServerTrack(t, st);
    if (newUnique > 0 && notifOn) {
      const latest = latestRealEvent(t);
      const label = eventLabel(latest);
      const subj = t.subject ? `“${t.subject}”` : 'your email';
      const toLine = `To: ${recipientOnly(t)}`;
      const subjLine = `${subj} — ${label.toLowerCase()}`;
      const moreLine = newUnique > 1 ? ` (+${newUnique - 1} more)` : '';
      const when = latest && latest.received_at ? ` · ${fmtTime(latest.received_at)}` : '';
      try {
        await chrome.notifications.create('pmt-' + st.id + '-' + Date.now(), {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Email detected',
          message: `${toLine}\n${subjLine}${when}${moreLine}`,
        });
      } catch (e) { /* notifications blocked — badge still counts */ }
      newUnread += newUnique;
      t.lastNotifiedAt = Date.now();
    }
    // Baseline always advances to the server's unique count so the same
    // detection never notifies twice — even when notifications are off.
    t.lastUniqueNotified = Math.max(t.lastUniqueNotified || 0, curUnique);
    changed = true;
  }

  // Cache cap: prune oldest SENT tracks beyond the limit (server keeps all).
  const ids = Object.keys(tracks);
  if (ids.length > s2.maxTracks) {
    const sentIds = ids.filter((id) => tracks[id].sent !== 0)
      .sort((a, b) => String(tracks[a].updatedAt || '').localeCompare(String(tracks[b].updatedAt || '')));
    const drop = sentIds.slice(0, ids.length - s2.maxTracks);
    for (const id of drop) delete tracks[id];
    if (drop.length) changed = true;
  }

  await saveStore({
    tracks,
    unread: newUnread,
    lastSyncAt: fetched.serverTime || new Date().toISOString(),
  });
  try {
    await chrome.action.setBadgeText({ text: newUnread > 0 ? String(Math.min(newUnread, 99)) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#0b7a55' });
  } catch (e) { /* ignore */ }
  return { ok: true, changed };
}

/* ================= wiring ================= */

try {
  chrome.notifications.onClicked.addListener((nid) => { chrome.notifications.clear(nid); });
  chrome.notifications.onButtonClicked.addListener((nid) => { chrome.notifications.clear(nid); });
} catch (e) { /* non-browser (tests) */ }

function scheduleAlarm() {
  try { chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES }); } catch (e) { /* tests */ }
}

try {
  chrome.runtime.onInstalled.addListener(() => {
    scheduleAlarm();
    getStore().then(s => ensureServerAccount(s.serverUrl));
    reinjectContentScripts();
    pollTracks();
  });
  chrome.runtime.onStartup.addListener(() => {
    scheduleAlarm();
    getStore().then(s => ensureServerAccount(s.serverUrl));
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

try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type === 'PMT_PREPARE_TRACK') {
        sendResponse(await prepareTrack(msg.id, msg.subject, msg.to, msg.from));
      } else if (msg.type === 'PMT_TOUCH_TRACK') {
        sendResponse(await touchTrack(msg.trackId, msg.subject, msg.to, msg.from));
      } else if (msg.type === 'PMT_COMMIT_TRACK') {
        sendResponse(await commitTrack(msg.trackId, msg.subject, msg.to, msg.from));
      } else if (msg.type === 'PMT_GET_TICK_DATA') {
        // Tick marks in Gmail: detection analytics per track (server-synced).
        const { tracks } = await getStore();
        sendResponse({
          ok: true,
          tracks: Object.keys(tracks).map((id) => {
            const t = tracks[id];
            const a = t.analytics || {};
            const raw = a.raw_event_count || 0;
            const last = latestRealEvent(t);
            return {
              id,
              subject: t.subject || '',
              recipient: t.recipient || '',
              sender: t.sender || '',
              sent: t.sent === 0 ? 0 : 1,
              createdAt: t.createdAt || '',
              rawCount: raw,
              uniqueCount: a.estimated_unique_events || 0,
              firstDetectedAt: a.first_detected_at || null,
              lastDetectedAt: a.last_detected_at || null,
              viaGmail: !!(last && last.event_type === 'GMAIL_PROXY'),
            };
          }),
        });
      } else if (msg.type === 'PMT_SELF_VIEW') {
        sendResponse(await selfView(msg.trackId));
      } else if (msg.type === 'PMT_POLL_NOW') {
        await pollTracks();
        sendResponse({ ok: true });
      } else if (msg.type === 'PMT_CLEAR_BADGE') {
        await saveStore({ unread: 0 });
        try { await chrome.action.setBadgeText({ text: '' }); } catch (e) { /* ignore */ }
        sendResponse({ ok: true });
      } else if (msg.type === 'PMT_GOOGLE_SIGNIN') {
        sendResponse(await googleSignIn());
      } else if (msg.type === 'PMT_GOOGLE_SIGNOUT') {
        sendResponse(await googleSignOut());
      } else if (msg.type === 'PMT_GOOGLE_STATUS') {
        sendResponse(await googleStatus());
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true; // async response
  });
} catch (e) { /* tests */ }

// Exported for node:test (MV3 service workers have no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isValidTrackId, outboxNextDelayMs, outboxPush, buildLocalTrack,
    applyLocalUpdate, applyServerTrack, migrateLocalTrack,
    recipientOnly, eventLabel,
  };
}
