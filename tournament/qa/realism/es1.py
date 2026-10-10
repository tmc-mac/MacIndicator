import numpy as np, pandas as pd, glob
parts=[]
for f in sorted(glob.glob('/tmp/claude-0/rawes/*.csv')):
    x=pd.read_csv(f,usecols=['ts_event','open','high','low','close','volume','symbol']); x['file']=f[-9:-4]; parts.append(x)
d=pd.concat(parts,ignore_index=True)
print('rows',len(d)); print(d.groupby('file').ts_event.agg(['min','max']))
syms=d.symbol.value_counts(); print(syms.head(40).to_string()); 
d=d[d.symbol.str.match(r'^ES[HMUZ]\d$')].copy()
d['ts']=pd.to_datetime(d.ts_event,utc=True).dt.tz_localize(None)
print('dups (ts,sym)',d.duplicated(['ts','symbol']).sum())
d.to_pickle('/tmp/claude-0/rawes/out.pkl')
print(d.groupby('symbol').ts.agg(['min','max','size']).sort_values('min').to_string())
