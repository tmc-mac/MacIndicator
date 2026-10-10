"""Certification: is a strategy PROVEN to hit +$3,000 before the trailing -$2,000 drawdown?
python certify.py <TEAM>   -> hidden_files/quant-team/certification/<TEAM>.json

Protocol (frozen 2026-10-10):
 1. Sizing is chosen on the DESIGN window only (2021-09-27..2024-06-30): the RISK_KEY multiplier from a fixed grid that
    maximises pass_rate - bust_rate subject to bust_rate <= 0.30.  Then it is frozen.
 2. PROOF (2024-07-01..2025-06-30, never visible to recruits) is scored once with the frozen sizing.
 Every 'start' = a fresh $50K eval starting at a session open, run until PASS (+$3,000), BUST, or 60 sessions (TIMEOUT).
 Starts every 3 sessions; starts lacking 60 full sessions of data are excluded (censored).
 REQUIRED (all):
   proof   : pass_rate >= 0.50, bust_rate <= 0.25, trades >= 100 and >= 0.5/day (raw)
   design  : pass_rate >= 0.40, bust_rate <= 0.30
   halves  : pass_rate >= 0.25 in EACH half of the proof starts
   cost    : with 2-tick slippage, proof pass_rate >= 0.40 and bust_rate <= 0.30
   robust  : perturbing every TUNABLE param by -/+20% (sizing fixed) keeps median proof pass_rate >= 0.7 x baseline
             and worst >= 0.25
   clean   : lookahead_check passes
"""
import sys, os, json, copy
sys.path.insert(0, os.path.dirname(__file__))
os.environ['TOURNAMENT_COORDINATOR'] = '1'
import numpy as np, engine as E
from run_team import load_strategy

OUT = os.path.join(os.path.dirname(__file__), '..', 'hidden_files/quant-team/certification')
GRID = (0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8)

def stats(d, sig, w, **kw):
    return E.combine_stats(E.combine(d, sig, *d.idx(*E.WINDOWS[w]), **kw))

def certify(team, verbose=True):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    d = E.load(inst, phase='dev'); m = load_strategy(team)
    rk = getattr(m, 'RISK_KEY', None); tun = list(getattr(m, 'TUNABLE', []))
    res = dict(team=team, instrument=inst, checks={}, reasons=[])
    if not rk or rk not in m.PARAMS:
        res.update(certified=False); res['reasons'].append('strategy.py must export RISK_KEY (a PARAMS key scaling size)'); return res
    # 1. pick sizing on DESIGN
    best = None; sweep = []
    for k in GRID:
        p = dict(m.PARAMS); p[rk] = m.PARAMS[rk] * k
        st = stats(d, m.generate(d, p), 'design')
        sweep.append(dict(mult=k, **{x: st[x] for x in ('pass_rate', 'bust_rate', 'timeout_rate', 'median_days_to_pass')}))
        if st['bust_rate'] <= 0.30:
            obj = st['pass_rate'] - st['bust_rate']
            if best is None or obj > best[0]: best = (obj, k, st)
        if verbose: print(team, 'design x', k, {x: round(v, 2) for x, v in st.items() if x in ('pass_rate', 'bust_rate')}, flush=True)
    res['design_sweep'] = sweep
    if best is None:
        res.update(certified=False); res['reasons'].append('no sizing multiplier gets design bust_rate <= 0.30'); return res
    mult = best[1]; params = dict(m.PARAMS); params[rk] = m.PARAMS[rk] * mult
    sig = m.generate(d, params); res['chosen_mult'] = mult; res['frozen_params'] = {k: (v if isinstance(v, (int, float, str, bool, list)) else str(v)) for k, v in params.items()}
    # 2. PROOF
    design = best[2]; proof_rows = E.combine(d, sig, *d.idx(*E.WINDOWS['proof'])); proof = E.combine_stats(proof_rows)
    half = len(proof_rows) // 2; h1 = E.combine_stats(proof_rows[:half]); h2 = E.combine_stats(proof_rows[half:])
    raw = E.run(d, sig, *d.idx(*E.WINDOWS['proof']), enforce=False)
    cost = stats(d, sig, 'proof', slip=2.0)
    c = res['checks']
    c['proof'] = dict(ok=proof['pass_rate'] >= .5 and proof['bust_rate'] <= .25 and raw['trades'] >= 100 and raw['trades_per_day'] >= .5,
                      pass_rate=proof['pass_rate'], bust_rate=proof['bust_rate'], timeout_rate=proof['timeout_rate'], median_days_to_pass=proof['median_days_to_pass'],
                      n_starts=proof['n'], raw_trades=raw['trades'], raw_tpd=raw['trades_per_day'], raw_pf=raw['pf'], raw_net=raw['net'])
    c['design'] = dict(ok=design['pass_rate'] >= .4 and design['bust_rate'] <= .3, pass_rate=design['pass_rate'], bust_rate=design['bust_rate'], n_starts=design['n'])
    c['halves'] = dict(ok=h1['pass_rate'] >= .25 and h2['pass_rate'] >= .25, h1=h1['pass_rate'], h2=h2['pass_rate'])
    c['cost_2tick'] = dict(ok=cost['pass_rate'] >= .4 and cost['bust_rate'] <= .3, pass_rate=cost['pass_rate'], bust_rate=cost['bust_rate'])
    # robustness
    base = proof['pass_rate']; outs = []
    for name in tun:
        v = m.PARAMS.get(name)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or name == rk: continue
        for f in (0.8, 1.2):
            p2 = dict(params); nv = v * f; p2[name] = int(round(nv)) if isinstance(v, int) else nv
            if p2[name] == params[name]: continue
            try:
                outs.append(stats(d, m.generate(d, p2), 'proof')['pass_rate'])
            except Exception as e:
                outs.append(0.0)
    if outs:
        c['robust'] = dict(ok=(np.median(outs) >= .7 * base and min(outs) >= .25), median=float(np.median(outs)), worst=float(min(outs)), n=len(outs))
    else:
        c['robust'] = dict(ok=False, note='no TUNABLE params exported')
    clean = E.lookahead_check(d, m.generate, params); c['lookahead'] = dict(ok=bool(clean))
    for k, v in c.items():
        if not v['ok']: res['reasons'].append(f'{k} failed: ' + ', '.join(f'{a}={b:.2f}' if isinstance(b, float) else f'{a}={b}' for a, b in v.items() if a != 'ok'))
    res['certified'] = all(v['ok'] for v in c.values())
    return res

if __name__ == '__main__':
    t = sys.argv[1]; r = certify(t)
    os.makedirs(OUT, exist_ok=True); json.dump(r, open(os.path.join(OUT, t + '.json'), 'w'), indent=1, default=float)
    print(t, 'CERTIFIED' if r['certified'] else 'NOT certified', '| mult', r.get('chosen_mult'), '|', '; '.join(r['reasons']) or 'all checks passed')
