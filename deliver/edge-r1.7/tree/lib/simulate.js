const { ptInfo } = require('./helpers');

// NY session opens at 6:30 AM Pacific (9:30 AM ET) — the same clock boundary
// both indicators already anchor their own NY-session concepts to (06:30
// Open, session VWAP, Initial Balance). `blockNyOpenMinutes` (default 30)
// blocks new entries from that open until this many minutes past it, so the
// bot doesn't trade into the open and instead lets the first candles develop.
const NY_OPEN_MINUTES = 6 * 60 + 30;
function inNyOpenBlackout(ts, blockMinutes) {
  if (!blockMinutes) return false;
  const minutesOfDay = ptInfo(ts).minutesOfDay;
  return minutesOfDay >= NY_OPEN_MINUTES && minutesOfDay < NY_OPEN_MINUTES + blockMinutes;
}

// Backtesting showed leg 1's win rate (69%) looks great in isolation but is
// actually BELOW breakeven for its own risk/reward: its stop (Levels PRO's
// full structural stop, ATR-based) runs ~2.7x wider than its fixed 15-point
// target, so leg 1 was a net -$1,312 drag even while "winning" most of the
// time. `leg1StopCapMultiple`, when set, caps how far the STOP can be from
// entry during the leg-1 phase to `target1Points * multiple` — e.g. 2.0 caps
// a 15-point target's stop at 30 points instead of whatever the structural
// stop happens to be. Only affects the pre-breakeven phase; leg 2's stop is
// already overridden to breakeven once leg 1 closes regardless.
function capStop(entryPrice, stopPrice, dir, target1Points, multiple) {
  if (!multiple) return stopPrice;
  const maxDist = target1Points * multiple;
  const actualDist = dir === 1 ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (actualDist <= maxDist) return stopPrice;
  return dir === 1 ? entryPrice - maxDist : entryPrice + maxDist;
}

// Asia session starts at 3:00 PM Pacific (same boundary both indicators use
// for is_asia/asia_start). `asiaBlockUntilMinutes` (default 17:00 PT, i.e.
// 5:00 PM) blocks new entries from the Asia open until that clock time —
// not the whole Asia session, just its early, thinly-traded hours right
// after the NY session winds down.
const ASIA_START_MINUTES = 15 * 60;
function inAsiaBlackout(ts, blockUntilMinutes) {
  if (blockUntilMinutes == null) return false;
  const minutesOfDay = ptInfo(ts).minutesOfDay;
  return minutesOfDay >= ASIA_START_MINUTES && minutesOfDay < blockUntilMinutes;
}

// Trade simulator: walks the aligned MAC Trap Machine + Levels PRO output
// arrays bar-by-bar and simulates taking every qualifying signal. Every
// trade is 2 contracts:
//   - Leg 1 (1 contract) targets a fixed DOLLAR goal (default $30, tunable
//     between the $20-40/hr range) — entry ± (dollarGoal / pointValue).
//     Purely math-based, independent of level structure.
//   - Once leg 1 closes, leg 2 (1 contract)'s stop moves to breakeven and
//     then TRAILS: every time price closes beyond an institutional level
//     further than the current trail stop, the stop ratchets up to that
//     level. No fixed target — it rides until the trail catches it or
//     `maxHoldBars` forces a timeout.
//
// Entry rule (per your instructions):
//   - No C-grade trades. MAC only counts at score >= minMacScore (default 7,
//     i.e. grade B or better). Levels PRO's own sig_long/sig_short is already
//     gated at grade B+ internally.
//   - Either indicator's strong read is enough on its own — they don't have
//     to agree. If they DO agree, that's tagged 'both-agree'.
//   - If Levels PRO has a valid structural plan in the matching direction,
//     its entry/entryType/stop are used (target is overridden by the
//     dollar-based leg-1 rule above). If only MAC's score/bias qualifies
//     with no Levels PRO plan, a synthetic ATR-based stop is used instead —
//     tagged 'mac-only'.
//
// Execution model:
//   - A signal confirmed at bar i's CLOSE can only act starting bar i+1.
//   - MARKET plans fill at bar i+1's open. LIMIT/STOP plans become a
//     RESTING order at the plan's exact entry price and only fill once
//     price actually trades there. An order never touched expires after
//     `pendingExpireBars` bars.
//   - `sameBarAssumption` controls what happens when a single bar's range
//     touches both the active stop and target1: 'conservative' (default)
//     assumes the stop hit first, 'optimistic' assumes the target did. Run
//     both and compare — the gap between them tells you how much this
//     assumption (unavoidable with OHLC-only data) is actually costing,
//     versus a real edge problem.
//   - Each leg is recorded as its own 1-contract trade, so total $ P&L for
//     a round trip is just the sum of its two leg records.
//   - If `fineBars` (e.g. 5-minute bars) are supplied, a same-bar ambiguity
//     is resolved for real by looking inside the chart bar at finer
//     resolution to see which threshold actually got touched first, instead
//     of guessing between the conservative/optimistic assumption. This only
//     matters — and only runs — for bars that are actually ambiguous, and
//     falls back to `sameBarAssumption` if the fine data doesn't cover that
//     period or is itself still ambiguous at that resolution.

