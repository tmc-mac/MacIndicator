// Port of "MAC Trap Machine v4.0" (Pine Script) to JS.
//
// Design: this evaluates the FULL bar history you give it (chartBars) as if
// it were the live chart the indicator is drawn on, replaying every bar in
// order so stateful concepts (trap age, retest state machine, level status,
// fuel gauge) build up exactly like they do on a real TradingView chart.
// `htf` supplies the higher-timeframe bar series it needs
// (M/W/D/H4/H1/M30/M15/M10/M5/M3) — when evaluating "as if this were a 1H
// chart", pass htf.H1 = chartBars. M10/M5/M3 only feed the RSI exhaustion
// check (section 18) — everything else in this file works fine without them.
//
// Only computational logic is ported. Plots, labels, boxes, the dashboard
// table, and the Ripster EMA cloud (a purely visual optional overlay) are
// left out — they don't affect any of the values below.
//
// Section numbers in comments match the original Pine file's own section
// markers, so this can be audited line-by-line against the source.

const { ema, smma, zlema, atr, macd, sma, ptInfo, rsi, adx } = require('./helpers');

function impulseMdSeries(bars) {
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  const hlc3 = bars.map(b => (b.h + b.l + b.c) / 3);
  const len = 34;
  const smmaHi = smma(highs, len);
  const smmaLo = smma(lows, len);
  const zl = zlema(hlc3, len);
  return bars.map((_, i) => {
    if (smmaHi[i] == null || smmaLo[i] == null || zl[i] == null) return 0;
    const mi = zl[i];
    if (mi > smmaHi[i]) return mi - smmaHi[i];
    if (mi < smmaLo[i]) return mi - smmaLo[i];
    return 0;
  });
}

