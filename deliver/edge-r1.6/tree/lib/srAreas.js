'use strict';
// sr-areas r1 (MacAreas, 10/29): SUPPORT & RESISTANCE AREAS - DISPLAY ONLY. Pure function: no I/O, timers, clock reads or randomness; nothing in trading reads it.
// Mac 10/28: "Let's call them support and resistance areas cause we may not be exact with the price point but we can get a good idea of the areas price
//   struggled to get passed or lower than." 10/29: the same areas in the Levels PRO indicator, so the algorithm is written to be ported 1:1 to Pine v5/v6
//   (see PINE-PLAN.md): only completed-bar pivots, wick tests, Wilder ATR, a bounded zone list, one hourly state machine, no lookahead.
//
// METHOD (each step is cheap in Pine: loops over <= MAX_ZONES zones once per completed 1H bar)
//  1 Inputs: completed 1H and 4H bars (t + period <= now), optional 15m (live-test flag only) and daily (distance window only). Bad bars are dropped.
//  2 Births (where price stalled or reversed), per timeframe, ATR = Wilder ATR(14) of THAT timeframe at the anchor bar:
//      - swing high / low: a completed pivot (left bars strictly lower/higher, right bars not higher/lower), known only once its right bars have closed;
//      - rejection wick: a bar whose upper (lower) wick is >= WICK_ATR x ATR and >= its body, known at that bar's close.
//    Zone = from the extreme inward by the wick depth, clamped to [W_MIN, W_MAX] x ATR (resistance: [high - depth, high]; support: [low, low + depth]).
//  3 Merge: a birth that overlaps a live area joins it (union, if the union stays <= MERGE_CAP x ATR and touches no other area). If the union would be too
//    wide, the birth keeps only its part beyond the existing area (on its extreme's side) when that part is >= W_MIN x ATR; otherwise it is absorbed
//    (adds its timeframe/source). Areas never overlap.
//  4 One state machine, stepped on every completed 1H bar for every area (4H areas too): a TOUCH is an episode of consecutive 1H bars that trade into the
//    area (adjacent bars are not separate touches); each touching bar is a WICK REJECTION (closes back outside on the area's side) or a BODY STALL (closes
//    inside). A 1H CLOSE beyond the far edge = BROKEN (the role flips: old resistance is now support). A broken area that is retested from the new side and
//    left on that side = FLIPPED. Broken areas never retested fade and are removed after BROKEN_TTL_H hours; any area untouched for EXPIRE_H hours expires.
//    A new birth replays the 1H bars that completed between its anchor and its confirmation (Pine keeps a small ring buffer for this).
//  5 Rank: score = touches x recency x timeframe weight (recency halves every HALF_LIFE_H hours since the last touch; 4H > 1H; both = confluence bonus).
//    strength 1-5 from the score. Output: the nearest PICK areas above and PICK below price, within DIST_DATR x daily ATR (fallback DIST_H4ATR x 4H ATR).
//
// NO LOOKAHEAD: every decision uses bars completed by `now`; a bar that completes later can only change output computed after it completed.
// DETERMINISTIC: fixed processing order (1H step -> expiry -> births ordered by birthAt, 4H before 1H, then anchor time), stable tie-breaks, rounding at output.
// [P] = builder-proposed parameter, frozen for r1 (a different value is a new version). Owner-facing knobs (PICK, DIST) are options, not method.
const VERSION = 'sr-areas-r1';
const M15 = 900000, H1 = 3600000, H4 = 4 * H1, D1 = 86400000;
const PARAMS = Object.freeze({
  ATR_LEN: 14,
  PIVOT: Object.freeze({ '1H': Object.freeze([3, 2]), '4H': Object.freeze([2, 1]) }),   // [left, right] bars                              [P]
  W_MIN: 0.25, W_MAX: 0.5,                                                                   // zone depth, x ATR of the birth timeframe          [P]
  WICK_ATR: 0.5,                                                                             // rejection-wick birth: wick >= 0.5 ATR and >= body [P]
  MERGE_CAP: 0.5,                                                                            // merged width <= 0.5 x the larger birth ATR (= W_MAX) [P]
  TICK: 0.25,                                                                                // instrument tick (MNQ); Pine: syminfo.mintick
  WINDOW_D: 10,                                                                              // births considered from the last 10 days           [P]
  EXPIRE_H: Object.freeze({ '1H': 120, '4H': 240 }),                                         // hours without a touch before an area expires      [P]
  BROKEN_TTL_H: 72,                                                                          // a broken, never-retested area is removed after    [P]
  HALF_LIFE_H: 72,                                                                           // recency half-life                                 [P]
  TF_W: Object.freeze({ '1H': 1, '4H': 1.5 }), CONFLUENCE_W: 0.25,                           // timeframe weights                                 [P]
  STRENGTH_CUTS: Object.freeze([1.5, 3, 5, 8]),                                                // score -> strength 1..5                            [P]
  MAX_ZONES: 40,                                                                             // live areas kept (lowest score dropped)            [P]
  PICK: 3, DIST_DATR: 1.5, DIST_H4ATR: 3,                                                    // output selection (display options)
  INPUT_CAP: Object.freeze({ H1: 400, H4: 200, M15: 96, D: 200 }),                           // newest bars used (work bound; ATR seeds < 1e-5 of Pine's)
});
const PERIOD = { '1H': H1, '4H': H4 };
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const okBar = b => !!b && Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h >= b.l && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c);

