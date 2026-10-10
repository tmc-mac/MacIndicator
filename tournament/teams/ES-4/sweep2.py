from ev import *
for step in (1,2,5):
 for T in (0.05,0.06,0.07,0.09):
    p = dict(S.PARAMS, T=T, step=step, ks=8, kt=0, model='model_inner.json'); print(step,T, ev(p))
