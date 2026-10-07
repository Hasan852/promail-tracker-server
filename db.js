// ProMail Tracker storage layer — v2.3.0
//
// Postgres is recommended for hosted deployments; node:sqlite is supported
// for local/VPS use.
//
// EVENT MODEL (v2.2.0):
//   tracks = one tracking identity attached to one outgoing email.
//   events = append-only raw detection events (one HTTP request = one row).
//            Raw events are NEVER deleted; duplicates are kept for audit.
//   analytics = derived per track:
//     raw_event_count       = COUNT(*) of non-suspect events
//     estimated_unique      = COUNT(DISTINCT dedupe_key)  <- UI + notifications
//     proxy/direct/other/unknown breakdowns
//     first/last detected timestamps
//
// SELF-VIEW MODEL (v2.2.0): sender signals are recorded, then proxy-type
// events inside [signal-180s, signal+120s] are FLAGGED
// (is_suspected_self_view) — never deleted. Flagged events are excluded from
// analytics but remain visible in diagnostics. Limitation: a recipient proxy
// event inside the same window can be mis-flagged; this is documented, not
// hidden.
//
// GOOGLE IDENTITY MODEL (v2.3.0):
//   accounts.google_sub  = Google's stable user id ("sub"), UNIQUE, nullable.
//   accounts.google_email = the Google account email (display only).
//   The per-install auth token (token_hash) stays the API credential; the
//   Google link is what SURVIVES an extension reinstall. On sign-in:
//     - no account holds this sub      -> attach it to the current account.
//     - another account holds this sub -> merge: move this account's tracks
//       into the linked account, repoint this install token at it, drop the
//       now-empty account row. (Target's privacy_mode wins.)
//   The Google OAuth access token itself is verified once and NEVER stored.

const crypto = require('crypto');
const path = require('path');
const { classifyEvent, deviceFromUA } = require('./classify');
const { dedupeKey, normalizedClient } = require('./dedupe');
const { pixelId } = require('./validate');
const log = require('./logger');

const usePostgres = !!process.env.DATABASE_URL;
let sqliteDb = null;
let pgPool = null;

const LEGACY_OWNER = 'legacy';
const SELF_VIEW_BACK_SEC = 180;
const SELF_VIEW_FWD_SEC = 120;

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  privacy_mode INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT,
  google_email TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}',
  subject TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
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
CREATE TABLE IF NOT EXISTS self_views (
  track_id TEXT PRIMARY KEY,
  viewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  normalized_client TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  is_suspected_self_view INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_track_received ON events(track_id, received_at);
CREATE INDEX IF NOT EXISTS idx_events_track_dedupe ON events(track_id, dedupe_key);
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  privacy_mode INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT,
  google_email TEXT
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}',
  subject TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  schema_version INTEGER NOT NULL DEFAULT 1
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
CREATE TABLE IF NOT EXISTS self_views (
  track_id TEXT PRIMARY KEY,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  normalized_client TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  is_suspected_self_view BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_events_track_received ON events(track_id, received_at);
CREATE INDEX IF NOT EXISTS idx_events_track_dedupe ON events(track_id, dedupe_key);
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}
function newAccountId() { return 'acct_' + crypto.randomUUID().replace(/-/g, ''); }
function nowISO() { return new Date().toISOString(); }

// ---------- low-level helpers ----------

async function pgQuery(text, params) { return pgPool.query(text, params); }
function liteAll(sql, ...params) { return sqliteDb.prepare(sql).all(...params); }
function liteGet(sql, ...params) { return sqliteDb.prepare(sql).get(...params); }
function liteRun(sql, ...params) { return sqliteDb.prepare(sql).run(...params); }

