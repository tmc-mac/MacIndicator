'use strict';
// lib/healthAlerts.js - bf-alerts r1 (NOTIFICATION / JOURNAL ONLY). Pushes Mac's phone when the bot is unhealthy or takes a full stop.
// Nothing here is read by an order, a gate, a size, a stop, a target or the state machine. Every entry point catches its own errors:
// a failed push, a failed file write or a bad argument is logged and the caller carries on (the trading loop never sees a throw).
//
// Alerts (each pushed through the bot's own notifyPhone channel, journaled as one { type: 'alert' } row, de-duplicated):
//   not-live     the bot is running but not in a healthy live loop (warming up, desynced / halted, broker auth failing, loop passes failing
//                or stalled, market data stale) for NOT_LIVE_MS (10 min) during trading hours. Re-pushed every REPUSH_MS (30 min) while it lasts;
//                "recovered" once when it ends (only if a push went out). Outside trading hours the episode closes silently.
//   restarts     3 starts (= 2 restarts) within RESTART_WINDOW_MS (30 min). Start times persist in the state file next to the bot.
//                One push per window (a 4th start inside the same 30 min adds no push).
//   warmup       the warm-up was skipped (the loop started without one), cut short (fewer 15m bars than historyRefreshLimit),
//                failed (threw), or stopped (the previous process ended mid warm-up; seen on the next start). One push per start.
//   full-stop    a trade closed at its full protective stop: side, qty, entry, exit, pts/contract, $ net (estimate). One push per trade.
//   halt / any   healthAlert(kind, details): for desk A's exit-safety HALT and any other safety event (see healthAlert below).
//
// Heartbeat: a small JSON file (heartbeatFile) rewritten at most every HEARTBEAT_MIN_MS and on every check (every CHECK_MS), read by the
// external watchdog (health-watchdog.js), which pushes when the process is dead or frozen (the bot cannot alert for itself then).

const fs = require('fs');
const path = require('path');
const NP = require('./notifyPolicy');

const VERSION = 'bf-alerts r1';
const MIN = 60000;
const NOT_LIVE_MS = 10 * MIN;
const REPUSH_MS = 30 * MIN;
const RESTART_WINDOW_MS = 30 * MIN;
const RESTART_COUNT = 3;                 // 3 starts inside the window = restarted twice
const STALL_MS = 5 * MIN;                // no completed loop pass for this long = not live (the loop is stuck or every pass throws)
const STALE_BAR_MS = 5 * MIN;            // the newest 1m bar older than this, in trading hours = market data stale
const CHECK_MS = 30000;
const HEARTBEAT_MIN_MS = 10000;
const HALT_DEDUPE_MS = 30 * MIN;
const ONCE_TTL_MS = 60 * MIN;
// UNVERIFIED full CME closures (PT dates). Used ONLY to keep the "market data stale" reason quiet on those days; nothing else reads it.
const FULL_CLOSED_DAYS = new Set(['2026-12-25', '2027-01-01']);

const fin = v => typeof v === 'number' && Number.isFinite(v);
const f2 = v => (fin(v) ? v.toFixed(2) : '?');
const mins = ms => Math.max(0, Math.round(ms / MIN));
const hhmmUtc = t => new Date(t).toISOString().slice(11, 16) + 'Z';
const money = v => (fin(v) ? `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}` : '?');

// The default "trading hours" test: the bot's own session calendar (Sun 15:00 PT -> Fri 13:10 PT, not 13:10-15:00 PT on weekdays).
function defaultInTradingHours(t) { try { return NP.statusPushWindow(t); } catch (e) { return false; } }

let active = null;   // the instance healthAlert() forwards to (the executor creates one)

