import numpy as np, pandas as pd
def load(nm):
    z=np.load(f'/tmp/claude-0/cache/{nm}_1m.npz'); ts=z['ts']; n=np.searchsorted(ts,np.datetime64('2025-07-01','s').astype(np.int64))
    t=pd.to_datetime(ts[:n],unit='s',utc=True).tz_convert('America/New_York')
    return pd.DataFrame({k:z[k][:n] for k in 'ohlcv'},index=t)
out={}
for nm in ['nq','es']:
    df=load(nm); s=(df.index+pd.Timedelta(hours=7)).normalize().tz_localize(None)
    g=df.groupby(s).agg(n=('c','size'),first=('c',lambda x:x.index[0].strftime('%H:%M')),last=('c',lambda x:x.index[-1].strftime('%H:%M')))
    out[nm]=g
    print('=====',nm); 
    sh=g[(g.n<1330)]
    sh=sh.assign(dow=sh.index.day_name().str[:3]); print(sh.to_string())
    # sessions by weekday count
    print(pd.Series(g.index.dayofweek).value_counts().sort_index().to_dict())
    # RTH minutes missing: count of missing minutes 9:30-16:00 on normal days
    rth=df.between_time('09:30','15:59'); 
    rs=(rth.index+pd.Timedelta(hours=7)).normalize()
    cnt=rth.groupby(rs.tz_localize(None)).size()
    full=cnt[cnt>=390]; print('RTH days',len(cnt),'full390',len(full),'missing-minute days',((cnt<390)&(cnt>300)).sum(), 'sum missing', (390-cnt[(cnt<390)&(cnt>300)]).sum())
    # DST check: volume peak ET minute in winter vs summer
    v=df.v; mm=df.index.hour*60+df.index.minute
    for lab,mask in [('summer',(df.index.month>=6)&(df.index.month<=8)),('winter',(df.index.month==12)|(df.index.month<=2))]:
        p=v[mask].groupby(mm[mask]).mean(); print(lab,'peak ET minute',p.idxmax()//60,p.idxmax()%60)
    # DST transition weeks: Mon after Sunday transition first bar
    for dts in ['2022-03-13','2022-11-06','2023-03-12','2023-11-05','2024-03-10','2024-11-03','2025-03-09']:
        x=df[(df.index>=pd.Timestamp(dts).tz_localize('America/New_York')) & (df.index<pd.Timestamp(dts).tz_localize('America/New_York')+pd.Timedelta(days=1))]
        print(dts, len(x), x.index[0] if len(x) else None)
