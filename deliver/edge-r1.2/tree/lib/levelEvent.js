'use strict';
// lv1 LEVEL-EVENT TRIGGER (Mac 10/27, final directive: "entries are events at institutional levels - sweeps, reclaims, acceptance, failures ... NO LEVEL, NO TRADE").
// Pure: no I/O, no clock reads, no globals. Levels PRO (lib/levelsPro.js) only builds a plan for its single IN-PLAY level and only at grade B+; on 10/27 the NY-open
// reclaim (06:30 Open swept to 29,494 at 07:17, reclaimed 07:25-07:30, then +300 pts) never became a Levels PRO plan. This module adds that trigger, frozen:
//
// SWEEP-RECLAIM at a NAMED level L (long; short is the mirror), judged on COMPLETED bars of one trigger timeframe only:
//   (1) reclaim close : the NEWLY completed bar (complete by request time, see createTracker) closes ABOVE L and the bar before it closed AT/BELOW L;
//   (2) sweep         : over the bars SINCE PRICE LAST CLOSED ABOVE L (at most SWEEP_LOOKBACK, this bar included) some bar traded at least SWEEP_PTS below L;
//                       that run's low is the sweep extreme (an older, unrelated swing never sets the stop);
//   (3) board agrees  : for a Levels PRO board level, its behaviour on this bar points the same way on the trigger-TF board OR the 15m board (Levels PRO's
//                       labels differ by timeframe: 10/27 07:30 the NYO read CHOP on 5m and SWEEP DN on 15m) - SWEEP DN / FAIL DN / RECLAIM / ACCEPT+ / HOLD+
//                       long, mirror short. Weekly levels the board does not carry (PWO / PWC / WTD High / WTD Low) need (1)+(2) only.
//   The plan: MARKET at the reclaim close, stop SWEEP extreme -/+ STOP_BUF (the executor's stop floors then apply as for every entry), target = the next named
//   level beyond the entry at least MIN_TGT away (else entry +/- PROJ_PTS, flagged projected), grade 'B' (fixed: passes the plan grade gate, no MAC input).
// PERSISTENCE (the morning-hold rule): an event stays live while every later completed close stays on the reclaimed side of L, for at most PERSIST_MS (30 min
//   of bar time on every timeframe); a close back across L kills it for good. The executor's hold / blackout / no-chase gates decide whether a live event may be taken (a 06:50 event can be taken at 07:10
//   only if it is still live and price is within no-chase of the level).
// When several levels qualify on the same bar, the highest in Mac's HIERARCHY wins (weekly -> daily -> session -> period opens -> IB -> VWAP).
// Not in r1 (stated): 1H/4H battle-zone clusters as trigger levels (PO3 lib/po3.js zones are observe-only; a later revision may admit its frozen zones).
//
// r13 BREAK-RETEST (Mac 10/28 AM: "yes I want the break and retest entry path"; createTracker { retest: true }, off by default) at a FIXED named level L (long;
// short is the mirror), judged on the same completed bars, the same knowledge / contiguity / observation rules and the same persistence as a sweep:
//   (1) break      : inside RETEST_WINDOW_MS before the newly completed bar b, a contiguous known bar closed AT/BELOW L and the next bar closed ABOVE it (the break bar);
//   (2) acceptance : every close from the break bar to the bar before b is ABOVE L (one close back at/below = no break to retest);
//   (3) departure  : after the break, before b, some bar traded at least RETEST_AWAY above L;
//   (4) retest     : b is the FIRST bar after that departure to come back to L (its low at most RETEST_TOL above L; a wick through L counts) and b CLOSES at
//                    least RETEST_HOLD above L (it held);
//   (5) board      : for a board level, its labels (trigger TF + 15m) include an agreeing or neutral one (ACCEPT+ / HOLD+ / TESTING / RECLAIM / SWEEP DN / FAIL DN /
//                    support) and NO opposite label and no CHOP; weekly levels need (1)-(4) only.
//   The plan: MARKET at b's close, stop = b's extreme (the retest low) -/+ STOP_BUF, target as for a sweep. event 'BREAK-RETEST' (both directions; dir says
//   which), retest = { breakT, departT } (provenance). VWAP is not a retest level in r13 (its value moves bar to bar; stated). No intrabar retest births in r13.

const SWEEP_PTS = 0.25, SWEEP_LOOKBACK = 12, STOP_BUF = 2, MIN_TGT = 10, PROJ_PTS = 40, PERSIST_MS = 30 * 60000, MAX_TGT_ATR = 3;
const RETEST_TOL = 2, RETEST_AWAY = 10, RETEST_HOLD = 1, RETEST_WINDOW_MS = 2 * 3600000;   // r13 break-retest (points; the break inside the last 2 h)
// lv1 r13.3.4 (Mac 10/30, signed: plans-1030/htf-levels): the monthly and quarterly levels go on top, above the weekly ones; the rest is unchanged.
const HTF_NAMES = ['QO', 'PQH', 'PQL', 'QH', 'QL', 'CMO', 'PMH', 'PML', 'PMO', 'CMH', 'CML'];
const HIERARCHY = [...HTF_NAMES, 'Week Open', 'PWH', 'PWL', 'PWO', 'PWC', 'WTD High', 'WTD Low', 'PDH', 'PDL', 'Daily Open', '15:00 Open', 'PDC',
  '06:30 Open', 'London High', 'London Low', 'Asia High', 'Asia Low', '4H Open', '1H Open', '30m Open', '15m Open', 'IB High', 'IB Low', 'VWAP'];
const LONG_BEH = ['SWEEP DN', 'FAIL DN', 'RECLAIM', 'ACCEPT+', 'HOLD+'], SHORT_BEH = ['SWEEP UP', 'FAIL UP', 'LOST', 'ACCEPT-', 'HOLD-'];
// r13: a retest's board labels - agreeing or neutral at the level (a retest bar sits AT the level, where Levels PRO reads TESTING); never an opposite label or CHOP
const RETEST_LONG_BEH = ['ACCEPT+', 'HOLD+', 'TESTING', 'RECLAIM', 'SWEEP DN', 'FAIL DN', 'support'], RETEST_SHORT_BEH = ['ACCEPT-', 'HOLD-', 'TESTING', 'LOST', 'SWEEP UP', 'FAIL UP', 'resist'];
const retestBoard = (behs, dir) => behs.find(x => (dir > 0 ? RETEST_LONG_BEH : RETEST_SHORT_BEH).includes(x)) && !behs.some(x => x === 'CHOP' || (dir > 0 ? SHORT_BEH : LONG_BEH).includes(x))
  ? behs.find(x => (dir > 0 ? RETEST_LONG_BEH : RETEST_SHORT_BEH).includes(x)) : null;
