'use strict';
// r9.10 CURRENT-PERIOD COMPLETION (Mac 10/20: "None of our data should be coming back as stale or unknown, we're not guessing where price is").
// At a period boundary the provider can return a higher-timeframe series whose newest bar is still the PREVIOUS period (the new bar is created
// only after its first trade reaches the bar service). Every open read from that series (15m/30m/1H/4H Open levels, the alignment slots) is then
// the previous period's open - stale. The open of the new period is not unknown: it is the first trade of that period, already present in the
// finer bars of the SAME poll. This builds the missing current bar from those real bars:
//   for each target TF (M5, M15, M30, H1, H4): expected start = lib/alignmentFreshness expectedPeriodStart (H4 on the 15:00 PT session anchor).
//   If the series has no bar at that start, take the FINEST series of this poll (M3, then M5, then M15) that HAS a bar starting exactly at
//   that start, and append { t: start, o: first.o, h: max, l: min, c: last.c, v: sum } over its bars from that start - marked derived.
// (Only when the provider's newest bar has ended by the expected start, and only from a finer bar that starts EXACTLY at it.)
// No finer bar inside the period = no trade yet in the period: nothing is invented (the series is unchanged,
// the same thing the TradingView indicator shows until the new bar's first trade). Inputs are never mutated; outside market hours: unchanged.
const { expectedPeriodStart, marketOpenAt, TF_MS } = require('./alignmentFreshness');
const TARGETS = ['M5', 'M15', 'M30', 'H1', 'H4'], SOURCES = ['M3', 'M5', 'M15'];
function completeCurrentPeriods(htf, nowMs) {
  const derived = [];
  if (!htf || typeof htf !== 'object' || !Number.isSafeInteger(nowMs) || !marketOpenAt(nowMs)) return { htf, derived };
  const out = { ...htf };
  // MacDot 6297111941: duplicate or future-dated provider bars never feed a derived bar
  // MacDot 6297275089: a timestamp delivered twice with DIFFERENT values is conflicting evidence - every copy is dropped (never first-wins),
  // so a conflicting bar at the period start proves nothing; identical repeats collapse to one.
  const sig = b => [b.o, b.h, b.l, b.c].join('|');
  const clean = a => { const by = new Map(); for (const b of a || []) { if (!b || !Number.isFinite(b.t) || b.t > nowMs) continue; const k = by.get(b.t); by.set(b.t, k === undefined ? b : (k && sig(k) === sig(b) ? k : null)); }
    return [...by.values()].filter(Boolean).sort((x, y) => x.t - y.t); };
  for (const k of TARGETS) {
    const ser = out[k];
    if (!Array.isArray(ser) || !ser.length) continue;
    const start = expectedPeriodStart(k, nowMs), last = ser[ser.length - 1];
    if (!Number.isFinite(start) || !last || !(last.t < start)) continue;   // current bar present (or a newer one): untouched
    // review r9.10 B1: only when the provider's newest bar has ENDED by the expected start. A provider bar that still covers `start` (its grid
    // differs from ours, e.g. a fixed UTC H4 grid after a DST change) is the provider's current bar: never add an overlapping one.
    if (last.t + TF_MS[k] > start) continue;
    // MacDot 6297069784: the open is PROVEN only by a finer bar that starts EXACTLY at the period start (its open is the period's first trade).
    // A first in-period bar that starts later cannot prove there was no earlier trade (provider gap vs no trading), so it is never used: the
    // finest source WITH a bar exactly at the start wins; none = nothing derived (the decision row then labels PREV_PERIOD_NO_TRADE_YET).
    let best = null;
    for (const s of SOURCES) {
      if (s === k || !(TF_MS[s] < TF_MS[k])) continue;
      const src = clean(out[s]); if (!src.length) continue;
      const i = src.findIndex(b => b && b.t === start);
      if (i < 0) continue;
      const seg = src.slice(i).filter(b => b && b.t < start + TF_MS[k] && [b.o, b.h, b.l, b.c].every(Number.isFinite));
      if (seg.length && seg[0].t === start) { best = { s, seg }; break; }
    }
    if (best) {
      const seg = best.seg, bar = { t: start, o: seg[0].o, h: Math.max(...seg.map(b => b.h)), l: Math.min(...seg.map(b => b.l)), c: seg[seg.length - 1].c,
        v: seg.reduce((a, b) => a + (Number.isFinite(b.v) ? b.v : 0), 0), derived: true, derivedFrom: best.s };
      out[k] = [...ser, bar];
      derived.push({ tf: k, start, from: best.s, o: bar.o });
    }
  }
  return { htf: out, derived };
}
module.exports = { completeCurrentPeriods, TARGETS, SOURCES };
