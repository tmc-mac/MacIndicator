'use strict';
/** Pure evidence validation. CURRENT is not a trading or market-open decision. */
function assessProvenance(input) {
  const reasons = new Set();
  const add = code => reasons.add(code);
  const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const str = x => typeof x === 'string' && x.trim().length > 0;
  const time = x => Number.isSafeInteger(x) && x >= 0;
  const num = x => typeof x === 'number' && Number.isFinite(x);
  const i = obj(input) ? input : {};
  if (!obj(input)) add('INVALID_INPUT');
  if (i.timestampUnit !== 'epoch_ms') add('UNSUPPORTED_TIMESTAMP_UNIT');
  if (i.candlePolicy !== 'forming') add('UNKNOWN_UNSUPPORTED_POLICY');
  const slot = obj(i.slot) ? i.slot : {};
  if (!['ema21', 'period_open'].includes(slot.rule)) add('UNSUPPORTED_RULE');
  const expected = obj(i.expectedInterval) ? i.expectedInterval : {};
  const bar = obj(i.bar) ? i.bar : {};
  const limits = obj(i.limits) ? i.limits : {};
  const warmup = obj(i.warmup) ? i.warmup : {};
  for (const key of ['instrument', 'timeframe', 'rule']) {
    if (!str(slot[key])) add('INVALID_SLOT');
    if (!str(bar[key]) || bar[key] !== slot[key]) add(`BAR_${key.toUpperCase()}_MISMATCH`);
  }
  const intervalOK = time(expected.start) && time(expected.end) && expected.start < expected.end && str(expected.session);
  if (!intervalOK) add('INVALID_EXPECTED_INTERVAL');
  if (!obj(i.bar)) add('MISSING_BAR');
  const barOK = time(bar.start) && time(bar.end) && bar.start < bar.end;
  if (!barOK) add('INVALID_BAR_INTERVAL');
  if (intervalOK && barOK && (bar.start !== expected.start || bar.end !== expected.end)) add('BAR_INTERVAL_MISMATCH');
  if (!str(bar.session) || bar.session !== expected.session) add('BAR_SESSION_MISMATCH');
  for (const key of ['price', 'open']) if (!num(bar[key])) add(`INVALID_${key.toUpperCase()}`);
  if (slot.rule === 'ema21') {
    if (!num(bar.ema)) add('INVALID_EMA');
    if (!time(bar.emaAsOf) || !time(i.marketUpdatedAt) || bar.emaAsOf !== i.marketUpdatedAt) add('EMA_ASOF_MISMATCH');
  }
  const timestamps = ['evaluatedAt', 'observedAt', 'receivedAt', 'marketUpdatedAt'];
  for (const key of timestamps) if (!time(i[key])) add(`INVALID_${key.toUpperCase()}`);
  const limitNames = ['clockToleranceMs', 'maxObservationAgeMs', 'maxReceiptAgeMs', 'maxMarketAgeMs', 'maxBarEndAgeMs'];
  for (const key of limitNames) if (!time(limits[key])) add('INVALID_LIMITS');
  const tol = time(limits.clockToleranceMs) ? limits.clockToleranceMs : 0;
  if (time(i.evaluatedAt)) {
    if (intervalOK && (i.evaluatedAt < expected.start || i.evaluatedAt >= expected.end)) add('OUTSIDE_FORMING_INTERVAL');
    for (const key of ['observedAt', 'receivedAt', 'marketUpdatedAt']) {
      if (time(i[key]) && i[key] - i.evaluatedAt > tol) add(`FUTURE_${key.toUpperCase()}`);
    }
    if (barOK && bar.start - i.evaluatedAt > tol) add('FUTURE_BAR');
    if (intervalOK && expected.start - i.evaluatedAt > tol) add('FUTURE_EXPECTED_INTERVAL');
    for (const [field, limit, code] of [
      ['observedAt', 'maxObservationAgeMs', 'STALE_OBSERVATION'],
      ['receivedAt', 'maxReceiptAgeMs', 'STALE_RECEIPT'],
      ['marketUpdatedAt', 'maxMarketAgeMs', 'STALE_MARKET_UPDATE']
    ]) if (time(i[field]) && time(limits[limit]) && i.evaluatedAt - i[field] > limits[limit]) add(code);
    if (barOK && time(limits.maxBarEndAgeMs) && i.evaluatedAt - bar.end > limits.maxBarEndAgeMs) add('STALE_BAR');
  }
  for (const [earlier, later] of [['marketUpdatedAt', 'receivedAt'], ['receivedAt', 'observedAt'], ['observedAt', 'evaluatedAt']]) {
    if (time(i[earlier]) && time(i[later]) && i[earlier] - i[later] > tol) add('OUT_OF_ORDER_TIMESTAMPS');
  }
  // Market-update time must describe this selected bar, not an unrelated heartbeat.
  if (barOK && time(i.marketUpdatedAt) && (i.marketUpdatedAt < bar.start || i.marketUpdatedAt >= bar.end)) add('UPDATE_OUTSIDE_BAR');
  if (slot.rule === 'ema21') {
    const warmupOK = Number.isSafeInteger(warmup.requiredSamples) && warmup.requiredSamples >= 21 && Number.isSafeInteger(warmup.availableSamples) && warmup.availableSamples >= 0 && time(warmup.seedThrough);
    if (!warmupOK) add('INVALID_WARMUP');
    if (warmupOK && warmup.availableSamples < warmup.requiredSamples) add('INSUFFICIENT_WARMUP');
    if (warmupOK && time(i.marketUpdatedAt) && warmup.seedThrough > i.marketUpdatedAt) add('FUTURE_WARMUP');
  }
  const reasonCodes = [...reasons].sort();
  // Copy only scalar evidence fields; do not leak unrelated input or retain mutable objects.
  const pick = (source, keys) => Object.fromEntries(keys.map(k => [k, (typeof source[k] === 'string' || num(source[k])) ? source[k] : null]));
  return {
    status: reasonCodes.length ? 'UNKNOWN' : 'CURRENT',
    reasonCodes,
    provenance: {
      declarations: pick(i, ['timestampUnit', 'candlePolicy']),
      slot: pick(slot, ['instrument', 'timeframe', 'rule']),
      expectedInterval: pick(expected, ['start', 'end', 'session']),
      selectedBar: pick(bar, ['instrument', 'timeframe', 'rule', 'start', 'end', 'session', 'price', 'open', 'ema', 'emaAsOf']),
      timestamps: pick(i, timestamps),
      limits: pick(limits, limitNames),
      warmup: pick(warmup, ['requiredSamples', 'availableSamples', 'seedThrough'])
    }
  };
}

module.exports = { assessProvenance };
