'use strict';
const { createClockConfidenceGate } = require('./alignmentEvidence/clock-gate.cjs');
const { evaluateSlot, POLICY, expectedPeriodStart, marketOpenAt, TF_MS, MAX_AGE_MS, CLOCK_DIVERGENCE_MS } = require('./alignmentFreshness');
// Every field that identifies a read-age measurement; a consumed slot must equal its board slot on all of them.
const slotKey = x => JSON.stringify([x.timeframe, x.chartTf, x.instrument, x.open, x.price, x.barStart, x.priceBarStart, x.status, x.flag,
  x.read && [x.read.doneAt, x.read.mono, x.read.gen, x.read.instrument], x.priceRead && [x.priceRead.doneAt, x.priceRead.mono, x.priceRead.gen, x.priceRead.instrument]]);
// A receipt-time or Date.now reading is NOT an independently established clock.
// Until a host witness verifier is implemented, the deployed default fails closed.
const defaultClockGate = createClockConfidenceGate({
  readEvaluationClock: () => ({ source:'runtime-wall-clock', version:'1', evaluatedAtMs:Date.now() }),
  verifyClockEvidence: () => false,
  maxEvidenceAgeMs: 0
});
function createAlignmentRuntime({ clockGate = defaultClockGate } = {}) {
  return function checkConsumedAlignment({ source, context, nowMs, freshness = null } = {}) {
    const independentReclaim = context && context.alignmentConsumed === false && typeof context.reclaimOf === 'string' && context.reclaimOf.length > 0;
    const consumed = !independentReclaim && (source === 'levels' || (context && context.alignmentConsumed === true));
    if (!consumed) return { ok:true, status:'NOT_CONSUMED', reasonCodes:[] };
    const fail = reason => ({ ok:false, status:'UNKNOWN', reasonCodes:[reason] });
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return fail('INVALID_EVALUATION_TIME');
    // Required slots are captured from configuration at initial intent, separately
    // from observations, and carried unchanged through every await/reassessment.
    const required = context && context.alignmentRequiredSlots;
    const supported = new Set(['M3', 'M5', 'M10', 'M15', 'M30', 'H1', 'H4']);
    if (!Array.isArray(required) || !required.length || required.some(tf => !supported.has(tf)) || new Set(required).size !== required.length) return fail('INVALID_REQUIRED_SLOTS');
    const slots = context && context.alignmentSlots;
    if (!Array.isArray(slots) || !slots.length) return fail('MISSING_CONSUMED_SLOTS');
    if (new Set(slots.map(s => s && s.timeframe)).size !== slots.length) return fail('DUPLICATE_SLOT');
    if (slots.length !== required.length || required.some(tf => !slots.some(slot => slot && slot.timeframe === tf))) return fail('REQUIRED_SLOT_COVERAGE_MISMATCH');
    // READ-AGE RULE (Mac 10/19 option 2; r8): when the intent carries it, every consumed slot is re-judged NOW by the SAME evaluator the
    // producer used (lib/alignmentFreshness.js), against the executor's live freshness state (current poll generation, monotonic clock,
    // instrument) and bound to the board that poll produced: a slot whose values differ from that board is refused.
    const fr = context.alignmentFreshness;
    if (fr && fr.kind === 'read-age') {
      if (fr.policy !== POLICY) return fail('INVALID_FRESHNESS_POLICY');
      const live = freshness;
      if (!live || typeof live !== 'object') return fail('MISSING_FRESHNESS_STATE');
      if (live.instrument !== context.alignmentInstrument) return fail('INSTRUMENT_MISMATCH');
      const board = live.board;
      if (!board || board.gen !== live.currentGen) return fail('NO_BOARD_FOR_CURRENT_POLL');
      const chartTf = slots[0] && slots[0].chartTf;
      const ref = board.byChart && board.byChart[chartTf];
      if (!Array.isArray(ref)) return fail('NO_BOARD_FOR_CHART');
      for (const slot of slots) {
        if (!slot || slot.rule !== 'period_open' || slot.chartTf !== chartTf) return fail('INVALID_PERIOD_OPEN_MEASUREMENT');
        if (slot.status !== 'CURRENT' || typeof slot.flag !== 'boolean' || slot.flag !== (slot.price > slot.open)) return fail('SLOT_NOT_CURRENT');
        const b = ref.find(x => x && x.timeframe === slot.timeframe);
        if (!b || slotKey(b) !== slotKey(slot)) return fail('MEASUREMENT_BOARD_MISMATCH');
        const r = evaluateSlot(slot, { nowMs, monoNowMs:live.monoNowMs, currentGen:live.currentGen, instrument:context.alignmentInstrument });
        if (!r.ok) return fail(r.code);
      }
      return { ok:true, status:'CURRENT', reasonCodes:['READ_AGE_CURRENT'] };
    }
    // r9.10 MEASURED (Mac 10/20, binary like the indicator): every consumed slot must be a decided period-open measurement that still matches
    // the board of the executor's CURRENT poll exactly (no stale intent after an await); there is no read-age rule.
    if (fr && fr.kind === 'measured') {
      const live = freshness;
      if (!live || typeof live !== 'object') return fail('MISSING_FRESHNESS_STATE');
      if (live.instrument !== context.alignmentInstrument) return fail('INSTRUMENT_MISMATCH');
      const board = live.board;
      if (!board || board.gen !== live.currentGen) return fail('NO_BOARD_FOR_CURRENT_POLL');
      const chartTf = slots[0] && slots[0].chartTf;
      const ref = board.byChart && board.byChart[chartTf];
      if (!Array.isArray(ref)) return fail('NO_BOARD_FOR_CHART');
      // MacDot 6297111941: board identity is not freshness at SUBMISSION. The board's bars must have been read <= MAX_AGE_MS ago (wall AND
      // monotonic), the market must be open, and every slot must still describe the CURRENT period at this instant (an await across a period
      // boundary refuses). A refusal only waits for the next poll's fresh board; nothing is restamped.
      if (!marketOpenAt(nowMs)) return fail('MARKET_CLOSED');
      if (!Number.isFinite(board.readAt) || !Number.isFinite(board.readMono) || !Number.isFinite(live.monoNowMs)) return fail('BOARD_READ_TIME_MISSING');
      if (nowMs - board.readAt > MAX_AGE_MS || live.monoNowMs - board.readMono > MAX_AGE_MS || nowMs < board.readAt || live.monoNowMs < board.readMono) return fail('BOARD_TOO_OLD');
      // MacDot 6297381853: the two clocks must also AGREE on the elapsed time (same CLOCK_DIVERGENCE_MS as the read-age rule): a wall clock
      // stepped inside the window is refused, not trusted because each clock alone is under the limit.
      if (Math.abs((nowMs - board.readAt) - (live.monoNowMs - board.readMono)) > CLOCK_DIVERGENCE_MS) return fail('CLOCK_DIVERGENCE');
      const chartExp = expectedPeriodStart(chartTf, nowMs);
      for (const slot of slots) {
        if (!slot || slot.rule !== 'period_open' || slot.chartTf !== chartTf || !Number.isFinite(slot.open) || !Number.isFinite(slot.price)) return fail('INVALID_PERIOD_OPEN_MEASUREMENT');
        if (slot.status !== 'CURRENT' || typeof slot.flag !== 'boolean' || slot.flag !== (slot.price > slot.open)) return fail('SLOT_NOT_CURRENT');
        const b = ref.find(x => x && x.timeframe === slot.timeframe);
        if (!b || slotKey(b) !== slotKey(slot)) return fail('MEASUREMENT_BOARD_MISMATCH');
        const exp = expectedPeriodStart(slot.timeframe, nowMs), dur = TF_MS[slot.timeframe], code = (slot.reasonCodes || [])[0];
        const periodOk = code === 'MEASURED_PROVIDER_GRID' ? slot.barStart <= nowMs && nowMs < slot.barStart + dur
          : slot.barStart === exp;
        if (!periodOk) return fail('PERIOD_CHANGED');
        // MacDot 6297417251: submission-time alignment uses CURRENT chart-price evidence only - the chart bar of the current period (a completed
        // previous bar is a signal input, not the current price); until the new chart bar exists the entry waits for the next poll.
        if (slot.priceBarStart !== chartExp) return fail('PRICE_BAR_NOT_CURRENT');
      }
      return { ok:true, status:'CURRENT', reasonCodes:['MEASURED'] };
    }
    const witnesses = context.alignmentEvidence;
    if (!witnesses || typeof witnesses !== 'object') return fail('MISSING_PROVIDER_EVIDENCE');
    for (const slot of slots) {
      if (!slot || slot.rule !== 'period_open' || !Number.isFinite(slot.open) || !Number.isFinite(slot.price)) return fail('INVALID_PERIOD_OPEN_MEASUREMENT');
      if (slot.timeframe === 'M30') return fail('M30_POLICY_NOT_ADOPTED');
      const evidence = witnesses[slot.timeframe];
      if (!evidence) return fail('MISSING_SLOT_EVIDENCE');
      let result;
      try { result = clockGate(evidence, context.alignmentClockConfidence); } catch (_) { return fail('CLOCK_GATE_EXCEPTION'); }
      if (!result || result.status !== 'CURRENT') return fail('UNVERIFIED_OR_STALE_SLOT');
      const p = result.evidenceAssessment && result.evidenceAssessment.provenance;
      const bar = p && p.selectedBar;
      if (!bar || bar.rule !== 'period_open' || bar.timeframe !== slot.timeframe || bar.instrument !== context.alignmentInstrument || !slot.session || bar.session !== slot.session || bar.start !== slot.barStart || bar.open !== slot.open || bar.price !== slot.price) return fail('MEASUREMENT_WITNESS_MISMATCH');
      // Never reuse an earlier CURRENT label after an await.
      if (!p.timestamps || p.timestamps.evaluatedAt !== nowMs) return fail('EVALUATION_CLOCK_MISMATCH');
    }
    return { ok:true, status:'CURRENT', reasonCodes:[] };
  };
}
module.exports = { createAlignmentRuntime, checkConsumedAlignment:createAlignmentRuntime() };
