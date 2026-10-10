import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(risk=100.0, K=8, LEGMIN=2.0, FIB=0.382, STOPFIB=1.0, EXT=0.272, CANCEL=60, ATRN=60)
RISK_KEY = 'risk'
TUNABLE = ['K', 'LEGMIN', 'FIB', 'STOPFIB', 'EXT', 'CANCEL']

@njit
def _gen(h, l, c, mod, day, K, LEGMIN, FIB, STOPFIB, EXT, CANCEL, ATRN, risk, mult):
    n = len(c)
    cap = n // 20 + 100
    ob = np.zeros(cap, np.int64); osd = np.zeros(cap, np.int64); opx = np.zeros(cap); ost = np.zeros(cap)
    otg = np.zeros(cap); oex = np.zeros(cap, np.int64); ocn = np.zeros(cap, np.int64); oq = np.zeros(cap, np.int64)
    m = 0
    atr = 0.0
    lastp = 0.0   # last pivot price
    lastt = 0     # +1 last pivot high, -1 low, 0 none
    lasti = 0
    a = 2.0 / (ATRN + 1)
    for i in range(2 * K + 1, n):
        atr = atr * (1 - a) + a * (h[i] - l[i]) if atr > 0 else (h[i] - l[i])
        j = i - K
        if day[i] != day[i - 2 * K]:
            continue
        ph = True; pl = True
        for t in range(i - 2 * K, i + 1):
            if h[t] > h[j] or (t < j and h[t] == h[j]): ph = False
            if l[t] < l[j] or (t < j and l[t] == l[j]): pl = False
        piv = 0; pp = 0.0
        if ph and not pl: piv = 1; pp = h[j]
        elif pl and not ph: piv = -1; pp = l[j]
        if piv == 0: continue
        if lastt == piv:
            # same-type: keep the more extreme
            if (piv == 1 and pp > lastp) or (piv == -1 and pp < lastp):
                lastp = pp; lasti = j
            continue
        if lastt != 0:
            leg = abs(pp - lastp)
            mm = mod[i]
            # leg atr in 1-min-ATR units scaled by sqrt(duration) is complex; use raw ATR multiple (bars of range)
            if leg >= LEGMIN * atr * 3.0 and mm >= 585 and mm <= 915 and m < cap:
                side = 1 if piv == 1 else -1
                lim = pp - side * FIB * leg
                stop = pp - side * STOPFIB * leg - side * 0.5
                valid = (side == 1 and c[i] > stop and h[i] < pp + 1e9) or (side == -1 and c[i] < stop)
                # skip if price already beyond extreme
                if side == 1 and h[i] > pp: valid = False
                if side == -1 and l[i] < pp: valid = False
                sd = abs(lim - stop)
                if valid and sd > 1.0:
                    q = int(risk / (sd * mult))
                    if q < 1: q = 1
                    ob[m] = i; osd[m] = side; opx[m] = lim; ost[m] = stop
                    otg[m] = pp + side * EXT * leg if EXT > 0 else pp
                    ocn[m] = i + CANCEL
                    # exit by 15:55 ET
                    oex[m] = i + max(1, 955 - mm) if mm < 955 else i + 1
                    oq[m] = q; m += 1
        lastt = piv; lastp = pp; lasti = j
    return ob[:m], osd[:m], opx[:m], ost[:m], otg[:m], oex[:m], ocn[:m], oq[:m]

def generate(d, p):
    ob, osd, opx, ost, otg, oex, ocn, oq = _gen(d.h, d.l, d.c, d.minute_of_day_et, d.day, int(p['K']), float(p['LEGMIN']),
        float(p['FIB']), float(p['STOPFIB']), float(p['EXT']), int(p['CANCEL']), int(p['ATRN']), float(p['risk']), d.mult)
    return E.make_signals(ob, osd, np.ones(len(ob), np.int64), opx, ost, otg, oex, ocn, oq)
