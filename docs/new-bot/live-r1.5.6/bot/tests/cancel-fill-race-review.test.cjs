#!/usr/bin/env node
'use strict';
// Offline synthetic correctness regression. Fake broker uses explicitly hypothesized safety contract.
// A failed assertion exits nonzero; this is not a live adapter or provider guarantee.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const localParent = path.resolve(__dirname,'..');
const root = localParent;
const L = require(path.join(root, 'lib/tideLive.js'));
const T = require(path.join(root, 'lib/tideOrders.js'));
const M = require(path.join(root, 'lib/moneyRule.js'));
const W = require(path.join(root, 'lib/tideWire.js'));
const S = require(path.join(root, 'lib/structure.js'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-r156-'));
let n = 0, passed = 0; const failures = [], observations = [];
function check(ok, name, detail) { if (ok) passed++; else failures.push({name, detail}); }
const clone = x => JSON.parse(JSON.stringify(x));
const contract = {version:'tide-safety-r1', reduceOnlyAtExecution:true, atomicStopAmend:true, uniqueClientTag:true, terminalLookupByTag:true};
function cfg(extra = {}) { const c = clone(M.DEFAULTS); Object.assign(c.sizing, {enabled:true, flatDollars:400, noFit:'take1', nearFloor:{enabled:false,cushionUsd:1000,dollars:200}}, extra); return {...c, pointValue:2, tickSize:0.25}; }
function broker() {
  const b = {q:0, px:1000, next:0, all:new Map(), calls:[], pending:[], clock:1000000, slow:0, hide:new Set(), defer:null,maxStops:0,beforeAmend:null};
  function fill(x, requested, px) {
    let q = Math.min(requested, x.size - x.fillVolume), d = x.side === 0 ? 1 : -1;
    if (x.reduceOnly) q = b.q*d < 0 ? Math.min(q,Math.abs(b.q)) : 0;
    if (q) { x.filledPrice = ((x.filledPrice||0)*x.fillVolume + px*q)/(x.fillVolume+q); x.fillVolume += q; b.q += d*q; }
    if (x.fillVolume === x.size || x.reduceOnly && b.q*d >= 0) x.status = x.fillVolume === x.size ? 2 : 3;
  }
  function accept(body) {
    const existing = [...b.all.values()].find(x=>x.customTag===body.customTag); if (existing) return existing.id;
    const x = {...body,id:++b.next,status:1,fillVolume:0,filledPrice:null}; b.all.set(x.id,x);b.maxStops=Math.max(b.maxStops,[...b.all.values()].filter(x=>x.type===4&&x.status===1).length);
    if (x.type===2) fill(x,x.size,b.px); return x.id;
  }
  b.api = {
    OrderType:{LIMIT:1,MARKET:2,STOP:4}, OrderSide:{BUY:0,SELL:1}, safetyContract:{...contract},
    async placeOrder(_token,body) { b.calls.push({op:'place',...body}); if(b.defer&&b.defer(body)){b.pending.push(clone(body));throw new Error('response uncertain');} return {success:true,orderId:accept(body)}; },
    async amendStop(_token,body) { b.calls.push({op:'amend',...body});if(b.beforeAmend)await b.beforeAmend(body);const x=b.all.get(body.orderId); if(!x||x.status!==1){const e=new Error('terminal');e.orderRejected=true;throw e;} x.size=x.fillVolume+body.remainingQty;x.stopPrice=body.stopPrice;return {success:true,orderId:x.id}; },
    async lookupByTag(_token,_a,_c,tag) { b.calls.push({op:'lookup',tag}); const x=[...b.all.values()].find(x=>x.customTag===tag&&!b.hide.has(tag));return x?clone(x):null; },
    async cancelOrder(_token,_a,id) { b.calls.push({op:'cancel',id});const x=b.all.get(id);if(x&&x.status===1){x.status=3;return true;}return false; },
    async getOpenPosition() { b.calls.push({op:'position'});b.clock+=b.slow;b.slow=0;return b.q?{size:Math.abs(b.q),type:b.q>0?1:2,averagePrice:1000}:null; },
    async getOpenOrders() { b.calls.push({op:'orders'});return [...b.all.values()].filter(x=>x.status===1&&!b.hide.has(x.customTag)).map(x=>({...x,size:x.size-x.fillVolume})); },
    async getEntryOrder(_token,_a,_c,id) { b.calls.push({op:'history',id}); const x=b.all.get(id); if(!x||b.hide.has(x.customTag))throw new Error('not yet visible');return clone(x); }
  };
  b.tick = px => {b.px=px;for(const x of b.all.values())if(x.status===1){const hit=x.type===4?(x.side===0?px>=x.stopPrice:px<=x.stopPrice):x.type===1?(x.side===0?px<=x.limitPrice:px>=x.limitPrice):false;if(hit)fill(x,x.size-x.fillVolume,x.type===4?x.stopPrice:x.limitPrice);}};
  b.deliver=()=>{for(const body of b.pending.splice(0))accept(body);};b.fill=fill;
  b.liveStops=()=>[...b.all.values()].filter(x=>x.type===4&&x.status===1);
  b.places=()=>b.calls.filter(x=>x.op==='place'); return b;
}
function driver(b, opts={}) {
  const file=opts.file||path.join(temp,`${++n}.json`), rows=[], money=opts.money||cfg();
  return {file,rows,d:L.create({token:'offline',accountId:1,contractId:'synthetic',orders:b.api,cfgFn:()=>money,stateFile:file,now:()=>b.clock,sleep:async()=>{},preCheck:opts.preCheck,journal:x=>rows.push(x),take1MaxFn:()=>400})};
}
const signal=(riskMult=1,htf='against')=>({dir:1,entry:1000,riskMult,htf,pools:[{price:1020,name:'pool'},{price:1060,name:'far',major:true}]});
const plan=(stop=980,grade='A+')=>({stop,grade,entryType:'MARKET'});
async function test(name,fn){try{await fn();}catch(e){failures.push({name,error:e.stack});}}const assert=require('assert');
async function runCase(kind, dir) {
  const b=broker(), rawCancel=b.api.cancelOrder, rawHistory=b.api.getEntryOrder, rawPlace=b.api.placeOrder;let victim=null, after=false, reads=0;
  b.api.placeOrder=async(t,body)=>{ if(body.type===2 && body.reduceOnly) { b.calls.push({op:'blocked-close'}); const e=new Error('synthetic close delayed');throw e; }return rawPlace(t,body); };
  b.api.cancelOrder=async(t,a,id)=>{if(id===victim&&!after){const order=b.all.get(id);b.fill(order,kind==='entry-full'?order.size:1,1000);const result=await rawCancel(t,a,id);after=true;return result;}return rawCancel(t,a,id);};
  b.api.getEntryOrder=async(t,a,c,id,ts)=>{if(after&&id===victim){reads++;if(reads===2)throw new Error('synthetic second history failure');}return rawHistory(t,a,c,id,ts);};
  const isEntry=kind.startsWith('entry'), x=driver(b,{money:cfg({maxContracts:3})}), p=isEntry?{...plan(dir===1?980:1020),entryType:'LIMIT'}:plan(dir===1?980:1020), sig={...signal(),dir,pools:[{price:1000+20*dir,name:'pool'},{price:1000+60*dir,name:'far',major:true}]};await x.d.signal(sig,p,'case-'+kind+'-'+dir);
  const order=Object.values(x.d.state().pos.orders).find(o=>o.kind===(isEntry?'entry':'tp1'));assert(order,'missing victim order');
  victim=x.d.state().ids[order.key];assert(victim!=null,'missing fake order ID');
  if(isEntry){b.clock+=L.ENTRY_EXPIRE_MS+1;await x.d.poll({lastPx:1000});} else await x.d.exitAtMarket('synthetic');
  assert(after&&reads>=1,'did not exercise the terminal cancellation read');
  const report=(label,d)=>{const st=d.state(),o=st.pos&&st.pos.orders[order.key];const retained=!!o&&((o.filled||0)>=1 || (['sent','unknown','working','cancel-sent'].includes(o.status)&&d.owned()));return {label,retained,filled:o&&o.filled,status:o&&o.status,owned:d.owned(),phase:d.phase(),brokerQty:b.q,readCount:reads};};
  const first=report('after-cancel',x.d);await x.d.poll({lastPx:1000});const poll=report('after-poll',x.d);
  if(kind==='entry-full') { assert.strictEqual(first.filled,3); assert.strictEqual(first.brokerQty,3*dir); assert.strictEqual(b.liveStops().length,1,'full fill must receive a protective stop in the fake model'); }
  const y=driver(b,{file:x.file});await y.d.start();await y.d.poll({lastPx:1000});const restart=report('after-restart',y.d);
  console.log(JSON.stringify({case:kind,first,poll,restart}));
  assert(first.retained&&poll.retained&&restart.retained,'terminal cancel lost partial fill or released unresolved ownership');
}
(async()=>{let fail=0;try {for(const k of ['entry','entry-full','target'])for(const dir of [1,-1]){try{await runCase(k,dir);console.log('PASS '+k+' '+dir);}catch(e){fail++;console.log('FAIL '+k+' '+dir+': '+e.message);}}}finally{fs.rmSync(temp,{recursive:true,force:true});}console.log(`cancel-fill race: ${fail} failing case(s)`);if(fail)process.exitCode=1;})();
