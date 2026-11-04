'use strict';
// node tests/money.test.cjs  (pure lib tests for lib/moneyRule.js money-r4: sizing modes flat/grade + shadow, noFit, entry by grade + grade-upgrade add (D5),
// fail-closed lifecycle, placeable protection, exits D'', option C, config, startup line, no day limit)
// r3 changes to the r2 groups (D5 / playbook §22): the A+-only scale-in group became the entry-by-grade group; the startup text; the version.
// r4 changes to earlier groups (MacDot review + team sizing position): gradeOf now fails closed; protectStop / structuralTrail need lastPx; secondLeg needs
// structuralStop; startup text; version; the D5 upgrade groups were rewritten for the reservation contract. ON keeps the grade-mode behaviour explicit.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib', 'moneyRule.js');
const M = require(LIB);
let n = 0, failed = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message); } };
// ON = the r2/r3 behaviour made explicit under r4: grade dollars, D5 entry by grade, the grade-upgrade add on. FLAT = the r4 defaults with sizing on.
const ON = { sizing: { enabled: true, mode: 'grade', flatDollars: 450, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, noFit: 'skip', entryByGrade: true, scaleInB: true, upgradeAdd: { enabled: true } },
  exits: { partialFrac: 2 / 3, trailBufferPts: 2, protect: { enabled: true, startR: 1, stepR: 0.5, trailR: 1, structural15m: true, climax: true, climaxVolMult: 2 } } };
const withS = (s) => ({ ...ON, sizing: { ...ON.sizing, ...s } });
const withE = (e) => ({ ...ON, exits: { ...ON.exits, ...e } });

