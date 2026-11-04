#!/usr/bin/env node
'use strict';
// Offline durability review against a fake broker. No historical market data.
// Run from this bot directory: node tests/tide-durable-review.test.cjs
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
// Fault-injected local filesystem + fake broker only. Failures must prevent sends.
const assert = require('assert');
(async () => {
  for (const failAt of ['write', 'file-fsync', 'directory-fsync']) {
    const B = broker(), {D,file} = drv(B), rawWrite = fs.writeFileSync, rawSync = fs.fsyncSync; let injected = false;
    try {
      if (failAt === 'write') fs.writeFileSync = function(fd, data, ...rest) {
        if (typeof fd === 'number' && typeof data === 'string' && data.includes('dispatch pending')) { injected = true; throw new Error('synthetic write failure'); }
        return rawWrite.call(fs,fd,data,...rest);
      };
      if (failAt === 'file-fsync') fs.fsyncSync = function(fd) {
        let text=''; try { text = fs.readFileSync(file + '.tmp-' + process.pid, 'utf8'); } catch (_) {}
        if (text.includes('dispatch pending')) { injected = true; throw new Error('synthetic file fsync failure'); }
        return rawSync.call(fs,fd);
      };
      if (failAt === 'directory-fsync') fs.fsyncSync = function(fd) {
        let text=''; try { text = fs.readFileSync(file, 'utf8'); } catch (_) {}
        if (fs.fstatSync(fd).isDirectory() && text.includes('dispatch pending')) { injected = true; throw new Error('synthetic directory fsync failure'); }
        return rawSync.call(fs,fd);
      };
      try { await D.signal(sig(30),plan(30),'fs-failure'); } catch (_) { /* expected */ }
    } finally { fs.writeFileSync = rawWrite; fs.fsyncSync = rawSync; }
    assert(injected, failAt + ' did not hit the pre-send marker'); assert.strictEqual(B.reqs.length,0,failAt+' allowed a broker request'); assert.strictEqual(B.pos,0);
    console.log('PASS ' + failAt + ' before dispatch causes no broker mutation');
  }
  {
    const B=broker(); let file, captured, capturedTag, sends=0;
    B.api.placeOrder=async (_token,body) => {
      sends++; const durable=JSON.parse(fs.readFileSync(file,'utf8')).dispatch;
      captured={type:body.type,side:body.side,size:body.size,limitPrice:body.limitPrice ?? null,stopPrice:body.stopPrice ?? null}; capturedTag=body.customTag;
      assert.deepStrictEqual(durable.request,captured, 'durable request differs from actual send'); assert.strictEqual(durable.customTag,capturedTag);
      assert.strictEqual(typeof capturedTag,'string'); assert(capturedTag.length>0);
      body.size=999; body.customTag='mutated'; throw new Error('response lost after dispatch');
    };
    const d=drv(B); file=d.file; await d.D.signal(sig(30),plan(30),'immutable-snapshot');
    assert.strictEqual(sends,1); assert.deepStrictEqual(d.D.state().dispatch.request,captured); assert.strictEqual(d.D.state().dispatch.customTag,capturedTag);
    const after=JSON.parse(fs.readFileSync(file,'utf8')).dispatch; assert.deepStrictEqual(after.request,captured); assert.strictEqual(after.customTag,capturedTag);
    assert(d.D.owned()); assert.strictEqual(d.D.phase(),'UNKNOWN'); console.log('PASS immutable request and tag persisted before dispatch');
  }
  {
    const B=broker(), cancel=B.api.cancelOrder; let oldId=null, attempts=0;
    B.api.cancelOrder=async (token,account,id) => { if (id===oldId) { attempts++; throw new Error('cancel response lost, execution delayed'); } return cancel(token,account,id); };
    const first=drv(B); await first.D.signal(sig(30),plan(30),'cancel-lost'); oldId=stops(B)[0].id;
    B.tick(27970); await first.D.poll({lastPx:27970}); assert(attempts>0); assert(first.D.owned()); assert.strictEqual(first.D.phase(),'UNKNOWN');
    const before=B.reqs.length, previousAttempts=attempts, next=drv(B,{file:first.file}); await next.D.start(); await next.D.poll({lastPx:27970});
    assert(next.D.owned()); assert.strictEqual(next.D.phase(),'UNKNOWN'); assert.strictEqual(B.reqs.length,before); assert.strictEqual(attempts,previousAttempts,'cancel retried after restart');
    await cancel('fake',1,oldId); const after=B.reqs.length; await next.D.poll({lastPx:27970});
    assert.strictEqual(B.reqs.length,after,'late cancellation resumed trade'); assert(next.D.owned()); assert.strictEqual(next.D.phase(),'UNKNOWN');
    console.log('PASS unknown cancel remains held after restart and late cancel; position may be unprotected');
  }
  for (const failAt of ['write', 'file-fsync', 'directory-fsync']) {
    const B=broker(), {D,file}=drv(B); await D.signal(sig(30),plan(30),'cancel-durability'); B.tick(27970);
    const n=B.reqs.length, rawWrite=fs.writeFileSync, rawSync=fs.fsyncSync; let injected=false;
    try {
      if (failAt==='write') fs.writeFileSync=function(fd,data,...rest) {
        if (typeof fd==='number' && typeof data==='string' && data.includes('cancellation pending')) {injected=true;throw new Error('synthetic cancellation write failure');}
        return rawWrite.call(fs,fd,data,...rest);
      };
      if (failAt==='file-fsync') fs.fsyncSync=function(fd) {
        let txt='';try{txt=fs.readFileSync(file+'.tmp-'+process.pid,'utf8');}catch(_){}
        if (txt.includes('cancellation pending')) {injected=true;throw new Error('synthetic cancellation file fsync failure');} return rawSync.call(fs,fd);
      };
      if (failAt==='directory-fsync') fs.fsyncSync=function(fd) {
        let txt='';try{txt=fs.readFileSync(file,'utf8');}catch(_){}
        if (fs.fstatSync(fd).isDirectory() && txt.includes('cancellation pending')) {injected=true;throw new Error('synthetic cancellation directory fsync failure');} return rawSync.call(fs,fd);
      };
      try{await D.poll({lastPx:27970});}catch(_){}
    } finally {fs.writeFileSync=rawWrite;fs.fsyncSync=rawSync;}
    assert(injected,failAt+' did not hit pre-cancel marker'); assert.strictEqual(B.reqs.length,n,failAt+' allowed a broker mutation');
    assert.strictEqual(stops(B).length,1); assert.strictEqual(B.pos,-1); console.log('PASS '+failAt+' before cancel causes no broker mutation');
  }
  for (const [name, change] of [
    ['wrong ID', h=>({...h,id:h.id+1})], ['missing ID', h=>{delete h.id;return h;}],
    ['wrong account', h=>({...h,accountId:2})], ['missing account', h=>{delete h.accountId;return h;}],
    ['wrong contract', h=>({...h,contractId:'other'})], ['missing contract', h=>{delete h.contractId;return h;}]
  ]) {
    const B=broker(), history=B.api.getEntryOrder; let oldId=null;
    B.api.getEntryOrder=async (...args) => { const h=await history(...args); return args[3]===oldId ? change({...h,status:3,fillVolume:0}) : h; };
    const first=drv(B); await first.D.signal(sig(30),plan(30),'foreign-terminal'); oldId=stops(B)[0].id; B.cancelFails.add(oldId);
    B.tick(27970); await first.D.poll({lastPx:27970}); assert.strictEqual(B.pos,-1); assert.strictEqual(first.D.phase(),'UNKNOWN',name);
    assert.strictEqual(stops(B).length,1, name+' created a replacement stop'); assert.strictEqual(stops(B)[0].id,oldId);
    const before=B.reqs.length, next=drv(B,{file:first.file}); await next.D.start(); await next.D.poll({lastPx:27970});
    assert(next.D.owned()); assert.strictEqual(next.D.phase(),'UNKNOWN'); assert.strictEqual(B.reqs.length,before); assert.strictEqual(stops(B).length,1); assert.strictEqual(B.pos,-1);
    console.log('PASS foreign terminal cancellation evidence: '+name);
  }
  for (const fill of ['', '   ', false]) {
    const B=broker(), history=B.api.getEntryOrder; let oldId=null;
    B.api.getEntryOrder=async (...args) => { const h=await history(...args); return args[3]===oldId ? {...h,status:3,fillVolume:fill} : h; };
    const d=drv(B); await d.D.signal(sig(30),plan(30),'invalid-fill'); oldId=stops(B)[0].id; B.cancelFails.add(oldId); B.tick(27970); await d.D.poll({lastPx:27970});
    const hold=d.D.state().dispatch; assert(hold); assert.strictEqual(d.D.phase(),'UNKNOWN');
    assert(!hold.observed || hold.observed.fillVolume == null, 'invalid fill volume was reported as numeric zero');
    assert.strictEqual(stops(B).length,1); assert.strictEqual(B.pos,-1);
    console.log('PASS malformed fill volume '+JSON.stringify(fill)+' is not zero');
  }
  console.log('durability review: fault injection and lost cancellation passed');
})().catch(e=>{console.error(e);process.exitCode=1});
