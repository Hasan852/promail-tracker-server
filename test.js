// extension/test.js — unit tests for background.js pure logic (v2.2.0).
// Run: npm test   (node --test server/test.js extension/test.js)

// Minimal chrome stub so background.js top-level wiring doesn't throw.
global.chrome = {
  storage: { local: { get: async () => ({}), set: async () => ({}) } },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
  },
  alarms: { onAlarm: { addListener() {} }, create() {} },
  notifications: { onClicked: { addListener() {} }, onButtonClicked: { addListener() {} } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { query: async () => [] },
  scripting: { executeScript: async () => {} },
};

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bg = require('./background.js');

describe('background pure logic', () => {
  test('isValidTrackId', () => {
    assert.ok(bg.isValidTrackId('trk_AbC123xYz456'));
    assert.ok(!bg.isValidTrackId('trk_short'));
    assert.ok(!bg.isValidTrackId('http://evil/x'));
    assert.ok(!bg.isValidTrackId(null));
  });

  test('outbox backoff grows and caps', () => {
    const d0 = bg.outboxNextDelayMs(0);
    const d1 = bg.outboxNextDelayMs(1);
    const d2 = bg.outboxNextDelayMs(2);
    assert.equal(d0, 30000);
    assert.equal(d1, 60000);
    assert.equal(d2, 120000);
    assert.equal(bg.outboxNextDelayMs(100), 3600000, 'capped at 1h');
  });

  test('outboxPush bounds size', () => {
    let box = [];
    for (let i = 0; i < 120; i++) box = bg.outboxPush(box, { id: i }, 100);
    assert.equal(box.length, 100);
    assert.equal(box[0].id, 20, 'oldest dropped first');
  });

  test('applyServerTrack: server wins, newUnique computed', () => {
    const t = bg.buildLocalTrack('Old', 'a@x.com', 's@x.com', 'https://srv', false);
    t.lastUniqueNotified = 1;
    const st = {
      id: 'trk_AbC123xYz456', subject: 'New', recipient: 'b@x.com', sender: 's@x.com',
      sent: 1, updated_at: '2026-10-07T00:00:00.000Z',
      analytics: { raw_event_count: 5, estimated_unique_events: 3, proxy_event_count: 5, direct_event_count: 0, first_detected_at: '2026-10-07T01:00:00.000Z', last_detected_at: '2026-10-07T02:00:00.000Z' },
      events: [
        { received_at: '2026-10-07T01:00:00.000Z', device: 'Proxy', event_type: 'GMAIL_PROXY', is_suspected_self_view: false },
      ],
    };
    const { newUnique, curUnique } = bg.applyServerTrack(t, st);
    assert.equal(t.subject, 'New', 'server subject wins');
    assert.equal(newUnique, 2);
    assert.equal(curUnique, 3);
    assert.equal(t.recentEvents.length, 1);
  });

  test('applyServerTrack: unique count drop (self-view flag) never notifies', () => {
    const t = bg.buildLocalTrack('S', 'a@x.com', '', 'https://srv', false);
    t.lastUniqueNotified = 3;
    const { newUnique } = bg.applyServerTrack(t, {
      id: 'trk_AbC123xYz456', sent: 1,
      analytics: { raw_event_count: 0, estimated_unique_events: 0 },
      events: [],
    });
    assert.equal(newUnique, 0);
  });

  test('applyServerTrack: legacy opens shape still merges', () => {
    const t = bg.buildLocalTrack('S', 'a@x.com', '', 'https://srv', false);
    const { newUnique } = bg.applyServerTrack(t, {
      id: 'trk_AbC123xYz456', sent: 1,
      opens: [
        { opened_at: '2026-10-07T01:00:00Z', device: 'Gmail proxy', is_gmail_proxy: true },
        { opened_at: '2026-10-07T02:00:00Z', device: 'Gmail proxy', is_gmail_proxy: true },
      ],
    });
    assert.equal(newUnique, 2);
    assert.equal(t.analytics.proxy_event_count, 2);
  });

  test('migrateLocalTrack preserves baseline', () => {
    const t = {
      subject: 'S', recipient: 'a@x.com', sent: 1,
      opens: [{ opened_at: '2026-10-07T01:00:00Z', device: 'Gmail proxy', is_gmail_proxy: true }],
      lastOpenCount: 1,
    };
    const m = bg.migrateLocalTrack(t);
    assert.equal(m.analytics.raw_event_count, 1);
    assert.equal(m.lastUniqueNotified, 1);
    assert.equal(m.analytics, m.analytics, 'idempotent');
    bg.migrateLocalTrack(m);
    assert.equal(m.analytics.raw_event_count, 1);
  });

  test('eventLabel honesty', () => {
    assert.equal(bg.eventLabel({ event_type: 'GMAIL_PROXY' }), 'Detected via Gmail');
    assert.equal(bg.eventLabel({ event_type: 'DIRECT', device: 'Mobile' }), 'Detected on Mobile');
    assert.ok(!bg.eventLabel({ event_type: 'DIRECT', device: 'Desktop' }).includes('Read'));
  });

  test('recipientOnly hides sender', () => {
    assert.equal(bg.recipientOnly({ recipient: 'a@x.com, s@x.com', sender: 's@x.com' }), 'a@x.com');
  });
});

