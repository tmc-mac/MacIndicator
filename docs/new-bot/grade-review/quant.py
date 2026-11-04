#!/usr/bin/env python3
"""MacGradeQuant: which setup factors separate 2R-first winners from full stops. stdlib only.
run: nice -n 19 python3 -I quant.py SCRATCH   (SCRATCH = session scratchpad; reads tide/study/fixes_on/*.csv, replay1104/data/m1,m5)
Outcome: +2R before the auto rule-C stop (setups.csv `stop`), first touch on 1m from the entry minute, same 1m = stop,
flat at the 14:00 PT close (marked to market, clipped to [-1,+2]); data end = censored (MTM, flagged)."""
import csv, json, sys, os, random, statistics as st, datetime as D, bisect
from zoneinfo import ZoneInfo
PT = ZoneInfo('America/Los_Angeles')
S = sys.argv[1]
SET = os.path.join(S, 'tide/study/fixes_on/setups.csv'); RD = os.path.join(S, 'tide/study/fixes_on/readings.csv')
m1 = sorted(json.load(open(os.path.join(S, 'replay1104/data/m1.json'))), key=lambda b: b['t'])
m5 = sorted(json.load(open(os.path.join(S, 'replay1104/data/m5.json'))), key=lambda b: b['t'])
m1t = [b['t'] for b in m1]; m5t = [b['t'] for b in m5]

def ts(lbl, year=2026):
    md, hm = lbl.split(' '); mo, dd = map(int, md.split('-')); hh, mi = map(int, hm.split(':'))
    return int(D.datetime(year, mo, dd, hh, mi, tzinfo=PT).timestamp())
def ptmin(t):
    d = D.datetime.fromtimestamp(t, PT); return d.hour * 60 + d.minute

RDG = {}
for r in csv.DictReader(open(RD)):
    RDG[ts(r['time_pt'])] = (float(r['score15']), float(r['score30']))
rdt = sorted(RDG)

def our(t, d):
    s = RDG.get(t)
    return None if s is None else max(d * s[0], d * s[1])

def outcome(T, d, entry, stop):
    R = abs(entry - stop); tgt = entry + d * 2 * R
    i = bisect.bisect_left(m1t, T)
    for b in m1[i:]:
        m = ptmin(b['t'])
        if 840 <= m < 900:
            return max(-1, min(2, (b['o'] - entry) * d / R)), 'close', b['t']
        hs = (b['h'] >= stop) if d < 0 else (b['l'] <= stop)
        ht = (b['l'] <= tgt) if d < 0 else (b['h'] >= tgt)
        if hs: return -1.0, 'stop', b['t'] + 60
        if ht: return 2.0, 'win', b['t'] + 60
    return max(-1, min(2, (m1[-1]['c'] - entry) * d / R)), 'dataend', m1[-1]['t'] + 60

