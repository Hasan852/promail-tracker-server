// server/test.js — automated tests for ProMail Tracker v2.2.0.
// Run: npm test   (node --test server/test.js extension/test.js)
// Uses a temp SQLite file; Postgres paths are skipped without DATABASE_URL.

process.env.SQLITE_FILE = '/tmp/pmt-test-' + process.pid + '.db';
process.env.PORT = '41099';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { classifyEvent, deviceFromUA } = require('./classify');
const { dedupeKey, normalizedClient, bucketStartMs, BUCKET_SECONDS } = require('./dedupe');
const v = require('./validate');
const db = require('./db');

const BASE = 'http://127.0.0.1:41099';
const TOKEN_A = 'pmt_' + 'a'.repeat(64);
const TOKEN_B = 'pmt_' + 'b'.repeat(64);
const GMAIL_UA = 'Mozilla/5.0 (compatible; GoogleImageProxy)';
const DIRECT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function authed(token, opts = {}) {
  return { ...(opts.headers || {}), 'X-PMT-Key': token, 'Content-Type': 'application/json', ...(opts.headers || {}) };
}
async function api(method, path, token, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-PMT-Key': token || '', 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON (pixel, csv) */ }
  return { status: res.status, json, res };
}
function newTid() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'trk_';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * 62)];
  return s;
}

describe('classification', () => {
  test('gmail proxy signals', () => {
    assert.equal(classifyEvent('Mozilla/5.0 GoogleImageProxy'), 'GMAIL_PROXY');
    assert.equal(classifyEvent('xxx ggpht.com yyy'), 'GMAIL_PROXY');
  });
  test('other proxy', () => {
    assert.equal(classifyEvent('SomeMail Image Proxy/1.0'), 'OTHER_PROXY');
  });
  test('direct client', () => {
    assert.equal(classifyEvent(DIRECT_UA), 'DIRECT');
  });
  test('unknown when empty', () => {
    assert.equal(classifyEvent(''), 'UNKNOWN');
    assert.equal(classifyEvent(null), 'UNKNOWN');
  });
  test('proxy hides device', () => {
    assert.equal(deviceFromUA('iPhone ' + GMAIL_UA, 'GMAIL_PROXY'), 'Proxy');
    assert.equal(deviceFromUA('iPhone OS 17', 'DIRECT'), 'Mobile');
  });
});

describe('dedupe', () => {
  test('deterministic key', () => {
    const k1 = dedupeKey('trk_abc', 'GMAIL_PROXY', GMAIL_UA, '1.2.3.4', 1700000000000);
    const k2 = dedupeKey('trk_abc', 'GMAIL_PROXY', GMAIL_UA, '9.9.9.9', 1700000000000);
    assert.equal(k1, k2, 'proxy key ignores ip');
  });
  test('bucket boundary splits keys', () => {
    const s = BUCKET_SECONDS.DIRECT * 1000;
    const edge = Math.ceil(1700000000000 / s) * s;
    const a = dedupeKey('trk_x', 'DIRECT', DIRECT_UA, '1.2.3.4', edge - 1);
    const b = dedupeKey('trk_x', 'DIRECT', DIRECT_UA, '1.2.3.4', edge + 1);
    assert.notEqual(a, b);
  });
  test('different clients differ', () => {
    const a = normalizedClient('DIRECT', DIRECT_UA, '1.2.3.4');
    const b = normalizedClient('DIRECT', DIRECT_UA, '5.6.7.8');
    assert.notEqual(a, b);
  });
  test('bucketStartMs aligns', () => {
    assert.equal(bucketStartMs(1700000000001, 'GMAIL_PROXY') % 86400000, 0);
  });
});