t('grade size table A+ $900', () => {
  for (const [s, c] of [[25, 18], [60, 7], [120, 3], [225, 2], [450, 1]]) assert.strictEqual(M.sizeFor(s, 'A+', ON).contracts, c, `stop ${s}`);
  const nf = M.sizeFor(451, 'A+', ON); assert.strictEqual(nf.contracts, 0); assert.strictEqual(nf.code, 'GRADE_NO_FIT'); assert.strictEqual(nf.reason, 'grade-no-fit');
  assert.strictEqual(M.sizeFor(25, 'A', ON).contracts, 18);   // 'A' and 'A+' are the same config key
  assert.strictEqual(M.sizeFor(25, 'A+', ON).riskUsd, 900); assert.strictEqual(M.sizeFor(60, 'A+', ON).riskUsd, 840);
});
t('grade size tables B $600 / C $300', () => {
  for (const [s, c] of [[25, 12], [60, 5], [120, 2], [300, 1]]) assert.strictEqual(M.sizeFor(s, 'B', ON).contracts, c, `B stop ${s}`);
  assert.strictEqual(M.sizeFor(300.25, 'B', ON).code, 'GRADE_NO_FIT');
  for (const [s, c] of [[25, 6], [60, 2], [120, 1], [150, 1]]) assert.strictEqual(M.sizeFor(s, 'C', ON).contracts, c, `C stop ${s}`);
  assert.strictEqual(M.sizeFor(150.25, 'C', ON).code, 'GRADE_NO_FIT');
  for (const g of ['A+', 'B', 'C']) for (let s = 0.25; s <= 500; s += 0.25) { const z = M.sizeFor(s, g, ON); assert.ok(z.riskUsd <= z.gradeRiskUsd + 1e-9, `${g} ${s}`); assert.strictEqual(z.stopPts, s, 'the stop is never moved'); }
  assert.strictEqual(M.sizeFor(25, 'D', ON).reason, 'invalid-grade'); assert.strictEqual(M.sizeFor(0, 'B', ON).reason, 'invalid-stop'); assert.strictEqual(M.sizeFor(NaN, 'B', ON).contracts, 0);
});
t('maxContracts cap', () => {
  const z = M.sizeFor(10, 'A+', ON); assert.strictEqual(z.contracts, 30); assert.strictEqual(z.reason, 'grade-max-contracts'); assert.strictEqual(z.riskUsd, 600);
  assert.strictEqual(M.sizeFor(15, 'A+', ON).contracts, 30); assert.strictEqual(M.sizeFor(15.25, 'A+', ON).contracts, 29);
  assert.strictEqual(M.sizeFor(10, 'A+', withS({ maxContracts: 5 })).contracts, 5); assert.strictEqual(M.DEFAULTS.sizing.maxContracts, 30);
});
t('per-account dollars (50K example)', () => {
  const c = withS({ gradeRiskUsd: { A: 300, B: 200, C: 100 } });
  assert.strictEqual(M.sizeFor(25, 'A+', c).contracts, 6); assert.strictEqual(M.sizeFor(25, 'C', c).contracts, 2); assert.strictEqual(M.sizeFor(50.25, 'C', c).code, 'GRADE_NO_FIT');
});
t('gradeOf is deprecated and FAILS CLOSED: money never grades (finding 1; GRADE r3 belongs to the structure engine)', () => {
  const all = { control4h: true, trapAtPool: true, displacementShift: true, firstRetest: true };
  // MacDot's witnesses: r3 gave B with control4h false, and A+ with validTrigger omitted. Both are now no trade.
  assert.strictEqual(M.gradeOf({ ...all, control4h: false }).grade, null);
  assert.strictEqual(M.gradeOf(all).grade, null);
  for (const ev of [{ ...all, validTrigger: true }, {}, null, undefined, { ...all, validTrigger: false }]) { const g = M.gradeOf(ev); assert.strictEqual(g.grade, null); assert.strictEqual(g.reason, 'GRADE_NOT_IN_MONEY'); assert.strictEqual(g.deprecated, true); }
  assert.strictEqual(M.GRADE_PARTS, undefined);   // the r2 grade parts are gone
  assert.strictEqual(M.sizeFor(25, M.gradeOf(all).grade, ON).contracts, 0);   // a caller that still grades through money gets no trade, not a size
});
t('entry by grade (D5, §22): A+ all at once, B half + half at the B dollars, C one entry', () => {
  let p = M.scaleInPlan(25, 'A+', ON); assert.deepStrictEqual([p.total, p.first, p.second, p.scaleIn, p.style], [18, 18, 0, false, 'all-at-once']);
  p = M.scaleInPlan(60, 'A+', ON); assert.deepStrictEqual([p.total, p.first, p.second], [7, 7, 0]);
  p = M.scaleInPlan(25, 'B', ON); assert.deepStrictEqual([p.total, p.first, p.second, p.scaleIn, p.style], [12, 6, 6, true, 'scale-in']);
  p = M.scaleInPlan(60, 'B', ON); assert.deepStrictEqual([p.total, p.first, p.second], [5, 3, 2]);   // half rounded up
  p = M.scaleInPlan(120, 'B', ON); assert.deepStrictEqual([p.total, p.first, p.second], [2, 1, 1]);
  p = M.scaleInPlan(300, 'B', ON); assert.deepStrictEqual([p.total, p.first, p.second, p.scaleIn, p.style], [1, 1, 0, false, 'one-entry']);   // a 1-lot still trades on the trigger
  p = M.scaleInPlan(300.25, 'B', ON); assert.deepStrictEqual([p.total, p.first, p.code], [0, 0, 'GRADE_NO_FIT']);
  p = M.scaleInPlan(25, 'C', ON); assert.deepStrictEqual([p.total, p.first, p.second, p.style], [6, 6, 0, 'one-entry']);
  p = M.scaleInPlan(25, 'B', withS({ scaleInB: false })); assert.deepStrictEqual([p.first, p.second, p.style], [12, 0, 'one-entry']);
  // long B: first 6 @ 20000 stop 19975; the rest at the retest 19990 (closer to the stop): 6 x 25 x 2 = 300 + 6 x 15 x 2 = 180 -> 480 <= 600, as planned
  let s = M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 }, ON);
  assert.strictEqual(s.contracts, 6); assert.strictEqual(s.combinedRiskUsd, 480); assert.strictEqual(s.stop, 19975); assert.strictEqual(s.gradeRiskUsd, 600); assert.strictEqual(s.reason, 'as-planned');
  // first fill slipped 5 pts worse (30 pts risk): 6 x 30 x 2 = 360, room 240 at 15 pts -> 8 > planned 6 -> 6
  s = M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20005, firstContracts: 6, entry2: 19990, plannedSecond: 6, grade: 'B' }, ON); assert.strictEqual(s.contracts, 6); assert.strictEqual(s.combinedRiskUsd, 540);
  // second entry worse than the first (40 pts): room 300 / 80 = 3 -> sized down
  s = M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 6, entry2: 20015, plannedSecond: 6 }, ON); assert.strictEqual(s.contracts, 3); assert.strictEqual(s.reason, 'sized-down');
  // short mirror
  s = M.secondLeg({ dir: -1, stop: 20025, structuralStop: 20025, firstFill: 20000, firstContracts: 6, entry2: 20010, plannedSecond: 6 }, ON); assert.strictEqual(s.contracts, 6); assert.strictEqual(s.combinedRiskUsd, 480);
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19970, plannedSecond: 6 }, ON).contracts, 0);   // at/through the stop
  s = M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 12, entry2: 19990, plannedSecond: 6 }, ON); assert.strictEqual(s.contracts, 0); assert.strictEqual(s.reason, 'no-room');   // 12 x 50 = 600
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 }, withS({ maxContracts: 7 })).contracts, 1);
  const c = M.combine([{ price: 20000, contracts: 6 }, { price: 19990, contracts: 6 }]); assert.strictEqual(c.contracts, 12); assert.strictEqual(c.avgEntry, 19995);
});
t('targetFor: nearest pool >= 2R; A+ major pool; none -> 2R', () => {
  // long 20000, stop 19975 (R 25): 2R = 20050
  const pools = [{ price: 20030 }, { price: 20062.6, name: 'EQH' }, { price: 20100, major: true, name: 'PDH' }, { price: 20150, major: true }];
  let r = M.targetFor(20000, 19975, 1, pools, 'B', ON); assert.strictEqual(r.price, 20062.5); assert.strictEqual(r.basis, 'pool'); assert.strictEqual(r.pool.name, 'EQH');   // inside the pool (toward entry, on the tick)
  r = M.targetFor(20000, 19975, 1, pools, 'A+', ON); assert.strictEqual(r.price, 20100); assert.strictEqual(r.basis, 'major-pool'); assert.strictEqual(r.rr, 4);
  r = M.targetFor(20000, 19975, 1, [{ price: 20030 }], 'B', ON); assert.strictEqual(r.price, 20050); assert.strictEqual(r.basis, '2R'); assert.strictEqual(r.rr, 2);
  r = M.targetFor(20000, 19975, 1, [{ price: 20050.1 }], 'C', ON); assert.strictEqual(r.price, 20050);   // rounding toward entry never goes under 2R
  r = M.targetFor(20000, 19975, 1, [{ price: 20070 }], 'A+', ON); assert.strictEqual(r.price, 20070); assert.strictEqual(r.basis, 'pool');   // A+ with no major beyond 2R: the nearest pool beyond 2R
  r = M.targetFor(20000, 19975, 1, [], 'A+', ON); assert.strictEqual(r.price, 20050);
  // short mirror: entry 20000 stop 20025: 2R 19950
  r = M.targetFor(20000, 20025, -1, [{ price: 19970 }, { price: 19937.4 }, { price: 19900, major: true }], 'B', ON); assert.strictEqual(r.price, 19937.5);
  r = M.targetFor(20000, 20025, -1, [{ price: 19970 }, { price: 19937.4 }, { price: 19900, major: true }], 'A+', ON); assert.strictEqual(r.price, 19900);
  assert.strictEqual(M.targetFor(20000, 20010, 1, [], 'B', ON), null);   // stop on the wrong side
  for (const g of ['A+', 'B', 'C']) for (let pp = 19990; pp < 20200; pp += 1.3) { const z = M.targetFor(20000, 19975, 1, [{ price: pp, major: pp > 20100 }], g, ON); assert.ok(z.rr >= 2 - 1e-9); }
});
t('partialFor: TP1 at the first internal pool <= 1R, else 1R; 2/3 rounded', () => {
  let p = M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20062.5, pools: [{ price: 20018.1, name: 'swing H' }, { price: 20040 }], contracts: 18 }, ON);
  assert.strictEqual(p.price, 20018); assert.strictEqual(p.basis, 'pool'); assert.strictEqual(p.contracts, 12); assert.strictEqual(p.rest, 6);
  p = M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20062.5, pools: [{ price: 20040 }], contracts: 7 }, ON);
  assert.strictEqual(p.price, 20025); assert.strictEqual(p.basis, '1R'); assert.strictEqual(p.contracts, 5); assert.strictEqual(p.rest, 2);
  p = M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20062.5, pools: [{ price: 19990 }, { price: 20000.1 }], contracts: 3 }, ON);   // behind / at entry do not count
  assert.strictEqual(p.basis, '1R'); assert.strictEqual(p.contracts, 2); assert.strictEqual(p.rest, 1);   // Mac: "2 out of 3"
  assert.deepStrictEqual([2, 4, 5, 6, 9, 12].map(k => M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20050, pools: [], contracts: k }, ON).contracts), [1, 3, 3, 4, 6, 8]);
  p = M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20062.5, pools: [], contracts: 1 }, ON); assert.strictEqual(p.contracts, 0); assert.strictEqual(p.rest, 1);   // a 1-lot rides to TP2
  p = M.partialFor({ entry: 20000, stop: 20025, dir: -1, tp: 19937.5, pools: [{ price: 19988.1 }], contracts: 6 }, ON); assert.strictEqual(p.price, 19988.25); assert.strictEqual(p.contracts, 4);
  p = M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20050, pools: [], contracts: 10 }, withE({ partialFrac: 0.5 })); assert.strictEqual(p.contracts, 5);
  for (let k = 2; k <= 30; k++) { const z = M.partialFor({ entry: 20000, stop: 19975, dir: 1, tp: 20050, pools: [], contracts: k }, ON); assert.ok(z.contracts >= 1 && z.rest >= 1, `${k}`); }
});
t('break-even after the partial', () => {
  assert.strictEqual(M.beStopAfterPartial(20000, 1, ON), 20000.25); assert.strictEqual(M.beStopAfterPartial(20000, -1, ON), 19999.75);
  assert.strictEqual(M.beStopAfterPartial(19995.1, 1, ON), 19995.5); assert.strictEqual(M.beStopAfterPartial(19995.1, -1, ON), 19994.75);   // average entry off the tick: toward profit
});
t('R-ladder (protectStop)', () => {
  const L = (bestPx, currentStop = 19975, dir = 1, entry = 20000, lastPx = bestPx) => M.protectStop({ entry, R: 25, dir, bestPx, currentStop, lastPx, cfg: ON });   // r4: lastPx required
  assert.strictEqual(L(20024.75).moved, false); assert.strictEqual(L(20024.75).reason, 'below-start');
  assert.strictEqual(L(20025).stop, 20000.25); assert.strictEqual(L(20037).stop, 20000.25);   // +1R: BE + 1 tick
  assert.strictEqual(L(20037.5).stop, 20012.5); assert.strictEqual(L(20049.75).stop, 20012.5);   // +1.5R: lock 0.5R
  assert.strictEqual(L(20050).stop, 20025); assert.strictEqual(L(20062.5).stop, 20037.5); assert.strictEqual(L(20100).stop, 20075);   // +2R lock 1R, then best - 1R in 0.5R steps
  assert.strictEqual(L(20050, 20030).stop, 20030); assert.strictEqual(L(20050, 20030).reason, 'not-in-favour');   // never widens
  assert.strictEqual(L(19962.5, 20025, -1).stop, 19987.5); assert.strictEqual(L(19950, 20025, -1).stop, 19975);   // short mirror
  assert.strictEqual(M.protectStop({ entry: 20000, R: 25, dir: 1, bestPx: 20100, currentStop: 19975, cfg: withE({ protect: { ...ON.exits.protect, enabled: false } }) }).stop, 19975);
  // property (GROSS mark-at-stop: the stop rests in time and fills at its price): touched +1R closes >= BE + 1 tick, touched +2R closes >= +1R, on random paths
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 400; k++) {
    const dir = k % 2 ? 1 : -1, entry = 20000, R = 10 + Math.floor(rnd() * 100), cfg = ON; let stop = entry - dir * R, best = entry, maxR = 0, out = null, px = entry;
    for (let i = 0; i < 300 && out === null; i++) {
      px = M.roundTick(px + dir * (rnd() - 0.47) * R * 0.6, 0.25);
      if (dir * (px - stop) <= 0) { out = stop; break; }
      if (dir * (px - best) > 0) best = px; maxR = Math.max(maxR, dir * (best - entry) / R);
      stop = M.protectStop({ entry, R, dir, bestPx: best, currentStop: stop, lastPx: px, cfg }).stop;
    }
    if (out === null) continue;
    const res = dir * (out - entry);
    if (maxR >= 1) assert.ok(res > 0, `touched ${maxR.toFixed(2)}R closed ${res}`);
    if (maxR >= 2) assert.ok(res >= R - 1e-9, `touched ${maxR.toFixed(2)}R closed ${res} < 1R ${R}`);
  }
});
t('structural 15m trail (after a major sweep only) and climax tighten; minor swings never move the stop', () => {
  const sw15 = [{ type: 'L', price: 20020, t: 1 }, { type: 'H', price: 20060, t: 2 }, { type: 'L', price: 20040, t: 3 }];
  let r = M.structuralTrail({ dir: 1, currentStop: 20000.25, swings15m: sw15, majorSwept: false, cfg: ON }); assert.strictEqual(r.moved, false); assert.strictEqual(r.reason, 'no-major-sweep');
  r = M.structuralTrail({ dir: 1, currentStop: 20000.25, swings15m: sw15, majorSwept: true, lastPx: 20070, cfg: ON }); assert.strictEqual(r.stop, 20038);
  r = M.structuralTrail({ dir: 1, currentStop: 20045, swings15m: sw15, majorSwept: true, cfg: ON }); assert.strictEqual(r.stop, 20045);   // only if tighter
  r = M.structuralTrail({ dir: 1, currentStop: 20000.25, swings15m: sw15, majorSwept: true, lastPx: 20037, cfg: ON }); assert.strictEqual(r.stop, 20000.25);   // never through the market
  r = M.structuralTrail({ dir: -1, currentStop: 20100, swings15m: [{ type: 'H', price: 20050, t: 1 }], majorSwept: true, lastPx: 20040, cfg: ON }); assert.strictEqual(r.stop, 20052);   // r4: lastPx required
  // climax: 20 quiet bars (v 100), then a push, then a high-volume bar that pushes less and closes back toward the middle
  const bars = []; for (let i = 0; i < 21; i++) bars.push({ o: 20000 + i, h: 20003 + i, l: 19998 + i, c: 20001 + i, v: 100 });
  bars.push({ o: 20021, h: 20040, l: 20020, c: 20038, v: 150 }); bars.push({ o: 20038, h: 20045, l: 20030, c: 20036, v: 250 });
  assert.strictEqual(M.isClimax(bars, 1, ON).climax, true);
  assert.strictEqual(M.isClimax(bars.slice(0, -1).concat([{ ...bars[bars.length - 1], v: 150 }]), 1, ON).climax, false);   // volume < 2x median
  assert.strictEqual(M.isClimax(bars.slice(0, -1).concat([{ ...bars[bars.length - 1], c: 20044 }]), 1, ON).climax, false);   // closed at the extreme
  assert.strictEqual(M.isClimax(bars, -1, ON).climax, false);
  r = M.climaxTighten({ dir: 1, currentStop: 20000.25, climax: true, swings5m: [{ type: 'L', price: 20030, t: 9 }], lastPx: 20036, cfg: ON }); assert.strictEqual(r.stop, 20028);
  r = M.climaxTighten({ dir: 1, currentStop: 20000.25, climax: false, swings5m: [{ type: 'L', price: 20030, t: 9 }], cfg: ON }); assert.strictEqual(r.moved, false);
  const ns = M.nextStop({ dir: 1, entry: 20000, R: 25, bestPx: 20051, currentStop: 19975, majorSwept: true, swings15m: sw15, climax: true, swings5m: [{ type: 'L', price: 20030, t: 9 }], lastPx: 20050, cfg: ON });
  assert.strictEqual(ns.stop, 20038); assert.strictEqual(ns.by, 'structural-15m');   // the tightest of ladder 20025 / 15m 20038 / climax 20028
  assert.strictEqual(M.nextStop({ dir: 1, entry: 20000, R: 25, bestPx: 20010, currentStop: 19975, swings5m: [{ type: 'L', price: 20008, t: 1 }], lastPx: 20010, cfg: ON }).stop, 19975);   // a minor 5m swing alone moves nothing
});
t('pyramid add (addAllowed): house money only, once, after TP1, trend still ours', () => {
  const base = { dir: -1, runner: { entry: 28366.75, contracts: 1 }, originalContracts: 3, addPx: 28172.5, stop: 28220.5, tp2: 28035.25, tp1Done: true, addsDone: 0,
    bias: { m15: -0.3, m30: -0.25, line: 0.15 }, control4h: -1, rejection: true, cfg: ON };
  let a = M.addAllowed(base); assert.strictEqual(a.ok, true); assert.strictEqual(a.qty, 1); assert.strictEqual(a.code, 'ADD_OK');
  assert.strictEqual(a.combined.contracts, 2); assert.strictEqual(a.combined.avgEntry, 28269.625); assert.strictEqual(a.combined.atStopUsd, 196.5);   // 146.25 locked - 48 risk = +98.25 pts
  a = M.addAllowed({ ...base, stop: 28366.5 }); assert.strictEqual(a.ok, false); assert.strictEqual(a.reason, 'not-house-money'); assert.strictEqual(a.code, 'ADD_SKIP'); assert.ok(a.combined.atStopUsd < 0);
  for (const [k, v, why] of [['tp1Done', false, 'before-tp1'], ['addsDone', 1, 'already-added'], ['control4h', 1, '4h-control-changed'], ['rejection', false, 'no-rejection'],
    ['bias', { m15: -0.1, m30: -0.05, line: 0.15 }, 'bias-not-ours'], ['bias', { m15: -0.3, m30: 0.2, line: 0.15 }, 'bias-not-ours'], ['addPx', 28030, 'tp2-reached'], ['addPx', 28230, 'stop-not-behind-add']])
    assert.strictEqual(M.addAllowed({ ...base, [k]: v }).reason, why, `${k}`);
  assert.deepStrictEqual([1, 2, 3, 4, 6, 18].map(M.addQty), [1, 1, 1, 1, 2, 6]);
  assert.strictEqual(M.addAllowed({ ...base, runner: { entry: 28366.75, contracts: 30 }, originalContracts: 30 }).reason, 'max-contracts');
  // long mirror
  a = M.addAllowed({ dir: 1, runner: { entry: 20000, contracts: 2 }, originalContracts: 6, addPx: 20040, stop: 20025, tp2: 20100, tp1Done: true, bias: { m15: 0.2, m30: 0.1, line: 0.15 }, control4h: true, rejection: true, cfg: ON });
  assert.strictEqual(a.ok, true); assert.strictEqual(a.qty, 2); assert.strictEqual(a.combined.atStopUsd, 40);   // 2 x 25 - 2 x 15 = 20 pts
});
// The 11/04 witness (playbook §3): short 3 MNQ at 28366.75, 4H stop 28513 (R 146.25), 1m closes 16:08-17:06 with the 16:55 bounce high 28196.5.
const WITNESS = [28366.75, 28341.25, 28353.25, 28338, 28343.25, 28335.75, 28326, 28315.5, 28313.75, 28304.25, 28267.5, 28239, 28232.75, 28223.75, 28239.75, 28243.25, 28212, 28180,
  28177.25, 28135.5, 28132.75, 28137, 28149.75, 28136.5, 28090, 28093, 28066, 28052.75, 28054.75, 28053.5, 28044.5, 28083, 28079, 28082.25, 28070.5, 28067, 28082, 28090.5, 28124.5,
  28116.5, 28128, 28143.25, 28145, 28149.75, 28156.75, 28162.75, 28167.75, 28196.5 /* 16:55 high */, 28190.75, 28172.5 /* 16:56 rejection: the add */, 28168.75, 28168, 28153.25,
  28149.5, 28150, 28163.5, 28068.75, 28071.25, 27986.5, 27896.5];
