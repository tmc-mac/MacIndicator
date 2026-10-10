import sys, os
sys.path.insert(0,'/home/user/MacIndicator/tournament/engine')
import numpy as np, numba
from numba import njit
import engine as E
import sx
d = E.load('NQ', phase='design')

@njit
def outcomes(o,h,l,c,bar,side,px,stop,tgt,exitb,canc):
    n=len(bar); R=np.full(n,np.nan); hold=np.zeros(n)
    for k in range(n):
        s=side[k]; b=bar[k]+1; eb=-1; entry=0.0
        for j in range(b, canc[k]+1):
            if s==1 and l[j]<=px[k]-0.25: entry=px[k] if o[j]>px[k] else o[j]; eb=j; break
            if s==-1 and h[j]>=px[k]+0.25: entry=px[k] if o[j]<px[k] else o[j]; eb=j; break
        if eb<0: continue
        risk=abs(entry-stop[k])
        if (s==1 and stop[k]>=entry) or (s==-1 and stop[k]<=entry): continue
        j=eb; ex=0.0
        while True:
            if (s==1 and l[j]<=stop[k]) or (s==-1 and h[j]>=stop[k]):
                ex=stop[k]-s*0.25; break
            if (s==1 and h[j]>=tgt[k]+0.25) or (s==-1 and l[j]<=tgt[k]-0.25):
                ex=tgt[k]; break
            if j>=exitb[k]: ex=c[j]; break
            j+=1
        R[k]=s*(ex-entry)/risk; hold[k]=j-eb
    return R,hold

def cands(p):
    sig=sx.generate(d,p); F=sx.LASTFEAT
    R,hold=outcomes(d.o,d.h,d.l,d.c,sig['bar'],sig['side'],sig['px'],sig['stop'],sig['target'],sig['exit_by'],sig['cancel_by'])
    return sig,F,R,hold
