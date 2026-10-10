import numpy as np, pandas as pd, glob
d=pd.read_pickle('/tmp/claude-0/rawes/out.pkl'); f=pd.read_pickle('/tmp/claude-0/rawes/front.pkl')
sp=[]
for fn in sorted(glob.glob('/tmp/claude-0/rawes/*.csv')):
    x=pd.read_csv(fn,usecols=['ts_event','close','volume','symbol']); x=x[x.symbol.str.contains('-')]; sp.append(x)
sp=pd.concat(sp); sp['ts']=pd.to_datetime(sp.ts_event,utc=True).dt.tz_localize(None); sp=sp.set_index(['symbol','ts']).close
d['day']=d.ts.dt.floor('D'); d['front']=d.day.map(f)
sel=d[d.symbol==d.front].drop_duplicates('ts').sort_values('ts').reset_index(drop=True)
px=d.set_index(['symbol','ts']).close
sym=sel.symbol.values; chg=np.flatnonzero(sym[1:]!=sym[:-1])+1
rows=[]; cum=0
for i in chg:
    t=sel.ts[i]; old,new=sym[i-1],sym[i]
    has_old=(old,t) in px.index
    g=px[(new,t)]-px[(old,t)] if has_old else np.nan
    # naive jump in raw sel series
    nj=sel.close[i]-sel.close[i-1]
    # spread symbol
    s1=sp.get((f"{old}-{new}",t),np.nan)
    # calendar-time gap since prev bar
    gap=(t-sel.ts[i-1]).total_seconds()
    # old contract bar in the previous minute (continuity of old)
    rows.append((t,old,new,has_old,g,nj,s1,gap, sel.volume[i-1],sel.volume[i]))
r=pd.DataFrame(rows,columns=['t','old','new','old_has_bar_at_t','gap_used','raw_naive_jump','spread_sym_close','secs_since_prev','v_prev','v_new'])
r['et']=r.t.dt.tz_localize('UTC').dt.tz_convert('America/New_York')
print(r.to_string())
print('sum gap',r.gap_used.sum())
# Check spread symbol vs gap
