// server/dedupe.js — deterministic detection-event deduplication (v2.2.0).
//
// Model:
//   RAW EVENT      = every stored /px request (append-only, never deleted).
//   UNIQUE EVENT   = DISTINCT(dedupe_key) — the "estimated unique detections"
//                    shown in the UI and used for notifications.
//
// dedupe_key = sha256(track_id | event_type | normalized_client | bucket_start)
//
// Time buckets are deliberately conservative so genuinely separate views on
// different days are never merged:
//   GMAIL_PROXY / OTHER_PROXY → 24h bucket (proxy fetches are bursty and
//                                carry no per-recipient client identity)
//   DIRECT                    → 6h bucket, keyed on UA fingerprint + IP prefix
//   UNKNOWN                   → 1h bucket
//
// This is intentionally NOT aggressive: it may slightly over-count unique
// detections rather than risk merging real ones.

const crypto = require('crypto');
const { normalizeUA } = require('./classify');

const BUCKET_SECONDS = {
  GMAIL_PROXY: 24 * 3600,
  OTHER_PROXY: 24 * 3600,
  DIRECT: 6 * 3600,
  UNKNOWN: 1 * 3600,
};

function bucketStartMs(receivedAtMs, eventType) {
  const s = BUCKET_SECONDS[eventType] || 3600;
  return Math.floor(receivedAtMs / 1000 / s) * s * 1000;
}

// Coarse network identity: IPv4 /24, IPv6 /48, IPv4-mapped IPv6 handled.
// Only a prefix is ever hashed into the key — never the full address.
function ipPrefix(ip) {
  const v = String(ip || '').trim();
  if (!v) return '';
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = mapped ? mapped[1] : v;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.split('.').slice(0, 3).join('.');
  if (v.includes(':')) return v.split(':').slice(0, 3).join(':');
  return '';
}

function normalizedClient(eventType, userAgent, ip) {
  if (eventType === 'GMAIL_PROXY' || eventType === 'OTHER_PROXY') return 'proxy';
  const fp = crypto
    .createHash('sha1')
    .update(normalizeUA(userAgent) + '|' + ipPrefix(ip))
    .digest('hex')
    .slice(0, 16);
  return String(eventType).toLowerCase() + ':' + fp;
}

function dedupeKey(trackId, eventType, userAgent, ip, receivedAtMs) {
  const bucket = bucketStartMs(receivedAtMs, eventType);
  const client = normalizedClient(eventType, userAgent, ip);
  return crypto
    .createHash('sha256')
    .update([trackId, eventType, client, String(bucket)].join('|'))
    .digest('hex');
}

module.exports = { bucketStartMs, ipPrefix, normalizedClient, dedupeKey, BUCKET_SECONDS };
