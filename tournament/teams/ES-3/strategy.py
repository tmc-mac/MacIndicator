"""ES-3: Asia-range breakout traded in London session (MES)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(buf=0.0, sk=2.0, tg=2.0, rmin=0.5, rmax=2.0, risk=150.0,
              mode=1,            # 0 breakout, 1 fade
              t_end=300, t_exit=510, hist=20)

@njit(cache=True)
def _gen(c, h, l, day, mod, mult, buf, sk, tg, rmin, rmax, risk, mode, t_end, t_exit, hist):
    n = len(c)
    ob = np.zeros(n, np.int64); osd = np.zeros(n, np.int64); ostop = np.zeros(n)
    otg = np.zeros(n); oex = np.zeros(n, np.int64); oq = np.zeros(n, np.int64)
    k = 0
    cur = -1
    H = -1e18; L = 1e18; cnt = 0
    finalized = False; taken = False
    ring = np.zeros(hist); rn = 0
    A = 0.0; R = 0.0
    for i in range(n):
        if day[i] != cur:
            cur = day[i]; H = -1e18; L = 1e18; cnt = 0; finalized = False; taken = False
        m = mod[i]
        if m >= 1080 or m < 180:
            if h[i] > H: H = h[i]
            if l[i] < L: L = l[i]
            cnt += 1
            continue
        if m < 180 or m > t_end or taken:
            continue
        if not finalized:
            finalized = True
            R = H - L
            if cnt >= 200:
                A = 0.0
                if rn >= 5:
                    mm = min(rn, hist)
                    A = ring[:mm].sum() / mm
                ring[rn % hist] = R; rn += 1
            else:
                R = 0.0
        if R <= 0 or A <= 0 or R < rmin * A or R > rmax * A:
            continue
        side = 0
        if c[i] > H + buf * R: side = 1
        elif c[i] < L - buf * R: side = -1
        if side == 0:
            continue
        if mode == 1:
            side = -side
        # stop
        if mode == 0:
            stop = H - sk * R if side == 1 else L + sk * R
        else:
            stop = c[i] - side * sk * R   # fade: stop sk*R beyond entry
        sd = abs(c[i] - stop)
        if sd < 0.5:
            continue
        q = int(risk / (sd * mult))
        if q < 1: q = 1
        ob[k] = i; osd[k] = side; ostop[k] = stop
        otg[k] = c[i] + side * tg * sd
        oex[k] = i + (t_exit - m) if t_exit > m else i + 1
        oq[k] = q
        k += 1; taken = True
    return k, ob, osd, ostop, otg, oex, oq

def generate(d, p):
    k, ob, osd, ostop, otg, oex, oq = _gen(d.c, d.h, d.l, d.day, d.minute_of_day_et, d.mult,
        p['buf'], p['sk'], p['tg'], p['rmin'], p['rmax'], p['risk'], p['mode'], p['t_end'], p['t_exit'], p['hist'])
    oex = np.minimum(oex, d.n - 1)
    return E.make_signals(ob[:k], osd[:k], np.zeros(k, np.int64), np.zeros(k), ostop[:k], otg[:k], oex[:k],
                          oex[:k], oq[:k])
