"""Research runner.  python engine/run_team.py <TEAM> <window> [--official]
Windows visible to teams: train.  'validate' is reserved for the coordinator (--official)."""
import sys, importlib.util, json, os
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, engine as E

def load_strategy(team):
    p = os.path.join(os.path.dirname(__file__), '..', 'teams', team, 'strategy.py')
    spec = importlib.util.spec_from_file_location('strategy_' + team.replace('-', '_'), p)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def evaluate(team, window, official=False, check=True):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    if window == 'validate' and not official:
        raise SystemExit('validate window is reserved for the coordinator')
    d = E.load(inst, research=True)
    m = load_strategy(team)
    sig = m.generate(d, m.PARAMS)
    i0, i1 = d.idx(*E.WINDOWS[window])
    raw = E.run(d, sig, i0, i1, enforce=False)           # gate stats: account rules off
    roll = E.summarize_rolling(E.rolling_evals(d, sig, i0, i1))
    out = dict(team=team, window=window, raw=E.brief(raw), rolling=roll)
    if check:
        out['lookahead_clean'] = E.lookahead_check(d, m.generate, m.PARAMS)
    out['_raw'] = raw
    return out

if __name__ == '__main__':
    team, window = sys.argv[1], sys.argv[2]
    r = evaluate(team, window, official='--official' in sys.argv)
    r.pop('_raw'); print(json.dumps(r, indent=1))
