import numpy as np, pandas as pd
def load(nm):
    z=np.load(f'/tmp/claude-0/cache/{nm}_1m.npz'); ts=z['ts']; n=np.searchsorted(ts,np.datetime64('2025-07-01','s').astype(np.int64))
    t=pd.to_datetime(ts[:n],unit='s',utc=True).tz_convert('America/New_York')
    return pd.DataFrame({k:z[k][:n] for k in 'ohlcv'},index=t)
nq=load('nq'); es=load('es')
def sess(df): return (df.index+pd.Timedelta(hours=7)).normalize().tz_localize(None)
nq['s']=sess(nq); es['s']=sess(es)
# per-session bars count and first/last time around quarterly expiry
for d in ['2021-12-17','2022-03-18','2022-06-17','2023-03-17','2024-06-21','2024-12-20','2025-03-21']:
    x=nq[nq.s==pd.Timestamp(d)+pd.Timedelta(days=0)]
    y=nq[nq.s==pd.Timestamp(d)]
    print(d,'nq bars',len(y), y.index[0] if len(y) else None, y.index[-1] if len(y) else None,'| es', len(es[es.s==pd.Timestamp(d)]))
# session-to-session: gap between last close of session and first open of next, vs ES
ng=nq.groupby('s').agg(first=('o','first'),last=('c','last'),n=('c','size'))
eg=es.groupby('s').agg(first=('o','first'),last=('c','last'),n=('c','size'))
j=ng.join(eg,lsuffix='_nq',rsuffix='_es',how='inner')
j['gap_nq']=j.first_nq-j.last_nq.shift(); j['gap_es']=j.first_es-j.last_es.shift()
j['gp_nq']=j.gap_nq/j.last_nq.shift(); j['gp_es']=j.gap_es/j.last_es.shift()  # es adjusted levels, tiny error
j['diff']=(j.gp_nq-1.2*j.gp_es)
print(j['diff'].describe())
big=j[(j['diff'].abs()>0.006)]
print(big[['gap_nq','gap_es','gp_nq','gp_es','diff']].round(4).to_string())
print('---- all quarterly expiries')
exps=[]
for y in range(2021,2026):
    for m in (3,6,9,12):
        d=pd.Timestamp(y,m,1); fr=d+pd.Timedelta(days=(4-d.dayofweek)%7)+pd.Timedelta(days=14); exps.append(fr)
rows=[]
for e in exps:
    if e<pd.Timestamp('2021-10-01') or e>pd.Timestamp('2025-06-30'): continue
    nxt=ng.index[ng.index>e]
    if len(nxt)==0: continue
    s=nxt[0]; 
    pe=ng.index[ng.index<=e][-1]
    gnq=ng.loc[s,'first']-ng.loc[pe,'last']
    ges=eg.loc[s,'first']-eg.loc[pe,'last'] if (s in eg.index and pe in eg.index) else np.nan
    rows.append((e.date(),pe.date(),s.date(),ng.loc[pe,'n'],round(gnq,2),round(ges,2),round(gnq-1.15*ges,1) if ges==ges else None))
print(pd.DataFrame(rows,columns=['expiry','lastsess','nextsess','bars_exp_day','nq_gap','es_gap','nq_gap_minus_1.15es']).to_string())
