'use strict';
// DISPLAY ONLY. Local request time bounds display lifetime; it is NOT provider
// freshness, session certification, or clock evidence. Never used by entries.
const DURATIONS = Object.freeze({ M15:900000, M30:1800000, H1:3600000, H4:14400000 });
const DISPLAY_TTL_MS = 60000;
function buildAlignmentDisplay(htf, required, requestedAt, now, elapsedMs) {
  const validTime = Number.isSafeInteger(requestedAt) && requestedAt >= 0 &&
    Number.isSafeInteger(now) && now >= requestedAt && now < requestedAt + DISPLAY_TTL_MS &&
    Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < DISPLAY_TTL_MS &&
    Math.abs((now-requestedAt)-elapsedMs) <= 1000;
  function candle(tf) {
    const duration = DURATIONS[tf];
    if (!validTime || !duration || !Array.isArray(htf?.[tf])) return null;
    const candidates = htf[tf].filter(b => b && Number.isSafeInteger(b.t) && b.t >= 0 && b.t <= now && now < b.t + duration);
    if (candidates.length !== 1) return null;
    const b = candidates[0];
    if (![b.o,b.h,b.l,b.c].every(Number.isFinite) || b.l > Math.min(b.o,b.c) || b.h < Math.max(b.o,b.c) || b.l > b.h) return null;
    // A response started before rollover cannot establish the next interval.
    if (b.t > requestedAt) return null;
    return b;
  }
  const priceBar = candle('M15');
  return { kind:'measured-period-open-v1', requestedAt, slots:required.map(timeframe => {
    const b = candle(timeframe);
    if (!b || !priceBar) return {timeframe,status:'UNKNOWN'};
    return {timeframe,status:'MEASURED / UNCERTIFIED',open:b.o,price:priceBar.c,
      barStart:b.t,priceBarStart:priceBar.t,
      expiresAt:Math.min(requestedAt + DISPLAY_TTL_MS,now + DISPLAY_TTL_MS - Math.ceil(elapsedMs),b.t+DURATIONS[timeframe],priceBar.t+DURATIONS.M15)};
  }) };
}
module.exports = { buildAlignmentDisplay, DISPLAY_TTL_MS };
