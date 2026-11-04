#!/usr/bin/env node
'use strict';
// TIDE r2 STAGE 1 executor wiring tests (MacTide). Plumbing only (playbook §9: "You don't have to test it" - these check the wiring, not the strategy).
// usage: nice -n 19 node tests/tide2-exec.test.cjs [-v]      (run from the bot folder: live-executor.js + lib/ next to tests/)
//   A  config: shipped off; shadow accepted; add / only / sizing.enabled refused in Stage 1; unknown keys; MNQ only; NO daily loss limit keys
//   B  plan by grade (§22): A+ all at once, B half + half (combined <= B dollars, same stop), C one entry, the upgrade add to the A+ dollars, GRADE_NO_FIT,
//      the stop is never moved to fit, the §3 witness sizes (A+ 3 MNQ, C 1 MNQ at the 28,513 stop), ASCII push lines
//   C  shadowStep: journal rows + pushes only, dedupe, the row cap, chatty rows only for setups that signalled
//   D  the executor text: the shadow block has NO order path; every TIDE call is behind tideOn() or is the startup check / line; M30 is a TIDE-only
//      bias read (not a trigger timeframe); the CONFIG default is off
//   E  the 11/04 witness day through the real engine (lib/structure.js) and this wiring, the bias going THROUGH the bias book the executor uses (noteBias /
//      biasAt): a SHORT shadow signal off the 4H Open trap with the stop above 28,511, journaled and pushed (playbook §3); A+ TP2 = the next MAJOR pool
//      beyond 2R (PDL 28,035.25)
//   G  live-shaped timing: each reading is taken 3-10 s AFTER a 1m close (the executor evaluates after the close), so a close only ever gets an earlier
//      reading (observedAt = when it was read); the 11/04 A+ push still fires; a reading from after the close is never used (causality)
//   V  the virtual trade (shadow): exits from money (stop / TP1 -> BE / TP2 / ladder / 13:05 flatten) told to the engine; missing volume = null; the session close
//   F  sizing mode (grade | flat, config only), the bias book's shape (what structure.js normBias reads), day pools, late catch-up signals, grade evidence
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const W = require(path.join(ROOT, 'lib/tideWire.js')), M = require(path.join(ROOT, 'lib/moneyRule.js'));
const VERBOSE = process.argv.includes('-v');
let pass = 0, fail = 0, pend = 0; const fails = [], pends = [];
function ok(cond, name, extra) { if (cond) { pass++; if (VERBOSE) console.log('  ok  ' + name); } else { fail++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); } }
// pending(): an expectation that waits for a library the team is still changing (printed, counted, not a failure)
function pending(cond, name, extra) { if (cond) { pass++; if (VERBOSE) console.log('  ok  ' + name); } else { pend++; pends.push(name); console.log('  PENDING ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } }
const clone = o => JSON.parse(JSON.stringify(o));
const S1M = () => { const d = W.moneyDefaults(); d.sizing.flatDollars = 450; d.sizing.noFit = 'skip'; d.sizing.nearFloor = { enabled: false, cushionUsd: 2000, dollars: 300 }; delete d.sizing.take1MaxUsd; return d; };   // [2a] the Stage-1 money these tests were written for
const CFG = (tide = {}, money = {}) => ({ tide: { ...W.DEFAULTS.tide, ...tide }, money: { ...S1M(), ...money }, controlGateMin: 0.15 });
const SZ = (o = {}) => ({ sizing: { ...S1M().sizing, ...o } });
const CTX = { symbol: 'MNQ', pointValue: 2, minContracts: 1 };
const ASCII = /^[\x20-\x7E]+$/;
const code = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '')).join('\n');   // the text without // comments

console.log('A config');
ok(W.configProblem(CFG(), CTX) === null, 'A1 shipped defaults (off) load');
ok(W.configProblem(CFG({ mode: 'shadow' }), CTX) === null, 'A2 shadow loads');
ok(/Stage-1 build/.test(W.configProblem(CFG({ mode: 'add' }), CTX) || ''), 'A3 add refused in Stage 1');
ok(/Stage-1 build/.test(W.configProblem(CFG({ mode: 'only' }), CTX) || ''), 'A4 only refused in Stage 1');
ok(/unknown setting "tide.dayLimit"/.test(W.configProblem({ ...CFG(), tide: { ...CFG().tide, dayLimit: 2 } }, CTX) || ''), 'A5 unknown tide key refused');
ok(/useTimeBlocks/.test(W.configProblem(CFG({ useTimeBlocks: 'yes' }), CTX) || ''), 'A6 tide.useTimeBlocks must be boolean');
ok(/sizing.enabled must stay false/.test(W.configProblem(CFG({}, SZ({ enabled: true })), CTX) || ''), 'A7 money.sizing.enabled true refused in Stage 1');
{ const c = CFG(); c.money.sizing.dayFullStops = 2; ok(/money:/.test(W.configProblem(c, CTX) || ''), 'A8 a day-limit key in money is refused (NO daily loss limit, §17)'); }
{ const c = CFG(); c.money.dailyLossLimitUsd = 1000; ok(/money:/.test(W.configProblem(c, CTX) || ''), 'A9 a daily-loss key is refused'); }
ok(/MNQ only/.test(W.configProblem(CFG({ mode: 'shadow' }), { ...CTX, symbol: 'MGC' }) || ''), 'A10 shadow on a non-MNQ bot refused');
ok(W.configProblem(CFG(), { ...CTX, symbol: 'MGC' }) === null, 'A11 off on any symbol loads (identity)');
ok(W.modeOf(CFG({ mode: 'add' })) === 'off' && W.modeOf({}) === 'off' && W.modeOf(CFG({ mode: 'shadow' })) === 'shadow', 'A12 modeOf: anything but a Stage-1 mode reads off');
{ const l = W.startupLines(CFG()); ok(/^\[tide\] new model tide-wire-r2\.\d+(-live)? \(stage 1\): off \(/.test(l[0]) && l[1] === '[sizing] off' && /^\[money\] config money-r4\.1: mode flat; flatDollars 450; noFit skip; nearFloor off;.* sizing\.enabled false;$/.test(l[2]), 'A13 off startup lines (+ the [money] config line set-tide-money.sh checks)', l); }
{ const l = W.startupLines(CFG({ mode: 'shadow' })); ok(/\): SHADOW \(/.test(l[0]) && /NO order is ever sent/.test(l[0]) && /NO daily loss limit/.test(l[0]) && /A\+ \$900 \/ B \$600 \/ C \$300/.test(l[0]), 'A14 shadow startup line', l[0]); }
ok(!/day.?limit|daily/i.test(Object.keys(W.DEFAULTS.tide).join(',')), 'A15 no day-limit key exists in tide');
ok(W.DEFAULTS.tide.useTimeBlocks === true && W.DEFAULTS.tide.openWaitMin === 30, 'A16 Mac 11/04 07:30Z: the bot\'s own time blocks ON for TIDE entries, its own open wait 30 min');
{ const g = W.tideGate({ flat: true, useTimeBlocks: W.DEFAULTS.tide.useTimeBlocks, timeBlock: 'Asia blackout', mode: 'add' }); ok(!g.ok && g.code === 'TIME_BLOCK', 'A16b [2a] a signal inside a block (e.g. 16:08 PT, Asia) is TIME_BLOCK: journaled, not taken', g); }
ok(/openWaitMin/.test(W.configProblem(CFG({ openWaitMin: 200 }), CTX) || '') && /openWaitMin/.test(W.configProblem(CFG({ openWaitMin: 'x' }), CTX) || ''), 'A17 tide.openWaitMin validated 0-120');
{ const at = s => W.openWait(Date.parse(s), 30);
  ok(/Asia open/.test(at('2026-11-03T23:10:00Z')) && at('2026-11-03T23:40:00Z') === null && /London open/.test(at('2026-11-04T08:10:00Z')) && /NY open/.test(at('2026-11-04T14:40:00Z')) && /4H open/.test(at('2026-11-04T15:05:00Z')) && at('2026-11-04T16:00:00Z') === null && W.openWait(Date.parse('2026-11-03T23:10:00Z'), 0) === null,
    'A18 open wait: 30 min after 15:00 / 00:00 / 06:30 PT and each 4H open (PST)'); }
{ const g = x => W.tideGate({ mode: 'add', flat: true, ...x }).code;
  ok(g({}) === 'OK' && g({ openWait: 'NY open + 3 min' }) === 'OPEN_WAIT' && g({ timeBlock: 'Asia block' }) === 'OK' && g({ timeBlock: 'Asia block', useTimeBlocks: true }) === 'TIME_BLOCK' && g({ newsWait: 'CPI' }) === 'NEWS_WAIT' && g({ sessionNoEntry: true }) === 'SESSION_CLOSE' && g({ flat: false }) === 'NOT_FLAT' && W.tideGate({ mode: 'shadow' }).code === 'TIDE_SHADOW',
    'A19 kept gates: news wait, session close, flat, TIDE open wait; the old time blocks only with useTimeBlocks true'); }

console.log('B plan by grade (§22, mode grade + entryByGrade + upgradeAdd on) and the money rule (§17)');
const C1 = CFG({ mode: 'shadow' }, SZ({ mode: 'grade', entryByGrade: true, upgradeAdd: { enabled: true } })), CF = CFG({ mode: 'shadow' });   // C1 = the §22 grade styles, CF = the shipped flat
const sig = (o = {}) => ({ id: 'X-T', setupId: 'X', leg: 'trigger', dir: -1, kind: 'trap', levelName: '4H Open', entry: 28366.75, stop: 28513, stopTf: '4H', grade: 'A+', gradePoints: 4,
  pools: [{ price: 28306, name: '1H swing low', major: false }, { price: 28035.25, name: 'PDL', major: true }, { price: 27732, name: '4H swing low', major: true }], internalPools: [{ price: 28306, name: '1H swing low', major: false }], ...o });
{ const p = W.plan(sig(), C1); ok(p.ok && p.qty === 3 && p.total === 3 && p.stop === 28513 && p.stopPts === 146.25 && p.budgetUsd === 900, 'B1 §3 witness A+: 3 MNQ at the 28,513 stop ($900 / 292.50)', p);
  ok(p.ok && p.legNote === 'all at once' && p.first === 3 && p.second === 0, 'B2 A+ all at once (no entry scale-in)', p.legNote);
  ok(p.ok && p.riskUsd <= 900 && p.exits.tp.price <= 28366.75 - 2 * 146.25 && p.exits.tp.price === 28035.25, 'B3 TP2: the A+ major pool beyond 2R', p.exits && p.exits.tp);
  const line = W.pushLine(sig(), p); ok(ASCII.test(line) && line.startsWith('TIDE SHADOW SHORT A+ (4) grade A+ 900: 3 MNQ | flat 450: 1 MNQ @28366.75 stop 28513 TP1 28306 TP2 28035.25 | '), 'B4 push line: ASCII, Mac\'s format + the shadow size', line);
  const s2 = sig({ pointDetail: { trap: 1, force: 1, volume: 1, timing: 1, impulse: 0 } }), p2 = W.plan(s2, C1), l2 = W.pushLine(s2, p2, 'OPEN_WAIT');
  ok(l2.startsWith('TIDE SHADOW SHORT A+ (4: trap force volume timing) grade A+ 900: 3 MNQ | flat 450: 1 MNQ @28366.75 stop 28513 TP1 ') && / \| Stage 2 would wait: OPEN_WAIT$/.test(l2), 'B4b push shows the grade + its points (Mac 11/04) and a gate that would wait', l2);
  const l3 = W.pushLine({ ...s2, grade: 'C' }, W.plan({ ...s2, grade: 'C', gradePoints: 4, capTag: 'exhaustion-watch' }, C1)); ok(/\[exhaustion-watch\]/.test(l3), 'B4c the wave-peak cap tag is shown', l3); }
{ const p = W.plan(sig({ grade: 'C', gradePoints: 2 }), C1); ok(p.ok && p.qty === 1 && p.legNote === 'C one entry', 'B5 §3 witness at C ($300): 1 MNQ, one entry', p); }
{ const p = W.plan(sig({ grade: 'B', gradePoints: 3, stop: 28440 }), C1);   // 73.25 pts -> B $600 / 146.50 = 4 -> 2 now + 2 resting at the retest
  ok(p.ok && p.planned === 4 && p.qty === 2 && p.first === 2 && p.second === 2 && p.reservedQty === 2 && /B half now, \+2 resting/.test(p.legNote), 'B6 B: half now (rounded up), the rest RESERVED at the retest', p);
  const prior = { grade: 'B', stop: 28440, legs: [{ price: 28366.75, contracts: 2 }], second: 2, secondPx: 28380 };
  const q = W.plan(sig({ id: 'X-R', leg: 'retest', grade: 'B', gradePoints: 3, stop: 28440, entry: 28380 }), C1, 2, 0.25, prior);
  ok(q.ok && q.qty === 2 && q.total === 4 && q.stop === 28440 && q.totalRiskUsd <= 600, 'B7 B second half: same stop, combined risk <= $600', q);
  const q2 = W.plan(sig({ id: 'X-R', leg: 'retest', grade: 'B', gradePoints: 3, stop: 28440, entry: 28420 }), C1, 2, 0.25, prior);
  ok(q2.ok && q2.qty <= 2 && q2.totalRiskUsd <= 600, 'B8 B second half sized down to keep the combined risk <= $600', q2);
  const q3 = W.plan(sig({ id: 'X-R', leg: 'retest', grade: 'B', gradePoints: 3, stop: 28470 }), C1, 2, 0.25, prior); ok(q3.ok && q3.stop === 28440, 'B9 a later leg keeps the FIRST leg\'s stop (never moved)', q3);
  const q4 = W.plan(sig({ id: 'X-R', leg: 'retest', grade: 'B', gradePoints: 3, stop: 28440, entry: 28380 }), C1, 2, 0.25, { ...prior, stop: undefined }); ok(!q4.ok, 'B9b no structural stop known = no second half (money-r4 fails closed)', q4); }
{ const life = { tp1Done: false, tp1Px: 28306, bestPx: 28360, upgraded: false, second: 0 };
  const prior = { grade: 'C', points: 2, stop: 28513, legs: [{ price: 28366.75, contracts: 1 }], ...life };   // C 1 lot = $292.50; upgrade at 28380 (133 pts = $266 / lot): (900 - 292.5) / 266 = 2
  const u = W.plan(sig({ id: 'X-U', leg: 'upgrade-add', grade: 'A+', entry: 28380 }), C1, 2, 0.25, prior);
  ok(u.ok && u.qty === 2 && u.total === 3 && u.stop === 28513 && u.totalRiskUsd <= 900 && u.grade === 'A+' && u.fromGrade === 'C' && u.upgrade && u.upgrade.code === 'GRADE_UPGRADE', 'B10 grade-upgrade add: top up to the A+ dollars at the same stop', u);
  const n = W.plan(sig({ id: 'X-U', leg: 'upgrade-add', grade: 'A+', entry: 28380 }), C1, 2, 0.25, null); ok(!n.ok && n.code === 'GRADE_UPGRADE_SKIP' && /nothing to top up/.test(n.legNote), 'B11 upgrade with no open leg = nothing to top up', n);
  const shadowMem = W.plan(sig({ id: 'X-U', leg: 'upgrade-add', grade: 'A+', entry: 28380 }), C1, 2, 0.25, { grade: 'C', points: 2, stop: 28513, legs: [{ price: 28366.75, contracts: 1 }] });
  ok(!shadowMem.ok && /unknown-state/.test(shadowMem.legNote), 'B11b the shadow knows no fills (tp1Done / tp1Px / bestPx unknown): money-r4 refuses the upgrade (fail closed)', shadowMem.legNote);
  const rv = W.plan(sig({ id: 'X-U', leg: 'upgrade-add', grade: 'A+', entry: 28380 }), C1, 2, 0.25, { ...prior, grade: 'B', points: 3, stop: 28440, legs: [{ price: 28366.75, contracts: 2 }], second: 2, secondPx: 28390 });
  ok(rv.ok ? rv.reservedQty === 2 && rv.upgrade.totalRiskUsd <= 900 : /UPGRADE skipped/.test(rv.legNote), 'B11c a resting B half stays RESERVED in the upgrade (counted as filled: total <= $900 in every outcome)', rv);
  const uf = W.plan(sig({ id: 'X-U', leg: 'upgrade-add', grade: 'A+', entry: 28380 }), CFG({ mode: 'shadow' }, SZ({ upgradeAdd: { enabled: true } })), 2, 0.25, prior); ok(!uf.ok && /flat-mode/.test(uf.legNote), 'B11d flat mode: no upgrade add', uf.legNote); }
{ const prior = { grade: 'A+', stop: 28513, legs: [{ price: 28366.75, contracts: 3 }] };
  const r = W.plan(sig({ id: 'X-R', leg: 'retest' }), C1, 2, 0.25, prior); ok(!r.ok && r.code === 'LEG_NO_ROOM' && W.pushLine(sig(), r).includes('no trade'), 'B12 A+ / C never add on a retest', r); }
{ const p = W.plan(sig({ stop: 28366.75 + 451 }), C1); ok(!p.ok && p.code === 'GRADE_NO_FIT' && p.stop === 28366.75 + 451, 'B13 GRADE_NO_FIT: the stop is NOT moved to fit (451 pts > $900 at 1 MNQ)', p);
  ok(ASCII.test(W.pushLine(sig(), p)) && /no trade \(GRADE_NO_FIT\)/.test(W.pushLine(sig(), p)), 'B14 GRADE_NO_FIT push line', W.pushLine(sig(), p)); }
{ const p = W.plan(sig({ stop: 28366.75 + 450 }), C1); ok(p.ok && p.qty === 1, 'B15 450 pts at A+ = exactly 1 MNQ', p); }
{ const p = W.plan(sig({ stop: 28366.75 + 10 }), C1); ok(p.ok && p.qty === 30, 'B16 a 10 pt stop at A+ caps at maxContracts 30', p && p.qty); }
{ const p = W.plan(sig({ stop: 28300 }), C1); ok(!p.ok && p.code === 'TIDE_NO_STOP', 'B17 a stop on the wrong side = no trade', p); }
{ const p = W.plan(sig({ grade: 'D' }), C1); ok(!p.ok && p.code === 'GRADE_NONE', 'B18 below C = no trade', p); }
{ const p = W.plan(sig({ dir: 1, entry: 28000, stop: 27900, kind: 'accepted-break', levelName: 'PDL', pools: [{ price: 28250, major: true, name: 'PDH' }], internalPools: [] }), C1);
  ok(p.ok && p.qty === 4 && p.exits.tp.price >= 28200 && /^TIDE SHADOW LONG A\+/.test(W.pushLine(sig({ dir: 1, entry: 28000 }), p)), 'B19 long mirror: 100 pts at A+ = 4 MNQ, TP2 >= 2R', p); }
{ const p = W.plan(sig({ stopTf: 'H', levelName: 'London High', kind: 'accepted-break' }), C1); ok(p.ok && p.stopTf === '1H', 'B20 hour-type stop labelled 1H (option C, the engine names the wick)', p.stopTf); }

console.log('F sizing (money-r4 owns it), bias book, day pools, late signals, grade evidence');
{ const d = S1M().sizing;
  ok(d.mode === 'flat' && d.flatDollars === 450 && d.entryByGrade === false && d.upgradeAdd.enabled === false && d.noFit === 'skip' && W.configProblem(CFG(), CTX) === null, 'F1 shipped sizing written out: mode flat $450 (placeholder), every grade all at once, upgrade add off, no fit = skip; loads', d);
  ok(/mode/.test(W.configProblem(CFG({}, SZ({ mode: 'kelly' })), CTX) || ''), 'F2 a bad sizing.mode is refused (moneyRule.problem)');
  ok(/flatDollars/.test(W.configProblem(CFG({}, SZ({ flatDollars: 5000 })), CTX) || ''), 'F3 flatDollars validated 50-2000');
  ok(/gradeRiskUsd/.test(W.configProblem(CFG({}, SZ({ gradeRiskUsd: { A: 300, B: 600, C: 900 } })), CTX) || ''), 'F4 grade dollars validated in either mode');
  const mc = W.moneyCfg(CF, 2, 0.25); ok(mc.sizing === CF.money.sizing && mc.pointValue === 2 && mc.tickSize === 0.25, 'F5 the wiring hands money-r4 the config unchanged (+ pointValue / tickSize only)');
  const pf = W.plan(sig(), CF);   // 146.25 pts: flat $450 -> 1 MNQ; grade A+ $900 -> 3 MNQ
  ok(pf.ok && pf.mode === 'flat' && pf.qty === 1 && pf.budgetUsd === 450 && pf.legNote === 'all at once' && pf.shadow && pf.shadow.line === 'flat 450: 1 MNQ | grade A+ 900: 3 MNQ' && pf.shadow.logOnly === true, 'F6 flat plans the leg; moneyRule.shadowSize logs the grade size beside it', pf);
  const s4 = sig({ pointDetail: { trap: 1, force: 1, volume: 1, timing: 1, impulse: 0 } }), lf = W.pushLine(s4, W.plan(s4, CF));
  ok(ASCII.test(lf) && lf.startsWith('TIDE SHADOW SHORT A+ (4: trap force volume timing) flat 450: 1 MNQ | grade A+ 900: 3 MNQ @28366.75 stop 28513 TP1 28306 TP2 28035.25 | all at once, 1 lot: BE at TP1, no partial | '), 'F7 push: grade + points, the flat size and the would-be grade size (values from the money config)', lf);
  const lg = W.pushLine(sig(), W.plan(sig(), CFG({ mode: 'shadow' }, SZ({ mode: 'grade', flatDollars: 600 })))); ok(/^TIDE SHADOW SHORT A\+ \(4\) grade A\+ 900: 3 MNQ \| flat 600: 2 MNQ @/.test(lg), 'F8 grade mode first, the flat size beside it', lg);
  const fb = W.plan(sig({ grade: 'B', gradePoints: 3, stop: 28440 }), CF); ok(fb.ok && fb.second === 0 && fb.qty === 3 && /grade B 600: 4 MNQ/.test(fb.shadow.line), 'F9 flat: a B is ONE entry of the flat size; the grade size is logged', fb);
  const nf = W.plan(sig({ stop: 28366.75 + 300 }), CF); ok(!nf.ok && nf.code === 'GRADE_NO_FIT' && nf.shadow && /grade A\+ 900: 1 MNQ/.test(nf.shadow.line) && W.pushLine(sig(), nf).includes('| flat 450: 0 MNQ (GRADE_NO_FIT) | grade A+ 900: 1 MNQ |'), 'F10 300 pts: flat $450 does not fit 1 MNQ ($600) = skip; the grade A+ $900 size is logged', W.pushLine(sig(), nf));
  const t1 = W.plan(sig({ stop: 28366.75 + 300 }), CFG({ mode: 'shadow' }, SZ({ noFit: 'take1', take1MaxUsd: 700 }))); ok(t1.ok && t1.qty === 1 && /take1/.test(t1.legNote), 'F11 noFit take1: 1 MNQ, the dollars over budget noted (300 pts = $600 <= a $700 ceiling)', t1.legNote);
  const t1c = W.plan(sig({ stop: 28366.75 + 300 }), CFG({ mode: 'shadow' }, SZ({ noFit: 'take1' }))); ok(!t1c.ok && t1c.code === 'GRADE_NO_FIT_CEILING' && t1c.oneLotUsd === 600, 'F11c [2a] take1 over the ceiling (300 pts = $600 > $400): GRADE_NO_FIT_CEILING, not taken', t1c); }
{ const book = W.createBiasBook(); W.noteBias(book, 1000000, -0.21, -0.18); W.noteBias(book, 1020000, -0.25, null); W.noteBias(book, 1030000, null, null);
  const r = W.biasAt(book, 1025); ok(r && r.m15 && r.m15.score === -0.25 && r.m15.valid === true && r.m15.observedAt === 1020 && r.m30 === null && !('s15' in r), 'F13 biasAt: { m15: {score, valid, observedAt}, m30 } objects (structure.js normBias shape), the latest reading at or before the close', r);
  ok(W.biasAt(book, 1015).m15.score === -0.21 && W.biasAt(book, 999) === null && W.biasAt(book, 1020 + 121) === null && W.biasAt(book, 1020 + 120) !== null, 'F14 nothing from after the close; nothing older than 120 s');
  ok(W.lastBiasAt(book) === 1020000 && W.lastBiasAt(W.createBiasBook()) === -Infinity, 'F15 lastBiasAt: when the newest reading was taken'); }
{ const tg = [{ price: 28104.25, name: 'London Low', major: true }];
  const dp = W.dayPools({ PDH: 28449.75, PDL: 28035.25 }, -1, 28366.75, tg); ok(dp.length === 1 && dp[0].name === 'PDL' && dp[0].major === true, 'F16 day pools: the board PDL joins a short\'s pools when missing (PDH is behind the entry)', dp);
  ok(W.dayPools({ PDH: 28449.75, PDL: 28035.25 }, -1, 28366.75, [...tg, { price: 28035.25, name: 'PDL + 4H swing low', major: true }]).length === 0, 'F17 not added twice'); }
{ const sh = { engine: { step: () => ({ rows: [], signals: [{ ...sig(), id: 'L1', at: 1000 }] }) }, seen: new Set() };
  const o = W.shadowStep(sh, { nowMs: 1000 + W.LATE_MS + 1 }, C1, { flat: true }); ok(o.pushes.length === 0 && o.rows.some(r => r.phase === 'signal' && r.late === true && r.push === null), 'F18 a catch-up (late) signal is journaled, not pushed', o.rows); }
{ const p = W.plan(sig({ gradePoints: null }), C1); ok(!p.ok && p.code === 'GRADE_NONE', 'F19 a grade without its points (missing evidence) = no trade; the wiring never grades (MacDot money-r3 review d)', p);
  const src = code(fs.readFileSync(path.join(ROOT, 'lib/tideWire.js'), 'utf8')); ok(!/gradeOf\(/.test(src), 'F20 lib/tideWire.js never calls moneyRule.gradeOf');
  ok(M.gradeOf({ control4h: true, trapAtPool: true, displacementShift: true, firstRetest: true }).grade === null, 'F21 money-r4 gradeOf always fails closed (the grade is the structure engine\'s)'); }
{ const NF = CFG({ mode: 'shadow' }, SZ({ nearFloor: { enabled: true, cushionUsd: 2000, dollars: 300 } }));   // 146.25 pts: $300 -> 1 MNQ; 74 pts: $450 -> 3, $300 -> 2
  const near = W.plan(sig({ stop: 28366.75 + 74 }), NF, 2, 0.25, null, 1500), far = W.plan(sig({ stop: 28366.75 + 74 }), NF, 2, 0.25, null, 5000), unk = W.plan(sig({ stop: 28366.75 + 74 }), NF, 2, 0.25, null, null);
  ok(near.ok && near.qty === 2 && near.nearFloor && near.nearFloor.active === true && far.ok && far.qty === 3 && far.nearFloor.active === false && unk.ok && unk.qty === 2 && unk.nearFloor.reason === 'distance-unknown',
    'F22 money-r4.1 near-floor guard (when enabled): floor distance $1,500 < cushion caps the dollars at $300; $5,000 does not; unknown fails safe (capped)', [near.qty, far.qty, unk.qty]);
  ok(/near-floor/.test(W.pushLine(sig(), near)), 'F23 the push names the near-floor cap', W.pushLine(sig(), near));
  const off = W.plan(sig({ stop: 28366.75 + 74 }), CF, 2, 0.25, null, 100); ok(off.ok && off.qty === 3 && off.nearFloor === null, 'F24 guard off (shipped): the floor distance changes nothing'); }
{ const JM = require(path.join(ROOT, 'lib/journalMeta.js')), cfg = { ...CFG({ mode: 'shadow' }), minMacScore: 6 };
  const pr = JM.projectSettings(cfg); ok(pr.settings.tide && pr.settings.tide.mode === 'shadow' && pr.settings.money && pr.settings.money.sizing.mode === 'flat' && !pr.unlistedKeys.includes('tide') && !pr.unlistedKeys.includes('money'), 'F25 the session stamp records tide / money by value (lib/journalMeta.js TRADING_SETTINGS)', pr.unlistedKeys); }

console.log('G live-shaped timing and causality');
{ const fxFile = path.join(__dirname, 'fixtures/witness-1104.json');
  if (fs.existsSync(fxFile)) {
    const fx = JSON.parse(fs.readFileSync(fxFile, 'utf8')), S = require(path.join(ROOT, 'lib/structure.js')), NAMES = ['4H Open', '1H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low'];
    for (const lagS of [3, 7, 10]) {
      const sh = { engine: W.createAdapter(S, {}), seen: new Set() }, book = W.createBiasBook(); let board = []; const got = []; let used = 0, future = 0;
      for (const r of fx.m1) {
        const T = r[0] + 60, rd = fx.readings[String(T)];
        // the poll at T + lag: the shadow steps the bar that closed at T with the book as it stands (readings noted at EARLIER polls), then the evaluation notes its own
        const b = W.biasAt(book, T); if (b) { used++; for (const x of [b.m15, b.m30]) if (x && x.observedAt > T) future++; }
        const o = W.shadowStep(sh, { nowMs: (T + lagS) * 1000, m1New: [{ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }], warm: false, board, biasAt: t => W.biasAt(book, t) }, CF, { flat: true });
        for (const x of o.rows) if (x.phase === 'signal' && x.push) got.push(x);
        if (rd) { W.noteBias(book, (T + lagS) * 1000, rd[0], rd[1]); board = NAMES.map((n, i) => ({ name: n, price: rd[2 + i] })).filter(x => Number.isFinite(x.price)); }
      }
      const ap = got.find(x => x.t >= Date.parse('2026-11-03T23:35:00Z') && x.t <= Date.parse('2026-11-04T00:25:00Z') && x.dir === -1 && x.plan && x.plan.grade === 'A+');
      ok(ap && ap.plan.stop === 28513 && ap.plan.tp2.price === 28035.25 && /^TIDE SHADOW SHORT A\+ \(4/.test(ap.push), `G1.${lagS} readings ${lagS} s after each close: the 11/04 A+ short is still pushed (stop 28,513, TP2 PDL 28,035.25)`, got.map(x => x.push && x.push.slice(0, 90)));
      ok(used > 1000 && future === 0, `G2.${lagS} every close got an earlier reading (${used} closes), none observed after its close`, { used, future });
    }
    { const book = W.createBiasBook(), T = 1793750460; W.noteBias(book, (T + 2) * 1000, -0.9, -0.9);
      ok(W.biasAt(book, T) === null, 'G3 a reading taken 2 s after the close is NOT given to that close (causality)');
      let st = S.createState(); const o = S.step(st, { m1: { t: T - 60, o: 1, h: 1, l: 1, c: 1, v: 1 }, bias: { m15: { score: -0.9, valid: true, observedAt: T + 2 }, m30: null }, levels: null });
      ok(!JSON.stringify(o.state).includes('-0.9'), 'G4 the engine itself drops a reading observed after the close (normBias: no look-ahead)');
      const o2 = S.step(S.createState(), { m1: { t: T - 60, o: 1, h: 1, l: 1, c: 1, v: 1 }, bias: { m15: { score: -0.9, valid: true, observedAt: T - 121 }, m30: null }, levels: null });
      ok(!JSON.stringify(o2.state).includes('-0.9'), 'G5 ... and one older than 120 s (biasMaxAgeSec)');
      const o3 = S.step(S.createState(), { m1: { t: T - 60, o: 1, h: 1, l: 1, c: 1, v: 1 }, bias: W.biasAt((() => { const b = W.createBiasBook(); W.noteBias(b, (T - 15) * 1000, -0.9, null); return b; })(), T), levels: null });
      ok(JSON.stringify(o3.state).includes('-0.9'), 'G6 a reading taken 15 s before the close (the previous poll) IS used');
      const o4 = S.step(S.createState(), { m1: { t: T - 60, o: 1, h: 1, l: 1, c: 1, v: 1 }, bias: { s15: -0.9, s30: -0.9 }, levels: null }), o5 = S.step(S.createState(), { m1: { t: T - 60, o: 1, h: 1, l: 1, c: 1, v: 1 }, bias: { m15: -0.9, m30: -0.9 }, levels: null });
      ok(!JSON.stringify(o4.state).includes('-0.9') && !JSON.stringify(o5.state).includes('-0.9'), 'G7 the shipped engine (biasInput strict) rejects bare scalars: only the book\'s {score, valid, observedAt} objects are read'); }
  } else ok(false, 'G0 fixture present'); }

console.log('V virtual trades, engine feedback, volume, session clock');
{ // a recording engine: one SHORT signal on bar 0 (entry 100, stop 110, TP1 95, TP2 80), then the bars the test gives
  const mk = () => { const seen = []; let n = 0; const lib = { VERSION: 'rec', createState: () => ({}), step: (st, inp) => { seen.push(inp); const sig = n++ === 0 ? { id: 'S1', setupId: 'U1', dir: -1, kind: 'failed-break', level: { name: '4H Open', price: 101 }, entryPrice: 100, chosenStop: 110, stops: { stopType: '4H' }, grade: 'A+', gradeTotal: 4, t: inp.m1.t, targets: [{ price: 95, name: 'swing', major: false }, { price: 80, name: 'PDL', major: true }] } : null; return { state: st, events: [], signal: sig }; } }; return { seen, sh: { engine: W.createAdapter(lib, {}), seen: new Set() } }; };
  const T0 = Date.parse('2026-11-04T17:00:00Z'), bar = (i, o, h, l, c, v) => ({ t: T0 + i * 60000, o, h, l, c, ...(v === undefined ? {} : { v }) });
  const run = (bars, sessionAt) => { const r = mk(), rows = [], pushes = []; for (const b of bars) { const o = W.shadowStep(r.sh, { nowMs: b.t + 61000, m1New: [b], warm: false, board: [], biasAt: () => null, sessionAt }, C1, { flat: true }); rows.push(...o.rows); pushes.push(...o.pushes); } return { ...r, rows, pushes }; };
  const tp2 = run([bar(0, 100, 100, 100, 100, 5), bar(1, 100, 100, 94, 95), bar(2, 95, 96, 79, 81), bar(3, 81, 82, 80, 81)]);
  const ex = tp2.rows.find(r => r.phase === 'shadow_exit'), fbk = tp2.seen[2] && tp2.seen[2].trades;
  ok(ex && ex.why === 'tp2' && ex.exit === 80 && ex.tp1Done === true && ex.simulated === true, 'V1 the virtual trade ends at TP2 (TP1 traded first: break-even), journaled as a simulated shadow_exit', ex);
  ok(Array.isArray(fbk) && fbk.some(t => t.signalId === 'S1' && t.setupId === 'U1' && t.closed === true) && !tp2.seen[2].stoppedOut, 'V2 ... and the engine is told in the step of that same (closed) bar: closed (so the next same-direction setup is allowed), no stoppedOut', tp2.seen.map(x => x.trades || null));
  ok(tp2.seen[1] && Array.isArray(tp2.seen[1].trades) && tp2.seen[1].trades.some(t => t.tp1Done === true && t.closed === false), 'V3 TP1 traded is told to the engine (tp1Done, before the close)', tp2.seen[1] && tp2.seen[1].trades);
  const st = run([bar(0, 100, 100, 100, 100), bar(1, 100, 111, 99, 108), bar(2, 108, 109, 107, 108)]);
  ok(st.rows.some(r => r.phase === 'shadow_exit' && r.why === 'stop' && r.exit === 110 && r.resultR === -1) && st.seen[1] && st.seen[1].stoppedOut && st.seen[1].stoppedOut.dir === -1, 'V4 a full structural stop: closed at the stop (-1R) and stoppedOut { dir } (C.4: a new trigger needs a new shift)', st.rows.filter(r => r.phase === 'shadow_exit'));
  const be = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 94, 96), bar(2, 96, 100.5, 96, 100)]);
  ok(be.rows.some(r => r.phase === 'shadow_exit' && r.why === 'be-stop' && r.exit === 99.75) && be.seen[2] && !be.seen[2].stoppedOut, 'V5 after TP1 the stop is break-even + 1 tick: a pullback closes there, no stoppedOut', be.rows.filter(r => r.phase === 'shadow_exit'));
  const vol = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 99, 99, 0)]);
  ok(vol.seen[0].m1.v === 5 || vol.seen[0].m1.v === null, 'V6a (fixture) ok'); ok(run([bar(0, 100, 100, 100, 100)]).seen[0].m1.v === null && vol.seen[1].m1.v === 0, 'V6 a bar with NO volume reaches the engine as null (r3.2 withholds the volume point); an observed 0 stays 0', [vol.seen[0].m1.v, vol.seen[1].m1.v]);
  const Sx = require(path.join(ROOT, 'lib/structure.js')), nb = Sx.step(Sx.createState(), { m1: { t: 1793750400, o: 1, h: 1, l: 1, c: 1, v: null }, bias: null, levels: null });
  ok(nb.state.m1 && nb.state.m1.at(-1) && nb.state.m1.at(-1).vk === false, 'V7 ... and the engine marks it volume-unknown (vk false)', nb.state.m1 && nb.state.m1.at(-1));
  const sess = t => { const m = W.ptMinute(t); return { noEntry: m >= 775 && m < 900, flattenDue: m >= 785 && m < 900 }; };   // 12:55 no entry, 13:05 flatten (PST)
  const T1 = Date.parse('2026-11-04T20:58:00Z'), b2 = (i, o, h, l, c) => ({ t: T1 + i * 60000, o, h, l, c, v: 1 });   // 12:58 PT
  const sc = run([b2(0, 100, 100, 100, 100), b2(1, 100, 101, 99, 100)], sess); const srow = sc.rows.find(r => r.phase === 'signal');
  ok(srow && srow.gatesNow === 'SESSION_CLOSE' && srow.push === null && srow.taken === false && srow.tradeable === false && sc.pushes.length === 0 && sc.seen[1].trades && sc.seen[1].trades[0].closed === true, 'V8 a signal inside the session close (12:58 PT): journaled SESSION_CLOSE, silent, not taken, the engine told closed', srow);
  const T2 = Date.parse('2026-11-04T20:50:00Z'), b3 = (i, o, h, l, c) => ({ t: T2 + i * 60000, o, h, l, c, v: 1 });   // 12:50 PT: taken; open at 13:05
  const fl = run(Array.from({ length: 18 }, (_, i) => b3(i, 100, 100.5, 99.5, 100)), sess); const fx = fl.rows.find(r => r.phase === 'shadow_exit');
  ok(fx && fx.why === 'session-flatten' && new Date(fx.t).toISOString() === '2026-11-04T21:05:00.000Z', 'V9 a virtual trade still open at 13:05 PT closes at the session flatten', fx);
  const two = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 99, 99)]); two.sh.engine = { step: () => ({ rows: [], signals: [{ ...sig(), id: 'S2', setupId: 'U2', entry: 99, stop: 110 }] }) };
  const o2 = W.shadowStep(two.sh, { nowMs: T0 + 3 * 60000, m1New: [], board: [] }, C1, { flat: true }); const r2row = o2.rows.find(r => r.phase === 'signal');
  ok(r2row && r2row.gatesNow === 'TIDE_OPEN' && r2row.taken === false, 'V10 one TIDE position at a time: a new setup while the virtual trade is open is not taken (TIDE_OPEN)', r2row && [r2row.gatesNow, r2row.taken]); }
{ const src = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8'); ok(/sessionAt: t => sessionCloseState\(t, CONFIG\)/.test(src), 'V11 the executor hands the shadow its own session clock (sessionCloseState)'); }

console.log('C shadowStep (journal + phone only)');
{ let calls = 0; const rowsOut = [{ event: 'FAIL', phase: 'fail', t: 1, zone: '4H Open' }, { event: 'GRADE_LIVE', phase: 'grade_live', t: 1, setup: 'S1' }, { event: 'GRADE_LIVE', phase: 'grade_live', t: 1, setup: 'X' }];
  const eng = { step: () => { calls++; return { rows: rowsOut, signals: [sig()] }; } }, sh = { engine: eng, seen: new Set() };
  const o1 = W.shadowStep(sh, { nowMs: 1000 }, C1, { flat: true }); const o2 = W.shadowStep(sh, { nowMs: 2000 }, C1, { flat: true });
  ok(o1.pushes.length === 1 && o2.pushes.length === 0, 'C1 one push per signal id (dedupe)', [o1.pushes, o2.pushes]);
  const sigRow = o1.rows.find(r => r.phase === 'signal');
  ok(sigRow && sigRow.type === 'lv_tide' && sigRow.shadow === true && sigRow.order === 'none (shadow)' && sigRow.plan.qty === 3 && sigRow.plan.tp2 && sigRow.plan.pyramid, 'C2 the signal row carries the plan (grade, size, stop, TP1, TP2, adds)', sigRow);
  ok(o1.rows.every(r => r.type === 'lv_tide'), 'C3 every row is lv_tide');
  ok(!o1.rows.some(r => r.event === 'GRADE_LIVE' && r.setup === 'S1'), 'C4 GRADE_LIVE kept only for setups that signalled');
  ok([...o1.rows, ...o2.rows].filter(r => r.event === 'GRADE_LIVE' && r.setup === 'X').length === 1, 'C5 GRADE_LIVE of a signalled setup is journaled (once)');
  ok(sh.setups.get('X') && sh.setups.get('X').legs.length === 1, 'C6 the shadow remembers the legs it would hold'); }
{ const many = Array.from({ length: 100 }, (_, i) => ({ event: 'BREAK', phase: 'break', t: i, zone: 'Z' + i })); const sh = { engine: { step: () => ({ rows: many, signals: [] }) }, seen: new Set() };
  const o = W.shadowStep(sh, { nowMs: 1 }, C1, {}); ok(o.rows.length === W.ROWS_PER_STEP + 1 && o.rows.at(-1).phase === 'rows_capped' && o.rows.at(-1).dropped === 100 - W.ROWS_PER_STEP, 'C7 rows per step are capped (+ one rows_capped row)', o.rows.length); }
{ const src = code(fs.readFileSync(path.join(ROOT, 'lib/tideWire.js'), 'utf8'));
  const reqs = [...src.matchAll(/require\(([^)]*)\)/g)].map(m => m[1]);
  ok(reqs.length === 4 && reqs.includes("'./tideOrders'") && reqs.includes("'path'") && reqs.includes("'./moneyRule'") && /structure\.js/.test(reqs.join(' ')), 'C8 lib/tideWire.js requires only path, ./moneyRule, ./structure.js and ([2a] live configProblem) ./tideOrders', reqs);
  ok(!/placeOrder|cancelOrder|takeEntry|openEntry|replaceStop|stateMachine|fetch\(|https|child_process|writeFile|appendFile/.test(src), 'C9 lib/tideWire.js has no order / state machine / I/O path'); }

console.log('D executor text');
const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
{ const a = EX.indexOf('// ── TIDE r2 STAGE 1 SHADOW'), b = EX.indexOf('\n  }\n', EX.indexOf('async function tidePollStep', a)); const blk = a > 0 && b > a ? code(EX.slice(a, b)) : '';
  ok(blk.length > 2000, 'D1 the shadow block is found', blk.length);
  ok(!/placeOrder|cancelOrder|OrderType|OrderSide|takeEntry|openEntry|checkForNewEntry|replaceStopSafely|flatten|journalOrder|lvjOrder|stopCapOldStop/.test(blk), 'D2 the shadow block has NO order path');
  ok(!/stateMachine\.(?!desynced)/.test(blk), 'D3 the shadow block only READS stateMachine.desynced');
  ok(/notifyPhone\('TIDE shadow', line, \{ priority: 'default'/.test(blk) && /notifyPhone\('TIDE live signal', line, \{ priority: 'default'/.test(blk), 'D4 pushes go through notifyPhone at default priority (INFO tier: the INFO budget applies)');
  ok(/lvjWrite\(r\)/.test(blk) && !/appendJournal|journalSignalSnapshot|appendFileSync/.test(blk), 'D5 rows go to the levels journal only (lvjWrite), never the trade journal'); }
{ const lines = EX.split('\n'), a = EX.slice(0, EX.indexOf('// ── TIDE r2 STAGE 1 SHADOW')).split('\n').length, b = EX.slice(0, EX.indexOf('  async function refreshAndEvaluate(')).split('\n').length;
  const uses = lines.map((l, i) => [i + 1, l]).filter(([n, l]) => (n < a || n >= b) && /tideWire\.|tidePollStep\(|tideNoteEval\(|tideLv30|tideM30|tideOwnM30|tideOn\(\)/.test(l) && !/^\s*\/\//.test(l));
  const ALLOWED = [/^  money: tideWire\.moneyDefaults\(\),$/, /^\{ const p = tideWire\.configProblem\(CONFIG, /, /^  for \(const l of tideWire\.startupLines\(CONFIG, pointValue, tickSize\)\) log\(l\);/, /^  try \{ const h16 = f => require\('crypto'\)/,
    /^    let tideLv30 = null;/, /^    if \(tideOn\(\)\) \{ try \{ const b30 = tideWire\.agg30\(/, /^      if \(b30\.length >= 100\) \{ const o30 = evaluateLevelsPro\(b30, \{ \.\.\.htf, M30: b30 \}/, /^    if \(tideOn\(\)\) tideNoteEval\(lvByTf\.M15, tideLv30, htf\);/,
    /^      if \(tideOn\(\)\) tideM1Tail = m1;/, /^      if \(tideOn\(\)\) tideM15Tail = m15probe;/, /^  try \{ if \(tideWire\.modeOf\(CONFIG\) === 'live'\) log\(`\[tide\] mode LIVE: /, /^    cfgFn: \(\) => \{ let fd = null;/, /^    onEnd: \(takeId, res\) => \{ try \{ if \(tideShadow\) tideWire\.liveFeedback/, /^    journal: row => .*take1MaxFn: \(\) => tideWire\.take1Max\(CONFIG\),/, /^    preCheck: async sig => \{ const n = Date\.now\(\);.*tideWire\.blockAt\(CONFIG, n\)/, /^function oldPathSilenced\(title\) \{ return tideWire\.modeOf\(CONFIG\) === .live. && CONFIG\.tide/,
    /^      return \{ v: 1, mode: tideWire\.modeOf\(CONFIG\), version: tideWire\.VERSION, engine: tideShadow/, /^        sizing: \{ mode: sz\.mode \|\| null, flatUsd:.*take1MaxUsd: tideWire\.take1Max\(CONFIG\)/, /^        rules: \{ useTimeBlocks: CONFIG\.tide\.useTimeBlocks === true, blocks: tideWire\.tideBlocks\(CONFIG\)/, /^    \} catch \(e\) \{ return \{ v: 1, mode: tideWire\.modeOf\(CONFIG\), error:/, /^        \.\.\.\(tideOn\(\) \? \{ tide: tideSnapshotView\(\) \} : \{\}\),/,
    /^    if \(tideOn\(\) && !tideBusy\) \{ tideBusy = true; const m1t = tideM1Tail; Promise\.resolve\(\)\.then\(\(\) => tidePollStep\(m1t\)\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ tideBusy = false; \}\); \}/];
  const outside = uses.filter(([, l]) => !ALLOWED.some(re => re.test(l)));
  ok(a > 1 && b > a && uses.length === ALLOWED.length && outside.length === 0, 'D6 outside the shadow block, TIDE appears only at the 11 known call sites + 6 [2a] live-driver lines + 5 [r1.2] snapshot.tide lines (each behind tideOn(), or the pure startup check / line / defaults)', { n: uses.length, outside: outside.map(x => x[0] + ': ' + x[1].trim().slice(0, 90)) });
  const BASE = EX.split('\n');
  ok(/\n    let htf, alignPoll = null;\n/.test(EX) && /const fastTf = await fetchFastTimeframes\(token, contractId, \{ limit: CONFIG\.historyRefreshLimit, extra: CONFIG\.align30 === true \? \[\.\.\.ex18, 'M30'\] : ex18, onRead: alignPoll\.onRead \}\);/.test(EX), 'D7 the bot\'s fetches are r13.3.7\'s lines exactly: TIDE adds no request to a refresh (its 30m bars are built from the 15m bars)');
  { const b15 = []; for (let i = 0; i < 6; i++) b15.push({ t: 1800000 * 1000 + i * 900000, o: 10 + i, h: 20 + i, l: 5 + i, c: 11 + i, v: 1 }); const a30 = W.agg30(b15);
    ok(a30.length === 3 && a30[0].o === 10 && a30[0].h === 21 && a30[0].l === 5 && a30[0].c === 12 && a30[0].v === 2 && a30[2].c === 16, 'D7b agg30: 15m -> 30m (o first, h max, l min, c last, v sum), the forming 15m makes the forming 30m', a30); }
  ok(/if \(tideOn\(\)\) tideM1Tail = m1;/.test(EX) && !/await tidePollStep/.test(EX) && EX.indexOf('tidePollStep(m1t)') > EX.indexOf("runFlagJob();   // 10/17 round 3") && EX.indexOf('tidePollStep(m1t)') < EX.indexOf('    await sleepWithFastPoll(CONFIG.pollIntervalMs);'), 'D7c A1: TIDE runs AFTER the pass (after its last entry decision), never awaited, one at a time (tideBusy)');
  ok(/const m1 = await fetchBars\(token, contractId, UNIT\.MINUTE, 1, \{ limit: 3 \}\);\n      if \(tideOn\(\)\) tideM1Tail = m1;/.test(EX), 'D7d the old path\'s 1m read is unchanged (limit 3)');
  ok(/limit: CONFIG\.historyRefreshLimit/.test(EX) && !/LEVELS_TRIGGER_TFS[^\n]*'M30'/.test(EX.replace(/\/\/[^\n]*/g, '')), 'D8 M30 is NOT a trigger timeframe (LEVELS_TRIGGER_TFS untouched)');
  ok(/tide: \{ mode: 'off', useTimeBlocks: true, openWaitMin: 30, push: true, liveArmed: null, oldPathEntries: false \}/.test(EX), 'D9 CONFIG ships tide.mode off, the old time blocks off for TIDE, open wait 30');
  ok(/money: tideWire\.moneyDefaults\(\)/.test(EX) && W.moneyDefaults().sizing.enabled === false && W.moneyDefaults().sizing.mode === 'flat' && S1M().sizing.flatDollars === 450, 'D10 CONFIG ships money.sizing.enabled false, mode flat (Stage-1 money: 450)');
  { const L = W.moneyDefaults().sizing; ok(L.flatDollars === 400 && L.noFit === 'take1' && L.take1MaxUsd === 400 && L.nearFloor.enabled === false && L.nearFloor.cushionUsd === 1000 && L.nearFloor.dollars === 200 && L.maxContracts === 30 && L.entryByGrade === false && L.enabled === false, 'D10L [2a] LIVE money defaults (Mac 11/04 07:45Z, 50K combine size): flat $400, take1 <= $400, nearFloor OFF ($1,000 -> $200 when on), max 30, entryByGrade false', L); }
  ok(/CONFIG-LOCAL ERROR: the bot will NOT start because of config-local\.json\.\\n\$\{p\}/.test(EX), 'D11 a bad tide / money config stops the bot with CONFIG-LOCAL ERROR');
  const oa = EX.indexOf('  function tideOwnReading('), own = oa > 0 ? code(EX.slice(oa, EX.indexOf('\n  }\n', oa))) : '';
  ok(own.length > 400 && !/fetch|await|onRead|alignPoll|cachedSlowHtf =|lvByTf|entryControlBoard|latestLevelBoard|journalBars|noteCandleRead|candleM30/.test(own) && /mergeTail\(tideHtf\.M15, tideM15Tail\)/.test(own), 'D12 the own bias read uses only bars the bot already read (no request, nothing of the bot\'s written)', own.length);
  ok(/now - tideWire\.lastBiasAt\(tideBook\) < 40000/.test(own) && /tideOwnNextAt = now \+ 40000/.test(own), 'D13 the own read only when the book is 40 s old, at most once per 40 s (a 1m close always gets a reading < 120 s old)');
  const ps = EX.slice(EX.indexOf('  async function tidePollStep('), EX.indexOf('  async function refreshAndEvaluate('));
  ok(/tideOwnReading\(now\);/.test(ps) && ps.indexOf('tideOwnReading(now)') < ps.indexOf('if (!tideShadow) {'), 'D14 the own read is tried on every TIDE step, before any early return');
  ok(/lim = tideM1Last === null \? tideWire\.WARM_CLOCK_MIN :/.test(ps) && W.WARM_CLOCK_MIN === 6000 && W.WARM_KEEP === 2000 && /hist\.slice\(-tideWire\.WARM_KEEP\)/.test(ps) && /\[tide\] warm-up bars=\$\{h\.length\} 1H-range=\$\{inf\.range1hKnown \? 'known' : 'unknown'\}/.test(ps), 'D16 item 4: the first read asks 6000 min of clock (weekend-proof), the engine warms on the last 2000, "[tide] warm-up bars=N 1H-range=known|unknown" is logged');
  ok(/\[tide\] restart: memory rebuilt from warm-up/.test(ps) && /onWarmSetup: id => tideShadow\.preRestart\.add\(id\)/.test(ps), 'D17 4b (fallback): the restart is journaled; setups armed in the warm-up are never pushed / taken');
  ok(/const floorDistanceUsd = soft\(\(\) => \{ const f = computeDrawdownFloor\(\); return Number\.isFinite\(lastAccountBalance\) && Number\.isFinite\(f\) \? lastAccountBalance - f : null; \}\);/.test(EX) && (EX.match(/function computeDrawdownFloor\(/g) || []).length === 1, 'D15 floorDistanceUsd = balance - the bot\'s own trailing floor (computeDrawdownFloor, no second MLL model); unknown = null'); }

console.log('E the 11/04 witness day through the real engine (playbook §3)');
{ const fxFile = path.join(__dirname, 'fixtures/witness-1104.json');
  if (!fs.existsSync(fxFile)) ok(false, 'E0 fixture tests/fixtures/witness-1104.json present');
  else {
    const fx = JSON.parse(fs.readFileSync(fxFile, 'utf8')), S = require(path.join(ROOT, 'lib/structure.js'));
    const sh = { engine: W.createAdapter(S, {}), seen: new Set() }, NAMES = ['4H Open', '1H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low'], book = W.createBiasBook();
    const sigs = [], pushes = [], exits = []; let rows = 0, threw = null;
    const sess = t => { const m = W.ptMinute(t), wd = new Date(t - 8 * 3600e3).getUTCDay(), wk = wd >= 1 && wd <= 5; return { noEntry: wk && m >= 775 && m < 900, flattenDue: wk && m >= 785 && m < 900 }; };   // 12:55 / 13:05 PT (PST), as sessionCloseState
    try {
      for (const r of fx.m1) {
        const T = r[0] + 60, rd = fx.readings[String(T)];
        const board = rd ? NAMES.map((n, i) => ({ name: n, price: rd[2 + i] })).filter(x => Number.isFinite(x.price)) : [];
        if (rd) W.noteBias(book, T * 1000, rd[0], rd[1]);   // the executor's path: tideNoteEval -> noteBias; the adapter asks biasAt(close)
        const o = W.shadowStep(sh, { nowMs: T * 1000, m1New: [{ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }], warm: false, board, biasAt: t => W.biasAt(book, t), sessionAt: sess }, CF, { flat: true });   // the SHIPPED config (flat)
        rows += o.rows.length; for (const x of o.rows) { if (x.phase === 'signal') sigs.push(x); if (x.phase === 'shadow_exit') exits.push(x); } pushes.push(...o.pushes);
      }
    } catch (e) { threw = e.stack; }
    ok(!threw, 'E1 the engine + wiring run the whole witness file without throwing', threw);
    const from = Date.parse('2026-11-03T23:35:00Z'), to = Date.parse('2026-11-04T00:25:00Z');   // 15:35 - 16:25 PT, TradeDay 11/04
    const ref = sigs.filter(s => s.t >= from && s.t <= to && s.dir === -1 && s.level === '4H Open' && s.kind === 'trap');
    ok(ref.length >= 1, 'E2 a SHORT signal off the 4H Open trap in the reference window', sigs.filter(s => s.t >= from && s.t <= to).map(s => [new Date(s.t).toISOString().slice(11, 16), s.side, s.level, s.kind, s.plan && s.plan.stop]));
    ok(ref.some(s => s.plan && Number.isFinite(s.plan.stop) && s.plan.stop > 28511), 'E3 its stop is above the 28,511 failed-breakout high (4H type)', ref.map(s => s.plan && (s.plan.stop || s.plan.skip)));
    ok(ref.some(s => typeof s.push === 'string' && ASCII.test(s.push) && s.push.startsWith('TIDE SHADOW SHORT')), 'E4 it is pushed (ASCII line)', ref.map(s => s.push));
    ok(pushes.every(p => ASCII.test(p)), 'E5 every push line is ASCII');
    ok(rows < 20000, 'E6 journal volume bounded over the witness file', rows);
    const aplus = ref.find(s => s.plan && s.plan.grade === 'A+');
    ok(aplus && aplus.plan.tp2.price === 28035.25 && aplus.plan.tp2.basis === 'major-pool' && aplus.plan.tp2.pool && /^PDL\b/.test(aplus.plan.tp2.pool.name), 'E7 A+ TP2 = the next MAJOR pool beyond 2R: PDL 28,035.25 (playbook §18.4)', aplus && aplus.plan.tp2);
    const axe = aplus && exits.find(x => x.id === aplus.id);
    ok(axe && axe.why === 'tp2' && axe.exit === 28035.25 && axe.resultR === 2.27 && axe.simulated === true, 'E11 the A+ virtual trade ends at TP2 PDL 28,035.25 (+2.27R, 17:05 PT): journaled, and the engine told', axe);
    const late = sigs.find(x => x.t >= Date.parse('2026-11-03T21:30:00Z') && x.t <= Date.parse('2026-11-03T21:40:00Z'));
    ok(late && late.gatesNow === 'SESSION_CLOSE' && late.push === null && late.taken === false, 'E12 the 13:33 PT signal is inside the session close: journaled SESSION_CLOSE, silent, not taken', late && [late.gatesNow, late.push]);
    ok(aplus && aplus.plan.mode === 'flat' && aplus.plan.qty === 1 && aplus.plan.shadow && aplus.plan.shadow.shadow.mode === 'grade' && aplus.plan.shadow.shadow.contracts === 3 && aplus.plan.stop === 28513, 'E8 the §3 witness at A+, stop 28,513: flat $450 = 1 MNQ, the grade A+ $900 size 3 MNQ beside it', aplus && aplus.plan);
    ok(aplus && aplus.plan.tp1 && aplus.plan.tp1.pool && !/round/i.test(String(aplus.plan.tp1.pool.name)) && aplus.plan.tp1.price === 28324.5, 'E10 the 11/04 TP1 is not a round-number pool: 1H Open 28,324.5 (structure r3.2, from moneyRule.planExits on the signal\'s pools)', aplus && aplus.plan.tp1);
    ok(aplus && /^TIDE SHADOW SHORT A\+ \(4: trap force volume timing\) flat 450: 1 MNQ \| grade A\+ 900: 3 MNQ @28366\.75 stop 28513 TP1 28324\.5 TP2 28035\.25 \| all at once, 1 lot: BE at TP1, no partial \| /.test(aplus.push), 'E9 the witness push line (shipped config)', aplus && aplus.push);
    if (VERBOSE) for (const s of ref) console.log('     ', new Date(s.t).toISOString(), s.push);
  } }

console.log(`\ntide2-exec (${W.VERSION}, ${M.VERSION}): ${pass} passed, ${fail} failed${pend ? `, ${pend} pending (${pends.join('; ')})` : ''}`);
if (fail) { for (const f of fails) console.log('  - ' + f); process.exitCode = 1; }
