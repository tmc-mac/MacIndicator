'use strict';
// botfix-B (phone snapshot): an in-memory record of the broker reads the bot ALREADY makes (Account/search, Position/searchOpen, Order/searchOpen through
// lib/liveOrders.js), each with the time the response was received. Display only: nothing here is ever read by an order, a gate, a size or an exit.
// It makes no API call of its own. A failed or unreadable read records nothing, so the last good read and its own time stay (the phone shows the age).
const accounts = new Map();   // accountId -> [{ balance, readAt }] newest last (last 8 reads)
const positions = new Map();  // accountId -> { readAt, list }
const orders = new Map();     // accountId -> { readAt, list }
const fin = v => typeof v === 'number' && Number.isFinite(v);

function noteAccounts(list, t = Date.now()) {
  if (!Array.isArray(list)) return;
  for (const a of list) {
    if (!a || a.id == null || !fin(a.balance)) continue;
    const h = accounts.get(a.id) || []; h.push({ balance: a.balance, readAt: t }); while (h.length > 8) h.shift(); accounts.set(a.id, h);
  }
}
function notePositions(accountId, list, t = Date.now()) { if (accountId != null && Array.isArray(list)) positions.set(accountId, { readAt: t, list: list.slice(0, 50) }); }
function noteOrders(accountId, list, t = Date.now()) { if (accountId != null && Array.isArray(list)) orders.set(accountId, { readAt: t, list: list.slice(0, 200) }); }

// The time of the newest broker read that returned exactly `balance` for this account (the age of the figure the bot shows), or null.
function balanceReadAt(accountId, balance) {
  const h = accounts.get(accountId); if (!h || !fin(balance)) return null;
  for (let k = h.length - 1; k >= 0; k--) if (h[k].balance === balance) return h[k].readAt;
  return null;
}
function positionRead(accountId) { return positions.get(accountId) || null; }
function ordersRead(accountId) { return orders.get(accountId) || null; }
function _reset() { accounts.clear(); positions.clear(); orders.clear(); }

module.exports = { noteAccounts, notePositions, noteOrders, balanceReadAt, positionRead, ordersRead, _reset };
