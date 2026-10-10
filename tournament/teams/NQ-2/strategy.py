import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(RM=45, ENTRY_END=690, SF=0.75, TM=100.0, RISK=200.0, WMIN=0.5, WMAX=2.0, EXIT_MIN=955, LOOK=20)

@njit
def _gen(day, mod, h, l, c, mult, RM, ENTRY_END, SF, TM, RISK, WMIN, WMAX, EXIT_MIN, LOOK):
    n = len(day)
    ob = np.zeros(n, np.int64); osd = np.zeros(n, np.int64); opx = np.zeros(n); ost = np.zeros(n)
    otg = np.zeros(n); oex = np.zeros(n, np.int64); oq = np.zeros(n, np.int64)
    k = 0
    hist = np.zeros(LOOK); nh = 0; hp = 0
    i = 0
    while i < n:
        d = day[i]
        j = i
        while j < n and day[j] == d:
            j += 1
        # session [i,j)
        hi = -1e18; lo = 1e18; cnt = 0; ex = -1
        for t in range(i, j):
            if mod[t] >= 570 and mod[t] < 570 + RM:
                if h[t] > hi: hi = h[t]
                if l[t] < lo: lo = l[t]
                cnt += 1
            if mod[t] <= EXIT_MIN:
                ex = t
        if cnt >= RM - 3:
            W = hi - lo
            atr = 0.0
            if nh >= 5:
                s = 0.0
                m = min(nh, LOOK)
                for q in range(m): s += hist[q]
                atr = s / m
            if nh >= 5 and W >= WMIN * atr and W <= WMAX * atr and W > 0 and ex > 0:
                for t in range(i, j):
                    if mod[t] >= 570 + RM and mod[t] < ENTRY_END and t < ex:
                        side = 0
                        if c[t] > hi: side = 1
                        elif c[t] < lo: side = -1
                        if side != 0:
                            if side == 1: stop = hi - SF * W
                            else: stop = lo + SF * W
                            dist = abs(c[t] - stop)
                            if dist < 1.0: dist = 1.0
                            q = int(RISK / (dist * mult))
                            if q < 1: q = 1
                            ob[k] = t; osd[k] = side; ost[k] = stop
                            opx[k] = 0.0
                            otg[k] = c[t] + side * TM * dist
                            oex[k] = ex; oq[k] = q; k += 1
                            break
            hist[hp % LOOK] = W; hp += 1; nh += 1
        i = j
    return ob[:k], osd[:k], opx[:k], ost[:k], otg[:k], oex[:k], oq[:k]

def generate(d, p):
    ob, osd, opx, ost, otg, oex, oq = _gen(d.day, d.minute_of_day_et, d.h, d.l, d.c, d.mult,
        p['RM'], p['ENTRY_END'], p['SF'], p['TM'], p['RISK'], p['WMIN'], p['WMAX'], p['EXIT_MIN'], p['LOOK'])
    z = np.zeros(len(ob), np.int64)
    return E.make_signals(ob, osd, z, opx, ost, otg, oex, oex, oq)
