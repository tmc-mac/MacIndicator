"""NQ-6 v2: rolling volatility-regime classifier (ATR short/long) gating squeeze-breakout vs stretch-fade."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(lo=0.6, hi=1.5, z=2.5, box=30, risk=60.0, tm=2.0, cool=30, maxday=3, sw=15, lw=240, mw=60)


@njit
def _gen(o, h, l, c, day, mod, lo, hi, z, box, risk, tm, cool, maxday, sw, lw, mw, mult):
    n = len(c)
    cap = n // 100 + 100
    ob = np.zeros(cap, np.int64); osd = np.zeros(cap, np.int64)
    opx = np.zeros(cap); ost = np.zeros(cap); otg = np.zeros(cap)
    oex = np.zeros(cap, np.int64); oq = np.zeros(cap, np.int64)
    k = 0
    tr = np.zeros(n)
    for i in range(1, n):
        tr[i] = max(h[i], c[i-1]) - min(l[i], c[i-1])
    cs = np.zeros(n + 1); cs2 = np.zeros(n + 1); cc = np.zeros(n + 1)
    for i in range(n):
        cs[i+1] = cs[i] + tr[i]; cc[i+1] = cc[i] + c[i]; cs2[i+1] = cs2[i] + c[i]*c[i]
    cur = -1; cnt = 0; last = -10**9
    for i in range(lw + 1, n):
        if day[i] != cur:
            cur = day[i]; cnt = 0
        m = mod[i]
        if m < 600 or m > 930 or cnt >= maxday or i - last < cool or k >= cap:
            continue
        if day[i - lw] != day[i] and False:
            continue
        a_s = (cs[i+1] - cs[i+1-sw]) / sw
        a_l = (cs[i+1] - cs[i+1-lw]) / lw
        if a_l <= 0: continue
        ratio = a_s / a_l
        ex = i + (955 - m)
        side = 0; stp = 0.0; tgt = 0.0
        if ratio < lo:
            bh = -1e18; bl = 1e18
            for j in range(i - box, i):
                if h[j] > bh: bh = h[j]
                if l[j] < bl: bl = l[j]
            mid = 0.5 * (bh + bl)
            if c[i] > bh: side = 1
            elif c[i] < bl: side = -1
            if side != 0:
                dist = abs(c[i] - mid)
                stp = mid; tgt = c[i] + side * tm * dist
        elif ratio > hi:
            mu = (cc[i+1] - cc[i+1-mw]) / mw
            var = (cs2[i+1] - cs2[i+1-mw]) / mw - mu * mu
            if var <= 0: continue
            sd = var ** 0.5
            zz = (c[i] - mu) / sd
            if zz > z: side = -1
            elif zz < -z: side = 1
            if side != 0:
                ext = h[i] if side == -1 else l[i]
                stp = ext - side * (-1) * a_s * 0 if False else (ext + a_s if side == -1 else ext - a_s)
                tgt = mu
        if side == 0: continue
        dist = abs(c[i] - stp)
        if dist < 1.0 or (side == 1 and tgt <= c[i]) or (side == -1 and tgt >= c[i]): continue
        q = int(risk / (dist * mult))
        if q < 1: q = 1
        ob[k] = i; osd[k] = side; opx[k] = c[i]; ost[k] = stp; otg[k] = tgt; oex[k] = ex; oq[k] = q
        k += 1; cnt += 1; last = i
    return ob[:k], osd[:k], opx[:k], ost[:k], otg[:k], oex[:k], oq[:k]


def generate(d, p):
    b, s, px, st, tg, ex, q = _gen(d.o, d.h, d.l, d.c, d.day, d.minute_of_day_et, float(p['lo']), float(p['hi']),
        float(p['z']), int(p['box']), float(p['risk']), float(p['tm']), int(p['cool']), int(p['maxday']),
        int(p['sw']), int(p['lw']), int(p['mw']), float(d.mult))
    return E.make_signals(b, s, np.zeros(len(b), np.int64), px, st, tg, ex, b, q)
