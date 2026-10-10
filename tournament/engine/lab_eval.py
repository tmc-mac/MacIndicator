"""NQ-5 combine lab evaluator.
  python3 lab_eval.py <strategy.py path> [--agent NAME] [--proof] [--mult 3]
Prints month-start and dense-start combine stats on the DESIGN window (always) and, with --proof, on the hidden
PROOF year (aggregate only; budget = 3 looks per agent, counted in lab/proof_looks.json).  Hold-out is never available.
Metrics: P60 = passed within 60 sessions; P120 = passed within 120 sessions ('eventual'); B = busted within 120;
days = median calendar days to pass.  Strategy module: PARAMS, RISK_KEY, generate(d, params), optional GOV (risk-governor dict)."""
import sys, os, json, importlib.util, argparse
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, pandas as pd

def load_mod(path):
    spec = importlib.util.spec_from_file_location('labstrat', path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def starts_monthly(d, i0, i1, cap):
    t = pd.to_datetime(d.ts[i0:i1], unit='s'); df = pd.DataFrame({'i': np.arange(i0, i1), 'day': d.day[i0:i1], 'ym': t.strftime('%Y-%m')})
    first = df.groupby('ym').first(); days = np.unique(d.day[i0:i1]); out = []
    for ym, r in first.iterrows():
        k = int(np.searchsorted(days, r['day']))
        if k + cap >= len(days): continue
        out.append((ym, int(r['i']), int(np.searchsorted(d.day, days[k + cap]))))
    return out

def run_starts(E, d, sig, gov, starts, slip=1.0):
    rows = []
    for ym, a, b in starts:
        r = E.run(d, sig, a, b, enforce=True, slip=slip, stop_on_pass=True, gov=gov)
        res = 'bust' if r['bust'] else ('pass' if r['passed'] else 'timeout')
        dp = (r['passed_ts'] - d.ts[a]) / 86400 if r['passed'] else np.nan
        sd = np.searchsorted(np.unique(d.day[a:b]), d.day[a:b][np.searchsorted(d.ts[a:b], r['passed_ts'])]) + 1 if r['passed'] else np.nan
        rows.append(dict(start=ym, res=res, net=r['net'], dd=r['max_dd'], days=dp, sessions=sd, trades=r['trades']))
    return pd.DataFrame(rows)

def summarize(df60, df120):
    P60 = float((df60.res == 'pass').mean()) if len(df60) else float('nan')
    P120 = float((df120.res == 'pass').mean()) if len(df120) else float('nan')
    B120 = float((df120.res == 'bust').mean()) if len(df120) else float('nan')
    B60 = float((df60.res == 'bust').mean()) if len(df60) else float('nan')
    return dict(P60=round(P60, 3), B60=round(B60, 3), P120=round(P120, 3), B120=round(B120, 3),
                med_days=round(float(np.nanmedian(df120.days)), 1) if (df120.res == 'pass').any() else None, n60=len(df60), n120=len(df120))

def evaluate(E, d, sig, gov, window, step=3):
    i0, i1 = d.idx(*E.WINDOWS[window])
    out = {}
    m60 = run_starts(E, d, sig, gov, starts_monthly(d, i0, i1, 60)); m120 = run_starts(E, d, sig, gov, starts_monthly(d, i0, i1, 120))
    out['monthly'] = summarize(m60, m120)
    days = np.unique(d.day[i0:i1]); first = np.searchsorted(d.day, days)
    def dense(cap):
        return [(str(k), int(first[k]), int(first[k + cap])) for k in range(0, len(days), step) if k + cap < len(days)]
    d60 = run_starts(E, d, sig, gov, dense(60)); d120 = run_starts(E, d, sig, gov, dense(120))
    out['dense'] = summarize(d60, d120)
    return out, (m60, m120, d60, d120)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('path'); ap.add_argument('--agent', default='coordinator'); ap.add_argument('--proof', action='store_true'); ap.add_argument('--mult', type=float, default=1.0)
    a = ap.parse_args()
    import engine as E
    m = load_mod(a.path); params = dict(m.PARAMS); params[m.RISK_KEY] = params[m.RISK_KEY] * a.mult; gov = getattr(m, 'GOV', None)
    d = E.load('NQ', phase='design'); sig = m.generate(d, params)
    res, _ = evaluate(E, d, sig, gov, 'design'); print('DESIGN', json.dumps(res))
    if a.proof:
        logp = os.path.join(os.path.dirname(__file__), '..', 'lab', 'proof_looks.json')
        log = json.load(open(logp)) if os.path.exists(logp) else {}
        if log.get(a.agent, 0) >= 3 and a.agent != 'coordinator':
            print('PROOF BUDGET EXHAUSTED for', a.agent); sys.exit(0)
        os.environ['TOURNAMENT_COORDINATOR'] = '1'
        import importlib; importlib.reload(E)
        dd = E.load('NQ', phase='dev'); sig2 = m.generate(dd, params)
        res2, _ = evaluate(E, dd, sig2, gov, 'proof'); print('PROOF ', json.dumps(res2))
        log[a.agent] = log.get(a.agent, 0) + 1; json.dump(log, open(logp, 'w')); print('proof looks used by', a.agent, ':', log[a.agent], '/ 3')
