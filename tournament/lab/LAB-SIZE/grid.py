import sys, os, json, itertools, numpy as np
sys.path.insert(0,'/home/user/MacIndicator/tournament/engine'); sys.path.insert(0,'/home/user/MacIndicator/tournament/lab/LAB-SIZE')
import engine as E, lab_eval as L, strategy as S
from multiprocessing import Pool
d=E.load('NQ',phase='design'); i0,i1=d.idx(*E.WINDOWS['design'])
days=np.unique(d.day[i0:i1]); first=np.searchsorted(d.day,days)
def dense(cap,step=3): return [(k,int(first[k]),int(first[k+cap])) for k in range(0,len(days),step) if k+cap<len(days)]
D60=dense(60); D120=dense(120)
import pandas as pd
yr=lambda k: pd.Timestamp(int(days[k])*86400,unit='s').year*10+ (pd.Timestamp(int(days[k])*86400,unit='s').month>6)
SIG={}
def sig(m):
    if m not in SIG:
        p=dict(S.PARAMS); p['risk']*=m; SIG[m]=S.generate(d,p)
    return SIG[m]
def ev(args):
    m,gov=args; s=sig(m)
    def go(st):
        r=[]
        for k,a,b in st:
            x=E.run(d,s,a,b,enforce=True,stop_on_pass=True,gov=gov); r.append((k,'bust' if x['bust'] else 'pass' if x['passed'] else 'to'))
        return r
    a=go(D60); b=go(D120)
    p60=np.mean([x[1]=='pass' for x in a]); p120=np.mean([x[1]=='pass' for x in b]); b120=np.mean([x[1]=='bust' for x in b])
    # per period 120 pass/bust: early(<2023) 2023, 2024
    per={}
    for k,r in b:
        y=pd.Timestamp(int(days[k])*86400,unit='s'); key='21-22' if y.year<2023 else str(y.year)
        per.setdefault(key,[]).append(r)
    ps={k:(round(np.mean([x=='pass' for x in v]),2),round(np.mean([x=='bust' for x in v]),2)) for k,v in per.items()}
    return (m,gov,round(p60,3),round(p120,3),round(b120,3),ps)
if __name__=='__main__':
    grid=json.load(open(sys.argv[1]))
    with Pool(4) as p:
        for r in p.imap(ev,[(g[0],g[1]) for g in grid]):
            print(json.dumps(r),flush=True)