X = []
for r in csv.DictReader(open(SET)):
    d = -1 if r['dir'] == 'SHORT' else 1
    T = ts(r['time_pt']); rb = ts(r['retest_bar_pt']); L = float(r['level_px'])
    entry, stop = float(r['entry_ref']), float(r['stop'])
    x = dict(td=r['tradeday'], T=T, rb=rb, d=d, L=L, level=r['level'], kind=r['control_kind'], p4=r['h4_open_pt'], entry=entry, stop=stop,
             R=abs(entry - stop), taken=r['flat_only_taken'] == '1', label=r['time_pt'])
    x['res'], x['why'], x['exitT'] = outcome(T, d, entry, stop)
    x['win'] = x['why'] == 'win'
    # breaking wave: last 1m close crossing L our way before the retest bar (<= 240 min back); else the 60 min before the retest bar
    i = bisect.bisect_left(m1t, rb) - 1; brk = None
    while i > 0 and m1[i]['t'] >= rb - 14400:
        c, pc = m1[i]['c'], m1[i - 1]['c']
        if (d < 0 and c < L <= pc) or (d > 0 and c > L >= pc): brk = m1[i]['t']; break
        i -= 1
    x['nobreak'] = brk is None
    ws = brk if brk is not None else rb - 3600
    x['wave_min'] = (rb - ws) / 60
    vals = [our(t, d) for t in rdt[bisect.bisect_right(rdt, ws):bisect.bisect_right(rdt, rb)]]
    vals = [v for v in vals if v is not None]
    x['peak'] = max(vals) if vals else 0.0
    x['ebias'] = our(T, d) if our(T, d) is not None else 0.0
    # growing turn (r2): bias now vs least favourable of the last 5 samples >= 0.10
    last5 = [our(t, d) for t in range(T - 240, T + 1, 60) if our(t, d) is not None]
    x['grow'] = (x['ebias'] - min(last5) >= 0.10) if last5 else False
    # 5m candles of the wave: displacement + volume rhythm
    j0 = bisect.bisect_left(m5t, ws - ws % 300); j1 = bisect.bisect_left(m5t, rb)
    best = {}
    for th in (0.5, 0.6, 0.7):
        for k in (1.0, 1.5):
            best[(th, k)] = False
    for j in range(max(j0, 20), j1):
        b = m5[j]; rg = b['h'] - b['l']
        if rg <= 0: continue
        avg = sum(m5[q]['h'] - m5[q]['l'] for q in range(j - 20, j)) / 20
        bp = (b['c'] - b['o']) * d / rg
        for (th, k) in best:
            if bp >= th and rg >= k * avg: best[(th, k)] = True
    x['disp'] = best
    jb = bisect.bisect_right(m5t, (brk if brk else ws)) - 1
    if jb >= 20:
        bv = m5[jb]['v']; med = st.median(m5[q]['v'] for q in range(jb - 20, jb))
        x['brkvol'] = bv / med if med else 1.0
        seg = m5[jb + 1:j1 + 1]
        if seg:
            ext = (min if d < 0 else max)(range(len(seg)), key=lambda q: seg[q]['l'] if d < 0 else seg[q]['h'])
            pb = seg[ext:] or seg[-1:]
            x['pbvol'] = (sum(b['v'] for b in pb) / len(pb)) / bv if bv else 1.0
        else: x['pbvol'] = None
    else: x['brkvol'] = x['pbvol'] = None
    # touches of L (separate 5m visits within 2 pts) in the 24 h before the wave
    k0 = bisect.bisect_left(m5t, ws - 86400); k1 = bisect.bisect_left(m5t, ws); vis = 0; lastk = -99
    for k in range(k0, k1):
        b = m5[k]
        if b['l'] <= L + 2 and b['h'] >= L - 2:
            if k - lastk > 6: vis += 1
            lastk = k
    x['touches'] = vis
    m = ptmin(T)
    x['sess'] = 'Asia' if m >= 900 else 'London' if m < 390 else 'NY'
    x['nearopen'] = (0 <= m - 900 < 60) or (0 <= m < 60) or (0 <= m - 390 < 60)
    X.append(x)
X.sort(key=lambda x: x['T'])

# ---- episodes: same dir, level price within 3 pts, joined while the previous member is <= 60 min old or the first member's trade is still open
EP = []
for x in X:
    for e in reversed(EP):
        if e['d'] == x['d'] and abs(e['L'] - x['L']) <= 3 and (x['T'] - e['m'][-1]['T'] <= 3600 or x['T'] < e['m'][0]['exitT']):
            e['m'].append(x); x['ep'] = e; break
    else:
        e = dict(d=x['d'], L=x['L'], m=[x]); EP.append(e); x['ep'] = e
for n, e in enumerate(EP): e['id'] = n
# first retest = first episode at this level/dir in the 4H period
seen = {}
for e in EP:
    f = e['m'][0]; k = (f['p4'], f['d'], round(f['L'] * 4) / 4)
    seen[k] = seen.get(k, 0) + 1; e['retest_n'] = seen[k]
for x in X: x['first_retest'] = x['ep']['retest_n'] == 1; x['ep_first'] = x is x['ep']['m'][0]

