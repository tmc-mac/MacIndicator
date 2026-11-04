'use strict';
// Offline synthetic diagnostics only; no broker or historical market data.
const assert = require('assert');
const S = require('../lib/structure');
const g = {
  required: [
    { name: 'control4h', when: [{ field: 'control4h', op: 'eq', value: true }] },
    { name: 'waveBias', when: [{ field: 'wavePeakBias', op: 'gte', value: 0.2 }] },
    { name: 'laneTrigger', when: [{ field: 'kind', op: 'eq', value: 'failed-break' }] },
  ], factors: [], bands: [['C', 0]], caps: []
};
const cfg = { controlAsBias: true, controlFree: true, waveBiasTrend: true, laneAccept: true };
const ev = { kind: 'accepted-break', dir: 1, control4h: false, controlKind: 'hold', wavePeakBias: 0, bias15: -0.1, bias30: -0.1 };
const r = S.gradeOf(ev, g, cfg);
assert.strictEqual(r.gates.control4h, false);
assert.strictEqual(r.gates.waveBias, false);
assert.strictEqual(r.effectiveGates.control4h, true);
assert.strictEqual(r.effectiveGates.waveBias, true);
assert.deepStrictEqual(r.waived, ['control4h->controlFree', 'waveBias->waveBiasTrend']);
assert.strictEqual(r.policy.waveBiasEffectiveFloor, 0);
assert.strictEqual(r.gateEvidence.waveBias[0][0].value, 0.2);
const bias = S.gradeOf({ ...ev, bias15: 0.1, bias30: 0.2 }, g, cfg);
assert(bias.waived.includes('control4h->bias'));
assert(!bias.waived.includes('control4h->controlFree'));
const lane = S.gradeOf({ ...ev, control4h: true, controlKind: 'trap', retestClosedInside: false, wavePeakBias: 0.4 }, g, cfg);
assert.strictEqual(lane.gates.laneTrigger, false);
assert.strictEqual(lane.effectiveGates.laneTrigger, true);
assert(lane.waived.includes('laneTrigger->laneAccept'));
const strict = S.gradeOf(ev, g, { controlFree: false, controlAsBias: false, waveBiasTrend: false, laneAccept: false });
assert.strictEqual(strict.grade, null);
assert.strictEqual(strict.policy.waveBiasEffectiveFloor, 0.2);
assert(strict.missing.includes('control4h') && strict.missing.includes('waveBias'));
const duplicate = { ...g, required: [
  { name: 'waveBias', when: [{ field: 'wavePeakBias', op: 'gte', value: -0.5 }] },
  { name: 'waveBias', when: [{ field: 'wavePeakBias', op: 'gte', value: 0.5 }] }
] };
const d = S.gradeOf({ ...ev, wavePeakBias: 0.4 }, duplicate, { waveBiasTrend: false });
assert.strictEqual(d.policy.waveBiasEffectiveFloor, null);
assert.strictEqual(d.gates.waveBias, false);
assert.deepStrictEqual(d.gateRules.map(x => x.observed), [true, false]);
const st = { period: { t: 100, O4: 100, control: null }, bars: { h4: [] }, cur: { h4: null } };
const h = S.htfStep(st, { cfg: { h4AnchorPtMin: 900 }, b: { t: 120, c: 105 } });
assert.strictEqual(h.cur4h.status, 'FORMING');
assert.strictEqual(h.prev4h, null);
assert.strictEqual(h.availability.prev4h, false);
assert.strictEqual(h.availability.daily, false);
assert.strictEqual(h.daily.side, 0); // legacy vote retained; availability is explicit
assert.strictEqual(h.daily.status, 'FORMING');
console.log('grade and HTF diagnostic witnesses passed');
