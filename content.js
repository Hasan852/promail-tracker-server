// v1.7.0: re-injection guard — background.js re-injects this file into open
// Gmail tabs after install/startup (no more F5 needed). The guard makes
// re-execution safe: top-level const/let live inside this block scope.
if (!window.__pmtBooted) {
window.__pmtBooted = true;
// content.js — runs inside Gmail.
//
// Part 1: injects the tracking pixel into compose windows.
//   Spam-safety rules:
//   - Exactly ONE <img> tag is added, nothing else in the email body is touched.
//   - Minimal attributes: src + width/height 1 + border 0 + empty alt. No CSS,
//     no display:none (hidden content can be less transparent to filters), no wrapper divs.
//   - Pixel URL is clean HTTPS with no query strings or redirects.
//   - If the server is unreachable or not configured, composing is untouched.
//
// Part 2: detection tick marks in Sent Mail (v2.2.0 terminology).
//   - ✓  (single, gray) = sent, no detection yet
//   - ✓✓ (double, green) = detection received (image loaded; see tooltip)
//   Placed Mailsuite-style: LEFT, between the star and "To:".
//   Ticks are a pure UI overlay in the browser DOM — the email body is never
//   touched by them, so they cannot affect spam placement.

/* ============ Centralized Gmail selector layer (v2.2.0) ============
 * Gmail changes its DOM without notice. EVERY Gmail selector lives in this
 * one object — no other code in this file may hard-code a Gmail class or
 * attribute. Entries list fallbacks in priority order; the qsaFirst() helper
 * tries them in order and returns the first hit.
 *
 * Strategy preference: stable attributes (role, name) first, then single CSS
 * classes, then aria-label/title/text matches LAST because those are
 * locale-dependent (a non-English Gmail UI changes them).
 */
const SELECTORS = {
  composeBody: ['div[aria-label="Message Body"]'],
  composeRoot: ['div.nH', '[role="dialog"]'],
  sendButton: [
    '.T-I-atl',                                  // classic Gmail send-button class
    '[role="button"][aria-label^="Send"]',        // aria-label (English UI)
    '[aria-label^="Send"][role="button"]',
    'div[role="button"][data-tooltip^="Send"]',
  ],
  sendButtonText: /^send$/i,                     // last resort: English button text
  subjectInput: ['input[name="subjectbox"]'],
  recipientChip: ['[email]'],
  accountButton: ['[aria-label^="Google Account"]', '[aria-label*="@"]'],
  sentRow: ['tr.zA'],
  sentRowSubject: ['span.bog'],
  sentRowDate: ['td.xW span'],
  sentRowPeople: ['td.yX'],
  messageViewHeader: ['div.ha'],
  messageViewSubject: ['h2.hP'],
  messageBodyImg: ['.a3s img[src]'],
  dialog: ['[role="dialog"]'],
};

// First matching element for a selector list, or null. Never throws.
function qsaFirst(root, selectors) {
  try {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
  } catch (e) { /* never break Gmail */ }
  return null;
}

function qsaAll(root, selectors) {
  const out = [];
  try {
    for (const sel of selectors) {
      root.querySelectorAll(sel).forEach((el) => { if (!out.includes(el)) out.push(el); });
    }
  } catch (e) { /* never break Gmail */ }
  return out;
}

// Send-button lookup with fallback chain: class -> aria-label variants ->
// English button-text match. Returns null when nothing matches (callers must
// tolerate that: Sent-list fallback still catches the send).
function findSendButton(root) {
  const el = qsaFirst(root, SELECTORS.sendButton);
  if (el) return el;
  try {
    const btns = root.querySelectorAll('[role="button"]');
    for (const b of btns) {
      if (SELECTORS.sendButtonText.test((b.textContent || '').trim())) return b;
    }
  } catch (e) { /* never break Gmail */ }
  return null;
}

const MARK_ATTR = 'data-pmt-tracked';

/* ================= Part 1: pixel insertion ================= */

function getComposeRoot(box) {
  try {
    return qsaFirst(box, SELECTORS.composeRoot) || document;
  } catch (e) {
    return document;
  }
}

function getComposeSubject(box) {
  try {
    // The compose window root usually carries the subject input nearby.
    const root = getComposeRoot(box);
    const input = qsaFirst(root, SELECTORS.subjectInput);
    if (input && input.value) return input.value.trim().slice(0, 300);
  } catch (e) {
    /* ignore */
  }
  return '';
}

// Recipient chips in Gmail compose
function getComposeRecipients(box) {
  try {
    const root = getComposeRoot(box);
    const emails = [];
    const sender = getSenderEmail().trim().toLowerCase();
    // জিমেইলের নতুন ও পুরোনো সব ডিজাইনের জন্য
    qsaAll(root, SELECTORS.recipientChip).forEach((c) => {
      const em = (c.getAttribute('email') || '').trim();
      // Gmail's compose subtree can include the active From account too.
      // The tracker list is recipient-only, so never treat that as a recipient.
      if (em && em.includes('@') && em.toLowerCase() !== sender && !emails.includes(em)) emails.push(em);
    });
    return emails.slice(0, 3).join(', ');
  } catch (e) {
    return '';
  }
}

// Sender = the Gmail account logged into this Chrome profile.
function getSenderEmail() {
  try {
    // যেকোনো ভাষার জিমেইলের জন্য (ব্রাউজার টাইটেল থেকে ইমেইল ধরা)
    const titleMatch = (document.title || '').match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/);
    if (titleMatch) return titleMatch[1];

    const btn = qsaFirst(document, SELECTORS.accountButton);
    if (btn) {
      const m = (btn.getAttribute('aria-label') || '').match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/);
      if (m) return m[1];
    }
  } catch (e) {
    /* ignore */
  }
  return '';
}