// a rolling period open only exists from its period's start: its sweep run never reaches back before it (America/Los_Angeles; 4H anchored to the 15:00 PT TradeDay)
const PERIOD_MIN = { '15m Open': 15, '30m Open': 30, '1H Open': 60, '4H Open': 240 };
const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' });
function periodStart(name, t) {
  const P = PERIOD_MIN[name]; if (!P) return -Infinity;
  const [hh, mm] = PT_FMT.format(new Date(t)).split(':').map(Number), min = (hh % 24) * 60 + mm;
  const into = P === 240 ? ((min - 900 + 1440) % 1440) % 240 : min % P;
  return t - into * 60000;
}
// r6: an OPEN level is born exactly at its period / session start (its price is the first trade there). bornAt(name, t) = that start for the period containing t
// (minute-aligned), or null for every other level (their birth time is unknown, so only the acquisition bounds them).
const SESSION_OPEN_MIN = { '06:30 Open': 390 };
function bornAt(name, t) {
  const t0 = t - (((t % 60000) + 60000) % 60000);
  if (PERIOD_MIN[name]) return periodStart(name, t0);
  const S = SESSION_OPEN_MIN[name]; if (S == null) return null;
  const [hh, mm] = PT_FMT.format(new Date(t0)).split(':').map(Number), min = (hh % 24) * 60 + mm;
  return min >= S ? t0 - (min - S) * 60000 : null;
}
const rank = n => { const i = HIERARCHY.indexOf(n); return i < 0 ? Infinity : i; };
// lv1 r13.3.4 levelT (MacUI, display only): the start of the period whose open the level is, for the opens the PT clock fixes (15m / 30m / 1H / 4H Open,
// 06:30 Open) at time t; null for every other level (its period is not known from the clock alone).
function levelT(name, t) { if (!Number.isFinite(t)) return null; if (PERIOD_MIN[name]) { const t0 = t - (((t % 60000) + 60000) % 60000); return periodStart(name, t0); } return name === '06:30 Open' ? bornAt(name, t) : null; }
const r2 = x => Math.round(x * 100) / 100;

// Weekly levels the Levels PRO registry lacks, on Levels PRO's own week convention (lib/levelsPro.js: the current week = the last 1W bar whose t <= the bar
// time, the previous COMPLETED week = the bar before it). at = the time being evaluated (ms; the last completed trigger bar's t).
// PWO / PWC = the previous completed week's open / close; WTD High / Low = the current week's range from its COMPLETED daily bars - every 1D bar from the
// week's start up to (not including) the daily bar that contains `at` (the week so far through the last completed day: a level formed before this session,
// never moved by today's own sweep). Missing inputs = the level is simply absent (never guessed).
function weeklyLevels({ weekly = [], daily = [], at }) {
  const out = [];
  if (!Number.isFinite(at)) return out;
  const ok = b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite);
  const wk = (Array.isArray(weekly) ? weekly : []).filter(b => ok(b) && b.t <= at).sort((a, b) => a.t - b.t);
  const cur = wk.length ? wk[wk.length - 1] : null, prev = wk.length > 1 ? wk[wk.length - 2] : null;
  if (prev) { out.push({ name: 'PWO', price: prev.o, behavior: null, weekly: true }); out.push({ name: 'PWC', price: prev.c, behavior: null, weekly: true }); }
  if (cur) {
    const dd = (Array.isArray(daily) ? daily : []).filter(b => ok(b) && b.t <= at).sort((a, b) => a.t - b.t);
    const today = dd.length ? dd[dd.length - 1] : null;
    const days = today ? dd.filter(b => b.t >= cur.t && b.t < today.t) : [];
    if (days.length) {
      out.push({ name: 'WTD High', price: Math.max(...days.map(b => b.h)), behavior: null, weekly: true });
      out.push({ name: 'WTD Low', price: Math.min(...days.map(b => b.l)), behavior: null, weekly: true });
    }
  }
  return out;
}

// lv1 r13.3.4 MONTHLY AND QUARTERLY LEVELS (Mac 10/30: "all high time frames open lows and highs are important as institutions can have liquidity waiting
// there"; signed: plans-1030/htf-levels/PLAN.md). Tradeable exactly like the weekly levels: the boards do not carry them, so an event needs the sweep and
// the reclaim / loss only (weekly: true = "no board label needed", as for PWO / PWC / WTD). From the bot's own 1M and 1D bars (htf.M, htf.D), at = the
// time being evaluated (the last completed trigger bar's t):
//   PMH / PML / PMO  the previous completed month's high / low / open (the 1M bar of the month before at's month);
//   CMO              this month's open (the 1M bar of at's month);
//   CMH / CML        this month's high / low from its COMPLETED daily bars - never today's (the daily bar that contains at), like WTD High / Low;
//   QO               the open of the quarter's first month (Jan / Apr / Jul / Oct);
//   QH / QL          this quarter's high / low from its COMPLETED daily bars (the daily history must reach back before the quarter began);
//   PQH / PQL        the previous quarter's high / low from its 3 completed 1M bars.
// Month and quarter are the bars' own TradeDay month: the calendar month of t + 3 h. A session-open stamp (22:00Z / 23:00Z the evening before) lands on
// the TradeDay's date, as in the harness's 1W / 1M convention (9e403d3), and so does a midnight-UTC stamp. Fail safe: a missing month, a gap in the 1M
// bars or a daily history too short = that level is absent, never invented. Shared prices: one level per price, named by the highest name in HIERARCHY,
// the others in alsoNames (CMO = QO in a quarter's first month, PMH = PQH, ...).
const tdMonth = t => { const d = new Date(t + 3 * 3600000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };   // the TradeDay's month as one integer
function htfLevels({ monthly = [], daily = [], at }) {
  if (!Number.isFinite(at)) return [];
  const ok = b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite);
  const byMonth = new Map();   // one 1M bar per TradeDay month (a later bar for the same month - a derived current bar - replaces an earlier one)
  for (const b of (Array.isArray(monthly) ? monthly : []).filter(b => ok(b) && b.t <= at).sort((a, b) => a.t - b.t)) byMonth.set(tdMonth(b.t), b);
  const dd = (Array.isArray(daily) ? daily : []).filter(b => ok(b) && b.t <= at).sort((a, b) => a.t - b.t);
  const today = dd.length ? dd[dd.length - 1] : null, nowM = tdMonth(at), qM = nowM - (nowM % 3);   // the month of `at`; today = the daily bar holding it (never counted)
  const done = today ? dd.filter(b => b.t < today.t) : [];   // completed days only
  const L = [], hi = a => Math.max(...a.map(b => b.h)), lo = a => Math.min(...a.map(b => b.l));
  const cur = byMonth.get(nowM), prev = byMonth.get(nowM - 1);
  if (prev) L.push(['PMH', prev.h], ['PML', prev.l], ['PMO', prev.o]);
  if (cur) L.push(['CMO', cur.o]);
  const mDays = done.filter(b => tdMonth(b.t) === nowM);
  if (mDays.length) L.push(['CMH', hi(mDays)], ['CML', lo(mDays)]);
  const q0 = byMonth.get(qM); if (q0) L.push(['QO', q0.o]);
  const qDays = done.filter(b => tdMonth(b.t) >= qM);
  if (qDays.length && dd.length && tdMonth(dd[0].t) < qM) L.push(['QH', hi(qDays)], ['QL', lo(qDays)]);   // the daily history covers the whole quarter
  const pq = [qM - 3, qM - 2, qM - 1].map(m => byMonth.get(m));
  if (pq.every(Boolean)) L.push(['PQH', hi(pq)], ['PQL', lo(pq)]);
  const byPx = new Map();
  for (const [name, price] of L.sort((a, b) => rank(a[0]) - rank(b[0]))) { const k = String(price), e = byPx.get(k); if (e) e.alsoNames.push(name); else byPx.set(k, { name, price, alsoNames: [] }); }
  return [...byPx.values()].map(e => ({ name: e.name, price: e.price, behavior: null, weekly: true, htf: true, ...(e.alsoNames.length ? { alsoNames: e.alsoNames } : {}) }));
}

