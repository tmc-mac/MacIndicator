'use strict';
// np1 STRETCH CHECK (Mac 10/24). Pure, no I/O. A CLOSED-5m-BAR APPROXIMATION of MacDot's frozen definition (6380448344), versioned separately (r1.1):
// At the decision time `now`, using only CLOSED 5m bars ({ t = start ms, o, h, l, c }) and the decision price `px`:
//   displacement = dir x (px - close of the latest closed 5m bar that ended at least 15 min before now)   (so the reference is 15-20 min old)
//   hour position = (px - low) / (high - low) for a LONG, (high - px) / (high - low) for a SHORT, over the 12 latest closed 5m bars (the prior hour); not clamped,
//                   so > 1 = beyond the hour's edge (a breakout), < 0 = beyond the other edge
//   flag = 20 < displacement <= 40 AND hour position >= 0.8
// Missing / gapped / stale bars or a zero-width hour = not assessable (flag null): never a pass or a block by default.
// The diagnostics (displacement / 15m ATR, path efficiency, advancing bars, largest bar share) are tags only - nothing reads them for a decision.
const VERSION = 'stretch-5m-approx-v1';   // r1.1 (MacDot 6380641991 #4): the CLOSED-5m approximation, not the accepted exact-15-min / trailing-hour definition
const MIN_PTS = 20, MAX_PTS = 40, EDGE = 0.8;   // frozen: a different band is a new version, not a setting
const BAR = 300000, REF_MIN_AGE = 15 * 60000, REF_MAX_AGE = 20 * 60000, HOUR_BARS = 12;
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
const okBar = b => b && Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite);

function stretchFeatures({ dir, px, now, bars5, atr15 = null }) {
  const out = { version: VERSION, band: [MIN_PTS, MAX_PTS], edge: EDGE, assessable: false, why: null, flag: null, px: r2(px) };
  const no = why => Object.assign(out, { why });
  if (dir !== 1 && dir !== -1) return no('no direction');
  if (!Number.isFinite(px)) return no('no decision price');
  if (!Number.isFinite(now)) return no('no decision time');
  if (!Array.isArray(bars5)) return no('no 5m bars');
  const closed = bars5.filter(b => okBar(b) && b.t + BAR <= now).sort((a, b) => a.t - b.t);
  // the reference: latest closed bar that ended >= 15 min before now, and no more than 20 min before (a missing bar never stretches the window)
  let ref = null; for (const b of closed) if (b.t + BAR <= now - REF_MIN_AGE) ref = b;
  if (!ref) return no('no 5m bar ended 15 min before the decision');
  if (now - (ref.t + BAR) > REF_MAX_AGE) return no('the 15-min reference bar is missing (gap)');
  const hour = closed.slice(-HOUR_BARS);
  if (hour.length < HOUR_BARS) return no('fewer than 12 closed 5m bars');
  for (let i = 1; i < hour.length; i++) if (hour[i].t !== hour[i - 1].t + BAR) return no('a gap in the last hour of 5m bars');
  if (now - (hour[hour.length - 1].t + BAR) >= BAR) return no('the latest 5m bar is stale');
  const hi = Math.max(...hour.map(b => b.h)), lo = Math.min(...hour.map(b => b.l));
  if (!(hi > lo)) return no('zero-width hour range');
  const disp = dir * (px - ref.c), pos = dir === 1 ? (px - lo) / (hi - lo) : (hi - px) / (hi - lo);
  // diagnostics over the bars after the reference (closed) plus the move from the last close to px
  const run = closed.filter(b => b.t >= ref.t + BAR);
  let path = 0, prev = ref.c; for (const b of run) { path += Math.abs(b.c - prev); prev = b.c; } path += Math.abs(px - prev);
  const moves = run.map(b => dir * (b.c - b.o));
  Object.assign(out, {
    assessable: true, flag: disp > MIN_PTS && disp <= MAX_PTS && pos >= EDGE,
    refT: ref.t, refPx: ref.c, disp: r2(disp), hourHi: hi, hourLo: lo, hourPos: r2(pos),
    tags: { dispAtr15: Number.isFinite(atr15) && atr15 > 0 ? r2(disp / atr15) : null, efficiency5m: path > 0 ? r2(disp / path) : null,
      runBars: run.length, advancingBars: moves.filter(m => m > 0).length, largestBarShare: disp > 0 && moves.length ? r2(Math.max(...moves) / disp) : null },
  });
  return out;
}
module.exports = { VERSION, MIN_PTS, MAX_PTS, EDGE, stretchFeatures };
