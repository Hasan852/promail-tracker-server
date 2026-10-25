// report.js — weekly/monthly analytics report (v2.2.0).
//
// Uses the new /api/report/:kind JSON API (summary + daily trend + rows).
// Dates are computed in the user's preferred timezone and passed as explicit
// from/to bounds; display and CSV use the same timezone. Timestamps are
// stored in UTC server-side and never mixed with local time.

(async () => {
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') === 'monthly' ? 'monthly' : 'weekly';
  document.getElementById('kind').textContent = kind[0].toUpperCase() + kind.slice(1);

  const d = await chrome.storage.local.get(['serverUrl', 'authToken', 'timezone']);
  const url = (d.serverUrl || PMT_DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const tz = d.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!url || !d.authToken) {
    document.getElementById('body').innerHTML = '<div class="error">Server/account is not configured.</div>';
    return;
  }

  // Period bounds in the user's timezone -> explicit UTC ISO for the server.
  function periodBounds() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
    const todayYMD = `${parts.year}-${parts.month}-${parts.day}`;
    if (kind === 'monthly') {
      const from = `${parts.year}-${parts.month}-01T00:00:00`;
      const toDate = new Date(Date.UTC(+parts.year, +parts.month, 1));
      const to = toDate.toISOString().slice(0, 10) + 'T00:00:00';
      return { from: zonedToISO(from), to: zonedToISO(to), label: `${parts.year}-${parts.month}` };
    }
    // Week starting Monday, in tz.
    const dow = (new Date(todayYMD + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const monday = new Date(Date.parse(todayYMD + 'T12:00:00Z') - dow * 86400000);
    const monYMD = monday.toISOString().slice(0, 10);
    const sun = new Date(monday.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    return { from: zonedToISO(monYMD + 'T00:00:00'), to: zonedToISO(sun + 'T00:00:00'), label: monYMD };
  }

  // Interpret a "YYYY-MM-DDTHH:mm:ss" wall time in tz as an ISO UTC string.
  // (Two-pass offset resolution; good enough for reporting boundaries.)
  function zonedToISO(wall) {
    const guess = new Date(wall + 'Z').getTime();
    const off1 = tzOffsetMs(tz, guess);
    const off2 = tzOffsetMs(tz, guess - off1);
    return new Date(guess - off2).toISOString();
  }
  function tzOffsetMs(zone, ts) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const p = dtf.formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUTC - ts;
  }

  function fmtT(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  // Timezone-aware ISO with numeric offset (for CSV).
  function fmtISOtz(iso) {
    if (!iso) return '';
    try {
      const dt = new Date(iso);
      // off = local wall clock minus UTC (east of UTC is positive). The old code had
      // both the sign and the shift inverted, so CSV times showed the mirrored zone
      // (Dhaka 16:00 came out as 04:00-06:00).
      const off = tzOffsetMs(tz, dt.getTime());
      const sign = off >= 0 ? '+' : '-';
      const abs = Math.abs(off);
      const hh = String(Math.floor(abs / 3600000)).padStart(2, '0');
      const mm = String(Math.floor((abs % 3600000) / 60000)).padStart(2, '0');
      return new Date(dt.getTime() + off).toISOString().replace('Z', sign + hh + ':' + mm);
    } catch (e) { return iso; }
  }
  function fmtDur(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
    return (sec / 86400).toFixed(1) + 'd';
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function recipientOnly(track) {
    // v2.4.0: server-computed primary recipient (automated addresses filtered).
    if (track.primary_recipient) return track.primary_recipient;
    const sender = String(track.sender || '').trim().toLowerCase();
    return String(track.recipient || '').split(/[;,]/).map(x => x.trim())
      .filter(x => x && (!sender || x.toLowerCase() !== sender)).join(', ') || '(unknown recipient)';
  }
  function statusOf(r) {
    if (!r.raw_events) return 'Sent — no detection';
    return r.proxy_events === r.raw_events ? 'Detected via Gmail' : 'Detected';
  }
  function evLabel(e) {
    if (!e) return 'Detected';
    if (e.event_type === 'GMAIL_PROXY') return 'Detected via Gmail';
    if (e.event_type === 'OTHER_PROXY') return 'Detected via proxy';
    return 'Detected';
  }
  // v2.4.0: follow-up chains — group rows under their root ancestor
  // (cycle-safe). Chains ordered by root sent time; members oldest-first.
  function chainGroups(rows) {
    const byId = {};
    for (const r of rows) byId[r.track_id] = r;
    const rootCache = {};
    function rootId(id) {
      if (rootCache[id]) return rootCache[id];
      let cur = id;
      const seen = new Set([id]);
      for (let g = 0; g < 20; g++) {
        const t = byId[cur];
        if (!t) break;
        const p = t.parent_track_id || null;
        if (!p || !byId[p] || seen.has(p)) break;
        seen.add(p);
        cur = p;
      }
      rootCache[id] = cur;
      return cur;
    }
    const groups = {};
    for (const r of rows) {
      const k = rootId(r.track_id);
      (groups[k] = groups[k] || []).push(r);
    }
    const tOf = (r) => String(r.sent_at || '');
    const roots = Object.keys(groups).sort((a, b) => tOf(groups[a][0]).localeCompare(tOf(groups[b][0])));
    for (const k of roots) groups[k].sort((a, b) => tOf(a).localeCompare(tOf(b)));
    return { byId, roots, groups };
  }

  let payload;
  try {
    const b = periodBounds();
    const apiUrl = `${url}/api/report/${kind}?format=json&tz=${encodeURIComponent(tz)}&from=${encodeURIComponent(b.from)}&to=${encodeURIComponent(b.to)}`;
    const r = await fetch(apiUrl, { headers: { 'X-PMT-Key': d.authToken } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    payload = await r.json();
  } catch (e) {
    document.getElementById('body').innerHTML = '<div class="error">Could not load report: ' + esc(e.message) + '</div>';
    return;
  }

  const s = payload.summary || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  document.getElementById('range').textContent =
    `${s.sent || 0} sent · ${s.detected || 0} detected · ${s.unique_detected || 0} unique · ${tz}`;
  document.getElementById('stats').innerHTML = [
    ['Sent', s.sent || 0], ['Detected', s.detected || 0], ['Unique detected', s.unique_detected || 0],
    ['Detection rate', (s.detection_rate || 0) + '%'], ['Unique rate', (s.unique_detection_rate || 0) + '%'],
    ['Tracking events', s.raw_events || 0], ['Via Gmail', s.proxy_events || 0], ['Direct', s.direct_events || 0],
    ['Avg. time to first detection', fmtDur(s.avg_time_to_first_detection_sec)],
  ].map(([k, val]) => `<div class="stat"><b>${esc(val)}</b>${esc(k)}</div>`).join('');

  const trend = (payload.daily_trend || []).map(x =>
    `<tr><td>${esc(x.date)}</td><td class="c">${x.sent}</td><td class="c">${x.detected}</td><td class="c">${x.unique_detected}</td><td class="c">${x.raw_events}</td></tr>`
  ).join('');
  const trendHtml = `<h2 class="sect">Daily trend (${esc(tz)})</h2><table><thead><tr><th>Date</th><th>Sent</th><th>Detected</th><th>Unique</th><th>Events</th></tr></thead><tbody>${trend || '<tr><td colspan="5" class="c">No activity.</td></tr>'}</tbody></table>`;

  const { roots, groups } = chainGroups(rows);
  const bodyRows = [];
  roots.forEach((rid) => {
    groups[rid].forEach((x, di) => {
      const indent = di > 0 ? '↳ ' : '';
      const tag = di > 0 ? ' <span class="followtag">follow-up</span>' : '';
      bodyRows.push(
        `<tr data-track-id="${esc(x.track_id)}"${di > 0 ? ' class="chain-child"' : ''}><td>${esc(indent + recipientOnly(x))}${tag}</td><td>${esc(x.subject || '(no subject)')}</td>` +
        `<td class="c">${x.unique_events || 0}</td><td class="c">${x.raw_events || 0}</td>` +
        `<td class="c">${x.proxy_events || 0}</td><td class="c">${x.direct_events || 0}</td>` +
        `<td>${esc(statusOf(x))}</td><td>${esc(fmtT(x.sent_at))}</td><td>${esc(fmtT(x.first_detected_at))}</td><td>${esc(fmtT(x.last_detected_at))}</td></tr>`
      );
    });
  });
  const bodyRowsHtml = bodyRows.join('');
  const tableHtml = `<h2 class="sect">Emails <span class="hint">— click a row for detection history</span></h2><table><thead><tr><th>To</th><th>Subject</th><th>Unique</th><th>Events</th><th>Via Gmail</th><th>Direct</th><th>Status</th><th>Sent</th><th>First detected</th><th>Last detected</th></tr></thead><tbody>${bodyRowsHtml || '<tr><td colspan="10" class="c">No tracked emails in this period.</td></tr>'}</tbody></table>`;

  const note = `<p class="note">“Detected” means the tracking image was loaded — it does not prove a person read the message. ` +
    `“Via Gmail” events were loaded through Gmail's image proxy. “Unique” is a conservative deduplicated estimate. Times shown in ${esc(tz)}.</p>`;
  document.getElementById('body').innerHTML =
    trendHtml + tableHtml +
    `<div class="row"><button id="dlcsv" class="primary">⬇ Download CSV</button></div>` + note;

  // v2.4.0: click a row to expand its per-event detection history.
  // Uses GET /api/tracks/:id (events carry time, source and device —
  // never raw IPs). Honest labels: image loads, not proof of reading.
  document.getElementById('body').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-track-id]');
    if (!tr) return;
    const id = tr.getAttribute('data-track-id');
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('detail-row') && next.getAttribute('data-for') === id) {
      next.remove();
      return;
    }
    document.querySelectorAll('tr.detail-row').forEach((r) => r.remove());
    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    detail.setAttribute('data-for', id);
    detail.innerHTML = '<td colspan="10" class="c">loading…</td>';
    tr.after(detail);
    try {
      const r = await fetch(`${url}/api/tracks/${encodeURIComponent(id)}`, { headers: { 'X-PMT-Key': d.authToken } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.json();
      const evs = (t.events || []).filter((ev) => !ev.is_suspected_self_view);
      detail.innerHTML = '<td colspan="10">' + (
        evs.length
          ? evs.map((ev, i) =>
              `<div class="evrow"><b>#${i + 1}</b> ${esc(evLabel(ev))} &middot; ${esc(fmtT(ev.received_at))} &middot; ${esc(ev.device || 'unknown device')}</div>`
            ).join('') +
            '<div class="evnote">ⓘ detections = image loads, not proof of reading</div>'
          : '<span class="c">No detections yet.</span>'
      ) + '</td>';
    } catch (err) {
      detail.innerHTML = '<td colspan="10" class="c">Could not load: ' + esc(err.message) + '</td>';
    }
  });

  document.getElementById('dlcsv').addEventListener('click', () => {    const head = ['track_id', 'recipient', 'subject', 'sent_at', 'detection_count',
      'unique_detection_count', 'proxy_event_count', 'direct_event_count',
      'first_detected_at', 'last_detected_at', 'detection_status'];
    const q = (val) => {
      let str = String(val == null ? '' : val);
      if (/^[=+\-@\t\r]/.test(str)) str = "'" + str; // neutralise spreadsheet formulas
      return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [head.join(',')];
    for (const x of rows) {
      lines.push([
        x.track_id, x.recipient, x.subject, fmtISOtz(x.sent_at),
        x.raw_events || 0, x.unique_events || 0, x.proxy_events || 0, x.direct_events || 0,
        fmtISOtz(x.first_detected_at), fmtISOtz(x.last_detected_at),
        (x.raw_events || 0) > 0 ? 'detected' : 'sent',
      ].map(q).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `promail-${kind}-${payload.label || 'report'}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
})();
