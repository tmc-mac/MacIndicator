'use strict';
// MacUI-N 2.0.9.22 witness: (T) the TIDE tape in the Hour card; (L) the Levels "Live trade · PLAN" lines from TIDE (tide.position, else the board's
// NEXT TO ACT plan), the old path behind "Old levels path (manage-only)", off by default; (V) the page version 2.0.9.22 everywhere; (J) the MacJournal
// merge with MacArthur's ruling (rule-window rows only under "Control & rules"); (O) TIDE off: nothing of this mounted.
const path = require('path'); const { chromium } = require('playwright'), { startServer, openPhone, meta } = require(path.resolve('lib.cjs'));
let pass = 0, fail = 0; const ok = (c, n, g) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' got: ' + String(g).slice(0, 500)}`); };
async function withState(b, st, fn) { const m = meta(st), srv = await startServer(st, 'mn20', m.clock); try { const o = await openPhone(b, { port: srv.port, v: '2', clock: m.clock }); try { await fn(o.page, o.errors); } finally { await o.ctx.close(); } } finally { srv.stop(); } }
const levels = (page, f) => page.evaluate(async f => { if (f) (new Function('d', f))(lastSnapForPoll); window.lvTradeKey = null; const TX = []; const ft = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (t) { TX.push(String(t)); return ft.apply(this, arguments); }; switchView('levels'); renderLevels(lastSnapForPoll); await new Promise(r => setTimeout(r, 600)); CanvasRenderingContext2D.prototype.fillText = ft;
  const P = lvPlanTrade(lastSnapForPoll.levels), q = s => (document.querySelector(s) || {}).textContent || '';
  return { P: P ? { tide: P.tide || null, entry: P.entry, stop0: P.stop0, stops: P.stops, targets: P.targets, planWhat: P.planWhat, old: !!P.oldPath } : null, sub: q('#lv-trade-sub'), body: q('#lv-trade-body'),
    btn: !!document.querySelector('#lv-trade-body .fx20-old'), pressed: (document.querySelector('#lv-trade-body .fx20-old') || { getAttribute: () => null }).getAttribute('aria-pressed'), chart: !!document.querySelector('#lv-trade-chart'), tx: TX }; }, f);
(async () => { const b = await chromium.launch();
  try {
    await withState(b, 'tide19-board16', async (page, errors) => {
      const t = await page.evaluate(() => { macui.feat20920.update(); const tp = document.querySelector('#fx17-hour .fx20-tape'), st = document.querySelector('#fx17-hour .fx17-strip');
        return { tape: !!tp && !tp.hidden, strip: st ? getComputedStyle(st).display : 'missing', attr: document.getElementById('fx17-hour').getAttribute('data-fx20'), ctl: (document.querySelector('.fx20-c') || { getAttribute: () => null }).getAttribute('data-dir'),
          ct: (document.querySelector('.fx20-ct') || {}).textContent, codes: [...new Set([...document.querySelectorAll('.fx20-s')].map(e => e.getAttribute('data-code')))].join(), cap: (document.querySelector('.fx20-cap') || {}).textContent || '',
          hits: [...document.querySelectorAll('.fx20-hit')].map(e => e.getBoundingClientRect().width), now: (document.querySelector('.fx20-now') || { getAttribute: () => '' }).getAttribute('transform'), perf: macui.feat20920.perf }; });
      ok(t.tape && t.strip === 'none' && t.attr === 'tide', 'T1 the tape replaces the Hour strip (strip hidden, not removed)', JSON.stringify(t));
      ok(t.ctl === '-1' && /SELLERS · trap/.test(t.ct) && !/needs bot/.test(t.ct), 'T2 the control lane from tide.board.control', t.ct);
      ok(/TIME_BLOCK/.test(t.codes) && /OPEN_WAIT/.test(t.codes), 'T3 no-entry shading: TIME_BLOCK + OPEN_WAIT from tide.rules', t.codes);
      ok(/^next 4H open in \d:\d\d:\d\d/.test(t.cap), 'T4 the caption: next 4H open countdown', t.cap);
      ok(/^translate\([\d.]+ 0\)$/.test(t.now), 'T5 the now marker is a transform', t.now);
      ok(t.perf.updates > 0 && t.perf.updateMax < 50, 'T6 render cost measured (max ' + (t.perf.updateMax || 0).toFixed(1) + ' ms over ' + t.perf.updates + ' updates; budget 4 ms unloaded, 50 under the gate load)', JSON.stringify(t.perf));
      if (t.hits.length) { const det = await page.evaluate(() => { const h = document.querySelector('.fx20-hit'); h.dispatchEvent(new MouseEvent('click', { bubbles: true })); return document.querySelector('.fx20-det').textContent; });
        ok(/^(\d+ events: )?\d\d:\d\d PT · /.test(det) && t.hits.every(w => w >= 30), 'T7 a tap gives one aria-live detail line; hit rects 44 viewBox px', det + ' / ' + t.hits.join()); }
      else ok(false, 'T7 the board16 fixture has TIDE rows in the window', 'no ticks');
      const L = await levels(page, null);
      ok(L.P && L.P.tide === 'board' && L.P.entry === 28414 && L.P.stop0 === 28513 && 'STOP ref' in L.P.stops && !Object.keys(L.P.targets).length, 'L1 PLAN lines from the board NEXT TO ACT (reference: level + stop ref, TPs set at signal)', JSON.stringify(L.P));
      ok(L.sub === 'TIDE PLAN' && /Reference, not an order/.test(L.body) && /Stop ref/.test(L.body) && /set at the signal/.test(L.body) && /takes no entries under TIDE/.test(L.body) && !/A live level event/.test(L.body), 'L2 the card says TIDE PLAN, reference, not the old level-event text', L.sub + ' | ' + L.body.slice(0, 400));
      ok(L.tx.includes('Plan entry') && !L.tx.includes('Fill'), 'L12 a TIDE board plan keeps "Plan entry" (plans unchanged)', JSON.stringify(L.tx.filter(t => /entry|Fill/i.test(t))));
      ok(L.btn && L.pressed === 'false', 'L3 "Old levels path (manage-only)" button, off by default', JSON.stringify(L));
      await page.evaluate(() => document.querySelector('#lv-trade-body .fx20-old').click()); const O = await levels(page, null);
      ok(O.P && O.P.old && /^old path \(manage-only\) · /.test(O.P.planWhat) && O.sub === 'OLD PATH PLAN' && O.pressed === 'true' && /manage-only under TIDE/.test(O.body), 'L4 toggle on: the old path\'s lines, labelled manage-only', JSON.stringify(O.P) + ' ' + O.sub);
      await page.evaluate(() => document.querySelector('#lv-trade-body .fx20-old').click()); const O2 = await levels(page, null);
      ok(O2.P && O2.P.tide === 'board' && O2.pressed === 'false', 'L5 toggle off again: TIDE lines', JSON.stringify(O2.P));
      const N = await levels(page, "d.tide.board.levels.forEach(l => { l.plan = null; });");
      ok(N.P === null && /TIDE next to act: .* · entry, stop and TPs set at the signal/.test(N.body) && !/Plan<\/span>/.test(N.body), 'L6 an armed level without a plan: no lines, a TIDE note (never the old event plan)', JSON.stringify(N).slice(0, 400));
      const v = await page.evaluate(() => ({ pv: macui.pageVersion, tj: macui.tideJournal ? macui.tideJournal.pageVersion() : null }));
      ok(v.pv === '2.0.9.22' && v.tj && v.tj.v === '2.0.9.22' && v.tj.exact === true, 'V1 macui.pageVersion = 2.0.9.22 (the journal export reads it)', JSON.stringify(v));
      ok(!errors.length, 'E1 no page errors (board16)', errors);
    });
    await withState(b, 'tide19-live', async (page, errors) => {
      const L = await levels(page, null);
      ok(L.P && L.P.tide === 'position' && L.P.entry === 27731.25 && L.P.stop0 === 27760.25 && 'STOP' in L.P.stops && L.P.targets.TP1 && L.P.targets.TP1[0][1] === 27690 && L.P.targets.TP2[0][1] === 27611.5, 'L7 TIDE in a trade: the lines from tide.position (fill, acked stop, TP1, TP2)', JSON.stringify(L.P));
      ok(L.tx.includes('Fill') && !L.tx.includes('Plan entry'), 'L11 MacCharts names the TIDE fill line "Fill", never "Plan entry"', JSON.stringify(L.tx.filter(t => /entry|Fill/i.test(t))));
      ok(L.sub === 'TIDE IN TRADE' && /open position \(tide\.position\)/.test(L.body) && /acked by the broker/.test(L.body), 'L8 the card says TIDE IN TRADE', L.sub + ' | ' + L.body.slice(0, 300));
      const A = await levels(page, "d.tide.position.stopAcked = null;");
      ok(A.P && A.P.tide === 'position' && 'STOP asked' in A.P.stops && /asked, NOT acked/.test(A.body), 'L9 a stop not acked is labelled asked', JSON.stringify(A.P.stops));
      const U = await levels(page, "d.tide.position.avgEntry = null;");
      ok(U.P === null && /fill price UNKNOWN/.test(U.body), 'L10 no observed fill: nothing charted, UNKNOWN said', U.body.slice(0, 300));
      const tp = await page.evaluate(() => { macui.feat20920.update(); return [...document.querySelectorAll('.fx20-t')].map(e => e.getAttribute('data-open')).join(); });
      ok(/1/.test(tp), 'T8 the open TIDE position is a trade bar on the tape', tp);
      ok(!errors.length, 'E2 no page errors (live)', errors);
    });
    await withState(b, 'tide18-shadow', async (page) => {
      const t = await page.evaluate(() => { macui.feat20920.update(); return (document.querySelector('.fx20-ct') || {}).textContent || ''; });
      ok(/needs bot r1\.3|4H control: none/.test(t), 'T9 no board: the journal control_form, labelled "needs bot r1.3" (or none)', t);
    });
    await withState(b, 'tide19-board16', async (page) => {
      const r = await page.evaluate(async () => { switchView('journal'); const pick = async k => { const c = document.querySelector(`[data-tj-f="${k}"]`); if (c) c.click(); await new Promise(r => setTimeout(r, 200)); const a = document.querySelector('[data-tj-all]'); if (a && a.getAttribute('aria-expanded') !== 'true') { a.click(); await new Promise(r => setTimeout(r, 200)); }
          const root = document.querySelector('.tj-root'); return root ? root.textContent : ''; };
        const all = await pick('all'), ctl = await pick('control'); await pick('all'); return { all: /no entries until/.test(all), ctl: /no entries until/.test(ctl), root: !!document.querySelector('.tj-root') }; });
      ok(r.root && !r.all && r.ctl, 'J1 MacArthur ruling: the Open wait / Time block rows only under "Control & rules", not under "All"', JSON.stringify(r));
    });
    await withState(b, 'mac1814', async (page, errors) => {
      const r = await page.evaluate(() => { switchView('levels'); renderLevels(lastSnapForPoll); macui.feat20920.update(); return { tape: !!document.querySelector('.fx20-tape:not([hidden])'), attr: (document.getElementById('fx17-hour') || { getAttribute: () => null }).getAttribute('data-fx20'), old: !!document.querySelector('.fx20-old'), note: !!document.querySelector('.fx20-lvn'), tp: macui.feat20920.tidePlan(lastSnapForPoll) === undefined, tj: !!document.querySelector('.tj-root') || document.getElementById('view-journal').hasAttribute('data-tj') }; });
      ok(!r.tape && !r.attr && !r.old && !r.note && r.tp && !r.tj, 'O1 TIDE absent: no tape, no PLAN changes, no journal root', JSON.stringify(r)); ok(!errors.length, 'O2 no page errors (TIDE off)', errors);
    });
  } finally { await b.close(); }
  console.log(`\nfeat-20920: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
