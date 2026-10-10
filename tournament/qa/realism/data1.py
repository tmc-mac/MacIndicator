import numpy as np, pandas as pd
for name in ['nq','es']:
    z=np.load(f'/tmp/claude-0/cache/{name}_1m.npz'); ts=z['ts']
    # restrict to <= 2025-06-30
    lim=np.datetime64('2025-07-01','s').astype(np.int64); n=np.searchsorted(ts,lim)
    ts=ts[:n]; o,h,l,c,v=[z[k][:n] for k in 'ohlcv']
    print('=====',name,n,pd.to_datetime(ts[0],unit='s'),pd.to_datetime(ts[-1],unit='s'))
    print('dups',(np.diff(ts)==0).sum(),'nonmono',(np.diff(ts)<0).sum())
    print('zero vol',(v==0).sum(), 'nan',np.isnan(o).sum()+np.isnan(c).sum())
    print('h<max(o,c)',(h<np.maximum(o,c)-1e-9).sum(),'l>min',(l>np.minimum(o,c)+1e-9).sum(),'h<l',(h<l).sum())
    print('nonpos px',(c<=0).sum(), 'off-tick', (np.abs(np.round(c*4)-c*4)>1e-6).sum(), 'of',n)
    dt=np.diff(ts); u,cnt=np.unique(dt,return_counts=True)
    top=sorted(zip(cnt,u),reverse=True)[:12]; print('gaps(sec,count):',[(int(a),int(b)) for b,a in top][:12])
    big=[(int(a),int(b)) for b,a in zip(cnt,u) if a>3600]
    print('gaps>1h count',sum(c_ for a,c_ in big))
    # jumps
    r=np.diff(c); atr=pd.Series(np.abs(r)).rolling(1000,min_periods=100).median().values
    print('max |close-close|',np.abs(r).max(), 'top5',np.sort(np.abs(r))[-5:])
    bar_rng=h-l; print('max range',bar_rng.max(),'p99.99',np.percentile(bar_rng,99.99))
    t=pd.to_datetime(ts,unit='s',utc=True).tz_convert('America/New_York')
    # bars per session
    sess=(t+pd.Timedelta(hours=7)).normalize()
    g=pd.Series(1,index=sess).groupby(level=0).size()
    print('sessions',len(g),'bars/session describe',g.describe().round(0).to_dict())
    print('short sessions (<600 bars on weekday):'); gg=g[(g<1000)]; print(gg.index.strftime('%Y-%m-%d %a').tolist()[:80], len(gg))
    # minutes within day coverage: bars at hours
    hh=pd.Series(t.hour).value_counts().sort_index(); print('bars by ET hour',hh.to_dict())
    # weekend bars: Saturday bars; Friday after 17; Sunday before 18
    dw=t.dayofweek; print('Sat bars',(dw==5).sum(),'Fri>=17h',((dw==4)&(t.hour>=17)).sum(),'Sun<18h',((dw==6)&(t.hour<18)).sum())
    mt=(t.hour==17).sum(); print('bars in 17h ET',mt)
