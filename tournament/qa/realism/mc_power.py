import numpy as np
rng=np.random.default_rng(1)
def start_result(path):  # path: daily pnl for 60 days; closed equity at EOD, trailing floor EOD, intraday ignored
    eq=50000.0; peak=50000.0
    for x in path:
        eq+=x
        if eq>=53000: return 1
        if eq<=peak-2000: return 2
        peak=max(peak,eq)
    return 0
def trial(mu,sd,nsess=252):
    d=rng.normal(mu,sd,nsess+60)
    res=[start_result(d[k:k+60]) for k in range(0,nsess-60,3)]   # same censoring as engine: need 60 sessions inside year
    res=np.array(res); return (res==1).mean(),(res==2).mean(),len(res)
print('zero-edge and weak-edge daily pnl random walks, certifier proof test (pass>=.5 & bust<=.25) false-pass rate over 3000 simulated years')
for mu,sd in [(0,300),(0,400),(0,500),(0,600),(0,800),(15,500),(30,500)]:
    ok=0; ps=[];bs=[]
    for _ in range(1500):
        p,b,n=trial(mu,sd); ps.append(p); bs.append(b); ok+=(p>=.5 and b<=.25)
    print(f'mu={mu:>3} sd={sd}: mean pass {np.mean(ps):.2f} bust {np.mean(bs):.2f} n_starts {n} | P(cert-proof-ok)={ok/1500:.3f} | sd(pass over years)={np.std(ps):.2f}')
