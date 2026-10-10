import numpy as np, pandas as pd
d=pd.read_pickle('/tmp/claude-0/rawes/out.pkl')
d['day']=d.ts.dt.floor('D')
vol=d.groupby(['day','symbol']).volume.sum().reset_index().sort_values(['day','volume'],ascending=[True,False])
front=vol.drop_duplicates('day').set_index('day').symbol
key=lambda s:(int(s[3]),'HMUZ'.index(s[2]))
cur=None; fl={}; raw_flips=0
for day,s in front.items():
    if cur is None or key(s)>=key(cur): cur=s
    else: raw_flips+=1
    fl[day]=cur
f=pd.Series(fl)
print('days where raw top-volume contract was OLDER than chosen (backward flips ignored):',raw_flips)
chg=f[f!=f.shift()]
print(chg.to_string())
# for each roll: dollar volume shares around roll, day of week, expiry
rows=[]
for day,s in chg.iloc[1:].items():
    old=f.shift()[day]
    exp=pd.Timestamp(2000+int(s[3])+(10 if int(s[3])<5 else 0) if False else 0,1,1) if False else None
    v=vol[vol.day==day].set_index('symbol').volume
    prev_d=day-pd.Timedelta(days=1)
    rows.append((day.date(),old,s,v.get(old,0),v.get(s,0)))
print(pd.DataFrame(rows,columns=['day','old','new','vol_old','vol_new']).to_string())
f.to_pickle('/tmp/claude-0/rawes/front.pkl')
