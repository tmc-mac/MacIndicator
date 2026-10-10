import numpy as np, pandas as pd
def load(nm):
    z=np.load(f'/tmp/claude-0/cache/{nm}_1m.npz'); ts=z['ts']; n=np.searchsorted(ts,np.datetime64('2025-07-01','s').astype(np.int64))
    return pd.DataFrame({k:z[k][:n] for k in 'ohlcv'},index=pd.to_datetime(ts[:n],unit='s'))
nq=load('nq'); es=load('es')
j=nq[['o','c']].join(es[['o','c']],lsuffix='n',rsuffix='e',how='inner')
# true ES level is unknown (additive adjusted); approx use raw-ish: pts diff
# bar-to-bar previous close in joined index only when consecutive minute
prev_gap=j.index.to_series().diff().dt.total_seconds()
rn=(j.on-j.cn.shift())/j.cn.shift(); re=(j.oe-j.ce.shift())/j.ce.shift()
res=(rn-re)  # open vs prior close, pct
res=res[(prev_gap<=7200*100)]
# normal gap-open residual std for 60s gaps small; find big
r60=res[prev_gap.reindex(res.index)==60]
print('std 1-min open residual',r60.std())
big=res[res.abs()>0.004].sort_values()
x=pd.DataFrame({'res':big,'gap_s':prev_gap.reindex(big.index)})
x['et']=x.index.tz_localize('UTC').tz_convert('America/New_York')
print(x.to_string())
