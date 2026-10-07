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