// completed, valid, sorted, de-duplicated (last copy of a timestamp wins), newest `cap` kept
function prep(bars, period, now, cap) {
  if (!Array.isArray(bars)) return { bars: [], dropped: 0 };
  let dropped = 0; const byT = new Map();
  for (const b of bars) {
    if (!okBar(b)) { dropped++; continue; }
    if (!(b.t + period <= now)) continue;                     // forming or future bar: not used (no lookahead)
    byT.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  const out = [...byT.values()].sort((a, b) => a.t - b.t);
  return { bars: out.slice(-cap), dropped };
}
// Wilder ATR, exactly ta.atr(len) = ta.rma(ta.tr(true), len): TR[0] = h - l; seed = SMA of the first len TRs; then rma = (prev * (len - 1) + tr) / len
function atrSeries(bars, len) {
  const out = new Array(bars.length).fill(NaN); let rma = NaN, sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : NaN;
    const tr = Number.isFinite(pc) ? Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)) : b.h - b.l;
    if (i < len) { sum += tr; if (i === len - 1) rma = sum / len; } else rma = (rma * (len - 1) + tr) / len;
    out[i] = i >= len - 1 ? rma : NaN;
  }
  return out;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function zoneFromBar(b, atr, role) {
  if (role === 'resistance') { const depth = clamp(b.h - Math.max(b.o, b.c), PARAMS.W_MIN * atr, PARAMS.W_MAX * atr); return { lo: b.h - depth, hi: b.h }; }
  const depth = clamp(Math.min(b.o, b.c) - b.l, PARAMS.W_MIN * atr, PARAMS.W_MAX * atr); return { lo: b.l, hi: b.l + depth };
}
// birth candidates for one timeframe: { tf, how, role, lo, hi, anchorT, anchorEnd, birthAt, atr }
function birthsFor(tf, bars, atr, from) {
  const [L, R] = PARAMS.PIVOT[tf], per = PERIOD[tf], out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], a = atr[i];
    if (!Number.isFinite(a) || b.t < from) continue;
    const push = (how, role, birthAt) => { const z = zoneFromBar(b, a, role); out.push({ tf, how, role, lo: z.lo, hi: z.hi, anchorT: b.t, anchorEnd: b.t + per, birthAt, atr: a }); };
    if (i >= L && i + R < bars.length) {
      let ph = true, pl = true;
      for (let k = i - L; k < i; k++) { if (!(b.h > bars[k].h)) ph = false; if (!(b.l < bars[k].l)) pl = false; }
      for (let k = i + 1; k <= i + R; k++) { if (!(b.h >= bars[k].h)) ph = false; if (!(b.l <= bars[k].l)) pl = false; }
      const confirmAt = bars[i + R].t + per;
      if (ph) push('swing-high', 'resistance', confirmAt);
      if (pl) push('swing-low', 'support', confirmAt);
    }
    const body = Math.abs(b.c - b.o), up = b.h - Math.max(b.o, b.c), dn = Math.min(b.o, b.c) - b.l;
    if (up >= PARAMS.WICK_ATR * a && up >= body) push('wick-high', 'resistance', b.t + per);
    if (dn >= PARAMS.WICK_ATR * a && dn >= body) push('wick-low', 'support', b.t + per);
  }
  return out;
}
const tfRank = tf => (tf === '4H' ? 2 : 1);
function scoreOf(z, at) {
  const rec = Math.pow(0.5, Math.max(0, at - z.lastTouchEnd) / (PARAMS.HALF_LIFE_H * H1));
  const w = PARAMS.TF_W[z.tf] + (z.tfs.length > 1 ? PARAMS.CONFLUENCE_W : 0);
  return z.touches * rec * w;
}
function strengthOf(score) { let s = 1; for (const c of PARAMS.STRENGTH_CUTS) if (score >= c) s++; return s; }

