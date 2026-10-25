// popup.js — dashboard (v2.2.0): tracked emails with detection analytics,
// server status, last-sync info, weekly/monthly report shortcuts.
//
// Terminology is deliberately careful: a tracking pixel detects IMAGE
// LOADING. It cannot prove a human read the message.

const DISCLAIMER = 'Email tracking detects image loading. It cannot guarantee that a person read the message.';

function fmt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return iso;
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function recipientOnly(track) {
  // v2.4.0: server-computed primary recipient (automated noreply-style
  // addresses filtered out); falls back to the old join for older data.
  if (track.primary_recipient) return esc(track.primary_recipient);
  const sender = String(track.sender || '').trim().toLowerCase();
  const recipients = String(track.recipient || '').split(/[;,]/)
    .map((email) => email.trim())
    .filter((email) => email && (!sender || email.toLowerCase() !== sender));
  return esc(recipients.join(', ')) || '<i>(unknown recipient)</i>';
}

// Honest per-event label: a proxy hides the real client.
function eventLabel(e) {
  if (!e) return 'Detected';
  if (e.event_type === 'GMAIL_PROXY') return 'Detected via Gmail';
  if (e.event_type === 'OTHER_PROXY') return 'Detected via proxy';
  const d = e.device || '';
  if (/mobile/i.test(d)) return '📱 Detected on Mobile';
  if (/tablet|ipad/i.test(d)) return '📱 Detected on Tablet';
  if (/desktop/i.test(d)) return '🖥️ Detected on Desktop';
  return 'Detected';
}

function analyticsOf(t) {
  const a = t.analytics || {};
  return {
    raw: a.raw_event_count || 0,
    unique: a.estimated_unique_events || 0,
    proxy: a.proxy_event_count || 0,
    direct: a.direct_event_count || 0,
    first: a.first_detected_at || null,
    last: a.last_detected_at || null,
  };
}

// The tick is derived ONLY from server-synced analytics (single source of
// truth). ✓ = sent, no detection. ✓✓ = detection received.
function tickForTrack(t) {
  const { raw } = analyticsOf(t);
  return { tickCls: raw ? 'open' : 'unopen', tickMark: raw ? '✓✓' : '✓' };
}

// The popup lists only actually-sent mails. Deferred tracks (compose opened
// but Send not yet clicked) carry sent:0 and stay hidden. Missing sent flag
// (tracks stored by older versions) counts as sent.
function shouldShowTrack(t) {
  return t.sent !== 0 && !t.hidden; // hidden = the user pressed "Clear list"
}

function detectionLine(t) {
  const a = analyticsOf(t);
  if (!a.raw) return 'Sent — not opened yet';
  // Headline = how many times the mail was opened (estimated unique opens:
  // duplicate proxy/cache hits are deduped server-side). Raw event count is
  // shown too when it differs, and the header ⓘ keeps the honest definition.
  const opens = a.unique || a.raw;
  const bits = [`Opened ${opens} time${opens === 1 ? '' : 's'}`];
  if (a.raw !== opens) bits.push(`${a.raw} tracking events`);
  const evs = (t.recentEvents || []).filter((e) => !e.is_suspected_self_view);
  const last = evs.length ? evs[evs.length - 1] : null;
  if (last && last.event_type === 'GMAIL_PROXY') bits.push('via Gmail');
  else if (last && last.event_type === 'DIRECT') bits.push('direct');
  return bits.join(' · ');
}

function timeLine(t) {
  const a = analyticsOf(t);
  if (!a.first) return '';
  if (a.first === a.last) return `Opened ${esc(fmt(a.first))}`;
  return `First opened ${esc(fmt(a.first))} · Last opened ${esc(fmt(a.last))}`;
}

// Expandable per-event detection history (cached recent events).
function historyHtml(t) {
  const evs = (t.recentEvents || []).filter((e) => !e.is_suspected_self_view);
  if (!evs.length) return '<div class="history" hidden><div class="hrow">no detections yet</div></div>';
  const rows = evs.map((e, i) =>
    `<div class="hrow"><span class="hnum">#${i + 1}</span>${esc(eventLabel(e))} &middot; ${esc(fmt(e.received_at))}</div>`
  ).join('');
  const note = `<div class="hrow hnote" title="${esc(DISCLAIMER)}">ⓘ detections = image loads, not proof of reading</div>`;
  return `<div class="history" hidden>${rows}${note}</div>`;
}

function parentIdOf(t) { return t.parent_track_id || t.parentTrackId || null; }

