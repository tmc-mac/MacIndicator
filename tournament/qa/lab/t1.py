import time; from qlib import *
t=time.time()
m=load_strategy(os.path.join(TOUR,'lab/base/strategy.py'))
d=E.load('NQ',phase='dev'); print(d.n, time.time()-t)
ids=sess_ids(d.ts); print('session id equal to engine:', (ids==d.day).all(), (ids!=d.day).sum())
p=dict(m.PARAMS); p[m.RISK_KEY]*=3
sig=m.generate(d,p); print(len(sig['bar']), time.time()-t)
np.save('/tmp/claude-0/-home-user-MacIndicator/3587a0c7-5c88-5908-83cd-aea976db760a/scratchpad/x.npy',np.array([1]))
print(d.ts[0], d.ts[-1])
