// Optional DOM test: needs `npm i -D playwright` + a Chromium. Runs content.js against a mock Gmail page.
// Run: node extension/test.content.playwright.js
const { chromium } = require('playwright');
const fs = require('fs');
const CONTENT = fs.readFileSync('' + require('path').join(__dirname, 'content.js') + '', 'utf8');
let pass = 0;
const ok = (n, c, x) => { if (!c) { console.log('FAIL', n, x === undefined ? '' : x); process.exitCode = 1; } else { pass++; console.log('ok  ', n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMPOSE = (n, to, subj, label = 'Message Body') => `
<div role="dialog" class="AD" id="c${n}"><form>
  <div class="aoD hl"><div class="vR"><span email="${to}" class="vN"></span></div></div>
  <input name="subjectbox" value="${subj}">
  <div class="aoP"><div class="Am Al editable" role="textbox" g_editable="true" aria-label="${label}" contenteditable="true">Hi there<div class="gmail_quote">quoted <a href="https://q.example">q</a></div> <a href="https://example.com/offer">offer</a></div></div>
  <div class="gU"><div class="T-I T-I-atl aoO" role="button" id="send${n}">Send</div></div>
</form></div>`;

const PAGE = (hash = '', body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Inbox (2) - me@gmail.com - Gmail</title></head><body>
<div class="nH"><div class="adn" data-message-id="m1"><span class="gD" email="thread.person@else.com"></span><div class="a3s" id="msgbody">body</div></div></div>
${body}
<table><tbody id="list"></tbody></table><div class="ha"><h2 class="hP">Offer</h2></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const msgs = [];
  let tickTracks = [];
  let ownIds = [];
  let clickTracking = false;
  await page.exposeFunction('__bg', (m) => {
    msgs.push(m);
    if (m.type === 'PMT_PREPARE_TRACK') { ownIds.push(m.id); return { ok: true, trackId: m.id, serverUrl: 'https://px.test' }; }
    if (m.type === 'PMT_GET_TICK_DATA') return { ok: true, tracks: tickTracks };
    return { ok: true };
  });
  await page.addInitScript(() => {
    window.chrome = {
      runtime: { sendMessage: (m) => window.__bg(m), lastError: null },
      storage: { local: { get: (k, cb) => window.__bg({ type: '__get' }).then(() => cb({ ownIds: window.__own || [] })) },
                 onChanged: { addListener: (f) => { window.__onChanged = f; } } },
    };
  });
  await page.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE('', COMPOSE(1, 'client@x.com', 'Offer') + COMPOSE(2, 'other@y.com', 'Second one')) }));
  await page.goto('https://mail.google.com/mail/u/0/#inbox');
  await page.addScriptTag({ content: CONTENT });
  await sleep(500);

  // ---- T1/T2: compose windows ----
  const preps = msgs.filter((m) => m.type === 'PMT_PREPARE_TRACK');
  ok('two composes -> two prepares', preps.length === 2, preps.length);
  const p1 = preps.find((p) => p.subject === 'Offer'), p2 = preps.find((p) => p.subject === 'Second one');
  ok('compose 1 recipients = its own chip only (not thread participants)', p1 && p1.to === 'client@x.com', JSON.stringify(p1));
  ok('compose 2 recipients correct', p2 && p2.to === 'other@y.com');
  ok('sender read from window title', p1.from === 'me@gmail.com');
  ok('each compose has exactly one pixel with its own id', await page.evaluate(([a, b]) => document.querySelectorAll('#c1 img').length === 1 && document.querySelector('#c1 img').src === `https://px.test/px/${a}.gif` && document.querySelector('#c2 img').src === `https://px.test/px/${b}.gif`, [p1.id, p2.id]));
  ok('pixel is a plain 1x1 img (no style/display:none)', await page.evaluate(() => { const i = document.querySelector('#c1 img'); return i.width === 1 && !i.getAttribute('style') && i.getAttribute('border') === '0' && i.getAttribute('alt') === ''; }));

  // Send click on compose 2 commits ONLY compose 2
  await page.click('#send2');
  await sleep(100);
  let commits = msgs.filter((m) => m.type === 'PMT_COMMIT_TRACK');
  ok('send click commits that compose only', commits.length === 1 && commits[0].trackId === p2.id && commits[0].to === 'other@y.com' && commits[0].subject === 'Second one' && !('links' in commits[0]), JSON.stringify(commits));
  // Ctrl+Enter inside compose 1 commits compose 1 (old code committed the FIRST compose for any compose)
  await page.focus('#c1 [g_editable]');
  await page.keyboard.press('Control+Enter');
  await sleep(100);
  commits = msgs.filter((m) => m.type === 'PMT_COMMIT_TRACK');
  ok('ctrl+enter commits the focused compose', commits.length === 2 && commits[1].trackId === p1.id, JSON.stringify(commits.map((c) => c.trackId)));
  await page.click('#send1'); await sleep(50);
  ok('double trigger within 2s not committed twice', msgs.filter((m) => m.type === 'PMT_COMMIT_TRACK').length === 2);
  ok('body links never rewritten', await page.evaluate(() => document.querySelector('#c1 a[href="https://example.com/offer"]') !== null));

  // ---- T3: own-open guard ----
  await page.evaluate((id) => { window.__own = [id]; window.__onChanged({ ownIds: { newValue: [id] } }, 'local'); }, 'trk_OWNOWNOWN001');
  await page.evaluate(() => {
    const mk = (src) => { const i = document.createElement('img'); i.src = src; return i; };
    const body = document.getElementById('msgbody');
    const own = mk('data:image/gif;base64,R0lGODlhAQABAAAAACw=#x'); // placeholder, replaced below via attribute so no network is used
    own.setAttribute('src', 'https://ci3.googleusercontent.com/meips/ABCD=s0-d-e1-ft#https://px.test/px/trk_OWNOWNOWN001.gif');
    own.id = 'own'; body.appendChild(own);
    const enc = mk('about:blank'); enc.setAttribute('src', 'https://ci3.googleusercontent.com/meips/EFGH=s0#https%3A%2F%2Fpx.test%2Fpx%2Ftrk_OWNOWNOWN001.gif'); enc.id = 'enc'; body.appendChild(enc);
    const foreign = mk('about:blank'); foreign.setAttribute('src', 'https://x.googleusercontent.com/meips/Z#https://px.test/px/trk_SOMEONEELSE1.gif'); foreign.id = 'foreign'; body.appendChild(foreign);
    const normal = mk('about:blank'); normal.setAttribute('src', 'https://example.com/logo.png'); normal.id = 'normal'; body.appendChild(normal);
  });
  await sleep(100);
  ok('own pixel removed from sender message view', await page.evaluate(() => !document.getElementById('own') && !document.getElementById('enc')));
  ok('colleague/foreign pixel untouched', await page.evaluate(() => !!document.getElementById('foreign')));
  ok('ordinary images untouched', await page.evaluate(() => !!document.getElementById('normal')));
  const sv = msgs.filter((m) => m.type === 'PMT_SELF_VIEW');
  ok('self-view signalled once for the own pixel (debounced)', sv.length === 1 && sv[0].trackId === 'trk_OWNOWNOWN001', JSON.stringify(sv));
  // src swapped later by Gmail (attribute mutation path)
  await page.evaluate(() => { const i = document.createElement('img'); i.id = 'late'; i.setAttribute('src', 'about:blank'); document.getElementById('msgbody').appendChild(i); });
  await sleep(30);
  await page.evaluate(() => document.getElementById('late').setAttribute('src', 'https://ci3.googleusercontent.com/meips/Q#https://px.test/px/trk_OWNOWNOWN001.gif'));
  await sleep(50);
  ok('pixel re-pointed after insertion is also caught', await page.evaluate(() => !document.getElementById('late')));
  // quoted old pixel inside compose is removed, compose's own pixel stays
  const oldId = 'trk_OLDQUOTED001';
  await page.evaluate(([oldId]) => { window.__own.push(oldId); window.__onChanged({ ownIds: { newValue: window.__own } }, 'local'); const q = document.createElement('img'); q.id = 'quoted'; q.setAttribute('src', 'https://px.test/px/' + oldId + '.gif'); document.querySelector('#c1 .gmail_quote').appendChild(q); }, [oldId]);
  await sleep(60);
  ok('quoted old pixel removed from outgoing reply', await page.evaluate(() => !document.getElementById('quoted')));
  ok("compose's own pixel kept", await page.evaluate(() => document.querySelectorAll('#c1 img').length === 1));

  // ---- T4: ticks in Sent list ----
  const now = Date.now();
  tickTracks = [
    { id: 'trk_T1', subject: 'Offer', recipient: 'client@x.com', sender: 'me@gmail.com', sent: 1, createdAt: new Date(now - 3600e3).toISOString(), rawCount: 0, uniqueCount: 0, lastDetectedAt: null, viaGmail: false },
    { id: 'trk_T2', subject: 'Offer', recipient: 'someone@else.com', sender: 'me@gmail.com', sent: 1, createdAt: new Date(now - 1800e3).toISOString(), rawCount: 2, uniqueCount: 1, lastDetectedAt: new Date(now - 60e3).toISOString(), viaGmail: true },
    { id: 'trk_T3', subject: 'Never sent draft', recipient: '', sender: '', sent: 0, createdAt: new Date(now).toISOString(), rawCount: 0, uniqueCount: 0, lastDetectedAt: null, viaGmail: false },
  ];
  await page.evaluate(() => {
    document.getElementById('list').innerHTML =
      '<tr class="zA"><td class="yX"><span email="client@x.com" class="yP">Client</span></td><td><span class="bog">Offer</span></td><td class="xW"><span title="">1:00 PM</span></td></tr>' +
      '<tr class="zA"><td class="yX"><span email="someone@else.com" class="yP">Else</span></td><td><span class="bog">Offer</span></td><td class="xW"><span title="">1:30 PM</span></td></tr>' +
      '<tr class="zA"><td class="yX"><span email="a@a.com">A</span></td><td><span class="bog">Totally unrelated</span></td><td class="xW"><span>Sep 29</span></td></tr>';
    location.hash = '#sent';
  });
  await sleep(2600);
  const ticks = await page.evaluate(() => Array.from(document.querySelectorAll('tr.zA')).map((r) => { const t = r.querySelector('[data-pmt-tick]'); return t ? t.textContent + ':' + t.getAttribute('data-pmt-tick') : null; }));
  ok('same-subject mails disambiguated by recipient: row1 -> unopened ✓ (T1)', ticks[0] === '✓:trk_T1', JSON.stringify(ticks));
  ok('row2 -> opened ✓✓ (T2)', ticks[1] === '✓✓:trk_T2', JSON.stringify(ticks));
  ok('unrelated row has no tick', ticks[2] === null);
  ok('tooltip shows opens/clicks/via Gmail', await page.evaluate(() => /2 tracking events/.test(document.querySelectorAll('[data-pmt-tick]')[1].title) && /1 estimated unique/.test(document.querySelectorAll('[data-pmt-tick]')[1].title) && /via Gmail/.test(document.querySelectorAll('[data-pmt-tick]')[1].title)));
  ok('tick sits left, before the recipients (first child of td.yX)', await page.evaluate(() => document.querySelector('tr.zA td.yX').firstElementChild.hasAttribute('data-pmt-tick')));

  // mutation-feedback loop check: with nothing changing, tick refreshes must stop
  const c0 = msgs.filter((m) => m.type === 'PMT_GET_TICK_DATA').length;
  await sleep(6000);
  const c1 = msgs.filter((m) => m.type === 'PMT_GET_TICK_DATA').length;
  ok('no render->mutation->render loop (idle for 6s)', c1 - c0 <= 0, `${c1 - c0} extra refreshes`);
  // state change flips ✓ -> ✓✓ and no duplicate ticks
  tickTracks[0].rawCount = 1; tickTracks[0].uniqueCount = 1; tickTracks[0].lastDetectedAt = new Date().toISOString();
  await page.evaluate(() => window.__onChanged({ tracks: { newValue: {} } }, 'local'));
  await sleep(1800);
  const ticks2 = await page.evaluate(() => Array.from(document.querySelectorAll('tr.zA')).map((r) => r.querySelectorAll('[data-pmt-tick]').length + ':' + (r.querySelector('[data-pmt-tick]') || {}).textContent));
  ok('open flips single tick to double, still one tick per row', ticks2[0] === '1:✓✓' && ticks2[1] === '1:✓✓', JSON.stringify(ticks2));

  // pagination hash is a list, not a message view
  await page.evaluate(() => (location.hash = '#sent/p2'));
  await sleep(1900);
  ok('#sent/p2 treated as list (ticks present)', (await page.evaluate(() => document.querySelectorAll('[data-pmt-tick]').length)) >= 2);

  // ---- T5/T7: settings page and non-English UI ----
  const page2 = await ctx.newPage();
  const msgs2 = [];
  await page2.exposeFunction('__bg', (m) => { msgs2.push(m); return m.type === 'PMT_PREPARE_TRACK' ? { ok: true, serverUrl: 'https://px.test' } : { ok: true }; });
  await page2.addInitScript(() => { window.chrome = { runtime: { sendMessage: (m) => window.__bg(m) }, storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener() {} } } }; });
  await page2.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE('', COMPOSE(9, 'bn@x.com', 'বাংলা বিষয়', 'বার্তার মূল অংশ')) }));
  await page2.goto('https://mail.google.com/mail/u/0/#settings/general');
  await page2.addScriptTag({ content: CONTENT });
  await sleep(400);
  ok('settings page (signature editor) is NOT given a pixel', msgs2.filter((m) => m.type === 'PMT_PREPARE_TRACK').length === 0);
  await page2.evaluate(() => (location.hash = '#inbox'));
  await page2.evaluate(() => { document.body.appendChild(document.createElement('div')); }); // any DOM change
  await sleep(500);
  const bn = msgs2.filter((m) => m.type === 'PMT_PREPARE_TRACK');
  ok('works with a non-English Gmail UI (Bengali aria-label)', bn.length === 1 && bn[0].subject === 'বাংলা বিষয়' && bn[0].to === 'bn@x.com', JSON.stringify(bn));

  console.log(process.exitCode ? 'SOME FAILED' : `ALL ${pass} PASSED`);
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
