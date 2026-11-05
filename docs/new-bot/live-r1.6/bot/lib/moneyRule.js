'use strict';
// MONEY RULE r4.1 (lv1 new model): Candace's SIZE style and profit-taking style on OUR structural stops. MNQ only. PURE: no I/O, no requires, no clock, no state.
//   Playbook §5 (stops: structure, option C, never tightened to fit), §11 (stops only move in the trade's favour, no timed exits),
//   §16/§17 (size by grade dollars), §18 (Candace's exits), §22 (how each grade enters + the grade-upgrade add), SPEC-TIDE-r2 D' (sizing), D'' (exits),
//   D''' (protection), D'''' (2/3 partial + pyramid) and D5 (entry by grade + grade-upgrade add; supersedes D' "scale-in on A+ only").
//   NO daily loss limit of any kind (Mac 11/04: "No daily loss limit! Don't forget that!"): nothing here counts losses, trades or days.
//
// cfg = { sizing: { enabled, mode: 'flat' | 'grade', flatDollars, gradeRiskUsd: { A, B, C }, maxContracts, noFit: 'skip' | 'take1', entryByGrade, scaleInB,
//                   upgradeAdd: { enabled } }, exits: { partialFrac, trailBufferPts, protect }, pointValue?, tickSize? }
//   (pointValue 2 = MNQ, tickSize 0.25 by default; the executor passes its own. sizing.scaleInA is the r2 key: still accepted, ignored.)
// r4 TEAM POSITION, COMMON RISK FIRST: mode 'flat' (default) = every grade risks flatDollars; the grade is logged and its grade-dollar size is logged as
//   a SHADOW (shadowSize) for the paired comparison, never placed. mode 'grade' = the grade dollars. The dollar amount is Mac's decision.
// GRADES are never computed here: they come from the structure engine's GRADE r3 table. gradeOf is deprecated and always fails closed.
// SIZE   sizeFor(stopPts, grade, cfg)       contracts = min(maxContracts, floor(dollars / (stopPts x $2))); none fit -> noFit 'skip' (GRADE_NO_FIT) or 'take1'
//                                           (1 MNQ, over-budget dollars logged). The stop is never moved.
//        chooseStop(cands, grade, cfg, o)   option C: 4H-type level / trap -> the 4H wick, hour-type -> the 1H wick. No fallback to a tighter wick.
// ENTRY  entryByGrade false (default): every grade ALL AT ONCE. entryByGrade true (D5, §22): A+ all at once; B half (rounded up) at the trigger + the rest
//        resting at the retest/FVG, same structural stop, combined risk <= the B trade's dollars; C one entry. restingCancel fails closed (cancel).
//        upgradeAdd (off by default; mode 'grade' only): a B or C trade re-graded A+ by the structure engine, BEFORE TP1, ONCE: top the total risk up to the
//        A+ dollars at the SAME structural stop, with the resting B half RESERVED until it is terminal. Every lifecycle field is required (fail closed).
// NEAR-FLOOR GUARD (r4.1, MacRisk's option, OFF by default: Mac has not decided): sizing.nearFloor { enabled, cushionUsd, dollars }. When enabled and the
//        executor's cfg.floorDistanceUsd (balance - the trailing floor) is below cushionUsd, OR unknown / invalid (fail SAFE), every trade's dollars become
//        min(the mode's dollars, nearFloor.dollars), in both modes. It only caps the size: it never refuses a trade and counts nothing (not a loss limit).
// EXITS  targetFor   TP = nearest pool at/beyond 2R (A+: the next MAJOR pool beyond 2R; else the nearest pool beyond 2R; none -> 2R exactly).
//        partialFor  TP1 at the first internal pool between entry and TP, no farther than 1R (none -> 1R): 2/3 of the position (round to nearest; 3 -> 2).
//        beStopAfterPartial  entry +/- 1 tick toward profit. TP2 = targetFor: everything left (runner + add) exits there.
// PROTECT (D''', playbook §20; all only tighten): protectStop = the R-ladder (+1R BE+1 tick, +1.5R lock 0.5R, +2R lock 1R, then best R - 1R in 0.5R steps);
//        structuralTrail = behind the last confirmed 15m swing once a MAJOR pool in our favour is swept; climaxTighten = behind the last 5m swing on a climax
//        in our favour (isClimax). Minor 1m/5m swings never move the stop (D''' supersedes the D'' minor-swing trail). nextStop combines them.
// PYRAMID (D'''', §21): addAllowed = once, after TP1, 1/3 of the original size on a rejected pullback, trend still ours, HOUSE MONEY only.
const VERSION = 'money-r4.1';
const ENTRY_VERSIONS = Object.freeze(['money-r2', 'money-r3', 'money-r4', 'money-r4.1']);   // isMoneyEntry: an r2 trade restored across the upgrade keeps its graded behaviour
const DEFAULTS = Object.freeze({
  // money-r4 team position: COMMON RISK FIRST. mode 'flat' = every grade risks flatDollars (450 = placeholder until Mac sets it); grades are logged and
  // the grade size is logged as a shadow only. mode 'grade' = the grade dollars (150K values, Mac 11/04). entryByGrade false = every grade all at once.
  // upgradeAdd off (dormant by design: GRADE r3 freezes points at the decision). noFit 'skip' (Mac's ruling pending; 'take1' = 1 MNQ, over-budget logged).
  sizing: Object.freeze({ enabled: false, mode: 'flat', flatDollars: 450, gradeRiskUsd: Object.freeze({ A: 900, B: 600, C: 300 }), maxContracts: 30, noFit: 'skip',
    entryByGrade: false, scaleInB: true, upgradeAdd: Object.freeze({ enabled: false }),
    nearFloor: Object.freeze({ enabled: false, cushionUsd: 2000, dollars: 300 }) }),   // r4.1: OFF (Mac to decide)
  exits: Object.freeze({ partialFrac: 2 / 3, trailBufferPts: 2,   // Mac 11/04: "2 out of 3"; the swing buffer = the level-event STOP_BUF
    protect: Object.freeze({ enabled: true, startR: 1, stepR: 0.5, trailR: 1, structural15m: true, climax: true, climaxVolMult: 2 }) }),
});
const MIN_RR = 2;                // §18.1: bracket at a minimum 1:2
const RISK_MIN = 50, RISK_MAX = 2000, MAX_CONTRACTS_LIMIT = 150;
const EPS = 1e-9;
const PLACE_BUFFER_TICKS = 1;   // a new stop must rest at least this many ticks behind the last price to be placeable (D''' protection, finding 5)
// Config keys that name a day / daily limit are refused outright (§17: no daily loss limit, not as dollars, not as a trade count).
const NO_DAY_LIMIT_GUARD = /day|daily|session.?loss|loss.?limit|max.?loss|full.?stops/i;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const r2 = x => Math.round(x * 100) / 100;
function mkt(cfg) { const c = cfg || {}; return { pv: isNum(c.pointValue) && c.pointValue > 0 ? c.pointValue : 2, tick: isNum(c.tickSize) && c.tickSize > 0 ? c.tickSize : 0.25 }; }
const SIZING_MODES = Object.freeze(['flat', 'grade']), NO_FIT_MODES = Object.freeze(['skip', 'take1']);
// Runtime view of cfg.sizing. Fails closed: an unknown mode sizes 0 (SIZING_MODE_INVALID); an unknown noFit is 'skip'; entryByGrade and upgradeAdd
// are on only when exactly true.
function sizingOf(cfg) {
  const s = (cfg && cfg.sizing) || {}, d = DEFAULTS.sizing;
  return { enabled: s.enabled === true, mode: s.mode === undefined ? d.mode : s.mode, flatDollars: s.flatDollars === undefined ? d.flatDollars : s.flatDollars,
    gradeRiskUsd: { ...d.gradeRiskUsd, ...(s.gradeRiskUsd || {}) }, maxContracts: isNum(s.maxContracts) ? s.maxContracts : d.maxContracts,
    noFit: s.noFit === 'take1' ? 'take1' : 'skip', entryByGrade: s.entryByGrade === true, scaleInB: typeof s.scaleInB === 'boolean' ? s.scaleInB : d.scaleInB,
    upgradeAddEnabled: !!(s.upgradeAdd && s.upgradeAdd.enabled === true), nearFloor: nearFloorCfg(s.nearFloor) };
}
// r4.1 near-floor guard. Runtime view: on only when enabled === true; a cushion or dollars that is not a usable number falls back to the default
// (the guard dollars can only shrink the size: min(mode dollars, guard dollars)).
function nearFloorCfg(n) {
  const d = DEFAULTS.sizing.nearFloor, o = n && typeof n === 'object' ? n : {};
  return { enabled: o.enabled === true, cushionUsd: isNum(o.cushionUsd) && o.cushionUsd > 0 ? o.cushionUsd : d.cushionUsd, dollars: isNum(o.dollars) && o.dollars > 0 ? o.dollars : d.dollars };
}
// The guard state for one sizing call. cfg.floorDistanceUsd = balance - the trailing floor (the executor passes it, like pointValue). null = guard off.
// Unknown / invalid distance while enabled -> active (fail SAFE: the smaller size), reason 'distance-unknown'. Never a refusal.
function nearFloorOf(s, cfg, baseUsd) {
  const nf = s.nearFloor; if (!nf.enabled) return null;
  const dist = cfg ? cfg.floorDistanceUsd : undefined, known = isNum(dist), active = !known || dist < nf.cushionUsd;
  return Object.freeze({ enabled: true, active, reason: !known ? 'distance-unknown' : active ? 'below-cushion' : 'above-cushion', floorDistanceUsd: known ? r2(dist) : null,
    cushionUsd: nf.cushionUsd, dollars: nf.dollars, baseUsd, usd: active ? Math.min(baseUsd, nf.dollars) : baseUsd });
}
// The dollars a trade of grade key k risks after the near-floor guard: { usd, guard } (guard null when the guard is off; usd null on an unknown mode).
function budgetOf(k, s, cfg) { const base = dollarsFor(k, s); if (base === null) return { usd: null, guard: null }; const g = nearFloorOf(s, cfg, base); return { usd: g ? g.usd : base, guard: g }; }
// The dollars a trade of grade key k risks: flat -> flatDollars for every grade; grade -> gradeRiskUsd[k]; an unknown mode -> null (no trade).
function dollarsFor(k, s) { const v = s.mode === 'flat' ? s.flatDollars : s.mode === 'grade' ? s.gradeRiskUsd[k] : null; return isNum(v) && v > 0 ? v : null; }
// [r1.5.6] withRiskMult: the same cfg with every risk budget x m (flatDollars, gradeRiskUsd A/B/C); m 1 / missing = the cfg itself. Used for an against-HTF signal (tide.htfAgainst 'half': m 0.5).
// The minimum stays 1 MNQ through noFit 'take1' (sizeFor); maxContracts and every other rule are unchanged.
function withRiskMult(cfg, m) {
  if (!isNum(m) || m <= 0 || m === 1) return cfg;
  const c = cfg || {}, s = c.sizing || {}, g = s.gradeRiskUsd || {};
  return { ...c, sizing: { ...s, ...(isNum(s.flatDollars) ? { flatDollars: r2(s.flatDollars * m) } : {}), gradeRiskUsd: { ...g, ...Object.fromEntries(['A', 'B', 'C'].filter(k => isNum(g[k])).map(k => [k, r2(g[k] * m)])) }, riskMult: m } };
}
function withMode(cfg, mode) { const c = cfg || {}; return { ...c, sizing: { ...(c.sizing || {}), mode } }; }
function exitsOf(cfg) { const e = (cfg && cfg.exits) || {}; const d = DEFAULTS.exits; return { partialFrac: isNum(e.partialFrac) ? e.partialFrac : d.partialFrac, trailBufferPts: isNum(e.trailBufferPts) ? e.trailBufferPts : d.trailBufferPts, protect: { ...d.protect, ...(e.protect || {}) } }; }
// tick rounding in "favour" coordinates: x = dir * price, so "up" is always toward profit
function roundTick(p, tick, mode) { const q = p / tick; const n = mode === 'up' ? Math.ceil(q - EPS) : mode === 'down' ? Math.floor(q + EPS) : Math.round(q); return r2(n * tick); }
function towardProfit(price, dir, tick) { return roundTick(price, tick, dir === 1 ? 'up' : 'down'); }   // never less favourable than price
function towardEntry(price, dir, tick) { return roundTick(price, tick, dir === 1 ? 'down' : 'up'); }    // a resting limit inside the pool
function towardLoss(price, dir, tick) { return towardEntry(price, dir, tick); }                        // a stop behind a swing

