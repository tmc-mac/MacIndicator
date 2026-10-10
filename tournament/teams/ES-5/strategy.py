import numpy as np
from numba import njit
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import engine as E

PARAMS = dict(VW=60, K=2.5, RW=60, LOC=0.15, CLV=0.2, ATRW=30, MINR=0.8, PAD=0.25, TM=1.5, TIME=45,
              RISK=150.0, MAXC=20, START=585, END=930, FLAT=955, MAXDAY=3, COOL=10, MODE=2, ZT=9.0, VR=1.0, SW=6.0, TIME3=60, MAXDAY3=3, COOL3=30, S3=600, E3=900)

@njit(cache=False)
def _roll_mean(x, w):
    n = len(x); out = np.full(n, np.nan); s = 0.0
    for i in range(n):
        s += x[i]
        if i >= w: s -= x[i - w]
        if i >= w - 1: out[i] = s / w
    return out

@njit(cache=False)
def _core(o, h, l, c, v, day, mod, vol_prev, atr, rhi, rlo, mult, K, LOC, CLV, MINR, PAD, TM, TIME, RISK, MAXC,
          START, END, FLAT, MAXDAY, COOL, MODE):
    n = len(c)
    ob = np.zeros(n, np.int64); os_ = np.zeros(n, np.int64); ost = np.zeros(n); otg = np.zeros(n)
    oex = np.zeros(n, np.int64); oq = np.zeros(n, np.int64)
    k = 0; cd = -1; cnt = 0; last = -10**9
    for i in range(70, n):
        if day[i] != cd:
            cd = day[i]; cnt = 0
        m = mod[i]
        if m < START or m > END or cnt >= MAXDAY or i - last < COOL:
            continue
        rng = h[i] - l[i]
        if rng <= 0 or np.isnan(vol_prev[i]) or vol_prev[i] <= 0 or np.isnan(atr[i]):
            continue
        if v[i] / vol_prev[i] < K or rng < MINR * atr[i]:
            continue
        clv = (2 * c[i] - h[i] - l[i]) / rng
        span = rhi[i] - rlo[i]
        if span <= 0:
            continue
        side = 0
        if MODE == 0:
            if clv >= CLV and l[i] <= rlo[i] + LOC * span:
                side = 1
            elif clv <= -CLV and h[i] >= rhi[i] - LOC * span:
                side = -1
        else:
            if clv >= CLV and h[i] >= rhi[i] - LOC * span:
                side = 1
            elif clv <= -CLV and l[i] <= rlo[i] + LOC * span:
                side = -1
        if side == 0:
            continue
        if side == 1:
            stop = l[i] - PAD * atr[i]
        else:
            stop = h[i] + PAD * atr[i]
        dist = abs(c[i] - stop)
        if dist < 0.5:
            continue
        q = int(RISK / (dist * mult))
        if q < 1: q = 1
        if q > MAXC: q = MAXC
        ob[k] = i; os_[k] = side; ost[k] = stop; otg[k] = c[i] + side * TM * dist
        # flat time: bars until FLAT minute (approx, 1 bar/min)
        ex = i + 1 + TIME
        rem = FLAT - m
        if rem >= 0 and i + rem < ex: ex = i + rem
        oex[k] = ex; oq[k] = q
        k += 1; cnt += 1; last = i
    return ob[:k], os_[:k], ost[:k], otg[:k], oex[:k], oq[:k]

def generate(d, p):
    v = d.v.astype(np.float64)
    vm = _roll_mean(v, p['VW'])
    vol_prev = np.full(d.n, np.nan); vol_prev[1:] = vm[:-1]
    pc = np.r_[d.c[0], d.c[:-1]]
    tr = np.maximum(d.h - d.l, np.maximum(np.abs(d.h - pc), np.abs(d.l - pc)))
    atr = _roll_mean(tr, p['ATRW'])
    import pandas as pd
    rhi = pd.Series(d.h).rolling(p['RW']).max().values
    rlo = pd.Series(d.l).rolling(p['RW']).min().values
    ob, side, st, tg, ex, q = _core(d.o, d.h, d.l, d.c, v, d.day, d.minute_of_day_et, vol_prev, atr, rhi, rlo, d.mult,
        p['K'], p['LOC'], p['CLV'], p['MINR'], p['PAD'], p['TM'], p['TIME'], p['RISK'], p['MAXC'],
        p['START'], p['END'], p['FLAT'], p['MAXDAY'], p['COOL'], p['MODE'])
    z = np.zeros(len(ob))
    return E.make_signals(ob, side, z, z, st, tg, ex, z, q)


