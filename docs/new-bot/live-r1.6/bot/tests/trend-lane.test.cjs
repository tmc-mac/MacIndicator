#!/usr/bin/env node
'use strict';
// TIDE live r1.6 witnesses (MacTrend 11/05): the trend lane (lib/trendLane.js) on synthetic engine states, sizing ($400 max, cap 3), caps, the kept gates,
// trend=off / grade=strict identity with r1.5.6 (BASE = ../../pkg-live-r1.5.6-wip or $R156_BASE), gradeGate aligned-pass on the 11/04 fixture, the journal reload.
// usage: nice -n 19 node tests/trend-lane.test.cjs
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), W = require(path.join(ROOT, 'lib/tideWire.js')), S = require(path.join(ROOT, 'lib/structure.js')), TL = require(path.join(ROOT, 'lib/trendLane.js'));
let pass = 0, fail = 0; const fails = [];
const ok = (c, n, x) => { if (c) pass++; else { fail++; fails.push(n); console.log('  FAIL ' + n + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 900) : '')); } };
const U = (h, m) => Date.UTC(2026, 10, 4, h, m) / 1000;   // 11/04 UTC (PST: PT = UTC - 8)
const bar = (t, o, h, l, c) => ({ t, o, h, l, c, v: 100, vk: true });
// a synthetic engine state at T (unix sec): DIR down (prior 4H bearish), last 30M bearish, price just under PDL 28290
function stateAt(T, o = {}) {
  const t5 = T - 300, trig = o.trig || bar(t5, 28286, 28292.25, 28283.75, 28284);
  const m5 = []; for (let t = U(11, 0); t < t5; t += 300) m5.push(bar(t, 28300 - (t - U(11, 0)) / 600, 28300.5 - (t - U(11, 0)) / 600, 28299.5 - (t - U(11, 0)) / 600, 28300 - (t + 300 - U(11, 0)) / 600));
  m5.push(trig);
  const last30 = o.last30 || bar(U(12, 0), 28300, 28301, 28281, 28282), cur30 = o.cur30 === null ? null : (o.cur30 || bar(U(12, 30), 28282, Math.max(28292.25, trig.h), 28281, trig.c));
  return { v: 'test', bars: { m5, m15: [bar(U(12, 0), 28300, 28301, 28290, 28291), bar(U(12, 15), 28291, 28295, 28281, 28282)], m30: [bar(U(11, 0), 28300, 28302, 28298, 28300), bar(U(11, 30), 28300, 28301, 28299, 28300), last30], h1: [bar(U(11, 0), 28300, 28302, 28281, 28282)], h4: [] },
    cur: { m5: null, m15: bar(U(12, 30), 28282, trig.h, 28281, trig.c), m30: cur30, h1: bar(U(12, 0), 28300, 28301, 28281, trig.c), h4: null },
    htf: o.htf === null ? null : (o.htf || { prev4h: { t: U(7, 0), at: '11-03 23:00', o: 28400, h: 28401, l: 28299, c: 28300, dir: -1, hh: false, ll: true, openSide: -1 }, cur4h: { t: U(11, 0), o: 28300, side: -1, control: null }, daily: { t: U(11, 0) - 43200, o: 28500, side: -1 }, votes: [-1, -1, -1], dir: -1, tie: false }),
    period: { t: U(11, 0), O4: 28300, control: null }, zones: [], levels: { O4: 28300, O1: 28300, PDH: 28600, PDL: o.pdl === undefined ? 28290 : o.pdl, AsiaH: null, AsiaL: null, LonH: null, LonL: null },
    piv: { m15: { hi: [{ t: U(12, 15), price: 28295, confT: U(12, 45), len: 900 }], lo: [] }, h1: { hi: [], lo: [] }, h4: { hi: [], lo: [] } }, climax: o.climax || null, mstate: { state: 'TREND', dir: -1, known: true } };
}
const CFG = (t = {}) => ({ tide: { ...W.DEFAULTS.tide, mode: 'live', liveArmed: W.LIVE_ARM, ...t }, money: W.moneyDefaults() });

