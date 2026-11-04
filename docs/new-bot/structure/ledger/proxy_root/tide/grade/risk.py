#!/usr/bin/env python3
"""MacRisk: sizing options A-E on the grade-review episode data. stdlib only.
run: nice -n 19 python3 -I risk.py SCRATCH   (SCRATCH = session scratchpad; imports tide/grade/quant.py for episodes, waves, volume)
Grade proxy = playbook section 23 (r3 team grade); outcomes = 2R first-touch (quant's) and an r2-exit proxy (2/3 at 1R, rest 2R or BE).
Sizing = playbook section 17: contracts = floor(grade $ / (stop pts x $2)), min 1 (no skipping for stop width). Cost $0.62/side/MNQ."""
import sys, os, json, csv, bisect, random, statistics as st, importlib.util
S = sys.argv[1]
sys.argv = ['quant.py', S]
spec = importlib.util.spec_from_file_location('quant', os.path.join(S, 'tide/grade/quant.py'))
Q = importlib.util.module_from_spec(spec); spec.loader.exec_module(Q)
m1, m1t, m5, m5t, ptmin = Q.m1, Q.m1t, Q.m5, Q.m5t, Q.ptmin

PT_USD, COST_SIDE, MLL = 2.0, 0.62, 4500.0
OPTS = {'A grade $900/600/300': {'A+': 900, 'B': 600, 'C': 300},
        'B flat $450': {'A+': 450, 'B': 450, 'C': 450},
        'C = A (practice)': {'A+': 900, 'B': 600, 'C': 300},
        'D compressed $600/450/300': {'A+': 600, 'B': 450, 'C': 300},
        'E flat $300': {'A+': 300, 'B': 300, 'C': 300}}
THR = {'A grade $900/600/300': None, 'B flat $450': None, 'C = A (practice)': None, 'D compressed $600/450/300': None, 'E flat $300': None}
HYB = {'H1 = A + throttle': ({'A+': 900, 'B': 600, 'C': 300}, (2000, 300)),
       'H2 = D + throttle': ({'A+': 600, 'B': 450, 'C': 300}, (2000, 300))}

# stacked pool = another level within tolerance (setups.csv also_in_tol)
STK = {}
for r in csv.DictReader(open(os.path.join(S, 'tide/study/fixes_on/setups.csv'))):
    STK[(Q.ts(r['time_pt']), r['dir'], r['level'])] = r['also_in_tol'] != ''

def force(x):
    """breaking-wave leg (max excursion beyond the level, 1m, break -> retest bar) vs 2x mean 5m range of the 20 bars before the wave."""
    ws = x['rb'] - x['wave_min'] * 60
    i0, i1 = bisect.bisect_left(m1t, ws), bisect.bisect_left(m1t, x['rb'])
    if i1 <= i0: return None
    ext = max((b['h'] - x['L']) if x['d'] > 0 else (x['L'] - b['l']) for b in m1[i0:i1 + 1])
    j = bisect.bisect_left(m5t, ws)
    if j < 20: return None
    atr = sum(m5[q]['h'] - m5[q]['l'] for q in range(j - 20, j)) / 20
    return ext >= 2 * atr

def grade_r3(x):
    if x['peak'] < 0.20: return 'no trade', None
    stacked = STK.get((x['T'], 'SHORT' if x['d'] < 0 else 'LONG', x['level']), False)
    pts = dict(trap=x['kind'] == 'trap' and (x['level'] in Q.STRONG or stacked),
               force=force(x), vol=None if x['pbvol'] is None else x['pbvol'] < 1.0,
               timing=x['nearopen'], band=0.30 <= x['peak'] < 0.40)
    p = sum(1 for v in pts.values() if v)
    g = 'A+' if p >= 4 else 'B' if p == 3 else 'C'
    if x['peak'] >= 0.40: g = 'C'
    return g, pts

def grade_q2(x):  # quant's 2-point fallback
    if x['peak'] < 0.20: return 'no trade'
    p = (0.30 <= x['peak'] < 0.40) + (x['pbvol'] is not None and x['pbvol'] < 1.0)
    return {2: 'A+', 1: 'B', 0: 'C'}[p]