// Tracks whose compose window is open but which haven't been sent yet.
// A track leaves this set when the mail is actually sent (Send click,
// Ctrl/Cmd+Enter, or the row appearing in Sent Mail). Pixel hits are ignored
// server-side until then, so opening+closing compose never fakes an "open".
const sentMarkedIds = new Set(); // locally committed ids (avoid double commit)

// v1.7.0 (pure): client-generated track IDs — the pixel is injected instantly
// at compose time without waiting for a server round-trip.
function newTrackId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let s = 'trk_';
  for (let i = 0; i < 12; i++) s += chars[buf[i] % 62];
  return s;
}

// Local-only metadata sync (debounced): keeps the freshest subject/recipients
// on the LOCAL record, so even the schedule-send fallback (compose already
// gone) commits real metadata instead of "(no subject)".
function touchTrackMeta(box, trackId) {
  try {
    const subject = getComposeSubject(box);
    const to = getComposeRecipients(box);
    const from = getSenderEmail();
    // v1.4: when Gmail strips To chips on Send click, the stored recipient is preserved.
    const finalTo = to || box.dataset.pmtLastTo || '';
    if (finalTo) box.dataset.pmtLastTo = finalTo;
    if (subject) box.dataset.pmtLastSubj = subject;
    chrome.runtime.sendMessage({ type: 'PMT_TOUCH_TRACK', trackId, subject, to: finalTo, from });
  } catch (e) {
    /* ignore */
  }
}

// Send-time commit: the mail is really going out — the server track is
// created NOW with the client-generated id and final metadata. The popup
// therefore can never show a track for an unsent mail.
function commitById(box, trackId) {
  if (!trackId || sentMarkedIds.has(trackId)) return;
  sentMarkedIds.add(trackId);
  try {
    const subject = getComposeSubject(box) || box.dataset.pmtLastSubj || '';
    const to = getComposeRecipients(box) || box.dataset.pmtLastTo || '';
    const from = getSenderEmail();
    chrome.runtime.sendMessage({ type: 'PMT_COMMIT_TRACK', trackId, subject, to, from }, () => {
      if (chrome.runtime.lastError) showStaleBanner();
    });
  } catch (e) {
    /* never break Gmail send */
  }
}

