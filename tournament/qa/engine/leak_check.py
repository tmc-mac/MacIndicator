"""Direct leakage test: signals generated on DEV data (design+proof, what certify.py uses) vs on DESIGN-only data (what teams saw).
All signals decided before the design/proof boundary must be identical.  Also run a strict truncation lookahead check at random points."""
import sys, os, json
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from diff_teams import *
def sigcmp(a, b, kmax, keys=('bar', 'side', 'kind', 'px', 'stop', 'target', 'exit_by', 'cancel_by', 'contracts')):
    ma, mb = a['bar'] < kmax, b['bar'] < kmax
    if ma.sum() != mb.sum(): return f'count {ma.sum()} vs {mb.sum()}'
    bad = []
    for k in keys:
        x, y = a[k][ma], b[k][mb]
        if k in ('exit_by', 'cancel_by'): x, y = np.minimum(x, kmax), np.minimum(y, kmax)   # absolute bar idx may be capped at data end
        if not np.allclose(np.nan_to_num(x, nan=-9e9), np.nan_to_num(y, nan=-9e9)): bad.append(k)
    return bad
def main(team):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    dev = E.load(inst, phase='dev'); des = E.load(inst, phase='design'); m = load_strategy(team)
    out = dict(team=team)
    try:
        a = m.generate(dev, m.PARAMS); b = m.generate(des, m.PARAMS)
        out['dev_vs_design_boundary'] = sigcmp(a, b, des.n - 1)
        rng = np.random.default_rng(5); bad = 0; chk = 0
        for _ in range(4):
            k = int(rng.integers(100_000, des.n - 5000)); sub = E._truncate(dev, k); part = m.generate(sub, m.PARAMS)
            r = sigcmp(a, part, k - 1, keys=('bar', 'side', 'px', 'stop', 'contracts')); chk += 1
            if r != []: bad += 1
        out['strict_truncation_fail'] = f'{bad}/{chk}'
    except Exception as e:
        out['error'] = repr(e)[:200]
    print(json.dumps(out, default=str), flush=True)
if __name__ == '__main__': main(sys.argv[1])
