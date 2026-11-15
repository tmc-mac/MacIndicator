// Groups simulated trades by TopstepX's actual trading day (resets 5:00 PM
// CT, same boundary the terminal uses for its own Daily Loss Limit tracking)
// and answers the real question for sizing decisions: at the current size,
// how bad were the worst days, and what happens to that worst day if
// position size were scaled up? This uses your REAL historical trade
// outcomes just resized, not a theoretical model — the actual bad days that
// happened are the ones that matter for a hard daily loss limit.
//
// Caveat worth keeping in mind: trades from all three timeframe instances
// (15m/30m/1h) are combined here as if they can all run fully independently
// and simultaneously. In live trading you'd likely want a cap on total
// concurrent open contracts across all three, so this may somewhat overstate
// how much exposure actually stacks on any given day.

function chicagoOffsetHours(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const m = s.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) : -6;
}

// Returns a stable numeric key (the trading day's start, in ms) for a
// timestamp — mirrors terminal.html's getTradingDayStart() exactly.
function tradingDayKey(ts) {
  const now = new Date(ts);
  const offset = chicagoOffsetHours(now);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const yyyy = parseInt(parts.year, 10), mm = parseInt(parts.month, 10), dd = parseInt(parts.day, 10);
  let sessionStartUTC = Date.UTC(yyyy, mm - 1, dd, 17 - offset, 0, 0);
  if (now.getTime() < sessionStartUTC) sessionStartUTC -= 86400000;
  return sessionStartUTC;
}

function analyzeDailyRisk(trades, { dllLimit = 1000, scaleFactors = [1, 1.5, 2, 3, 4, 5] } = {}) {
  const byDay = new Map();
  for (const t of trades) {
    const key = tradingDayKey(t.exitTime);
    byDay.set(key, (byDay.get(key) || 0) + t.pnlDollars);
  }
  const dailyPnls = Array.from(byDay.values());
  const numDays = dailyPnls.length;
  const avgDaily = numDays ? dailyPnls.reduce((a, b) => a + b, 0) / numDays : 0;
  const worstDay = numDays ? Math.min(...dailyPnls) : 0;
  const bestDay = numDays ? Math.max(...dailyPnls) : 0;
  const positiveDays = dailyPnls.filter(p => p > 0).length;

  const perScale = scaleFactors.map(scale => {
    const scaled = dailyPnls.map(p => p * scale);
    return {
      scale,
      avgDailyPnl: scaled.length ? scaled.reduce((a, b) => a + b, 0) / scaled.length : 0,
      worstDay: scaled.length ? Math.min(...scaled) : 0,
      bestDay: scaled.length ? Math.max(...scaled) : 0,
      dllBreaches: scaled.filter(p => p <= -dllLimit).length,
      positiveDays: scaled.filter(p => p > 0).length,
    };
  });

  return { numDays, avgDaily, worstDay, bestDay, positiveDays, dailyPnls, perScale };
}

module.exports = { tradingDayKey, analyzeDailyRisk };
