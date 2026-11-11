const jr = require('./journalReceipts');
const { checkConsumedAlignment } = require('./alignmentRuntime');
// Real-order state machine for the 3-leg shave, driven off ACTUAL account
// state (position size, open orders) rather than our own bar-by-bar
// simulation — once an entry is live, protective stops and targets are real
// resting orders on the exchange, so a crashed script never leaves the
// position naked. Every transition is inferred from a position-size CHANGE
// between polls, which is robust to exactly which order fired first.
//
// Phases:  FLAT -> PENDING_ENTRY -> LEG1_OPEN (N contracts, full stop resting)
//          -> LEG23_OPEN (N-1 contracts, breakeven stop + target2 limit resting)
//          -> LEG3_OPEN (N-2 contracts, breakeven/trailing stop resting) -> FLAT
//
// N (this.contracts) is set per trade at openEntry() — grade/score-based
// sizing, re-tuned 2026-09-22: leg1/leg2 sizes (and TP1's own distance) now
// depend on the size tier so TP1 banks a real $200 total either way (leg1=3
// of 5 on a base trade, leg1=6 of 15 on a grade trade) instead of a flat
// $30/contract regardless of size; whatever's left of the base 5/15 beyond
// leg1+leg2 goes to leg3, the trend-riding leg.
//
// If actual position size ever doesn't match what this phase expects, it
// sets `desynced: true` and stops taking any further action (still polls and
// logs) until the process is restarted — fail-safe over fail-silent, since a
// wrong assumption here would mean canceling or sizing an order incorrectly
// against a real account.

const { OrderType, OrderSide, placeOrder, cancelOrder, getOpenPosition, getOpenOrders, getEntryOrder } = require('./liveOrders');
const liveOrdersMod = require('./liveOrders');   // bf-exitsafe: searchOrdersSince read through the module (late-bound)
const POSITION_READ_ALERT_AFTER = 5;   // profittrail4: consecutive failed position reads before the one urgent alert
const { MECH_TRAIL_LOCK_DOLLARS, roundTrailStopConservative } = require('./simulate3leg');
const { runnerTrailOffset } = require('./riskRules');
const { profitLockPoints } = require('./riskRules');   // 10/18 RULE 3 (pure)
const { ptxFetch } = require('./bars');
const exits5m = require('./exits5m');   // exits5m r1 (pure)
const safeExit = require('./safeExit');   // bf-exitsafe: one outcome rule for every market exit
const edgeExits = require('./edgeExits');   // edge r1 (pure): early adverse exit + session runner rule
const fs = require('fs');
// FIX1015 (restart after TP1): the trade state is saved to a small JSON file (stateFile, next to the journal) after every public call that can change it, and
// restored at startup when the broker position matches it. Methods whose end state is saved:
const PERSIST_AFTER_ASYNC = ['openEntry', 'tick', 'recoverSavedPendingEntry', 'orphanEntryStep', 'cancelPendingForStartup', 'auditStopLadder', 'maybeRatchetTrail', 'maybeProfitLock', 'maybeSmartHoldExit', 'flattenNow', 'cancelEntryRequest', 'adoptExistingPosition', 'restoreFromState', 'sweepStaleStops', 'cancelPendingForBlackout', 'cancelPendingForStopTouch', 'cancelPendingForTargetTouch', 'cancelPendingForNews', 'cancelPendingForPause', 'handleReversedPosition', 'sessionFlatten', 'noProgressStep', 'levelLossStep', 'earlyAdverseStep'];   // np1; exits5m r1
const PERSIST_AFTER_SYNC = ['updateProfitTrail', 'reset', 'noteNoProgressPrices'];   // np1
const RESTORE_ENTRY_TOLERANCE_PTS = 1;   // broker averagePrice vs the saved entry fill: further apart than this = not the same trade
const OPEN_PHASES = ['LEG1_OPEN', 'LEG23_OPEN', 'LEG3_OPEN'];
// so1 r1.10: null = a usable trade-state record, else the reason it is not (MacDot 6357193156). Optional fields: absent/null or the right type.
const SAVED_PHASES = ['FLAT', 'PENDING_ENTRY', 'LEG1_OPEN', 'LEG23_OPEN', 'LEG3_OPEN', 'FLATTENING'];
// np1 r1.1: the no-progress check time = the close of the first FULL 5m candle after the first observation of the fill; the decision deadline after it.
const NP_DEADLINE_MS = 90000, NP_DECISIONS = ['exit', 'pass', 'unassessed', 'abandoned'];
function npCheckAt(fillAt) { return Math.floor(fillAt / 300000) * 300000 + 600000; }
function npHm(t) { return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) + ' UTC' : 'the 5m close'; }
// np1 r1.1 (MacDot 6380641991 #3): a restored no-progress record is used only when it is wholly consistent; otherwise the fill time is "not known" (the check then
// leaves the trade alone). npGap: anything but an explicit false = gapped. An 'exit' decision needs a finite checkAt; a sending marker is kept (the startup latch reads it).
function npRestore(st, now = Date.now()) {
  const fin = x => typeof x === 'number' && Number.isFinite(x), none = { npFillAt: null, npBestPts: null, npCoveredTo: null, npGap: true, npState: null, npLeftLeg1At: null, npDisabled: st && st.npDisabled === true };
  if (!st || !fin(st.npFillAt) || st.npFillAt > now + 60000) return none;
  const checkAt = npCheckAt(st.npFillAt), cov0 = Math.floor(st.npFillAt / 60000) * 60000 + 60000;
  if (!fin(st.npCoveredTo) || st.npCoveredTo < cov0 || st.npCoveredTo > checkAt || !(st.npBestPts === null || fin(st.npBestPts))) return none;
  let s = null;
  if (st.npState != null) {
    const o = st.npState;
    if (!o || typeof o !== 'object' || !NP_DECISIONS.includes(o.decided) || (o.decided === 'exit' && (!fin(o.checkAt) || o.checkAt !== checkAt)) || ('sending' in o && typeof o.sending !== 'boolean')) return none;
    s = o;
  }
  return { npFillAt: st.npFillAt, npBestPts: st.npBestPts, npCoveredTo: st.npCoveredTo, npGap: st.npGap !== false, npState: s, npLeftLeg1At: fin(st.npLeftLeg1At) ? st.npLeftLeg1At : null, npDisabled: st.npDisabled === true };
}
// exits5m r1: a restored trigger level is used only when wholly well formed (else null: the level-loss exit then leaves the trade alone)
function lossLevelRestore(o) {
  const fin = x => typeof x === 'number' && Number.isFinite(x);
  if (!o || typeof o !== 'object' || !fin(o.price) || (o.exitAt != null && !fin(o.exitAt))) return null;
  return { price: o.price, name: typeof o.name === 'string' ? o.name : null, jid: o.jid ?? null, ...(fin(o.exitAt) ? { exitAt: o.exitAt, close5m: fin(o.close5m) ? o.close5m : null, barT: fin(o.barT) ? o.barT : null } : {}) };
}
// edge r1: restored records are used only when wholly well formed (else null: the early exit leaves the trade alone / the runner is today's)
const EAE_DECISIONS = ['exit', 'log', 'keep', 'unassessed', 'abandoned'];
function eaeRestore(o) {
  const fin = x => typeof x === 'number' && Number.isFinite(x);
  if (!o || typeof o !== 'object' || !EAE_DECISIONS.includes(o.decided) || !fin(o.at)) return null;
  if (o.decided === 'exit' && !(fin(o.pts) && fin(o.close) && typeof o.reason === 'string')) return { decided: 'unassessed', at: o.at, why: 'the saved early-exit decision was not usable after a restart' };
  return { ...o };
}
function runnerPlanRestore(o) {
  const fin = x => typeof x === 'number' && Number.isFinite(x);
  if (!o || typeof o !== 'object' || !edgeExits.RUNNER_MODES.includes(o.mode)) return null;
  if (o.mode === 'atrTarget' && !(fin(o.stopPts) && o.stopPts >= 0 && fin(o.tp2) && fin(o.atr15) && o.atr15 > 0)) return null;
  return { ...o };
}
function tradeStateProblem(st) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) return 'not an object';
  if (st.v !== 1) return 'not a v1 trade state';
  if (!SAVED_PHASES.includes(st.phase)) return `unsupported phase ${JSON.stringify(st.phase)}`;
  const opt = (k, ok, what) => (st[k] == null || ok(st[k])) ? null : `${k} is not ${what} (${JSON.stringify(st[k])})`;
  const isStr = x => typeof x === 'string' && x.length > 0, isBool = x => typeof x === 'boolean', isNum = x => typeof x === 'number' && Number.isFinite(x), isInt0 = x => Number.isInteger(x) && x >= 0;
  if ('so1Halt' in st && !(st.so1Halt === null || isStr(st.so1Halt))) return `so1Halt is not null or a reason (${JSON.stringify(st.so1Halt)})`;
  const p = opt('desynced', isBool, 'a boolean') || opt('runnerArmed', isBool, 'a boolean') || opt('contractId', x => typeof x === 'string' || typeof x === 'number', 'a contract id')
    || opt('trailStop', isNum, 'a number') || opt('trailPeakPts', isNum, 'a number') || opt('stopPriceIntended', isNum, 'a number') || opt('target1', isNum, 'a number') || opt('target2', isNum, 'a number');
  if (p) return p;
  if (st.phase === 'PENDING_ENTRY' || OPEN_PHASES.includes(st.phase)) {
    if (st.dir !== 1 && st.dir !== -1) return `dir is not 1 or -1 (${JSON.stringify(st.dir)}) for phase ${st.phase}`;
    if (!(Number.isInteger(st.contracts) && st.contracts >= 1)) return `contracts is not a whole number >= 1 (${JSON.stringify(st.contracts)})`;
  }
  if (OPEN_PHASES.includes(st.phase)) {
    if (!isNum(st.entryPrice)) return `entryPrice is not a number (${JSON.stringify(st.entryPrice)})`;
    if (!isInt0(st.leg1Size) || !isInt0(st.leg2Size) || st.leg1Size + st.leg2Size > st.contracts) return `leg sizes are not valid (${JSON.stringify([st.leg1Size, st.leg2Size, st.contracts])})`;
  }
  return null;
}

// MNQ and MES both trade in 0.25-point ticks (confirmed against the
// terminal's own contract data: MNQ $0.50/tick ÷ $2/pt, MES $1.25/tick ÷
// $5/pt — both 0.25) — but MGC (Micro Gold) trades in 0.10-point ticks, and
// 0.25 is NOT an even multiple of 0.10. A real order rejected 2026-09-21
// with "Invalid price. Price is outside allowed range." traced back to
// exactly this kind of mismatch for MNQ; the SAME bug hit MGC on
// 2026-09-22 the moment a second instrument existed, because tick size was
// hardcoded instead of passed in per-instrument like pointValue already
// was. Now takes tickSize explicitly on every call — no silent default —
// so adding a third instrument can't quietly reintroduce this.
// TIME BLOCKS r1 (journal only): the block a window reason names. ASIA_OPEN_BLOCK 15:00-17:00 PT, NY_BLACKOUT 06:30-07:00 PT, MORNING_HOLD, SESSION_CLOSE.
function blockWindowCode(reason) {
  const r = String(reason || '');
  return /^morning hold/.test(r) ? 'MORNING_HOLD' : /^NY-open/.test(r) ? 'NY_BLACKOUT' : /^Asia/.test(r) ? 'ASIA_OPEN_BLOCK' : /^session close/.test(r) ? 'SESSION_CLOSE' : 'OTHER';
}
function roundToTick(price, tickSize) {
  const result = Math.round(price / tickSize) * tickSize;
  // Plain binary floating-point drift (2026-09-23): 0.10 tick (gold) isn't
  // exactly representable in binary, so this multiplication can land on
  // something like 4401.400000000001 instead of 4401.4 — displays fine via
  // toFixed(2) in a log line, but the exchange sees the untruncated number in
  // the real order JSON and correctly rejects it as an invalid tick multiple.
  // MNQ's 0.25 tick never showed this (0.25 IS exact in binary); snapping to
  // the tick size's own decimal precision fixes it for every tick size.
  const tickStr = tickSize.toString();
  const decimals = tickStr.includes('.') ? tickStr.split('.')[1].length : 0;
  return Number(result.toFixed(decimals));
}

// Marketable limit (2026-09-21, real live trade review): a true MARKET order
// for 15 contracts has to walk through more of the book than the 3-5 lot
// orders this was originally validated at — a real fill came back 3.75pts
// worse than the signal price ($112.50 of pure slippage on entry alone). A
// raw MARKET order has NO ceiling on how bad that can get. This prices an
// aggressive LIMIT instead: through the reference price by
// marketableLimitBufferPoints, essentially guaranteed to fill immediately in
// normal conditions (same as a market order would), but with a hard cap on
// the worst case instead of an open-ended one. If price is moving so fast
// even that buffer isn't enough, the order simply rests instead of chasing
// further — a safer failure mode than unlimited slippage.
// 10/16: pendingStopTouch / fillSlipDecision live in lib/pendingRules.js (pure, no I/O; shared with the paper path in live-executor.js).
const { pendingStopTouch, fillSlipDecision } = require('./pendingRules');
const stopFloor = require('./stopFloor');   // entry stop floor: the 6.1 post-fill stop + the fill-relative floor (pure)

function aggressiveLimitPrice(side, refPrice, buffer, tickSize) {
  return roundToTick(side === OrderSide.BUY ? refPrice + buffer : refPrice - buffer, tickSize);
}

class LiveStateMachine {
  alignmentFreshness() { try { return typeof this.alignmentFreshnessFn === 'function' ? this.alignmentFreshnessFn() : null; } catch (_) { return null; } }   // a throw = no state = refused
  constructor({ token, accountId, contractId, pointValue, tickSize = 0.25, log, notify, journal, profitLockDollars = null, profitLockPct = 0.5, marketableLimitBufferPoints = 0, pendingExpireMs = null, trailStepPoints = null, profitTrail = null, runnerTrailRule = null, journalIdFn = null, blackoutFn = null, stateFile = null, pendingCancelOnStopTouch = false, fillSlipGuard = null, entryStopFloorFn = null, entryStopFloorPlanFn = null, newsRestingFn = null, entryControlCheck = null, entryQuantityCheck = null, alignmentFreshnessFn = null, blockFn = null, restingBlockHorizonMs = 0, tp1FromFill = false, sessionRunnerFn = null }) {
    this.entryControlCheck = entryControlCheck;
    this.alignmentFreshnessFn = alignmentFreshnessFn;   // r8.1: live read-age state for the alignment checks below (null = none, as before)
    this.entryQuantityCheck = entryQuantityCheck;
    this.token = token;
    this.accountId = accountId;
    this.contractId = contractId;
    this.pointValue = pointValue;
    this.tickSize = tickSize;
    // Mac's runner trail (2026-10-08, bundle spec) — single knob, null (the
    // default) keeps the old level-gated ratchet; see maybeRatchetTrail.
    this.trailStepPoints = trailStepPoints;
    // so1 (Mac 10/22): { lockPts, stepPts } = after the scale-out the runner's stop is +lockPts, then trails lockPts behind the best price in stepPts steps
    // (riskRules.runnerTrailOffset). null = the trail above, unchanged.
    this.runnerTrailRule = runnerTrailRule && Number.isFinite(runnerTrailRule.lockPts) && Number.isFinite(runnerTrailRule.stepPts) && runnerTrailRule.stepPts > 0 ? { lockPts: runnerTrailRule.lockPts, stepPts: runnerTrailRule.stepPts } : null;
    this.lossLevel = null;   // exits5m r1 (change 5): { price, name, jid, exitAt?, close5m?, barT? } the trade's trigger level, set by the executor only while exitOnLevelLoss is on
    this.log = log;
    this.notify = notify || (() => {});
    // Trade journal (2026-09-22): a durable record of WHY each real entry
    // fired — MAC/Levels bias at that moment, source, grade — plus whether a
    // position was closed by the bot's own logic or a manual flatten. Broker
    // fills alone (what recentTrades/computeRecentTrades derive from) only
    // ever show WHAT happened financially, never WHY — this is what lets
    // that "what made money" question actually get answered later instead
    // of guessed at.
    this.journal = journal || (() => {});
    this.signalContext = null;
    this.phase = 'FLAT';
    this.desynced = false;
    this.dir = null; this.entryPrice = null; this.target1 = null; this.target2 = null;
    this.entryOrderId = null; this.stopOrderId = null; this.targetOrderId = null;
    // Mac's runner trail split (2026-10-08, bundle spec): leg3 gets its OWN
    // resting stop, separate from leg2's (stopOrderId) — see the LEG1_OPEN
    // and LEG23_OPEN transitions below. null whenever leg3 has no stop of
    // its own resting (not yet reached, or already closed).
    this.leg3StopOrderId = null;
    this.trailPeakPts = 0;
    // edge r1: (ts) => { session, mode, stopPts, tp2AtrMult, atr15, why } for a fill at ts; null = today's runner on every trade (nothing read, nothing journaled)
    this.sessionRunnerFn = typeof sessionRunnerFn === 'function' ? sessionRunnerFn : null;
    this.runnerPlan = null; this.eaeState = null; this.tp2RetryAt = 0;   // edge r1 per-trade records (saved with the trade)
    this.runnerArmed = false;   // so1 r1.1: true only once TP1 really filled (or the journal shows it banked); the runner rule acts only while armed
    this.source = null; this.grade = null;
    this.entrySignalTime = null;
    this.tightStopPrice = null; this.smartHoldChecked = false;
    this.contracts = null;
    // Peak unrealized $ this trade ever reached, tracked every poll cycle
    // while a position is open (see trackPeakUnrealized()) and journaled
    // once at close (reset()) so the mobile signal journal can show "was up
    // $X before it came back to breakeven/a loss" — the number the broker's
    // own fill history can never show, since it only ever sees the final exit.
    this.peakUnrealized = 0;
    // leg1Size/leg2Size (2026-09-21): how many contracts leg1/leg2 actually
    // close, instead of the old hardcoded 1 each — set per-trade at
    // openEntry(), mirrors simulate3leg.js's leg1SizeForContracts/
    // leg2SizeForContracts exactly so the live math matches what was
    // backtested.
    this.leg1Size = 1; this.leg2Size = 1;
    // Profit-lock (2026-09-21): bank a chunk on actual unrealized DOLLARS
    // instead of waiting for a fixed price level — see maybeProfitLock()
    // below. null/off by default.
    this.profitLockDollars = profitLockDollars; this.profitLockPct = profitLockPct;
    this.profitLocked = false; this.profitLocked2 = false;
    this.marketableLimitBufferPoints = marketableLimitBufferPoints;
    // PROFIT TRAIL (2026-10-13): whole-position profit-locking stop ladder, CONFIG.profitTrail = { enabled, beAtDollars, armDollars, lockDollars, stepDollars }. See updateProfitTrail().
    this.profitTrail = profitTrail && profitTrail.enabled ? { beAtDollars: profitTrail.beAtDollars ?? null, armDollars: profitTrail.armDollars ?? null, lockDollars: profitTrail.lockDollars ?? 0, stepDollars: profitTrail.stepDollars ?? null,
      // 10/18 RULE 3: unit 'points' = the same ladder in POINTS from entry (armPts/lockPts/stepPts/bePts), identical at every size; 'dollars' (or absent) = the old $ ladder
      unit: profitTrail.unit === 'points' ? 'points' : 'dollars', armPts: profitTrail.armPts ?? null, lockPts: profitTrail.lockPts ?? 0, stepPts: profitTrail.stepPts ?? null, bePts: profitTrail.bePts ?? null } : null;
    this.ptPeakPts = 0; this.profitTrailStop = null; this.profitTrailMoved = false;
    this.journalIdFn = journalIdFn; // TRADE LOG: () => journalId of the trade being managed (journal only)
    this.staleStops = new Map(); // hotfix 4b: order ids of OUR stops that should no longer exist but could not be cancelled yet: id -> { size, price, label, since, tries }
    this.failStreak = 0;         // hotfix 4b: consecutive failed stop repairs -> exponential back-off
    this.pendingExpireMs = pendingExpireMs;
    this.blockFn = blockFn;   // TIME BLOCKS r2: (ts) => null | reason, the EXACT block (no lead): exposure inside a block is reported
    this.restingBlockHorizonMs = restingBlockHorizonMs;   // TIME BLOCKS r2: a resting LIMIT/STOP entry is not admitted when a block starts within this horizon (its own life)
    this.blackoutFn = blackoutFn;   // BLACKOUT CANCEL: (ts) => null | reason; an unfilled resting entry is cancelled, and no entry is submitted, while this returns a reason (TIME BLOCKS r1: the executor includes the lead before a block)
    this.pendingCancelOnStopTouch = !!pendingCancelOnStopTouch;   // 10/16: cancel an unfilled entry once price has traded at/beyond its planned stop (CONFIG.pendingCancelOnStopTouch; false = old behaviour)
    this.entryStopFloorFn = typeof entryStopFloorFn === 'function' ? entryStopFloorFn : null;
    this.entryStopFloorPlanFn = typeof entryStopFloorPlanFn === 'function' ? entryStopFloorPlanFn : null;   // r2: (resting, ts) => largest floor over the order's transport lifetime from ts   // entry stop floor: (ts) => { session, pts } for a fill at ts; null = no floor
    this.fillSlipGuard = fillSlipGuard;   // 10/16 FILL-SLIPPAGE GUARD: { enabled, minPts, frac } (null = old behaviour: always shift)
    this.tp1FromFill = tp1FromFill === true;   // lv1 r13.3.5 (Mac 10/30): with the scale-out runner on, TP1 = the actual fill +/- the planned TP1 distance on every fill path
    this.sessionConfirmMs = 1000;   // 10/17 round 2 (QA B5): pause before the confirming re-read of a zero position during the session flatten (tests set 0)
    this.newsRestingFn = newsRestingFn;   // 10/16 NEWS: (ts) => null | { title, ms } = a high-impact release is due within newsCancelRestingSec: a resting LIMIT/STOP entry is pulled
    this.pendingStopTouched = null; // { price, t } once notePendingBars() saw the planned stop traded while PENDING_ENTRY (sticky until the machine leaves PENDING_ENTRY)
    this.cancelReason = null;       // set when the machine cancels its own pending entry for a reason the executor should journal (read once via takeCancelReason)
    // FIX1015: persist the trade state after every call that can change it (only when a stateFile is given; the smoke tests that build a bare machine are unchanged)
    this.stateFile = stateFile; this._lastStateJson = null;
    if (this.stateFile) {
      for (const m of PERSIST_AFTER_ASYNC) { const f = this[m]; this[m] = async function (...a) { try { return await f.apply(this, a); } finally { this.saveState(); } }; }
      for (const m of PERSIST_AFTER_SYNC) { const f = this[m]; this[m] = function (...a) { try { return f.apply(this, a); } finally { this.saveState(); } }; }
    }
  }

  // 18f1 F5 (NOTIFICATION ONLY): the two alerts that repeat on every poll while a market exit keeps failing / stays unconfirmed. One push per position
  // and kind per 60 s; the next push says how many were held back. Reads and writes only this._notifyThrottle (never persisted, never read by an order path).
  _notifyThrottled(kind, title, msg, opts) {
    try {
      const now = Date.now(), pos = `${this.dir}|${this.entrySignalTime || ''}|${this.intendedEntryPrice ?? this.entryPrice ?? ''}`;
      if (!this._notifyThrottle || this._notifyThrottle.pos !== pos) this._notifyThrottle = { pos, kinds: {} };
      const k = this._notifyThrottle.kinds[kind] || (this._notifyThrottle.kinds[kind] = { last: 0, held: 0 });
      if (now - k.last < 60000) { k.held++; return; }
      const held = k.held; k.last = now; k.held = 0;
      this.notify(held ? `${title} (x${held + 1} in the last ${Math.max(1, Math.round((now - (k.prev || now)) / 1000))} s)` : title, held ? `${msg} [${held} more of these were held back since the last push]` : msg, opts);
      k.prev = now;
    } catch (e) { /* notification only */ }
  }

  // ── FIX1015: trade-state persistence (restart after TP1) ──
  stateSnapshot() {
    return {
      v: 1, contractId: this.contractId, accountId: this.accountId, phase: this.phase, desynced: !!this.desynced, so1Halt: this._so1HaltWhy || null, dir: this.dir,
      entryPrice: this.entryPrice, contracts: this.contracts, leg1Size: this.leg1Size, leg2Size: this.leg2Size,
      target1: this.target1, target2: this.target2, stopPriceIntended: this.stopPriceIntended ?? null,
      trailStop: this.trailStop ?? null, trailPeakPts: this.trailPeakPts || 0, runnerArmed: !!this.runnerArmed, profitTrailStop: this.profitTrailStop ?? null, ptPeakPts: this.ptPeakPts || 0,
      stopOrderId: this.stopOrderId ?? null, targetOrderId: this.targetOrderId ?? null, leg3StopOrderId: this.leg3StopOrderId ?? null, entryOrderId: this.entryOrderId ?? null,
      tp1Filled: this.phase === 'LEG23_OPEN' || this.phase === 'LEG3_OPEN', source: this.source ?? null, grade: this.grade ?? null,
      sessionExit: this.sessionExit ?? null, peakUnrealized: this.peakUnrealized || 0, profitLocked: !!this.profitLocked, profitLocked2: !!this.profitLocked2,
      npFillAt: this.npFillAt ?? null, npBestPts: this.npBestPts ?? null, npCoveredTo: this.npCoveredTo ?? null, npGap: !!this.npGap, npState: this.npState ?? null, flattenKind: this.flattenKind ?? null,   // np1
      npLeftLeg1At: this.npLeftLeg1At ?? null, npDisabled: !!this.npDisabled,   // np1 r1.1 (outcome categories)
      ...(this.phase === 'PENDING_ENTRY' ? { pendingEntry: { entryType: this.entryType ?? null, intendedEntryPrice: this.intendedEntryPrice ?? null, entrySignalTime: this.entrySignalTime ?? null, tightStopPrice: this.tightStopPrice ?? null,
        protection: { ids: [...(this._cancelProtectionIds || [])].map(String), unknown: !!this._cancelProtectionUnknown, intent: this._cancelProtectionIntent ?? null },
        fillPlan: this._fillPlanBase || this._cancelFillPlan || null, fillFloorRead: this._fillFloor !== undefined, fillFloor: this._fillFloor ?? null, planFloor: this._planFloor ?? null } } : {}),   // TIME BLOCKS r2/r3/r4; combined build: the stop floor's plan base + floor read
      ...(this._orphanEntry ? { orphanEntry: { ...this._orphanEntry } } : {}),   // TIME BLOCKS r3: an unresolved old entry id survives ordinary ticks and a second restart
      ...(this.lossLevel ? { lossLevel: { ...this.lossLevel } } : {}),   // exits5m r1: only while exitOnLevelLoss set it (absent when off = the file as before)
      ...(this.eaeState ? { eaeState: { ...this.eaeState } } : {}), ...(this.runnerPlan ? { runnerPlan: { ...this.runnerPlan } } : {}),   // edge r1: absent when the rules are off / live = the file as before
      ...(this.exitInFlight ? { exitInFlight: { ...this.exitInFlight } } : {}), ...(this.exitAttempts > 0 ? { exitAttempts: this.exitAttempts } : {}),   // bf-exitsafe: written BEFORE the market exit goes out
    };
  }

  // Never throws. Writes only when something changed (tmp file + rename, so a crash mid-write never leaves half a file).
  // TIME BLOCKS r5: returns true when the file holds the current state (written now, or already identical) or no state file is configured; false when the
  // write or the rename failed (the file still holds the previous state). Ordinary callers ignore it; the protective-STOP checkpoint requires it.
  saveState() {
    if (!this.stateFile) return true;
    if (this.phase === 'FLAT' && !this._stateArmed) return true;   // a fresh process never overwrites the saved trade before startup has had the chance to resume it
    if (this._haltLatched) return true;   // so1 r1.6: a latched halt keeps the saved (halted) trade state untouched until it is resolved
    this._stateArmed = true;
    try {
      const snap = this.stateSnapshot(), j = JSON.stringify(snap);
      if (j === this._lastStateJson) return true;
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...snap, savedAt: Date.now() }));
      fs.renameSync(tmp, this.stateFile);
      this._lastStateJson = j;
      if (this._so1HaltWhy && snap.so1Halt) this._haltLatched = true;   // r1.7: a retried halt save that succeeded pins it now
      return true;
    } catch (e) { try { this.log(`  [state] could not save the trade state (${e.message}) - non-fatal.`); } catch (e2) { /* never throws */ } return false; }
  }

  // so1 r1.6 (MacDot 6356940590): called once at startup BEFORE any recovery. Returns { latched, cleared, why }.
  async so1HaltLatch() {
    let st = null, bad = null;
    if (this.stateFile) {
      try { const txt = fs.readFileSync(this.stateFile, 'utf8'); try { st = JSON.parse(txt); } catch (e) { bad = 'invalid JSON (' + e.message + ')'; } if (!bad) { const sp = tradeStateProblem(st); if (sp) bad = 'malformed (' + sp + ')'; } }   // r1.10: schema, not just the version marker
      catch (e) { if (e.code !== 'ENOENT') bad = 'unreadable (' + (e.code || e.message) + ')'; }
    }
    if (bad && this.runnerTrailRule) st = { so1Halt: `the saved trade state is ${bad} - it cannot prove there is nothing to resolve` };   // r1.7: fail closed
    if (st && !bad && !st.so1Halt && st.exitInFlight && typeof st.exitInFlight === 'object') {   // bf-exitsafe: a market exit was in flight at the stop - the same settle rule as in-session
      const r = await this._startupExitInFlight(st);
      if (r.done) return r.result;
      st = r.st;
    }
    if (st && !st.so1Halt && st.npState && typeof st.npState === 'object' && st.npState.sending === true) st = { ...st, so1Halt: `a no-progress market exit (${st.npState.size ?? '?'}x) was being sent or confirmed when the bot stopped - its outcome is unknown` };   // np1 r1.1 #2
    if (st && !st.so1Halt && st.npState && typeof st.npState === 'object' && st.npState.recovering) st = { ...st, so1Halt: `a no-progress recovery stop (${st.npState.recovering.size ?? '?'}x @ ${st.npState.recovering.lvl ?? '?'}) was being sent when the bot stopped - its outcome is unknown` };   // np1 r1.3
    if (!st || !st.so1Halt) return { latched: false };
    let pos = null, orders = null;
    try { pos = await getOpenPosition(this.token, this.accountId, this.contractId); orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { orders = null; }
    const flat = orders != null && !(pos && pos.size), none = orders != null && orders.length === 0;
    if (flat && none) {
      this._stateArmed = true; this._haltLatched = false; this._so1HaltWhy = null; this.desynced = false; this.phase = 'FLAT'; this._lastStateJson = null;
      const rewritten = this.saveState() === true;   // r1.10: reported, not assumed
      this.log(`  [state] so1 halt from the previous run is RESOLVED: the account is flat with no open orders on ${this.contractId} (was: ${st.so1Halt}). Normal operation resumes.${rewritten ? ' The saved state was rewritten as FLAT.' : ' WARNING: the clean FLAT state could NOT be written - the old file remains; the next startup checks the broker again.'}`);
      try { this._manage('HALT_RESOLVED', `The earlier halt (${st.so1Halt}) is resolved: the broker shows no position and no open orders, so the bot resumes normally.`, { so1: true }); } catch (e2) { /* journal only */ }
      return { latched: false, cleared: true, rewritten, why: st.so1Halt };
    }
    this.desynced = true; this._haltLatched = true; this._so1HaltWhy = st.so1Halt;
    const what = orders == null ? 'the broker position/orders could not be read' : `the broker shows ${pos && pos.size ? `${pos.size}x ${pos.type === 1 ? 'LONG' : 'SHORT'}` : 'no position'} and ${orders.length} open order(s)`;
    this.log(`  [state] so1 HALT still latched from the previous run (${st.so1Halt}); ${what}. Nothing is adopted, cancelled or placed. Flatten and cancel by hand in the platform, then restart.`);
    this.notify('HALTED — still waiting for you', `The halt from before the restart is still active (${st.so1Halt}); ${what}. The bot will not trade or touch orders until the account is flat with no open orders. Fix it in the platform, then restart.`, { priority: 'urgent', tags: 'rotating_light' });
    try { this._manage('DESYNC', `so1 halt still latched after a restart (${st.so1Halt}); ${what}. No automatic adoption.`, { so1: true }); } catch (e2) { /* journal only */ }
    return { latched: true, why: st.so1Halt };
  }
  // bf-exitsafe RULE 4: the bot stopped while a market exit was in flight (sent, reply unknown, or accepted but flat never confirmed). Called by so1HaltLatch at
  // startup BEFORE any recovery. The same settle rule as in-session: flat = the exit filled (leftovers swept, state written FLAT); the same position with
  // nothing working = the exit did not happen (the marker is cleared and the normal restore re-places the missing stop / TP; the K cap is kept);
  // anything else (other size, opposite side, never settles, unreadable) = a latched HALT with an urgent alert. Returns { done, result } or { done: false, st }.
  async _startupExitInFlight(st) {
    const x = st.exitInFlight, dir = x.dir === 1 || x.dir === -1 ? x.dir : st.dir, size = Number.isInteger(x.size) && x.size > 0 ? x.size : null;
    const T = { 'no-progress': 'no-progress exit', 'level-loss': 'level-loss exit', 'early-adverse': 'early adverse exit', 'morning-hold': 'morning-hold close', 'session-close': 'session close', manual: 'manual flatten', 'through-stop': 'filled-through-stop exit' }[x.kind] || 'market exit';   // r1.1: + manual, through-stop
    const write = obj => { try { const tmp = this.stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ ...obj, savedAt: Date.now() })); fs.renameSync(tmp, this.stateFile); return true; } catch (e) { this.log(`  [state] could not write the trade state (${e.message}).`); return false; } };
    const halt = why => {
      this.desynced = true; this._so1HaltWhy = why; this._haltLatched = write({ ...st, so1Halt: why });
      this.log(`  [exit-safety] HALT at startup: ${why}. Nothing is adopted, cancelled or placed. Flatten and cancel by hand in the platform, then restart.`);
      this.notify(`Restart: ${T} outcome UNKNOWN - FLATTEN IN TOPSTEPX NOW`, `The bot restarted while a ${T} (${size ?? '?'}x) was in flight and ${why.replace(/^.*?; /, '')}. It has HALTED: no new entries, no orders. Use Flatten / Close position in TopstepX, then restart.`, { priority: 'urgent', tags: 'rotating_light' });
      try { this._manage('EXIT_HALT', `Exit safety halt at startup: ${why}.`, { exitInFlight: x }); } catch (e2) { /* journal only */ }
      return { done: true, result: { latched: true, why } };
    };
    if (!dir || !size || !OPEN_PHASES.concat(['FLATTENING'], x.kind === 'through-stop' ? ['PENDING_ENTRY'] : []).includes(st.phase)) return halt(`a ${T} was in flight at the restart but its record is not usable (${JSON.stringify(x).slice(0, 120)})`);
    this.log(`  [exit-safety] startup: a ${T} (${size}x, outcome ${x.outcome}) was in flight when the bot stopped - reading the broker until it settles before anything else.`);
    let r = await safeExit.settle(this._settleIo(), dir, size, this._settleOpts());
    if (r.verdict === 'flat' && r.orders.length) { await this.cancelAllOrdersForContract(); r = await safeExit.settle(this._settleIo(), dir, size, this._settleOpts()); if (r.verdict === 'flat' && r.orders.length) r = { ...r, verdict: 'unsettled' }; }
    if (x.outcome !== 'accepted') r = await this._confirmNotFilled(r, dir, size, Number.isFinite(x.at) ? x.at : Date.now() - 600000);
    const ex = { kind: x.kind, size, verdict: r.verdict, net: r.net, reads: r.reads.length, outcome: x.outcome };
    if (r.verdict === 'flat') {
      this._stateArmed = true; this.phase = 'FLAT'; this._lastStateJson = null; const rewritten = this.saveState() === true;
      this.log(`  [exit-safety] startup: the ${T} filled - the account is flat with no working orders. Starting FLAT${rewritten ? '' : ' (WARNING: the FLAT state could not be written)'}.`);
      try { this._manage('EXIT_UNKNOWN_RESOLVED', `After a restart: the ${T} that was in flight DID fill; the broker is flat with no working orders. Nothing else was sent.`, ex); } catch (e2) { /* journal only */ }
      this.notify(`Restart: ${T} confirmed flat`, `The bot restarted during the ${T}; the broker is flat with no working orders. Nothing else was sent.`, { tags: 'checkered_flag' });
      return { done: true, result: { latched: false, cleared: true, rewritten, why: `${T} in flight` } };
    }
    if (r.verdict === 'same') {
      const { exitInFlight, ...rest } = st, st2 = { ...rest, phase: OPEN_PHASES.includes(st.phase) ? st.phase : 'LEG1_OPEN', ...(st.npState && typeof st.npState === 'object' ? { npState: { ...st.npState, sending: false } } : {}) };
      if (!OPEN_PHASES.includes(st.phase)) return halt(`a ${T} was in flight or accepted before the restart and the broker still shows ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x`);
      if (!write(st2)) return halt(`a ${T} was in flight at the restart; the broker still shows the position but the cleared state could not be written`);
      this.log(`  [exit-safety] startup: the ${T} did NOT fill (the broker shows the same ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x, nothing working) - resuming the trade; its stop/TP are re-placed by the restore and the exit is retried by its owner (${st.exitAttempts || 0}/${safeExit.EXIT_MAX_ATTEMPTS} attempts used).`);
      try { this._manage('EXIT_UNKNOWN_NOT_FILLED', `After a restart: the ${T} that was in flight did NOT fill; the broker shows the same position with nothing working. The trade is resumed with its protection; the exit is retried within its cap.`, ex); } catch (e2) { /* journal only */ }
      return { done: false, st: st2 };
    }
    const what = r.verdict === 'unsettled' ? (r.why || `the broker position/orders did not settle within ${safeExit.SETTLE_MAX_MS / 1000} s`) : r.verdict === 'opposite' ? `the broker shows the OPPOSITE side (${r.net > 0 ? 'LONG' : 'SHORT'} ${Math.abs(r.net)}x)` : `the broker shows ${Math.abs(r.net)}x instead of ${size}x or flat`;
    return halt(`a ${T} (${size}x) was in flight at the restart; ${what}`);
  }
  loadState() {
    if (!this.stateFile) return null;
    try { if (!fs.existsSync(this.stateFile)) return null; const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return st && st.v === 1 ? st : null; }
    catch (e) { this.log(`  [state] trade state file unreadable (${e.message}) - ignoring it.`); return null; }
  }

  // Startup: resume the trade the saved state describes, if the broker position is that trade (same contract, side, size and entry price). Keeps the stops and
  // targets that still rest, re-places only what is missing, cancels only orders it does not know. After TP1 every stop it places is at break-even or better
  // (no widen-from-entry fallback). Returns { ok: true } when resumed, else { ok: false, why } and changes nothing (the caller then adopts as before).
  async restoreFromState(pos) {
    const st = this.loadState();
    const no = why => { this.log(`  [state] not resuming from the saved trade state: ${why}.`); return { ok: false, why }; };
    this._stateArmed = true;
    if (!st) return no('no saved trade state');
    if (st.savedAt && Date.now() - st.savedAt > 7 * 86400000) return no('the saved trade state is more than 7 days old');
    if (this.phase !== 'FLAT') return no(`the machine is already ${this.phase}`);
    if (st.contractId !== this.contractId) return no(`saved for another contract (${st.contractId})`);
    if (!OPEN_PHASES.includes(st.phase)) return no(`saved phase is ${st.phase}`);
    if (st.so1Halt) { this.desynced = true; this._haltLatched = true; this._so1HaltWhy = st.so1Halt; return { ok: false, halted: true, why: 'the saved trade is an so1 halt: ' + st.so1Halt }; }   // so1 r1.6
    if (st.desynced) return no('the saved trade was desynced');
    if (!pos || !pos.size) return no('the broker shows no position');
    const posDir = pos.type === 1 ? 1 : pos.type === 2 ? -1 : null;
    if (posDir !== st.dir) return no(`side differs (broker ${posDir === 1 ? 'LONG' : 'SHORT'}, saved ${st.dir === 1 ? 'LONG' : 'SHORT'})`);
    const leg3Size = st.contracts - st.leg1Size - st.leg2Size;
    const expected = st.phase === 'LEG1_OPEN' ? st.contracts : st.phase === 'LEG23_OPEN' ? (st.stopOrderId != null ? st.leg2Size : 0) + (st.leg3StopOrderId != null ? leg3Size : 0) : leg3Size;
    if (pos.size !== expected) return no(`size differs (broker ${pos.size}x, saved ${st.phase} expects ${expected}x)`);
    if (pos.averagePrice != null && Math.abs(pos.averagePrice - st.entryPrice) > RESTORE_ENTRY_TOLERANCE_PTS) return no(`entry differs (broker ${pos.averagePrice}, saved ${st.entryPrice})`);
    let orders;
    try { orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { return no(`open orders unreadable (${e.message})`); }
    // restore every field
    this.dir = st.dir; this.entryPrice = st.entryPrice; this.intendedEntryPrice = st.entryPrice; this.contracts = st.contracts; this.leg1Size = st.leg1Size; this.leg2Size = st.leg2Size;
    this.target1 = st.target1; this.target2 = st.target2; this.stopPriceIntended = st.stopPriceIntended; this.trailStop = st.trailStop; this.trailPeakPts = st.trailPeakPts || 0; this.runnerArmed = !!st.runnerArmed;
    this.profitTrailStop = this.profitTrail ? st.profitTrailStop : null; this.ptPeakPts = st.ptPeakPts || 0;
    this.stopOrderId = st.stopOrderId; this.targetOrderId = st.targetOrderId; this.leg3StopOrderId = st.leg3StopOrderId; this.entryOrderId = null;
    this.source = st.source; this.grade = st.grade; this.sessionExit = st.sessionExit; this.peakUnrealized = st.peakUnrealized || 0;
    this.profitLocked = !!st.profitLocked; this.profitLocked2 = !!st.profitLocked2; this.tightStopPrice = null; this.smartHoldChecked = true;
    Object.assign(this, npRestore(st)); this.flattenKind = st.flattenKind === 'no-progress' ? 'no-progress' : st.flattenKind === 'level-loss' ? 'level-loss' : st.flattenKind === 'manual' ? 'manual' : st.flattenKind === 'early-adverse' ? 'early-adverse' : null; this.eaeState = eaeRestore(st.eaeState); this.runnerPlan = runnerPlanRestore(st.runnerPlan); this.pxBoundaryAt = Date.now();   // (edge r1.1, review S3: pxBoundaryAt is a live statement again) r1.1: an unfinished manual flatten survives a restart; edge r1: + the early exit and the runner plan   // r1.5: without a valid restored fill time, prices from after the restore only   // np1 r1.1: the whole record validated (npRestore)
    this.lossLevel = lossLevelRestore(st.lossLevel);   // exits5m r1 (null when absent or malformed)
    // edge r1.1 (review S2): a saved early-exit decision whose market order never went out (no exit intent on disk, no attempt counted, the stop still tracked)
    // and that is older than EAE_SEND_MAX_MS is NOT executed after a restart: it expires and the trade keeps its stop, TP1 and np1.
    if (this.eaeState && this.eaeState.decided === 'exit' && st.phase === 'LEG1_OPEN' && !st.exitInFlight && !(Number.isInteger(st.exitAttempts) && st.exitAttempts > 0) && st.stopOrderId != null
      && Date.now() - this.eaeState.at > edgeExits.EAE_SEND_MAX_MS) { if (this.flattenKind === 'early-adverse') this.flattenKind = null; this._eaeExpire(Date.now(), 'restart'); }
    this.exitAttempts = Number.isInteger(st.exitAttempts) && st.exitAttempts > 0 ? st.exitAttempts : 0;   // bf-exitsafe: the K cap spans restarts
    this.phase = st.phase;
    const byId = new Map(orders.map(o => [String(o.id), o]));
    const has = id => id != null && byId.has(String(id));
    // tracked orders of this phase: [field, size, kind]
    const tracked = [];
    if (st.phase === 'LEG1_OPEN') tracked.push(['stopOrderId', st.contracts, 'stop'], ['targetOrderId', st.leg1Size, 'tp1']);
    else if (st.phase === 'LEG23_OPEN') {
      if (st.stopOrderId != null) tracked.push(['stopOrderId', st.leg2Size, 'be'], ['targetOrderId', st.leg2Size, 'tp2']);
      if (st.leg3StopOrderId != null) tracked.push(['leg3StopOrderId', leg3Size, 'runner']);
      if (st.stopOrderId == null && st.leg3StopOrderId != null && this._atrRunner()) tracked.push(['targetOrderId', leg3Size, 'tp2r']);   // edge r1: the ATR runner's TP2 limit is this trade's order
    } else tracked.push(['stopOrderId', leg3Size, 'runner']);
    const keep = new Set(tracked.map(([f]) => this[f]).filter(has).map(String));
    for (const o of orders) {
      if (keep.has(String(o.id))) continue;
      let okc = false; try { okc = await cancelOrder(this.token, this.accountId, o.id); } catch (e) { okc = false; }
      this.log(`  [state] resume: cancelled order ${o.id} (${o.size ?? '?'}x) that the saved trade does not know${okc ? '' : ' - cancel FAILED'}.`);
    }
    const entry = roundToTick(this.entryPrice, this.tickSize), long = this.dir === 1;
    const lock = lvl => (this.profitTrailStop == null ? lvl : long ? Math.max(lvl, this.profitTrailStop) : Math.min(lvl, this.profitTrailStop));
    const beOrBetter = lvl => roundToTick(lock(lvl == null ? entry : long ? Math.max(lvl, entry) : Math.min(lvl, entry)), this.tickSize);
    let refPrice = null;
    const replaced = [];
    for (const [field, size, kind] of tracked) {
      if (has(this[field])) continue;
      if (size <= 0) { this[field] = null; continue; }
      try {
        if (kind === 'stop') { this[field] = await this.placeProtectiveStop(size, lock(roundToTick(this.stopPriceIntended, this.tickSize))); replaced.push(`stop ${size}x`); }
        else if (kind === 'tp1') { this[field] = await this.placeTargetLimit(size, this.target1); replaced.push(`TP1 ${size}x`); }
        else if (kind === 'tp2') { this[field] = await this.placeTargetLimit(size, this.target2); replaced.push(`TP2 ${size}x`); }
        else if (kind === 'tp2r') { this[field] = null; this.tp2RetryAt = 0; replaced.push(`runner TP2 ${size}x (re-placed by the next poll, after an order-list check)`); }   // edge r1: never placed blind here
        else {
          // after TP1: break-even or better, never the widen-from-entry fallback; a market already through the level exits those contracts (what the stop would do)
          if (refPrice == null) refPrice = await this.trailRefPrice(this.entryPrice);
          const lvl = beOrBetter(kind === 'runner' ? this.trailStop : entry);
          this[field] = null;
          const r = await this.replaceStopSafely(field, size, lvl, refPrice, null, kind === 'runner' ? 'runner stop' : 'leg2 break-even stop');
          if (!r.ok && !r.exited) this[field] = `missing-${field}`;   // keeps the leg counted as open; the ladder audit retries it every poll
          if (kind === 'runner' && r.ok) this.trailStop = r.lvl;
          replaced.push(`${kind === 'runner' ? 'runner stop' : 'leg2 stop'} ${size}x ${r.ok ? '@ ' + r.lvl.toFixed(2) : r.exited ? 'exited at market' : 'NOT placed yet'}`);
        }
      } catch (e) { this.log(`  [state] resume: could not re-place the ${kind} order (${e.message}); the ladder audit / next poll retries.`); }
    }
    const desc = `${this.dir === 1 ? 'LONG' : 'SHORT'} ${pos.size}x @ ${this.entryPrice.toFixed(2)}, phase ${this.phase}${this.phase !== 'LEG1_OPEN' ? ' (TP1 already banked)' : ''}`;
    this.log(`  [state] RESUMED the saved trade after a restart: ${desc}; kept ${keep.size} resting order(s)${replaced.length ? `, re-placed: ${replaced.join(', ')}` : ''}.`);
    this.notify('Position resumed after restart', `${desc}. Stops and targets kept as they were${replaced.length ? ` (re-placed: ${replaced.join(', ')})` : ''}.`, { priority: 'high', tags: 'shield' });
    try { this._manage('RESUMED', `After a restart the bot found its own trade (${desc}) and resumed managing it from the saved state: the same stops, targets, runner trail and profit lock as before the restart.`, { phase: this.phase }); } catch (e2) { /* journal only */ }
    // bring every stop to its intended level (never loosens anything; a stop worse than intended is repaired)
    try { await this.auditStopLadder(refPrice != null ? refPrice : await this.trailRefPrice(this.entryPrice)); } catch (e) { /* the main loop audits again */ }
    return { ok: true };
  }

  takeCancelReason() { const r = this.cancelReason; this.cancelReason = null; return r; }

  // TRADE LOG (journal only): one 'trade_manage' row per management event: a reason code + one plain-English sentence, keyed by the trade's journalId.
  // Never throws and is never read by any order logic.
  _manage(code, text, extra = {}) {
    try { this.journal({ type: 'trade_manage', t: Date.now(), journalId: this.journalIdFn ? this.journalIdFn() : null, code, text, dir: this.dir, phase: this.phase, ...extra }); } catch (e) { /* journal only */ }
  }

  sideFor(dir, closing) {
    // closing=true means the order that REDUCES the position (opposite side
    // of the entry direction) — used for every stop/target exit order.
    const isBuy = closing ? dir === -1 : dir === 1;
    return isBuy ? OrderSide.BUY : OrderSide.SELL;
  }

  // tightStopPrice (optional): when smart-stop-hold is on, `stopPrice` is
  // the WIDE grace-ceiling distance actually resting on the exchange (the
  // real, always-on safety net — never removed), and `tightStopPrice` is the
  // original tighter reference used only to decide whether to CUT LOSSES
  // EARLY via a market order once Levels PRO's own classification confirms
  // a real break of structure. See maybeSmartHoldExit() for why this can't
  // work the other way around (widening a resting order after it's touched
  // isn't possible — it would have already filled).
  async openEntry({ dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, source, grade, contracts = 3, leg1Size = 1, leg2Size = 1, signalContext = null, sessionExit = null }) {
    jr.note(this, 'ADMISSION_STARTED', { phaseObservation: this.phase, result: this.phase === 'FLAT' ? 'CONTINUE' : 'REFUSED_NOT_FLAT' }, signalContext?.journalId);
    if (this.phase !== 'FLAT') { this.log(`  [live] refused to open entry — not FLAT (phase=${this.phase})`); return; }
    const side = this.sideFor(dir, false);
    const useMarketableLimit = entryType === 'MARKET' && this.marketableLimitBufferPoints > 0;
    const type = useMarketableLimit ? OrderType.LIMIT : entryType === 'MARKET' ? OrderType.MARKET : entryType === 'LIMIT' ? OrderType.LIMIT : OrderType.STOP;
    const roundedEntryPrice = useMarketableLimit ? aggressiveLimitPrice(side, entryPrice, this.marketableLimitBufferPoints, this.tickSize)
      : entryType === 'MARKET' ? entryPrice : roundToTick(entryPrice, this.tickSize);
    const body = { accountId: this.accountId, contractId: this.contractId, type, side, size: contracts };
    if (type === OrderType.LIMIT) body.limitPrice = roundedEntryPrice;
    if (type === OrderType.STOP) body.stopPrice = roundedEntryPrice;
    this.log(`  [LIVE ORDER] placing ${useMarketableLimit ? 'MARKETABLE-LIMIT' : entryType} entry: ${dir === 1 ? 'BUY' : 'SELL'} ${contracts}x @ ${type === OrderType.MARKET ? 'market' : roundedEntryPrice.toFixed(2)}`);
    // Explicit failure alert (2026-09-22): the phone's "Signal" push fires
    // BEFORE this placement attempt (live-executor.js announces intent as
    // soon as it decides to trade) — without this, a rejected order (bad
    // price, margin, anything) used to fail silently into the main loop's
    // generic catch-all logger, leaving you with a "trade" notification and
    // then nothing, no explanation. This is exactly what a tick-size
    // mismatch on a newly-added instrument did for real on 2026-09-22.
    jr.note(this, 'TRANSPORT_INTENT', { roundedTransportGeometry: { type, side, size: contracts, entryPrice: roundedEntryPrice, stopPrice: roundToTick(stopPrice, this.tickSize), target1: roundToTick(target1, this.tickSize), target2: roundToTick(target2, this.tickSize) }, statement: 'Rounded transport intent; no acknowledgement or fill yet.' }, signalContext?.journalId);
    // TIME BLOCKS r1: no entry is submitted inside a time block or within the lead before one (checked here and again right before the raw send).
    const windowRefusal = () => this.blackoutFn ? this.blackoutFn(Date.now()) : null;
    const refuseWindow = (why, seam) => { this.log(`  [live] entry NOT placed: ${why} (${seam}).`); this._manage('ENTRY_REFUSED_WINDOW', `The ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} entry was not sent: ${why}. Entries are blocked in this window; exits and protection are unaffected.`, { journalId: signalContext?.journalId ?? (this.journalIdFn ? this.journalIdFn() : null), dir, window: blockWindowCode(why), reason: why, seam, entryType }); };
    // TIME BLOCKS r2: a resting LIMIT/STOP entry lives until it fills, expires (pendingExpireMs) or is cancelled; it is not admitted when a block starts
    // within that life (sampled every 30 s up to restingBlockHorizonMs; blocks last >= 30 min). r3: only a true MARKET order is exempt.
    const restingRefusal = () => {
      if (type === OrderType.MARKET || !this.blackoutFn || !(this.restingBlockHorizonMs > 0)) return null;   // r3: the TRANSPORT type (a marketable LIMIT can rest: no IOC/FOK)
      const t0 = Date.now(), H = this.restingBlockHorizonMs;
      for (let dt = 0; ; dt = Math.min(H, dt + 30000)) { const r = this.blackoutFn(t0 + dt); if (r) return `${String(r).replace(/ - starts within.*$/, '')} starts within this resting entry's life (about ${Math.round(dt / 1000)} s from now, life ${Math.round(H / 1000)} s)`; if (dt >= H) return null; }
    };
    let d, lateWindow = null, planNeed = null;   // r3: the floor this order was admitted for (largest over its transport lifetime at the last coverage check)
    try {
      { const w = windowRefusal(); if (w) { refuseWindow(w, 'initial'); return; } }
      { const w = restingRefusal(); if (w) { refuseWindow(w, 'resting-life'); return; } }   // TIME BLOCKS r2: no resting entry whose life reaches a block
      const alignment = jr.verdict(this, signalContext?.journalId, 'initial', 'alignment', checkConsumedAlignment({ source, context:signalContext, nowMs:Date.now(), freshness:this.alignmentFreshness() }));
      if (!alignment.ok) { this.log('[alignment] entry blocked at final submit: ' + alignment.reasonCodes.join(', ')); return; }
      const controlAllowed = () => this.entryControlCheck === null || (typeof this.entryControlCheck === 'function' && this.entryControlCheck(dir, source, signalContext) === true);
      // Assert the frozen legs/quantity against rounded transport geometry after every auth await.
      // r2 (MacDot 6330538954 #2): the frozen stop must still cover the largest session floor over THIS transport's lifetime from now (a true MARKET 60 s,
      // a resting order pendingExpireMs + 60 s). Checked at the initial seam and again right before the raw send after every await; a plan that no longer
      // covers it is refused (nothing sent) and the next evaluation replans. An unreadable floor refuses too (fail closed).
      let floorRefused = false;
      const floorCovered = () => {
        if (!this.entryStopFloorPlanFn) return true;
        let need = null, err = null; try { need = this.entryStopFloorPlanFn(type !== OrderType.MARKET, Date.now()); } catch (e) { err = e; }
        if (!err && need == null) return true;   // no floor configured
        if (!err && Number.isFinite(need)) planNeed = need;
        const have = Math.abs(entryPrice - roundToTick(stopPrice, this.tickSize));
        if (!err && Number.isFinite(need) && have + 1e-9 >= need) return true;
        if (!floorRefused) { floorRefused = true; const why = err ? `the stop floor could not be read (${err.message})` : `the planned stop is ${Math.round(have * 100) / 100} pts from the entry, under the ${need}-pt floor that applies while this order can fill`;
          this.log(`  [live] ENTRY REFUSED (stop floor): ${why} - nothing sent; the next evaluation replans.`);
          try { this._manage('ENTRY_REFUSED_STOP_FLOOR', `The ${dir === 1 ? 'LONG' : 'SHORT'} ${contracts}x entry was not sent: ${why}.`, { journalId: signalContext?.journalId ?? null, plannedStopPts: Math.round(have * 100) / 100, floorPts: Number.isFinite(need) ? need : null, resting: type !== OrderType.MARKET }); } catch (e2) { /* journal only */ } }
        return false;
      };
      const quantityAllowed = () => floorCovered() && (this.entryQuantityCheck === null || (body.size === contracts && this.entryQuantityCheck({ dir,
        entryPrice: roundedEntryPrice, stopPrice: roundToTick(stopPrice, this.tickSize), contracts: body.size,
        source, grade, signalContext, leg1Size, leg2Size }) === true));
      if (!jr.verdict(this, signalContext?.journalId, 'initial', 'control', controlAllowed()) || !jr.verdict(this, signalContext?.journalId, 'initial', 'quantity', quantityAllowed())) return;
      d = await placeOrder(this.token, body, { preSubmit: () => !(lateWindow = windowRefusal() || restingRefusal()) && jr.verdict(this, signalContext?.journalId, 'preSubmit-auth-or-retry', 'control', controlAllowed()) && jr.verdict(this, signalContext?.journalId, 'preSubmit-auth-or-retry', 'quantity', quantityAllowed()) && jr.verdict(this, signalContext?.journalId, 'preSubmit-auth-or-retry', 'alignment', checkConsumedAlignment({ source, context:signalContext, nowMs:Date.now(), freshness:this.alignmentFreshness() })).ok });
    } catch (e) {
      if (e.alignmentBlocked === true && lateWindow) { refuseWindow(lateWindow, 'preSubmit'); return; }   // TIME BLOCKS r1: refused at the raw-send seam (nothing was sent)
      jr.note(this, 'SUBMISSION_FAILED_OR_UNKNOWN', { authBlocked: e.authBlocked === true, authFailed: e.authFailed === true, authUnknownOrder: e.authUnknownOrder === true, orderRejected: e.orderRejected === true, delivery: e.orderRejected === true || e.authBlocked === true ? 'REJECTED_OR_NOT_SENT' : 'UNKNOWN' }, signalContext?.journalId);
      this.log(`  [live] ENTRY FAILED to place: ${e.message}`);
      this.notify('Entry failed — nothing was placed', `${dir === 1 ? 'LONG' : 'SHORT'} ${contracts}x entry order was rejected: ${e.message}. No position was opened despite the earlier signal push.`, { priority: 'high', tags: 'warning' });
      return;
    }
    jr.note(this, 'ACKNOWLEDGED', { orderId: d.orderId || d.id, recoveredAfterAuth: d.recoveredAfterAuth === true, statement: 'Order acknowledged; a fill has not been established.' }, signalContext?.journalId);
    this.entryOrderId = d.orderId || d.id || null;
    this.entryIdentity = require('crypto').randomUUID();
    this._cancelProtectionIds = new Set(); this._cancelClosedFill = null; this._cancelObservedFill = false; this._cancelFillPlan = null; this._cancelProtectionUnknown = false; this._fillPlanBase = null; this._fillFloor = undefined; this._planFloor = Number.isFinite(planNeed) ? planNeed : null; this._cancelProtectionIntent = null;
    this.phase = 'PENDING_ENTRY'; this._startupCancel = false; this._startupUnresolvedReported = false;
    this.dir = dir; this.stopPriceIntended = roundToTick(stopPrice, this.tickSize); this.target1 = roundToTick(target1, this.tickSize); this.target2 = roundToTick(target2, this.tickSize);
    this.tightStopPrice = tightStopPrice != null ? roundToTick(tightStopPrice, this.tickSize) : null; this.smartHoldChecked = false;
    // The SIGNAL-TIME reference price, kept separate from this.entryPrice
    // (which gets overwritten with the REAL fill price once it happens) —
    // needed to compute how far the actual fill drifted from what the
    // stop/target math assumed, so they can be shifted to match reality.
    this.intendedEntryPrice = entryPrice;
    this.source = source; this.grade = grade; this.contracts = contracts;
    // 10/18 RULE 2 (leg split at any size): a 1-lot is ONE leg (leg1 = the whole position at the first scale), so leg1 may equal the size; a 2-lot is 1 + runner (leg2 0).
    this.leg1Size = Math.max(0, Math.min(leg1Size, contracts)); this.leg2Size = Math.max(0, Math.min(leg2Size, contracts - this.leg1Size));
    this.profitLocked = false; this.profitLocked2 = false;
    this.entrySignalTime = Date.now();
    this.entryType = entryType; this.fillHandled = false; this.throughStop = false;
    this.pendingStopTouched = null; this.pendingTargetTouched = null;
    this.signalContext = signalContext;
    this.sessionExit = sessionExit;   // optional per-trade base-hit plan (live-executor.js CONFIG.sessionExits); null for every normal trade
    this.saveState();   // TIME BLOCKS r3: the acknowledged entry's identity is on disk BEFORE any further await (a crash during the cancel below cannot lose it)
    // TIME BLOCKS r2: the ACK arrived after a block (or its lead) began (request sent before, answered late): cancel now, verified (a fill wins and is protected)
    try { const w = this.blackoutFn ? this.blackoutFn(Date.now()) : null; if (w) { this.log(`  [live] entry acknowledged inside a time window (${w}) - cancelling it now.`); this._manage('ENTRY_ACK_IN_WINDOW', `The entry was acknowledged after the time window began (${w}); it is being cancelled now (a fill, if any, wins and is protected).`, { window: blockWindowCode(w), reason: w, entryOrderId: this.entryOrderId }); await this.cancelPendingForBlackout(w); } }
    catch (e) { this.log('  [live] post-ACK window cancel failed (the next poll retries): ' + e.message); }
  }

  async placeProtectiveStop(size, stopPrice, opts = {}) {
    if (this._so1HaltWhy) { this.log(`  [live] so1 HALT active - stop ${size}x @ ${stopPrice} not sent.`); return null; }   // so1 r1.7: central gate
    const rounded = roundToTick(stopPrice, this.tickSize);
    try {
      const d = await placeOrder(this.token, {
        accountId: this.accountId, contractId: this.contractId,
        type: OrderType.STOP, side: this.sideFor(this.dir, true), size, stopPrice: rounded,
      });
      this.log(`  [LIVE ORDER] resting STOP placed: ${size}x @ ${rounded.toFixed(2)}`);
      return d.orderId || d.id || null;
    } catch (e) {
      // Widen-and-retry (2026-09-22): capStop() only ever caps a distance
      // that's too WIDE — nothing anywhere enforces a minimum, so whenever
      // an upstream calculation (a stale ATR estimate, a fill-price shift,
      // anything) puts the stop too close to or on the wrong side of the
      // current market, the exchange rejects it outright, and this got
      // called again next poll cycle with the EXACT same doomed price —
      // repeating forever instead of ever correcting. This has now
      // happened from two different upstream causes, so instead of
      // chasing a third, this is the one place every caller already
      // funnels through: retry progressively further from entry until
      // one actually lands. A real position getting SOME protection, even
      // wider than originally intended, beats it sitting naked while
      // identical alerts fire uselessly every 20 seconds forever.
      this.log(`  [live] protective stop rejected @ ${rounded.toFixed(2)} (${e.message}) — retrying wider.`);
      // r2 (MacDot 6330538954 #3): widening from the REQUESTED stop applies only to a new entry's initial protection with a session floor in force
      // (opts.initialEntry from the fill block); every other caller - restart adoption / recovery, restore, BE, lock, trail, floor off - keeps the r9.16.1 entry-based steps.
      const below = opts.initialEntry === true && !!this._fillFloor && Number.isFinite(this.entryPrice) && (this.dir === 1 ? rounded < this.entryPrice : rounded > this.entryPrice), from = below ? rounded : this.entryPrice;   // entry stop floor package
      for (const widenTicks of [20, 50, 100, 200]) {
        const widerRaw = this.dir === 1 ? from - widenTicks * this.tickSize : from + widenTicks * this.tickSize;
        const wider = roundToTick(widerRaw, this.tickSize);
        try {
          const d = await placeOrder(this.token, {
            accountId: this.accountId, contractId: this.contractId,
            type: OrderType.STOP, side: this.sideFor(this.dir, true), size, stopPrice: wider,
          });
          this.log(`  [LIVE ORDER] resting STOP placed WIDER than intended: ${size}x @ ${wider.toFixed(2)} (original ${rounded.toFixed(2)} was rejected: ${e.message})`);
          this.notify('Stop placed wider than planned', `Your protective stop @ ${rounded.toFixed(2)} was rejected by the exchange, so it was placed @ ${wider.toFixed(2)} instead to guarantee SOME protection rather than none. Worth a manual check.`, { priority: 'high', tags: 'warning' });
          return d.orderId || d.id || null;
        } catch (e2) { /* try the next, wider step */ }
      }
      throw e; // every retry also failed — surface the ORIGINAL error so the caller's existing UNPROTECTED alert still fires
    }
  }

  async placeTargetLimit(size, limitPrice) {
    if (this._so1HaltWhy) { this.log(`  [live] so1 HALT active - limit ${size}x @ ${limitPrice} not sent.`); return null; }   // so1 r1.7: central gate
    const rounded = roundToTick(limitPrice, this.tickSize);
    const d = await placeOrder(this.token, {
      accountId: this.accountId, contractId: this.contractId,
      type: OrderType.LIMIT, side: this.sideFor(this.dir, true), size, limitPrice: rounded,
    });
    this.log(`  [LIVE ORDER] resting LIMIT placed: ${size}x @ ${rounded.toFixed(2)}`);
    return d.orderId || d.id || null;
  }

  async cancelIfSet(orderIdField) {
    const orderId = this[orderIdField];
    if (!orderId) return;
    // Pending entry IDs are released only by terminal-history reconciliation.
    if (orderIdField === 'entryOrderId') return this.resolvePendingCancel();
    try { await cancelOrder(this.token, this.accountId, orderId); }
    catch (e) { this.log(`  [live] cancel of ${orderIdField} failed (likely already filled): ${e.message}`); }
    this[orderIdField] = null;
  }

  // Defensive sweep — whenever the account should be FLAT, there should be
  // ZERO working orders left on this contract. Trusting only our own tracked
  // stopOrderId/targetOrderId (via cancelIfSet) is fragile: a cancel call
  // that fails for a reason OTHER than "already filled", a partial fill that
  // lands on an unexpected size and trips DESYNC before cleanup runs, or any
  // other bookkeeping drift can all leave a real order resting on the
  // exchange with nothing left to clean it up. This checks the account's
  // ACTUAL open orders instead of hoping our own state matches reality, and
  // cancels every one of them — called on every transition back to flat.
  async cancelAllOrdersForContract() {
    let orders;
    try { orders = await getOpenOrders(this.token, this.accountId, this.contractId); }
    catch (e) { this.log(`  [live] could not fetch open orders to sweep-cancel: ${e.message}`); return; }
    for (const o of orders) {
      try {
        const accepted = await cancelOrder(this.token, this.accountId, o.id);
        if (!accepted) { this.log(`  [live] sweep cancel refused for ${o.id}; not confirmed.`); continue; }
        this.log(`  [live] requested cancellation of leftover resting order ${o.id} (size ${o.size ?? '?'}) — should not have still been open.`);
      } catch (e) {
        this.log(`  [live] failed to sweep-cancel leftover order ${o.id}: ${e.message}`);
      }
    }
  }

  // BLACKOUT CANCEL. Only called from tick() while PENDING_ENTRY with the position just read as 0 and our entry order still resting. Never resets unless the broker says flat.
  // Returns 'cancelled' | 'filled' | 'retry'. Unknown (unreadable) = change nothing and retry on the next poll.
  async cancelPendingForBlackout(reason) {
    // 10/17 SESSION CLOSE: the 12:55 PT no-new-entries window uses this same verified path (a fill wins); it gets its own journal code and phone title.
    if (/^session close/.test(String(reason || ''))) {
      const d = this.dir === 1 ? 'LONG' : 'SHORT', e = this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?';
      return this._cancelPendingVerified({
        label: 'session-close cancel', cancelReason: 'entry cancelled: ' + reason, logDone: `entry cancelled: ${reason}.`,
        code: 'ENTRY_CANCELLED_SESSION', manageText: `The resting ${d} entry at ${e} was cancelled unfilled because of the ${reason}: Topstep requires flat by 13:10 PT, so no new entry may start now.`, manageExtra: { reason },
        noteTitle: 'Entry cancelled: session close', noteText: `Your unfilled ${d} entry at ${e} was cancelled: ${reason}. Nothing is open.`,
      });
    }
    const id = this.entryOrderId, sig = this.entrySignalTime;
    const out = await this._cancelPendingVerifiedBlackout(reason);
    const inside = this._inBlock();   // r3: observed AFTER the cancel workflow's awaits
    if (inside && out !== 'cancelled' && this.phase === 'PENDING_ENTRY' && String(this.entryOrderId) === String(id))
      this._reportBlockExposure('ENTRY_RESTING_IN_BLOCK', `The resting entry ${id} is still working inside the ${inside} (cancel outcome: ${out}). The bot keeps trying to cancel it; a fill is protected as normal. Check TopstepX.`, { cancelOutcome: out, ageSec: Number.isFinite(sig) ? Math.round((Date.now() - sig) / 1000) : null });
    return out;
  }
  async _cancelPendingVerifiedBlackout(reason) {
    return this._cancelPendingVerified({
      label: 'blackout cancel', cancelReason: 'entry cancelled: blackout started (' + reason + ')', logDone: `entry cancelled: blackout started (${reason}).`,
      code: 'ENTRY_CANCELLED_BLACKOUT', manageText: `The resting ${this.dir === 1 ? 'LONG' : 'SHORT'} entry at ${this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?'} was cancelled unfilled because the ${reason} started (no new entries are placed during a blackout).`, manageExtra: r => { const inside = this._inBlock(); return { reason, window: blockWindowCode(reason), entryOrderId: this.entryOrderId, observedAt: Date.now(), insideBlock: !!inside, terminalEvidence: r ? `${r.outcome}: ${r.detail}` : 'unknown', venueTime: 'unknown', ...(inside ? { lateNote: 'the end of this entry was observed only after the block began; when it stopped being executable is not known' } : {}) }; },
      noteTitle: 'Entry cancelled: blackout started', noteText: `Your unfilled ${this.dir === 1 ? 'LONG' : 'SHORT'} entry order was cancelled because the ${reason} started. Nothing is open.`,
    });
  }

  // PENDING STOP-TOUCH CANCEL (2026-10-16). Same verified path as the blackout cancel: the position is re-read before and after the cancel, a fill ALWAYS wins
  // (it is then managed normally), unknown = keep the order and retry next poll. Called from tick() only.
  async cancelPendingForStopTouch(touch) {
    const d = this.dir === 1 ? 'LONG' : 'SHORT', st = this.stopPriceIntended != null ? this.stopPriceIntended.toFixed(2) : '?', px = touch && Number.isFinite(touch.price) ? touch.price.toFixed(2) : '?';
    const e = this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?';
    return this._cancelPendingVerified({
      label: 'stop-touch cancel', cancelReason: `entry cancelled: price reached the planned stop ${st} before the entry filled (setup invalid)`, logDone: `entry cancelled: price ${px} reached the planned stop ${st} before the ${d} entry at ${e} filled (setup invalid).`,
      code: 'ENTRY_CANCELLED_STOP_TOUCH', manageText: `The resting ${d} entry at ${e} was cancelled unfilled because price traded at ${px}, at or beyond its planned stop ${st}, before it filled: the setup was already invalid.`, manageExtra: { stop: this.stopPriceIntended, touch: touch ? touch.price : null },
      noteTitle: 'Entry cancelled: stop reached first', noteText: `Your unfilled ${d} entry at ${e} was cancelled: price reached its planned stop ${st} before it filled, so the setup is no longer valid. Nothing is open.`,
    });
  }

  cancelPositionMatches(pos) {
    return !pos || (pos.contractId === this.contractId &&
      (pos.accountId == null || pos.accountId === this.accountId) &&
      Number.isInteger(pos.size) && pos.size > 0 && pos.size <= this.contracts &&
      pos.type === (this.dir === 1 ? 1 : 2));
  }

  async readCancelPosition() {
    const pos = await getOpenPosition(this.token, this.accountId, this.contractId);
    if (!this.cancelPositionMatches(pos)) throw new Error('Position identity/side/size does not match tracked entry');
    return pos;
  }

  // ENTRY STOP FLOOR: the session floor for this trade's fill, read ONCE at the first fill observation (the fill time is the observation time; the broker
  // position has no execution time). Every retry, the cancel-fill protection and its verify step then use the same floor. null = no floor (fn absent/throws).
  _entryFloorForFill() {
    if (this._fillFloor === undefined) { let f = null; try { f = this.entryStopFloorFn ? this.entryStopFloorFn(Date.now()) : null; } catch (e) { f = null; } this._fillFloor = f && Number.isFinite(f.pts) && f.pts > 0 ? { session: f.session || null, pts: f.pts, at: Date.now(), planFloor: Number.isFinite(this._planFloor) ? this._planFloor : null, exceedsPlan: Number.isFinite(this._planFloor) && f.pts > this._planFloor } : null; /* r5: the floor at the first observed exposure; the admitted floor is recorded, never applied */
      if (this._fillFloor && this._fillFloor.exceedsPlan) { this.log(`  [live] STOP FLOOR ABOVE PLAN: this fill takes the ${this._fillFloor.pts}-pt ${this._fillFloor.session} floor; the order was admitted and sized for ${this._planFloor} pts. The floor follows the FIRST OBSERVED exposure (a proxy: broker execution time is not available), seen after the order's planned life. Risk is above plan.`);
        try { this._manage('FLOOR_ABOVE_PLAN', `The ${this._fillFloor.pts}-pt ${this._fillFloor.session} floor applies to this fill, but the order was admitted and sized for ${this._planFloor} pts; the stop is placed at the required floor, so the dollar risk is above plan. The session is taken from the first observation of the exposure, a proxy for (not proof of) the execution time.`, { floorPts: this._fillFloor.pts, planFloor: this._planFloor, session: this._fillFloor.session, basis: 'first-observed-exposure (proxy, not broker execution time)' }); } catch (e) { /* journal only */ }
        this.notify('Stop floor above plan', `This fill takes the ${this._fillFloor.pts}-pt ${this._fillFloor.session} floor; the order was sized for ${this._planFloor} pts, so the risk is above plan.`, { priority: 'high', tags: 'warning' }); }
      if (this.stateFile && this.saveState() === false && !this._floorSaveReported) { this._floorSaveReported = true;   // combined fix 3: the save result is not ignored
        this.log('  [state] CRITICAL: the stop-floor read could not be saved to the trade-state file - protection continues; the lifecycle persistence wrappers retry the save after each wrapped call.');
        try { this._manage('FLOOR_STATE_NOT_SAVED', `The session floor (${this._fillFloor ? this._fillFloor.pts + ' pts' : 'none'}) and the plan for this fill could not be written to the trade-state file. Protection is placed anyway; the lifecycle persistence wrappers retry the save after each wrapped call. Until a save succeeds, a restart resumes from the older file: it re-reads the floor at that restart, and an untracked STOP it finds is reconciled (exact match tracked, otherwise uncovered quantity only + halt), never stacked.`, { floor: this._fillFloor || null, planFloor: this._planFloor ?? null }); } catch (e) { /* journal only */ }
        this.notify('Trade state not saved', 'The bot could not save the stop-floor state for the open fill (disk/permissions). Protection is still being placed and the save is retried after each bot action. Do not restart the bot until this clears; check the VPS disk.', { priority: 'urgent', tags: 'rotating_light' }); }
    }   // combined build: the floor read is saved before any STOP request at that price when the save succeeds (time blocks r5 gates its own checkpoint)
    return this._fillFloor;
  }

  cancelFillPlan(pos) {
    // Preserve the original strategy plan across failed protection attempts and
    // changing average fills. Never accumulate the same fill-price shift twice.
    const base = this._cancelFillPlan || (this._cancelFillPlan = this._fillPlanBase ? { ...this._fillPlanBase } : {
      stop: this.stopPriceIntended, target1: this.target1, target2: this.target2, tight: this.tightStopPrice,
    });
    const fill = Number.isFinite(pos?.averagePrice) && pos.averagePrice > 0 ? pos.averagePrice : this.intendedEntryPrice;
    const slip = fillSlipDecision({ dir: this.dir, intended: this.intendedEntryPrice, fill, stop: base.stop, guard: this.fillSlipGuard });
    const delta = slip.action === 'shift' ? fill - this.intendedEntryPrice : 0;
    const natural = roundToTick(base.stop + delta, this.tickSize), fl = slip.action !== 'exit' && pos && pos.size > 0 ? this._entryFloorForFill() : null;   // r2 (MacDot #1): only on real exposure
    const floor = fl ? stopFloor.applyFloor({ dir: this.dir, entry: fill, stop: natural, floorPts: fl.pts, tickSize: this.tickSize }) : null;   // entry stop floor from the actual fill
    return { base, fill, slip, stop: floor && floor.valid ? floor.stop : natural, natural, floor };
  }

  cancelFillUnchanged(a, b) {
    return !!a && !!b && a.size === b.size && this.cancelFillPlan(a).fill === this.cancelFillPlan(b).fill;
  }

  reportCancelProtectionFailure(pos, detail) {
    // Same urgent channel and two-minute limit as the existing NO_STOP path.
    // Keep polling; an alert is not an exit policy or a cancellation confirmation.
    this.trailRetryAt = 0;
    this.log('  [live] cancellation fill protection unresolved: ' + detail);
    if (this._cancelProtectionAlertEntry !== this.entryIdentity || !this.noStopNotifiedAt || Date.now() - this.noStopNotifiedAt > 2 * 60000) {
      this.noStopNotifiedAt = Date.now(); this._cancelProtectionAlertEntry = this.entryIdentity;
      try { this._manage('NO_PROTECTION', `Protection for the observed ${pos.size}x entry fill is not verified: ${detail}. Tracking retained; retrying every poll.`, { orderId: this.entryOrderId, size: pos.size }); } catch (e) { /* journal only */ }
      this.notify('UNPROTECTED POSITION — action required', `Protection for the observed ${pos.size}x entry fill is not verified: ${detail}. Check the account and protection manually NOW. The bot retains tracking and retries every poll.`, { priority: 'urgent', tags: 'rotating_light' });
    }
    return { ok: false, detail };
  }

  async protectCancelFill(pos) {
    if (!this.cancelPositionMatches(pos) || !pos?.size) return { ok: false };
    this._reportBlockExposure('ENTRY_FILLED_IN_BLOCK', `The entry ${this.entryOrderId} was seen ${pos.size < this.contracts ? 'partly ' : ''}filled (${pos.size}x of ${this.contracts}) inside a time block while it was being cancelled. The fill is protected; the venue fill time is not known to the bot.`, { quantity: pos.size, planned: this.contracts, cancelRequested: true });   // TIME BLOCKS r2
    jr.note(this, 'FILL_OBSERVED', { observationSource: 'broker-position-during-cancel', quantity: pos.size, averagePrice: Number.isFinite(pos.averagePrice) && pos.averagePrice > 0 ? pos.averagePrice : jr.UNKNOWN, entryOrderId: this.entryOrderId, actualFillIds: jr.UNKNOWN });
    if (this._cancelProtectionUnknown) return this.reportCancelProtectionFailure(pos, 'Prior STOP submission outcome unknown; no duplicate STOP will be submitted automatically');
    const owned = this._cancelProtectionIds || (this._cancelProtectionIds = new Set());
    let open = await getOpenOrders(this.token, this.accountId, this.contractId);
    let current = await this.readCancelPosition();
    if (!this.cancelFillUnchanged(current, pos)) return { ok: false };
    this._cancelObservedFill = true;
    const desired = this.cancelFillPlan(current).stop;
    const stop = open.find(o => String(o.id) === String(this.stopOrderId));
    if (!stop || stop.size !== current.size || stop.stopPrice !== desired || stop.type !== OrderType.STOP || stop.side !== this.sideFor(this.dir, true)) {
      // Narrow cancellation protection: no sweep, market fallback or assumed resize.
      // Place the latest size first; retain every owned ID until absence is verified.
      let d;
      // TIME BLOCKS r4 (MacDot 6329392748): intent checkpoint BEFORE the request. A restart that finds it (crash between request and answer) treats the
      // outcome as UNKNOWN: no duplicate STOP is submitted automatically. Cleared only by an answer with an id, or a definitive rejection.
      this._cancelProtectionIntent = { size: current.size, stopPrice: desired, t: Date.now() };
      if (!this.saveState()) {   // TIME BLOCKS r5 (MacDot 6329557319): no automatic STOP request without a durable intent checkpoint
        this._cancelProtectionIntent = null;   // nothing was sent; the file still holds the previous (valid) state, so a restart cannot mistake a sent STOP for none
        if (this._checkpointAlertEntry !== this.entryIdentity) { this._checkpointAlertEntry = this.entryIdentity;
          try { this._manage('PROTECTION_CHECKPOINT_FAILED', `The protective STOP for the observed ${current.size}x fill was NOT sent: its intent could not be saved to the trade-state file (a crash after sending could duplicate it). Existing orders are unchanged. The bot retries every poll; fix the bot host's disk (space / permissions) or protect the position in TopstepX.`, { size: current.size, stopPrice: desired, existingStopId: this.stopOrderId ?? null }); } catch (e) { /* journal only */ } }
        return this.reportCancelProtectionFailure(current, 'protective STOP not sent: the trade-state checkpoint could not be written (disk). Retrying every poll; fix the bot host disk or protect the position manually');
      }
      try { d = await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId,
        type: OrderType.STOP, side: this.sideFor(this.dir, true), size: current.size, stopPrice: desired }); }
      catch (e) {
        // A transport failure may have accepted the stop without returning its ID.
        // Definitive broker rejection may retry; uncertain delivery must not stack stops.
        if (e.orderRejected !== true) this._cancelProtectionUnknown = true; else this._cancelProtectionIntent = null;   // the intent on disk already covers a crash here
        return this.reportCancelProtectionFailure(current, 'STOP placement failed: ' + e.message);
      }
      const id = d.orderId || d.id;
      if (!id) { this._cancelProtectionUnknown = true; return this.reportCancelProtectionFailure(current, 'Protective order identity unavailable'); }
      owned.add(String(id));
      if (stop) owned.add(String(stop.id));
      this.stopOrderId = id; this._cancelProtectionIntent = null; this.saveState();
    }
    for (const id of owned) {
      if (id === String(this.stopOrderId)) continue;
      current = await this.readCancelPosition();
      if (!this.cancelFillUnchanged(current, pos)) return { ok: false };
      open = await getOpenOrders(this.token, this.accountId, this.contractId);
      if (!open.some(o => String(o.id) === id)) { owned.delete(id); this.saveState(); continue; }
      try { if (!await cancelOrder(this.token, this.accountId, open.find(o => String(o.id) === id).id)) return this.reportCancelProtectionFailure(current, 'Old protective STOP cancellation refused; both IDs retained'); }
      catch (e) { return this.reportCancelProtectionFailure(current, 'Old protective STOP cancellation interrupted; both IDs retained'); }
      open = await getOpenOrders(this.token, this.accountId, this.contractId);
      if (open.some(o => String(o.id) === id)) return this.reportCancelProtectionFailure(current, 'Old protective STOP still working; reconciliation pending');
      owned.delete(id); this.saveState();   // r4: only a verified absence removes an owned id from disk
    }
    open = await getOpenOrders(this.token, this.accountId, this.contractId);
    current = await this.readCancelPosition();
    const verified = open.find(o => String(o.id) === String(this.stopOrderId));
    if (!this.cancelFillUnchanged(current, pos)) return { ok: false };
    const ok = !!verified && verified.size === current.size && verified.stopPrice === this.cancelFillPlan(current).stop &&
      verified.type === OrderType.STOP && verified.side === this.sideFor(this.dir, true);
    return ok ? { ok: true } : this.reportCancelProtectionFailure(current, 'Working STOP price/size could not be verified');
  }

  async closeCancelledFill(order) {
    // A partial fill may close before we adopt it. Only terminal entry history,
    // fresh flat reads and verified removal of OUR cancellation stops allow reset.
    if (this._cancelProtectionUnknown || !this._cancelObservedFill || ![2,3,4].includes(order.status) || !(order.fillVolume > 0)) return false;
    let open = await getOpenOrders(this.token, this.accountId, this.contractId);
    if (open.some(o => String(o.id) === String(this.entryOrderId)) || await this.readCancelPosition()) return false;
    const owned = this._cancelProtectionIds || new Set();
    for (const id of owned) {
      if (await this.readCancelPosition()) return false;
      if (!open.some(o => String(o.id) === id)) continue;
      if (!await cancelOrder(this.token, this.accountId, open.find(o => String(o.id) === id).id)) return false;
      open = await getOpenOrders(this.token, this.accountId, this.contractId);
      if (open.some(o => String(o.id) === id)) return false;
    }
    open = await getOpenOrders(this.token, this.accountId, this.contractId);
    if (open.some(o => String(o.id) === String(this.entryOrderId) || owned.has(String(o.id))) || await this.readCancelPosition()) return false;
    this._cancelClosedFill = { fillPrice: order.filledPrice ?? null, contracts: order.fillVolume };
    this.reset();
    return true;
  }

  // One entry only. Never sweep: a fill may have installed protection during cancellation.
  async resolvePendingCancel({ request = true, intent = null } = {}) {
    if (this._cancelInFlight) return { outcome: 'pending', detail: 'Cancellation check in progress' };
    this._cancelInFlight = true;
    // r9.6 (MacDot aa79108): the cancel intent is recorded only by the caller that holds the lock and sends the request; a caller refused above never changes it.
    // Priority = the first bot cancel actually sent for this order; a later bot request replaces it only when it, too, takes the lock and sends.
    if (request && intent) this._pendingCancelIntent = intent;
    try {
      const id = this.entryOrderId;
      if (this.phase !== 'PENDING_ENTRY' || !id) return { outcome: 'unknown', detail: 'Entry is no longer tracked; no action taken' };
      let pos = await this.readCancelPosition();
      this.cancelFillPlan(pos);
      let ack = null;
      // Full fills go through the original protection/stop/slippage path immediately.
      if (pos?.size === this.contracts) {
        if (this.stopOrderId && !(await this.protectCancelFill(pos)).ok) return { outcome: 'unknown', detail: 'Fill protection unresolved; tracking retained' };
        await this.tick({ cancelOwner: true, noBlackout: true, noStopTouch: true });
        return { outcome: this.phase === 'PENDING_ENTRY' ? 'unknown' : 'filled', detail: this.phase === 'PENDING_ENTRY' ? 'Fill adoption/protection unresolved; tracking retained' : 'Entry filled; normal position management retained' };
      }
      // Protect a partial fill while its unfilled remainder is being cancelled/verified.
      if (pos?.size > 0) {
        const r = await this.protectCancelFill(pos);
        if (!r.ok) return { outcome: 'unknown', detail: 'Partial fill protection unresolved; tracking retained' };
      }
      const before = await getOpenOrders(this.token, this.accountId, this.contractId);
      if (request && before.some(o => String(o.id) === String(id))) {
        try { ack = await cancelOrder(this.token, this.accountId, id); }
        catch (e) { ack = false; }
      }
      this.lastCancelAck = ack === true;
      // Read orders before the final position; history prevents delayed fills looking cancelled.
      const open = await getOpenOrders(this.token, this.accountId, this.contractId);
      pos = await this.readCancelPosition();
      if (pos?.size === this.contracts) {
        if (this.stopOrderId && !(await this.protectCancelFill(pos)).ok) return { outcome: 'unknown', detail: 'Fill protection unresolved; tracking retained' };
        await this.tick({ cancelOwner: true, noBlackout: true, noStopTouch: true });
        return { outcome: this.phase === 'PENDING_ENTRY' ? 'unknown' : 'filled', detail: this.phase === 'PENDING_ENTRY' ? 'Fill adoption/protection unresolved; tracking retained' : 'Fill raced cancellation; normal management retained' };
      }
      if (pos?.size > 0) {
        const r = await this.protectCancelFill(pos);
        if (!r.ok) return { outcome: 'unknown', detail: 'Partial fill protection unresolved; tracking retained' };
      }
      if (open.some(o => String(o.id) === String(id))) return { outcome: ack === false ? 'failed' : 'pending', detail: 'Entry still working; tracking retained' };
      const order = await getEntryOrder(this.token, this.accountId, this.contractId, id, this.entrySignalTime);
      pos = await this.readCancelPosition();
      if (order.fillVolume > 0 || order.status === 2 || pos?.size > 0) {
        if (!pos) {
          const closed = await this.closeCancelledFill(order);
          return { outcome: closed ? 'filled' : 'unknown', detail: closed ? 'Entry filled then closed; owned protection cleanup verified' : 'Fill history present; closure/cleanup unverified, tracking retained' };
        }
        if (pos?.size > 0 && pos.size === order.fillVolume && [2,3,4].includes(order.status)) {
          // A terminal partial entry cannot grow further. Keep the existing stop and
          // use the original fill-management path with the actual remaining size.
          if (!(await this.protectCancelFill(pos)).ok) return { outcome: 'unknown', detail: 'Latest fill protection unresolved; tracking retained' };
          this.contracts = pos.size;
          this.leg1Size = Math.min(this.leg1Size, pos.size);
          this.leg2Size = Math.min(this.leg2Size, pos.size - this.leg1Size);
          await this.tick({ cancelOwner: true, noBlackout: true, noStopTouch: true });
        }
        return { outcome: this.phase === 'PENDING_ENTRY' ? 'unknown' : 'filled', detail: 'Fill evidence found; never reported cancelled; tracking retained' };
      }
      if (order.fillVolume !== 0 || ![3,4,5].includes(order.status)) return { outcome: 'unknown', detail: 'No terminal unfilled evidence; tracking retained' };
      // A failed cancel call alone never clears state. A subsequent read-only check
      // may resolve it using explicit terminal history, open orders and position.
      if (ack === false) return { outcome: 'failed', detail: 'Cancel call failed; terminal evidence will be checked next poll' };
      return { outcome: order.status === 3 ? 'cancelled' : 'resolved', detail: order.status === 3 ? 'Verified cancelled, zero fills and no position' : 'Entry expired/rejected unfilled' };
    } catch (e) {
      return { outcome: 'unknown', detail: 'Broker state unreadable; tracking retained: ' + e.message };
    } finally { this._cancelInFlight = false; }
  }

  // r9.6 (Mac 10/19 "after 5 mins no entry it should cancel the pending orders"): is the expiry deadline due? Pure check. The 3 s fast poll uses it only to
  // wake the main loop early (once per entry), so the cancel itself stays in tick(): fresh 1m bars first (stop-touch / TP1-touch keep priority), retries at
  // the normal 20 s pace (review r9.6 #2/#3).
  // TIME BLOCKS r2: exposure INSIDE an exact block is reported, once per order and kind (journal + urgent push). Never changes an order.
  _inBlock(ts = Date.now()) { try { return this.blockFn ? this.blockFn(ts) : null; } catch (e) { return null; } }
  _reportBlockExposure(kind, text, extra = {}) {
    const b = this._inBlock(); if (!b) return false;
    const key = `${this.entryOrderId}|${kind}`; if (this._blockExposureKeys && this._blockExposureKeys.has(key)) return false;
    (this._blockExposureKeys || (this._blockExposureKeys = new Set())).add(key);
    try { this._manage(kind, text, { window: blockWindowCode(b), reason: b, entryOrderId: this.entryOrderId, detectedAt: Date.now(), venueTime: 'unknown', ...extra }); } catch (e) { /* journal only */ }
    try { this.notify(kind === 'ENTRY_FILLED_IN_BLOCK' ? 'Entry filled inside a time block' : 'Entry still working inside a time block', text, { priority: 'urgent', tags: 'rotating_light' }); } catch (e) { /* notification only */ }
    return true;
  }
  // TIME BLOCKS r3 (MacDot 6329113809 #2/#3): a resting entry saved by the previous process is OURS by its exact order id. Startup RESTORES that pending
  // lifecycle (side, size, legs, planned stop/targets, order id, any cancel-time protective stop) so the machine's own verified paths run on it: a partial
  // fill is protected at its actual size and the remainder cancelled; a fill is managed with the saved plan; the order is cancelled (startup cancel,
  // verified by order history, a fill wins). While it is PENDING_ENTRY the executor's startup reconciliation / adoption does not run (phase is not FLAT).
  // A saved position that does not match the saved entry (other side / larger) is not restored: the exact id is kept as a persisted orphan and cancelled.
  async recoverSavedPendingEntry() {
    const st = this.loadState();
    if (!st) return { action: 'none' };
    if (st.contractId !== this.contractId || (st.accountId != null && st.accountId !== this.accountId)) return { action: 'none', why: 'saved for another contract/account' };
    if (this.phase !== 'FLAT') return { action: 'none', why: `machine is ${this.phase}` };
    if (st.phase !== 'PENDING_ENTRY' && st.orphanEntry && st.orphanEntry.orderId != null) { this._orphanEntry = { ...st.orphanEntry, reported: false }; this._stateArmed = true; return this.orphanEntryStep(); }
    if (st.phase !== 'PENDING_ENTRY' || st.entryOrderId == null || ![1, -1].includes(st.dir) || !(st.contracts > 0)) return { action: 'none' };
    const pe = st.pendingEntry || {};
    let pos, posKnown = true; try { pos = await getOpenPosition(this.token, this.accountId, this.contractId); } catch (e) { posKnown = false; }
    Object.assign(this, { dir: st.dir, contracts: st.contracts, leg1Size: st.leg1Size ?? 1, leg2Size: st.leg2Size ?? 0, entryPrice: null, intendedEntryPrice: pe.intendedEntryPrice ?? st.entryPrice ?? null,
      stopPriceIntended: st.stopPriceIntended, target1: st.target1, target2: st.target2, tightStopPrice: pe.tightStopPrice ?? null, entryOrderId: st.entryOrderId, entryType: pe.entryType ?? 'LIMIT',
      entrySignalTime: Number.isFinite(pe.entrySignalTime) ? pe.entrySignalTime : Date.now(), source: st.source ?? null, grade: st.grade ?? null, sessionExit: st.sessionExit ?? null,
      stopOrderId: st.stopOrderId ?? null, targetOrderId: null, leg3StopOrderId: null, fillHandled: false, throughStop: false, pendingStopTouched: null, pendingTargetTouched: null, signalContext: null,
      entryIdentity: require('crypto').randomUUID(), _cancelProtectionIds: new Set([...((pe.protection && Array.isArray(pe.protection.ids)) ? pe.protection.ids.map(String) : []), ...(st.stopOrderId != null ? [String(st.stopOrderId)] : [])]), _cancelClosedFill: null, _cancelObservedFill: false, _cancelFillPlan: null,
      _cancelProtectionUnknown: !!(pe.protection && (pe.protection.unknown || pe.protection.intent)), _cancelProtectionIntent: pe.protection && pe.protection.intent ? pe.protection.intent : null,   // TIME BLOCKS r4: never cleared by a restart
      _fillPlanBase: pe.fillPlan && Number.isFinite(pe.fillPlan.stop) ? { stop: pe.fillPlan.stop, target1: pe.fillPlan.target1, target2: pe.fillPlan.target2, tight: pe.fillPlan.tight ?? null } : null,   // combined build: the plan as sent
      _fillFloor: pe.fillFloorRead ? (pe.fillFloor && Number.isFinite(pe.fillFloor.pts) ? { ...pe.fillFloor } : null) : undefined,
      _planFloor: Number.isFinite(pe.planFloor) ? pe.planFloor : null, _restoredPending: true, _floorSaveReported: false, _ordersUnreadableReported: false });   // combined fix 3   // combined build: the floor read before the restart is kept (never re-read wider)
    if (posKnown && pos && pos.size && !this.cancelPositionMatches(pos)) {
      const mismatch = `broker position ${pos.type === 1 ? 'LONG' : 'SHORT'} ${pos.size}x does not match the saved ${st.dir === 1 ? 'LONG' : 'SHORT'} ${st.contracts}x entry`;
      Object.assign(this, { dir: null, contracts: null, entryOrderId: null, stopOrderId: null, intendedEntryPrice: null, _cancelProtectionIds: new Set() });
      this._orphanEntry = { orderId: st.entryOrderId, dir: st.dir, contracts: st.contracts, entryType: pe.entryType ?? null, price: pe.intendedEntryPrice ?? null, signalTime: pe.entrySignalTime ?? null, attempts: 0, reported: false };
      this._stateArmed = true; try { this._manage('STARTUP_PENDING_MISMATCH', `The resting entry ${st.entryOrderId} saved by the previous run was not resumed: ${mismatch}. Its exact order id is cancelled (no other order); the position is reconciled separately.`, { entryOrderId: st.entryOrderId, dir: st.dir, why: mismatch }); } catch (e) { /* journal only */ }
      return this.orphanEntryStep();
    }
    this.phase = 'PENDING_ENTRY'; this._startupCancel = true; this._stateArmed = true;
    try { this._manage('STARTUP_PENDING_RESTORED', `The resting ${st.dir === 1 ? 'LONG' : 'SHORT'} ${st.contracts}x entry ${st.entryOrderId} left by the previous run was resumed under the bot's own pending-entry handling: it is being cancelled (verified; a fill wins and is protected at its actual size).`, { entryOrderId: st.entryOrderId, dir: st.dir, contracts: st.contracts, positionAtStart: posKnown ? (pos ? pos.size : 0) : 'unreadable' }); } catch (e) { /* journal only */ }
    this.saveState();
    try { await this.tick(); } catch (e) { this.log('  [startup-entry] first pass failed (non-fatal; the main loop retries): ' + e.message); }   // protection is not postponed
    if (this.phase === 'PENDING_ENTRY') this._reportStartupUnresolved(this.pendingCancelOutcome ? this.pendingCancelOutcome.outcome + ': ' + this.pendingCancelOutcome.detail : 'unresolved after the first pass');   // e.g. order gone but history unreadable
    return { action: this.phase === 'PENDING_ENTRY' ? 'restored-pending' : 'restored-resolved', phase: this.phase };
  }
  // TIME BLOCKS r3: the verified startup cancel of a restored entry (same verified path as every pending cancel: order history, a fill wins)
  async cancelPendingForStartup() {
    const d = this.dir === 1 ? 'LONG' : 'SHORT', id = this.entryOrderId;
    const out = await this._cancelPendingVerified({
      label: 'startup cancel', cancelReason: 'entry cancelled: left resting by the previous run (this run cannot govern it)', logDone: `entry ${id} from the previous run cancelled (verified).`,
      code: 'STARTUP_ENTRY_CANCELLED', manageText: `The resting ${d} entry ${id} left by the previous run ended unfilled after the bot's cancel request (terminal evidence attached).`,
      manageExtra: r => ({ entryOrderId: id, terminalEvidence: r ? `${r.outcome}: ${r.detail}` : 'unknown', venueTime: 'unknown' }), noteTitle: null, noteText: null });
    return out;   // an unresolved outcome is reported once by recoverSavedPendingEntry after its first pass
  }
  _reportStartupUnresolved(out) {
    if (this._startupUnresolvedReported) return; this._startupUnresolvedReported = true; const id = this.entryOrderId;
    try { this._manage('STARTUP_ENTRY_UNRESOLVED', `The resting entry ${id} left by the previous run is not yet confirmed ended (outcome ${out}). The bot keeps it under pending-entry handling and keeps trying; check TopstepX.`, { entryOrderId: id, cancelOutcome: out }); } catch (e) { /* journal only */ }
    try { this.notify('Old resting entry not confirmed cancelled', `Entry order ${id} from before the restart: not yet confirmed ended (${out}). Retrying; check TopstepX.`, { priority: 'urgent', tags: 'rotating_light' }); } catch (e) { /* notification only */ }
  }
  async orphanEntryStep() {
    const o = this._orphanEntry; if (!o) return { action: 'none' };
    const extra = { entryOrderId: o.orderId, dir: o.dir, entryType: o.entryType, entry: o.price, signalTime: o.signalTime, attempts: o.attempts };
    const unresolved = why => { this.saveState(); if (!o.reported) { o.reported = true; try { this._manage('STARTUP_ENTRY_UNRESOLVED', `The resting entry ${o.orderId} left by the previous run could not be confirmed cancelled (${why}). The bot keeps retrying; check TopstepX.`, { ...extra, why }); } catch (e) { /* journal only */ }
      try { this.notify('Old resting entry not confirmed cancelled', `Entry order ${o.orderId} from before the restart: ${why}. Retrying; check TopstepX.`, { priority: 'urgent', tags: 'rotating_light' }); } catch (e) { /* notification only */ } } return { action: 'unresolved', why }; };
    const listed = async () => (await getOpenOrders(this.token, this.accountId, this.contractId)).some(x => String(x.id) === String(o.orderId));
    let present; try { present = await listed(); } catch (e) { return unresolved('working orders unreadable: ' + e.message); }
    if (!present) { this._orphanEntry = null; try { this._manage('STARTUP_ENTRY_GONE', `The resting entry ${o.orderId} saved by the previous run is no longer working${o.attempts ? ' after the cancel request' : ''}. Why it ended (cancelled, filled, expired) is not established here; a position, if any, is reconciled separately.`, { ...extra, terminalReason: 'unknown' }); } catch (e) { /* journal only */ } this.saveState(); return { action: 'absent' }; }
    o.attempts++; extra.attempts = o.attempts;
    try { await cancelOrder(this.token, this.accountId, o.orderId); } catch (e) { /* verified below */ }
    try { present = await listed(); } catch (e) { return unresolved('working orders unreadable after the cancel: ' + e.message); }
    if (!present) { this._orphanEntry = null; try { this._manage('STARTUP_ENTRY_GONE', `The resting entry ${o.orderId} left by the previous run is no longer working after the cancel request. Why it ended is not established here (no order history read on this path).`, { ...extra, terminalReason: 'unknown' }); } catch (e) { /* journal only */ } this.saveState(); return { action: 'absent-after-cancel' }; }
    return unresolved('still working after the cancel request');
  }
  // TIME BLOCKS r1: a resting entry the window test now blocks (the executor's fast poll wakes the main loop on this; tick() does the verified cancel).
  pendingWindowDue(now = Date.now()) {
    return !this.desynced && this.phase === 'PENDING_ENTRY' && !!this.entryOrderId && !!this.blackoutFn && !!this.blackoutFn(now);
  }
  pendingExpiryDue(now = Date.now()) {
    return !this.desynced && this.phase === 'PENDING_ENTRY' && !!this.entryOrderId && !!this.pendingExpireMs && now - this.entrySignalTime >= this.pendingExpireMs;
  }
  async _cancelPendingVerified({ label, cancelReason, logDone, code, manageText, manageExtra, noteTitle, noteText, request = true }) {
    this.lastUnfilledCancel = null;   // final review N2: never pair a reason with an older order's record
    // r9.6 re-review S1: why the BOT asked to cancel; a lagged cancel confirmed later keeps this reason (cleared in reset()). Set under the cancel lock (resolvePendingCancel).
    const result = await this.resolvePendingCancel({ request, intent: request ? cancelReason : null });
    this.pendingCancelOutcome = result;
    if (!['cancelled', 'resolved'].includes(result.outcome)) {
      this.log(`  [live] ${label}: ${result.outcome}: ${result.detail}`);
      return result.outcome === 'filled' ? 'filled' : 'retry';
    }
    this.cancelReason = cancelReason;
    this.log(`  [live] ${logDone}`);
    // r9.6 (MacDot R9.6 #3): the verified-unfilled order's OWN identity and geometry, kept past reset() so a ban never depends on the executor's journal context.
    const unfilled = { orderId: this.entryOrderId, dir: this.dir, price: this.intendedEntryPrice, stop: this.stopPriceIntended, entryType: this.entryType, reason: cancelReason, ageMs: Number.isFinite(this.entrySignalTime) ? Date.now() - this.entrySignalTime : null, t: Date.now() };
    try { this._manage(code, manageText, { ...((typeof manageExtra === 'function' ? manageExtra(result) : manageExtra) || {}), ageSec: unfilled.ageMs != null ? Math.round(unfilled.ageMs / 1000) : null, entry: unfilled.price, entryType: unfilled.entryType }); } catch (e) { /* journal only */ }   // r9.6: rows carry age + planned entry (MacShip ask)
    if (noteTitle) this.notify(noteTitle, noteText, { tags: 'octagonal_sign' });
    this.reset();
    this.lastUnfilledCancel = unfilled;
    return 'cancelled';
  }

  async cancelEntryRequest(target) {
    if (!target || target.accountId !== this.accountId || target.contractId !== this.contractId ||
        target.entryIdentity !== this.entryIdentity || String(target.orderId) !== String(this.entryOrderId)) {
      return { outcome: 'unknown', detail: 'Target is not the tracked entry; no action taken' };
    }
    if (this.phase !== 'PENDING_ENTRY') return { outcome: this.phase === 'FLAT' ? 'unknown' : 'filled', detail: 'Entry no longer pending; no flatten requested' };
    const r = await this.resolvePendingCancel();
    if (['cancelled', 'resolved'].includes(r.outcome)) { this.cancelReason = r.detail; this.reset(); }
    return r;
  }

  // NEWS CANCEL (2026-10-16): a resting LIMIT/STOP entry is pulled shortly before a HIGH-impact release (the 10/14 loss was a resting limit run over by the 8:30 ET gap).
  // Same verified path (fill wins). MARKET entries are never touched; the signal may enter again after the release.
  async cancelPendingForNews(ev) {
    const d = this.dir === 1 ? 'LONG' : 'SHORT', e = this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?';
    const title = ev && ev.title ? String(ev.title).split(' / ')[0] : 'a high-impact release';
    const when = ev && ev.ms ? new Date(ev.ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT' : '';
    return this._cancelPendingVerified({
      label: 'news cancel', cancelReason: `entry pulled before news: ${title}${when ? ' at ' + when : ''} (resting orders are pulled before a high-impact release)`, logDone: `entry pulled before news: the resting ${d} entry at ${e} was cancelled because ${title} is due${when ? ' at ' + when : ''}.`,
      code: 'ENTRY_CANCELLED_NEWS', manageText: `The resting ${d} entry at ${e} was pulled unfilled because ${title} (high impact) is due${when ? ' at ' + when : ''}: a resting order can be filled far away by the release gap. The signal may enter again after the release.`, manageExtra: { news: title, newsAt: ev ? ev.ms : null },
      noteTitle: 'Entry pulled before news', noteText: `Your resting ${d} entry at ${e} was cancelled before ${title}${when ? ' (' + when + ')' : ''}. Nothing is open. The bot may enter again after the release.`,
    });
  }

  // FILL-SLIPPAGE GUARD 'exit' (10/16): the entry filled at or beyond its ORIGINAL planned stop (news/gap). The trade is already stopped out on its own plan: close it at
  // market right away (position re-read first; same MARKET close + FLATTENING confirmation as the flatten path; tick() confirms flat). If the market order fails the
  // phase stays PENDING_ENTRY, so the next poll (size n again) retries the exit; the entry row / phone note are written once.
  async _exitFilledThroughStop(n, fill, slip) {
    jr.note(this, 'CLOSE_ATTEMPT', { attemptedCause: 'filled_through_planned_stop', attemptedActor: 'AUTOMATIC', provenance: '_exitFilledThroughStop caller', acceptance: jr.UNKNOWN });
    const d = this.dir === 1 ? 'LONG' : 'SHORT', st = this.stopPriceIntended.toFixed(2);
    if (!this.fillHandled) {
      this.fillHandled = true; this.throughStop = true; this.entryPrice = fill;
      this.log(`  [LIVE FILL] entry filled: ${d} ${n}x @ ${fill.toFixed(2)} - THROUGH the planned stop ${st} (${Math.abs(slip.delta).toFixed(2)} pts from the plan ${this.intendedEntryPrice.toFixed(2)}): exiting at market now.`);
      jr.note(this, 'FILL_OBSERVED', { observationSource: 'broker-position-through-stop', quantity: n, averagePrice: fill, entryOrderId: this.entryOrderId, actualFillIds: jr.UNKNOWN });
      this.journal({ type: 'entry', t: Date.now(), dir: this.dir, entryPrice: fill, contracts: n, leg1Size: this.leg1Size, leg2Size: this.leg2Size, source: this.source, grade: this.grade, ...(this.signalContext || {}) });
      try { this._manage('FILLED_THROUGH_STOP', `The ${d} entry planned at ${this.intendedEntryPrice.toFixed(2)} filled at ${fill.toFixed(2)} (news or a gap), already at or beyond its planned stop ${st}. The setup was stopped out before it began, so all ${n} contracts are closed at market at once instead of moving the stop with the gap.`, { fill, stop: this.stopPriceIntended, slip: slip.delta }); } catch (e2) { /* journal only */ }
      this.notify('Filled through the planned stop at news/gap - exited', `${d} ${n}x filled @ ${fill.toFixed(2)}, beyond the planned stop ${st}. Closing all ${n} at market now.`, { priority: 'high', tags: 'rotating_light' });
    }
    // r1.1: the through-stop exit is on the safe-exit rule too: a backoff after a rejection, K = 3 market sends in total (rejected or unknown-then-still-open),
    // the in-flight exit on disk before the send, a lost reply settled before anything else, then HALT. The backup stop rests whenever no exit is in flight.
    if (this.exitRetryAt && Date.now() < this.exitRetryAt) return;   // backoff after a rejected exit; the backup stop keeps resting
    const K = safeExit.EXIT_MAX_ATTEMPTS, backupLvl = () => roundToTick(fill - this.dir * Math.abs(this.intendedEntryPrice - this.stopPriceIntended), this.tickSize);
    const backupStop = async sz => { try { if (!this.stopOrderId) this.stopOrderId = await this.placeProtectiveStop(sz, backupLvl()); } catch (e3) { this.log(`  [live] CRITICAL: the backup stop for ${sz}x could not be placed (${e3.message}).`); } };   // QA 10/16 C1: never naked while the exit retries
    const capHalt = (sz, why) => this._exitHalt(`the market exit after a fill through the stop ${why} - ${this.exitAttempts} of ${K} market attempts used and the position is still open (${sz}x)`, `Through-stop exit FAILED ${this.exitAttempts}x - FLATTEN IN TOPSTEPX NOW`, `The bot tried ${this.exitAttempts} times to close ${sz}x at market (the entry filled through its stop) and the broker still shows the position. A backup stop was placed where possible. The bot has HALTED (no new entries). Use Flatten / Close position in TopstepX.`);
    let size;
    try { const pos = await getOpenPosition(this.token, this.accountId, this.contractId); size = pos ? pos.size : 0; }
    catch (e) { this.log(`  [live] filled-through-stop exit: position re-read failed (${e.message}) - retrying next poll.`); return; }
    if (!size) { this.log('  [live] filled-through-stop exit: the position is already 0 - cleaning up.'); await this.cancelAllOrdersForContract(); this.reset(); return; }
    if ((this.exitAttempts || 0) >= K) { await backupStop(size); capHalt(size, 'reached its cap'); return; }   // checked before the backup stop is touched
    // ROUND 4 (QA B4): a backup stop from an earlier failed attempt is cancelled (verified) BEFORE the market exit, never after: otherwise the stop can fill
    // between the exit and its cancel and reverse the position. Still resting = send nothing this poll (the stale-stop sweep retries; the next poll re-evaluates).
    if (this.stopOrderId) {
      const gone = await this.cancelVerified(this.stopOrderId, 'backup stop', size, null);
      if (!gone) { this.log('  [live] filled-through-stop exit: the backup stop is still resting - NOT sending the market exit this poll (it would reverse the position if both filled).'); return; }
      this.stopOrderId = null;
      try { const p2 = await getOpenPosition(this.token, this.accountId, this.contractId); size = p2 ? p2.size : 0; }
      catch (e) { this.log(`  [live] filled-through-stop exit: position re-read after the backup-stop cancel failed (${e.message}) - backup stop back, retrying next poll.`); await backupStop(size); return; }
      if (!size) { this.log('  [live] filled-through-stop exit: the backup stop already closed the position - confirming.'); await this.cancelAllOrdersForContract(); this.exitReason = 'through-stop'; this.phase = 'FLATTENING'; return; }
    }
    // the in-flight exit is on disk BEFORE the market goes out (a restart while it is unresolved runs the same settle rule, _startupExitInFlight)
    this.exitAttempts = (this.exitAttempts || 0) + 1;
    this.exitInFlight = { kind: 'through-stop', dir: this.dir, size, at: Date.now(), attempt: this.exitAttempts, outcome: 'sending' };
    if (this.stateFile && this.saveState() !== true) {
      this.exitInFlight = null; this.exitAttempts--;
      this.log('  [through-stop] the exit intent could not be saved - backup stop back, NOT sending the exit this poll (retried next poll).');
      await backupStop(size); return;
    }
    jr.requestClose(this, 'filled_through_planned_stop', 'AUTOMATIC', '_exitFilledThroughStop after position and backup-stop checks; before market submission');
    const sentAt = this.exitInFlight.at;   // bf-exitsafe
    try { await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.MARKET, side: this.sideFor(this.dir, true), size }); }
    catch (e) {
      if (safeExit.classifyExitError(e) === 'unknown') {   // bf-exitsafe: a lost reply is not a failure - settle first; never a backup stop or a second exit on an unknown outcome
        this.exitInFlight = { ...this.exitInFlight, outcome: 'unknown', err: String(e && e.message || e) }; this.saveState();
        this.log(`  [through-stop] the market exit (${size}x) was sent but its outcome is UNKNOWN (${e.message}) - sending nothing, no backup stop; reading the broker until it settles.`);
        const r = await this._confirmNotFilled(await safeExit.settle(this._settleIo(), this.dir, size, this._settleOpts()), this.dir, size, sentAt);
        try { this._manage('EXIT_OUTCOME_UNKNOWN', `The market exit after the fill through the stop (${size}x) got no reply (${e.message}); the broker settled: ${r.verdict}.`, { verdict: r.verdict, net: r.net, size }); } catch (e2) { /* journal only */ }
        if (r.verdict === 'flat') { this.exitInFlight = { ...this.exitInFlight, outcome: 'filled' }; if (r.orders.length) await this.cancelAllOrdersForContract(); this.exitReason = 'through-stop'; this.phase = 'FLATTENING'; return; }
        if (r.verdict !== 'same') { this._exitHalt(`the market exit after a fill through the stop (${size}x) got no reply and the broker settled ${r.verdict} (net ${r.net})${r.why ? ': ' + r.why : ''}`, 'Exit outcome UNKNOWN - FLATTEN IN TOPSTEPX NOW', `The market exit for ${size}x (entry filled through its stop) got no reply and the broker shows ${r.verdict === 'unsettled' ? 'no stable picture' : `net ${r.net}`}. The bot has HALTED: no new entries, no orders. Use Flatten / Close position in TopstepX.`); return; }
        // same: the exit did not happen (position, orders and history agree) -> backup stop back, retry next poll within the cap
        this.exitInFlight = null;
        try { this._manage('EXIT_UNKNOWN_NOT_FILLED', `Through-stop exit: the lost-reply exit did NOT fill (${r.reads.length} reads); backup stop placed; attempt ${this.exitAttempts} of ${K} used.`, { size, attempts: this.exitAttempts }); } catch (e2) { /* journal only */ }
        await backupStop(size);
        if (this.exitAttempts >= K) { capHalt(size, 'could not be confirmed'); return; }
        this.log(`  [through-stop] the unknown exit did NOT fill (the broker settled on ${size}x, nothing working) - backup stop placed, retry next poll (${this.exitAttempts}/${K}).`);
        this._notifyThrottled('EXIT FAILED', 'EXIT FAILED - position open beyond its stop', `The market exit for ${size}x got no reply and the broker still shows the position. A backup stop is resting; the bot retries (at most ${K} attempts, then it halts). Flatten in TopstepX if this repeats.`, { priority: 'urgent', tags: 'rotating_light' });
        return;
      }
      // a proven REJECTION: nothing happened at the broker -> backup stop back, retry after the backoff, HALT at the cap
      this.exitInFlight = null;
      this.sessionExitFails = (this.sessionExitFails || 0) + 1;
      const capped = this.exitAttempts >= K, wait = safeExit.backoffMs(this.sessionExitFails);
      this.log(`  [live] CRITICAL: market exit after a fill through the stop was REJECTED (${e.message}) - backup stop back${capped ? '; attempt cap reached, halting' : `, retrying ${wait ? `in ${wait / 1000} s` : 'next poll'}`} (attempt ${this.exitAttempts}/${K}).`);
      try { this._manage('THROUGH_STOP_EXIT_RETRY', `The market exit after the fill through the stop was rejected (${e.message}); a backup stop is placed${capped ? ' and the attempt cap was reached' : ' and the bot retries'} (attempt ${this.exitAttempts} of ${K}).`, { attempt: this.sessionExitFails, sends: this.exitAttempts }); } catch (e2) { /* journal only */ }
      await backupStop(size);
      if (capped) { capHalt(size, `was rejected ${this.sessionExitFails}x (last: ${e.message})`); return; }
      this.exitRetryAt = Date.now() + wait;
      this._notifyThrottled('EXIT FAILED', 'EXIT FAILED - position open beyond its stop', `Could not close ${size}x at market (${e.message}). A backup stop is resting; the bot retries (at most ${K} attempts, then it halts). Flatten in TopstepX if this repeats.`, { priority: 'urgent', tags: 'rotating_light' });   // 18f1 F5: max 1 push / position / 60 s
      return;
    }
    this.exitInFlight = { ...this.exitInFlight, outcome: 'accepted', okAt: Date.now() };
    this.exitRetryAt = 0;
    this.exitReason = 'through-stop';
    this.phase = 'FLATTENING';
  }

  // SESSION CLOSE FLATTEN (10/17 package; owner approved 10/14). Topstep: "All positions must be closed by 3:10 PM CT every weekday" (13:10 PT). The executor calls this on
  // every poll from sessionFlattenPt (13:05 PT) until the machine is FLAT. Same verified market-exit order as the slip-guard exit (round 4, QA B4) and the manual flatten:
  //   1. every protective order of ours (TP limit, stop, runner stop) is cancelled VERIFIED first; one still resting = send nothing this poll (the position stays protected);
  //   2. the position is re-read; 0 = a stop/target already closed it -> confirm;
  //   3. ONE market order for the whole size; phase FLATTENING; tick() confirms size 0, then sweeps every leftover order (cancelAllOrdersForContract) and resets.
  // A rejected market order: the stops that were cancelled in step 1 are put back AT ONCE (same prices and sizes) and the exit is retried on the next poll.
  // A resting entry order (PENDING_ENTRY) is cancelled through the verified blackout path (a fill wins and is flattened on the next call).
  // Returns 'none' (flat) | 'cancelled' | 'filled' | 'sent' | 'retry' | 'desynced'.
  // np1 NO-PROGRESS EXIT (Mac 10/24): the best price since the fill, from this poll's 1m bars and price, CAPPED at the check time (r1.1, MacDot 6380641991 #3):
  // a poll price counts only when the poll is at or before checkAt; a complete 1m bar only when it ends at or before checkAt. The fill minute counts poll prices only
  // (its extremes may precede the fill). A complete 1m bar up to checkAt that was never seen (a poll gap > the 3 bars fetched) marks the track as gapped.
  // "Best" is what the bot OBSERVED from its first sight of the fill: below +15 means "not seen reaching +15", not proof that it never traded there.
  noteNoProgressPrices(m1, px, now = Date.now()) {
    if (!Number.isFinite(this.npFillAt) || this.entryPrice == null || this.desynced) return;
    if ((this.phase === 'LEG23_OPEN' || this.phase === 'LEG3_OPEN') && !this.npState && this.npLeftLeg1At == null) this.npLeftLeg1At = now;   // r1.1: scaled out before the check
    if (this.phase !== 'LEG1_OPEN' || this.npState) return;
    const checkAt = npCheckAt(this.npFillAt), fav = p => this.dir === 1 ? p - this.entryPrice : this.entryPrice - p;
    // r1.5 (MacDot 6381681820): the scalar poll price is NOT evidence - it carries no proof it was traded after the fill (the 1m read precedes the fill
    // observation in the same poll). Only complete 1m bars that started after the fill-observation minute count (below). `px` is ignored.
    const bars = (Array.isArray(m1) ? m1 : []).filter(b => b && Number.isFinite(b.t) && Number.isFinite(b.h) && Number.isFinite(b.l) && b.t + 60000 <= now && b.t + 60000 <= checkAt).sort((a, b) => a.t - b.t);
    for (const b of bars) {
      if (!Number.isFinite(this.npCoveredTo) || b.t + 60000 <= this.npCoveredTo) continue;   // the fill minute or a bar already counted
      if (b.t > this.npCoveredTo) this.npGap = true;                                           // a complete 1m bar between them was never seen
      this.npBestPts = Math.max(Number.isFinite(this.npBestPts) ? this.npBestPts : 0, fav(this.dir === 1 ? b.h : b.l));
      this.npCoveredTo = b.t + 60000;
    }
  }
  // At the close of the first FULL 5m candle after the fill (5-10 min after it): not seen at +mfePts -> close at market through sessionFlatten('no-progress').
  // Decided ONCE per trade (npState). r1.1: the decision deadline is checkAt + 90 s, enforced FIRST (a late decision never acts, whatever the coverage).
  // Not assessed (left alone, journaled once): unknown fill time (adopted position), a gapped track, the deadline passed, or no price seen.
  async noProgressStep(cfg, now = Date.now()) {
    if (!cfg || cfg.enabled !== true) { if (this.phase !== 'FLAT') this.npDisabled = true; return null; }   // r1.1: recorded for the outcome row
    if (this.desynced) return null;
    const st = this.npState && typeof this.npState === 'object' ? this.npState : null;
    const d = this.dir === 1 ? 'LONG' : 'SHORT';
    if (st && st.decided === 'exit') {
      if (this.phase === 'FLAT') return 'flat';
      if (this.phase !== 'LEG1_OPEN' && this.phase !== 'FLATTENING' && !this.sessionMarketSent) {   // TP1 filled before the exit went out: the trade progressed, leave it
        this.npState = { ...st, decided: 'abandoned', abandonedAt: now, reason: 'scaled-out-before-send', phase: this.phase };
        try { this._manage('NO_PROGRESS_ABANDONED', `No-progress exit not sent: the ${d} scaled out at +20 first (phase ${this.phase}); the runner is managed as normal.`, { phase: this.phase }); } catch (e2) { /* journal only */ }
        return 'abandoned';
      }
      return this.sessionFlatten(`no progress: not seen at +${cfg.mfePts} pts by ${npHm(st.checkAt)}`, 'no-progress');
    }
    if (st || this.phase !== 'LEG1_OPEN' || this.entryPrice == null) return null;
    if (this.eaeState && this.eaeState.decided === 'exit') return null;   // edge r1: the early adverse exit owns this trade's exit (one decision owner; np1's own rule is unchanged)
    const mark = (decided, why, extra = {}) => {
      this.npState = { decided, why, at: now, ...extra };
      try { this._manage(decided === 'pass' ? 'NO_PROGRESS_PASS' : 'NO_PROGRESS_UNASSESSED', `No-progress check: ${why}.`, { mfePts: cfg.mfePts, ...extra }); } catch (e2) { /* journal only */ }
      return decided;
    };
    if (!Number.isFinite(this.npFillAt)) return mark('unassessed', 'the fill time is not known (adopted or restored position) - the trade is left alone');
    const checkAt = npCheckAt(this.npFillAt);
    if (now < checkAt) return null;
    const best = Number.isFinite(this.npBestPts) ? this.npBestPts : null, ex = { checkAt, fillSeenAt: this.npFillAt, bestPts: best, coveredTo: this.npCoveredTo ?? null, decidedLateMs: now - checkAt };
    if (now - checkAt > NP_DEADLINE_MS) return mark('unassessed', `the decision deadline (${NP_DEADLINE_MS / 1000} s after the 5m close) passed before it could be made - the trade is left alone`, ex);
    if (this.npGap) return mark('unassessed', 'a 1m bar after the fill was not seen (poll gap) - the best price is not known, the trade is left alone', ex);
    if (best != null && best >= cfg.mfePts) return mark('pass', `the ${d} was seen at +${best.toFixed(2)} pts (>= +${cfg.mfePts}) by the first full 5m close after the fill - kept`, ex);
    if (!Number.isFinite(this.npCoveredTo) || this.npCoveredTo < checkAt) return null;   // the candle's last 1m bar is not in yet: wait for it (until the deadline)
    if (best == null) return mark('unassessed', 'no price was seen since the fill - the trade is left alone', ex);
    this.npState = { decided: 'exit', at: now, ...ex };
    this.log(`  [no-progress] the ${d} from ${this.entryPrice.toFixed(2)} was seen at best +${best.toFixed(2)} pts by the first full 5m close after the fill (needs +${cfg.mfePts}) - closing it at market.`);
    try { this._manage('NO_PROGRESS_EXIT', `No-progress exit: the ${d} was seen at best +${best.toFixed(2)} pts by the first full 5m close after the fill (needs +${cfg.mfePts}), so it is closed at market now.`, { mfePts: cfg.mfePts, ...ex }); } catch (e2) { /* journal only */ }
    this.journal({ type: 'no_progress_exit', t: now, dir: this.dir, entryPrice: this.entryPrice, contracts: this.contracts, mfePts: cfg.mfePts, ...ex });
    return this.sessionFlatten(`no progress: not seen at +${cfg.mfePts} pts by ${npHm(checkAt)}`, 'no-progress');
  }
  // edge r1 A. EARLY ADVERSE EXIT (Mac 11/11: "I can agree with this"; study edge/A-LOSS-ANATOMY.md). Called by the executor every poll BEFORE np1 and the level-loss
  // step, with this poll's 1m bars. Once per trade (eaeState), before TP1 only (LEG1_OPEN): at the first completed 1m close cfg.afterSec (120 s) or more after the
  // fill observation - close at or beyond -cfg.lossPts (10) AND the best favourable excursion since the fill (np1's tracker, npBestPts) below +cfg.minSeenPts (3)
  // = the whole position is closed at market through sessionFlatten('early-adverse') (the safe-exit rule: verified cancels, intent on disk, lost reply = settle,
  // K sends, then HALT). The close must be within afterSec + 60 s of the fill and the decision within EAE_DECIDE_GRACE_MS of that close; otherwise 'unassessed'
  // (journaled, the trade is left alone). mode 'log' = the same row with wouldExit: true and NO order. ONE decision owner per trade: nothing is decided while another
  // exit is under way or decided (session close, morning hold, manual, np1, level-loss); once this exit is decided np1 and level-loss stand down.
  // Returns null | 'keep' | 'log' | 'unassessed' | 'abandoned' | 'other-exit' | 'retry' | sessionFlatten's result.
  // edge r1.1 (review S2): the decided early exit was not sent in time. No order, no cancel: the decision becomes 'abandoned' (np1 and level-loss own the trade again).
  _eaeExpire(now, where) {
    const st = this.eaeState || {}, d = this.dir === 1 ? 'LONG' : 'SHORT', ageSec = Number.isFinite(st.at) ? Math.round((now - st.at) / 1000) : null, limitSec = edgeExits.EAE_SEND_MAX_MS / 1000;
    this.eaeState = { ...st, decided: 'abandoned', abandonedAt: now, why: 'send-expired', expired: true, where };
    if (this.flattenKind === 'early-adverse') { this.flattenKind = null; this.sessionFlattenStarted = false; }
    this.log(`  [eae] the early exit decided ${ageSec} s ago was never sent (limit ${limitSec} s${where === 'restart' ? '; found after a restart' : ''}) - EXPIRED: no order is sent, the ${d} keeps its stop, TP1 and the no-progress rule.`);
    try { this.journal({ type: 'early_adverse_exit', t: now, journalId: this._edgeJid(), dir: this.dir, fill: this.entryPrice, contracts: this.contracts, decision: 'expired', result: 'expired', wouldExit: false, orderSent: false, decidedAt: st.at ?? null, ageSec, limitSec, where,
      pts: st.pts ?? null, mfe: st.mfe ?? null, close: st.close ?? null, closeAt: st.closeAt ?? null }); } catch (e2) { /* journal only */ }
    try { this.notify('Early exit not sent', 'Early exit not sent (broker did not answer in 60 s); trade back on its stop and TP1', { priority: 'high', tags: 'warning' }); } catch (e2) { /* alert only */ }   // r1.1 follow-up 3: once per trade (the decision expires once)
    try { this._manage('EARLY_ADVERSE_ABANDONED', `Early exit not sent: its decision was ${ageSec} s old (limit ${limitSec} s). Nothing was sent; the ${d} keeps its stop and TP1.`, { expired: true, ageSec, where }); } catch (e2) { /* journal only */ }
    if (where !== 'restart') { try { if (this.stateFile) this.saveState(); } catch (e2) { /* saved on the next change */ } }   // mid-restore the state is saved by the restore itself
  }
  // edge r1.1 (review S1): a HALTED machine with an ATR runner. The runner rests two closing orders with no link (the +stopPts stop and the TP2 limit); a halted
  // machine does not manage them, so a fill of one would leave the other on a flat account. Called by tick() while halted, it only ever CANCELS the bot's own orders:
  //   position still open -> the TP2 limit is cancelled (verified), the protective stop is kept: one resting order, and when it fills the account is flat;
  //   position flat on two polls in a row -> every order of this trade still working (by its saved id) is cancelled. Journal: orphan_sweep. Unreadable = nothing changes.
  async _haltedAtrRunnerStep() {
    if (this._haltPairDone || !this._atrRunner() || (this.phase !== 'LEG23_OPEN' && this.phase !== 'LEG3_OPEN')) return null;
    let pos, orders;
    try { pos = await getOpenPosition(this.token, this.accountId, this.contractId); orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { return 'unread'; }
    if (!Array.isArray(orders)) return 'unread';
    const has = id => id != null && orders.some(o => String(o.id) === String(id)), size = pos ? pos.size : 0;
    const cancel = async id => { let ok = false; try { ok = await cancelOrder(this.token, this.accountId, id); } catch (e) { ok = false; } if (ok) return true;
      try { const again = await getOpenOrders(this.token, this.accountId, this.contractId); return Array.isArray(again) && !again.some(o => String(o.id) === String(id)); } catch (e) { return false; } };
    if (size > 0) {
      this._haltFlatReads = 0;
      if (!has(this.targetOrderId)) return 'kept';
      const id = this.targetOrderId, stopLive = has(this.leg3StopOrderId), ok = await cancel(id);
      this.log(`  [halt] ATR runner while halted: TP2 limit ${id} ${ok ? 'cancelled' : 'could NOT be cancelled (retried next poll)'}; the runner stop ${stopLive ? `${this.leg3StopOrderId} stays resting` : 'is NOT resting'}.`);
      try { this.journal({ type: 'orphan_sweep', t: Date.now(), where: 'halt', journalId: this._edgeJid(), position: size, cancelled: ok ? [id] : [], failed: ok ? [] : [id], kept: stopLive ? [this.leg3StopOrderId] : [], note: 'halted with an ATR runner: the TP2 limit is cancelled so only the protective stop rests' }); } catch (e2) { /* journal only */ }
      if (ok) { this.targetOrderId = null; this.notify('Halted with the NY runner open', `The bot is halted. Its TP2 limit (${this.runnerPlan.tp2}) was cancelled so that only the runner's stop ${stopLive ? `(${this.trailStop ?? '?'}) rests` : 'would rest - but NO stop is resting: check TopstepX now'}. The 1x runner is yours to manage in TopstepX.`, { priority: 'urgent', tags: 'warning' }); }
      return ok ? 'tp2-cancelled' : 'retry';
    }
    this._haltFlatReads = (this._haltFlatReads || 0) + 1;
    if (this._haltFlatReads < 2) return 'flat-once';   // one zero read is not proof
    const own = [this.leg3StopOrderId, this.targetOrderId, this.stopOrderId].filter(has), cancelled = [], failed = [];
    for (const id of own) (await cancel(id) ? cancelled : failed).push(id);
    if (own.length) {
      this.log(`  [halt] ATR runner while halted: the account is flat - cancelled the bot's own leftover order(s) ${cancelled.join(', ') || 'none'}${failed.length ? `; could NOT cancel ${failed.join(', ')} (retried next poll)` : ''}.`);
      try { this.journal({ type: 'orphan_sweep', t: Date.now(), where: 'halt-flat', journalId: this._edgeJid(), position: 0, cancelled, failed, kept: [], note: 'halted, the account is flat on two reads: the orders this trade placed are cancelled so none can open a position' }); } catch (e2) { /* journal only */ }
      this.notify(failed.length ? 'Halted: an order of the closed runner could NOT be cancelled' : 'Halted: the runner closed, its other order was cancelled', failed.length ? `The account is flat but order ${failed.join(', ')} is still working and could open a position. Cancel it in TopstepX.` : `The account is flat. The runner's leftover order (${cancelled.join(', ')}) was cancelled, so nothing of this trade rests.`, { priority: failed.length ? 'urgent' : 'high', tags: 'broom' });
    }
    if (!failed.length) this._haltPairDone = true;
    return failed.length ? 'retry' : 'swept';
  }
  // edge r1.1 (review S1c): startup on a FLAT account. Orders that the saved trade state says this bot placed (stop, TP, runner stop - by id) and that are still
  // working are cancelled; nothing else is touched. Called by the executor after the startup reconciliation found no position. The account is read flat twice first.
  async sweepSavedOrphans() {
    const st = this.loadState();
    if (!st || st.contractId !== this.contractId || this.phase !== 'FLAT') return { swept: false, why: 'no saved trade for this contract' };
    const ids = [st.stopOrderId, st.targetOrderId, st.leg3StopOrderId].filter(x => x != null).map(String);
    if (!ids.length) return { swept: false, why: 'the saved trade tracks no stop or TP order' };
    // r1.1 follow-up 1: two INDEPENDENT position reads, sessionConfirmMs (1 s) apart like the session close's confirming read; both must succeed and both must
    // show flat. A read error or a disagreement = nothing is cancelled, journaled as skipped.
    const skip = (why, reads) => { try { this.journal({ type: 'orphan_sweep', t: Date.now(), where: 'startup-flat', result: 'skipped', why, reads, savedPhase: st.phase ?? null, savedIds: ids, cancelled: [], failed: [], note: 'the flat account was not confirmed by two position reads: no order was touched' }); } catch (e2) { /* journal only */ }
      this.log(`  [startup] orphan sweep skipped: ${why}. No order was touched.`); return { swept: false, skipped: true, why }; };
    let orders; const reads = [];
    for (let k = 0; k < 2; k++) {
      if (k === 1 && this.sessionConfirmMs > 0) await new Promise(r => setTimeout(r, this.sessionConfirmMs));
      try { const p = await getOpenPosition(this.token, this.accountId, this.contractId); reads.push(p && p.size ? p.size : 0); } catch (e) { reads.push('unreadable'); return skip('the broker position could not be read: ' + e.message, reads); }
    }
    if (reads[0] !== 0 || reads[1] !== 0) return skip(reads[0] !== reads[1] ? `the two position reads disagree (${reads[0]} then ${reads[1]})` : 'the account is not flat', reads);
    try { orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { return skip('the working orders could not be read: ' + e.message, reads); }
    if (!Array.isArray(orders)) return skip('the working orders could not be read', reads);
    const own = (Array.isArray(orders) ? orders : []).filter(o => o && ids.includes(String(o.id)) && (o.type === OrderType.STOP || o.type === OrderType.LIMIT));
    if (!own.length) return { swept: false, why: 'none of the saved orders is working' };
    const cancelled = [], failed = [];
    for (const o of own) { let ok = false; try { ok = await cancelOrder(this.token, this.accountId, o.id); } catch (e) { ok = false; }
      if (!ok) { try { const again = await getOpenOrders(this.token, this.accountId, this.contractId); ok = Array.isArray(again) && !again.some(x => String(x.id) === String(o.id)); } catch (e) { ok = false; } }
      (ok ? cancelled : failed).push({ id: o.id, size: o.size ?? null, price: o.stopPrice ?? o.limitPrice ?? null, kind: o.type === OrderType.STOP ? 'stop' : 'limit' }); }
    const others = (Array.isArray(orders) ? orders : []).filter(o => o && !ids.includes(String(o.id))).length;
    try { this.journal({ type: 'orphan_sweep', t: Date.now(), where: 'startup-flat', result: 'swept', position: 0, savedPhase: st.phase ?? null, savedAt: st.savedAt ?? null, cancelled, failed, notOurs: others, note: 'flat at startup: working orders the saved trade state says this bot placed are cancelled; orders it does not own are never touched' }); } catch (e2) { /* journal only */ }
    this.notify(failed.length ? 'Startup: a leftover order could NOT be cancelled' : 'Startup: leftover order cancelled', failed.length ? `The account is flat but ${failed.length} order(s) of the last trade (${failed.map(o => o.id).join(', ')}) are still working and could open a position. Cancel in TopstepX.` : `The account is flat. ${cancelled.length} order(s) the last trade left working (${cancelled.map(o => `${o.kind} ${o.size ?? '?'}x @ ${o.price ?? '?'}`).join(', ')}) were cancelled.`, { priority: failed.length ? 'urgent' : 'high', tags: 'broom' });
    return { swept: true, cancelled, failed, notOurs: others };
  }
  // r1.1 follow-up 2: after an expiry the trade must be back on its stop AND TP1. If the TP1 limit is not tracked (a started exit cancelled it and its put-back was
  // refused), it is put back once at its original price and quantity through the reject flow's own put-back (_exitPutTpBack). A TP1 limit found resting is adopted.
  async _eaeTpBackAfterExpiry() {
    const st = this.eaeState; if (!st || !st.expired || st.tpChecked) return;
    if (this.phase !== 'LEG1_OPEN' || this.desynced || this.sessionFlattenStarted) return;
    if (this.targetOrderId != null) { this.eaeState = { ...st, tpChecked: true }; return; }
    if (!(Number.isFinite(this.target1) && this.leg1Size > 0 && this.contracts > 0)) { this.eaeState = { ...st, tpChecked: true }; return; }
    let orders; try { orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { return; }   // unknown: retried next poll, nothing placed blind
    if (!Array.isArray(orders)) return;
    const px = roundToTick(this.target1, this.tickSize), resting = orders.find(o => o && o.limitPrice != null && Math.abs(o.limitPrice - px) < this.tickSize / 2 && String(o.id) !== String(this.stopOrderId));
    let how;
    if (resting) { this.targetOrderId = resting.id; how = 'adopted'; }
    else { this._exitTpBack = { price: this.target1, size: this.leg1Size, posSize: this.contracts }; await this._exitPutTpBack(this.contracts); how = this.targetOrderId != null ? 'placed' : 'failed'; }
    this.eaeState = { ...this.eaeState, tpChecked: true, tpBack: how };
    this.log(`  [eae] after the expired early exit: TP1 ${this.leg1Size}x @ ${px.toFixed(2)} ${how === 'placed' ? 'was put back' : how === 'adopted' ? 'was found resting and is tracked again' : 'could NOT be put back - the stop protects the trade'}.`);
    try { this._manage('EARLY_ADVERSE_TP1_BACK', how === 'failed' ? `After the expired early exit the TP1 limit could not be put back; the stop protects the trade.` : `After the expired early exit the TP1 limit (${this.leg1Size}x @ ${px.toFixed(2)}) rests again (${how}).`, { result: how, tp1: px, size: this.leg1Size }); } catch (e2) { /* journal only */ }
    try { if (this.stateFile) this.saveState(); } catch (e2) { /* saved on the next change */ }
  }
  async earlyAdverseStep(cfg, m1, now = Date.now()) {
    if (!cfg || (cfg.mode !== 'exit' && cfg.mode !== 'log') || this.desynced) return null;
    if (this.eaeState && this.eaeState.expired && !this.eaeState.tpChecked) { try { await this._eaeTpBackAfterExpiry(); } catch (e) { /* retried next poll */ } }   // (also the first poll after an expiry found on restore)
    const st = this.eaeState && typeof this.eaeState === 'object' ? this.eaeState : null, d = this.dir === 1 ? 'LONG' : 'SHORT';
    if (st && st.decided === 'exit') {
      if (this.phase === 'FLAT') return 'flat';
      if (this.phase !== 'LEG1_OPEN' && this.phase !== 'FLATTENING' && !this.sessionMarketSent) {   // TP1 filled before the exit went out: the trade worked, leave it
        this.eaeState = { ...st, decided: 'abandoned', abandonedAt: now, why: 'scaled-out-before-send', phase: this.phase };
        try { this._manage('EARLY_ADVERSE_ABANDONED', `Early exit not sent: the ${d} scaled out first (phase ${this.phase}); the runner is managed as normal.`, { phase: this.phase }); } catch (e2) { /* journal only */ }
        return 'abandoned';
      }
      if (this.sessionFlattenStarted && this.flattenKind !== 'early-adverse') return 'other-exit';   // another exit took the trade over (session close, manual): it drives itself
      // edge r1.1 (review S2): the SEND has an age limit too. Not sent (no market order, no exit intent, no attempt counted), still before TP1 with the stop tracked,
      // and EAE_SEND_MAX_MS past the decision = expired: nothing is sent, the trade keeps its stop, TP1 and np1. An exit that already went out is driven to its end as before.
      if (this.phase === 'LEG1_OPEN' && !this.sessionMarketSent && !this.exitInFlight && !(this.exitAttempts > 0) && this.stopOrderId != null && now - st.at > edgeExits.EAE_SEND_MAX_MS) { this._eaeExpire(now, 'poll'); try { await this._eaeTpBackAfterExpiry(); } catch (e) { /* retried next poll */ } return 'expired'; }
      return this.sessionFlatten(st.reason, 'early-adverse');
    }
    if (st || this.phase !== 'LEG1_OPEN' || this.entryPrice == null) return null;
    if (this.sessionFlattenStarted || (this.npState && this.npState.decided === 'exit') || (this.lossLevel && Number.isFinite(this.lossLevel.exitAt))) return null;   // another exit owns the trade
    const base = { t: now, journalId: this._edgeJid(), dir: this.dir, fill: this.entryPrice, fillSeenAt: this.npFillAt ?? null, contracts: this.contracts, mode: cfg.mode, afterSec: cfg.afterSec, lossPts: cfg.lossPts, minSeenPts: cfg.minSeenPts };
    const unassessed = (why, extra = {}) => {
      this.eaeState = { decided: 'unassessed', why, at: now };
      try { this.journal({ type: 'early_adverse_check', ...base, decision: 'unassessed', why, ...extra }); } catch (e2) { /* journal only */ }
      try { this._manage('EARLY_ADVERSE_UNASSESSED', `Early-exit check not made: ${why}. The trade is left alone.`, { ...extra }); } catch (e2) { /* journal only */ }
      return 'unassessed';
    };
    if (!Number.isFinite(this.npFillAt)) return unassessed('the fill time is not known (adopted or restored position)');
    const cb = edgeExits.eaeCloseBar(m1, this.npFillAt, now, cfg);
    if (cb.wait) return null;
    if (cb.missed) return unassessed(cb.why, { firstCloseAt: cb.firstCloseAt });
    const r2 = x => Math.round(x * 100) / 100, close = cb.bar.c, pts = r2(this.dir * (close - this.entryPrice));
    const ex = { close, closeAt: cb.closeAt, secAfterFill: Math.round((cb.closeAt - this.npFillAt) / 1000), decidedLateMs: cb.lateMs, pts };
    if (this.npGap) return unassessed('a 1m bar after the fill was not seen (poll gap), so the best price is not known', ex);
    if (!Number.isFinite(this.npCoveredTo) || this.npCoveredTo < cb.closeAt) {   // the tracker has not counted this bar yet (it runs first in the same poll): wait inside the grace
      if (now - cb.closeAt > edgeExits.EAE_DECIDE_GRACE_MS - 1) return unassessed('the best price since the fill was not tracked up to the 1m close', ex);
      return null;
    }
    const mfe = r2(Number.isFinite(this.npBestPts) ? this.npBestPts : 0);
    const pollPeakPts = Number.isFinite(this.peakUnrealized) && this.contracts > 0 && this.pointValue > 0 ? r2(this.peakUnrealized / (this.pointValue * this.contracts)) : null;   // information only (a poll price is not evidence, np1 r1.5)
    const adverse = pts <= -cfg.lossPts, neverWorked = mfe < cfg.minSeenPts;
    const shadow = { stop: this.stopPriceIntended ?? null, tp1: this.target1 ?? null, stopPts: Number.isFinite(this.stopPriceIntended) ? r2(Math.abs(this.entryPrice - this.stopPriceIntended)) : null, tp1Pts: Number.isFinite(this.target1) ? r2(Math.abs(this.target1 - this.entryPrice)) : null };
    const row = { ...base, ...ex, mfe, pollPeakPts, ...shadow };
    if (!(adverse && neverWorked)) {
      const why = !adverse ? `the 1m close was at ${pts >= 0 ? '+' : ''}${pts.toFixed(2)} pts (the rule needs -${cfg.lossPts} or worse)` : `the trade had been seen at +${mfe.toFixed(2)} pts (the rule needs below +${cfg.minSeenPts})`;
      this.eaeState = { decided: 'keep', at: now, pts, mfe, close, closeAt: cb.closeAt, why };
      try { this.journal({ type: 'early_adverse_check', ...row, decision: 'keep', why }); } catch (e2) { /* journal only */ }
      return 'keep';
    }
    const reason = `early exit: never worked, ${pts.toFixed(2)} pts at the 1m close ${ex.secAfterFill} s after the fill, best seen +${mfe.toFixed(2)}`;
    if (cfg.mode === 'log') {
      this.eaeState = { decided: 'log', at: now, pts, mfe, close, closeAt: cb.closeAt, reason, mode: 'log', shadow };
      this.log(`  [eae] LOG ONLY: the ${d} from ${this.entryPrice.toFixed(2)} closed the 1m bar at ${close} (${pts.toFixed(2)} pts) with best seen +${mfe.toFixed(2)} - the early exit WOULD close it; no order sent (mode log).`);
      try { this.journal({ type: 'early_adverse_exit', ...row, decision: 'log', wouldExit: true, orderSent: false }); } catch (e2) { /* journal only */ }
      try { this._manage('EARLY_ADVERSE_WOULD_EXIT', `Early-exit rule (log only): ${pts.toFixed(2)} pts at the 1m close ${ex.secAfterFill} s after the fill and never seen at +${cfg.minSeenPts} (best +${mfe.toFixed(2)}). It would have closed the ${d} here; nothing was sent.`, { pts, mfe, close }); } catch (e2) { /* journal only */ }
      return 'log';
    }
    const before = this.eaeState;
    this.eaeState = { decided: 'exit', at: now, pts, mfe, close, closeAt: cb.closeAt, reason, mode: 'exit', shadow };
    if (this.stateFile && this.saveState() !== true) { this.eaeState = before; this.log('  [eae] the early-exit decision could not be saved - not sending the exit this poll (retried next poll, inside the decision window).'); return 'retry'; }
    this.log(`  [eae] the ${d} from ${this.entryPrice.toFixed(2)} closed the 1m bar at ${close} (${pts.toFixed(2)} pts, ${ex.secAfterFill} s after the fill) and was never seen at +${cfg.minSeenPts} (best +${mfe.toFixed(2)}) - closing ${this.contracts}x at market.`);
    try { this.journal({ type: 'early_adverse_exit', ...row, decision: 'exit', wouldExit: true, orderSent: true }); } catch (e2) { /* journal only */ }
    return this.sessionFlatten(reason, 'early-adverse');
  }
  // edge r1 B. SESSION RUNNER RULE: decided ONCE at the first observation of the fill (the same moment and clock as the stop floor), saved with the trade.
  //   'live'      today's plan, untouched.
  //   'allAtTp1'  the TP1 limit closes ALL contracts at the scale-out price; no runner (the whole-position TP1 path of a 1-lot, _closeWholeLeg1).
  //   'atrTarget' TP1 as today; then the runner's stop goes to entry + stopPts (profit side, rounded INTO profit), a TP2 limit rests at fill +/- tp2AtrMult x ATR15,
  //               no trail; the session close flattens it. ATR15 missing, or a TP2 that is not beyond TP1 = 'live' for this trade (journaled with the reason).
  // Only a scale-out trade with exactly one runner (so1, leg2 0, 2+ contracts) takes a non-live mode. Journal: one runner_rule row per fill while the rule is in use.
  _decideRunnerPlan(now = Date.now()) {
    this.runnerPlan = null; this.tp2RetryAt = 0;
    if (!this.sessionRunnerFn) return null;
    let r = null, err = null; try { r = this.sessionRunnerFn(now); } catch (e) { err = e; r = null; }
    const n = this.contracts, fin = x => typeof x === 'number' && Number.isFinite(x);
    const requested = r && edgeExits.RUNNER_MODES.includes(r.mode) ? r.mode : 'live';
    let mode = requested, why = !r ? `the session runner rule could not be read (${err ? err.message : 'no answer'})` : (r.why || null), tp2 = null;
    const shape = !!this.runnerTrailRule && this.leg2Size === 0 && n > 1 && this.leg1Size === n - 1;
    if (mode !== 'live' && !shape) { mode = 'live'; why = `not a scale-out trade with one runner (${n} contract${n === 1 ? '' : 's'}, TP1 ${this.leg1Size}x, leg 2 ${this.leg2Size}x)`; }
    if (mode === 'atrTarget') {
      if (!(fin(r.atr15) && r.atr15 > 0 && fin(r.stopPts) && r.stopPts >= 0 && fin(r.tp2AtrMult) && r.tp2AtrMult > 0)) { mode = 'live'; why = why || 'ATR15 unavailable at the fill'; }
      else {
        tp2 = roundToTick(this.entryPrice + this.dir * r.tp2AtrMult * r.atr15, this.tickSize);
        if (!(fin(this.target1) && this.dir * (tp2 - this.target1) >= 4 * this.tickSize)) { mode = 'live'; why = `the ATR target ${tp2.toFixed(2)} (${r.tp2AtrMult} x ATR15 ${r.atr15}) is not beyond TP1 ${fin(this.target1) ? this.target1.toFixed(2) : '?'}`; tp2 = null; }
      }
    }
    if (mode === 'allAtTp1') { this.leg1Size = n; this.leg2Size = 0; }
    this.runnerPlan = { session: r && r.session ? r.session : null, mode, requested, atr15: r && fin(r.atr15) ? r.atr15 : null, stopPts: r && fin(r.stopPts) ? r.stopPts : null, tp2AtrMult: r && fin(r.tp2AtrMult) ? r.tp2AtrMult : null, tp2, why: mode !== requested ? why : null, at: now };
    const p = this.runnerPlan, D = this.dir === 1 ? 'LONG' : 'SHORT';
    const text = mode === 'allAtTp1' ? `all ${n} contracts exit at TP1 ${fin(this.target1) ? this.target1.toFixed(2) : '?'} (no runner)` : mode === 'atrTarget' ? `after TP1 the runner's stop goes to entry ${this.dir === 1 ? '+' : '-'}${p.stopPts} (${this._atrStopLevel().toFixed(2)}) and a TP2 limit rests at ${tp2.toFixed(2)} (${p.tp2AtrMult} x ATR15 ${p.atr15}); no trail` : `today's runner${mode !== requested ? ` (fell back from ${requested}: ${why})` : ''}`;
    this.log(`  [runner] ${p.session || '?'} session, ${D} ${n}x: ${text}.`);
    try { this.journal({ type: 'runner_rule', t: now, journalId: this._edgeJid(), dir: this.dir, fill: this.entryPrice, contracts: n, session: p.session, mode, requested, atr15: p.atr15, stopPts: mode === 'atrTarget' ? p.stopPts : null, tp2AtrMult: mode === 'atrTarget' ? p.tp2AtrMult : null, tp2, tp1: this.target1 ?? null, leg1Size: this.leg1Size, ...(mode !== requested ? { fallback: true, why } : {}) }); } catch (e2) { /* journal only */ }
    return p;
  }
  _edgeJid() { try { const j = this.journalIdFn ? this.journalIdFn() : null; return j != null ? j : (this.signalContext && this.signalContext.journalId != null ? this.signalContext.journalId : null); } catch (e) { return null; } }
  _atrRunner() { return !!(this.runnerPlan && this.runnerPlan.mode === 'atrTarget' && Number.isFinite(this.runnerPlan.tp2) && Number.isFinite(this.runnerPlan.stopPts)); }
  // The ATR runner's stop: entry + stopPts in the profit direction, rounded to the tick INTO profit (never worse than entry + stopPts, the profit-securing invariant).
  _atrStopLevel() {
    const raw = this.entryPrice + this.dir * this.runnerPlan.stopPts, t = this.tickSize;
    return Math.round((this.dir === 1 ? Math.ceil(raw / t - 1e-9) : Math.floor(raw / t + 1e-9)) * t * 100) / 100;
  }
  // The ATR runner's TP2 limit. Never stacked: before every send the working orders are read and a resting closing LIMIT at the TP2 price is adopted; an unreadable
  // list or an unknown send outcome waits (30 s) before the next check; a proven rejection retries after 15 s. Returns true when a TP2 limit is tracked.
  async _atrPlaceTp2(size, { fresh = false } = {}) {
    if (!this._atrRunner() || this.desynced || this._so1HaltWhy || !(size > 0)) return false;
    if (this.targetOrderId != null) return true;
    const px = roundToTick(this.runnerPlan.tp2, this.tickSize), side = this.sideFor(this.dir, true);
    if (!fresh) {
      let open = null; try { open = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { open = null; }
      if (!open) { this.tp2RetryAt = Date.now() + 30000; return false; }
      const mine = open.find(o => o && o.type === OrderType.LIMIT && (o.side === undefined || o.side === side) && Number.isFinite(o.limitPrice) && Math.abs(o.limitPrice - px) < this.tickSize / 2);
      if (mine) { this.targetOrderId = mine.id; this.target2 = px; this.log(`  [runner] the runner's TP2 limit ${mine.size ?? '?'}x @ ${px.toFixed(2)} is already resting (order ${mine.id}) - tracked, not placed again.`); return true; }
    }
    try {
      const id = await this.placeTargetLimit(size, px);
      if (!id) throw new Error('no order id in the reply');
      this.targetOrderId = id; this.target2 = px; this.tp2RetryAt = 0;
      this.log(`  [runner] ATR target: TP2 limit ${size}x @ ${px.toFixed(2)} (${this.runnerPlan.tp2AtrMult} x ATR15 ${this.runnerPlan.atr15} from the fill).`);
      try { this._manage('RUNNER_TP2_PLACED', `Runner target: a TP2 limit for the ${size}x runner rests at ${px.toFixed(2)} (${this.runnerPlan.tp2AtrMult} x the 15m ATR ${this.runnerPlan.atr15} from the fill). No trail.`, { tp2: px, atr15: this.runnerPlan.atr15 }); } catch (e2) { /* journal only */ }
      return true;
    } catch (e) {
      const rejected = e && e.orderRejected === true;
      this.tp2RetryAt = Date.now() + (rejected ? 15000 : 30000);
      this.log(`  [runner] the TP2 limit ${size}x @ ${px.toFixed(2)} was ${rejected ? 'REJECTED' : 'not confirmed'} (${e.message}) - the runner keeps its stop; checked again in ${rejected ? 15 : 30} s (the order list is read first, nothing is stacked).`);
      if (!this._tp2FailReported) { this._tp2FailReported = true; try { this._manage('RUNNER_TP2_NOT_PLACED', `The runner's TP2 limit at ${px.toFixed(2)} was ${rejected ? 'rejected' : 'not confirmed'} (${e.message}). The runner keeps its stop; the bot checks the order list and tries again.`, { tp2: px, rejected }); } catch (e2) { /* journal only */ } }
      return false;
    }
  }
  // The ATR runner went to 0: the TP2 limit or the +stopPts stop (or a manual close). The broker's working orders say which; both gone / both listed / unreadable =
  // decided by the last poll price, labelled unsure. Every leftover order is cancelled and the machine resets (flat is flat).
  async _atrRunnerClosed(leg3Size) {
    let orders = null; try { orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { orders = null; }
    const has = id => !!(orders && id != null && orders.some(o => String(o.id) === String(id)));
    const tpLive = has(this.targetOrderId), stopLive = has(this.leg3StopOrderId), tp2 = this.runnerPlan.tp2, stopPx = this.trailStop;
    let kind, sure = true;
    if (orders && this.targetOrderId != null && !tpLive && stopLive) kind = 'tp2';
    else if (orders && !stopLive && (tpLive || this.targetOrderId == null)) kind = 'stop';
    else { sure = false; const px = Number.isFinite(this.lastPrice) ? this.lastPrice : null; kind = px != null && Number.isFinite(stopPx) && Math.abs(px - tp2) < Math.abs(px - stopPx) ? 'tp2' : 'stop'; }
    const note = sure ? '' : ' (unsure: the order list could not tell which order filled; decided by the last price)';
    if (kind === 'tp2') {
      this.target2 = roundToTick(tp2, this.tickSize);   // the executor's close estimate reads the runner's TP2 price from here
      this.log(`  [LIVE FILL] runner TP2 filled: ${leg3Size}x closed at the ATR target ${tp2.toFixed(2)}${note}.`);
      this.notify('Runner target hit', `Runner closed ${leg3Size}x @ ${tp2.toFixed(2)} (TP2 = ${this.runnerPlan.tp2AtrMult} x ATR15).`, { tags: 'chart_with_upwards_trend' });
      try { this._manage('TP2_OR_BE', `The runner (${leg3Size}x) closed at its TP2 target ${tp2.toFixed(2)} (${this.runnerPlan.tp2AtrMult} x ATR15 from the fill).${note}`, { viaTarget: true, runnerRule: 'atrTarget', sure }); } catch (e2) { /* journal only */ }
    } else {
      this.log(`  [LIVE FILL] runner stopped at ${stopPx != null ? stopPx.toFixed(2) : '?'} (entry ${this.dir === 1 ? '+' : '-'}${this.runnerPlan.stopPts}), ${leg3Size}x${note}.`);
      this.notify('Runner stopped', `Runner closed ${leg3Size}x @ ${stopPx != null ? stopPx.toFixed(2) : '?'} (stop at entry ${this.dir === 1 ? '+' : '-'}${this.runnerPlan.stopPts}; TP2 ${tp2.toFixed(2)} not reached).`, { tags: 'chart_with_upwards_trend' });
      try { this._manage('RUNNER_STOPPED', `The runner (${leg3Size}x) was stopped out at ${stopPx != null ? stopPx.toFixed(2) : '?'} - its stop at entry ${this.dir === 1 ? '+' : '-'}${this.runnerPlan.stopPts} (the ATR target ${tp2.toFixed(2)} was not reached).${note}`, { stop: stopPx, runnerRule: 'atrTarget', sure }); } catch (e2) { /* journal only */ }
    }
    try { this.journal({ type: 'runner_exit', t: Date.now(), journalId: this._edgeJid(), dir: this.dir, fill: this.entryPrice, mode: 'atrTarget', kind, sure, price: kind === 'tp2' ? tp2 : stopPx ?? null, tp2, stop: stopPx ?? null, atr15: this.runnerPlan.atr15 }); } catch (e2) { /* journal only */ }
    // no POSITION_CLOSED row here: the executor's close estimate books the runner from the row above (TP2_OR_BE at TP2 / RUNNER_STOPPED at its stop), once
    await this.cancelAllOrdersForContract();
    this.reset();
  }
  // exits5m r1 CHANGE 5 LEVEL-LOSS EXIT (Mac-approved 11/09). Called by the executor every poll while exitOnLevelLoss is on and lossLevel is set (the trade's trigger
  // level, saved with the trade). bars5 = this poll's 5m read. Before TP1 only (LEG1_OPEN): the LAST completed 5m bar that closes after the fill (or after the
  // restore / adoption when the fill time is not known) closing 1+ tick back through the level against the position = decided ONCE (lossLevel.exitAt, saved
  // first), journal level_loss_exit, then the verified session-close exit labelled 'level-loss' (every poll until FLAT). The stop order is never moved here: it is
  // cancelled only inside that exit, verified, and put back at once if the market exit is rejected. TP1 filled before the exit went out = abandoned (the runner
  // is managed as normal). Not while another exit (session close, morning hold, np1) is under way. Returns null | 'abandoned' | 'other-exit' | sessionFlatten's result.
  async levelLossStep(bars5, now = Date.now()) {
    const L = this.lossLevel;
    if (!L || this.desynced || this.phase === 'FLAT') return null;
    const d = this.dir === 1 ? 'LONG' : 'SHORT', lvTxt = `${L.name ? L.name + ' ' : ''}${L.price}`;
    if (Number.isFinite(L.exitAt)) {
      if (this.phase !== 'LEG1_OPEN' && this.phase !== 'FLATTENING' && !this.sessionMarketSent) {
        this.lossLevel = null; this.saveState();
        try { this._manage('LEVEL_LOSS_ABANDONED', `Level-loss exit not sent: the ${d} scaled out first (phase ${this.phase}); the runner is managed as normal.`, { phase: this.phase }); } catch (e2) { /* journal only */ }
        return 'abandoned';
      }
      if (this.phase === 'FLATTENING' && this.flattenKind !== 'level-loss') return 'other-exit';
      return this.sessionFlatten(`level lost: a 5m close at ${L.close5m} back through ${lvTxt}`, 'level-loss');
    }
    if (this.phase !== 'LEG1_OPEN' || this.sessionFlattenStarted || (this.npState && this.npState.decided === 'exit') || (this.eaeState && this.eaeState.decided === 'exit') || this.entryPrice == null) return null;   // edge r1: + the early adverse exit
    const since = Number.isFinite(this.npFillAt) ? this.npFillAt : this.pxBoundaryAt;
    if (!Number.isFinite(since)) return null;
    const done = exits5m.completedBars(bars5, now).filter(b => b.t + exits5m.M5 > since), last = done[done.length - 1];
    if (!last || !exits5m.levelLost(this.dir, L.price, last.c, this.tickSize)) return null;
    this.lossLevel = { ...L, exitAt: now, close5m: last.c, barT: last.t };
    if (this.stateFile && this.saveState() !== true) { this.lossLevel = L; this.log('  [level-loss] the exit decision could not be saved - not sending the exit this poll (retried next poll).'); return 'retry'; }
    const pnlPts = Math.round(this.dir * (last.c - this.entryPrice) * 100) / 100;
    this.journal({ type: 'level_loss_exit', t: now, journalId: L.jid ?? null, dir: this.dir, level: L.price, levelName: L.name ?? null, close5m: last.c, barT: last.t, qty: this.contracts, entry: this.entryPrice, pnlPts });
    this.log(`  [level-loss] the 5m bar at ${new Date(last.t).toISOString().slice(11, 16)} UTC closed at ${last.c}, 1+ tick back through ${lvTxt} - closing the ${d} ${this.contracts}x at market (${pnlPts} pts from the fill).`);
    return this.sessionFlatten(`level lost: a 5m close at ${last.c} back through ${lvTxt}`, 'level-loss');
  }
  // r1.5 (MacDot 6381681820): may a 1m bar's price manage THIS position? Only if the bar STARTED in a minute after the boundary minute: the fill observation
  // (npFillAt), else - adopted or restored without a known fill time - the adoption / restore time (pxBoundaryAt). The bar's prices are then provably later
  // than the boundary; a bar from the fill minute or earlier (a same-minute pre-observation close, a frozen older bar) is rejected. Unknown = rejected.
  // r1.6 (MacDot 6381787697): AND the bar must be the CURRENT one - the 1m bar whose interval contains `now` (barT <= now < barT + 60 s). A future-stamped bar
  // and a frozen older bar (however long after the boundary) are rejected: both callers use the price as the current mark. Chronology, not a TTL.
  priceEvidenceOk(barT, now = Date.now()) {
    const b = Number.isFinite(this.npFillAt) ? this.npFillAt : this.pxBoundaryAt;
    return Number.isFinite(b) && Number.isFinite(barT) && Number.isFinite(now) && barT >= Math.floor(b / 60000) * 60000 + 60000 && barT <= now && now < barT + 60000;
  }
  // r1.3 (MacDot 6380800453): the ONE submission path for every no-progress recovery STOP. The intent (npState.recovering) is saved FIRST and the save must succeed;
  // then ONE direct STOP (no widening loop), classified: an order id back = confirmed; success:false = rejected; any other throw or no id = unknown. The intent stays on
  // disk through every result (a restart while it is unresolved latches a halt); only the caller clears it after every stop it needed is confirmed.
  async _npDurableStop(size, lvl, why) {
    if (!Number.isFinite(lvl) || !(size > 0) || this._so1HaltWhy) return { prot: 'not-sent' };
    const px = roundToTick(lvl, this.tickSize);
    this.npState = { ...(this.npState || {}), recovering: { why, size, lvl: px, at: Date.now() } };
    if (this.stateFile && this.saveState() !== true) return { prot: 'not-saved', lvl: px };
    try {
      const d = await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.STOP, side: this.sideFor(this.dir, true), size, stopPrice: px });
      const id = d && (d.orderId || d.id); return id ? { prot: 'confirmed', id, lvl: px } : { prot: 'unknown', lvl: px, err: 'no order id in the reply' };
    } catch (e) { return { prot: e && e.orderRejected === true ? 'rejected' : 'unknown', lvl: px, err: e && e.message }; }
  }
  _npProtText(r, size) {
    const at = Number.isFinite(r.lvl) ? r.lvl.toFixed(2) : '?';
    return r.prot === 'confirmed' ? `a ${size}x stop is resting at ${at} (confirmed)` : r.prot === 'rejected' ? `the ${size}x stop at ${at} was REJECTED - the position is UNPROTECTED`
      : r.prot === 'unknown' ? `the ${size}x stop at ${at} may or may not be resting (unknown${r.err ? ': ' + r.err : ''})` : r.prot === 'not-saved' ? `the recovery could not be saved first, so NO stop was sent - the position is UNPROTECTED`
      : 'no stop could be sent - the position is UNPROTECTED';
  }
  // r1.3: the no-progress put-back (replaces _sessionPutStopsBack while the flatten is a no-progress one): every stop through _npDurableStop; all confirmed = the intent is
  // cleared and the exit retries as before; anything else = so1 HALT naming the outcome, nothing else sent.
  async _npRestoreStops(stopsBack, size) {
    let left = Number.isFinite(size) && size > 0 ? size : null;
    for (const sb of (stopsBack || [])) {
      const n = left == null ? sb.size : Math.min(sb.size ?? left, left);
      if (!(n > 0)) continue;
      const r = await this._npDurableStop(n, sb.price, 'restore');
      if (r.prot !== 'confirmed') {
        this.npState = { ...(this.npState || {}), protection: r.prot, sending: false };
        try { this._manage('NO_PROGRESS_RECOVERY_HALT', `No-progress exit: putting the stop back did not confirm; ${this._npProtText(r, n)}. The bot halts.`, { protection: r.prot }); } catch (e2) { /* journal only */ }
        this._so1Halt(`the no-progress exit could not confirm its stop put-back; ${this._npProtText(r, n)}`, null, r.lvl);
        return false;
      }
      this[sb.field] = r.id; if (left != null) left -= n;
    }
    const { recovering, ...rest } = this.npState || {}; this.npState = rest; this.saveState();   // all confirmed: the intent is resolved (a failed save keeps it -> a restart halts: conservative)
    return true;
  }
  // r1.2/r1.3 (MacDot 6380744276 / 6380800453): the position SHRANK during the no-progress cancels - ambiguous (TP1, a partial stop fill, a manual close), never labelled
  // TP1. ONE durable, outcome-aware stop for the open size at the cancelled stop's level, no TP restore, then so1 HALT in every case; nothing else is sent.
  async _npReducedDuringCancel(stopsBack, size) {
    const sb = (stopsBack || []).find(x => x.field === 'stopOrderId') || (stopsBack || [])[0], lvl = sb && Number.isFinite(sb.price) ? sb.price : this.stopPriceIntended;
    const r = await this._npDurableStop(size, lvl, 'reduction');
    if (r.prot === 'confirmed') this.stopOrderId = r.id;
    this.targetOrderId = null; this.leg3StopOrderId = null;
    this.npState = { ...(this.npState || {}), decided: 'abandoned', abandonedAt: Date.now(), reason: 'size-reduced-during-cancel', sizeSeen: size, protection: r.prot, sending: false };
    const what = this._npProtText(r, size);
    try { this._manage('NO_PROGRESS_ABANDONED', `No-progress exit stopped: the position went from ${this.contracts} to ${size} contracts while its orders were being cancelled (TP1, a stop fill or a manual close - not proven); ${what}. The bot halts.`, { sizeSeen: size, protection: r.prot }); } catch (e2) { /* journal only */ }
    this._so1Halt(`the position went from ${this.contracts} to ${size} contracts while the no-progress exit was cancelling its orders (cause not proven); ${what}`, r.prot === 'confirmed' ? r.id : null, r.lvl);
    return 'desynced';
  }
  async sessionFlatten(reason = 'session close', kind = 'session') {
    const np = kind === 'no-progress';   // np1: the same verified exit, labelled as the no-progress exit
    jr.note(this, 'CLOSE_ATTEMPT', { attemptedCause: np ? 'no_progress' : kind === 'manual' ? 'manual_flatten' : 'session_close', attemptedActor: kind === 'manual' ? 'MANUAL' : 'AUTOMATIC', provenance: 'sessionFlatten caller', phaseObservation: this.phase, desyncedObservation: this.desynced, acceptance: jr.UNKNOWN, statement: 'Session-close function invoked; this attempt does not establish an accepted or initiating close request.' });
    if (this.desynced) return 'desynced';
    if (this.phase === 'FLAT') return 'none';
    if (this.phase === 'FLATTENING') {
      if (this.exitReason !== 'session-close' || this.sessionMarketSent) return 'sent';
      // ROUND 2 (QA B5): FLATTENING was entered on a (confirmed) zero read, so NO market order went out. If the broker now shows the position again on the same side,
      // the zero was stale: resume the flatten (restore the phase it had) instead of waiting forever for a fill that was never ordered.
      let p0; try { p0 = await getOpenPosition(this.token, this.accountId, this.contractId); } catch (e) { return 'retry'; }
      if (!p0 || !p0.size) return 'sent';
      const d0 = p0.type === 1 ? 1 : p0.type === 2 ? -1 : this.dir;
      if (d0 !== this.dir) return 'sent';   // the opposite side: tick()'s FLATTENING reversal guard handles it
      this.log(`  [session] flatten: the broker shows ${p0.size}x again after a zero read (stale) - putting the stops back and resuming the session-close exit.`);
      this.phase = this.sessionPrevPhase || 'LEG1_OPEN'; this.exitReason = null;
      // ROUND 3 (QA R2-1): the stops cancelled before the stale zeros are put back FIRST (at the true size), so the position is protected again before anything else
      const sb = this.sessionStopsBack || []; this.sessionStopsBack = null;
      const putBack = await this._sessionPutStopsBack(sb, p0.size);
      if (putBack === false || this.desynced || this._so1HaltWhy) return 'desynced';   // np1 r1.4: a failed / halted put-back ends THIS call - nothing further is cancelled or sent
    }
    if (this.phase === 'PENDING_ENTRY' && !this.fillHandled) {
      if (!this.entryOrderId) return 'retry';
      const r = await this.cancelPendingForBlackout(reason);
      return r === 'cancelled' ? 'cancelled' : r;
    }
    if (this.phase === 'PENDING_ENTRY') return 'sent';   // the fill-through-stop exit is already closing it (it retries itself every poll)
    if (this.exitRetryAt && Date.now() < this.exitRetryAt) return 'retry';   // bf-exitsafe (S4): backoff after a rejected exit; the stop and TP keep resting meanwhile
    this._exitTpBack = null;
    let size, pos;
    try { pos = await getOpenPosition(this.token, this.accountId, this.contractId); size = pos ? pos.size : 0; }
    catch (e) { this.log(`  [session] flatten: position read failed (${e.message}) - unknown, changing nothing, retrying next poll.`); return 'retry'; }
    const d = this.dir === 1 ? 'LONG' : 'SHORT';
    if (!this.sessionFlattenStarted && np) {   // np1
      this.sessionFlattenStarted = true; this.flattenKind = 'no-progress';
      this.log(`  [no-progress] closing the ${d} ${size}x at market now (${reason}).`);
      this.journal({ type: 'no_progress_flatten', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice, contractsAtFlatten: size, reason });
      this.notify('No-progress exit', `Closing ${d} ${size}x at market: it was not seen at +15 pts by the first full 5m candle after the fill. Confirming shortly.`, { priority: 'high', tags: 'hourglass' });
    }
    if (!this.sessionFlattenStarted && kind === 'level-loss') {   // exits5m r1 (change 5): the same verified exit, labelled as the level-loss exit
      this.sessionFlattenStarted = true; this.flattenKind = 'level-loss';
      this.log(`  [level-loss] closing the ${d} ${size}x at market now (${reason}).`);
      try { this._manage('LEVEL_LOSS_EXIT', `Level lost: the ${d} position (${size}x) is closed at market (${reason}). The stop was never moved.`, { size, reason }); } catch (e2) { /* journal only */ }
      this.notify('Level lost - exiting', `Closing ${d} ${size}x at market: ${reason}. Confirming shortly.`, { priority: 'high', tags: 'door' });
    }
    if (!this.sessionFlattenStarted && kind === 'early-adverse') {   // edge r1: the same verified exit, labelled as the early adverse exit
      this.sessionFlattenStarted = true; this.flattenKind = 'early-adverse';
      const e = this.eaeState || {}, lossTxt = Number.isFinite(e.pts) ? `${e.pts <= 0 ? '\u2212' : '+'}${Math.abs(e.pts).toFixed(2)} pts` : 'adverse';
      this.log(`  [eae] closing the ${d} ${size}x at market now (${reason}).`);
      try { this._manage('EARLY_ADVERSE_EXIT', `Early exit: never worked, ${lossTxt}. The ${d} position (${size}x) is closed at market (${reason}). The stop was never moved.`, { size, reason, pts: e.pts ?? null, mfe: e.mfe ?? null }); } catch (e2) { /* journal only */ }
      this.journal({ type: 'early_adverse_flatten', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice, contractsAtFlatten: size, reason });
      this.notify(`Early exit: never worked, ${lossTxt}`, `Closing ${d} ${size}x at market: ${Number.isFinite(e.pts) ? e.pts.toFixed(2) : '?'} pts at the 1m close after the fill and never seen in profit (best +${Number.isFinite(e.mfe) ? e.mfe.toFixed(2) : '?'}). Confirming shortly.`, { priority: 'high', tags: 'door' });
    }
    if (!this.sessionFlattenStarted && kind === 'manual') {   // r1.1: the phone / daily-floor / time-stop flatten on the safe-exit rule (same wording as before)
      this.sessionFlattenStarted = true; this.flattenKind = 'manual';
      this.log(`  [live] MANUAL FLATTEN requested — closing ${size}x at MARKET now (${reason}; safe-exit rule).`);
      try { this._manage('MANUAL_FLATTEN', `Manual flatten requested: ${size} contracts are being closed at market now.`, {}); } catch (e2) { /* journal only */ }
      // Tagged by entryPrice/dir so it can be matched back to the entry journal record and the broker's fills (manually ended, not a target/stop).
      this.journal({ type: 'manual_flatten', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice, contractsAtFlatten: size, ...(this.exitWhat && this.exitWhat !== 'manual' ? { what: this.exitWhat } : {}) });
      this.notify('Flatten requested', `Closing ${size}x at market now — confirming shortly.`, { tags: 'octagonal_sign' });
    }
    if (!this.sessionFlattenStarted) {
      this.sessionFlattenStarted = true; this.flattenKind = null;
      const mh = this.exitWhat = /^morning hold/.test(String(reason)) ? 'morning-hold' : 'session';   // bf-exitsafe (S3): the morning hold shares this path but keeps its own wording
      this.log(mh === 'morning-hold' ? `  [morning] MORNING HOLD: flattening the ${d} ${size}x now (${reason}).` : `  [session] SESSION CLOSE: flattening the ${d} ${size}x now (${reason}).`);
      try { this._manage('SESSION_FLATTEN', mh === 'morning-hold' ? `Morning hold: the ${d} position (${size}x) is closed at market (${reason}).` : `Session close: the ${d} position (${size}x) is closed at market (${reason}). Topstep requires flat by 13:10 PT (3:10 PM CT).`, { size, reason }); } catch (e2) { /* journal only */ }
      this.journal({ type: 'session_flatten', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice, contractsAtFlatten: size, reason });
      if (mh === 'morning-hold') this.notify('Morning hold: closing the position', `Closing ${d} ${size}x at market now (${reason}). Confirming shortly.`, { priority: 'high', tags: 'sunrise' });
      else this.notify('Session close: flattening', `Closing ${d} ${size}x at market now (Topstep: flat by 13:10 PT). Confirming shortly.`, { priority: 'high', tags: 'checkered_flag' });
    }
    if (!size) {
      // ROUND 2 (QA B5): one zero read is not proof - confirm it with a second read before treating the position as closed
      const c = await this._sessionConfirmZero([], null, 'before the cancels');
      if (c !== 'resume') return c;
      try { pos = await getOpenPosition(this.token, this.accountId, this.contractId); size = pos ? pos.size : 0; } catch (e) { return 'retry'; }
      if (!size) return 'retry';
    }
    if (pos && this.dir != null) { const posDir = pos.type === 1 ? 1 : pos.type === 2 ? -1 : this.dir; if (posDir !== this.dir) { await this.handleReversedPosition(pos); return 'retry'; } }
    if (this.flattenKind !== 'manual') jr.requestClose(this, this.flattenKind === 'no-progress' ? 'no_progress' : this.flattenKind === 'level-loss' ? 'level_loss' : this.flattenKind === 'early-adverse' ? 'early_adverse' : 'session_close', 'AUTOMATIC', 'sessionFlatten after existing guards and position read; before protection cancellation');   // r1.1: flattenNow already recorded the manual request
    // 1. protective orders first, verified (their prices/sizes are remembered so they can be put back if the exit is rejected)
    let open = [];
    try { open = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { this.log(`  [session] flatten: order list unreadable (${e.message}) - retrying next poll.`); return 'retry'; }
    const ours = [['targetOrderId', 'TP limit'], ['stopOrderId', 'stop'], ['leg3StopOrderId', 'runner stop']].filter(([f]) => this[f]);
    const cancelledIds = new Set(ours.map(([f]) => String(this[f])));   // ROUND 2 (QA B1): a lagging order list may still show these after their cancel: never treat them as leftovers
    const stopsBack = [];
    for (const [f, label] of ours) {
      const o = open.find(x => String(x.id) === String(this[f]));
      const gone = await this.cancelVerified(this[f], this._exitTag() + ' ' + label, o ? o.size : null, o ? (o.stopPrice ?? o.limitPrice ?? o.price ?? null) : null);
      if (!gone) { this.log(`  [session] flatten: the ${label} (order ${this[f]}) is still resting - NOT sending the market exit this poll (both could fill and reverse the position).`); await this._sessionPutStopsBack(stopsBack, size); return 'retry'; }
      if (f === 'targetOrderId') {   // bf-exitsafe (S4): the target is remembered so a failed exit puts it back too (only while the position is still this size)
        const tpPx = o && Number.isFinite(o.limitPrice ?? o.price) ? (o.limitPrice ?? o.price) : (this.phase === 'LEG1_OPEN' ? this.target1 : this.target2);
        const tpSz = o && Number.isFinite(o.size) ? o.size : (this.phase === 'LEG1_OPEN' ? this.leg1Size : this.leg2Size);
        if (Number.isFinite(tpPx) && tpSz > 0) this._exitTpBack = { price: tpPx, size: tpSz, posSize: size };
      }
      if (f !== 'targetOrderId') {
        // ROUND 2 (QA B2): recorded even when the (lagging) order list did not show it yet - then at the machine's own stop level
        const listed = o && Number.isFinite(o.stopPrice ?? o.price) ? (o.stopPrice ?? o.price) : null;
        const own = f === 'leg3StopOrderId' ? (this.trailStop ?? this.stopPriceIntended) : (this.trailStop ?? this.stopPriceIntended);
        const price = listed != null ? listed : own;
        if (Number.isFinite(price)) stopsBack.push({ field: f, size: o && Number.isFinite(o.size) ? o.size : null, price });
      }
      this[f] = null;
    }
    // any other working order on this contract (an untracked leftover) is swept too, verified
    let rest = [];
    try { rest = await getOpenOrders(this.token, this.accountId, this.contractId); }
    catch (e) { this.log(`  [session] flatten: order list unreadable after the cancels (${e.message}) - putting the stops back, retrying next poll.`); await this._sessionPutStopsBack(stopsBack, size); return 'retry'; }   // ROUND 2 (QA B3)
    for (const o of rest) {
      if (cancelledIds.has(String(o.id))) continue;   // QA B1: our own just-cancelled order, still listed by a lagging list
      const gone = await this.cancelVerified(o.id, this._exitTag() + ' leftover order', o.size, o.stopPrice ?? o.limitPrice ?? null);
      if (!gone) { this.log(`  [session] flatten: leftover order ${o.id} still resting - putting the stops back, retrying next poll.`); await this._sessionPutStopsBack(stopsBack, size); return 'retry'; }   // QA B3
    }
    // 2. re-read after the cancels (a TP or stop may have filled during them)
    let size2;
    try { const p2 = await getOpenPosition(this.token, this.accountId, this.contractId); size2 = p2 ? p2.size : 0; }
    catch (e) { this.log(`  [session] flatten: position re-read after the cancels failed (${e.message}) - putting the stops back (last known ${size}x), retrying next poll.`); await this._sessionPutStopsBack(stopsBack, size); return 'retry'; }
    if (!size2) {
      const c = await this._sessionConfirmZero(stopsBack, size, 'after the cancels');
      if (c !== 'resume') return c;
      try { const p3 = await getOpenPosition(this.token, this.accountId, this.contractId); size2 = p3 ? p3.size : 0; } catch (e) { await this._sessionPutStopsBack(stopsBack, size); return 'retry'; }
      if (!size2) { await this._sessionPutStopsBack(stopsBack, size); return 'retry'; }
    }
    size = size2;
    if (np) {
      // np1 r1.2: the position shrank during the cancels -> ambiguous (TP1 / stop / manual): one outcome-aware stop, then HALT (never resumed as a TP1 fill)
      if (this.phase === 'LEG1_OPEN' && Number.isInteger(this.contracts) && size < this.contracts) return this._npReducedDuringCancel(stopsBack, size);
      // np1 r1.1 #2: the exit intent is on disk BEFORE the market goes out (a restart before the flat confirmation latches a halt, never an adoption)
      this.npState = { ...(this.npState || {}), sending: true, sendingAt: Date.now(), size };
    }
    // bf-exitsafe: the K cap (every market send counts, rejected or unknown-then-still-open; it survives restarts)
    if ((this.exitAttempts || 0) >= safeExit.EXIT_MAX_ATTEMPTS) {
      await this._sessionPutStopsBack(stopsBack, size);
      return this._exitHalt(`the ${this._exitTitle().toLowerCase()} reached its cap of ${safeExit.EXIT_MAX_ATTEMPTS} market attempts and the position is still open (${size}x)`, `${this._exitTitle()} FAILED ${safeExit.EXIT_MAX_ATTEMPTS}x - FLATTEN IN TOPSTEPX NOW`, `The bot tried ${safeExit.EXIT_MAX_ATTEMPTS} times to close ${size}x at market and the broker still shows the position. The stop and TP were put back where possible. The bot has HALTED (no new entries). Use Flatten / Close position in TopstepX.`);
    }
    // bf-exitsafe: the in-flight exit is on disk BEFORE the market goes out (a restart while it is unresolved runs the same settle rule, _startupExitInFlight)
    this.exitAttempts = (this.exitAttempts || 0) + 1;
    this.exitInFlight = { kind: this._exitTag(), dir: this.dir, size, at: Date.now(), attempt: this.exitAttempts, outcome: 'sending' };
    if (this.stateFile && this.saveState() !== true) {
      if (np) this.npState = { ...this.npState, sending: false };
      this.exitInFlight = null; this.exitAttempts--;
      this.log(`  [${this._exitTag()}] the exit intent could not be saved - putting the stops back, NOT sending the exit this poll (retried next poll).`);
      await this._sessionPutStopsBack(stopsBack, size); return 'retry';
    }
    // 3. one market order for the whole size
    try { await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.MARKET, side: this.sideFor(this.dir, true), size }); }
    catch (e) {
      // bf-exitsafe: only a PROVEN rejection (the broker answered success:false) means nothing happened. Anything else (timeout, lost reply, transport, malformed
      // reply) may have been accepted: UNKNOWN -> no stop put back, no second order, until the broker reads settle (_resolveUnknownExit).
      if (safeExit.classifyExitError(e) === 'unknown') return this._resolveUnknownExit(size, stopsBack, e);
      if (np) this.npState = { ...this.npState, sending: false };
      this.exitInFlight = null;
      this.sessionExitFails = (this.sessionExitFails || 0) + 1;
      const T = this._exitTitle(), capped = this.exitAttempts >= safeExit.EXIT_MAX_ATTEMPTS, wait = safeExit.backoffMs(this.sessionExitFails);
      this.log(`  [${this._exitTag()}] CRITICAL: the ${T.toLowerCase()} market exit was REJECTED (${e.message}) - putting the stop and TP back${capped ? '; attempt cap reached, halting' : `, retrying ${wait ? `in ${wait / 1000} s` : 'next poll'}`} (attempt ${this.exitAttempts}/${safeExit.EXIT_MAX_ATTEMPTS}).`);
      try { this._manage('SESSION_FLATTEN_RETRY', `The ${T.toLowerCase()} market exit was rejected (${e.message}); the stop and TP were put back${capped ? ' and the attempt cap was reached' : ' and the bot retries'} (attempt ${this.exitAttempts} of ${safeExit.EXIT_MAX_ATTEMPTS}).`, { attempt: this.sessionExitFails, sends: this.exitAttempts, kind: this._exitTag() }); } catch (e2) { /* journal only */ }
      const putBack = await this._sessionPutStopsBack(stopsBack, size);
      if (capped) return this._exitHalt(`the ${T.toLowerCase()} market exit was rejected ${this.sessionExitFails}x (last: ${e.message}); attempt cap ${safeExit.EXIT_MAX_ATTEMPTS} reached`, `${T}: exit REJECTED ${safeExit.EXIT_MAX_ATTEMPTS}x - FLATTEN IN TOPSTEPX NOW`, `The broker rejected the market exit for ${size}x ${safeExit.EXIT_MAX_ATTEMPTS} times (${e.message}). The stop and TP were put back where possible. The bot has HALTED (no new entries). Use Flatten / Close position in TopstepX.`);
      if (putBack === false || this.desynced) return 'desynced';
      this.exitRetryAt = Date.now() + wait;
      if (this.sessionExitFails === 1) this.notify(`${T}: exit FAILED - retrying`, `Could not close ${size}x at market (${e.message}). Stop and TP put back; the bot retries (at most ${safeExit.EXIT_MAX_ATTEMPTS} attempts, then it halts). Flatten in TopstepX if this repeats.`, { priority: 'urgent', tags: 'rotating_light' });
      return 'retry';
    }
    this.exitInFlight = { ...this.exitInFlight, outcome: 'accepted', okAt: Date.now() };
    this.exitRetryAt = 0;
    this.sessionMarketSent = true;   // QA B5: only after the market order was accepted
    this.sessionPrevPhase = null;
    this.exitReason = 'session-close';
    this.phase = 'FLATTENING';
    if (this.flattenKind === 'manual') jr.note(this, 'CLOSE_SUBMISSION_ACKNOWLEDGED', { requestedMechanism: 'MARKET', observedMechanism: jr.UNKNOWN, certainty: 'PROVISIONAL', statement: 'Flatten market submission acknowledged; exit execution remains unconfirmed.' });
    return 'sent';
  }
  // bf-exitsafe: names for the four exits that share sessionFlatten (S3: every alert and journal text says which exit it is)
  _exitTag() { return this.flattenKind === 'no-progress' ? 'no-progress' : this.flattenKind === 'level-loss' ? 'level-loss' : this.flattenKind === 'early-adverse' ? 'early-adverse' : this.flattenKind === 'manual' ? 'manual' : (this.exitReason === 'through-stop' || (this.throughStop && this.phase === 'PENDING_ENTRY')) ? 'through-stop' : this.exitWhat === 'morning-hold' ? 'morning-hold' : 'session-close'; }   // r1.1: + manual, through-stop
  _exitTitle() { const t = this._exitTag(); if (t === 'manual') return { 'daily-floor': 'Daily-floor flatten', 'time-stop': 'Time-stop flatten' }[this.exitWhat] || 'Manual flatten'; return { 'no-progress': 'No-progress exit', 'level-loss': 'Level-loss exit', 'early-adverse': 'Early adverse exit', 'morning-hold': 'Morning-hold close', 'session-close': 'Session close', 'through-stop': 'Through-stop exit' }[t]; }
  // bf-exitsafe: HALT (no new entries, no further automatic order; latched across restarts until the account is flat with no orders) + one loud alert + journal.
  _exitHalt(why, title, body) {
    if (this.desynced && this._so1HaltWhy) return 'desynced';
    this.desynced = true; this._so1HaltWhy = why;
    if (this.saveState() === true && this.stateFile) this._haltLatched = true;
    this.log(`  [exit-safety] HALT: ${why}. Automated management stopped; resolve in the platform, then restart.`);
    this.notify(title, body, { priority: 'urgent', tags: 'rotating_light' });
    try { const ha = typeof healthAlert === 'function' ? healthAlert : typeof global.healthAlert === 'function' ? global.healthAlert : typeof this.healthAlert === 'function' ? this.healthAlert : null; if (ha) ha('halt', why); } catch (e2) { /* alert hook only */ }   // desk C's health alerts, when present
    try { this._manage('EXIT_HALT', `Exit safety halt: ${why}. The bot sends no further order and takes no new entries until the account is flat with no open orders and it is restarted.`, { kind: this._exitTag(), exitInFlight: this.exitInFlight || null }); } catch (e2) { /* journal only */ }
    return 'desynced';
  }
  _settleIo() { return { readPos: () => getOpenPosition(this.token, this.accountId, this.contractId), readOrders: () => getOpenOrders(this.token, this.accountId, this.contractId), sleep: ms => new Promise(r => setTimeout(r, ms)) }; }
  _settleOpts() { return this.settleReadMs != null ? { readMs: this.settleReadMs } : {}; }
  // bf-exitsafe: a 'same' verdict (the lost-reply exit did not fill) must also be confirmed by the order HISTORY: our market exit absent, or
  // cancelled/expired/rejected. Seen live/filled, or history unreadable = the position read may be stale -> the verdict becomes 'unsettled' (halt, never a retry).
  async _confirmNotFilled(r, dir, size, since) {
    if (r.verdict !== 'same') return r;
    let h;
    try { h = safeExit.exitOrderSeen(await liveOrdersMod.searchOrdersSince(this.token, this.accountId, this.contractId, since), { side: this.sideFor(dir, true), size, since }); }
    catch (e) { return { ...r, verdict: 'unsettled', why: `the order history could not be read (${e.message})` }; }
    if (h === 'unknown') return { ...r, verdict: 'unsettled', why: 'the order history has a row whose type/side/status could not be recognised, so it cannot prove the exit did not fill' };   // r1.1: fail safe
    return h === 'none' ? r : { ...r, verdict: 'unsettled', why: 'the order history shows the market exit live or filled while the position read still shows it open' };
  }
  // bf-exitsafe RULE 1: the market exit's reply was lost or timed out. Nothing is sent and no stop is put back until the broker's position and working orders
  // agree on consecutive reads (lib/safeExit.js settle). flat = done (leftovers swept); same = the exit did not happen (protection back, retry within the cap);
  // same side other size = protect the real size + HALT; opposite / never settles = HALT. Every branch is journaled; the halts alert loudly.
  async _resolveUnknownExit(size, stopsBack, err) {
    const T = this._exitTitle(), tag = this._exitTag(), d = this.dir === 1 ? 'LONG' : 'SHORT';
    this.exitInFlight = { ...(this.exitInFlight || {}), outcome: 'unknown', err: String(err && err.message || err) };
    this.saveState();
    this.log(`  [${tag}] the market exit (${size}x) was sent but its outcome is UNKNOWN (${this.exitInFlight.err}) - sending nothing, putting no stop back; reading the broker until it settles.`);
    try { this._manage('EXIT_OUTCOME_UNKNOWN', `${T}: the market exit for ${size}x was sent but the broker's reply was lost (${this.exitInFlight.err}). The bot sends nothing more and reads the position and orders until they agree.`, { kind: tag, size }); } catch (e2) { /* journal only */ }
    let r = await safeExit.settle(this._settleIo(), this.dir, size, this._settleOpts());
    if (r.verdict === 'flat' && r.orders.length) {   // flat with orders still working: sweep them, then the picture must settle flat again
      await this.cancelAllOrdersForContract();
      r = await safeExit.settle(this._settleIo(), this.dir, size, this._settleOpts());
      if (r.verdict === 'flat' && r.orders.length) r = { ...r, verdict: 'unsettled' };
    }
    r = await this._confirmNotFilled(r, this.dir, size, this.exitInFlight.at);
    const np = this.flattenKind === 'no-progress', ex = { kind: tag, size, verdict: r.verdict, net: r.net, reads: r.reads.length };
    if (np) this.npState = { ...this.npState, sending: false };
    if (r.verdict === 'flat') {
      this.exitInFlight = { ...this.exitInFlight, outcome: 'filled' };
      try { this._manage('EXIT_UNKNOWN_RESOLVED', `${T}: the lost-reply exit DID fill - the broker settled flat with no working orders (${r.reads.length} reads). Nothing else was sent.`, ex); } catch (e2) { /* journal only */ }
      this.log(`  [${tag}] the unknown exit settled FLAT (${r.reads.length} reads) - confirming.`);
      this.sessionMarketSent = true; this.sessionPrevPhase = null; this.exitRetryAt = 0; this.exitReason = 'session-close'; this.phase = 'FLATTENING';
      return 'sent';
    }
    if (r.verdict === 'same') {
      this.exitInFlight = null;
      try { this._manage('EXIT_UNKNOWN_NOT_FILLED', `${T}: the lost-reply exit did NOT fill - the broker settled on the same ${d} ${size}x with no working order (${r.reads.length} reads). Stop and TP put back; the exit is retried (attempt ${this.exitAttempts} of ${safeExit.EXIT_MAX_ATTEMPTS} used).`, ex); } catch (e2) { /* journal only */ }
      this.log(`  [${tag}] the unknown exit did NOT fill (the broker settled on ${d} ${size}x, nothing working) - stop and TP back, retry next poll (${this.exitAttempts}/${safeExit.EXIT_MAX_ATTEMPTS}).`);
      const putBack = await this._sessionPutStopsBack(stopsBack, size);
      if (this.exitAttempts >= safeExit.EXIT_MAX_ATTEMPTS) return this._exitHalt(`the ${T.toLowerCase()} could not be confirmed after ${this.exitAttempts} market attempts and the position is still open (${size}x)`, `${T} FAILED - FLATTEN IN TOPSTEPX NOW`, `${this.exitAttempts} market exits for ${size}x did not close the position. The stop and TP were put back where possible. The bot has HALTED (no new entries). Use Flatten / Close position in TopstepX.`);
      if (putBack === false || this.desynced) return 'desynced';
      this.notify(`${T}: exit did not fill - retrying`, `The market exit for ${d} ${size}x got no reply and the broker still shows the position. Stop and TP are back; the bot retries (at most ${safeExit.EXIT_MAX_ATTEMPTS} attempts).`, { priority: 'urgent', tags: 'rotating_light' });
      return 'retry';
    }
    const what = r.verdict === 'unsettled' ? r.why ? `${r.why}` : `the broker position/orders did not settle within ${safeExit.SETTLE_MAX_MS / 1000} s (last read: ${r.net == null ? 'unreadable' : r.net + ' net, ' + (r.orders ? r.orders.length : '?') + ' working order(s)'})`
      : r.verdict === 'opposite' ? `the broker now shows the OPPOSITE side (${r.net > 0 ? 'LONG' : 'SHORT'} ${Math.abs(r.net)}x)` : `the broker shows ${d} ${Math.abs(r.net)}x instead of ${size}x or flat`;
    if (r.verdict === 'mismatch') {   // same side, another size: protection for the REAL size at the cancelled stop's level (no target), then halt
      const sb = (stopsBack || []).find(x => x.field === 'stopOrderId') || (stopsBack || [])[0], lvl = sb && Number.isFinite(sb.price) ? sb.price : this.stopPriceIntended;
      try { if (Number.isFinite(lvl)) this.stopOrderId = await this.placeProtectiveStop(Math.abs(r.net), lvl); } catch (e3) { this.log(`  [${tag}] CRITICAL: the protective stop for the real ${Math.abs(r.net)}x could not be placed (${e3.message}).`); }
    }
    return this._exitHalt(`the ${T.toLowerCase()} for ${d} ${size}x got no reply and ${what}`, `${T}: exit outcome UNKNOWN - FLATTEN IN TOPSTEPX NOW`,
      `The market exit for ${d} ${size}x got no reply (${this.exitInFlight.err}) and ${what}. The bot has HALTED: no new entries and no further orders${r.verdict === 'mismatch' ? ' (a stop for the real size was placed)' : ''}. Check TopstepX and use Flatten / Close position, then restart.`);
  }
  // ROUND 2 (QA B5): a zero position read during the flatten is confirmed by a second read after a short pause. Still 0 -> FLATTENING without a market order
  // (tick() confirms flat and sweeps; sessionFlatten resumes if a later read shows the position again). Not 0 -> 'resume' (the caller sends the exit).
  async _sessionConfirmZero(stopsBack, lastSize, where) {
    if (this.sessionConfirmMs > 0) await new Promise(r => setTimeout(r, this.sessionConfirmMs));
    let p; try { p = await getOpenPosition(this.token, this.accountId, this.contractId); } catch (e) { await this._sessionPutStopsBack(stopsBack, lastSize); return 'retry'; }
    if (p && p.size) { this.log(`  [session] flatten: the zero read ${where} was stale (now ${p.size}x) - sending the exit.`); return 'resume'; }
    this.log(`  [session] flatten: the position is 0 ${where} (confirmed by a second read) - confirming and sweeping every leftover order.`);
    this.sessionPrevPhase = this.phase; this.sessionMarketSent = false;
    this.sessionStopsBack = (stopsBack || []).slice();   // ROUND 3 (QA R2-1): kept so a resume can put them back if the zeros were stale
    this.exitReason = 'session-close'; this.phase = 'FLATTENING';
    return 'sent';
  }
  // Puts back the stops cancelled in step 1, never for more contracts than are open (ROUND 2, QA B4: a TP that partly filled during its cancel leaves fewer contracts).
  async _sessionPutStopsBack(stopsBack, size) {
    if (this.flattenKind === 'no-progress') { const ok = await this._npRestoreStops(stopsBack, size); if (ok) await this._exitPutTpBack(size); return ok; }   // np1 r1.3: every no-progress recovery is durable + outcome-aware
    let left = Number.isFinite(size) && size > 0 ? size : null, ok = true;
    for (const s of stopsBack) {
      const n = left == null ? s.size : Math.min(s.size ?? left, left);
      if (!(n > 0)) continue;
      try { this[s.field] = await this.placeProtectiveStop(n, s.price); if (left != null) left -= n; if (!this[s.field]) ok = false; }
      catch (e) { ok = false; this.log(`  [session] CRITICAL: could not put the stop back (${e.message}).`); this.notify('UNPROTECTED POSITION - flatten in TopstepX', `The ${this._exitTitle().toLowerCase()} exit failed and the stop ${n}x @ ${Number(s.price).toFixed(2)} could not be put back (${e.message}). Flatten in TopstepX now.`, { priority: 'urgent', tags: 'rotating_light' }); }
    }
    if (ok) await this._exitPutTpBack(size);
    return ok ? true : 'failed';   // never false here: a failed plain put-back keeps the exit retrying (false = np1's durable halt)
  }
  // bf-exitsafe (S4): the target cancelled for the exit is put back at its price, only while the position is still the size it protected (a shrink = it may have filled)
  async _exitPutTpBack(size) {
    const tp = this._exitTpBack; this._exitTpBack = null;
    if (!tp || this.targetOrderId || size !== tp.posSize || this.desynced) return;
    try { this.targetOrderId = await this.placeTargetLimit(Math.min(tp.size, size), tp.price); }
    catch (e) { this.log(`  [session] the target ${tp.size}x @ ${tp.price} could not be put back (${e.message}) - the stop protects the position.`); }
  }

  // MANUAL PAUSE (10/16): the owner paused new entries from the phone: a resting entry order is cancelled at the pause start (verified path, fill wins).
  async cancelPendingForPause(untilTxt) {
    if (this.phase !== 'PENDING_ENTRY' || !this.entryOrderId) return 'none';
    const d = this.dir === 1 ? 'LONG' : 'SHORT', e = this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?';
    return this._cancelPendingVerified({ label: 'pause cancel', cancelReason: `entry cancelled: paused by you${untilTxt ? ' until ' + untilTxt : ''}`, logDone: `entry cancelled: the resting ${d} entry at ${e} was cancelled because you paused the bot${untilTxt ? ' until ' + untilTxt : ''}.`,
      code: 'ENTRY_CANCELLED_PAUSE', manageText: `The resting ${d} entry at ${e} was cancelled unfilled because you paused new entries from the phone${untilTxt ? ' until ' + untilTxt : ''}.`, manageExtra: {}, noteTitle: null, noteText: null });
  }

  // ROUND 4 FAR-LIMIT SWITCH: the resting Levels entry is far from price and MAC fired the same way intrabar: cancel it through the same verified path
  // (position re-read before and after; a fill ALWAYS wins and is then managed normally). The executor takes MAC's market entry only on 'cancelled'.
  async cancelPendingForFarLimit(info = {}) {
    if (this.phase !== 'PENDING_ENTRY' || !this.entryOrderId) return 'none';
    const d = this.dir === 1 ? 'LONG' : 'SHORT', e = this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?', px = Number.isFinite(info.px) ? info.px.toFixed(2) : '?';
    return this._cancelPendingVerified({ label: 'far-limit cancel', cancelReason: `entry cancelled: far-limit switch - the ${d} order at ${e} was ${info.pts != null ? info.pts : '?'} pts from price ${px}; MAC grade ${info.grade || '?'} fired the same way, taking MAC's market entry`,
      logDone: `entry cancelled (far-limit switch): the resting ${d} at ${e} is ${info.pts != null ? info.pts : '?'} pts from price ${px} and MAC fired grade ${info.grade || '?'} the same way.`,
      code: 'FAR_LIMIT_SWITCH', manageText: `The resting ${d} entry at ${e} was ${info.pts != null ? info.pts : '?'} pts (${info.atrX != null ? info.atrX : '?'} x 15m ATR) from price ${px} while MAC fired ${d} grade ${info.grade || '?'} intrabar, so it was cancelled unfilled and MAC's market entry is taken instead.`,
      manageExtra: { limit: this.intendedEntryPrice, px: info.px, pts: info.pts, atrX: info.atrX, grade: info.grade }, noteTitle: null, noteText: null });
  }

  // 10/16: the main loop hands every poll's 1-minute bars to the machine while an entry rests unfilled. Only records (sticky); tick() acts on it. No I/O.
  notePendingBars(bars) {
    if (this.phase !== 'PENDING_ENTRY' || !this.pendingCancelOnStopTouch) return this.pendingStopTouched;
    if (!this.pendingStopTouched) {
      const t = pendingStopTouch(this.dir, this.stopPriceIntended, bars, this.entrySignalTime);
      if (t) { this.pendingStopTouched = t; this.log(`  [live] price ${t.price.toFixed(2)} reached the planned stop ${this.stopPriceIntended.toFixed(2)} while the entry is unfilled - cancelling it (fill wins if it filled first).`); }
    }
    // round 3 (owner 10/16): TP1 traded before the entry filled = the move already happened without us. Same rule mirrored: TP1 is beyond the entry in the trade's direction.
    if (!this.pendingStopTouched && !this.pendingTargetTouched && Number.isFinite(this.target1)) {
      const t = pendingStopTouch(-this.dir, this.target1, bars, this.entrySignalTime);
      if (t) { this.pendingTargetTouched = t; this.log(`  [live] price ${t.price.toFixed(2)} reached TP1 ${this.target1.toFixed(2)} while the entry is unfilled - cancelling it (fill wins if it filled first).`); }
    }
    return this.pendingStopTouched || this.pendingTargetTouched;
  }
  // PLAN_TARGET_HIT (round 3): same verified cancel as the stop-touch cancel (position re-read before and after; a fill always wins).
  async cancelPendingForTargetTouch(touch) {
    const d = this.dir === 1 ? 'LONG' : 'SHORT', tp = this.target1 != null ? this.target1.toFixed(2) : '?', e = this.intendedEntryPrice != null ? this.intendedEntryPrice.toFixed(2) : '?';
    const txt = `Entry cancelled: price reached TP1 ${tp} before the entry filled; the move already happened.`;
    return this._cancelPendingVerified({
      label: 'TP1-touch cancel', cancelReason: txt, logDone: `${txt} (${d} entry at ${e}, price ${touch && Number.isFinite(touch.price) ? touch.price.toFixed(2) : '?'})`,
      code: 'PLAN_TARGET_HIT', manageText: `${txt} The resting ${d} entry at ${e} was cancelled unfilled.`, manageExtra: { tp1: this.target1, touch: touch ? touch.price : null },
      noteTitle: 'Entry cancelled: TP1 reached first', noteText: `Your unfilled ${d} entry at ${e} was cancelled: price reached TP1 ${tp} before it filled, so the move already happened. Nothing is open.`,
    });
  }

  // 10/18 RULE 2: a position whose every contract is leg 1 (a 1-lot) went to 0. The TP1 limit and the stop both close the WHOLE position, so the broker's working orders
  // decide which one filled: TP1 gone + stop still working = TP1; stop gone + TP1 still working = stopped out. Both gone / both listed (lag) / unreadable = decided by the
  // last poll price (nearer TP1 = TP1), labelled 'unsure'. Either way: every leftover order is cancelled and the machine resets (flat is flat).
  async _closeWholeLeg1() {
    const n = this.contracts;
    let orders = null; try { orders = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { orders = null; }
    const has = id => !!(orders && id != null && orders.some(o => String(o.id) === String(id)));
    const tpLive = has(this.targetOrderId), stopLive = has(this.stopOrderId);
    let kind, sure = true;
    if (orders && !tpLive && stopLive) kind = 'tp1';
    else if (orders && tpLive && !stopLive) kind = 'stop';
    else {
      sure = false;
      const px = Number.isFinite(this.lastPrice) ? this.lastPrice : null, st = this.profitTrail && this.profitTrailStop != null ? this.profitTrailStop : this.stopPriceIntended;
      kind = px != null && Number.isFinite(this.target1) && Number.isFinite(st) && Math.abs(px - this.target1) < Math.abs(px - st) ? 'tp1' : 'stop';
    }
    const lockStop = this.profitTrail ? this.profitTrailStop : null;
    const stopPx = lockStop != null ? (this.dir === 1 ? Math.max(this.stopPriceIntended, lockStop) : Math.min(this.stopPriceIntended, lockStop)) : this.stopPriceIntended;
    this.lastExit = { kind, sure, t: Date.now(), dir: this.dir, entry: this.entryPrice, stop: this.stopPriceIntended, lockStop, target1: this.target1, target2: this.target2, contracts: n };
    if (kind === 'tp1') {
      this.log(`  [LIVE FILL] first scale filled: the whole ${n}x closed at TP1 ${this.target1.toFixed(2)}${sure ? '' : ' (unsure: both orders gone or the order list unreadable; decided by the last price)'}.`);
      this.notify('Target 1 hit - position closed', `${n}x closed @ ${this.target1.toFixed(2)} (first scale; a ${n}-contract trade has no runner).`, { tags: 'chart_with_upwards_trend' });
      try { this._manage('TP1_FILLED', `TP1 filled: all ${n} contract${n === 1 ? '' : 's'} closed at the first scale ${this.target1.toFixed(2)} (a ${n}-contract trade has no second leg or runner).${sure ? '' : ' (The broker order list could not tell which order filled; the last price was nearer TP1.)'}`, { tp1: this.target1, whole: true, sure }); } catch (e2) { /* journal only */ }
      try { this._manage('POSITION_CLOSED', 'The position is fully closed (the whole trade exited at TP1).', {}); } catch (e2) { /* journal only */ }
    } else {
      this.log(`  [LIVE FILL] full stop-out on all ${n} contracts${sure ? '' : ' (unsure: decided by the last price)'}.`);
      if (!(this.fullStopPushOwner === 'health' && lockStop == null)) this.notify('Stopped out', `Full stop-out on all ${n} contracts @ ${stopPx.toFixed(2)}${lockStop != null ? ' (profit lock)' : ''}.`, { priority: 'high', tags: 'chart_with_downwards_trend' });   // r1.1: ONE push per full stop - the executor's richer "Full stop" push (lib/healthAlerts.js) owns it when wired
      try { this._manage('STOP_FILLED', `The stop filled: all ${n} contracts closed at about ${stopPx.toFixed(2)}${lockStop != null ? ' (the profit-lock stop)' : ' (the planned stop)'}.${sure ? '' : ' (The broker order list could not tell which order filled; decided by the last price.)'}`, { sure }); } catch (e2) { /* journal only */ }
    }
    await this.cancelIfSet('targetOrderId');
    await this.cancelIfSet('stopOrderId');
    await this.cancelAllOrdersForContract();
    this.reset();
  }

  // Called every poll cycle. Reconciles our assumed phase against the
  // account's REAL position size and drives the cancel/replace cascade.
  async tick(opts = {}) {
    if (this._cancelInFlight && !opts.cancelOwner) return;
    if (this.desynced) { try { await this._haltedAtrRunnerStep(); } catch (e) { /* edge r1.1 (review S1): cancel-only housekeeping, retried next poll */ } return; }
    if (this.phase === 'FLAT') return;
    // profittrail4: a position read that FAILS (HTTP 200 success:false, malformed body, network error) means "unknown", never "flat": change nothing, keep every resting
    // order and phase, retry on the next poll; after POSITION_READ_ALERT_AFTER consecutive failures send one urgent alert.
    let pos;
    try {
      pos = await getOpenPosition(this.token, this.accountId, this.contractId);
      if (this.posReadFails) { this.log(`  [live] position read recovered after ${this.posReadFails} failed attempt(s).`); this.posReadFails = 0; this.posReadAlerted = false; }
    } catch (e) {
      this.posReadFails = (this.posReadFails || 0) + 1;
      if (this.phase === 'PENDING_ENTRY') this._reportBlockExposure('ENTRY_RESTING_IN_BLOCK', `The resting entry ${this.entryOrderId} may still be working inside a time block: the position cannot be read (${e.message}), so the bot cannot cancel it safely yet. It keeps retrying. Check TopstepX.`, { cancelOutcome: 'position-unreadable' });   // TIME BLOCKS r2
      if (this.posReadFails === 1 || this.posReadFails % 10 === 0) this.log(`  [live] position read FAILED (${e.message}) - treating the position as UNKNOWN: keeping all resting orders and the current phase, retrying (failure #${this.posReadFails}).`);
      if (this.posReadFails >= POSITION_READ_ALERT_AFTER && !this.posReadAlerted) {
        this.posReadAlerted = true;
        try { this._manage('POSITION_UNREADABLE', `The broker position could not be read ${this.posReadFails} times in a row (${e.message}), so the bot is changing nothing: every stop and target keeps resting and it keeps trying. An urgent alert was sent.`, {}); } catch (e2) { /* journal only */ }
        this.notify('Cannot read the broker position', `The position read has failed ${this.posReadFails} times in a row (${e.message}). The bot is NOT changing anything: all stops and targets stay resting. If this continues, check TopstepX and the relay.`, { priority: 'urgent', tags: 'rotating_light' });
      }
      return;
    }
    if (this.phase === 'PENDING_ENTRY' && !this.cancelPositionMatches(pos)) { this.log('  [live] pending position identity mismatch; no order mutation.'); return; }
    const size = pos ? pos.size : 0;
    if (opts.cancelOwner && size !== this.contracts) return; // changed during adoption: retry, never DESYNC or reset from an old size
    // hotfix 4b: a position on the OPPOSITE side of what this machine holds (e.g. both of our stops filled) used to look like an ordinary size mismatch
    if (pos && pos.size && this.dir != null && (this.phase === 'LEG1_OPEN' || this.phase === 'LEG23_OPEN' || this.phase === 'LEG3_OPEN')) {
      const posDir = pos.type === 1 ? 1 : pos.type === 2 ? -1 : null;
      if (posDir != null && posDir !== this.dir) { await this.handleReversedPosition(pos); return; }
    }

    const n = this.contracts;

    if (this.phase === 'PENDING_ENTRY') {
      if (size > 0 && size < n && !opts.cancelOwner) { await this.resolvePendingCancel(); return; }
      if (size === n) {
        if (this.stopOrderId && !(await this.protectCancelFill(pos)).ok) return;
        let realFillPrice = pos.averagePrice;
        // QA 10/16 C2: a missing / zero / non-finite broker fill price never drives an exit or a crash: protect at the planned entry instead
        if (!(Number.isFinite(realFillPrice) && realFillPrice > 0)) { this.log('  [live] fill price unreadable (' + realFillPrice + ') - using the planned entry for protection, NOT exiting.'); realFillPrice = this.intendedEntryPrice; }
        // ACTUALLY re-derive stop/target1/target2/tightStop off the REAL
        // fill price now (2026-09-21 fix — the comment used to claim this
        // happened; the code never did it, it just kept reusing the stale
        // signal-time estimate). A real overnight fill landed 26pts away
        // from the estimate, which put the stale stop price on the WRONG
        // SIDE of the actual entry — the exchange rejected it, and because
        // that happened before this.phase advanced, the position sat with
        // ZERO resting orders. Shifting every reference price by the exact
        // fill-vs-estimate delta preserves the intended point distances
        // regardless of how far the real fill drifted from the estimate.
        if (this._cancelFillPlan) {
          const base = this._cancelFillPlan;
          this.stopPriceIntended = base.stop; this.target1 = base.target1; this.target2 = base.target2; this.tightStopPrice = base.tight;
        } else {
          // entry stop floor package: the plan as sent, kept once. A protection failure leaves the machine in PENDING_ENTRY and this block runs again on the
          // next poll; it now starts from the same plan every time instead of shifting the already-shifted stop and targets a second time.
          const base = this._fillPlanBase || (this._fillPlanBase = { stop: this.stopPriceIntended, target1: this.target1, target2: this.target2, tight: this.tightStopPrice });
          this.stopPriceIntended = base.stop; this.target1 = base.target1; this.target2 = base.target2; this.tightStopPrice = base.tight;
        }
        const delta = realFillPrice - this.intendedEntryPrice;
        // FILL-SLIPPAGE GUARD (10/16): a fill far from the intended price (news / gap) keeps the ORIGINAL stop and targets; a fill already through the stop exits at once.
        const slip = fillSlipDecision({ dir: this.dir, intended: this.intendedEntryPrice, fill: realFillPrice, stop: this.stopPriceIntended, guard: this.fillSlipGuard });
        if (slip.action === 'exit') { await this._exitFilledThroughStop(n, realFillPrice, slip); return; }
        if (slip.action === 'keep') {
          this.log(`  [live] FILL-SLIPPAGE GUARD: fill @ ${realFillPrice.toFixed(2)} is ${Math.abs(delta).toFixed(2)} pts from the signal price ${this.intendedEntryPrice.toFixed(2)} (more than ${slip.threshold.toFixed(2)}): NOT shifting - keeping the original stop ${this.stopPriceIntended.toFixed(2)} and targets ${this.target1.toFixed(2)} / ${this.target2.toFixed(2)}.`);
          try { this._manage('FILL_SLIP_KEPT', `The entry filled at ${realFillPrice.toFixed(2)}, ${Math.abs(delta).toFixed(2)} pts from the planned ${this.intendedEntryPrice.toFixed(2)} (news or a gap). The stop and targets were NOT moved with it: the original stop ${this.stopPriceIntended.toFixed(2)} and targets ${this.target1.toFixed(2)} / ${this.target2.toFixed(2)} are kept.`, { fill: realFillPrice, slip: delta, threshold: slip.threshold }); } catch (e2) { /* journal only */ }
          if (!this.fillHandled) this.notify('Big slip on the entry - stop kept', `${this.dir === 1 ? 'LONG' : 'SHORT'} filled @ ${realFillPrice.toFixed(2)}, ${Math.abs(delta).toFixed(2)} pts from the plan ${this.intendedEntryPrice.toFixed(2)}. Original stop ${this.stopPriceIntended.toFixed(2)} kept (not shifted); the session stop floor from the fill still applies.`, { priority: 'high', tags: 'warning' });
        } else if (delta !== 0) {
          this.log(`  [live] fill @ ${realFillPrice.toFixed(2)} differs from signal estimate ${this.intendedEntryPrice.toFixed(2)} by ${delta.toFixed(2)}pts — shifting stop/target(s) to preserve intended distances.`);
          this.stopPriceIntended = roundToTick(this.stopPriceIntended + delta, this.tickSize);
          this.target1 = roundToTick(this.target1 + delta, this.tickSize);
          this.target2 = roundToTick(this.target2 + delta, this.tickSize);
          if (this.tightStopPrice != null) this.tightStopPrice = roundToTick(this.tightStopPrice + delta, this.tickSize);
        }
        // lv1 r13.3.5 TP1 FROM THE FILL (Mac 10/30, plans-1030/tp1-from-fill): with the scale-out runner on, TP1 is measured from the ACTUAL fill on every fill
        // path - the slip guard's keep included, which kept the planned absolute TP1 (10/30 07:45 PT: 41 pts from the fill instead of 15). The distance is the
        // plan as sent (|planned TP1 - signal price|, from the kept plan base, so a retry or a restart gives the same TP1). The stop is not touched here.
        if (this.tp1FromFill && this.runnerTrailRule) {
          const b1 = this._cancelFillPlan || this._fillPlanBase, d1 = b1 && Number.isFinite(b1.target1) ? Math.abs(b1.target1 - this.intendedEntryPrice) : NaN;
          if (Number.isFinite(d1) && d1 > 0) {
            const was1 = this.target1, t1 = roundToTick(realFillPrice + this.dir * d1, this.tickSize);
            this.target1 = t1;
            if (t1 !== was1 && !this.fillHandled) {
              this.log(`  [live] TP1 FROM THE FILL: TP1 ${t1.toFixed(2)} = the fill ${realFillPrice.toFixed(2)} ${this.dir === 1 ? '+' : '-'} ${d1.toFixed(2)} pts (the planned TP1 distance), not ${Number.isFinite(was1) ? was1.toFixed(2) : was1} (${Number.isFinite(was1) ? Math.abs(was1 - realFillPrice).toFixed(2) : '?'} pts from the fill).`);
              try { this._manage('TP1_FROM_FILL', `TP1 is measured from the actual fill: ${t1.toFixed(2)} = ${realFillPrice.toFixed(2)} ${this.dir === 1 ? '+' : '-'} ${d1.toFixed(2)} pts (the planned TP1 distance), not ${Number.isFinite(was1) ? was1.toFixed(2) : was1}. The stop is unchanged by this.`, { fill: realFillPrice, tp1: t1, tp1Before: was1, plannedTp1Pts: d1, slipAction: slip.action }); } catch (e2) { /* journal only */ }
            }
          }
        }
        // ENTRY STOP FLOOR from the ACTUAL fill (6.1 revised): after the shift / keep above, a stop closer than the session floor to the real fill is moved OUT
        // to it (LONG min(stop, fill - floor), SHORT max(stop, fill + floor), outward to the tick). 'exit' returned above and is never overridden.
        {
          const fl = this._entryFloorForFill(), natural = this.stopPriceIntended;
          const f = fl ? stopFloor.applyFloor({ dir: this.dir, entry: realFillPrice, stop: natural, floorPts: fl.pts, tickSize: this.tickSize }) : null;
          if (f && f.valid && f.floored) this.stopPriceIntended = f.stop;
          if (fl && this.tightStopPrice != null) { const ft = stopFloor.applyFloor({ dir: this.dir, entry: realFillPrice, stop: this.tightStopPrice, floorPts: fl.pts, tickSize: this.tickSize }); if (ft.valid) this.tightStopPrice = ft.stop; }
          if (!this.fillHandled) {
            if (f && f.floored) this.log(`  [live] ENTRY STOP FLOOR: the stop ${natural.toFixed(2)} is ${f.naturalPts} pts from the fill ${realFillPrice.toFixed(2)}; moved out to ${f.stop.toFixed(2)} (the ${fl.pts}-pt ${fl.session} floor from the fill).`);
            try { this._manage('STOP_FLOOR_FROM_FILL', f && f.floored ? `The stop was ${f.naturalPts} pts from the actual fill ${realFillPrice.toFixed(2)}, inside the ${fl.pts}-pt ${fl.session} floor, so it was moved out to ${f.stop.toFixed(2)} (${f.finalPts} pts).` : `The stop ${this.stopPriceIntended.toFixed(2)} is ${f ? f.finalPts : Math.round(Math.abs(realFillPrice - this.stopPriceIntended) * 100) / 100} pts from the actual fill ${realFillPrice.toFixed(2)}${fl ? `, at or beyond the ${fl.pts}-pt ${fl.session} floor` : ' (no floor configured)'}: not moved.`,
              { version: stopFloor.VERSION, fill: realFillPrice, slipAction: slip.action, plannedStop: this._cancelFillPlan ? this._cancelFillPlan.stop : this._fillPlanBase ? this._fillPlanBase.stop : null, naturalStop: natural, naturalPts: f ? f.naturalPts : null, floorPts: fl ? fl.pts : null, floorSession: fl ? fl.session : null, floorAt: fl ? fl.at : null, floored: !!(f && f.floored), finalStop: this.stopPriceIntended, finalPts: f ? f.finalPts : null }); } catch (e2) { /* journal only */ }
          }
        }
        this.entryPrice = realFillPrice;
        if (!this.fillHandled) { const t = Date.now(); this.npFillAt = t; this.npBestPts = 0; this.npCoveredTo = Math.floor(t / 60000) * 60000 + 60000; this.npGap = false; this.npState = null; this.eaeState = null; this._decideRunnerPlan(t); }   // np1: first observation of the fill (the venue time is not known); edge r1: the session runner plan, once
        this.fillHandled = true;
        jr.note(this, 'FILL_OBSERVED', { observationSource: 'broker-position', quantity: n, averagePrice: Number.isFinite(pos.averagePrice) && pos.averagePrice > 0 ? pos.averagePrice : jr.UNKNOWN, managementReferencePrice: this.entryPrice, entryOrderId: this.entryOrderId, actualFillIds: jr.UNKNOWN, statement: 'Entry exposure observed in broker position; individual execution IDs remain UNKNOWN.' });
        this.log(`  [LIVE FILL] entry filled: ${this.dir === 1 ? 'LONG' : 'SHORT'} ${n}x @ ${this.entryPrice.toFixed(2)}`);
        this.notify('Entry filled', `${this.dir === 1 ? 'LONG' : 'SHORT'} ${n}x @ ${this.entryPrice.toFixed(2)}`, { tags: 'moneybag' });
        this._reportBlockExposure('ENTRY_FILLED_IN_BLOCK', `The ${this.dir === 1 ? 'LONG' : 'SHORT'} entry ${this.entryOrderId} (${n}x) was seen filled inside a time block. It is managed and protected as normal; the venue fill time is not known to the bot.`, { quantity: n, cancelRequested: !!this._pendingCancelIntent });   // TIME BLOCKS r2
        try { this._manage('ENTRY_FILLED', `The ${this.dir === 1 ? 'LONG' : 'SHORT'} ${n}x filled at ${this.entryPrice.toFixed(2)}${delta !== 0 ? ` (the signal expected ${this.intendedEntryPrice.toFixed(2)}, so the stop and targets were shifted by ${delta.toFixed(2)} pts to keep the planned distances)` : ''}.`, { fill: this.entryPrice }); } catch (e2) { /* journal only */ }
        // Journaled at the REAL fill price/time (not the signal-time
        // estimate) so this lines up with what the broker's own fill
        // records show — that's what lets a later analysis match "why this
        // trade fired" back to "what it actually made."
        this.journal({
          type: 'entry', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice,
          contracts: n, leg1Size: this.leg1Size, leg2Size: this.leg2Size,
          source: this.source, grade: this.grade, ...(this.signalContext || {}),
        });
        // Safety net: if placing protection STILL fails for any other
        // reason, this must never fail silently into a naked position —
        // urgent phone alert immediately, and phase stays PENDING_ENTRY so
        // the next tick retries with these now-corrected prices instead of
        // the stale ones that caused the rejection in the first place.
        try {
          if (this._cancelFillPlan && !(await this.protectCancelFill(pos)).ok) return;
          if (!this.stopOrderId && this._restoredPending) {   // combined fix 3 (r5): bounded reconciliation after a restart
            let open = null; try { open = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { open = null; }
            if (open === null) {
              if (!this._ordersUnreadableReported) { this._ordersUnreadableReported = true; try { this._manage('STARTUP_ORDERS_UNREADABLE', `After the restart the ${n}x position is filled but the working orders cannot be listed, so the bot cannot tell whether the previous run's STOP is resting. Nothing is added blind; it retries every poll.`, {}); } catch (e) { /* journal only */ }
                this.notify('Check stops after restart', `Filled ${n}x after a restart, but working orders cannot be read. The bot will not add a STOP blind (it may already have one) and retries every poll. Check TopstepX now.`, { priority: 'urgent', tags: 'rotating_light' }); }
              return;
            }
            // r6 (MacDot 6331588524 #1): the position can change while the order list is awaited (an existing STOP fills): re-read it; a changed exposure submits nothing this poll
            let pos2 = null; try { pos2 = await getOpenPosition(this.token, this.accountId, this.contractId); } catch (e) { pos2 = undefined; }
            if (pos2 === undefined || !pos2 || pos2.size !== n || pos2.type !== pos.type) { this.log(`  [live] restart reconciliation: the position changed while the orders were read (${n}x -> ${pos2 === undefined ? 'unreadable' : pos2 ? pos2.size + 'x' : 'flat'}); nothing submitted this poll, re-evaluated on the next.`);
              try { this._manage('STARTUP_EXPOSURE_CHANGED', `During restart reconciliation the position changed from ${n}x to ${pos2 === undefined ? 'unreadable' : pos2 ? pos2.size + 'x' : 'flat'} while the working orders were being read. No protection was submitted on the stale quantity; the next poll re-evaluates from the fresh position.`, { before: n, after: pos2 === undefined ? null : pos2 ? pos2.size : 0 }); } catch (e) { /* journal only */ }
              return; }
            const side = this.sideFor(this.dir, true), known = new Set([...(this._cancelProtectionIds || [])].map(String)), want = roundToTick(this.stopPriceIntended, this.tickSize);
            const cand = open.filter(o => o && o.type === OrderType.STOP && o.side === side && String(o.id) !== String(this.entryOrderId) && !known.has(String(o.id)));
            const fmt = o => `${o.size}x @ ${o.stopPrice} (${Number.isFinite(o.stopPrice) ? Math.round(Math.abs(realFillPrice - o.stopPrice) * 100) / 100 : '?'} pts from the fill)`;
            if (cand.length === 1 && cand[0].size === n && cand[0].stopPrice === want) { this.stopOrderId = cand[0].id;
              try { this._manage('STARTUP_STOP_MATCHED', `After the restart the filled ${n}x position already had one STOP whose side, size and price match this trade's plan exactly (${fmt(cand[0])}). That is matching geometry, not proof of who placed it; it is tracked as this trade's STOP instead of placing a second one.`, { stopId: cand[0].id, stopPrice: cand[0].stopPrice, planned: want, basis: 'geometry match (side, size, exact price), not ownership' }); } catch (e) { /* journal only */ } }
            else if (cand.length) {
              const covered = cand.reduce((a, o) => a + (Number.isFinite(o.size) ? o.size : 0), 0), uncovered = Math.max(0, n - covered);
              // r6 (MacDot 6331588524 #2): ONE request, no widen retries (a retry after an accepted-but-lost answer would stack); the outcome is classified
              let placed = null, outcome = 'none'; if (uncovered > 0) { try { const d = await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.STOP, side, size: uncovered, stopPrice: want }); placed = d && (d.orderId || d.id) || null; outcome = placed ? 'accepted' : 'unknown'; }
                catch (e) { outcome = e && e.orderRejected === true ? 'rejected' : 'unknown'; } }
              const addTxt = uncovered <= 0 ? (covered > n ? `They cover ${covered}x, MORE than the position: if all fill, the position reverses.` : 'They cover the full size; nothing was added.')
                : outcome === 'accepted' ? `A STOP was added for the ${uncovered}x not covered: ${uncovered}x @ ${want} (order ${placed}).` : outcome === 'rejected' ? `Adding a STOP for the ${uncovered}x not covered was REJECTED by the broker (${uncovered}x @ ${want}); it was not retried. The ${uncovered}x is UNPROTECTED.`
                : `A STOP request for the ${uncovered}x not covered (${uncovered}x @ ${want}) got NO definite answer: it may be resting. It was not retried, so nothing can stack.`;
              const text = `After the restart the filled ${n}x position has ${cand.length} untracked protective STOP(s) that do not match this trade's plan (${want}): ${cand.map(fmt).join(', ')}. ${addTxt} Nothing was widened or cancelled. Automatic management is halted: review the protective orders in TopstepX.`;
              this.log('  [live] PROTECTION UNVERIFIED: ' + text); this.notify('PROTECTION UNVERIFIED - action required', text, { priority: 'urgent', tags: 'rotating_light' });
              this.desynced = true; try { this._manage('DESYNC', text, { reason: 'PROTECTION_UNVERIFIED', untracked: cand.map(o => ({ id: o.id, size: o.size, stopPrice: o.stopPrice })), uncovered, addedStopId: placed, addOutcome: outcome, addedStop: uncovered > 0 ? { size: uncovered, stopPrice: want } : null, planned: want, fill: realFillPrice }); } catch (e) { /* journal only */ }
              return;
            }
            this._restoredPending = false;
          }
          if (!this.stopOrderId) this.stopOrderId = await this.placeProtectiveStop(n, this.stopPriceIntended, { initialEntry: true });
          this.targetOrderId = await this.placeTargetLimit(this.leg1Size, this.target1);
          this.phase = 'LEG1_OPEN';
          try { this._manage('PROTECTION_PLACED', `Protection placed: stop for all ${n}x at ${this.stopPriceIntended.toFixed(2)} and a TP1 limit for ${this.leg1Size}x at ${this.target1.toFixed(2)}.`, { stop: this.stopPriceIntended, tp1: this.target1 }); } catch (e2) { /* journal only */ }
        } catch (e) {
          this.log(`  [live] CRITICAL: protective stop/target failed to place after fill — position is UNPROTECTED: ${e.message}`);
          this.notify('UNPROTECTED POSITION — action required', `Entry filled ${n}x @ ${realFillPrice.toFixed(2)} but the protective stop/target order failed: ${e.message}. Check the account and add protection manually NOW.`, { priority: 'urgent', tags: 'rotating_light' });
          try { this._manage('NO_PROTECTION', `The entry filled but the protective stop/target could not be placed (${e.message}); the bot keeps retrying and has sent an urgent alert.`, {}); } catch (e2) { /* journal only */ }
        }
      } else if (size === 0 && this.entryOrderId && this.fillHandled) {
        // 10/16: the entry DID fill and the position is already 0 - the backup stop (or a manual close) closed it: confirm like an exit.
        // Round 4 (QA low item): only a fill THROUGH the planned stop is labelled 'through-stop'; a normal fill whose protection failed and was then closed by hand is a manual close.
        this.log(this.throughStop ? '  [live] the entry that filled through its planned stop is already closed (backup stop or manual) - confirming.' : '  [live] the filled entry (protection had failed) is already closed - confirming as a manual close.');
        this.exitReason = this.throughStop ? 'through-stop' : 'manual'; this.phase = 'FLATTENING';
      } else if (size === 0 && this.entryOrderId) {
        const stillOpen = (await getOpenOrders(this.token, this.accountId, this.contractId)).some(o => o.id === this.entryOrderId);
        if (!stillOpen) { await this._cancelPendingVerified({ request: false, label: 'entry resolution', cancelReason: this._pendingCancelIntent ? `${this._pendingCancelIntent} (verified unfilled)` : 'entry verified unfilled', logDone: 'entry terminal and unfilled', code: 'ENTRY_RESOLVED', manageText: 'Entry verified terminal and unfilled.' }); }
        // BLACKOUT CANCEL (owner order 2026-10-13): an unfilled LIMIT/STOP entry must not keep resting into the NY-open or Asia blackout. Same verified-cancel path as the expiry
        // below, but the position is re-read before AND after the cancel: a fill always wins and is then managed normally.
        else if (!opts.noBlackout && this.blackoutFn && this.blackoutFn(Date.now())) { await this.cancelPendingForBlackout(this.blackoutFn(Date.now())); }
        else if (!opts.noBlackout && this._startupCancel) { await this.cancelPendingForStartup(); }   // TIME BLOCKS r3: restored entry from the previous run
        // NEWS (10/16): a high-impact release is due within newsCancelRestingSec: pull the resting LIMIT/STOP entry (MARKET entries are never pulled).
        else if (!opts.noStopTouch && this.newsRestingFn && this.entryType !== 'MARKET' && this.newsRestingFn(Date.now())) { await this.cancelPendingForNews(this.newsRestingFn(Date.now())); }
        // PENDING STOP-TOUCH (10/16): price traded at/beyond the planned stop before the entry filled = the setup is invalid: cancel now (same verified path, fill wins).
        else if (!opts.noStopTouch && this.pendingCancelOnStopTouch && this.pendingStopTouched) { await this.cancelPendingForStopTouch(this.pendingStopTouched); }
        else if (!opts.noStopTouch && this.pendingCancelOnStopTouch && this.pendingTargetTouched) { await this.cancelPendingForTargetTouch(this.pendingTargetTouched); }   // round 3: TP1 first
        // A resting LIMIT/STOP entry (levels-plan trades, and now the
        // mac-only pullback-level trades too) previously had NO timeout in
        // LIVE mode — only paper mode's `pending` object ever expired one.
        // A stale limit sitting for hours can fill on a setup that's long
        // since invalidated. Mirrors CONFIG.pendingExpireMs, same as paper.
        else if (this.pendingExpireMs && Date.now() - this.entrySignalTime >= this.pendingExpireMs) {
          this.log('  [live] pending entry expired unfilled — cancelling.');
          await this._cancelPendingVerified({ label: 'entry expiry', cancelReason: 'entry expired', logDone: 'expired entry cancellation verified', code: 'ENTRY_EXPIRED', manageText: 'Expired entry cancellation verified.' });
        }
      } else if (size !== 0) {
        this.log(`  [live] DESYNC: expected 0 or ${n} during PENDING_ENTRY, got ${size}. Halting automated action.`);
        this.notify('DESYNC — action required', `Expected 0 or ${n} contracts during PENDING_ENTRY, got ${size}. Automated action halted — check the account manually.`, { priority: 'urgent', tags: 'rotating_light' });
        this.desynced = true; try { this._manage('DESYNC', 'The bot\'s picture of the position no longer matches the broker, so it stopped managing automatically (see the phone alert). Flatten manually and restart.', {}); } catch (e2) { /* journal only */ }
      }
      return;
    }

    if (this.phase === 'LEG1_OPEN') {
      const afterLeg1 = n - this.leg1Size;
      if (size === n) return; // no change yet
      // 10/18 RULE 2: the whole position is leg 1 (1-lot): size 0 can be the TP1 limit OR the stop. Size alone cannot tell them apart, so ask the broker which order is gone.
      if (afterLeg1 === 0 && size === 0) { await this._closeWholeLeg1(); return; }
      if (size === afterLeg1) {
        this.log(`  [LIVE FILL] leg1 target1 filled (${n} -> ${afterLeg1} contracts, ${this.leg1Size}x closed).`);
        this.notify('Target 1 hit', this.leg2Size > 0 ? `Leg1 closed ${this.leg1Size}x @ ${this.target1.toFixed(2)}. Stop now breakeven, leg2 target=${this.target2.toFixed(2)}.` : `Base hit: ${this.leg1Size}x closed @ ${this.target1.toFixed(2)}. The runner (${afterLeg1}x) now has a break-even stop.`, { tags: 'chart_with_upwards_trend' });
        try { this._manage('TP1_FILLED', `TP1 filled: ${this.leg1Size} contracts closed at ${this.target1.toFixed(2)}. The rest is protected at break-even ${this.entryPrice.toFixed(2)}: ${this.leg2Size > 0 ? `leg 2 (${this.leg2Size}x) keeps a target at TP2 ${this.target2.toFixed(2)}, the runner (${afterLeg1 - this.leg2Size}x) trails behind price.` : `this was the session base hit - the runner (${afterLeg1}x) keeps a break-even stop${this.sessionExit && this.sessionExit.runnerStopAtBE ? '' : ' and trails behind price'}${this.profitTrail && this.profitTrail.enabled ? ' (the profit trail may raise it)' : ''}.`}`, { tp1: this.target1, be: this.entryPrice }); } catch (e2) { /* journal only */ }
        if (this.runnerTrailRule && this.leg2Size === 0 && afterLeg1 > 0) await this._so1Activate(afterLeg1);   // so1 r1.3: no cancel-first, no break-even staging
        else {
        await this.cancelIfSet('stopOrderId');
        // Mac's runner trail split (2026-10-08, bundle spec): leg2 and leg3
        // used to share ONE breakeven stop here, sized afterLeg1. Now each
        // gets its OWN stop from this moment on — leg2's breakeven stop
        // (stopOrderId, unchanged name/size) and leg3's own trailing stop
        // (leg3StopOrderId, new), tracked and ratcheted independently from
        // here. See maybeRatchetTrail and the LEG23_OPEN handler below.
        const leg3SizeAtOpen = afterLeg1 - this.leg2Size;
        // leg2Size 0 (session base-hit plan: everything except the runner(s) left at TP1): there is no leg2, so no leg2 stop/target - only the runner's break-even stop below.
        this.stopOrderId = this.leg2Size > 0 ? await this.placeProtectiveStop(this.leg2Size, this.entryPrice) : null; // leg2's breakeven stop
        this.targetOrderId = this.leg2Size > 0 ? await this.placeTargetLimit(this.leg2Size, this.target2) : null;
        this.trailStop = this.entryPrice;
        this.trailPeakPts = 0;
        this.leg3StopOrderId = leg3SizeAtOpen > 0 ? await this.placeProtectiveStop(leg3SizeAtOpen, this.trailStop) : null;
        this.phase = 'LEG23_OPEN';
        }
      } else if (size === 0) {
        this.lastExit = { kind: 'stop', t: Date.now(), dir: this.dir, entry: this.entryPrice, stop: this.stopPriceIntended, lockStop: this.profitTrail ? this.profitTrailStop : null, target1: this.target1, target2: this.target2, contracts: n };   // 10/18: read by the executor (ban / reclaim)
        this.log(`  [LIVE FILL] full stop-out on all ${n} contracts.`);
        if (!(this.fullStopPushOwner === 'health' && !(this.profitTrail && this.profitTrailStop != null))) this.notify('Stopped out', `Full stop-out on all ${n} contracts @ ${(this.profitTrail && this.profitTrailStop != null ? (this.dir === 1 ? Math.max(this.stopPriceIntended, this.profitTrailStop) : Math.min(this.stopPriceIntended, this.profitTrailStop)) : this.stopPriceIntended).toFixed(2)}${this.profitTrail && this.profitTrailStop != null ? ' (profit lock)' : ''}.`, { priority: 'high', tags: 'chart_with_downwards_trend' });
        try { this._manage('STOP_FILLED', `The stop filled: all ${n} contracts closed at about ${(this.profitTrail && this.profitTrailStop != null ? (this.dir === 1 ? Math.max(this.stopPriceIntended, this.profitTrailStop) : Math.min(this.stopPriceIntended, this.profitTrailStop)) : this.stopPriceIntended).toFixed(2)}${this.profitTrail && this.profitTrailStop != null ? ' (the profit-lock stop)' : ' (the planned stop)'}.`, {}); } catch (e2) { /* journal only */ }
        await this.cancelIfSet('targetOrderId');
        await this.cancelAllOrdersForContract();
        this.reset();
      } else if (size > afterLeg1 && size < n && await this.handlePartialTp1(size)) {
        // FIX1015: TP1 partly filled - the stop now matches the open size and the rest of TP1 keeps resting (see handlePartialTp1)
      } else {
        this.log(`  [live] DESYNC: expected ${n} or ${afterLeg1} during LEG1_OPEN, got ${size}. Halting automated action.`);
        this.notify('DESYNC — action required', `Expected ${n} or ${afterLeg1} contracts during LEG1_OPEN, got ${size}. Automated action halted — check the account manually.`, { priority: 'urgent', tags: 'rotating_light' });
        this.desynced = true; try { this._manage('DESYNC', 'The bot\'s picture of the position no longer matches the broker, so it stopped managing automatically (see the phone alert). Flatten manually and restart.', {}); } catch (e2) { /* journal only */ }
      }
      return;
    }

    if (this.phase === 'LEG23_OPEN') {
      // Mac's runner trail split (2026-10-08, bundle spec): leg2
      // (stopOrderId + targetOrderId) and leg3 (leg3StopOrderId) now carry
      // INDEPENDENT resting orders instead of one shared stop, so a size
      // change can no longer be read off position size alone — it has to
      // say which leg actually closed. "Still open" is read off this
      // machine's own tracked state (whichever id fields are non-null); a
      // leg that already closed on an earlier tick keeps contributing 0
      // here forever, so this naturally covers every ordering (leg2 first,
      // leg3 first, or both in the same poll) without extra phase bookkeeping.
      const leg2OpenBefore = this.stopOrderId != null;
      const leg3OpenBefore = this.leg3StopOrderId != null;
      const leg3Size = this.contracts - this.leg1Size - this.leg2Size;
      const expectedBefore = (leg2OpenBefore ? this.leg2Size : 0) + (leg3OpenBefore ? leg3Size : 0);
      // D1 (profit-trail QA): every leg already left at MARKET by the stop-repair path (both stop ids nulled) and the broker is flat: reset to FLAT and cancel the leftover TP2 limit,
      // otherwise the machine sits in LEG23_OPEN forever and an orphan TP2 sell could open a naked short later.
      if (size === 0 && expectedBefore === 0) { this.log('  [LIVE FILL] every leg already exited at market - cleaning up and resetting.'); await this.cancelAllOrdersForContract(); this.reset(); return; }
      if (size === expectedBefore) return; // nothing new this tick
      if (size === 0 && this._atrRunner() && !leg2OpenBefore && leg3OpenBefore) { await this._atrRunnerClosed(leg3Size); return; }   // edge r1: TP2 limit or the +stopPts stop
      if (size === 0) {
        this.log('  [LIVE FILL] leg2 and leg3 both closed.');
        this.notify('Position closed', 'Leg2 and leg3 both closed.', { tags: 'checkered_flag' });
        try { this._manage('POSITION_CLOSED', 'The position is fully closed (leg 2 and the runner are both out).', {}); } catch (e2) { /* journal only */ }
        await this.cancelAllOrdersForContract();
        this.reset();
        return;
      }
      // Something closed but not everything — ask the broker which specific
      // order(s) are gone instead of guessing from size math alone (the old
      // single-shared-stop design never needed this; two independent orders
      // do). Same "trust the real account over our own tracked state"
      // principle every other transition in this file already follows.
      const openOrders = await getOpenOrders(this.token, this.accountId, this.contractId);
      const leg2StopStillOpen = leg2OpenBefore && openOrders.some(o => o.id === this.stopOrderId);
      const leg2TargetStillOpen = leg2OpenBefore && openOrders.some(o => o.id === this.targetOrderId);
      // leg2 is only "still undecided" while BOTH its orders are still
      // resting — either one filling means leg2 is done (and the other,
      // now-pointless order needs cancelling below).
      const leg2StillOpen = leg2OpenBefore && leg2StopStillOpen && leg2TargetStillOpen;
      const leg3StillOpen = leg3OpenBefore && openOrders.some(o => o.id === this.leg3StopOrderId);
      const expectedAfter = (leg2StillOpen ? this.leg2Size : 0) + (leg3StillOpen ? leg3Size : 0);
      if (size !== expectedAfter) {
        this.log(`  [live] DESYNC: order-survival inference (${expectedAfter}x: leg2 ${leg2StillOpen ? 'open' : 'closed'}, leg3 ${leg3StillOpen ? 'open' : 'closed'}) doesn't match real size (${size}x) during LEG23_OPEN. Halting automated action.`);
        this.notify('DESYNC — action required', `Order-fill inference didn't match real position size (${size}x) during LEG23_OPEN. Automated action halted — check the account manually.`, { priority: 'urgent', tags: 'rotating_light' });
        this.desynced = true; try { this._manage('DESYNC', 'The bot\'s picture of the position no longer matches the broker, so it stopped managing automatically (see the phone alert). Flatten manually and restart.', {}); } catch (e2) { /* journal only */ }
        return;
      }
      if (leg2OpenBefore && !leg2StillOpen) {
        // Exactly one of the two should have filled; both gone in the same
        // poll (a gap move) is the one truly ambiguous case — default the
        // label to the breakeven stop (the more conservative read) when
        // that happens, it changes nothing financially either way.
        const viaTarget = !leg2TargetStillOpen && leg2StopStillOpen;
        this.log(`  [LIVE FILL] leg2 closed via ${viaTarget ? `target2 @ ${this.target2.toFixed(2)}` : 'breakeven stop'} (${this.leg2Size}x). Leg3 (${leg3Size}x) ${leg3StillOpen ? 'still running, untouched' : 'already closed too'}.`);
        this.notify(viaTarget ? 'Target 2 hit' : 'Leg2 stopped at breakeven', viaTarget ? `Leg2 closed ${this.leg2Size}x @ ${this.target2.toFixed(2)}. Leg3 ${leg3StillOpen ? `still running ${leg3Size}x` : 'also closed'}.` : `Leg2 closed ${this.leg2Size}x at breakeven. Leg3 ${leg3StillOpen ? `still running ${leg3Size}x` : 'also closed'}.`, { tags: viaTarget ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend' });
        try { this._manage('TP2_OR_BE', viaTarget ? `Leg 2 (${this.leg2Size}x) closed at its TP2 target ${this.target2.toFixed(2)}.` : `Leg 2 (${this.leg2Size}x) was stopped at break-even ${this.entryPrice.toFixed(2)} (no loss, no gain on that leg).`, { viaTarget }); } catch (e2) { /* journal only */ }
        await this.cancelIfSet('stopOrderId');
        await this.cancelIfSet('targetOrderId');
      }
      if (leg3OpenBefore && !leg3StillOpen) {
        this.log(`  [LIVE FILL] leg3 trailed out @ ${this.trailStop != null ? this.trailStop.toFixed(2) : '?'} (${leg3Size}x). Leg2 ${leg2StillOpen ? 'still running toward TP2, untouched' : 'already closed too'}.`);
        this.notify('Leg3 trailed out', `Leg3 closed ${leg3Size}x @ ${this.trailStop != null ? this.trailStop.toFixed(2) : '?'}. Leg2 ${leg2StillOpen ? 'still running toward TP2' : 'also closed'}.`, { tags: 'chart_with_upwards_trend' });
        try { this._manage('RUNNER_STOPPED', `The runner (${leg3Size}x) was stopped out by its trailing stop at ${this.trailStop != null ? this.trailStop.toFixed(2) : '?'} - profit locked by the trail.`, { stop: this.trailStop }); } catch (e2) { /* journal only */ }
        this.leg3StopOrderId = null;
      }
      if (!leg2StillOpen && !leg3StillOpen) {
        await this.cancelAllOrdersForContract();
        this.reset();
      }
      return;
    }

    if (this.phase === 'LEG3_OPEN') {
      const afterLeg2 = n - this.leg1Size - this.leg2Size;
      if (size === afterLeg2) return;
      if (size === 0) {
        this.log('  [LIVE FILL] leg3 closed (trailing/breakeven stop hit).');
        this.notify('Position closed', `Leg3 closed @ ${this.trailStop != null ? this.trailStop.toFixed(2) : '?'} (trailing/breakeven stop).`, { tags: 'checkered_flag' });
        try { this._manage('POSITION_CLOSED', `The position is fully closed: the last contracts were stopped at ${this.trailStop != null ? this.trailStop.toFixed(2) : '?'} (trailing/break-even stop).`, {}); } catch (e2) { /* journal only */ }
        await this.cancelAllOrdersForContract();
        this.reset();
      } else {
        this.log(`  [live] DESYNC: expected ${afterLeg2} or 0 during LEG3_OPEN, got ${size}. Halting automated action.`);
        this.notify('DESYNC — action required', `Expected ${afterLeg2} or 0 contracts during LEG3_OPEN, got ${size}. Automated action halted — check the account manually.`, { priority: 'urgent', tags: 'rotating_light' });
        this.desynced = true; try { this._manage('DESYNC', 'The bot\'s picture of the position no longer matches the broker, so it stopped managing automatically (see the phone alert). Flatten manually and restart.', {}); } catch (e2) { /* journal only */ }
      }
      return;
    }

    if (this.phase === 'FLATTENING') {
      // ROUND 4 (QA B4) REVERSAL GUARD: the broker shows the OPPOSITE side while we are closing (e.g. the market exit and a backup stop both filled).
      // Never wait silently for size 0: flatten the excess at once (same side + size re-read first) and send an urgent alert; if that fails, halt (DESYNC) + urgent alert.
      if (size && pos && this.dir != null) {
        const posDir = pos.type === 1 ? 1 : pos.type === 2 ? -1 : this.dir;
        if (posDir !== this.dir) { await this.handleReversedWhileClosing(pos); return; }
      }
      if (size === 0) {
        if (this.exitReason === 'session-close' && this.flattenKind === 'manual') {   // r1.1: the manual flatten now runs through sessionFlatten (same texts as before)
          this.log('  [LIVE FILL] manual flatten confirmed — position fully closed.');
          this.notify('Flatten confirmed', 'Position fully closed per your flatten request.', { tags: 'checkered_flag' });
          try { this._manage('FLATTEN_CONFIRMED', 'The manual flatten is confirmed: the position is fully closed.', {}); } catch (e2) { /* journal only */ }
        } else if (this.exitReason === 'session-close' && this.flattenKind === 'no-progress') {   // np1
          this.log('  [no-progress] flat confirmed - sweeping every working order.');
          this.notify('No-progress exit: flat', 'The trade that went nowhere is closed and its orders are cancelled.', { tags: 'hourglass' });
          try { this._manage('NO_PROGRESS_FLAT_CONFIRMED', 'No-progress exit: flat confirmed; every working order on the contract is being cancelled.', {}); } catch (e2) { /* journal only */ }
        } else if (this.exitReason === 'session-close' && this.flattenKind === 'level-loss') {   // exits5m r1
          this.log('  [level-loss] flat confirmed - sweeping every working order.');
          this.notify('Level-loss exit: flat', 'The trade whose level was lost is closed and its orders are cancelled.', { tags: 'door' });
          try { this._manage('LEVEL_LOSS_FLAT_CONFIRMED', 'Level-loss exit: flat confirmed; every working order on the contract is being cancelled.', {}); } catch (e2) { /* journal only */ }
        } else if (this.exitReason === 'session-close' && this.flattenKind === 'early-adverse') {   // edge r1
          this.log('  [eae] flat confirmed - sweeping every working order.');
          this.notify('Early exit: flat', 'The trade that never worked is closed and its orders are cancelled.', { tags: 'door' });
          try { this._manage('EARLY_ADVERSE_FLAT_CONFIRMED', 'Early exit: flat confirmed; every working order on the contract is being cancelled.', {}); } catch (e2) { /* journal only */ }
        } else if (this.exitReason === 'session-close') {
          this.log('  [session] SESSION CLOSE: flat confirmed - sweeping every working order.');
          this.notify('Session close: flat', 'The position is closed and every working order is cancelled (Topstep: flat by 13:10 PT).', { tags: 'checkered_flag' });
          try { this._manage('SESSION_FLAT_CONFIRMED', 'Session close: flat confirmed; every working order on the contract is being cancelled.', {}); } catch (e2) { /* journal only */ }
        } else if (this.exitReason === 'through-stop') {
          this.log('  [LIVE FILL] exit after the fill through the planned stop confirmed - position fully closed.');
          this.notify('Exit confirmed', 'The entry that filled through its planned stop is fully closed.', { tags: 'checkered_flag' });
          try { this._manage('FLATTEN_CONFIRMED', 'The market exit after the fill through the planned stop is confirmed: the position is fully closed.', {}); } catch (e2) { /* journal only */ }
        } else {
        this.log('  [LIVE FILL] manual flatten confirmed — position fully closed.');
        this.notify('Flatten confirmed', 'Position fully closed per your flatten request.', { tags: 'checkered_flag' });
        try { this._manage('FLATTEN_CONFIRMED', 'The manual flatten is confirmed: the position is fully closed.', {}); } catch (e2) { /* journal only */ }
        }
        await this.cancelAllOrdersForContract();
        this.reset();
      }
      // else: MARKET order hasn't shown as filled yet — check again next tick.
      // bf-exitsafe: an ACCEPTED exit that still shows the same position long after: one urgent alert, never a second order from here
      else if (this.exitInFlight && Number.isFinite(this.exitInFlight.at) && Date.now() - this.exitInFlight.at > safeExit.FLATTEN_STUCK_MS && !this._exitStuckAlerted) {
        this._exitStuckAlerted = true;
        this.log(`  [exit-safety] the ${this._exitTitle().toLowerCase()} market exit was sent ${Math.round((Date.now() - this.exitInFlight.at) / 1000)} s ago and the broker still shows ${size}x - no second order is sent; urgent alert.`);
        this.notify(`${this._exitTitle()}: still NOT FLAT - check TopstepX`, `The market exit was sent over ${safeExit.FLATTEN_STUCK_MS / 1000} s ago and the broker still shows ${size}x with no stop. The bot will not send a second exit. Use Flatten / Close position in TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
        try { this._manage('EXIT_NOT_CONFIRMED', `${this._exitTitle()}: the market exit was sent and the broker still shows ${size}x after ${safeExit.FLATTEN_STUCK_MS / 1000} s; urgent alert, no second order.`, { size }); } catch (e2) { /* journal only */ }
      }
    }
  }

  // ROUND 4 (QA B4): the position REVERSED while the bot was closing it. The excess is ours (our exit + a resting stop both filled), so it is closed at market
  // at once: the position is re-read right before the order and must be the same side and size; then confirmed flat. Any doubt or failure = DESYNC + urgent alert.
  async handleReversedWhileClosing(pos) {
    const excess = pos.size, side = pos.type === 1 ? 'LONG' : 'SHORT';
    this.log(`  [live] CRITICAL: the position REVERSED while closing - the broker shows ${side} ${excess}x. Closing the excess at market now.`);
    this.notify('POSITION REVERSED while closing - closing the excess now', `Broker shows ${side} ${excess}x while the bot was closing a ${this.dir === 1 ? 'LONG' : 'SHORT'}. The bot is closing the ${excess}x at market now; check TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
    let ok = false;
    try {
      const p1 = await getOpenPosition(this.token, this.accountId, this.contractId);
      if (p1 && p1.size === excess && p1.type === pos.type) {
        await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.MARKET, side: pos.type === 1 ? OrderSide.SELL : OrderSide.BUY, size: excess });
        for (let i = 0; i < 12 && !ok; i++) {
          try { const p2 = await getOpenPosition(this.token, this.accountId, this.contractId); ok = !p2 || !p2.size; } catch (e) { /* retry */ }
          if (!ok) await new Promise(res => setTimeout(res, 250));
        }
      } else this.log('  [live] the reversed position changed (or could not be re-read) just before the correction order - NOT sending it; halting.');
    } catch (e) { this.log(`  [live] closing the reversed excess FAILED: ${e.message}`); ok = false; }
    if (ok) {
      await this.cancelAllOrdersForContract();
      this.notify('REVERSED position closed', `The ${excess}x excess was closed at market. The account should be flat - check TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
      try { this._manage('REVERSAL_CORRECTION', `While closing, the position reversed to ${side} ${excess}x (the market exit and a resting stop both filled). The bot closed exactly the ${excess}x excess at market and is flat again.`, { excess }); } catch (e2) { /* journal only */ }
      this.reset();
      return 'closed';
    }
    this.desynced = true;
    this.notify('POSITION REVERSED - FLATTEN IN TOPSTEPX NOW', `Broker shows ${side} ${excess}x while closing. The bot sent a closing order that did not confirm in 3 s and has HALTED - in TopstepX use Flatten / Close position (NOT a new opposite order), then restart.`, { priority: 'urgent', tags: 'rotating_light' });
    try { this._manage('DESYNC', 'The position reversed while the bot was closing it and the correction did not confirm; the bot stopped. Flatten manually.', { excess }); } catch (e2) { /* journal only */ }
    return 'halted';
  }

  // FIX1015 (partial TP1): the position shrank from n to `size` with afterLeg1 < size < n. The full-size stop must never stay larger than the position (a stop for
  // 5 on a 4-lot reverses 1 contract when it fills), so the stop is ALWAYS resized to the open size first (new stop first, then a verified cancel of the old one).
  // When the TP1 limit is still resting this is a partial TP1 fill: contracts/leg1Size shrink by what filled and management continues (the rest of TP1 stays
  // resting; when it fills the normal TP1 transition runs). Returns true = handled (keep managing), false = not a clean partial TP1 (the caller halts as before).
  async handlePartialTp1(size) {
    const n = this.contracts, filled = n - size;
    let open;
    try { open = await getOpenOrders(this.token, this.accountId, this.contractId); }
    catch (e) { this.log(`  [live] partial TP1 check: open orders unreadable (${e.message}) - changing nothing, retrying next poll.`); return true; }
    const tp1Open = this.targetOrderId != null && open.some(o => String(o.id) === String(this.targetOrderId));
    const stopO = open.find(o => String(o.id) === String(this.stopOrderId));
    const intended = roundToTick(this.profitTrail && this.profitTrailStop != null ? (this.dir === 1 ? Math.max(this.stopPriceIntended, this.profitTrailStop) : Math.min(this.stopPriceIntended, this.profitTrailStop)) : this.stopPriceIntended, this.tickSize);
    const lvl = stopO && (stopO.stopPrice ?? stopO.price) != null ? (stopO.stopPrice ?? stopO.price) : intended;
    let resized = stopO && stopO.size === size;
    let exited = false;
    if (!resized) {
      const r = await this.replaceStopSafely('stopOrderId', size, lvl, lvl, stopO ? lvl : null, `stop resized to ${size}x after a partial TP1`);
      resized = !!r.ok; exited = !!r.exited;
      if (!resized && !exited) {
        this.log(`  [live] partial TP1: could not resize the stop to ${size}x yet - the ${n}x stop still rests; retrying next poll.`);
        if (!this.partialNotifiedAt || Date.now() - this.partialNotifiedAt > 2 * 60000) { this.partialNotifiedAt = Date.now(); this.notify('Stop is larger than the position - retrying', `TP1 partly filled (${n} -> ${size}x) but the stop could not be resized yet. If this stays, set the stop to ${size} contracts in TopstepX.`, { priority: 'urgent', tags: 'rotating_light' }); }
        return tp1Open;   // not a clean partial -> halt as before; a clean one retries the resize on the next poll
      }
    }
    if (!tp1Open) { this.log(`  [live] position ${n} -> ${size}x but the TP1 order is no longer resting: not a partial TP1. The stop was resized to the open size first.`); return false; }
    this.contracts = size; this.leg1Size = this.leg1Size - filled;
    this.log(`  [LIVE FILL] partial TP1: ${filled}x of TP1 filled (${n} -> ${size} contracts); the stop is now ${size}x${exited ? ' (exited at market)' : ` @ ${Number(lvl).toFixed(2)}`}, ${this.leg1Size}x of TP1 still resting. Managing on.`);
    this.notify('TP1 partly filled', `${filled}x of TP1 filled @ ${this.target1.toFixed(2)}. Stop resized to ${size}x; ${this.leg1Size}x of TP1 still resting.`, { tags: 'chart_with_upwards_trend' });
    try { this._manage('TP1_PARTIAL', `TP1 partly filled: ${filled} contract(s) closed at ${this.target1.toFixed(2)}. The stop was resized to the ${size} contracts still open and the remaining ${this.leg1Size} of TP1 keeps resting.`, { filled, open: size }); } catch (e2) { /* journal only */ }
    return true;
  }

  // Smart-stop-hold, live-safe adaptation of the backtested mechanic. The
  // REAL protective stop is already resting at the WIDE grace-ceiling price
  // (this.stopPriceIntended) — that never changes here, it's the always-on
  // safety net a crashed process can still rely on. This only ever ACCELERATES
  // an exit: once price crosses the tighter reference level, check Levels
  // PRO's own real-time classification. If it confirms a genuine break of
  // structure (ACCEPT/RECLAIM in the adverse direction — sellers/buyers have
  // truly taken control), exit early via a market order instead of riding it
  // all the way to the wide stop. If the classification is ambiguous or looks
  // like a sweep, do nothing — the wide resting stop keeps protecting as-is.
  // Checked once per trade (smartHoldChecked), matching "one grace" in the
  // backtest.
  async maybeSmartHoldExit(latestClose, levelsRow) {
    if (this.phase !== 'LEG1_OPEN' || this.desynced || !this.tightStopPrice || this.smartHoldChecked) return;
    const crossed = this.dir === 1 ? latestClose <= this.tightStopPrice : latestClose >= this.tightStopPrice;
    if (!crossed) return;
    this.smartHoldChecked = true;
    const structural = (levelsRow?.levels || []).some(l => {
      const b = l.behavior || '';
      return this.dir === 1 ? (b === 'ACCEPT-' || b === 'LOST') : (b === 'ACCEPT+' || b === 'RECLAIM');
    });
    if (!structural) {
      this.log(`  [live] smart-stop-hold: price crossed the tight reference (${this.tightStopPrice.toFixed(2)}) but no confirmed break of structure — holding, wide stop stays resting.`);
      return;
    }
    this.log(`  [live] smart-stop-hold: confirmed break of structure @ ${latestClose.toFixed(2)} — exiting all ${this.contracts} contracts early instead of waiting for the wide stop.`);
    await this.cancelIfSet('stopOrderId');
    await this.cancelIfSet('targetOrderId');
    const exitSide = this.sideFor(this.dir, true);
    const exitType = this.marketableLimitBufferPoints > 0 ? OrderType.LIMIT : OrderType.MARKET;
    const exitBody = { accountId: this.accountId, contractId: this.contractId, type: exitType, side: exitSide, size: this.contracts };
    if (exitType === OrderType.LIMIT) exitBody.limitPrice = aggressiveLimitPrice(exitSide, latestClose, this.marketableLimitBufferPoints, this.tickSize);
    jr.requestClose(this, 'smart_hold_exit', 'AUTOMATIC', 'maybeSmartHoldExit submission');
    await placeOrder(this.token, exitBody);
    this.notify('Smart-hold early exit', `Confirmed break of structure @ ${latestClose.toFixed(2)} — exited all ${this.contracts} contracts early rather than wait for the wide stop.`, { priority: 'high', tags: 'chart_with_downwards_trend' });
    try { this._manage('SMART_HOLD_EXIT', `Smart-stop-hold: price crossed the tight stop reference and Levels PRO confirmed a break of structure, so all ${this.contracts} contracts were closed at market (~${latestClose.toFixed(2)}) instead of waiting for the wide stop.`, {}); } catch (e2) { /* journal only */ }
    await this.cancelAllOrdersForContract();
    this.reset();
  }

  // Ratchets leg3's resting stop to a better level by canceling and
  // replacing it. Runs in TWO phases now (2026-10-08, bundle spec): LEG23_OPEN
  // (leg3 trails on its OWN order, leg2Size+targetOrderId untouched, via
  // leg3StopOrderId) and the plain LEG3_OPEN case inherited from either the
  // old leg2-already-closed transition or startup recovery (via
  // stopOrderId, unchanged name). Which field to ratchet is picked once via
  // orderIdField so the rest of the logic is identical either way.
  // ── HOTFIX 4 (2026-10-13): a trail ratchet must NEVER weaken protection ──
  // Live evidence (10/12 ~18:10 PT): long 5x @30714.50, TP1 filled, runner at +53 pts; the ratchet cancelled leg3's break-even stop FIRST, set trailStop to the
  // new level, then the exchange rejected the new stop ("order price is outside allowed range"); the old "retry wider from ENTRY" fallback then collapsed a +50 pt
  // lock to a stop at/below break-even, and trailStop already held the rejected level so nothing retried. These helpers are used by the trail ratchet only:
  //  - the NEW stop is placed first, with NO widen-from-entry fallback; the old stop is cancelled only after the new one is accepted;
  //  - rejected while the market is already through the new level (long: price <= new stop) -> exit those contracts at MARKET (what the stop would have done);
  //  - rejected while the market is still above it -> the best VALID level (a few ticks inside the market, never worse than the previous stop);
  //  - nothing placeable -> the OLD stop stays resting, trailStop is NOT updated, and the ratchet is retried after a short back-off;
  //  - trailStop only ever changes to a level that is actually resting at the exchange.
  async trailRefPrice(fallback) {
    try {
      const d = await ptxFetch('/api/History/retrieveBars', { contractId: this.contractId, live: false, startTime: new Date(Date.now() - 10 * 60000).toISOString(), endTime: new Date().toISOString(), unit: 2, unitNumber: 1, limit: 5, includePartialBar: true }, this.token);
      const bars = (d && d.bars) || [];
      if (bars.length) { bars.sort((a, b) => new Date(a.t) - new Date(b.t)); const c = bars[bars.length - 1].c; if (Number.isFinite(c)) return c; }
    } catch (e) { /* fall back to the price the caller already had */ }
    return fallback;
  }

  async cancelVerified(orderId, label, sizeHint = null, priceHint = null) {
    if (!orderId) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      let ok = false;
      try { ok = await cancelOrder(this.token, this.accountId, orderId); } catch (e) { ok = false; }
      if (ok) return true;
      // cancel reported failure: either the order already filled/vanished (fine) or it is still resting (not fine - two stops would double-sell)
      let open = [];
      try { open = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { return false; }
      if (!open.some(o => o.id === orderId)) return true;
    }
    this.staleStops.set(String(orderId), { size: sizeHint ?? null, price: priceHint ?? null, label, since: Date.now(), tries: 0 });
    this.log(`  [live] CRITICAL: could not cancel the old ${label} (order ${orderId}) after the new one was placed - two stops may be resting. It is remembered and re-cancelled every poll until the broker confirms it is gone.`);
    this.notify('Old stop could not be cancelled - check the account', /^session-close/.test(label) ? `The ${label} (order ${orderId}) would not cancel during the session-close flatten, so the market exit is held back (the position stays protected). If it is still resting near 13:09 PT, flatten in TopstepX.` : /^(morning-hold|no-progress|level-loss|early-adverse) /.test(label) ? `The ${label} (order ${orderId}) would not cancel during the ${label.split(' ')[0]} exit, so the market exit is held back (the position stays protected). If it keeps failing, flatten in TopstepX.` : label === 'backup stop' ? `The backup stop order ${orderId} (placed while the exit after a fill through the stop was retrying) would not cancel, so it may still be resting.` : `The trail moved the runner's stop but the old stop order ${orderId} would not cancel, so two stops may be resting. The bot keeps retrying; if this alert is still active in a minute, open TopstepX and cancel the OLDER stop by hand.`, { priority: 'urgent', tags: 'rotating_light' });
    try { this._manage('STALE_STOP', `The old stop (order ${orderId}) would not cancel after the new one was placed. The bot remembers it and retries every poll until the broker confirms it is gone.`, { orderId }); } catch (e2) { /* journal only */ }
    return false;
  }

  // ── HOTFIX 4b ──
  // (1) Stale stops: an old stop of ours whose cancel failed (two stops would then rest for the same contracts and, if the market crashed through both, REVERSE the
  //     position). Every poll, until the broker's working-order list no longer contains it, the cancel is retried. Runs also while FLAT.
  async sweepStaleStops() {
    if (!this.staleStops.size) return 'none';
    let open;
    try { open = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { return 'unreadable'; }
    const ids = new Set(open.map(o => String(o.id)));
    for (const [id, info] of Array.from(this.staleStops)) {
      if (!ids.has(id)) { this.staleStops.delete(id); this.log(`  [risk] stale ${info.label} (order ${id}) is gone from the broker - confirmed.`); continue; }
      let ok = false;
      try { ok = await cancelOrder(this.token, this.accountId, id); } catch (e) { ok = false; }
      info.tries++;
      this.log(`  [risk] retry-cancel of stale ${info.label} (order ${id}), attempt ${info.tries}: ${ok ? 'cancel accepted (confirmed next poll)' : 'cancel FAILED'}`);
      if (!ok && (info.tries === 5 || info.tries % 30 === 0)) this.notify('Old stop still resting - cancel it in TopstepX', `Order ${id} (${info.label}${info.price != null ? ' @ ' + Number(info.price).toFixed(2) : ''}) could not be cancelled after ${info.tries} tries. Open TopstepX and cancel the OLDER stop now.`, { priority: 'urgent', tags: 'rotating_light' });
    }
    return this.staleStops.size ? 'pending' : 'cleared';
  }

  // (2) Reversed position: the broker shows the OPPOSITE side of what this machine holds. Provable as our own doing only when a stale stop of ours is gone from the
  //     broker and its size covers the excess (both of our stops filled): then only the excess is bought/sold back at market and an urgent alert is sent. Otherwise
  //     halt (DESYNC) with an urgent "flatten it" alert. Never leaves the reversed position silently.
  async handleReversedPosition(pos) {
    const excess = pos.size;
    const reduceSide = this.sideFor(this.dir, false); // the side that ADDS to our direction = reduces the opposite (reversed) position
    let open = null;
    try { open = await getOpenOrders(this.token, this.accountId, this.contractId); } catch (e) { open = null; }
    let goneStale = 0;
    if (open) { const ids = new Set(open.map(o => String(o.id))); for (const [id, info] of this.staleStops) if (!ids.has(id)) goneStale += info.size || 0; }
    // Proof 2 (stop-vs-target double fill): every order of OURS that the broker no longer lists is counted at its full size; if the expected open size minus all of them equals
    // exactly minus the reversed size, the reversed position is the arithmetic result of our own orders having filled (e.g. TP1 limit + the full-size stop, in either order) and nothing else.
    let goneSum = 0, goneList = [], expectedOpen = 0;
    if (open) {
      const ids = new Set(open.map(o => String(o.id)));
      const leg3Size = this.contracts - this.leg1Size - this.leg2Size;
      const mine = [];
      if (this.phase === 'LEG1_OPEN') { expectedOpen = this.contracts; mine.push([this.stopOrderId, this.contracts, 'stop'], [this.targetOrderId, this.leg1Size, 'TP1']); }
      else if (this.phase === 'LEG23_OPEN') { expectedOpen = (this.stopOrderId != null ? this.leg2Size : 0) + (this.leg3StopOrderId != null ? leg3Size : 0); mine.push([this.stopOrderId, this.leg2Size, 'leg2 stop'], [this.targetOrderId, this.leg2Size, 'TP2'], [this.leg3StopOrderId, leg3Size, 'runner stop']); }
      else { expectedOpen = leg3Size; mine.push([this.stopOrderId, leg3Size, 'runner stop']); }
      for (const [id, sz, lab] of mine) if (id != null && !ids.has(String(id))) { goneSum += sz; goneList.push(`${lab} ${sz}x`); }
      for (const [id, info] of this.staleStops) if (!ids.has(id)) { goneSum += info.size || 0; goneList.push(`stale stop ${info.size || 0}x`); }
    }
    const arith = open != null && excess > 0 && goneSum > 0 && expectedOpen - goneSum === -excess;
    const provable = open != null && excess > 0 && (goneStale >= excess || arith);
    this.log(`  [risk] REVERSED position: expected ${this.dir === 1 ? 'LONG' : 'SHORT'} ${expectedOpen}x, broker shows ${pos.type === 1 ? 'LONG' : 'SHORT'} ${excess}x. Our orders gone from the broker: ${goneList.join(' + ') || 'none'} (= ${goneSum}x; ${expectedOpen} - ${goneSum} = ${expectedOpen - goneSum}) -> ${provable ? (arith ? 'EXACTLY the position those orders leave: provably ours, closing the excess at market' : 'stale stop explains it: closing the excess at market') : 'cannot prove it, halting'}.`);
    // D8 (profittrail3): the excess was read a moment ago (position, then orders). Re-read the position right before the market order and require the SAME side and size; if it
    // changed (the owner flattened or traded by hand in the gap) or cannot be read, send nothing and halt.
    let recheckOk = false;
    if (provable) {
      try { const p3 = await getOpenPosition(this.token, this.accountId, this.contractId); recheckOk = !!p3 && p3.size === excess && p3.type === pos.type; }
      catch (e) { recheckOk = false; }
      if (!recheckOk) this.log(`  [risk] REVERSED position changed (or could not be re-read) just before the correction order - NOT sending it; halting.`);
    }
    if (provable && recheckOk) {
      try {
        await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.MARKET, side: reduceSide, size: excess });
        let flat = false;
        for (let i = 0; i < 12 && !flat; i++) {
          try { const p2 = await getOpenPosition(this.token, this.accountId, this.contractId); flat = !p2 || !p2.size; } catch (e) { /* retry */ }
          if (!flat) await new Promise(res => setTimeout(res, 250));
        }
        if (flat) {
          await this.cancelAllOrdersForContract();
          this.staleStops.clear();
          this.notify('REVERSED position closed', `Both stops filled and the position reversed by ${excess}x; the excess was closed at market. The account should be flat - check TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
          try { this._manage('REVERSAL_CORRECTION', `Both of the bot's own orders for the same contracts filled (stop and target), reversing the position by ${excess}x. The bot bought/sold back exactly the excess at market and is flat again.`, { excess }); } catch (e2) { /* journal only */ }
          this.reset();
          return 'closed';
        }
      } catch (e) { this.log(`  [risk] closing the reversed excess FAILED: ${e.message}`); }
    }
    this.desynced = true; try { this._manage('DESYNC', 'The bot\'s picture of the position no longer matches the broker, so it stopped managing automatically (see the phone alert). Flatten manually and restart.', {}); } catch (e2) { /* journal only */ }
    this.notify('POSITION REVERSED - FLATTEN IN TOPSTEPX NOW', `The broker shows ${pos.type === 1 ? 'LONG' : 'SHORT'} ${excess}x but the bot holds ${this.dir === 1 ? 'LONG' : 'SHORT'}. The bot has HALTED. Flatten the account in TopstepX and restart the bot.`, { priority: 'urgent', tags: 'rotating_light' });
    try { this._manage('REVERSAL_HALT', `The broker shows the opposite side (${excess}x) and the bot could not prove its own orders caused it, so it halted. Flatten in TopstepX.`, { excess }); } catch (e2) { /* journal only */ }
    return 'halted';
  }

  // Core of hotfix 4. Replaces the stop held in this[orderIdField] by `newStop` (size `size`) WITHOUT ever weakening protection:
  // `curStop` is the price of the stop that is resting now (null if there is none); a replacement must be strictly better than it.
  // Returns { ok:true, lvl, id } (new stop resting, old cancelled), { exited:true } (market exit confirmed) or { ok:false } (nothing changed).
  async replaceStopSafely(orderIdField, size, newStop, refPrice, curStop, label) {
    if (this._so1HaltWhy) { this.log(`  [live] so1 HALT active - ${label} ${size}x @ ${newStop} not sent.`); return { ok: false, halted: true }; }   // so1 r1.7: central gate
    const long = this.dir === 1, tick = this.tickSize;
    const oldId = this[orderIdField];
    const better = lvl => curStop == null ? true : (long ? lvl > curStop : lvl < curStop);
    const place = async lvl => {
      try {
        const d = await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.STOP, side: this.sideFor(this.dir, true), size, stopPrice: lvl });
        return { ok: true, id: d.orderId || d.id || null, lvl };
      } catch (e) { return { ok: false, err: e }; }
    };
    let r = await place(newStop);
    if (!r.ok) {
      try { this._manage('ORDER_REJECTED', `The exchange rejected the new ${label} at ${newStop.toFixed(2)} (${r.err.message}). The existing stop keeps protecting while the bot decides: sell at market if the market is already through that level, otherwise try the closest valid level.`, { level: newStop }); } catch (e2) { /* journal only */ }
      this.log(`  [live] ${label} @ ${newStop.toFixed(2)} rejected (${r.err.message}); the existing stop${curStop != null ? ` @ ${curStop.toFixed(2)}` : ''} stays resting.`);
      const px = await this.trailRefPrice(refPrice);
      const through = long ? px <= newStop + tick : px >= newStop - tick;
      if (through) {
        // the market is already through the level: the stop would have fired - exit those contracts at market now
        this.log(`  [live] market ${px.toFixed(2)} is already through ${newStop.toFixed(2)} - exiting ${size}x at MARKET (what the stop would have done).`);
        let size0 = null;
        try { const pos = await getOpenPosition(this.token, this.accountId, this.contractId); size0 = pos ? pos.size : 0; } catch (e) { /* unknown */ }
        try {
          await placeOrder(this.token, { accountId: this.accountId, contractId: this.contractId, type: OrderType.MARKET, side: this.sideFor(this.dir, true), size });
        } catch (e) {
          this.log(`  [live] market exit FAILED (${e.message}); the existing stop stays resting.`);
          this.notify('Stop exit failed - old stop still resting', `Could not exit ${size}x at market (${e.message}). The previous stop is still resting.`, { priority: 'high', tags: 'warning' });
          try { this._manage('ORDER_REJECTED', `The market exit for ${size} contracts failed (${e.message}); the previous stop stays resting.`, {}); } catch (e2) { /* journal only */ }
          this.failStreak = (this.failStreak || 0) + 1; this.trailRetryAt = Date.now() + [5000, 15000, 60000, 180000, 300000][Math.min(this.failStreak, 5) - 1];
          if (this.runnerTrailRule) this._so1Halt(`a market exit was sent for the ${label} but its outcome is unknown`, oldId, curStop);   // so1 r1.6: latched here, for every caller
          return { ok: false, exitUnknown: true };   // so1 r1.4: a failed/unacknowledged market order may still have filled
        }
        let confirmed = false;
        for (let i = 0; i < 12 && !confirmed; i++) {
          try { const pos = await getOpenPosition(this.token, this.accountId, this.contractId); const now = pos ? pos.size : 0; confirmed = size0 != null ? now <= size0 - size : now === 0; } catch (e) { /* retry */ }
          if (!confirmed) await new Promise(res => setTimeout(res, 250));
        }
        if (confirmed) {
          await this.cancelVerified(oldId, label, size, curStop);
          this[orderIdField] = null;
          this.log('  [live] exited at market after a rejected stop.');
          this.notify('Exited at market', `The ${label} wanted @ ${newStop.toFixed(2)} but the market (${px.toFixed(2)}) was already through it - closed ${size}x at market.`, { priority: 'high', tags: 'chart_with_upwards_trend' });
          try { this._manage('MARKET_EXIT', `The ${label} wanted at ${newStop.toFixed(2)} was rejected because the market (${px.toFixed(2)}) was already through it, so ${size} contracts were sold at market - what the stop would have done.`, { level: newStop, market: px }); } catch (e2) { /* journal only */ }
          return { exited: true };
        }
        this.log('  [live] market exit not confirmed yet - leaving the old stop resting; the next poll reconciles the position size.');
        this._notifyThrottled('Exit unconfirmed', 'Exit unconfirmed', 'A market exit was sent but the position size has not changed yet. The old stop is still resting. Check the account.', { priority: 'high', tags: 'warning' });   // 18f1 F5: max 1 push / position / 60 s
        if (this.runnerTrailRule) this._so1Halt(`a market exit was sent for the ${label} but its outcome is unknown`, oldId, curStop);   // so1 r1.6: latched here, for every caller
        return { ok: false, exitUnknown: true };   // so1 r1.4: sent, not confirmed
      }
      // still on the safe side of the level: the best VALID stop a few ticks inside the market, never worse than what rests now
      for (const k of [2, 4, 8, 16]) {
        const cand = roundToTick(long ? Math.min(newStop, px - k * tick) : Math.max(newStop, px + k * tick), tick);
        if (!better(cand)) break;
        r = await place(cand);
        if (r.ok) { this.log(`  [live] ${label} placed at the best VALID level ${cand.toFixed(2)} (wanted ${newStop.toFixed(2)}, market ${px.toFixed(2)}).`); try { this._manage('STOP_VALID_LEVEL', `The ${label} was placed at ${cand.toFixed(2)}, the closest valid level inside the market (${px.toFixed(2)}); it wanted ${newStop.toFixed(2)}.`, { wanted: newStop, placed: cand }); } catch (e2) { /* journal only */ } break; }
      }
    }
    if (!r.ok) {
      if (curStop == null) {
        // C5: nothing is protecting these contracts - never back off: retry on every poll and alert (rate-limited to 2 min)
        this.trailRetryAt = 0;
        this.log(`  [live] ${label} to ${newStop.toFixed(2)} could not be placed and NO stop rests for these contracts - retrying on every poll.`);
        if (!this.noStopNotifiedAt || Date.now() - this.noStopNotifiedAt > 2 * 60000) {
          this.noStopNotifiedAt = Date.now();
          try { this._manage('NO_STOP', `${size} contracts have NO stop resting (the ${label} at ${newStop.toFixed(2)} could not be placed); the bot retries on every poll and has sent an urgent alert.`, { level: newStop }); } catch (e2) { /* journal only */ }
          this.notify('NO STOP on part of the position - retrying', `The ${label} @ ${newStop.toFixed(2)} (${size}x) could not be placed and no stop is resting for those contracts. The bot retries every poll. If this continues, flatten in TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
        }
        return { ok: false };
      }
      this.failStreak = (this.failStreak || 0) + 1; this.trailRetryAt = Date.now() + [5000, 15000, 60000, 180000, 300000][Math.min(this.failStreak, 5) - 1];
      this.log(`  [live] ${label} to ${newStop.toFixed(2)} could not be placed - the existing stop stays resting (retry with back-off).`);
      if (!this.trailFailNotifiedAt || Date.now() - this.trailFailNotifiedAt > 5 * 60000) {
        this.trailFailNotifiedAt = Date.now();
        this.notify('Stop update rejected - previous stop kept', `The exchange rejected the ${label} @ ${newStop.toFixed(2)}. The previous stop${curStop != null ? ` @ ${curStop.toFixed(2)}` : ''} is still resting; retrying.`, { priority: 'high', tags: 'warning' });
      }
      return { ok: false };
    }
    // accepted: only now remove the old stop
    this[orderIdField] = r.id;
    await this.cancelVerified(oldId, `previous ${label}`, size, curStop);
    this.failStreak = 0;
    return { ok: true, lvl: r.lvl, id: r.id };
  }

  // so1 r1.3 (MacDot 6356559270 #1/#2): the runner's stop right after the scale-out filled. The old n-contract stop is NOT cancelled first: it is replaced by a
  // runner-sized stop at +lockPts through replaceStopSafely (new stop first, verified cancel of the old one, market exit when the market is already through).
  // trailStop only takes a level the broker accepted. r1.5: an unknown exit outcome halts; a plain refusal resizes the old stop to the runner (see below).
  async _so1Activate(leg3) {
    const oldId = this.stopOrderId, oldLvl = Number.isFinite(this.stopPriceIntended) ? roundToTick(this.stopPriceIntended, this.tickSize) : null;
    this.leg3StopOrderId = oldId; this.stopOrderId = null; this.targetOrderId = null;
    this.trailStop = oldLvl; this.trailPeakPts = Math.abs(this.target1 - this.entryPrice); this.runnerArmed = true; this.phase = 'LEG23_OPEN';
    const atr = this._atrRunner();   // edge r1: the session runner rule's ATR-target runner (stop at entry + stopPts, TP2 limit, no trail)
    const want = atr ? this._atrStopLevel() : roundTrailStopConservative(this.entryPrice + this.dir * runnerTrailOffset(this.trailPeakPts, this.runnerTrailRule), this.dir, this.tickSize);
    const r = await this.replaceStopSafely('leg3StopOrderId', leg3, want, this.target1, oldLvl, 'runner stop after the scale-out');
    if (r.ok && atr) { this.trailStop = r.lvl; this.log(`  [runner] scale-out done - the ${leg3}x runner's stop now rests at ${r.lvl.toFixed(2)} (entry ${this.dir === 1 ? '+' : '-'}${this.runnerPlan.stopPts}); the ${this.contracts}x stop was replaced, not cancelled first.`); await this._atrPlaceTp2(leg3, { fresh: true }); return; }
    if (r.ok) { this.trailStop = r.lvl; this.log(`  [live] so1: scale-out done - the ${leg3}x runner's stop now rests at ${r.lvl.toFixed(2)} (+${this.runnerTrailRule.lockPts}); the ${this.contracts}x stop was replaced, not cancelled first.`); return; }
    if (r.exited) { this.trailStop = null; return; }   // the market was through +lock: the runner was closed at market; the next tick sees the flat position
    // so1 r1.5 (MacDot 6356835501):
    //  - exit outcome UNKNOWN (a market exit sent but unconfirmed, or a market call that threw): nothing proves that order is dead, so the machine HALTS (desynced -
    //    tick, ratchet, audit, lock and smart-hold all stand down) with an urgent alert for manual resolution. No further order is sent by any path.
    //  - plain refusal (no market order was sent): the old n-contract stop is resized to the runner's quantity AT ITS OWN LEVEL (a level already resting, on the
    //    safe side) through the same safe replace - new 1x first, verified cancel - so no oversized stop is left. If even that is not accepted: HALT.
    if (r.exitUnknown) return this._so1Halt(`a market exit for the runner was sent but its outcome is unknown`, oldId, oldLvl);
    const rz = await this.replaceStopSafely('leg3StopOrderId', leg3, oldLvl, this.target1, null, 'runner stop (resized to the runner)');
    if (rz.ok && atr) { this.trailStop = rz.lvl; this.log(`  [runner] the stop at entry ${this.dir === 1 ? '+' : '-'}${this.runnerPlan.stopPts} was refused - the stop was resized to the ${leg3}x runner at ${rz.lvl.toFixed(2)}; it is moved to ${want.toFixed(2)} after the back-off.`); await this._atrPlaceTp2(leg3, { fresh: true }); return; }
    if (rz.ok) { this.trailStop = rz.lvl; this.log(`  [live] so1: +${this.runnerTrailRule.lockPts} refused - the stop was resized to the ${leg3}x runner at ${rz.lvl.toFixed(2)}; the ratchet retries +${this.runnerTrailRule.lockPts} after the back-off.`); return; }
    if (rz.exited) { this.trailStop = null; return; }
    return this._so1Halt(rz.exitUnknown ? 'a market exit for the runner was sent but its outcome is unknown' : `neither the +${this.runnerTrailRule.lockPts} stop nor a ${leg3}x stop at ${oldLvl != null ? oldLvl.toFixed(2) : '?'} was accepted`, this.leg3StopOrderId ?? oldId, oldLvl);
  }
  _so1Halt(why, orderId, lvl) {
    if (this.desynced && this._so1HaltWhy) return;   // r1.6: one halt, one alert
    this.desynced = true; this._so1HaltWhy = why;
    if (this.saveState() === true && this.stateFile) this._haltLatched = true;   // r1.7: pin only after a successful write; otherwise every later save retries
    else if (this.stateFile) this.log('  [state] so1 halt could NOT be saved yet - the halt stays active in memory; every later save retries it.');
    this.log(`  [live] so1 HALT: ${why}. Automated management stopped; order ${orderId ?? '?'} (${this.contracts}x stop @ ${lvl != null ? lvl.toFixed(2) : '?'}) may still be resting. Resolve manually, then restart.`);
    this.notify('HALTED — action required', `${why}. The bot sent no further order and stopped managing this trade. Check the position and the resting stop (${this.contracts}x @ ${lvl != null ? lvl.toFixed(2) : '?'}) in the platform, fix it by hand, then restart the bot.`, { priority: 'urgent', tags: 'rotating_light' });
    try { this._manage('DESYNC', `so1 halt: ${why}. The bot stopped managing automatically and sent no further order; resolve the position and the resting stop by hand, then restart.`, { so1: true, orderId: orderId ?? null, level: lvl ?? null }); } catch (e2) { /* journal only */ }
  }

  async replaceTrailStop(orderIdField, size, newStop, refPrice) {
    const res = await this.replaceStopSafely(orderIdField, size, newStop, refPrice, this.trailStop, 'runner trail stop');
    if (this.runnerTrailRule && res.exitUnknown) { this._so1Halt('a market exit for the runner was sent but its outcome is unknown', this[orderIdField], this.trailStop); return false; }   // so1 r1.5
    const fromStop = this.trailStop;
    if (res.ok) this.trailStop = res.lvl; // only a level that is actually resting at the exchange
    if (res.ok) { const w = this._ratchetWhy; try { this._manage('TRAIL_RATCHET', w && w.so1 ? `Runner trail: the best price so far is +${w.peakPts.toFixed(1)} pts from entry, so the runner's stop moves from ${fromStop != null ? fromStop.toFixed(2) : '(unread)'} to ${res.lvl.toFixed(2)} (+${w.offsetPoints} pts: ${w.so1.lockPts} pts behind the best ${w.so1.stepPts}-pt step, only ever up).` : w ? `Runner trail: the best price so far is +${w.peakPts.toFixed(1)} pts from entry, past the +${w.lockPoints.toFixed(1)} pt lock level ($${MECH_TRAIL_LOCK_DOLLARS} on ${w.leg3Size} contracts), so the runner's stop moves from ${fromStop.toFixed(2)} to ${res.lvl.toFixed(2)} (it trails in ${this.trailStepPoints}-pt steps, so it only moves up).` : `Runner stop moved from ${fromStop.toFixed(2)} to ${res.lvl.toFixed(2)}.`, { from: fromStop, to: res.lvl }); } catch (e2) { /* journal only */ } }
    return !!res.ok || !!res.exited;
  }

  // ── PROFIT TRAIL ──
  // Whole-position profit protection. peakPts = the best favourable excursion (points from entry, live poll price) since entry; the peak OPEN PROFIT is peakPts x pointValue x the
  // contracts open NOW (so it is recomputed for the remaining size after TP1/TP2). Ladder (all in $ of the open position):
  //   peak >= beAtDollars  -> every remaining contract's stop at break-even;
  //   peak >= armDollars   -> stop at the price where closing ALL open contracts locks lockDollars, +stepDollars of lock for every further stepDollars of peak.
  // profitTrailStop only ever moves in the favourable direction. It is NOT placed here: auditStopLadder()'s intended level for every stop is max(its own level, profitTrailStop)
  // (long), so the stops are moved by the same new-first / verified-cancel / market-exit-if-through path as every other repair. Returns true when the lock moved this poll.
  updateProfitTrail(latestClose) {
    this.profitTrailMoved = false;
    const cfg = this.profitTrail;
    if (!cfg || this.desynced || this.entryPrice == null || this.dir == null) return false;
    const phase = this.phase;
    if (phase !== 'LEG1_OPEN' && phase !== 'LEG23_OPEN' && phase !== 'LEG3_OPEN') return false;
    const leg3Size = this.contracts - this.leg1Size - this.leg2Size;
    const n = phase === 'LEG1_OPEN' ? this.contracts : phase === 'LEG23_OPEN' ? (this.stopOrderId != null ? this.leg2Size : 0) + (this.leg3StopOrderId != null ? leg3Size : 0) : leg3Size;
    if (!(n > 0) || !Number.isFinite(latestClose)) return false;
    const dir = this.dir, tick = this.tickSize;
    this.ptPeakPts = Math.max(this.ptPeakPts || 0, dir * (latestClose - this.entryPrice));
    const peakD = this.ptPeakPts * this.pointValue * n;
    let stage = null, lockD = 0, lockPts;
    if (cfg.unit === 'points') {
      // 10/18 RULE 3: the same ladder in points from entry, independent of how many contracts are open (5-lot: $200/$150/$50 = 20/15/5 pts)
      const r = profitLockPoints(this.ptPeakPts, { armPts: cfg.armPts, lockPts: cfg.lockPts, stepPts: cfg.stepPts, bePts: cfg.bePts }, tick);
      if (!r) return false;
      stage = r.stage; lockPts = r.lockPts;
    } else {
    if (cfg.armDollars != null && peakD >= cfg.armDollars) {
      const step = cfg.stepDollars > 0 ? cfg.stepDollars : null;
      lockD = (cfg.lockDollars || 0) + (step ? Math.floor((peakD - cfg.armDollars) / step) * step : 0);
      stage = 'LOCK';
    } else if (cfg.beAtDollars != null && peakD >= cfg.beAtDollars) { lockD = 0; stage = 'BE'; }
    if (!stage) return false;
    lockPts = Math.max(0, lockD / (this.pointValue * n));
    }
    lockPts = Math.min(lockPts, Math.max(0, this.ptPeakPts - tick)); // never at or above the peak price itself
    const lvl = roundTrailStopConservative(this.entryPrice + dir * lockPts, dir, tick);
    const better = this.profitTrailStop == null || (dir === 1 ? lvl > this.profitTrailStop : lvl < this.profitTrailStop);
    if (!better) return false;
    this.profitTrailStop = lvl; this.profitTrailMoved = true;
    const lockedD = Math.round(dir * (lvl - this.entryPrice) * this.pointValue * n * 100) / 100;
    this.log(`  [profit-trail] ${stage}: peak open profit $${peakD.toFixed(0)} on ${n}x (peak ${this.ptPeakPts.toFixed(2)} pts) -> every open stop to ${lvl.toFixed(2)} (locks about $${lockedD} on the ${n}x still open).`);
    const ptsTxt = cfg.unit === 'points' ? ` (points ladder: arm +${cfg.armPts}, lock +${cfg.lockPts}, step ${cfg.stepPts}; locks +${(dir * (lvl - this.entryPrice)).toFixed(2)} pts)` : '';   // 10/18
    try { this._manage('PROFIT_TRAIL', stage === 'BE' ? `Profit trail: open profit peaked at $${peakD.toFixed(0)} on ${n}x, so every open stop goes to break-even ${lvl.toFixed(2)}.${ptsTxt}` : `Profit trail: open profit peaked at $${peakD.toFixed(0)} on ${n}x (+${this.ptPeakPts.toFixed(1)} pts), so every open stop moves to ${lvl.toFixed(2)}, which locks about $${lockedD} if all ${n} contracts stop out there.${ptsTxt}`, { stage, stopPrice: lvl, peakDollars: Math.round(peakD), unit: cfg.unit }); } catch (e2) { /* journal only */ }
    this.journal({ type: 'profit_trail', t: Date.now(), dir, entryPrice: this.entryPrice, stage, peakPoints: this.ptPeakPts, peakDollars: Math.round(peakD * 100) / 100, openContracts: n, lockDollars: lockedD, stopPrice: lvl, phase });
    return true;
  }

  // ── Stop-ladder audit (hotfix 4): every poll while a position is open, compare the broker's WORKING stop orders with the ladder this machine intends.
  //  - a tracked stop that is missing, the wrong size, or WORSE than intended (long: lower; short: higher) is replaced by the intended level, or - if the market is
  //    already through that level - those contracts are exited at market. Never loosened: a stop BETTER than intended (e.g. dragged by hand) is left alone, and for the
  //    runner stop the trail level adopts it so a later ratchet cannot replace it with something weaker.
  //  - only acts when the broker's position size equals what this machine expects (read before AND after the order list), so a leg that just filled is never "repaired".
  //  - unreadable orders / position -> do nothing and retry next poll. Untracked extra stop orders are reported, never cancelled.
  // Returns a short status string (for tests/logs).
  async auditStopLadder(latestClose) {
    if (this.desynced) return 'desynced';
    const phase = this.phase;
    if (phase !== 'LEG1_OPEN' && phase !== 'LEG23_OPEN' && phase !== 'LEG3_OPEN') return 'not-open';
    if (this.auditRetryAt && Date.now() < this.auditRetryAt) return 'backoff';
    const tick = this.tickSize, long = this.dir === 1, half = tick / 2;
    const entry = roundToTick(this.entryPrice, tick);
    const ptStop = this.profitTrail ? this.profitTrailStop : null; // profit-trail lock (null when off / not armed): tighter of it and each stop's own level
    const fl = lvl => ptStop == null ? lvl : (long ? Math.max(lvl, ptStop) : Math.min(lvl, ptStop));
    const ladder = [];
    let expectedOpen;
    if (phase === 'LEG1_OPEN') {
      expectedOpen = this.contracts;
      ladder.push({ field: 'stopOrderId', size: this.contracts, intended: fl(roundToTick(this.stopPriceIntended, tick)), label: ptStop != null && fl(roundToTick(this.stopPriceIntended, tick)) === ptStop ? 'profit-lock stop' : 'initial stop', trail: false });
    } else if (phase === 'LEG23_OPEN') {
      const leg3Size = this.contracts - this.leg1Size - this.leg2Size;
      expectedOpen = (this.stopOrderId != null ? this.leg2Size : 0) + (this.leg3StopOrderId != null ? leg3Size : 0);
      if (this.stopOrderId != null) ladder.push({ field: 'stopOrderId', size: this.leg2Size, intended: fl(entry), label: ptStop != null && fl(entry) !== entry ? 'leg2 profit-lock stop' : 'leg2 break-even stop', trail: false });
      const atrLvl = this._atrRunner() && this.runnerArmed ? this._atrStopLevel() : null, rs0 = this.trailStop ?? entry;   // edge r1: the ATR runner's stop is never intended below entry + stopPts
      const rs = atrLvl == null ? rs0 : long ? Math.max(rs0, atrLvl) : Math.min(rs0, atrLvl);
      if (this.leg3StopOrderId != null) ladder.push({ field: 'leg3StopOrderId', size: leg3Size, intended: fl(roundToTick(long ? Math.max(rs, entry) : Math.min(rs, entry), tick)), label: 'runner stop', trail: true });
    } else {
      expectedOpen = this.contracts - this.leg1Size - this.leg2Size;
      ladder.push({ field: 'stopOrderId', size: expectedOpen, intended: fl(roundToTick(long ? Math.max(this.trailStop ?? entry, entry) : Math.min(this.trailStop ?? entry, entry), tick)), label: 'runner stop', trail: true });
    }
    if (expectedOpen <= 0 || !ladder.length) return 'nothing-expected';
    let pos1, orders, pos2;
    try {
      pos1 = await getOpenPosition(this.token, this.accountId, this.contractId);
      orders = await getOpenOrders(this.token, this.accountId, this.contractId);
      pos2 = await getOpenPosition(this.token, this.accountId, this.contractId);
    } catch (e) { return 'unreadable'; }
    const s1 = pos1 ? pos1.size : 0, s2 = pos2 ? pos2.size : 0;
    if (s1 !== expectedOpen || s2 !== expectedOpen) return 'size-mismatch'; // a fill is in flight, or tick() will DESYNC it; never repair on a moving picture
    const closeSide = this.sideFor(this.dir, true);
    const isStop = o => o.type === OrderType.STOP && (o.side === undefined || o.side === closeSide);
    const byId = new Map(orders.map(o => [String(o.id), o]));
    const fixes = [];
    let ladderTotal = 0;
    for (const L of ladder) {
      const id = this[L.field], o = id == null ? null : byId.get(String(id));
      const price = o ? (o.stopPrice ?? o.price) : null;
      const sizeOk = o ? (o.size === undefined || o.size === L.size) : false;
      const worse = o && price != null ? (long ? price < L.intended - half : price > L.intended + half) : false;
      const better = o && price != null ? (long ? price > L.intended + half : price < L.intended - half) : false;
      if (o && sizeOk) ladderTotal += L.size;
      if (o && !worse && sizeOk) {
        if (better && L.trail) { this.trailStop = price; } // a stop that is better than intended (dragged by hand) is adopted, never fought
        continue;
      }
      fixes.push({ L, o, price, why: !o ? 'missing' : !sizeOk ? `size ${o.size} != ${L.size}` : `worse than intended (${price.toFixed(2)} vs ${L.intended.toFixed(2)})` });
    }
    // untracked extra stops (report only)
    const trackedIds = new Set(ladder.map(L => this[L.field]).filter(x => x != null).map(String));
    for (const sid of this.staleStops.keys()) trackedIds.add(sid); // known stale stops are being cancelled by sweepStaleStops(), not 'untracked extras'
    const extras = orders.filter(o => isStop(o) && !trackedIds.has(String(o.id)));
    const totalStopSize = orders.filter(isStop).reduce((sum, o) => sum + (o.size || 0), 0);
    if (!fixes.length) {
      if (totalStopSize > expectedOpen && extras.length && (!this.auditExtraNotifiedAt || Date.now() - this.auditExtraNotifiedAt > 10 * 60000)) {
        this.auditExtraNotifiedAt = Date.now();
        this.log(`  [risk] ladder check: ${totalStopSize}x of stop orders rest for a ${expectedOpen}x position (${extras.length} untracked stop order(s)) - not touching them.`);
        this.notify('Extra stop orders resting', `${totalStopSize} contracts of stop orders rest for a ${expectedOpen}-contract position (${extras.length} the bot did not place). Check the account.`, { priority: 'high', tags: 'warning' });
      }
      return 'ok';
    }
    const done = [];
    for (const f of fixes) {
      const { L, o, price } = f;
      const res = await this.replaceStopSafely(L.field, L.size, L.intended, latestClose, o ? price : null, L.label);
      if (res.ok) { if (L.trail) this.trailStop = res.lvl; done.push(`${L.label} ${f.why} -> ${res.lvl.toFixed(2)}`); }
      else if (res.exited) done.push(`${L.label} ${f.why} -> exited ${L.size}x at market`);
      else done.push(`${L.label} ${f.why} -> NOT fixed yet`);
    }
    const anyFailed = done.some(x => /NOT fixed/.test(x));
    const missingUnfixed = fixes.some((f, i) => !f.o && /NOT fixed/.test(done[i]));   // C5: a leg with NO stop at all
    if (anyFailed && missingUnfixed) { this.auditRetryAt = 0; } // never back off while a leg has no stop: retry on every poll
    else if (anyFailed) { // back off exponentially under persistent rejection of a repair that has a (worse) stop in place: 5 s, 15 s, 60 s, 3 min, 5 min (cap)
      this.failStreak = (this.failStreak || 0) + 1;
      this.auditRetryAt = Date.now() + [5000, 15000, 60000, 180000, 300000][Math.min(this.failStreak, 5) - 1];
    } else this.failStreak = 0;
    this.log(`  [risk] ladder ${anyFailed ? 'NOT fully fixed (retrying with back-off)' : 'fixed'}: ${done.join('; ')}`);
    try { this._manage('LADDER_REPAIR', `Stop check: the stops at the broker did not match the plan, so the bot ${anyFailed ? 'tried to repair them but not everything could be fixed yet' : 'repaired them'}: ${done.join('; ')}.`, { ok: !anyFailed }); } catch (e2) { /* journal only */ }
    if (!this.auditNotifiedAt || Date.now() - this.auditNotifiedAt > (missingUnfixed ? 2 * 60000 : 5 * 60000)) {
      this.auditNotifiedAt = Date.now();
      this.notify(anyFailed ? (missingUnfixed ? 'NO STOP on part of the position - retrying' : 'Stop ladder: repair FAILED - retrying') : 'Stop ladder repaired', done.join('; '), { priority: missingUnfixed ? 'urgent' : 'high', tags: anyFailed ? 'warning' : 'shield' });
    }
    return 'fixed';
  }

  async maybeRatchetTrail(latestClose, levelsRow) {
    if (this.desynced) return;
    if (this.sessionExit && this.sessionExit.runnerStopAtBE) return;   // base-hit trade: the runner keeps its break-even stop (the profit trail, if on, may still raise it)
    let orderIdField;
    if (this.phase === 'LEG23_OPEN' && this.leg3StopOrderId != null) orderIdField = 'leg3StopOrderId';
    else if (this.phase === 'LEG3_OPEN') orderIdField = 'stopOrderId';
    else return;
    const leg3Size = this.contracts - this.leg1Size - this.leg2Size;
    if (leg3Size <= 0) return;
    if (this.runnerTrailRule && !this.runnerArmed) return;   // so1 r1.1 (MacDot #3): no proof the scale-out happened -> no runner trail
    if (this.runnerTrailRule && this._atrRunner()) {
      // edge r1 'atrTarget': NO trail. The stop is brought to entry + stopPts when it is not there yet (refused at the scale-out, or re-placed lower), never moved
      // beyond it; a missing TP2 limit is put back (order list read first). Same safe replace path as the trail.
      if (this.targetOrderId == null && !(this.tp2RetryAt && Date.now() < this.tp2RetryAt)) await this._atrPlaceTp2(leg3Size);
      const want = this._atrStopLevel();
      if (this.trailStop != null && !(this.dir === 1 ? want > this.trailStop : want < this.trailStop)) return;
      if (this.trailRetryAt && Date.now() < this.trailRetryAt) return;
      this.log(`  [runner] ATR runner: stop ${this.trailStop != null ? this.trailStop.toFixed(2) : '(unread)'} -> ${want.toFixed(2)} (entry ${this.dir === 1 ? '+' : '-'}${this.runnerPlan.stopPts}), replacing the runner's resting stop (new stop first).`);
      this._ratchetWhy = null;
      await this.replaceTrailStop(orderIdField, leg3Size, want, latestClose);
      return;
    }
    if (this.runnerTrailRule) {
      // so1 (Mac 10/22): stop lockPts behind the best price in stepPts steps, never below +lockPts, never loosening (same safe replace path as below).
      const excursionPts = this.dir === 1 ? latestClose - this.entryPrice : this.entryPrice - latestClose;
      this.trailPeakPts = Math.max(this.trailPeakPts || 0, excursionPts);
      const offsetPoints = runnerTrailOffset(this.trailPeakPts, this.runnerTrailRule);
      const roundedStop = roundTrailStopConservative(this.dir === 1 ? this.entryPrice + offsetPoints : this.entryPrice - offsetPoints, this.dir, this.tickSize);
      if (this.trailStop != null && !(this.dir === 1 ? roundedStop > this.trailStop : roundedStop < this.trailStop)) return;   // r1.3: an unread level (null) is replaced
      if (this.trailRetryAt && Date.now() < this.trailRetryAt) return;
      this.log(`  [live] runner trail (so1): ${this.trailStop != null ? this.trailStop.toFixed(2) : '(unread)'} -> ${roundedStop.toFixed(2)}, replacing the runner's resting stop (new stop first).`);
      this._ratchetWhy = { peakPts: this.trailPeakPts, offsetPoints, leg3Size, from: this.trailStop, so1: this.runnerTrailRule };   // from may be null (r1.3)
      await this.replaceTrailStop(orderIdField, leg3Size, roundedStop, latestClose);
      return;
    }
    if (this.trailStepPoints != null) {
      // Mac's runner trail (2026-10-08, bundle spec) — MECHANICAL, replacing
      // the level-gated ratchet below. See simulate3leg.js's matching
      // comment for the full rule. latestClose is this live loop's own poll
      // price (no true intrabar high/low here), used as the running
      // favorable-excursion proxy — one-way (trailPeakPts only grows) and
      // tick-rounded conservatively so rounding never tightens past what
      // was earned.
      const excursionPts = this.dir === 1 ? latestClose - this.entryPrice : this.entryPrice - latestClose;
      this.trailPeakPts = Math.max(this.trailPeakPts || 0, excursionPts);
      const lockPoints = MECH_TRAIL_LOCK_DOLLARS / (this.pointValue * leg3Size);
      if (this.trailPeakPts < lockPoints) return; // still breakeven, nothing earned yet
      const extra = this.trailPeakPts - lockPoints;
      const offsetPoints = lockPoints + Math.floor(extra / this.trailStepPoints) * this.trailStepPoints;
      const rawStop = this.dir === 1 ? this.entryPrice + offsetPoints : this.entryPrice - offsetPoints;
      const roundedStop = roundTrailStopConservative(rawStop, this.dir, this.tickSize);
      const better = this.dir === 1 ? roundedStop > this.trailStop : roundedStop < this.trailStop;
      if (!better) return;
      if (this.trailRetryAt && Date.now() < this.trailRetryAt) return; // back-off after a rejected placement (hotfix 4)
      this.log(`  [live] trail ratchet (mechanical): ${this.trailStop.toFixed(2)} -> ${roundedStop.toFixed(2)}, replacing leg3's resting stop (new stop first, old one cancelled only after it is accepted).`);
      this._ratchetWhy = { peakPts: this.trailPeakPts, lockPoints, offsetPoints, leg3Size, from: this.trailStop };
      await this.replaceTrailStop(orderIdField, leg3Size, roundedStop, latestClose);
    } else {
      if (!levelsRow?.levels) return;
      let best = this.trailStop;
      for (const lvl of levelsRow.levels) {
        if (this.dir === 1) { if (lvl.price > best && latestClose > lvl.price) best = lvl.price; }
        else { if (lvl.price < best && latestClose < lvl.price) best = lvl.price; }
      }
      if (best !== this.trailStop) {
        if (this.trailRetryAt && Date.now() < this.trailRetryAt) return;
        this.log(`  [live] trail ratchet: ${this.trailStop.toFixed(2)} -> ${best.toFixed(2)}, replacing resting stop (new stop first).`);
        await this.replaceTrailStop(orderIdField, leg3Size, best, latestClose);
      }
    }
  }

  // Profit-lock (2026-09-21, real live trade review): TP1's fixed price
  // distance doesn't scale with position size — on a 15-contract trade,
  // unrealized profit can already be hundreds of dollars before price ever
  // reaches a 15pt target, and a reversal from there gives all of it back
  // with nothing banked. This reacts to the actual dollar swing instead of
  // waiting for a price level, in BOTH windows a position can sit exposed:
  // waiting on TP1 (LEG1_OPEN) and waiting on TP2 (LEG23_OPEN, TP2 sits even
  // further out). Each fires at most once per trade. Cancels and re-places
  // the resting stop/target at the new, smaller size afterward — a resting
  // order's size can't be edited in place, only replaced, same pattern as
  // every other order mutation in this file.
  // Tracks the best (most favorable) unrealized $ this trade reaches, across
  // every open phase — journaled once at close (reset(), below) so a later
  // "was this ever actually working before it round-tripped" question is
  // answerable from the signal journal instead of guessed at from just the
  // final realized P&L, which is all the broker's own fill history ever
  // shows. Read-only observation — places no orders, changes no state
  // machine behavior.
  trackPeakUnrealized(latestClose) {
    if (Number.isFinite(latestClose)) this.lastPrice = latestClose;   // 10/18: the last poll price (1-lot exit disambiguation)
    if (this.desynced || this.phase === 'FLAT' || this.phase === 'PENDING_ENTRY' || this.entryPrice == null) return;
    const unrealizedPts = this.dir === 1 ? (latestClose - this.entryPrice) : (this.entryPrice - latestClose);
    const openSize = this.phase === 'LEG1_OPEN' ? this.contracts
      : this.phase === 'LEG23_OPEN' ? this.contracts - this.leg1Size
      : this.contracts - this.leg1Size - this.leg2Size; // LEG3_OPEN
    if (openSize <= 0) return;
    this.peakUnrealized = Math.max(this.peakUnrealized, unrealizedPts * this.pointValue * openSize);
  }

  async maybeProfitLock(latestClose) {
    if (this.desynced || !this.profitLockDollars) return;
    if (this.phase === 'LEG1_OPEN' && !this.profitLocked) {
      const unrealizedPts = this.dir === 1 ? (latestClose - this.entryPrice) : (this.entryPrice - latestClose);
      const unrealizedDollars = unrealizedPts * this.pointValue * this.contracts;
      if (unrealizedDollars < this.profitLockDollars) return;
      const lockSize = Math.min(this.contracts - 1, Math.max(1, Math.round(this.contracts * this.profitLockPct)));
      const lockSide1 = this.sideFor(this.dir, true);
      const lockType1 = this.marketableLimitBufferPoints > 0 ? OrderType.LIMIT : OrderType.MARKET;
      const lockBody1 = { accountId: this.accountId, contractId: this.contractId, type: lockType1, side: lockSide1, size: lockSize };
      if (lockType1 === OrderType.LIMIT) lockBody1.limitPrice = aggressiveLimitPrice(lockSide1, latestClose, this.marketableLimitBufferPoints, this.tickSize);
      this.log(`  [live] profit-lock: unrealized $${unrealizedDollars.toFixed(2)} on ${this.contracts}x crossed $${this.profitLockDollars} before TP1 — closing ${lockSize}x${lockType1 === OrderType.LIMIT ? ' (marketable limit)' : ' at market'}.`);
      await placeOrder(this.token, lockBody1);
      this.notify('Profit lock', `Closed ${lockSize}x at market — unrealized crossed $${this.profitLockDollars} before TP1.`, { tags: 'moneybag' });
      try { this._manage('PROFIT_LOCK_CASH', `Dollar profit-lock: unrealized profit crossed ${this.profitLockDollars} before TP1, so ${lockSize} contracts were closed at market.`, {}); } catch (e2) { /* journal only */ }
      this.contracts -= lockSize;
      this.leg1Size = Math.min(this.leg1Size, this.contracts - 1);
      await this.cancelIfSet('stopOrderId');
      await this.cancelIfSet('targetOrderId');
      this.stopOrderId = await this.placeProtectiveStop(this.contracts, this.stopPriceIntended);
      this.targetOrderId = await this.placeTargetLimit(this.leg1Size, this.target1);
      this.profitLocked = true;
    } else if (this.phase === 'LEG23_OPEN' && !this.profitLocked2) {
      const openAfterLeg1 = this.contracts - this.leg1Size;
      const leg3Remaining = this.contracts - this.leg1Size - this.leg2Size;
      if (leg3Remaining <= 0) return;
      const unrealizedPts = this.dir === 1 ? (latestClose - this.entryPrice) : (this.entryPrice - latestClose);
      const unrealizedDollars = unrealizedPts * this.pointValue * openAfterLeg1;
      if (unrealizedDollars < this.profitLockDollars) return;
      const lockSize = Math.min(leg3Remaining, Math.max(1, Math.round(leg3Remaining * this.profitLockPct)));
      const lockSide2 = this.sideFor(this.dir, true);
      const lockType2 = this.marketableLimitBufferPoints > 0 ? OrderType.LIMIT : OrderType.MARKET;
      const lockBody2 = { accountId: this.accountId, contractId: this.contractId, type: lockType2, side: lockSide2, size: lockSize };
      if (lockType2 === OrderType.LIMIT) lockBody2.limitPrice = aggressiveLimitPrice(lockSide2, latestClose, this.marketableLimitBufferPoints, this.tickSize);
      this.log(`  [live] profit-lock-2: unrealized $${unrealizedDollars.toFixed(2)} on ${openAfterLeg1}x (post-TP1) crossed $${this.profitLockDollars} while waiting on TP2 — closing ${lockSize}x${lockType2 === OrderType.LIMIT ? ' (marketable limit)' : ' at market'} from leg3's share.`);
      await placeOrder(this.token, lockBody2);
      this.notify('Profit lock (TP2 wait)', `Closed ${lockSize}x at market — unrealized crossed $${this.profitLockDollars} while waiting on TP2.`, { tags: 'moneybag' });
      try { this._manage('PROFIT_LOCK_CASH', `Dollar profit-lock: unrealized profit crossed ${this.profitLockDollars} while waiting for TP2, so ${lockSize} contracts were closed at market.`, {}); } catch (e2) { /* journal only */ }
      this.contracts -= lockSize;
      // Mac's runner trail split (2026-10-08, bundle spec): this used to
      // cancel+resize the ONE shared leg2+leg3 stop back to breakeven. Now
      // it only ever touches leg3's OWN stop (leg2's stop/target are
      // untouched), resized to leg3's new smaller remainder and replaced at
      // its CURRENT trail level (this.trailStop), not reset to breakeven —
      // leg3's trail may already have ratcheted past breakeven by the time
      // this fires, and resetting it would throw that away for no reason.
      const newLeg3Size = this.contracts - this.leg1Size - this.leg2Size;
      await this.cancelIfSet('leg3StopOrderId');
      this.leg3StopOrderId = newLeg3Size > 0 ? await this.placeProtectiveStop(newLeg3Size, this.trailStop) : null;
      this.profitLocked2 = true;
    }
  }

  // Startup reconciliation (2026-09-21): a process restart previously left a
  // REAL open position completely unmanaged forever — phase always
  // initialized to FLAT and tick() no-ops entirely while FLAT, so a restart
  // that happened while a position was open meant zero stop, zero target,
  // and zero awareness a fresh signal could stack another entry on top of
  // it. This exact failure put a real 15-lot position naked for hours.
  // Called once at startup (see live-executor.js) whenever the account's
  // REAL position search finds something already open. We don't know the
  // original signal's entry/stop/target plan — that died with the old
  // process — so this sweeps whatever orders exist (they may be stale,
  // partial, or gone) and places a fresh protective stop/target computed
  // off CURRENT conditions, adopting the position into the normal
  // LEG1_OPEN management flow from here forward. A 1-contract-or-less
  // leftover has nothing left to scale out of, so it goes straight to
  // LEG3_OPEN under a single trailing stop instead.
  async adoptExistingPosition({ dir, size, entryPrice, stopPrice, target1, target2, leg1Size, leg2Size, tp1Banked = false }) {
    this.pxBoundaryAt = Date.now();   // np1 r1.5: prices from after the adoption only (the fill time is not known)
    await this.cancelAllOrdersForContract();
    this.dir = dir; this.entryPrice = entryPrice; this.intendedEntryPrice = entryPrice; this.contracts = size;
    this.tightStopPrice = null; this.smartHoldChecked = false; this.profitLocked = false; this.profitLocked2 = false;
    this._stateArmed = true;
    // FIX1015: the saved state could not be matched but the journal shows this trade already banked TP1: never a loss-side stop. Every remaining contract gets ONE
    // stop at break-even (no new TP1 limit) and trails as a runner (LEG3_OPEN). Placed without the widen-from-entry fallback; if the market is already through
    // break-even, those contracts are closed at market (what the break-even stop would have done).
    if (tp1Banked && this.runnerTrailRule && size > 1 && Number.isFinite(target1)) {
      // so1 r1.3 (MacDot 6356559270 #3): a partial scale-out (e.g. 5 entered, 2 scaled, 3 held) must still leave exactly ONE runner
      const be = roundToTick(entryPrice, this.tickSize);
      this.leg1Size = size - 1; this.leg2Size = 0; this.stopPriceIntended = be; this.trailStop = null; this.trailPeakPts = 0; this.runnerArmed = false; this.stopOrderId = null; this.targetOrderId = null;
      this.target1 = roundToTick(target1, this.tickSize); this.target2 = roundToTick(target2, this.tickSize); this.phase = 'LEG1_OPEN';
      const r = await this.replaceStopSafely('stopOrderId', size, be, entryPrice, null, 'break-even stop (scale-out partly banked)');
      if (r.exited) { this.log(`  [live] RECOVERY: the market was already through break-even - the ${size}x were closed at market.`); return; }
      if (r.exitUnknown || r.halted || this.desynced) return;   // so1 r1.7: halted - no TP1, no further submissions
      if (!r.ok) this.log(`  [live] RECOVERY: the break-even stop for ${size}x could not be placed yet - the stop ladder audit / next poll retries.`);
      this.targetOrderId = await this.placeTargetLimit(this.leg1Size, this.target1);
      this.log(`  [live] RECOVERY: adopted ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} after a partial scale-out: stop ${r.ok ? '@ ' + r.lvl.toFixed(2) : 'pending'} for all ${size}x, TP1 ${this.leg1Size}x @ ${this.target1.toFixed(2)}, 1 runner after it fills.`);
      this.notify('Recovered position protected (scale-out partly banked)', `${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)}: break-even stop, ${this.leg1Size}x still to scale at ${this.target1.toFixed(2)}, 1 runner.`, { priority: r.ok ? 'high' : 'urgent', tags: 'shield' });
      try { this._manage('ADOPTED', `After a restart the bot found this position after a partial scale-out: break-even stop for all ${size}, the remaining ${this.leg1Size} scale out at ${this.target1.toFixed(2)}, one runner after that.`, { tp1Banked: true, so1: true }); } catch (e2) { /* journal only */ }
      return;
    }
    if (tp1Banked) {
      const be = roundToTick(entryPrice, this.tickSize);
      this.leg1Size = 0; this.leg2Size = 0; this.stopPriceIntended = be; this.trailStop = be; this.trailPeakPts = 0; this.targetOrderId = null; this.stopOrderId = null;
      if (this.runnerTrailRule) { this.runnerArmed = true; this.trailPeakPts = Number.isFinite(target1) ? Math.abs(target1 - entryPrice) : 2 * this.runnerTrailRule.lockPts; }   // so1 r1.1: TP1 banked = the scale happened
      this.phase = 'LEG3_OPEN';
      const r = await this.replaceStopSafely('stopOrderId', size, be, entryPrice, null, 'break-even stop (TP1 already banked)');
      if (this.runnerTrailRule) this.trailStop = r.ok ? r.lvl : null;   // so1 r1.3: only an accepted level (null = none resting; the ratchet places one)
      const what = r.ok ? `a break-even stop @ ${r.lvl.toFixed(2)} now rests for all ${size}x` : r.exited ? `the market was already through break-even, so the ${size}x were closed at market` : 'the break-even stop could not be placed yet (retrying every poll)';
      this.log(`  [live] RECOVERY: adopted pre-existing ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)}; the journal shows TP1 already filled, so ${what} (phase=${this.phase}, no new TP1).`);
      this.notify('Recovered position protected (TP1 already banked)', `${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} found on startup after TP1: ${what}.`, { priority: r.ok || r.exited ? 'high' : 'urgent', tags: 'shield' });
      try { this._manage('ADOPTED', `After a restart the bot found this position at the broker. The journal shows TP1 already filled, so ${what}; it trails as a runner from here.`, { tp1Banked: true }); } catch (e2) { /* journal only */ }
      return;
    }
    const roundedStop = roundToTick(stopPrice, this.tickSize);
    try {
      if (size <= 1 && this.runnerTrailRule && Number.isFinite(target1)) {
        // so1 r1.1 (MacDot 6356445687 #3): an unscaled 1-lot keeps the so1 plan - the whole contract exits at the +20 TP1 limit, no runner
        this.leg1Size = size; this.leg2Size = 0; this.runnerArmed = false;
        this.stopPriceIntended = roundedStop; this.target1 = roundToTick(target1, this.tickSize); this.target2 = roundToTick(target2, this.tickSize);
        this.stopOrderId = await this.placeProtectiveStop(size, this.stopPriceIntended);
        this.targetOrderId = await this.placeTargetLimit(this.leg1Size, this.target1);
        this.phase = 'LEG1_OPEN';
      } else if (size <= 1) {
        this.leg1Size = 0; this.leg2Size = 0;
        this.stopOrderId = await this.placeProtectiveStop(size, roundedStop);
        this.stopPriceIntended = roundedStop; this.trailStop = roundedStop; this.targetOrderId = null;
        this.phase = 'LEG3_OPEN';
      } else {
        this.leg1Size = Math.min(leg1Size, size - 1);
        this.leg2Size = Math.min(leg2Size, size - this.leg1Size);
        this.stopPriceIntended = roundedStop; this.target1 = roundToTick(target1, this.tickSize); this.target2 = roundToTick(target2, this.tickSize);
        this.stopOrderId = await this.placeProtectiveStop(size, this.stopPriceIntended);
        this.targetOrderId = await this.placeTargetLimit(this.leg1Size, this.target1);
        this.phase = 'LEG1_OPEN';
      }
      this.log(`  [live] RECOVERY: adopted pre-existing ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} found on startup — fresh protective stop @ ${roundedStop.toFixed(2)} now resting (phase=${this.phase}).`);
      this.notify('Recovered position protected', `${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} found on startup — fresh stop @ ${roundedStop.toFixed(2)} now resting.`, { priority: 'high', tags: 'shield' });
      try { this._manage('ADOPTED', `After a restart the bot found this position at the broker and placed a fresh protective stop at ${roundedStop.toFixed(2)}. Any earlier profit lock is rebuilt from the next price.`, {}); } catch (e2) { /* journal only */ }
    } catch (e) {
      this.log(`  [live] CRITICAL: could not place protective stop for recovered position — still UNPROTECTED: ${e.message}`);
      this.notify('UNPROTECTED POSITION — action required', `Found ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} on startup but protective stop failed to place: ${e.message}. Check the account manually NOW.`, { priority: 'urgent', tags: 'rotating_light' });
    }
  }

  // Manual flatten (2026-09-22): lets you close everything RIGHT NOW from
  // the mobile status page — a resting stop protects against the position
  // moving against you, but doesn't cover "I just want out immediately,"
  // which was the whole gap in "you can only watch" while away from a
  // computer. Always a plain MARKET order, regardless of
  // marketableLimitBufferPoints — an emergency exit needs CERTAINTY of
  // actually getting flat, not slippage control; a marketable-limit that
  // fails to fill would leave you exactly as exposed as doing nothing.
  // Goes through a FLATTENING phase rather than resetting immediately, so
  // tick() confirms the real position actually hit 0 first — same "never
  // assume it filled" rule as every other transition in this file.
  // r1.1: the manual flatten (phone request, also the daily floor and the trend time stop) now runs on the SAME safe-exit rule as every automatic exit:
  // it is a 'manual' kind of sessionFlatten (protective orders cancelled VERIFIED first, the exit intent on disk before the send, a lost reply = UNKNOWN -> settle,
  // never a second order while unknown, K = 3 sends with backoff, then HALT). flattenKind 'manual' is persisted, and the executor drives an unfinished manual
  // flatten every poll (stops still resting, a rejected send waiting its backoff, a restart) until FLAT or HALT. A halted machine sends nothing (flatten in TopstepX).
  // Returns 'none' | 'sent' | 'retry' | 'desynced' | the pending-cancel result. An unreadable position still THROWS (e.positionUnreadable) before anything is touched.
  async flattenNow(opts = {}) {
    const receiptAttempt = jr.consumeCloseAttempt(this); // observer only; consumed even on no-op
    if (this.phase === 'FLAT' || this.phase === 'FLATTENING') {
      this.log(`  [live] flatten requested but phase is already ${this.phase} — no-op.`);
      return this.phase === 'FLAT' ? 'none' : 'sent';
    }
    if (this.phase === 'PENDING_ENTRY' && !this.throughStop) {
      jr.note(this, 'PENDING_CANCEL_REQUESTED', { requestedAction: 'cancel_pending_entry', attempt: receiptAttempt, statement: 'Pending-entry cancellation requested; this is not a position-close request or a cancellation confirmation.' });
      return this._cancelPendingVerified({ label: 'manual pending cancel', cancelReason: 'manual entry cancellation verified', logDone: 'manual entry cancellation verified', code: 'MANUAL_ENTRY_CANCEL', manageText: 'Pending entry cancellation verified.', noteTitle: 'Entry cancellation verified', noteText: 'Broker confirms the entry is terminal, unfilled, with no position.' });
    }
    if (this.phase === 'PENDING_ENTRY') { this.log('  [live] flatten requested while the filled-through-stop exit is already closing the position - it keeps running on the safe-exit rule; nothing extra is sent.'); return 'sent'; }
    if (this.desynced) {
      this.log(`  [exit-safety] flatten requested but the bot is HALTED (${this._so1HaltWhy || 'desync'}) - it sends no order on an unexplained position. Flatten in TopstepX.`);
      try { this._manage('MANUAL_FLATTEN_REFUSED_HALTED', `A flatten was requested while the bot is halted (${this._so1HaltWhy || 'desync'}); no order was sent. Flatten in TopstepX.`, {}); } catch (e2) { /* journal only */ }
      return 'desynced';
    }
    // profittrail4: an unreadable position must not look like "already flat" (that cancelled every stop and sent no exit): throw instead; the caller keeps the request and retries.
    const pos = await getOpenPosition(this.token, this.accountId, this.contractId);
    const size = pos ? pos.size : 0;
    if (size === 0) {
      this.log('  [live] flatten requested but real position is already 0 — cleaning up and resetting.');
      await this.cancelAllOrdersForContract();
      this.reset();
      return 'none';
    }
    jr.requestClose(this, receiptAttempt.cause, receiptAttempt.actor, receiptAttempt.provenance);
    // an exit that is already running (session close, morning hold, no-progress, level-loss) keeps its own kind and owner: this call just drives it now
    if (!this.sessionFlattenStarted) { this.flattenKind = 'manual'; this.exitWhat = opts.what || 'manual'; }
    const kind = this.flattenKind === 'manual' ? 'manual' : this.flattenKind === 'no-progress' ? 'no-progress' : this.flattenKind === 'level-loss' ? 'level-loss' : this.flattenKind === 'early-adverse' ? 'early-adverse' : 'session';
    return this.sessionFlatten(opts.reason || 'manual flatten', kind);
  }

  reset() {
    this._pendingCancelIntent = null;   // r9.6 re-review S1
    this._startupCancel = false; this._startupUnresolvedReported = false;   // TIME BLOCKS r3: never carried into the next entry
    jr.resetObserved(this);
    // Journaled here, not at each individual leg exit, since this is the ONE
    // place every closing path (target fills, stop-outs, manual flatten)
    // already funnels through — matched back to the broker's own fill
    // record the same way the 'entry' event already is (dir + entryPrice +
    // time window), in enrichTradesWithJournal().
    if (this.entryPrice != null && this.phase !== 'PENDING_ENTRY' && this.phase !== 'FLAT') {   // np1 r1.1 (MacDot #5): a complete assessment denominator
      const dd = this.npState && this.npState.decided, cat = dd === 'exit' ? 'exited' : dd ? dd : this.npDisabled ? 'disabled' : !Number.isFinite(this.npFillAt) ? 'unknown-fill' : this.npLeftLeg1At != null ? 'scaled-out-before-assessment' : 'closed-before-assessment';   // r1.2: "before assessment" (timing is not proven)
      try { this.journal({ type: 'no_progress_outcome', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice, contracts: this.contracts, category: cat, fillSeenAt: this.npFillAt ?? null, checkAt: Number.isFinite(this.npFillAt) ? npCheckAt(this.npFillAt) : null, bestPtsSeen: this.npBestPts ?? null, decision: this.npState || null, note: 'observed from the first sight of the fill; an outcome record, not a causal estimate; written at reset (a trade completed during downtime or an unresolved halt has no row)' }); } catch (e2) { /* journal only */ }
    }
    if (this.entryPrice != null && this.phase !== 'PENDING_ENTRY' && this.phase !== 'FLAT' && this.eaeState) {   // edge r1: how the trade ended against the early-exit decision (both modes; none while the rule is off)
      const e = this.eaeState, le = this.lastExit && this.lastExit.entry === this.entryPrice && this.lastExit.dir === this.dir ? this.lastExit.kind : null;
      const tp1Reached = this.phase === 'LEG23_OPEN' || this.phase === 'LEG3_OPEN' || this.npLeftLeg1At != null || le === 'tp1';
      const endedBy = this.phase === 'FLATTENING' ? (this.exitReason === 'session-close' ? (this.flattenKind || this.exitWhat || 'session-close') : (this.exitReason || 'market-exit')) : tp1Reached ? 'after-tp1' : le === 'stop' || this.phase === 'LEG1_OPEN' ? 'full-stop' : 'unknown';
      try { this.journal({ type: 'early_adverse_outcome', t: Date.now(), journalId: this._edgeJid(), dir: this.dir, fill: this.entryPrice, contracts: this.contracts, mode: e.mode || null, decision: e.decided, wouldExit: e.decided === 'exit' || e.decided === 'log', exited: this.phase === 'FLATTENING' && this.flattenKind === 'early-adverse',
        pts: e.pts ?? null, mfe: e.mfe ?? null, close: e.close ?? null, closeAt: e.closeAt ?? null, why: e.why ?? null, endedBy, tp1Reached, phaseAtEnd: this.phase, bestPtsSeen: this.npBestPts ?? null,
        shadow: e.shadow ? { ...e.shadow, note: e.decided === 'exit' ? 'where the original stop and TP1 rested when the early exit was sent: walk the bars after closeAt to see which would have come first' : 'log mode: the trade ran on; endedBy / tp1Reached say what happened to it' } : null }); } catch (e2) { /* journal only */ }
    }
    if (this.entryPrice != null) {
      this.journal({ type: 'peak_unrealized', t: Date.now(), dir: this.dir, entryPrice: this.entryPrice, peakUnrealized: this.peakUnrealized });
    }
    this.phase = 'FLAT';
    this.dir = null; this.entryPrice = null; this.intendedEntryPrice = null; this.target1 = null; this.target2 = null;
    this.entryOrderId = null; this.stopOrderId = null; this.targetOrderId = null;
    this.leg3StopOrderId = null; this.trailPeakPts = 0; this.runnerArmed = false;
    this.trailStop = null; this.source = null; this.grade = null;
    this.tightStopPrice = null; this.smartHoldChecked = false; this.contracts = null;
    this.leg1Size = 1; this.leg2Size = 1; this.profitLocked = false; this.profitLocked2 = false;
    this.signalContext = null; this.sessionExit = null; this.peakUnrealized = 0;
    this.npFillAt = null; this.npBestPts = null; this.npCoveredTo = null; this.npGap = false; this.npState = null; this.flattenKind = null; this.npLeftLeg1At = null; this.npDisabled = false; this.pxBoundaryAt = null;   // np1
    this.lossLevel = null;   // exits5m r1
    this.eaeState = null; this.runnerPlan = null; this.tp2RetryAt = 0; this._tp2FailReported = false; this._haltPairDone = false; this._haltFlatReads = 0;   // edge r1; r1.1 (S1)
    this.trailRetryAt = 0; this.auditRetryAt = 0; // hotfix 4
    this.ptPeakPts = 0; this.profitTrailStop = null; this.profitTrailMoved = false; // profit trail
    this.pendingStopTouched = null; this.pendingTargetTouched = null; this.exitReason = null; this.entryType = null; this.fillHandled = false; this.throughStop = false; this._restoredPending = false; this._floorSaveReported = false; this._ordersUnreadableReported = false; this._fillPlanBase = null; this._fillFloor = undefined; this._planFloor = null; // 10/16; entry stop floor per-trade fields
    this.sessionFlattenStarted = false; this.sessionExitFails = 0; this.sessionMarketSent = false; this.sessionPrevPhase = null; this.sessionStopsBack = null; // 10/17 session close
    this.exitInFlight = null; this.exitAttempts = 0; this.exitRetryAt = 0; this.exitWhat = null; this._exitTpBack = null; this._exitStuckAlerted = false;   // bf-exitsafe
  }
}

// FIX1015 (restart fallback): does the trade journal show that the broker position `pos` already banked TP1? Finds the most recent 'entry' row with the same side and
// an entry price within RESTORE_ENTRY_TOLERANCE_PTS of the broker averagePrice; TP1 is banked when a later TP1_FILLED / TP1_PARTIAL trade_manage row exists, or
// when the broker now holds fewer contracts than that entry opened (the only way the bot reduces a trade is a target fill). Pure; never throws.
function journalShowsTp1(lines, pos) {
  try {
    if (!pos || !pos.size) return false;
    const dir = pos.type === 1 ? 1 : pos.type === 2 ? -1 : null;
    const rows = [];
    for (const line of lines) { if (!line || line.indexOf('"signal_check"') >= 0) continue; try { rows.push(JSON.parse(line)); } catch (e) { /* skip */ } }
    let i = rows.length - 1;
    for (; i >= 0; i--) { const r = rows[i]; if (r.type === 'entry' && r.dir === dir && Number.isFinite(r.entryPrice) && (pos.averagePrice == null || Math.abs(r.entryPrice - pos.averagePrice) <= RESTORE_ENTRY_TOLERANCE_PTS)) break; }
    if (i < 0) return false;
    const entryRow = rows[i];
    for (let k = i + 1; k < rows.length; k++) { const r = rows[k]; if (r.type === 'trade_manage' && (r.code === 'TP1_FILLED' || r.code === 'TP1_PARTIAL') && (r.dir == null || r.dir === dir)) return true; }
    return Number.isFinite(entryRow.contracts) && pos.size < entryRow.contracts;
  } catch (e) { return false; }
}

module.exports = { LiveStateMachine, journalShowsTp1, pendingStopTouch, fillSlipDecision };
