'use strict';
// edge r1.1 (Mac 11/11): RECORD AND REPORT ONLY. The per-trade rule facts, the rule scorecard, the early-exit shadow and the ATR-sized TP1 shadow.
// Nothing here is read by an entry, an exit, a size or an order: the module has no broker access at all (no token, no order function, no fetch). It is fed
//   - journal rows the bot already writes (indexJournal),
//   - the poll's price and 1m bars the bot already fetched, plus a read-only view of the open trade (onPoll),
//   - the broker round trips the bot already reads for Recent Trades (onBrokerTrades).
// State: one small JSON file, written tmp + rename, read at startup. A corrupt file = start fresh, journal a scorecard_state row, never throw.
// Every public method catches its own errors: a scorecard bug can cost a number on the phone, never a poll.
const SESSIONS = ['asia', 'london', 'ny', 'late'];
const TP1S_MODES = ['log', 'off'];
const M1 = 60000;
const EAE_SHADOW_MS = 30 * M1;        // the early-exit shadow watches for 30 minutes
const TP1S_MAX_MS = 240 * M1;         // the TP1 shadow watches for 240 minutes (the study's path length)
const PRICE_GAP_MS = 3 * M1;          // no price for longer than this while a shadow is watching = unresolved (never interpolated)
const MONEY_WAIT_MS = 6 * 3600000;    // a closed trade waits this long for its broker round trip, then is counted without money
const SAVE_EVERY_MS = M1;             // heartbeat-only changes (last price time) are saved at most once a minute
const VERSION = 1;
// edge r1.4 (X-03 / X-04): the OLD runner rule shadow. For a trade the session runner rule manages ('allAtTp1' or 'atrTarget') the scorecard follows what
// `sessionRunner: live` would have done with the same fill on the price path the bot already polls: at TP1 every contract but ONE exits, the one runner's stop
// rests at entry + lockPts and then trails lockPts behind the best price in stepPts steps (lib/riskRules.js runnerTrailOffset, the order machine's own formula),
// and the runner is flat at the session close. Record only: journal row runner_shadow + the scorecard's runnerShadow line. Bounded watch (RS_MAX_MS from the
// fill), unresolved on a price gap (PRICE_GAP_MS), never interpolated; the state lives in the scorecard file, so a restart continues it or ends it unresolved.
const RS_MAX_MS = 240 * M1;           // the old-runner shadow watches at most 240 minutes from the fill
const RS_SAME_WAIT_MS = 3 * M1;       // a trade that ended without TP1: wait this long for the last 1m bars, then "same as live"
const RS_RULES = ['allAtTp1', 'atrTarget'];
// edge r1.4 (D2): a NY trade is "late" when its fill is at or after this Pacific time. A constant here, not a config key: the counter only records.
const NY_LATE_CUT_PT = '09:00', NY_LATE_CUT_MIN = 9 * 60;
const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function ptHm(t) { try { const o = {}; for (const p of PT_FMT.formatToParts(new Date(t))) o[p.type] = p.value; const h = parseInt(o.hour, 10) % 24, m = parseInt(o.minute, 10); return { min: h * 60 + m, text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }; } catch (e) { return null; } }
const fin = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => (fin(x) ? Math.round(x * 100) / 100 : null);
// The old runner's stop offset from the entry, in points: the same arithmetic as lib/riskRules.js runnerTrailOffset (a copy: this module requires nothing but fs;
// test/runner-shadow.test.js checks the two against each other).
function runnerTrailOffset(peakPts, { lockPts = 10, stepPts = 10 } = {}) { const p = fin(peakPts) ? peakPts : 0; return Math.max(lockPts, Math.floor(p / stepPts + 1e-9) * stepPts - lockPts); }

// ---- config (fail closed: the executor refuses to start on any problem) ----
function validateTp1Shadow(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['tp1AtrShadow must be an object { mode, atrMult, minPts, maxPts, beAfterPts }'];
  const e = [];
  if (!TP1S_MODES.includes(c.mode)) e.push(`tp1AtrShadow.mode must be "log" or "off", got ${JSON.stringify(c.mode)}`);
  if (!(fin(c.atrMult) && c.atrMult >= 0.1 && c.atrMult <= 5)) e.push(`tp1AtrShadow.atrMult must be 0.1 to 5 (x ATR15), got ${JSON.stringify(c.atrMult)}`);
  if (!(fin(c.minPts) && c.minPts > 0 && c.minPts <= 200)) e.push(`tp1AtrShadow.minPts must be above 0 and at most 200 points, got ${JSON.stringify(c.minPts)}`);
  if (!(fin(c.maxPts) && c.maxPts > 0 && c.maxPts <= 500)) e.push(`tp1AtrShadow.maxPts must be above 0 and at most 500 points, got ${JSON.stringify(c.maxPts)}`);
  if (fin(c.minPts) && fin(c.maxPts) && c.minPts > c.maxPts) e.push(`tp1AtrShadow.minPts (${c.minPts}) must not be above maxPts (${c.maxPts})`);
  if (!(fin(c.beAfterPts) && c.beAfterPts > 0 && c.beAfterPts <= 200)) e.push(`tp1AtrShadow.beAfterPts must be above 0 and at most 200 points, got ${JSON.stringify(c.beAfterPts)}`);
  return e;
}
function shadowTp1Pts(atr15, c) { return fin(atr15) && atr15 > 0 && c ? r2(Math.min(c.maxPts, Math.max(c.minPts, c.atrMult * atr15))) : null; }
function scoreLine(since, c) {
  return `[score] scorecard since ${fin(since) ? new Date(since).toISOString() : '?'} ; tp1 ATR shadow: ${c && c.mode === 'log' ? `LOG (TP1 = ${c.atrMult} x ATR15 at the fill, ${c.minPts}-${c.maxPts} pts; plain stop and stop-to-entry after +${c.beAfterPts}; journal rows only, no order is ever sent or changed)` : 'off'}`;
}

// ---- ATR15 median over the last `days` calendar days (display only). bars: [{ t, h, l, c }] 15m bars, oldest first (the forming bar is dropped by time). ----
const M15 = 900000, ATR_N = 14;
function atr15Median(bars, now, days = 20) {
  if (!Array.isArray(bars) || !fin(now)) return null;
  const done = bars.filter(b => b && fin(b.t) && fin(b.h) && fin(b.l) && fin(b.c) && b.t + M15 <= now);
  const from = now - days * 86400000;
  if (done.length < ATR_N + 2 || done[0].t > from) return null;   // the bot does not hold `days` days of 15m bars
  const tr = new Array(done.length).fill(null);
  for (let i = 1; i < done.length; i++) { const b = done[i], pc = done[i - 1].c; tr[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); }
  const out = []; let sum = 0;
  for (let i = 1; i < done.length; i++) {
    sum += tr[i]; if (i > ATR_N) sum -= tr[i - ATR_N];
    if (i >= ATR_N && done[i].t + M15 > from) out.push(sum / ATR_N);
  }
  if (!out.length) return null;
  out.sort((a, b) => a - b);
  const m = out.length % 2 ? out[(out.length - 1) / 2] : (out[out.length / 2 - 1] + out[out.length / 2]) / 2;
  return r2(m);
}
// snapshot.rules (pure; the executor passes its CONFIG objects and the numbers it already holds)
function rulesView({ eae, runner, runnerNy, scaleOutOn, sessionNow, atr15Now, atr15Median20d, tp1Shadow }) {
  const mode = scaleOutOn && runner && SESSIONS.includes(sessionNow) ? runner[sessionNow] : 'live';
  return {
    earlyAdverseExit: eae ? { mode: eae.mode, afterSec: eae.afterSec, lossPts: eae.lossPts, minSeenPts: eae.minSeenPts } : null,
    sessionRunner: runner ? { asia: runner.asia, london: runner.london, ny: runner.ny, late: runner.late } : null,
    sessionRunnerNy: runnerNy ? { stopPts: runnerNy.stopPts, tp2AtrMult: runnerNy.tp2AtrMult } : null,
    sessionNow: SESSIONS.includes(sessionNow) ? sessionNow : null,
    atr15Now: fin(atr15Now) ? atr15Now : null,
    atr15Median20d: fin(atr15Median20d) ? atr15Median20d : null,
    runnerNow: { mode, tp2Pts: mode === 'atrTarget' && fin(atr15Now) && runnerNy && fin(runnerNy.tp2AtrMult) ? r2(runnerNy.tp2AtrMult * atr15Now) : null },
    tp1AtrShadow: tp1Shadow && tp1Shadow.mode === 'log' ? { mode: 'log', atrMult: tp1Shadow.atrMult, minPts: tp1Shadow.minPts, maxPts: tp1Shadow.maxPts, beAfterPts: tp1Shadow.beAfterPts, tp1PtsNow: shadowTp1Pts(atr15Now, tp1Shadow) } : { mode: 'off' },
  };
}

