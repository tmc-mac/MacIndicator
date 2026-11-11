'use strict';
// edge r1 (Mac 11/11): two measured exit rules, each behind a switch. Pure helpers: no I/O, no requires. The decisions and the orders are the order machine's
// (lib/liveStateMachine.js earlyAdverseStep / _decideRunnerPlan); the executor validates the config at startup (fail closed) and prints the two startup lines.
//
// A. EARLY ADVERSE EXIT (CONFIG.earlyAdverseExit { mode: 'exit' | 'log' | 'off', afterSec, lossPts, minSeenPts }). Once per trade, before TP1: at the first completed
//    1m close that is afterSec (120 s) or more after the fill observation, a close at or beyond lossPts (10) against the position AND a best favourable excursion
//    (np1's tracker: complete 1m bars after the fill minute) below minSeenPts (3) = closed at market through the safe-exit path (sessionFlatten, kind
//    'early-adverse'). The close used must be within afterSec + 60 s of the fill; the decision must be made within EAE_DECIDE_GRACE_MS of that close.
// B. SESSION RUNNER RULE (CONFIG.sessionRunner { asia, london, ny, late }: 'live' | 'allAtTp1' | 'atrTarget'; CONFIG.sessionRunnerNy { stopPts, tp2AtrMult }).
//    The session is the fill's session (lib/stopFloor.js sessionOf, the same helper as the entry stop floor).
const EAE_MODES = ['exit', 'log', 'off'];
const RUNNER_MODES = ['live', 'allAtTp1', 'atrTarget'];
const SESSIONS = ['asia', 'london', 'ny', 'late'];
const EAE_WINDOW_EXTRA_MS = 60000;    // the close used is at most afterSec + 60 s after the fill (120 s -> 180 s)
const EAE_SEND_MAX_MS = 60000;       // edge r1.1 (review S2): a decided exit whose market order has not gone out this long after the decision expires (the trade keeps its stop, TP1 and np1)
const EAE_DECIDE_GRACE_MS = 45000;    // the decision is made at most this long after that close (two 20 s polls + latency); later = unassessed, never a late exit
const M1 = 60000, M15 = 900000, ATR_N = 14;
const fin = x => typeof x === 'number' && Number.isFinite(x);

function validateEae(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['earlyAdverseExit must be an object { mode, afterSec, lossPts, minSeenPts }'];
  const e = [];
  if (!EAE_MODES.includes(cfg.mode)) e.push(`earlyAdverseExit.mode must be one of ${EAE_MODES.map(x => JSON.stringify(x)).join(' or ')}, got ${JSON.stringify(cfg.mode)}`);
  if (!(fin(cfg.afterSec) && cfg.afterSec >= 60 && cfg.afterSec <= 240)) e.push(`earlyAdverseExit.afterSec must be 60 to 240 seconds, got ${JSON.stringify(cfg.afterSec)}`);
  if (!(fin(cfg.lossPts) && cfg.lossPts > 0 && cfg.lossPts <= 100)) e.push(`earlyAdverseExit.lossPts must be above 0 and at most 100 points, got ${JSON.stringify(cfg.lossPts)}`);
  if (!(fin(cfg.minSeenPts) && cfg.minSeenPts > 0 && cfg.minSeenPts <= 50)) e.push(`earlyAdverseExit.minSeenPts must be above 0 and at most 50 points, got ${JSON.stringify(cfg.minSeenPts)}`);
  return e;
}
function eaeLine(cfg) {
  const rule = `first 1m close ${cfg.afterSec} s+ after the fill, before TP1: at -${cfg.lossPts} pts or worse and never seen at +${cfg.minSeenPts}`;
  return '[eae] early adverse exit: ' + (cfg.mode === 'exit' ? `ON (${rule} = closed at market on the safe-exit rule; close used within ${cfg.afterSec + EAE_WINDOW_EXTRA_MS / 1000} s of the fill, decided within ${EAE_DECIDE_GRACE_MS / 1000} s of it, else unassessed; a decided exit not sent within ${EAE_SEND_MAX_MS / 1000} s expires)`
    : cfg.mode === 'log' ? `LOG (${rule} = journaled with wouldExit, NO order sent)` : 'off');
}
// The 1m close the rule reads. Returns { wait: true } (not there yet), { bar, closeAt, lateMs } or { missed: true, why }.
function eaeCloseBar(m1, fillAt, now, cfg) {
  const firstCloseAt = Math.ceil((fillAt + cfg.afterSec * 1000) / M1) * M1, windowEnd = fillAt + cfg.afterSec * 1000 + EAE_WINDOW_EXTRA_MS;
  if (now < firstCloseAt) return { wait: true, firstCloseAt };
  const done = (Array.isArray(m1) ? m1 : []).filter(b => b && fin(b.t) && fin(b.c) && b.t % M1 === 0 && b.t + M1 <= now && b.t + M1 >= firstCloseAt && b.t + M1 <= windowEnd).sort((a, b) => a.t - b.t);
  const fresh = done.find(b => now - (b.t + M1) <= EAE_DECIDE_GRACE_MS);
  if (fresh) return { bar: fresh, closeAt: fresh.t + M1, lateMs: now - (fresh.t + M1), firstCloseAt };
  const lastClose = Math.floor(windowEnd / M1) * M1;
  if (now > lastClose + EAE_DECIDE_GRACE_MS) return { missed: true, firstCloseAt, why: done.length ? `the 1m close was seen ${Math.round((now - (done[0].t + M1)) / 1000)} s late (limit ${EAE_DECIDE_GRACE_MS / 1000} s)` : `no 1m close between ${cfg.afterSec} and ${cfg.afterSec + EAE_WINDOW_EXTRA_MS / 1000} s after the fill was seen in time (poll gap)` };
  return { wait: true, firstCloseAt };
}