function createHealthAlerts(opts = {}) {
  const {
    notify = () => Promise.resolve(),           // notifyPhone(title, body, { priority, tags })
    log = () => {},
    now = () => Date.now(),
    stateFile = null,                            // restarts + warm-up-in-progress (survives a restart)
    heartbeatFile = null,                        // read by health-watchdog.js
    inTradingHours = defaultInTradingHours,
    staleExempt = () => false,                   // extra days on which "data stale" is not a reason (early-close candidates)
    warmupBarsNeeded = 2000,
    pointValue = null,
    costPerContractRoundTrip = 0,
    label = '',                                  // e.g. '[PAPER] ' for the paper process
    pid = process.pid,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;

  let journalFn = null; const journalQueue = [];
  const nl = { live: false, since: now(), reason: 'starting up', lastLiveAt: null, lastPassAt: null, alertedAt: null, pushes: 0, firstAlertAt: null };
  let lastBarT = null;
  let warm = { reported: false, startedAt: null };
  const fullStopSeen = new Set();
  const haltSeen = new Map();
  const onceSeen = new Map();
  let timer = null, lastBeat = 0;
  const counts = { pushes: 0, pushFails: 0, byKind: {} };

  function safeLog(m) { try { log(m); } catch (e) { /* never */ } }
  function journal(row) {
    try { if (journalFn) journalFn(row); else { journalQueue.push(row); if (journalQueue.length > 50) journalQueue.shift(); } }
    catch (e) { safeLog('  [health] journal write failed (non-fatal): ' + (e && e.message)); }
  }
  // the one push path: never throws, never rejects; a failed push is logged and counted
  function push(kind, title, body, extra = {}, { priority = 'high', tags = 'warning' } = {}) {
    const t = now();
    counts.pushes++; counts.byKind[kind] = (counts.byKind[kind] || 0) + 1;
    safeLog(`  [health] ALERT ${kind}: ${title} - ${body}`);
    journal({ type: 'alert', t, kind, title, body, ...extra });
    try {
      const p = notify(`${label}${title}`, body, { priority, tags });
      if (p && typeof p.then === 'function') p.then(null, e => { counts.pushFails++; safeLog(`  [health] push failed (non-fatal): ${e && e.message}`); });
    } catch (e) { counts.pushFails++; safeLog(`  [health] push failed (non-fatal): ${e && e.message}`); }
    return true;
  }

  // ---- state file (restarts, warm-up in progress) ----
  function loadState() {
    if (!stateFile) return {};
    try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
  }
  function saveState(st) {
    if (!stateFile) return;
    try { const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, stateFile); }
    catch (e) { safeLog('  [health] state file not saved (non-fatal): ' + e.message); }
  }

  // ---- 2. restarts ----
  function noteStart() {
    try {
      const t = now(), st = loadState();
      const starts = (Array.isArray(st.starts) ? st.starts : []).filter(x => fin(x) && t - x < RESTART_WINDOW_MS && x <= t);
      starts.push(t);
      st.starts = starts;
      // 3. the previous process ended during its warm-up (killed, crashed, OOM): seen now
      if (st.warmup && fin(st.warmup.startedAt) && st.warmup.pid !== pid) {
        const w = st.warmup;
        push('warmup', 'Warm-up STOPPED before it finished', `The previous bot process (started its warm-up at ${hhmmUtc(w.startedAt)}) ended before the warm-up completed. This start warms up again; check the log for why it stopped (memory, crash, kill).`, { reason: 'stopped', startedAt: w.startedAt });
      }
      st.warmup = null;
      if (starts.length >= RESTART_COUNT && !(fin(st.restartAlertAt) && t - st.restartAlertAt < RESTART_WINDOW_MS)) {
        st.restartAlertAt = t;
        push('restarts', `Bot restarted ${starts.length - 1} times in 30 min`, `${starts.length} starts since ${hhmmUtc(starts[0])} (${starts.map(hhmmUtc).join(', ')}). It may be crash-looping; check the log. Open positions keep their broker-side stops.`, { starts: starts.slice() });
      } else if (starts.length >= RESTART_COUNT) safeLog(`  [health] ${starts.length} starts in 30 min (already pushed at ${hhmmUtc(st.restartAlertAt)}; no new push).`);
      saveState(st);
      return starts.length;
    } catch (e) { safeLog('  [health] restart check failed (non-fatal): ' + (e && e.message)); return 0; }
  }

  // ---- 3. warm-up ----
  function warmupStart() {
    try { warm.startedAt = now(); const st = loadState(); st.warmup = { startedAt: warm.startedAt, pid }; saveState(st); notLive('warming up'); }
    catch (e) { safeLog('  [health] warm-up note failed (non-fatal): ' + (e && e.message)); }
  }
  // { bars, need, error, skipped }
  function warmupResult(r = {}) {
    try {
      if (warm.reported) return;
      warm.reported = true;
      const st = loadState(); st.warmup = null; saveState(st);
      const need = fin(r.need) ? r.need : warmupBarsNeeded, took = warm.startedAt != null ? now() - warm.startedAt : null;
      const tookTxt = took != null ? ` after ${Math.round(took / 1000)} s` : '';
      if (r.error) return push('warmup', 'Warm-up FAILED', `The warm-up stopped with an error${tookTxt}: ${String(r.error && r.error.message || r.error).slice(0, 200)}. The bot does not trade without it.`, { reason: 'failed', tookMs: took });
      if (r.skipped) return push('warmup', 'Warm-up SKIPPED', `The bot entered the live loop without a warm-up${r.why ? ` (${r.why})` : ''}. Its levels and signals are not built from the full ${need}-bar history.`, { reason: 'skipped', need });
      if (!fin(r.bars) || r.bars < need) return push('warmup', 'Warm-up cut short', `The warm-up read ${fin(r.bars) ? r.bars : 'no'} 15m bars of the ${need} it needs${tookTxt}. Levels and signals may differ from the chart until the history is complete.`, { reason: 'short', bars: fin(r.bars) ? r.bars : null, need, tookMs: took });
      safeLog(`  [health] warm-up OK: ${r.bars} 15m bars (needs ${need})${tookTxt}.`);
      return false;
    } catch (e) { safeLog('  [health] warm-up check failed (non-fatal): ' + (e && e.message)); return false; }
  }

  // ---- 1. not LIVE ----
  function notLive(reason) {
    nl.reason = reason || nl.reason || 'unknown';
    if (nl.live) { nl.live = false; nl.since = now(); }
  }
  function becameLive() {
    const t = now();
    if (!nl.live && nl.alertedAt != null) {
      push('not-live', 'Bot is LIVE again', `Back in the live loop after ${mins(t - nl.since)} min not live (last reason: ${nl.reason}). ${nl.pushes} not-LIVE push${nl.pushes === 1 ? '' : 'es'} were sent.`, { recovered: true, downMs: t - nl.since, reason: nl.reason }, { priority: 'high', tags: 'white_check_mark' });
    }
    if (!nl.live) Object.assign(nl, { live: true, since: t, alertedAt: null, pushes: 0, firstAlertAt: null });
    nl.lastLiveAt = t;
  }
  // called at the end of every main-loop pass. ok = the pass completed; reason = why the bot is not trading normally (null = healthy); barT = newest 1m bar time
  function pass({ ok = true, reason = null, barT = null } = {}) {
    try {
      const t = now();
      if (fin(barT)) lastBarT = barT;
      if (!warm.reported) warmupResult({ skipped: true, why: 'no warm-up was reported before the first loop pass' });
      if (ok) nl.lastPassAt = t;
      let why = ok ? reason : (reason || 'a loop pass failed');
      if (!why && ok && fin(lastBarT) && t - lastBarT > STALE_BAR_MS && inTradingHours(t) && !isStaleExempt(t)) why = `market data stale: the newest 1m bar is ${mins(t - lastBarT)} min old`;
      if (why) notLive(why); else becameLive();
      check();
    } catch (e) { safeLog('  [health] pass check failed (non-fatal): ' + (e && e.message)); }
  }
  function isStaleExempt(t) {
    try { if (staleExempt(t)) return true; } catch (e) { /* not exempt */ }
    try { return FULL_CLOSED_DAYS.has(NP.ptClock(t).date); } catch (e) { return false; }
  }
  // the timer side (also runs while the loop is stuck in an await): stall detection, the 10-min rule, re-push, heartbeat
  function check() {
    try {
      const t = now();
      if (nl.live && nl.lastPassAt != null && t - nl.lastPassAt > STALL_MS) { nl.live = false; nl.since = nl.lastPassAt; nl.reason = `no loop pass completed for ${mins(t - nl.lastPassAt)} min (the loop is stuck or every pass fails)`; }
      if (!nl.live && nl.reason && /^no loop pass completed/.test(nl.reason) && nl.lastPassAt != null) nl.reason = `no loop pass completed for ${mins(t - nl.lastPassAt)} min (the loop is stuck or every pass fails)`;
      if (!nl.live) {
        if (!safeHours(t)) {
          if (nl.alertedAt != null) safeLog(`  [health] not-LIVE episode closed outside trading hours (no push): ${nl.reason}.`);
          nl.alertedAt = null; nl.pushes = 0; nl.firstAlertAt = null; nl.since = t;   // the 10-min clock restarts when trading hours begin
        } else if (t - nl.since >= NOT_LIVE_MS && (nl.alertedAt == null || t - nl.alertedAt >= REPUSH_MS)) {
          const again = nl.alertedAt != null;
          nl.alertedAt = t; nl.pushes++; if (!again) nl.firstAlertAt = t;
          push('not-live', `Bot NOT LIVE for ${mins(t - nl.since)} min`, `Not trading since ${hhmmUtc(nl.since)}: ${nl.reason}.${again ? ` Reminder ${nl.pushes} (every 30 min while it lasts).` : ' Repeats every 30 min while it lasts; "LIVE again" when it ends.'} Open positions keep their broker-side stops.`, { reason: nl.reason, since: nl.since, repeat: nl.pushes - 1 }, { priority: 'urgent', tags: 'rotating_light' });
        }
      }
      beat(t, false);
    } catch (e) { safeLog('  [health] check failed (non-fatal): ' + (e && e.message)); }
  }
  function safeHours(t) { try { return !!inTradingHours(t); } catch (e) { return false; } }
  function beat(t, force) {
    if (!heartbeatFile || (!force && t - lastBeat < HEARTBEAT_MIN_MS)) return;
    lastBeat = t;
    try { const tmp = heartbeatFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ v: 1, t, pid, live: nl.live, reason: nl.live ? null : nl.reason, since: nl.since, lastPassAt: nl.lastPassAt })); fs.renameSync(tmp, heartbeatFile); }
    catch (e) { /* the watchdog reports a missing heartbeat */ }
  }

  // ---- 4. full stop ----
  // { key, dir, qty, entry, exit, pointValue?, netUsd?, grossUsd?, paper?, sure? }  - one push per key (journalId / exit time)
  function fullStop(x = {}) {
    try {
      const key = String(x.key != null ? x.key : `${x.dir}|${x.entry}|${x.t || ''}`);
      if (fullStopSeen.has(key)) return false;
      fullStopSeen.add(key); if (fullStopSeen.size > 200) fullStopSeen.delete(fullStopSeen.values().next().value);
      const dir = x.dir === 1 ? 'LONG' : x.dir === -1 ? 'SHORT' : '?', qty = Number.isInteger(x.qty) && x.qty > 0 ? x.qty : null;
      const pv = fin(x.pointValue) ? x.pointValue : pointValue;
      const pts = fin(x.entry) && fin(x.exit) && (x.dir === 1 || x.dir === -1) ? (x.exit - x.entry) * x.dir : null;
      const gross = fin(x.grossUsd) ? x.grossUsd : fin(pts) && fin(pv) && qty ? pts * pv * qty : null;
      const net = fin(x.netUsd) ? x.netUsd : fin(gross) && qty ? gross - costPerContractRoundTrip * qty : null;
      const title = `Full stop: ${dir} ${qty || '?'}x ${money(net)} net`;
      const body = `${x.paper ? '[PAPER] ' : ''}${dir} ${qty || '?'}x entry ${f2(x.entry)} -> exit ${f2(x.exit)} = ${fin(pts) ? pts.toFixed(2) : '?'} pts/contract, ${money(net)} net (est., incl. ${money(-costPerContractRoundTrip * (qty || 0))} costs; the broker figure follows in the journal).${x.sure === false ? ' (Which order filled was not certain; decided by the last price.)' : ''}`;
      return push('full-stop', title, body, { key, dir: x.dir, qty, entry: fin(x.entry) ? x.entry : null, exit: fin(x.exit) ? x.exit : null, ptsPerContract: fin(pts) ? Math.round(pts * 100) / 100 : null, netUsd: fin(net) ? Math.round(net * 100) / 100 : null, journalId: x.journalId || null }, { priority: 'high', tags: 'chart_with_downwards_trend' });
    } catch (e) { safeLog('  [health] full-stop alert failed (non-fatal): ' + (e && e.message)); return false; }
  }

  // ---- 5. halt / safety events ----
  // healthAlert(kind, details): kind = short id ('halt', 'exit-safety', ...). details (all optional):
  //   title    push title (default 'HALT: <kind>')       message  push body (default: the other detail fields as k=v)
  //   key      de-dupe key (default kind|title)          dedupeMin  window in minutes (default 30); 0 = never de-dupe
  //   priority ntfy priority (default 'urgent')          any other field is journaled with the alert row
  // Returns true when pushed, false when de-duplicated or on error. Never throws.
  function alert(kind, details = {}) {
    try {
      const k = String(kind || 'halt'), d = details && typeof details === 'object' ? details : { message: String(details) };
      const { title: ti, message, key: kk, dedupeMin, priority, tags, ...facts } = d;
      const title = ti ? String(ti) : `HALT: ${k}`;
      const body = message ? String(message) : (Object.keys(facts).length ? Object.entries(facts).map(([a, b]) => `${a}=${typeof b === 'object' ? JSON.stringify(b) : b}`).join(', ') : 'Safety event; check the bot.');
      const key = kk != null ? String(kk) : `${k}|${title}`, win = fin(dedupeMin) && dedupeMin >= 0 ? dedupeMin * MIN : HALT_DEDUPE_MS, t = now();
      const prev = haltSeen.get(key);
      if (win > 0 && fin(prev) && t - prev < win) { safeLog(`  [health] ${k} alert de-duplicated (same key pushed ${mins(t - prev)} min ago): ${title}`); return false; }
      haltSeen.set(key, t);
      return push(k, title, body, { key, ...facts }, { priority: priority || 'urgent', tags: tags || 'rotating_light' });
    } catch (e) { safeLog('  [health] healthAlert failed (non-fatal): ' + (e && e.message)); return false; }
  }

  // ---- 6. log de-dupe (cap-guard line) ----
  // true the first time a key is seen within ttl; the caller logs only then
  function once(key, ttlMs = ONCE_TTL_MS) {
    try {
      const t = now(), k = String(key), prev = onceSeen.get(k);
      if (fin(prev) && t - prev < ttlMs) return false;
      onceSeen.set(k, t);
      if (onceSeen.size > 500) for (const [a, b] of onceSeen) if (t - b >= ttlMs) onceSeen.delete(a);
      return true;
    } catch (e) { return true; }
  }

  function attachJournal(fn) { journalFn = typeof fn === 'function' ? fn : null; if (journalFn) while (journalQueue.length) journal(journalQueue.shift()); }
  function start() { try { if (!timer) { timer = setIntervalFn(check, CHECK_MS); if (timer && typeof timer.unref === 'function') timer.unref(); } beat(now(), true); } catch (e) { safeLog('  [health] timer not started (non-fatal): ' + (e && e.message)); } }
  function stop() { try { if (timer) clearIntervalFn(timer); } catch (e) { /* ignore */ } timer = null; }
  function armedText() {
    return `${VERSION}: alerts ARMED - not-LIVE ${mins(NOT_LIVE_MS)}+ min in trading hours (re-push every ${mins(REPUSH_MS)} min, "LIVE again" once; stall ${mins(STALL_MS)} min, data stale ${mins(STALE_BAR_MS)} min) | restarts ${RESTART_COUNT - 1} in ${mins(RESTART_WINDOW_MS)} min | warm-up skipped / cut short (< ${warmupBarsNeeded} 15m bars) / failed / stopped | full stop (one per trade) | halt / safety healthAlert(kind, details) | heartbeat ${heartbeatFile ? path.basename(heartbeatFile) : 'off'} for health-watchdog.js`;
  }

  const api = { noteStart, warmupStart, warmupResult, pass, check, notLive, fullStop, alert, once, attachJournal, start, stop, armedText,
    view: () => ({ live: nl.live, since: nl.since, reason: nl.live ? null : nl.reason, alertedAt: nl.alertedAt, pushes: nl.pushes, counts: { ...counts, byKind: { ...counts.byKind } } }) };
  active = api;
  return api;
}

// The stable entry point for other code (desk A's exit-safety HALT): healthAlert(kind, details). Forwards to the executor's instance;
// before it exists (or in a unit test without one) it only logs to the console and returns false. Never throws.
function healthAlert(kind, details = {}) {
  try { if (active) return active.alert(kind, details); console.log(`[health] healthAlert(${kind}) before the alerts were set up (not pushed): ${JSON.stringify(details).slice(0, 300)}`); }
  catch (e) { /* never */ }
  return false;
}
function _resetActive() { active = null; }

module.exports = { createHealthAlerts, healthAlert, _resetActive, defaultInTradingHours, VERSION,
  NOT_LIVE_MS, REPUSH_MS, RESTART_WINDOW_MS, RESTART_COUNT, STALL_MS, STALE_BAR_MS, CHECK_MS, HALT_DEDUPE_MS, FULL_CLOSED_DAYS };