function findFineBarsInWindow(fineBars, startMs, endMs) {
  if (!fineBars || !fineBars.length) return [];
  let lo = 0, hi = fineBars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (fineBars[mid].t < startMs) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let k = lo; k < fineBars.length && fineBars[k].t < endMs; k++) out.push(fineBars[k]);
  return out;
}

function resolveIntrabar(fineBars, chartBarStart, tfMs, dir, stopPrice, targetPrice) {
  const relevant = findFineBarsInWindow(fineBars, chartBarStart, chartBarStart + tfMs);
  if (!relevant.length) return null;
  for (const fb of relevant) {
    const hitStop = dir === 1 ? fb.l <= stopPrice : fb.h >= stopPrice;
    const hitTarget = dir === 1 ? fb.h >= targetPrice : fb.l <= targetPrice;
    if (hitStop) return 'stop'; // still conservative at the finest resolution we have, if a fine bar itself is ambiguous
    if (hitTarget) return 'target';
  }
  return null;
}

// Finds the price at the finest resolution available (5-minute fine bars)
// where `level` was actually crossed within this 15m bar, instead of
// assuming a market-order exit happened at the full bar's close. A real
// live system polls roughly every 20 seconds, so it reacts to a crossing far
// sooner than a full 15-minute bar close would suggest — using the bar's
// close as the exit price would systematically understate a fast-reacting
// exit. Falls back to `fallbackClose` if no fine bars cover this window.
function findCrossPrice(fineBars, chartBarStart, tfMs, dir, level, fallbackClose) {
  const relevant = findFineBarsInWindow(fineBars, chartBarStart, chartBarStart + tfMs);
  for (const fb of relevant) {
    const crossed = dir === 1 ? fb.l <= level : fb.h >= level;
    if (crossed) return fb.c;
  }
  return fallbackClose;
}