STRONG = {'4H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low'}
F = [  # name, function -> True/False/None
    ('strong pool type (not 1H Open)', lambda x: x['level'] in STRONG),
    ('4H Open', lambda x: x['level'] == '4H Open'),
    ('PDH/PDL', lambda x: x['level'] in ('PDH', 'PDL')),
    ('session H/L (Asia/London)', lambda x: x['level'] in ('Asia High', 'Asia Low', 'London High', 'London Low')),
    ('1H Open', lambda x: x['level'] == '1H Open'),
    ('touches >= 2 (24h)', lambda x: x['touches'] >= 2),
    ('touches >= 3 (24h)', lambda x: x['touches'] >= 3),
    ('trap control (vs below/above)', lambda x: x['kind'] == 'trap'),
    ('strong-pool trap', lambda x: x['kind'] == 'trap' and x['level'] in STRONG),
    ('real break found (vs no-break rejection)', lambda x: not x['nobreak']),
    ('displacement 5m body>=50% range>=1.0x', lambda x: x['disp'][(0.5, 1.0)]),
    ('displacement body>=60% range>=1.0x', lambda x: x['disp'][(0.6, 1.0)]),
    ('displacement body>=70% range>=1.0x', lambda x: x['disp'][(0.7, 1.0)]),
    ('displacement body>=60% range>=1.5x', lambda x: x['disp'][(0.6, 1.5)]),
    ('first retest (first episode at level in 4H)', lambda x: x['first_retest']),
    ('wave peak >= 0.20', lambda x: x['peak'] >= 0.20),
    ('wave peak >= 0.25', lambda x: x['peak'] >= 0.25),
    ('wave peak >= 0.30', lambda x: x['peak'] >= 0.30),
    ('wave peak >= 0.35', lambda x: x['peak'] >= 0.35),
    ('wave peak >= 0.40 (exhaustion test)', lambda x: x['peak'] >= 0.40),
    ('entry-minute bias with us >= 0.15', lambda x: x['ebias'] >= 0.15),
    ('entry-minute bias against <= -0.15', lambda x: x['ebias'] <= -0.15),
    ('growing turn (5-min swing >= 0.10)', lambda x: x['grow']),
    ('break vol >= 1.5x 20-bar median', lambda x: None if x['brkvol'] is None else x['brkvol'] >= 1.5),
    ('pullback vol < break vol', lambda x: None if x['pbvol'] is None else x['pbvol'] < 1.0),
    ('session NY', lambda x: x['sess'] == 'NY'),
    ('session London', lambda x: x['sess'] == 'London'),
    ('session Asia', lambda x: x['sess'] == 'Asia'),
    ('within 60 min of a session open', lambda x: x['nearopen']),
    ('stop <= 40 pts', lambda x: x['R'] <= 40),
    ('stop <= 60 pts', lambda x: x['R'] <= 60),
    ('stop > 75 pts', lambda x: x['R'] > 75),
]

def boot(rows, f, B=2000, seed=7):
    lab = [(f(x), x['win'], x['res']) for x in rows]; lab = [l for l in lab if l[0] is not None]
    w = [l for l in lab if l[0]]; o = [l for l in lab if not l[0]]
    if len(w) < 3 or len(o) < 3: return None
    rate = lambda a: sum(l[1] for l in a) / len(a); er = lambda a: sum(l[2] for l in a) / len(a)
    rnd = random.Random(seed); dr, de = [], []
    for _ in range(B):
        a = [w[rnd.randrange(len(w))] for _ in w]; b = [o[rnd.randrange(len(o))] for _ in o]
        dr.append(rate(a) - rate(b)); de.append(er(a) - er(b))
    dr.sort(); de.sort(); q = lambda v, p: v[int(p * (len(v) - 1))]
    return dict(nw=len(w), no=len(o), rw=rate(w), ro=rate(o), d=rate(w) - rate(o), lo=q(dr, .05), hi=q(dr, .95),
                ew=er(w), eo=er(o), de=er(w) - er(o), elo=q(de, .05), ehi=q(de, .95))

