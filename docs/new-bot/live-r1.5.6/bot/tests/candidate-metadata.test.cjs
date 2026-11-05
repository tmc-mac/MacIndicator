#!/usr/bin/env node
'use strict';
// LOCAL/OFFLINE acceptance only. Reuse the isolated fake fixture, without running
// the safety suite; no provider credentials, adapters, network, or deployment.
const fs = require('fs'), path = require('path'), vm = require('vm');
const fixture = fs.readFileSync(path.join(__dirname, 'candidate-safety.test.cjs'), 'utf8');
const boundary = fixture.indexOf('(async()=>{');
if (boundary < 0) throw new Error('Safety fixture boundary changed; review this harness before running');
const tests = `
(async()=>{
try {
await scenario('M1 recovered exact-tag identity survives next trade and restart',async()=>{
 const B=safeBroker(); B.noAckIf=b=>!b.reduceOnly; const a=drv(B),D=a.D;
 await D.signal(sig(30),plan(30),'metadata-lost-entry'); await D.poll({lastPx:28000}); await D.poll({lastPx:28000});
 const oldEntry=[...B.hist.values()].find(h=>!h.reduceOnly).id;
 ok(D.state().hist.orderIds.includes(String(oldEntry)),'recovered entry ID persisted in history');
 B.tick(28030); await D.poll({lastPx:28030});
 ok(!D.owned()&&D.view().trades.length===1,'recovered entry trade closes once');
 ok(D.view().trades[0].grossUsd===-180&&D.view().trades[0].resultR===-1,'history result uses exact fills');
 B.noAckIf=null; B.px=28000; await D.signal(sig(30),plan(30),'metadata-next-entry');
 ok(D.view().orderIds.includes(String(oldEntry)),'old recovered ID survives new signal');
 ok(D.state().hist.orderIds.filter(id=>id===String(oldEntry)).length===1,'remembered IDs deduplicated');
 const restarted=drv(B,{file:a.file}); await restarted.D.start();
 ok(restarted.D.view().orderIds.includes(String(oldEntry)),'old recovered ID survives restart');
 ok(restarted.D.view().trades.length===1,'completed trade history survives restart');
});
await scenario('M2 recovered native amendment metadata and notification',async()=>{
 const B=safeBroker(),amend=B.api.amendStop; let pending;
 B.api.amendStop=async(...args)=>{pending=args;throw new Error('delayed amendment');};
 const a=drv(B),D=a.D;
 await D.signal(sig(30),plan(30),'metadata-delayed-amend'); B.tick(27970); await D.poll({lastPx:27970});
 for(let i=0;i<3;i++)await D.poll({lastPx:27970});
 ok(!!pending&&D.state().pos.stopNext!==null,'scenario has genuinely unresolved amendment');
 ok(!a.pushes.some(p=>p.startsWith('TIDE stop moved |')),'no confirmed stop-move push before verification');
 await amend(...pending); for(let i=0;i<3;i++)await D.poll({lastPx:27970});
 const view=D.view();
 ok(view.position.stopAcked===27999.75&&D.state().pos.stopNext===null,'recovered stop price verified and generation settled');
 ok(view.position.stopBy==='break-even','recovered stop metadata updated');
 ok(a.pushes.filter(p=>p.startsWith('TIDE stop moved |')).length===1,'recovered amendment sends exactly one stop-move push');
 ok(a.pushes.some(p=>p.startsWith('TIDE stop moved |')&&p.includes('27999.75')),'push contains broker-verified price');
 const restarted=drv(B,{file:a.file}); await restarted.D.start(); await restarted.D.poll({lastPx:27970});
 ok(!restarted.pushes.some(p=>p.startsWith('TIDE stop moved |')),'restart does not duplicate confirmed stop notification');
 ok(B.maxStops===1&&B.pos===-1,'metadata recovery neither overlaps stops nor changes position');
});
await scenario('M3 recovered initial stop emits verified entry plan once',async()=>{
 const B=safeBroker(); B.noAckIf=b=>b.type===T.STOP; const a=drv(B),D=a.D;
 await D.signal(sig(30),plan(30),'metadata-initial-stop');
 ok(!a.pushes.some(p=>p.startsWith('TIDE ENTRY ')),'no protected entry plan asserted before stop verification');
 await D.poll({lastPx:28000}); await D.poll({lastPx:28000});
 ok(D.view().position.stopAcked===28030,'initial stop recovery adopts broker price');
 ok(a.pushes.filter(p=>p.startsWith('TIDE ENTRY ')).length===1,'initial recovered stop produces entry plan once');
 const restarted=drv(B,{file:a.file}); await restarted.D.start(); await restarted.D.poll({lastPx:28000});
 ok(!restarted.pushes.some(p=>p.startsWith('TIDE ENTRY ')),'initial entry notification dedup survives restart');
 ok(B.maxStops===1&&B.pos===-3,'initial stop recovery preserves one stop and position');
});
console.log(JSON.stringify({pass,fail,fails},null,2));process.exitCode=fail?1:0;
} finally {fs.rmSync(DIR,{recursive:true,force:true});}
})()`;
Promise.resolve(vm.runInNewContext(fixture.slice(0,boundary)+tests,{require,console,process,__dirname,setTimeout})).catch(e=>{console.error(e);process.exitCode=1;});