// ---------------------------------------------------------------- grade
// 'A+' | 'A' -> 'A' (the config key), 'B', 'C'; anything else null.
function gradeKey(g) { const s = String(g == null ? '' : g).trim().toUpperCase(); return s === 'A+' || s === 'A' ? 'A' : s === 'B' ? 'B' : s === 'C' ? 'C' : null; }
function gradeLabel(k) { return k === 'A' ? 'A+' : k; }
// gradeOf is DEPRECATED (money-r4) and always FAILS CLOSED: grade null = no trade, whatever it is given. The money rule never grades or
// re-grades: the grade (gates + points) comes only from the structure engine's GRADE r3 table (SPEC-TIDE-r2 "GRADE r3"), and money sizes what it is
// handed (sizeFor / scaleInPlan / upgradeAdd take that grade as a label). Kept as an export only so an old caller gets "no trade", not a crash.
function gradeOf() { return Object.freeze({ grade: null, missing: [], reason: 'GRADE_NOT_IN_MONEY', deprecated: true }); }

// ---------------------------------------------------------------- size
// mode flat: usd = flatDollars for every grade (the grade is still required: it is logged). mode grade: usd = gradeRiskUsd[grade].
// budgetUsd = gradeRiskUsd = usd (gradeRiskUsd kept as the r2/r3 field name). The STOP IS NEVER MOVED: stopPts comes back unchanged in every branch.
// No fit (even 1 MNQ > usd): noFit 'skip' -> 0, GRADE_NO_FIT; noFit 'take1' -> 1 MNQ, code NO_FIT_TAKE1, overBudgetUsd = the actual 1-lot risk - usd.
function sizeFor(stopPts, grade, cfg) {
  const s = sizingOf(cfg), { pv } = mkt(cfg), k = gradeKey(grade);
  const base = { version: VERSION, mode: s.mode, grade: k ? gradeLabel(k) : null, stopPts: isNum(stopPts) ? r2(stopPts) : null };
  if (!k) return Object.freeze({ ...base, contracts: 0, riskUsd: 0, budgetUsd: null, gradeRiskUsd: null, perContractUsd: null, maxFitPts: null, overBudgetUsd: 0, reason: 'invalid-grade', code: 'GRADE_INVALID' });
  const { usd, guard } = budgetOf(k, s, cfg), nf = guard ? { nearFloor: guard } : {};   // r4.1: the field exists only when the guard is enabled (off = r4 output)
  if (usd === null) return Object.freeze({ ...base, contracts: 0, riskUsd: 0, budgetUsd: null, gradeRiskUsd: null, perContractUsd: null, maxFitPts: null, overBudgetUsd: 0, reason: 'invalid-mode', code: 'SIZING_MODE_INVALID' });
  if (!(isNum(stopPts) && stopPts > 0)) return Object.freeze({ ...base, contracts: 0, riskUsd: 0, budgetUsd: usd, gradeRiskUsd: usd, perContractUsd: null, maxFitPts: r2(usd / pv), overBudgetUsd: 0, reason: 'invalid-stop', code: 'GRADE_INVALID', ...nf });
  const per = stopPts * pv, fit = Math.floor(usd / per + EPS), contracts = Math.max(0, Math.min(s.maxContracts, fit));
  const common = { ...base, budgetUsd: usd, gradeRiskUsd: usd, perContractUsd: r2(per), maxFitPts: r2(usd / pv), maxContracts: s.maxContracts, ...nf };
  if (contracts === 0 && s.noFit === 'take1') return Object.freeze({ ...common, contracts: 1, riskUsd: r2(per), overBudgetUsd: r2(per - usd), reason: 'no-fit-take1', code: 'NO_FIT_TAKE1' });
  return Object.freeze({ ...common, contracts, riskUsd: r2(contracts * per), overBudgetUsd: 0,
    reason: contracts === 0 ? 'grade-no-fit' : fit > s.maxContracts ? 'grade-max-contracts' : 'grade-fit', code: contracts === 0 ? 'GRADE_NO_FIT' : null });
}
// Shadow size for the paired comparison (logging ONLY, never placed): the size used and what the other mode would size at the same stop.
// line = '<used> | <shadow>', e.g. 'flat 450: 3 MNQ | grade A+ 900: 6 MNQ' (75 pts, mode flat).
function shadowSize(stopPts, grade, cfg) {
  const s = sizingOf(cfg), otherMode = s.mode === 'flat' ? 'grade' : 'flat';
  const used = sizeFor(stopPts, grade, cfg), other = sizeFor(stopPts, grade, withMode(cfg, otherMode));
  const pick = z => ({ mode: z.mode, grade: z.grade, budgetUsd: z.budgetUsd, contracts: z.contracts, riskUsd: z.riskUsd, overBudgetUsd: z.overBudgetUsd, code: z.code, ...(z.nearFloor ? { nearFloor: z.nearFloor } : {}) });
  const lab = z => `${z.mode === 'grade' ? `grade ${z.grade}` : String(z.mode)} ${z.budgetUsd ?? '?'}${z.nearFloor && z.nearFloor.active ? ' near-floor' : ''}: ${z.contracts} MNQ${z.code === 'NO_FIT_TAKE1' ? ` (take1, $${z.overBudgetUsd} over)` : z.code ? ` (${z.code})` : ''}`;
  const g = used.nearFloor && used.nearFloor.active ? used.nearFloor : null;   // r4.1: the line names the guard when it capped the size
  const tag = g ? ` [near-floor guard $${g.dollars}: ${g.reason === 'distance-unknown' ? 'floor distance unknown' : `floor distance $${g.floorDistanceUsd} < cushion $${g.cushionUsd}`}]` : '';
  return Object.freeze({ logOnly: true, used: Object.freeze(pick(used)), shadow: Object.freeze(pick(other)), line: `${lab(used)} | ${lab(other)}${tag}` });
}