function simulateTimeframe({
  tf, chartBars, macOut, levelsOut, pointValue,
  warmupBars = 300, maxHoldBars = 200, pendingExpireBars = 20,
  minMacScore = 7, target1DollarGoal = 30, sameBarAssumption = 'conservative',
  fineBars = null, tfMs = null, requireLevelsAlignment = false, blockNyOpenMinutes = 30,
  asiaBlockUntilMinutes = 17 * 60, leg1StopCapMultiple = null,
}) {
  const trades = [];
  let fineResolvedCount = 0, fineUnresolvedCount = 0;
  const effTfMs = tfMs || (chartBars[1] ? chartBars[1].t - chartBars[0].t : 900000);
  let position = null;
  let pending = null;
  const target1Points = target1DollarGoal / pointValue;

  function pushLeg(pos, exitPrice, exitReason, exitIdx, leg) {
    const pnlPoints = pos.dir === 1 ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    trades.push({
      tf, dir: pos.dir, source: pos.source, grade: pos.grade, entryType: pos.entryType, leg,
      entryTime: chartBars[pos.entryIdx].t, entryPrice: pos.entryPrice,
      exitTime: chartBars[exitIdx].t, exitPrice, exitReason,
      barsHeld: exitIdx - pos.entryIdx, waitedBars: pos.waitedBars || 0,
      pnlPoints, pnlDollars: pnlPoints * pointValue,
    });
  }

  for (let i = warmupBars; i < chartBars.length; i++) {
    const bar = chartBars[i];

    // ── 1. Manage an open position ──
    if (position) {
      if (!position.leg1Closed) {
        const hitStop = position.dir === 1 ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;
        const hitTarget1 = position.dir === 1 ? bar.h >= position.target1 : bar.l <= position.target1;
        if (hitStop && hitTarget1) {
          const resolved = resolveIntrabar(fineBars, bar.t, effTfMs, position.dir, position.stopPrice, position.target1);
          if (resolved) fineResolvedCount++; else fineUnresolvedCount++;
          if (resolved === 'target') {
            pushLeg(position, position.target1, 'target1 (resolved via fine bars)', i, 1);
            position.leg1Closed = true;
            position.trailStop = position.entryPrice;
          } else if (resolved === 'stop') {
            pushLeg(position, position.stopPrice, 'stop (resolved via fine bars)', i, 1);
            pushLeg(position, position.stopPrice, 'stop (resolved via fine bars)', i, 2);
            position = null;
          } else if (sameBarAssumption === 'optimistic') {
            pushLeg(position, position.target1, 'target1 (both hit - optimistic, no fine data)', i, 1);
            position.leg1Closed = true;
            position.trailStop = position.entryPrice;
          } else {
            pushLeg(position, position.stopPrice, 'stop (both hit - conservative, no fine data)', i, 1);
            pushLeg(position, position.stopPrice, 'stop (both hit - conservative, no fine data)', i, 2);
            position = null;
          }
        } else if (hitTarget1) {
          pushLeg(position, position.target1, 'target1', i, 1);
          position.leg1Closed = true;
          position.trailStop = position.entryPrice;
        } else if (hitStop) {
          pushLeg(position, position.stopPrice, 'stop', i, 1);
          pushLeg(position, position.stopPrice, 'stop', i, 2);
          position = null;
        } else if ((i - position.entryIdx) >= maxHoldBars) {
          pushLeg(position, bar.c, 'timeout', i, 1);
          pushLeg(position, bar.c, 'timeout', i, 2);
          position = null;
        }
      } else {
        // Leg 2: trailing stop through cleared institutional levels, no fixed target.
        const hitStop = position.dir === 1 ? bar.l <= position.trailStop : bar.h >= position.trailStop;
        if (hitStop) {
          const reason = position.trailStop === position.entryPrice ? 'breakeven stop' : 'trailing stop';
          pushLeg(position, position.trailStop, reason, i, 2);
          position = null;
        } else if ((i - position.entryIdx) >= maxHoldBars) {
          pushLeg(position, bar.c, 'timeout', i, 2);
          position = null;
        } else {
          // Ratchet the stop forward using levels this bar's CLOSE has cleared —
          // checked against the OLD stop above first, so this can't stop the
          // trade out on the same bar it ratchets (no lookahead into the future,
          // no self-inflicted same-bar stop from the update itself).
          const lv = levelsOut[i];
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
      continue;
    }

    // ── 2. Manage a resting (not-yet-filled) LIMIT/STOP order ──
    if (pending) {
      let filled = false;
      if (pending.entryType === 'LIMIT') {
        if (pending.dir === 1 && bar.l <= pending.entryPrice) filled = true;
        if (pending.dir === -1 && bar.h >= pending.entryPrice) filled = true;
      } else if (pending.entryType === 'STOP') {
        if (pending.dir === 1 && bar.h >= pending.entryPrice) filled = true;
        if (pending.dir === -1 && bar.l <= pending.entryPrice) filled = true;
      }
      if (filled) {
        position = {
          dir: pending.dir, entryIdx: i, entryPrice: pending.entryPrice, entryType: pending.entryType,
          stopPrice: pending.stopPrice, target1: pending.target1,
          source: pending.source, grade: pending.grade, waitedBars: i - pending.signalIdx, leg1Closed: false,
        };
        pending = null;
        continue;
      }
      if (i - pending.signalIdx >= pendingExpireBars) {
        pending = null;
      } else {
        continue;
      }
    }

    // ── 3. Look for a new signal (only when flat and nothing pending) ──
    if (inNyOpenBlackout(bar.t, blockNyOpenMinutes)) continue; // let the open develop before trading it
    if (inAsiaBlackout(bar.t, asiaBlockUntilMinutes)) continue; // skip the thin early-Asia hours
    if (i + 1 >= chartBars.length) continue;
    const mac = macOut[i], lv = levelsOut[i];
    if (!mac || !lv) continue;

    const macDirRaw = ((mac.activeDir === 1 && mac.activeScore >= minMacScore) || mac.biasStr === 'STRONG BULL') ? 1
      : ((mac.activeDir === -1 && mac.activeScore >= minMacScore) || mac.biasStr === 'STRONG BEAR') ? -1 : 0;
    // mac.hardBlock (late buyer/seller exhaustion, the 06:30 news window, or
    // VIX) already zeroes out entryGrade, but activeDir/activeScore are
    // computed BEFORE that gate — without this check a "late buyers" bar
    // could still fire a directional signal with a worthless grade.
    const macDir = mac.hardBlock ? 0 : macDirRaw;
    // requireLevelsAlignment: only take a Levels PRO signal when its own
    // 15m/1H/4H alignment tracker says all three actually agree — the
    // literal version of "wait until other timeframes line up" instead of
    // just rewarding alignment in the grade like the indicator does by default.
    const lvGateOk = !requireLevelsAlignment || lv.alignedFull;
    const lvDirRaw = !lvGateOk ? 0 : lv.sigLong ? 1 : lv.sigShort ? -1
      : lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1 : 0;
    // levels-sourced signals used to ignore mac.hardBlock entirely even
    // though mac-sourced ones are zeroed by it above — a levels trade could
    // still fire on a "late buyers"/"late sellers"/VIX/news-window bar. Gated
    // the same way now, so backtest matches the live executor's own fix.
    const lvDir = (mac.hardBlock || mac.chopSkip) ? 0 : lvDirRaw;

    let dir = 0, source = null, grade = null;
    // Re-tested 2026-09-23: allowing full agreement outperformed skipping it
    // (avg/day $925.88 vs $717.10, same worst day) — only a genuine CONFLICT
    // (opposite directions) is skipped now. mac.hardBlock above already
    // zeroed macDir/lvDir whenever the move is genuinely overextended, so
    // that exhaustion protection is untouched by this.
    if (macDir !== 0 && lvDir !== 0 && macDir !== lvDir) { continue; }
    else if (macDir !== 0 && lvDir !== 0) { dir = macDir; source = (lv.plan && lv.plan.dir === dir) ? 'levels' : 'mac'; grade = (lv.plan && lv.plan.dir === dir) ? lv.plan.grade : mac.entryGrade; }
    else if (lvDir !== 0) { dir = lvDir; source = 'levels'; grade = (lv.plan && lv.plan.dir === dir) ? lv.plan.grade : null; }
    else if (macDir !== 0) { dir = macDir; source = 'mac'; grade = mac.entryGrade; }
    if (dir === 0) continue;

    const nextBar = chartBars[i + 1];
    const planMatches = lv.plan && lv.plan.dir === dir;

    if (planMatches) {
      const { entryType, entry: entryPrice, stop: stopPriceRaw } = lv.plan;
      if (entryType === 'MARKET') {
        const fillPrice = nextBar.o;
        if (dir === 1 && stopPriceRaw >= fillPrice) continue;
        if (dir === -1 && stopPriceRaw <= fillPrice) continue;
        const stopPrice = capStop(fillPrice, stopPriceRaw, dir, target1Points, leg1StopCapMultiple);
        const target1 = dir === 1 ? fillPrice + target1Points : fillPrice - target1Points;
        position = { dir, entryIdx: i + 1, entryPrice: fillPrice, entryType, stopPrice, target1, source, grade, waitedBars: 0, leg1Closed: false };
      } else {
        const stopPrice = capStop(entryPrice, stopPriceRaw, dir, target1Points, leg1StopCapMultiple);
        const target1 = dir === 1 ? entryPrice + target1Points : entryPrice - target1Points;
        pending = { dir, entryType, entryPrice, stopPrice, target1, source, grade, signalIdx: i };
      }
    } else {
      // MAC-only signal, no structural plan — synthetic ATR-based stop, same dollar-based target1.
      const fillPrice = nextBar.o;
      const atrRef = lv.atrRef || mac.atrVal || (Math.abs(bar.h - bar.l) * 2) || 1;
      const risk = atrRef * 0.5;
      const stopPriceRaw = dir === 1 ? fillPrice - risk : fillPrice + risk;
      const stopPrice = capStop(fillPrice, stopPriceRaw, dir, target1Points, leg1StopCapMultiple);
      const target1 = dir === 1 ? fillPrice + target1Points : fillPrice - target1Points;
      position = { dir, entryIdx: i + 1, entryPrice: fillPrice, entryType: 'MARKET', stopPrice, target1, source, grade, waitedBars: 0, leg1Closed: false };
    }
  }

  // Attached rather than changed to an object return, so `trades` stays a
  // plain array everywhere it's already used (summarize(), .length, concat).
  trades.fineResolvedCount = fineResolvedCount;
  trades.fineUnresolvedCount = fineUnresolvedCount;
  return trades;
}

function summarize(trades) {
  const bySource = {};
  for (const t of trades) {
    const key = t.source;
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(t);
  }
  function stats(list) {
    if (!list.length) return null;
    const wins = list.filter(t => t.pnlDollars > 0);
    const losses = list.filter(t => t.pnlDollars <= 0);
    const totalPnl = list.reduce((s, t) => s + t.pnlDollars, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlDollars, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlDollars, 0) / losses.length : 0;
    const grossWin = wins.reduce((s, t) => s + t.pnlDollars, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of list) { equity += t.pnlDollars; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); }
    return {
      count: list.length, winRate: wins.length / list.length,
      avgWin, avgLoss, expectancy: totalPnl / list.length,
      totalPnl, profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDrawdown: maxDD,
    };
  }
  const result = { overall: stats(trades) };
  for (const key of Object.keys(bySource)) result[key] = stats(bySource[key]);
  return result;
}

// Runs all three timeframe instances INTERLEAVED in true chronological
// order, sharing one daily-loss counter across all of them — because a bad
// day on 15m and a bad day on 1H both draw against the same account. Once
// the day's REALIZED (closed) P&L drops to -dailyStopLoss, no new trades are
// opened on ANY timeframe until the next trading day rolls over. Positions
// already open when the stop triggers are left to close normally (stop,
// target, or trail) — the breaker only blocks new entries, matching the
// idea of not "spiraling" into more risk after a bad stretch, not
// force-flattening winners or partial trades mid-course.
//
// Simplification worth knowing: this gates on REALIZED P&L only (closed
// trades), not floating/unrealized P&L on positions still open — a large
// open loss doesn't count against the daily stop until it actually closes.
function simulateAllTimeframes(timeframeConfigs, {
  pointValue, warmupBars = 300, maxHoldBars = 200, pendingExpireBars = 20,
  minMacScore = 7, target1DollarGoal = 30, dailyStopLoss = 400, requireLevelsAlignment = false,
  blockNyOpenMinutes = 30, asiaBlockUntilMinutes = 17 * 60, leg1StopCapMultiple = null,
} = {}) {
  const { tradingDayKey } = require('./dailyRisk');
  const target1Points = target1DollarGoal / pointValue;
  const trades = [];

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

  let currentDayKey = null, dayRealizedPnl = 0, dayBlocked = false;

  function pushLeg(st, pos, exitPrice, exitReason, exitIdx, leg) {
    const pnlPoints = pos.dir === 1 ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnlDollars = pnlPoints * pointValue;
    trades.push({
      tf: st.tf, dir: pos.dir, source: pos.source, grade: pos.grade, entryType: pos.entryType, leg,
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
    if (dayKey !== currentDayKey) { currentDayKey = dayKey; dayRealizedPnl = 0; dayBlocked = false; }
    if (dayRealizedPnl <= -dailyStopLoss) dayBlocked = true;

    if (st.position) {
      const position = st.position;
      if (!position.leg1Closed) {
        const hitStop = position.dir === 1 ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;
        const hitTarget1 = position.dir === 1 ? bar.h >= position.target1 : bar.l <= position.target1;
        if (hitStop && hitTarget1) {
          const resolved = resolveIntrabar(st.fineBars, bar.t, st.tfMs, position.dir, position.stopPrice, position.target1);
          if (resolved === 'target') {
            pushLeg(st, position, position.target1, 'target1 (resolved via fine bars)', i, 1);
            position.leg1Closed = true; position.trailStop = position.entryPrice;
          } else {
            pushLeg(st, position, position.stopPrice, resolved === 'stop' ? 'stop (resolved via fine bars)' : 'stop (both hit, no fine data)', i, 1);
            pushLeg(st, position, position.stopPrice, resolved === 'stop' ? 'stop (resolved via fine bars)' : 'stop (both hit, no fine data)', i, 2);
            st.position = null;
          }
        } else if (hitTarget1) {
          pushLeg(st, position, position.target1, 'target1', i, 1);
          position.leg1Closed = true; position.trailStop = position.entryPrice;
        } else if (hitStop) {
          pushLeg(st, position, position.stopPrice, 'stop', i, 1);
          pushLeg(st, position, position.stopPrice, 'stop', i, 2);
          st.position = null;
        } else if ((i - position.entryIdx) >= maxHoldBars) {
          pushLeg(st, position, bar.c, 'timeout', i, 1);
          pushLeg(st, position, bar.c, 'timeout', i, 2);
          st.position = null;
        }
      } else {
        const hitStop = position.dir === 1 ? bar.l <= position.trailStop : bar.h >= position.trailStop;
        if (hitStop) {
          pushLeg(st, position, position.trailStop, position.trailStop === position.entryPrice ? 'breakeven stop' : 'trailing stop', i, 2);
          st.position = null;
        } else if ((i - position.entryIdx) >= maxHoldBars) {
          pushLeg(st, position, bar.c, 'timeout', i, 2);
          st.position = null;
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
          stopPrice: pending.stopPrice, target1: pending.target1,
          source: pending.source, grade: pending.grade, waitedBars: i - pending.signalIdx, leg1Closed: false,
        };
        st.pending = null;
        continue;
      }
      if (i - pending.signalIdx >= pendingExpireBars) st.pending = null;
      else continue;
    }

    if (dayBlocked) continue; // daily circuit breaker — no new entries for the rest of this trading day
    if (inNyOpenBlackout(bar.t, blockNyOpenMinutes)) continue; // let the open develop before trading it
    if (inAsiaBlackout(bar.t, asiaBlockUntilMinutes)) continue; // skip the thin early-Asia hours
    if (i + 1 >= st.chartBars.length) continue;
    const mac = st.macOut[i], lv = st.levelsOut[i];
    if (!mac || !lv) continue;

    const macDirRaw = ((mac.activeDir === 1 && mac.activeScore >= minMacScore) || mac.biasStr === 'STRONG BULL') ? 1
      : ((mac.activeDir === -1 && mac.activeScore >= minMacScore) || mac.biasStr === 'STRONG BEAR') ? -1 : 0;
    const macDir = mac.hardBlock ? 0 : macDirRaw;
    const lvGateOk = !requireLevelsAlignment || lv.alignedFull;
    const lvDirRaw = !lvGateOk ? 0 : lv.sigLong ? 1 : lv.sigShort ? -1
      : lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1 : 0;
    const lvDir = (mac.hardBlock || mac.chopSkip) ? 0 : lvDirRaw;

    let dir = 0, source = null, grade = null;
    if (macDir !== 0 && lvDir !== 0 && macDir !== lvDir) { continue; }
    else if (macDir !== 0 && lvDir !== 0) { dir = macDir; source = (lv.plan && lv.plan.dir === dir) ? 'levels' : 'mac'; grade = (lv.plan && lv.plan.dir === dir) ? lv.plan.grade : mac.entryGrade; }
    else if (lvDir !== 0) { dir = lvDir; source = 'levels'; grade = (lv.plan && lv.plan.dir === dir) ? lv.plan.grade : null; }
    else if (macDir !== 0) { dir = macDir; source = 'mac'; grade = mac.entryGrade; }
    if (dir === 0) continue;

    const nextBar = st.chartBars[i + 1];
    const planMatches = lv.plan && lv.plan.dir === dir;

    if (planMatches) {
      const { entryType, entry: entryPrice, stop: stopPriceRaw } = lv.plan;
      if (entryType === 'MARKET') {
        const fillPrice = nextBar.o;
        if (dir === 1 && stopPriceRaw >= fillPrice) continue;
        if (dir === -1 && stopPriceRaw <= fillPrice) continue;
        const stopPrice = capStop(fillPrice, stopPriceRaw, dir, target1Points, leg1StopCapMultiple);
        const target1 = dir === 1 ? fillPrice + target1Points : fillPrice - target1Points;
        st.position = { dir, entryIdx: i + 1, entryPrice: fillPrice, entryType, stopPrice, target1, source, grade, waitedBars: 0, leg1Closed: false };
      } else {
        const stopPrice = capStop(entryPrice, stopPriceRaw, dir, target1Points, leg1StopCapMultiple);
        const target1 = dir === 1 ? entryPrice + target1Points : entryPrice - target1Points;
        st.pending = { dir, entryType, entryPrice, stopPrice, target1, source, grade, signalIdx: i };
      }
    } else {
      const fillPrice = nextBar.o;
      const atrRef = lv.atrRef || mac.atrVal || (Math.abs(bar.h - bar.l) * 2) || 1;
      const risk = atrRef * 0.5;
      const stopPriceRaw = dir === 1 ? fillPrice - risk : fillPrice + risk;
      const stopPrice = capStop(fillPrice, stopPriceRaw, dir, target1Points, leg1StopCapMultiple);
      const target1 = dir === 1 ? fillPrice + target1Points : fillPrice - target1Points;
      st.position = { dir, entryIdx: i + 1, entryPrice: fillPrice, entryType: 'MARKET', stopPrice, target1, source, grade, waitedBars: 0, leg1Closed: false };
    }
  }

  return trades;
}

module.exports = {
  simulateTimeframe, simulateAllTimeframes, summarize,
  // Exported so lib/simulate3leg.js can reuse the same fill/blackout/stop-cap
  // logic instead of forking it — the 2-leg path above stays byte-for-byte
  // what's already been validated against real data.
  capStop, resolveIntrabar, findCrossPrice, inNyOpenBlackout, inAsiaBlackout,
};
