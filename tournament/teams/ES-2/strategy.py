import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(L=75, W=780, K=2.25, stop_m=3.0, tgt_m=2.5, tmax=180, risk=130.0, trend_m=3.0,
              start=585, end=900, flat=955, max_per_day=4, confirm=0)

@njit
def _gen(c, day, mod, mult, L, W, K, stop_m, tgt_m, tmax, risk, trend_m, start, end, flat, maxpd, confirm):
    n = len(c)
    dc = np.zeros(n)
    for i in range(1, n):
        dc[i] = c[i] - c[i - 1]
    # rolling std via cumulative sums
    cs = np.zeros(n + 1); cs2 = np.zeros(n + 1)
    for i in range(n):
        cs[i + 1] = cs[i] + dc[i]; cs2[i + 1] = cs2[i] + dc[i] * dc[i]
    cap = n // 20 + 10
    bar = np.zeros(cap, np.int64); side = np.zeros(cap, np.int64); stop = np.zeros(cap)
    tgt = np.zeros(cap); ex = np.zeros(cap, np.int64); q = np.zeros(cap, np.int64)
    k = 0
    cur = -1; cnt = 0; ropen = np.nan
    for i in range(W + L, n):
        if day[i] != cur:
            cur = day[i]; cnt = 0; ropen = np.nan
        m = mod[i]
        if m == 570 and np.isnan(ropen):
            ropen = c[i - 1]
        if np.isnan(ropen) and m >= 570:
            ropen = c[i]
        if m < start or m > end or cnt >= maxpd or np.isnan(ropen):
            continue
        s1 = cs[i + 1] - cs[i + 1 - W]; s2 = cs2[i + 1] - cs2[i + 1 - W]
        var = s2 / W - (s1 / W) ** 2
        if var <= 0:
            continue
        sig = np.sqrt(var)
        u = sig * np.sqrt(L)
        z = (c[i] - c[i - L]) / u
        if abs(c[i] - ropen) > trend_m * sig * np.sqrt(390.0):
            continue
        sd = 0
        if z <= -K:
            sd = 1
        elif z >= K:
            sd = -1
        if sd == 0 or k >= cap:
            continue
        if confirm == 1 and ((sd == 1 and c[i] <= c[i - 1]) or (sd == -1 and c[i] >= c[i - 1])):
            continue
        sp = stop_m * u
        st = c[i] - sd * sp
        tg = c[i] + sd * tgt_m * u
        qq = int(risk / (sp * mult))
        if qq < 1:
            qq = 1
        e = i + tmax
        lim = i + (flat - m)
        if e > lim:
            e = lim
        bar[k] = i; side[k] = sd; stop[k] = st; tgt[k] = tg; ex[k] = e; q[k] = qq
        k += 1; cnt += 1
    return bar[:k], side[:k], stop[:k], tgt[:k], ex[:k], q[:k]

def generate(d, p):
    bar, side, stop, tgt, ex, q = _gen(d.c, d.day, d.minute_of_day_et, d.mult, p['L'], p['W'], p['K'],
                                       p['stop_m'], p['tgt_m'], p['tmax'], p['risk'], p['trend_m'],
                                       p['start'], p['end'], p['flat'], p['max_per_day'], p['confirm'])
    z = np.zeros(len(bar))
    return E.make_signals(bar, side, z.astype(np.int64), z, stop, tgt, ex, z.astype(np.int64), q)
