import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(risk=100.0, mode=0, start_min=585, last_min=900, buf=0.5, kt=2.0, min_stop=10.0, tgt_frac=1.0, exit_min=955)
RISK_KEY = 'risk'
TUNABLE = ['start_min', 'last_min', 'buf', 'kt', 'min_stop', 'tgt_frac', 'exit_min']

@njit
def _gen(day, mod, o, h, l, c, mode, start_min, last_min, buf, kt, min_stop, tgt_frac, exit_min, risk, mult):
    n = len(c)
    ob = np.zeros(n, np.int64); osd = np.zeros(n, np.int64); opx = np.zeros(n); ost = np.zeros(n)
    otg = np.zeros(n); oex = np.zeros(n, np.int64); oq = np.zeros(n, np.int64); k = 0
    # rolling RTH stats for current day and previous day
    cur = -1; rh = -1e18; rl = 1e18; rc = 0.0
    ph = 0.0; pl = 0.0; pc = 0.0; have = False
    used = np.zeros(4, np.int64); ntr = 0
    exit_bar = -1
    for i in range(n):
        if day[i] != cur:
            if cur != -1 and rh > 0:
                ph = rh; pl = rl; pc = rc; have = True
            cur = day[i]; rh = -1e18; rl = 1e18; used[:] = 0; ntr = 0
        m = mod[i]
        if m >= 570 and m < 960:
            if h[i] > rh: rh = h[i]
            if l[i] < rl: rl = l[i]
            rc = c[i]
        if not have or m < start_min or m > last_min or ntr >= 2:
            continue
        R = ph - pl
        if R <= 0: continue
        H3 = pc + R * 1.1 / 4; H4 = pc + R * 1.1 / 2
        L3 = pc - R * 1.1 / 4; L4 = pc - R * 1.1 / 2
        side = 0; stop = 0.0; tgt = 0.0; lv = -1
        if mode == 0:
            if h[i] >= H3 and c[i] < H3 and used[0] == 0:
                side = -1; stop = H4 + buf; tgt = c[i] - tgt_frac * (c[i] - pc); lv = 0
            elif l[i] <= L3 and c[i] > L3 and used[1] == 0:
                side = 1; stop = L4 - buf; tgt = c[i] + tgt_frac * (pc - c[i]); lv = 1
        else:
            if c[i] > H4 and used[2] == 0:
                side = 1; stop = H3; tgt = H4 + kt * (H4 - H3); lv = 2
            elif c[i] < L4 and used[3] == 0:
                side = -1; stop = L3; tgt = L4 - kt * (H4 - H3); lv = 3
        if side == 0: continue
        sd = abs(c[i] - stop)
        if sd < min_stop: continue
        if side == 1 and tgt <= c[i]: continue
        if side == -1 and tgt >= c[i]: continue
        used[lv] = 1; ntr += 1
        # exit bar: find 15:55 of this session -> offset by minutes remaining (RTH contiguous)
        ob[k] = i; osd[k] = side; opx[k] = c[i]; ost[k] = stop; otg[k] = tgt
        oex[k] = i + max(exit_min - m, 1)
        q = int(risk / (sd * mult))
        oq[k] = max(q, 1); k += 1
    return ob[:k], osd[:k], opx[:k], ost[:k], otg[:k], oex[:k], oq[:k]

def generate(d, params):
    p = params
    b, s, px, st, tg, ex, q = _gen(d.day, d.minute_of_day_et, d.o, d.h, d.l, d.c, int(p['mode']), int(p['start_min']),
        int(p['last_min']), float(p['buf']), float(p['kt']), float(p['min_stop']), float(p['tgt_frac']), int(p['exit_min']),
        float(p['risk']), d.mult)
    ex = np.minimum(ex, d.n - 1)
    return E.make_signals(b, s, np.zeros(len(b), np.int64), px, st, tg, ex, ex, q)