// Option C (§5): which wick a level uses. 4H-type: 4H Open, PDH, PDL, any trap. Hour-type: 1H Open, Asia / London highs and lows (and other session levels).
function levelStopTf(levelName, isTrap = false) {
  if (isTrap) return '4H';
  const n = String(levelName == null ? '' : levelName).toUpperCase().replace(/[\s_-]+/g, '');
  if (/^(4HO|4HOPEN|O4|PDH|PDL)$/.test(n) || /^4H/.test(n)) return '4H';
  if (/^(1HO|1HOPEN)$/.test(n) || /^1H/.test(n) || /ASIA|LONDON|LDN/.test(n)) return '1H';
  return null;
}
// cands [{ tf: '4H' | '1H', stopPts, ...any (e.g. stop price) }]. o = { levelName, isTrap } or { tf } (the wick option C requires).
// Returns the required wick sized at the grade dollars, or GRADE_NO_FIT. Never a tighter wick to make it fit (the stop is never moved to fit).
function chooseStop(cands, grade, cfg, o = {}) {
  const list = Array.isArray(cands) ? cands.filter(c => c && typeof c === 'object') : [];
  const want = o.tf ? String(o.tf).toUpperCase() : levelStopTf(o.levelName, o.isTrap === true);
  const tried = list.map(c => { const z = sizeFor(c.stopPts, grade, cfg); return { tf: c.tf ?? null, stopPts: z.stopPts, contracts: z.contracts, reason: z.reason }; });
  const pick = want ? list.find(c => String(c.tf).toUpperCase() === want) : list.slice().sort((a, b) => tfRank(b.tf) - tfRank(a.tf))[0];
  if (!pick) return Object.freeze({ tf: want, stopPts: null, contracts: 0, riskUsd: 0, grade: gradeKey(grade) ? gradeLabel(gradeKey(grade)) : null, reason: 'no-wick', code: 'GRADE_NO_WICK', rule: 'option-C', tried });
  const z = sizeFor(pick.stopPts, grade, cfg);
  return Object.freeze({ ...pick, tf: pick.tf ?? null, stopPts: z.stopPts, contracts: z.contracts, riskUsd: z.riskUsd, grade: z.grade, gradeRiskUsd: z.gradeRiskUsd, reason: z.reason, code: z.code, rule: 'option-C', tried });
}
function tfRank(tf) { const m = /^\s*(\d+)\s*(m|h|d|w)\s*$/i.exec(String(tf == null ? '' : tf)); if (!m) return -1; const u = m[2].toLowerCase(); return Number(m[1]) * (u === 'w' ? 10080 : u === 'd' ? 1440 : u === 'h' ? 60 : 1); }

