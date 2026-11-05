#!/usr/bin/env node
'use strict';
// Local fake only: adversarial lost-placement responses with absent/misleading
// open-order reads. No provider, host, deployment, or publication operations.
const fs=require('fs'),path=require('path'),vm=require('vm');
const fixture=fs.readFileSync(path.join(__dirname,'candidate-safety.test.cjs'),'utf8');
const boundary=fixture.indexOf('(async()=>{');
if(boundary<0)throw new Error('Review fixture boundary');
const tests=`
(async()=>{try{
for(const kind of ['stop','tp1','tp2'])for(const mode of ['deferred','hidden'])await scenario('L '+kind+' '+mode,async()=>{
 const B=safeBroker(),match=b=>b.customTag&&b.customTag.includes(':'+kind+':');
 if(mode==='deferred')B.deferIf=match;
 else B.noAckIf=b=>{if(match(b)){B.hide.add(b.customTag);return true;}return false;};
 const a=drv(B);await a.D.signal(sig(30),plan(30),'lost-'+kind+'-'+mode);
 const request=B.places().find(match);ok(!!request,'lost '+kind+' transport exercised');if(!request)return;
 const tag=request.customTag;
 // A manual order has identical shape but a DIFFERENT durable identity.
 const manual={...request,id:900,customTag:'manual-not-tide',left:request.size};delete manual.req;
 B.book.push(manual);B.hist.set(900,{...manual,status:1,fillVolume:0,filledPrice:null});
 const open=B.api.getOpenOrders;let absentReads=2;
 B.api.getOpenOrders=async(...args)=>absentReads-->0?[]:open(...args);
 // Recreate driver so its captured method observes empty then misleading reads.
 const b=drv(B,{file:a.file});await b.D.start();for(let i=0;i<3;i++)await b.D.poll({lastPx:28000});
 ok(B.places().filter(r=>r.customTag===tag).length===1,'unknown '+kind+' never resubmitted after empty reads and restart');
 ok(B.places().filter(match).length===1,'unknown '+kind+' not duplicated under a replacement key');
 ok(!Object.values(b.D.state().ids).includes(900),'shape-identical manual '+kind+' not adopted');
 ok(!B.reqs.some(r=>r.req==='cancel'&&r.id===900),'manual '+kind+' not cancelled');
 ok(b.D.owned(),'unresolved '+kind+' retains ownership');
 B.deferIf=null;B.noAckIf=null;B.hide.delete(tag);B.deliver();
 for(let i=0;i<4;i++)await b.D.poll({lastPx:28000});
 const actual=[...B.hist.values()].find(h=>h.customTag===tag);
 ok(!!actual&&b.D.state().ids[tag]===actual.id,'late '+kind+' adopted only through exact durable tag');
 ok(B.places().filter(r=>r.customTag===tag).length===1,'late '+kind+' recovery adds no duplicate transport');
 ok(B.places().filter(match).length===1,'late '+kind+' recovery creates no replacement-key duplicate');
 ok(!Object.values(b.D.state().ids).includes(900)&&!B.reqs.some(r=>r.req==='cancel'&&r.id===900),'manual identity remains untouched after recovery');
});
await scenario('L transient read retries never retry transport',async()=>{
 const B=safeBroker(),read=B.api.getOpenPosition;let failures=3,reads=0;
 B.api.getOpenPosition=async(...args)=>{reads++;if(failures-->0)throw new Error('ECONNRESET');return read(...args);};
 const a=drv(B);const answer=await a.D.signal(sig(30),plan(30),'read-retry');
 ok(answer.ok&&reads>=4,'transient position read succeeds after retry budget');
 ok(a.rows.some(r=>r.phase==='live_read_retry_ok'&&r.tries===4),'successful fourth read journaled');
 ok(B.places().filter(b=>!b.reduceOnly).length===1,'read retries produce exactly one entry transport');
 ok(B.places().filter(b=>b.type===T.STOP).length===1&&B.maxStops===1,'read retries produce exactly one protective stop');
});
await scenario('L exhausted read retries refuse entry',async()=>{
 const B=safeBroker();let reads=0;B.api.getOpenPosition=async()=>{reads++;throw new Error('ECONNRESET');};
 const a=drv(B);const answer=await a.D.signal(sig(30),plan(30),'unreadable');
 ok(!answer.ok&&answer.why==='broker-unreadable','unreadable admission refuses signal');
 ok(reads===4,'unreadable admission uses exactly four read tries');
 ok(B.places().length===0,'exhausted read budget sends no transport');
 ok(a.pushes.some(p=>p.startsWith('TIDE URGENT: signal NOT taken')),'exhausted read refusal surfaces notification');
});
console.log(JSON.stringify({pass,fail,fails},null,2));process.exitCode=fail?1:0;
}finally{fs.rmSync(DIR,{recursive:true,force:true});}})()`;
Promise.resolve(vm.runInNewContext(fixture.slice(0,boundary)+tests,{require,console,process,__dirname,setTimeout,clearTimeout})).catch(e=>{console.error(e);process.exitCode=1;});
