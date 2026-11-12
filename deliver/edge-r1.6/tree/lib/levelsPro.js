// Port of "Daily Levels PRO v2 — Scalp Engine" (Pine Script) to JS.
//
// Same design as macTrap.js: replays the full bar history in order so
// stateful concepts (HOLD/PUSH/FLOW EMAs, sweep/fail memory, level status,
// RVOL-by-time-of-day) build up exactly like a live chart. Pass
// htf.M15 = chartBars when evaluating "as a 15m chart", etc.
//
// Skipped (purely visual, no effect on the trade plan): drawing, price
// ladder, dashboard table, confluence-label merging.
//
// Section numbers in comments match the Pine source for auditing.

const { ema, clamp, ptInfo } = require('./helpers');

// Alignment row text with the rule named for each 'open' slot, e.g. "15m+ 1h+ 4h+ (above 4H open 30,794.50)" (alignModeByTf only).
function alignTextOf(rules) {
  const f2 = (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return rules.map(r => `${r.tf}${r.flag == null ? '?' : r.flag ? '+' : '-'}${r.rule === 'open' ? (r.flag == null ? ` (UNKNOWN; ${r.measuredFlag == null ? 'measurement unavailable' : 'measured ' + (r.measuredFlag ? 'above ' : 'at/below ') + r.tf.toUpperCase() + ' open ' + f2(r.open)})` : ` (${r.flag ? 'above' : 'at/below'} ${r.tf.toUpperCase()} open ${f2(r.open)})`) : ''}`).join(' ');
}
function bsearchOpenIndex(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// sessionAnchor 'cme' (2026-10-14, Mac: "3:00 PT like the chart"): the trading day that starts at 15:00 PT (17:00 CT, the CME
// session open; DST-proof because ptInfo is America/Los_Angeles local time) is labelled with the NEXT calendar date, like
// TradingView's time("D") on CME futures. Sunday 15:00 PT opens Monday's day; Friday's last bar is still Friday: one roll.
// r9.15.1: VWAP/POC restart = a true crossing into 06:30 PT (first bar at/after 06:30 on a calendar date), like Pine's crossing
// predicate. Exact-bar is0630 is only for capturing the 06:30 Open. Under cme midnight no longer clears the accumulators, so a
// missing 06:30 bar must still restart them on the next bar (MacDot 6325385298).
function crossedInto0630(pt, prevPt) {
  return pt.minutesOfDay >= 6 * 60 + 30 && (prevPt === null || prevPt.dateStr !== pt.dateStr || prevPt.minutesOfDay < 6 * 60 + 30);
}

// r9.16: VWAP over a bar series with the evaluator's own reset rules (calendar-0630: reset on the 06:30 PT crossing and on the new day, accumulate
// from 06:30; session: reset on the new day only). Returns [{ t, vwap, complete }] per bar (vwap null until volume accumulates). complete = the
// current accumulation began at a real reset seen in this series (not merely at the series' first bar, e.g. a history starting at 09:00).
function vwapFromBars(bars, { anchorCme, vwapSession }) {
  const out = []; let pv = 0, vol = 0, prevKey = null, prevPt = null, complete = false;
  for (const b of [...bars].sort((x, y) => x.t - y.t)) {
    const pt = ptInfo(b.t), key = anchorCme ? cmeDayKey(pt) : pt.dateStr, newDay = prevKey !== null && key !== prevKey;
    if ((prevPt !== null && crossedInto0630(pt, prevPt) && !vwapSession) || newDay) { pv = 0; vol = 0; complete = true; }   // the first bar is never a seen reset
    if ((vwapSession || pt.minutesOfDay >= 6 * 60 + 30) && Number.isFinite(b.v)) { pv += ((b.h + b.l + b.c) / 3) * b.v; vol += b.v; }
    out.push({ t: b.t, vwap: vol > 0 ? pv / vol : null, complete });
    prevKey = key; prevPt = pt;
  }
  return out;
}

function cmeDayKey(pt) {
  if (pt.minutesOfDay < 15 * 60) return pt.dateStr;
  const [y, m, d] = pt.dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The 20-level registry. Index order matches the Pine L_NAME array exactly.
const LEVEL_DEFS = [
  { name: 'PDH', imp: 3.0, roll: false },
  { name: 'PDL', imp: 3.0, roll: false },
  { name: 'PDC', imp: 2.5, roll: false },
  { name: 'Daily Open', imp: 2.0, roll: false },
  { name: 'Asia High', imp: 2.5, roll: false },
  { name: 'Asia Low', imp: 2.5, roll: false },
  { name: 'London High', imp: 2.5, roll: false },
  { name: 'London Low', imp: 2.5, roll: false },
  { name: '06:30 Open', imp: 3.0, roll: false },
  { name: '15:00 Open', imp: 2.5, roll: false },
  { name: 'IB High', imp: 2.0, roll: false },
  { name: 'IB Low', imp: 2.0, roll: false },
  { name: 'VWAP', imp: 3.0, roll: false },
  { name: '4H Open', imp: 3.0, roll: true, periodMin: 240 },
  { name: '1H Open', imp: 2.5, roll: true, periodMin: 60 },
  { name: '30m Open', imp: 2.0, roll: true, periodMin: 30 },
  { name: '15m Open', imp: 1.5, roll: true, periodMin: 15 },
  { name: 'PWH', imp: 3.5, roll: true, periodMin: 10080 },
  { name: 'PWL', imp: 3.5, roll: true, periodMin: 10080 },
  { name: 'Week Open', imp: 3.0, roll: true, periodMin: 10080 },
];
const NL = LEVEL_DEFS.length;

function behWeight(b) {
  if (b === 2 || b === 3) return 1.0;
  if (b === 4 || b === 5) return 0.9;
  if (b === 6 || b === 7) return 0.8;
  if (b === 8 || b === 9) return 0.7;
  if (b === 10 || b === 11) return 0.6;
  return 0.0;
}
function behDir(b) {
  if ([3, 5, 6, 8, 10].includes(b)) return 1;
  if ([2, 4, 7, 9, 11].includes(b)) return -1;
  return 0;
}
function behStr(b) {
  const m = { 12: 'CHOP', 2: 'SWEEP UP', 3: 'SWEEP DN', 4: 'FAIL UP', 5: 'FAIL DN', 1: 'TESTING', 8: 'ACCEPT+', 9: 'ACCEPT-', 6: 'RECLAIM', 7: 'LOST', 10: 'HOLD+', 11: 'HOLD-', 13: 'support', 14: 'resist' };
  return m[b] || 'untested';
}
function ctlStr(c) {
  const m = { 8: 'NEW', 9: 'DIST', 2: 'BUY', [-2]: 'SELL', 3: 'buy', [-3]: 'sell', 1: '->BUY', [-1]: '->SELL' };
  return m[c] ?? '--';
}

/**
 * @param {Array} chartBars - the "chart timeframe" bars, ascending, {t,o,h,l,c,v}
 * @param {Object} htf - { M, W, D, H4, H1, M30, M15 } bar arrays
 * @param {Object} opts - overrides for the indicator's own inputs
 */
const { evaluateSlot: evaluateAlignFreshness, expectedPeriodStart: alignPeriodStart } = require('./alignmentFreshness');
function evaluateLevelsPro(chartBars, htf, opts = {}) {
  const cfg = {
    stMin: 60, ltMin: 360, wHold: 0.35, wPush: 0.40, wFlow: 0.25,
    shiftSens: 0.15, bandMult: 0.25, distantAtr: 1.5, ctrlThresh: 0.22,
    leanRatio: 0.45, confirmBars: 3, acceptBars: 12, chopThresh: 2.5, eventLife: 10,
    engageAtr: 0.6, stopAtr: 0.40, minTgtAtr: 0.60, minRr: 1.5, blockShift: true,
    pbBuffer: 0.10, projTarget: true, projMult: 1.20, useTrig: true,
    wickPct: 0.50, absorbRng: 0.50, rollMinAge: 3,
    // alignTfs (2026-10-09, JayMac's live-dashboard observation — "it takes
    // a long time for all those levels to align") — the three timeframes
    // alignedFull checks for agreement, in order. Defaults to the exact
    // validated 15m/1h/4h combo, unchanged. Any 3 of 'M3'/'M15'/'M30'/'H1'/
    // 'H4' (htf's own keys) can be passed instead, e.g. ['M3','M15','H1']
    // or ['M3','M15','M30'], to swap in faster-reacting timeframes —
    // backtest-first opt-in, not yet a trusted improvement. See the use
    // site below for the EMA/bull-check mechanics (unchanged regardless of
    // which three timeframes are picked).
    alignTfs: ['M15', 'H1', 'H4'],
    // alignModeByTf (2026-10-14, Mac: "the 4hr + needs to be dependent on where
    // we are on the open control line not the EMA"). Per alignTfs key, e.g.
    // { H4: 'open' }. Missing / 'ema' = today's rule (that TF's bar close vs its
    // EMA21), byte-identical. 'open' = '+' when the current price (this chart
    // bar's close; live = the forming price) is above the open of that TF's bar
    // CONTAINING the current bar, '-' when below or equal. The open is fixed from
    // the first tick of that HTF bar, so it never uses a future close.
    alignModeByTf: null,
    // alignFreshness (Mac 10/19, option 2; r8): null = every slot UNKNOWN (the witness-only rule). Otherwise
    // { nowMs, monoNowMs, currentGen, instrument, chartTf, reads: { TF: { doneAt, mono, gen, instrument } } } and ONLY the current decision
    // bar (the last row) may become CURRENT, by lib/alignmentFreshness.js evaluateSlot. Every earlier row stays UNKNOWN exactly as today,
    // so signal edges (prevPlanLong / prevPlanShort) and historical grades are unchanged (MacDot R7 F5).
    alignFreshness: null,
    alignMeasured: false,   // r9.10: true = binary measured alignment (see section 8)
    alignNowMs: null, alignChartTf: null, alignInstrument: null,   // r9.10 measured: decision clock + the chart/instrument the slots are stamped with
    // lv1 r13.3.4 lp1, Pine parity (Levels PRO v2.3/v2.4; MacTrace D1/D2 10/16, re-measured 10/28 16:30 PT). Defaults OFF = the e2a69278 port exactly; the
    // executor's levelsParity 'pine' passes momChartAtr + dedupeLevels true (D6 stays off).
    //  momChartAtr (D1): PUSH momRaw and effort progress divide by the CHART-timeframe ATR(14), floored at 4 ticks (Pine atr_sf, v2.4 :326-327, :729, :802).
    //  dedupeLevels (D2): visible levels within 2 ticks merge into the higher importance one, the later one on a tie (Pine dedupe_lvl, v2.4 :693-708).
    //  atrClosedHour (D6, default OFF: atrRef is load-bearing for stops/targets elsewhere): Pine v2.2+ atr_ref = the last CLOSED hour's ATR (v2.4 :337-341).
    momChartAtr: false, dedupeLevels: false, atrClosedHour: false, tickSize: 0.25,
    ...opts,
  };
  const ALIGN_LABEL = { M3: '3m', M5: '5m', M10: '10m', M15: '15m', M30: '30m', H1: '1h', H4: '4h', D: 'D', W: 'W' };

  const n = chartBars.length;
  const tfMin = ((chartBars[1] ? chartBars[1].t - chartBars[0].t : 900000) / 60000) || 1;

  // ── ATR reference: 1H ATR, stable across chart zoom (section "DISTANCE REFERENCE") ──
  const h1Closes = (htf.H1 || []).map(b => b.c);
  const h1TR = (htf.H1 || []).map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - htf.H1[i - 1].c), Math.abs(b.l - htf.H1[i - 1].c)));
  const h1AtrSeries = [];
  { let prev = null; for (let i = 0; i < h1TR.length; i++) { if (i < 13) { h1AtrSeries.push(null); continue; } if (prev === null) { let s = 0; for (let j = i - 13; j <= i; j++) s += h1TR[j]; prev = s / 14; } else prev = (prev * 13 + h1TR[i]) / 14; h1AtrSeries.push(prev); } }

  // ── TF alignment (cfg.alignTfs, default 15m/1h/4h — see its own comment
  // above). Each slot's own bar series + EMA21, independent of chart TF. ──
  const alignBars = cfg.alignTfs.map(k => htf[k] || []);
  // Levels alignment is period-open for every consumed slot. MAC remains separate.
  const alignAnyOpen = true;

  // ── Persistent state ──
  let dayHi = null, dayLo = null, prevDayHi = null, prevDayLo = null, prevDayC = null, dayOpen = null;
  let asiaHiL = null, asiaLoL = null, asiaHiK = null, asiaLoK = null;
  let lonHiL = null, lonLoL = null, lonHiK = null, lonLoK = null;
  let open0630 = null, open1500 = null;
  let ibHiL = null, ibLoL = null, ibHi = null, ibLo = null;
  let vwPV = 0, vwVol = 0;
  let momStE = 0, momLtE = 0, flwStE = 0, flwLtE = 0;
  let bod = -1, cumVol = 0;
  const VP_AVG = new Array(600).fill(0), VP_N = new Array(600).fill(0);
  let prevDateStr = null, prevIsAsia = null, prevIsLondon = null, prevPt = null;
  // sessionAnchor: 'legacy' (default, unchanged) = day rolls at PT midnight, VWAP restarts 06:30 PT (and at midnight).
  // 'cme' = day (PDH/PDL/PDC, Daily Open, IB, tested/touch, RVOL day) rolls at 15:00 PT like the Pine's
  // newDay = ta.change(time("D")) on CME futures. VWAP (opts.vwapAnchor, r9.15): 'calendar-0630' (default) restarts at the 06:30 PT
  // crossing and at newDay and accumulates from 06:30 (v14 Pine 388-396); 'session' = the r9.14.1 cme path (restart only at newDay).
  const sessionAnchor = opts.sessionAnchor == null ? 'legacy' : opts.sessionAnchor;
  if (sessionAnchor !== 'legacy' && sessionAnchor !== 'cme') throw new Error(`evaluateLevelsPro: sessionAnchor must be 'legacy' or 'cme', got ${JSON.stringify(opts.sessionAnchor)}`);
  const anchorCme = sessionAnchor === 'cme';
  // r9.15 (Mac 10/21: "Bot and indicator should be matching levels"; MacDot: keep day boundary and VWAP anchoring independent).
  // vwapAnchor 'calendar-0630' (default) = Levels PRO v2.4-dev v14 Pine lines 388-396: reset at the 06:30 PT cross OR the new day, accumulate
  // only from 06:30 PT of the calendar day. 'session' = the pre-r9.15 cme behaviour (reset only at the 15:00 PT roll, accumulate every bar).
  // With sessionAnchor 'legacy' the default reproduces the old legacy VWAP exactly.
  const vwapAnchor = opts.vwapAnchor == null ? 'calendar-0630' : opts.vwapAnchor;
  if (vwapAnchor !== 'calendar-0630' && vwapAnchor !== 'session') throw new Error(`evaluateLevelsPro: vwapAnchor must be 'calendar-0630' or 'session', got ${JSON.stringify(opts.vwapAnchor)}`);
  const vwapSession = vwapAnchor === 'session';
  // r9.16 (Mac 10/21 15:15 PT "Switch to 5 minute build"): opts.vwapBars = the 5m series. VWAP is then built from 5m hlc3 x volume with the SAME
  // resets (06:30 PT crossing / new day / session) and each chart row takes the 5m VWAP through the 5m bars inside it. Rows the 5m series does not
  // cover fall back to the chart-built VWAP and say so (vwapSource). No opts.vwapBars = the chart-built VWAP exactly as r9.15.1.
  // r9.16.1 (MacDot 6328045033): CAUSAL as-of - a chart row uses only 5m bars that have ENDED by the row's end (live, the forming 5m bar ends inside
  // the forming chart bar, so it is included; history never sees a later-ending 5m bar). Charts whose timeframe is not a multiple of 5m (3m) get
  // no 5m VWAP. A 5m point counts only when its accumulation began at a real reset inside the series (complete prefix); otherwise fall back, labelled.
  const vwapRequested = opts.vwapBuild === '5m' || Array.isArray(opts.vwapBars);
  const vwapTfOk = Number.isInteger(tfMin) && tfMin % 5 === 0;
  const vwapSeries = vwapRequested && vwapTfOk && Array.isArray(opts.vwapBars) && opts.vwapBars.length ? vwapFromBars(opts.vwapBars, { anchorCme, vwapSession }) : null;
  let vwJ = 0;

  const st = LEVEL_DEFS.map(() => ({
    holdSt: 0, holdLt: 0, dlt: 0, def: 0, tested: false, inband: false, touch: 0,
    side: 0, xage: 9999, xdir: 0, state: 0, beh: 0, swp: 0, swpage: 9999,
    faild: 0, failage: 9999, xcnt: 0, tchage: 9999, scSt: 0, scLt: 0,
    ctlSt: 0, ctlLt: 0, score: 0, prevsc: 0, lLast: null, lAge: 0,
  }));

  const stBars = Math.max(Math.round(cfg.stMin / tfMin), 3);
  const ltBars = Math.max(Math.round(cfg.ltMin / tfMin), 10);
  const aSt = 2.0 / (stBars + 1);
  const aLt = 2.0 / (ltBars + 1);

  const out = [];
  // D1: Pine atr_sf = max(nz(ta.atr(14), 0), mintick*4) on the CHART bars (Wilder RMA, SMA seed at bar 13, 0 before it)
  const chartAtrSf = [];
  if (cfg.momChartAtr) {
    const cTR = chartBars.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - chartBars[i - 1].c), Math.abs(b.l - chartBars[i - 1].c)));
    let prev = null;
    for (let i = 0; i < cTR.length; i++) {
      let a = 0;
      if (i >= 13) { if (prev === null) { let s2 = 0; for (let j = i - 13; j <= i; j++) s2 += cTR[j]; prev = s2 / 14; } else prev = (prev * 13 + cTR[i]) / 14; a = prev; }
      chartAtrSf.push(Math.max(a, cfg.tickSize * 4));
    }
  }

  for (let i = 0; i < n; i++) {
    const bar = chartBars[i];
    const pt = ptInfo(bar.t);
    const dayKey = anchorCme ? cmeDayKey(pt) : pt.dateStr;
    const newDay = prevDateStr !== null && dayKey !== prevDateStr;
    const isAsia = pt.isAsia, isLondon = pt.isLondon;
    const asiaStart = isAsia && prevIsAsia === false, asiaEnd = !isAsia && prevIsAsia === true;
    const lonStart = isLondon && prevIsLondon === false, lonEnd = !isLondon && prevIsLondon === true;
    const cross0630 = pt.is0630, cross1500 = pt.is1500;   // exact-bar: open capture only
    const vwapCross0630 = crossedInto0630(pt, prevPt);    // true crossing: VWAP restart
    const inIB = pt.isIB;

    // ── ATR ref lookup (1H ATR as of this bar's time) ──
    const h1Idx = bsearchOpenIndex(htf.H1 || [], bar.t);
    const h1AtrI = cfg.atrClosedHour ? h1Idx - 1 : h1Idx;   // D6 (off by default): the last CLOSED hour, like Pine ta.atr(14)[1] lookahead_on
    const atrRef = Math.max(h1AtrI >= 0 && h1AtrSeries[h1AtrI] != null ? h1AtrSeries[h1AtrI] : 0, 0.05) || 0.05;
    const band = atrRef * cfg.bandMult;

    // ── 4. Level computation (from the chart's own bars) ──
    // 10/21 PDH/PDL fix (Mac): roll the PRIOR day's high/low BEFORE folding in the current bar. The old order updated dayHi/dayLo with the
    // new session's first bar and then rolled it into prevDayHi/prevDayLo, so PDH/PDL could include the new day's first bar (MAC Trap B1).
    if (dayHi === null) { dayHi = bar.h; dayLo = bar.l; dayOpen = bar.o; }
    if (newDay) { prevDayHi = dayHi; prevDayLo = dayLo; prevDayC = i > 0 ? chartBars[i - 1].c : bar.c; dayHi = bar.h; dayLo = bar.l; dayOpen = bar.o; }
    else { dayHi = Math.max(dayHi, bar.h); dayLo = Math.min(dayLo, bar.l); }

    if (asiaStart) { asiaHiL = bar.h; asiaLoL = bar.l; }
    if (isAsia) { asiaHiL = asiaHiL == null ? bar.h : Math.max(asiaHiL, bar.h); asiaLoL = asiaLoL == null ? bar.l : Math.min(asiaLoL, bar.l); }
    if (asiaEnd && asiaHiL != null) { asiaHiK = asiaHiL; asiaLoK = asiaLoL; }
    const asiaHi = isAsia ? asiaHiL : asiaHiK, asiaLo = isAsia ? asiaLoL : asiaLoK;

    if (lonStart) { lonHiL = bar.h; lonLoL = bar.l; }
    if (isLondon) { lonHiL = lonHiL == null ? bar.h : Math.max(lonHiL, bar.h); lonLoL = lonLoL == null ? bar.l : Math.min(lonLoL, bar.l); }
    if (lonEnd && lonHiL != null) { lonHiK = lonHiL; lonLoK = lonLoL; }
    const lonHi = isLondon ? lonHiL : lonHiK, lonLo = isLondon ? lonLoL : lonLoK;

    if (cross0630) open0630 = bar.o;
    if (cross1500) open1500 = bar.o;

    if (newDay) { ibHiL = ibLoL = ibHi = ibLo = null; }
    if (inIB) { ibHiL = ibHiL == null ? bar.h : Math.max(ibHiL, bar.h); ibLoL = ibLoL == null ? bar.l : Math.min(ibLoL, bar.l); ibHi = ibHiL; ibLo = ibLoL; }

    if ((vwapCross0630 && !vwapSession) || newDay) { vwPV = 0; vwVol = 0; }
    if (vwapSession || pt.minutesOfDay >= 6 * 60 + 30) { vwPV += ((bar.h + bar.l + bar.c) / 3) * bar.v; vwVol += bar.v; }
    let sessVWAP = vwVol > 0 ? vwPV / vwVol : null, vwapSource = 'chart';
    if (vwapRequested && !vwapTfOk) vwapSource = 'chart:tf-not-5m-multiple';
    else if (vwapRequested && !vwapSeries) vwapSource = 'chart-fallback:no-5m-series';
    else if (vwapSeries) {   // the 5m VWAP through the last 5m bar that has ENDED by this chart bar's end and started inside it
      const endT = bar.t + tfMin * 60000;
      while (vwJ < vwapSeries.length && vwapSeries[vwJ].t + 300000 <= endT) vwJ++;
      const last = vwJ > 0 ? vwapSeries[vwJ - 1] : null;
      if (!last || last.t < bar.t) vwapSource = 'chart-fallback:5m-not-covering-row';
      else if (!last.complete) vwapSource = 'chart-fallback:5m-prefix-incomplete';
      else { sessVWAP = last.vwap; vwapSource = '5m'; }
    }

    // ── HTF opens (lookahead_on) ──
    const wIdx = bsearchOpenIndex(htf.W || [], bar.t);
    const h4Idx = bsearchOpenIndex(htf.H4 || [], bar.t);
    const h30Idx = bsearchOpenIndex(htf.M30 || [], bar.t);
    const h15Idx = bsearchOpenIndex(htf.M15 || [], bar.t);
    // PWH/PWL: high/low of the previous COMPLETED week = htf.W bar just before the current one.
    const pwIdx = wIdx > 0 ? wIdx - 1 : -1;
    const pwhV = pwIdx >= 0 ? htf.W[pwIdx].h : null;
    const pwlV = pwIdx >= 0 ? htf.W[pwIdx].l : null;
    const wkOpen = wIdx >= 0 ? htf.W[wIdx].o : null;
    const h4Open = h4Idx >= 0 ? htf.H4[h4Idx].o : null;
    const h1Open = h1Idx >= 0 ? htf.H1[h1Idx].o : null;
    const h30Open = h30Idx >= 0 ? htf.M30[h30Idx].o : null;
    const h15Open = h15Idx >= 0 ? htf.M15[h15Idx].o : null;

    // ── Level registry snapshot for this bar ──
    const px = [prevDayHi, prevDayLo, prevDayC, dayOpen, asiaHi, asiaLo, lonHi, lonLo, open0630, open1500, ibHi, ibLo, sessVWAP, h4Open, h1Open, h30Open, h15Open, pwhV, pwlV, wkOpen];
    const rollOpenIdx = [null, null, null, null, null, null, null, null, null, null, null, null, null, h4Idx, h1Idx, h30Idx, h15Idx, wIdx, wIdx, wIdx];
    const on = LEVEL_DEFS.map(d => !d.roll || d.periodMin > tfMin); // hide_sub: only show rolling opens whose period exceeds chart TF
    // D2: Pine dedupe_lvl. As in Pine, a level switched off inside the inner loop still absorbs later neighbours of its own price.
    if (cfg.dedupeLevels) {
      for (let a = 0; a < NL - 1; a++) {
        if (!on[a] || px[a] == null) continue;
        for (let b = a + 1; b < NL; b++) {
          if (!on[b] || px[b] == null) continue;
          if (Math.abs(px[a] - px[b]) <= cfg.tickSize * 2 + 1e-9) { if (LEVEL_DEFS[b].imp <= LEVEL_DEFS[a].imp) on[b] = false; else on[a] = false; }
        }
      }
    }

    // ── Roll detection + state reset for rolling levels ──
    for (let k = 0; k < NL; k++) {
      const def = LEVEL_DEFS[k];
      const s = st[k];
      if (def.roll) {
        const curOpenIdx = rollOpenIdx[k];
        const rolled = s._lastOpenIdx != null && curOpenIdx != null && curOpenIdx !== s._lastOpenIdx;
        if (rolled || (px[k] != null && s.lLast == null)) {
          Object.assign(s, { holdSt: 0, holdLt: 0, dlt: 0, def: 0, side: 0, xage: 9999, xdir: 0, state: 0, tested: false, inband: false, touch: 0, prevsc: 0, lAge: 0 });
        } else {
          s.lAge += 1;
        }
        s.lLast = px[k];
        s._lastOpenIdx = curOpenIdx;
      } else {
        s.lAge = Math.min(s.lAge + 1, 99999);
      }
    }
    if (newDay) for (let k = 0; k < NL; k++) { st[k].tested = false; st[k].touch = 0; }

    // ── 6. Order flow primitives + global PUSH/FLOW ──
    const barRng = Math.max(bar.h - bar.l, 0.0001);
    const buyVol = bar.v * (bar.c - bar.l) / barRng;
    const sellVol = bar.v * (bar.h - bar.c) / barRng;
    const deltaN = bar.v > 0 ? (buyVol - sellVol) / bar.v : 0;
    const window20 = chartBars.slice(Math.max(0, i - 19), i + 1).map(b => b.v);
    const volAvg = window20.reduce((a, b) => a + b, 0) / window20.length;
    const volW = volAvg > 0 ? Math.min(bar.v / volAvg, 3.0) : 1.0;
    const volExp = volAvg > 0 && bar.v > volAvg * 1.4;

    const momRaw = (bar.c - (i > 0 ? chartBars[i - 1].c : bar.c)) / (cfg.momChartAtr ? chartAtrSf[i] : atrRef);   // D1 (Pine :729 / atr_sf)
    momStE = momStE * (1 - aSt) + momRaw * aSt;
    momLtE = momLtE * (1 - aLt) + momRaw * aLt;
    flwStE = flwStE * (1 - aSt) + deltaN * aSt;
    flwLtE = flwLtE * (1 - aLt) + deltaN * aLt;
    const pushSt = clamp(momStE * stBars * 0.50, -1, 1);
    const pushLt = clamp(momLtE * ltBars * 0.35, -1, 1);
    const flowSt = clamp(flwStE * 2.5, -1, 1);
    const flowLt = clamp(flwLtE * 2.5, -1, 1);
    const pfDiverge = (pushSt > 0.15 && flowSt < -0.08) || (pushSt < -0.15 && flowSt > 0.08);
    const wsumC = Math.max(cfg.wHold + cfg.wPush + cfg.wFlow, 0.01);

    // ── Tape engine: RVOL by time-of-day ──
    bod = newDay ? 0 : bod + 1;
    const vidx = Math.min(Math.max(bod, 0), 599);
    cumVol = newDay ? bar.v : cumVol + bar.v;
    const vpPrior = VP_AVG[vidx], vpN = VP_N[vidx];
    const rvol = vpN > 0 && vpPrior > 0 ? cumVol / vpPrior : null;
    const isLastBar = i === n - 1;
    if (!isLastBar) { // treat all but the still-forming final bar as "confirmed"
      VP_AVG[vidx] = vpN > 0 ? (vpPrior * vpN + cumVol) / (vpN + 1) : cumVol;
      VP_N[vidx] = Math.min(vpN + 1, 20);
    }
    const tapeHeavy = rvol != null && rvol >= 1.5;
    const tapeDead = rvol != null && rvol < 0.70;

    const effN = 5;
    const closeEffN = i >= effN ? chartBars[i - effN].c : bar.c;
    const progress = Math.abs(bar.c - closeEffN) / (cfg.momChartAtr ? chartAtrSf[i] : atrRef);   // D1 (Pine :802 / atr_sf)
    const volWin = chartBars.slice(Math.max(0, i - effN + 1), i + 1).reduce((a, b) => a + b.v, 0);
    const volNorm = volAvg > 0 ? volWin / (volAvg * effN) : 1.0;
    const effDir = bar.c > closeEffN ? 1 : -1;
    const effHeavy = volNorm > 1.20, effMove = progress > 0.35;
    const tapeAbsorbing = effHeavy && !effMove, tapeDriving = effHeavy && effMove, tapeThin = !effHeavy && effMove;

    // ── 7. Per-level state ──
    for (let k = 0; k < NL; k++) {
      const p = px[k], s = st[k];
      if (p == null) {
        s.holdSt *= 0.95; s.holdLt *= 0.98; s.dlt *= 0.95; s.def *= 0.98; s.state = 0;
        continue;
      }
      const inc = (bar.c > p ? 1 : -1) * volW;
      s.holdSt = s.holdSt * (1 - aSt) + inc * aSt;
      s.holdLt = s.holdLt * (1 - aLt) + inc * aLt;
      const atLvl = bar.l <= p + band && bar.h >= p - band;
      if (atLvl) { s.dlt = s.dlt * (1 - aSt) + deltaN * aSt; s.tested = true; if (!s.inband) s.touch += 1; }
      else s.dlt *= 0.995;
      s.inband = atLvl;

      const bdef = bar.l < p && bar.c > p && bar.o >= p;
      const sdef = bar.h > p && bar.c < p && bar.o <= p;
      s.def = clamp(s.def * 0.99 + (bdef ? 1 : 0) - (sdef ? 1 : 0), -3, 3);

      const ns = bar.c > p ? 1 : -1, os = s.side, xdPrev = s.xdir, xaPrev = s.xage;   // lv1 r9: the prior cross, captured before this bar updates it (Pine v2.3 LV-5)
      if (os !== 0 && ns !== os) { s.xdir = ns; s.xage = 0; } else s.xage = Math.min(s.xage + 1, 9999);
      s.side = ns;

      const xa = s.xage, xd = s.xdir;
      s.state = atLvl ? 1 : (xa < cfg.confirmBars && xd !== 0) ? (xd > 0 ? 2 : 3) : (xa >= cfg.confirmBars && xa <= 60 && xd !== 0) ? (xd > 0 ? 4 : 5) : (ns > 0 ? 6 : 7);

      const swUp = bar.h > p && bar.c < p && bar.o < p;
      const swDn = bar.l < p && bar.c > p && bar.o > p;
      if (swUp) { s.swp = 1; s.swpage = 0; } else if (swDn) { s.swp = -1; s.swpage = 0; } else s.swpage = Math.min(s.swpage + 1, 9999);

      if (os !== 0 && ns !== os) {
        if (xdPrev !== 0 && xaPrev < cfg.confirmBars) { s.faild = xdPrev; s.failage = 0; }   // lv1 r9: the PRIOR cross failed (it reversed within confirmBars)
        s.xcnt += 1.0;
      }
      s.failage = s.failage + (s.failage < 9999 ? 1 : 0);
      s.xcnt *= 0.93;

      if (atLvl) s.tchage = 0; else s.tchage = Math.min(s.tchage + 1, 9999);

      const swa = s.swpage, fla = s.failage, tca = s.tchage;
      const distLv = Math.abs(bar.c - p) / atrRef;
      const choppy = s.xcnt >= cfg.chopThresh;
      const defended = tca >= 2 && tca <= 20 && distLv > 0.35 && xa > tca;

      let bh;
      if (choppy) bh = 12;
      else if (swa <= cfg.eventLife) bh = s.swp > 0 ? 2 : 3;
      else if (fla <= cfg.eventLife) bh = s.faild > 0 ? 4 : 5;
      else if (atLvl) bh = 1;
      else if (xd !== 0 && xa >= cfg.acceptBars) bh = xd > 0 ? 8 : 9;
      else if (xd !== 0 && xa >= cfg.confirmBars) bh = xd > 0 ? 6 : 7;
      else if (defended) bh = ns > 0 ? 10 : 11;
      else if (!s.tested) bh = 0;
      else bh = ns > 0 ? 13 : 14;
      s.beh = bh;
    }

    // ── Composite scores + control classification ──
    for (let k = 0; k < NL; k++) {
      const p = px[k], s = st[k];
      if (p == null) { s.scSt = 0; s.scLt = 0; s.ctlSt = 0; s.ctlLt = 0; s.score = 0; continue; }
      const distA = Math.abs(bar.c - p) / atrRef;
      const distant = distA > cfg.distantAtr;
      const hSt = clamp(s.holdSt / 1.5, -1, 1), hLt = clamp(s.holdLt / 1.5, -1, 1);
      const dl = clamp(s.dlt * 2.0, -1, 1), df = clamp(s.def / 3.0, -1, 1);
      const flowEffSt = s.inband ? clamp((flowSt + dl) / 1.6, -1, 1) : flowSt;
      const scSt = (cfg.wHold * hSt + cfg.wPush * pushSt + cfg.wFlow * flowEffSt) / wsumC;
      const scLt = (cfg.wHold * hLt + cfg.wPush * pushLt + cfg.wFlow * flowLt) / wsumC;

      const holderSt = hSt > 0.10 ? 1 : hSt < -0.10 ? -1 : 0;
      const moverSt = pushSt > cfg.shiftSens ? 1 : pushSt < -cfg.shiftSens ? -1 : 0;
      const holderLt = hLt > 0.10 ? 1 : hLt < -0.10 ? -1 : 0;
      const moverLt = pushLt > cfg.shiftSens ? 1 : pushLt < -cfg.shiftSens ? -1 : 0;

      const def = LEVEL_DEFS[k];
      const perBars = def.roll ? def.periodMin / tfMin : 999;
      const minAge = Math.max(1, Math.min(cfg.rollMinAge, Math.round(perBars * 0.15)));
      const tooNew = def.roll && s.lAge < minAge;

      let cSt, cLt;
      if (tooNew) { cSt = 8; cLt = 8; }
      else if (distant) { cSt = 9; cLt = 9; }
      else {
        const leanT = cfg.ctrlThresh * cfg.leanRatio;
        cSt = (holderSt !== 0 && moverSt !== 0 && holderSt !== moverSt) ? moverSt : scSt >= cfg.ctrlThresh ? 2 : scSt <= -cfg.ctrlThresh ? -2 : scSt >= leanT ? 3 : scSt <= -leanT ? -3 : 0;
        cLt = (holderLt !== 0 && moverLt !== 0 && holderLt !== moverLt) ? moverLt : scLt >= cfg.ctrlThresh ? 2 : scLt <= -cfg.ctrlThresh ? -2 : scLt >= leanT ? 3 : scLt <= -leanT ? -3 : 0;
      }
      const raw = 0.55 * scSt + 0.25 * scLt + 0.12 * dl + 0.08 * df;
      const damp = distant ? Math.max(0.25, cfg.distantAtr / distA) : 1.0;
      const comp = raw * damp;

      s.scSt = scSt; s.scLt = scLt; s.ctlSt = cSt; s.ctlLt = cLt; s.score = comp;
      const flip = (s.prevsc <= -cfg.ctrlThresh && comp >= cfg.ctrlThresh) || (s.prevsc >= cfg.ctrlThresh && comp <= -cfg.ctrlThresh);
      s.prevsc = comp;
      void flip; // (FLIPA age tracking omitted — display-only in the source)
    }

    // ── 8. Multi-timeframe alignment (cfg.alignTfs, default 15m/1h/4h) ──
    const alignOpens = [];
    const alignSlots = cfg.alignTfs.map((k, slot) => {
      const bars = alignBars[slot];
      const idx = bsearchOpenIndex(bars, bar.t);
      const selected = idx >= 0 ? bars[idx] : null;
      const duration = { M3:180000, M5:300000, M10:600000, M15:900000, M30:1800000, H1:3600000, H4:14400000 }[k];
      // This bounds a measurement, not a provider/calendar freshness proof.
      const bounded = selected && Number.isFinite(selected.t) && duration && selected.t <= bar.t && bar.t < selected.t + duration;
      const open = bounded && Number.isFinite(selected.o) ? selected.o : null;
      alignOpens[slot] = open;
      const measuredFlag = open != null && Number.isFinite(bar.c) ? bar.c > open : null;
      const fr = cfg.alignFreshness, frOn = !!(fr && typeof fr === 'object') && i === n - 1 && measuredFlag != null;
      const rd = frOn && fr.reads ? fr.reads : {};
      const cand = frOn ? { timeframe:k, chartTf:fr.chartTf, instrument:fr.instrument, open, price:bar.c, barStart:selected.t, priceBarStart:bar.t,
        read:rd[k] ? { ...rd[k] } : null, priceRead:rd[fr.chartTf] ? { ...rd[fr.chartTf] } : null } : null;
      const fresh = frOn ? evaluateAlignFreshness(cand, { nowMs:fr.nowMs, monoNowMs:fr.monoNowMs, currentGen:fr.currentGen, instrument:fr.instrument }) : null;
      if (fresh && fresh.ok) return { ...cand, rule:'period_open', status:'CURRENT', flag:measuredFlag, measuredFlag, reasonCodes:[fresh.code] };
      // r9.10 MEASURED alignment (Mac 10/20: "It's either aligned or not aligned very similar to the indicator"): the slot is DECIDED by the
      // measurement alone - price above / below this timeframe's current-period open, exactly like the TradingView indicator's TF ALIGN row.
      // Only a missing bar (no measurement) stays UNKNOWN, and an UNKNOWN slot still means NOT aligned (alignedFull false). No read-age gate.
      // History rows (i < n-1) use the same bounded period-open measurement the Pine indicator draws, so alignment history (alignNet,
      // `converging`) is real instead of all-UNKNOWN (review r9.10 #3). The DECISION row (i === n-1) is pinned to the wall clock: the open is
      // the bar that starts exactly at the expected current period (lib/currentPeriod.js has already built it from this poll's finer bars when
      // the provider had not created it yet); only when the new period has NO trade yet anywhere is the previous period's bar used - exactly what
      // the indicator shows until the first trade - and that is labelled PREV_PERIOD_NO_TRADE_YET. Price = the chart's latest close (the last
      // trade). chartTf / instrument are stamped so the entry recheck binds the slot to this poll's board (review r9.10 #1).
      if (cfg.alignMeasured === true && i < n - 1 && measuredFlag != null) return { timeframe:k, rule:'period_open', status:'CURRENT', flag:measuredFlag, measuredFlag,
        open, price:bar.c, barStart:selected.t, priceBarStart:bar.t, reasonCodes:['MEASURED'] };
      if (cfg.alignMeasured === true && i === n - 1 && Number.isFinite(bar.c) && bars.length) {
        const nowMs = Number.isSafeInteger(cfg.alignNowMs) ? cfg.alignNowMs : bar.t, exp = alignPeriodStart(k, nowMs);
        const dur = { M3:180000, M5:300000, M10:600000, M15:900000, M30:1800000, H1:3600000, H4:14400000 }[k];
        // MacDot 6297275089: the current-period bar must be unique (conflicting duplicates at exp prove nothing -> OPEN_UNPROVEN path below)
        const atExp = Number.isFinite(exp) ? bars.filter(b => b && b.t === exp) : [], conflict = atExp.some(b => b.o !== atExp[0].o);
        const cur = atExp.length && !conflict ? atExp[0] : null, prevI = bsearchOpenIndex(bars, nowMs), prev = prevI >= 0 ? bars[prevI] : null;
        // review N1: the fallback is accepted only when it is the provider's own bar covering now (its grid differs from ours) or the period that
        // ended exactly when the new one began (no trade yet in the new one). An older bar = a stale/truncated series: left to the UNKNOWN path.
        const prevOk = prev && Number.isFinite(dur) && prev.t + dur >= exp;
        // MacDot 6297069784: the previous period's open stands in ONLY while the new period has no trade anywhere in this poll's bars. If any
        // bar at/after the expected start exists (the period HAS traded) but none starts exactly at it, the open is UNPROVEN: not aligned.
        const newTraded = Number.isFinite(exp) && (conflict || bar.t >= exp || ['M3', 'M5', 'M15'].some(s => Array.isArray(htf[s]) && htf[s].some(b => b && b.t >= exp)));
        const coversNow = prev && Number.isFinite(dur) && prev.t + dur > nowMs;
        const use = cur || (!conflict && prevOk && (coversNow || !newTraded) ? prev : null);
        if (!use && prevOk && newTraded) return { timeframe:k, chartTf:cfg.alignChartTf ?? null, instrument:cfg.alignInstrument ?? null, rule:'period_open', status:'UNKNOWN', flag:null,
          measuredFlag:null, open:null, price:bar.c, barStart:null, priceBarStart:bar.t, reasonCodes:['OPEN_UNPROVEN'] };
        // MacDot 6297206503: no new-period bar anywhere does not PROVE no trading (it may be a feed gap), so the previous period's open never
        // admits: the slot is reported (open, flag) but UNKNOWN = not aligned until a bar proves the current period's open (next poll).
        if (use && Number.isFinite(use.o) && !cur && !(use.t + dur > nowMs)) { alignOpens[slot] = use.o;
          return { timeframe:k, chartTf:cfg.alignChartTf ?? null, instrument:cfg.alignInstrument ?? null, rule:'period_open', status:'UNKNOWN', flag:null, measuredFlag:bar.c > use.o,
            open:use.o, price:bar.c, barStart:use.t, priceBarStart:bar.t, reasonCodes:['PREV_PERIOD_NO_TRADE_YET'] }; }
        if (use && Number.isFinite(use.o)) {
          const f = bar.c > use.o; alignOpens[slot] = use.o;
          return { timeframe:k, chartTf:cfg.alignChartTf ?? null, instrument:cfg.alignInstrument ?? null, rule:'period_open', status:'CURRENT', flag:f, measuredFlag:f,
            open:use.o, price:bar.c, barStart:use.t, priceBarStart:bar.t, reasonCodes:[cur ? (cur.derived ? 'MEASURED_DERIVED_' + cur.derivedFrom : 'MEASURED') : 'MEASURED_PROVIDER_GRID'] };
        }
      }
      // Without a passing freshness rule the measurement is never labeled CURRENT.
      return { timeframe:k, rule:'period_open', status:'UNKNOWN', flag:null, measuredFlag,
        open, price:Number.isFinite(bar.c) ? bar.c : null, barStart: selected ? selected.t : null,
        reasonCodes:[!bounded ? 'MISSING_OR_OUT_OF_INTERVAL_BAR' : fresh ? fresh.code : 'MISSING_PROVIDER_EVIDENCE'] };
    });
    const alignFlags = alignSlots.map(s => s.flag);
    // Generalized to cfg.alignTfs.length (was hardcoded to 3) so a
    // different-sized alignTfs array — e.g. a 2-slot regime+trigger
    // hierarchy instead of 3 symmetric peers — computes alignedFull
    // correctly instead of it being unreachable. Byte-identical for the
    // default 3-slot config: alignBull in 0..3, alignNet in {-3,-1,1,3}.
    const nAlign = cfg.alignTfs.length;
    const alignBull = alignFlags.filter(Boolean).length;
    const alignmentKnown = nAlign > 0 && alignSlots.every(s => s.status === 'CURRENT');
    const alignNet = alignmentKnown ? alignBull - (nAlign - alignBull) : 0;
    const alignAbs = Math.abs(alignNet);
    const alignAbsPrev10 = out[i - 10] ? Math.abs(out[i - 10]._alignNet) : alignAbs;
    const converging = alignAbs > alignAbsPrev10;
    const alignedFull = alignmentKnown && alignAbs === nAlign;

    const d4 = h4Open != null && bar.c > h4Open, d1h = h1Open != null && bar.c > h1Open, d30 = h30Open != null && bar.c > h30Open;
    const driveN = 3, driveBull = (d4 ? 1 : 0) + (d1h ? 1 : 0) + (d30 ? 1 : 0);
    const driveNote = driveBull === driveN ? 'BUYERS DRIVING' : driveBull === 0 ? 'SELLERS DRIVING' : driveBull === 2 ? (d30 ? 'buyers, 4H soft' : 'buyers, 30m fading') : (d30 ? 'sellers, 30m turning' : 'sellers, 4H soft');

    // ── 9. Board bias ──
    let bnum = 0, bden = 0, stsum = 0, ltsum = 0, wsum = 0;
    for (let k = 0; k < NL; k++) {
      const p = px[k]; if (p == null || !on[k]) continue;
      const s = st[k];
      const prox = 1.0 / (1.0 + Math.abs(bar.c - p) / atrRef);
      const w = LEVEL_DEFS[k].imp * prox;
      bnum += s.score * w; bden += w; stsum += s.scSt * w; ltsum += s.scLt * w; wsum += w;
    }
    const biasScore = bden > 0 ? bnum / bden : 0;
    const stBias = wsum > 0 ? stsum / wsum : 0;
    const ltBias = wsum > 0 ? ltsum / wsum : 0;
    const driveExhaust = (driveBull === driveN && (stBias < 0 || flowSt < -0.10)) || (driveBull === 0 && (stBias > 0 || flowSt > 0.10));
    const boardHolder = stBias > 0.05 ? 1 : stBias < -0.05 ? -1 : 0;
    const boardMover = pushSt > cfg.shiftSens ? 1 : pushSt < -cfg.shiftSens ? -1 : 0;
    const boardShift = boardHolder !== 0 && boardMover !== 0 && boardHolder !== boardMover;
    const biasStr = boardShift ? (boardMover > 0 ? 'SHIFTING TO BUYERS' : 'SHIFTING TO SELLERS')
      : biasScore >= 0.45 ? 'STRONG BUYER CONTROL' : biasScore >= cfg.ctrlThresh ? 'BUYERS IN CONTROL'
      : biasScore <= -0.45 ? 'STRONG SELLER CONTROL' : biasScore <= -cfg.ctrlThresh ? 'SELLERS IN CONTROL'
      : biasScore >= cfg.ctrlThresh * cfg.leanRatio ? 'BUYERS LEANING' : biasScore <= -cfg.ctrlThresh * cfg.leanRatio ? 'SELLERS LEANING' : 'CONTESTED';

    // ── 10. Trade plan ──
    let ipI = -1, ipPx = null, ipD = Infinity;
    for (let k = 0; k < NL; k++) { const p = px[k]; if (p == null || !on[k]) continue; const d = Math.abs(bar.c - p); if (d < ipD) { ipD = d; ipI = k; ipPx = p; } }
    const engaged = ipI >= 0 && ipD <= atrRef * cfg.engageAtr;

    const closeBack3 = i >= 3 ? chartBars[i - 3].c : bar.c;
    const ipDprev = ipI >= 0 ? Math.abs(closeBack3 - ipPx) : Infinity;
    const approachV = (ipI >= 0 && ipDprev < 1e11) ? (ipDprev - ipD) / atrRef / 3.0 : 0;
    const fastApproach = approachV > 0.05 && volExp;
    const slowApproach = approachV > 0 && approachV <= 0.025;

    const ipState = ipI >= 0 ? st[ipI].state : 0;
    const ipCtl = ipI >= 0 ? st[ipI].ctlSt : 0;
    const ipSc = ipI >= 0 ? st[ipI].scSt : 0;
    const ipBeh = ipI >= 0 ? st[ipI].beh : 0;
    const bDir = behDir(ipBeh);
    const behChop = ipBeh === 12;

    const lvlAbove = ipI >= 0 && ipPx > bar.c, lvlBelow = ipI >= 0 && ipPx < bar.c;
    const boardUp = alignNet > 0 && driveBull >= driveN - 1, boardDn = alignNet < 0 && (driveN - driveBull) >= driveN - 1;
    const bullsTaking = ipCtl === 1 || ipCtl === 2, bearsTaking = ipCtl === -1 || ipCtl === -2;
    const bullsHold = ipCtl >= 1, bearsHold = ipCtl <= -1;

    let setup = 0;
    if (engaged && !behChop && bDir !== 0) {
      const flowOk = bDir > 0 ? flowSt > -0.15 : flowSt < 0.15;
      if (flowOk && !tapeThin) {
        if (ipBeh === 2 || ipBeh === 3) setup = bDir > 0 ? 1 : 2;
        else if (ipBeh === 4 || ipBeh === 5) setup = bDir > 0 ? 1 : 2;
        else if (ipBeh === 6) setup = 5;
        else if (ipBeh === 7) setup = 6;
        else if (ipBeh === 8) setup = 5;
        else if (ipBeh === 9) setup = 6;
        else if (ipBeh === 10) setup = 1;
        else if (ipBeh === 11) setup = 2;
      }
    }
    if (engaged && setup === 0 && !behChop) {
      if (lvlAbove) {
        if (bullsTaking && (fastApproach || boardUp || flowSt > 0.10)) setup = 3;
        else if (bearsHold || slowApproach) setup = 2;
      } else if (lvlBelow) {
        if (ipState === 4 || ipState === 6) {
          if (bullsHold) setup = 5;
          else if (bearsTaking && (fastApproach || boardDn)) setup = 4;
        } else if (bearsTaking && (fastApproach || boardDn || flowSt < -0.10)) setup = 4;
        else if (bullsHold) setup = 1;
      }
    }

    let planDir = (setup === 1 || setup === 3 || setup === 5) ? 1 : (setup === 2 || setup === 4 || setup === 6) ? -1 : 0;
    if (behChop) { planDir = 0; setup = 0; }
    if (cfg.blockShift && planDir !== 0) { if ((planDir > 0 && ipCtl === -1) || (planDir < 0 && ipCtl === 1)) { planDir = 0; setup = 0; } }

    // Bar-level triggers
    const rngBar = Math.max(bar.h - bar.l, 0.0001);
    const upWick = bar.h - Math.max(bar.o, bar.c), dnWick = Math.min(bar.o, bar.c) - bar.l;
    const atIp = ipI >= 0 && bar.l <= ipPx + band && bar.h >= ipPx - band;
    const trigRejDn = atIp && bar.h > ipPx && bar.c < ipPx && upWick >= rngBar * cfg.wickPct;
    const trigRejUp = atIp && bar.l < ipPx && bar.c > ipPx && dnWick >= rngBar * cfg.wickPct;
    const prevClose = i > 0 ? chartBars[i - 1].c : bar.c;
    const trigRcUp = ipI >= 0 && bar.c > ipPx && prevClose <= ipPx && volExp;
    const trigRcDn = ipI >= 0 && bar.c < ipPx && prevClose >= ipPx && volExp;
    const trigAbsorb = atIp && volExp && rngBar < atrRef * cfg.absorbRng;
    const trigBull = trigRejUp || trigRcUp, trigBear = trigRejDn || trigRcDn;

    // Structural entry + stop
    let entryPx = null, stopPx = null, entryType = '--';
    if (planDir !== 0 && ipPx != null) {
      const buf = atrRef * cfg.pbBuffer, stp = atrRef * cfg.stopAtr;
      if (setup === 1 || setup === 5) { entryPx = ipPx + buf; stopPx = ipPx - stp; entryType = bar.c <= entryPx + atrRef * 0.03 ? 'MARKET' : 'LIMIT'; }
      else if (setup === 3) { entryPx = ipPx + buf; stopPx = ipPx - stp; entryType = bar.c >= entryPx ? 'MARKET' : 'STOP'; }
      else if (setup === 2 || setup === 6) { entryPx = ipPx - buf; stopPx = ipPx + stp; entryType = bar.c >= entryPx - atrRef * 0.03 ? 'MARKET' : 'LIMIT'; }
      else if (setup === 4) { entryPx = ipPx - buf; stopPx = ipPx + stp; entryType = bar.c <= entryPx ? 'MARKET' : 'STOP'; }
    }

    // Target: next real level WITHIN a sane distance, or ATR projection if
    // there's genuinely nothing usable close enough. 2026-09-24 fix (FIX 8
    // Part B): previously had NO distance cap at all — a real trade record
    // showed a 534-pt "target" (next week's level, pulled across an entire
    // week's range) against a ~10-pt stop, producing fantasy RR math. Capped
    // at 3x ATR; beyond that, treated the same as "no level found" and falls
    // through to the ATR projection below.
    let tgtPx = null, tgtNm = '--', tgtProjected = false;
    if (planDir !== 0 && entryPx != null) {
      let bestGap = Infinity;
      const maxTargetGap = atrRef * 3;
      for (let k = 0; k < NL; k++) {
        const p = px[k]; if (p == null || !on[k]) continue;
        const gap = planDir > 0 ? p - entryPx : entryPx - p;
        if (gap > 0.02 && gap <= maxTargetGap && gap < bestGap) { bestGap = gap; tgtPx = p; tgtNm = LEVEL_DEFS[k].name; }
      }
    }
    if (planDir !== 0 && tgtPx == null && cfg.projTarget && entryPx != null) {
      tgtPx = planDir > 0 ? entryPx + atrRef * cfg.projMult : entryPx - atrRef * cfg.projMult;
      tgtNm = 'ATR projection'; tgtProjected = true;
    }

    let risk = null, reward = null, rr = 0;
    if (planDir !== 0 && stopPx != null && tgtPx != null && entryPx != null) {
      risk = planDir > 0 ? entryPx - stopPx : stopPx - entryPx;
      reward = planDir > 0 ? tgtPx - entryPx : entryPx - tgtPx;
      rr = risk > 0 ? reward / risk : 0;
    }
    const planValid = planDir !== 0 && rr >= cfg.minRr && tgtPx != null && stopPx != null && reward > 0;
    const isLimitType = entryType === 'LIMIT' || entryType === 'STOP';
    const toEntry = entryPx != null ? Math.abs(bar.c - entryPx) : null;
    const trigOk = !cfg.useTrig || (planDir > 0 && trigBull) || (planDir < 0 && trigBear);
    const readyNow = toEntry != null && toEntry <= atrRef * 0.05 && trigOk;

    // Grade
    let g = 0;
    if (planValid) {
      g += Math.min(Math.abs(ipSc) / 0.45, 1.0) * 2.0;
      g += (alignedFull && alignNet * planDir > 0) ? 2.5 : (alignAbs >= 2 && alignNet * planDir > 0) ? 1.6 : converging ? 0.8 : 0.0;
      g += rr <= 1.0 ? 0.0 : rr <= 2.0 ? (rr - 1.0) * 2.0 : rr <= 3.0 ? 2.0 : Math.max(2.0 - (rr - 3.0) * 0.6, 0.4);
      g += behWeight(ipBeh) * 2.0;
      g += (bDir !== 0 && bDir === planDir) ? 0.8 : 0.0;
      g += ((planDir > 0 && flowSt > 0) || (planDir < 0 && flowSt < 0)) ? 1.0 : 0.0;
      g += ((setup === 3 || setup === 4) && fastApproach) ? 1.0 : ((setup === 1 || setup === 2) && slowApproach) ? 1.0 : 0.0;
      g -= ((setup === 3 || setup === 4) && slowApproach) ? 1.5 : 0.0;
      g -= ((setup === 1 || setup === 2) && fastApproach) ? 1.0 : 0.0;
      g -= tgtProjected ? 1.0 : 0.0;
      g -= pfDiverge ? 1.0 : 0.0;
      g += ((planDir > 0 && trigBull) || (planDir < 0 && trigBear)) ? 1.0 : 0.0;
      g -= (trigAbsorb && (setup === 3 || setup === 4)) ? 1.0 : 0.0;
      g -= ((setup === 3 || setup === 4) && tapeDead) ? 1.5 : 0.0;
      g += ((setup === 3 || setup === 4) && tapeHeavy && tapeDriving) ? 1.2 : 0.0;
      g += ((setup === 1 || setup === 2) && tapeAbsorbing) ? 1.0 : 0.0;
      g -= tapeThin ? 1.2 : 0.0;
      g -= ((planDir > 0 && biasScore <= -cfg.ctrlThresh) || (planDir < 0 && biasScore >= cfg.ctrlThresh)) ? 1.8 : 0.0;
      g -= ((planDir > 0 && ltBias <= -cfg.ctrlThresh) || (planDir < 0 && ltBias >= cfg.ctrlThresh)) ? 0.8 : 0.0;
      g -= driveExhaust ? 0.8 : 0.0;
    }
    const gradeStr = !planValid ? '--' : g >= 8.5 ? 'A' : g >= 7.0 ? 'A-' : g >= 6.0 ? 'B' : g >= 5.0 ? 'B-' : g >= 4.0 ? 'C' : 'D';

    const planLong = planValid && planDir > 0 && g >= 6.0;
    const planShort = planValid && planDir < 0 && g >= 6.0;
    const prevPlanLong = i > 0 ? out[i - 1]._planLong : false;
    const prevPlanShort = i > 0 ? out[i - 1]._planShort : false;
    const sigLong = planLong && !prevPlanLong;
    const sigShort = planShort && !prevPlanShort;

    out.push({
      t: bar.t, close: bar.c, atrRef, vwapSource,
      biasStr, biasScore, stBias, ltBias, boardShift, driveNote, driveExhaust,
      alignmentStatus: alignmentKnown ? 'CURRENT' : 'UNKNOWN', alignSlots,
      tfAlign: cfg.alignTfs.map((k, slot) => `${ALIGN_LABEL[k] || k}${alignFlags[slot] == null ? '?' : alignFlags[slot] ? '+' : '-'}`).join(' '), alignedFull, converging,
      // Only present when some TF uses the 'open' rule (default output unchanged):
      // per slot { tf, rule: 'open'|'ema21', flag, open } for the checklist text.
      alignRules: cfg.alignTfs.map((k, slot) => ({ tf: ALIGN_LABEL[k] || k, rule:'open', flag:alignFlags[slot], measuredFlag:alignSlots[slot].measuredFlag, open:alignOpens[slot] })),
      alignText: alignTextOf(cfg.alignTfs.map((k, slot) => ({ tf: ALIGN_LABEL[k] || k, rule:'open', flag:alignFlags[slot], measuredFlag:alignSlots[slot].measuredFlag, open:alignOpens[slot] }))),
      inPlayLevel: ipI >= 0 ? { name: LEVEL_DEFS[ipI].name, price: ipPx, control: ctlStr(ipCtl), behavior: behStr(ipBeh) } : null,
      engaged, setup, setupDir: planDir,
      plan: planValid ? { dir: planDir, entry: entryPx, stop: stopPx, target: tgtPx, targetName: tgtNm, rr, grade: gradeStr, entryType, readyNow, projected: tgtProjected } : null,
      sigLong, sigShort, planLong, planShort,
      levels: LEVEL_DEFS.map((d, k) => px[k] == null || !on[k] ? null : { name: d.name, price: px[k], control: ctlStr(st[k].ctlSt), behavior: behStr(st[k].beh) }).filter(Boolean),
      tapeHeavy, tapeDead, rvol,
      _alignNet: alignNet, _planLong: planLong, _planShort: planShort,
    });

    prevDateStr = dayKey; prevIsAsia = isAsia; prevIsLondon = isLondon; prevPt = pt;
  }

  return out;
}

module.exports = { evaluateLevelsPro, LEVEL_DEFS, vwapFromBars };
