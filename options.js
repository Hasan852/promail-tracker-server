// options.js — server URL + tracking preferences (v2.2.0).
//
// Server section: requests host permission for the server origin so the
// background worker can poll it (avoids the overly-broad https://*/* permission).
// Preferences section: timezone (report display), desktop notifications,
// privacy mode (server stops storing pixel IPs for this account), local
// cache size. The server always keeps full history; the cache cap only
// affects this profile's popup list.

// Pre-configured server (same as background.js DEFAULT_SERVER_URL) — shown
// in the box by default so every profile works with zero setup. Saving a
// different URL here overrides it.
const DEFAULT_SERVER_URL = 'https://promail-tracker-server.onrender.com';

const msg = (t, cls) => {
  const el = document.getElementById('msg');
  el.textContent = t;
  el.className = cls || '';
};

const pmsg = (t, cls) => {
  const el = document.getElementById('pmsg');
  el.textContent = t;
  el.className = cls || '';
};

function normalize(url) {
  url = (url || '').trim().replace(/\/+$/, '');
  return url;
}

async function getAuthToken() {
  const d = await chrome.storage.local.get(['authToken']);
  if (d.authToken) return d.authToken;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = 'pmt_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ authToken: token });
  return token;
}

async function testUrl(url) {
  const res = await fetch(url + '/health');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!j.ok) throw new Error('bad response');
  return j;
}

async function bootstrap(url) {
  const token = await getAuthToken();
  const res = await fetch(url + '/api/bootstrap', { method: 'POST', headers: { 'X-PMT-Key': token } });
  if (!res.ok) throw new Error('authentication/bootstrap failed (HTTP ' + res.status + ')');
  return res.json();
}

document.getElementById('save').addEventListener('click', async () => {
  const url = normalize(document.getElementById('url').value);
  if (!/^https:\/\//i.test(url)) {
    msg('❌ URL must start with https://', 'err');
    return;
  }
  msg('Testing connection…');
  try {
    const info = await testUrl(url);
    await bootstrap(url);
    // Ask Chrome for permission to talk to this origin.
    const granted = await chrome.permissions.request({ origins: [url + '/*'] });
    if (!granted) {
      msg('⚠ Permission denied — the tracker cannot poll this server.', 'err');
      return;
    }
    await chrome.storage.local.set({ serverUrl: url });
    msg(`✅ Saved & connected (backend: ${info.backend}). You can close this tab.`, 'ok');
  } catch (e) {
    msg('❌ Cannot reach server: ' + e.message, 'err');
  }
});

document.getElementById('test').addEventListener('click', async () => {
  const url = normalize(document.getElementById('url').value);
  if (!/^https:\/\//i.test(url)) {
    msg('❌ URL must start with https://', 'err');
    return;
  }
  msg('Testing…');
  try {
    const info = await testUrl(url);
    msg(`✅ Server reachable (backend: ${info.backend}, time: ${info.time})`, 'ok');
  } catch (e) {
    msg('❌ Cannot reach server: ' + e.message, 'err');
  }
});

/* ---------- preferences ---------- */

const COMMON_ZONES = [
  'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'Australia/Sydney', 'UTC',
];

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

async function loadPrefs() {
  const d = await chrome.storage.local.get([
    'serverUrl', 'timezone', 'notificationsEnabled', 'privacyMode', 'maxTracks',
  ]);
  document.getElementById('url').value = d.serverUrl || DEFAULT_SERVER_URL;
  document.getElementById('tz').value = d.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  document.getElementById('notif').checked = d.notificationsEnabled !== false;
  document.getElementById('privacy').checked = d.privacyMode === true;
  document.getElementById('cache').value = d.maxTracks || 500;
  const dl = document.getElementById('zones');
  COMMON_ZONES.forEach((z) => {
    const o = document.createElement('option');
    o.value = z;
    dl.appendChild(o);
  });
}

document.getElementById('psave').addEventListener('click', async () => {
  const tz = document.getElementById('tz').value.trim() || 'UTC';
  if (!validZone(tz)) {
    pmsg('❌ Unknown timezone: ' + tz, 'err');
    return;
  }
  const notif = document.getElementById('notif').checked;
  const privacy = document.getElementById('privacy').checked;
  const cache = Math.min(Math.max(parseInt(document.getElementById('cache').value, 10) || 500, 50), 5000);
  const prev = await chrome.storage.local.get(['privacyMode', 'serverUrl']);
  await chrome.storage.local.set({
    timezone: tz,
    notificationsEnabled: notif,
    privacyMode: privacy,
    maxTracks: cache,
  });
  // Push privacy mode to the server account (pixel IPs stop being stored).
  if (!!prev.privacyMode !== privacy && prev.serverUrl) {
    pmsg('Saving privacy mode on the server…');
    try {
      const token = await getAuthToken();
      const url = String(prev.serverUrl).replace(/\/+$/, '');
      const res = await fetch(url + '/api/account/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PMT-Key': token },
        body: JSON.stringify({ privacy_mode: privacy ? 1 : 0 }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      pmsg('⚠ Preferences saved locally, but the server update failed: ' + e.message, 'err');
      return;
    }
  }
  pmsg('✅ Preferences saved.', 'ok');
});

/* ---------- Google account (v2.3.0) ---------- */

const gmsg = (t, cls) => {
  const el = document.getElementById('gmsg');
  el.textContent = t;
  el.className = cls || '';
};

function renderGoogleStatus(account) {
  const el = document.getElementById('gstatus');
  const inBtn = document.getElementById('gsignin');
  const outBtn = document.getElementById('gsignout');
  if (account && account.email) {
    el.innerHTML = '';
    el.appendChild(document.createTextNode('Signed in as '));
    const b = document.createElement('b');
    b.textContent = account.email;
    el.appendChild(b);
    if (account.linkedAt) {
      el.appendChild(document.createTextNode(' (linked ' + account.linkedAt.slice(0, 10) + ')'));
    }
    inBtn.disabled = true;
    outBtn.disabled = false;
  } else {
    el.textContent = 'Not signed in. Your data is currently tied to this browser installation only.';
    inBtn.disabled = false;
    outBtn.disabled = true;
  }
}

async function refreshGoogleStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PMT_GOOGLE_STATUS' });
    renderGoogleStatus(r && r.account);
  } catch (e) {
    document.getElementById('gstatus').textContent = 'Could not reach the background worker.';
  }
}

document.getElementById('gsignin').addEventListener('click', async () => {
  gmsg('Opening Google sign-in…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PMT_GOOGLE_SIGNIN' });
    if (r && r.ok) {
      const merged = r.mergedTracks > 0 ? ` Restored with ${r.mergedTracks} previously tracked email(s).` : '';
      gmsg('✅ Signed in as ' + (r.email || 'your Google account') + '.' + merged, 'ok');
    } else {
      gmsg('❌ Sign-in failed: ' + ((r && r.error) || 'unknown error'), 'err');
    }
  } catch (e) {
    gmsg('❌ Sign-in failed: ' + e.message, 'err');
  }
  refreshGoogleStatus();
});

document.getElementById('gsignout').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'PMT_GOOGLE_SIGNOUT' });
    gmsg('Signed out on this browser. Your data stays linked to your Google account.', 'ok');
  } catch (e) {
    gmsg('❌ Sign-out failed: ' + e.message, 'err');
  }
  refreshGoogleStatus();
});

loadPrefs();
refreshGoogleStatus();
