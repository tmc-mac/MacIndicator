'use strict';
// Observation only: no policy, network, filesystem, timer, or trading-state writes.
const crypto = require('crypto');
const UNKNOWN = 'UNKNOWN';
const SCHEMA = 'team-mac-journal-receipt-v1';
const BUILD = 'journal-receipts-r4-on-candle-r5-166dea73-confidence-afcf5a0';
const states = new WeakMap();
const attempts = new WeakMap();
const closeAttempts = new WeakMap();
function clean(v, depth = 0) {
  if (depth > 12 || v == null) return UNKNOWN;
  if (typeof v === 'number') return Number.isFinite(v) ? v : UNKNOWN;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
  if (typeof v !== 'object') return UNKNOWN;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (/token|secret|password|account|credential|authorization|api.?key/i.test(k)) continue;
    out[k] = clean(v[k], depth + 1);
  }
  return out;
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function identity(config) { return crypto.createHash('sha256').update(JSON.stringify(clean(config))).digest('hex'); }
function receipt(id, status, facts = {}, t = Date.now()) {
  return freeze({ type: 'journal_receipt', schema: SCHEMA, build: BUILD, journalId: id || UNKNOWN,
    decisionId: id || UNKNOWN, status, recordedAt: t, ...clean(facts) });
}
function emit(write, make) {
  try { const r = make(); const p = write(r); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) { /* journal failure never authorizes or blocks transport */ }
}
function selected({ journalId, dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, source, grade, contracts, leg1Size, leg2Size, signalContext, sizing, planInfo, config, decisionAt }) {
  const c = signalContext || {}, p = planInfo || {};
  return receipt(journalId, 'SELECTED_INTENT', {
    configIdentity: identity(config), configIdentityScope: 'sanitized effective CONFIG; credentials excluded', decisionAt,
    dataAt: UNKNOWN, dataTimestampBasis: 'no independently bound decision data timestamp producer',
    path: p.path, triggerRuleId: UNKNOWN, selector: { source, grade }, confidence: sizing?.confidence,
    quantity: { raw: sizing?.rawContracts, affordable: UNKNOWN, affordableBasis: 'rawContracts is existing-sizing allowance; distinct affordability producer absent', confidenceCeiling: sizing?.gradeCeiling, globalCeiling: sizing?.globalMax, capped: sizing?.contracts, final: contracts, sizing },
    intendedGeometry: { dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, contracts, leg1Size, leg2Size },
    roundedTransportGeometry: UNKNOWN, stopBasis: p.stopBasis, entryWhy: p.entryWhy,
    triggerContext: { triggerTf: c.triggerTf, isIntrabar: c.isIntrabar, levelContext: c.levelContext, reclaimOf: c.reclaimOf,
      selectedCallSite: { path: p.path, refPrice: p.refPrice, entryWhy: p.entryWhy,
        mac: { verdict: p.mac?.verdict, bias: p.mac?.biasStr, score: p.mac?.activeScore, grade: p.mac?.entryGrade },
        levels: { triggerTf: p.lv?.triggerTf, plan: p.lv?.plan ? { dir: p.lv.plan.dir, grade: p.lv.plan.grade, entry: p.lv.plan.entry, stop: p.lv.plan.stop, target: p.lv.plan.target } : UNKNOWN } },
      basis: 'selected call-site context; not the last signal_check board; individual consumed features are not asserted' },
    alignment: { consumed: c.alignmentConsumed, required: c.alignmentRequiredSlots, slots: c.alignmentSlots, evidence: c.alignmentEvidence, clockConfidence: c.alignmentClockConfidence,
      exception: c.alignmentConsumed === false && c.reclaimOf ? { producer: 'alignmentRuntime.independentReclaim', reclaimOf: c.reclaimOf } : UNKNOWN },
    controlVerdict: UNKNOWN, alignmentVerdict: UNKNOWN, marketStage: UNKNOWN, thesisInvalidation: UNKNOWN,
    statement: `Selected intent: ${p.path || UNKNOWN}; confidence ${sizing?.confidence?.source || UNKNOWN} ${sizing?.confidence?.grade || UNKNOWN}; quantity ${contracts ?? UNKNOWN}. Admission and fill remain unconfirmed.`
  }, decisionAt);
}
// Active identity comes only from the FSM's accepted signal context. An attempted
// ID is a receipt address, never authority to replace a still-active trade.
function context(sm) {
  const id = sm.signalContext?.journalId || UNKNOWN;
  let c = states.get(sm);
  if (!c || c.id !== id) { c = { id, request: UNKNOWN }; states.set(sm, c); }
  return c;
}
function note(sm, status, facts = {}, id) {
  emit(sm.journal, () => receipt(id || context(sm).id, status, facts));
}
// The value has ALREADY been evaluated by the original predicate. Return it unchanged.
function verdict(sm, id, seam, gate, value) {
  try {
    let a = attempts.get(sm);
    if (!a || a.id !== id) { a = { id, count: 0 }; attempts.set(sm, a); }
    if (gate === 'control') a.count++;
    note(sm, 'ADMISSION_RESULT', { seam, checkSequence: a.count, gate, result: value,
      statement: `${seam}: ${gate} result recorded; unevaluated gates remain UNKNOWN.` }, id);
  } catch (_) {} return value;
}
// Caller metadata is a one-use observer slot, never trading state or authorization.
function attemptClose(sm, cause, actor, provenance) {
  try {
    const attempt = freeze(clean({ cause, actor, provenance, journalId: sm.signalContext?.journalId || UNKNOWN }));
    closeAttempts.set(sm, attempt);
    note(sm, 'CLOSE_ATTEMPT', { attempt, phaseObservation: sm.phase, acceptance: UNKNOWN,
      statement: 'Flatten/cancel function requested by caller; acceptance and execution remain unconfirmed.' });
  } catch (_) {}
}
function consumeCloseAttempt(sm) {
  try {
    const attempt = closeAttempts.get(sm); closeAttempts.delete(sm);
    if (attempt && attempt.journalId === (sm.signalContext?.journalId || UNKNOWN)) return attempt;
  } catch (_) {}
  return { cause: UNKNOWN, actor: UNKNOWN, provenance: UNKNOWN };
}
function requestClose(sm, cause, actor, provenance) {
  try {
    const c = context(sm);
    const latestRequest = freeze(clean({ cause, actor, provenance, requestedAt: Date.now(), requestedAction: 'flatten' }));
    const first = c.request === UNKNOWN;
    // Append subsequent request evidence, never rewrite the first observed request.
    // First observed intent is not proof of the execution's causal initiator.
    if (first) c.request = latestRequest;
    note(sm, 'CLOSE_REQUESTED', { requested: c.request, latestRequest,
      requestRelation: first ? 'FIRST_OBSERVED' : 'ADDITIONAL_REQUEST', initiatingExecutionCause: UNKNOWN,
      observedMechanism: UNKNOWN, certainty: 'PROVISIONAL',
      statement: first ? `Close requested: ${cause || UNKNOWN}; actor ${actor || UNKNOWN}. Execution is unconfirmed.`
        : 'Additional close request observed; first-request provenance retained. Execution causality remains UNKNOWN.' });
  } catch (_) {}
}
function resetObserved(sm) {
  try {
    const c = context(sm);
    note(sm, sm.fillHandled || sm.entryPrice != null ? 'CLOSE_PROVISIONAL' : 'PLAN_RESET', {
      requested: c.request, observedMechanism: UNKNOWN, certainty: 'UNKNOWN', exitFills: UNKNOWN, effectiveProtectiveOrderVersion: UNKNOWN,
      stateMachineObservation: { phase: sm.phase, lastExit: sm.lastExit, exitReason: sm.exitReason, cancelReason: sm.cancelReason },
      economics: UNKNOWN, statement: 'Local state reset observed; exit mechanism, fill linkage and economics require independent confirmation.' });
    states.delete(sm); attempts.delete(sm); closeAttempts.delete(sm);
  } catch (_) {}
}
function economics(id, row, matched) {
  const observation = { source: row.pnlSource, exitPrice: row.exitPrice, realizedPnl: row.realizedPnl, fees: row.fees, exitTime: row.exitTime,
    brokerTradeKey: row.brokerTradeKey };
  return receipt(id, matched ? 'ECONOMICS_MATCH_OBSERVED' : 'CLOSE_ESTIMATE', {
    requested: UNKNOWN, observedMechanism: UNKNOWN, certainty: UNKNOWN, exitFills: UNKNOWN, effectiveProtectiveOrderVersion: UNKNOWN,
    economics: matched ? UNKNOWN : observation,
    legacyEconomicObservation: matched ? observation : UNKNOWN,
    brokerJournalAssociation: UNKNOWN,
    matchingBasis: matched ? 'existing heuristic matcher; unique broker-to-journal identity NOT established' : 'local decision-ID close estimate',
    statement: matched ? 'Legacy broker economics match observed; unique journal association is UNKNOWN. This is not an authoritative reconciliation or exit-cause confirmation.' : 'Provisional close economics; execution mechanism and final economics remain unconfirmed.'
  });
}

module.exports = { UNKNOWN, SCHEMA, BUILD, clean, identity, receipt, emit, selected, note, verdict, attemptClose, consumeCloseAttempt, requestClose, resetObserved, economics };