// ---------------------------------------------------------------- entry by grade (D5, playbook §16 / §22)
// A+: ALL AT ONCE at the trigger (the best moves often never retest). B: half at the trigger (rounded up; a 1-lot still trades), the rest resting
// at the retest/FVG price with the same structural stop. C: one small entry. sizing.scaleInB false: B is one entry too (the safe build until the
// resting order is wired). style = 'all-at-once' | 'scale-in' | 'one-entry'. money-r4: these D5 styles apply only with sizing.entryByGrade true;
// entryByGrade false (the default) = EVERY grade all at once at the trigger.
function scaleInPlan(stopPts, grade, cfg) {
  const z = sizeFor(stopPts, grade, cfg), s = sizingOf(cfg), k = gradeKey(grade);
  const split = s.entryByGrade && k === 'B' && s.scaleInB && z.contracts >= 2;
  const first = split ? Math.ceil(z.contracts / 2) : z.contracts;
  return Object.freeze({ version: VERSION, mode: z.mode, grade: z.grade, stopPts: z.stopPts, total: z.contracts, first, second: z.contracts - first, scaleIn: split,
    style: !s.entryByGrade || k === 'A' ? 'all-at-once' : split ? 'scale-in' : 'one-entry', entryByGrade: s.entryByGrade, gradeRiskUsd: z.gradeRiskUsd, reason: z.reason, code: z.code,
    ...(z.nearFloor ? { nearFloor: z.nearFloor } : {}) });
}
// The resting B half once the first half is filled: same structural stop PRICE, at most the planned rest, combined risk <= the B dollars.
// p = { dir, stop (the one protective stop), structuralStop (the stop the trade was sized at: MANDATORY), firstFill, firstContracts, entry2, plannedSecond, grade? }.
// grade defaults to 'B' (the only grade that scales in); A+ / C (or scaleInB false, or entryByGrade false) -> 0 'no-scale-in'. Cap = the B trade's dollars. No structuralStop -> 0 'no-structural-stop';
// a stop that already moved off it -> 0 'stop-moved' (sizing never follows a tightened stop).
function secondLeg(p, cfg) {
  const { pv } = mkt(cfg), s = sizingOf(cfg), q = p || {}, k = q.grade == null ? 'B' : gradeKey(q.grade);
  if (k !== 'B' || !s.scaleInB || !s.entryByGrade) return Object.freeze({ contracts: 0, grade: k ? gradeLabel(k) : null, reason: 'no-scale-in' });
  const usd = budgetOf('B', s, cfg).usd, zero = reason => Object.freeze({ contracts: 0, grade: 'B', reason });   // r4.1: the near-floor guard applies
  if (usd === null) return zero('invalid-mode');
  const ok = (q.dir === 1 || q.dir === -1) && isNum(q.stop) && isNum(q.firstFill) && isNum(q.entry2) && Number.isInteger(q.firstContracts) && q.firstContracts >= 1 && Number.isInteger(q.plannedSecond) && q.plannedSecond >= 0;
  if (!ok) return zero('invalid-input');
  if (!isNum(q.structuralStop)) return zero('no-structural-stop');
  if (Math.abs(q.stop - q.structuralStop) > EPS) return zero('stop-moved');
  const r1 = q.dir * (q.firstFill - q.stop), rB = q.dir * (q.entry2 - q.stop);
  if (!(r1 > 0) || !(rB > 0)) return zero('stop-not-behind-entry');
  const firstRisk = q.firstContracts * r1 * pv, left = usd - firstRisk;
  const fit = left > 0 ? Math.floor(left / (rB * pv) + EPS) : 0;
  const contracts = Math.max(0, Math.min(q.plannedSecond, fit, s.maxContracts - q.firstContracts));
  return Object.freeze({ contracts, grade: 'B', stop: q.stop, entry2: q.entry2, firstRiskUsd: r2(firstRisk), secondRiskUsd: r2(contracts * rB * pv), combinedRiskUsd: r2(firstRisk + contracts * rB * pv), gradeRiskUsd: usd,
    reason: contracts === 0 ? 'no-room' : contracts < q.plannedSecond ? 'sized-down' : 'as-planned' });
}
// Should the resting B half be cancelled now? EVERY field is required and must be known:
//   p = { dir, bestPx (best 1m high/low since the first fill), tp1Px (the plan's TP1 price), tp1Done, invalidated (TIDE: the setup is invalid or its
//         retest window ended), closed (the position is flat: stop or any exit) } -- booleans must be true/false, prices finite.
// -> { cancel, reason: 'position-closed' | 'tp1-reached' | 'invalidated' | 'keep' | 'unknown-state' }. Anything unknown FAILS CLOSED: cancel.
function restingCancel(p) {
  const q = p || {}, dir = q.dir, out = (cancel, reason) => Object.freeze({ cancel, reason });
  if (q.closed === true) return out(true, 'position-closed');
  const known = (dir === 1 || dir === -1) && isNum(q.bestPx) && isNum(q.tp1Px) && [q.tp1Done, q.invalidated, q.closed].every(b => typeof b === 'boolean');
  if (!known) return out(true, 'unknown-state');
  if (q.tp1Done === true || dir * (q.bestPx - q.tp1Px) >= -EPS) return out(true, 'tp1-reached');
  if (q.invalidated === true) return out(true, 'invalidated');
  return out(false, 'keep');
}
// GRADE-UPGRADE ADD (D5, §22): a B or C trade that re-grades A+ while open (the grade comes from the structure engine; money does not re-grade),
// BEFORE TP1, ONCE per trade, adds on the next rejected pullback the contracts that bring the total risk up to the A+ dollars at the SAME structural stop.
// p (EVERY field required unless marked ?) = { grade (the trade's grade), newGrade (the structure engine's live re-grade), dir, openQty, entry (avg entry of
//     the open contracts), stop (the ONE protective stop), structuralStop (the stop the trade was sized at), addPx (the pullback price the add is sent at),
//     restingQty (RESERVED: the resting B half's contracts not yet terminal, i.e. working or cancel sent but unconfirmed; 0 only after a confirmed
//     cancel or once its fills are folded into openQty/entry), restingPx (required when restingQty > 0), tp1Done, tp1Px, bestPx (best 1m high/low since
//     the first fill; a 1-lot has no TP1 order, so TP1 counts as done once its price trades), upgradedBefore, oldPoints?, newPoints?, cfg }
// -> { ok, qty, reason, code: GRADE_UPGRADE | GRADE_UPGRADE_SKIP, worstAddPx, reservedRestingQty, risk: { openUsd, restingUsd, addUsd, totalUsd, gradeRiskUsd },
//      combined: { contracts, avgEntry } (open + add), ifRestingFills: { contracts, avgEntry }, row }.
//   RESERVATION: the add is sized as if every reserved resting contract fills at restingPx, so open + resting + add <= the A dollars (and <= maxContracts)
//   in every outcome: the resting half filling before a cancel completes cannot push the trade past the A+ dollars.
//   Refusals fail closed: 'upgrade-off' (sizing.upgradeAdd.enabled is not true: the default), 'flat-mode' / 'invalid-mode' (only mode 'grade' upgrades), 'invalid-input' (geometry), 'no-structural-stop', 'unknown-state' (a lifecycle field missing / not boolean / not finite),
//   'not-b-or-c', 'not-a-plus', 'after-tp1', 'already-upgraded', 'stop-moved' (the stop differs from structuralStop or sits at/past the entry: never
//   size to a tightened stop), 'stop-not-behind-add', 'no-room', 'max-contracts'.
//   worstAddPx = the worst add fill that keeps the total <= the A dollars at this qty (send the add as a limit there; slippage past it is extra).
function upgradeAdd(p) {
  const q = p || {}, { pv, tick } = mkt(q.cfg), s = sizingOf(q.cfg), dir = q.dir, k = gradeKey(q.grade), nk = gradeKey(q.newGrade), A = budgetOf('A', s, q.cfg).usd;   // r4.1: the near-floor guard caps the A+ dollars too
  const restingKnown = Number.isInteger(q.restingQty) && q.restingQty >= 0, resting = restingKnown ? q.restingQty : null;
  const res = (ok, qty, reason, x = {}) => {
    const risk = x.risk || null, worstAddPx = x.worstAddPx ?? null, code = ok ? 'GRADE_UPGRADE' : 'GRADE_UPGRADE_SKIP';
    const row = { code, version: VERSION, from: k ? gradeLabel(k) : null, to: nk ? gradeLabel(nk) : null, reason, oldPoints: q.oldPoints ?? null, newPoints: q.newPoints ?? null,
      dir: dir ?? null, openQty: q.openQty ?? null, entry: q.entry ?? null, stop: q.stop ?? null, structuralStop: q.structuralStop ?? null, addPx: q.addPx ?? null, qty, worstAddPx,
      reservedRestingQty: resting, restingPx: q.restingPx ?? null, openRiskUsd: risk ? risk.openUsd : null, restingRiskUsd: risk ? risk.restingUsd : null,
      addRiskUsd: risk ? risk.addUsd : null, totalRiskUsd: risk ? risk.totalUsd : null, gradeRiskUsd: A };
    return Object.freeze({ ok, qty, reason, code, worstAddPx, reservedRestingQty: resting, risk, combined: x.combined || null, ifRestingFills: x.ifRestingFills || null, row: Object.freeze(row) });
  };
  if (!s.upgradeAddEnabled) return res(false, 0, 'upgrade-off');   // money-r4 default: dormant (GRADE r3 freezes points at the decision)
  if (s.mode !== 'grade') return res(false, 0, s.mode === 'flat' ? 'flat-mode' : 'invalid-mode');   // flat: every grade has the same dollars, nothing to top up
  if (!(dir === 1 || dir === -1) || !isNum(q.entry) || !isNum(q.stop) || !isNum(q.addPx) || !(Number.isInteger(q.openQty) && q.openQty >= 1)) return res(false, 0, 'invalid-input');
  if (!isNum(q.structuralStop)) return res(false, 0, 'no-structural-stop');
  const lifecycleKnown = typeof q.tp1Done === 'boolean' && typeof q.upgradedBefore === 'boolean' && restingKnown && (resting === 0 || isNum(q.restingPx)) && isNum(q.tp1Px) && isNum(q.bestPx);
  if (!lifecycleKnown) return res(false, 0, 'unknown-state');
  if (k !== 'B' && k !== 'C') return res(false, 0, 'not-b-or-c');
  if (nk !== 'A') return res(false, 0, 'not-a-plus');
  if (q.tp1Done === true || dir * (q.bestPx - q.tp1Px) >= -EPS) return res(false, 0, 'after-tp1');
  if (q.upgradedBefore === true) return res(false, 0, 'already-upgraded');
  const openUsd = q.openQty * dir * (q.entry - q.stop) * pv;
  if (Math.abs(q.stop - q.structuralStop) > EPS || !(openUsd > 0)) return res(false, 0, 'stop-moved');
  const per = dir * (q.addPx - q.stop) * pv, perRest = resting ? dir * (q.restingPx - q.stop) * pv : 0;
  if (!(per > 0)) return res(false, 0, 'stop-not-behind-add');
  if (resting && !(perRest > 0)) return res(false, 0, 'invalid-input');
  const restingUsd = resting * perRest, budget = A - openUsd - restingUsd;
  const fit = budget > 0 ? Math.floor(budget / per + EPS) : 0, room = s.maxContracts - q.openQty - resting, qty = Math.max(0, Math.min(fit, room));
  if (qty < 1) return res(false, 0, fit >= 1 ? 'max-contracts' : 'no-room', { risk: { openUsd: r2(openUsd), restingUsd: r2(restingUsd), addUsd: 0, totalUsd: r2(openUsd + restingUsd), gradeRiskUsd: A } });
  const risk = { openUsd: r2(openUsd), restingUsd: r2(restingUsd), addUsd: r2(qty * per), totalUsd: r2(openUsd + restingUsd + qty * per), gradeRiskUsd: A };
  const worstAddPx = towardLoss(q.stop + dir * budget / (qty * pv), dir, tick);
  const legs = [{ price: q.entry, contracts: q.openQty }, { price: q.addPx, contracts: qty }];
  return res(true, qty, resting ? 'merged-resting' : 'top-up', { risk, worstAddPx, combined: combine(legs), ifRestingFills: resting ? combine(legs.concat([{ price: q.restingPx, contracts: resting }])) : combine(legs) });
}
// The combined position (one position, one protective stop, D''): legs [{ price, contracts }] -> { contracts, avgEntry }
function combine(legs) {
  const L = (Array.isArray(legs) ? legs : []).filter(l => l && isNum(l.price) && Number.isInteger(l.contracts) && l.contracts > 0);
  const n = L.reduce((a, l) => a + l.contracts, 0);
  return { contracts: n, avgEntry: n ? L.reduce((a, l) => a + l.price * l.contracts, 0) / n : null };
}