describe('validate', () => {
  test('trackId', () => {
    assert.ok(v.trackId('trk_AbC123xYz456'));
    assert.equal(v.trackId('trk_short'), null);
    assert.equal(v.trackId('http://evil'), null);
  });
  test('pixelId bounded', () => {
    assert.ok(v.pixelId('trk_AbC123xYz456'));
    assert.equal(v.pixelId('trk_' + 'x'.repeat(100)), null);
  });
  test('str/flag01/int/isoDateTime/timezone', () => {
    assert.equal(v.str('hello world', 5), 'hello');
    assert.equal(v.str(42, 5), '');
    assert.equal(v.flag01('1'), 1);
    assert.equal(v.flag01('0'), 0);
    assert.equal(v.flag01('x'), undefined);
    assert.equal(v.int('abc', 7, 1, 10), 7);
    assert.equal(v.int('500', 7, 1, 10), 10);
    assert.ok(v.isoDateTime('2026-10-07T00:00:00.000Z'));
    assert.equal(v.isoDateTime('not a date'), null);
    assert.equal(v.timezone('Asia/Dhaka'), 'Asia/Dhaka');
    assert.equal(v.timezone('../../etc'), null);
  });
});

describe('database + API', () => {
  let closeServer;
  before(async () => {
    try { fs.unlinkSync(process.env.SQLITE_FILE); } catch (e) { /* fresh */ }
    await db.init();
    ({ close: closeServer } = require('./server.js')); // starts listening on PORT
    await new Promise((r) => setTimeout(r, 300));
  });
  after(() => {
    try { closeServer(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(process.env.SQLITE_FILE); } catch (e) { /* keep */ }
  });

  test('health', async () => {
    const r = await fetch(BASE + '/health');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.version, '2.3.0');
  });

  test('auth: missing/invalid token -> 401', async () => {
    const r1 = await api('GET', '/api/tracks', '');
    assert.equal(r1.status, 401);
    const r2 = await api('GET', '/api/tracks', 'short');
    assert.equal(r2.status, 401);
  });

  test('create + commit are idempotent; owner mismatch rejected', async () => {
    const id = newTid();
    const c1 = await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'Hello', to: 'r@x.com', from: 's@x.com' });
    assert.equal(c1.status, 200);
    assert.equal(c1.json.trackId, id);
    const c2 = await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'Hello', to: 'r@x.com', from: 's@x.com' });
    assert.equal(c2.status, 200);
    assert.equal(c2.json.deduped, true);
    // another owner can never touch this id
    const c3 = await api('POST', '/api/tracks', TOKEN_B, { id, subject: 'Hijack' });
    assert.equal(c3.status, 409);
    const k1 = await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'Hello final', to: 'r@x.com', from: 's@x.com' });
    assert.equal(k1.status, 200);
    const k2 = await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'Hello final', to: 'r@x.com', from: 's@x.com' });
    assert.equal(k2.status, 200);
    assert.equal(k2.json.alreadyCommitted, true);
    const kb = await api('POST', `/api/tracks/${id}/commit`, TOKEN_B, {});
    assert.equal(kb.status, 409);
    const all = await api('GET', '/api/tracks?all=1', TOKEN_A);
    assert.equal(all.json.tracks.filter((t) => t.id === id).length, 1, 'exactly one track');
  });

  test('owner isolation: B cannot read A track or A data in reports', async () => {
    const id = newTid();
    await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'Secret', to: 'vip@x.com' });
    await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'Secret', to: 'vip@x.com' });
    const r = await api('GET', `/api/tracks/${id}`, TOKEN_B);
    assert.equal(r.status, 404);
    const rep = await api('GET', '/api/report/weekly?format=json', TOKEN_B);
    assert.ok(!rep.json.rows.some((x) => x.track_id === id), 'B report has no A rows');
  });

  test('pixel: public, classified, deduped; unsent ignored', async () => {
    const id = newTid();
    await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'Pix', to: 'p@x.com' });
    // unsent: pixel ignored for analytics
    await fetch(BASE + `/px/${id}.gif`, { headers: { 'user-agent': GMAIL_UA } });
    let t = await api('GET', `/api/tracks/${id}`, TOKEN_A);
    assert.equal(t.json.analytics.raw_event_count, 0);
    await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'Pix', to: 'p@x.com' });
    // two proxy hits in same bucket -> raw 2, unique 1
    const px = { headers: { 'user-agent': GMAIL_UA } };
    const p1 = await fetch(BASE + `/px/${id}.gif`, px);
    assert.equal(p1.status, 200);
    assert.equal(p1.headers.get('content-type'), 'image/gif');
    await fetch(BASE + `/px/${id}.gif`, px);
    t = await api('GET', `/api/tracks/${id}`, TOKEN_A);
    const a = t.json.analytics;
    assert.equal(a.raw_event_count, 2);
    assert.equal(a.estimated_unique_events, 1, 'duplicate proxy hits dedupe');
    assert.equal(a.proxy_event_count, 2);
    // direct hit with different client -> unique 2
    await fetch(BASE + `/px/${id}.gif`, { headers: { 'user-agent': DIRECT_UA } });
    t = await api('GET', `/api/tracks/${id}`, TOKEN_A);
    assert.equal(t.json.analytics.estimated_unique_events, 2);
    assert.equal(t.json.analytics.direct_event_count, 1);
    assert.ok(t.json.analytics.first_detected_at);
    assert.ok(t.json.analytics.last_detected_at);
    // unknown id: pixel still served, nothing stored, no leak
    const pu = await fetch(BASE + '/px/trk_nope12345678.gif');
    assert.equal(pu.status, 200);
  });

  test('self-view flags, never deletes', async () => {
    const id = newTid();
    await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'SV', to: 'sv@x.com' });
    await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'SV', to: 'sv@x.com' });
    await fetch(BASE + `/px/${id}.gif`, { headers: { 'user-agent': GMAIL_UA } });
    const sv = await api('POST', `/api/tracks/${id}/self-view`, TOKEN_A, {});
    assert.equal(sv.status, 200);
    assert.equal(sv.json.ok, true);
    const t = await api('GET', `/api/tracks/${id}?diagnostics=1`, TOKEN_A);
    const evs = t.json.events;
    assert.equal(evs.length, 1, 'raw event retained, not deleted');
    assert.equal(evs[0].is_suspected_self_view, true);
    assert.equal(t.json.analytics.raw_event_count, 0, 'flagged event excluded from analytics');
    assert.ok(!('ip' in (await api('GET', `/api/tracks/${id}`, TOKEN_A)).json.events[0]), 'no ip in normal view');
  });

  test('privacy mode skips IP storage', async () => {
    const id = newTid();
    await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'PM', to: 'pm@x.com' });
    await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'PM', to: 'pm@x.com' });
    await api('POST', '/api/account/preferences', TOKEN_A, { privacy_mode: 1 });
    await fetch(BASE + `/px/${id}.gif`, { headers: { 'user-agent': DIRECT_UA, 'x-forwarded-for': '9.9.9.9' } });
    const t = await api('GET', `/api/tracks/${id}?diagnostics=1`, TOKEN_A);
    assert.equal(t.json.events[t.json.events.length - 1].ip, '');
    await api('POST', '/api/account/preferences', TOKEN_A, { privacy_mode: 0 });
  });

  test('batch sync via updatedSince', async () => {
    const beforeSync = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const id = newTid();
    await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'Sync', to: 's@x.com' });
    await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'Sync', to: 's@x.com' });
    const r = await api('GET', `/api/tracks?all=1&updatedSince=${encodeURIComponent(beforeSync)}`, TOKEN_A);
    assert.equal(r.status, 200);
    assert.ok(r.json.tracks.some((t) => t.id === id), 'changed track included');
    assert.ok(r.json.tracks[0].analytics, 'analytics included');
    const bad = await api('GET', '/api/tracks?updatedSince=nope', TOKEN_A);
    assert.equal(bad.status, 400);
  });

  test('security: SQLi, oversize, malformed id, malformed JSON', async () => {
    const evil = `x'; DROP TABLE tracks;--`;
    const id = newTid();
    const c = await api('POST', '/api/tracks', TOKEN_A, { id, subject: evil, to: 'e@x.com' });
    assert.equal(c.status, 200);
    const t = await api('GET', `/api/tracks/${id}`, TOKEN_A);
    assert.equal(t.json.subject, evil, 'stored literally, not executed');
    const still = await api('GET', '/api/tracks?limit=1', TOKEN_A);
    assert.equal(still.status, 200, 'tracks table intact');
    const big = await api('POST', '/api/tracks', TOKEN_A, { id: newTid(), subject: 's'.repeat(5000) });
    assert.equal(big.status, 200);
    const bt = await api('GET', `/api/tracks/${big.json.trackId}`, TOKEN_A);
    assert.equal(bt.json.subject.length, 300);
    const badId = await api('POST', '/api/tracks', TOKEN_A, { id: 'not-a-track' });
    assert.equal(badId.status, 400);
    const badCommit = await api('POST', '/api/tracks/bad!!/commit', TOKEN_A, {});
    assert.equal(badCommit.status, 400);
    const malformed = await fetch(BASE + '/api/tracks', {
      method: 'POST', headers: { 'X-PMT-Key': TOKEN_A, 'Content-Type': 'application/json' }, body: '{oops',
    });
    assert.ok(malformed.status >= 400 && malformed.status < 600, 'malformed JSON fails safely');
    const missing = await api('GET', '/api/tracks/trk_000000000000', TOKEN_A);
    assert.equal(missing.status, 404);
  });

  test('legacy endpoints still work (marked legacy)', async () => {
    const id = newTid();
    const c = await fetch(BASE + `/api/create-track?id=${id}&subject=Leg&to=l@x.com&deferred=1`, { headers: { 'X-PMT-Key': TOKEN_A } });
    assert.equal(c.status, 200);
    const s = await fetch(BASE + `/api/status/${id}`, { headers: { 'X-PMT-Key': TOKEN_A } });
    assert.equal(s.status, 200);
    const j = await s.json();
    assert.ok(Array.isArray(j.opens), 'legacy opens shape present');
  });

  test('report ranges + CSV', async () => {
    const r = await api('GET', '/api/report/weekly?format=json', TOKEN_A);
    assert.equal(r.status, 200);
    assert.ok(r.json.summary);
    assert.ok(Array.isArray(r.json.daily_trend));
    assert.ok('unique_detection_rate' in r.json.summary);
    const csv = await fetch(BASE + '/api/report/weekly?format=csv', { headers: { 'X-PMT-Key': TOKEN_A } });
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.ok(text.split('\r\n')[0].includes('unique_detection_count'), 'new CSV columns');
    const badRange = await api('GET', '/api/report/weekly?from=2026-10-10&to=2026-10-01', TOKEN_A);
    assert.equal(badRange.status, 400);
  });

  test('migration: legacy opens rows become events (idempotent)', async () => {
    const id = newTid();
    await api('POST', '/api/tracks', TOKEN_A, { id, subject: 'Mig', to: 'm@x.com' });
    await api('POST', `/api/tracks/${id}/commit`, TOKEN_A, { subject: 'Mig', to: 'm@x.com' });
    // simulate a pre-2.2 opens row written directly
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.SQLITE_FILE);
    raw.prepare('INSERT INTO opens (track_id, opened_at, ip, user_agent, device, is_gmail_proxy) VALUES (?,?,?,?,?,?)')
      .run(id, new Date().toISOString(), '1.1.1.1', GMAIL_UA, 'Gmail proxy', 1);
    raw.prepare("DELETE FROM schema_migrations WHERE name='opens_to_events_v1'").run();
    raw.close();
    await db.init(); // restart-safe: migrates exactly once
    await db.init(); // and again: no duplicates
    const t = await api('GET', `/api/tracks/${id}?diagnostics=1`, TOKEN_A);
    const migrated = t.json.events.filter((e) => e.event_type === 'GMAIL_PROXY');
    assert.equal(migrated.length, 1, 'legacy open migrated exactly once');
  });

  describe('google auth', () => {
    const CLIENT_ID = 'test-client.apps.googleusercontent.com';
    const realFetch = global.fetch;
    function stubGoogle({ sub = 'gsub_1', email = 'user@example.com', aud = CLIENT_ID, ok = true } = {}) {
      global.fetch = async (url, opts) => {
        if (String(url).includes('tokeninfo')) {
          return {
            ok, status: ok ? 200 : 400,
            json: async () => ok
              ? { aud, sub, email, expires_in: '3600' }
              : { error: 'invalid_token' },
          };
        }
        return realFetch(url, opts);
      };
    }
    function unstub() { global.fetch = realFetch; }
    before(() => { process.env.GOOGLE_CLIENT_ID = CLIENT_ID; });
    after(() => { unstub(); delete process.env.GOOGLE_CLIENT_ID; });

    const TOKEN_C = 'pmt_' + 'c'.repeat(64);
    const TOKEN_D = 'pmt_' + 'd'.repeat(64);
    const TOKEN_E = 'pmt_' + 'e'.repeat(64);

    test('link: first sign-in attaches the google identity', async () => {
      stubGoogle();
      try {
        const r = await api('POST', '/api/auth/google', TOKEN_C, { google_access_token: 'ya29.valid' });
        assert.equal(r.status, 200);
        assert.equal(r.json.googleLinked, true);
        assert.equal(r.json.email, 'user@example.com');
        const me = await api('GET', '/api/auth/me', TOKEN_C);
        assert.equal(me.json.google.linked, true);
        assert.equal(me.json.google.email, 'user@example.com');
      } finally { unstub(); }
    });

    test('restore: a fresh install token merges into the linked account', async () => {
      const beforeMe = await api('GET', '/api/auth/me', TOKEN_C);
      stubGoogle(); // same google sub as the previous test
      try {
        const r = await api('POST', '/api/auth/google', TOKEN_D, { google_access_token: 'ya29.valid2' });
        assert.equal(r.status, 200);
        assert.equal(r.json.accountId, beforeMe.json.accountId, 'new token now maps to the linked account');
        const me = await api('GET', '/api/auth/me', TOKEN_D);
        assert.equal(me.json.google.linked, true);
        assert.equal(me.json.accountId, beforeMe.json.accountId);
      } finally { unstub(); }
    });

    test('merge: tracks from a pre-login account move into the linked account', async () => {
      const tid = newTid();
      await api('POST', '/api/tracks', TOKEN_E, { id: tid, subject: 'Merge me', to: 'm@x.com' });
      await api('POST', `/api/tracks/${tid}/commit`, TOKEN_E, { subject: 'Merge me', to: 'm@x.com' });
      stubGoogle(); // same google sub -> linked account from earlier tests
      try {
        const r = await api('POST', '/api/auth/google', TOKEN_E, { google_access_token: 'ya29.valid3' });
        assert.equal(r.status, 200);
        assert.ok(r.json.mergedTracks >= 1, 'expected the pre-login track to move');
        const list = await api('GET', '/api/tracks?all=1', TOKEN_E);
        assert.ok(list.json.tracks.map((t) => t.id).includes(tid), 'merged track visible via the same install token');
      } finally { unstub(); }
    });

    test('reject: missing google_access_token -> 400', async () => {
      const r = await api('POST', '/api/auth/google', TOKEN_C, {});
      assert.equal(r.status, 400);
    });

    test('reject: invalid google token -> 401', async () => {
      stubGoogle({ ok: false });
      try {
        const r = await api('POST', '/api/auth/google', TOKEN_C, { google_access_token: 'ya29.badtoken123' });
        assert.equal(r.status, 401);
      } finally { unstub(); }
    });

    test('reject: token issued for another app -> 401', async () => {
      stubGoogle({ aud: 'other.apps.googleusercontent.com' });
      try {
        const r = await api('POST', '/api/auth/google', TOKEN_C, { google_access_token: 'ya29.other' });
        assert.equal(r.status, 401);
      } finally { unstub(); }
    });

    test('reject: server without GOOGLE_CLIENT_ID -> 503', async () => {
      delete process.env.GOOGLE_CLIENT_ID;
      stubGoogle();
      try {
        const r = await api('POST', '/api/auth/google', TOKEN_C, { google_access_token: 'ya29.valid' });
        assert.equal(r.status, 503);
      } finally { unstub(); process.env.GOOGLE_CLIENT_ID = CLIENT_ID; }
    });

    test('privacy page is public', async () => {
      const res = await fetch(BASE + '/privacy');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Privacy Policy'));
      assert.ok(html.includes('never read your Gmail'));
    });
  });
});
