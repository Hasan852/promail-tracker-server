// content.js — runs inside Gmail.
//
// Part 1: injects the tracking pixel into compose windows.
//   Spam-safety rules:
//   - Exactly ONE <img> tag is added, nothing else in the email body is touched.
//   - Minimal attributes: src + width/height 1 + border 0 + empty alt. No CSS,
//     no display:none (hidden content looks sneaky to filters), no wrapper divs.
//   - Pixel URL is clean HTTPS with no query strings or redirects.
//   - If the server is unreachable or not configured, composing is untouched.
//
// Part 2: WhatsApp-style tick marks in Sent Mail.
//   - ✓  (single, gray) = sent with tracker, not opened yet
//   - ✓✓ (double, blue) = opened / seen (hover for open count + last open time)
//   Ticks are a pure UI overlay in the browser DOM — the email body is never
//   touched by them, so they cannot affect spam placement.

const COMPOSE_SELECTOR = 'div[aria-label="Message Body"]';
const MARK_ATTR = 'data-pmt-tracked';

/* ================= Part 1: pixel insertion ================= */

function getComposeRoot(box) {
  try {
    return box.closest('div.nH') || box.closest('[role="dialog"]') || document;
  } catch (e) {
    return document;
  }
}

function getComposeSubject(box) {
  try {
    // The compose window root usually carries the subject input nearby.
    const root = getComposeRoot(box);
    const input = root.querySelector('input[name="subjectbox"]');
    if (input && input.value) return input.value.trim().slice(0, 300);
  } catch (e) {
    /* ignore */
  }
  return '';
}

// Recipient chips in Gmail compose: <span class="vN" email="to@example.com">
function getComposeRecipients(box) {
  try {
    const root = getComposeRoot(box);
    const chips = root.querySelectorAll('span.vN[email]');
    const emails = [];
    chips.forEach((c) => {
      const em = (c.getAttribute('email') || '').trim();
      if (em && !emails.includes(em)) emails.push(em);
    });
    return emails.slice(0, 3).join(', ');
  } catch (e) {
    return '';
  }
}

// Sender = the Gmail account logged into this Chrome profile.
function getSenderEmail() {
  try {
    const btn = document.querySelector('[aria-label^="Google Account"]');
    if (btn) {
      const m = (btn.getAttribute('aria-label') || '').match(/\(([^)]+@[^)]+)\)/);
      if (m) return m[1];
    }
  } catch (e) {
    /* ignore */
  }
  return '';
}

// Push final compose values to the server. Called on Send click and
// (debounced) while typing, so the stored subject/recipient are never stale.
function syncTrackMeta(box, trackId) {
  try {
    const subject = getComposeSubject(box);
    const to = getComposeRecipients(box);
    const from = getSenderEmail();
    const key = subject + '|' + to + '|' + from;
    if (box.dataset.pmtMetaKey === key) return; // unchanged — skip
    box.dataset.pmtMetaKey = key;
    chrome.runtime.sendMessage({ type: 'PMT_UPDATE_TRACK', trackId, fields: { subject, to, from } });
  } catch (e) {
    /* ignore */
  }
}

function wireSendSync(box, trackId) {
  try {
    const root = getComposeRoot(box);
    // Immediate send button (covers the normal Send click).
    const sendBtn = root.querySelector('.T-I-atl');
    if (sendBtn && !sendBtn.dataset.pmtSyncWired) {
      sendBtn.dataset.pmtSyncWired = '1';
      sendBtn.addEventListener('click', () => syncTrackMeta(box, trackId), true);
    }
    // Typing / recipient changes (covers Schedule-send and late typing):
    // debounced sync while the compose window is alive.
    if (!box.dataset.pmtInputWired) {
      box.dataset.pmtInputWired = '1';
      let timer = null;
      const debounced = () => {
        clearTimeout(timer);
        timer = setTimeout(() => syncTrackMeta(box, trackId), 2500);
      };
      root.addEventListener('input', debounced, true);
    }
  } catch (e) {
    /* ignore */
  }
}