// ---------------------------------------------------------------- exits (D'', playbook §18)
function poolList(pools) { return (Array.isArray(pools) ? pools : []).map(p => (isNum(p) ? { price: p, major: false } : p)).filter(p => p && isNum(p.price)); }
// TP: nearest pool at or beyond 2R; A+ the next MAJOR pool beyond 2R (no major there -> the nearest pool beyond 2R); no pool beyond 2R -> 2R exactly.
function targetFor(entry, stop, dir, pools, grade, cfg) {
  const { tick } = mkt(cfg);
  if (!(isNum(entry) && isNum(stop) && (dir === 1 || dir === -1)) || !(dir * (entry - stop) > 0)) return null;
  const R = dir * (entry - stop), p2R = towardProfit(entry + dir * MIN_RR * R, dir, tick), x2R = dir * p2R;
  const beyond = poolList(pools).map(p => ({ ...p, at: Math.max(dir * towardEntry(p.price, dir, tick), x2R) * dir, x: dir * p.price })).filter(p => p.x >= x2R - EPS).sort((a, b) => a.x - b.x);
  const isA = gradeKey(grade) === 'A', major = beyond.find(p => p.major === true);
  const pick = isA && major ? major : beyond[0] || null;
  const price = pick ? r2(pick.at) : p2R;
  return Object.freeze({ price, pts: r2(dir * (price - entry)), rr: r2(dir * (price - entry) / R), R: r2(R), basis: pick ? (isA && major ? 'major-pool' : 'pool') : '2R', pool: pick ? { price: pick.price, major: pick.major === true, name: pick.name ?? null } : null });
}
// TP1 (partial): the first internal pool strictly between entry and TP2, no farther than 1R (none there -> 1R). p = { entry, stop, dir, tp, pools, contracts }.
// Count: round(contracts x partialFrac) (2/3: 3 -> 2, 18 -> 12), at least 1, at most contracts - 1. A 1-lot has no partial order: it rides to TP2 (the ladder protects it).
function partialFor(p, cfg) {
  const { tick } = mkt(cfg), e = exitsOf(cfg), q = p || {}, dir = q.dir;
  if (!(isNum(q.entry) && isNum(q.stop) && isNum(q.tp) && (dir === 1 || dir === -1)) || !(dir * (q.entry - q.stop) > 0) || !(dir * (q.tp - q.entry) > 0)) return null;
  const R = dir * (q.entry - q.stop), x1R = dir * towardProfit(q.entry + dir * R, dir, tick), xE = dir * q.entry, xT = dir * q.tp;
  const inside = poolList(q.pools).map(pl => ({ ...pl, x: dir * towardEntry(pl.price, dir, tick) })).filter(pl => pl.x >= xE + tick - EPS && pl.x < xT - EPS).sort((a, b) => a.x - b.x);
  const first = inside[0] && inside[0].x <= x1R + EPS ? inside[0] : null;
  const price = r2(dir * (first ? first.x : x1R)), n = Number.isInteger(q.contracts) ? q.contracts : 0;
  const count = n >= 2 ? Math.max(1, Math.min(n - 1, Math.round(n * e.partialFrac + EPS))) : 0;
  return Object.freeze({ price, pts: r2(dir * (price - q.entry)), basis: first ? 'pool' : '1R', pool: first ? { price: first.price, name: first.name ?? null } : null, contracts: count, rest: n - count, frac: e.partialFrac });
}
// After the partial fills: break-even = entry +/- 1 tick toward profit (an average entry off the tick rounds toward profit).
function beStopAfterPartial(entry, dir, cfg) { const { tick } = mkt(cfg); return isNum(entry) && (dir === 1 || dir === -1) ? towardProfit(entry + dir * tick, dir, tick) : null; }
// Any stop change: only in the trade's favour (§11). Returns the stop to rest.
function stopOnlyInFavour(prevStop, wantStop, dir) { if (!isNum(wantStop)) return prevStop; if (!isNum(prevStop)) return wantStop; return dir * wantStop > dir * prevStop ? wantStop : prevStop; }


