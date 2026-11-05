'use strict';
// MacUI-N3 2.0.9.21 witness (Mac's 08:34 PT 11/04 screen, TIDE live r1.5.4): the Levels "Live trade" card drew Target 28,587 / Stop 28,471.75 / a Trigger
// marker (a LONG shape, the OLD path's live level event) while TIDE's only setup was the 1H Open 28,628.25 SHORT, and the footer said "no plan".
// Fixture tide21-leak = that state. (W) the card draws THAT level's reference plan (stop above the entry for the short), labelled "1H Open · SHORT";
// no old-path text on the canvas; (N) no armed level / armed without a plan: no plan lines at all, the level lines and the footer stay; (D) the Dash card
// and the full screen draw no old-path lines either; (H) the header's distance in words; (O) the old-path toggle still shows them, labelled, on purpose.
//   node plan-leak-20921.test.cjs   (cwd = the harness folder; MACUI_V2 = the candidate page; one browser; nice 19 by the caller)
const path = require('path'); const { chromium } = require('playwright'), { startServer, openPhone, meta } = require(path.resolve('lib.cjs'));
let pass = 0, fail = 0; const ok = (c, n, g) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' got: ' + String(g).slice(0, 600)}`); };
async function withState(b, st, fn) { const m = meta(st), srv = await startServer(st, 'mn21', m.clock); try { const o = await openPhone(b, { port: srv.port, v: '2', clock: m.clock }); try { await fn(o.page, o.errors); } finally { await o.ctx.close(); } } finally { srv.stop(); } }
// render the Levels tab (and the Dash card, and the full screen) with every canvas fillText captured
const levels = (page, f) => page.evaluate(async f => { if (f) (new Function('d', f))(lastSnapForPoll); window.lvTradeKey = null; const TX = [], TD = [], TF = [];
  const ft = CanvasRenderingContext2D.prototype.fillText; let cur = TX; CanvasRenderingContext2D.prototype.fillText = function (t) { cur.push(String(t)); return ft.apply(this, arguments); };
  switchView('levels'); renderLevels(lastSnapForPoll); await new Promise(r => setTimeout(r, 600));
  cur = TD; try { renderLevelsDash(lastSnapForPoll); } catch (e) { TD.push('ERR ' + e.message); } await new Promise(r => setTimeout(r, 300));
  cur = TF; try { lvFullOpen(); } catch (e) { TF.push('ERR ' + e.message); } await new Promise(r => setTimeout(r, 300)); const full = (document.getElementById('lv-full') || {}).textContent || ''; try { lvFullClose(); } catch (e) { /* display only */ }
  CanvasRenderingContext2D.prototype.fillText = ft;
  const P = lvPlanTrade(lastSnapForPoll.levels), q = s => (document.querySelector(s) || {}).textContent || '';
  return { P: P ? { tide: P.tide || null, dir: P.dir, entry: P.entry, stop0: P.stop0, stops: P.stops, targets: P.targets, planWhat: P.planWhat, old: !!P.oldPath } : null, sub: q('#lv-trade-sub'), body: q('#lv-trade-body'), banner: q('#g-banner'),
    ladder: !!document.querySelector('#lv-lad-body canvas, #lv-lad-body svg'), chart: !!document.querySelector('#lv-trade-chart'), tx: TX, td: TD, tf: TF, full, dash: q('#lv-dash-body') }; }, f);
const OLD = /TGT|28,?47[12]|28,?587|Trigger/;   // the old path's LONG shape: TGT 28587, STOP 28472 (rounded tag), the trigger bar
(async () => { const b = await chromium.launch();
  try {
    await withState(b, 'tide21-leak', async (page, errors) => {
      const W = await levels(page, null);
      ok(W.P && W.P.tide === 'board' && W.P.dir === -1 && W.P.entry === 28628.25 && W.P.stop0 === 28662 && W.P.stop0 > W.P.entry && 'STOP ref' in W.P.stops, 'W1 the card\'s plan is the board\'s 1H Open SHORT: entry 28628.25, stop ref 28662 ABOVE the entry', JSON.stringify(W.P));
      ok(W.P && /1H Open/.test(W.P.planWhat) && /SHORT/.test(W.P.planWhat) && W.sub === 'TIDE PLAN' && /1H Open · SHORT/.test(W.body), 'W2 labelled "1H Open · SHORT" (from tide.board.levels[].dir), card title TIDE PLAN', (W.P && W.P.planWhat) + ' | ' + W.sub + ' | ' + W.body.slice(0, 200));
      ok(!OLD.test(W.tx.join('|')) && !/STOP 2847/.test(W.tx.join('|')), 'W3 no old-path Target 28587 / Stop 28471.75 / Trigger text on the canvas', JSON.stringify(W.tx));
      ok(W.tx.some(t => /^1H Open/.test(t)) && W.tx.includes('Plan entry') && W.tx.includes('28,628.25') && /Stop ref\s*28,662\.00/.test(W.body), 'W4 the canvas tags: the level name, "Plan entry" at 28,628.25; the card says Stop ref 28,662.00', JSON.stringify(W.tx) + ' | ' + W.body.slice(0, 300));
      ok(!/Flat, no plan/.test(W.body) && /Reference, not an order/.test(W.body), 'W5 the footer does not contradict the chart (reference plan text, not "Flat, no plan")', W.body.slice(0, 300));
      ok(!OLD.test(W.td.join('|')) && !OLD.test(W.tf.join('|')) && /1H Open · SHORT/.test(W.full), 'D1 the Dash card and the full screen draw the same TIDE plan, no old-path lines', JSON.stringify({ td: W.td, tf: W.tf, full: W.full.slice(0, 160) }));
      ok(/1H Open 28,628\.25 · 37\.25 above price/.test(W.banner) && !/\(\+37\.25\)/.test(W.banner) && /▼ 1H Open/.test(W.banner), 'H1 the header says "37.25 above price", not "(+37.25)"', W.banner);
      ok(!errors.length, 'E1 no page errors', errors.join(' | '));
      // armed, but the board carries no plan yet: no lines at all, the level lines and the footer stay, a TIDE note says why
      const N = await levels(page, "d.tide.board.levels[0].plan = null;");
      ok(N.P === null && /Flat, no plan at a level/.test(N.body) && /TIDE next to act: 1H Open 28,628\.25 · entry, stop and TPs set at the signal/.test(N.body), 'N1 armed without a plan: no plan, the footer and the TIDE note', N.body.slice(0, 300));
      ok(!OLD.test(N.tx.join('|')) && !OLD.test(N.td.join('|')) && !OLD.test(N.tf.join('|')) && N.tx.some(t => /^London Hi|^1H Open|^Week Open|^PWC/.test(t)) && N.ladder, 'N2 no Target / Stop / Trigger text anywhere (card, ladder, Dash, full screen); the named level lines stay', JSON.stringify({ tx: N.tx, td: N.td, tf: N.tf }));
      // nothing armed at all
      const Z = await levels(page, "d.tide.board.levels.forEach(l => { l.state = 'watching'; l.plan = null; l.dir = null; });");
      ok(Z.P === null && /TIDE: nothing armed/.test(Z.body) && /Flat, no plan at a level/.test(Z.body) && !OLD.test(Z.tx.join('|')) && !OLD.test(Z.td.join('|')) && !OLD.test(Z.tf.join('|')), 'N3 no armed level: no plan lines, "nothing armed", the footer', JSON.stringify({ body: Z.body.slice(0, 200), tx: Z.tx }));
      ok(/TIDE scanning/.test(Z.banner), 'H2 header with nothing armed: TIDE scanning', Z.banner);
      // the old path's lines are one tap away, labelled, on purpose (per phone, off by default)
      await page.evaluate(() => document.querySelector('#lv-trade-body .fx20-old').click()); const O = await levels(page, null);
      ok(O.P && O.P.old && O.sub === 'OLD PATH PLAN' && /manage-only under TIDE/.test(O.body), 'O1 the old-path toggle on: its LONG event, labelled manage-only (Mac\'s choice, not the default)', JSON.stringify(O.P) + ' ' + O.sub);
      await page.evaluate(() => document.querySelector('#lv-trade-body .fx20-old').click()); const O2 = await levels(page, null);
      ok(O2.P === null && !OLD.test(O2.tx.join('|')), 'O2 toggle off again: no old-path lines', JSON.stringify(O2.tx));
    });
    // TIDE off: the ladder is the page's own (the old path's event lines ARE drawn, as in 2.0.9.20; the identity test covers the DOM)
    await withState(b, 'mac1814', async (page, errors) => {
      const r = await page.evaluate(() => ({ tide: !!(lastSnapForPoll && lastSnapForPoll.tide), banner: (document.getElementById('g-banner') || {}).textContent || '' }));
      ok(!r.tide && !/above price|below price/.test(r.banner), 'O3 TIDE absent: no TIDE words in the header', JSON.stringify(r)); ok(!errors.length, 'O4 no page errors (TIDE off)', errors.join(' | '));
    });
  } finally { await b.close(); }
  console.log(`\nplan-leak-20921: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