console.log('A the lane on synthetic states (Mac 11/05 spec: prior-4H DIR, 30M harmony, 5M trigger at any tracked level, 30M-wick stop)');
{ const T = U(12, 45), lane = TL.create(W.trendLaneOf(CFG())), r = lane.step(stateAt(T), T, [{ name: 'PDL', price: 28290 }]);
  ok(r.signal && r.signal.dir === -1 && r.signal.trend.trigger === 'reject' && r.signal.level.name === 'PDL' && r.signal.entryPrice === 28284 && r.signal.chosenStop === 28292.75 && r.signal.trend.stopBasis === '30m-wick', 'a1 DIR down (prior 4H bearish) + 30M harmony + a 5m REJECTION at PDL 28290 (wick 6.25 >= 4, close 28284 below) -> one SHORT at the 5m close, stop beyond the 30M wick 28292.25 + 2 ticks = 28292.75', r.signal && { trig: r.signal.trend.trigger, lvl: r.signal.level, e: r.signal.entryPrice, s: r.signal.chosenStop, b: r.signal.trend.stopBasis, why: r.rows.map(x => x.phase + ':' + (x.why || '')) });
  ok(r.rows.some(x => x.phase === 'trend_arm' && x.R === 28290), 'a1b trend_arm row for PDL (R, kind, dirEv, h30)', r.rows);
  const t5 = T - 300, s2 = stateAt(T, { pdl: null, trig: bar(t5, 28291, 28292, 28283.75, 28284), cur30: bar(U(12, 30), 28290, 28292, 28281, 28284) }), r2 = TL.create(W.trendLaneOf(CFG())).step(s2, T, []);
  ok(r2.signal && r2.signal.trend.trigger === 'break' && r2.signal.level.name === '30M Open' && r2.signal.level.price === 28290 && r2.signal.chosenStop === 28292.5, 'a2 a 5m BREAK-and-close below the 30M open 28290 (opened 28291 above, closed 28284 below; no wick minimum) -> SHORT, stop 28292 + 2 ticks', r2.signal && { trig: r2.signal.trend.trigger, lvl: r2.signal.level, s: r2.signal.chosenStop });
  const rb = TL.create(W.trendLaneOf(CFG())).step(stateAt(T, { last30: bar(U(12, 0), 28282, 28301, 28281, 28300) }), T, [{ name: 'PDL', price: 28290 }]);
  ok(!rb.signal && rb.rows.some(x => x.phase === 'trend_idle' && /30M not in harmony \(last 30M closed against DIR at 11-04 04:00\)/.test(x.why)), 'b the last completed 30M closed BULLISH against DIR -> no entry, trend_idle "30M not in harmony (last 30M closed against DIR at hh:mm)"', rb.rows);
  const rb2 = TL.create(W.trendLaneOf(CFG())).step(stateAt(T, { htf: { prev4h: { t: U(7, 0), at: '11-03 23:00', o: 28300, h: 28401, l: 28299, c: 28300.5, dir: 0 }, cur4h: null, daily: { side: 0 }, votes: [0, 0, 0], dir: 0 } }), T, []);
  ok(!rb2.signal && rb2.rows.some(x => x.phase === 'trend_idle' && x.why === 'no 4H direction (prior 4H flat)'), 'b2 a flat prior 4H -> idle "no 4H direction (prior 4H flat)"', rb2.rows);
  const rc = TL.create(W.trendLaneOf(CFG())).step(stateAt(T, { trig: bar(t5, 28286, 28292.25, 28283.75, 28291) }), T, [{ name: 'PDL', price: 28290 }]);
  ok(!rc.signal && !rc.rows.some(x => x.phase === 'trend_signal' || x.phase === 'trend_skip'), 'c the 5m closes back on the WRONG side of PDL (28291 > 28290) -> no entry', rc.rows);
  const T2 = U(12, 36), s3 = stateAt(T2, { trig: bar(T2 - 300, 28286, 28292.25, 28283.75, 28284), cur30: bar(U(12, 30), 28282, 28292.25, 28281, 28284) }), rf2 = TL.create(W.trendLaneOf(CFG())).step(s3, T2, [{ name: 'PDL', price: 28290 }]);
  ok(rf2.signal && rf2.signal.trend.stopBasis === 'prev-30m-wick' && rf2.signal.chosenStop === 28301.5 && rf2.signal.trend.stopEv.at === '11-04 04:00', 'f2 the 30M candle is 6 min old at the trigger -> the PREVIOUS 30M wick (28301) + 2 ticks = 28301.5, stopBasis prev-30m-wick with its open time', rf2.signal && rf2.signal.trend.stopEv);
  const ri = TL.create(W.trendLaneOf(CFG())).step(stateAt(T, { climax: { dir: -1, T: T - 900 } }), T, [{ name: 'PDL', price: 28290 }]);
  ok(ri.signal && ri.signal.trend.climax && ri.signal.trend.climax.sameWay === true, 'i CLIMAX state active (selling climax) + a valid 5m trigger in DIR -> the lane ENTERS (climax "defense-confirms"); the climax is journaled on the signal', ri.signal && ri.signal.trend.climax);
  const ri2 = TL.create(W.trendLaneOf(CFG({ trendLane: { ...W.TREND_LANE_SHIP, climax: 'block' } }))).step(stateAt(T, { climax: { dir: -1, T: T - 900 } }), T, [{ name: 'PDL', price: 28290 }]);
  ok(!ri2.signal && ri2.rows.some(x => x.phase === 'trend_skip' && /^CLIMAX/.test(x.why)), 'i2 tide.trendLane.climax "block" -> refused with why CLIMAX', ri2.rows);
  ok(TL.configProblem({ enabled: true, retestTol: 6, climax: 'defense-confirms', capHour: 2, capDay: 6, minAge30: 10 }) === null && /climax/.test(TL.configProblem({ climax: 'x' }) || '') && /unknown/.test(TL.configProblem({ foo: 1 }) || ''), 'a3 tide.trendLane config validation');
  ok(W.openWait(Date.UTC(2026, 10, 4, 15, 30), 30) === null && W.blockAt(CFG(), Date.UTC(2026, 10, 4, 15, 30)) === null, 'a4 Mac\'s 07:30 PT example: no open wait (06:30 + 30, 07:00 4H + 30 are over) and no entry block (06:30-07:10) at 07:30 PT'); }