// r3 (MacDot HOLD 6451609719 / 6451687678): a CAUSAL, IMMUTABLE event tracker - one per trigger timeframe, held by the executor across polls.
//  - Completion by ACQUISITION: a bar counts only if it had ENDED by the time the bars were REQUESTED (reqAt). No valid reqAt = nothing is observed.
//  - Birth only on a NEWLY completed bar, judged once, with the boards observed at that moment; history is never re-derived from a later board. A poll that
//    skipped bars (the previous completed bar was never observed as the newest) cannot create an event (no reconstruction).
//  - Level identity = exact name AND price. The level must have been observed with the same name and price when the previous bar was the newest (so a new
//    period's value can never be applied to an older period's bars), and the board behaviour that confirms it must belong to that exact name + price.
//  - Once born the event is frozen; it stays live while every later completed close holds the reclaimed side, for PERSIST_MS of bar time (the same 30 min
//    on 5m and 3m); a close back across or the time limit ends it for good (an ended event is never revived).
// r6 (MacDot 6454174200 / 6454209995): (a) an acquisition counts only if it holds the bar that is the LAST COMPLETED one at request time - an older prefix
//    (even behind a derived current bar) certifies nothing, and age / expiry run on acquisition time; older acquisitions are ignored (monotonic); (b) a level is
//    known from the first bar starting at/after the request that first showed it (an open first seen inside its own first bar: from that bar, its exact
//    birth); (c) the sweep run is walked over contiguous completed bars only - a missing bar ends the walk.
// r12 (Mac 10/28 screenshot: VWAP was 'too new' on every bar): VWAP MOVES every bar, so its identity is its NAME (since its 06:30 PT reset; the boards carry
// slightly different VWAP values per timeframe - the trigger timeframe's own board value is used); every other level is exact name AND price.
// r12.2 (MacDot HOLD 6458814650): (1) name continuity alone is no evidence - every bar is judged against the VWAP value OBSERVED FOR THAT BAR (the trigger
// board's value when that bar was the board's newest row, the latest such observation; see step levelsBarT): the reclaim's previous bar, the sweep run and
// the reclaim bar each against their own value, and a bar with no observed value ends the walk (fail closed, never filled from today's value); (2) VWAP
// identity is bound to its EPOCH (the reset it accumulates from: Levels PRO 'calendar-0630' restarts at 06:30 PT and at the new day - 15:00 PT under the
// cme anchor, midnight under legacy; the executor passes its anchor's resets, the default is every one of them) and a live VWAP event ENDS at the next reset.
const MOVING = new Set(['VWAP']), MOVING_TOL = 2;   // boards' VWAP values within 2 pts are the same VWAP
const VWAP_RESETS_PT = Object.freeze([0, 390, 900]);   // PT minute of day: legacy midnight, 06:30, cme 15:00 (default = all: an extra reset only ends identity sooner)
function epochStart(t, resets) {   // the start of the VWAP epoch containing t (the most recent reset at/before t's minute)
  const t0 = t - (((t % 60000) + 60000) % 60000), [hh, mm] = PT_FMT.format(new Date(t0)).split(':').map(Number), min = (hh % 24) * 60 + mm;
  return t0 - Math.min(...resets.map(r => (((min - r) % 1440) + 1440) % 1440)) * 60000;
}
const keyOf = l => (MOVING.has(l.name) ? `${l.name}#${l.epoch}` : `${l.name}|${l.price}`);
// epoch = the VWAP epoch of the bar the boards' values belong to (null = unknown: a moving level is then absent - its identity cannot be bound)
function normLevels(boardLevels, extraLevels, epoch) {
  const m = new Map();
  for (const l of [...(boardLevels || []), ...(extraLevels || [])]) {
    if (!l || typeof l.name !== 'string' || !Number.isFinite(l.price) || rank(l.name) === Infinity) continue;
    const mv = MOVING.has(l.name); if (mv && epoch == null) continue;
    const k = keyOf(mv ? { name: l.name, epoch } : l), e = m.get(k) || { name: l.name, price: l.price, weekly: !!l.weekly, behaviors: [], ...(mv ? { moving: true, epoch } : {}),
      ...(l.htf ? { htf: true, ...(Array.isArray(l.alsoNames) && l.alsoNames.length ? { alsoNames: l.alsoNames.slice() } : {}) } : {}) };   // r13.3.4
    if (mv && Math.abs(l.price - e.price) > MOVING_TOL) continue;   // r12: another board's VWAP value far from the trigger board's is not this level (its label never confirms it)
    if (l.behavior) e.behaviors.push(l.behavior); m.set(k, e);
  }
  return m;
}
// r12 INTRABAR (Mac 10/28: "check the bars intrabar for an entry" - the bot polls every 20 s, but a level only fired on a 3m / 5m CLOSE): with
// { intrabar: true } the FORMING bar is judged on every poll, with the same rules as a close, where its live price stands in for the close:
//   the previous COMPLETED bar closed at/below L (long; mirror short), the forming price is now at least intrabarBufPts ABOVE L, the sweep run (contiguous completed
//   bars since the last close above L, plus the forming bar's low so far) traded SWEEP_PTS below L, the level was known before the previous bar started, and the
//   boards observed now agree. The event is born at that poll (bornT = the forming bar's start, intrabar: true, bornAt = the request time; entry = the live
//   price) and is then frozen. While its bar is still forming it is live only while the live price holds the reclaimed side; once the bar completes the close
//   rules apply to it INCLUDING its own bar (a birth bar that closes back across ends it). One intrabar birth per forming bar; a live event is never replaced
//   by an intrabar one; when the birth bar then closes as a reclaim the same event carries on (no second birth).
// r12.2 (MacDot 6458814650): (3) observation is MONOTONIC ON THE EXACT REQUEST TIME - an older request, even in the same completed-bar bucket, is ignored
//   entirely (it can neither revive nor birth from a forming bar a newer request already superseded); (4) PROVENANCE: an intrabar event's bornAt is the time
//   its evidence was IN HAND (obsAt = the response time of this timeframe's read; null when not supplied - never the request time), reqAt is kept beside it,
//   and seen = the forming bar exactly as observed then (frozen: the bar's final OHLC is never presented as what was known at birth).
// r12.4 (Mac 10/28 ruling on MacDot 6461402060, "seen only"): a moving level's SWEEP is OBSERVED, never inferred: it counts only when one observation's own
//   price (the row's latest price) is SWEEP_PTS through the level's value in that SAME observation; a wick between two observations is missed (fail closed).
//   Fixed levels keep the bar-range test (their price never moves). Every plan says which: sweepBasis 'seen' (moving) / 'bar-range' (fixed).
// r12.3 (MacDot HOLD 6460523672): (1) [superseded for the sweep by r12.4] endpoint-bracket sweep inference; A bar's CLOSE is compared with the value
//   observed at that close (a completed-row observation) or, failing that, conservatively with both observations bracketing it (the last during the bar and
//   the first after it); no observation = no evidence. (2) a request time EQUAL to one already seen is a duplicate and is ignored like an older one (it can
//   neither recertify nor birth). (3) an intrabar birth requires a valid obsAt (response time >= request time): unknown observation time = no intrabar birth.
// r13.3.5 planEndsAtTarget (shipped off): a live event also ends for good, why 'target-reached', once a price SEEN after its birth trades at or through its
//   plan target (a projected target too) - long: a high >= target, short: a low <= target - before an entry: the plan is spent. Seen after the birth = the
//   completed bars after the birth bar (high / low), an intrabar event's own birth bar only beyond the extreme already seen at its birth (the rest of
//   that bar came before the birth), and the forming bar's live price (its close so far) from any acquisition that carries it. false = r13.3.4.
function createTracker(tfMs, { intrabar = false, intrabarBufPts = 1, vwapResetsPt = VWAP_RESETS_PT, retest = false, planEndsAtTarget = false } = {}) {
  if (!(Number.isFinite(tfMs) && tfMs > 0)) throw new Error('levelEvent tracker needs the timeframe in ms');
  const resets = (Array.isArray(vwapResetsPt) ? vwapResetsPt : []).filter(r => Number.isInteger(r) && r >= 0 && r < 1440);
  if (!resets.length) throw new Error('levelEvent tracker needs at least one VWAP reset (PT minute of day)');
  const pStart = (name, t) => (MOVING.has(name) ? epochStart(t, resets) : periodStart(name, t));
  // firstSeen: exact level (name|price) -> the time the level is KNOWN from, kept only while every later observation keeps showing it (r4, MacDot 6453398804
  // #2). r6 (MacDot 6454174200 #2): bounded by the ACQUISITION, not by the newest bar it came with - the level is known from the start of the first bar that
  // begins at/after the request time of the first observation showing it (a lagged response never backdates a level). Bars that started earlier are
  // pre-birth and can never be the reclaim's previous bar or part of its sweep run.
  // maxExpected (r6, MacDot 6454209995): the newest acquisition-time expected last completed bar seen so far; an older acquisition is ignored (monotonic).
  // mv (r12.3): moving-level key (name#epoch) -> { bars: Map(bar t -> { vLast, vClose, vAfter, swL, swH }) } (vLast = the latest value observed for the bar's
  //   row, vClose = the value from a completed-row observation, vAfter = the first value observed after the bar's close; swL / swH (r12.4) = a price SEEN
  //   through the level below / above in one observation); maxReqAt (r12.2): the newest request time seen.
  const st = { lastSeenT: -Infinity, prevObs: null, event: null, firstSeen: new Map(), ended: null, maxExpected: -Infinity, maxReqAt: -Infinity, mv: new Map() };
  const mvRec = (L, t) => { const m = st.mv.get(keyOf(L)); return m ? m.bars.get(t) : undefined; };
  // the level at bar x's CLOSE as [low, high]: a fixed level's price; a moving level's completed-row value, else the two observations bracketing the close
  const closeBand = (L, x) => {
    if (!L.moving) return [L.price, L.price];
    const r = mvRec(L, x.t); if (!r) return undefined;
    if (r.vClose !== undefined) return [r.vClose, r.vClose];
    return r.vLast !== undefined && r.vAfter !== undefined ? [Math.min(r.vLast, r.vAfter), Math.max(r.vLast, r.vAfter)] : undefined;
  };
  const farSide = (x, L, dir) => { const b = closeBand(L, x); return b !== undefined && (dir > 0 ? x.c <= b[0] : x.c >= b[1]); };
  const swept = (run, L, dir) => run.some(x => { if (!L.moving) return dir > 0 ? x.l <= L.price - SWEEP_PTS : x.h >= L.price + SWEEP_PTS; const r = mvRec(L, x.t); return !!r && (dir > 0 ? r.swL : r.swH); });
  // one observation of a moving level: value v for the row of bar t (X = that bar's OHLC so far, null if the response lacks it; complete = the row had ended)
  function observeMoving(k, v, t, X, complete) {
    const m = st.mv.get(k) || { bars: new Map() }, r = m.bars.get(t) || { vLast: undefined, vClose: undefined, vAfter: undefined, swL: false, swH: false };
    if (X) {   // r12.4 'seen only': this observation's own price against this observation's own value (a completed row: its close and its close value)
      if (X.c <= v - SWEEP_PTS) r.swL = true;
      if (X.c >= v + SWEEP_PTS) r.swH = true;
    }
    r.vLast = v; if (complete) r.vClose = v;
    const pr = m.bars.get(t - tfMs); if (pr && pr.vAfter === undefined) pr.vAfter = v;   // the first value after the previous bar's close
    m.bars.set(t, r); st.mv.set(k, m);
    for (const bt of [...m.bars.keys()]) if (bt < t - (SWEEP_LOOKBACK + 2) * tfMs) m.bars.delete(bt);
  }
  // bars: this TF's bars as fetched (forming bar may be included - dropped here by reqAt); reqAt: when they were REQUESTED (ms); obsAt (r12.2): when the
  // response was in hand (ms); levelsBarT (r12.2): the bar time of the trigger board's newest row (the bar its VWAP value belongs to); boardLevels: the boards'
  // levels observed now ({ name, price, behavior }, trigger TF + 15m); extraLevels: weeklyLevels() for the newest completed bar; atr: target cap only.
  function step({ bars, reqAt, obsAt = null, levelsBarT = null, boardLevels = [], extraLevels = [], atr = null } = {}) {
    if (typeof reqAt !== 'number' || !Number.isFinite(reqAt)) return { event: null, live: null, observed: false };   // r4: no valid acquisition = no evidence, not an old event
    const B = (Array.isArray(bars) ? bars : []).filter(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t + tfMs <= reqAt).sort((x, y) => x.t - y.t);
    const n = B.length; if (!n) return { event: null, live: null, observed: false };
    const last = B[n - 1];
    // r6 FRESHNESS (MacDot 6454209995): the acquisition must cover the bar that, by request time, is the LAST COMPLETED bar (expectedLast, on the bars' own
    // grid). An older completed prefix (a derived / forming current bar does not count: it was dropped above) is no evidence of now: no birth, no
    // certification - only invalidation by its completed closes and expiry against acquisition time. Observation state is monotonic: an acquisition older
    // than one already seen is ignored entirely - r12.2: by its exact request time, not its completed-bar bucket.
    const phase = ((last.t % tfMs) + tfMs) % tfMs, expectedLast = Math.floor((reqAt - phase) / tfMs) * tfMs + phase - tfMs;
    if (!(reqAt > st.maxReqAt)) return { event: null, live: null, observed: false, stale: reqAt === st.maxReqAt ? 'duplicate-acquisition' : 'older-acquisition' };   // r12.3: equal = duplicate
    st.maxReqAt = reqAt; st.maxExpected = expectedLast;
    // r12: the forming bar of THIS acquisition (started by the request, not yet ended), if the response carried it
    const F = intrabar ? (Array.isArray(bars) ? bars : []).find(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t === expectedLast + tfMs && b.t <= reqAt) || null : null;
    if (last.t !== expectedLast) { liveView(B, expectedLast, false, null, reqAt); return { event: null, live: null, observed: false, stale: 'last-bar-missing' }; }
    // r13.3.5 planEndsAtTarget: the forming bar this acquisition carries (the intrabar one, or found the same way when intrabar births are off)
    const FT = planEndsAtTarget ? F || (Array.isArray(bars) ? bars : []).find(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t === expectedLast + tfMs && b.t <= reqAt) || null : null;
    // r12.2: the boards' levels, a moving level bound to the epoch of the bar its value belongs to, and that value recorded for that bar (newest request wins)
    const vb = levelsBarT === expectedLast || levelsBarT === expectedLast + tfMs ? levelsBarT : null;   // the board's row is the last completed bar or the forming one; else no value
    const levelsNow = normLevels(boardLevels, extraLevels, vb === null ? null : pStart('VWAP', vb));
    for (const k of [...st.mv.keys()]) if (!levelsNow.has(k)) st.mv.delete(k);   // left the board (or a new epoch): its history is not this level's
    const X = vb === null ? null : vb === expectedLast ? last : (Array.isArray(bars) ? bars : []).find(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t === vb) || null;
    for (const [k, L] of levelsNow) if (L.moving) observeMoving(k, L.price, vb, X, vb + tfMs <= reqAt);
    let born = null, scan = null;
    if (last.t > st.lastSeenT) {
      const obs = { barT: last.t, levels: levelsNow };
      const p = n > 1 ? B[n - 2] : null;
      const judged = judge(B, obs, atr, !!(p && p.t === last.t - tfMs && st.prevObs && st.prevObs.barT === p.t), expectedLast, reqAt);
      born = judged.hit; scan = judged.scan; st.lastJudgeable = judged.scan.judgeable;   // r12: an intrabar birth needs the same unbroken observation
      for (const k of [...st.firstSeen.keys()]) if (!obs.levels.has(k)) st.firstSeen.delete(k);   // a level that left the board is a new level if it returns
      // r6: known from the first bar starting at/after this acquisition - or, for an open first seen INSIDE its own first bar, from that bar (it was born at its start)
      const knownAt = Math.ceil((reqAt - phase) / tfMs) * tfMs + phase, cur = expectedLast + tfMs;
      for (const [k, L] of obs.levels) if (!st.firstSeen.has(k)) st.firstSeen.set(k, bornAt(L.name, reqAt) === cur ? cur : knownAt);
      st.prevObs = obs; st.lastSeenT = last.t;
      // r12: the birth bar of a live intrabar event closing as the same reclaim is that event carrying on, not a second birth
      const e0 = st.event;
      if (born && e0 && e0.intrabar && e0.bornT === born.bornT && e0.dir === born.dir && keyOf(e0.level) === keyOf(born.level) && !liveEnded(B, e0)) born = null;
      else if (born) st.event = born;
    }
    // r12 INTRABAR birth: only from an acquisition that is current (its last completed bar is the expected one and was observed as the newest, and the bar
    // before it was too - after a skipped poll / restart, as for a close birth, nothing is born until one bar has been watched end to end), with no live event
    const seenAt = typeof obsAt === 'number' && Number.isFinite(obsAt) && obsAt >= reqAt ? obsAt : null;   // r12.3: no valid response time = no intrabar birth
    if (F && seenAt !== null && !born && st.prevObs && st.prevObs.barT === last.t && st.lastJudgeable && st.ibT !== F.t && !(st.event && liveView(B, expectedLast, true, F, reqAt, FT))) {
      const ib = judgeForming(B, F, levelsNow, atr, reqAt, seenAt, vb);
      if (ib) { st.event = ib; st.ibT = F.t; born = ib; }
    }
    return { event: born, live: liveView(B, expectedLast, true, F, reqAt, FT), observed: true, scan };
  }
  // the sweep run's first bar: walk back from completed bar j while the bar before is contiguous, known and closed on the far side of L - r12.2: of ITS OWN
  // value of L (a bar with no observed value ends the walk) (shared by close / intrabar)
  function walkBack(B, j, from, L, dir, knownFrom) {
    while (j > from && B[j].t - B[j - 1].t === tfMs && B[j - 1].t >= knownFrom && farSide(B[j - 1], L, dir)) j--;
    return j;
  }
  function liveEnded(B, e) { return B.some(x => x.t >= e.bornT && (e.dir > 0 ? !(x.c > e.level.price) : !(x.c < e.level.price))); }
  // r12: judge the FORMING bar F (its live price F.c in place of a close) against the previous completed bar - the rules of judge(), see createTracker
  // r12.2 / r12.3: F's live price against the level's value observed NOW for F's row (vb = F.t; a moving level only), p's close against its close band, and the
  // sweep from contemporaneous evidence; bornAt = obsAt (always a valid response time here)
  function judgeForming(B, F, levels, atr, reqAt, obsAt, vb) {
    const i = B.length - 1, p = B[i], from = Math.max(0, i - SWEEP_LOOKBACK + 2), hits = [];
    if (!p || p.t !== F.t - tfMs) return null;
    for (const [k, L] of levels) {
      const vf = L.moving && vb !== F.t ? undefined : L.price, bp = closeBand(L, p); if (vf === undefined || bp === undefined) continue;
      const dir = F.c >= vf + intrabarBufPts && p.c <= bp[0] ? 1 : F.c <= vf - intrabarBufPts && p.c >= bp[1] ? -1 : 0;
      if (!dir) continue;
      const seen = st.firstSeen.get(k), knownFrom = seen === undefined ? Infinity : Math.max(seen, pStart(L.name, F.t));
      if (p.t < knownFrom) continue;
      const j = walkBack(B, i, from, L, dir, knownFrom);
      const run = B.slice(j, i + 1).concat([F]), ext = dir > 0 ? Math.min(...run.map(x => x.l)) : Math.max(...run.map(x => x.h));
      if (!swept(run, L, dir)) continue;
      const beh = L.behaviors.find(bh => (dir > 0 ? LONG_BEH : SHORT_BEH).includes(bh)) || null;
      if (!L.weekly && !beh) continue;
      hits.push({ L: L.moving ? { ...L, price: vf } : L, dir, ext, beh });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => rank(a.L.name) - rank(b.L.name));   // Mac's hierarchy, as at a close
    return Object.freeze({ ...plan(hits[0], F.c, F.t, levels, atr), intrabar: true, reqAt, bornAt: obsAt, seen: Object.freeze({ t: F.t, o: F.o, h: F.h, l: F.l, c: F.c }) });
  }
  // the frozen plan of a qualifying hit: MARKET at `entry`, stop beyond the sweep extreme, target = the next named level >= MIN_TGT away (ATR-capped) else a projection
  function plan({ L, dir, ext, beh, rt }, entry, bornT, levels, atr) {
    const stop = dir > 0 ? ext - STOP_BUF : ext + STOP_BUF;
    let target = null, targetName = null, projected = false;
    const cap = Number.isFinite(atr) && atr > 0 ? atr * MAX_TGT_ATR : Infinity;
    for (const o of levels.values()) {
      const gap = dir > 0 ? o.price - entry : entry - o.price;
      if (gap >= MIN_TGT && gap <= cap && (target == null || gap < (dir > 0 ? target - entry : entry - target))) { target = o.price; targetName = o.name; }
    }
    if (target == null) { target = entry + dir * PROJ_PTS; targetName = 'projection'; projected = true; }
    // r13.3.4: when a monthly / quarterly level shares the event's price, every name at that price is journaled (alsoNames, Mac's order); otherwise the
    // level is exactly as before (no new field)
    const same = L.moving ? [] : [...levels.values()].filter(o => o !== L && !o.moving && o.price === L.price && (L.htf || o.htf));
    const also = [...new Set([...(L.alsoNames || []), ...same.flatMap(o => [o.name, ...(o.alsoNames || [])])])].filter(x => x !== L.name).sort((a, b) => rank(a) - rank(b));
    return { dir, tfMs, level: Object.freeze({ name: L.name, price: L.price, behavior: beh, weekly: !!L.weekly, ...(L.moving ? { epoch: L.epoch } : {}), ...(L.htf ? { htf: true } : {}), ...(also.length ? { alsoNames: Object.freeze(also) } : {}) }), event: dir > 0 ? 'SWEEP-RECLAIM' : 'SWEEP-LOSS',
      sweepBasis: L.moving ? 'seen' : 'bar-range',   // r12.4: how the sweep is known - a price seen through a moving level / a bar's range through a fixed price
      bornT, sweepExtreme: r2(ext), entry: r2(entry), stop: r2(stop), target: r2(target), targetName, projected, grade: 'B', entryType: 'MARKET',
      ...(rt ? { event: 'BREAK-RETEST', retest: Object.freeze({ breakT: rt.breakT, departT: rt.departT }) } : {}) };   // r13: same key order; the retest adds its provenance
  }
  // r13 BREAK-RETEST geometry at FIXED level L for the newly completed bar B[i] (see the header); k = L's key. null = no retest on this bar.
  function retestOf(B, i, L, k) {
    const b = B[i], P = L.price, lo = Math.max(1, i - Math.floor(RETEST_WINDOW_MS / tfMs));
    const dir = b.c >= P + RETEST_HOLD && b.l <= P + RETEST_TOL ? 1 : b.c <= P - RETEST_HOLD && b.h >= P - RETEST_TOL ? -1 : 0;
    if (!dir || i < 2) return null;
    const seen = st.firstSeen.get(k), knownFrom = seen === undefined ? Infinity : Math.max(seen, pStart(L.name, b.t));   // as for a sweep: known, inside its period
    const held = x => (dir > 0 ? x.c > P : x.c < P);
    if (!(b.t - B[i - 1].t === tfMs && B[i - 1].t >= knownFrom && held(B[i - 1]))) return null;   // the bar before b already held (else b is a cross, not a retest)
    let j = i - 1;   // walk back over the accepted run: contiguous, known, every close beyond L
    while (j > lo && B[j].t - B[j - 1].t === tfMs && B[j - 1].t >= knownFrom && held(B[j - 1])) j--;
    const q = B[j - 1];   // must be the close at/through L right before the break bar B[j] (contiguous, known); anything else = the break is not proven
    if (!q || B[j].t - q.t !== tfMs || q.t < knownFrom || held(q)) return null;
    let d = -1;
    for (let x = j; x < i; x++) if (dir > 0 ? B[x].h >= P + RETEST_AWAY : B[x].l <= P - RETEST_AWAY) { d = x; break; }
    if (d < 0) return null;   // never left the level: chop at the level, not a break
    for (let x = d + 1; x < i; x++) if (dir > 0 ? B[x].l <= P + RETEST_TOL : B[x].h >= P - RETEST_TOL) return null;   // b must be the FIRST return
    return { dir, ext: dir > 0 ? b.l : b.h, breakT: B[j].t, departT: B[d].t };
  }
  // r5 (journal / display only - the decision is exactly r4's): every level on the board gets a verdict for the bar that just completed, so the team can see
  // which levels price worked, which became events and WHY the others did not. Codes: EVENT | outranked (qualified, a higher level won the bar) | no-sweep
  // (closed back across without trading SWEEP_PTS through it since the last close on that side) | board-against (no agreeing behaviour label) | too-new (the
  // level was not on the board before the previous bar) | not-judged (the previous bar was never observed as the newest: no reconstruction) | touched (traded
  // through, closed on the same side) | away | sweep-live (r13.3: a break-retest while a sweep event is still live - a retest never replaces a live sweep).
  // Each entry: [name, price, code, closeMinusLevel, dir (1/-1/0), behaviours, usableNextBar, weekly]. at / nowT = the acquisition (liveView's own clock).
  function judge(B, obs, atr, judgeable, at, nowT) {
    const i = B.length - 1, b = B[i], p = i > 0 ? B[i - 1] : null, from = Math.max(0, i - SWEEP_LOOKBACK + 1), hits = [], rows = [];
    // r13.3 (MacDot 6470196640: "a new retest also replaces a still-live same-level sweep"): while a sweep event is live by liveView's own end test (nothing is
    // ended here), no retest is born on any level - the sweep keeps its stop and size. Mac's choice; the alternative is the newer retest replacing it (r13).
    const e0 = st.event, sweepLive = !!(retest && e0 && e0.event !== 'BREAK-RETEST' && endOf(B, e0, at, nowT) === null);
    for (const [k, L] of obs.levels) {
      const seen0 = st.firstSeen.get(k), bb = closeBand(L, b), bp = p ? closeBand(L, p) : undefined, r0 = L.moving ? mvRec(L, b.t) : null;   // r12.3: each close's own band
      const lb = r0 ? (r0.vClose !== undefined ? r0.vClose : r0.vLast !== undefined ? r0.vLast : L.price) : L.price;
      const row = [L.name, lb, 'away', r2(b.c - lb), 0, L.behaviors.slice(0, 3), seen0 !== undefined && Math.max(seen0, pStart(L.name, b.t + tfMs)) <= b.t, !!L.weekly];   // [6]: usable as the NEXT bar's previous bar (display), [7]: weekly
      rows.push(row);
      if (bb === undefined || (p && bp === undefined)) { row[2] = 'not-judged'; continue; }   // r12.2: no value observed at this close or the one before = no evidence
      if (b.l <= bb[1] && b.h >= bb[0]) row[2] = 'touched';
      if (!p) continue;
      const dir = b.c > bb[1] && p.c <= bp[0] ? 1 : b.c < bb[0] && p.c >= bp[1] ? -1 : 0;
      if (!dir) {
        // r13: no cross on this bar - it may be the retest of a break (fixed levels only; the sweep rules below never see it)
        const rt = retest && !L.moving ? retestOf(B, i, L, k) : null; if (!rt) continue;
        row[4] = rt.dir;
        if (!judgeable) { row[2] = 'not-judged'; continue; }
        const rb = L.weekly ? null : retestBoard(L.behaviors, rt.dir);
        if (!L.weekly && !rb) { row[2] = 'board-against'; continue; }
        if (sweepLive) { row[2] = 'sweep-live'; continue; }   // r13.3
        row[2] = 'outranked'; hits.push({ L, dir: rt.dir, ext: rt.ext, beh: rb, row, rt });
        continue;
      }
      row[4] = dir;
      if (!judgeable) { row[2] = 'not-judged'; continue; }
      const seen = st.firstSeen.get(k);   // the same name AND price must already be on the board, continuously
      const knownFrom = seen === undefined ? Infinity : Math.max(seen, pStart(L.name, b.t));   // no bar that started before the level was known (r4/r6) or before its period began
      if (p.t < knownFrom) { row[2] = 'too-new'; continue; }
      // r6 (MacDot 6454174200 #1): the sweep run is walked over CONTIGUOUS completed bars only - a missing bar may have closed back across and ended the
      // excursion, so the walk stops at a gap and nothing before it can lend its extreme (no sweep inside the unbroken part = not judged)
      const j = walkBack(B, i - 1, from, L, dir, knownFrom);
      const run = B.slice(j, i + 1), ext = dir > 0 ? Math.min(...run.map(x => x.l)) : Math.max(...run.map(x => x.h));
      if (!swept(run, L, dir)) { row[2] = j > from && (B[j].t - B[j - 1].t !== tfMs || closeBand(L, B[j - 1]) === undefined) ? 'not-judged' : 'no-sweep'; continue; }
      const beh = L.behaviors.find(bh => (dir > 0 ? LONG_BEH : SHORT_BEH).includes(bh)) || null;
      if (!L.weekly && !beh) { row[2] = 'board-against'; continue; }
      row[2] = 'outranked'; hits.push({ L: L.moving ? { ...L, price: dir > 0 ? bb[1] : bb[0] } : L, dir, ext, beh, row });   // a moving level: the strict edge of its close band
    }
    const scan = { barT: b.t, tfMs, open: b.o, close: b.c, high: b.h, low: b.l, judgeable, levels: rows };
    if (!hits.length) return { hit: null, scan };
    hits.sort((x, y) => rank(x.L.name) - rank(y.L.name));
    hits[0].row[2] = 'EVENT';
    return { hit: Object.freeze(plan(hits[0], b.c, b.t, obs.levels, atr)), scan };
  }
  // why event e has ended at acquisition `at` / request time nowT, or null while it is live (r13.3: liveView's end test, shared with judge(); ends nothing)
  function endOf(B, e, at, nowT, FT) {
    // r12: an intrabar event's own birth bar counts once it completes (it was born before its close)
    const crossed = B.some(x => (e.intrabar ? x.t >= e.bornT : x.t > e.bornT) && (e.dir > 0 ? !(x.c > e.level.price) : !(x.c < e.level.price)));
    const reset = MOVING.has(e.level.name) && pStart(e.level.name, nowT) !== e.level.epoch;
    return crossed ? 'closed-back-across' : reset ? 'vwap-reset' : Math.max(0, at - e.bornT) >= PERSIST_MS ? 'expired-30m' : planEndsAtTarget && targetSeen(B, e, FT) ? 'target-reached' : null;
  }
  // r13.3.5 planEndsAtTarget: a price seen after e's birth at or through e.target (see createTracker)
  function targetSeen(B, e, FT) {
    if (!Number.isFinite(e.target)) return false;
    const hit = p => Number.isFinite(p) && (e.dir > 0 ? p >= e.target : p <= e.target), ext = x => (e.dir > 0 ? x.h : x.l);
    for (const x of B) {
      if (x.t < e.bornT) continue;
      if (x.t === e.bornT) { if (e.intrabar && e.seen && (e.dir > 0 ? x.h > e.seen.h : x.l < e.seen.l) && hit(ext(x))) return true; continue; }   // the birth bar: only what came after the birth
      if (hit(ext(x))) return true;
    }
    return !!(FT && FT.t >= e.bornT && hit(FT.c));
  }
  // at = the acquisition-time expected last completed bar (r6: age and expiry run on acquisition time, never on the newest bar a response happened to carry);
  // certify = false for a stale acquisition: it may end the event (a completed close across, or expiry) but never certifies it
  // nowT (r12.2) = the request time: a VWAP event whose epoch is no longer the current one (VWAP has reset since its birth) ends for good ('vwap-reset')
  function liveView(B, at, certify, F, nowT, FT = null) {
    const e = st.event; if (!e) return null;
    if (B) {
      const ageMs = Math.max(0, at - e.bornT), why = endOf(B, e, at, nowT, FT);
      if (why) { st.ended = { event: e, why, at }; st.event = null; return null; }   // invalidated, reset or expired: ended for good
      if (!certify) return null;
      // r4 (MacDot #3): validity is certified only over an UNBROKEN run of completed bars from the birth bar to now; a gap = unassessed (no trade now), the
      // event is kept (not revived if a close across it is seen later, not certified while evidence is missing)
      const seq = B.filter(x => x.t >= e.bornT);
      // r12: an intrabar event whose birth bar is still forming is live only while this poll's forming price holds the reclaimed side
      if (e.intrabar && !seq.length) { if (!(F && F.t === e.bornT && (e.dir > 0 ? F.c > e.level.price : F.c < e.level.price))) return null; st.ageMs = 0; return { ...e, ageMs: 0, ageBars: 0 }; }
      if (!seq.length || seq[0].t !== e.bornT || seq.some((x, q) => q > 0 && x.t - seq[q - 1].t !== tfMs)) return null;
      st.ageMs = ageMs;
    }
    return { ...e, ageMs: st.ageMs || 0, ageBars: Math.round((st.ageMs || 0) / tfMs) };
  }
  return { step, state: () => ({ lastSeenT: st.lastSeenT, prevBarT: st.prevObs ? st.prevObs.barT : null, event: st.event, ended: st.ended, firstSeen: new Map(st.firstSeen), maxExpected: st.maxExpected, maxReqAt: st.maxReqAt }) };
}

