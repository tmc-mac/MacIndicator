// Thin wrappers around the real order-mutating ProjectX endpoints, matching
// the exact request/response shapes terminal.html already uses successfully
// (OrderType/OrderSide enums, field names) — nothing invented here.
const { ptxFetch } = require('./bars');
const brokerReads = require('./brokerReads');   // botfix-B: display-only record of these reads (time + rows) for the phone snapshot; never read by trading

const OrderType = { LIMIT: 1, MARKET: 2, STOP: 4, TRAILING_STOP: 5 };
const OrderSide = { BUY: 0, SELL: 1 };

async function placeOrder(token, { accountId, contractId, type, side, size, limitPrice, stopPrice }, { preSubmit } = {}) {
  const body = { accountId, contractId, type, side, size };
  if (limitPrice != null) body.limitPrice = limitPrice;
  if (stopPrice != null) body.stopPrice = stopPrice;
  const d = await ptxFetch('/api/Order/place', body, token, { preSubmit });
  if (!d?.success) {
    const e = new Error(`Order/place failed: ${d?.errorMessage || `errorCode ${d?.errorCode}`}`);
    e.orderRejected = d?.success === false; // missing/malformed response is uncertain delivery
    throw e;
  }
  return d;
}

async function cancelOrder(token, accountId, orderId) {
  const d = await ptxFetch('/api/Order/cancel', { accountId, orderId }, token);
  return !!d?.success;
}

async function getAccounts(token) {
  const d = await ptxFetch('/api/Account/search', { onlyActiveAccounts: true }, token);
  try { brokerReads.noteAccounts(d?.accounts); } catch (e) { /* display only */ }
  return d?.accounts || [];
}

// Kept for compatibility — but with more than one active account (e.g. an
// eval account alongside a practice account) this silently picks whichever
// one the API lists first. live-executor.js's --live path uses getAccounts()
// instead and makes you pick explicitly, precisely because guessing here is
// how you'd end up trading the wrong account.
async function getAccount(token) {
  const list = await getAccounts(token);
  return list[0] || null;
}

async function getOpenPosition(token, accountId, contractId) {
  let d;
  try { d = await ptxFetch('/api/Position/searchOpen', { accountId }, token); }
  catch (e) { e.positionUnreadable = true; throw e; }   // tradelog (QA): EVERY failed read (HTTP 500/429, timeout, network) is "unknown", so a Flatten request during an outage is kept, retried and alerted
  // profittrail4: HTTP 200 with success:false, a missing/non-array positions list or a malformed body is UNREADABLE, never "no position". null from this function means a
  // READABLE empty list = flat. Callers treat the throw as UNKNOWN: change nothing, keep every resting order, retry (e.positionUnreadable === true marks this case).
  if (!d || typeof d !== 'object' || d.success === false || !Array.isArray(d.positions)) {
    const e = new Error(`/api/Position/searchOpen -> unreadable response (${d && d.errorMessage ? d.errorMessage : (d && d.success === false ? 'success:false' : 'no positions list')})`);
    e.positionUnreadable = true; throw e;
  }
  try { brokerReads.notePositions(accountId, d.positions); } catch (e) { /* display only */ }
  return d.positions.find(p => p.contractId === contractId) || null;
}

async function getOpenOrders(token, accountId, contractId) {
  const d = await ptxFetch('/api/Order/searchOpen', { accountId }, token);
  // D7 (profittrail3): HTTP 200 with success:false, or a body without an orders array, is UNREADABLE - never an empty list. An empty list means "none of our orders are
  // resting"; every caller (reversal proof, stale-stop sweep, ladder audit, entry guard) must treat a failed read as "unknown" and retry, so this throws like an HTTP error.
  if (!d || typeof d !== 'object' || d.success === false || !Array.isArray(d.orders)) {
    throw new Error(`/api/Order/searchOpen -> unreadable response (${d && d.errorMessage ? d.errorMessage : (d && d.success === false ? 'success:false' : 'no orders list')})`);
  }
  const list = d.orders;
  try { brokerReads.noteOrders(accountId, list); } catch (e) { /* display only */ }
  return contractId ? list.filter(o => o.contractId === contractId) : list;
}

// Terminal history is required: absence from searchOpen is not proof of cancellation.
// ProjectX order-search / realtime OrderStatus: 2 filled, 3 cancelled, 4 expired, 5 rejected.
async function getEntryOrder(token, accountId, contractId, orderId, since) {
  if (!Number.isFinite(since)) throw new Error('Entry timestamp unknown');
  const d = await ptxFetch('/api/Order/search', { accountId, startTimestamp: new Date(since - 60000).toISOString() }, token);
  if (d?.success !== true || !Array.isArray(d.orders)) throw new Error('Order history unreadable');
  const rows = d.orders.filter(o => String(o.id) === String(orderId) && o.accountId === accountId && o.contractId === contractId);
  if (rows.length !== 1) throw new Error('Entry history missing or ambiguous');
  return rows[0];
}

// bf-exitsafe: the account's order HISTORY since `since` for one contract (an independent check, not the position cache): used before a lost-reply exit is
// called "not filled". Throws when unreadable (the caller then treats the outcome as unknown).
async function searchOrdersSince(token, accountId, contractId, since) {
  if (!Number.isFinite(since)) throw new Error('since unknown');
  const d = await ptxFetch('/api/Order/search', { accountId, startTimestamp: new Date(since - 60000).toISOString() }, token);
  if (d?.success !== true || !Array.isArray(d.orders)) throw new Error('Order history unreadable');
  return d.orders.filter(o => o && o.contractId === contractId);
}

module.exports = { OrderType, OrderSide, placeOrder, cancelOrder, getEntryOrder, getAccount, getAccounts, getOpenPosition, getOpenOrders, searchOrdersSince };
