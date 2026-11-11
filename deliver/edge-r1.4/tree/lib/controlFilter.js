// 10/18 package (owner rules, Chart School 10/14 answers + 10/15 spec). Pure: no I/O. Shared by live-executor.js and the tests / replay.
//
// RULE 4  TREND / CONTROL FILTER (CONFIG.controlFilter, ON). No counter-trend entries:
//   LONG only when price is ACCEPTED above the session's control open, SHORT only when accepted below.
//   Control open (CONFIG.controlLineBySession, shipped { asia:'4H', london:'1H', ny:'4H' }): the open of the CURRENT 4H or 1H bar.
//     Sessions (PT): asia 15:00-24:00, london 00:00-06:30, ny 06:30-15:00 (NY entries stop at 12:55 anyway: session close).
//   Accepted = the last CLOSED candle of CONFIG.controlAcceptTf ('5m' shipped; '3m' or '15m') closed beyond the open by more than CONFIG.controlBufferPts
//   (shipped 0 = strictly beyond). Inside the buffer neither side is accepted (chop: no trade either way).
//   Missing / stale bars = UNKNOWN = the filter does not block (same convention as the no-chase filter) and says so on the phone and in the journal.
const { ptInfo, ema, rsi } = require('./helpers');

const TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '1H': 3600000, '4H': 14400000 };
const SESSIONS = ['asia', 'london', 'ny'];

function controlSession(ts) {
  const m = ptInfo(ts).minutesOfDay;
  if (m < 6 * 60 + 30) return 'london';
  if (m < 15 * 60) return 'ny';
  return 'asia';
}
function controlTfFor(session, cfg = {}) {
  const map = Object.assign({ asia: '4H', london: '1H', ny: '4H' }, cfg.controlLineBySession || {});
  return map[session] === '1H' ? '1H' : '4H';
}
// the bar whose period contains ts (the current, possibly forming, bar)
function barContaining(bars, ts, ms) {
  if (!Array.isArray(bars)) return null;
  for (let i = bars.length - 1; i >= 0; i--) { const b = bars[i]; if (!b || !Number.isFinite(b.t)) continue; if (b.t <= ts && ts < b.t + ms) return b; if (b.t + ms <= ts) return null; }
  return null;
}
// the last CLOSED bar (t + ms <= now) and the one before it
function lastClosedPair(bars, ms, now) {
  if (!Array.isArray(bars)) return { last: null, prev: null };
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]; if (!b || !Number.isFinite(b.t)) continue;
    if (b.t + ms <= now) { const p = i > 0 ? bars[i - 1] : null; return { last: b, prev: p && p.t + ms <= b.t ? p : null }; }
  }
  return { last: null, prev: null };
}
// bars: { H1, H4, M3, M5, M15 } (arrays of {t,o,h,l,c,v}, ms timestamps). Returns the full state for the phone / journal.
function controlState({ now, bars = {}, cfg = {} }) {
  const on = cfg.controlFilter !== false;
  const session = controlSession(now), tf = controlTfFor(session, cfg);
  const acceptTf = ['3m', '5m', '15m'].includes(cfg.controlAcceptTf) ? cfg.controlAcceptTf : '5m';
  const buffer = Number.isFinite(cfg.controlBufferPts) && cfg.controlBufferPts > 0 ? cfg.controlBufferPts : 0;
  const ctl = barContaining(tf === '1H' ? bars.H1 : bars.H4, now, TF_MS[tf]);
  const acc = { '3m': bars.M3, '5m': bars.M5, '15m': bars.M15 }[acceptTf];
  const { last } = lastClosedPair(acc, TF_MS[acceptTf], now);
  // the accepting candle must be recent (closed within 2 of its own periods); an old candle = stale data = unknown
  const fresh = last && now - (last.t + TF_MS[acceptTf]) <= 2 * TF_MS[acceptTf];
  const known = !!(ctl && Number.isFinite(ctl.o) && fresh && Number.isFinite(last.c));
  const st = { on, session, tf, acceptTf, buffer, known, open: ctl ? ctl.o : null, openT: ctl ? ctl.t : null, close: known ? last.c : null, closeT: known ? last.t + TF_MS[acceptTf] : null, longOk: null, shortOk: null };
  if (known) {
    st.longOk = last.c > ctl.o + buffer;
    st.shortOk = last.c < ctl.o - buffer;
    st.distPts = Math.round((last.c - ctl.o) * 100) / 100;
  }
  st.text = controlText(st);
  return st;
}
function controlAllows(st, dir) {
  if (!st || !st.on || !st.known) return true;
  return dir === 1 ? !!st.longOk : dir === -1 ? !!st.shortOk : true;
}
const SESS_NAME = { asia: 'Asia', london: 'London', ny: 'NY' };
function controlText(st) {
  if (!st.on) return 'Control filter off';
  const lbl = `${SESS_NAME[st.session]} ${st.tf} open`;
  if (!st.known) return `${lbl}: no data yet (filter not blocking)`;
  const side = st.longOk ? 'LONG ok' : st.shortOk ? 'SHORT ok' : 'neither (inside the buffer: chop)';
  return `${side}: last ${st.acceptTf} close ${st.close.toFixed(2)} ${st.distPts >= 0 ? '+' : ''}${st.distPts.toFixed(2)} vs ${lbl} ${st.open.toFixed(2)}${st.buffer ? ` (buffer ${st.buffer} pts)` : ''}`;
}

// RULE 5  SAME-LEVEL BAN (CONFIG.sameLevelBan, ON). After a stop-out OR a pending cancel (stop / TP1 touched before the fill) that level + direction is banned until the
// current 15m bar closes. A new entry matches a ban when it is the same direction and its entry price is within tolPts of the banned entry, or it names the same level.
function banMatch(ban, { dir, price, levelName, now, tolPts = 2 }) {
  if (!ban || ban.dir !== dir || !(now < ban.until)) return false;
  if (Number.isFinite(price) && Number.isFinite(ban.price) && Math.abs(price - ban.price) <= tolPts + 1e-9) return true;
  return !!(levelName && ban.levelName && String(levelName) === String(ban.levelName));
}