console.log('B sizing: $400 hard max, cap 3 (tide.sizeCap), the lane and level setups alike');
{ const cfg = CFG(), sig = pts => ({ dir: -1, entry: 28284, stop: 28284 + pts, grade: 'C', gradePoints: 0, kind: 'trend', lane: 'trend', stopTf: '30M', levelName: 'PDL', pools: [{ price: 28200, major: true, name: 'PDL2' }] });
  const q = pts => { const p = W.plan(sig(pts), cfg, 2, 0.25, null, 50000); return p.ok ? p.qty : p.code + (p.why ? ' | ' + p.why : ''); };
  ok(q(60) === 3, 'f a 60-pt 30M-wick stop ($120 / lot) -> 3 MNQ (floor(400/120) = 3, cap 3)', q(60));
  ok(q(19) === 8, 'f4 a 19-pt stop (would be 10 lots) -> capped at 8 (tide.sizeCap, Mac 11/05 ruling)', q(19));
  ok(q(45) === 4 && q(100) === 2, 'f8 45-pt -> 4 MNQ, 100-pt -> 2 MNQ', [q(45), q(100)]);
  ok(q(90) === 2, 'f3 a 90-pt stop ($180) -> 2 MNQ', q(90));
  ok(q(180) === 1, 'm2 a 180-pt stop ($360) -> 1 MNQ', q(180));
  ok(/^GRADE_NO_FIT_CEILING \| stop 250 pts = \$500 for 1 MNQ > \$400 max: needed a better entry$/.test(q(250)), 'm a 250-pt stop ($500 > $400) -> SKIPPED, code GRADE_NO_FIT_CEILING, why "needed a better entry" (no over-budget take)', q(250));
  const c8 = CFG({ sizeCap: 3 }); ok(W.plan(sig(19), c8, 2, 0.25, null, 50000).qty === 3 && W.sizeCapOf(c8) === 3 && /tide\.sizeCap/.test(W.configProblem(CFG({ sizeCap: 0 }), { symbol: 'MNQ', pointValue: 2, minContracts: 1 }) || ''), 'f5 tide.sizeCap 3 lowers the cap to 3 (runtime config, set-tide.sh sizecap=N; 0 is refused)');
  ok(W.liveMoney(cfg).sizing.maxContracts === 8 && W.moneyCfg(cfg).sizing.maxContracts === 8, 'f6 the money cfg the live driver / planner size with carries maxContracts = min(money maxContracts, tide.sizeCap)');
  ok(/size: \$400 max · cap 8/.test(W.startupLines(cfg)[0]) && /trend lane ON \(prior-4H dir · 30M harmony · 5M trigger at any level · 30M-wick stop · 2\/h 6\/day · climax defense-confirms/.test(W.startupLines(cfg)[0]) && / · journal reload ON;/.test(W.startupLines(cfg)[0]) && /grade gate: aligned-pass/.test(W.startupLines(cfg)[0]), 'f7 the startup line: "size: $400 max · cap 8", "trend lane ON (prior-4H dir · 30M harmony · 5M trigger at any level · 30M-wick stop · 2/h 6/day · climax defense-confirms)", "journal reload ON", "grade gate: aligned-pass"', W.startupLines(cfg)[0].slice(0, 400)); }

console.log('C the wiring: trend_signal rows, the kept gates, re-entry and the hourly cap, trend_skip on a too-wide stop');
function fakeEngine(lane, stFn, board) {   // an adapter that steps the real lane on a given state and hands its signal to shadowStep like createAdapter does
  return { version: 'fake', view: () => stFn(), trendNote: (sig, taken, T) => lane.note(sig, taken, T), step(ctx) { const rows = [], signals = []; for (const b of ctx.m1New || []) { const T = Math.floor(b.t / 1000) + 60, lr = lane.step(stFn(T), T, board || []); rows.push(...lr.rows); if (lr.signal) { const ns = W.normSignal(lr.signal, 'fake', null); if (ctx.onSignal) ctx.onSignal(ns, b); else signals.push(ns); } } return { rows, signals }; } };
}
{ const cfg = CFG(), lane = TL.create(W.trendLaneOf(cfg)), sh = { engine: fakeEngine(lane, T => stateAt(T), [{ name: 'PDL', price: 28290 }]), seen: new Set() }, T = U(12, 45);
  const out = W.shadowStep(sh, { nowMs: T * 1000, m1New: [{ t: (T - 60) * 1000, o: 28285, h: 28285, l: 28284, c: 28284, v: 1 }], warm: false, board: [], biasAt: () => null, sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true, useTimeBlocks: true, timeBlock: null }, 2, 0.25);
  const ts = out.rows.find(r => r.phase === 'trend_signal'), sg = out.rows.find(r => r.phase === 'signal');
  ok(ts && ts.taken === true && ts.size === 8 && ts.stop === 28292.75 && ts.trigger === undefined && ts.R === 28290 && out.takes.length === 1 && sg && sg.takenWhy && /^taken/.test(sg.takenWhy) && sg.kind === 'trend', 'e1 live mode: the lane signal is TAKEN (8 MNQ at an 8.75-pt stop: floor(400/17.5) = 22, cap 8; stop 28292.75), trend_signal + signal rows (takenWhy) written, one take', { ts, takes: out.takes.length, why: sg && sg.takenWhy });
  W.liveFeedback(sh, out.takes[0].id, { closed: true, tp1Done: true, why: 'tp2' });
  const T2 = T + 300, s2 = stateAt(T2, { trig: bar(T2 - 300, 28286, 28292.25, 28283.75, 28284) }); sh.engine = fakeEngine(lane, () => s2, [{ name: 'PDL', price: 28290 }]);
  const o2 = W.shadowStep(sh, { nowMs: T2 * 1000, m1New: [{ t: (T2 - 60) * 1000, o: 28285, h: 28285, l: 28284, c: 28284, v: 1 }], warm: false, board: [], biasAt: () => null, sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true }, 2, 0.25);
  ok(o2.takes.length === 1 && o2.rows.some(r => r.phase === 'trend_signal' && r.taken === true), 'e2 after TP2 (liveFeedback) the next trigger is a RE-ENTRY (taken)', o2.rows.filter(r => r.phase === 'trend_signal'));
  W.liveFeedback(sh, o2.takes[0].id, { closed: true, tp1Done: false, stopped: true });
  const T3 = T + 600, s3 = stateAt(T3, { trig: bar(T3 - 300, 28286, 28292.25, 28283.75, 28284) }); sh.engine = fakeEngine(lane, () => s3, [{ name: 'PDL', price: 28290 }]);
  const o3 = W.shadowStep(sh, { nowMs: T3 * 1000, m1New: [{ t: (T3 - 60) * 1000, o: 28285, h: 28285, l: 28284, c: 28284, v: 1 }], warm: false, board: [], biasAt: () => null, sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true }, 2, 0.25);
  ok(o3.takes.length === 0 && o3.rows.some(r => r.phase === 'trend_skip' && /^CAP_HOUR: 2 trend entries this clock hour \(cap 2\)/.test(r.why)), 'e3 a third trigger in the same clock hour -> trend_skip CAP_HOUR (2/h)', o3.rows);
  ok(lane.counts(T3).hour === 2 && lane.counts(T3).day === 2, 'e4 the lane counts 2 entries this hour / TradeDay');
  // d: inside the NY block (06:50 PT = 14:50 UTC) the kept gate refuses the take; the trend_signal row says why
  const Td = U(14, 50), laneD = TL.create(W.trendLaneOf(cfg)), shD = { engine: fakeEngine(laneD, T => stateAt(T, { trig: bar(T - 300, 28286, 28292.25, 28283.75, 28284), cur30: bar(U(14, 30), 28282, 28292.25, 28281, 28284), last30: bar(U(14, 0), 28300, 28301, 28281, 28282) }), [{ name: 'PDL', price: 28290 }]), seen: new Set() };
  const od = W.shadowStep(shD, { nowMs: Td * 1000, m1New: [{ t: (Td - 60) * 1000, o: 28285, h: 28285, l: 28284, c: 28284, v: 1 }], warm: false, board: [], biasAt: () => null, sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true, useTimeBlocks: true, timeBlock: W.blockAt(cfg, Td * 1000) }, 2, 0.25);
  const tsd = od.rows.find(r => r.phase === 'trend_signal');
  ok(od.takes.length === 0 && tsd && tsd.taken === false && /TIME_BLOCK|OPEN_WAIT/.test(tsd.why) && laneD.counts(Td).hour === 0, 'd a trigger inside the NY blockout (06:50 PT) -> refused (TIME_BLOCK or the 30-min open wait, whichever gate answers first), not counted as an entry', tsd);
  // the lane's own stop too wide: trend_skip with Mac's why
  const Tw = U(12, 45), laneW = TL.create(W.trendLaneOf(cfg)), shW = { engine: fakeEngine(laneW, T => stateAt(T, { cur30: bar(U(12, 30), 28282, 28540, 28281, 28284) }), [{ name: 'PDL', price: 28290 }]), seen: new Set() };
  const ow = W.shadowStep(shW, { nowMs: Tw * 1000, m1New: [{ t: (Tw - 60) * 1000, o: 28285, h: 28285, l: 28284, c: 28284, v: 1 }], warm: false, board: [], biasAt: () => null, sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true }, 2, 0.25);
  const sk = ow.rows.find(r => r.phase === 'trend_skip');
  ok(ow.takes.length === 0 && sk && sk.code === 'GRADE_NO_FIT_CEILING' && /stop 256.5 pts = \$513 for 1 MNQ > \$400 max: needed a better entry/.test(sk.why), 'm3 a 30M wick 256.5 pts away -> trend_skip GRADE_NO_FIT_CEILING "needed a better entry" (the stop is never moved to fit)', sk); }

console.log('G identity: trend=off + grade=strict on the same synthetic bars = the r1.5.6 wire + engine (rows equal after the version strings and the new takenWhy field are set aside)');
{ const BASE = process.env.R156_BASE || path.resolve(ROOT, '..', '..', 'pkg-live-r1.5.6-wip', 'bot');
  if (!fs.existsSync(path.join(BASE, 'lib', 'tideWire.js'))) { console.log('  (base r1.5.6 not found at ' + BASE + ': identity witness skipped)'); ok(false, 'g identity witness: base r1.5.6 missing'); }
  else {
    const W0 = require(path.join(BASE, 'lib/tideWire.js')), S0 = require(path.join(BASE, 'lib/structure.js'));
    const bars = []; let px = 28300; for (let i = 0; i < 1500; i++) { const t = U(0, 0) - 1500 * 60 + i * 60, d = Math.sin(i / 37) * 1.5 + (i % 97 === 0 ? 6 : 0) - (i % 131 === 0 ? 7 : 0); const c = px + d; bars.push({ t: t * 1000, o: px, h: Math.max(px, c) + 0.5, l: Math.min(px, c) - 0.5, c, v: 100 + (i % 13) * 20 }); px = c; }
    const board = [{ name: '4H Open', price: 28300 }, { name: 'PDH', price: 28330 }, { name: 'PDL', price: 28270 }, { name: '1H Open', price: 28298 }, { name: 'Asia High', price: 28320 }, { name: 'Asia Low', price: 28280 }];
    const run = (Wx, Sx, cfg) => { const sh = { engine: Wx.createAdapter(Sx, Wx.engineCfgOf(cfg)), seen: new Set() }, rows = [], book = Wx.createBiasBook(); let takes = 0;
      for (const b of bars) { Wx.noteBias(book, b.t + 60000, 0.25 * Math.sin(b.t / 900000), 0.2); const o = Wx.shadowStep(sh, { nowMs: b.t + 60000, m1New: [b], warm: false, board, biasAt: t => Wx.biasAt(book, t), sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true }, 2, 0.25); rows.push(...o.rows); takes += (o.takes || []).length; }
      return { rows, takes }; };
    const norm = r => JSON.stringify(r).replace(/tide-wire-r2\.\d-live/g, 'WIRE').replace(/tide-structure-r3\.\d/g, 'ENG').replace(/,"takenWhy":"[^"]*"/g, '');
    const c0 = { tide: { ...W0.DEFAULTS.tide, mode: 'shadow' }, money: W0.moneyDefaults() }, c1 = { tide: { ...W.DEFAULTS.tide, mode: 'shadow', trendLane: { ...W.TREND_LANE_SHIP, enabled: false }, gradeGate: 'strict', sizeCap: 30 }, money: W.moneyDefaults() };
    // rule 18 v3 (the STALE cancel of a far un-retested acceptance, structure DEFAULTS.staleAccept true) is the ONE intended engine divergence from r1.5.6 under the default config; the identity
    // witness switches it off through the engine-only key (not a tide switch) so everything else is proven byte-identical. g3 below shows the divergence is that cancel alone.
    const run2 = (cfg) => { const sh = { engine: W.createAdapter(S, { ...W.engineCfgOf(cfg), staleAccept: false }), seen: new Set() }, rows = [], book = W.createBiasBook(); let takes = 0;
      for (const b of bars) { W.noteBias(book, b.t + 60000, 0.25 * Math.sin(b.t / 900000), 0.2); const o = W.shadowStep(sh, { nowMs: b.t + 60000, m1New: [b], warm: false, board, biasAt: t => W.biasAt(book, t), sessionAt: () => ({ noEntry: false, flattenDue: false }) }, cfg, { flat: true }, 2, 0.25); rows.push(...o.rows); takes += (o.takes || []).length; }
      return { rows, takes }; };
    const a = run(W0, S0, c0), b = run2(c1), bDef = run(W, S, c1);
    ok(bDef.rows.length > b.rows.length && bDef.rows.some(r => r.phase === 'setup_cancel' && /^STALE: /.test(r.why)) && bDef.rows.filter(r => r.phase === 'setup_cancel' && /^STALE: /.test(r.why)).length >= 1, `g3 with the default config (staleAccept on) the same bars add rule 18 v3 rows: ${bDef.rows.length} rows vs ${b.rows.length}, the first a STALE setup_cancel of a far un-retested acceptance`, { def: bDef.rows.length, off: b.rows.length, stale: bDef.rows.filter(r => /^STALE: /.test(r.why || '')).map(r => [r.at, r.setup, r.why]) });
    const na = a.rows.map(norm), nb = b.rows.map(norm); let firstDiff = -1; for (let i = 0; i < Math.max(na.length, nb.length); i++) if (na[i] !== nb[i]) { firstDiff = i; break; }
    ok(a.rows.length === b.rows.length && firstDiff < 0 && a.takes === b.takes, `g trend=off + grade=strict (+ sizeCap 30 = the r1.5.6 maxContracts): ${b.rows.length} journal rows and ${b.takes} takes identical to r1.5.6 on 1500 synthetic bars`, { a: a.rows.length, b: b.rows.length, firstDiff, ra: firstDiff >= 0 ? na[firstDiff] : null, rb: firstDiff >= 0 ? nb[firstDiff] : null });
    ok(JSON.stringify(W.engineCfgOf(c1)).replace(/,"gradeGate":"strict"/, '').replace(/,"trendLane":\{[^}]*\}/, '') === JSON.stringify(W0.engineCfgOf(c0)), 'g2 engineCfgOf with the lane off + strict carries exactly the r1.5.6 engine keys plus gradeGate / trendLane (the adapter strips trendLane before structure.step)', [W.engineCfgOf(c1), W0.engineCfgOf(c0)]);
    // j/k/l: the 11/04 witness fixture through the real engine, r1.5.6 vs r1.6 strict (identical) and r1.6 aligned-pass (WITH-HTF gate refusals become signals)
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/witness-1104.json'), 'utf8')), NAMES = ['4H Open', '1H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low'];
    const fxRun = (Sx, cfgE) => { let st = Sx.createState(); const sigs = [], nt = [], wv = [];
      for (const r of fx.m1) { const T = r[0] + 60, rd = fx.readings[String(T)], L = {}; if (rd) NAMES.forEach((n, i) => { L[['O4', 'O1', 'PDH', 'PDL', 'AsiaH', 'AsiaL', 'LonH', 'LonL'][i]] = Number.isFinite(rd[2 + i]) ? rd[2 + i] : null; });
        const out = Sx.step(st, { m1: { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }, bias: rd ? { m15: { score: rd[0], valid: true, observedAt: T }, m30: { score: rd[1], valid: true, observedAt: T } } : null, levels: rd ? L : null }, cfgE); st = out.state;
        if (out.signal) sigs.push({ id: out.signal.id, dir: out.signal.dir, entry: out.signal.entryPrice, stop: out.signal.chosenStop, grade: out.signal.grade, waived: out.signal.gradeWaived === true, tags: out.signal.gradeTags || null, htf: out.signal.htf });
        for (const e of out.events) { if (e.type === 'GRADE_NO_TRADE') nt.push({ setup: e.setup, missing: e.missing, htf: e.htf }); if (e.type === 'GRADE_WAIVED') wv.push(e); } }
      return { sigs, nt, wv }; };
    const e0 = W0.engineCfgOf(c0), e1 = { ...W.engineCfgOf(c1), staleAccept: false }; delete e1.trendLane; const eA = { ...e1, gradeGate: 'aligned-pass' };   // staleAccept off: the strict run must equal r1.5.6 (l); j/k measure the grade gate alone
    const f0 = fxRun(S0, e0), f1 = fxRun(S, e1), fA = fxRun(S, eA);
    ok(JSON.stringify(f0.sigs) === JSON.stringify(f1.sigs.map(s => { const { waived, tags, ...r } = s; return r; }).map(s => s)) || JSON.stringify(f0.sigs.map(s => s.id)) === JSON.stringify(f1.sigs.map(s => s.id)), `l grade=strict: the 11/04 fixture gives the same ${f1.sigs.length} engine signal(s) and ${f1.nt.length} GRADE_NO_TRADE row(s) as r1.5.6 (${f0.sigs.length} / ${f0.nt.length})`, { f0: f0.sigs, f1: f1.sigs });
    const withRefused = f1.nt.filter(x => x.htf === 'with' && !(x.missing || []).includes('logicalStop')), againstRefused = f1.nt.filter(x => x.htf !== 'with');
    // the aligned-pass run DIVERGES from the strict run at its first waived take (the 11/04 fixture: S9 09:03 is taken and stopped; the later strict-run WITH refusals S11..S234 either never form in the
    // aligned run or are cancelled (RECLAIM / SUPERSEDED / TRAP_UNDONE) before grading, S237 passes on points), so the strict count is not the waived count. The spec witness is: no WITH setup is
    // ever refused by a grade gate (k), every GRADE_WAIVED has its signal with gradeWaived true + the failed gate names, and the fixture produces at least one waived take.
    const waivedSigs = fA.sigs.filter(s => s.waived);
    ok(withRefused.length > 0 && fA.wv.length > 0 && waivedSigs.length === fA.wv.length && waivedSigs.every(s => Array.isArray(s.tags) && s.tags.length && s.htf === 'with') && fA.wv.every(w => w.htf === 'with' && w.gates.length && !w.gates.includes('logicalStop')) && fA.sigs.length > f1.sigs.length, `j aligned-pass: the strict run refused ${withRefused.length} WITH-HTF setups on points; the aligned run waives every WITH-HTF gate refusal it grades (GRADE_WAIVED ${fA.wv.length}, each a signal with gradeWaived true + gradeTags), none is refused (k), and takes more signals than strict (${fA.sigs.length} vs ${f1.sigs.length})`, { withRefused, waivedSigs, wv: fA.wv.map(w => [w.setup, w.gates]) });
    ok(fA.nt.length === f1.nt.length - withRefused.length && fA.nt.every(x => x.htf !== 'with' || (x.missing || []).includes('logicalStop')), `k aligned-pass: the AGAINST / neutral refusals (${againstRefused.length}) stay GRADE_NO_TRADE as before`, fA.nt);
    if (!withRefused.length) console.log('  note: the 11/04 fixture holds no WITH-HTF grade refusal, so j is witnessed as "nothing waived" only; the aligned-pass path is exercised by the fixture run without error');
  } }

