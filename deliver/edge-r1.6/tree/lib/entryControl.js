'use strict';
// Week 1 is an explicit source policy, not a clock-based expiry or local toggle.
const POLICY = Object.freeze({ id: 'week1-decided-m15-v2', threshold: 0.22 });
// lv1 r13.3.3-ctl1 (Mac 10/30, MacArthur's scope): the 15m control line (controlGateMin) is the one source-policy value config-local.json may set,
// a number from 0.05 to 0.45 (shipped: POLICY.threshold, 0.22). lockPolicy locks the config's own value; classifyControl and controlDisplaySnapshot
// read the line from that locked config. An unusable line gives no side (fail closed); the bot's startup check stops it with FATAL before that.
// standdownWeek1, controlDirectionGate and controlContestedMinSize stay source policy (a local value is still ignored).
const CONTROL_LINE = Object.freeze({ min: 0.05, max: 0.45 });
let lockedConfig = null;
function controlLineProblem(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= CONTROL_LINE.min && v <= CONTROL_LINE.max ? null
    : `a number from ${CONTROL_LINE.min} to ${CONTROL_LINE.max} (the 15m control line; shipped ${POLICY.threshold}), got ${JSON.stringify(v)}`;
}
function controlLine() { const v = lockedConfig ? lockedConfig.controlGateMin : POLICY.threshold; return controlLineProblem(v) === null ? v : null; }
function classifyControl(lv, dir) {
  const score = Number.isFinite(lv?.controlBiasScore) ? lv.controlBiasScore : null;
  const valid = lv?.controlValid === true && score !== null;
  const line = controlLine();
  const side = valid && line !== null && Math.abs(score) >= line ? Math.sign(score) : 0;
  const reason = !valid ? 'control-unknown' : !side ? 'control-contested' : side !== dir ? 'control-opposite' : null;
  return { ok: !reason, reason, score, valid, side, threshold: line, timeframe: 'M15',
    controlSource: 'LevelsPro.M15', observedAt: lv?.controlObservedAt ?? null,
    evaluatedAt: lv?.controlEvaluatedAt ?? null, policy: POLICY.id };
}
function lockPolicy(config, overrides = []) {
  const line = config.controlGateMin === undefined ? POLICY.threshold : config.controlGateMin;   // ctl1: the config's own line (shipped 0.22; a local one stays)
  for (const [key, value] of Object.entries({ standdownWeek1: true, controlDirectionGate: true, controlGateMin: line, controlContestedMinSize: false })) {
    Object.defineProperty(config, key, { value, enumerable: true, writable: false, configurable: false });
    if (key !== 'controlGateMin') for (const item of overrides) if (item.key === key) { item.requested = item.to; item.to = value; item.note = POLICY.id + ': source policy; local override ignored'; }
  }
  lockedConfig = config;
}
function createControlJournal(append, limit = 4000) {
  const seen = new Map();
  return (lv, dir, meta = {}) => {
    const verdict = classifyControl(lv, dir);
    if (verdict.ok) return true;
    const setup = meta.setup ?? meta.path ?? 'entry';
    const opportunityId = JSON.stringify([meta.source ?? 'unknown', dir, setup, meta.triggerTf ?? null,
      meta.triggerAt ?? null, verdict.observedAt, verdict.reason]);
    if (!seen.has(opportunityId)) {
      seen.set(opportunityId, true);
      if (seen.size > limit) seen.delete(seen.keys().next().value);
      append({ type: 'control_exclusion', code: 'CONTROL_EXCLUDED', t: Date.now(), ...verdict,
        source: meta.source ?? 'unknown', setup, dir, triggerTf: meta.triggerTf ?? null,
        triggerAt: meta.triggerAt ?? null, seam: meta.seam ?? 'selection', opportunityId,
        stage: 'candidate-before-order', outcome: 'excluded' });
    }
    return false;
  };
}
// Read-only display view of the same M15 control read. Never consumed by an entry, sizing or transport path.
function controlDisplaySnapshot(lv) {
  const score = Number.isFinite(lv?.controlBiasScore) ? lv.controlBiasScore : null;
  const valid = lv?.controlValid === true && score !== null;
  const line = controlLine();
  const side = valid && line !== null && Math.abs(score) >= line ? Math.sign(score) : 0;
  return { side, score, valid, threshold: line, timeframe: 'M15', policy: POLICY.id,
    observedAt: lv?.controlObservedAt ?? null, evaluatedAt: lv?.controlEvaluatedAt ?? null };
}
module.exports = { POLICY, CONTROL_LINE, controlLineProblem, controlLine, classifyControl, controlDisplaySnapshot, lockPolicy, createControlJournal };