function attachPixel(box) {
  if (box.hasAttribute(MARK_ATTR)) return;
  box.setAttribute(MARK_ATTR, 'pending');

  const subject = getComposeSubject(box);
  const to = getComposeRecipients(box);
  const from = getSenderEmail();

  chrome.runtime.sendMessage({ type: 'PMT_CREATE_TRACK', subject, to, from }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      // Server not configured / unreachable: leave the email 100% untouched.
      box.removeAttribute(MARK_ATTR);
      return;
    }
    try {
      const img = document.createElement('img');
      img.setAttribute('src', resp.serverUrl.replace(/\/+$/, '') + '/px/' + resp.trackId + '.gif');
      img.setAttribute('width', '1');
      img.setAttribute('height', '1');
      img.setAttribute('border', '0');
      img.setAttribute('alt', '');
      // No display:none, no extra styling — a plain 1px image is the most
      // filter-friendly form a tracking pixel can take.
      box.appendChild(img);
      box.setAttribute(MARK_ATTR, resp.trackId);
      wireSendSync(box, resp.trackId);
    } catch (e) {
      box.removeAttribute(MARK_ATTR);
    }
  });
}

function scan() {
  document.querySelectorAll(COMPOSE_SELECTOR).forEach(attachPixel);
}

/* ================= Part 2: tick marks ================= */

const TICK_ROW_ATTR = 'data-pmt-tick-row';
const TICK_VIEW_ATTR = 'data-pmt-tick-view';

function normSubject(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
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
  const cands = tracks.filter((t) => normSubject(t.subject) === ns);
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
  if (t.openCount > 0) {
    let s = 'Seen — ' + t.openCount + ' open' + (t.openCount === 1 ? '' : 's');
    if (t.lastOpenedAt) s += ' · last opened ' + fmtTickTime(t.lastOpenedAt);
    if (t.viaGmail) s += ' (via Gmail)';
    return s;
  }
  return 'Sent — not opened yet';
}

function makeTickEl(t) {
  const seen = t.openCount > 0;
  const el = document.createElement('span');
  el.setAttribute('data-pmt-tick', t.id);
  el.textContent = seen ? '✓✓' : '✓';
  el.title = tickTitle(t);
  el.style.cssText =
    'display:inline-block;margin-left:6px;font-size:13px;font-weight:700;' +
    'line-height:1;vertical-align:baseline;cursor:default;' +
    (seen ? 'color:#00b578;' : 'color:#9aa0a6;');
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
function refreshSentList(tracks) {
  const rows = document.querySelectorAll('tr.zA');
  rows.forEach((row) => {
    try {
      const subjEl = row.querySelector('span.bog');
      if (!subjEl || !subjEl.parentElement) return;
      const dateEl = row.querySelector('td.xW span');
      const t = findTrack(tracks, subjEl.textContent, dateEl ? parseGmailDate(dateEl.textContent) : null);
      const prev = row.querySelector('[data-pmt-tick]');
      if (!t) {
        if (prev) prev.remove();
        row.removeAttribute(TICK_ROW_ATTR);
        return;
      }
      if (prev) {
        // Update in place — the tick may have flipped from ✓ to ✓✓.
        prev.replaceWith(makeTickEl(t));
      } else {
        subjEl.parentElement.appendChild(makeTickEl(t));
      }
      row.setAttribute(TICK_ROW_ATTR, t.id);
    } catch (e) {
      /* never break Gmail */
    }
  });
}

// Tick in the header when reading a sent email.
function refreshSentEmailView(tracks) {
  const header = document.querySelector('div.ha');
  if (!header) return;
  try {
    const h2 = header.querySelector('h2.hP');
    if (!h2 || !h2.parentElement) return;
    const t = findTrack(tracks, h2.textContent, null);
    const prev = header.querySelector('[data-pmt-tick]');
    if (!t) {
      if (prev) prev.remove();
      header.removeAttribute(TICK_VIEW_ATTR);
      return;
    }
    if (prev) {
      prev.replaceWith(makeTickEl(t));
    } else {
      h2.parentElement.appendChild(makeTickEl(t));
    }
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
    return; // extension reloaded / context invalidated — stay quiet
  }
  if (!resp || !resp.ok || !Array.isArray(resp.tracks)) return;
  try {
    if (isSentListView()) refreshSentList(resp.tracks);
    else if (isSentEmailView()) refreshSentEmailView(resp.tracks);
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

/* ================= wiring ================= */

const observer = new MutationObserver(() => {
  scan();
  scheduleTickRefresh();
});
observer.observe(document.body, { childList: true, subtree: true });
scan();

window.addEventListener('hashchange', () => setTimeout(refreshTicks, 600));
setInterval(refreshTicks, 30000);
setTimeout(refreshTicks, 2500);
