// server/logger.js — minimal structured logging (v2.2.0). JSON lines to stdout.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function log(level, msg, fields) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const line = { ts: new Date().toISOString(), level, msg };
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) line[k] = v;
    }
  }
  try {
    console.log(JSON.stringify(line));
  } catch (e) {
    console.log(String(msg));
  }
}

module.exports = {
  debug: (m, f) => log('debug', m, f),
  info: (m, f) => log('info', m, f),
  warn: (m, f) => log('warn', m, f),
  error: (m, f) => log('error', m, f),
};
