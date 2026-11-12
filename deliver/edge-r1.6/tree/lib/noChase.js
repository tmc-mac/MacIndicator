// NO-CHASE FILTER (2026-10-16, owner: "don't get caught selling impulsive lows before the lower high"; spec hft/ops/tests/no-chase.md, definitions).
// Pure, no I/O. Swings = confirmed 15m fractal pivots, the same rule as casebook2/lib/waves-lib.js (K = 2: a swing low counts only once 2 LATER
// closed 15m bars have a higher low - i.e. it is known on the close of the 2nd bar after it), alternating zigzag points (a more extreme same-side
// pivot before any opposite swing extends the last point). CLOSED bars only for swings: no lookahead.
// (ROUND 2 text, superseded by the ROUND 4 redesign below) A signal was a CHASE when ALL hold:
//   (1) it is in the direction of the current leg: SHORT while the last confirmed swing is a lower high (LH) = a down leg from it; LONG while the last
//       confirmed swing is a higher low (HL) = an up leg from it;
//   (2) E = |entry - that swing| >= k x ATR(14) on 15m;
//   (3) the leg has not yet retraced >= 38.2% of its size (swing -> leg extreme so far; the extreme may come from the forming bar's intrabar range).
// Anything missing (too few bars, no ATR, no swing) = NOT a chase (fail-open: the filter never blocks everything).

function atr14(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  let a = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (!Number.isFinite(tr)) return null;
    if (i <= n) { a = (a || 0) + tr / n; } else a = (a * (n - 1) + tr) / n;   // Wilder
  }
  return Number.isFinite(a) && a > 0 ? a : null;
}

function label(side, p, prev) { if (!prev) return side; if (side === 'H') return p > prev.p ? 'HH' : p < prev.p ? 'LH' : 'EH'; return p < prev.p ? 'LL' : p > prev.p ? 'HL' : 'EL'; }

// waves-lib.js WaveTF section 1, batch form: returns the alternating swing points [{ side 'H'|'L', p, j, t, label }] known after the last bar's close.
function swings(bars, K = 2) {
  const pts = [];
  for (let i = 2 * K; i < bars.length; i++) {
    const j = i - K; let isH = true, isL = true;
    for (let q = 1; q <= K; q++) { if (!(bars[j].h > bars[j - q].h && bars[j].h >= bars[j + q].h)) isH = false; if (!(bars[j].l < bars[j - q].l && bars[j].l <= bars[j + q].l)) isL = false; }
    let grp = [];
    if (isH) grp.push({ side: 'H', p: bars[j].h, j }); if (isL) grp.push({ side: 'L', p: bars[j].l, j });
    if (grp.length === 2 && pts.length && pts[pts.length - 1].side === grp[1].side) grp = [grp[1], grp[0]];
    for (const P of grp) {
      const last = pts[pts.length - 1];
      if (last && last.side === P.side) {
        if (!(P.side === 'H' ? P.p > last.p : P.p < last.p)) continue;
        pts[pts.length - 1] = { ...P, t: bars[j].t, label: label(P.side, P.p, pts.length >= 3 ? pts[pts.length - 3] : null) };
      } else pts.push({ ...P, t: bars[j].t, label: label(P.side, P.p, pts.length >= 2 ? pts[pts.length - 2] : null) });
    }
  }
  return pts;
}

