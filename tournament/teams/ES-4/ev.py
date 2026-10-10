import sys, os, numpy as np
sys.path.insert(0, '.'); import strategy as S, engine as E
d = E.load('ES')
def ev(params, wins=(('2021-09-27','2022-12-31'),('2023-01-01','2023-12-31'))):
    sig = S.generate(d, params); out=[]
    for a,b in wins:
        i0,i1 = d.idx(a,b); r = E.run(d,sig,i0,i1,enforce=False); out.append(E.brief(r))
    return out
if __name__=='__main__':
    for T in (0.02,0.03,0.04,0.06,0.08):
        p = dict(S.PARAMS, T=T, model='model_inner.json'); print(T, ev(p))
