'use strict';
// MacUI-C 2.0.9.24 witness (fails on 2.0.9.23, passes on .24). One browser; cwd = the harness folder; MACUI_V2 = the candidate page; nice 19 by the caller.
//   M  trade rows resolve to their TIDE record on t24-tide1105 (four bot trades shaped after the 11/05 live journal): level + kind, qty from the fills (the
//      12:29 trade reads 1x, not the broker list's 3x), pts, $, R, exits, Why? with gates / grade / takenWhy; no row twice on the Trades tab
//   N  unmatched account rows (t23-pnl1105: six round trips the bot did not place) read "account fill · not matched to a bot record", never a bare Level line
//   E  no console / page errors on t24-tide1105, t23-pnl1105 and t23-standdown (the negative <rect> width is clamped)
//   V  macui.pageVersion = 2.0.9.24
const path = require('path'); const { chromium } = require('playwright'), { startServer, openPhone, meta } = require(path.resolve('lib.cjs'));
let pass = 0, fail = 0; const ok = (c, n, g) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' got: ' + String(g).slice(0, 900)}`); };
async function withState(b, st, fn) { const m = meta(st), srv = await startServer(st, 'mc24', m.clock); try { const o = await openPhone(b, { port: srv.port, v: '2', clock: m.clock }); try { await fn(o.page, o.errors); } finally { await o.ctx.close(); } } finally { srv.stop(); } }
const upd = page => page.evaluate(async () => { for (const k of ['feat20918', 'feat20919', 'feat20920', 'feat20923', 'feat20924']) { try { macui[k].update(); } catch (e) { /* */ } } await new Promise(r => setTimeout(r, 300)); try { macui.feat20924.update(); } catch (e) { /* */ } });
const rows = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].map(r => ({ hidden: r.hidden, fx24: r.getAttribute('data-fx24'), size: ((r.querySelector('.trade-size') || r.querySelector('b') || {}).textContent || '').trim(), lv: ((r.querySelector('.fx24-lv') || {}).textContent || '').replace(/\s+/g, ' ').trim(), unk: !!r.querySelector('.res-unk') && getComputedStyle(r.querySelector('.res-unk')).display !== 'none' })), sel);
(async () => { const b = await chromium.launch();
  try {
    await withState(b, 't24-tide1105', async (page, errors) => { await page.evaluate(() => switchView('dashboard')); await upd(page);
      const R = await rows(page, '#trades-body .trade-row'); const L = R.map(r => r.lv).join(' || ');
      ok(R.length === 4 && R.every(r => r.fx24 === 'matched'), 'M1 Now · Recent Trades: all four rows matched to a TIDE record', JSON.stringify(R.map(r => r.fx24)));
      ok(R.map(r => r.size).join(',') === '1x,2x,4x,1x', 'M2 qty from the entry fills: 1x (12:29), 2x (S448), 4x (S437), 1x (S425) — not the broker list\'s 3x', JSON.stringify(R.map(r => r.size)));
      ok(/Level 4H Open 28,430\.50 · trap · 2 lots · \+78\.50 pts · \+\$314\.00 fills, before fees · broker net \+\$309\.26 · \+5\.32R/.test(L), 'M3 S448-E reads Level "4H Open 28,430.50 · trap", 2 lots, +78.50 pts, +$314.00 from the fills (broker net +$309.26 named), +5.32R', L);
      ok(/entry 2 @ 28,377\.25 \(04:30\) · tp1 1 @ 28,361\.75 \(04:32\) · tp2 1 @ 28,235\.75 \(06:13\)/.test(L) || /tp1 1 @ 28,361\.75 \(04:32\) · tp2 1 @ 28,235\.75 \(06:13\)/.test(L), 'M4 S448-E exits: tp1 1 @ 28,361.75 (04:32) · tp2 1 @ 28,235.75 (06:13)', L);
      ok(/Level NY ORL 26,890\.00 · trap · 1 lot · \+154\.75 pts · \+\$309\.50 fills, before fees · broker net \+\$200\.34/.test(L), 'M5 the 12:29 short (journal rows only): 1 lot, +154.75 pts, $ from the fills, the broker net named when it differs', L);
      ok(/Level 4H Open 28,430\.50 · trap · 4 lots/.test(L) && /tp1 3 @ 28,443\.75/.test(L) && /stop 1 @ 28,430\.00/.test(L), 'M6 S437-E: 4 lots, tp1 3 @ 28,443.75 · stop 1 @ 28,430.00', L);
      ok(/Level 4H ORH 28,354\.75 · accepted-break · 1 lot · 0\.00 pts/.test(L) && /stop 1 @ 28,381\.25/.test(L), 'M7 S425-E: accepted-break, 1 lot, 0.00 pts (stop at break-even)', L);
      ok(!R.some(r => r.unk) && !/Level: not recorded|pts UNKNOWN/.test(L), 'M8 no orange UNKNOWN chip / "Level: not recorded" on a matched row', L);
      const W = await page.evaluate(() => { const d = document.querySelectorAll('#trades-body .fx24-why')[1]; d.open = true; return d.textContent.replace(/\s+/g, ' ').trim(); });
      ok(/signal S448-E · setup S448 · 04:30 PT · SHORT · planned entry 28,368\.75 · stop 28,392\.00 · TP1 28,361\.75 · TP2 28,235\.75/.test(W) && /grade B · 3 pts/.test(W) && /gates: control4h: pass, htf: pass, displacement: pass, time: pass/.test(W) && /taken: taken: 4H control \+ trap at the level/.test(W) && /matched by order id/.test(W), 'M9 Why? opens the TIDE signal row: planned entry, stop, TPs, grade tag, gates, takenWhy, matched by order id', W);
      await page.evaluate(() => switchView('trades')); await page.waitForTimeout(400); await upd(page);
      const A = await rows(page, '.fx23-acct li.fx23-ar'), T = await rows(page, '.fx18-tlist li.fx18-tr');
      ok(A.length === 4 && A.filter(r => r.fx24 === 'dup' && r.hidden).length === 3 && A.filter(r => r.fx24 === 'matched' && !r.hidden).length === 1, 'M10 Trades tab: the three trades already listed as TIDE trades are hidden in the account box (not shown twice); the 12:29 trade stays, matched', JSON.stringify(A.map(r => r.fx24 + ':' + r.hidden)));
      ok(A.some(r => /NY ORL 26,890\.00 · trap · 1 lot/.test(r.lv)), 'M11 the account-box row of the 12:29 trade carries the resolved line (1 lot)', JSON.stringify(A.map(r => r.lv)));
      ok(T.length === 3 && T.every(r => /Level 4H (Open 28,430\.50 · trap|ORH 28,354\.75 · accepted-break)/.test(r.lv) && /lots?/.test(r.lv) && /pts/.test(r.lv) && /R/.test(r.lv)), 'M12 the TIDE trade rows carry level, kind, qty, pts, R and the exits', JSON.stringify(T.map(r => r.lv)));
      const V = await page.evaluate(() => macui.pageVersion); ok(V === '2.0.9.24', 'V1 macui.pageVersion = 2.0.9.24', V);
      ok(!errors.length, 'E1 no page errors (t24-tide1105)', errors.join(' | ')); });
    await withState(b, 't23-pnl1105', async (page, errors) => { await page.evaluate(() => switchView('dashboard')); await upd(page);
      const R = await rows(page, '#trades-body .trade-row');
      ok(R.length > 0 && R.every(r => r.fx24 === 'none' && /^account fill · not matched to a bot record$/.test(r.lv)), 'N1 the six round trips the bot did not place read "account fill · not matched to a bot record"', JSON.stringify(R.map(r => r.fx24 + ':' + r.lv)));
      await page.evaluate(() => switchView('trades')); await page.waitForTimeout(400); await upd(page);
      const A = await rows(page, '.fx23-acct li.fx23-ar'); ok(A.length === 6 && A.every(r => !r.hidden && /not matched to a bot record/.test(r.lv)), 'N2 Trades tab: all six account rows stay, each muted "not matched"', JSON.stringify(A.map(r => r.hidden + ':' + r.lv)));
      ok(!errors.length, 'E2 no page errors (t23-pnl1105)', errors.join(' | ')); });
    await withState(b, 't23-standdown', async (page, errors) => { await upd(page); await page.waitForTimeout(500);
      const neg = await page.evaluate(() => [...document.querySelectorAll('#fx17-hour rect')].filter(r => +r.getAttribute('width') < 0).length); ok(neg === 0, 'E3 no <rect> with a negative width on the lane fixture', neg);
      ok(!errors.length, 'E4 no page errors (t23-standdown: the rect width clamp)', errors.join(' | ')); });
    await withState(b, 'qc155-flat', async (page, errors) => { await page.waitForTimeout(800);
      const n = await page.evaluate(() => document.querySelectorAll('.fx24-lv, [data-fx24]').length); ok(n === 0, 'I1 flat day (qc155-flat, no trade): feat-20924 adds nothing to the page (no .fx24-lv, no data-fx24)', n);
      ok(!errors.length, 'E5 no page errors (qc155-flat)', errors.join(' | ')); });
  } finally { await b.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
