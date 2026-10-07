// server/classify.js — detection-event classification (v2.2.0).
//
// A tracking-pixel HTTP request is NOT proof that a human read the email.
// This module only classifies *how* the request appears to have arrived:
//
//   GMAIL_PROXY — User-Agent carries Gmail image-proxy signals
//                 (GoogleImageProxy, ggpht.com). Gmail fetches and caches
//                 images itself, so this proves image loading, not reading.
//   OTHER_PROXY — UA mentions a proxy but is not Gmail's.
//   DIRECT      — looks like an ordinary mail/browser client fetch.
//   UNKNOWN     — no usable User-Agent at all.
//
// UI layers must render these as "Detected via Gmail" / "Detected" etc.,
// never as "Read".

const GMAIL_PROXY_RE = /GoogleImageProxy|ggpht\.com/i;
const PROXY_WORD_RE = /proxy/i;

const EVENT_TYPES = ['UNKNOWN', 'GMAIL_PROXY', 'DIRECT', 'OTHER_PROXY'];

function classifyEvent(userAgent) {
  const ua = String(userAgent || '');
  if (GMAIL_PROXY_RE.test(ua)) return 'GMAIL_PROXY';
  if (PROXY_WORD_RE.test(ua)) return 'OTHER_PROXY';
  if (ua.trim().length === 0) return 'UNKNOWN';
  return 'DIRECT';
}

// Honest device label. A proxy hides the real client, so proxy events are
// never attributed to a specific device.
function deviceFromUA(userAgent, eventType) {
  const ua = String(userAgent || '');
  if (eventType === 'GMAIL_PROXY' || eventType === 'OTHER_PROXY') return 'Proxy';
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) return 'Mobile';
  if (/tablet|ipad/i.test(ua)) return 'Tablet';
  return eventType === 'UNKNOWN' && !ua ? 'Unknown' : 'Desktop';
}

// Deterministic, version-stripped UA fingerprint used only inside dedupe keys.
// Version numbers are stripped so "Chrome/120.0" and "Chrome/121.0" from the
// same client still dedupe together.
function normalizeUA(ua) {
  return String(ua || '')
    .toLowerCase()
    .replace(/\d+(\.\d+)+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

module.exports = { classifyEvent, deviceFromUA, normalizeUA, EVENT_TYPES };
