'use strict';
const { evaluateEvidence } = require('./vendor/adapter.cjs');
const CLOCK_GATE_VERSION = 'alignment-clock-confidence-gate/0.1.0-candidate';
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = x => typeof x === 'string' && x.trim().length > 0;
const uint = x => Number.isSafeInteger(x) && x >= 0;
const identity = x => obj(x) && str(x.source) && str(x.version);
const same = (a, b) => identity(a) && identity(b) && a.source === b.source && a.version === b.version;
function freeze(x) { if (obj(x) || Array.isArray(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
/** Offline only. Dependencies are trusted integration code, never feed-supplied callbacks. */
function createClockConfidenceGate({ readEvaluationClock, verifyClockEvidence, maxEvidenceAgeMs } = {}) {
  return function evaluateWithClockConfidence(input, confidence) {
    const errors = new Set();
    let i, c, clock, assessment = null;
    // Plain JSON-shaped inputs only, as in the underlying adapter. No getters/proxies/cycles.
    try { i = structuredClone(input); c = structuredClone(confidence); }
    catch { errors.add('UNCLONEABLE_INPUT'); }
    i = obj(i) ? i : {};
    c = obj(c) ? c : {};
    if (!uint(maxEvidenceAgeMs)) errors.add('INVALID_CLOCK_CONFIDENCE_AGE_POLICY');
    if (i.policy?.clockToleranceMs !== 2000) errors.add('UNSUPPORTED_CLOCK_TOLERANCE');
    if (c.schema !== 'alignment-clock-confidence/v1') errors.add('INVALID_CLOCK_CONFIDENCE_SCHEMA');
    if (!str(c.id) || !identity(c.issuer)) errors.add('MISSING_CLOCK_CONFIDENCE_PROVENANCE');
    if (!uint(c.measuredAtMs) || !uint(c.validUntilMs) || c.validUntilMs < c.measuredAtMs) errors.add('INVALID_CLOCK_CONFIDENCE_WINDOW');
    if (!uint(c.maxPairwiseDiscrepancyMs)) errors.add('UNBOUNDED_CLOCK_CONFIDENCE');
    else if (c.maxPairwiseDiscrepancyMs > 2000) errors.add('CLOCK_DISCREPANCY_EXCEEDS_TOLERANCE');
    if (c.coverage !== 'all_evidence_timestamps_through_valid_until') errors.add('INCOMPLETE_CLOCK_CONFIDENCE_COVERAGE');
    if (!same(c.policy, i.policy)) errors.add('CLOCK_CONFIDENCE_POLICY_MISMATCH');
    if (!obj(c.sources)) errors.add('MISSING_CLOCK_CONFIDENCE_SOURCES');
    const required = ['selected', 'calendar', 'marketUpdate'];
    if (i.slot?.rule === 'ema21') required.push('emaEvidence');
    for (const role of required) if (!same(c.sources?.[role], i[role])) errors.add(`CLOCK_CONFIDENCE_${role.toUpperCase()}_MISMATCH`);
    // Receipt and observation timestamps are explicitly covered by the evaluation host clock.
    if (c.localTimestampClock !== 'evaluation_clock') errors.add('UNBOUND_LOCAL_TIMESTAMP_CLOCK');
    // Verification must authenticate the complete envelope and its numeric bounds/coverage,
    // not just an issuer string. Exact true only: Promise/truthy results cannot grant trust.
    if (typeof verifyClockEvidence !== 'function') errors.add('CLOCK_CONFIDENCE_VERIFIER_MISSING');
    else {
      try { if (verifyClockEvidence(freeze(c)) !== true) errors.add('UNTRUSTED_CLOCK_CONFIDENCE'); }
      catch { errors.add('CLOCK_CONFIDENCE_VERIFICATION_FAILED'); }
    }
    // Read AFTER synchronous verification, never reuse input.clock.evaluatedAtMs.
    try { clock = typeof readEvaluationClock === 'function' ? structuredClone(readEvaluationClock()) : null; }
    catch { errors.add('EVALUATION_CLOCK_READ_FAILED'); }
    if (!identity(clock) || !uint(clock?.evaluatedAtMs)) errors.add('INVALID_FRESH_EVALUATION_CLOCK');
    if (!same(c.evaluationClock, clock) || !same(i.clock, clock)) errors.add('CLOCK_CONFIDENCE_EVALUATION_CLOCK_MISMATCH');
    if (uint(clock?.evaluatedAtMs) && uint(c.measuredAtMs) && uint(c.validUntilMs)) {
      if (c.measuredAtMs > clock.evaluatedAtMs) errors.add('FUTURE_CLOCK_CONFIDENCE');
      if (clock.evaluatedAtMs > c.validUntilMs) errors.add('EXPIRED_CLOCK_CONFIDENCE');
      if (uint(maxEvidenceAgeMs) && clock.evaluatedAtMs - c.measuredAtMs > maxEvidenceAgeMs) errors.add('STALE_CLOCK_CONFIDENCE');
    }
    // Do NOT run the tolerance-bearing adapter until clock confidence passes.
    if (!errors.size) {
      try { assessment = evaluateEvidence({ ...i, clock }); }
      catch { errors.add('EVIDENCE_ADAPTER_FAILED'); }
    }
    return {
      gateVersion: CLOCK_GATE_VERSION,
      evaluatedAtMs: uint(clock?.evaluatedAtMs) ? clock.evaluatedAtMs : null,
      status: errors.size || assessment?.status !== 'CURRENT' ? 'UNKNOWN' : 'CURRENT',
      clockReasonCodes: [...errors].sort(),
      evidenceAssessment: assessment,
      evidenceEvaluation: assessment ? 'EVALUATED' : 'NOT_EVALUATED_CLOCK_GATE_FAILED',
      clockEvidenceReference: { id: str(c.id) ? c.id : null, issuerSource: str(c.issuer?.source) ? c.issuer.source : null, issuerVersion: str(c.issuer?.version) ? c.issuer.version : null, measuredAtMs: uint(c.measuredAtMs) ? c.measuredAtMs : null, validUntilMs: uint(c.validUntilMs) ? c.validUntilMs : null, maxPairwiseDiscrepancyMs: uint(c.maxPairwiseDiscrepancyMs) ? c.maxPairwiseDiscrepancyMs : null },
      entryAuthorization: 'NOT_PROVIDED'
    };
  };
}

module.exports = { CLOCK_GATE_VERSION, createClockConfidenceGate };
