'use strict';
// Initial entries only. Grades are labels, not calibrated probabilities.
const VERSION = 'initial-confidence-ceilings-v1';   // np1: + flatSize (the decision row carries it; the version names the grade table, unchanged)
const GRADES = { mac: { A: 5, B: 4, C: 2 }, levels: { A: 5, 'A-': 4, B: 4, 'B-': 2, C: 2 } };
function provenance(source, grade) {
  return Object.freeze({ source: typeof source === 'string' ? source : null,
    grade: typeof grade === 'string' ? grade : null });
}
function confidenceFor(sig) {
  if (sig?.source === 'wave' || sig?.source === 'reversal') return provenance(sig.source, sig.grade);
  const p = sig && Object.hasOwn(sig, 'confidence') ? sig.confidence : sig;
  return provenance(p?.source, p?.grade);
}
function ceiling(p) { return Object.hasOwn(GRADES, p?.source) && Object.hasOwn(GRADES[p.source], p?.grade) ? GRADES[p.source][p.grade] : 0; }
// np1 (Mac 10/24): flatSize (a whole number >= 1) replaces the grade ceiling for every ELIGIBLE grade (an ineligible one stays 0); null/0 = the grade table.
function decision({ rawContracts, stopPoints, pointValue, globalMax, confidence, flatSize = null }) {
  const p = provenance(confidence?.source, confidence?.grade), gradeCeiling = ceiling(p);
  const flat = Number.isInteger(flatSize) && flatSize >= 1 ? flatSize : null, cap = gradeCeiling > 0 && flat != null ? flat : gradeCeiling;
  const valid = [rawContracts, stopPoints, pointValue, globalMax].every(Number.isFinite) && rawContracts >= 0 && stopPoints > 0 && pointValue > 0 && globalMax >= 1;
  const contracts = valid ? Math.max(0, Math.min(Math.floor(rawContracts), Math.floor(globalMax), cap)) : 0;
  return Object.freeze({ version: VERSION, confidence: p, rawContracts: Number.isFinite(rawContracts) ? rawContracts : null,
    gradeCeiling, flatSize: flat, globalMax: Number.isFinite(globalMax) ? globalMax : null, contracts,
    reason: !gradeCeiling ? 'confidence-ineligible' : !valid ? 'invalid-sizing-input' : !contracts ? 'unaffordable' : cap < Math.min(rawContracts, Math.floor(globalMax)) ? (flat != null ? 'flat-size' : 'confidence-ceiling') : globalMax < rawContracts ? 'global-ceiling' : 'existing-sizing' });
}
function validLegs(n, leg1, leg2) { return Number.isInteger(n) && n > 0 && Number.isInteger(leg1) && leg1 > 0 && Number.isInteger(leg2) && leg2 >= 0 && leg1 + leg2 <= n; }
module.exports = { VERSION, provenance, confidenceFor, ceiling, decision, validLegs };
