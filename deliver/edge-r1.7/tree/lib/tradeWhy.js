'use strict';
// Display only: per-trade "why this trade / why it closed" facts for the phone, built ONLY from rows the bot already journals
// (trade_plan, entry, trade_manage), joined by journalId. It mints no new judgement: stage and invalidation have no producer yet
// and stay UNKNOWN; a close is named by its journaled mechanism code, never by the sign of the result; a flatten event does not
// prove who started it. Never consumed by an entry, sizing, gate, exit or transport path.
const CLOSE_CODES = new Set(['STOP_FILLED', 'TP1_FILLED', 'MARKET_EXIT', 'FILLED_THROUGH_STOP', 'MANUAL_FLATTEN', 'FLATTEN_CONFIRMED', 'POSITION_CLOSED', 'PROFIT_TRAIL', 'LADDER_REPAIR']);
const WINDOW = 60;   // newest close-related events kept per trade (oldest dropped, so the real close is never lost behind earlier events)
const CAP = 300;   // journalIds kept (oldest dropped first)

function createTradeWhyIndex(cap = CAP) {
  const byId = new Map();
  const rec = id => { let r = byId.get(id); if (!r) { r = { plan: null, codes: [], trailIntents: 0 }; byId.set(id, r); while (byId.size > cap) byId.delete(byId.keys().next().value); } return r; };
  function index(e) {
    if (!e || typeof e !== 'object' || typeof e.journalId !== 'string' || !e.journalId) return;
    if (e.type === 'trade_plan') {
      rec(e.journalId).plan = {
        path: str(e.path), pathLabel: str(e.pathLabel), timeframe: str(e.timeframe), intrabar: typeof e.intrabar === 'boolean' ? e.intrabar : null,
        entryType: str(e.entry && e.entry.type), stopPoints: num(e.stop && e.stop.points), stopBasis: str(e.stop && e.stop.basis),
        riskUsd: num(e.riskCap && e.riskCap.riskUsd), cap: num(e.riskCap && e.riskCap.cap), candidateBasis: str(e.candidateBasis),
      };
    } else if (e.type === 'trade_manage' && CLOSE_CODES.has(e.code)) {
      const r = rec(e.journalId);
      // Keep what each event proves: fill certainty (sure), trail stage/level (an intent), repair outcome (applied or not).
      r.codes.push({ code: e.code, t: num(e.t), sure: typeof e.sure === 'boolean' ? e.sure : null, stage: str(e.stage), stopPrice: num(e.stopPrice), ok: typeof e.ok === 'boolean' ? e.ok : null, whole: e.whole === true });
      if (e.code === 'PROFIT_TRAIL') r.trailIntents++;
      if (r.codes.length > WINDOW) r.codes.shift();
    }
  }
  return { index, get: id => byId.get(id) || null, size: () => byId.size };
}
const str = v => (typeof v === 'string' && v ? v : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Decision facts: the entry row's sizing block names the producer whose grade sized the trade (Levels-sized trades carry the Levels
// grade there even when the entry row's legacy `grade` field holds another source's grade).
function decisionFacts(entryEvent, rec) {
  if (!entryEvent && !(rec && rec.plan)) return null;
  const sz = entryEvent && entryEvent.sizing && typeof entryEvent.sizing === 'object' ? entryEvent.sizing : null;
  const conf = sz && sz.confidence && typeof sz.confidence === 'object' ? sz.confidence : null;
  const p = rec && rec.plan;
  return {
    path: p ? p.path : null, pathLabel: p ? p.pathLabel : null, timeframe: p ? p.timeframe : null, intrabar: p ? p.intrabar : null, entryType: p ? p.entryType : null,
    producer: conf && str(conf.source) ? { source: conf.source, grade: str(conf.grade) } : null,
    // allowed = the sizing policy's result; entered = the contracts the entry row records (a caller may submit fewer than allowed).
    sizing: sz ? { raw: num(sz.rawContracts), ceiling: num(sz.gradeCeiling), globalMax: num(sz.globalMax), allowed: num(sz.contracts), reason: str(sz.reason) } : null,
    entered: entryEvent ? num(entryEvent.contracts) : null,
    stopPoints: p ? p.stopPoints : null, stopBasis: p ? p.stopBasis : null, riskUsd: p ? p.riskUsd : null, cap: p ? p.cap : null,
    alignmentConsumed: entryEvent && typeof entryEvent.alignmentConsumed === 'boolean' ? entryEvent.alignmentConsumed : null,
    stage: 'UNKNOWN', invalidation: 'UNKNOWN',
  };
}
// Close facts. The final mechanism is the last SPECIFIC exit event (stop, whole-position TP1, market exit, fill through stop, flatten),
// with its recorded certainty; a generic POSITION_CLOSED never replaces it, and alone means "closed, mechanism not detailed".
// A MARKET_EXIT (possibly one leg) is reported as an event during the trade, never as the whole trade's close.
// A partial TP1 (whole !== true) is progress, not a close. PROFIT_TRAIL is an intent; LADDER_REPAIR ok:true only says the ladder
// check reported itself resolved (it can also resolve by exiting), so it is never treated as proof the stop move was applied.
function closeFacts(rec) {
  const codes = rec && Array.isArray(rec.codes) ? rec.codes : [];
  // MARKET_EXIT is not a final cause: the stop audit can market-exit ONE leg while others stay open, so it is reported as an event only.
  const isSpecific = x => ['STOP_FILLED', 'FILLED_THROUGH_STOP', 'FLATTEN_CONFIRMED', 'MANUAL_FLATTEN'].includes(x.code) || (x.code === 'TP1_FILLED' && x.whole);
  let li = -1; for (let k = 0; k < codes.length; k++) if (isSpecific(codes[k])) li = k;
  const generic = codes.some(x => x.code === 'POSITION_CLOSED');
  const last = li >= 0 ? codes[li] : null, before = li >= 0 ? codes.slice(0, li) : codes;
  const any = c => codes.some(x => x.code === c);
  const mech = !last ? (generic ? 'closed' : 'UNKNOWN')
    : last.code === 'STOP_FILLED' ? 'stop' : last.code === 'TP1_FILLED' ? 'tp1-whole'
    : last.code === 'FILLED_THROUGH_STOP' ? 'filled-through-stop'
    : any('FILLED_THROUGH_STOP') ? 'filled-through-stop' : 'flatten';
  let ti = -1; for (let k = 0; k < before.length; k++) if (before[k].code === 'PROFIT_TRAIL') ti = k;
  const lastTrail = ti >= 0 ? before[ti] : null, after = ti >= 0 ? before.slice(ti + 1) : [];
  const ladder = !lastTrail ? null : after.some(x => x.code === 'LADDER_REPAIR' && x.ok === false) ? 'failed'
    : after.some(x => x.code === 'LADDER_REPAIR' && x.ok === true) ? 'reported-resolved' : null;
  return { mechanism: mech, at: last ? last.t : null, sure: last ? last.sure : null,
    trailIntents: rec && Number.isFinite(rec.trailIntents) ? rec.trailIntents : 0,
    lastTrail: lastTrail ? { stage: lastTrail.stage, stopPrice: lastTrail.stopPrice, ladder } : null,
    partialTp1: codes.some(x => x.code === 'TP1_FILLED' && !x.whole), marketExitReported: any('MARKET_EXIT'), flattenConfirmed: any('FLATTEN_CONFIRMED'),
    initiator: mech === 'flatten' ? 'UNKNOWN' : null };   // a flatten event does not record who started it
}
module.exports = { createTradeWhyIndex, decisionFacts, closeFacts, CLOSE_CODES };
