"""How often does BUG-1 (stop beyond DLL/floor; phantom DLL/BUST gains) occur on real signals?"""
import sys, os, json
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from diff_teams import *
def main(team, mult):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    d = E.load(inst, phase='dev'); m = load_strategy(team)
    p = dict(m.PARAMS); p[m.RISK_KEY] *= mult; sig = m.generate(d, p); R = RS.Ref(d)
    out = dict(team=team, mult=mult)
    j0, j1 = d.idx('2022-07-01', '2025-06-30')
    ncomb = 0; tot = dict(trades=0, stop_ge_dll=0, stop_ge_2000=0, phantom=0, phantom_sum=0.0)
    # continuous per-start (use combine rows from ref in mimic mode and strict breach flags)
    rows_m = RS.combine_ref(R, sig, j0, j1, mode='mimic')
    rows_s = RS.combine_ref(R, sig, j0, j1, mode='breach_order,post_check,pause_orders')
    cnt = lambda rows: tuple(sum(1 for r in rows if r[1] == x) for x in ('pass', 'bust', 'timeout'))
    for r in rows_m:
        for t in r[4]['trades']:
            tot['trades'] += 1
            if t[7] == 1 and t[5] <= -1250: tot['stop_ge_dll'] += 1
            if t[7] == 1 and t[5] <= -2000: tot['stop_ge_2000'] += 1
            if t[7] in (3, 4) and t[5] > 0: tot['phantom'] += 1; tot['phantom_sum'] += t[5]
    out.update(tot); out['n_starts'] = len(rows_m); out['mimic_pbt'] = cnt(rows_m); out['breach_fixed_pbt'] = cnt(rows_s)
    print(json.dumps(out, default=float), flush=True)
if __name__ == '__main__': main(sys.argv[1], float(sys.argv[2]))