function runTrade(o) {
  const dir = o.dir, plan = M.planExits({ dir, entry: o.entry, contracts: o.contracts, stop: o.stop, pools: o.pools, grade: o.grade }, ON), R = plan.R, log = [];
  let open = plan.contracts, avg = plan.avgEntry, stop = plan.stop, pnl = 0, tp1 = false, adds = 0, best = o.entry, bestSince = o.entry, stopMin = null;
  for (let i = 0; i < o.path.length; i++) {
    const px = o.path[i];
    if (dir * (px - stop) <= 0) { pnl += open * dir * (stop - avg) * 2; log.push(['stopped', i, stop, open]); open = 0; break; }
    if (!tp1 && plan.partial.contracts > 0 && dir * (px - plan.partial.price) >= 0) { pnl += plan.partial.contracts * dir * (plan.partial.price - avg) * 2; open -= plan.partial.contracts; tp1 = true; stop = M.stopOnlyInFavour(stop, plan.beStop, dir); log.push(['tp1', i, plan.partial.price, plan.partial.contracts]); }
    if (dir * (px - plan.tp.price) >= 0) { pnl += open * dir * (plan.tp.price - avg) * 2; log.push(['tp2', i, plan.tp.price, open]); open = 0; break; }
    if (o.addAt === i) {
      const a = M.addAllowed({ dir, runner: { entry: avg, contracts: open }, originalContracts: plan.contracts, addPx: px, stop, tp2: plan.tp.price, tp1Done: tp1, addsDone: adds, bias: { m15: dir * 0.3, m30: dir * 0.3, line: 0.15 }, control4h: dir, rejection: true, cfg: ON });
      log.push(['add', i, px, a.ok ? a.qty : 0, a.reason]);
      if (a.ok) { avg = a.combined.avgEntry; open += a.qty; adds++; bestSince = px; }
    }
    if (dir * (px - best) > 0) best = px; if (dir * (px - bestSince) > 0) bestSince = px;
    const was = stop; stop = M.nextStop({ dir, entry: avg, R, bestPx: adds ? bestSince : best, currentStop: stop, lastPx: px, cfg: ON }).stop;
    assert.ok(dir * stop >= dir * was, 'stops only tighten');
    stopMin = stop;
  }
  return { pnl, open, stop: stopMin, log, plan };
}
t('11/04 witness: survives the 16:45 bounce to 28196.5 and reaches PDL 28035.25 (2 off at 28306, add 1 on the rejection, 2 out at PDL)', () => {
  const pools = [{ price: 28306, name: 'swing L' }, { price: 28104.25, name: 'London Low' }, { price: 28035.25, major: true, name: 'PDL' }];
  const r = runTrade({ dir: -1, entry: 28366.75, stop: 28513, contracts: 3, grade: 'B', pools, path: WITNESS, addAt: 49 });
  assert.strictEqual(r.plan.R, 146.25); assert.strictEqual(r.plan.tp.price, 28035.25); assert.strictEqual(r.plan.partial.price, 28306); assert.strictEqual(r.plan.partial.contracts, 2);
  const kinds = r.log.map(x => x[0]); assert.deepStrictEqual(kinds, ['tp1', 'add', 'tp2'], JSON.stringify(r.log));
  assert.deepStrictEqual(r.log[1].slice(2, 5), [28172.5, 1, 'house-money']); assert.deepStrictEqual(r.log[2].slice(2), [28035.25, 2]);
  assert.strictEqual(r.pnl, 2 * 60.75 * 2 + 331.5 * 2 + 137.25 * 2);   // $1,180.50
  // without the add: the ladder alone still holds through the bounce (stop 28220.5 = +1R locked at 2.2R best) and reaches PDL
  const r2 = runTrade({ dir: -1, entry: 28366.75, stop: 28513, contracts: 3, grade: 'B', pools, path: WITNESS });
  assert.deepStrictEqual(r2.log.map(x => x[0]), ['tp1', 'tp2']); assert.strictEqual(r2.pnl, 2 * 60.75 * 2 + 331.5 * 2);
  // a continuous lock (best - 1R with no 0.5R steps) would have been stopped by the bounce: the step matters
  const cont = 28044.5 + 146.25; assert.ok(cont < 28196.5 && 28220.5 > 28196.5);
});
t('house-money refusal on the path: the add is skipped while the runner only has break-even locked', () => {
  const pools = [{ price: 28306, name: 'swing L' }, { price: 28035.25, major: true, name: 'PDL' }];
  const r = runTrade({ dir: -1, entry: 28366.75, stop: 28513, contracts: 3, grade: 'B', pools, path: WITNESS.slice(0, 14).concat([28250, 28290]), addAt: 15 });   // best 28223.75 = 0.98R: stop BE+tick
  const add = r.log.find(x => x[0] === 'add'); assert.ok(add); assert.strictEqual(add[3], 0); assert.strictEqual(add[4], 'not-house-money');
});
t('planExits: scaled-in combined position; risk-free after TP1', () => {
  const plan = M.planExits({ dir: 1, legs: [{ price: 20000, contracts: 9 }, { price: 19990, contracts: 9 }], stop: 19975, pools: [{ price: 20010 }, { price: 20080, major: true }], grade: 'A+' }, ON);
  assert.strictEqual(plan.contracts, 18); assert.strictEqual(plan.avgEntry, 19995); assert.strictEqual(plan.tp.price, 20080); assert.strictEqual(plan.partial.price, 20010); assert.strictEqual(plan.partial.contracts, 12);
  assert.deepStrictEqual(plan.legs, { leg1: 12, leg2: 6, runner: 0 }); assert.strictEqual(plan.beStop, 19995.25); assert.strictEqual(plan.addQty, 6); assert.strictEqual(plan.R, 20);
  const r = M.planExits({ dir: 1, entry: 20000, contracts: 3, stop: 19975, pools: [], grade: 'B' }, ON); assert.strictEqual(r.tp.price, 20050); assert.strictEqual(r.partial.price, 20025);
  let s = runTrade({ dir: 1, entry: 20000, stop: 19975, contracts: 3, grade: 'B', pools: [], path: [20010, 20025, 20010, 19999] });
  assert.deepStrictEqual(s.log.map(x => x[0]), ['tp1', 'stopped']); assert.strictEqual(s.pnl, 2 * 25 * 2 + 1 * 0.25 * 2);
  s = runTrade({ dir: 1, entry: 20000, stop: 19975, contracts: 3, grade: 'B', pools: [], path: [19990, 19975] }); assert.strictEqual(s.pnl, -150);
  s = runTrade({ dir: 1, entry: 20000, stop: 19975, contracts: 3, grade: 'B', pools: [], path: [20025, 20050] }); assert.strictEqual(s.pnl, 2 * 25 * 2 + 50 * 2);
  // from the actual (slipped) fill: TP2 >= 2R and TP1 <= 1R from the fill; partial entry fill: the plan for the filled size
  const f = M.planExits({ dir: 1, entry: 20003, contracts: 7, stop: 19975, pools: [{ price: 20050 }], grade: 'B' }, ON); assert.ok(f.tp.rr >= 2); assert.strictEqual(f.tp.price, 20059); assert.strictEqual(f.partial.price, 20031);
  assert.deepStrictEqual(M.planExits({ dir: 1, entry: 20000, contracts: 4, stop: 19975, pools: [], grade: 'B' }, ON).legs, { leg1: 3, leg2: 1, runner: 0 });
});
t('chooseStop option C (no fallback to a tighter wick)', () => {
  const c = [{ tf: '1H', stopPts: 20, stop: 19980 }, { tf: '4H', stopPts: 60, stop: 19940 }];
  let r = M.chooseStop(c, 'B', ON, { levelName: 'PDH' }); assert.strictEqual(r.tf, '4H'); assert.strictEqual(r.contracts, 5); assert.strictEqual(r.stop, 19940);
  r = M.chooseStop(c, 'B', ON, { levelName: 'London High' }); assert.strictEqual(r.tf, '1H'); assert.strictEqual(r.contracts, 15);
  r = M.chooseStop(c, 'B', ON, { levelName: '1H Open' }); assert.strictEqual(r.tf, '1H');
  r = M.chooseStop(c, 'B', ON, { levelName: 'Asia Low', isTrap: true }); assert.strictEqual(r.tf, '4H');   // a trap is 4H-type
  r = M.chooseStop([{ tf: '1H', stopPts: 20 }, { tf: '4H', stopPts: 160 }], 'C', ON, { levelName: '4H Open' });
  assert.strictEqual(r.code, 'GRADE_NO_FIT'); assert.strictEqual(r.contracts, 0); assert.strictEqual(r.tried.length, 2); assert.strictEqual(r.tried[0].contracts, 7);   // never the 1H wick to fit
  r = M.chooseStop([{ tf: '1H', stopPts: 20 }], 'B', ON, { levelName: 'PDL' }); assert.strictEqual(r.code, 'GRADE_NO_WICK');
  r = M.chooseStop(c, 'B', ON, {}); assert.strictEqual(r.tf, '4H');   // unknown level type: the higher timeframe
  assert.strictEqual(M.levelStopTf('PDL'), '4H'); assert.strictEqual(M.levelStopTf('4H Open'), '4H'); assert.strictEqual(M.levelStopTf('Asia High'), '1H'); assert.strictEqual(M.levelStopTf('London Low'), '1H');
});
t('config validation', () => {
  const D = JSON.parse(JSON.stringify(M.DEFAULTS));
  assert.strictEqual(M.problem(D), null); assert.strictEqual(M.problem(ON), null); assert.strictEqual(M.problem(ON, { symbol: 'MNQ', pointValue: 2, minContracts: null }), null);
  const bad = (c, re) => assert.match(M.problem(c) || '', re);
  bad(withS({ gradeRiskUsd: { A: 2001, B: 600, C: 300 } }), /gradeRiskUsd\.A/); bad(withS({ gradeRiskUsd: { A: 900, B: 600, C: 49 } }), /gradeRiskUsd\.C/);
  bad(withS({ gradeRiskUsd: { A: 900, B: 600 } }), /gradeRiskUsd\.C/); bad(withS({ gradeRiskUsd: { A: 500, B: 600, C: 300 } }), /step down/);
  bad(withS({ gradeRiskUsd: { A: 900, B: 600, C: 300, D: 100 } }), /unknown/);
  assert.strictEqual(M.problem(withS({ gradeRiskUsd: { A: 50, B: 50, C: 50 } })), null); assert.strictEqual(M.problem(withS({ gradeRiskUsd: { A: 2000, B: 2000, C: 2000 } })), null);
  bad(withS({ maxContracts: 0 }), /maxContracts/); bad(withS({ maxContracts: 2.5 }), /maxContracts/); bad(withS({ maxContracts: 151 }), /maxContracts/);
  bad(withS({ enabled: 'yes' }), /enabled/); bad(withS({ scaleInA: 1 }), /scaleInA/); bad(withS({ maxLossUsd: 300 }), /NO daily loss limit|unknown/);
  bad(withE({ partialFrac: 1 }), /partialFrac/); bad(withE({ partialFrac: 0 }), /partialFrac/); bad(withE({ trailBufferPts: -1 }), /trailBufferPts/); bad(withE({ protect: { ...ON.exits.protect, stepR: 0 } }), /stepR/); bad(withE({ protect: { ...ON.exits.protect, enabled: 1 } }), /protect.enabled/); bad(withE({ protect: { ...ON.exits.protect, trailAfterDays: 1 } }), /NO daily loss limit|unknown/); bad(withE({ protect: undefined }), /protect/); bad(withE({ minWinUsd: 200 }), /unknown exits key/);
  bad({ sizing: ON.sizing }, /exits/); bad(null, /object/); bad({ ...ON, extra: 1 }, /unknown money key/);
  assert.match(M.problem(ON, { symbol: 'NQ' }), /MNQ only/); assert.match(M.problem(ON, { pointValue: 20 }), /MNQ only/); assert.match(M.problem(ON, { minContracts: 3 }), /minContracts 3/);
  assert.strictEqual(M.problem({ ...ON, sizing: { ...ON.sizing, enabled: false } }, { symbol: 'NQ', minContracts: 3 }), null);   // off: no conflict
});
t('startup line', () => {
  assert.strictEqual(M.startupLine(M.DEFAULTS), '[sizing] off');
  assert.strictEqual(M.startupLine(ON), '[sizing] mode grade: A+ $900 / B $600 / C $300 per trade (shadow flat $450, logged only) (MNQ $2/pt, max 30 contracts): 1 MNQ fits up to 450 / 300 / 150 pts, wider = GRADE_NO_FIT skip (the stop is never moved); entry: A+ all at once, B half at the trigger + half resting at the retest (cancelled at TP1 or invalidation), C one entry; grade-upgrade add on (B/C re-graded A+, before TP1, up to the A+ dollars at the same stop, resting half reserved); exits: TP1 67% at the first pool (<= 1R) then break-even + 1 tick, one house-money add of 1/3 on a rejected pullback, TP2 everything at the pool >= 2R (A+ the major pool); protect R-ladder (+1R BE, then lock best R - 1R in 0.5R steps), 15m swing after a major sweep, 5m swing on a climax, placeable stops only (a crossed lock exits at market); stops only tighten; no timed exits; NO daily loss limit');
  assert.match(M.startupLine(withE({ protect: { ...ON.exits.protect, enabled: false } })), /protect off/);
  assert.match(M.startupLine(withS({ scaleInB: false })), /B one entry, C one entry/);
});
t('journal rows + exemptions', () => {
  const row = M.entryRow({ stopPts: 25, grade: 'A+', contracts: 9 }, ON); assert.strictEqual(row.version, 'money-r4'); assert.strictEqual(M.VERSION, 'money-r4'); assert.strictEqual(row.sizedContracts, 18); assert.strictEqual(row.riskUsd, 450);
  assert.deepStrictEqual(row.exempt, { noProgressExit: true, stopCapFromFill: true, sessionStopFloor: true });
  const nf = M.noFitRow({ stopPts: 451, grade: 'A+', stopTf: '4H' }, ON); assert.strictEqual(nf.code, 'GRADE_NO_FIT'); assert.strictEqual(nf.oneLotUsd, 902); assert.strictEqual(nf.maxFitPts, 450);
  assert.strictEqual(M.isMoneyEntry({ money: row }), true); assert.strictEqual(M.isMoneyEntry({ money: { version: 'money-r1' } }), false); assert.strictEqual(M.isMoneyEntry(null), false);
});
t('NO daily loss limit: no code path exists', () => {
  // 1. no export, default or config key for a day limit; a day-limit key is refused
  for (const k of Object.keys(M)) assert.ok(!/day|daily|limit|fullStop/i.test(k), `export ${k}`);
  assert.ok(!/day|daily|limit/i.test(JSON.stringify(M.DEFAULTS)));
  for (const k of ['dailyLossLimitUsd', 'dayFullStops', 'maxDailyLoss', 'dayLimit', 'sessionLossUsd']) assert.match(M.problem(withS({ [k]: 1 })), /NO daily loss limit/, k);
  assert.match(M.problem({ ...ON, dailyLossUsd: 3000 }), /NO daily loss limit/);
  // 2. pure and stateless: the size after any run of full stops is the same as the first trade's
  const first = M.sizeFor(25, 'A+', ON);
  for (let i = 0; i < 50; i++) { M.sizeFor(25 + i, 'C', ON); M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 9, entry2: 19990, plannedSecond: 9 }, ON); }
  assert.deepStrictEqual(M.sizeFor(25, 'A+', ON), first); assert.ok(Object.isFrozen(first));
  // 3. source scan (comments removed): the only day words are the guard constant that refuses them
  const code = fs.readFileSync(LIB, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, ''));
  const hits = code.map((l, i) => [i + 1, l]).filter(([, l]) => /day|daily|DAY_LIMIT|fullStops|pnlToday|lossCount/i.test(l));
  for (const [i, l] of hits) assert.ok(/NO_DAY_LIMIT_GUARD|NO daily loss limit/.test(l), `line ${i}: ${l.trim().slice(0, 100)}`);
  assert.ok(!/require\(/.test(code.join('\n')), 'no requires (pure)');
  assert.ok(!/Date\.now|new Date|setTimeout|setInterval|process\./.test(code.join('\n')), 'no clock, no timers (no timed exits)');
});
t('the old W / runner-at-W exit and the minor-swing trail are gone', () => { for (const k of ['winPts', 'runnerStopPts', 'lockedUsd', 'trailStop']) assert.strictEqual(M[k], undefined); assert.ok(!('minWinUsd' in M.DEFAULTS.exits)); });
// ---------------------------------------------------------------- money-r3: D5 entry by grade + grade-upgrade add (playbook §22)
t('A+ and C never scale in (any stop, any config)', () => {
  for (const cfg of [ON, withS({ scaleInB: false }), withS({ scaleInA: true }), withS({ gradeRiskUsd: { A: 2000, B: 2000, C: 2000 } })])
    for (const g of ['A+', 'A', 'C']) for (let s = 0.25; s <= 500; s += 0.25) {
      const p = M.scaleInPlan(s, g, cfg); assert.strictEqual(p.second, 0, `${g} ${s}`); assert.strictEqual(p.first, p.total, `${g} ${s}`); assert.strictEqual(p.scaleIn, false);
      assert.strictEqual(p.style, g === 'C' ? 'one-entry' : 'all-at-once');
    }
  for (const g of ['A+', 'C']) { const z = M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6, grade: g }, ON); assert.strictEqual(z.contracts, 0); assert.strictEqual(z.reason, 'no-scale-in'); }
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 }, withS({ scaleInB: false })).reason, 'no-scale-in');
});
t('B combined risk <= $600 (the plan, a slipped first fill, any resting price, both directions)', () => {
  for (let s = 0.25; s <= 300; s += 0.25) {
    const p = M.scaleInPlan(s, 'B', ON); assert.ok(p.total * s * 2 <= 600 + 1e-9, `plan ${s}`); assert.strictEqual(p.first + p.second, p.total); assert.strictEqual(p.first, p.total >= 2 ? Math.ceil(p.total / 2) : p.total);
  }
  let calls = 0;
  for (const dir of [1, -1]) for (const stopPts of [5, 10, 25, 40, 60, 100, 150, 299.75]) for (const slip of [-3, 0, 2, 5, 10]) {
    const entry = 20000, stop = entry - dir * stopPts, p = M.scaleInPlan(stopPts, 'B', ON); if (!p.scaleIn) continue;
    const firstFill = entry + dir * slip; if (!(dir * (firstFill - stop) > 0)) continue;
    for (let d = 0.25; d <= stopPts + 40; d += 0.75) {
      const z = M.secondLeg({ dir, stop, structuralStop: stop, firstFill, firstContracts: p.first, entry2: stop + dir * d, plannedSecond: p.second }, ON); calls++;
      assert.ok(z.combinedRiskUsd <= 600 + 1e-9, `dir ${dir} stop ${stopPts} slip ${slip} d ${d}: ${z.combinedRiskUsd}`); assert.ok(z.contracts <= p.second); assert.strictEqual(z.stop, stop);
    }
  }
  assert.ok(calls > 5000);
});
// ---------------------------------------------------------------- money-r4: MacDot review findings 1-6 + the team sizing position (common risk first)
const FLAT = { ...JSON.parse(JSON.stringify(M.DEFAULTS)), exits: ON.exits }; FLAT.sizing.enabled = true;   // the r4 defaults with sizing on
const withF = (s) => ({ ...FLAT, sizing: { ...FLAT.sizing, ...s } });
const RC = { dir: 1, bestPx: 20010, tp1Px: 20025, tp1Done: false, invalidated: false, closed: false };
t('restingCancel: TP1 / invalidation / close cancel; every field required, anything unknown FAILS CLOSED (finding 2)', () => {
  assert.deepStrictEqual({ ...M.restingCancel(RC) }, { cancel: false, reason: 'keep' });
  assert.strictEqual(M.restingCancel({ ...RC, bestPx: 20025 }).reason, 'tp1-reached');   // touched, filled or not (a 1-lot has no TP1 order)
  assert.strictEqual(M.restingCancel({ ...RC, tp1Done: true }).reason, 'tp1-reached');
  assert.strictEqual(M.restingCancel({ ...RC, invalidated: true }).reason, 'invalidated');
  assert.strictEqual(M.restingCancel({ ...RC, closed: true }).reason, 'position-closed');
  assert.strictEqual(M.restingCancel({ ...RC, dir: -1, bestPx: 19975, tp1Px: 19975 }).cancel, true); assert.strictEqual(M.restingCancel({ ...RC, dir: -1, bestPx: 19980, tp1Px: 19975 }).cancel, false);
  // MacDot: r3 kept the order when fields were missing. Now each missing / malformed field cancels.
  for (const k of Object.keys(RC)) { const o = { ...RC }; delete o[k]; assert.deepStrictEqual({ ...M.restingCancel(o) }, { cancel: true, reason: 'unknown-state' }, `missing ${k}`); }
  for (const [k, v] of [['dir', 0], ['bestPx', NaN], ['tp1Px', null], ['tp1Done', 'no'], ['invalidated', 0], ['closed', undefined]]) assert.strictEqual(M.restingCancel({ ...RC, [k]: v }).cancel, true, `${k}=${v}`);
  assert.strictEqual(M.restingCancel(null).cancel, true); assert.strictEqual(M.restingCancel({ closed: true }).reason, 'position-closed');
});
const UP = { grade: 'B', newGrade: 'A+', dir: 1, openQty: 12, entry: 20000, stop: 19975, structuralStop: 19975, addPx: 20000, restingQty: 0,
  tp1Done: false, tp1Px: 20025, bestPx: 20010, upgradedBefore: false, cfg: ON };