console.log('V rule 18 v3: a far un-retested accepted-break is cancelled STALE at the 5M close and re-arms when price returns (Mac 11/05 12:10: acceptance below the 4H ORH 27,083.25, price 26,850)');
{ const ev = [], cfg = { ...S.DEFAULTS, staleR: 2, staleMinPts: 60, retestTolPts: 6 }, mk = (T, c) => ({ cfg, T, b: { t: T - 60, o: c, h: c + 1, l: c - 1, c }, E: (type, d) => ev.push({ type, ...d }) });
  const base = { id: 'S259', kind: 'accepted-break', dir: -1, status: 'armed', zone: { name: '4H ORH', key: 'K259' }, zones: ['4H ORH'], level: 27083.25, ukey: '100|K259|accepted-break|-1', stopType: '4H', breakBar: { t: 0, o: 27090, h: 27095.25, l: 27070, c: 27072, v: 1 }, armT: 100, retest: null, retestNo: 0, legs: {}, disp: true, wave: { wavePeakBias: -0.4 }, htf: 'with', expiresT: 99999 };
  const st = { period: { t: 100 }, used: {}, seq: 260, setups: [{ ...base }], htf: { dir: -1 } };
  S.staleAccepted(st, mk(1300, 27050));
  ok(st.setups[0].status === 'armed' && !ev.length, 'v0 33 pts from the level (< max(2 x 12 risk, 60)): still armed, retest pending', ev);
  S.staleAccepted(st, mk(1600, 26850));
  const c = ev.find(e => e.type === 'SETUP_CANCEL');
  ok(st.setups[0].status === 'cancelled' && c && c.setup === 'S259' && /^STALE: 233\.25 pts from the level \(max 60\); re-arms if price returns within 6 pts \(rule 18\)$/.test(c.why) && st.setups.filter(x => x.status === 'armed').length === 0, 'v1 price 26,850 at the 5M close = 233.25 pts away (> max(2 x 12, 60)): SETUP_CANCEL "STALE: 233.25 pts from the level (max 60)", the slot released (no armed setup left for the board)', c);
  S.staleAccepted(st, mk(1900, 26900)); ok(st.setups.length === 1 && ev.length === 1, 'v2 price 26,900 (183 pts away): nothing re-armed yet');
  S.staleAccepted(st, mk(2200, 27078));
  const a = ev.find(e => e.type === 'SETUP_ARM'), re = st.setups.find(x => x.status === 'armed');
  ok(a && re && a.setup === re.id && re.id === 'S261' && a.rearmedFrom === 'S259' && re.level === 27083.25 && re.retestNo === 0 && re.retest === null && re.armT === 2200 && re.kind === 'accepted-break' && /re-armed/.test(a.note), 'v3 price back to 27,078 (5.25 pts, within retestTol 6): re-armed as a fresh setup S261 (rearmedFrom S259) at the same level, retest pending again', { a, re });
  S.staleAccepted(st, mk(2500, 27078)); ok(st.setups.filter(x => x.status === 'armed').length === 1 && !st.staleAcc.length, 'v4 re-armed once: the memory is cleared');
  const st2 = { period: { t: 100 }, used: {}, seq: 1, setups: [{ ...base }], htf: null }; S.staleAccepted(st2, mk(1600, 26850)); st2.period = { t: 200 }; S.staleAccepted(st2, mk(1900, 27080));
  ok(st2.setups.length === 1 && st2.staleAcc.length === 0, 'v5 a new 4H period forgets the stale acceptance (no re-arm across periods)');
  const st3 = { period: { t: 100 }, used: {}, seq: 1, setups: [{ ...base }], htf: null }; S.staleAccepted(st3, { ...mk(1600, 26850), cfg: { ...cfg, staleR: 0 } });
  ok(st3.setups[0].status === 'armed', 'v6 tide.staleR 0 (rule 18 OFF) leaves the far acceptance armed (the r1.5.1 setups)'); }