// The named-event PROOF every levels-only entry must carry (lib/signal.js stamps it; live-executor.js takeEntry refuses an entry without it). r4 (MacDot
// 6453398804 #1): every proof needs a SWEEP event of this module (causal birth, sweep extreme, timeframe, age) in that direction at that exact level:
//   'level-event'      - the plan IS the event's plan (withLevelEvent);
//   'levels-plan+event' - Levels PRO's own plan in that direction whose in-play level is the event's exact level (name and price).
// A behaviour label alone (HOLD+ / ACCEPT+ / RECLAIM on the board), STRONG control, or a plan at another level proves nothing = no trade (fail closed).
function levelProof(lv, dir) {
  if (!lv || (dir !== 1 && dir !== -1)) return null;
  const ev = lv.levelEvent, ip = lv.inPlayLevel;
  if (!ev || ev.dir !== dir || !ev.level || rank(ev.level.name) === Infinity || !Number.isFinite(ev.level.price) || !Number.isFinite(ev.bornT) || !Number.isFinite(ev.sweepExtreme)) return null;
  if (!lv.plan || lv.plan.dir !== dir) return null;
  const base = { dir, name: ev.level.name, price: ev.level.price, event: ev.event, bornT: ev.bornT, tfMs: ev.tfMs, sweepExtreme: ev.sweepExtreme, ageMs: ev.ageMs,
    trigger: Number.isFinite(ev.entry) ? ev.entry : null,   // r13.2: the event's own entry (the retest / reclaim close) - the executor's retest chase check
    ...(Array.isArray(ev.level.alsoNames) && ev.level.alsoNames.length ? { alsoNames: ev.level.alsoNames } : {}) };   // r13.3.4: every name at a monthly / quarterly price
  if (lv.plan.levelEvent === ev.event) return Object.freeze({ kind: 'level-event', ...base });
  if (ip && ip.name === ev.level.name && ip.price === ev.level.price) return Object.freeze({ kind: 'levels-plan+event', ...base, planBehavior: ip.behavior || null });
  return null;
}
// r12.6 (Mac 10/28: "isn't it already requiring higher time frame alignment in the trade direction?" - it was not: alignedFull is all three slots agreeing
// with EACH OTHER, either way). The direction the HTF alignment points: +1 = every slot CURRENT and price above its open (15m+ 1H+ 4H+), -1 = every slot at/below
// its open, 0 = mixed, unknown, or no slots. A levels-only trade needs alignDir(lv) === its direction (lib/signal.js levelsAlignWithTrade).
// r12.6.1 (MacDot 6464184681 #1): the slots must be EXACTLY the configured required set - each required timeframe once, nothing else - so one CURRENT M15
// slot, a duplicate or an unnamed slot can never pass. alignRequired(cfg) is the live executor's own set (levelsAlignOpts: + M30 when align30 is on).
function alignRequired(cfg) { return cfg && cfg.align30 === true ? ['M15', 'M30', 'H1', 'H4'] : ['M15', 'H1', 'H4']; }
function alignDir(lv, required = alignRequired(null)) {
  if (!lv || lv.alignmentStatus !== 'CURRENT' || lv.alignedFull !== true || !Array.isArray(lv.alignSlots) || !Array.isArray(required) || !required.length) return 0;
  const S = lv.alignSlots;
  if (S.length !== required.length || !required.every(k => S.filter(x => x && x.timeframe === k).length === 1)) return 0;
  const f = S.map(x => x.status === 'CURRENT' ? x.flag : null);
  return f.every(x => x === true) ? 1 : f.every(x => x === false) ? -1 : 0;
}
// Trigger timeframes re-ordered so the one whose trigger carries the HIGHEST-ranked proof level comes first (ties keep the configured order); a trigger with
// no proof ranks last. dirOf(lv) = that board's trigger direction (lib/levelsTrigger.js levelsTriggerInfo().dir).
function rankTimeframes(lvByTf, order, dirOf) {
  return (order || []).map((k, i) => { const lv = lvByTf[k], d = lv ? dirOf(lv) : 0, pf = d ? levelProof(lv, d) : null; return { k, i, r: pf ? rank(pf.name) : Infinity }; })
    .sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.k);
}

