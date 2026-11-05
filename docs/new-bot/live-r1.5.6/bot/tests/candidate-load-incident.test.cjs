#!/usr/bin/env node
'use strict';
// Offline-only malformed-checkpoint acceptance. Every broker method is a fake;
// this test never uses provider credentials, a host, an installer, or a network.
const fs=require('fs'),path=require('path'),vm=require('vm');
const fixture=fs.readFileSync(path.join(__dirname,'candidate-safety.test.cjs'),'utf8');
const boundary=fixture.indexOf('(async()=>{');
if(boundary<0)throw new Error('Review fixture boundary');
const tests=`
(async()=>{try{
const seed=drv(safeBroker());await seed.D.signal(sig(30),plan(30),'checkpoint-seed');
const valid=JSON.parse(fs.readFileSync(seed.file,'utf8'));
const damaged=(fn)=>{const x=JSON.parse(JSON.stringify(valid));fn(x);return JSON.stringify(x);};
const cases=[
 ['corrupt JSON','{"version":'],
 ['incompatible malformed pos/hist',JSON.stringify({version:'old-incompatible',pos:{plan:{},orders:null},hist:{day:'bad',trades:null,alerts:2},dispatch:{x:null}})],
 ['current empty pos',damaged(x=>x.pos={})],
 ['current nonobject pos',damaged(x=>x.pos='broken')],
 ['current missing pos with owned orders',damaged(x=>x.pos=null)],
 ['current incompatible planner version',damaged(x=>x.pos.version='unsupported-planner')],
 ['current malformed flatten',damaged(x=>x.pos.flat='broken')],
 ['current unsupported flatten phase',damaged(x=>x.pos.flat={phase:'BOGUS',orderKeys:[],exits:[]})],
 ['current unsupported order side',damaged(x=>Object.values(x.pos.orders).find(o=>o.kind==='stop').side='INVALID')],
 ['current unsupported order type',damaged(x=>Object.values(x.pos.orders)[0].orderType='INVALID')],
 ['current unsupported order kind',damaged(x=>Object.values(x.pos.orders)[0].kind='INVALID')],
 ['current fill exceeds quantity',damaged(x=>{const o=Object.values(x.pos.orders)[0];o.filled=o.qty+1;})],
 ['current stop reference missing',damaged(x=>x.pos.stopKey='missing-order')],
 ['current invalid phase',damaged(x=>x.pos.phase='unexpected-phase')],
 ['current terminal phase with open exposure',damaged(x=>x.pos.phase='DONE')],
 ['current missing orders',damaged(x=>x.pos.orders=null)],
 ['current null order record',damaged(x=>x.pos.orders[Object.keys(x.pos.orders)[0]]=null)],
 ['current malformed dispatch',damaged(x=>x.dispatch[Object.keys(x.dispatch)[0]]=null)],
 ['current malformed hist',damaged(x=>x.hist={day:x.hist.day,trades:'broken',alerts:null,orderIds:2})]
];
for(const [label,bytes]of cases)await scenario('I '+label,async()=>{
 const B=safeBroker(),calls=[];
 for(const [name,fn]of Object.entries(B.api))if(typeof fn==='function')B.api[name]=async(...args)=>{calls.push(name);return fn(...args);};
 const file=path.join(DIR,'incident-'+(++fileN)+'.json');fs.writeFileSync(file,bytes);
 const {D}=drv(B,{file});
 const check=(name,fn,predicate=()=>true)=>{try{const value=fn();ok(predicate(value),label+' '+name,value);}catch(e){ok(false,label+' '+name+' threw',e.message);}};
 check('owned retained',()=>D.owned(),v=>v===true);
 check('load incident recorded',()=>D.state().loadIncident,v=>typeof v==='string'&&v.length>0);
 check('fast observable',()=>D.fast(),v=>typeof v==='boolean');
 check('phase observable',()=>D.phase(),v=>typeof v==='string'&&v.length>0);
 check('view observable',()=>D.view(),v=>v&&typeof v==='object'&&v.position===null);
 for(const [name,fn]of [['start',()=>D.start()],['poll',()=>D.poll({lastPx:28000})],['exit',()=>D.exitAtMarket('must refuse')],['signal',()=>D.signal(sig(30),plan(30),'must-refuse')]]){
  try{const r=await fn();ok(name!=='signal'||r&&r.ok===false,label+' '+name+' safely returns');}catch(e){ok(false,label+' '+name+' threw',e.message);}
 }
 check('owned retained after calls',()=>D.owned(),v=>v===true);
 ok(calls.length===0,label+' no broker methods called',calls);
 ok(B.places().length===0,label+' no order transport');
 ok(fs.readFileSync(file,'utf8')===bytes,label+' original checkpoint bytes preserved');
});
await scenario('I valid amended checkpoint resumes instead of locking',async()=>{
 const B=safeBroker(),a=drv(B);await a.D.signal(sig(30),plan(30),'valid-amended');B.tick(27970);await a.D.poll({lastPx:27970});
 ok(Object.values(a.D.state().pos.orders).some(o=>o.status==='superseded'),'positive fixture contains valid superseded generation');
 const b=drv(B,{file:a.file});ok(b.D.state().loadIncident===null,'valid amended checkpoint passes schema validation');
 await b.D.start();await b.D.poll({lastPx:27970});
 ok(b.D.phase()==='OPEN','valid amended checkpoint resumes OPEN');
 const view=b.D.view();ok(view.position&&view.position.open===1&&view.position.stopAcked===27999.75,'resumed live view retains verified one-lot stop');
 ok(B.places().filter(o=>o.type===T.STOP).length===1,'valid restart does not duplicate protective stop');
 B.tick(27910);await b.D.poll({lastPx:27910});ok(!b.D.owned()&&b.D.phase()==='DONE'&&B.pos===0,'resumed valid checkpoint completes exit lifecycle');
 const finishedBytes=fs.readFileSync(a.file,'utf8'),n=B.places().length,c=drv(B,{file:a.file});await c.D.start();await c.D.poll({lastPx:27910});
 ok(c.D.state().loadIncident===null,'valid completed checkpoint passes validation');
 ok(c.D.phase()==='DONE'&&!c.D.owned(),'valid completed checkpoint remains terminal and releases ownership');
 ok(c.D.view().trades.length===1&&B.places().length===n,'completed checkpoint retains result without new transport');
 ok(fs.readFileSync(a.file,'utf8')===finishedBytes,'completed checkpoint observational restart preserves bytes');
});
console.log(JSON.stringify({pass,fail,fails},null,2));process.exitCode=fail?1:0;
}finally{fs.rmSync(DIR,{recursive:true,force:true});}})()`;
Promise.resolve(vm.runInNewContext(fixture.slice(0,boundary)+tests,{require,console,process,__dirname,setTimeout,clearTimeout})).catch(e=>{console.error(e);process.exitCode=1;});
