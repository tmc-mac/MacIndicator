import os, sys, glob, pickle, copy, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,'.'); sys.path.insert(0,'../../engine')
import numpy as np, pandas as pd, simqa as Q, engine as E
from run_team import load_strategy
R={}
for f in glob.glob('exp1_*.pkl'): R.update(pickle.load(open(f,'rb')))
nq=E.load('NQ',phase='dev'); es=E.load('ES',phase='dev')
# roll bars
import datetime
exp_days=[]
for y in range(2021,2026):
    for m in (3,6,9,12):
        dd=datetime.date(y,m,1); exp_days.append(np.datetime64(dd+datetime.timedelta(days=(4-dd.weekday())%7+14)))
rb=[i for i in np.flatnonzero(np.diff(nq.ts)>86400)+1 if np.datetime64(int(nq.ts[i-1]),'s').astype('datetime64[D]') in exp_days]
jumps=[]
for i in rb:
    t_prev, t_new = nq.ts[i-1], nq.ts[i]
    ie0=np.searchsorted(es.ts,t_prev,side='right')-1; ie1=np.searchsorted(es.ts,t_new)
    es_move=es.o[ie1]-es.c[ie0]
    beta=nq.c[i-1]/es.c[ie0]        # approx level ratio on adj ES (error small: ES adj offset tiny for beta)
    j=(nq.o[i]-nq.c[i-1])-es_move*beta*1.0
    jumps.append(j); print(str(np.datetime64(int(t_new),'s')), 'nq gap',round(nq.o[i]-nq.c[i-1],1),'es move',round(es_move,1),'est roll jump',round(j,1))
adj=np.zeros(nq.n)
for i,j in zip(rb,jumps): adj[:i]+=j     # raise older prices to new contract level
nqa=copy.copy(nq)
for f in 'ohlc': setattr(nqa,f,getattr(nq,f)+adj)
print('cum adj at start',adj[0])
i0=nq.idx('2021-09-27','2025-06-30')[0]; i1=nq.n
out={}
for team in sorted(R):
    if not team.startswith('NQ'): continue
    m=load_strategy(team); mult=R[team]['mult']; p=dict(m.PARAMS); p[m.RISK_KEY]*=mult
    row={}
    for lab,dd in (('raw_unadj',nq),('rolladj',nqa)):
        sig=m.generate(dd,p); raw=Q.run(dd,sig,i0,i1,enforce=False); rows=Q.combine(dd,sig,i0,i1)
        r=np.array([x[1] for x in rows]); row[lab]=dict(net=round(raw['net']),pf=round(raw['pf'],3),trades=raw['trades'],pass_=round(float((r=='pass').mean()),3),bust=round(float((r=='bust').mean()),3))
    out[team]=row; print(team,row,flush=True)
pickle.dump((jumps,out),open('exp3.pkl','wb'))