// The Levels PRO-shaped plan for decideSignal() / takeEntry(): a SHALLOW COPY of the board row with plan / planLong / planShort / sigLong / sigShort and the
// named in-play level replaced by the live level event. The board row is never mutated. Returns the original row when there is no live event or when the
// board already has its own live plan (Levels PRO's own plan keeps priority).
// r4: Levels PRO's own plan keeps its geometry only when a live event of the same direction sits at its exact in-play level (the event is attached as its
// proof); otherwise the live event's plan replaces it (an unproved native plan cannot trade under levels-only, so it must not pre-empt a proved event).
function withLevelEvent(lv, live) {
  if (!lv || !live) return lv;
  const ip = lv.inPlayLevel;
  if ((lv.planLong || lv.planShort) && lv.plan && lv.plan.dir === live.dir && ip && ip.name === live.level.name && ip.price === live.level.price) return Object.assign({}, lv, { levelEvent: live });
  const rr = Math.abs(live.target - live.entry) / Math.max(Math.abs(live.entry - live.stop), 0.25);
  return Object.assign({}, lv, {
    plan: { dir: live.dir, entry: live.entry, stop: live.stop, target: live.target, targetName: live.targetName, rr: r2(rr), grade: live.grade, entryType: live.entryType,
      readyNow: true, projected: live.projected, levelEvent: live.event, level: live.level },
    planLong: live.dir > 0, planShort: live.dir < 0, sigLong: live.dir > 0 && live.ageBars === 0, sigShort: live.dir < 0 && live.ageBars === 0,
    inPlayLevel: { name: live.level.name, price: live.level.price, control: lv.inPlayLevel && lv.inPlayLevel.name === live.level.name ? lv.inPlayLevel.control : null, behavior: live.event,
      intrabar: !!live.intrabar, tfMs: live.tfMs },   // r12.4: display / journal only (the trade row names how the event fired)
    levelEvent: live });
}

module.exports = { PLAN_END_VERSION: 'plan-ends-at-target-v1', createTracker, weeklyLevels, htfLevels, levelT, HTF_NAMES, withLevelEvent, levelProof, alignDir, alignRequired, rankTimeframes, epochStart, HIERARCHY, LONG_BEH, SHORT_BEH, RETEST_LONG_BEH, RETEST_SHORT_BEH, VWAP_RESETS_PT, PARAMS: Object.freeze({ SWEEP_PTS, SWEEP_LOOKBACK, STOP_BUF, MIN_TGT, PROJ_PTS, PERSIST_MS, MAX_TGT_ATR, RETEST_TOL, RETEST_AWAY, RETEST_HOLD, RETEST_WINDOW_MS }) };
