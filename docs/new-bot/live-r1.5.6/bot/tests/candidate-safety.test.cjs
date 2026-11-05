#!/usr/bin/env node
'use strict';
// TIDE Stage 2a LIVE tests (MacLive 11/04): lib/tideLive.js + lib/tideOrders.js + lib/tideWire.js against a FAKE lib/liveOrders.js. Every broker request is
// recorded with its order; the tests check the requests themselves (type, side, size, price), never only the planner's intents.
// usage: nice -n 19 node tests/tide-live.test.cjs [-v]      (run from the bot folder)
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'lib/tideLive.js')), W = require(path.join(ROOT, 'lib/tideWire.js')), M = require(path.join(ROOT, 'lib/moneyRule.js'));
const VERBOSE = process.argv.includes('-v');
let pass = 0, fail = 0; const fails = [];
function ok(c, name, extra) { if (c) { pass++; if (VERBOSE) console.log('  ok  ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 900) : '')); } }
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
  const rows = [], pushes = [], ends = [], tp1s = [], file = o.file || path.join(DIR, `s${++fileN}.json`), money = o.money || MONEY();
  const D = L.create({ token: 'fake', accountId: 1, contractId: 'C', orders: B.api, log: VERBOSE ? (m => console.log('     ' + m)) : () => {}, notify: (t, x) => pushes.push(t + ' | ' + x),
    journal: r => rows.push(r), stateFile: file, sleep: async () => {}, cfgFn: () => ({ ...W.moneyOnly(money), pointValue: 2, tickSize: 0.25, floorDistanceUsd: o.floor === undefined ? 50000 : o.floor }),
    take1MaxFn: () => W.take1Max({ money }), preCheck: o.preCheck, onEnd: (id, r) => ends.push([id, r]), onTp1: id => tp1s.push(id) });
  return { D, rows, pushes, ends, tp1s, file };
}
// a SHORT at 28000; R = stop pts; pools: TP1 at a pool 1R below, TP2 a major pool >= 2R below
const sig = (stopPts, o = {}) => ({ dir: -1, entry: 28000, pools: [{ price: 28000 - stopPts, name: 'swing L' }, { price: 28000 - 3 * stopPts, major: true, name: 'PDL' }], ...o });
const plan = (stopPts, o = {}) => ({ grade: 'A+', entryType: 'MARKET', stop: 28000 + stopPts, ...o });
const stops = B => B.book.filter(x => x.type === T.STOP);

// LOCAL SIMULATION ONLY. This contract is implemented by this fake, not asserted of any provider.
const CONTRACT = {version:'tide-safety-r1',reduceOnlyAtExecution:true,atomicStopAmend:true,uniqueClientTag:true,terminalLookupByTag:true};
function safeBroker() {
  const B = {px:28000,pos:0,avg:null,book:[],hist:new Map(),id:500,reqs:[],pending:[],hide:new Set(),amendRequests:new Map(),readFails:false,hideStops:false,beforeAmend:null,beforeClose:null,deferIf:null,noAckIf:null,maxStops:0,lookups:[],rejectIf:null,cancelFails:new Set(),stopPxShift:0,afterAmend:null,beforeCancel:null};
  const count = () => { B.maxStops=Math.max(B.maxStops,B.book.filter(o=>o.type===T.STOP).length); };
  B.fill = (o,q,px) => {
    if (!o || !B.book.includes(o)) return;
    const direction=o.side===SD.BUY?1:-1;
    if(o.reduceOnly) q = B.pos*direction<0 ? Math.min(q,Math.abs(B.pos)) : 0;
    q=Math.min(q,o.left); const h=B.hist.get(o.id);
    if(q>0) { const before=B.pos; B.pos+=direction*q; B.avg=B.pos?(before===0?px:B.avg):null; h.filledPrice=((h.filledPrice||0)*h.fillVolume+px*q)/(h.fillVolume+q); h.fillVolume+=q; o.left-=q; }
    if(o.left===0 || (o.reduceOnly && (B.pos===0 || B.pos*direction>=0))) { h.status=o.left===0?2:3; B.book.splice(B.book.indexOf(o),1); }
  };
  const create = body => {
    const existing=[...B.hist.values()].find(h=>h.customTag===body.customTag); if(existing)return existing.id;
    const o={...body,id:++B.id,left:body.size};if(o.type===T.STOP)o.stopPrice+=B.stopPxShift;
    B.hist.set(o.id,{...o,id:o.id,status:1,fillVolume:0,filledPrice:null}); B.book.push(o);count();
    if(o.type===T.MARKET)B.fill(o,o.left,B.px); return o.id;
  };
  B.api={OrderType:{LIMIT:1,MARKET:2,STOP:4},OrderSide:SD,safetyContract:CONTRACT,
    async placeOrder(token,body){
      if(!body.customTag)throw new Error('FAKE requires exact unique tag');
      const r={req:'place',...body,price:body.type===T.STOP?body.stopPrice:body.type===T.LIMIT?body.limitPrice:null}; B.reqs.push(r);
      if(B.rejectIf&&B.rejectIf(body)){r.result='rejected';const e=new Error('fake rejected');e.orderRejected=true;throw e;}
      if(body.reduceOnly && body.type===T.MARKET && B.beforeClose)await B.beforeClose(body);
      if(B.deferIf && B.deferIf(body)){if(!B.pending.some(x=>x.customTag===body.customTag))B.pending.push({...body});throw new Error('uncertain submission');}
      r.id=create(body); if(B.noAckIf && B.noAckIf(body)){r.result='no-ack';throw new Error('lost response');}return {success:true,orderId:r.id};
    },
    async amendStop(token,body){
      B.reqs.push({req:'amend',...body}); if(B.amendRequests.has(body.requestId))return B.amendRequests.get(body.requestId);
      if(B.rejectIf&&B.rejectIf({...body,type:T.STOP,size:body.remainingQty})){const e=new Error('amend rejected');e.orderRejected=true;throw e;}
      if(B.beforeAmend)await B.beforeAmend(body);
      const o=B.book.find(o=>o.id===body.orderId); if(!o){const e=new Error('terminal order');e.orderRejected=true;throw e;}
      if(body.reduceOnly!==true)throw new Error('amend requires reduceOnly');
      o.left=body.remainingQty;o.size=B.hist.get(o.id).fillVolume+body.remainingQty;o.stopPrice=body.stopPrice;o.reduceOnly=true;
      Object.assign(B.hist.get(o.id),{size:o.size,stopPrice:body.stopPrice});count();
      const answer={success:true,orderId:o.id};B.amendRequests.set(body.requestId,answer);if(B.afterAmend)await B.afterAmend(body);return answer;
    },
    async lookupByTag(token,a,c,key){B.lookups.push(key); if(B.hide.has(key))return null;const h=[...B.hist.values()].find(h=>h.customTag===key);return h?{...h}:null;},
    async cancelOrder(token,a,id){B.reqs.push({req:'cancel',id});if(B.cancelFails.has(id))return false;if(B.beforeCancel)await B.beforeCancel(id);const o=B.book.find(x=>x.id===id);if(!o)return false;B.book.splice(B.book.indexOf(o),1);B.hist.get(id).status=3;return true;},
    async getOpenPosition(){if(B.readFails)throw new Error('position unavailable');return B.pos?{contractId:'C',type:B.pos>0?1:2,size:Math.abs(B.pos),averagePrice:B.avg}:null;},
    async getOpenOrders(){if(B.readFails)throw new Error('orders unavailable');return B.book.filter(o=>!B.hide.has(o.customTag)&&!(B.hideStops&&o.type===T.STOP)).map(o=>({...o,size:o.left}));},
    async getEntryOrder(token,a,c,id){if(B.readFails)throw new Error('history unavailable');const h=B.hist.get(id);if(!h || B.hide.has(h.customTag))throw new Error('history unavailable');return {...h};}
  };
  B.deliver = () => {for(const body of B.pending.splice(0))create(body);};
  B.tick = px=>{B.px=px;for(const o of [...B.book]){const buy=o.side===SD.BUY;const hit=o.type===T.STOP?(buy?px>=o.stopPrice:px<=o.stopPrice):o.type===T.LIMIT?(buy?px<=o.limitPrice:px>=o.limitPrice):false;if(hit)B.fill(o,o.left,o.type===T.STOP?o.stopPrice:o.limitPrice);}};
  B.partial=(id,q,px)=>B.fill(B.book.find(o=>o.id===id),q,px);
  B.str=()=>B.reqs.map(r=>r.req==='cancel'?`cancel#${r.id}`:r.req==='amend'?`AMEND#${r.orderId} ${r.remainingQty}@${r.stopPrice}`:`${r.side===0?'BUY':'SELL'} ${r.type===2?'MKT':r.type===4?'STOP':'LMT'} ${r.size}${r.price!=null?'@'+r.price:''}${r.result?' ('+r.result+')':''}`);
  B.places=()=>B.reqs.filter(r=>r.req==='place');return B;
}
async function scenario(name,fn){console.log(name);try{await fn();}catch(e){ok(false,name+' threw',{message:e.message,stack:e.stack});}}
(async()=>{
await scenario('S1 default fail-closed',async()=>{const B=broker(),{D}=drv(B);const r=await D.signal(sig(30),plan(30),'no-contract');ok(!r.ok&&B.places().length===0,'unattested adapter cannot place entry',r);});
for(const dir of [-1,1])await scenario('S2 ordinary lifecycle '+dir,async()=>{
 const B=safeBroker(),{D}=drv(B);const r=await D.signal(sig(30,{dir,pools:[{price:28000+dir*30,name:'swing'},{price:28000+dir*90,major:true,name:'major'}]}),plan(30,{stop:28000-dir*30}),'life-'+dir);
 ok(r.ok&&B.pos===dir*3&&stops(B).length===1,'entry protected '+dir,{r,pos:B.pos});const id=stops(B)[0]?.id;
 B.tick(28000+dir*30);await D.poll({lastPx:B.px});
 ok(stops(B).length===1&&stops(B)[0].id===id&&stops(B)[0].left===1&&B.maxStops===1,'same-id amend without overlap '+dir,B.reqs);
 B.tick(28000+dir*90);await D.poll({lastPx:B.px});
 ok(B.pos===0&&B.book.length===0&&!D.owned(),'terminal flat '+dir,{pos:B.pos,phase:D.phase(),book:B.book});
 ok(B.places().every(x=>x.customTag)&&B.places().slice(1).every(x=>x.reduceOnly===true),'all placements tagged and closing orders reduce-only '+dir);
});
await scenario('S3 delayed unknown close across restart',async()=>{
 const B=safeBroker(),a=drv(B);await a.D.signal(sig(30),plan(30),'close');const stop=stops(B)[0]?.id;
 B.deferIf=b=>b.type===T.MARKET&&b.reduceOnly;await a.D.exitAtMarket('test');await a.D.poll({lastPx:28000});
 const b=drv(B,{file:a.file});await b.D.start();await b.D.poll({lastPx:28000});await b.D.exitAtMarket('repeat');
 ok(B.places().filter(x=>x.type===T.MARKET&&x.reduceOnly).length===1,'unknown close not submitted twice',B.reqs);
 ok(b.D.owned()&&stops(B).some(x=>x.id===stop),'unknown close remains owned and protected');
 B.deferIf=null;B.deliver();await b.D.poll({lastPx:28000});await b.D.poll({lastPx:28000});
 ok(B.pos===0&&!b.D.owned()&&B.book.length===0,'late close terminal fill settles once',{pos:B.pos,phase:b.D.phase(),book:B.book});
});
await scenario('S4 invisible unknown entry retained and recovered',async()=>{
 const B=safeBroker(),a=drv(B);B.deferIf=b=>!b.reduceOnly;await a.D.signal(sig(30),plan(30),'late-entry');await a.D.poll({lastPx:28000});
 const b=drv(B,{file:a.file});await b.D.start();await b.D.poll({lastPx:28000});
 ok(b.D.owned()&&B.places().length===1,'unproven absent entry remains owned without retry',{phase:b.D.phase(),reqs:B.reqs});
 B.deferIf=null;B.deliver();await b.D.poll({lastPx:28000});await b.D.poll({lastPx:28000});
 ok(B.pos===-3&&stops(B).length===1&&stops(B)[0].left===3,'late exact-tag entry fill recovered and protected',{pos:B.pos,phase:b.D.phase(),book:B.book});
});
await scenario('S5 stop/target fills race native amend',async()=>{
 const B=safeBroker(),{D}=drv(B);await D.signal(sig(30),plan(30),'race');const original=stops(B)[0]?.id;B.tick(27970);
 B.beforeAmend=async()=>{const tp=B.book.find(o=>o.type===T.LIMIT);B.fill(tp,tp.left,tp.limitPrice);const st=stops(B)[0];B.fill(st,st.left,st.stopPrice);};
 await D.poll({lastPx:27970});await D.poll({lastPx:27970});
 ok(B.pos===0&&B.maxStops===1,'concurrent target and oversized stop cannot reverse',{pos:B.pos,maxStops:B.maxStops,reqs:B.reqs});
 ok(B.places().filter(x=>x.type===T.STOP).length===1&&B.reqs.filter(x=>x.req==='amend').every(x=>x.orderId===original),'amend never creates independent stop');
});
await scenario('S6 exit read failure retains protection',async()=>{
 const B=safeBroker(),{D}=drv(B);await D.signal(sig(30),plan(30),'read-fail');const id=stops(B)[0]?.id;B.readFails=true;await D.exitAtMarket('test read failure');
 ok(B.pos===-3&&stops(B).some(x=>x.id===id)&&D.owned(),'read failure cannot remove protective stop',B.reqs);
});
await scenario('S7 missing stop readback is unknown',async()=>{
 const B=safeBroker(),{D,rows}=drv(B);B.hideStops=true;const lookup=B.api.lookupByTag;B.api.lookupByTag=async(...args)=>{const h=await lookup(...args);return h&&h.type===T.STOP?null:h;};
 await D.signal(sig(30),plan(30),'unread-stop');
 ok(B.places().some(r=>r.type===T.STOP)&&D.owned(),'missing readback scenario actually places stop and retains ownership');
 const acks=rows.filter(r=>r.phase==='live_stop_ack');
 ok(!acks.some(r=>Number.isFinite(r.acked)&&r.source!=='broker'),'no requested stop price fabricated as broker ack',acks);
 const p=D.state().pos;ok(!(p&&p.protPx===28030),'unread stop has no asserted protection price',p&&{protPx:p.protPx,phase:p.phase});
});
await scenario('S8 fake reduce-only execution independently verified',async()=>{
 for(const type of [T.MARKET,T.STOP,T.LIMIT]){const B=safeBroker();B.pos=-1;B.avg=28000;const body={accountId:1,contractId:'C',type,side:SD.BUY,size:3,reduceOnly:true,customTag:'reduce-'+type,stopPrice:28030,limitPrice:27970};await B.api.placeOrder('fake',body);if(type!==T.MARKET)B.fill(B.book[0],3,28000);ok(B.pos===0,'reduce-only oversized '+type+' cannot reverse');await B.api.placeOrder('fake',body);ok(B.hist.size===1&&B.pos===0,'tag dedup persists after terminal fill '+type);}
});
await scenario('S9 incomplete and unsupported contracts fail closed',async()=>{
 const cases=[null,{}, {...CONTRACT,version:'other'},...Object.keys(CONTRACT).filter(k=>k!=='version').map(k=>({...CONTRACT,[k]:false}))];
 for(const contract of cases){const B=safeBroker();B.api.safetyContract=contract;const {D}=drv(B);const r=await D.signal(sig(30),plan(30),'contract');ok(!r.ok&&B.places().length===0,'contract refusal '+JSON.stringify(contract));}
 for(const method of ['amendStop','lookupByTag']){const B=safeBroker();delete B.api[method];const {D}=drv(B);const r=await D.signal(sig(30),plan(30),'method');ok(!r.ok&&B.places().length===0,'missing '+method+' refuses entry');}
});
await scenario('S10 rejected native amend performs protected terminal close',async()=>{
 const B=safeBroker(),{D}=drv(B);await D.signal(sig(30),plan(30),'reject-amend');const id=stops(B)[0].id;let protectedAtClose=false;
 B.beforeClose=async body=>{protectedAtClose=stops(B).some(o=>o.id===id)&&B.pos===-1&&body.reduceOnly===true;};
 B.rejectIf=b=>b.type===T.STOP;B.tick(27970);await D.poll({lastPx:27970});
 const closes=B.places().filter(r=>r.type===T.MARKET&&r.reduceOnly);
 ok(protectedAtClose&&closes.length===1&&closes[0].size===1,'two rejected native resizes lead to one still-protected reducing close',B.reqs);
 ok(B.pos===0&&!D.owned()&&B.book.length===0&&B.maxStops===1,'rejected resize exit ends flat without overlap or leftovers');
 const closeIndex=B.reqs.findIndex(r=>r.req==='place'&&r.type===T.MARKET&&r.reduceOnly);const cancelIndex=B.reqs.findIndex(r=>r.req==='cancel'&&r.id===id);
 ok(closeIndex>=0&&cancelIndex>closeIndex,'protective stop cancelled only after market close');
});
await scenario('S11 accepted amendment with lost response/restart',async()=>{
 const B=safeBroker(),a=drv(B);await a.D.signal(sig(30),plan(30),'lost-amend');const id=stops(B)[0].id;let gap;
 B.afterAmend=async()=>{gap=fs.readFileSync(a.file,'utf8');B.hideStops=true;throw new Error('lost amend response');};B.tick(27970);await a.D.poll({lastPx:27970});
 ok(B.reqs.filter(r=>r.req==='amend').length===1&&stops(B)[0]?.id===id,'unknown native amend is single dispatch');
 // Restore the durable crash-point snapshot from inside the accepted amend, before a logical ACK existed.
 fs.writeFileSync(a.file,gap);B.hideStops=false;B.afterAmend=null;const b=drv(B,{file:a.file});await b.D.start();await b.D.poll({lastPx:27970});
 ok(B.reqs.filter(r=>r.req==='amend').length===1&&stops(B).length===1&&stops(B)[0].id===id&&b.D.state().pos.protPx===27999.75,'restart recovers accepted amend without replay',b.D.state().pos);
 B.tick(28000);await b.D.poll({lastPx:28000});ok(B.pos===0&&!b.D.owned(),'recovered amended stop terminal fill closes once');
});
await scenario('S12 uncertain unexecuted amendment not replayed',async()=>{
 const B=safeBroker(),a=drv(B);await a.D.signal(sig(30),plan(30),'pending-amend');const id=stops(B)[0].id;B.beforeAmend=async()=>{throw new Error('unresolved amend transport');};B.tick(27970);await a.D.poll({lastPx:27970});await a.D.poll({lastPx:27970});
 const b=drv(B,{file:a.file});await b.D.start();await b.D.poll({lastPx:27970});
 ok(B.reqs.filter(r=>r.req==='amend').length===1&&B.pos===-1&&stops(B).length===1&&stops(B)[0].id===id,'unresolved amend retained without duplicate or overlap',{reqs:B.reqs,phase:b.D.phase()});
});
await scenario('S13 cancellation racing target fill keeps cumulative history',async()=>{
 const B=safeBroker(),{D,rows}=drv(B);await D.signal(sig(30),plan(30),'cancel-race');let raced=false;
 B.beforeCancel=async id=>{const o=B.book.find(o=>o.id===id);if(!raced&&o&&o.type===T.LIMIT){raced=true;B.fill(o,o.left,o.limitPrice);}};
 await D.exitAtMarket('cancel race');await D.poll({lastPx:28000});
 const filled=rows.filter(r=>r.phase==='live_fill');ok(raced&&B.pos===0&&!D.owned()&&B.book.length===0,'cancel-fill race ends flat without leftovers',{pos:B.pos,phase:D.phase(),reqs:B.reqs});
 ok(filled.some(r=>r.kind==='tp1'&&r.filledQty===2)&&filled.some(r=>r.kind==='position'&&r.filledQty===1),'terminal target history survives cancellation race',filled);
});
await scenario('S14 cancellation racing partial target fill',async()=>{
 const B=safeBroker(),{D,rows}=drv(B);await D.signal(sig(30),plan(30),'partial-cancel');let raced=false;
 B.beforeCancel=async id=>{const o=B.book.find(o=>o.id===id);if(!raced&&o&&o.type===T.LIMIT){raced=true;B.fill(o,1,o.limitPrice);}};
 await D.exitAtMarket('partial cancel race');await D.poll({lastPx:28000});
 const fills=rows.filter(r=>r.phase==='live_fill');ok(raced&&B.pos===0&&!D.owned()&&B.book.length===0,'partial cancellation race settles flat');
 ok(fills.some(r=>r.kind==='tp1'&&r.filledQty===1)&&fills.some(r=>r.kind==='position'&&r.filledQty===2),'partial-fill history accounted before remaining market close',fills);
});
await scenario('S15 partial stop fill then amendment preserves cumulative accounting',async()=>{
 const B=safeBroker(),{D,rows}=drv(B);await D.signal(sig(30),plan(30),'partial-stop');const st=stops(B)[0];B.fill(st,1,st.stopPrice);await D.poll({lastPx:28000});
 if(B.pos!==0){const remaining=stops(B)[0];ok(!!remaining,'partially stopped remainder retains protection');if(remaining)B.fill(remaining,remaining.left,remaining.stopPrice);await D.poll({lastPx:28000});}
 const p=D.state().pos;const exits=Object.values(p.orders).filter(o=>o.kind!=='entry').reduce((sum,o)=>sum+(o.filled||0),0);
 ok(B.pos===0&&!D.owned()&&B.book.length===0&&exits===3,'same broker stop cumulative fills counted exactly once',{pos:B.pos,phase:D.phase(),exits,orders:p.orders});
});
await scenario('S16 three partial stop fills across two native amendments',async()=>{
 const B=safeBroker(),{D}=drv(B);await D.signal(sig(30),plan(30),'triple-partial-stop');const id=stops(B)[0].id;
 for(let remaining=2;remaining>=1;remaining--){const st=stops(B)[0];B.fill(st,1,28032-remaining);await D.poll({lastPx:28000});ok(B.pos===-remaining&&stops(B).length===1&&stops(B)[0].id===id&&stops(B)[0].left===remaining,'partial fill preserves same stop resized to '+remaining,{pos:B.pos,stops:stops(B)});}
 const st=stops(B)[0];B.fill(st,1,28032);await D.poll({lastPx:28000});await D.poll({lastPx:28000});
 const exits=Object.values(D.state().pos.orders).filter(o=>o.kind!=='entry').reduce((sum,o)=>sum+(o.filled||0),0);
 ok(B.pos===0&&!D.owned()&&B.book.length===0&&exits===3&&B.maxStops===1,'three generations account cumulative fills exactly once',{pos:B.pos,phase:D.phase(),exits,orders:D.state().pos.orders});
 ok(B.places().filter(r=>r.type===T.STOP).length===1&&B.reqs.filter(r=>r.req==='amend').length===2,'one stop placement and two native amendments only',B.reqs);
 const exitValue=Object.values(D.state().pos.orders).filter(o=>o.kind!=='entry').reduce((sum,o)=>sum+(o.filled||0)*(o.avgPx||0),0);ok(Math.abs(exitValue-(28030+28031+28032))<1e-7,'cumulative offset preserves differing fill prices across three generations',exitValue);
});
console.log(JSON.stringify({pass,fail,fails},null,2));fs.rmSync(DIR,{recursive:true,force:true});process.exitCode=fail?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
