import numpy as np
from numba import njit
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine'))
import engine as E

PARAMS = dict(N=10, Z=2.0, stopk=2.0, tgtm=1.5, H=30, cool=10, risk=100.0, sign=1, W=390)
RISK_KEY = 'risk'
TUNABLE = ['N', 'Z', 'stopk', 'tgtm', 'H', 'cool']
_NQ = {}

def _nq_aligned(d):
    if 'nq' not in _NQ:
        _NQ['nq'] = E.load('NQ')
    nq = _NQ['nq']
    # causal: for ES bar ts[i], use latest NQ bar with ts <= ts[i]
    j = np.searchsorted(nq.ts, d.ts, side='right') - 1
    j = np.maximum(j, 0)
    return nq.c[j]

@njit
def _core(ts, c, h, l, nqc, mod, day, N, Z, stopk, tgtm, H, cool, risk, sign, W, mult):
    n = len(c)
    ret_e = np.zeros(n); ret_n = np.zeros(n)
    for i in range(N, n):
        ret_e[i] = np.log(c[i] / c[i - N]); ret_n[i] = np.log(nqc[i] / nqc[i - N])
    # causal rolling std (past W bars, incl. current) via running sums of squares
    D = np.zeros(n); z = np.zeros(n)
    se = 0.0; sn = 0.0; qe = 0.0; qn = 0.0
    sd = 0.0; qd = 0.0
    for i in range(n):
        # standardise each by its own rolling std (computed from prior W bars incl. i)
        se += ret_e[i]; qe += ret_e[i] ** 2; sn += ret_n[i]; qn += ret_n[i] ** 2
        if i >= W:
            se -= ret_e[i - W]; qe -= ret_e[i - W] ** 2; sn -= ret_n[i - W]; qn -= ret_n[i - W] ** 2
        if i >= W:
            ve = qe / W - (se / W) ** 2; vn = qn / W - (sn / W) ** 2
            if ve > 1e-14 and vn > 1e-14:
                D[i] = ret_n[i] / np.sqrt(vn) - ret_e[i] / np.sqrt(ve)
    for i in range(n):
        sd += D[i]; qd += D[i] ** 2
        if i >= W:
            sd -= D[i - W]; qd -= D[i - W] ** 2
            v = qd / W - (sd / W) ** 2
            if v > 1e-12:
                z[i] = D[i] / np.sqrt(v)
    # ATR(30) causal
    atr = np.zeros(n); a = 0.0
    for i in range(1, n):
        tr = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        a = tr if i == 1 else a + (tr - a) / 30.0
        atr[i] = a
    ob = np.zeros(n, np.int64); os_ = np.zeros(n, np.int64); ost = np.zeros(n); otg = np.zeros(n)
    oex = np.zeros(n, np.int64); oq = np.zeros(n, np.int64)
    m = 0; last = -10**9
    for i in range(W + 1, n - 1):
        t = mod[i]
        if t < 575 or t > 930: continue
        if i - last < cool: continue
        if day[i] != day[i - N]: continue
        if abs(z[i]) < Z: continue
        side = int(np.sign(z[i])) * sign
        sd_ = stopk * atr[i]
        if sd_ < 0.5: continue
        q = int(risk / (sd_ * mult))
        if q < 1: q = 1
        px = c[i]
        ob[m] = i; os_[m] = side; ost[m] = px - side * sd_; otg[m] = px + side * sd_ * tgtm
        # time exit: H bars or 15:55 ET
        ex = i + H
        lim = i + (955 - t)
        if ex > lim: ex = lim
        oex[m] = ex; oq[m] = q; m += 1
        last = i
    return ob[:m], os_[:m], ost[:m], otg[:m], oex[:m], oq[:m]

def generate(d, params):
    p = params
    nqc = _nq_aligned(d)
    ob, sd, st, tg, ex, q = _core(d.ts, d.c, d.h, d.l, nqc, d.minute_of_day_et, d.day, int(round(p['N'])), float(p['Z']),
                                  float(p['stopk']), float(p['tgtm']), int(round(p['H'])), int(round(p['cool'])),
                                  float(p['risk']), int(p['sign']), int(p['W']), d.mult)
    k = len(ob)
    return E.make_signals(ob, sd, np.zeros(k, np.int64), np.zeros(k), st, tg, ex, ob, q)
