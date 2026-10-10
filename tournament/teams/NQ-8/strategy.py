import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(risk=200.0, N=90, atr_n=60, stop_atr=8.0, tgt_r=3.0, minw=10.0, start=585, end=870, flat=955, max_day=2)
RISK_KEY = 'risk'
TUNABLE = ['N', 'atr_n', 'stop_atr', 'tgt_r', 'minw', 'start', 'end']


@njit
def _gen(o, h, l, c, day, mod, risk, N, atr_n, stop_atr, tgt_r, minw, start, end, flat, max_day, mult, out):
    n = len(c)
    cs = np.zeros(n + 1)
    for i in range(n):
        cs[i + 1] = cs[i] + (h[i] - l[i])
    m = 0
    busy = -1
    cur = -1
    cnt = 0
    last_stop_side = 0
    for i in range(max(N, atr_n) + 2, n - 1):
        if day[i] != cur:
            cur = day[i]; cnt = 0; last_stop_side = 0
        if i <= busy or cnt >= max_day:
            continue
        t = mod[i]
        if t < start or t > end:
            continue
        hh = -1e18; ll = 1e18
        for j in range(i - N, i):
            if h[j] > hh: hh = h[j]
            if l[j] < ll: ll = l[j]
        atr = (cs[i + 1] - cs[i + 1 - atr_n]) / atr_n
        if atr <= 0 or (hh - ll) < minw * atr:
            continue
        side = 0
        if c[i] > hh: side = 1
        elif c[i] < ll: side = -1
        if side == 0 or side == last_stop_side:
            continue
        sd = stop_atr * atr
        ent = c[i]
        stop = ent - side * sd
        tgt = ent + side * tgt_r * sd
        q = int(risk / (sd * mult))
        if q < 1: q = 1
        # find end of day bar
        eb = i + 1
        while eb < n - 1 and day[eb + 1] == day[i] and mod[eb] < flat:
            eb += 1
        # simulate exit approx
        ex = eb; hit = 0
        for j in range(i + 1, eb + 1):
            if side == 1:
                if l[j] <= stop: ex = j; hit = -1; break
                if h[j] >= tgt: ex = j; hit = 1; break
            else:
                if h[j] >= stop: ex = j; hit = -1; break
                if l[j] <= tgt: ex = j; hit = 1; break
        busy = ex
        cnt += 1
        if hit == -1: last_stop_side = side
        out[m, 0] = i; out[m, 1] = side; out[m, 2] = stop; out[m, 3] = tgt
        out[m, 4] = eb; out[m, 5] = q
        m += 1
    return m


def generate(d, p):
    out = np.zeros((200000, 6))
    m = _gen(d.o, d.h, d.l, d.c, d.day, d.minute_of_day_et, float(p['risk']), int(p['N']), int(p['atr_n']),
             float(p['stop_atr']), float(p['tgt_r']), float(p['minw']), int(p['start']), int(p['end']),
             int(p['flat']), int(p['max_day']), d.mult, out)
    o = out[:m]
    z = np.zeros(m, np.int64)
    return E.make_signals(o[:, 0], o[:, 1], z, np.zeros(m), o[:, 2], o[:, 3], o[:, 4], z, o[:, 5])
