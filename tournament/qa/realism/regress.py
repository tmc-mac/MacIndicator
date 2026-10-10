import os, sys, numpy as np
sys.path.insert(0,'.')
import simqa as Q, engine as E
from run_team import load_strategy
d=E.load('NQ',phase='dev')
for team in ['NQ-1','NQ-8','NQ-5']:
    m=load_strategy(team); sig=m.generate(d,m.PARAMS); i0,i1=d.idx(*E.WINDOWS['proof'])
    for enf in (False,True):
        a=E.run(d,sig,i0,i1,enforce=enf); b=Q.run(d,sig,i0,i1,enforce=enf)
        print(team,enf,a['net'],b['net'],a['trades'],b['trades'],a['bust'],b['bust'], np.allclose(a['tape'][:,:9],b['tape'][:,:9]))
    ca=E.combine(d,sig,i0,i1); cb=Q.combine(d,sig,i0,i1); print(' combine equal', ca==cb or [x[:3] for x in ca]==[x[:3] for x in cb])
