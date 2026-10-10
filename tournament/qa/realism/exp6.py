import os, sys, glob, pickle, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,'.'); sys.path.insert(0,'../../engine')
import numpy as np, pandas as pd, simqa as Q, engine as E
from run_team import load_strategy
R={}
for f in glob.glob('exp1_*.pkl'): R.update(pickle.load(open(f,'rb')))
data={k:E.load(k,phase='dev') for k in ('NQ','ES')}
out={}
for team in ['ES-1','ES-5','ES-4','NQ-3','NQ-8','NQ-4','NQ-2']:
    inst='NQ' if team.startswith('NQ') else 'ES'; d=data[inst]; m=load_strategy(team)
    p=dict(m.PARAMS); p[m.RISK_KEY]*=R[team]['mult']; sig=m.generate(d,p); i0=d.idx('2021-09-27','2025-06-30')[0]; i1=d.n
    udays,first=np.unique(d.day[i0:i1],return_index=True); first+=i0
    n=0; rev=0; passes=0; boomerang=0
    for k in range(0,len(udays),3):
        if k+60>=len(udays): break
        a=int(first[k]); b=int(first[k+60]); r=Q.run(d,sig,a,b,enforce=True)   # keep trading after pass
        t=r['tape']
        if not len(t): continue
        eq=t[:,8]; hit=np.flatnonzero(eq>=53000)
        if len(hit)==0 or r['bust'] and r['tape'][-1,7]==3 and False: continue
        # was there a bust before the pass? (bust sets tape end) first hit index must precede bust
        passes+=1
        h=hit[0]; dd=d.day[t[:,1].astype(int)]
        same=np.flatnonzero(dd==dd[h]); eod=eq[same[-1]]
        if eod<53000: rev+=1
    out[team]=(passes,rev); print(team,'passes',passes,'pass-day EOD below 53k (would not count under EOD-target rule, if strategy keeps trading that day):',rev,flush=True)
