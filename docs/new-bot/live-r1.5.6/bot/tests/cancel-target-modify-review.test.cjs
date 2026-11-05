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
(async()=>{let fail=0;try{for(const partial of [false,true]){
  const b=broker(),cancel=b.api.cancelOrder;let victim=null, hit=false;
  b.api.cancelOrder=async(t,a,id)=>{if(id===victim&&!hit){hit=true;if(partial)b.fill(b.all.get(id),1,1000);}return cancel(t,a,id);};
  const x=driver(b);await x.d.signal(signal(),plan(),'modify-test');const old=Object.values(x.d.state().pos.orders).find(o=>o.kind==='tp1');victim=x.d.state().ids[old.key];
  old.price+=1;await x.d.poll({lastPx:1000});const p=x.d.state().pos, original=p.orders[old.key];
  const out={partial,hit,oldFilled:original.filled,oldStatus:original.status,block:p.block,open:p.open,brokerQty:b.q,tp1:Object.values(p.orders).filter(o=>o.kind==='tp1').map(o=>({status:o.status,filled:o.filled})),targetWorking:[...b.all.values()].filter(o=>o.status===1&&o.type===1).map(o=>({size:o.size,price:o.limitPrice}))};console.log(JSON.stringify(out));
  if(!hit || original.filled!==(partial?1:0) || original.status!=='cancelled'){fail++;console.log('FAIL target modification fill or cancellation');}else console.log('PASS target modification accounting; replacement blocked='+p.block);
}}finally{fs.rmSync(temp,{recursive:true,force:true});}if(fail)process.exitCode=1;})().catch(e=>{console.error(e);process.exitCode=1});