def r2exit(x):
    """2/3 off at +1R (TP1), stop -> BE, last 1/3 to +2R or BE. Same 1m bar: stop first. Flat at 14:00 PT MTM. No pyramid/upgrade adds."""
    d, e, s = x['d'], x['entry'], x['stop']; R = abs(e - s); t1, t2 = e + d * R, e + d * 2 * R
    i = bisect.bisect_left(m1t, x['T']); tp1 = False
    for b in m1[i:]:
        m = ptmin(b['t'])
        if 840 <= m < 900:
            mtm = (b['o'] - e) * d / R
            return (2 / 3 + max(0.0, min(2, mtm)) / 3) if tp1 else max(-1.0, min(2.0, mtm))
        hi_fav = (b['h'] - e) * d if d > 0 else (e - b['l'])
        lo_adv = (e - b['l']) if d > 0 else (b['h'] - e)
        if not tp1:
            if lo_adv >= R: return -1.0
            if hi_fav >= R:
                tp1 = True
                if hi_fav >= 2 * R: return 2 / 3 + 2 / 3
            continue
        if lo_adv >= 0: return 2 / 3           # back to breakeven (checked first: conservative)
        if hi_fav >= 2 * R: return 2 / 3 + 2 / 3
    mtm = (m1[-1]['c'] - e) * d / R
    return (2 / 3 + max(0.0, min(2, mtm)) / 3) if tp1 else max(-1.0, min(2.0, mtm))

