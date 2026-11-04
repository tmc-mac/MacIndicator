#!/usr/bin/env python3
"""Whole-contract variant of risk.py: the TP1 partial uses the money lib's integer rule
(n=1 -> no partial, runner only with BE after +1R; n>=2 -> max(1, min(n-1, round(2n/3)))). Everything else as risk.py."""
import sys, os, importlib.util, bisect
S = sys.argv[1]
sys.argv = ['risk.py', S]
spec = importlib.util.spec_from_file_location('risk', os.path.join(S, 'tide/grade/risk.py'))
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
Q = R.Q; m1, m1t, ptmin = R.m1, R.m1t, R.ptmin

def parts(x):
    """(tp1_hit, runner_R, full_R): same path logic as risk.r2exit."""
    d, e, s = x['d'], x['entry'], x['stop']; Rr = abs(e - s); i = bisect.bisect_left(m1t, x['T']); tp1 = False
    for b in m1[i:]:
        m = ptmin(b['t'])
        if 840 <= m < 900:
            mtm = (b['o'] - e) * d / Rr
            return (True, max(0.0, min(2, mtm)), None) if tp1 else (False, None, max(-1.0, min(2.0, mtm)))
        hi = (b['h'] - e) * d if d > 0 else (e - b['l']); lo = (e - b['l']) if d > 0 else (b['h'] - e)
        if not tp1:
            if lo >= Rr: return (False, None, -1.0)
            if hi >= Rr:
                tp1 = True
                if hi >= 2 * Rr: return (True, 2.0, None)
            continue
        if lo >= 0: return (True, 0.0, None)
        if hi >= 2 * Rr: return (True, 2.0, None)
    mtm = (m1[-1]['c'] - e) * d / Rr
    return (True, max(0.0, min(2, mtm)), None) if tp1 else (False, None, max(-1.0, min(2.0, mtm)))

def pcount(n): return max(1, min(n - 1, round(n * 2 / 3 + 1e-9))) if n >= 2 else 0

def usd_int(x, dollars, r):
    ctr = max(1, int(dollars // (x['R'] * R.PT_USD))); risk = ctr * x['R'] * R.PT_USD
    if r == 0: return 0.0, risk
    tp1, run, full = r
    if not tp1: rm = ctr * full
    else: k = pcount(ctr); rm = k * 1.0 + (ctr - k) * run
    return rm * x['R'] * R.PT_USD - ctr * 2 * R.COST_SIDE, risk
R.usd = usd_int

TK = [x for x in Q.X if x['taken']]
for x in Q.X:
    if x['ep_first'] or x['taken']:
        x['g'], x['pts'] = R.grade_r3(x); x['gq'] = R.grade_q2(x); x['r2'] = R.r2exit(x); x['r2i'] = parts(x)
out = ['| option | grade | whole-contract: normal 30-boot P / med | stress A+ like C 30-boot P / med | fractional (old) normal / stress | share of trades 1 MNQ / 2 MNQ |', '|---|---|---|---|---|---|']
for gk, gl in (('g', 'r3'), ('gq', 'quant')):
    rows = [dict(x, g=x[gk]) for x in TK if x[gk] != 'no trade']; rows.sort(key=lambda x: x['T'])
    nd = len({x['td'] for x in rows}); pd = max(1, round(len(rows) / nd))
    for on, opt in R.OPTS.items():
        if on.startswith('C ='): continue
        b = R.boot(rows, opt, 'r2i', 30, pd); s = R.boot(rows, opt, 'r2i', 30, pd, 'apc')
        cts = [max(1, int(opt[x['g']] // (x['R'] * R.PT_USD))) for x in rows]
        # old fractional numbers from risk_results.json
        import json; old = json.load(open(os.path.join(S, 'tide/grade/risk_results.json'))).get(' | '.join(('taken-if-flat', gk, 'r2', on)))
        ob = '%.1f%% / %+.0f ; %.1f%% / %+.0f' % (100*old['b30']['pb'], old['b30']['med'], 100*old['s30']['pb'], old['s30']['med']) if old else '-'
        out.append('| %s | %s | %.1f%% / %+.0f | %.1f%% / %+.0f | %s | %.0f%% / %.0f%% |' % (on, gl, 100*b['pb'], b['med'], 100*s['pb'], s['med'], ob,
                   100*sum(c == 1 for c in cts)/len(cts), 100*sum(c == 2 for c in cts)/len(cts)))
print('n trades r3 gate:', len([x for x in TK if x['g'] != 'no trade']))
print('\n'.join(out))