// RULE 6  AGGRESSIVE RECLAIM RE-ENTRY after a stop-out (CONFIG.reclaimReentry, ON). All required:
//   (a) the stopped trade's direction passes the control filter (controlOk from controlState / controlAllows);
//   (b) price swept THROUGH our stop (traded at least one tick beyond it);
//   (c) after the ban / cooldown end (w.until = the 15m close after the stop-out) the most recent CLOSED 5m candle closed back through the stop price;
//   (d) that candle's volume > the previous 5m candle's volume;
//   (e) the current price is still on the accepted side of the stop;
//   (f) within windowMin (60) of the stop-out;  (g) max 1 re-entry per original trade (w.used) and never from a re-entry's own stop-out (not watched).
// w = { dir, stop, t (stop-out ms), until (ban end ms), extreme (most adverse price since the stop-out, tracked by the caller), used }.
// bars5: 5m bars (forming one allowed: dropped here by time). Returns { go, code, why, candle, prev, extreme, stop (new stop beyond the sweep extreme) }.
function reclaimDecision({ w, now, px, bars5, controlOk, cfg = {}, tick = 0.25 }) {
  const windowMs = (Number.isFinite(cfg.reclaimWindowMin) ? cfg.reclaimWindowMin : 60) * 60000;
  const buf = Number.isFinite(cfg.reclaimStopBufferPts) ? cfg.reclaimStopBufferPts : 0.5;
  const no = (code, why, extra = {}) => ({ go: false, code, why, ...extra });
  if (!w) return no('none', 'no stop-out being watched');
  if (w.used) return no('used', 'this stopped trade already had its one reclaim re-entry');
  if (now > w.t + windowMs) return no('expired', `more than ${windowMs / 60000} min since the stop-out`);
  if (now < w.until) return no('ban', 'waiting for the 15m ban / cooldown to end');
  const { last: C, prev: P } = lastClosedPair(bars5, 300000, now);
  if (!C || !P) return no('nodata', 'no closed 5m candles');
  const cClose = C.t + 300000;
  if (cClose < w.until) return no('wait', 'waiting for the first 5m candle that closes after the ban ends');
  if (cClose > w.t + windowMs) return no('expired', `the reclaim candle closed more than ${windowMs / 60000} min after the stop-out`);
  // sweep extreme: the caller's tracked extreme, and every 5m bar from the stop-out candle on
  let ext = Number.isFinite(w.extreme) ? w.extreme : w.stop;
  const from = Math.floor(w.t / 300000) * 300000;
  for (const b of bars5 || []) { if (!b || b.t < from || b.t > now) continue; ext = w.dir === 1 ? Math.min(ext, b.l) : Math.max(ext, b.h); }
  const ctx = { candle: C, prev: P, extreme: ext };
  if (!(w.dir === 1 ? ext <= w.stop - tick + 1e-9 : ext >= w.stop + tick - 1e-9)) return no('no-sweep', `price did not trade beyond our stop ${w.stop.toFixed(2)} (extreme ${ext.toFixed(2)})`, ctx);
  if (!(w.dir === 1 ? C.c > w.stop : C.c < w.stop)) return no('no-close-through', `the last 5m candle closed ${C.c.toFixed(2)}, not back through the stop ${w.stop.toFixed(2)}`, ctx);
  if (!(Number.isFinite(C.v) && Number.isFinite(P.v) && C.v > P.v)) return no('no-volume', `the reclaim candle's volume ${C.v} is not above the previous candle's ${P.v}`, ctx);
  if (!(Number.isFinite(px) && (w.dir === 1 ? px > w.stop : px < w.stop))) return no('price-back', `price ${Number.isFinite(px) ? px.toFixed(2) : '?'} is back through the stop ${w.stop.toFixed(2)}`, ctx);
  if (!controlOk) return no('control', 'the control filter no longer allows this direction (trend flipped)', ctx);
  const raw = w.dir === 1 ? ext - buf : ext + buf;
  const stop = w.dir === 1 ? Math.floor(raw / tick + 1e-9) * tick : Math.ceil(raw / tick - 1e-9) * tick;
  return { go: true, code: 'go', why: 'reclaim', ...ctx, stop: Number(stop.toFixed(2)) };
}