def usd(x, dollars, r):
    ctr = max(1, int(dollars // (x['R'] * PT_USD)))
    return ctr * x['R'] * PT_USD * r - ctr * 2 * COST_SIDE, ctr * x['R'] * PT_USD

def run_path(seq, opt, per_day, thr=None):
    """seq = [(trade, R outcome)] in order. EOD trailing MLL: floor = max EOD balance - 4500, never above the start (Topstep lock);
    breach if the closed balance after any trade < floor (open-trade heat ignored). thr = (cushion $, fallback $): when balance - floor
    < cushion, every grade is sized at the fallback $ (a size throttle, not a loss limit). per_day: int (chunks) or list of day ids."""
    bal = peak_eod = 0.0; floor = -MLL; breach = False; pk = 0.0; mdd = 0.0; pn = []
    days = per_day if isinstance(per_day, list) else [k // per_day for k in range(len(seq))]
    for k, (x, r) in enumerate(seq):
        dol = opt[x['g']]
        if thr and bal - floor < thr[0]: dol = min(dol, thr[1])
        p = usd(x, dol, r)[0]; pn.append(p); bal += p
        if bal < floor - 1e-9: breach = True
        pk = max(pk, bal); mdd = max(mdd, pk - bal)
        if k == len(seq) - 1 or days[k + 1] != days[k]:
            peak_eod = max(peak_eod, bal); floor = min(0.0, peak_eod - MLL)
    return bal, mdd, breach, pn

def boot(rows, opt, key, n, per_day, mode=None, thr=None, B=2000, seed=11):
    """resample n trades with replacement. mode: None = as observed; 'apc' = A+ trades keep A+ SIZE but draw their outcome from the C pool
    (A+ performs like C); 'swap' = A+ <-> C outcome pools (grades fully backwards)."""
    rnd = random.Random(seed); pool = {g: [x[key] for x in rows if x['g'] == g] for g in ('A+', 'B', 'C')}
    MAP = {'apc': {'A+': 'C'}, 'swap': {'A+': 'C', 'C': 'A+'}}.get(mode, {})
    ends, br = [], 0
    for _ in range(B):
        seq = []
        for _ in range(n):
            x = rows[rnd.randrange(len(rows))]; g2 = MAP.get(x['g'])
            seq.append((x, rnd.choice(pool[g2]) if g2 and pool[g2] else x[key]))
        e, m, b, _ = run_path(seq, opt, per_day, thr); ends.append(e); br += b
    ends.sort()
    return dict(pb=br / B, med=ends[B // 2], p10=ends[B // 10])

def perm_breach(rows, opt, key, per_day, thr=None, B=2000, seed=5):
    rnd = random.Random(seed); seq0 = [(x, x[key]) for x in rows]; br = 0
    for _ in range(B):
        seq = seq0[:]; rnd.shuffle(seq); br += run_path(seq, opt, per_day, thr)[2]
    return br / B

if __name__ == '__main__':
    EPF = [e['m'][0] for e in Q.EP]; TK = [x for x in Q.X if x['taken']]
    for x in Q.X:
        if x['ep_first'] or x['taken']:
            x['g'], x['pts'] = grade_r3(x); x['gq'] = grade_q2(x); x['r2'] = r2exit(x); x['r2f'] = x['res']
    O = ['# Sizing options A-E: risk simulation (MacRisk, 11/04)', '']
    # ---- factor availability and grade mix
    O += ['## 1. Grade proxy (playbook section 23, r3) and mix', '']
    for nm, rows in (('episodes', EPF), ('taken-if-flat', TK)):
        gate = [x for x in rows if x['g'] != 'no trade']
        miss = {k: sum(1 for x in gate if x['pts'][k] is None) for k in ('trap', 'force', 'vol', 'timing', 'band')}
        hit = {k: sum(1 for x in gate if x['pts'][k]) for k in ('trap', 'force', 'vol', 'timing', 'band')}
        O.append('- %s n=%d, pass gate (peak>=0.20) %d. Points scored / not computable: %s' % (nm, len(rows), len(gate),
                 ', '.join('%s %d/%d' % (k, hit[k], miss[k]) for k in hit)))
        for gk, lab in (('g', 'r3 proxy'), ('gq', 'quant 2-pt')):
            parts = []
            for g in ('A+', 'B', 'C', 'no trade'):
                a = [x for x in rows if x[gk] == g]
                if a: parts.append('%s %d (%.0f%%) 2R-first %.0f%% avg %+.2fR / r2 %+.2fR' % (g, len(a), 100 * len(a) / len(rows),
                                   100 * sum(x['win'] for x in a) / len(a), sum(x['res'] for x in a) / len(a), sum(x['r2'] for x in a) / len(a)))
            O.append('  - %s: %s' % (lab, '; '.join(parts)))
    O.append('')
    # ---- simulations
    R = {}
    for setname, rows0 in (('taken-if-flat', TK), ('episodes', EPF)):
        for gk in ('g', 'gq'):
            rows = [dict(x, g=x[gk]) for x in rows0 if x[gk] != 'no trade']; rows.sort(key=lambda x: x['T'])
            ndays = len({x['td'] for x in rows}); per_day = max(1, round(len(rows) / ndays))
            O += ['## %s, grade = %s (n=%d traded after the peak gate, %d TradeDays, %d trades/day used in the bootstrap)' % (
                setname, 'r3 proxy' if gk == 'g' else 'quant 2-pt fallback', len(rows), ndays, per_day), '']
            for key, kl in (('r2f', '2R first-touch'), ('r2', 'r2-exit proxy (2/3 at 1R, rest 2R or BE)')):
                O += ['### outcome: %s' % kl, '',
                      '| option | actual total $ | actual max DD $ | per-trade $ p10 / med / p90 (worst) | avg risk $ A+/B/C | shuffle P(breach) | n-boot P / med / p10 | 30-boot P / med / p10 | STRESS A+ like C, 30-boot P / med / p10 | STRESS swap A+<->C, 30-boot P / med / p10 | STRESS A+ like C, n-boot P / med |',
                      '|---|---|---|---|---|---|---|---|---|---|---|']
                allo = [(on, opt, None) for on, opt in OPTS.items()] + [(on, o, t) for on, (o, t) in HYB.items()]
                for on, opt, thr in allo:
                    tot, mdd, _, pn = run_path([(x, x[key]) for x in rows], opt, [x['td'] for x in rows], thr)
                    q = sorted(pn); rk = {g: [usd(x, opt[g], 0)[1] for x in rows if x['g'] == g] for g in ('A+', 'B', 'C')}
                    bn = boot(rows, opt, key, len(rows), per_day, None, thr); b30 = boot(rows, opt, key, 30, per_day, None, thr)
                    s30 = boot(rows, opt, key, 30, per_day, 'apc', thr); w30 = boot(rows, opt, key, 30, per_day, 'swap', thr)
                    sn = boot(rows, opt, key, len(rows), per_day, 'apc', thr); pb = perm_breach(rows, opt, key, per_day, thr)
                    R[(setname, gk, key, on)] = dict(tot=tot, mdd=mdd, pb=pb, bn=bn, b30=b30, s30=s30, w30=w30, sn=sn, worst=q[0])
                    O.append('| %s | %+.0f | %.0f | %+.0f / %+.0f / %+.0f (%+.0f) | %s | %.1f%% | %.1f%% / %+.0f / %+.0f | %.1f%% / %+.0f / %+.0f | %.1f%% / %+.0f / %+.0f | %.1f%% / %+.0f / %+.0f | %.1f%% / %+.0f |' % (
                        on, tot, mdd, q[len(q) // 10], q[len(q) // 2], q[int(len(q) * .9)], q[0],
                        '/'.join('%.0f' % (sum(rk[g]) / len(rk[g])) if rk[g] else '-' for g in ('A+', 'B', 'C')),
                        100 * pb, 100 * bn['pb'], bn['med'], bn['p10'], 100 * b30['pb'], b30['med'], b30['p10'],
                        100 * s30['pb'], s30['med'], s30['p10'], 100 * w30['pb'], w30['med'], w30['p10'], 100 * sn['pb'], sn['med']))
                O.append('')
    open(os.path.join(S, 'tide/grade/RISK_tables.md'), 'w').write('\n'.join(O) + '\n')
    json.dump({' | '.join(k): v for k, v in R.items()}, open(os.path.join(S, 'tide/grade/risk_results.json'), 'w'), indent=0)
    print('\n'.join(O))
