'use strict';
// MacUI-N3 2.0.9.22 witness: the QC-UI items on the r1.5.4 / r1.5.5 fixtures (MacArthur 11/04, after the .21 ship).
//   (P) Day P&L header during a TIDE trade: "Day P&L (closed) $x · TIDE open +$y (bot|calc)" (qc154-pos = calc, qc154-pos2 = bot 135)
//   (C) TIDE card 4H CONTROL since = tide.board.control.since (07:40), not the row's write time (07:31); no "failed break above the 4H open" without a zone: "trap · extreme 28,829.50"
//   (R) LAST REFUSAL line: "08:28 S279 London High · waveBias wavePeakBias 0.0842 < 0.2" (+ "waived control4h->bias" on the r1.5.5 row); tape ○ / ⊘ detail with the zone
//   (N) Now under TIDE live: #wnt-card and the Position card's old flat reasons hidden, copied under "Old levels model (not trading)"; no "Score below threshold" visible
//   (G) 120-row ring: the note and the board control when the control_form row is gone
//   node qc-20922.test.cjs   (cwd = the harness folder; MACUI_V2 = the candidate page; one browser; nice 19 by the caller)
const path = require('path'); const { chromium } = require('playwright'), { startServer, openPhone, meta } = require(path.resolve('lib.cjs'));
let pass = 0, fail = 0; const ok = (c, n, g) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' got: ' + String(g).slice(0, 700)}`); };
async function withState(b, st, fn) { const m = meta(st), srv = await startServer(st, 'mn22', m.clock); try { const o = await openPhone(b, { port: srv.port, v: '2', clock: m.clock }); try { await fn(o.page, o.errors); } finally { await o.ctx.close(); } } finally { srv.stop(); } }
const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return 'missing'; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.height > 0 ? 'visible' : 'hidden'; }, sel);
const now = async page => page.evaluate(async () => { switchView('dashboard'); macui.feat20918.update(); macui.feat20919.update(); macui.feat20920.update(); await new Promise(r => setTimeout(r, 300));
  const q = s => (document.querySelector(s) || {}).textContent || '', ctl = [...document.querySelectorAll('.fx18-ctl')].map(e => e.textContent.replace(/\s+/g, ' ').trim());
  const dets = []; for (const h of document.querySelectorAll('.fx20-hit')) { h.dispatchEvent(new MouseEvent('click', { bubbles: true })); dets.push(q('.fx20-det')); }
  return { ctl, ref: q('.fx22-ref').replace(/\s+/g, ' ').trim(), ring: q('.fx22-ring'), pnlSub: q('#pnl-sub'), pnlVal: q('#pnl-value'), deck: q('#fx11-deck'), oldb: q('#fx11-deck .fx20-oldb').replace(/\s+/g, ' '), wntAttr: (document.getElementById('wnt-card') || { getAttribute: () => null }).getAttribute('data-fx22'),
    posBody: q('#position-body').replace(/\s+/g, ' '), nowText: (document.getElementById('view-dashboard') || document.body).innerText.replace(/\s+/g, ' '), dets, glyphs: [...document.querySelectorAll('#fx17-hour .fx20-box text')].map(t => t.textContent).join(''), title: q('#fx18-card .fx18-t') }; });
(async () => { const b = await chromium.launch();
  try {
    await withState(b, 'qc154-flat', async (page, errors) => {
      const r = await now(page);
      ok(r.ctl.some(t => /4H CONTROL ▼ SELLERS · since 07:40/.test(t)), 'C1 4H CONTROL since = tide.board.control.since 07:40 (the row was written 07:31)', JSON.stringify(r.ctl));
      ok(r.ctl.some(t => /trap · extreme 28,829\.50/.test(t)) && !r.ctl.some(t => /failed break above the 4H open/.test(t)), 'C2 no invented zone: "trap · extreme 28,829.50"', JSON.stringify(r.ctl));
      ok(/^LAST REFUSAL 08:28 S279 London High · waveBias wavePeakBias 0\.0842 < 0\.2$/.test(r.ref), 'R1 LAST REFUSAL line: time, setup, zone from its setup_arm, gate value < limit', r.ref);
      ok(r.dets.some(t => /08:28 PT · no trade · London High · waveBias wavePeakBias 0\.0842 < 0\.2/.test(t)), 'R2 tape ○ detail borrows the zone and the gate text', JSON.stringify(r.dets));
      ok(r.wntAttr === 'old' && (await vis(page, '#wnt-card')) === 'hidden' && /Old checklist: .*\(not trading\)/.test(r.oldb), 'N1 the old "Why no trade right now" card is hidden and copied under "Old levels model (not trading)"', r.wntAttr + ' | ' + r.oldb.slice(0, 200));
      ok((await vis(page, '#position-body .flat-reasons')) === 'hidden' && /Old model, flat reasons/.test(r.oldb) && /TIDE live: the reasons are TIDE/.test(r.posBody), 'N2 the Position card\'s old flat reasons are hidden with a TIDE note; copied under the collapse', r.posBody.slice(0, 300));
      ok(!/Score below threshold/.test(r.nowText) && !/No qualifying signal/.test(r.nowText), 'N3 no old-model reason reads on Now while TIDE is live (collapsed text not rendered)', r.nowText.match(/.{0,80}(Score below|No qualifying).{0,80}/) || 'none');
      ok(!/TIDE open/.test(r.pnlSub), 'P0 flat: the page\'s own Day P&L line', r.pnlSub);
      ok(!r.ring, 'G0 13 rows: no ring note', r.ring);
      ok(!errors.length, 'E1 no page errors (qc154-flat)', errors.join(' | '));
    });
    await withState(b, 'qc155-flat', async (page, errors) => {
      const r = await now(page);
      ok(/waived control4h(->|→)bias/.test(r.ref), 'R3 r1.5.5 grade row: the waived list on the LAST REFUSAL line', r.ref);
      ok(r.dets.some(t => /08:28 PT · refused · London High · REFUSED: waveBias - slot released/.test(t)), 'R4 r1.5.5 REFUSED cancel: "refused · <zone> · <why>" detail (its ⊘ glyph leads only outside a cluster)', JSON.stringify(r.dets) + ' ' + r.glyphs);
      ok(!errors.length, 'E2 no page errors (qc155-flat)', errors.join(' | '));
    });
    await withState(b, 'qc155-ring', async (page, errors) => {
      const r = await now(page);
      ok(/journal rows 120\/120 · earliest dropped/.test(r.ring), 'G1 the 120-row ring note', r.ring);
      ok(r.ctl.some(t => /4H CONTROL ▼ SELLERS · since 07:40.*from tide\.board/.test(t)), 'G2 control_form row gone: the 4H control from tide.board.control', JSON.stringify(r.ctl));
      ok(!errors.length, 'E3 no page errors (qc155-ring)', errors.join(' | '));
    });
    await withState(b, 'qc156-htf', async (page, errors) => {
      const r = await now(page);
      const htfl = await page.evaluate(() => ({ line: ((document.querySelector('.fx22-htfl') || {}).textContent || '').replace(/\s+/g, ' ').trim(), stage: ((document.querySelector('.fx18-stage') || {}).textContent || '').replace(/\s+/g, ' '), tags: [...document.querySelectorAll('.fx22-htf')].map(e => e.getAttribute('data-htf') + ':' + e.textContent.trim()), banner: (document.getElementById('g-banner') || {}).textContent || '', lv: ((document.getElementById('fx19-lv') || {}).textContent || '').replace(/\s+/g, ' ') }));
      ok(/^HTF ↓ · prior 4H ↓ \(LL\) · 4H open below · day open below$/.test(htfl.line), 'H1 TIDE card HTF line from tide.board.htf', htfl.line);
      ok(/HTF ↓/.test(htfl.banner) && /ARMED · 4H ▼ sellers · HTF ↓/.test(htfl.banner.replace(/\s+/g, ' ')), 'H2 header ends with "HTF ↓"', htfl.banner.replace(/\s+/g, ' '));
      ok(/WITH HTF ↓/.test(htfl.stage) && htfl.tags.some(t => t === 'with:WITH HTF ↓'), 'H3 the armed setup S281 is tagged WITH HTF ↓ (green) on the TIDE card', htfl.stage + ' ' + JSON.stringify(htfl.tags));
      ok(/1H Open 28,628\.25.*WITH HTF ↓/.test(htfl.lv) || /NEXT TO ACT.*WITH HTF ↓/.test(htfl.lv), 'H4 Levels Now: the armed 1H Open carries the tag', htfl.lv.slice(0, 300));
      ok(r.dets.some(t => /armed · 1H Open 28,628\.25 · waiting for the retest · WITH HTF ↓/.test(t)), 'H5 tape tick detail carries the tag', JSON.stringify(r.dets));
      const A = await page.evaluate(async () => { lastSnapForPoll.tide.board.htf.dir = 1; lastSnapForPoll.tide.rows.forEach(x => { if (x.htf) { x.htf = x.dir === 1 ? 'with' : 'against'; x.htfDir = 1; } }); macui.feat20918.update(); macui.feat20919.update(); await new Promise(r => setTimeout(r, 200)); return { tags: [...document.querySelectorAll('.fx22-htf')].map(e => e.getAttribute('data-htf') + ':' + e.textContent.trim()), banner: (document.getElementById('g-banner') || {}).textContent.replace(/\s+/g, ' ') }; });
      ok(A.tags.some(t => t === 'against:AGAINST HTF ↑') && /HTF ↑/.test(A.banner), 'H6 HTF flipped up: S281 short reads AGAINST HTF ↑ (amber), header HTF ↑', JSON.stringify(A));
      const Z = await page.evaluate(async () => { delete lastSnapForPoll.tide.board.htf; lastSnapForPoll.tide.rows.forEach(x => { delete x.htf; delete x.htfDir; }); macui.feat20918.update(); macui.feat20919.update(); await new Promise(r => setTimeout(r, 200)); return { n: document.querySelectorAll('.fx22-htf, .fx22-htfl').length, banner: (document.getElementById('g-banner') || {}).textContent, unknown: /HTF/.test(document.getElementById('view-dashboard').innerText) }; });
      ok(Z.n === 0 && !/HTF/.test(Z.banner) && !Z.unknown, 'H7 fields absent (r1.5.5 bot): nothing drawn, no UNKNOWN noise', JSON.stringify(Z));
      ok(!errors.length, 'E5 no page errors (qc156-htf)', errors.join(' | '));
    });
    await withState(b, 'qc154-pos', async (page, errors) => {
      const r = await now(page);
      ok(/^Day P&L \(closed\) \+?\$0\.00 · TIDE open \+\$48\.00 \(calc: last price − fill × contracts × point value\)$/.test(r.pnlSub.trim()), 'P1 in a TIDE trade, r1.5.4 (no openUsd): closed $0.00 · TIDE open +$48.00 (calc = 6 × 4 pts × $2)', r.pnlSub);
      ok(!errors.length, 'E4 no page errors (qc154-pos)', errors.join(' | '));
    });
    await withState(b, 'qc154-pos2', async (page) => {
      const r = await now(page);
      ok(/TIDE open \+\$135\.00 \(bot\)/.test(r.pnlSub), 'P2 with tide.position.openUsd: "+$135.00 (bot)"', r.pnlSub);
    });
    await withState(b, 'mac1814', async (page, errors) => {
      const r = await page.evaluate(() => ({ sub: (document.getElementById('pnl-sub') || {}).textContent, wnt: (document.getElementById('wnt-card') || { getAttribute: () => null }).getAttribute('data-fx22'), css: !!document.getElementById('fx22-css') }));
      ok(!/TIDE/.test(r.sub || '') && r.wnt === null, 'O1 TIDE absent: the page\'s own header line, the old checklist card untouched', JSON.stringify(r)); ok(!errors.length, 'O2 no page errors (TIDE off)', errors.join(' | '));
    });
  } finally { await b.close(); }
  console.log(`\nqc-20922: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
