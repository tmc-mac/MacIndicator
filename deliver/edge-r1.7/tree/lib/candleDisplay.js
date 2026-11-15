'use strict';
// Display only: where price sat inside each forming 15m / 30m / 1H bar at the moment that timeframe was last fetched.
// OHLC cannot show whether the high or the low printed first, so this reports position and side of open only.
// Never consumed by an entry, sizing, gate or transport path.
const SLOTS = [['M15', 15], ['M30', 30], ['H1', 60]];
const MAX_READ_AGE_MS = 3 * 60000;   // a read older than this is shown as UNKNOWN, not as the current position
const num = v => typeof v === 'number' && Number.isFinite(v);
function slot(bars, minutes, readAt, now) {
  const b = Array.isArray(bars) ? bars[bars.length - 1] : null;
  if (!b || ![b.t, b.o, b.h, b.l, b.c].every(num)) return { status: 'UNKNOWN', reason: 'missing-or-malformed-bar' };
  if (!(b.l <= Math.min(b.o, b.c) && Math.max(b.o, b.c) <= b.h)) return { status: 'UNKNOWN', reason: 'incoherent-ohlc' };
  if (!num(now)) return { status: 'UNKNOWN', reason: 'no-clock' };
  if (!num(readAt)) return { status: 'UNKNOWN', reason: 'no-read-time' };
  if (readAt > now) return { status: 'UNKNOWN', reason: 'read-time-in-future' };
  if (now - readAt > MAX_READ_AGE_MS) return { status: 'UNKNOWN', reason: 'stale-read', readAt };
  const end = b.t + minutes * 60000;
  if (readAt < b.t || readAt >= end) return { status: 'UNKNOWN', reason: 'read-outside-bar', readAt };
  if (now >= end) return { status: 'UNKNOWN', reason: 'bar-closed-since-read', readAt };
  const range = b.h - b.l;
  return { status: 'CURRENT', minutes, barStart: b.t, barEnd: end, readAt,
    elapsedMin: Math.floor((readAt - b.t) / 60000),   // minutes into the bar at the read, not at render
    open: b.o, high: b.h, low: b.l, last: b.c,
    rangePct: range > 0 ? Math.round(((b.c - b.l) / range) * 100) : null,
    vsOpen: b.c > b.o ? 'above' : b.c < b.o ? 'below' : 'at' };
}
// readAt: { M15, M30, H1 } = when each timeframe's bars were actually fetched (a cached timeframe keeps its older time).
function candlePositionSnapshot(ctlBars, readAt, now = Date.now()) {
  const out = { maxReadAgeMs: MAX_READ_AGE_MS, slots: {} };
  for (const [tf, minutes] of SLOTS) out.slots[tf] = slot(ctlBars ? ctlBars[tf] : null, minutes, readAt ? readAt[tf] : null, now);
  return out;
}
module.exports = { candlePositionSnapshot, MAX_READ_AGE_MS };