// ── ADDENDUM 2 (owner, 10/15): TREND REGIME + WAVE RULE (CONFIG.trendFilter / trendUseDayType / trendInside4h / waveRule, all ON; set-trend.sh) ──
// Top-level direction gate; rule 4's open-line acceptance stays underneath it.
//  Ripster cloud 3 as in MAC Trap v4.2 section 21: EMA(hl2, 34) and EMA(hl2, 50), computed on the 1H and on the 4H chart (4H bars open 15/19/23/03/07/11 PT, the
//  broker's bars). The cloud is read from the last CLOSED HTF bar (no lookahead). "Price" = the entry price of the order being checked (market: the current price;
//  limit / stop: its order price), as in the owner's 10/14 check; without one, the last closed 5m close.
//    below the cloud = price < min(EMA34, EMA50); above = price > max. Ripster DOWN = below on both 1H and 4H; UP = above on both; MIXED otherwise.
//  Day type (prior CME day = the previous 15:00-15:00 PT session's high / low from the 1H bars): last closed 5m close below PDL = TREND_DOWN, above PDH = TREND_UP,
//  else RANGE. 4H inside bar: while no closed 5m candle of the CURRENT 4H bar has closed beyond the PREVIOUS 4H bar's high / low, the day type is RANGE (4H inside).
//  Regime: DOWN = Ripster DOWN or TREND_DOWN (and nothing says UP); UP mirrored; both = MIXED; neither = MIXED (Ripster mixed) / RANGE.
//  Permission: in DOWN shorts only, in UP longs only; a COUNTER-trend entry only as a reclaim of the session's control open (the last closed 5m candle closed back across
//  it beyond the buffer, the candle before was on the other side, and its volume beat the previous candle's). MIXED / RANGE: both directions, rule 4 decides.
//  Wave rule: see ADDENDUM 3 below (waveState). Missing data never blocks (shown as unknown).
const H1 = 3600000, H4 = 14400000, M5 = 300000;
function closedBars(bars, ms, now) { return Array.isArray(bars) ? bars.filter(b => b && Number.isFinite(b.t) && b.t + ms <= now) : []; }
function rippleCloud(bars, ms, now, fast = 34, slow = 50) {
  const cb = closedBars(bars, ms, now); if (cb.length < slow + 5) return null;
  const src = cb.map(b => (b.h + b.l) / 2), ef = ema(src, fast), es = ema(src, slow), i = cb.length - 1;
  if (ef[i] == null || es[i] == null) return null;
  return { fast: Math.round(ef[i] * 100) / 100, slow: Math.round(es[i] * 100) / 100, lo: Math.min(ef[i], es[i]), hi: Math.max(ef[i], es[i]), barT: cb[i].t };
}
function cmeDayKey(t) { return ptInfo(t + 9 * 3600000).dateStr; }   // the CME trading day: 15:00 PT starts the next date
function priorDayRange(h1, now) {
  const cb = closedBars(h1, H1, now); if (!cb.length) return null;
  const cur = cmeDayKey(now); let key = null, hi = -Infinity, lo = Infinity;
  for (let i = cb.length - 1; i >= 0; i--) { const k = cmeDayKey(cb[i].t); if (k >= cur) continue; if (key == null) key = k; if (k !== key) break; hi = Math.max(hi, cb[i].h); lo = Math.min(lo, cb[i].l); }
  return key == null ? null : { day: key, pdh: hi, pdl: lo };
}
function trendState({ now, bars = {}, cfg = {}, px: pxIn = null }) {
  const on = cfg.trendFilter !== false;
  const acc5 = closedBars(bars.M5, M5, now), last = acc5[acc5.length - 1];
  const fresh = last && now - (last.t + M5) <= 2 * M5;
  const close5 = fresh ? last.c : null;
  const px = Number.isFinite(pxIn) ? pxIn : close5;   // the cloud side is judged at the ENTRY price (owner's 10/14 check); the day type at the last 5m close (acceptance)
  const c1 = rippleCloud(bars.H1, H1, now), c4 = rippleCloud(bars.H4, H4, now);
  const side = c => (c == null || px == null) ? null : px < c.lo ? 'below' : px > c.hi ? 'above' : 'inside';
  const s1 = side(c1), s4 = side(c4);
  const ripster = s1 == null || s4 == null ? null : s1 === 'below' && s4 === 'below' ? 'DOWN' : s1 === 'above' && s4 === 'above' ? 'UP' : 'MIXED';
  const pr = priorDayRange(bars.H1, now);
  let dayType = null, dayTypeRaw = null;
  if (pr && close5 != null) dayTypeRaw = dayType = close5 < pr.pdl ? 'TREND_DOWN' : close5 > pr.pdh ? 'TREND_UP' : 'RANGE';
  // 4H inside bar
  let inside4h = null, prev4 = null, cur4 = null;
  if (Array.isArray(bars.H4)) {
    cur4 = barContaining(bars.H4, now, H4);
    if (cur4) { const i = bars.H4.indexOf(cur4); prev4 = i > 0 ? bars.H4[i - 1] : null; }
    if (cur4 && prev4) {
      const broke = acc5.some(b => b.t >= cur4.t && (b.c > prev4.h || b.c < prev4.l));
      inside4h = !broke;
    }
  }
  if (cfg.trendInside4h !== false && inside4h === true && dayType) dayType = 'RANGE';
  const useDay = cfg.trendUseDayType !== false;
  const down = ripster === 'DOWN' || (useDay && dayType === 'TREND_DOWN');
  const up = ripster === 'UP' || (useDay && dayType === 'TREND_UP');
  const known = ripster != null && (!useDay || dayType != null);
  const regime = !known ? null : down && up ? 'MIXED' : down ? 'DOWN' : up ? 'UP' : ripster === 'MIXED' ? 'MIXED' : 'RANGE';
  const st = { on, known, regime, px, close5, ripster, side1h: s1, side4h: s4, cloud1h: c1 ? { fast: c1.fast, slow: c1.slow } : null, cloud4h: c4 ? { fast: c4.fast, slow: c4.slow } : null,
    pdh: pr ? pr.pdh : null, pdl: pr ? pr.pdl : null, dayType, dayTypeRaw, inside4h, prev4h: prev4 ? { h: prev4.h, l: prev4.l, t: prev4.t } : null };
  st.text = trendText(st);
  return st;
}
function trendText(st) {
  if (!st.on) return 'Trend filter off';
  if (!st.known) return 'Trend: no data yet (not blocking)';
  const cl = st.ripster === 'DOWN' ? '1H+4H below cloud' : st.ripster === 'UP' ? '1H+4H above cloud' : `1H ${st.side1h} / 4H ${st.side4h} cloud`;
  const dt = st.dayType === 'TREND_DOWN' ? 'below PDL' : st.dayType === 'TREND_UP' ? 'above PDH' : st.inside4h && st.dayTypeRaw !== 'RANGE' ? 'RANGE (4H inside bar)' : 'inside prior day';
  return `Trend: ${st.regime} (${cl}, ${dt})`;
}
// ── ADDENDUM 3 (owner's wave clarification, 10/14-evening 5m chart): swings, structure, entry A / B ──
// Swings: 5m pivots of strength waveSwingStrength (3 bars each side, confirmed 3 bars later), kept only when they move at least waveMinSwingAtr x the 15m ATR(14)
// from the previous kept swing (zig-zag: micro-wiggles do not count; two highs in a row keep the higher). A full M / W is NOT required.
// DOWN structure = at least waveMinLowerHighs (2) consecutive LOWER swing highs; the descending trendline runs through the last two swing highs. UP mirrored.
//   Entry A (lower-high rejection): a closed 5m candle after the last swing high trades up to within waveLineBufferAtr x ATR of the line, or into the prior swing-high zone
//   (the last swing high, or a broken shelf), then closes back down (red candle, close below the line). Stop = that candle's wick + waveStopBufferPts.
//   Entry B (descending-triangle breakdown): the latest swing lows form a flat shelf (>= 2 within waveShelfAtr x ATR of each other); a 5m candle closes below the shelf
//   (the candle before had not) with volume above the candle before. Stop = the last lower high + waveStopBufferPts.
// waveMode 'confirm' (shipped): a with-trend Levels / MAC signal needs the wave: entry A / B fired on one of the last waveConfirmBars closed 5m candles, OR the last swing is
//   a lower high (short) / higher low (long) and price has not broken the last swing low / high since. A fresh impulsive low with no pullback = WAVE_WAIT.
// waveMode 'trigger' (OFF until backtested): as 'confirm', AND entry A / B become a standalone entry source (live-executor.js waveTriggerStep). 'off' = no wave rule.
function atr15(bars15, now) {
  const cb = closedBars(bars15, 900000, now); if (cb.length < 16) return null;
  const tr = cb.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - cb[i - 1].c), Math.abs(b.l - cb[i - 1].c)));
  let a = tr.slice(0, 14).reduce((x, y) => x + y, 0) / 14; for (let i = 14; i < tr.length; i++) a = (a * 13 + tr[i]) / 14;
  return a;
}
function rawPivots(b, k = 3) {
  const piv = [];
  for (let i = k; i < b.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) { if (!(b[i].h > b[i - j].h && b[i].h >= b[i + j].h)) hi = false; if (!(b[i].l < b[i - j].l && b[i].l <= b[i + j].l)) lo = false; }
    if (hi) piv.push({ i, t: b[i].t, kind: 'H', p: b[i].h });
    if (lo) piv.push({ i, t: b[i].t, kind: 'L', p: b[i].l });
  }
  return piv;
}
function swings5(b, k = 3, minSize = 0) {
  const piv = [];
  for (let i = k; i < b.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) { if (!(b[i].h > b[i - j].h && b[i].h >= b[i + j].h)) hi = false; if (!(b[i].l < b[i - j].l && b[i].l <= b[i + j].l)) lo = false; }
    if (hi) piv.push({ i, t: b[i].t, kind: 'H', p: b[i].h });
    if (lo) piv.push({ i, t: b[i].t, kind: 'L', p: b[i].l });
  }
  const z = [];
  for (const p of piv) {
    const last = z[z.length - 1];
    if (!last) { z.push(p); continue; }
    if (p.kind === last.kind) { if (p.kind === 'H' ? p.p > last.p : p.p < last.p) z[z.length - 1] = p; continue; }
    if (Math.abs(p.p - last.p) >= minSize) z.push(p);
  }
  return z;
}
const pivots5 = (b, k = 2) => swings5(b, k, 0);   // (addendum 2 name, kept for the tests)
function waveState(dir, bars = {}, now, cfg = {}, px = null) {
  const k = Number.isFinite(cfg.waveSwingStrength) ? Math.max(1, Math.round(cfg.waveSwingStrength)) : 3;
  const cb = closedBars(bars.M5, M5, now).slice(-(Number.isFinite(cfg.waveLookbackBars) ? cfg.waveLookbackBars : 96));
  const atr = atr15(bars.M15, now);
  const name = dir === -1 ? 'short' : 'long';
  if (cb.length < 2 * k + 4 || !atr) return { known: false, ok: true, dir, atr, text: 'wave: not enough 5m / 15m bars (not blocking)' };
  const z = swings5(cb, k, (Number.isFinite(cfg.waveMinSwingAtr) ? cfg.waveMinSwingAtr : 0.5) * atr);
  const side = dir === -1 ? 'H' : 'L', opp = dir === -1 ? 'L' : 'H';
  const better = (a, b2) => dir === -1 ? a < b2 : a > b2;   // a lower high (short) / a higher low (long)
  const hs = z.filter(x => x.kind === side), ls = z.filter(x => x.kind === opp);
  let run = 0; for (let i = hs.length - 1; i > 0 && better(hs[i].p, hs[i - 1].p); i--) run++;
  const minLH = Number.isFinite(cfg.waveMinLowerHighs) ? cfg.waveMinLowerHighs : 2;
  const structure = run >= minLH;
  const lastSw = z[z.length - 1] || null, lastH = hs[hs.length - 1] || null, prevH = hs[hs.length - 2] || null, lastL = ls[ls.length - 1] || null;
  const buf = (Number.isFinite(cfg.waveLineBufferAtr) ? cfg.waveLineBufferAtr : 0.2) * atr, sbuf = Number.isFinite(cfg.waveStopBufferPts) ? cfg.waveStopBufferPts : 0.5;
  const lineAt = t => (lastH && prevH && lastH.t !== prevH.t) ? lastH.p + (lastH.p - prevH.p) * (t - lastH.t) / (lastH.t - prevH.t) : null;
  // shelf of swing lows (short) / ceiling of swing highs (long): the latest opposite swings within waveShelfAtr x ATR of the most recent one
  const tol = (Number.isFinite(cfg.waveShelfAtr) ? cfg.waveShelfAtr : 0.25) * atr;
  const rl = rawPivots(cb, k).filter(x => x.kind === opp);   // the shelf uses every confirmed pivot low (high), not only the zig-zag swings
  const shelfEndingAt = end => { const grp = []; for (let i = end; i >= 0; i--) { if (!grp.length || Math.abs(rl[i].p - grp[0].p) <= tol) grp.push(rl[i]); else break; }
    return grp.length >= 2 ? { level: dir === -1 ? Math.min(...grp.map(x => x.p)) : Math.max(...grp.map(x => x.p)), touches: grp.length, from: grp[grp.length - 1].t, to: grp[0].t } : null; };
  const shelf = rl.length ? shelfEndingAt(rl.length - 1) : null;
  // the most recent shelf that price has since closed through (support turned resistance: entry A's "prior zone" after a breakdown)
  let broken = null; for (let e = rl.length - 1; e >= 1 && !broken; e--) { const sh = shelfEndingAt(e); if (sh && cb.some(x => x.t > sh.to && (dir === -1 ? x.c < sh.level : x.c > sh.level))) broken = sh; }
  const confirmBars = Number.isFinite(cfg.waveConfirmBars) ? cfg.waveConfirmBars : 3;
  const setups = [];
  for (let n = Math.max(1, cb.length - confirmBars); n < cb.length; n++) {
    const C = cb[n], P = cb[n - 1];
    if (structure && lastH && C.t > lastH.t) {   // entry A: rejection at the line / the prior swing-high zone
      const lv = lineAt(C.t), zones = [lv, lastH.p, broken && cb.some(x => x.t > broken.to && x.t < C.t && (dir === -1 ? x.c < broken.level : x.c > broken.level)) ? broken.level : null].filter(Number.isFinite);
      const touched = zones.find(zv => dir === -1 ? C.h >= zv - buf && C.h <= zv + buf * 2 : C.l <= zv + buf && C.l >= zv - buf * 2);
      const rejected = dir === -1 ? C.c < C.o && (lv == null || C.c < lv) : C.c > C.o && (lv == null || C.c > lv);
      if (touched != null && rejected) setups.push({ kind: 'A', t: C.t, closeT: C.t + M5, zone: touched, stop: dir === -1 ? C.h + sbuf : C.l - sbuf, text: `entry A: the 5m candle ${hmPt(C.t)} touched ${touched.toFixed(2)} and closed back ${dir === -1 ? 'down' : 'up'} ${C.c.toFixed(2)}` });
    }
    if (structure && shelf && lastH) {   // entry B: triangle breakdown / breakout
      const brk = dir === -1 ? C.c < shelf.level && P.c >= shelf.level : C.c > shelf.level && P.c <= shelf.level;
      if (brk && Number.isFinite(C.v) && Number.isFinite(P.v) && C.v > P.v) setups.push({ kind: 'B', t: C.t, closeT: C.t + M5, shelf: shelf.level, stop: dir === -1 ? lastH.p + sbuf : lastH.p - sbuf, text: `entry B: the 5m candle ${hmPt(C.t)} closed ${C.c.toFixed(2)} ${dir === -1 ? 'below' : 'above'} the ${shelf.touches}-touch shelf ${shelf.level.toFixed(2)} on volume ${C.v} > ${P.v}` });
    }
  }
  const lastClose = cb[cb.length - 1];
  const setup = setups.filter(x => x.closeT === lastClose.t + M5).pop() || null;   // fired on the LAST closed candle (trigger mode)
  const recent = setups[setups.length - 1] || null;
  const p = Number.isFinite(px) ? px : lastClose.c;
  const pulledBack = structure && lastSw && lastSw.kind === side && (!prevH || better(lastSw.p, prevH.p)) && (!lastL || (dir === -1 ? p >= lastL.p : p <= lastL.p));   // spec rules-10-18 B: DOWN needs >= 2 lower highs
  const ok = !!recent || !!pulledBack;
  const out = { known: true, ok, dir, atr: Math.round(atr * 100) / 100, structure, lowerHighs: run, brokenShelf: broken, swings: z.slice(-6).map(x => ({ kind: x.kind, t: x.t, p: x.p })), line: lastH && prevH ? { t1: prevH.t, p1: prevH.p, t2: lastH.t, p2: lastH.p } : null, shelf, setup, recent,
    swingExt: lastL ? lastL.p : null, prior: prevH ? prevH.p : null, fresh: lastSw && lastSw.kind === side ? lastSw.p : null };
  out.text = recent ? `wave: ${recent.text}` : pulledBack ? `wave: ${dir === -1 ? 'lower high' : 'higher low'} ${lastSw.p.toFixed(2)} printed after the 5m swing ${dir === -1 ? 'low' : 'high'}${lastL ? ' ' + lastL.p.toFixed(2) : ''}${structure ? ` (${run} ${dir === -1 ? 'lower highs' : 'higher lows'} in a row)` : ''}`
    : `wave: no ${dir === -1 ? 'lower high' : 'higher low'} since the 5m swing ${dir === -1 ? 'low' : 'high'}${lastL ? ' ' + lastL.p.toFixed(2) : ''} (fresh impulsive ${dir === -1 ? 'low' : 'high'}; waiting for the pullback, entry A or B)`;
  return out;
}
function hmPt(t) { return new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }); }
function waveCheck(dir, bars5, now, lookback, cfg = {}) { return waveState(dir, { M5: bars5, M15: cfg.__m15 }, now, cfg); }
// ── ADDENDUM 4 (owner): PULLBACK-DEPTH RULE for wave entry A (CONFIG.pullbackRule, ON in waveMode 'confirm') ──
// Reference bar: the last CLOSED 15m candle, if it is bearish (DOWN regime, shorts) / bullish (UP, longs). Size = its high-low range (pullbackBasis 'range', shipped) or its body ('body').
// Short zone = close + pullbackZone[0] .. close + pullbackZone[1] x size (15% .. 30%); long zone mirrored below the close.
// Entry: a CLOSED 3m candle of the current 15m bar traded into the zone (its high inside it) and closed back down (a red close below the zone top, or a close back
// below the zone) while the pullback never went past the zone top (overrun = no entry from this candle; not void) - longs mirrored.
// VOID: price traded beyond close + pullbackVoid (50%) x size after the reference close -> no wave entry until this 15m candle closes; then the new close is the reference.
// Confluence (logged, +1 grade step): the current 15m, 30m or 1H open lies inside the zone. Stop: beyond the reference candle's high (low) - the structural level.
// It applies only to MARKET with-trend entries (wave / wave-confirmed); a Levels LIMIT / STOP resting at a level is a level entry and is not judged by the zone.
function pullbackState(dir, bars = {}, now, cfg = {}) {
  const c15 = closedBars(bars.M15, 900000, now), ref = c15[c15.length - 1];
  if (!ref || now - (ref.t + 900000) > 900000) return { applies: false, known: false, text: 'pullback: no fresh 15m reference candle' };
  const bear = ref.c < ref.o, bull = ref.c > ref.o;
  if ((dir === -1 && !bear) || (dir === 1 && !bull)) return { applies: false, known: true, ref, text: `pullback: the last 15m candle is not ${dir === -1 ? 'bearish' : 'bullish'} (no reference; the swing rule decides)` };
  const size = cfg.pullbackBasis === 'body' ? Math.abs(ref.o - ref.c) : ref.h - ref.l;   // shipped 'range' (owner correction 10/15)
  const zq = Array.isArray(cfg.pullbackZone) && cfg.pullbackZone.length === 2 ? cfg.pullbackZone : [0.15, 0.30], vq = Number.isFinite(cfg.pullbackVoid) ? cfg.pullbackVoid : 0.5;
  const zlo = dir === -1 ? ref.c + zq[0] * size : ref.c - zq[1] * size, zhi = dir === -1 ? ref.c + zq[1] * size : ref.c - zq[0] * size;
  const voidLvl = dir === -1 ? ref.c + vq * size : ref.c - vq * size, refEnd = ref.t + 900000;
  const after3 = (Array.isArray(bars.M3) ? bars.M3 : []).filter(b => b && b.t >= refEnd && b.t <= now);
  const src = after3.length ? after3 : (Array.isArray(bars.M5) ? bars.M5 : []).filter(b => b && b.t >= refEnd && b.t <= now);   // no 3m feed: the 5m candles
  const tfMs = after3.length ? 180000 : 300000;
  const voided = src.some(b => dir === -1 ? b.h > voidLvl : b.l < voidLvl);
  const st = { applies: true, known: true, dir, ref: { t: ref.t, o: ref.o, h: ref.h, l: ref.l, c: ref.c }, size: Math.round(size * 100) / 100, zone: [Math.round(zlo * 100) / 100, Math.round(zhi * 100) / 100], voidLevel: Math.round(voidLvl * 100) / 100, voided, tf: tfMs === 180000 ? '3m' : '5m',
    stop: dir === -1 ? ref.h : ref.l, rejection: null, confluence: [] };
  if (voided) { st.ok = false; st.text = `pullback VOID: price traded ${dir === -1 ? 'above' : 'below'} ${st.voidLevel.toFixed(2)} (50% of the ${hmPt(ref.t)} 15m ${cfg.pullbackBasis === 'body' ? 'body' : 'range'}) - no wave entry until this 15m candle closes`; return st; }
  const closed = src.filter(b => b.t + tfMs <= now);
  // the pullback must stay INSIDE the zone (owner's 10/14 fixtures: 19% and 23% trigger, 39% does not): a pullback past the zone top (30%) but short of the void
  // level is no entry this candle (not void either)
  st.overrun = src.some(b => dir === -1 ? b.h > zhi + 1e-9 : b.l < zlo - 1e-9);
  // rejection: a closed candle whose high reached the zone (and stayed inside it) closed back down: a red close below the zone top, or a close back below the zone
  const rej = st.overrun ? null : closed.filter(b => dir === -1 ? b.h >= zlo - 1e-9 && b.h <= zhi + 1e-9 && b.c < zhi && (b.c < b.o || b.c < zlo) : b.l <= zhi + 1e-9 && b.l >= zlo - 1e-9 && b.c > zlo && (b.c > b.o || b.c > zhi)).pop() || null;
  if (rej) { st.rejection = { t: rej.t, h: rej.h, l: rej.l, c: rej.c }; st.stop = dir === -1 ? Math.max(ref.h, rej.h) : Math.min(ref.l, rej.l); }
  // confluence: the current 15m / 30m / 1H open inside the zone
  const opens = [['15m', barContaining(bars.M15, now, 900000)], ['1H', barContaining(bars.H1, now, 3600000)]];
  { const b30 = Array.isArray(bars.M15) ? bars.M15.find(b => b && b.t === Math.floor(now / 1800000) * 1800000) : null; if (b30) opens.push(['30m', b30]); }
  for (const [nm, b] of opens) if (b && Number.isFinite(b.o) && b.o >= zlo - 1e-9 && b.o <= zhi + 1e-9) st.confluence.push(nm);
  st.ok = !!rej;
  if (st.overrun) { st.text = `pullback: price went past the zone ${st.zone[0].toFixed(2)}-${st.zone[1].toFixed(2)} (beyond ${Math.round(zq[1] * 100)}% of the ${hmPt(ref.t)} 15m ${cfg.pullbackBasis === 'body' ? 'body' : 'range'}; void only beyond ${st.voidLevel.toFixed(2)}): no wave entry from this candle`; return st; }
  st.text = rej ? `pullback: the ${hmPt(rej.t)} ${st.tf} candle rejected the ${st.zone[0].toFixed(2)}-${st.zone[1].toFixed(2)} zone (${Math.round(zq[0] * 100)}-${Math.round(zq[1] * 100)}% of the ${hmPt(ref.t)} 15m ${cfg.pullbackBasis === 'body' ? 'body' : 'range'})${st.confluence.length ? ' + confluence ' + st.confluence.join('/') + ' open (+1 grade)' : ''}`
    : `pullback: waiting for a ${st.tf} rejection inside ${st.zone[0].toFixed(2)}-${st.zone[1].toFixed(2)} (${Math.round(zq[0] * 100)}-${Math.round(zq[1] * 100)}% of the ${hmPt(ref.t)} 15m ${cfg.pullbackBasis === 'body' ? 'body' : 'range'}; void above ${st.voidLevel.toFixed(2)})`.replace('void above', dir === -1 ? 'void above' : 'void below');
  return st;
}

