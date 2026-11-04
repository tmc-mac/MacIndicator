from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
import itertools, importlib.util, json, subprocess
p=str(ROOT / 'source/tools/pinei2.py')
s=importlib.util.spec_from_file_location('pinei2',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
i=m.load(str(ROOT / 'LevelsPRO-TIDE-r155-partial-review.pine'))
cases=[]
for ix,(d,ck,kind,cd,bias,ncl,rci,body,xavg,wp,flags) in enumerate(itertools.product([-1,1],["trap","above",""],[0,1],[-1,0,1],[(-.2,-.1),(0,0),(.1,.2),(None,.2)],[1,2],[False,True],[.4,.6],[.9,1.1],[-.1,0,.2,None],[(True,True,True,True),(False,False,False,False),(True,False,True,False),(False,True,False,True)])):
 if ix % 11: continue
 ev={'dir':d,'kind':'failed-break' if kind==0 else 'accepted-break','control4h':cd==d,'controlKind':ck or None,'bias15':bias[0],'bias30':bias[1],'acceptClosesOut':ncl,'retestClosedInside':rci,'dispBodyPct':body,'dispRangeX':xavg,'wavePeakBias':wp,'retestNo':1,'midRange':False,'stopLogical':True}
 cfg={'controlAsBias':flags[0],'controlFree':flags[1],'laneAccept':flags[2],'waveBiasTrend':flags[3]}
 cases.append([ev,cfg,cd])
js='''const s=require(process.argv[1]);let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{let xs=JSON.parse(b);process.stdout.write(JSON.stringify(xs.map(([ev,cfg])=>{const r=s.gradeOf(ev,s.DEFAULTS.grade,cfg);return ['control4h','laneTrigger','waveBias'].map(x=>!r.missing.includes(x))})))})'''
r=subprocess.run(['node','-e',js,str(ROOT / 'checks/structure-r155.js')],input=json.dumps(cases),text=True,capture_output=True,check=True)
expected=json.loads(r.stdout)
for (ev,cfg,cd),exp in zip(cases,expected):
 i.g.v.update({'td_control_bias':cfg['controlAsBias'],'td_control_free':cfg['controlFree'],'td_lane_accept':cfg['laneAccept'],'td_wave_trend':cfg['waveBiasTrend']})
 out=i.call_fn('t_policy',[ev['dir'],0 if ev['kind']=='failed-break' else 1,cd,ev['controlKind'] or '',ev['bias15'],ev['bias30'],ev['acceptClosesOut'],ev['retestClosedInside'],ev['dispBodyPct'],ev['dispRangeX'],ev['wavePeakBias']])
 got=[bool(out[1]),bool(out[2]),bool(out[3])]
 if got!=exp:raise AssertionError((ev,cfg,got,exp,out))
print(len(cases),'synthetic required-gate comparisons passed against actual r3.6 gradeOf')
