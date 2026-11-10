'use strict';
const { assessProvenance } = require('./assess.cjs');
const ADAPTER_VERSION = 'alignment-evidence-adapter/0.1.2';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = v => typeof v === 'string' && v.trim().length > 0;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const keys = ['instrument', 'timeframe', 'rule'];
const limitsKeys = ['clockToleranceMs', 'maxObservationAgeMs', 'maxReceiptAgeMs', 'maxMarketAgeMs', 'maxBarEndAgeMs'];
// Strict UTC ISO subset avoids locale parsing, missing zones and date rollover.
function normalizeTimestamp(tag) {
  if (!object(tag)) return null;
  if (tag.unit === 'epoch_ms') return integer(tag.value) ? tag.value : null;
  if (tag.unit === 'epoch_s') {
    if (typeof tag.value !== 'number' || !Number.isFinite(tag.value) || tag.value < 0 || tag.value > Number.MAX_SAFE_INTEGER / 1000) return null;
    // Interpret the canonical decimal spelling exactly, not binary float * 1000.
    const [mantissa, exponent = '0'] = String(tag.value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const digits = BigInt(whole + fraction);
    const scale = Number(exponent) - fraction.length + 3;
    const divisor = scale < 0 ? 10n ** BigInt(-scale) : 1n;
    if (digits % divisor !== 0n) return null; // Never round sub-ms timestamps.
    const ms = Number(scale < 0 ? digits / divisor : digits * 10n ** BigInt(scale));
    return integer(ms) ? ms : null;
  }
  if (tag.unit === 'iso8601' && typeof tag.value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+00:00)$/.test(tag.value)) {
    const utc = tag.value.replace(/\+00:00$/, 'Z');
    const ms = Date.parse(utc);
    const canonical = utc.includes('.') ? utc : utc.replace('Z', '.000Z');
    return integer(ms) && new Date(ms).toISOString() === canonical ? ms : null;
  }
  return null;
}
/** Pure mapping of explicit witnesses only. Never fetches, selects a fallback or gives entry permission. */
function evaluateEvidence(input) {
  const errors = new Set();
  const i = object(input) ? input : {};
  if (!object(input)) errors.add('INVALID_INPUT');
  const get = k => object(i[k]) ? i[k] : {};
  const selected = get('selected');
  const raw = object(selected.raw) ? selected.raw : {};
  const slot = get('slot'), calendar = get('calendar'), policy = get('policy');
  const update = get('marketUpdate'), ema = get('emaEvidence');
  const clock = get('clock');
  const provenance = (v, name) => {
    if (!string(v.source) || !string(v.version)) errors.add(`MISSING_${name}_PROVENANCE`);
  };
  provenance(clock, 'CLOCK'); provenance(calendar, 'CALENDAR'); provenance(policy, 'POLICY');
  if (!integer(clock.evaluatedAtMs)) errors.add('INVALID_TRUSTED_CLOCK');
  if (!integer(policy.maxTimestampDistanceMs)) errors.add('MISSING_TIMESTAMP_PLAUSIBILITY_POLICY');
  for (const key of limitsKeys) if (!integer(policy[key])) errors.add('INVALID_POLICY_LIMITS');
  const ts = (tag, name, near = true) => {
    const value = normalizeTimestamp(tag);
    if (value === null) errors.add(`INVALID_${name}`);
    else if (near && integer(clock.evaluatedAtMs) && integer(policy.maxTimestampDistanceMs) && Math.abs(value - clock.evaluatedAtMs) > policy.maxTimestampDistanceMs) errors.add(`IMPLAUSIBLE_${name}`);
    return value;
  };
  for (const key of keys) {
    if (!string(slot[key])) errors.add('INVALID_EXPECTED_SLOT');
    if (selected[key] !== slot[key]) errors.add(`SELECTED_${key.toUpperCase()}_MISMATCH`);
    if (calendar[key] !== slot[key]) errors.add(`CALENDAR_${key.toUpperCase()}_MISMATCH`);
  }
  if (calendar.origin !== 'independent_calendar') errors.add('CALENDAR_NOT_INDEPENDENT');
  if (!string(selected.id) || !string(selected.source) || !string(selected.version)) errors.add('MISSING_SELECTED_PROVENANCE');
  const start = ts({value: raw.t, unit: selected.timestampUnit}, 'BAR_START');
  const end = ts(selected.end, 'BAR_END');
  const binding = (witness, name) => {
    provenance(witness, name);
    if (!string(selected.id) || witness.barId !== selected.id || witness.barSource !== selected.source || !string(selected.version) || witness.barVersion !== selected.version) errors.add(`${name}_BAR_BINDING_MISMATCH`);
    for (const key of keys) if (witness[key] !== slot[key] || witness[key] !== selected[key]) errors.add(`${name}_${key.toUpperCase()}_MISMATCH`);
    if (ts(witness.barStart, `${name}_BAR_START`) !== start || ts(witness.barEnd, `${name}_BAR_END`) !== end || witness.session !== selected.session) errors.add(`${name}_INTERVAL_BINDING_MISMATCH`);
  };
  binding(update, 'MARKET_UPDATE');
  if (update.kind !== 'selected_bar_market_event') errors.add('INVALID_MARKET_UPDATE_KIND');
  const marketUpdatedAt = ts(update.at, 'MARKET_UPDATED_AT');
  const bar = {instrument:selected.instrument, timeframe:selected.timeframe, rule:selected.rule, session:selected.session, start, end, price:raw.c, open:raw.o};
  let warmup;
  if (slot.rule === 'ema21') {
    binding(ema, 'EMA');
    if (ema.method !== 'ema21' || !string(ema.sampleSetId) || !string(ema.seedEvidenceId)) errors.add('MISSING_EMA_COMPUTATION_EVIDENCE');
    bar.ema = ema.value;
    bar.emaAsOf = ts(ema.asOf, 'EMA_ASOF');
    warmup = {requiredSamples:ema.requiredSamples, availableSamples:ema.availableSamples, seedThrough:ts(ema.seedThrough,'SEED_THROUGH',false)};
  }
  const mapped = {timestampUnit:'epoch_ms', candlePolicy:i.candlePolicy, slot:{...Object.fromEntries(keys.map(k=>[k,slot[k]]))}, expectedInterval:{start:ts(calendar.start,'EXPECTED_START'),end:ts(calendar.end,'EXPECTED_END'),session:calendar.session}, bar, limits:Object.fromEntries(limitsKeys.map(k=>[k,policy[k]])), warmup, evaluatedAt:clock.evaluatedAtMs, observedAt:ts(i.observedAt,'OBSERVED_AT'), receivedAt:ts(i.receivedAt,'RECEIVED_AT'), marketUpdatedAt};
  const assessment = assessProvenance(mapped);
  const mappingErrors = [...errors].sort();
  // Scalar-only provenance avoids retaining mutable caller metadata.
  const safe = x => string(x) ? x : null;
  return {adapterVersion:ADAPTER_VERSION, evaluatedAtMs:integer(clock.evaluatedAtMs) ? clock.evaluatedAtMs : null, status:mappingErrors.length ? 'UNKNOWN' : assessment.status, mappingErrors, reasonCodes:assessment.reasonCodes, provenance:assessment.provenance, evidenceReferences:{clockSource:safe(clock.source),clockVersion:safe(clock.version),calendarSource:safe(calendar.source),calendarVersion:safe(calendar.version),policySource:safe(policy.source),policyVersion:safe(policy.version),selectedId:safe(selected.id),selectedSource:safe(selected.source),selectedVersion:safe(selected.version),updateSource:safe(update.source),updateVersion:safe(update.version),emaSource:safe(ema.source),emaVersion:safe(ema.version),sampleSetId:safe(ema.sampleSetId),seedEvidenceId:safe(ema.seedEvidenceId)}};
}

module.exports = { ADAPTER_VERSION, normalizeTimestamp, evaluateEvidence };