// Fallback send detection: a Sent-list row matched an uncommitted local
// track — the mail WAS sent (covers schedule-send and missed send clicks).
function fallbackCommit(t) {
  if (!t || !t.id || sentMarkedIds.has(t.id)) return;
  sentMarkedIds.add(t.id);
  try {
    chrome.runtime.sendMessage(
      { type: 'PMT_COMMIT_TRACK', trackId: t.id, subject: t.subject || '', to: t.recipient || '', from: t.sender || '' },
      () => { if (chrome.runtime.lastError) showStaleBanner(); }
    );
  } catch (e) {
    /* ignore */
  }
}

function wireSendSync(box, trackId) {
  try {
    const root = getComposeRoot(box);
    // Immediate send button (covers the normal Send click). Fallback chain in
    // findSendButton(): class -> aria-label -> button text.
    const sendBtn = findSendButton(root);
    if (sendBtn && !sendBtn.dataset.pmtSyncWired) {
      sendBtn.dataset.pmtSyncWired = '1';
      sendBtn.addEventListener('click', () => commitById(box, trackId), true);
    }
    // Ctrl/Cmd+Enter keyboard send — no button click happens here.
    if (!root.dataset.pmtKeyWired) {
      root.dataset.pmtKeyWired = '1';
      root.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) {
          commitById(box, trackId);
        }
      }, true);
    }
    // Recipient/subject changes: keep LOCAL metadata fresh (the schedule-send
    // fallback commits from the local record after the compose is gone).
    if (!box.dataset.pmtInputWired) {
      box.dataset.pmtInputWired = '1';
      let timer = null;
      root.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => touchTrackMeta(box, trackId), 2500);
      }, true);
    }
  } catch (e) {
    /* ignore */
  }
}

function attachPixel(box) {
  if (box.hasAttribute(MARK_ATTR)) return;
  box.setAttribute(MARK_ATTR, 'pending');

  // v1.7.0: the track id is generated HERE, instantly — no server round-trip.
  // The pixel goes in immediately; the server learns about the track at send
  // time (commitById). A slow/napping server can never delay composing or
  // eat the pixel anymore.
  const trackId = newTrackId();
  const subject = getComposeSubject(box);
  const to = getComposeRecipients(box);
  const from = getSenderEmail();

  // NOTE: this sendMessage MUST stay inside try/catch. If the extension is
  // reloaded/updated while this Gmail tab is open, the old content script
  // keeps running but its extension context is dead — the call throws
  // "Extension context invalidated" synchronously (lastError never fires).
  // We drop the pending mark so the re-injected script retries, and show the
  // reconnecting banner. Gmail compose must never break because of this.
  try {
    chrome.runtime.sendMessage({ type: 'PMT_PREPARE_TRACK', id: trackId, subject, to, from }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        box.removeAttribute(MARK_ATTR);
        return;
      }
      try {
        const img = document.createElement('img');
        img.setAttribute('src', resp.serverUrl.replace(/\/+$/, '') + '/px/' + trackId + '.gif');
        img.setAttribute('width', '1');
        img.setAttribute('height', '1');
        img.setAttribute('border', '0');
        img.setAttribute('alt', '');
        // No display:none, no extra styling — a plain 1px image is the most
        // filter-friendly form a tracking pixel can take.
        box.appendChild(img);
        box.setAttribute(MARK_ATTR, trackId);
        wireSendSync(box, trackId);
      } catch (e) {
        box.removeAttribute(MARK_ATTR);
      }
    });
  } catch (e) {
    box.removeAttribute(MARK_ATTR);
    showStaleBanner();
  }
}

function scan() {
  qsaAll(document, SELECTORS.composeBody).forEach(attachPixel);
}

