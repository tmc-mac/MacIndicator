#!/usr/bin/env node
'use strict';
// Offline lifecycle review against a fake broker. No historical market data.
// Run from this bot directory: node tests/tide-lifecycle-review.test.cjs
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'lib/tideLive.js')), W = require(path.join(ROOT, 'lib/tideWire.js'));
const VERBOSE = process.argv.includes('-v');
const DIR = fs.mkdtempSync(path.join(process.env.TL_TMP || os.tmpdir(), 'tide-live-'));
const T = { LIMIT: 1, MARKET: 2, STOP: 4 }, SD = { BUY: 0, SELL: 1 };

// ---- the fake broker: one contract; MARKET fills at px at once; STOP / LIMIT fill on tick(px); partial(id, q) fills part of a resting order
function broker() {
  const B = { px: 28000, pos: 0, avg: null, book: [], hist: new Map(), id: 500, reqs: [], rejectIf: null, noAckIf: null, cancelFails: new Set(), stopPxShift: 0 };
  const iso = () => new Date().toISOString();
  function fillQty(o, q, px) {
    const s = o.side === SD.BUY ? 1 : -1, before = B.pos, after = before + s * q;
    if (before === 0 || Math.sign(before) === s) B.avg = ((B.avg || 0) * Math.abs(before) + px * q) / Math.abs(after); else if (after !== 0 && Math.sign(after) !== Math.sign(before)) B.avg = px;
    B.pos = after; if (!B.pos) B.avg = null;
    const h = B.hist.get(o.id); const fv = h.fillVolume + q; h.filledPrice = ((h.filledPrice || 0) * h.fillVolume + px * q) / fv; h.fillVolume = fv;
    o.left -= q; if (o.left === 0) { h.status = 2; B.book.splice(B.book.indexOf(o), 1); }
  }
  B.api = {
    OrderType: { LIMIT: 1, MARKET: 2, STOP: 4, TRAILING_STOP: 5 }, OrderSide: SD,
    async placeOrder(token, body) {
      const r = { req: 'place', type: body.type, side: body.side, size: body.size, price: body.type === T.STOP ? body.stopPrice : body.type === T.LIMIT ? body.limitPrice : null, px: B.px };
      B.reqs.push(r);
      if (B.rejectIf && B.rejectIf(body)) { r.result = 'rejected'; const e = new Error('Order/place failed: rejected (fake)'); e.orderRejected = true; throw e; }
      const o = { ...body, id: ++B.id, left: body.size }; if (o.type === T.STOP) o.stopPrice += B.stopPxShift;
      B.hist.set(o.id, { id: o.id, accountId: 1, contractId: 'C', status: 1, type: o.type, side: o.side, size: o.size, fillVolume: 0, filledPrice: null, creationTimestamp: iso() });
      B.book.push(o);
      if (o.type === T.MARKET) fillQty(o, o.size, B.px);
      r.id = o.id;
      if (B.noAckIf && B.noAckIf(body)) { r.result = 'no-ack'; throw new Error('timeout (fake no-ack)'); }
      return { success: true, orderId: o.id };
    },
    async cancelOrder(token, a, id) { B.reqs.push({ req: 'cancel', id }); if (B.cancelFails.has(id)) return false; const o = B.book.find(x => x.id === id); if (!o) return false; B.book.splice(B.book.indexOf(o), 1); B.hist.get(id).status = 3; return true; },
    async getOpenPosition() { return B.pos ? { contractId: 'C', type: B.pos > 0 ? 1 : 2, size: Math.abs(B.pos), averagePrice: B.avg } : null; },
    async getOpenOrders() { return B.book.map(o => ({ id: o.id, contractId: 'C', type: o.type, side: o.side, size: o.left, stopPrice: o.stopPrice, limitPrice: o.limitPrice })); },
    async getEntryOrder(token, a, c, id) { const h = B.hist.get(id); if (!h) throw new Error('Entry history missing or ambiguous'); return { ...h }; },
  };
  B.tick = px => { B.px = px; for (const o of [...B.book].sort((a, b) => a.id - b.id)) { if (!B.book.includes(o)) continue; const buy = o.side === SD.BUY;
    const hit = o.type === T.STOP ? (buy ? px >= o.stopPrice : px <= o.stopPrice) : o.type === T.LIMIT ? (buy ? px <= o.limitPrice : px >= o.limitPrice) : false;
    if (hit) fillQty(o, o.left, o.type === T.STOP ? o.stopPrice : o.limitPrice); } };
  B.partial = (id, q, px) => { const o = B.book.find(x => x.id === id); fillQty(o, q, px); };
  B.places = () => B.reqs.filter(r => r.req === 'place');
  B.str = () => B.reqs.map(r => r.req === 'cancel' ? `cancel#${r.id}` : `${r.side === 0 ? 'BUY' : 'SELL'} ${r.type === 2 ? 'MKT' : r.type === 4 ? 'STOP' : 'LMT'} ${r.size}${r.price != null ? '@' + r.price : ''}${r.result ? ' (' + r.result + ')' : ''}`);
  return B;
}
let fileN = 0;
const MONEY = (o = {}) => { const d = W.moneyDefaults(); d.sizing.flatDollars = 200; Object.assign(d.sizing, o); return d; };   // the mechanics tests size at $200 (3 MNQ at 30 pts); the SHIPPED $400 is checked in L12h
function drv(B, o = {}) {
  const rows = [], pushes = [], prios = [], ends = [], tp1s = [], file = o.file || path.join(DIR, `s${++fileN}.json`), money = o.money || MONEY();
  const D = L.create({ token: 'fake', accountId: 1, contractId: 'C', orders: B.api, log: VERBOSE ? (m => console.log('     ' + m)) : () => {}, notify: (t, x, op) => { pushes.push(t + ' | ' + x); prios.push(String(op && op.priority)); },
    journal: r => rows.push(r), stateFile: file, sleep: o.sleep || (async () => {}), cfgFn: () => ({ ...W.moneyOnly(money), pointValue: 2, tickSize: 0.25, floorDistanceUsd: o.floor === undefined ? 50000 : o.floor }),
    take1MaxFn: () => W.take1Max({ money }), preCheck: o.preCheck, onEnd: (id, r) => ends.push([id, r]), onTp1: id => tp1s.push(id) });
  return { D, rows, pushes, prios, ends, tp1s, file };
}
// a SHORT at 28000; R = stop pts; pools: TP1 at a pool 1R below, TP2 a major pool >= 2R below
const sig = (stopPts, o = {}) => ({ dir: -1, entry: 28000, pools: [{ price: 28000 - stopPts, name: 'swing L' }, { price: 28000 - 3 * stopPts, major: true, name: 'PDL' }], ...o });
const plan = (stopPts, o = {}) => ({ grade: 'A+', entryType: 'MARKET', stop: 28000 + stopPts, ...o });
const stops = B => B.book.filter(x => x.type === T.STOP);
// Offline review only. RISK indicates a reproduced safety failure; exit 1 while any remains.
// In the delayed-close case the position can remain unprotected while the outcome is held.
// These fake-broker cases do not establish broker-side timing or atomicity guarantees.
const assert = require('assert'); let risks = 0, errors = 0;
async function check(name, fn) { const before = risks; try { await fn(); if (risks === before) console.log('PASS ' + name); } catch (e) { errors++; console.log('FAIL ' + name + ': ' + e.message); } }
function reversal(name, actual) { if (actual !== 0) { risks++; console.log('RISK ' + name + ': signed inventory ' + actual); } else console.log('PASS ' + name + ': flat'); }
(async () => {
  await check('delayed stop and restart', async () => {
    const B = broker(), original = B.api.placeOrder; let delayed, once = true;
    B.api.placeOrder = async (token, body) => { if (once && body.type === T.STOP) { once = false; delayed = body; throw new Error('delayed no-ack'); } return original(token, body); };
    const first = drv(B); await first.D.signal(sig(30), plan(30), 'stop-test'); assert(delayed); assert(first.D.owned());
    assert.strictEqual(typeof delayed.customTag, 'string'); assert(delayed.customTag.length > 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(first.file, 'utf8')).dispatch.customTag, delayed.customTag, 'tag was not persisted before unanswered send');
    const n = B.reqs.length, again = drv(B, { file: first.file }); await again.D.start(); await again.D.poll({ lastPx: 28000 });
    assert(again.D.owned()); assert.strictEqual(again.D.phase(), 'UNKNOWN'); assert.strictEqual(B.reqs.length, n, 'restart resent');
    await original('fake', delayed); assert.strictEqual(stops(B).length, 1); B.tick(28030); assert.strictEqual(B.pos, 0);
  });
  await check('pre-existing ambiguous close and restart', async () => {
    // Synthetic fixture: the current review candidate holds on earlier cancellation,
    // so it cannot reach a normal close send. Model an already-dispatched close
    // independently and verify a restart does not resend it.
    const B = broker(), first = drv(B); await first.D.signal(sig(30), plan(30), 'close-test');
    for (const order of [...B.book]) await B.api.cancelOrder('fake', 1, order.id);
    const delayed = {accountId:1,contractId:'C',type:T.MARKET,side:SD.BUY,size:3,customTag:'delayed-close'};
    const state=first.D.state(); state.dispatch={key:'synthetic-close',kind:'position',op:'flatten',customTag:delayed.customTag,reason:'unanswered dispatch',at:Date.now(),
      request:{type:delayed.type,side:delayed.side,size:delayed.size,limitPrice:null,stopPrice:null}};
    fs.writeFileSync(first.file,JSON.stringify(state)); const n=B.reqs.length, again=drv(B,{file:first.file});
    await again.D.start(); await again.D.poll({lastPx:28000}); assert(again.D.owned()); assert.strictEqual(again.D.phase(),'UNKNOWN'); assert.strictEqual(B.reqs.length,n,'restart resent');
    await B.api.placeOrder('fake',delayed); B.tick(28030); assert.strictEqual(B.pos,0);
  });
  await check('normal flatten remains held awaiting cancellation finality', async () => {
    const B=broker(), {D}=drv(B); await D.signal(sig(30),plan(30),'flatten-hold'); const n=B.reqs.length;
    await D.exitAtMarket('test'); assert(D.owned()); assert.strictEqual(D.phase(),'UNKNOWN'); assert.strictEqual(B.pos,-3);
    assert.strictEqual(B.places().slice(n).filter(x=>x.type===T.MARKET).length,0,'unexpected close dispatch');
  });
  await check('failed stop cancellation witness', async () => {
    const B = broker(), { D } = drv(B); await D.signal(sig(30), plan(30), 'cancel-test');
    B.cancelFails.add(stops(B)[0].id); B.tick(27970); await D.poll({ lastPx: 27970 }); assert.strictEqual(B.pos, -1); B.tick(28030);
    reversal('failed stop cancellation', B.pos);
  });
  await check('target then stop before poll witness', async () => {
    const B = broker(), { D } = drv(B); await D.signal(sig(30), plan(30), 'race-test'); B.tick(27970); B.tick(28030);
    reversal('target and full stop before poll', B.pos);
  });
  await check('invalid JSON and foreign version quarantine', async () => {
    for (const body of ['not json', JSON.stringify({ version: 'unknown' })]) {
      const B = broker(), file = path.join(DIR, 'bad-' + (++fileN) + '.json'); fs.writeFileSync(file, body);
      const { D, pushes } = drv(B, { file }); assert(D.owned()); assert.strictEqual(D.phase(), 'UNKNOWN');
      await D.start(); await D.poll({ lastPx: 28000 }); assert.strictEqual(await D.exitAtMarket('test'), false); assert.strictEqual(D.view().blocked, 'broker-state-unknown');
      assert.strictEqual(B.reqs.length, 0); assert.strictEqual(fs.readFileSync(file, 'utf8'), body); assert(pushes.length > 0);
    }
  });
  await check('truncated same-version state', async () => {
    for (const state of [{ version: L.VERSION }, { version: L.VERSION, pos: { phase: 'OPEN', orders: {} }, ids: {}, sentAt: {}, pushed: {}, ev: 0 }]) {
      const body = JSON.stringify(state), B = broker(), file = path.join(DIR, 'truncated-' + (++fileN) + '.json'); fs.writeFileSync(file, body); const { D } = drv(B, { file });
      if (!D.owned() || D.phase() !== 'UNKNOWN') { risks++; console.log('RISK malformed same-version state accepted without quarantine'); continue; }
      await D.start(); await D.poll({ lastPx: 28000 }); assert.strictEqual(B.reqs.length, 0); assert.strictEqual(fs.readFileSync(file, 'utf8'), body);
    }
  });
  await check('explicit rejection with order ID does not become an acceptance', async () => {
    const B = broker(); let sends = 0; B.api.placeOrder = async () => { sends++; return { success: false, errorCode: 2, errorMessage: 'brackets disabled', orderId: 987 }; };
    const { D } = drv(B); await D.signal(sig(30), plan(30), 'rejection-test'); await D.poll({ lastPx: 28000 });
    assert.strictEqual(sends, 1, 'rejected request was resent'); assert.strictEqual(B.pos, 0); assert.strictEqual(B.book.length, 0);
    const entry = D.state().pos && Object.values(D.state().pos.orders).find(o => o.kind === 'entry');
    assert(!entry || !['working', 'done'].includes(entry.status), 'rejected ID treated as accepted or filled');
  });
  await check('pending response with order ID remains unresolved across restart', async () => {
    const B = broker(); let sends = 0; B.api.placeOrder = async () => { sends++; return { success: false, errorCode: 6, errorMessage: 'pending', orderId: 988 }; };
    const first = drv(B); await first.D.signal(sig(30), plan(30), 'pending-test');
    const again = drv(B, { file: first.file }); await again.D.start(); await again.D.poll({ lastPx: 28000 });
    assert.strictEqual(sends, 1, 'pending request was resent'); assert(again.D.owned(), 'pending request lost ownership'); assert.strictEqual(again.D.phase(), 'UNKNOWN');
  });
  await check('duplicate tag rejection preserves uncertainty of prior order', async () => {
    const B = broker(); let sends = 0; B.api.placeOrder = async () => { sends++; return { success: false, errorCode: 2, errorMessage: 'Duplicate customTag', orderId: 989 }; };
    const first = drv(B); await first.D.signal(sig(30), plan(30), 'duplicate-tag-test');
    const again = drv(B, { file: first.file }); await again.D.start(); await again.D.poll({ lastPx: 28000 });
    assert.strictEqual(sends, 1, 'duplicate response prompted resend'); assert(again.D.owned(), 'duplicate response incorrectly released ownership'); assert.strictEqual(again.D.phase(), 'UNKNOWN');
  });
  await check('duplicate tag error from adapter preserves uncertainty', async () => {
    const B = broker(); let sends = 0; B.api.placeOrder = async () => { sends++; const e = new Error('duplicate customTag'); e.orderRejected = true; throw e; };
    const first = drv(B); await first.D.signal(sig(30), plan(30), 'duplicate-throw-test');
    const again = drv(B, { file: first.file }); await again.D.start(); await again.D.poll({ lastPx: 28000 });
    assert.strictEqual(sends, 1, 'duplicate error prompted resend'); assert(again.D.owned(), 'duplicate error incorrectly released ownership'); assert.strictEqual(again.D.phase(), 'UNKNOWN');
  });
  await check('passive opposite-direction equal-size position is detected', async () => {
    const B = broker(), { D } = drv(B); await D.signal(sig(30), plan(30), 'direction-test'); assert.strictEqual(B.pos, -3);
    B.pos = 3; const n = B.reqs.length; await D.poll({ lastPx: 28000 });
    assert.strictEqual(B.reqs.length, n, 'new order submitted on reversed inventory'); assert.strictEqual(D.phase(), 'UNKNOWN', 'same-size opposite direction not quarantined');
  });
  console.log(`lifecycle review: ${risks} risk(s), ${errors} test error(s)`); if (risks || errors) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