function validateRunner(cfg, ny) {
  const e = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) e.push('sessionRunner must be an object { asia, london, ny, late }');
  else for (const s of SESSIONS) if (!RUNNER_MODES.includes(cfg[s])) e.push(`sessionRunner.${s} must be one of ${RUNNER_MODES.map(x => JSON.stringify(x)).join(' or ')}, got ${JSON.stringify(cfg[s])}`);
  if (!ny || typeof ny !== 'object' || Array.isArray(ny)) e.push('sessionRunnerNy must be an object { stopPts, tp2AtrMult }');
  else {
    if (!(fin(ny.stopPts) && ny.stopPts >= 0 && ny.stopPts <= 50)) e.push(`sessionRunnerNy.stopPts must be 0 to 50 points (the runner's stop, from the entry in the profit direction), got ${JSON.stringify(ny.stopPts)}`);
    if (!(fin(ny.tp2AtrMult) && ny.tp2AtrMult >= 0.25 && ny.tp2AtrMult <= 10)) e.push(`sessionRunnerNy.tp2AtrMult must be 0.25 to 10 (x ATR15), got ${JSON.stringify(ny.tp2AtrMult)}`);
  }
  return e;
}
function runnerAllLive(cfg) { return !!cfg && SESSIONS.every(s => cfg[s] === 'live'); }
function runnerLine(cfg, ny, scaleOutOn) {
  const txt = m => m === 'allAtTp1' ? 'all contracts out at TP1 (no runner)' : m === 'atrTarget' ? `runner stop entry +${ny.stopPts}, TP2 ${ny.tp2AtrMult} x ATR15 from the fill, no trail, flat at the session close` : 'live (unchanged)';
  return `[runner] session runner: asia ${txt(cfg.asia)}; london ${txt(cfg.london)}; ny ${txt(cfg.ny)}; late ${txt(cfg.late)}`
    + (runnerAllLive(cfg) ? '' : scaleOutOn ? ' (by the fill\'s session; ATR15 missing at the fill = live for that trade)' : ' - INACTIVE: scaleOutRunner is off, every trade is live');
}
// ATR15 for the runner target: the MEAN true range of the 14 completed 15m bars before ts (bars: { t (bar start, ms), h, l, c }; the forming bar is dropped by time).
// Needs 15 consecutive completed bars (the 15th gives the first previous close) and the newest of them must be the bar that closed last before ts or the one before it.
function atr15At(bars, ts) {
  if (!Array.isArray(bars) || !fin(ts)) return { atr: null, why: 'no 15m bars' };
  const done = bars.filter(b => b && fin(b.t) && fin(b.h) && fin(b.l) && fin(b.c) && b.t + M15 <= ts).sort((a, b) => a.t - b.t).slice(-(ATR_N + 1));
  if (done.length < ATR_N + 1) return { atr: null, why: `only ${done.length} completed 15m bars (needs ${ATR_N + 1})` };
  const newestEnd = done[done.length - 1].t + M15, lastBoundary = Math.floor(ts / M15) * M15;
  if (newestEnd < lastBoundary - M15) return { atr: null, why: `the 15m bars are stale (newest closed ${Math.round((ts - newestEnd) / 60000)} min before the fill)` };
  let sum = 0;
  for (let i = 1; i < done.length; i++) {
    const b = done[i], pc = done[i - 1].c, tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (!(fin(tr) && tr >= 0)) return { atr: null, why: 'a 15m bar is malformed' };
    sum += tr;
  }
  const atr = sum / ATR_N;
  return atr > 0 ? { atr: Math.round(atr * 100) / 100, bars: ATR_N, newestEnd } : { atr: null, why: 'the 15m true range is zero' };
}
// The plan for one fill: { session, mode, stopPts, tp2AtrMult, atr15, why }. The order machine applies its own shape checks (scale-out trade with one runner).
function runnerPlanFor({ session, cfg, ny, bars15, ts }) {
  const mode = cfg && SESSIONS.includes(session) && RUNNER_MODES.includes(cfg[session]) ? cfg[session] : 'live';
  const a = atr15At(bars15, ts);
  return { session: session || null, mode, stopPts: ny ? ny.stopPts : null, tp2AtrMult: ny ? ny.tp2AtrMult : null, atr15: a.atr, why: mode === 'atrTarget' && a.atr == null ? `ATR15 unavailable at the fill: ${a.why}` : null };
}
module.exports = { EAE_MODES, RUNNER_MODES, SESSIONS, EAE_WINDOW_EXTRA_MS, EAE_DECIDE_GRACE_MS, EAE_SEND_MAX_MS, validateEae, eaeLine, eaeCloseBar, validateRunner, runnerAllLive, runnerLine, atr15At, runnerPlanFor };
