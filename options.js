// options.js — server URL setup. Requests host permission for the server
// origin so the background worker can poll it (avoids the overly-broad
// https://*/* permission).

const msg = (t, cls) => {
  const el = document.getElementById('msg');
  el.textContent = t;
  el.className = cls || '';
};

function normalize(url) {
  url = (url || '').trim().replace(/\/+$/, '');
  return url;
}

async function testUrl(url) {
  const res = await fetch(url + '/health');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!j.ok) throw new Error('bad response');
  return j;
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

(async () => {
  const d = await chrome.storage.local.get(['serverUrl']);
  if (d.serverUrl) document.getElementById('url').value = d.serverUrl;
})();
