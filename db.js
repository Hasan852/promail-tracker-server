// db.js — storage layer for ProMail Tracker.
//
// Two backends:
//   1. Postgres, when DATABASE_URL is set (recommended for permanent hosting,
//      e.g. free Neon/Supabase DB — data survives restarts and redeploys).
//   2. Built-in node:sqlite file DB otherwise (zero dependencies, good for a
//      VPS or a PC that stays on). Data lives in tracker.db next to this file.
//
// Nothing is ever auto-deleted: weekly reports read from the same tables,
// so history is permanent on either backend.

const crypto = require('crypto');
const path = require('path');

const usePostgres = !!process.env.DATABASE_URL;

let sqliteDb = null;
let pgPool = null;

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  is_gmail_proxy INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_opens_track ON opens(track_id);
CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at);
-- v1.4: self-view suppression. When the sender opens their own sent mail,
-- the extension signals it here so the resulting pixel hit is NOT counted
-- as an open. Only the receiver's opens count.
CREATE TABLE IF NOT EXISTS self_views (
  track_id TEXT PRIMARY KEY,
  viewed_at TEXT NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS opens (
  id SERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  is_gmail_proxy BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_opens_track ON opens(track_id);
CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at);
-- v1.4: self-view suppression (see SQLite schema comment above).
CREATE TABLE IF NOT EXISTS self_views (
  track_id TEXT PRIMARY KEY,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function init() {
  if (usePostgres) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pgPool.query(PG_SCHEMA);
    // Migrate older DBs that were created before recipient/sender existed.
    await pgPool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT ''`);
    await pgPool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT ''`);
    // v1.3: 'sent' flag — 1 = mail actually sent, 0 = compose opened but not
    // yet sent. Pixel hits are ignored until sent=1, which kills false
    // "opened" events from the sender's own compose window. One-time backfill:
    // rows predating this column came from the old flow, so treat as sent.
    const sentCol = await pgPool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'tracks' AND column_name = 'sent'`
    );
    if (sentCol.rowCount === 0) {
      await pgPool.query(`ALTER TABLE tracks ADD COLUMN sent INTEGER NOT NULL DEFAULT 0`);
      await pgPool.query(`UPDATE tracks SET sent = 1`);
      console.log('[db] migrated tracks.sent (backfilled existing rows as sent)');
    }
    console.log('[db] using Postgres');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const file = process.env.SQLITE_FILE || path.join(__dirname, 'tracker.db');
    sqliteDb = new DatabaseSync(file);
    sqliteDb.exec(SQLITE_SCHEMA);
    // Migrate older DBs (SQLite has no ADD COLUMN IF NOT EXISTS — check first).
    const cols = sqliteDb.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    if (!cols.includes('recipient')) sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN recipient TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('sender')) sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN sender TEXT NOT NULL DEFAULT ''`);
    // v1.3: 'sent' flag (see Postgres branch above). One-time backfill only
    // when the column is newly added — never on later restarts.
    if (!cols.includes('sent')) {
      sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN sent INTEGER NOT NULL DEFAULT 0`);
      sqliteDb.exec(`UPDATE tracks SET sent = 1`);
      console.log('[db] migrated tracks.sent (backfilled existing rows as sent)');
    }
    console.log('[db] using SQLite file:', file);
  }
}

function newId() {
  return 'trk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function createTrack(subject, recipient, sender, opts = {}) {
  // v1.7.0: the extension generates the id client-side (instant pixel, no
  // server round-trip at compose). Accept it via opts.id (strictly validated);
  // upsert so retries and double-commits are idempotent. Callers without an
  // id keep the old server-generated behavior.
  let id = opts.id;
  if (!(typeof id === 'string' && /^trk_[A-Za-z0-9]{12}$/.test(id))) {
    id = newId();
  }
  const createdAt = new Date().toISOString();
  const r = (recipient || '').slice(0, 300);
  const s = (sender || '').slice(0, 200);
  // sent=0 when the extension defers the "sent" mark until the user actually
  // sends (v1.3+); legacy callers without the flag keep the old behavior (1).
  const sent = opts.deferred ? 0 : 1;
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO tracks (id, subject, recipient, sender, sent, created_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, recipient = EXCLUDED.recipient,
         sender = EXCLUDED.sender, sent = EXCLUDED.sent`,
      [id, subject || '', r, s, sent, createdAt]);
  } else {
    sqliteDb.prepare(
      `INSERT INTO tracks (id, subject, recipient, sender, sent, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET subject = excluded.subject, recipient = excluded.recipient,
         sender = excluded.sender, sent = excluded.sent`
    ).run(id, subject || '', r, s, sent, createdAt);
  }
  return id;
}

