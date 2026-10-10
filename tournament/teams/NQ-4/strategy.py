import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(hf=8, hs=34, pb_len=30, atr_len=60, depth=0.5, look=20, stop_mult=2.0, rr=2.5,
              risk=60.0, max_day=3, cooldown=90, min_stop=8.0, max_hold=180,
              strength=1.0, start_min=585, end_min=915, flat_min=955)


@njit
def _gen(ts, o, h, l, c, day, mod, mult, hf, hs, pb_len, atr_len, depth, look, stop_mult, rr,
         risk, max_day, cooldown, min_stop, max_hold, strength, start_min, end_min, flat_min):
    n = len(c)
    cap = n // 20 + 10
    ob = np.zeros(cap, np.int64); os_ = np.zeros(cap, np.int64); opx = np.zeros(cap)
    ost = np.zeros(cap); otg = np.zeros(cap); oex = np.zeros(cap, np.int64); oq = np.zeros(cap, np.int64)
    k = 0
    af = 2.0 / (hf + 1); as_ = 2.0 / (hs + 1); ap = 2.0 / (pb_len + 1); aa = 1.0 / atr_len
    ef = c[0]; es = c[0]; hcount = 0
    pb = c[0]; atr = h[0] - l[0]
    cur_hour = ts[0] // 3600
    last_sig = -10**9
    dcount = 0; cur_day = -1
    below = -10**9; above = -10**9   # last bar index where close was a pullback beyond depth
    for i in range(1, n):
        hr = ts[i] // 3600
        if hr != cur_hour:
            x = c[i - 1]
            ef += af * (x - ef); es += as_ * (x - es); hcount += 1
            cur_hour = hr
        tr = max(h[i] - l[i], max(abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
        atr += aa * (tr - atr)
        pb += ap * (c[i] - pb)
        if day[i] != cur_day:
            cur_day = day[i]; dcount = 0
        if c[i] < pb - depth * atr:
            below = i
        if c[i] > pb + depth * atr:
            above = i
        if hcount < hs * 2 or i < 1000:
            continue
        m = mod[i]
        if m < start_min or m > end_min or dcount >= max_day or i - last_sig < cooldown:
            continue
        if day[i] != day[i - 1]:
            continue
        lastc = c[i - 1]
        up = ef - es > strength * 8.0 * atr and lastc > es
        dn = es - ef > strength * 8.0 * atr and lastc < es
        side = 0
        if up and i - below <= look and c[i] > pb and c[i] > h[i - 1]:
            side = 1
        elif dn and i - above <= look and c[i] < pb and c[i] < l[i - 1]:
            side = -1
        if side == 0:
            continue
        sd = max(stop_mult * atr, min_stop)
        q = int(risk / (sd * mult))
        if q < 1:
            q = 1
        ob[k] = i; os_[k] = side; opx[k] = c[i]
        ost[k] = c[i] - side * sd
        otg[k] = c[i] + side * rr * sd
        # exit: flat time or max hold
        ex = i + max_hold
        mins_left = flat_min - m
        if mins_left < max_hold:
            ex = i + max(mins_left, 1)
        oex[k] = ex; oq[k] = q
        k += 1
        last_sig = i; dcount += 1
    return ob[:k], os_[:k], opx[:k], ost[:k], otg[:k], oex[:k], oq[:k]


def generate(d, params):
    p = params
    ob, s, px, st, tg, ex, q = _gen(d.ts, d.o, d.h, d.l, d.c, d.day, d.minute_of_day_et, d.mult,
        p['hf'], p['hs'], p['pb_len'], p['atr_len'], p['depth'], p['look'], p['stop_mult'], p['rr'],
        p['risk'], p['max_day'], p['cooldown'], p['min_stop'], p['max_hold'], p['strength'],
        p['start_min'], p['end_min'], p['flat_min'])
    ex = np.minimum(ex, d.n - 1)
    z = np.zeros(len(ob), np.int64)
    return E.make_signals(ob, s, z, px, st, tg, ex, z, q)

RISK_KEY = 'risk'
TUNABLE = ['hf', 'hs', 'pb_len', 'atr_len', 'depth', 'look', 'stop_mult', 'rr', 'cooldown', 'strength', 'start_min', 'end_min']
