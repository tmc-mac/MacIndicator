'use strict';
// edge r1.4 (X-05, RECORD ONLY): control parity. The 15m control gate reads the Levels PRO control score of ONE formula (levelsParity 'pine' = the indicator's
// formula, 'off' = the bot's). This module holds the pure parts of recording the OTHER formula's score beside it: which options the other formula takes, the
// comparison against the +/- line, and the fields a journal row gets. It evaluates nothing itself and is read by no gate, size or order: the executor calls
// the evaluator a second time on the same bars and hands both scores here; the result goes to journal rows only.
const fin = v => typeof v === 'number' && Number.isFinite(v);
const r3 = v => Math.round(v * 1000) / 1000;
const PINE_OPTS = Object.freeze({ momChartAtr: true, dedupeLevels: true });   // the same two options the executor's levelsParityOpts() passes for 'pine'
// The formula the gate uses, from CONFIG.levelsParity.
function formulaOf(levelsParity) { return levelsParity === 'pine' ? 'pine' : 'bot'; }
// The evaluator options of the OTHER formula (spread over the common options in place of levelsParityOpts()).
function altOptsFor(formula) { return formula === 'pine' ? {} : { ...PINE_OPTS }; }
// The side a score is on, exactly as the gate reads it (lib/entryControl.js classifyControl): |score| >= line -> its sign, else 0 (contested).
function sideOf(score, line) { return fin(score) && fin(line) && Math.abs(score) >= line ? Math.sign(score) : 0; }
// Is the used score close enough to the +/- line for the other formula to possibly land on the other side of it? near = null -> always.
function nearLine(used, line, near) { return near == null || (fin(used) && fin(line) && Math.abs(Math.abs(used) - line) <= near); }
// One evaluation's record. used / alt: the two raw scores (alt null = not computed; why says so).
function compare({ used, alt, line, formula, barT = null, altMs = null, why = null }) {
  if (!fin(used) || !fin(line)) return null;
  const has = fin(alt);
  return { formula, altFormula: formula === 'pine' ? 'bot' : 'pine', used: r3(used), alt: has ? r3(alt) : null, line, barT,
    disagree: has ? sideOf(used, line) !== sideOf(alt, line) : null, usedSide: sideOf(used, line), altSide: has ? sideOf(alt, line) : null, altMs: fin(altMs) ? Math.round(altMs * 10) / 10 : null, why: has ? null : (why || 'not-computed') };
}
// Row types that carry the gate's decision, and where each keeps the control score it was written with.
const ROW_TYPES = Object.freeze(['signal_check', 'trade_plan', 'trade_block', 'entry', 'control_flip', 'control_exclusion']);
function ownScore(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (fin(event.controlBiasScore)) return event.controlBiasScore;                                  // signal_check
  if (event.levels && fin(event.levels.controlBiasScore)) return event.levels.controlBiasScore;    // signal_check rows from journalSignalSnapshot (the score of the evaluation the row was written from)
  if (fin(event.controlScore)) return event.controlScore;                                          // trade_block GATE (control reasons)
  if (event.control && fin(event.control.score)) return event.control.score;                       // trade_plan
  if (event.controlContested && fin(event.controlContested.score)) return event.controlContested.score;   // entry at minimum size
  if ((event.type === 'control_flip' || (event.type === 'trade_block' && (event.code === 'CONTROL_GATE' || event.code === 'CONTROL_UNKNOWN'))) && fin(event.bias)) return event.bias;
  if (event.type === 'control_exclusion' && fin(event.score)) return event.score;
  return undefined;
}
// The fields for one journal row, or null. Only for the listed row types, and only when the row's own control score (when it carries one) is the score of
// the evaluation the other formula ran on: a row written from an older evaluation gets nothing rather than a score that is not its own.
function fieldsFor(event, latest) {
  if (!latest || !event || !ROW_TYPES.includes(event.type) || event.controlScoreAlt !== undefined) return null;
  const own = ownScore(event);
  if (own === undefined && event.type === 'entry') return null;   // an entry row is written at the fill, possibly evaluations later: only with its own score
  if (own !== undefined && Math.abs(own - latest.used) > 0.0011) return null;
  const out = { controlScore: latest.used, controlScoreAlt: latest.alt, controlFormula: latest.formula };
  if (latest.alt == null) out.controlAltWhy = latest.why; else if (latest.disagree) out.controlDisagree = true;
  return out;
}
// Adds the fields to a row in place (new keys only; an existing key is never replaced). Returns true when anything was added.
function annotate(event, latest) {
  const f = fieldsFor(event, latest); if (!f) return false;
  for (const k of Object.keys(f)) if (event[k] === undefined) event[k] = f[k];
  return true;
}
// Running cost of the second evaluation (timing only).
function createStats() {
  const c = { n: 0, skipped: 0, errors: 0, disagree: 0, altMsSum: 0, altMsMax: 0, usedMsSum: 0, usedN: 0, evalMsSum: 0, evalN: 0, evalMsMax: 0 };
  return { c,
    used(ms) { c.usedN++; c.usedMsSum += ms; }, alt(ms) { c.n++; c.altMsSum += ms; if (ms > c.altMsMax) c.altMsMax = ms; }, skip() { c.skipped++; }, error() { c.errors++; }, disagreed() { c.disagree++; },
    evaluation(ms) { c.evalN++; c.evalMsSum += ms; if (ms > c.evalMsMax) c.evalMsMax = ms; },
    view() { const avg = (s, n) => (n ? Math.round(s / n * 10) / 10 : null); const a = avg(c.altMsSum, c.n), e = avg(c.evalMsSum, c.evalN);
      return { runs: c.n, skipped: c.skipped, errors: c.errors, disagreements: c.disagree, altMsAvg: a, altMsMax: Math.round(c.altMsMax * 10) / 10, usedMsAvg: avg(c.usedMsSum, c.usedN), evalMsAvg: e, evalMsMax: Math.round(c.evalMsMax * 10) / 10,
        // what the second run adds, over ALL evaluations (those that skipped it count as 0): ms per evaluation, and as a share of the evaluation without it (evalMs includes it)
        addedMsPerEval: c.evalN ? Math.round(c.altMsSum / c.evalN * 10) / 10 : null, addedPct: c.evalN && c.evalMsSum - c.altMsSum > 0 ? Math.round(c.altMsSum / (c.evalMsSum - c.altMsSum) * 1000) / 10 : null }; } };
}
module.exports = { PINE_OPTS, ROW_TYPES, formulaOf, altOptsFor, sideOf, nearLine, compare, ownScore, fieldsFor, annotate, createStats };
