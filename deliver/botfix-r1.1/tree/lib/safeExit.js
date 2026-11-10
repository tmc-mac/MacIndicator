'use strict';
// bf-exitsafe: the ONE rule every market exit follows when its outcome is not proven (lib/liveStateMachine.js sessionFlatten: the 13:05 PT session close,
// the morning-hold close, the no-progress exit (np1), the level-loss exit (exit 5); and the filled-through-stop exit).
//
//   * a broker reply that says success:false (err.orderRejected === true) is a REJECTION: nothing was done at the broker;
//   * anything else (timeout, lost reply, transport error, malformed body) is UNKNOWN: the order may have been accepted and filled.
//
// On UNKNOWN nothing is sent and no stop is put back until the broker's position and working orders have been read until they agree with each other on
// consecutive reads (settle()). The verdict decides what happens next (see BF-EXITSAFE.md for the state diagram):
//   flat      -> done: leftovers swept, journaled
//   same      -> the exit did not happen: protection back, the exit may be retried (at most EXIT_MAX_ATTEMPTS sends in total)
//   mismatch  -> same side, a different size: protect the real size, HALT, alert
//   opposite  -> HALT, alert (nothing of ours can protect it; no new order on an unexplained position)
//   unsettled -> the reads never agreed within N: HALT, alert, nothing placed
//
// N = SETTLE_MAX_MS = 20 s: the broker HTTP timeout is 15 s, so an order whose reply was lost can still be processed for a few seconds after the timeout;
//   20 s of reads covers that tail and stays far inside the 13:05 -> 13:08 PT Topstep window. Reads are 1 s apart.
// "flat" needs 2 agreeing reads (a wrong "flat" sends nothing). "same" needs SAME_MIN_READS agreeing reads (spanning >= 5 s) with NO working order on
// the contract, because a wrong "same" (a lagging position read) is what turns a retry into a reversal (QA D5).
// K = EXIT_MAX_ATTEMPTS = 3 market sends per exit (rejected or unknown-then-still-open): a broker that refuses a market exit three times, with backoff, is not
//   a transient fault; Mac has to act. 3 sends + backoff + settles fit in about a minute, before Topstep's own 13:08 PT flatten.
const SETTLE_MAX_MS = 20000;
const SETTLE_READ_MS = 1000;
const SAME_MIN_READS = 6;            // 6 agreeing reads 1 s apart = 5 s of a stable "still open, nothing working"
const FLAT_MIN_READS = 2;
const EXIT_MAX_ATTEMPTS = 3;
const REJECT_BACKOFF_MS = [0, 10000]; // before retry n (n = 1, 2): the next poll, then >= 10 s after the 2nd rejection
const FLATTEN_STUCK_MS = 60000;       // an accepted exit still not flat after this long: one urgent alert (no new order)

function classifyExitError(e) { return e && e.orderRejected === true ? 'rejected' : 'unknown'; }
function signedNet(pos) { if (!pos || !pos.size) return 0; return pos.type === 1 ? pos.size : pos.type === 2 ? -pos.size : NaN; }
function ordersKey(orders) { return (orders || []).map(o => String(o && o.id)).sort().join(','); }
function backoffMs(rejections) { const i = rejections - 1; return i < 0 ? 0 : REJECT_BACKOFF_MS[Math.min(i, REJECT_BACKOFF_MS.length - 1)]; }

// Reads position + working orders until they agree. dir = the side that was being closed (1 / -1), size = the size the exit was sent for.
// io: { readPos, readOrders, sleep } ; opts: { readMs, maxReads, sameMinReads, flatMinReads }. Never throws; read failures break the agreement.
async function settle(io, dir, size, opts = {}) {
  const readMs = opts.readMs ?? SETTLE_READ_MS;
  const maxReads = opts.maxReads ?? Math.max(FLAT_MIN_READS, Math.ceil(SETTLE_MAX_MS / Math.max(1, SETTLE_READ_MS)));
  const sameMin = opts.sameMinReads ?? SAME_MIN_READS, flatMin = opts.flatMinReads ?? FLAT_MIN_READS;
  const reads = [];
  let prev = null, streak = 0, last = null;
  for (let i = 0; i < maxReads; i++) {
    if (i > 0 && readMs > 0) await io.sleep(readMs);
    let net, orders;
    try { net = signedNet(await io.readPos()); orders = await io.readOrders(); if (!Array.isArray(orders) || !Number.isFinite(net)) throw new Error('malformed read'); }
    catch (e) { reads.push({ err: e && e.message }); prev = null; streak = 0; continue; }
    const key = net + '|' + ordersKey(orders);
    streak = key === prev ? streak + 1 : 1; prev = key; last = { net, orders };
    reads.push({ net, orders: orders.length });
    if (net === 0) { if (streak >= flatMin) return { verdict: 'flat', net, orders, reads }; continue; }
    if (Math.sign(net) !== dir) { if (streak >= flatMin) return { verdict: 'opposite', net, orders, reads }; continue; }
    if (Math.abs(net) !== size) { if (streak >= flatMin && orders.length === 0) return { verdict: 'mismatch', net, orders, reads }; continue; }
    if (orders.length === 0 && streak >= sameMin) return { verdict: 'same', net, orders, reads };   // a working order may be our exit still in flight: keep reading
  }
  return { verdict: 'unsettled', net: last ? last.net : null, orders: last ? last.orders : null, reads };
}