/* ================= Part 2: tick marks ================= */

const TICK_ROW_ATTR = 'data-pmt-tick-row';
const TICK_VIEW_ATTR = 'data-pmt-tick-view';

function normSubject(s) {
  // v1.6.1: strip Re:/Fw:/Fwd: prefixes (possibly nested) so a reply's
  // "Re: College program" matches the Sent-list thread row "College program".
  let n = (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  let prev;
  do {
    prev = n;
    n = n.replace(/^(re|fwd?)\s*:\s*/, '');
  } while (n !== prev);
  return n;
}

// v1.6.1: thread rows show the thread subject ("College program - yes On
// Thu,") while the track holds the message subject ("College program").
// A prefix match (short >= 4 chars) counts, on top of exact equality.
function subjectsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length >= 4 && long.startsWith(short);
}

function fmtTickTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return iso || '';
  }
}

// Parse the date text Gmail shows in the Sent list ("4:53 PM", "Sep 29", ...)
// into a Date. Best effort — returns null when it cannot tell.
function parseGmailDate(txt) {
  txt = (txt || '').trim();
  if (!txt) return null;
  const now = new Date();

  // "4:53 PM" or "16:53" -> today at that time
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

  // "Sep 29" -> that date this year (last year if it would be in the future)
  m = txt.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (m) {
    const d = new Date(m[1] + ' ' + m[2] + ', ' + now.getFullYear());
    if (isNaN(d.getTime())) return null;
    if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
    return d;
  }

  // "2026/09/29" or "2026-09-29"
  m = txt.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));

  return null;
}