// ---- aggregates ----
const emptyRs = () => ({ n: 0, resolved: 0, unresolved: 0, pending: 0, tp1NotReached: 0, compared: 0, oldPtsSum: 0, livePtsSum: 0 });   // edge r1.4
const emptyT1 = () => ({ n: 0, unresolved: 0, touched: 0, filled: 0, touchedFilled: 0, touchedNotFilled: 0, filledUntouched: 0, neither: 0, tnfFullStops: 0, tnfNetUsd: 0, tnfNetKnown: 0, tnfMoneyMissing: 0 });
const emptyNy = () => ({ trades: 0, wins: 0, fullStops: 0, netUsd: 0, grossUsd: 0, contracts: 0, moneyMissing: 0 });
const EAE_PTS_KEYS = ['firedPtsN', 'firedPtsSum', 'shadowPtsN', 'shadowPtsSum'];   // edge r1.2: added counters; a scorecard file written before them loads with 0 (never thrown away)
function emptyAgg() {
  const sess = f => Object.fromEntries(SESSIONS.map(s => [s, f()]));
  return {
    eae: { fired: 0, passed: 0, unassessed: 0, logWouldExit: 0, firedNetUsd: 0, stop: 0, tp1: 0, unresolved: 0, pending: 0, estSavedUsd: 0,
      firedPtsN: 0, firedPtsSum: 0, shadowPtsN: 0, shadowPtsSum: 0 },   // edge r1.2: the same story in points per contract (EAE_PTS_KEYS)
    runner: sess(() => ({ trades: 0, tp1Hits: 0, allAtTp1Count: 0, n: 0, tp2Hits: 0, stoppedAtPlus2: 0, sessionClosed: 0, other: 0, runnerNetUsd: 0, reached30: 0, runnerPtsSum: 0, runnerPtsN: 0 })),
    tp1s: { n: 0, resolved: 0, unresolved: 0, pending: 0, plainUsd: 0, beUsd: 0, liveUsd: 0, liveMissing: 0, extraPlain: 0, extraBe: 0, pTp1: 0, pStop: 0, bTp1: 0, bStop: 0, bBe: 0 },
    totals: sess(() => ({ trades: 0, wins: 0, fullStops: 0, netUsd: 0, grossUsd: 0, contracts: 0 })),
    moneyMissing: 0,
    t1: emptyT1(), ny: { late: emptyNy(), early: emptyNy() },   // edge r1.4: D1 (TP1 touched) and D2 (NY late-session) counters
    rs: Object.fromEntries(RS_RULES.map(k => [k, emptyRs()])),   // edge r1.4: the old runner rule shadow, by the live rule the trade got
  };
}
// Adds one trade record to an aggregate. Pure. The same function serves the permanent fold (a finished record) and the live view (records still waiting).
function fold(a, r, ctx) {
  const pv = ctx.pointValue, cost = ctx.costPerContractRoundTrip || 0, s = SESSIONS.includes(r.session) ? r.session : null, m = r.money || null;
  const closed = !r.open;
  // early exit
  if (closed) {
    if (r.eae === 'fired') { a.eae.fired++; if (m && fin(m.netUsd)) a.eae.firedNetUsd += m.netUsd;
      if (m && fin(m.grossUsd) && fin(pv) && pv > 0 && r.contracts > 0) { a.eae.firedPtsN++; a.eae.firedPtsSum += m.grossUsd / (pv * r.contracts); } }   // edge r1.2: broker gross points per contract of the exit
    else if (r.eae === 'passed') a.eae.passed++;
    else if (r.eae === 'unassessed') a.eae.unassessed++;
    else if (r.eae === 'log-would-exit') a.eae.logWouldExit++;
  }
  const es = r.eaeShadow;
  if (es && (closed ? r.eae === 'fired' : true)) {
    if (es.state === 'pending') a.eae.pending++;
    else if (es.state === 'unresolved') a.eae.unresolved++;
    else if (es.state === 'stop' || es.state === 'tp1') {
      a.eae[es.state]++;
      if (closed && fin(es.stopPts) && fin(es.tp1Pts)) { a.eae.shadowPtsN++; a.eae.shadowPtsSum += es.state === 'stop' ? -es.stopPts : es.tp1Pts; }   // edge r1.2: what the untouched plan ended at, in points
      if (closed && m && fin(m.grossUsd) && fin(es.stopPts) && fin(es.tp1Pts) && fin(pv) && r.contracts > 0) {
        const plan = es.state === 'stop' ? -es.stopPts * pv * r.contracts : es.tp1Pts * pv * r.contracts;
        a.eae.estSavedUsd += m.grossUsd - plan;
      }
    }
  }
  // runner + totals
  if (closed && s) {
    const R = a.runner[s]; R.trades++;
    const reason = m ? m.exitReason : null, tp1Hit = !!r.tp1Hit || reason === 'TP1' || reason === 'TP2' || reason === 'RUNNER_STOP';
    if (tp1Hit) R.tp1Hits++;
    if (r.runnerMode === 'allAtTp1') R.allAtTp1Count++;
    if (r.runnerMode === 'atrTarget' && tp1Hit) {
      R.n++;
      const end = reason === 'TP2' ? 'tp2' : reason === 'RUNNER_STOP' ? 'stop' : reason === 'SESSION_CLOSE' || reason === 'MORNING_HOLD' ? 'session' : 'other';
      if (end === 'tp2') R.tp2Hits++; else if (end === 'stop') R.stoppedAtPlus2++; else if (end === 'session') R.sessionClosed++; else R.other++;
      if (end === 'stop' && fin(r.best) && r.best >= 30) R.reached30++;
      if (m && fin(m.netUsd)) R.runnerNetUsd += m.netUsd;
      const run = r.contracts - r.leg1Size;
      if (m && fin(m.grossUsd) && fin(pv) && pv > 0 && fin(r.tp1Pts) && run > 0) { R.runnerPtsSum += (m.grossUsd / pv - r.leg1Size * r.tp1Pts) / run; R.runnerPtsN++; }
    }
    if (m && fin(m.netUsd)) {
      const T = a.totals[s]; T.trades++; if (m.netUsd > 0) T.wins++; if (m.exitReason === 'STOP') T.fullStops++;
      T.netUsd += m.netUsd; if (fin(m.grossUsd)) T.grossUsd += m.grossUsd; T.contracts += fin(m.contracts) && m.contracts > 0 ? m.contracts : r.contracts;
    } else if (r.moneyGivenUp) a.moneyMissing++;
  }
  // edge r1.4 (D1): TP1 touched / filled. An unresolved record (a price gap, or first seen after its fill) is counted as such, never guessed.
  const t1 = r.tp1t;
  if (t1 && closed && t1.state !== 'watching' && a.t1) {
    const A = a.t1; A.n++;
    if (t1.state === 'unresolved') A.unresolved++;
    else {
      const touched = t1.touchedAt != null; if (touched) A.touched++; if (t1.filled) A.filled++;
      if (touched && t1.filled) A.touchedFilled++; else if (!touched && t1.filled) A.filledUntouched++; else if (!touched) A.neither++;
      else {   // touched, not filled
        A.touchedNotFilled++;
        if (m && fin(m.netUsd)) { A.tnfNetKnown++; A.tnfNetUsd += m.netUsd; if (m.exitReason === 'STOP') A.tnfFullStops++; } else if (r.moneyGivenUp) A.tnfMoneyMissing++;
      }
    }
  }
  // edge r1.4 (D2): NY trades by fill time against the cut. Counted like the session totals (money known), or as moneyMissing once given up.
  if (closed && s === 'ny' && a.ny && !r.cont) {
    const at = fin(r.fillAt) ? r.fillAt : r.seenAt, hm = fin(at) ? ptHm(at) : null;
    if (hm) {
      const N = hm.min >= NY_LATE_CUT_MIN ? a.ny.late : a.ny.early;
      if (m && fin(m.netUsd)) { N.trades++; if (m.netUsd > 0) N.wins++; if (m.exitReason === 'STOP') N.fullStops++; N.netUsd += m.netUsd; if (fin(m.grossUsd)) N.grossUsd += m.grossUsd; N.contracts += fin(m.contracts) && m.contracts > 0 ? m.contracts : r.contracts; }
      else if (r.moneyGivenUp) N.moneyMissing++;
    }
  }
  // edge r1.4: the old runner rule shadow. compared = resolved, TP1 reached and the broker money known: old rule points per contract against the live trade's.
  const rs = r.rs;
  if (rs && a.rs && a.rs[rs.rule]) {
    const A = a.rs[rs.rule]; A.n++;
    if (rs.state === 'pending') A.pending++;
    else if (rs.state === 'unresolved') A.unresolved++;
    else if (rs.state === 'resolved') {
      A.resolved++;
      if (rs.exit === 'same') A.tp1NotReached++;
      else if (closed && m && fin(m.grossUsd) && fin(pv) && pv > 0 && r.contracts > 0 && fin(rs.oldPts)) { A.compared++; A.oldPtsSum += rs.oldPts; A.livePtsSum += m.grossUsd / (pv * r.contracts); }
    }
  }
  // tp1 ATR shadow
  const t = r.tp1s;
  if (t) {
    const A = a.tp1s; A.n++;
    if (t.state === 'pending') A.pending++;
    else if (t.state === 'unresolved') A.unresolved++;
    else if (t.state === 'resolved') {
      A.resolved++;
      if (t.plain === 'tp1') A.pTp1++; else A.pStop++;
      if (t.be === 'tp1') A.bTp1++; else if (t.be === 'stop') A.bStop++; else A.bBe++;
      if (closed && m && fin(m.netUsd) && fin(pv)) {
        const n = r.contracts, usd = o => (o === 'tp1' ? t.pts : o === 'stop' ? -r.stopPts : 0) * pv * n - cost * n;
        A.plainUsd += usd(t.plain); A.beUsd += usd(t.be); A.liveUsd += m.netUsd;
        if (t.plain === 'stop' && m.exitReason !== 'STOP') A.extraPlain++;
        if (t.be === 'stop' && m.exitReason !== 'STOP') A.extraBe++;
      } else if (closed && r.moneyGivenUp) A.liveMissing++;
    }
  }
  return a;
}
function viewOf(agg, ctx) {
  const pv = ctx.pointValue, a = agg;
  const runner = {}, totals = {}; const all = { trades: 0, wins: 0, fullStops: 0, netUsd: 0, grossUsd: 0, contracts: 0 };
  for (const s of SESSIONS) {
    const R = a.runner[s], T = a.totals[s];
    runner[s] = { trades: R.trades, tp1Hits: R.tp1Hits, allAtTp1Count: R.allAtTp1Count, atrRunner: { n: R.n, tp2Hits: R.tp2Hits, stoppedAtPlus2: R.stoppedAtPlus2, sessionClosed: R.sessionClosed, other: R.other,
      runnerNetUsd: r2(R.runnerNetUsd), reached30BeforeEntry: R.reached30, avgRunnerPts: R.runnerPtsN ? r2(R.runnerPtsSum / R.runnerPtsN) : null } };
    totals[s] = { trades: T.trades, wins: T.wins, fullStops: T.fullStops, netUsd: r2(T.netUsd), ptsPerContract: T.contracts > 0 && fin(pv) && pv > 0 ? r2(T.grossUsd / (pv * T.contracts)) : null };
    for (const k of Object.keys(all)) all[k] += T[k];
  }
  totals.all = { trades: all.trades, wins: all.wins, fullStops: all.fullStops, netUsd: r2(all.netUsd), ptsPerContract: all.contracts > 0 && fin(pv) && pv > 0 ? r2(all.grossUsd / (pv * all.contracts)) : null };
  const t = a.tp1s;
  return {
    earlyExit: { fired: a.eae.fired, passed: a.eae.passed, unassessed: a.eae.unassessed, logWouldExit: a.eae.logWouldExit, firedNetUsd: r2(a.eae.firedNetUsd),
      shadow: { wouldHaveHitStop: a.eae.stop, wouldHaveHitTp1: a.eae.tp1, unresolved: a.eae.unresolved, pending: a.eae.pending }, estSavedUsd: r2(a.eae.estSavedUsd),
      // edge r1.2: points per contract. exit = what the fired exits actually made (broker gross; negative = lost); shadow = where the untouched plan ended (-stop or +TP1)
      pts: { exit: { n: a.eae.firedPtsN, sum: r2(a.eae.firedPtsSum), avg: a.eae.firedPtsN > 0 ? r2(a.eae.firedPtsSum / a.eae.firedPtsN) : null },
        shadow: { n: a.eae.shadowPtsN, sum: r2(a.eae.shadowPtsSum), avg: a.eae.shadowPtsN > 0 ? r2(a.eae.shadowPtsSum / a.eae.shadowPtsN) : null } } },
    runner,
    tp1AtrShadow: ctx.tp1Mode === 'log' ? { mode: 'log', n: t.n, resolved: t.resolved, unresolved: t.unresolved, pending: t.pending,
      shadowNetUsd: { plain: r2(t.plainUsd), beAfter15: r2(t.beUsd) }, liveNetUsd: r2(t.liveUsd), liveNetUsdMissing: t.liveMissing,
      extraFullStops: { plain: t.extraPlain, beAfter15: t.extraBe }, outcomes: { plain: { tp1: t.pTp1, stop: t.pStop }, beAfter15: { tp1: t.bTp1, stop: t.bStop, breakeven: t.bBe } } } : { mode: 'off' },
    totals,
    moneyMissing: a.moneyMissing,
    // edge r1.4 (D1): trades with a resting TP1 whose price reached TP1. notTouched / filledUntouched are what the polled prices (1m bars + the poll price) showed;
    // the minute of the close is not counted. touchedNotFilled = the price reached TP1 but the order did not fill: how many ended in a full stop and their summed net.
    tp1Touch: (() => { const T = a.t1 || emptyT1(); return { n: T.n, unresolved: T.unresolved, touched: T.touched, filled: T.filled, touchedFilled: T.touchedFilled, touchedNotFilled: T.touchedNotFilled, filledUntouched: T.filledUntouched, neither: T.neither,
      touchedNotFilledFullStops: T.tnfFullStops, touchedNotFilledNetUsd: r2(T.tnfNetUsd), touchedNotFilledNetKnown: T.tnfNetKnown, touchedNotFilledMoneyMissing: T.tnfMoneyMissing }; })(),
    // edge r1.4 (D2): NY trades by fill time: at or after cutPt = late. Record only; nothing is skipped.
    nyLate: (() => { const one = N => ({ trades: N.trades, wins: N.wins, fullStops: N.fullStops, netUsd: r2(N.netUsd), ptsPerContract: N.contracts > 0 && fin(pv) && pv > 0 ? r2(N.grossUsd / (pv * N.contracts)) : null, moneyMissing: N.moneyMissing });
      const n = a.ny || { late: emptyNy(), early: emptyNy() }; return { cutPt: NY_LATE_CUT_PT, late: one(n.late), early: one(n.early) }; })(),
    // edge r1.4: per live rule. oldMinusLivePtsPerContract = what the old runner rule would have made minus what the live trade made (broker gross), in points
    // per contract of the whole trade, averaged over `compared` trades; positive = the old rule would have paid more.
    runnerShadow: Object.fromEntries(RS_RULES.map(k => { const A = (a.rs && a.rs[k]) || emptyRs(); return [k, { n: A.n, resolved: A.resolved, unresolved: A.unresolved, pending: A.pending, tp1NotReached: A.tp1NotReached, compared: A.compared,
      oldPtsPerContract: A.compared ? r2(A.oldPtsSum / A.compared) : null, livePtsPerContract: A.compared ? r2(A.livePtsSum / A.compared) : null, oldMinusLivePtsPerContract: A.compared ? r2((A.oldPtsSum - A.livePtsSum) / A.compared) : null }]; })),
  };
}

