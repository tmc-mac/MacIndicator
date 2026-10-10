import os, sys, glob, pickle, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,'.'); sys.path.insert(0,'../../engine')
import numpy as np, pandas as pd, simqa as Q, engine as E
from run_team import load_strategy
R={}
for f in glob.glob('exp1_*.pkl'): R.update(pickle.load(open(f,'rb')))
data={k:E.load(k,phase='dev') for k in ('NQ','ES')}
# NQ roll bars: first bar after each quarterly-expiry gap (Sunday open after 09:29 ET cut)
def roll_bars(d):
    gap=np.diff(d.ts); idx=np.flatnonzero(gap>2*86400)+1   # weekend gaps; filter by expiry week
    return idx
nqd=data['NQ']
import datetime
exp_days=[]
for y in range(2021,2026):
    for m in (3,6,9,12):
        dd=datetime.date(y,m,1); fr=dd+datetime.timedelta(days=(4-dd.weekday())%7+14); exp_days.append(np.datetime64(fr))
nq_roll_idx=[]
for i in np.flatnonzero(np.diff(nqd.ts)>86400)+1:
    last=np.datetime64(int(nqd.ts[i-1]),'s').astype('datetime64[D]')
    if last in exp_days: nq_roll_idx.append(i)
print('NQ roll bars',len(nq_roll_idx), [str(np.datetime64(int(nqd.ts[i]),'s')) for i in nq_roll_idx][:20])
res={}
for team in sorted(R):
    inst='NQ' if team.startswith('NQ') else 'ES'; d=data[inst]; m=load_strategy(team); mult=R[team]['mult']
    p=dict(m.PARAMS); p[m.RISK_KEY]*=mult; sig=m.generate(d,p); i0=d.idx('2021-09-27','2025-06-30')[0]; i1=d.n
    row={}
    def stat(rows): 
        n=len(rows); r=np.array([x[1] for x in rows]); return float((r=='pass').mean()),float((r=='bust').mean())
    for name,kw in dict(ns2=dict(no_samebar=2), REAL2=dict(slip_stop=2,no_samebar=2,comm=1.5,bust_exit=1,dll_exit=1),
                        REAL2_intraday=dict(slip_stop=2,no_samebar=2,comm=1.5,bust_exit=1,dll_exit=1,trail=1)).items():
        raw=Q.run(d,sig,i0,i1,enforce=False,**kw); pr,bu=stat(Q.combine(d,sig,i0,i1,**kw))
        row[name]=dict(pf=raw['pf'],net=raw['net'],pass_=pr,bust=bu)
    base=Q.run(d,sig,i0,i1,enforce=False); t=base['tape']
    # hold across 16:10 ET .. 18:00 or session boundary
    if len(t):
        eb=t[:,0].astype(int); xb=t[:,1].astype(int)
        cross_sess=(d.day[xb]!=d.day[eb]).mean()
        after1610=(d.minute_of_day_et[xb]>=16*60+10).mean()
        # exit minute of day 
        row['cross_session_share']=float(cross_sess); row['exit_after_1610_share']=float(after1610)
        row['exit_after_1555']=float((d.minute_of_day_et[xb]>=15*60+55).mean())
        row['n_cross_sess']=int((d.day[xb]!=d.day[eb]).sum())
        if inst=='NQ':
            hit=[(a,b) for a,b in zip(eb,xb) if any(a<ri<=b for ri in nq_roll_idx)]
            row['nq_roll_spanning_trades']=len(hit)
        # worst-day, DLL breaches
        dayid=d.day[xb]; s=pd.Series(t[:,5]).groupby(dayid).sum()
        row['days_below_-1250']=int((s<-1250).sum()); row['worst_day']=float(s.min()); row['best_day']=float(s.max())
        row['trades_over_dll_single']=int((t[:,5]<-1250).sum())
    # combine pass quality
    udays,first=np.unique(d.day[i0:i1],return_index=True); first=first+i0
    cons=[]; dpass=[]
    for k in range(0,len(udays),3):
        if k+60>=len(udays): break
        a=int(first[k]); b=int(first[k+60]); r=Q.run(d,sig,a,b,enforce=True,stop_on_pass=True)
        if r['passed'] and not r['bust']:
            tt=r['tape']; dd=pd.Series(tt[:,5]).groupby(d.day[tt[:,1].astype(int)]).sum()
            cons.append(dd.max()/dd.sum()); dpass.append(len(dd))
    row['n_pass_starts']=len(cons)
    if cons:
        cons=np.array(cons); row['best_day_share_median']=float(np.median(cons)); row['share_passes_best_day>50%']=float((cons>0.5).mean()); row['share_passes_best_day>30%']=float((cons>0.3).mean())
        row['pass_in_<=2_trading_days']=float((np.array(dpass)<=2).mean()); row['pass_in_<5_days']=float((np.array(dpass)<5).mean())
    res[team]=row; print(team,{k:(round(v,3) if isinstance(v,float) else v) for k,v in row.items() if not isinstance(v,dict)},{k:{a:round(b,2) for a,b in v.items()} for k,v in row.items() if isinstance(v,dict)},flush=True)
pickle.dump(res,open('exp2.pkl','wb'))
