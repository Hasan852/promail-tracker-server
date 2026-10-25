// content.js — runs inside Gmail (v2.4.2).
//
// Part 1  pixel insertion   one 1x1 <img>, nothing else in the mail is touched.
// Part 2  send detection    delegated listeners (survive Gmail re-rendering) -> server commit.
// Part 3  own-view guard    the sender's own copy of the pixel is removed the moment it
//                           appears in Gmail's message view and the server is told, so the
//                           sender reading their own mail is never counted or notified.
// Part 4  ticks             ✓ sent / ✓✓ detected, in the Sent list and the message view.
//
// All Gmail-specific selectors live in SELECTORS below: if Google renames a
// class, this is the only place to change.
//
// Re-injection guard: background.js re-injects this file into already-open Gmail
// tabs after install/update; the guard makes re-execution safe.
if (!window.__pmtBooted) {
window.__pmtBooted = true;

const SELECTORS = {
  composeBody: ['div[role="textbox"][g_editable="true"]', 'div[aria-label="Message Body"]'],
  sendButton: ['div.aoO', 'div.T-I-atl[role="button"]'],
  subjectInput: ['input[name="subjectbox"]'],
  fieldsMarker: ['input[name="subjectbox"]', '[name="to"]', '.aoD', '.vR'],
  recipientInputs: ['[name="to"]', '[name="cc"]', '[name="bcc"]'],
  notComposeField: ['.a3s', '.adn', '.gs', '.hb', '.gD', 'h3', '[data-message-id]'],
  threadSubject: ['h2.hP'],
  listRow: ['tr.zA'],
  listSubject: ['span.bog'],
  listPeople: ['td.yX'],
  listDate: ['td.xW span'],
  messageHeader: ['div.ha'],
};
const COMPOSE_SELECTOR = SELECTORS.composeBody.join(', ');
const SEND_BTN_SELECTOR = SELECTORS.sendButton.join(', ');
const MARK_ATTR = 'data-pmt-tracked';
const PX_RE = /\/px\/(trk_[A-Za-z0-9]{12})\.gif/;
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/* ================= shared state ================= */

let ownIds = new Set(); // track ids created by THIS browser profile (never cleared by the popup)
let ownReady = false;

function send(msg) {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  } catch (e) {
    return Promise.resolve(null);
  }
}

function loadLocalState() {
  try {
    chrome.storage.local.get(['ownIds'], (d) => {
      if (chrome.runtime.lastError) return;
      ownIds = new Set(d.ownIds || []);
      ownReady = true;
      sweepPixels();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.ownIds) { for (const id of ch.ownIds.newValue || []) ownIds.add(id); }
      if (ch.tracks) scheduleTickRefresh();
    });
  } catch (e) { /* never break Gmail */ }
}

/* ================= Part 1: pixel insertion ================= */

function countBoxes(el) {
  return el.querySelectorAll(COMPOSE_SELECTOR).length;
}

// Lowest ancestor that contains this compose body AND a Send button but no other
// compose body — i.e. exactly this compose window (popup, full-screen or inline reply).
function getComposeRoot(box) {
  let el = box.parentElement;
  for (let i = 0; el && i < 25; i++, el = el.parentElement) {
    if (countBoxes(el) > 1) break;
    if (el.querySelector(SEND_BTN_SELECTOR)) return el;
  }
  return box.closest('[role="dialog"]') || box.closest('form') || box.parentElement || document.body;
}

// The recipient / subject rows may sit above the Send toolbar — climb until we see them.
function getFieldsRoot(box) {
  let el = box.parentElement;
  for (let i = 0; el && i < 30; i++, el = el.parentElement) {
    if (countBoxes(el) > 1) break;
    if (el.querySelector(SELECTORS.fieldsMarker.join(', '))) return el;
  }
  return getComposeRoot(box);
}

function getComposeSubject(box) {
  try {
    const input = getFieldsRoot(box).querySelector(SELECTORS.subjectInput.join(', '));
    if (input && input.value) return input.value.trim().slice(0, 300);
    const h = document.querySelector(SELECTORS.threadSubject.join(', ')); // inline reply: subject = thread subject
    if (h && h.textContent) return h.textContent.trim().slice(0, 300);
  } catch (e) { /* ignore */ }
  return '';
}

const NOT_COMPOSE_FIELD = SELECTORS.notComposeField.join(', ');