// Match a Gmail row/view subject to one of our tracks.
// Same-subject duplicates are disambiguated by the row date (12h window);
// without a usable date hint the most recent track wins.
function findTrack(tracks, subject, dateHint) {
  const ns = normSubject(subject);
  if (!ns || !Array.isArray(tracks)) return null;
  const cands = tracks.filter((t) => subjectsMatch(normSubject(t.subject), ns));
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0];
  if (!dateHint || isNaN(dateHint.getTime())) {
    return cands.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[cands.length - 1];
  }
  let best = null;
  let bestDiff = Infinity;
  for (const t of cands) {
    const c = new Date(t.createdAt).getTime();
    if (isNaN(c)) continue;
    const diff = Math.abs(c - dateHint.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  return best && bestDiff < 12 * 3600 * 1000 ? best : null;
}

function tickTitle(t) {
  const raw = t.rawCount || 0;
  const n = t.uniqueCount || 0;
  if (raw > 0) {
    let s = 'Detected — ' + n + ' estimated unique detection' + (n === 1 ? '' : 's') +
      ' (' + raw + ' tracking event' + (raw === 1 ? '' : 's') + ')';
    if (t.lastDetectedAt) s += ' · last detected ' + fmtTickTime(t.lastDetectedAt);
    if (t.viaGmail) s += ' (via Gmail)';
    s += '. Tracking detects image loading; it cannot prove the message was read.';
    return s;
  }
  return 'Sent — no detection yet';
}

function makeTickEl(t) {
  const detected = (t.rawCount || 0) > 0;
  const el = document.createElement('span');
  el.setAttribute('data-pmt-tick', t.id);
  el.textContent = detected ? '✓✓' : '✓';
  el.title = tickTitle(t);
  el.style.cssText =
    'display:inline-block;margin:0 6px 0 2px;font-size:13px;font-weight:700;' +
    'line-height:1;vertical-align:baseline;cursor:default;' +
    (detected ? 'color:#00b578;' : 'color:#9aa0a6;');
  return el;
}

function isSentListView() {
  const h = location.hash || '';
  return h === '#sent' || h.indexOf('#sent?') === 0;
}

function isSentEmailView() {
  return /^#sent\//.test(location.hash || '');
}

// Ticks next to each tracked email in the Sent Mail list.
// v1.7.0: destroy + re-render every pass (Mailsuite technique) — stale or
// duplicated ticks are impossible by construction.
function refreshSentList(tracks) {
  try {
    document.querySelectorAll('[data-pmt-tick]').forEach((el) => el.remove());
    document.querySelectorAll('tr.zA').forEach((row) => row.removeAttribute(TICK_ROW_ATTR));
  } catch (e) { /* never break Gmail */ }
  const rows = qsaAll(document, SELECTORS.sentRow);
  rows.forEach((row) => {
    try {
      const subjEl = qsaFirst(row, SELECTORS.sentRowSubject);
      if (!subjEl || !subjEl.parentElement) return;
      const dateEl = qsaFirst(row, SELECTORS.sentRowDate);
      const t = findTrack(tracks, subjEl.textContent, dateEl ? parseGmailDate(dateEl.textContent) : null);
      if (!t) return;
      // Fallback send detection: the row is in Sent Mail, so this mail was
      // really sent (covers schedule-send and any missed send clicks).
      if (t.sent === 0) fallbackCommit(t);
      // Mailsuite-style placement (v1.6): tick sits LEFT, right before
      // "To:" inside td.yX (between the star and the recipient).
      const peopleCell = qsaFirst(row, SELECTORS.sentRowPeople);
      if (peopleCell) peopleCell.insertBefore(makeTickEl(t), peopleCell.firstChild);
      else subjEl.parentElement.appendChild(makeTickEl(t)); // fallback
      row.setAttribute(TICK_ROW_ATTR, t.id);
    } catch (e) {
      /* never break Gmail */
    }
  });
}

// Tick in the header when reading a sent email.
function refreshSentEmailView(tracks) {
  const header = qsaFirst(document, SELECTORS.messageViewHeader);
  if (!header) return;
  try {
    header.querySelectorAll('[data-pmt-tick]').forEach((el) => el.remove());
    header.removeAttribute(TICK_VIEW_ATTR);
    const h2 = qsaFirst(header, SELECTORS.messageViewSubject);
    if (!h2 || !h2.parentElement) return;
    const t = findTrack(tracks, h2.textContent, null);
    if (!t) return;
    h2.parentElement.appendChild(makeTickEl(t));
    header.setAttribute(TICK_VIEW_ATTR, t.id);
  } catch (e) {
    /* never break Gmail */
  }
}

async function refreshTicks() {
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'PMT_GET_TICK_DATA' });
  } catch (e) {
    // Brief disconnect (e.g. extension updating right now) — the banner
    // explains, and auto re-inject heals the tab without any F5.
    showStaleBanner();
    return;
  }
  if (!resp || !resp.ok || !Array.isArray(resp.tracks)) return;
  try {
    // Connection healthy again — remove any stale banner.
    const stale = document.querySelector('[data-pmt-stale]');
    if (stale) stale.remove();
    if (isSentListView()) refreshSentList(resp.tracks);
    else if (isSentEmailView()) refreshSentEmailView(resp.tracks);
  } catch (e) {
    /* never break Gmail */
  }
}

// v1.7.0 — one-time banner when this tab's content script briefly loses its
// connection (e.g. right after an extension update, before auto re-inject
// heals it). Auto-removed on the next successful refresh. Pure DOM, never
// touches email content.
let staleBannerShown = false;
function showStaleBanner() {
  if (staleBannerShown) return;
  staleBannerShown = true;
  try {
    const bar = document.createElement('div');
    bar.setAttribute('data-pmt-stale', '1');
    bar.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:999999;background:#fff8e1;color:#5d4037;' +
      'border:1px solid #e6a500;border-radius:8px;padding:8px 12px;font-size:13px;' +
      'font-family:Roboto,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    bar.textContent = 'ProMail Tracker: reconnecting… (auto-recovers, no action needed) ';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'margin-left:8px;cursor:pointer;border:none;background:transparent;font-size:14px;color:#5d4037;';
    x.onclick = () => bar.remove();
    bar.appendChild(x);
    document.documentElement.appendChild(bar);
  } catch (e) {
    /* never break Gmail */
  }
}

