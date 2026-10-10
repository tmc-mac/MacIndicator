import json, pickle; from qlib import *
m=load_strategy(os.path.join(TOUR,'lab/base/strategy.py'))
d=E.load('NQ',phase='dev')
p=dict(m.PARAMS); p[m.RISK_KEY]*=3
sig=m.generate(d,p)
v=json.load(open(os.path.join(TOUR,'lab/versions/v2.json')))
i0=0
dev_end=d.n
# (A) month starts on dev data, cap120 and compare with v2.json
ms=month_starts(d,0,d.n,120)
rows=outcomes(d,sig,ms)
vm={r['month']:r for r in v['months']}
bad=0
for r in rows:
    q=vm[r['lab']]
    ok = (q['res']==r['res']) and (q['ev_sess']==r['ev'])
    if not ok: bad+=1; print('MISMATCH',r['lab'],r['res'],r['ev'],'v2:',q['res'],q['ev_sess'], round(r['net']),q['net'])
print('monthly120 compared',len(rows),'mismatch',bad)
print(' ',rates(rows,60),rates(rows,120))
# the same with lab-style period split
des=[r for r in rows if r['lab']<='2024-06']; prf=[r for r in rows if '2024-07'<=r['lab']<='2025-06']
print('design-start months (windows may reach proof data):',rates(des,60),rates(des,120))
print('proof-start months:',rates(prf,60),rates(prf,120))
# (B) design-only truncated
i0,i1=d.idx('2021-09-27','2024-06-30')
print('design bars',i1)
for cap in (60,120):
    r=outcomes(d,sig,month_starts(d,i0,i1,cap)); print('design monthly cap',cap,rates(r,cap))
    r=outcomes(d,sig,dense_starts(d,i0,i1,cap)); print('design dense cap',cap,rates(r,cap))
# proof year windows alone
j0,j1=d.idx('2024-07-01','2025-06-30')
for cap in (60,120):
    r=outcomes(d,sig,month_starts(d,j0,j1,cap)); print('proof-only monthly cap',cap,rates(r,cap))
    r=outcomes(d,sig,dense_starts(d,j0,j1,cap)); print('proof-only dense cap',cap,rates(r,cap))