def tbl(rows, title):
    out = ['### ' + title, '', '| factor | n with / without | 2R-first with / without | diff [90% CI] | avg R with / without | diff R [90% CI] |', '|---|---|---|---|---|---|']
    res = {}
    for nm, f in F:
        b = boot(rows, f); res[nm] = b
        if b is None: out.append('| %s | too few | | | | |' % nm); continue
        out.append('| %s | %d / %d | %.0f%% / %.0f%% | %+.0f pp [%+.0f, %+.0f] | %+.2f / %+.2f | %+.2f [%+.2f, %+.2f] |' % (
            nm, b['nw'], b['no'], 100 * b['rw'], 100 * b['ro'], 100 * b['d'], 100 * b['lo'], 100 * b['hi'], b['ew'], b['eo'], b['de'], b['elo'], b['ehi']))
    return out, res

def base(rows):
    n = len(rows); w = sum(x['win'] for x in rows)
    return '%d rows, 2R-first %d (%.0f%%), stop %d, close/data-end %d, avg R %+.2f' % (n, w, 100 * w / max(n, 1), sum(x['why'] == 'stop' for x in rows),
        sum(x['why'] in ('close', 'dataend') for x in rows), sum(x['res'] for x in rows) / max(n, 1))

if __name__ == '__main__':
    EPF = [e['m'][0] for e in EP]
    TK = [x for x in X if x['taken']]
    L = ['# Setup GRADE: quant evidence (MacGradeQuant, 11/04)', '']
    L.append('Data: tide/study/fixes_on/setups.csv (537 setups, TradeDays 10/28-11/04, last 1m bar 11/03 19:48 PT). Outcome = +2R before the auto rule-C stop '
             '(`stop` column), first touch on 1m from the entry minute, same 1m = stop, flat at 14:00 PT (MTM, clipped to [-1, +2]). Avg R = +2 / -1 / MTM.')
    L.append('')
    L.append('**Episode rule:** setups join one episode when same direction, level price within 3 pts (so 4H Open / 1H Open at one price merge), and the setup comes '
             '<= 60 min after the previous member OR before the first member\'s trade has resolved. Each episode is scored by its FIRST setup (what a bot would take).')
    L.append('')
    L.append('- All setups: ' + base(X)); L.append('- Episodes (first setup): ' + base(EPF)); L.append('- Taken-if-flat: ' + base(TK))
    L.append('- Episodes per TradeDay: ' + ', '.join('%s %d' % (td[5:], sum(1 for x in EPF if x['td'] == td)) for td in sorted({x['td'] for x in X})))
    L.append('- Median setups per episode %.0f, max %d.' % (st.median(len(e['m']) for e in EP), max(len(e['m']) for e in EP)))
    L.append('')
    t1, r1 = tbl(EPF, 'Per episode (n=%d), bootstrap over episodes, 2000 resamples' % len(EPF))
    t2, r2 = tbl(TK, 'Taken-if-flat (n=%d)' % len(TK))
    t3, r3 = tbl(X, 'All setups, for reference only (n=%d, NOT independent: CIs too narrow)' % len(X))
    L += t1 + [''] + t2 + [''] + t3 + ['']
    # peak buckets
    L.append('### Wave-peak buckets (episodes)'); L.append(''); L.append('| peak our way | n | 2R-first | avg R |'); L.append('|---|---|---|---|')
    for lo, hi in ((-9, .15), (.15, .20), (.20, .25), (.25, .30), (.30, .35), (.35, .40), (.40, .45), (.45, 9)):
        g = [x for x in EPF if lo <= x['peak'] < hi]
        if g: L.append('| %.2f-%.2f | %d | %.0f%% | %+.2f |' % (max(lo, -1), min(hi, 1), len(g), 100 * sum(x['win'] for x in g) / len(g), sum(x['res'] for x in g) / len(g)))
    L.append('')
    json.dump(dict(r_ep=r1, r_tk=r2), open(os.path.join(S, 'tide/grade/factors.json'), 'w'), indent=0, default=str)
    open(os.path.join(S, 'tide/grade/QUANT_tables.md'), 'w').write('\n'.join(L) + '\n')
    print('\n'.join(L))

# ---- grade proposal + walk-forward (train TradeDays 10/28-11/02, test 11/03-11/04)
def grade_rows(rows, lo, hi):
    out = []
    for x in rows:
        if x['peak'] < 0.20: g = 'no trade'
        else:
            p = (lo <= x['peak'] < hi) + (x['pbvol'] is not None and x['pbvol'] < 1.0)
            g = {2: 'A+', 1: 'B', 0: 'C'}[p]
        out.append((g, x))
    return out

