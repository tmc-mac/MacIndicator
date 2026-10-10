import sys; sys.path.insert(0,'/home/user/MacIndicator/tournament/engine'); sys.path.insert(0,'/home/user/MacIndicator/tournament/teams/NQ-1')
import engine as E, strategy as S, numpy as np, json
d=E.load('NQ'); i0,i1=d.idx(*E.WINDOWS['train'])
def go(**kw):
    p=dict(S.PARAMS); p.update(kw); sig=S.generate(d,p); r=E.run(d,sig,i0,i1,enforce=False)
    ro=E.summarize_rolling(E.rolling_evals(d,sig,i0,i1))
    print(kw, E.brief(r), {k:round(v,2) for k,v in ro.items()}, flush=True)
    return r
if __name__=='__main__':
    for a in sys.argv[1:]: go(**json.loads(a))
