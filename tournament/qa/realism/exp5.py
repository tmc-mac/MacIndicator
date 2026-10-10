import os, sys, glob, pickle, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,'.'); sys.path.insert(0,'../../engine')
import numpy as np, pandas as pd, simqa as Q, engine as E
from run_team import load_strategy
R={}
for f in glob.glob('exp1_*.pkl'): R.update(pickle.load(open(f,'rb')))
data={k:E.load(k,phase='dev') for k in ('NQ','ES')}
tot=[]
for team in ['ES-8','NQ-11','ES-2','ES-10','NQ-4','NQ-1','ES-7']:
    inst='NQ' if team.startswith('NQ') else 'ES'; d=data[inst]; m=load_strategy(team)
    p=dict(m.PARAMS); p[m.RISK_KEY]*=R[team]['mult']; sig=m.generate(d,p); i0=d.idx('2021-09-27','2025-06-30')[0]
    t=Q.run(d,sig,i0,d.n,enforce=False)['tape']; eb=t[:,0].astype(int); xb=t[:,1].astype(int)
    x=np.flatnonzero(d.day[xb]!=d.day[eb])
    for i in x:
        et=pd.Timestamp(int(d.ts[eb[i]]),unit='s',tz='UTC').tz_convert('America/New_York'); xt=pd.Timestamp(int(d.ts[xb[i]]),unit='s',tz='UTC').tz_convert('America/New_York')
        tot.append((team,et.strftime('%Y-%m-%d %H:%M %a'),xt.strftime('%Y-%m-%d %H:%M %a'),int(t[i,7]),round(t[i,5])))
df=pd.DataFrame(tot,columns=['team','entry','exit','reason','pnl']); print(df.to_string()); print(df.groupby('team').pnl.agg(['count','sum']))
