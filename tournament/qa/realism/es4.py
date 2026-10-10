import numpy as np, pandas as pd
d=pd.read_pickle('/tmp/claude-0/rawes/out.pkl'); f=pd.read_pickle('/tmp/claude-0/rawes/front.pkl')
d['day']=d.ts.dt.floor('D'); d['front']=d.day.map(f)
sel=d[d.symbol==d.front].drop_duplicates('ts').sort_values('ts').reset_index(drop=True)
z=np.load('/tmp/claude-0/cache/es_1m.npz')
print(len(sel),len(z['ts']))
ts=sel.ts.values.astype('datetime64[s]').astype(np.int64)
print('ts equal',np.array_equal(ts,z['ts']))
adj=z['c']-sel.close.values
# adj should be piecewise-constant, nonincreasing in time toward 0
ch=np.flatnonzero(np.abs(np.diff(adj))>1e-9)
print('n adj changes',len(ch), 'adj at start',adj[0],'adj at end',adj[-1])
for i in ch: print(pd.to_datetime(ts[i+1],unit='s'), round(adj[i]-adj[i+1],2))
n=np.searchsorted(z['ts'],np.datetime64('2025-07-01','s').astype(np.int64)); print('adj at dev end',adj[n-1],'raw price',sel.close.values[n-1],'adj price',z['c'][n-1])
print('raw start', sel.close.values[0], 'adj start', z['c'][0])
# bar-to-bar jump in npz at roll bar vs typical
for i in ch:
    print(pd.to_datetime(ts[i+1],unit='s'),'adj-series jump c->o',round(z['o'][i+1]-z['c'][i],2))
# check h/l/o adjusted consistent: ohlc same shift
for k in 'ohl': 
    a=z[k]-sel[{'o':'open','h':'high','l':'low'}[k]].values; print(k,np.abs(a-adj).max())
