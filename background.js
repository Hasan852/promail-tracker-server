// background.js — MV3 service worker.
//
// Jobs:
//   1. Hand out tracking IDs to content.js (talks to the server).
//   2. Poll the server every 60s (chrome.alarms — the fastest reliable
//      interval for MV3 workers) for new opens on registered tracks.
//   3. Fire a desktop notification the moment a new open is detected.
//   4. Keep an unread counter badge on the extension icon.

const ALARM_NAME = 'pmt-poll';
const POLL_MINUTES = 1;

async function getStore() {
  const d = await chrome.storage.local.get(['serverUrl', 'tracks', 'unread']);
  return {
    serverUrl: (d.serverUrl || '').replace(/\/+$/, ''),
    tracks: d.tracks || {},
    unread: d.unread || 0,
  };
}

async function saveStore(patch) {
  await chrome.storage.local.set(patch);
}

function api(path, serverUrl) {
  return serverUrl + path;
}

async function createTrack(subject, to, from) {
  const { serverUrl, tracks } = await getStore();
  if (!serverUrl) return { ok: false, reason: 'no-server' };
  let res;
  try {
    res = await fetch(
      api('/api/create-track?subject=' + encodeURIComponent(subject || '') +
        '&to=' + encodeURIComponent(to || '') +
        '&from=' + encodeURIComponent(from || ''), serverUrl));
  } catch (e) {
    return { ok: false, reason: 'unreachable' };
  }
  if (!res.ok) return { ok: false, reason: 'server-error' };
  const data = await res.json();
  tracks[data.trackId] = {
    subject: subject || '',
    recipient: to || '',
    sender: from || '',
    serverUrl,
    createdAt: new Date().toISOString(),
    lastOpenCount: 0,
    opens: [], // cached snapshot for the popup
  };
  await saveStore({ tracks });
  return { ok: true, trackId: data.trackId, serverUrl };
}

// Final compose values (subject/To/sender) are known only at send time.
async function updateTrack(trackId, fields) {
  const { serverUrl, tracks } = await getStore();
  const t = tracks[trackId];
  if (!t || !serverUrl) return { ok: false };
  const q = '&subject=' + encodeURIComponent(fields.subject || '') +
    '&to=' + encodeURIComponent(fields.to || '') +
    '&from=' + encodeURIComponent(fields.from || '');
  try {
    await fetch(api('/api/update-track/' + encodeURIComponent(trackId) + '?' + q.slice(1), serverUrl));
  } catch (e) {
    /* server napping — local copy still updated below */
  }
  t.subject = fields.subject || t.subject;
  t.recipient = fields.to || t.recipient;
  t.sender = fields.from || t.sender;
  await saveStore({ tracks });
  return { ok: true };
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return iso;
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Honest device label: Gmail proxy hides the real device, so we only claim
// Mobile/Desktop for direct (non-proxy) opens.
function deviceInfo(open) {
  if (open.is_gmail_proxy) return { emoji: '', label: 'via Gmail', title: '📧 Email opened (via Gmail)' };
  const d = open.device || '';
  if (/mobile/i.test(d)) return { emoji: '📱', label: 'Mobile', title: '📧 Opened on Mobile' };
  if (/tablet|ipad/i.test(d)) return { emoji: '📱', label: 'Tablet', title: '📧 Opened on Tablet' };
  return { emoji: '🖥️', label: 'Desktop', title: '📧 Opened on Desktop' };
}

async function pollTracks() {
  const { tracks, unread } = await getStore();
  const ids = Object.keys(tracks);
  if (ids.length === 0) return;

  let newUnread = unread;
  let changed = false;

  for (const id of ids) {
    const t = tracks[id];
    let status;
    try {
      const res = await fetch(api('/api/status/' + encodeURIComponent(id), t.serverUrl));
      if (!res.ok) continue;
      status = await res.json();
    } catch (e) {
      continue; // server napping — try again next minute, never crash
    }
    const opens = Array.isArray(status.opens) ? status.opens : [];
    if (opens.length > (t.lastOpenCount || 0)) {
      const fresh = opens.slice(t.lastOpenCount || 0);
      const latest = fresh[fresh.length - 1];
      const dev = deviceInfo(latest);
      const openNum = opens.length; // this open's serial number
      const subj = t.subject ? `“${t.subject}”` : 'your email';
      const toLine = `To: ${t.recipient || '(unknown recipient)'}`;
      const subjLine = `${subj} — ${fmtTime(latest.opened_at)} (${ordinal(openNum)} open)`;
      const fromLine = t.sender ? `\nFrom: ${t.sender}` : '';
      const moreLine = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
      chrome.notifications.create('pmt-' + id + '-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: dev.title,
        message: `${toLine}\n${subjLine}${moreLine}${fromLine}`,
      });
      newUnread += fresh.length;
      t.lastOpenCount = opens.length;
      t.opens = opens.map((o) => ({ opened_at: o.opened_at, device: o.device, is_gmail_proxy: o.is_gmail_proxy }));
      changed = true;
    } else if (JSON.stringify(t.opens || []) !== JSON.stringify(opens.map((o) => o.opened_at))) {
      t.opens = opens.map((o) => ({ opened_at: o.opened_at, device: o.device, is_gmail_proxy: o.is_gmail_proxy }));
      changed = true;
    }
  }

  if (changed || newUnread !== unread) {
    await saveStore({ tracks, unread: newUnread });
  }
  await chrome.action.setBadgeText({ text: newUnread > 0 ? String(Math.min(newUnread, 99)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0b7a55' });
}

// ---- wiring ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollTracks();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'PMT_CREATE_TRACK') {
      sendResponse(await createTrack(msg.subject, msg.to, msg.from));
    } else if (msg.type === 'PMT_UPDATE_TRACK') {
      sendResponse(await updateTrack(msg.trackId, msg.fields || {}));
    } else if (msg.type === 'PMT_GET_TICK_DATA') {
      // Tick marks in Gmail: subject + createdAt + open state per track.
      const { tracks } = await getStore();
      sendResponse({
        ok: true,
        tracks: Object.keys(tracks).map((id) => {
          const t = tracks[id];
          const opens = Array.isArray(t.opens) ? t.opens : [];
          const last = opens.length ? opens[opens.length - 1] : null;
          return {
            id,
            subject: t.subject || '',
            recipient: t.recipient || '',
            createdAt: t.createdAt || '',
            openCount: t.lastOpenCount || 0,
            lastOpenedAt: last ? last.opened_at : null,
            viaGmail: !!(last && last.is_gmail_proxy),
          };
        }),
      });
    } else if (msg.type === 'PMT_POLL_NOW') {
      await pollTracks();
      sendResponse({ ok: true });
    } else if (msg.type === 'PMT_CLEAR_BADGE') {
      await saveStore({ unread: 0 });
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true; // async response
});
