import os, sys, time, json, pickle, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,'.'); sys.path.insert(0,'../../engine')
import numpy as np, simqa as Q, engine as E
from run_team import load_strategy
TEAMS = sys.argv[1].split(',')
data = {k: E.load(k, phase='dev') for k in ('NQ','ES')}
GRID = (0.5,1,1.5,2,3,4,6)
VAR = {
 'base':{}, 'slip0':dict(slip=0), 'slip2':dict(slip=2), 'slip3':dict(slip=3),
 'delay1':dict(delay=1), 'tgt_first':dict(order=1), 'ohlc_order':dict(order=2),
 'nosamebar':dict(no_samebar=1), 'thru2':dict(thru=2), 'tgtslip1':dict(tgt_slip=1),
 'stop_ext':dict(stop_ext=1), 'comm1.5':dict(comm=1.5), 'stopslip3':dict(slip_stop=3),
 'REALISTIC':dict(slip_stop=2, no_samebar=1, comm=1.5, bust_exit=1, dll_exit=1),
 'HARSH':dict(slip=2, delay=1, thru=2, no_samebar=1, comm=1.5, bust_exit=1, dll_exit=1, tgt_slip=1),
 'trail_intraday':dict(trail=1), 'trail_intra_lock':dict(trail=1, lock=1), 'lock_eod':dict(lock=1),
 'bust_exit':dict(bust_exit=1), 'dll_exit':dict(dll_exit=1, bust_exit=1),
}
def stats(rows):
    n=len(rows); res=np.array([r[1] for r in rows])
    return dict(n=n,pass_=float((res=='pass').mean()),bust=float((res=='bust').mean()),to=float((res=='timeout').mean()))
out={}
for team in TEAMS:
    t0=time.time()
    inst='NQ' if team.startswith('NQ') else 'ES'; d=data[inst]; m=load_strategy(team)
    rk=m.RISK_KEY; i0=d.idx('2021-09-27','2025-06-30')[0]; i1=d.n
    # sizing: certifier rule on whole dev window with base fills
    best=None; sweep={}
    sigs={}
    for k in GRID:
        p=dict(m.PARAMS); p[rk]=m.PARAMS[rk]*k; sg=m.generate(d,p); sigs[k]=sg
        st=stats(Q.combine(d,sg,i0,i1)); sweep[k]=st
        if st['bust']<=0.30:
            obj=st['pass_']-st['bust']
            if best is None or obj>best[0]: best=(obj,k)
    mult=best[1] if (best and sweep[best[1]]['pass_']>=0.05) else 3
    sig=sigs[mult]
    res=dict(team=team,mult=mult,sweep=sweep,var={})
    for name,kw in VAR.items():
        kw2=dict(kw); slip=kw2.pop('slip',1.0); delay=kw2.pop('delay',0)
        raw=Q.run(d,sig,i0,i1,enforce=False,slip=slip,delay=delay,**kw2)
        rows=Q.combine(d,sig,i0,i1,slip=slip,delay=delay,**kw2) if True else []
        st=stats(rows)
        res['var'][name]=dict(net=raw['net'],pf=raw['pf'],trades=raw['trades'],wr=raw['win_rate'],**st)
    # diagnostics on base tape
    base=Q.run(d,sig,i0,i1,enforce=False); t=base['tape']
    if len(t):
        reason=t[:,7]; kind=t[:,11]; both=t[:,9]; sbx=t[:,10]
        q=t[:,6]; tickval=d.mult*0.25*q; pnl_t=t[:,5]/tickval
        lim=kind==1
        res['diag']=dict(trades=len(t),limit_share=float(lim.mean()),target_share=float((reason==2).mean()),stop_share=float((reason==1).mean()),time_share=float((reason==5).mean()),
            both_hit_share=float(both.mean()), sameBar_exit_share=float(sbx.mean()),
            limit_samebar_target=int(((reason==2)&(sbx==1)&lim).sum()), limit_samebar_target_pnl=float(t[((reason==2)&(sbx==1)&lim),5].sum()),
            exp_ticks=float(pnl_t.mean()), avg_win_ticks=float(pnl_t[pnl_t>0].mean()) if (pnl_t>0).any() else 0, avg_loss_ticks=float(pnl_t[pnl_t<0].mean()) if (pnl_t<0).any() else 0,
            avg_q=float(q.mean()), hold_bars=float((t[:,1]-t[:,0]).mean()))
    out[team]=res
    print(team,'mult',mult,'base',res['var']['base'],f'{time.time()-t0:.0f}s',flush=True)
pickle.dump(out,open(f'exp1_{TEAMS[0]}.pkl','wb'))
