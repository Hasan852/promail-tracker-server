// server.js — ProMail Tracker backend (v2.3.0).
//
// Endpoints:
//   GET  /health                              -> { ok, backend, version, time, db }
//   GET  /privacy                             -> privacy policy (public; for OAuth consent screen)
//   POST /api/bootstrap                       -> { ok, accountId }
//   POST /api/auth/google                     -> link Google identity { ok, accountId, email, mergedTracks }
//   GET  /api/auth/me                         -> { ok, accountId, google: {linked,email} | null }
//   POST /api/tracks                           -> { trackId }            (create, sent=0)
//   POST /api/tracks/:id/commit                -> { ok, alreadyCommitted } (send-time commit)
//   POST /api/tracks/:id/self-view             -> { ok, flagged }
//   POST /api/account/preferences              -> { ok }  { privacy_mode }
//   GET  /api/tracks?limit&all&updatedSince=   -> changed tracks + analytics (batch sync)
//   GET  /api/tracks/:id?diagnostics=1          -> track + events + analytics
//   GET  /api/status/:id                       -> legacy alias of /api/tracks/:id
//   GET  /px/:id.gif                           -> 1x1 pixel (public; logs detection event)
//   GET  /report/weekly | /report/monthly      -> HTML reports
//   GET  /api/report/weekly | /api/report/monthly | /api/report -> JSON / CSV
//
// Legacy GET endpoints (/api/create-track, /api/update-track/:id,
// /api/self-view/:id) are kept for older extensions and marked LEGACY.
//
// Run:  npm install && npm start          (PORT env, default 3000)
// Data: Postgres if DATABASE_URL is set, else ./tracker.db (SQLite).
//       Rows are NEVER auto-deleted, so reports keep full history.
//
// Google sign-in (v2.3.0): the extension obtains a Google OAuth access token
// via chrome.identity (scopes: openid, email, profile — identity only, no
// Gmail access) and POSTs it here once. The server verifies it with Google,
// then links the install-token account to the Google identity
// (accounts.google_sub). The access token itself is never stored.
// Env: GOOGLE_CLIENT_ID must match the OAuth client used by the extension.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');
const v = require('./validate');
const { createRateLimiter } = require('./ratelimit');
const log = require('./logger');

const VERSION = '2.3.0';

const app = express();
app.set('trust proxy', true); // honor X-Forwarded-For on Render/Railway/etc.

// CORS: explicit allowlist when configured; otherwise only extension pages and
// Gmail itself. Never default to allow-all.
function corsOriginFn(origin, cb) {
  if (!origin) return cb(null, true); // curl / server-to-server
  if (/^chrome-extension:\/\//.test(origin)) return cb(null, true);
  if (origin === 'https://mail.google.com') return cb(null, true);
  return cb(null, false);
}
const corsOpt = process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()), methods: ['GET', 'POST', 'OPTIONS'] }
  : { origin: corsOriginFn, methods: ['GET', 'POST', 'OPTIONS'] };
app.use(cors(corsOpt));
app.use(express.json({ limit: '64kb' }));

