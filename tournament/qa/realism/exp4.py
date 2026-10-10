import os, sys, glob, pickle, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,'.'); sys.path.insert(0,'../../engine')
import numpy as np, simqa as Q, engine as E
from run_team import load_strategy
R={}
for f in glob.glob('exp1_*.pkl'): R.update(pickle.load(open(f,'rb')))
data={k:E.load(k,phase='dev') for k in ('NQ','ES')}
V=dict(base={}, time_slip1=dict(time_slip=1), stop_mid=dict(stop_ext=2),
       REC_nocomm=dict(slip_stop=2,time_slip=1,no_samebar=2,bust_exit=1,dll_exit=1),
       REC_comm=dict(slip_stop=2,time_slip=1,no_samebar=2,bust_exit=1,dll_exit=1,comm=1.5),
       REC_intraday=dict(slip_stop=2,time_slip=1,no_samebar=2,bust_exit=1,dll_exit=1,comm=1.5,trail=1))
res={}
for team in sorted(R):
    inst='NQ' if team.startswith('NQ') else 'ES'; d=data[inst]; m=load_strategy(team); mult=R[team]['mult']
    p=dict(m.PARAMS); p[m.RISK_KEY]*=mult; sig=m.generate(d,p); i0=d.idx('2021-09-27','2025-06-30')[0]; i1=d.n
    row={'nsig':len(sig['bar'])}
    for name,kw in V.items():
        raw=Q.run(d,sig,i0,i1,enforce=False,**kw); rows=Q.combine(d,sig,i0,i1,**kw); r=np.array([x[1] for x in rows])
        row[name]=dict(pf=raw['pf'],net=raw['net'],trades=raw['trades'],pass_=float((r=='pass').mean()),bust=float((r=='bust').mean()))
    t=Q.run(d,sig,i0,i1,enforce=False)['tape']
    if len(t): row['time_share']=float((t[:,7]==5).mean()); row['stop_share']=float((t[:,7]==1).mean())
    if name and len(t) and 'NQ-5'==team:
        base_net=row['base']['net']; ns1=Q.run(d,sig,i0,i1,enforce=False,no_samebar=1)['net']
        row['p_curve']={p_:base_net*p_+ns1*(1-p_) for p_ in (0,0.25,0.5,0.75,1)}
    res[team]=row
    print(team,mult,{k:(round(v['pf'],2),round(v['pass_'],2),round(v['bust'],2)) for k,v in row.items() if isinstance(v,dict) and 'pf' in v},'time',round(row.get('time_share',0),2),'fills/sig',round(row['base']['trades']/max(row['nsig'],1),2),flush=True)
pickle.dump(res,open('exp4.pkl','wb'))
print(res['NQ-5'].get('p_curve'))
