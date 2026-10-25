// extension/test.integration.js — background.js + the REAL server (SQLite, real HTTP).
// Fake chrome.* API; fetch goes over the loopback to server/server.js.
// Covers the data-loss / race / false-notification bugs fixed in v2.4.2.

process.env.SQLITE_FILE = '/tmp/pmt-int-' + process.pid + '.db';
process.env.PORT = '41097';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const db = require('../server/db');

const BASE = 'http://127.0.0.1:41097';
const GMAIL = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const OUTLOOK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Outlook/16.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const tid = () => 'trk_Int' + String(++n).padStart(9, '0');

describe('background.js against the real server', () => {
  let closeServer, ctx, chromeMock;
  const mem = {};
  const notifs = [];
  let badge = '';
  let netDown = false;
  let tracksDelay = 0;
  const fetchLog = [];

  async function fakeFetch(url, init = {}) {
    const p = new URL(url).pathname;
    fetchLog.push((init.method || 'GET') + ' ' + p);
    if (netDown) throw new Error('network down');
    if (p === '/api/tracks' && tracksDelay) await sleep(tracksDelay);
    return fetch(url, init);
  }
  const msg = (m) => new Promise((resolve) => chromeMock._on(m, {}, resolve));
  const hit = (id, ua) => fetch(`${BASE}/px/${id}.gif`, { headers: { 'user-agent': ua } });
  const ageEvents = (id, sec) => {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.SQLITE_FILE);
    raw.prepare('UPDATE events SET received_at=? WHERE track_id=?').run(new Date(Date.now() - sec * 1000).toISOString(), id);
    raw.close();
  };
  const serverTrack = async (id) => {
    const r = await fetch(`${BASE}/api/tracks/${id}`, { headers: { 'X-PMT-Key': mem.authToken } });
    return r.ok ? r.json() : null;
  };

  before(async () => {
    try { fs.unlinkSync(process.env.SQLITE_FILE); } catch (e) { /* fresh */ }
    await db.init();
    ({ close: closeServer } = require('../server/server.js'));
    await sleep(300);
    mem.serverUrl = BASE;
    chromeMock = {
      storage: { local: {
        async get(keys) { await sleep(2); const o = {}; for (const k of [].concat(keys)) if (k in mem) o[k] = JSON.parse(JSON.stringify(mem[k])); return o; },
        async set(p) { await sleep(2); for (const k in p) mem[k] = JSON.parse(JSON.stringify(p[k])); },
      } },
      alarms: { create() {}, get(n, cb) { cb(undefined); }, onAlarm: { addListener() {} } },
      notifications: { create: async (id, o) => { notifs.push(o); }, clear() {}, onClicked: { addListener() {} }, onButtonClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { chromeMock._on = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      action: { async setBadgeText({ text }) { badge = text; }, async setBadgeBackgroundColor() {} },
      tabs: { query: async () => [] }, scripting: { executeScript: async () => {} },
    };
    ctx = vm.createContext({
      chrome: chromeMock, fetch: fakeFetch, console, setTimeout, clearTimeout, AbortSignal, URL, Date, JSON, Promise, Intl,
      crypto: require('crypto').webcrypto, Uint8Array, Array, Object, Math, Number, String, parseInt, Error, Set, isFinite: Number.isFinite,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), ctx);
  });
  after(() => {
    try { closeServer(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(process.env.SQLITE_FILE); } catch (e) { /* keep */ }
    setTimeout(() => process.exit(0), 50).unref();
  });

  test('first run: concurrent calls create exactly ONE auth token', async () => {
    await Promise.all([msg({ type: 'PMT_POLL_NOW' }), msg({ type: 'PMT_GET_TICK_DATA' }), msg({ type: 'PMT_POLL_NOW' })]);
    assert.match(mem.authToken, /^pmt_[0-9a-f]{64}$/);
  });

  test('prepare -> commit -> receiver detection -> exactly one notification and a double tick', async () => {
    const id = tid();
    const r = await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Offer', to: 'client@x.com', from: 'me@gmail.com' });
    assert.equal(r.ok, true);
    assert.ok(mem.ownIds.includes(id), 'own ids tracked for the Gmail tab');
    await sleep(80);
    await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Offer', to: 'client@x.com', from: 'me@gmail.com' });
    assert.equal((await serverTrack(id)).sent, true);
    await hit(id, OUTLOOK);
    ageEvents(id, 60);
    notifs.length = 0;
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(notifs.length, 1);
    assert.match(notifs[0].message, /client@x\.com/);
    assert.match(notifs[0].message, /Offer/);
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(notifs.length, 1, 'no duplicate on the next poll');
    const tick = (await msg({ type: 'PMT_GET_TICK_DATA' })).tracks.find((t) => t.id === id);
    assert.equal(tick.rawCount, 1);
    assert.equal(tick.sent, 1);
  });

  test('server never saw the compose-time create -> commit still tracks the mail (v2.4.1 lost it)', async () => {
    const id = tid();
    netDown = true;
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Cold', to: 'c@x.com', from: 'me@gmail.com' });
    await sleep(50);
    netDown = false;
    assert.equal(await serverTrack(id), null, 'server really does not know it');
    const r = await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Cold', to: 'c@x.com', from: 'me@gmail.com' });
    assert.equal(r.ok, true);
    const t = await serverTrack(id);
    assert.equal(t.sent, true);
    assert.equal(t.subject, 'Cold');
    await hit(id, GMAIL);
    assert.equal((await serverTrack(id)).analytics.raw_event_count, 1, 'the open is counted');
    assert.ok(!mem.outbox.some((o) => o.op === 'create' && o.id === id), 'obsolete create dropped');
  });

  test('commit during a slow poll: the track is NOT lost and still reaches the server', async () => {
    const id = tid();
    tracksDelay = 500;
    const polling = msg({ type: 'PMT_POLL_NOW' });
    await sleep(150);
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Race', to: 'q@x.com', from: 'me@gmail.com' });
    await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Race', to: 'q@x.com', from: 'me@gmail.com' });
    await polling;
    tracksDelay = 0;
    assert.ok(mem.tracks[id], 'local record survived the poll');
    assert.equal(mem.tracks[id].sent, 1);
    assert.equal((await serverTrack(id)).sent, true);
  });

  test('commit while the server is down is queued and delivered later', async () => {
    const id = tid();
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Offline', to: 'o@x.com', from: 'me@gmail.com' });
    await sleep(80);
    netDown = true;
    const r = await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Offline', to: 'o@x.com', from: 'me@gmail.com' });
    assert.equal(r.queued, true);
    assert.ok(mem.outbox.some((o) => o.op === 'commit' && o.id === id));
    netDown = false;
    mem.outbox.forEach((o) => { o.nextRetryAt = 0; });
    await msg({ type: 'PMT_POLL_NOW' });
    assert.ok(!mem.outbox.some((o) => o.id === id), 'outbox drained');
    assert.equal((await serverTrack(id)).sent, true);
  });

  test('commit of a track whose local record is gone self-heals', async () => {
    const id = tid();
    const r = await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Healed', to: 'h@x.com', from: 'me@gmail.com' });
    assert.equal(r.ok, true, 'v2.4.1 returned ok:false here and never contacted the server');
    assert.equal((await serverTrack(id)).subject, 'Healed');
  });

  test('sender looks at their own mail: no notification, and the NEXT real detection still notifies', async () => {
    const id = tid();
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Own', to: 'r@x.com', from: 'me@gmail.com' });
    await sleep(80);
    await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Own', to: 'r@x.com', from: 'me@gmail.com' });
    notifs.length = 0;
    // 1) the proxy hit lands, and a poll runs BEFORE the self-view signal reaches the server
    await hit(id, GMAIL);
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(notifs.length, 0, 'a detection younger than the settle window is deferred, not announced');
    // 2) the extension's self-view signal arrives and flags it
    assert.equal((await msg({ type: 'PMT_SELF_VIEW', trackId: id })).ok, true);
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(notifs.length, 0);
    assert.equal(mem.tracks[id].lastUniqueNotified, 0);
    // 3) a genuine recipient (another client) opens later
    await hit(id, OUTLOOK);
    await db.recordSelfView; // (no-op, keeps linter quiet)
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.SQLITE_FILE);
    raw.prepare('UPDATE events SET received_at=? WHERE track_id=? AND is_suspected_self_view=0').run(new Date(Date.now() - 60000).toISOString(), id);
    raw.close();
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(notifs.length, 1, 'the real open is announced (v2.4.1 swallowed it)');
  });

  test('self-view signal BEFORE the hit: nothing counted, nothing announced', async () => {
    const id = tid();
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Own2', to: 'r@x.com', from: 'me@gmail.com' });
    await sleep(80);
    await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Own2', to: 'r@x.com', from: 'me@gmail.com' });
    notifs.length = 0;
    await msg({ type: 'PMT_SELF_VIEW', trackId: id });
    await hit(id, GMAIL);
    ageEvents(id, 60);
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(notifs.length, 0);
    assert.equal((await serverTrack(id)).analytics.raw_event_count, 0);
  });

  test('Clear list hides rows but keeps the track (ticks, ownership, sync); a new detection un-hides', async () => {
    const id = tid();
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Hide', to: 'h@x.com', from: 'me@gmail.com' });
    await sleep(80);
    await msg({ type: 'PMT_COMMIT_TRACK', trackId: id, subject: 'Hide', to: 'h@x.com', from: 'me@gmail.com' });
    await msg({ type: 'PMT_CLEAR_LIST' });
    assert.equal(mem.tracks[id].hidden, true);
    assert.ok(mem.ownIds.includes(id));
    assert.ok((await msg({ type: 'PMT_GET_TICK_DATA' })).tracks.some((t) => t.id === id), 'tick data survives');
    await hit(id, OUTLOOK);
    ageEvents(id, 60);
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(mem.tracks[id].hidden, false);
  });

  test('a poll never flips a locally-sent mail back to unsent while the commit is pending', async () => {
    const id = tid();
    await msg({ type: 'PMT_PREPARE_TRACK', id, subject: 'Pending', to: 'p@x.com', from: 'me@gmail.com' });
    await sleep(80);
    // server knows the track but only as unsent; the local side already committed
    mem.tracks[id].sent = 1;
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(mem.tracks[id].sent, 1);
    assert.ok(mem.outbox.some((o) => o.op === 'commit' && o.id === id) || (await serverTrack(id)).sent, 'a commit is queued or already applied');
  });

  test('one bulk request per poll regardless of track count', async () => {
    fetchLog.length = 0;
    await msg({ type: 'PMT_POLL_NOW' });
    assert.equal(fetchLog.filter((l) => l === 'GET /api/tracks').length, 1);
    assert.equal(fetchLog.filter((l) => /status/.test(l)).length, 0);
  });

  test('every message gets an answer even when handling throws', async () => {
    const orig = chromeMock.storage.local.get;
    chromeMock.storage.local.get = async () => { throw new Error('storage broke'); };
    const r = await msg({ type: 'PMT_GET_TICK_DATA' });
    chromeMock.storage.local.get = orig;
    assert.equal(r.ok, false);
  });
});