// ROUND 4 REDESIGN (QA pkg-1016-r2 B1/B2; the 15m-LH version never fired on the real 10/14 05:42 / 07:12 shorts).
// REFERENCE for a SHORT (mirror for a LONG):
//   origin  = the HIGHEST high of the last `originBars` (12) CLOSED 15m bars = where the current down leg began;
//   ref     = the most recent CONFIRMED 5m swing high (K = 2: higher than the 2 bars before it, and not exceeded by the 2 CLOSED 5m bars after it)
//             that started at or after the origin's 15m bar; if there is none, ref = the origin itself.
// A new SHORT is a CHASE when ALL hold:
//   (1) E = ref - entry (SIGNED: > 0 only when the entry is BELOW the reference, i.e. past it in the leg direction) >= k x ATR(14) on 15m (Wilder);
//   (2) the leg (ref -> lowest low since ref) has not yet retraced >= 38.2%. The retrace counts the highest high AFTER the leg low (closed 5m bars),
//       the latest price, and the entry itself when the entry rests on the pullback side (a sell LIMIT above the market fills only after that bounce).
// Anything missing or odd = NOT a chase (fail-open). Closed bars only for swings: no lookahead.
// closed15 = closed 15m bars (oldest first, {t,o,h,l,c}); forming15 = the forming 15m bar (optional; extends the leg extreme only);
// closed5 = CLOSED 5m bars (optional; without them the reference is the 12-bar origin); px = the latest price (optional).
function swingPivots(bars, side, K = 2) {
  const out = [];
  for (let j = K; j + K < bars.length; j++) {
    let ok = true;
    for (let q = 1; q <= K && ok; q++) {
      if (side === 'H') ok = bars[j].h > bars[j - q].h && bars[j].h >= bars[j + q].h;
      else ok = bars[j].l < bars[j - q].l && bars[j].l <= bars[j + q].l;
    }
    if (ok) out.push({ j, t: bars[j].t, p: side === 'H' ? bars[j].h : bars[j].l });
  }
  return out;
}
function noChaseDecision({ dir, entry, closed, forming = null, closed5 = null, px = null, k = 1.5, atr = null, retraceMin = 0.382, originBars = 12, lookback = 400 }) {
  const out = { chase: false };
  if ((dir !== 1 && dir !== -1) || !Number.isFinite(entry) || !Array.isArray(closed) || closed.length < 15) return { ...out, failOpen: 'not enough data' };
  const bars = closed.slice(-lookback);
  if (bars.some(b => !b || !Number.isFinite(b.h) || !Number.isFinite(b.l) || !Number.isFinite(b.t))) return { ...out, failOpen: 'bad bar' };
  const A = Number.isFinite(atr) && atr > 0 ? atr : atr14(bars);
  if (!A) return { ...out, failOpen: 'no ATR' };
  const win = bars.slice(-originBars);
  let oi = 0; win.forEach((b, i) => { if (dir === -1 ? b.h > win[oi].h : b.l < win[oi].l) oi = i; });
  const origin = { p: dir === -1 ? win[oi].h : win[oi].l, t: win[oi].t, kind: 'origin' };
  const b5 = Array.isArray(closed5) ? closed5.filter(b => b && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.t)) : [];
  const piv = b5.length >= 5 ? swingPivots(b5, dir === -1 ? 'H' : 'L').filter(s => s.t >= origin.t) : [];
  const ref = piv.length ? { p: piv[piv.length - 1].p, t: piv[piv.length - 1].t, kind: 'swing5' } : origin;
  // bars AFTER the reference (5m when there are any after it, else 15m), then the forming 15m bar (extreme only)
  const after5 = b5.filter(b => b.t > ref.t);
  const seq = after5.length ? after5 : bars.filter(b => b.t > ref.t);
  let ext = ref.p, extI = -1;
  seq.forEach((b, i) => { const v = dir === -1 ? b.l : b.h; if (dir === -1 ? v < ext : v > ext) { ext = v; extI = i; } });
  let extFromForming = false;
  if (forming && Number.isFinite(forming.h) && Number.isFinite(forming.l)) { const v = dir === -1 ? forming.l : forming.h; if (dir === -1 ? v < ext : v > ext) { ext = v; extFromForming = true; } }
  if (Number.isFinite(px) && (dir === -1 ? px < ext : px > ext)) { ext = px; extFromForming = true; }
  const leg = Math.abs(ref.p - ext);
  const E = dir === -1 ? ref.p - entry : entry - ref.p;   // signed: > 0 only when the entry is PAST the reference in the leg direction
  const swLabel = ref.kind === 'swing5' ? (dir === -1 ? '5m swing high' : '5m swing low') : (dir === -1 ? '12-bar 15m high (leg origin)' : '12-bar 15m low (leg origin)');
  const base = { swing: ref.p, swingT: ref.t, swingKind: ref.kind, swingLabel: swLabel, origin: origin.p, originT: origin.t, atr: A, E, eAtr: E / A, leg, extreme: ext };
  if (!(E >= k * A)) return { ...base, chase: false, why: `entry ${(E / A).toFixed(1)} ATR past the ${swLabel} (< ${k})` };
  if (!(leg > 0)) return { ...base, chase: false, why: 'no leg yet' };
  let back = ext;
  if (!extFromForming) seq.forEach((b, i) => { if (i > extI) { const v = dir === -1 ? b.h : b.l; if (dir === -1 ? v > back : v < back) back = v; } });
  if (Number.isFinite(px) && (dir === -1 ? px > back : px < back)) back = px;
  if (dir === -1 ? entry > back : entry < back) back = entry;   // a resting entry on the pullback side fills only after that retrace
  const retrace = Math.abs(back - ext) / leg;
  return { ...base, retrace, chase: retrace < retraceMin, why: retrace < retraceMin ? 'chase' : `the leg already retraced ${(retrace * 100).toFixed(0)}% (>= ${(retraceMin * 100).toFixed(1)}%)` };
}

// "Not chasing: entry 2.3 ATR past the last lower high 30,640 with no 38% pullback -> wait for the pullback"
function noChaseText(d) {
  return `Not chasing: entry ${d.eAtr.toFixed(1)} ATR past the ${d.swingLabel} ${d.swing.toLocaleString('en-US', { maximumFractionDigits: 2 })} with no 38% pullback (leg ${d.leg.toFixed(2)} pts, retraced ${((d.retrace || 0) * 100).toFixed(0)}%) -> wait for the pullback`;
}

module.exports = { noChaseDecision, noChaseText, swings, swingPivots, atr14 };
