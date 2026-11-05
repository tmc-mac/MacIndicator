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
async function test(name,fn){try{await fn();}catch(e){failures.push({name,error:e.stack});}}const assert=require('assert'), {spawnSync}=require('child_process');
async function worker(kind,file,modelFile,stage) {
  const b=broker(), rawCancel=b.api.cancelOrder, rawPlace=b.api.placeOrder;let victim=null, injected=false;
  b.api.placeOrder=async(t,body)=>{if(body.type===2&&body.reduceOnly){b.calls.push({op:'blocked-close'});throw new Error('synthetic delayed close');}return rawPlace(t,body);};
  b.api.cancelOrder=async(t,a,id)=>{if(id===victim&&!injected){injected=true;b.fill(b.all.get(id),1,1000);}return rawCancel(t,a,id);};
  const d=driver(b,{file}), p=kind==='entry'?{...plan(),entryType:'LIMIT'}:plan();await d.d.signal(signal(),p,'crash-'+kind);
  const order=Object.values(d.d.state().pos.orders).find(o=>o.kind===(kind==='entry'?'entry':'tp1'));victim=d.d.state().ids[order.key];
  const rawSync=fs.fsyncSync;fs.fsyncSync=function(fd){rawSync.call(fs,fd);if(!fs.fstatSync(fd).isDirectory())return;
    let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){return;}
    const evidence=Object.values(state.dispatch||{}).some(x=>x.cancelEvidence);
    if(stage==='before' ? !evidence : evidence || !state.pos || !state.pos.orders[order.key] || state.pos.orders[order.key].filled!==1) return;
    fs.writeFileSync(modelFile,JSON.stringify({q:b.q,px:b.px,next:b.next,clock:b.clock,all:[...b.all.entries()],key:order.key}));
    fs.rmSync(temp,{recursive:true,force:true});process.exit(73);
  };
  if(kind==='entry'){b.clock+=L.ENTRY_EXPIRE_MS+1;await d.d.poll({lastPx:1000});} else await d.d.exitAtMarket('synthetic');
  throw new Error('expected crash boundary was not reached');
}
async function parent() {
  let bad=0;
  for(const [kind,stage] of [['entry','before'],['target','before'],['entry','after']]){
    const file=path.join(temp,kind+'-'+stage+'.json'), model=path.join(temp,kind+'-'+stage+'-broker.json');
    const sub=spawnSync(process.execPath,[__filename,'--worker',kind,file,model,stage],{encoding:'utf8'});
    try {
      assert.strictEqual(sub.status,73,`crash child failed: ${sub.stderr}`);
      const state=JSON.parse(fs.readFileSync(file,'utf8')), saved=JSON.parse(fs.readFileSync(model,'utf8'));
      const ev=state.dispatch[saved.key].cancelEvidence;
      if(stage==='before') {assert(ev&&ev.filledQty===1,'partial fill not durably checkpointed');assert.strictEqual(state.pos.orders[saved.key].filled,0,'crash point after ack, not before');}
      else {assert(!ev,'cancel evidence unexpectedly retained');assert.strictEqual(state.pos.orders[saved.key].filled,1,'ack not applied');assert.strictEqual(saved.q,1);}
      const b=broker();b.q=saved.q;b.px=saved.px;b.next=saved.next;b.clock=saved.clock;b.all=new Map(saved.all);
      const d=driver(b,{file});await d.d.start();let o=d.d.state().pos.orders[saved.key];assert.strictEqual(o.filled,1,'partial fill lost at restart');
      const before=o.filled;await d.d.poll({lastPx:1000});const again=driver(b,{file});await again.d.start();o=again.d.state().pos.orders[saved.key];
      assert.strictEqual(o.filled,before,'fill double-counted or lost on second restart');
      if(stage==='after') {const st=again.d.state(), sk=st.pos && st.pos.stopNext; assert(b.liveStops().length===1,'entry filled but queued protective stop never sent after restart; state='+JSON.stringify({owned:again.d.owned(),phase:again.d.phase(),brokerQty:b.q,stops:b.liveStops().length,stopNext:sk,stopStatus:sk&&st.pos.orders[sk].status,stopDispatch:sk&&st.dispatch[sk],block:st.pos&&st.pos.block}));}
      console.log(`PASS ${kind}/${stage}: durable terminal evidence replayed once after process exit`);
    } catch(e){bad++;console.log(`FAIL ${kind}/${stage}: ${e.message}`);}
  }
  fs.rmSync(temp,{recursive:true,force:true});if(bad)process.exitCode=1;
}
if(process.argv[2]==='--worker')worker(process.argv[3],process.argv[4],process.argv[5],process.argv[6]).catch(e=>{console.error(e);process.exitCode=2}); else parent().catch(e=>{console.error(e);process.exitCode=2});