// ---- the price observations of one poll for one watcher: completed 1m bars it has not counted (high / low) + the poll price ----
// w: { barFrom (first bar start it may use), lastBarT, lastSeenAt }. Returns [{ hi, lo }] and updates w. Bars that began before barFrom are never used
// (their range includes prices from before the watch started).
function observations(w, now, price, bars) {
  const out = [];
  for (const b of (Array.isArray(bars) ? bars : []).filter(x => x && fin(x.t) && fin(x.h) && fin(x.l) && x.t % M1 === 0).sort((x, y) => x.t - y.t)) {
    if (b.t < w.barFrom || b.t + M1 > now || (fin(w.lastBarT) && b.t <= w.lastBarT)) continue;
    out.push({ hi: b.h, lo: b.l, t: b.t, src: 'bar1m' }); w.lastBarT = b.t;   // edge r1.4: t / src for the TP1 touch counter (the other watchers ignore them)
  }
  if (fin(price)) out.push({ hi: price, lo: price, t: now, src: 'poll' });
  return out;
}

function createScorecard(opts) {
  const fs = opts.fs || require('fs'), file = opts.file || null, nowFn = opts.now || Date.now;
  const journal = r => { try { if (opts.journal) opts.journal(r); } catch (e) { /* journal only */ } };
  const log = m => { try { if (opts.log) opts.log(m); } catch (e) { /* log only */ } };
  const tp1Cfg = opts.tp1AtrShadow && opts.tp1AtrShadow.mode === 'log' && validateTp1Shadow(opts.tp1AtrShadow).length === 0 ? { ...opts.tp1AtrShadow } : null;
  const oldRunner = opts.runnerOld && fin(opts.runnerOld.lockPts) && opts.runnerOld.lockPts >= 0 && fin(opts.runnerOld.stepPts) && opts.runnerOld.stepPts > 0 ? { lockPts: opts.runnerOld.lockPts, stepPts: opts.runnerOld.stepPts } : null;   // edge r1.4: the old runner rule's numbers (CONFIG.scaleOutRunner); null = no old-runner shadow
  const ctx = { pointValue: opts.pointValue, costPerContractRoundTrip: opts.costPerContractRoundTrip || 0, tp1Mode: tp1Cfg ? 'log' : 'off' };
  const eaeMode = () => { try { return typeof opts.eaeMode === 'function' ? opts.eaeMode() : opts.eaeMode; } catch (e) { return null; } };
  let st = null, dirty = false, lastSave = 0, loadInfo = null;
  const facts = new Map();   // journalId -> rule facts from the journal (seeded from the file at startup, then live)

  const fresh = t => ({ version: VERSION, since: t, updatedAt: t, agg: emptyAgg(), recs: [], emitted: [] });
  function load() {
    const t = nowFn(); let why = null;
    try {
      if (file && fs.existsSync(file)) {
        const o = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!o || typeof o !== 'object' || o.version !== VERSION || !fin(o.since) || !o.agg || !Array.isArray(o.recs)) why = 'the file does not have the scorecard shape';
        else {
          const base = emptyAgg();   // every counter must be a finite number, or the file is not trusted
          if (o.agg.eae && typeof o.agg.eae === 'object') for (const k of EAE_PTS_KEYS) if (o.agg.eae[k] === undefined) o.agg.eae[k] = 0;
          if (o.agg.t1 === undefined) o.agg.t1 = base.t1; if (o.agg.ny === undefined) o.agg.ny = base.ny;   // edge r1.4: a file from edge r1.3 or earlier has no TP1-touch / NY-late counters yet
          if (o.agg.rs === undefined) o.agg.rs = base.rs;   // edge r1.4: a file from edge r1.3 or earlier has no old-runner shadow counters yet (never thrown away for that)   // edge r1.2: a file from edge r1.1 has no points counters yet
          const okNum = (x, y) => Object.keys(y).every(k => (typeof y[k] === 'object' ? x && typeof x[k] === 'object' && okNum(x[k], y[k]) : x && fin(x[k])));
          if (!okNum(o.agg, base)) why = 'a counter is missing or not a number';
          else if (!o.recs.every(r => r && typeof r === 'object' && typeof r.id === 'string' && (r.dir === 1 || r.dir === -1) && fin(r.entry))) why = 'a trade record is malformed';
          else { st = { version: VERSION, since: o.since, updatedAt: fin(o.updatedAt) ? o.updatedAt : t, agg: o.agg, recs: o.recs.slice(-50), emitted: Array.isArray(o.emitted) ? o.emitted.filter(x => typeof x === 'string').slice(-600) : [] };   // edge r1.4: the record-only rows already written (see emitOnce)
            if (!tp1Cfg) for (const r of st.recs) if (r.tp1s && r.tp1s.state === 'pending') { r.tp1s = null; dirty = true; }
            if (!oldRunner) for (const r of st.recs) if (r.rs && r.rs.state === 'pending') { r.rs = null; dirty = true; }   // edge r1.4: no old rule to follow (scale-out off): nothing is carried on   // mode off: no TP1 shadow is carried on
            loadInfo = { fresh: false, corrupt: false }; return loadInfo; }
        }
      }
    } catch (e) { why = String(e && e.message || e).slice(0, 160); }
    st = fresh(t); dirty = true;
    if (why) {
      let kept = null;
      try { kept = `${file}.corrupt-${t}`; fs.renameSync(file, kept); } catch (e) { kept = null; }
      log(`  [score] the scorecard file could not be used (${why}) - starting a new scorecard from now${kept ? '; the old file is kept beside it' : ''}.`);
      journal({ type: 'scorecard_state', t, event: 'corrupt-file-replaced', why, since: t });
    }
    loadInfo = { fresh: true, corrupt: !!why, why };
    save(true);
    return loadInfo;
  }
  function save(force) {
    if (!file || !st || !dirty) return false;
    const t = nowFn();
    try {
      st.updatedAt = t;
      const tmp = `${file}.${process.pid}.tmp`;
      try { fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, file); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ } throw e; }
      dirty = false; lastSave = t; return true;
    } catch (e) { log('  [score] scorecard save failed (non-fatal, retried): ' + (e && e.message)); return false; }
  }

  // edge r1.4: every record-only row added by r1.4 (runner_shadow, tp1_touch, ny_late_trade) goes out through here: ONE row per (type, journalId), idempotent across a kill
  // at any point. ORDER: the key is persisted in the state file FIRST (synchronous, tmp + rename), the row is appended SECOND. A kill between the two loses that one
  // record-only row (the restart sees the key and writes nothing); it can never write it twice. If the state cannot be saved the row is not written (returns
  // 'failed' and the caller tries again later where it can). A row without a journalId is never written.
  function emitOnce(row) {
    if (!st || !row || typeof row.journalId !== 'string' || !row.journalId) return 'noid';
    const key = `${row.type}|${row.journalId}`;
    if (st.emitted.includes(key)) return 'dup';
    st.emitted.push(key); if (st.emitted.length > 600) st.emitted.splice(0, st.emitted.length - 600); dirty = true;
    if (file && !save(true)) { st.emitted.pop(); return 'failed'; }
    journal(row); return 'ok';
  }

  // ---- rule facts from journal rows (display + the scorecard's early-exit class) ----
  function indexJournal(e) {
    try {
      if (!e || typeof e !== 'object' || typeof e.journalId !== 'string' || !e.journalId) return;
      const ty = e.type;
      if (ty !== 'runner_rule' && ty !== 'early_adverse_exit' && ty !== 'early_adverse_check' && ty !== 'tp1_atr_shadow' && !(ty === 'trade_manage' && (e.code === 'EARLY_ADVERSE_ABANDONED' || e.code === 'TP1_FILLED'))) return;
      let f = facts.get(e.journalId);
      if (!f) { f = {}; facts.set(e.journalId, f); while (facts.size > 400) facts.delete(facts.keys().next().value); }
      if (ty === 'runner_rule') { f.runnerMode = e.mode; if (fin(e.atr15)) f.atr15 = e.atr15; f.tp2 = fin(e.tp2) ? e.tp2 : null; if (e.session) f.session = e.session;
        f.stopPts = fin(e.stopPts) ? e.stopPts : null; f.tp2AtrMult = fin(e.tp2AtrMult) ? e.tp2AtrMult : null; }   // edge r1.2: the rule numbers THIS trade got
      else if (ty === 'tp1_atr_shadow') { if (e.phase === 'open' && fin(e.atr15) && !fin(f.atr15)) f.atr15 = e.atr15; }
      else if (ty === 'early_adverse_exit' && (e.result === 'expired' || e.decision === 'expired')) { f.eae = 'unassessed'; f.eaeAbandoned = true; f.eaeExpired = true; }   // edge r1.1 (S2): decided, never sent, expired - the rule did not act on this trade
      else if (ty === 'early_adverse_exit') { f.eae = e.decision === 'exit' ? 'fired' : 'log-would-exit'; f.eaeAt = fin(e.closeAt) ? e.closeAt : null; f.eaePts = fin(e.pts) ? e.pts : null; f.eaeDecidedAt = fin(e.t) ? e.t : null;
        f.eaeStop = fin(e.stop) ? e.stop : null; f.eaeTp1 = fin(e.tp1) ? e.tp1 : null; f.eaeStopPts = fin(e.stopPts) ? e.stopPts : null; f.eaeTp1Pts = fin(e.tp1Pts) ? e.tp1Pts : null; }
      else if (ty === 'early_adverse_check') { if (!f.eae) { f.eae = e.decision === 'keep' ? 'passed' : 'unassessed'; f.eaeAt = e.decision === 'keep' && fin(e.closeAt) ? e.closeAt : null; f.eaePts = e.decision === 'keep' && fin(e.pts) ? e.pts : null; } }
      else if (e.code === 'TP1_FILLED') { f.tp1Filled = true; if (!fin(f.tp1FilledAt) && fin(e.t)) f.tp1FilledAt = e.t; }   // edge r1.4: the fact the old-runner shadow starts from when the polled prices did not show the touch
      else if (f.eae === 'fired') { f.eae = 'passed'; f.eaeAbandoned = true; }   // EARLY_ADVERSE_ABANDONED: TP1 filled before the exit was sent
    } catch (err) { /* display only */ }
  }
  // The per-trade `rule` object of the snapshot. closed: the trade is over (no row can still arrive).
  function ruleOf(journalId, closed) {
    if (typeof journalId !== 'string' || !journalId) return { runnerMode: null, atr15AtFill: null, tp2Price: null, earlyExit: null, earlyExitAt: null, earlyExitPts: null, session: null, stopPts: null, tp2AtrMult: null };
    const f = facts.get(journalId) || {}, mode = eaeMode();
    // edge r1.2: session = the session of the fill (the runner_rule row, else the scorecard's own record of the trade); stopPts / tp2AtrMult = the ATR runner's numbers this trade got
    let sess = SESSIONS.includes(f.session) ? f.session : null;
    if (!sess && st) { const rec = st.recs.find(x => x.jid === journalId); if (rec && SESSIONS.includes(rec.session)) sess = rec.session; }
    const ee = f.eae || (mode === 'off' ? 'off' : closed ? 'unassessed' : null);
    const rm = f.runnerMode || 'live';
    return { runnerMode: rm, atr15AtFill: fin(f.atr15) ? f.atr15 : null, tp2Price: rm === 'atrTarget' && fin(f.tp2) ? f.tp2 : null, earlyExit: ee,
      earlyExitAt: (ee === 'fired' || ee === 'passed' || ee === 'log-would-exit') && fin(f.eaeAt) ? f.eaeAt : null, earlyExitPts: (ee === 'fired' || ee === 'passed' || ee === 'log-would-exit') && fin(f.eaePts) ? f.eaePts : null,
      session: sess, stopPts: rm === 'atrTarget' && fin(f.stopPts) ? f.stopPts : null, tp2AtrMult: rm === 'atrTarget' && fin(f.tp2AtrMult) ? f.tp2AtrMult : null };
  }

  // ---- shadows ----
  function stepEaeShadow(r, now, obs, otherTradeOpen) {
    const s = r.eaeShadow; if (!s || s.state !== 'pending') return;
    const done = (state, why) => {
      s.state = state; s.why = why || null; s.resolvedAt = now; dirty = true;
      journal({ type: 'early_adverse_shadow', t: now, journalId: r.jid, dir: r.dir, fill: r.entry, contracts: r.contracts, decidedAt: s.startedAt, exitPts: s.exitPts ?? null, stop: s.stop, tp1: s.tp1, stopPts: s.stopPts, tp1Pts: s.tp1Pts,
        result: state === 'stop' ? 'wouldHaveHitStop' : state === 'tp1' ? 'wouldHaveHitTp1' : 'unresolved', why: why || null, minutes: r2((now - s.startedAt) / M1), watchMin: EAE_SHADOW_MS / M1,
        note: 'price from the polls the bot already makes (completed 1m bars after the decision + the poll price); the stop wins a bar that touches both; record only, no order' });
    };
    if (otherTradeOpen) return done('unresolved', 'another trade opened');
    if (fin(s.lastSeenAt) && now - s.lastSeenAt > PRICE_GAP_MS) return done('unresolved', `no price for ${Math.round((now - s.lastSeenAt) / 1000)} s`);
    for (const o of obs) {
      const lo = Math.min(r.dir * (o.hi - r.entry), r.dir * (o.lo - r.entry)), hi = Math.max(r.dir * (o.hi - r.entry), r.dir * (o.lo - r.entry));
      if (lo <= -s.stopPts) return done('stop'); if (hi >= s.tp1Pts) return done('tp1');
    }
    if (obs.length) { if (!fin(s.lastSeenAt) || now - s.lastSeenAt >= SAVE_EVERY_MS) dirty = true; s.lastSeenAt = now; }
    if (now - s.startedAt >= EAE_SHADOW_MS) return done('unresolved', '30 minutes passed with neither level touched');
  }
  function stepTp1Shadow(r, now, obs, otherTradeOpen) {
    const t = r.tp1s; if (!t || t.state !== 'pending') return;
    const end = (state, why) => { t.state = state; t.why = why || null; t.resolvedAt = now; dirty = true; };
    if (otherTradeOpen) return end('unresolved', 'another trade opened');
    if (fin(t.lastSeenAt) && now - t.lastSeenAt > PRICE_GAP_MS) return end('unresolved', `no price for ${Math.round((now - t.lastSeenAt) / 1000)} s`);
    for (const o of obs) {
      const a = r.dir * (o.hi - r.entry), b = r.dir * (o.lo - r.entry), lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi > (t.best ?? -Infinity)) { t.best = r2(hi); }
      if (!t.plain) { if (lo <= -r.stopPts) { t.plain = 'stop'; t.plainAt = now; dirty = true; } else if (hi >= t.pts) { t.plain = 'tp1'; t.plainAt = now; dirty = true; } }
      if (!t.be) {
        if (!t.seenBe) { if (lo <= -r.stopPts) t.be = 'stop'; else if (hi >= t.pts) t.be = 'tp1'; else if (hi >= t.beAfterPts) { t.seenBe = true; t.seenBeAt = now; dirty = true; } }   // the move to entry applies from the NEXT observation
        else if (lo <= 0) t.be = 'breakeven'; else if (hi >= t.pts) t.be = 'tp1';
        if (t.be) { t.beAt = now; dirty = true; }
      }
      if (t.plain && t.be) return end('resolved');
    }
    if (obs.length) { if (!fin(t.lastSeenAt) || now - t.lastSeenAt >= SAVE_EVERY_MS) dirty = true; t.lastSeenAt = now; }
    if (now >= t.deadline) return end('unresolved', t.deadlineWhy);
  }
  // edge r1.4: one step of the old runner rule shadow (see the header). r.rs: { state, rule, phase 'pre' | 'run', lockPts, stepPts, peak, closeAt, deadline, ... }.
  function stepRunnerShadow(r, now, obs, price, otherTradeOpen) {
    const s = r.rs; if (!s || s.state !== 'pending') return;
    const pv = ctx.pointValue, cost = ctx.costPerContractRoundTrip, n = r.contracts;
    const end = (state, exit, runnerPts, why) => {
      s.state = state; s.exit = exit; s.why = why || null; s.resolvedAt = now; dirty = true;
      const res = state === 'resolved';
      s.runnerPts = res && fin(runnerPts) ? r2(runnerPts) : null;
      // the old rule's whole trade in points per contract: (n - 1) contracts at TP1 + the one runner. 'same' = TP1 never reached: the two rules are the same trade.
      s.oldPts = res && exit !== 'same' && fin(s.runnerPts) ? r2(((n - 1) * r.tp1Pts + s.runnerPts) / n) : null;
      const usd = fin(s.oldPts) && fin(pv) ? r2(s.oldPts * n * pv - cost * n) : null;
      emitOnce({ type: 'runner_shadow', t: now, journalId: r.jid, session: r.session, rule: s.rule, oldRuleExit: res ? exit : null, oldRulePts: s.oldPts, oldRuleUsdEst: usd, resolved: res, why: s.why,
        dir: r.dir, fill: r.entry, contracts: n, tp1Pts: r.tp1Pts, oldRunnerPts: s.runnerPts, bestPtsSeen: s.peak ?? null, armedAt: s.armedAt ?? null, armedBy: s.armedBy ?? null, minutes: fin(r.fillAt) ? r2((now - r.fillAt) / M1) : null,
        overlap: s.overlap === true, lockPts: s.lockPts, stepPts: s.stepPts,
        note: 'record only, no order: the old runner rule (all but 1 contract out at TP1, the runner stop +lockPts then lockPts behind the best price in stepPts steps, flat at the session close) on the polled prices (completed 1m bars + the poll price); the stop wins a bar that touches both; oldRulePts = points per contract of the whole trade; the estimate takes the configured round-trip cost and no slippage' });
    };
    if (fin(s.lastSeenAt) && now - s.lastSeenAt > PRICE_GAP_MS) return end('unresolved', null, null, `no price for ${Math.round((now - s.lastSeenAt) / 1000)} s`);
    if (otherTradeOpen && s.phase === 'run' && !s.overlap) { s.overlap = true; dirty = true; }   // the old rule would still hold its runner while the bot took another trade
    const f = r.jid ? facts.get(r.jid) : null;
    for (const o of obs) {
      const a = r.dir * (o.hi - r.entry), b = r.dir * (o.lo - r.entry), lo = Math.min(a, b), hi = Math.max(a, b);
      if (s.phase === 'pre') { if (hi >= r.tp1Pts) { s.phase = 'run'; s.armedAt = now; s.armedBy = 'price'; s.peak = r2(Math.max(hi, r.tp1Pts)); dirty = true; } }   // the runner's stop applies from the NEXT observation
      else {
        const off = runnerTrailOffset(s.peak, s);
        if (lo <= off) return end('resolved', 'runner_stop', off);
        if (hi > s.peak) { s.peak = r2(hi); dirty = true; }
      }
    }
    if (s.phase === 'pre' && ((f && f.tp1Filled) || r.tp1Hit)) { s.phase = 'run'; s.armedAt = now; s.armedBy = 'fill'; s.peak = r.tp1Pts; dirty = true; }   // TP1 filled (the bot's own fact) though the polled prices did not show it
    if (obs.length) { if (!fin(s.lastSeenAt) || now - s.lastSeenAt >= SAVE_EVERY_MS) dirty = true; s.lastSeenAt = now; }
    if (s.phase === 'pre' && !r.open && fin(r.closedAt) && now - r.closedAt >= RS_SAME_WAIT_MS) return end('resolved', 'same', null, 'the trade ended without reaching TP1: the old rule and the live rule are the same trade');
    if (s.phase === 'run' && fin(s.closeAt) && now >= s.closeAt) return fin(price) ? end('resolved', 'session_close', r.dir * (price - r.entry)) : end('unresolved', null, null, 'the session closed with no price');
    if (now >= s.deadline) return end('unresolved', null, null, `${RS_MAX_MS / M1} minutes passed${s.phase === 'run' ? ' with the old runner still open' : ''}`);
  }
  // edge r1.4 (D1): one step of the TP1 touch watch. While the trade is open the poll price and the completed 1m bars count; on the poll that finds the trade closed
  // only completed bars count (the poll price after the close is not the trade's price), and the watch ends.
  function stepTp1Touch(r, now, price, bars) {
    const w = r.tp1t; if (!w || w.state !== 'watching') return;
    const open = r.open === true;
    if (open && w.touchedAt == null && fin(w.lastSeenAt) && now - w.lastSeenAt > PRICE_GAP_MS) { w.state = 'unresolved'; w.why = `no price for ${Math.round((now - w.lastSeenAt) / 1000)} s before the price was seen at TP1`; dirty = true; return finishTp1Touch(r, now); }
    const obs = observations(w, now, open ? price : null, bars);
    for (const o of obs) {
      const hi = Math.max(r.dir * (o.hi - r.entry), r.dir * (o.lo - r.entry));
      if (w.touchedAt == null && hi >= r.tp1Pts - 1e-9) { w.touchedAt = o.src === 'bar1m' ? o.t : now; w.touchSource = o.src; dirty = true; break; }
    }
    if (open && obs.length) { if (!fin(w.lastSeenAt) || now - w.lastSeenAt >= SAVE_EVERY_MS) dirty = true; w.lastSeenAt = now; }
    if (!open) finishTp1Touch(r, now);
  }
  function finishTp1Touch(r, now) {
    const w = r.tp1t; if (!w) return;
    const f = r.jid ? facts.get(r.jid) : null;
    w.filled = !!(f && f.tp1Filled) || !!r.tp1Hit; w.filledAt = f && fin(f.tp1FilledAt) ? f.tp1FilledAt : null;
    if (w.state === 'watching') w.state = 'resolved';
    w.resolvedAt = now; dirty = true;
  }
  function tp1TouchRow(r, now) {
    const w = r.tp1t, m = r.money || null, pv = ctx.pointValue;
    return { type: 'tp1_touch', t: now, journalId: r.jid, session: r.session, dir: r.dir, fill: r.entry, contracts: r.contracts, tp1Price: fin(r.tp1) ? r.tp1 : null, tp1Pts: r.tp1Pts,
      touchedAt: w.touchedAt ?? null, touchSource: w.touchSource ?? null, touchResolution: w.touchSource === 'bar1m' ? '1m bar (touchedAt = the bar start; the price reached TP1 within that minute)' : w.touchSource === 'poll' ? 'poll price (the bot\'s own read at touchedAt)' : null,
      filled: w.filled === true ? true : w.filled === false ? false : null, filledAt: w.filledAt ?? null, maxFavorablePts: fin(r.best) ? r.best : null,
      exitReason: m ? m.exitReason : null, netUsd: m && fin(m.netUsd) ? m.netUsd : null, state: w.state, why: w.why || null, touchedNotFilled: w.state === 'resolved' && w.touchedAt != null && w.filled === false,
      note: 'record only, no order: whether the polled prices (completed 1m bars and the poll price while the trade was open) reached the TP1 price, and whether the TP1 order filled; the minute of the close is not counted; unresolved = never guessed' };
  }
  function nyLateRow(r, now) {
    const at = fin(r.fillAt) ? r.fillAt : r.seenAt, hm = fin(at) ? ptHm(at) : null; if (!hm || hm.min < NY_LATE_CUT_MIN || r.session !== 'ny' || r.cont || !r.jid) return null;
    const m = r.money || null;
    return { type: 'ny_late_trade', t: now, journalId: r.jid, session: 'ny', dir: r.dir, contracts: r.contracts, entryAt: at, entryPt: hm.text, cutPt: NY_LATE_CUT_PT, moneyKnown: !!(m && fin(m.netUsd)),
      netUsd: m && fin(m.netUsd) ? m.netUsd : null, grossUsd: m && fin(m.grossUsd) ? m.grossUsd : null, exitReason: m ? m.exitReason : null, fullStop: !!(m && m.exitReason === 'STOP'), note: 'record only: a NY trade filled at or after the cut; nothing is skipped' };
  }
  function tp1Row(r, phase, now) {
    const t = r.tp1s, m = r.money || null, n = r.contracts, pv = ctx.pointValue, cost = ctx.costPerContractRoundTrip;
    const usd = o => (o && fin(pv) ? r2((o === 'tp1' ? t.pts : o === 'stop' ? -r.stopPts : 0) * pv * n - cost * n) : null);
    const base = { type: 'tp1_atr_shadow', t: now, phase, journalId: r.jid, dir: r.dir, fill: r.entry, fillSeenAt: r.fillAt, contracts: n, session: r.session, atr15: r.atr15, shadowTp1Pts: t.pts, shadowTp1: r2(r.entry + r.dir * t.pts),
      liveTp1Pts: r.tp1Pts, stop: r.stop, stopPts: r.stopPts, beAfterPts: t.beAfterPts, atrMult: t.atrMult, deadline: t.deadline };
    if (phase === 'open') return { ...base, note: 'record only: what an ATR-sized TP1 would have done on this trade; no order is placed or changed' };
    return { ...base, state: t.state, why: t.why || null, resolvedAt: t.resolvedAt ?? null, bestPtsSeen: t.best ?? null,
      shadow: { plain: t.plain || null, beAfter: t.be || null, plainNetUsd: t.state === 'resolved' ? usd(t.plain) : null, beAfterNetUsd: t.state === 'resolved' ? usd(t.be) : null, model: 'all contracts leave at the outcome, minus the configured round-trip cost; no runner modelled' },
      live: { closedAt: r.closedAt ?? null, exitReason: m ? m.exitReason : null, netUsd: m && fin(m.netUsd) ? m.netUsd : null, grossUsd: m && fin(m.grossUsd) ? m.grossUsd : null, tp1Hit: !!r.tp1Hit, earlyExit: r.eae ?? null, runnerMode: r.runnerMode ?? null } };
  }

  // ---- the poll: trade = a read-only view of the open, filled trade or null; price / bars = what the poll already fetched ----
  // trade: { jid, dir, entry, contracts, leg1Size, stop, tp1, fillAt, phase, runnerMode, tp2, atr15, session, sessionCloseAt }
  function onPoll(p) {
    try {
      if (!st) return;
      const now = fin(p.now) ? p.now : nowFn(), tr = p.trade && (p.trade.dir === 1 || p.trade.dir === -1) && fin(p.trade.entry) ? p.trade : null;
      const id = tr ? String(tr.jid || `x|${tr.dir}|${tr.entry}|${fin(tr.fillAt) ? tr.fillAt : ''}`) : null;
      let cur = st.recs.find(r => r.open) || null;
      if (cur && (!tr || cur.id !== id)) closeRec(cur, now), cur = null;
      if (tr && !cur) {
        if (!st.recs.some(r => r.id === id)) {   // (a record with this id that is already closed: the same trade seen again after a glitch - never counted twice)
          const first = tr.phase === 'LEG1_OPEN' && fin(tr.stop) && fin(tr.tp1) && fin(tr.fillAt);   // seen from its fill: the stop and TP1 are the trade's own
          cur = { id, jid: tr.jid || null, dir: tr.dir, entry: tr.entry, contracts: tr.contracts, leg1Size: fin(tr.leg1Size) ? tr.leg1Size : null, stop: fin(tr.stop) ? tr.stop : null, tp1: fin(tr.tp1) ? tr.tp1 : null,
            stopPts: fin(tr.stop) ? r2(Math.abs(tr.entry - tr.stop)) : null, tp1Pts: fin(tr.tp1) ? r2(Math.abs(tr.tp1 - tr.entry)) : null, fillAt: fin(tr.fillAt) ? tr.fillAt : null, seenAt: now, session: tr.session || null,
            atr15: fin(tr.atr15) ? tr.atr15 : null, runnerMode: tr.runnerMode || 'live', tp2: fin(tr.tp2) ? tr.tp2 : null, open: true, closedAt: null, best: null, tp1Hit: false, eae: null, eaeShadow: null, tp1s: null, money: null };
          // edge r1.4: the same trade seen again under a new record id (a restart: the id carries the fill time, and an adopted position may have no journalId). The record
          // that was closed in THIS poll for that reason hands its watchers over, so a restart cannot end a shadow as "the trade ended" and cannot start a second one. Same
          // direction, entry within a tick, and a journalId that does not differ; it takes the old record's journalId when its own is unknown.
          const prev = st.recs.find(x => x !== cur && !x.open && x.closedAt === now && x.dir === cur.dir && fin(x.entry) && Math.abs(x.entry - cur.entry) < 0.26 && (!cur.jid || !x.jid || x.jid === cur.jid) && (x.rs || x.tp1t));
          if (prev) {
            cur.cont = true; if (!cur.jid && prev.jid) cur.jid = prev.jid;
            if (prev.rs && prev.rs.state === 'pending') { cur.rs = prev.rs; prev.rs = null; } if (prev.tp1t && prev.tp1t.state === 'watching') { cur.tp1t = prev.tp1t; prev.tp1t = null; }
            if (fin(prev.best) && !(cur.best >= prev.best)) cur.best = prev.best; if (prev.tp1Hit) cur.tp1Hit = true; dirty = true;
          }
          const pts = tp1Cfg && first && cur.stopPts > 0 ? shadowTp1Pts(cur.atr15, tp1Cfg) : null;
          if (pts != null) {
            const cap = cur.fillAt + TP1S_MAX_MS, sc = fin(tr.sessionCloseAt) && tr.sessionCloseAt > cur.fillAt ? tr.sessionCloseAt : null;
            cur.tp1s = { state: 'pending', pts, atrMult: tp1Cfg.atrMult, beAfterPts: tp1Cfg.beAfterPts, plain: null, be: null, seenBe: false, best: null, barFrom: Math.ceil((cur.fillAt + 1) / M1) * M1, lastBarT: null, lastSeenAt: null,
              deadline: sc != null && sc < cap ? sc : cap, deadlineWhy: sc != null && sc < cap ? 'the session closed' : '240 minutes passed' };
            journal(tp1Row(cur, 'open', now));
          }
          // edge r1.4 (D1): every trade with a resting TP1 limit is watched for the price reaching TP1 while it is open. A trade first seen after its fill
          // (restart, adopted) cannot say when the price first reached TP1: it is counted unresolved.
          if (!prev) {   // a continuation keeps the watchers it was handed (or none): a restart never starts a second shadow for the same trade
            const noJid = !(typeof cur.jid === 'string' && cur.jid);   // edge r1.4: a trade whose journalId is unknown is never shadowed (no row can name it): counted unresolved once, with why 'no journalId'
            if (fin(cur.tp1Pts) && cur.tp1Pts > 0) {
              cur.tp1t = noJid ? { state: 'unresolved', touchedAt: null, touchSource: null, filled: null, filledAt: null, why: 'no journalId' } : first ? { state: 'watching', touchedAt: null, touchSource: null, filled: null, filledAt: null, barFrom: Math.ceil((cur.fillAt + 1) / M1) * M1, lastBarT: null, lastSeenAt: now, why: null }
                : { state: 'unresolved', touchedAt: null, touchSource: null, filled: !!tr.phase && tr.phase !== 'LEG1_OPEN' && tr.phase !== 'FLATTENING' ? true : null, filledAt: null, why: 'the trade was first seen after its fill (a restart or an adopted position)' };
            }
            // edge r1.4: the old runner rule shadow, for a trade the session runner rule manages (2+ contracts: the old rule keeps exactly one runner)
            if (oldRunner && first && RS_RULES.includes(cur.runnerMode) && cur.contracts >= 2 && cur.tp1Pts > 0 && noJid) cur.rs = { state: 'unresolved', rule: cur.runnerMode, phase: 'pre', lockPts: oldRunner.lockPts, stepPts: oldRunner.stepPts, peak: null, why: 'no journalId' };
            else if (oldRunner && first && RS_RULES.includes(cur.runnerMode) && cur.contracts >= 2 && cur.tp1Pts > 0) {
              const sc = fin(tr.sessionCloseAt) && tr.sessionCloseAt > cur.fillAt ? tr.sessionCloseAt : null;
              cur.rs = { state: 'pending', rule: cur.runnerMode, phase: 'pre', lockPts: oldRunner.lockPts, stepPts: oldRunner.stepPts, peak: null, closeAt: sc, deadline: cur.fillAt + RS_MAX_MS,
                barFrom: Math.ceil((cur.fillAt + 1) / M1) * M1, lastBarT: null, lastSeenAt: null };
            }
          }
          st.recs.push(cur); dirty = true;
        }
      }
      if (cur && tr) {
        if (tr.phase && tr.phase !== 'LEG1_OPEN' && tr.phase !== 'FLATTENING' && !cur.tp1Hit) { cur.tp1Hit = true; dirty = true; }
        if (fin(p.price)) { const f = r2(cur.dir * (p.price - cur.entry)); if (!(cur.best >= f)) { cur.best = f; dirty = true; } }
        for (const b of Array.isArray(p.bars) ? p.bars : []) if (b && fin(b.t) && fin(b.h) && fin(b.l) && fin(cur.fillAt) && b.t > cur.fillAt) { const f = r2(cur.dir === 1 ? b.h - cur.entry : cur.entry - b.l); if (!(cur.best >= f)) { cur.best = f; dirty = true; } }
        const f = cur.jid ? facts.get(cur.jid) : null;
        if (f && f.eae === 'fired' && !cur.eaeShadow) {   // the early exit was decided this poll: start watching the original stop and TP1 from here
          const stop = fin(f.eaeStop) ? f.eaeStop : cur.stop, tp1 = fin(f.eaeTp1) ? f.eaeTp1 : cur.tp1;
          if (fin(stop) && fin(tp1)) { cur.eaeShadow = { state: 'pending', startedAt: now, stop, tp1, stopPts: r2(Math.abs(cur.entry - stop)), tp1Pts: r2(Math.abs(tp1 - cur.entry)), exitPts: f.eaePts ?? null, barFrom: Math.ceil((now + 1) / M1) * M1, lastBarT: null, lastSeenAt: now }; dirty = true; }
        } else if (cur.eaeShadow && f && f.eaeAbandoned) { cur.eaeShadow = null; dirty = true; }   // TP1 filled first: there was no early exit to shadow
      }
      for (const r of st.recs) {
        const other = !!cur && cur !== r;
        if (r.tp1t && r.tp1t.state === 'watching') stepTp1Touch(r, now, p.price, p.bars);   // edge r1.4 (D1)
        if (r.eaeShadow && r.eaeShadow.state === 'pending') stepEaeShadow(r, now, observations(r.eaeShadow, now, p.price, p.bars), other);
        if (r.tp1s && r.tp1s.state === 'pending') stepTp1Shadow(r, now, observations(r.tp1s, now, p.price, p.bars), other);
        if (r.rs && r.rs.state === 'pending') stepRunnerShadow(r, now, observations(r.rs, now, p.price, p.bars), p.price, other);   // edge r1.4
      }
      settle(now);
      if (dirty) save();
    } catch (e) { log('  [score] poll step failed (non-fatal): ' + (e && e.message)); }
  }
  function closeRec(r, now) {
    r.open = false; r.closedAt = now; dirty = true;
    const f = r.jid ? facts.get(r.jid) : null, mode = eaeMode();
    r.eae = f && f.eae ? f.eae : mode === 'off' || mode == null ? 'off' : 'unassessed';
    if (f && f.runnerMode) { r.runnerMode = f.runnerMode; if (fin(f.tp2)) r.tp2 = f.tp2; }
    if (r.eae !== 'fired' && r.eaeShadow) r.eaeShadow = null;
  }
  // Broker round trips the bot already read (closed ones, with a unique journal match): [{ journalId, grossUsd, netUsd, contracts, exitReason }]
  function onBrokerTrades(list, now = nowFn()) {
    try {
      if (!st || !Array.isArray(list)) return;
      for (const b of list) {
        if (!b || typeof b.journalId !== 'string' || !fin(b.netUsd)) continue;
        const r = st.recs.find(x => !x.open && !x.money && x.jid === b.journalId); if (!r) continue;
        r.money = { grossUsd: fin(b.grossUsd) ? b.grossUsd : null, netUsd: b.netUsd, contracts: fin(b.contracts) ? b.contracts : null, exitReason: typeof b.exitReason === 'string' ? b.exitReason : 'UNKNOWN' }; dirty = true;
      }
      settle(now);
      if (dirty) save();
    } catch (e) { log('  [score] broker-trade step failed (non-fatal): ' + (e && e.message)); }
  }
  // A record that waits for nothing more is folded into the permanent counters and dropped.
  function settle(now) {
    for (const r of st.recs.slice()) {
      if (r.open) continue;
      if (!r.money && !r.moneyGivenUp && now - r.closedAt > MONEY_WAIT_MS) { r.moneyGivenUp = true; dirty = true; }
      const waiting = (!r.money && !r.moneyGivenUp) || (r.eaeShadow && r.eaeShadow.state === 'pending') || (r.tp1s && r.tp1s.state === 'pending') || (r.rs && r.rs.state === 'pending');
      if (waiting) continue;
      if (r.tp1s) journal(tp1Row(r, 'resolve', now));
      // edge r1.4: the rows below persist their key before they are appended (emitOnce), and a record leaves st.recs the moment it is folded, so a state saved
      // inside emitOnce is always consistent: a record is either still in recs (not yet folded) or folded and gone, never both.
      if (r.tp1t && r.tp1t.state !== 'watching' && emitOnce(tp1TouchRow(r, now)) === 'failed') continue;   // D1: one row per trade
      { const nr = nyLateRow(r, now); if (nr && emitOnce(nr) === 'failed') continue; }   // D2
      fold(st.agg, r, ctx); st.recs.splice(st.recs.indexOf(r), 1); dirty = true;
    }
  }
  function view() {
    try {
      if (!st) return null;
      const a = JSON.parse(JSON.stringify(st.agg));
      for (const r of st.recs) fold(a, r, ctx);
      return { version: VERSION, since: st.since, updatedAt: st.updatedAt, openRecords: st.recs.length, ...viewOf(a, ctx) };
    } catch (e) { return null; }
  }
  return { load, save: () => save(true), indexJournal, ruleOf, onPoll, onBrokerTrades, view, since: () => (st ? st.since : null), _state: () => st, _facts: facts };
}

module.exports = { NY_LATE_CUT_PT, ptHm, RS_MAX_MS, RS_SAME_WAIT_MS, RS_RULES, runnerTrailOffset, VERSION, SESSIONS, TP1S_MODES, EAE_SHADOW_MS, TP1S_MAX_MS, PRICE_GAP_MS, MONEY_WAIT_MS, validateTp1Shadow, shadowTp1Pts, scoreLine, atr15Median, rulesView, emptyAgg, fold, viewOf, observations, createScorecard };