function getComposeRecipients(box) {
  try {
    const root = getFieldsRoot(box);
    const seen = [];
    const add = (e) => {
      e = (e || '').trim().toLowerCase();
      if (e && !seen.includes(e)) seen.push(e);
    };
    root.querySelectorAll(SELECTORS.recipientInputs.join(', ')).forEach((el) => {
      if (box.contains(el)) return;
      const txt = el.value !== undefined && el.value !== '' ? el.value : el.textContent;
      (String(txt || '').match(EMAIL_RE) || []).forEach(add);
    });
    root.querySelectorAll('[email]').forEach((el) => {
      if (box.contains(el) || el.closest(NOT_COMPOSE_FIELD)) return;
      add(el.getAttribute('email'));
    });
    root.querySelectorAll('[data-hovercard-id*="@"]').forEach((el) => {
      if (box.contains(el) || el.closest(NOT_COMPOSE_FIELD)) return;
      add(el.getAttribute('data-hovercard-id'));
    });
    const me = (getSenderEmail() || '').toLowerCase();
    const others = seen.filter((e) => e !== me);
    return (others.length ? others : seen).slice(0, 5).join(', ');
  } catch (e) {
    return '';
  }
}

// Sender = the Gmail account of this tab (any UI language: the window title carries it).
function getSenderEmail() {
  try {
    const titleMatch = (document.title || '').match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
    if (titleMatch) return titleMatch[1];
    const btn = document.querySelector('[aria-label^="Google Account"]') || document.querySelector('[aria-label*="@"]');
    if (btn) {
      const m = (btn.getAttribute('aria-label') || '').match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
      if (m) return m[1];
    }
  } catch (e) { /* ignore */ }
  return '';
}

// Client-generated id: the pixel goes in instantly, no server round-trip at compose.
function newTrackId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let s = 'trk_';
  for (let i = 0; i < 12; i++) s += chars[buf[i] % 62];
  return s;
}

// Keep the freshest metadata locally (Gmail strips To chips at Send time).
function touchTrackMeta(box, trackId) {
  try {
    const subject = getComposeSubject(box);
    const to = getComposeRecipients(box) || box.dataset.pmtLastTo || '';
    if (to) box.dataset.pmtLastTo = to;
    if (subject) box.dataset.pmtLastSubj = subject;
    send({ type: 'PMT_TOUCH_TRACK', trackId, subject, to, from: getSenderEmail() });
  } catch (e) { /* ignore */ }
}

function attachPixel(box) {
  if (box.hasAttribute(MARK_ATTR)) return;
  if (/^#settings/.test(location.hash || '')) return; // signature editor etc. is not a mail
  box.setAttribute(MARK_ATTR, 'pending');

  const trackId = newTrackId();
  ownIds.add(trackId); // known BEFORE the img exists, so the guard never mistakes it for foreign
  send({
    type: 'PMT_PREPARE_TRACK', id: trackId,
    subject: getComposeSubject(box), to: getComposeRecipients(box), from: getSenderEmail(),
  }).then((resp) => {
    if (!resp || !resp.ok) {
      // background asleep / server config missing: retry in a few seconds, never spin.
      box.setAttribute(MARK_ATTR, 'failed');
      setTimeout(() => box.removeAttribute(MARK_ATTR), 5000);
      return;
    }
    try {
      const base = resp.serverUrl.replace(/\/+$/, '');
      const img = document.createElement('img');
      img.setAttribute('src', base + '/px/' + trackId + '.gif');
      img.setAttribute('width', '1');
      img.setAttribute('height', '1');
      img.setAttribute('border', '0');
      img.setAttribute('alt', '');
            box.setAttribute(MARK_ATTR, trackId); // set before the img lands so the guard recognises it
      box.appendChild(img);
      if (!box.dataset.pmtInputWired) {
        box.dataset.pmtInputWired = '1';
        let timer = null;
        getFieldsRoot(box).addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => touchTrackMeta(box, trackId), 2500);
        }, true);
      }
    } catch (e) {
      box.removeAttribute(MARK_ATTR);
    }
  });
}

