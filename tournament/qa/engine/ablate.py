"""Ablation of the strict-reading conventions, one at a time, on combine starts (proof year + design chunk)."""
import sys, os, json
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from diff_teams import *
FLAGS = ['breach_order', 'post_check', 'pend_block', 'fillbar_tgt', 'time_slip', 'pause_orders', 'strict']
def main(team, mult):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    d = E.load(inst, phase='dev'); m = load_strategy(team)
    p = dict(m.PARAMS); p[m.RISK_KEY] *= mult; sig = m.generate(d, p); R = RS.Ref(d)
    res = {}
    for name, (a, b) in dict(proof=E.WINDOWS['proof'], d23=('2022-07-01', '2023-12-31')).items():
        j0, j1 = d.idx(a, b)
        cnt = lambda rows: tuple(sum(1 for r in rows if r[1] == x) for x in ('pass', 'bust', 'timeout'))
        row = {'mimic': cnt(RS.combine_ref(R, sig, j0, j1, mode='mimic'))}
        for f in FLAGS: row[f] = cnt(RS.combine_ref(R, sig, j0, j1, mode=f))
        res[name] = row
    # fill-bar target and time-exit frequency on a continuous run
    i0, i1 = d.idx('2022-01-01', '2023-12-31'); r = RS.simulate(R, sig, i0, i1, enforce=False)
    tr = r['trades']; kind = sig['kind']; 
    print(json.dumps(dict(team=team, mult=mult, trades=len(tr), n_time=sum(1 for t in tr if t[7] == 5), n_tgt=sum(1 for t in tr if t[7] == 2),
                          tgt_on_entry_bar=sum(1 for t in tr if t[7] == 2 and t[0] == t[1]), res=res)), flush=True)
if __name__ == '__main__': main(sys.argv[1], float(sys.argv[2]))
