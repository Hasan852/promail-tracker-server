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
  return t.sent !== 0;
}

function detectionLine(t) {
  const a = analyticsOf(t);
  if (!a.raw) return 'Sent — no detection yet';
  const bits = [`${a.raw} tracking event${a.raw === 1 ? '' : 's'}`];
  if (a.unique !== a.raw) bits.push(`${a.unique} estimated unique`);
  const evs = (t.recentEvents || []).filter((e) => !e.is_suspected_self_view);
  const last = evs.length ? evs[evs.length - 1] : null;
  if (last && last.event_type === 'GMAIL_PROXY') bits.push('via Gmail');
  else if (last && last.event_type === 'DIRECT') bits.push('direct');
  return 'Detected · ' + bits.join(' · ');
}

function timeLine(t) {
  const a = analyticsOf(t);
  if (!a.first) return '';
  if (a.first === a.last) return `Detected ${esc(fmt(a.first))}`;
  return `First ${esc(fmt(a.first))} · Last ${esc(fmt(a.last))}`;
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

async function load() {
  const d = await chrome.storage.local.get(['serverUrl', 'tracks', 'lastSyncAt', 'deadLetter']);
  const serverUrl = (d.serverUrl || '').replace(/\/+$/, '');
  const tracks = d.tracks || {};

  const statusEl = document.getElementById('status');
  if (!serverUrl) {
    statusEl.textContent = '⚠ Set your server URL in Settings first.';
  } else {
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
  const ids = Object.keys(tracks)
    .filter((id) => shouldShowTrack(tracks[id]))
    .sort((a, b) => (tracks[b].createdAt || '').localeCompare(tracks[a].createdAt || ''));
  if (ids.length === 0) {
    list.innerHTML = '<div class="empty">No tracked emails yet.<br>Send an email in Gmail and it will appear here.</div>';
  } else {
    list.innerHTML = ids.slice(0, 100).map((id, i) => {
      const t = tracks[id];
      const { tickCls, tickMark } = tickForTrack(t);
      const toLine = recipientOnly(t);
      const subjLine = esc(t.subject) ? `“${esc(t.subject)}”` : '<i>(no subject)</i>';
      const detLine = detectionLine(t);
      const tLine = timeLine(t);
      return `<div class="item"><div class="serial">#${i + 1}</div><div class="body">
        <div class="to"><span class="tick ${tickCls}" title="${esc(DISCLAIMER)}">${tickMark}</span>To: ${toLine}</div>
        <div class="subj">${subjLine}</div>
        <div class="meta">${esc(detLine)}</div>
        ${tLine ? `<div class="meta">${tLine}</div>` : ''}
        ${historyHtml(t)}
      </div></div>`;
    }).join('');
  }

  // Opening the popup marks notifications as seen.
  chrome.runtime.sendMessage({ type: 'PMT_CLEAR_BADGE' });
}

document.getElementById('refresh').addEventListener('click', async () => {
  document.getElementById('status').textContent = 'checking…';
  await chrome.runtime.sendMessage({ type: 'PMT_POLL_NOW' });
  load();
});

// Clear: wipes only THIS profile's local cache. Server history stays safe.
document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Clear this popup\u2019s local cache?\nYour server history stays safe.')) return;
  await chrome.storage.local.set({ tracks: {}, unread: 0, deadLetter: [] });
  await chrome.runtime.sendMessage({ type: 'PMT_CLEAR_BADGE' });
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
  const d = await chrome.storage.local.get(['serverUrl']);
  const serverUrl = (d.serverUrl || '').replace(/\/+$/, '');
  if (!serverUrl) return alert('Set your server URL in Settings first.');
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html?kind=' + encodeURIComponent(kind)) });
}

document.getElementById('weekly').addEventListener('click', () => openReport('weekly'));
document.getElementById('monthly').addEventListener('click', () => openReport('monthly'));

document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

load();