def gsum(rows, lo, hi):
    G = grade_rows(rows, lo, hi); res = []
    for g in ('A+', 'B', 'C', 'no trade'):
        a = [x for gg, x in G if gg == g]
        res.append('%s n=%d (%.0f%%) 2R %s avgR %s' % (g, len(a), 100 * len(a) / max(len(rows), 1),
                   ('%.0f%%' % (100 * sum(x['win'] for x in a) / len(a))) if a else '-', ('%+.2f' % (sum(x['res'] for x in a) / len(a))) if a else '-'))
    return res

if __name__ == '__main__':
    tr = lambda rows: [x for x in rows if x['td'] <= '2026-11-02']; te = lambda rows: [x for x in rows if x['td'] >= '2026-11-03']
    best = None; grid = []
    for lo in (0.20, 0.25, 0.30):
        for hi in (0.35, 0.40, 0.45, 9):
            a = [x for x in tr(EPF) if lo <= x['peak'] < hi]; b = [x for x in tr(EPF) if x['peak'] >= 0.20 and not (lo <= x['peak'] < hi)]
            if len(a) < 8 or len(b) < 5: continue
            v = sum(x['res'] for x in a) / len(a) - sum(x['res'] for x in b) / len(b); grid.append((lo, hi, len(a), v))
            if best is None or v > best[3]: best = (lo, hi, len(a), v)
    W = ['## Walk-forward', '', 'Band fitted on TRAIN episodes (10/28-11/02) by avg-R difference vs peak>=0.20 outside the band:', '']
    W += ['- band [%.2f, %s): n_in %d, diff avg R %+.2f' % (g[0], '%.2f' % g[1] if g[1] < 9 else 'inf', g[2], g[3]) for g in grid]
    lo, hi = best[0], best[1]
    W += ['', '**Chosen band: %.2f <= peak < %s.** Grade = required peak >= 0.20; +1 band; +1 pullback volume < break-candle volume. A+ = 2, B = 1, C = 0.' % (lo, '%.2f' % hi if hi < 9 else 'inf'), '']
    for nm, rows in (('episodes TRAIN', tr(EPF)), ('episodes TEST 11/03-11/04', te(EPF)), ('taken-if-flat TRAIN', tr(TK)), ('taken-if-flat TEST', te(TK)), ('episodes ALL', EPF), ('taken-if-flat ALL', TK)):
        W.append('- %s (n=%d): ' % (nm, len(rows)) + '; '.join(gsum(rows, lo, hi)))
    # current proposal for comparison: required peak>=0.20, +1 strong pool, +1 disp(0.6,1.0), +1 first retest, +1 peak>=0.30 ; 4 A+, 3 B, 2 C
    W += ['', 'Current proposal (required peak>=0.20; +1 strong pool type, displacement 60%/1x, first retest, peak>=0.30; 4=A+, 3=B, 2=C, <2 none):', '']
    for nm, rows in (('episodes ALL', EPF), ('taken-if-flat ALL', TK), ('episodes TEST', te(EPF))):
        G = {}
        for x in rows:
            if x['peak'] < 0.20: g = 'no trade'
            else:
                p = (x['level'] in STRONG) + x['disp'][(0.6, 1.0)] + x['first_retest'] + (x['peak'] >= 0.30)
                g = 'A+' if p >= 4 else 'B' if p == 3 else 'C' if p == 2 else 'no trade'
            G.setdefault(g, []).append(x)
        W.append('- %s (n=%d): ' % (nm, len(rows)) + '; '.join('%s n=%d 2R %.0f%% avgR %+.2f' % (g, len(G[g]), 100 * sum(x['win'] for x in G[g]) / len(G[g]), sum(x['res'] for x in G[g]) / len(G[g])) for g in ('A+', 'B', 'C', 'no trade') if g in G))
    open(os.path.join(S, 'tide/grade/QUANT_tables.md'), 'a').write('\n'.join(W) + '\n')
    print('\n'.join(W))