// one completed 1H bar against one area
function step(z, b) {
  const E = b.t + H1, res = z.role === 'resistance';
  const beyond = res ? b.c > z.hi : b.c < z.lo, inter = b.h >= z.lo && b.l <= z.hi;
  if (beyond) { z.role = res ? 'support' : 'resistance'; z.status = 'broken'; z.breaks++; z.brokenAt = E; z.brokenOnce = true; z.inEp = false; z.lastT = b.t; z.lastTouchEnd = E; ev(z, b, 'break', b.c); return; }
  if (inter) {
    if (!z.inEp) { z.touches++; z.inEp = true; }
    const w = res ? b.c < z.lo : b.c > z.hi;
    if (w) z.wick++; else z.stall++;
    ev(z, b, w ? 'wick' : 'stall', res ? b.h : b.l);
    z.status = 'tested'; z.lastT = b.t; z.lastTouchEnd = E; return;
  }
  if (z.inEp) { z.inEp = false; z.status = z.brokenOnce ? 'flipped' : 'holding'; if (z.brokenOnce) ev(z, b, 'held'); }
}
// trace (display / audit only; bounded): the touch history that makes this an area
const TRACE_MAX = 40;
function ev(z, b, e, px) { if (!z.trace) return; z.trace.push({ t: b.t, e, role: z.role, px: Number.isFinite(px) ? px : null, tch: z.touches }); if (z.trace.length > TRACE_MAX) z.trace.shift(); }
function newZone(c) {
  const z = { id: `${c.tf}:${c.how}:${c.anchorT}`, role: c.role, lo: c.lo, hi: c.hi, tf: c.tf, tfs: [c.tf], how: c.how, cap: PARAMS.MERGE_CAP * c.atr, atr: c.atr,
    touches: 1, wick: 0, stall: 0, breaks: 0, status: 'holding', brokenOnce: false, brokenAt: null, inEp: true,
    firstT: c.anchorT, lastT: c.anchorT, lastTouchEnd: c.anchorEnd, bornAt: c.birthAt, sources: 1, trace: c.trace ? [{ t: c.anchorT, e: 'born:' + c.how, role: c.role, px: c.role === 'resistance' ? c.hi : c.lo, tch: 1 }] : null };
  return z;
}
function anchorClass(z, b) { if (z.role === 'resistance' ? b.c < z.lo : b.c > z.hi) z.wick++; else z.stall++; }