// ── RULE X (spec rules-10-18.md, Mac's 10/15 21:30 PT squeeze): EXHAUSTION REVERSAL - the second allowed counter-trend path (CONFIG.exhaustionReversal, ON) ──
// A LONG in a DOWN regime (a SHORT in UP, mirrored), market, when ALL hold:
//  1. context: >= 2 of the 15m / 30m / 1H RSI(14) were <= exhaustionRsiLevel (30) on a CLOSED bar within the last exhaustionRsiLookbackBars (6) x 15m. Context only.
//  2. a bullish engulfing candle (body engulfs the prior body, close > prior open) with volume > the prior bar on the 3m AND the 5m AND a CLOSED 15m bar, each at or
//     after the swing low (the lowest low of the last 6 x 15m of 5m bars). The forming 15m bar never counts (no lookahead).
//  3. the fast Ripster clouds are green on the last closed 3m AND 5m bar: EMA5 >= EMA12 and EMA8 >= EMA9 (hl2).
//  4. entry at market; 5. stop below the swing low (- exhaustionStopBufferPts), sized by rule 1;
//  6. target = the NEARER (above price) of the session VWAP (15:00 PT CME day, hlc3 x volume of 5m bars) and the last lower high (or the descending trendline);
//     the whole position exits there (no runner); skipped when the target is less than exhaustionMinRR x the risk.
function engulfs(dir, C, P) {
  if (!C || !P) return false;
  const pTop = Math.max(P.o, P.c), pBot = Math.min(P.o, P.c);
  return dir === 1 ? C.c > C.o && C.o <= pBot && C.c >= pTop && C.c > P.o && C.v > P.v
                   : C.c < C.o && C.o >= pTop && C.c <= pBot && C.c < P.o && C.v > P.v;
}
function fastCloudGreen(dir, bars) {   // last CLOSED bar of `bars`
  if (!Array.isArray(bars) || bars.length < 20) return null;
  const src = bars.map(b => (b.h + b.l) / 2), e5 = ema(src, 5), e12 = ema(src, 12), e8 = ema(src, 8), e9 = ema(src, 9), i = bars.length - 1;
  if ([e5[i], e12[i], e8[i], e9[i]].some(v => v == null)) return null;
  return dir === 1 ? e5[i] >= e12[i] && e8[i] >= e9[i] : e5[i] <= e12[i] && e8[i] <= e9[i];
}
function sessionVwap(bars5, now) {
  const start = (() => { const k = cmeDayKey(now); let t = Math.floor(now / 300000) * 300000; while (t > now - 26 * 3600000 && cmeDayKey(t - 1) === k) t -= 300000; return t; })();
  let pv = 0, vv = 0; for (const b of bars5 || []) { if (!b || b.t < start || b.t + 300000 > now || !(b.v > 0)) continue; const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; }
  return vv > 0 ? pv / vv : null;
}
function exhaustionReversal({ dir, now, bars = {}, cfg = {}, px = null, tick = 0.25 }) {
  const lvl = Number.isFinite(cfg.exhaustionRsiLevel) ? cfg.exhaustionRsiLevel : 30, look = (Number.isFinite(cfg.exhaustionRsiLookbackBars) ? cfg.exhaustionRsiLookbackBars : 6) * 900000;
  const out = { dir, ok: false, context: false, why: null, rsi: {}, engulf: {}, clouds: {}, swing: null, stop: null, target: null, vwap: null, lowerHigh: null };
  // 1. RSI context
  let hits = 0;
  for (const [k, arr, ms] of [['m15', bars.M15, 900000], ['m30', bars.M30, 1800000], ['h1', bars.H1, 3600000]]) {
    const cb = closedBars(arr, ms, now); if (cb.length < 20) { out.rsi[k] = null; continue; }
    const r = rsi(cb.map(b => b.c), 14); let ext = null;
    for (let i = cb.length - 1; i >= 0 && cb[i].t + ms > now - look; i--) { const v = r[i]; if (v == null) continue; ext = ext == null ? v : dir === 1 ? Math.min(ext, v) : Math.max(ext, v); }
    out.rsi[k] = ext == null ? null : Math.round(ext * 10) / 10;
    if (ext != null && (dir === 1 ? ext <= lvl : ext >= 100 - lvl)) hits++;
  }
  out.context = hits >= 2;
  if (!out.context) { out.why = `context: ${hits} of 15m/30m/1H RSI ${dir === 1 ? '<=' : '>='} ${dir === 1 ? lvl : 100 - lvl} in the last ${look / 900000} x 15m (needs 2)`; return out; }
  // swing extreme = the lowest low (highest high) of the 5m bars in the lookback
  const c5 = closedBars(bars.M5, 300000, now), win = c5.filter(b => b.t + 300000 > now - look); if (!win.length) { out.why = 'no 5m bars'; return out; }
  const sw = win.reduce((a, b) => (dir === 1 ? b.l < a.l : b.h > a.h) ? b : a);
  out.swing = { t: sw.t, p: dir === 1 ? sw.l : sw.h };
  // 2. engulfing on 3m, 5m, closed 15m at/after the swing extreme
  const c3 = closedBars(bars.M3, 180000, now), c15 = closedBars(bars.M15, 900000, now);
  const findEngulf = (cb, ms) => { for (let i = cb.length - 1; i >= 1; i--) { if (cb[i].t + ms <= sw.t) break; if (engulfs(dir, cb[i], cb[i - 1])) return cb[i]; } return null; };
  const e3 = findEngulf(c3, 180000), e5 = findEngulf(c5, 300000), e15 = findEngulf(c15, 900000);
  out.engulf = { m3: e3 ? e3.t : null, m5: e5 ? e5.t : null, m15: e15 ? e15.t : null };
  if (!e3 || !e5 || !e15) { out.why = `engulfing with volume after the swing ${dir === 1 ? 'low' : 'high'} ${out.swing.p}: 3m ${e3 ? 'yes' : 'no'}, 5m ${e5 ? 'yes' : 'no'}, closed 15m ${e15 ? 'yes' : 'no'}`; return out; }
  // 3. fast Ripster clouds on 3m and 5m
  const g3 = fastCloudGreen(dir, c3), g5 = fastCloudGreen(dir, c5); out.clouds = { m3: g3, m5: g5 };
  if (!g3 || !g5) { out.why = `fast Ripster clouds not ${dir === 1 ? 'green' : 'red'} on ${!g3 && !g5 ? '3m and 5m' : !g3 ? '3m' : '5m'}`; return out; }
  // 5-6. stop, target, 1R
  const p = Number.isFinite(px) ? px : c5[c5.length - 1].c, buf = Number.isFinite(cfg.exhaustionStopBufferPts) ? cfg.exhaustionStopBufferPts : 0.5;
  const rawStop = dir === 1 ? out.swing.p - buf : out.swing.p + buf; out.stop = dir === 1 ? Math.floor(rawStop / tick + 1e-9) * tick : Math.ceil(rawStop / tick - 1e-9) * tick;
  if (!(dir === 1 ? p > out.swing.p && out.stop < p : p < out.swing.p && out.stop > p)) { out.why = `price ${p} is back ${dir === 1 ? 'at/below the swing low' : 'at/above the swing high'} ${out.swing.p} (no falling knife; the stop would be on the wrong side)`; return out; }   // QA-A D1 (10/15)
  out.vwap = sessionVwap(bars.M5, now); if (out.vwap != null) out.vwap = Math.round(out.vwap * 100) / 100;
  const atr = atr15(bars.M15, now), z = swings5(c5.slice(-96), Number.isFinite(cfg.waveSwingStrength) ? cfg.waveSwingStrength : 3, (Number.isFinite(cfg.waveMinSwingAtr) ? cfg.waveMinSwingAtr : 0.5) * (atr || 0));
  const opp = z.filter(x => x.kind === (dir === 1 ? 'H' : 'L')), last = opp[opp.length - 1], prev = opp[opp.length - 2];
  let lh = last ? last.p : null; if (last && prev && last.t !== prev.t) { const line = last.p + (last.p - prev.p) * (now - last.t) / (last.t - prev.t); if (dir === 1 ? line > p && line < last.p : line < p && line > last.p) lh = line; }
  out.lowerHigh = lh != null ? Math.round(lh * 100) / 100 : null;
  const cands = [out.vwap, out.lowerHigh].filter(v => Number.isFinite(v) && (dir === 1 ? v > p : v < p));
  if (!cands.length) { out.why = `no target: session VWAP ${out.vwap ?? '?'} / last ${dir === 1 ? 'lower high' : 'higher low'} ${out.lowerHigh ?? '?'} are not ${dir === 1 ? 'above' : 'below'} price ${p}`; return out; }
  const tgt = dir === 1 ? Math.min(...cands) : Math.max(...cands); out.target = dir === 1 ? Math.floor(tgt / tick) * tick : Math.ceil(tgt / tick) * tick;
  const risk = Math.abs(p - out.stop), rew = Math.abs(out.target - p), minRR = Number.isFinite(cfg.exhaustionMinRR) ? cfg.exhaustionMinRR : 1;
  out.rr = risk > 0 ? Math.round(rew / risk * 100) / 100 : null;
  if (!(rew >= minRR * risk)) { out.why = `target ${out.target} is ${rew.toFixed(2)} pts away, less than ${minRR}R (${risk.toFixed(2)} pts)`; return out; }
  out.ok = true; out.why = `exhaustion reversal: RSI context ${JSON.stringify(out.rsi)}, engulfing on 3m/5m/15m, fast clouds ${dir === 1 ? 'green' : 'red'}; stop ${out.stop}, target ${out.target} (${out.rr}R)`;
  return out;
}

