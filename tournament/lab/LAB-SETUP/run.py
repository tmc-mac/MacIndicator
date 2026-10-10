import sys, os, json
sys.path.insert(0,'/home/user/MacIndicator/tournament/engine')
import numpy as np, pandas as pd
import engine as E, lab_eval as L
import importlib
def evalp(mod, over, gov=None, mult=3, label='', post=None):
    p=dict(mod.PARAMS); p.update(over); p[mod.RISK_KEY]*=mult
    d=E.load('NQ',phase='design'); sig=mod.generate(d,p)
    if post: sig=post(d,sig,mod.LASTFEAT)
    i0,i1=d.idx(*E.WINDOWS['design'])
    days=np.unique(d.day[i0:i1]); first=np.searchsorted(d.day,days)
    out={}
    for cap in (60,120):
        st=[(str(k),int(first[k]),int(first[k+cap])) for k in range(0,len(days),3) if k+cap<len(days)]
        df=L.run_starts(E,d,sig,gov,st); df['yr']=[('21-22' if d.ts[a]<1672531200 else ('23' if d.ts[a]<1704067200 else '24')) for _,a,_ in st]
        out[cap]=df
    s=L.summarize(out[60],out[120])
    r=E.run(d,sig,i0,i1,enforce=False)
    per={y:(round((g.res=='pass').mean(),2),round((out[120][out[120].yr==y].res=='pass').mean(),2),round((out[120][out[120].yr==y].res=='bust').mean(),2)) for y,g in out[60].groupby('yr')}
    print(label, 'P60',s['P60'],'P120',s['P120'],'B120',s['B120'],'days',s['med_days'],'| PF %.2f n=%d (%.2f/d) net=%.0f'%(r['pf'],r['trades'],r['trades_per_day'],r['net']),'| yr(P60,P120,B120)',per, flush=True)
    return s