// Update subject/recipient/sender after compose (values are final only at send time).
// Pass { sent: 1 } to mark the mail as actually sent.
async function updateTrack(id, { subject, recipient, sender, sent }) {
  const sets = [];
  const vals = [];
  if (typeof subject === 'string') { sets.push(`subject = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(subject.slice(0, 300)); }
  if (typeof recipient === 'string') { sets.push(`recipient = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(recipient.slice(0, 300)); }
  if (typeof sender === 'string') { sets.push(`sender = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(sender.slice(0, 200)); }
  if (sent === 1 || sent === 0) { sets.push(`sent = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(sent); }
  if (sets.length === 0) return false;
  if (usePostgres) {
    vals.push(id);
    const r = await pgPool.query(`UPDATE tracks SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    return r.rowCount > 0;
  }
  const r = sqliteDb.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return r.changes > 0;
}

async function logOpen(trackId, { ip, userAgent, device, isGmailProxy }) {
  const openedAt = new Date().toISOString();
  // v1.4: the sender's own views are never counted. If the extension signalled
  // a self-view for this track inside the forward window, this pixel hit came
  // from the sender opening their own sent mail — skip it silently.
  if (await recentSelfView(trackId, SELF_VIEW_FORWARD_SEC)) return false;
  // Only log opens for mails that were actually sent. Hits arriving while
  // sent=0 come from the sender's own compose window rendering the pixel —
  // logging them would fire false "opened" notifications.
  if (usePostgres) {
    const r = await pgPool.query('SELECT sent FROM tracks WHERE id = $1', [trackId]);
    if (r.rowCount === 0 || Number(r.rows[0].sent) !== 1) return false;
    await pgPool.query(
      'INSERT INTO opens (track_id, opened_at, ip, user_agent, device, is_gmail_proxy) VALUES ($1, $2, $3, $4, $5, $6)',
      [trackId, openedAt, ip || '', userAgent || '', device || '', !!isGmailProxy]
    );
    return true;
  }
  const row = sqliteDb.prepare('SELECT sent FROM tracks WHERE id = ?').get(trackId);
  if (!row || Number(row.sent) !== 1) return false;
  sqliteDb.prepare(
    'INSERT INTO opens (track_id, opened_at, ip, user_agent, device, is_gmail_proxy) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(trackId, openedAt, ip || '', userAgent || '', device || '', isGmailProxy ? 1 : 0);
  return true;
}

// ---- v1.4: self-view suppression ----
//
// The sender opening their own sent mail must not count as an "open" and
// must never fire a notification — only the receiver's opens count. The
// extension watches Gmail message views; when one of our tracking pixels
// actually LOADS in a message view, it signals recordSelfView(). Pixel hits
// inside the suppression window are then silently ignored.
//
// Signalling on LOAD (not on DOM insert) keeps the signal and the pixel hit
// tightly correlated in time (~1s apart): the hit is logged when Gmail's
// proxy fetches it, the browser fires the img load event when the proxy
// responds. This also handles lazy-loaded images (long mails: the pixel may
// load only when the sender scrolls to the bottom) and Gmail's "ask before
// displaying images" setting (no load -> no hit -> nothing to suppress).
//
// Two small windows cover the residual race in either order:
//   FORWARD: a pixel hit arriving up to 15s AFTER a self-view signal is the
//            sender's own view -> not counted. (Causal order is hit-then-
//            signal, so this only catches proxy re-fetch weirdness; kept
//            short so a genuine receiver open minutes later is never eaten.)
//   RETRO:   when a self-view signal arrives, PROXY opens logged in the
//            previous 5s are dropped -> covers the case where the pixel hit
//            beat the signal to the server. Proxy-only on purpose: the
//            sender's view always arrives via Gmail's image proxy (the
//            extension only signals from Gmail web), so a non-proxy open in
//            the window is the receiver's own client and is never touched.
const SELF_VIEW_FORWARD_SEC = 15;
const SELF_VIEW_RETRO_SEC = 5;

function cutoffISO(sec) {
  return new Date(Date.now() - sec * 1000).toISOString();
}

async function recentSelfView(trackId, windowSec) {
  const cutoff = cutoffISO(windowSec);
  if (usePostgres) {
    const r = await pgPool.query(
      'SELECT 1 FROM self_views WHERE track_id = $1 AND viewed_at > $2::timestamptz',
      [trackId, cutoff]
    );
    return r.rowCount > 0;
  }
  const r = sqliteDb.prepare('SELECT 1 FROM self_views WHERE track_id = ? AND viewed_at > ?').get(trackId, cutoff);
  return !!r;
}

async function deleteRecentOpens(trackId, windowSec) {
  const cutoff = cutoffISO(windowSec);
  // Proxy-only: the sender's own view always arrives via Gmail's image proxy
  // (the extension signals only from Gmail web). A non-proxy open in the
  // window is the receiver's own mail client — never touch it.
  if (usePostgres) {
    const r = await pgPool.query(
      'DELETE FROM opens WHERE track_id = $1 AND opened_at > $2::timestamptz AND is_gmail_proxy = TRUE',
      [trackId, cutoff]
    );
    return r.rowCount;
  }
  const r = sqliteDb.prepare('DELETE FROM opens WHERE track_id = ? AND opened_at > ? AND is_gmail_proxy = 1').run(trackId, cutoff);
  return r.changes;
}

// Called by the extension when the sender views their own sent mail.
// Records the signal and drops any opens that landed in the last few seconds
// (the pixel hit may have arrived just before this signal).
async function recordSelfView(trackId) {
  const exists = usePostgres
    ? (await pgPool.query('SELECT 1 FROM tracks WHERE id = $1', [trackId])).rowCount > 0
    : !!sqliteDb.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId);
  if (!exists) return { recorded: false, removed: 0 };
  const now = new Date().toISOString();
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO self_views (track_id, viewed_at) VALUES ($1, $2)
       ON CONFLICT (track_id) DO UPDATE SET viewed_at = EXCLUDED.viewed_at`,
      [trackId, now]
    );
    // Opportunistic prune so the table stays tiny (one row per track max).
    await pgPool.query(`DELETE FROM self_views WHERE viewed_at < NOW() - INTERVAL '1 day'`);
  } else {
    sqliteDb.prepare('INSERT OR REPLACE INTO self_views (track_id, viewed_at) VALUES (?, ?)').run(trackId, now);
    sqliteDb.prepare('DELETE FROM self_views WHERE viewed_at < ?').run(new Date(Date.now() - 86400000).toISOString());
  }
  const removed = await deleteRecentOpens(trackId, SELF_VIEW_RETRO_SEC);
  return { recorded: true, removed };
}

function normRow(r) {  return {
    id: r.id,
    track_id: r.track_id,
    opened_at: r.opened_at instanceof Date ? r.opened_at.toISOString() : r.opened_at,
    ip: r.ip,
    user_agent: r.user_agent,
    device: r.device,
    is_gmail_proxy: usePostgres ? !!r.is_gmail_proxy : r.is_gmail_proxy === 1,
  };
}

async function getTrack(trackId) {
  let track;
  if (usePostgres) {
    const r = await pgPool.query('SELECT id, subject, recipient, sender, created_at FROM tracks WHERE id = $1', [trackId]);
    if (r.rowCount === 0) return null;
    track = r.rows[0];
    track.created_at = track.created_at.toISOString();
    const o = await pgPool.query(
      'SELECT id, track_id, opened_at, ip, user_agent, device, is_gmail_proxy FROM opens WHERE track_id = $1 ORDER BY opened_at ASC',
      [trackId]
    );
    return { id: track.id, subject: track.subject, recipient: track.recipient || '', sender: track.sender || '', created_at: track.created_at, opens: o.rows.map(normRow) };
  }
  const t = sqliteDb.prepare('SELECT id, subject, recipient, sender, created_at FROM tracks WHERE id = ?').get(trackId);
  if (!t) return null;
  const opens = sqliteDb
    .prepare('SELECT id, track_id, opened_at, ip, user_agent, device, is_gmail_proxy FROM opens WHERE track_id = ? ORDER BY opened_at ASC')
    .all(trackId)
    .map(normRow);
  return { id: t.id, subject: t.subject, recipient: t.recipient || '', sender: t.sender || '', created_at: t.created_at, opens };
}

async function listTracks(limit = 50, includeUnsent = false) {
  const sentFilter = includeUnsent ? '' : 'WHERE t.sent = 1';
  if (usePostgres) {
    const r = await pgPool.query(
      `SELECT t.id, t.subject, t.recipient, t.sender, t.sent, t.created_at,
              COUNT(o.id) AS open_count,
              MIN(o.opened_at) AS first_open,
              MAX(o.opened_at) AS last_open,
              COUNT(o.id) FILTER (WHERE o.is_gmail_proxy) AS proxy_opens
       FROM tracks t LEFT JOIN opens o ON o.track_id = t.id
       ${sentFilter}
       GROUP BY t.id ORDER BY t.created_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows.map((x) => ({
      id: x.id,
      subject: x.subject,
      recipient: x.recipient || '',
      sender: x.sender || '',
      sent: Number(x.sent) === 1,
      created_at: x.created_at.toISOString(),
      open_count: Number(x.open_count),
      first_open: x.first_open ? x.first_open.toISOString() : null,
      last_open: x.last_open ? x.last_open.toISOString() : null,
      proxy_opens: Number(x.proxy_opens),
    }));
  }
  const rows = sqliteDb.prepare(
    `SELECT t.id, t.subject, t.recipient, t.sender, t.sent, t.created_at,
            COUNT(o.id) AS open_count,
            MIN(o.opened_at) AS first_open,
            MAX(o.opened_at) AS last_open,
            COALESCE(SUM(o.is_gmail_proxy), 0) AS proxy_opens
     FROM tracks t LEFT JOIN opens o ON o.track_id = t.id
     ${sentFilter}
     GROUP BY t.id ORDER BY t.created_at DESC LIMIT ?`
  ).all(limit);
  return rows.map((x) => ({
    id: x.id,
    subject: x.subject,
    recipient: x.recipient || '',
    sender: x.sender || '',
    sent: Number(x.sent) === 1,
    created_at: x.created_at,
    open_count: x.open_count,
    first_open: x.first_open,
    last_open: x.last_open,
    proxy_opens: x.proxy_opens,
  }));
}

// Per-track summary rows for a date range (used by weekly/monthly reports).
async function reportSummary(fromISO, toISO) {
  if (usePostgres) {
    const r = await pgPool.query(
      `SELECT t.id, t.subject, t.recipient, t.sender, t.created_at,
              COUNT(o.id) AS open_count,
              MIN(o.opened_at) AS first_open,
              MAX(o.opened_at) AS last_open,
              COUNT(o.id) FILTER (WHERE o.is_gmail_proxy) AS proxy_opens
       FROM tracks t LEFT JOIN opens o ON o.track_id = t.id
       WHERE t.created_at >= $1 AND t.created_at < $2 AND t.sent = 1
       GROUP BY t.id ORDER BY t.created_at ASC`,
      [fromISO, toISO]
    );
    return r.rows.map((x) => ({
      track_id: x.id,
      subject: x.subject,
      recipient: x.recipient || '',
      sender: x.sender || '',
      sent_at: x.created_at.toISOString(),
      opens: Number(x.open_count),
      first_open: x.first_open ? x.first_open.toISOString() : '',
      last_open: x.last_open ? x.last_open.toISOString() : '',
      proxy_opens: Number(x.proxy_opens),
    }));
  }
  const rows = sqliteDb.prepare(
    `SELECT t.id, t.subject, t.recipient, t.sender, t.created_at,
            COUNT(o.id) AS open_count,
            MIN(o.opened_at) AS first_open,
            MAX(o.opened_at) AS last_open,
            COALESCE(SUM(o.is_gmail_proxy), 0) AS proxy_opens
     FROM tracks t LEFT JOIN opens o ON o.track_id = t.id
     WHERE t.created_at >= ? AND t.created_at < ? AND t.sent = 1
     GROUP BY t.id ORDER BY t.created_at ASC`
  ).all(fromISO, toISO);
  return rows.map((x) => ({
    track_id: x.id,
    subject: x.subject,
    recipient: x.recipient || '',
    sender: x.sender || '',
    sent_at: x.created_at,
    opens: x.open_count,
    first_open: x.first_open || '',
    last_open: x.last_open || '',
    proxy_opens: x.proxy_opens,
  }));
}

module.exports = { init, createTrack, updateTrack, logOpen, getTrack, listTracks, reportSummary, recordSelfView, recentSelfView, backend: () => (usePostgres ? 'postgres' : 'sqlite') };