// Minimal security headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Rate limits: pixel endpoint per IP; APIs per token (or IP fallback).
const pixelLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 240 });
const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 180 });

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim().slice(0, 64);
  const ra = req.headers['x-real-ip'];
  if (typeof ra === 'string' && ra.length > 0) return ra.trim().slice(0, 64);
  return ((req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

function rateKey(req) {
  const token = req.get('X-PMT-Key') || '';
  if (token.length >= 36) return 't:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  return 'ip:' + clientIp(req);
}

async function requireAuth(req, res, next) {
  try {
    if (!apiLimiter.allow(rateKey(req))) return res.status(429).json({ error: 'rate limited' });
    const token = req.get('X-PMT-Key');
    if (!token || token.length < v.TOKEN_MIN_LEN) return res.status(401).json({ error: 'authentication required' });
    req.ownerId = await db.ensureAccount(token);
    next();
  } catch (e) {
    log.error('auth failed', { error: e.message });
    res.status(401).json({ error: 'authentication failed' });
  }
}

app.get('/health', async (req, res) => {
  let dbState = 'ok';
  try {
    await db.getPrivacyMode('__healthcheck__');
  } catch (e) {
    dbState = 'degraded: ' + e.message.slice(0, 120);
  }
  res.json({ ok: true, backend: db.backend(), version: VERSION, time: new Date().toISOString(), db: dbState });
});

// Register/restore this extension installation. The token is generated locally
// and never stored in plaintext server-side; only its SHA-256 hash is kept.
app.post('/api/bootstrap', requireAuth, async (req, res) => {
  const privacyMode = await db.getPrivacyMode(req.ownerId).catch(() => false);
  res.json({ ok: true, accountId: req.ownerId, privacyMode });
});

// ---- Google sign-in (v2.3.0) ----

const GOOGLE_TOKENINFO_URL = process.env.PMT_GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo';

// Verify a Google OAuth access token with Google. Returns { sub, email }.
// Throws on any problem; the token itself is never stored server-side.
async function verifyGoogleToken(accessToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) throw new Error('Google login is not configured on this server');
  const url = GOOGLE_TOKENINFO_URL + '?access_token=' + encodeURIComponent(accessToken);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new Error('could not reach Google: ' + String(e.message).slice(0, 60));
  }
  if (!res.ok) throw new Error('Google rejected the token');
  let j;
  try { j = await res.json(); } catch (e) { throw new Error('bad response from Google'); }
  if (j.aud !== clientId) throw new Error('token was not issued for this app');
  if (j.expires_in !== undefined && !(Number(j.expires_in) > 0)) throw new Error('token expired');
  if (j.exp !== undefined && Number(j.exp) * 1000 < Date.now()) throw new Error('token expired');
  const sub = String(j.sub || '');
  if (!sub) throw new Error('no user id in token');
  return { sub, email: String(j.email || '') };
}

// Link this install's account to a verified Google identity. First sign-in
// attaches the identity to the current account; signing in on a fresh
// install (or a second device) merges into — and thereby restores — the
// previously linked account. See db.linkGoogleAccount for the merge rule.
app.post('/api/auth/google', requireAuth, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const gtok = v.str(body.google_access_token, 2048);
    if (!gtok || gtok.length < 10) return res.status(400).json({ error: 'google_access_token required' });
    let info;
    try {
      info = await verifyGoogleToken(gtok);
    } catch (e) {
      log.warn('google sign-in rejected', { error: e.message.slice(0, 80) });
      const code = /not configured/.test(e.message) ? 503 : 401;
      return res.status(code).json({ error: 'Google sign-in failed: ' + e.message.slice(0, 90) });
    }
    const r = await db.linkGoogleAccount(req.ownerId, req.get('X-PMT-Key'), info.sub, info.email);
    req.ownerId = r.accountId; // requireAuth resolved this before the merge
    res.json({ ok: true, accountId: r.accountId, email: r.email, mergedTracks: r.mergedTracks, googleLinked: true });
  } catch (e) {
    log.error('google link failed', { error: e.message });
    res.status(500).json({ error: 'could not link Google account' });
  }
});

