'use strict';
// JOURNAL CONTEXT (Mac 10/19 ~7:00 PT: "additional context I would like the trade journal to have for yall to examine"). JOURNAL ONLY:
// nothing here is read by an entry, sizing, gate, exit or transport path. Built from bars / state the bot already has.
//   entry_context row (at entry): RSI(14) on 3m / 5m / 15m / 30m / 1h, the previous CLOSED candle's high/low on each, stop distance,
//                                 confidence, main reason.
//   trade_time row (at close):    time in trade, time winning vs losing, longest losing stretch, worst / best excursion.
const { rsi } = require('./helpers');
const TF_MS = Object.freeze({ M3: 180000, M5: 300000, M15: 900000, M30: 1800000, H1: 3600000 });
const LABEL = Object.freeze({ M3: '3m', M5: '5m', M15: '15m', M30: '30m', H1: '1h' });
const r2 = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

// One timeframe at time nowMs. rsiLive includes the still-forming bar when the series has one (formingBarIncluded); otherwise it equals
// rsiClosed. rsiClosed stops at the last bar that closed before nowMs. prevCandle = that last closed bar (null + prevCandleInvalid when its
// OHLC is malformed). prevIsImmediate = it is the period right before the current one (false when the cached series is behind).
// readAt / ageMs = when those bars were fetched and how long before nowMs: `available` means present, NOT fresh.
const validBar = b => b && [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h >= Math.max(b.o, b.c, b.l) && b.l <= Math.min(b.o, b.c, b.h);
function tfContext(bars, tf, nowMs, readAt = null) {
  const d = TF_MS[tf];
  if (!d || !Array.isArray(bars) || !bars.length || !Number.isFinite(nowMs)) return { tf: LABEL[tf] || tf, available: false };
  const ok = bars.filter(b => b && Number.isFinite(b.t) && Number.isFinite(b.c) && b.t <= nowMs);
  if (!ok.length) return { tf: LABEL[tf], available: false };
  let iClosed = -1; for (let i = ok.length - 1; i >= 0; i--) if (ok[i].t + d <= nowMs) { iClosed = i; break; }
  const live = rsi(ok.map(b => b.c), 14), closed = iClosed >= 0 ? rsi(ok.slice(0, iClosed + 1).map(b => b.c), 14) : [];
  const prev = iClosed >= 0 ? ok[iClosed] : null, curStart = nowMs - (nowMs % d), prevOk = validBar(prev);
  return { tf: LABEL[tf], available: true, formingBarIncluded: iClosed < ok.length - 1, rsiLive: r2(live[live.length - 1]), rsiClosed: r2(closed.length ? closed[closed.length - 1] : null),
    prevCandle: prevOk ? { start: prev.t, open: prev.o, high: prev.h, low: prev.l, close: prev.c } : null, ...(prev && !prevOk ? { prevCandleInvalid: true } : {}),
    prevIsImmediate: prevOk ? prev.t === curStart - d : false, barsUsed: ok.length,
    readAt: Number.isFinite(readAt) ? readAt : null, ageMs: Number.isFinite(readAt) ? nowMs - readAt : null };
}
function marketContext(htf, nowMs, readAt = {}) {
  return Object.fromEntries(Object.keys(TF_MS).map(tf => [LABEL[tf], tfContext(htf && htf[tf], tf, nowMs, readAt && readAt[tf])]));
}
function stopDistance({ dir, entryPrice, stopPrice, contracts, pointValue }) {
  const pts = Number.isFinite(entryPrice) && Number.isFinite(stopPrice) ? Math.abs(entryPrice - stopPrice) : null;
  const wrongSide = pts != null && (dir === 1 ? stopPrice >= entryPrice : dir === -1 ? stopPrice <= entryPrice : false);
  return { points: r2(pts), perContractUsd: pts != null && Number.isFinite(pointValue) ? r2(pts * pointValue) : null,
    totalUsd: pts != null && Number.isFinite(pointValue) && Number.isFinite(contracts) ? r2(pts * pointValue * contracts) : null, wrongSide };
}
const SRC = { mac: 'MAC Trap', levels: 'Levels PRO', reclaim: 'Reclaim re-entry', wave: 'Wave', reversal: 'Reversal' };
// One plain sentence: the source that fired, its grade and side, and the trigger the bot recorded. Never invents a reason.
function mainReason({ dir, source, grade, entryType, entryWhy, signalContext = {} }) {
  const side = dir === 1 ? 'LONG' : dir === -1 ? 'SHORT' : '?', s = signalContext || {};
  const parts = [`${SRC[source] || source || 'unknown source'}${grade && grade !== '-' ? ' grade ' + grade : ''} ${side}${entryType ? ' (' + String(entryType).toLowerCase() + ')' : ''}`];
  if (typeof entryWhy === 'string' && entryWhy) parts.push(entryWhy);
  else {
    if (source === 'levels' && s.levelContext && s.levelContext.name) parts.push(`${s.levelContext.name}${s.levelContext.behavior ? ' ' + s.levelContext.behavior : ''}${s.triggerTf ? ' on the ' + s.triggerTf + ' chart' : ''}`);
    if (source === 'mac' && s.macVerdict) parts.push(`MAC ${s.macVerdict}${s.macBiasStr ? ', bias ' + s.macBiasStr : ''}`);
    if (s.reclaimOf) parts.push('reclaim after a stop-out');
  }
  return parts.join(': ');
}
// Time winning vs losing while the position is open (r9.1 after MacDot R9 6281382297).
// - Starts at the FIRST observation of a filled position (startAt = that observation), never at order send; samples older than the
//   start, out of order, or ahead of the bot's clock are rejected (counted in `rejectedSamples`).
// - Each interval between two accepted samples is attributed to the side of the sample that started it, ONLY if it is <= MAX_CLASSIFIED_GAP_MS;
//   a longer gap is counted as unknownMs (not classified). Time between the known fill/entry time (if any) and the first observation is
//   unobservedBeforeMs; time from that observation to the first accepted price sample is beforeFirstSampleMs. msWinning + msLosing + msFlat +
//   unknownMs = observedSpanMs (first to last accepted sample); it is an ESTIMATE from samples, not an error-bounded measure, not broker
//   fill-to-close timing. `complete` = at least two samples and consistent endpoints; it does NOT mean full coverage. fullCoverage = sampled
//   from the journaled entryTime itself (known, zero prefix) through the close with no gap or tail (see fullCoverage,
//   unobservedBeforeMs / beforeFirstSampleMs / unknownMs / unobservedAfterMs). A close earlier than the start or the last sample is a clock
//   regression: complete:false, no tail reported.
// - Excursions in $ use the ORIGINAL entry size (hypothetical original-size $), not account dollars after scale-outs.
const MAX_CLASSIFIED_GAP_MS = 60000;
function createTradeTimer({ dir, entryPrice, startAt, entryTime = null, pointValue = null, contracts = null, startBasis = 'first filled observation' }) {
  const st = { last: null, msWin: 0, msLose: 0, msFlat: 0, unknown: 0, loseRun: 0, longestLose: 0, firstLoseAt: null, mae: 0, mfe: 0, samples: 0, rejected: 0, maxGap: 0, gaps: 0, firstT: null };
  return {
    sample(t, px, nowMs = t) {
      if (!Number.isFinite(t) || !Number.isFinite(px) || !Number.isFinite(entryPrice) || t < startAt || t > nowMs || (st.last && t <= st.last.t)) { st.rejected++; return false; }
      const pts = (px - entryPrice) * dir, side = pts > 0 ? 1 : pts < 0 ? -1 : 0;
      if (st.last) {
        const dt = t - st.last.t; st.maxGap = Math.max(st.maxGap, dt);
        if (dt > MAX_CLASSIFIED_GAP_MS) { st.unknown += dt; st.gaps++; st.loseRun = 0; }
        else if (st.last.side > 0) { st.msWin += dt; st.loseRun = 0; }
        else if (st.last.side < 0) { st.msLose += dt; st.loseRun += dt; st.longestLose = Math.max(st.longestLose, st.loseRun); }
        else { st.msFlat += dt; st.loseRun = 0; }
      }
      if (side < 0 && st.firstLoseAt == null) st.firstLoseAt = t;
      if (st.firstT == null) st.firstT = t;
      st.mae = Math.min(st.mae, pts); st.mfe = Math.max(st.mfe, pts); st.samples++; st.last = { t, side };
      return true;
    },
    summary({ endAt, closePrice = null, closePriceSource = null, closeTimeSource = null } = {}) {
      const usd = p => (Number.isFinite(pointValue) && Number.isFinite(contracts) ? r2(p * pointValue * contracts) : null);
      // r9.2 (MacDot R9.1 J2): the close must not be earlier than the start OR the last accepted sample; a contradictory close is flagged,
      // the row is incomplete, and no close-bounded tail is reported.
      const lastT = st.last ? st.last.t : null, endOk = Number.isFinite(endAt), clockBack = endOk && (endAt < startAt || (lastT != null && endAt < lastT));
      const none = st.samples === 0;
      // r9.3 (MacDot R9.2): fullCoverage is whole-trade, so it also needs a KNOWN zero prefix (entryTime === startAt); a missing entryTime = false.
      return { complete: endOk && st.samples >= 2 && !clockBack, fullCoverage: endOk && st.samples >= 2 && !clockBack && st.unknown === 0 && st.firstT === startAt && endAt === lastT && Number.isFinite(entryTime) && entryTime === startAt, startAt, startBasis, entryTime: Number.isFinite(entryTime) ? entryTime : null,
        unobservedBeforeMs: Number.isFinite(entryTime) && entryTime <= startAt ? startAt - entryTime : null,
        firstSampleAt: st.firstT, beforeFirstSampleMs: st.firstT != null ? st.firstT - startAt : null, lastSampleAt: lastT, endAt: Number.isFinite(endAt) ? endAt : null, closePrice: Number.isFinite(closePrice) ? closePrice : null, closePriceSource, closeTimeSource,
        unobservedAfterMs: endOk && !clockBack && lastT != null ? endAt - lastT : null, clockRegression: clockBack,
        observedSpanMs: lastT != null ? lastT - st.firstT : 0, msWinning: st.msWin, msLosing: st.msLose, msFlat: st.msFlat, unknownMs: st.unknown, unclassifiedGaps: st.gaps,
        longestLosingStretchMs: st.longestLose, firstLosingAt: st.firstLoseAt,
        maxAdversePts: none ? null : r2(st.mae), maxFavorablePts: none ? null : r2(st.mfe), maxAdverseUsdAtEntrySize: none ? null : usd(st.mae), maxFavorableUsdAtEntrySize: none ? null : usd(st.mfe),   // no samples = unknown, not zero movement
        excursionUsdBasis: { contracts, pointValue, note: 'hypothetical: original entry size x points; NOT account dollars after scale-outs' },
        samples: st.samples, rejectedSamples: st.rejected, maxGapMs: st.maxGap, maxClassifiedGapMs: MAX_CLASSIFIED_GAP_MS,
        method: 'estimate from bot price samples; each interval <= maxClassifiedGapMs is counted on the side of the sample that started it, longer gaps are unknownMs' };
    },
  };
}
// A close the timer never observed (e.g. filled and closed between two bot cycles, or a restart): an explicitly incomplete row.
// Same keys as a timer summary (r9.2), every measured value null.
function incompleteTradeTime({ entryTime = null, endAt = null, reason }) {
  const e = Number.isFinite(entryTime) ? entryTime : null, x = Number.isFinite(endAt) ? endAt : null;
  return { complete: false, fullCoverage: false, reason, startAt: null, startBasis: null, entryTime: e, unobservedBeforeMs: null, firstSampleAt: null, beforeFirstSampleMs: null,
    lastSampleAt: null, endAt: x, closePrice: null, closePriceSource: null, closeTimeSource: null, unobservedAfterMs: null, clockRegression: e != null && x != null && x < e,
    observedSpanMs: 0, msWinning: null, msLosing: null, msFlat: null, unknownMs: e != null && x != null && x >= e ? x - e : null, unclassifiedGaps: null,
    longestLosingStretchMs: null, firstLosingAt: null, maxAdversePts: null, maxFavorablePts: null, maxAdverseUsdAtEntrySize: null, maxFavorableUsdAtEntrySize: null,
    excursionUsdBasis: null, samples: 0, rejectedSamples: null, maxGapMs: null, maxClassifiedGapMs: MAX_CLASSIFIED_GAP_MS,
    method: 'no observation of the filled position: nothing measured' };
}
module.exports = { TF_MS, MAX_CLASSIFIED_GAP_MS, tfContext, marketContext, stopDistance, mainReason, createTradeTimer, incompleteTradeTime };
