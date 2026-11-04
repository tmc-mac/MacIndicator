'use strict';
// Synthetic read-only order-history evidence. No broker or market data.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/tideLive');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-tag-review-'));
const file = path.join(dir, 'state.json');
const h = { key: 'order-k', kind: 'stop', at: 1, customTag: 'synthetic-tag', request: { type: 4, side: 0, size: 3, limitPrice: null, stopPrice: 101 } };
fs.writeFileSync(file, JSON.stringify({ version: L.VERSION, pos: null, ids: {}, sentAt: {}, pushed: {}, ev: 0, dispatch: h }));
const before = fs.readFileSync(file, 'utf8');
let response = { success: true, orders: [] }, searches = 0, writes = 0;
const orders = { OrderType: {}, OrderSide: {}, placeOrder: async () => { writes++; }, cancelOrder: async () => { writes++; }, getOpenPosition: async () => null, getOpenOrders: async () => [], getEntryOrder: async () => null };
const d = L.create({ token: 'fake', accountId: 1, contractId: 'C', orders, stateFile: file, cfgFn: () => ({}), sleep: async () => {}, searchOrderHistory: async () => { searches++; if (response instanceof Error) throw response; return response; } });
const observed = { id: 8, accountId: 1, contractId: 'C', customTag: 'synthetic-tag', type: 4, side: 0, size: 3, stopPrice: 101, status: 1, fillVolume: 0 };
async function check(expected) { const r = await d.inspectHoldByTag(); assert.strictEqual(r.status, expected); assert(d.owned()); assert.strictEqual(d.phase(), 'UNKNOWN'); assert.strictEqual(writes, 0); assert.strictEqual(fs.readFileSync(file, 'utf8'), before); }
(async () => {
  await check('tag-not-observed');
  response = { success: true, orders: [observed] }; await check('tag-observed');
  response = { success: true, orders: [observed, {...observed, id: 9}] }; await check('tag-conflict');
  for (const bad of [{ accountId: 2 }, { contractId: 'X' }, { id: null }, { side: 1 }, { size: 2 }, { stopPrice: 102 }, { limitPrice: 90 }]) {
    response = { success: true, orders: [{ ...observed, ...bad }] }; await check('identity-unverified');
  }
  response = { success: false, orders: [observed] }; await check('history-unavailable');
  response = { success: true, errorCode: 6, orders: [observed] }; await check('history-unavailable');
  response = new Error('offline read failed'); await check('history-unavailable');
  const noSearch = L.create({ token: 'fake', accountId: 1, contractId: 'C', orders, stateFile: file, cfgFn: () => ({}), sleep: async () => {} });
  assert.strictEqual((await noSearch.inspectHoldByTag()).status, 'tag-search-unavailable');
  assert(searches > 0); assert.strictEqual(writes, 0);
  console.log('tag evidence: observations, conflicts, identity and unavailable history pass; hold never cleared');
})().catch(e => { console.error(e); process.exitCode = 1; });