// ---------------------------------------------------------------- profit protection (D''', playbook §20). Every helper returns a stop that is never looser than currentStop.
// R-ladder on the whole remaining position (partial filled or not; after a pyramid add, on the combined position from its average entry).
//   bestR = the best favourable excursion in R (from highs/lows, not closes). bestR < startR: nothing.
//   Else lock = max(0, floor(bestR / stepR) x stepR - trailR) R: 1R -> 0 (= BE + 1 tick), 1.5R -> 0.5R, 2R -> 1R, 2.5R -> 1.5R ...
//   A lock > 0 rounds toward profit; lock 0 = beStopAfterPartial.
// PLACEABLE (money-r4): lastPx is REQUIRED. A new stop is proposed only when it rests >= PLACE_BUFFER_TICKS behind lastPx. Otherwise the stop is NOT
//   moved (stop = currentStop, moved false, placeable false) and action says what to do, by this rule:
//   - 'exit-at-market': the market already traded at/through the wanted lock (the lock the stop would have filled at). Flatten through the
//     executor's verified flatten path (never a blind opposite market order).
//   - 'hold-current': the lock is inside the buffer (too close to place), or price is at/through the CURRENT stop (the resting stop works;
//     never send a second exit). Keep the resting stop, re-poll.
//   action 'place' = send the stop replace; 'none' = nothing to do.
// The ladder's "touched +1R closes >= BE + 1 tick, touched +2R closes >= +1R" is GROSS mark-at-stop math only: it holds when the stop rests in time
// and fills at its price. Gaps, slippage, fees and an exit-at-market after a crossed lock can close worse.
function placeableAt(stop, lastPx, dir, tick) { return dir * (lastPx - stop) >= PLACE_BUFFER_TICKS * tick - EPS; }
function protectStop(p) {
  const q = p || {}, { tick } = mkt(q.cfg), pr = exitsOf(q.cfg).protect, dir = q.dir;
  const keep = (why, extra) => Object.freeze({ stop: q.currentStop, moved: false, placeable: null, action: 'none', reason: why, ...(extra || {}) });
  const hold = (why, extra, action = 'hold-current') => Object.freeze({ stop: q.currentStop, moved: false, placeable: false, action, reason: why, ...(extra || {}) });
  if (!(dir === 1 || dir === -1) || !isNum(q.entry) || !(isNum(q.R) && q.R > 0) || !isNum(q.currentStop)) return hold('invalid-input');
  if (pr.enabled !== true) return keep('protect-off');
  if (!isNum(q.lastPx)) return hold('no-last-price');
  const bestR = isNum(q.bestPx) ? dir * (q.bestPx - q.entry) / q.R : null;
  if (bestR === null || !(bestR >= pr.startR - EPS)) return keep('below-start', { bestR: bestR === null ? null : r2(bestR) });
  const lockR = Math.max(0, Math.floor(bestR / pr.stepR + EPS) * pr.stepR - pr.trailR);
  const want = lockR > 0 ? towardProfit(q.entry + dir * lockR * q.R, dir, tick) : beStopAfterPartial(q.entry, dir, q.cfg);
  const info = { lockR: r2(lockR), bestR: r2(bestR), ladderStop: want, wantStop: want };
  if (!(dir * want > dir * q.currentStop + EPS)) return keep('not-in-favour', info);
  if (dir * (q.lastPx - q.currentStop) <= EPS) return hold('at-current-stop', info);
  if (placeableAt(want, q.lastPx, dir, tick)) return Object.freeze({ stop: want, moved: true, placeable: true, action: 'place', reason: 'ladder', ...info });
  if (dir * (q.lastPx - want) <= EPS) return hold('lock-crossed', info, 'exit-at-market');
  return hold('lock-too-close', info);
}
// Structural trail on the 15m: once a MAJOR pool in our favour has been swept (majorSwept true), the stop may move behind the last confirmed 15m swing
// on the protective side (a swing HIGH for a short, a LOW for a long) +/- trailBufferPts, if tighter and placeable. swings15m = [{ type: 'H' | 'L', price, t }], confirmed only.
// Minor 1m/5m swings never move the stop (D''': room for the runner through bounces like 11/04 16:45). A swing level the market already crossed: hold.
function structuralTrail(p) {
  const q = p || {}, { tick } = mkt(q.cfg), e = exitsOf(q.cfg), dir = q.dir;
  if (!(dir === 1 || dir === -1)) return Object.freeze({ stop: q.currentStop, moved: false, placeable: false, action: 'hold-current', reason: 'invalid-dir' });
  if (e.protect.enabled !== true || e.protect.structural15m !== true) return Object.freeze({ stop: q.currentStop, moved: false, placeable: null, action: 'none', reason: 'off' });
  if (q.majorSwept !== true) return Object.freeze({ stop: q.currentStop, moved: false, placeable: null, action: 'none', reason: 'no-major-sweep' });
  return behindSwing(q.currentStop, q.swings15m, dir, e.trailBufferPts, tick, q.lastPx, 'structural-15m');
}
// Climax in our favour (playbook §12.5) on CLOSED 5m bars [{ o, h, l, c, v }] (the last one is the candidate): volume >= climaxVolMult x the median
// of the 20 bars before it; progress narrowing (its push past the previous bar's extreme is smaller than the previous bar's own push); and the close
// back toward the middle (at least 30% of its range away from the extreme in our direction).
function isClimax(bars5m, dir, cfg) {
  const B = (Array.isArray(bars5m) ? bars5m : []).filter(b => b && [b.o, b.h, b.l, b.c, b.v].every(isNum));
  if (!(dir === 1 || dir === -1) || B.length < 23) return Object.freeze({ climax: false, reason: 'not-enough-bars' });
  const mult = exitsOf(cfg).protect.climaxVolMult, last = B[B.length - 1], prev = B[B.length - 2], prev2 = B[B.length - 3];
  const vols = B.slice(-21, -1).map(b => b.v).sort((a, b) => a - b), med = (vols[9] + vols[10]) / 2;
  const push = (b, a) => dir === 1 ? b.h - a.h : a.l - b.l;
  const range = last.h - last.l, fromFar = range > 0 ? (dir === 1 ? last.h - last.c : last.c - last.l) / range : 0;
  const volOk = med > 0 && last.v >= mult * med, narrowing = push(last, prev) < push(prev, prev2) && push(prev, prev2) > 0, backToMid = fromFar >= 0.3;
  return Object.freeze({ climax: volOk && narrowing && backToMid, volRatio: med > 0 ? r2(last.v / med) : null, narrowing, backToMid });
}
// On a climax in our favour: lock behind the last 5m swing (protective side) +/- trailBufferPts, if tighter and placeable.
function climaxTighten(p) {
  const q = p || {}, { tick } = mkt(q.cfg), e = exitsOf(q.cfg), dir = q.dir;
  if (!(dir === 1 || dir === -1)) return Object.freeze({ stop: q.currentStop, moved: false, placeable: false, action: 'hold-current', reason: 'invalid-dir' });
  if (e.protect.enabled !== true || e.protect.climax !== true) return Object.freeze({ stop: q.currentStop, moved: false, placeable: null, action: 'none', reason: 'off' });
  if (q.climax !== true) return Object.freeze({ stop: q.currentStop, moved: false, placeable: null, action: 'none', reason: 'no-climax' });
  return behindSwing(q.currentStop, q.swings5m, dir, e.trailBufferPts, tick, q.lastPx, 'climax-5m');
}
function behindSwing(currentStop, swings, dir, buf, tick, lastPx, why) {
  const back = dir === 1 ? 'L' : 'H';
  const S = (Array.isArray(swings) ? swings : []).filter(s => s && s.type === back && isNum(s.price) && isNum(s.t)).sort((a, b) => a.t - b.t);
  const sw = S[S.length - 1];
  if (!sw) return Object.freeze({ stop: currentStop, moved: false, placeable: null, action: 'none', reason: 'no-swing' });
  const want = towardLoss(sw.price - dir * buf, dir, tick), swing = { price: sw.price, t: sw.t };
  if (!isNum(currentStop) || !isNum(lastPx)) return Object.freeze({ stop: currentStop, moved: false, placeable: false, action: 'hold-current', reason: isNum(currentStop) ? 'no-last-price' : 'invalid-input', want, swing });
  if (!(dir * want > dir * currentStop + EPS)) return Object.freeze({ stop: currentStop, moved: false, placeable: null, action: 'none', reason: 'not-in-favour', want, swing });
  if (!placeableAt(want, lastPx, dir, tick)) return Object.freeze({ stop: currentStop, moved: false, placeable: false, action: 'hold-current', reason: 'at-market', want, swing });
  return Object.freeze({ stop: want, moved: true, placeable: true, action: 'place', reason: why, want, swing });
}
// One poll: the tightest PLACEABLE stop of the current stop, the R-ladder, the 15m structural trail and the climax lock (inputs = the union of the three).
// A crossed ladder lock wins: action 'exit-at-market'. -> { stop, moved, placeable, action: place | none | hold-current | exit-at-market, by, ladder, structural, climax }
function nextStop(p) {
  const q = p || {}, dir = q.dir, parts = [protectStop(q), structuralTrail(q), climaxTighten(q)];
  const out = (stop, action, by, placeable) => Object.freeze({ stop, moved: stop !== q.currentStop, placeable, action, by, ladder: parts[0], structural: parts[1], climax: parts[2] });
  if (!(dir === 1 || dir === -1) || !isNum(q.currentStop) || !isNum(q.lastPx)) return out(q.currentStop, 'hold-current', null, false);
  if (parts[0].action === 'exit-at-market') return out(q.currentStop, 'exit-at-market', 'lock-crossed', false);
  let stop = q.currentStop, by = null;
  for (const r of parts) if (r.action === 'place' && dir * r.stop > dir * stop + EPS) { stop = r.stop; by = r.reason; }
  if (stop !== q.currentStop) return out(stop, 'place', by, true);
  return parts.some(r => r.action === 'hold-current') ? out(stop, 'hold-current', null, false) : out(stop, 'none', null, null);
}

// ---------------------------------------------------------------- pyramid add (D'''', playbook §21): once per trade, after TP1, 1/3 of the ORIGINAL size
// p = { dir, runner: { entry (avg), contracts }, originalContracts, addPx, stop (the current protective stop), tp2, tp1Done, addsDone,
//       bias: { m15, m30, line }, control4h (the 4H control direction, or true), rejection (retest of a broken minor swing / 5m FVG + 1m rejection), cfg }
// -> { ok, qty, reason, code, combined: { contracts, avgEntry, atStopUsd } }. HOUSE MONEY: the combined position closed at the current stop >= 0.
function addQty(originalContracts) { return Number.isInteger(originalContracts) && originalContracts >= 1 ? Math.max(1, Math.round(originalContracts / 3)) : 0; }
function addAllowed(p) {
  const q = p || {}, { pv } = mkt(q.cfg), s = sizingOf(q.cfg), dir = q.dir, run = q.runner || {};
  const no = (reason, extra) => Object.freeze({ ok: false, qty: 0, reason, code: 'ADD_SKIP', ...(extra || {}) });
  if (!(dir === 1 || dir === -1) || !isNum(q.addPx) || !isNum(q.stop) || !isNum(run.entry) || !(Number.isInteger(run.contracts) && run.contracts >= 1)) return no('invalid-input');
  if (q.tp1Done !== true) return no('before-tp1');
  if (Number.isInteger(q.addsDone) && q.addsDone >= 1) return no('already-added');
  if (isNum(q.tp2) && dir * (q.addPx - q.tp2) >= -EPS) return no('tp2-reached');
  const ctl = q.control4h === true || q.control4h === dir;
  if (!ctl) return no('4h-control-changed');
  const b = q.bias || {}, line = isNum(b.line) ? b.line : null, sc = [b.m15, b.m30].filter(isNum);
  if (line === null || !sc.length || !sc.some(v => dir * v >= line - EPS) || sc.some(v => dir * v <= -line + EPS)) return no('bias-not-ours');
  if (q.rejection !== true) return no('no-rejection');
  if (!(dir * (q.addPx - q.stop) > 0)) return no('stop-not-behind-add');
  const qty = addQty(q.originalContracts);
  if (!(qty >= 1)) return no('invalid-original-size');
  if (run.contracts + qty > s.maxContracts) return no('max-contracts');
  const atStop = (run.contracts * dir * (q.stop - run.entry) + qty * dir * (q.stop - q.addPx)) * pv;
  const c = combine([{ price: run.entry, contracts: run.contracts }, { price: q.addPx, contracts: qty }]);
  const combined = { contracts: c.contracts, avgEntry: c.avgEntry, atStopUsd: r2(atStop), runnerLockedUsd: r2(run.contracts * dir * (q.stop - run.entry) * pv), addRiskUsd: r2(qty * dir * (q.addPx - q.stop) * pv) };
  if (!(atStop >= -EPS)) return no('not-house-money', { combined });
  return Object.freeze({ ok: true, qty, reason: 'house-money', code: 'ADD_OK', combined });
}