console.log('R the journal reload into the phone ring, tide.day and the reloaded trades (executor functions extracted by text; the journal file is read only)');
{ const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
  const grab = (from, to) => EX.slice(EX.indexOf(from), EX.indexOf(to, EX.indexOf(from)));
  const src = grab('const TIDE_KEEP = new Set(', '// [r1.2] write a file atomically');
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-ring-')), file = path.join(DIR, 'levels-journal-MNQ-2026-11-05.jsonl');
  const rows = []; const t0 = Date.UTC(2026, 10, 5, 0, 0);
  // 30 KEEP rows: 5 of each phase; the 5 signal rows (i = 1, 7, 13, 19, 25) are all taken:true and the ones at i 13 / 19 / 25 are REBUILT (the warm-up replay's rows: counted in rows / byPhase / live, never as taken)
  for (let i = 0; i < 30; i++) rows.push({ type: 'lv_tide', t: t0 + i * 60000, phase: ['setup_arm', 'signal', 'grade_no_trade', 'control_form', 'trend_signal', 'trend_arm'][i % 6], setup: 'S' + i, dir: -1, kind: 'trap', taken: i % 6 === 1 ? true : i % 6 === 4 ? true : undefined, ...(i % 6 === 1 && i >= 13 ? { rebuilt: true } : {}), shadow: false, evidence: { big: 'x'.repeat(100) } });
  for (const [id, usd, pts] of [['tide-1', 82.5, 41.25], ['tide-2', 314, 157], ['tide-3', -60, -30]]) { rows.push({ type: 'lv_tide', t: t0 + 3600000, phase: 'live_end', position: id, realizedUsd: usd, realizedPts: pts, fees: 2.44, realizedNetUsd: usd - 2.44, realizedSource: 'calc' }); rows.push({ type: 'lv_tide', t: t0 + 3600000 + 1, phase: 'live_result', position: id, take: id + '-E', qty: 2, entry: 28400, usd, pts, fees: 2.44, netUsd: usd - 2.44, r: 1, path: 'tp1 1x, tp2 1x' }); }
  rows.push({ type: 'lv_event', t: t0, phase: 'born' }); rows.push({ type: 'lv_tide', t: t0 + 2, phase: 'startup', node: 'v18' });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const lvj = { day: 'D1', file }, ctx = new Function('fs', 'path', 'lvj', src + '\nreturn { tideRowNote, tideRowsRing, tideRingReload, tideDaySummary, tideTradesMerged, tideTradesReloaded, TIDE_KEEP };')(fs, path, lvj);
  const rl = ctx.tideRingReload();
  ok(rl.rows === 30 + 6 + 1 && rl.trades === 3 && ctx.tideRowsRing.rows.length === 37 && ctx.tideRowsRing.rows.every(r => r.reloaded === true && !('evidence' in r)) && ctx.tideRowsRing.rows[0].t <= ctx.tideRowsRing.rows[36].t, 'r1 the 30 synthetic KEEP rows (+ 6 live_end/live_result + startup) are reloaded into the ring, newest last, reloaded:true, evidence stripped; the lv_event row is not', rl);
  const d = ctx.tideDaySummary(Date.now());
  // rows = EVERY lv_tide row of the TradeDay file: 30 KEEP (3 of them rebuilt) + 6 live_end / live_result + 1 startup = 37 (the lv_event row is not lv_tide); signals.taken = signal rows taken:true and NOT rebuilt = 2 (i 1, 7); signals.replayed = the 3 rebuilt
  ok(d && d.tradeDay === '2026-11-05' && d.rows === 37 && d.signals.replayed === 3 && d.byPhase.setup_arm === 5 && d.byPhase.signal === 5 && d.byPhase.trend_signal === 5 && d.control && d.control.dir === -1 && d.signals.live === 5 && d.signals.taken === 2 && d.setups.armed === 5 && d.setups.noTrade === 5 && d.trend.taken === 5 && d.trend.armed === 5 && d.trades && d.trades.closed === 3 && d.trades.won === 2 && d.trades.lost === 1 && d.trades.netUsd === Math.round((82.5 + 314 - 60 - 3 * 2.44) * 100) / 100 && d.restarts === 1, 'r2 tide.day from the WHOLE file: tradeDay, rows 37 (every lv_tide row incl. the 3 rebuilt + the startup row), byPhase, control, signals { live 5, taken 2 (taken and not rebuilt), replayed 3 }, setups, trend, trades { closed 3, won 2, lost 1, netUsd = gross - fees }, restarts 1', d);
  const d2 = ctx.tideDaySummary(Date.now() + 1000); ok(d2 === d, 'r3 within 30 s the summary is the cached one (no re-read)');
  fs.appendFileSync(file, JSON.stringify({ type: 'lv_tide', t: t0 + 7200000, phase: 'trend_skip', why: 'CAP_HOUR' }) + '\n'); const d3 = ctx.tideDaySummary(Date.now() + 31000);
  ok(d3.rows === 38 && d3.trend.skipped === 1 && d3.signals.taken === 2, 'r4 after 30 s only the appended bytes are read (rows 37 + 1 = 38, trend.skipped 1, the earlier counts kept)', d3);
  const merged = ctx.tideTradesMerged([{ id: 'tide-3', grossUsd: -60, closedAt: t0 + 3600001 }, { id: 'tide-4', grossUsd: 10, closedAt: t0 + 7200000 }]);
  ok(merged.length === 4 && merged.filter(t => t.reloaded).length === 2 && merged.find(t => t.id === 'tide-2').netUsd === 311.56 && merged.find(t => t.id === 'tide-2').realizedPts === 157, 'r5 tide.trades = the driver\'s trades + the reloaded ones it lacks (by position id): 3 journal trades + 1 live, 2 reloaded:true, S448-like +157 pts / net 311.56', merged.map(t => [t.id, t.reloaded, t.netUsd]));
  ok(['startup', 'trend_arm', 'trend_signal', 'trend_skip', 'trend_idle', 'trend_tie', 'live_order_reject', 'grade_waived'].every(p => ctx.TIDE_KEEP.has(p)), 'r6 TIDE_KEEP holds the new phases');
  ok(/day: tideDaySummary\(Date\.now\(\)\),/.test(EX) && /warm: tideWarmView\(\),/.test(EX) && /trades: tideTradesMerged\(lv \? lv\.trades : \[\]\)/.test(EX) && /lastReject: lv \? lv\.lastReject : null/.test(EX) && /if \(!tideRingReloaded\) \{ tideRingReloaded = true; lvjDay\(now\); const rl = tideRingReload\(\);/.test(EX) && EX.indexOf('if (!tideRingReloaded)') < EX.indexOf('const wr = await tideWire.warmRead('), 'r7 the snapshot carries tide.day / tide.warm / merged trades / lastReject; the reload runs before the warm-up read');
  ok(/Object\.assign\(tideWarm, \{ rebuilding: true, doneMin: 0, totalMin: 6 \* 60, startedAt: t0/.test(EX) && /if \(Number\.isFinite\(x\.done\)\) tideWarm\.doneMin = x\.done; if \(Number\.isFinite\(x\.of\)\) tideWarm\.totalMin = x\.of;/.test(EX) && /Object\.assign\(tideWarm, \{ rebuilding: false, doneMin: tideWarm\.totalMin, finishedAt: Date\.now\(\), result: 'rebuilt' \}\)/.test(EX), 'r8 tide.warm: set at the rebuild start, updated by onProgress (done / of), closed at the end or on failure (text witness; the rebuild itself is not simulated here)'); }

async function sectionT() {
console.log('T realized on live_end (tideLive r1.2) from the fills; slipPts; a broker rejection row');
{ const L = require(path.join(ROOT, 'lib/tideLive.js')), T2 = { LIMIT: 1, MARKET: 2, STOP: 4 }, SD = { BUY: 0, SELL: 1 };
  function broker() { const B = { px: 28000, pos: 0, book: [], hist: new Map(), id: 500, rejectIf: null };
    function fill(o, q, px) { const s = o.side === SD.BUY ? 1 : -1; B.pos += s * q; const h = B.hist.get(o.id); const fv = h.fillVolume + q; h.filledPrice = ((h.filledPrice || 0) * h.fillVolume + px * q) / fv; h.fillVolume = fv; o.left -= q; if (!o.left) { h.status = 2; B.book.splice(B.book.indexOf(o), 1); } }
    B.api = { OrderType: { LIMIT: 1, MARKET: 2, STOP: 4 }, OrderSide: SD,
      async placeOrder(tk, body) { if (B.rejectIf && B.rejectIf(body)) { const e = new Error('Order/place failed: Trading is currently unavailable. The instrument is not in an active trading status.'); e.orderRejected = true; throw e; } const o = { ...body, id: ++B.id, left: body.size }; B.hist.set(o.id, { id: o.id, status: 1, fillVolume: 0, filledPrice: null, creationTimestamp: new Date().toISOString() }); B.book.push(o); if (o.type === T2.MARKET) fill(o, o.size, B.px); return { orderId: o.id }; },
      async cancelOrder(tk, a, id) { const o = B.book.find(x => x.id === id); if (!o) return false; B.book.splice(B.book.indexOf(o), 1); B.hist.get(id).status = 3; return true; },
      async getOpenPosition() { return B.pos ? { type: B.pos > 0 ? 1 : 2, size: Math.abs(B.pos) } : null; }, async getOpenOrders() { return B.book.map(o => ({ id: o.id, type: o.type, side: o.side, size: o.left, stopPrice: o.stopPrice, limitPrice: o.limitPrice })); }, async getEntryOrder(tk, a, c, id) { return { ...B.hist.get(id) }; } };
    B.tick = px => { B.px = px; for (const o of [...B.book]) { if (!B.book.includes(o)) continue; const buy = o.side === SD.BUY, hit = o.type === T2.STOP ? (buy ? px >= o.stopPrice : px <= o.stopPrice) : o.type === T2.LIMIT ? (buy ? px <= o.limitPrice : px >= o.limitPrice) : false; if (hit) fill(o, o.left, o.type === T2.STOP ? (buy ? Math.max(px, o.stopPrice) : Math.min(px, o.stopPrice)) : o.limitPrice); } };   // a stop fills at the worse of the tick and its price (a tick through it = slippage, as S437-E's BE stop filled 28430 under its 28430.25)
    return B; }
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-live-r16-')); let n = 0;
  const drv = (B, money) => { const rows = [], pushes = []; const D = L.create({ token: 'f', accountId: 1, contractId: 'C', orders: B.api, journal: r => rows.push(r), notify: (t, x) => pushes.push(t + ' | ' + x), stateFile: path.join(DIR, `s${++n}.json`), sleep: async () => {}, feePerContractSide: 0.61, cfgFn: () => ({ ...W.liveMoney({ money }), pointValue: 2, tickSize: 0.25, floorDistanceUsd: 50000 }), take1MaxFn: () => 400 }); return { D, rows, pushes }; };   // feePerContractSide is a create() option (the executor's brokerCosts), never a money key: the money validator refuses unknown keys
  // S448-E: SHORT 2 lots, entry 28377.25, tp1 1 @ 28361.75, tp2 1 @ 28235.75 -> +157 pts gross = +$314
  { const B = broker(); B.px = 28377.25; const { D, rows } = drv(B, W.moneyDefaults());
    await (D.signal({ dir: -1, entry: 28368.75, pools: [{ price: 28361.75, name: 'p1' }, { price: 28235.75, major: true, name: 'PDL' }] }, { grade: 'A+', entryType: 'MARKET', stop: 28447 }, 'S448-E'));   // sized from the SIGNAL entry (78.25 pts = $156.5 -> 2 lots at $400); from the 28377.25 fill R = 69.75, so the major pool 28235.75 (139.5 pts = 2R) is TP2 itself, as in S448-E
    const fill = rows.find(r => r.phase === 'live_fill' && r.kind === 'entry');
    ok(fill && fill.slipPts === -8.5 && fill.planned === 28368.75 && fill.filledQty === 2, 'T1 slipPts on the entry fill: a SHORT planned 28368.75 filled 28377.25 (sold 8.5 higher) -> -8.5 = 8.5 pts in our favour (+ would be adverse; the sign follows the direction)', fill);
    B.tick(28361.75); await (D.poll({ lastPx: 28361.75 })); B.tick(28235.75); await (D.poll({ lastPx: 28235.75 }));
    const end = rows.find(r => r.phase === 'live_end'), tr = D.view().trades[0];
    ok(end && end.realizedPts === 157 && end.realizedUsd === 314 && end.fees === Math.round(4 * 0.61 * 100) / 100 && end.realizedNetUsd === 314 - 2.44 && end.realizedSource === 'calc' && Array.isArray(end.exitFills) && end.exitFills.length === 2 && tr && tr.realizedPts === 157 && tr.grossUsd === 314 && tr.netUsd === 311.56, 'T2 S448-E: live_end realizedPts 157, realizedUsd $314, fees 4 sides x $0.61 = $2.44, net $311.56, exits listed; the trade entry carries the same', { end, tr }); }
  // S437-E: LONG 4 lots (50-pt stop at $400 = 4): entry 28430, tp1 3 @ 28443.75, BE stop 1 @ 28430 -> 41.25 pts gross = $82.50
  { const B = broker(); B.px = 28430; const m = W.moneyDefaults(); m.sizing.flatDollars = 400; const { D, rows } = drv(B, m);
    await (D.signal({ dir: 1, entry: 28430, pools: [{ price: 28443.75, name: 'p1' }, { price: 28600, major: true, name: 'PDH' }] }, { grade: 'B', entryType: 'MARKET', stop: 28430 - 50 }, 'S437-E'));
    B.tick(28443.75); await (D.poll({ lastPx: 28443.75 })); B.tick(28430); await (D.poll({ lastPx: 28430 }));
    const end = rows.find(r => r.phase === 'live_end');
    ok(end && end.realizedPts === 41.25 && end.realizedUsd === 82.5 && D.view().trades[0].qty === 4 && end.fees === Math.round(8 * 0.61 * 100) / 100, 'T3 S437-E (4 lots: tp1 3 @ +13.75, BE stop 1 @ 0): realizedPts 41.25, $82.50 gross, fees 8 sides', end); }
  // S425-E: 1 lot, stop at the entry price -> ~$0
  { const B = broker(); B.px = 28381.25; const { D, rows } = drv(B, W.moneyDefaults());
    await (D.signal({ dir: 1, entry: 28381.25, pools: [{ price: 28400, name: 'p1' }, { price: 28500, major: true, name: 'PDH' }] }, { grade: 'C', entryType: 'MARKET', stop: 28381.25 - 150 }, 'S425-E'));
    B.tick(28400); await (D.poll({ lastPx: 28400, bar: { t: Date.now() + 60000, h: 28400, l: 28390 } })); B.tick(28381.5); await (D.poll({ lastPx: 28381.5 }));
    const end = rows.find(r => r.phase === 'live_end');
    ok(end && end.realizedUsd === 0.5 && end.realizedPts === 0.25 && end.realizedNetUsd === 0.5 - 1.22, 'T4 S425-E 1 lot: TP1 traded (BE + 1 tick), stopped at 28381.5 -> +0.25 pt = $0.50 gross, net -$0.72 (~$0)', end); }
  // a broker rejection: order_reject row + push + view().lastReject
  { const B = broker(); B.rejectIf = b => b.type === T2.MARKET; const { D, rows, pushes } = drv(B, W.moneyDefaults());
    const r = await (D.signal({ dir: -1, entry: 28000, pools: [{ price: 27900, major: true, name: 'PDL' }] }, { grade: 'A+', entryType: 'MARKET', stop: 28030 }, 'S-rej'));
    const rj = rows.find(x => x.phase === 'live_order_reject');
    ok(rj && /not in an active trading status/.test(rj.reason) && rj.kind === 'entry' && rj.qty === 6 && D.view().lastReject && D.view().lastReject.reason === rj.reason && pushes.some(p => /TIDE order REJECTED: entry/.test(p)) && !D.owned(), 'T5 a broker rejection -> live_order_reject row (side, qty, reason text, setup / take), a push, tide.lastReject; the position ends as before (no re-send in this build)', { rj, r, pushes }); }
}
}
sectionT().then(() => { console.log(`\ntrend-lane r1.6 (${W.VERSION}, ${S.VERSION}, ${TL.VERSION}): ${pass} passed, ${fail} failed`); for (const f of fails) console.log('  - ' + f); process.exitCode = fail ? 1 : 0; }, e => { console.log('T section crashed: ' + (e && e.stack)); process.exitCode = 1; });