async function hasMigration(name) {
  if (usePostgres) {
    const r = await pgQuery('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    return r.rowCount > 0;
  }
  return !!liteGet('SELECT 1 FROM schema_migrations WHERE name=?', name);
}
async function recordMigration(name) {
  const at = nowISO();
  if (usePostgres) {
    await pgQuery('INSERT INTO schema_migrations(name, applied_at) VALUES($1,$2) ON CONFLICT(name) DO NOTHING', [name, at]);
  } else {
    liteRun('INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES(?,?)', name, at);
  }
}

// ---------- init + migrations (idempotent, restart-safe) ----------

async function init() {
  if (usePostgres) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pgQuery(PG_SCHEMA);
    // Legacy-table upgrades (v2.0/v2.1 installs).
    for (const col of [
      `owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}'`,
      `recipient TEXT NOT NULL DEFAULT ''`,
      `sender TEXT NOT NULL DEFAULT ''`,
      `sent INTEGER NOT NULL DEFAULT 0`,
      'sent_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ',
      'schema_version INTEGER NOT NULL DEFAULT 1',
    ]) {
      await pgQuery(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pgQuery('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS privacy_mode INTEGER NOT NULL DEFAULT 0');
    await pgQuery('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS google_sub TEXT');
    await pgQuery('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS google_email TEXT');
    await pgQuery('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub)');
    for (const col of [
      `event_type TEXT NOT NULL DEFAULT 'UNKNOWN'`,
      `normalized_client TEXT NOT NULL DEFAULT ''`,
      `dedupe_key TEXT NOT NULL DEFAULT ''`,
      'is_suspected_self_view BOOLEAN NOT NULL DEFAULT FALSE',
    ]) {
      await pgQuery(`ALTER TABLE events ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_tracks_owner_created ON tracks(owner_id, created_at)');
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_tracks_owner_updated ON tracks(owner_id, updated_at)');
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_events_track_received ON events(track_id, received_at)');
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_events_track_dedupe ON events(track_id, dedupe_key)');
    log.info('[db] using Postgres');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const file = process.env.SQLITE_FILE || path.join(__dirname, 'tracker.db');
    sqliteDb = new DatabaseSync(file);
    sqliteDb.exec(SQLITE_SCHEMA);
    const trackCols = liteAll('PRAGMA table_info(tracks)').map(c => c.name);
    const need = (n, ddl) => { if (!trackCols.includes(n)) sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN ${ddl}`); };
    need('owner_id', `owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}'`);
    need('recipient', `recipient TEXT NOT NULL DEFAULT ''`);
    need('sender', `sender TEXT NOT NULL DEFAULT ''`);
    need('sent', 'sent INTEGER NOT NULL DEFAULT 0');
    need('sent_at', 'sent_at TEXT');
    need('updated_at', 'updated_at TEXT');
    need('schema_version', 'schema_version INTEGER NOT NULL DEFAULT 1');
    const acctCols = liteAll('PRAGMA table_info(accounts)').map(c => c.name);
    if (!acctCols.includes('privacy_mode')) sqliteDb.exec('ALTER TABLE accounts ADD COLUMN privacy_mode INTEGER NOT NULL DEFAULT 0');
    if (!acctCols.includes('google_sub')) sqliteDb.exec('ALTER TABLE accounts ADD COLUMN google_sub TEXT');
    if (!acctCols.includes('google_email')) sqliteDb.exec('ALTER TABLE accounts ADD COLUMN google_email TEXT');
    sqliteDb.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub)');
    const evCols = liteAll('PRAGMA table_info(events)').map(c => c.name);
    if (!evCols.includes('event_type')) sqliteDb.exec(`ALTER TABLE events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'UNKNOWN'`);
    if (!evCols.includes('normalized_client')) sqliteDb.exec(`ALTER TABLE events ADD COLUMN normalized_client TEXT NOT NULL DEFAULT ''`);
    if (!evCols.includes('dedupe_key')) sqliteDb.exec(`ALTER TABLE events ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''`);
    if (!evCols.includes('is_suspected_self_view')) sqliteDb.exec('ALTER TABLE events ADD COLUMN is_suspected_self_view INTEGER NOT NULL DEFAULT 0');
    if (!trackCols.includes('sent')) {
      // Very old installs: every pre-existing track was a sent mail.
      sqliteDb.exec('UPDATE tracks SET sent = 1 WHERE sent = 0');
    }
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_tracks_owner_created ON tracks(owner_id, created_at)');
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_tracks_owner_updated ON tracks(owner_id, updated_at)');
    log.info('[db] using SQLite file:', file);
  }
  await backfillTrackTimestamps();
  await migrateOpensToEvents();
}

async function backfillTrackTimestamps() {
  if (usePostgres) {
    await pgQuery('UPDATE tracks SET sent_at = created_at WHERE sent = 1 AND sent_at IS NULL');
    await pgQuery('UPDATE tracks SET updated_at = created_at WHERE updated_at IS NULL');
    await pgQuery('UPDATE tracks SET schema_version = 2 WHERE schema_version IS NULL OR schema_version < 2');
  } else {
    liteRun('UPDATE tracks SET sent_at = created_at WHERE sent = 1 AND sent_at IS NULL');
    liteRun('UPDATE tracks SET updated_at = created_at WHERE updated_at IS NULL');
    liteRun('UPDATE tracks SET schema_version = 2 WHERE schema_version IS NULL OR schema_version < 2');
  }
}

// One-time, restart-safe copy of legacy `opens` rows into the append-only
// `events` table. The `opens` table itself is left untouched.
async function migrateOpensToEvents() {
  const NAME = 'opens_to_events_v1';
  if (await hasMigration(NAME)) return;
  const rows = usePostgres
    ? (await pgQuery('SELECT track_id, opened_at, ip, user_agent, device, is_gmail_proxy FROM opens ORDER BY id ASC')).rows
    : liteAll('SELECT track_id, opened_at, ip, user_agent, device, is_gmail_proxy FROM opens ORDER BY id ASC');
  let n = 0;
  for (const r of rows) {
    const openedAt = r.opened_at instanceof Date ? r.opened_at.toISOString() : String(r.opened_at || nowISO());
    const ms = Date.parse(openedAt) || Date.now();
    const ua = String(r.user_agent || '');
    const proxy = usePostgres ? !!r.is_gmail_proxy : r.is_gmail_proxy === 1;
    const eventType = proxy ? 'GMAIL_PROXY' : (ua.trim() ? 'DIRECT' : 'UNKNOWN');
    const key = dedupeKey(r.track_id, eventType, ua, r.ip || '', ms);
    const client = normalizedClient(eventType, ua, r.ip || '');
    const vals = [r.track_id, openedAt, r.ip || '', ua.slice(0, 500), r.device || '', eventType, client, key, usePostgres ? false : 0];
    if (usePostgres) {
      await pgQuery(
        'INSERT INTO events (track_id, received_at, ip, user_agent, device, event_type, normalized_client, dedupe_key, is_suspected_self_view) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        vals);
    } else {
      liteRun(
        'INSERT INTO events (track_id, received_at, ip, user_agent, device, event_type, normalized_client, dedupe_key, is_suspected_self_view) VALUES (?,?,?,?,?,?,?,?,?)',
        ...vals);
    }
    n++;
  }
  await recordMigration(NAME);
  if (n) log.info('[db] migrated opens -> events', { rows: n });
}

// ---------- accounts ----------

async function ensureAccount(token) {
  if (!token || String(token).length < 36) throw new Error('invalid auth token');
  const hash = hashToken(token);
  if (usePostgres) {
    let r = await pgQuery('SELECT id FROM accounts WHERE token_hash = $1', [hash]);
    if (r.rowCount) return r.rows[0].id;
    const id = newAccountId();
    try {
      await pgQuery('INSERT INTO accounts (id, token_hash) VALUES ($1, $2)', [id, hash]);
      return id;
    } catch (e) {
      r = await pgQuery('SELECT id FROM accounts WHERE token_hash = $1', [hash]);
      if (r.rowCount) return r.rows[0].id;
      throw e;
    }
  }
  const existing = liteGet('SELECT id FROM accounts WHERE token_hash = ?', hash);
  if (existing) return existing.id;
  const id = newAccountId();
  try {
    liteRun('INSERT INTO accounts (id, token_hash, created_at) VALUES (?, ?, ?)', id, hash, nowISO());
    return id;
  } catch (e) {
    const again = liteGet('SELECT id FROM accounts WHERE token_hash = ?', hash);
    if (again) return again.id;
    throw e;
  }
}

async function getPrivacyMode(ownerId) {
  if (usePostgres) {
    const r = await pgQuery('SELECT privacy_mode FROM accounts WHERE id=$1', [ownerId]);
    return r.rowCount ? Number(r.rows[0].privacy_mode) === 1 : false;
  }
  const r = liteGet('SELECT privacy_mode FROM accounts WHERE id=?', ownerId);
  return r ? Number(r.privacy_mode) === 1 : false;
}

async function setPrivacyMode(ownerId, mode) {
  const v = mode ? 1 : 0;
  if (usePostgres) {
    await pgQuery('UPDATE accounts SET privacy_mode=$1 WHERE id=$2', [v, ownerId]);
  } else {
    liteRun('UPDATE accounts SET privacy_mode=? WHERE id=?', v, ownerId);
  }
  return true;
}

// ---------- Google identity linking (v2.3.0) ----------

async function getGoogleLink(ownerId) {
  if (usePostgres) {
    const r = await pgQuery('SELECT google_sub, google_email FROM accounts WHERE id=$1', [ownerId]);
    if (!r.rowCount || !r.rows[0].google_sub) return null;
    return { linked: true, email: r.rows[0].google_email || '' };
  }
  const r = liteGet('SELECT google_sub, google_email FROM accounts WHERE id=?', ownerId);
  if (!r || !r.google_sub) return null;
  return { linked: true, email: r.google_email || '' };
}

// Link the current install-token account to a verified Google identity.
// Merge rule: if another account already holds this google_sub, the current
// account's tracks move into it, this install token is repointed at it, and
// the now-empty account row is dropped. Returns { accountId, email, mergedTracks }.
async function linkGoogleAccount(ownerId, rawToken, sub, email) {
  const cleanSub = String(sub || '').slice(0, 128);
  const cleanEmail = String(email || '').slice(0, 200);
  if (!cleanSub) throw new Error('bad google sub');
  if (!rawToken || String(rawToken).length < 36) throw new Error('invalid auth token');
  const tokenHash = hashToken(rawToken);
  if (usePostgres) return pgLinkGoogleAccount(ownerId, tokenHash, cleanSub, cleanEmail);
  return liteLinkGoogleAccount(ownerId, tokenHash, cleanSub, cleanEmail);
}

async function pgLinkGoogleAccount(ownerId, tokenHash, sub, email) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT id, google_sub FROM accounts WHERE id=$1 FOR UPDATE', [ownerId]);
    if (!cur.rowCount) throw new Error('account not found');
    let targetRow = await client.query('SELECT id FROM accounts WHERE google_sub=$1 FOR UPDATE', [sub]);
    let targetId = targetRow.rowCount ? targetRow.rows[0].id : null;

    if (targetId === ownerId) {
      // Re-sign-in on the same account: just refresh the display email.
      await client.query('UPDATE accounts SET google_email=$1 WHERE id=$2', [email, ownerId]);
      await client.query('COMMIT');
      return { accountId: ownerId, email, mergedTracks: 0 };
    }

    if (!targetId) {
      // First link: attach the Google identity to the current account.
      await client.query('SAVEPOINT pmt_link');
      try {
        await client.query('UPDATE accounts SET google_sub=$1, google_email=$2 WHERE id=$3', [sub, email, ownerId]);
      } catch (e) {
        // Lost a race: someone linked this sub concurrently — merge instead.
        await client.query('ROLLBACK TO SAVEPOINT pmt_link');
        targetRow = await client.query('SELECT id FROM accounts WHERE google_sub=$1 FOR UPDATE', [sub]);
        if (!targetRow.rowCount) throw e;
        targetId = targetRow.rows[0].id;
      }
    }

    if (!targetId) {
      await client.query('COMMIT');
      return { accountId: ownerId, email, mergedTracks: 0 };
    }

    // Merge: move this account's tracks into the Google-linked account,
    // repoint this install token at it, drop the emptied account row.
    // (Target's privacy_mode and settings win.)
    const moved = await client.query('UPDATE tracks SET owner_id=$1 WHERE owner_id=$2', [targetId, ownerId]);
    await client.query('DELETE FROM accounts WHERE id=$1', [ownerId]);
    await client.query('UPDATE accounts SET token_hash=$1, google_email=$2 WHERE id=$3', [tokenHash, email, targetId]);
    await client.query('COMMIT');
    log.info('[db] google account merged', { from: ownerId, to: targetId, tracks: moved.rowCount });
    return { accountId: targetId, email, mergedTracks: moved.rowCount };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

function liteLinkGoogleAccount(ownerId, tokenHash, sub, email) {
  const cur = liteGet('SELECT id, google_sub FROM accounts WHERE id=?', ownerId);
  if (!cur) throw new Error('account not found');
  let target = liteGet('SELECT id FROM accounts WHERE google_sub=?', sub);
  let targetId = target ? target.id : null;

  if (targetId === ownerId) {
    liteRun('UPDATE accounts SET google_email=? WHERE id=?', email, ownerId);
    return { accountId: ownerId, email, mergedTracks: 0 };
  }

  if (!targetId) {
    try {
      liteRun('UPDATE accounts SET google_sub=?, google_email=? WHERE id=?', sub, email, ownerId);
    } catch (e) {
      // Lost a race — merge instead.
      target = liteGet('SELECT id FROM accounts WHERE google_sub=?', sub);
      if (!target) throw e;
      targetId = target.id;
    }
  }

  if (!targetId) return { accountId: ownerId, email, mergedTracks: 0 };

  const moved = liteRun('UPDATE tracks SET owner_id=? WHERE owner_id=?', targetId, ownerId);
  liteRun('DELETE FROM accounts WHERE id=?', ownerId);
  liteRun('UPDATE accounts SET token_hash=?, google_email=? WHERE id=?', tokenHash, email, targetId);
  log.info('[db] google account merged', { from: ownerId, to: targetId, tracks: moved.changes });
  return { accountId: targetId, email, mergedTracks: moved.changes };
}

// ---------- tracks ----------

function newId() { return 'trk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12); }

// Create a deferred (unsent) track with a client-generated id. Idempotent per
// (id, owner): retries never duplicate. An id owned by someone else is NEVER
// touched (owner_mismatch).
async function createTrack(subject, recipient, sender, opts = {}) {
  let id = opts.id;
  if (!(typeof id === 'string' && /^trk_[A-Za-z0-9]{12}$/.test(id))) id = newId();
  const ownerId = opts.ownerId;
  if (!ownerId) throw new Error('owner required');
  const at = nowISO();
  const subj = String(subject || '').slice(0, 300);
  const r = String(recipient || '').slice(0, 300);
  const s = String(sender || '').slice(0, 200);
  const existing = await getTrackOwner(id);
  if (existing) {
    if (existing.owner_id !== ownerId) {
      log.warn('[db] createTrack owner mismatch', { id });
      return { id, ok: false, reason: 'owner_mismatch' };
    }
    await updateTrack(id, ownerId, { subject: subj, recipient: r, sender: s });
    return { id, ok: true, deduped: true };
  }
  try {
    if (usePostgres) {
      await pgQuery(
        'INSERT INTO tracks (id, owner_id, subject, recipient, sender, sent, created_at, updated_at, schema_version) VALUES ($1,$2,$3,$4,$5,0,$6,$6,2)',
        [id, ownerId, subj, r, s, at]);
    } else {
      liteRun(
        'INSERT INTO tracks (id, owner_id, subject, recipient, sender, sent, created_at, updated_at, schema_version) VALUES (?,?,?,?,?,0,?,?,2)',
        id, ownerId, subj, r, s, at, at);
    }
    return { id, ok: true };
  } catch (e) {
    // Lost race with a concurrent insert for the same id: fall back to update.
    const again = await getTrackOwner(id);
    if (again && again.owner_id === ownerId) {
      await updateTrack(id, ownerId, { subject: subj, recipient: r, sender: s });
      return { id, ok: true, deduped: true };
    }
    log.warn('[db] createTrack conflict', { id, error: e.message });
    return { id, ok: false, reason: 'owner_mismatch' };
  }
}

async function getTrackOwner(id) {
  if (usePostgres) {
    const r = await pgQuery('SELECT id, owner_id, sent FROM tracks WHERE id=$1', [id]);
    return r.rowCount ? r.rows[0] : null;
  }
  return liteGet('SELECT id, owner_id, sent FROM tracks WHERE id=?', id) || null;
}

// Send-time commit: marks sent=1 with final metadata. Idempotent — committing
// twice (Send click + Sent-list fallback) still yields exactly one track.
async function commitTrack(id, ownerId, { subject, recipient, sender } = {}) {
  const existing = await getTrackOwner(id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.owner_id !== ownerId) {
    log.warn('[db] commitTrack owner mismatch', { id });
    return { ok: false, reason: 'owner_mismatch' };
  }
  const at = nowISO();
  const sets = ['sent = 1'];
  const vals = [];
  const ph = () => (usePostgres ? '$' + (vals.length + 1) : '?');
  if (typeof subject === 'string') { sets.push(`subject = ${ph()}`); vals.push(subject.slice(0, 300)); }
  if (typeof recipient === 'string') { sets.push(`recipient = ${ph()}`); vals.push(recipient.slice(0, 300)); }
  if (typeof sender === 'string') { sets.push(`sender = ${ph()}`); vals.push(sender.slice(0, 200)); }
  if (Number(existing.sent) !== 1) { sets.push(`sent_at = ${ph()}`); vals.push(at); }
  sets.push(`updated_at = ${ph()}`); vals.push(at);
  vals.push(id, ownerId);
  const n = vals.length;
  if (usePostgres) {
    await pgQuery(`UPDATE tracks SET ${sets.join(', ')} WHERE id=$${n - 1} AND owner_id=$${n}`, vals);
  } else {
    liteRun(`UPDATE tracks SET ${sets.join(', ')} WHERE id=? AND owner_id=?`, ...vals);
  }
  return { ok: true, alreadyCommitted: Number(existing.sent) === 1 };
}

async function updateTrack(id, ownerId, { subject, recipient, sender, sent }) {
  const sets = [], vals = [];
  const ph = () => (usePostgres ? '$' + (vals.length + 1) : '?');
  if (typeof subject === 'string') { sets.push(`subject = ${ph()}`); vals.push(subject.slice(0, 300)); }
  if (typeof recipient === 'string') { sets.push(`recipient = ${ph()}`); vals.push(recipient.slice(0, 300)); }
  if (typeof sender === 'string') { sets.push(`sender = ${ph()}`); vals.push(sender.slice(0, 200)); }
  if (sent === 1 || sent === 0) { sets.push(`sent = ${ph()}`); vals.push(sent); }
  if (!sets.length) return false;
  sets.push(`updated_at = ${ph()}`); vals.push(nowISO());
  if (usePostgres) {
    vals.push(id, ownerId);
    const r = await pgQuery(`UPDATE tracks SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND owner_id=$${vals.length}`, vals);
    return r.rowCount > 0;
  }
  const r = liteRun(`UPDATE tracks SET ${sets.join(', ')} WHERE id=? AND owner_id=?`, ...vals, id, ownerId);
  return r.changes > 0;
}

// ---------- detection events ----------

// Public pixel endpoint logic. NEVER throws; NEVER requires auth (email
// clients cannot send X-PMT-Key). Unknown / unsent tracks are ignored without
// leaking track existence.
async function logDetectionEvent(trackId, { ip, userAgent }) {
  try {
    const pid = pixelId(trackId);
    if (!pid) return { stored: false, reason: 'bad_id' };
    const track = await getTrackOwner(pid);
    if (!track || Number(track.sent) !== 1) return { stored: false, reason: 'not_sent' };
    const privacy = await getPrivacyMode(track.owner_id);
    const ua = String(userAgent || '').slice(0, 500);
    const eventType = classifyEvent(ua);
    const device = deviceFromUA(ua, eventType);
    const cleanIp = privacy ? '' : String(ip || '').slice(0, 64);
    const now = new Date();
    const receivedAt = now.toISOString();
    const key = dedupeKey(pid, eventType, ua, cleanIp, now.getTime());
    const client = normalizedClient(eventType, ua, cleanIp);
    if (usePostgres) {
      await pgQuery(
        `INSERT INTO events (track_id, received_at, ip, user_agent, device, event_type, normalized_client, dedupe_key, is_suspected_self_view)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)`,
        [pid, receivedAt, cleanIp, ua, device, eventType, client, key]);
      await pgQuery('UPDATE tracks SET updated_at=$1 WHERE id=$2', [receivedAt, pid]);
    } else {
      liteRun(
        `INSERT INTO events (track_id, received_at, ip, user_agent, device, event_type, normalized_client, dedupe_key, is_suspected_self_view)
         VALUES (?,?,?,?,?,?,?,?,0)`,
        pid, receivedAt, cleanIp, ua, device, eventType, client, key);
      liteRun('UPDATE tracks SET updated_at=? WHERE id=?', receivedAt, pid);
    }
    return { stored: true, eventType, dedupeKey: key };
  } catch (e) {
    log.error('[db] logDetectionEvent failed', { error: e.message });
    return { stored: false, reason: 'error' };
  }
}

// Deprecated v2.1 entry point — kept so nothing that still calls it breaks.
// Delegates to the v2.2 event model (flag-based self-view, no deletes).
async function logOpen(trackId, { ip, userAgent } = {}) {
  const r = await logDetectionEvent(trackId, { ip, userAgent });
  return r.stored;
}

// ---------- self-view (flag model, v2.2.0) ----------

async function recordSelfView(trackId, ownerId) {
  const pid = pixelId(trackId);
  if (!pid) return { recorded: false, flagged: 0 };
  const track = await getTrackOwner(pid);
  if (!track || track.owner_id !== ownerId) return { recorded: false, flagged: 0 };
  const now = nowISO();
  const fromISO = new Date(Date.now() - SELF_VIEW_BACK_SEC * 1000).toISOString();
  const toISO = new Date(Date.now() + SELF_VIEW_FWD_SEC * 1000).toISOString();
  let flagged = 0;
  if (usePostgres) {
    await pgQuery(
      'INSERT INTO self_views(track_id, viewed_at) VALUES($1,$2) ON CONFLICT(track_id) DO UPDATE SET viewed_at=EXCLUDED.viewed_at',
      [pid, now]);
    const r = await pgQuery(
      `UPDATE events SET is_suspected_self_view = TRUE
       WHERE track_id=$1 AND is_suspected_self_view = FALSE
         AND event_type IN ('GMAIL_PROXY','OTHER_PROXY')
         AND received_at >= $2::timestamptz AND received_at <= $3::timestamptz`,
      [pid, fromISO, toISO]);
    flagged = r.rowCount;
    await pgQuery(`DELETE FROM self_views WHERE viewed_at < NOW() - INTERVAL '30 days'`);
    await pgQuery('UPDATE tracks SET updated_at=$1 WHERE id=$2', [now, pid]);
  } else {
    liteRun('INSERT OR REPLACE INTO self_views(track_id, viewed_at) VALUES(?,?)', pid, now);
    const r = liteRun(
      `UPDATE events SET is_suspected_self_view = 1
       WHERE track_id=? AND is_suspected_self_view = 0
         AND event_type IN ('GMAIL_PROXY','OTHER_PROXY')
         AND received_at >= ? AND received_at <= ?`,
      pid, fromISO, toISO);
    flagged = r.changes;
    liteRun('DELETE FROM self_views WHERE viewed_at < ?', new Date(Date.now() - 30 * 86400000).toISOString());
    liteRun('UPDATE tracks SET updated_at=? WHERE id=?', now, pid);
  }
  return { recorded: true, flagged };
}

// ---------- analytics ----------

function analyticsAgg(alias) {
  // Counts only non-suspect events; callers join events pre-filtered or use
  // these CASE expressions. `alias` is the events table alias ('' for none).
  const p = alias ? alias + '.' : '';
  const ns = usePostgres ? `${p}is_suspected_self_view = FALSE` : `${p}is_suspected_self_view = 0`;
  const cnt = (type) => usePostgres
    ? `COUNT(*) FILTER (WHERE ${p}event_type='${type}' AND ${ns})`
    : `SUM(CASE WHEN ${p}event_type='${type}' AND ${ns} THEN 1 ELSE 0 END)`;
  const uniq = `COUNT(DISTINCT CASE WHEN ${ns} THEN ${p}dedupe_key END)`;
  return {
    raw: `SUM(CASE WHEN ${ns} THEN 1 ELSE 0 END)`,
    unique: uniq,
    proxy: cnt('GMAIL_PROXY'),
    direct: cnt('DIRECT'),
    other: cnt('OTHER_PROXY'),
    unknown: cnt('UNKNOWN'),
    suspect: usePostgres
      ? `COUNT(*) FILTER (WHERE ${p}is_suspected_self_view = TRUE)`
      : `SUM(CASE WHEN ${p}is_suspected_self_view = 1 THEN 1 ELSE 0 END)`,
    first: `MIN(CASE WHEN ${ns} THEN ${p}received_at END)`,
    last: `MAX(CASE WHEN ${ns} THEN ${p}received_at END)`,
  };
}

function normTs(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toAnalytics(row) {
  return {
    raw_event_count: Number(row.raw_events || 0),
    estimated_unique_events: Number(row.unique_events || 0),
    proxy_event_count: Number(row.proxy_events || 0),
    direct_event_count: Number(row.direct_events || 0),
    other_proxy_event_count: Number(row.other_events || 0),
    unknown_event_count: Number(row.unknown_events || 0),
    suspected_self_view_events: Number(row.suspect_events || 0),
    first_detected_at: normTs(row.first_detected),
    last_detected_at: normTs(row.last_detected),
  };
}

async function getAnalytics(trackId, ownerId) {
  const a = analyticsAgg('e');
  const where = usePostgres
    ? 'FROM events e JOIN tracks t ON t.id = e.track_id WHERE e.track_id=$1 AND t.owner_id=$2'
    : 'FROM events e JOIN tracks t ON t.id = e.track_id WHERE e.track_id=? AND t.owner_id=?';
  const sql = `SELECT ${a.raw} AS raw_events, ${a.unique} AS unique_events, ${a.proxy} AS proxy_events,
    ${a.direct} AS direct_events, ${a.other} AS other_events, ${a.unknown} AS unknown_events,
    ${a.suspect} AS suspect_events, ${a.first} AS first_detected, ${a.last} AS last_detected
    ${where}`;
  const row = usePostgres ? (await pgQuery(sql, [trackId, ownerId])).rows[0] : liteGet(sql, trackId, ownerId);
  return toAnalytics(row || {});
}

// ---------- reads ----------

function normEvent(r) {
  return {
    id: r.id,
    received_at: normTs(r.received_at),
    device: r.device || '',
    event_type: r.event_type || 'UNKNOWN',
    is_suspected_self_view: usePostgres ? !!r.is_suspected_self_view : r.is_suspected_self_view === 1,
  };
}

async function getTrack(trackId, ownerId, opts = {}) {
  const includeEvents = opts.includeEvents !== false;
  const includeDiagnostics = !!opts.includeDiagnostics;
  let t;
  if (usePostgres) {
    const r = await pgQuery(
      'SELECT id, subject, recipient, sender, sent, created_at, sent_at, updated_at FROM tracks WHERE id=$1 AND owner_id=$2',
      [trackId, ownerId]);
    if (!r.rowCount) return null;
    t = r.rows[0];
  } else {
    t = liteGet(
      'SELECT id, subject, recipient, sender, sent, created_at, sent_at, updated_at FROM tracks WHERE id=? AND owner_id=?',
      trackId, ownerId);
    if (!t) return null;
  }
  const analytics = await getAnalytics(trackId, ownerId);
  let events = [];
  if (includeEvents) {
    const cols = includeDiagnostics
      ? 'id, received_at, ip, user_agent, device, event_type, is_suspected_self_view'
      : 'id, received_at, device, event_type, is_suspected_self_view';
    const rows = usePostgres
      ? (await pgQuery(`SELECT ${cols} FROM events WHERE track_id=$1 ORDER BY received_at ASC LIMIT 500`, [trackId])).rows
      : liteAll(`SELECT ${cols} FROM events WHERE track_id=? ORDER BY received_at ASC LIMIT 500`, trackId);
    events = rows.map((r) => {
      const e = normEvent(r);
      if (includeDiagnostics) { e.ip = r.ip || ''; e.user_agent = r.user_agent || ''; }
      return e;
    });
  }
  return {
    id: t.id,
    subject: t.subject,
    recipient: t.recipient || '',
    sender: t.sender || '',
    sent: Number(t.sent) === 1,
    created_at: normTs(t.created_at),
    sent_at: normTs(t.sent_at),
    updated_at: normTs(t.updated_at),
    analytics,
    events,
    // Legacy shape for older extension builds.
    opens: events.map((e) => ({ opened_at: e.received_at, device: e.device, is_gmail_proxy: e.event_type === 'GMAIL_PROXY' })),
  };
}

async function listTracks(ownerId, limitOrOpts = 50, includeUnsent = false) {
  const opts = typeof limitOrOpts === 'object' && limitOrOpts !== null
    ? limitOrOpts
    : { limit: limitOrOpts, includeUnsent };
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 500);
  const sentFilter = opts.includeUnsent ? '' : 'AND t.sent=1';
  const sinceFilter = opts.updatedSince
    ? (usePostgres ? 'AND t.updated_at > $2::timestamptz' : 'AND t.updated_at > ?')
    : '';
  // Join filters out suspected self-view events, so plain COUNT(e.id) counts
  // only analytics-relevant events. Suspect events stay in the table.
  const join = usePostgres
    ? 'LEFT JOIN events e ON e.track_id = t.id AND e.is_suspected_self_view = FALSE'
    : 'LEFT JOIN events e ON e.track_id = t.id AND e.is_suspected_self_view = 0';
  const agg = usePostgres ? {
    raw: 'COUNT(e.id)',
    unique: 'COUNT(DISTINCT e.dedupe_key)',
    proxy: `COUNT(e.id) FILTER (WHERE e.event_type='GMAIL_PROXY')`,
    direct: `COUNT(e.id) FILTER (WHERE e.event_type='DIRECT')`,
    other: `COUNT(e.id) FILTER (WHERE e.event_type='OTHER_PROXY')`,
    unknown: `COUNT(e.id) FILTER (WHERE e.event_type='UNKNOWN')`,
  } : {
    raw: 'COUNT(e.id)',
    unique: 'COUNT(DISTINCT e.dedupe_key)',
    proxy: `SUM(CASE WHEN e.event_type='GMAIL_PROXY' THEN 1 ELSE 0 END)`,
    direct: `SUM(CASE WHEN e.event_type='DIRECT' THEN 1 ELSE 0 END)`,
    other: `SUM(CASE WHEN e.event_type='OTHER_PROXY' THEN 1 ELSE 0 END)`,
    unknown: `SUM(CASE WHEN e.event_type='UNKNOWN' THEN 1 ELSE 0 END)`,
  };
  const params = [ownerId];
  if (opts.updatedSince) params.push(opts.updatedSince);
  params.push(limit);
  const ownerPh = usePostgres ? '$1' : '?';
  const limitPh = usePostgres ? `$${params.length}` : '?';
  const sql = `SELECT t.id, t.subject, t.recipient, t.sender, t.sent, t.created_at, t.sent_at, t.updated_at,
      ${agg.raw} AS raw_events, ${agg.unique} AS unique_events,
      ${agg.proxy} AS proxy_events, ${agg.direct} AS direct_events,
      ${agg.other} AS other_events, ${agg.unknown} AS unknown_events,
      MIN(e.received_at) AS first_detected, MAX(e.received_at) AS last_detected
    FROM tracks t ${join}
    WHERE t.owner_id=${ownerPh} ${sentFilter} ${sinceFilter}
    GROUP BY t.id ORDER BY t.updated_at DESC LIMIT ${limitPh}`;
  const rows = usePostgres ? (await pgQuery(sql, params)).rows : liteAll(sql, ...params);
  return rows.map((x) => ({
    id: x.id,
    subject: x.subject,
    recipient: x.recipient || '',
    sender: x.sender || '',
    sent: Number(x.sent) === 1,
    created_at: normTs(x.created_at),
    sent_at: normTs(x.sent_at),
    updated_at: normTs(x.updated_at),
    analytics: toAnalytics({
      raw_events: x.raw_events, unique_events: x.unique_events,
      proxy_events: x.proxy_events, direct_events: x.direct_events,
      other_events: x.other_events, unknown_events: x.unknown_events,
      suspect_events: 0, first_detected: x.first_detected, last_detected: x.last_detected,
    }),
  }));
}

async function reportSummary(ownerId, fromISO, toISO) {
  const a = analyticsAgg('e');
  const ttf = usePostgres
    ? `MIN(CASE WHEN e.is_suspected_self_view = FALSE THEN EXTRACT(EPOCH FROM (e.received_at - t.sent_at)) END)`
    : `MIN(CASE WHEN e.is_suspected_self_view = 0 THEN (julianday(e.received_at) - julianday(t.sent_at)) * 86400 END)`;
  const join = usePostgres
    ? 'LEFT JOIN events e ON e.track_id = t.id'
    : 'LEFT JOIN events e ON e.track_id = t.id';
  const where = usePostgres
    ? 'WHERE t.owner_id=$1 AND t.sent_at >= $2::timestamptz AND t.sent_at < $3::timestamptz AND t.sent=1'
    : 'WHERE t.owner_id=? AND t.sent_at >= ? AND t.sent_at < ? AND t.sent=1';
  const sql = `SELECT t.id, t.subject, t.recipient, t.sender, t.sent_at,
      ${a.raw} AS raw_events, ${a.unique} AS unique_events,
      ${a.proxy} AS proxy_events, ${a.direct} AS direct_events,
      ${a.other} AS other_events, ${a.unknown} AS unknown_events,
      ${a.first} AS first_detected, ${a.last} AS last_detected,
      ${ttf} AS ttf_sec
    FROM tracks t ${join} ${where} GROUP BY t.id ORDER BY t.sent_at ASC`;
  const rows = usePostgres
    ? (await pgQuery(sql, [ownerId, fromISO, toISO])).rows
    : liteAll(sql, ownerId, fromISO, toISO);
  return rows.map((x) => ({
    track_id: x.id,
    subject: x.subject,
    recipient: x.recipient || '',
    sender: x.sender || '',
    sent_at: normTs(x.sent_at),
    raw_events: Number(x.raw_events || 0),
    unique_events: Number(x.unique_events || 0),
    proxy_events: Number(x.proxy_events || 0),
    direct_events: Number(x.direct_events || 0),
    other_proxy_events: Number(x.other_events || 0),
    unknown_events: Number(x.unknown_events || 0),
    first_detected_at: normTs(x.first_detected),
    last_detected_at: normTs(x.last_detected),
    time_to_first_detection_sec: x.ttf_sec == null ? null : Math.round(Number(x.ttf_sec)),
    // Legacy aliases for older clients.
    opens: Number(x.raw_events || 0),
    first_open: normTs(x.first_detected) || '',
    last_open: normTs(x.last_detected) || '',
    proxy_opens: Number(x.proxy_events || 0),
  }));
}

module.exports = {
  init,
  ensureAccount,
  getPrivacyMode,
  setPrivacyMode,
  getGoogleLink,
  linkGoogleAccount,
  createTrack,
  commitTrack,
  updateTrack,
  logDetectionEvent,
  logOpen, // deprecated shim -> logDetectionEvent
  recordSelfView,
  getAnalytics,
  getTrack,
  listTracks,
  reportSummary,
  backend: () => (usePostgres ? 'postgres' : 'sqlite'),
};
