'use strict';
// MONEY RULE r3 (lv1 new model): Candace's SIZE style and profit-taking style on OUR structural stops. MNQ only. PURE: no I/O, no requires, no clock, no state.
//   Playbook §5 (stops: structure, option C, never tightened to fit), §11 (stops only move in the trade's favour, no timed exits),
//   §16/§17 (size by grade dollars), §18 (Candace's exits), §22 (how each grade enters + the grade-upgrade add), SPEC-TIDE-r2 D' (sizing), D'' (exits),
//   D''' (protection), D'''' (2/3 partial + pyramid) and D5 (entry by grade + grade-upgrade add; supersedes D' "scale-in on A+ only").
//   NO daily loss limit of any kind (Mac 11/04: "No daily loss limit! Don't forget that!"): nothing here counts losses, trades or days.
//
// cfg = { sizing: { enabled, gradeRiskUsd: { A, B, C }, maxContracts, scaleInB }, exits: { partialFrac, trailBufferPts, protect }, pointValue?, tickSize? }
//   (pointValue 2 = MNQ, tickSize 0.25 by default; the executor passes its own. sizing.scaleInA is the r2 key: still accepted, ignored, A+ is all at once.)
// SIZE   sizeFor(stopPts, grade, cfg)       contracts = min(maxContracts, floor(gradeRiskUsd[grade] / (stopPts x $2))); 0 = GRADE_NO_FIT. The stop is never moved.
//        chooseStop(cands, grade, cfg, o)   option C: 4H-type level / trap -> the 4H wick, hour-type -> the 1H wick. No fallback to a tighter wick.
// ENTRY  (D5, §22) scaleInPlan / secondLeg  A+ ALL AT ONCE; B half (rounded up) at the trigger + the rest resting at the retest/FVG, same stop,
//        combined risk <= the B dollars; C one entry. restingCancel: the resting B half is cancelled at TP1, on invalidation or when the trade closes.
//        upgradeAdd: a B or C trade re-graded A+ while open, BEFORE TP1, ONCE: top the total risk up to the A+ dollars at the SAME stop
//        (a resting B half is cancelled and merged into it first). Journal GRADE_UPGRADE / GRADE_UPGRADE_SKIP. After TP1 the pyramid is the only add.
// EXITS  targetFor   TP = nearest pool at/beyond 2R (A+: the next MAJOR pool beyond 2R; else the nearest pool beyond 2R; none -> 2R exactly).
//        partialFor  TP1 at the first internal pool between entry and TP, no farther than 1R (none -> 1R): 2/3 of the position (round to nearest; 3 -> 2).
//        beStopAfterPartial  entry +/- 1 tick toward profit. TP2 = targetFor: everything left (runner + add) exits there.
// PROTECT (D''', playbook §20; all only tighten): protectStop = the R-ladder (+1R BE+1 tick, +1.5R lock 0.5R, +2R lock 1R, then best R - 1R in 0.5R steps);
//        structuralTrail = behind the last confirmed 15m swing once a MAJOR pool in our favour is swept; climaxTighten = behind the last 5m swing on a climax
//        in our favour (isClimax). Minor 1m/5m swings never move the stop (D''' supersedes the D'' minor-swing trail). nextStop combines them.
// PYRAMID (D'''', §21): addAllowed = once, after TP1, 1/3 of the original size on a rejected pullback, trend still ours, HOUSE MONEY only.
const VERSION = 'money-r3';
const ENTRY_VERSIONS = Object.freeze(['money-r2', 'money-r3']);   // isMoneyEntry: an r2 trade restored across the upgrade keeps its graded behaviour
const DEFAULTS = Object.freeze({
  sizing: Object.freeze({ enabled: false, gradeRiskUsd: Object.freeze({ A: 900, B: 600, C: 300 }), maxContracts: 30, scaleInB: true }),   // 150K values (Mac 11/04); D5: B scales in
  exits: Object.freeze({ partialFrac: 2 / 3, trailBufferPts: 2,   // Mac 11/04: "2 out of 3"; the swing buffer = the level-event STOP_BUF
    protect: Object.freeze({ enabled: true, startR: 1, stepR: 0.5, trailR: 1, structural15m: true, climax: true, climaxVolMult: 2 }) }),
});
const MIN_RR = 2;                // §18.1: bracket at a minimum 1:2
const RISK_MIN = 50, RISK_MAX = 2000, MAX_CONTRACTS_LIMIT = 150;
const EPS = 1e-9;
// Config keys that name a day / daily limit are refused outright (§17: no daily loss limit, not as dollars, not as a trade count).
const NO_DAY_LIMIT_GUARD = /day|daily|session.?loss|loss.?limit|max.?loss|full.?stops/i;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const r2 = x => Math.round(x * 100) / 100;
function mkt(cfg) { const c = cfg || {}; return { pv: isNum(c.pointValue) && c.pointValue > 0 ? c.pointValue : 2, tick: isNum(c.tickSize) && c.tickSize > 0 ? c.tickSize : 0.25 }; }
function sizingOf(cfg) { const s = (cfg && cfg.sizing) || {}; const d = DEFAULTS.sizing; return { enabled: s.enabled === true, gradeRiskUsd: { ...d.gradeRiskUsd, ...(s.gradeRiskUsd || {}) }, maxContracts: isNum(s.maxContracts) ? s.maxContracts : d.maxContracts, scaleInB: typeof s.scaleInB === 'boolean' ? s.scaleInB : d.scaleInB }; }
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
// Grade in Mac's terms (§17, D'): A+ = all four; B = one missing; C = two missing (still a valid §C trigger); more missing / no trigger = no trade.
const GRADE_PARTS = Object.freeze(['control4h', 'trapAtPool', 'displacementShift', 'firstRetest']);
function gradeOf(ev) {
  const e = ev || {}, missing = GRADE_PARTS.filter(k => e[k] !== true);
  if (e.validTrigger === false) return Object.freeze({ grade: null, missing, reason: 'GRADE_NO_TRIGGER' });
  const grade = missing.length === 0 ? 'A+' : missing.length === 1 ? 'B' : missing.length === 2 ? 'C' : null;
  return Object.freeze({ grade, missing, reason: grade ? 'graded' : 'GRADE_NONE' });
}

