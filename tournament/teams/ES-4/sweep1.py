from ev import *
for ks,kt in ((4,4),(6,6),(8,8),(6,0),(10,0)):
  for T in (0.04,0.07):
    p = dict(S.PARAMS, T=T, ks=ks, kt=kt, model='model_inner.json'); print(ks,kt,T, ev(p))
