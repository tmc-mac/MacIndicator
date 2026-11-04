#!/usr/bin/env node
'use strict';
// Offline inspectHold review against a fake broker. No historical market data.
// Run from this bot directory: node tests/tide-inspect-review.test.cjs
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
// Read-only inspection: exact evidence never clears the hold or sends orders.
const assert = require('assert');
(async () => {
  const B = broker(), getHistory = B.api.getEntryOrder; let edit = x => x, reads = 0;
  B.api.getEntryOrder = async (...args) => { reads++; return edit(await getHistory(...args)); };
  const { D, file } = drv(B); await D.signal(sig(30), plan(30), 'inspect-test');
  const state = D.state(), key = Object.keys(state.ids).find(k => state.pos.orders[k].kind === 'entry');
  const id = state.ids[key], tag = 'inspect-fake-tag';
  B.hist.get(id).customTag = tag;
  state.dispatch = { key, kind: 'entry', reason: 'test hold', at: Date.now(), customTag: tag };
  fs.writeFileSync(file, JSON.stringify(state));
  const beforeState = JSON.parse(JSON.stringify(state.dispatch)), beforeFile = fs.readFileSync(file, 'utf8'), beforeOrders = B.reqs.length;
  const verifyHeld = async () => {
    assert.deepStrictEqual(D.state().dispatch, beforeState, 'hold changed');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), beforeFile, 'state file changed');
    assert(D.owned()); assert.strictEqual(D.phase(), 'UNKNOWN'); assert.strictEqual(D.view().blocked, 'broker-state-unknown');
    assert.strictEqual(D.view().position.phase, 'UNKNOWN'); assert.strictEqual(D.view().position.brokerState, 'unknown');
    await D.poll({ lastPx: 28000 }); assert.strictEqual(B.reqs.length, beforeOrders, 'order submitted');
  };
  for (const [name, change] of [
    ['exact', x => x],
    ['wrong id', x => ({...x,id:id+1})], ['missing id', x => { delete x.id; return x; }],
    ['wrong account', x => ({...x,accountId:2})], ['missing account', x => { delete x.accountId; return x; }],
    ['wrong contract', x => ({...x,contractId:'other'})], ['missing contract', x => { delete x.contractId; return x; }],
    ['wrong tag', x => ({...x,customTag:'other'})], ['missing tag', x => { delete x.customTag; return x; }]
  ]) {
    edit = change; const r = await D.inspectHold(); assert.strictEqual(r.status, name === 'exact' ? 'order-observed' : 'identity-unverified', name);
    if (name === 'exact') assert.strictEqual(r.orderId, id); await verifyHeld(); console.log('PASS ' + name);
  }
  edit = () => { throw new Error('unavailable'); }; const unavailable = await D.inspectHold();
  assert.strictEqual(unavailable.status, 'history-unavailable'); await verifyHeld(); console.log('PASS history unavailable');
  edit = x => x; const priorTag = state.dispatch.customTag; delete state.dispatch.customTag;
  const noTag = await D.inspectHold(); assert.strictEqual(noTag.status, 'order-observed-untagged'); assert.strictEqual(noTag.customTag, null);
  assert(D.owned()); assert.strictEqual(D.phase(), 'UNKNOWN'); assert.strictEqual(B.reqs.length, beforeOrders);
  state.dispatch.customTag = priorTag; await verifyHeld(); console.log('PASS tagless evidence is explicitly untagged');
  const prevKey = state.dispatch.key; delete state.dispatch.key; const noIdReads = reads; const absent = await D.inspectHold();
  assert.strictEqual(absent.status, 'identity-unknown'); assert.strictEqual(reads, noIdReads); assert.strictEqual(B.reqs.length, beforeOrders);
  state.dispatch.key = prevKey; await verifyHeld(); console.log('PASS missing held ID');
  const vm = require('vm'), source = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
  const start = source.indexOf('  function tideSnapshotView() {'), end = source.indexOf('  function tideTagFills(', start);
  assert(start >= 0 && end > start, 'snapshot function unavailable');
  const scope = { CONFIG: {money:{sizing:{}}, tide:{useTimeBlocks:true,openWaitMin:30}},
    tideWire: {modeOf:()=> 'live',VERSION:'fake',gradeUsd:()=>null,take1Max:()=>400,tideBlocks:()=>[]},
    tideLiveOn:()=>true, tideDrv: {view:()=>D.view()}, tideLiveReady:true, tideShadow:null, currentDayKey:'test',
    tideRowsRing:{day:'test',rows:[]},lvj:{day:'test'},tideBoardSafe:()=>null };
  vm.runInNewContext(source.slice(start,end) + '\nthis.snapshot = tideSnapshotView;',scope);
  const held = scope.snapshot(); assert.strictEqual(held.blocked, 'broker-state-unknown'); assert.strictEqual(held.live,false); assert.strictEqual(held.position.phase,'UNKNOWN'); assert.strictEqual(held.position.brokerState,'unknown');
  console.log('PASS hold propagates through executor snapshot');
  scope.tideDrv = null; const absentDriver = scope.snapshot();
  assert.strictEqual(absentDriver.live, false, 'missing live driver reported as live');
  console.log('PASS missing driver is not reported live');
  for (const phase of ['DONE','FLAT']) for (const status of ['sent','unknown','working','cancel-sent']) {
    const malformed = { version: L.VERSION, pos: {phase, orders:{o:{status}}}, ids:{},sentAt:{},pushed:{},ev:0 };
    const body = JSON.stringify(malformed), mb = broker(), mf = path.join(DIR, 'terminal-' + (++fileN) + '.json'); fs.writeFileSync(mf,body);
    const md = drv(mb,{file:mf}).D; assert(md.owned(), `${phase}/${status} lost ownership`); assert.strictEqual(md.phase(),'UNKNOWN');
    await md.start(); await md.poll({lastPx:28000}); assert.strictEqual(mb.reqs.length,0); assert.strictEqual(fs.readFileSync(mf,'utf8'),body);
  }
  console.log('PASS DONE/FLAT with nonterminal orders quarantine');
  for (const phase of ['DONE','FLAT']) {
    const malformed = { version:L.VERSION, pos:{phase,orders:{},open:3,plan:{}}, ids:{},sentAt:{},pushed:{},ev:0 };
    const body=JSON.stringify(malformed), mb=broker(), mf=path.join(DIR,'terminal-open-'+(++fileN)+'.json'); fs.writeFileSync(mf,body);
    const md=drv(mb,{file:mf}).D; assert(md.owned(), `${phase} with open inventory lost ownership`); assert.strictEqual(md.phase(),'UNKNOWN');
  }
  console.log('PASS terminal states with recorded open inventory quarantine');

  for (const phase of ['DONE','FLAT']) for (const order of [{status:'not-a-state'},{}]) {
    const malformed = {version:L.VERSION,pos:{phase,orders:{o:order},open:0},ids:{},sentAt:{},pushed:{},ev:0};
    const body=JSON.stringify(malformed), mb=broker(), mf=path.join(DIR,'bad-status-'+(++fileN)+'.json'); fs.writeFileSync(mf,body);
    const md=drv(mb,{file:mf}).D; assert(md.owned()); assert.strictEqual(md.phase(),'UNKNOWN'); await md.start();
    assert.strictEqual(mb.reqs.length,0); assert.strictEqual(fs.readFileSync(mf,'utf8'),body);
  }
  console.log('PASS terminal states with unknown or missing order status quarantine');
  console.log('inspect review: identity, hold and executor snapshot checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
