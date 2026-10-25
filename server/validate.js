// server/validate.js — strict input validation for all API inputs (v2.2.0).

const TRACK_ID_RE = /^trk_[A-Za-z0-9]{12}$/;      // ids we generate
const PIXEL_ID_RE = /^trk_[A-Za-z0-9_-]{8,64}$/;   // ids we accept on /px (bounded)
const TOKEN_MIN_LEN = 36;

// Returns the valid track id, or null.
function trackId(v) {
  return typeof v === 'string' && TRACK_ID_RE.test(v) ? v : null;
}

// Bounded id accepted on the public pixel endpoint. Unknown ids simply match
// no track and are ignored (no existence oracle).
function pixelId(v) {
  return typeof v === 'string' && PIXEL_ID_RE.test(v) ? v : null;
}

// String capped to maxLen; non-strings become ''.
function str(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}

// 0/1 flag from common encodings; undefined when absent/invalid.
function flag01(v) {
  if (v === 1 || v === '1' || v === true) return 1;
  if (v === 0 || v === '0' || v === false) return 0;
  return undefined;
}

// Bounded integer with default.
function int(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// ISO-8601 datetime string, or null.
function isoDateTime(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// IANA timezone name, allow-listed shape (letters, _, /, -, +). Falls back null.
function timezone(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, 64);
  if (!/^[A-Za-z_][A-Za-z0-9_\-+\/]*$/.test(t)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return t;
  } catch (e) {
    return null;
  }
}

module.exports = { trackId, pixelId, str, flag01, int, isoDateTime, timezone, TOKEN_MIN_LEN };
