// Fetches multi-timeframe OHLCV bars for a contract from the real ProjectX
// Gateway API, via the local tmc-proxy.js (for CORS). Node has built-in
// fetch (v18+), so no dependencies are needed here.

const PROXY_BASE = 'http://localhost:8787';
const { findPlacedOrder } = require('./brokerAuth');

const UNIT = { SECOND: 1, MINUTE: 2, HOUR: 3, DAY: 4, WEEK: 5, MONTH: 6 };

// 15s timeout (2026-09-29): a dead connection with no timeout hangs this
// fetch() forever — it never resolves OR rejects, so the main loop's own
// try/catch (which handles every OTHER failure mode fine) never even runs,
// and the process sits frozen indefinitely with no error, no crash, no
// systemd restart. Root cause of the 2026-09-27/28 weekend stall: an idle
// connection over the ~49h weekly market closure silently died with nothing
// on either end to notice. AbortSignal.timeout() turns that into a normal
// rejected promise, which the caller's existing catch-and-retry handles.
//
// edge r1.2 (live finding 11/09-11/11: "TypeError: fetch failed" ~100 ms after most 15m closes; the first intrabar check was skipped each time).
// Root cause, reproduced (EDGE-R12.md): Node's fetch keeps the proxy connections of the bar-close burst open for reuse; tmc-proxy.js closed an idle
// connection after 5 s (Node's http default). The bar-close evaluation is one long synchronous block, so the bot's own "this connection is too old"
// timer could not run; the next request went out on a connection the proxy had already closed -> UND_ERR_SOCKET "other side closed".
//   1. CONNECTION-LEVEL failures (the request never got an answer because the socket was dead) are retried ONCE after 150 ms, on READ-ONLY paths only
//      (RETRY_READ_PATHS, exact match, default deny). A timeout is NOT a connection-level failure and is never retried here.
//   2. Order/place, Order/cancel, Order/modify, every Auth path and anything not on the list keep exactly the previous behaviour: one attempt, the
//      error propagates (the order machine's own UNKNOWN / safe-exit handling decides). A state-changing call is never sent twice from here.
//   3. Every failed attempt is counted (fetchFailureStats) and logged as path + cause code only (no token, no body).
const RETRY_READ_PATHS = new Set([
  '/api/History/retrieveBars',
  '/api/Position/searchOpen',
  '/api/Order/search',
  '/api/Order/searchOpen',
  '/api/Account/search',
  '/api/Trade/search',
  '/api/Contract/search',
]);
const CONN_CAUSE_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNREFUSED']);
const CONN_RETRY_DELAY_MS = 150;
// The cause code of a connection-level fetch failure, else null (HTTP statuses, timeouts, aborts, bad JSON = null).
function connFailureCode(e) {
  if (!e || e.name !== 'TypeError' || e.message !== 'fetch failed') return null;
  const c = e.cause; if (!c || typeof c !== 'object') return null;
  if (typeof c.code === 'string' && CONN_CAUSE_CODES.has(c.code)) return c.code;
  if (typeof c.message === 'string' && /other side closed/i.test(c.message)) return typeof c.code === 'string' && c.code ? c.code : 'OTHER_SIDE_CLOSED';
  return null;
}
// A short label for any transport failure: the cause code, else the error name (TimeoutError, AbortError, ...). Never the message of an HTTP body.
function fetchCauseOf(e) {
  const c = e && e.cause;
  if (c && typeof c === 'object' && typeof c.code === 'string' && c.code) return c.code;
  if (c && typeof c === 'object' && typeof c.message === 'string' && /other side closed/i.test(c.message)) return 'OTHER_SIDE_CLOSED';
  return e && typeof e.name === 'string' && e.name ? e.name : 'UNKNOWN';
}
const fetchFail = { times: [], recovered: [], lastAt: null, lastPath: null, lastCause: null, lastIdleMs: null, lastAnswerAt: null };
let fetchLog = null;   // set by the executor (setFetchLog); null = silent
function setFetchLog(fn) { fetchLog = typeof fn === 'function' ? fn : null; }
function noteFetchFailure(path, cause, t = Date.now()) {
  fetchFail.times.push(t); if (fetchFail.times.length > 2000) fetchFail.times.shift();
  fetchFail.lastAt = t; fetchFail.lastPath = path; fetchFail.lastCause = cause;
  fetchFail.lastIdleMs = fetchFail.lastAnswerAt != null ? t - fetchFail.lastAnswerAt : null;   // how long since the proxy last answered anything (>= 5000 = the idle-connection case)
}
// For the health heartbeat / phone snapshot: failed fetch ATTEMPTS (transport level, not HTTP statuses) in the last hour, and the latest one.
function fetchFailureStats(now = Date.now()) {
  const since = now - 3600000, n = a => { let k = 0; for (let i = a.length - 1; i >= 0 && a[i] > since; i--) k++; return k; };
  return { lastHour: n(fetchFail.times), recoveredLastHour: n(fetchFail.recovered), lastAt: fetchFail.lastAt, lastPath: fetchFail.lastPath, lastCause: fetchFail.lastCause, lastIdleMs: fetchFail.lastIdleMs };
}
function _resetFetchFailures() { fetchFail.times = []; fetchFail.recovered = []; fetchFail.lastAt = fetchFail.lastPath = fetchFail.lastCause = fetchFail.lastIdleMs = fetchFail.lastAnswerAt = null; }
const fetchSleep = ms => new Promise(r => setTimeout(r, ms));
async function rawPtxFetchOnce(path, body, token) {
  let r;
  try {
    r = await fetch(PROXY_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    // transport failure: tag it (path + cause code only) so every caller's log line can say what failed
    try { e.fetchPath = path; e.fetchCause = fetchCauseOf(e); noteFetchFailure(path, e.fetchCause); } catch (_) { /* observation only */ }
    throw e;
  }
  fetchFail.lastAnswerAt = Date.now();   // any HTTP answer: the connection worked
  if (!r.ok) { const e = new Error(`${path} -> HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
async function rawPtxFetch(path, body, token) {
  try { return await rawPtxFetchOnce(path, body, token); }
  catch (e) {
    const code = connFailureCode(e), retry = code != null && RETRY_READ_PATHS.has(path);
    if (e && e.fetchPath && fetchLog) { try { fetchLog(`  [fetch] ${path} failed: ${e.fetchCause}${fetchFail.lastIdleMs != null ? ` (${fetchFail.lastIdleMs} ms after the proxy's last answer)` : ''}${retry ? ` - read-only path, retrying once in ${CONN_RETRY_DELAY_MS} ms` : ' - not retried'}`); } catch (_) { /* log only */ } }
    if (!retry) throw e;
    await fetchSleep(CONN_RETRY_DELAY_MS);
    const d = await rawPtxFetchOnce(path, body, token);   // the second failure propagates (tagged and counted like the first)
    fetchFail.recovered.push(Date.now()); if (fetchFail.recovered.length > 2000) fetchFail.recovered.shift();
    return d;
  }
}

// 10/18 (live finding 10/15: token expired after 24 h -> every call 401, bot blind): when `token` is a lib/brokerAuth.js BrokerAuth, an HTTP 401
// re-logs in (rate-limited) and retries THIS call once. /api/Order/place is retried only after the broker's order lists prove the first attempt
// did not land (no duplicate order); while auth is failing no order is sent at all. A plain string token behaves exactly as before.
async function ptxFetch(path, body, token, { preSubmit } = {}) {
  const send = (credential) => {
    // Entry-only validator is opt-in by call site. Protection has no validator.
    // Run synchronously AFTER all auth/reconciliation awaits, on EVERY submit attempt.
    if (path === '/api/Order/place' && preSubmit !== undefined && (typeof preSubmit !== 'function' || preSubmit() !== true)) {
      const e = new Error('ALIGNMENT_UNKNOWN: entry evidence invalid at transport submit');
      e.alignmentBlocked = true; throw e;
    }
    return rawPtxFetch(path, body, credential);
  };
  if (!token || token.isBrokerAuth !== true) return send(token);
  const auth = token, isPlace = path === '/api/Order/place', startedAt = Date.now();
  if (isPlace && auth.blocksOrders()) {
    const r = await auth.refresh('before an order');
    if (!r.ok || auth.blocksOrders()) { const e = new Error(`${path} NOT SENT: BROKER AUTH FAILED (${auth.lastError || 're-login failed'})`); e.status = 401; e.authBlocked = true; throw e; }
  }
  const sent = auth.toString();
  try { const d = await send(sent); auth.noteSuccess(); return d; }
  catch (e) {
    if (e.status !== 401) throw e;
    // another call may already have renewed the token while this one was in flight
    let ok = auth.toString() !== sent;
    if (!ok) { const r = await auth.refresh(`HTTP 401 on ${path}`); ok = r.ok && auth.toString() !== sent; if (!ok && r.skipped) auth.failing = true; }
    if (!ok) { e.message += ' (broker auth: re-login ' + (auth.canAttempt() ? 'failed' : 'tried < ' + Math.round(auth.minGapMs / 1000) + ' s ago') + ')'; e.authFailed = true; throw e; }
    if (isPlace) {
      const chk = await findPlacedOrder(rawPtxFetch, auth.toString(), body, startedAt);
      if (chk.found) {
        auth.recoveredOrders++; auth.noteSuccess();
        auth.log(`  [auth] Order/place answered 401 but the order IS at the broker (id ${chk.order.id}, via ${chk.via}) - NOT sent again`);
        return { success: true, orderId: chk.order.id, errorCode: 0, errorMessage: null, recoveredAfterAuth: true };
      }
      if (chk.unknown) { const e2 = new Error(`${path} -> HTTP 401, re-login OK, but the order list is unreadable: NOT retried (no duplicate risk)`); e2.status = 401; e2.authUnknownOrder = true; throw e2; }
    }
    auth.retries++;
    try { const d = await send(auth.toString()); auth.noteSuccess(); return d; }
    catch (e2) { if (e2.status === 401) auth.noteAuthFailure(`${path} still 401 after a re-login`); throw e2; }
  }
}

function unitDurationMs(unit, unitNumber) {
  switch (unit) {
    case UNIT.SECOND: return unitNumber * 1000;
    case UNIT.MINUTE: return unitNumber * 60000;
    case UNIT.HOUR: return unitNumber * 3600000;
    case UNIT.DAY: return unitNumber * 86400000;
    case UNIT.WEEK: return unitNumber * 7 * 86400000;
    case UNIT.MONTH: return unitNumber * 30 * 86400000; // approximate, only used for lookback sizing
    default: return 60000;
  }
}

async function fetchBars(token, contractId, unit, unitNumber, { limit = 400, live = false } = {}) {
  const barMs = unitDurationMs(unit, unitNumber);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - barMs * (limit + 10));
  const d = await ptxFetch('/api/History/retrieveBars', {
    contractId, live,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    unit, unitNumber, limit, includePartialBar: true,
  }, token);
  if (!d?.success) throw new Error(`retrieveBars failed: ${d?.errorMessage || d?.errorCode}`);
  const bars = (d.bars || []).map(b => ({
    t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
  }));
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

// Fetches every timeframe both indicators reference, for one contract.
// `limit` controls how many intraday bars come back; monthly/weekly/daily
// windows are sized separately since they need far fewer bars.
// onRead(key, bars) (r8 alignment freshness, optional): called the moment each timeframe's request COMPLETES successfully, so the caller
// can stamp a per-request completion time. Omitted = exactly the previous behaviour.
const tapRead = (onRead, key) => bars => { if (onRead) onRead(key, bars); return bars; };
async function fetchAllTimeframes(token, contractId, { limit = 400, onRead = null } = {}) {
  const [M, W, D, H4, H1, M30, M15, M10, M5, M3] = await Promise.all([
    fetchBars(token, contractId, UNIT.MONTH, 1, { limit: 36 }).then(tapRead(onRead, 'M')),
    fetchBars(token, contractId, UNIT.WEEK, 1, { limit: 104 }).then(tapRead(onRead, 'W')),
    fetchBars(token, contractId, UNIT.DAY, 1, { limit: 250 }).then(tapRead(onRead, 'D')),
    fetchBars(token, contractId, UNIT.HOUR, 4, { limit }).then(tapRead(onRead, 'H4')),
    fetchBars(token, contractId, UNIT.HOUR, 1, { limit }).then(tapRead(onRead, 'H1')),
    fetchBars(token, contractId, UNIT.MINUTE, 30, { limit }).then(tapRead(onRead, 'M30')),
    fetchBars(token, contractId, UNIT.MINUTE, 15, { limit }).then(tapRead(onRead, 'M15')),
    // Lower-TF RSI exhaustion check (macTrap.js) needs these; nothing else did
    // before, which is why they weren't fetched previously.
    fetchBars(token, contractId, UNIT.MINUTE, 10, { limit }).then(tapRead(onRead, 'M10')),
    fetchBars(token, contractId, UNIT.MINUTE, 5, { limit }).then(tapRead(onRead, 'M5')),
    fetchBars(token, contractId, UNIT.MINUTE, 3, { limit }).then(tapRead(onRead, 'M3')),
  ]);
  return { M, W, D, H4, H1, M30, M15, M10, M5, M3 };
}

// Intrabar evaluation mode (2026-10-08) — ONLY the timeframes that can
// actually produce a DIFFERENT value inside one poll cycle. Traced every
// htf.X read in macTrap.js/levelsPro.js to confirm this, not guessed:
//   - M15: the still-forming bar intrabar mode exists to watch. Always live.
//   - H1, H4: levelsPro.js's alignedFull ("15m+ 1h+ 4h+") reads each one's
//     CURRENT bar's close via bsearchOpenIndex (the same "current period"
//     lookup M15 itself uses), not the closed-bar-safe bsearchClosedIndex —
//     so these are ALREADY live-sensitive today, in plain bar-close mode
//     too, not something intrabar mode introduces. They need to be in this
//     fast set or alignedFull silently goes stale between real closes.
//   - M30, D, W, M and M10/M5/M3 are NOT here on purpose: M30/D/W/M are
//     only ever read as a fixed Open price (known from the first tick,
//     genuinely non-repainting) or through bsearchClosedIndex — they
//     cannot produce a different value until they close, and that close
//     always lands exactly on a real 15m boundary the bar-close path
//     already catches the instant it happens. M10/M5/M3 only feed the RSI
//     exhaustion-gate veto, which is OFF in live CONFIG right now. Fetching
//     any of those 7 more often than every real bar close changes nothing
//     about what the bot decides — the caller merges this into a cached
//     copy of them from the most recent FULL fetchAllTimeframes() call (at
//     startup and every real bar close); see live-executor.js's
//     refreshAndEvaluate() for exactly how.
//
// `extra` (owner forward-test 2026-10-11, not backtested): optional list of additional timeframe keys to refresh on the same
// call, from EXTRA_FAST_TF below (e.g. ['M5','M3'] so the Levels PRO 5m/3m triggers see the still-forming bar). Default [] =
// exactly the three calls above, nothing else. Each extra key is ONE additional retrieveBars call per intrabar poll.
const EXTRA_FAST_TF = { M3: [UNIT.MINUTE, 3], M5: [UNIT.MINUTE, 5], M10: [UNIT.MINUTE, 10], M30: [UNIT.MINUTE, 30] };
async function fetchFastTimeframes(token, contractId, { limit = 400, extra = [], onRead = null } = {}) {
  const extraKeys = (extra || []).filter(k => EXTRA_FAST_TF[k]);
  const [M15, H1, H4, ...extraBars] = await Promise.all([
    fetchBars(token, contractId, UNIT.MINUTE, 15, { limit }).then(tapRead(onRead, 'M15')),
    fetchBars(token, contractId, UNIT.HOUR, 1, { limit }).then(tapRead(onRead, 'H1')),
    fetchBars(token, contractId, UNIT.HOUR, 4, { limit }).then(tapRead(onRead, 'H4')),
    ...extraKeys.map(k => fetchBars(token, contractId, EXTRA_FAST_TF[k][0], EXTRA_FAST_TF[k][1], { limit }).then(tapRead(onRead, k))),
  ]);
  const out = { M15, H1, H4 };
  extraKeys.forEach((k, i) => { out[k] = extraBars[i]; });
  return out;
}

// Returns the HTF bar whose period CONTAINS timestamp `ts` — i.e. the
// current (possibly still-forming) bar. Mirrors Pine's
// request.security(..., lookahead=barmerge.lookahead_on) used for HTF OPENS,
// which is safe because an HTF open is fixed and known from the first tick
// of its bar.
function htfOpenAt(htfBars, ts) {
  let result = null;
  for (const b of htfBars) {
    if (b.t <= ts) result = b; else break;
  }
  return result;
}

// Returns the last HTF bar that fully CLOSED before timestamp `ts`. Mirrors
// lookahead=barmerge.lookahead_off, used for anything close-derived (EMAs,
// impulse, etc.) to avoid lookahead bias.
function htfClosedAt(htfBars, ts, barDurationMs) {
  let result = null;
  for (const b of htfBars) {
    if (b.t + barDurationMs <= ts) result = b; else break;
  }
  return result;
}

module.exports = { UNIT, unitDurationMs, fetchBars, fetchAllTimeframes, fetchFastTimeframes, EXTRA_FAST_TF, htfOpenAt, htfClosedAt, ptxFetch, rawPtxFetch,
  RETRY_READ_PATHS, CONN_RETRY_DELAY_MS, connFailureCode, fetchCauseOf, fetchFailureStats, setFetchLog, _resetFetchFailures };