// The whole exit plan for a (combined) position. p = { dir, legs: [{ price, contracts }] | entry + contracts, stop, pools, partialPools?, grade }.
function planExits(p, cfg) {
  const q = p || {}, c = Array.isArray(q.legs) ? combine(q.legs) : { contracts: q.contracts, avgEntry: q.entry };
  if (!(c.contracts >= 1) || !isNum(c.avgEntry)) return null;
  const tp = targetFor(c.avgEntry, q.stop, q.dir, q.pools, q.grade, cfg); if (!tp) return null;
  const partial = partialFor({ entry: c.avgEntry, stop: q.stop, dir: q.dir, tp: tp.price, pools: q.partialPools || q.pools, contracts: c.contracts }, cfg);
  return Object.freeze({ version: VERSION, dir: q.dir, contracts: c.contracts, avgEntry: c.avgEntry, stop: q.stop, R: tp.R, tp, partial, beStop: beStopAfterPartial(c.avgEntry, q.dir, cfg), addQty: partial.contracts > 0 ? addQty(c.contracts) : 0,
    legs: { leg1: partial.contracts, leg2: partial.rest, runner: 0 } });   // FSM legs: leg1 = TP1 (partial.price), leg2 = the rest at TP2 (tp.price); the pyramid add joins leg2
}

// ---------------------------------------------------------------- journal, exemptions, config, startup
function entryRow(p, cfg) {
  const q = p || {}, z = sizeFor(q.stopPts, q.grade, cfg), s = sizingOf(cfg);
  const n = Number.isInteger(q.contracts) ? q.contracts : z.contracts, risk = r2(n * (isNum(q.stopPts) ? q.stopPts : 0) * mkt(cfg).pv);
  return { version: VERSION, mode: s.mode, grade: z.grade, stopPts: z.stopPts, contracts: n, sizedContracts: z.contracts, riskUsd: risk, budgetUsd: z.budgetUsd, gradeRiskUsd: z.gradeRiskUsd,
    overBudgetUsd: z.budgetUsd === null ? 0 : r2(Math.max(0, risk - z.budgetUsd)), sizeCode: z.code, maxContracts: s.maxContracts, entryByGrade: s.entryByGrade,
    shadow: shadowSize(q.stopPts, q.grade, cfg), scaleIn: q.scaleIn || null, exits: q.exits || null, exempt: EXEMPT, ...(z.nearFloor ? { nearFloor: z.nearFloor } : {}) };
}
// GRADE_NO_FIT (noFit 'skip') or NO_FIT_TAKE1 (noFit 'take1': the 1-lot is taken, overBudgetUsd logged). The code name is kept in both modes.
function noFitRow(p, cfg) { const q = p || {}, z = sizeFor(q.stopPts, q.grade, cfg); return { code: z.code === 'NO_FIT_TAKE1' ? 'NO_FIT_TAKE1' : 'GRADE_NO_FIT', version: VERSION, mode: z.mode, grade: z.grade, stopPts: z.stopPts, oneLotUsd: z.perContractUsd, budgetUsd: z.budgetUsd, gradeRiskUsd: z.gradeRiskUsd, maxFitPts: z.maxFitPts, overBudgetUsd: z.overBudgetUsd, shadow: shadowSize(q.stopPts, q.grade, cfg), stopTf: q.stopTf ?? null, stop: q.stop ?? null, entry: q.entry ?? null, ...(z.nearFloor ? { nearFloor: z.nearFloor } : {}) }; }
// The executor guards these entries are exempt from (D', §5): no timed / no-progress exit, no stop cap from the fill, no session stop floor.
const EXEMPT = Object.freeze({ noProgressExit: true, stopCapFromFill: true, sessionStopFloor: true });
function isMoneyEntry(signalContext) { return !!(signalContext && signalContext.money && ENTRY_VERSIONS.includes(signalContext.money.version)); }

