from ana import *
import pandas as pd
p=dict(sx.PARAMS); p['wins']=[0,1380]; p['max_per_day']=50; p['exit_min']=955
sig,F,R,hold=cands(p)
df=pd.DataFrame(F,columns='depth disp fvg sdatr mod htf wi side sd'.split()); df['R']=R; df['hold']=hold
df['day']=d.day[sig['bar']]; df['yr']=pd.to_datetime(d.ts[sig['bar']],unit='s').year
df=df.dropna()
print(len(df), df.R.mean())
df['hr']=(df['mod']//30)*30
print(df.groupby('hr').R.agg(['count','mean','sum']).round(3).to_string())
df.to_pickle('cand_all.pkl')
