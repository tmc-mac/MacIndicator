"""NQ-6: volatility-regime-adaptive opening-range system (see prereg.md)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(lookback=20, thr=1.0, tm=2.0, fw=15, risk=60.0, or_end=600, last_dec=840, flat=955)


@njit
def _gen(o, h, l, c, day, mod, lookback, thr, tm, fw, risk, mult, or_end, last_dec, flat):
    n = len(c)
    cap = n // 200 + 100
    ob = np.zeros(cap, np.int64); osd = np.zeros(cap, np.int64)
    opx = np.zeros(cap); ost = np.zeros(cap); otg = np.zeros(cap)
    oex = np.zeros(cap, np.int64); oq = np.zeros(cap, np.int64)
    k = 0
    hist = np.zeros(4000); nh = 0
    cur = -1
    orh = 0.0; orl = 0.0; orc = 0; width = 0.0; ready = False; traded = False; mode = 0
    pu = -1; pue = 0.0; pd = -1; pde = 0.0
    for i in range(n):
        if day[i] != cur:
            cur = day[i]; orh = -1e18; orl = 1e18; orc = 0; ready = False; traded = False
            pu = -1; pd = -1; pue = 0.0; pde = 0.0
        m = mod[i]
        if m >= 570 and m < or_end:
            if h[i] > orh: orh = h[i]
            if l[i] < orl: orl = l[i]
            orc += 1
        if m == or_end - 1 and orc >= 20 and not ready:
            width = orh - orl
            if nh >= lookback and width > 0:
                s = 0.0
                for q in range(nh - lookback, nh):
                    s += hist[q]
                rel = width / (s / lookback)
                mode = 1 if rel < thr else 2
                ready = True
            if width > 0 and nh < 4000:
                hist[nh] = width; nh += 1
            continue
        if not ready or traded or m < or_end or m > last_dec or k >= cap:
            continue
        ex = i + (flat - m)
        if mode == 1:
            side = 0
            if c[i] > orh: side = 1
            elif c[i] < orl: side = -1
            if side != 0:
                mid = 0.5 * (orh + orl)
                dist = abs(c[i] - mid)
                if dist < 0.5: continue
                q = int(risk / (dist * mult))
                if q < 1: q = 1
                ob[k] = i; osd[k] = side; opx[k] = c[i]; ost[k] = mid
                otg[k] = c[i] + side * tm * dist; oex[k] = ex; oq[k] = q; k += 1; traded = True
        else:
            if h[i] > orh:
                if pu < 0 or i - pu > fw:
                    pu = i; pue = h[i]
                elif h[i] > pue: pue = h[i]
            if l[i] < orl:
                if pd < 0 or i - pd > fw:
                    pd = i; pde = l[i]
                elif l[i] < pde: pde = l[i]
            side = 0
            if pu >= 0 and i - pu <= fw and c[i] < orh:
                side = -1; stp = pue + 0.25
            elif pd >= 0 and i - pd <= fw and c[i] > orl:
                side = 1; stp = pde - 0.25
            if side != 0:
                dist = abs(stp - c[i])
                if dist > width or dist < 0.5: 
                    pu = -1; pd = -1
                    continue
                q = int(risk / (dist * mult))
                if q < 1: q = 1
                ob[k] = i; osd[k] = side; opx[k] = c[i]; ost[k] = stp
                otg[k] = 0.5 * (orh + orl); oex[k] = ex; oq[k] = q; k += 1; traded = True
    return ob[:k], osd[:k], opx[:k], ost[:k], otg[:k], oex[:k], oq[:k]


def generate(d, params):
    p = params
    b, s, px, st, tg, ex, q = _gen(d.o, d.h, d.l, d.c, d.day, d.minute_of_day_et, int(p['lookback']), float(p['thr']),
                                   float(p['tm']), int(p['fw']), float(p['risk']), float(d.mult),
                                   int(p['or_end']), int(p['last_dec']), int(p['flat']))
    return E.make_signals(b, s, np.zeros(len(b), np.int64), px, st, tg, ex, b, q)
