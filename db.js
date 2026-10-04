// ProMail Tracker storage layer — v2
// Postgres is recommended for hosted deployments; node:sqlite is supported for local/VPS use.
const crypto = require('crypto');
const path = require('path');
const usePostgres = !!process.env.DATABASE_URL;
let sqliteDb = null;
let pgPool = null;

const LEGACY_OWNER = 'legacy';

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}',
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
CREATE INDEX IF NOT EXISTS idx_tracks_owner_created ON tracks(owner_id, created_at);
CREATE TABLE IF NOT EXISTS self_views (
  track_id TEXT PRIMARY KEY,
  viewed_at TEXT NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}',
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
CREATE INDEX IF NOT EXISTS idx_tracks_owner_created ON tracks(owner_id, created_at);
CREATE TABLE IF NOT EXISTS self_views (
  track_id TEXT PRIMARY KEY,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}
function newAccountId() { return 'acct_' + crypto.randomUUID().replace(/-/g, ''); }

async function init() {
  if (usePostgres) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pgPool.query(PG_SCHEMA);
    await pgPool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}'`);
    await pgPool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT ''`);
    await pgPool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT ''`);
    await pgPool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS sent INTEGER NOT NULL DEFAULT 0`);
    // Existing records belong to the old single-user deployment and are not exposed to new accounts.
    console.log('[db] using Postgres');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const file = process.env.SQLITE_FILE || path.join(__dirname, 'tracker.db');
    sqliteDb = new DatabaseSync(file);
    sqliteDb.exec(SQLITE_SCHEMA);
    const cols = sqliteDb.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
    if (!cols.includes('owner_id')) sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER}'`);
    if (!cols.includes('recipient')) sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN recipient TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('sender')) sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN sender TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('sent')) {
      sqliteDb.exec(`ALTER TABLE tracks ADD COLUMN sent INTEGER NOT NULL DEFAULT 0`);
      sqliteDb.exec(`UPDATE tracks SET sent = 1`);
    }
    console.log('[db] using SQLite file:', file);
  }
}

async function ensureAccount(token) {
  if (!token || String(token).length < 36) throw new Error('invalid auth token');
  const hash = hashToken(token);
  if (usePostgres) {
    let r = await pgPool.query('SELECT id FROM accounts WHERE token_hash = $1', [hash]);
    if (r.rowCount) return r.rows[0].id;
    const id = newAccountId();
    try {
      await pgPool.query('INSERT INTO accounts (id, token_hash) VALUES ($1, $2)', [id, hash]);
      return id;
    } catch (e) {
      r = await pgPool.query('SELECT id FROM accounts WHERE token_hash = $1', [hash]);
      if (r.rowCount) return r.rows[0].id;
      throw e;
    }
  }
  const existing = sqliteDb.prepare('SELECT id FROM accounts WHERE token_hash = ?').get(hash);
  if (existing) return existing.id;
  const id = newAccountId();
  try {
    sqliteDb.prepare('INSERT INTO accounts (id, token_hash, created_at) VALUES (?, ?, ?)').run(id, hash, new Date().toISOString());
    return id;
  } catch (e) {
    const again = sqliteDb.prepare('SELECT id FROM accounts WHERE token_hash = ?').get(hash);
    if (again) return again.id;
    throw e;
  }
}