// counter-trend reclaim of the control open: the last closed 5m candle closed across it (beyond the buffer), the one before was on the other side, volume up
function counterReclaim(dir, ctl, bars5, now) {
  if (!ctl || !Number.isFinite(ctl.open)) return { ok: false, text: 'no control open' };
  const { last: C, prev: P } = lastClosedPair(bars5, M5, now);
  if (!C || !P) return { ok: false, text: 'no closed 5m candles' };
  const lvl = dir === 1 ? ctl.open + (ctl.buffer || 0) : ctl.open - (ctl.buffer || 0);
  const across = dir === 1 ? C.c > lvl && P.c <= lvl : C.c < lvl && P.c >= lvl;
  const vol = Number.isFinite(C.v) && Number.isFinite(P.v) && C.v > P.v;
  return { ok: across && vol, across, vol, text: `${across ? 'closed back across' : 'no 5m close back across'} the ${ctl.tf} open ${ctl.open.toFixed(2)}${across ? (vol ? ' with volume up' : ' but volume not up') : ''}` };
}
// THE direction gate every new entry goes through: { ok, code: null|'TREND_FILTER'|'WAVE_WAIT'|'CONTROL_FILTER', trend, control, wave, counter, text }
// 10-18b2a MOMENTUM CONTINUATION (Mac's b2 ruling Q2, 10/16 09:32 PT: 'Momentum entries is the key', NY = momentum). A with-trend MARKET entry skips the
// pullback-zone and wave rules when momentum confirms it: 'mac' = a MAC-sourced signal of a grade in waveMomentumGrades; 'break' = the last closed 5m
// candle closed beyond the extreme of the previous waveMomentumBreakBars closed 5m candles on more volume than the candle before it; 'both' = either.
// Only in waveMomentumSessions (controlSession names). 'off' (and every caller that passes no source) = the 10-18 rule. Returns null or { kind, ... }.
function momentumConfirm(dir, bars, now, cfg, source, grade) {
  const mode = cfg.waveMomentumPath || 'off'; if (mode === 'off') return null;
  const sess = controlSession(now); if (Array.isArray(cfg.waveMomentumSessions) && !cfg.waveMomentumSessions.includes(sess)) return null;
  if ((mode === 'mac' || mode === 'both') && source === 'mac' && Array.isArray(cfg.waveMomentumGrades) && cfg.waveMomentumGrades.includes(grade)) return { kind: 'mac', grade, session: sess };
  if (mode === 'break' || mode === 'both') {
    const n = Math.max(2, Math.floor(Number(cfg.waveMomentumBreakBars) || 6));
    const cb = closedBars(bars && bars.M5, TF_MS['5m'], now); if (cb.length < n + 1) return null;
    const last = cb[cb.length - 1], prior = cb.slice(cb.length - 1 - n, cb.length - 1), before = prior[prior.length - 1];
    const ext = dir === -1 ? Math.min(...prior.map(b => b.l)) : Math.max(...prior.map(b => b.h));
    const beyond = dir === -1 ? last.c < ext : last.c > ext, volUp = Number.isFinite(last.v) && Number.isFinite(before.v) && last.v > before.v;
    if (beyond && volUp) return { kind: 'break', swingExt: ext, close: last.c, vol: last.v, prevVol: before.v, barT: last.t, session: sess };
  }
  return null;
}
function directionGate({ dir, now, bars = {}, cfg = {}, skipWave = false, px = null, entryType = null, source = null, grade = null }) {
  const control = controlState({ now, bars, cfg });
  const trend = trendState({ now, bars, cfg, px });
  let wave = null, counter = null;
  if (trend.on && trend.known && (trend.regime === 'DOWN' || trend.regime === 'UP')) {
    const withT = (trend.regime === 'DOWN' && dir === -1) || (trend.regime === 'UP' && dir === 1);
    if (!withT) {
      counter = counterReclaim(dir, control, bars.M5, now);
      if (!counter.ok) return { ok: false, code: 'TREND_FILTER', trend, control, wave, counter, text: `${trend.text}: ${dir === 1 ? 'LONG' : 'SHORT'} is counter-trend and not a reclaim (${counter.text})` };
    } else if ((entryType == null || entryType === 'MARKET') && !skipWave && (cfg.waveMode || 'confirm') !== 'off' && (wave = (() => { const m = momentumConfirm(dir, bars, now, cfg, source, grade); return m ? { momentum: m, known: true, ok: true, text: `momentum continuation (${m.kind})` } : null; })())) {
      // 10-18b2a: momentum confirmed -> the pullback-zone and wave rules are skipped for this with-trend MARKET entry (trend regime + control filter still apply)
    } else if ((cfg.waveMode || 'confirm') !== 'off' && !skipWave && entryType !== 'LIMIT') {   // a resting LIMIT at a level only fills ON a pullback: it is a level entry, not judged by the wave (owner, addendum 4)
      wave = waveState(dir, bars, now, cfg, px);
      // ADDENDUM 4: a MARKET with-trend entry (wave / wave-confirmed) must come from a rejection inside the pullback zone of the last 15m candle (entry A);
      // entry B (the triangle breakdown) still confirms on its own; a resting Levels LIMIT / STOP is a level entry and is not judged by the zone.
      let pb = null;
      if (cfg.pullbackRule !== false && (entryType == null || entryType === 'MARKET') && !(wave.recent && wave.recent.kind === 'B')) {
        pb = pullbackState(dir, bars, now, cfg); wave.pullback = pb;
        if (pb.applies) {
          if (pb.voided) return { ok: false, code: 'PULLBACK_VOID', trend, control, wave, counter, text: pb.text };
          if (!pb.ok) return { ok: false, code: 'WAVE_WAIT', trend, control, wave, counter, text: pb.text };
        }
      }
      if (!(pb && pb.applies && pb.ok) && wave.known && !wave.ok) return { ok: false, code: 'WAVE_WAIT', trend, control, wave, counter, text: wave.text };
    }
  }
  if (!controlAllows(control, dir)) return { ok: false, code: 'CONTROL_FILTER', trend, control, wave, counter, text: control.text };
  return { ok: true, code: null, trend, control, wave, counter, text: counter && counter.ok ? `counter-trend reclaim: ${counter.text}` : trend.on && trend.known ? trend.text : control.text };
}

module.exports = { momentumConfirm /* 10-18b2a */, TF_MS, SESSIONS, controlSession, controlTfFor, barContaining, lastClosedPair, controlState, controlAllows, controlText, banMatch, reclaimDecision, closedBars, rippleCloud, priorDayRange, cmeDayKey, trendState, trendText, pivots5, rawPivots, swings5, atr15, waveState, waveCheck, counterReclaim, directionGate, pullbackState, engulfs, fastCloudGreen, sessionVwap, exhaustionReversal };
