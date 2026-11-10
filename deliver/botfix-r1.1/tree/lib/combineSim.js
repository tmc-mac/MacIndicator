// Simulates actually passing a Topstep Trading Combine from a sequence of
// REAL historical daily P&Ls — not a proxy like avg/day, the real mechanics:
// a profit target that auto-scales if one day gets too large a share of it
// (the 55% consistency rule), and a trailing Maximum Loss Limit that rises
// with realized balance but locks permanently once starting balance is
// reached (verified against Topstep's own help-center docs, 2026-09-21).
//
// This exists because "maximize avg/day" and "reach the eval target fastest"
// are NOT the same question. An eval only needs to clear a fixed dollar
// target once, respecting the consistency cap — it doesn't care about
// smoothness for its own sake the way a funded/live account does. So the
// right metric for "should we press the gas during evals" is DAYS TO PASS,
// computed against the real rule, not a generic risk-adjusted score.
const { tradingDayKey } = require('./dailyRisk');

function simulateCombinePass(trades, { startingBalance, profitTarget, mllLimit, consistencyPct = 0.55 }) {
  const byDay = new Map();
  for (const t of trades) {
    const key = tradingDayKey(t.exitTime);
    byDay.set(key, (byDay.get(key) || 0) + t.pnlDollars);
  }
  const days = Array.from(byDay.entries()).sort((a, b) => a[0] - b[0]);

  let balance = startingBalance;
  let peakForFloor = startingBalance; // capped at startingBalance once reached — MLL "locks permanently"
  let bestDay = 0;
  let blownOnDay = null;
  let passedOnDay = null;
  let daysElapsed = 0;

  for (const [dayKey, dayPnl] of days) {
    daysElapsed++;
    balance += dayPnl;
    if (dayPnl > bestDay) bestDay = dayPnl;

    peakForFloor = Math.min(Math.max(peakForFloor, balance), startingBalance);
    const floor = peakForFloor - mllLimit;
    if (balance <= floor && blownOnDay == null) {
      blownOnDay = daysElapsed;
      break; // account closes permanently — nothing after this matters
    }

    const profitSoFar = balance - startingBalance;
    // Consistency rule: if the best single day so far exceeds consistencyPct
    // of what's needed, the required total scales up so that day never
    // represents more than consistencyPct of the total — recomputed fresh
    // each day since bestDay can only grow, never shrink.
    const requiredTarget = Math.max(profitTarget, bestDay / consistencyPct);
    if (profitSoFar >= requiredTarget && passedOnDay == null) {
      passedOnDay = { day: daysElapsed, requiredTarget, profitSoFar };
    }
  }

  return {
    totalDays: days.length,
    blownOnDay,
    passedOnDay,
    finalBalance: balance,
    bestDay,
  };
}

module.exports = { simulateCombinePass };