@njit(cache=False)
def _core3(c, day, mod, z, vr, dn, atr, mult, ZT, VR, SW, TIME, RISK, MAXC, S3, E3, FLAT, MAXDAY, COOL):
    n = len(c)
    ob = np.zeros(n, np.int64); os_ = np.zeros(n, np.int64); ost = np.zeros(n); otg = np.full(n, np.nan)
    oex = np.zeros(n, np.int64); oq = np.zeros(n, np.int64)
    k = 0; cd = -1; cnt = 0; last = -10**9
    for i in range(400, n):
        if day[i] != cd:
            cd = day[i]; cnt = 0
        m = mod[i]
        if m < S3 or m > E3 or cnt >= MAXDAY or i - last < COOL or np.isnan(z[i]) or np.isnan(vr[i]) or np.isnan(atr[i]):
            continue
        if vr[i] < VR:
            continue
        side = 0
        if z[i] >= ZT and dn[i] > 0: side = 1
        elif z[i] <= -ZT and dn[i] < 0: side = -1
        if side == 0: continue
        dist = SW * atr[i]
        if dist < 1.0: continue
        q = int(RISK / (dist * mult))
        if q < 1: q = 1
        if q > MAXC: q = MAXC
        ob[k] = i; os_[k] = side; ost[k] = c[i] - side * dist
        ex = i + 1 + TIME
        rem = FLAT - m
        if rem >= 0 and i + rem < ex: ex = i + rem
        oex[k] = ex; oq[k] = q; k += 1; cnt += 1; last = i
    return ob[:k], os_[:k], ost[:k], otg[:k], oex[:k], oq[:k]

def generate3(d, p):
    import pandas as pd
    v = d.v.astype(np.float64); mod = d.minute_of_day_et
    tp = (d.h + d.l + d.c) / 3
    rth = (mod >= 570) & (mod <= 960)
    df = pd.DataFrame(dict(pv=np.where(rth, tp * v, 0.0), vv=np.where(rth, v, 0.0), day=d.day))
    cp = df.groupby('day').pv.cumsum().values; cv = df.groupby('day').vv.cumsum().values
    with np.errstate(all='ignore'):
        vw = np.where(cv > 0, cp / cv, np.nan)
    pc = np.r_[d.c[0], d.c[:-1]]
    tr = np.maximum(d.h - d.l, np.maximum(np.abs(d.h - pc), np.abs(d.l - pc)))
    atr = _roll_mean(tr, 60)
    z = (d.c - vw) / atr
    sv = pd.Series(v)
    vr = (sv.rolling(10).sum() / sv.rolling(300).mean() / 10).values
    clv = (2 * d.c - d.h - d.l) / np.maximum(d.h - d.l, 1e-9)
    dl = pd.Series(clv * v)
    dn = (dl.rolling(10).sum() / sv.rolling(10).sum()).values
    ob, side, st, tg, ex, q = _core3(d.c, d.day, mod, z, vr, dn, atr, d.mult, p['ZT'], p['VR'], p['SW'], p['TIME3'],
        p['RISK'], p['MAXC'], p['S3'], p['E3'], p['FLAT'], p['MAXDAY3'], p['COOL3'])
    z0 = np.zeros(len(ob))
    return E.make_signals(ob, side, z0, z0, st, tg, ex, z0, q)

_gen12 = generate
def generate(d, p):
    return generate3(d, p) if p.get('MODE') == 2 else _gen12(d, p)
