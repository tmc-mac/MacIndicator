const { capStop, resolveIntrabar, findCrossPrice, inNyOpenBlackout, inAsiaBlackout } = require('./simulate');
const { ptInfo } = require('./helpers');

// 3-contract version of the shave-and-trail plan, matching what you actually
// described wanting from the start: "shave 2/3 of the position if I have 3
// cons on" — leg 1 takes the fixed math-based target, leg 2 takes the
// institutional-level (structural) target, and leg 3 rides the trail with no
// fixed target at all. This is a NEW file rather than a rewrite of
// simulate.js's 2-leg path specifically so the already-validated
// $151.59/day, -$180 worst-day 2-leg result stays untouched and comparable
// side-by-side — this is a real, untested lever, not a replacement.
//
//   Leg 1 (1 contract): fixed $ target (target1DollarGoal), stop capped at
//     leg1StopCapMultiple x that target's distance. Exactly the leg-1 rule
//     already validated in simulate.js.
//   Leg 2 (1 contract): once leg 1 closes, stop moves to breakeven. Targets
//     Levels PRO's own structural target (lv.plan.target) when a plan in the
//     trade's direction exists and that target is actually further out than
//     leg 1's — "target 2 can be the institutional levels," per your own
//     words. Falls back to target1Points x target2Multiple (default 2.5) when
//     there's no usable structural target (e.g. a mac-only signal).
//   Leg 3 (1 contract): once leg 1 closes, stop moves to breakeven and then
//     TRAILS through cleared institutional levels exactly like the old leg 2
//     did — no fixed target, rides until the trail or a timeout closes it.
//
// If the initial risk stop (pre-leg-1) is hit, all three legs close together
// at that stop price, same as the 2-leg version — the extra contract simply
// scales that loss by 1.5x (3 legs x $30 vs 2 legs x $30), which the worst-day
// printout in backtest.js will show directly against your $1,000 DLL.

// Mac's runner trail (2026-10-08, bundle spec) constants — MNQ-only (same
// assumption the rest of this backtest/live pair already makes; MGC is
// disabled). $200 is the fixed combined-unrealized lock trigger; the tick
// size is only used to round the computed stop conservatively (long rounds
// DOWN, short rounds UP) so rounding can never tighten past what was earned.
const MECH_TRAIL_LOCK_DOLLARS = 200;
const MECH_TRAIL_TICK_SIZE = 0.25;
function roundTrailStopConservative(price, dir, tickSize) {
  return dir === 1 ? Math.floor(price / tickSize) * tickSize : Math.ceil(price / tickSize) * tickSize;
}

// Nearest named Levels PRO level beyond entryPx, in the trade's favor, whose
// distance falls within [minPts, maxPts] — used by the Asia structural TP2
// override below. Scans the full level registry (PDH/PDC/VWAP/Asia+London
// hi-lo/IB/Week Open/etc., lib/levelsPro.js's LEVEL_DEFS), same source
// findPullbackLevel() already draws from, just the opposite side (beyond
// entry, not a pullback into it).
function findNearestStructuralLevel(dir, entryPx, levels, minPts, maxPts) {
  let best = null, bestDist = Infinity;
  for (const lvl of (levels || [])) {
    if (lvl.price == null) continue;
    const onFarSide = dir === 1 ? lvl.price > entryPx : lvl.price < entryPx;
    if (!onFarSide) continue;
    const dist = Math.abs(lvl.price - entryPx);
    if (dist < minPts || dist > maxPts) continue;
    if (dist < bestDist) { bestDist = dist; best = lvl.price; }
  }
  return best;
}

// asiaStruct (2026-10-08, bundle spec), when passed, is
// { levels, minPts, maxPts, fallbackPts } — only built by call sites when
// the signal fired in Asia session and asiaStructuralTarget2 is on. Takes
// priority over the plain multiple-based fallback but NOT over an already-
// valid lv.plan structTarget (that's already a real structural level, from
// a more specific source — Levels PRO's own plan for this exact setup).
function computeTarget2(dir, entryPx, target1Px, target1Points, structTarget, multiple, asiaStruct) {
  if (structTarget != null && Number.isFinite(structTarget)) {
    const validDir = dir === 1 ? structTarget > target1Px : structTarget < target1Px;
    if (validDir) return structTarget;
  }
  if (asiaStruct) {
    const lvlPrice = findNearestStructuralLevel(dir, entryPx, asiaStruct.levels, asiaStruct.minPts, asiaStruct.maxPts);
    if (lvlPrice != null) return lvlPrice;
    return dir === 1 ? entryPx + asiaStruct.fallbackPts : entryPx - asiaStruct.fallbackPts;
  }
  const t2Points = target1Points * multiple;
  return dir === 1 ? entryPx + t2Points : entryPx - t2Points;
}

