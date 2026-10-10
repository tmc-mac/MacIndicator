import numpy as np, pandas as pd
z=np.load('/tmp/claude-0/cache/nq_1m.npz'); ts=z['ts']; n=np.searchsorted(ts,np.datetime64('2025-07-01','s').astype(np.int64))
ts=ts[:n];o,h,l,c,v=[z[k][:n] for k in 'ohlcv']
t=pd.to_datetime(ts,unit='s',utc=True).tz_convert('America/New_York')
df=pd.DataFrame(dict(o=o,h=h,l=l,c=c,v=v),index=t)
r=pd.Series(c).diff().abs().values
idx=np.argsort(-r)[:25]
for i in sorted(idx): print(t[i], 'prev',c[i-1],'o',o[i],'c',c[i],'jump',round(c[i]-c[i-1],2),'gap sec',ts[i]-ts[i-1])
# sizes of jump at the open of first bar after long gaps
