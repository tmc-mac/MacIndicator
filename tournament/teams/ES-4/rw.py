import sys; sys.path.insert(0,'.')
import fit, strategy as S, engine as E, numpy as np
d=E.load('ES')
def ev(p,a,b):
    sig=S.generate(d,p); i0,i1=d.idx(a,b); return E.brief(E.run(d,sig,i0,i1,enforce=False))
fit.fit('2024-06-30',0.01,out='m_rw.json')
for T in (0.045,0.055,0.065):
  for ks in (7,):
    p=dict(S.PARAMS,T=T,ks=ks,model='m_rw.json')
    print(T,ks,'| 24H1(in-sample)',ev(p,'2024-01-01','2024-06-30'),'| OOS 24H2-25H1',ev(p,'2024-07-01','2025-06-30'))
p=dict(S.PARAMS,model='model.json'); print('old model OOS', ev(p,'2024-07-01','2025-06-30'))
