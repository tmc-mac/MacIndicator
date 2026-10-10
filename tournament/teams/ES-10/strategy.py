import numpy as np
from numba import njit
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import engine as E

PARAMS = dict(risk=100.0, tf=15, lb=8, tol=0.5, wick=2.0, buf=0.1, tgt_r=1.5, min_atr=0.5, max_atr=3.0,
              patt=7, t_start=585, t_end=915)
RISK_KEY = 'risk'
TUNABLE = ['tf', 'lb', 'tol', 'wick', 'buf', 'tgt_r', 't_start', 't_end']

@njit
def _gen(h, l, o, c, mod, day, mult, risk, tf, lb, tol, wick, buf, tgt_r, min_atr, max_atr, patt, t0, t1):
    n = len(c)
    cap = n // 4 + 10
    ob = np.zeros(cap, np.int64); osd = np.zeros(cap, np.int64); ost = np.zeros(cap); otg = np.zeros(cap)
    oq = np.zeros(cap, np.int64); oex = np.zeros(cap, np.int64)
    k = 0
    M = 4000
    ao = np.zeros(M); ah = np.zeros(M); al = np.zeros(M); ac = np.zeros(M)
    na = 0
    cu_o = 0.0; cu_h = 0.0; cu_l = 0.0; cu_c = 0.0; have = False; cday = -1
    atr = 0.0
    lastbar = -1
    for i in range(n):
        m = mod[i]
        if m < 570 or m >= 960:
            continue
        if day[i] != cday:
            cday = day[i]; na = 0; have = False; atr = 0.0
        b = m // tf
        if (not have):
            cu_o = o[i]; cu_h = h[i]; cu_l = l[i]; have = True
        else:
            if h[i] > cu_h: cu_h = h[i]
            if l[i] < cu_l: cu_l = l[i]
        cu_c = c[i]
        if (m % tf) != tf - 1:
            continue
        # bar complete
        have = False
        if na >= M: continue
        ao[na] = cu_o; ah[na] = cu_h; al[na] = cu_l; ac[na] = cu_c
        tr = cu_h - cu_l
        if na > 0:
            tr = max(tr, abs(cu_h - ac[na-1]), abs(cu_l - ac[na-1]))
        atr = tr if na == 0 else atr + (tr - atr) / 14.0
        na += 1
        if na < lb + 3 or m < t0 or m > t1 or atr <= 0:
            continue
        j = na - 1
        o1 = ao[j]; h1 = ah[j]; l1 = al[j]; c1 = ac[j]
        o2 = ao[j-1]; h2 = ah[j-1]; l2 = al[j-1]; c2 = ac[j-1]
        rng = h1 - l1
        body = abs(c1 - o1)
        swl = 1e18; swh = -1e18
        for q in range(j - lb, j):
            if al[q] < swl: swl = al[q]
            if ah[q] > swh: swh = ah[q]
        side = 0
        # patt bitmask: 1 engulf, 2 pin, 4 inside breakout
        if (patt & 1):
            if c2 < o2 and c1 > o1 and o1 <= c2 and c1 >= o2 and l1 <= swl + tol * atr: side = 1
            elif c2 > o2 and c1 < o1 and o1 >= c2 and c1 <= o2 and h1 >= swh - tol * atr: side = -1
        if side == 0 and (patt & 2) and rng > 0:
            lw = min(o1, c1) - l1; uw = h1 - max(o1, c1)
            if lw >= wick * max(body, 0.1 * rng) and c1 >= l1 + 0.6 * rng and l1 <= swl + tol * atr: side = 1
            elif uw >= wick * max(body, 0.1 * rng) and c1 <= l1 + 0.4 * rng and h1 >= swh - tol * atr: side = -1
        if side == 0 and (patt & 4) and j >= 2:
            h3 = ah[j-2]; l3 = al[j-2]
            if h2 < h3 and l2 > l3:
                if c1 > h3: side = 1
                elif c1 < l3: side = -1
        if side == 0: continue
        if side == 1:
            stp = min(l1, l2 if (patt & 4) and (l2 > al[j-2] and ah[j-1] < ah[j-2]) else l1) - buf * atr
            dist = c1 - stp
        else:
            stp = max(h1, h2 if (patt & 4) and (l2 > al[j-2] and ah[j-1] < ah[j-2]) else h1) + buf * atr
            dist = stp - c1
        if dist < min_atr * atr or dist > max_atr * atr: continue
        q = int(risk / (dist * mult))
        if q < 1: q = 1
        ob[k] = i; osd[k] = side; ost[k] = stp
        otg[k] = c1 + side * tgt_r * dist
        oq[k] = q
        oex[k] = i + (955 - m)   # ~15:55 ET (assumes continuous 1m bars)
        k += 1
    return ob[:k], osd[:k], ost[:k], otg[:k], oq[:k], oex[:k]

def generate(d, p):
    ob, osd, ost, otg, oq, oex = _gen(d.h, d.l, d.o, d.c, d.minute_of_day_et, d.day, d.mult, float(p['risk']),
        int(round(p['tf'])), int(round(p['lb'])), float(p['tol']), float(p['wick']), float(p['buf']), float(p['tgt_r']),
        float(p['min_atr']), float(p['max_atr']), int(p['patt']), int(p['t_start']), int(p['t_end']))
    z = np.zeros(len(ob), np.int64)
    return E.make_signals(ob, osd, z, np.zeros(len(ob)), ost, otg, np.minimum(oex, d.n - 1), z, oq)
