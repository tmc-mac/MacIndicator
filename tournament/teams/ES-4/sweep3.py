import fit
from ev import *
for C in (0.005,0.05,0.5):
    fit.fit('2022-12-31', C, out='m_tmp.json')
    for T in (0.05,0.06):
        for ks in (6,8,10):
            p = dict(S.PARAMS, T=T, ks=ks, kt=0, model='m_tmp.json'); print(C,T,ks, ev(p))
