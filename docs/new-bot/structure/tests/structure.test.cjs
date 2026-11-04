#!/usr/bin/env node
'use strict';
// lib/structure.js tests (MacStructure). Run: nice -n 19 node tests/structure.test.cjs
// 1. Mac's 11/04 witness (playbook §3) on the real replay bars with the BOT'S OWN bias (tests/fixtures/witness-1104-bot.json, tools/build-bias-fixture.cjs).
// 2. No look-ahead: changing every bar after T never changes anything the engine said up to T; a bias reading observed after T is ignored.
// 3. Playbook §8 / spec F core cases, each with its mirror (prices reflected, bias negated, highs <-> lows):
//    failed break + shift -> retest entry; failed break without the internal swing breaking -> no trade; accepted break -> continuation;
//    middle of the 1H range -> no trade.
// 4. The grade TABLE: swap thresholds / gates / bands from cfg, validation.
const path = require('path');
const S = require(path.join(__dirname, '../lib/structure.js'));
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) pass++; else { fail++; console.log('  FAIL', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const group = n => console.log(n);

// ------------------------------------------------------------------ fixture runner
const FX = require(path.join(__dirname, 'fixtures/witness-1104-bot.json'));
function runFixture(fx, cfg0, opt = {}) {
  // r3.2: bare {s15, s30} scalars are OFFLINE input (fixtures / tools); the executor shape {m15:{score, valid, observedAt}} runs under the default strict mode
  const cfg = opt.biasShape === 'executor' || opt.strict ? cfg0 : Object.assign({ biasInput: 'offline' }, cfg0 || {});
  let st = S.createState(); const sigs = [], evs = [], lives = [];
  for (let r of fx.m1) {
    const T = r[0] + 60, rd = fx.readings[String(T)];
    const obs = (T - (opt.biasAgeSec || 0)) * 1000, valid = opt.biasValid !== false;
    const bias = rd ? (opt.biasShape === 'executor' ? { m15: { score: rd[0], valid, observedAt: obs }, m30: { score: rd[1], valid, observedAt: obs } }
      : opt.biasShape === 'scoreOnly' ? { m15: { score: rd[0] }, m30: { score: rd[1] } } : { s15: rd[0], s30: rd[1] }) : null;
    if (opt.dropVolAt && S.ptLabel(r[0]) === opt.dropVolAt) r = r.slice(0, 5);   // MacDot's case: this minute's volume field is missing
    if (opt.zeroVolAt && S.ptLabel(r[0]) === opt.zeroVolAt) r = [...r.slice(0, 5), 0];   // an OBSERVED zero volume
    const input = { m1: opt.noVolume ? [r[0], r[1], r[2], r[3], r[4], 0] : r, bias, levels: rd && !opt.noBoard ? { O4: rd[2], O1: rd[3], PDH: rd[4], PDL: rd[5], AsiaH: rd[6], AsiaL: rd[7], LonH: rd[8], LonL: rd[9] } : null };
    const out = S.step(st, input, cfg); st = out.state;
    for (const e of out.events) evs.push(e);
    if (out.signal) sigs.push(out.signal);
    for (const e of out.events) if (e.type === 'SIGNAL_EXTRA') sigs.push(e.signal);
    if (out.live && out.live.length) lives.push({ T, live: out.live });
  }
  return { st, sigs, evs, lives };
}

group('1. witness 11/04 (playbook §3, spec F)');
const W = runFixture(FX);
const wShort = W.sigs.filter(s => s.dir === -1 && s.at >= '11-03 15:30' && s.at <= '11-03 16:30');
const w = wShort[0];
ok(wShort.length === 1, 'exactly one short in 15:30-16:30', wShort.map(s => s.at));
if (w) {
  ok(w.at >= '11-03 16:08' && w.at <= '11-03 16:09', 'entry at 16:08-16:09 PT (the 1m rejection, no chasing the 15:45 red candle)', w.at);
  ok(Math.abs(w.entryPrice - 28367) <= 3, 'entry ~28,367', w.entryPrice);
  ok(w.kind === 'failed-break' && w.level.name === '4H Open', 'trap at the 4H open', [w.kind, w.level.name]);
  ok(w.chosenStop === 28513 && w.stops.stopType === '4H', 'stop above 28,511 + 2 (4H type, option C)', [w.chosenStop, w.stops.stopType]);
  ok(w.shift && w.shift.tf === 'm5' && w.shift.at === '11-03 15:35' && w.defended && Math.abs(w.defended.price - 28448) <= 1, 'shift = the 15:35 5m displacement (body >= 50%, 3.75x avg) through ~28,448 (GRADE r3 lane)', [w.shift, w.defended]);
  ok(w.retest && Math.abs(w.retest.extreme - 28394) <= 1, 'bounce to ~28,394', w.retest);
  ok(w.grade === 'A+' && w.gradeTotal === 4, 'grade A+ (4) under the default GRADE r3 table', [w.grade, w.gradePoints]);
  ok(w.gradePoints.trap === 1 && w.gradePoints.force === 1 && w.gradePoints.volume === 1 && w.gradePoints.timing === 1 && w.gradePoints.impulseBand === 0, 'witness points: trap force volume timing, no impulse band', w.gradePoints);
  ok(w.evidence.breakVol5m === 13911 && w.evidence.pullbackBars5m.map(x => x.at).join() === '11-03 16:00,11-03 16:05' && w.evidence.pullbackVsBreak5m < 1, 'volume: pullback 16:00/16:05 (forming bar pro-rated) < break 15:35 13,911', w.evidence.pullbackBars5m);
  ok(w.evidence.trapStacked && w.evidence.trapSweptCount >= 2 && w.evidence.sweepMinutesFromOpen <= 60 && w.evidence.forceLegAtrX >= 2, 'trap stacked, timing, force evidence', w.evidence);
  ok(w.evidence.wavePeakBias >= 0.2 && w.evidence.wavePeakBias < 0.3, 'breaking-wave peak ~0.26-0.28 (gate >= 0.20, no impulse band)', w.evidence.wavePeakBias);
  { const n = w.targets.find(t => t.major && t.distanceR >= 2); ok(n && n.price === 28035.25 && /PDL/.test(n.name), 'next major pool beyond 2R = PDL 28,035.25', n); }
  const v = w.evidence;
  for (const k of ['control4h', 'controlKind', 'poolType', 'poolTouches', 'dispBodyPct', 'dispRangeX', 'retestNo', 'wavePeakBias', 'entryBias', 'turnDelta', 'breakVol', 'breakVolMedian20', 'pullbackVsBreak', 'session', 'minutesFromSessionOpen', 'marketState', 'climax'])
    ok(k in v, `evidence field ${k}`);
  ok(v.control4h === true && v.controlKind === 'trap' && v.wavePeakBias >= 0.20 && v.retestNo === 1 && v.session === 'Asia' && v.minutesFromSessionOpen === 68, 'witness evidence values', v);
  ok(Math.abs(v.entryBias) < 0.15, 'no bias gate at the entry minute (GRADE r2: 16:08 bias ~0)', v.entryBias);
  ok(Array.isArray(w.targets) && w.targets.every((t, i, a) => t.price < w.entryPrice && (i === 0 || t.distancePts >= a[i - 1].distancePts)), 'targets: ordered pools below the entry');
  ok(w.swings && w.swings.m5 && Array.isArray(w.swings.m5.highs) && w.swings.m15 && Array.isArray(w.swings.m15.highs), 'minor (1m/5m) and 15m swings exposed for trailing');
  const lv = W.lives.find(x => x.live.some(l => l.setupId === w.setupId));
  ok(lv && lv.live.find(l => l.setupId === w.setupId).currentGrade !== undefined, 'live re-grade reported for the open trade');
}
ok(!W.sigs.some(s => s.dir === -1 && s.at >= '11-03 15:40' && s.at < '11-03 16:08'), 'no short before the retest (I do not chase red candles)');
const W2 = runFixture(FX, null, { biasShape: 'executor' });
ok(W2.sigs.length === W.sigs.length && W2.sigs.every((s, i) => s.id === W.sigs[i].id && s.entryPrice === W.sigs[i].entryPrice), 'executor bias shape {m15:{score,valid,observedAt}} gives the same signals');

group('2. no look-ahead');
{
  const cuts = ['11-03 15:45', '11-03 16:05', '11-03 16:08', '11-03 17:30'];
  for (const cut of cuts) {
    const ci = FX.m1.findIndex(r => S.ptLabel(r[0] + 60) === cut);
    const fx2 = { readings: {}, m1: FX.m1.map((r, i) => (i <= ci ? r : [r[0], 30000 - r[1], 30000 - r[3], 30000 - r[2], 30000 - r[4], r[5] * 3])) };
    for (const [k, v] of Object.entries(FX.readings)) fx2.readings[k] = +k <= FX.m1[ci][0] + 60 ? v : [-(v[0] || 0), -(v[1] || 0), ...v.slice(2)];
    const A = runFixture(FX), B = runFixture(fx2);
    const Tcut = FX.m1[ci][0] + 60, f = e => e.t <= Tcut;
    const ea = JSON.stringify(A.evs.filter(f)), eb = JSON.stringify(B.evs.filter(f));
    ok(ea === eb, `events up to ${cut} identical when the future is rewritten`);
    ok(JSON.stringify(A.sigs.filter(x => x.t <= Tcut)) === JSON.stringify(B.sigs.filter(x => x.t <= Tcut)), `signals (with their frozen evidence) up to ${cut} identical`);
    ok(JSON.stringify(A.lives.filter(x => x.T <= Tcut)) === JSON.stringify(B.lives.filter(x => x.T <= Tcut)), `live re-grades up to ${cut} identical`);
  }
  let st = S.createState();
  const b0 = { t: 1800000000, o: 100, h: 101, l: 99, c: 100, v: 10 };
  const out = S.step(st, { m1: b0, bias: { m15: { score: 0.9, valid: true, observedAt: (b0.t + 120) * 1000 }, m30: { score: 0.5, valid: false } } });
  ok(out.state.bias.length === 0, 'a bias reading observed after the 1m close (or invalid) is ignored');
  const out2 = S.step(out.state, { m1: b0 });
  ok(out2.events[0] && out2.events[0].type === 'STALE_BAR', 'a repeated / older bar is refused (STALE_BAR)');
}

// ------------------------------------------------------------------ synthetic scenarios (short space; mirror = reflect around 1000)
const P = Date.UTC(2026, 10, 10, 15, 0) / 1000;   // 2026-11-10 07:00 PT, a 4H open (NY session)
const M = 1000;
function pathBars(points, t0, t1) {   // points: [[unixSec, price], ...] piecewise linear; 1m bars on [t0, t1)
  const out = []; let j = 0, prevC = null;
  const at = t => { while (j + 1 < points.length && points[j + 1][0] <= t) j++; const [ta, pa] = points[j], nb = points[j + 1]; if (!nb) return pa; const [tb, pb] = nb; return pa + (pb - pa) * (t - ta) / (tb - ta); };
  for (let t = t0; t < t1; t += 60) {
    const o = prevC === null ? at(t) : prevC, c = Math.round(at(t + 60) * 4) / 4;
    out.push({ t, o, h: Math.max(o, c) + 0.25, l: Math.min(o, c) - 0.25, c, v: 1000 }); prevC = c;
  }
  return out;
}
function history(kind) {   // 48 h before P. TREND: a down staircase (lower highs / lower lows on 1H); RANGE: equal 1H highs 1100 / lows 900 around 1000
  const pts = [], H = 3600;
  if (kind === 'trend') { let p = 1090, t = P - 48 * H; pts.push([t, p]); for (let k = 0; k < 6; k++) { t += 5 * H; p -= 30; pts.push([t, p]); t += 3 * H; p += 15; pts.push([t, p]); } pts[pts.length - 1][1] = 1000; }
  else { let t = P - 50 * H; pts.push([t, 1000]); t += 2.5 * H; pts.push([t, 1100]); for (let k = 0; k < 4; k++) { t += 10 * H; pts.push([t, 900]); t += 10 * H; pts.push([t, 1100]); } pts[pts.length - 1] = [P - 2.5 * H, 1100]; pts.push([P, 1000]); }
  return pts;
}
const mn = m => P + m * 60;
function scenario(name) {   // returns { pts, bias(T)->s, board, vol(T)->v|null }
  const lin = (T, a) => { for (let i = 0; i + 1 < a.length; i++) if (T >= mn(a[i][0]) && T <= mn(a[i + 1][0])) { const [ta, va] = a[i], [tb, vb] = a[i + 1]; return va + (vb - va) * (T - mn(ta)) / (mn(tb) - mn(ta)); } return a[a.length - 1][1]; };
  const base = { AsiaL: 990, AsiaH: 1150, PDH: 1180, PDL: 820, LonH: 1170, LonL: 830 };
  if (name === 'trap-shift' || name === 'trap-noshift' || name === 'mid-range') {
    // control SELL "below" the 4H open by our bias; Asia Low 990 is swept from below (failed break up), then the internal low 975 breaks (or not)
    const tail = name === 'trap-noshift'
      ? [[65, 986], [75, 984], [85, 987], [95, 983], [105, 986], [115, 985], [150, 986]]
      : [[65, 980], [70, 966], [85, 964], [100, 972], [102, 973], [104, 971], [106, 968], [110, 964], [130, 955], [150, 950]];   // the bounce is a lower high UNDER the broken swing 975 (no 5m reclaim)
    // r3.1 redraw (no engine change): the first 30 min stay near the 4H open (the 4H opening range ~997-1000 sits with the 4H open, out of the way);
    // a quick stab to 975 (ONE 5m close below Asia Low, so no acceptance and no retest of Asia Low before the trap); the sweep of Asia Low 990
    // from below peaks at 07:53; the 08:00 1H open (~983) does not bridge Asia Low and the 4H-open cluster into one zone
    return { pts: [[mn(0), 1000], [mn(30), 997], [mn(33), 990], [mn(36), 975], [mn(39), 990], [mn(40), 989], [mn(50), 989.5], [mn(53), 995], [mn(57), 986], [mn(60), 983], ...tail.map(([m, p]) => [mn(m), p])],
      bias: T => lin(T, [[0, -0.05], [20, -0.3], [40, -0.3], [55, 0.05], [62, -0.2], [70, -0.32], [100, -0.05], [104, -0.12], [150, -0.3]]), board: base, vol: () => null, hist: name === 'mid-range' ? 'range' : 'trend' };
  }
  if (name === 'accept' || name === 'accept-weak' || name === 'accept-lowwave') {   // control SELL below the 4H open; Asia Low 990 breaks DOWN on volume, holds 2 closes, defended retest from below, 1m rejection
    // accept-weak (r3.1): bias only -0.10 at the 2nd close outside (07:50), breaking-wave peak -0.25 at 08:00 -> accepted, wave gate passes.
    // accept-lowwave (r3.1): the wave peak is only -0.18 -> GRADE_NO_TRADE naming the wave gate (wavePeakBias).
    const bz = name === 'accept' ? [[0, -0.05], [20, -0.3], [55, -0.35], [80, -0.1], [84, -0.2], [150, -0.3]]
      : name === 'accept-weak' ? [[0, -0.05], [20, -0.12], [50, -0.10], [60, -0.25], [70, -0.2], [80, -0.05], [84, -0.1], [150, -0.1]]
        : [[0, -0.05], [20, -0.17], [40, -0.17], [50, -0.10], [60, -0.18], [80, -0.05], [84, -0.1], [150, -0.1]];
    return { pts: [[mn(0), 1000], [mn(30), 998], [mn(40), 993], [mn(45), 984], [mn(55), 975], [mn(65), 968], [mn(80), 986], [mn(82), 988.5], [mn(84), 984], [mn(95), 965], [mn(150), 950]],
      bias: T => lin(T, bz), board: base,
      vol: T => (T > mn(40) && T <= mn(45) ? 4000 : T > mn(66) && T <= mn(84) ? 400 : null), hist: 'trend' };
  }
  // ---- r3.2 scenarios
  const far = { AsiaL: 900, AsiaH: 1100, PDH: 1180, PDL: 820, LonH: 1170, LonL: 830 };   // no board pool near the 4H open
  if (name === 'trap-hold' || name === 'trap-hold-void') {
    // a failed break ABOVE the 4H open (ext 1012.25) -> SELL trap control at 07:50; then a failed break BELOW the open (ext 984.75), price back above
    // the open at 08:05 while 1012.25 still holds: r3.1 flipped to a BUY trap; r3.2 holds. -void: 1012.25 is taken back at ~07:77 -> VOID, then the BUY trap forms.
    const tail = name === 'trap-hold' ? [[80, 1006], [239, 1005], [250, 1004]] : [[80, 1013.5], [150, 1008]];
    return { pts: [[mn(0), 1000], [mn(30), 999], [mn(33), 1001], [mn(38), 1012], [mn(42), 1006], [mn(47), 994], [mn(50), 994], [mn(53), 1001], [mn(55), 1001], [mn(58), 990], [mn(61), 985], [mn(65), 1004],
      ...tail.map(([m, p]) => [mn(m), p])], bias: () => 0, board: far, vol: () => null, hist: 'trend', endMin: name === 'trap-hold' ? 250 : 150 };
  }
  if (name === 'bias-trap') {   // bias control SELL "below" at 07:33, then a failed break BELOW the open: the BUY trap replaces the bias control at once (ruling)
    return { pts: [[mn(0), 1000], [mn(30), 999], [mn(34), 998], [mn(45), 1001], [mn(55), 1001], [mn(58), 990], [mn(61), 985], [mn(65), 1004], [mn(150), 1005]],
      bias: T => lin(T, [[0, -0.05], [20, -0.3], [150, -0.3]]), board: far, vol: () => null, hist: 'trend' };
  }
  if (name === 'trap-after-cancel' || name === 'trap-chase') {
    // trap-after-cancel: TWO closes below Asia Low first (an accepted-break setup arms, retests, is cancelled RETEST_DEEP), then the sweep from below
    // and the shift: the trap's bounce is ITS break's first retest (r3.1 counted it 2 per zone and skipped it).
    // trap-chase: the shift candle closes 3.75 pts under the broken swing and the next red continuation bars sit within retestTolPts of it: no entry
    // there (r3.1 shorted the red bar 2 min after the shift); the real bounce at ~08:38 and its rejection is the entry.
    const head = name === 'trap-after-cancel'
      ? [[0, 1000], [30, 997], [40, 975], [45, 979], [50, 985], [53, 995], [57, 986], [60, 983]]
      : [[0, 1000], [30, 997], [33, 990], [36, 975], [39, 990], [40, 989], [50, 989.5], [53, 995], [57, 986], [60, 983]];
    const tail = name === 'trap-after-cancel'
      ? [[65, 980], [70, 966], [85, 964], [100, 972], [102, 973], [104, 971], [106, 968], [110, 964], [130, 955], [150, 950]]
      : [[65, 980], [70, 971], [72, 969], [85, 960], [100, 968], [102, 969], [104, 967], [106, 964], [110, 960], [130, 952], [150, 948]];
    return { pts: [...head, ...tail].map(([m, p]) => [mn(m), p]),
      bias: T => lin(T, [[0, -0.05], [20, -0.3], [40, -0.3], [55, 0.05], [62, -0.2], [70, -0.32], [100, -0.05], [104, -0.12], [150, -0.3]]), board: base, vol: () => null, hist: 'trend' };
  }
  throw new Error(name);
}
function runScenario(name, mirror, cfg0, opt = {}) {
  const cfg = Object.assign({ biasInput: 'offline' }, cfg0 || {});   // synthetic scenarios feed bare scalars (offline input)
  const sc = scenario(name), X = p => (mirror ? 2 * M - p : p);
  const hist = history(sc.hist), allPts = [...hist.filter(x => x[0] < P), ...sc.pts];
  const bars = pathBars(allPts, P - (opt.histHours || 48) * 3600, mn(sc.endMin || 150));
  const swap = { AsiaL: 'AsiaH', AsiaH: 'AsiaL', PDH: 'PDL', PDL: 'PDH', LonH: 'LonL', LonL: 'LonH' };
  const board = {}; for (const [k, v] of Object.entries(sc.board)) board[mirror ? swap[k] : k] = X(v);
  let st = S.createState(); const sigs = [], evs = [];
  for (const b0 of bars) {
    const v = sc.vol(b0.t + 60);
    const b = mirror ? { t: b0.t, o: X(b0.o), h: X(b0.l), l: X(b0.h), c: X(b0.c), v: v || b0.v } : Object.assign({}, b0, { v: v || b0.v });
    const T = b.t + 60, inScn = T > P, s = inScn ? sc.bias(T) : 0;
    const out = S.step(st, { m1: b, bias: inScn ? { s15: mirror ? -s : s, s30: mirror ? -s : s } : null, levels: Object.assign({ O4: T > P ? X(1000) : null }, board) }, cfg);
    st = out.state; evs.push(...out.events); if (out.signal) sigs.push(out.signal);
  }
  return { sigs, evs, st };
}
const lbl = T => S.ptLabel(T).slice(6);

group('3. playbook §8 core cases, each with its mirror');
for (const mirror of [false, true]) {
  const d = mirror ? 1 : -1, tag = mirror ? '(mirror, long)' : '(short)';
  {   // §8.2: failed break + displacement shift + retest rejection = the trade
    const R = runScenario('trap-shift', mirror);
    const s = R.sigs.find(x => x.kind === 'failed-break');
    ok(s && s.dir === d, `trap-shift ${tag}: failed-break signal in the trap direction`, R.sigs.map(x => [x.at, x.kind, x.dir]));
    if (s) {
      ok(R.evs.some(e => e.type === 'SHIFT' && e.dir === d) && R.evs.some(e => e.type === 'FAIL'), `trap-shift ${tag}: FAIL then SHIFT before the entry`);
      ok(lbl(s.t) >= '08:40' && lbl(s.t) <= '08:50', `trap-shift ${tag}: entry on the retest rejection (~08:43), not on the shift candle`, lbl(s.t));
      ok(s.stops.stopType === '1H' && (d < 0 ? s.chosenStop > s.entryPrice : s.chosenStop < s.entryPrice), `trap-shift ${tag}: hour-type level -> 1H wick stop beyond the entry`, s.stops);
      ok(s.evidence.retestNo === 1 && s.evidence.control4h === true && s.evidence.controlKind === (mirror ? 'above' : 'below'), `trap-shift ${tag}: evidence`, s.evidence);
      ok(s.targets.length > 0 && s.targets.every(t => (d < 0 ? t.price < s.entryPrice : t.price > s.entryPrice)), `trap-shift ${tag}: targets in the trade direction`);
    }
    ok(!R.sigs.some(x => x.dir === -d), `trap-shift ${tag}: nothing against the 4H`);
  }
  {   // §8.2 / spec F: a reclaim / failed break WITHOUT the internal swing breaking -> no trade
    const R = runScenario('trap-noshift', mirror);
    ok(R.evs.some(e => e.type === 'FAIL' && e.zone === (mirror ? 'Asia High' : 'Asia Low')), `trap-noshift ${tag}: the failure is seen`, R.evs.filter(e => e.type === 'FAIL').map(e => e.zone));
    ok(!R.evs.some(e => e.type === 'SHIFT' && e.dir === d), `trap-noshift ${tag}: no shift the trap way`, R.evs.filter(e => e.type === 'SHIFT'));
    ok(R.sigs.length === 0, `trap-noshift ${tag}: no trade (failure alone is not a trade)`, R.sigs.map(x => [x.at, x.kind]));
  }
  {   // §8.1 / §13: accepted break -> continuation on the defended retest
    const R = runScenario('accept', mirror);
    const s = R.sigs.find(x => x.kind === 'accepted-break');
    ok(s && s.dir === d, `accept ${tag}: accepted-break continuation signal`, R.sigs.map(x => [x.at, x.kind, x.dir]).concat(R.evs.filter(e => /ACCEPT|RETEST|SKIP|CANCEL/.test(e.type)).map(e => [e.at, e.type, e.zone, e.why])));
    if (s) {
      ok(lbl(s.t) >= '08:22' && lbl(s.t) <= '08:30', `accept ${tag}: entry on the retest rejection (~08:24)`, lbl(s.t));
      ok(s.evidence.breakVolX >= 2 && s.evidence.pullbackVsBreak < 1, `accept ${tag}: break volume > median, pullback volume < break volume (§13.2-3)`, [s.evidence.breakVolX, s.evidence.pullbackVsBreak]);
      ok(d < 0 ? s.chosenStop > s.entryPrice : s.chosenStop < s.entryPrice, `accept ${tag}: stop beyond the entry`);
    }
  }
  {   // §8.6 / spec A: the middle of the 1H range is a no-trade zone
    const R = runScenario('mid-range', mirror);
    ok(R.st.mstate.state === 'RANGE', `mid-range ${tag}: 1H state is RANGE`, R.st.mstate);
    ok(R.sigs.length === 0 && R.evs.some(e => e.type === 'SIGNAL_SKIP' && /MID_RANGE/.test(e.why)), `mid-range ${tag}: skipped MID_RANGE, no trade`, R.evs.filter(e => e.type === 'SIGNAL_SKIP').map(e => e.why));
  }
  {   // r3.1 C.1: no point-in-time bias check at the acceptance; the frozen wave peak is the bias gate
    const R = runScenario('accept-weak', mirror), acc = R.evs.find(e => e.type === 'ACCEPT' && e.zone === (mirror ? 'Asia High' : 'Asia Low'));
    ok(acc && Math.abs(acc.s15) <= 0.1001 && Math.abs(acc.s15) < 0.15, `accept-weak ${tag}: accepted with bias only 0.10 at the 2nd close outside`, acc);
    const s = R.sigs.find(x => x.kind === 'accepted-break');
    ok(s && s.dir === d && s.gradeGates.waveBias === true && Math.abs(s.evidence.wavePeakBias - 0.25) < 0.011, `accept-weak ${tag}: wave peak 0.25 -> gate passes, trade taken`, s ? [s.gradeGates, s.evidence.wavePeakBias] : R.evs.filter(e => /GRADE_NO|SKIP|CANCEL/.test(e.type)));
    const R2 = runScenario('accept-lowwave', mirror), nt = R2.evs.find(e => e.type === 'GRADE_NO_TRADE');
    ok(!R2.sigs.some(x => x.kind === 'accepted-break'), `accept-lowwave ${tag}: no trade`, R2.sigs.map(x => [x.at, x.kind]));
    ok(nt && nt.missing.includes('waveBias') && nt.why.some(w => /wavePeakBias gte 0.2 got 0.18/.test(w)), `accept-lowwave ${tag}: GRADE_NO_TRADE names the wave gate (wavePeakBias 0.18 < 0.20)`, nt);
  }
  {   // fail-closed: 1H range unknown (3 h of history: no two 1H swing highs/lows) -> notMidRange cannot pass
    const R = runScenario('trap-shift', mirror, null, { histHours: 3 }), nt = R.evs.find(e => e.type === 'GRADE_NO_TRADE');
    ok(R.sigs.length === 0 && nt && nt.missing.includes('notMidRange'), `1H range unknown ${tag}: no trade, gate notMidRange fails`, nt || R.sigs.map(x => x.at));
  }
}

group('4. grade table (cfg.grade, GRADE r3)');
{
  const g = S.DEFAULTS.grade;
  ok(S.validateCfg().length === 0, 'defaults validate', S.validateCfg());
  const base = { control4h: true, kind: 'failed-break', dispBodyPct: 0.59, dispRangeX: 3.75, wavePeakBias: 0.27, retestNo: 1, midRange: false, stopLogical: true,
    trapStacked: true, forceLegAtrX: 3.2, pullbackVsBreak5m: 0.79, sweepMinutesFromOpen: 35, entryBias: 0.01 };
  let r = S.gradeOf(base, g);
  ok(r.grade === 'A+' && r.total === 4 && r.missing.length === 0, 'witness-like evidence = A+ (4)', r);
  r = S.gradeOf(Object.assign({}, base, { entryBias: -0.9 }), g); ok(r.grade === 'A+', 'entry-minute bias is not a gate');
  r = S.gradeOf(Object.assign({}, base, { wavePeakBias: 0.19 }), g); ok(r.grade === null && r.missing.includes('waveBias'), 'wave peak < 0.20 -> no trade');
  r = S.gradeOf(Object.assign({}, base, { control4h: false }), g); ok(r.grade === null && r.missing.includes('control4h'), '4H control required');
  r = S.gradeOf(Object.assign({}, base, { retestNo: 2 }), g); ok(r.grade === null && r.missing.includes('firstRetest'), 'first retest is a GATE');
  r = S.gradeOf(Object.assign({}, base, { dispBodyPct: 0.45 }), g); ok(r.grade === null && r.missing.includes('laneTrigger'), 'failed break needs a displacement shift (body >= 50%)');
  r = S.gradeOf(Object.assign({}, base, { kind: 'accepted-break', acceptClosesOut: 2, retestClosedInside: false }), g); ok(r.grade === 'A+', 'accepted break + defended retest is a lane');
  r = S.gradeOf(Object.assign({}, base, { kind: 'accepted-break', acceptClosesOut: 2, retestClosedInside: true }), g); ok(r.grade === null && r.missing.includes('laneTrigger'), 'retest closed back inside -> no lane');
  r = S.gradeOf(Object.assign({}, base, { midRange: true }), g); ok(r.grade === null && r.missing.includes('notMidRange'), 'mid-range gate');
  r = S.gradeOf(Object.assign({}, base, { stopLogical: false }), g); ok(r.grade === null && r.missing.includes('logicalStop'), 'logical stop gate');
  r = S.gradeOf(Object.assign({}, base, { wavePeakBias: 0.33 }), g); ok(r.grade === 'A+' && r.total === 5, 'impulse band 0.30-0.40 adds a point (5)');
  r = S.gradeOf(Object.assign({}, base, { wavePeakBias: 0.42 }), g); ok(r.grade === 'C' && r.uncapped === 'A+' && r.tags.includes('exhaustion-watch'), 'peak >= 0.40 caps at C (exhaustion-watch)', r);
  r = S.gradeOf(Object.assign({}, base, { trapStacked: false }), g); ok(r.grade === 'B' && r.total === 3, '3 points = B');
  r = S.gradeOf(Object.assign({}, base, { trapStacked: false, forceLegAtrX: 1, dispRangeX: 1.5, pullbackVsBreak5m: 1.2, sweepMinutesFromOpen: 90 }), g); ok(r.grade === 'C' && r.total === 0, '0 points = C (still a trade)');
  r = S.gradeOf(Object.assign({}, base, { forceLegAtrX: 1, dispRangeX: 2.1 }), g); ok(r.points.force === 1, 'force by shift bar >= 2x average range');
  const t = JSON.parse(JSON.stringify(g)); t.required.find(q => q.name === 'waveBias').when[0].value = 0.30;
  r = S.gradeOf(base, t); ok(r.grade === null && r.missing.includes('waveBias'), 'table thresholds come from cfg');
  ok(S.validateCfg({ grade: t }).length === 0, 'swapped table validates');
  ok(S.validateCfg({ grade: { required: [{ name: 'x', when: [{ field: 'a', op: 'zz' }] }], factors: [], bands: [['A+', 4]] } }).length > 0, 'bad op refused');
  ok(S.validateCfg({ grade: { required: [], factors: [{ name: 'f', points: 1, when: [{ field: 'a', op: 'gte', value: 'x' }] }], bands: [['A+', 4], ['B', 5]] } }).length >= 2, 'bad threshold + bands not stepping down refused');
  ok(S.validateCfg({ grade: Object.assign({}, g, { caps: [{ name: 'c', maxBand: 'Z', when: [{ field: 'a', op: 'truthy' }] }] }) }).length > 0, 'cap with an unknown band refused');
  const W3 = runFixture(FX, { grade: t }); ok(!W3.sigs.some(s => s.dir === -1 && s.at >= '11-03 16:08' && s.at <= '11-03 16:09'), 'witness with a 0.30 wave gate is not taken (cfg drives the engine)');
}

group('6. r3.2 rulings: trap control holds, Rounds are context only, first retest per break, the bounce is a real counter-move');
for (const mirror of [false, true]) {
  const d = mirror ? 1 : -1, tag = mirror ? '(mirror)' : '(base)', ctl = R => R.evs.filter(e => /^CONTROL_|^PERIOD$/.test(e.type) && e.t > P);
  {   // 1. a mid-4H opposite trap is blocked while the trap extreme holds; the 4H close clears it
    const R = runScenario('trap-hold', mirror), ev = ctl(R), form = ev.find(e => e.type === 'CONTROL_FORM'), hold = ev.find(e => e.type === 'CONTROL_HOLD');
    ok(form && form.dir === d && form.kind === 'trap' && lbl(form.t) === '07:50', `trap-hold ${tag}: the failed break of the open forms the trap control at 07:50`, ev);
    ok(hold && hold.dir === d && hold.blockedDir === -d && lbl(hold.t) === '08:05', `trap-hold ${tag}: the opposite trap at 08:05 is BLOCKED (CONTROL_HOLD), the old extreme still holds`, ev);
    ok(!ev.some(e => e.type === 'CONTROL_FLIP' || e.type === 'CONTROL_VOID'), `trap-hold ${tag}: no flip and no void inside the 4H`, ev.map(e => [lbl(e.t), e.type, e.dir]));
    const per = ev.find(e => e.type === 'PERIOD' && e.t > mn(200));
    ok(per && per.start === '11-10 11:00' && R.st.period.t === mn(240) && R.st.period.control === null, `trap-hold ${tag}: the 4H close clears it (new candle re-reads, control null)`, [per, R.st.period.control]);
    const R1 = runScenario('trap-hold', mirror, { trapControlHolds: false });
    ok(ctl(R1).some(e => e.type === 'CONTROL_FLIP' && e.dir === -d && lbl(e.t) === '08:05'), `trap-hold ${tag}: control check, trapControlHolds false reproduces the r3.1 flip`, ctl(R1));
  }
  {   // the extreme taken back clears it; the pending opposite trap may then form (a FORM, not a flip)
    const R = runScenario('trap-hold-void', mirror), ev = ctl(R), vo = ev.find(e => e.type === 'CONTROL_VOID'), f2 = ev.filter(e => e.type === 'CONTROL_FORM')[1];
    ok(vo && vo.dir === d && f2 && f2.dir === -d && f2.kind === 'trap' && f2.t >= vo.t && !ev.some(e => e.type === 'CONTROL_FLIP'), `trap-hold-void ${tag}: extreme taken back -> VOID, then the opposite trap FORMS`, ev.map(e => [lbl(e.t), e.type, e.dir]));
  }
  {   // bias control -> opposite trap still replaces at once (ruling 1)
    const R = runScenario('bias-trap', mirror), ev = ctl(R), b0 = ev.find(e => e.type === 'CONTROL_FORM'), fl = ev.find(e => e.type === 'CONTROL_FLIP');
    ok(b0 && b0.kind === (mirror ? 'above' : 'below') && fl && fl.kind === 'trap' && fl.dir === -d && fl.from === d, `bias-trap ${tag}: bias control ${mirror ? 'above' : 'below'} is replaced by the opposite trap (CONTROL_FLIP)`, ev.map(e => [lbl(e.t), e.type, e.kind, e.dir]));
  }
  {   // 3. first retest per break: a cancelled setup's touch on the same zone does not use up the trap's first retest
    const R = runScenario('trap-after-cancel', mirror), z = mirror ? 'Asia High' : 'Asia Low';
    const acc = R.evs.find(e => e.type === 'SETUP_ARM' && e.kind === 'accepted-break' && e.zone === z), accRt = acc && R.evs.find(e => e.type === 'RETEST' && e.setup === acc.setup);
    const accCx = acc && R.evs.find(e => e.type === 'SETUP_CANCEL' && e.setup === acc.setup), s = R.sigs.find(x => x.kind === 'failed-break');
    ok(acc && accRt && accRt.n === 1 && accCx, `trap-after-cancel ${tag}: the accepted-break setup on ${z} retested (n=1) and was cancelled`, R.evs.filter(e => /ARM|RETEST|CANCEL/.test(e.type)).map(e => [lbl(e.t), e.type, e.setup, e.n, e.why]));
    ok(s && s.dir === d && s.evidence.retestNo === 1 && !R.evs.some(e => e.type === 'RETEST_2_SKIP'), `trap-after-cancel ${tag}: the later break's first retest is allowed (retestNo 1, traded)`, s ? s.evidence.retestNo : R.evs.filter(e => /SKIP|GRADE_NO/.test(e.type)));
  }
  {   // 2. the bounce must be a real counter-move: no shorting the red continuation bar after the shift; the real bounce + rejection is the entry
    const R = runScenario('trap-chase', mirror), sh = R.evs.find(e => e.type === 'SHIFT' && e.dir === d), s = R.sigs.find(x => x.kind === 'failed-break');
    ok(sh && R.evs.some(e => e.type === 'BOUNCE_NOT_COUNTER' && e.t <= mn(75)), `trap-chase ${tag}: the continuation bar near the swing right after the shift is journalled BOUNCE_NOT_COUNTER`, R.evs.filter(e => /SHIFT|BOUNCE|RETEST/.test(e.type)).map(e => [lbl(e.t), e.type]));
    ok(!R.sigs.some(x => x.t <= mn(80)), `trap-chase ${tag}: no entry on the red continuation bars (08:10-08:20)`, R.sigs.map(x => lbl(x.t)));
    ok(s && s.dir === d && lbl(s.t) >= '08:38' && lbl(s.t) <= '08:50', `trap-chase ${tag}: entry after the real bounce and its rejection`, s ? lbl(s.t) : R.evs.filter(e => /RETEST|REJECT|SKIP|GRADE_NO|CANCEL/.test(e.type)).map(e => [lbl(e.t), e.type, e.why]));
  }
}
{   // 3. unit: a 2nd touch of the SAME break counts 2 and is skipped; another break / the other lane starts at 1
  const st = S.createState(), I = S._internal, a = { id: 'Sa', kind: 'accepted-break', dir: 1, zone: { key: 'Z@1', name: 'Z' }, breakT: 100, armT: 200 };
  ok(I.noteRetest(st, a) === 1 && I.noteRetest(st, a) === 2, 'same break: 1st touch n=1, 2nd touch n=2');
  ok(I.noteRetest(st, Object.assign({}, a, { breakT: 300 })) === 1, 'a new break of the same zone starts at n=1');
  ok(I.noteRetest(st, Object.assign({}, a, { kind: 'failed-break', dir: 1 })) === 1, 'the other lane on the same zone starts at n=1');
  const evs = [], ctx = { cfg: S.resolveCfg(), b: { c: 1 }, T: 1, E: (type, o) => evs.push(Object.assign({ type }, o)), sigs: [] };
  I.rejectionEntry(st, ctx, Object.assign({}, a, { retestNo: 2, status: 'armed' }));
  ok(evs.length === 1 && evs[0].type === 'RETEST_2_SKIP' && ctx.sigs.length === 0, 'a 2nd touch of the same break is skipped (RETEST_2_SKIP), never traded', evs);
}
{   // 2. rounds: context only (witness 11/04 + the whole fixture)
  const R = runFixture(FX), w = R.sigs.find(x => x.at === '11-03 16:08');
  ok(R.sigs.every(x => !x.targets.some(t => /Round/.test(t.name))), 'no Round pool in any signal target list (TP1/TP2 candidates)');
  ok(w && w.contextPools.some(c => c.price === 28350) && w.targets[0].price === 28324.5 && /1H Open/.test(w.targets[0].name), 'witness: Round 28,350 is context only; the first target is the 1H Open 28,324.5 (0.29R), not Round 28,350 (0.11R)', w && [w.targets[0], w.contextPools]);
  ok(R.st.zones.filter(z => z.members.some(m => m.src === 'round')).every(z => z.members.length === 1 && !z.setup), 'Round zones are never merged into a real pool zone and never a setup');
  const RT = runFixture(FX, { pools: { roundAsTarget: true } }), wt = RT.sigs.find(x => x.at === '11-03 16:08');
  ok(wt && wt.targets.some(t => /Round/.test(t.name)), 'cfg pools.roundAsTarget true puts Rounds back as targets (config, default false)');
}

group('7. r3.2 MacDot review: bias provenance (strict / offline) and volume completeness');
{
  const T0 = 1800000000, nb = S._internal.normBias, ok15 = { score: 0.3, valid: true, observedAt: T0 * 1000 };
  const cases = [
    ['nested {score} only, no valid / observedAt', { m15: { score: 0.3 }, m30: { score: 0.2 } }],
    ['bare s15 next to an INVALID nested m15', { s15: 0.3, m15: { score: 0.3, valid: false, observedAt: T0 * 1000 } }],
    ['bare s15 next to a STALE nested m15', { s15: 0.3, m15: { score: 0.3, valid: true, observedAt: (T0 - 600) * 1000 } }],
    ['bare s15 next to a FUTURE nested m15', { s15: 0.3, m15: { score: 0.3, valid: true, observedAt: (T0 + 60) * 1000 } }],
  ];
  for (const [nm, x] of cases) ok(nb(x, T0, 120, 'strict') === null, `strict: ${nm} -> rejected (no bias this minute)`);
  ok(nb({ s15: 0.3, m15: ok15 }, T0, 120, 'strict') === null, 'strict: even a VALID nested reading next to a bare scalar is ambiguous -> rejected');
  ok(nb({ s15: 0.3, s30: 0.2 }, T0, 120, 'strict') === null && nb({ m15: 0.3 }, T0, 120, 'strict') === null, 'strict: bare scalars (s15/s30, or m15 as a number) rejected');
  ok(nb({ m15: ok15 }, T0, 120, 'strict').s15 === 0.3 && nb({ m15: ok15 }, T0, 120).s15 === 0.3, 'strict (the default): a valid, fresh, as-of reading is used');
  ok(nb({ s15: 0.3, s30: 0.2 }, T0, 120, 'offline').s15 === 0.3, 'offline (fixtures / tools): bare scalars accepted');
  ok(S.DEFAULTS.biasInput === 'strict' && S.validateCfg({ biasInput: 'loose' }).length > 0, 'default biasInput is strict; an unknown mode is refused');
  const Rs = runFixture(FX, null, { biasShape: 'scoreOnly', strict: true }), Ro = runFixture(FX, null, { biasShape: 'scoreOnly' }), Rb = runFixture(FX);
  ok(Rs.sigs.length === 0, 'the fixture with nested {score}-only readings: 0 signals in strict', Rs.sigs.length);
  ok(Ro.sigs.length === Rb.sigs.length && Ro.sigs.every((x, i) => x.id === Rb.sigs[i].id && x.entryPrice === Rb.sigs[i].entryPrice && x.grade === Rb.sigs[i].grade), 'the same fixture in offline: signals unchanged', [Ro.sigs.length, Rb.sigs.length]);
  const Rx = runFixture(FX, null, { strict: true }); ok(Rx.sigs.length === 0, 'bare-scalar fixture fed in strict mode: 0 signals (tools must declare offline)');
  // volume completeness: MacDot's exact case (the 11-03 16:06 minute has no volume field)
  const RV = runFixture(FX, null, { dropVolAt: '11-03 16:06' }), wv = RV.sigs.find(x => x.at === '11-03 16:08');
  ok(wv && wv.gradePoints.volume === 0 && wv.evidence.pullbackVsBreak5m === null && wv.evidence.pullbackVolMissing === true, 'one pullback minute without volume -> the volume point is withheld (null evidence), not 1', wv && [wv.gradePoints, wv.evidence.pullbackBars5m]);
  ok(wv && wv.grade === 'B' && wv.gradeTotal === 3 && wv.entryPrice === 28366.75 && wv.chosenStop === 28513, 'under that test only: the 11/04 witness grades B (3), same entry and stop', wv && [wv.grade, wv.gradeTotal]);
  const RZ = runFixture(FX, null, { zeroVolAt: '11-03 16:06' }), wz = RZ.sigs.find(x => x.at === '11-03 16:08');
  ok(wz && typeof wz.evidence.pullbackVsBreak5m === 'number' && wz.evidence.pullbackVolMissing === false && wz.gradePoints.volume === 1, 'an OBSERVED 0 volume is data, not missing (comparison computed)', wz && wz.evidence.pullbackBars5m);
}

group('5. fail-closed: a missing or unknown input never awards a point and never passes a gate');
{
  const g = S.DEFAULTS.grade;
  const base = { control4h: true, kind: 'failed-break', dispBodyPct: 0.59, dispRangeX: 3.75, wavePeakBias: 0.33, retestNo: 1, midRange: false, stopLogical: true,
    trapStacked: true, forceLegAtrX: 3.2, pullbackVsBreak5m: 0.79, sweepMinutesFromOpen: 35, acceptClosesOut: 2, retestClosedInside: false };
  const full = S.gradeOf(base, g); ok(full.total === 5 && full.grade === 'A+', 'reference evidence = 5 points');
  const flat = w => w.flatMap(c => (c && Array.isArray(c.any) ? flat(c.any.flat()) : [c]));
  const fields = [...new Set([...g.required, ...g.factors, ...g.caps].flatMap(r => flat(r.when)).map(c => c.field))];
  let worst = null;
  for (const f of fields) for (const bad of ['delete', null, NaN, 'x', {}]) {
    const ev = Object.assign({}, base); if (bad === 'delete') delete ev[f]; else ev[f] = bad;
    const r = S.gradeOf(ev, g);
    const gatesNeeding = g.required.filter(q => flat(q.when).some(c => c.field === f) && !(q.when.some(c => c.any)));
    if (r.total > full.total || gatesNeeding.some(q => r.gates[q.name])) worst = [f, bad, r];
    const facNeeding = g.factors.filter(x => !x.when.some(c => c.any) && flat(x.when).some(c => c.field === f));
    if (facNeeding.some(x => r.points[x.name] > 0)) worst = [f, bad, r.points];
  }
  ok(worst === null, `every table field (${fields.length}) missing / null / NaN / wrong type: no gate it needs passes, no point it needs is awarded`, worst);
  const none = S.gradeOf({}, g); ok(none.grade === null && none.total === 0 && Object.values(none.gates).every(x => !x), 'empty evidence: every gate fails, 0 points, no trade', none);
  let r = S.gradeOf(Object.assign({}, base, { kind: 'accepted-break', acceptClosesOut: null }), g); ok(!r.gates.laneTrigger, 'accepted lane with closes outside unknown fails');
  r = S.gradeOf(Object.assign({}, base, { forceLegAtrX: null, dispRangeX: null }), g); ok(r.points.force === 0 && !r.gates.laneTrigger, 'ATR / average range missing: no force point, no lane');
  r = S.gradeOf(Object.assign({}, base, { wavePeakBias: null }), g); ok(r.grade === null && r.points.impulseBand === 0 && !r.capped.length, 'wave peak unknown: gate fails, no impulse point, no cap');
  // bias invalid / stale / future (engine)
  const T0 = 1800000000, nb = S._internal.normBias;
  ok(nb({ m15: { score: 0.5, valid: false, observedAt: T0 * 1000 } }, T0, 120) === null, 'bias valid:false ignored');
  ok(nb({ m15: { score: 0.5, valid: true, observedAt: (T0 - 300) * 1000 } }, T0, 120) === null, 'bias observed 5 min before the close (stale) ignored');
  ok(nb({ m15: { score: 0.5, valid: true, observedAt: (T0 + 1) * 1000 } }, T0, 120) === null, 'bias observed after the close (future) ignored');
  ok(nb({ m15: { score: NaN, valid: true } }, T0, 120) === null && nb({ m15: { score: '0.5' } }, T0, 120) === null, 'non-numeric score ignored');
  ok(nb({ m15: { score: 0.5, valid: true, observedAt: (T0 - 60) * 1000 } }, T0, 120).s15 === 0.5, 'a fresh reading (60 s old) is used');
  for (const [nm, o] of [['invalid', { biasShape: 'executor', biasValid: false }], ['stale', { biasShape: 'executor', biasAgeSec: 600 }]]) {
    const R = runFixture(FX, null, o), nt = R.evs.find(e => e.type === 'GRADE_NO_TRADE' && e.at === '11-03 16:08');
    ok(!R.sigs.length && nt && nt.missing.includes('waveBias'), `witness with every bias reading ${nm}: no trade; GRADE_NO_TRADE at 16:08 names waveBias`, [R.sigs.length, nt && nt.missing]);
  }
  // volume missing (engine): no volume point, the rest of the grade unchanged
  const RV = runFixture(FX, null, { noVolume: true }), wv = RV.sigs.find(x => x.at === '11-03 16:08');
  ok(wv && wv.gradePoints.volume === 0 && wv.evidence.pullbackVsBreak5m === null && wv.grade === 'B', 'witness with no volume: volume point 0 (null evidence), grade B (3)', wv && [wv.gradePoints, wv.evidence.pullbackVsBreak5m]);
  // ATR missing (engine): no 5m bars -> no ATR -> no force ratio
  const fe = S._internal.forceEvidence({ bars: { m5: [] } }, S.DEFAULTS, 100, 50); ok(fe.forceLegAtrX === null && fe.forceAtr5 === null, 'ATR missing: forceLegAtrX null', fe);
  // 1H range unknown (engine)
  ok(S._internal.midRangeOf(S.createState(), S.DEFAULTS, 1000) === null, '1H range unknown: midRange null (gate notMidRange fails)');
  // pools missing: no board -> no board pool is ever invented as trap / swept / target
  const RB = runFixture(FX, null, { noBoard: true }), boardNames = /PDH|PDL|Asia High|Asia Low|London High|London Low/;
  ok(RB.sigs.every(x => !x.evidence.trapObviousPools.some(n => boardNames.test(n)) && !x.evidence.trapSweptLevels.some(n => boardNames.test(n)) && !x.targets.some(t => boardNames.test(t.name))),
    'board missing: no PDH/PDL/session pool appears in any trap, swept list or target', RB.sigs.map(x => [x.at, x.evidence.trapObviousPools, x.evidence.trapSweptLevels]));
  ok(RB.sigs.every(x => !x.gradePoints.trap || x.evidence.trapObviousPools.length > 0 || x.evidence.trapSweptCount >= 2), 'board missing: a trap point is only ever backed by a pool the engine actually has');
  ok(S._internal.sweptLevels({ levels: {}, period: null, orb: {}, lastT: 0 }, S.DEFAULTS, -1, 100, 120).length === 0, 'no levels: nothing swept');
}

console.log(`\nstructure ${S.VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
