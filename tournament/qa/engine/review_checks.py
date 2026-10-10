"""(a) TUNABLE coverage per team   (b) lookahead_check blindness demo with a deliberately cheating generator."""
import sys, os, json
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from diff_teams import *
import glob
print('--- TUNABLE coverage (numeric non-bool PARAMS not listed in TUNABLE, excluding RISK_KEY)')
for p in sorted(glob.glob(os.path.join(ENG, '..', 'teams', '*', 'strategy.py'))):
    t = p.split(os.sep)[-2]
    try: m = load_strategy(t)
    except Exception as e: print(t, 'load error', e); continue
    num = [k for k, v in m.PARAMS.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and k != getattr(m, 'RISK_KEY', None)]
    tun = list(getattr(m, 'TUNABLE', [])); un = [k for k in num if k not in tun]
    print(f'{t:6s} numeric={len(num):2d} tunable={len(tun):2d} NOT perturbed={len(un):2d} {un}')
print('--- lookahead_check on a CHEATING generator (side = sign of close 30 bars in the FUTURE)')
d = E.load('NQ', phase='design')
def cheat(d, params):
    i = np.arange(0, d.n - 40, 15)
    fut = d.c[i + 30] - d.c[i]
    side = np.where(fut > 0, 1, -1)
    stop = np.where(side == 1, d.c[i] - 5, d.c[i] + 5)
    return E.make_signals(i, side, np.zeros(len(i), int), np.full(len(i), np.nan), stop, np.full(len(i), np.nan), i + 30, i + 30, np.full(len(i), 1))
print('cheater passes lookahead_check (True = declared CLEAN):', E.lookahead_check(d, cheat, {}))
i0, i1 = d.idx('2023-01-01', '2023-03-31'); r = E.run(d, cheat(d, {}), i0, i1, enforce=False)
print('cheater 3-month net with 1 micro:', round(r['net']), 'PF', round(r['pf'], 2), 'trades', r['trades'])
# proper check: truncate at k exactly
def strict_check(data, generate, params, n_checks=5, span=60_000):
    full = generate(data, params); rng = np.random.default_rng(11); ok = True
    for _ in range(n_checks):
        k = int(rng.integers(span, data.n - 5000)); sub = E._truncate(data, k); part = generate(sub, params)
        a = full['bar'] < k - 1; b = part['bar'] < k - 1
        for key in ('bar', 'side', 'px', 'stop', 'contracts'):
            x, y = full[key][a], part[key][b]
            if len(x) != len(y) or not np.allclose(np.nan_to_num(x), np.nan_to_num(y)): ok = False
    return ok
print('strict_check (truncate exactly at k) on the cheater:', strict_check(d, cheat, {}))