// v2.4.0: follow-up chains. Tracks group under their root ancestor
// (cycle-safe walk). Roots sort newest-first; chain members oldest-first.
function buildChains(tracks) {
  const byId = {};
  for (const id of Object.keys(tracks)) {
    if (shouldShowTrack(tracks[id])) byId[id] = tracks[id];
  }
  const rootCache = {};
  function rootId(id) {
    if (rootCache[id]) return rootCache[id];
    let cur = id;
    const seen = new Set([id]);
    for (let g = 0; g < 20; g++) {
      const t = byId[cur];
      if (!t) break;
      const p = parentIdOf(t);
      if (!p || !byId[p] || seen.has(p)) break;
      seen.add(p);
      cur = p;
    }
    rootCache[id] = cur;
    return cur;
  }
  const groups = {};
  for (const id of Object.keys(byId)) {
    const r = rootId(id);
    (groups[r] = groups[r] || []).push(id);
  }
  const timeOf = (id) => String(byId[id].sentAt || byId[id].createdAt || '');
  const roots = Object.keys(groups).sort((a, b) =>
    String(byId[b].createdAt || '').localeCompare(String(byId[a].createdAt || '')));
  for (const r of roots) groups[r].sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  return { byId, roots, groups };
}

function itemHtml(t, serial, depth) {
  const { tickCls, tickMark } = tickForTrack(t);
  const toLine = recipientOnly(t);
  const subjLine = esc(t.subject) ? `\u201c${esc(t.subject)}\u201d` : '<i>(no subject)</i>';
  const detLine = detectionLine(t);
  const tLine = timeLine(t);
  const followTag = depth > 0 ? '<span class="followtag">follow-up</span>' : '';
  return `<div class="item${depth ? ' child' : ''}"><div class="serial">${depth ? '\u21b3' : '#' + serial}</div><div class="body">
    <div class="to"><span class="tick ${tickCls}" title="${esc(DISCLAIMER)}">${tickMark}</span>To: ${toLine}${followTag}</div>
    <div class="subj">${subjLine}</div>
    <div class="meta">${esc(detLine)}</div>
    ${tLine ? `<div class="meta">${tLine}</div>` : ''}
    ${historyHtml(t)}
  </div></div>`;
}

async function load() {
  const d = await chrome.storage.local.get(['serverUrl', 'tracks', 'lastSyncAt', 'deadLetter']);
  const serverUrl = (d.serverUrl || PMT_DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const tracks = d.tracks || {};

  const statusEl = document.getElementById('status');
  {
    try {
      const r = await fetch(serverUrl + '/health');
      const j = await r.json();
      statusEl.textContent = j.ok ? `🟢 Server online (${j.backend || ''})` : '🔴 Server error';
    } catch (e) {
      statusEl.textContent = '🔴 Cannot reach server';
    }
  }

  const syncEl = document.getElementById('syncinfo');
  const bits = [];
  if (d.lastSyncAt) bits.push('Last synced ' + fmt(d.lastSyncAt));
  const dead = (d.deadLetter || []).length;
  if (dead) bits.push(`⚠ ${dead} sync ${dead === 1 ? 'failure' : 'failures'} need attention (Settings)`);
  syncEl.textContent = bits.join(' · ');
  syncEl.hidden = bits.length === 0;

  const list = document.getElementById('list');
  const { byId, roots, groups } = buildChains(tracks);
  if (roots.length === 0) {
    list.innerHTML = '<div class="empty">No tracked emails yet.<br>Send an email in Gmail and it will appear here.</div>';
  } else {
    const parts = [];
    roots.slice(0, 100).forEach((rid, i) => {
      groups[rid].forEach((id, di) => {
        parts.push(itemHtml(byId[id], i + 1, di));
      });
    });
    list.innerHTML = parts.join('');
  }

  // Opening the popup marks notifications as seen.
  chrome.runtime.sendMessage({ type: 'PMT_CLEAR_BADGE' });
}

document.getElementById('refresh').addEventListener('click', async () => {
  document.getElementById('status').textContent = 'checking…';
  await chrome.runtime.sendMessage({ type: 'PMT_POLL_NOW' });
  load();
});

// Clear list: only HIDES the rows here. Wiping the cache would also remove the
// Gmail ticks and (because sync is incremental) never bring those mails back.
// Server history is untouched; a hidden mail reappears when it is detected again.
document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Clear this list?\nGmail ticks, notifications and your server history are not affected.')) return;
  await chrome.storage.local.set({ deadLetter: [] });
  await chrome.runtime.sendMessage({ type: 'PMT_CLEAR_LIST' });
  load();
});

// Click a row to expand/collapse its detection history.
document.getElementById('list').addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  const h = item.querySelector('.history');
  if (h) h.hidden = !h.hidden;
});

async function openReport(kind) {
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html?kind=' + encodeURIComponent(kind)) });
}

document.getElementById('weekly').addEventListener('click', () => openReport('weekly'));
document.getElementById('monthly').addEventListener('click', () => openReport('monthly'));

document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

load();
