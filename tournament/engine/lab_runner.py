"""Builds the Combine Lab dataset for a strategy version -> lab/versions/<id>.json and merges into lab/lab_state.json.
python3 lab_runner.py <id> "<label>" <strategy.py> --mult 3 [--note "..."]   (coordinator-only: uses full data incl. hold-out)"""
import sys, os, json, argparse, datetime as dt
sys.path.insert(0, os.path.dirname(__file__)); os.environ['TOURNAMENT_COORDINATOR'] = '1'
import numpy as np, pandas as pd, engine as E
E.FILLMODE = int(os.environ.get('LAB_FILLMODE', E.FILLMODE))
from lab_eval import load_mod, starts_monthly

LAB = os.path.join(os.path.dirname(__file__), '..', 'lab'); START_PERIODS = None

def period_of(ym):
    return 'design' if ym <= '2024-06' else ('proof' if ym <= '2025-06' else 'holdout')

def one(E, d, sig, gov, a, b):
    r = E.run(d, sig, a, b, enforce=True, stop_on_pass=True, gov=gov)
    days_u = np.unique(d.day[a:b])
    sess = lambda ts: int(np.searchsorted(days_u, d.day[a:b][min(np.searchsorted(d.ts[a:b], ts), b - a - 1)])) + 1
    res = 'bust' if r['bust'] else ('pass' if r['passed'] else 'timeout')
    ev = sess(r['passed_ts']) if r['passed'] else (sess(r['bust_ts']) if r['bust'] else None)
    # daily curve [day_epoch, eod_equity, floor, day_pnl]
    cum = 50000.0; peak = 50000.0; curve = []
    for dd_, p in zip(r['daily_day'], r['daily_pnl']):
        cum += p; peak = max(peak, cum); curve.append([int(dd_) * 86400, round(cum, 1), round(peak - 2000, 1), round(float(p), 1)])
    return dict(res=res, ev_sess=ev, net=round(r['net'], 1), dd=round(r['max_dd'], 1), trades=r['trades'], curve=curve,
                days=round((r['passed_ts'] - d.ts[a]) / 86400, 1) if r['passed'] else None, pass_ts=int(r['passed_ts']) if r['passed'] else 0,
                bust_ts=int(r['bust_ts']) if r['bust'] else 0)

def at_cap(row, cap):
    if row['res'] == 'pass' and row['ev_sess'] <= cap: return 'pass'
    if row['res'] == 'bust' and row['ev_sess'] <= cap: return 'bust'
    return 'timeout'

def stats(rows, cap):
    rs = [at_cap(r, cap) for r in rows]; n = len(rs)
    if n == 0: return dict(n=0, pass_rate=None, bust_rate=None, timeout_rate=None, median_days=None)
    ds = [r['days'] for r, x in zip(rows, rs) if x == 'pass' and r['days'] is not None]
    return dict(n=n, pass_rate=round(rs.count('pass') / n, 4), bust_rate=round(rs.count('bust') / n, 4), timeout_rate=round(rs.count('timeout') / n, 4),
                median_days=round(float(np.median(ds)), 1) if ds else None)

def build(vid, label, path, mult, note='', sizing_sweep=True):
    m = load_mod(path); params = dict(m.PARAMS); params[m.RISK_KEY] = params[m.RISK_KEY] * mult; gov = getattr(m, 'GOV', None)
    d = E.load('NQ', phase='full'); sig = m.generate(d, params)
    months = []
    for ym, a, b in starts_monthly(d, 0, d.n, 120):
        row = one(E, d, sig, gov, a, b); row.update(month=ym, period=period_of(ym)); months.append(row)
    # most-recent months (cap 120 not available): add shorter-window starts with whatever data remains, flagged as 'open'
    ends = {r['month'] for r in months}
    t = pd.to_datetime(d.ts, unit='s').strftime('%Y-%m'); first = pd.Series(np.arange(d.n)).groupby(t).first()
    for ym, a in first.items():
        if ym in ends or ym < '2021-10': continue
        row = one(E, d, sig, gov, int(a), d.n); row.update(month=ym, period=period_of(ym), censored=True); months.append(row)
    months.sort(key=lambda r: r['month'])
    # dense starts (every 3 sessions)
    days = np.unique(d.day); first_bar = np.searchsorted(d.day, days)
    dense = []
    for k in range(0, len(days) - 120, 3):
        row = one(E, d, sig, gov, int(first_bar[k]), int(first_bar[k + 120]))
        ym = pd.Timestamp(int(d.ts[first_bar[k]]), unit='s').strftime('%Y-%m'); dense.append(dict(month=ym, period=period_of(ym), res=row['res'], ev_sess=row['ev_sess'], days=row['days'], net=row['net'], dd=row['dd']))
    full = [r for r in months if not r.get('censored')]
    summ = {}
    for per in ('all', 'design', 'proof', 'holdout'):
        mm = [r for r in full if per == 'all' or r['period'] == per]; dd_ = [r for r in dense if per == 'all' or r['period'] == per]
        summ[per] = dict(monthly60=stats(mm, 60), monthly120=stats(mm, 120), dense60=stats(dd_, 60), dense120=stats(dd_, 120))
    hist = {}
    for per in ('all', 'design', 'proof', 'holdout'):
        ds = [r['days'] for r in dense if r['res'] == 'pass' and r['days'] is not None and (per == 'all' or r['period'] == per)]
        hist[per] = np.histogram(ds, bins=[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 160, 400])[0].tolist() if ds else [0] * 13
    sweep = []
    if sizing_sweep:
        for k in (1, 1.5, 2, 2.5, 3, 4, 5, 6):
            p2 = dict(m.PARAMS); p2[m.RISK_KEY] = m.PARAMS[m.RISK_KEY] * k; s2 = m.generate(d, p2); rows = []
            for kk in range(0, len(days) - 120, 9):
                r = one(E, d, s2, gov, int(first_bar[kk]), int(first_bar[kk + 120])); rows.append(dict(res=r['res'], ev_sess=r['ev_sess'], days=r['days']))
            sweep.append(dict(mult=k, risk=round(m.PARAMS[m.RISK_KEY] * k), **{x: stats(rows, 60)[x] for x in ('pass_rate', 'bust_rate', 'timeout_rate')}, pass120=stats(rows, 120)['pass_rate']))
    tape = E.run(d, sig, 0, d.n, enforce=False, gov=gov)
    out = dict(id=vid, label=label, note=note, mult=mult, risk=round(params[m.RISK_KEY]), gov=gov, built=dt.datetime.utcnow().replace(microsecond=0).isoformat(),
               params={k: (v if isinstance(v, (int, float, str, bool)) else str(v)) for k, v in params.items()},
               months=months, summary=summ, hist_days=hist, sweep=sweep,
               raw=dict(pf=round(tape['pf'], 3), wr=round(tape['win_rate'], 3), trades=tape['trades'], tpd=round(tape['trades_per_day'], 2), net=round(tape['net'])))
    os.makedirs(LAB + '/versions', exist_ok=True); json.dump(out, open(f'{LAB}/versions/{vid}.json', 'w'), default=float)
    return out

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('id'); ap.add_argument('label'); ap.add_argument('path'); ap.add_argument('--mult', type=float, default=1.0); ap.add_argument('--note', default='')
    a = ap.parse_args(); o = build(a.id, a.label, a.path, a.mult, a.note)
    print(a.id, json.dumps({k: {x: v[x]['pass_rate'] for x in ('monthly60', 'monthly120', 'dense60')} for k, v in o['summary'].items()}))