// ---------------------------------------------------------------- size
function sizeFor(stopPts, grade, cfg) {
  const s = sizingOf(cfg), { pv } = mkt(cfg), k = gradeKey(grade);
  const base = { version: VERSION, grade: k ? gradeLabel(k) : null, stopPts: isNum(stopPts) ? r2(stopPts) : null };
  if (!k) return Object.freeze({ ...base, contracts: 0, riskUsd: 0, gradeRiskUsd: null, perContractUsd: null, maxFitPts: null, reason: 'invalid-grade', code: 'GRADE_INVALID' });
  const usd = s.gradeRiskUsd[k];
  if (!(isNum(stopPts) && stopPts > 0)) return Object.freeze({ ...base, contracts: 0, riskUsd: 0, gradeRiskUsd: usd, perContractUsd: null, maxFitPts: r2(usd / pv), reason: 'invalid-stop', code: 'GRADE_INVALID' });
  const per = stopPts * pv, fit = Math.floor(usd / per + EPS), contracts = Math.max(0, Math.min(s.maxContracts, fit));
  return Object.freeze({ ...base, contracts, riskUsd: r2(contracts * per), gradeRiskUsd: usd, perContractUsd: r2(per), maxFitPts: r2(usd / pv), maxContracts: s.maxContracts,
    reason: contracts === 0 ? 'grade-no-fit' : fit > s.maxContracts ? 'grade-max-contracts' : 'grade-fit', code: contracts === 0 ? 'GRADE_NO_FIT' : null });
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
// resting order is wired). style = 'all-at-once' | 'scale-in' | 'one-entry'.
function scaleInPlan(stopPts, grade, cfg) {
  const z = sizeFor(stopPts, grade, cfg), s = sizingOf(cfg), k = gradeKey(grade);
  const split = k === 'B' && s.scaleInB && z.contracts >= 2;
  const first = split ? Math.ceil(z.contracts / 2) : z.contracts;
  return Object.freeze({ version: VERSION, grade: z.grade, stopPts: z.stopPts, total: z.contracts, first, second: z.contracts - first, scaleIn: split,
    style: k === 'A' ? 'all-at-once' : split ? 'scale-in' : 'one-entry', gradeRiskUsd: z.gradeRiskUsd, reason: z.reason, code: z.code });
}
// The resting B half once the first half is filled: same structural stop PRICE, at most the planned rest, combined risk <= the B dollars.
// p = { dir, stop, firstFill, firstContracts, entry2, plannedSecond, grade? }. grade defaults to 'B' (the only grade that scales in);
// A+ / C (or scaleInB false) -> contracts 0, reason 'no-scale-in'.
function secondLeg(p, cfg) {
  const { pv } = mkt(cfg), s = sizingOf(cfg), q = p || {}, k = q.grade == null ? 'B' : gradeKey(q.grade);
  if (k !== 'B' || !s.scaleInB) return Object.freeze({ contracts: 0, grade: k ? gradeLabel(k) : null, reason: 'no-scale-in' });
  const usd = s.gradeRiskUsd.B;
  const ok = (q.dir === 1 || q.dir === -1) && isNum(q.stop) && isNum(q.firstFill) && isNum(q.entry2) && Number.isInteger(q.firstContracts) && q.firstContracts >= 1 && Number.isInteger(q.plannedSecond);
  if (!ok) return Object.freeze({ contracts: 0, grade: 'B', reason: 'invalid-input' });
  const r1 = q.dir * (q.firstFill - q.stop), rB = q.dir * (q.entry2 - q.stop);
  if (!(r1 > 0) || !(rB > 0)) return Object.freeze({ contracts: 0, grade: 'B', reason: 'stop-not-behind-entry' });
  const firstRisk = q.firstContracts * r1 * pv, left = usd - firstRisk;
  const fit = left > 0 ? Math.floor(left / (rB * pv) + EPS) : 0;
  const contracts = Math.max(0, Math.min(q.plannedSecond, fit, s.maxContracts - q.firstContracts));
  return Object.freeze({ contracts, grade: 'B', stop: q.stop, entry2: q.entry2, firstRiskUsd: r2(firstRisk), secondRiskUsd: r2(contracts * rB * pv), combinedRiskUsd: r2(firstRisk + contracts * rB * pv), gradeRiskUsd: usd,
    reason: contracts === 0 ? 'no-room' : contracts < q.plannedSecond ? 'sized-down' : 'as-planned' });
}
// Should the resting B half be cancelled now? p = { dir, bestPx (best 1m high/low since the first fill), tp1Px (the plan's TP1 price), tp1Done,
// invalidated (TIDE: the setup is invalid or its retest window ended), closed (the position is flat: stop or any exit) }.
// -> { cancel, reason: 'tp1-reached' | 'invalidated' | 'position-closed' | 'keep' | 'invalid-input' (fails closed: cancel) }.
function restingCancel(p) {
  const q = p || {}, dir = q.dir, out = (cancel, reason) => Object.freeze({ cancel, reason });
  if (!(dir === 1 || dir === -1)) return out(true, 'invalid-input');
  if (q.closed === true) return out(true, 'position-closed');
  if (q.tp1Done === true || (isNum(q.bestPx) && isNum(q.tp1Px) && dir * (q.bestPx - q.tp1Px) >= -EPS)) return out(true, 'tp1-reached');
  if (q.invalidated === true) return out(true, 'invalidated');
  return out(false, 'keep');
}
// GRADE-UPGRADE ADD (D5, §22): a B or C trade that re-grades A+ while open, BEFORE TP1, ONCE per trade, adds on the next rejected pullback the
// contracts that bring the total risk up to the A+ dollars at the SAME (current, one) protective stop. The stop is never moved to fit.
// p = { grade (the trade's grade), newGrade (the live re-grade), openQty, entry (avg entry of the open contracts), stop (the ONE protective stop), dir,
//       restingQty (an unfilled B half), tp1Done, upgradedBefore, addPx? (the pullback price; default entry), structuralStop? (the stop the trade
//       was sized at; default stop), oldPoints?, newPoints?, cfg }
// -> { ok, qty, reason, code: GRADE_UPGRADE | GRADE_UPGRADE_SKIP, cancelRestingQty, worstAddPx, risk: { openUsd, addUsd, totalUsd, gradeRiskUsd },
//      combined: { contracts, avgEntry }, row }. A resting B half is CANCELLED first and merged into qty (its risk is not counted: it never fills).
//   The SAME structural stop: a stop that protection already moved (it differs from structuralStop, or sits at/past the entry) refuses the upgrade
//   ('stop-moved'): sizing the add to a tightened stop would buy more contracts than the A+ dollars allow at the structure.
//   worstAddPx = the worst add fill that keeps the total <= the A dollars at this qty (use it as the add's limit price; slippage past it is extra).
function upgradeAdd(p) {
  const q = p || {}, { pv, tick } = mkt(q.cfg), s = sizingOf(q.cfg), dir = q.dir, k = gradeKey(q.grade), nk = gradeKey(q.newGrade), A = s.gradeRiskUsd.A;
  const resting = Number.isInteger(q.restingQty) && q.restingQty > 0 ? q.restingQty : 0, addPx = isNum(q.addPx) ? q.addPx : q.entry;
  const res = (ok, qty, reason, x = {}) => {
    const risk = x.risk || null, cancelRestingQty = ok ? resting : 0, worstAddPx = x.worstAddPx ?? null, code = ok ? 'GRADE_UPGRADE' : 'GRADE_UPGRADE_SKIP';
    const row = { code, version: VERSION, from: k ? gradeLabel(k) : null, to: nk ? gradeLabel(nk) : null, reason, oldPoints: q.oldPoints ?? null, newPoints: q.newPoints ?? null,
      dir: dir ?? null, openQty: q.openQty ?? null, entry: q.entry ?? null, stop: q.stop ?? null, addPx: isNum(addPx) ? addPx : null, qty, worstAddPx, cancelRestingQty, restingQty: resting,
      openRiskUsd: risk ? risk.openUsd : null, addRiskUsd: risk ? risk.addUsd : null, totalRiskUsd: risk ? risk.totalUsd : null, gradeRiskUsd: A };
    return Object.freeze({ ok, qty, reason, code, cancelRestingQty, worstAddPx, risk, combined: x.combined || null, row: Object.freeze(row) });
  };
  if (!(dir === 1 || dir === -1) || !isNum(q.entry) || !isNum(q.stop) || !isNum(addPx) || !(Number.isInteger(q.openQty) && q.openQty >= 1)) return res(false, 0, 'invalid-input');
  if (k !== 'B' && k !== 'C') return res(false, 0, 'not-b-or-c');
  if (nk !== 'A') return res(false, 0, 'not-a-plus');
  if (q.tp1Done === true) return res(false, 0, 'after-tp1');
  if (q.upgradedBefore === true) return res(false, 0, 'already-upgraded');
  const openUsd = q.openQty * dir * (q.entry - q.stop) * pv;
  if ((isNum(q.structuralStop) && Math.abs(q.stop - q.structuralStop) > EPS) || !(openUsd > 0)) return res(false, 0, 'stop-moved');
  const per = dir * (addPx - q.stop) * pv;
  if (!(per > 0)) return res(false, 0, 'stop-not-behind-add');
  const budget = A - openUsd;
  const fit = budget > 0 ? Math.floor(budget / per + EPS) : 0, room = s.maxContracts - q.openQty, qty = Math.max(0, Math.min(fit, room));
  if (qty < 1) return res(false, 0, fit >= 1 ? 'max-contracts' : 'no-room', { risk: { openUsd: r2(openUsd), addUsd: 0, totalUsd: r2(openUsd), gradeRiskUsd: A } });
  const risk = { openUsd: r2(openUsd), addUsd: r2(qty * per), totalUsd: r2(openUsd + qty * per), gradeRiskUsd: A };
  const worstAddPx = towardLoss(q.stop + dir * budget / (qty * pv), dir, tick);
  return res(true, qty, resting ? 'merged-resting' : 'top-up', { risk, worstAddPx, combined: combine([{ price: q.entry, contracts: q.openQty }, { price: addPx, contracts: qty }]) });
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
//   A lock > 0 rounds toward profit (a trade that touched +2R closes >= +1R); lock 0 = beStopAfterPartial (a trade that touched +1R cannot close red).
function protectStop(p) {
  const q = p || {}, { tick } = mkt(q.cfg), pr = exitsOf(q.cfg).protect, dir = q.dir;
  const keep = (why, extra) => Object.freeze({ stop: q.currentStop, moved: false, reason: why, ...(extra || {}) });
  if (!(dir === 1 || dir === -1) || !isNum(q.entry) || !(isNum(q.R) && q.R > 0)) return keep('invalid-input');
  if (pr.enabled !== true) return keep('protect-off');
  const bestR = isNum(q.bestPx) ? dir * (q.bestPx - q.entry) / q.R : null;
  if (bestR === null || !(bestR >= pr.startR - EPS)) return keep('below-start', { bestR: bestR === null ? null : r2(bestR) });
  const lockR = Math.max(0, Math.floor(bestR / pr.stepR + EPS) * pr.stepR - pr.trailR);
  const want = lockR > 0 ? towardProfit(q.entry + dir * lockR * q.R, dir, tick) : beStopAfterPartial(q.entry, dir, q.cfg);
  const stop = stopOnlyInFavour(q.currentStop, want, dir);
  return Object.freeze({ stop, moved: stop !== q.currentStop, reason: stop !== q.currentStop ? 'ladder' : 'not-in-favour', lockR: r2(lockR), bestR: r2(bestR), ladderStop: want });
}
// Structural trail on the 15m: once a MAJOR pool in our favour has been swept (majorSwept true), the stop may move behind the last confirmed 15m swing
// on the protective side (a swing HIGH for a short, a LOW for a long) +/- trailBufferPts, if tighter. swings15m = [{ type: 'H' | 'L', price, t }], confirmed only.
// Minor 1m/5m swings never move the stop (D''': room for the runner through bounces like 11/04 16:45).
function structuralTrail(p) {
  const q = p || {}, { tick } = mkt(q.cfg), e = exitsOf(q.cfg), dir = q.dir;
  if (!(dir === 1 || dir === -1)) return Object.freeze({ stop: q.currentStop, moved: false, reason: 'invalid-dir' });
  if (e.protect.enabled !== true || e.protect.structural15m !== true) return Object.freeze({ stop: q.currentStop, moved: false, reason: 'off' });
  if (q.majorSwept !== true) return Object.freeze({ stop: q.currentStop, moved: false, reason: 'no-major-sweep' });
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
// On a climax in our favour: lock behind the last 5m swing (protective side) +/- trailBufferPts, if tighter.
function climaxTighten(p) {
  const q = p || {}, { tick } = mkt(q.cfg), e = exitsOf(q.cfg), dir = q.dir;
  if (!(dir === 1 || dir === -1)) return Object.freeze({ stop: q.currentStop, moved: false, reason: 'invalid-dir' });
  if (e.protect.enabled !== true || e.protect.climax !== true) return Object.freeze({ stop: q.currentStop, moved: false, reason: 'off' });
  if (q.climax !== true) return Object.freeze({ stop: q.currentStop, moved: false, reason: 'no-climax' });
  return behindSwing(q.currentStop, q.swings5m, dir, e.trailBufferPts, tick, q.lastPx, 'climax-5m');
}
function behindSwing(currentStop, swings, dir, buf, tick, lastPx, why) {
  const back = dir === 1 ? 'L' : 'H';
  const S = (Array.isArray(swings) ? swings : []).filter(s => s && s.type === back && isNum(s.price) && isNum(s.t)).sort((a, b) => a.t - b.t);
  const sw = S[S.length - 1];
  if (!sw) return Object.freeze({ stop: currentStop, moved: false, reason: 'no-swing' });
  const want = towardLoss(sw.price - dir * buf, dir, tick);
  if (isNum(lastPx) && !(dir * want < dir * lastPx - EPS)) return Object.freeze({ stop: currentStop, moved: false, reason: 'at-market', want });
  const stop = stopOnlyInFavour(currentStop, want, dir);
  return Object.freeze({ stop, moved: stop !== currentStop, reason: stop !== currentStop ? why : 'not-in-favour', want, swing: { price: sw.price, t: sw.t } });
}
// One poll: the tightest of the current stop, the R-ladder, the 15m structural trail and the climax lock (inputs = the union of the three).
function nextStop(p) {
  const q = p || {}, dir = q.dir, parts = [protectStop(q), structuralTrail(q), climaxTighten(q)];
  let stop = q.currentStop, by = null;
  for (const r of parts) { const s = stopOnlyInFavour(stop, r.stop, dir); if (s !== stop) { stop = s; by = r.reason; } }
  return Object.freeze({ stop, moved: stop !== q.currentStop, by, ladder: parts[0], structural: parts[1], climax: parts[2] });
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
  return { version: VERSION, grade: z.grade, stopPts: z.stopPts, contracts: Number.isInteger(q.contracts) ? q.contracts : z.contracts, sizedContracts: z.contracts,
    riskUsd: r2((Number.isInteger(q.contracts) ? q.contracts : z.contracts) * (isNum(q.stopPts) ? q.stopPts : 0) * mkt(cfg).pv), gradeRiskUsd: z.gradeRiskUsd, maxContracts: s.maxContracts,
    scaleIn: q.scaleIn || null, exits: q.exits || null, exempt: EXEMPT };
}
function noFitRow(p, cfg) { const q = p || {}, z = sizeFor(q.stopPts, q.grade, cfg); return { code: 'GRADE_NO_FIT', version: VERSION, grade: z.grade, stopPts: z.stopPts, oneLotUsd: z.perContractUsd, gradeRiskUsd: z.gradeRiskUsd, maxFitPts: z.maxFitPts, stopTf: q.stopTf ?? null, stop: q.stop ?? null, entry: q.entry ?? null }; }
// The executor guards these entries are exempt from (D', §5): no timed / no-progress exit, no stop cap from the fill, no session stop floor.
const EXEMPT = Object.freeze({ noProgressExit: true, stopCapFromFill: true, sessionStopFloor: true });
function isMoneyEntry(signalContext) { return !!(signalContext && signalContext.money && ENTRY_VERSIONS.includes(signalContext.money.version)); }

function problem(cfg, ctx = null) {
  if (!cfg || typeof cfg !== 'object') return 'money config must be an object { sizing, exits }';
  const bad = findRefusedKey(cfg); if (bad) return `"${bad}" is refused: there is NO daily loss limit of any kind (Mac 11/04, playbook §17)`;
  for (const k of Object.keys(cfg)) if (!['sizing', 'exits', 'pointValue', 'tickSize'].includes(k)) return `unknown money key "${k}"`;
  const s = cfg.sizing, e = cfg.exits;
  if (!s || typeof s !== 'object') return 'sizing must be an object { enabled, gradeRiskUsd: { A, B, C }, maxContracts, scaleInB }';
  for (const k of Object.keys(s)) if (!['enabled', 'gradeRiskUsd', 'maxContracts', 'scaleInB', 'scaleInA'].includes(k)) return `unknown sizing key "${k}"`;
  if (typeof s.enabled !== 'boolean') return `sizing.enabled must be true or false, got ${JSON.stringify(s.enabled)}`;
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
function startupLine(cfg) {
  const s = sizingOf(cfg), e = exitsOf(cfg), { pv } = mkt(cfg), g = s.gradeRiskUsd;
  if (!s.enabled) return '[sizing] off';
  return `[sizing] grade dollars per trade A+ $${g.A} / B $${g.B} / C $${g.C} (MNQ $${pv}/pt, max ${s.maxContracts} contracts): 1 MNQ fits up to ${r2(g.A / pv)} / ${r2(g.B / pv)} / ${r2(g.C / pv)} pts, wider = GRADE_NO_FIT (the stop is never moved); ` +
    `entry: A+ all at once, B ${s.scaleInB ? 'half at the trigger + half resting at the retest (cancelled at TP1 or invalidation)' : 'one entry'}, C one entry` +
    `${cfg && cfg.sizing && 'scaleInA' in cfg.sizing ? ' (sizing.scaleInA is ignored since money-r3)' : ''}; one grade-upgrade add (B/C re-graded A+, before TP1) up to the A+ dollars at the same stop; exits: TP1 ${Math.round(e.partialFrac * 100)}% at the first pool (<= 1R) then break-even + 1 tick, one house-money add of 1/3 on a rejected pullback, TP2 everything at the pool >= 2R (A+ the major pool); ` +
    `protect ${e.protect.enabled ? `R-ladder (+${e.protect.startR}R BE, then lock best R - ${e.protect.trailR}R in ${e.protect.stepR}R steps)${e.protect.structural15m ? ', 15m swing after a major sweep' : ''}${e.protect.climax ? ', 5m swing on a climax' : ''}` : 'off'}; stops only tighten; no timed exits; NO daily loss limit`;
}

module.exports = { VERSION, ENTRY_VERSIONS, DEFAULTS, MIN_RR, EXEMPT, GRADE_PARTS, gradeKey, gradeOf, sizeFor, levelStopTf, chooseStop, scaleInPlan, secondLeg, restingCancel, upgradeAdd, combine,
  targetFor, partialFor, beStopAfterPartial, stopOnlyInFavour, protectStop, structuralTrail, isClimax, climaxTighten, nextStop, addQty, addAllowed, planExits, entryRow, noFitRow, isMoneyEntry, problem, startupLine, roundTick };