function newId() { return 'trk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12); }

async function createTrack(subject, recipient, sender, opts = {}) {
  let id = opts.id;
  if (!(typeof id === 'string' && /^trk_[A-Za-z0-9]{12}$/.test(id))) id = newId();
  const ownerId = opts.ownerId;
  if (!ownerId) throw new Error('owner required');
  const createdAt = new Date().toISOString();
  const r = (recipient || '').slice(0, 300);
  const s = (sender || '').slice(0, 200);
  const sent = opts.deferred ? 0 : 1;
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO tracks (id, owner_id, subject, recipient, sender, sent, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET owner_id=EXCLUDED.owner_id, subject=EXCLUDED.subject, recipient=EXCLUDED.recipient, sender=EXCLUDED.sender, sent=EXCLUDED.sent`,
      [id, ownerId, subject || '', r, s, sent, createdAt]);
  } else {
    sqliteDb.prepare(
      `INSERT INTO tracks (id, owner_id, subject, recipient, sender, sent, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, subject=excluded.subject, recipient=excluded.recipient, sender=excluded.sender, sent=excluded.sent`
    ).run(id, ownerId, subject || '', r, s, sent, createdAt);
  }
  return id;
}

async function updateTrack(id, ownerId, { subject, recipient, sender, sent }) {
  const sets = [], vals = [];
  if (typeof subject === 'string') { sets.push(`subject = ${usePostgres ? '$'+(vals.length+1) : '?'}`); vals.push(subject.slice(0,300)); }
  if (typeof recipient === 'string') { sets.push(`recipient = ${usePostgres ? '$'+(vals.length+1) : '?'}`); vals.push(recipient.slice(0,300)); }
  if (typeof sender === 'string') { sets.push(`sender = ${usePostgres ? '$'+(vals.length+1) : '?'}`); vals.push(sender.slice(0,200)); }
  if (sent === 1 || sent === 0) { sets.push(`sent = ${usePostgres ? '$'+(vals.length+1) : '?'}`); vals.push(sent); }
  if (!sets.length) return false;
  if (usePostgres) {
    vals.push(id, ownerId);
    const r = await pgPool.query(`UPDATE tracks SET ${sets.join(', ')} WHERE id=$${vals.length-1} AND owner_id=$${vals.length}`, vals);
    return r.rowCount > 0;
  }
  const r = sqliteDb.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id=? AND owner_id=?`).run(...vals, id, ownerId);
  return r.changes > 0;
}

async function logOpen(trackId, { ip, userAgent, device, isGmailProxy }) {
  const openedAt = new Date().toISOString();
  if (await recentSelfView(trackId, 15)) return false;
  if (usePostgres) {
    const r = await pgPool.query('SELECT sent FROM tracks WHERE id=$1', [trackId]);
    if (!r.rowCount || Number(r.rows[0].sent)!==1) return false;
    await pgPool.query('INSERT INTO opens (track_id,opened_at,ip,user_agent,device,is_gmail_proxy) VALUES ($1,$2,$3,$4,$5,$6)', [trackId,openedAt,ip||'',userAgent||'',device||'',!!isGmailProxy]);
  } else {
    const row = sqliteDb.prepare('SELECT sent FROM tracks WHERE id=?').get(trackId);
    if (!row || Number(row.sent)!==1) return false;
    sqliteDb.prepare('INSERT INTO opens (track_id,opened_at,ip,user_agent,device,is_gmail_proxy) VALUES (?,?,?,?,?,?)').run(trackId,openedAt,ip||'',userAgent||'',device||'',isGmailProxy?1:0);
  }
  return true;
}

const cutoffISO = sec => new Date(Date.now()-sec*1000).toISOString();
async function recentSelfView(trackId, windowSec) {
  const cutoff=cutoffISO(windowSec);
  if(usePostgres){const r=await pgPool.query('SELECT 1 FROM self_views WHERE track_id=$1 AND viewed_at>$2::timestamptz',[trackId,cutoff]);return r.rowCount>0;}
  return !!sqliteDb.prepare('SELECT 1 FROM self_views WHERE track_id=? AND viewed_at>?').get(trackId,cutoff);
}
async function deleteRecentOpens(trackId, windowSec){
  const cutoff=cutoffISO(windowSec);
  if(usePostgres){const r=await pgPool.query('DELETE FROM opens WHERE track_id=$1 AND opened_at>$2::timestamptz AND is_gmail_proxy=TRUE',[trackId,cutoff]);return r.rowCount;}
  return sqliteDb.prepare('DELETE FROM opens WHERE track_id=? AND opened_at>? AND is_gmail_proxy=1').run(trackId,cutoff).changes;
}
async function recordSelfView(trackId, ownerId){
  const exists=usePostgres ? (await pgPool.query('SELECT 1 FROM tracks WHERE id=$1 AND owner_id=$2',[trackId,ownerId])).rowCount>0 : !!sqliteDb.prepare('SELECT 1 FROM tracks WHERE id=? AND owner_id=?').get(trackId,ownerId);
  if(!exists) return {recorded:false,removed:0};
  const now=new Date().toISOString();
  if(usePostgres){await pgPool.query(`INSERT INTO self_views(track_id,viewed_at) VALUES($1,$2) ON CONFLICT(track_id) DO UPDATE SET viewed_at=EXCLUDED.viewed_at`,[trackId,now]);await pgPool.query(`DELETE FROM self_views WHERE viewed_at<NOW()-INTERVAL '1 day'`);} 
  else {sqliteDb.prepare('INSERT OR REPLACE INTO self_views(track_id,viewed_at) VALUES(?,?)').run(trackId,now);sqliteDb.prepare('DELETE FROM self_views WHERE viewed_at<?').run(new Date(Date.now()-86400000).toISOString());}
  return {recorded:true,removed:await deleteRecentOpens(trackId,5)};
}
function normRow(r){return {id:r.id,track_id:r.track_id,opened_at:r.opened_at instanceof Date?r.opened_at.toISOString():r.opened_at,ip:r.ip,user_agent:r.user_agent,device:r.device,is_gmail_proxy:usePostgres?!!r.is_gmail_proxy:r.is_gmail_proxy===1};}
async function getTrack(trackId, ownerId){
  if(usePostgres){const r=await pgPool.query('SELECT id,subject,recipient,sender,sent,created_at FROM tracks WHERE id=$1 AND owner_id=$2',[trackId,ownerId]);if(!r.rowCount)return null;const t=r.rows[0];const o=await pgPool.query('SELECT id,track_id,opened_at,ip,user_agent,device,is_gmail_proxy FROM opens WHERE track_id=$1 ORDER BY opened_at ASC',[trackId]);return {id:t.id,subject:t.subject,recipient:t.recipient||'',sender:t.sender||'',sent:Number(t.sent)===1,created_at:t.created_at.toISOString(),opens:o.rows.map(normRow)};}
  const t=sqliteDb.prepare('SELECT id,subject,recipient,sender,sent,created_at FROM tracks WHERE id=? AND owner_id=?').get(trackId,ownerId);if(!t)return null;const opens=sqliteDb.prepare('SELECT id,track_id,opened_at,ip,user_agent,device,is_gmail_proxy FROM opens WHERE track_id=? ORDER BY opened_at ASC').all(trackId).map(normRow);return {id:t.id,subject:t.subject,recipient:t.recipient||'',sender:t.sender||'',sent:Number(t.sent)===1,created_at:t.created_at,opens};
}
async function listTracks(ownerId,limit=50,includeUnsent=false){
  const sentFilter=includeUnsent?'':'AND t.sent=1';
  if(usePostgres){const r=await pgPool.query(`SELECT t.id,t.subject,t.recipient,t.sender,t.sent,t.created_at,COUNT(o.id) AS open_count,MIN(o.opened_at) AS first_open,MAX(o.opened_at) AS last_open,COUNT(o.id) FILTER(WHERE o.is_gmail_proxy) AS proxy_opens FROM tracks t LEFT JOIN opens o ON o.track_id=t.id WHERE t.owner_id=$1 ${sentFilter} GROUP BY t.id ORDER BY t.created_at DESC LIMIT $2`,[ownerId,limit]);return r.rows.map(x=>({id:x.id,subject:x.subject,recipient:x.recipient||'',sender:x.sender||'',sent:Number(x.sent)===1,created_at:x.created_at.toISOString(),open_count:Number(x.open_count),first_open:x.first_open?x.first_open.toISOString():null,last_open:x.last_open?x.last_open.toISOString():null,proxy_opens:Number(x.proxy_opens)}));}
  return sqliteDb.prepare(`SELECT t.id,t.subject,t.recipient,t.sender,t.sent,t.created_at,COUNT(o.id) AS open_count,MIN(o.opened_at) AS first_open,MAX(o.opened_at) AS last_open,COALESCE(SUM(o.is_gmail_proxy),0) AS proxy_opens FROM tracks t LEFT JOIN opens o ON o.track_id=t.id WHERE t.owner_id=? ${sentFilter} GROUP BY t.id ORDER BY t.created_at DESC LIMIT ?`).all(ownerId,limit).map(x=>({id:x.id,subject:x.subject,recipient:x.recipient||'',sender:x.sender||'',sent:Number(x.sent)===1,created_at:x.created_at,open_count:x.open_count,first_open:x.first_open||null,last_open:x.last_open||null,proxy_opens:x.proxy_opens}));
}
async function reportSummary(ownerId,fromISO,toISO){
  if(usePostgres){const r=await pgPool.query(`SELECT t.id,t.subject,t.recipient,t.sender,t.created_at,COUNT(o.id) AS open_count,MIN(o.opened_at) AS first_open,MAX(o.opened_at) AS last_open,COUNT(o.id) FILTER(WHERE o.is_gmail_proxy) AS proxy_opens FROM tracks t LEFT JOIN opens o ON o.track_id=t.id WHERE t.owner_id=$1 AND t.created_at>=$2 AND t.created_at<$3 AND t.sent=1 GROUP BY t.id ORDER BY t.created_at ASC`,[ownerId,fromISO,toISO]);return r.rows.map(x=>({track_id:x.id,subject:x.subject,recipient:x.recipient||'',sender:x.sender||'',sent_at:x.created_at.toISOString(),opens:Number(x.open_count),first_open:x.first_open?x.first_open.toISOString():'',last_open:x.last_open?x.last_open.toISOString():'',proxy_opens:Number(x.proxy_opens)}));}
  return sqliteDb.prepare(`SELECT t.id,t.subject,t.recipient,t.sender,t.created_at,COUNT(o.id) AS open_count,MIN(o.opened_at) AS first_open,MAX(o.opened_at) AS last_open,COALESCE(SUM(o.is_gmail_proxy),0) AS proxy_opens FROM tracks t LEFT JOIN opens o ON o.track_id=t.id WHERE t.owner_id=? AND t.created_at>=? AND t.created_at<? AND t.sent=1 GROUP BY t.id ORDER BY t.created_at ASC`).all(ownerId,fromISO,toISO).map(x=>({track_id:x.id,subject:x.subject,recipient:x.recipient||'',sender:x.sender||'',sent_at:x.created_at,opens:x.open_count,first_open:x.first_open||'',last_open:x.last_open||'',proxy_opens:x.proxy_opens}));
}
module.exports={init,ensureAccount,createTrack,updateTrack,logOpen,getTrack,listTracks,reportSummary,recordSelfView,recentSelfView,backend:()=>usePostgres?'postgres':'sqlite'};
