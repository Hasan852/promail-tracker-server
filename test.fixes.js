// server/test.fixes.js — regression tests for the v2.4.2 fixes.
// Run: npm test   (separate port + DB file so it can run in parallel with test.js)

process.env.SQLITE_FILE = '/tmp/pmt-fixes-' + process.pid + '.db';
process.env.PORT = '41098';
process.env.NEW_ACCOUNTS_PER_IP_HOUR = '4';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const db = require('./db');

const BASE = 'http://127.0.0.1:41098';
const TOKEN = 'pmt_' + 'c'.repeat(64);
const GMAIL_UA = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const OUTLOOK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Outlook/16.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tid() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'trk_'; for (let i = 0; i < 12; i++) s += c[Math.floor(Math.random() * 62)];
  return s;
}
async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'X-PMT-Key': token || '', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, json, res };
}
const hit = (id, ua, method = 'GET') => fetch(BASE + `/px/${id}.gif`, { method, headers: { 'user-agent': ua } });
const analytics = async (id) => (await api('GET', `/api/tracks/${id}`, TOKEN)).json.analytics;

describe('v2.4.2 server fixes', () => {
  let closeServer, server;
  before(async () => {
    try { fs.unlinkSync(process.env.SQLITE_FILE); } catch (e) { /* fresh */ }
    await db.init();
    server = require('./server.js');
    closeServer = server.close;
    await sleep(300);
  });
  after(() => {
    try { closeServer(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(process.env.SQLITE_FILE); } catch (e) { /* keep */ }
    setTimeout(() => process.exit(0), 50).unref();
  });

  test('commit of a track the server never saw creates AND commits it (lost compose-time create)', async () => {
    const id = tid();
    const c = await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'Quote', to: 'a@b.com', from: 'me@x.com' });
    assert.equal(c.status, 200);
    assert.equal(c.json.ok, true);
    const t = (await api('GET', `/api/tracks/${id}`, TOKEN)).json;
    assert.equal(t.sent, true);
    assert.equal(t.subject, 'Quote');
    assert.equal(t.recipient, 'a@b.com');
    await hit(id, GMAIL_UA);
    assert.equal((await analytics(id)).raw_event_count, 1, 'the recipient open is counted');
  });

  test('commit is still idempotent and owner-isolated', async () => {
    const id = tid();
    await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'S', to: 'a@b.com' });
    const again = await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'S', to: 'a@b.com' });
    assert.equal(again.json.alreadyCommitted, true);
    const other = await api('POST', `/api/tracks/${id}/commit`, 'pmt_' + 'd'.repeat(64), { subject: 'hijack' });
    assert.equal(other.status, 409, 'another owner can never take over an id');
    assert.equal((await api('GET', `/api/tracks/${id}`, TOKEN)).json.subject, 'S');
  });

  test('legacy create-track: without deferred=1 it commits, with deferred=1 it stays unsent', async () => {
    const a = tid(); const b = tid();
    await fetch(BASE + `/api/create-track?id=${a}&subject=L1&to=l@x.com`, { headers: { 'X-PMT-Key': TOKEN } });
    await fetch(BASE + `/api/create-track?id=${b}&subject=L2&to=l@x.com&deferred=1`, { headers: { 'X-PMT-Key': TOKEN } });
    assert.equal((await api('GET', `/api/tracks/${a}`, TOKEN)).json.sent, true);
    assert.equal((await api('GET', `/api/tracks/${b}`, TOKEN)).json.sent, false);
  });

  test('self-view: signal BEFORE the proxy hit flags that hit (forward window)', async () => {
    const id = tid();
    await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'Own', to: 'r@x.com' });
    await api('POST', `/api/tracks/${id}/self-view`, TOKEN, {});
    await hit(id, GMAIL_UA);
    const a = await analytics(id);
    assert.equal(a.raw_event_count, 0, 'sender own view not counted');
    assert.equal(a.estimated_unique_events, 0);
    const diag = (await api('GET', `/api/tracks/${id}?diagnostics=1`, TOKEN)).json.events;
    assert.equal(diag.length, 1, 'raw event kept for audit');
    assert.equal(diag[0].is_suspected_self_view, true);
  });

  test('self-view: a receiver on a non-proxy client is never flagged', async () => {
    const id = tid();
    await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'Own2', to: 'r@x.com' });
    await api('POST', `/api/tracks/${id}/self-view`, TOKEN, {});
    await hit(id, OUTLOOK_UA);
    assert.equal((await analytics(id)).raw_event_count, 1);
  });

  test('self-view windows are tight: a recipient open 60s earlier is NOT eaten', async () => {
    const id = tid();
    await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'Own3', to: 'r@x.com' });
    await hit(id, GMAIL_UA);
    // age the event by 60s directly in the database
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.SQLITE_FILE);
    raw.prepare('UPDATE events SET received_at=? WHERE track_id=?').run(new Date(Date.now() - 60000).toISOString(), id);
    raw.close();
    await api('POST', `/api/tracks/${id}/self-view`, TOKEN, {});
    assert.equal((await analytics(id)).raw_event_count, 1, 'real recipient detection survives');
  });

  test('HEAD request to the pixel serves the gif but never counts', async () => {
    const id = tid();
    await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: 'H', to: 'r@x.com' });
    const r = await hit(id, OUTLOOK_UA, 'HEAD');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/gif');
    assert.equal((await analytics(id)).raw_event_count, 0);
    await hit(id, OUTLOOK_UA);
    assert.equal((await analytics(id)).raw_event_count, 1);
  });

  test('account creation is rate-limited per IP; existing accounts keep working', async () => {
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await api('POST', '/api/bootstrap', 'pmt_' + String(i).repeat(64))).status);
    assert.ok(results.includes(429), 'token rotation is stopped: ' + results.join(','));
    assert.equal((await api('POST', '/api/bootstrap', TOKEN)).status, 200, 'known token unaffected');
  });

  test('week/month ranges follow the report timezone (Dhaka)', () => {
    const w = server.currentWeekRange('Asia/Dhaka', Date.UTC(2026, 9, 3, 23, 30)); // Sun 05:30 Dhaka
    assert.equal(w.label, '2026-09-28');
    assert.equal(w.from, '2026-09-27T18:00:00.000Z');
    assert.equal(w.to, '2026-10-04T18:00:00.000Z');
    const w2 = server.currentWeekRange('Asia/Dhaka', Date.UTC(2026, 9, 4, 19, 0)); // Mon 01:00 Dhaka
    assert.equal(w2.label, '2026-10-05');
    const m = server.currentMonthRange('Asia/Dhaka', Date.UTC(2026, 8, 30, 20, 0)); // Oct 1 02:00 Dhaka
    assert.equal(m.label, '2026-10');
    assert.equal(m.from, '2026-09-30T18:00:00.000Z');
    assert.equal(m.to, '2026-10-31T18:00:00.000Z');
    const u = server.currentWeekRange('UTC', Date.UTC(2026, 9, 3, 23, 30));
    assert.equal(u.from, '2026-09-28T00:00:00.000Z');
  });

  test('date-only report bounds are local midnight in tz', async () => {
    const r = await api('GET', '/api/report/weekly?from=2026-10-01&to=2026-10-02&tz=Asia/Dhaka', TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.json.from, '2026-09-30T18:00:00.000Z');
    assert.equal(r.json.to, '2026-10-01T18:00:00.000Z');
  });

  test('CSV neutralises spreadsheet formulas in subjects', async () => {
    const id = tid();
    await api('POST', `/api/tracks/${id}/commit`, TOKEN, { subject: '=HYPERLINK("http://evil")', to: 'a@b.com' });
    const csv = await fetch(BASE + '/api/report/weekly?format=csv', { headers: { 'X-PMT-Key': TOKEN } });
    const text = await csv.text();
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`), text.slice(0, 400));
  });

  test('malformed JSON is a clean 400', async () => {
    const r = await fetch(BASE + '/api/tracks', { method: 'POST', headers: { 'X-PMT-Key': TOKEN, 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(r.status, 400);
  });
});
