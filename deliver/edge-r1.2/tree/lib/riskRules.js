// 10/18 package (owner order 10/15: "implement now, backtest later"). Pure risk rules shared by live-executor.js (LIVE and PAPER), lib/liveStateMachine.js and the
// tests. No I/O, no requires. Every rule has a one-line off switch in CONFIG (see live-executor.js) and a set-*.sh script.
//
// RULE 1  $ RISK CAP BY SIZING DOWN (CONFIG.maxRiskPerTradeUsd, 250). The structural stop is NOT moved: the size is cut instead.
//   contracts = floor(maxRiskUsd / ((stopPts + slipPts) x pointValue)), capped at maxContracts (5). 0 = even 1 contract would risk more than the cap -> the trade
//   is SKIPPED (journal RISK_CAP_SKIP). slipPts = CONFIG.riskSizingSlipPts (shipped 0: the fill-slippage guard shifts the stop with every ADVERSE entry slip, so an
//   entry slip never adds risk; a favourable slip beyond the guard keeps the original stop = LESS risk. Exit slippage on the stop itself is not modelled anywhere).
function sizeForRisk({ stopPts, maxRiskUsd, pointValue = 2, maxContracts = 5, slipPts = 0 }) {
  const eff = Number(stopPts) + (Number.isFinite(slipPts) && slipPts > 0 ? slipPts : 0);
  if (!(eff > 0) || !(maxRiskUsd > 0) || !(pointValue > 0)) return { contracts: 0, skip: true, perContractUsd: null, riskUsd: null, effPts: eff, why: 'bad input' };
  const per = eff * pointValue;
  const n = Math.floor(maxRiskUsd / per + 1e-9);
  if (n < 1) return { contracts: 0, skip: true, perContractUsd: round2(per), riskUsd: round2(per), effPts: eff, why: `1 contract = $${round2(per)} > $${maxRiskUsd}` };
  const c = Math.max(1, Math.min(Math.floor(maxContracts) || 1, n));
  return { contracts: c, skip: false, perContractUsd: round2(per), riskUsd: round2(per * c), effPts: eff, why: null };
}
// the widest stop (points) that still allows 1 contract
function maxStopPtsForOneLot(maxRiskUsd, pointValue = 2, slipPts = 0) { return Math.floor((maxRiskUsd / pointValue - (slipPts > 0 ? slipPts : 0)) * 100) / 100; }

// RULE 2  LEG SPLIT AT ANY SIZE. leg1 = first scale (TP1), leg2 = TP2, runner = the rest (trails).
//   1 -> 1/0/0 (the whole trade exits at the first scale); 2 -> 1/0/1 (no TP2 leg: 1 at the first scale, 1 runner); 3 -> 1/1/1; 4 -> 2/1/1; 5 -> 2/1/2 (= today).
//   3..baseContracts: leg1 = max(1, round(40% x size)), leg2 = 1, runner = rest. Above baseContracts (not reachable while maxContracts = 5) the old grade formula.
function legSplit(n, { baseContracts = 5, baseLeg1Extra = 1, gradeLeg1Extra = 3, gradeLeg2Extra = 2, scaleOutRunner = null } = {}) {
  n = Math.floor(n);
  if (!(n > 0)) return { leg1: 0, leg2: 0, runner: 0 };
  if (n === 1) return { leg1: 1, leg2: 0, runner: 0 };
  if (scaleOutRunner && scaleOutRunner.enabled === true) return { leg1: n - 1, leg2: 0, runner: 1 };   // so1 (Mac 10/22): all but 1 out at the scale, 1 runner
  if (n === 2) return { leg1: 1, leg2: 0, runner: 1 };
  if (n <= baseContracts) { const l1 = Math.max(1, Math.min(n - 2, Math.round(0.4 * n))); return { leg1: l1, leg2: 1, runner: n - l1 - 1 }; }
  const extra = n - baseContracts;
  const l1 = Math.max(1, Math.min(1 + baseLeg1Extra + Math.min(extra, gradeLeg1Extra), n - 1));
  const l2 = Math.max(0, Math.min(1 + Math.min(Math.max(0, extra - gradeLeg1Extra), gradeLeg2Extra), n - l1 - 1));
  return { leg1: l1, leg2: l2, runner: n - l1 - l2 };
}

// TP1 / TP2 distances. firstScalePts (20) on: TP1 = entry +/- 20 pts at every size. Off (null): the old dollar goal / (leg1 contracts x $/pt), with the leg1 count never
// below the 5-lot's leg1 (2), so a small size keeps the normal distance and simply banks less (before, a 1-lot would have needed a 4x farther TP1).
// TP2 always keeps TODAY's distance basis (the 5-lot TP1 distance x the multiple, or the structural / Asia target), so "leg2 keeps TP2" holds at every size.
function target1Points({ firstScalePts = null, goalUsd, leg1Size, baseLeg1 = 2, pointValue = 2 }) {
  if (Number.isFinite(firstScalePts) && firstScalePts > 0) return firstScalePts;
  return goalUsd / (Math.max(leg1Size || 1, baseLeg1) * pointValue);
}
function legacyTarget1Points({ goalUsd, baseLeg1 = 2, pointValue = 2 }) { return goalUsd / (baseLeg1 * pointValue); }

// RULE 3  L3 PROFIT LOCK IN POINTS (CONFIG.profitLockUnit 'points'). Today's L3 on a 5-lot ($200 arm / $150 lock / $50 step) = 20 / 15 / 5 points.
// peakPts = best favourable excursion since entry. Returns null (not armed) or { stage, lockPts } (lockPts from entry, never at or past the peak itself).
function profitLockPoints(peakPts, { armPts = 20, lockPts = 15, stepPts = 5, bePts = null } = {}, tick = 0.25) {
  if (!Number.isFinite(peakPts)) return null;
  let stage = null, lk = 0;
  if (Number.isFinite(armPts) && peakPts >= armPts) { lk = (lockPts || 0) + (stepPts > 0 ? Math.floor((peakPts - armPts) / stepPts + 1e-9) * stepPts : 0); stage = 'LOCK'; }
  else if (Number.isFinite(bePts) && bePts != null && peakPts >= bePts) { lk = 0; stage = 'BE'; }
  if (!stage) return null;
  return { stage, lockPts: Math.max(0, Math.min(lk, peakPts - tick)) };
}

function round2(x) { return Math.round(x * 100) / 100; }
// so1 (Mac 10/22) RUNNER TRAIL: after the scale-out the runner's stop is +lockPts (10) from entry, then it trails lockPts behind the best price in stepPts (10) steps:
// peak +20 -> +10, +30 -> +20, +40 -> +30. peakPts = best favourable excursion in points. Returns the stop offset from entry in points (never below lockPts).
function runnerTrailOffset(peakPts, { lockPts = 10, stepPts = 10 } = {}) {
  const p = Number.isFinite(peakPts) ? peakPts : 0;
  return Math.max(lockPts, Math.floor(p / stepPts + 1e-9) * stepPts - lockPts);
}
module.exports = { sizeForRisk, maxStopPtsForOneLot, legSplit, target1Points, legacyTarget1Points, profitLockPoints, runnerTrailOffset };
