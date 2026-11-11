// BROKER SESSION TOKEN THAT RENEWS ITSELF (10/18 package).
// Live finding 10/15 05:06Z: the bot logged in ONCE at startup; the ProjectX session token expires after ~24 h, so exactly 24 h after the
// 10/14 05:06 restart every call (bars, position, orders) answered HTTP 401 and the bot went blind (status stale 47+ min).
//
// One BrokerAuth object replaces the old token string everywhere. String(auth) / `Bearer ${auth}` is ALWAYS the current token, so every existing
// call site (bars, position, orders, reconciliation, the state machine) picks up a renewed token with no other change. lib/bars.js ptxFetch
// recognises the object and:
//   - on HTTP 401: re-login (POST /api/Auth/validate with the current token first; it answers { success, newToken }; if that fails,
//     /api/Auth/loginKey), then retries THAT call exactly once. Re-logins are rate-limited (at most 1 per minGapMs, default 60 s);
//   - /api/Order/place is never blindly retried: after the re-login it re-reads the broker's orders (Order/searchOpen, then Order/search since
//     the call started). A matching order means the first call DID go through: it is returned, no second order. Only a readable "no match"
//     allows the one retry; an unreadable order list means NO retry (the call fails and the bot's normal reconciliation takes over);
//   - while auth is failing, no order is sent (blocksOrders()); the executor also skips new entries.
// Proactive renewal every refreshHours (default 20 h, CONFIG.tokenRefreshHours) from the main loop. Every attempt is journalled (AUTH_REFRESH).
// After alertAfter (3) consecutive auth failures (a failed re-login, or a call still 401 right after a successful one) it calls alert() once
// (urgent phone push) and view().failed turns true ("BROKER AUTH FAILED" on the phone). Any successful call clears it.
'use strict';

class BrokerAuth {
  constructor({ rawFetch, userName, apiKey, refreshHours = 20, minGapMs = 60000, alertAfter = 3, now = () => Date.now(), log = () => {}, journal = () => {}, alert = () => {} } = {}) {
    if (typeof rawFetch !== 'function') throw new Error('BrokerAuth: rawFetch required');
    this.rawFetch = rawFetch; this.userName = userName; this.apiKey = apiKey;
    this.refreshHours = refreshHours; this.minGapMs = minGapMs; this.alertAfter = alertAfter;
    this.now = now; this.log = log; this.journal = journal; this.alert = alert;
    this.token = null; this.issuedAt = null; this.lastAttemptAt = null; this.inflight = null;
    this.failures = 0; this.failing = false; this.alerted = false; this.lastError = null;
    this.lastRefresh = null; this.refreshes = 0; this.retries = 0; this.recoveredOrders = 0;
  }
  get isBrokerAuth() { return true; }
  toString() { return this.token == null ? '' : String(this.token); }
  [Symbol.toPrimitive]() { return this.toString(); }
  toJSON() { return '[broker token]'; }   // never write the token into a log or a file

  // Startup login (loginKey). Returns true/false; the caller decides (the executor exits on false, as before).
  async login() {
    const t = this.now(); this.lastAttemptAt = t;
    let d; try { d = await this.rawFetch('/api/Auth/loginKey', { userName: this.userName, apiKey: this.apiKey }); } catch (e) { this.lastError = e.message; return false; }
    if (!d || !d.success || !d.token) { this.lastError = (d && d.errorMessage) || `errorCode ${d && d.errorCode}`; return false; }
    this.token = d.token; this.issuedAt = this.now(); this.lastRefresh = { t: this.issuedAt, method: 'loginKey', reason: 'startup', ok: true };
    return true;
  }

  canAttempt() { return this.lastAttemptAt == null || this.now() - this.lastAttemptAt >= this.minGapMs; }

  // Re-login. Concurrent callers share one attempt. Rate-limited: inside minGapMs it returns { ok:false, skipped:true } without calling the broker.
  async refresh(reason) {
    if (this.inflight) return this.inflight;
    if (!this.canAttempt()) return { ok: false, skipped: true, reason };
    this.lastAttemptAt = this.now();
    this.inflight = (async () => {
      const errs = []; let token = null, method = null;
      if (this.token) {
        try {
          const d = await this.rawFetch('/api/Auth/validate', {}, this.toString());
          const nt = d && d.success ? (d.newToken || d.token) : null;
          if (nt) { token = nt; method = 'validate'; } else errs.push('validate: ' + ((d && d.errorMessage) || `errorCode ${d && d.errorCode}`));
        } catch (e) { errs.push('validate: ' + e.message); }
      }
      if (!token) {
        try {
          const d = await this.rawFetch('/api/Auth/loginKey', { userName: this.userName, apiKey: this.apiKey });
          if (d && d.success && d.token) { token = d.token; method = 'loginKey'; } else errs.push('loginKey: ' + ((d && d.errorMessage) || `errorCode ${d && d.errorCode}`));
        } catch (e) { errs.push('loginKey: ' + e.message); }
      }
      const t = this.now();
      if (token) {
        this.token = token; this.issuedAt = t; this.refreshes++;
        this.lastRefresh = { t, method, reason, ok: true };
        this.log(`  [auth] broker token renewed (${method}; ${reason})`);
        this.journal({ type: 'auth', code: 'AUTH_REFRESH', t, ok: true, method, reason, failuresBefore: this.failures });
        return { ok: true, method, reason };
      }
      this.lastRefresh = { t, method: null, reason, ok: false, error: errs.join('; ') };
      this.log(`  [auth] broker re-login FAILED (${reason}): ${errs.join('; ')}`);
      this.journal({ type: 'auth', code: 'AUTH_REFRESH', t, ok: false, reason, error: errs.join('; ').slice(0, 300), failures: this.failures + 1 });
      this.noteAuthFailure(`re-login failed (${reason})`);
      return { ok: false, reason, error: errs.join('; ') };
    })();
    try { return await this.inflight; } finally { this.inflight = null; }
  }