function scan() {
  if (/^#settings/.test(location.hash || '')) return;
  document.querySelectorAll(COMPOSE_SELECTOR).forEach(attachPixel);
}

/* ================= Part 2: send detection ================= */

function findTrackedBox(fromEl) {
  let el = fromEl instanceof Element ? fromEl : null;
  for (let i = 0; el && i < 30; i++, el = el.parentElement) {
    const boxes = el.querySelectorAll('[' + MARK_ATTR + '^="trk_"]');
    if (boxes.length === 1) return boxes[0];
    if (boxes.length > 1) return null;
  }
  return null;
}

function commitFromBox(box) {
  const trackId = box.getAttribute(MARK_ATTR);
  if (!trackId || trackId.indexOf('trk_') !== 0) return;
  const now = Date.now();
  if (box._pmtLastCommit && now - box._pmtLastCommit < 2000) return;
  box._pmtLastCommit = now;
  try {
    const subject = getComposeSubject(box) || box.dataset.pmtLastSubj || '';
    const to = getComposeRecipients(box) || box.dataset.pmtLastTo || '';
    send({ type: 'PMT_COMMIT_TRACK', trackId, subject, to, from: getSenderEmail() }).then((r) => {
      if (!r) showStaleBanner();
    });
  } catch (e) { /* never break Gmail send */ }
}

// Fallback: a Sent-list row matched a track that was never committed (schedule-send,
// missed click) -> the mail WAS sent.
const fallbackDone = new Set();
function fallbackCommit(t) {
  if (!t || !t.id || fallbackDone.has(t.id)) return;
  fallbackDone.add(t.id);
  send({ type: 'PMT_COMMIT_TRACK', trackId: t.id, subject: t.subject || '', to: t.recipient || '', from: t.sender || '' });
}

document.addEventListener('click', (e) => {
  try {
    const btn = e.target instanceof Element ? e.target.closest(SEND_BTN_SELECTOR) : null;
    if (!btn) return;
    const box = findTrackedBox(btn);
    if (box) commitFromBox(box);
  } catch (err) { /* ignore */ }
}, true);

document.addEventListener('keydown', (e) => {
  try {
    if (!((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13))) return;
    const box = findTrackedBox(e.target);
    if (box) commitFromBox(box);
  } catch (err) { /* ignore */ }
}, true);

/* ================= Part 3: own-open guard ================= */

function pixelIdFromSrc(src) {
  if (!src || src.indexOf('trk_') === -1) return null; // fast reject (Gmail has thousands of imgs)
  let s = src;
  try { s = decodeURIComponent(src); } catch (e) { /* keep raw */ }
  const m = s.match(PX_RE);
  return m ? m[1] : null;
}

const selfViewSentAt = {};
function signalSelfView(id) {
  const now = Date.now();
  if (selfViewSentAt[id] && now - selfViewSentAt[id] < 8000) return; // each new view re-signals
  selfViewSentAt[id] = now;
  send({ type: 'PMT_SELF_VIEW', trackId: id });
}

// Called for every <img> Gmail adds / re-points. Own pixel outside the compose window =
// the sender (or a quoted copy of the sender's mail) is looking at it -> tell the
// server first, then take the pixel out of the page. Foreign pixels (other people's
// trackers sharing this server) are never touched.
function guardPixel(img) {
  if (!img || img.tagName !== 'IMG') return;
  const id = pixelIdFromSrc(img.getAttribute('src'));
  if (!id) return;
  if (ownReady && !ownIds.has(id)) return;

  const box = img.closest(COMPOSE_SELECTOR);
  if (box) {
    // Inside a compose window the ONE pixel we added stays. Any other of our pixels
    // (quoted earlier mail in a reply/forward, resumed draft) would ping the old
    // track from the sender's own browser -> remove it from the outgoing copy.
    if (box.getAttribute(MARK_ATTR) === id) return;
    img.remove();
    return;
  }
  signalSelfView(id);
  img.remove();
}

function sweepPixels() {
  try { document.querySelectorAll('img[src*="trk_"]').forEach(guardPixel); } catch (e) { /* ignore */ }
}

const guardObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === 'attributes') {
      guardPixel(m.target);
    } else {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') guardPixel(n);
        else if (n.querySelectorAll) n.querySelectorAll('img[src*="trk_"]').forEach(guardPixel);
      }
    }
  }
});
guardObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

/* ================= Part 4: tick marks ================= */

function normSubject(s) {
  let n = (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  let prev;
  do {
    prev = n;
    n = n.replace(/^(re|fwd?)\s*:\s*/, '');
  } while (n !== prev);
  return n;
}

// Thread rows show the thread subject + snippet; accept a prefix match (>= 4 chars).
function subjectsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length >= 4 && long.startsWith(short);
}

function fmtTickTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso || ''; }
}

function parseGmailDate(txt) {
  txt = (txt || '').trim();
  if (!txt) return null;
  const now = new Date();
  let m = txt.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i) || txt.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3];
    if (ampm) {
      const pm = /p/i.test(ampm);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() > now.getTime() + 5 * 60 * 1000) d.setDate(d.getDate() - 1);
    return d;
  }
  m = txt.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (m) {
    const d = new Date(m[1] + ' ' + m[2] + ', ' + now.getFullYear());
    if (isNaN(d.getTime())) return null;
    if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  m = txt.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return null;
}

// Gmail's date cell carries the full timestamp in its title attribute — more reliable than the text.
function rowDate(row) {
  const el = row.querySelector(SELECTORS.listDate.join(', '));
  if (!el) return null;
  const t = el.getAttribute('title');
  if (t) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d;
  }
  return parseGmailDate(el.textContent);
}

function emailsOf(str) {
  return (String(str || '').toLowerCase().match(EMAIL_RE) || []);
}

// Match a Gmail row/view to one of our tracks: subject first, then recipients,
// then the row's date (12h window); committed tracks beat never-sent composes.
function findTrack(tracks, subject, dateHint, rowEmails) {
  const ns = normSubject(subject);
  if (!ns || !Array.isArray(tracks)) return null;
  let cands = tracks.filter((t) => subjectsMatch(normSubject(t.subject), ns));
  if (cands.length === 0) return null;
  const committed = cands.filter((t) => t.sent !== 0);
  if (committed.length) cands = committed;
  if (cands.length === 1) return cands[0];
  if (rowEmails && rowEmails.length) {
    const byRcpt = cands.filter((t) => emailsOf(t.recipient).some((e) => rowEmails.includes(e)));
    if (byRcpt.length) cands = byRcpt;
    if (cands.length === 1) return cands[0];
  }
  if (!dateHint || isNaN(dateHint.getTime())) {
    return cands.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[cands.length - 1];
  }
  let best = null;
  let bestDiff = Infinity;
  for (const t of cands) {
    const c = new Date(t.createdAt).getTime();
    if (isNaN(c)) continue;
    const diff = Math.abs(c - dateHint.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = t; }
  }
  return best && bestDiff < 12 * 3600 * 1000 ? best : null;
}

function tickTitle(t) {
  if (t.rawCount > 0) {
    let s = 'Detected — ' + t.rawCount + ' tracking event' + (t.rawCount === 1 ? '' : 's');
    if (t.uniqueCount && t.uniqueCount !== t.rawCount) s += ' (' + t.uniqueCount + ' estimated unique)';
    if (t.lastDetectedAt) s += ' · last ' + fmtTickTime(t.lastDetectedAt);
    if (t.viaGmail) s += ' · via Gmail';
    return s + '\nImage loads are not proof the message was read.';
  }
  return 'Sent — no detection yet';
}

function tickSig(t) {
  return [t.id, t.rawCount > 0 ? 2 : 1, t.rawCount, t.uniqueCount || 0, t.lastDetectedAt || ''].join('|');
}

function makeTickEl(t) {
  const seen = t.rawCount > 0;
  const el = document.createElement('span');
  el.setAttribute('data-pmt-tick', t.id);
  el.setAttribute('data-pmt-sig', tickSig(t));
  el.textContent = seen ? '✓✓' : '✓';
  el.title = tickTitle(t);
  el.style.cssText =
    'display:inline-block;margin:0 6px 0 2px;font-size:13px;font-weight:700;line-height:1;' +
    'vertical-align:baseline;cursor:default;' + (seen ? 'color:#00b578;' : 'color:#9aa0a6;');
  return el;
}

// #sent, #sent?page=2, #sent/p2  = list;  #sent/<message id>  = message view
function isSentListView() {
  return /^#sent(\/p\d+)?(\?.*)?$/.test(location.hash || '');
}
function isSentEmailView() {
  return /^#sent\/(?!p\d+(\?.*)?$)/.test(location.hash || '');
}

