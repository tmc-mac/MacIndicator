import sys; sys.path.insert(0,'.')
import strategy as S, engine as E, itertools
d=E.load('ES'); i0,i1=d.idx(*E.WINDOWS['design'])
for sign in (1,-1):
  for N,Z,H in itertools.product((5,15,30),(1.5,2.5,3.0),(15,60)):
    p=dict(S.PARAMS); p.update(sign=sign,N=N,Z=Z,H=H)
    r=E.run(d,S.generate(d,p),i0,i1,enforce=False)
    print(sign,N,Z,H,E.brief(r),flush=True)
