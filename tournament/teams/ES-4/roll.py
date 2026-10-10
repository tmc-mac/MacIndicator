import sys; sys.path.insert(0,'.')
import strategy as S, engine as E, numpy as np
d=E.load('ES'); i0,i1=d.idx('2021-09-27','2023-12-31')
for risk in (150,250,350):
    sig=S.generate(d,dict(S.PARAMS,risk=risk)); rs=E.rolling_evals(d,sig,i0,i1)
    print(risk,E.summarize_rolling(rs),'rawDD',E.run(d,sig,i0,i1,enforce=False)['max_dd'],'maxDDroll',max(r['max_dd'] for r in rs))