// Current account + Google link status.
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const g = await db.getGoogleLink(req.ownerId);
    res.json({ ok: true, accountId: req.ownerId, google: g });
  } catch (e) {
    log.error('auth/me failed', { error: e.message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

// ---- Privacy policy (public; linked from the OAuth consent screen) ----

function privacyHTML() {
  const contact = process.env.PRIVACY_CONTACT_EMAIL || 'the developer listed on the OAuth consent screen';
  const verifyTag = process.env.GOOGLE_SITE_VERIFICATION
    ? `<meta name="google-site-verification" content="${escapeHtml(process.env.GOOGLE_SITE_VERIFICATION)}">`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">${verifyTag}<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ProMail Tracker — Privacy Policy</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#222;line-height:1.65}
h1{font-size:24px}h2{font-size:17px;margin-top:26px}</style></head><body>
<h1>ProMail Tracker — Privacy Policy</h1>
<p><i>Last updated: 2026-10-08</i></p>
<h2>What this app does</h2>
<p>ProMail Tracker is a browser extension that adds a tiny tracking image to emails <b>you</b> send from Gmail.
When a recipient's email client loads that image, the server records a detection event (time, IP address unless
privacy mode is on, and user-agent). Detection means the image was loaded — it does not prove a person read the message.</p>
<h2>Data we store</h2>
<ul><li>Email subjects, recipients and senders for messages you choose to track.</li>
<li>Detection events for those messages (timestamps, IP address, user-agent, device class).</li>
<li>If you use <b>Sign in with Google</b>: your Google account's stable user ID and email address, used only to
link your tracking data to your identity so it can be restored if you reinstall the extension.</li></ul>
<h2>What we never do</h2>
<ul><li>We <b>never read your Gmail</b> — the extension requests only identity scopes
(<code>openid</code>, <code>email</code>, <code>profile</code>). No Gmail API scopes are used.</li>
<li>We never access message content beyond what you choose to track.</li>
<li>We never sell your data or share it with advertisers.</li>
<li>Your Google OAuth access token is verified once and <b>never stored</b>.</li></ul>
<h2>Data retention</h2>
<p>Tracking data is kept on the server until you ask for its deletion. Contact ${escapeHtml(contact)} to request
export or deletion of your data.</p>
<h2>Contact</h2>
<p>Questions about this policy: ${escapeHtml(contact)}.</p>
</body></html>`;
}

app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(privacyHTML());
});

// Create a deferred (unsent) track. The extension generates the id locally
// (trk_ + 12 chars); the server validates it strictly. Idempotent per
// (id, owner) — retries never duplicate.
app.post('/api/tracks', requireAuth, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let id = body.id;
    if (id !== undefined && !v.trackId(id)) return res.status(400).json({ error: 'bad track id' });
    const r = await db.createTrack(v.str(body.subject, 300), v.str(body.to, 300), v.str(body.from, 200), {
      id, ownerId: req.ownerId,
    });
    if (!r.ok) return res.status(409).json({ error: r.reason || 'conflict' });
    res.json({ trackId: r.id, deduped: !!r.deduped });
  } catch (e) {
    log.error('create track failed', { error: e.message });
    res.status(500).json({ error: 'could not create track' });
  }
});

// Send-time commit: the mail really went out. Idempotent — Send click plus
// Sent-list fallback still produce exactly one track.
app.post('/api/tracks/:id/commit', requireAuth, async (req, res) => {
  try {
    const id = v.trackId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad track id' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await db.commitTrack(id, req.ownerId, {
      subject: v.str(body.subject, 300),
      recipient: v.str(body.to, 300),
      sender: v.str(body.from, 200),
    });
    if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 409).json({ error: r.reason || 'commit failed' });
    res.json({ ok: true, alreadyCommitted: !!r.alreadyCommitted });
  } catch (e) {
    log.error('commit failed', { error: e.message });
    res.status(500).json({ error: 'could not commit track' });
  }
});

// Sender viewed their own sent mail: flag nearby proxy events as suspected
// self-views (never deleted). See db.js for the model and its limitation.
app.post('/api/tracks/:id/self-view', requireAuth, async (req, res) => {
  try {
    const r = await db.recordSelfView(req.params.id, req.ownerId);
    res.json({ ok: r.recorded, flagged: r.flagged || 0 });
  } catch (e) {
    log.error('self-view failed', { error: e.message });
    res.status(500).json({ error: 'could not record self-view' });
  }
});

// Account preferences (currently: privacy_mode — when on, pixel IPs are not stored).
app.post('/api/account/preferences', requireAuth, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = v.flag01(body.privacy_mode);
    if (mode === undefined) return res.status(400).json({ error: 'privacy_mode must be 0 or 1' });
    await db.setPrivacyMode(req.ownerId, mode);
    res.json({ ok: true, privacyMode: mode === 1 });
  } catch (e) {
    log.error('preferences failed', { error: e.message });
    res.status(500).json({ error: 'could not save preferences' });
  }
});

// Batch sync: tracks changed since updatedSince, each with derived analytics.
// Prefer this over one request per track.
app.get('/api/tracks', requireAuth, async (req, res) => {
  try {
    const limit = v.int(req.query.limit, 50, 1, 500);
    const includeUnsent = req.query.all === '1';
    let updatedSince = null;
    if (req.query.updatedSince !== undefined) {
      updatedSince = v.isoDateTime(req.query.updatedSince);
      if (!updatedSince) return res.status(400).json({ error: 'bad updatedSince' });
    }
    const tracks = await db.listTracks(req.ownerId, { limit, includeUnsent, updatedSince });
    res.json({ tracks, serverTime: new Date().toISOString() });
  } catch (e) {
    log.error('tracks failed', { error: e.message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

app.get('/api/tracks/:id', requireAuth, async (req, res) => {
  try {
    const track = await db.getTrack(req.params.id, req.ownerId, {
      includeDiagnostics: req.query.diagnostics === '1',
    });
    if (!track) return res.status(404).json({ error: 'Tracking ID not found' });
    res.json(track);
  } catch (e) {
    log.error('track lookup failed', { error: e.message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

// ---- LEGACY endpoints (kept for older extensions; prefer the POST APIs) ----

app.get('/api/create-track', requireAuth, async (req, res) => {
  log.warn('legacy endpoint used', { endpoint: 'GET /api/create-track' });
  try {
    const id = typeof req.query.id === 'string' && v.trackId(req.query.id) ? req.query.id : undefined;
    const r = await db.createTrack(v.str(req.query.subject, 300), v.str(req.query.to, 300), v.str(req.query.from, 200), {
      id, ownerId: req.ownerId,
    });
    if (!r.ok) return res.status(409).json({ error: r.reason || 'conflict' });
    res.json({ trackId: r.id });
  } catch (e) {
    log.error('legacy create-track failed', { error: e.message });
    res.status(500).json({ error: 'could not create track' });
  }
});

app.get('/api/update-track/:id', requireAuth, async (req, res) => {
  log.warn('legacy endpoint used', { endpoint: 'GET /api/update-track/:id' });
  try {
    const ok = await db.updateTrack(req.params.id, req.ownerId, {
      subject: typeof req.query.subject === 'string' ? v.str(req.query.subject, 300) : undefined,
      recipient: typeof req.query.to === 'string' ? v.str(req.query.to, 300) : undefined,
      sender: typeof req.query.from === 'string' ? v.str(req.query.from, 200) : undefined,
      sent: v.flag01(req.query.sent),
    });
    res.json({ ok });
  } catch (e) {
    log.error('legacy update-track failed', { error: e.message });
    res.status(500).json({ error: 'could not update track' });
  }
});

app.get('/api/self-view/:id', requireAuth, async (req, res) => {
  log.warn('legacy endpoint used', { endpoint: 'GET /api/self-view/:id' });
  try {
    const r = await db.recordSelfView(req.params.id, req.ownerId);
    res.json({ ok: r.recorded, flagged: r.flagged || 0 });
  } catch (e) {
    log.error('legacy self-view failed', { error: e.message });
    res.status(500).json({ error: 'could not record self-view' });
  }
});

// LEGACY alias for GET /api/tracks/:id.
app.get('/api/status/:id', requireAuth, async (req, res) => {
  try {
    const track = await db.getTrack(req.params.id, req.ownerId);
    if (!track) return res.status(404).json({ error: 'Tracking ID not found' });
    res.json(track);
  } catch (e) {
    log.error('legacy status failed', { error: e.message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

// ---- Tracking pixel ----
// Public by design: email clients cannot send X-PMT-Key. Security comes from
// high-entropy track ids, owner isolation on authenticated APIs, and no
// sensitive data in the URL. The pixel is ALWAYS served, even if analytics
// logging fails or times out — a broken database must never hang Gmail.
app.get('/px/:id.gif', async (req, res) => {
  if (!pixelLimiter.allow(clientIp(req))) {
    log.warn('pixel rate limited', { ip: clientIp(req) });
  } else {
    const ua = req.headers['user-agent'] || '';
    const work = db.logDetectionEvent(req.params.id, { ip: clientIp(req), userAgent: ua });
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ stored: false, reason: 'timeout' }), 4000));
    try {
      await Promise.race([work, timeout]);
    } catch (e) {
      log.error('pixel logging failed', { error: e.message });
    }
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', PIXEL.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(PIXEL);
});

// ---- Reports ----

function currentWeekRangeUTC() {
  const now = new Date();
  const mondayOffset = (now.getUTCDay() + 6) % 7; // Monday = 0
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset, 0, 0, 0));
  const to = new Date(from.getTime() + 7 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), label: from.toISOString().slice(0, 10) };
}

function currentMonthRangeUTC() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return { from: from.toISOString(), to: to.toISOString(), label: from.toISOString().slice(0, 7) };
}

function parseRange(q, kind) {
  if (q.from && q.to) {
    const from = v.isoDateTime(q.from);
    const to = v.isoDateTime(q.to);
    if (!from || !to || to <= from) return null;
    return { from, to, label: `${String(q.from).slice(0, 10)}_to_${String(q.to).slice(0, 10)}` };
  }
  return kind === 'month' ? currentMonthRangeUTC() : currentWeekRangeUTC();
}

function summarize(rows) {
  const sent = rows.length;
  const detected = rows.filter((r) => r.raw_events > 0).length;
  const uniqueDetected = rows.filter((r) => r.unique_events > 0).length;
  const rawEvents = rows.reduce((a, r) => a + r.raw_events, 0);
  const proxyEvents = rows.reduce((a, r) => a + r.proxy_events, 0);
  const directEvents = rows.reduce((a, r) => a + r.direct_events, 0);
  const ttfs = rows.map((r) => r.time_to_first_detection_sec).filter((x) => x != null && x >= 0);
  const avgTtf = ttfs.length ? Math.round(ttfs.reduce((a, b) => a + b, 0) / ttfs.length) : null;
  const firsts = rows.map((r) => r.first_detected_at).filter(Boolean).sort();
  const lasts = rows.map((r) => r.last_detected_at).filter(Boolean).sort();
  return {
    sent,
    detected,
    unique_detected: uniqueDetected,
    detection_rate: sent ? Math.round((detected / sent) * 100) : 0,
    unique_detection_rate: sent ? Math.round((uniqueDetected / sent) * 100) : 0,
    raw_events: rawEvents,
    proxy_events: proxyEvents,
    direct_events: directEvents,
    avg_time_to_first_detection_sec: avgTtf,
    earliest_detection: firsts[0] || null,
    latest_detection: lasts[lasts.length - 1] || null,
  };
}

// Daily trend buckets in the requested timezone (JS-side, backend-agnostic).
function dailyTrend(rows, tz) {
  const zone = v.timezone(tz) || 'UTC';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const map = new Map();
  for (const r of rows) {
    if (!r.sent_at) continue;
    const day = fmt.format(new Date(r.sent_at));
    let d = map.get(day);
    if (!d) { d = { date: day, sent: 0, detected: 0, unique_detected: 0, raw_events: 0 }; map.set(day, d); }
    d.sent += 1;
    if (r.raw_events > 0) d.detected += 1;
    if (r.unique_events > 0) d.unique_detected += 1;
    d.raw_events += r.raw_events;
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function reportPayload(ownerId, range, tz) {
  const rows = await db.reportSummary(ownerId, range.from, range.to);
  return {
    from: range.from,
    to: range.to,
    label: range.label,
    timezone: v.timezone(tz) || 'UTC',
    summary: summarize(rows),
    daily_trend: dailyTrend(rows, tz),
    rows,
  };
}

function escCSV(val) {
  const s = String(val == null ? '' : val);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Legacy CSV export (v2.1 shape, upgraded columns). Timezone-aware ISO
// timestamps (explicit UTC). The report page generates its own tz-aware CSV.
function toCSV(rows) {
  const head = ['track_id', 'recipient', 'subject', 'sent_at', 'detection_count',
    'unique_detection_count', 'proxy_event_count', 'direct_event_count',
    'first_detected_at', 'last_detected_at', 'detection_status'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.track_id, r.recipient, r.subject, r.sent_at,
      r.raw_events, r.unique_events, r.proxy_events, r.direct_events,
      r.first_detected_at || '', r.last_detected_at || '',
      r.raw_events > 0 ? 'detected' : 'sent',
    ].map(escCSV).join(','));
  }
  return lines.join('\r\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtT(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').replace('Z', '').slice(0, 19);
}
function fmtDur(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
  return (sec / 86400).toFixed(1) + 'd';
}

function reportHTML(payload, kind) {
  const s = payload.summary;
  const trs = payload.rows.map((r) => {
    const status = r.raw_events > 0
      ? (r.proxy_events === r.raw_events ? 'Detected via Gmail' : 'Detected')
      : 'Sent — no detection';
    return `<tr><td>${escapeHtml(r.recipient) || '<i>—</i>'}</td><td>${escapeHtml(r.subject) || '<i>(no subject)</i>'}</td>
<td class="c">${r.unique_events}</td><td class="c">${r.raw_events}</td><td class="c">${r.proxy_events}</td><td class="c">${r.direct_events}</td>
<td>${escapeHtml(status)}</td><td>${escapeHtml(fmtT(r.sent_at))}</td><td>${escapeHtml(fmtT(r.first_detected_at))}</td><td>${escapeHtml(fmtT(r.last_detected_at))}</td></tr>`;
  }).join('');
  const trend = payload.daily_trend.map((d) =>
    `<tr><td>${escapeHtml(d.date)}</td><td class="c">${d.sent}</td><td class="c">${d.detected}</td><td class="c">${d.unique_detected}</td><td class="c">${d.raw_events}</td></tr>`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ProMail Tracker — ${kind} Report (${escapeHtml(payload.label)})</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:22px}h2{font-size:16px;margin:26px 0 10px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.stat{background:#f4f6f8;border-radius:10px;padding:12px 18px;min-width:130px}.stat b{font-size:22px;display:block}
.c{text-align:center}table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #ddd;padding:8px 10px;text-align:left}th{background:#f4f6f8}
a.btn{display:inline-block;margin-top:16px;padding:10px 16px;background:#0b7a55;color:#fff;border-radius:8px;text-decoration:none}
.note{color:#777;font-size:12px;margin-top:18px;max-width:760px;line-height:1.6}</style>
</head><body>
<h1>📧 ${kind} Email Report <small>(${escapeHtml(payload.label)})</small></h1>
<p style="color:#666;font-size:13px">Timezone: ${escapeHtml(payload.timezone)} · ${escapeHtml(payload.from.slice(0, 10))} → ${escapeHtml(payload.to.slice(0, 10))}</p>
<div class="stats">
<div class="stat"><b>${s.sent}</b>sent</div>
<div class="stat"><b>${s.detected}</b>detected</div>
<div class="stat"><b>${s.unique_detected}</b>unique detected</div>
<div class="stat"><b>${s.detection_rate}%</b>detection rate</div>
<div class="stat"><b>${s.unique_detection_rate}%</b>unique rate</div>
<div class="stat"><b>${s.raw_events}</b>tracking events</div>
<div class="stat"><b>${s.proxy_events}</b>via Gmail</div>
<div class="stat"><b>${s.direct_events}</b>direct</div>
<div class="stat"><b>${fmtDur(s.avg_time_to_first_detection_sec)}</b>avg. time to first detection</div>
</div>
<h2>Daily trend</h2>
<table><tr><th>Date</th><th>Sent</th><th>Detected</th><th>Unique</th><th>Events</th></tr>${trend || '<tr><td colspan="5">No activity.</td></tr>'}</table>
<h2>Emails</h2>
<table><tr><th>To</th><th>Subject</th><th>Unique</th><th>Events</th><th>Via Gmail</th><th>Direct</th><th>Status</th><th>Sent</th><th>First detected</th><th>Last detected</th></tr>${trs || '<tr><td colspan="10">No tracked emails in this period.</td></tr>'}</table>
<a class="btn" href="/api/report/${kind.toLowerCase()}?format=csv&from=${encodeURIComponent(payload.from.slice(0, 10))}&to=${encodeURIComponent(payload.to.slice(0, 10))}">⬇ Download CSV</a>
<p class="note">“Detected” means the tracking image was loaded — it does not prove a person read the message.
“Via Gmail” events were loaded through Gmail's image proxy, which pre-loads images on Google's servers.
“Unique” is a conservative deduplicated estimate (see README: accuracy model). Data is kept permanently on the server.</p>
</body></html>`;
}

async function serveReportPage(req, res, kind) {
  try {
    const range = parseRange(req.query, kind === 'Monthly' ? 'month' : 'week');
    if (!range) return res.status(400).send('Bad date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD');
    const payload = await reportPayload(req.ownerId, range, req.query.tz);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(reportHTML(payload, kind));
  } catch (e) {
    log.error('report page failed', { error: e.message });
    res.status(500).send('report failed');
  }
}

app.get('/report/weekly', requireAuth, (req, res) => serveReportPage(req, res, 'Weekly'));
app.get('/report/monthly', requireAuth, (req, res) => serveReportPage(req, res, 'Monthly'));

async function serveReportApi(req, res, kind) {
  try {
    const range = parseRange(req.query, kind);
    if (!range) return res.status(400).json({ error: 'Bad date range. Use from=YYYY-MM-DD&to=YYYY-MM-DD' });
    const payload = await reportPayload(req.ownerId, range, req.query.tz);
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
      // LEGACY download shape (upgraded columns).
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="promail-${kind}-${range.label}.csv"`);
      return res.send('﻿' + toCSV(payload.rows));
    }
    res.json({ kind, ...payload, total: payload.rows.length });
  } catch (e) {
    log.error('report api failed', { error: e.message });
    res.status(500).json({ error: 'report failed' });
  }
}

app.get('/api/report/weekly', requireAuth, (req, res) => serveReportApi(req, res, 'week'));
app.get('/api/report/monthly', requireAuth, (req, res) => serveReportApi(req, res, 'month'));
app.get('/api/report', requireAuth, (req, res) => serveReportApi(req, res, 'week'));

// 404 + global error handler (never leak stack traces).
app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('unhandled request error', { error: err && err.message });
  res.status(500).json({ error: 'internal error' });
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason && reason.message || reason).slice(0, 300) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: String(err && err.message).slice(0, 300) });
});

const PORT = process.env.PORT || 3000;
let listener = null;
db.init()
  .then(() => {
    listener = app.listen(PORT, () => log.info(`ProMail Tracker v${VERSION} running`, { port: PORT, backend: db.backend() }));
  })
  .catch((e) => {
    log.error('DB init failed', { error: e.message });
    process.exit(1);
  });

module.exports = { app, VERSION, close: () => { try { if (listener) listener.close(); } catch (e) { /* ignore */ } } };
