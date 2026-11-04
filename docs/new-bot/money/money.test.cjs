'use strict';
// node tests/money.test.cjs  (pure lib tests for lib/moneyRule.js money-r3: grade sizing, entry by grade + grade-upgrade add (D5), exits D'', option C, config, startup line, no day limit)
// r3 changes to the r2 groups (superseded by D5 / playbook §22 only): the A+-only scale-in group became the entry-by-grade group (B scales in at the
// B dollars, A+ and C one entry); the startup-line text; the version string. Every other r2 assertion is unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib', 'moneyRule.js');
const M = require(LIB);
let n = 0, failed = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message); } };
const ON = { sizing: { enabled: true, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, scaleInB: true },
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
t('gradeOf (Mac terms)', () => {
  const all = { control4h: true, trapAtPool: true, displacementShift: true, firstRetest: true };
  assert.strictEqual(M.gradeOf(all).grade, 'A+');
  assert.strictEqual(M.gradeOf({ ...all, firstRetest: false }).grade, 'B');
  assert.strictEqual(M.gradeOf({ ...all, firstRetest: false, trapAtPool: false }).grade, 'C');
  assert.strictEqual(M.gradeOf({ control4h: true }).grade, null); assert.strictEqual(M.gradeOf({ control4h: true }).reason, 'GRADE_NONE');
  assert.strictEqual(M.gradeOf({ ...all, validTrigger: false }).grade, null);
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
  let s = M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 }, ON);
  assert.strictEqual(s.contracts, 6); assert.strictEqual(s.combinedRiskUsd, 480); assert.strictEqual(s.stop, 19975); assert.strictEqual(s.gradeRiskUsd, 600); assert.strictEqual(s.reason, 'as-planned');
  // first fill slipped 5 pts worse (30 pts risk): 6 x 30 x 2 = 360, room 240 at 15 pts -> 8 > planned 6 -> 6
  s = M.secondLeg({ dir: 1, stop: 19975, firstFill: 20005, firstContracts: 6, entry2: 19990, plannedSecond: 6, grade: 'B' }, ON); assert.strictEqual(s.contracts, 6); assert.strictEqual(s.combinedRiskUsd, 540);
  // second entry worse than the first (40 pts): room 300 / 80 = 3 -> sized down
  s = M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 20015, plannedSecond: 6 }, ON); assert.strictEqual(s.contracts, 3); assert.strictEqual(s.reason, 'sized-down');
  // short mirror
  s = M.secondLeg({ dir: -1, stop: 20025, firstFill: 20000, firstContracts: 6, entry2: 20010, plannedSecond: 6 }, ON); assert.strictEqual(s.contracts, 6); assert.strictEqual(s.combinedRiskUsd, 480);
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19970, plannedSecond: 6 }, ON).contracts, 0);   // at/through the stop
  s = M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 12, entry2: 19990, plannedSecond: 6 }, ON); assert.strictEqual(s.contracts, 0); assert.strictEqual(s.reason, 'no-room');   // 12 x 50 = 600
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 }, withS({ maxContracts: 7 })).contracts, 1);
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
  const L = (bestPx, currentStop = 19975, dir = 1, entry = 20000) => M.protectStop({ entry, R: 25, dir, bestPx, currentStop, cfg: ON });
  assert.strictEqual(L(20024.75).moved, false); assert.strictEqual(L(20024.75).reason, 'below-start');
  assert.strictEqual(L(20025).stop, 20000.25); assert.strictEqual(L(20037).stop, 20000.25);   // +1R: BE + 1 tick
  assert.strictEqual(L(20037.5).stop, 20012.5); assert.strictEqual(L(20049.75).stop, 20012.5);   // +1.5R: lock 0.5R
  assert.strictEqual(L(20050).stop, 20025); assert.strictEqual(L(20062.5).stop, 20037.5); assert.strictEqual(L(20100).stop, 20075);   // +2R lock 1R, then best - 1R in 0.5R steps
  assert.strictEqual(L(20050, 20030).stop, 20030); assert.strictEqual(L(20050, 20030).reason, 'not-in-favour');   // never widens
  assert.strictEqual(L(19962.5, 20025, -1).stop, 19987.5); assert.strictEqual(L(19950, 20025, -1).stop, 19975);   // short mirror
  assert.strictEqual(M.protectStop({ entry: 20000, R: 25, dir: 1, bestPx: 20100, currentStop: 19975, cfg: withE({ protect: { ...ON.exits.protect, enabled: false } }) }).stop, 19975);
  // property: touched +1R never closes red, touched +2R closes >= +1R (stop fills at its price), on random paths
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 400; k++) {
    const dir = k % 2 ? 1 : -1, entry = 20000, R = 10 + Math.floor(rnd() * 100), cfg = ON; let stop = entry - dir * R, best = entry, maxR = 0, out = null, px = entry;
    for (let i = 0; i < 300 && out === null; i++) {
      px = M.roundTick(px + dir * (rnd() - 0.47) * R * 0.6, 0.25);
      if (dir * (px - stop) <= 0) { out = stop; break; }
      if (dir * (px - best) > 0) best = px; maxR = Math.max(maxR, dir * (best - entry) / R);
      stop = M.protectStop({ entry, R, dir, bestPx: best, currentStop: stop, cfg }).stop;
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
  r = M.structuralTrail({ dir: -1, currentStop: 20100, swings15m: [{ type: 'H', price: 20050, t: 1 }], majorSwept: true, cfg: ON }); assert.strictEqual(r.stop, 20052);
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
  assert.strictEqual(M.startupLine(ON), '[sizing] grade dollars per trade A+ $900 / B $600 / C $300 (MNQ $2/pt, max 30 contracts): 1 MNQ fits up to 450 / 300 / 150 pts, wider = GRADE_NO_FIT (the stop is never moved); entry: A+ all at once, B half at the trigger + half resting at the retest (cancelled at TP1 or invalidation), C one entry; one grade-upgrade add (B/C re-graded A+, before TP1) up to the A+ dollars at the same stop; exits: TP1 67% at the first pool (<= 1R) then break-even + 1 tick, one house-money add of 1/3 on a rejected pullback, TP2 everything at the pool >= 2R (A+ the major pool); protect R-ladder (+1R BE, then lock best R - 1R in 0.5R steps), 15m swing after a major sweep, 5m swing on a climax; stops only tighten; no timed exits; NO daily loss limit');
  assert.match(M.startupLine(withE({ protect: { ...ON.exits.protect, enabled: false } })), /protect off/);
  assert.match(M.startupLine(withS({ scaleInB: false })), /B one entry, C one entry/);
});
t('journal rows + exemptions', () => {
  const row = M.entryRow({ stopPts: 25, grade: 'A+', contracts: 9 }, ON); assert.strictEqual(row.version, 'money-r3'); assert.strictEqual(M.VERSION, 'money-r3'); assert.strictEqual(row.sizedContracts, 18); assert.strictEqual(row.riskUsd, 450);
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
  for (let i = 0; i < 50; i++) { M.sizeFor(25 + i, 'C', ON); M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 9, entry2: 19990, plannedSecond: 9 }, ON); }
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
  for (const g of ['A+', 'C']) { const z = M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6, grade: g }, ON); assert.strictEqual(z.contracts, 0); assert.strictEqual(z.reason, 'no-scale-in'); }
  assert.strictEqual(M.secondLeg({ dir: 1, stop: 19975, firstFill: 20000, firstContracts: 6, entry2: 19990, plannedSecond: 6 }, withS({ scaleInB: false })).reason, 'no-scale-in');
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
      const z = M.secondLeg({ dir, stop, firstFill, firstContracts: p.first, entry2: stop + dir * d, plannedSecond: p.second }, ON); calls++;
      assert.ok(z.combinedRiskUsd <= 600 + 1e-9, `dir ${dir} stop ${stopPts} slip ${slip} d ${d}: ${z.combinedRiskUsd}`); assert.ok(z.contracts <= p.second); assert.strictEqual(z.stop, stop);
    }
  }
  assert.ok(calls > 5000);
});
t('restingCancel: the resting B half goes at TP1, on invalidation or when the trade closes', () => {
  assert.deepStrictEqual({ ...M.restingCancel({ dir: 1, bestPx: 20010, tp1Px: 20025 }) }, { cancel: false, reason: 'keep' });
  assert.strictEqual(M.restingCancel({ dir: 1, bestPx: 20025, tp1Px: 20025 }).reason, 'tp1-reached');   // touched, filled or not (a 1-lot has no TP1 order)
  assert.strictEqual(M.restingCancel({ dir: 1, bestPx: 20010, tp1Px: 20025, tp1Done: true }).reason, 'tp1-reached');
  assert.strictEqual(M.restingCancel({ dir: 1, bestPx: 20010, tp1Px: 20025, invalidated: true }).reason, 'invalidated');
  assert.strictEqual(M.restingCancel({ dir: 1, bestPx: 20010, tp1Px: 20025, closed: true }).reason, 'position-closed');
  assert.strictEqual(M.restingCancel({ dir: -1, bestPx: 19975, tp1Px: 19975 }).cancel, true); assert.strictEqual(M.restingCancel({ dir: -1, bestPx: 19980, tp1Px: 19975 }).cancel, false);
  assert.deepStrictEqual({ ...M.restingCancel({ dir: 0 }) }, { cancel: true, reason: 'invalid-input' });   // fails closed
});
const UP = { grade: 'B', newGrade: 'A+', openQty: 12, entry: 20000, stop: 19975, dir: 1, restingQty: 0, tp1Done: false, upgradedBefore: false, cfg: ON };
t('upgradeAdd B -> A+ sizing, no resting half: top up to $900 at the same stop', () => {
  let u = M.upgradeAdd(UP);   // B 12 @ 20000, 25 pts = $600; add at the entry price: $300 / $50 = 6 -> 18 = the A+ size at 25 pts
  assert.deepStrictEqual([u.ok, u.qty, u.reason, u.code, u.cancelRestingQty], [true, 6, 'top-up', 'GRADE_UPGRADE', 0]);
  assert.deepStrictEqual({ ...u.risk }, { openUsd: 600, addUsd: 300, totalUsd: 900, gradeRiskUsd: 900 }); assert.deepStrictEqual(u.combined, { contracts: 18, avgEntry: 20000 }); assert.strictEqual(u.worstAddPx, 20000);
  u = M.upgradeAdd({ ...UP, addPx: 20010 });   // the pullback add 35 pts from the stop: $300 / $70 = 4; worst fill for 4 = 19975 + 300 / 8 = 20012.5
  assert.deepStrictEqual([u.qty, u.risk.totalUsd, u.worstAddPx], [4, 880, 20012.5]); assert.ok(12 * 25 * 2 + 4 * (u.worstAddPx - 19975) * 2 <= 900);
  u = M.upgradeAdd({ ...UP, addPx: 19990 });   // a deeper pullback (15 pts from the stop): $300 / $30 = 10 -> 22 contracts, still $900 at the stop
  assert.deepStrictEqual([u.qty, u.combined.contracts, u.risk.totalUsd], [10, 22, 900]);
  assert.strictEqual(M.upgradeAdd({ ...UP, structuralStop: 19975 }).ok, true);   // the stop is still the structural one
  assert.strictEqual(M.upgradeAdd({ ...UP, grade: 'b', newGrade: 'A' }).ok, true);   // grade spelling as gradeKey
  assert.ok(Object.isFrozen(u) && Object.isFrozen(u.row));
});
t('upgradeAdd B -> A+ with a resting half: cancelled and merged first, total <= $900', () => {
  // B 12 at 25 pts: 6 filled @ 20000, 6 resting @ 19990. Upgrade: cancel the 6, add 12 at 20000 -> 18 (= the A+ size), $300 + $600 = $900
  let u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6 });
  assert.deepStrictEqual([u.ok, u.qty, u.reason, u.cancelRestingQty, u.combined.contracts, u.risk.totalUsd], [true, 12, 'merged-resting', 6, 18, 900]);
  // the pullback reached the resting price 19990: add 20 there ($600 / $30), 26 contracts, $900 at the stop; the resting order is still cancelled (not filled twice)
  u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, addPx: 19990 }); assert.deepStrictEqual([u.qty, u.cancelRestingQty, u.risk.totalUsd], [20, 6, 900]);
  // the resting half filled before the cancel (race): call again with it open -> sized from the combined position
  u = M.upgradeAdd({ ...UP, openQty: 12, entry: 19995, restingQty: 0, addPx: 20000 }); assert.deepStrictEqual([u.qty, u.cancelRestingQty, u.risk.openUsd, u.risk.totalUsd], [8, 0, 480, 880]);   // $420 / $50 = 8
  // a refusal leaves the resting half alone
  u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, tp1Done: true }); assert.deepStrictEqual([u.ok, u.cancelRestingQty, u.row.restingQty], [false, 0, 6]);
});
t('upgradeAdd C -> A+ and the short mirror; total risk <= the A+ dollars everywhere (property)', () => {
  let u = M.upgradeAdd({ ...UP, grade: 'C', openQty: 6 }); assert.deepStrictEqual([u.qty, u.combined.contracts, u.risk.totalUsd], [12, 18, 900]);
  u = M.upgradeAdd({ ...UP, grade: 'C', openQty: 1, stop: 19880 }); assert.deepStrictEqual([u.qty, u.risk.totalUsd], [2, 720]);   // C 1-lot at 120 pts: $660 / $240 = 2
  u = M.upgradeAdd({ ...UP, dir: -1, stop: 20025, addPx: 20010 }); assert.deepStrictEqual([u.ok, u.qty, u.risk.totalUsd, u.worstAddPx], [true, 10, 900, 20010]);
  u = M.upgradeAdd({ ...UP, dir: -1, stop: 20025, addPx: 19990 }); assert.deepStrictEqual([u.qty, u.risk.totalUsd, u.worstAddPx], [4, 880, 19987.5]);
  let oks = 0;
  for (const dir of [1, -1]) for (const g of ['B', 'C']) for (const [openQty, stopPts] of [[12, 25], [6, 25], [1, 120], [5, 60], [2, 150], [30, 5]]) for (const resting of [0, 3]) {
    const entry = 20000, stop = entry - dir * stopPts; if (openQty * stopPts * 2 > (g === 'B' ? 600 : 300)) continue;
    for (let d = 0.25; d <= stopPts + 60; d += 0.25) {
      const addPx = stop + dir * d, z = M.upgradeAdd({ grade: g, newGrade: 'A+', openQty, entry, stop, dir, restingQty: resting, addPx, cfg: ON });
      if (!z.ok) { assert.ok(['no-room', 'max-contracts'].includes(z.reason), z.reason); continue; }
      oks++; assert.ok(z.risk.totalUsd <= 900 + 1e-9, `${g} ${dir} ${openQty} d ${d}`); assert.ok(z.combined.contracts <= 30);
      assert.ok(openQty * stopPts * 2 + z.qty * dir * (z.worstAddPx - stop) * 2 <= 900 + 1e-9, 'a fill at worstAddPx stays <= $900');
      assert.ok(dir * z.worstAddPx >= dir * addPx - 0.25 + 1e-9, 'worstAddPx is no better than the add price by more than a tick');
      assert.strictEqual(z.cancelRestingQty, resting);
    }
  }
  assert.ok(oks > 2000, `${oks}`);
});
t('upgradeAdd refused after TP1 (the pyramid is the only add after TP1)', () => {
  const u = M.upgradeAdd({ ...UP, tp1Done: true }); assert.deepStrictEqual([u.ok, u.qty, u.reason, u.code], [false, 0, 'after-tp1', 'GRADE_UPGRADE_SKIP']);
  assert.strictEqual(M.upgradeAdd({ ...UP, grade: 'C', openQty: 6, tp1Done: true }).reason, 'after-tp1');
  // after TP1 the D'''' pyramid add still works as in r2
  assert.strictEqual(M.addAllowed({ dir: 1, runner: { entry: 20000, contracts: 2 }, originalContracts: 6, addPx: 20040, stop: 20025, tp2: 20100, tp1Done: true, bias: { m15: 0.2, m30: 0.1, line: 0.15 }, control4h: true, rejection: true, cfg: ON }).ok, true);
});
t('upgradeAdd refused twice (once per trade)', () => {
  const first = M.upgradeAdd(UP); assert.strictEqual(first.ok, true);
  assert.strictEqual(M.upgradeAdd({ ...UP, upgradedBefore: true }).reason, 'already-upgraded');
  // the persisted trade after the upgrade is A+, so even without the flag it is refused
  assert.strictEqual(M.upgradeAdd({ ...UP, grade: 'A+', openQty: first.combined.contracts }).reason, 'not-b-or-c');
});
t('upgradeAdd other refusals: not B/C, not A+, the stop moved, no room, bad input', () => {
  const why = (o) => M.upgradeAdd({ ...UP, ...o }).reason;
  assert.strictEqual(why({ grade: 'A+' }), 'not-b-or-c'); assert.strictEqual(why({ grade: 'D' }), 'not-b-or-c');
  assert.strictEqual(why({ newGrade: 'B' }), 'not-a-plus'); assert.strictEqual(why({ newGrade: null }), 'not-a-plus'); assert.strictEqual(why({ grade: 'C', openQty: 6, newGrade: 'B' }), 'not-a-plus');   // C -> B is no upgrade add
  assert.strictEqual(why({ stop: 19985, structuralStop: 19975 }), 'stop-moved');   // a protection move tightened the stop: never size to it
  assert.strictEqual(why({ stop: 20000.25 }), 'stop-moved');                       // at/past the entry
  assert.strictEqual(why({ addPx: 19975 }), 'stop-not-behind-add'); assert.strictEqual(why({ addPx: 19960 }), 'stop-not-behind-add');
  assert.strictEqual(M.upgradeAdd({ ...UP, cfg: withS({ gradeRiskUsd: { A: 600, B: 600, C: 300 } }) }).reason, 'no-room');   // A = B: nothing to top up
  assert.strictEqual(M.upgradeAdd({ ...UP, cfg: withS({ maxContracts: 12 }) }).reason, 'max-contracts');
  assert.strictEqual(why({ openQty: 0 }), 'invalid-input'); assert.strictEqual(why({ dir: 0 }), 'invalid-input'); assert.strictEqual(why({ entry: NaN }), 'invalid-input');
  assert.strictEqual(M.upgradeAdd(null).reason, 'invalid-input');
});
t('GRADE_UPGRADE journal row', () => {
  let u = M.upgradeAdd({ ...UP, openQty: 6, restingQty: 6, addPx: 20005, oldPoints: 3, newPoints: 4 });
  assert.deepStrictEqual({ ...u.row }, { code: 'GRADE_UPGRADE', version: 'money-r3', from: 'B', to: 'A+', reason: 'merged-resting', oldPoints: 3, newPoints: 4, dir: 1, openQty: 6, entry: 20000, stop: 19975,
    addPx: 20005, qty: 10, worstAddPx: 20005, cancelRestingQty: 6, restingQty: 6, openRiskUsd: 300, addRiskUsd: 600, totalRiskUsd: 900, gradeRiskUsd: 900 });
  u = M.upgradeAdd({ ...UP, tp1Done: true, oldPoints: 3, newPoints: 4 });
  assert.deepStrictEqual([u.row.code, u.row.reason, u.row.from, u.row.to, u.row.qty, u.row.totalRiskUsd], ['GRADE_UPGRADE_SKIP', 'after-tp1', 'B', 'A+', 0, null]);
});
t('D5 path: B half fills, re-grades A+ before TP1, resting half merged, exits re-planned as A+ on the combined position', () => {
  const plan0 = M.scaleInPlan(25, 'B', ON), first = M.planExits({ dir: 1, entry: 20000, contracts: plan0.total, stop: 19975, pools: [{ price: 20020 }, { price: 20060 }, { price: 20090, major: true }], grade: 'B' }, ON);
  assert.deepStrictEqual([plan0.first, plan0.second, first.partial.price, first.tp.price], [6, 6, 20020, 20060]);   // B: TP2 the nearest pool >= 2R; TP1 the pool 20020
  assert.strictEqual(M.restingCancel({ dir: 1, bestPx: 20012, tp1Px: first.partial.price }).cancel, false);   // no retest yet, TP1 not reached: keep resting
  const u = M.upgradeAdd({ ...UP, openQty: plan0.first, restingQty: plan0.second, addPx: 20005, oldPoints: 3, newPoints: 4 });
  assert.deepStrictEqual([u.ok, u.qty, u.cancelRestingQty, u.risk.totalUsd], [true, 10, 6, 900]);
  const legs = [{ price: 20000, contracts: 6 }, { price: 20005, contracts: u.qty }];
  const plan = M.planExits({ dir: 1, legs, stop: 19975, pools: [{ price: 20020 }, { price: 20060 }, { price: 20090, major: true }], grade: 'A+' }, ON);   // upgraded: A+ holds for the major pool
  assert.deepStrictEqual([plan.contracts, plan.avgEntry, plan.R, plan.tp.price, plan.tp.basis, plan.partial.price, plan.partial.contracts, plan.addQty], [16, 20003.125, 28.13, 20090, 'major-pool', 20020, 11, 5]);
  assert.strictEqual(M.upgradeAdd({ ...UP, openQty: 16, entry: plan.avgEntry, upgradedBefore: true }).reason, 'already-upgraded');
  assert.strictEqual(M.restingCancel({ dir: 1, bestPx: 20020, tp1Px: plan.partial.price }).reason, 'tp1-reached');
});
t('r2 config compatibility: scaleInA accepted and ignored, r2 entries still graded', () => {
  const R2 = { ...ON, sizing: { enabled: true, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, scaleInA: true } };
  assert.strictEqual(M.problem(R2), null); assert.strictEqual(M.problem({ ...R2, sizing: { ...R2.sizing, scaleInA: false } }), null);
  assert.deepStrictEqual([M.scaleInPlan(25, 'A+', R2).first, M.scaleInPlan(25, 'A+', R2).second], [18, 0]);   // A+ all at once whatever scaleInA says
  assert.deepStrictEqual([M.scaleInPlan(25, 'B', R2).first, M.scaleInPlan(25, 'B', R2).second], [6, 6]);       // scaleInB defaults to true
  assert.match(M.startupLine(R2), /sizing\.scaleInA is ignored since money-r3/); assert.doesNotMatch(M.startupLine(ON), /scaleInA/);
  assert.strictEqual(M.problem(withS({ scaleInB: 'no' })) !== null, true); assert.match(M.problem(withS({ scaleInB: 1 })), /scaleInB/);
  assert.strictEqual(M.isMoneyEntry({ money: { version: 'money-r2' } }), true); assert.strictEqual(M.isMoneyEntry({ money: M.entryRow({ stopPts: 25, grade: 'B', contracts: 6 }, ON) }), true);
  assert.deepStrictEqual([...M.ENTRY_VERSIONS], ['money-r2', 'money-r3']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(M.DEFAULTS.sizing)), { enabled: false, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, scaleInB: true });
  assert.strictEqual(M.problem(JSON.parse(JSON.stringify(M.DEFAULTS))), null);
});
console.log(`moneyRule ${M.VERSION}: ${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