function simulateAllTimeframes3Leg(timeframeConfigs, {
  pointValue, warmupBars = 300, maxHoldBars = 200, pendingExpireBars = 20,
  minMacScore = 7, target1DollarGoal = 30, target2Multiple = 2.5, dailyStopLoss = 999999,
  requireLevelsAlignment = true, blockNyOpenMinutes = 30, asiaBlockUntilMinutes = 17 * 60,
  leg1StopCapMultiple = 1.0,
  // Off-peak (Asia + London, i.e. anything outside the same inNySession window
  // nyStopMultiple already uses below) target override — null means "off",
  // reproducing the exact pre-existing behavior at every call site that
  // doesn't pass these. When set, a signal that fires outside NY hours banks
  // a smaller/larger total $ at leg 1 and/or scales leg 2's multiple
  // differently, instead of chasing the same NY-sized target through the
  // slower, lower-range Asia/London tape.
  offPeakTarget1DollarGoal = null, offPeakTarget2Multiple = null,
  // See the blockMacGradeB comment at its use site below. Off by default —
  // every existing call site reproduces current behavior unchanged.
  blockMacGradeB = false, blockGradeCAsia = false, blockMacCompression = false,
  // See the biasAgreement comment at its use site below. null = off.
  minBiasAgreementMacSource = null, minBiasAgreementLevelsSource = null,
  // See the requireVolSpike comment at its use site below. Off by default;
  // intended for an intrabar-only backtest harness to turn on, never the
  // standing bar-close config.
  requireVolSpike = false,
  // See the blockMacSourceIntrabar comment at its use site below. Off by
  // default; intended for an intrabar-only backtest harness to turn on,
  // never the standing bar-close config.
  blockMacSourceIntrabar = false,
  // See lib/signal.js's matching comment for the full rationale. Off by
  // default; every existing call site reproduces the exact validated
  // baseline unchanged.
  levelsUsePersistedPlan = false,
  // Asia structural TP2 (2026-10-08, bundle spec) — see computeTarget2's
  // comment. Off by default; every existing call site unaffected.
  asiaStructuralTarget2 = false, asiaTarget2MinPoints = 40, asiaTarget2MaxPoints = 150, asiaTarget2FallbackPoints = 150,
  // Mac's runner trail (2026-10-08, bundle spec) — single knob. null (the
  // default) keeps the old level-gated leg3 ratchet exactly as before; 10
  // is the validated ship value for the new mechanical rule (see its own
  // comment at the use site).
  trailStepPoints = null,
  // Both-agree gate (2026-09-21 trend-day review) — OFF by default, so every
  // existing call site reproduces the exact validated baseline unchanged.
  // The original 2-leg backtest found "both agree" was the worst-performing
  // bucket and skipped it entirely (see the comment below). That blocks
  // entries on the CLEANEST possible signal — full MAC + Levels PRO
  // agreement — which is exactly what a strong trend day looks like. This
  // flag lets a real backtest answer whether that finding still holds for
  // the current 3-leg grade-sized system, instead of trusting a finding
  // from a different, older version of the strategy. A genuine CONFLICT
  // (mac and levels pointing opposite ways) is still always skipped either
  // way — only true agreement is affected.
  allowBothAgree = false,
  // Sweep-entry experiment (Sept 21 trade review) — OFF by default, so every
  // existing call site reproduces the exact validated baseline unchanged.
  // When on, a mac-only signal (no Levels PRO structural plan) no longer
  // chases at market on the next bar's open; instead it waits for a pullback
  // into the JUST-CLOSED signal candle's own range (the same candle the
  // signal fired from) and only fills there, same as a real limit order. The
  // idea: a strong bullish candle typically makes its low before its high, so
  // buying the retracement instead of the breakout avoids getting stopped by
  // the very wick that would otherwise take you out right before the move.
  // Stop is sized off a fixed TOTAL dollar risk budget across all 3 contracts
  // (not the 1.0x leg1-target cap used everywhere else), since a pullback
  // entry is deliberately meant to tolerate more room than a breakout chase.
  // Levels PRO's own structural entries (LIMIT/STOP off real institutional
  // levels) are untouched — this only ever changes the mac-only fallback path.
  sweepEntry = false, sweepPullbackPct = 0.35, sweepStopBudgetDollars = 250, sweepContracts = 3,
  // Smart-stop-hold (Sept 21 trade review) — OFF by default. Uses Levels
  // PRO's own real-time behavior classification (already computed, already
  // logged as "LEVEL CROSS ... behavior=SWEEP DN" etc.) to tell a temporary
  // wick from a real break of structure, instead of a uniform wider stop
  // that can't tell the difference. See the comment at its use site below.
  smartStopHold = false, sweepGraceMultiple = 3.0,
  // smartHoldLiveStyle (Sept 21, second revision): the ORIGINAL smart-hold
  // above starts tight and widens reactively the instant a stop is touched —
  // only possible in a backtest, which can see the whole bar in hindsight. A
  // REAL resting stop order can't be widened after price has already touched
  // it — it would have already filled. So live-executor.js/liveStateMachine.js
  // actually do the mirror image: start at the WIDE ceiling from entry (the
  // real, always-on resting stop), and only ever ACCELERATE an exit early —
  // via a market order — once price crosses the tight reference AND Levels
  // PRO confirms a genuine ACCEPT/RECLAIM break of structure. This flag runs
  // THAT exact mechanic here, so it can be validated against real history
  // instead of just trusting it matches the (different) mechanic already
  // proven above.
  smartHoldLiveStyle = false,
  // Grade/score-based sizing (2026-09-21) — OFF by default. mac.activeScore
  // is computed on every bar regardless of which source actually triggers
  // the entry, so this applies uniformly, not just to mac-only signals. Leg1
  // and leg2 always close exactly 1 contract each (the proven $30-then-
  // structural math); any extra size beyond baseContracts goes entirely to
  // leg3, the trend-riding leg, on the idea that more conviction should mean
  // more size behind the trend, not a bigger scalp on the fixed-target legs.
  sizeByGrade = false, gradeSizeThreshold = 9, gradeSizeContracts = 5, baseContracts = 3,
  // Leg1 shave size on grade-sized trades (2026-09-21 trade review) — OFF
  // (0) by default, meaning leg1 always closes exactly 1 contract, same as
  // before grade-sizing existed. gradeLeg1Extra lets a grade-sized trade
  // (contracts > baseContracts) bank MORE than 1 contract at leg1's $30
  // target, funded ONLY from the extra size beyond baseContracts — never
  // from leg2's 1 contract or from a normal (non-grade) trade, so the
  // already-validated 3-contract 1/1/1 math is untouched either way. The
  // idea being tested: since a real trend tends to hand the bot another
  // qualifying signal on a pullback anyway (see the 4-re-entries-in-one-
  // evening pattern in the Sept 20 trade log), banking more certain profit
  // at the safest/earliest target may cost less upside than it looks like,
  // because leg3's job (riding the rest of the move) can often get picked
  // back up on a fresh entry instead of one continuous position.
  gradeLeg1Extra = 0,
  // Base leg1 shave size (2026-09-21 trade review, prop-account framing) —
  // 0 by default, meaning leg1 always closes exactly 1 contract on a NORMAL
  // (non-grade-sized) trade, same as always. This is DIFFERENT from
  // gradeLeg1Extra above: that one only ever touches the EXTRA size on a
  // grade-sized (5-contract) trade. This one changes the base 3-contract
  // split itself (e.g. 2/1/0 instead of 1/1/1), the one piece of math this
  // project has treated as already-proven and hasn't re-tested until now.
  // The question raised (2026-09-21): a Combine evaluation isn't "maximize
  // avg/day" — it's "reach a fixed profit target without ever tripping the
  // trailing drawdown, while respecting the 55% single-day consistency cap."
  // A lower-variance split could be the better choice for THAT goal even at
  // a lower avg/day. See backtest.js's PROP COMBINE SIMULATION section.
  baseLeg1Extra = 0,
  // Session-aware leg1 stop (2026-09-21 trade review) — null by default,
  // meaning leg1StopCapMultiple applies uniformly everywhere, same as
  // before. The SESSION BREAKDOWN in backtest.js found leg1's win rate
  // during NY (06:30-13:00 PT) notably worse than London/Asia at the same
  // 15pt stop — this lets NY use a DIFFERENT multiple than every other
  // session, instead of widening the stop globally (which the STOP ROOM
  // SWEEP already showed underperforms in aggregate, precisely because it
  // wastes room on sessions that didn't need it).
  nyStopMultiple = null,
  // Leg2 shave size on grade-sized trades (2026-09-21, same evening as
  // gradeLeg1Extra) — 0 by default, meaning leg2 always closes exactly 1
  // contract regardless of size, same as always. Generalizes the SAME idea
  // to leg2's structural target, since at 15-contract sizing (this account's
  // real Combine-tier size, not the 5-contract size the original
  // gradeLeg1Extra test ran against) the tradeoff may look different — this
  // exists to test that directly instead of assuming the 5-contract finding
  // still holds at 3x the size.
  gradeLeg2Extra = 0,
  // Profit-lock (2026-09-21) — null (off) by default. See the comment at its
  // use site in the LEG1_OPEN block below for the full reasoning: this ties
  // the FIRST profit bank to actual unrealized dollars instead of a fixed
  // 15pt price distance, which doesn't scale with a 15-contract position.
  profitLockDollars = null, profitLockPct = 0.5,
  // Stop-cap reference (2026-09-23, matches live-executor.js's fix) — kept
  // separate from target1DollarGoal on purpose so a bigger TP1 goal can't
  // shrink the stop-cap ceiling. Only used for the mac-only fallback path
  // below now — a REAL Levels PRO structural stop is trusted outright and
  // never passed through capStop() at all.
  stopCapDollarsPerContract = 30,
  // Day-progress-aware sizing (2026-10-07, user spec) — OFF by default, so
  // every existing call site reproduces the exact validated baseline
  // unchanged. Distinct from sizeByGrade above: that one upsizes based on
  // signal quality alone; this one ALSO tracks the day's own running
  // REALIZED P&L (the same dayRealizedPnl this function already maintains
  // for the daily-stop gate) and changes size based on whether today's
  // target has been banked yet — "trade bigger to get there fast on a
  // genuinely good signal, then protect it for the rest of the day."
  //   - Before dayTargetDollars is reached: a grade-A signal (activeScore
  //     >= bigGradeThreshold) trades bigContracts; anything else trades the
  //     normal baseContracts size (not smallContracts — running out of big-
  //     size attempts isn't the same thing as having already banked
  //     profit to protect).
  //   - Once dayRealizedPnl >= dayTargetDollars: EVERY signal for the rest
  //     of that trading day trades smallContracts, no exceptions, grade-A
  //     or not — this is the deliberate, explicit answer to "does it scale
  //     back up later," not an oversight.
  //   - maxBigAttempts (null = unlimited) caps how many big-size entries
  //     can fire in one day before the target is reached, independent of
  //     outcome — a losing-streak guardrail. null reproduces "keep
  //     swinging big until the target lands," which the backtest below
  //     exists specifically to check isn't actually the best choice.
  dayProgressSizing = false, bigContracts = 10, smallContracts = 2, dayTargetDollars = 200,
  bigGradeThreshold = 9, maxBigAttempts = null,
  // Same-zone failure cooldown (2026-10-07, trade-log P2/P5 evidence) — OFF
  // by default. After a trade gets FULLY stopped out (all 3 legs at the
  // original risk stop, before leg1 ever banked), veto any new signal in
  // the SAME direction whose entry price lands within cooldownZonePoints of
  // that stopped-out trade's own entry price, for the rest of that trading
  // day. Evidence: 2026-09-25 four longs into the same ~23pt PDH/Asia-High
  // ceiling (30928.75/30905.25/30899.50/30905.25) stopped out for -$1,512
  // combined; 2026-09-29 a re-short of the same London Low zone 30min after
  // a prior stop there lost another -$469.30. A trade that banks ANYTHING
  // (TP1, BE, trail) never enters this list — only a clean full stop does,
  // since that's the specific "this exact zone just proved wrong" signal
  // the evidence is about, not every losing trade.
  sameZoneCooldown = false, cooldownZonePoints = 20,
  // Risk-budgeted sizing (2026-10-07) — OFF by default, so every existing
  // call site reproduces the exact validated baseline unchanged. The flat
  // baseContracts scheme sizes every trade the same regardless of how far
  // away its stop is, so a structurally wide stop (a real Levels PRO level
  // far from entry) risks far more dollars than a tight one at the SAME
  // contract count — that's the single-trade tail risk that no daily-stop/
  // trailing-floor logic can ever catch, since it's realized inside one
  // already-open trade, not across several. When on, contracts are sized
  // from the signal's OWN stop distance so every trade risks roughly the
  // same dollars at full stop: contracts = round(dollarRiskPerTrade /
  // (stopPoints * pointValue)), clamped to
  // [riskSizingMinContracts, riskSizingMaxContracts]. Replaces
  // contractsForSignal()/dayProgressSizing/sizeByGrade entirely when on —
  // not stacked with them. Doesn't touch the sweepEntry path (OFF by
  // default anyway), which already has its own fixed dollar-budget sizing
  // via sweepContracts/sweepStopBudgetDollars.
  riskBudgetedSizing = false, dollarRiskPerTrade = 250, riskSizingMinContracts = 1, riskSizingMaxContracts = 15,
} = {}) {
  const { tradingDayKey } = require('./dailyRisk');
  // No longer a single outer constant (2026-09-22 parity fix with
  // live-executor.js): target1DollarGoal is a TOTAL to bank at TP1, not a
  // per-contract figure, so the point-distance has to divide by however many
  // contracts leg1 actually closes — which varies by size tier. Computed
  // per-trade below, right after leg1Size is known, and carried on
  // position/pending objects for the couple of places (smart-stop-hold) that
  // need it again later in that same trade's lifetime.
  const trades = [];

  let bigAttemptsToday = 0; // reset alongside dayRealizedPnl/dayBlocked at each day boundary below
  function contractsForSignal(mac) {
    if (dayProgressSizing) {
      if (dayRealizedPnl >= dayTargetDollars) return smallContracts;
      const isGradeA = mac.activeScore >= bigGradeThreshold;
      if (isGradeA && (maxBigAttempts == null || bigAttemptsToday < maxBigAttempts)) {
        bigAttemptsToday++;
        return bigContracts;
      }
      return baseContracts;
    }
    if (!sizeByGrade) return baseContracts;
    return mac.activeScore >= gradeSizeThreshold ? gradeSizeContracts : baseContracts;
  }

  // Risk-budgeted sizing (2026-10-07) — see riskBudgetedSizing's own comment
  // above. stopPoints is THIS signal's own raw stop distance (before any
  // leg/size-dependent math), computed by each branch below from whatever
  // already determines its stop price — never a flat per-contract reference,
  // so a trade with a genuinely wide structural stop gets sized DOWN instead
  // of carrying the same contract count as a tight one.
  function sizeForStop(mac, stopPoints) {
    if (!riskBudgetedSizing) return contractsForSignal(mac);
    if (!stopPoints || stopPoints <= 0) return baseContracts; // defensive — shouldn't happen on a real signal
    const raw = dollarRiskPerTrade / (stopPoints * pointValue);
    return Math.max(riskSizingMinContracts, Math.min(riskSizingMaxContracts, Math.round(raw)));
  }

  // How many contracts leg1 shaves off for THIS trade's size — always 1
  // unless this trade got grade-sized above baseContracts, in which case up
  // to gradeLeg1Extra of that extra size gets added to leg1 instead of leg3.
  function leg1SizeForContracts(contracts) {
    const extra = Math.max(0, contracts - baseContracts);
    const size = 1 + baseLeg1Extra + Math.min(extra, gradeLeg1Extra);
    // Math.max(1, ...) added 2026-10-07 — defensive backstop (see
    // live-executor.js's identical fix for the real story): at contracts=1,
    // the un-clamped math gives leg1Size=0, which makes target1Points =
    // target1DollarGoal/(0*pointValue) = Infinity. Caught via
    // riskBudgetedSizing before any live use; riskSizingMinContracts=4 is
    // what actually keeps contracts from getting this small in practice —
    // this is just a floor so the arithmetic itself can never go there.
    return Math.max(1, Math.min(size, contracts - 1)); // always leave at least 1 contract for leg2
  }

  // Mirrors leg1SizeForContracts — leg2's extra is funded from the SAME pool
  // of grade-sized extra contracts as leg1's (contracts - baseContracts),
  // computed AFTER leg1Size so the two never double-claim the same size.
  // leg3 (the rider) is allowed to reach 0 — that's a valid, informative
  // outcome to test, not something to protect against.
  function leg2SizeForContracts(contracts, leg1Size) {
    const extra = Math.max(0, contracts - baseContracts);
    const size = 1 + Math.min(Math.max(0, extra - gradeLeg1Extra), gradeLeg2Extra);
    // Math.max(0, ...) added 2026-10-07 — same defensive backstop as
    // leg1SizeForContracts above, for the same reason: contracts-leg1Size
    // can go negative at small contract counts if leg1Size is ever larger
    // than contracts (shouldn't happen given leg1SizeForContracts's own
    // clamp, but this is cheap insurance against the two functions ever
    // drifting out of sync).
    return Math.max(0, Math.min(size, contracts - leg1Size)); // leg3 may legitimately be 0
  }

  function applySmartHoldLive(entryPrice, tightStop, dir) {
    if (!(smartStopHold && smartHoldLiveStyle)) return { stopPrice: tightStop, tightStopPrice: null };
    const tightPoints = dir === 1 ? entryPrice - tightStop : tightStop - entryPrice;
    const widePoints = tightPoints * sweepGraceMultiple;
    const stopPrice = dir === 1 ? entryPrice - widePoints : entryPrice + widePoints;
    return { stopPrice, tightStopPrice: tightStop };
  }

  const states = timeframeConfigs.map(cfg => ({
    tf: cfg.tf, chartBars: cfg.chartBars, macOut: cfg.macOut, levelsOut: cfg.levelsOut,
    fineBars: cfg.fineBars || null,
    tfMs: cfg.tfMs || (cfg.chartBars[1] ? cfg.chartBars[1].t - cfg.chartBars[0].t : 900000),
    position: null, pending: null,
  }));

  const events = [];
  for (let s = 0; s < states.length; s++) {
    for (let i = warmupBars; i < states[s].chartBars.length; i++) events.push({ s, i, t: states[s].chartBars[i].t });
  }
  events.sort((a, b) => a.t - b.t);

  let currentDayKey = null, dayRealizedPnl = 0, dayBlocked = false, recentStopOuts = [];

  // contracts (default 1): how many lots this leg-closing event represents —
  // leg1/leg2 always 1, leg3 closes whatever's left riding (pos.contracts-2).
  function pushLeg(st, pos, exitPrice, exitReason, exitIdx, leg, contracts = 1) {
    const pnlPoints = pos.dir === 1 ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnlDollars = pnlPoints * pointValue * contracts;
    trades.push({
      tf: st.tf, dir: pos.dir, source: pos.source, grade: pos.grade, entryType: pos.entryType, leg, contracts,
      entryTime: st.chartBars[pos.entryIdx].t, entryPrice: pos.entryPrice,
      exitTime: st.chartBars[exitIdx].t, exitPrice, exitReason,
      barsHeld: exitIdx - pos.entryIdx, waitedBars: pos.waitedBars || 0,
      pnlPoints, pnlDollars,
    });
    dayRealizedPnl += pnlDollars;
  }

  for (const ev of events) {
    const st = states[ev.s], i = ev.i, bar = st.chartBars[i];

    const dayKey = tradingDayKey(bar.t);
    if (dayKey !== currentDayKey) { currentDayKey = dayKey; dayRealizedPnl = 0; dayBlocked = false; bigAttemptsToday = 0; recentStopOuts = []; }
    if (dayRealizedPnl <= -dailyStopLoss) dayBlocked = true;

    if (st.position) {
      const position = st.position;
      if (!position.leg1Closed) {
        // Profit-lock (2026-09-21, real live trade review): TP1's fixed 15pt/
        // 1-contract shave doesn't scale with position size — on a 15-contract
        // grade-sized trade, unrealized profit can already be $200-300 before
        // price ever reaches the 15pt target, and a reversal from there gives
        // ALL of it back with nothing banked. This ties the FIRST bank to
        // actual dollar profit instead of a fixed price distance: once
        // unrealized crosses profitLockDollars (on the position's CURRENT
        // size), it closes profitLockPct of whatever's open, right then, at
        // whatever price that took. Fires at most once per trade. leg1/leg2
        // still fire normally afterward, resized against whatever's left.
        if (profitLockDollars != null && !position.profitLocked) {
          const neededPoints = profitLockDollars / (pointValue * position.contracts);
          const triggerPrice = position.dir === 1 ? position.entryPrice + neededPoints : position.entryPrice - neededPoints;
          const reached = position.dir === 1 ? bar.h >= triggerPrice : bar.l <= triggerPrice;
          if (reached) {
            const lockSize = Math.min(position.contracts - 1, Math.max(1, Math.round(position.contracts * profitLockPct)));
            pushLeg(st, position, triggerPrice, 'profit-lock', i, 0, lockSize);
            position.contracts -= lockSize;
            position.leg1Size = leg1SizeForContracts(position.contracts);
            position.leg2Size = leg2SizeForContracts(position.contracts, position.leg1Size);
            position.profitLocked = true;
          }
        }
        // Smart-stop-hold (Sept 21 trade review): before honoring a stop hit,
        // check whether Levels PRO's OWN real-time classification says this
        // is a SWEEP/FAIL at a nearby level (a wick that's likely to reverse)
        // rather than an ACCEPT/LOST (a genuine break of structure). Only
        // does this ONCE per trade (position.graceUsed), and only widens up
        // to sweepGraceMultiple as a hard ceiling — it never lets a real
        // breakdown run indefinitely, it just gives a wick one chance to
        // prove itself wrong before cutting the loss.
        if (smartStopHold && smartHoldLiveStyle && position.tightStopPrice != null && !position.smartHoldChecked) {
          const crossed = position.dir === 1 ? bar.l <= position.tightStopPrice : bar.h >= position.tightStopPrice;
          if (crossed) {
            position.smartHoldChecked = true;
            const curLv = st.levelsOut[i];
            const structural = (curLv && curLv.levels || []).some(l => {
              const b = l.behavior || '';
              return position.dir === 1 ? (b === 'ACCEPT-' || b === 'LOST') : (b === 'ACCEPT+' || b === 'RECLAIM');
            });
            if (structural) {
              // A real live poll reacts within ~20s of the crossing, not up
              // to a full 15 minutes later — use the finest resolution we
              // have (5-minute fine bars) to find the price near where the
              // tight level actually got crossed, instead of the full bar's
              // close (which can have kept moving hard against the trade for
              // the rest of the 15 minutes, understating a fast reaction).
              const exitPrice = findCrossPrice(st.fineBars, bar.t, st.tfMs, position.dir, position.tightStopPrice, bar.c);
              pushLeg(st, position, exitPrice, 'smart-hold early exit', i, 1, position.leg1Size);
              pushLeg(st, position, exitPrice, 'smart-hold early exit', i, 2, position.leg2Size);
              pushLeg(st, position, exitPrice, 'smart-hold early exit', i, 3, position.contracts - position.leg1Size - position.leg2Size);
              st.position = null;
              continue;
            }
            // ambiguous/sweep-like — do nothing, the wide resting stop (position.stopPrice) stays the real exit
          }
        } else if (smartStopHold && !smartHoldLiveStyle && !position.graceUsed) {
          const wouldHitStop = position.dir === 1 ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;
          if (wouldHitStop) {
            const curLv = st.levelsOut[i];
            const sweepy = (curLv && curLv.levels || []).some(l => {
              const b = l.behavior || '';
              return position.dir === 1 ? (b === 'SWEEP DN' || b === 'FAIL DN') : (b === 'SWEEP UP' || b === 'FAIL UP');
            });
            if (sweepy) {
              const widerStop = position.dir === 1
                ? position.entryPrice - position.target1Points * sweepGraceMultiple
                : position.entryPrice + position.target1Points * sweepGraceMultiple;
              const stillSafeAtWiderStop = position.dir === 1 ? bar.l > widerStop : bar.h < widerStop;
              if (stillSafeAtWiderStop) {
                position.stopPrice = widerStop;
                position.graceUsed = true;
              }
            }
          }
        }

        const hitStop = position.dir === 1 ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;
        const hitTarget1 = position.dir === 1 ? bar.h >= position.target1 : bar.l <= position.target1;
        if (hitStop && hitTarget1) {
          const resolved = resolveIntrabar(st.fineBars, bar.t, st.tfMs, position.dir, position.stopPrice, position.target1);
          if (resolved === 'target') {
            pushLeg(st, position, position.target1, 'target1 (resolved via fine bars)', i, 1, position.leg1Size);
            position.leg1Closed = true;
            position.leg2Stop = position.entryPrice;
            position.trailStop = position.entryPrice;
            position.trailPeakPts = 0;
          } else {
            const reason = resolved === 'stop' ? 'stop (resolved via fine bars)' : 'stop (both hit, no fine data)';
            pushLeg(st, position, position.stopPrice, reason, i, 1, position.leg1Size);
            pushLeg(st, position, position.stopPrice, reason, i, 2, position.leg2Size);
            pushLeg(st, position, position.stopPrice, reason, i, 3, position.contracts - position.leg1Size - position.leg2Size);
            if (sameZoneCooldown) recentStopOuts.push({ dir: position.dir, entryPrice: position.entryPrice });
            st.position = null;
          }
        } else if (hitTarget1) {
          pushLeg(st, position, position.target1, 'target1', i, 1, position.leg1Size);
          position.leg1Closed = true;
          position.leg2Stop = position.entryPrice;
          position.trailStop = position.entryPrice;
          position.trailPeakPts = 0;
        } else if (hitStop) {
          pushLeg(st, position, position.stopPrice, 'stop', i, 1, position.leg1Size);
          pushLeg(st, position, position.stopPrice, 'stop', i, 2, position.leg2Size);
          pushLeg(st, position, position.stopPrice, 'stop', i, 3, position.contracts - position.leg1Size - position.leg2Size);
          if (sameZoneCooldown) recentStopOuts.push({ dir: position.dir, entryPrice: position.entryPrice });
          st.position = null;
        } else if ((i - position.entryIdx) >= maxHoldBars) {
          pushLeg(st, position, bar.c, 'timeout', i, 1, position.leg1Size);
          pushLeg(st, position, bar.c, 'timeout', i, 2, position.leg2Size);
          pushLeg(st, position, bar.c, 'timeout', i, 3, position.contracts - position.leg1Size - position.leg2Size);
          st.position = null;
        }
      } else {
        // Second-stage profit-lock (2026-09-21, same evening): TP2 sits even
        // further out than TP1 (45pt structural distance vs TP1's 15pt) — the
        // remaining position (leg2 + leg3, both now at breakeven) can sit
        // exposed to a full round-trip back to breakeven for a long time
        // waiting on it. Fires at most once in this phase, shaving only from
        // LEG3's share (leg2 keeps its own fixed target, untouched) once
        // unrealized on what's still open crosses the threshold again.
        const leg3RemainingBeforeLock = position.contracts - position.leg1Size - position.leg2Size;
        if (profitLockDollars != null && !position.profitLocked2 && leg3RemainingBeforeLock > 0) {
          const openAfterLeg1 = position.contracts - position.leg1Size;
          const neededPoints2 = profitLockDollars / (pointValue * openAfterLeg1);
          const triggerPrice2 = position.dir === 1 ? position.entryPrice + neededPoints2 : position.entryPrice - neededPoints2;
          const reached2 = position.dir === 1 ? bar.h >= triggerPrice2 : bar.l <= triggerPrice2;
          if (reached2) {
            const lockSize2 = Math.min(leg3RemainingBeforeLock, Math.max(1, Math.round(leg3RemainingBeforeLock * profitLockPct)));
            pushLeg(st, position, triggerPrice2, 'profit-lock-2', i, 0, lockSize2);
            position.contracts -= lockSize2;
            position.profitLocked2 = true;
          }
        }
        // Leg 2: breakeven stop, targets the structural/fallback target2.
        if (!position.leg2Closed) {
          const hitStop2 = position.dir === 1 ? bar.l <= position.leg2Stop : bar.h >= position.leg2Stop;
          const hitTarget2 = position.dir === 1 ? bar.h >= position.target2 : bar.l <= position.target2;
          if (hitStop2 && hitTarget2) {
            const resolved = resolveIntrabar(st.fineBars, bar.t, st.tfMs, position.dir, position.leg2Stop, position.target2);
            if (resolved === 'target') { pushLeg(st, position, position.target2, 'target2 (resolved via fine bars)', i, 2, position.leg2Size); position.leg2Closed = true; }
            else { pushLeg(st, position, position.leg2Stop, resolved === 'stop' ? 'breakeven stop (resolved via fine bars)' : 'breakeven stop (both hit, no fine data)', i, 2, position.leg2Size); position.leg2Closed = true; }
          } else if (hitTarget2) {
            pushLeg(st, position, position.target2, 'target2', i, 2, position.leg2Size);
            position.leg2Closed = true;
          } else if (hitStop2) {
            pushLeg(st, position, position.leg2Stop, 'breakeven stop', i, 2, position.leg2Size);
            position.leg2Closed = true;
          } else if ((i - position.entryIdx) >= maxHoldBars) {
            pushLeg(st, position, bar.c, 'timeout', i, 2, position.leg2Size);
            position.leg2Closed = true;
          }
        }
        // Leg 3: breakeven stop that trails, no fixed target.
        if (!position.leg3Closed) {
          const hitStop3 = position.dir === 1 ? bar.l <= position.trailStop : bar.h >= position.trailStop;
          if (hitStop3) {
            pushLeg(st, position, position.trailStop, position.trailStop === position.entryPrice ? 'breakeven stop' : 'trailing stop', i, 3, position.contracts - position.leg1Size - position.leg2Size);
            position.leg3Closed = true;
          } else if ((i - position.entryIdx) >= maxHoldBars) {
            pushLeg(st, position, bar.c, 'timeout', i, 3, position.contracts - position.leg1Size - position.leg2Size);
            position.leg3Closed = true;
          } else if (trailStepPoints != null) {
            // Mac's runner trail (2026-10-08, bundle spec) — MECHANICAL,
            // replacing the level-gated ratchet below. Below a $200 combined
            // unrealized on leg3's own contracts, stop sits at breakeven.
            // Once peak favorable excursion crosses the point distance that
            // $200 represents for leg3's actual size, the stop locks that
            // level in, then ratchets another trailStepPoints for every
            // further trailStepPoints of favorable excursion beyond it.
            // One-way (peak excursion only grows) and tick-rounded
            // conservatively so rounding never tightens past what was earned.
            const leg3Size = position.contracts - position.leg1Size - position.leg2Size;
            const favorableExtreme = position.dir === 1 ? bar.h : bar.l;
            const excursionPts = position.dir === 1 ? favorableExtreme - position.entryPrice : position.entryPrice - favorableExtreme;
            position.trailPeakPts = Math.max(position.trailPeakPts || 0, excursionPts);
            const lockPoints = (leg3Size > 0) ? MECH_TRAIL_LOCK_DOLLARS / (pointValue * leg3Size) : Infinity;
            if (position.trailPeakPts >= lockPoints) {
              const extra = position.trailPeakPts - lockPoints;
              const offsetPoints = lockPoints + Math.floor(extra / trailStepPoints) * trailStepPoints;
              const rawStop = position.dir === 1 ? position.entryPrice + offsetPoints : position.entryPrice - offsetPoints;
              const roundedStop = roundTrailStopConservative(rawStop, position.dir, MECH_TRAIL_TICK_SIZE);
              position.trailStop = position.dir === 1 ? Math.max(position.trailStop, roundedStop) : Math.min(position.trailStop, roundedStop);
            }
          } else {
            const lv = st.levelsOut[i];
            if (lv && lv.levels) {
              let best = position.trailStop;
              for (const lvl of lv.levels) {
                if (position.dir === 1) { if (lvl.price > best && bar.c > lvl.price) best = lvl.price; }
                else { if (lvl.price < best && bar.c < lvl.price) best = lvl.price; }
              }
              position.trailStop = best;
            }
          }
        }
        if (position.leg2Closed && position.leg3Closed) st.position = null;
      }
      continue;
    }

    if (st.pending) {
      const pending = st.pending;
      let filled = false;
      if (pending.entryType === 'LIMIT') {
        if (pending.dir === 1 && bar.l <= pending.entryPrice) filled = true;
        if (pending.dir === -1 && bar.h >= pending.entryPrice) filled = true;
      } else if (pending.entryType === 'STOP') {
        if (pending.dir === 1 && bar.h >= pending.entryPrice) filled = true;
        if (pending.dir === -1 && bar.l <= pending.entryPrice) filled = true;
      }
      if (filled) {
        st.position = {
          dir: pending.dir, entryIdx: i, entryPrice: pending.entryPrice, entryType: pending.entryType,
          stopPrice: pending.stopPrice, tightStopPrice: pending.tightStopPrice ?? null, smartHoldChecked: false,
          target1: pending.target1, target2: pending.target2, target1Points: pending.target1Points, contracts: pending.contracts, leg1Size: pending.leg1Size, leg2Size: pending.leg2Size,
          source: pending.source, grade: pending.grade, waitedBars: i - pending.signalIdx,
          leg1Closed: false, leg2Closed: false, leg3Closed: false, profitLocked: false, profitLocked2: false,
        };
        st.pending = null;
        continue;
      }
      if (i - pending.signalIdx >= pendingExpireBars) st.pending = null;
      else continue;
    }

    if (dayBlocked) continue;
    if (inNyOpenBlackout(bar.t, blockNyOpenMinutes)) continue;
    if (inAsiaBlackout(bar.t, asiaBlockUntilMinutes)) continue;
    if (i + 1 >= st.chartBars.length) continue;
    const mac = st.macOut[i], lv = st.levelsOut[i];
    if (!mac || !lv) continue;

    const macDirRaw = ((mac.activeDir === 1 && mac.activeScore >= minMacScore) || mac.biasStr === 'STRONG BULL') ? 1
      : ((mac.activeDir === -1 && mac.activeScore >= minMacScore) || mac.biasStr === 'STRONG BEAR') ? -1 : 0;
    // mac.hardBlock (late buyer/seller exhaustion, the 06:30 news window, or
    // VIX) already zeroes out entryGrade, but activeDir/activeScore are
    // computed BEFORE that gate — without this check a "late buyers" bar
    // could still fire a directional signal with a worthless grade. This is
    // what let the Sept 21 chase through right before it got wicked out.
    // blockMacCompression (2026-10-08, bundle spec) — see lib/signal.js's
    // matching comment. Mirrors live bar-for-bar; levels-only entries unaffected.
    const macDir = (mac.hardBlock || (blockMacCompression && mac.volCompression)) ? 0 : macDirRaw;
    const lvGateOk = !requireLevelsAlignment || lv.alignedFull;
    // levelsUsePersistedPlan — mirrors lib/signal.js's matching comment
    // exactly, for parity.
    const lvDirRaw = !lvGateOk ? 0
      : (levelsUsePersistedPlan ? lv.planLong : lv.sigLong) ? 1
      : (levelsUsePersistedPlan ? lv.planShort : lv.sigShort) ? -1
      : lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1 : 0;
    // Same hardBlock gate mac-sourced signals already get above — a levels
    // signal on a "late buyers"/"late sellers"/VIX/news-window bar used to
    // still fire. Kept in parity with lib/signal.js and simulate.js.
    const lvDir = (mac.hardBlock || mac.chopSkip) ? 0 : lvDirRaw;

    let dir = 0, source = null, grade = null;
    // Backtesting on real data (original 2-leg system) showed "both agree" is
    // the WORST-performing bucket, consistently — likely explanation: by the
    // time two independently-built momentum/control composites both max out
    // at once, the move is often already late-stage exhaustion, not
    // confirmation. A genuine CONFLICT (opposite directions) is always
    // skipped regardless of allowBothAgree — only true agreement is gated.
    if (macDir !== 0 && lvDir !== 0) {
      if (!allowBothAgree || macDir !== lvDir) continue;
      dir = macDir;
      source = (lv.plan && lv.plan.dir === dir) ? 'levels' : 'mac';
      grade = (lv.plan && lv.plan.dir === dir) ? lv.plan.grade : mac.entryGrade;
    }
    else if (lvDir !== 0) { dir = lvDir; source = 'levels'; grade = (lv.plan && lv.plan.dir === dir) ? lv.plan.grade : null; }
    else if (macDir !== 0) { dir = macDir; source = 'mac'; grade = mac.entryGrade; }
    if (dir === 0) continue;
    // blockMacSourceIntrabar (2026-10-08) — mirrors lib/signal.js's matching
    // comment exactly, for parity. See its own comment there for the full
    // intrabar economics-backtest numbers (mac-sourced PF 1.03/$1,095 vs
    // levels-sourced PF 1.29/$17,195 over 627 candidates).
    if (blockMacSourceIntrabar && source === 'mac') continue;
    // requireVolSpike (2026-10-08) — mirrors lib/signal.js's matching
    // comment exactly, for parity. mac.volSpikeBull/volSpikeBear require
    // this bar's volume > cfg.volSpikeMult (1.5x) its own 20-bar average
    // AND aligned with this bar's own direction — real participation, not
    // just a price tick satisfying the other gates.
    if (requireVolSpike) {
      const volSpikeAligned = dir === 1 ? mac.volSpikeBull : mac.volSpikeBear;
      if (!volSpikeAligned) continue;
    }
    // blockMacGradeB (2026-10-08, PF investigation) — a source x grade
    // breakdown across the full 5-year sample found mac.entryGrade==='B'
    // (tierStrong, MAC's own middle confidence tier) is fine when Levels PRO
    // agrees (source becomes 'levels', PF 1.51) but net LOSING when mac is
    // the sole source (no Levels PRO plan backing it): n=2203 (38% of every
    // trade taken), PF=0.96, totalPnl=-$13,853 over 5 years — the single
    // largest negative bucket in the whole book, not a small-sample fluke.
    // Every other mac-sourced grade (A, C, -) is net positive on its own.
    if (blockMacGradeB && source === 'mac' && grade === 'B') continue;
    // blockGradeCAsia (2026-10-08) — re-running the same breakdown AFTER
    // blockMacGradeB still showed grade C entries during Asia hours as a
    // standalone net-negative bucket (n=311, PF=0.90, -$3,552 over 5y) even
    // though grade C is fine everywhere else (London +$4,918, NY +$5,558).
    if (blockGradeCAsia && grade === 'C' && ptInfo(bar.t).isAsia) continue;
    // minBiasAgreementMacSource / minBiasAgreementLevelsSource (2026-10-08,
    // "weight the two indicators" investigation) — lv.biasScore is Levels
    // PRO's own continuous buyer/seller-control composite (levelsPro.js's
    // weighted "board bias", ~line 374), never previously checked at entry
    // time at all (requireLevelsAlignment only gates lvDir, not macDir, and
    // only checks the separate 15m/1h/4h EMA alignment, not this). Signed
    // so positive always means "agrees with this trade's direction":
    //   - mac-sourced, split by |biasScore|: opposes (n=168) PF=0.07,
    //     neutral/contested (<0.22, n=882) PF=0.43-0.52, in-control (n=969)
    //     PF=1.94-3.87. MAC's own momentum with NO buyer/seller control
    //     behind it (let alone control pointing the other way) is close to
    //     a coin flip with a bad payout, independent of grade.
    //   - levels-sourced trades show the IDENTICAL split (weak biasScore
    //     n=881 PF=0.66 vs in-control n=1473 PF=1.91-3.54) — a specific
    //     level's sweep/reclaim firing (source='levels') doesn't guarantee
    //     the BROADER multi-level board agrees yet.
    const biasAgreement = dir === 1 ? lv.biasScore : -lv.biasScore;
    if (source === 'mac' && minBiasAgreementMacSource != null && biasAgreement < minBiasAgreementMacSource) continue;
    if (source === 'levels' && minBiasAgreementLevelsSource != null && biasAgreement < minBiasAgreementLevelsSource) continue;
    if (sameZoneCooldown && recentStopOuts.some(so => so.dir === dir && Math.abs(so.entryPrice - bar.c) <= cooldownZonePoints)) continue;
    const stopCapPoints = stopCapDollarsPerContract / pointValue;
    const signalMinutesOfDay = ptInfo(bar.t).minutesOfDay;
    const inNySession = signalMinutesOfDay >= 6 * 60 + 30 && signalMinutesOfDay < 13 * 60;
    const effectiveStopMultiple = (nyStopMultiple != null && inNySession) ? nyStopMultiple : leg1StopCapMultiple;
    const effectiveTarget1DollarGoal = (!inNySession && offPeakTarget1DollarGoal != null) ? offPeakTarget1DollarGoal : target1DollarGoal;
    const effectiveTarget2Multiple = (!inNySession && offPeakTarget2Multiple != null) ? offPeakTarget2Multiple : target2Multiple;
    // Asia structural TP2 (2026-10-08, bundle spec) — built once per signal,
    // passed into every computeTarget2() call below. See its own comment.
    const asiaStruct = (asiaStructuralTarget2 && ptInfo(bar.t).isAsia)
      ? { levels: lv.levels, minPts: asiaTarget2MinPoints, maxPts: asiaTarget2MaxPoints, fallbackPts: asiaTarget2FallbackPoints }
      : null;

    const nextBar = st.chartBars[i + 1];
    const planMatches = lv.plan && lv.plan.dir === dir;

    // contracts/leg1Size/leg2Size/target1Points are computed PER BRANCH below
    // (after that branch's own stop distance is known), not once up front —
    // riskBudgetedSizing needs the real stop distance to size the trade; off
    // (the default), sizeForStop() just calls contractsForSignal(mac) same as
    // always, so this reorder changes nothing when the flag is off.
    if (planMatches) {
      const { entryType, entry: entryPriceP, stop: stopPriceRaw, target: structTarget } = lv.plan;
      if (entryType === 'MARKET') {
        const fillPrice = nextBar.o;
        if (dir === 1 && stopPriceRaw >= fillPrice) continue;
        if (dir === -1 && stopPriceRaw <= fillPrice) continue;
        // Trusted outright (2026-09-23 spec) — a real Levels PRO structural
        // stop, not a synthetic ATR guess, so no capStop() truncation.
        const { stopPrice, tightStopPrice } = applySmartHoldLive(fillPrice, stopPriceRaw, dir);
        const contracts = sizeForStop(mac, Math.abs(fillPrice - stopPriceRaw));
        const leg1Size = leg1SizeForContracts(contracts);
        const leg2Size = leg2SizeForContracts(contracts, leg1Size);
        const target1Points = effectiveTarget1DollarGoal / (leg1Size * pointValue);
        const target1 = dir === 1 ? fillPrice + target1Points : fillPrice - target1Points;
        const target2 = computeTarget2(dir, fillPrice, target1, target1Points, structTarget, effectiveTarget2Multiple, asiaStruct);
        st.position = {
          dir, entryIdx: i + 1, entryPrice: fillPrice, entryType, stopPrice, tightStopPrice, smartHoldChecked: false, target1, target2, target1Points, contracts, leg1Size, leg2Size,
          source, grade, waitedBars: 0, leg1Closed: false, leg2Closed: false, leg3Closed: false, profitLocked: false, profitLocked2: false,
        };
      } else {
        // Same as the MARKET branch above — real structural stop, trusted outright.
        const { stopPrice, tightStopPrice } = applySmartHoldLive(entryPriceP, stopPriceRaw, dir);
        const contracts = sizeForStop(mac, Math.abs(entryPriceP - stopPriceRaw));
        const leg1Size = leg1SizeForContracts(contracts);
        const leg2Size = leg2SizeForContracts(contracts, leg1Size);
        const target1Points = effectiveTarget1DollarGoal / (leg1Size * pointValue);
        const target1 = dir === 1 ? entryPriceP + target1Points : entryPriceP - target1Points;
        const target2 = computeTarget2(dir, entryPriceP, target1, target1Points, structTarget, effectiveTarget2Multiple, asiaStruct);
        st.pending = { dir, entryType, entryPrice: entryPriceP, stopPrice, tightStopPrice, target1, target2, target1Points, contracts, leg1Size, leg2Size, source, grade, signalIdx: i };
      }
    } else if (sweepEntry) {
      // Pull back into the signal candle's own range instead of chasing its
      // close/breakout. bar == the just-closed signal candle (chartBars[i]).
      // Sized off its own fixed dollar budget (sweepContracts) regardless of
      // riskBudgetedSizing — this path already is risk-budgeted, just via a
      // different, pre-existing mechanism.
      const range = bar.h - bar.l;
      const entryPriceP = dir === 1 ? bar.h - range * sweepPullbackPct : bar.l + range * sweepPullbackPct;
      const sweepStopPoints = (sweepStopBudgetDollars / pointValue) / sweepContracts;
      const stopPrice = dir === 1 ? entryPriceP - sweepStopPoints : entryPriceP + sweepStopPoints;
      const contracts = sweepContracts;
      const leg1Size = leg1SizeForContracts(contracts);
      const leg2Size = leg2SizeForContracts(contracts, leg1Size);
      const target1Points = effectiveTarget1DollarGoal / (leg1Size * pointValue);
      const target1 = dir === 1 ? entryPriceP + target1Points : entryPriceP - target1Points;
      const target2 = computeTarget2(dir, entryPriceP, target1, target1Points, null, effectiveTarget2Multiple, asiaStruct);
      st.pending = { dir, entryType: 'LIMIT', entryPrice: entryPriceP, stopPrice, target1, target2, target1Points, contracts, leg1Size, leg2Size, source, grade, signalIdx: i };
    } else {
      const fillPrice = nextBar.o;
      const atrRef = lv.atrRef || mac.atrVal || (Math.abs(bar.h - bar.l) * 2) || 1;
      const risk = atrRef * 0.5;
      const stopPriceRaw = dir === 1 ? fillPrice - risk : fillPrice + risk;
      const tightStop = capStop(fillPrice, stopPriceRaw, dir, stopCapPoints, effectiveStopMultiple);
      const { stopPrice, tightStopPrice } = applySmartHoldLive(fillPrice, tightStop, dir);
      const contracts = sizeForStop(mac, Math.abs(fillPrice - tightStop));
      const leg1Size = leg1SizeForContracts(contracts);
      const leg2Size = leg2SizeForContracts(contracts, leg1Size);
      const target1Points = effectiveTarget1DollarGoal / (leg1Size * pointValue);
      const target1 = dir === 1 ? fillPrice + target1Points : fillPrice - target1Points;
      const target2 = computeTarget2(dir, fillPrice, target1, target1Points, null, effectiveTarget2Multiple, asiaStruct);
      st.position = {
        dir, entryIdx: i + 1, entryPrice: fillPrice, entryType: 'MARKET', stopPrice, tightStopPrice, smartHoldChecked: false, target1, target2, target1Points, contracts, leg1Size, leg2Size,
        source, grade, waitedBars: 0, leg1Closed: false, leg2Closed: false, leg3Closed: false, profitLocked: false, profitLocked2: false,
      };
    }
  }

  return trades;
}

module.exports = {
  simulateAllTimeframes3Leg,
  // Exported so live-executor.js can build target2 the identical way, without
  // duplicating (and risking drift from) this exact rule.
  computeTarget2,
  // Exported so lib/liveStateMachine.js's maybeRatchetTrail can apply the
  // IDENTICAL mechanical runner-trail rule, without duplicating (and risking
  // drift from) this exact math.
  MECH_TRAIL_LOCK_DOLLARS, roundTrailStopConservative,
};