function bsearchOpenIndex(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
// Hold-bars streak helper (2026-10-09) — see cfg.tfFullConfirmMode's
// comment at its use site. Defined once, outside the per-bar loop
// (evaluateMacTrap runs this over the full history, 5 years of 15m bars is
// 80k+ iterations — no reason to recreate a closure that many times).
function updateStreak(open, close, side, streak) {
  if (open == null) return { side: 0, streak: 0 };
  const newSide = close > open ? 1 : close < open ? -1 : 0;
  const newStreak = (newSide !== 0 && newSide === side) ? streak + 1 : (newSide !== 0 ? 1 : 0);
  return { side: newSide, streak: newStreak };
}
function bsearchClosedIndex(bars, ts, barMs) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + barMs <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function precomputeTF(bars) {
  const closes = bars.map(b => b.c);
  return { ef: ema(closes, 9), es: ema(closes, 21), md: impulseMdSeries(bars) };
}

const TF_MS = { H4: 4 * 3600000, H1: 3600000, M30: 30 * 60000, M15: 15 * 60000, M10: 10 * 60000, M5: 5 * 60000, M3: 3 * 60000, D: 86400000 };

/**
 * @param {Array} chartBars - the "chart timeframe" bars, ascending, {t,o,h,l,c,v}
 * @param {Object} htf - { M, W, D, H4, H1, M30, M15, M10, M5, M3 } bar arrays
 * @param {Array} vixBars - [{t,c}] daily VIX closes, ascending
 * @param {Object} opts - overrides for the indicator's own inputs (all optional)
 * @returns {Object} the full time series of computed outputs, one entry per chartBar
 */
// r9.15: the CME trading date (same rule as lib/levelsPro.js cmeDayKey): a bar at/after 15:00 America/Los_Angeles belongs to the next date.
// r9.15.1: VWAP/POC restart = a true crossing into 06:30 PT (first bar at/after 06:30 on a calendar date), like Pine's crossing
// predicate. Exact-bar is0630 is only for capturing the 06:30 Open. Under cme midnight no longer clears the accumulators, so a
// missing 06:30 bar must still restart them on the next bar (MacDot 6325385298).
function crossedInto0630(pt, prevPt) {
  return pt.minutesOfDay >= 6 * 60 + 30 && (prevPt === null || prevPt.dateStr !== pt.dateStr || prevPt.minutesOfDay < 6 * 60 + 30);
}

function cmeDayKey(pt) {
  if (pt.minutesOfDay < 15 * 60) return pt.dateStr;
  const [y, m, d] = pt.dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function evaluateMacTrap(chartBars, htf, vixBars = [], opts = {}) {
  const cfg = {
    cloudLen: 20, atrLen: 14, atrMult: 0.75, squeezeLen: 20,
    emaFast: 9, emaSlow: 21, minTfScore: 4, require4h: true,
    // tfFullRequiresEmaCross (2026-10-09, JayMac's live-dashboard question —
    // "once it reclaims the open that should be a green circle, but they're
    // grey") — ON by default, reproducing the exact validated bull/bearXFull
    // definition unchanged: reclaiming a timeframe's own candle OPEN is only
    // HALF the condition; its own EMA9/EMA21 cross must also agree, which can
    // lag the reclaim by a while (that's the dashboard's disconnect). OFF
    // drops the EMA-cross half from all four dots (4h/1h/30m/15m) at once,
    // leaving just the open-reclaim — directly affects bullTfScore/
    // bearTfScore, L1/L2 scoring, biasStr, AND longAnchoredRaw/
    // shortAnchoredRaw (bull4hFull feeds the anchor gate, not just display).
    // Backtest-first opt-in, not yet a trusted improvement.
    tfFullRequiresEmaCross: true,
    // tfFullConfirmMode / tfFullHoldBars (2026-10-09, JayMac's follow-up:
    // "open vs close with some kind of small time delay" instead of the EMA
    // cross) — a genuinely different confirmation mechanism from
    // tfFullRequiresEmaCross:false (which was measured and rejected: PF
    // 1.15, 55% bust rate — see live-executor.js's chopSkip/minMacScore
    // history for the full numbers). Instead of a lagging moving average,
    // this requires price to have stayed on the reclaimed side of a
    // timeframe's own candle open for tfFullHoldBars CONSECUTIVE evaluated
    // bars running — a dwell-time/persistence confirmation, same concept
    // levelsPro.js already uses (confirmBars) for its own level breaks,
    // just applied here to the open-reclaim. 'emaCross' (default)
    // reproduces today's exact validated behavior unchanged, gated by
    // tfFullRequiresEmaCross as before; 'holdBars' ignores
    // tfFullRequiresEmaCross entirely and uses the streak check instead.
    // Backtest-first opt-in — tfFullHoldBars=2 is a starting guess (30min
    // on the 15m chart), not yet validated against real data.
    tfFullConfirmMode: 'emaCross', tfFullHoldBars: 2,
    // tfDotModeByTf (2026-10-14, Mac: "the 4hr + needs to be dependent on where we are on the open control line not the damn EMA",
    // then: test every TF on its open). Per dot key ('H4' / 'H1' / 'M30' / 'M15'): missing or 'ema' = today's rule for that dot,
    // byte-identical (above the open AND EMA9 > EMA21 per tfFullRequiresEmaCross, or the hold-bars rule). 'open' = that dot is +
    // when the current price (bar.c; live = the forming price) is above the open of that TF's bar CONTAINING the current bar,
    // - when below, = when equal; no EMA, overrides tfFullConfirmMode for that dot only. The open is known from the first tick of
    // that bar: no look-ahead. tfDotOpenSrc (offline sim only): { H4: 'H4S' } reads the open from another htf series (the sim's
    // session-anchored 4H); live leaves it null (htf.H4 / H1 / M30 / M15 as fetched).
    tfDotModeByTf: null, tfDotOpenSrc: null,
    // chopSkipEnabled / chopSkipExemptLowVolume (2026-10-09, JayMac: "remove
    // that filter, I can't have that on during low volume sessions, that's
    // not helping me make any money") — the overnight check that triggered
    // this: 15m ADX sat 11-16 (mostly under the chopSkip threshold) for
    // 4.5+ straight hours through Asia/London, zeroing every entry the whole
    // time. chopSkipEnabled:false removes the gate entirely, everywhere.
    // chopSkipExemptLowVolume:true is the narrower version — keeps the gate
    // during NY (isAsia===false && isLondon===false) but turns it off during
    // Asia/London specifically, the literal "low volume sessions." Both
    // backtest-first opt-ins; chopSkip stays ON everywhere by default,
    // reproducing the exact validated FIX 9 behavior unchanged.
    chopSkipEnabled: true, chopSkipExemptLowVolume: false,
    volSpikeMult: 1.5, vixBlockLevel: 32, useNewsBlock: true,
    // Exhaustion gate variant (2026-09-23 ablation knob):
    //   'full'     — current behavior: 4 straight same-dir H1 candles OR RSI
    //                beyond 25/75 on ANY of 3/5/10/15m (default, unchanged)
    //   'off'      — gate disabled entirely (lateBuyer/lateSeller never set)
    //   'rsi-any'  — RSI leg only (any of 3/5/10/15m beyond 25/75)
    //   'h1-only'  — H1 streak leg only (4 straight same-dir H1 candles)
    //   '15m-only' — RSI leg on the 15m only
    exhaustionGate: 'full',
    // 4h RSI directional veto (standing user directive, 2026-09-23): no longs
    // into 4h overbought, no shorts into 4h oversold. Thresholds tunable;
    // set rsi4hLongMax to null/Infinity or rsi4hShortMin to null/-Infinity to
    // disable that side's veto.
    rsi4hLongMax: 75,
    rsi4hShortMin: 25,
    // 10/18 package (owner decision 10/15: "RSI overbought/oversold must no longer block entries"): mtfRsiVeto false = the 15m/30m/1h RSI >= 75 / <= 25 readings
    // no longer gate anything (mtfVetoLong/Short are false; the raw readings stay in rsiNow15/30/1h and mtfRsiExtremeLong/Short, information only).
    // The bot passes { rsi4hLongMax: null, rsi4hShortMin: null, mtfRsiVeto: false } when its CONFIG.rsiVetoes is false. Default true = the Pine-parity behaviour.
    mtfRsiVeto: true,
    // 4h RSI turn path (2026-09-23): an overbought H4 that starts breaking
    // down validates shorts BEFORE the slow H4 EMA alignment flips (and an
    // oversold H4 turning up mirrors for longs). "Was pinned" = RSI at/past
    // the veto threshold on any of the last rsi4hTurnLookback CLOSED H4 bars;
    // "turning" = the latest closed bar's RSI moved back toward neutral vs
    // the prior closed bar. All reads use fully closed H4 bars — no lookahead.
    rsi4hTurnLookback: 3,
    // 4h-EMA anchor lag fix (2026-10-07, research finding validated against
    // real trade-log mismatches — e.g. the 2026-09-23 MNQ long and
    // 2026-09-24 00:00 PT short, both logged as terminal-vs-chart MISMATCH
    // with a specific "what pushed the 4h-weighted bias here" question).
    // null = exactly today's behavior (unchanged). The turn escape above
    // ONLY fires after RSI was pinned at the 75/25 extreme — a 4H reversal
    // that never got that extreme (e.g. turning down from 62) gets NO
    // escape, so longAnchored/shortAnchored stays hard-gated on the slow
    // EMA9/EMA21 cross, which can lag the real turn by many hours. Setting
    // this adds a SECOND, independent escape: RSI crossing down through
    // this midline (or up through 100-this) on its own, no prior pin
    // required — a genuine momentum shift, not just an extreme-exhaustion
    // reversal. Additive only: OR'd onto the existing pinned-turn escape,
    // never replaces it.
    rsi4hTurnMidline: null,
    ...opts,
  };

  const n = chartBars.length;
  const closes = chartBars.map(b => b.c);
  const opens = chartBars.map(b => b.o);

  // ── 6. Regime cloud + squeeze ──
  const baseline = ema(closes, cfg.cloudLen);
  const atrVal = atr(chartBars, cfg.atrLen);
  const upperBand = closes.map((_, i) => (baseline[i] != null && atrVal[i] != null) ? baseline[i] + atrVal[i] * cfg.atrMult : null);
  const lowerBand = closes.map((_, i) => (baseline[i] != null && atrVal[i] != null) ? baseline[i] - atrVal[i] * cfg.atrMult : null);
  const cloudWidth = closes.map((_, i) => (upperBand[i] != null && lowerBand[i] != null) ? upperBand[i] - lowerBand[i] : null);
  const avgCloudWidth = sma(cloudWidth.map(v => v == null ? 0 : v), cfg.squeezeLen);

  // ── 15. MACD ──
  const { macdLine, signalLine, hist } = macd(closes, 12, 26, 9);

  // ── 16. Impulse + volume ──
  const chartMd = impulseMdSeries(chartBars);
  const volAvg20 = sma(chartBars.map(b => b.v), 20);

  // ── HTF precompute (only D/H4/H1/M30/M15 need close-derived series) ──
  const pre = {
    D: precomputeTF(htf.D || []),
    H4: precomputeTF(htf.H4 || []),
    H1: precomputeTF(htf.H1 || []),
    M30: precomputeTF(htf.M30 || []),
    M15: precomputeTF(htf.M15 || []),
  };
  const d1Baseline = ema((htf.D || []).map(b => b.c), cfg.cloudLen);
  const d1Atr = atr(htf.D || [], cfg.atrLen);

  // Lower-TF RSI for the exhaustion gate below (section 18) — an oversold
  // reading here means "already extended," a real reversal-risk signal,
  // unlike the old level-proximity check it replaces. htf.M10/M5/M3 are only
  // populated when the caller fetched them (fetchAllTimeframes does, live);
  // callers that don't (older backtests/smoke tests) just get an inactive
  // RSI leg here, same as any other htf.X || [] fallback in this file.
  const rsi15 = rsi((htf.M15 || []).map(b => b.c), 14);
  const rsi10 = rsi((htf.M10 || []).map(b => b.c), 14);
  const rsi5 = rsi((htf.M5 || []).map(b => b.c), 14);
  const rsi3 = rsi((htf.M3 || []).map(b => b.c), 14);
  // 4h RSI for the directional veto / turn path (section 14). Fully closed
  // H4 bars only — indexed by h4ClosedIdx, same as the EMA alignment reads.
  const rsiH4 = rsi((htf.H4 || []).map(b => b.c), 14);
  // Multi-timeframe overextension veto (2026-09-24, FIX 5): the 4h veto above
  // takes forever to reach 75/25, so the bot kept shorting into locally-
  // oversold lower-TF moves that 4h RSI hadn't caught up to yet. This adds
  // 15m/30m/1h to the same kind of directional veto — 4h stays the separate,
  // unchanged check it already was.
  const rsi30 = rsi((htf.M30 || []).map(b => b.c), 14);
  const rsi1h = rsi((htf.H1 || []).map(b => b.c), 14);
  // 15m ADX(14) chop-skip (2026-09-24, FIX 9, "B7 — Mac's chosen stack"):
  // trend strength, direction-agnostic — below 15 means chop, skip every
  // entry (trend AND reversal scalp) regardless of what score/RSI says.
  // Needs full OHLC bars, not just closes, unlike the RSI series above.
  const adx15 = adx(htf.M15 || [], 14);

  // ── Persistent state (Pine `var`) ──
  let dayHi = null, dayLo = null, pdhPt = null, pdlPt = null;
  let asiaHiLive = null, asiaLoLive = null, asiaHiLock = null, asiaLoLock = null;
  let lonHiLive = null, lonLoLive = null, lonHiLock = null, lonLoLock = null;
  let open0630 = null, open1500 = null;
  let vwapPv = 0, vwapVol = 0;
  let sessPoc = null, sessPocVol = 0;
  let cvd = 0;
  let barsSinceTrap = 999, lastTrapDir = 0;
  // Hold-bars confirmation (2026-10-09, JayMac: "open vs close with some
  // kind of small time delay" as an alternative to the EMA9/21 cross — see
  // cfg.tfFullConfirmMode's own comment). Tracks, per timeframe, how many
  // CONSECUTIVE evaluated bars price has stayed on the same side of that
  // timeframe's own candle open — resets the instant the side flips, no
  // persistence across a flip-flop. Mirrors levelsPro.js's own confirmBars
  // concept (same codebase, same idea, different engine).
  let h4Side = 0, h4Streak = 0, h1Side = 0, h1Streak = 0, h30Side = 0, h30Streak = 0, h15Side = 0, h15Streak = 0;
  // Reversal grader (2026-09-24): consecutive CLOSED 15m bars in extreme, per
  // direction — lets a consumer tell a fresh cross (barsInExtremeX === 1)
  // from a pinned multi-bar stretch, without re-deriving it from history.
  let barsInExtremeLong = 0, barsInExtremeShort = 0;
  let lvlState = 0, trackedLevel = null;
  let retestState = 0;
  let prevDateStr = null, prevIsAsia = null, prevIsLondon = null, prevPt = null;
  let prevRegimeBull = false, prevRegimeBear = false, prevRegimeRange = true;
  let prevIsSqueezing = false;

  // r9.15 sessionAnchor: 'legacy' (default here, unchanged) = the day (PDH/PDL, session locks, opens, VWAP/POC/CVD resets) rolls at PT midnight;
  // 'cme' = it rolls at 15:00 America/Los_Angeles like the MAC Trap Pine (MACPARITY NEW_DAY_LAST_TIME = the 15:00 PT session open).
  const sessionAnchor = cfg.sessionAnchor == null ? 'legacy' : cfg.sessionAnchor;
  if (sessionAnchor !== 'legacy' && sessionAnchor !== 'cme') throw new Error(`evaluateMacTrap: sessionAnchor must be 'legacy' or 'cme', got ${JSON.stringify(cfg.sessionAnchor)}`);
  const anchorCme = sessionAnchor === 'cme';

  const out = [];

  for (let i = 0; i < n; i++) {
    const bar = chartBars[i];
    const pt = ptInfo(bar.t);
    const dayKey = anchorCme ? cmeDayKey(pt) : pt.dateStr;
    const newDay = prevDateStr !== null && dayKey !== prevDateStr;
    const isAsia = pt.isAsia, isLondon = pt.isLondon;
    const asiaStart = isAsia && prevIsAsia === false;
    const asiaEnd = !isAsia && prevIsAsia === true;
    const lonStart = isLondon && prevIsLondon === false;
    const lonEnd = !isLondon && prevIsLondon === true;
    const cross0630 = pt.is0630;                          // exact-bar: open capture only
    const nyCross0630 = crossedInto0630(pt, prevPt);      // true crossing: VWAP/POC restart
    const cross1500 = pt.is1500;
    const inNY = pt.minutesOfDay >= 6 * 60 + 30;
    const newsWindow = cfg.useNewsBlock && pt.isNewsWindow;

    // ── 7. PDH/PDL + session hi/lo (computed off the CHART's own bars) ──
    // 10/21 PDH/PDL fix (Mac): roll the prior day BEFORE folding in the current bar (the old order leaked the new day's first bar into PDH/PDL).
    if (dayHi === null) { dayHi = bar.h; dayLo = bar.l; }
    if (newDay) { pdhPt = dayHi; pdlPt = dayLo; dayHi = bar.h; dayLo = bar.l; }
    else { dayHi = Math.max(dayHi, bar.h); dayLo = Math.min(dayLo, bar.l); }

    if (newDay) { asiaHiLive = asiaLoLive = asiaHiLock = asiaLoLock = null; }
    if (asiaStart) { asiaHiLive = bar.h; asiaLoLive = bar.l; }
    if (isAsia) { asiaHiLive = asiaHiLive == null ? bar.h : Math.max(asiaHiLive, bar.h); asiaLoLive = asiaLoLive == null ? bar.l : Math.min(asiaLoLive, bar.l); }
    if (asiaEnd && asiaHiLive != null) { asiaHiLock = asiaHiLive; asiaLoLock = asiaLoLive; }
    const asiaHigh = isAsia ? asiaHiLive : asiaHiLock;
    const asiaLow = isAsia ? asiaLoLive : asiaLoLock;

    if (newDay) { lonHiLive = lonLoLive = lonHiLock = lonLoLock = null; }
    if (lonStart) { lonHiLive = bar.h; lonLoLive = bar.l; }
    if (isLondon) { lonHiLive = lonHiLive == null ? bar.h : Math.max(lonHiLive, bar.h); lonLoLive = lonLoLive == null ? bar.l : Math.min(lonLoLive, bar.l); }
    if (lonEnd && lonHiLive != null) { lonHiLock = lonHiLive; lonLoLock = lonLoLive; }
    const londonHigh = isLondon ? lonHiLive : lonHiLock;
    const londonLow = isLondon ? lonLoLive : lonLoLock;

    if (newDay) { open0630 = open1500 = null; }
    if (cross0630) open0630 = bar.o;
    if (cross1500) open1500 = bar.o;

    // ── 8. Session VWAP + POC + CVD ──
    if (nyCross0630 || newDay) { vwapPv = 0; vwapVol = 0; }
    if (inNY) { vwapPv += ((bar.h + bar.l + bar.c) / 3) * bar.v; vwapVol += bar.v; }
    const sessVwap = vwapVol > 0 ? vwapPv / vwapVol : null;

    if (nyCross0630 || newDay) { sessPoc = null; sessPocVol = 0; }
    if (inNY && bar.v > sessPocVol) { sessPoc = (bar.h + bar.l + bar.c) / 3; sessPocVol = bar.v; }

    const barRange = Math.max(bar.h - bar.l, 0.0001);
    const buyVol = bar.v * (bar.c - bar.l) / barRange;
    const sellVol = bar.v * (bar.h - bar.c) / barRange;
    if (newDay) cvd = 0;
    cvd += (buyVol - sellVol);

    // ── 5. HTF opens (lookahead_on: current/forming bar of that period) ──
    const monthlyOpenIdx = bsearchOpenIndex(htf.M || [], bar.t);
    const weeklyOpenIdx = bsearchOpenIndex(htf.W || [], bar.t);
    const dailyOpenIdx = bsearchOpenIndex(htf.D || [], bar.t);
    const h4OpenIdx = bsearchOpenIndex(htf.H4 || [], bar.t);
    const h1OpenIdx = bsearchOpenIndex(htf.H1 || [], bar.t);
    const h30OpenIdx = bsearchOpenIndex(htf.M30 || [], bar.t);
    const h15OpenIdx = bsearchOpenIndex(htf.M15 || [], bar.t);
    const monthlyOpen = monthlyOpenIdx >= 0 ? htf.M[monthlyOpenIdx].o : null;
    const weeklyOpen = weeklyOpenIdx >= 0 ? htf.W[weeklyOpenIdx].o : null;
    const dailyOpen = dailyOpenIdx >= 0 ? htf.D[dailyOpenIdx].o : null;
    const h4Open = h4OpenIdx >= 0 ? htf.H4[h4OpenIdx].o : null;
    const h1Open = h1OpenIdx >= 0 ? htf.H1[h1OpenIdx].o : null;
    const h30Open = h30OpenIdx >= 0 ? htf.M30[h30OpenIdx].o : null;
    const h15Open = h15OpenIdx >= 0 ? htf.M15[h15OpenIdx].o : null;

    // Daily regime + momentum (lookahead_off: last CLOSED daily bar)
    const dClosedIdx = bsearchClosedIndex(htf.D || [], bar.t, TF_MS.D);
    const d1Close = dClosedIdx >= 0 ? htf.D[dClosedIdx].c : null;
    const d1BaselineV = dClosedIdx >= 0 ? d1Baseline[dClosedIdx] : null;
    const d1AtrV = dClosedIdx >= 0 ? d1Atr[dClosedIdx] : null;
    const d1Ef = dClosedIdx >= 0 ? pre.D.ef[dClosedIdx] : null;
    const d1Es = dClosedIdx >= 0 ? pre.D.es[dClosedIdx] : null;

    // Intraday momentum per TF (lookahead_off: last CLOSED bar of that TF)
    const h4ClosedIdx = bsearchClosedIndex(htf.H4 || [], bar.t, TF_MS.H4);
    const h1ClosedIdx = bsearchClosedIndex(htf.H1 || [], bar.t, TF_MS.H1);
    const m30ClosedIdx = bsearchClosedIndex(htf.M30 || [], bar.t, TF_MS.M30);
    const m15ClosedIdx = bsearchClosedIndex(htf.M15 || [], bar.t, TF_MS.M15);
    const m10ClosedIdx = bsearchClosedIndex(htf.M10 || [], bar.t, TF_MS.M10);
    const m5ClosedIdx = bsearchClosedIndex(htf.M5 || [], bar.t, TF_MS.M5);
    const m3ClosedIdx = bsearchClosedIndex(htf.M3 || [], bar.t, TF_MS.M3);
    const ef4h = h4ClosedIdx >= 0 ? pre.H4.ef[h4ClosedIdx] : null, es4h = h4ClosedIdx >= 0 ? pre.H4.es[h4ClosedIdx] : null, md4h = h4ClosedIdx >= 0 ? pre.H4.md[h4ClosedIdx] : 0;
    const ef1h = h1ClosedIdx >= 0 ? pre.H1.ef[h1ClosedIdx] : null, es1h = h1ClosedIdx >= 0 ? pre.H1.es[h1ClosedIdx] : null, md1h = h1ClosedIdx >= 0 ? pre.H1.md[h1ClosedIdx] : 0;
    const ef30 = m30ClosedIdx >= 0 ? pre.M30.ef[m30ClosedIdx] : null, es30 = m30ClosedIdx >= 0 ? pre.M30.es[m30ClosedIdx] : null, md30 = m30ClosedIdx >= 0 ? pre.M30.md[m30ClosedIdx] : 0;
    const ef15 = m15ClosedIdx >= 0 ? pre.M15.ef[m15ClosedIdx] : null, es15 = m15ClosedIdx >= 0 ? pre.M15.es[m15ClosedIdx] : null, md15 = m15ClosedIdx >= 0 ? pre.M15.md[m15ClosedIdx] : 0;

    // VIX (lookahead_off: last CLOSED daily VIX bar)
    const vixClosedIdx = bsearchClosedIndex(vixBars, bar.t, TF_MS.D);
    const vixNow = vixClosedIdx >= 0 ? vixBars[vixClosedIdx].c : null;

    // ── 6. Regime ──
    const regimeBull = upperBand[i] != null && bar.c > upperBand[i];
    const regimeBear = lowerBand[i] != null && bar.c < lowerBand[i];
    const regimeRange = !regimeBull && !regimeBear;
    const isSqueezing = cloudWidth[i] != null && avgCloudWidth[i] != null && cloudWidth[i] < avgCloudWidth[i] * 0.75;
    const isCoiling = regimeRange && isSqueezing;
    const squeezeBreakoutUp = regimeBull && prevRegimeRange && prevIsSqueezing;
    const squeezeBreakoutDown = regimeBear && prevRegimeRange && prevIsSqueezing;
    const breakoutUp = regimeBull && !prevRegimeBull;
    const breakoutDown = regimeBear && !prevRegimeBear;

    const d1Upper = (d1BaselineV != null && d1AtrV != null) ? d1BaselineV + d1AtrV * cfg.atrMult : null;
    const d1Lower = (d1BaselineV != null && d1AtrV != null) ? d1BaselineV - d1AtrV * cfg.atrMult : null;
    const d1Bull = d1Close != null && d1Upper != null && d1Close > d1Upper;
    const d1Bear = d1Close != null && d1Lower != null && d1Close < d1Lower;

    // ── 9. Trap detection ──
    const sweptAbove = lvl => lvl != null && bar.h > lvl && bar.c < lvl && bar.o < lvl;
    const sweptBelow = lvl => lvl != null && bar.l < lvl && bar.c > lvl && bar.o > lvl;
    const trapGate = regimeBull || regimeBear;
    const buyersTrappedRaw = [monthlyOpen, weeklyOpen, dailyOpen, h4Open, h1Open, pdhPt, open0630, open1500, asiaHigh, londonHigh, sessVwap].some(sweptAbove);
    const sellersTrappedRaw = [monthlyOpen, weeklyOpen, dailyOpen, h4Open, h1Open, pdlPt, open0630, open1500, asiaLow, londonLow, sessVwap].some(sweptBelow);
    const buyersTrapped = buyersTrappedRaw && trapGate;
    const sellersTrapped = sellersTrappedRaw && trapGate;
    if (buyersTrapped) { barsSinceTrap = 0; lastTrapDir = 1; }
    else if (sellersTrapped) { barsSinceTrap = 0; lastTrapDir = -1; }
    else barsSinceTrap += 1;
    const trapFresh = barsSinceTrap <= 8;
    const trapBullNow = trapFresh && lastTrapDir === -1;
    const trapBearNow = trapFresh && lastTrapDir === 1;

    // ── 10. Nearest key level ──
    const candidates = [
      ['Monthly Open', monthlyOpen], ['Weekly Open', weeklyOpen], ['Daily Open', dailyOpen],
      ['4H Open', h4Open], ['1H Open', h1Open], ['PDH', pdhPt], ['PDL', pdlPt],
      ['06:30 Open', open0630], ['15:00 Open', open1500], ['Asia High', asiaHigh], ['Asia Low', asiaLow],
      ['London High', londonHigh], ['London Low', londonLow], ['Session VWAP', sessVwap], ['Session POC', sessPoc],
    ].filter(([, px]) => px != null);
    let nln = 'None', nlp = null, nd = Infinity;
    for (const [name, px] of candidates) {
      const d = Math.abs(bar.c - px);
      if (d < nd) { nd = d; nlp = px; nln = name; }
    }

    // ── 14. Bias engine ──
    // Hold-bars streak update (2026-10-09, see cfg.tfFullConfirmMode's own
    // comment) — runs every bar regardless of which mode is active, so
    // switching modes live never starts from a cold streak. updateStreak()
    // itself is defined once outside the loop (below); side: 1 above open,
    // -1 below, 0 if open isn't known yet. A flip (or an unknown open)
    // resets the streak to 1 (or 0); staying on the same side extends it.
    ({ side: h4Side, streak: h4Streak } = updateStreak(h4Open, bar.c, h4Side, h4Streak));
    ({ side: h1Side, streak: h1Streak } = updateStreak(h1Open, bar.c, h1Side, h1Streak));
    ({ side: h30Side, streak: h30Streak } = updateStreak(h30Open, bar.c, h30Side, h30Streak));
    ({ side: h15Side, streak: h15Streak } = updateStreak(h15Open, bar.c, h15Side, h15Streak));

    // tfFullRequiresEmaCross — see its own comment above. The `&& efX > esX`
    // (bull) / `&& efX < esX` (bear) clause is the EMA-cross half; dropped
    // entirely when the flag is off, leaving only the open-reclaim half.
    const emaOk = cfg.tfFullRequiresEmaCross;
    const holdMode = cfg.tfFullConfirmMode === 'holdBars';
    const dotOpenMode = (k) => !!cfg.tfDotModeByTf && cfg.tfDotModeByTf[k] === 'open';
    const dotOpen = (k, own) => { const src = cfg.tfDotOpenSrc && cfg.tfDotOpenSrc[k]; if (!src) return own; const bs = htf[src] || []; const j = bsearchOpenIndex(bs, bar.t); return j >= 0 ? bs[j].o : null; };
    const o4 = dotOpenMode('H4') ? dotOpen('H4', h4Open) : null, o1 = dotOpenMode('H1') ? dotOpen('H1', h1Open) : null;
    const o30 = dotOpenMode('M30') ? dotOpen('M30', h30Open) : null, o15 = dotOpenMode('M15') ? dotOpen('M15', h15Open) : null;
    const bull4hFull = dotOpenMode('H4') ? (o4 != null && bar.c > o4) : holdMode ? (h4Side === 1 && h4Streak >= cfg.tfFullHoldBars)
      : h4Open != null && ef4h != null && es4h != null && bar.c > h4Open && (!emaOk || ef4h > es4h);
    const bull1hFull = dotOpenMode('H1') ? (o1 != null && bar.c > o1) : holdMode ? (h1Side === 1 && h1Streak >= cfg.tfFullHoldBars)
      : h1Open != null && ef1h != null && es1h != null && bar.c > h1Open && (!emaOk || ef1h > es1h);
    const bull30Full = dotOpenMode('M30') ? (o30 != null && bar.c > o30) : holdMode ? (h30Side === 1 && h30Streak >= cfg.tfFullHoldBars)
      : h30Open != null && ef30 != null && es30 != null && bar.c > h30Open && (!emaOk || ef30 > es30);
    const bull15Full = dotOpenMode('M15') ? (o15 != null && bar.c > o15) : holdMode ? (h15Side === 1 && h15Streak >= cfg.tfFullHoldBars)
      : h15Open != null && ef15 != null && es15 != null && bar.c > h15Open && (!emaOk || ef15 > es15);
    const bear4hFull = dotOpenMode('H4') ? (o4 != null && bar.c < o4) : holdMode ? (h4Side === -1 && h4Streak >= cfg.tfFullHoldBars)
      : h4Open != null && ef4h != null && es4h != null && bar.c < h4Open && (!emaOk || ef4h < es4h);
    const bear1hFull = dotOpenMode('H1') ? (o1 != null && bar.c < o1) : holdMode ? (h1Side === -1 && h1Streak >= cfg.tfFullHoldBars)
      : h1Open != null && ef1h != null && es1h != null && bar.c < h1Open && (!emaOk || ef1h < es1h);
    const bear30Full = dotOpenMode('M30') ? (o30 != null && bar.c < o30) : holdMode ? (h30Side === -1 && h30Streak >= cfg.tfFullHoldBars)
      : h30Open != null && ef30 != null && es30 != null && bar.c < h30Open && (!emaOk || ef30 < es30);
    const bear15Full = dotOpenMode('M15') ? (o15 != null && bar.c < o15) : holdMode ? (h15Side === -1 && h15Streak >= cfg.tfFullHoldBars)
      : h15Open != null && ef15 != null && es15 != null && bar.c < h15Open && (!emaOk || ef15 < es15);
    const bullTfScore = (bull4hFull ? 3 : 0) + (bull1hFull ? 2 : 0) + (bull30Full ? 1 : 0) + (bull15Full ? 1 : 0);
    const bearTfScore = (bear4hFull ? 3 : 0) + (bear1hFull ? 2 : 0) + (bear30Full ? 1 : 0) + (bear15Full ? 1 : 0);
    // ── 14b. 4h RSI directional veto + turn path (2026-09-23) ──
    // Standing directive: no longs into 4h overbought, no shorts into 4h
    // oversold — 4h extension overrides a lower-TF bullish/bearish read.
    // The turn path is the mirror exception: an overbought H4 that starts
    // breaking down validates shorts BEFORE the slow H4 EMA alignment flips
    // (oversold-then-turning-up mirrors for longs). All reads use fully
    // closed H4 bars (h4ClosedIdx) — no lookahead. Nulling a threshold
    // disables that side's veto AND its turn path (the turn is defined
    // against the same threshold).
    const rsiH4Now = h4ClosedIdx >= 0 ? rsiH4[h4ClosedIdx] : null;
    const rsiH4Prev = h4ClosedIdx > 0 ? rsiH4[h4ClosedIdx - 1] : null;
    let h4WasPinnedHigh = false, h4WasPinnedLow = false;
    for (let k = 0; k < cfg.rsi4hTurnLookback && h4ClosedIdx - k >= 0; k++) {
      const v = rsiH4[h4ClosedIdx - k];
      if (v == null) continue;
      if (cfg.rsi4hLongMax != null && v >= cfg.rsi4hLongMax) h4WasPinnedHigh = true;
      if (cfg.rsi4hShortMin != null && v <= cfg.rsi4hShortMin) h4WasPinnedLow = true;
    }
    // Midline escape (2026-10-07): RSI crossing down through rsi4hTurnMidline
    // (or up through its mirror, 100-rsi4hTurnMidline) this bar vs last,
    // independent of any prior pin. OR'd onto the pinned-turn path below —
    // null leaves h4TurnDown/h4TurnUp exactly as validated before this.
    const h4TurnDownMidline = cfg.rsi4hTurnMidline != null && rsiH4Now != null && rsiH4Prev != null
      && rsiH4Prev >= cfg.rsi4hTurnMidline && rsiH4Now < cfg.rsi4hTurnMidline;
    const h4TurnUpMidline = cfg.rsi4hTurnMidline != null && rsiH4Now != null && rsiH4Prev != null
      && rsiH4Prev <= (100 - cfg.rsi4hTurnMidline) && rsiH4Now > (100 - cfg.rsi4hTurnMidline);
    const h4TurnDown = (rsiH4Now != null && rsiH4Prev != null && h4WasPinnedHigh && rsiH4Now < rsiH4Prev) || h4TurnDownMidline;
    const h4TurnUp = (rsiH4Now != null && rsiH4Prev != null && h4WasPinnedLow && rsiH4Now > rsiH4Prev) || h4TurnUpMidline;
    const rsi4hVetoLong = cfg.rsi4hLongMax != null && rsiH4Now != null && rsiH4Now >= cfg.rsi4hLongMax;
    const rsi4hVetoShort = cfg.rsi4hShortMin != null && rsiH4Now != null && rsiH4Now <= cfg.rsi4hShortMin;
    // ── 14c. Multi-timeframe overextension veto (2026-09-24, FIX 5) ──
    // Any closed RSI(14) on 15m/30m/1h at/beyond 75/25 blocks a trend-
    // continuation entry into that extreme — same directional-only shape as
    // the 4h veto (blocks one side, not both), just faster to trigger since
    // it doesn't wait on the slow 4h clock. Uses the SAME closed-bar indices
    // (m15ClosedIdx/m30ClosedIdx/h1ClosedIdx) already computed above for the
    // EMA-alignment reads — no lookahead.
    const rsiNow15 = m15ClosedIdx >= 0 ? rsi15[m15ClosedIdx] : null;
    const rsiNow30 = m30ClosedIdx >= 0 ? rsi30[m30ClosedIdx] : null;
    const rsiNow1h = h1ClosedIdx >= 0 ? rsi1h[h1ClosedIdx] : null;
    const mtfReadings = [rsiNow15, rsiNow30, rsiNow1h];
    const mtfRsiExtremeLong = mtfReadings.some(v => v != null && v >= 75);   // 10/18: the raw reading (information)
    const mtfRsiExtremeShort = mtfReadings.some(v => v != null && v <= 25);
    const mtfVetoLong = cfg.mtfRsiVeto !== false && mtfRsiExtremeLong;    // 10/18: the gate (false when the RSI vetoes are switched off)
    const mtfVetoShort = cfg.mtfRsiVeto !== false && mtfRsiExtremeShort;
    // ── 14d. ADX chop-skip (2026-09-24, FIX 9) ──
    // Direction-agnostic, so it gates BOTH sides equally (unlike the RSI
    // vetoes above, which only ever block one side). Folded into
    // longAnchored/shortAnchored the same way — flows through to
    // activeDir/activeScore/biasStr with zero signal.js changes needed for
    // the mac-sourced side; lib/signal.js separately extends this to the
    // levels-sourced side too, since chop-skip means "skip ALL entries."
    const adxNow15 = m15ClosedIdx >= 0 ? adx15[m15ClosedIdx] : null;
    const chopSkipRaw = adxNow15 != null && adxNow15 < 15;
    const chopSkip = chopSkipRaw && cfg.chopSkipEnabled && !(cfg.chopSkipExemptLowVolume && (isAsia || isLondon));
    const longAnchoredRaw = !cfg.require4h || bull4hFull || h4TurnUp;
    const shortAnchoredRaw = !cfg.require4h || bear4hFull || h4TurnDown;
    const longAnchored = longAnchoredRaw && !rsi4hVetoLong && !mtfVetoLong && !chopSkip;
    const shortAnchored = shortAnchoredRaw && !rsi4hVetoShort && !mtfVetoShort && !chopSkip;
    const biasLongStrong = bullTfScore >= 6 && longAnchored;
    const biasShortStrong = bearTfScore >= 6 && shortAnchored;
    const biasLongPartial = bullTfScore >= cfg.minTfScore && longAnchored;
    const biasShortPartial = bearTfScore >= cfg.minTfScore && shortAnchored;
    const htfConflict = (biasLongPartial && d1Bear) || (biasShortPartial && d1Bull);

    // ── 15. MACD state ──
    const macdBullish = macdLine[i] != null && signalLine[i] != null && macdLine[i] > signalLine[i];
    const macdBearish = macdLine[i] != null && signalLine[i] != null && macdLine[i] < signalLine[i];
    const histBullish = hist[i] != null && hist[i] > 0;
    const histBearish = hist[i] != null && hist[i] < 0;
    const prevMacd = i > 0 ? macdLine[i - 1] : null, prevSignal = i > 0 ? signalLine[i - 1] : null;
    const macdCrossUp = macdBullish && prevMacd != null && prevSignal != null && prevMacd <= prevSignal;
    const macdCrossDn = macdBearish && prevMacd != null && prevSignal != null && prevMacd >= prevSignal;
    const prevHist = i > 0 ? hist[i - 1] : null;
    const macdStrBull = histBullish && prevHist != null && hist[i] > prevHist;
    const macdStrBear = histBearish && prevHist != null && hist[i] < prevHist;
    const histWindow = hist.slice(Math.max(0, i - 49), i + 1).filter(v => v != null);
    const histHi = histWindow.length ? Math.max(...histWindow) : null;
    const histLo = histWindow.length ? Math.min(...histWindow) : null;
    const macdExtremeBull = histBullish && histHi != null && histHi > 0 && hist[i] > histHi * 0.8;
    const macdExtremeBear = histBearish && histLo != null && histLo < 0 && hist[i] < histLo * 0.8;
    const macdConfBull = macdCrossUp || macdStrBull || macdExtremeBull;
    const macdConfBear = macdCrossDn || macdStrBear || macdExtremeBear;

    // ── 16. Impulse + volume ──
    const impMd = chartMd[i];
    const impulseBull = impMd > 0, impulseBear = impMd < 0;
    const volRatio = volAvg20[i] > 0 ? bar.v / volAvg20[i] : 1;
    const volExpansion = volRatio > cfg.volSpikeMult;
    const volCompression = volRatio < 0.7;
    const volNormal = volRatio >= 0.7 && volRatio <= cfg.volSpikeMult;
    const volOk = volExpansion || volNormal;
    const volSpikeBull = volExpansion && bar.c > bar.o;
    const volSpikeBear = volExpansion && bar.c < bar.o;

    // ── 17. VIX regime ──
    const vixOk = vixNow == null || vixNow < cfg.vixBlockLevel;

    // ── 18. Late entry / exhaustion ──
    // Was: 3 straight same-direction 15m closes AND price at/through the
    // daily open or PDH/PDL. That blocked exactly the setup the user wants —
    // a breakdown through yesterday's low on a trend day is a PREFERRED
    // short, not exhaustion, and the level-proximity check couldn't tell the
    // two apart. Replaced with two real exhaustion signals instead of a
    // level-based proxy for one: (a) trend DURATION — 4 straight
    // same-direction 1H candles, counted on the higher timeframe instead of
    // the noisy chart one; (b) momentum being already extended — RSI beyond
    // 25/75 on any of 3/5/10/15m. Either alone is real evidence the move is
    // late; this is an OR, not an AND, of the two.
    const h1i = h1ClosedIdx;
    const h1BullStreak4 = h1i >= 3 && [0, 1, 2, 3].every(k => htf.H1[h1i - k].c > htf.H1[h1i - k].o);
    const h1BearStreak4 = h1i >= 3 && [0, 1, 2, 3].every(k => htf.H1[h1i - k].c < htf.H1[h1i - k].o);
    // rsiNow15 is already computed above (section 14c, shared with the MTF veto).
    const rsiNow10 = m10ClosedIdx >= 0 ? rsi10[m10ClosedIdx] : null;
    const rsiNow5 = m5ClosedIdx >= 0 ? rsi5[m5ClosedIdx] : null;
    const rsiNow3 = m3ClosedIdx >= 0 ? rsi3[m3ClosedIdx] : null;
    const rsiReadings = [rsiNow3, rsiNow5, rsiNow10, rsiNow15];
    const rsiOverbought = rsiReadings.some(v => v != null && v > 75);
    const rsiOversold = rsiReadings.some(v => v != null && v < 25);
    const rsiOverbought15m = rsiNow15 != null && rsiNow15 > 75;
    const rsiOversold15m = rsiNow15 != null && rsiNow15 < 25;
    // exhaustionGate ablation (2026-09-23): which leg(s) of the late-entry
    // gate are active. 'full' is the standing behavior (either leg alone
    // blocks); the other variants isolate each leg so the backtest can tell
    // which one actually earns its keep.
    let lateBuyer = false, lateSeller = false;
    switch (cfg.exhaustionGate) {
      case 'off': break; // gate disabled
      case 'rsi-any': lateBuyer = rsiOverbought; lateSeller = rsiOversold; break;
      case 'h1-only': lateBuyer = h1BullStreak4; lateSeller = h1BearStreak4; break;
      case '15m-only': lateBuyer = rsiOverbought15m; lateSeller = rsiOversold15m; break;
      default: lateBuyer = h1BullStreak4 || rsiOverbought; lateSeller = h1BearStreak4 || rsiOversold; // 'full'
    }

    // ── 18b. Reversal Grader (2026-09-24) ──
    // Single source of truth for overextension setups — computed once here
    // from bar history alone (no live/position state, which this file never
    // sees), consumed by BOTH the mobile terminal's "Reversal Grader" card
    // (as `mac.reversal`, for learning/observability) and FIX 5's actual
    // trade trigger below (reversalDir/reversalLongReady/reversalShortReady
    // are now thin derivations of `reversal.grade`, not a separate
    // computation). Deliberately 15m-only for the grade itself — no 4h
    // filter, no 3m/5m confirmation (both tested, both added nothing or hurt
    // per the backtest notes) — 3m/5m RSI still travel in the object as
    // display-only fast-timeframe context.
    function wickRatio15m(dir, k) {
      const c = htf.M15[m15ClosedIdx - k];
      if (!c) return 0;
      const range = c.h - c.l;
      if (range <= 0) return 0;
      const wick = dir === 1 ? (Math.min(c.o, c.c) - c.l) : (c.h - Math.max(c.o, c.c));
      return wick / range;
    }
    function wickCount15m(dir) {
      if (m15ClosedIdx < 2) return 0; // need 3 closed candles
      let count = 0;
      for (let k = 0; k < 3; k++) if (wickRatio15m(dir, k) >= 0.40) count++;
      return count;
    }
    // extreme/dir/grade reflect the CURRENT bar's read and hold through a
    // whole pinned stretch (never fresh-cross-gated themselves) —
    // barsInExtreme is what lets a consumer (the journal, the notifier)
    // tell "just crossed" (===1) from "been pinned a while" (>1).
    const extremeLong = rsiNow15 != null && rsiNow15 <= 25;
    const extremeShort = rsiNow15 != null && rsiNow15 >= 75;
    barsInExtremeLong = extremeLong ? barsInExtremeLong + 1 : 0;
    barsInExtremeShort = extremeShort ? barsInExtremeShort + 1 : 0;
    const reversalDirRaw = extremeLong ? 1 : extremeShort ? -1 : 0;
    const reversalWickCount = reversalDirRaw !== 0 ? wickCount15m(reversalDirRaw) : 0;
    const reversalWickConfirmed = reversalWickCount >= 2;
    // htfAligned: confidence TAG only, never a gate (n=8 in the study, too
    // small) — closed 30m AND 1h RSI also extreme in the SAME direction.
    const reversalHtfAligned = reversalDirRaw === 0 ? false
      : reversalDirRaw === 1 ? (rsiNow30 != null && rsiNow30 <= 25 && rsiNow1h != null && rsiNow1h <= 25)
      : (rsiNow30 != null && rsiNow30 >= 75 && rsiNow1h != null && rsiNow1h >= 75);
    const reversalGrade = reversalDirRaw === 0 ? null : reversalWickConfirmed ? 'PRIME' : 'EXTENDED';
    // Per-candle wick ratios (2026-09-24, Reversal Grader Task 2's wick
    // checklist) — oldest to newest of the last 3 closed 15m candles, each
    // 0-1 (fraction of that candle's own range). null entries when fewer
    // than 3 closed candles exist yet, or when there's no active direction
    // to grade a wick against.
    const reversalWickRatios = reversalDirRaw === 0 ? [null, null, null]
      : [2, 1, 0].map(k => (m15ClosedIdx >= 2 ? wickRatio15m(reversalDirRaw, k) : null));
    const reversal = {
      rsi3: rsiNow3, rsi5: rsiNow5, rsi15: rsiNow15, rsi30: rsiNow30, rsi1h: rsiNow1h,
      dir: reversalDirRaw, extreme: reversalDirRaw !== 0, grade: reversalGrade,
      wickConfirmed: reversalWickConfirmed, wickCount: reversalWickCount, wickRatios: reversalWickRatios,
      htfAligned: reversalHtfAligned,
      barsInExtreme: reversalDirRaw === 1 ? barsInExtremeLong : reversalDirRaw === -1 ? barsInExtremeShort : 0,
    };
    // FIX 5's live trigger: only grade PRIME is actionable. chopSkip (ADX
    // trend-strength filter — independent of the RSI extreme a reversal
    // needs) still applies, same as before this refactor.
    const reversalLongReady = reversalGrade === 'PRIME' && reversalDirRaw === 1 && !chopSkip;
    const reversalShortReady = reversalGrade === 'PRIME' && reversalDirRaw === -1 && !chopSkip;
    const reversalDir = reversalLongReady ? 1 : reversalShortReady ? -1 : 0;

    // ── 12. Level status state machine ──
    const tolerance = 0.05; // syminfo.mintick*5 substitute — futures mintick is tiny; use a small absolute band
    const touching = nlp != null && (Math.abs(bar.c - nlp) <= tolerance || Math.abs(bar.l - nlp) <= tolerance || Math.abs(bar.h - nlp) <= tolerance);
    const lvSwept = sweptAbove(nlp) || sweptBelow(nlp);
    const lvFailed = nlp != null && ((bar.c > nlp * 1.0005 && bar.o < nlp) || (bar.c < nlp * 0.9995 && bar.o > nlp));
    if (newDay) lvlState = 0;
    if (trackedLevel !== nlp) { trackedLevel = nlp; lvlState = 0; }
    if (lvlState === 0) { if (lvSwept) lvlState = 1; else if (lvFailed) lvlState = 4; }
    else if (lvlState === 1) { if (touching) lvlState = 2; }
    else if (lvlState === 2) { if (lvFailed) lvlState = 4; else if (!touching && !lvSwept) lvlState = 3; }

    // ── 13. Cloud retest state machine ──
    const retestTouchBull = regimeBull && upperBand[i] != null && bar.l <= upperBand[i] * 1.001;
    const retestTouchBear = regimeBear && lowerBand[i] != null && bar.h >= lowerBand[i] * 0.999;
    const retestHeldBull = retestTouchBull && bar.c > upperBand[i];
    const retestHeldBear = retestTouchBear && bar.c < lowerBand[i];
    const retestFailBull = retestTouchBull && bar.c < upperBand[i];
    const retestFailBear = retestTouchBear && bar.c > lowerBand[i];
    if (newDay) retestState = 0;
    if (breakoutUp || breakoutDown) retestState = 1;
    else if (retestState === 1 || retestState === 2) {
      if ((regimeBull && retestTouchBull) || (regimeBear && retestTouchBear)) retestState = 2;
      else if (retestState === 2) {
        if ((regimeBull && retestHeldBull) || (regimeBear && retestHeldBear)) retestState = 3;
        else if ((regimeBull && retestFailBull) || (regimeBear && retestFailBear)) retestState = 4;
      }
    } else if (retestState === 3 || retestState === 4) { if (regimeRange) retestState = 0; }
    const retestZone = retestState === 2, retestHeld = retestState === 3, retestFailed = retestState === 4;

    // ── 19. Directional 10-point scoring ──
    const L1 = bullTfScore >= 6 ? 2 : bullTfScore >= cfg.minTfScore ? 1 : 0;
    const L2 = (bull30Full && bull15Full) ? 1 : 0;
    const L3 = (lvlState === 1 || lvlState === 2 || lvlState === 3) ? 1 : 0;
    const L4 = (regimeBull || isCoiling) ? 1 : 0;
    const L5 = !d1Bear ? 1 : 0;
    const L6 = impulseBull ? 1 : 0;
    const L7 = macdConfBull ? 1 : 0;
    const L8 = volOk ? 1 : 0;
    const L9 = (sessVwap == null || bar.c > sessVwap) ? 1 : 0;
    const longScore = L1 + L2 + L3 + L4 + L5 + L6 + L7 + L8 + L9;

    const S1 = bearTfScore >= 6 ? 2 : bearTfScore >= cfg.minTfScore ? 1 : 0;
    const S2 = (bear30Full && bear15Full) ? 1 : 0;
    const S3 = (lvlState === 1 || lvlState === 2 || lvlState === 3) ? 1 : 0;
    const S4 = (regimeBear || isCoiling) ? 1 : 0;
    const S5 = !d1Bull ? 1 : 0;
    const S6 = impulseBear ? 1 : 0;
    const S7 = macdConfBear ? 1 : 0;
    const S8 = volOk ? 1 : 0;
    const S9 = (sessVwap == null || bar.c < sessVwap) ? 1 : 0;
    const shortScore = S1 + S2 + S3 + S4 + S5 + S6 + S7 + S8 + S9;

    const longFinal = Math.min(longScore + (trapBullNow ? 1 : 0), 10);
    const shortFinal = Math.min(shortScore + (trapBearNow ? 1 : 0), 10);
    const activeLong = longFinal > shortFinal && longAnchored;
    const activeShort = shortFinal > longFinal && shortAnchored;
    // Pre-veto direction (display/ablation only): what the signal WOULD have
    // been before the 4h RSI veto zeroed the anchored flag.
    const activeLongRaw = longFinal > shortFinal && longAnchoredRaw;
    const activeShortRaw = shortFinal > longFinal && shortAnchoredRaw;
    // Vetoed entry: the 4h RSI veto killed what would otherwise be an
    // entry-grade (>= 7, the bot's minMacScore) directional signal this bar.
    // Shown as AVOID (4h RSI) so the ablation is visible in verdicts and
    // logs instead of silently reading as a WAIT.
    const vetoedEntry = (rsi4hVetoLong && activeLongRaw && longFinal >= 7)
      || (rsi4hVetoShort && activeShortRaw && shortFinal >= 7)
      || (mtfVetoLong && activeLongRaw && longFinal >= 7)
      || (mtfVetoShort && activeShortRaw && shortFinal >= 7)
      || (chopSkip && ((activeLongRaw && longFinal >= 7) || (activeShortRaw && shortFinal >= 7)));
    const activeScore = activeLong ? longFinal : activeShort ? shortFinal : Math.max(longFinal, shortFinal);
    const activeDir = activeLong ? 1 : activeShort ? -1 : 0;

    // ── 20. Hard gates + verdict ──
    const gateLate = lateBuyer || lateSeller;
    const gateNews = newsWindow;
    const gateVix = !vixOk;
    const hardBlock = gateLate || gateNews || gateVix;
    const tierEnter = !hardBlock && activeDir !== 0 && activeScore >= 9;
    const tierStrong = !hardBlock && activeDir !== 0 && activeScore >= 7 && activeScore < 9;
    const tierSetup = !hardBlock && activeDir !== 0 && activeScore >= 5 && activeScore < 7;
    const tierWatch = !hardBlock && activeScore >= 3 && activeScore < 5;
    const tierCoil = !hardBlock && isCoiling && activeScore < 5;

    const verdictLongEnter = tierEnter && activeLong;
    const verdictShortEnter = tierEnter && activeShort;
    const verdictLongStrong = tierStrong && activeLong;
    const verdictShortStrong = tierStrong && activeShort;
    const verdictLongSetup = tierSetup && activeLong;
    const verdictShortSetupVal = tierSetup && activeShort;
    const verdictRetestEnter = !hardBlock && retestHeld && activeDir !== 0 && activeScore >= 5;

    const entryGrade = tierEnter ? 'A' : tierStrong ? 'B' : tierSetup ? 'C' : '-';

    let verdictStr;
    if (hardBlock) verdictStr = `AVOID (${gateVix ? 'VIX' : gateNews ? '06:30 data window' : (lateBuyer ? 'late buyers' : 'late sellers')})`;
    else if (vetoedEntry) verdictStr = (rsi4hVetoLong && activeLongRaw) ? 'AVOID (4h RSI overbought)'
      : (rsi4hVetoShort && activeShortRaw) ? 'AVOID (4h RSI oversold)'
      : (mtfVetoLong && activeLongRaw) ? 'AVOID (RSI overbought 15m/30m/1h)'
      : (mtfVetoShort && activeShortRaw) ? 'AVOID (RSI oversold 15m/30m/1h)'
      : 'AVOID (chop, ADX<15)';
    else if (verdictRetestEnter) verdictStr = activeLong ? 'ENTER LONG - RETEST HELD' : 'ENTER SHORT - RETEST HELD';
    else if (verdictLongEnter) verdictStr = 'ENTER LONG';
    else if (verdictShortEnter) verdictStr = 'ENTER SHORT';
    else if (verdictLongStrong) verdictStr = 'STRONG SETUP LONG';
    else if (verdictShortStrong) verdictStr = 'STRONG SETUP SHORT';
    else if (verdictLongSetup) verdictStr = 'SETUP LONG';
    else if (verdictShortSetupVal) verdictStr = 'SETUP SHORT';
    else if (retestZone) verdictStr = 'RETEST ZONE - PREPARE';
    else if (tierCoil) verdictStr = 'COILING';
    else if (tierWatch) verdictStr = 'WATCH - BUILDING';
    else verdictStr = 'WAIT';

    const prevLongEntryRaw = i > 0 ? out[i - 1]._longEntryRaw : false;
    const prevShortEntryRaw = i > 0 ? out[i - 1]._shortEntryRaw : false;
    const longEntryRaw = verdictLongEnter || verdictLongStrong || (verdictRetestEnter && activeLong);
    const shortEntryRaw = verdictShortEnter || verdictShortStrong || (verdictRetestEnter && activeShort);
    const longEntry = longEntryRaw && !prevLongEntryRaw;
    const shortEntry = shortEntryRaw && !prevShortEntryRaw;
    const prevLongSetup = i > 0 ? out[i - 1]._verdictLongSetup : false;
    const prevShortSetup = i > 0 ? out[i - 1]._verdictShortSetup : false;
    const longSetupSig = verdictLongSetup && !prevLongSetup;
    const shortSetupSig = verdictShortSetupVal && !prevShortSetup;

    out.push({
      t: bar.t, close: bar.c, atrVal: atrVal[i],
      pdh: pdhPt, pdl: pdlPt, sessVwap, sessPoc,   // r9.15 diagnostics only (parity with MACPARITY PDH/PDL rows); nothing reads them for decisions
      regime: regimeBull ? 'EXPANDING UP' : regimeBear ? 'EXPANDING DOWN' : isCoiling ? 'COILING' : 'RANGING',
      isCoiling, breakoutUp, breakoutDown, squeezeBreakoutUp, squeezeBreakoutDown,
      biasStr: biasLongStrong ? 'STRONG BULL' : biasShortStrong ? 'STRONG BEAR' : biasLongPartial ? 'BULL LEAN' : biasShortPartial ? 'BEAR LEAN' : bullTfScore > bearTfScore ? 'WEAK BULL' : bearTfScore > bullTfScore ? 'WEAK BEAR' : 'NEUTRAL',
      ...(cfg.tfDotModeByTf && ['H4', 'H1', 'M30', 'M15'].some(dotOpenMode) ? { tfDotRules: { H4: dotOpenMode('H4') ? 'open' : 'ema', H1: dotOpenMode('H1') ? 'open' : 'ema', M30: dotOpenMode('M30') ? 'open' : 'ema', M15: dotOpenMode('M15') ? 'open' : 'ema' }, tfDotOpens: { H4: o4, H1: o1, M30: o30, M15: o15 } } : {}),
      bullTfScore, bearTfScore, tfPanel: `${bull4hFull ? '4H+' : bear4hFull ? '4H-' : '4H='} ${bull1hFull ? '1H+' : bear1hFull ? '1H-' : '1H='} ${bull30Full ? '30+' : bear30Full ? '30-' : '30='} ${bull15Full ? '15+' : bear15Full ? '15-' : '15='}`,
      d1Bull, d1Bear, htfConflict,
      trapBullNow, trapBearNow, barsSinceTrap, buyersTrapped, sellersTrapped,
      fuelLevel: null, // fuel gauge lives in Levels PRO's nearest-level tracker; MAC v4's own is display-only and not used in scoring
      nearestLevel: { name: nln, price: nlp },
      lvlState, retestZone, retestHeld, retestFailed,
      macdStr: macdCrossUp ? 'Golden Cross' : macdCrossDn ? 'Death Cross' : macdExtremeBull ? 'Extreme Bull' : macdExtremeBear ? 'Extreme Bear' : macdStrBull ? 'Bull Strengthening' : macdStrBear ? 'Bear Strengthening' : macdBullish ? 'Bullish' : macdBearish ? 'Bearish' : 'Flat',
      impulseBull, impulseBear, volExpansion, volCompression, volSpikeBull, volSpikeBear, volRatio,
      vixNow, vixOk, hardBlock, blockReason: gateVix ? 'VIX' : gateNews ? '06:30 data window' : gateLate ? (lateBuyer ? 'late buyers' : 'late sellers') : vetoedEntry ? ((rsi4hVetoLong || rsi4hVetoShort) ? '4h RSI' : (mtfVetoLong || mtfVetoShort) ? 'RSI 15m/30m/1h' : 'chop (ADX<15)') : null,
      rsiH4Now, rsi4hVetoLong, rsi4hVetoShort, h4TurnDown, h4TurnUp, exhaustionGate: cfg.exhaustionGate,
      rsiNow15, rsiNow30, rsiNow1h, mtfVetoLong, mtfVetoShort, mtfRsiExtremeLong, mtfRsiExtremeShort, rsiVetoesOn: cfg.mtfRsiVeto !== false || cfg.rsi4hLongMax != null || cfg.rsi4hShortMin != null,
      adxNow15, chopSkip,
      reversalDir, reversalLongReady, reversalShortReady, reversal,
      longScore, shortScore, longFinal, shortFinal, activeDir, activeScore,
      verdict: verdictStr, entryGrade,
      longEntry, shortEntry, longSetupSig, shortSetupSig, retestEnter: verdictRetestEnter,
      activeLong, activeShort,
      _longEntryRaw: longEntryRaw, _shortEntryRaw: shortEntryRaw,
      _verdictLongSetup: verdictLongSetup, _verdictShortSetup: verdictShortSetupVal,
    });

    prevDateStr = dayKey;   // r9.15: the key that defines the day (calendar or CME date)
    prevIsAsia = isAsia; prevIsLondon = isLondon; prevPt = pt;
    prevRegimeBull = regimeBull; prevRegimeBear = regimeBear; prevRegimeRange = regimeRange;
    prevIsSqueezing = isSqueezing;
  }

  return out;
}

module.exports = { evaluateMacTrap };