describe('v2.4.2 pure logic', () => {
  test('outboxUpsert replaces the same (op,id) and stays bounded', () => {
    let o = bg.outboxUpsert([], { op: 'commit', id: 'trk_a', attempts: 3 }, 3);
    o = bg.outboxUpsert(o, { op: 'commit', id: 'trk_a', attempts: 0 }, 3);
    assert.equal(o.length, 1);
    assert.equal(o[0].attempts, 0);
    o = bg.outboxUpsert(o, { op: 'create', id: 'trk_a' }, 3);
    assert.equal(o.length, 2, 'different op is a different item');
    for (let i = 0; i < 5; i++) o = bg.outboxUpsert(o, { op: 'commit', id: 'trk_' + i }, 3);
    assert.equal(o.length, 3);
  });

  test('pushOwnId dedupes, keeps newest, bounded', () => {
    let ids = bg.pushOwnId([], 'a', 3);
    ids = bg.pushOwnId(ids, 'b', 3);
    ids = bg.pushOwnId(ids, 'a', 3);
    assert.deepEqual(ids, ['b', 'a']);
    ids = bg.pushOwnId(ids, 'c', 3); ids = bg.pushOwnId(ids, 'd', 3);
    assert.deepEqual(ids, ['a', 'c', 'd']);
  });

  test('mergeMeta never blanks existing metadata', () => {
    const t = { subject: 'S', recipient: 'a@x.com', sender: 'me@x.com' };
    bg.mergeMeta(t, { subject: '', to: '', from: '' });
    assert.equal(t.subject, 'S'); assert.equal(t.recipient, 'a@x.com'); assert.equal(t.sender, 'me@x.com');
    bg.mergeMeta(t, { subject: 'New', to: 'b@x.com' });
    assert.equal(t.subject, 'New'); assert.equal(t.recipient, 'b@x.com');
  });

  test('isFreshDetection: young detections are deferred, old ones settle', () => {
    const now = Date.parse('2026-10-08T10:00:30Z');
    assert.equal(bg.isFreshDetection('2026-10-08T10:00:25Z', now), true);
    assert.equal(bg.isFreshDetection('2026-10-08T10:00:00Z', now), false);
    assert.equal(bg.isFreshDetection(null, now), false);
  });

  test('pruneLocalTracks: abandoned composes expire, sent mails kept up to the cap', () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    const day = 86400000;
    const tracks = {
      old_draft: { sent: 0, createdAt: new Date(now - 3 * day).toISOString() },
      new_draft: { sent: 0, createdAt: new Date(now - 1000).toISOString() },
      s1: { sent: 1, updatedAt: '2026-10-01T00:00:00Z' },
      s2: { sent: 1, updatedAt: '2026-10-02T00:00:00Z' },
      s3: { sent: 1, updatedAt: '2026-10-03T00:00:00Z' },
    };
    bg.pruneLocalTracks(tracks, 3, now);
    assert.ok(!('old_draft' in tracks));
    assert.ok('new_draft' in tracks, 'a compose still open is kept');
    assert.ok(!('s1' in tracks), 'oldest sent mail dropped once over the cap');
    assert.ok('s2' in tracks && 's3' in tracks);
  });

  test('unique count dropping (self-view flagged) lets the baseline follow the server', () => {
    const t = bg.buildLocalTrack('S', 'a@x.com', '', 'https://srv', false);
    t.sent = 1; t.lastUniqueNotified = 1;
    const r = bg.applyServerTrack(t, { id: 'trk_AbC123xYz456', sent: 1, analytics: { raw_event_count: 0, estimated_unique_events: 0 }, events: [] });
    assert.equal(r.newUnique, 0);
    assert.equal(r.curUnique, 0, 'poll sets baseline = curUnique, so the next real detection notifies');
  });
});
