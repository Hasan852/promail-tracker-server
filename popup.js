// popup.js — dashboard: serial list of tracked emails, server status,
// weekly/monthly report shortcuts.

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

// Honest device text: proxy hides the real device.
function deviceText(open) {
  if (!open) return '';
  if (open.is_gmail_proxy) return 'via Gmail';
  const d = open.device || '';
  if (/mobile/i.test(d)) return '📱 Mobile';
  if (/tablet|ipad/i.test(d)) return '📱 Tablet';
  return '🖥️ Desktop';
}

async function load() {
  const d = await chrome.storage.local.get(['serverUrl', 'tracks']);
  const serverUrl = (d.serverUrl || '').replace(/\/+$/, '');
  const tracks = d.tracks || {};

  const statusEl = document.getElementById('status');
  if (!serverUrl) {
    statusEl.textContent = '⚠ Set your server URL in Settings first.';
  } else {
    try {
      const r = await fetch(serverUrl + '/health');
      const j = await r.json();
      statusEl.textContent = j.ok ? `🟢 Server online (${j.backend})` : '🔴 Server error';
    } catch (e) {
      statusEl.textContent = '🔴 Cannot reach server';
    }
  }

  const list = document.getElementById('list');
  const ids = Object.keys(tracks).sort((a, b) => (tracks[b].createdAt || '').localeCompare(tracks[a].createdAt || ''));
  if (ids.length === 0) {
    list.innerHTML = '<div class="empty">No tracked emails yet.<br>Compose an email in Gmail and it will appear here.</div>';
  } else {
    list.innerHTML = ids.slice(0, 50).map((id, i) => {
      const t = tracks[id];
      const n = t.lastOpenCount || 0;
      const opens = t.opens || [];
      const last = opens.length ? opens[opens.length - 1] : null;
      const tickCls = n ? 'open' : 'unopen';
      const tickMark = n ? '✓✓' : '✓';
      const toLine = esc(t.recipient) || '<i>(unknown recipient)</i>';
      const subjLine = esc(t.subject) ? `“${esc(t.subject)}”` : '<i>(no subject)</i>';
      const openLine = last
        ? `${deviceText(last)} · ${esc(fmt(last.opened_at))} · <b>${n} open${n === 1 ? '' : 's'}</b>`
        : 'not opened yet';
      const fromLine = t.sender ? `<div class="from">from: ${esc(t.sender)}</div>` : '';
      return `<div class="item"><div class="serial">#${i + 1}</div><div class="body">
        <div class="to"><span class="tick ${tickCls}">${tickMark}</span>To: ${toLine}</div>
        <div class="subj">${subjLine}</div>
        <div class="meta">${openLine}</div>${fromLine}
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

async function openReport(kind) {
  const d = await chrome.storage.local.get(['serverUrl']);
  const serverUrl = (d.serverUrl || '').replace(/\/+$/, '');
  if (!serverUrl) return alert('Set your server URL in Settings first.');
  chrome.tabs.create({ url: serverUrl + '/report/' + kind });
}

document.getElementById('weekly').addEventListener('click', () => openReport('weekly'));
document.getElementById('monthly').addEventListener('click', () => openReport('monthly'));

document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

load();