function problem(cfg, ctx = null) {
  if (!cfg || typeof cfg !== 'object') return 'money config must be an object { sizing, exits }';
  const bad = findRefusedKey(cfg); if (bad) return `"${bad}" is refused: there is NO daily loss limit of any kind (Mac 11/04, playbook §17)`;
  for (const k of Object.keys(cfg)) if (!['sizing', 'exits', 'pointValue', 'tickSize', 'floorDistanceUsd'].includes(k)) return `unknown money key "${k}"`;   // floorDistanceUsd: runtime (r4.1)
  const s = cfg.sizing, e = cfg.exits;
  if (!s || typeof s !== 'object') return 'sizing must be an object { enabled, mode, flatDollars, gradeRiskUsd: { A, B, C }, maxContracts, noFit, entryByGrade, scaleInB, upgradeAdd: { enabled } }';
  for (const k of Object.keys(s)) if (!['enabled', 'mode', 'flatDollars', 'gradeRiskUsd', 'maxContracts', 'noFit', 'entryByGrade', 'scaleInB', 'scaleInA', 'upgradeAdd', 'nearFloor'].includes(k)) return `unknown sizing key "${k}"`;
  if (typeof s.enabled !== 'boolean') return `sizing.enabled must be true or false, got ${JSON.stringify(s.enabled)}`;
  if ('mode' in s && !SIZING_MODES.includes(s.mode)) return `sizing.mode must be 'flat' or 'grade', got ${JSON.stringify(s.mode)}`;
  if ('flatDollars' in s && !(isNum(s.flatDollars) && s.flatDollars >= RISK_MIN && s.flatDollars <= RISK_MAX)) return `sizing.flatDollars must be dollars from ${RISK_MIN} to ${RISK_MAX}, got ${JSON.stringify(s.flatDollars)}`;
  if ('noFit' in s && !NO_FIT_MODES.includes(s.noFit)) return `sizing.noFit must be 'skip' or 'take1', got ${JSON.stringify(s.noFit)}`;
  if ('entryByGrade' in s && typeof s.entryByGrade !== 'boolean') return `sizing.entryByGrade must be true or false, got ${JSON.stringify(s.entryByGrade)}`;
  if ('upgradeAdd' in s) {
    const u = s.upgradeAdd;
    if (!u || typeof u !== 'object' || Array.isArray(u)) return 'sizing.upgradeAdd must be an object { enabled }';
    for (const k of Object.keys(u)) if (k !== 'enabled') return `unknown sizing.upgradeAdd key "${k}"`;
    if (typeof u.enabled !== 'boolean') return `sizing.upgradeAdd.enabled must be true or false, got ${JSON.stringify(u.enabled)}`;
  }
  if ('nearFloor' in s) {   // r4.1: { enabled, cushionUsd, dollars }; absent keys take the defaults (the executor deep-merges over DEFAULTS)
    const n = s.nearFloor;
    if (!n || typeof n !== 'object' || Array.isArray(n)) return 'sizing.nearFloor must be an object { enabled, cushionUsd, dollars }';
    for (const k of Object.keys(n)) if (!['enabled', 'cushionUsd', 'dollars'].includes(k)) return `unknown sizing.nearFloor key "${k}"`;
    if ('enabled' in n && typeof n.enabled !== 'boolean') return `sizing.nearFloor.enabled must be true or false, got ${JSON.stringify(n.enabled)}`;
    if ('cushionUsd' in n && !(isNum(n.cushionUsd) && n.cushionUsd >= 100 && n.cushionUsd <= 100000)) return `sizing.nearFloor.cushionUsd must be dollars from 100 to 100000, got ${JSON.stringify(n.cushionUsd)}`;
    if ('dollars' in n && !(isNum(n.dollars) && n.dollars >= RISK_MIN && n.dollars <= RISK_MAX)) return `sizing.nearFloor.dollars must be dollars from ${RISK_MIN} to ${RISK_MAX}, got ${JSON.stringify(n.dollars)}`;
  }
  const g = s.gradeRiskUsd;
  if (!g || typeof g !== 'object') return 'sizing.gradeRiskUsd must be { A, B, C } dollars';
  for (const k of Object.keys(g)) if (!['A', 'B', 'C'].includes(k)) return `unknown sizing.gradeRiskUsd key "${k}" (A = A+, B, C)`;
  for (const k of ['A', 'B', 'C']) if (!(isNum(g[k]) && g[k] >= RISK_MIN && g[k] <= RISK_MAX)) return `sizing.gradeRiskUsd.${k} must be dollars from ${RISK_MIN} to ${RISK_MAX}, got ${JSON.stringify(g[k])}`;
  if (!(g.A >= g.B && g.B >= g.C)) return `sizing.gradeRiskUsd must step down A >= B >= C, got A ${g.A} / B ${g.B} / C ${g.C}`;
  if (!(Number.isInteger(s.maxContracts) && s.maxContracts >= 1 && s.maxContracts <= MAX_CONTRACTS_LIMIT)) return `sizing.maxContracts must be a whole number from 1 to ${MAX_CONTRACTS_LIMIT}, got ${JSON.stringify(s.maxContracts)}`;
  for (const k of ['scaleInB', 'scaleInA']) if (k in s && typeof s[k] !== 'boolean') return `sizing.${k} must be true or false, got ${JSON.stringify(s[k])}`;   // both optional; scaleInA (r2) is ignored
  if (!e || typeof e !== 'object') return 'exits must be an object { partialFrac, trailBufferPts, protect }';
  for (const k of Object.keys(e)) if (!['partialFrac', 'trailBufferPts', 'protect'].includes(k)) return `unknown exits key "${k}"`;
  if (!(isNum(e.partialFrac) && e.partialFrac >= 0.1 && e.partialFrac <= 0.9)) return `exits.partialFrac must be from 0.1 to 0.9, got ${JSON.stringify(e.partialFrac)}`;
  if (!(isNum(e.trailBufferPts) && e.trailBufferPts >= 0 && e.trailBufferPts <= 10)) return `exits.trailBufferPts must be points from 0 to 10, got ${JSON.stringify(e.trailBufferPts)}`;
  const pr = e.protect;
  if (!pr || typeof pr !== 'object') return 'exits.protect must be an object { enabled, startR, stepR, trailR, structural15m, climax, climaxVolMult }';
  for (const k of Object.keys(pr)) if (!['enabled', 'startR', 'stepR', 'trailR', 'structural15m', 'climax', 'climaxVolMult'].includes(k)) return `unknown exits.protect key "${k}"`;
  for (const k of ['enabled', 'structural15m', 'climax']) if (typeof pr[k] !== 'boolean') return `exits.protect.${k} must be true or false, got ${JSON.stringify(pr[k])}`;
  if (!(isNum(pr.startR) && pr.startR >= 0.5 && pr.startR <= 3)) return `exits.protect.startR must be from 0.5 to 3, got ${JSON.stringify(pr.startR)}`;
  if (!(isNum(pr.stepR) && pr.stepR >= 0.25 && pr.stepR <= 1)) return `exits.protect.stepR must be from 0.25 to 1, got ${JSON.stringify(pr.stepR)}`;
  if (!(isNum(pr.trailR) && pr.trailR >= 0.5 && pr.trailR <= 3)) return `exits.protect.trailR must be from 0.5 to 3, got ${JSON.stringify(pr.trailR)}`;
  if (!(isNum(pr.climaxVolMult) && pr.climaxVolMult >= 1 && pr.climaxVolMult <= 5)) return `exits.protect.climaxVolMult must be from 1 to 5, got ${JSON.stringify(pr.climaxVolMult)}`;
  if (!s.enabled || !ctx) return null;
  if (ctx.symbol != null && String(ctx.symbol).toUpperCase() !== 'MNQ') return `sizing on is MNQ only, this instance trades ${ctx.symbol}`;
  if (ctx.pointValue != null && ctx.pointValue !== 2) return `sizing on is MNQ only ($2/pt), got pointValue ${ctx.pointValue}`;
  if (ctx.minContracts === 3) return 'sizing on cannot go with minContracts 3 (grade sizing sizes down to 1 by the stop): set minContracts off or sizing off';
  return null;
}
function findRefusedKey(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return null;
  for (const k of Object.keys(o)) { if (NO_DAY_LIMIT_GUARD.test(k)) return k; const d = findRefusedKey(o[k], depth + 1); if (d) return d; }
  return null;
}
// Carries the mode used AND the shadow mode (logged only, never placed), the noFit rule, the entry style and the upgrade-add switch.
function startupLine(cfg) {
  const s = sizingOf(cfg), e = exitsOf(cfg), { pv } = mkt(cfg), g = s.gradeRiskUsd;
  if (!s.enabled) return '[sizing] off';
  const fits = usd => r2(usd / pv), gradeTxt = `A+ $${g.A} / B $${g.B} / C $${g.C}`;
  const head = s.mode === 'flat'
    ? `[sizing] mode flat: $${s.flatDollars} per trade, every grade (grades logged, not sized; shadow grade ${gradeTxt}, logged only) (MNQ $${pv}/pt, max ${s.maxContracts} contracts): 1 MNQ fits up to ${fits(s.flatDollars)} pts`
    : s.mode === 'grade'
      ? `[sizing] mode grade: ${gradeTxt} per trade (shadow flat $${s.flatDollars}, logged only) (MNQ $${pv}/pt, max ${s.maxContracts} contracts): 1 MNQ fits up to ${fits(g.A)} / ${fits(g.B)} / ${fits(g.C)} pts`
      : `[sizing] mode ${JSON.stringify(s.mode)} is INVALID: no trades`;
  const noFit = s.noFit === 'take1' ? 'wider = take 1 MNQ and log the dollars over budget' : 'wider = GRADE_NO_FIT skip';
  const entry = !s.entryByGrade ? 'every grade all at once at the trigger'
    : `A+ all at once, B ${s.scaleInB ? 'half at the trigger + half resting at the retest (cancelled at TP1 or invalidation)' : 'one entry'}, C one entry`;
  return `${head}, ${noFit} (the stop is never moved); entry: ${entry}` +
    `${cfg && cfg.sizing && 'scaleInA' in cfg.sizing ? ' (sizing.scaleInA is ignored since money-r3)' : ''}; grade-upgrade add ${s.upgradeAddEnabled ? 'on (B/C re-graded A+, before TP1, up to the A+ dollars at the same stop, resting half reserved)' : 'off'}; ` +
    (s.nearFloor.enabled ? `near-floor guard ON: within $${s.nearFloor.cushionUsd} of the trailing floor (or the distance unknown) every trade risks at most $${s.nearFloor.dollars}, both modes (a size cap; trades continue; NO daily loss limit); ` : '') +
    `exits: TP1 ${Math.round(e.partialFrac * 100)}% at the first pool (<= 1R) then break-even + 1 tick, one house-money add of 1/3 on a rejected pullback, TP2 everything at the pool >= 2R (A+ the major pool); ` +
    `protect ${e.protect.enabled ? `R-ladder (+${e.protect.startR}R BE, then lock best R - ${e.protect.trailR}R in ${e.protect.stepR}R steps)${e.protect.structural15m ? ', 15m swing after a major sweep' : ''}${e.protect.climax ? ', 5m swing on a climax' : ''}, placeable stops only (a crossed lock exits at market)` : 'off'}; stops only tighten; no timed exits; NO daily loss limit`;
}
// r4.1: one line with the sizing switches exactly as loaded, for set-tide-money.sh to confirm a switch. Printed whether sizing is on or off.
// Every token is ' key value;' so a check cannot match a prefix (flatDollars 45 vs 450).
function configLine(cfg) {
  const s = sizingOf(cfg), raw = (cfg && cfg.sizing) || {}, v = x => (typeof x === 'string' ? x : JSON.stringify(x));
  return `[money] config ${VERSION}: mode ${v(s.mode)}; flatDollars ${v(s.flatDollars)}; noFit ${v(raw.noFit === undefined ? DEFAULTS.sizing.noFit : raw.noFit)}; nearFloor ${s.nearFloor.enabled ? 'on' : 'off'};` +
    ` cushionUsd ${s.nearFloor.cushionUsd}; nearFloorDollars ${s.nearFloor.dollars}; entryByGrade ${s.entryByGrade}; upgradeAdd ${s.upgradeAddEnabled}; sizing.enabled ${s.enabled};`;
}

module.exports = { VERSION, ENTRY_VERSIONS, DEFAULTS, withRiskMult, MIN_RR, EXEMPT, PLACE_BUFFER_TICKS, gradeKey, gradeOf, sizeFor, levelStopTf, chooseStop, shadowSize, scaleInPlan, secondLeg, restingCancel, upgradeAdd, combine,
  targetFor, partialFor, beStopAfterPartial, stopOnlyInFavour, protectStop, structuralTrail, isClimax, climaxTighten, nextStop, addQty, addAllowed, planExits, entryRow, noFitRow, isMoneyEntry, problem, startupLine, configLine, roundTick };