// Idempotent: a row whose tick already shows the right state is left alone, so
// rendering never causes DOM churn (and can never feed back into the observer).
function placeTick(container, anchorFirst, t) {
  const existing = container.querySelector(':scope > [data-pmt-tick]');
  if (existing && existing.getAttribute('data-pmt-sig') === tickSig(t)) return;
  if (existing) existing.remove();
  const el = makeTickEl(t);
  if (anchorFirst) container.insertBefore(el, container.firstChild);
  else container.appendChild(el);
}

function refreshSentList(tracks) {
  document.querySelectorAll(SELECTORS.listRow.join(', ')).forEach((row) => {
    try {
      const subjEl = row.querySelector(SELECTORS.listSubject.join(', '));
      const peopleCell = row.querySelector(SELECTORS.listPeople.join(', '));
      const holder = peopleCell || (subjEl && subjEl.parentElement);
      if (!subjEl || !holder) return;
      const rowEmails = Array.from(row.querySelectorAll('[email]')).map((e) => (e.getAttribute('email') || '').toLowerCase());
      const t = findTrack(tracks, subjEl.textContent, rowDate(row), rowEmails);
      if (!t) {
        holder.querySelectorAll(':scope > [data-pmt-tick]').forEach((x) => x.remove());
        return;
      }
      if (t.sent === 0) fallbackCommit(t);
      placeTick(holder, !!peopleCell, t);
    } catch (e) { /* never break Gmail */ }
  });
}

function refreshSentEmailView(tracks) {
  try {
    const header = document.querySelector(SELECTORS.messageHeader.join(', '));
    const h2 = header && header.querySelector(SELECTORS.threadSubject.join(', '));
    if (!h2 || !h2.parentElement) return;
    const t = findTrack(tracks, h2.textContent, null, null);
    if (!t) {
      h2.parentElement.querySelectorAll(':scope > [data-pmt-tick]').forEach((x) => x.remove());
      return;
    }
    placeTick(h2.parentElement, false, t);
  } catch (e) { /* never break Gmail */ }
}

async function refreshTicks() {
  if (!isSentListView() && !isSentEmailView()) return;
  const resp = await send({ type: 'PMT_GET_TICK_DATA' });
  if (!resp || !resp.ok || !Array.isArray(resp.tracks)) {
    showStaleBanner();
    return;
  }
  const stale = document.querySelector('[data-pmt-stale]');
  if (stale) stale.remove();
  staleBannerShown = false;
  if (isSentListView()) refreshSentList(resp.tracks);
  else refreshSentEmailView(resp.tracks);
}

let staleBannerShown = false;
function showStaleBanner() {
  if (staleBannerShown) return;
  staleBannerShown = true;
  try {
    const bar = document.createElement('div');
    bar.setAttribute('data-pmt-stale', '1');
    bar.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:999999;background:#fff8e1;color:#5d4037;border:1px solid #e6a500;' +
      'border-radius:8px;padding:8px 12px;font-size:13px;font-family:Roboto,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    bar.textContent = 'ProMail Tracker: reconnecting… (auto-recovers) ';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'margin-left:8px;cursor:pointer;border:none;background:transparent;font-size:14px;color:#5d4037;';
    x.onclick = () => bar.remove();
    bar.appendChild(x);
    document.documentElement.appendChild(bar);
  } catch (e) { /* ignore */ }
}

let tickTimer = null;
function scheduleTickRefresh() {
  if (tickTimer) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    refreshTicks();
  }, 1200);
}

/* ================= wiring ================= */

function isOurNode(n) {
  if (!n) return false;
  const el = n.nodeType === 1 ? n : n.parentElement;
  return !!(el && el.closest && el.closest('[data-pmt-tick], [data-pmt-stale]'));
}

// Ignore the DOM changes WE make (ticks / banner) — otherwise rendering retriggers rendering.
const observer = new MutationObserver((muts) => {
  let external = false;
  for (const m of muts) {
    const changed = [...m.addedNodes, ...m.removedNodes];
    if (changed.length && changed.every(isOurNode)) continue;
    external = true;
    break;
  }
  if (!external) return;
  scan();
  scheduleTickRefresh();
});
observer.observe(document.body, { childList: true, subtree: true });

loadLocalState();
scan();
window.addEventListener('hashchange', () => setTimeout(refreshTicks, 600));
setInterval(refreshTicks, 30000);
setTimeout(refreshTicks, 2500);
setTimeout(sweepPixels, 1500);

} // __pmtBooted
