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
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
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
    console.log('[db] using SQLite file:', file);
  }
}

function newId() {
  return 'trk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function createTrack(subject, recipient, sender) {
  const id = newId();
  const createdAt = new Date().toISOString();
  const r = (recipient || '').slice(0, 300);
  const s = (sender || '').slice(0, 200);
  if (usePostgres) {
    await pgPool.query('INSERT INTO tracks (id, subject, recipient, sender, created_at) VALUES ($1, $2, $3, $4, $5)', [id, subject || '', r, s, createdAt]);
  } else {
    sqliteDb.prepare('INSERT INTO tracks (id, subject, recipient, sender, created_at) VALUES (?, ?, ?, ?, ?)').run(id, subject || '', r, s, createdAt);
  }
  return id;
}

// Update subject/recipient/sender after compose (values are final only at send time).
async function updateTrack(id, { subject, recipient, sender }) {
  const sets = [];
  const vals = [];
  if (typeof subject === 'string') { sets.push(`subject = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(subject.slice(0, 300)); }
  if (typeof recipient === 'string') { sets.push(`recipient = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(recipient.slice(0, 300)); }
  if (typeof sender === 'string') { sets.push(`sender = ${usePostgres ? '$' + (vals.length + 1) : '?'}`); vals.push(sender.slice(0, 200)); }
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
  if (usePostgres) {
    const r = await pgPool.query('SELECT 1 FROM tracks WHERE id = $1', [trackId]);
    if (r.rowCount === 0) return false;
    await pgPool.query(
      'INSERT INTO opens (track_id, opened_at, ip, user_agent, device, is_gmail_proxy) VALUES ($1, $2, $3, $4, $5, $6)',
      [trackId, openedAt, ip || '', userAgent || '', device || '', !!isGmailProxy]
    );
    return true;
  }
  const exists = sqliteDb.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId);
  if (!exists) return false;
  sqliteDb.prepare(
    'INSERT INTO opens (track_id, opened_at, ip, user_agent, device, is_gmail_proxy) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(trackId, openedAt, ip || '', userAgent || '', device || '', isGmailProxy ? 1 : 0);
  return true;
}

function normRow(r) {
  return {
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

async function listTracks(limit = 50) {
  if (usePostgres) {
    const r = await pgPool.query(
      `SELECT t.id, t.subject, t.recipient, t.sender, t.created_at,
              COUNT(o.id) AS open_count,
              MIN(o.opened_at) AS first_open,
              MAX(o.opened_at) AS last_open,
              COUNT(o.id) FILTER (WHERE o.is_gmail_proxy) AS proxy_opens
       FROM tracks t LEFT JOIN opens o ON o.track_id = t.id
       GROUP BY t.id ORDER BY t.created_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows.map((x) => ({
      id: x.id,
      subject: x.subject,
      recipient: x.recipient || '',
      sender: x.sender || '',
      created_at: x.created_at.toISOString(),
      open_count: Number(x.open_count),
      first_open: x.first_open ? x.first_open.toISOString() : null,
      last_open: x.last_open ? x.last_open.toISOString() : null,
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
     GROUP BY t.id ORDER BY t.created_at DESC LIMIT ?`
  ).all(limit);
  return rows.map((x) => ({
    id: x.id,
    subject: x.subject,
    recipient: x.recipient || '',
    sender: x.sender || '',
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
       WHERE t.created_at >= $1 AND t.created_at < $2
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
     WHERE t.created_at >= ? AND t.created_at < ?
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

module.exports = { init, createTrack, updateTrack, logOpen, getTrack, listTracks, reportSummary, backend: () => (usePostgres ? 'postgres' : 'sqlite') };
