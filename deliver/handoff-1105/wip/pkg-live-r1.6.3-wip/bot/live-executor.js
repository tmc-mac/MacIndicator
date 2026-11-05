#!/usr/bin/env node
const initialQuantity = require('./lib/initialQuantity');
const { lockPolicy, createControlJournal, controlDisplaySnapshot, classifyControl, controlLineProblem } = require('./lib/entryControl');   // r9.10: classifyControl for the GATE reason text
const { checkConsumedAlignment } = require('./lib/alignmentRuntime');
const journalContext = require('./lib/journalContext');   // 10/19 journal-only entry / trade-time context
// r9.4: module scope. It was declared inside main() AFTER its first use by the startup checklist -> TDZ crash at boot (10/20 03:06 UTC).
const ALIGN_TF_LABEL = { M15: '15m', M30: '30m', H1: '1h', H4: '4h' };
const { POLICY: ALIGN_FRESHNESS_POLICY, MAX_AGE_MS: ALIGN_FRESHNESS_MAX_AGE_MS } = require('./lib/alignmentFreshness');
const { buildAlignmentDisplay } = require('./lib/alignmentDisplay');
const { candlePositionSnapshot } = require('./lib/candleDisplay');
const { createTradeWhyIndex, decisionFacts, closeFacts } = require('./lib/tradeWhy');
const { withEntryDetail } = require('./lib/entryPush');
const { performance: displayPerformance } = require('node:perf_hooks');
// Separate display storage: never added to entry/control boards or journal context.
const alignmentDisplays = new WeakMap();
// Live executor. Default mode is PAPER TRADING: watches real-time ProjectX
// data and runs the exact signal + 3-leg position logic validated in
// backtest.js / lib/simulate3leg.js, logging every decision as if it were
// trading, placing ZERO real orders.
//
// Pass --live to place REAL orders instead (intended for a TopstepX practice
// account — see lib/liveStateMachine.js for how real order state is managed:
// protective stops are always resting ON THE EXCHANGE, never just watched by
// this script, so a crashed process can't leave a position unprotected).
// --live requires typing a confirmation naming the actual account it will
// trade, so it can't fire against the wrong account by accident.
//
// Usage:
//   node tmc-proxy.js                                (in another terminal, must be running)
//   PTX_USER=you PTX_KEY=yourkey node live-executor.js [MNQ|MES] [--live]
//
// Same credential rule as backtest.js: env vars only, never hardcoded here.

const fs = require('fs');
const https = require('https');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { fetchAllTimeframes, fetchFastTimeframes, fetchBars, ptxFetch, rawPtxFetch, UNIT, EXTRA_FAST_TF } = require('./lib/bars');
const { BrokerAuth } = require('./lib/brokerAuth');   // 10/18: the broker token renews itself (live finding 10/15: blind after 24 h)
const { ptInfo } = require('./lib/helpers');
const { evaluateMacTrap } = require('./lib/macTrap');
const { evaluateLevelsPro } = require('./lib/levelsPro');
const { capStop, inNyOpenBlackout: inNyOpenBlackoutBase, inAsiaBlackout } = require('./lib/simulate');
const { sessionCloseState, sessionCloseText, validateEarlyCloses, splitEarlyCloses, validateSessionTimes, sessionFlagCount } = require('./lib/sessionClose');   // 10/17 session close + session flag count
const { computeTarget2, MECH_TRAIL_LOCK_DOLLARS, roundTrailStopConservative } = require('./lib/simulate3leg');
const { decideSignal, candidateBasis, controlSide, controlKnown, controlEvalValid } = require('./lib/signal');   // 10-18b2c r2: controlKnown / controlEvalValid
const { pickLevelsTrigger, levelsTriggerInfo } = require('./lib/levelsTrigger');
const levelEvent = require('./lib/levelEvent');   // lv1: sweep -> reclaim / loss at a named level (pure)
// [r1.5.2] ONE shared fetch helper for every bot fetch (the broker proxy, the VIX CDN), installed over the global fetch:
// - a failed fetch's message names METHOD host/path and the cause (e.g. "TypeError: fetch failed [POST localhost:8787/api/Position/searchOpen:
//   UND_ERR_SOCKET other side closed]"), so the loop's ERROR line says which call and why;
// - a broker READ (position, orders, order / trade search, account, contract, bars: the 15m-close reads too) that hits a stale or reset keep-alive
//   socket (UND_ERR_SOCKET, UND_ERR_CLOSED, ECONNRESET, EPIPE, "other side closed") is retried AT ONCE on a fresh connection (undici drops the dead socket),
//   then after 400 / 1200 / 2500 ms; every retry is logged;
// - ORDERS (place / cancel / modify) are NEVER re-sent here: a place that died on a socket error may have landed (TIDE's planner reads the open orders and
//   re-sends only what is not there);
// - idle sockets are dropped after 2 s (keepAliveTimeout 2 s, keepAliveMaxTimeout 5 s on a fresh Agent of Node's own undici, no npm), before the far end
//   closes them. Installed after the first real fetch (Node creates its dispatcher lazily); a fake fetch (the replay rig) has none and is left as is.
{ const f0 = globalThis.fetch, DSYM = Symbol.for('undici.globalDispatcher.1');
  if (typeof f0 === 'function' && !f0.__r152) {
    const READ = /\/api\/(Position\/searchOpen|Order\/searchOpen|Order\/search|Trade\/search|History\/retrieveBars|Account\/search|Contract\/search)$/;
    const STALE = c => !!c && /UND_ERR_SOCKET|UND_ERR_CLOSED|ECONNRESET|EPIPE|other side closed|socket hang up/i.test(`${c.code || ''} ${c.message || ''}`);
    const BACKOFF_MS = [0, 400, 1200, 2500];
    const where = (url, opts) => { try { const u = new URL(String(url && url.url ? url.url : url)); return { host: u.host, path: u.pathname, method: (opts && opts.method) || 'GET' }; } catch (_) { return { host: '?', path: '', method: (opts && opts.method) || 'GET' }; } };
    const tag = (e, w) => { try { const c = e && e.cause, why = `${w.method} ${w.host}${w.path}${c ? `: ${[c.code, c.message].filter(Boolean).join(' ')}` : ''}`;
      if (e && typeof e.message === 'string' && !e.message.includes(' [')) { e.message = `${e.message} [${why}]`; if (typeof e.stack === 'string') e.stack = e.stack.replace(/^[^\n]*/, `${e.name || 'Error'}: ${e.message}`); } } catch (_) { /* diagnostics only */ } return e; };
    const say = m => { try { console.log(`[${new Date().toISOString()}]   [net] ${m}`); } catch (_) { /* log only */ } };
    let agentDone = false;
    const agent = () => { if (agentDone) return; agentDone = true;
      try { const d = globalThis[DSYM]; if (d && typeof d.constructor === 'function' && d.constructor.name === 'Agent') { globalThis[DSYM] = new d.constructor({ keepAliveTimeout: 2000, keepAliveMaxTimeout: 5000 }); say('keep-alive: idle sockets dropped after 2 s (keepAliveTimeout 2 s, keepAliveMaxTimeout 5 s)'); } }
      catch (e) { say(`keep-alive Agent not set (${e.message}) - the stale-socket retry alone covers it`); } };
    const fx = async function (url, opts) {
      let r; try { r = await f0(url, opts); agent(); return r; }
      catch (e) {
        agent();
        const w = where(url, opts); let last = e;
        for (let k = 0; k < BACKOFF_MS.length && last && last.name === 'TypeError' && STALE(last.cause) && READ.test(w.path) && !(opts && opts.signal && opts.signal.aborted); k++) {
          const c = last.cause; if (BACKOFF_MS[k]) await new Promise(res => setTimeout(res, BACKOFF_MS[k]));
          try { r = await f0(url, opts); say(`${w.method} ${w.host}${w.path}: ${c.code || c.message} - retry ${k + 1} (${BACKOFF_MS[k] ? `after ${BACKOFF_MS[k]} ms` : 'at once, fresh connection'}): OK`); return r; }
          catch (e2) { say(`${w.method} ${w.host}${w.path}: ${c.code || c.message} - retry ${k + 1} (${BACKOFF_MS[k] ? `after ${BACKOFF_MS[k]} ms` : 'at once, fresh connection'}): failed (${(e2.cause && e2.cause.code) || e2.message})`); last = e2; }
        }
        throw tag(last, w);
      }
    };
    fx.__r152 = true; globalThis.fetch = fx;
  }
}
const tideWire = require('./lib/tideWire');   // TIDE r2 stage 1 (MacTide): the new model's wiring + lib/moneyRule.js (MacMoney); shipped tide.mode "off" (pure; lib/structure.js loads only when on)
const tideLive = require('./lib/tideLive');   // [2a] TIDE Stage 2a LIVE (MacLive): one TIDE position through the tideOrders r1.2 planner (tide.mode "live" + --live only)
const { fetchVixDaily } = require('./lib/vix');
const { VixFeed } = require('./lib/vixFeed');   // FIX1015: daily VIX refresh + age/failure flag
const { tradingDayKey } = require('./lib/dailyRisk');
const { createDayTracker, effectiveDayKey } = require('./lib/dayTracker'); // dashfix: DISPLAY-ONLY day tracker (rolling P&L = balance - start-of-day balance, day peak, wall-clock rollover)
const { getAccounts, getOpenPosition, getOpenOrders, placeOrder, cancelOrder, OrderType, OrderSide } = require('./lib/liveOrders');
const NP = require('./lib/notifyPolicy');   // 18f1: phone-push rules (tiers + UTC-day budget, status window, level-cross mode). NOTIFICATION ONLY: never read by an order, gate or size
const { LiveStateMachine, journalShowsTp1 } = require('./lib/liveStateMachine');
const { pendingStopTouch, fillSlipDecision } = require('./lib/pendingRules');
const stopFloor = require('./lib/stopFloor');   // entry stop floor (Mac 10/21; priority 6330144245): pure, shared with the state machine   // 10/16 pure rules shared with the state machine
const { NewsCalendar } = require('./lib/newsCalendar');   // 10/16 news awareness
const { noChaseDecision, noChaseText, atr14 } = require('./lib/noChase');   // 10/16 no-chase filter
const { stretchFeatures } = require('./lib/stretchCheck');   // np1 stretch check
const { srAreas: srAreasCompute, selectAreas: srAreasSelect, VERSION: SR_AREAS_VERSION } = require('./lib/srAreas');   // sr-areas r1 (lv1 r13.6.3): DISPLAY ONLY (own file + the phone); nothing in trading reads it
const { po3Compute, VERSION: PO3_VERSION } = require('./lib/po3');   // po3 r1.3: OBSERVE-ONLY (own file); nothing in trading reads it
const { sizeForRisk, maxStopPtsForOneLot, legSplit, target1Points: riskTarget1Points, legacyTarget1Points, runnerTrailOffset } = require('./lib/riskRules');   // 10/18 rules 1-3 (pure)
const { directionGate, banMatch, reclaimDecision, waveState, exhaustionReversal: exhaustionReversalCheck, trendState } = require('./lib/controlFilter');   // 10/18 rules 4-6 + trend regime / wave rule (pure)

const LIVE = process.argv.includes('--live');
// Running more than one instrument at once (2026-09-22) means more than one
// live-executor.js process shares this same /opt/mac-bot directory — every
// per-instance file has to be namespaced by symbol or two instances would
// silently clobber each other's snapshot/journal/flatten-request/log files.
const SYMBOL = (process.argv[2] || 'MNQ').toUpperCase();
const BIAS_SNAPSHOT_FILE = path.join(__dirname, `bias-snapshot-${SYMBOL}.json`);
// Manual-flatten signal (2026-09-22): mobile.html can't hold your real
// TopstepX credentials (it's deliberately read-only/credential-free), so it
// can't place an order itself. Instead its "Flatten Position" button POSTs
// to tmc-proxy.js, which just drops this file — the ONE thing a request
// carrying only the shared proxy key is trusted to do. This process (which
// already holds the real token) checks for it every poll cycle and executes
// the actual flatten itself. The file itself carries no authority beyond
// "a flatten was requested" — its mere existence is the whole signal.
const entryCancelQueue = require('./lib/entryCancelRequests').store(__dirname, SYMBOL);
const FLATTEN_REQUEST_FILE = path.join(__dirname, `flatten-request-${SYMBOL}.json`);
const PAUSE_REQUEST_FILE = path.join(__dirname, `pause-request-${SYMBOL}.json`);   // 10/16 manual pause: written by tmc-proxy.js POST /pause (same auth as /flatten)
const PAUSE_STATE_FILE = path.join(__dirname, `pause-state-${SYMBOL}.json`);       // 10/16 manual pause: { until } so a restart keeps the pause
const COOLDOWN_STATE_FILE = path.join(__dirname, `cooldown-state-${SYMBOL}${LIVE ? '' : '-paper'}.json`);   // final review N1: paper never shares the live file   // r9.7 review S2: running cooldowns (incl. the 15-min after-win floor) survive a restart
const DAY_STATE_FILE = path.join(__dirname, `day-state-${SYMBOL}.json`); // dashfix: start-of-day balance + day peak (display only), survives a restart
// Trade journal (2026-09-22): a durable, append-only record of WHY each
// real entry fired (MAC/Levels bias at that moment, source, grade) and
// whether a position was closed by the bot's own logic or a manual
// flatten — broker fills alone (what /api/Trade/search gives us) only ever
// show WHAT happened financially, never WHY. This is what lets "what's our
// most profitable setup" get answered from real data later instead of
// guessed at. One JSON object per line (JSONL) — never rewritten, only
// appended to, so a crash mid-write can't corrupt earlier entries.
const TRADE_JOURNAL_FILE = path.join(__dirname, `trade-journal-${SYMBOL}.jsonl`);
const SRA_JOURNAL_PREFIX = path.join(__dirname, `sr-areas-${SYMBOL}-`), SRA_ROW_MAX = 65536, SRA_DAY_MAX = 1024 * 1024, SRA_BUDGET_MS = 50;   // sr-areas r1 (lv1 r13.6.3): its own per-TradeDay file, bounded like the levels journal
const STOP_CAP_FILE = path.join(__dirname, `stop-cap-owned-${SYMBOL}.json`);   // lv1 r13.6.2c: the old stops the stop cap still owns (durable; see stopCapSave)
const PO3_JOURNAL_PREFIX = path.join(__dirname, `po3-journal-${SYMBOL}-`), PO3_ROW_MAX = 65536, PO3_DAY_MAX = 5 * 1024 * 1024, PO3_BUDGET_MS = 100, PO3_RUN_ID = `po3run-${Date.now().toString(36)}`;   // po3 r1.3 observer files (one per TradeDay; never the trade journal), bounds, run identity
// r9.10 (Mac 10/20: "It needs to log minute by minute levels so we can know that as well looking back at our trades"): one Levels PRO board
// row per minute, in its OWN daily file (PT date) so the trade journal stays small for the phone download. Journal only; never read back.
const levelsMinuteFile = ptDate => path.join(__dirname, `levels-minute-${SYMBOL}-${ptDate}.jsonl`);
let lastLevelsMinute = null;   // r9.10: module scope (the startup refresh runs before main's later declarations)
let latestLevelBoard = null;   // r9.14 entry-level journal: the last 15m Levels PRO level list ({ t, levels: [{ name, price }] }), refreshed every evaluation
const retestTaken = new Set(), retestKey = pf => `${pf.name}|${pf.price}|${pf.dir}|${pf.bornT}|${pf.tfMs}`;   // lv1 r13.2: break-retests already handed to the order machine (one trade per retest)
const levelEventTrackers = {};   // lv1 r3: one causal level-event tracker per trigger timeframe (lib/levelEvent.js createTracker), kept across polls
// lv1 r5 LEVELS JOURNAL (journal / display only; nothing here is read by a trading decision): lib/levelPanel.js builds the rows and the phone panel; they go to
// levels-journal-<SYMBOL>-<TradeDay>.jsonl ONLY (never the trade journal). Bounded: 256 KB per row, 40 MB per TradeDay (the day file's size is read, so the cap
// survives restarts); an unknown file size or any write error skips the row (fail closed, logged at most every 10 min); files are never deleted by the bot.
const { createLevelPanel, createExitIndex } = require('./lib/levelPanel');   // r13.1: createExitIndex = how a trade ended, for the phone (display only)
const LEVEL_JOURNAL_PREFIX = path.join(__dirname, `levels-journal-${SYMBOL}-`), LVJ_ROW_MAX = 262144, LVJ_DAY_MAX = 40 * 1024 * 1024;
const levelPanel = createLevelPanel({ ptMinutesFn: t => ptInfo(t).minutesOfDay, levelTFn: (n, t) => levelEvent.levelT(n, t) }), lvj = { day: null, file: null, bytes: null, rows: 0, capped: 0, fails: 0, errAt: 0 };
function lvjErr(e) { lvj.fails++; if (Date.now() - lvj.errAt > 600000) { lvj.errAt = Date.now(); try { log(`  [lv1] levels journal skipped a row (${e && (e.code || e.message) || e}); trading unaffected`); } catch (_) { /* log only */ } } }
function lvjDay(t) { const d = effectiveDayKey(t); if (d === lvj.day) return; const r = levelPanel.roll(d); lvj.day = d; lvj.file = `${LEVEL_JOURNAL_PREFIX}${new Date(d + 43200000).toISOString().slice(0, 10)}.jsonl`; lvj.bytes = null; if (r) { r.t = t; lvjWrite(r); } }
// [r1.2] snapshot.tide rows: today's lv_tide rows of the KEEP phases (MacUI-N contract), as journaled minus evidence / raw; <= 120 rows and <= 64 KB (the oldest
// non-signal row goes first). Only lv_tide rows touch it: with tide.mode off none are ever written.
const TIDE_KEEP = new Set(['restart', 'period', 'htf', 'control_form', 'setup_arm', 'setup_cancel', 'setup_expire', 'retest', 'rejection', 'grade_live', 'grade_no_trade', 'signal', 'shadow_exit', 'stopped_out', 'live_step', 'live_order', 'live_fill', 'live_end', 'live_result', 'live_alert', 'live_not_taken', 'live_guard', 'live_restart', 'rebuild',
  'startup', 'trend_arm', 'trend_signal', 'trend_skip', 'trend_idle', 'trend_tie', 'order_reject', 'live_order_reject', 'grade_waived']);   // [r1.6] + the process start row, the trend lane's rows (lib/trendLane.js), broker rejections (tideLive r1.2), aligned-pass waivers
const tideRowsRing = { day: null, rows: [], bytes: 0 };
function tideRowNote(row) {
  try { if (!row || row.type !== 'lv_tide' || !TIDE_KEEP.has(row.phase)) return; const d = lvj.day;
    if (tideRowsRing.day !== d) { tideRowsRing.day = d; tideRowsRing.rows = []; tideRowsRing.bytes = 0; }
    const { evidence, raw, ...r } = row, n = Buffer.byteLength(JSON.stringify(r)); if (n > 16384) return;
    tideRowsRing.rows.push(r); tideRowsRing.bytes += n;
    while (tideRowsRing.rows.length > 120 || tideRowsRing.bytes > 65536) { let i = tideRowsRing.rows.findIndex(x => x.phase !== 'signal'); if (i < 0) i = 0; tideRowsRing.bytes -= Buffer.byteLength(JSON.stringify(tideRowsRing.rows[i])); tideRowsRing.rows.splice(i, 1); }
  } catch (e) { /* display only */ }
}
// [r1.6] (Mac 11/05: "A restart shouldn't make the journal empty") the ring above is memory-only and starts empty after a restart. At startup, before the warm-up
// rebuild, today's TradeDay lv_tide rows are RELOADED from the on-disk journal file (read only; the file is never written here) into the ring, oldest first so the
// newest stay last, under the same 120-row / 64 KB cap, each tagged reloaded:true. snapshot.tide.day is a summary of the WHOLE day file (not the ring), read
// incrementally (only the bytes appended since the last read), refreshed at most every 30 s.
const TIDE_RELOAD_MAX = 8 * 1024 * 1024, TIDE_DAY_REFRESH_MS = 30000, TIDE_DAY_CHUNK_MAX = 8 * 1024 * 1024;
function tideJournalRead(file, from, maxBytes) {   // -> { text, end } : the file from byte `from` (whole lines only when from > 0: the first partial line is dropped), at most maxBytes from the END
  let fd = null;
  try { const size = fs.statSync(file).size; let start = Math.max(from, size - maxBytes); const len = size - start; if (len <= 0) return { text: '', end: size };
    fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len); const got = fs.readSync(fd, buf, 0, len, start); let text = buf.toString('utf8', 0, got);
    if (start > 0 && start !== from) text = text.slice(text.indexOf('\n') + 1); return { text, end: start + got }; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* closing */ } } }
}
const tideTradesReloaded = { day: null, trades: [] };   // [r1.6] (Mac 11/05: "TIDE 0 closed" after the restart) today's closed TIDE trades rebuilt from the journal's live_result (+ live_end) rows, reloaded:true
function tideRingReload() {   // today's lv_tide KEEP rows from lvj.file -> the ring, and the closed trades -> tideTradesReloaded (lvjDay(now) first). -> { rows, parsed, file, ring, bytes, trades }; never throws
  const out = { rows: 0, parsed: 0, file: lvj.file ? path.basename(lvj.file) : null, ring: 0, bytes: 0, trades: 0, laneTaken: [] };   // [r1.6.2] laneTaken: the TAKEN (not rebuilt) trend_signal times (unix sec) -> the lane's caps (trendLane.seed)
  try {
    tideTradesReloaded.day = lvj.day; tideTradesReloaded.trades = [];
    if (!lvj.file || !fs.existsSync(lvj.file)) return out;
    const { text } = tideJournalRead(lvj.file, 0, TIDE_RELOAD_MAX), ends = new Map();
    for (const line of text.split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch (e) { continue; } out.parsed++; if (!r || r.type !== 'lv_tide') continue;
      if (r.phase === 'live_end' && r.position) ends.set(String(r.position), r);
      if (r.phase === 'live_result' && r.position && Number.isFinite(r.qty)) { const e = ends.get(String(r.position)) || null;
        tideTradesReloaded.trades.push({ id: r.position, setup: null, signalId: r.take || null, dir: null, grade: null, qty: r.qty, avgEntry: r.entry ?? null, openedAt: null, closedAt: Number.isFinite(r.t) ? r.t : null, exitPath: null, exitAvgPx: null, resultR: r.r ?? null,
          grossUsd: r.usd ?? null, netUsd: Number.isFinite(r.netUsd) ? r.netUsd : e && Number.isFinite(e.realizedNetUsd) ? e.realizedNetUsd : null, realizedPts: r.pts ?? null, fees: r.fees ?? (e ? e.fees ?? null : null), path: r.path || null, realizedSource: r.pts != null ? 'calc' : 'journal', reloaded: true }); }
      if (r.phase === 'trend_signal' && r.taken === true && r.rebuilt !== true && Number.isFinite(r.t)) out.laneTaken.push(Math.floor(r.t / 1000));   // [r1.6.2] the 2/h 6/day caps survive the restart
      if (!TIDE_KEEP.has(r.phase)) continue; tideRowNote({ ...r, reloaded: true }); out.rows++; }
    const seen = new Set(); tideTradesReloaded.trades = tideTradesReloaded.trades.filter(t => { const k = String(t.id); if (seen.has(k)) return false; seen.add(k); return true; }).slice(-40);
  } catch (e) { out.error = String(e && e.message); }
  out.ring = tideRowsRing.rows.length; out.bytes = tideRowsRing.bytes; out.trades = tideTradesReloaded.trades.length; return out;
}
function tideTradesMerged(live) {   // the driver's own closed trades (tide-live state) + the reloaded ones it does not hold (by position id), oldest first
  const own = Array.isArray(live) ? live : [], ids = new Set(own.map(t => String(t && t.id)));
  const extra = tideTradesReloaded.day === lvj.day ? tideTradesReloaded.trades.filter(t => !ids.has(String(t.id))) : [];
  return [...extra, ...own].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
}
const tideDay = { file: null, off: 0, rem: '', at: 0, sum: null };
function tideDayBlank(tradeDay) { return { tradeDay, rows: 0, byPhase: {}, control: null, signals: { live: 0, taken: 0, replayed: 0 }, setups: { armed: 0, noTrade: 0, cancelled: 0 }, trend: { armed: 0, taken: 0, skipped: 0 }, trades: null, tradesWhy: 'no live_result row in the journal (no TIDE trade closed this TradeDay)', restarts: 0, readAt: null }; }
function tideDayNote(s, r) {   // one journal row into the day summary (lv_tide rows only)
  if (!r || r.type !== 'lv_tide' || typeof r.phase !== 'string') return;
  s.rows++; s.byPhase[r.phase] = (s.byPhase[r.phase] || 0) + 1;
  switch (r.phase) {
    case 'control_form': s.control = { dir: Number.isFinite(r.dir) ? r.dir : null, kind: r.kind || null, since: Number.isFinite(r.t) ? r.t : null }; break;
    case 'signal': if (r.shadow === false) s.signals.live++; if (r.rebuilt === true) s.signals.replayed++; else if (r.taken === true) s.signals.taken++; break;   // [r1.6] taken = taken:true and NOT rebuilt (the warm-up replay's rows place no order); rows / byPhase count every lv_tide row of the file, reloaded and rebuilt alike
    case 'setup_arm': s.setups.armed++; break;
    case 'grade_no_trade': s.setups.noTrade++; break;
    case 'setup_cancel': s.setups.cancelled++; break;
    case 'trend_arm': s.trend.armed++; break;
    case 'trend_signal': if (r.taken === true) s.trend.taken++; else s.trend.skipped++; break;
    case 'trend_skip': s.trend.skipped++; break;
    case 'live_result': { const t = s.trades || (s.trades = { closed: 0, won: 0, lost: 0, even: 0, netUsd: 0, grossUsd: 0, feesUsd: 0, feesKnown: 0 }); s.tradesWhy = null; t.closed++; const u = Number.isFinite(r.usd) ? r.usd : 0; if (u > 0) t.won++; else if (u < 0) t.lost++; else t.even++;
      t.grossUsd = Math.round((t.grossUsd + u) * 100) / 100; const f = Number.isFinite(r.fees) ? r.fees : 0; if (Number.isFinite(r.fees)) { t.feesUsd = Math.round((t.feesUsd + f) * 100) / 100; t.feesKnown++; } t.netUsd = Math.round((t.netUsd + u - f) * 100) / 100; break; }   // [r1.6] netUsd = gross - the fees the row carries (tideLive r1.2); older rows: gross
    case 'startup': s.restarts++; break;
    default: break;
  }
}
function tideDaySummary(now) {   // snapshot.tide.day from the WHOLE on-disk TradeDay journal, refreshed at most every 30 s, reading only what was appended
  try {
    if (!lvj.file) return null;
    const tradeDay = lvj.file.slice(-16, -6);
    if (tideDay.file !== lvj.file) { tideDay.file = lvj.file; tideDay.off = 0; tideDay.rem = ''; tideDay.at = 0; tideDay.sum = tideDayBlank(tradeDay); }
    if (now - tideDay.at < TIDE_DAY_REFRESH_MS) return tideDay.sum;
    tideDay.at = now;
    let size = 0; try { size = fs.statSync(tideDay.file).size; } catch (e) { if (e && e.code === 'ENOENT') { return tideDay.sum; } throw e; }
    if (size < tideDay.off) { tideDay.off = 0; tideDay.rem = ''; tideDay.sum = tideDayBlank(tradeDay); }   // the file shrank (replaced): read it again from the start
    if (size > tideDay.off) {
      const { text, end } = tideJournalRead(tideDay.file, tideDay.off, TIDE_DAY_CHUNK_MAX);
      const lines = (tideDay.rem + text).split('\n'); tideDay.rem = lines.pop(); tideDay.off = end;
      for (const line of lines) { if (!line) continue; let r; try { r = JSON.parse(line); } catch (e) { continue; } tideDayNote(tideDay.sum, r); }
    }
    tideDay.sum.readAt = now;
    return tideDay.sum;
  } catch (e) { return { tradeDay: lvj.file ? lvj.file.slice(-16, -6) : null, error: String(e && e.message) }; }
}
// [r1.2] write a file atomically: a temp file in the same folder, written + fsynced, then renamed over the target (a reader sees the old or the new file, never a
// partial one). The bytes written are exactly the bytes given.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`; let fd = null;
  try { fd = fs.openSync(tmp, 'w'); fs.writeSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; fs.renameSync(tmp, file); }
  catch (e) { if (fd != null) { try { fs.closeSync(fd); } catch (e2) { /* closing */ } } try { fs.unlinkSync(tmp); } catch (e3) { /* gone */ } throw e; }
}
function lvjWrite(row) {
  if (!row) return false;
  if (dayCtxHook && (row.type === 'lv_block' || (row.type === 'lv_event' && row.phase === 'born'))) { try { row = { ...row, context: dayCtxHook(row.dir, Number.isFinite(row.entry) ? row.entry : null) }; } catch (e) { /* log only */ } }   // lv1 r13.3.7: the day-type context (log only)
  try {
    const line = JSON.stringify(row) + '\n', n = Buffer.byteLength(line);
    if (lvj.bytes == null) { try { lvj.bytes = fs.statSync(lvj.file).size; } catch (e) { if (e && e.code === 'ENOENT') lvj.bytes = 0; else { lvjErr(e); return false; } } }
    if (n > LVJ_ROW_MAX || lvj.bytes + n > LVJ_DAY_MAX) { lvj.capped++; return false; }
    if (row.type === 'lv_tide') tideRowNote(row);   // [r1.2] snapshot.tide rows (lv_tide only)
    fs.appendFileSync(lvj.file, line); lvj.bytes += n; lvj.rows++; return true;
  } catch (e) { lvjErr(e); return false; }
}
// lv1 r11 SAVED REPLAYS (Mac 10/28: "make sure my replay trades are stored somewhere I can review them even after a bot restart or update"): every
// lv_replay row (a trade's self-contained replay record, from lib/levelPanel.js) is appended to trade-replays-<SYMBOL>.jsonl next to the bot - a file no
// update replaces - and read back once at start-up (newest row per trade). Bounded: 1 MB per row; past 24 MB the file is rewritten with the newest 300
// trades (the previous file is kept as .prev). Display only; any error skips the row (fail closed, logged at most every 10 min).
const TRADE_REPLAY_FILE = path.join(__dirname, `trade-replays-${SYMBOL}.jsonl`), REPLAY_ROW_MAX = 1048576, REPLAY_FILE_MAX = 24 * 1024 * 1024, REPLAY_READ_MAX = 96 * 1024 * 1024;
const lvReplay = { loaded: false, bytes: null, saved: 0, rows: 0 };
function lvReplayCompact() { const tmp = TRADE_REPLAY_FILE + '.tmp'; fs.writeFileSync(tmp, levelPanel.savedRows().map(r => JSON.stringify(r) + '\n').join('')); try { fs.renameSync(TRADE_REPLAY_FILE, TRADE_REPLAY_FILE + '.prev'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } fs.renameSync(tmp, TRADE_REPLAY_FILE); lvReplay.bytes = fs.statSync(TRADE_REPLAY_FILE).size; }
function lvReplayBoot() {
  lvReplay.loaded = true;
  try {
    let size; try { size = fs.statSync(TRADE_REPLAY_FILE).size; } catch (e) { if (e && e.code === 'ENOENT') { lvReplay.bytes = 0; return; } throw e; }
    if (size > REPLAY_READ_MAX) { log(`  [lv1] trade replays: ${TRADE_REPLAY_FILE} is ${Math.round(size / 1048576)} MB - not loaded (left as is); new trades still saved`); lvReplay.bytes = size; return; }
    const m = new Map(); let bad = 0;
    for (const line of fs.readFileSync(TRADE_REPLAY_FILE, 'utf8').split('\n')) { if (!line) continue; try { const r = JSON.parse(line); if (r && r.type === 'lv_replay' && r.rec && typeof r.rec.key === 'string') { m.delete(r.rec.key); m.set(r.rec.key, r.rec); } else bad++; } catch (e) { bad++; } }
    lvReplay.saved = levelPanel.loadSaved([...m.values()]); lvReplay.bytes = size;
    log(`  [lv1] trade replays: ${lvReplay.saved} saved trade(s) loaded from ${path.basename(TRADE_REPLAY_FILE)}${bad ? ` (${bad} unreadable line(s) skipped)` : ''}`);
    if (size > REPLAY_FILE_MAX) lvReplayCompact();
  } catch (e) { lvjErr(e); }
}
function lvReplayWrite(row) {
  try {
    const line = JSON.stringify(row) + '\n', n = Buffer.byteLength(line); if (n > REPLAY_ROW_MAX) { lvj.capped++; return false; }
    if (lvReplay.bytes == null) { try { lvReplay.bytes = fs.statSync(TRADE_REPLAY_FILE).size; } catch (e) { if (e && e.code === 'ENOENT') lvReplay.bytes = 0; else throw e; } }
    if (lvReplay.bytes + n > REPLAY_FILE_MAX) lvReplayCompact(); else { fs.appendFileSync(TRADE_REPLAY_FILE, line); lvReplay.bytes += n; }
    lvReplay.rows++; return true;
  } catch (e) { lvjErr(e); return false; }
}
function lvjTracker(k, out, tr) { try { const t = Date.now(); lvjDay(t); const tf = { M5: '5m', M3: '3m' }[k] || k; if (out.scan) lvjWrite(levelPanel.scan(tf, out.scan, t)); for (const r of levelPanel.eventState(tf, out, tr.state(), t)) lvjWrite(r); } catch (e) { lvjErr(e); } }
// lv1 r12.6: a board's levels-only trigger direction after the HTF-direction rule (lib/signal.js levelsAlignWithTrade): a trigger against the alignment ranks as no trigger
function lvTradeDir(l) { const d = levelsTriggerInfo(l, CONFIG).dir; return d !== 0 && CONFIG.levelsOnlyEntries && CONFIG.requireLevelsAlignment && CONFIG.levelsAlignWithTrade && d !== levelEvent.alignDir(l, levelEvent.alignRequired(CONFIG)) ? 0 : d; }
// lv1 r12.6 (Mac 10/28: "why with price being so bullish is the bot ready to short?"): the entry gates' current reading for the armed-levels radar - the same reads as
// lib/signal.js and the checklist rows (HTF alignment direction, 15m control). Display only.
function lvjGate(lv) {
  const ctl = CONFIG.controlDirectionGate || CONFIG.standdownWeek1 ? controlDisplaySnapshot(lv) : null;
  return { htf: CONFIG.requireLevelsAlignment ? { dir: levelEvent.alignDir(lv, levelEvent.alignRequired(CONFIG)), status: lv && lv.alignmentStatus || null, text: lv && (lv.alignText || lv.tfAlign) || null, withTrade: CONFIG.levelsAlignWithTrade === true } : null,
    control: ctl ? { known: !!ctl.valid, side: ctl.valid ? ctl.side : null, score: Number.isFinite(ctl.score) ? Math.round(ctl.score * 1000) / 1000 : null, min: ctl.threshold, exempt: CONFIG.levelEventControl === 'exempt', contestedMinSize: CONFIG.controlContestedMinSize === true } : null };
}
function lvjDecision(lv, checklist) { try { const t = Date.now(); lvjDay(t); for (const r of levelPanel.decision(lv, checklist, t, lvjGate(lv))) lvjWrite(r); } catch (e) { lvjErr(e); } }   // r12.6: + the radar's gate reading
function lvjBlock(code, dir, data) { try { const t = Date.now(); lvjDay(t); lvjWrite(levelPanel.block(code, dir, data, t)); } catch (e) { lvjErr(e); } }
function lvjAttempt(proof, info) { try { if (!proof) return; const t = Date.now(); lvjDay(t); lvjWrite(levelPanel.attempt(proof, info, t)); } catch (e) { lvjErr(e); } }
function lvjHanded(proof, info) { try { if (!proof) return; const t = Date.now(); lvjDay(t); lvjWrite(levelPanel.handed(proof, info, t)); } catch (e) { lvjErr(e); } }
function lvjOrder(journalId, stage, info) { try { if (!journalId) return; const t = Date.now(); lvjDay(t); lvjWrite(levelPanel.orderUpdate(journalId, stage, info || {}, t)); } catch (e) { lvjErr(e); } }   // lv1 r6: order progress by journalId (journal only)
let lvReqStart = NaN;   // lv1 r3: when THIS poll's bars were requested (stamped right before the fetch) - level-event completion is judged against it
const noChaseDiagnosticBoards = new WeakMap(); // journal only: per-evaluation identity, never an admission input (MacDot no-chase diagnostic; module scope for start-up order)
let lastDerivedPeriods = [];   // r9.10: current-period bars rebuilt from finer bars on the latest poll (lib/currentPeriod.js), journaled per minute
const { completeCurrentPeriods } = require('./lib/currentPeriod');
// Journal metadata r1.2 (Mac-approved spec; journal only): build/settings stamp, level board, evaluation snapshot, block ids, versioned plan outcomes
const journalMeta = require('./lib/journalMeta');
const journalRunId = require('crypto').randomUUID();   // one id per process run; board references are { runId, boardSeq }
let journalStampId = null;      // set after the effective settings are final; carried on later rows
let boardTracker = null;        // created on the first evaluation with the contract's tick
const planTerminals = journalMeta.createPlanTerminals();
const journalMetaErrors = journalMeta.createMetaErrors();
const evalSnapshots = new WeakMap();   // Levels row consumed by a decision -> its evaluation snapshot
const evalBoards = new WeakMap();   // r1.3: Levels evaluation -> ITS board result { runId, boardSeq, status } (MacDot 6328545796 #1)
let latestEvalBoard = null;   // r1.3: the most recent evaluation's board result, for rows that carry no evaluation (trade_plan / trade_block / entry)
const JOURNAL_META_TYPES = new Set(journalMeta.META_TYPES);
// Metadata rows go to the journal FILE only (never the bounded economic history/index) and report whether they were persisted; module scope so a
// warm-up evaluation (before main() initialises journalHistory) can write them without touching any later-declared binding.
function persistJournalMeta(row) { try { fs.appendFileSync(TRADE_JOURNAL_FILE, JSON.stringify(row) + '\n'); return true; } catch (_) { return false; } }
const TRADE_STATE_FILE = path.join(__dirname, `trade-state-${SYMBOL}.json`);   // FIX1015: the open trade's state, saved on every change and resumed after a restart

// ── JOURNAL-BROKER RECONCILE HELPERS (begin) ── (2026-10-12, journal stats fix)
// The 'closed' journal row is written the instant the bot sees FLAT, with exitPrice = the last 1m close and a P&L computed from it
// (no fees, every contract priced at that one close) - an ESTIMATE. The broker's Trade/search fills are the real numbers (what the
// dashboard's Recent Trades list shows). These pure helpers match a journal trade to its broker round trip so live-executor.js can
// APPEND one corrected 'closed' row (same journalId, pnlSource:'broker'); the file is never rewritten. Display/journal only - nothing
// here is read by any entry, exit or risk decision.
const JOURNAL_MATCH_WINDOW_MS = 5 * 60 * 1000;       // entry time tolerance, same as enrichTradesWithJournal()
const JOURNAL_RECONCILE_GIVEUP_MS = 30 * 60 * 1000;  // live path: stop retrying this long after the close; the row stays an estimate
const JOURNAL_BACKFILL_TRADING_DAYS = 30;            // startup backfill window (fix 4: 30 trading days so the All-Time box can be broker-based back to the journal start)

// Product part of a contract id ('CON.F.US.MNQ.Z25' -> 'CON.F.US.MNQ'), so a quarterly roll inside the backfill window still matches.
function contractProduct(cid) { return typeof cid === 'string' && cid.includes('.') ? cid.split('.').slice(0, -1).join('.') : cid; }

// 2026-10-12 fix 4: journal trades that were FILLED ('traded') but never got a 'closed' or 'canceled' row - e.g. the bot restarted
// mid-trade, so the new process adopted the position without knowing its journalId and the close was never written. Newest last.
// fix 5: each item also carries entryPrices/entryTimes (the 'traded' row price PLUS the real fill price of any state-machine 'entry'
// event within 5 min - a MARKET row only holds the signal-time price) and peakUnrealized (from the trade's own peak_unrealized event),
// so the caller can match the adopted position / the broker round trip against the real fill.
function findOpenJournalTrades(events, sinceMs = 0) {
  const groups = new Map();
  const entryEvents = [], peakEvents = [];
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'entry') { entryEvents.push(e); continue; }
    if (e.type === 'peak_unrealized') { peakEvents.push(e); continue; }
    if (e.type !== 'signal_check' || !e.journalId) continue;
    if (!groups.has(e.journalId)) groups.set(e.journalId, []);
    groups.get(e.journalId).push(e);
  }
  const open = [];
  const allTraded = [];
  for (const rows of groups.values()) { const t2 = rows.filter(r => r.outcome === 'traded'); if (t2.length) allTraded.push(t2[t2.length - 1]); }
  for (const [journalId, rows] of groups) {
    if (rows.some(r => r.outcome === 'closed' || r.outcome === 'canceled')) continue;
    const traded = rows.filter(r => r.outcome === 'traded');
    if (!traded.length) continue;
    const tr = traded[traded.length - 1];
    if (tr.t < sinceMs) continue;
    const entryPrices = [], entryTimes = [tr.t];
    if (tr.entryPrice != null) entryPrices.push(tr.entryPrice);
    for (const en of entryEvents) {
      if (en.dir !== tr.dir || en.entryPrice == null || Math.abs(en.t - tr.t) >= JOURNAL_MATCH_WINDOW_MS) continue;
      // an 'entry' event belongs to the NEAREST same-direction 'traded' row of any trade, so a never-filled signal cannot borrow the
      // fill of a different trade that happened a minute later
      const nearer = allTraded.some(o => o !== tr && o.dir === en.dir && Math.abs(o.t - en.t) < Math.abs(tr.t - en.t));
      if (nearer) continue;
      entryPrices.push(en.entryPrice); entryTimes.push(en.t);
    }
    // the trade's own peak_unrealized (written once when the position resets): same direction, entry price = one of the prices
    // above (within a tick), after the entry and within 36 h - the same rule enrichTradesWithJournal() uses for Recent Trades.
    const pk = peakEvents.filter(p => p.dir === tr.dir && p.t >= tr.t - 60000 && p.t - tr.t < 36 * 3600 * 1000 && p.peakUnrealized != null
      && entryPrices.some(x => Math.abs(x - p.entryPrice) < 0.26)).sort((x, y) => x.t - y.t)[0];
    open.push({ journalId, dir: tr.dir, entryPrice: tr.entryPrice, entryPrices, entryTimes, contracts: tr.contracts, source: tr.source, grade: tr.grade,
      t: rows[0].t, tradedT: tr.t, peakUnrealized: pk ? pk.peakUnrealized : null });
  }
  return open.sort((a, b) => a.tradedT - b.tradedT);
}

// fix 5: an open-without-close journal trade as a reconcile candidate. NOTHING is written for it: closedRow is a synthetic, in-memory
// row (never appended); only a broker-confirmed 'closed' row built from it (buildBrokerClosedRow) or, much later, a 'canceled' row
// ever reaches the journal. exitTime is unknown, so the entry time stands in (only used to break ties between two broker trips).
function openTradeToCandidate(o, nowMs) {
  return { journalId: o.journalId, dir: o.dir, entryPrices: o.entryPrices.slice(), entryTimes: o.entryTimes.slice(), exitTime: o.tradedT, fromOpenTrade: true, tradedT: o.tradedT,
    closedRow: { type: 'signal_check', t: nowMs, journalId: o.journalId, outcome: 'closed', dir: o.dir, source: o.source, grade: o.grade, contracts: o.contracts,
      exitPrice: null, exitTime: null, realizedPnl: null, peakUnrealized: o.peakUnrealized, pnlSource: 'estimate', closedBy: 'restart-reconcile',
      reason: 'closed while no bot process was tracking it (restart); numbers from the broker fills' } };
}

// Every journalId that has a 'closed' row but no broker-confirmed one, with what is needed to find its broker round trip.
// events = parsed journal lines (file order). sinceMs filters on the close time.
function collectJournalReconcileCandidates(events, sinceMs = 0) {
  const groups = new Map();
  const entryEvents = [];
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'entry') { entryEvents.push(e); continue; }
    if (e.type !== 'signal_check' || !e.journalId) continue;
    if (!groups.has(e.journalId)) groups.set(e.journalId, []);
    groups.get(e.journalId).push(e);
  }
  const confirmed = new Set(), usedBrokerKeys = new Set(), candidates = [];
  for (const [journalId, rows] of groups) {
    const broker = rows.filter(r => r.outcome === 'closed' && r.pnlSource === 'broker');
    if (broker.length) { confirmed.add(journalId); for (const b of broker) if (b.brokerTradeKey) usedBrokerKeys.add(b.brokerTradeKey); continue; }
    const closed = rows.filter(r => r.outcome === 'closed');
    if (!closed.length) continue;
    const closedRow = closed[0]; // the original estimate
    const exitTime = closedRow.exitTime || closedRow.t;
    if (exitTime < sinceMs) continue;
    const opened = rows.filter(r => r.outcome === 'traded');
    const openRow = opened[opened.length - 1] || rows.find(r => r.outcome === 'pending');
    if (!openRow) continue; // no entry info at all - cannot match safely
    const entryTimes = [openRow.t], entryPrices = [];
    if (openRow.entryPrice != null) entryPrices.push(openRow.entryPrice);
    // the state machine's own 'entry' event carries the REAL fill price (a MARKET row above only has the signal-time price)
    for (const en of entryEvents) {
      if (en.dir === closedRow.dir && Math.abs(en.t - openRow.t) < JOURNAL_MATCH_WINDOW_MS && en.t <= exitTime && en.entryPrice != null) {
        entryPrices.push(en.entryPrice); entryTimes.push(en.t);
      }
    }
    candidates.push({ journalId, dir: closedRow.dir, entryPrices, entryTimes, exitTime, closedRow });
  }
  return { candidates, confirmed, usedBrokerKeys };
}

function brokerTradeKey(t) { return `${t.contractId}|${t.entryTime}`; }
// fix 5: the stored key is an exact string compare; two spellings of one timestamp ('...19Z' vs '...19.000000+00:00') must still count as
// the same broker trade, or one broker trade could be attached to two journal trades. Compared as product|epoch-ms.
function normBrokerKey(k) {
  const i = typeof k === 'string' ? k.indexOf('|') : -1;
  if (i < 0) return k;
  const ms = Date.parse(k.slice(i + 1));
  return Number.isNaN(ms) ? k : `${contractProduct(k.slice(0, i))}|${ms}`;
}

// Finds the CLOSED broker round trip (computeRecentTrades() output) for one candidate: same direction, entry price within a tick
// (first fill or entry VWAP), entry time within 5 min, not already attached to another journalId. Several -> closest exit time.
function matchBrokerTradeForJournal(cand, trades, usedKeys, tickSize = 0.25) {
  const tol = tickSize + 0.01;
  const usedNorm = new Set([...usedKeys].map(normBrokerKey));
  let best = null, bestGap = Infinity;
  for (const t of trades) {
    if (!t || !t.closed || t.dir !== cand.dir || usedKeys.has(brokerTradeKey(t)) || usedNorm.has(normBrokerKey(brokerTradeKey(t)))) continue;
    const entryMs = new Date(t.entryTime).getTime();
    if (!cand.entryTimes.some(x => Math.abs(x - entryMs) < JOURNAL_MATCH_WINDOW_MS)) continue;
    const prices = [t.entryPrice, t.entryAvgPrice].filter(p => p != null);
    if (!cand.entryPrices.some(jp => prices.some(bp => Math.abs(jp - bp) < tol))) continue;
    const gap = Math.abs(new Date(t.exitTime).getTime() - cand.exitTime);
    if (gap < bestGap) { best = t; bestGap = gap; }
  }
  return best;
}

// The corrected row: a copy of the original estimate (same journalId/context) with the broker's exit, P&L and fees.
function buildBrokerClosedRow(closedRow, t, nowMs, via) {
  const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
  return {
    ...closedRow,
    t: nowMs,
    exitPrice: t.exitPrice != null ? Math.round(t.exitPrice * 10000) / 10000 : closedRow.exitPrice,
    exitTime: new Date(t.exitTime).getTime(),
    realizedPnl: r2(t.pnl), grossPnl: r2(t.grossPnl), fees: r2(t.fees),
    commissions: t.commissions != null ? r2(t.commissions) : null, netPnl: t.netPnl != null ? r2(t.netPnl) : null,   // 10-18u2: broker NET (= Topstep's per-trade net); realizedPnl stays gross - fees (the reconciled journal basis)
    pnlSource: 'broker',
    estimatedPnl: closedRow.realizedPnl ?? null, estimatedExitPrice: closedRow.exitPrice ?? null,
    brokerEntryPrice: t.entryAvgPrice ?? t.entryPrice, brokerEntryTime: new Date(t.entryTime).getTime(), brokerContracts: t.maxSize,
    brokerTradeKey: brokerTradeKey(t), reconciledVia: via, reconciledAt: nowMs,
    feeModel: 'all-fills', // fix 5: fees = every fill of the round trip (rows written before fix 5 lack this field: exit-side fees only)
  };
}

// fix 5 fee re-correction: the latest broker row of each journalId that was built with the OLD fee model (no feeModel field = exit-side fees
// only). sinceMs filters on the close time. Returns the rows (file order = oldest first).
function collectFeeRecorrectionCandidates(events, sinceMs = 0) {
  const latest = new Map();
  for (const e of events) {
    if (e && e.type === 'signal_check' && e.outcome === 'closed' && e.pnlSource === 'broker' && e.journalId) latest.set(e.journalId, e);
  }
  return [...latest.values()].filter(r => r.feeModel !== 'all-fills' && r.brokerTradeKey && r.fees != null && r.grossPnl != null && (r.exitTime || r.t) >= sinceMs);
}
// The superseding row for such a candidate, or null when nothing changes (same fee total, or the broker trip is not the one the row was
// built from: gross P&L must agree to the cent). Same journalId; everything else is copied from the row it supersedes.
function buildFeeRecorrectionRow(row, t, nowMs) {
  const r2 = v => Math.round(v * 100) / 100;
  if (!t || !t.closed || Math.abs(r2(t.grossPnl) - row.grossPnl) > 0.011) return null;
  const fees = r2(t.fees);
  if (Math.abs(fees - row.fees) < 0.005) return null;
  return { ...row, t: nowMs, fees, grossPnl: r2(t.grossPnl), realizedPnl: r2(t.grossPnl - t.fees), feeModel: 'all-fills', reconciledVia: 'fee-recorrection', reconciledAt: nowMs,
    previousFees: row.fees, previousRealizedPnl: row.realizedPnl };
}

// fix 5 (display only): the day's realized P&L the phone shows = net of every CLOSED broker round trip of the day, fees over ALL fills -
// the same numbers and the same convention the journal's broker rows (and so the Journal Daily box) use. Not read by any risk decision.
function sumClosedRoundTripNet(trips) {
  let sum = 0;
  for (const t of trips || []) if (t && t.closed) sum += Math.round(t.pnl * 100) / 100;
  return Math.round(sum * 100) / 100;
}

// dashfix (display only): the day's realized net as TopstepX computes it = closed round trips, minus the costs the fills did not carry (see extraCost
// in computeRecentTrades: $0.36 fee per contract-side when absent, $0.25 commission per contract-side when absent). 10/13: 1,912.00 - 152.50 = 1,759.50.
function sumClosedRoundTripNetAllCosts(trips) {
  let sum = 0;
  for (const t of trips || []) if (t && t.closed) sum += Math.round((t.pnl - (t.extraCost || 0)) * 100) / 100;
  return Math.round(sum * 100) / 100;
}
// DashT 10/28 (display only): the TradeDay totals over EVERY closed round trip (the snapshot's recentTrades lists only the last 10). net is the same sum as
// sumClosedRoundTripNetAllCosts (= dayPnlNet), gross the fills' P&L, sides 2 x exit size - so the phone's gross / costs / net cover the whole TradeDay.
function dayTripTotals(trips, dayKey) {
  let n = 0, gross = 0, sides = 0;
  for (const t of trips || []) if (t && t.closed) { n++; gross += Number(t.grossPnl) || 0; sides += 2 * (Number(t.exitSize) || Number(t.maxSize) || 0); }
  return { dayKey, n, gross: Math.round(gross * 100) / 100, sides, net: sumClosedRoundTripNetAllCosts(trips) };
}

// Start of the trading day JOURNAL_BACKFILL_TRADING_DAYS sessions back (Friday-evening/Saturday keys are not trading days).
function journalBackfillSinceMs(nowMs, days, dayKeyFn) {
  const wd = k => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(new Date(k));
  let k = dayKeyFn(nowMs), counted = 1, guard = 0;
  while (counted < days && guard++ < 40) { k = dayKeyFn(k - 1); if (wd(k) !== 'Fri' && wd(k) !== 'Sat') counted++; }
  return k;
}
// ── JOURNAL-BROKER RECONCILE HELPERS (end) ──

// ── ENTRY-GUARD HELPERS (begin) ── (entryfix hotfix 1, 2026-10-13) pure functions, unit-tested in smoke-test-entryfix-hotfix.js
// CONFIG.reentryCooldown blocks a new entry in the SAME direction as a just-STOPPED (losing) trade until the next cooldown candle (reentryCooldownCandleMin, 5 or 15 min) has closed.
// (The RSI reversal scalp this was first written for was REMOVED from the bot on 2026-10-13: no tested stack of guards gave it an edge.)
const ENTRY_BAR_MS = 15 * 60 * 1000;
// 10/18 RULE 7: the Asia blackout end minute, or null when the blackout is switched off (asiaBlackout false); inAsiaBlackout(ts, null) is false.
function asiaBlockMinutes(cfg) { return cfg && cfg.asiaBlackout === false ? null : cfg ? cfg.asiaBlockUntilMinutes : null; }
function nextBarCloseMs(tsMs) { return Math.floor(tsMs / ENTRY_BAR_MS) * ENTRY_BAR_MS + ENTRY_BAR_MS; }
// Returns { dir, t, until, kind } for a stop-out at exitMs; the block lasts until the close of the Nth cooldown candle after the exit (N = reentryCooldownBars, min 1).
// 10/16: candle-based only (owner decision: no timer floor). extra = { win, tradeDir } for a cooldown after a win.
// 10/19 (Mac: "my cooldown period is too long ... it should be the end of the 5min candle instead of 15min"): the cooldown candle is
// cfg.reentryCooldownCandleMin, 5 or 15 (anything else = 15). Only the cooldown uses it; the level ban, reclaim window and dead-plan expiry stay on 15m.
function cooldownCandleMs(cfg) { return (cfg && Number(cfg.reentryCooldownCandleMin) === 5 ? 5 : 15) * 60 * 1000; }
function cooldownTfLabel(cfg) { return cooldownCandleMs(cfg) === 300000 ? '5m' : '15m'; }
// r9.7 AFTER-A-WIN FLOOR (journal 10/12-10/19, 86 broker trades): a re-entry filled 0-10 min after a WIN went 4W/11L, -$3,308 (after a LOSS, 0-15 min: +$422).
// A win's cooldown therefore ends no sooner than cfg.reentryWinMinMinutes after the exit (0 = off = candle rule only). Losses keep the candle rule.
// r9.7 review S1: how a cooldown end is worded: "15 min after the win, at" when the after-win floor sets it, else "the 5m candle closes at".
// r9.14 ENTRY LEVEL (Mac 10/21: "I need that notated in the journal ... so we can know which levels work the best for us"). Journal only:
// every entry records the level it was taken at. basis 'trigger' = the level the signal fired off (levelContext: Levels in-play level or the
// MAC pullback level); 'nearest' = no trigger level (e.g. a MAC market entry), so the closest Levels PRO level to the planned entry, which says
// nothing about why the trade was taken; 'none' = no level board. distancePts = (planned entry - level price) x direction: + = the entry sits on
// the trade's side of the level (above it for a long, below it for a short). The fill's own distance is entryPrice on the same 'entry' row.
function levelBoardFrom(lv, t) {
  if (!lv || !Array.isArray(lv.levels)) return null;
  return { t, levels: lv.levels.filter(L => L && typeof L.name === 'string' && L.name && Number.isFinite(L.price)).map(L => ({ name: L.name, price: L.price })) };
}
function entryLevelFor(dir, entryPrice, levelContext, board, nowMs) {
  const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  const levels = board && Array.isArray(board.levels) ? board.levels : [];
  const boardAgeMs = board && Number.isFinite(board.t) ? Math.max(0, nowMs - board.t) : null;
  const named = levelContext && typeof levelContext.name === 'string' && levelContext.name ? levelContext.name : null;
  const out = (basis, name, price, behavior) => ({ basis, name, price: r2(price), behavior: behavior ?? null, plannedEntry: r2(entryPrice),
    distancePts: Number.isFinite(price) && Number.isFinite(entryPrice) && (dir === 1 || dir === -1) ? r2((entryPrice - price) * dir) : null, boardAgeMs });
  if (named) {
    const own = Number.isFinite(levelContext.price) ? levelContext.price : null;
    const onBoard = levels.find(L => L.name === named);
    return out('trigger', named, own != null ? own : onBoard ? onBoard.price : null, levelContext.behavior);
  }
  if (!Number.isFinite(entryPrice)) return out('none', null, null, null);
  let pick = null;
  for (const L of levels) if (!pick || Math.abs(L.price - entryPrice) < Math.abs(pick.price - entryPrice)) pick = L;
  return pick ? out('nearest', pick.name, pick.price, null) : out('none', null, null, null);
}
function cooldownEndText(cfg, rec) { return rec && rec.winFloorMin ? `${rec.winFloorMin} min after the win, at` : rec && rec.sameDirBlockMin ? `the ${rec.sameDirBlockMin}m candle closes at` : `the ${cooldownTfLabel(cfg)} candle closes at`; }   // r1.11
function buildStopOut(cfg, dir, exitMs, kind, extra = {}) {
  const bars = Math.max(1, Math.floor(Number(cfg.reentryCooldownBars)) || 1), ms = cooldownCandleMs(cfg);
  let until = Math.floor(exitMs / ms) * ms + ms + (bars - 1) * ms;
  const floorMin = extra.win ? Math.min(120, Number(cfg.reentryWinMinMinutes)) : 0,   // review N1: at most 120 min, so a typo cannot block entries for days
    floored = floorMin > 0 && exitMs + floorMin * 60000 > until;
  if (floored) until = exitMs + floorMin * 60000;
  return { dir, t: exitMs, until, kind, ...extra, ...(floored ? { winFloorMin: floorMin } : {}) };
}
// 10/16 COOLDOWN AFTER A WIN (CONFIG.reentryCooldownAfterWin, default false): which directions a closed WIN blocks ('same' = the trade's own direction, 'both').
function winCooldownDirs(cfg, dir) { return !cfg.reentryCooldown || !cfg.reentryCooldownAfterWin || dir == null ? [] : cfg.reentryCooldownScope === 'both' ? [1, -1] : [dir]; }   // reentryCooldown false = the whole cooldown is off
// null when entering `dir` at nowMs is allowed, otherwise the stop-out record that blocks it. `stopOuts` keeps ONE record per direction ({1: rec, -1: rec}),
// so a stop-out in the other direction can never overwrite (and so lift) this direction's block. Opposite direction is never blocked.
function reentryBlockedBy(cfg, stopOuts, dir, nowMs) {
  if (!cfg.reentryCooldown || !stopOuts) return null;
  const rec = stopOuts[dir];
  return (rec && nowMs < rec.until) ? rec : null;
}
// What counts as a stop-out (QA decision C1): only a LOSING close; a target win never starts a cooldown.
// Market/timeout/manual exits: a stop-out only if the close was NOT in profit versus the entry (unknown prices -> stop-out).
function closedAtLoss(dir, entryPrice, closePrice) {
  if (entryPrice == null || closePrice == null || !Number.isFinite(entryPrice) || !Number.isFinite(closePrice)) return true;
  return !(dir * (closePrice - entryPrice) > 0);
}
// lv1 r13.3.4 sf1 (pure): the contracts an exit ORDER closed and that order's own price, from the FSM's journal row and the FSM itself at that moment (before
// its reset): the planned stop (or the profit-lock stop when that one is tighter - the FSM's own STOP_FILLED text), the TP1 / TP2 limit, break-even, the
// runner's trail stop. The bot never sees the broker's fill price at that moment (the broker-confirmed row follows), so the order's price is the estimate;
// an older poll price is never used for an exit order. fin = this fill closed the position. null = not an exit-order row (or nothing new).
function exitFillOf(code, sm, row) {
  if (!sm || (sm.dir !== 1 && sm.dir !== -1)) return null;
  const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null), dir = sm.dir, n = sm.contracts, l1 = sm.leg1Size, l2 = sm.leg2Size, r = row || {};
  if (code === 'STOP_FILLED') {
    const st = fin(sm.stopPriceIntended), lock = sm.profitTrail ? fin(sm.profitTrailStop) : null;
    const px = st == null ? lock : lock == null ? st : dir === 1 ? Math.max(st, lock) : Math.min(st, lock);
    return [{ c: n, px, src: lock != null && px === lock && px !== st ? 'profit-lock stop' : 'planned stop', fin: true }];
  }
  if (code === 'TP1_FILLED') return [{ c: r.whole ? n : l1, px: fin(sm.target1), src: 'TP1 limit', fin: !!r.whole }];
  if (code === 'TP1_PARTIAL') return [{ c: r.filled, px: fin(sm.target1), src: 'TP1 limit', fin: false }];
  if (code === 'TP2_OR_BE') return [r.viaTarget ? { c: l2, px: fin(sm.target2), src: 'TP2 limit', fin: false } : { c: l2, px: fin(sm.entryPrice), src: 'break-even stop', fin: false }];
  if (code === 'RUNNER_STOPPED') return [{ c: n - l1 - l2, px: fin(r.stop), src: 'runner trail stop', fin: false }];
  if (code === 'POSITION_CLOSED' && r.phase === 'LEG3_OPEN') return [{ c: n - l1 - l2, px: fin(sm.trailStop), src: 'runner trail stop', fin: true }];
  if (code === 'POSITION_CLOSED' && r.phase === 'LEG23_OPEN') {   // the last legs in one poll: the runner at its trail stop; a leg 2 still resting could be TP2 or break-even
    const out = [];
    if (sm.stopOrderId != null && l2 > 0) out.push({ c: l2, px: null, src: 'leg 2: TP2 or break-even (both gone in one poll)', fin: false });
    if (sm.leg3StopOrderId != null && n - l1 - l2 > 0) out.push({ c: n - l1 - l2, px: fin(sm.trailStop), src: 'runner trail stop', fin: true });
    return out;
  }
  return null;   // POSITION_CLOSED in LEG1_OPEN = the whole-TP1 close, already booked by its TP1_FILLED
}
// lv1 r13.3.4 sf1 (pure): the close of a trade from its booked exit-order fills. Contracts no exit order explains (a market exit: a flatten, the session
// close, a no-progress exit, the cash profit lock) keep the bot's last price, as before. closePx = the price that closed the position (the win / loss
// read); realizedPnl = null when any part has no price.
function exitEstimate(dir, entry, n0, fills, pointValue, lastPx) {
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const out = (Array.isArray(fills) ? fills : []).filter(f => f && Number.isInteger(f.c) && f.c > 0).map(f => ({ c: f.c, px: fin(f.px) ? f.px : null, src: f.src, fin: !!f.fin }));
  const booked = out.reduce((s, f) => s + f.c, 0), rest = (Number.isInteger(n0) && n0 > 0 ? n0 : booked) - booked, byOrder = out.length > 0 && out[out.length - 1].fin;
  if (rest > 0) { const m = { c: rest, px: fin(lastPx) ? lastPx : null, src: 'last bot price (a market exit has no order price)', fin: !byOrder }; if (byOrder) out.unshift(m); else out.push(m); }
  const last = out.length ? out[out.length - 1] : null, ok = rest >= 0 && out.length > 0 && (dir === 1 || dir === -1) && fin(entry) && fin(pointValue) && out.every(f => f.px != null);
  return { closePx: last ? last.px : fin(lastPx) ? lastPx : null, source: last ? last.src : 'last bot price (a market exit has no order price)',
    realizedPnl: ok ? out.reduce((s, f) => s + dir * (f.px - entry) * pointValue * f.c, 0) : null, fills: out.map(f => ({ c: f.c, px: f.px, src: f.src })) };
}
// ENTRY-FIX: broker-position guard + attempt hold (pure).
// Returns a reason string when the broker state forbids a new entry, else null. pos = Position/searchOpen row or null; orders = Order/searchOpen rows for this contract.
function brokerGuardReason(cfg, pos, orders, symbol) {
  if (pos && pos.size) return `broker already shows ${pos.type === 1 ? 'LONG' : 'SHORT'} ${pos.size}x ${symbol}${pos.averagePrice != null ? ' @ ' + Number(pos.averagePrice).toFixed(2) : ''}`;
  if (cfg.entryGuardBlockOnWorkingOrders && orders && orders.length) return `${orders.length} working order(s) on ${symbol} while flat (${orders.slice(0, 3).map(o => `#${o.id} type ${o.type} ${o.size}x${o.stopPrice != null ? ' stop ' + o.stopPrice : ''}${o.limitPrice != null ? ' limit ' + o.limitPrice : ''}`).join('; ')})`;
  return null;
}
// ROUND 4 MAC A/B INTRABAR ONLY: true = this bar-close MAC signal is not entered (its grade trades intrabar only). Only in intrabar evaluation mode, and only for
// grades that the intrabar path actually allows (otherwise the signal could never trade at all).
function macIntrabarOnlyBlock(cfg, sig, isIntrabar) {
  if (isIntrabar || !sig || sig.source !== 'mac' || cfg.evaluationMode !== 'intrabar-1m') return false;
  if (!Array.isArray(cfg.macIntrabarOnlyGrades) || !cfg.macIntrabarOnlyGrades.includes(sig.grade)) return false;
  return !cfg.intrabarRestrictToLevelsSource || (Array.isArray(cfg.intrabarAllowMacGrades) && cfg.intrabarAllowMacGrades.includes(sig.grade));
}
// ROUND 4 FAR-LIMIT: MAC's OWN signal on this board, as decideSignal() would source it with Levels silenced (same MAC gates: score, hard block, compression,
// grade-B block, intrabar grade allowance, bias agreement). null = no MAC signal.
function macSignalOnly(decide, mac, lv, cfg, isIntrabar, nowTs) {
  try {
    const lvMute = { ...lv, alignedFull: false, sigLong: false, sigShort: false, planLong: false, planShort: false, biasStr: '', plan: null };
    const r = decide(mac, lvMute, { ...cfg, requireLevelsAlignment: true, requireVolSpike: isIntrabar && cfg.intrabarRequireVolSpike, blockMacSourceIntrabar: isIntrabar && cfg.intrabarRestrictToLevelsSource }, nowTs);
    return r && r.source === 'mac' ? r : null;
  } catch (e) { return null; }
}
// { switch, pts, atrX, why }: switch when the resting plan is > farLimitAtr x ATR from price and MAC fired grade A/B in the same direction. Fail-safe = no switch.
function farLimitDecision(cfg, { planDir, planEntry, px, atr, macSig }) {
  if (!cfg.farLimitSwitch) return { switch: false, why: 'off' };
  if (!Number.isFinite(planEntry) || !Number.isFinite(px) || !(atr > 0)) return { switch: false, why: 'no data' };
  const pts = Math.abs(planEntry - px), atrX = Math.round(pts / atr * 100) / 100;
  if (!(pts > (cfg.farLimitAtr ?? 1) * atr)) return { switch: false, pts, atrX, why: 'near' };
  const grades = Array.isArray(cfg.intrabarAllowMacGrades) ? cfg.intrabarAllowMacGrades.filter(g => g === 'A' || g === 'B') : [];
  if (!macSig || macSig.dir !== planDir || !grades.includes(macSig.grade)) return { switch: false, pts, atrX, why: !macSig ? 'no MAC signal' : macSig.dir !== planDir ? 'MAC opposite' : 'MAC grade ' + macSig.grade };
  return { switch: true, pts, atrX, why: 'far + MAC agrees' };
}
// ROUND 5: true = this entry skips the no-chase check (CONFIG.noChaseExemptMacGrades, shipped [] = nobody is exempt)
function noChaseExempt(cfg, source, grade, entryType) { return entryType === 'MARKET' && source === 'mac' && Array.isArray(cfg.noChaseExemptMacGrades) && cfg.noChaseExemptMacGrades.includes(grade); }
function entryHoldActive(cfg, lastAttemptAt, nowMs) { return !!(cfg.entryAttemptHoldMs > 0 && lastAttemptAt && nowMs - lastAttemptAt < cfg.entryAttemptHoldMs); }
// ── ENTRY-GUARD HELPERS (end) ──

// so1: scale-out + runner mode (CONFIG.scaleOutRunner.enabled). Validated at startup (scaleOutRunnerProblem).
function scaleOutRunnerOn(cfg) { return !!(cfg && cfg.scaleOutRunner && cfg.scaleOutRunner.enabled === true); }
function scaleOutOn() { return scaleOutRunnerOn(CONFIG); }
function scaleOutRunnerProblem(cfg) {
  if (!scaleOutRunnerOn(cfg)) return null;
  const s = cfg.scaleOutRunner, ok = v => Number.isFinite(v) && v > 0;
  if (!ok(s.atPts) || !ok(s.runnerLockPts) || !ok(s.runnerStepPts)) return 'atPts, runnerLockPts and runnerStepPts must be positive numbers';
  if (s.runnerLockPts >= s.atPts) return 'runnerLockPts must be below atPts (the runner stop must sit behind the scale-out price)';
  return null;
}
// ── REVERSAL EXIT (pure; lv1 r13.3.3) ──
// MacTradeState's plan (docs/claude-session/plans-1030/reversal-exit/PLAN.md + TRADESTATE.md; Mac signed 10/29 17:08 PT) and its exact semantics (SEMANTICS.md,
// 10/30), ported from tslib.Tracker (sha256 379291ed) line for line, with the same tolerances. This build ships it as the SHADOW LOG ('log'): it labels the
// trade at every complete 1m close before TP1 and journals R4 / R2 when they first hold. Nothing here sends an order or touches a trade field.
//   Bar 0 = the fill minute; bar k = the 1m bar starting k minutes after it. fav(p) = dir x (p - entry); c_k = fav(close of bar k). Nothing is rounded.
//   R4 momentum flush (k >= momentumBars): momentumBars closes in a row, each STRICTLY worse than the one before (c[i+1] < c[i] - 1e-9), measured from the
//      close before the first fall (so momentumBars + 1 closes; the oldest may be bar 0's): c_{k-n} - c_k >= momentumPts - 1e-9, and c_k < 0 (strictly
//      past the entry). The momentumBars + 1 bars must be consecutive minutes: a missing 1m bar = R4 not evaluated until the run is whole again.
//   R2 sweep failed: only at a 5m close (the 1m bar that ends on a 300000 ms boundary = PT :00 / :05 ...), only with a known level L (the trade's own,
//      never rounded): dir x (close - L) <= -levelPts + 1e-9. It needs only that boundary bar, and it may be the fill bar (a 5m bar begun before the fill).
//      No level known = R2 is never evaluated (UNKNOWN): nothing is guessed.
//   Bar 0 counts by its CLOSE only (its high / low may come before the fill). The state labels (journal only) use MacTradeState's fixed thresholds: R1 (a
//   close 10+ through the entry at a new worst close), R3 (a lower pivot high, then a close below the pivot low between the two, below the entry),
//   CONTINUING / WAVING / CONSOLIDATING / UNDECIDED; bar 0 is labelled FILL unless R1 / R2 already hold there. After a missing minute the labels go on from
//   the bars seen (each row says how many minutes were missing before it).
const REV_MODES = ['off', 'log'];
const REV_P = { prog: 5, contClose: 5, fresh: 1, retr: 0.5, consAge: 3, r1: 10 };   // TRADESTATE.md table 1, fixed before any scoring
const REV_EPS = 1e-9, REV_M1 = 60000, REV_M5 = 300000;
function reversalExitProblem(cfg) {
  const r = cfg && cfg.reversalExit;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'it must be an object { mode, momentumBars, momentumPts, levelPts }';
  if (r.mode === 'on') return 'mode "on" (the real exit) is not in this build: r13.3.3 ships the shadow log only. Use "log" (journal rows, no orders) or "off"; "on" comes in a later build, after the shadow review and Mac\'s ruling';
  if (!REV_MODES.includes(r.mode)) return `mode must be "off" or "log", got ${JSON.stringify(r.mode)}`;
  if (!(Number.isInteger(r.momentumBars) && r.momentumBars >= 1 && r.momentumBars <= 10)) return `momentumBars must be a whole number 1-10, got ${JSON.stringify(r.momentumBars)}`;
  if (!(typeof r.momentumPts === 'number' && Number.isFinite(r.momentumPts) && r.momentumPts > 0)) return `momentumPts must be a positive number, got ${JSON.stringify(r.momentumPts)}`;
  if (!(typeof r.levelPts === 'number' && Number.isFinite(r.levelPts) && r.levelPts >= 0)) return `levelPts must be 0 or a positive number, got ${JSON.stringify(r.levelPts)}`;
  const extra = Object.keys(r).filter(x => !['mode', 'momentumBars', 'momentumPts', 'levelPts'].includes(x));
  if (extra.length) return `unknown key(s) ${extra.map(x => JSON.stringify(x)).join(', ')} (only mode, momentumBars, momentumPts, levelPts)`;
  return null;
}
// R4 on the last momentumBars + 1 closes, in favourable points from the fill, oldest first
function revR4(favCloses, momentumPts) {
  const n = favCloses.length; if (n < 2) return false;
  for (let i = 0; i + 1 < n; i++) if (!(favCloses[i + 1] < favCloses[i] - REV_EPS)) return false;
  return favCloses[0] - favCloses[n - 1] >= momentumPts - REV_EPS && favCloses[n - 1] < 0;
}
// R2 on one close: only a 5m close, only with a known level; measured from the level, never from the entry
function revR2(dir, close, level, isFiveMinClose, levelPts) {
  return !!isFiveMinClose && typeof level === 'number' && Number.isFinite(level) && dir * (close - level) <= -levelPts + REV_EPS;
}
function revTrackerNew({ dir, entry, fillAt, level, momentumBars, momentumPts, levelPts }) {
  return { dir, entry, fillAt, fillMin: Math.floor(fillAt / REV_M1) * REV_M1, level: typeof level === 'number' && Number.isFinite(level) ? level : null,
    n4: momentumBars, r4: momentumPts, r2: levelPts, i: -1, mi: [], hi: [], lo: [], c: [], best: 0, bestBar: null, ph: [], pl: [], lastT: null, missed: 0,
    waveConfirmedAt: null, fired: {}, firstFireK: null };
}
// One complete 1m bar { t (start, ms), h, l, c }, in time order from the fill minute on. A bar before the fill minute, already seen, off the minute grid or
// with a non-number price is skipped (null). k is the bar's minute index from the fill minute, so a missing minute leaves a hole in k.
function revTrackerUpdate(tr, b) {
  if (!b || ![b.t, b.h, b.l, b.c].every(Number.isFinite)) return null;
  if (b.t < tr.fillMin || (tr.lastT !== null && b.t <= tr.lastT) || (b.t - tr.fillMin) % REV_M1 !== 0) return null;
  const k = (b.t - tr.fillMin) / REV_M1, gapBefore = tr.lastT === null ? k : (b.t - tr.lastT) / REV_M1 - 1;
  tr.lastT = b.t; tr.missed += gapBefore; tr.i += 1; tr.mi.push(k);
  const i = tr.i, d = tr.dir, fav = p => d * (p - tr.entry), P = REV_P;   // i = the bars seen (= k with no missing minute), the label arrays' index
  const c = fav(b.c);
  let hi, lo; if (k === 0) { hi = lo = c; } else { hi = fav(d === 1 ? b.h : b.l); lo = fav(d === 1 ? b.l : b.h); }
  tr.hi.push(hi); tr.lo.push(lo); tr.c.push(c);
  if (hi > tr.best + REV_EPS) { tr.best = hi; tr.bestBar = i; }
  if (i >= 2) { const j = i - 1;   // a 1-bar pivot at j, confirmed by this bar
    if (tr.hi[j] >= tr.hi[j - 1] && tr.hi[j] > hi) tr.ph.push([j, tr.hi[j]]);
    if (tr.lo[j] <= tr.lo[j - 1] && tr.lo[j] < lo) tr.pl.push([j, tr.lo[j]]); }
  const best = tr.best, bb = tr.bestBar, extAge = bb !== null ? i - bb : i + 1;
  const origin = Math.min(0, ...(bb !== null ? tr.lo.slice(0, bb) : [])), impulse = best - origin;
  const pull = bb !== null ? tr.lo.slice(bb + 1, i + 1) : [], pullLow = pull.length ? Math.min(...pull) : null;
  const prev = tr.c.slice(0, -1), end = b.t + REV_M1, is5 = end % REV_M5 === 0;
  let comp = [];
  if (c <= -P.r1 + REV_EPS && (!prev.length || c < Math.min(...prev) - REV_EPS)) comp.push('R1');
  if (revR2(d, b.c, tr.level, is5, tr.r2)) comp.push('R2');
  if (tr.ph.length >= 2 && tr.ph[tr.ph.length - 1][1] < tr.ph[tr.ph.length - 2][1] - REV_EPS && i >= 1) {
    const a = tr.ph[tr.ph.length - 2][0], z = tr.ph[tr.ph.length - 1][0], between = tr.lo.slice(a, z + 1);
    if (between.length && c < Math.min(...between) - REV_EPS && c < 0) comp.push('R3'); }
  const r4Evaluated = k >= tr.n4 && i >= tr.n4 && tr.mi[i - tr.n4] === k - tr.n4;   // bars k-n..k all seen (minute indexes rise by 1 or more)
  if (r4Evaluated && revR4(tr.c.slice(i - tr.n4, i + 1), tr.r4)) comp.push('R4');
  let state;
  if (k === 0) { comp = comp.filter(x => x === 'R1' || x === 'R2'); state = comp.length ? 'REVERSING' : 'FILL'; }
  else if (comp.length) state = 'REVERSING';
  else if (extAge <= P.fresh && best >= P.prog - REV_EPS && c >= P.contClose - REV_EPS) state = 'CONTINUING';
  else if (best >= P.prog - REV_EPS && c >= -REV_EPS && (best - c) <= P.retr * impulse + REV_EPS && (pullLow === null || pullLow > origin + REV_EPS)) state = 'WAVING';
  else if (extAge >= P.consAge) state = 'CONSOLIDATING';
  else state = 'UNDECIDED';
  if (state === 'WAVING' && pullLow !== null && tr.waveConfirmedAt === null) tr.waveConfirmedAt = i;
  const rev = comp.filter(x => x === 'R2' || x === 'R4');   // the exit signals holding at this close, R2 before R4 ('R2+R4' when both)
  const fires = rev.filter(x => tr.fired[x] === undefined); for (const x of fires) tr.fired[x] = k;
  const first = fires.length > 0 && tr.firstFireK === null; if (first) tr.firstFireK = k;
  return { k, barT: b.t, end, is5, gapBefore, missed: tr.missed, r4Evaluated, state, signals: comp, rev, fires, first, close: b.c, closePts: c, best,
    worst: Math.min(...tr.lo), waveConfirmed: tr.waveConfirmedAt !== null };
}
// ── REVERSAL EXIT (pure end) ──
// ── CONSISTENT SIZE (pure; lv1 size1) ──
// Mac 10/30 (plans-1030/size/PLAN.md): "always 3 contracts or no trade". minContracts "off" (or the shipped null) = off: 1-3 contracts by the stop under the $ cap,
// exactly as before. 3 = a setup sized below 3 is SKIPPED, never opened smaller. Two gates, both on the count itself:
//   quantityForStop()     every entry path sizes there (the $ cap at the structural stop, then the grade / flat / baseContracts ceilings): below 3 -> 0
//                         contracts, so the path's own "!contracts -> riskCapSkip" skips it, journaled SIZE_BELOW_MIN with the why;
//   entryQuantityAllowed()  the FINAL count, checked by takeEntry() right before the order goes to the order machine and again by the machine at submit:
//                         any order below 3 (whatever reduced it after sizing) is refused, journaled SIZE_BELOW_MIN.
// The one reducer after sizing, the contested minimum size (controlContestedMinSize: 1 contract), cannot be on with 3: the bot refuses to start.
function minContractsProblem(cfg, pointValue) {
  const m = cfg ? cfg.minContracts : undefined;
  if (m === null || m === 'off') return null;
  if (m !== 3) return `minContracts must be "off" or 3, got ${JSON.stringify(m)}`;
  if (!(Number.isInteger(cfg.baseContracts) && cfg.baseContracts >= 3)) return `minContracts 3 needs baseContracts 3 or more, got ${JSON.stringify(cfg.baseContracts)}`;
  if (!(Number.isInteger(cfg.flatSizeContracts) && cfg.flatSizeContracts >= 3)) return `minContracts 3 needs flatSizeContracts 3 or more, got ${JSON.stringify(cfg.flatSizeContracts)} (0 = the grade table, which sizes some grades at 2)`;
  if (cfg.controlContestedMinSize) return 'minContracts 3 cannot go with controlContestedMinSize on (a contested setup is sized at 1 contract): turn controlContestedMinSize off';
  const cap = cfg.maxRiskPerTradeUsd, slip = cfg.riskSizingSlipPts > 0 ? cfg.riskSizingSlipPts : 0, f = cfg.entryStopFloor;
  if (Number.isFinite(cap) && cap > 0 && f && f.enabled === true) {
    for (const [s, nm] of [['asia', 'Asia'], ['london', 'London'], ['ny', 'NY'], ['late', 'late']]) if (Number.isFinite(f[s]) && 3 * (f[s] + slip) * pointValue > cap + 1e-9)
      return `the $${cap} risk cap cannot fit 3 contracts at the ${nm} stop floor (${f[s]} pts = $${Math.round(3 * (f[s] + slip) * pointValue * 100) / 100} at 3)`;
  }
  return null;
}
// the widest stop (pts) at which the $ cap still fits 3 contracts (null = the cap is off)
function minContractsMaxStopPts(cfg, pointValue) {
  const cap = cfg.maxRiskPerTradeUsd, slip = cfg.riskSizingSlipPts > 0 ? cfg.riskSizingSlipPts : 0;
  return Number.isFinite(cap) && cap > 0 ? Math.floor((cap / (3 * pointValue) - slip) * 100 + 1e-6) / 100 : null;
}
// the gate on one sizing decision (lib/initialQuantity.js decision()): the SAME object when the rule is off or the size is 3+ (or already 0)
function minContractsGate(q, min, stopPts, pointValue, slipPts) {
  if (min !== 3 || !q || !(q.contracts > 0) || q.contracts >= min) return q;
  const per = (stopPts + (slipPts > 0 ? slipPts : 0)) * pointValue, need = Math.round(min * per * 100) / 100, usd = x => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
  const why = Number.isFinite(q.rawContracts) && q.rawContracts < min ? `stop ${Number(stopPts).toFixed(2)} pts needs ${usd(need)} at ${min}` : `${q.reason}: ${q.contracts} contract${q.contracts === 1 ? '' : 's'}`;
  return Object.freeze({ ...q, contracts: 0, reason: 'below-min-contracts', minContracts: min, sizedContracts: q.contracts, sizedReason: q.reason, needUsd: need, minText: `size below ${min} (${why})` });
}
function minContractsOk(min, contracts) { return min !== 3 || (Number.isInteger(contracts) && contracts >= min); }
// ── CONSISTENT SIZE (pure end) ──
// so1: the end of the same-direction block after a stop-out: the close of the candle (stopOutSameDirBlockMin, default 15) that contains the exit. null = off.
// The result can be at or before exitMs (a stop seen just after a boundary): then there is no candle block, only the normal cooldown.
function sameDirBlockUntil(cfg, exitMs) { const m = Number(cfg && cfg.stopOutSameDirBlockMin); if (!(m > 0) || !Number.isFinite(exitMs)) return null; const ms = m * 60000, lag = Math.max(0, Number(cfg.pollIntervalMs) || 0) + 5000; return Math.floor((exitMs - lag) / ms) * ms + ms; }   // r1.1: exitMs is the OBSERVATION time; lag = one poll + 5 s
// ── SESSION-EXIT HELPERS (begin) ── (optional feature, default OFF; see CONFIG.sessionExits)
// Which session a timestamp is in, with the bot's existing definition (ptInfo: asia >= 15:00 PT, london < 06:30 PT, else ny).
function sessionKeyOf(pt) { return pt.isAsia ? 'asia' : pt.isLondon ? 'london' : 'ny'; }
// Returns null when session exits are off for the session of `pt`; { skipped: reason } when on but unusable; else the plan { session, label, out, runners, targetPoints, target1, runnerStopAtBE, how, text }.
function sessionExitPlan(cfg, pt, dir, entryPrice, contracts, atr, tickSize) {
  const all = cfg && cfg.sessionExits; if (!all || scaleOutRunnerOn(cfg)) return null;
  const key = sessionKeyOf(pt), c = all[key];
  if (!c || c.enabled !== true) return null;
  const label = key === 'ny' ? 'NY' : key[0].toUpperCase() + key.slice(1);
  const runners = Math.max(1, Math.floor(Number(c.runners)) || 1), out = contracts - runners;
  if (!(out >= 1)) return { skipped: `${label} base-hit needs more than ${runners} contract(s) (this trade has ${contracts})` };
  let pts, how;
  if (c.targetAtrMult != null) {
    if (!(atr > 0)) return { skipped: `${label} base-hit uses ${c.targetAtrMult} x ATR but the ATR is not available` };
    pts = c.targetAtrMult * atr; how = `${c.targetAtrMult} x ATR(14,15m) ${Number(atr).toFixed(2)}`;
  } else { pts = Number(c.targetPoints); how = 'fixed'; }
  const tick = tickSize || 0.25; pts = Math.round(pts / tick) * tick;
  if (!(pts > 0)) return { skipped: `${label} base-hit target distance is not positive` };
  const target1 = Math.round((entryPrice + dir * pts) / tick) * tick;
  const fmt = n => (Math.round(n * 100) / 100).toString();
  return { session: key, label, out, runners, targetPoints: pts, target1, runnerStopAtBE: c.runnerStopAtBE !== false, how,
    text: `${label} base-hit: ${out} out at +${fmt(pts)}, ${runners} runner${runners === 1 ? '' : 's'} at BE` };
}
// ── SESSION-EXIT HELPERS (end) ──

// ── TRADE-LOG HELPERS (begin) ── (2026-10-13, owner: "enter the full trade logic and signal in our journal ... why our bot is setting the stop loss, take profit targets, and everything else")
// JOURNAL / DISPLAY ONLY. Pure functions that turn what the entry code already computed into plain-English journal rows (trade_plan, trade_manage, trade_block). Nothing here is
// read by any trading decision; every call site wraps these in try/catch so a logging error can never reach an order.
const TL_PATHS = {
  'levels-market': 'Levels PRO plan, market entry',
  'levels-limit': 'Levels PRO plan, resting limit/stop entry',
  'mac-pullback': 'MAC Trap, limit at a pullback level',
  'mac-market': 'MAC Trap, market entry',
};
const tlP = x => (x == null || !Number.isFinite(x)) ? '?' : Number(x).toFixed(2);
const tlUsd = x => (x < 0 ? '-$' : '$') + Math.abs(Math.round(x * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
// Which rule produced target2? Inferred from the numbers (the same inputs computeTarget2 used), so the text can never disagree with the price that was actually used.
function tlDescribeTarget2(dir, entryPx, target1Px, target1Points, structTarget, multiple, asiaStruct, target2Px, levels) {
  const near = (a, b) => Math.abs(a - b) < 0.01;
  if (structTarget != null && Number.isFinite(structTarget) && near(target2Px, structTarget)) return { kind: 'structure', text: `Levels PRO plan target ${tlP(structTarget)} (the next structural level beyond TP1)` };
  if (asiaStruct) {
    const lv = (levels || []).find(l => l && near(l.price, target2Px));
    if (lv) return { kind: 'asia-structure', text: `Asia structural target: the nearest level ${asiaStruct.minPts}-${asiaStruct.maxPts} pts away, ${lv.name} @ ${tlP(lv.price)}` };
    if (near(Math.abs(target2Px - entryPx), asiaStruct.fallbackPts)) return { kind: 'asia-fallback', text: `Asia fallback: no level ${asiaStruct.minPts}-${asiaStruct.maxPts} pts away, so a fixed ${asiaStruct.fallbackPts} pts from entry` };
  }
  return { kind: 'multiple', text: `${multiple}x the TP1 distance (${tlP(target1Points)} pts x ${multiple} = ${tlP(target1Points * multiple)} pts from entry)` };
}
// Everything about the stop in words and numbers. sb = the call site's stop facts: { kind: 'structure'|'atr', rawStop, atrRef, risk, capMaxPts, capApplied, multipleLabel }.
function tlStopBasis(sb, dir, entryPx, stopPrice, tightStopPrice, smartHold) {
  const pts = Math.abs(entryPx - stopPrice);   // the stop that RESTS at the exchange is what the trade really risks (with smart-stop-hold that is the wide stop)
  let text;
  if (sb.kind === 'structure') text = `Levels PRO's structural stop (a real break-of-structure level) at ${tlP(sb.rawStop)}, ${tlP(Math.abs(entryPx - sb.rawStop))} pts from entry, used as-is: no ATR cap is applied to a structural stop.`;
  else text = `no structural level to use, so the stop is half an ATR from entry: 0.5 x ATR ${tlP(sb.atrRef)} = ${tlP(sb.risk)} pts -> ${tlP(sb.rawStop)}${sb.capApplied ? `; that was ${tlP(Math.abs(entryPx - sb.rawStop))} pts away and the cap of ${tlP(sb.capMaxPts)} pts (${sb.multipleLabel}) pulled it in to ${tlP(tightStopPrice != null ? tightStopPrice : stopPrice)}` : `; within the cap of ${tlP(sb.capMaxPts)} pts (${sb.multipleLabel}), so no cap was applied`}.`;
  if (smartHold && tightStopPrice != null) text += ` Smart-stop-hold is ON: the order resting at the exchange is the WIDE stop ${tlP(stopPrice)} (${tlP(Math.abs(entryPx - stopPrice))} pts from entry, which is the risk shown); the tight reference ${tlP(tightStopPrice)} (${tlP(Math.abs(entryPx - tightStopPrice))} pts) only triggers an early market exit if Levels confirms a break of structure.`;
  else text += ' Smart-stop-hold is off, so this is the stop resting at the exchange.';
  return { pts: Math.round(pts * 100) / 100, text };
}
// The whole plan row. inp carries only values the entry code already had.
function buildTradePlanRow(inp) {
  const dirW = inp.dir === 1 ? 'LONG' : 'SHORT';
  const pv = inp.pointValue, n = inp.contracts, l1 = inp.leg1Size, l2 = inp.leg2Size, l3 = n - l1 - l2;
  const stopPts = inp.stop.points;
  const perLeg = [['leg 1 (TP1)', l1], ['leg 2 (TP2)', l2], ['runner', l3]].filter(x => x[1] > 0).map(([name, size]) => ({ leg: name, contracts: size, riskUsd: Math.round(stopPts * pv * size * 100) / 100 }));
  const totalRisk = Math.round(stopPts * pv * n * 100) / 100;
  const tp1Pts = inp.tp1 ? Math.abs(inp.tp1.price - inp.entryPrice) : null, tp2Pts = inp.tp2 ? Math.abs(inp.tp2.price - inp.entryPrice) : null;
  const row = {
    type: 'trade_plan', t: inp.t, journalId: inp.journalId, dir: inp.dir, path: inp.path, pathLabel: TL_PATHS[inp.path] || inp.path, source: inp.source, grade: inp.grade,
    intrabar: !!inp.intrabar, timeframe: inp.timeframe, trigger: inp.trigger,
    entry: { type: inp.entryType, price: inp.entryPrice, refPrice: inp.refPrice, why: inp.entryWhy, level: inp.entryLevel ?? null },   // r9.14: the level the entry was taken at
    stop: { price: inp.stop.price, tightRefPrice: inp.stop.tightRefPrice, points: stopPts, basis: inp.stop.text },
    tp1: inp.tp1 ? { price: inp.tp1.price, points: Math.round(tp1Pts * 100) / 100, basis: inp.tp1.text } : null,
    tp2: inp.tp2 ? { price: inp.tp2.price, points: Math.round(tp2Pts * 100) / 100, kind: inp.tp2.kind, basis: inp.tp2.text } : null,
    sizes: { contracts: n, leg1: l1, leg2: l2, leg3: l3, riskPerLeg: perLeg, totalRiskUsd: totalRisk, rrTp1: tp1Pts != null && stopPts ? Math.round(tp1Pts / stopPts * 100) / 100 : null, rrTp2: tp2Pts != null && stopPts ? Math.round(tp2Pts / stopPts * 100) / 100 : null },
    settings: inp.settings,
  };
  row.summary = `${inp.baseHit ? inp.baseHit + '. ' : ''}${dirW} ${n}x via ${row.pathLabel}${inp.grade ? ` (grade ${inp.grade})` : ''}${inp.timeframe ? ` on the ${inp.timeframe} chart` : ''}, ${inp.intrabar ? 'caught intrabar (before the 15m close)' : 'on the 15m bar close'}. ${inp.entryWhy} `
    + `Stop ${tlP(row.stop.price)} (${stopPts} pts = ${tlUsd(totalRisk)} total risk on ${n}x). `
    + (row.tp1 ? `TP1 ${tlP(row.tp1.price)} (${row.tp1.points} pts, ${l1}x). ` : '') + (row.tp2 ? `TP2 ${tlP(row.tp2.price)} (${row.tp2.points} pts, ${l2}x). ` : '')
    + (l3 > 0 ? (inp.baseHit ? `${l3}x runner stays at break-even after the base hit.` : `${l3}x runner trails behind.`) : '') + (row.sizes.rrTp1 != null ? ` R:R to TP1 ${row.sizes.rrTp1}.` : '');
  return row;
}
// Plain-English text for a blocked signal.
// lv1 r13.3.7-candidate: the PAST_LEVEL check (pure). past = (entry - level price) x dir in points; blocks only when past > maxPts (exactly at the limit = allowed).
// maxPts null / undefined = off (never blocks). Returns null or { pastPts, limit }.
function pastLevelBlock({ dir, entry, levelPrice, maxPts }) {
  if (maxPts === null || maxPts === undefined) return null;
  if (!(dir === 1 || dir === -1) || !Number.isFinite(entry) || !Number.isFinite(levelPrice) || !Number.isFinite(maxPts)) return null;
  const past = Math.round((entry - levelPrice) * dir * 100) / 100;
  return past > maxPts + 1e-9 ? { pastPts: past, limit: maxPts } : null;
}
// ── DAY CONTEXT (pure; lv1 r13.3.7) ──
// LOG ONLY (Mac ~00:40Z 10/31): the day-type context the journals carry; nothing reads it to decide. Inputs: the bot's 1H bars (each { t ms, o, h, l, c }),
// the price at that moment, the moment (ms) and the row's direction. Only bars that STARTED at or before the moment are read (the forming 1H bar as fetched).
// Every boundary is America/Los_Angeles wall time: the CME day runs 15:00 PT -> 14:00 PT (a bar at 15:00 PT or later belongs to the next date), the week
// opens Sunday 15:00 PT, 4H candles start at 15:00 / 19:00 / 23:00 / 03:00 / 07:00 / 11:00 PT. Missing history = null with a reason (fail open).
const DC_VERSION = 'day-context-v1', DC_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DC_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
const dcCache = new Map();   // bar time -> its PT wall-clock parts (bounded)
function dcParts(t) {
  const c = dcCache.get(t); if (c) return c;
  const o = {}; for (const p of DC_FMT.formatToParts(new Date(t))) o[p.type] = p.value;
  const r = { y: +o.year, mo: +o.month, d: +o.day, H: +o.hour % 24, M: +o.minute, wd: DC_WD.indexOf(o.weekday) };
  if (dcCache.size > 20000) dcCache.clear(); dcCache.set(t, r); return r;
}
function dcPtToUtc(y, mo, d, H, M) {   // the instant of a PT wall-clock time (PDT = UTC-7, PST = UTC-8; the one whose PT reading matches)
  for (const off of [7, 8]) { const t = Date.UTC(y, mo - 1, d, H + off, M), p = dcParts(t); if (p.y === y && p.mo === mo && p.d === d && p.H === H && p.M === M) return t; }
  return null;
}
const dcDateKey = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10);
function dcTradeDay(t) { const p = dcParts(t); return p.H >= 15 ? dcDateKey(p.y, p.mo, p.d + 1) : dcDateKey(p.y, p.mo, p.d); }   // the CME day a time belongs to
function dc4hStart(t) { const p = dcParts(t), min = p.H * 60 + p.M; return t - (((min - 900 + 1440) % 1440) % 240) * 60000 - (t % 60000); }   // its 4H candle's start
function dcWeekOpenAt(at) {   // the most recent Sunday 15:00 PT at or before `at`
  const p = dcParts(at); let back = p.wd;
  for (let k = 0; k < 3; k++, back += 7) { const day = new Date(Date.UTC(p.y, p.mo - 1, p.d - back)); const t = dcPtToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 15, 0); if (t != null && t <= at) return t; }
  return null;
}
// EXHAUSTION (lv1 r13.3.7; Mac's 10/30 11:30 PT chart read, "signs of exhaustion before the reclaim"; LOG ONLY): RSI(14) on the closes of the last CLOSED 5m /
// 15m / 30m / 1H / 4H bar, how many of the five are below 25 / above 75, the last closed 15m bar's volume against the 20 closed 15m bars before it, and its shape.
// CLOSED = the bar ended at or before the moment its series was REQUESTED (the latest evaluation's request start; never a bar that may have come back forming).
// 30m = the 15m bars paired from :00 / :30; 4H = the 1H bars from 15:00 PT (the CME day's 4H grid, the same as h4Trend). Wilder RSI = Pine ta.rsi: the first
// average gain / loss = the mean of the first 14 changes, then (avg x 13 + x) / 14; no loss = 100 (a flat series = 50); fewer than 15 closes = null.
function dcRsi14(closes) {
  const n = 14; if (!Array.isArray(closes) || closes.length < n + 1 || !closes.every(Number.isFinite)) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
}
// bars (sorted by start) into the larger bars that startOf(t) names: o = the first bar's, h / l = the extremes, c = the last bar's, v = the sum (null if any is missing)
function dcBarsAgg(bars, startOf) {
  const m = new Map();
  for (const b of bars) { const s = startOf(b.t), a = m.get(s), v = Number.isFinite(b.v) ? b.v : null;
    if (!a) m.set(s, { t: s, o: b.o, h: b.h, l: b.l, c: b.c, v }); else { a.h = Math.max(a.h, b.h); a.l = Math.min(a.l, b.l); a.c = b.c; a.v = a.v !== null && v !== null ? a.v + v : null; } }
  return [...m.values()].sort((a, b) => a.t - b.t);
}
// the last closed 15m bar's shape (prev = the closed 15m bar before it, or null). In this order: HAMMER = the lower wick at least 2x the body AND at least half the
// range; SHOOTING_STAR = the mirror (the upper wick); a bar that is both (a doji with both wicks at half the range) = NONE; BULL_ENGULF = a green bar whose body
// covers a red prior bar's body (open <= its close, close >= its open) and is bigger; BEAR_ENGULF = the mirror; otherwise (or a zero range) NONE.
function dcCandle15(prev, cur) {
  const E = 1e-9; if (!cur || ![cur.o, cur.h, cur.l, cur.c].every(Number.isFinite)) return null;
  const body = Math.abs(cur.c - cur.o), range = cur.h - cur.l, lower = Math.min(cur.o, cur.c) - cur.l, upper = cur.h - Math.max(cur.o, cur.c);
  if (!(range > E)) return 'NONE';
  const ham = lower >= 2 * body - E && lower >= 0.5 * range - E, star = upper >= 2 * body - E && upper >= 0.5 * range - E;
  if (ham || star) return ham && star ? 'NONE' : ham ? 'HAMMER' : 'SHOOTING_STAR';
  if (prev && [prev.o, prev.c].every(Number.isFinite)) { const pb = Math.abs(prev.c - prev.o);
    if (cur.c > cur.o && prev.c < prev.o && cur.o <= prev.c + E && cur.c >= prev.o - E && body > pb + E) return 'BULL_ENGULF';
    if (cur.c < cur.o && prev.c > prev.o && cur.o >= prev.c - E && cur.c <= prev.o + E && body > pb + E) return 'BEAR_ENGULF'; }
  return 'NONE';
}
function dcExhaustion({ m5, m15, h1, readAt }) {
  const r2 = x => Math.round(x * 100) / 100, TF = { m5: 300000, m15: 900000, m30: 1800000, h1: 3600000, h4: 14400000 };
  const out = { rsi14: { m5: null, m15: null, m30: null, h1: null, h4: null }, bars: { m5: null, m15: null, m30: null, h1: null, h4: null }, oversoldCount: null, overboughtCount: null, vol15Ratio: null, candle15: null, reasons: [] };
  const why = (k, r) => { out.reasons.push(`${k}: ${r}`); };
  if (!Number.isFinite(readAt)) { why('all', 'the bars have no request time (no evaluation yet)'); return out; }
  const closed = (bars, ms) => (Array.isArray(bars) ? bars : []).filter(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t + ms <= readAt).sort((a, b) => a.t - b.t);
  const S = { m5: closed(m5, TF.m5), m15: closed(m15, TF.m15), h1: closed(h1, TF.h1) };
  S.m30 = dcBarsAgg(S.m15, t => t - (t % TF.m30)).filter(b => b.t + TF.m30 <= readAt);
  S.h4 = dcBarsAgg(S.h1, dc4hStart).filter(b => b.t + TF.h4 <= readAt);
  for (const k of ['m5', 'm15', 'm30', 'h1', 'h4']) { const bs = S[k], v = dcRsi14(bs.map(b => b.c));
    if (v === null) why(`rsi14.${k}`, `${bs.length} closed bars (< 15)`); else { out.rsi14[k] = r2(v); out.bars[k] = bs[bs.length - 1].t; } }
  const vals = Object.values(out.rsi14).filter(x => x !== null);
  if (vals.length) { out.oversoldCount = vals.filter(x => x < 25).length; out.overboughtCount = vals.filter(x => x > 75).length; }
  if (vals.length < 5) why('counts', `out of ${vals.length} timeframes`);
  const q = S.m15, n = q.length;
  if (n >= 21) { const last = q[n - 1], prev20 = q.slice(n - 21, n - 1);
    if (!Number.isFinite(last.v) || !prev20.every(b => Number.isFinite(b.v))) why('vol15Ratio', 'a 15m bar has no volume');
    else { const avg = prev20.reduce((a, b) => a + b.v, 0) / 20; if (avg > 0) out.vol15Ratio = r2(last.v / avg); else why('vol15Ratio', 'the 20 bars before it have no volume'); } }
  else why('vol15Ratio', `${n} closed 15m bars (< 21)`);
  if (n) out.candle15 = dcCandle15(n >= 2 ? q[n - 2] : null, q[n - 1]); else why('candle15', 'no closed 15m bar');
  if (!out.reasons.length) delete out.reasons;
  return out;
}
function dayContext({ h1, price, at, dir, m5, m15, readAt } = {}) {
  const out = { v: DC_VERSION, at: Number.isFinite(at) ? at : null, price: null, weeklyOpen: null, vsWeeklyOpenPts: null, priorDay: null, priorDayStructure: null,
    sessionBrokePDL: null, sessionBrokePDH: null, h4Trend: null, dayType: null, withDayType: null, exhaustion: null, reasons: [] };
  const why = (k, r) => { out.reasons.push(`${k}: ${r}`); };
  if (!Number.isFinite(at)) { why('all', 'no time'); return out; }
  try { out.exhaustion = dcExhaustion({ m5, m15, h1, readAt: Number.isFinite(readAt) ? Math.min(readAt, at) : null }); } catch (e) { why('exhaustion', `error ${e && e.message}`); }   // its own reasons inside it
  const B = (Array.isArray(h1) ? h1 : []).filter(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.t <= at && b.t >= at - 12 * 86400000).sort((a, b) => a.t - b.t);
  if (!B.length) { why('all', 'no 1H bars'); return out; }
  const px = Number.isFinite(price) ? price : B[B.length - 1].c; out.price = px;
  const r2 = x => Math.round(x * 100) / 100;
  // the weekly open: the first 1H bar at or after Sunday 15:00 PT (and at or before now)
  const ws = dcWeekOpenAt(at), wb0 = ws == null ? null : B.find(b => b.t >= ws), wb = wb0 && wb0.t <= ws + 2 * 3600000 ? wb0 : null;   // the week's first bar itself (a gap = unknown, never a later bar)
  if (wb) { out.weeklyOpen = wb.o; out.vsWeeklyOpenPts = r2(px - wb.o); } else why('weeklyOpen', ws == null ? 'no week start' : 'the first 1H bar of the week (Sunday 15:00 PT) is not in the history');
  // the CME days in the history
  const days = new Map(); for (const b of B) { const k = dcTradeDay(b.t); if (!days.has(k)) days.set(k, []); days.get(k).push(b); }
  const today = dcTradeDay(at), past = [...days.keys()].filter(k => k < today).sort();
  const agg = (k, bs) => ({ date: k, o: bs[0].o, h: Math.max(...bs.map(b => b.h)), l: Math.min(...bs.map(b => b.l)), c: bs[bs.length - 1].c, bars: bs.length });
  const MINB = 12;   // a CME day has 23 1H bars; fewer than 12 = a partial day in the history, not used
  const pk = past[past.length - 1], bk = past[past.length - 2];
  const prior = pk && days.get(pk).length >= MINB ? agg(pk, days.get(pk)) : null, before = bk && days.get(bk).length >= MINB ? agg(bk, days.get(bk)) : null;
  if (prior) {
    const rng = prior.h - prior.l, closeLoc = rng > 0 ? Math.round((prior.c - prior.l) / rng * 100) / 100 : null;
    out.priorDay = { date: prior.date, o: prior.o, h: prior.h, l: prior.l, c: prior.c, closeLoc, color: prior.c > prior.o ? 'GREEN' : prior.c < prior.o ? 'RED' : 'FLAT' };
    if (closeLoc == null) why('priorDay.closeLoc', 'a zero-range day');
    const sess = days.get(today) || [], sl = Math.min(px, ...sess.map(b => b.l)), sh = Math.max(px, ...sess.map(b => b.h));
    out.sessionBrokePDL = sl < prior.l; out.sessionBrokePDH = sh > prior.h;
  } else { why('priorDay', pk ? `the prior CME day ${pk} has ${days.get(pk).length} 1H bars in the history (< ${MINB})` : 'no prior CME day in the history'); why('sessionBroke', 'no prior day'); }
  if (prior && before) out.priorDayStructure = prior.h > before.h && prior.l > before.l ? 'HH_HL' : prior.h < before.h && prior.l < before.l ? 'LH_LL' : prior.h <= before.h && prior.l >= before.l ? 'INSIDE' : 'OUTSIDE';
  else why('priorDayStructure', prior ? 'no complete day before the prior day' : 'no prior day');
  // the last 3 COMPLETED 4H candles (from 15:00 PT)
  const c4 = new Map(); for (const b of B) { const s = dc4hStart(b.t); if (!c4.has(s)) c4.set(s, []); c4.get(s).push(b); }
  const done = [...c4.keys()].filter(s => s + 4 * 3600000 <= at).sort((a, b) => a - b).slice(-3).map(s => agg(s, c4.get(s)));
  if (done.length === 3) { const [a, b, c] = done;
    out.h4Trend = b.h < a.h && c.h < b.h && b.l < a.l && c.l < b.l ? 'DOWN' : b.h > a.h && c.h > b.h && b.l > a.l && c.l > b.l ? 'UP' : 'MIXED'; }
  else why('h4Trend', `${done.length} completed 4H candles in the history (< 3)`);
  // the day type
  const cl = out.priorDay ? out.priorDay.closeLoc : null;
  if (cl == null || out.weeklyOpen == null || out.sessionBrokePDL == null) why('dayType', 'an input is missing');
  else out.dayType = cl < 0.333 && px < out.weeklyOpen && out.sessionBrokePDL ? 'TREND_DOWN' : cl > 0.667 && px > out.weeklyOpen && out.sessionBrokePDH ? 'TREND_UP' : 'NONE';
  out.withDayType = (dir === 1 || dir === -1) && (out.dayType === 'TREND_DOWN' || out.dayType === 'TREND_UP') ? (out.dayType === 'TREND_UP') === (dir === 1) : null;
  if (!out.reasons.length) delete out.reasons;
  return out;
}
// ── DAY CONTEXT (pure end) ──
let dayCtxHook = null;   // lv1 r13.3.7: set by main() to (dir, price) => the context now; the levels journal's writer calls it (log only, never throws)
let dcBarsReqAt = NaN;   // lv1 r13.3.7: when the bars the context reads (the latest evaluation's) were requested - the exhaustion fields' closed-bar cut
// ── PLAN-END TREND (pure; lv1 r13.3.7d) ──
// planEndsAtTargetTrend (shipped null = off; only with planEndsAtTarget ON): an entry whose event's plan target was reached before it is taken only when this holds
// at the entry decision. Every boundary is America/Los_Angeles wall time: the TradeDay runs 15:00 PT -> 14:00 PT (15:00 PT = 22:00Z under PDT, 23:00Z under PST;
// US clocks change Sun 11/1). Bars: the latest evaluation's (M5 / M15 / H1, all read every poll); a candle counts as COMPLETED only if it had ended when its series
// was requested (readAt) and before the decision (at). 30m candles = the 15m pairs from :00 / :30 (both halves present). Missing data = the check fails.
const PET_TF = Object.freeze({ '5m': 300000, '15m': 900000, '30m': 1800000, '1H': 3600000 }), PET_TFS = Object.freeze(Object.keys(PET_TF));
const PET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const petCache = new Map();   // minute -> its PT wall-clock parts (bounded)
function petParts(t) {
  const k = t - (((t % 60000) + 60000) % 60000), c = petCache.get(k); if (c) return c;
  const o = {}; for (const p of PET_FMT.formatToParts(new Date(k))) o[p.type] = p.value;
  const r = { y: +o.year, mo: +o.month, d: +o.day, H: +o.hour % 24, M: +o.minute };
  if (petCache.size > 20000) petCache.clear(); petCache.set(k, r); return r;
}
function petPtToUtc(y, mo, d, H, M) {   // the instant of a PT wall-clock time (the date normalised first; PDT = UTC-7, PST = UTC-8: the offset whose PT reading matches)
  const n = new Date(Date.UTC(y, mo - 1, d)), Y = n.getUTCFullYear(), Mo = n.getUTCMonth() + 1, D = n.getUTCDate();
  for (const off of [7, 8]) { const t = Date.UTC(Y, Mo - 1, D, H + off, M), p = petParts(t); if (p.y === Y && p.mo === Mo && p.d === D && p.H === H && p.M === M) return t; }
  return null;
}
function petDayStart(t) { if (!Number.isFinite(t)) return null; const p = petParts(t); return petPtToUtc(p.y, p.mo, p.H >= 15 ? p.d : p.d - 1, 15, 0); }   // the latest 15:00 PT at or before t
function petH4Start(t) { const p = petParts(t), min = p.H * 60 + p.M; return t - (((min - 900 + 1440) % 1440) % 240) * 60000 - (((t % 60000) + 60000) % 60000); }   // its 4H candle (15:00 PT grid)
// the TradeDay's open: the open of the bar that started EXACTLY at its 15:00 PT (the first series in the list that has it; a gap at the open = unknown, never a later bar)
function petDailyOpen(series, at) {
  const s = petDayStart(at); if (s === null || !(s <= at)) return null;
  for (const bars of series) for (const b of Array.isArray(bars) ? bars : []) if (b && b.t === s && Number.isFinite(b.o)) return { dailyOpen: b.o, dayStart: s };
  return null;
}
// the PRIOR TradeDay's high / low from 1H bars: the latest TradeDay before the current one that has 1H bars (a weekend / holiday is skipped); fewer than 12 bars (of 23) =
// a partial day in the history = null (unknown)
function petPriorDay(h1, at, readAt) {
  const s = petDayStart(at); if (s === null) return null;
  const B = (Array.isArray(h1) ? h1 : []).filter(b => b && [b.t, b.h, b.l].every(Number.isFinite) && b.t < s && b.t >= s - 6 * 86400000 && b.t + 3600000 <= readAt);
  let ps = -Infinity; for (const b of B) { const d = petDayStart(b.t); if (d > ps) ps = d; }
  if (!Number.isFinite(ps)) return null;
  const day = new Map(); for (const b of B) if (petDayStart(b.t) === ps) day.set(b.t, b);
  if (day.size < 12) return null;
  const v = [...day.values()];
  return { dayStart: ps, high: Math.max(...v.map(b => b.h)), low: Math.min(...v.map(b => b.l)), bars: day.size };
}
function petSeries(bars, tf) {   // the `tf` candles of the evaluation's bars
  const B = bars || {};
  if (tf === '5m') return B.M5; if (tf === '15m') return B.M15; if (tf === '1H') return B.H1;
  if (tf === '30m') { const m = new Map(); for (const b of Array.isArray(B.M15) ? B.M15 : []) if (b && [b.t, b.c].every(Number.isFinite)) m.set(b.t, b);
    const out = []; for (const [t, b] of m) if (((t % 1800000) + 1800000) % 1800000 === 0 && m.has(t + 900000)) out.push({ t, o: b.o, c: m.get(t + 900000).c }); return out; }
  return null;
}
// the completed candles of the TradeDay that started at dayStart, by time (one per start)
function petDayBars(bars, tfMs, dayStart, readAt) {
  const m = new Map(); for (const b of Array.isArray(bars) ? bars : []) if (b && [b.t, b.c].every(Number.isFinite) && b.t >= dayStart && b.t + tfMs <= readAt) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}
// `closes` CONSECUTIVE completed candles (back-to-back times: a missing candle breaks the run) of this TradeDay closed beyond `level` (long: above, short: below):
// { at: when the run's last candle closed, run } for the first such run, or null
function petAccepted(bars, tfMs, dayStart, readAt, dir, level, closes) {
  if (!(dir === 1 || dir === -1) || !Number.isFinite(level) || !Number.isFinite(dayStart) || !(Number.isInteger(closes) && closes >= 1)) return null;
  let run = 0, prev = null;
  for (const b of petDayBars(bars, tfMs, dayStart, readAt)) {
    run = !(dir > 0 ? b.c > level : b.c < level) ? 0 : prev !== null && b.t - prev === tfMs ? run + 1 : 1; prev = b.t;
    if (run >= closes) return { at: b.t + tfMs, run };
  }
  return null;
}
// the longest run of consecutive completed closes above `hi` / below `lo` this TradeDay (the log's per-timeframe acceptance read)
function petRuns(bars, tfMs, dayStart, readAt, hi, lo) {
  let up = 0, dn = 0, bu = 0, bd = 0, prev = null;
  for (const b of petDayBars(bars, tfMs, dayStart, readAt)) { const c = prev !== null && b.t - prev === tfMs; up = b.c > hi ? (c ? up + 1 : 1) : 0; dn = b.c < lo ? (c ? dn + 1 : 1) : 0; bu = Math.max(bu, up); bd = Math.max(bd, dn); prev = b.t; }
  return { above: bu, below: bd };
}
// null when c is usable, else why not: null (off) | { mode: 'dailyOpenPts', pts: (0, 500] } | { mode: 'pdRange', accept: { tf: 5m / 15m / 30m / 1H, closes: 1-24 } }, nothing else
function planEndTrendConfigError(c) {
  if (c === null) return null;
  const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x), keys = x => Object.keys(x).sort().join(','), got = ` got ${JSON.stringify(c)}`;
  if (!plain(c)) return `null (off), { mode: 'dailyOpenPts', pts } or { mode: 'pdRange', accept: { tf, closes } } -${got}`;
  if (c.mode === 'dailyOpenPts') return keys(c) !== 'mode,pts' ? `dailyOpenPts takes exactly { mode, pts } -${got}` : typeof c.pts === 'number' && Number.isFinite(c.pts) && c.pts > 0 && c.pts <= 500 ? null : `pts must be more than 0 and at most 500 -${got}`;
  if (c.mode === 'pdRange') { if (keys(c) !== 'accept,mode') return `pdRange takes exactly { mode, accept } -${got}`;
    const a = c.accept; return plain(a) && keys(a) === 'closes,tf' && PET_TFS.includes(a.tf) && Number.isInteger(a.closes) && a.closes >= 1 && a.closes <= 24 ? null : `accept must be { tf: '5m' / '15m' / '30m' / '1H', closes: a whole number 1-24 } -${got}`; }
  return `mode must be 'dailyOpenPts' or 'pdRange' -${got}`;
}
function planEndTrendLabel(c) { return !c ? 'off' : c.mode === 'dailyOpenPts' ? `dailyOpenPts ${c.pts}` : `pdRange (accepted after ${c.accept.closes} consecutive ${c.accept.tf} close${c.accept.closes === 1 ? '' : 's'})`; }
// the decision. cfg = CONFIG.planEndsAtTargetTrend (checked at startup), dir, entry = the price the bot would send, at = now, readAt = when the bars were requested,
// bars = { M5, M15, H1 }, alignDir = levelEvent.alignDir(the evaluated board) (+1 / -1 / 0). { allow, row } - row = the journal's numbers (both modes, as known).
function planEndTrendDecide({ cfg, dir, entry, at, readAt, bars, alignDir } = {}) {
  const r2 = x => Math.round(x * 100) / 100, mode = cfg && (cfg.mode === 'dailyOpenPts' || cfg.mode === 'pdRange') ? cfg.mode : null, B = bars || {};
  const row = { trendMode: mode, dailyOpen: null, pastDailyOpenPts: null, limit: mode === 'dailyOpenPts' ? cfg.pts : null, pdHigh: null, pdLow: null, beyondPd: null, accepted: null,
    alignedFull: (dir === 1 || dir === -1) && alignDir === dir };
  if (mode === 'pdRange') { row.accept = { tf: cfg.accept.tf, closes: cfg.accept.closes }; row.acceptedAt = null; }
  if (!mode || !(dir === 1 || dir === -1) || !Number.isFinite(entry) || !Number.isFinite(at)) return { allow: false, row };
  const cut = Number.isFinite(readAt) ? Math.min(readAt, at) : NaN, s = petDayStart(at), dO = petDailyOpen([B.M15, B.H1, B.M5], at);
  let past = NaN; if (dO) { past = (entry - dO.dailyOpen) * dir; row.dailyOpen = dO.dailyOpen; row.pastDailyOpenPts = r2(past); }
  const pd = petPriorDay(B.H1, at, cut);
  if (pd) { row.pdHigh = pd.high; row.pdLow = pd.low; row.beyondPd = dir > 0 ? entry > pd.high : entry < pd.low; }
  if (mode === 'dailyOpenPts') return { allow: Number.isFinite(past) && past >= cfg.pts - 1e-9, row };
  if (pd) { const acc = petAccepted(petSeries(B, cfg.accept.tf), PET_TF[cfg.accept.tf], s, cut, dir, dir > 0 ? pd.high : pd.low, cfg.accept.closes); row.accepted = !!acc; row.acceptedAt = acc ? acc.at : null; }
  return { allow: row.alignedFull === true && row.beyondPd === true && row.accepted === true, row };
}
function planEndTrendWhy(d, dir) {   // a block's reason, from its row
  if (!d || !d.trendMode) return 'the trend check could not be made';
  if (d.trendMode === 'dailyOpenPts') return d.pastDailyOpenPts === null ? `the 15:00 PT daily open is unknown (needs ${d.limit} pts past it)` : `${d.pastDailyOpenPts} pts past the 15:00 PT daily open ${d.dailyOpen} (needs ${d.limit})`;
  const side = dir > 0 ? 'high' : 'low', lvl = dir > 0 ? d.pdHigh : d.pdLow;
  return [`alignment ${d.alignedFull ? 'its way' : 'NOT its way'}`, d.pdHigh === null ? 'prior-day range UNKNOWN' : `price ${d.beyondPd ? 'beyond' : 'NOT beyond'} the prior-day ${side} ${lvl}`,
    d.pdHigh === null ? null : `${d.accepted ? 'accepted' : 'NOT accepted'} (${d.accept ? `${d.accept.closes} consecutive ${d.accept.tf} close(s)` : '?'} beyond it)`].filter(Boolean).join(', ');
}
// LOG ONLY (Mac's trend-day words, 10/31 ~05:00Z; nothing decides on these): the context row's dayTypeMac / pdRangeMac / htfBreak. dayTypeMac: TREND_UP = the
// alignment up + the price above the prior TradeDay's high + accepted (2 consecutive completed 5m closes above it this TradeDay); TREND_DOWN = the mirror; INSIDE =
// within the prior-day range; BREAKOUT_UNCONFIRMED = beyond it, not accepted or not aligned. pdRangeMac.runs = per timeframe the longest run of consecutive completed
// closes above the high / below the low this TradeDay (any other acceptance rule reads from them). htfBreak: the prior completed 4H candle (15:00 PT grid, from 1H
// bars), the prior TradeDay, the prior week (the 1W bar before the current one) and the prior month (the 1M bar of the TradeDay month before) - high / low, whether the
// price is beyond each, and the completed 1H closes of this TradeDay beyond each (closesAbove / closesBelow; closesBeyond = both; the 4H candle: only the 1H bars after it).
function petMacContext({ bars, htf, price, at, readAt, alignDir = 0 } = {}) {
  const out = { dayTypeMac: null, pdRangeMac: null, htfBreak: null }, why = [], B = bars || {}, H = htf || {};
  if (!Number.isFinite(at) || !Number.isFinite(price)) { out.macReasons = ['no price / time']; return out; }
  const cut = Number.isFinite(readAt) ? Math.min(readAt, at) : NaN, s = petDayStart(at), pd = petPriorDay(B.H1, at, cut);
  if (pd) {
    const runs = {}; for (const tf of PET_TFS) runs[tf] = petRuns(petSeries(B, tf), PET_TF[tf], s, cut, pd.high, pd.low);
    const accUp = !!petAccepted(B.M5, 300000, s, cut, 1, pd.high, 2), accDn = !!petAccepted(B.M5, 300000, s, cut, -1, pd.low, 2), side = price > pd.high ? 'ABOVE' : price < pd.low ? 'BELOW' : 'INSIDE';
    out.pdRangeMac = { high: pd.high, low: pd.low, side, aligned: alignDir === 1 ? 'UP' : alignDir === -1 ? 'DOWN' : 'NONE', acceptRule: '2 consecutive 5m closes', acceptedAbove: accUp, acceptedBelow: accDn, runs };
    out.dayTypeMac = side === 'INSIDE' ? 'INSIDE' : side === 'ABOVE' ? (alignDir === 1 && accUp ? 'TREND_UP' : 'BREAKOUT_UNCONFIRMED') : (alignDir === -1 && accDn ? 'TREND_DOWN' : 'BREAKOUT_UNCONFIRMED');
  } else why.push('pd: no complete prior TradeDay in the 1H history');
  const h1 = petDayBars(B.H1, 3600000, s, cut);
  const ref = (hi, lo, from) => { if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null; const cs = h1.filter(b => b.t >= from), a = cs.filter(b => b.c > hi).length, bl = cs.filter(b => b.c < lo).length;
    return { high: hi, low: lo, beyondHigh: price > hi, beyondLow: price < lo, closesBeyond: a + bl, closesAbove: a, closesBelow: bl }; };
  const g = new Map(); for (const b of (Array.isArray(B.H1) ? B.H1 : []).filter(b => b && [b.t, b.h, b.l].every(Number.isFinite) && b.t + 3600000 <= cut && b.t >= at - 2 * 86400000)) { const k = petH4Start(b.t); if (!g.has(k)) g.set(k, []); g.get(k).push(b); }
  const k4 = [...g.keys()].filter(k => k + 14400000 <= cut).sort((a, b) => a - b).pop();
  const h4 = k4 === undefined ? null : ref(Math.max(...g.get(k4).map(b => b.h)), Math.min(...g.get(k4).map(b => b.l)), k4 + 14400000);
  const ok = b => b && [b.t, b.h, b.l].every(Number.isFinite), wk = (Array.isArray(H.W) ? H.W : []).filter(b => ok(b) && b.t <= at).sort((a, b) => a.t - b.t), pw = wk.length > 1 ? wk[wk.length - 2] : null;
  const tdm = t => { const d = new Date(t + 3 * 3600000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }, pm = (Array.isArray(H.M) ? H.M : []).filter(b => ok(b) && tdm(b.t) === tdm(at) - 1).sort((a, b) => a.t - b.t).pop() || null;
  out.htfBreak = { h4, day: pd ? ref(pd.high, pd.low, s) : null, week: pw ? ref(pw.h, pw.l, s) : null, month: pm ? ref(pm.h, pm.l, s) : null };
  for (const [k, v] of Object.entries(out.htfBreak)) if (!v) why.push(`htfBreak.${k}: not in the history`);
  Object.assign(out, htfClock(at));   // lv1 r13.3.7e: minutesInto1H / minutesInto4H (PT wall time)
  if (why.length) out.macReasons = why;
  return out;
}
// lv1 r13.3.7e HTF CLOCK (pure): where t sits in its 1H / 4H candle by PT wall time (4H from 15:00 PT: 15 / 19 / 23 / 03 / 07 / 11), in whole minutes; and the
// 4H-open entry wait: { minutesInto4H, limit, h4Start } while minutesInto4H < n (the first n minutes), else null; n null = off (never).
function htfClock(t) { if (!Number.isFinite(t)) return null; const p = petParts(t), min = p.H * 60 + p.M; return { minutesInto1H: p.M, minutesInto4H: ((min - 900 + 1440) % 1440) % 240 }; }
function htfOpenWait(t, n) { if (n === null || n === undefined || !(Number.isInteger(n) && n >= 1 && n <= 30)) return null; const c = htfClock(t); return c && c.minutesInto4H < n ? { minutesInto4H: c.minutesInto4H, limit: n, h4Start: petH4Start(t) } : null; }
// ── PLAN-END TREND (pure end) ──
let petBarsReqAt = NaN;   // lv1 r13.3.7d: when the bars the plan-end trend check reads (the latest evaluation's) were requested
function tlBlockText(code, d = {}) {
  const w = d.dir === 1 ? 'LONG' : d.dir === -1 ? 'SHORT' : '';
  switch (code) {
    case 'COOLDOWN': { const tw = d.tradeDir === 1 ? 'LONG' : d.tradeDir === -1 ? 'SHORT' : w;
      if (d.win) return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: the ${tw} trade closed (win) ${d.since || 'recently'}, so new ${w} entries wait until ${d.winFloorMin ? `${d.winFloorMin} min after the win` : `the ${cooldownTfLabel(CONFIG)} candle closes`} (${d.until || ''}).`;   // 10/16
      if (d.tradeDir != null && d.tradeDir !== d.dir) return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: the ${tw} trade closed (loss) ${d.since || 'recently'}, so no new trade in either direction until the ${cooldownTfLabel(CONFIG)} candle closes (${d.until || ''}).`;   // 10/16 scope both
      return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: a ${w} trade was stopped out ${d.since || 'recently'}, so new ${w} entries wait until the ${cooldownTfLabel(CONFIG)} bar closes (${d.until || ''}).`; }
    case 'CONTROL_GATE': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped by the control gate: ${d.control === 0 ? 'neither side is in control' : `${d.control === 1 ? 'BUYERS' : 'SELLERS'} are in control`} (15m control score ${d.bias != null ? d.bias : '?'}, line +/-${d.threshold}); entries go only with the side in control.`;
    case 'PAUSED': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: you paused new entries from the phone until ${d.until || '?'}.`;
    case 'NO_CHASE': return `A ${w} ${d.entryType || ''} entry${d.entry != null ? ' at ' + Number(d.entry).toFixed(2) : ''}${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped as a CHASE: it is ${d.ePts} pts (${d.eAtr} x ATR ${d.atr}) past the ${d.swingLabel === 'LH' ? 'last lower high' : d.swingLabel === 'HL' ? 'last higher low' : (d.swingLabel || 'reference')} ${d.swing}, and the ${d.leg}-pt leg has retraced only ${d.retracePct}% (needs 38.2%) - wait for the pullback.`;
    case 'TP1_ALREADY_PASSED': return `A ${w} LIMIT entry at ${d.entry != null ? Number(d.entry).toFixed(2) : '?'}${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was not placed: price ${d.px != null ? Number(d.px).toFixed(2) : '?'} is already at or beyond its TP1 ${d.tp1 != null ? Number(d.tp1).toFixed(2) : '?'} (the move happened before the plan). Nothing was sent.`;   // round 4 (QA B5)
    case 'MAC_INTRABAR_ONLY': return `A ${w} MAC grade-${d.grade || '?'} signal on the 15m close was not entered: the same signal was already seen mid-bar in this bar (traded or blocked by a guard), and MAC grade ${(d.grades || ['A', 'B']).join('/')} signals are never entered twice (owner rule 10/14).`;   // round 4/5
    case 'MAC_CLOSE_FIRST_SEEN': return `A ${w} MAC grade-${d.grade || '?'} signal appeared for the first time at the 15m close (never seen mid-bar in this bar), so it is taken at the close (owner rule 10/14, O4). Not a block.`;   // round 5
    case 'FAR_LIMIT_SWITCH': return `The Levels ${w} ${d.entryType || 'LIMIT'} at ${d.limit != null ? Number(d.limit).toFixed(2) : '?'} was ${d.pts != null ? Number(d.pts).toFixed(2) : '?'} pts (${d.atrX != null ? d.atrX : '?'} x 15m ATR ${d.atr != null ? d.atr : '?'}) from price ${d.px != null ? Number(d.px).toFixed(2) : '?'} while MAC fired ${w} grade ${d.grade || '?'} intrabar: ${d.pending ? 'the resting order was cancelled (verified; a fill wins) and ' : 'it was not placed and '}MAC's MARKET entry was taken instead (far-limit switch, owner rule 10/14).`;   // round 4
    case 'NEWS_WAIT': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: ${d.news || 'a high-impact release'} came out at ${d.released || '?'}, and new entries wait for the first 15m bar after a release to close (${d.until || ''}) - trade the reaction, not the release.`;
    case 'PLAN_INVALIDATED': return `A ${w} entry at ${d.entry != null ? Number(d.entry).toFixed(2) : '?'} (stop ${d.stop != null ? Number(d.stop).toFixed(2) : '?'}) was not placed again: the same plan was cancelled at ${d.at || '?'} because price reached its ${d.kind === 'target' ? 'TP1' : 'stop'} before it filled. A new ${w} needs a fresh plan (a different entry/stop) from a later 15m close.`;
    case 'NEWS_RESTING': return `A ${w} ${d.entryType || 'resting'} entry${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was not placed: ${d.news || 'a high-impact release'} is due ${d.at || 'shortly'}, and resting entry orders are pulled before high-impact news (market entries are still allowed).`;
    case 'CONTROL_UNKNOWN': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: the 15m control score is UNKNOWN (no valid 15m Levels PRO evaluation), and an unknown score is never read as contested. No entry.`;   // 10-18b2c r2
    case 'FRESH_STOP_UNKNOWN': return `A ${w} ${d.entryType || ''} re-entry was not placed: after the last stop-out${d.since ? ' (' + d.since + ')' : ''} no finite price was known to anchor the fresh-stop rule (no exit stop, last close or plan stop), and no fresh 1m bar or live price has set one since.`;   // 10-18b2c r2
    case 'INVALID_ORDER': return `A ${w} ${d.entryType || ''} entry was not sent: ${d.why || 'not a valid order'}.`;   // 10-18b2c r2
    case 'FRESH_STOP': return `A ${w} ${d.entryType || ''} re-entry${d.entry != null ? ' at ' + Number(d.entry).toFixed(2) : ''} was not placed: its stop ${d.stop != null ? Number(d.stop).toFixed(2) : '?'} is not beyond the ${d.extreme != null ? Number(d.extreme).toFixed(2) : '?'} traded since the last stop-out${d.since ? ' (' + d.since + ')' : ''}.`;
    case 'ENTRY_GUARD': return `A ${w} entry was refused by the broker guard: ${d.reason || 'the broker already shows a position or working orders'}. No order was sent.`;
    case 'DAY_STOP': return `A ${w} signal${d.source ? ` (${d.source})` : ''} was skipped: the daily stop/floor was hit, so there are no new entries for the rest of the trading day.`;
    case 'DESYNCED': return `A ${w} signal was skipped: the bot's position tracking is out of sync with the broker and it is halted until restarted (flatten manually first).`;
    case 'NY_BLACKOUT': return `A ${w} signal${d.source ? ` (${d.source})` : ''} was skipped: the first ${d.minutes || 30} minutes after the NY open are a no-trade window.`;
    case 'ASIA_OPEN_BLOCK': case 'ASIA_BLACKOUT': return `A ${w} signal${d.source ? ` (${d.source})` : ''} was skipped: early Asia session is a no-trade window.`;
    case 'SIZE_BELOW_MIN': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: ${d.why || 'size below 3'} - minContracts 3: always 3 contracts or no trade.`;   // lv1 size1
    case 'RISK_CAP_SKIP': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped by the $ risk cap: its stop is ${d.stopPts} pts away, so even 1 contract would risk $${d.oneLotRisk} (more than the $${d.cap} cap per trade).`;   // 10/18
    case 'CONTROL_FILTER': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped by the control filter (no counter-trend entries): ${d.why || ''}.`;   // 10/18
    case 'TREND_FILTER': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped by the trend filter: ${d.why || ''}.`;   // 10/18
    case 'PULLBACK_VOID': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: the pullback went past 50% of the reference 15m candle, so the wave entry is void until that 15m candle closes (${d.why || ''}).`;   // 10/18 addendum 4
    case 'WAVE_WAIT': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} waits for the wave (no ${d.dir === -1 ? 'shorting a fresh low before a lower high' : 'buying a fresh high before a higher low'}): ${d.why || ''}.`;   // 10/18
    case 'LEVEL_BAN': return `A ${w} entry at ${d.entry != null ? Number(d.entry).toFixed(2) : '?'} was skipped: that level${d.levelName ? ' (' + d.levelName + ')' : ''} is banned for ${w} after ${d.banWhy || 'a stop-out'} at ${d.at || '?'}, until the 15m close at ${d.until || '?'}.`;   // 10/18
    case 'AUTH_BLOCK': return `A ${w} entry${d.entry != null ? ' at ' + Number(d.entry).toFixed(2) : ''} was NOT placed: BROKER AUTH FAILED (${d.why || 'the broker login is failing'}). No orders until the login works again.`;   // 10/18
    case 'REVERSAL_SKIP': return `No exhaustion reversal (${w}): ${d.why || ''}.`;   // 10/18 rule X
    case 'RECLAIM_SKIP': return `No reclaim re-entry (${w}): ${d.why || d.skip || ''}.`;   // 10/18
    case 'SESSION_CLOSE': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was skipped: session close - no new entries from ${d.from || '12:55'} PT until the ${d.reopen || '15:00'} PT reopen (Topstep requires flat by 13:10 PT; the bot flattens at ${d.flat || '13:05'} PT).`;   // 10/17
    case 'GATE': return `A ${w ? w + ' ' : ''}candidate (${d.source || 'mac/levels'}${d.grade ? ', grade ' + d.grade : ''}) did not trade: ${d.reason || 'a gate blocked it'}.`;
    case 'HTF_ALIGN': return `A ${w} level trigger${d.level ? ` at ${d.level}` : ''} was not traded: the 15m / 1H / 4H alignment (${d.align || '?'}) points ${d.alignDir === 1 ? 'UP' : d.alignDir === -1 ? 'DOWN' : 'neither way'} - levels-only entries trade only with it (lv1 r12.6)${d.alsoControl ? '; the 15m control gate refuses it too' : ''}.`;
    case 'RETEST_CHASE': return `A ${w} break-retest${d.level ? ` at ${d.level}` : ''} was not traded: the price ${d.entry} is ${d.past} pts past its retest close ${d.trigger} (limit ${d.limit}) - a retest is entered at the retest, never chased (lv1 r13.2).`;
    case 'HTF_OPEN_WAIT': return `A ${w} levels entry${d.level ? ` at ${d.level}` : ''}${Number.isFinite(d.levelPrice) ? ` (${d.levelPrice})` : ''} was not traded: it came ${d.minutesInto4H} min into a 4H candle, inside its first ${d.htfOpenEntryBlockMin} min (htfOpenEntryBlockMin; lv1 r13.3.7e).`;
    case 'PLAN_END_TARGET': return `A ${w} levels entry${d.level ? ` at ${d.level}` : ''}${Number.isFinite(d.levelPrice) ? ` (${d.levelPrice})` : ''} was not traded: its plan target was reached before the entry (planEndsAtTarget) and the trend allowance (${d.trendMode || 'unknown'}) did not hold - ${d.reason || 'no reason'}; the event ended (lv1 r13.3.7d).`;
    case 'PAST_LEVEL': return `A ${w} levels entry${d.level ? ` at ${d.level}` : ''}${Number.isFinite(d.levelPrice) ? ` (${d.levelPrice})` : ''} was not traded: the price ${d.entry} is ${d.pastPts} pts past the level (limit ${d.maxEntryPastLevelPts}) - too far past the level to enter (lv1 r13.3.7-candidate).`;
    case 'RETEST_ONCE': return `A ${w} break-retest${d.level ? ` at ${d.level}` : ''} was not traded again: one trade per retest (lv1 r13.2).`;
    case 'LEVELS_ONLY': return `A ${w} signal${d.source ? ` (${d.source}${d.grade ? ', grade ' + d.grade : ''})` : ''} was not traded: entries are levels only (lv1) - a named level event is required and MAC never opens a trade${d.reason ? ` (${d.reason})` : ''}.`;
    default: return `A signal was blocked (${code}).`;
  }
}
// ── TRADE-LOG HELPERS (end) ──

// Raw macDir/lvDir for DISPLAY, separate from decideSignal()'s entry gating —
// decideSignal() returns null on a MAC/Levels CONFLICT (agreement has traded since the 2026 re-test), which is exactly the case worth SHOWING the user, not
// hiding. The bias panel should say "MAC says X, Levels says Y" even on bars
// the bot itself declines to trade — that's the whole point of a "what is
// the bot thinking" readout. Actual entries still go through decideSignal()
// alone; this never feeds a trading decision, only the terminal's display.
function computeOverallBias(mac, lv, config) {
  // Kept consistent with decideSignal()'s hardBlock check (lib/signal.js) —
  // otherwise this display could show "LEAN BULL via MAC Trap" on a bar the
  // bot would actually never trade because MAC Trap's own late-buyer/seller/
  // VIX/news gate is up.
  const macOk = config.macStrongRequired === false || mac.activeScore >= config.minMacScore;   // 10-18b1 (display parity)
  const macDirRaw = ((mac.activeDir === 1 && macOk) || mac.biasStr === 'STRONG BULL') ? 1
    : ((mac.activeDir === -1 && macOk) || mac.biasStr === 'STRONG BEAR') ? -1 : 0;
  const macDir = (config.levelsOnlyEntries || mac.hardBlock) ? 0 : macDirRaw;   // lv1 r2: MAC is never a trading direction
  const lvGateOk = lv.alignmentStatus !== 'UNKNOWN' && (!config.requireLevelsAlignment || lv.alignedFull);
  const lvDirAny = !lvGateOk ? 0 : lv.sigLong ? 1 : lv.sigShort ? -1
    : lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1
    : (config.levelsTriggerRequired === false && lv.biasStr === 'BUYERS IN CONTROL') ? 1 : (config.levelsTriggerRequired === false && lv.biasStr === 'SELLERS IN CONTROL') ? -1 : 0;   // 10-18b1 (display parity)
  const lvDir = lvDirAny !== 0 && config.levelsOnlyEntries && config.requireLevelsAlignment && config.levelsAlignWithTrade && lvDirAny !== levelEvent.alignDir(lv, levelEvent.alignRequired(config)) ? 0 : lvDirAny;   // lv1 r12.6 (display parity with lib/signal.js)
  let label, tradable = false;
  if (macDir !== 0 && lvDir !== 0) {
    // 2026-10-13 label fix (display only): decideSignal() TRADES agreement (lib/signal.js), so the label says so; only a conflict stands down.
    if (macDir === lvDir) { label = `STRONG ${macDir === 1 ? 'BULL' : 'BEAR'} (MAC + Levels agree — tradable)`; tradable = true; }
    else label = 'CONFLICTING (bot stands down)';
  } else if (lvDir !== 0) {
    label = `LEAN ${lvDir === 1 ? 'BULL' : 'BEAR'} (via Levels PRO)`; tradable = true;
  } else if (macDir !== 0) {
    label = `LEAN ${macDir === 1 ? 'BULL' : 'BEAR'} (via MAC Trap)`; tradable = true;
  } else {
    label = 'NEUTRAL';
  }
  return { label, tradable, macDir, lvDir };
}

// Must match the validated Sunday config in backtest.js's LEG3_CONFIG exactly.
// If you change one, change both, or the two stop being the same experiment.
const CONFIG = {
  // OWNER FORWARD-TEST 2026-10-11, NOT BACKTESTED (JayMac: "no need to backtest, I want to forward test"). Four changes, each
  // one line to roll back (old value in each comment):
  // minMacScore 7 -> 6. OLD VALUE: 7. Rollback: minMacScore: 7. Score 6 is MAC entry-grade 'C' (5-6 = C, 7-8 = B, 9+ = A);
  // CONFIG.blockMacGradeB (unchanged) still blocks mac-sourced grade B (7-8), so the mac-sourced mix is now grade A (9+) plus
  // grade C (exactly 6, not in Asia hours because of blockGradeCAsia) - see README.md for the full table.
  minMacScore: 6,
  requireLevelsAlignment: true,
  // sessionAnchor (2026-10-14, Mac: "3:00 PT like the chart is good, and the levels code has the logic for the time to change the
  // levels"). 'legacy' (shipped = today, byte-identical): Levels PRO's day (PDH/PDL/PDC, Daily Open, IB) rolls at PT midnight and
  // its VWAP restarts at 06:30 PT. 'cme': the day rolls at 15:00 PT (17:00 CT, the CME session open, DST-proof) exactly like the
  // Pine's newDay = ta.change(time("D")) on TradingView, and VWAP restarts at 15:00 PT like his chart's session VWAP
  // (lib/levelsPro.js opts.sessionAnchor). Plan: hft/ops/tests/session-anchor.md. NOT pass-rate tested yet. Rollback: 'legacy'.
  // r9.15 OWNER DECISION 10/21 (Mac: "Thats the boundary we should be using for the bot as well" / "Bot and indicator should be matching levels"):
  // shipped default is now 'cme' = 15:00 America/Los_Angeles (DST-aware) for BOTH Levels PRO and MAC Trap (lib/macTrap.js opts.sessionAnchor).
  // VWAP is anchored separately and keeps the indicator's calendar 06:30 PT reset (lib/levelsPro.js vwapAnchor 'calendar-0630', Pine v14 388-396).
  // Rollback: "sessionAnchor": "legacy" in config-local.json (PT-midnight day, byte-identical to r9.14.1).
  sessionAnchor: 'cme',
  // r9.16 vwapBuildTf (Mac 2026-10-21 15:15 PT "Switch to 5 minute build"): '5m' = Levels PRO VWAP built from the 5m series like Mac's 5m chart
  // (same hlc3 x volume formula and resets); 'chart' = built from the evaluated chart's own bars (r9.15.1). Rollback: "vwapBuildTf": "chart".
  // MAC Trap's VWAP/POC are NOT changed by this setting (scope: Levels PRO only, pending Mac's call on MAC Trap).
  vwapBuildTf: '5m',
  // levelsUsePersistedPlan (2026-10-09, built+backtested, shipped 2026-10-10
  // after JayMac: "the levels pro trigger is preventing us from getting
  // some longs we could've gotten") — swaps the default sigLong/sigShort
  // (rising-edge only: fires on the exact bar a grade-B+ plan first turns
  // valid, never again) for planLong/planShort, which stays true for as
  // long as the plan remains valid — a qualifying setup that's still on the
  // board a few bars later can still fire, not just the bar it first
  // qualified. Backtested clean win vs the rising-edge default: PF 1.36 vs
  // 1.35, total $228,842 vs $221,209 (5y), pass(1yr) 67.2% vs 66.0%, bust
  // 32.8% vs 34.0% — built and validated same day as the fix, just never
  // actually flipped on until now.
  levelsUsePersistedPlan: true,
  // 10-18b1 (Mac's ruling 10/16 09:06 PT: REMOVE "MAC strong" and "Levels trigger"; both read only by lib/signal.js decideSignal()).
  // macStrongRequired false = MAC's direction counts at ANY score (not only minMacScore+); hardBlock, the conflict skip and every later gate
  // stand. levelsTriggerRequired false = when the 15m/1h/4h alignment holds, Levels' bias side (BUYERS/SELLERS IN CONTROL) counts without
  // a plan. Rollback (each alone): bash set-removal.sh mac off / bash set-removal.sh levels off (= true, the 10-18 rule, byte-identical).
  macStrongRequired: false,
  levelsTriggerRequired: true,   // lv1 (Mac 10/27 "NO LEVEL, NO TRADE"): a Levels PRO trigger (plan / sig / STRONG control) at a named level is required; a bias label alone is not
  levelsOnlyEntries: true,   // lv1: levels only - MAC has no input (never opens, relabels, replaces or vetoes a trade; lib/signal.js); MAC-only candidates are journaled LEVELS_ONLY
  levelEvents: true,   // lv1: a sweep -> reclaim / loss at a named level on completed 5m / 3m bars is a Levels plan when Levels PRO has none (lib/levelEvent.js)
  // lv1 r13.3.4 (Mac 10/30, signed: plans-1030/htf-levels): the monthly and quarterly levels - PMH / PML / PMO, CMO, CMH / CML, QO, QH / QL, PQH / PQL - from the
  //   bot's own 1M / 1D bars, tradeable exactly like the weekly levels and on top of the hierarchy (lib/levelEvent.js htfLevels). false = r13.3.3's levels.
  htfLevels: true,
  // lv1 r13.3.4 lp1 (Mac 10/30 "add lp1 to r13.3.4"; shipped OFF): the 15m control score computed as Mac's Pine Levels PRO computes it. 'off' = the bot formula
  //   (momentum and progress over the 1H ATR, every level counted; exactly as before); 'pine' = D1 momentum / progress over the chart's own ATR(14) (floored at
  //   4 ticks) + D2 levels within 2 ticks merged into the more important one (Pine dedupe_lvl), on every Levels PRO evaluation. It moves the control gate, the
  //   plan-grade penalties and the STRONG trigger; the 0.15 line was measured on the bot formula (MacEntry re-measures it before 'pine' goes live). set-parity.sh.
  levelsParity: 'off',
  // lv1 r13.3.5 (Mac 10/30, agreed; plans-1030/tp1-from-fill): with the scale-out runner on, TP1 = the ACTUAL fill +/- the planned TP1 distance on every fill
  //   (the slip guard's keep included; the stop handling unchanged). false = r13.3.4: a fill the guard keeps leaves TP1 at its planned price. set-tp1fill.sh.
  tp1FromFill: true,
  // lv1 r13.3.5 (shipped OFF): a live level event ends for good ('target-reached') once a price seen after its birth trades at or through its plan target
  //   (a projected one included) before an entry: the plan is spent. false = an event ends on a close back across, a VWAP reset or 30 min. set-planend.sh.
  planEndsAtTarget: false,
  // lv1 r13.3.7-candidate (MacArthur 10/31, losing points #1 / #2; shipped OFF): a levels entry more than this many points past its level - (entry - level
  //   price) x dir at the price the bot would send - is skipped (trade_block PAST_LEVEL). null = off (every entry as in r13.3.5). Replay-gated before any use.
  maxEntryPastLevelPts: null,
  // lv1 r13.3.7d (MacArthur / Mac 10/31; shipped OFF): with planEndsAtTarget ON, an entry after its event's plan target was reached is still taken on a trend -
  //   { mode: 'dailyOpenPts', pts: 75 } = the entry price at least pts past the 15:00 PT daily open in its direction; { mode: 'pdRange', accept: { tf: '5m', closes: 2 } }
  //   = the 15m / 1H / 4H alignment its way + the price beyond the prior TradeDay's high (long) / low (short) + `closes` consecutive completed `tf` closes beyond it
  //   this TradeDay. Otherwise the event ends as planEndsAtTarget says (trade_block PLAN_END_TARGET). null = off (r13.3.5's planEndsAtTarget exactly). Replay-gated.
  planEndsAtTargetTrend: null,
  // lv1 r13.3.7e (Mac 10/31 ~05:30Z; shipped OFF): no NEW levels entry in the first this-many minutes of a 4H candle (15:00 PT anchor: 15 / 19 / 23 / 03 / 07 / 11 PT,
  //   wall time) - trade_block HTF_OPEN_WAIT. null = off. Whole minutes 1-30. Replay-gated.
  htfOpenEntryBlockMin: null,
  levelEventControl: 'require',   // lv1: 'require' = a level-event trigger passes the 15m control gate like every entry; 'exempt' = it skips it (Mac's ruling)
  levelsAlignWithTrade: true,   // lv1 r12.6 (Mac 10/28): a levels-only entry needs the 15m / 1H / 4H alignment pointing ITS way (15m+ 1H+ 4H+ = longs only, all - = shorts only); false = all three agreeing either way (r12.5)
  levelEventIntrabar: true, levelEventIntrabarBufPts: 1,   // lv1 r12 (Mac 10/28: "check the bars intrabar for an entry"): in intrabar mode a level event is also judged on the FORMING 5m / 3m bar every poll - the live price at least 1 pt back across the level after the sweep (lib/levelEvent.js); false = completed bars only
  levelRetest: false,   // lv1 r13 (Mac 10/28 AM: "yes I want the break and retest entry path"): a named level price BROKE (closed through), ACCEPTED (held), LEFT (10+ pts) and came BACK to - the first retest that holds is a level event (BREAK-RETEST, lib/levelEvent.js); every entry gate still applies. r13.2: shipped OFF (replays 10/27-10/28: 10 retest trades, -$1,007); set-retest.sh on = true
  levelStopMaxFromFillPts: 50,   // lv1 r13.6.2 STOP CAP FROM THE FILL (Mac 10/29; MacRisk 6489686540 S2b-50): a levels entry's resting stop is moved in to at most this many points from the ACTUAL fill once it is filled (verified replace; never inside the session floor: the cap is raised to it); the size stays what the structural stop gave (never sized up). null = off = r13.5.3
  levelRetestChasePts: 5,   // lv1 r13.2 (replays 10/27-10/28: 8 of 10 retest trades entered 5.5-59 pts past the retest close; three retests were traded twice): a BREAK-RETEST is entered only within 5 pts of its retest close, never chased, and only once
  // 10-18b1 CONTROL GATE (Mac's control doctrine 10/16 09:19 PT: "we want trades when one or the other is in control... The control means
  // everything."). true = every entry (MAC or Levels) must go WITH the side in control on the 15m Levels PRO buyer/seller-control score:
  // |score| < controlGateMin (contested / leaning) = no entry; the other side = no entry (journal trade_block CONTROL_GATE, no push). A change
  // of the controlling side is journaled (CONTROL_FLIP) with one info push, at most one per 15m bar. controlGateMin 0.22 = Levels PRO's own
  // "IN CONTROL" line (ctrlThresh). Rollback: bash set-removal.sh control off (= false: no gate, no flip rows). bash set-removal.sh control-min 0.10.
  controlDirectionGate: true,
  controlGateMin: 0.22,   // lv1 r13.3.3-ctl1: config-local.json may set it, a number from 0.05 to 0.45 (tools/set-control.sh); lib/entryControl.js locks it at startup
  // 10-18b2c TEAM DECISION 1 (MacLedger 6227766281; Mac holds veto by notice): CONTESTED (|15m control score| < controlGateMin) no longer refuses an
  // entry. With every other gate passed, the entry is taken at the MINIMUM size: 1 contract, and only if 1 contract fits the $ risk cap on its stop
  // (sizeForStop; 0 = the RISK_CAP_SKIP as before). Same side = size unchanged; the other side = still refused (direction selection unchanged).
  // false = the b1 / b2a rule (contested = no entry).
  // Week 1 policy is locked after local overlay loading, until explicitly changed in source.
  controlContestedMinSize: false,
  // OWNER FORWARD-TEST 2026-10-11, NOT BACKTESTED. OLD VALUE: the 4H anchor was always required (macTrap.js default require4h:true).
  // macRequire4hAnchor false -> MAC Trap no longer needs the 4H reclaim+EMA cross or an RSI turn before it will name a direction
  // (passed as opts.require4h to evaluateMacTrap). The 4H RSI veto, the multi-timeframe (15m/30m/1h) RSI veto and the ADX chop
  // skip still apply. Rollback: macRequire4hAnchor: true.
  macRequire4hAnchor: false,
  // tfMode (2026-10-14, Mac: "the 4hr + needs to be dependent on where we are on the open control line not the damn EMA", then
  // "test a version with the 15m/30m using the open as well"). One switch per timeframe, 'ema' (shipped = today) or 'open':
  //   'open' = that timeframe is + when price is above the open of its CURRENT bar (the control line), - when below; no EMA.
  //   It applies everywhere that timeframe is used: the Levels alignment row (15m / 1h / 4h, and 30m when align30 is on;
  //   lib/levelsPro.js alignModeByTf) and the MAC Trap dot (4H / 1H / 30m / 15m; lib/macTrap.js tfDotModeByTf).
  //   'ema' = today: Levels slot = that TF's close vs its EMA21; MAC dot = above its open AND EMA9 > EMA21.
  // Test plan: hft/ops/tests/h4-control-line.md (32-combo factorial). Rollback: every key 'ema'.
  tfMode: { m15: 'ema', m30: 'ema', h1: 'ema', h4: 'ema' },
  // align30: add the 30m to the Levels alignment row (15m / 30m / 1h / 4h; "fully aligned" then needs all four). Shipped false = today.
  align30: false,
  // ALIGNMENT FRESHNESS (Mac 10/19 ~5:00 PT, option 2: "2"; replaces the provider-witness requirement, which Topstep's bars cannot supply).
  // 'read-age-60s' (the only accepted value; the 60 s limit is fixed in lib/alignmentFreshness.js): a Levels alignment slot on the CURRENT
  // decision bar is CURRENT when its bars and the chart bars came from the current successful poll, completed <= 60 s ago (wall AND
  // monotonic clock), and both bars start exactly at the expected current period start; otherwise UNKNOWN (Levels entries held, as before).
  // Re-checked at every entry seam against the live poll state. Any other value (e.g. null) = the witness-only rule. Rollback: null.
  // r9.10 (Mac 10/20 ~10:30 PT: "It's either aligned or not aligned very similar to the indicator"): 'measured' = binary alignment, price vs
  // each timeframe's current-period open, no read-age UNKNOWN (lib/levelsPro.js alignMeasured; lib/alignmentRuntime.js 'measured'). The
  // live bot recorded NOT aligned on clearly aligned boards (10/20 07:24:52-07:28:29, 07:47; cause not logged - read-age UNKNOWN suspected). Rollback: 'read-age-60s'.
  alignmentFreshnessPolicy: 'measured',
  // tfModeApplyToMac (2026-10-14, Mac: "make that 4HR change in the code for the HTF alignment filter ... now"): true = a timeframe's
  // tfMode also drives MAC Trap's dot for that timeframe (the 32-combo test's definition); false = tfMode changes ONLY the Levels
  // PRO HTF alignment row. Mac's live setting is { tfMode: { h4: 'open' }, tfModeApplyToMac: false }.
  tfModeApplyToMac: true,
  // OWNER FORWARD-TEST 2026-10-11, NOT BACKTESTED. OLD VALUE: only the 15m chart was evaluated (equivalent to ['M15']).
  // levelsTriggerTimeframes = priority order of the chart timeframes whose Levels PRO output may supply the trigger (persisted
  // plan, or STRONG BUYER/SELLER CONTROL bias, each behind the usual alignment gate). The FIRST timeframe in the list that fires
  // wins (lib/levelsTrigger.js pickLevelsTrigger); if none fires the 15m output is used unchanged. 'M5'/'M3' add one
  // evaluateLevelsPro run each per evaluation and, in intrabar mode, one extra retrieveBars call each per poll (see
  // refreshAndEvaluate). Rollback: levelsTriggerTimeframes: ['M15'] (no extra fetches, no extra evaluations).
  levelsTriggerTimeframes: ['M15', 'M5', 'M3'],
  // Reverted 2.0x -> 1.0x (30pt -> 15pt) on 2026-09-21 after finding and
  // fixing a real bug: mac.hardBlock (MAC Trap's own late-buyer/seller/VIX/
  // news gate) was never checked before taking a mac-only trade, letting the
  // bot chase already-extended moves. Once that bug was fixed, plain 1.0x
  // beat every stop-distance alternative tried: avg/day $229.04, worst day
  // -$180, PF 2.23. See backtest.js's LEG3_CONFIG comment for the full
  // history and numbers.
  leg1StopCapMultiple: 1.0,
  // Session-aware NY stop (2026-09-21 trade review) — VALIDATED. backtest.js's
  // SESSION BREAKDOWN found leg1's win rate during NY (06:30-13:00 PT) was
  // only 47.1% with avg pnl -$1.76/trade, vs 64-68%/+$8-11 for London and
  // Asia at the SAME 1.0x/15pt stop — NY's wider bar ranges were wicking out
  // trades the other sessions wouldn't have. A global wider stop (the STOP
  // ROOM SWEEP) already failed on avg/day because it wasted room on sessions
  // that didn't need it. Widening ONLY the NY session's stop instead: 2.5x
  // was the clean peak of a monotonic 1.5x->3.5x sweep — NY win rate hit
  // 81.3%/+$12.77/trade (best of any session), AND the whole book improved
  // on every metric at once (avg/day $219.81->$268.11, worst day -$240->
  // -$195, PF 2.09->2.48) — a rare case with no tradeoff to weigh. 3.0x/3.5x
  // plateaued and started giving a little back, confirming 2.5x as the peak,
  // not just the last value tried.
  nyStopMultiple: 2.5,
  // Smart-stop-hold: TRIED AND REJECTED on 2026-09-21, kept here disabled
  // rather than deleted since the code (LiveStateMachine.maybeSmartHoldExit,
  // simulate3leg.js's smartHoldLiveStyle) is still correct and may be worth
  // revisiting with a faster classification source. Backtested honestly
  // (live-style mechanic, realistic fine-bar exit pricing) it UNDERPERFORMED
  // doing nothing: avg/day $144.40 vs plain 1.0x's $229.04, worst day -$334.50
  // vs -$180, PF 1.67 vs 2.23. Root cause: the Sept 21 wick that started this
  // whole investigation happened WITHIN a single 15m candle (swept and
  // reclaimed in ~6 minutes) — Levels PRO's SWEEP/FAIL classification for
  // that candle doesn't exist until the candle closes, by which point a real
  // resting stop would already have filled. The backtest-only version that
  // looked great (PF 2.90) only works because it evaluates with hindsight
  // after the bar closes — not available to a live, real-order system. A
  // real fix would need a genuinely faster (sub-15m) classification source,
  // not a config change.
  smartStopHold: false,
  sweepGraceMultiple: 2.5,
  // Raised 30 -> 200 (2026-09-22 spec): a real bank per trade, not $30/contract
  // — his own words, repeated: "$200 per trade, not $30 per trade." This is
  // now a TOTAL dollar goal for whatever closes at leg1, not a per-contract
  // one — see target1Points below, which divides by leg1Size to get there.
  target1DollarGoal: 200,
  target2Multiple: 3.0,
  // Off-peak (Asia + London — everything outside the same 06:30-13:00 PT
  // inNySession window nyStopMultiple uses above) target override
  // (2026-10-08, validated against the full 5-year sample). The 5y session
  // breakdown showed leg1's target1 hit rate during NY was 41.1% vs only
  // 29.0% in Asia and 26.3% in London — NY's bigger range actually reaches
  // the $200 target, the slower off-peak tape mostly doesn't, so trades
  // taken there were chasing a target the session's own range rarely
  // delivers. Shrinking off-peak's target1DollarGoal/target2Multiple lets
  // the SAME setups bank smaller, more-often-reached wins instead. A
  // $125-$175 x 1.75-2.25x grid was uniformly BETTER than the $200/3.0x
  // baseline across that whole range (avg/day $76.66 -> $78-84, worst day
  // flat or improved, more positive days 651/1272 -> ~678/1275) — not a
  // single lucky cell. $160/2.0x sits in the middle of that plateau: avg/day
  // $83.20 (+$6.54), worst day -$873.14 (vs -$881.12 baseline, slightly
  // better), posDays 679/1275 vs 651/1272.
  offPeakTarget1DollarGoal: 160,
  offPeakTarget2Multiple: 2.0,
  // VALIDATED (2026-10-08) against the full 5-year sample. A source x grade
  // x session breakdown found mac-sourced grade B (no Levels PRO backing)
  // is net-negative (n=2203, PF=0.96, -$13,853/5y), and grade C during Asia
  // hours is too (n=311, PF=0.90, -$3,552/5y) — see lib/signal.js's comment
  // at the matching filter for the full numbers. Blocking both: avg/day
  // $83.20 -> $115.32, rawPF 1.16 -> 1.23, worst day improved.
  // ROUND 4 (owner order 10/14): OFF. MAC grade B now trades (intrabar only, see macIntrabarOnlyGrades). set-macintrabar.sh off turns the block back ON.
  blockMacGradeB: false,
  // 10-18b1 (Mac 10/16 09:13 PT: "no grade blocks anymore"): the Asia grade-C block is OFF. OLD VALUE: true. Rollback: bash set-removal.sh grades off.
  blockGradeCAsia: false,
  // SHIPPED PER EXPLICIT USER OVERRIDE (2026-10-08) — all 3 bundle-spec
  // changes below (blockMacCompression, asiaStructuralTarget2,
  // trailStepPoints) turned on together, matching the spec's ALL-FIVE
  // combined config. The merge gate's own 5-year numbers for this exact
  // combination: avg/day $76.66 -> $133.98, worst day -$881 -> -$1,212 (a
  // real breach of the -$1,000 ceiling set earlier this session, driven
  // almost entirely by trailStepPoints — see lib/liveStateMachine.js's
  // maybeRatchetTrail comment for the mechanism). Flagged once with the
  // full numbers; shipping as asked rather than holding it back.
  // OWNER FORWARD-TEST 2026-10-11, NOT BACKTESTED: volume-compression entry filter REMOVED. OLD VALUE: true (it had been shipped
  // 2026-10-08 per explicit user override, see the note above). Rollback: blockMacCompression: true. With false the
  // 'MAC Trap volume not compressed' checklist row disappears.
  blockMacCompression: false,
  asiaStructuralTarget2: true,
  asiaTarget2MinPoints: 40,
  asiaTarget2MaxPoints: 150,
  asiaTarget2FallbackPoints: 150,
  trailStepPoints: 10,
  // Stop-cap reference (2026-09-23 fix): capStop()'s whole job is "never let
  // a structural stop sit wider than the account's real risk tolerance" —
  // that tolerance doesn't change just because TP1 got leg1Size-aware.
  // target1Points now SHRINKS as leg1Size grows (a 15-lot's leg1Size=6 needs
  // less distance per contract to reach $200 than a 5-lot's leg1Size=3
  // does), which would make BIGGER trades get a TIGHTER stop cap if capStop
  // kept using target1Points directly — backwards, and a direct violation of
  // "stops stay at structural levels, unchanged." This keeps the ORIGINAL
  // flat $30/contract distance as the cap's own reference, completely
  // decoupled from whatever target1DollarGoal is set to for profit-taking.
  stopCapDollarsPerContract: 30,
  // Raised 150 -> 1000 on 2026-09-21, per your own call: this is a risk
  // allowance, not a performance lever — no day in backtested history has
  // ever lost anywhere close to $1000 (worst was -$450 across every config
  // tested tonight), so this doesn't change historical numbers at all. It's
  // meant to stop the bot from shutting itself down for the day after one
  // early bad stretch, so it actually gets enough opportunities to trade.
  // Still well under this account's real Daily Loss Limit ($2,300) and only
  // ~22% of Max DD ($4,500) — those are the terminal's separate, self-entered
  // account-rule numbers, untouched by this.
  // 2026-09-22: raised 1000 -> 2700 and switched from per-symbol to
  // account-wide (was a $1,000-per-symbol breaker, worst case $2,000
  // combined across MNQ+MGC).
  // 2026-09-24: briefly brought back to $1,000, then DISABLED (null) for the
  // practice forward test — user wants the untruncated day-P&L distribution
  // (true worst-day, true variance) to validate against backtests that were
  // run with no daily stop. This was a clean disable, not a deletion.
  //
  // 2026-10-07: RE-ENABLED at $350, paired with a new TRAILING PROFIT FLOOR
  // (trailArmThreshold/trailGiveback below), after the user set a hard
  // constraint: "We can't have a worse day beyond $1000 because that will be
  // my DLL." A 5-year offline backtest (scratchpad/backtest5y/, reusing the
  // live evaluateMacTrap/evaluateLevelsPro/simulateAllTimeframes3Leg code
  // unmodified) found the real worst-day/configured-threshold relationship
  // isn't 1:1 — a "block new entries" rule can't stop the loss on a trade
  // that's ALREADY OPEN when the threshold is crossed — and located a sharp
  // cliff at configured $500->$550 (real worst day jumping from safely under
  // $1,000 to well over it), consistent across every position-size variant
  // tested. $350 sits comfortably below that cliff with room for the
  // baseLeg1Extra=1 resize below. See CONFIG-RECOMMENDATION-ANALYSIS.md
  // (scratchpad/backtest5y/) for the full writeup.
  //
  // The floor is flat at -dailyStopLoss until the day's peak account-wide
  // realized P&L reaches trailArmThreshold, then RISES to
  // (peak - trailGiveback) — banked profit above the arm point is locked in,
  // not given back to a flat stop. trailArmThreshold/trailGiveback == null
  // reproduces the exact old flat-stop behavior (see the dailyFloor calc in
  // the main loop). Checked via dayRealizedPnlAccountWide (unfiltered by
  // contractId) instead of the per-symbol dayRealizedPnl used for display.
  // See refreshRealDayPnl() and dayPeakPnlAccountWide in the main loop.
  //
  // 2026-10-09: DISABLED again (null) — JayMac's explicit call: no point
  // running a bot-side daily stop while the strategy is still proving
  // itself; he'll set the risk cap manually on the platform once it's
  // shown it's profitable around the clock. dailyFloor() (below) returns
  // null whenever dailyStopLoss is null, which makes the dayBlocked check
  // in the main loop permanently false — no circuit breaker at all right
  // now, by design, not an oversight. The $350/arm-$250/giveback-$100
  // numbers above are preserved in history (and in
  // CONFIG-RECOMMENDATION-ANALYSIS.md) for whenever a bot-side floor comes
  // back.
  dailyStopLoss: null,
  // Arm the trailing floor once the day banks $250 realized (account-wide);
  // once armed, never give back more than $100 of the peak. Both validated
  // in the same backtest pass as dailyStopLoss above — see
  // CONFIG-RECOMMENDATION-ANALYSIS.md. Set either to null to disable the
  // trail and fall back to the flat -dailyStopLoss floor. Moot right now
  // since dailyStopLoss itself is null (see its own comment, 2026-10-09).
  trailArmThreshold: null,
  trailGiveback: null,
  blockNyOpenMinutes: 30,
  // MORNING HOLD (Mac 10/19: "completely flat at that time, no orders" 06:00-07:10 PT; "the code ... needs to automatically pause the bot";
  // "Can we edit the code to close any entries prior to 6am?"). From (from - flattenLeadMin) to `to` PT: no new entries of any kind, a resting
  // entry is cancelled, and an open position is closed at market by the SAME state-machine sessionFlatten() the 13:05 session close uses
  // (verified cancels, two zero reads, stops put back on failure), with an urgent alert if not flat 90 s after the flatten start. null = off.
  morningHold: { from: '06:00', to: '07:10', flattenLeadMin: 35 },   // Mac 10/19: "close everything at 5:30am ... keep it locked up till 7:10am", then "5:25 makes more sense" (clear of the 05:30 PT / 8:30 ET release)
  asiaBlockUntilMinutes: 17 * 60,
  // SESSION CLOSE (10/17 package; owner approved 10/14: "No need entries EOD, yes please"). Topstep: "All positions must be closed by 3:10 PM CT every weekday" and
  // "Avoid opening new positions after 3:08 PM CT - Risk Managers begin flattening at that time" (help.topstep.com/en/articles/8284206). 3:10 PM CT = 13:10 PT.
  // No NEW entries from sessionNoEntryFromPt until the 15:00 PT reopen (a resting entry is cancelled then: verified cancel, a fill wins); at sessionFlattenPt any open
  // position is closed at market (verified cancels of the protective orders first, then one market order, flat confirmed, every leftover order swept); an urgent phone
  // alert when still not flat sessionFlattenAlertSec after sessionFlattenPt. Weekdays only, PT wall clock via Intl (DST-safe). lib/sessionClose.js.
  // sessionEarlyCloses: CME holiday early closes [{ date:'YYYY-MM-DD', flattenPt:'HH:MM', noEntryFromPt?:'HH:MM', note }] - SHIPPED EMPTY (not verified on cmegroup.com; TODO).
  // Switch: set-session.sh on|off|<noentry>/<flatten>|early <date> <HH:MM>|early-clear.
  sessionClose: true,
  sessionNoEntryFromPt: '12:55',
  sessionFlattenPt: '13:05',   // lead decision 10/14: 3 min before Topstep's risk desk starts flattening at 3:08 PM CT (13:08 PT)
  sessionFlattenAlertSec: 90,
  // ROUND 2: Topstep holiday trading hours (https://help.topstep.com/en/articles/13350348-topstep-holiday-trading-hours, read 2026-10-14): "Close all positions
  // 15 minutes before early close" (open positions at the cutoff are auto-liquidated). Close-by times (CT -> PT): 11/26 11:45 CT = 09:45 PT; 11/27 and 12/24 12:00 CT = 10:00 PT.
  // The bot flattens 5 min before Topstep's close-by and stops new entries 10 min before that. 12/25/2026 and 01/01/2027: markets closed (nothing to do).
  // RE-CHECK the Topstep page the week before each date. Edit with set-session.sh early <YYYY-MM-DD> <flatten HH:MM> [<noentry HH:MM>] | early-clear.
  sessionEarlyCloses: [
    { date: '2026-11-26', noEntryFromPt: '09:30', flattenPt: '09:40', note: 'Thanksgiving (Topstep close-by 11:45 CT = 09:45 PT)' },
    { date: '2026-11-27', noEntryFromPt: '09:45', flattenPt: '09:55', note: 'Day after Thanksgiving (Topstep close-by 12:00 CT = 10:00 PT)' },
    { date: '2026-12-24', noEntryFromPt: '09:45', flattenPt: '09:55', note: 'Christmas Eve (Topstep close-by 12:00 CT = 10:00 PT)' },
  ],
  // ROUND 2 (QA F-FLAG): the session flag count uses MAC with "Require 4H Anchor" ON, the Pine v4.2 default, so it matches Mac's chart. DISPLAY ONLY: the bot's
  // trading MAC keeps macRequire4hAnchor (false). Set false to count the bot's own trading MAC instead.
  flagsRequire4hAnchor: true,
  // 2026-09-22: deliberately shorter than the backtest's pendingExpireBars=20
  // (5 hours) — that value came from bar-count math, not a live judgment
  // call. If price hasn't come back to the entry within 30 minutes, the
  // setup is considered too far gone to still be worth taking.
  // 2026-10-16 owner order: 15 minutes (was 30), LIVE and paper. config-local "pendingExpireMs" (set-pending-expiry.sh <5-30 minutes>) changes it.
  // (Before r9.5 an EXPIRED plan could be placed again on the next 15m close; r9.5 bans it — see below.)
  // OWNER CHANGE 10/19 ~9:20 PM PT (Mac: "after 5 mins no entry it should cancel the pending orders and see if there may be a better entry"): 5 min (was 15).
  // At expiry (verified cancel, zero fills) the price is banned until the 15m close (same level ban as a stop/TP1-touch cancel), so the identical order cannot
  // come straight back; a different level / a new signal can still enter. The 3 s fast poll wakes the main loop at the deadline (pendingExpiryDue); tick() cancels.
  pendingExpireMs: 5 * 60 * 1000,
  // PENDING STOP-TOUCH (2026-10-16, owner: "how long until an unfilled far-away entry is cancelled?"). true = a resting LIMIT/STOP entry is cancelled as soon as
  // price trades at or beyond its planned STOP before it fills (the setup is invalid), through the same verified cancel as the blackout (a fill always wins).
  // The pendingExpireMs timer (5 min since r9.5) still applies. false = old behaviour (only the timer). Switch: set-pending.sh on|off.
  pendingCancelOnStopTouch: true,
  // FILL-SLIPPAGE GUARD (2026-10-16, safety fix for 10/14 05:30 PT: a LONG limit filled 66.76 pts away at the 8:30 ET gap and the stop was shifted with it).
  // When an entry fills more than max(minPts, frac x planned stop distance) from the intended price, the stop and targets are NOT shifted (the original absolute
  // levels are kept); a fill already at or beyond the original stop is closed at market at once ("filled through the planned stop at news/gap - exited").
  // A normal small slip still shifts as before. enabled false = old behaviour. Switch: set-slipguard.sh on|off.
  fillSlipGuard: { enabled: true, minPts: 4, frac: 0.25 },
  // ENTRY STOP FLOOR (Mac 10/21: 6309102502 / 6309188306 / 6309508924 / 6309831067; priority 6330144245). MNQ points, measured from the entry: the planned
  // entry at the signal (sizing, 6.1 thresholds) and again from the ACTUAL fill. A tighter natural stop is moved OUT to the floor on every route (MAC capped
  // paths, Levels, reclaim, wave, reversal); a wider one is kept. Sessions by PT clock: london 00:00-06:30, ny 06:30-13:00, late 13:00-15:00, asia 15:00-24:00.
  // ENTRY-ONLY: the restart/recovery stop (stopCapDollarsPerContract x recoveryStopMultiple, reconcileIfUnknownPosition) never reads this key, and this key
  // never changes stopCapDollarsPerContract. enabled false = the r9.16.1 stops exactly. See lib/stopFloor.js.
  entryStopFloor: { enabled: true, asia: 30, london: 30, ny: 50, late: 30 },
  // NEWS AWARENESS (2026-10-16, owner: trade the news, but know when releases happen). Calendar: news-calendar.json in the bot folder (US releases, UTC times),
  // refreshed at startup and every newsCalendarRefreshMs from newsCalendarUrl (ForexFactory weekly JSON; null = never fetch, file only). A missing calendar never
  // blocks trading. newsAware true: MARKET entries trade through releases; a RESTING LIMIT/STOP entry is pulled newsCancelRestingSec before a HIGH-impact release
  // (same verified cancel, fill wins) and no new resting entry is placed inside that window. Phone: "Next catalyst" chip. Journal: newsWithinMin on plan/trade rows.
  // Switch: set-news.sh on|off.
  // NO-CHASE FILTER (2026-10-16 owner order: "don't get caught selling impulsive lows before the lower high"; spec hft/ops/tests/no-chase.md; ROUND 4 redesign
  // after QA pkg-1016-r2 B1/B2). A NEW entry (market or resting, levels or mac) is skipped when it is at least noChaseAtr x 15m ATR(14) PAST the reference in
  // the trade direction and that leg has not yet pulled back 38.2%. Reference (short; long mirrored) = the most recent CONFIRMED 5m swing high (2 closed 5m bars
  // after it) since the leg began, or, if none, the leg ORIGIN = the highest high of the last 12 closed 15m bars (lib/noChase.js). The distance is signed and a
  // resting entry on the pullback side counts as the retrace (a sell LIMIT above the market is not a chase). Closed bars only. Missing data = never blocks.
  // A resting entry that later becomes a chase is NOT cancelled. noChaseMode: 'skip' only ('pullback' is reserved, untested: treated as 'skip' with a log).
  // OWNER-ORDERED, NOT BACKTESTED (the engine does not model it). On the real 10/14 bars it blocks the 05:42 (+$160 winner) and 07:12 (-$477.50) shorts.
  // On the 6 strongest Q3 trend days it flags 18-27% (22% pooled) of with-trend 15m-close market entries. Switch: set-nochase.sh.
  // ROUND 5 (owner answer O1/O3, 10/14): 2.0 ATR for ALL sources, MAC included (was 1.5). QA freq (Q3): ~12% of with-trend 15m-close entries flagged pooled on the 6 strongest trend days (16% max day), 7.5% / 9.3% of all closes.
  noChase: true, noChaseAtr: 2.0, noChaseMode: 'skip',
  // ROUND 5 (switch; owner kept it OFF on 10/14, shipped [] = nobody exempt): MAC-sourced MARKET entries of these grades skip the no-chase check (also inside the
  // far-limit switch). ['A','B'] = MAC A/B market entries are never blocked as chases. Note: the 5m reference needs the M5 timeframe in levelsTriggerTimeframes
  // (shipped ['M15','M5','M3']); without M5 the intrabar M5 bars come from the 15m-close cache.
  noChaseExemptMacGrades: [],
  // 10-18b2a (Mac's b2 ruling Q3): no-chase skips momentum-path MARKET entries and resting level entries within the near band of their level. The near band
  // (entryNearPts / entryNearAtr1h: max(10 pts, 0.10 x 1H ATR)) is the one b2b's placement rule uses. Every skip is journaled with what no-chase would have said.
  noChaseExemptMomentum: true, noChaseLevelNearExempt: true, entryNearPts: 10, entryNearAtr1h: 0.10,
  // 10-18b2a MOMENTUM PATH (Mac's b2 ruling Q2): with-trend MARKET entries skip the pullback-zone + wave rules when MAC grade A/B or a 5m break confirms (NY only).
  waveMomentumPath: 'break', waveMomentumGrades: [],   // lv1 r2: momentum = the 5m price break only, never a MAC signal (was 'both', ['A', 'B'])
  waveMomentumSessions: ['ny'], waveMomentumBreakBars: 6,
  newsAware: true, newsCancelRestingSec: 60,
  // TRADE THE REACTION, NOT THE RELEASE (2026-10-16 owner order): after a HIGH-impact release no NEW entry (market or resting) until the first 15m bar that starts at
  // or after the release has CLOSED (CPI 05:30 PT -> entries from the 05:45 close), and never sooner than newsWaitMinMs. An open position is managed normally.
  // Needs newsAware. false = enter right after the release. Switch: set-news.sh wait-on|wait-off.
  newsWaitAfter: true, newsWaitMinMs: 15 * 60 * 1000,
  newsCalendarUrl: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', newsCalendarRefreshMs: 6 * 60 * 60 * 1000,
  pollIntervalMs: 20000,
  historyRefreshLimit: 2000,
  // Continuous monitoring (2026-10-08, Mac's directive) — "Open the bot's
  // eyes". 'bar-close-15m' (the old default) evaluates only once a 15m bar
  // fully closes. 'intrabar-1m' — APPROVED AND SWITCHED ON (2026-10-08) —
  // evaluates against the STILL-FORMING 15m bar every
  // evaluationIntrabarPollMs instead of waiting for it to close — see
  // refreshAndEvaluate()'s and checkForNewEntry()'s own comments for
  // exactly how, and the repainting writeup further down this file (search
  // "REPAINTING") for which signals can un-print before the real close and
  // how the state machine handles that.
  evaluationMode: 'intrabar-1m',
  // Only consulted when evaluationMode === 'intrabar-1m'. Tightened from
  // 60000 to 20000 (2026-10-08) — matches pollIntervalMs, which is the hard
  // floor: the intrabar check runs inside the same main-loop iteration as
  // the bar-close probe and the fill/trail/profit-lock checks, so it can
  // never fire faster than the loop's own tick regardless of what this is
  // set to. Mac's directive asked for "near-1-minute"; going to the floor
  // instead cuts detection lag on the live H1/H4/biasScore reads (the real
  // PF lever per the fetchFastTimeframes trace above) to as little as the
  // loop allows. fetchFastTimeframes is always 3 retrieveBars calls
  // (M15+H1+H4) per invocation regardless of this setting — tightening
  // this only changes how often those 3 calls happen, not what's fetched
  // per call. See the rate-limit accounting further down for the
  // recomputed load at this cadence.
  evaluationIntrabarPollMs: 20000,
  // Intrabar false-signal mitigation (2026-10-08) — only ever consulted for
  // the INTRABAR caller (see checkForNewEntry()'s isIntrabar param); the
  // bar-close path is NEVER affected by this flag, regardless of its value.
  // MEASURED AND REJECTED (2026-10-08): a full walk-forward economics
  // backtest (not just signal-survival) over 627 real intrabar candidates
  // found this gate keeps only 55/627 candidates — PF 1.62 but just $4,404
  // total, vs letting everything through at PF 1.20/$18,290. It isolates
  // noise barely better than chance; it mostly just turns intrabar mode
  // off. Staying OFF — not a "pending validation" placeholder anymore, an
  // actual measured no.
  intrabarRequireVolSpike: false,
  // Intrabar source restriction (2026-10-08) — only ever consulted for the
  // INTRABAR caller, exactly like intrabarRequireVolSpike above; bar-close
  // is never affected. MEASURED (2026-10-08): the same 627-candidate
  // walk-forward economics backtest found mac-sourced intrabar entries are
  // economically dead weight (PF 1.03, $1,095 total over 221 trades) even
  // though they survive to the real bar close MORE often than
  // levels-sourced ones (74.7% vs 49.5% — signal-survival and dollar P&L
  // are NOT the same thing). Levels-sourced alone carries essentially the
  // whole baseline's profit (PF 1.29, $17,195 — 94% of the $18,290
  // unfiltered baseline) using only 406/627 of the candidates. This is the
  // one filter that survived actual P&L testing, not just
  // precision/recall on whether a signal held to close — see
  // lib/signal.js's blockMacSourceIntrabar comment for the full numbers.
  // APPROVED AND SWITCHED ON (2026-10-08, JayMac's explicit go-ahead after
  // the full validation chain: bug fixes, SkeptiMac's adversarial review,
  // ScoutMac's independent research, hand-verified unit tests, parity
  // confirmed). Mac-sourced signals still fire normally on the bar-close
  // path — this ONLY restricts the intrabar caller to levels-sourced
  // entries.
  intrabarRestrictToLevelsSource: true,
  // MAC A/B INTRABAR ONLY (ROUND 4, owner order 10/14, OWNER-ORDERED, UNTESTED). intrabarAllowMacGrades: MAC-sourced signals of these grades pass the
  // intrabar source restriction above and enter as soon as they fire mid-bar (every other gate still applies). macIntrabarOnlyGrades: MAC-sourced signals of
  // these grades are NOT entered again at the 15m bar close when the same signal was SEEN mid-bar in that bar (traded or guard-blocked; journal MAC_INTRABAR_ONLY);
  // ROUND 5 (owner answer O4): a flag FIRST seen at the close is traded at the close (journal MAC_CLOSE_FIRST_SEEN). Grade C (and anything not listed) keeps waiting for the 15m close. HONEST NOTE: the 10/08 intrabar test above pooled ALL MAC grades
  // (PF 1.03 over 221 trades); grade A/B intrabar on its own has never been measured, and the engine does not model this rule yet.
  // Switch: set-macintrabar.sh AB (shipped) | A | off (off = the old rule: every MAC signal at the 15m close, grade-B block ON).
  intrabarAllowMacGrades: [],   // lv1 r2: no MAC grade lists (MAC never trades); was ['A', 'B']
  macIntrabarOnlyGrades: [],   // lv1 r2: was ['A', 'B']
  // 10-18b2a SEEN = ORDER SENT (Mac's b2 ruling Q1, 10/16 09:32 PT): a mid-bar MAC signal counts as 'seen' (and so is not entered again at the 15m close)
  // only when an order for it actually went out this bar - not when a guard (blackout, cooldown, wave, no-chase, ...) blocked it. false = the 10-18 rule.
  macSeenOnOrder: true,
  // 10-18b1 (Mac 10/16 09:13 PT: "no grade blocks anymore"): true = MAC-sourced signals of EVERY grade (A/B/C/'-') may enter mid-bar (lib/signal.js);
  // intrabarAllowMacGrades is then not consulted by the entry rule. macIntrabarOnlyGrades (the close "seen" rule) is NOT changed here (b2 item).
  // Rollback: bash set-removal.sh grades off (= false, the rule above).
  macIntrabarAllGrades: true,
  // FAR-LIMIT -> MAC MARKET (ROUND 4, owner order 10/14, OWNER-ORDERED, UNTESTED). When a Levels resting LIMIT/STOP plan (pending, or about to be placed) is more
  // than farLimitAtr x 15m ATR(14) from the current price AND an intrabar MAC grade A/B signal (intrabarAllowMacGrades) fires in the SAME direction, the resting
  // order is cancelled through the verified cancel (a fill wins) and MAC's MARKET entry is taken with MAC's normal stop/target (the mac-market path). Journal
  // FAR_LIMIT_SWITCH with both prices. Not done when MAC's market entry would itself be skipped (no-chase, cooldown, pause, news wait, blackout).
  // Live case 10/14 10:30 PT: a short LIMIT 30284.97 rested ~113 pts above price while MAC showed ENTER SHORT A 10/10. Switch: set-farlimit.sh on|off|<atr>.
  farLimitSwitch: false, farLimitAtr: 1.0,   // lv1: OFF (both far-limit routes swapped a Levels order for a MAC market entry)
  // ROUND 5 (owner answer O2, 10/14: "don't let both fire simultaneously"): true (shipped) = a far Levels STOP plan with MAC A/B agreeing also gives way to MAC's
  // market entry, through the same cancel -> acknowledged -> re-read position AND orders path (a fill of the STOP wins and nothing else is sent); false = LIMIT only.
  farLimitIncludeStops: true,
  // Periodic phone status push (2026-09-21) — a view-only status summary
  // (bot status, day P&L, current position if any, current bias) sent to
  // the SAME ntfy.sh topic already used for signal/fill alerts, so it works
  // from anywhere (cellular, away from home) with zero new network exposure
  // — no tunnel, no VPN, no port opened on this machine. This is check-in
  // status only; ntfy has no way to place or cancel an order back, so there
  // is no new order-placing surface no matter who ends up with the topic URL.
  // 18f1 F3 (NOTIFICATION ONLY): every 120 min (was 30), and only between 15:00 and 13:10 PT on trading days (lib/notifyPolicy.js statusPushWindow);
  // the weekend is silent except for CRITICAL pushes.
  statusPushIntervalMs: 120 * 60 * 1000,
  // Level-cross PHONE cooldown (2026-09-21) — every genuine cross still gets
  // logged to the console/log file (that detail is worth keeping), but the
  // PHONE push for a given level is suppressed if one already fired for that
  // SAME level within this window. Chopping back and forth around one level
  // was firing a separate push on every single flip; sweeps, breaks, and
  // crosses of a DIFFERENT level are completely unaffected by this — it only
  // throttles repeat pushes on the one level currently being chopped around.
  levelCrossCooldownMs: 5 * 60 * 1000,
  // 18f1 F2 (NOTIFICATION ONLY): level-cross PHONE pushes. 'off' (shipped) = the LEVEL CROSS log line only, no push; 'key' = push only PWH, PWL, Week Open,
  // PDH, PDL and 4H Open crosses, at most one per level per levelCrossKeyCooldownMs; 'all' = every level with levelCrossCooldownMs (the 10-18 behaviour).
  levelCrossPush: 'off',
  levelCrossKeyCooldownMs: 30 * 60 * 1000,
  // 18f1 F4 (NOTIFICATION ONLY): INFO pushes (signals, status, crosses, session started, pause / cancel notes) allowed per UTC day - ntfy.sh resets its
  // 250-per-day counter at 00:00 UTC (17:00 PDT). notifyInfoReserveFrac of it is kept for after 13:00 PT. CRITICAL pushes are never capped.
  notifyInfoBudget: 150,
  notifyInfoReserveFrac: 0.30,
  // Flat 5-contract sizing (2026-09-23 direct order — "We sizing down to 5
  // cons"): every trade is exactly baseContracts, no scale-up, on a dying
  // eval being used for low-stakes forward testing. Score/grade stays an
  // entry-quality signal (still computed, still shown, still what
  // decideSignal's minMacScore gates on) but no longer touches size at all.
  // Still read as the fallback size by contractsForSignal()/sizeForStop()
  // whenever riskBudgetedSizing is off.
  baseContracts: 5,
  // Risk-budgeted sizing (2026-10-07) — the deferred idea mentioned in the
  // comment above, built, then DISABLED again the same night after two
  // rounds of backtesting:
  // Round 1 shipped riskSizingMinContracts=1, sizing trades all the way down
  // to 1-2 contracts for wide-stop signals. Backtested great (avg/day
  // ~unchanged, worst day -39%) — but WRONG: at contracts=1, leg1Size
  // computes to 0, making target1Points = target1DollarGoal/(0*pointValue)
  // = Infinity, which would have sent liveStateMachine.js a real
  // 0-contract/infinite-price limit order for TP1. At contracts=2-3,
  // leg2Size can also hit 0, breaking the state machine's target-fill-vs-
  // stop-fill detection (it tells the two apart by comparing remaining
  // position size, which needs "always something left for leg2" to stay
  // unambiguous). The 3-leg structure only has room for 3 real legs at 4-5
  // contracts given baseLeg1Extra=1's split — caught before any live use,
  // never actually traded.
  // Round 2 re-ran the exact same backtest with riskSizingMinContracts
  // corrected to 4 (the real safe floor) — and the benefit mostly
  // evaporated: every dollarRiskPerTrade tested ($120-300) UNDERPERFORMED
  // flat baseContracts=5 on avg/day (-11% to -30%), the worst-day
  // improvement shrank to 14-16% (not 39%), and the worst single trade was
  // IDENTICAL to the flat baseline in every row — the one trade actually
  // driving the worst-day tail clamps to 5 contracts regardless, so a
  // safely-bounded version of this never even touches it. The whole
  // original improvement came specifically from sizing down to 1-2
  // contracts, which is exactly the part that isn't safe to ship without
  // rebuilding how the state machine distinguishes a stop-fill from a
  // target-fill — real surgery on live order-management code, not
  // attempted this session. OFF (false) until/unless that's done properly.
  // leg1SizeForContracts()/leg2SizeForContracts() below keep their
  // Math.max(1,...)/Math.max(0,...) defensive clamps regardless, as cheap
  // insurance against the same Infinity/negative-size bug if this is ever
  // turned back on without re-deriving a safe contract floor first.
  riskBudgetedSizing: false, dollarRiskPerTrade: 170, riskSizingMinContracts: 4, riskSizingMaxContracts: 5,
  // ════ 10/18 PACKAGE (owner decision 10/15: "implement now; backtest later"). Every rule below ships ON; each has a one-line off switch (this key in
  // config-local.json, or its set-*.sh script). NOT BACKTESTED: the engines do not model any of them yet (owner-accepted parity gap). lib/riskRules.js, lib/controlFilter.js.
  // RULE 1  $ RISK CAP PER TRADE BY SIZING DOWN (owner 10/15: "$250 max loss per trade"). The structural stop stays exactly where the strategy puts it; the SIZE is cut:
  //   contracts = floor(maxRiskPerTradeUsd / ((stop pts + riskSizingSlipPts) x $2)), at most baseContracts (5). If even 1 contract would risk more than the cap (a stop
  //   wider than 125 pts) the trade is SKIPPED (journal RISK_CAP_SKIP). Sized on the stop that RESTS at the broker. riskSizingSlipPts 0: the fill-slippage guard shifts the
  //   stop with every adverse entry slip (the $ risk is kept) and a favourable slip beyond it only shrinks the risk, so entry slippage adds nothing; slippage on the stop's
  //   own fill is not modelled anywhere (add points here to cover it). It replaces riskBudgetedSizing while on. 0 = off (old sizing). Switch: set-riskcap.sh on|off|<usd>.
  maxRiskPerTradeUsd: 250, riskSizingSlipPts: 0,
  // RULE 2  FIRST SCALE AT +20 PTS (built, shipped OFF) + LEG SPLIT AT ANY SIZE (ON) (Chart School 10/14: "20 pts, the easiest scaling target"). With firstScalePts > 0, TP1 = entry +/- firstScalePts at every size.
  //   Split (lib/riskRules.js legSplit): 5 = 2 at TP1 / 1 at TP2 / 2 runners (today), 4 = 2/1/1, 3 = 1/1/1, 2 = 1 at TP1 + 1 runner (no TP2 leg), 1 = all at TP1.
  //   TP2 keeps today's distance basis (the 5-lot TP1 dollar distance x the multiple, or the structural / Asia target). The runner trails as today.
  //   0 = off: TP1 is the old dollar goal / leg-1 contracts (never fewer than the 5-lot's 2, so a small size keeps the normal distance). Switch: set-firstscale.sh.
  //   OWNER DECISION (after the QA'd backtest, 10/15): SHIPPED OFF (0) until it is tested on its own; `set-firstscale.sh on` = +20. The leg split for small sizes
  //   works with it off (TP1 at the plan's normal distance).
  firstScalePts: 0,
  // so1 SCALE-OUT + RUNNER (Mac 10/22 live trial): at +atPts (20) every contract but 1 exits at ONE limit (no TP2 leg); the 1 runner's stop goes to +runnerLockPts (10)
  //   and then trails runnerLockPts behind the best price in runnerStepPts (10) steps (+30 -> +20, +40 -> +30). A 1-lot exits fully at +atPts. While on, TP1 = atPts at every size
  //   (it replaces firstScalePts), the whole-position profit lock (profitTrail) is forced OFF and session base-hit exits are not used.
  scaleOutRunner: { enabled: true, atPts: 20, runnerLockPts: 10, runnerStepPts: 10 },
  // RULE 3  THE L3 PROFIT LOCK IN POINTS (same at every size). Today's L3 on 5 contracts ($200 arm / $150 lock / $50 step) = +20 / +15 / +5 pts from entry.
  //   'points' (shipped): arm at +profitLockPts.arm pts of best excursion, lock +lock pts, +step pts of lock per step pts of peak; 'dollars' = the old $ ladder
  //   (profitTrail.armDollars ...; at 5 contracts identical, smaller sizes needed far more points). Only acts while profitTrail.enabled (set-l3.sh). Switch: set-l3pts.sh.
  profitLockUnit: 'points', profitLockPts: { arm: 20, lock: 15, step: 5 },
  // RULE 4  CONTROL FILTER (no counter-trend entries). LONG only when the last CLOSED controlAcceptTf candle closed above the session's control open by more than
  //   controlBufferPts, SHORT only below. Control open = the CURRENT bar's open of controlLineBySession[session] (Asia 15:00-24:00 4H, London 00:00-06:30 1H, NY 06:30-15:00 4H).
  //   Missing data never blocks. Journal CONTROL_FILTER with the numbers. Switch: set-control.sh on|off|buffer <pts>|line <asia|london|ny> <1H|4H>|accept <3m|5m|15m>.
  controlFilter: true, controlBufferPts: 0, controlLineBySession: { asia: '4H', london: '1H', ny: '4H' }, controlAcceptTf: '5m',
  // ADDENDUM 2 (owner 10/15) TREND REGIME above rule 4 + WAVE RULE. Ripster 34/50 EMA cloud (hl2) on the last CLOSED 1H and 4H bars: DOWN = the entry price below both
  //   clouds, UP = above both. Day type: last closed 5m close below the prior CME day's low = TREND_DOWN, above its high = TREND_UP, else RANGE; while the current 4H bar has
  //   no 5m close beyond the previous 4H bar's high/low, RANGE (trendInside4h). DOWN regime: shorts only, UP: longs only; a counter-trend entry only as a reclaim of the
  //   control open (5m close back across it + buffer, volume up). MIXED/RANGE: both, rule 4 decides. Journal TREND_FILTER.
  //   Switch: set-trend.sh on|off|daytype on|off|inside4h on|off|wave confirm|trigger|off|wave-param <key> <value>.
  trendFilter: true, trendUseDayType: true, trendInside4h: true,
  // WAVE RULE (addendum 3, the owner's 10/14-evening chart). Swings = 5m pivots of strength waveSwingStrength that move >= waveMinSwingAtr x the 15m ATR(14). DOWN structure
  //   = waveMinLowerHighs lower swing highs in a row, trendline through the last two. Entry A = a 5m candle tags the line (within waveLineBufferAtr x ATR) or the prior
  //   swing-high / broken-shelf zone and closes back down (stop above its wick). Entry B = >= 2 pivot lows within waveShelfAtr x ATR (a shelf), then a 5m close below it on
  //   volume above the candle before (stop above the last lower high). UP mirrored. waveMode 'confirm' (shipped): a with-trend signal in DOWN/UP needs A/B on one of the
  //   last waveConfirmBars 5m candles, or a printed lower high (higher low) not yet broken - never a fresh impulsive low (journal WAVE_WAIT). 'trigger' (OFF until the
  //   backtest): A/B also enter on their own (source 'wave'). 'off': no wave rule.
  // PULLBACK-DEPTH RULE (addendum 4) for wave entry A, in DOWN (UP mirrored): the reference is the last closed 15m candle when bearish; the short zone is close +
  //   pullbackZone (15%-30%) of its high-low RANGE (pullbackBasis 'range', shipped per the owner's correction; 'body' = open-close). A MARKET with-trend entry needs a 3m candle that traded into the zone and closed back down;
  //   price beyond pullbackVoid (50%) first = VOID until that 15m candle closes (journal PULLBACK_VOID). Confluence (15m/30m/1H open in the zone) is logged (+1 grade).
  //   Resting Levels LIMIT/STOP entries are level entries and are not judged by the zone; entry B (breakdown) confirms on its own. Switch: set-trend.sh pullback on|off|...
  pullbackRule: true, pullbackBasis: 'range', pullbackZone: [0.15, 0.30], pullbackVoid: 0.50,
  waveMode: 'confirm', waveSwingStrength: 3, waveMinSwingAtr: 0.5, waveMinLowerHighs: 2, waveLineBufferAtr: 0.2, waveShelfAtr: 0.25, waveConfirmBars: 3, waveStopBufferPts: 0.5,
  // RULE 5  SAME-LEVEL BAN. After a stop-out OR a pending cancel (stop / TP1 touched before the fill) that level + direction (entry within sameLevelBanTolPts, or the same
  //   named level) is banned until the current 15m bar closes. On top of the both-direction candle cooldown. Journal LEVEL_BAN. Switch: set-levelban.sh on|off.
  sameLevelBan: true, sameLevelBanTolPts: 2,   // 10-18b2c TEAM DECISION 1: RESTORED to the 10-18f1 value (b2a had removed it, Mac's b2 ruling Q4); reentryFreshStop was on alongside until the 2026-10-21 owner removal (below)
  // RULE 6  AGGRESSIVE RECLAIM RE-ENTRY after a stop-out: same direction at market when ALL hold - the direction still passes the trend/control gate; price swept through our
  //   stop; after the 15m ban/cooldown the last closed 5m candle closed back through the stop with volume above the candle before; price still on that side; within
  //   reclaimWindowMin of the stop-out. Stop = the sweep extreme +/- reclaimStopBufferPts, size by rule 1, TP1 by rule 2, TP2 = the original plan's TP2. Max 1 per original
  //   trade; every other block still applies (session close, news, 06:30-07:00, cooldown, pause, no-chase, broker guard). Journal RECLAIM_REENTRY. Switch: set-reclaim.sh.
  reclaimReentry: true, reclaimWindowMin: 60, reclaimStopBufferPts: 0.5,
  // RSI VETOES (owner decision 10/15: "RSI overbought/oversold must no longer block entries"). false (shipped) = the 4H RSI veto (75/25) and the 15m/30m/1h RSI veto
  //   no longer gate MAC (nor the 4H RSI turn path, which is defined against the same 75/25 pin); the RSI readings are still computed, journaled and shown (information).
  //   exhaustionGate stays 'off'. The display-only flag count keeps the Pine defaults. true = today's behaviour, byte-identical. Switch: set-rsi-veto.sh on|off.
  //   NOTE: the bot's MAC verdict then differs from the MAC Trap indicator's "AVOID (RSI ...)" labels until the Pine gets a matching toggle.
  rsiVetoes: false,
  // RULE X  EXHAUSTION REVERSAL (spec rules-10-18.md; the second counter-trend path besides the control-open reclaim). In a DOWN regime a LONG (UP: a SHORT) at market when:
  //   >= 2 of the 15m/30m/1H RSI <= exhaustionRsiLevel within exhaustionRsiLookbackBars x 15m (context only); a bullish engulfing with volume on the 3m AND 5m AND a CLOSED
  //   15m after the swing low; the fast Ripster clouds (5/12, 8/9 on hl2) green on the 3m and 5m. Stop below the swing low (- exhaustionStopBufferPts), size by rule 1;
  //   target = the nearer of the session VWAP and the last lower high / trendline, the WHOLE position exits there (no runner); skipped below exhaustionMinRR x risk.
  //   Every other block still applies (window, session, news, pause, cooldown, ban, broker guard); the trend / control / wave gate does not (it is the exception).
  //   Journal REVERSAL_ENTRY; phone "Reversal watch". Switch: set-reversal.sh on|off.
  exhaustionReversal: false,   // lv1 r2: OFF - an RSI/engulf reversal is not a trigger at a named level (was true)
  exhaustionRsiLevel: 30, exhaustionRsiLookbackBars: 6, exhaustionMinRR: 1, exhaustionStopBufferPts: 0.5,
  // RULE 7  ASIA OPEN BLOCK (15:00-17:00 PT, asiaBlockUntilMinutes). Was OFF from 10/15 ("the Asia blackout can go"); back ON by Mac's order 10/21 15:56 PT
  // ("Both time blocks need to get back in the code"; a trade filled ~15:54 with it off). false = off. Switch: set-asia.sh on|off (config-local wins).
  asiaBlackout: true,
  // TIME BLOCKS r1 (Mac 10/21): a resting entry must not fill across a block boundary. The order state machine treats "a block starts within
  // entryWindowLeadSec" as already blocked: no entry is submitted then, and the 3 s fast poll wakes the main loop so the verified cancel runs BEFORE the boundary.
  entryWindowLeadSec: 15,
  // TIME BLOCKS r2 (Mac's order allows "no-resting-across-the-boundary treatment"): a resting LIMIT/STOP entry is not placed when a block starts within its own
  // life (pendingExpireMs + 60 s; 30 min + 60 s when expiry is off). Effect: no new resting entry in the ~6 min before each block. false = off (r1 behaviour).
  noRestingAcrossBlock: true,
  // 10/18 BROKER TOKEN RENEWAL (live finding 10/15 05:06Z: the one startup login expired after 24 h -> every call HTTP 401, the bot was blind).
  //   The token is renewed every tokenRefreshHours (0.01-23; /api/Auth/validate first, then a fresh loginKey). Any HTTP 401: re-login, then that call
  //   is retried once (an order only after the broker's order list shows it did not land). At most one re-login per authReloginMinGapSec (1-600).
  //   3 failures in a row: urgent phone alert, "BROKER AUTH FAILED" on the phone, and no orders until a call succeeds again. Journal AUTH_REFRESH.
  tokenRefreshHours: 20, authReloginMinGapSec: 60,
  // Broker-position guard: right before ANY entry order the bot asks the broker for the open position and the working orders on this contract; a non-zero
  // position or any working order refuses the entry (one phone alert per 10 min). Also: after any entry attempt no other entry is attempted for entryAttemptHoldMs
  // (closes the "response lost, order live, second path orders again" race). Prevents stacking even with two bot instances. false = off.
  entryGuard: true, entryGuardBlockOnWorkingOrders: true, entryAttemptHoldMs: 0, entryGuardReadRetries: 2, entryGuardRetryMs: [400, 1200],   // 10-18b2a: guard read retried twice (0.4 s, 1.2 s) before it refuses; 0 = 10-18 (refuse on the first failed read)   // 10-18b2a: Mac 10/16 10:54 PT 'Remove the 45-second hold' (0 = off; the broker guard above stays)
 
  // HOTFIX 1: after a trade is stopped out (a trend trade that never reached TP1), block new entries in the SAME
  // direction until the next 15m bar has closed; reentryCooldownBars: 1 = the very next close, 2 = the one after.
  // The opposite direction is not blocked. false = old behaviour (re-enter on the next 20 s poll).
  // so1 (Mac 10/22: "Block the short for the remainder of that 15 minute candle"): after a stop-out the SAME direction is blocked until the current 15m candle closes
  //   (on top of the cooldown below; the longer block wins). 0 = off.
  // Mac 10/23 (clarified): ON - an END-OF-CANDLE block: a stop-out at 10:41 blocks that direction until 10:45, at 10:58 until 11:00 (not 15 minutes).
  stopOutSameDirBlockMin: 15,
  // so1 r1.11 (Mac 10/23: "use the same settings we are using for a loser"): after a WIN the same direction is blocked until the current 15m candle closes too
  //   (the stopOutSameDirBlockMin candle, same grace). The after-win 5m cooldown / reentryWinMinMinutes floor still apply; the longer block wins. false = losses only.
  sameDirBlockAfterWin: true,
  // np1 (Mac 10/24) NO-PROGRESS EXIT: at the close of the first FULL 5m candle after the fill (5-10 min after it), a trade still in its first leg (no scale-out yet)
  //   that has never been mfePts (15) in our favour since the fill is closed at market, through the session-close exit path (verified cancels, stops put back if the
  //   exit is rejected). Best price since the fill = every poll price + the high/low of every complete 1m bar after the fill minute. A fill time the bot does not know
  //   (an adopted position), a missed 1m bar or a late check = not assessed: the trade is left alone (journaled). enabled false = off.
  // lv1 r13.3.7 (Mac 10/31, the timer test): candles = which full 5m candle after the fill the check waits for - 1 (shipped) = the first, exactly as r13.3.5;
  //   2 = the second (the check 5 min later; nothing else changes). Only 1 or 2; anything else refuses to start. config-local: "noProgressExit": { "candles": 2 }.
  // lv1 r13.3.7e (Mac 10/31 ~05:30Z): hourEndDefer = null (shipped, never) or 1-15: a check time inside the last that many minutes of a 1H candle moves to the next
  //   5m close (one 5m candle, at most once; nothing else changes). config-local: "noProgressExit": { "hourEndDefer": 10 }.
  noProgressExit: { enabled: true, mfePts: 15, candles: 1, hourEndDefer: null },
  // lv1 r13.3.3 REVERSAL EXIT (MacTradeState's plan, Mac signed 10/29 17:08 PT), shipped as the SHADOW LOG: 'log' = journal rows only (trade_state at every
  //   1m close before TP1, reversal_signal when R4 or R2 first holds); the bot trades exactly as without it. 'off' = nothing at all. 'on' is not in this build.
  //   R4: momentumBars falling 1m closes, momentumPts+ in total against the trade, the last past the entry. R2: a 5m close levelPts+ back through the trade's level.
  reversalExit: { mode: 'log', momentumBars: 3, momentumPts: 15, levelPts: 5 },
  // np1 STRETCH CHECK (frozen definition, MacDot 6380448344; lib/stretchCheck.js): 20 < directional 15-min displacement <= 40 pts AND directional position in the
  //   prior hour's range >= 0.8. 'log' (shipped) = every entry attempt journals its features and flag (stretch_check row), trades unchanged; 'block' = a flagged
  //   entry is skipped (journal STRETCH); 'off'. The band is fixed in the code (a new band is a new version, not a setting).
  stretchCheck: 'log',
  // po3 r1 (Mac 10/26): OBSERVE-ONLY Power of Three + cluster map (lib/po3.js). 'log' = write po3_state on every state change and cluster_map once per
  //   TradeDay to po3-journal-<SYMBOL>-<TradeDay>.jsonl, from the bars each evaluation already fetched; trades unchanged. 'off' = nothing runs. There is no blocking mode in this version.
  po3Observe: 'log',
  // sr-areas r1 (lv1 r13.6.3; Mac 10/28-10/29 "support and resistance areas", MacAreas): DISPLAY ONLY. 'show' = Support & Resistance Areas (lib/srAreas.js) computed once per
  //   completed 1H bar from the bars each evaluation already fetched, shown on the phone (bands under the Level ladder's candles + the "Support & Resistance Areas" card)
  //   and written to sr-areas-<SYMBOL>-<TradeDay>.jsonl (one sr_areas row per completed 1H bar). 'off' = nothing runs (no snapshot field, no file). Nothing in trading reads it.
  srAreas: 'show',
  // np1 FLAT SIZE (Mac 10/24): every new entry is at most this many contracts whatever its grade (the $ risk cap can still size it down; a grade with no size stays
  //   ineligible). 0 = the grade ceilings as before (lib/initialQuantity.js: MAC A 5 / B 4 / C 2).
  flatSizeContracts: 3,
  // lv1 size1 CONSISTENT SIZE (Mac 10/30, plans-1030/size): "off" (or this shipped null) = off, sizes 1-3 by the stop under the $ cap exactly as before.
  //   3 = always 3 contracts or no trade: a setup sized below 3 is SKIPPED (journal SIZE_BELOW_MIN), never opened smaller. Only "off" or 3; with 3 the bot refuses
  //   to start unless baseContracts and flatSizeContracts are 3+, controlContestedMinSize is off and the $ cap fits 3 at every session stop floor. Shipped as null
  //   because config-local must match a shipped value's type, and a null default takes both "off" and 3. set-size.sh 3 | off | clear switches it.
  minContracts: null,
  reentryCooldown: true, reentryCooldownBars: 1,   // 10-18b2c TEAM DECISION 1: RESTORED to the 10-18f1 value (b2a had removed it)
  // 10/16 (owner's 10/14: a LONG closed as a win at 05:28:52 and a new LONG limit was placed 5 s later; it filled 66 pts away at the 8:30 ET release).
  // OWNER DECISION 10/16: CANDLE-BASED, no timer. reentryCooldownAfterWin true: after ANY close (win or loss) no new entry in the same direction until the
  // current 15m candle closes (= the loss rule above, extended to wins). reentryCooldownScope: 'same' = the trade's own direction, 'both' = both directions.
  // Switch: set-wincool.sh on|off|same|both (off = back to loss-only).
  // OWNER CHANGE 10/16: scope 'both' - after ANY close (win or loss) NO new entry in EITHER direction until the current 15m candle closes.
  // OWNER CHANGE 10/19 ~9:20 PM PT (Mac: "my cooldown period is too long as well. I think it should be the end of the 5min candle instead of 15min"):
  // the cooldown above (after wins and losses) ends at the close of the current 5m candle. 15 = the previous rule. Same-level ban / reclaim / fresh-stop unchanged.
  reentryCooldownCandleMin: 5,
  // r9.7 (data, 10/20): after a WIN, no new entry for at least this many minutes from the exit, even if the candle above has closed. 0 = off.
  // Journal: re-entries filled 0-10 min after a win: 15 trades, 4W, -$3,308 on 4 of 7 days; 10-20 min: -$80; after a loss, 0-15 min: +$422. Losses are unchanged.
  // r9.14 OWNER DECISION 10/21 (Mac: "All cool down periods should be the rest of that 5 min candle"): 0 = after a win the cooldown is the 5m-candle rule
  // above, exactly like a loss. The r9.7 floor stays available as a setting; the blocked-signal journal rows keep recording what a floor would have blocked.
  reentryWinMinMinutes: 0,
  reentryCooldownAfterWin: true, reentryCooldownScope: 'both',   // 10-18b2c TEAM DECISION 1: RESTORED to the 10-18f1 value (after a win: no new trade either way until the current 15m candle closes)
  // 10-18b2a FRESH-STOP RE-ENTRY (Mac's b2 ruling Q4): after a stop-out, a new entry in the SAME direction is placed only if its stop sits beyond the
  // extreme price traded since that stop-out (the new stop must sit outside the noise that killed the last one). No clock, no count; it ends when
  // the next trade fills and never blocks the opposite direction. false = no such check.
  // OWNER REMOVAL 2026-10-21 (Mac: "Drop the rule"; 10/21 evening: every short reaching the order step 16:22-22:15 refused against one 15:54 reference): OFF and locked off below.
  reentryFreshStop: false,
  // HOTFIX 4 (2026-10-13): every poll while a position is open, check the broker's working stop orders against the ladder the state machine intends (lib/liveStateMachine.js
  // auditStopLadder): after TP1 no stop may sit worse than break-even, each leg's stop >= its intended level, stop sizes match the open size. A missing/worse stop is replaced
  // (or those contracts are exited at market if the market is already through the level); a better stop (dragged by hand) is never touched. false = no audit.
  stopLadderAudit: true,
  // Fast order/position poll while a trend position is open (ms; null or 0 = off). The 20 s pollIntervalMs still drives signal evaluation; this only re-reads the broker position in between so a
  // fill is handled within seconds (profit-trail D2: a lock stop resting close to TP1/TP2 makes the stop-vs-target double fill likely). About 1 read call per 3 s while a position is open.
  openPositionPollMs: 3000,
  // PROFIT TRAIL (2026-10-13, owner: "secure profits; I don't care to be stopped out with good profits"). Whole-position profit-locking stop ladder for TREND trades. OFF until the lab picks the ladder. Peak open profit = best favourable excursion (live poll price) x $/pt x the contracts open NOW (recomputed after TP1/TP2).
  //   beAtDollars  (null = off): peak >= this -> every remaining contract's stop to break-even.
  //   armDollars / lockDollars / stepDollars: once peak >= armDollars the stop sits where closing ALL open contracts locks lockDollars; every further stepDollars of peak raises the lock by stepDollars.
  // Never loosens; stops rest at the broker via the same safe replace path as the runner trail (new stop first, verified cancel, market exit if the market is already through the level);
  // the lock is the tighter of this and every stop's own level. Needs the stop-ladder audit machinery (enabled automatically while this is on). Lock moves are journaled ('profit_trail').
  profitTrail: { enabled: false, beAtDollars: null, armDollars: 200, lockDollars: 100, stepDollars: 50 },
  // SESSION EXITS (2026-10-13, OPTIONAL, every session OFF): a "base hit" exit plan per session for the trend entries of that session (LIVE only). When enabled for the session an entry is
  // taken in, all contracts EXCEPT `runners` exit together at ONE limit at entry +/- targetPoints (or targetAtrMult x ATR(14, 15m) when targetAtrMult is set), instead of the normal TP1/TP2 legs
  // (for that trade only). The runner(s) keep a break-even stop once the base hit fills (runnerStopAtBE: true = no runner trail ratchet; the profit trail above, if on, may still raise it).
  // The stop-loss, sizing and everything else are unchanged; the stop ladder audit and the journal trade_plan ("Asia base-hit: 4 out at +20, 1 runner at BE") cover it. Sessions are the bot's existing
  // ones (lib/helpers.js ptInfo): london 00:00-06:30 PT, ny 06:30-15:00 PT, asia 15:00-24:00 PT. A restart in the middle of such a trade re-adopts it with the normal recovery legs.
  sessionExits: {
    asia: { enabled: false, targetPoints: 20, targetAtrMult: null, runners: 1, runnerStopAtBE: true },
    london: { enabled: false, targetPoints: 20, targetAtrMult: null, runners: 1, runnerStopAtBE: true },
    ny: { enabled: false, targetPoints: 20, targetAtrMult: null, runners: 1, runnerStopAtBE: true },
  },
  // Trend-position time stop (2026-09-24, FIX 9 "B7" Rule 2): a trend
  // position (leg1, before TP1) that hasn't hit TP1 within this many closed
  // 15m bars exits ALL remaining legs at market.
  trendMaxBarsToTP1: 8,
  // Exhaustion gate ablation (2026-09-23 backtest verdict): 'full' (H1 streak
  // OR lower-TF RSI beyond 25/75) costs ~$208/day vs gate-off on NQ across
  // two separate backtest periods, same worst day either way — it needs
  // recalibration, not deployment, so it ships OFF tonight. Not deleted:
  // 'full' / 'rsi-any' / 'h1-only' / '15m-only' remain valid values in
  // macTrap.js for whenever it gets re-tuned.
  exhaustionGate: 'off',
  // chopSkipEnabled (2026-10-09, JayMac's follow-up: "let's just remove the
  // adx filter completely") — supersedes the low-volume-only exemption
  // shipped minutes earlier. Backtested both against the real 5-year data:
  // the exemption-only version was total $228,458/PF 1.34/pass(1yr) 66.6%;
  // full removal (this) was $230,244/PF 1.34/pass(1yr) 66.0% — essentially
  // a wash, JayMac's explicit call to just take it out everywhere rather
  // than keep the NY-only carve-out. chopSkipExemptLowVolume is now inert
  // (chopSkipEnabled:false short-circuits it) but left in place/true since
  // it costs nothing and preserves the option to re-enable the narrower
  // version later without re-deriving it.
  chopSkipEnabled: false, chopSkipExemptLowVolume: true,
  // Shave-size override (2026-09-21) — SHIPPED PER EXPLICIT USER OVERRIDE,
  // against the backtested recommendation. Every version of "bank more at
  // TP1/TP2 or on unrealized dollars" tested tonight (leg1-shave, 70-80%
  // shave, TP1-only scaling, profit-lock) came back worse on avg/day, PF,
  // and Combine-pass speed than the flat 1/1/remainder split — see
  // backtest.js's TP1-ONLY SCALING and PROFIT-LOCK sections for the actual
  // numbers. The user's call: this account is an explicitly risk-free
  // sandbox meant for testing, the "1 contract out of 15" psychology of
  // watching a large unrealized gain round-trip is a real cost backtesting
  // doesn't fully price in, and live results (not backtest history) will be
  // the actual test. Revert to 0/0/null below if live results agree with
  // the backtest. This exact combination (leg1+leg2 shave AND profit-lock
  // stacked together) was never tested as a single combined config —
  // each piece individually was, not the stack.
  // Both re-tuned 2026-09-22 alongside target1DollarGoal's $30->$200 change,
  // so leg1 landed on his exact numbers at both size tiers. gradeLeg1Extra/
  // gradeLeg2Extra untouched since — he only specified leg1 back then, and
  // the 2026-10-07 retune below is about baseLeg1Extra specifically.
  //
  // baseLeg1Extra 2->1 (2026-10-07): the same 5-year backtest behind the new
  // dailyStopLoss/trail above also swept this split (how a flat 5-contract
  // trade divides across the three exit legs — leg1Size = 1+baseLeg1Extra,
  // leg2 always 1, leg3 = remainder). baseLeg1Extra=0 (1/1/3, max ride)
  // nearly TRIPLED total returns but carries an UN-FIXABLE single-trade tail
  // risk: a real -$1,096 worst day from one trade alone, before any daily
  // stop even gets a chance to act — disqualified outright under the $1,000
  // DLL constraint, no threshold tuning fixes it. baseLeg1Extra=1 (2/1/2)
  // was the validated winner that respects the constraint. See
  // CONFIG-RECOMMENDATION-ANALYSIS.md for the full sweep.
  gradeLeg1Extra: 3,   // leg1 closes 6 of 15 (40%) on grade-sized trades — unchanged
  gradeLeg2Extra: 2,   // leg2 closes 3 of 15 (20%) on grade-sized trades instead of 1
  baseLeg1Extra: 1,    // leg1 closes 2 of 5 on base-sized trades — was 3 of 5
  // Dropped 2026-09-22: TP1 itself now banks $200 with real structure (bank +
  // BE + trail) — this was a rougher version of the same job and would now
  // fire right on top of TP1. maybeProfitLock() no-ops whenever
  // profitLockDollars is falsy, so this is the whole change; the mechanism
  // stays in liveStateMachine.js in case it's ever wanted again.
  profitLockDollars: null,
  profitLockPct: 0.33,
  // Marketable-limit entry/exit buffer (2026-09-21, real live trade review):
  // a true MARKET order at 15 contracts walked the book badly — a real fill
  // came back 3.75pts worse than signal price ($112.50 of pure slippage on
  // entry alone). This prices every entry/exit that would've been a raw
  // MARKET order as an aggressive LIMIT instead, this many points through
  // the reference price — fills immediately in normal conditions, same as
  // market would, but caps the worst case instead of leaving it open-ended.
  marketableLimitBufferPoints: 2.0,
  // Mac-only pullback entry (2026-09-21, per your request to stop always
  // chasing MARKET on mac-only signals): before falling back to MARKET/
  // marketable-limit, look for the NEAREST Levels PRO level, on the
  // pullback side of current price, that has already SWEPT or RECLAIMED in
  // the direction of the trade — not just any nearby level. "Nearest and
  // on the right side" alone would happily rest a limit at a level that's
  // actively being broken against you; requiring a confirmed sweep/reclaim
  // means the level has already shown buyers (or sellers) stepping back in
  // there. See findPullbackLevel() below. Distance cap keeps this to a
  // genuine pullback, not a level so far away the setup would be stale by
  // the time (if ever) it fills — same order of magnitude as the ATR risk
  // already used for the mac-only stop. Set to 0 to disable and always use
  // MARKET/marketable-limit, matching the old behavior. NOT backtested —
  // shipped directly per your live-trading request, same as the sizing
  // override; watch live results.
  macOnlyPullbackMaxAtr: 0.5,
  // Account-level risk readout for mobile.html (2026-09-22): the ProjectX
  // API doesn't expose your account's actual trailing Maximum Loss Limit
  // anywhere (terminal.html's own CFG.maxDrawdown is manually entered for
  // the exact same reason) — these two numbers have to be told to it by
  // hand, matching the $150K Combine tier this account actually is
  // (verified against Topstep's own published rules earlier this session).
  // If you ever move to a different account size, update both.
  accountStartingBalance: 150000,
  // 10-18u2 (Mac 10/16 13:26 PT: the terminal's numbers must reconcile to Topstep's): the ONE place the broker's per-contract costs live. TopstepX charges per
  // contract per SIDE a $0.36 exchange/clearing fee and a $0.25 commission = $1.22 per contract per round trip (MacLedger's 10/16 reconciliation, exact).
  // Every net figure the bot shows (per trade and per day) is built from these; the terminal reads them from the snapshot and has no fallback of its own.
  brokerCosts: { feePerContractSide: 0.36, commissionPerContractSide: 0.25 },
  accountMllLimit: 4500,
  // TIDE r2 (MacTide, SPEC-TIDE-r2 E; playbook §1-23). Stage 1: "off" (shipped: r13.3.7 exactly) or "shadow" (the new model reads the market on the bot's
  //   own bars + level board and JOURNALS / PUSHES every signal with its plan - grade, size, stop, TP1, TP2, adds - and never sends an order).
  //   useTimeBlocks (Mac 11/04 FINAL: false): the OLD time blocks (Asia 15:00-17:00, NY-open 06:30-07:10, morning hold) do not apply to TIDE; openWaitMin: TIDE's own
  //   wait, no new-model entry in the first N minutes after 15:00 / 00:00 / 06:30 PT or a 4H open. News wait + session flatten / no-entry still apply. The old
  //   entry paths keep their blocks unchanged. push: one phone line per shadow signal (INFO budget).
  //   Tool: tools/set-tide.sh off|shadow|clear. "add" / "only" (orders) come with Stage 2 and are refused by this build.
  tide: { mode: 'off', useTimeBlocks: true, openWaitMin: 30, push: true, liveArmed: null, oldPathEntries: false, climaxGate: true, staleR: 2, laneAccept: true, controlFree: true, nearestWins: false, ltfOpens: false, waveBiasTrend: true, releaseOnRefusal: true, controlAsBias: true, trail: '5m', trailSwingStrength: 2, htfAgainst: 'tag',
    trendLane: { enabled: true, retestTol: 6, wickMin: 4, stopTicks: 2, capHour: 2, capDay: 6, climax: 'defense-confirms' }, gradeGate: 'aligned-pass', sizeCap: 8 },   // [r1.6] sizeCap 8 (Mac 11/05 ruling; every TIDE entry is 1-8 MNQ inside the hard $400 per-trade max; tools/set-tide.sh sizecap=N); gradeGate 'aligned-pass' (Mac 11/05: a WITH-HTF level setup is not refused by the grade gates; 'strict' = r1.5.6); trendLane (Mac 11/05: ON): the 4H-direction / 1H-harmony / 5m-defense entry lane (lib/trendLane.js); tools/set-tide.sh trend=off = r1.5.6 setups only   // [r1.5.6] + htfAgainst   // [r1.5.5] waveBiasTrend: gate waveBias >= 0 for with-trend setups   // [r1.5.4] staleR 2 (rule 18 ON) + the four lane / zone switches ON; tools/set-tide.sh lanes=off = r1.5.3 behaviour   // [r1.5.1] climaxGate false = the engine's CLIMAX with-trend block is bypassed   // [2a] liveArmed: written only by tools/set-tide.sh live; oldPathEntries: with mode "live" the old levels path takes no new entries unless true
  // money (MacMoney, lib/moneyRule.js money-r4, read by lib/tideWire.js; written out from its DEFAULTS): sizing.mode "flat" (shipped, the team's "common risk first":
  //   flatDollars 450 at every grade, a placeholder until Mac sets it) or "grade" (gradeRiskUsd { A: 900, B: 600, C: 300 }, 150K values); entryByGrade false (every grade
  //   all at once), upgradeAdd off, noFit "skip". Config only. TP1 2/3 / BE / pyramid / TP2 + the R-ladder. NO daily loss limit.
  //   Stage 1: sizing.enabled must stay false (shadow journals the size it WOULD take, and the other mode's size beside it).
  money: tideWire.moneyDefaults(),
};

// ── CONFIG OVERLAY HELPERS (begin) ──
// config-local.json (2026-10-13, owner request): every package replaces this file and wipes hand-edited CONFIG values, so the owner's own choices live in a SEPARATE file that packages never touch:
// /opt/mac-bot/config-local.json (same folder as this file). At startup, if it exists, its keys are deep-merged over CONFIG above. No file = CONFIG exactly as written here (byte-identical behaviour).
// Strict on purpose: an unknown key (typo), a wrong type, invalid JSON or a non-object file REFUSES to start with a clear message (every problem listed at once). Keys starting with "_" are comments and ignored.
// Rules: object -> merged key by key; number/boolean/string -> same type required; a default of null (feature off) accepts a number, string, boolean or null; array -> replaced (same element type).
const CONFIG_LOCAL_FILE = path.join(__dirname, 'config-local.json');
const CONFIG_ENUMS = { vwapBuildTf: ['5m', 'chart'], pullbackBasis: ['body', 'range'], waveMode: ['confirm', 'trigger', 'off'], profitLockUnit: ['points', 'dollars'], controlAcceptTf: ['3m', '5m', '15m'], 'controlLineBySession.asia': ['1H', '4H'], 'controlLineBySession.london': ['1H', '4H'], 'controlLineBySession.ny': ['1H', '4H'], 'tfMode.m15': ['ema', 'open'], 'tfMode.m30': ['ema', 'open'], 'tfMode.h1': ['ema', 'open'], 'tfMode.h4': ['ema', 'open'], sessionAnchor: ['legacy', 'cme'], reentryCooldownScope: ['same', 'both'], noChaseMode: ['skip', 'pullback'], stretchCheck: ['off', 'log', 'block'], po3Observe: ['off', 'log'], srAreas: ['show', 'off'], levelEventControl: ['require', 'exempt'] };   // text settings that only accept these values
const CONFIG_NULL_OBJECTS = new Set(['planEndsAtTargetTrend']);   // lv1 r13.3.7d: object settings whose shipped null means off (config-local may give an object; the startup check validates it)
const CONFIG_NULLABLE = new Set(['levelStopMaxFromFillPts']);   // lv1 r13.3.1 (r13.5.2's mechanism, the stop-cap key only): number settings that also accept null (= off)
// lv1 r13.6.2 STOP CAP FROM THE FILL (pure). The largest configured session floor (used when the fill's own floor is not known, e.g. after a restart: never inside ANY floor).
function stopCapFloorMaxOf(cfg) { const f = cfg && cfg.entryStopFloor; if (!f || f.enabled !== true) return null; const v = ['asia', 'london', 'ny', 'late'].map(s => f[s]).filter(x => Number.isFinite(x) && x > 0); return v.length ? Math.max(...v) : null; }
// The capped stop for a resting stop `stop` of a position filled at `fill`: null = no change (the cap is off, the stop is within it, or the input is not a protective stop).
// The cap is raised to the floor (cap >= floor). The level is rounded TOWARD the fill (never more than the cap away), except that when that would land inside the floor
// (the cap equals the floor and an average fill is off the tick) the floor's own outward rounding wins (at most one tick). Only ever tighter than `stop`.
function levelStopCapFromFill({ dir, fill, stop, capPts, floorPts, tickSize }) {
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.25, fl = Number.isFinite(floorPts) && floorPts > 0 ? floorPts : 0;
  if (!(dir === 1 || dir === -1) || !(Number.isFinite(fill) && fill > 0) || !Number.isFinite(stop) || !(Number.isFinite(capPts) && capPts > 0)) return null;
  const eff = Math.max(capPts, fl), before = dir * (fill - stop);
  if (!(before > eff + 1e-9)) return null;   // within the cap (or not on the protective side: not this rule's to move)
  let s = dir === 1 ? Math.ceil((fill - eff) / tick - 1e-9) * tick : Math.floor((fill + eff) / tick + 1e-9) * tick;
  if (fl && dir * (fill - s) < fl - 1e-9) s = dir === 1 ? Math.floor((fill - fl) / tick + 1e-9) * tick : Math.ceil((fill + fl) / tick - 1e-9) * tick;
  s = Math.round(s * 100) / 100;
  const after = dir * (fill - s);
  if (!(after < before - 1e-9) || !(after > 0)) return null;
  return { stop: s, before: stop, beforePts: Math.round(before * 100) / 100, afterPts: Math.round(after * 100) / 100, capPts: eff, setting: capPts, floorPts: fl || null };
}
function cfgType(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
function cfgEditDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function mergeConfigOverlay(base, over, prefix, applied, errors) {
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;   // comment key
    const v = over[k], at = prefix + k;
    if (!Object.prototype.hasOwnProperty.call(base, k)) {
      if (prefix === '' && /^(reversal|rsi)/i.test(k)) { errors.push(`"${at}": the RSI reversal scalp was REMOVED from the bot on 2026-10-13 (no edge found), so this setting no longer exists - delete this line from config-local.json`); continue; }
      const near = Object.keys(base).map(x => [x, cfgEditDistance(k.toLowerCase(), x.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
      errors.push(`unknown setting "${at}"${near && near[1] <= Math.max(2, Math.floor(k.length / 4)) ? ` - did you mean "${prefix}${near[0]}"?` : ''}`);
      continue;
    }
    const b = base[k], tb = cfgType(b), tv = cfgType(v);
    if (CONFIG_ENUMS[at] && !CONFIG_ENUMS[at].includes(v)) { errors.push(`"${at}" must be one of ${CONFIG_ENUMS[at].map(x => JSON.stringify(x)).join(' or ')}, got ${JSON.stringify(v)}`); continue; }
    if (b === null && tv === 'object' && CONFIG_NULL_OBJECTS.has(at)) { const o = JSON.parse(JSON.stringify(v)); applied.push({ key: at, from: b, to: o }); base[k] = o; continue; }   // lv1 r13.3.7d
    if (v === null && CONFIG_NULLABLE.has(at)) { applied.push({ key: at, from: b, to: v }); base[k] = v; continue; }   // lv1 r13.3.1 (r13.5.2): a number setting whose null means off
    if (tb === 'object') {
      if (tv !== 'object') errors.push(`"${at}" must be an object { ... } like the shipped default ${JSON.stringify(b)}, got ${tv} ${JSON.stringify(v)}`);
      else mergeConfigOverlay(b, v, at + '.', applied, errors);
      continue;
    }
    if (tb === 'null') {
      if (!['number', 'string', 'boolean', 'null'].includes(tv)) errors.push(`"${at}" must be a number, string, true/false or null (shipped default null = off), got ${tv} ${JSON.stringify(v)}`);
      else { applied.push({ key: at, from: b, to: v }); base[k] = v; }
      continue;
    }
    if (CONFIG_ENUMS[at] && !CONFIG_ENUMS[at].includes(v)) { errors.push(`"${at}" must be one of ${CONFIG_ENUMS[at].map(x => JSON.stringify(x)).join(' or ')}, got ${JSON.stringify(v)}`); continue; }
    if (tb === 'array') {
      const want = b.length ? cfgType(b[0]) : null;
      if (tv !== 'array' || (want && !v.every(x => cfgType(x) === want))) errors.push(`"${at}" must be a list of ${want || 'values'} like the shipped default ${JSON.stringify(b)}, got ${JSON.stringify(v)}`);
      else { applied.push({ key: at, from: b.slice(), to: v.slice() }); base[k] = v.slice(); }
      continue;
    }
    if (tv !== tb || (tb === 'number' && !Number.isFinite(v))) errors.push(`"${at}" must be a ${tb} (shipped default ${JSON.stringify(b)}), got ${tv} ${JSON.stringify(v)}`);
    else { applied.push({ key: at, from: b, to: v }); base[k] = v; }
  }
}
// Returns { present, file, overrides:[{key,from,to}] }; throws Error(message with every problem) when the file is unusable. No file -> { present:false, overrides:[] } and CONFIG is not touched.
function loadConfigOverlay(base, file, fsMod = fs) {
  if (!fsMod.existsSync(file)) return { present: false, file, overrides: [] };
  let over;
  try { over = JSON.parse(fsMod.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message})`); }
  if (cfgType(over) !== 'object') throw new Error(`${file} must contain one JSON object { ... }, got ${cfgType(over)}`);
  const applied = [], errors = [];
  mergeConfigOverlay(base, over, '', applied, errors);
  if (errors.length) throw new Error(`${file} has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  return { present: true, file, overrides: applied };
}
// ── CONFIG OVERLAY HELPERS (end) ──
const CONFIG_LOCAL = (() => {
  try { return loadConfigOverlay(CONFIG, CONFIG_LOCAL_FILE); }
  catch (e) {
    console.error(`\nCONFIG-LOCAL ERROR: the bot will NOT start because of config-local.json.\n${e.message}\nFix the file (or delete it to run the shipped defaults) and restart. See config-local.example.json.\n`);
    process.exit(1);
  }
})();
{ const p = tideWire.configProblem(CONFIG, { symbol: SYMBOL, pointValue: SYMBOL === 'MGC' ? 10 : 2, minContracts: CONFIG.minContracts });   // TIDE r2: fail closed before anything starts
  if (p) { console.error(`\nCONFIG-LOCAL ERROR: the bot will NOT start because of config-local.json.\n${p}\nFix the file (or delete the tide / money lines to run the shipped defaults) and restart.\n`); process.exit(1); } }
// Week 1 source policy: no auto-expiry; stale local settings cannot restore probes.
lockPolicy(CONFIG, CONFIG_LOCAL.overrides);
// Owner removal 2026-10-19: this combined entry veto cannot be restored by old local settings.
// Keep the separate 15m controlDirectionGate, stops, risk and no-chase settings untouched.
const REMOVED_FILTER_CONTEXT = Object.freeze({ trendFilter: CONFIG.trendFilter, controlFilter: CONFIG.controlFilter });
for (const key of ['trendFilter', 'controlFilter']) {
  Object.defineProperty(CONFIG, key, { value: false, enumerable: true, writable: false, configurable: false });
  for (const item of CONFIG_LOCAL.overrides) if (item.key === key) { item.requested = item.to; item.to = false; item.note = 'Removed entry filter; local value ignored'; }
}
// Owner removal 2026-10-21 (Mac: "Drop the rule"): the fresh-stop re-entry rule cannot be restored by old local settings either.
Object.defineProperty(CONFIG, 'reentryFreshStop', { value: false, enumerable: true, writable: false, configurable: false });
for (const item of CONFIG_LOCAL.overrides) if (item.key === 'reentryFreshStop') { item.requested = item.to; item.to = false; item.note = 'Removed re-entry rule; local value ignored'; }
// Control-line switches (tfMode / align30, 2026-10-14): options handed to evaluateLevelsPro / evaluateMacTrap. Shipped defaults
// (all 'ema', align30 false) return {} (no extra keys), so both evaluators run exactly as before.
// 10/18 RSI vetoes switch -> evaluateMacTrap options. rsiVetoes true returns {} (the call is exactly as before).
function rsiVetoOpts(cfg = CONFIG) { return cfg.rsiVetoes === false ? { rsi4hLongMax: null, rsi4hShortMin: null, mtfRsiVeto: false } : {}; }
const TF_MODE_KEYS = { m15: 'M15', m30: 'M30', h1: 'H1', h4: 'H4' };
function levelsAlignOpts(cfg = CONFIG) {
  const tfs = cfg.align30 === true ? ['M15', 'M30', 'H1', 'H4'] : ['M15', 'H1', 'H4'];
  return { alignTfs:tfs, alignModeByTf:Object.fromEntries(tfs.map(k => [k, 'open'])), alignMeasured: cfg.alignmentFreshnessPolicy === 'measured' };   // r9.10
}
function macDotOpts(cfg = CONFIG) {
  if (cfg.tfModeApplyToMac === false) return {};
  const m = {}, tm = cfg.tfMode || {};
  for (const [ck, hk] of Object.entries(TF_MODE_KEYS)) if (tm[ck] === 'open') m[hk] = 'open';
  return Object.keys(m).length ? { tfDotModeByTf: m } : {};
}
// sessionAnchor -> evaluator options. Shipped 'cme' (r9.15); 'legacy' returns {} so the evaluators run exactly as r9.14.1.
// r9.16.1: the 5m VWAP request. With '5m' the evaluator is ALWAYS told it was requested, so a missing/empty 5m read is labelled a fallback
// (vwapSource 'chart-fallback:no-5m-series'), never confused with the deliberate 'chart' rollback ({} -> 'chart').
function levelsParityOpts(cfg = CONFIG) { return cfg.levelsParity === 'pine' ? { momChartAtr: true, dedupeLevels: true } : {}; }   // lv1 r13.3.4 lp1: 'off' = {} (the call exactly as before)
function levelsVwapOpts(htf, cfg = CONFIG) { return cfg.vwapBuildTf === '5m' ? { vwapBuild: '5m', vwapBars: htf && Array.isArray(htf.M5) ? htf.M5 : [] } : {}; }
function levelsSessionOpts(cfg = CONFIG) { return cfg.sessionAnchor === 'cme' ? { sessionAnchor: 'cme' } : {}; }   // VWAP: evaluator default 'calendar-0630' (r9.15)
function macSessionOpts(cfg = CONFIG) { return cfg.sessionAnchor === 'cme' ? { sessionAnchor: 'cme' } : {}; }      // r9.15: MAC Trap uses the same day boundary

// Sweep/reclaim behavior families from lib/levelsPro.js's behStr(): a level
// swept in OUR direction and reclaimed, or already reclaimed/lost outright,
// vs. FAIL/ACCEPT/HOLD which are separate concepts (rejection without a
// sweep, long-held control, or currently-being-defended) — deliberately not
// included here, since "reclaims or sweeps" was the specific ask.
const PULLBACK_BEHAVIORS = {
  1: ['SWEEP DN', 'RECLAIM'],   // long: swept the low and closed back above, or already reclaimed above
  '-1': ['SWEEP UP', 'LOST'],   // short: swept the high and closed back below, or already lost/broken below
};

// Nearest Levels PRO level on the pullback side of refPrice (below it for a
// long, above it for a short) whose CURRENT behavior confirms a sweep or
// reclaim in `dir`'s favor, within maxDistPoints. Returns null if none
// qualifies — callers fall back to the existing MARKET/marketable-limit path.
function findPullbackLevel(dir, refPrice, levels, maxDistPoints) {
  const wanted = PULLBACK_BEHAVIORS[dir] || [];
  let best = null, bestDist = Infinity;
  for (const lvl of (levels || [])) {
    if (!wanted.includes(lvl.behavior)) continue;
    const onPullbackSide = dir === 1 ? lvl.price <= refPrice : lvl.price >= refPrice;
    if (!onPullbackSide) continue;
    const dist = Math.abs(refPrice - lvl.price);
    if (dist <= maxDistPoints && dist < bestDist) { bestDist = dist; best = lvl; }
  }
  return best;
}

// When smartStopHold is on, the REAL stop (resting on the exchange in LIVE
// mode, or watched in paper mode) widens to tightStop's distance x
// sweepGraceMultiple, and the ORIGINAL leg1StopCapMultiple-capped stop is
// kept only as a reference for an early-exit check once Levels PRO's own
// classification confirms a real break of structure. Off, this is a no-op —
// same tight stop either way, tightStopPrice null (smart-hold check skipped).
function applySmartHold(entryPrice, tightStop, dir) {
  if (!CONFIG.smartStopHold) return { stopPrice: tightStop, tightStopPrice: null };
  const tightPoints = dir === 1 ? entryPrice - tightStop : tightStop - entryPrice;
  const widePoints = tightPoints * CONFIG.sweepGraceMultiple;
  const stopPrice = dir === 1 ? entryPrice - widePoints : entryPrice + widePoints;
  return { stopPrice, tightStopPrice: tightStop };
}

const LOG_FILE = path.join(__dirname, `live-executor-${SYMBOL}-${LIVE ? 'LIVE' : 'paper'}-${new Date().toISOString().slice(0, 10)}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* logging failure shouldn't crash the loop */ }
}

// Optional push notification to your phone via ntfy.sh — set NTFY_TOPIC to a
// long, hard-to-guess string and subscribe to https://ntfy.sh/<that string>
// in the ntfy app. Silently does nothing if NTFY_TOPIC isn't set, so this is
// fully optional and never blocks the trading loop (fire-and-forget, errors
// are logged but never thrown). Reserved for moments that matter when you're
// away from the screen — entries, fills, the daily stop, and anything that
// needs your attention — not the routine level-touch/board-state logging.
const NTFY_TOPIC = process.env.NTFY_TOPIC || null;
// 18f1: optional ntfy access token (ntfy.sh paid tier or an own server). Used ONLY as the 'Authorization: Bearer' header of the push; never logged,
// journaled or written to the snapshot (the startup line says only 'auth: on/off'). Not set = exactly the 10-18 request.
const NTFY_TOKEN = NP.ntfyToken(process.env.NTFY_TOKEN);
const NTFY_TOKEN_BAD = !NTFY_TOKEN && typeof process.env.NTFY_TOKEN === 'string' && process.env.NTFY_TOKEN.trim() !== '';
const NOTIFY_BUDGET_FILE = path.join(__dirname, `notify-budget-${SYMBOL}.json`);   // 18f1 F4: today's (UTC) push counts, so a restart does not reset the budget
let notifyBudget = null;   // 18f1 F4: created on the first push (CONFIG incl. config-local.json is final by then)
// Returns a promise so the one call site that exits the process right after
// (the FATAL crash handler) can await delivery instead of racing process.exit
// against an in-flight HTTPS request. Every other call site fires-and-forgets
// by just not awaiting it.
// HTTP header VALUES must be plain ASCII — Node's http module throws
// ERR_INVALID_CHAR synchronously (crashing the whole process, since this
// runs inside an async call chain with nothing to catch it) on anything
// outside that range. Several notify() titles use an em dash ("—",
// U+2014) for style, which is exactly such a character — that crashed a
// real live process on 2026-09-22 mid-reconciliation, right as it was
// trying to warn about an unprotected position, which meant the warning
// itself never went out either. Sanitizing here means a future title with
// any other non-ASCII punctuation (curly quotes, en dashes, emoji) can't
// reintroduce the same crash.
function sanitizeHeaderValue(s) {
  return String(s)
    .replace(/[‒-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '');
}
// BLACKOUT CANCEL (owner order 2026-10-13): which entry blackout (if any) the time is in. The same two tests checkForNewEntry/computeStatus use.
// MORNING HOLD: true inside [from - flattenLeadMin, to) Pacific time, every day. Malformed from/to = off.
function morningHoldWindow() {
  const h = CONFIG.morningHold, m = s => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return r && +r[1] < 24 && +r[2] < 60 ? +r[1] * 60 + +r[2] : null; };
  if (!h) return null; const a = m(h.from), b = m(h.to); if (!(a != null && b != null && a < b)) return null;
  const lead = Number.isInteger(h.flattenLeadMin) && h.flattenLeadMin >= 0 && h.flattenLeadMin <= 60 ? h.flattenLeadMin : 0;
  return { a: Math.max(0, a - lead), b };   // the hold (entry block + flatten) starts flattenLeadMin before `from`
}
function morningHoldLabel() { const w = morningHoldWindow(); const f = x => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); return w ? f(w.a) + '-' + f(w.b) : 'off'; }
function inMorningHold(ts) { const w = morningHoldWindow(); if (!w) return false; const mod = ptInfo(ts).minutesOfDay; return mod >= w.a && mod < w.b; }
// Every executor entry gate that checks the NY-open blackout also honours the morning hold (lib/simulate.js and backtests are unchanged).
function inNyOpenBlackout(ts, blockMinutes) { return inMorningHold(ts) || inNyOpenBlackoutBase(ts, blockMinutes); }
function blackoutReason(ts) {
  if (inMorningHold(ts)) return `morning hold (no entries ${morningHoldLabel()} PT)`;
  if (inNyOpenBlackout(ts, CONFIG.blockNyOpenMinutes)) return 'NY-open blackout';
  if (inAsiaBlackout(ts, CONFIG.asiaBlackout === false ? null : CONFIG.asiaBlockUntilMinutes)) return 'Asia blackout';   // 10/18 RULE 7 (same as asiaBlockMinutes(CONFIG); inline so this helper needs no new name)
  const sc = sessionCloseState(ts, CONFIG); if (sc.noEntry) return `session close (no new entries ${sc.noEntryPt}-${sc.reopenPt} PT, flat by ${sc.flattenPt} PT)`;   // 10/17
  return null;
}
// TIME BLOCKS r1: the order state machine's window test = inside a block now, or one starts within entryWindowLeadSec (0..60 s; anything else = 15).
function entryWindowLeadMs() { const s = CONFIG.entryWindowLeadSec; return (Number.isFinite(s) && s >= 0 && s <= 60 ? s : 15) * 1000; }
function entryWindowReason(ts) {
  const now = blackoutReason(ts); if (now) return now;
  const lead = entryWindowLeadMs(); if (!lead) return null;
  const soon = blackoutReason(ts + lead); return soon ? `${soon} - starts within ${Math.round(lead / 1000)} s` : null;
}

// [2a r1.1] Mac: "the old model turned off and this one turned on": with tide.mode live (oldPathEntries false) the old levels path's TRADE-SIGNAL pushes are
// journal / log only (one model on the phone: TIDE). Safety and system pushes (session, flatten, errors, auth, pause, status) are never silenced.
const OLD_SIGNAL_PUSH = /^(Signal: |Reclaim re-entry attempted|Crossed |Control: |Entry refused by the broker guard)/;
function oldPathSilenced(title) { return tideWire.modeOf(CONFIG) === 'live' && CONFIG.tide && CONFIG.tide.oldPathEntries !== true && OLD_SIGNAL_PUSH.test(String(title || '')); }
function notifyPhone(title, message, { priority = 'default', tags = '' } = {}) {
  if (oldPathSilenced(title)) { log(`  [push silenced: TIDE live, old path manage-only] ${title}: ${String(message || '').slice(0, 160)}`); return Promise.resolve(); }
  if (!NTFY_TOPIC) return Promise.resolve();
  // 18f1 F4 (NOTIFICATION ONLY): CRITICAL (fills, exits, stop-outs, errors, session close, auth) is always sent; INFO counts against the UTC-day budget
  // (CONFIG.notifyInfoBudget, 30% kept for after 13:00 PT) and the weekend quiet (Fri 13:10 - Sun 15:00 PT): over it, the push is logged here, not sent.
  let gate = null;
  try {
    if (!notifyBudget) notifyBudget = NP.createNotifyBudget({ file: NOTIFY_BUDGET_FILE, infoBudget: CONFIG.notifyInfoBudget, reserveFrac: CONFIG.notifyInfoReserveFrac, log });
    gate = notifyBudget.decide(title, priority, Date.now());
  } catch (e) { gate = null; }   // a broken budget never blocks a push
  if (gate && !gate.send) {
    log(`  [ntfy] not sent (${gate.why === 'weekend' ? 'weekend: INFO is quiet Fri 13:10 - Sun 15:00 PT' : gate.why === 'quota' ? 'ntfy daily quota reached today' : `INFO budget used: ${gate.info}/${gate.cap} this UTC day`}), logged only: ${sanitizeHeaderValue(title)} - ${sanitizeHeaderValue(message).slice(0, 160)}`);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const body = Buffer.from(message, 'utf8');
    let req;
    try { req = https.request({
      hostname: 'ntfy.sh',
      path: '/' + encodeURIComponent(NTFY_TOPIC),
      method: 'POST',
      headers: {
        // SYMBOL prefix (2026-09-22): with MNQ and MGC both pushing to the
        // same phone, "Crossed PDL" or "Entry filled" alone forces you to
        // read the price value itself to figure out which instrument it's
        // about. One change here covers every notify() call site at once
        // instead of editing each title individually.
        'Title': sanitizeHeaderValue(`MacMillionz ${SYMBOL}: ${title}`),
        'Priority': priority,
        ...(tags ? { 'Tags': sanitizeHeaderValue(tags) } : {}),
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        ...(NTFY_TOKEN ? { 'Authorization': 'Bearer ' + NTFY_TOKEN } : {}),   // 18f1: only when NTFY_TOKEN is set
      },
    }); } catch (e) { log('  [ntfy] push failed (non-fatal): ' + e.message); resolve(); return; }   // 18f1: a bad header can never throw out of a push
    req.on('error', e => { log('  [ntfy] push failed (non-fatal): ' + e.message); resolve(); });
    // 15s timeout (2026-10-07): this raw https.request had no timeout at
    // all — the same gap already fixed in tmc-proxy.js's upstream request
    // and lib/bars.js's ptxFetch, just missed here. notifyPhone() is
    // awaited directly in the main loop (the periodic status push, every
    // entry/exit notification) — if ntfy.sh's connection ever silently
    // hangs (connects, never responds, never errors), this Promise never
    // resolves and the ENTIRE main loop freezes right there, indefinitely,
    // with no crash and no log line. Likely root cause of the 2026-10-05/07
    // ~30h stall: the bars.js/tmc-proxy.js fix was confirmed already active
    // at the time (deployed 09-29, restarted via the weekend timer 10-04),
    // every other network call in the main loop routes through the
    // now-protected ptxFetch, and this was the one path left uncovered.
    // destroy() forces the 'error' handler above to fire, resolving non-
    // fatally exactly like every other ntfy failure mode already does.
    req.setTimeout(15000, () => req.destroy(new Error('ntfy.sh request timed out')));
    // Status check (2026-09-22): this used to resolve on ANY completed
    // response, success or not — a connection-level failure (DNS, timeout,
    // reset) was the only thing that ever got logged. That meant a
    // rejection ntfy.sh returns WITH a response (quota exceeded, rate
    // limited, bad topic) looked identical in the log to a real successful
    // push — exactly what made last night's "quota reached" silence so
    // hard to track down; it took a manual curl test to find it. Now any
    // non-2xx gets logged with the actual status and body.
    req.on('response', res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          log(`  [ntfy] push rejected (HTTP ${res.statusCode}): ${body}`);
          if (res.statusCode === 429 && /42908|quota/i.test(body)) { try { if (notifyBudget) notifyBudget.noteQuota(Date.now()); } catch (e) { /* notification only */ } }   // 18f1 F4
        }
        resolve();
      });
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function askConfirmation(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function login(auth) {
  const userName = process.env.PTX_USER;
  const apiKey = process.env.PTX_KEY;
  if (!userName || !apiKey) {
    console.error('Set PTX_USER and PTX_KEY environment variables first.');
    console.error('Example: PTX_USER=you PTX_KEY=yourkey node live-executor.js');
    process.exit(1);
  }
  auth.userName = userName; auth.apiKey = apiKey;
  if (!(await auth.login())) {
    console.error('Login failed:', auth.lastError);
    process.exit(1);
  }
  return auth;
}

async function resolveContract(token, searchText) {
  const d = await ptxFetch('/api/Contract/search', { searchText, live: false }, token);
  const list = d?.contracts || [];
  const active = list.find(c => c.activeContract) || list[0];
  return active?.id || null;
}

async function main() {
  const symbol = SYMBOL;
  // MGC (Micro Gold, 2026-09-22): 10 troy oz/contract, $1/tick at 0.10 —
  // $10/point. Previously fell through to the generic `: 1` default, which
  // would have silently mispriced every P&L/target/stop dollar calc for it.
  const pointValue = symbol === 'MNQ' ? 2 : symbol === 'MES' ? 5 : symbol === 'MGC' ? 10 : 1;
  // Tick size (2026-09-22, found live): MNQ/MES both trade in 0.25-point
  // ticks, but MGC trades in 0.10 — and 0.25 isn't an even multiple of
  // 0.10. lib/liveStateMachine.js used to hardcode 0.25 everywhere, which
  // silently produced invalid prices for MGC orders (rejected by the
  // exchange) the moment a second instrument existed. Passed through
  // explicitly now so a third instrument can't quietly reintroduce this.
  const tickSize = symbol === 'MGC' ? 0.10 : 0.25;

  { const fe = stopFloor.validate(CONFIG.entryStopFloor); if (fe.length) throw new Error(`entryStopFloor is unusable: ${fe.join('; ')}`); }   // entry stop floor: fail closed at startup
  // so1 (Mac 10/22 live trial): scale-out + runner replaces the whole-position profit lock, so profitTrail is forced off while it is on (config-local cannot turn it back on).
  { const p = scaleOutRunnerProblem(CONFIG); if (p) throw new Error(`scaleOutRunner is unusable: ${p}`); }
  { const p = controlLineProblem(CONFIG.controlGateMin); if (p) throw new Error(`controlGateMin is unusable: ${p}`); }   // lv1 r13.3.3-ctl1: fail closed at startup, before any startup line
  { const p = reversalExitProblem(CONFIG); if (p) throw new Error(`reversalExit is unusable: ${p}`); }   // lv1 r13.3.3: fail closed at startup ('on' included)
  if (typeof CONFIG.htfLevels !== 'boolean') throw new Error(`htfLevels is unusable: true or false, got ${JSON.stringify(CONFIG.htfLevels)}`);   // lv1 r13.3.4: fail closed at startup
  if (CONFIG.levelsParity !== 'off' && CONFIG.levelsParity !== 'pine') throw new Error(`levelsParity is unusable: "off" or "pine", got ${JSON.stringify(CONFIG.levelsParity)}`);   // lv1 r13.3.4 lp1: fail closed at startup
  if (typeof CONFIG.tp1FromFill !== 'boolean') throw new Error(`tp1FromFill is unusable: true or false, got ${JSON.stringify(CONFIG.tp1FromFill)}`);   // lv1 r13.3.5: fail closed at startup
  if (typeof CONFIG.planEndsAtTarget !== 'boolean') throw new Error(`planEndsAtTarget is unusable: true or false, got ${JSON.stringify(CONFIG.planEndsAtTarget)}`);   // lv1 r13.3.5: fail closed at startup
  { const why = planEndTrendConfigError(CONFIG.planEndsAtTargetTrend); if (why !== null) throw new Error(`planEndsAtTargetTrend is unusable: ${why}`); }   // lv1 r13.3.7d: fail closed at startup
  { const c = CONFIG.maxEntryPastLevelPts; if (!(c === null || (Number.isFinite(c) && c > 0 && c <= 500))) throw new Error(`maxEntryPastLevelPts is unusable: null (off) or points past the level, more than 0 and at most 500, got ${JSON.stringify(c)}`); }   // lv1 r13.3.7-candidate: fail closed
  if (scaleOutRunnerOn(CONFIG) && CONFIG.profitTrail) {
    const was = CONFIG.profitTrail.enabled;
    CONFIG.profitTrail.enabled = false;
    for (const item of CONFIG_LOCAL.overrides) if (item.key === 'profitTrail' || item.key.startsWith('profitTrail.')) { item.requested = item.to; item.to = item.key === 'profitTrail' ? { ...CONFIG.profitTrail } : item.key === 'profitTrail.enabled' ? false : item.to; item.note = 'scaleOutRunner on: the whole-position profit lock is off'; }
    log(`[so1] scale-out at +${CONFIG.scaleOutRunner.atPts}: all but 1 contract exit there; the runner's stop goes to +${CONFIG.scaleOutRunner.runnerLockPts}, then trails ${CONFIG.scaleOutRunner.runnerLockPts} pts behind the best price in ${CONFIG.scaleOutRunner.runnerStepPts}-pt steps. Whole-position profit lock: OFF${was ? ' (config-local had it on; forced off)' : ''}. Same-direction block after a stop-out: ${CONFIG.stopOutSameDirBlockMin > 0 ? 'rest of the ' + CONFIG.stopOutSameDirBlockMin + 'm candle' : 'off'}.`);
  }
  { const p = minContractsProblem(CONFIG, pointValue); if (p) throw new Error(`minContracts is unusable: ${p}`); }   // lv1 size1 CONSISTENT SIZE: fail closed at startup
  { const w = minContractsMaxStopPts(CONFIG, pointValue); log(CONFIG.minContracts === 3 ? `[size] minimum 3 contracts: ${w === null ? 'setups sized below 3 are skipped (the $ risk cap is off)' : `setups whose stop needs more than ${w} pts are skipped`}` : '[size] minimum contracts: off'); }   // lv1 size1
  // np1: fail closed at startup on unusable values (config-local cannot slip a bad one in)
  { const n = CONFIG.flatSizeContracts; if (!(Number.isInteger(n) && n >= 0 && n <= CONFIG.baseContracts)) throw new Error(`flatSizeContracts is unusable: a whole number from 0 to baseContracts (${CONFIG.baseContracts}), got ${JSON.stringify(n)}`); }
  { const np = CONFIG.noProgressExit; if (!np || typeof np.enabled !== 'boolean' || !(Number.isFinite(np.mfePts) && np.mfePts > 0)) throw new Error('noProgressExit is unusable: { enabled: true/false, mfePts: a positive number }'); }
  if (!(CONFIG.noProgressExit.candles === 1 || CONFIG.noProgressExit.candles === 2)) throw new Error(`noProgressExit.candles is unusable: 1 (the first full 5m candle after the fill) or 2 (the second), got ${JSON.stringify(CONFIG.noProgressExit.candles)}`);   // lv1 r13.3.7: fail closed at startup
  { const h = CONFIG.noProgressExit.hourEndDefer; if (!(h === null || (Number.isInteger(h) && h >= 1 && h <= 15))) throw new Error(`noProgressExit.hourEndDefer is unusable: null (off) or whole minutes 1-15, got ${JSON.stringify(h)}`); }   // lv1 r13.3.7e: fail closed
  { const h = CONFIG.htfOpenEntryBlockMin; if (!(h === null || (Number.isInteger(h) && h >= 1 && h <= 30))) throw new Error(`htfOpenEntryBlockMin is unusable: null (off) or whole minutes 1-30, got ${JSON.stringify(h)}`); }   // lv1 r13.3.7e: fail closed
  log(`[lv1] levels-triggered entries: ${CONFIG.levelsOnlyEntries ? 'ON (levels only - MAC has no input; MAC-only candidates journaled LEVELS_ONLY)' : 'off'}; Levels trigger required: ${CONFIG.levelsTriggerRequired}; level events: ${CONFIG.levelEvents ? 'ON' : 'off'} (control gate: ${CONFIG.levelEventControl}; break-retest: ${CONFIG.levelRetest === true ? 'ON' : 'off'}); far-limit switch: ${CONFIG.farLimitSwitch ? 'ON' : 'off'}; morning hold: ${morningHoldLabel()}; NY-open block: ${CONFIG.blockNyOpenMinutes ? CONFIG.blockNyOpenMinutes + ' min' : 'off'}; levels journal: ${path.basename(LEVEL_JOURNAL_PREFIX)}<TradeDay>.jsonl.`);
  { const c = CONFIG.levelStopMaxFromFillPts; if (!(c === null || (Number.isFinite(c) && c > 0 && c <= 500))) throw new Error(`levelStopMaxFromFillPts is unusable: null (off) or points from the fill, more than 0 and at most 500, got ${JSON.stringify(c)}`);
    const f = CONFIG.entryStopFloor, fl = s => (f && f.enabled === true && Number.isFinite(f[s]) ? f[s] : null), eff = s => (fl(s) === null ? c : Math.max(c, fl(s))), per = s => `${eff(s)} (floor ${fl(s) === null ? 'off' : fl(s)})`;   // lv1 r13.3.1: the effective cap AND the floor
    log(`[lv1] stop cap from the fill: ${c === null ? 'off (levelStopMaxFromFillPts null - the stops are as in r13.3)' : `${c} pts - a levels entry's resting stop is moved in to at most ${c} pts from the actual fill once filled (verified replace, before TP1); the size stays what the structural stop gave (never sized up); never inside the session floor; effective cap per session: Asia ${per('asia')}, London ${per('london')}, NY ${per('ny')}, late ${per('late')}`}.`); }   // lv1 r13.6.2
  log(`[lv1] monthly / quarterly levels: ${CONFIG.htfLevels ? `ON (${levelEvent.HTF_NAMES.join(', ')} - above the weekly levels in the hierarchy; from the bot's own 1M / 1D bars, running highs / lows from completed days only)` : 'off (htfLevels false - the levels are as in r13.3.3)'}.`);   // lv1 r13.3.4
  { const r = CONFIG.reversalExit; log(`[rev] reversal exit: ${r.mode === 'log' ? `SHADOW LOG (journal rows only - no order, the trades are unchanged): R4 = ${r.momentumBars} falling 1m closes, ${r.momentumPts}+ pts in total, the last past the entry; R2 = a 5m close ${r.levelPts}+ pts back through the trade's level (no level known = not evaluated); a trade_state row at every 1m close before TP1` : 'off'}.`); }   // lv1 r13.3.3
  { const o = CONFIG_LOCAL.overrides.find(x => x.key === 'controlGateMin');   // lv1 r13.3.3-ctl1: the line the gate uses (lib/entryControl.js reads the same locked value)
    log(`[control] 15m control line: +/-${CONFIG.controlGateMin} (${o ? `config-local; shipped ${o.from}` : 'shipped'})`); }
  log(`[levels] control score: ${CONFIG.levelsParity === 'pine' ? 'Pine parity (15m ATR + level dedupe: momentum and progress over the chart ATR(14), levels within 2 ticks merged)' : 'bot formula (1H ATR)'}.`);   // lv1 r13.3.4 lp1
  log(`[tp1] TP1 from the fill: ${CONFIG.tp1FromFill ? (scaleOutRunnerOn(CONFIG) ? 'ON (TP1 = the actual fill +/- the planned TP1 distance on every fill, a fill the slip guard keeps included; the stop handling unchanged)' : 'ON, inactive (the scale-out runner is off: TP1 as planned)') : 'off (tp1FromFill false - a fill the slip guard keeps leaves TP1 at its planned price, as in r13.3.4)'}.`);   // lv1 r13.3.5
  log(`[lv1] plan ends at its target: ${CONFIG.planEndsAtTarget ? 'ON (a live level event ends for good once a price seen after its birth trades at or through its target, a projected one included, before an entry)' : 'off (planEndsAtTarget false - an event ends on a close back across, a VWAP reset or 30 min, as in r13.3.4)'}.`);   // lv1 r13.3.5
  log(`[lv1] entry past the level: ${CONFIG.maxEntryPastLevelPts === null ? 'off (maxEntryPastLevelPts null - every levels entry as before)' : `at most ${CONFIG.maxEntryPastLevelPts} pts - a levels entry farther past its level is skipped (PAST_LEVEL)`}.`);   // lv1 r13.3.7-candidate
  log(`[lv1] plan-end trend allowance: ${CONFIG.planEndsAtTargetTrend === null ? 'off (planEndsAtTargetTrend null - an entry after its plan target was reached is decided by planEndsAtTarget alone, as in r13.3.5)' : `${planEndTrendLabel(CONFIG.planEndsAtTargetTrend)} - ${CONFIG.planEndsAtTarget ? 'with planEndsAtTarget ON, a level event whose target was reached before an entry stays live and is still taken when ' + (CONFIG.planEndsAtTargetTrend.mode === 'dailyOpenPts' ? `the entry price is at least ${CONFIG.planEndsAtTargetTrend.pts} pts past the 15:00 PT daily open in its direction` : `the 15m / 1H / 4H alignment points its way, the price is beyond the prior TradeDay's high (long) / low (short) and ${CONFIG.planEndsAtTargetTrend.accept.closes} consecutive completed ${CONFIG.planEndsAtTargetTrend.accept.tf} candle(s) of this TradeDay closed beyond it`) + '; otherwise it ends (target-reached, PLAN_END_TARGET)' : 'NO EFFECT: planEndsAtTarget is off'}`}.`);   // lv1 r13.3.7d
  log(`[np1] no-progress check time: noProgressExit.candles ${CONFIG.noProgressExit.candles} = the close of the ${CONFIG.noProgressExit.candles === 2 ? 'SECOND full 5m candle after the fill (10-15 min after it; the timer test)' : 'first full 5m candle after the fill (5-10 min after it), as in r13.3.5'}${CONFIG.noProgressExit.enabled ? '' : ' (the exit itself is off)'}.`);   // lv1 r13.3.7
  log(`[np1] no-progress hour-end defer: ${CONFIG.noProgressExit.hourEndDefer === null ? 'off (noProgressExit.hourEndDefer null - the check time never moves)' : `${CONFIG.noProgressExit.hourEndDefer} min - a check time in the last ${CONFIG.noProgressExit.hourEndDefer} minutes of a 1H candle moves to the next 5m close (one candle, once)`}.`);   // lv1 r13.3.7e
  log(`[lv1] 4H-open entry wait: ${CONFIG.htfOpenEntryBlockMin === null ? 'off (htfOpenEntryBlockMin null - entries at any minute of a 4H candle)' : `${CONFIG.htfOpenEntryBlockMin} min - no new levels entry in the first ${CONFIG.htfOpenEntryBlockMin} minutes of a 4H candle (15:00 / 19:00 / 23:00 / 03:00 / 07:00 / 11:00 PT; HTF_OPEN_WAIT)`}.`);   // lv1 r13.3.7e
  for (const l of tideWire.startupLines(CONFIG, pointValue, tickSize)) log(l);
  try { const h16 = f => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'lib', f))).digest('hex').slice(0, 16); log(`[tide] shas structure=${h16('structure.js')} money=${h16('moneyRule.js')} wire=${h16('tideWire.js')} node=${process.version}${tideWire.modeOf(CONFIG) === 'live' ? ` orders=${h16('tideOrders.js')} live=${h16('tideLive.js')}` : ''}`);
  try { if (tideWire.modeOf(CONFIG) === 'live') log(`[tide] mode LIVE: ${tideLive.VERSION} + planner ${require('./lib/tideOrders').VERSION} send REAL orders for TIDE signals${LIVE ? '' : ' (paper run: no driver, takes are refused)'}; take1 ceiling $${tideWire.take1Max(CONFIG)}; TIDE entry blocks ${tideWire.blocksText(CONFIG)} (news wait + 12:55 PT always); open wait ${CONFIG.tide.openWaitMin} min; old levels path ${CONFIG.tide.oldPathEntries === true ? 'ON (new entries too)' : 'OFF (manage-only; its signal pushes silenced)'}; warm-up bias rebuild ${fs.existsSync(path.join(__dirname, 'lib', 'tideRebuild.js')) ? 'ON (lib/tideRebuild.js)' : 'OFF (PRE_RESTART fallback)'}.`); } catch (e) { /* log only */ } } catch (e) { log(`[tide] shas unavailable (${e.message})`); }   // TIDE r2: which libs scored the shadow   // TIDE r2: '[tide] new model ...' + money-r4.1's '[sizing] ...' and '[money] config ...'
  log(`[np1] no-progress exit: ${CONFIG.noProgressExit.enabled ? `ON (not seen at +${CONFIG.noProgressExit.mfePts} pts by the ${CONFIG.noProgressExit.candles === 2 ? 'second' : 'first'} full 5m close after the fill = closed at market)` : 'off'}. Stretch check: ${CONFIG.stretchCheck}${CONFIG.stretchCheck === 'log' ? ' (journal only, trades unchanged)' : ''}. Size: ${CONFIG.flatSizeContracts ? `flat ${CONFIG.flatSizeContracts} contracts at every grade (the $${CONFIG.maxRiskPerTradeUsd} risk cap can size it down)` : 'grade ceilings'}.`);
  log(`[sr-areas] ${SR_AREAS_VERSION}: ${CONFIG.srAreas === 'show' ? `DISPLAY ONLY - Support & Resistance Areas once per completed 1H bar from the bars already fetched (no provider call); the phone (snapshot srAreas) and ${path.basename(SRA_JOURNAL_PREFIX)}<TradeDay>.jsonl; nothing in trading reads it` : 'off'}.`);   // lv1 r13.6.3
  log(`[po3] ${PO3_VERSION}: ${CONFIG.po3Observe === 'log' ? `OBSERVE-ONLY - writes po3_state / cluster_map to ${path.basename(PO3_JOURNAL_PREFIX)}<TradeDay>.jsonl (run ${PO3_RUN_ID}), trades unchanged` : 'off'}.`);
  log(`=== ${LIVE ? 'LIVE ORDER' : 'PAPER TRADING'} EXECUTOR starting for ${symbol} ===`);
  log(`Config: ${JSON.stringify(CONFIG)}`);
  if (CONFIG_LOCAL.present) {   // config-local.json overrides, listed one per line so the log shows exactly what differs from the shipped defaults
    log(`[config-local] ${CONFIG_LOCAL_FILE} applied: ${CONFIG_LOCAL.overrides.length} setting(s) overridden over the shipped defaults:`);
    for (const o of CONFIG_LOCAL.overrides) log(`[config-local]   ${o.key} = ${JSON.stringify(o.to)}   (shipped default ${JSON.stringify(o.from)}${JSON.stringify(o.from) === JSON.stringify(o.to) ? ' - same' : ''})`);
  } else log(`[config-local] no ${path.basename(CONFIG_LOCAL_FILE)} - running the shipped defaults.`);
  { const sc0 = sessionCloseState(Date.now(), CONFIG), badTimes = CONFIG.sessionClose ? validateSessionTimes(CONFIG) : [];
    const ec = splitEarlyCloses(CONFIG.sessionEarlyCloses, badTimes.length ? '13:05' : CONFIG.sessionFlattenPt);   // round 3 (QA R2-2): entries are validated one by one
    log(`[session] ${CONFIG.sessionClose ? `session close ON: no new entries ${CONFIG.sessionNoEntryFromPt}-15:00 PT, flatten at ${CONFIG.sessionFlattenPt} PT, urgent alert if not flat ${CONFIG.sessionFlattenAlertSec} s later (Topstep: flat by 13:10 PT)` : 'session close OFF (set-session.sh on)'} | early closes: ${ec.good.length ? ec.good.map(e => e.date + ' ' + e.flattenPt).join(', ') : 'NONE'}${ec.bad.length ? ` | ${ec.bad.length} INVALID entr${ec.bad.length === 1 ? 'y' : 'ies'} SKIPPED` : ''}`);
    for (const b of badTimes) log(`[session] WARNING: ${b} - using the shipped 12:55 / 13:05 PT instead.`);
    if (ec.bad.length) {
      for (const b of ec.bad) log(`[session] !!! WARNING: early-close entry ${b.date || '#' + b.index} SKIPPED: ${b.problems.join('; ')}. The other early-close dates stay active. Fix it with set-session.sh early <date> <HH:MM>.`);
      notifyPhone('Holiday early-close setting SKIPPED', `${ec.bad.length} early-close entr${ec.bad.length === 1 ? 'y is' : 'ies are'} invalid and ignored (${ec.bad.map(b => b.date || '#' + b.index).join(', ')}): ${ec.bad[0].problems[0]}. The other dates still apply. Fix: bash /opt/mac-bot/set-session.sh early <date> <HH:MM>, then restart when flat.`, { priority: 'high', tags: 'warning' });
    }
    if (sc0.candidate) log(`[session] WARNING: today ${sc0.date} may be a CME early close (${sc0.candidate}; UNVERIFIED) and it is not in sessionEarlyCloses: the bot will flatten only at ${sc0.flattenPt} PT.`); }
  log(`[levels] session anchor: ${CONFIG.sessionAnchor === 'cme' ? 'cme - Levels PRO + MAC Trap day rolls at 15:00 PT (CME session, like the indicators), VWAP restarts 06:30 PT' : 'legacy - levels day rolls at PT midnight, VWAP restarts 06:30 PT'}`);

  // 10/18: `token` is a lib/brokerAuth.js BrokerAuth, not a string. `Bearer ${token}` is always the CURRENT token, so every call below (bars, position,
  // orders, reconciliation, the state machine) uses the renewed one; lib/bars.js ptxFetch re-logs in on HTTP 401 and retries once (orders: no duplicate).
  const clampCfg = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const token = new BrokerAuth({ rawFetch: rawPtxFetch,
    refreshHours: clampCfg(CONFIG.tokenRefreshHours, 0.01, 23, 20), minGapMs: clampCfg(CONFIG.authReloginMinGapSec, 1, 600, 60) * 1000,
    log: m => log(m),
    journal: ev => { try { appendJournal(ev); } catch (e) { /* the journal is not set up yet during startup */ } },
    alert: (n, why) => notifyPhone('BROKER AUTH FAILED', `${symbol}: the broker login failed ${n} times in a row (${why}). The bot cannot read prices or the position and sends NO orders until it works again. Check TopstepX and the API key; open positions keep their broker-side stops.`, { priority: 'urgent', tags: 'rotating_light' }) });
  await login(token);
  log(`[auth] broker login OK; the token is renewed every ${token.refreshHours} h, and on any HTTP 401 (at most once per ${Math.round(token.minGapMs / 1000)} s).`);
  const contractId = await resolveContract(token, symbol);
  if (!contractId) { console.error(`Could not resolve a contract for ${symbol}`); process.exit(1); }
  log(`Contract: ${contractId}`);

  let account = null;
  if (LIVE) {
    const accounts = await getAccounts(token);
    if (!accounts.length) { console.error('Could not resolve any account.'); process.exit(1); }
    // Running unattended under a process supervisor (systemd, so it survives
    // your computer sleeping/being closed) means there's no TTY — readline
    // would hang forever waiting for input that can never come, so every
    // interactive prompt below needs a non-interactive equivalent. Both fail
    // CLOSED (refuse to start) rather than silently picking a default, same
    // spirit as the original prompts: never guess which account to trade.
    const interactive = !!process.stdin.isTTY;
    if (accounts.length === 1) {
      account = accounts[0];
    } else if (interactive) {
      console.log('\nMultiple active accounts found:');
      accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.name || a.id}  (id=${a.id})  balance=${a.balance ?? 'unknown'}`));
      const pick = await askConfirmation('Type the number of the account to trade: ');
      const idx = parseInt(pick.trim(), 10) - 1;
      if (!(idx >= 0 && idx < accounts.length)) { console.log('Invalid selection. Cancelled.'); process.exit(0); }
      account = accounts[idx];
    } else {
      const wantId = process.env.PTX_ACCOUNT_ID;
      account = wantId ? accounts.find(a => String(a.id) === String(wantId)) : null;
      if (!account) {
        console.error('Non-interactive session with multiple accounts — set PTX_ACCOUNT_ID to the exact account id to trade. Found:');
        accounts.forEach(a => console.error(`  id=${a.id}  name=${a.name || '(unnamed)'}  balance=${a.balance ?? 'unknown'}`));
        process.exit(1);
      }
    }
    console.log(`\n*** LIVE ORDER MODE ***`);
    console.log(`Account: ${account.name || account.id}  (id=${account.id})  balance=${account.balance ?? 'unknown'}`);
    console.log(`This will place REAL orders on the account above using your validated 3-contract shave config.`);
    if (interactive) {
      const answer = await askConfirmation('Type LIVE (all caps) to confirm and start, anything else to cancel: ');
      if (answer.trim() !== 'LIVE') { console.log('Cancelled.'); process.exit(0); }
    } else {
      // Require the SAME "LIVE" confirmation explicitly via an env var,
      // set once and deliberately in the service's environment file —
      // a missing or wrong value fails closed (refuses to start) instead
      // of an unattended restart ever silently trading by accident.
      if (process.env.PTX_CONFIRM_LIVE !== 'LIVE') {
        console.error('Non-interactive session (no TTY) and PTX_CONFIRM_LIVE=LIVE is not set — refusing to start LIVE mode unattended without explicit confirmation.');
        process.exit(1);
      }
    }
    log(`Confirmed LIVE mode against account ${account.name || account.id} (${account.id}).`);
  }

  // FIX1015: VIX is refreshed daily (main loop: vixFeed.maybeRefresh) and a failed fetch keeps the last value (also across restarts, vix-cache.json) and alerts.
  // 10/16 NEWS AWARENESS: calendar file next to this script; refreshed in the background (never blocks, never throws).
  const newsCal = new NewsCalendar({ file: path.join(__dirname, 'news-calendar.json'), log });
  newsCal.load();
  let newsLastRefresh = 0;
  function newsMaybeRefresh(now = Date.now()) {
    if (process.env.MACBOT_NEWS_FETCH === '0' || !CONFIG.newsAware) return;   // QA 10/16 R3: no download while news awareness is off   // tests (test-fakeclock.js preload) never fetch the calendar
    if (!CONFIG.newsCalendarUrl || now - newsLastRefresh < (CONFIG.newsCalendarRefreshMs || 21600000)) return;
    newsLastRefresh = now; newsCal.refresh(CONFIG.newsCalendarUrl).catch(() => {});
  }
  // the high-impact release resting entry orders must be pulled for now (null when none, or newsAware off)
  function newsRestingBlock(ts = Date.now()) { if (!CONFIG.newsAware) return null; newsCal.load(); return newsCal.restingBlock(ts, CONFIG.newsCancelRestingSec); }
  function newsNearestMin(ts = Date.now()) { return newsCal.nearestHighMin(ts); }
  // 10/16 NO-CHASE (see CONFIG.noChase): the decision for a new entry in `dir` at `entry` on the latest 15m bars; null = allowed (also on any missing data)
  let lastFlagEvalAt = 0;       // 10/17 round 2: the display-only flag MAC evaluation is throttled mid-bar
  let sessionFlags = null;      // 10/17 SESSION FLAG COUNT (display/logging only): { m15: {long,short,lead,text,since,bars,partial}, m5: null } from the last MAC evaluation (declared before refreshAndEvaluate: the warmup evaluates first)
  let noChaseBars = null, noChase5Bars = null;   // round 4: the 5m bars of the same evaluation (the reference swing)
  if (CONFIG.noChase && CONFIG.noChaseMode === 'pullback') log("  [no-chase] noChaseMode 'pullback' is not tested yet - using 'skip' (the signal is skipped, no pullback order).");
  function noChaseBlock(dir, entry, px = (() => { try { return livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose; } catch (e) { return lastKnownClose; } })()) {
    if (!CONFIG.noChase || !Array.isArray(noChaseBars) || noChaseBars.length < 16) return null;
    const nowNc = Date.now(), closed5 = Array.isArray(noChase5Bars) ? noChase5Bars.filter(b => b && b.t + 300000 <= nowNc) : null;   // CLOSED 5m bars only
    const d = noChaseDecision({ dir, entry, closed: noChaseBars.slice(0, -1), forming: noChaseBars[noChaseBars.length - 1], closed5, px, k: CONFIG.noChaseAtr });
    return d.chase ? d : null;
  }
  // np1 STRETCH CHECK row (r1.1: the closed-5m approximation 'stretch-5m-approx-v1'): one per takeEntry call, before every admission check. Journal only; the
  //   flag is enforced in takeEntry only when stretchCheck is 'block'. Decision price = the live 1m price (else the last close); bars = this evaluation's 5m bars.
  function stretchRow(dir, entryType, entryPrice, source, grade, signalContext, planInfo) {
    if (CONFIG.stretchCheck !== 'log' && CONFIG.stretchCheck !== 'block') return null;
    const now = Date.now(), px = livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose;
    let atr15 = null; try { atr15 = Array.isArray(noChaseBars) && noChaseBars.length >= 16 ? atr14(noChaseBars.slice(0, -1).slice(-400)) : null; } catch (e) { atr15 = null; }
    const f = stretchFeatures({ dir, px, now, bars5: noChase5Bars, atr15 });
    appendJournal({ type: 'stretch_check', t: now, mode: CONFIG.stretchCheck, journalId: signalContext && signalContext.journalId || null, dir, entryType, entry: entryPrice, source, grade,
      path: planInfo ? planInfo.path || null : null, levelName: signalContext && signalContext.levelContext ? signalContext.levelContext.name : null, pxSource: livePx && Number.isFinite(livePx.price) ? '1m-live' : 'last-close', ...f });
    return f;
  }
  // sr-areas r1 (lv1 r13.6.3) DISPLAY ONLY. srAreasTick runs from refreshAndEvaluate right after the observer call. It schedules (setImmediate: a later event-loop turn, never inside the
  //   evaluation) at most ONE compute per completed 1H bar of this evaluation's htf.H1 (asOf = that bar's end), from the bars already fetched (no provider call). The result
  //   is kept for the snapshot, which re-picks the nearest areas and their distances at its own price on every write (srAreasView). One sr_areas row per completed 1H
  //   bar to sr-areas-<SYMBOL>-<TradeDay>.jsonl ONLY (never the trade journal): 64 KB per row, 1 MB per TradeDay, the day file's size is read (only ENOENT = 0 bytes), an
  //   unknown size or a write error skips the row (fail closed). A throw keeps the previous result (logged at most every 10 min). 3 runs in a row over SRA_BUDGET_MS
  //   turn sr-areas off for this process (logged): a RETROSPECTIVE breaker (r13.6.3b wording, MacDot 6497691546) - each run is timed after it has finished, so it
  //   bounds how long sr-areas keeps costing the event loop, not how long one run takes; it isolates the decision data (nothing in admission, sizing, stops,
  //   exits or orders reads sra / srAreasView), it is not a latency cap.
  const sra = { asOf: null, at: null, result: null, off: null, busy: false, overBudget: 0, runs: 0, errors: 0, lastMs: 0, maxMs: 0, day: null, file: null, bytes: null, rows: 0, capped: 0, writeFails: 0, statFails: 0, logAt: 0, busySince: 0, stuck: 0, schedFails: 0, rowAsOf: null };
  function sraLog(msg) { if (Date.now() - sra.logAt > 600000) { sra.logAt = Date.now(); try { log(`  [sr-areas] ${msg} (display only; trading unaffected)`); } catch (_) { /* log only */ } } }
  function sraWrite(row) {
    const d = effectiveDayKey(row.t); if (d !== sra.day) { sra.day = d; sra.file = `${SRA_JOURNAL_PREFIX}${new Date(d + 43200000).toISOString().slice(0, 10)}.jsonl`; sra.bytes = null; }
    const line = JSON.stringify(row) + '\n', n = Buffer.byteLength(line);
    if (sra.bytes == null) { try { sra.bytes = fs.statSync(sra.file).size; } catch (e) { if (e && e.code === 'ENOENT') sra.bytes = 0; else { sra.statFails++; sraLog(`day-file size unknown (${e && e.code || e}); row skipped`); return false; } } }
    if (n > SRA_ROW_MAX || sra.bytes + n > SRA_DAY_MAX) { sra.capped++; return false; }
    try { fs.appendFileSync(sra.file, line); sra.bytes += n; sra.rows++; return true; } catch (e) { sra.writeFails++; sraLog(`row not written (${e && e.code || e})`); return false; }
  }
  const SRA_STUCK_MS = 120000;   // lv1 r13.6.3b (MacShip F1): a compute scheduled but not run for this long is cleared - with a log line, never silently
  const sraOkBar = b => !!b && Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h >= b.l && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c);   // = lib/srAreas.js okBar
  function sraPrice(bars) {   // lv1 r13.6.3b: the latest close in the bars this evaluation fetched (15m, else 1H) - never lastKnownClose, which is not initialised during the warmup
    for (const k of ['M15', 'H1']) { let best = null; for (const b of Array.isArray(bars[k]) ? bars[k] : []) if (sraOkBar(b) && (!best || b.t > best.t)) best = b; if (best) return best.c; }
    return NaN;
  }
  function srAreasTick(bars) {
    if (CONFIG.srAreas !== 'show' || sra.off || !bars || !Array.isArray(bars.H1)) return false;
    const cutoff = Date.now();   // lv1 r13.6.3b (MacDot 6497691546): the ACQUISITION cutoff of these bars - eligibility AND the compute use it, never the callback's clock
    if (sra.busy) {   // lv1 r13.6.3b (MacShip F1): a compute that was scheduled but never ran is cleared after SRA_STUCK_MS, visibly
      if (cutoff - sra.busySince < SRA_STUCK_MS) return false;
      sra.stuck++; sra.busy = false;
      try { log(`  [sr-areas] the compute scheduled ${Math.round((cutoff - sra.busySince) / 1000)} s ago never ran - cleared (${sra.stuck}x in this process); computing again from this poll (display only; trading unaffected)`); } catch (_) { /* log only */ }
    }
    let lastEnd = null;
    for (const b of bars.H1) if (sraOkBar(b) && b.t + 3600000 <= cutoff && (lastEnd === null || b.t + 3600000 > lastEnd)) lastEnd = b.t + 3600000;   // = the lib's asOf at this cutoff
    if (lastEnd === null || lastEnd === sra.asOf) return false;   // the key IS the result hour: one compute per completed 1H bar, not one per poll
    try {
      const input = { h1: bars.H1, h4: bars.H4, d: bars.D, m15: bars.M15, now: cutoff, price: sraPrice(bars) };
      sra.busy = true; sra.busySince = cutoff; sra.asOf = lastEnd;   // one attempt per completed 1H bar, whatever its outcome
      setImmediate(() => {
        const t0 = Date.now();
        try {
          const r = srAreasCompute(input), ms = Date.now() - t0; sra.runs++;
          if (r && r.asOf != null) {
            sra.result = { ...r, all: r.all.map(({ trace, ...a }) => a) }; sra.at = t0;
            if (r.asOf !== sra.rowAsOf) {   // one row per result hour, never twice
              sra.rowAsOf = r.asOf;
              sraWrite({ type: 'sr_areas', t: t0, version: r.version, asOf: r.asOf, cutoff, price: r.refPrice, atr: r.atr, maxDistPts: r.maxDistPts, coverage: r.coverage, computeMs: ms, live: r.live,
                areas: r.all.map(a => [a.kind, a.lo, a.hi, a.tfs.join('+'), a.touches, a.rejectBy.wick, a.rejectBy.stall, a.breaks, a.strength, a.status, a.firstT, a.lastT]) });
            }
          } else if (r) sraLog(`no areas this hour (${r.coverage}); the previous result is kept`);
        } catch (e) { sra.errors++; sraLog(`compute error: ${e && e.message}; the previous result is kept`); }
        finally {
          sra.lastMs = Date.now() - t0; sra.maxMs = Math.max(sra.maxMs, sra.lastMs);
          if (sra.lastMs > SRA_BUDGET_MS) { sra.overBudget++; if (sra.overBudget >= 3) { sra.off = `over the ${SRA_BUDGET_MS} ms budget 3 runs in a row`; try { log(`  [sr-areas] DISABLED for this process: ${sra.off} (display only; trading unaffected)`); } catch (_) { /* log only */ } } }
          else sra.overBudget = 0;
          sra.busy = false;
        }
      });
      return true;
    } catch (e) { sra.busy = false; sra.asOf = null; sra.schedFails++; sraLog(`the compute could not be scheduled (${e && e.message}); tried again next poll`); return false; }   // lv1 r13.6.3b: never a silent, stuck busy
  }
  function srAreasView(px) {   // the snapshot field: the hourly result re-picked at this price; null = disabled for this process or nothing computed yet
    try { const r = sra.off ? null : sra.result; return r ? { ...srAreasSelect(r, px), all: undefined, computedAt: sra.at, computeMs: sra.lastMs } : null; } catch (e) { return null; }
  }
  // po3 r1.3 OBSERVER (its OWN per-TradeDay file; MacDot 6429000789 / 6429200579 / 6429596500). Scheduled with setImmediate from the bar step of refreshAndEvaluate: it runs
  //   SYNCHRONOUSLY on a later event-loop turn (compute + file append). Declared budget PO3_BUDGET_MS for the whole run (compute + writes); 3 runs in a row over it
  //   disable the observer for this process (logged; trading unaffected). One run at a time; only bars and per-series request/response times this evaluation
  //   already has (po3Req = request START = the conservative completion cutoff; po3Obs = response time) - no new provider calls. Rows go to
  //   po3-journal-<SYMBOL>-<TradeDay>.jsonl ONLY (never the trade journal, its history, index or terminals); the per-TradeDay byte cap reads the day file's size, so it
  //   survives restarts; files are never deleted by the bot (retention: operator). COMMIT AFTER PERSIST: frozen map / Asia / signature advance only after their row
  //   was written. Rows carry the run id and a publication id (content ids repeat on identical inputs; publications do not). r1.3: event first sightings
  //   (frozen.seen) commit after persist too; a day-file stat failure other than ENOENT leaves the size unknown and skips writes (fail closed).
  //   The budget is a POST-RUN circuit breaker: it cannot pre-empt one slow synchronous run, it stops the next ones.
  const po3Req = {}, po3Obs = {}; let po3ReqStart = null;
  const po3Last = { sig: null, frozen: {}, day: null, file: null, bytes: null, pubs: 0, startedAt: null, off: null, overBudget: 0, errAt: 0, statFails: 0, statLogAt: 0, busy: false, runs: 0, errors: 0, writeFails: 0, capped: 0, lastMs: 0, maxMs: 0 };
  function po3Write(row) {
    const line = JSON.stringify(row) + '\n', n = Buffer.byteLength(line);
    if (po3Last.bytes == null) {   // r1.3: only ENOENT establishes a new (empty) day file; any other stat failure = size unknown -> no write, re-stat next time
      try { po3Last.bytes = fs.statSync(po3Last.file).size; } catch (e) {
        if (e && e.code === 'ENOENT') po3Last.bytes = 0;
        else { po3Last.statFails++; if (Date.now() - po3Last.statLogAt > 600000) { po3Last.statLogAt = Date.now(); try { log(`  [po3] day-file size unknown (${e && e.code || e}); observer writes skipped until a stat succeeds (trading unaffected)`); } catch (_) { /* log only */ } } return false; }
      }
    }
    if (n > PO3_ROW_MAX || po3Last.bytes + n > PO3_DAY_MAX) { po3Last.capped++; return false; }
    try { fs.appendFileSync(po3Last.file, line); po3Last.bytes += n; return true; } catch (e) { po3Last.writeFails++; return false; }
  }
  function po3Observe(bars, req, obs) {
    if (CONFIG.po3Observe !== 'log' || po3Last.off || po3Last.busy || !bars) return;
    po3Last.busy = true;
    if (po3Last.startedAt == null) po3Last.startedAt = Date.now();
    const reads = { ...(req || {}) }, seen = { ...(obs || {}) };
    setImmediate(() => {
      const t0 = Date.now();
      try {
        const r = po3Compute({ now: t0, m5: bars.M5, h1: bars.H1, h4: bars.H4, d: bars.D, w: bars.W, readAt: reads, observedAt: seen, observerStartedAt: po3Last.startedAt, frozen: po3Last.frozen });
        po3Last.runs++;
        if (r.tradeDay !== po3Last.day) { po3Last.day = r.tradeDay; po3Last.file = `${PO3_JOURNAL_PREFIX}${new Date(Date.parse(r.tradeDay) + 43200000).toISOString().slice(0, 10)}.jsonl`; po3Last.bytes = null; }
        const meta = { run: PO3_RUN_ID, computeMs: Date.now() - t0, prevTotalMs: po3Last.lastMs, maxTotalMs: po3Last.maxMs, budgetMs: PO3_BUDGET_MS };
        if (r.mapIsNew) {
          const publication = `${PO3_RUN_ID}:map${po3Last.pubs + 1}`;
          if (!po3Write({ type: 'cluster_map', t: t0, publication, ...meta, ...r.map })) return;
          po3Last.pubs++; po3Last.frozen = { ...po3Last.frozen, map: { ...r.map, publication } };
        }
        if (r.signature !== po3Last.sig || r.asiaIsNew) {
          if (!po3Write({ type: 'po3_state', t: t0, ...meta, mapPublication: po3Last.frozen.map ? po3Last.frozen.map.publication : null, firstSinceStart: po3Last.sig === null, ...r.state })) return;
          po3Last.sig = r.signature; po3Last.frozen = { ...po3Last.frozen, seen: r.seenNext };   // r1.3: first sightings commit only after their row is written
          if (r.asiaIsNew) po3Last.frozen = { ...po3Last.frozen, asia: r.state.asia };
        }
      } catch (e) {
        po3Last.errors++;
        if (Date.now() - po3Last.errAt > 600000) { po3Last.errAt = Date.now(); try { log(`  [po3] observer error (observer file only; no trading code reads it): ${e && e.message}`); } catch (_) { /* log only */ } }
      } finally {
        po3Last.lastMs = Date.now() - t0; po3Last.maxMs = Math.max(po3Last.maxMs, po3Last.lastMs);
        if (po3Last.lastMs > PO3_BUDGET_MS) {
          po3Last.overBudget++;
          if (po3Last.overBudget >= 3) { po3Last.off = `over the ${PO3_BUDGET_MS} ms budget 3 runs in a row`; try { log(`  [po3] observer DISABLED for this process: ${po3Last.off} (trading unaffected)`); } catch (_) { /* log only */ } }
        } else po3Last.overBudget = 0;
        po3Last.busy = false;
      }
    });
  }
  // ROUND 4 far-limit: 15m ATR(14) of the latest evaluation's CLOSED 15m bars (Wilder, same as no-chase). null = unknown (no switch).
  function farLimitAtrNow() { return Array.isArray(noChaseBars) && noChaseBars.length >= 16 ? atr14(noChaseBars.slice(0, -1).slice(-400)) : null; }
  function noChaseRow(nowTs, result) {
    if (!CONFIG.noChase) return null;
    if (!result) return { key: 'noChase', label: `Not chasing a leg (>= ${CONFIG.noChaseAtr} ATR past the last 5m swing / leg origin, no 38% pullback)`, pass: null, detail: 'N/A yet' };
    const px = livePx ? livePx.price : lastKnownClose; const d = Number.isFinite(px) ? noChaseBlock(result.dir, px, px) : null;
    return { key: 'noChase', label: `Not chasing a leg (>= ${CONFIG.noChaseAtr} ATR past the last 5m swing / leg origin, no 38% pullback)`, pass: !d,
      detail: d ? noChaseText(d) : `OK${Number.isFinite(px) ? ` (at ${px.toFixed(2)})` : ''}` };
  }
  function newsWaitBlock(ts = Date.now()) { if (!CONFIG.newsAware || !CONFIG.newsWaitAfter) return null; newsCal.load(); return newsCal.waitBlock(ts, CONFIG.newsWaitMinMs); }
  function newsView(ts = Date.now()) {
    newsCal.load();
    const panel = { upcoming: newsCal.upcoming(ts, 7, 40), ...newsCal.sourceInfo() };   // 10/16 "Upcoming news" panel (shown even with news awareness off: Mac decides manually)
    if (!CONFIG.newsAware) return { off: true, next: null, wait: null, ...panel };
    const v = newsCal.view(ts, CONFIG.newsCancelRestingSec, CONFIG.newsWaitAfter ? CONFIG.newsWaitMinMs : undefined); return { ...v, resting: !!newsRestingBlock(ts), waitAfter: !!CONFIG.newsWaitAfter, ...panel };
  }
  function newsChecklistRow(nowTs) {
    if (!CONFIG.newsAware) return null;
    const v = newsCal.view(nowTs, CONFIG.newsCancelRestingSec), blk = newsRestingBlock(nowTs), wt = newsWaitBlock(nowTs);
    const hmw = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
    if (wt) return { key: 'news', label: 'News: trade the reaction, not the release', pass: false,
      detail: `News: ${String(wt.title).split(' / ')[0]} released ${hmw(wt.ms)} PT, entries wait for the ${hmw(wt.until)} PT close (first 15m bar after the release; an open position is managed normally)` };
    const pull = `resting orders pulled ${CONFIG.newsCancelRestingSec >= 60 ? Math.round(CONFIG.newsCancelRestingSec / 60) + ' min' : CONFIG.newsCancelRestingSec + ' s'} before a high-impact release`;
    return { key: 'news', label: 'News (market entries allowed; resting entries pulled before high-impact releases)', pass: null, warn: !!blk,
      detail: v.next ? `News: ${v.text}${v.next.impact === 'high' ? '' : ' (medium)'} (${pull})${blk ? ' - NOW: no resting entry orders until the release' : ''}` : `News: ${v.text} (${pull})` };
  }
  const vixFeed = new VixFeed({ fetchFn: fetchVixDaily, cacheFile: path.join(__dirname, 'vix-cache.json'), log, notify: notifyPhone });
  let vixBars = await vixFeed.init();

  // ============================================================
  // REPAINTING — what changes before the 15m bar actually closes,
  // and how this bot handles it (2026-10-08, Mac's directive).
  // ============================================================
  //
  // Both engines are fundamentally "evaluate as of this bar's close"
  // systems. Every output either one produces for the CURRENT (possibly
  // still-forming) bar is computed off that bar's running `c` (last-traded
  // price so far) — in bar-close mode this is moot, since macOut/levelsOut
  // are only ever read for a bar whose `c` is already final. In intrabar
  // mode, the current bar's `c` moves every poll, so ANY of the following
  // can print, then un-print, then print again before the real close:
  //
  //   - mac.activeDir / mac.activeScore / mac.entryGrade — every EMA/MACD/
  //     regression/trap-tier computation macTrap.js runs keys off the
  //     current bar's close. This is EXACTLY what happened in Mac's own
  //     2026-10-08 case study: WEAK BULL sc5 at 07:15 vs the same bar's
  //     eventual close.
  //   - mac.biasStr ("STRONG BULL"/"STRONG BEAR") — score-threshold labels
  //     on the above, so they move with it.
  //   - mac.chopSkip / mac.hardBlock — ADX(14) and the VIX/late-buyer/
  //     late-seller gates are themselves close-dependent; a bar can swing
  //     through the ADX<15 chop threshold or a late-buyer/seller read more
  //     than once before settling.
  //   - lv.biasStr / lv.biasScore — Levels PRO's own weighted buyer/seller-
  //     control composite. THIS is the one Mac's case study names directly
  //     (BUYERS LEANING -> BUYERS IN CONTROL between 07:15 and 07:30) —
  //     it's a weighted average over every active level's own control
  //     score, each of which is itself close-relative, so it can drift
  //     through a classification boundary (e.g. the 0.22 "IN CONTROL"
  //     line) and back as the bar prints.
  //   - lv.sigLong / lv.sigShort / lv.plan — Levels PRO's sweep/reclaim/
  //     acceptance setup detector. "Acceptance above a level" fundamentally
  //     means "this bar's close ended up above it" — mid-bar, price can
  //     trade above a level and then settle back below, un-printing an
  //     acceptance signal that looked real a minute earlier.
  //   - Any single level's own `behavior` classification (SWEEP/FAIL/
  //     ACCEPT/RECLAIM/etc.) — same close-relative mechanism as the setup
  //     detector above, just per-level instead of aggregate.
  //   - lv.alignedFull ("15m+ 1h+ 4h+") — CORRECTED (2026-10-08): this
  //     reads the CURRENT H1 and H4 bar's close the exact same
  //     "current-period" way it reads M15's, not the closed-bar-safe
  //     lookup — so the 1h/4h legs of this check are ALREADY
  //     live-sensitive in plain bar-close mode too, not something
  //     intrabar mode introduces. requireLevelsAlignment gates on this, so
  //     a levels-sourced signal's eligibility itself can repaint.
  //
  // In short: essentially everything both engines output is subject to
  // repainting intrabar, not some narrow edge case. That's the real cost
  // of trading on a bar before it closes, and it's an accepted, honest
  // tradeoff Mac's directive explicitly chose — "the way a trader watches
  // TradingView live" is this exact tradeoff; a human doing the same thing
  // takes the same risk.
  //
  // What does NOT repaint: M30/D/W/M specifically (not the full HTF set —
  // H1/H4 are the exception above) — see refreshAndEvaluate()'s own
  // comment; they're always closed-bar-only in both modes. And the ENTRY
  // side, once taken, never repaints either — see checkForNewEntry()'s
  // "sticky entries" comment: once takeEntry()/
  // openEntry() commits, isFlat() goes false and NEITHER the bar-close nor
  // the intrabar caller ever calls checkForNewEntry() again until the
  // position is fully closed. A signal that un-prints a poll cycle (or
  // even by the real bar close) later has nothing left to undo — there is
  // no code path anywhere in this file that cancels or flattens a position
  // because the signal that opened it stopped looking as clean. Only the
  // resting stop/target/trail orders (price-based, placed once at entry,
  // managed by the unchanged stateMachine.tick()/maybeRatchetTrail()
  // machinery) govern the exit from that point forward. This is also
  // exactly why intrabar mode's own block never calls flattenNow() or any
  // other closing action — it only ever reads market data and, when
  // isFlat() and a real signal fires, takes a normal entry through the
  // same takeEntry() path the bar-close caller already uses.

  // intrabar evaluation mode (2026-10-08, Mac's directive) — see
  // CONFIG.evaluationMode's own comment for the full design/repainting
  // writeup. htf.M15 (like every timeframe fetchAllTimeframes() returns)
  // already comes back with includePartialBar:true (lib/bars.js's
  // fetchBars) — the still-forming 15m bar's live, continuously-updating
  // OHLC was ALWAYS one array slot away; `closedChartBars` dropping it via
  // slice(0,-1) is the ONLY thing that made this bot "blind between
  // closes" in the first place. intrabar mode's entire implementation is
  // simply NOT dropping it before handing the chart series to
  // evaluateMacTrap/evaluateLevelsPro, which — being pure bar-by-bar replay
  // functions with no persisted state of their own — need no other change
  // to evaluate correctly through to a still-forming last bar.
  //
  // HTF context — CORRECTED (2026-10-08, see lib/bars.js's fetchFastTimeframes
  // comment for the full trace): M30/D/W/M genuinely are closed-bar-only in
  // both modes (only ever read as a fixed Open price or through
  // bsearchClosedIndex). H1 and H4 are NOT — levelsPro.js's alignedFull
  // ("15m+ 1h+ 4h+") reads each one's CURRENT bar's close the same
  // "current period" way M15 itself is read, so they're already
  // live-sensitive today, in plain bar-close mode too. Only M30/D/W/M (plus
  // M10/M5/M3, which only feed the currently-OFF exhaustion-gate veto) are
  // actually unaffected by this flag.
  //
  // API load (2026-10-08): `fast: true` (the intrabar caller only) skips
  // re-fetching M/W/D/M30/M10/M5/M3 — none of those can produce a
  // different value in the seconds since the last full fetch (see above) —
  // and reuses cachedSlowHtf from the most recent full fetch instead,
  // calling fetchFastTimeframes() for just M15/H1/H4, the three that can.
  // Cuts intrabar mode's added call volume from 10/poll to 3/poll with no
  // correctness cost. The bar-close caller (fast omitted, the default)
  // still does a full fetch on every real close, which both evaluates
  // normally AND keeps cachedSlowHtf fresh for the intrabar calls in between.
  //
  // Rate-limit accounting at evaluationIntrabarPollMs=20000 (matches
  // ProjectX Gateway's documented POST /api/History/retrieveBars limit of
  // 50 requests/30s — see https://gateway.docs.projectx.com/docs/getting-started/rate-limits):
  // worst-case alignment fits 2 intrabar firings (3 retrieveBars calls
  // each = 6) inside any 30s window, PLUS a real-bar-close burst
  // (fetchAllTimeframes = 10 calls, near-simultaneous) if one lands in the
  // same window = 16 calls/30s peak, 32% of the 50/30s budget. Comfortable
  // headroom remains even in that worst case; steady state between bar
  // closes is 6/30s (12%). This doesn't account for any undocumented
  // informal "fair-use" ceiling ProjectX's Terms of Use reference beyond
  // the raw published numbers.
  //
  // Levels-trigger timeframes (owner forward-test 2026-10-11): with CONFIG.levelsTriggerTimeframes = ['M15','M5','M3'] each fast
  // (intrabar) poll refreshes M5 and M3 as well = 5 retrieveBars calls per poll instead of 3. Per 20 s loop iteration the
  // calls are now: 1 (m1 fast poll) + 1 (15m bar-close probe) + 5 (intrabar) = 7, i.e. 10.5 per 30 s in steady state (21% of the
  // 50/30 s limit; was 5 per iteration = 7.5 per 30 s). Worst case in one 30 s window: 2 iterations x 7 = 14, plus the full
  // bar-close burst (fetchAllTimeframes = 10 calls, which already fetched M5/M3) = 24 of 50 (48%; was 20 = 40%).
  // ['M15'] only reverts to exactly the old call pattern. Each M5/M3 call asks for historyRefreshLimit bars like the others.
  let cachedSlowHtf = null;
  // ALIGNMENT FRESHNESS (r8): each refresh is one poll generation. Starting a refresh REVOKES the previous generation (alignValidGen = null);
  // each timeframe's read is stamped when its own request COMPLETES (wall + monotonic, non-empty bars only); the generation becomes valid only
  // after the whole fetch succeeded, and its board (the slots the evaluations produced) is published after evaluation. A failed or
  // in-progress refresh therefore leaves no valid evidence. Read by the alignment rule, never by the display.
  let alignGenSeq = 0, alignValidGen = null, alignReads = {}, alignBoard = null;
  function alignPollStart() { alignValidGen = null; alignBoard = null; alignReads = {}; const gen = ++alignGenSeq, reads = {};
    return { gen, reads, onRead: (k, bars) => { if (gen === alignGenSeq && Array.isArray(bars) && bars.length) reads[k] = Object.freeze({ doneAt: Date.now(), mono: displayPerformance.now(), gen, instrument: contractId }); } }; }
  // A refresh whose poll was superseded by a newer one (overlap) must not publish anything: its caller is stopped before it touches any cache
  // or control state (MacDot R8 #2). Returns only for the current poll.
  function alignPollDone(p) { if (p.gen !== alignGenSeq) throw new Error(`refresh superseded by a newer refresh (poll ${p.gen} < ${alignGenSeq}); its data is discarded`); alignReads = p.reads; alignValidGen = p.gen; }
  function alignPollCurrent(p) { return !!p && p.gen === alignGenSeq && p.gen === alignValidGen; }
  function alignFreshnessOn() { return CONFIG.alignmentFreshnessPolicy === ALIGN_FRESHNESS_POLICY; }
  // Bound to the caller's own poll: an obsolete poll evaluates with no current generation (every slot UNKNOWN).
  function alignFreshnessOpts(chartTf, poll) {
    if (CONFIG.alignmentFreshnessPolicy === 'measured') return { alignNowMs: Date.now(), alignChartTf: chartTf, alignInstrument: contractId };   // r9.10 measured
    if (!alignFreshnessOn()) return {};
    const cur = alignPollCurrent(poll);
    return { alignFreshness: { nowMs: Date.now(), monoNowMs: displayPerformance.now(), currentGen: cur ? poll.gen : null, instrument: contractId, chartTf, reads: cur ? poll.reads : {} } };
  }
  // JOURNAL CONTEXT (journal only): the bars of the latest successful refresh and when each timeframe was fetched.
  let journalBars = null; const journalReadAt = {};
  function alignFreshnessState() { return { monoNowMs: displayPerformance.now(), currentGen: alignValidGen, instrument: contractId, board: alignBoard }; }
  // Display-only In candle state, declared before the first refreshAndEvaluate so its first fetch stamps too (Macaveli candle-r2).
  const candleReadAt = { M15: null, M30: null, H1: null };   // display only: when each timeframe was really fetched (cached M30 keeps its older time)
  let candleM30 = null, candleM30Busy = false;   // display only: the 30m bars the In candle row reads; never merged into htf / ctlBars, so no gate sees a fresher 30m
  function noteCandleRead(tfs, src) { const t = Date.now(); for (const k of Object.keys(candleReadAt)) if (tfs.includes(k)) candleReadAt[k] = t; if (tfs.includes('M30') && src && src.M30) candleM30 = src.M30; }
  // Display only: 1 extra retrieveBars call (3 bars) per intrabar poll, not awaited (never delays evaluation), one at a time.
  // Budget: steady 10.5 -> 12 per 30 s (24% of 50/30 s); worst window 24 -> 26 of 50 (52%). Failure leaves the slot to go UNKNOWN by age.
  function refreshCandleM30(token, contractId) {
    if (candleM30Busy) return; candleM30Busy = true; const asked = Date.now();   // stamp the request time, never later than the data
    fetchBars(token, contractId, UNIT.MINUTE, 30, { limit: 3 })
      .then(b => { if (Array.isArray(b) && b.length && !(candleReadAt.M30 >= asked)) { candleM30 = b; candleReadAt.M30 = asked; } })   // never overwrite a newer read (e.g. a full fetch that landed meanwhile)
      .catch(() => { /* display only */ })
      .finally(() => { candleM30Busy = false; });
  }
  const levelsTfWarned = new Set();
  const LEVELS_TRIGGER_TFS = (Array.isArray(CONFIG.levelsTriggerTimeframes) && CONFIG.levelsTriggerTimeframes.length) ? CONFIG.levelsTriggerTimeframes : ['M15'];
  const EXTRA_LEVELS_TFS = LEVELS_TRIGGER_TFS.filter(k => k !== 'M15' && EXTRA_FAST_TF[k]);
  function levelsTfWarnOnce(key, msg) { if (!levelsTfWarned.has(key)) { levelsTfWarned.add(key); log('  [levels-trigger] ' + msg); } }
  let entryControlBoard = null;
  const controlExclusion = createControlJournal(appendJournal);
  function entryControlAllowed(dir, source, setup, seam, board = entryControlBoard, triggerAt = null) {
    return controlExclusion(board, dir, { source, setup, seam, triggerAt, triggerTf: board?.triggerTf ?? null });
  }
  // r9.10 LEVELS MINUTE (journal only): at most one row per wall-clock minute with every evaluated chart's Levels PRO board - bias / score,
  // control, alignment per slot WITH its reason code, plan, in-play level and every level (name, price, behavior, control). Compact arrays.
  function journalLevelsMinute(lvByTf, lvPicked, chartBars) {
    const now = Date.now(), minute = Math.floor(now / 60000);
    if (minute === lastLevelsMinute) return;
    const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null), r3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
    const one = lv => !lv ? null : {
      bias: lv.biasStr ?? null, score: r3(lv.biasScore), aligned: lv.alignedFull === true, align: lv.alignmentStatus ?? null, alignText: lv.alignText || lv.tfAlign || null,
      slots: (lv.alignSlots || []).map(s => [s.timeframe, r2(s.open), r2(s.price), s.flag ?? null, s.status ?? null, (s.reasonCodes || [])[0] ?? null]),
      sig: lv.planLong ? 1 : lv.planShort ? -1 : 0,
      plan: lv.plan ? { dir: lv.plan.dir, grade: lv.plan.grade ?? null, type: lv.plan.entryType ?? null, entry: r2(lv.plan.entry), stop: r2(lv.plan.stop), target: r2(lv.plan.target), rr: r2(lv.plan.rr) } : null,
      inPlay: lv.inPlayLevel ? [lv.inPlayLevel.name, r2(lv.inPlayLevel.price), lv.inPlayLevel.behavior ?? null, lv.inPlayLevel.control ?? null] : null,
      atrRef: r2(lv.atrRef), close: r2(lv.close),
      levels: (lv.levels || []).map(L => [L.name, r2(L.price), L.behavior ?? null, L.control ?? null]) };
    const tf = {}; for (const k of Object.keys(lvByTf)) tf[k] = one(lvByTf[k]);
    const row = { type: 'levels_minute', t: now, barT: chartBars && chartBars.length ? chartBars[chartBars.length - 1].t : null, triggerTf: lvPicked.triggerTf ?? null,
      control: { score: r3(lvPicked.controlBiasScore), valid: lvPicked.controlValid === true, line: CONFIG.controlGateMin }, alignPolicy: CONFIG.alignmentFreshnessPolicy, derived: lastDerivedPeriods, tf };
    const d = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    fs.appendFileSync(levelsMinuteFile(d), JSON.stringify(row) + '\n');
    lastLevelsMinute = minute;
  }
  let lastLoggedTriggerTf; // last value logged by the [levels-trigger] line below (log on change only)
  // ── TIDE r2 STAGE 1 SHADOW (MacTide; SPEC-TIDE-r2 E, playbook §1-23) ── journal + phone only. It is given NO order path: it reads the bot's closed 1m bars,
  // the 15m level board and the forming 15m / 30m bias, asks the structure engine (lib/structure.js), and writes lv_tide rows to the levels journal plus one
  // INFO push per new signal. It never calls takeEntry, the state machine or an order function (tests/tide2-exec.test.cjs checks this block's text).
  // Nothing here runs with tide.mode "off" (every call site is behind tideOn()).
  function tideOn() { return tideWire.modeOf(CONFIG) !== 'off'; }
  let tideDrv = null, manualTideNoted = false;   // [2a] the Stage 2a driver (tide.mode "live" + LIVE only): owns the TIDE position; the state machine never holds it
  const tideOwned = () => !!(tideDrv && tideDrv.owned());   // [2a] the guard: a TIDE position exists (pending / open / closing): old entries, adoption and TIDE's own flat gate keep out
  const tideLiveOn = () => tideWire.modeOf(CONFIG) === 'live';
  let tideLiveReady = false, tideCatchup = false, tideWarmAlerted = false, tideHourAt = 0;   // [2a] TIDE takes live signals only after its warm-up (and the bias rebuild, when lib/tideRebuild.js is present) finished
  // [2a] TIDE_REBUILD_HOOK (MacStructure, lib/tideRebuild.js): rebuildBias({ m1, now, hours: 6, levelsPro, yieldEvery }) -> Promise<book>, book = tideWire.createBiasBook()
  //   filled with tideWire.noteBias(book, observedAtMs = that 1m bar's close, s15, s30) (levelsPro biasScore on the forming 15m / 30m as of that close). Absent = the
  //   PRE_RESTART fallback: setups armed in the warm-up history are journaled, never pushed or taken.
  function tideRebuildLib() { try { return require('./lib/tideRebuild'); } catch (e) { return null; } }
  let tideShadow = null, tideBoard = [], tideM1Last = null, tideFeedFails = 0, tideFeedNextAt = 0, tideHtf = null, tideOwnNextAt = 0, tideOwnFails = 0, tideBusy = false, tideM1Tail = null, tideM15Tail = null;
  let tideRingReloaded = false;   // [r1.6] today's journal rows reloaded into the phone ring once, at the first TIDE poll (before the warm-up rebuild)
  const tideWarm = { rebuilding: false, doneMin: 0, totalMin: 0, startedAt: null, finishedAt: null, result: null };   // [r1.6] snapshot.tide.warm: the rebuild progress counter (the phone says "warming up - n of N min")
  function tideWarmView() { return { rebuilding: tideWarm.rebuilding, doneMin: tideWarm.doneMin, totalMin: tideWarm.totalMin, startedAt: tideWarm.startedAt, finishedAt: tideWarm.finishedAt, result: tideWarm.result, live: !!tideLiveReady }; }
  const tideBook = tideWire.createBiasBook();   // the forming 15m / 30m Levels PRO bias at each evaluation (playbook §2: intrabar); stamped with the time it was read
  function tideNoteEval(lv15, lv30, htf) {   // refreshAndEvaluate (tideOn only) and tideOwnReading: the board the engine reads + one bias reading
    try { const sc = lv => (lv && Number.isFinite(lv.biasScore) ? lv.biasScore : null);
      if (lv15 && Array.isArray(lv15.levels)) tideBoard = lv15.levels.filter(l => l && typeof l.name === 'string' && Number.isFinite(l.price)).map(l => ({ name: l.name, price: l.price }));
      if (htf) tideHtf = htf;
      tideWire.noteBias(tideBook, Date.now(), sc(lv15), sc(lv30));
    } catch (e) { /* journal-side only */ }
  }
  // The bot's own evaluation runs intrabar only while it is flat (and not day-blocked): with a position open the book would go stale and the engine (which drops a
  // reading > 120 s old) would read no bias. When the book is 40 s old, TIDE computes the forming 15m / 30m bias itself, at most once per 40 s, from bars the bot
  // ALREADY read: the last refresh's bars + the 15m probe of this pass (no request of its own; the bot's htf, caches and boards are not touched).
  function tideOwnReading(now) {
    if (!tideHtf || !Array.isArray(tideHtf.M15) || now < tideOwnNextAt || now - tideWire.lastBiasAt(tideBook) < 40000) return;
    tideOwnNextAt = now + 40000;
    try {
      const m15 = tideWire.mergeTail(tideHtf.M15, tideM15Tail), h = completeCurrentPeriods({ ...tideHtf, M15: m15 }, now).htf, b30 = tideWire.agg30(h.M15);
      const ev = (bars, tf, hh) => { if (!Array.isArray(bars) || bars.length < 100) return null; const o = evaluateLevelsPro(bars, hh, { ...levelsAlignOpts(), ...levelsSessionOpts(), ...levelsVwapOpts(hh), ...levelsParityOpts(), ...alignFreshnessOpts(tf, null) }); return o[o.length - 1] || null; };
      tideNoteEval(ev(h.M15, 'M15', h), ev(b30, 'M30', { ...h, M30: b30 }), null);
      tideOwnFails = 0;
    } catch (e) { tideOwnFails++; tideOwnNextAt = now + 120000; if (tideOwnFails === 1 || tideOwnFails % 10 === 0) log(`  [tide] own bias read failed (${e.message}) - retried in 2 min (shadow only).`); }
  }
  // [r1.5] live health alerts (CLAUDE.md bot ship gate): TIDE not LIVE 10+ min after a start; 3+ starts within 30 min (2 restarts: a crash / OOM loop), from a small
  // state file of start times. The warm-up skipped / stopped pushes are in the rebuild hook. Each alert once per event (priority high = CRITICAL, never INFO-capped).
  let tideHealth = null;
  function tideHealthStep(now) {
    try {
      if (!tideHealth) { tideHealth = { startAt: now, notLiveSent: false };
        const f = path.join(__dirname, `tide-starts-${SYMBOL}.json`); let st = []; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { st = []; }
        st = (Array.isArray(st) ? st : []).filter(t => Number.isFinite(t) && now - t < 24 * 3600000); st.push(now); while (st.length > 20) st.shift();
        try { const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, f); } catch (e) { /* health only */ }
        const recent = st.filter(t => now - t <= 30 * 60000);
        if (recent.length >= 3) { log(`  [tide] HEALTH: ${recent.length - 1} restarts within 30 min (starts ${recent.map(t => new Date(t).toISOString().slice(11, 16)).join(', ')} UTC) - check memory / the service log.`);
          notifyPhone('TIDE: bot restarting repeatedly', `${recent.length - 1} restarts within 30 min. Check the service log and memory (an OOM loop restarts the bot during the TIDE warm-up).`, { priority: 'high', tags: 'rotating_light' }); } }
      if (tideLiveOn() && !tideLiveReady && !tideHealth.notLiveSent && now - tideHealth.startAt >= 10 * 60000) { tideHealth.notLiveSent = true;
        log(`  [tide] HEALTH: TIDE is still NOT LIVE ${Math.round((now - tideHealth.startAt) / 60000)} min after the start (the warm-up has not finished).`);
        notifyPhone('TIDE not LIVE 10+ min after the start', `TIDE has not gone live ${Math.round((now - tideHealth.startAt) / 60000)} min after the bot started: the warm-up / rebuild has not finished. No TIDE trades until it does.`, { priority: 'high', tags: 'warning' }); }
    } catch (e) { /* health only */ }
  }
  async function tidePollStep(m1) {
    if (tideWire.modeOf(CONFIG) !== 'shadow' && !tideLiveOn()) return;   // Stage 1: shadow; [2a] live runs the same engine step
    try {
      const now = Date.now(), soft = f => { try { return f(); } catch (e) { return null; } };
      tideHealthStep(now);   // [r1.5] the live health alerts (HIGH = the CRITICAL budget, once per event)
      tideOwnReading(now);
      if (!tideShadow) { const ad = tideWire.createAdapter(tideWire.structure(), tideWire.engineCfgOf(CONFIG)); tideShadow = { engine: ad, seen: new Set(), preRestart: new Set() }; log(`  [tide] shadow engine ${ad.version} (one step per closed 1m bar).`); }
      const okBar = b => b && Number.isFinite(b.t) && b.t + 60000 <= now && [b.o, b.h, b.l, b.c].every(Number.isFinite);
      let fresh = (Array.isArray(m1) ? m1 : []).filter(okBar), warm = false;
      if (tideM1Last === null || (fresh.length && fresh[0].t > tideM1Last + 60000)) {   // first poll, or a gap: read the missing closed 1m bars once (backs off on failure)
        if (now < tideFeedNextAt) return;
        // the first read asks for 6000 minutes of clock (about 4 days) so a weekend / holiday restart still gets ~2000 bars (structure r3.2 needs >= ~1500 for the 1H range)
        const lim = tideM1Last === null ? tideWire.WARM_CLOCK_MIN : Math.min(2000, Math.ceil((now - tideM1Last) / 60000) + 5);
        if (tideM1Last === null) {   // [r1.1a] the warm-up: the read ladder 6000 -> 3000 -> 2000 -> 1500 at once; all failed -> retried every 30 s (60 s cap) + ONE phone alert
          if (!tideRingReloaded) { tideRingReloaded = true; lvjDay(now); const rl = tideRingReload();   // [r1.6] the phone ring is not empty after a restart: today's journal rows first (read only), then the startup row
            try { const ln = tideShadow.engine.lane && tideShadow.engine.lane(); if (ln && typeof ln.seed === 'function' && rl.laneTaken.length) { const n = ln.seed(rl.laneTaken), c = ln.counts(Math.floor(now / 1000)); log(`  [tide] trend lane caps seeded from the journal: ${n} taken entr${n === 1 ? 'y' : 'ies'} today (${c.hour} this hour, ${c.day} this TradeDay)`); } } catch (e) { log(`  [tide] trend lane cap seed failed: ${e.message}`); }   // [r1.6.2]
            log(`  [tide] journal reload: ${rl.rows} of ${rl.parsed} rows of ${rl.file || '(no day file yet)'} into the phone ring (${rl.ring} rows, ${rl.bytes} bytes), ${rl.trades} closed TIDE trade(s) of the TradeDay${rl.error ? ` - ${rl.error}` : ''}`);
            lvjWrite(tideWire.tideRow('startup', { shadow: !tideLiveOn(), mode: tideWire.modeOf(CONFIG), node: process.version, reloadedRows: rl.rows, reloadedTrades: rl.trades, ringRows: rl.ring, trendLane: tideWire.trendLaneOn(CONFIG), gradeGate: tideWire.gradeGateOf(CONFIG), sizeCap: tideWire.sizeCapOf(CONFIG), trail: tideWire.trailOf(CONFIG) }, now)); }
          const wr = await tideWire.warmRead(l => fetchBars(token, contractId, UNIT.MINUTE, 1, { limit: l }), log);
          if (!wr.bars) { tideFeedFails++; tideFeedNextAt = now + Math.min(60000, 30000 * tideFeedFails); log(`  [tide] 1m warm-up read failed at every limit (${wr.errors.map(x => x.limit).join(' / ')}) - retried in ${Math.round((tideFeedNextAt - now) / 1000)} s; TIDE is NOT trading yet.`);
            if (!tideWarmAlerted) { tideWarmAlerted = true; notifyPhone("TIDE warm-up can't read 1m history - not trading yet", `Every 1m history read failed (${wr.errors.map(x => x.limit + ': ' + x.error).join('; ')}). Retrying every 30-60 s.`, { priority: 'high', tags: 'warning' }); } return; }
          fresh = wr.bars.filter(okBar); tideFeedFails = 0; if (wr.limit !== tideWire.WARM_CLOCK_MIN) log(`  [tide] 1m warm-up read OK at limit ${wr.limit} (the larger reads failed).`);
          if (tideWarmAlerted) { tideWarmAlerted = false; notifyPhone('TIDE warm-up: 1m history read OK', `The warm-up read worked at limit ${wr.limit}; TIDE goes live after the rebuild.`, { priority: 'default', tags: 'white_check_mark' }); }
        } else {
          try { fresh = (await tideWire.socketRetry(() => fetchBars(token, contractId, UNIT.MINUTE, 1, { limit: lim }), log, `1m gap read (limit ${lim})`)).filter(okBar); tideFeedFails = 0; }
          catch (e) { tideFeedFails++; tideFeedNextAt = now + Math.min(60000, 15000 * 2 ** Math.min(2, tideFeedFails - 1)); log(`  [tide] 1m gap read failed at limit ${lim}: ${tideWire.errText(e)} - retried in ${Math.round((tideFeedNextAt - now) / 1000)} s.`); return; }
        }
        warm = tideM1Last === null;
      }
      const add = fresh.filter(b => tideM1Last === null || b.t > tideM1Last).sort((a, b) => a.t - b.t);
      if (!add.length) return;
      tideM1Last = add[add.length - 1].t;
      const live = warm ? add.slice(-1) : add, hist = warm ? add.slice(0, -1) : [];
      if (hist.length || warm) {   // history builds the engine's state (no bias, no board); nothing journaled. Setups it armed are the restart's: never pushed (4b)
        const h = warm ? hist.slice(-tideWire.WARM_KEEP) : hist, RB = warm ? tideRebuildLib() : null; let rbOut = null;
        // [2a] TIDE_REBUILD_HOOK (MacStructure lib/tideRebuild.js): the causal per-minute bias of the last 6 h (the bot's own levelsPro on the bars as of each close,
        // in a worker thread: the old path is never blocked). TIDE takes nothing live until it resolves. A failure -> the PRE_RESTART fallback + an alert.
        // [r1.5] memory guard (Mac's VPS: 1 core, 961 MB, no swap; 5 OOM kills during the rebuild): below 250 MB available the rebuild is skipped (PRE_RESTART fallback)
        // MemAvailable + SwapFree (Mac's VPS now has 2 GB of swap): the rebuild is skipped only below 400 MB of the two together
        const memAvailMb = (() => { try { const t = fs.readFileSync('/proc/meminfo', 'utf8'), g = k => { const m = new RegExp(k + ':\\s+(\\d+)').exec(t); return m ? +m[1] / 1024 : null; }, a = g('MemAvailable'); if (a != null) return Math.round(a + (g('SwapFree') || 0)); } catch (e) { /* not Linux */ } return Math.round(require('os').freemem() / 1048576); })();
        const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
        if (RB && typeof RB.rebuildBias === 'function' && memAvailMb < 400) { log(`  [tide] bias rebuild SKIPPED: only ${memAvailMb} MB available incl. swap (< 400 MB; RSS ${rssMb()} MB) - the PRE_RESTART fallback applies.`);
          notifyPhone('TIDE warm-up rebuild skipped - low memory', `Only ${memAvailMb} MB of memory (incl. swap) is available, so the bias rebuild was skipped to avoid an out-of-memory kill. TIDE goes live on the PRE_RESTART fallback (setups armed before this start are not taken).`, { priority: 'high', tags: 'warning' }); }
        else if (RB && typeof RB.rebuildBias === 'function') { const t0 = Date.now(), rssLimitMb = rssMb() + Math.min(300, Math.max(100, memAvailMb - 150)); log(`  [tide] bias rebuild starting (available ${memAvailMb} MB incl. swap, RSS ${rssMb()} MB; worker heap capped at 64 MB; stopped above RSS ${rssLimitMb} MB).`);
          Object.assign(tideWarm, { rebuilding: true, doneMin: 0, totalMin: 6 * 60, startedAt: t0, finishedAt: null, result: null });   // [r1.6] snapshot.tide.warm
          try { const H = tideHtf || {}; rbOut = await RB.rebuildBias({ m1: h, htf: { M5: H.M5 || [], M15: H.M15 || [], M30: H.M30 || tideWire.agg30(H.M15 || []), H1: H.H1 || [], H4: H.H4 || [], W: H.W || [] }, now, hours: 6,
              levelsPro: require('./lib/levelsPro'), worker: true, levelsProPath: require.resolve('./lib/levelsPro'),
              resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 2 }, maxRssMb: rssLimitMb, rssCheckMs: 250,   // [r1.5] RELATIVE: the start RSS + min(300, max(100, available incl. swap - 150)) MB, checked every 250 ms (the heap cap is not enforced on every Node)   // [r1.5] measured: peak +126 MB instead of +250 MB; over the cap the WORKER ends (ERR_WORKER_OUT_OF_MEMORY) -> the fallback
              timeoutMs: 15 * 60000, progressMs: 60000, onProgress: x => { if (Number.isFinite(x.done)) tideWarm.doneMin = x.done; if (Number.isFinite(x.of)) tideWarm.totalMin = x.of; log(`  [tide] rebuild progress: ${x.done} of ${x.of} minutes (${Math.round((Date.now() - t0) / 1000)} s, RSS ${rssMb()} MB)`); } });   // [r1.2] WATCHDOG: 10 min, then the worker is terminated   // [r1.6] + snapshot.tide.warm counter
            RB.fillBook(tideBook, rbOut, tideWire.noteBias); tideBook.rows.sort((a, b) => a.t - b.t); tideCatchup = true;
            Object.assign(tideWarm, { rebuilding: false, doneMin: tideWarm.totalMin, finishedAt: Date.now(), result: 'rebuilt' });   // [r1.6]
            log(`  [tide] rebuilt from ${h.length} bars in ${((Date.now() - t0) / 1000).toFixed(1)} s (${rbOut.n} bias minutes, RSS ${rssMb()} MB${rbOut.missing && rbOut.missing.length ? `, ${rbOut.missing.length} without a bar` : ''}${tideHtf ? '' : '; NO higher-timeframe bars yet'}).`); }
          catch (e) { rbOut = null; log(`  [tide] bias rebuild FAILED (${e && e.message}) - the PRE_RESTART fallback applies (setups armed before this start are not taken).`);
            Object.assign(tideWarm, { rebuilding: false, finishedAt: Date.now(), result: e && e.timedOut ? 'timed-out' : e && e.rssLimit ? 'stopped-memory' : 'failed' });   // [r1.6]
            if (e && e.rssLimit) notifyPhone('TIDE warm-up rebuild stopped - memory', `The bias rebuild was stopped at ${e.message}. TIDE goes live on the PRE_RESTART fallback (setups armed before this start are not taken).`, { priority: 'high', tags: 'warning' });
            else if (e && e.timedOut) notifyPhone('TIDE warm-up rebuild timed out - using the PRE_RESTART fallback', `The bias rebuild did not finish in 15 min (worker terminated). TIDE goes live now; setups armed before this start are not taken.`, { priority: 'high', tags: 'warning' });
            else notifyPhone('TIDE: warm-up rebuild failed', `The bias rebuild failed (${e && e.message}); setups armed before this start will not be taken.`, { priority: 'high', tags: 'warning' }); } }
        if (rbOut && rbOut.from) {   // older bars warm the engine; the rebuilt window is replayed minute by minute WITH its bias + board (signals there are late: journal only)
          const fromMs = (rbOut.from - 60) * 1000, old = h.filter(b => b.t < fromMs), win = h.filter(b => b.t >= fromMs);
          if (old.length) tideShadow.engine.step({ nowMs: now, m1New: old, warm: true });
          for (const b of win) { const rd = rbOut.readings.get(Math.round((b.t + 60000) / 1000));
            const o = tideWire.shadowStep(tideShadow, { nowMs: now, m1New: [b], warm: false, rebuild: true, board: (rd && rd.board && rd.board.length ? rd.board : tideBoard), biasAt: t => tideWire.biasAt(tideBook, t), floorDistanceUsd: null, sessionAt: t => sessionCloseState(t, CONFIG) }, CONFIG, { flat: false }, pointValue, tickSize);
            if (o.rows.length) { lvjDay(now); for (const r of o.rows) lvjWrite({ ...r, rebuilt: true, barT: b.t + 60000 }); }   // [r1.5] barT = the replayed bar's close (ms); t stays the write time
            for (const tk of o.takes || []) tideWire.liveFeedback(tideShadow, tk.id, { closed: true, tp1Done: false, why: 'rebuild-window' }); }
          lvjDay(now); lvjWrite(tideWire.tideRow('rebuild', { shadow: tideWire.modeOf(CONFIG) !== 'live', bars: h.length, window: win.length, from: rbOut.from, to: rbOut.to, ms: rbOut.ms }, now));
        } else tideShadow.engine.step({ nowMs: now, m1New: h, warm: true, onWarmSetup: id => tideShadow.preRestart.add(id) });
        if (warm) { const inf = tideShadow.engine.info(); log(`  [tide] warm-up bars=${h.length} 1H-range=${inf.range1hKnown ? 'known' : 'unknown'}`); log(rbOut && rbOut.from ? '  [tide] restart: memory rebuilt from the warm-up WITH the rebuilt bias (setups in progress stay live)' : '  [tide] restart: memory rebuilt from warm-up (setups armed before this start are journaled, never pushed or taken)');
          lvjDay(now); lvjWrite(tideWire.tideRow('restart', { shadow: true, warmBars: h.length, range1hKnown: !!inf.range1hKnown, preRestartSetups: tideShadow.preRestart.size, memory: rbOut && rbOut.from ? 'rebuilt from warm-up + causal bias (tideRebuild)' : 'rebuilt from warm-up (PRE_RESTART fallback)' }, now)); }
      }
      if (now - tideHourAt >= 3600000) { if (tideHourAt) { const r = tideWire.readStats; log(`  [tide] hourly: 1m reads - stale-socket retries ${r.socketRetries} (${r.socketRetryOk} ok on the retry), failed reads ${r.readFailures} (since start)`); } tideHourAt = now; }   // [r1.2]
      if (!tideLiveReady) { tideLiveReady = true; if (tideLiveOn()) log('  [tide] LIVE: the warm-up is done - TIDE signals now place real orders.'); }
      const gate = { flat: soft(() => isFlat()) === true && !tideOwned(), desynced: !!soft(() => LIVE && stateMachine && stateMachine.desynced), sessionNoEntry: !!soft(() => sessionCloseState(now, CONFIG).noEntry),
        timeBlock: soft(() => tideWire.blockAt(CONFIG, now)),   // [2a r1.1] TIDE's OWN windows (tide.blocks), never the old path's block keys
        useTimeBlocks: CONFIG.tide.useTimeBlocks, newsWait: soft(() => { const n = newsWaitBlock(now); return n ? String(n.title).split(' / ')[0] : null; }), paused: !!soft(() => pausedUntil && now < pausedUntil) };
      const floorDistanceUsd = soft(() => { const f = computeDrawdownFloor(); return Number.isFinite(lastAccountBalance) && Number.isFinite(f) ? lastAccountBalance - f : null; });   // money-r4.1 near-floor guard input (the bot's own floor)
      // [r1.1] after a slow warm-up rebuild, the bars that closed DURING it are stepped one by one at their own close (+5 s), so a signal that fired meanwhile
      // is judged as live (not a late catch-up); the driver still refuses one older than 10 min (stale) and every gate is checked NOW
      const catchup = tideCatchup && !warm && live.length > 1; if (!warm) tideCatchup = false;
      const steps = catchup ? live.map(b => [[b], Math.min(now, b.t + 65000)]) : [[live, now]];
      if (catchup) log(`  [tide] catch-up after the rebuild: ${live.length} bars stepped at their own close.`);
      for (const [stepBars, stepNow] of steps) {
        const out = tideWire.shadowStep(tideShadow, { nowMs: stepNow, m1New: stepBars, warm: false, board: tideBoard, biasAt: t => tideWire.biasAt(tideBook, t), floorDistanceUsd, sessionAt: t => sessionCloseState(t, CONFIG) }, CONFIG, gate, pointValue, tickSize);   // the bot's own session clock (the engine has none)
        if (out.rows.length) { lvjDay(stepNow); for (const r of out.rows) lvjWrite(r); }
        const lv = tideLiveOn();
        for (const line of out.pushes) { log(`  [tide] ${line} (${lv ? 'live: journal only, the ENTRY push follows a fill' : 'shadow: no order'})`); if (CONFIG.tide.push && !lv) notifyPhone('TIDE shadow', line, { priority: 'default', tags: 'eyes' }); }   // [r1.1] live: no signal push (blocked / skipped = journal only)
        for (const tk of (lv && out.takes) || []) {   // [2a] a live take: the driver re-checks (flat FSM, session, broker: no position, no working order) and places it; not placed = the engine is told at once
          let r = { ok: false, why: 'no live driver (not --live)' };
          if (tideDrv) { try { r = await tideDrv.signal(tk.sig, tk.plan, tk.id); } catch (e) { r = { ok: false, why: 'driver error: ' + e.message }; } }
          log(`  [tide-live] signal ${tk.id}: ${r.ok ? 'entry sent (' + r.phase + ')' : 'NOT taken (' + r.why + ')'}`);
          if (r.ok && CONFIG.tide.push) { const line = (out.pushes || []).find(x => x.includes(`@${Math.round(tk.sig.entry * 100) / 100} `)) || `TIDE LIVE ${tk.sig.dir === 1 ? 'LONG' : 'SHORT'} ${tk.plan.grade}`; notifyPhone('TIDE live signal', line, { priority: 'default', tags: 'rotating_light' }); }   // [r1.1] the taken signal (INFO); blocked / skipped = journal only
          if (!r.ok) { tideWire.liveFeedback(tideShadow, tk.id, { closed: true, tp1Done: false, why: 'not-placed' }); lvjDay(now); lvjWrite(tideWire.tideRow('live_not_taken', { id: tk.id, why: r.why }, now)); }
        }
      }
    } catch (e) { log(`  [tide] shadow step failed (${e && e.message}) - journal only, nothing else is affected.`); }
  }
  async function refreshAndEvaluate({ fast = false } = {}) {
    entryControlBoard = null; // Fail closed throughout refresh, including failed fetch/evaluation.
    const displayRequestedAt = Date.now(), displayStarted = displayPerformance.now();
    let htf, alignPoll = null;
    if (fast && cachedSlowHtf) {
      const ex18 = [...EXTRA_LEVELS_TFS]; if (REMOVED_FILTER_CONTEXT.controlFilter || REMOVED_FILTER_CONTEXT.trendFilter || CONFIG.reclaimReentry) { if (!ex18.includes('M5')) ex18.push('M5'); if ((CONFIG.controlAcceptTf === '3m' || CONFIG.pullbackRule) && !ex18.includes('M3')) ex18.push('M3'); } if (CONFIG.vwapBuildTf === '5m' && !ex18.includes('M5')) ex18.push('M5');   // 10/18: the 5m candles must be fresh. r9.16.1: the 5m VWAP needs fresh 5m bars every fast poll (executable, before this comment)
      lvReqStart = Date.now();   // lv1 r3: level-event request start (its own stamp; before the fetch)
      alignPoll = alignPollStart(); po3ReqStart = Date.now();   // po3 r1.3: request start (PO3 provenance only)
      const fastTf = await fetchFastTimeframes(token, contractId, { limit: CONFIG.historyRefreshLimit, extra: CONFIG.align30 === true ? [...ex18, 'M30'] : ex18, onRead: alignPoll.onRead });   // align30: the 30m alignment slot reads the forming 30m bar, so refresh it on every intrabar poll
      alignPollDone(alignPoll);   // throws if superseded, BEFORE any cache / control state is touched
      htf = { ...cachedSlowHtf, ...fastTf };
      try { noteCandleRead(Object.keys(fastTf), fastTf); if (CONFIG.align30 !== true) refreshCandleM30(token, contractId); } catch (e) { /* display only */ }
    } else {
      lvReqStart = Date.now();   // lv1 r3: level-event request start (its own stamp; before the fetch)
      alignPoll = alignPollStart(); po3ReqStart = Date.now();   // po3 r1.3: request start (PO3 provenance only)
      htf = await fetchAllTimeframes(token, contractId, { limit: CONFIG.historyRefreshLimit, onRead: alignPoll.onRead });
      alignPollDone(alignPoll);
      cachedSlowHtf = { M: htf.M, W: htf.W, D: htf.D, M30: htf.M30, M10: htf.M10, M5: htf.M5, M3: htf.M3 };
      try { noteCandleRead(['M15', 'M30', 'H1'], htf); } catch (e) { /* display only */ }
    }
    // r9.10 (Mac 10/20 "None of our data should be coming back as stale or unknown"): a higher-TF series still missing its CURRENT-period bar at a
    // boundary gets that bar rebuilt from this poll's finer bars (first trade of the period = its open) BEFORE anything reads it. Copies only;
    // the slow-TF cache keeps the provider's own bars. A failure leaves the provider bars unchanged.
    try { const cp = completeCurrentPeriods(htf, Date.now()); htf = cp.htf; lastDerivedPeriods = cp.derived; } catch (e) { lastDerivedPeriods = [{ error: String(e && e.message) }]; }
    try { journalBars = htf; for (const [k, r] of Object.entries(alignPoll.reads)) journalReadAt[k] = r.doneAt; } catch (e) { /* journal only */ }
    try { for (const [k, r] of Object.entries(alignPoll.reads)) { po3Req[k] = po3ReqStart; po3Obs[k] = r.doneAt; } } catch (e) { /* po3 r1.3: observer provenance only */ }
    const closedChartBars = htf.M15.slice(0, -1);
    petBarsReqAt = lvReqStart;   // lv1 r13.3.7d: when the bars the plan-end trend check reads were requested (a candle counts as completed only if it had ended by then)
    try { noteControlBars(htf); dcBarsReqAt = lvReqStart; } catch (e) { /* 10/18: display / filters only */ }   // lv1 r13.3.7: + when these bars were requested (the context log's closed-bar cut; log only)
    noChaseBars = htf.M15;   // 10/16 no-chase: the 15m bars of this evaluation (last one = forming)
    noChase5Bars = Array.isArray(htf.M5) ? htf.M5 : null;   // round 4: 5m bars (the forming one is dropped by time in noChaseBlock)
    try { po3Observe(htf, po3Req, po3Obs); } catch (e) { /* po3 r1.3: observe-only, never affects this evaluation */ }
    try { srAreasTick(htf); } catch (e) { try { sraLog(`tick failed (${e && e.message})`); } catch (_) { /* log only */ } }   // sr-areas r1 (lv1 r13.6.3; r13.6.3b: logged, never silent): display only, never affects this evaluation
    const intrabar = CONFIG.evaluationMode === 'intrabar-1m';
    const chartBars = intrabar ? htf.M15 : closedChartBars;
    const macOut = evaluateMacTrap(chartBars, htf, vixBars, { ...macSessionOpts(), exhaustionGate: CONFIG.exhaustionGate, chopSkipEnabled: CONFIG.chopSkipEnabled, chopSkipExemptLowVolume: CONFIG.chopSkipExemptLowVolume, require4h: CONFIG.macRequire4hAnchor !== false, ...macDotOpts(), ...rsiVetoOpts() });
    // 10/17 SESSION FLAG COUNT (display/logging only; the bot has no 5m MAC). Round 2 (QA F-FLAG): counted with the Pine v4.2 default "Require 4H Anchor" ON
    // (CONFIG.flagsRequire4hAnchor) so the phone matches Mac's chart; the bot's TRADING MAC keeps macRequire4hAnchor. When the two differ, a second display-only
    // MAC evaluation is run (at every 15m close, and at most once a minute mid-bar). Round 3 (QA R2-3): that extra run is DEFERRED (flagJob) and executed by
    // runFlagJob() at the end of the main-loop pass, AFTER the entry decision, so it never delays an entry or the fast poll.
    try {
      const flagAnchor = CONFIG.flagsRequire4hAnchor !== false, tradeAnchor = CONFIG.macRequire4hAnchor !== false;
      if (flagAnchor === tradeAnchor) { sessionFlags = { m15: sessionFlagCount(macOut), m5: null, require4h: flagAnchor }; lastFlagEvalAt = Date.now(); flagJob = null; }
      else if (!fast || !sessionFlags || Date.now() - lastFlagEvalAt >= 60000) {
        lastFlagEvalAt = Date.now();
        const optsF = { ...macSessionOpts(), exhaustionGate: CONFIG.exhaustionGate, chopSkipEnabled: CONFIG.chopSkipEnabled, chopSkipExemptLowVolume: CONFIG.chopSkipExemptLowVolume, require4h: flagAnchor, ...macDotOpts() };
        flagJob = () => { const flagOut = evaluateMacTrap(chartBars, htf, vixBars, optsF); sessionFlags = { m15: sessionFlagCount(flagOut), m5: null, require4h: flagAnchor }; };
      }
    } catch (e) { sessionFlags = null; }
    const levelsOut = evaluateLevelsPro(chartBars, htf, { ...levelsAlignOpts(), ...levelsSessionOpts(), ...levelsVwapOpts(htf), ...levelsParityOpts(), ...alignFreshnessOpts('M15', alignPoll) });
    // Levels PRO on the 5m / 3m charts (owner forward-test 2026-10-11): same treatment as the 15m path - forming bar included in
    // intrabar mode, dropped in bar-close mode; htf passed unchanged. A timeframe that is short of bars or throws is skipped
    // (logged once), never fatal.
    const lvByTf = { M15: levelsOut[levelsOut.length - 1] };
    try { latestLevelBoard = levelBoardFrom(lvByTf.M15, Date.now()); } catch (e) { latestLevelBoard = null; }   // r9.14 entry-level journal only
    try {   // journal metadata r1.2: 15m board, persisted BEFORE it can be referenced (commit only after a successful write)
      if (!boardTracker) boardTracker = journalMeta.createBoardTracker({ tick: tickSize, runId: journalRunId });
      const lastBar = chartBars && chartBars.length ? chartBars[chartBars.length - 1] : null;
      const cand = boardTracker.observe(lvByTf.M15, { t: Date.now(), chartTf: '15m', barTime: lastBar ? lastBar.t : null, anchor: CONFIG.sessionAnchor, vwapAnchor: 'calendar-0630' });
      const persisted = cand ? persistJournalMeta(cand.row) : false;
      if (cand && !persisted) { const r = journalMetaErrors.row('level_board', 'board write failed'); if (r) persistJournalMeta(r); }
      latestEvalBoard = boardTracker.bind(cand, persisted);   // r1.3: commit-after-persist, and THIS evaluation's own result (write-failed = not its board)
      if (lvByTf.M15) evalBoards.set(lvByTf.M15, latestEvalBoard);
    } catch (e) { latestEvalBoard = { boardSeq: null, status: 'unknown' }; try { const r = journalMetaErrors.row('level_board', e); if (r) persistJournalMeta(r); } catch (_) { /* journal only */ } }
    for (const k of EXTRA_LEVELS_TFS) {
      try {
        const tfBars = htf[k] || [];
        let bars = intrabar ? tfBars : tfBars.slice(0, -1);
        const wantMs = EXTRA_FAST_TF[k][1] * 60000;
        // evaluateLevelsPro infers the chart timeframe from its first two bars; drop a leading bar if it sits across a session gap
        while (bars.length > 2 && bars[1].t - bars[0].t !== wantMs) bars = bars.slice(1);
        if (bars.length < 100) { levelsTfWarnOnce(k + ':short', `${k} chart has only ${bars.length} usable bars (<100) - skipped for the trigger.`); continue; }
        const out = evaluateLevelsPro(bars, htf, { ...levelsAlignOpts(), ...levelsSessionOpts(), ...levelsVwapOpts(htf), ...levelsParityOpts(), ...alignFreshnessOpts(k, alignPoll) });
        lvByTf[k] = out[out.length - 1];
      } catch (e) { levelsTfWarnOnce(k + ':err', `${k} Levels PRO evaluation failed (${e.message}) - skipped for the trigger.`); }
    }
    let tideLv30 = null;   // TIDE r2: the forming 30m bias for the new model only (not a trigger timeframe: lvByTf is untouched)
    if (tideOn()) { try { const b30 = tideWire.agg30(intrabar ? htf.M15 : (htf.M15 || []).slice(0, -1));   // built from the 15m bars this refresh already read: no extra request
      if (b30.length >= 100) { const o30 = evaluateLevelsPro(b30, { ...htf, M30: b30 }, { ...levelsAlignOpts(), ...levelsSessionOpts(), ...levelsVwapOpts(htf), ...levelsParityOpts(), ...alignFreshnessOpts('M30', alignPoll) }); tideLv30 = o30[o30.length - 1] || null; } } catch (e) { tideLv30 = null; levelsTfWarnOnce('tide:m30', `TIDE 30m bias read failed (${e.message}) - the 15m reading is used alone.`); } }
    // lv1 LEVEL EVENTS (r3, causal): each 5m / 3m tracker sees only bars that had ENDED when this poll REQUESTED them (lvReqStart, stamped before the fetch;
    // a timeframe not read in this poll observes nothing). An event is born only on a newly completed bar, from the boards observed now (the TF's board +
    // the 15m board, exact name + price, + the weekly set), and is then frozen; while live it becomes that TF's Levels plan when Levels PRO has none (a
    // shallow copy - the evaluator rows are never mutated). A failure leaves the boards exactly as Levels PRO produced them.
    if (CONFIG.levelEvents) {
      for (const [k, ms] of [['M5', 300000], ['M3', 180000]]) {
        try {
          const lv0 = lvByTf[k]; if (!lv0) continue;
          const tr = levelEventTrackers[k] || (levelEventTrackers[k] = levelEvent.createTracker(ms, { intrabar: CONFIG.levelEventIntrabar === true && CONFIG.evaluationMode === 'intrabar-1m', intrabarBufPts: Number.isFinite(CONFIG.levelEventIntrabarBufPts) ? CONFIG.levelEventIntrabarBufPts : 1, planEndTrend: CONFIG.planEndsAtTargetTrend !== null && CONFIG.planEndsAtTargetTrend !== undefined, vwapResetsPt: CONFIG.sessionAnchor === 'cme' ? [390, 900] : [0, 390], retest: CONFIG.levelRetest === true, planEndsAtTarget: CONFIG.planEndsAtTarget === true }));   // lv1 r12: intrabar births; r12.2: the VWAP epochs of this anchor (Levels PRO calendar-0630: 06:30 PT + the new day); r13: break-retest births
          const reqAt = alignPoll && alignPoll.reads && alignPoll.reads[k] ? lvReqStart : NaN, tfBars = (htf[k] || []).slice(-200);
          const obsAt = alignPoll && alignPoll.reads && alignPoll.reads[k] ? alignPoll.reads[k].doneAt : null, lvRow = (intrabar ? tfBars : tfBars.slice(0, -1)).at(-1);   // lv1 r12.2: when this TF's bars were in hand; the board's newest row (its VWAP value's bar)
          const lastDone = tfBars.filter(b => b && Number.isFinite(b.t) && b.t + ms <= reqAt).at(-1);
          const board = [...(Array.isArray(lv0.levels) ? lv0.levels : []), ...(lvByTf.M15 && Array.isArray(lvByTf.M15.levels) ? lvByTf.M15.levels : [])];
          const out = tr.step({ bars: tfBars, reqAt, obsAt, levelsBarT: lvRow ? lvRow.t : null, boardLevels: board, extraLevels: lastDone ? levelEvent.weeklyLevels({ weekly: htf.W, daily: htf.D, at: lastDone.t }).concat(CONFIG.htfLevels ? levelEvent.htfLevels({ monthly: htf.M, daily: htf.D, at: lastDone.t }) : []) : [], atr: lv0.atrRef }), live = out.live;   // r13.3.4: + the monthly / quarterly levels
          lvjTracker(k, out, tr);   // lv1 r5: levels journal (scan + event lifecycle); journal only
          if (k === 'M5') { try { levelPanel.seedBars(tfBars.filter(b => b && Number.isFinite(b.t) && b.t + ms <= reqAt)); levelPanel.seedForming(tfBars.find(b => b && Number.isFinite(b.t) && b.t <= reqAt && b.t + ms > reqAt) || null); } catch (e) { lvjErr(e); } }   // lv1 r10.1: the ladder's candles = the bot's own completed 5m bars; r12.5: + the forming one (display only)
          if (live) lvByTf[k] = levelEvent.withLevelEvent(lv0, live);
        } catch (e) { levelsTfWarnOnce(k + ':levelEvent', `${k} level-event check failed (${e.message}) - Levels PRO board used unchanged.`); }
      }
    }
    // r8: publish this poll's alignment board (the slots each chart's evaluation produced); entry rechecks must match it exactly.
    if ((alignFreshnessOn() || CONFIG.alignmentFreshnessPolicy === 'measured') && alignPollCurrent(alignPoll)) alignBoard = Object.freeze({ gen: alignPoll.gen,   // r9.10: the measured policy binds entries to the current poll's board too
      // r9.10 (MacDot 6297111941): when this poll's OLDEST bar read completed (wall + monotonic), so the submission seam can refuse an old board
      readAt: (() => { const v = Object.values(alignPoll.reads || {}).map(r => r.doneAt).filter(Number.isFinite); return v.length ? Math.min(...v) : null; })(),
      readMono: (() => { const v = Object.values(alignPoll.reads || {}).map(r => r.mono).filter(Number.isFinite); return v.length ? Math.min(...v) : null; })(),
      byChart: Object.fromEntries(Object.entries(lvByTf).filter(([, v]) => v && Array.isArray(v.alignSlots)).map(([k, v]) => [k, JSON.parse(JSON.stringify(v.alignSlots))])) });
    // lv1 r3: levels-only = the trigger timeframe whose named-event proof ranks highest in Mac's level hierarchy wins (ties keep the configured order)
    const lvPicked = pickLevelsTrigger(lvByTf, CONFIG.levelsOnlyEntries ? { ...CONFIG, levelsTriggerTimeframes: levelEvent.rankTimeframes(lvByTf, LEVELS_TRIGGER_TFS, lvTradeDir) } : CONFIG);   // r12.6: a trigger against the HTF alignment ranks last
    if (CONFIG.controlDirectionGate && lvByTf.M15 && Number.isFinite(lvByTf.M15.biasScore)) { lvPicked.controlBiasScore = lvByTf.M15.biasScore; }   // 10-18b1 (flip journal now runs after controlValid is set, below)
    if (CONFIG.controlDirectionGate) { try { lvPicked.controlValid = controlEvalValid(lvByTf.M15, chartBars.length); } catch (e) { lvPicked.controlValid = false; } }   // 10-18b2c r2 (B4): only a VALID 15m evaluation (>= 100 bars, levels priced, finite close / ATR) can read as contested; an error = not valid
    lvPicked.controlObservedAt = chartBars.at(-1)?.t ?? null;
    lvPicked.controlEvaluatedAt = Date.now();
    try {   // journal metadata r1.2: the snapshot of THIS consumed evaluation (its own timeframe and bars), keyed by the object signal_check rows are written from
      const k = { '15m': 'M15', '10m': 'M10', '5m': 'M5', '3m': 'M3', '30m': 'M30' }[lvPicked.triggerTf] || 'M15', tfMs = { M15: 900000, M10: 600000, M5: 300000, M3: 180000, M30: 1800000 }[k];
      evalSnapshots.set(lvPicked, journalMeta.evaluationSnapshot(lvPicked, { tfKey: k, bars: k === 'M15' ? chartBars : (htf[k] || []), tfMs, instrument: contractId, feed: 'ProjectX', evaluatedAt: lvPicked.controlEvaluatedAt }));
    } catch (e) { /* journal only: the row then says identity unknown */ }
    try { if (latestEvalBoard) evalBoards.set(lvPicked, latestEvalBoard); } catch (e) { /* journal only: the row then says board unknown */ }   // r1.3: the decision object carries its own evaluation's board result
    if (CONFIG.controlDirectionGate) { try { noteControlSide(lvPicked); } catch (e) { /* journal / push only */ } }   // same strict M15 read as the gate
    entryControlBoard = { ...lvPicked }; // Latest evaluation, including intrabar; never the prior closed-board cache.
    try { journalLevelsMinute(lvByTf, lvPicked, chartBars); } catch (e) { /* journal only */ }   // r9.10
    if (lvPicked.triggerTf !== lastLoggedTriggerTf) {
      lastLoggedTriggerTf = lvPicked.triggerTf;
      log(`  [levels-trigger] trigger timeframe now: ${lvPicked.triggerTf || 'none'} (${Object.entries(lvPicked.tfTriggers).map(([k, v]) => `${k}:${v.skipped ? 'skipped' : v.dir === 0 ? '-' : (v.dir === 1 ? 'LONG' : 'SHORT') + '/' + v.via}`).join(' ')})`);
    }
    try { alignmentDisplays.set(lvPicked, buildAlignmentDisplay(htf, levelsAlignOpts().alignTfs, displayRequestedAt, Date.now(), displayPerformance.now()-displayStarted)); }
    catch (_) { alignmentDisplays.delete(lvPicked); } // Display failure must not interrupt strategy/protection evaluation.
    if (tideOn()) tideNoteEval(lvByTf.M15, tideLv30, htf);   // TIDE r2 stage 1: the board + the forming 15m / 30m bias for the shadow (no order path)
    const evalBar = chartBars[chartBars.length - 1];
    return {
      // ALWAYS the real last CLOSED bar's time, regardless of mode — every
      // existing bar-close-bookkeeping consumer (the "has a new 15m bar
      // closed?" probe, tickTrendTimeoutBarClose,
      // bar-close notifications/journaling) keys off this and must keep
      // meaning exactly what it always has, in both modes.
      lastClosedBarTime: closedChartBars[closedChartBars.length - 1].t,
      mac: macOut[macOut.length - 1],
      lv: lvPicked,
      // The bar mac/lv actually reflect — the still-forming bar's live time/
      // price in intrabar mode, otherwise identical to lastClosedBarTime/
      // the closed bar's own close. This is what checkForNewEntry()'s
      // refTime/refPrice should use, NOT lastClosedBarTime, so an intrabar
      // entry prices off the CURRENT live print, not a stale closed level.
      evalBarTime: evalBar.t,
      evalBarClose: evalBar.c,
      barIsPartial: intrabar,
    };
  }

  // 10/17 round 3 (QA R2-3): the deferred display-only flag MAC run (set by refreshAndEvaluate); never throws, never trades.
  let flagJob = null;
  function runFlagJob() { const j = flagJob; flagJob = null; if (!j) return; try { j(); } catch (e) { sessionFlags = null; } }

  // LIVE mode uses REAL realized P&L from the broker (matching terminal.html's
  // own refreshRealizedPnl) for the daily-stop circuit breaker, instead of a
  // self-tracked estimate — the broker's own fill data is the one source of
  // truth for money.
  async function refreshRealDayPnl(dayStartMs, { accountWide = false } = {}) {
    const d = await ptxFetch('/api/Trade/search', { accountId: account.id, startTimestamp: new Date(dayStartMs).toISOString() }, token);
    const trades = d?.trades || [];
    let realized = 0;
    for (const t of trades) {
      // Filtered to THIS instance's own contract by default (2026-09-22) —
      // /api/Trade/search returns every fill on the whole ACCOUNT, not just
      // this symbol's. Per-symbol dayRealizedPnl (this default) stays
      // filtered — it's what mobile.html shows per instrument, and that
      // split is intentional (see the mobile-dashboard P&L discussion).
      // accountWide=true skips the filter instead, for the account-wide
      // dailyStopLoss circuit breaker (2026-09-22 spec) — both symbols'
      // processes independently compute the same real total this way, no
      // cross-process coordination needed.
      if (!accountWide && t.contractId !== contractId) continue;
      if (t.voided || t.profitAndLoss == null) continue;
      realized += t.profitAndLoss - (t.fees || 0);
    }
    return realized;
  }

  // Ported EXACTLY from terminal.html's own computeRecentTrades() (2026-09-21)
  // — same round-trip grouping off the broker's real fills — so the mobile
  // status page can show the identical Recent Trades list without needing
  // its own login/token. Keeping this server-side and folding it into the
  // snapshot file means the phone page stays pure read-only: no credential
  // ever touches it, same safety property the ntfy.sh push already has.
  function computeRecentTrades(fills) {
    const sorted = [...fills].filter(f => f.price != null).sort((a, b) => new Date(a.creationTimestamp) - new Date(b.creationTimestamp));
    const trades = [];
    let current = null, pos = 0;
    for (const f of sorted) {
      const delta = f.side === 1 ? -f.size : f.size; // side 0 = Buy, 1 = Sell
      if (pos === 0) {
        current = { contractId: f.contractId, dir: delta > 0 ? 1 : -1, entryTime: f.creationTimestamp, entryPrice: f.price, maxSize: 0, pnl: 0, closed: false, exitTime: null,
          // added 2026-10-12 (journal reconcile; existing fields above unchanged): entry/exit VWAPs, broker fees and gross P&L.
          // fees = every fill of the round trip (fix 5), grossPnl = the fills that carry a profitAndLoss, so pnl === grossPnl - fees.
          entryAvgPrice: null, exitPrice: null, exitSize: 0, fees: 0, grossPnl: 0, _inQty: 0, _inNotional: 0, _outNotional: 0 };
        trades.push(current);
      }
      const prevAbs = Math.abs(pos);
      pos += delta;
      current.maxSize = Math.max(current.maxSize, Math.abs(pos));
      if (Math.abs(pos) > prevAbs) { current._inQty += f.size; current._inNotional += f.price * f.size; current.entryAvgPrice = current._inNotional / current._inQty; }
      else { current.exitSize += f.size; current._outNotional += f.price * f.size; current.exitPrice = current._outNotional / current.exitSize; }
      // fix 5 (2026-10-12): fees are summed over EVERY fill of the round trip, entry side included. Before, only fills that carried a
      // profitAndLoss (the exits) were charged, which left the journal and Recent Trades $1.80 per 5-lot better than the account
      // (the account charges $0.36 per contract per side). If the broker's entry fills carry no fee field this adds 0 - same as before.
      current.fees += (f.fees || 0);
      // dashfix (2026-10-13), DISPLAY ONLY: TopstepX charges per contract per side a $0.36 FEE plus a $0.25 COMMISSION ($6.10 per 5-lot round trip). The
      // broker's fills carry at most the exit-side fee (no entry fee, no commission), so the fill-sum showed $1,867.00 on 10/13 where TopstepX showed
      // $1,759.50. current.extraCost = the costs NOT already in t.fees (entry/exit fee when absent, commission always); t.fees / t.pnl (used by the journal) are deliberately left as they were.
      // 10-18u2: the per-side costs come from CONFIG.brokerCosts (one place); the commission part is kept separately so each round trip carries netPnl + commissions.
      const bcF = CONFIG.brokerCosts.feePerContractSide, bcC = CONFIG.brokerCosts.commissionPerContractSide, comm = f.commissions > 0 ? f.commissions : bcC * f.size;
      current.extraCost = (current.extraCost || 0) + (f.fees > 0 ? 0 : bcF * f.size) + comm;
      current.commissions = (current.commissions || 0) + comm;
      if (f.profitAndLoss != null) current.grossPnl += f.profitAndLoss;
      current.exitTime = f.creationTimestamp;
      if (pos === 0) current.closed = true;
    }
    for (const t of trades) { delete t._inQty; delete t._inNotional; delete t._outNotional; t.pnl = t.grossPnl - t.fees;
      t.netPnl = Math.round((t.pnl - (t.extraCost || 0)) * 100) / 100; t.commissions = Math.round((t.commissions || 0) * 100) / 100; }   // 10-18u2: broker NET per round trip (gross - fees - commissions)
    return trades.reverse(); // most recent first
  }

  let lastBrokerRoundTrips = []; // full (un-sliced) list from the latest refreshRecentTrades(), for reconcileJournalWithBroker()
  async function refreshRecentTrades(dayStartMs) {
    const d = await ptxFetch('/api/Trade/search', { accountId: account.id, startTimestamp: new Date(dayStartMs).toISOString() }, token);
    const fills = (d?.trades || []).filter(t => t.contractId === contractId && t.price != null);
    lastBrokerRoundTrips = computeRecentTrades(fills);
    if (tideLiveOn() && tideDrv) tideTagFills(lastBrokerRoundTrips, fills);   // [r1.2] live only: a trip holding a TIDE order's fill gets model 'tide' (off / shadow: untouched)
    return lastBrokerRoundTrips.slice(0, 10);
  }

  // Broker fills (what computeRecentTrades derives from) only ever show
  // WHAT happened financially, never WHY — this attaches the matching
  // journal entry's bias/source/grade context (and whether it ended via a
  // manual flatten) onto each trade for display, matched by direction +
  // entry price (within a tick) + entry time (within 5 minutes, generous
  // enough to absorb any clock/poll-timing drift between the two sources).
  function enrichTradesWithJournal(trades) {
    // 2026-10-12 fix 3: match against tradeEventIndex (entry / manual / peak events only, seeded from the journal FILE at startup)
    // instead of journalHistory, which starts empty on every restart and holds only the last 200 rows (~1 hour of signal checks),
    // so Recent Trades lost their context after any restart or an hour after the entry.
    const H = tradeEventIndex;
    const out = trades.map(t => {
      const entryMs = new Date(t.entryTime).getTime();
      const entryEvent = H.find(j => j.type === 'entry' && j.dir === t.dir
        && Math.abs(j.entryPrice - t.entryPrice) < 0.26 && Math.abs(j.t - entryMs) < 5 * 60 * 1000);
      // manual_entry (2026-09-22): logged when the periodic reconciliation
      // check catches a position it didn't open — this bot never advances
      // past FLAT except by opening something itself, so mid-session that
      // can only mean a manual trade. Widened match window (30 min, not
      // 5) since a manual entry can sit open a while before the bot's next
      // poll cycle happens to catch it, unlike an automated entry which is
      // journaled at the instant it fills.
      const manualEntryEvent = H.find(j => j.type === 'manual_entry' && j.dir === t.dir
        && Math.abs(j.entryPrice - t.entryPrice) < 0.26 && Math.abs(j.t - entryMs) < 30 * 60 * 1000);
      // fix 3: the index now spans days, so exit-time events must also fall after this entry (and within 36 h) - otherwise an
      // older trade at the same price could lend its exit/peak to a new one.
      const afterEntry = j => j.t >= entryMs - 60 * 1000 && j.t - entryMs < 36 * 3600 * 1000;
      const manualExitEvent = H.find(j => j.type === 'manual_flatten' && j.dir === t.dir
        && Math.abs(j.entryPrice - t.entryPrice) < 0.26 && afterEntry(j));
      // peak_unrealized (2026-09-24): written once at reset() — see
      // liveStateMachine.js — so it's an EXIT-time event, not matchable
      // against entryMs the same way entryEvent is; same loose dir+price
      // match as manualExitEvent above.
      const peakEvent = H.find(j => j.type === 'peak_unrealized' && j.dir === t.dir
        && Math.abs(j.entryPrice - t.entryPrice) < 0.26 && afterEntry(j));
      if (!entryEvent && !manualEntryEvent && !manualExitEvent && !peakEvent) return t;
      // levelName/levelBehavior: the actual TRIGGER level a trade fired off
      // (e.g. "Asia Low" / "TESTING"), when one exists — set for both a
      // mac-only pullback entry and a levels-sourced plan match (2026-09-24
      // fix: the latter used to fall through to levelsPlan.targetName, the
      // plan's downside TARGET, not what actually triggered the entry — a
      // real trade record showed "PWH" 534pts away for exactly this reason).
      // targetName is now only ever the fallback for the rare case neither
      // levelContext is set. Previously only ever visible in the raw server
      // log at the instant it happened; now travels with the trade record
      // itself so mobile can show it.
      const levelName = entryEvent?.levelContext?.name || entryEvent?.entryLevel?.name || entryEvent?.levelsPlan?.targetName;   // r9.14: entryLevel before the plan-target fallback
      const levelBehavior = entryEvent?.levelContext?.behavior;
      return {
        ...t,
        source: entryEvent?.source, grade: entryEvent?.grade, journalId: entryEvent?.journalId,
        macBiasStr: entryEvent?.macBiasStr, levelsBiasStr: entryEvent?.levelsBiasStr,
        triggerTf: entryEvent?.triggerTf, levelsBiasScore: entryEvent?.levelsBiasScore, biasAgreement: entryEvent?.biasAgreement, // owner forward-test 2026-10-11
        levelName, levelBehavior, levelTfMs: entryEvent?.levelContext?.tfMs, levelIntrabar: entryEvent?.levelContext?.intrabar,   // lv1 r12.4: display only
        manualEntry: !!manualEntryEvent,
        manualFlatten: !!manualExitEvent,
        peakUnrealized: peakEvent?.peakUnrealized,
        // isIntrabar (2026-10-09) — see signalContext's own comment in
        // checkForNewEntry(). Undefined (not false) for any trade recorded
        // before this field existed, or for manual entries that
        // never go through signalContext at all — the dashboard treats
        // undefined the same as bar-close (falsy), which is correct for
        // all of those cases.
        isIntrabar: entryEvent?.isIntrabar,
        // display only: why this trade / why it closed. Only for a UNIQUE broker-trade <-> entry-row match (exactly one candidate entry row,
        // and no other trade in this list claims the same journalId, checked below); otherwise the facts are withheld as ambiguous.
        ...(() => { try {
          const cands = H.filter(j => j.type === 'entry' && j.dir === t.dir && Math.abs(j.entryPrice - t.entryPrice) < 0.26 && Math.abs(j.t - entryMs) < 5 * 60 * 1000);
          if (cands.length !== 1 || !cands[0].journalId) return { decision: null, close: null, whyAmbiguous: cands.length > 1 };
          const r = tradeWhyIndex.get(cands[0].journalId);
          return { whyJournalId: cands[0].journalId, decision: decisionFacts(cands[0], r), close: r ? closeFacts(r) : null, exit: (() => { try { return tradeExitIndex.get(cands[0].journalId, { entryMs, exitMs: t.exitTime ? new Date(t.exitTime).getTime() : NaN, closed: t.closed === true }); } catch (e) { return null; } })() };   // lv1 r13.1: exit = display only
          // lv1 r13.3 (MacDot 6470325875 #4): this journalId comes from a HEURISTIC match (direction, entry price within a tick, entry time within 5 min, unique) -
          // not broker identity. The exit facts are windowed to this broker trade's own entry / last fill (lib/levelPanel.js createExitIndex), which narrows it only.
        } catch (e) { return {}; } })(),
      };
    });
    // display only: a journalId claimed by more than one broker trade is ambiguous for every claimant.
    const seen = new Map(); for (const t of out) if (t && t.whyJournalId) seen.set(t.whyJournalId, (seen.get(t.whyJournalId) || 0) + 1);
    return out.map(t => (t && t.whyJournalId && seen.get(t.whyJournalId) > 1) ? { ...t, decision: null, close: null, exit: null, whyAmbiguous: true } : t);
  }

  // Live REALIZED balance, refreshed each poll — the value at login time
  // (`account.balance`) goes stale the moment a trade closes. This is the
  // broker's own number, same source of truth as refreshRealDayPnl.
  async function refreshAccountBalance() {
    const accounts = await getAccounts(token);
    const match = accounts.find(a => a.id === account.id);
    return match ? match.balance : null;
  }

  log('Warming up on full history...');
  let { lastClosedBarTime, mac: lastMac, lv: lastLv } = await refreshAndEvaluate();
  runFlagJob();   // 10/17 round 3: the warm-up has no entry decision
  // Intrabar evaluation mode's own independent cadence (2026-10-08) — see
  // CONFIG.evaluationMode's comment. Starts at 0 so the very first main-loop
  // iteration is eligible to run it immediately rather than waiting a full
  // evaluationIntrabarPollMs first.
  let lastIntrabarEvalTime = 0;
  log(`Warmup complete. Last closed 15m bar: ${new Date(lastClosedBarTime).toISOString()}`);
  // 2026-10-14: log the version (sha256, first 8) of every lib file at startup, so an outdated file on the VPS is visible in the log
  // (the chop-skip and persisted-plan settings were silently ignored for days by old lib files).
  try {
    const crypto = require('crypto');
    const libDir = path.join(__dirname, 'lib');
    const vers = fs.readdirSync(libDir).filter(f => f.endsWith('.js')).sort().map(f => `${f}=${crypto.createHash('sha256').update(fs.readFileSync(path.join(libDir, f))).digest('hex').slice(0, 8)}`);
    log(`lib versions: ${vers.join(' ')}`);
  } catch (e) { log(`WARNING: could not list lib versions: ${e.message}`); }
  // 2026-10-14 startup guard: the 10/09 'chop skip off' order only works if lib/macTrap.js honours opts.chopSkipEnabled.
  // An older macTrap.js silently ignores it (found live 10/14: checklist said "blocked by ADX chop skip" with the filter off).
  try {
    if (CONFIG.chopSkipEnabled === false && !fs.readFileSync(path.join(__dirname, 'lib', 'macTrap.js'), 'utf8').includes('chopSkipEnabled')) {
      log('WARNING: lib/macTrap.js is an outdated version that IGNORES chopSkipEnabled:false - the ADX chop skip is still blocking entries. Install lib/macTrap.js from the latest package.');
    }
  } catch (e) { log(`WARNING: could not read lib/macTrap.js for the chop-skip version check: ${e.message}`); }
  log(`Entering live loop, polling every ${CONFIG.pollIntervalMs / 1000}s...${CONFIG.evaluationMode === 'intrabar-1m' ? ` [INTRABAR EVALUATION MODE — every ${CONFIG.evaluationIntrabarPollMs / 1000}s against the still-forming bar]` : ''}`);
  // Confirms the session actually made it through login/warmup and is
  // running, not just that the process started — a login failure or a bad
  // contract resolution would exit before this point, so this alone tells
  // you it's genuinely live.
  log(`[ntfy] auth: ${NTFY_TOKEN ? 'on' : 'off'}${NTFY_TOKEN_BAD ? ' (NTFY_TOKEN is set but is not a valid token - not used)' : ''} | phone pushes ${NTFY_TOPIC ? 'on' : 'off (NTFY_TOPIC not set)'} | INFO budget ${CONFIG.notifyInfoBudget} per UTC day (${Math.round(CONFIG.notifyInfoReserveFrac * 100)}% kept for after 13:00 PT), CRITICAL never capped | level-cross pushes: ${NP.levelCrossMode(CONFIG.levelCrossPush)} | status push every ${Math.round(CONFIG.statusPushIntervalMs / 60000)} min, 15:00-13:10 PT trading days`);   // 18f1
  notifyPhone(
    `${LIVE ? 'LIVE' : 'Paper'} session started`,
    `${symbol} warmed up and entering the live loop.${LIVE ? ` Trading account ${account.name || account.id}.` : ''}`,
    { tags: LIVE ? 'rotating_light' : 'information_source' }
  );

  // Kept in memory (capped) so writeSnapshotFile() can match recent
  // journal entries against broker fills WITHOUT re-reading the whole
  // JSONL file off disk every ~20s poll — the file itself is the permanent
  // record, this is just a fast lookup cache mirroring what's in it.
  let journalHistory = [];
  // 2026-10-12 fix 3: trade-context events kept separately (newest first) and seeded from the file, so a restart or a busy hour of
  // signal checks no longer strips Recent Trades of their source/grade/MAC/Levels/level/peak details.
  const TRADE_EVENT_TYPES = new Set(['entry', 'manual_entry', 'manual_flatten', 'peak_unrealized']);
  const TRADE_EVENT_CAP = 600;
  let tradeEventIndex = [];
  const tradeWhyIndex = createTradeWhyIndex();   // display only: trade_plan + close codes by journalId (own cap, so it never evicts entry events)
  const tradeExitIndex = createExitIndex();   // lv1 r13.1 (display only): how each trade ended, from its trade_manage rows (lib/levelPanel.js)
  function indexTradeEvent(event) {
    try { tradeWhyIndex.index(event); } catch (e) { /* display only */ }
    try { tradeExitIndex.index(event); } catch (e) { /* lv1 r13.1: display only */ }
    if (!event || !TRADE_EVENT_TYPES.has(event.type)) return;
    tradeEventIndex.unshift(event);
    if (tradeEventIndex.length > TRADE_EVENT_CAP) tradeEventIndex.length = TRADE_EVENT_CAP;
  }
  (function seedTradeEventIndex() {
    try {
      if (!fs.existsSync(TRADE_JOURNAL_FILE)) return;
      const lines = fs.readFileSync(TRADE_JOURNAL_FILE, 'utf8').split('\n');
      for (const line of lines) {
        if (!line || line.indexOf('"type":"signal_check"') >= 0) continue;
        let e; try { e = JSON.parse(line); } catch (err) { continue; }
        indexTradeEvent(e);
      }
      log(`[journal] trade-context index seeded from file: ${tradeEventIndex.length} entry/manual/peak events`);
    } catch (e) { log('  [journal] trade-context seed failed (non-fatal): ' + e.message); }
  })();
  function appendJournal(event) {
    if (event && JOURNAL_META_TYPES.has(event.type)) { persistJournalMeta(event); return; }   // journal metadata r1.2: file only
    try {   // journal metadata r1.2: enrich a COPY of frozen rows (receipts are frozen); never throws into the caller
      if (event && typeof event === 'object') {
        if (Object.isFrozen(event)) event = { ...event };
        if (journalStampId && event.stampId === undefined) event.stampId = journalStampId;
        if ((event.type === 'entry' || event.type === 'trade_block') && event.context === undefined) event.context = dayContextNow(event.dir, [event.entryPrice, event.entry, event.price].find(Number.isFinite) ?? null);   // lv1 r13.3.7: the day-type context (log only)
        // r1.3: signal_check rows carry their own evaluation's board (set where the row is built); other rows the LATEST evaluation's result, labelled as such
        if ((event.type === 'signal_check' || event.type === 'trade_plan' || event.type === 'trade_block') && event.boardRef === undefined && latestEvalBoard) event.boardRef = { ...latestEvalBoard, binding: 'latest-evaluation' };
        if (event.type === 'entry' && event.board === undefined && boardTracker && latestEvalBoard) event.board = { ...(boardTracker.current() || {}), status: latestEvalBoard.status, binding: 'latest-evaluation' };   // the trade's birth certificate (MacLedger)
        if (event.type === 'signal_check' && event.bar === undefined) event.bar = { identity: 'unknown' };   // only the snapshot writer knows the consumed evaluation
      }
    } catch (_) { /* journal only */ }
    const writeTerminal = () => {   // r1.4: called only after the evidence row persisted. Earlier deferred evidence is retried FIRST, then THIS row is proposed
      try {                         // against the committed state (never a proposal computed before the retry); a failed write queues it in order (retried next write)
        if (planTerminals.pendingCount()) planTerminals.retry(persistJournalMeta);
        planTerminals.feed(event, persistJournalMeta);
      } catch (_) { /* journal only */ }
    };
    // Receipts must not evict economic reconciliation history or enter a legacy read-side index.
    if (event && event.type === 'journal_receipt') { let ok = false; try { fs.appendFileSync(TRADE_JOURNAL_FILE, JSON.stringify(event) + '\n'); ok = true; } catch (_) { /* receipt write only */ } if (ok) writeTerminal(); return; }
    journalHistory.push(event);
    if (journalHistory.length > 200) journalHistory.shift();
    indexTradeEvent(event);
    let wrote = false;
    try { fs.appendFileSync(TRADE_JOURNAL_FILE, JSON.stringify(event) + '\n'); wrote = true; }
    catch (e) { log('  [journal] write failed (non-fatal): ' + e.message); }
    if (wrote) writeTerminal();   // a plan_terminal never cites an evidence row that failed to persist
  }

  // Restart safety for the order lifecycle journal (2026-09-24, B2 point 5)
  // — journalHistory above starts EMPTY on every process restart (it only
  // mirrors what THIS run has written), so a 'pending' row left orphaned by
  // a crash/restart right as an order was resting would otherwise sit
  // "PENDING" on mobile forever. Reads the actual on-disk file once at
  // startup (the only time this needs the full history, not just the recent
  // in-memory tail) and resolves any journalId whose only row is 'pending'.
  async function reconcileOrphanedPendingJournalRows() {
    let lines;
    try { lines = fs.readFileSync(TRADE_JOURNAL_FILE, 'utf8').split('\n').filter(Boolean); }
    catch (e) { return; } // no journal file yet on a brand-new deploy — nothing to reconcile
    const byId = new Map();
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; } // one bad line shouldn't sink reconciliation
      if (ev.type !== 'signal_check' || !ev.journalId) continue;
      if (!byId.has(ev.journalId)) byId.set(ev.journalId, []);
      byId.get(ev.journalId).push(ev);
    }
    for (const [journalId, events] of byId) {
      if (events.length !== 1 || events[0].outcome !== 'pending') continue; // already resolved, or not an order-lifecycle row
      const p = events[0];
      log(`  Restart reconciliation: orphaned PENDING journal row (${journalId}, ${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.entryType} @ ${p.entryPrice}) — checking against the broker.`);
      if (LIVE) {
        let pos; try { pos = await getOpenPosition(token, account.id, contractId); } catch (e) { pos = undefined; }
        if (pos === undefined) { log(`  Restart reconciliation: broker position unreadable - leaving the pending row ${journalId} for the next restart.`); continue; }   // profittrail4: unknown is not "no fill"
        if (pos && pos.size) {
          appendJournal({ type: 'signal_check', t: Date.now(), journalId, outcome: 'traded', dir: p.dir, source: p.source, grade: p.grade, contracts: p.contracts, entryType: p.entryType, entryPrice: pos.averagePrice, stopPrice: p.stopPrice });
        } else {
          log(`  Restart reconciliation: ${journalId} remains UNKNOWN: flat position alone does not prove entry cancellation; pending-order recovery is separate.`);
        }
      } else {
        // PAPER mode has no real broker to check against — this process is
        // the only thing that could ever have filled it, and it just
        // restarted, so it genuinely never filled.
        appendJournal({ type: 'signal_check', t: Date.now(), journalId, outcome: 'canceled', dir: p.dir, source: p.source, grade: p.grade, reason: 'process restart (paper mode), order never filled' });
      }
    }
  }

  // Signal journal (2026-09-24, mobile Tab 1 — "every signal, traded or sat
  // out + why"): one entry per 15m bar close while flat, whether or not a
  // trade actually fired. Board state is already fully known at this point
  // (lastMac/lastLv) — this just records it, same TRADE_JOURNAL_FILE as
  // entries/exits so one file has the whole story. Read-only: never affects
  // what the bot decides, only what gets written down about it.
  function journalSignalSnapshot(mac, lv, outcome, extra = {}) {
    // owner forward-test 2026-10-11: compact checklist state (verdict + the keys of every FAILING row) so a later reading of the journal
    // shows what was blocking each evaluation without needing the phone screenshot. Never throws, never affects a decision.
    let checklist = null;
    try { const c = computeEntryChecklist(mac, lv, Date.now()); checklist = { verdict: c.verdict, fail: c.items.filter(i => i.pass === false).map(i => i.key) }; } catch (e) { checklist = null; }
    appendJournal({
      type: 'signal_check', t: Date.now(),
      mac: {
        verdict: mac.verdict, biasStr: mac.biasStr, longScore: mac.longScore, shortScore: mac.shortScore,
        activeDir: mac.activeDir, activeScore: mac.activeScore, entryGrade: mac.entryGrade,
        hardBlock: mac.hardBlock, blockReason: mac.blockReason,
        rsiH4Now: mac.rsiH4Now, rsi4hVetoLong: mac.rsi4hVetoLong, rsi4hVetoShort: mac.rsi4hVetoShort,
      },
      levels: {
        biasStr: lv.biasStr, biasScore: lv.biasScore, triggerTf: lv.triggerTf ?? null, tfTriggers: lv.tfTriggers ? Object.fromEntries(Object.entries(lv.tfTriggers).map(([k, v]) => [k, v.skipped ? 'skipped' : v.dir === 0 ? null : `${v.dir === 1 ? 'LONG' : 'SHORT'}/${v.via}`])) : null, // biasScore/triggerTf/tfTriggers added owner forward-test 2026-10-11
        plan: lv.plan ? { dir: lv.plan.dir, targetName: lv.plan.targetName, grade: lv.plan.grade, rr: lv.plan.rr } : null,
        // r9.10 (journal only): the 15m control score the gate reads, and the alignment verdict WITH the first failing slot's reason code
        controlBiasScore: Number.isFinite(lv.controlBiasScore) ? Math.round(lv.controlBiasScore * 1000) / 1000 : null, aligned: lv.alignedFull === true, alignmentStatus: lv.alignmentStatus ?? null,
        alignSlots: Array.isArray(lv.alignSlots) ? lv.alignSlots.map(s => `${s.timeframe}${s.flag == null ? '?' : s.flag ? '+' : '-'}${s.status === 'CURRENT' ? '' : ':' + ((s.reasonCodes || [])[0] || s.status)}`) : null,
      },
      checklist,
      bar: (() => { try { return evalSnapshots.get(lv) || { identity: 'unknown' }; } catch (e) { return { identity: 'unknown' }; } })(),   // journal metadata r1.2
      boardRef: (() => { try { const b = lv && evalBoards.get(lv); return b ? { ...b, binding: 'evaluation' } : { boardSeq: null, status: 'unknown', binding: 'none' }; } catch (e) { return { boardSeq: null, status: 'unknown', binding: 'none' }; } })(),   // r1.3: THIS row's evaluation, never a newer board
      ...(() => { try { const f = flagsForJournal(); return f ? { flags: f } : {}; } catch (e) { return {}; } })(),   // 10/17 session flag count (display/logging only)
      outcome, ...extra,
      ...(() => { if (!['pending', 'attempted', 'traded', 'canceled', 'closed'].includes(outcome)) return {}; try { const m = newsNearestMin(Date.now()); return m == null ? {} : { newsWithinMin: m }; } catch (e) { return {}; } })(),   // 10/16: minutes to (+) / since (-) the nearest high-impact release
    });
  }

  // 10/18 RULE 3: the L3 ladder in POINTS (profitLockUnit 'points'): the state machine reads unit / armPts / lockPts / stepPts from the profitTrail object it is given
  if (CONFIG.profitTrail && CONFIG.profitLockUnit === 'points' && CONFIG.profitLockPts) Object.assign(CONFIG.profitTrail, { unit: 'points', armPts: CONFIG.profitLockPts.arm, lockPts: CONFIG.profitLockPts.lock, stepPts: CONFIG.profitLockPts.step, bePts: CONFIG.profitLockPts.be ?? null });
  // Journal metadata r1.2: the session stamp is taken HERE, after the last startup mutation of CONFIG (line above), so it fingerprints the settings that trade.
  try {
    const files = { 'live-executor.js': fs.readFileSync(__filename, 'utf8') };
    for (const f of fs.readdirSync(path.join(__dirname, 'lib')).filter(f => f.endsWith('.js'))) files['lib/' + f] = fs.readFileSync(path.join(__dirname, 'lib', f), 'utf8');
    const stamp = journalMeta.buildSessionStamp({ files, effectiveConfig: CONFIG, overrides: CONFIG_LOCAL.overrides, node: process.version, startedAt: Date.now(), runId: journalRunId });
    if (persistJournalMeta(stamp)) { journalStampId = stamp.stampId; log(`[journal] session stamp ${stamp.stampId} run ${journalRunId.slice(0, 8)} (executor ${stamp.files['live-executor.js'].slice(0, 8)}, settings ${stamp.settingsHash.slice(0, 8)})`); }
    else persistJournalMeta({ type: 'session_stamp', schema: journalMeta.SCHEMA, t: Date.now(), runId: journalRunId, incomplete: true, error: 'stamp write failed' });
  } catch (e) { log('  [journal] session stamp failed (non-fatal): ' + e.message); persistJournalMeta({ type: 'session_stamp', schema: journalMeta.SCHEMA, t: Date.now(), runId: journalRunId, incomplete: true, error: String(e.message).slice(0, 200) }); }
  // Journal metadata r1.2: plan outcomes survive restarts - rebuild open plans (planned size) and the latest plan_terminal version per plan from disk
  try {
    const keep = [], txt = fs.existsSync(TRADE_JOURNAL_FILE) ? fs.readFileSync(TRADE_JOURNAL_FILE, 'utf8') : '';
    // r1.3: plus the durable EVIDENCE rows, so a terminal whose write failed before the restart is recovered (written now) from what is on disk
    for (const line of txt.split('\n')) if (line.includes('"journalId"') && /"(trade_plan|plan_terminal|entry|ENTRY_FILLED|ENTRY_EXPIRED|canceled|PLAN_CANCELED|PLAN_RESET|FILL_OBSERVED)"/.test(line)) { try { const r = JSON.parse(line); if (r.type === 'trade_plan' || r.type === 'plan_terminal' || journalMeta.evidenceOf(r)) keep.push(r); } catch (_) { /* torn line */ } }
    const recovered = planTerminals.restore(keep, persistJournalMeta);
    if (recovered.length) log(`[journal] ${recovered.length} plan outcome row(s) recovered from durable evidence at startup`);
    if (planTerminals.lastRestoreOutOfScope) log(`[journal] ${planTerminals.lastRestoreOutOfScope} evidence row(s) of plans outside the retained outcome cache left unresolved at startup (no version issued)`);   // r1.5
  } catch (e) { const r = journalMetaErrors.row('plan_terminal_restore', e); if (r) persistJournalMeta(r); }
  const stateMachine = LIVE ? new LiveStateMachine({ token, accountId: account.id, contractId, pointValue, tickSize, log, notify: notifyPhone, journal: sfJournal, profitLockDollars: CONFIG.profitLockDollars, profitLockPct: CONFIG.profitLockPct, marketableLimitBufferPoints: CONFIG.marketableLimitBufferPoints, pendingExpireMs: CONFIG.pendingExpireMs, trailStepPoints: CONFIG.trailStepPoints, profitTrail: CONFIG.profitTrail, runnerTrailRule: scaleOutRunnerOn(CONFIG) ? { lockPts: CONFIG.scaleOutRunner.runnerLockPts, stepPts: CONFIG.scaleOutRunner.runnerStepPts } : null, blackoutFn: entryWindowReason, blockFn: blackoutReason, restingBlockHorizonMs: CONFIG.noRestingAcrossBlock === false ? 0 : (Number.isFinite(CONFIG.pendingExpireMs) && CONFIG.pendingExpireMs > 0 ? CONFIG.pendingExpireMs : 30 * 60000) + 60000, pendingCancelOnStopTouch: CONFIG.pendingCancelOnStopTouch, noProgressHourEndDefer: CONFIG.noProgressExit.hourEndDefer, fillSlipGuard: CONFIG.fillSlipGuard, tp1FromFill: CONFIG.tp1FromFill === true, noProgressCandles: CONFIG.noProgressExit.candles, entryStopFloorFn: ts => entryFloorAt(ts), entryStopFloorPlanFn: (resting, ts) => entryFloorWindow(resting, ts).pts, newsRestingFn: ts => newsRestingBlock(ts), journalIdFn: () => { const c = openJournalContext || pendingJournalContext; return c ? c.journalId : null; }, stateFile: TRADE_STATE_FILE, entryQuantityCheck: entryQuantityAllowed, alignmentFreshnessFn: alignFreshnessState, entryControlCheck: (dir, source, context) => { const result = entryControlAllowed(dir, source, context?.reclaimOf ? 'reclaim' : context?.wave ? 'wave' : context?.reversal ? 'reversal' : 'entry', 'transport-submit'); try { const jr = require('./lib/journalReceipts'); jr.emit(appendJournal, () => jr.receipt(context?.journalId, 'CONTROL_ADMISSION', { result, seam: 'transport-submit', producer: 'entryControlAllowed/createControlJournal', policy: 'week1-decided-m15-v2', direction: dir, source, exception: 'NONE', measurement: { score: entryControlBoard?.controlBiasScore, valid: entryControlBoard?.controlValid, observedAt: entryControlBoard?.controlObservedAt, evaluatedAt: entryControlBoard?.controlEvaluatedAt }, marketStage: jr.UNKNOWN })); } catch (_) { /* receipt only */ } return result; } }) : null;
  if (LIVE && tideLiveOn()) tideDrv = tideLive.create({ token, accountId: account.id, contractId, orders: require('./lib/liveOrders'), log, notify: notifyPhone,   // [2a]
    cfgFn: () => { let fd = null; try { const f = computeDrawdownFloor(); fd = Number.isFinite(lastAccountBalance) && Number.isFinite(f) ? lastAccountBalance - f : null; } catch (e) { fd = null; } return { ...tideWire.liveMoney(CONFIG), pointValue, tickSize, floorDistanceUsd: fd, trail: tideWire.trailOf(CONFIG), trailSwingStrength: tideWire.trailSwingStrengthOf(CONFIG) }; },   // [r1.6] maxContracts capped at tide.sizeCap   // [r1.6.3] trail: tide.trail '5m' (shipped) | 'ladder'
    journal: row => { try { lvjDay(Date.now()); lvjWrite(row); } catch (e) { /* journal only */ } }, stateFile: path.join(__dirname, `tide-live-state-${SYMBOL}.json`), take1MaxFn: () => tideWire.take1Max(CONFIG), feePerContractSide: (CONFIG.brokerCosts && Number.isFinite(CONFIG.brokerCosts.feePerContractSide) && Number.isFinite(CONFIG.brokerCosts.commissionPerContractSide)) ? CONFIG.brokerCosts.feePerContractSide + CONFIG.brokerCosts.commissionPerContractSide : 0.61,   // [r1.6.1] the TIDE net follows CONFIG.brokerCosts (0.36 + 0.25)
    preCheck: async sig => { const n = Date.now(); if (!tideLiveReady) return 'the warm-up is not done'; if (sig && Number.isFinite(sig.at) && n - sig.at > 10 * 60000) return `stale: the signal is ${Math.round((n - sig.at) / 60000)} min old (> 10)`; if (!(stateMachine.phase === 'FLAT' && !stateMachine.desynced)) return `the old path holds ${stateMachine.phase}`; if (sessionCloseState(n, CONFIG).noEntry) return 'session close (no entry from 12:55 PT)'; { const tb = tideWire.blockAt(CONFIG, n); if (tb) return 'TIME_BLOCK: ' + tb; } if (newsWaitBlock(n)) return 'news wait'; return null; },
    onEnd: (takeId, res) => { try { if (tideShadow) tideWire.liveFeedback(tideShadow, takeId, res); } catch (e) { /* feedback only */ } }, onTp1: takeId => { try { if (tideShadow) tideWire.liveFeedback(tideShadow, takeId, { tp1Done: true }); } catch (e) { /* feedback only */ } } });

  // HOTFIX 1 (2026-10-13) same-direction re-entry cooldown state (see ENTRY-GUARD HELPERS and CONFIG.reentryCooldown). In-memory only: a restart
  // forgets it (the next entry then waits for nothing), which is the old behaviour.
  let stopOuts = {};            // { 1: {dir,t,until,kind}, -1: {...} } most recent stop-out per direction (an opposite-direction stop never overwrites this one)
  // r9.7 review S2: restore cooldowns still running after a restart (validated below; anything unreadable is reported, never treated as none).
  // MacDot aa79108: a record must be complete (dir, numeric t and until, until after t, at most 3 h long, t not more than 5 min in the future) or it is dropped WITH a log line;
  // a file that exists but cannot be read is reported as unreadable, never treated as "no cooldown". Durations are judged from the record's own t, so a small clock step does not drop it.
  let cdRaw = null; try { cdRaw = fs.readFileSync(COOLDOWN_STATE_FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') log('  [cooldown] WARNING: the saved cooldown file could not be read (' + e.message + ') - no cooldown restored; check ' + COOLDOWN_STATE_FILE); }
  if (cdRaw != null && LIVE) try { const sv = JSON.parse(cdRaw), nowR = Date.now();
    for (const d of [1, -1]) { const r = sv && sv[d]; if (r == null) continue;
      const bad = !(r && typeof r === 'object') ? 'not an object' : r.dir !== d ? 'wrong direction' : !(typeof r.t === 'number' && Number.isFinite(r.t)) ? 'no valid exit time' : !(typeof r.until === 'number' && Number.isFinite(r.until)) ? 'no valid end time'
        : r.until <= r.t ? 'ends before it starts' : r.until - r.t > 3 * 3600000 ? 'longer than 3 h' : r.t > nowR + 5 * 60000 ? 'exit time in the future (clock?)' : null;
      if (bad) { log(`  [cooldown] WARNING: saved ${d === 1 ? 'LONG' : 'SHORT'} cooldown dropped at restart (${bad}).`); continue; }
      if (r.until > nowR) {
        // final review S2: re-apply TODAY's config to the saved record (after-win off / scope 'same' / floor 0 / 15m candle): never longer than the current rules would give
        if (!CONFIG.reentryCooldown) continue;
        const winSd = !!(r.win && r.sameDirBlockMin && CONFIG.sameDirBlockAfterWin && (r.tradeDir == null || r.tradeDir === d));   // so1 r1.11
        if (r.win && !winCooldownDirs(CONFIG, r.tradeDir ?? d).includes(d) && !winSd) continue;
        if (!r.win && r.tradeDir != null && r.tradeDir !== d && !(CONFIG.reentryCooldownAfterWin && CONFIG.reentryCooldownScope === 'both')) continue;
        const cur = buildStopOut(CONFIG, d, r.t, r.kind, { ...(r.win ? { win: true } : {}), ...(r.tradeDir != null ? { tradeDir: r.tradeDir } : {}) });
        { const sd = r.sameDirBlockMin && (r.tradeDir == null || r.tradeDir === d) && (!r.win || CONFIG.sameDirBlockAfterWin) ? sameDirBlockUntil(CONFIG, r.t) : null; if (sd != null && sd > cur.until) cur.until = sd; else delete r.sameDirBlockMin; }   // r1.11: wins too   // so1 r1.1 (MacDot #2): today's candle block is part of the rule
        if (cur.until <= nowR) continue;
        const floorSetsEnd = !!cur.winFloorMin && r.until >= cur.until; r.until = Math.min(r.until, cur.until); if (floorSetsEnd) r.winFloorMin = cur.winFloorMin; else delete r.winFloorMin;   // MacDot 153790c: '15 min' only when the floor really is the end
        stopOuts[d] = r; log(`  [cooldown] restored after the restart: ${d === 1 ? 'LONG' : 'SHORT'} blocked until ${new Date(r.until).toISOString()}${r.winFloorMin ? ` (${r.winFloorMin} min after a win)` : ''}`); } } } catch (e) { log('  [cooldown] WARNING: the saved cooldown file is not valid JSON (' + e.message + ') - no cooldown restored; check ' + COOLDOWN_STATE_FILE); }
  if (Number(CONFIG.reentryWinMinMinutes) > 0 && !(CONFIG.reentryCooldown && CONFIG.reentryCooldownAfterWin)) log(`  [cooldown] NOTE: reentryWinMinMinutes is ${CONFIG.reentryWinMinMinutes} but the after-win cooldown is OFF (reentryCooldown / reentryCooldownAfterWin), so the after-win floor does nothing.`);   // review S3
  let deadPlans = {};           // 10/16 NO RE-ARMING A DEAD PLAN: { 1: {dir, entry, stop, t}, -1: ... } the last plan cancelled because price reached its stop before it filled
  let lastNewsWaitLog = null;   // 10/16 news wait: log once per wait window
  const sessionDone = {};       // 10/17 session close, per PT date: { alerted, candidateWarned, paperFlat, lastLog }
  function flagsForJournal() { return sessionFlags && sessionFlags.m15 ? { m15: { long: sessionFlags.m15.long, short: sessionFlags.m15.short, lead: sessionFlags.m15.lead }, m5: sessionFlags.m5 ? { long: sessionFlags.m5.long, short: sessionFlags.m5.short, lead: sessionFlags.m5.lead } : null } : null; }
  // 10/17 the phone's session-close view (display only)
  function sessionView(now = Date.now()) {
    const st = sessionCloseState(now, CONFIG);
    if (!st.on) return { on: false };
    return { on: true, phase: st.phase, noEntryFrom: st.noEntryFrom, flattenAt: st.flattenAt, reopenAt: st.reopenAt, noEntryPt: st.noEntryPt, flattenPt: st.flattenPt, early: st.early, candidate: st.candidate, text: sessionCloseText(st) };
  }
  // 10/17 SESSION CLOSE step, every main-loop poll (before the market data fetch, so a failed fetch never delays it). Entries are blocked in checkForNewEntry and a resting
  // entry is cancelled by the state machine's blackout path (blackoutReason); this step flattens an open position from sessionFlattenPt and alerts when still not flat.
  async function sessionCloseStep(now = Date.now()) {
    const st = sessionCloseState(now, CONFIG);
    if (!st.on || !st.weekday) return null;
    const mem = sessionDone[st.date] || (sessionDone[st.date] = {});
    for (const k of Object.keys(sessionDone)) if (k < st.date) delete sessionDone[k];
    if (st.candidate && !mem.candidateWarned && now < st.flattenAt) { mem.candidateWarned = true; log(`  [session] WARNING: today may be a CME early close (${st.candidate}; UNVERIFIED) and it is not in sessionEarlyCloses: the bot flattens only at ${st.flattenPt} PT.`); notifyPhone('Check: holiday early close today?', `Today (${st.date}) may be a CME early close (${st.candidate}, unverified). The bot flattens only at ${st.flattenPt} PT. If CME closes earlier, add it: bash /opt/mac-bot/set-session.sh early ${st.date} HH:MM, then restart when flat - or flatten by hand before the close.`, { priority: 'high', tags: 'warning' }); }
    if (!st.flattenDue) return st.noEntry ? 'no-entry' : null;
    let r = null;
    if (LIVE && tideOwned()) {   // [2a] the TIDE position: the planner's flatten (verified stop cancel -> market -> confirming read), exactly one per position
      if (!mem.tideExitAt) { mem.tideExitAt = now; log(`  [session] session close at ${st.flattenPt} PT: closing the TIDE position (planner flatten).`); }
      try { await tideDrv.exitAtMarket(`session close at ${st.flattenPt} PT`); } catch (e) { log('  [session] TIDE exit step failed (retrying next poll): ' + e.message); }
      if (tideOwned() && st.alertDue && !mem.tideAlerted) { mem.tideAlerted = true; log('  [session] URGENT: the TIDE position is still NOT FLAT after the session-close exit - Topstep liquidates at 13:10 PT.'); notifyPhone('NOT FLAT - FLATTEN IN TOPSTEPX NOW', `The TIDE position is still open after the ${st.flattenPt} PT exit (phase ${tideDrv.phase()}). Topstep closes everything at 13:10 PT. Use Flatten in TopstepX now.`, { priority: 'urgent', tags: 'rotating_light' }); }
      if (tideOwned()) return 'sent';
    }
    if (LIVE) {
      if (stateMachine.phase !== 'FLAT') {
        const ph = stateMachine.phase;
        try { r = await stateMachine.sessionFlatten(`session close at ${st.flattenPt} PT`); } catch (e) { r = 'retry'; log('  [session] flatten step failed (retrying next poll): ' + e.message); }
        watchLiveLifecycle(ph);
        if (r === 'sent' && mem.sentAt == null) mem.sentAt = now;   // ROUND 2 (QA B6): when the exit went out (an exit still confirming is not "not flat")
        if (r === 'retry') mem.sentAt = null;
      } else r = 'flat';
      // urgent alert when still not flat at flattenAt + sessionFlattenAlertSec (once per day); the machine keeps retrying every poll
      if (st.alertDue && stateMachine.phase !== 'FLAT' && (stateMachine.phase !== 'FLATTENING' || mem.sentAt == null || now - mem.sentAt > 20000) && !mem.alerted) {   // QA B6: not right after a good exit
        mem.alerted = true;
        log(`  [session] URGENT: still NOT FLAT at ${new Date(now).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT (phase ${stateMachine.phase}) - Topstep liquidates at 13:10 PT.`);
        journalManage('SESSION_NOT_FLAT', `Session close: the position is still open ${CONFIG.sessionFlattenAlertSec} s after ${st.flattenPt} PT (phase ${stateMachine.phase}); urgent alert sent. The bot keeps retrying every poll.`, { phase: stateMachine.phase });
        notifyPhone('NOT FLAT - FLATTEN IN TOPSTEPX NOW', `The session-close flatten has not confirmed (phase ${stateMachine.phase}). Topstep closes everything at 13:10 PT (3:10 PM CT). Use Flatten / Close position in TopstepX now.`, { priority: 'urgent', tags: 'rotating_light' });
      }
    } else if (position || pending) {
      log(`  [PAPER] session close at ${st.flattenPt} PT: closing the simulated ${position ? 'position' : 'pending order'}.`);
      if (position) journalPositionClosed(lastKnownClose, position.realizedPnlSoFar); else journalOrderCanceled('session close (paper)');
      appendJournal({ type: 'session_flatten', t: now, paper: true, dir: (position || pending).dir });
      position = null; pending = null; r = 'flat';
      notifyPhone('Session close (paper)', 'Cleared the simulated position/order (flat by 13:10 PT).', { tags: 'checkered_flag' });
    } else r = 'flat';
    return r;
  }
  // MORNING HOLD FLATTEN (Mac 10/19): inside the hold window, an open position or resting entry is closed with the state machine's own
  // sessionFlatten() - the same verified path the 13:05 PT session close runs every day. Urgent alert once per day if still not flat 90 s in.
  const morningDone = {};
  async function morningFlattenStep(now = Date.now()) {
    if (!inMorningHold(now)) return null;
    const day = ptInfo(now).dateStr, mem = morningDone[day] || (morningDone[day] = { startedAt: now });
    for (const k of Object.keys(morningDone)) if (k < day) delete morningDone[k];
    let r = null;
    if (LIVE) {
      if (tideOwned() && !mem.tideNoted) { mem.tideNoted = true; log('  [tide-live] morning hold: the TIDE position is NOT closed (TIDE has no timed exits); new TIDE entries follow the blocks.'); journalManage('TIDE_MORNING_SKIP', 'Morning hold: the TIDE position is not closed (no timed exits for TIDE).', {}); }   // [2a]
      if (stateMachine.phase === 'FLAT') return 'flat';
      if (!mem.noted) { mem.noted = true; log(`  [morning] MORNING HOLD: closing the open ${stateMachine.phase} now; locked until ${CONFIG.morningHold.to} PT (same path as the session close).`);
        journalManage('MORNING_FLATTEN', `Morning hold: the bot closes any open position / resting entry and stays flat until ${CONFIG.morningHold.to} PT.`, { phase: stateMachine.phase });
        notifyPhone('Morning hold: flattening', `Closing everything now (no new entries until ${CONFIG.morningHold.to} PT). Confirming shortly.`, { priority: 'high', tags: 'sunrise' }); }
      const ph = stateMachine.phase;
      try { r = await stateMachine.sessionFlatten(`morning hold ${morningHoldLabel()} PT`); } catch (e) { r = 'retry'; log('  [morning] flatten step failed (retrying next poll): ' + e.message); }
      watchLiveLifecycle(ph);
      if (stateMachine.phase !== 'FLAT' && now - mem.startedAt > 90000 && !mem.alerted) {
        mem.alerted = true;
        log(`  [morning] URGENT: still NOT FLAT 90 s into the morning hold (phase ${stateMachine.phase}); retrying every poll.`);
        journalManage('MORNING_NOT_FLAT', `Morning hold: still not flat 90 s after the flatten started (phase ${stateMachine.phase}); urgent alert sent. The bot keeps retrying every poll.`, { phase: stateMachine.phase });
        notifyPhone('NOT FLAT - FLATTEN IN TOPSTEPX NOW', `The morning-hold flatten has not confirmed (phase ${stateMachine.phase}). Use Flatten / Close position in TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
      }
    } else if (position || pending) {
      log(`  [PAPER] morning hold: closing the simulated ${position ? 'position' : 'pending order'}.`);
      if (position) journalPositionClosed(lastKnownClose, position.realizedPnlSoFar); else journalOrderCanceled('morning hold (paper)');
      position = null; pending = null; r = 'flat';
    } else r = 'flat';
    return r;
  }
  let pausedFrom = 0;           // 10/16 when the current pause started (phone countdown ring)
  let pausedUntil = 0;          // 10/16 MANUAL PAUSE: no NEW entries before this time (ms); 0 = not paused. Restored from PAUSE_STATE_FILE at startup.
  try { const ps = JSON.parse(fs.readFileSync(PAUSE_STATE_FILE, 'utf8')); if (ps && Number.isFinite(ps.until) && ps.until > Date.now()) { pausedUntil = Math.min(ps.until, Date.now() + 30 * 60000); pausedFrom = Number.isFinite(ps.at) ? ps.at : Date.now(); log(`  [pause] restored after the restart: paused by you until ${new Date(pausedUntil).toISOString()} (no new entries).`); } } catch (e) { /* no pause saved */ }
  // 10/16 MANUAL PAUSE from the phone (POST /pause -> pause-request file). minutes 5/10/15/30 pause (clamped to <= 30 min from now), 0 resumes. Blocks NEW entries
  // only: an open position keeps its stops/targets/trail; a resting entry order is cancelled at the pause start (verified cancel, a fill wins). One phone note each.
  // ROUND 4 (QA M2): the pause file is written atomically (tmp file + rename), so a restart never reads a torn file.
  function writeAtomic(f, str) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, str); fs.renameSync(tmp, f); }
  async function handlePauseRequest(minutes, now = Date.now()) {
    const hmP = t => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT';
    if (![0, 5, 10, 15, 30].includes(minutes)) { log(`  [pause] request ignored: minutes ${JSON.stringify(minutes)} (allowed 5, 10, 15, 30, or 0 = resume)`); return 'rejected'; }
    if (minutes === 0) {
      if (!pausedUntil) return 'not-paused';
      pausedUntil = 0; try { writeAtomic(PAUSE_STATE_FILE, JSON.stringify({ until: 0, at: now })); } catch (e) { /* best effort */ }
      log('  [pause] RESUMED by you: new entries allowed again.');
      journalManage('MANUAL_RESUME', 'You resumed the bot from the phone: new entries are allowed again.', { by: 'phone' });
      notifyPhone('Bot resumed', 'New entries are allowed again (you resumed from the phone).', { tags: 'arrow_forward' });
      return 'resumed';
    }
    pausedUntil = Math.min(now + minutes * 60000, now + 30 * 60000); pausedFrom = now;
    try { writeAtomic(PAUSE_STATE_FILE, JSON.stringify({ until: pausedUntil, at: now })); } catch (e) { log('  [pause] could not save the pause (' + e.message + ') - it is active but a restart would forget it'); }
    log(`  [pause] PAUSED by you for ${minutes} min: no new entries until ${hmP(pausedUntil)} (open positions are managed normally).`);
    journalManage('MANUAL_PAUSE', `You paused new entries from the phone for ${minutes} min, until ${hmP(pausedUntil)}. Any open position keeps its stops, targets and trail; a resting entry order is cancelled.`, { minutes, until: pausedUntil });
    notifyPhone('Bot paused', `No new entries until ${hmP(pausedUntil)}. Open positions keep their stops, targets and trail; a resting entry order is cancelled.`, { tags: 'pause_button' });
    if (LIVE && stateMachine.phase === 'PENDING_ENTRY') { const ph = stateMachine.phase; try { await stateMachine.cancelPendingForPause(hmP(pausedUntil)); } catch (e) { log('  [pause] cancelling the resting entry failed (retrying next poll): ' + e.message); } watchLiveLifecycle(ph); }
    else if (!LIVE && pending) { log('  [PAPER] entry cancelled: paused by you.'); journalOrderCanceled('entry cancelled: paused by you until ' + hmP(pausedUntil)); pending = null; }
    return 'paused';
  }
  function checkPauseExpiry(now = Date.now()) {
    if (!pausedUntil || now < pausedUntil) return false;
    pausedUntil = 0; try { writeAtomic(PAUSE_STATE_FILE, JSON.stringify({ until: 0, at: now })); } catch (e) { /* best effort */ }
    log('  [pause] the pause ended: new entries allowed again.');
    journalManage('MANUAL_RESUME', 'Your pause ended: new entries are allowed again.', { by: 'expiry' });
    notifyPhone('Pause ended', 'New entries are allowed again.', { tags: 'arrow_forward' });
    return true;
  }
  // 10/16 phone Control tab: the switches and live state of every entry guard (display only; reads CONFIG and in-memory state, never the broker)
  function controlsView(now = Date.now()) {
    const cd = d => { const r = stopOuts && stopOuts[d]; return r && now < r.until ? { dir: d, until: r.until, win: !!r.win, ...(r.winFloorMin ? { winFloorMin: r.winFloorMin } : {}) } : null; };
    const active = [cd(1), cd(-1)].filter(Boolean);
    return {
      noChase: { on: !!CONFIG.noChase, atr: CONFIG.noChaseAtr, mode: CONFIG.noChaseMode, last: lastNoChase ? { t: lastNoChase.t, dir: lastNoChase.dir, text: lastNoChase.text, eAtr: lastNoChase.eAtr ?? null } : null },
      lossCooldown: { on: !!CONFIG.reentryCooldown, active: active.filter(a => !a.win) },
      winCooldown: { on: !!CONFIG.reentryCooldownAfterWin, scope: CONFIG.reentryCooldownScope, active: active.filter(a => a.win) },
      pendingExpireMin: Math.round(CONFIG.pendingExpireMs / 60000), stopTouch: !!CONFIG.pendingCancelOnStopTouch,
      slipGuard: CONFIG.fillSlipGuard ? { on: !!CONFIG.fillSlipGuard.enabled, minPts: CONFIG.fillSlipGuard.minPts, frac: CONFIG.fillSlipGuard.frac } : { on: false },
      news: { on: !!CONFIG.newsAware, waitAfter: !!CONFIG.newsWaitAfter, cancelSec: CONFIG.newsCancelRestingSec },
      h4: (CONFIG.tfMode && CONFIG.tfMode.h4) || 'ema', h4ApplyToMac: CONFIG.tfModeApplyToMac !== false,
      l3: CONFIG.profitTrail ? { on: !!CONFIG.profitTrail.enabled, arm: CONFIG.profitTrail.armDollars, lock: CONFIG.profitTrail.lockDollars, step: CONFIG.profitTrail.stepDollars, unit: CONFIG.profitLockUnit === 'points' ? 'points' : 'dollars', pts: CONFIG.profitLockPts ? { ...CONFIG.profitLockPts } : null } : { on: false },
      // 10/18 rules (phone Control tab)
      risk: (() => { try { return riskView(now); } catch (e) { return null; } })(),
      trend: (() => { try { return trendView(now); } catch (e) { return null; } })(),
      bans: (() => { try { return bansView(now); } catch (e) { return null; } })(),
      asiaBlackout: CONFIG.asiaBlackout !== false,
      dayBlocked: !!dayBlocked, blackout: (() => { try { return blackoutReason(now); } catch (e) { return null; } })(),
      session: (() => { try { return sessionView(now); } catch (e) { return null; } })(),   // 10/17 session close tile
      // round 4: MAC A/B intrabar-only timing and the far-limit switch (phone tiles)
      macTiming: { allow: Array.isArray(CONFIG.intrabarAllowMacGrades) ? CONFIG.intrabarAllowMacGrades.slice() : [], closeBlocked: Array.isArray(CONFIG.macIntrabarOnlyGrades) ? CONFIG.macIntrabarOnlyGrades.slice() : [], gradeBBlock: !!CONFIG.blockMacGradeB, intrabarMode: CONFIG.evaluationMode === 'intrabar-1m' },
      farLimit: { on: !!CONFIG.farLimitSwitch, atr: CONFIG.farLimitAtr, stops: CONFIG.farLimitIncludeStops === true, noChaseExempt: Array.isArray(CONFIG.noChaseExemptMacGrades) ? CONFIG.noChaseExemptMacGrades.slice() : [], last: lastFarSwitch ? { ...lastFarSwitch } : null },
    };
  }
  // ROUND 5 (owner answer O4, 10/14): MAC A/B signals SEEN mid-bar (evaluated intrabar while flat or while a Levels order rests; traded OR blocked by a guard), by
  // 15m bar and direction. At that bar's close such a signal is not taken again (MAC_INTRABAR_ONLY); one FIRST seen at the close is traded (MAC_CLOSE_FIRST_SEEN).
  // In memory only: a restart mid-bar forgets what was seen in that bar.
  let macSeen = {};
  const macSeenStartBar = Math.floor(Date.now() / 900000);   // the bar the bot started in: treat as "seen" (a restart forgets mid-bar history) - QA r5 C1
  let seenCandidate = null;   // 10-18b2a: { refT, dir } of this evaluation's mid-bar MAC signal; marked seen only when takeEntry() sends its order
  function noteMacSeen(refT, dir) { if (dir !== 1 && dir !== -1 || !Number.isFinite(refT)) return; const b = Math.floor(refT / 900000); macSeen[b + '|' + dir] = true; for (const k of Object.keys(macSeen)) if (Number(k.split('|')[0]) < b - 4) delete macSeen[k]; }
  function macSeenIntrabar(refT, dir) { return Number.isFinite(refT) && (Math.floor(refT / 900000) === macSeenStartBar || !!macSeen[Math.floor(refT / 900000) + '|' + dir]); }
  let lastFarSwitch = null;     // round 4 far-limit switch: { t, dir, limit, px, pts, atrX, grade, pending } of the last switch (phone tile)
  let lastNoChase = null;       // 10/16 no-chase: { key (dir|swing time), t, dir, text } of the last skipped chase (log once per leg; phone reason line)
  let lastSessionLog = null;    // 10/17 session close: log once per day
  let lastCooldownLogKey = '';  // so a blocked signal logs once per cooldown, not every 20 s poll
  // ENTRY-FIX state (in memory; a restart clears it)
  let lastEntryAttemptAt = 0;                       // when an entry order was last about to be sent (any path)
  const guardLogged = {};                           // reason -> last time logged / alerted
  // Broker-position guard (LIVE only). Returns null when entering is allowed, else the reason (already logged; one phone alert per reason per 10 min).
  async function entryGuard(label) {
    if (!LIVE || !CONFIG.entryGuard) return null;
    const now = Date.now();
    const note = (reason, alert) => {
      const k = label + '|' + reason.slice(0, 40);
      if (!guardLogged[k] || now - guardLogged[k] > 600000) {
        guardLogged[k] = now;
        log(`  [entry-guard] ${label} REFUSED: ${reason}`);
        if (alert) notifyPhone('Entry refused by the broker guard', `${label}: ${reason}. No order was sent.`, { priority: 'high', tags: 'no_entry_sign' });
      }
      return reason;
    };
    if (entryHoldActive(CONFIG, lastEntryAttemptAt, now)) return note(`another entry was attempted ${Math.round((now - lastEntryAttemptAt) / 1000)} s ago (hold ${CONFIG.entryAttemptHoldMs / 1000} s)`, false);
    let pos, orders = [];
    // 10-18b2a (PDL-fade exam 10/16: 3 refusals in 10 min, one a MAC grade-A short, each from ONE failed read): the read is retried up to
    // entryGuardReadRetries times (entryGuardRetryMs between tries) before refusing. Still FAIL-CLOSED: if every try fails, the entry is refused as before.
    const tries = 1 + Math.max(0, Math.floor(Number(CONFIG.entryGuardReadRetries) || 0)), waits = Array.isArray(CONFIG.entryGuardRetryMs) ? CONFIG.entryGuardRetryMs : [];
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, Number(waits[Math.min(i - 1, waits.length - 1)]) || 500));
      try {
        pos = await getOpenPosition(token, account.id, contractId);
        orders = CONFIG.entryGuardBlockOnWorkingOrders ? await getOpenOrders(token, account.id, contractId) : [];
        lastErr = null; break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) { const e = lastErr; brokerGuardView = { t: now, reason: 'broker position/orders could not be read (' + e.message + ')' }; return note('broker position/orders could not be read' + (tries > 1 ? ` after ${tries} tries` : '') + ' (' + e.message + ')', false); }
    const why = brokerGuardReason(CONFIG, pos, orders, symbol);
    brokerGuardView = { t: now, reason: why };   // FIX1015 checklist row
    return why ? note(why, true) : null;
  }
  // ── FIX1015 checklist rows for the entry gates outside decideSignal() (display only: nothing here decides or sends anything) ──
  let brokerGuardView = null;           // { t, reason|null }: the broker guard's last read, by entryGuard() itself or by refreshBrokerGuardView() below
  let checklistEvalIntrabar = false;    // set by checkForNewEntry(): is the evaluation being journaled an intrabar poll (MAC-sourced signals wait for the 15m close)
  let checklistEvalAt = null;           // ... and when it started: its journal rows judge the 45-s hold as the gate saw it then (not the hold its own entry starts)
  // While flat (LIVE, guard on): re-read the broker the same way entryGuard() does, at most once a minute, so the checklist row shows what would refuse an entry now.
  async function refreshBrokerGuardView(nowTs = Date.now()) {
    if (!LIVE || !CONFIG.entryGuard || !isFlat() || (brokerGuardView && nowTs - brokerGuardView.t < 60000)) return;
    try {
      const pos = await getOpenPosition(token, account.id, contractId);
      const orders = CONFIG.entryGuardBlockOnWorkingOrders ? await getOpenOrders(token, account.id, contractId) : [];
      brokerGuardView = { t: nowTs, reason: brokerGuardReason(CONFIG, pos, orders, symbol) };
    } catch (e) { brokerGuardView = { t: nowTs, reason: 'broker position/orders could not be read (' + e.message + ')' }; }
  }
  // Rows for the re-entry cooldown, the 45-second hold, the broker guard and a resting entry order; each reads the state the entry path reads.
  function hiddenGateRows(nowTs, result, evalAt = nowTs) {
    const rows = [], hm = t => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' PT';
    const dname = d => (d === 1 ? 'LONG' : 'SHORT');
    if (CONFIG.reentryCooldown || CONFIG.reentryCooldownAfterWin) {
      const recs = [1, -1].map(d => reentryBlockedBy(CONFIG, stopOuts, d, nowTs)).filter(Boolean);
      const b = result ? reentryBlockedBy(CONFIG, stopOuts, result.dir, nowTs) : null;
      rows.push({ key: 'reentryCooldown', label: CONFIG.reentryCooldownAfterWin ? (CONFIG.reentryCooldownScope === 'both' ? `Cooldown: no new trades until this ${cooldownTfLabel(CONFIG)} candle closes (after wins and losses, both directions${Number(CONFIG.reentryWinMinMinutes) > 0 ? `; after a win at least ${Math.min(120, Number(CONFIG.reentryWinMinMinutes))} min` : ''})` : `Cooldown: no new trade in the same direction until this ${cooldownTfLabel(CONFIG)} candle closes (after wins and losses)`) : 'Re-entry cooldown after a stop-out', pass: result ? !b : null,
        detail: b ? (b.win ? `Blocked: the ${dname(b.tradeDir ?? b.dir)} trade closed (win) at ${hm(b.t)}; no new ${dname(b.dir)} until ${b.winFloorMin ? `${b.winFloorMin} min after the win, at` : `the ${cooldownTfLabel(CONFIG)} candle closes at`} ${hm(b.until)}${CONFIG.reentryCooldownScope === 'both' ? '' : ' (the opposite side is allowed)'}`
          : b.tradeDir != null && b.tradeDir !== b.dir ? `Blocked: the ${dname(b.tradeDir)} trade closed (loss) at ${hm(b.t)}; no new trade either way until the ${cooldownTfLabel(CONFIG)} candle closes at ${hm(b.until)}`
          : `Blocked: the ${dname(b.dir)} was stopped out (${b.kind}) at ${hm(b.t)}; no new ${dname(b.dir)} until the ${cooldownTfLabel(CONFIG)} close at ${hm(b.until)}${CONFIG.reentryCooldownAfterWin && CONFIG.reentryCooldownScope === 'both' ? '' : ' (the opposite side is allowed)'}`)
          : recs.length ? `${result ? `${dname(result.dir)} allowed; ` : ''}${recs.map(r => `${dname(r.dir)} blocked until ${hm(r.until)}`).join(', ')}` : 'No cooldown running' });
    }
    if (LIVE && CONFIG.entryGuard && CONFIG.entryAttemptHoldMs > 0) {
      const hold = lastEntryAttemptAt < evalAt && entryHoldActive(CONFIG, lastEntryAttemptAt, evalAt);
      rows.push({ key: 'entryHold', label: `${Math.round(CONFIG.entryAttemptHoldMs / 1000)}-second entry hold`, pass: !hold,
        detail: hold ? `Another entry was attempted ${Math.round((evalAt - lastEntryAttemptAt) / 1000)} s ago; next attempt allowed in ${Math.ceil((CONFIG.entryAttemptHoldMs - (evalAt - lastEntryAttemptAt)) / 1000)} s` : 'OK (no entry attempt in the hold window)' });
    }
    if (LIVE && CONFIG.entryGuard) {
      const v = brokerGuardView;
      rows.push({ key: 'brokerGuard', label: `Broker guard (no ${symbol} position${CONFIG.entryGuardBlockOnWorkingOrders ? ' or working order' : ''} at the broker)`, pass: v ? !v.reason : null,
        detail: !v ? 'Not read yet (read at least once a minute while flat)' : `${v.reason ? 'Blocked: ' + v.reason : `Broker flat${CONFIG.entryGuardBlockOnWorkingOrders ? `, no working ${symbol} orders` : ''}`} (read ${Math.max(0, Math.round((nowTs - v.t) / 1000))} s ago)` });
    }
    rows.push({ key: 'directionGate', label: 'Trend / control entry filter', pass: null,
      detail: 'Removed by owner; not an entry gate. Separate risk, stop, freshness, no-chase and 15m control checks remain.' });
    if (CONFIG.sameLevelBan) { const act = levelBans.filter(b => b.until > nowTs);
      if (act.length) rows.push({ key: 'levelBan', label: 'Not a banned level (stopped / cancelled this 15m candle)', pass: result ? !act.some(b => b.dir === result.dir) : null, detail: act.map(b => `${dname(b.dir)} ${b.price != null ? b.price.toFixed(2) : ''}${b.levelName ? ' (' + b.levelName + ')' : ''} banned until ${hm(b.until)}`).join(', ') }); }
    if (riskCapOn()) rows.push({ key: 'riskCap', label: `$${CONFIG.maxRiskPerTradeUsd} max loss per trade (size by the stop)`, pass: null,
      detail: `${CONFIG.baseContracts}x up to a ${r2_18(CONFIG.maxRiskPerTradeUsd / CONFIG.baseContracts / pointValue)}-pt stop, 1x up to ${maxStopPtsForOneLot(CONFIG.maxRiskPerTradeUsd, pointValue, CONFIG.riskSizingSlipPts)} pts, wider = skipped${lastSizing && nowTs - lastSizing.t < 15 * 60000 ? ' · last: ' + lastSizing.text : ''}` });
    if (reclaimWatch) rows.push({ key: 'reclaimWatch', label: 'Reclaim watch after a stop-out', pass: null, detail: `${dname(reclaimWatch.dir)} stopped at ${reclaimWatch.stop.toFixed(2)} (${hm(reclaimWatch.t)}): ${reclaimWatch.lastWhy || 'watching'}; ends ${hm(reclaimWatch.t + (CONFIG.reclaimWindowMin || 60) * 60000)}` });
    if (pausedUntil && nowTs < pausedUntil) rows.push({ key: 'manualPause', label: 'Not paused by you', pass: false, detail: `Paused by you until ${hm(pausedUntil).replace(/:\d\d (AM|PM)/, ' $1')} (Resume on the phone)` });   // 10/16
    const resting = LIVE ? stateMachine.phase === 'PENDING_ENTRY' : !!pending;
    const rd = LIVE ? stateMachine.dir : pending && pending.dir, rp = LIVE ? stateMachine.intendedEntryPrice : pending && pending.entryPrice, rt = LIVE ? stateMachine.entrySignalTime : pending && pending.signalTime;
    rows.push({ key: 'restingEntry', label: 'No resting entry order blocking new signals', pass: !resting,
      detail: resting ? `A resting ${rd != null ? dname(rd) : ''} entry order${rp != null ? ` @ ${Number(rp).toFixed(2)}` : ''}${rt ? ` (placed ${hm(rt)}${CONFIG.pendingExpireMs ? `, expires ${hm(rt + CONFIG.pendingExpireMs)}` : ''}${CONFIG.pendingCancelOnStopTouch ? ', or if price reaches the stop or TP1' : ''})` : ''} blocks every new signal, either direction, until it fills, expires or is cancelled` : 'None resting' });
    return rows;
  }
  // ── 10/18 RISK RULES (begin) ── (owner order 10/15 "implement now; backtest later"; every rule ON with a one-line off switch; pure math in lib/riskRules.js + lib/controlFilter.js)
  // In memory only (a restart forgets a ban / a reclaim watch: then nothing is re-entered, the safe side).
  let lastSizing = null;          // RULE 1: the last size decision { t, dir, contracts, stopPts, riskUsd, cap, skip, text, source, grade, entryType, path }
  let ctlBars = null;             // RULES 4/6 + trend + wave: the bars of the latest evaluation { H1, H4, M3, M5, M15, at } (at = when they were read)
  const lastGate = { 1: null, '-1': null };   // the last direction-gate result per direction (phone / journal)
  let levelBans = [];             // RULE 5: [{ dir, price, levelName, t, until, why }]
  let reclaimWatch = null;        // RULE 6: { dir, stop, entry, t, until, extreme, used, target2, source, grade, journalId, levelName, lastCode, lastWhy }
  let lastReclaim = null;         // RULE 6: the last reclaim re-entry (phone)
  let sizeIntent = null;          // lv1 r13.3.3 SIZE_PARTIAL: { journalId, contracts, source, entryType, planPath, dir } of the order takeEntry() just sent (journal only)
  let lastEntryPlan = null;       // the plan of the trade takeEntry() just placed (read by the ban / reclaim when that trade closes)
  let lastWaveTriggerT = 0;       // wave trigger mode: the 5m candle already acted on
  const gateLogged = new Map();
  const r2_18 = x => Math.round(x * 100) / 100;
  // lv1 r13.3.7: the day-type context now (log only): the latest evaluation's 1H bars, the given price or the bot's last price; never throws
  function dayContextNow(dir, price) {
    try { let last = null; try { last = lastKnownClose; } catch (e) { last = null; }
      return dayContextMac(dayContext({ h1: ctlBars && ctlBars.H1, m5: ctlBars && ctlBars.M5, m15: ctlBars && ctlBars.M15, readAt: dcBarsReqAt, price: Number.isFinite(price) ? price : last, at: Date.now(), dir })); }
    catch (e) { return { v: DC_VERSION, error: String(e && e.message || e) }; }
  }
  // lv1 r13.3.7d (LOG ONLY): Mac's trend-day fields (dayTypeMac / pdRangeMac / htfBreak, petMacContext) added to a context row; never throws (an error = macError)
  function dayContextMac(c) {
    try {
      if (!c || typeof c !== 'object' || c.error || !Number.isFinite(c.at)) return c;
      let al = 0; try { al = levelEvent.alignDir(entryControlBoard || lastLv, levelEvent.alignRequired(CONFIG)); } catch (e) { al = 0; }
      let hb = null; try { hb = journalBars; } catch (e) { hb = null; }
      Object.assign(c, petMacContext({ bars: ctlBars || {}, htf: hb || {}, price: c.price, at: c.at, readAt: petBarsReqAt, alignDir: al }));
    } catch (e) { try { c.macError = String(e && e.message || e); } catch (_) { /* log only */ } }
    return c;
  }
  dayCtxHook = dayContextNow;
  function noteControlBars(htf) { if (htf) ctlBars = { H1: htf.H1 || null, H4: htf.H4 || null, M3: htf.M3 || null, M5: htf.M5 || null, M15: htf.M15 || null, M30: htf.M30 || null, at: Date.now() }; }
  let lastReversal = null;        // RULE X: { t, dir, context, ok, why, rsi } (phone "Reversal watch")
  let lastReversalSwingT = 0;     // RULE X: the swing extreme already acted on
  async function reversalStep() {
    if (!CONFIG.exhaustionReversal || CONFIG.levelsOnlyEntries || !ctlBars) return null;   // lv1 r2: no non-level entry path under levels-only
    let tr = null; try { tr = trendState({ now: ctlNow(), bars: ctlBars, cfg: CONFIG }); } catch (e) { return null; }
    const reg = tr && tr.known ? tr.regime : null; if (reg !== 'DOWN' && reg !== 'UP') { lastReversal = null; return 'no-trend'; }
    const dir = reg === 'DOWN' ? 1 : -1;
    let px = null; try { px = livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose; } catch (e) { px = lastKnownClose; }
    let x; try { x = exhaustionReversalCheck({ dir, now: ctlNow(), bars: ctlBars, cfg: CONFIG, px, tick: tickSize || 0.25 }); } catch (e) { log('  [reversal] check failed (not trading): ' + e.message); return null; }
    lastReversal = { t: Date.now(), dir, context: x.context, ok: x.ok, why: x.why, rsi: x.rsi, regime: reg };
    if (!x.ok) return x.context ? 'watch' : 'no-context';
    if (!isFlat()) return 'not-flat';
    if (x.swing && x.swing.t === lastReversalSwingT) return 'done';
    if (!Number.isFinite(px) || !Number.isFinite(x.stop) || (dir === 1 ? x.stop >= px : x.stop <= px)) return 'stop-wrong-side';   // QA-A D1 (10/15): belt and braces
    const blk = entryWindowBlock(Date.now()); if (blk) { journalBlock('REVERSAL_SKIP', dir, { why: `exhaustion reversal qualified but new entries are blocked (${blk})`, reasonKey: 'blocked|' + blk }); return 'blocked'; }
    if (!entryControlAllowed(dir, 'reversal', 'reversal', 'reversal-qualified', entryControlBoard, x.swing?.t)) return 'control-blocked';
    lastReversalSwingT = x.swing ? x.swing.t : Date.now();
    const rvFloor = floorEntryStop(dir, px, { stopPrice: x.stop, tightStopPrice: null }, 'MARKET', { rawStop: x.stop }), rvStop = rvFloor.stopPrice;   // entry stop floor BEFORE sizing
    const stopPts = Math.abs(px - rvStop), sig = { dir, source: 'reversal', grade: 'X' }, contracts = sizeForStop(stopPts, sig);
    if (!contracts) return riskCapSkip(lastMac, lastLv, sig, stopPts, { entryType: 'MARKET', entry: px, stop: rvStop, path: 'reversal' });
    noteSizing(dir, contracts, stopPts, { source: 'reversal', grade: 'X', entryType: 'MARKET', path: 'reversal' });
    const txt = `Exhaustion reversal ${dir === 1 ? 'LONG' : 'SHORT'} in a ${reg} regime: ${x.why}. ${contracts}x at market ~${px.toFixed(2)}, the whole position exits at ${x.target.toFixed(2)} (no runner).`;
    log('SIGNAL: ' + txt);
    appendJournal({ type: 'reversal', code: 'REVERSAL_ENTRY', t: Date.now(), dir, text: txt, px, stop: rvStop, structuralStop: x.stop, target: x.target, rr: x.rr, rsi: x.rsi, engulf: x.engulf, clouds: x.clouds, swing: x.swing, vwap: x.vwap, lowerHigh: x.lowerHigh, contracts, regime: reg });
    notifyPhone(`Signal: ${dir === 1 ? 'LONG' : 'SHORT'} exhaustion reversal (${contracts}x)`, txt, { tags: 'arrows_counterclockwise' });
    await takeEntry(dir, 'MARKET', px, rvStop, x.target, x.target, 'reversal', 'X', null, contracts, { isIntrabar: true, reversal: true, fullExit: true, stopFloor: rvFloor.stopFloor },
      { path: 'reversal', entryWhy: txt, stopBasis: { kind: 'reversal', rawStop: x.stop }, stopEntryRef: px, stopFloor: rvFloor.stopFloor, target1Points: Math.abs(x.target - px), t2BasisPoints: Math.abs(x.target - px), structTarget: null, t2Multiple: 1, asiaStruct: null, goalUsd: null, offPeak: false, mac: lastMac || {}, lv: lastLv || {}, sig, refPrice: px, reversal: { rsi: x.rsi, engulf: x.engulf, clouds: x.clouds, rr: x.rr } });
    return 'entered';
  }
  // the evaluation time for bar-based decisions: never later than the bars were read (a forming candle read mid-bar is never taken for a closed one)
  function ctlNow() { const n = Date.now(); return ctlBars && Number.isFinite(ctlBars.at) ? Math.min(n, ctlBars.at) : n; }
  // RULES 4 + trend + wave: the direction gate for an entry in `dir` at price px. null when every filter is off.
  // 10-18b2a NO-CHASE EXEMPTIONS (Mac's b2 ruling Q3): C2 = a with-trend MARKET entry the momentum path admitted (gateNow, < 5 s ago);
  // C3 = a resting level entry whose order sits within the near band of its level (band = max(entryNearPts, entryNearAtr1h x 1H ATR)). The 38.2% term itself is unchanged.
  function nearBandPts() { const a = lastLv && Number.isFinite(lastLv.atrRef) ? lastLv.atrRef : null; return Math.max(Number(CONFIG.entryNearPts) || 0, a != null ? (Number(CONFIG.entryNearAtr1h) || 0) * a : 0); }
  function noChaseExemptB2a(dir, entryType, entryPrice, source, signalContext) {
    if (CONFIG.noChaseExemptMomentum && entryType === 'MARKET') { const m = lastGate[dir] && lastGate[dir].momentum; if (m && Date.now() - m.t < 5000) return { kind: 'momentum-' + m.kind }; }
    if (CONFIG.noChaseLevelNearExempt && entryType !== 'MARKET' && signalContext && signalContext.levelContext) {
      const lvl = lastLv && lastLv.inPlayLevel && lastLv.inPlayLevel.name === signalContext.levelContext.name && Number.isFinite(lastLv.inPlayLevel.price) ? lastLv.inPlayLevel.price : null;
      const band = nearBandPts();
      if (lvl != null && Math.abs(entryPrice - lvl) <= band) return { kind: 'near-level', level: lvl, band: Math.round(band * 100) / 100, distPts: Math.round(Math.abs(entryPrice - lvl) * 100) / 100 };
    }
    return null;
  }
  function gateNow(dir, px, opts = {}) {
    // Removed entry veto. Legacy calculation is context ONLY for the existing no-chase
    // momentum exemption; neither a negative result nor an exception can veto an entry.
    let context = null;
    try {
      context = directionGate({ dir, now: ctlNow(), bars: ctlBars || {}, cfg: { ...CONFIG, ...REMOVED_FILTER_CONTEXT },
        px: Number.isFinite(px) ? px : null, skipWave: !!opts.skipWave, entryType: opts.entryType || null, source: opts.source || null, grade: opts.grade || null });
    } catch (e) { /* Missing context grants no momentum exemption, never a direction veto. */ }
    lastGate[dir] = { t: Date.now(), ok: true, removed: true, code: null, why: 'Trend / control entry filter removed',
      momentum: context && context.ok && context.wave && context.wave.momentum ? { ...context.wave.momentum, t: Date.now() } : null };
    return null;
  }

  // blocks (journal CONTROL_FILTER / TREND_FILTER / WAVE_WAIT with the numbers) and returns the gate, or null when allowed
  function gateBlock(dir, px, info = {}) {
    const g = gateNow(dir, px, info); if (!g || g.ok) return null;
    const t = g.trend || {}, c = g.control || {}, key = `${g.code}|${dir}|${Math.floor(Date.now() / 300000)}`;
    if (!gateLogged.has(key)) { gateLogged.set(key, 1); if (gateLogged.size > 300) gateLogged.delete(gateLogged.keys().next().value); log(`  [${g.code === 'CONTROL_FILTER' ? 'control' : g.code === 'WAVE_WAIT' || g.code === 'PULLBACK_VOID' ? 'wave' : 'trend'}] ${dir === 1 ? 'LONG' : 'SHORT'}${info.entryType ? ' ' + info.entryType : ''} @ ${Number.isFinite(px) ? px.toFixed(2) : '?'} skipped: ${g.text}`); }
    journalBlock(g.code, dir, { source: info.source, grade: info.grade, entryType: info.entryType || null, entry: Number.isFinite(px) ? px : null, path: info.path || null, why: g.text,
      regime: t.regime ?? null, ripster: t.ripster ?? null, cloud1h: t.cloud1h ?? null, cloud4h: t.cloud4h ?? null, dayType: t.dayType ?? null, pdh: t.pdh ?? null, pdl: t.pdl ?? null, inside4h: t.inside4h ?? null, prev4h: t.prev4h ?? null,
      session: c.session ?? null, controlTf: c.tf ?? null, controlOpen: c.open ?? null, acceptTf: c.acceptTf ?? null, acceptClose: c.close ?? null, distPts: c.distPts ?? null, bufferPts: c.buffer ?? 0,
      wave: g.wave ? { structure: !!g.wave.structure, lowerHighs: g.wave.lowerHighs ?? null, swingLow: g.wave.swingExt ?? null, priorHigh: g.wave.prior ?? null, atr: g.wave.atr ?? null } : null,
      pullback: g.wave && g.wave.pullback && g.wave.pullback.applies ? { refT: g.wave.pullback.ref.t, refClose: g.wave.pullback.ref.c, size: g.wave.pullback.size, zone: g.wave.pullback.zone, voidLevel: g.wave.pullback.voidLevel, voided: g.wave.pullback.voided, rejection: g.wave.pullback.rejection, confluence: g.wave.pullback.confluence } : null, reclaimCheck: g.counter ? g.counter.text : null, reasonKey: g.code });
    return g;
  }
  // RULE 1
  // ENTRY STOP FLOOR helpers. entryFloorAt(ts): the floor for a fill at ts (fill-relative; the state machine and the paper fill call it).
  // entryFloorPlan(entryType, ts): the LARGEST floor over every instant this order can fill (MARKET: 60 s; LIMIT/STOP: pendingExpireMs + 60 s), so a resting
  // order that fills after 06:30 was already sized and thresholded for 50. floorEntryStop(): the planned stop (and the smart-hold tight reference) moved out.
  function entryFloorAt(ts) { return stopFloor.floorAt(ts, CONFIG.entryStopFloor, t => ptInfo(t).minutesOfDay); }
  // r2 (MacDot 6330538954 #2): the window is the ACTUAL transport lifetime. A MARKET entry is sent as a resting marketable LIMIT when marketableLimitBufferPoints > 0
  // (the state machine's conversion), so only a true MARKET gets 60 s; anything resting gets pendingExpireMs + 60 s. The state machine re-checks it at final submit.
  // r4 (MacDot 6330946390 #1): expiry OFF (pendingExpireMs 0/null, which the state machine treats as never expiring) = an unbounded resting life: plan over 24 h,
  // i.e. every reachable session's floor (the largest), never 60 s.
  // lv1 r13.6.2 STOP CAP FROM THE FILL (LIVE): runs after every tick. Once the FSM has the fill and its protection rests (LEG1_OPEN, before TP1), a levels entry whose
  // intended stop is more than the cap from the ACTUAL fill (stateMachine.entryPrice) gets the capped stop through the FSM's verified replace. Broker picture first, as
  // the ladder audit: the position is this trade's full size before AND after the order list, and its own stop rests at that size; otherwise nothing now (a fill in
  // flight, a partial TP1 being resized, a missing stop the audit puts back) and the next poll looks again. The size is never touched. One trade_manage row
  // STOP_CAP_FROM_FILL per outcome (replaced / already-within / exited / not-replaced, retried with back-off / halted).
  const stopCap = { key: null, retryAt: 0, fails: 0, reported: false };
  // lv1 r13.6.2b STOP-CAP REPLACEMENT STATUS (MacDot 6494360892, BLOCKING; MacShip 6494458844). The FSM's replaceStopSafely returns { ok: true } as soon as the NEW stop
  // is accepted - also when the old stop's cancel then failed (cancelVerified's false is awaited, not returned: the old id goes to the FSM's staleStops after 3 tries,
  // or is not even remembered when its own order read failed). So the FSM's "ok" means "new protection accepted", never "old stop gone". The FSM is not changed (the
  // installed file; every other caller keeps its contract). Instead this step reads the broker's working orders after the replace: only an old id absent from them
  // is a completed, verified replacement ('replaced'). Anything else is 'replaced-old-pending': two stops may cover the same contracts, so the old one is handed to
  // the FSM's stale-stop sweep (re-cancelled every poll, also while flat, and confirmed against the working orders; the ladder audit then counts it as ours, and a
  // reversal it causes is provably ours). No other stop is ever placed for the trade, and the completion is journaled only once the working orders no longer hold
  // the old stop ('old-stop-gone').
  stopCap.pending = new Map(); stopCap.halted = false;
  // lv1 r13.6.2c DURABLE OWNERSHIP (MacDot 6496813651). Every old stop the cap leaves pending (after a replace or a market exit) is recorded in STOP_CAP_FILE -
  // a temp file written and fsynced, renamed over the store, the directory fsynced (the level-once discipline) - and leaves it only when the broker's working
  // orders no longer hold it. After a restart the recorded ids of THIS contract are claimed again for the FSM's stale-stop sweep, but only an order that is
  // still a working stop, is not one of the FSM's own resumed orders, and only while no position the bot does not manage is open and no so1 halt is latched;
  // otherwise it is held and reported. Never an unrecorded (manual) order, never a new stop. A store that cannot be read or written fails closed: no new cap
  // replacement until it is good again (the stop keeps resting), and a bad file is never overwritten.
  stopCap.store = { loaded: false, bad: null, unsaved: false, foreign: [] };
  function stopCapSave() {   // durable or it throws
    const entries = {};
    for (const f of stopCap.store.foreign) entries[f.oldId] = f;
    for (const p of stopCap.pending.values()) entries[p.oldId] = { oldId: p.oldId, contractId: p.contractId, dir: p.dir, fill: p.fill ?? null, n: p.n, oldStop: p.oldStop ?? null, newId: p.newId ?? null, newStop: p.newStop ?? null, kind: p.newStop != null ? 'replace' : 'exit', label: p.label, since: p.since, key: p.key ?? null };
    const tmp = STOP_CAP_FILE + '.tmp', fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify({ v: 1, entries }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, STOP_CAP_FILE);
    const dfd = fs.openSync(path.dirname(STOP_CAP_FILE), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
  function stopCapPersist(sm) {   // after every change; a failed save is retried every poll, and no new replacement is made meanwhile (fail closed)
    if (stopCap.store.bad) return false;   // never overwrite a store that could not be read
    try { stopCapSave(); if (stopCap.store.unsaved) { stopCap.store.unsaved = false; log(`  [lv1] STOP CAP: ${path.basename(STOP_CAP_FILE)} saved again.`); } return true; }
    catch (e) {
      if (!stopCap.store.unsaved) {
        stopCap.store.unsaved = true; const why = e && (e.code || e.message);
        log(`  [lv1] STOP CAP: could not save ${path.basename(STOP_CAP_FILE)} durably (${why}) - retried every poll; no new cap replacement until it is saved.`);
        try { sm._manage('STOP_CAP_FROM_FILL', `Stop cap from the fill: the record of the old stop(s) the cap still owns could not be saved durably (${why}); it is retried every poll, and no new cap replacement is made until it is saved.`, { version: 'stop-cap-from-fill-v1', broker: 'store-unsaved', why }); } catch (e2) { /* journal only */ }
        try { sm.notify('Stop cap: its record could not be saved', `${path.basename(STOP_CAP_FILE)} could not be written (${why}). The bot keeps retrying; until it is saved, a restart would forget an old stop that may still be working. Check the disk.`, { priority: 'high', tags: 'warning' }); } catch (e2) { /* alert only */ }
      }
      return false;
    }
  }
  function stopCapEntryOk(k, e) { return !!e && typeof e === 'object' && String(e.oldId) === k && /^\S{1,64}$/.test(k) && typeof e.contractId === 'string' && e.contractId.length > 0 && (e.dir === 1 || e.dir === -1) && Number.isInteger(e.n) && e.n > 0 && Number.isFinite(e.since); }
  function stopCapLoad() {   // { entries } | { bad }: only a file that does not exist is "nothing owned"
    let d;
    try { d = JSON.parse(fs.readFileSync(STOP_CAP_FILE, 'utf8')); } catch (e) { return e && e.code === 'ENOENT' ? { entries: [] } : { bad: e && e.code ? `unreadable (${e.code})` : 'corrupt (not JSON)' }; }
    if (!(d && d.v === 1 && d.entries && typeof d.entries === 'object' && !Array.isArray(d.entries))) return { bad: 'corrupt (not a v1 stop-cap store)' };
    const out = [];
    for (const [k, e] of Object.entries(d.entries)) { if (!stopCapEntryOk(k, e)) return { bad: `corrupt (entry ${JSON.stringify(k).slice(0, 60)})` }; out.push({ ...e, oldId: k }); }
    return { entries: out };
  }
  function stopCapInit(sm) {   // load the store once (at startup, or at the first step) and retry while it is bad; recorded ids become pending, not yet claimed
    if (stopCap.store.loaded && !stopCap.store.bad) return true;
    const L = stopCapLoad(), f = path.basename(STOP_CAP_FILE); stopCap.store.loaded = true;
    if (L.bad) {
      if (stopCap.store.bad !== L.bad) {
        stopCap.store.bad = L.bad;
        log(`  [lv1] STOP CAP STATE BAD: ${f} is ${L.bad} - no cap replacement until it reads good (the stops rest as they are; the file is left untouched). An old stop the cap owned may still be working: check the account.`);
        try { sm._manage('STOP_CAP_FROM_FILL', `Stop cap from the fill: its record ${f} is ${L.bad}. No cap replacement is made until it reads good, and the file is left as it is. An old stop the cap owned may still be working - check the account.`, { version: 'stop-cap-from-fill-v1', broker: 'store-bad', why: L.bad }); } catch (e) { /* journal only */ }
        try { sm.notify('Stop cap: its record is unreadable - check the account', `${f} is ${L.bad}. The stop cap makes no replacement until it reads good. An old stop it owned may still be working: check TopstepX for an extra stop order.`, { priority: 'urgent', tags: 'rotating_light' }); } catch (e) { /* alert only */ }
      }
      return false;
    }
    if (stopCap.store.bad) log(`  [lv1] STOP CAP: ${f} reads good again (${L.entries.length} recorded old stop(s)).`);
    stopCap.store.bad = null;
    for (const e of L.entries) {
      if (e.contractId !== String(contractId)) {   // another contract's: never touched here, kept in the store
        if (!stopCap.store.foreign.some(x => x.oldId === e.oldId)) { stopCap.store.foreign.push(e); log(`  [lv1] STOP CAP: ${f} records old stop ${e.oldId} for another contract (${e.contractId}) - left alone (check the account).`); }
        continue;
      }
      if (!stopCap.pending.has(e.oldId)) stopCap.pending.set(e.oldId, { ...e, recovered: true, armed: false, heldWhy: null });
    }
    return true;
  }
  function stopCapStoreReady(sm) { if (!stopCapInit(sm)) return false; if (stopCap.store.unsaved) stopCapPersist(sm); return !stopCap.store.unsaved; }
  async function stopCapRecoveredCheck(sm, p, open) {   // a recorded old stop from before a restart: claimed for the sweep only when cancelling it is safe
    const o = open.find(x => x && String(x.id) === p.oldId);
    if (!o) return 'gone';
    const base = { version: 'stop-cap-from-fill-v1', dir: p.dir, fill: p.fill, contracts: p.n, oldOrderId: p.oldId, oldStop: p.oldStop, recovered: true };
    if ([sm.stopOrderId, sm.leg3StopOrderId, sm.targetOrderId, sm.entryOrderId].some(x => x != null && String(x) === p.oldId)) {   // the FSM resumed it as its own order: it protects now
      stopCap.pending.delete(p.oldId); stopCapPersist(sm);
      try { sm._manage('STOP_CAP_FROM_FILL', `Stop cap from the fill: the recorded old stop ${p.oldId} is the order the bot resumed as its own after the restart, so it is not cancelled and is no longer recorded.`, { ...base, broker: 'old-stop-is-live' }); } catch (e) { /* journal only */ }
      log(`  [lv1] STOP CAP: recorded old stop ${p.oldId} is the bot's own resumed order - left resting, no longer recorded.`); return 'dropped';
    }
    let why = null;
    if (o.type !== OrderType.STOP) why = `order ${p.oldId} is not a stop order`;
    else if (sm._haltLatched || sm._so1HaltWhy) why = 'the so1 halt is latched (hands off until it is resolved)';
    else if (sm.desynced) why = "the bot is desynced from the broker's position";
    else if (!['LEG1_OPEN', 'LEG23_OPEN', 'LEG3_OPEN', 'FLATTENING'].includes(sm.phase)) {
      let pos; try { pos = await getOpenPosition(token, account.id, contractId); } catch (e) { pos = undefined; }
      if (pos === undefined) why = 'the position could not be read';
      else if (pos && pos.size) why = `a ${pos.size}x position the bot does not manage is open (the old stop may be its only stop)`;
    }
    if (why) {
      if (p.heldWhy !== why) {
        p.heldWhy = why; log(`  [lv1] STOP CAP: recorded old stop ${p.oldId} @ ${scFx(p.oldStop)} is still working but NOT cancelled: ${why}. Checked again every poll.`);
        try { sm._manage('STOP_CAP_FROM_FILL', `Stop cap from the fill: the recorded old stop ${p.oldId} @ ${scFx(p.oldStop)} is still working, but it is not cancelled yet: ${why}. It is checked again every poll.`, { ...base, broker: 'old-stop-held', why }); } catch (e) { /* journal only */ }
        try { sm.notify('Stop cap: an old stop it owned is still working', `Order ${p.oldId} @ ${scFx(p.oldStop)} is still working and was not cancelled: ${why}. Check TopstepX.`, { priority: 'urgent', tags: 'rotating_light' }); } catch (e) { /* alert only */ }
      }
      return 'held';
    }
    p.armed = true; p.heldWhy = null;
    try { sm._manage('STOP_CAP_FROM_FILL', `Stop cap from the fill: after the restart, the recorded old stop ${p.oldId} @ ${scFx(p.oldStop)} is still working; it is claimed again and re-cancelled every poll until the broker's working orders no longer hold it. No new stop is placed.`, { ...base, broker: 'old-stop-recovered', pendingSince: p.since }); } catch (e) { /* journal only */ }
    log(`  [lv1] STOP CAP: recorded old stop ${p.oldId} @ ${scFx(p.oldStop)} is still working after the restart - claimed again for the stale-stop sweep (no new stop).`);
    return 'armed';
  }
  const scFx = v => (Number.isFinite(v) ? Number(v).toFixed(2) : '?');
  async function stopCapOldStop(oldId) {   // the old stop against the broker's working orders: 'gone' | 'working' | 'unreadable'
    if (oldId == null) return 'gone';
    try { const os = await getOpenOrders(token, account.id, contractId); return (os || []).some(x => x && String(x.id) === String(oldId)) ? 'working' : 'gone'; } catch (e) { return 'unreadable'; }
  }
  function stopCapExposure(dir, n, flat, newStop, oldStop) {   // what the old stop can still do: with the position open, both stops cover the same n contracts
    const side = dir === 1 ? 'sold' : 'bought', after = dir === 1 ? 'SHORT' : 'LONG', kind = dir === 1 ? 'an over-sell' : 'an over-buy';
    const text = flat ? `The position is closed, so if the market reached the old stop ${scFx(oldStop)}, ${n} contracts would be ${side} - ${kind} that would leave the account ${after} ${n}x`
      : `Both stops (${n}x each) are working for the ${n}-contract position: if the market ${dir === 1 ? 'fell' : 'rose'} through both (${scFx(newStop)}, then ${scFx(oldStop)}), ${2 * n} contracts would be ${side} - ${kind} that would leave the account ${after} ${n}x`;
    return { text, data: { positionContracts: flat ? 0 : n, stopContractsWorking: flat ? n : 2 * n, ifAllFill: `${kind.slice(3)}: ${after} ${n}x` } };
  }
  function stopCapPend(sm, p) {   // hand the old stop to the FSM's stale-stop sweep and remember it until the working orders no longer hold it
    const id = String(p.oldId);
    if (sm.staleStops && !sm.staleStops.has(id)) sm.staleStops.set(id, { size: p.n, price: p.oldStop, label: p.label, since: Date.now(), tries: 0 });
    stopCap.pending.set(id, { ...p, oldId: id, contractId: String(contractId), since: Date.now() }); stopCapPersist(sm);   // lv1 r13.6.2c: durable from here on
  }
  async function stopCapReconcile(sm) {   // every poll while an old stop is pending: never a placement; the completion only from the broker's working orders
    if (stopCap.store.unsaved) stopCapPersist(sm);   // lv1 r13.6.2c: a failed save is retried every poll
    let open = null, out = 'old-pending';
    for (const p of [...stopCap.pending.values()]) {
      if (sm.staleStops && sm.staleStops.has(p.oldId)) continue;   // the FSM's sweep is still cancelling it (it drops the id only when the working orders no longer hold it)
      if (open === null) { try { open = (await getOpenOrders(token, account.id, contractId)) || []; } catch (e) { return 'old-unreadable'; } }
      if (p.recovered && !p.armed) { const h = await stopCapRecoveredCheck(sm, p, open); if (h === 'held' || h === 'dropped') { if (h === 'held') out = 'old-held'; continue; } }   // lv1 r13.6.2c: a recorded id from before a restart
      if (open.some(x => x && String(x.id) === p.oldId)) { if (sm.staleStops) sm.staleStops.set(p.oldId, { size: p.n, price: p.oldStop, label: p.label, since: Date.now(), tries: 0 }); continue; }   // out of the sweep (a reversal correction clears it) yet still working: back into it
      stopCap.pending.delete(p.oldId); out = 'old-stop-gone'; stopCapPersist(sm);   // lv1 r13.6.2c: out of the store only now
      try { sm._manage('STOP_CAP_FROM_FILL', `Stop cap from the fill: the old stop (${p.oldId} @ ${scFx(p.oldStop)}) is no longer in the broker's working orders (checked ${Math.round((Date.now() - p.since) / 1000)} s after ${p.newStop != null ? `the capped stop ${scFx(p.newStop)} was accepted` : 'the market exit'}), so no second stop is working any more.`,
        { version: 'stop-cap-from-fill-v1', broker: 'old-stop-gone', dir: p.dir, fill: p.fill, contracts: p.n, oldOrderId: p.oldId, oldStop: p.oldStop, orderId: p.newId, stopAfter: p.newStop, pendingSince: p.since, recovered: !!p.recovered }); } catch (e) { /* journal only */ }
      log(`  [lv1] STOP CAP FROM THE FILL: the old stop ${p.oldId} @ ${scFx(p.oldStop)} is gone from the broker's working orders - no second stop any more.`);
    }
    return out === 'old-pending' && !stopCap.pending.size ? 'old-none' : out;   // lv1 r13.6.2c: a record dropped as the FSM's own order leaves nothing pending
  }
  async function levelStopCapStep(sm = stateMachine) {
    const cap = CONFIG.levelStopMaxFromFillPts;
    if (!LIVE || !sm) return 'off';
    stopCapInit(sm);   // lv1 r13.6.2c: the durable store (loaded once; retried while it is bad)
    const rec = stopCap.pending.size ? await stopCapReconcile(sm) : null;   // lv1 r13.6.2b: an old stop not yet gone from the broker's working orders
    if (cap === null || !(Number.isFinite(cap) && cap > 0)) return rec || 'off';   // lv1 r13.6.2c: recorded old stops are reconciled whatever the setting
    if (sm.desynced || sm.phase !== 'LEG1_OPEN' || sm.source !== 'levels' || !Number.isFinite(sm.entryPrice) || !Number.isFinite(sm.stopPriceIntended)) return rec || 'n/a';
    const ff = sm._fillFloor && Number.isFinite(sm._fillFloor.pts) && sm._fillFloor.pts > 0 ? sm._fillFloor : null, floorPts = ff ? ff.pts : stopCapFloorMaxOf(CONFIG);
    const d = levelStopCapFromFill({ dir: sm.dir, fill: sm.entryPrice, stop: sm.stopPriceIntended, capPts: cap, floorPts, tickSize: sm.tickSize });
    if (!d) return rec || 'within';
    const key = `${sm.dir}|${sm.entryPrice}|${sm.contracts}|${sm.target1}`;   // this trade: a back-off belongs to it only
    if (stopCap.key !== key) Object.assign(stopCap, { key, retryAt: 0, fails: 0, reported: false, halted: false, storeReported: false });
    if ([...stopCap.pending.values()].some(p => p.key === key)) return 'old-pending';   // lv1 r13.6.2b: never a second replace for this trade while its old stop may still work
    if (Date.now() < stopCap.retryAt) return 'backoff';
    const n = sm.contracts; let p1, orders, p2;
    try { p1 = await getOpenPosition(token, account.id, contractId); orders = await getOpenOrders(token, account.id, contractId); p2 = await getOpenPosition(token, account.id, contractId); } catch (e) { return 'unreadable'; }
    if ((p1 ? p1.size : 0) !== n || (p2 ? p2.size : 0) !== n || sm.phase !== 'LEG1_OPEN' || sm.desynced) return 'size-mismatch';   // never on a moving picture
    const o = (orders || []).find(x => x && String(x.id) === String(sm.stopOrderId) && x.type === OrderType.STOP);
    if (!o || (o.size !== undefined && o.size !== n)) return 'not-resting';   // the ladder audit puts back a missing / wrong-size stop; the cap follows on a later poll
    const resting = Number.isFinite(o.stopPrice) ? o.stopPrice : Number.isFinite(o.price) ? o.price : null, fx = v => Number(v).toFixed(2);
    const base = { version: 'stop-cap-from-fill-v1', fill: sm.entryPrice, stopBefore: d.before, restingBefore: resting, beforePts: d.beforePts, wanted: d.stop, capPts: d.capPts, setting: d.setting, floorPts: d.floorPts, floorSession: ff ? ff.session || null : null, floorSource: ff ? 'fill' : 'largest-configured', contracts: n, sizedOn: 'the structural stop (unchanged; never sized up)' };
    const head = `Stop cap from the fill: the stop ${fx(d.before)} is ${d.beforePts} pts from the actual fill ${fx(sm.entryPrice)}, more than the ${d.capPts}-pt cap${d.capPts !== d.setting ? ` (${d.setting} raised to the ${d.floorPts}-pt floor)` : ''}`;
    const row = (code, text, extra) => { try { sm._manage(code, text, { ...base, ...extra }); } catch (e) { /* journal only */ } };
    if (resting != null && sm.dir * (resting - d.stop) >= -1e-9) {   // what rests is already at or inside the cap (the profit lock, a stop dragged by hand): only the intent moves
      sm.stopPriceIntended = d.stop; const saved = sm.saveState() !== false;
      row('STOP_CAP_FROM_FILL', `${head}; the resting stop ${fx(resting)} is already within it, so only the intended stop moves to ${fx(d.stop)} (${d.afterPts} pts). The size stays ${n}.`, { broker: 'already-within', stopAfter: d.stop, afterPts: d.afterPts, saved });
      log(`  [lv1] STOP CAP FROM THE FILL: the intended stop ${fx(d.before)} -> ${fx(d.stop)} (${d.afterPts} pts from the fill ${fx(sm.entryPrice)}); the resting ${fx(resting)} is already within it.`); return 'intent'; }
    if (!stopCapStoreReady(sm)) {   // lv1 r13.6.2c: fail closed - never leave behind an old stop the cap could not record durably
      if (!stopCap.storeReported) { stopCap.storeReported = true; row('STOP_CAP_FROM_FILL', `${head}; the stop cap's record (${path.basename(STOP_CAP_FILE)}) is ${stopCap.store.bad || 'not saved'}, so nothing is replaced: the stop keeps resting at ${fx(resting)} until the record is good again.`, { broker: 'not-replaced-store', store: stopCap.store.bad || 'unsaved' }); }
      return 'store-bad'; }
    const oldId = sm.stopOrderId, r = await sm.replaceStopSafely('stopOrderId', n, d.stop, lastKnownClose, resting, `stop capped at ${d.capPts} pts from the fill`);
    if (r && r.ok) {
      sm.stopPriceIntended = r.lvl; const saved = sm.saveState() !== false, afterPts = Math.round(sm.dir * (sm.entryPrice - r.lvl) * 100) / 100; stopCap.fails = 0;
      const old = await stopCapOldStop(oldId);   // lv1 r13.6.2b: the FSM's ok = the new stop accepted; only the broker's working orders say the old one is gone
      if (old !== 'gone') {
        stopCapPend(sm, { key, dir: sm.dir, fill: sm.entryPrice, n, oldId, oldStop: resting, newId: r.id ?? null, newStop: r.lvl, label: `previous stop capped at ${d.capPts} pts from the fill` });
        const ex = stopCapExposure(sm.dir, n, false, r.lvl, resting), how = old === 'working' ? "is still in the broker's working orders (its cancel is not confirmed)" : 'could not be checked (the working orders could not be read)';
        row('STOP_CAP_FROM_FILL', `${head}. The capped stop ${fx(r.lvl)} (${afterPts} pts) was accepted and protects the position, but the replacement is NOT complete: the old stop (${oldId} @ ${fx(resting)}) ${how}. ${ex.text}. The old stop is re-cancelled every poll and checked against the broker's working orders until it is gone; no other stop is placed. The size stays ${n}.`,
          { broker: 'replaced-old-pending', oldStop: old, exposure: ex.data, stopAfter: r.lvl, afterPts, orderId: r.id ?? null, oldOrderId: oldId ?? null, saved });
        log(`  [lv1] STOP CAP FROM THE FILL: the capped stop ${fx(r.lvl)} (${n}x) is accepted, but the OLD stop ${oldId} @ ${fx(resting)} ${old === 'working' ? 'is still working' : 'could not be checked'} - the replacement is NOT complete; it is re-cancelled every poll until the broker's working orders no longer hold it.`);
        try { sm.notify('Stop cap: the OLD stop may still be working', `${ex.text}. The bot keeps cancelling the OLD stop (@ ${fx(resting)}, order ${oldId}) every poll; if this alert stays, cancel the OLDER stop in TopstepX.`, { priority: 'urgent', tags: 'rotating_light' }); } catch (e) { /* alert only */ }
        return 'capped-old-pending'; }
      row('STOP_CAP_FROM_FILL', `${head}, so it now rests at ${fx(r.lvl)} (${afterPts} pts): the new stop was placed first, and the old one (${oldId}) is verified gone from the broker's working orders. The size stays ${n} (sized on the structural stop; never sized up).`, { broker: 'replaced', oldStop: 'gone', stopAfter: r.lvl, afterPts, orderId: r.id ?? null, oldOrderId: oldId ?? null, saved });
      log(`  [lv1] STOP CAP FROM THE FILL: the ${n}x stop ${fx(d.before)} (${d.beforePts} pts from the fill ${fx(sm.entryPrice)}) -> ${fx(r.lvl)} (${afterPts} pts), replaced (the old stop verified gone from the working orders); size unchanged.${saved ? '' : ' The trade state could not be saved yet (the next wrapped FSM call retries it).'}`); return 'capped'; }
    const oldX = r && r.exited ? await stopCapOldStop(oldId) : null;   // lv1 r13.6.2b: after a market exit the FSM cancels the old stop the same unverified way
    if (oldX && oldX !== 'gone') stopCapPend(sm, { key, dir: sm.dir, fill: sm.entryPrice, n, oldId, oldStop: resting, newId: null, newStop: null, label: `stop left after the market exit (cap ${d.capPts} pts)` });
    if (r && r.exited) { row('STOP_CAP_FROM_FILL', `${head}; the market was already through ${fx(d.stop)}, so the ${n} contracts were closed at market (what the capped stop would have done).${oldX === 'gone' ? ` The old stop (${oldId}) is verified gone from the broker's working orders.` : ` The old stop (${oldId} @ ${fx(resting)}) ${oldX === 'working' ? "is still in the broker's working orders" : 'could not be checked (the working orders could not be read)'}: ${stopCapExposure(sm.dir, n, true, null, resting).text}. It is re-cancelled every poll until the broker's working orders no longer hold it.`}`,
      { broker: 'exited', oldStop: oldX, oldOrderId: oldId ?? null, exposure: oldX === 'gone' ? null : stopCapExposure(sm.dir, n, true, null, resting).data }); log(`  [lv1] STOP CAP FROM THE FILL: the market was through ${fx(d.stop)} - ${n}x closed at market${oldX === 'gone' ? '' : `; the OLD stop ${oldId} @ ${fx(resting)} is not confirmed gone (re-cancelled every poll)`}.`); return oldX === 'gone' ? 'exited' : 'exited-old-pending'; }
    if (r && (r.halted || r.exitUnknown)) { if (!stopCap.halted) { stopCap.halted = true; row('STOP_CAP_FROM_FILL', `${head}; the replace stopped: ${r.halted ? 'the so1 halt is active' : 'a market exit was sent and its outcome is unknown (halted)'}. The bot changes nothing more.`, { broker: 'halted' }); } return 'halted'; }   // lv1 r13.6.2b (MacShip 6494458844): one row per trade, not one per poll
    stopCap.fails += 1; const wait = [5000, 15000, 60000, 180000, 300000][Math.min(stopCap.fails, 5) - 1]; stopCap.retryAt = Date.now() + wait;
    if (!stopCap.reported) { stopCap.reported = true; row('STOP_CAP_FROM_FILL', `${head}; the capped stop ${fx(d.stop)} was not accepted, so the old stop keeps resting at ${resting != null ? fx(resting) : '?'} (nothing loosened); retrying with back-off.`, { broker: 'not-replaced' }); }
    log(`  [lv1] STOP CAP FROM THE FILL: ${fx(d.stop)} not accepted - the old stop keeps resting; retry in ${Math.round(wait / 1000)} s.`); return 'not-replaced';
  }
  async function stopCapAfterTick() { try { await levelStopCapStep(); } catch (e) { log('  [lv1] stop cap from the fill failed (non-fatal; the old stop keeps resting; retried next poll): ' + e.message); } }
  function entryFloorWindow(resting, ts = Date.now()) { const life = !resting ? 0 : (Number.isFinite(CONFIG.pendingExpireMs) && CONFIG.pendingExpireMs > 0 ? CONFIG.pendingExpireMs : 24 * 3600000); return stopFloor.floorOverWindow(ts, ts + life + 60000, CONFIG.entryStopFloor, t => ptInfo(t).minutesOfDay); }
  function entryFloorPlan(entryType, ts = Date.now()) { return entryFloorWindow(entryType !== 'MARKET' || CONFIG.marketableLimitBufferPoints > 0, ts); }
  function floorEntryStop(dir, entryRef, held, entryType, capInfo = null) {
    const plan = entryFloorPlan(entryType), f = stopFloor.applyFloor({ dir, entry: entryRef, stop: held.stopPrice, floorPts: plan.pts, tickSize });
    const ft = held.tightStopPrice != null ? stopFloor.applyFloor({ dir, entry: entryRef, stop: held.tightStopPrice, floorPts: plan.pts, tickSize }) : null;
    const stopPrice = f.valid ? f.stop : held.stopPrice, tightStopPrice = ft ? (ft.valid ? ft.stop : held.tightStopPrice) : held.tightStopPrice;
    const geo = { version: stopFloor.VERSION, basis: 'planned entry at the signal (re-applied from the actual fill by the order machine)', entryRef, entryType,
      rawPts: capInfo && Number.isFinite(capInfo.rawStop) ? Math.round(Math.abs(entryRef - capInfo.rawStop) * 100) / 100 : null,
      capPts: capInfo && Number.isFinite(capInfo.capPts) ? Math.round(capInfo.capPts * 100) / 100 : null,
      naturalPts: f.naturalPts, floorPts: plan.pts, floorSession: plan.session, windowSessions: plan.sessions, floored: !!f.floored, finalPts: f.valid ? f.finalPts : f.naturalPts, finalStop: stopPrice };
    return { stopPrice, tightStopPrice, stopFloor: geo };
  }
  function riskCapOn() { return Number.isFinite(CONFIG.maxRiskPerTradeUsd) && CONFIG.maxRiskPerTradeUsd > 0; }
  function noteSizing(dir, contracts, stopPts, info = {}) {
    const slip = riskCapOn() && CONFIG.riskSizingSlipPts > 0 ? CONFIG.riskSizingSlipPts : 0, per = (stopPts + slip) * pointValue, cap = riskCapOn() ? CONFIG.maxRiskPerTradeUsd : null;
    lastSizing = { t: Date.now(), dir, contracts, stopPts: r2_18(stopPts), riskUsd: r2_18(per * contracts), perContractUsd: r2_18(per), cap, skip: !contracts, source: info.source || null, grade: info.grade || null, entryType: info.entryType || null, path: info.path || null,
      text: !cap ? `${contracts}x (risk cap off): stop ${stopPts.toFixed(1)} pts = $${Math.round(per * contracts)} at risk`
        : contracts ? `${contracts}x: stop ${stopPts.toFixed(1)} pts${slip ? ` + ${slip} slip` : ''} = $${Math.round(per * contracts)} at risk (cap $${cap})`
        : `skipped: stop ${stopPts.toFixed(1)} pts, 1 contract = $${Math.round(per)} > the $${cap} cap` };
    return lastSizing;
  }
  function riskCapSkip(mac, lv, sig, stopPts, info = {}) {
    const sizing = quantityForStop(stopPts, sig);
    if (sizing.reason === 'below-min-contracts') {   // lv1 size1 CONSISTENT SIZE: sized below 3 = skipped, never opened smaller; named on the phone's risk tile and in the journal
      const z = noteSizing(sig.dir, 0, stopPts, { source: sig.source, grade: sig.grade, ...info }); z.text = `skipped: ${sizing.minText}`;
      log(`  [size] ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${sig.source || ''} signal SKIPPED: ${sizing.minText} - minContracts 3: always 3 contracts or no trade.`);
      journalBlock('SIZE_BELOW_MIN', sig.dir, { source: sig.source, grade: sig.grade, entryType: info.entryType || null, entry: info.entry ?? null, stop: info.stop ?? null, stopPts: z.stopPts, minContracts: 3, sizedContracts: sizing.sizedContracts, sizedReason: sizing.sizedReason, needUsd: sizing.needUsd, cap: z.cap, reason: 'size-below-min', why: sizing.minText, path: info.path || null });
      try { journalSignalSnapshot(mac || lastMac, lv || lastLv, 'sat_out', { reason: sizing.minText, dir: sig.dir, source: sig.source, grade: sig.grade }); } catch (e) { /* journal only */ }
      return 'blocked';
    }
    if (sizing.reason === 'confidence-ineligible' || sizing.reason === 'invalid-sizing-input') {
      journalBlock('INITIAL_QUANTITY_SKIP', sig.dir, { source: sig.source, grade: sig.grade, sizing, path: info.path || null });
      return 'blocked';
    }
    const z = noteSizing(sig.dir, 0, stopPts, { source: sig.source, grade: sig.grade, ...info });
    log(`  [risk-cap] ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${sig.source || ''} signal SKIPPED: ${z.text}.`);
    journalBlock('RISK_CAP_SKIP', sig.dir, { source: sig.source, grade: sig.grade, entryType: info.entryType || null, entry: info.entry ?? null, stop: info.stop ?? null, stopPts: z.stopPts, oneLotRisk: z.perContractUsd, cap: z.cap, path: info.path || null });
    try { journalSignalSnapshot(mac || lastMac, lv || lastLv, 'sat_out', { reason: 'risk cap: ' + z.text, dir: sig.dir, source: sig.source, grade: sig.grade }); } catch (e) { /* journal only */ }
    return 'blocked';
  }
  // RULE 2: TP1 distance (firstScalePts, else the dollar goal with the 5-lot's leg-1 count as the floor) and TP2's distance basis (today's 5-lot TP1 distance)
  function tp1PointsFor(goalUsd, leg1Size) { return riskTarget1Points({ firstScalePts: CONFIG.scaleOutRunner?.enabled === true ? CONFIG.scaleOutRunner.atPts : CONFIG.firstScalePts > 0 ? CONFIG.firstScalePts : null, goalUsd, leg1Size, baseLeg1: legSplit(CONFIG.baseContracts, CONFIG).leg1, pointValue }); }
  function tp2BasisPoints(goalUsd) { return legacyTarget1Points({ goalUsd, baseLeg1: legSplit(CONFIG.baseContracts, CONFIG).leg1, pointValue }); }
  // RULE 5
  function levelBanAdd(dir, price, levelName, why, t = Date.now()) {
    if (!CONFIG.sameLevelBan || (dir !== 1 && dir !== -1) || !(Number.isFinite(price) || levelName)) return null;
    const ban = { dir, price: Number.isFinite(price) ? price : null, levelName: levelName || null, t, until: nextBarCloseMs(t), why };
    levelBans = levelBans.filter(b => b.until > t).concat([ban]);
    log(`  [level-ban] ${dir === 1 ? 'LONG' : 'SHORT'} at ${Number.isFinite(price) ? price.toFixed(2) : '?'}${levelName ? ' (' + levelName + ')' : ''} banned until the 15m close at ${new Date(ban.until).toISOString()} (${why}).`);
    try { journalManage('LEVEL_BAN_STARTED', `Same-level ban: after ${why}, no new ${dir === 1 ? 'LONG' : 'SHORT'} at ${Number.isFinite(price) ? price.toFixed(2) : 'this level'}${levelName ? ' (' + levelName + ')' : ''} (within ${CONFIG.sameLevelBanTolPts} pts) until the 15m candle closes at ${tlHm(ban.until)}.`, { dir, price: ban.price, levelName: ban.levelName, until: ban.until }); } catch (e) { /* journal only */ }
    return ban;
  }
  function levelBanBlock(dir, price, levelName, now = Date.now()) {
    if (!CONFIG.sameLevelBan) return null;
    levelBans = levelBans.filter(b => b.until > now);
    return levelBans.find(b => banMatch(b, { dir, price, levelName, now, tolPts: CONFIG.sameLevelBanTolPts })) || null;
  }
  // a FILLED trade closed at a loss before TP1 (the stop-out path of watchLiveLifecycle / the paper stop): ban its level, and watch for a reclaim when the STOP filled
  // 10-18b2a FRESH-STOP: { dir, t, ext } = the stopped-out direction, when, and the extreme traded since (high for a short, low for a long)
  let freshStopRec = null;
  // 10-18b2c r3 (Macaveli PR 6229841650, desk ruling): an UNKNOWN reference is repaired only by MARKET-observation time, never receipt time: a 1m bar (or a quote
  // taken from one, livePx.barT) whose OPEN is at or after the first full minute after the stop-out. The bar that contains the stop-out minute never repairs it
  // (a whole-bar extreme cannot place a tick relative to the stop). freshStopTrack and takeEntry both use this one test.
  function freshStopRepairs(r, marketT) { return !!r && typeof marketT === 'number' && Number.isFinite(marketT) && Number.isFinite(r.t) && marketT >= Math.floor(r.t / 60000) * 60000 + 60000; }
  function freshStopTrack(bars1m) { const r = freshStopRec; if (!r || !Array.isArray(bars1m)) return; for (const b of bars1m) { if (!b || !Number.isFinite(b.t) || b.t + 60000 <= r.t) continue; if ((r.ext === null || r.ext === undefined) && !freshStopRepairs(r, b.t)) continue; const x = r.dir === -1 ? b.h : b.l; if (typeof x !== 'number' || !Number.isFinite(x)) continue; r.ext = r.ext === null || r.ext === undefined ? x : r.dir === -1 ? Math.max(r.ext, x) : Math.min(r.ext, x); r.unknown = false; } }   // 10-18b2c r2 (B12): a non-finite bar is skipped; r3: an UNKNOWN reference is repaired only by a bar wholly after the stop-out minute (freshStopRepairs)
  function onLossClose(life, lx) {
    const pl = life && life.plan; if (!life) return;
    // 10-18b2c r2 (MacLock B12 / Macaveli H1): the reference is the FIRST FINITE of the exit stop, the last close, the PLAN stop. None finite = UNKNOWN (ext null):
    // same-direction re-entries are refused (FRESH_STOP_UNKNOWN) until freshStopTrack() or a live price read after the stop-out sets a finite extreme. Never +/-Infinity.
    if (CONFIG.reentryFreshStop && (life.dir === 1 || life.dir === -1)) { const fin = v => typeof v === 'number' && Number.isFinite(v); const ex = lx && fin(lx.stop) ? lx.stop : fin(lastKnownClose) ? lastKnownClose : pl && fin(pl.stop) ? pl.stop : null; freshStopRec = { dir: life.dir, t: lx && Number.isFinite(lx.t) ? lx.t : Date.now(), ext: ex, unknown: ex === null }; try { journalManage(ex === null ? 'FRESH_STOP_UNKNOWN' : 'FRESH_STOP_ARMED', ex === null ? `After the ${life.dir === 1 ? 'LONG' : 'SHORT'} stop-out no finite exit stop, last close or plan stop is known: a new ${life.dir === 1 ? 'LONG' : 'SHORT'} is refused until a price traded after the stop-out is seen. No timer.` : `After the ${life.dir === 1 ? 'LONG' : 'SHORT'} stop-out, a new ${life.dir === 1 ? 'LONG' : 'SHORT'} needs its stop beyond the ${life.dir === 1 ? 'lowest' : 'highest'} price traded since (now ${Number(ex).toFixed(2)}). No timer.`, { dir: life.dir, ext: ex }); } catch (e) { /* journal only */ } }
    levelBanAdd(life.dir, pl && Number.isFinite(pl.entryPrice) ? pl.entryPrice : life.entryPrice, pl ? pl.levelName : null, 'a stop-out');
    if (lx && lx.kind === 'stop') reclaimStart(life, lx);
  }
  // RULE 6
  function reclaimStart(life, lx) {
    if (!CONFIG.reclaimReentry || !life) return null;
    const pl = life.plan || {};
    if (pl.reclaimOf) { log('  [reclaim] the reclaim re-entry was stopped out too: no further re-entry (max 1 per original trade).'); reclaimWatch = null; return null; }
    const stop = lx && Number.isFinite(lx.stop) ? lx.stop : pl.stop; if (!Number.isFinite(stop)) return null;
    const t = lx && Number.isFinite(lx.t) ? lx.t : Date.now();
    reclaimWatch = { dir: life.dir, stop, entry: life.entryPrice, t, until: nextBarCloseMs(t), extreme: stop, used: false, target2: lx && Number.isFinite(lx.target2) ? lx.target2 : pl.target2, source: pl.source || null, grade: pl.grade || null, confidence: initialQuantity.confidenceFor(pl), journalId: pl.journalId || null, levelName: pl.levelName || null, lastCode: 'ban', lastWhy: 'waiting for the 15m ban / cooldown to end' };
    log(`  [reclaim] watching the stopped ${life.dir === 1 ? 'LONG' : 'SHORT'} (stop ${stop.toFixed(2)}): a re-entry needs a 5m close back through the stop on rising volume after ${new Date(reclaimWatch.until).toISOString()}, within ${CONFIG.reclaimWindowMin} min.`);
    return reclaimWatch;
  }
  function reclaimTrack(bars1m) { const w = reclaimWatch; if (!w || w.used || !Array.isArray(bars1m)) return; for (const b of bars1m) { if (!b || !Number.isFinite(b.t) || b.t + 60000 <= w.t) continue; w.extreme = w.dir === 1 ? Math.min(w.extreme, b.l) : Math.max(w.extreme, b.h); } }
  // the blocks a reclaim re-entry respects before takeEntry() (which re-checks cooldown, pause, no-chase, ban, the gate and the broker guard)
  // combined fix 4 (Mac 6330904926): PAPER parity with the state machine's resting-life rule: a resting paper entry is not booked when a block (or its lead)
  // starts within its life (pendingExpireMs + 60 s; 30 min + 60 s with expiry off), sampled every 30 s like LIVE. MARKET paper entries fill at once (exempt).
  const PAPER_WINDOW_FETCH_MS = 2000;   // r7 (MacDot 6331741152): the PAPER early pass waits at most this long for fill evidence before the window cancel
  function paperRestingRefusal(entryType, now = Date.now()) {
    if (LIVE || entryType === 'MARKET' || CONFIG.noRestingAcrossBlock === false) return null;
    const H = (Number.isFinite(CONFIG.pendingExpireMs) && CONFIG.pendingExpireMs > 0 ? CONFIG.pendingExpireMs : 30 * 60000) + 60000;
    for (let dt = 0; dt <= H; dt += 30000) { const r = entryWindowReason(now + Math.min(dt, H)); if (r) return { reason: r, inMs: dt }; }
    return null;
  }
  // combined fix 4: ms until a resting entry's window lead BEGINS within the next totalMs (1 s steps), or null (none, or it is already due: the current pass
  // serviced it and a failed cancel retries on the normal cadence, never a tight loop). LIVE: the state machine's own pendingWindowDue; PAPER: the paper pending.
  function pendingWindowWakeIn(totalMs, now = Date.now()) {
    const due = t => { try { return LIVE ? !!(stateMachine && typeof stateMachine.pendingWindowDue === 'function' && stateMachine.pendingWindowDue(t)) : !!(pending && pending.entryType !== 'MARKET' && entryWindowReason(t)); } catch (e) { return false; } };
    if (due(now)) return null;
    for (let dt = 1000; dt < totalMs; dt += 1000) if (due(now + dt)) return dt;
    return null;
  }
  function entryWindowBlock(now = Date.now()) {
    if (dayBlocked) return 'daily stop';
    if (LIVE && stateMachine.desynced) return 'desynced';
    if (inMorningHold(now)) return `morning hold (${morningHoldLabel()} PT)`;
    if (inNyOpenBlackout(now, CONFIG.blockNyOpenMinutes)) return 'NY-open window (06:30-07:00 PT)';
    if (inAsiaBlackout(now, asiaBlockMinutes(CONFIG))) return 'Asia blackout';
    if (sessionCloseState(now, CONFIG).noEntry) return 'session close';
    if (pausedUntil && now < pausedUntil) return 'paused by you';
    try { if (newsWaitBlock(now)) return 'news wait'; } catch (e) { /* none */ }
    return null;
  }
  async function reclaimStep(bars1m) {
    const w = reclaimWatch; if (!w) return null;
    if (CONFIG.levelsOnlyEntries) return 'levels-only';   // lv1 r3: the reclaim re-entry carries no named level-event proof - suppressed (a fresh sweep -> reclaim at a named level is a level event)
    reclaimTrack(bars1m);
    const now = Date.now();
    if (w.used) { reclaimWatch = null; return 'used'; }
    if (now > w.t + (CONFIG.reclaimWindowMin || 60) * 60000) { log(`  [reclaim] no reclaim within ${CONFIG.reclaimWindowMin} min of the stop-out: watch ended.`); journalBlock('RECLAIM_SKIP', w.dir, { why: `no qualifying reclaim within ${CONFIG.reclaimWindowMin} min of the stop-out`, skip: 'expired', stop: w.stop, reasonKey: 'expired' }); reclaimWatch = null; return 'expired'; }
    if (!isFlat()) return 'not-flat';
    let px = null; try { px = livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose; } catch (e) { px = lastKnownClose; }
    const g = gateNow(w.dir, px, { skipWave: true });
    const d = reclaimDecision({ w, now: ctlNow(), px, bars5: ctlBars && ctlBars.M5, controlOk: !g || g.ok, cfg: CONFIG, tick: tickSize || 0.25 });
    if (d.code === 'ban' && now >= w.until) { /* the bars were read before the ban ended: wait for fresh bars */ }
    w.lastCode = d.code; w.lastWhy = d.why;
    if (!d.go) {
      if (['no-sweep', 'no-close-through', 'no-volume', 'price-back', 'control'].includes(d.code) && d.candle) journalBlock('RECLAIM_SKIP', w.dir, { why: d.why, skip: d.code, candleT: d.candle.t, candleClose: d.candle.c, candleVol: d.candle.v, prevVol: d.prev ? d.prev.v : null, stop: w.stop, extreme: d.extreme, gate: g && !g.ok ? g.text : null, reasonKey: d.code + '|' + d.candle.t });
      if (d.code === 'expired') reclaimWatch = null;
      return d.code;
    }
    const blk = entryWindowBlock(now);
    if (blk) { w.lastCode = 'blocked'; w.lastWhy = blk; journalBlock('RECLAIM_SKIP', w.dir, { why: `the reclaim qualified but new entries are blocked (${blk})`, skip: 'blocked', stop: w.stop, reasonKey: 'blocked|' + blk }); return 'blocked'; }
    const rcFloor = floorEntryStop(w.dir, px, { stopPrice: d.stop, tightStopPrice: null }, 'MARKET', { rawStop: d.stop }), rcStop = rcFloor.stopPrice;   // entry stop floor: a tighter beyond-the-sweep stop moves out
    const stopPts = Math.abs(px - rcStop);
    if (!entryControlAllowed(w.dir, w.source || 'reclaim', 'reclaim', 'reclaim-qualified', entryControlBoard, w.t)) return 'control-blocked';
    const sig = { dir: w.dir, source: w.source || 'reclaim', grade: w.grade, confidence: w.confidence };
    const contracts = sizeForStop(stopPts, sig);
    if (!contracts) { const sizing = quantityForStop(stopPts, sig); w.lastCode = sizing.reason; w.lastWhy = sizing.reason === 'confidence-ineligible' ? 'originating confidence is ineligible for a new entry' : sizing.reason === 'below-min-contracts' ? sizing.minText : 'the stop beyond the sweep is too wide for 1 contract'; riskCapSkip(lastMac, lastLv, sig, stopPts, { entryType: 'MARKET', entry: px, stop: rcStop, path: 'reclaim' }); return 'risk-cap'; }
    noteSizing(w.dir, contracts, stopPts, { source: sig.source, grade: sig.grade, entryType: 'MARKET', path: 'reclaim' });
    const inNy = (() => { const m = ptInfo(now).minutesOfDay; return m >= 6 * 60 + 30 && m < 13 * 60; })();
    const goal = (!inNy && CONFIG.offPeakTarget1DollarGoal != null) ? CONFIG.offPeakTarget1DollarGoal : CONFIG.target1DollarGoal, mult = (!inNy && CONFIG.offPeakTarget2Multiple != null) ? CONFIG.offPeakTarget2Multiple : CONFIG.target2Multiple;
    const leg1Size = leg1SizeForContracts(contracts), t1Pts = tp1PointsFor(goal, leg1Size), target1 = w.dir === 1 ? px + t1Pts : px - t1Pts;
    const target2 = computeTarget2(w.dir, px, target1, tp2BasisPoints(goal), Number.isFinite(w.target2) ? w.target2 : null, mult, null);
    // reclaim-fix r2 (MacDot 6309285825 / 6309377686 / 6309836012): CONSERVATIVE CONSUME-ON-FSM-ATTEMPT. The watch is consumed once
    // THIS call's entry was handed to the order state machine (its own attemptReceipt, not a global counter). A refusal inside takeEntry()
    // before that hand-off (control, cooldown, no-chase, ban, guard, quantity...) leaves the watch QUALIFIABLE inside its ORIGINAL window
    // (w.t / deadline / extreme unchanged); every later poll re-runs the reclaim qualification and every gate. A refusal INSIDE the FSM or
    // transport after the hand-off still consumes it (open item, never a second attempt). The window is re-checked after the awaited
    // broker guard, right before the hand-off. The watch is in memory only, so a restart ends it (no resubmit).
    if (w.inFlight) return 'in-flight';
    const info = { stopOut: w.stop, stopOutAt: w.t, sweepExtreme: d.extreme, candleT: d.candle.t, candleClose: d.candle.c, candleVol: d.candle.v, prevVol: d.prev.v, px, newStop: rcStop, sweepStop: d.stop, contracts, riskUsd: lastSizing ? lastSizing.riskUsd : null, target1, target2, of: w.journalId };
    const txt = `Reclaim re-entry: the ${w.dir === 1 ? 'LONG' : 'SHORT'} stopped at ${w.stop.toFixed(2)} swept to ${d.extreme.toFixed(2)}; the ${new Date(d.candle.t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' })} PT 5m candle closed back at ${d.candle.c.toFixed(2)} on volume ${d.candle.v} > ${d.prev.v}; re-entering ${contracts}x at market ~${px.toFixed(2)}, stop ${rcStop.toFixed(2)} (${rcFloor.stopFloor.floored ? `the ${rcFloor.stopFloor.floorPts}-pt ${rcFloor.stopFloor.floorSession} floor; beyond the sweep was ${d.stop.toFixed(2)}` : 'beyond the sweep'}), TP1 ${target1.toFixed(2)}, TP2 ${target2.toFixed(2)}.`;
    const sc = { path: 'reclaim', entryWhy: txt, stopBasis: { kind: 'reclaim', rawStop: d.stop }, stopEntryRef: px, stopFloor: rcFloor.stopFloor, target1Points: t1Pts, t2BasisPoints: tp2BasisPoints(goal), structTarget: Number.isFinite(w.target2) ? w.target2 : null, t2Multiple: mult, asiaStruct: null, goalUsd: goal, offPeak: !inNy, mac: lastMac || {}, lv: lastLv || {}, sig, refPrice: px, reclaim: info };
    const receipt = { handedOff: false, lateInvalid: false, deadline: w.t + (CONFIG.reclaimWindowMin || 60) * 60000, stillValid: () => reclaimWatch === w && !w.used && Date.now() <= receipt.deadline };
    let sendErr = null;
    w.inFlight = true;
    try {
      await takeEntry(w.dir, 'MARKET', px, rcStop, target1, target2, sig.source, sig.grade, null, contracts, { confidence: sig.confidence, stopFloor: rcFloor.stopFloor, alignmentConsumed: false, isIntrabar: true, reclaimOf: w.journalId || 'reclaim', levelContext: w.levelName ? { name: w.levelName, behavior: 'RECLAIM' } : null, attemptReceipt: receipt }, sc);
    } catch (e) { sendErr = e; } finally { w.inFlight = false; }
    if (!receipt.handedOff) {
      if (sendErr) log('  [reclaim] the entry failed before it reached the order machine (watch kept): ' + sendErr.message);
      w.lastCode = receipt.lateInvalid ? 'expired' : 'refused'; w.lastWhy = receipt.lateInvalid ? 'the reclaim window ended while the entry was being checked' : 'the reclaim qualified but the entry was refused before it reached the order machine';
      const rk = 'refused|' + (d.candle ? d.candle.t : '');
      if (w.refusedKey !== rk) { w.refusedKey = rk; journalBlock('RECLAIM_SKIP', w.dir, { why: w.lastWhy + ' (watch kept until ' + (Number.isFinite(w.t) ? new Date(w.t + (CONFIG.reclaimWindowMin || 60) * 60000).toISOString() : 'its window ends') + ')', skip: 'refused-not-sent', stop: w.stop, candleT: d.candle ? d.candle.t : null, reasonKey: rk }); }
      if (receipt.lateInvalid && reclaimWatch === w) reclaimWatch = null;
      return receipt.lateInvalid ? 'expired' : 'refused';
    }
    w.used = true;   // conservative consume-on-FSM-attempt: the order machine may still refuse without a broker send; that late refusal does not reopen the watch
    lastReclaim = { t: now, dir: w.dir, ...info };
    log('  [reclaim] ' + txt);
    appendJournal({ type: 'reclaim', code: 'RECLAIM_REENTRY', t: now, dir: w.dir, text: txt, handedToOrderMachine: true, brokerSendConfirmed: false, ...info });
    notifyPhone(`Reclaim re-entry attempted: ${w.dir === 1 ? 'LONG' : 'SHORT'} ${contracts}x`, txt + ' (handed to the order machine; see the order/fill alerts for what the broker did)', { tags: 'repeat' });
    if (sendErr) throw sendErr;   // the attempt may have reached the broker: the watch is already consumed above, the caller logs the failure
    return 'attempted';
  }
  // WAVE TRIGGER MODE (waveMode 'trigger', OFF until the backtest): entry A / B on the last closed 5m candle, with the regime, enters on its own (source 'wave').
  async function waveTriggerStep() {
    if (CONFIG.levelsOnlyEntries || CONFIG.waveMode !== 'trigger' || !REMOVED_FILTER_CONTEXT.trendFilter || !isFlat() || !ctlBars) return null;
    const now = Date.now(); if (entryWindowBlock(now)) return 'blocked';
    let g; try { g = directionGate({ dir: -1, now: ctlNow(), bars: ctlBars, cfg: CONFIG }); } catch (e) { return null; }
    const reg = g && g.trend && g.trend.known ? g.trend.regime : null; if (reg !== 'DOWN' && reg !== 'UP') return 'no-trend';
    const dir = reg === 'DOWN' ? -1 : 1;
    let ws; try { ws = waveState(dir, ctlBars, ctlNow(), CONFIG); } catch (e) { return null; }
    if (!ws || !ws.setup || ws.setup.t === lastWaveTriggerT) return 'no-setup';
    if (!entryControlAllowed(dir, 'wave', 'wave-' + ws.setup.kind, 'wave-qualified', entryControlBoard, ws.setup.t)) return 'control-blocked';
    lastWaveTriggerT = ws.setup.t;
    let px = null; try { px = livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose; } catch (e) { px = lastKnownClose; }
    if (!Number.isFinite(px) || (dir === -1 ? ws.setup.stop <= px : ws.setup.stop >= px)) return 'stop-wrong-side';
    const wvFloor = floorEntryStop(dir, px, { stopPrice: ws.setup.stop, tightStopPrice: null }, 'MARKET', { rawStop: ws.setup.stop }), wvStop = wvFloor.stopPrice;   // entry stop floor BEFORE sizing
    const stopPts = Math.abs(px - wvStop), sig = { dir, source: 'wave', grade: ws.setup.kind }, contracts = sizeForStop(stopPts, sig);
    if (!contracts) return riskCapSkip(lastMac, lastLv, sig, stopPts, { entryType: 'MARKET', entry: px, stop: wvStop, path: 'wave-' + ws.setup.kind });
    noteSizing(dir, contracts, stopPts, { source: 'wave', grade: ws.setup.kind, entryType: 'MARKET', path: 'wave-' + ws.setup.kind });
    const inNy = (() => { const m = ptInfo(now).minutesOfDay; return m >= 6 * 60 + 30 && m < 13 * 60; })();
    const goal = (!inNy && CONFIG.offPeakTarget1DollarGoal != null) ? CONFIG.offPeakTarget1DollarGoal : CONFIG.target1DollarGoal, mult = (!inNy && CONFIG.offPeakTarget2Multiple != null) ? CONFIG.offPeakTarget2Multiple : CONFIG.target2Multiple;
    const leg1Size = leg1SizeForContracts(contracts), t1Pts = tp1PointsFor(goal, leg1Size), target1 = dir === 1 ? px + t1Pts : px - t1Pts, target2 = computeTarget2(dir, px, target1, tp2BasisPoints(goal), null, mult, null);
    log(`SIGNAL: ${dir === 1 ? 'LONG' : 'SHORT'} MARKET wave ${ws.setup.text} (${contracts}x) entry~${px.toFixed(2)} stop=${wvStop.toFixed(2)} target1=${target1.toFixed(2)} target2=${target2.toFixed(2)}`);
    notifyPhone(`Signal: ${dir === 1 ? 'LONG' : 'SHORT'} (wave ${ws.setup.kind}, ${contracts}x)`, `${ws.setup.text}; entry~${px.toFixed(2)} stop=${wvStop.toFixed(2)} t1=${target1.toFixed(2)} t2=${target2.toFixed(2)}`, { tags: 'moneybag' });
    await takeEntry(dir, 'MARKET', px, wvStop, target1, target2, 'wave', ws.setup.kind, null, contracts, { isIntrabar: true, wave: ws.setup.kind, stopFloor: wvFloor.stopFloor },
      { path: 'wave-' + ws.setup.kind, entryWhy: `wave trigger (${reg}): ${ws.setup.text}`, stopBasis: { kind: 'wave', rawStop: ws.setup.stop }, stopEntryRef: px, stopFloor: wvFloor.stopFloor, target1Points: t1Pts, t2BasisPoints: tp2BasisPoints(goal), structTarget: null, t2Multiple: mult, asiaStruct: null, goalUsd: goal, offPeak: !inNy, mac: lastMac || {}, lv: lastLv || {}, sig, refPrice: px });
    return 'entered';
  }
  // phone / snapshot (display only)
  function riskView(now = Date.now()) {
    const cap = riskCapOn() ? CONFIG.maxRiskPerTradeUsd : null, sm = LIVE ? stateMachine : null;
    let plan = null;
    try {
      if (LIVE && sm && sm.phase !== 'FLAT' && Number.isFinite(sm.stopPriceIntended) && Number.isFinite(sm.intendedEntryPrice ?? sm.entryPrice)) { const e = sm.phase === 'PENDING_ENTRY' ? sm.intendedEntryPrice : sm.entryPrice, pts = Math.abs(e - sm.stopPriceIntended); plan = { pending: sm.phase === 'PENDING_ENTRY', dir: sm.dir, contracts: sm.contracts, legs: { leg1: sm.leg1Size, leg2: sm.leg2Size, runner: sm.contracts - sm.leg1Size - sm.leg2Size }, stopPts: r2_18(pts), riskUsd: r2_18(pts * pointValue * sm.contracts) }; }
      else if (!LIVE && (pending || position)) { const q = pending || position, pts = Math.abs(q.entryPrice - q.stopPrice); plan = { pending: !!pending, dir: q.dir, contracts: q.contracts, stopPts: r2_18(pts), riskUsd: r2_18(pts * pointValue * q.contracts) }; }
    } catch (e) { plan = null; }
    return { on: !!cap, cap, maxContracts: CONFIG.baseContracts, slipPts: CONFIG.riskSizingSlipPts || 0, widestStopPts: cap ? (CONFIG.minContracts === 3 ? minContractsMaxStopPts(CONFIG, pointValue) : maxStopPtsForOneLot(cap, pointValue, CONFIG.riskSizingSlipPts)) : null, minContracts: CONFIG.minContracts === 3 ? 3 : null, plan, last: lastSizing && now - lastSizing.t < 30 * 60000 ? { ...lastSizing } : null,
      firstScalePts: scaleOutOn() ? CONFIG.scaleOutRunner.atPts : CONFIG.firstScalePts > 0 ? CONFIG.firstScalePts : null, scaleOutRunner: scaleOutOn() ? { ...CONFIG.scaleOutRunner } : null, split: Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, legSplit(n, CONFIG)])) };
  }
  function trendView(now = Date.now()) {
    return { on: false, controlOn: false, removed: true, waveMode: 'removed-entry-confirmation', regime: null,
      text: 'Trend / control entry filter removed by owner', control: null,
      longOk: null, longWhy: 'Filter removed; other entry checks still apply', shortOk: null, shortWhy: 'Filter removed; other entry checks still apply',
      barsAt: ctlBars ? ctlBars.at : null,
      reversal: CONFIG.exhaustionReversal && lastReversal && lastReversal.context && now - lastReversal.t < 120000 ? { dir: lastReversal.dir, ok: lastReversal.ok, why: lastReversal.why, rsi: lastReversal.rsi } : null, reversalOn: !!CONFIG.exhaustionReversal };
  }
  function bansView(now = Date.now()) {
    const bans = levelBans.filter(b => b.until > now).map(b => ({ dir: b.dir, price: b.price, levelName: b.levelName, until: b.until, why: b.why }));
    const w = reclaimWatch;
    return { banOn: !!CONFIG.sameLevelBan, bans, reclaimOn: !!CONFIG.reclaimReentry, windowMin: CONFIG.reclaimWindowMin,
      watch: w ? { dir: w.dir, stop: w.stop, extreme: w.extreme, since: w.t, until: w.until, endsAt: w.t + (CONFIG.reclaimWindowMin || 60) * 60000, used: !!w.used, state: w.lastCode || null, why: w.lastWhy || null } : null,
      last: lastReclaim && now - lastReclaim.t < 60 * 60000 ? { t: lastReclaim.t, dir: lastReclaim.dir, px: lastReclaim.px, newStop: lastReclaim.newStop, contracts: lastReclaim.contracts } : null };
  }
  // ── 10/18 RISK RULES (end) ──
  // ── 18f1 F1 SIGNAL PUSH (NOTIFICATION ONLY) ── checkForNewEntry() used to push "Signal: ..." BEFORE takeEntry(), whose gates (dead plan, TP1 passed, level ban,
  // trend / control / wave, no-chase, news, broker guard) then often placed nothing: 268 such pushes on 10/15. Now the four checkForNewEntry branches only ARM
  // the push (signalPushArm, same title and text) and takeEntry() sends it right before the order goes to the state machine (signalPushFire), at most once
  // per direction / path / entry / stop / 15m bar. These three functions read and write only signalPushArmed / signalPushSent.
  let signalPushArmed = null;          // { title, body, opts } armed by checkForNewEntry for the takeEntry() call that follows it
  const signalPushSent = new Map();    // dedup key -> time sent (kept 2 h)
  function signalPushArm(title, body, opts) { signalPushArmed = { title, body, opts }; }
  function signalPushTake() { const p = signalPushArmed; signalPushArmed = null; return p; }
  function signalPushFire(p, dir, pth, entry, stop) {
    if (!p) return;
    try {
      const now = Date.now(), r = v => (Number.isFinite(+v) ? (+v).toFixed(2) : String(v));
      const key = `${dir}|${pth || '-'}|${r(entry)}|${r(stop)}|${Math.floor(now / 900000)}`;
      for (const [k, t] of signalPushSent) if (now - t > 2 * 3600000) signalPushSent.delete(k);
      if (signalPushSent.has(key)) { log(`  [ntfy] Signal push skipped: the same ${dir === 1 ? 'LONG' : 'SHORT'} ${pth || ''} ${r(entry)} / stop ${r(stop)} was already pushed in this 15m bar`); return; }
      signalPushSent.set(key, now);
      notifyPhone(p.title, p.body, p.opts);
    } catch (e) { /* a push never affects the entry */ }
  }
  let trendLife = null;         // { dir, filled, pastLeg1, entryPrice } of the live trend position being watched (watchLiveLifecycle); null whenever the machine is FLAT
  // 10/16 NO RE-ARMING A DEAD PLAN. markPlanDead: the stop-touch rule cancelled this plan. planDeadBlock: the dead record when a new entry is the SAME plan
  // (same direction, entry within 2 ticks, stop within 1 tick), else null. A different plan in that direction (new structure) clears the record.
  // kind 'stop' (price reached the planned stop) or 'target' (round 3: price reached TP1 first; the same plan = same direction + entry within 2 ticks)
  function markPlanDead(dir, entry, stop, t = Date.now(), kind = 'stop') { if (dir == null || !Number.isFinite(entry) || (kind === 'stop' && !Number.isFinite(stop))) return; deadPlans[dir] = { dir, entry, stop, t, kind }; }
  function planDeadBlock(dir, entry, stop) {
    const d = deadPlans[dir]; if (!d) return null;
    // round 5 (QA r4 B8, keeps the documented promise): a STOP-touched plan stays blocked (24 h, or until a different plan is checked); a TP1-touched plan expires at the next 15m close
    if (d.kind === 'target' ? Date.now() >= nextBarCloseMs(d.t) : Date.now() - d.t > 24 * 3600000) { delete deadPlans[dir]; return null; }
    const tk = tickSize || 0.25;
    if (Math.abs(entry - d.entry) <= 2 * tk + 1e-9 && (d.kind === 'target' || Math.abs(stop - d.stop) <= tk + 1e-9)) return d;
    delete deadPlans[dir]; return null;
  }
  // 10/16: a later record never SHORTENS a running cooldown (the longer of the two is kept)
  function setCooldownRec(rec) { const cur = stopOuts[rec.dir]; if (!cur || cur.until <= rec.until || Date.now() >= cur.until) stopOuts[rec.dir] = rec; }
  // r9.7 (MacDot aa79108): the WHOLE cooldown state is written once, after every record of a close is set (one atomic file = both directions or neither).
  // A failed write keeps the cooldown in memory and says so (urgent log); a restart would then lose it, never half of it.
  function saveCooldowns() { if (!LIVE) return; try { writeAtomic(COOLDOWN_STATE_FILE, JSON.stringify(stopOuts)); } catch (e) { log('  [cooldown] WARNING: could not save the cooldown (' + e.message + ') - it is active now, but a restart before ' + Object.values(stopOuts).filter(Boolean).map(r => new Date(r.until).toISOString()).join(' / ') + ' would forget it'); } }
  // 10/16 COOLDOWN AFTER A WIN (CONFIG.reentryCooldownAfterWin; default off). Called when a FILLED trend trade closes and it was NOT a stop-out.
  function noteWinClose(dir, kind, exitMs = Date.now()) {
    const dirs = winCooldownDirs(CONFIG, dir);
    const sdUntil = CONFIG.reentryCooldown && CONFIG.sameDirBlockAfterWin && dir != null ? sameDirBlockUntil(CONFIG, exitMs) : null;   // so1 r1.11
    const sdApplies = sdUntil != null && sdUntil > exitMs && sdUntil > ((stopOuts[dir] && stopOuts[dir].until) || 0);
    if (!dirs.length && !sdApplies) return;
    for (const d of dirs) setCooldownRec(buildStopOut(CONFIG, d, exitMs, kind, { win: true, tradeDir: dir }));
    if (sdUntil != null && sdUntil > exitMs && (!stopOuts[dir] || sdUntil > stopOuts[dir].until)) setCooldownRec({ dir, t: exitMs, until: sdUntil, kind: kind + ' (15m same-direction block after a win)', win: true, tradeDir: dir, sameDirBlockMin: CONFIG.stopOutSameDirBlockMin });
    saveCooldowns();
    if (!dirs.length) {   // only the candle block (the after-win 5m cooldown is off)
      log(`  [cooldown] ${kind}: the ${dir === 1 ? 'LONG' : 'SHORT'} closed (win) - new ${dir === 1 ? 'LONG' : 'SHORT'} entries blocked until the ${CONFIG.stopOutSameDirBlockMin}m candle closes at ${new Date(stopOuts[dir].until).toISOString()}`);
      try { journalManage('COOLDOWN_STARTED', `The ${dir === 1 ? 'LONG' : 'SHORT'} trade closed (win) (${kind}), so the bot will not open another ${dir === 1 ? 'LONG' : 'SHORT'} until the ${CONFIG.stopOutSameDirBlockMin}m candle closes at ${tlHm(stopOuts[dir].until)}. The opposite direction is still allowed.`, { dir, until: stopOuts[dir].until, win: true, sameDirBlockMin: CONFIG.stopOutSameDirBlockMin }); } catch (e) { /* journal only */ }
      return;
    }
    const until = Math.max(...dirs.map(d => stopOuts[d].until)), endRec = dirs.map(d => stopOuts[d]).find(r => r.until === until);
    const names = dirs.length === 2 ? 'LONG or SHORT' : (dir === 1 ? 'LONG' : 'SHORT');
    log(`  [cooldown] ${kind}: the ${dir === 1 ? 'LONG' : 'SHORT'} closed (win) - new ${names} entries blocked until ${cooldownEndText(CONFIG, endRec)} ${new Date(until).toISOString()}`);
    try { journalManage('COOLDOWN_STARTED', `The ${dir === 1 ? 'LONG' : 'SHORT'} trade closed (win) (${kind}), so the bot will not open another ${names} until ${cooldownEndText(CONFIG, endRec)} ${tlHm(until)}${dirs.length === 2 && stopOuts[-dir] && stopOuts[-dir].until !== until ? ` (${-dir === 1 ? 'LONG' : 'SHORT'} entries: until ${tlHm(stopOuts[-dir].until)})` : ''}.${dirs.length === 2 ? '' : ' The opposite direction is still allowed.'}`, { dir, until, win: true, scope: CONFIG.reentryCooldownScope, ...(endRec && endRec.winFloorMin ? { winFloorMin: endRec.winFloorMin } : {}) }); } catch (e) { /* journal only */ }
  }
  function noteStopOut(dir, kind, exitMs = Date.now()) {
    if (!CONFIG.reentryCooldown || dir == null) return;
    setCooldownRec(buildStopOut(CONFIG, dir, exitMs, kind));
    const bothDirs = !!(CONFIG.reentryCooldownAfterWin && CONFIG.reentryCooldownScope === 'both');   // 10/16: scope 'both' covers losses too (no new trade either way until the candle closes)
    if (bothDirs) setCooldownRec(buildStopOut(CONFIG, -dir, exitMs, kind, { tradeDir: dir }));
    const sdUntil = sameDirBlockUntil(CONFIG, exitMs);   // so1: same direction blocked for the rest of the 15m candle (the longer record wins)
    if (sdUntil != null && sdUntil > stopOuts[dir].until) setCooldownRec({ ...stopOuts[dir], until: sdUntil, kind: kind + ' (15m same-direction block)', sameDirBlockMin: CONFIG.stopOutSameDirBlockMin });
    saveCooldowns();
    const tf = stopOuts[dir].sameDirBlockMin ? `${stopOuts[dir].sameDirBlockMin}m` : cooldownTfLabel(CONFIG), opp = bothDirs && stopOuts[-dir] && stopOuts[-dir].until !== stopOuts[dir].until ? ` (${-dir === 1 ? 'LONG' : 'SHORT'} entries: until ${tlHm(stopOuts[-dir].until)})` : '';
    log(`  [cooldown] ${kind}: new ${bothDirs ? 'LONG or SHORT' : dir === 1 ? 'LONG' : 'SHORT'} entries blocked until the ${tf} bar closes at ${new Date(stopOuts[dir].until).toISOString()}`);
    try { journalManage('COOLDOWN_STARTED', bothDirs ? `The ${dir === 1 ? 'LONG' : 'SHORT'} trade closed (loss: ${kind}), so the bot will not open any new trade, in either direction, until the ${tf} candle closes at ${tlHm(stopOuts[dir].until)}${opp}.`
      : `The ${dir === 1 ? 'LONG' : 'SHORT'} trade was stopped out (${kind}), so the bot will not open another ${dir === 1 ? 'LONG' : 'SHORT'} until the ${tf} bar closes at ${tlHm(stopOuts[dir].until)}. The opposite direction is still allowed.`, { dir, until: stopOuts[dir].until, ...(bothDirs ? { scope: 'both' } : {}) }); } catch (e) { /* journal only */ }
  }
  // The stop-out record that blocks an entry in `dir` right now, or null. Logs once per cooldown.
  function cooldownBlock(dir) {
    const b = reentryBlockedBy(CONFIG, stopOuts, dir, Date.now());
    if (b) {
      const key = `${b.until}|${dir}`;
      if (key !== lastCooldownLogKey) { lastCooldownLogKey = key; log(`  [cooldown] ${dir === 1 ? 'LONG' : 'SHORT'} entry blocked: ${b.win ? 'win close' : b.kind} at ${new Date(b.t).toISOString()}, waiting until ${cooldownEndText(CONFIG, b)} ${new Date(b.until).toISOString()}`); }
    }
    return b;
  }
  // Trend-position time-stop counter (2026-09-24, FIX 9 Rule 2) — counts
  // closed 15m bars since the CURRENT trend position opened, reset to 0 by
  // takeEntry() on every new trend entry. Only meaningful while pre-TP1
  // (leg1 open); see tickTrendTimeoutBarClose().
  let trendBarsOpen = 0;

  // Order/fill lifecycle journaling (2026-09-24, mobile terminal spec B1/B2)
  // — journalId ties a signal's pending -> traded/canceled -> closed rows
  // together as one append-only JSONL thread, so mobile can render one card
  // per signal instead of the old bug where a mere LIMIT/STOP order PLACEMENT
  // was journaled as 'traded' even though the broker might never fill it.
  // Deliberately observes LIVE state EXTERNALLY (phase transitions around the
  // existing stateMachine.tick() call) rather than modifying
  // liveStateMachine.js — that
  // class places real orders and is proven in production, not something to
  // retrofit for a journaling feature. PAPER mode calls these same 4 helpers
  // inline, at its own exact transition points, with exact (not estimated)
  // prices/P&L.
  let pendingJournalContext = null; // { journalId, dir, contracts, entryType, entryPrice, stopPrice, source, grade } — set for LIMIT/STOP entries only; MARKET fills instantly, no pending stage
  let openJournalContext = null; // { journalId, dir, contracts, entryPrice, source, grade, peakUnrealized } — set the instant an entry fills, cleared once the position closes

  function journalOrderPending(ctx) {
    pendingJournalContext = ctx;
    journalSignalSnapshot(lastMac, lastLv, 'pending', {
      journalId: ctx.journalId, dir: ctx.dir, source: ctx.source, grade: ctx.grade,
      contracts: ctx.contracts, entryType: ctx.entryType, entryPrice: ctx.entryPrice, stopPrice: ctx.stopPrice,
      entryPath: ctx.entryPath ?? null, entryLevel: ctx.entryLevel ?? null, ...(ctx.extra || {}),   // r9.14 (MacDot 6319625469): carried onto the emitted pending row
    });
  }

  function journalOrderFilled(fillPrice) {
    if (!pendingJournalContext) return; // MARKET entries never go through 'pending' — nothing to resolve
    const ctx = pendingJournalContext;
    if (CONFIG.levelsOnlyEntries) lvjOrder(ctx.journalId, 'filled', { fill: fillPrice, paper: !LIVE });   // lv1 r6
    journalSignalSnapshot(lastMac, lastLv, 'traded', {
      journalId: ctx.journalId, dir: ctx.dir, source: ctx.source, grade: ctx.grade,
      contracts: ctx.contracts, entryType: ctx.entryType, entryPrice: fillPrice, stopPrice: ctx.stopPrice,
      entryPath: ctx.entryPath ?? null, entryLevel: ctx.entryLevel ?? null, ...(ctx.extra || {}),   // r9.14: and onto the pending -> traded row
    });
    openJournalContext = { journalId: ctx.journalId, dir: ctx.dir, contracts: ctx.contracts, entryPrice: fillPrice, source: ctx.source, grade: ctx.grade, peakUnrealized: 0, entryTime: Date.now(), setup: ctx.extra && ctx.extra.setup };
    pendingJournalContext = null;
  }

  // 18f1 LABEL (journal only): the MARKET entry between 'attempted' (sent) and the broker's answer. Read only by the three functions below.
  let marketAttemptContext = null;
  // right after stateMachine.openEntry(): PENDING_ENTRY = the broker took the order (the fill is confirmed later); FLAT = rejected, nothing was placed
  function journalMarketAfterSend(jid) {
    const c = marketAttemptContext; if (!c || c.journalId !== jid) return;
    if (stateMachine && stateMachine.phase === 'PENDING_ENTRY') { c.placed = true; if (CONFIG.levelsOnlyEntries) lvjOrder(jid, 'accepted', { phase: 'PENDING_ENTRY' }); return; }
    if (CONFIG.levelsOnlyEntries && stateMachine && stateMachine.phase === 'FLAT') lvjOrder(jid, 'not-admitted', { reason: stateMachine.entryOrderId != null ? 'flat after the send with a broker order id' : 'flat after the send call with no broker order id (refused before the send, or the send failed) - not proven a broker rejection' });   // lv1 r10
    marketAttemptContext = null;
    if (openJournalContext && openJournalContext.journalId === c.journalId && !(stateMachine && stateMachine.phase !== 'FLAT')) openJournalContext = null;   // linkage fix: immediate rejection (MacDot 6328175259 #6)
    if (stateMachine && stateMachine.phase === 'FLAT') journalSignalSnapshot(lastMac, lastLv, 'canceled', { journalId: c.journalId, dir: c.dir, source: c.source, grade: c.grade, reason: stateMachine.entryOrderId != null ? 'entry not placed - flat after the send' : 'entry not placed - no broker order id (refused before the send, or the send failed)' });   // lv1 r10 (MacDot 6455780460 #3): no broker-rejection claim without broker evidence
  }
  // PENDING_ENTRY -> open / FLATTENING: the broker filled it: 'traded' at the real fill price
  function journalMarketFilled(fillPrice) {
    const c = marketAttemptContext; if (!c || !c.placed) return; marketAttemptContext = null;
    if (CONFIG.levelsOnlyEntries) lvjOrder(c.journalId, 'filled', { fill: fillPrice != null ? fillPrice : c.entryPrice });   // lv1 r6
    journalSignalSnapshot(lastMac, lastLv, 'traded', { journalId: c.journalId, dir: c.dir, source: c.source, grade: c.grade, contracts: c.contracts, entryType: c.entryType, entryPrice: fillPrice != null ? fillPrice : c.entryPrice, stopPrice: c.stopPrice, entryPath: c.entryPath, entryLevel: c.entryLevel ?? null, signalPrice: c.entryPrice });
  }
  // PENDING_ENTRY -> FLAT: the (marketable-limit) entry never filled
  function journalMarketUnfilled(reason) {
    const c = marketAttemptContext; if (!c || !c.placed) return; marketAttemptContext = null;
    // journal metadata (linkage fix): a LIVE MARKET attempt sets openJournalContext at SEND; when it never fills, release it, or later trade_manage / FSM rows
    // inherit this dead plan's journalId (10/20: 8dc6853f stamped ea0be66c's and 5c10b58a's rows). Journal only.
    if (openJournalContext && openJournalContext.journalId === c.journalId) openJournalContext = null;
    if (CONFIG.levelsOnlyEntries) lvjOrder(c.journalId, 'unfilled', { reason });   // lv1 r6
    journalSignalSnapshot(lastMac, lastLv, 'canceled', { journalId: c.journalId, dir: c.dir, source: c.source, grade: c.grade, reason });
  }

  function journalOrderCanceled(reason) {
    if (!pendingJournalContext) return;
    const ctx = pendingJournalContext;
    if (CONFIG.levelsOnlyEntries) lvjOrder(ctx.journalId, 'canceled', { reason });   // lv1 r6
    journalSignalSnapshot(lastMac, lastLv, 'canceled', { journalId: ctx.journalId, dir: ctx.dir, source: ctx.source, grade: ctx.grade, reason });
    try { const jr = require('./lib/journalReceipts'); jr.emit(appendJournal, () => jr.receipt(ctx.journalId, 'PLAN_CANCELED', { reason, statement: 'Pending plan canceled; this status does not assert a fill.' })); } catch (_) { /* receipt only */ }
    pendingJournalContext = null;
  }

  // Paper-mode pending (LIMIT/STOP) entry: fill / blackout-cancel / expire. Called once per poll with the live bar. (Extracted from the main loop unchanged so the smoke test can run it; the blackout cancel is new.)
  // 10/16: + fill-slippage guard (gap-aware fill price), news pull before a high-impact release, and the stop-touch cancel - each mirrors the LIVE state machine.
  function paperStopCap(p, fill, floorPts) {   // lv1 r13.6.2 (PAPER): the same cap on the paper book's levels position at its fill
    if (!p || p.source !== 'levels' || CONFIG.levelStopMaxFromFillPts === null) return null;
    const d = levelStopCapFromFill({ dir: p.dir, fill, stop: p.stopPrice, capPts: CONFIG.levelStopMaxFromFillPts, floorPts, tickSize });
    if (!d) return null;
    p.stopPrice = d.stop;
    log(`  [PAPER] STOP CAP FROM THE FILL: stop ${d.before.toFixed(2)} is ${d.beforePts} pts from the fill ${fill.toFixed(2)}; moved in to ${d.stop.toFixed(2)} (${d.afterPts} pts); size unchanged.`);
    try { appendJournal({ type: 'trade_manage', t: Date.now(), journalId: (openJournalContext || pendingJournalContext) ? (openJournalContext || pendingJournalContext).journalId : null, code: 'STOP_CAP_FROM_FILL', text: `[PAPER] The stop was ${d.beforePts} pts from the fill ${fill.toFixed(2)}, more than the ${d.capPts}-pt cap, so it was moved in to ${d.stop.toFixed(2)} (${d.afterPts} pts). The size stays ${p.contracts}.`, dir: p.dir, phase: 'PAPER', paper: true, version: 'stop-cap-from-fill-v1', fill, stopBefore: d.before, beforePts: d.beforePts, stopAfter: d.stop, afterPts: d.afterPts, capPts: d.capPts, setting: d.setting, floorPts: d.floorPts, contracts: p.contracts, broker: 'paper' }); } catch (e) { /* journal only */ }
    return d;
  }
  function resolvePaperPending(liveBar) {
    let filled = false;
    if (pending.entryType === 'LIMIT') {
      if (pending.dir === 1 && liveBar.l <= pending.entryPrice) filled = true;
      if (pending.dir === -1 && liveBar.h >= pending.entryPrice) filled = true;
    } else if (pending.entryType === 'STOP') {
      if (pending.dir === 1 && liveBar.h >= pending.entryPrice) filled = true;
      if (pending.dir === -1 && liveBar.l <= pending.entryPrice) filled = true;
    }
    const guard = CONFIG.fillSlipGuard && CONFIG.fillSlipGuard.enabled ? CONFIG.fillSlipGuard : null;
    if (filled) {
      // 10/16: with the guard on, a 1m bar that OPENED through the entry (a gap, bar started after the order) fills at its open, like the exchange would
      let fillPx = pending.entryPrice;
      if (guard && Number.isFinite(liveBar.o) && Number.isFinite(liveBar.t) && pending.signalTime != null && liveBar.t >= pending.signalTime) {
        const o = liveBar.o, e = pending.entryPrice, lim = pending.entryType === 'LIMIT';
        if ((lim && pending.dir === 1 && o < e) || (lim && pending.dir === -1 && o > e) || (!lim && pending.dir === 1 && o > e) || (!lim && pending.dir === -1 && o < e)) fillPx = o;
      }
      const slip = fillSlipDecision({ dir: pending.dir, intended: pending.entryPrice, fill: fillPx, stop: pending.stopPrice, guard });
      const paperTp1Pts = CONFIG.tp1FromFill === true && scaleOutRunnerOn(CONFIG) && Number.isFinite(pending.target1) && Number.isFinite(pending.entryPrice) && pending.target1 !== pending.entryPrice ? Math.abs(pending.target1 - pending.entryPrice) : null;   // lv1 r13.3.5 tp1FromFill (PAPER): the planned TP1 distance
      const pfFloor = slip.action !== 'exit' ? stopFloor.postFillStop({ dir: pending.dir, intended: pending.entryPrice, fill: fillPx, plannedStop: pending.stopPrice, slip, floorPts: entryFloorAt(Date.now()).pts, tickSize }) : null;   // entry stop floor from the actual fill (read before pending is cleared)
      log(`  [PAPER FILL] Entry filled: ${pending.dir === 1 ? 'LONG' : 'SHORT'} @ ${fillPx.toFixed(2)} (${pending.source}, grade ${pending.grade})`);
      journalOrderFilled(fillPx);
      position = { ...pending, entryPrice: fillPx, smartHoldChecked: false, leg1Closed: false, leg2Closed: false, leg3Closed: false };
      pending = null;
      if (slip.action === 'shift' && slip.delta) {
        const rt = v => Math.round((v + slip.delta) / tickSize) * tickSize;   // QA 10/16 R5: on the tick, like LIVE's roundToTick
        position.stopPrice = rt(position.stopPrice); position.target1 = rt(position.target1); position.target2 = rt(position.target2); if (position.tightStopPrice != null) position.tightStopPrice = rt(position.tightStopPrice);
        log(`  [PAPER] fill differs from the signal price by ${slip.delta.toFixed(2)} pts - stop/targets shifted to keep the planned distances.`);
      }
      if (paperTp1Pts !== null && slip.action !== 'exit') {   // lv1 r13.3.5 tp1FromFill (PAPER): the live FSM's rule - TP1 from the actual fill on every fill path, the keep included
        const t1 = Math.round((fillPx + position.dir * paperTp1Pts) / tickSize) * tickSize;
        if (t1 !== position.target1) log(`  [PAPER] TP1 FROM THE FILL: TP1 ${t1.toFixed(2)} = the fill ${fillPx.toFixed(2)} ${position.dir === 1 ? '+' : '-'} ${paperTp1Pts.toFixed(2)} pts, not ${position.target1.toFixed(2)}.`);
        position.target1 = t1;
      }
      if (pfFloor && pfFloor.floor && pfFloor.floor.valid && position.stopPrice !== pfFloor.stop) {
        log(`  [PAPER] ENTRY STOP FLOOR: stop ${position.stopPrice.toFixed(2)} is ${pfFloor.floor.naturalPts} pts from the fill ${fillPx.toFixed(2)}; moved out to ${pfFloor.stop.toFixed(2)} (the ${pfFloor.floor.floorPts}-pt floor from the fill).`);
        position.stopPrice = pfFloor.stop;
      }
      if (slip.action !== 'exit') paperStopCap(position, fillPx, pfFloor && pfFloor.floor && Number.isFinite(pfFloor.floor.floorPts) ? pfFloor.floor.floorPts : stopCapFloorMaxOf(CONFIG));   // lv1 r13.6.2
      // r2 (MacDot 6330538954 #4): the smart-hold tight reference is floored on its own on every non-exit fill (LIVE parity), whether or not the resting stop moved
      if (pfFloor && pfFloor.floor && Number.isFinite(pfFloor.floor.floorPts) && position && position.tightStopPrice != null) { const t = stopFloor.applyFloor({ dir: position.dir, entry: fillPx, stop: position.tightStopPrice, floorPts: pfFloor.floor.floorPts, tickSize }); if (t.valid) position.tightStopPrice = t.stop; } else if (slip.action === 'keep') {
        log(`  [PAPER] FILL-SLIPPAGE GUARD: fill ${Math.abs(slip.delta).toFixed(2)} pts from the plan (more than ${slip.threshold.toFixed(2)}): original stop ${position.stopPrice.toFixed(2)} and targets kept.`);
        notifyPhone('Big slip on the entry - stop kept', `[PAPER] filled @ ${fillPx.toFixed(2)}, ${Math.abs(slip.delta).toFixed(2)} pts from the plan. Original stop ${position.stopPrice.toFixed(2)} kept (not shifted).`, { priority: 'high', tags: 'warning' });
      } else if (slip.action === 'exit') {
        const ex = Number.isFinite(liveBar.c) ? liveBar.c : fillPx;
        log(`  [PAPER] FILL-SLIPPAGE GUARD: filled @ ${fillPx.toFixed(2)}, through the planned stop ${position.stopPrice.toFixed(2)} - exiting at market ${ex.toFixed(2)}.`);
        notifyPhone('Filled through the planned stop at news/gap - exited', `[PAPER] ${position.dir === 1 ? 'LONG' : 'SHORT'} filled @ ${fillPx.toFixed(2)}, beyond the planned stop ${position.stopPrice.toFixed(2)}. Closed at market.`, { priority: 'high', tags: 'rotating_light' });
        recordLeg(1, ex, 'filled through the planned stop', position.contracts);
        journalPositionClosed(ex, position.realizedPnlSoFar);
        position = null;
      }
    } else if (entryWindowReason(Date.now())) {
      // BLACKOUT CANCEL (paper path): the bar above did not fill it, so the fill (if any) has already won; otherwise cancel at once.
      // combined fix 4 (Mac 6330904926): the window LEAD counts too (entryWindowReason), so a resting paper entry is cleared BEFORE the window opens, like LIVE.
      const why = entryWindowReason(Date.now());
      log(`  [PAPER] entry cancelled: blackout started (${why}).`);
      journalOrderCanceled('entry cancelled: blackout started (' + why + ')');
      notifyPhone('Entry cancelled: blackout started', `Your unfilled ${pending.dir === 1 ? 'LONG' : 'SHORT'} entry order (paper) was cancelled because the ${why} started. Nothing is open.`, { tags: 'octagonal_sign' });
      pending = null;
    } else if (pending.entryType !== 'MARKET' && (() => { try { return newsRestingBlock(Date.now()); } catch (e) { return null; } })()) {
      const nb = newsRestingBlock(Date.now()), title = String(nb.title).split(' / ')[0];
      log(`  [PAPER] entry pulled before news: ${title} is due.`);
      journalOrderCanceled(`entry pulled before news: ${title} (resting orders are pulled before a high-impact release)`);
      notifyPhone('Entry pulled before news', `Your resting ${pending.dir === 1 ? 'LONG' : 'SHORT'} entry (paper) at ${pending.entryPrice.toFixed(2)} was cancelled before ${title}. Nothing is open.`, { tags: 'octagonal_sign' });
      pending = null;
    } else if (CONFIG.pendingCancelOnStopTouch && pendingStopTouch(pending.dir, pending.stopPrice, [liveBar], pending.signalTime)) {
      const tch = pendingStopTouch(pending.dir, pending.stopPrice, [liveBar], pending.signalTime), st = pending.stopPrice.toFixed(2);
      log(`  [PAPER] entry cancelled: price ${tch.price.toFixed(2)} reached the planned stop ${st} before the ${pending.dir === 1 ? 'LONG' : 'SHORT'} entry at ${pending.entryPrice.toFixed(2)} filled (setup invalid).`);
      markPlanDead(pending.dir, pending.entryPrice, pending.stopPrice);
      try { levelBanAdd(pending.dir, pending.entryPrice, pending.plan ? pending.plan.levelName : null, 'a pending cancel (stop reached before the fill)'); } catch (e) { /* non-fatal */ }   // 10/18 RULE 5
      journalOrderCanceled(`entry cancelled: price reached the planned stop ${st} before the entry filled (setup invalid)`);
      notifyPhone('Entry cancelled: stop reached first', `[PAPER] Your unfilled ${pending.dir === 1 ? 'LONG' : 'SHORT'} entry at ${pending.entryPrice.toFixed(2)} was cancelled: price reached its planned stop ${st} before it filled. Nothing is open.`, { tags: 'octagonal_sign' });
      pending = null;
    } else if (CONFIG.pendingCancelOnStopTouch && Number.isFinite(pending.target1) && pendingStopTouch(-pending.dir, pending.target1, [liveBar], pending.signalTime)) {
      // round 3 (owner 10/16): TP1 traded before the entry filled - the move already happened without us (the fill check above already won if the bar filled it)
      const txt = `Entry cancelled: price reached TP1 ${pending.target1.toFixed(2)} before the entry filled; the move already happened.`;
      log(`  [PAPER] ${txt}`);
      markPlanDead(pending.dir, pending.entryPrice, pending.stopPrice, Date.now(), 'target');
      try { levelBanAdd(pending.dir, pending.entryPrice, pending.plan ? pending.plan.levelName : null, 'a pending cancel (TP1 reached before the fill)'); } catch (e) { /* non-fatal */ }   // 10/18 RULE 5
      try { journalManage('PLAN_TARGET_HIT', `${txt} The resting ${pending.dir === 1 ? 'LONG' : 'SHORT'} entry at ${pending.entryPrice.toFixed(2)} was cancelled unfilled (paper).`, { tp1: pending.target1 }); } catch (e) { /* journal only */ }
      journalOrderCanceled(txt);
      notifyPhone('Entry cancelled: TP1 reached first', `[PAPER] Your unfilled ${pending.dir === 1 ? 'LONG' : 'SHORT'} entry at ${pending.entryPrice.toFixed(2)} was cancelled: price reached TP1 ${pending.target1.toFixed(2)} before it filled. Nothing is open.`, { tags: 'octagonal_sign' });
      pending = null;
    } else if (Date.now() - pending.signalTime >= CONFIG.pendingExpireMs) {
      log('  Pending entry expired unfilled.');
      journalOrderCanceled('pending expired unfilled');
      pending = null;
    }
  }

  function journalPositionClosed(exitPrice, realizedPnl, priceSource = null, exitFills = null) {   // lv1 r13.3.4 sf1: + where the LIVE price came from, and the fills it sums (trade_time estimateFills; not the receipts' broker exitFills)
    if (!openJournalContext) return;
    const ctx = openJournalContext;
    // pnlSource (2026-10-12): LIVE close rows are ESTIMATES (r13.3.4 sf1: priced by the exit orders that closed the trade, see exitFillOf); reconcileJournalWithBroker() later
    // appends the broker-confirmed row for the same journalId. PAPER rows are the simulator's own exact numbers.
    const exitTime = Date.now();
    journalSignalSnapshot(lastMac, lastLv, 'closed', {
      journalId: ctx.journalId, dir: ctx.dir, source: ctx.source, grade: ctx.grade,
      exitPrice, exitTime, realizedPnl, peakUnrealized: ctx.peakUnrealized,
      pnlSource: LIVE ? 'estimate' : 'paper', ...(ctx.setup ? { setup: ctx.setup } : {}),
    });
    try {   // 10/19 (Mac) journal only; r9.1: an unobserved fill-to-close writes an explicitly incomplete row
      if (LIVE) appendJournal({ type: 'trade_time', t: exitTime, journalId: ctx.journalId, dir: ctx.dir, realizedPnl, pnlSource: 'estimate',
        ...(ctx.timer ? ctx.timer.summary({ endAt: exitTime, closePrice: exitPrice, closePriceSource: exitPrice == null ? null : priceSource || 'last bot price', closeTimeSource: 'bot close detection' })
          : journalContext.incompleteTradeTime({ entryTime: ctx.entryTime, endAt: exitTime, reason: 'the bot never observed the filled position before it closed (filled and closed between cycles, or a restart)' })), ...(exitFills ? { estimateFills: exitFills } : {}) });
    } catch (e) { /* journal only */ }
    try { const jr = require('./lib/journalReceipts'); jr.emit(appendJournal, () => jr.economics(ctx.journalId, { exitPrice, exitTime, realizedPnl, pnlSource: LIVE ? 'estimate' : 'paper' }, false)); } catch (_) { /* receipt only */ }
    if (LIVE) queueJournalReconcile(ctx, exitPrice, exitTime, realizedPnl);
    openJournalContext = null;
  }

  // ── Journal <-> broker reconciliation (2026-10-12) ── display/journal only; never feeds a trading decision.
  // brokerConfirmedJournalIds/usedBrokerTradeKeys are seeded from the whole file at startup (backfillJournalFromBroker), so a restart
  // never appends a second corrected row for the same journalId or attaches one broker round trip to two journal trades.
  const brokerConfirmedJournalIds = new Set();
  const usedBrokerTradeKeys = new Set();
  let journalReconcileQueue = []; // candidates (see collectJournalReconcileCandidates) waiting for their broker round trip
  function queueJournalReconcile(ctx, exitPrice, exitTime, realizedPnl) {
    try {
      const entryTimes = [ctx.entryTime ?? exitTime], entryPrices = [ctx.entryPrice];
      for (const en of journalHistory) {
        if (en.type === 'entry' && en.dir === ctx.dir && en.entryPrice != null && Math.abs(en.t - entryTimes[0]) < JOURNAL_MATCH_WINDOW_MS) { entryPrices.push(en.entryPrice); entryTimes.push(en.t); }
      }
      const closedRow = journalHistory.slice().reverse().find(r => r.type === 'signal_check' && r.outcome === 'closed' && r.journalId === ctx.journalId);
      if (!closedRow) return;
      journalReconcileQueue.push({ journalId: ctx.journalId, dir: ctx.dir, entryPrices, entryTimes, exitTime, closedRow });
    } catch (e) { log('  [journal-reconcile] could not queue (non-fatal): ' + e.message); }
  }
  // 2026-10-12 fix 5 (replaces fix 4's placeholder close rows): restart mid-trade.
  // (a) The position the startup reconciliation just adopted is re-linked to its own journal trade: same direction and an entry price
  //     within a tick of the trade's 'traded' row price OR of its real fill price (a MARKET row holds the signal-time price; the
  //     'entry' event holds the fill), so its close is journaled and broker-confirmed like any other trade.
  // (b) Every other filled-but-never-closed journal trade is kept as an IN-MEMORY candidate for the broker backfill that runs right
  //     after: NOTHING is written for it. Only a broker-confirmed 'closed' row (same journalId) is ever appended, or - for a trade
  //     older than one full trading day with no matching fill in the fetched window - one 'canceled' row (see backfillJournalFromBroker).
  //     In PAPER mode there is no broker and the paper position did not survive the restart, so those trades get one 'canceled' row now.
  // Journal/display only: nothing here is read by an entry, exit or risk decision.
  let openTradeCandidates = []; // candidates for open-without-close journal trades, consumed by backfillJournalFromBroker()
  async function reconcileOpenJournalTrades() {
    let lines;
    try { lines = fs.readFileSync(TRADE_JOURNAL_FILE, 'utf8').split('\n').filter(Boolean); }
    catch (e) { return; }
    const events = [];
    for (const line of lines) { try { events.push(JSON.parse(line)); } catch (e) { /* skip bad line */ } }
    const sinceMs = journalBackfillSinceMs(Date.now(), JOURNAL_BACKFILL_TRADING_DAYS, tradingDayKey);
    const open = findOpenJournalTrades(events, sinceMs);
    if (!open.length) return;
    let relinked = null;
    if (LIVE && stateMachine && stateMachine.phase !== 'FLAT' && !openJournalContext) {
      const tol = tickSize + 0.01;
      const cand = open.slice().reverse().find(o => o.dir === stateMachine.dir && o.entryPrices.some(p => Math.abs(p - stateMachine.entryPrice) < tol));
      if (cand) {
        openJournalContext = { journalId: cand.journalId, dir: cand.dir, contracts: cand.contracts, entryPrice: stateMachine.entryPrice, source: cand.source, grade: cand.grade, peakUnrealized: 0, entryTime: cand.tradedT };
        relinked = cand.journalId;
        log(`[journal] restart mid-trade: adopted ${cand.dir === 1 ? 'LONG' : 'SHORT'} @ ${stateMachine.entryPrice} re-linked to journal trade ${cand.journalId.slice(0, 8)} - its close will be journaled and broker-confirmed.`);
      }
    }
    const rest = open.filter(o => o.journalId !== relinked);
    if (!rest.length) return;
    if (!LIVE) {
      for (const o of rest) appendJournal({ type: 'signal_check', t: Date.now(), journalId: o.journalId, outcome: 'canceled', dir: o.dir, source: o.source, grade: o.grade, reason: 'process restart (paper mode), open paper position was not persisted' });
      log(`[journal] restart reconcile (paper): ${rest.length} filled journal trade(s) had no close row - marked canceled (paper positions do not survive a restart).`);
      return;
    }
    openTradeCandidates = rest.map(o => openTradeToCandidate(o, Date.now()));
    log(`[journal] restart reconcile: ${rest.length} filled journal trade(s) had no close row - looking for their fills at the broker (nothing is written unless a broker round trip matches).`);
  }

  // Called after every LIVE refreshRecentTrades() (no extra API call). Appends ONE corrected 'closed' row per matched journalId.
  function reconcileJournalWithBroker(trades, via, candidates = journalReconcileQueue) {
    const now = Date.now();
    let matched = 0;
    const left = [];
    for (const cand of candidates) {
      if (brokerConfirmedJournalIds.has(cand.journalId)) continue;
      const t = matchBrokerTradeForJournal(cand, trades, usedBrokerTradeKeys, tickSize);
      if (t) {
        const row = buildBrokerClosedRow(cand.closedRow, t, now, via);
        appendJournal(row);
        try { const jr = require('./lib/journalReceipts'); jr.emit(appendJournal, () => jr.economics(cand.journalId, row, true)); } catch (_) { /* receipt only */ }
        brokerConfirmedJournalIds.add(cand.journalId);
        usedBrokerTradeKeys.add(row.brokerTradeKey);
        matched++;
        if (via === 'live') log(`  [journal-reconcile] ${cand.journalId.slice(0, 8)}: broker exit ${row.exitPrice} net ${row.realizedPnl} (fees ${row.fees}) replaces estimate exit ${row.estimatedExitPrice} / ${row.estimatedPnl}`);
      } else if (via === 'live' && now - cand.exitTime > JOURNAL_RECONCILE_GIVEUP_MS) {
        log(`  [journal-reconcile] ${cand.journalId.slice(0, 8)}: no matching broker round trip ${Math.round(JOURNAL_RECONCILE_GIVEUP_MS / 60000)} min after the close - keeping the estimate (pnlSource 'estimate').`);
      } else {
        left.push(cand);
      }
    }
    if (candidates === journalReconcileQueue) journalReconcileQueue = left;
    return { matched, unmatched: left.length };
  }
  // Startup backfill: closed rows from the last JOURNAL_BACKFILL_TRADING_DAYS trading days with no broker row -> ONE Trade/search
  // call from the earliest such trading day. Non-fatal on any error.
  async function backfillJournalFromBroker() {
    let lines;
    try { lines = fs.readFileSync(TRADE_JOURNAL_FILE, 'utf8').split('\n').filter(Boolean); }
    catch (e) { return; }
    const events = [];
    for (const line of lines) { try { events.push(JSON.parse(line)); } catch (e) { /* skip bad line */ } }
    const sinceMs = journalBackfillSinceMs(Date.now(), JOURNAL_BACKFILL_TRADING_DAYS, tradingDayKey);
    const { candidates: estCandidates, confirmed, usedBrokerKeys } = collectJournalReconcileCandidates(events, sinceMs);
    for (const id of confirmed) brokerConfirmedJournalIds.add(id);
    for (const k of usedBrokerKeys) usedBrokerTradeKeys.add(k);
    // fix 5: estimate-only closed rows first, then the open-without-close trades (so a never-filled signal can never take a round trip
    // that belongs to a trade with a real close row)
    const openCands = openTradeCandidates.filter(c => !confirmed.has(c.journalId));
    openTradeCandidates = [];
    const candidates = estCandidates.concat(openCands);
    // fix 5: one-time fee re-correction of broker rows written with exit-side fees only (see collectFeeRecorrectionCandidates)
    const recorr = LIVE ? collectFeeRecorrectionCandidates(events, sinceMs) : [];
    if (!LIVE || (!candidates.length && !recorr.length)) {
      log(`[journal-reconcile] startup: ${confirmed.size} journal trades already broker-confirmed; ${candidates.length} estimate-only closed rows in the last ${JOURNAL_BACKFILL_TRADING_DAYS} trading days${LIVE ? '' : ' (paper mode - nothing to reconcile)'}.`);
      return;
    }
    const earliest = Math.min(...candidates.map(c => Math.min(...c.entryTimes)), ...recorr.map(r => r.brokerEntryTime || r.exitTime || r.t));
    const startMs = tradingDayKey(earliest);
    try {
      const d = await ptxFetch('/api/Trade/search', { accountId: account.id, startTimestamp: new Date(startMs).toISOString() }, token);
      const product = contractProduct(contractId);
      const byContract = new Map();
      for (const f of (d?.trades || [])) {
        if (f.price == null || f.voided || contractProduct(f.contractId) !== product) continue;
        if (!byContract.has(f.contractId)) byContract.set(f.contractId, []);
        byContract.get(f.contractId).push(f);
      }
      const trades = [];
      for (const fills of byContract.values()) trades.push(...computeRecentTrades(fills));
      const r = candidates.length ? reconcileJournalWithBroker(trades, 'startup-backfill', candidates) : { matched: 0, unmatched: 0 };
      log(`[journal-reconcile] startup backfill since ${new Date(startMs).toISOString().slice(0, 10)}: ${candidates.length} candidates (${estCandidates.length} estimate-only closed rows + ${openCands.length} open-without-close trades) -> ${r.matched} corrected from broker fills, ${r.unmatched} unmatched (no matching fill); ${confirmed.size} were already confirmed.`);
      // fix 5: an open-without-close trade with no broker fill, older than one full trading day, was never filled (or its fills are gone):
      // ONE 'canceled' row ends it. Only when the fetched fills reach back to (before) the trade, so a short broker history never cancels a
      // real trade. Younger trades are left alone; the next restart looks again.
      const firstFillMs = Math.min(...(d?.trades || []).map(f => Date.parse(f.creationTimestamp)).filter(x => !Number.isNaN(x)));
      const oldBefore = journalBackfillSinceMs(Date.now(), 2, tradingDayKey);
      let canceledN = 0;
      for (const c of openCands) {
        if (brokerConfirmedJournalIds.has(c.journalId) || !(c.tradedT < oldBefore) || !(firstFillMs <= c.tradedT)) continue;
        appendJournal({ type: 'signal_check', t: Date.now(), journalId: c.journalId, outcome: 'canceled', dir: c.dir, source: c.closedRow.source, grade: c.closedRow.grade, reason: 'no broker fill found for this order after restart' });
        canceledN++;
      }
      let feeFixed = 0;
      if (recorr.length) {
        const byKey = new Map(trades.map(t => [normBrokerKey(brokerTradeKey(t)), t]));
        for (const row of recorr) {
          const nr = buildFeeRecorrectionRow(row, byKey.get(normBrokerKey(row.brokerTradeKey)), Date.now());
          if (nr) { appendJournal(nr); feeFixed++; }
        }
        log(`[journal-reconcile] fee re-correction (all fills, entry side included): ${recorr.length} broker rows had exit-side fees only -> ${feeFixed} superseded by a corrected row${feeFixed < recorr.length ? ` (${recorr.length - feeFixed} unchanged or their fills are outside the fetched window)` : ''}.`);
      }
      if (canceledN) log(`[journal-reconcile] ${canceledN} filled-looking journal trade(s) older than one trading day have no fill at the broker - marked canceled.`);
    } catch (e) {
      log('[journal-reconcile] startup backfill skipped (non-fatal): ' + e.message);
    }
  }

  // LIVE's external phase-transition watch — called every fast-poll cycle,
  // comparing stateMachine.phase before/after tick() (+ the smart-hold/
  // ratchet/profit-lock calls right after it, which can also cause a close).
  // Any non-FLAT -> FLAT transition covers every closing path uniformly
  // (natural stop/target fill goes straight there; a manual or time-stop
  // flatten goes through FLATTENING first) without needing to enumerate
  // which specific path fired. exitPrice/realizedPnl are same-poll-cycle
  // ESTIMATES off lastKnownClose — the broker's own Trade/search-derived
  // recentTrades stays the authoritative P&L source (unchanged, B4).
  // ── TRADE LOG (journal/display only; see TRADE-LOG HELPERS above) ──
  // trade_manage: one row per management event of the open trade, keyed by the trade's journalId, with a reason code and one plain-English sentence.
  // ── lv1 r13.3.3 REVERSAL EXIT, shadow log ('log'): journal rows only ──
  // Every poll, right before np1's step, while the position is in LEG1_OPEN (before TP1: the FSM's own phase) with a known fill sighting (npFillAt, np1's
  // clock): each COMPLETE 1m bar of this poll's 1m read that the trade has not labelled yet goes through the pure tracker (REVERSAL EXIT (pure), above).
  // Complete = final when the broker built the read: a later bar is in the same read, or the bar had ended by a time before the read when the trade was
  // confirmed in LEG1_OPEN (leg1SeenAt: the last step, or a fast-poll tick that still found LEG1_OPEN). The read's last bar (normally the forming one)
  // waits for the next poll. A trade that left LEG1_OPEN since then gets one last pass: the bars that had ended by leg1SeenAt (np1's check close, when
  // np1 acted in the poll that read it a moment early; the bar before a stop or a TP1 fill that came before the next poll), then nothing more.
  // Rows, appended to the trade journal FILE only:
  //   trade_state      one per complete 1m close in LEG1_OPEN: the state, the signals that hold, the close / best / worst in pts from the fill;
  //   reversal_signal  at the close where R4 or R2 FIRST holds for this trade (so at most one row per signal type; R2+R4 when both first hold at one
  //                    close): the close, the level, the fill-to-level distance and the would-be result of a market exit at that close (first: true on
  //                    the trade's first such row = MacTradeState's REVERSAL_SIGNAL row).
  // It sends NO order, makes NO broker call and sets NO field the trade path reads: the FSM, np1, TP1, the stop and the runner are untouched. Its rows
  // stay out of the in-memory journal history and the trade indexes, so they never evict the rows the broker reconciliation reads, and they are keyed
  // tradeJournalId (not journalId), so no journalId reader groups them. The trade's level is the entry's frozen levelProof (the journal plan's level),
  // noted when the order is taken; none known (an adopted or restored position, or an entry without a level proof) = R2 is UNKNOWN, never guessed.
  // An unknown fill sighting = not assessed.
  const revLevels = new Map();    // journalId -> { price, name, event } (the last 50 entries)
  let revTrade = null;            // { fillAt, jid, contracts, levelName, levelEvent, leg1SeenAt, done, tr } for the position being labelled (one per npFillAt)
  function revLevelNote(journalId, proof) {
    const r = CONFIG.reversalExit; if (!r || r.mode !== 'log') return;
    if (journalId == null || !proof || typeof proof.price !== 'number' || !Number.isFinite(proof.price)) return;
    revLevels.set(journalId, { price: proof.price, name: typeof proof.name === 'string' ? proof.name : null, event: typeof proof.event === 'string' ? proof.event : null });
    if (revLevels.size > 50) revLevels.delete(revLevels.keys().next().value);
  }
  function revRow(row) {   // the trade journal file only (no history, no index, no plan terminals); never throws
    try { fs.appendFileSync(TRADE_JOURNAL_FILE, JSON.stringify(journalStampId ? { ...row, stampId: journalStampId } : row) + '\n'); return true; } catch (e) { return false; }
  }
  function reversalExitStep(m1, now = Date.now()) {
    const cfg = CONFIG.reversalExit;
    if (!cfg || cfg.mode !== 'log') return 0;
    const sm = stateMachine;
    if (!sm || sm.desynced) return 0;
    if (sm.phase !== 'LEG1_OPEN') { const T = revTrade; if (!T || T.done) return 0; T.done = true; return revLabel(T, m1, b => b.t + 60000 <= T.leg1SeenAt, now); }
    const fillAt = sm.npFillAt, entry = sm.entryPrice, dir = sm.dir, contracts = sm.contracts;
    if (typeof fillAt !== 'number' || !Number.isFinite(fillAt) || typeof entry !== 'number' || !Number.isFinite(entry) || !(dir === 1 || dir === -1)) return 0;
    const jc = openJournalContext || pendingJournalContext, jid = jc ? jc.journalId : null;   // the FSM's own journalIdFn (a resting fill: pending until the lifecycle runs)
    if (!revTrade || revTrade.fillAt !== fillAt || revTrade.tr.dir !== dir) {   // one tracker per fill sighting (npFillAt is set once per trade)
      revTrade = { fillAt, jid: null, contracts: null, levelName: null, levelEvent: null, leg1SeenAt: null, done: false,
        tr: revTrackerNew({ dir, entry, fillAt, level: null, momentumBars: cfg.momentumBars, momentumPts: cfg.momentumPts, levelPts: cfg.levelPts }) };
    }
    const T = revTrade, seen = T.leg1SeenAt;   // before this poll's read (null on the trade's first step)
    if (T.done) return 0;   // this fill already left LEG1_OPEN once: never labelled again
    if (T.jid === null && jid != null) {   // the trade's journal id, once known; its level (the entry's levelProof) from then on: R2 is evaluated from that close on
      T.jid = jid; const lv = revLevels.get(jid);
      if (lv && T.tr.level === null) { T.tr.level = lv.price; T.levelName = lv.name; T.levelEvent = lv.event; }
    }
    T.leg1SeenAt = now; if (Number.isFinite(contracts)) T.contracts = contracts;
    const ts = (Array.isArray(m1) ? m1 : []).map(b => b && b.t).filter(Number.isFinite), lastT = ts.length ? Math.max(...ts) : -Infinity;
    return revLabel(T, m1, b => b.t < lastT || (seen !== null && b.t + 60000 <= seen), now);
  }
  function revLeg1Seen(t) {   // the fast poll: its tick read the position after time t and the FSM is still in LEG1_OPEN = the trade was open at t (in memory only)
    const cfg = CONFIG.reversalExit, T = revTrade, sm = stateMachine;
    if (!cfg || cfg.mode !== 'log' || !T || T.done || !sm || sm.desynced || sm.phase !== 'LEG1_OPEN' || sm.npFillAt !== T.fillAt || !Number.isFinite(t)) return;
    if (T.leg1SeenAt === null || t > T.leg1SeenAt) T.leg1SeenAt = t;
  }
  function revLabel(T, m1, complete, now) {   // the rows for every complete bar of this read that the trade has not labelled yet
    const tr = T.tr, dir = tr.dir, entry = tr.entry, n = T.contracts, pv = typeof pointValue === 'number' && Number.isFinite(pointValue) ? pointValue : 2;
    const cents = x => Math.round(x * 100) / 100, utc = ms => new Date(ms).toISOString().slice(11, 16), bc = CONFIG.brokerCosts;
    const perCt = bc && Number.isFinite(bc.feePerContractSide) && Number.isFinite(bc.commissionPerContractSide) ? 2 * (bc.feePerContractSide + bc.commissionPerContractSide) : null;   // CONFIG.brokerCosts: $1.22 per contract round trip (= tslib's FEE)
    const bars = (Array.isArray(m1) ? m1 : []).filter(b => b && Number.isFinite(b.t) && b.t + 60000 <= now && complete(b)).sort((a, b) => a.t - b.t);
    const base = { tradeJournalId: T.jid, mode: 'log', dir, entryPrice: entry, contracts: n, fillSeenAt: T.fillAt, level: tr.level, levelStatus: tr.level === null ? 'UNKNOWN' : 'known' };   // entryPrice: the fill the labels are measured from (the first one seen in LEG1_OPEN)
    let rows = 0;
    for (const b of bars) {
      const s = revTrackerUpdate(tr, b); if (!s) continue;
      const minAfterFill = cents((s.end - T.fillAt) / 60000);
      if (revRow({ type: 'trade_state', code: 'TRADE_STATE', t: s.end, at: now, ...base, k: s.k, barStartMs: s.barT, closeMs: s.end, minAfterFill, state: s.state,
          signals: s.signals, close: s.close, closePts: s.closePts, best: s.best, worst: s.worst, fiveMinClose: s.is5, waveConfirmed: s.waveConfirmed,
          ...(s.gapBefore ? { missedBefore: s.gapBefore } : {}), ...(s.missed ? { missedSoFar: s.missed, r4Evaluated: s.r4Evaluated } : {}), ...(T.done ? { writtenAfterLeg1: true } : {}) })) rows++;
      if (!s.fires.length) continue;
      const signal = s.rev.join('+'), gross = n === null ? null : cents(s.closePts * pv * n), costs = n === null || perCt === null ? null : cents(n * perCt);
      const net = gross === null || costs === null ? null : cents(gross - costs), lvTxt = T.levelName ? `${T.levelName} ${tr.level}` : `the level ${tr.level}`;
      if (revRow({ type: 'reversal_signal', code: 'REVERSAL_SIGNAL', t: s.end, at: now, ...base, signal, newSignals: s.fires, first: s.first, k: s.k, barStartMs: s.barT,
          closeMs: s.end, minAfterFill, close: s.close, closePts: s.closePts, levelName: T.levelName, levelEvent: T.levelEvent,
          levelSource: tr.level === null ? 'none' : 'journal plan (the entry\'s levelProof)', fillVsLevelPts: tr.level === null ? null : dir * (entry - tr.level),
          closeVsLevelPts: tr.level === null ? null : dir * (s.close - tr.level), wouldBeGrossUsd: gross, costsUsd: costs, wouldBeUsd: net,
          rule: { momentumBars: tr.n4, momentumPts: tr.r4, levelPts: tr.r2 },
          text: `Shadow only (no order sent): ${s.rev.map(x => x === 'R4' ? `R4 momentum flush (${tr.n4} falling 1m closes, ${tr.r4}+ pts against, past the entry)` : `R2 sweep failed (a 5m close ${tr.r2}+ pts back through ${lvTxt})`).join(' + ')} at the ${utc(s.end)} UTC close ${s.close} (${s.closePts} pts from the fill, ${minAfterFill} min after it). A market exit there would have been about ${net === null ? '?' : `${net >= 0 ? '+' : ''}${net} $`} after costs on ${n === null ? '?' : n} contract(s).` })) rows++;
    }
    return rows;
  }
  function journalManage(code, text, extra = {}) {
    try { const c = openJournalContext || pendingJournalContext; appendJournal({ type: 'trade_manage', t: Date.now(), journalId: c ? c.journalId : null, code, text, ...extra }); } catch (e) { /* journal only */ }
  }
  // lv1 r13.3.3 SIZE_PARTIAL (journal only; Mac 10/30: "What i can control is how we manage the contracts that do get filled"): an entry that filled BELOW the size
  // it was sent at. The order machine keeps and protects what filled (resolvePendingCancel: its own stop, the rest cancelled), exactly as before; this only says
  // so, once per entry, so the scorecard can tell a partial fill from a size-rule skip (SIZE_BELOW_MIN, which never sends an order). The size rule's final-count
  // check (entryQuantityAllowed) is on the ORDER at submit only; a fill that comes in smaller is never checked against it.
  function sizePartialNote() {
    const si = sizeIntent, sm = stateMachine; if (!si || si.noted || !sm || sm.dir !== si.dir) return;
    const filled = sm.contracts; if (!(Number.isInteger(si.contracts) && Number.isInteger(filled) && filled > 0 && filled < si.contracts)) return;
    si.noted = true;
    journalManage('SIZE_PARTIAL', `The entry filled ${filled} of the ${si.contracts} contracts it was sent for; the bot keeps and manages the ${filled} that filled (the rest of the order was cancelled).`,
      { intended: si.contracts, filled, path: si.planPath || si.entryType, source: si.source, entryType: si.entryType, journalId: si.journalId });
  }
  // trade_block: a signal that was blocked, max one row per reason (and direction) per 15m bar.
  const tlBlockSeen = new Map();
  function journalBlock(code, dir, data = {}) {
    try {
      const k = `${code}|${dir}|${data.reasonKey || ''}|${Math.floor(Date.now() / 900000)}`;
      if (CONFIG.levelsOnlyEntries) lvjBlock(code, dir, data);   // lv1 r6: a block on the picked level event - BEFORE the per-code dedupe (the panel dedupes per event + code; levels journal only)
      if (tlBlockSeen.has(k)) return;
      tlBlockSeen.set(k, true); if (tlBlockSeen.size > 400) tlBlockSeen.delete(tlBlockSeen.keys().next().value);
      const { reasonKey, ...rest } = data;
      const tB = Date.now(), cB = openJournalContext || pendingJournalContext;
      appendJournal({ type: 'trade_block', t: tB, code, dir, text: tlBlockText(code, { dir, ...rest }), ...rest, blockId: journalMeta.blockIdFor(code, dir, tB), journalId: rest.journalId ?? (cB ? cB.journalId : null) });   // journal metadata r1.2
    } catch (e) { /* journal only */ }
  }
  const tlAgo = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'under a minute ago' : `${m} min ago`; };
  const tlHm = ms => new Date(ms).toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' }) + ' PT';
  // 10-18b1 CONTROL_FLIP: the side in control (15m Levels PRO score vs controlGateMin) changed since the last report: one journal row and one
  // INFO push, at most one per 15m bar (a flip back within the same bar is reported at the next bar, from the last REPORTED side). Journal/push only.
  let ctrlReported = null, ctrlFlipBar = null, ctrlLastValid = null, ctrlUnknownBar = null;   // ctrlLastValid: last decided side pushed/baselined (UNKNOWN gaps do not re-trigger pushes)
  function noteControlSide(lv) {
    const ctl = controlDisplaySnapshot(lv), side = ctl.valid ? ctl.side : 'U', now = Date.now(), bar = Math.floor(now / 900000);
    if (ctrlReported === null) { ctrlReported = side; if (side !== 'U') ctrlLastValid = side; return; }   // first evaluation after a start: the baseline, not a flip
    if (side === ctrlReported) return;
    if (side !== 'U' && ctrlLastValid === null) { ctrlLastValid = side; ctrlReported = side; return; }   // first decided reading after start: baseline, not a flip
    const realFlip = side !== 'U' && side !== ctrlLastValid;   // a recovery to the last decided side is not a flip
    if (side === 'U' ? bar === ctrlUnknownBar : (realFlip && bar === ctrlFlipBar)) return;   // one UNKNOWN row and one real flip per 15m bar; recoveries use neither slot
    const nm = d => d === 'U' ? 'UNKNOWN' : d === 1 ? 'BUYERS' : d === -1 ? 'SELLERS' : 'CONTESTED';
    const score = ctl.valid ? Math.round(ctl.score * 1000) / 1000 : null;
    const rule = side === 'U' ? 'No new entries while control is UNKNOWN (no valid 15m Levels PRO evaluation).' : side === 0 ? (CONFIG.controlContestedMinSize ? 'Contested: new entries at minimum size (1 contract).' : 'No new entries while contested.') : `New entries only ${side === 1 ? 'LONG' : 'SHORT'}.`;
    appendJournal({ type: 'control_flip', code: 'CONTROL_FLIP', t: now, from: nm(ctrlReported), to: nm(side), dir: side === 'U' ? null : side, bias: score, valid: ctl.valid, threshold: CONFIG.controlGateMin,
      text: `Control changed: ${nm(ctrlReported)} -> ${nm(side)} (15m Levels PRO control score ${score == null ? '?' : score}, line +/-${CONFIG.controlGateMin}). ${rule}` });
    if (realFlip) notifyPhone(`Control: ${nm(side)}`, `was ${nm(ctrlLastValid ?? ctrlReported)}; 15m control score ${score} (line +/-${CONFIG.controlGateMin}). ${rule}`, { tags: 'scales' });
    if (side === 'U') ctrlUnknownBar = bar; else { if (realFlip) ctrlFlipBar = bar; ctrlLastValid = side; }
    ctrlReported = side;
  }
  // the same signal decideSignal() would see, for logging only (pure, no side effects)
  function tlPeekSignal(mac, lv, isIntrabar) {
    try { return decideSignal(mac, lv, { ...CONFIG, requireVolSpike: isIntrabar && CONFIG.intrabarRequireVolSpike, blockMacSourceIntrabar: isIntrabar && CONFIG.intrabarRestrictToLevelsSource }, Date.now()); } catch (e) { return null; }
  }
  function tlSettings(dir) {
    const rec = stopOuts[dir];
    return {
      minMacScore: CONFIG.minMacScore, blockMacGradeB: CONFIG.blockMacGradeB, blockGradeCAsia: CONFIG.blockGradeCAsia, requireLevelsAlignment: CONFIG.requireLevelsAlignment, levelsUsePersistedPlan: CONFIG.levelsUsePersistedPlan,
      macStrongRequired: CONFIG.macStrongRequired, levelsTriggerRequired: CONFIG.levelsTriggerRequired, macIntrabarAllGrades: CONFIG.macIntrabarAllGrades, intrabarAllowMacGrades: CONFIG.intrabarAllowMacGrades,   // 10-18b1
      controlDirectionGate: CONFIG.controlDirectionGate, controlGateMin: CONFIG.controlGateMin, controlContestedMinSize: CONFIG.controlContestedMinSize,   // 10-18b1; 10-18b2c
      evaluationMode: CONFIG.evaluationMode, intrabarRestrictToLevelsSource: CONFIG.intrabarRestrictToLevelsSource, smartStopHold: CONFIG.smartStopHold,
      cooldown: { enabled: CONFIG.reentryCooldown, bars: CONFIG.reentryCooldownBars, activeForThisDirection: rec && Date.now() < rec.until ? { stoppedAt: rec.t, until: rec.until } : null },
      profitTrail: CONFIG.profitTrail ? { ...CONFIG.profitTrail } : null,
      runnerTrail: CONFIG.scaleOutRunner?.enabled === true ? { lockPts: CONFIG.scaleOutRunner.runnerLockPts, stepPoints: CONFIG.scaleOutRunner.runnerStepPts, rule: 'so1' } : { lockDollars: MECH_TRAIL_LOCK_DOLLARS, stepPoints: CONFIG.trailStepPoints }, entryGuard: CONFIG.entryGuard,
    };
  }
  // trade_plan: the full "why" of one entry (all paths). sc = the call site's local facts; tk = what takeEntry() is about to send.
  function journalTradePlan(sc, tk) {
    try {
      const { mac, lv, sig } = sc;
      let cl = null; try { const c = computeEntryChecklist(mac, lv, Date.now()); cl = { pass: c.items.filter(i => i.pass === true).map(i => i.label), fail: c.items.filter(i => i.pass === false).map(i => `${i.label}: ${i.detail}`) }; } catch (e) { /* optional */ }
      const trigger = {
        mac: { verdict: mac.verdict, bias: mac.biasStr, score: mac.activeScore, longScore: mac.longFinal, shortScore: mac.shortFinal, grade: mac.entryGrade, activeDir: mac.activeDir,
          vetoesPassed: [!mac.hardBlock && 'MAC hard block clear', !mac.rsi4hVetoLong && !mac.rsi4hVetoShort && '4H RSI veto clear', !mac.mtfVetoLong && !mac.mtfVetoShort && 'multi-TF RSI veto clear', !mac.chopSkip && 'ADX chop filter clear', !(CONFIG.blockMacCompression && mac.volCompression) && 'volume not compressed'].filter(Boolean),
          trap: { bull: !!mac.trapBullNow, bear: !!mac.trapBearNow },
          rsi: { h4: mac.rsiH4Now ?? null, m15: mac.rsiNow15 ?? null, m30: mac.rsiNow30 ?? null, h1: mac.rsiNow1h ?? null, vetoes: CONFIG.rsiVetoes !== false } },   // 10/18: RSI readings as information (the vetoes are off unless set-rsi-veto.sh on)
        levels: { bias: lv.biasStr, biasScore: lv.biasScore, tfAlign: lv.tfAlign, ...(lv.alignText ? { alignText: lv.alignText } : {}), triggerTf: lv.triggerTf || null, plan: lv.plan ? { dir: lv.plan.dir, grade: lv.plan.grade, rr: lv.plan.rr, entryType: lv.plan.entryType, entry: lv.plan.entry, stop: lv.plan.stop, target: lv.plan.target, targetName: lv.plan.targetName } : null,
          inPlay: lv.inPlayLevel ? { name: lv.inPlayLevel.name, behavior: lv.inPlayLevel.behavior } : null },
        checklist: cl,
      };
      const stop = tlStopBasis(sc.stopBasis, tk.dir, sc.stopEntryRef, tk.stopPrice, tk.tightStopPrice, CONFIG.smartStopHold);
      const t2 = tlDescribeTarget2(tk.dir, sc.stopEntryRef, tk.target1, sc.t2BasisPoints != null ? sc.t2BasisPoints : sc.target1Points, sc.structTarget, sc.t2Multiple, sc.asiaStruct, tk.target2, lv.levels);   // 10/18: TP2 keeps today's basis
      const row = buildTradePlanRow({
        t: Date.now(), journalId: tk.journalId, dir: tk.dir, path: sc.path, source: tk.source, grade: tk.grade, intrabar: !!(tk.signalContext && tk.signalContext.isIntrabar), timeframe: lv.triggerTf || '15m', trigger,
        entryType: tk.entryType, entryPrice: tk.entryPrice, refPrice: sc.refPrice, entryWhy: sc.entryWhy, pointValue, entryLevel: tk.signalContext ? tk.signalContext.entryLevel ?? null : null,
        stop: { price: tk.stopPrice, tightRefPrice: tk.tightStopPrice, points: stop.pts, text: stop.text },
        contracts: tk.contracts, leg1Size: tk.leg1Size, leg2Size: tk.leg2Size,
        baseHit: tk.sessionExit ? tk.sessionExit.text : null,
        tp1: tk.sessionExit ? { price: tk.target1, text: `${tk.sessionExit.text}: the ${tk.sessionExit.out} contracts that are not runners exit together at ONE limit ${tlP(tk.sessionExit.targetPoints)} pts from the entry (${tk.sessionExit.how === 'fixed' ? 'fixed distance, CONFIG.sessionExits.' + tk.sessionExit.session + '.targetPoints' : tk.sessionExit.how}); the TP1/TP2 legs are replaced for this trade only` } : CONFIG.scaleOutRunner?.enabled === true && tk.contracts > 1 && tk.leg1Size >= tk.contracts ? { price: tk.target1, text: `full exit: all ${tk.contracts} contracts exit at the plan target (${tlP(Math.abs(tk.target1 - tk.entryPrice))} pts from entry); this path takes no runner, so the so1 scale-out / runner trail does not apply` }
          : CONFIG.scaleOutRunner?.enabled === true ? { price: tk.target1, text: `scale-out: ${tlP(sc.target1Points)} pts from entry (scaleOutRunner, the same at every size); ${tk.leg1Size} of ${tk.contracts} contract${tk.contracts === 1 ? '' : 's'} exit there${tk.contracts > 1 ? `, 1 runner: stop +${CONFIG.scaleOutRunner.runnerLockPts} then ${CONFIG.scaleOutRunner.runnerLockPts} pts behind the best price in ${CONFIG.scaleOutRunner.runnerStepPts}-pt steps` : ''}` } : (CONFIG.firstScalePts > 0 ? { price: tk.target1, text: `first scale: ${tlP(sc.target1Points)} pts from entry (firstScalePts, the same at every size); ${tk.leg1Size} of ${tk.contracts} contract${tk.contracts === 1 ? '' : 's'} exit there` } : { price: tk.target1, text: `${sc.offPeak ? 'off-peak' : 'NY-session'} goal ${tlUsd(sc.goalUsd)} total at TP1 / (${Math.max(tk.leg1Size, legSplit(CONFIG.baseContracts, CONFIG).leg1)} contracts x ${tlUsd(pointValue)} per point) = ${tlP(sc.target1Points)} pts from entry` }),
        tp2: tk.sessionExit ? null : { price: tk.target2, kind: t2.kind, text: t2.text },
        settings: tlSettings(tk.dir),
      });
      try { row.candidateBasis = candidateBasis(mac, lv, { dir: tk.dir, source: tk.source }, CONFIG); } catch (e) { /* journal only */ }   // 10-18b1
      try { if (CONFIG.controlDirectionGate) { const ctl = controlDisplaySnapshot(lv); row.control = { side: ctl.valid ? ctl.side : null, score: ctl.score, valid: ctl.valid, min: CONFIG.controlGateMin }; } } catch (e) { /* journal only */ }   // 10-18b1
      try { const m = newsNearestMin(Date.now()); if (m != null) row.newsWithinMin = m; } catch (e) { /* journal only */ }   // 10/16
      try { const f = flagsForJournal(); if (f) row.flags = f; } catch (e) { /* journal only */ }   // 10/17 session flag count
      try { if (lastSizing && lastSizing.contracts === tk.contracts && Date.now() - lastSizing.t < 60000) row.riskCap = { cap: lastSizing.cap, stopPts: lastSizing.stopPts, riskUsd: lastSizing.riskUsd, text: lastSizing.text }; } catch (e) { /* journal only */ }   // 10/18 RULE 1
      try { const g = lastGate[tk.dir]; if (g && Date.now() - g.t < 60000) { row.directionGate = { ok: g.ok, why: g.why }; if (g.pullback && g.pullback.ok) { const steps = ['C', 'B', 'A', 'A+'], i = steps.indexOf(tk.grade); row.pullback = { ...g.pullback, gradeAfterConfluence: g.pullback.confluence && g.pullback.confluence.length && i >= 0 ? steps[Math.min(i + 1, 3)] : tk.grade }; } } if (sc.reclaim) row.reclaim = sc.reclaim; } catch (e) { /* journal only */ }   // 10/18 RULES 4/6 + addendum 4 (confluence +1 grade step, journal only)
      try { if (sc.stopCapAttemptId) row.stopCapAttemptId = sc.stopCapAttemptId; } catch (e) { /* journal only */ }   // stop-cap shadow v2.1: the exact attemptId this plan came from (no price/time matching)
      appendJournal(row);
      return row;   // notification only: the Signal push reuses this row's facts
    } catch (e) { /* journal only */ }
    return null;
  }
  // 10/19 journal only (Mac): time winning vs losing while the position is open. Called at the start of watchLiveLifecycle AND right after a
  // fill is journaled (r9.1: so the fill cycle itself is the first observation).
  function journalTimerTick(phaseAfter) {
    try {
      if (phaseAfter !== 'FLAT' && phaseAfter !== 'PENDING_ENTRY' && openJournalContext && Number.isFinite(stateMachine.entryPrice)) {
        const c = openJournalContext;
        // starts at THIS first observation of the filled position (never at order send); c.entryTime as journaled is kept for the unobserved part
        if (!c.timer) c.timer = journalContext.createTradeTimer({ dir: stateMachine.dir, entryPrice: stateMachine.entryPrice, startAt: Date.now(), entryTime: c.entryTime, pointValue, contracts: c.contracts });
        if (livePx && Number.isFinite(livePx.price) && livePx.t !== c.timerPxT) { c.timerPxT = livePx.t; c.timer.sample(livePx.t, livePx.price, Date.now()); }   // each quote offered once
      }
    } catch (e) { /* journal only */ }
  }
  // lv1 r13.3.4 sf1: the open trade's exit-order fills, booked from the FSM's own journal rows (sfJournal = appendJournal + the booking; the FSM is unchanged).
  // At the close (sfClose) they price the win / loss read - the cooldown and its text, onLossClose (the same-level ban) - and the journal's estimate.
  let sfBook = null;   // { dir, entry, n0, fills: [{ c, px, src, fin, code, t }] }
  function sfJournal(r) {
    try { const f = r && r.type === 'trade_manage' ? exitFillOf(r.code, stateMachine, r) : null; if (f && f.length) { if (!sfBook) sfBook = { dir: stateMachine.dir, entry: stateMachine.entryPrice, n0: null, fills: [] }; for (const x of f) sfBook.fills.push({ ...x, code: r.code, t: r.t }); } } catch (e) { /* journal only */ }
    return appendJournal(r);
  }
  function sfOpen(ph) {   // the first sight of the open position: its size; a trade first seen past TP1 (a restart) books its TP1 contracts at the TP1 limit
    const sm = stateMachine; if (!sm || (sm.dir !== 1 && sm.dir !== -1) || !Number.isFinite(sm.entryPrice) || !(Number.isInteger(sm.contracts) && sm.contracts > 0)) return;
    if (!sfBook) sfBook = { dir: sm.dir, entry: sm.entryPrice, n0: null, fills: [] };
    if (sfBook.n0 != null) return;
    sfBook.n0 = sm.contracts;
    if ((ph === 'LEG23_OPEN' || ph === 'LEG3_OPEN') && !sfBook.fills.length) {
      sfBook.fills.push({ c: sm.leg1Size, px: Number.isFinite(sm.target1) ? sm.target1 : null, src: 'TP1 limit', fin: false, code: 'SEEN_PAST_TP1', t: Date.now() });
      if (ph === 'LEG3_OPEN' && sm.leg2Size > 0) sfBook.fills.push({ c: sm.leg2Size, px: null, src: 'leg 2 (closed before the bot saw the trade)', fin: false, code: 'SEEN_PAST_TP1', t: Date.now() });
    }
  }
  function sfClose() { const b = sfBook; sfBook = null; return b && b.fills.length + (b.n0 || 0) > 0 ? exitEstimate(b.dir, b.entry, b.n0, b.fills, pointValue, lastKnownClose) : null; }
  function watchLiveLifecycle(phaseBefore) {
    const phaseAfter = stateMachine.phase;
    let sfEst = null;   // lv1 r13.3.4 sf1: this close, priced (sfClose)
    // Keep peakUnrealized fresh every cycle while still open — reset()
    // zeroes stateMachine's own copy the instant phase flips to FLAT, too
    // late to read after the fact.
    if (phaseAfter !== 'FLAT' && openJournalContext) openJournalContext.peakUnrealized = stateMachine.peakUnrealized;
    journalTimerTick(phaseAfter);
    if (phaseAfter === 'LEG1_OPEN' || phaseAfter === 'LEG23_OPEN' || phaseAfter === 'LEG3_OPEN' || phaseAfter === 'FLATTENING') { try { sfOpen(phaseAfter); } catch (e) { /* sf1: journal / win-loss read only */ } }
    // HOTFIX 1/3: remember the trend position's direction, whether it ever FILLED, whether it got past TP1 (leg1) and its entry price, so a pre-TP1 LOSING
    // close starts the re-entry cooldown. trendLife is dropped every time the machine is FLAT (also after a flatten that reset() outside this window).
    if (phaseAfter !== 'FLAT') {
      if (!trendLife) trendLife = { dir: stateMachine.dir, filled: false, pastLeg1: false, entryPrice: null, plan: lastEntryPlan && lastEntryPlan.dir === stateMachine.dir ? lastEntryPlan : null };
      if (phaseAfter !== 'PENDING_ENTRY') { trendLife.filled = true; freshStopRec = null; }   // 10-18b2a: the next fill ends the fresh-stop condition
      if (phaseAfter === 'LEG23_OPEN' || phaseAfter === 'LEG3_OPEN') trendLife.pastLeg1 = true;
      if (stateMachine.entryPrice != null) trendLife.entryPrice = stateMachine.entryPrice;
    } else {
      // never filled (cancelled / flattened while PENDING_ENTRY) = not a stop-out; reached TP1 = not a stop-out; closed in profit pre-TP1 (manual/time stop) = not a stop-out
      // 10/18: how the trade ended, as the state machine saw it (a 1-lot that exited whole at TP1 is a win, not a stop-out)
      let lx = null; try { if (LIVE && stateMachine.lastExit) { lx = stateMachine.lastExit; stateMachine.lastExit = null; } } catch (e) { lx = null; }
      try { sfEst = sfClose(); } catch (e) { sfEst = null; }   // lv1 r13.3.4 sf1: priced by the exit orders that closed it, never by an older poll price
      if (lx && lx.kind === 'tp1' && trendLife) trendLife.pastLeg1 = true;
      if (trendLife && trendLife.filled && !trendLife.pastLeg1 && closedAtLoss(trendLife.dir, trendLife.entryPrice, sfEst ? sfEst.closePx : lastKnownClose)) { noteStopOut(trendLife.dir, 'trend stop-out'); try { onLossClose(trendLife, lx); } catch (e) { log('  [level-ban/reclaim] failed (non-fatal): ' + e.message); } }
      else if (trendLife && trendLife.filled) noteWinClose(trendLife.dir, trendLife.pastLeg1 ? 'closed after TP1' : 'closed in profit');   // 10/16 (no-op unless reentryCooldownAfterWin)
      trendLife = null;
    }
    if (phaseBefore === phaseAfter) return;
    if (phaseBefore === 'PENDING_ENTRY') {
      const openPhases = ['LEG1_OPEN', 'LEG23_OPEN', 'LEG3_OPEN'];
      if (openPhases.includes(phaseAfter)) { try { sizePartialNote(); } catch (e) { /* lv1 r13.3.3: journal only */ } journalMarketFilled(stateMachine.entryPrice); journalOrderFilled(stateMachine.entryPrice); journalTimerTick(phaseAfter); return; }   // 18f1: + the MARKET 'traded' row
      if (phaseAfter === 'FLATTENING') { journalMarketFilled(stateMachine.entryPrice); journalOrderFilled(stateMachine.entryPrice); return; }   // 10/16 fill-slippage guard: filled through the stop, closing at market (the close row follows on FLAT)
      if (phaseAfter === 'FLAT' && stateMachine._cancelClosedFill) {
        const closed = stateMachine._cancelClosedFill; stateMachine._cancelClosedFill = null;
        if (pendingJournalContext) pendingJournalContext.contracts = closed.contracts;
        if (marketAttemptContext) marketAttemptContext.contracts = closed.contracts;
        journalMarketFilled(closed.fillPrice); journalOrderFilled(closed.fillPrice);
        if (openJournalContext) journalPositionClosed(null, null); // broker costs/P&L remain unknown until reconciliation
        return;
      }
      if (phaseAfter === 'FLAT') {
        const ctxP = pendingJournalContext, why = (stateMachine.takeCancelReason ? stateMachine.takeCancelReason() : null) || 'order not filled (expired or cancelled)';
        if (/reached the planned stop/.test(why) && ctxP) { markPlanDead(ctxP.dir, ctxP.entryPrice, ctxP.stopPrice); try { levelBanAdd(ctxP.dir, ctxP.entryPrice, ctxP.levelName, 'a pending cancel (stop reached before the fill)'); } catch (e) { /* non-fatal */ } }   // 10/16 dead plan + 10/18 RULE 5
        // r9.6 (MacDot R9.6 #3): the ban is keyed on the cancelled order's own direction + price (FSM lastUnfilledCancel), never on a nullable/stale journal context;
        // the level NAME is borrowed from ctxP only when ctxP describes that same order (same direction, same price).
        else if (/^entry expired/.test(why)) { try { const g = stateMachine.lastUnfilledCancel; if (g && g.reason === why && g.entryType !== 'MARKET' && (g.dir === 1 || g.dir === -1) && Number.isFinite(g.price)) {   // final review S1: MARKET entries are not banned (r9.5 behaviour); N2: same cancel only
            const nm = ctxP && ctxP.dir === g.dir && Number.isFinite(ctxP.entryPrice) && Math.abs(ctxP.entryPrice - g.price) < 0.01 ? ctxP.levelName : null; levelBanAdd(g.dir, g.price, nm, `a pending expiry (unfilled after ${Math.round(CONFIG.pendingExpireMs / 60000)} min)`); } } catch (e) { /* non-fatal */ } }   // r9.5: verified cancel, zero fills (fills take the branches above)
        else if (/price reached TP1/.test(why) && ctxP) { markPlanDead(ctxP.dir, ctxP.entryPrice, ctxP.stopPrice, Date.now(), 'target'); try { levelBanAdd(ctxP.dir, ctxP.entryPrice, ctxP.levelName, 'a pending cancel (TP1 reached before the fill)'); } catch (e) { /* non-fatal */ } }   // round 3 + 10/18 RULE 5
        journalMarketUnfilled(why); journalOrderCanceled(why); return;   // 18f1: + the MARKET 'canceled' row
      }
    }
    if (phaseBefore !== 'FLAT' && phaseAfter === 'FLAT' && openJournalContext) {
      const ctx = openJournalContext;
      if (sfEst) journalPositionClosed(sfEst.closePx, sfEst.realizedPnl, sfEst.source, sfEst.fills);   // lv1 r13.3.4 sf1
      else {   // no booked trade (the bot never saw the position open): the bot's last price, as before
      const exitPrice = lastKnownClose;
      const realizedPnl = exitPrice != null ? (ctx.dir === 1 ? exitPrice - ctx.entryPrice : ctx.entryPrice - exitPrice) * pointValue * ctx.contracts : null;
      journalPositionClosed(exitPrice, realizedPnl, 'last bot price');
      }
    }
  }

  // Reconciliation (2026-09-21, extended 2026-09-22): a process restart
  // previously assumed FLAT unconditionally, even if a REAL position was
  // already open — leaving it with zero resting stop/target and the bot
  // fully unaware it existed. That's the SAME failure mode as a MANUAL
  // trade placed while the bot is scanning: phase stays FLAT, tick() never
  // even looks (it no-ops entirely while FLAT), and the bot could stack an
  // automated entry right on top of your manual one with no idea it's
  // already exposed. This one function now covers BOTH cases — called once
  // at startup, AND every poll cycle while scanning (see the main loop) —
  // by actually checking the REAL account position instead of ever trusting
  // FLAT blindly just because that's what this process last knew.
  async function reconcileIfUnknownPosition(reasonLabel) {
    if (!LIVE || stateMachine.phase !== 'FLAT' || stateMachine.desynced) return false;
    if (tideOwned()) return false;   // [2a] the guard: a TIDE position is the planner's (never adopted under the old path's protection)
    const existingPos = await getOpenPosition(token, account.id, contractId);
    if (!existingPos || !existingPos.size) return false;
    const dir = existingPos.type === 1 ? 1 : -1;
    const size = existingPos.size;
    const entryPrice = existingPos.averagePrice;
    // FIX1015: at startup, first try to RESUME the bot's own trade from the saved state (same side/size/entry): keeps TP1-banked stops, the runner and the lock
    if (reasonLabel === 'STARTUP RECONCILIATION') { const r = await stateMachine.restoreFromState(existingPos); if (r && r.ok) { log(`${reasonLabel}: resumed the bot's own ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} from ${path.basename(TRADE_STATE_FILE)} (phase ${stateMachine.phase}).`); return true; } }
    log(`${reasonLabel}: found an EXISTING open position ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} that this bot didn't open. Adopting it under fresh protective orders instead of risking a stacked entry.`);
    notifyPhone('Unknown position adopted', `Found a real ${dir === 1 ? 'LONG' : 'SHORT'} ${size}x @ ${entryPrice.toFixed(2)} not opened by the bot (${reasonLabel.toLowerCase()}) — adopted under fresh protection.`, { priority: 'high', tags: 'eyes' });
    // Journaled as manual ONLY for the periodic (mid-session) catch — if
    // phase is FLAT and a real position exists at any point other than
    // startup, this bot categorically did not open it (it always advances
    // phase the instant it does). A STARTUP find is genuinely ambiguous —
    // it could be this bot's own trade surviving a restart — so that case
    // isn't asserted as manual either way.
    if (reasonLabel === 'LIVE RECONCILIATION') {
      appendJournal({ type: 'manual_entry', t: Date.now(), dir, entryPrice, contracts: size });
    }
    // No reliable ATR reference exists at exactly this moment — lastLv/
    // lastMac are freshly empty right after a restart, which is precisely
    // when this function needs to run. The old `atrRef || 1` fallback
    // assumed a ~1-POINT ATR, sane-ish for an index-point instrument like
    // MNQ but nonsensically tight for a $4000+/point instrument like gold.
    // A real position on 2026-09-22 got a stop this way that had already
    // been blown through by the time the order reached the exchange,
    // rejected outright as "Invalid price. Price is outside allowed
    // range." instead of placed — leaving 30 contracts naked. capStop
    // already caps every OTHER stop in this file down to exactly
    // target1Points*leg1StopCapMultiple whenever a real ATR is available
    // and large enough, so using that distance directly here matches the
    // normal successful case exactly, while removing the one path that
    // could ever produce something this tight.
    // A position recovered here already existed before this function could
    // know whether it was opened as a normal-hours or NY-session entry — and
    // an NY-session entry is meant to carry the wider nyStopMultiple, not
    // the base leg1StopCapMultiple. Guessing narrow is the wrong side to err
    // on (it's exactly what tagged a real MGC entry's recovered stop at 3pts
    // when the original signal called for 7.5), so use whichever session's
    // multiple is in effect right now — the same check takeEntry()'s own
    // NY-session signals use — rather than always assuming the tighter one.
    const recoveryMinutesOfDay = ptInfo(Date.now()).minutesOfDay;
    const recoveryInNySession = recoveryMinutesOfDay >= 6 * 60 + 30 && recoveryMinutesOfDay < 13 * 60;
    const recoveryStopMultiple = recoveryInNySession ? CONFIG.nyStopMultiple : CONFIG.leg1StopCapMultiple;
    // leg1Size first — target1DollarGoal is now a TOTAL to bank at TP1, not
    // per-contract, so the point-distance has to divide by however many
    // contracts actually close there (same fix as the main signal path below).
    const leg1Size = leg1SizeForContracts(size);
    const leg2Size = leg2SizeForContracts(size, leg1Size);
    // Same off-peak override the main signal path uses (see
    // CONFIG.offPeakTarget1DollarGoal's comment) — a recovered position
    // adopted during Asia/London hours shouldn't get handed a wider NY-sized
    // target it's equally unlikely to reach.
    const recoveryTarget1DollarGoal = (!recoveryInNySession && CONFIG.offPeakTarget1DollarGoal != null) ? CONFIG.offPeakTarget1DollarGoal : CONFIG.target1DollarGoal;
    const recoveryTarget2Multiple = (!recoveryInNySession && CONFIG.offPeakTarget2Multiple != null) ? CONFIG.offPeakTarget2Multiple : CONFIG.target2Multiple;
    const target1Points = tp1PointsFor(recoveryTarget1DollarGoal, leg1Size);   // 10/18 RULE 2
    // Stop-cap reference — deliberately NOT target1Points (see
    // stopCapDollarsPerContract's own comment above): using the leg1Size-
    // shrunk value here would synthesize an artificially tight stop for a
    // recovered large position, exactly the failure mode this function was
    // already rewritten once to avoid.
    const stopCapPoints = CONFIG.stopCapDollarsPerContract / pointValue;
    const risk = stopCapPoints * recoveryStopMultiple;
    const stopPriceRaw = dir === 1 ? entryPrice - risk : entryPrice + risk;
    const stopPrice = capStop(entryPrice, stopPriceRaw, dir, stopCapPoints, recoveryStopMultiple);
    const target1 = dir === 1 ? entryPrice + target1Points : entryPrice - target1Points;
    const target2 = computeTarget2(dir, entryPrice, target1, tp2BasisPoints(recoveryTarget1DollarGoal), null, recoveryTarget2Multiple);   // 10/18: TP2 keeps today's basis
    // FIX1015: no usable saved state - if the journal shows this trade already banked TP1, the stop goes to break-even (never a loss-side stop) and no new TP1
    let tp1Banked = false;
    if (reasonLabel === 'STARTUP RECONCILIATION') { try { tp1Banked = journalShowsTp1(fs.existsSync(TRADE_JOURNAL_FILE) ? fs.readFileSync(TRADE_JOURNAL_FILE, 'utf8').split('\n') : [], existingPos); } catch (e) { tp1Banked = false; } }
    await stateMachine.adoptExistingPosition({ dir, size, entryPrice, stopPrice, target1, target2, leg1Size, leg2Size, tp1Banked });
    return true;
  }
  // so1 r1.6: a saved so1 halt is checked FIRST; while latched there is no pending-entry recovery, no reconciliation, no adoption and no order sweep
  const so1Latch = LIVE ? await stateMachine.so1HaltLatch() : { latched: false };
  if (so1Latch.latched) log(`Startup: so1 HALT still latched (${so1Latch.why}) - no recovery, no adoption; waiting for manual resolution (flat, no open orders), then a restart.`);
  if (LIVE && !so1Latch.latched) {
    let found; for (let attempt = 1; ; attempt++) {   // profittrail4: an unreadable position at startup is retried (never read as "start FLAT"); after 5 tries the process exits and the service restarts it
      // TIME BLOCKS r3: our own resting entry from the previous run is RESTORED as the machine's pending entry BEFORE the position is reconciled; while it is
      // PENDING_ENTRY, reconcileIfUnknownPosition does nothing (phase !== FLAT): no generic adoption, no order sweep, protection sized by the pending lifecycle
      if (attempt === 1) { try { const r = await stateMachine.recoverSavedPendingEntry(); if (r.action !== 'none') log(`Startup: resting entry from the previous run: ${r.action}${r.why ? ' (' + r.why + ')' : ''}${r.phase ? ' (phase ' + r.phase + ')' : ''}.`); } catch (e) { log('  [startup-entry] check failed (non-fatal; retried each pass): ' + e.message); } }
      try { found = await reconcileIfUnknownPosition('STARTUP RECONCILIATION'); break; }
      catch (e) { if (!e.positionUnreadable || attempt >= 5) throw e; log(`Startup reconciliation: broker position unreadable (${e.message}) - retrying (${attempt}/5)`); await sleep(3000); }
    }
    if (!found) log(stateMachine.phase === 'PENDING_ENTRY' ? 'Startup reconciliation: skipped - the machine holds the restored resting entry from the previous run (PENDING_ENTRY).' : 'Startup reconciliation: no existing open position found — starting FLAT.');
  }
  if (LIVE) { try { if (stopCapInit(stateMachine) && stopCap.pending.size) log(`Startup: ${stopCap.pending.size} old stop(s) recorded by the stop cap (${path.basename(STOP_CAP_FILE)}) - checked against the broker's working orders from the first poll; only these recorded ids are ever cancelled.`); } catch (e) { log('  [lv1] stop-cap record check failed at startup (non-fatal; retried every poll): ' + e.message); } }   // lv1 r13.6.2c
  if (tideDrv) { try { await tideDrv.start(); } catch (e) { log(`[tide-live] startup reconcile failed (${e.message}) - retried by the first poll.`); } }   // [2a]
  await reconcileOrphanedPendingJournalRows();
  await reconcileOpenJournalTrades();
  try { await backfillJournalFromBroker(); } catch (e) { log('[journal-reconcile] startup backfill failed (non-fatal): ' + e.message); }

  let position = null; // paper-mode only
  let pending = null;  // paper-mode only
  // 10/19 QA-A (restart at the 3 PM PT rollover; ported to 18f1 from 10-20): start on the SAME day key the day tracker uses (wall clock, weekend frozen on Friday's day), so the
  // bar-driven rollover below never sees a stale pre-3 PM bar as a "new" day and moves the day BACKWARD (see the dayKey > currentDayKey check).
  let currentDayKey = effectiveDayKey(Date.now());
  let dayRealizedPnl = 0, dayRealizedPnlAccountWide = 0, dayBlocked = false;
  let dayPnlAllFills = 0; // fix 5, DISPLAY ONLY (snapshot dayPnlAllFills): see sumClosedRoundTripNet(). dayRealizedPnl above (exit-side fees) still drives the daily stop.
  // Trailing-floor peak (2026-10-07) — the day's running-max account-wide
  // realized P&L, used to arm/raise the trailing floor below. Only ever
  // moves UP intraday, reset to 0 at the next trading-day rollover alongside
  // dayRealizedPnlAccountWide itself. See CONFIG.trailArmThreshold/
  // trailGiveback and the dailyFloor calc in the main loop.
  let dayPeakPnlAccountWide = 0;
  let paperTotalPnl = 0;
  let recentTrades = []; // LIVE-mode only, refreshed alongside dayRealizedPnl — see refreshRecentTrades()
  let livePx = null;         // 10/16 LIVE PRICE ON THE PHONE: { price, t (when read), barT, src } from the 1m bar this loop already fetches (no extra broker call)
  let lastKnownClose = null; // most recent 1m close, for computing live unrealized P&L on whatever's open
  let lastAccountBalance = LIVE ? account.balance : null; // refreshed each poll — see refreshAccountBalance(); used for LIVE equity only
  // Topstep's trailing threshold is END-OF-DAY based (2026-09-22 correction)
  // — it does NOT move with intraday balance swings, only with each day's
  // CLOSING balance. So the floor itself has to be tracked separately from
  // the live/intraday `lastAccountBalance` above: eodPeakBalance only ever
  // updates once, at the daily rollover, using whatever balance was current
  // at that exact moment (= the day that just ended's closing balance) —
  // then stays completely fixed all the way through the next trading day,
  // no matter how balance/equity moves intraday. Real caveat: if this
  // account has never yet reached accountStartingBalance, this in-memory
  // peak is only as good as "every EOD rollover since this process last
  // restarted," not the account's true lifetime EOD high — once balance has
  // ever reached accountStartingBalance the real rule locks the floor
  // permanently at accountStartingBalance - accountMllLimit and this stops
  // mattering (true for this account, whose balance is already above it).
  let eodPeakBalance = LIVE ? account.balance : null;
  // dashfix (display only): start-of-day balance, day peak, wall-clock 5pm CT rollover. Reads lastAccountBalance / computeUnrealizedPnl() but writes nothing the trading code reads.
  const dayTracker = createDayTracker({ file: LIVE ? DAY_STATE_FILE : null, log });
  if (LIVE) dayTracker.load(Date.now());
  let dayFillsKnownFor = null; // trading-day key for which dayPnlAllFills has been read from the broker at least once
  let levelCrossState = {}; // per-level side-flip tracking, so ESTABLISHED levels alert every cross, not once/day
  let biasHistory = []; // intraday timeline for the terminal's bias panel, reset each trading day
  // Fast-read preview (2026-10-09, JayMac's "I want faster reads across the
  // board") — holds the latest INTRABAR-evaluated bias entry so the
  // dashboard's "current" card can update on CONFIG.evaluationIntrabarPollMs
  // cadence (~20s) instead of waiting for a real 15m bar close. Deliberately
  // kept SEPARATE from biasHistory: that array is the trend timeline
  // ("~10 hours of 15m readings") and must only grow once per real close, or
  // the 40-entry cap would shrink the visible window to ~13 minutes. This is
  // display-only, overwritten in place (never appended), and cleared back to
  // null the moment a real bar close lands (writeBiasSnapshot below) so
  // fresh real data always wins over a stale intrabar preview.
  let intrabarPreview = null;
  let lastStatusPushTime = Date.now(); // first periodic status push waits one full interval after the startup notification

  // Reports the bot's OWN known entry/stop/target for whatever's open right
  // now — not re-derived from raw order data in the browser, since the bot
  // already knows the exact answer. Returns null when flat.
  //
  // PENDING_ENTRY used to be left undrawn entirely — reasonable when it was
  // MARKET orders filling within one ~20s poll cycle, but marketable-limit
  // (2026-09-21) and the mac-only pullback-level entries can now leave a
  // real LIMIT order resting unfilled for a while, up to CONFIG.pendingExpireMs.
  // Leaving the chart totally blank the whole time that order is genuinely
  // working reads as "the bot stopped doing anything." Show the PLANNED
  // levels instead, tagged `pending: true` so the terminal can draw them
  // dashed (a working order, not yet a confirmed fill).
  function getDisplayMarkers() {
    if (LIVE) {
      if (!stateMachine || stateMachine.phase === 'FLAT') return null;
      if (stateMachine.phase === 'PENDING_ENTRY') {
        if (stateMachine.dir == null) return null;
        return {
          dir: stateMachine.dir,
          pending: true,
          cancelTarget: { accountId: stateMachine.accountId, contractId: stateMachine.contractId, orderId: stateMachine.entryOrderId, entryIdentity: stateMachine.entryIdentity },
          // 10/16: when the resting entry is cancelled (shown on the phone: "cancels at HH:MM or if price reaches the stop")
          placedAt: stateMachine.entrySignalTime ?? null, expiresAt: stateMachine.entrySignalTime != null && CONFIG.pendingExpireMs ? stateMachine.entrySignalTime + CONFIG.pendingExpireMs : null,
          cancelOnStopTouch: !!CONFIG.pendingCancelOnStopTouch, entryType: stateMachine.entryType ?? null,
          markers: [
            { label: 'PENDING ENTRY', price: stateMachine.intendedEntryPrice, kind: 'entry' },
            { label: 'STOP (planned)', price: stateMachine.stopPriceIntended, kind: 'stop' },
            { label: 'TP1 (planned)', price: stateMachine.target1, kind: 'target' },
            ...(stateMachine.leg2Size > 0 ? [{ label: 'TP2 (planned)', price: stateMachine.target2, kind: 'target' }] : []),   // lv1 r12.1: no leg 2 (so1 scale-out) = no TP2 order
          ],
        };
      }
      if (stateMachine.phase === 'FLATTENING') {
        if (stateMachine.dir == null) return null;
        return {
          dir: stateMachine.dir,
          flattening: true,
          markers: [{ label: 'CLOSING AT MARKET', price: stateMachine.entryPrice, kind: 'entry' }],
        };
      }
      const dir = stateMachine.dir;
      const markers = [{ label: 'ENTRY', price: stateMachine.entryPrice, kind: 'entry' }];
      // 2026-10-14 display fix: show the stop each leg is actually held at. The profit trail (L3) raises EVERY open stop to its lock level
      // (liveStateMachine.js stop-ladder audit, same max/min floor), but this snapshot used to report the raw level (break-even at entry
      // after TP1), so the phone said "break-even" while real profit was locked. Display only: orders are untouched.
      const ptStop = stateMachine.profitTrail ? stateMachine.profitTrailStop : null;
      const fl = lvl => (lvl == null || ptStop == null) ? lvl : (dir === 1 ? Math.max(lvl, ptStop) : Math.min(lvl, ptStop));
      const runnerLvl = () => { const e = stateMachine.entryPrice, t = stateMachine.trailStop ?? e; return fl(dir === 1 ? Math.max(t, e) : Math.min(t, e)); };
      if (stateMachine.phase === 'LEG1_OPEN') {
        markers.push({ label: 'STOP', price: fl(stateMachine.stopPriceIntended), kind: 'stop' });
        markers.push({ label: 'TP1', price: stateMachine.target1, kind: 'target' });
        if (stateMachine.leg2Size > 0) markers.push({ label: 'TP2', price: stateMachine.target2, kind: 'target' });   // lv1 r12.1: no leg 2 = no TP2 order (the runner trails)
      } else if (stateMachine.phase === 'LEG23_OPEN') {
        if (stateMachine.leg2Size > 0) { markers.push({ label: 'BE STOP', price: fl(stateMachine.entryPrice), kind: 'stop' }); markers.push({ label: 'TP2', price: stateMachine.target2, kind: 'target' }); }   // lv1 r12.1: leg 2 only when it exists
        if (stateMachine.leg3StopOrderId != null) { const r = runnerLvl(); if (r != null && (!(stateMachine.leg2Size > 0) || r !== fl(stateMachine.entryPrice))) markers.push({ label: 'TRAIL STOP', price: r, kind: 'stop' }); }
      } else if (stateMachine.phase === 'LEG3_OPEN') {
        markers.push({ label: 'TRAIL STOP', price: runnerLvl(), kind: 'stop' });
      }
      return { dir, markers };
    }
    if (pending || !position) return null;
    const dir = position.dir;
    const markers = [{ label: 'ENTRY', price: position.entryPrice, kind: 'entry' }];
    if (!position.leg1Closed) {
      markers.push({ label: 'STOP', price: position.stopPrice, kind: 'stop' });
      markers.push({ label: 'TP1', price: position.target1, kind: 'target' });
      if (!(position.leg2Size === 0)) markers.push({ label: 'TP2', price: position.target2, kind: 'target' });   // lv1 r12.1: no leg 2 = no TP2
    } else {
      if (!position.leg2Closed && !(position.leg2Size === 0)) {   // lv1 r12.1: no leg 2 = no BE leg / TP2
        markers.push({ label: 'BE STOP', price: position.leg2Stop, kind: 'stop' });
        markers.push({ label: 'TP2', price: position.target2, kind: 'target' });
      }
      if (!position.leg3Closed) {
        markers.push({ label: 'TRAIL STOP', price: position.trailStop, kind: 'stop' });
      }
    }
    return { dir, markers };
  }

  // Single source of truth for "what is the bot doing right now" — the
  // terminal's header status dot just displays this string, it never
  // re-derives it from raw state, so the two can't drift apart.
  function computeStatus() {
    if (token && token.isBrokerAuth === true && token.view().failed) return 'AUTH_FAILED';   // 10/18: 3+ broker auth failures in a row
    if (LIVE && stateMachine.desynced) return 'DESYNCED';
    if (LIVE && stateMachine.phase === 'FLATTENING') return 'FLATTENING';
    if (!isFlat()) return 'IN_POSITION';
    if (dayBlocked) return 'DAY_BLOCKED';
    const now = Date.now();
    if (inMorningHold(now)) return 'BLACKOUT_MORNING';
    if (inNyOpenBlackout(now, CONFIG.blockNyOpenMinutes)) return 'BLACKOUT_NY';
    if (inAsiaBlackout(now, asiaBlockMinutes(CONFIG))) return 'BLACKOUT_ASIA';
    return 'SCANNING';
  }

  // View-only status summary for the phone — same data the terminal's
  // Intraday Bias panel and Open Positions panel already show, just
  // reformatted as plain text for a push notification. Pushed periodically
  // (CONFIG.statusPushIntervalMs) over the same ntfy.sh topic already used
  // for signal/fill alerts, so checking in from anywhere needs nothing new:
  // no tunnel, no separate login, no additional attack surface — ntfy can't
  // send anything back to this process, it's a one-way push.
  function buildStatusMessage() {
    const lines = [`Status: ${computeStatus()}`, `Day P&L: ${dayRealizedPnl >= 0 ? '+' : ''}$${dayRealizedPnl.toFixed(2)}`];
    const dailyFloor = computeDailyFloor();
    if (dailyFloor != null) lines.push(`Daily floor: $${dailyFloor.toFixed(2)}  (peak $${dayPeakPnlAccountWide.toFixed(2)})`);
    const markers = getDisplayMarkers();
    if (markers) {
      const entry = markers.markers.find(m => m.kind === 'entry');
      const stop = markers.markers.find(m => m.kind === 'stop');
      const target = markers.markers.find(m => m.kind === 'target');
      lines.push(`${markers.dir === 1 ? 'LONG' : 'SHORT'}${entry ? ` @ ${entry.price.toFixed(2)}` : ''}${stop ? `  stop ${stop.price.toFixed(2)}` : ''}${target ? `  target ${target.price.toFixed(2)}` : ''}`);
    }
    if (lastMac && lastLv) lines.push(`MAC: ${lastMac.biasStr} (${lastMac.verdict})  Levels: ${lastLv.biasStr}`);
    return lines.join('\n');
  }

  // Rewrites the snapshot with a fresh position readout WITHOUT touching
  // biasHistory — history should only grow once per 15m bar close, not
  // every fast-poll tick, or the "one dot per reading" timeline breaks.
  // Unrealized P&L on whatever's currently open, off the most recent 1m
  // close — dayRealizedPnl alone only reflects trades that have already
  // CLOSED, so a position sitting on a real gain/loss right now wouldn't
  // show anywhere on the mobile page until it exits. Mirrors the exact same
  // open-size-per-phase math already used in maybeProfitLock().
  function computeUnrealizedPnl() {
    if (!LIVE || !stateMachine || lastKnownClose == null) return 0;
    const phase = stateMachine.phase;
    if (!['LEG1_OPEN', 'LEG23_OPEN', 'LEG3_OPEN', 'FLATTENING'].includes(phase)) return 0;
    const { dir, entryPrice, contracts, leg1Size, leg2Size } = stateMachine;
    if (dir == null || entryPrice == null) return 0;
    const openSize = phase === 'LEG1_OPEN' ? contracts
      : phase === 'LEG23_OPEN' ? contracts - leg1Size
      : contracts - leg1Size - leg2Size; // LEG3_OPEN or FLATTENING
    const pts = dir === 1 ? (lastKnownClose - entryPrice) : (entryPrice - lastKnownClose);
    return pts * pointValue * openSize;
  }

  // Trailing-drawdown floor, same rule validated against Topstep's own docs
  // in lib/combineSim.js: rises with END-OF-DAY realized balance but LOCKS
  // permanently at accountStartingBalance - accountMllLimit the moment an
  // EOD balance first reaches accountStartingBalance, never moving again
  // after that regardless of further gains. Deliberately reads ONLY
  // eodPeakBalance here, never the live/intraday lastAccountBalance — the
  // floor's LEVEL only moves once a day, at rollover (see the day-key check
  // in the main loop), even though the EQUITY compared against it below is
  // fully live. See eodPeakBalance's own comment for the one real caveat.
  function computeDrawdownFloor() {
    if (eodPeakBalance == null) return null;
    return Math.min(eodPeakBalance, CONFIG.accountStartingBalance) - CONFIG.accountMllLimit;
  }

  // Trailing profit floor (2026-10-07) — shared by the breach check in the
  // main loop and the status displays below, so both always agree on the
  // same number. See CONFIG.dailyStopLoss/trailArmThreshold/trailGiveback's
  // own comments for the mechanism and the backtest behind it.
  function computeDailyFloor() {
    if (CONFIG.dailyStopLoss == null) return null;
    const armed = CONFIG.trailArmThreshold != null && CONFIG.trailGiveback != null
      && dayPeakPnlAccountWide >= CONFIG.trailArmThreshold;
    return armed ? Math.max(-CONFIG.dailyStopLoss, dayPeakPnlAccountWide - CONFIG.trailGiveback) : -CONFIG.dailyStopLoss;
  }

  // lv1 r7 TRADE TAPE (journal / display only): the open position as the bot holds it - FSM phase + getDisplayMarkers() in LIVE, the paper book in PAPER - and
  // the live price the loop already read, handed to lib/levelPanel.js once per snapshot write. Never read by a trading decision; wrapped (fail-closed).
  function lvjM1() { try { return LIVE ? lastPendingM1 : null; } catch (_) { return null; } }   // lv1 r13.3.3 bars1m: this poll's 1m read (display only)
  function lvjTradeTick(openPnl) {
    try {
      const t = Date.now(); lvjDay(t); if (!lvReplay.loaded) lvReplayBoot();   // lv1 r11: saved replays come back before the first trade tick
      const phase = LIVE ? (stateMachine ? stateMachine.phase : 'FLAT') : position ? (position.leg2Closed ? 'LEG3_OPEN' : position.leg1Closed ? 'LEG23_OPEN' : 'LEG1_OPEN') : pending ? 'PENDING_ENTRY' : 'FLAT';
      const c = openJournalContext || pendingJournalContext, px = livePx && Number.isFinite(livePx.price) && Number.isFinite(livePx.t) ? livePx : null;   // r8: a resting order carries its plan's journalId
      // r10 (MacDot 6456332727): a price goes in only with its own read time (no fallback stamped now); the contract and the open quantity as the bot holds them
      const sm = LIVE ? stateMachine : null, l1 = (o, k) => (o && o[k] != null ? o[k] : 1);
      const openQty = sm ? (sm.phase === 'LEG1_OPEN' ? sm.contracts : sm.phase === 'LEG23_OPEN' ? sm.contracts - sm.leg1Size : ['LEG3_OPEN', 'FLATTENING'].includes(sm.phase) ? sm.contracts - sm.leg1Size - sm.leg2Size : null)
        : position ? position.contracts - (position.leg1Closed ? l1(position, 'leg1Size') : 0) - (position.leg2Closed ? l1(position, 'leg2Size') : 0) : null;
      for (const r of levelPanel.trade(t, { phase, markers: getDisplayMarkers(), px: px ? px.price : null, pxT: px ? px.t : null, journalId: c ? c.journalId : null,
        entryTime: c ? c.entryTime : null, contracts: c ? c.contracts : null, openQty: Number.isFinite(openQty) ? openQty : null, contractId: (sm && sm.contractId) || (typeof contractId !== 'undefined' ? contractId : null) || null,
        openPnl, dayPnl: dayRealizedPnl, live: !!LIVE, broker: LIVE ? lastBrokerRoundTrips : null, m1: lvjM1() })) lvjWrite(r);   // r13.3.3: + m1 (bars1m)
      for (const r of levelPanel.takeReplays()) lvReplayWrite(r);   // lv1 r11: saved replays go to their own file
    } catch (e) { lvjErr(e); }
  }
  // [r1.2] the phone's TIDE block. Built only from memory (no request). Live adds the position, today's trades and alerts.
  function tideSnapshotView() {
    try { const m = CONFIG.money || {}, sz = m.sizing || {}, lv = tideLiveOn() && tideDrv ? tideDrv.view() : null;
      return { v: 1, mode: tideWire.modeOf(CONFIG), version: tideWire.VERSION, engine: tideShadow && tideShadow.engine ? tideShadow.engine.version || null : null, dayKey: currentDayKey, live: !!tideLiveReady,
        sizing: { mode: sz.mode || null, flatUsd: Number.isFinite(sz.flatDollars) ? sz.flatDollars : null, gradeUsd: tideWire.gradeUsd(CONFIG), take1MaxUsd: tideWire.take1Max(CONFIG), noFit: sz.noFit || null, maxContracts: Number.isFinite(sz.maxContracts) ? sz.maxContracts : null, nearFloor: sz.nearFloor ? !!sz.nearFloor.enabled : null },
        rules: { useTimeBlocks: CONFIG.tide.useTimeBlocks === true, blocks: tideWire.tideBlocks(CONFIG).map(w => w.slice()), openWaitMin: CONFIG.tide.openWaitMin, oldPathEntries: CONFIG.tide.oldPathEntries === true },
        rows: tideRowsRing.day === lvj.day ? tideRowsRing.rows.slice() : [],
        day: tideDaySummary(Date.now()),   // [r1.6] the WHOLE on-disk TradeDay journal summarised (not the ring), refreshed at most every 30 s
        warm: tideWarmView(),   // [r1.6] the warm-up rebuild progress (rebuilding, doneMin / totalMin, startedAt, finishedAt)
        board: tideBoardSafe(),   // [r1.3] TIDE's own levels (MacUI-N Addendum r1.3); null on error or over the 5 ms budget
        ...(tideLiveOn() ? { position: lv ? lv.position : null, trades: tideTradesMerged(lv ? lv.trades : []), alerts: lv ? lv.alerts : [], lastReject: lv ? lv.lastReject : null, rejects: lv ? lv.rejects : [] } : { tradesReloaded: tideTradesMerged([]) }) };   // [r1.6] trades = the driver's + the TradeDay's reloaded ones (reloaded:true); lastReject (tideLive r1.2)
    } catch (e) { return { v: 1, mode: tideWire.modeOf(CONFIG), error: String(e && e.message) }; }
  }
  function tideTagFills(trips, fills) {   // [r1.2] the trip whose time span holds a fill of a TIDE order (tideLive's order ids, kept for the TradeDay) -> model 'tide'
    try { const ids = new Set(tideDrv.view().orderIds); for (const f of fills) { if (f == null || f.orderId == null || !ids.has(String(f.orderId))) continue; const ft = new Date(f.creationTimestamp).getTime();
        const t = trips.find(x => new Date(x.entryTime).getTime() <= ft && ft <= new Date(x.exitTime || x.entryTime).getTime()); if (t) t.model = 'tide'; } } catch (e) { /* display only */ }
  }
  // [r1.3] snapshot.tide.board, from memory only, within a 5 ms budget (null when over or on error: the rest of the snapshot is never held back)
  let tideBoardSlow = 0, tideBoardLast = null, tideBoardHourAt = 0, tideBoardHourN = 0;   // [r1.5] the last good board (kept, stale:true, on an overrun); the overruns counted per hour
  function tideBoardSafe() {
    try { const t0 = process.hrtime.bigint(), now = Date.now();
      if (!tideShadow || !tideShadow.engine || typeof tideShadow.engine.view !== 'function') return { at: now, price: null, O4: null, control: null, range1h: null, levels: [], truncated: 0 };   // before the warm-up: empty
      const soft = f => { try { return f(); } catch (e) { return null; } }, px = livePx && Number.isFinite(livePx.price) ? livePx.price : (Number.isFinite(lastKnownClose) ? lastKnownClose : null);
      const gates = { timeBlock: soft(() => tideWire.blockAt(CONFIG, now)), openWait: soft(() => tideWire.openWait(now, CONFIG.tide.openWaitMin)),
        sessionClose: soft(() => { const s = sessionCloseState(now, CONFIG); return s && s.noEntry ? `session close (no entry from ${s.noEntryPt} PT)` : null; }), newsWait: soft(() => { const n = newsWaitBlock(now); return n ? String(n.title).split(' / ')[0] : null; }) };
      const live = tideLiveOn() && tideDrv ? tideDrv.view().position : null;
      const b = tideWire.boardView(tideShadow.engine.view(), { lastPx: px, now, mc: tideWire.moneyCfg(CONFIG, pointValue, tickSize), gates, live });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (Date.now() - tideBoardHourAt >= 3600000) { if (tideBoardHourAt && tideBoardHourN) log(`  [tide] board: ${tideBoardHourN} build(s) over the 25 ms budget in the last hour (the last good board was kept, stale) - ${tideBoardSlow} since start.`); tideBoardHourAt = Date.now(); tideBoardHourN = 0; }
      if (ms > 25) { tideBoardSlow++; tideBoardHourN++; return tideBoardLast ? { ...tideBoardLast, stale: true } : null; }   // [r1.5] 25 ms budget (the 1-core VPS): the LAST good board, marked stale (its own at)
      tideBoardLast = b; return b;
    } catch (e) { return null; }
  }
  function tideTagTrips(trips) {   // [r1.2] recentTrades[i].model = 'tide' for a broker round trip whose orders belong to a TIDE position (live only; else unchanged)
    if (!(tideLiveOn() && tideDrv) || !Array.isArray(trips)) return trips;
    try { const ids = new Set(tideDrv.view().orderIds); return trips.map(t => { const os = [t && t.entryOrderId, t && t.exitOrderId, ...((t && Array.isArray(t.orderIds)) ? t.orderIds : [])].filter(x => x != null).map(String); return os.some(x => ids.has(x)) ? { ...t, model: 'tide' } : t; }); } catch (e) { return trips; }
  }
  function writeSnapshotFile() {
    try {
      const openPnl = computeUnrealizedPnl();
      if (CONFIG.levelsOnlyEntries) lvjTradeTick(openPnl);   // lv1 r7: the phone's live trade chart (journal / display only)
      const equity = lastAccountBalance != null ? lastAccountBalance + openPnl : null;
      const drawdownFloor = computeDrawdownFloor();
      writeFileAtomic(BIAS_SNAPSHOT_FILE, JSON.stringify({   // [r1.2] atomic: a phone poll never reads an empty / partial file
        dayKey: currentDayKey, updated: Date.now(),
        levels: (() => { try { return CONFIG.levelsOnlyEntries ? levelPanel.snapshot(Date.now(), lastKnownClose, lvj, livePx && livePx.price === lastKnownClose ? livePx.barT : null, { retest: CONFIG.levelRetest === true }) : null; } catch (e) { return null; } })(),   // lv1 r5/r6: the phone Levels tab + the journal writer state (display only); r12.6: + the price's 1m bar time
        ...(CONFIG.srAreas === 'show' ? { srAreas: srAreasView(lastKnownClose) } : {}),   // sr-areas r1 (lv1 r13.6.3): display only - the phone's bands and card
        mode: LIVE ? 'LIVE' : 'PAPER',
        accountName: LIVE && account && typeof account.name === 'string' && account.name ? account.name : null,   // lv1 r13.3.4 (display only; Mac's phone header - an exporter must strip it)
        // Evaluation mode / intrabar gate (2026-10-09, mobile dashboard
        // visibility) — read-only, mirrors CONFIG exactly so the dashboard
        // can show which mode is actually live without guessing from trade
        // patterns after the fact.
        evaluationMode: CONFIG.evaluationMode,
        intrabarRestrictToLevelsSource: CONFIG.intrabarRestrictToLevelsSource,
        configLocal: { present: CONFIG_LOCAL.present, overrides: CONFIG_LOCAL.overrides },   // config-local.json overrides, shown on the dashboard
        symbol,
        // Read-only display view of the M15 control read (display only; never an entry input).
        controlDisplay: controlDisplaySnapshot(entryControlBoard),
        candleDisplay: (() => { try { return candlePositionSnapshot(ctlBars && { M15: ctlBars.M15, H1: ctlBars.H1, M30: candleM30 }, candleReadAt, Date.now()); } catch (e) { return null; } })(),   // display only: position inside the forming 15m/30m/1H bars
        status: computeStatus(),
        dayPnl: dayRealizedPnl,
        dayPnlAccountWide: dayRealizedPnlAccountWide,
        dayPeakPnlAccountWide,
        dailyFloor: computeDailyFloor(),
        dailyStopLoss: CONFIG.dailyStopLoss,   // display only: lets the phone show the configured bot-level daily stop instead of a copied constant
        openPnl,
        rollingPnl: dayRealizedPnl + openPnl,
        dayPnlAllFills: LIVE ? dayPnlAllFills : dayRealizedPnl, // fix 5: display only (fees over ALL fills, ties to the Journal Daily box)
        dayTrips: LIVE && dayFillsKnownFor === currentDayKey ? dayTripTotals(lastBrokerRoundTrips, currentDayKey) : null,   // DashT 10/28: whole-TradeDay gross / sides / net (display only)
        dayPnlNet: LIVE && dayFillsKnownFor === currentDayKey ? dayPnlAllFills : null,   // 10-18u2: THE day figure = sum of every closed round trip's broker NET (same numbers as each trade's netPnl); null = not known yet, never a guess
        brokerCosts: CONFIG.brokerCosts,   // 10-18u2: the terminal's only cost source
        rollingPnlAllFills: (LIVE ? dayPnlAllFills : dayRealizedPnl) + openPnl,
        accountBalance: lastAccountBalance,
        // dashfix: the headline Rolling P&L = account balance now - balance at the start of the trading day + open P&L (ties to TopstepX).
        // dayPnlAllFills / rollingPnlAllFills above stay as the fill-sum CROSS-CHECK; day.crossCheck says how far apart they are.
        day: LIVE ? (() => { const v = dayTracker.view(Date.now(), { balance: lastAccountBalance, openPnl });
          v.crossCheck = (dayFillsKnownFor === currentDayKey && dayTracker.state.dayKey === currentDayKey) ? dayTracker.crossCheck(dayPnlAllFills, lastAccountBalance) : null; return v; })() : null,
        equity,
        remainingDrawdown: (equity != null && drawdownFloor != null) ? equity - drawdownFloor : null,
        recentTrades: LIVE ? tideTagTrips(enrichTradesWithJournal(recentTrades)) : [],
        // Fast-read preview wins when present — it's always at least as
        // fresh as the last real close (cleared on every real close, only
        // ever set from an intrabar poll that ran AFTER it). history stays
        // the real-close-only timeline either way.
        current: intrabarPreview || biasHistory[biasHistory.length - 1] || null,
        history: biasHistory,
        position: getDisplayMarkers(),
        pausedUntil: pausedUntil && Date.now() < pausedUntil ? pausedUntil : null,   // 10/16 manual pause (phone banner)
        brokerAuth: token && token.isBrokerAuth === true ? token.view() : null,   // 10/18: token renewal state; failed = "BROKER AUTH FAILED" on the phone
        pause: pausedUntil && Date.now() < pausedUntil ? { from: pausedFrom || null, until: pausedUntil } : null,
        controls: (() => { try { return controlsView(Date.now()); } catch (e) { return null; } })(),   // 10/16 phone Control tab: read-only state of every entry guard
        livePx,   // 10/16: the freshest price the loop read (the 1m bar it already fetches every poll); the phone uses it when newer than current.t
        news: (() => { try { return newsView(Date.now()); } catch (e) { return null; } })(),
        session: (() => { try { return sessionView(Date.now()); } catch (e) { return null; } })(),   // 10/17 session close (Position-card countdown, Control tile)
        risk: (() => { try { return riskView(Date.now()); } catch (e) { return null; } })(),   // 10/18 risk per trade + the pending plan's size (Dash)
        trend: (() => { try { return trendView(Date.now()); } catch (e) { return null; } })(),   // 10/18 trend / control status (Dash)
        flags: sessionFlags,   // 10/17 SESSION FLAG COUNT: { m15: { long, short, lead, text, since, bars, partial }, m5: null (the bot has no 5m MAC) } - display only
        noChase: lastNoChase && Date.now() - lastNoChase.t < 15 * 60000 ? { t: lastNoChase.t, dir: lastNoChase.dir, text: lastNoChase.text } : null,   // 10/16 phone reason line   // 10/16 next catalyst / news wait (display only)
        ...(tideOn() ? { tide: tideSnapshotView() } : {}),   // [r1.2] snapshot.tide (MacUI-N contract): absent with tide.mode off (the snapshot is r13.3.7's byte for byte)
      }));
    } catch (e) { log('  [bias] snapshot write failed: ' + e.message); }
  }

  // Entry checklist (2026-10-09, JayMac: a dashboard tab tracking exactly
  // what the bot is waiting on to enter, watched live against the charts —
  // "so I can see the disconnect between the strategy and what the charts
  // are doing" and so Claude can read it directly for evaluations). Mirrors
  // decideSignal()'s (lib/signal.js) real logic item-by-item, reading the
  // SAME mac/lv/CONFIG fields it does — this must never show a check as
  // passing that the real signal path would actually block, or it's worse
  // than useless for exactly the comparison JayMac wants to make. Pure,
  // read-only; computed fresh on every snapshot write (bar-close AND the
  // intrabar fast-read preview) so it's never stale by more than one poll.
  // Returns { verdict, direction, source, items: [{key,label,pass,detail}] }
  // — pass is true/false, or null for "not applicable yet" (a post-filter
  // that only matters once a candidate direction/source exists).
  function computeEntryChecklist(mac, lv, nowTs, opts = {}) {
    const items = [];
    const push = (key, label, pass, detail) => items.push({ key, label, pass, detail });

    // ── 0. Pre-conditions — checkForNewEntry()'s own gate, before
    // decideSignal() is even called. ──
    const flat = isFlat();
    push('flat', 'Flat (no position/pending order open)', flat, flat ? 'Ready' : 'Position or pending order already open');
    push('dayNotBlocked', 'Daily floor not breached', !dayBlocked, dayBlocked ? 'Daily stop hit — no new entries today' : 'OK');
    const nyBlackout = inNyOpenBlackout(nowTs, CONFIG.blockNyOpenMinutes);
    push('nyOpenBlackout', 'Not in NY-open blackout', !nyBlackout, nyBlackout ? `Within ${CONFIG.blockNyOpenMinutes}min of NY open` : 'OK');
    const asiaBlackout = inAsiaBlackout(nowTs, CONFIG.asiaBlackout === false ? null : CONFIG.asiaBlockUntilMinutes);
    push('asiaBlackout', 'Not in Asia-open blackout', !asiaBlackout, asiaBlackout ? 'Early Asia session' : 'OK');
    let sessionNoEntry = false;
    { const sc = sessionCloseState(nowTs, CONFIG); sessionNoEntry = !!(sc.on && sc.noEntry);   // 10/17 session close
      if (!sc.on) push('sessionClose', 'Session close (12:55-15:00 PT)', null, 'Off (set-session.sh on) - the bot does not flatten before Topstep\'s 13:10 PT');
      else push('sessionClose', `Not in the session close (${sc.noEntryPt}-${sc.reopenPt} PT)`, !sc.noEntry, sc.noEntry ? `${sessionCloseText(sc)}` : `OK - no entries ${sc.noEntryPt}-${sc.reopenPt} PT, flat by ${sc.flattenPt}${sc.early ? ' (early close today)' : ''}${sc.candidate ? ' - CHECK: today may be a CME early close (' + sc.candidate + ', unverified)' : ''}`); }

    // ── 1. MAC Trap's own gates (lib/signal.js's macDir computation) ──
    const LV1 = !!CONFIG.levelsOnlyEntries;   // lv1 r2: MAC rows are information only (MAC never blocks or trades)
    if (!LV1) push('macHardBlock', 'MAC Trap hard block clear' + (LV1 ? ' (info: MAC never blocks - levels only)' : ''), LV1 ? null : !mac.hardBlock, mac.hardBlock ? (mac.blockReason || 'blocked') : 'Clear');
    if (CONFIG.chopSkipEnabled) {
      // mac.chopSkip already bakes in chopSkipExemptLowVolume internally
      // (macTrap.js computes it session-aware) — nothing extra needed here.
      if (!LV1) push('chopSkip', `ADX chop filter (15m ADX ${mac.adxNow15 != null ? mac.adxNow15.toFixed(1) : '?'})`, LV1 ? null : !mac.chopSkip, mac.chopSkip ? 'Choppy — ADX<15, all entries skipped' : 'Trending enough');
    } else {
      // 2026-10-14 (owner: "why isn't the ADX chop skip in the filters checklist?"): the row used to echo CONFIG only, so it read
      // "Disabled" while an outdated lib/macTrap.js (one that ignores chopSkipEnabled) was still zeroing direction. It now reads
      // the engine's actual mac.chopSkip: OFF shows the live 15m ADX for context; a chop skip that still fired is a FAILED row.
      const adxTxt = mac.adxNow15 != null ? mac.adxNow15.toFixed(1) : '?';
      if (LV1) { /* lv1 r13.3.4: MAC's chop filter is not shown under levels-only */ } else if (mac.chopSkip) push('chopSkip', `ADX chop filter (15m ADX ${adxTxt})`, LV1 ? null : false, 'MISMATCH: switched OFF in your settings but the engine still applied it (outdated lib/macTrap.js) - entries blocked');
      else push('chopSkip', `ADX chop filter (15m ADX ${adxTxt})`, null, 'Off (your setting) - never blocks entries');
    }
    const macCompressionBlock = CONFIG.blockMacCompression && mac.volCompression;
    if (CONFIG.blockMacCompression && !LV1) push('macCompression', 'MAC Trap volume not compressed', LV1 ? null : !macCompressionBlock, macCompressionBlock ? 'volRatio<0.7 — mac-sourced side zeroed' : 'OK');
    // Split into TWO independent checks (2026-10-09 fix — JayMac caught
    // this live: screenshot showed "MAC score >=7 (now 7, dir 0)" marked
    // FAILED with detail "Needs 7, has 7", which is self-contradictory).
    // mac.activeDir and mac.activeScore are NOT the same gate:
    // activeScore = max(longFinal, shortFinal) regardless of anchoring, but
    // activeDir only goes nonzero once macTrap.js's internal longAnchored/
    // shortAnchored passes (bull4hFull/h4TurnUp, no RSI veto, no chop) — so
    // a bar can show a qualifying score with activeDir still 0 because the
    // 4H anchor hasn't confirmed, same mechanism as the HTF alignment/dots
    // lag already explained elsewhere. One combined check couldn't say
    // which of the two was actually the blocker; these two can.
    const tf4h = ((mac.tfPanel || '').split(' ')[0] || '4H?') + (mac.tfDotRules && mac.tfDotRules.H4 === 'open' ? ` (4H control line: ${mac.tfDotOpens.H4 != null ? 'open ' + Number(mac.tfDotOpens.H4).toFixed(2) : 'no 4H open yet'})` : ''); // "4H+"/"4H-"/"4H="
    const dirAnchored = mac.activeDir !== 0;
    // OWNER FORWARD-TEST 2026-10-11: with CONFIG.macRequire4hAnchor false the 4H anchor is no longer a requirement, so when MAC has
    // no direction the REAL remaining blockers are named instead (score tie, 4H RSI veto, multi-TF RSI veto, ADX chop). Fields all
    // come from the mac object (longFinal/shortFinal, rsi4hVetoLong/Short, rsiH4Now, mtfVetoLong/Short, rsiNow15/30/1h, chopSkip).
    const macNoDirText = () => {
      const lf = mac.longFinal, sf = mac.shortFinal;
      if (lf === sf) return `score tie (long ${lf} = short ${sf})`;
      const lead = lf > sf ? 1 : -1;
      const why = [];
      if (lead === 1 ? mac.rsi4hVetoLong : mac.rsi4hVetoShort) why.push(`4H RSI veto (4H RSI ${mac.rsiH4Now != null ? mac.rsiH4Now.toFixed(1) : '?'} ${lead === 1 ? 'overbought' : 'oversold'})`);
      if (lead === 1 ? mac.mtfVetoLong : mac.mtfVetoShort) why.push(`multi-TF RSI veto (15m ${mac.rsiNow15 != null ? mac.rsiNow15.toFixed(0) : '?'} / 30m ${mac.rsiNow30 != null ? mac.rsiNow30.toFixed(0) : '?'} / 1h ${mac.rsiNow1h != null ? mac.rsiNow1h.toFixed(0) : '?'} ${lead === 1 ? '>=75' : '<=25'})`);
      if (mac.chopSkip) why.push('ADX chop skip');
      return `${lead === 1 ? 'long' : 'short'} leads ${Math.max(lf, sf)}-${Math.min(lf, sf)} but is blocked by ${why.length ? why.join(' + ') : 'an unidentified gate (check macTrap anchoring)'}`;
    };
    if (CONFIG.macRequire4hAnchor === false) {
      if (!LV1) push('macAnchor', 'MAC Trap has a direction (4H anchor not required)', LV1 ? null : dirAnchored,
        dirAnchored ? `${mac.activeDir === 1 ? 'Long' : 'Short'} direction active (score long ${mac.longFinal} / short ${mac.shortFinal})` : `No direction: ${macNoDirText()}`);
    } else {
      if (!LV1) push('macAnchor', 'MAC Trap has an active direction (4H anchor confirmed)', LV1 ? null : dirAnchored,
        dirAnchored ? `${mac.activeDir === 1 ? 'Long' : 'Short'} anchored` : `Neither side anchored yet — ${tf4h} on the 4H dot, h4TurnUp=${!!mac.h4TurnUp}, h4TurnDown=${!!mac.h4TurnDown} (needs ${mac.tfDotRules && mac.tfDotRules.H4 === 'open' ? 'price above/below the 4H open' : 'the 4H reclaim+EMA cross'} OR an RSI turn)`);
    }
    const scoreOk = mac.activeScore >= CONFIG.minMacScore;
    const macScoreReq = CONFIG.macStrongRequired !== false;   // 10-18b1: false = the score row is information only (requirement removed)
    if (!LV1) push('macScoreThreshold', `MAC score ≥ ${CONFIG.minMacScore}${macScoreReq ? '' : ' (info: requirement removed 10/16)'}`, macScoreReq ? scoreOk : null, `Has ${mac.activeScore}${scoreOk ? ', qualifies' : ''}`);
    const macDir = (LV1 || mac.hardBlock || macCompressionBlock) ? 0
      : ((mac.activeDir === 1 && (!macScoreReq || mac.activeScore >= CONFIG.minMacScore)) || mac.biasStr === 'STRONG BULL') ? 1
      : ((mac.activeDir === -1 && (!macScoreReq || mac.activeScore >= CONFIG.minMacScore)) || mac.biasStr === 'STRONG BEAR') ? -1 : 0;

    // ── 2. Levels PRO's own gates ──
    const lvGateOk = lv.alignmentStatus !== 'UNKNOWN' && (!CONFIG.requireLevelsAlignment || lv.alignedFull);
    if (CONFIG.requireLevelsAlignment) push('levelsAlignment', `HTF alignment (${lv.alignText || lv.tfAlign})`, lvGateOk, lv.alignmentStatus === 'UNKNOWN' ? (alignFreshnessOn() ? `UNKNOWN: ${alignUnknownText(lv)}` : CONFIG.alignmentFreshnessPolicy === 'measured' ? `NOT ALIGNED: ${alignUnknownText(lv)}` : 'UNKNOWN provider freshness; measured open possession is not entry evidence') : `${lv.alignedFull ? 'Fully aligned' : 'Not fully aligned — needs every timeframe agreeing'} (CURRENT: ${alignReadText(lv, nowTs)})`);
    const triggerDir = (CONFIG.levelsUsePersistedPlan ? lv.planLong : lv.sigLong) ? 1 : (CONFIG.levelsUsePersistedPlan ? lv.planShort : lv.sigShort) ? -1 : 0;
    const strongBiasDir = lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1 : 0;
    const lvSideDir = (CONFIG.levelsTriggerRequired === false && lvGateOk) ? (lv.biasStr === 'BUYERS IN CONTROL' ? 1 : lv.biasStr === 'SELLERS IN CONTROL' ? -1 : 0) : 0;   // 10-18b1: bias side (decideSignal)
    const lvDirRaw = levelsTriggerInfo(lv, CONFIG).dir || lvSideDir; // identical to the old `!lvGateOk ? 0 : (triggerDir !== 0 ? triggerDir : strongBiasDir)` (lib/levelsTrigger.js mirrors decideSignal)
    // OWNER FORWARD-TEST 2026-10-11: the trigger may now come from the 15m, 5m or 3m chart (lv is the pickLevelsTrigger() output).
    const tfLabelsText = (LEVELS_TRIGGER_TFS || ['M15']).map(k => ({ M15: '15m', M5: '5m', M3: '3m', M10: '10m', M30: '30m' }[k] || k)).join(' / ');
    const tfStatus = lv.tfTriggers ? Object.entries(lv.tfTriggers).map(([k, v]) => `${{ M15: '15m', M5: '5m', M3: '3m', M10: '10m', M30: '30m' }[k] || k}: ${v.skipped ? 'skipped' : v.dir !== 0 ? `${v.dir === 1 ? 'LONG' : 'SHORT'} via ${v.via}` : (v.gateOk ? 'no trigger' : 'alignment gate closed')}`).join(' | ') : null;
    const firedText = lvDirRaw !== 0 ? `Fired ${lvDirRaw === 1 ? 'LONG' : 'SHORT'} via ${triggerDir !== 0 ? 'persisted plan/signal' : lv.biasStr}${lvSideDir !== 0 && levelsTriggerInfo(lv, CONFIG).dir === 0 ? ' (bias side: trigger requirement removed 10/16)' : ''}${lv.triggerTf ? ` on the ${lv.triggerTf} chart` : ''}`
      : LV1 ? (lv.plan ? `No level trigger: Levels PRO shows a ${lv.plan.dir === 1 ? 'LONG' : lv.plan.dir === -1 ? 'SHORT' : ''} plan, but a plan alone is not a trigger` : 'No level trigger: no live setup')   // lv1 r13.3.4: no grade wording
      : (lv.plan ? `No qualifying plan/signal or eligible control bias: displayed plan grade ${lv.plan.grade}, dir ${lv.plan.dir}; a plan alone is not a trigger` : 'No trigger: no active plan');
    push('levelsTrigger', LV1 ? `Level trigger: a live level setup or a Levels PRO plan, or STRONG buyer / seller control (${tfLabelsText})` : `Levels PRO trigger (${CONFIG.levelsUsePersistedPlan ? 'persisted plan' : 'sigLong/sigShort'} or ${CONFIG.levelsTriggerRequired === false ? 'control bias (trigger requirement off)' : 'STRONG bias'}, from ${tfLabelsText})`, lvDirRaw !== 0,   // lv1 r13.3.4: level wording
      tfStatus ? `${firedText} [${tfStatus}]` : (triggerDir !== 0 ? `Fired ${triggerDir === 1 ? 'LONG' : 'SHORT'}` : strongBiasDir !== 0 ? `${lv.biasStr}` : (lv.plan ? (LV1 ? `Levels PRO shows a ${lv.plan.dir === 1 ? 'LONG' : lv.plan.dir === -1 ? 'SHORT' : ''} plan; a plan alone is not a trigger` : `Displayed plan grade ${lv.plan.grade}, dir ${lv.plan.dir}; no qualifying plan/signal or eligible control bias`) : 'No active plan')));
    push('levelsSessionAnchor', 'Levels day / VWAP anchor (info)', null, CONFIG.sessionAnchor === 'cme' ? (LV1 ? 'cme: the Levels PRO day rolls at 15:00 PT (CME session, like the indicator), VWAP restarts 06:30 PT' : 'cme: Levels PRO + MAC Trap day rolls at 15:00 PT (CME session, like the indicators), VWAP restarts 06:30 PT') : 'legacy: levels day rolls at PT midnight, VWAP restarts 06:30 PT');
    const lvDir = (!LV1 && (mac.hardBlock || mac.chopSkip)) ? 0 : lvDirRaw;

    // ── 3. Combine step — conflict/agreement/single-source ──
    const conflict = macDir !== 0 && lvDir !== 0 && macDir !== lvDir;
    if (!LV1) push('noConflict', 'MAC Trap and Levels PRO not pointing opposite ways', !conflict, conflict ? `MAC says ${macDir === 1 ? 'LONG' : 'SHORT'}, Levels says ${lvDir === 1 ? 'LONG' : 'SHORT'} — skipped` : 'OK');

    let result = null;
    if (!conflict) {
      if (macDir !== 0 && lvDir !== 0) {
        const source = (lv.plan && lv.plan.dir === macDir) ? 'levels' : 'mac';
        result = { dir: macDir, source, grade: source === 'levels' ? lv.plan.grade : mac.entryGrade };
      } else if (lvDir !== 0) {
        result = { dir: lvDir, source: 'levels', grade: (lv.plan && lv.plan.dir === lvDir) ? lv.plan.grade : null };
      } else if (macDir !== 0) {
        result = { dir: macDir, source: 'mac', grade: mac.entryGrade };
      }
    }
    // lv1 r12.6 (Mac 10/28): the HTF alignment must point the trade's way (the same rule as lib/signal.js levelsAlignWithTrade)
    let lvAlignAgainst = 0;
    if (LV1 && CONFIG.requireLevelsAlignment && CONFIG.levelsAlignWithTrade) { const ad = levelEvent.alignDir(lv, levelEvent.alignRequired(CONFIG)), w = result ? (result.dir === 1 ? 'LONG' : 'SHORT') : '';
      push('levelsAlignDir', "HTF alignment in the trade's direction (15m / 1H / 4H)", result ? ad === result.dir : null, `HTF ${ad === 1 ? 'bullish' : ad === -1 ? 'bearish' : 'not aligned'} (${lv.alignText || lv.tfAlign || '?'})${!result ? '' : ad === result.dir ? `: the ${w} agrees` : ad === 0 ? `: no ${w} until all three agree with it` : `: the ${w} is against it, no entry`}`);
      if (result && ad !== result.dir) { lvAlignAgainst = result.dir; result = null; } }
    if (LV1) { const pf = result ? levelEvent.levelProof(lv, result.dir) : null; push('namedLevel', 'Named level event (NO LEVEL, NO TRADE)', result ? !!pf : null, !result ? 'N/A yet' : pf ? `${pf.name} ${pf.price} - ${pf.event}` : 'No sweep / reclaim / accept / hold event at a named level - no trade'); if (!pf) result = null; }   // lv1 r3
    // OWNER FORWARD-TEST 2026-10-11: the detail used to read 'Neither side has fired yet' even when MAC and Levels CONFLICTED
    // (result stays null on a conflict). Now: conflict is named as such, and a genuinely silent bar lists the binding reason per side.
    let hasDirDetail;
    if (result) hasDirDetail = `${result.dir === 1 ? 'LONG' : 'SHORT'} via ${result.source}`;
    else if (conflict) hasDirDetail = `CONFLICT (not silence): MAC says ${macDir === 1 ? 'LONG' : 'SHORT'}, Levels says ${lvDir === 1 ? 'LONG' : 'SHORT'}${lv.triggerTf ? ` (${lv.triggerTf} chart)` : ''} — bot stands down`;
    else {
      let macWhy;
      if (LV1) macWhy = 'no input (levels only)';
      else if (mac.hardBlock) macWhy = `hard block (${mac.blockReason || 'blocked'})`;
      else if (macCompressionBlock) macWhy = 'volume compressed (volRatio<0.7)';
      else if (mac.activeDir === 0) macWhy = CONFIG.macRequire4hAnchor === false ? macNoDirText() : `no anchored direction (${tf4h} on the 4H dot)`;
      else macWhy = `score ${mac.activeScore} < ${CONFIG.minMacScore}`;
      let lvWhy;
      if (lvDirRaw !== 0 && LV1) lvWhy = lvAlignAgainst ? `${lvAlignAgainst === 1 ? 'LONG' : 'SHORT'} trigger against the HTF alignment (${lv.alignText || lv.tfAlign})` : 'trigger present but no named level event in its direction';   // lv1 r12.6
      else if (lvDirRaw !== 0) lvWhy = `trigger present but zeroed by MAC ${mac.hardBlock ? 'hard block' : 'chop skip'}`;
      else if (!lvGateOk) lvWhy = lv.alignmentStatus === 'UNKNOWN' ? `HTF alignment UNKNOWN: ${alignUnknownText(lv)}` : `HTF alignment ${lv.alignText || lv.tfAlign} CURRENT but not full`;
      else lvWhy = LV1 ? `no live level setup, Levels PRO plan or STRONG control on ${tfLabelsText} (${lv.plan ? `Levels PRO plan: ${lv.plan.dir === 1 ? 'LONG' : lv.plan.dir === -1 ? 'SHORT' : '-'}` : 'no active plan'}; bias ${lv.biasStr})`   // lv1 r13.3.4: no grade wording
        : `no ${CONFIG.levelsUsePersistedPlan ? 'persisted plan' : 'signal'} or STRONG bias on ${tfLabelsText} (${lv.plan ? `plan exists: grade ${lv.plan.grade}, dir ${lv.plan.dir}` : 'no active plan'}; bias ${lv.biasStr})`;
      hasDirDetail = LV1 ? `No level trigger yet: ${lvWhy}` : `Neither side has fired — MAC: ${macWhy} | Levels: ${lvWhy}`;   // lv1 r13.3.4: no MAC wording under levels-only
    }
    push('hasDirection', LV1 ? 'A level trigger in one direction (levels only)' : 'A candidate direction exists', result != null, hasDirDetail);   // lv1 r13.3.4: the same key and pass, reworded

    // ── 4. Post-filters — only meaningful once a candidate exists ──
    const gradeBBlock = CONFIG.blockMacGradeB && result && result.source === 'mac' && result.grade === 'B';
    if (!LV1) push('notMacGradeB', 'Not a mac-sourced grade-B signal', result ? !gradeBBlock : null, !result ? 'N/A yet' : gradeBBlock ? 'Blocked — mac-sourced grade B historically unprofitable' : CONFIG.blockMacGradeB ? 'OK' : 'OK (grade-B block off: owner order 10/14)');
    const isAsiaNow = ptInfo(nowTs).isAsia;
    const gradeCAsiaBlock = CONFIG.blockGradeCAsia && result && result.grade === 'C' && isAsiaNow;
    if (!LV1) push('notGradeCAsia', 'Not a grade-C signal during Asia hours', result ? !gradeCAsiaBlock : null, !result ? 'N/A yet' : gradeCAsiaBlock ? 'Blocked — grade C during Asia historically unprofitable' : CONFIG.blockGradeCAsia ? 'OK' : 'OK (grade-C Asia block off)');
    let biasBlock = false;
    if (CONFIG.minBiasAgreementMacSource != null || CONFIG.minBiasAgreementLevelsSource != null) {
      const biasAgreement = result ? (result.dir === 1 ? lv.biasScore : -lv.biasScore) : null;
      const threshold = result && result.source === 'mac' ? CONFIG.minBiasAgreementMacSource : result && result.source === 'levels' ? CONFIG.minBiasAgreementLevelsSource : null;
      biasBlock = !!(result && threshold != null && biasAgreement < threshold);
      push('biasAgreement', `Bias-score agreement ≥ threshold`, result ? !biasBlock : null, !result ? 'N/A yet' : threshold == null ? 'No threshold set for this source' : `${biasAgreement.toFixed(2)} vs needs ≥${threshold}`);
    }

    // OWNER FORWARD-TEST 2026-10-11: informational only (pass=null, never part of wouldFire). Levels PRO bias score: positive = buyers,
    // negative = sellers; shown relative to the candidate trade direction. Tiers: |score| >= 0.45 STRONG (Levels PRO's own STRONG
    // CONTROL cut), >= 0.22 MODERATE (its ctrlThresh default), else WEAK.
    {
      const bsc = lv.biasScore;
      if (typeof bsc === 'number') {
        const tier = Math.abs(bsc) >= 0.45 ? 'STRONG' : Math.abs(bsc) >= 0.22 ? 'MODERATE' : 'WEAK';
        const agree = result ? (result.dir === 1 ? bsc : -bsc) : null;
        push('biasStrength', 'Bias strength (informational, not a gate)', null,
          `Levels bias score ${bsc >= 0 ? '+' : ''}${bsc.toFixed(2)} (${lv.biasStr}) — ${agree == null ? 'no candidate direction yet (+ = buyers)' : `${agree > 0 ? 'agrees with' : agree < 0 ? 'opposes' : 'is neutral to'} the ${result.dir === 1 ? 'LONG' : 'SHORT'} (agreement ${agree >= 0 ? '+' : ''}${agree.toFixed(2)})`} — tier ${tier} (>=0.45 STRONG)`);
      }
    }
    // 10-18b1 CONTROL GATE row (the same rule as lib/signal.js; only with controlDirectionGate on)
    let controlBlock = false;
    if (CONFIG.controlDirectionGate) {
      // Same dedicated-M15 read as the gate (lib/entryControl.js): no biasScore fallback, UNKNOWN unless controlValid and a finite controlBiasScore.
      const ctl = controlDisplaySnapshot(lv), cs = ctl.valid ? ctl.side : 0, csc = ctl.score, csn = !ctl.valid ? 'UNKNOWN' : cs === 1 ? 'BUYERS' : cs === -1 ? 'SELLERS' : 'CONTESTED';
      controlBlock = !!(result && (!ctl.valid || (cs !== result.dir && !(cs === 0 && CONFIG.controlContestedMinSize))));   // 10-18b2c: contested (known) = minimum size, not a block; r2: unknown blocks
      push('controlGate', `Trade with the side in control (15m control score beyond +/-${CONFIG.controlGateMin})`, result ? !controlBlock : null,
        `${csn} in control (score ${Number.isFinite(csc) ? (Math.round(csc * 1000) / 1000) : '?'})${!result ? '' : controlBlock ? (!ctl.valid ? ': control score UNKNOWN (no valid 15m Levels PRO evaluation), no entry' : cs === 0 ? ': contested, no entry' : `: this ${result.dir === 1 ? 'LONG' : 'SHORT'} is against it, no entry`) : cs === 0 ? ': contested, minimum size (1 contract, if it fits the risk cap)' : ': OK'}`);
    }
    // ── FIX1015: gates outside decideSignal() that also hold an entry back. Each row reads the state the entry path reads, and a failing row is part of wouldFire. ──
    let isIntrabarEval = !!opts.isIntrabar;
    let evalAt = nowTs;
    if (opts.isIntrabar == null) { try { isIntrabarEval = !!checklistEvalIntrabar; if (checklistEvalAt != null) evalAt = checklistEvalAt; } catch (e) { isIntrabarEval = false; } }
    // ROUND 4: MAC grades in intrabarAllowMacGrades (A/B) may enter mid-bar; MAC grades in macIntrabarOnlyGrades are NOT entered at the 15m close.
    const macGradeIntrabarOk = !!(result && (CONFIG.macIntrabarAllGrades === true || (Array.isArray(CONFIG.intrabarAllowMacGrades) && CONFIG.intrabarAllowMacGrades.includes(result.grade))));   // 10-18b1
    const macIntrabarBlock = !!(CONFIG.intrabarRestrictToLevelsSource && isIntrabarEval && result && result.source === 'mac' && !macGradeIntrabarOk);
    // the same rule as macIntrabarOnlyBlock() (inlined so the checklist stays self-contained; smoke-test-1016-round4.js checks the two agree)
    const macCloseOnlyBlock = !!(!isIntrabarEval && result && result.source === 'mac' && CONFIG.evaluationMode === 'intrabar-1m' && Array.isArray(CONFIG.macIntrabarOnlyGrades) && CONFIG.macIntrabarOnlyGrades.includes(result.grade)
      && (!CONFIG.intrabarRestrictToLevelsSource || macGradeIntrabarOk) && (() => { try { return macSeenIntrabar(nowTs - 900000, result.dir); }   /* the close evaluation looks at the bar that just closed */ catch (e) { return true; } })());   // round 5 (O4): only when seen mid-bar in this bar
    const ibGrades = CONFIG.macIntrabarAllGrades === true ? 'A/B/C/-' : Array.isArray(CONFIG.intrabarAllowMacGrades) && CONFIG.intrabarAllowMacGrades.length ? CONFIG.intrabarAllowMacGrades.join('/') : null;   // 10-18b1
    const nextCloseTxt = new Date(Math.floor(nowTs / 900000) * 900000 + 900000).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
    if (CONFIG.intrabarRestrictToLevelsSource && !LV1) push('macIntrabar', ibGrades ? `MAC timing: grade ${ibGrades} as soon as they fire (close only if first seen there; never twice), other grades at the 15m close` : 'MAC signals only at the 15m close', result ? !(macIntrabarBlock || macCloseOnlyBlock) : null,
      !result ? 'N/A yet' : macIntrabarBlock ? (ibGrades ? `Waiting: this ${result.dir === 1 ? 'LONG' : 'SHORT'} is MAC grade ${result.grade || '?'} and this is a mid-bar poll; only MAC grade ${ibGrades} enter mid-bar, this one waits for the 15m close (next close ${nextCloseTxt} PT)` : `Waiting: this ${result.dir === 1 ? 'LONG' : 'SHORT'} is MAC-sourced and this is a mid-bar poll; MAC signals are only taken on the first poll after a 15m close (next close ${nextCloseTxt} PT)`)
        : macCloseOnlyBlock ? `Not at the close: this MAC grade ${result.grade} signal was already seen mid-bar in this bar (traded or blocked); it is not entered twice`
        : result.source === 'mac' ? (isIntrabarEval ? `OK (MAC grade ${result.grade} may enter mid-bar)` : 'OK (15m-close evaluation)') : 'OK (Levels-sourced signals may enter mid-bar)');
    let hiddenRows = [];
    try { hiddenRows = hiddenGateRows(nowTs, result, evalAt); } catch (e) { hiddenRows = []; }
    for (const r of hiddenRows) items.push(r);
    try { const nr = newsChecklistRow(nowTs); if (nr) items.push(nr); } catch (e) { /* display only */ }
    try { const cr = noChaseRow(nowTs, result); if (cr) items.push(cr); } catch (e) { /* display only */ }
    // round 4 far-limit switch: informational row (never a gate) when a Levels LIMIT/STOP plan is in the candidate's direction
    try {
      if (CONFIG.farLimitSwitch && result && lv.plan && lv.plan.dir === result.dir && (lv.plan.entryType === 'LIMIT' || (lv.plan.entryType === 'STOP' && CONFIG.farLimitIncludeStops === true))) {
        const pxF = livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose, atrF = farLimitAtrNow();
        const ms = macSignalOnly(decideSignal, mac, lv, CONFIG, true, nowTs), fl = farLimitDecision(CONFIG, { planDir: result.dir, planEntry: lv.plan.entry, px: pxF, atr: atrF, macSig: ms && ms.controlContested ? null : ms });   // 10-18b2c: contested never switches
        if (Number.isFinite(pxF) && atrF > 0) items.push({ key: 'farLimit', label: `Far-limit switch (Levels ${CONFIG.farLimitIncludeStops === true ? 'limit/stop' : 'limit'} > ${CONFIG.farLimitAtr} x 15m ATR + MAC A/B agrees -> MAC market)`, pass: null,
          detail: `Levels ${lv.plan.entryType} ${lv.plan.entry.toFixed(2)} is ${Math.abs(lv.plan.entry - pxF).toFixed(2)} pts (${fl.atrX} ATR) from price ${pxF.toFixed(2)}: ${fl.switch ? `MAC grade ${ms.grade} agrees -> MAC's market entry is taken intrabar instead` : fl.why === 'near' ? 'near enough, the Levels order is used' : `no switch (${fl.why})`}` });
      }
    } catch (e) { /* display only */ }   // 10/16 no-chase row (a gate: blocks "WOULD ENTER")   // 10/16 news row (informational, never a gate)
    let vixRow = null;
    try { const v = vixFeed.view(nowTs); vixRow = { key: 'vixData', label: 'VIX data for the VIX ≥ 32 block', pass: v.warn ? null : true, warn: !!v.warn, detail: v.text }; } catch (e) { vixRow = null; }
    if (vixRow) items.push(vixRow);   // informational (the block itself is the MAC Trap hard-block row): flagged when stale, failed or missing
    const hiddenBlock = macIntrabarBlock || macCloseOnlyBlock || hiddenRows.some(r => r.pass === false);
    const newsBlock = items.some(i => (i.key === 'news' || i.key === 'noChase') && i.pass === false);   // 10/16 news wait + no-chase
    const wouldFire = flat && !dayBlocked && !nyBlackout && !asiaBlackout && !sessionNoEntry && result != null && !gradeBBlock && !gradeCAsiaBlock && !biasBlock && !controlBlock && !hiddenBlock && !newsBlock;   // 10-18b1: controlBlock; 10/19: sessionNoEntry (the entry paths already refuse it, the verdict now agrees)
    return {
      verdict: wouldFire ? 'WOULD ENTER' : 'WAITING',
      direction: result ? result.dir : null,
      source: result ? result.source : null,
      grade: result ? result.grade : null,
      items,
    };
  }

  // Shared shape builder (2026-10-09, extracted so the real bar-close
  // timeline and the intrabar fast-read preview below always render
  // identically on the dashboard — same fields, same semantics, the only
  // difference is which array/variable the result lands in).
  function buildBiasEntry(mac, lv, clOpts = {}) {
    const overall = computeOverallBias(mac, lv, CONFIG);
    const checklist = computeEntryChecklist(mac, lv, Date.now(), clOpts);
    if (CONFIG.levelsOnlyEntries) lvjDecision(lv, checklist);   // lv1 r5: why each live level event is / is not tradable right now (levels journal only)
    // Only the snapshot item carries display metadata; authority/pass is unchanged.
    checklist.items = checklist.items.map(it => it.key === 'levelsAlignment'
      ? { ...it, alignmentStatus: lv.alignmentStatus, alignmentDisplay: alignmentDisplays.get(lv) || null, ...alignAgeFields(lv) } : it);
    return {
      t: Date.now(),
      mac: {
        biasStr: mac.biasStr, regime: mac.regime, verdict: mac.verdict, longScore: mac.longScore, shortScore: mac.shortScore, tfPanel: mac.tfPanel,
        // Added 2026-09-24 for mobile's HTF Context tab (read-only — these
        // fields already exist on macTrap.js's per-bar output, just weren't
        // being copied into the persisted snapshot before now).
        close: mac.close, rsiH4Now: mac.rsiH4Now, rsi4hVetoLong: mac.rsi4hVetoLong, rsi4hVetoShort: mac.rsi4hVetoShort,
        rsiNow15: mac.rsiNow15 ?? null, rsiNow30: mac.rsiNow30 ?? null, rsiNow1h: mac.rsiNow1h ?? null, rsiVetoesOn: mac.rsiVetoesOn !== false,   // 10/18: RSI readings for the phone (information when the vetoes are off)
        h4TurnUp: mac.h4TurnUp, h4TurnDown: mac.h4TurnDown, hardBlock: mac.hardBlock, blockReason: mac.blockReason, exhaustionGate: mac.exhaustionGate,
        // ADX chop-skip (2026-09-24, FIX 9) — already computed and acted on
        // internally (macTrap.js's own longAnchored/shortAnchored, signal.js's
        // lvDir gate), just wasn't copied into the persisted snapshot, so
        // there was no way to confirm from /bias whether it's actually
        // firing.
        adxNow15: mac.adxNow15, chopSkip: mac.chopSkip,
      },
      lv: { alignmentStatus:lv.alignmentStatus, alignSlots:lv.alignSlots, biasStr: lv.biasStr, tfAlign: lv.tfAlign, ...(lv.alignText ? { alignText: lv.alignText } : {}), inPlayLevel: lv.inPlayLevel, levels: lv.levels || [], triggerTf: lv.triggerTf ?? null, biasScore: lv.biasScore },
      overallLabel: overall.label,
      tradable: overall.tradable,
      // Entry checklist (2026-10-09) — see computeEntryChecklist()'s own
      // comment. Computed here so BOTH writeBiasSnapshot (real bar close)
      // and writeIntrabarPreview (fast intrabar read) carry it, same as
      // every other field on this object.
      checklist,
    };
  }

  function writeBiasSnapshot(mac, lv) {
    biasHistory.push(buildBiasEntry(mac, lv, { isIntrabar: false }));
    if (biasHistory.length > 40) biasHistory.shift(); // ~10 hours of 15m readings
    // A real close always supersedes whatever the last intrabar preview
    // said — clear it so writeSnapshotFile()'s current: falls through to
    // the fresh biasHistory tail instead of stale 1m-poll data.
    intrabarPreview = null;
    writeSnapshotFile();
  }

  // Fast-read preview writer (2026-10-09) — same entry shape as a real bar
  // close, but overwrites intrabarPreview in place instead of pushing to
  // biasHistory, so the dashboard's "current" card can refresh on
  // CONFIG.evaluationIntrabarPollMs cadence without compressing the 15m
  // trend timeline. No-op risk-wise: this only ever runs with data that's
  // already been computed for (and may have fed) a real entry decision —
  // it changes what the dashboard shows, never what the bot does.
  function writeIntrabarPreview(mac, lv) {
    intrabarPreview = buildBiasEntry(mac, lv, { isIntrabar: true });
    writeSnapshotFile();
  }
  writeBiasSnapshot(lastMac, lastLv); // so the terminal has something to show before the first new bar closes

  // contracts (default 1): how many lots this leg-closing event represents —
  // leg1/leg2 always close exactly 1 (the proven $30-then-structural math),
  // leg3 closes whatever's left riding (position.contracts - 2), so a
  // grade-sized 5-contract trade's runner correctly settles 3x, not 1x.
  function recordLeg(leg, exitPrice, reason, contracts = 1) {
    const pnlPoints = position.dir === 1 ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    const pnlDollars = pnlPoints * pointValue * contracts;
    // Per-position running total (2026-09-24, Journal lifecycle B2) — a
    // position can close across several recordLeg() calls (leg1/leg2/leg3);
    // this is what the FINAL close's 'closed' journal row reads for the
    // whole trade's realizedPnl, exact for PAPER (unlike LIVE's estimate).
    position.realizedPnlSoFar = (position.realizedPnlSoFar || 0) + pnlDollars;
    dayRealizedPnl += pnlDollars;
    paperTotalPnl += pnlDollars;
    log(`  [PAPER FILL] leg${leg} ${position.dir === 1 ? 'LONG' : 'SHORT'} ${contracts}x exit=${reason} price=${exitPrice.toFixed(2)} pnl=$${pnlDollars.toFixed(2)}  (day: $${dayRealizedPnl.toFixed(2)}  total: $${paperTotalPnl.toFixed(2)})`);
    notifyPhone(`[PAPER] leg${leg} ${reason}`, `${position.dir === 1 ? 'LONG' : 'SHORT'} ${contracts}x exit @ ${exitPrice.toFixed(2)}, pnl=$${pnlDollars.toFixed(2)} (day: $${dayRealizedPnl.toFixed(2)})`, { tags: pnlDollars >= 0 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend' });
  }

  // 10/18 RULE 2 (paper): the runner size of the trade's own split, and closing whatever legs are still open (each leg recorded with its own size, none with 0)
  function paperRunnerSize(q) { const l1 = q.leg1Size != null ? q.leg1Size : 1, l2 = q.leg2Size != null ? q.leg2Size : 1; return Math.max(0, q.contracts - l1 - l2); }
  function paperCloseRemaining(price, reason) {
    const l1 = position.leg1Size != null ? position.leg1Size : 1, l2 = position.leg2Size != null ? position.leg2Size : 1, l3 = paperRunnerSize(position);
    if (!position.leg1Closed && l1 > 0) recordLeg(1, price, reason, l1);
    if (!position.leg2Closed && l2 > 0) recordLeg(2, price, reason, l2);
    if (!position.leg3Closed && l3 > 0) recordLeg(3, price, reason, l3);
  }

  function isFlat() {
    return LIVE ? (stateMachine.phase === 'FLAT' && !stateMachine.desynced) : (!position && !pending);
  }

  // Flat sizing (2026-09-23 direct order — risk-budgeted sizing built earlier
  // tonight, then explicitly deferred): every trade is baseContracts, full
  // stop. Grade/score no longer touches size at all — decideSignal's own
  // minMacScore gate is still what decides whether a trade fires.
  function contractsForSignal() {
    return CONFIG.baseContracts;
  }

  // Risk-budgeted sizing (2026-10-07) — see CONFIG.riskBudgetedSizing's own
  // comment below. Ported from lib/simulate3leg.js's identical function
  // (same backtest validated this exact formula/clamp against 5 years of
  // real data — see CONFIG-RECOMMENDATION-ANALYSIS.md). stopPoints is THIS
  // signal's own raw stop distance, passed in by each of the 4 signal
  // branches below from whatever already determines its stop price — never
  // a flat per-contract reference, so a genuinely wide structural stop gets
  // sized DOWN instead of carrying the same contract count as a tight one.
  function rawSizeForStop(stopPoints) {
    // 10/18 RULE 1: floor($cap / ((stop + slip) x $/pt)), at most baseContracts; 0 = even 1 contract is over the cap (the caller skips the trade)
    if (Number.isFinite(CONFIG.maxRiskPerTradeUsd) && CONFIG.maxRiskPerTradeUsd > 0) return sizeForRisk({ stopPts: stopPoints, maxRiskUsd: CONFIG.maxRiskPerTradeUsd, pointValue, maxContracts: CONFIG.baseContracts, slipPts: CONFIG.riskSizingSlipPts }).contracts;
    if (!CONFIG.riskBudgetedSizing) return contractsForSignal();
    if (!stopPoints || stopPoints <= 0) return CONFIG.baseContracts; // defensive — shouldn't happen on a real signal
    const raw = CONFIG.dollarRiskPerTrade / (stopPoints * pointValue);
    return Math.max(CONFIG.riskSizingMinContracts, Math.min(CONFIG.riskSizingMaxContracts, Math.round(raw)));
  }

  // Compute once before target legs; subsequent boundaries assert, never resize.
  function quantityForStop(stopPoints, sig) {
    const confidence = initialQuantity.confidenceFor(sig);
    const q = initialQuantity.decision({ rawContracts: initialQuantity.ceiling(confidence) > 0 ? rawSizeForStop(stopPoints) : 0, stopPoints,
      pointValue, globalMax: CONFIG.baseContracts, confidence, flatSize: CONFIG.flatSizeContracts || null });   // np1 flat size
    return minContractsGate(q, CONFIG.minContracts, stopPoints, pointValue, CONFIG.riskSizingSlipPts);   // lv1 size1: the minimum size (off = q itself)
  }
  function sizeForStop(stopPoints, sig) {
    const sizing = quantityForStop(stopPoints, sig);
    appendJournal({ type: 'initial_quantity', ...sizing });
    return sizing.contracts;
  }
  function entryQuantityAllowed(plan) {
    const { dir, entryPrice, stopPrice, contracts, source, grade, signalContext, leg1Size, leg2Size } = plan;
    const confidence = initialQuantity.confidenceFor({ source, grade, ...(signalContext && Object.hasOwn(signalContext, 'confidence') ? { confidence: signalContext.confidence } : {}) });
    const sizing = quantityForStop(Math.abs(entryPrice - stopPrice), { source, grade, confidence });
    const ok = Number.isFinite(entryPrice) && Number.isFinite(stopPrice) &&
      (dir === 1 ? stopPrice < entryPrice : dir === -1 && stopPrice > entryPrice) &&
      Number.isInteger(contracts) && contracts > 0 && contracts <= sizing.contracts && minContractsOk(CONFIG.minContracts, contracts) &&
      (leg1Size === undefined || initialQuantity.validLegs(contracts, leg1Size, leg2Size));
    try { const jr = require('./lib/journalReceipts'); jr.emit(appendJournal, () => jr.receipt(signalContext?.journalId, 'QUANTITY_ADMISSION', { result: ok, sizing, selectedContracts: contracts })); } catch (_) { /* receipt only */ }
    if (!ok && !minContractsOk(CONFIG.minContracts, contracts)) { log(`  [size] ${dir === 1 ? 'LONG' : 'SHORT'} ${source || ''} entry REFUSED: the order is ${contracts} contract${contracts === 1 ? '' : 's'} - minContracts 3.`); journalBlock('SIZE_BELOW_MIN', dir, { source, grade, contracts, sizing, minContracts: 3, reason: 'size-below-min', why: `size below 3 (the order is ${contracts} contract${contracts === 1 ? '' : 's'})` }); }   // lv1 size1: the final count
    else if (!ok) journalBlock('INITIAL_QUANTITY_REFUSED', dir, { source, grade, contracts, sizing });
    return ok;
  }

  // Mirrors simulate3leg.js's leg1SizeForContracts/leg2SizeForContracts
  // exactly, so live sizing matches what was actually backtested.
  function leg1SizeForContracts(contracts) {
    return legSplit(contracts, CONFIG).leg1;   // 10/18 RULE 2: leg split at any size (5 -> 2/1/2 exactly as before; 3 -> 1/1/1, 2 -> 1/0/1, 1 -> 1/0/0)
    const extra = Math.max(0, contracts - CONFIG.baseContracts);
    const size = 1 + CONFIG.baseLeg1Extra + Math.min(extra, CONFIG.gradeLeg1Extra);
    // Math.max(1, ...) added 2026-10-07 — defensive backstop, not the real
    // fix. riskSizingMinContracts=4 is what actually keeps contracts from
    // ever getting small enough to need this; this just makes sure a future
    // caller can never silently get leg1Size=0 (-> target1Points=Infinity ->
    // a real 0-contract/infinite-price order sent to the exchange) even if
    // that floor is ever lowered without re-checking this invariant first.
    return Math.max(1, Math.min(size, contracts - 1));
  }
  function leg2SizeForContracts(contracts, leg1Size) {
    { const sp = legSplit(contracts, CONFIG); return sp.leg1 === leg1Size ? sp.leg2 : Math.max(0, Math.min(sp.leg2, contracts - leg1Size - 1)); }   // 10/18 RULE 2
    const extra = Math.max(0, contracts - CONFIG.baseContracts);
    const size = 1 + Math.min(Math.max(0, extra - CONFIG.gradeLeg1Extra), CONFIG.gradeLeg2Extra);
    // Reserve at least 1 contract for leg3 (2026-09-22) — leg1SizeForContracts
    // already caps itself at contracts-1 for exactly this reason, but this
    // one capped only at contracts-leg1Size, letting leg2 legitimately
    // consume the ENTIRE remaining position on some size/grade
    // combinations. That left the state machine trying to open a leg3
    // stop for zero contracts once target2 filled — rejected by the
    // exchange and, uncaught, left the whole process stuck thinking a
    // position existed that had already fully closed. The "3-leg shave"
    // is only actually 3 legs if leg3 always has something to run.
    // Math.max(0, ...) added 2026-10-07 — same defensive backstop as
    // leg1SizeForContracts above: contracts-leg1Size-1 can go negative at
    // small contract counts, which riskSizingMinContracts=4 is what
    // actually prevents; this just stops it from ever going negative if
    // that floor changes without re-checking this invariant.
    return Math.max(0, Math.min(size, contracts - leg1Size - 1));
  }

  // Checklist text for the read-age rule (display only; the gate is lv.alignmentStatus / checkConsumedAlignment).
  function alignReadText(lv, nowTs) {
    // DashT 10/28: the 'measured' policy stamps no read times, so no ", read ?" then; the open is printed as the Dash card prints it (29,833.75).
    const f2 = v => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
    return (lv.alignSlots || []).map(x => `${ALIGN_TF_LABEL[x.timeframe] || x.timeframe} ${x.flag ? 'above' : 'at/below'} open ${f2(x.open)}${x.read && Number.isFinite(x.read.doneAt) ? ', read ' + Math.max(0, Math.round((nowTs - x.read.doneAt) / 1000)) + 's ago' : ''}`).join(' · ');
  }
  // r8 phone ageing: the OLDEST read behind a CURRENT board, in ms at snapshot build, and the fixed limit (display only).
  // r8.1: the larger of wall and monotonic age; a negative age on either clock (regression) reports the row as already expired.
  function alignAgeFields(lv) {
    if (!lv || lv.alignmentStatus !== 'CURRENT') return {};
    const now = Date.now(), mono = displayPerformance.now(), rs = (lv.alignSlots || []).flatMap(x => [x.read, x.priceRead]).filter(r => r && Number.isFinite(r.doneAt) && Number.isFinite(r.mono));
    if (!rs.length) return {};
    const ages = rs.map(r => (now < r.doneAt || mono < r.mono) ? Infinity : Math.max(now - r.doneAt, mono - r.mono)), worst = Math.max(...ages);
    return { alignmentReadAgeMs: Number.isFinite(worst) ? Math.round(worst) : ALIGN_FRESHNESS_MAX_AGE_MS + 1, alignmentMaxAgeMs: ALIGN_FRESHNESS_MAX_AGE_MS };
  }
  function alignUnknownText(lv) {
    const why = { STALE_READ: 'bars not read in the last 60 s', READ_NOT_IN_CURRENT_POLL: 'last refresh failed or still running', NO_CURRENT_POLL: 'last refresh failed or still running',
      NOT_CURRENT_PERIOD: 'bar is not the current period (new period not read yet)', CLOCK_REGRESSION: 'clock moved backwards', MISSING_OR_OUT_OF_INTERVAL_BAR: 'no bar for the current period', INSTRUMENT_MISMATCH: 'contract mismatch',
      // r9.11 (display text only): the measured-alignment reasons
      OPEN_UNPROVEN: 'new period has traded but no bar proves its open', PREV_PERIOD_NO_TRADE_YET: 'new period has no bar yet (previous open shown, not used)', MISSING_PROVIDER_EVIDENCE: 'no freshness evidence (read-age rule)' };
    const bad = (lv.alignSlots || []).filter(x => x.status !== 'CURRENT').map(x => `${ALIGN_TF_LABEL[x.timeframe] || x.timeframe}: ${why[(x.reasonCodes || [])[0]] || (x.reasonCodes || [])[0] || 'unknown'}`);
    return (bad.length ? bad.join(' · ') : 'no alignment slots') + ' (Levels entries held until every slot is CURRENT)';
  }
  function alignmentContextFor(source, lv) {
    return { alignmentConsumed: source === 'levels' || (source === 'mac' && CONFIG.tfModeApplyToMac === true),
      // Snapshot configured requirements, never infer them from available slots.
      alignmentRequiredSlots: Object.freeze([...levelsAlignOpts(CONFIG).alignTfs]),
      alignmentInstrument: contractId,
      alignmentSlots: lv && lv.alignSlots ? JSON.parse(JSON.stringify(lv.alignSlots)) : [],
      alignmentEvidence: null, alignmentClockConfidence: null,
      alignmentFreshness: CONFIG.alignmentFreshnessPolicy === 'read-age-60s' ? { kind: 'read-age', policy: 'read-age-60s' } : CONFIG.alignmentFreshnessPolicy === 'measured' ? { kind: 'measured' } : null };   // r9.10 'measured'   // literal = lib/alignmentFreshness POLICY (tested)
  }
  function alignmentEntryAllowed(source, context, seam) {
    const verdict = checkConsumedAlignment({ source, context, nowMs:Date.now(), freshness: alignFreshnessState() });
    if (!verdict.ok) journalBlock('ALIGNMENT_UNKNOWN', 0, { source, seam, reasons:verdict.reasonCodes });
    return verdict.ok;
  }
  function journalNoChaseSnapshot(planInfo, context, dir, source, grade, text) {
    // Last-close caches are not this attempt's board. Missing identity is diagnostic uncertainty, never permission.
    try {
      const board = context && noChaseDiagnosticBoards.get(context.alignmentSlots);
      const matched = !!(board && planInfo && planInfo.mac === board.mac && planInfo.lv === board.lv &&
        planInfo.sig && planInfo.sig.dir === dir && planInfo.sig.source === source &&
        (!context.alignmentConsumed || JSON.stringify(board.lv.alignSlots) === JSON.stringify(context.alignmentSlots)));
      const extra = { reason: 'no-chase: ' + text, dir, source, grade, rejectedGate: 'NO_CHASE',
        diagnosticContext: { status: matched ? 'MATCHED_EVALUATION' : board ? 'MISMATCHED' : 'UNAVAILABLE', cachedBoardUsed: false } };
      if (matched) journalSignalSnapshot(board.mac, board.lv, 'sat_out', extra);
      else appendJournal({ type: 'signal_check', t: Date.now(), outcome: 'sat_out', mac: null, levels: null, checklist: null, ...extra });
    } catch (_) { /* diagnostic only: no effect on the no-chase refusal */ }
  }
  // lv1 r13.3.7d PLAN-END TREND ALLOWANCE (planEndsAtTargetTrend; shipped null = off): a levels entry whose event's plan target was reached before it (the proof's
  // targetReached - the tracker marks instead of ending only when planEndsAtTarget is ON and this is set) is taken only when planEndTrendDecide holds NOW, at this
  // entry price; otherwise trade_block PLAN_END_TARGET (+ the levels journal's lv_block) and the event ends for good, 'target-reached', as planEndsAtTarget alone
  // ends it (+ the levels journal's ended row, with the numbers). Returns null (no mark), { allow: row } or { blocked: true }.
  function planEndTrendGate(pf, dir, entry, source) {
    if (!pf || !pf.targetReached) return null;
    const now = Date.now(), lvl = `${pf.name} ${pf.price}`; let d = null;
    try { d = planEndTrendDecide({ cfg: CONFIG.planEndsAtTargetTrend, dir, entry, at: now, readAt: petBarsReqAt, bars: ctlBars || {}, alignDir: levelEvent.alignDir(entryControlBoard, levelEvent.alignRequired(CONFIG)) }); } catch (e) { d = null; }
    const row = d ? d.row : { trendMode: null }, why = planEndTrendWhy(row, dir);
    if (d && d.allow) { try { log(`  [lv1] plan-end trend: ${dir === 1 ? 'LONG' : 'SHORT'} at ${lvl} - its target was reached before the entry; TAKEN on the trend (${why}).`); } catch (e) { /* log only */ } return { allow: row }; }
    try { log(`  [lv1] plan-end trend: ${dir === 1 ? 'LONG' : 'SHORT'} at ${lvl} - its target was reached before the entry; NOT taken (${why}) - the event ends.`); } catch (e) { /* log only */ }
    try { journalBlock('PLAN_END_TARGET', dir, { source, level: pf.name, levelPrice: pf.price, event: pf.event, entry, targetReachedAt: Number.isFinite(pf.targetReached.at) ? pf.targetReached.at : null, ...row, reason: why, reasonKey: lvl }); } catch (e) { /* journal only */ }
    try { for (const tr of Object.values(levelEventTrackers)) if (tr && typeof tr.endAtTarget === 'function' && tr.endAtTarget(pf, { trend: row }, now)) { lvjDay(now); lvjWrite(levelPanel.endNow(pf, 'target-reached', { by: 'entry-decision', ...row }, now)); break; } } catch (e) { lvjErr(e); }
    return { blocked: true };
  }
  async function takeEntry(dir, entryType, entryPrice, stopPrice, target1, target2, source, grade, tightStopPrice, contracts, signalContext, planInfo = null) {
    // np1 r1.1: FIRST statement - one stretch_check row for EVERY takeEntry call (all routes), before any admission check; candidates checkForNewEntry suppresses
    // upstream never reach takeEntry and are not in this denominator. Journal only; enforced below only in 'block'.
    let stretch = null; try { stretch = stretchRow(dir, entryType, entryPrice, source, grade, signalContext, planInfo); } catch (e) { stretch = null; }
    if (tideOwned() || (tideLiveOn() && CONFIG.tide.oldPathEntries !== true)) { try { journalBlock(tideOwned() ? 'TIDE_POSITION' : 'TIDE_LIVE', dir, { source, grade, reason: tideOwned() ? 'a TIDE position is open (one position account-wide)' : 'tide.mode live: the old levels path takes no new entries (tide.oldPathEntries false)' }); } catch (e) { /* journal only */ } return; }   // [2a]
    let planEndTrendAllow = null;   // lv1 r13.3.7d: set when the plan-end trend allowance let an after-target entry through (the entry row carries it)
    // lv1 r3 CENTRAL GUARD (MacDot 6451687678): under levels-only EVERY route must hand in a Levels-sourced entry with a named level-event proof for this exact
    // direction (lib/levelEvent.js levelProof, frozen by lib/signal.js); anything else is refused here, before any admission check or order.
    if (CONFIG.levelsOnlyEntries) { const pf = signalContext && signalContext.levelProof;
      if (!(source === 'levels' && pf && Object.isFrozen(pf) && pf.dir === dir && typeof pf.name === 'string' && levelEvent.HIERARCHY.includes(pf.name) && Number.isFinite(pf.price) && typeof pf.event === 'string')) {
        try { journalBlock('LEVELS_ONLY', dir, { source, grade, reason: `no named level-event proof on the ${planInfo && planInfo.path ? planInfo.path : 'entry'} route` }); } catch (e) { /* journal only */ } return; }
      if (pf.event === 'BREAK-RETEST') {   // lv1 r13.2: a break-retest is entered AT its retest (at most levelRetestChasePts past the retest close; the price here is the live entry price) and only once
        const lim = Number.isFinite(CONFIG.levelRetestChasePts) ? CONFIG.levelRetestChasePts : 5, past = Number.isFinite(pf.trigger) && Number.isFinite(entryPrice) ? (entryPrice - pf.trigger) * dir : NaN, lvl = `${pf.name} ${pf.price}`;
        if (!(past <= lim)) { try { journalBlock('RETEST_CHASE', dir, { source, level: lvl, entry: entryPrice, trigger: Number.isFinite(pf.trigger) ? pf.trigger : null, past: Number.isFinite(past) ? Math.round(past * 100) / 100 : null, limit: lim, reasonKey: lvl }); } catch (e) { /* journal only */ } return; }
        if (retestTaken.has(retestKey(pf))) { try { journalBlock('RETEST_ONCE', dir, { source, level: lvl, reasonKey: lvl }); } catch (e) { /* journal only */ } return; }
      }
      { const pb = pastLevelBlock({ dir, entry: entryPrice, levelPrice: pf.price, maxPts: CONFIG.maxEntryPastLevelPts });   // lv1 r13.3.7-candidate: too far past the level (null = off)
        if (pb) { const lvl = `${pf.name} ${pf.price}`; try { journalBlock('PAST_LEVEL', dir, { source, level: pf.name, levelPrice: pf.price, entry: entryPrice, pastPts: pb.pastPts, maxEntryPastLevelPts: pb.limit, event: pf.event, reason: `${pb.pastPts} pts past ${lvl} (limit ${pb.limit})`, reasonKey: lvl }); } catch (e) { /* journal only */ } return; } }
      { const hw = htfOpenWait(Date.now(), CONFIG.htfOpenEntryBlockMin); if (hw) { try { journalBlock('HTF_OPEN_WAIT', dir, { source, level: pf.name, levelPrice: pf.price, event: pf.event, entry: entryPrice, minutesInto4H: hw.minutesInto4H, htfOpenEntryBlockMin: hw.limit, h4Start: hw.h4Start, reason: `${hw.minutesInto4H} min into the 4H candle (waits ${hw.limit})`, reasonKey: 'h4|' + hw.h4Start }); } catch (e) { /* journal only */ } return; } }   // lv1 r13.3.7e: the 4H-open wait (null = off)
      { const pt = planEndTrendGate(pf, dir, entryPrice, source); if (pt && pt.blocked) return; if (pt) planEndTrendAllow = pt.allow; }   // lv1 r13.3.7d: an after-target entry (planEndsAtTargetTrend)
      lvjAttempt(pf, { route: planInfo && planInfo.path ? planInfo.path : null, entryType, entry: entryPrice, stop: stopPrice, contracts });   // lv1 r5: levels journal only
    }
    if (!entryControlAllowed(dir, source, planInfo?.path || 'entry', 'takeEntry-start')) { signalPushTake(); return; }
    if (!alignmentEntryAllowed(source, signalContext, 'takeEntry-start')) return;
    const armedSignalPush = signalPushTake();   // 18f1 F1 (notification only): the Signal push checkForNewEntry armed; sent below only when the order is really placed
    // Fresh clock for the new trend position's own 8-bar time-stop (FIX 9
    // Rule 2) — a genuinely-pending (LIMIT/STOP) entry that never fills gets
    // caught by pendingExpireMs first regardless, well before 8 bars.
    // HOTFIX 1: belt and braces - checkForNewEntry() already checks this before the "SIGNAL" log/push; nothing may reach the broker in cooldown.
    if (cooldownBlock(dir)) return;
    // 10-18b2c r2 (MacLock B3 narrow): whatever the risk cap says (it may be off), an order needs a finite entry and stop, the stop on the losing side of the entry,
    // and a whole number of contracts >= 1. Anything else is refused here (journal INVALID_ORDER), on every path (signal, reclaim, wave, reversal).
    if (!(typeof entryPrice === 'number' && Number.isFinite(entryPrice) && typeof stopPrice === 'number' && Number.isFinite(stopPrice) && (dir === 1 ? stopPrice < entryPrice : dir === -1 ? stopPrice > entryPrice : false) && Number.isInteger(contracts) && contracts >= 1)) {
      const why = `entry ${entryPrice}, stop ${stopPrice}, ${contracts} contract(s) is not a valid ${dir === 1 ? 'LONG' : dir === -1 ? 'SHORT' : '?'} order (needs a finite entry and stop, the stop on the losing side, >= 1 whole contract)`;
      log(`  [order-check] ${entryType} NOT placed: ${why}.`); journalBlock('INVALID_ORDER', dir, { source, grade, entryType, entry: Number.isFinite(entryPrice) ? entryPrice : null, stop: Number.isFinite(stopPrice) ? stopPrice : null, contracts, why });
      return;
    }
    if (pausedUntil && Date.now() < pausedUntil) { log('  [pause] entry not placed: paused by you.'); return; }   // 10/16 belt and braces (checkForNewEntry already blocks)
    // 10/18 BROKER AUTH: no new entry while the broker login is failing (lib/bars.js ptxFetch refuses the order too).
    if (token && token.isBrokerAuth === true && token.blocksOrders()) {
      log(`  [auth] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} @ ${Number(entryPrice).toFixed(2)} NOT placed: BROKER AUTH FAILED (${token.lastError || 'the last re-login failed'}).`);
      journalBlock('AUTH_BLOCK', dir, { source, grade, entryType, entry: entryPrice, why: token.lastError || null });
      return;
    }
    // 10/16 NO RE-ARMING A DEAD PLAN: the same plan whose stop was already traded before it filled is not placed again.
    { let dp = null; try { dp = planDeadBlock(dir, entryPrice, stopPrice); } catch (e) { dp = null; }
      if (dp) {
        const at = tlHm(dp.t);
        log(`  [plan] ${dir === 1 ? 'LONG' : 'SHORT'} @ ${entryPrice.toFixed(2)} stop ${stopPrice.toFixed(2)} NOT placed: the same plan was cancelled at ${at} because price reached its ${dp.kind === 'target' ? 'TP1' : 'stop'} first (needs a fresh plan).`);
        journalBlock('PLAN_INVALIDATED', dir, { source, grade, entry: entryPrice, stop: stopPrice, at, kind: dp.kind || 'stop' });
        journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `plan invalidated: the same ${dir === 1 ? 'LONG' : 'SHORT'} plan (entry ${entryPrice.toFixed(2)}, stop ${stopPrice.toFixed(2)}) was cancelled at ${at} when price reached its ${dp.kind === 'target' ? 'TP1' : 'stop'}`, dir, source, grade });
        return;
      } }
    // ROUND 4 (QA B5): a LIMIT plan whose TP1 is ALREADY reached when it would be placed is not placed at all (no order, no phone note, no dead-plan record).
    if (CONFIG.pendingCancelOnStopTouch && entryType === 'LIMIT' && Number.isFinite(target1)) {
      let px = null; try { px = livePx && Number.isFinite(livePx.price) ? livePx.price : lastKnownClose; } catch (e) { px = lastKnownClose; }
      if (Number.isFinite(px) && (dir === 1 ? px >= target1 : px <= target1)) {
        log(`  [plan] ${dir === 1 ? 'LONG' : 'SHORT'} LIMIT @ ${entryPrice.toFixed(2)} not placed: price ${px.toFixed(2)} is already beyond TP1 ${target1.toFixed(2)}.`);
        journalBlock('TP1_ALREADY_PASSED', dir, { source, grade, entry: entryPrice, tp1: target1, px });
        journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `TP1 already passed: price ${px.toFixed(2)} is beyond TP1 ${target1.toFixed(2)} of the ${dir === 1 ? 'LONG' : 'SHORT'} LIMIT at ${entryPrice.toFixed(2)}`, dir, source, grade });
        return;
      }
    }
    // 10/18 RULE 5 SAME-LEVEL BAN: this level + direction was stopped out / cancelled (stop or TP1 touched) in this 15m candle
    { const lvlName = signalContext && signalContext.levelContext ? signalContext.levelContext.name : null; let lb = null; try { lb = levelBanBlock(dir, entryPrice, lvlName); } catch (e) { lb = null; }
      if (lb) {
        log(`  [level-ban] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} @ ${entryPrice.toFixed(2)} NOT placed: the level ${lb.price != null ? lb.price.toFixed(2) : ''}${lb.levelName ? ' (' + lb.levelName + ')' : ''} is banned until ${tlHm(lb.until)} (${lb.why}).`);
        journalBlock('LEVEL_BAN', dir, { source, grade, entryType, entry: entryPrice, levelName: lb.levelName || lvlName || null, bannedPrice: lb.price, banWhy: lb.why, at: tlHm(lb.t), until: tlHm(lb.until) });
        journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `same-level ban until ${tlHm(lb.until)} (${lb.why})`, dir, source, grade });
        return;
      } }
    // 10-18b2a FRESH-STOP (replaces the cooldown + same-level ban): a same-direction re-entry after a stop-out needs its stop beyond the extreme traded since.
    if (CONFIG.reentryFreshStop && freshStopRec && dir === freshStopRec.dir && Number.isFinite(stopPrice)) {
      // 10-18b2c r2 (B12): a finite reference is updated by the live price as before. r3: an UNKNOWN one only by a quote whose MARKET time (livePx.barT, the 1m bar
      // it came from) passes freshStopRepairs - its receipt time (livePx.t) never counts
      try { if (livePx && Number.isFinite(livePx.price) && (freshStopRec.ext !== null || freshStopRepairs(freshStopRec, livePx.barT))) { freshStopRec.ext = freshStopRec.ext === null ? livePx.price : dir === -1 ? Math.max(freshStopRec.ext, livePx.price) : Math.min(freshStopRec.ext, livePx.price); freshStopRec.unknown = false; } } catch (e) { /* keep the tracked extreme */ }
      if (freshStopRec.ext === null) {
        log(`  [fresh-stop] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} @ ${Number(entryPrice).toFixed(2)} NOT placed: no finite price is known since the last stop-out (${tlHm(freshStopRec.t)}) to anchor the fresh-stop rule.`);
        journalBlock('FRESH_STOP_UNKNOWN', dir, { source, grade, entryType, entry: entryPrice, stop: stopPrice, since: tlHm(freshStopRec.t) });
        journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: 'fresh stop: no finite reference price since the last stop-out', dir, source, grade });
        return;
      }
      const ok = dir === -1 ? stopPrice > freshStopRec.ext : stopPrice < freshStopRec.ext;
      if (!ok) {
        log(`  [fresh-stop] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} @ ${entryPrice.toFixed(2)} NOT placed: its stop ${stopPrice.toFixed(2)} is not beyond the ${dir === 1 ? 'low' : 'high'} ${Number(freshStopRec.ext).toFixed(2)} traded since the last stop-out.`);
        journalBlock('FRESH_STOP', dir, { source, grade, entryType, entry: entryPrice, stop: stopPrice, extreme: freshStopRec.ext, since: tlHm(freshStopRec.t) });
        journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `fresh stop: the stop ${stopPrice.toFixed(2)} is inside the ${dir === 1 ? 'low' : 'high'} ${Number(freshStopRec.ext).toFixed(2)} traded since the last stop-out`, dir, source, grade });
        return;
      }
    }
    // 10/18 RULE 4 + TREND REGIME + WAVE: no counter-trend entries (the cloud side is judged at this order's price). A reclaim re-entry skips the wave rule (it is its own pullback).
    if (!(signalContext && signalContext.reversal)) { let gb = null; try { gb = gateBlock(dir, entryPrice, { source, grade, entryType, path: planInfo ? planInfo.path : null, skipWave: !!(signalContext && (signalContext.reclaimOf || signalContext.wave)) }); } catch (e) { gb = null; }
      if (gb) { journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `${gb.code === 'WAVE_WAIT' ? 'wave' : gb.code === 'TREND_FILTER' ? 'trend filter' : 'control filter'}: ${gb.text}`, dir, source, grade }); return; } }
    // 10/16 NO-CHASE: a new entry (market or resting, any source) at the end of an impulsive 15m leg with no 38% pullback is skipped.
    { let nc = null; let ncEx = null; try { ncEx = noChaseExemptB2a(dir, entryType, entryPrice, source, signalContext); } catch (e) { ncEx = null; }
      try { nc = noChaseExempt(CONFIG, source, grade, entryType) || ncEx ? null : noChaseBlock(dir, entryPrice); } catch (e) { nc = null; }
      if (ncEx) { try { const sh = noChaseBlock(dir, entryPrice); journalManage('NO_CHASE_EXEMPT', `No-chase skipped for this ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} (${ncEx.kind})${sh ? '; no-chase would have blocked it: ' + noChaseText(sh) : ''}.`, { dir, entryType, entry: entryPrice, exempt: ncEx, noChaseShadow: sh ? { wouldBlock: true, eAtr: Math.round(sh.eAtr * 100) / 100, retrace: sh.retrace ?? null } : { wouldBlock: false } }); } catch (e) { /* journal only */ } }
      if (nc) {
        const txt = noChaseText(nc), key = `${dir}|${nc.swingT}`;
        if (lastNoChase == null || lastNoChase.key !== key) log(`  [no-chase] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} @ ${entryPrice.toFixed(2)} skipped: ${txt}`);   // once per leg
        lastNoChase = { key, t: Date.now(), dir, text: txt, eAtr: Math.round(nc.eAtr * 10) / 10 };
        journalBlock('NO_CHASE', dir, { source, grade, entryType, entry: entryPrice, ePts: Math.round(nc.E * 100) / 100, atr: Math.round(nc.atr * 100) / 100, eAtr: Math.round(nc.eAtr * 100) / 100, swing: nc.swing, swingLabel: nc.swingLabel, leg: Math.round(nc.leg * 100) / 100, retracePct: Math.round(nc.retrace * 1000) / 10 });
        journalNoChaseSnapshot(planInfo, signalContext, dir, source, grade, txt);
        return;
      } }
    // np1 STRETCH CHECK, 'block' only (shipped 'log'): a flagged entry (20 < 15-min run <= 40 pts, at the hour's directional edge) is skipped.
    if (CONFIG.stretchCheck === 'block' && stretch && stretch.flag === true) {
      log(`  [stretch] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} @ ${Number(entryPrice).toFixed(2)} skipped: it ran ${stretch.disp} pts our way in the last 15 min and sits at ${stretch.hourPos} of the hour's range (late entry).`);
      journalBlock('STRETCH', dir, { source, grade, entryType, entry: entryPrice, disp: stretch.disp, hourPos: stretch.hourPos, version: stretch.version });
      journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `stretch: ran ${stretch.disp} pts in 15 min, at ${stretch.hourPos} of the hour's range`, dir, source, grade });
      return;
    }
    // 10/16 NEWS: no new RESTING (LIMIT/STOP) entry inside the window before a high-impact release (it would be pulled anyway); MARKET entries are allowed.
    if (entryType !== 'MARKET') {
      let nb = null; try { nb = newsRestingBlock(Date.now()); } catch (e) { nb = null; }
      if (nb) {
        const at = new Date(nb.ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT', title = String(nb.title).split(' / ')[0];
        log(`  [news] ${dir === 1 ? 'LONG' : 'SHORT'} ${entryType} entry NOT placed: ${title} is due at ${at} (resting entries are pulled ${CONFIG.newsCancelRestingSec} s before high-impact news).`);
        journalBlock('NEWS_RESTING', dir, { source, grade, entryType, news: title, at });
        journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `news: ${title} at ${at} - no resting entry before a high-impact release`, dir, source, grade });
        return;
      }
    }
    // ENTRY-FIX: broker-position guard right before the order (LIVE): refuse when the broker already has a position / working orders, or another entry was just attempted.
    if (LIVE) {
      const why = await entryGuard('trend entry');
      if (why) { journalBlock('ENTRY_GUARD', dir, { source, grade, reason: why }); journalSignalSnapshot(lastMac, lastLv, 'sat_out', { reason: `entry guard: ${why}`, dir, source, grade }); return; }
      lastEntryAttemptAt = Date.now();
    }
    // reclaim-fix r2.1 (MacDot 6309953783): final originating-watch / deadline check right AFTER the last await (entryGuard) and BEFORE any
    // trade-intent logging or bookkeeping (journal rows, lastEntryPlan, signal push). Nothing below awaits until the order-machine hand-off.
    { const rc = signalContext && signalContext.attemptReceipt;
      if (rc && typeof rc.stillValid === 'function' && !rc.stillValid()) { rc.lateInvalid = true; log('  [entry] not placed: the originating watch ended or its window expired while the entry was being checked.'); return; } }
    if (!entryControlAllowed(dir, source, planInfo?.path || 'entry', 'takeEntry-after-entryGuard')) return;
    if (!alignmentEntryAllowed(source, signalContext, 'takeEntry-after-entryGuard')) return;
    if (!entryQuantityAllowed({ dir, entryPrice, stopPrice, contracts, source, grade, signalContext })) return;
    { const pr = paperRestingRefusal(entryType); if (pr) { log(`  [PAPER] entry not placed: a resting ${entryType} would still be working when ${pr.reason.split(' - ')[0]} starts (in ${Math.round(pr.inMs / 1000)} s); entries are cleared before each window.`); journalBlock('RESTING_ACROSS_BLOCK', dir, { source, grade, entryType, window: pr.reason, inSec: Math.round(pr.inMs / 1000), reasonKey: 'resting|' + pr.reason }); return; } }   // combined fix 4: PAPER parity with the LIVE layer A
    if (CONFIG.macSeenOnOrder && seenCandidate && seenCandidate.dir === dir && source === 'mac') { noteMacSeen(seenCandidate.refT, dir); seenCandidate = null; }   // 10-18b2a: the order goes out now = seen
    trendBarsOpen = 0;
    let leg1Size = leg1SizeForContracts(contracts);
    let leg2Size = leg2SizeForContracts(contracts, leg1Size);
    if (signalContext && signalContext.fullExit) { leg1Size = contracts; leg2Size = 0; }   // 10/18 RULE X: the whole position exits at the target (no runner)
    // SESSION EXITS (optional, default OFF): in an enabled session the base-hit plan replaces the TP1/TP2 legs for this trade (LIVE only; goes through the same state-machine order paths).
    let sessionExit = null;
    if (LIVE) {
      try { sessionExit = sessionExitPlan(CONFIG, ptInfo(Date.now()), dir, entryPrice, contracts, lastMac && lastMac.atrVal, tickSize); } catch (e) { log('  [session-exit] ignored: ' + e.message); sessionExit = null; }
      if (sessionExit && sessionExit.skipped) { log(`  [session-exit] not applied: ${sessionExit.skipped} - normal TP1/TP2 legs used.`); sessionExit = null; }
      if (sessionExit) {
        leg1Size = sessionExit.out; leg2Size = 0; target1 = sessionExit.target1; target2 = sessionExit.target1;
        log(`  [session-exit] ${sessionExit.text}: ${sessionExit.out}x limit at ${target1.toFixed(2)} (${sessionExit.how === 'fixed' ? sessionExit.targetPoints + ' pts' : sessionExit.how}), ${sessionExit.runners}x runner keeps a break-even stop${sessionExit.runnerStopAtBE ? '' : ' and the normal trail'}.`);
      }
    }
    // Single choke point every entry (all 4 signal branches, live or paper)
    // funnels through — cheaper and safer than duplicating this call at
    // each of the 4 call sites above.
    // 2026-09-24 fix (B1): a LIMIT/STOP entry only PLACES an order — the
    // broker may fill it minutes later, cancel it, or never fill it at all.
    // Journaling 'traded' here unconditionally (the old behavior) recorded a
    // PLACEMENT as a fill. MARKET entries genuinely fill immediately, so
    // 'traded' stays correct for those; LIMIT/STOP now journal 'pending'
    // instead, resolved later by journalOrderFilled()/journalOrderCanceled().
    // D3 (QA): a pending journal context left over from an earlier LIMIT/STOP (its cancel/expiry row was never written) must not be consumed by THIS entry's fill
    // (it would write a second 'traded' row with the OLD order's id and stop). The machine is FLAT here and the entry guard has just confirmed the broker shows no working order, so the old order is gone: close its journal row.
    if (pendingJournalContext) { log(`  (journal) clearing a stale pending order row ${pendingJournalContext.journalId} before the new entry`); journalOrderCanceled('superseded by a new entry'); }
    const journalId = crypto.randomUUID();
    const confidence = initialQuantity.confidenceFor({ source, grade, ...(signalContext && Object.hasOwn(signalContext, 'confidence') ? { confidence: signalContext.confidence } : {}) });
    const sizing = quantityForStop(Math.abs(entryPrice - stopPrice), { source, grade, confidence });
    let entryLevel = null;   // r9.14 journal only: travels on the FSM's 'entry' row (it spreads signalContext) and on the pending row
    try { entryLevel = entryLevelFor(dir, entryPrice, signalContext ? signalContext.levelContext : null, latestLevelBoard, Date.now()); } catch (e) { entryLevel = null; }
    const signalContextTl = { ...signalContext, confidence, sizing, journalId, entryLevel, ...(planEndTrendAllow ? { planEndTrendAllow } : {}) };   // lv1 r13.3.7d: + the plan-end trend allowance that let it through (journal only)
    try { const jr = require('./lib/journalReceipts'); jr.emit(appendJournal, () => jr.selected({ journalId, dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, source, grade, contracts, leg1Size, leg2Size, signalContext: signalContextTl, sizing, planInfo, config: CONFIG, decisionAt: Date.now() })); } catch (_) { /* receipt only */ }
    if (!entryQuantityAllowed({ dir, entryPrice, stopPrice, contracts, source, grade, signalContext: signalContextTl, leg1Size, leg2Size })) return;
    try {   // 10/19 journal only (Mac): market context, stop distance, confidence and main reason at entry
      const sc = signalContext || {}, nowJ = Date.now();
      appendJournal({ type: 'entry_context', t: nowJ, journalId, phase: 'pre-send', note: 'decision snapshot after sizing/quantity admission, BEFORE the order is sent; does not prove a fill (see the entry / trade_time rows with the same journalId)',
        dir, source, grade, entryType, plannedEntryPrice: entryPrice, plannedStopPrice: stopPrice, plannedContracts: contracts,
        market: journalContext.marketContext(journalBars, nowJ, journalReadAt),
        stopDistance: journalContext.stopDistance({ dir, entryPrice, stopPrice, contracts, pointValue }),
        confidence: { source: confidence.source, grade: confidence.grade, gradeCeilingContracts: sizing.gradeCeiling, sizingReason: sizing.reason,
          macLongScore: sc.macLongScore ?? null, macShortScore: sc.macShortScore ?? null, levelsPlanGrade: sc.levelsPlan ? sc.levelsPlan.grade : null,
          levelsBiasScore: sc.levelsBiasScore ?? null, biasAgreement: sc.biasAgreement ?? null,
          controlScore: entryControlBoard && Number.isFinite(entryControlBoard.controlBiasScore) ? Math.round(entryControlBoard.controlBiasScore * 1000) / 1000 : null, controlValid: entryControlBoard ? entryControlBoard.controlValid === true : null },
        mainReason: journalContext.mainReason({ dir, source, grade, entryType, entryWhy: planInfo && planInfo.entryWhy, signalContext: sc }) });
    } catch (e) { /* journal only: never blocks an entry */ }
    appendJournal({ type: 'initial_quantity_admission', journalId, source, grade, ...sizing, allowedContracts: sizing.contracts, selectedContracts: contracts, limitingReason: contracts < sizing.contracts ? (signalContext?.controlContested ? 'existing-control-minimum' : 'caller-reduction') : sizing.reason }); // TRADE LOG: the 'entry' event now carries the journalId so Recent Trades can open the Why view (original signalContext left untouched for everything else)
    // entryPath (2026-10-12, display only): the path that actually FIRED this entry. The row's mac/levels/checklist snapshot below is
    // the last 15m-close board (lastMac/lastLv), which can differ from an intrabar / 5m / 3m Levels trigger.
    const entryPath = signalContext ? { source, triggerTf: signalContext.triggerTf ?? null, intrabar: !!signalContext.isIntrabar } : null;
    if (entryType === 'MARKET') {
      // 18f1 LABEL (journal only): LIVE writes 'attempted' when the order is SENT and 'traded' when the broker fill is confirmed (watchLiveLifecycle ->
      // journalMarketFilled). 10-18 wrote 'traded' here, before the order was even sent (10/14: 113 'traded' rows, 0 broker fills). PAPER fills right here: 'traded'.
      journalSignalSnapshot(lastMac, lastLv, LIVE ? 'attempted' : 'traded', { journalId, dir, source, grade, contracts, entryType, entryPrice, stopPrice, entryPath, entryLevel });   // r9.14: MARKET rows too
      if (LIVE) marketAttemptContext = { journalId, dir, source, grade, contracts, entryType, entryPrice, stopPrice, entryPath, entryLevel, placed: false };
      openJournalContext = { journalId, dir, contracts, entryPrice, source, grade, peakUnrealized: 0, entryTime: Date.now() };
    } else {
      journalOrderPending({ journalId, dir, contracts, entryType, entryPrice, stopPrice, source, grade, entryPath, planPath: planInfo ? planInfo.path : null, levelName: signalContext && signalContext.levelContext ? signalContext.levelContext.name : null, entryLevel });   // round 4: planPath (far-limit switch; not journaled)
    }
    const tradePlanRow = planInfo ? journalTradePlan(planInfo, { journalId, dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, source, grade, contracts, leg1Size, leg2Size, signalContext: signalContextTl, sessionExit }) : null; // TRADE LOG (journal only)
    // 10/18: the plan the ban / reclaim read when this trade closes; any fresh (non-reclaim) entry ends a running reclaim watch
    sizeIntent = { journalId, contracts, source, entryType, planPath: planInfo ? planInfo.path || null : null, dir, noted: false };   // lv1 r13.3.3 SIZE_PARTIAL (journal only)
    lastEntryPlan = { dir, entryPrice, stop: stopPrice, target1, target2, source, grade, confidence, sizing, contracts, journalId, levelName: signalContext && signalContext.levelContext ? signalContext.levelContext.name : null, reclaimOf: signalContext && signalContext.reclaimOf ? signalContext.reclaimOf : null };
    if (!(signalContext && signalContext.reclaimOf) && reclaimWatch) { log('  [reclaim] a new entry was taken: the reclaim watch ends.'); reclaimWatch = null; }
    const entrySignalPush = withEntryDetail(armedSignalPush, { row: tradePlanRow, dir, contracts, entryType, entryPrice, stopPrice, target1, target2, sizing, alignmentConsumed: signalContext ? signalContext.alignmentConsumed : undefined, showGrade: !CONFIG.levelsOnlyEntries });   // lv1 r13.3.4: no grade in the push under levels-only   // notification only: detailed entry push
    signalPushFire(entrySignalPush, dir, planInfo ? planInfo.path : null, entryPrice, stopPrice);   // 18f1 F1: every gate above has passed; the order is sent next
    // reclaim-fix r2 (MacDot 6309836012): per-call attempt receipt (its final validity check sits right after the entry guard, above).
    // The receipt is marked handedOff at the ONE point the entry is handed to the order state machine (LIVE) or booked (PAPER). handedOff means 'handed to the FSM', NOT 'transmitted to the broker':
    // the FSM / transport can still refuse without a raw send. Callers treat it conservatively as an attempt.
    { const rc = signalContext && signalContext.attemptReceipt; if (rc) rc.handedOff = true; }
    const lvHand = CONFIG.levelsOnlyEntries && signalContext && signalContext.levelProof ? journalId : null;   // lv1 r6: an order on a level event (journal only)
    try { revLevelNote(journalId, signalContext && signalContext.levelProof); } catch (e) { /* lv1 r13.3.3: the trade's own level for the shadow R2 (journal only) */ }
    const lvPh0 = LIVE && stateMachine ? stateMachine.phase : null, lvOid0 = LIVE && stateMachine ? stateMachine.entryOrderId : null;   // lv1 r10: identity of this attempt (journal only)
    if (lvHand) lvjHanded(signalContext.levelProof, { route: planInfo && planInfo.path ? planInfo.path : null, entryType, entry: entryPrice, stop: stopPrice, target1, target2, contracts, journalId, live: !!LIVE });
    if (lvHand && signalContext.levelProof.event === 'BREAK-RETEST') { retestTaken.add(retestKey(signalContext.levelProof)); if (retestTaken.size > 200) retestTaken.delete(retestTaken.values().next().value); }   // lv1 r13.2: one trade per retest
    if (LIVE) {
      await stateMachine.openEntry({ dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, source, grade, contracts, leg1Size, leg2Size, signalContext: signalContextTl, ...(sessionExit ? { sessionExit: { session: sessionExit.session, runnerStopAtBE: sessionExit.runnerStopAtBE } } : {}) });
      journalMarketAfterSend(journalId);   // 18f1 LABEL (journal only): a MARKET entry the broker rejected gets its 'canceled' row
      // 18p1 (protection timing): a MARKET entry fills at once, so look for the fill NOW (fill-only tick: stop + TP1 on a complete fill, nothing else), not 20 s later
      if (entryType === 'MARKET' && stateMachine.phase === 'PENDING_ENTRY') { try { if (await pendingFillCheck()) watchLiveLifecycle('PENDING_ENTRY'); } catch (e) { log('  [live] immediate fill check after the MARKET entry failed (non-fatal; the fast poll retries in 3 s): ' + e.message); } }   // lv1 r13.3.2: the executor's adapter (the FSM has no tickFill)
      if (lvHand) { const ph = stateMachine.phase, oid = stateMachine.entryOrderId, own = lvPh0 === 'FLAT' && oid != null && oid !== lvOid0;   // lv1 r10 (MacDot 6455780460 #4): only THIS attempt's order counts
        lvjOrder(lvHand, !own || ph === 'FLAT' ? 'not-admitted' : ph === 'PENDING_ENTRY' ? 'accepted' : 'filled', { phase: ph, orderId: own ? oid : null,
          ...(own ? {} : { reason: lvPh0 !== 'FLAT' ? `the FSM was ${lvPh0} before this attempt - refused; the open position is an earlier entry's` : 'no new broker order id for this attempt' }),
          ...(own && ph !== 'FLAT' && ph !== 'PENDING_ENTRY' && Number.isFinite(stateMachine.entryPrice) ? { fill: stateMachine.entryPrice } : {}) }); }
    } else if (entryType === 'MARKET') {
      position = { dir, entryPrice, entryType: 'MARKET', stopPrice, tightStopPrice, smartHoldChecked: false, target1, target2, source, grade, contracts, leg1Size, leg2Size, plan: lastEntryPlan, leg1Closed: false, leg2Closed: false, leg3Closed: false };
      paperStopCap(position, entryPrice, (() => { try { return entryFloorAt(Date.now()).pts; } catch (e) { return null; } })() ?? stopCapFloorMaxOf(CONFIG));   // lv1 r13.6.2
      if (lvHand) lvjOrder(lvHand, 'filled', { paper: true, fill: entryPrice });   // lv1 r6: paper MARKET is booked at once
    } else {
      pending = { dir, entryType, entryPrice, stopPrice, tightStopPrice, target1, target2, source, grade, contracts, leg1Size, leg2Size, plan: lastEntryPlan, signalTime: Date.now() };
      if (lvHand) lvjOrder(lvHand, 'accepted', { paper: true });   // lv1 r6: paper LIMIT / STOP rests until the paper book fills or cancels it
    }
  }

  // Trend-position time-stop (2026-09-24, FIX 9 Rule 2). Only counts while pre-TP1 (leg1 still open); resets to 0
  // once TP1 hits, on any stop-out, or on the NEXT fresh entry (see
  // takeEntry()). Reuses stateMachine.flattenNow() for LIVE — already
  // proven by the manual-flatten path, handles LEG1_OPEN correctly (cancels
  // resting stop/target, market-closes whatever size actually exists).
  async function tickTrendTimeoutBarClose() {
    const inLeg1 = LIVE ? (stateMachine.phase === 'LEG1_OPEN') : (position != null && !position.leg1Closed);
    if (!inLeg1) { trendBarsOpen = 0; return; }
    trendBarsOpen++;
    if (trendBarsOpen < CONFIG.trendMaxBarsToTP1) return;
    log(`  Trend position hit its ${CONFIG.trendMaxBarsToTP1}-bar time stop without reaching TP1 — exiting all legs at market.`);
    journalManage('TIME_STOP', `Time stop: the trade had not reached TP1 after ${CONFIG.trendMaxBarsToTP1} closed 15m bars (${CONFIG.trendMaxBarsToTP1 * 15} minutes), so the bot closes everything at market instead of waiting for the stop.`, { bars: CONFIG.trendMaxBarsToTP1 });
    notifyPhone('Trend position time-stop', `${CONFIG.trendMaxBarsToTP1}-bar timeout without reaching TP1 — closing all remaining contracts at market.`, { priority: 'high', tags: 'chart_with_downwards_trend' });
    if (LIVE) {
      try { require('./lib/journalReceipts').attemptClose(stateMachine, 'trend_timeout', 'AUTOMATIC', 'tickTrendTimeoutBarClose'); } catch (_) { /* receipt only */ }
      await stateMachine.flattenNow();
    } else if (position) {
      paperCloseRemaining(lastKnownClose, 'time-stop');
      journalPositionClosed(lastKnownClose, position.realizedPnlSoFar);
      position = null;
    }
    trendBarsOpen = 0;
  }

  process.on('SIGINT', () => {
    if (!LIVE) log(`\nShutting down. Final paper total P&L: $${paperTotalPnl.toFixed(2)}  (today so far: $${dayRealizedPnl.toFixed(2)})`);
    else log(`\nShutting down LIVE executor. Any open position/resting orders are UNCHANGED on the exchange — check the terminal or TopstepX platform directly.`);
    process.exit(0);
  });

  // FAST ORDER/POSITION POLL (profit-trail D2): while a trend position is open, the bot re-reads the broker position every CONFIG.openPositionPollMs (default 3 s) in the gaps between the
  // 20 s signal polls, so a fill (TP1/TP2/stop) is processed - sibling order cancelled, new stops placed - within seconds instead of up to 20 s. Same tick() as the main poll (idempotent:
  // it only acts on a change of the broker position size). Costs about 1 read call per 3 s while a position is open; nothing while flat. null/0 = off (old behaviour).
  // dashfix (DISPLAY ONLY - touches no order, no risk variable and no state machine field): one step of the day tracker. Called from the 20 s loop AND
  // from every ~3 s fast-poll wake-up, so the 5 PM CT (3 PM PT) rollover fires on the WALL CLOCK even when no 1m bar arrives (market closed 2-3 PM PT).
  // It only READS lastAccountBalance / computeUnrealizedPnl() / the state machine phase; the one broker call it can make is the balance read at rollover.
  async function dayTrackerTick() {
    if (!LIVE) return;
    try {
      const now = Date.now();
      if (dayTracker.needsRollover(now) && dayTracker.mayTryRollover(now)) {
        const bal = await refreshAccountBalance();
        if (bal != null) {
          const o = dayTracker.rollover(now, bal);
          log(`[day-tracker] NEW TRADING DAY (wall-clock 5 PM CT / 3 PM PT rollover): start balance $${bal.toFixed(2)}. Yesterday: start $${o.startBalance == null ? '?' : o.startBalance.toFixed(2)}, peak $${o.peak.toFixed(2)}, final = balance change ${o.startBalance == null ? '?' : '$' + (bal - o.startBalance).toFixed(2)}.`);
          writeSnapshotFile();
        } else log('  [day-tracker] rollover is due but the account balance could not be read; retrying in 10 s');
      }
      if (dayTracker.needsRollover(now)) return; // rollover still pending: do not sample the old day against the new clock
      dayTracker.ensureStart({ balance: lastAccountBalance, realizedEstimate: dayFillsKnownFor === dayTracker.state.dayKey ? dayPnlAllFills : null, nowMs: now });
      const peakBefore = dayTracker.state.peak;
      if (Date.now() < fastPollPausedUntil || (stateMachine && stateMachine.desynced)) return; // balance and position size may disagree now: take no peak sample
      dayTracker.sample(now, { balance: lastAccountBalance, openPnl: computeUnrealizedPnl(), phase: stateMachine ? stateMachine.phase : null });
      if (dayTracker.state.peak !== peakBefore) writeSnapshotFile(); // a new day high: show it on the phone now, not at the next 20 s snapshot
    } catch (e) { log('  [day-tracker] step failed (non-fatal, display only): ' + e.message); }
  }

  let fastPollPausedUntil = 0;   // HTTP 429 back-off: the fast poll sits out 15 s after a rate-limit answer (the normal 20 s poll is unaffected)
  let expiryWakeFor = null;   // r9.6: entry order id whose expiry already woke the main loop (one early wake per entry)
  let windowWakeAt = 0;   // TIME BLOCKS r1: last fast-poll wake for a block boundary (repeats every ~9 s while the entry still rests: a failed cancel is retried)
  let lastPendingM1 = null;   // r9.6: the last 1m bars seen by the main loop, for the early expiry pass at the top of the next pass
  // lv1 r13.3.2 PROTECTION TIMING: the fill of a pending entry, seen on the fast cadence (the MARKET entry's immediate check, the ~3 s fast poll of a resting
  // entry) instead of at the next ~20 s main-loop tick. The installed FSM (1172bfb3 / 3679078b) has no tickFill(), so 18p1's two callers threw and protection
  // waited for the main loop. This adapter only READS the position. On an observed fill of THIS entry (the FSM's own identity check: contract, account, side,
  // 0 < size <= the entry's contracts) it runs the FSM's own tick() with the options the FSM's own cancel paths use (no blackout / startup / news / stop-touch /
  // TP1-touch cancel on this cadence), i.e. exactly the main loop's fill path:
  //   a full fill = shift / keep / through-stop exit, the floor from the fill, the stop (only when there is none) and the TP1, then LEG1_OPEN;
  //   a partial fill = the FSM's resolvePendingCancel: the partial protected first, then the remainder's verified cancel.
  // No fill, not this entry's exposure, desynced, a cancel in flight, or the phase / entry order changed while the position was read: nothing at all
  // (expiry and every cancel stay on the main loop; the fast poll wakes the main loop for a due expiry before it gets here). A failed read throws to the
  // caller (logged; HTTP 429 pauses the fast poll 15 s) and never touches the FSM's read-failure count. One owner: both callers run inside the main loop's
  // own awaited flow, so two ticks never overlap. A later FSM's own tickFill(), if it has one, is used instead.
  // Returns true only when the phase left PENDING_ENTRY (the caller then runs watchLiveLifecycle once).
  async function pendingFillCheck(sm = stateMachine) {
    if (sm && typeof sm.tickFill === 'function') return sm.tickFill();
    if (!sm || sm.desynced || sm.phase !== 'PENDING_ENTRY' || sm.entryOrderId == null || sm._cancelInFlight) return false;
    const oid = sm.entryOrderId;
    const pos = await getOpenPosition(sm.token, sm.accountId, sm.contractId);
    if (!pos || !(pos.size > 0) || !sm.cancelPositionMatches(pos)) return false;   // no fill / not this entry's exposure: the main loop decides
    if (sm.desynced || sm.phase !== 'PENDING_ENTRY' || sm.entryOrderId !== oid || sm._cancelInFlight) return false;   // changed while the position was read
    await sm.tick({ noBlackout: true, noStopTouch: true });
    return sm.phase !== 'PENDING_ENTRY';
  }
  async function sleepWithFastPoll(totalMs) {
    const step = CONFIG.openPositionPollMs;
    if (!LIVE || !step || step >= totalMs) { const w = pendingWindowWakeIn(totalMs); if (w != null) log(`  [pending] a resting entry's time-window lead begins in ${Math.round(w / 1000)} s - waking the loop then.`); await sleep(w != null ? w : totalMs); return; }   // combined fix 4
    const end = Date.now() + totalMs;
    while (Date.now() < end) {
      await sleep(Math.min(step, Math.max(0, end - Date.now())));
      if (Date.now() >= end) break;
      if (typeof dayTrackerTick === 'function') await dayTrackerTick(); // dashfix: display-only (wall-clock rollover + peak sample every ~3 s); the typeof guard keeps smoke-test-stop-target-race.js (which extracts this loop on its own) unchanged
      // combined fix 4: the boundary wake makes no broker call, so it runs during an HTTP 429 pause too (the main loop's verified cancel then runs)
      if (Date.now() < fastPollPausedUntil && !stateMachine.desynced && stateMachine.phase === 'PENDING_ENTRY' && typeof stateMachine.pendingWindowDue === 'function' && stateMachine.pendingWindowDue() && Date.now() - windowWakeAt >= step * 3) { windowWakeAt = Date.now(); log('  [fast-poll] paused (HTTP 429), but a resting entry faces a time block - running the main loop now.'); return; }
      if (Date.now() < fastPollPausedUntil) continue;
      const ph = stateMachine.phase;
      // 18p1 (protection timing): a RESTING entry is fast-polled too, fill-only (lib/liveStateMachine.js tickFill): the fill is seen and the stop + TP1 placed within ~3 s,
      // not at the next 20 s main loop. Everything else about a resting entry (stop-touch check on the 1m bars, expiry, blackout / news / touch cancels) stays on the main loop.
      if (tideDrv && tideDrv.fast()) { try { await tideDrv.poll({}); } catch (e) { log('  [fast-poll] TIDE fill check failed (non-fatal): ' + e.message); } }   // [2a] 3 s: a TIDE fill is protected within ~3 s
      if (!stateMachine.desynced && ph === 'PENDING_ENTRY') {
        // r9.6: the 5-minute deadline wakes the main loop at once (once per entry) instead of waiting out the 20 s sleep; tick() does the verified cancel.
        if (stateMachine.pendingExpiryDue() && expiryWakeFor !== stateMachine.entryOrderId) { expiryWakeFor = stateMachine.entryOrderId; log('  [fast-poll] pending entry reached its expiry - running the main loop now.'); return; }
        // TIME BLOCKS r1: a block starts within entryWindowLeadSec (or has started): the main loop's verified cancel runs now, before the boundary, not at the next 20 s pass.
        if (typeof stateMachine.pendingWindowDue === 'function' && stateMachine.pendingWindowDue() && Date.now() - windowWakeAt >= 3 * step) { windowWakeAt = Date.now(); log(`  [fast-poll] pending entry vs time block (${stateMachine.blackoutFn(Date.now())}) - running the main loop now.`); return; }
        try { if (await pendingFillCheck()) watchLiveLifecycle(ph); }   // lv1 r13.3.2: the executor's adapter (the FSM has no tickFill)
        catch (e) {
          log('  [fast-poll] fill check failed (non-fatal): ' + e.message);
          if (/HTTP 429/.test(e.message)) { fastPollPausedUntil = Date.now() + 15000; log('  [fast-poll] rate limited (HTTP 429): pausing the fast poll for 15 s'); }
        }
        continue;
      }
      if (stateMachine.desynced || !(ph === 'LEG1_OPEN' || ph === 'LEG23_OPEN' || ph === 'LEG3_OPEN' || ph === 'FLATTENING')) continue;
      try {
        const revT0 = Date.now();   // lv1 r13.3.3 (shadow log only): the tick below reads the position after this time
        await stateMachine.tick();
        await stopCapAfterTick();   // lv1 r13.6.2
        await stateMachine.sweepStaleStops();
        try { if (ph === 'LEG1_OPEN' && typeof revLeg1Seen === 'function') revLeg1Seen(revT0); } catch (e) { /* lv1 r13.3.3: shadow log only */ }   // still LEG1_OPEN after that read = the trade was open at revT0 (one in-memory time, nothing else)
        // a fill just changed the position: bring the stops to their intended level now (profit lock after TP1, etc.) instead of at the next 20 s poll
        if (stateMachine.phase !== ph && (stateMachine.phase === 'LEG23_OPEN' || stateMachine.phase === 'LEG3_OPEN') && lastKnownClose != null) {
          if (CONFIG.profitTrail && CONFIG.profitTrail.enabled) stateMachine.updateProfitTrail(lastKnownClose);
          if (CONFIG.stopLadderAudit || (CONFIG.profitTrail && CONFIG.profitTrail.enabled)) await stateMachine.auditStopLadder(lastKnownClose);
        }
        watchLiveLifecycle(ph);
      } catch (e) {
        log('  [fast-poll] failed (non-fatal): ' + e.message);
        if (/HTTP 429/.test(e.message)) { fastPollPausedUntil = Date.now() + 15000; log('  [fast-poll] rate limited (HTTP 429): pausing the fast poll for 15 s'); }
      }
    }
  }

  let flattenReadFails = 0;   // profittrail4
  while (true) {
    try {
      // r9.6 (MacDot aa79108 #1): a due pending expiry is serviced FIRST in each pass, before the token renewal, reconciliation and history fetches that can take
      // seconds; stop-touch / TP1-touch use the previous pass's 1m bars (<= one poll old) and keep their priority inside tick(). The normal tick later in the pass runs too.
      // TIME BLOCKS r2: a resting entry left by the previous run that could not yet be confirmed cancelled is retried first (its exact order id only)
      if (LIVE && stateMachine._orphanEntry) { try { await stateMachine.orphanEntryStep(); } catch (e) { log('  [startup-entry] retry failed (non-fatal; retried next pass): ' + e.message); } }
      // TIME BLOCKS r1: a resting entry facing a time block (inside it, or within entryWindowLeadSec of it) is serviced first as well; tick() runs the verified cancel (a fill wins).
      if (LIVE && !stateMachine.pendingExpiryDue() && stateMachine.pendingWindowDue()) {
        const phW = stateMachine.phase;
        try { if (lastPendingM1) stateMachine.notePendingBars(lastPendingM1); await stateMachine.tick(); }
        catch (e) { log('  [pending] early time-block pass failed (non-fatal; the normal tick retries): ' + e.message); }
        watchLiveLifecycle(phW);
        await stopCapAfterTick();   // lv1 r13.6.2: a fill in this early pass is capped now, not after the history fetches
      }
      if (LIVE && stateMachine.pendingExpiryDue()) {
        const phB = stateMachine.phase;
        try { if (lastPendingM1) stateMachine.notePendingBars(lastPendingM1); await stateMachine.tick(); }
        catch (e) { log('  [pending] early expiry pass failed (non-fatal; the normal tick retries): ' + e.message); }
        watchLiveLifecycle(phB);
        await stopCapAfterTick();   // lv1 r13.6.2
      }
      // combined fix 5 (MacDot 6331384026): PAPER early pass - a resting paper entry facing a window is resolved BEFORE the token renewal / history work below
      if (!LIVE && pending && entryWindowReason(Date.now())) {   // a paper MARKET entry is never pending (it books a position at once)
        // r7 (MacDot 6331741152): the cancel deadline does not depend on the bar fetch. Fill evidence = a 1m bar RECEIVED within PAPER_WINDOW_FETCH_MS (2 s);
        // a slow or unresolved fetch cancels without a fill, and a bar that arrives later cannot fill an order already cancelled (pending is gone).
        let eb = null; try { const m1e = await Promise.race([fetchBars(token, contractId, UNIT.MINUTE, 1, { limit: 3 }), new Promise(r => setTimeout(() => r('deadline'), PAPER_WINDOW_FETCH_MS))]); eb = Array.isArray(m1e) && m1e.length ? m1e[m1e.length - 1] : null; } catch (e) { eb = null; }
        try { if (eb) resolvePaperPending(eb); else { const why = entryWindowReason(Date.now()); log(`  [PAPER] entry cancelled: ${why} (no 1m bar received within ${PAPER_WINDOW_FETCH_MS / 1000} s, so no fill evidence; a later bar cannot fill it).`); journalOrderCanceled('entry cancelled: blackout started (' + why + ')'); pending = null; } }
        catch (e) { log('  [PAPER] early time-window pass failed (non-fatal; the normal pass retries): ' + e.message); }
      }
      // 10/18 BROKER TOKEN: renew it before it expires (tokenRefreshHours); a failure is logged/journalled and retried on the next poll (rate-limited).
      try { await token.maybeProactive(); } catch (e) { log('  [auth] proactive token renewal failed (non-fatal): ' + e.message); }
      await dayTrackerTick(); // dashfix: display-only; the wall-clock day rollover must not wait for a new bar
      if (vixFeed.needsRefresh(Date.now())) vixFeed.refresh('daily refresh').then(() => { vixBars = vixFeed.bars; });   // FIX1015: VIX daily, in the background (never throws, never holds up the loop)
      // ── Catch a manual/unknown position every poll cycle, not just at
      // startup — see reconcileIfUnknownPosition()'s own comment for why.
      if (LIVE) {
        try { await reconcileIfUnknownPosition('LIVE RECONCILIATION'); }
        catch (e) { log('  [live] periodic reconciliation check failed (non-fatal): ' + e.message); }
        await refreshBrokerGuardView();   // FIX1015: checklist broker-guard row (at most once a minute while flat; never throws)
      }

      // ── 10/16 manual pause / resume request from mobile.html (POST /pause), checked every poll cycle; then the pause expiry ──
      if (fs.existsSync(PAUSE_REQUEST_FILE)) {
        let rq = null; try { rq = JSON.parse(fs.readFileSync(PAUSE_REQUEST_FILE, 'utf8')); } catch (e) { rq = null; }
        try { fs.unlinkSync(PAUSE_REQUEST_FILE); } catch (e) { /* best effort */ }
        if (rq) await handlePauseRequest(Number(rq.minutes));
      }
      checkPauseExpiry();
      // ROUND 4 (QA M1): a resting entry whose pause cancel failed ('retry') is retried every poll while the pause lasts (verified cancel, a fill wins)
      if (LIVE && pausedUntil && Date.now() < pausedUntil && stateMachine.phase === 'PENDING_ENTRY') { const ph = stateMachine.phase; try { await stateMachine.cancelPendingForPause(new Date(pausedUntil).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT'); } catch (e) { log('  [pause] retrying the resting-entry cancel failed (next poll): ' + e.message); } watchLiveLifecycle(ph); }
      // Cancel-only requests are bound to the displayed entry; never converted to flatten.
      try {
        const previousPhase = stateMachine && stateMachine.phase;
        await entryCancelQueue.process(LIVE ? stateMachine : null, r => {
          journalManage('ENTRY_CANCEL_REQUEST', `${r.requestId}: ${r.outcome}: ${r.detail}`, r);
          if (['cancelled', 'resolved', 'filled'].includes(r.outcome)) notifyPhone('Entry cancel: ' + r.outcome, `${r.requestId}: ${r.detail}`, { tags: 'information_source' });
        });
        if (LIVE) watchLiveLifecycle(previousPhase);
      } catch (e) { log('Entry cancel receipt unavailable: ' + e.message); }
      // ── Manual flatten request from mobile.html, checked every poll cycle ──
      if (fs.existsSync(FLATTEN_REQUEST_FILE)) {
        try { fs.unlinkSync(FLATTEN_REQUEST_FILE); } catch (e) { /* best-effort — worst case we act on it twice, which is a safe no-op */ }
        log('MANUAL FLATTEN requested via mobile — executing now.');
        if (LIVE && tideOwned()) {   // [2a] the TIDE position: the planner's flatten (verified stop cancel -> market -> confirming read); retried each poll while it closes
          try { await tideDrv.exitAtMarket('manual flatten (mobile)'); } catch (e) { log('  [tide-live] manual flatten step failed: ' + e.message); }
          if (tideOwned()) { try { fs.writeFileSync(FLATTEN_REQUEST_FILE, JSON.stringify({ requestedAt: Date.now(), retry: true, tide: true })); } catch (e2) { /* best effort */ } log(`  [tide-live] manual flatten: the TIDE position is closing (${tideDrv.phase()}) - checked again next poll.`); if (!manualTideNoted) { manualTideNoted = true; notifyPhone('Flatten: TIDE closing', `Closing the TIDE position at market (planner flatten, phase ${tideDrv.phase()}). Confirming next poll.`, { priority: 'high', tags: 'octagonal_sign' }); } }
          else { manualTideNoted = false; notifyPhone('Flatten: TIDE done', 'The TIDE position is flat (manual flatten).', { priority: 'high', tags: 'checkered_flag' }); journalManage('TIDE_MANUAL_FLATTEN', 'Manual flatten (mobile): the TIDE position was closed by the planner flatten.', {}); }
        }
        if (LIVE) {
          try { require('./lib/journalReceipts').attemptClose(stateMachine, 'flatten_request_file', 'UNKNOWN', 'FLATTEN_REQUEST_FILE consumer; file does not authenticate human actor'); } catch (_) { /* receipt only */ }
          try { await stateMachine.flattenNow(); flattenReadFails = 0; }
          catch (e) {
            if (!e.positionUnreadable) throw e;
            // profittrail4: the position could not be read, so nothing was cancelled or sent and the bot did NOT reset: keep the request and retry on the next poll
            flattenReadFails++;
            log(`  [live] MANUAL FLATTEN could not read the broker position (${e.message}) - nothing cancelled, stops stay resting; retrying in one poll (attempt ${flattenReadFails}).`);
            try { fs.writeFileSync(FLATTEN_REQUEST_FILE, JSON.stringify({ requestedAt: Date.now(), retry: true })); } catch (e2) { /* best effort */ }
            if (flattenReadFails === 1 || flattenReadFails % 5 === 0) notifyPhone('Flatten: cannot read the position', `Your flatten request could not read the broker position (${e.message}). Nothing was cancelled; the bot retries every poll. If this continues, flatten in TopstepX.`, { priority: 'urgent', tags: 'rotating_light' });
          }
        } else if (position || pending) {
          log('  [PAPER] flatten requested — clearing simulated position/pending (nothing real to close).');
          // Approximate for an open position (2026-09-24) — realizedPnlSoFar
          // only reflects legs already closed via recordLeg(); any still-open
          // remainder's unrealized P&L isn't folded in here, matching this
          // path's existing level of rigor (it never computed exact P&L on
          // manual paper-flatten either).
          if (position) journalPositionClosed(lastKnownClose, position.realizedPnlSoFar);
          else if (pending) journalOrderCanceled('manual flatten (paper)');
          position = null; pending = null;
          notifyPhone('Flatten (paper)', 'Cleared simulated position per your flatten request.', { tags: 'octagonal_sign' });
        }
      }

      // ── 10/17 SESSION CLOSE (flatten at sessionFlattenPt, alert if still not flat) ──
      try { await sessionCloseStep(); } catch (e) { log('  [session] step failed (non-fatal, retried next poll): ' + e.message); }
      try { await morningFlattenStep(); } catch (e) { log('  [morning] step failed (non-fatal, retried next poll): ' + e.message); }

      // ── 0. Periodic phone status push (view-only, ntfy.sh) ──
      if (NTFY_TOPIC && Date.now() - lastStatusPushTime >= CONFIG.statusPushIntervalMs && NP.statusPushWindow(Date.now())) {   // 18f1 F3: 15:00-13:10 PT trading days only
        lastStatusPushTime = Date.now();
        notifyPhone('Status update', buildStatusMessage(), { tags: 'bar_chart' });
      }

      try { newsMaybeRefresh(); } catch (e) { /* background, never blocks */ }   // 10/16 news calendar refresh (startup + every 6 h)
      // ── 1. Fast poll ──
      const m1 = await fetchBars(token, contractId, UNIT.MINUTE, 1, { limit: 3 });
      if (tideOn()) tideM1Tail = m1;   // TIDE r2: the shadow reads these bars AFTER the pass (below)
      const liveBar = m1[m1.length - 1];
      if (tideDrv && tideDrv.owned() && liveBar) { try { await tideDrv.poll({ lastPx: liveBar.c, bar: liveBar }); } catch (e) { log('  [tide-live] poll failed (non-fatal, retried next poll): ' + e.message); } }   // [2a]
      if (liveBar) {
        lastKnownClose = liveBar.c;
        if (Number.isFinite(liveBar.c)) livePx = { price: liveBar.c, t: Date.now(), barT: liveBar.t, src: '1m' };
        const dayKey = tradingDayKey(liveBar.t);
        // 10/19 QA-A (18f1): forward only. After a restart between 3:00 PM PT and the first bar of the new session, the newest 1m bar is still the OLD day's
        // (market closed 2-3 PM PT); dayKey !== currentDayKey used to roll currentDayKey BACK to yesterday (fills, day P&L and the day tracker's start balance).
        if (dayKey > currentDayKey) {
          // Lock in the trailing-drawdown floor using the day that just
          // ENDED's closing balance — lastAccountBalance right at this exact
          // instant IS that closing balance, since nothing's traded yet in
          // the new day. This is the ONE place eodPeakBalance is allowed to
          // move — never mid-day, matching Topstep's real EOD-based rule.
          if (LIVE && lastAccountBalance != null) eodPeakBalance = Math.max(eodPeakBalance ?? lastAccountBalance, lastAccountBalance);
          currentDayKey = dayKey; dayRealizedPnl = 0; dayRealizedPnlAccountWide = 0; dayPeakPnlAccountWide = 0; dayBlocked = false; dayPnlAllFills = 0;
          levelCrossState = {};
          biasHistory = []; // intraday bias timeline is per trading day
          log(`New trading day (5pm CT rollover): ${new Date(dayKey).toISOString().slice(0, 10)}`);
        }

        // Level-cross alerts — no TradingView API call involved (there isn't
        // one for creating alerts programmatically); this just watches the
        // SAME levels array the strategy itself trades off (lib/levelsPro.js's
        // `.levels`, recomputed fresh every 15m bar close) and fires on every
        // true CROSS (a side flip vs. the level's current price), not merely a
        // touch, and not capped at once per level per day — you want to know
        // about every crossing of an established level, since that's the
        // meaningful event; everything in between is "just action."
        //
        // Asia High/Low and London High/Low are skipped WHILE their own
        // session is still active: those two are still being extended bar by
        // bar during that window (every fresh high/low would otherwise read
        // as a spurious "cross" of itself). The instant that session ends
        // they're fixed for the rest of the day and get the exact same
        // repeat-cross alerting as PDH/PDL/PWH/PWL/opens/VWAP, which are
        // already fixed as soon as their day/week/period starts.
        //
        // Every level EXCEPT VWAP is meant to hold a fixed price between
        // rolls (daily levels roll once/day, 4H/1H/30m/15m Open roll on
        // their own period boundary). When one of those rolls, its price
        // jumps to a brand new number — comparing the new price's side
        // against a side recorded against the OLD price looks exactly like a
        // spurious cross. So for everything but VWAP, a change in the
        // level's own price silently re-anchors (no alert) instead of being
        // compared as a cross. VWAP is genuinely continuous — it's expected
        // to move every bar — so it always uses a plain side comparison.
        if (lastLv && lastLv.levels) {
          const pt = ptInfo(liveBar.t);
          for (const lvl of lastLv.levels) {
            const stillForming = ((lvl.name === 'Asia High' || lvl.name === 'Asia Low') && pt.isAsia)
              || ((lvl.name === 'London High' || lvl.name === 'London Low') && pt.isLondon);
            if (stillForming) continue;
            const side = liveBar.c > lvl.price ? 1 : -1;
            const st = levelCrossState[lvl.name] || { lastSide: null, lastPrice: null, lastAlertTime: 0 };
            const rolled = lvl.name !== 'VWAP' && st.lastPrice != null && st.lastPrice !== lvl.price;
            if (rolled) {
              st.lastSide = null; // re-anchor to the new price, don't treat the jump itself as a cross
            } else if (st.lastSide != null && st.lastSide !== side) {
              const dirStr = side === 1 ? 'crossed ABOVE' : 'crossed BELOW';
              // 18f1 F2 (NOTIFICATION ONLY): CONFIG.levelCrossPush decides whether this cross goes to the phone ('off' = this log line only); levelCrossState is read by nothing else.
              const lc = NP.levelCrossDecision({ mode: CONFIG.levelCrossPush, name: lvl.name, lastAlertTime: st.lastAlertTime, now: Date.now(), cooldownMs: CONFIG.levelCrossCooldownMs, keyCooldownMs: CONFIG.levelCrossKeyCooldownMs });
              log(`\u0007🔔 LEVEL CROSS: price ${dirStr} ${lvl.name} @ ${lvl.price.toFixed(2)}  (control=${lvl.control}, behavior=${lvl.behavior})${lc.note}`);
              if (lc.push) {
                notifyPhone(`Crossed ${lvl.name}`, `Price ${dirStr.toLowerCase()} ${lvl.name} @ ${lvl.price.toFixed(2)} (${lvl.control}, ${lvl.behavior})`, { tags: side === 1 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend' });
                st.lastAlertTime = Date.now();
              }
            }
            st.lastSide = side;
            st.lastPrice = lvl.price;
            levelCrossState[lvl.name] = st;
          }
        }

        if (LIVE) {
          try { dayRealizedPnl = await refreshRealDayPnl(currentDayKey); }
          catch (e) { log('  [live] Trade/search failed (non-fatal, keeping last known day P&L): ' + e.message); }
          try { dayRealizedPnlAccountWide = await refreshRealDayPnl(currentDayKey, { accountWide: true }); }
          catch (e) { log('  [live] account-wide Trade/search failed (non-fatal, keeping last known day P&L): ' + e.message); }
          try { recentTrades = await refreshRecentTrades(currentDayKey); dayPnlAllFills = sumClosedRoundTripNetAllCosts(lastBrokerRoundTrips); dayFillsKnownFor = currentDayKey; }
          catch (e) { log('  [live] recent-trades refresh failed (non-fatal, keeping last known list): ' + e.message); }
          if (journalReconcileQueue.length) {
            try { reconcileJournalWithBroker(lastBrokerRoundTrips, 'live'); }
            catch (e) { log('  [journal-reconcile] failed (non-fatal): ' + e.message); }
          }
          try {
            const bal = await refreshAccountBalance();
            if (bal != null) lastAccountBalance = bal; // intraday/live only — never feeds the EOD-based floor
          } catch (e) { log('  [live] account balance refresh failed (non-fatal, keeping last known): ' + e.message); }
          // dashfix: cross-check the old fill-sum figure against the balance-based day result (display only). Warn when they differ by more than $5.
          try {
            if (dayFillsKnownFor === currentDayKey && dayTracker.state.dayKey === currentDayKey) {
              const cc = dayTracker.crossCheck(dayPnlAllFills, lastAccountBalance);
              if (cc && dayTracker.shouldWarn(Date.now(), cc)) log(`  [day-tracker] WARNING: realized today by account balance $${cc.byBalance.toFixed(2)} vs by broker fills $${cc.fillSum.toFixed(2)} differ by $${cc.diff.toFixed(2)} (> $5). The dashboard headline uses the balance figure (ties to TopstepX).`);
            }
          } catch (e) { /* display only */ }
          // dashfix: a payout / reset / correction moves the balance while no fill moves: re-base the start balance (display only)
          try {
            const rb = dayTracker.observe(Date.now(), { balance: lastAccountBalance, fillSum: dayPnlAllFills, flat: !!stateMachine && stateMachine.phase === 'FLAT' && dayFillsKnownFor === currentDayKey && dayTracker.state.dayKey === currentDayKey });
            if (rb) log(`  [day-tracker] non-trading balance change of $${rb.delta.toFixed(2)} (no fills): start-of-day balance re-based, Rolling P&L and Day peak keep showing the trading result only.`);
          } catch (e) { /* display only */ }
        }
        // Account-wide (both symbols combined) as of 2026-09-22 — was
        // per-symbol dayRealizedPnl <= -$1,000; see refreshRealDayPnl().
        if (dayRealizedPnlAccountWide > dayPeakPnlAccountWide) dayPeakPnlAccountWide = dayRealizedPnlAccountWide;
        // Trailing profit floor (2026-10-07, validated via the 5-year
        // backtest's dailyTrailingSim.js — see CONFIG.dailyStopLoss's own
        // comment above and computeDailyFloor() for the shared calc). Flat
        // at -dailyStopLoss until the day's peak reaches trailArmThreshold,
        // then RISES to (peak - trailGiveback) so banked profit above the
        // arm point can't be given back down to the flat stop.
        // trailArmThreshold/trailGiveback == null (either one) falls back to
        // the exact old flat-stop behavior; dailyStopLoss == null still
        // disables the whole breaker, same as before this existed.
        const dailyFloor = computeDailyFloor();
        if (!dayBlocked && dailyFloor != null && dayRealizedPnlAccountWide <= dailyFloor) {
          dayBlocked = true;
          log(`DAILY FLOOR HIT (account-wide $${dayRealizedPnlAccountWide.toFixed(2)} <= floor $${dailyFloor.toFixed(2)}, peak was $${dayPeakPnlAccountWide.toFixed(2)}) — flattening and blocking new entries for the rest of this trading day.`);
          notifyPhone('Daily floor hit', `Account-wide $${dayRealizedPnlAccountWide.toFixed(2)} <= floor $${dailyFloor.toFixed(2)} (peak $${dayPeakPnlAccountWide.toFixed(2)}) — flattening, no new entries for the rest of the trading day.`, { priority: 'high', tags: 'octagonal_sign' });
          // The backtest this floor is validated against force-closes any
          // still-open position the instant the floor is crossed (it can't
          // just block NEW trades — a rule that only blocks new entries
          // can't stop the loss on a trade already open when the threshold
          // is crossed, which is exactly the gap that made a flat daily-stop
          // unable to actually cap the real worst day). Flattening here is
          // what makes this breach match the backtested numbers instead of
          // riding whatever's still open past the floor.
          if (LIVE) {
            try { require('./lib/journalReceipts').attemptClose(stateMachine, 'daily_floor', 'AUTOMATIC', 'daily floor branch'); } catch (_) { /* receipt only */ }
            if (tideOwned()) { log('  [tide-live] daily floor: the TIDE position is NOT closed (Mac: no daily loss limit for TIDE); its own stop protects it.'); journalManage('TIDE_FLOOR_SKIP', 'Daily floor hit: the TIDE position is not closed (no daily loss limit for TIDE).', {}); }   // [2a]
            try { await stateMachine.flattenNow(); }
            catch (e) { log('  [live] flatten-on-daily-floor failed (non-fatal — check the exchange/terminal directly): ' + e.message); }
          } else if (position || pending) {
            if (position) journalPositionClosed(lastKnownClose, position.realizedPnlSoFar);
            else if (pending) journalOrderCanceled('daily floor hit (paper)');
            position = null; pending = null;
          }
        }

        if (LIVE) {
          try { freshStopTrack(m1); } catch (e) { /* never blocks */ }   // 10-18b2a
          const phaseBeforeTick = stateMachine.phase;
          lastPendingM1 = m1;
          if (stateMachine.phase === 'PENDING_ENTRY') { try { stateMachine.notePendingBars(m1); } catch (e) { log('  [pending] stop-touch check failed (non-fatal): ' + e.message); } }   // 10/16 stop-touch
          await stateMachine.tick();
          await stopCapAfterTick();   // lv1 r13.6.2: before everything that reads the stop this poll (no-progress, smart hold, the ladder audit)
          stateMachine.trackPeakUnrealized(liveBar.c);
          try { stateMachine.noteNoProgressPrices(m1, liveBar.c, Date.now()); } catch (e) { /* tracking only */ }   // np1
          try { reversalExitStep(m1, Date.now()); } catch (e) { /* lv1 r13.3.3: shadow log only, never blocks the poll */ }   // before np1's step: the np1-check close is labelled too
          try { await stateMachine.noProgressStep(CONFIG.noProgressExit, Date.now()); } catch (e) { log('  [no-progress] step failed (non-fatal, retried next poll): ' + e.message); }   // np1 (off = records 'disabled' only)
          const pxOk = typeof stateMachine.priceEvidenceOk === 'function' && stateMachine.priceEvidenceOk(liveBar.t, Date.now());   // np1 r1.5/r1.6: the CURRENT 1m bar, started after the position existed
          if (stateMachine.phase === 'LEG1_OPEN' && pxOk) await stateMachine.maybeSmartHoldExit(liveBar.c, lastLv);
          // PROFIT TRAIL: update the whole-position lock from this poll's price and, when it moved, repair the stops NOW (before the runner trail), so a lock set at the peak rests at the broker.
          if (CONFIG.profitTrail && CONFIG.profitTrail.enabled && (stateMachine.phase === 'LEG1_OPEN' || stateMachine.phase === 'LEG23_OPEN' || stateMachine.phase === 'LEG3_OPEN')) {
            try { if (stateMachine.updateProfitTrail(liveBar.c)) await stateMachine.auditStopLadder(liveBar.c); } catch (e) { log('  [profit-trail] failed (non-fatal): ' + e.message); }
          }
          // Runner trail split (2026-10-08): leg3 now trails from the
          // MOMENT leg1 closes, concurrently with leg2 still working toward
          // TP2 — phase stays 'LEG23_OPEN' the whole time now (it no longer
          // transitions to 'LEG3_OPEN' once leg2 closes, tracked instead via
          // leg3StopOrderId/stopOrderId going null). maybeRatchetTrail()
          // itself already branches on which order field to ratchet for
          // either phase; this just has to actually call it in both.
          if ((stateMachine.phase === 'LEG23_OPEN' || stateMachine.phase === 'LEG3_OPEN') && pxOk) await stateMachine.maybeRatchetTrail(liveBar.c, lastLv);   // np1 r1.5: no ratchet on pre-position prices
          if (stateMachine.phase === 'LEG1_OPEN' || stateMachine.phase === 'LEG23_OPEN') await stateMachine.maybeProfitLock(liveBar.c);
          // HOTFIX 4b: retry-cancel any old stop of ours that could not be cancelled earlier, every poll, until the broker confirms it is gone (also while flat). Non-fatal.
          try { await stateMachine.sweepStaleStops(); } catch (e) { log('  [risk] stale-stop sweep failed (non-fatal): ' + e.message); }
          // HOTFIX 4: stop-ladder audit - the broker's working stops must match what the state machine intends (never worse than break-even after TP1, right sizes);
          // a missing/worse stop is replaced (or the contracts exited at market if the market is already through it); never loosens. Non-fatal.
          if ((CONFIG.stopLadderAudit || (CONFIG.profitTrail && CONFIG.profitTrail.enabled)) && (stateMachine.phase === 'LEG1_OPEN' || stateMachine.phase === 'LEG23_OPEN' || stateMachine.phase === 'LEG3_OPEN')) {
            try { await stateMachine.auditStopLadder(liveBar.c); } catch (e) { log('  [risk] stop-ladder audit failed (non-fatal): ' + e.message); }
          }
          watchLiveLifecycle(phaseBeforeTick);
        } else if (position) {
          if (!position.leg1Closed && position.tightStopPrice != null && !position.smartHoldChecked) {
            const crossed = position.dir === 1 ? liveBar.c <= position.tightStopPrice : liveBar.c >= position.tightStopPrice;
            if (crossed) {
              position.smartHoldChecked = true;
              const structural = (lastLv?.levels || []).some(l => {
                const b = l.behavior || '';
                return position.dir === 1 ? (b === 'ACCEPT-' || b === 'LOST') : (b === 'ACCEPT+' || b === 'RECLAIM');
              });
              if (structural) {
                log(`  [PAPER] smart-stop-hold: confirmed break of structure @ ${liveBar.c.toFixed(2)} — exiting early instead of waiting for the wide stop.`);
                paperCloseRemaining(liveBar.c, 'smart-hold exit');
                notifyPhone('Smart-hold early exit', `[PAPER] Confirmed break of structure @ ${liveBar.c.toFixed(2)} — exited all ${position.contracts} contracts early.`, { priority: 'high', tags: 'chart_with_downwards_trend' });
                journalPositionClosed(liveBar.c, position.realizedPnlSoFar);
                position = null;
              } else {
                log(`  [PAPER] smart-stop-hold: price crossed the tight reference @ ${liveBar.c.toFixed(2)} but no confirmed break of structure — holding, wide stop stays active.`);
              }
            }
          }
          if (position && !position.leg1Closed) {
            const hitStop = position.dir === 1 ? liveBar.l <= position.stopPrice : liveBar.h >= position.stopPrice;
            const hitTarget1 = position.dir === 1 ? liveBar.h >= position.target1 : liveBar.l <= position.target1;
            if (hitStop) {
              noteStopOut(position.dir, 'trend stop-out (paper)');
              try { onLossClose({ dir: position.dir, entryPrice: position.entryPrice, plan: position.plan || null, filled: true }, { kind: 'stop', t: Date.now(), stop: position.stopPrice, target2: position.target2 }); } catch (e) { /* non-fatal */ }   // 10/18 RULES 5/6
              paperCloseRemaining(position.stopPrice, 'stop');
              journalPositionClosed(position.stopPrice, position.realizedPnlSoFar);
              position = null;
            } else if (hitTarget1) {
              const pl1 = position.leg1Size != null ? position.leg1Size : 1;   // 10/18 RULE 2: the trade's own split
              recordLeg(1, position.target1, 'target1', pl1);
              position.leg1Closed = true;
              if ((position.leg2Size != null ? position.leg2Size : 1) === 0) position.leg2Closed = true;
              if (position.contracts - pl1 - (position.leg2Size != null ? position.leg2Size : 1) <= 0) position.leg3Closed = true;
              if (position.leg2Closed && position.leg3Closed) { log('  Position fully closed at TP1 (no second leg / runner at this size).'); journalPositionClosed(position.target1, position.realizedPnlSoFar); position = null; }
              else {
              position.leg2Stop = position.entryPrice;
              position.trailStop = position.entryPrice;
              position.trailPeakPts = 0;
              if (scaleOutOn()) { const sr = CONFIG.scaleOutRunner; position.trailPeakPts = Math.abs(position.target1 - position.entryPrice); position.trailStop = roundTrailStopConservative(position.entryPrice + position.dir * runnerTrailOffset(position.trailPeakPts, { lockPts: sr.runnerLockPts, stepPts: sr.runnerStepPts }), position.dir, tickSize); }
              log(`  Leg1 closed. Leg2 target=${position.target2.toFixed(2)}, leg2/leg3 stop now breakeven=${position.entryPrice.toFixed(2)}.`);
              }
            }
          } else if (position) {
            if (!position.leg2Closed) {
              const hitStop2 = position.dir === 1 ? liveBar.l <= position.leg2Stop : liveBar.h >= position.leg2Stop;
              const hitTarget2 = position.dir === 1 ? liveBar.h >= position.target2 : liveBar.l <= position.target2;
              if (hitTarget2) { recordLeg(2, position.target2, 'target2', position.leg2Size != null ? position.leg2Size : 1); position.leg2Closed = true; }
              else if (hitStop2) { recordLeg(2, position.leg2Stop, 'breakeven stop', position.leg2Size != null ? position.leg2Size : 1); position.leg2Closed = true; }
            }
            if (position && !position.leg3Closed) {
              const hitStop3 = position.dir === 1 ? liveBar.l <= position.trailStop : liveBar.h >= position.trailStop;
              if (hitStop3) {
                recordLeg(3, position.trailStop, position.trailStop === position.entryPrice ? 'breakeven stop' : 'trailing stop', paperRunnerSize(position));
                position.leg3Closed = true;
              } else if (scaleOutOn()) {
                const sr = CONFIG.scaleOutRunner, excursionPts = position.dir === 1 ? liveBar.h - position.entryPrice : position.entryPrice - liveBar.l;
                position.trailPeakPts = Math.max(position.trailPeakPts || 0, excursionPts);
                const roundedStop = roundTrailStopConservative(position.entryPrice + position.dir * runnerTrailOffset(position.trailPeakPts, { lockPts: sr.runnerLockPts, stepPts: sr.runnerStepPts }), position.dir, tickSize);
                if (position.dir === 1 ? roundedStop > position.trailStop : roundedStop < position.trailStop) { log(`  Runner trail (so1): ${position.trailStop.toFixed(2)} -> ${roundedStop.toFixed(2)}`); position.trailStop = roundedStop; }
              } else if (CONFIG.trailStepPoints != null) {
                // Mac's runner trail, mechanical (2026-10-08, bundle spec) —
                // PAPER-mode mirror of lib/liveStateMachine.js's
                // maybeRatchetTrail / lib/simulate3leg.js's leg3 block.
                const leg3Size = paperRunnerSize(position);
                const excursionPts = position.dir === 1 ? liveBar.h - position.entryPrice : position.entryPrice - liveBar.l;
                position.trailPeakPts = Math.max(position.trailPeakPts || 0, excursionPts);
                const lockPoints = MECH_TRAIL_LOCK_DOLLARS / (pointValue * leg3Size);
                if (position.trailPeakPts >= lockPoints) {
                  const extra = position.trailPeakPts - lockPoints;
                  const offsetPoints = lockPoints + Math.floor(extra / CONFIG.trailStepPoints) * CONFIG.trailStepPoints;
                  const rawStop = position.dir === 1 ? position.entryPrice + offsetPoints : position.entryPrice - offsetPoints;
                  const roundedStop = roundTrailStopConservative(rawStop, position.dir, tickSize);
                  const better = position.dir === 1 ? roundedStop > position.trailStop : roundedStop < position.trailStop;
                  if (better) {
                    log(`  Leg3 trail ratcheted (mechanical): ${position.trailStop.toFixed(2)} -> ${roundedStop.toFixed(2)}`);
                    position.trailStop = roundedStop;
                  }
                }
              } else if (lastLv && lastLv.levels) {
                let best = position.trailStop;
                for (const lvl of lastLv.levels) {
                  if (position.dir === 1) { if (lvl.price > best && liveBar.c > lvl.price) best = lvl.price; }
                  else { if (lvl.price < best && liveBar.c < lvl.price) best = lvl.price; }
                }
                if (best !== position.trailStop) log(`  Leg3 trail ratcheted: ${position.trailStop.toFixed(2)} -> ${best.toFixed(2)}`);
                position.trailStop = best;
              }
            }
            if (position && position.leg2Closed && position.leg3Closed) {
              log('  Position fully closed.');
              journalPositionClosed(position.trailStop, position.realizedPnlSoFar);
              position = null;
            }
          }
        } else if (pending) {
          resolvePaperPending(liveBar);
        }
        writeSnapshotFile(); // keep the chart's entry/stop/target lines current between 15m bar closes
      }

      // ── 2. Cheap check: has a new 15m bar closed? ──
      const m15probe = await fetchBars(token, contractId, UNIT.MINUTE, 15, { limit: 3 });
      if (tideOn()) tideM15Tail = m15probe;   // TIDE r2: the forming 15m for its own bias read while the bot is not evaluating
      const probeClosedBar = m15probe.length >= 2 ? m15probe[m15probe.length - 2] : null;
      if (probeClosedBar && probeClosedBar.t > lastClosedBarTime) {
        const refreshed = await refreshAndEvaluate();
        lastClosedBarTime = refreshed.lastClosedBarTime;
        lastMac = refreshed.mac;
        lastLv = refreshed.lv;
        writeBiasSnapshot(lastMac, lastLv);
        log(`New 15m bar closed @ ${new Date(lastClosedBarTime).toISOString()}  mac.verdict=${lastMac.verdict}  lv.biasStr=${lastLv.biasStr}`);

        await tickTrendTimeoutBarClose();

        if (isFlat()) {
          await checkForNewEntry(lastMac, lastLv, probeClosedBar.t, probeClosedBar.c);
        }
      }

      // ── 10/18 RULE 6 reclaim re-entry (needs flat; its own gates) and the wave trigger (OFF) ──
      if (reclaimWatch) { try { await reclaimStep(m1); } catch (e) { log('  [reclaim] step failed (non-fatal): ' + e.message); } }
      if (CONFIG.waveMode === 'trigger') { try { await waveTriggerStep(); } catch (e) { log('  [wave] trigger step failed (non-fatal): ' + e.message); } }
      if (CONFIG.exhaustionReversal) { try { await reversalStep(); } catch (e) { log('  [reversal] step failed (non-fatal): ' + e.message); } }

      // ── 2b. Intrabar evaluation (2026-10-08, Mac's directive — opt-in,
      // OFF by default) ──
      // Runs entirely independently of the bar-close block above, on its
      // own CONFIG.evaluationIntrabarPollMs cadence. A no-op unless
      // evaluationMode is switched to 'intrabar-1m' — the cheap isFlat()/
      // time check below costs nothing when it's not. Deliberately does
      // NOT touch lastClosedBarTime, or
      // tickTrendTimeoutBarClose/writeBiasSnapshot — those are anchored to
      // REAL 15m closes on purpose (an "N bars held" count means actual
      // bars) and must keep meaning exactly what they always have, in both
      // modes. Only ever
      // reads market data (fetchAllTimeframes -> GET-equivalent
      // History/retrieveBars calls through the proxy) and, when a real
      // signal fires, places a normal entry order through the EXACT same
      // takeEntry()/checkForNewEntry() paths the
      // bar-close caller already uses — this never calls flattenNow() or
      // any other closing action.
      if (CONFIG.evaluationMode === 'intrabar-1m' && isFlat() && !dayBlocked
        && Date.now() - lastIntrabarEvalTime >= CONFIG.evaluationIntrabarPollMs) {
        lastIntrabarEvalTime = Date.now();
        // fast:true — see refreshAndEvaluate()'s own "API load" comment.
        // Only the fast timeframes get re-fetched; M30/H1/H4/D/W/M reuse
        // the cache from the most recent real bar close.
        const intrabarEval = await refreshAndEvaluate({ fast: true });
        // Fast-read preview (2026-10-09) — update the dashboard's "current"
        // card from THIS poll's data regardless of what happens below, so a
        // flat/no-signal poll still refreshes the display. Enriched with
        // botAction/blockReason the same way the real bar-close call site
        // does, for the same reason: so the card's "Bot: waiting on
        // structure"-style text is accurate against intrabar data too, not
        // just real closes. intrabarEval.mac is a fresh per-poll object, so
        // mutating it here never touches lastMac/lastLv.
        writeIntrabarPreview(intrabarEval.mac, intrabarEval.lv);
        // Re-check isFlat() after the await — nothing else in this file
        // await-yields between the check above and here, but the fetch
        // itself is a real network round-trip, and a bar-close evaluation
        // from THIS SAME poll iteration (block 2, just above) could in
        // principle have already taken an entry if the two blocks are ever
        // reordered later. Cheap insurance, matches the "never trust stale
        // state across an await" rule every other entry path in this file
        // already follows.
        if (isFlat()) {
          // lastMac/lastLv (used for display/notifications/the next
          // bar-close comparison) are intentionally NOT overwritten here —
          // they stay anchored to the last REAL close. Only the LOCAL
          // intrabarEval.mac/.lv feed checkForNewEntry(); if it fires, the
          // trade's own signalContext still captures the truthful
          // (possibly-partial) board state at the moment it entered.
          await checkForNewEntry(intrabarEval.mac, intrabarEval.lv, intrabarEval.evalBarTime, intrabarEval.evalBarClose, { isIntrabar: true });
        }
      } else if (CONFIG.evaluationMode === 'intrabar-1m' && !dayBlocked && farLimitPendingEligible()
        && Date.now() - lastIntrabarEvalTime >= CONFIG.evaluationIntrabarPollMs) {
        // ROUND 4 FAR-LIMIT SWITCH: while a Levels LIMIT/STOP entry rests, the intrabar evaluation keeps running (same cadence, same fast fetch) so a far
        // order can give way to MAC's market entry. Nothing else is entered from here.
        lastIntrabarEvalTime = Date.now();
        const ev = await refreshAndEvaluate({ fast: true });
        writeIntrabarPreview(ev.mac, ev.lv);
        try { await farLimitPendingCheck(ev.mac, ev.lv, ev.evalBarTime, ev.evalBarClose); } catch (e) { log('  [far-limit] check failed (non-fatal, the order keeps resting): ' + e.message); }
      }
      runFlagJob();   // 10/17 round 3 (QA R2-3): the display-only flag MAC run, AFTER every entry decision of this pass
    } catch (e) {
      log('ERROR in loop (continuing): ' + (e.stack || e.message));
      // 10/18: a pass that died on a broker-auth failure still refreshes the phone snapshot, so "BROKER AUTH FAILED" shows instead of a stale screen.
      if (token.failing) { try { writeSnapshotFile(); } catch (e2) { /* display only */ } }
    }
    if (tideOn() && !tideBusy) { tideBusy = true; const m1t = tideM1Tail; Promise.resolve().then(() => tidePollStep(m1t)).catch(() => {}).finally(() => { tideBusy = false; }); }   // TIDE r2: AFTER the pass, never awaited
    await sleepWithFastPoll(CONFIG.pollIntervalMs);
  }

  // ROUND 4 FAR-LIMIT SWITCH on a RESTING Levels order (see CONFIG.farLimitSwitch). Called on the intrabar cadence while a Levels LIMIT/STOP entry rests.
  // Returns null (nothing to do) | 'gated' (the MAC entry would be skipped: the order keeps resting) | the cancel result ('filled' = the fill won) | 'switched'.
  function farLimitPendingEligible() {
    const ctx = pendingJournalContext;
    if (!CONFIG.farLimitSwitch || !ctx || ctx.planPath !== 'levels-limit' || ctx.entryType === 'MARKET' || (ctx.entryType === 'STOP' && CONFIG.farLimitIncludeStops !== true)) return false;   // round 5: STOPs only with farLimitIncludeStops
    return LIVE ? (stateMachine.phase === 'PENDING_ENTRY' && !stateMachine.desynced) : !!pending;
  }
  async function farLimitPendingCheck(mac, lv, refTime, px) {
    if (!farLimitPendingEligible()) return null;
    const ctx = pendingJournalContext, nowTs = Date.now();
    const macSig = macSignalOnly(decideSignal, mac, lv, { ...CONFIG, onControlOpportunity: candidate => entryControlAllowed(candidate.dir, candidate.source, 'far-limit-replacement', 'replacement-selection', lv, refTime) }, true, nowTs);
    if (macSig && Array.isArray(CONFIG.macIntrabarOnlyGrades) && CONFIG.macIntrabarOnlyGrades.includes(macSig.grade)) { if (CONFIG.macSeenOnOrder) seenCandidate = { refT: refTime, dir: macSig.dir }; else noteMacSeen(refTime, macSig.dir); }   // round 5 (O4); 10-18b2a
    let atrF = null; try { atrF = farLimitAtrNow(); } catch (e) { atrF = null; }
    const fl = farLimitDecision(CONFIG, { planDir: ctx.dir, planEntry: ctx.entryPrice, px, atr: atrF, macSig: macSig && macSig.controlContested ? null : macSig });   // 10-18b2c: a contested MAC signal never cancels / replaces the resting order
    if (!fl.switch) return null;
    // the MAC entry must be allowed right now, or the resting order is kept (same gates checkForNewEntry/takeEntry apply)
    let gate = null;
    if (dayBlocked) gate = 'daily stop';
    else if (pausedUntil && nowTs < pausedUntil) gate = 'paused';
    else if (inNyOpenBlackout(nowTs, CONFIG.blockNyOpenMinutes) || inAsiaBlackout(nowTs, asiaBlockMinutes(CONFIG))) gate = 'blackout';
    else if (sessionCloseState(nowTs, CONFIG).noEntry) gate = 'session close';   // 10/17
    else { try { if (newsWaitBlock(nowTs)) gate = 'news wait'; } catch (e) { /* none */ } }
    if (!gate && cooldownBlock(ctx.dir)) gate = 'cooldown';
    if (!gate) { let gg = null; try { gg = gateNow(ctx.dir, px); } catch (e) { gg = null; } if (gg && !gg.ok) gate = gg.code === 'WAVE_WAIT' ? 'wave' : gg.code === 'TREND_FILTER' ? 'trend filter' : 'control filter'; }   // 10/18
    if (!gate && !noChaseExempt(CONFIG, 'mac', macSig.grade, 'MARKET')) { let nc = null; try { nc = noChaseBlock(ctx.dir, px); } catch (e) { nc = null; } if (nc) gate = 'no-chase'; }
    if (gate) { log(`  [far-limit] the resting ${ctx.dir === 1 ? 'LONG' : 'SHORT'} at ${ctx.entryPrice.toFixed(2)} is far (${fl.atrX} ATR) and MAC agrees, but MAC's entry is held back (${gate}): the order keeps resting.`); return 'gated'; }
    if (!entryControlAllowed(ctx.dir, 'mac', 'far-limit-replacement', 'far-limit-before-cancel')) return 'gated';
    if (!alignmentEntryAllowed('mac', alignmentContextFor('mac', lv), 'far-limit-before-cancel')) return 'gated';
    const info = { limit: ctx.entryPrice, entryType: ctx.entryType, px, pts: Math.round(fl.pts * 100) / 100, atrX: fl.atrX, atr: Math.round(atrF * 100) / 100, grade: macSig.grade, pending: true };
    if (LIVE) {
      const ph = stateMachine.phase;
      const r = await stateMachine.cancelPendingForFarLimit(info);
      watchLiveLifecycle(ph);
      if (r !== 'cancelled') { log(`  [far-limit] the cancel returned '${r}'${r === 'filled' ? ': the resting order filled first - the fill wins, managed normally' : ' - retrying on the next intrabar poll'}.`); return r; }
      // ROUND 5 (QA r4 N1): never a 2x position under broker lag. MAC's market order is sent only when the cancel was ACKNOWLEDGED and, after a pause, a fresh read of
      // BOTH the position and the open orders shows flat with nothing working. A position of any size = the limit filled: no MAC order; the fill is adopted and managed.
      if (!stateMachine.lastCancelAck) { log('  [far-limit] the cancel was refused and the order vanished - NOT sending MAC market this poll (it may have filled).'); return 'unsure'; }
      await sleep(1500);
      let p2 = null, o2 = null;
      try { p2 = await getOpenPosition(token, account.id, contractId); o2 = await getOpenOrders(token, account.id, contractId); } catch (e) { log('  [far-limit] position/orders re-read failed after the cancel (' + e.message + ') - NOT sending MAC market.'); return 'unsure'; }
      if (p2 && p2.size) {
        log(`  [far-limit] a ${p2.size}x position appeared after the cancel (the limit filled) - NOT sending MAC market; the filled position is adopted and managed.`);
        try { await reconcileIfUnknownPosition('FAR-LIMIT FILL'); } catch (e) { log('  [far-limit] adopting the fill now failed (' + e.message + '); the next poll\'s reconciliation adopts it.'); }
        return 'filled';
      }
      if (o2 && o2.length) { log(`  [far-limit] ${o2.length} working order(s) still listed after the cancel - NOT sending MAC market this poll.`); return 'unsure'; }
    } else {
      log(`  [PAPER] far-limit switch: the resting ${ctx.dir === 1 ? 'LONG' : 'SHORT'} at ${ctx.entryPrice.toFixed(2)} is cancelled.`);
      journalOrderCanceled(`far-limit switch: the order was ${info.pts} pts from price ${px.toFixed(2)}; taking MAC's market entry`);
      pending = null;
    }
    log(`  [far-limit] SWITCH: cancelled the resting ${ctx.dir === 1 ? 'LONG' : 'SHORT'} ${ctx.entryType} at ${ctx.entryPrice.toFixed(2)} (${info.pts} pts = ${fl.atrX} x ATR ${info.atr} from price ${px.toFixed(2)}); MAC fired grade ${macSig.grade} the same way: taking MAC's MARKET entry.`);
    journalBlock('FAR_LIMIT_SWITCH', ctx.dir, { source: 'levels', grade: ctx.grade, ...info });
    lastFarSwitch = { t: Date.now(), dir: ctx.dir, ...info };
    lastEntryAttemptAt = 0;   // the entry hold is about the cancelled order: the broker was just re-read flat and every order swept
    await checkForNewEntry(mac, lv, refTime, px, { isIntrabar: true, forceMacMarket: macSig, farInfo: info });
    return 'switched';
  }

  // Shared entry-decision logic (2026-10-08, extracted so intrabar
  // evaluation mode can reuse it byte-for-byte — see CONFIG.evaluationMode's
  // comment for the full design). Caller must already have confirmed
  // isFlat(); this never checks it itself. Takes mac/lv/refTime/refPrice as
  // explicit params instead of closing over lastMac/lastLv/probeClosedBar so
  // the IDENTICAL decision path runs whether it's called from a real 15m
  // bar close or an intrabar poll against the still-forming bar.
  //
  // This is also what makes "sticky entries" correct with no extra code:
  // once takeEntry()/openEntry() commits, isFlat() goes false and this
  // function is never called again (by either caller) until the position
  // is fully closed — so a signal that un-prints on a LATER check (whether
  // that's the next intrabar poll or the eventual real bar close) has
  // nothing left to undo. Only the resting stop/target/trail orders govern
  // the exit from here on, never the original signal condition. This is
  // live trading reality, not a special case: a human watching the same
  // chart wouldn't un-enter a filled order because the setup that triggered
  // it stopped looking as clean a minute later, either.
  //
  // Returns 'blocked' (dayBlocked/desynced/a blackout — already journaled),
  // 'no-signal' (every gate passed but decideSignal() found nothing —
  // already journaled as 'no qualifying signal'), or 'entered' (a real
  // trend signal fired; takeEntry() was attempted, successfully or not).
  async function checkForNewEntry(mac, lv, refTime, refPrice, { isIntrabar = false, forceMacMarket = null, farInfo = null } = {}) {
    const nowTs = Date.now();
    // Record source opportunities even when an independent session/risk guard returns early.
    const observedSignal = forceMacMarket ? { dir: forceMacMarket.dir, source: 'mac', grade: forceMacMarket.grade } : decideSignal(mac, lv, {
        ...CONFIG,
        requireVolSpike: isIntrabar && CONFIG.intrabarRequireVolSpike,
        blockMacSourceIntrabar: isIntrabar && CONFIG.intrabarRestrictToLevelsSource,
        onControlOpportunity: candidate => entryControlAllowed(candidate.dir, candidate.source, { kind: candidate.setup, plan: candidate.source === 'levels' ? lv.plan ?? null : { grade: mac.entryGrade, activeDir: mac.activeDir } }, 'main-before-selection', lv, refTime),
      }, nowTs);
    checklistEvalIntrabar = isIntrabar; checklistEvalAt = nowTs;
    // ROUND 5 (O4): remember a MAC A/B signal seen on this mid-bar evaluation BEFORE any guard (a guard-blocked signal still counts as seen in this bar)
    seenCandidate = null;   // 10-18b2a
    if (isIntrabar) { try { const ms0 = macSignalOnly(decideSignal, mac, lv, CONFIG, true, nowTs); if (ms0 && Array.isArray(CONFIG.macIntrabarOnlyGrades) && CONFIG.macIntrabarOnlyGrades.includes(ms0.grade)) { if (CONFIG.macSeenOnOrder) seenCandidate = { refT: refTime, dir: ms0.dir }; else noteMacSeen(refTime, ms0.dir); } } catch (e) { /* bookkeeping only */ } }   // FIX1015: the checklist rows journaled for this evaluation know whether it is a mid-bar poll
    if (dayBlocked) {
      // no new entries for the rest of the trading day
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'daily stop hit' });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('DAY_STOP', pk.dir, { source: pk.source, grade: pk.grade }); }
      return 'blocked';
    } else if (LIVE && stateMachine.desynced) {
      log('  [live] state machine is desynced — not looking for new signals. Restart after flattening manually.');
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'desynced' });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('DESYNCED', pk.dir, { source: pk.source, grade: pk.grade }); }
      return 'blocked';
    } else if (inMorningHold(nowTs)) {
      log(`  (morning hold ${morningHoldLabel()} PT, skipping signal check)`);
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: `morning hold ${morningHoldLabel()} PT` });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('MORNING_HOLD', pk.dir, { source: pk.source, grade: pk.grade, window: morningHoldLabel(), from: CONFIG.morningHold.from, to: CONFIG.morningHold.to, flattenLeadMin: CONFIG.morningHold.flattenLeadMin }); }   // window = the effective hold (MacShip 6280063367)
      return 'blocked';
    } else if (inNyOpenBlackout(nowTs, CONFIG.blockNyOpenMinutes)) {
      log('  (in NY-open blackout, skipping signal check)');
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'NY-open blackout' });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('NY_BLACKOUT', pk.dir, { source: pk.source, grade: pk.grade, minutes: CONFIG.blockNyOpenMinutes, window: '06:30-' + String(Math.floor((390 + CONFIG.blockNyOpenMinutes) / 60)).padStart(2, '0') + ':' + String((390 + CONFIG.blockNyOpenMinutes) % 60).padStart(2, '0') }); }
      return 'blocked';
    } else if (inAsiaBlackout(nowTs, asiaBlockMinutes(CONFIG))) {
      log('  (in Asia blackout, skipping signal check)');
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'Asia blackout' });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('ASIA_OPEN_BLOCK', pk.dir, { source: pk.source, grade: pk.grade, window: '15:00-' + String(Math.floor(CONFIG.asiaBlockUntilMinutes / 60)).padStart(2, '0') + ':' + String(CONFIG.asiaBlockUntilMinutes % 60).padStart(2, '0') }); }   // TIME BLOCKS r1: was ASIA_BLACKOUT
      return 'blocked';
    } else if (sessionCloseState(nowTs, CONFIG).noEntry) {
      // 10/17 SESSION CLOSE: no new entries from sessionNoEntryFromPt until the 15:00 PT reopen (Topstep: flat by 13:10 PT)
      const sc = sessionCloseState(nowTs, CONFIG);
      if (lastSessionLog !== sc.date) { lastSessionLog = sc.date; log(`  [session] ${sessionCloseText(sc)}: skipping the signal check until ${sc.reopenPt} PT.`); }
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: sessionCloseText(sc) });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('SESSION_CLOSE', pk.dir, { source: pk.source, grade: pk.grade, from: sc.noEntryPt, flat: sc.flattenPt, reopen: sc.reopenPt }); }
      return 'blocked';
    } else if (pausedUntil && nowTs < pausedUntil) {
      // 10/16 MANUAL PAUSE from the phone: no new entries until pausedUntil
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'paused by you until ' + tlHm(pausedUntil) });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('PAUSED', pk.dir, { source: pk.source, grade: pk.grade, until: tlHm(pausedUntil) }); }
      return 'blocked';
    } else if ((() => { try { return newsWaitBlock(nowTs); } catch (e) { return null; } })()) {
      // 10/16 TRADE THE REACTION: a high-impact release happened; no new entry until the first 15m bar after it has closed
      const nw = newsWaitBlock(nowTs), hmw = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT', title = String(nw.title).split(' / ')[0];
      if (lastNewsWaitLog !== nw.until) { lastNewsWaitLog = nw.until; log(`  [news] ${title} released ${hmw(nw.ms)}: no new entries until the ${hmw(nw.until)} 15m close (trade the reaction, not the release).`); }
      journalSignalSnapshot(mac, lv, 'sat_out', { reason: `news wait: ${title} released ${hmw(nw.ms)}, entries wait for the ${hmw(nw.until)} close` });
      { const pk = tlPeekSignal(mac, lv, isIntrabar); if (pk) journalBlock('NEWS_WAIT', pk.dir, { source: pk.source, grade: pk.grade, news: title, released: hmw(nw.ms), until: hmw(nw.until) }); }
      return 'blocked';
    } else {
      // ROUND 4: forceMacMarket = the far-limit switch from a cancelled resting Levels order (MAC's own signal; it goes straight to the mac-market path)
      let sig = observedSignal;
      if (forceMacMarket && CONFIG.levelsOnlyEntries) { try { journalBlock('LEVELS_ONLY', forceMacMarket.dir, { source: 'mac', grade: forceMacMarket.grade, reason: 'far-limit MAC market replacement not sent' }); } catch (e) { /* journal only */ } return 'blocked'; }   // lv1
      if (forceMacMarket && !entryControlAllowed(sig.dir, 'mac', 'far-limit-replacement', 'forced-replacement')) return;
      if (!sig) {
        journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'no qualifying signal' });
        if (CONFIG.levelsOnlyEntries) { try { const u0 = decideSignal(mac, lv, { ...CONFIG, levelsOnlyEntries: false, requireVolSpike: isIntrabar && CONFIG.intrabarRequireVolSpike, blockMacSourceIntrabar: isIntrabar && CONFIG.intrabarRestrictToLevelsSource }, nowTs);
          if (u0 && u0.source === 'mac') journalBlock('LEVELS_ONLY', u0.dir, { source: 'mac', grade: u0.grade, reason: 'MAC-only candidate' }); } catch (e) { /* journal only */ } }   // lv1: count what levels-only skips
        // lv1 r12.6: a level trigger the HTF-direction rule refused (it would exist with the rule and the control gates off) gets its own trade_block row
        if (CONFIG.levelsOnlyEntries && CONFIG.requireLevelsAlignment && CONFIG.levelsAlignWithTrade) { try { const u1 = decideSignal(mac, lv, { ...CONFIG, levelsAlignWithTrade: false, controlDirectionGate: false, standdownWeek1: false, requireVolSpike: isIntrabar && CONFIG.intrabarRequireVolSpike, blockMacSourceIntrabar: isIntrabar && CONFIG.intrabarRestrictToLevelsSource }, nowTs), ad = levelEvent.alignDir(lv, levelEvent.alignRequired(CONFIG));
          // r12.6.1 (MacDot 6464184681 #2): the HTF rule is a VIOLATED gate here, not necessarily the only one - alsoControl says whether the control gate alone
          // (HTF rule off, control as configured) would refuse it too
          if (u1 && u1.source === 'levels' && u1.dir !== ad) { const u2 = decideSignal(mac, lv, { ...CONFIG, levelsAlignWithTrade: false, requireVolSpike: isIntrabar && CONFIG.intrabarRequireVolSpike, blockMacSourceIntrabar: isIntrabar && CONFIG.intrabarRestrictToLevelsSource }, nowTs), alsoControl = !(u2 && u2.dir === u1.dir);
            journalBlock('HTF_ALIGN', u1.dir, { source: 'levels', level: u1.level || null, align: lv.alignText || lv.tfAlign || null, alignDir: ad, alsoControl, reason: `${ad === 1 ? 'HTF bullish' : ad === -1 ? 'HTF bearish' : 'HTF not aligned'}: a ${u1.dir === 1 ? 'LONG' : 'SHORT'} is against it${alsoControl ? ' (the 15m control gate refuses it too)' : ''}` }); } } catch (e) { /* journal only */ } }
        let ctrlLogged = false;
        if (!CONFIG.standdownWeek1 && CONFIG.controlDirectionGate) { try { const u = decideSignal(mac, lv, { ...CONFIG, controlDirectionGate: false, requireVolSpike: isIntrabar && CONFIG.intrabarRequireVolSpike, blockMacSourceIntrabar: isIntrabar && CONFIG.intrabarRestrictToLevelsSource }, nowTs);
          if (u) { const ctl = controlDisplaySnapshot(lv); journalBlock(!ctl.valid ? 'CONTROL_UNKNOWN' : 'CONTROL_GATE', u.dir, { source: u.source, grade: u.grade, bias: ctl.valid ? Math.round(ctl.score * 1000) / 1000 : null, threshold: CONFIG.controlGateMin, control: ctl.valid ? ctl.side : null, candidateBasis: candidateBasis(mac, lv, u, CONFIG), controlValid: ctl.valid }); } ctrlLogged = !!u; } catch (e) { /* journal only */ } }   // 10-18b1
        // TRADE LOG: a candidate that existed but a rule held back (conflict, grade/score filters, intrabar rules) gets a plain-English trade_block row
        if (!ctrlLogged) try {   // 10-18b1: a candidate the control gate held back already has its CONTROL_GATE row
          const cl = computeEntryChecklist(mac, lv, nowTs);
          const bad = cl.items.find(i => i.pass === false && ['noConflict', 'notMacGradeB', 'notGradeCAsia', 'biasAgreement'].includes(i.key));
          if (bad) journalBlock('GATE', cl.direction, { source: cl.source, grade: cl.grade, reason: bad.detail, reasonKey: bad.key });
          else if (cl.direction != null) {
            // r9.10 (journal text fix, Macaveli 6295864956 / Claude 6295793615): report the rule that ACTUALLY refused, from the same lv - the 15m
            // control gate first (Week 1 skips the CONTROL_GATE explainer above), and only then the intrabar MAC restriction when it really applies.
            const cc = (() => { try { return classifyControl(lv, cl.direction); } catch (e) { return null; } })();
            const macIntrabarBlocked = isIntrabar && CONFIG.intrabarRestrictToLevelsSource && cl.source === 'mac' && !CONFIG.macIntrabarAllGrades && !(Array.isArray(CONFIG.intrabarAllowMacGrades) && CONFIG.intrabarAllowMacGrades.includes(cl.grade));
            if (cc && !cc.ok) journalBlock('GATE', cl.direction, { source: cl.source, grade: cl.grade, reason: `15m control ${cc.reason === 'control-contested' ? 'contested' : cc.reason === 'control-opposite' ? 'on the other side' : 'unknown'} (score ${Number.isFinite(cc.score) ? cc.score.toFixed(3) : '?'}, line ${cc.threshold})`, reasonKey: cc.reason, controlScore: Number.isFinite(cc.score) ? Math.round(cc.score * 1000) / 1000 : null });
            else if (macIntrabarBlocked) journalBlock('GATE', cl.direction, { source: cl.source, grade: cl.grade, reason: `mac-sourced grade ${cl.grade || '?'} signals are not taken intrabar, only on the 15m close`, reasonKey: 'intrabar' });
            else if (isIntrabar) journalBlock('GATE', cl.direction, { source: cl.source, grade: cl.grade, reason: 'no admissible signal (cause not isolated by the checklist)', reasonKey: 'unattributed' });
          }
        } catch (e) { /* journal only */ }
        return 'no-signal';
      }
      if (!alignmentEntryAllowed(sig.source, alignmentContextFor(sig.source, lv), 'decision')) return 'blocked';
      // ROUND 4 MAC A/B INTRABAR ONLY: a MAC grade A/B signal on the 15m close is not entered (it trades intrabar only, as soon as it fires; one that a guard
      // blocked intrabar is not retried here either). Grade C keeps trading on the close.
      if (macIntrabarOnlyBlock(CONFIG, sig, isIntrabar) && !macSeenIntrabar(refTime, sig.dir)) {
        // ROUND 5 (owner answer O4): never seen mid-bar in this bar -> FIRST seen at the close -> traded at the close (no duplicate is possible)
        journalBlock('MAC_CLOSE_FIRST_SEEN', sig.dir, { source: sig.source, grade: sig.grade });
      } else if (macIntrabarOnlyBlock(CONFIG, sig, isIntrabar)) {
        journalBlock('MAC_INTRABAR_ONLY', sig.dir, { source: sig.source, grade: sig.grade, grades: CONFIG.macIntrabarOnlyGrades });
        journalSignalSnapshot(mac, lv, 'sat_out', { reason: `MAC grade ${sig.grade} trades intrabar only (not again at the 15m close)`, dir: sig.dir, source: sig.source, grade: sig.grade });
        return 'blocked';
      }
      // ROUND 4 FAR-LIMIT -> MAC MARKET (flat path: the Levels plan is ABOUT to be placed). Intrabar only: the plan's resting price is > farLimitAtr x 15m ATR
      // from price and MAC fired grade A/B in the same direction -> MAC's market entry instead (unless that entry would itself be a chase).
      let macMarketOnly = !!forceMacMarket, farSwitch = farInfo;
      // r9.5 (MacDot): a plan whose price is banned by a pending EXPIRY never switches to MAC market (the expired idea cannot come back through the far-limit door).
      const expiryBanned = (() => { try { if (!lv.plan || !levelBanBlock(sig.dir, lv.plan.entry, lv.inPlayLevel ? lv.inPlayLevel.name : null)) return false; const q = { dir: sig.dir, price: lv.plan.entry, levelName: lv.inPlayLevel ? lv.inPlayLevel.name : null, now: Date.now(), tolPts: CONFIG.sameLevelBanTolPts }; return levelBans.some(b => /^a pending expiry/.test(b.why || '') && banMatch(b, q)); } catch (e) { return false; } })();   // review r9.6 #5: any matching expiry ban, not just the first ban found
      if (!macMarketOnly && !expiryBanned && isIntrabar && CONFIG.farLimitSwitch && lv.plan && lv.plan.dir === sig.dir && (lv.plan.entryType === 'LIMIT' || (lv.plan.entryType === 'STOP' && CONFIG.farLimitIncludeStops === true))) {
        const macSig = macSignalOnly(decideSignal, mac, lv, CONFIG, true, nowTs);
        let atrF = null; try { atrF = farLimitAtrNow(); } catch (e) { atrF = null; }
        const fl = farLimitDecision(CONFIG, { planDir: sig.dir, planEntry: lv.plan.entry, px: refPrice, atr: atrF, macSig: macSig && macSig.controlContested ? null : macSig });   // 10-18b2c: a contested MAC signal never switches the Levels plan
        if (fl.switch) {
          let nc = null; try { nc = macSig && noChaseExempt(CONFIG, 'mac', macSig.grade, 'MARKET') ? null : noChaseBlock(sig.dir, refPrice); } catch (e) { nc = null; }
          if (nc) log(`  [far-limit] the ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${lv.plan.entryType} at ${lv.plan.entry.toFixed(2)} is far (${fl.atrX} ATR) and MAC agrees, but MAC's market entry would be a chase: keeping the Levels plan.`);
          else {
            farSwitch = { limit: lv.plan.entry, entryType: lv.plan.entryType, px: refPrice, pts: Math.round(fl.pts * 100) / 100, atrX: fl.atrX, atr: Math.round(atrF * 100) / 100, grade: macSig.grade, pending: false };
            log(`  [far-limit] SWITCH: the Levels ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${lv.plan.entryType} at ${lv.plan.entry.toFixed(2)} is ${farSwitch.pts} pts (${fl.atrX} x ATR ${farSwitch.atr}) from price ${refPrice.toFixed(2)} and MAC fired grade ${macSig.grade} the same way: taking MAC's MARKET entry instead (the limit is not placed).`);
            journalBlock('FAR_LIMIT_SWITCH', sig.dir, { source: 'levels', grade: sig.grade, ...farSwitch });
            lastFarSwitch = { t: Date.now(), dir: sig.dir, ...farSwitch };
            sig = { dir: sig.dir, source: 'mac', grade: macSig.grade };
            macMarketOnly = true;
          }
        }
      }
      // HOTFIX 1: same-direction re-entry cooldown.
      {
        const cd = cooldownBlock(sig.dir);
        if (cd) {
          journalBlock('COOLDOWN', sig.dir, { source: sig.source, grade: sig.grade, since: tlAgo(cd.t), until: tlHm(cd.until), ...(cd.win ? { win: true } : {}), ...(cd.winFloorMin ? { winFloorMin: cd.winFloorMin } : {}), ...(cd.tradeDir != null ? { tradeDir: cd.tradeDir } : {}) });
          journalSignalSnapshot(mac, lv, 'sat_out', { reason: `re-entry cooldown (${cd.kind}, until ${cd.winFloorMin ? `${cd.winFloorMin} min after the win` : `${cd.sameDirBlockMin ? cd.sameDirBlockMin + 'm' : cooldownTfLabel(CONFIG)} close`} ${new Date(cd.until).toISOString()})`, dir: sig.dir, source: sig.source, grade: sig.grade });
          return 'blocked';
        }
      }
      // ENTRY-FIX: same broker-position guard BEFORE the signal log / phone push (takeEntry() re-checks right before the order).
      if (LIVE) {
        const why = await entryGuard('trend signal');
        if (why) { journalBlock('ENTRY_GUARD', sig.dir, { source: sig.source, grade: sig.grade, reason: why }); journalSignalSnapshot(mac, lv, 'sat_out', { reason: `entry guard: ${why}`, dir: sig.dir, source: sig.source, grade: sig.grade }); return 'blocked'; }
      }
      // Captured once per signal, threaded into every takeEntry() call
      // below and journaled at the real fill — the whole point being "what
      // did the board actually look like when this fired," so a later
      // analysis can group trades by bias condition instead of just by
      // source/grade.
      const signalContext = {
        ...alignmentContextFor(sig.source, lv),
        levelProof: sig.levelProof || null,   // lv1 r3: the frozen named-event proof (lib/signal.js); takeEntry() refuses a levels-only entry without it
        // isIntrabar (2026-10-09, mobile dashboard visibility) — which path
        // actually caught this signal (the still-forming bar vs. a real 15m
        // close). Spread into the state machine's own 'entry' journal event
        // via its existing signalContext mechanism (liveStateMachine.js
        // openEntry()/this.journal({type:'entry', ...this.signalContext})) —
        // no new plumbing needed there, just a new field riding the
        // existing one. See enrichTradesWithJournal() for how this reaches
        // the dashboard's trade list.
        isIntrabar,
        macBiasStr: mac.biasStr, macVerdict: mac.verdict,
        macLongScore: mac.longScore, macShortScore: mac.shortScore,
        levelsBiasStr: lv.biasStr,
        // OWNER FORWARD-TEST 2026-10-11: which chart timeframe supplied the Levels trigger ('15m'|'5m'|'3m', null when none fired,
        // e.g. a mac-only entry), the per-timeframe trigger status, and the bias score / its agreement with the trade direction
        // (positive = Levels bias supports the trade). Informational only; no sizing uses them.
        triggerTf: lv.triggerTf ?? null,
        tfTriggers: lv.tfTriggers ? Object.fromEntries(Object.entries(lv.tfTriggers).map(([k, v]) => [k, v.skipped ? 'skipped' : v.dir === 0 ? null : `${v.dir === 1 ? 'LONG' : 'SHORT'}/${v.via}`])) : null,
        levelsBiasScore: typeof lv.biasScore === 'number' ? Math.round(lv.biasScore * 1000) / 1000 : null,
        biasAgreement: typeof lv.biasScore === 'number' ? Math.round(sig.dir * lv.biasScore * 1000) / 1000 : null,
        levelsPlan: lv.plan ? { dir: lv.plan.dir, targetName: lv.plan.targetName, grade: lv.plan.grade, rr: lv.plan.rr } : null,
        // levelContext (2026-09-24 fix, FIX 8): a levels-sourced entry's
        // actual TRIGGER is lv.inPlayLevel (e.g. "Asia Low breakdown"), not
        // lv.plan.targetName (that's the plan's downside TARGET — a real
        // 2026-09-24 trade record showed "PWH" here when the trade
        // actually fired off an Asia Low break, PWH just happened to be
        // the nearest level below entry). Scoped to sig.source === 'levels'
        // only — a mac-sourced entry has no real "trigger level" at all,
        // and attributing lv.inPlayLevel to it would be equally misleading
        // in the other direction. The mac-only pullback branch below
        // already overrides this with its OWN more specific level via
        // object spread — unaffected by this.
        levelContext: (sig.source === 'levels' && lv.inPlayLevel)
          ? { name: lv.inPlayLevel.name, behavior: lv.inPlayLevel.behavior, price: lv.inPlayLevel.price, ...(Number.isFinite(lv.inPlayLevel.tfMs) ? { tfMs: lv.inPlayLevel.tfMs, intrabar: lv.inPlayLevel.intrabar === true } : {}) } : null,   // lv1 r12.4: the event's timeframe / intrabar birth (journal only)
      };
      noChaseDiagnosticBoards.set(signalContext.alignmentSlots, { mac, lv }); // identity survives the pullback context spread; weak key retains no old evaluations
      // 10-18b2c TEAM DECISION 1: a CONTESTED candidate is sized at the MINIMUM: 1 contract (the smallest size the leg ladder supports: legSplit(1) = 1/0/0),
      // and only when sizeForStop() - the $ risk cap on this branch's structural / capped stop - allows at least 1. 0 stays the RISK_CAP_SKIP. Off = b2a sizing.
      const ctlMinSize = !!(CONFIG.controlDirectionGate && CONFIG.controlContestedMinSize && sig.controlContested);
      const sizeB2c = n => (ctlMinSize && n > 0 ? Math.min(n, 1) : n);
      if (ctlMinSize) { const csc = Number.isFinite(lv.controlBiasScore) ? lv.controlBiasScore : lv.biasScore; signalContext.controlContested = { score: Number.isFinite(csc) ? Math.round(csc * 1000) / 1000 : null, min: CONFIG.controlGateMin, size: 'minimum (1 contract)' };
        log(`  [control] CONTESTED (15m control score ${signalContext.controlContested.score}, line +/-${CONFIG.controlGateMin}): this ${sig.dir === 1 ? 'LONG' : 'SHORT'} is sized at the minimum, 1 contract (if it fits the risk cap).`); }
      // contracts/leg1Size/target1Points are computed PER BRANCH below
      // (2026-10-07), after that branch's own stop distance is known —
      // sizeForStop() needs the real stop distance to size the trade when
      // riskBudgetedSizing is on; off, it just calls contractsForSignal()
      // same as always, so this reorder changes nothing when the flag is
      // off. See CONFIG.riskBudgetedSizing.
      //
      // Separate from target1Points on purpose (2026-09-23 fix) — see
      // stopCapDollarsPerContract's comment in CONFIG. capStop() below
      // uses THIS, never target1Points, so a bigger trade's smaller
      // target1Points can't tighten its stop cap.
      const stopCapPoints = CONFIG.stopCapDollarsPerContract / pointValue;
      const signalMinutesOfDay = ptInfo(refTime).minutesOfDay;
      const inNySession = signalMinutesOfDay >= 6 * 60 + 30 && signalMinutesOfDay < 13 * 60;
      const effectiveStopMultiple = inNySession ? CONFIG.nyStopMultiple : CONFIG.leg1StopCapMultiple;
      // Off-peak (Asia + London) target override — see CONFIG.offPeakTarget1DollarGoal's comment.
      const effectiveTarget1DollarGoal = (!inNySession && CONFIG.offPeakTarget1DollarGoal != null) ? CONFIG.offPeakTarget1DollarGoal : CONFIG.target1DollarGoal;
      const effectiveTarget2Multiple = (!inNySession && CONFIG.offPeakTarget2Multiple != null) ? CONFIG.offPeakTarget2Multiple : CONFIG.target2Multiple;
      const offPeakTag = (!inNySession && CONFIG.offPeakTarget1DollarGoal != null) ? ` [off-peak $${CONFIG.offPeakTarget1DollarGoal}/${CONFIG.offPeakTarget2Multiple}x target]` : '';
      // Asia structural TP2 (2026-10-08, bundle spec) — see
      // lib/simulate3leg.js's computeTarget2 comment. Built once per
      // signal, passed into every computeTarget2() call below.
      const asiaStruct = (CONFIG.asiaStructuralTarget2 && ptInfo(refTime).isAsia)
        ? { levels: lv.levels, minPts: CONFIG.asiaTarget2MinPoints, maxPts: CONFIG.asiaTarget2MaxPoints, fallbackPts: CONFIG.asiaTarget2FallbackPoints }
        : null;
      const planMatches = !macMarketOnly && lv.plan && lv.plan.dir === sig.dir;
      sig.confidence = initialQuantity.provenance(planMatches ? 'levels' : sig.source, planMatches ? lv.plan.grade : sig.grade);
      signalContext.confidence = sig.confidence;   // round 4: a far-limit switch goes to the mac-market path
      // TRADE LOG (journal only): the facts the trade_plan row needs from this call site. Never read by an order.
      const tlPi = (path, entryWhy, stopBasis, stopEntryRef, target1Points, structTarget) => ({ path, entryWhy, stopBasis, stopEntryRef, target1Points, t2BasisPoints: tp2BasisPoints(effectiveTarget1DollarGoal), structTarget, t2Multiple: effectiveTarget2Multiple, asiaStruct,
        goalUsd: effectiveTarget1DollarGoal, offPeak: !inNySession && CONFIG.offPeakTarget1DollarGoal != null, mac, lv, sig, refPrice, stopCapAttemptId: scAttemptId });   // stop-cap shadow v2.1: exact join id (null unless THIS evaluation stamped one)
      const tlAtrStop = (entryRef, stopRaw, atrRef, risk) => { const capMax = stopCapPoints * effectiveStopMultiple; return { kind: 'atr', rawStop: stopRaw, atrRef, risk, capMaxPts: capMax, capApplied: Math.abs(entryRef - stopRaw) > capMax + 1e-9,
        multipleLabel: inNySession ? `NY session ${CONFIG.nyStopMultiple}x of ${tlP(stopCapPoints)} pts (stopCapDollarsPerContract ${tlUsd(CONFIG.stopCapDollarsPerContract)} / ${tlUsd(pointValue)} per point)` : `${CONFIG.leg1StopCapMultiple}x of ${tlP(stopCapPoints)} pts (stopCapDollarsPerContract ${tlUsd(CONFIG.stopCapDollarsPerContract)} / ${tlUsd(pointValue)} per point)` }; };
      const tlLvName = lv.inPlayLevel ? ` at ${lv.inPlayLevel.name} (${lv.inPlayLevel.behavior})` : '';
      // STOP-CAP SHADOW v2 (journal only; Mac 10/20 07:28 PT "build it and discuss with the team"; issue 1 #6293261922 / #6293474364 / #6293447520). When the stop cap
      // binds (|entry - raw 0.5-ATR stop| > |entry - capped stop|), stamp ONE 'stop_cap_shadow' row (kind 'attempt') with an attemptId that the following trade_plan row
      // carries (stopCapAttemptId), so MacLedger joins it to the real outcome; a shadow with no matching trade_plan means no OBSERVED plan receipt (gate refusal in takeEntry, or a plan-row error), not proof the order never went; placement is confirmed only by the fill/order rows. Geometries are kept apart:
      // 'capped' (live: tight + resting stop, live size), 'natural05Atr' (the uncapped 0.5-ATR stop, sized by the SAME live chain: applySmartHold -> quantityForStop -> sizeB2c),
      // 'naturalEqualRisk' (same $ as the live trade), 'sweepExtreme' (null: these mac-only paths have no sweep anchor - never inferred). Each carries legs and TP1 points.
      // NEVER read by an order: no stop, size, target, gate or state changes. quantityForStop() is pure (sizeForStop() is the journaling variant and is not used).
      const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
      let scAttemptId = null;   // set only by stopCapShadow() below, in this same synchronous evaluation, then read by tlPi() at the takeEntry call that follows
      const stopCapShadow = (path, entryRef, stopRaw, tightStop, liveStop, liveContracts) => {
        try {
          const natPts = Math.abs(entryRef - stopRaw), tightPts = Math.abs(entryRef - tightStop);
          if (!(natPts > tightPts + 1e-9) || !(liveContracts > 0)) return null;   // the cap did not bind (or nothing was sized): nothing to compare
          const slip = CONFIG.riskSizingSlipPts > 0 ? CONFIG.riskSizingSlipPts : 0;
          const geo = (stop, n) => { const pts = Math.abs(entryRef - stop), sp = n > 0 ? legSplit(n, CONFIG) : { leg1: 0, leg2: 0, runner: 0 }, l1 = n > 0 ? leg1SizeForContracts(n) : 0;
            return { stop: r2(stop), pts: r2(pts), contracts: n, legs: { leg1: sp.leg1, leg2: sp.leg2, runner: sp.runner }, tp1Pts: n > 0 ? r2(tp1PointsFor(effectiveTarget1DollarGoal, l1)) : null,
              stopRiskUsd: r2(n * pts * pointValue), sizingRiskUsd: r2(n * (pts + slip) * pointValue) }; };
          const natRest = applySmartHold(entryRef, stopRaw, sig.dir).stopPrice, natPtsRest = Math.abs(entryRef - natRest);
          const natQ = quantityForStop(natPtsRest, sig), natN = sizeB2c(natQ && natQ.contracts ? natQ.contracts : 0);
          const liveRiskUsd = liveContracts * Math.abs(entryRef - liveStop) * pointValue, eqN = Math.max(0, Math.floor(liveRiskUsd / (natPtsRest * pointValue) + 1e-9));
          const attemptId = crypto.randomUUID();
          appendJournal({ type: 'stop_cap_shadow', kind: 'attempt', t: Date.now(), attemptId, path, dir: sig.dir, source: sig.source, grade: sig.grade, inNy: inNySession, entry: r2(entryRef),
            atrRef: lv.atrRef || mac.atrVal || null, capMaxPts: r2(stopCapPoints * effectiveStopMultiple), budgetUsd: CONFIG.maxRiskPerTradeUsd, slipPts: slip,
            capped: { ...geo(liveStop, liveContracts), tightStop: r2(tightStop), tightPts: r2(tightPts) },
            natural05Atr: { ...geo(natRest, natN), rawStop: r2(stopRaw), sizingReason: natQ ? natQ.reason || null : null },
            naturalEqualRisk: geo(natRest, eqN), sweepExtreme: null,
            controlContested: !!(signalContext && signalContext.controlContested),
            level: lv.inPlayLevel ? { name: lv.inPlayLevel.name, behavior: lv.inPlayLevel.behavior } : null,
            riskBasis: 'planned at attempt time (signal price, before any fill); post-fill and realized figures come from the joined trade_plan / fill / close rows',
            note: 'shadow attempt only; join stopCapAttemptId on trade_plan for the real outcome; an attempt with no trade_plan = no observed plan receipt (not proof the order never went; placement = fill/order rows); legs/TP1 per geometry; R/$ outcomes are scored by MacLedger, never here' });
          scAttemptId = attemptId;
          return attemptId;
        } catch (e) { return null; }   // journal only
      };
      if (planMatches) {
        const { entryType, entry: entryPriceP, stop: stopPriceRaw, target: structTarget } = lv.plan;
        if (entryType === 'MARKET') {
          if ((sig.dir === 1 && stopPriceRaw >= refPrice) || (sig.dir === -1 && stopPriceRaw <= refPrice)) {
            log(`  Signal ${sig.source}/${sig.dir} rejected: structural stop already on the wrong side of current price.`);
            journalSignalSnapshot(mac, lv, 'sat_out', { reason: 'structural stop on wrong side of price', dir: sig.dir, source: sig.source, grade: sig.grade });
          } else {
            // Trusted outright (2026-09-23 spec) — this is a REAL Levels
            // PRO structural stop (an actual break-of-structure level), not
            // a synthetic ATR guess, so it no longer gets truncated to a
            // TP1-derived multiple. capStop() stays in use below for the
            // mac-only paths, which have no real level to trust and still
            // need that sanity cap.
            const { stopPrice, tightStopPrice, stopFloor: sfGeo } = floorEntryStop(sig.dir, refPrice, applySmartHold(refPrice, stopPriceRaw, sig.dir), 'MARKET', { rawStop: stopPriceRaw });   // entry stop floor BEFORE sizing
            signalContext.stopFloor = sfGeo;
            const contracts = sizeB2c(sizeForStop(Math.abs(refPrice - stopPrice), sig));   // 10/18 RULE 1: sized on the stop that rests at the broker
            if (!contracts) return riskCapSkip(mac, lv, sig, Math.abs(refPrice - stopPrice), { entryType: 'MARKET', entry: refPrice, stop: stopPrice, path: 'levels-market' });
            noteSizing(sig.dir, contracts, Math.abs(refPrice - stopPrice), { source: sig.source, grade: sig.grade, entryType: 'MARKET', path: 'levels-market' });
            const leg1Size = leg1SizeForContracts(contracts);
            const target1Points = tp1PointsFor(effectiveTarget1DollarGoal, leg1Size);   // 10/18 RULE 2
            const target1 = sig.dir === 1 ? refPrice + target1Points : refPrice - target1Points;
            const target2 = computeTarget2(sig.dir, refPrice, target1, tp2BasisPoints(effectiveTarget1DollarGoal), structTarget, effectiveTarget2Multiple, asiaStruct);
            // No [NY Xx stop] label here (2026-09-23) — that multiple only
            // ever applied through capStop(), which this structural-stop
            // branch no longer calls at all.
            log(`SIGNAL: ${sig.dir === 1 ? 'LONG' : 'SHORT'} MARKET (${sig.source}, grade ${sig.grade}, ${contracts}x)${offPeakTag}  entry~${refPrice.toFixed(2)}  stop=${stopPrice.toFixed(2)}${tightStopPrice != null ? ` (tight ref ${tightStopPrice.toFixed(2)})` : ''}  target1=${target1.toFixed(2)}  target2=${target2.toFixed(2)}`);
            signalPushArm(`Signal: ${sig.dir === 1 ? 'LONG' : 'SHORT'} (${CONFIG.levelsOnlyEntries ? '' : `grade ${sig.grade}, `}${contracts}x)`, `${sig.source} MARKET entry~${refPrice.toFixed(2)}  stop=${stopPrice.toFixed(2)}  t1=${target1.toFixed(2)}  t2=${target2.toFixed(2)}`, { tags: 'moneybag' });
            await takeEntry(sig.dir, 'MARKET', refPrice, stopPrice, target1, target2, sig.source, sig.grade, tightStopPrice, contracts, signalContext,
              tlPi('levels-market', `Levels PRO has a ${CONFIG.levelsOnlyEntries ? '' : `grade-${lv.plan.grade} `}${sig.dir === 1 ? 'LONG' : 'SHORT'} plan whose entry type is MARKET${tlLvName}, and its trigger fired ${signalContext.isIntrabar ? 'intrabar' : 'on this 15m bar close'}${!CONFIG.levelsOnlyEntries && (sig.source !== 'levels' || mac.activeDir === sig.dir) ? ' with MAC Trap agreeing' : ''}; the bot enters at market ~${tlP(refPrice)}.`, { kind: 'structure', rawStop: stopPriceRaw }, refPrice, target1Points, structTarget));
          }
        } else {
          // Same as the MARKET branch above — a real structural stop,
          // trusted outright, no capStop() truncation.
          const { stopPrice, tightStopPrice, stopFloor: sfGeo } = floorEntryStop(sig.dir, entryPriceP, applySmartHold(entryPriceP, stopPriceRaw, sig.dir), entryType, { rawStop: stopPriceRaw });   // entry stop floor BEFORE sizing
          signalContext.stopFloor = sfGeo;
          const contracts = sizeB2c(sizeForStop(Math.abs(entryPriceP - stopPrice), sig));   // 10/18 RULE 1
          if (!contracts) return riskCapSkip(mac, lv, sig, Math.abs(entryPriceP - stopPrice), { entryType, entry: entryPriceP, stop: stopPrice, path: 'levels-limit' });
          noteSizing(sig.dir, contracts, Math.abs(entryPriceP - stopPrice), { source: sig.source, grade: sig.grade, entryType, path: 'levels-limit' });
          const leg1Size = leg1SizeForContracts(contracts);
          const target1Points = tp1PointsFor(effectiveTarget1DollarGoal, leg1Size);   // 10/18 RULE 2
          const target1 = sig.dir === 1 ? entryPriceP + target1Points : entryPriceP - target1Points;
          const target2 = computeTarget2(sig.dir, entryPriceP, target1, tp2BasisPoints(effectiveTarget1DollarGoal), structTarget, effectiveTarget2Multiple, asiaStruct);
          log(`SIGNAL: ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${entryType} (${sig.source}, grade ${sig.grade}, ${contracts}x)${offPeakTag}  pending entry=${entryPriceP.toFixed(2)}  stop=${stopPrice.toFixed(2)}${tightStopPrice != null ? ` (tight ref ${tightStopPrice.toFixed(2)})` : ''}  target1=${target1.toFixed(2)}  target2=${target2.toFixed(2)}`);
          signalPushArm(`Signal: ${sig.dir === 1 ? 'LONG' : 'SHORT'} (${CONFIG.levelsOnlyEntries ? '' : `grade ${sig.grade}, `}${contracts}x)`, `${sig.source} ${entryType} pending @ ${entryPriceP.toFixed(2)}  stop=${stopPrice.toFixed(2)}  t1=${target1.toFixed(2)}  t2=${target2.toFixed(2)}`, { tags: 'moneybag' });
          await takeEntry(sig.dir, entryType, entryPriceP, stopPrice, target1, target2, sig.source, sig.grade, tightStopPrice, contracts, signalContext,
            tlPi('levels-limit', `Levels PRO has a ${CONFIG.levelsOnlyEntries ? '' : `grade-${lv.plan.grade} `}${sig.dir === 1 ? 'LONG' : 'SHORT'} plan${tlLvName} that wants a ${entryType} order at ${tlP(entryPriceP)} (current price ${tlP(refPrice)}): the bot rests it there and waits for price to come to the level; an unfilled order is cancelled after ${Math.round(CONFIG.pendingExpireMs / 60000)} min${CONFIG.pendingCancelOnStopTouch ? ', or at once if price reaches its stop or TP1 first' : ''}.`, { kind: 'structure', rawStop: stopPriceRaw }, entryPriceP, target1Points, structTarget));
        }
      } else {
        const atrRef = lv.atrRef || mac.atrVal || 1;
        const risk = atrRef * 0.5;
        const pullbackLvl = !macMarketOnly && CONFIG.macOnlyPullbackMaxAtr > 0
          ? findPullbackLevel(sig.dir, refPrice, lv.levels, atrRef * CONFIG.macOnlyPullbackMaxAtr)
          : null;
        if (pullbackLvl) {
          const entryPriceP = pullbackLvl.price;
          const stopPriceRaw = sig.dir === 1 ? entryPriceP - risk : entryPriceP + risk;
          const tightStop = capStop(entryPriceP, stopPriceRaw, sig.dir, stopCapPoints, effectiveStopMultiple);
          const { stopPrice, tightStopPrice, stopFloor: sfGeo } = floorEntryStop(sig.dir, entryPriceP, applySmartHold(entryPriceP, tightStop, sig.dir), 'LIMIT', { rawStop: stopPriceRaw, capPts: Math.abs(entryPriceP - tightStop) });   // floor after the cap, BEFORE sizing
          signalContext.stopFloor = sfGeo;
          const contracts = sizeB2c(sizeForStop(Math.abs(entryPriceP - stopPrice), sig));   // 10/18 RULE 1
          if (!contracts) return riskCapSkip(mac, lv, sig, Math.abs(entryPriceP - stopPrice), { entryType: 'LIMIT', entry: entryPriceP, stop: stopPrice, path: 'mac-pullback' });
          noteSizing(sig.dir, contracts, Math.abs(entryPriceP - stopPrice), { source: sig.source, grade: sig.grade, entryType: 'LIMIT', path: 'mac-pullback' });
          stopCapShadow('mac-pullback', entryPriceP, stopPriceRaw, tightStop, stopPrice, contracts);   // journal only
          const leg1Size = leg1SizeForContracts(contracts);
          const target1Points = tp1PointsFor(effectiveTarget1DollarGoal, leg1Size);   // 10/18 RULE 2
          const target1 = sig.dir === 1 ? entryPriceP + target1Points : entryPriceP - target1Points;
          const target2 = computeTarget2(sig.dir, entryPriceP, target1, tp2BasisPoints(effectiveTarget1DollarGoal), null, effectiveTarget2Multiple, asiaStruct);
          log(`SIGNAL: ${sig.dir === 1 ? 'LONG' : 'SHORT'} LIMIT mac-only pullback @ ${pullbackLvl.name} (${pullbackLvl.behavior}) (grade ${sig.grade}, ${contracts}x)${inNySession ? ` [NY ${CONFIG.nyStopMultiple}x stop]` : ''}${offPeakTag}  pending entry=${entryPriceP.toFixed(2)}  stop=${stopPrice.toFixed(2)}${tightStopPrice != null ? ` (tight ref ${tightStopPrice.toFixed(2)})` : ''}  target1=${target1.toFixed(2)}  target2=${target2.toFixed(2)}`);
          signalPushArm(`Signal: ${sig.dir === 1 ? 'LONG' : 'SHORT'} (grade ${sig.grade}, ${contracts}x)`, `mac-only pullback LIMIT @ ${pullbackLvl.name} (${pullbackLvl.behavior}) pending @ ${entryPriceP.toFixed(2)}  stop=${stopPrice.toFixed(2)}  t1=${target1.toFixed(2)}  t2=${target2.toFixed(2)}`, { tags: 'moneybag' });
          // levelContext (2026-09-22): the console log already named the
          // exact level ("4H Open (SWEEP UP)"), but that never made it
          // into signalContext/the trade journal for this entry type —
          // only the (usually-irrelevant, since this branch only runs when
          // Levels PRO's own plan DIDN'T match) levelsPlan field did. This
          // is what makes "why did it short here" answerable later from
          // the journal/mobile instead of only from a log line you happened
          // to catch live.
          await takeEntry(sig.dir, 'LIMIT', entryPriceP, stopPrice, target1, target2, sig.source, sig.grade, tightStopPrice, contracts, { ...signalContext, levelContext: { name: pullbackLvl.name, behavior: pullbackLvl.behavior, price: pullbackLvl.price } },
            tlPi('mac-pullback', `limit pullback at ${pullbackLvl.name} ${pullbackLvl.behavior}: Levels PRO has no plan in this direction, so MAC Trap's ${sig.dir === 1 ? 'LONG' : 'SHORT'} signal (grade ${sig.grade || 'n/a'}) is entered as a resting LIMIT at the nearest pullback level, ${tlP(pullbackLvl.price)}, ${tlP(Math.abs(refPrice - pullbackLvl.price))} pts from the current price ${tlP(refPrice)} (within ${CONFIG.macOnlyPullbackMaxAtr} ATR).`, tlAtrStop(entryPriceP, stopPriceRaw, atrRef, risk), entryPriceP, target1Points, null));
        } else {
          const stopPriceRaw = sig.dir === 1 ? refPrice - risk : refPrice + risk;
          const tightStop = capStop(refPrice, stopPriceRaw, sig.dir, stopCapPoints, effectiveStopMultiple);
          const { stopPrice, tightStopPrice, stopFloor: sfGeo } = floorEntryStop(sig.dir, refPrice, applySmartHold(refPrice, tightStop, sig.dir), 'MARKET', { rawStop: stopPriceRaw, capPts: Math.abs(refPrice - tightStop) });   // floor after the cap, BEFORE sizing
          signalContext.stopFloor = sfGeo;
          const contracts = sizeB2c(sizeForStop(Math.abs(refPrice - stopPrice), sig));   // 10/18 RULE 1
          if (!contracts) return riskCapSkip(mac, lv, sig, Math.abs(refPrice - stopPrice), { entryType: 'MARKET', entry: refPrice, stop: stopPrice, path: 'mac-market' });
          noteSizing(sig.dir, contracts, Math.abs(refPrice - stopPrice), { source: sig.source, grade: sig.grade, entryType: 'MARKET', path: 'mac-market' });
          stopCapShadow('mac-market', refPrice, stopPriceRaw, tightStop, stopPrice, contracts);   // journal only
          const leg1Size = leg1SizeForContracts(contracts);
          const target1Points = tp1PointsFor(effectiveTarget1DollarGoal, leg1Size);   // 10/18 RULE 2
          const target1 = sig.dir === 1 ? refPrice + target1Points : refPrice - target1Points;
          const target2 = computeTarget2(sig.dir, refPrice, target1, tp2BasisPoints(effectiveTarget1DollarGoal), null, effectiveTarget2Multiple, asiaStruct);
          log(`SIGNAL: ${sig.dir === 1 ? 'LONG' : 'SHORT'} MARKET mac-only (grade ${sig.grade}, ${contracts}x)${inNySession ? ` [NY ${CONFIG.nyStopMultiple}x stop]` : ''}${offPeakTag}  entry~${refPrice.toFixed(2)}  stop=${stopPrice.toFixed(2)}${tightStopPrice != null ? ` (tight ref ${tightStopPrice.toFixed(2)})` : ''}  target1=${target1.toFixed(2)}  target2=${target2.toFixed(2)}`);
          signalPushArm(`Signal: ${sig.dir === 1 ? 'LONG' : 'SHORT'} (grade ${sig.grade}, ${contracts}x)`, `mac-only MARKET entry~${refPrice.toFixed(2)}  stop=${stopPrice.toFixed(2)}  t1=${target1.toFixed(2)}  t2=${target2.toFixed(2)}`, { tags: 'moneybag' });
          await takeEntry(sig.dir, 'MARKET', refPrice, stopPrice, target1, target2, sig.source, sig.grade, tightStopPrice, contracts, signalContext,
            tlPi('mac-market', macMarketOnly && farSwitch ? `FAR-LIMIT SWITCH: the Levels ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${farSwitch.entryType || 'LIMIT'} at ${tlP(farSwitch.limit)} was ${tlP(farSwitch.pts)} pts (${farSwitch.atrX} x 15m ATR) from price while MAC Trap fired ${sig.dir === 1 ? 'LONG' : 'SHORT'} grade ${sig.grade || 'n/a'} intrabar, so ${farSwitch.pending ? 'the resting order was cancelled and ' : ''}MAC's signal is entered at market ~${tlP(refPrice)}.` : `Levels PRO has no plan in this direction and no pullback level is within ${CONFIG.macOnlyPullbackMaxAtr} ATR of price, so MAC Trap's ${sig.dir === 1 ? 'LONG' : 'SHORT'} signal (grade ${sig.grade || 'n/a'}) is entered at market ~${tlP(refPrice)}.`, tlAtrStop(refPrice, stopPriceRaw, atrRef, risk), refPrice, target1Points, null));
        }
      }
      return 'entered';
    }
  }
}

main().catch(async e => {
  console.error('FATAL:', e);
  await notifyPhone('Executor crashed', `live-executor.js exited with a fatal error: ${e.message}`, { priority: 'urgent', tags: 'skull' });
  process.exit(1);
});
