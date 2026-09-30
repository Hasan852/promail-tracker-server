// server.js — ProMail Tracker backend.
//
// Endpoints:
//   GET  /health                       -> { ok, backend, time }
//   GET  /api/create-track?subject=..  -> { trackId }
//   GET  /track/:id.gif                -> 1x1 transparent pixel (logs the open)
//   GET  /api/status/:id               -> track + full open log
//   GET  /api/tracks?limit=50          -> recent tracks with open counts
//   GET  /report/weekly                -> pretty HTML weekly report (this week, Mon-Sun UTC)
//   GET  /api/report/weekly?format=csv -> CSV download of this week's report
//   GET  /api/report?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json
//
// Run:  npm install && npm start          (PORT env, default 3000)
// Data: Postgres if DATABASE_URL is set, else ./tracker.db (SQLite).
//       Rows are NEVER auto-deleted, so weekly reports keep full history.

const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.set('trust proxy', true); // honor X-Forwarded-For on Render/Railway/etc.
app.use(cors());
app.use(express.json());

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  const ra = req.headers['x-real-ip'];
  if (typeof ra === 'string' && ra.length > 0) return ra.trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function isGmailProxy(ua) {
  return /GoogleImageProxy|ggpht\.com/i.test(ua || '');
}

function deviceFromUA(ua) {
  ua = ua || '';
  if (isGmailProxy(ua)) return 'Gmail proxy';
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) return 'Mobile';
  if (/tablet|ipad/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

app.get('/health', (req, res) => {
  res.json({ ok: true, backend: db.backend(), time: new Date().toISOString() });
});

// Create a tracking ID for one outgoing email.
app.get('/api/create-track', async (req, res) => {
  try {
    const subject = typeof req.query.subject === 'string' ? req.query.subject.slice(0, 300) : '';
    const trackId = await db.createTrack(subject);
    res.json({ trackId });
  } catch (e) {
    console.error('create-track failed:', e.message);
    res.status(500).json({ error: 'could not create track' });
  }
});

// Tracking pixel. Fires when the recipient's client loads images.
// NOTE (spam-safety): clean short URL, direct 200 response, no redirects,
// no cookies, no query strings — a single 1x1 image is spam-neutral.
app.get('/px/:id.gif', async (req, res) => {
  const trackId = req.params.id;
  try {
    const ua = req.headers['user-agent'] || '';
    await db.logOpen(trackId, {
      ip: clientIp(req),
      userAgent: ua.slice(0, 500),
      device: deviceFromUA(ua),
      isGmailProxy: isGmailProxy(ua),
    });
  } catch (e) {
    console.error('logOpen failed:', e.message);
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', PIXEL.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(PIXEL);
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const track = await db.getTrack(req.params.id);
    if (!track) return res.status(404).json({ error: 'Tracking ID not found' });
    res.json(track);
  } catch (e) {
    console.error('status failed:', e.message);
    res.status(500).json({ error: 'lookup failed' });
  }
});

app.get('/api/tracks', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    res.json(await db.listTracks(limit));
  } catch (e) {
    console.error('tracks failed:', e.message);
    res.status(500).json({ error: 'lookup failed' });
  }
});

// ---- Weekly reports ----

function currentWeekRangeUTC() {
  const now = new Date();
  const mondayOffset = (now.getUTCDay() + 6) % 7; // Monday = 0
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset, 0, 0, 0));
  const to = new Date(from.getTime() + 7 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), label: from.toISOString().slice(0, 10) };
}

function parseRange(q) {
  if (q.from && q.to) {
    const from = new Date(q.from + 'T00:00:00Z');
    const to = new Date(q.to + 'T00:00:00Z');
    if (isNaN(from) || isNaN(to) || to <= from) return null;
    return { from: from.toISOString(), to: to.toISOString(), label: `${q.from}_to_${q.to}` };
  }
  return currentWeekRangeUTC();
}

function toCSV(rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['track_id', 'subject', 'sent_at_utc', 'opens', 'first_open_utc', 'last_open_utc', 'gmail_proxy_opens'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.track_id, r.subject, r.sent_at, r.opens, r.first_open, r.last_open, r.proxy_opens].map(esc).join(','));
  }
  return lines.join('\r\n');
}

function reportHTML(rows, label) {
  const totalOpens = rows.reduce((a, r) => a + r.opens, 0);
  const opened = rows.filter((r) => r.opens > 0).length;
  const trs = rows
    .map(
      (r) => `<tr><td>${escapeHtml(r.subject) || '<i>(no subject)</i>'}</td>
<td class="c">${r.opens}</td><td class="c">${r.proxy_opens}</td>
<td>${escapeHtml(fmt(r.sent_at))}</td><td>${escapeHtml(fmt(r.first_open))}</td><td>${escapeHtml(fmt(r.last_open))}</td></tr>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ProMail Tracker — Weekly Report (${escapeHtml(label)})</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:22px}.stats{display:flex;gap:16px;margin:16px 0}.stat{background:#f4f6f8;border-radius:10px;padding:12px 18px}
.stat b{font-size:22px;display:block}.c{text-align:center}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border:1px solid #ddd;padding:8px 10px;text-align:left}th{background:#f4f6f8}
a.btn{display:inline-block;margin-top:16px;padding:10px 16px;background:#0b7a55;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body>
<h1>📧 Weekly Email Report <small>(${escapeHtml(label)})</small></h1>
<div class="stats"><div class="stat"><b>${rows.length}</b>emails tracked</div>
<div class="stat"><b>${opened}</b>opened</div><div class="stat"><b>${totalOpens}</b>total opens</div></div>
<table><tr><th>Subject</th><th>Opens</th><th>Proxy</th><th>Sent (UTC)</th><th>First open</th><th>Last open</th></tr>${trs || '<tr><td colspan="6">No tracked emails this week.</td></tr>'}</table>
<a class="btn" href="/api/report/weekly?format=csv">⬇ Download CSV</a>
<p style="color:#777;font-size:12px">“Proxy” = opens via Gmail's image proxy (Gmail pre-loads images, so treat the first proxy open cautiously). Data is kept permanently on the server.</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 19);
}

app.get('/report/weekly', async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (!range) return res.status(400).send('Bad date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD');
    const rows = await db.reportSummary(range.from, range.to);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(reportHTML(rows, range.label));
  } catch (e) {
    console.error('weekly html failed:', e.message);
    res.status(500).send('report failed');
  }
});

app.get(['/api/report/weekly', '/api/report'], async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (!range) return res.status(400).json({ error: 'Bad date range. Use from=YYYY-MM-DD&to=YYYY-MM-DD' });
    const rows = await db.reportSummary(range.from, range.to);
    const format = (req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="promail-weekly-${range.label}.csv"`);
      return res.send('\uFEFF' + toCSV(rows));
    }
    res.json({ week: range.label, from: range.from, to: range.to, total: rows.length, rows });
  } catch (e) {
    console.error('report api failed:', e.message);
    res.status(500).json({ error: 'report failed' });
  }
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`ProMail Tracker server running on port ${PORT} (backend: ${db.backend()})`));
  })
  .catch((e) => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  });
