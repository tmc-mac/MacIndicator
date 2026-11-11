'use strict';
// edge r1.4 (D3, RECORD ONLY): the TradeDay's closed-trade record for the snapshot: day.risk { closedNet, lowNet, fullStops, tradesToday, ... }.
// Pure: it reads the broker round trips the bot already holds (closed ones carry the broker net) and writes nothing. No gate, size, stop, target or order
// reads it; the office computes its daily-loss what-if thresholds offline from these numbers.
//   closedNet  = the sum of the broker net of every closed round trip of the trading day (what TopstepX prints per trade).
//   lowNet     = the lowest value that running closed net reached after any close of the day (round trips in exit order); null before the first close.
//   fullStops  = closed trips whose exit reason (from the bot's own journal rows) is STOP; exitUnknown = closed trips with no matched reason (not counted as stops).
//   tradesToday = every round trip of the day (closed + still open); closedTrades / openTrades split it.
const fin = v => typeof v === 'number' && Number.isFinite(v);
const r2 = v => Math.round(v * 100) / 100;
// trips: [{ closed, netPnl, exitTime, entryTime, ...anything }]; exitReasonOf(trip) -> 'STOP' | ... | null. dayStart: epoch ms of the trading day start (null = every trip given).
function dayRisk(trips, { dayStart = null, exitReasonOf = () => null, now = Date.now(), dayKey = null } = {}) {
  const list = (Array.isArray(trips) ? trips : []).filter(t => t && (dayStart == null || !fin(dayStart) || !(Date.parse(t.exitTime || t.entryTime) < dayStart)));
  const closed = list.filter(t => t.closed === true && fin(t.netPnl)).sort((a, b) => (Date.parse(a.exitTime) || 0) - (Date.parse(b.exitTime) || 0));
  let cum = 0, low = null, stops = 0, unknown = 0;
  for (const t of closed) {
    cum += t.netPnl; if (low === null || cum < low) low = cum;
    let why = null; try { why = exitReasonOf(t); } catch (e) { why = null; }
    if (why === 'STOP') stops++; else if (why == null || why === 'UNKNOWN') unknown++;
  }
  return { dayKey, closedNet: r2(cum), lowNet: low === null ? null : r2(low), fullStops: stops, tradesToday: list.length, closedTrades: closed.length, openTrades: list.length - list.filter(t => t.closed === true).length, exitUnknown: unknown, asOf: now };
}
module.exports = { dayRisk };
