import sys, json; sys.path.insert(0,'.')
import fit, strategy as S, engine as E, numpy as np
d=E.load('ES')
def ev(p,a,b):
    sig=S.generate(d,p); i0,i1=d.idx(a,b); return E.brief(E.run(d,sig,i0,i1,enforce=False))
m=fit.fit('2024-06-30',0.01)
for name,keep in (('mom3+vwap',[2,3,4]),('pos+vwap',[3,5]),('no time/vol',[0,1,2,3,4,5])):
    mm=dict(m); w=np.zeros(8); w[keep]=np.array(m['w'])[keep]  # crude: zero other weights
    # refit properly on subset
    F,_=S.features(d); 
    i0,i1=d.idx('2021-09-27','2024-06-30'); hold=30
    y=np.full(d.n,np.nan); y[:-hold]=(d.c[hold:]>d.c[:-hold]); mod=d.minute_of_day_et
    sel=np.zeros(d.n,bool); sel[i0:i1-hold]=True
    sel&=~np.isnan(F).any(1)&~np.isnan(y)&(mod>=585)&(mod<=900)&(mod%5==0)
    from sklearn.linear_model import LogisticRegression
    X=F[sel][:,keep]; mu=X.mean(0); sd=X.std(0); c=LogisticRegression(C=0.01).fit((X-mu)/sd,y[sel])
    W=np.zeros(8); MU=np.zeros(8); SD=np.ones(8); W[keep]=c.coef_[0]; MU[keep]=mu; SD[keep]=sd
    json.dump(dict(mu=MU.tolist(),sd=SD.tolist(),w=W.tolist(),b=float(c.intercept_[0])),open('m_s.json','w'))
    for T in (0.03,0.045,0.06):
        p=dict(S.PARAMS,T=T,model='m_s.json'); print(name,np.round(c.coef_[0],3),T,'|in',ev(p,'2024-01-01','2024-06-30')[:40],'|OOS',ev(p,'2024-07-01','2025-06-30'))
