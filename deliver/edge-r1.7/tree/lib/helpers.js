// Shared math primitives, ported to match Pine Script's exact recursive
// definitions (ta.ema, ta.rma/ta.atr, ta.sma) rather than generic textbook
// formulas, since the two indicators' state depends on matching Pine bar-for-bar.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

// Pine's ta.ema: seeds with an SMA of the first `period` values, then applies
// the standard EMA recursion from there.
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

// Pine's SMMA (used by the Impulse System): smma := smma[1]*(len-1)/len + src/len,
// seeded with a plain SMA on the first bar.
function smma(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = (prev * (period - 1) + values[i]) / period;
    }
    out[i] = prev;
  }
  return out;
}

// Zero-lag EMA: e1 + (e1 - e2), where e2 is an EMA of e1.
function zlema(values, period) {
  const e1 = ema(values, period);
  const e1Clean = e1.map(v => (v == null ? values[0] : v));
  const e2 = ema(e1Clean, period);
  return values.map((_, i) => (e1[i] != null && e2[i] != null ? e1[i] + (e1[i] - e2[i]) : null));
}

// Pine's ta.atr = ta.rma(true range, length). ta.rma uses the same Wilder
// recursion as SMMA above, seeded with a plain SMA of the first `length` TRs.
function atr(bars, period) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += tr[j];
      prev = sum / period;
    } else {
      prev = (prev * (period - 1) + tr[i]) / period;
    }
    out[i] = prev;
  }
  return out;
}

// Standard MACD(12,26,9): EMA(fast) - EMA(slow), signal = EMA(macd line, 9).
function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const macdClean = macdLine.map(v => (v == null ? 0 : v));
  const signalRaw = ema(macdClean, signal);
  const signalLine = signalRaw.map((v, i) => (macdLine[i] == null ? null : v));
  const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
  return { macdLine, signalLine, hist };
}

function clamp(v, lo, hi) {
  return Math.max(Math.min(v, hi), lo);
}

// Pine's ta.rsi: 100 - 100/(1+rs), rs = rma(gain,length)/rma(loss,length) —
// same Wilder recursion as smma()/atr() above, so reuse it directly rather
// than a second copy of the same math. rs -> infinity (no losses at all in
// the window) reads as 100, matching Pine's own behavior there.
function rsi(values, period = 14) {
  const gains = values.map((v, i) => (i === 0 ? 0 : Math.max(v - values[i - 1], 0)));
  const losses = values.map((v, i) => (i === 0 ? 0 : Math.max(values[i - 1] - v, 0)));
  const avgGain = smma(gains, period);
  const avgLoss = smma(losses, period);
  return values.map((_, i) => {
    if (avgGain[i] == null || avgLoss[i] == null) return null;
    if (avgLoss[i] === 0) return 100;
    return 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
  });
}

// Wilder's ADX(14) — trend STRENGTH, 0-100, direction-agnostic (unlike RSI,
// high ADX doesn't mean bullish or bearish, just "trending, whichever way").
// Standard construction: +DM/-DM/TR per bar, Wilder-smoothed (same RMA
// recursion as atr()/rsi() above) into +DI/-DI, DX = 100*|+DI--DI|/(+DI+-DI),
// then ADX = Wilder-smoothed DX. Needs full OHLC bars, not just closes.
function adx(bars, period = 14) {
  const n = bars.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    const pc = bars[i - 1].c;
    tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
  }
  const smPlusDM = smma(plusDM, period);
  const smMinusDM = smma(minusDM, period);
  const smTR = smma(tr, period);
  const plusDI = smPlusDM.map((v, i) => (v != null && smTR[i] ? 100 * v / smTR[i] : null));
  const minusDI = smMinusDM.map((v, i) => (v != null && smTR[i] ? 100 * v / smTR[i] : null));
  const dx = plusDI.map((pdi, i) => {
    const mdi = minusDI[i];
    if (pdi == null || mdi == null || pdi + mdi === 0) return null;
    return 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  });
  const adxRaw = smma(dx.map(v => (v == null ? 0 : v)), period);
  return dx.map((v, i) => (v == null ? null : adxRaw[i]));
}

// Pacific-Time session info for a bar timestamp (ms since epoch), mirroring
// the Pine indicators' `time(timeframe.period, "1500-0000", "America/Los_Angeles")`
// style session windows.
function ptInfo(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts)).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const minutesOfDay = hour * 60 + minute;
  return {
    dateStr,
    minutesOfDay,
    isAsia: minutesOfDay >= 15 * 60, // 15:00–24:00 PT
    isLondon: minutesOfDay < 6 * 60 + 30, // 00:00–06:30 PT
    isNewsWindow: minutesOfDay >= 6 * 60 + 25 && minutesOfDay <= 6 * 60 + 35,
    is0630: minutesOfDay === 6 * 60 + 30,
    is1500: minutesOfDay === 15 * 60,
    isIB: minutesOfDay >= 6 * 60 + 30 && minutesOfDay < 7 * 60 + 30, // 06:30–07:30 PT
  };
}

module.exports = { sma, ema, smma, zlema, atr, macd, clamp, ptInfo, rsi, adx };
