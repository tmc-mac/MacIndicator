#!/usr/bin/env node
'use strict';
// Independent offline synthetic review. No historical bars, provider, network,
// original tide2-exec/tide-board witness, deployment, or account operations.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const localParent = path.resolve(__dirname,'..');
const root = path.resolve(process.argv[2] || (fs.existsSync(path.join(localParent,'lib/tideLive.js')) ? localParent : path.join(localParent,'stage2-candidate-de161d8-r0')));
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
async function test(name,fn){try{await fn();}catch(e){failures.push({name,error:e.stack});}}
(async()=>{try{
  const pinnedBaselineHashes={
    'lib/structure.js':'db026ac38e7d304149d94c95be35702b838f1bec46589c8ffe5549753a50b87d',
    'lib/tideWire.js':'0cdfc47e5e1bc417b19ad2f563025ee5ada32148788b1663113e36ab7d7c3f87',
    'lib/moneyRule.js':'46464752b872fa2c9e49f6da605ea0b6b8e8c0f1b52225a29cc25a0f3a9aac7b',
    'lib/tideRebuild.js':'f31f239b99e639e869e8950dca210a671283c464d03efe2507123e39446c9975',
    'lib/journalMeta.js':'8e510ebf799a87e86b9bf57e4be7761fb34ebd381b644123ea4aa307cbe762d7',
    'live-executor.js':'46e3d46ed09e2efab0c32143b55ad6d89ea998b516c113feeecd0853da5a9614'
  };
  for(const [f,pinned] of Object.entries(pinnedBaselineHashes)) {
    const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');check(actual===pinned,`latest baseline byte identity ${f}`);
  }
  check(W.htfAgainstOf({})==='tag'&&S.DEFAULTS.htfAgainst==='tag','tag remains shipped/default mode');
  check(JSON.stringify(W.HTF_MODES)==='["tag","half","skip"]','HTF choices retained');
  for(const h of [-1,0,1])for(const dir of [-1,1])check(S.htfTag({htf:{dir:h}},dir)===(h===0?'neutral':h===dir?'with':'against'),`HTF tag ${h}/${dir}`);
  for(const mode of W.HTF_MODES)check(W.engineCfgOf({tide:{htfAgainst:mode}}).htfAgainst===mode,`wire retains ${mode}`);
  for(const htf of ['with','against','neutral']) await test('tag '+htf,async()=>{const b=broker(),x=driver(b);await x.d.signal(signal(1,htf),plan(),'tag');check(b.q===10,`tag ${htf} unchanged size`);check(x.rows.some(r=>r.event&&r.event.type==='signal'&&r.event.htf===htf&&r.event.riskMult===1),`tag ${htf} journal carried`);});
  for(const mode of ['flat','grade'])for(const grade of ['A+','B','C'])await test(`half ${mode} ${grade}`,async()=>{
    const b=broker(),money=cfg({mode,gradeRiskUsd:{A:400,B:240,C:160}}),x=driver(b,{money});const original=JSON.stringify(money);
    await x.d.signal(signal(0.5),plan(980,grade),'half'); const expected=mode==='flat'?5:grade==='A+'?5:grade==='B'?3:2;
    check(b.q===expected,`half ${mode} ${grade} actual broker quantity`,b.q);check(x.d.state().pos.plan.budgetUsd===(mode==='flat'?200:grade==='A+'?200:grade==='B'?120:80),`half ${mode} ${grade} budget`);
    check(JSON.stringify(money)===original,`half ${mode} ${grade} configuration not mutated`);
  });
  await test('take1 half',async()=>{const b=broker(),x=driver(b);await x.d.signal(signal(.5),plan(850),'one');check(b.q===1,'half retains one MNQ minimum');check(x.d.state().pos.plan.sizeCode==='NO_FIT_TAKE1','half take1 status retained');check(x.d.state().pos.plan.budgetUsd===300,'take1 effective exposure budget equals risk');});
  await test('ceiling half',async()=>{const b=broker(),x=driver(b);const r=await x.d.signal(signal(.5),plan(799.75),'ceiling');check(!r.ok&&r.why==='GRADE_NO_FIT_CEILING'&&b.places().length===0,'half retains unchanged $400 take1 ceiling');});
  for(const ms of [3000,3001])for(const gate of ['changed','throws','allowed'])await test(`slow gate ${ms}/${gate}`,async()=>{
    const b=broker();b.slow=ms;let calls=0;const x=driver(b,{preCheck:()=>{calls++;if(calls===1||gate==='allowed')return null;if(gate==='throws')throw new Error('gate exception');return 'session closed';}});
    const r=await x.d.signal(signal(),plan(),'slow');check(calls===(ms>3000?2:1),`preCheck threshold ${ms}/${gate}`,calls);
    const refuse=ms>3000&&gate!=='allowed';check(r.ok!==refuse,`slow gate result ${ms}/${gate}`,r);check(b.places().filter(x=>!x.reduceOnly).length===(refuse?0:1),`slow gate entry count ${ms}/${gate}`);
    if(refuse)check(x.rows.some(r=>r.phase==='live_precheck_after_slow_read'&&r.ms===ms),`slow gate refusal journal ${gate}`);
  });
  for(const key of ['version','reduceOnlyAtExecution','atomicStopAmend','uniqueClientTag','terminalLookupByTag'])await test('contract '+key,async()=>{const b=broker();b.api.safetyContract[key]=null;const x=driver(b),r=await x.d.signal(signal(),plan(),'blocked');check(!r.ok&&b.calls.length===0,'contract missing '+key+' refuses before broker read');});
  await test('unknown close restart',async()=>{
    const b=broker(),a=driver(b);await a.d.signal(signal(),plan(),'close');const stop=b.liveStops()[0].id;b.defer=x=>x.type===2&&x.reduceOnly;
    await a.d.exitAtMarket('synthetic');const x=driver(b,{file:a.file});await x.d.start();for(let i=0;i<3;i++){await x.d.poll({lastPx:1000});await x.d.exitAtMarket('repeated');}
    check(b.places().filter(x=>x.type===2&&x.reduceOnly).length===1,'unknown close no retransmit across restart');check(x.d.owned()&&b.liveStops().length===1&&b.liveStops()[0].id===stop,'unknown close ownership and stop retained');
    b.defer=null;b.deliver();for(let i=0;i<3;i++)await x.d.poll({lastPx:1000});check(!x.d.owned()&&b.q===0&&b.liveStops().length===0,'unknown close exact-tag terminal recovery completes');
  });
  await test('unknown stop restart',async()=>{
    const b=broker();b.defer=x=>x.type===4;const a=driver(b);await a.d.signal(signal(),plan(),'stop');const x=driver(b,{file:a.file});await x.d.start();for(let i=0;i<3;i++)await x.d.poll({lastPx:1000});
    check(b.places().filter(x=>x.type===4).length===1&&x.d.owned(),'unknown stop no replacement or resend across restart');b.defer=null;b.deliver();for(let i=0;i<3;i++)await x.d.poll({lastPx:1000});check(b.liveStops().length===1&&b.places().filter(x=>x.type===4).length===1,'late unknown stop recovers without second stop');
  });
  await test('valid checkpoint same-id amendment',async()=>{
    const b=broker(),a=driver(b);await a.d.signal(signal(),plan(),'valid');const id=b.liveStops()[0].id;b.tick(1020);await a.d.poll({lastPx:1020});
    check(b.liveStops().length===1&&b.liveStops()[0].id===id,'TP1 uses one same-id stop');const x=driver(b,{file:a.file});check(x.d.state().loadIncident===null,'valid amended checkpoint accepted');await x.d.start();await x.d.poll({lastPx:1020});check(b.places().filter(x=>x.type===4).length===1&&x.d.phase()==='OPEN','valid restart retains one-stop OPEN');
  });
  for(const dir of [-1,1])await test('stop wins deferred close '+dir,async()=>{
    const b=broker(),a=driver(b);const s={...signal(),dir,pools:[{price:1000+dir*20,name:'pool'},{price:1000+dir*60,name:'far',major:true}]};
    await a.d.signal(s,plan(1000-dir*20),'race-close');b.defer=x=>x.type===2&&x.reduceOnly;await a.d.exitAtMarket('test');
    b.tick(1000-dir*20);await a.d.poll({lastPx:b.px});check(b.q===0&&a.d.owned(),'stop wins while unknown close retains ownership '+dir);
    const x=driver(b,{file:a.file});await x.d.start();b.defer=null;b.deliver();for(let i=0;i<3;i++)await x.d.poll({lastPx:b.px});
    check(b.q===0&&!x.d.owned(),'late reducing close cannot reverse stop-wins '+dir);
    check(b.places().filter(x=>x.type===2&&x.reduceOnly).length===1,'stop-wins unknown close never resent '+dir);
    check(b.maxStops===1,'stop-wins maximum one broker stop '+dir);
  });
  for(const dir of [-1,1])await test('TP2 fills during native amendment '+dir,async()=>{
    const b=broker(),a=driver(b);await a.d.signal({...signal(),dir,pools:[{price:1000+dir*20,name:'pool'},{price:1000+dir*60,name:'far',major:true}]},plan(1000-dir*20),'race-amend');const id=b.liveStops()[0].id;
    b.tick(1000+dir*20);b.beforeAmend=async()=>{for(const o of b.all.values())if(o.status===1&&o.type===1)b.fill(o,o.size-o.fillVolume,o.limitPrice);const stop=b.all.get(id);b.fill(stop,stop.size-stop.fillVolume,stop.stopPrice);};
    await a.d.poll({lastPx:b.px});for(let i=0;i<2;i++)await a.d.poll({lastPx:b.px});
    check(b.q===0&&b.maxStops===1,'target-stop race cannot reverse or overlap '+dir);
    check(b.places().filter(x=>x.type===4).length===1&&b.calls.filter(x=>x.op==='amend').every(x=>x.orderId===id),'target-stop race no replacement stop '+dir);
  });
  await test('unknown stop exact tag not shape',async()=>{
    const b=broker();b.defer=x=>x.type===4;const a=driver(b);await a.d.signal(signal(),plan(),'manual-shape');const request=b.places().find(x=>x.type===4);
    const manual={...request,id:900,customTag:'manual-identity',status:1,fillVolume:0,filledPrice:null};delete manual.op;b.all.set(900,manual);
    const x=driver(b,{file:a.file});await x.d.start();for(let i=0;i<3;i++)await x.d.poll({lastPx:1000});
    check(!Object.values(x.d.state().ids).includes(900),'shape-identical manual stop never adopted');check(!b.calls.some(x=>x.op==='cancel'&&x.id===900),'shape-identical manual stop never cancelled');
    check(b.places().filter(x=>x.type===4).length===1,'unknown own stop not resent due manual shape');
  });
  await test('malformed semantic checkpoints',async()=>{
    const b=broker(),a=driver(b);await a.d.signal(signal(),plan(),'seed');const seed=JSON.parse(fs.readFileSync(a.file));
    const cases=[['side',x=>Object.values(x.pos.orders).find(o=>o.kind==='stop').side='INVALID'],['filled exceeds quantity',x=>{const o=Object.values(x.pos.orders).find(o=>o.kind==='entry');o.filled=o.qty+1;}],['unknown stop key',x=>x.pos.stopKey='missing-order'],['invalid flatten phase',x=>x.pos.flat={phase:'BOGUS',orderKeys:[],exits:[]}],['unknown order kind',x=>Object.values(x.pos.orders)[0].kind='BOGUS'],['unknown order type',x=>Object.values(x.pos.orders)[0].orderType='BOGUS'],['stop pointer to entry',x=>x.pos.stopKey=Object.values(x.pos.orders).find(o=>o.kind==='entry').key],['missing order quantity',x=>delete Object.values(x.pos.orders)[0].qty],['invalid planner version',x=>x.pos.version='wrong'],['corrupt history',x=>x.hist.trades=null]];
    for(const [name,edit]of cases){const checkpoint=clone(seed);edit(checkpoint);const bytes=JSON.stringify(checkpoint),file=path.join(temp,`${++n}.json`);fs.writeFileSync(file,bytes);const z=broker(),x=driver(z,{file});const blocked=!!x.d.state().loadIncident;observations.push({checkpoint:name,blocked});check(blocked,`malformed ${name} blocked on load`);if(blocked){await x.d.start();await x.d.poll({lastPx:1000});check(z.calls.length===0&&fs.readFileSync(file,'utf8')===bytes,`malformed ${name} zero calls/evidence preserved`);}}
  });
}finally{
  fs.rmSync(temp,{recursive:true,force:true});
  const hashes={};for(const f of ['lib/tideLive.js','lib/tideOrders.js'])hashes[f]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');
  console.log(JSON.stringify({node:process.version,root,hashes,passed,failed:failures.length,failures,observations},null,2));process.exitCode=failures.length?1:0;
}})();
