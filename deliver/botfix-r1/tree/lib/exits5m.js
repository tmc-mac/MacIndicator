'use strict';
// exits5m r1 (Mac-approved change 5; pure, no I/O). Used by live-executor.js only when CONFIG.exitOnLevelLoss is on.
//   completedBars(bars, now): the 5m bars that are FINAL in this read - the bar has ended (t + 5 min <= now) AND a later bar is in the same read
//     (the broker had already started the next bar, so the earlier one cannot change). Sorted by time, duplicates dropped. Bar times in ms.
//   levelLost(dir, level, close, tick): a completed 5m close back through the trade's trigger level against the position by at least 1 tick
//     (long: close <= level - tick; short: close >= level + tick). A wick through the level is never enough: only the close counts.
const M5 = 300000, EPS = 1e-9;
const VERSION = 'exits5m-r1';
function completedBars(bars, now) {
  const seen = new Set(), out = [];
  for (const b of (Array.isArray(bars) ? bars : [])) {
    if (!b || ![b.t, b.h, b.l, b.c].every(Number.isFinite) || seen.has(b.t)) continue;
    seen.add(b.t); out.push(b);
  }
  out.sort((a, b) => a.t - b.t);
  const lastT = out.length ? out[out.length - 1].t : -Infinity;
  return out.filter(b => b.t < lastT && b.t + M5 <= now);
}
function levelLost(dir, level, close, tick) {
  if (!(dir === 1 || dir === -1) || !Number.isFinite(level) || !Number.isFinite(close) || !(tick > 0)) return false;
  return dir * (close - level) <= -tick + EPS;
}
module.exports = { VERSION, M5, completedBars, levelLost };