function srAreas({ h1, h4, m15 = null, d = null, price = NaN, now, pick = PARAMS.PICK, distDatr = PARAMS.DIST_DATR, trace = false } = {}) {
  const empty = why => ({ version: VERSION, asOf: null, price: Number.isFinite(price) ? price : null, refPrice: null, atr: { h1: null, h4: null, d: null }, areas: [], above: [], below: [],
    all: [], live: 0, coverage: why, dropped: 0 });
  if (!Number.isFinite(now)) return empty('unavailable: no time');
  const p1 = prep(h1, H1, now, PARAMS.INPUT_CAP.H1), p4 = prep(h4, H4, now, PARAMS.INPUT_CAP.H4);
  const pd = prep(d, D1, now, PARAMS.INPUT_CAP.D), p15 = prep(m15, M15, now, PARAMS.INPUT_CAP.M15);
  const dropped = p1.dropped + p4.dropped + pd.dropped + p15.dropped;
  const B1 = p1.bars, B4 = p4.bars;
  if (B1.length < PARAMS.ATR_LEN + 1) return { ...empty(B1.length ? 'warmup: too few completed 1H bars' : 'unavailable: no completed 1H bars'), dropped };
  const A1 = atrSeries(B1, PARAMS.ATR_LEN), A4 = atrSeries(B4, PARAMS.ATR_LEN), AD = atrSeries(pd.bars, PARAMS.ATR_LEN);
  const asOf = B1[B1.length - 1].t + H1;
  // births: 4H only once the 1H tape covers its anchor (the state machine needs the 1H bars); births from the last WINDOW_D days
  const from = Math.max(asOf - PARAMS.WINDOW_D * D1, B1[PARAMS.ATR_LEN - 1].t);
  const births = birthsFor('4H', B4, A4, from).concat(birthsFor('1H', B1, A1, from))
    .sort((a, b) => a.birthAt - b.birthAt || tfRank(b.tf) - tfRank(a.tf) || a.anchorT - b.anchorT || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  let zones = [], bi = 0;
  const startIdx = B1.findIndex(b => b.t >= from);
  const insert = (c, k) => {   // k = index of the last 1H bar already stepped
    const ov = zones.filter(z => c.lo <= z.hi && c.hi >= z.lo);
    if (ov.length) {
      const z = ov.map(z => [z, Math.min(c.hi, z.hi) - Math.max(c.lo, z.lo)]).sort((a, b) => b[1] - a[1] || a[0].lo - b[0].lo)[0][0];
      const lo = Math.min(z.lo, c.lo), hi = Math.max(z.hi, c.hi), cap = Math.max(z.cap, PARAMS.MERGE_CAP * c.atr);
      const clash = zones.some(o => o !== z && lo <= o.hi && hi >= o.lo);
      if (hi - lo <= cap && !clash) {   // MERGE: one area
        z.lo = lo; z.hi = hi; z.cap = cap;
        if (!z.tfs.includes(c.tf)) z.tfs.push(c.tf);
        if (tfRank(c.tf) > tfRank(z.tf)) z.tf = c.tf;
        z.sources++; z.firstT = Math.min(z.firstT, c.anchorT);
        if (z.trace) z.trace.push({ t: c.anchorT, e: 'merge:' + c.tf + ' ' + c.how, role: z.role, px: c.role === 'resistance' ? c.hi : c.lo, tch: z.touches });
        return;
      }
      // TRIM: the union would be too wide - keep only the new birth's part beyond the existing areas, on its extreme's side, if it is still >= W_MIN x ATR
      const res = c.role === 'resistance', edge = res ? Math.max(...ov.map(o => o.hi)) : Math.min(...ov.map(o => o.lo));
      const t = res ? { ...c, lo: edge + PARAMS.TICK } : { ...c, hi: edge - PARAMS.TICK };
      if (t.hi - t.lo < PARAMS.W_MIN * c.atr || zones.some(o => t.lo <= o.hi && t.hi >= o.lo)) {   // ABSORB: the existing area already covers it
        if (!z.tfs.includes(c.tf)) z.tfs.push(c.tf);
        if (tfRank(c.tf) > tfRank(z.tf)) z.tf = c.tf;
        z.sources++; return;
      }
      c = t;
    }
    const z = newZone(trace ? { ...c, trace: true } : c), ab = B1.filter(b => b.t >= c.anchorT && b.t + H1 <= c.anchorEnd);
    // the anchor's own 1H bar(s) classify the first touch; for a 4H anchor, its last 1H bar that reached into the area
    const ext = ab.filter(b => b.h >= z.lo && b.l <= z.hi);
    anchorClass(z, ext.length ? ext[ext.length - 1] : { c: c.role === 'resistance' ? z.lo - 1 : z.hi + 1 });
    for (let j = 0; j <= k; j++) if (B1[j].t >= c.anchorEnd) step(z, B1[j]);   // replay bars between the anchor and this confirmation
    zones.push(z);
  };
  const prune = E => {
    zones = zones.filter(z => !(z.status === 'broken' && E - z.brokenAt >= PARAMS.BROKEN_TTL_H * H1) && !(E - z.lastTouchEnd >= PARAMS.EXPIRE_H[z.tf] * H1));
    if (zones.length > PARAMS.MAX_ZONES) zones = zones.map(z => [z, scoreOf(z, E)]).sort((a, b) => b[1] - a[1] || b[0].lastTouchEnd - a[0].lastTouchEnd || a[0].lo - b[0].lo).slice(0, PARAMS.MAX_ZONES).map(x => x[0]);
  };
  while (bi < births.length && births[bi].birthAt <= B1[Math.max(0, startIdx)].t) bi++;   // confirmed before the window's first 1H bar: skipped (no 1H replay available)
  for (let k = Math.max(0, startIdx); k < B1.length; k++) {
    const b = B1[k], E = b.t + H1;
    for (const z of zones) step(z, b);
    prune(E);
    const nextStart = k + 1 < B1.length ? B1[k + 1].t : now;   // births known before the next 1H bar starts (Pine: the same chart bar that delivers this 1H bar)
    while (bi < births.length && births[bi].birthAt <= nextStart) { insert(births[bi], k); bi++; }
    prune(E);
  }
  // output
  const lastC = B1[B1.length - 1].c, ref = Number.isFinite(price) ? price : lastC;
  const atrD = AD.length ? AD[AD.length - 1] : NaN, atr4 = A4.length ? A4[A4.length - 1] : NaN, atr1 = A1[A1.length - 1];
  const maxDist = Number.isFinite(atrD) ? distDatr * atrD : Number.isFinite(atr4) ? PARAMS.DIST_H4ATR * atr4 : Infinity;
  const b15 = p15.bars.filter(b => b.t >= asOf);   // completed 15m bars after the last completed 1H bar: live-test flag only
  const all = zones.map(z => {
    const score = scoreOf(z, asOf);
    return { id: z.id, kind: z.role, lo: r2(z.lo), hi: r2(z.hi), mid: r2((z.lo + z.hi) / 2), tf: z.tf, tfs: z.tfs.slice().sort(), touches: z.touches,
      rejections: z.wick + z.stall, rejectBy: { wick: z.wick, stall: z.stall }, breaks: z.breaks, brokenAt: z.brokenAt, firstT: z.firstT, lastT: z.lastT,
      strength: strengthOf(score), score: r2(score), status: z.status, born: { how: z.how, at: z.bornAt },
      fade: z.status === 'broken' ? r2(Math.max(0, 1 - (asOf - z.brokenAt) / (PARAMS.BROKEN_TTL_H * H1))) : 1,
      test15: b15.some(m => m.h >= z.lo && m.l <= z.hi), ...(z.trace ? { trace: z.trace.slice() } : {}) };
  }).sort((a, b) => b.lo - a.lo);
  const base = { version: VERSION, asOf, atr: { h1: r2(atr1), h4: r2(atr4), d: r2(atrD) }, maxDistPts: Number.isFinite(maxDist) ? r2(maxDist) : null, all, live: zones.length,
    coverage: B4.length >= PARAMS.ATR_LEN ? 'ok' : '4H warmup (1H areas only)', dropped, lastClose: lastC };
  return selectAreas(base, price, { pick });
}
// SELECTION (pure, cheap): side / distance / nearest PICK above and below for a price. The executor computes srAreas once per completed 1H bar and calls
// this on every snapshot write with the latest price, so distances follow price between hourly recomputes without changing any area.
function selectAreas(base, price, { pick = PARAMS.PICK } = {}) {
  if (!base || !Array.isArray(base.all) || base.asOf == null) return base;   // empty / unavailable results pass through unchanged
  const ref = Number.isFinite(price) ? price : base.lastClose, maxDist = Number.isFinite(base.maxDistPts) ? base.maxDistPts : Infinity;
  const areas = base.all.map(a => {
    const side = ref > a.hi ? 'below' : ref < a.lo ? 'above' : 'at', dist = side === 'above' ? a.lo - ref : side === 'below' ? a.hi - ref : 0;
    const { test15, ...rest } = a;
    return { ...rest, side, distancePts: r2(dist), liveTest: !!test15 || side === 'at' };
  });
  const inRange = areas.filter(a => Math.abs(a.distancePts) <= maxDist);
  const up = inRange.filter(a => a.side === 'above' || (a.side === 'at' && a.kind === 'resistance')).sort((a, b) => a.distancePts - b.distancePts || a.lo - b.lo).slice(0, pick);
  const dn = inRange.filter(a => a.side === 'below' || (a.side === 'at' && a.kind === 'support')).sort((a, b) => b.distancePts - a.distancePts || b.hi - a.hi).slice(0, pick);
  const shown = up.concat(dn).sort((a, b) => Math.abs(a.distancePts) - Math.abs(b.distancePts) || a.lo - b.lo);
  return { ...base, price: Number.isFinite(price) ? price : null, refPrice: ref, priceSource: Number.isFinite(price) ? 'input' : 'last 1H close',
    areas: shown, above: up.map(a => a.id), below: dn.map(a => a.id), all: areas };
}
module.exports = { VERSION, PARAMS, srAreas, selectAreas, atrSeries, birthsFor, zoneFromBar };