// Does the order history show our market exit as live or filled? rows = searchOrdersSince(); side = the closing side (OrderSide), type 2 = MARKET.
// Field names and codes (r1.1, verified - see BF-R11.md): ProjectX Gateway /api/Order/search returns orders[] with id, accountId, contractId,
// creationTimestamp, updateTimestamp, status, type, side, size, limitPrice, stopPrice, fillVolume, filledPrice. OrderStatus: 0 None, 1 Open, 2 Filled,
// 3 Cancelled, 4 Expired, 5 Rejected, 6 Pending. OrderType 2 = Market. OrderSide 0 = Bid (buy), 1 = Ask (sell). The same names are already read by
// lib/brokerAuth.js orderMatches (type/side/size/creationTimestamp) and the entry-cancel path (status/fillVolume/filledPrice).
// 3 cancelled, 4 expired, 5 rejected = did not act; anything else (working, filled, pending, none) = it may have acted. A row whose time cannot be parsed
// counts (conservative: more halts, never a second exit).
// FAIL SAFE (r1.1): a row in the window whose type, side or status is missing or not an integer means the broker's row shape is not the one verified above,
// so "no matching row" would prove nothing: the answer is then 'unknown' and the caller HALTS (never a second exit). Returns 'none' | 'seen' | 'unknown'.
function exitOrderSeen(rows, { side, size, since }) {
  const DEAD = [3, 4, 5];
  if (!Array.isArray(rows)) return 'unknown';
  const isCode = v => v !== null && v !== undefined && v !== '' && Number.isInteger(Number(v));
  const inWindow = (rows || []).filter(o => o && typeof o === 'object').filter(o => { const t = Date.parse(o.creationTimestamp || o.createdAt || ''); return !Number.isFinite(t) || t >= since - 5000; });
  if (rows.some(o => !o || typeof o !== 'object') || inWindow.some(o => !isCode(o.type) || !isCode(o.side) || !isCode(o.status))) return 'unknown';
  const hit = inWindow.filter(o => Number(o.type) === 2 && Number(o.side) === side && (!Number.isFinite(Number(o.size)) || o.size === null || Number(o.size) === size))
    .filter(o => !DEAD.includes(Number(o.status)));
  return hit.length ? 'seen' : 'none';
}

// r1.1: the one-line rule the executor prints at startup ([exits] ...), from the constants above (so the log can never disagree with the code).
function rulesText() {
  return `safe-exit rule ON for every market exit (session close, morning hold, no-progress, level-loss, filled-through-stop, phone/manual flatten, daily floor, time stop): `
    + `a broker success:false = REJECTED, anything else (timeout, lost reply) = UNKNOWN -> no second order, no stop put back until the position and orders settle `
    + `(N = ${SETTLE_MAX_MS / 1000} s of reads ${SETTLE_READ_MS / 1000} s apart; flat = ${FLAT_MIN_READS} agreeing reads; "still open" = ${SAME_MIN_READS} agreeing reads with nothing working AND the order history showing no live/filled exit); `
    + `K = ${EXIT_MAX_ATTEMPTS} market sends per exit (backoff ${REJECT_BACKOFF_MS.map(x => x / 1000 + ' s').join(', ')}; the count survives restarts). `
    + `HALT (no entries, no orders, urgent push) when: K sends fail, the reads never settle, the broker shows the opposite side or another size, or the order history is unreadable / shows the exit live or filled / has an unrecognised row. `
    + `An accepted exit not flat after ${FLATTEN_STUCK_MS / 1000} s: one urgent alert, no second order.`;
}

module.exports = { exitOrderSeen, rulesText, SETTLE_MAX_MS, SETTLE_READ_MS, SAME_MIN_READS, FLAT_MIN_READS, EXIT_MAX_ATTEMPTS, REJECT_BACKOFF_MS, FLATTEN_STUCK_MS, classifyExitError, signedNet, settle, backoffMs };