let tickTimer = null;
function scheduleTickRefresh() {
  if (tickTimer) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    refreshTicks();
  }, 1200);
}

/* ================= Part 3: self-view detection (v1.4) =================
 *
 * The sender opening their own sent mail must NOT count as an "open" —
 * only the receiver's opens count. Gmail renders message bodies with class
 * "a3s". We signal the server when one of our tracking pixels actually
 * LOADS inside a message view (img load event, or img.complete for pixels
 * that finished before we saw them). Signalling on load — not on DOM
 * insert — keeps the signal tightly correlated with the pixel hit the
 * server logs (~1s apart), and also covers lazy-loaded images (long mails:
 * the pixel loads only when the sender scrolls to the bottom) and Gmail's
 * "ask before displaying images" setting (no load -> no hit -> nothing to
 * suppress). The server then ignores pixel hits inside the suppression
 * window (no count, no notification).
 *
 * The pixel src may be direct (our server URL) or Gmail-proxied
 * (googleusercontent.com/proxy/<hash>#<original-url>) — the regex matches
 * the /px/<id>.gif part in either form. Compose windows are excluded
 * (they are dialogs / lack .a3s), so typing an email never signals.
 */

function extractPixelTrackId(src) {
  try {
    // জিমেইল ইউআরএল এনকোড করে দিলে সেটা ঠিক করার জন্য decodeURIComponent যোগ করা হলো
    const decodedSrc = decodeURIComponent(src || '');
    const m = String(decodedSrc).match(/\/px\/(trk_[A-Za-z0-9]+)\.gif/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// trackId -> timestamp of last signal (debounce: one signal per 60s per mail)
const selfViewSentAt = {};
// pixel imgs already wired with a load listener (WeakSet: no leaks)
const selfViewWired = new WeakSet();

function signalSelfView(id) {
  const now = Date.now();
  if (selfViewSentAt[id] && now - selfViewSentAt[id] < 60000) return;
  selfViewSentAt[id] = now;
  try {
    chrome.runtime.sendMessage({ type: 'PMT_SELF_VIEW', trackId: id });
  } catch (e) {
    /* never break Gmail */
  }
}

function scanSelfViews() {
  let imgs;
  try {
    imgs = qsaAll(document, SELECTORS.messageBodyImg);
  } catch (e) {
    return;
  }
  imgs.forEach((img) => {
    try {
      if (img.closest(SELECTORS.dialog[0])) return; // compose, not a message view
      const id = extractPixelTrackId(img.getAttribute('src'));
      if (!id) return;
      if (img.complete) {
        signalSelfView(id); // already loaded (possibly from cache)
      } else if (!selfViewWired.has(img)) {
        selfViewWired.add(img);
        img.addEventListener('load', () => signalSelfView(id), { once: true });
      }
    } catch (e) {
      /* never break Gmail */
    }
  });
}

let selfViewLastScan = 0;
function scheduleSelfViewScan() {
  const now = Date.now();
  if (now - selfViewLastScan < 2000) return; // throttle: DOM mutates constantly
  selfViewLastScan = now;
  try {
    scanSelfViews();
  } catch (e) {
    /* never break Gmail */
  }
}

/* ================= wiring ================= */

const observer = new MutationObserver(() => {
  scan();
  scheduleTickRefresh();
  scheduleSelfViewScan();
});
observer.observe(document.body, { childList: true, subtree: true });
scan();

window.addEventListener('hashchange', () => {
  setTimeout(refreshTicks, 600);
  setTimeout(scheduleSelfViewScan, 800);
});
setInterval(refreshTicks, 30000);
setTimeout(refreshTicks, 2500);
setTimeout(scheduleSelfViewScan, 3000);


} // __pmtBooted