  noteAuthFailure(why) {
    this.failures++; this.failing = true; this.lastError = why;
    if (this.failures >= this.alertAfter && !this.alerted) {
      this.alerted = true;
      this.log(`  [auth] !!! BROKER AUTH FAILED ${this.failures} times in a row (${why}). No orders are sent until a call succeeds again.`);
      this.journal({ type: 'auth', code: 'AUTH_FAILED', t: this.now(), failures: this.failures, why });
      try { this.alert(this.failures, why); } catch (e) { /* the alert path must never break the loop */ }
    }
  }
  noteSuccess() {
    if (!this.failing && !this.failures) return;
    const was = this.failures; this.failures = 0; this.failing = false; this.lastError = null;
    if (this.alerted) { this.alerted = false; this.log(`  [auth] broker auth OK again (after ${was} failure(s)).`); this.journal({ type: 'auth', code: 'AUTH_OK', t: this.now(), failuresBefore: was }); }
  }
  blocksOrders() { return this.failing; }
  dueForRefresh() { return this.issuedAt != null && this.refreshHours > 0 && this.now() - this.issuedAt >= this.refreshHours * 3600000; }
  async maybeProactive() { return this.dueForRefresh() ? this.refresh(`proactive: token ${(((this.now() - this.issuedAt) / 3600000)).toFixed(1)} h old`) : null; }
  view() {
    return { ok: !this.failing, failing: this.failing, failed: this.failures >= this.alertAfter, failures: this.failures, lastError: this.lastError,
      issuedAt: this.issuedAt, nextRefreshAt: this.issuedAt != null ? this.issuedAt + this.refreshHours * 3600000 : null, refreshHours: this.refreshHours,
      lastRefresh: this.lastRefresh, refreshes: this.refreshes, retries: this.retries, recoveredOrders: this.recoveredOrders };
  }
}

// Did an Order/place that answered 401 still reach the broker? Re-reads with the NEW token. Returns { found, order } or { unknown:true }.
// Match = same contract, type, side, size and price (limit/stop), and (Order/search only) created at/after the call started minus 5 s.
function orderMatches(o, body) {
  if (!o) return false;
  const eq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);
  return o.contractId === body.contractId && Number(o.type) === Number(body.type) && Number(o.side) === Number(body.side) && Number(o.size) === Number(body.size)
    && (body.limitPrice == null || eq(o.limitPrice, body.limitPrice)) && (body.stopPrice == null || eq(o.stopPrice, body.stopPrice));
}
async function findPlacedOrder(rawFetch, token, body, startedAt) {
  let openOk = false;
  try {
    const d = await rawFetch('/api/Order/searchOpen', { accountId: body.accountId }, token);
    if (d && d.success !== false && Array.isArray(d.orders)) { openOk = true; const o = d.orders.find(x => orderMatches(x, body)); if (o) return { found: true, order: o, via: 'searchOpen' }; }
  } catch (e) { /* unreadable */ }
  // A MARKET order (or a limit that filled at once) is no longer open: look at the recent order history too.
  try {
    const d = await rawFetch('/api/Order/search', { accountId: body.accountId, startTimestamp: new Date(startedAt - 5000).toISOString() }, token);
    if (d && d.success !== false && Array.isArray(d.orders)) {
      const o = d.orders.find(x => orderMatches(x, body) && (!x.creationTimestamp || Date.parse(x.creationTimestamp) >= startedAt - 5000));
      return o ? { found: true, order: o, via: 'search' } : { found: false };
    }
  } catch (e) { /* unreadable */ }
  // Order history unreadable: an open-order "no match" proves nothing (a MARKET order, or the state machine's marketable LIMIT exits, fill at once),
  // so NO retry: the caller sees the failure and the bot's position/order reconciliation decides from the broker's real state.
  void openOk;
  return { unknown: true };
}

module.exports = { BrokerAuth, findPlacedOrder, orderMatches };