t('upgradeAdd B -> A+ sizing, no resting half: top up to $900 at the same stop', () => {
  let u = M.upgradeAdd(UP);   // B 12 @ 20000, 25 pts = $600; add at 20000: $300 / $50 = 6 -> 18 = the A+ size at 25 pts
  assert.deepStrictEqual([u.ok, u.qty, u.reason, u.code, u.reservedRestingQty], [true, 6, 'top-up', 'GRADE_UPGRADE', 0]);
  assert.deepStrictEqual({ ...u.risk }, { openUsd: 600, restingUsd: 0, addUsd: 300, totalUsd: 900, gradeRiskUsd: 900 }); assert.deepStrictEqual(u.combined, { contracts: 18, avgEntry: 20000 }); assert.strictEqual(u.worstAddPx, 20000);
  u = M.upgradeAdd({ ...UP, addPx: 20010 }); assert.deepStrictEqual([u.qty, u.risk.totalUsd, u.worstAddPx], [4, 880, 20012.5]);   // $300 / $70 = 4; worst fill 19975 + 300 / 8
  u = M.upgradeAdd({ ...UP, addPx: 19990 }); assert.deepStrictEqual([u.qty, u.combined.contracts, u.risk.totalUsd], [10, 22, 900]);
  u = M.upgradeAdd({ ...UP, grade: 'C', openQty: 6 }); assert.deepStrictEqual([u.qty, u.combined.contracts, u.risk.totalUsd], [12, 18, 900]);
  u = M.upgradeAdd({ ...UP, dir: -1, stop: 20025, structuralStop: 20025, addPx: 20010, tp1Px: 19975, bestPx: 19990 }); assert.deepStrictEqual([u.qty, u.risk.totalUsd, u.worstAddPx], [10, 900, 20010]);
  assert.strictEqual(M.upgradeAdd({ ...UP, grade: 'b', newGrade: 'A' }).ok, true); assert.ok(Object.isFrozen(u) && Object.isFrozen(u.row));
});
t('upgradeAdd RESERVES the resting B half until it is terminal (finding 4): total <= $900 in every outcome', () => {
  // MacDot's witness: r3 cancelled-and-merged on paper (6 open + 12 add); if the resting 6 filled before the cancel: 24 contracts / $1,200. Now:
  let u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 20000 });
  assert.deepStrictEqual([u.ok, u.qty, u.reason, u.reservedRestingQty, u.risk.restingUsd, u.risk.totalUsd], [true, 6, 'merged-resting', 6, 300, 900]);
  assert.deepStrictEqual([u.combined.contracts, u.ifRestingFills.contracts], [12, 18]);   // 18 contracts / $900 at most, never 24 / $1,200
  u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 19990 }); assert.deepStrictEqual([u.qty, u.risk.restingUsd, u.risk.totalUsd, u.ifRestingFills.contracts], [8, 180, 880, 20]);
  // terminal: the cancel is confirmed -> restingQty 0 -> the full r3 top-up; the fill is folded into openQty / entry -> sized from the position
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 6, restingQty: 0 }).qty, 12);
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 12, restingQty: 0 }).qty, 6);
  // a partial fill of the resting order: 2 filled (folded in), 4 still reserved
  u = M.upgradeAdd({ ...UP, openQty: 8, restingQty: 4, restingPx: 20000 }); assert.deepStrictEqual([u.qty, u.risk.totalUsd, u.ifRestingFills.contracts], [6, 900, 18]);
  // the contract cap counts the reservation too
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 19990, cfg: { ...ON, sizing: { ...ON.sizing, maxContracts: 14 } } }).qty, 2);
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 19990, cfg: { ...ON, sizing: { ...ON.sizing, maxContracts: 12 } } }).reason, 'max-contracts');
  // a reservation without its price, or with a price at/through the stop: refused
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6 }).reason, 'unknown-state');
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 19975 }).reason, 'invalid-input');
  // property: every resting outcome (cancelled / filled at its price) and every add fill up to worstAddPx stays <= $900 and <= maxContracts
  let oks = 0;
  for (const dir of [1, -1]) for (const g of ['B', 'C']) for (const [openQty, stopPts] of [[6, 25], [3, 60], [1, 120], [2, 50], [12, 10]]) for (const rest of [0, 1, 3, 6]) for (let rp = 0.25; rp <= stopPts + 10; rp += 1.75) {
    const entry = 20000, stop = entry - dir * stopPts, restingPx = stop + dir * rp;
    if (openQty * stopPts * 2 + rest * rp * 2 > (g === 'B' ? 600 : 300)) continue;
    for (let d = 0.25; d <= stopPts + 40; d += 2.25) {
      const z = M.upgradeAdd({ ...UP, grade: g, dir, openQty, entry, stop, structuralStop: stop, addPx: stop + dir * d, restingQty: rest, restingPx, tp1Px: entry + dir * stopPts, bestPx: entry });
      if (!z.ok) { assert.ok(['no-room', 'max-contracts'].includes(z.reason), z.reason); continue; }
      oks++;
      const worst = openQty * stopPts * 2 + rest * rp * 2 + z.qty * dir * (z.worstAddPx - stop) * 2;
      assert.ok(worst <= 900 + 1e-9, `${g} dir ${dir} open ${openQty} rest ${rest}@${rp} add ${z.qty}: ${worst}`); assert.ok(openQty + rest + z.qty <= 30);
    }
  }
  assert.ok(oks > 3000, `${oks}`);
});
t('upgradeAdd FAILS CLOSED on unknown lifecycle state (finding 2)', () => {
  // MacDot's witnesses: r3 returned ok with tp1Done / upgradedBefore missing and with restingQty NaN
  for (const k of ['tp1Done', 'upgradedBefore', 'restingQty', 'tp1Px', 'bestPx']) { const o = { ...UP }; delete o[k]; const u = M.upgradeAdd(o); assert.deepStrictEqual([u.ok, u.qty, u.reason], [false, 0, 'unknown-state'], `missing ${k}`); }
  for (const [k, v] of [['restingQty', NaN], ['restingQty', -1], ['restingQty', 2.5], ['restingQty', '0'], ['tp1Done', 'false'], ['tp1Done', 0], ['upgradedBefore', null], ['bestPx', NaN], ['tp1Px', Infinity]])
    assert.strictEqual(M.upgradeAdd({ ...UP, [k]: v }).reason, 'unknown-state', `${k}=${String(v)}`);
  for (const [k, v] of [['dir', 0], ['entry', NaN], ['stop', undefined], ['addPx', undefined], ['openQty', 0], ['openQty', 1.5]]) assert.strictEqual(M.upgradeAdd({ ...UP, [k]: v }).reason, 'invalid-input', `${k}`);
  assert.strictEqual(M.upgradeAdd(null).ok, false);
});
t('the original structural stop is MANDATORY wherever sizing depends on it (finding 3)', () => {
  const o = { ...UP }; delete o.structuralStop;
  assert.strictEqual(M.upgradeAdd(o).reason, 'no-structural-stop'); assert.strictEqual(M.upgradeAdd({ ...UP, structuralStop: NaN }).reason, 'no-structural-stop');
  assert.strictEqual(M.upgradeAdd({ ...UP, stop: 19985 }).reason, 'stop-moved');   // a protection move tightened it: never size to it
  assert.strictEqual(M.upgradeAdd({ ...UP, stop: 20000.25, structuralStop: 20000.25 }).reason, 'stop-moved');   // at/past the entry
  const L2 = { dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 };
  assert.strictEqual(M.secondLeg(L2, ON).reason, 'no-structural-stop'); assert.strictEqual(M.secondLeg(L2, ON).contracts, 0);
  assert.strictEqual(M.secondLeg({ ...L2, structuralStop: 19970 }, ON).reason, 'stop-moved');
  assert.strictEqual(M.secondLeg({ ...L2, structuralStop: 19975 }, ON).contracts, 6);
});
t('upgradeAdd refused after TP1, including a 1-lot whose TP1 price traded (no TP1 order)', () => {
  let u = M.upgradeAdd({ ...UP, tp1Done: true }); assert.deepStrictEqual([u.ok, u.qty, u.reason, u.code], [false, 0, 'after-tp1', 'GRADE_UPGRADE_SKIP']);
  u = M.upgradeAdd({ ...UP, grade: 'C', openQty: 1, stop: 19880, structuralStop: 19880, tp1Px: 20120, bestPx: 20120 }); assert.strictEqual(u.reason, 'after-tp1');   // MacDot R10
  assert.strictEqual(M.upgradeAdd({ ...UP, grade: 'C', openQty: 1, stop: 19880, structuralStop: 19880, tp1Px: 20120, bestPx: 20119.75 }).ok, true);
  assert.strictEqual(M.addAllowed({ dir: 1, runner: { entry: 20000, contracts: 2 }, originalContracts: 6, addPx: 20040, stop: 20025, tp2: 20100, tp1Done: true, bias: { m15: 0.2, m30: 0.1, line: 0.15 }, control4h: true, rejection: true, cfg: ON }).ok, true);   // the pyramid still works after TP1
});
t('upgradeAdd refused twice (once per trade) and the other refusals', () => {
  const first = M.upgradeAdd(UP); assert.strictEqual(first.ok, true);
  assert.strictEqual(M.upgradeAdd({ ...UP, upgradedBefore: true }).reason, 'already-upgraded');
  assert.strictEqual(M.upgradeAdd({ ...UP, grade: 'A+', openQty: first.combined.contracts }).reason, 'not-b-or-c');
  const why = (o) => M.upgradeAdd({ ...UP, ...o }).reason;
  assert.strictEqual(why({ grade: 'D' }), 'not-b-or-c'); assert.strictEqual(why({ newGrade: 'B' }), 'not-a-plus'); assert.strictEqual(why({ newGrade: null }), 'not-a-plus');
  assert.strictEqual(why({ addPx: 19975 }), 'stop-not-behind-add'); assert.strictEqual(why({ addPx: 19960 }), 'stop-not-behind-add');
  assert.strictEqual(why({ cfg: { ...ON, sizing: { ...ON.sizing, gradeRiskUsd: { A: 600, B: 600, C: 300 } } } }), 'no-room');
  assert.strictEqual(why({ cfg: { ...ON, sizing: { ...ON.sizing, maxContracts: 12 } } }), 'max-contracts');
});
t('GRADE_UPGRADE journal row (old/new points, the reservation, the risk)', () => {
  let u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 19990, addPx: 20005, oldPoints: 3, newPoints: 4 });   // $900 - 300 - 180 = 420 / 60 = 7
  assert.deepStrictEqual({ ...u.row }, { code: 'GRADE_UPGRADE', version: 'money-r4', from: 'B', to: 'A+', reason: 'merged-resting', oldPoints: 3, newPoints: 4, dir: 1, openQty: 6, entry: 20000, stop: 19975,
    structuralStop: 19975, addPx: 20005, qty: 7, worstAddPx: 20005, reservedRestingQty: 6, restingPx: 19990, openRiskUsd: 300, restingRiskUsd: 180, addRiskUsd: 420, totalRiskUsd: 900, gradeRiskUsd: 900 });
  u = M.upgradeAdd({ ...UP, tp1Done: true, oldPoints: 3, newPoints: 4 });
  assert.deepStrictEqual([u.row.code, u.row.reason, u.row.from, u.row.to, u.row.qty, u.row.totalRiskUsd], ['GRADE_UPGRADE_SKIP', 'after-tp1', 'B', 'A+', 0, null]);
});
t('D5 path (grade mode, entryByGrade on): B half fills, re-grades A+ before TP1, resting half reserved, A+ exits re-planned', () => {
  const pools = [{ price: 20020 }, { price: 20060 }, { price: 20090, major: true }];
  const plan0 = M.scaleInPlan(25, 'B', ON), first = M.planExits({ dir: 1, entry: 20000, contracts: plan0.total, stop: 19975, pools, grade: 'B' }, ON);
  assert.deepStrictEqual([plan0.first, plan0.second, first.partial.price, first.tp.price], [6, 6, 20020, 20060]);
  assert.strictEqual(M.restingCancel({ ...RC, bestPx: 20012, tp1Px: first.partial.price }).cancel, false);
  const u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, restingPx: 19990, addPx: 20005, tp1Px: first.partial.price, bestPx: 20012 });
  assert.deepStrictEqual([u.ok, u.qty, u.risk.totalUsd, u.ifRestingFills.contracts], [true, 7, 900, 19]);
  const legs = [{ price: 20000, contracts: 6 }, { price: 20005, contracts: 7 }];
  const plan = M.planExits({ dir: 1, legs, stop: 19975, pools, grade: 'A+' }, ON);
  assert.deepStrictEqual([plan.contracts, plan.tp.price, plan.tp.basis, plan.partial.price], [13, 20090, 'major-pool', 20020]);
  const both = M.planExits({ dir: 1, legs: legs.concat([{ price: 19990, contracts: 6 }]), stop: 19975, pools, grade: 'A+' }, ON); assert.strictEqual(both.contracts, 19);
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 13, entry: plan.avgEntry, upgradedBefore: true }).reason, 'already-upgraded');
});
t('protectStop / nextStop propose only PLACEABLE stops (finding 5)', () => {
  const cfg = ON;
  // MacDot's witness: long, the lock wants 110 but the market is at 105. r3 proposed 110 (crossed). Now: no stop, exit-at-market.
  let r = M.protectStop({ entry: 100, R: 10, dir: 1, bestPx: 120, currentStop: 90, lastPx: 105, cfg });
  assert.deepStrictEqual([r.stop, r.moved, r.placeable, r.action, r.reason, r.wantStop], [90, false, false, 'exit-at-market', 'lock-crossed', 110]);
  const P = (o) => M.protectStop({ entry: 20000, R: 25, dir: 1, bestPx: 20050, currentStop: 19975, lastPx: 20040, cfg, ...o });
  r = P({}); assert.deepStrictEqual([r.stop, r.moved, r.placeable, r.action], [20025, true, true, 'place']);
  r = P({ lastPx: 20025.25 }); assert.deepStrictEqual([r.stop, r.action], [20025, 'place']);                      // exactly one tick behind: placeable
  r = P({ lastPx: 20025.1 }); assert.deepStrictEqual([r.stop, r.placeable, r.action, r.reason], [19975, false, 'hold-current', 'lock-too-close']);
  r = P({ lastPx: 20025 }); assert.deepStrictEqual([r.stop, r.action, r.reason], [19975, 'exit-at-market', 'lock-crossed']);   // at the lock = the stop would have filled
  r = P({ lastPx: 19975 }); assert.deepStrictEqual([r.stop, r.action, r.reason], [19975, 'hold-current', 'at-current-stop']);   // the resting stop works: never a second exit
  r = P({ lastPx: undefined }); assert.deepStrictEqual([r.stop, r.moved, r.placeable, r.action, r.reason], [19975, false, false, 'hold-current', 'no-last-price']);
  r = P({ currentStop: undefined }); assert.deepStrictEqual([r.moved, r.action, r.reason], [false, 'hold-current', 'invalid-input']);
  r = M.protectStop({ entry: 20000, R: 25, dir: -1, bestPx: 19950, currentStop: 20025, lastPx: 19980, cfg }); assert.deepStrictEqual([r.stop, r.action], [20025, 'exit-at-market']);   // short mirror
  r = M.protectStop({ entry: 20000, R: 25, dir: -1, bestPx: 19950, currentStop: 20025, lastPx: 19960, cfg }); assert.deepStrictEqual([r.stop, r.action], [19975, 'place']);
  // swing locks: a crossed swing holds (no exit); nextStop passes the crossed ladder lock on as exit-at-market and needs lastPx
  r = M.structuralTrail({ dir: 1, currentStop: 20000.25, swings15m: [{ type: 'L', price: 20040, t: 1 }], majorSwept: true, lastPx: 20038, cfg }); assert.deepStrictEqual([r.moved, r.action, r.reason], [false, 'hold-current', 'at-market']);
  r = M.structuralTrail({ dir: 1, currentStop: 20000.25, swings15m: [{ type: 'L', price: 20040, t: 1 }], majorSwept: true, cfg }); assert.deepStrictEqual([r.moved, r.reason], [false, 'no-last-price']);
  let ns = M.nextStop({ dir: 1, entry: 100, R: 10, bestPx: 120, currentStop: 90, lastPx: 105, cfg }); assert.deepStrictEqual([ns.stop, ns.moved, ns.action, ns.by], [90, false, 'exit-at-market', 'lock-crossed']);
  ns = M.nextStop({ dir: 1, entry: 20000, R: 25, bestPx: 20050, currentStop: 19975, cfg }); assert.deepStrictEqual([ns.stop, ns.moved, ns.action], [19975, false, 'hold-current']);
  // property: every proposed stop is >= 1 tick behind lastPx, never looser, and 'place' <=> moved
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const q4 = x => Math.round(x * 4) / 4;
  for (let i = 0; i < 20000; i++) {
    const dir = rnd() < 0.5 ? 1 : -1, sp = q4(2 + rnd() * 100), entry = 20000, cur = q4(entry - dir * sp * (1 - rnd() * 1.8)), lastPx = q4(entry + dir * (rnd() * 3 - 1) * sp);
    const sw = Array.from({ length: 3 }, (_, k) => ({ type: rnd() < 0.5 ? 'H' : 'L', price: q4(entry + (rnd() - 0.5) * 3 * sp), t: k }));
    const z = M.nextStop({ dir, entry, R: sp, bestPx: q4(entry + dir * rnd() * 4 * sp), currentStop: cur, lastPx, majorSwept: rnd() < 0.5, climax: rnd() < 0.5, swings15m: sw, swings5m: sw, cfg });
    assert.ok(dir * (z.stop - cur) >= -1e-9, 'never looser'); assert.strictEqual(z.action === 'place', z.moved);
    if (z.moved) assert.ok(dir * (lastPx - z.stop) >= 0.25 - 1e-9, `crossed stop proposed: dir ${dir} last ${lastPx} stop ${z.stop}`);
  }
});
t('docs and lib: no ungrounded guarantees, no grade thresholds that conflict with GRADE r3 (findings 5 and 6)', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['lib/moneyRule.js', 'API.md', 'INTEGRATION.md']) {
    const txt = read(f);
    for (const bad of [/never closes red/i, /can'?t close red/i, /cannot close red/i, /one missing/i, /two missing/i, /0\/1\/2 missing/, /A\+ = 4.5, B = 3, C = 2/, /§19 points/, /GRADE r2\)/])
      assert.ok(!bad.test(txt), `${f}: ${bad}`);
  }
  assert.match(read('API.md'), /GROSS/); assert.match(read('INTEGRATION.md'), /GROSS/);
  assert.ok(!/GRADE_PARTS|trapAtPool|validTrigger/.test(read('lib/moneyRule.js')), 'the r2 grade parts are gone from the lib');
});
// ---- the team sizing position (addendum)
t('sizing.mode flat (default): every grade risks flatDollars; mode grade keeps the grade dollars', () => {
  assert.strictEqual(M.DEFAULTS.sizing.mode, 'flat'); assert.strictEqual(M.DEFAULTS.sizing.flatDollars, 450); assert.strictEqual(M.problem(FLAT), null);
  for (const g of ['A+', 'B', 'C']) { const z = M.sizeFor(75, g, FLAT); assert.deepStrictEqual([z.contracts, z.budgetUsd, z.mode, z.riskUsd], [3, 450, 'flat', 450]); }
  assert.deepStrictEqual(['A+', 'B', 'C'].map(g => M.sizeFor(75, g, ON).contracts), [6, 4, 2]);
  assert.strictEqual(M.sizeFor(75, 'B', withF({ flatDollars: 300 })).contracts, 2);
  assert.strictEqual(M.sizeFor(25, 'X', FLAT).code, 'GRADE_INVALID');   // the grade label is still required (it is logged)
  for (let s = 0.25; s <= 300; s += 0.25) { const z = M.sizeFor(s, 'C', FLAT); assert.ok(z.riskUsd <= 450 + 1e-9); assert.strictEqual(z.stopPts, s); }
});
t('unknown modes and bad keys refuse to start; at runtime they fail closed', () => {
  const bad = (c, re) => assert.match(M.problem(c) || '', re);
  for (const m of ['grades', 'Flat', '', null, 1]) bad(withF({ mode: m }), /sizing\.mode/);
  for (const v of ['take2', 'take', true, null]) bad(withF({ noFit: v }), /sizing\.noFit/);
  for (const v of [49, 2001, '450', NaN]) bad(withF({ flatDollars: v }), /sizing\.flatDollars/);
  bad(withF({ entryByGrade: 'yes' }), /entryByGrade/); bad(withF({ upgradeAdd: true }), /upgradeAdd/); bad(withF({ upgradeAdd: { enabled: 'y' } }), /upgradeAdd\.enabled/); bad(withF({ upgradeAdd: { enabled: true, x: 1 } }), /unknown sizing\.upgradeAdd key/);
  bad(withF({ sizeMode: 'flat' }), /unknown sizing key/);
  // runtime, if problem() was skipped: an unknown mode sizes nothing; an unknown noFit skips; non-true switches are off
  const z = M.sizeFor(25, 'A+', withF({ mode: 'grades' })); assert.deepStrictEqual([z.contracts, z.code], [0, 'SIZING_MODE_INVALID']);
  assert.strictEqual(M.scaleInPlan(25, 'B', withF({ mode: 'grades' })).total, 0); assert.match(M.startupLine(withF({ mode: 'grades' })), /INVALID: no trades/);
  assert.strictEqual(M.sizeFor(300, 'C', withF({ noFit: 'take2' })).contracts, 0);
  assert.strictEqual(M.scaleInPlan(25, 'B', withF({ entryByGrade: 'yes' })).scaleIn, false);
  assert.strictEqual(M.upgradeAdd({ ...UP, cfg: withF({ mode: 'grade', upgradeAdd: { enabled: 'yes' } }) }).reason, 'upgrade-off');
  assert.strictEqual(M.upgradeAdd({ ...UP, cfg: withF({ upgradeAdd: { enabled: true }, mode: 'grades' }) }).reason, 'invalid-mode');
});
t('entryByGrade false (default): every grade all at once; true: the D5 styles', () => {
  for (const g of ['A+', 'B', 'C']) for (const sp of [10, 25, 60, 120]) { const p = M.scaleInPlan(sp, g, FLAT); assert.deepStrictEqual([p.first, p.second, p.scaleIn, p.style], [p.total, 0, false, 'all-at-once'], `${g} ${sp}`); }
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 5, entry2: 19990, plannedSecond: 4 }, FLAT).reason, 'no-scale-in');
  const E = withF({ entryByGrade: true }); let p = M.scaleInPlan(25, 'B', E); assert.deepStrictEqual([p.total, p.first, p.second, p.style], [9, 5, 4, 'scale-in']);   // flat $450 / $50 = 9
  assert.strictEqual(M.scaleInPlan(25, 'A+', E).style, 'all-at-once'); assert.strictEqual(M.scaleInPlan(25, 'C', E).style, 'one-entry');
  const s2 = M.secondLeg({ dir: 1, stop: 19975, structuralStop: 19975, firstFill: 20000, firstContracts: 5, entry2: 19990, plannedSecond: 4 }, E); assert.deepStrictEqual([s2.contracts, s2.gradeRiskUsd, s2.combinedRiskUsd], [4, 450, 370]);
  assert.strictEqual(M.scaleInPlan(25, 'B', ON).style, 'scale-in');
});
t('upgradeAdd is off by default (dormant: GRADE r3 freezes points at the decision); flat mode never upgrades', () => {
  assert.strictEqual(M.DEFAULTS.sizing.upgradeAdd.enabled, false);
  assert.deepStrictEqual([M.upgradeAdd({ ...UP, cfg: FLAT }).ok, M.upgradeAdd({ ...UP, cfg: FLAT }).reason, M.upgradeAdd({ ...UP, cfg: FLAT }).code], [false, 'upgrade-off', 'GRADE_UPGRADE_SKIP']);
  assert.strictEqual(M.upgradeAdd({ ...UP, cfg: withF({ upgradeAdd: { enabled: true } }) }).reason, 'flat-mode');
  assert.strictEqual(M.upgradeAdd({ ...UP, cfg: withF({ upgradeAdd: { enabled: true }, mode: 'grade' }) }).ok, true);
  assert.match(M.startupLine(FLAT), /grade-upgrade add off/); assert.match(M.startupLine(ON), /grade-upgrade add on/);
});
t('shadow size: entryRow, noFitRow and startupLine carry the size used AND the other mode at the same stop (logging only)', () => {
  let row = M.entryRow({ stopPts: 75, grade: 'A+', contracts: 3 }, FLAT);
  assert.strictEqual(row.shadow.line, 'flat 450: 3 MNQ | grade A+ 900: 6 MNQ'); assert.strictEqual(row.shadow.logOnly, true);
  assert.deepStrictEqual([row.mode, row.contracts, row.sizedContracts, row.budgetUsd, row.shadow.used.contracts, row.shadow.shadow.contracts], ['flat', 3, 3, 450, 3, 6]);
  row = M.entryRow({ stopPts: 75, grade: 'C', contracts: 2 }, ON); assert.strictEqual(row.shadow.line, 'grade C 300: 2 MNQ | flat 450: 3 MNQ');
  assert.strictEqual(M.sizeFor(75, 'A+', FLAT).contracts, 3);   // the shadow never changes the size used
  const nf = M.noFitRow({ stopPts: 300, grade: 'B', stopTf: '4H' }, FLAT); assert.deepStrictEqual([nf.code, nf.mode, nf.shadow.line], ['GRADE_NO_FIT', 'flat', 'flat 450: 0 MNQ (GRADE_NO_FIT) | grade B 600: 1 MNQ']);
  assert.match(M.startupLine(FLAT), /^\[sizing\] mode flat: \$450 per trade, every grade \(grades logged, not sized; shadow grade A\+ \$900 \/ B \$600 \/ C \$300, logged only\)/);
  assert.match(M.startupLine(ON), /^\[sizing\] mode grade: A\+ \$900 \/ B \$600 \/ C \$300 per trade \(shadow flat \$450, logged only\)/);
  assert.ok(!('shadow' in M.planExits({ dir: 1, entry: 20000, contracts: 3, stop: 19975, pools: [], grade: 'B' }, FLAT)));   // nothing placed from it
});
t('noFit skip (default) vs take1; the stop is NEVER moved to fit', () => {
  let z = M.sizeFor(226, 'B', FLAT); assert.deepStrictEqual([z.contracts, z.code, z.stopPts, z.overBudgetUsd], [0, 'GRADE_NO_FIT', 226, 0]);
  const T1 = withF({ noFit: 'take1' }); z = M.sizeFor(226, 'B', T1);
  assert.deepStrictEqual([z.contracts, z.code, z.reason, z.stopPts, z.riskUsd, z.overBudgetUsd, z.budgetUsd], [1, 'NO_FIT_TAKE1', 'no-fit-take1', 226, 452, 2, 450]);
  assert.strictEqual(M.sizeFor(225, 'B', T1).code, null);   // fits: take1 changes nothing
  for (const cfg of [FLAT, T1, ON, { ...ON, sizing: { ...ON.sizing, noFit: 'take1' } }]) for (const g of ['A+', 'B', 'C']) for (let s = 0.25; s <= 700; s += 0.25) {
    const k = M.sizeFor(s, g, cfg); assert.strictEqual(k.stopPts, s, 'the stop is never moved'); assert.strictEqual(k.riskUsd, Math.round(k.contracts * s * 2 * 100) / 100);
    if (k.code === 'NO_FIT_TAKE1') { assert.strictEqual(k.contracts, 1); assert.ok(s * 2 > k.budgetUsd); assert.strictEqual(k.overBudgetUsd, Math.round((s * 2 - k.budgetUsd) * 100) / 100); }
    else assert.ok(k.riskUsd <= k.budgetUsd + 1e-9);
  }
  // option C with take1: still the required wick (never the tighter one), 1 MNQ, over-budget logged
  const c = M.chooseStop([{ tf: '1H', stopPts: 20 }, { tf: '4H', stopPts: 300 }], 'C', T1, { levelName: 'PDH' }); assert.deepStrictEqual([c.tf, c.stopPts, c.contracts, c.code], ['4H', 300, 1, 'NO_FIT_TAKE1']);
  const nf = M.noFitRow({ stopPts: 300, grade: 'C' }, T1); assert.deepStrictEqual([nf.code, nf.overBudgetUsd], ['NO_FIT_TAKE1', 150]);
  const row = M.entryRow({ stopPts: 300, grade: 'C', contracts: 1 }, T1); assert.deepStrictEqual([row.riskUsd, row.overBudgetUsd, row.sizeCode], [600, 150, 'NO_FIT_TAKE1']);
  assert.match(M.startupLine(T1), /wider = take 1 MNQ and log the dollars over budget/); assert.match(M.startupLine(FLAT), /wider = GRADE_NO_FIT skip/);
});
t('exits, the pyramid add and the R-ladder are the same in both modes', () => {
  const pools = [{ price: 20018 }, { price: 20062.6 }, { price: 20100, major: true }];
  for (const g of ['A+', 'B', 'C']) assert.deepStrictEqual(M.planExits({ dir: 1, entry: 20000, contracts: 7, stop: 19975, pools, grade: g }, FLAT), M.planExits({ dir: 1, entry: 20000, contracts: 7, stop: 19975, pools, grade: g }, ON));
  const pa = { dir: -1, runner: { entry: 28366.75, contracts: 1 }, originalContracts: 3, addPx: 28172.5, stop: 28220.5, tp2: 28035.25, tp1Done: true, addsDone: 0, bias: { m15: -0.3, m30: -0.25, line: 0.15 }, control4h: -1, rejection: true };
  assert.deepStrictEqual(M.addAllowed({ ...pa, cfg: FLAT }), M.addAllowed({ ...pa, cfg: ON }));
  const ns = { dir: 1, entry: 20000, R: 25, bestPx: 20051, currentStop: 19975, majorSwept: true, swings15m: [{ type: 'L', price: 20040, t: 3 }], climax: true, swings5m: [{ type: 'L', price: 20030, t: 9 }], lastPx: 20050 };
  assert.deepStrictEqual(M.nextStop({ ...ns, cfg: FLAT }), M.nextStop({ ...ns, cfg: ON }));
});
t('r2 / r3 config compatibility: still loads; without a mode it is FLAT (the r4 default); entries of every version still graded', () => {
  const R2 = { ...ON, sizing: { enabled: true, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, scaleInA: true } };
  assert.strictEqual(M.problem(R2), null); assert.strictEqual(M.sizeFor(25, 'A+', R2).contracts, 9);   // flat $450 (breaking: r2/r3 sized 18)
  assert.strictEqual(M.sizeFor(25, 'A+', { ...R2, sizing: { ...R2.sizing, mode: 'grade' } }).contracts, 18);
  assert.match(M.startupLine(R2), /sizing\.scaleInA is ignored since money-r3/); assert.doesNotMatch(M.startupLine(ON), /scaleInA/);
  for (const v of ['money-r2', 'money-r3', 'money-r4']) assert.strictEqual(M.isMoneyEntry({ money: { version: v } }), true);
  assert.strictEqual(M.isMoneyEntry({ money: { version: 'money-r1' } }), false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(M.DEFAULTS.sizing)), { enabled: false, mode: 'flat', flatDollars: 450, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, noFit: 'skip', entryByGrade: false, scaleInB: true, upgradeAdd: { enabled: false } });
  assert.strictEqual(M.problem(JSON.parse(JSON.stringify(M.DEFAULTS))), null);
  assert.match(M.problem(withF({ scaleInB: 1 })), /scaleInB/);
});
console.log(`moneyRule ${M.VERSION}: ${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
