#!/usr/bin/env node
'use strict';
// Latest-version seams only, all synthetic. No host, account, network or historical bars.
const fs=require('fs'),path=require('path'),vm=require('vm');
const fixture=fs.readFileSync(path.join(__dirname,'candidate-safety.test.cjs'),'utf8'),boundary=fixture.indexOf('(async()=>{');
if(boundary<0)throw Error('fixture boundary');
const tests=`
(async()=>{try{
await scenario('R156 six latest source modules preserved',async()=>{
 const crypto=require('crypto');const expected={
 'live-executor.js':'46e3d46ed09e2efab0c32143b55ad6d89ea998b516c113feeecd0853da5a9614',
 'lib/journalMeta.js':'8e510ebf799a87e86b9bf57e4be7761fb34ebd381b644123ea4aa307cbe762d7',
 'lib/tideWire.js':'0cdfc47e5e1bc417b19ad2f563025ee5ada32148788b1663113e36ab7d7c3f87',
 'lib/moneyRule.js':'46464752b872fa2c9e49f6da605ea0b6b8e8c0f1b52225a29cc25a0f3a9aac7b',
 'lib/structure.js':'db026ac38e7d304149d94c95be35702b838f1bec46589c8ffe5549753a50b87d',
 'lib/tideRebuild.js':'f31f239b99e639e869e8950dca210a671283c464d03efe2507123e39446c9975'};
 for(const [file,sha]of Object.entries(expected))ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')===sha,'exact latest '+file);
 const d=W.DEFAULTS.tide,expectedSwitches={staleR:2,laneAccept:true,controlFree:true,nearestWins:false,ltfOpens:false,waveBiasTrend:true,releaseOnRefusal:true,controlAsBias:true,htfAgainst:'tag'};
 ok(Object.entries(expectedSwitches).every(([k,v])=>d[k]===v),'latest strategy/HTF defaults not replaced by earlier design');
 const m=W.moneyDefaults();ok(m.sizing.flatDollars===400&&m.sizing.take1MaxUsd===400&&m.sizing.maxContracts===30&&!m.sizing.nearFloor.enabled,'latest $400/ceiling/max30/near-floor defaults retained');
 ok(d.useTimeBlocks===true&&d.openWaitMin===30&&JSON.stringify(d.blocks)===JSON.stringify([['15:00','17:00'],['06:30','07:10']]),'time-block configuration retained');
});
for(const dir of [-1,1])for(const rm of [undefined,1,0.5])await scenario('R156 actual driver HTF sizing '+dir+' '+rm,async()=>{
 const B=safeBroker(),{D}=drv(B,{money:W.moneyDefaults()});const p=plan(50,{stop:28000-dir*50});
 const r=await D.signal(sig(50,{dir,riskMult:rm,htf:rm===0.5?'against':'with',pools:[{price:28000+dir*50},{price:28000+dir*150,major:true}]}),p,'htf-'+dir+'-'+rm);
 const want=rm===0.5?2:4;ok(r.ok&&Math.abs(B.pos)===want&&D.state().pos.plan.contracts===want,'driver and planner use same adjusted quantity');
 ok(D.state().pos.plan.budgetUsd===(rm===0.5?200:400)&&stops(B).length===1&&stops(B)[0].left===want&&stops(B)[0].stopPrice===p.stop,'budget changes while structural stop stays exact');
});
await scenario('R156 half retains one-MNQ minimum and absolute take1 ceiling',async()=>{
 const A=safeBroker(),a=drv(A,{money:W.moneyDefaults()});const x=await a.D.signal(sig(150,{riskMult:0.5,htf:'against'}),plan(150),'half-one');
 ok(x.ok&&A.pos===-1&&a.D.state().pos.plan.budgetUsd===300&&a.D.state().pos.plan.riskUsd===300,'half $200 with one lot risk $300 remains permitted by existing $400 ceiling');
 const B=safeBroker(),b=drv(B,{money:W.moneyDefaults()});const y=await b.D.signal(sig(201,{riskMult:0.5,htf:'against'}),plan(201),'half-too-wide');
 ok(!y.ok&&y.why==='GRADE_NO_FIT_CEILING'&&B.places().length===0,'half does not bypass absolute $400 take1 ceiling');
});
function clockDriver(B,delay,reject){let time=100000,calls=0;const rows=[],file=path.join(DIR,'clock-'+(++fileN)+'.json'),original=B.api.getOpenPosition;
 B.api.getOpenPosition=async(...a)=>{time+=delay;return original(...a);};
 const D=L.create({token:'fake',accountId:1,contractId:'C',orders:B.api,stateFile:file,now:()=>time,sleep:async()=>{},cfgFn:()=>({...W.moneyOnly(W.moneyDefaults()),pointValue:2,tickSize:0.25}),take1MaxFn:()=>400,journal:r=>rows.push(r),preCheck:async()=>{calls++;if(calls>1&&reject==='throw')throw Error('synthetic gate error');return calls>1&&reject?'synthetic changed gate':null;}});
 return{D,rows,calls:()=>calls};}
for(const reject of [true,'throw',false])await scenario('R156 slow-read gate '+reject,async()=>{
 const B=safeBroker(),{D,rows,calls}=clockDriver(B,3001,reject);const r=await D.signal(sig(50),plan(50),'slow-read');
 ok(calls()===2,'slow broker read rechecks latest gates');
 ok(reject?!r.ok&&B.places().length===0:r.ok&&B.pos===-4,'second gate decision respected before entry');
 ok(reject?rows.some(x=>x.phase==='live_precheck_after_slow_read'):!rows.some(x=>x.phase==='live_precheck_after_slow_read'),'refusal journal matches latest gate');
});
await scenario('R156 exact slow-read threshold remains unchanged',async()=>{const B=safeBroker(),x=clockDriver(B,3000,true);const r=await x.D.signal(sig(50),plan(50),'threshold');ok(r.ok&&x.calls()===1,'exactly3000ms keeps original >3000ms condition');});
console.log(JSON.stringify({pass,fail,fails},null,2));process.exitCode=fail?1:0;
}finally{fs.rmSync(DIR,{recursive:true,force:true});}})()`;
Promise.resolve(vm.runInNewContext(fixture.slice(0,boundary)+tests,{require,console,process,__dirname,setTimeout,clearTimeout})).catch(e=>{console.error(e);process.exitCode=1;});
