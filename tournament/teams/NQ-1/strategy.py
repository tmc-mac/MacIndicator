import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(K=20, brk=1.0, N=20, rrmin=1.5, cz=1.0, risk=60.0, maxstop=7.0, stopbuf=0.5,
              t_start=210, t_end=900, flat=955, max_day=3, rrcap=4.0, lvmask=127, off=2.0, minconf=0, tr=0, trs=1)


@njit(cache=True)
def _gen(ts, o, h, l, c, v, day, mod, K, brk, N, rrmin, cz, risk, maxstop, stopbuf,
         t_start, t_end, flat, max_day, rrcap, lvmask, off, minconf, tr, trs, mult, out):
    n = len(c)
    NL = 7
    lv = np.full(NL, np.nan)
    cs = np.zeros(n + 1)
    for i in range(n):
        cs[i + 1] = cs[i] + (h[i] - l[i])
    cur_day = -1
    day_h = -1e18; day_l = 1e18
    pd_h = np.nan; pd_l = np.nan
    as_h = -1e18; as_l = 1e18
    wk = -1
    wk_h = -1e18; wk_l = 1e18
    pw_h = np.nan; pw_l = np.nan
    pv = 0.0; vv = 0.0
    used = np.zeros((NL, 2), np.int64)   # session id last used
    ntr_day = 0
    busy_until = -1
    m = 0
    for i in range(n):
        d = day[i]
        if d != cur_day:
            if cur_day != -1:
                pd_h = day_h; pd_l = day_l
            cur_day = d
            day_h = -1e18; day_l = 1e18
            as_h = -1e18; as_l = 1e18
            pv = 0.0; vv = 0.0
            ntr_day = 0
            w = (d + 3) // 7
            if w != wk:
                if wk != -1:
                    pw_h = wk_h; pw_l = wk_l
                wk = w
                wk_h = -1e18; wk_l = 1e18
        if h[i] > day_h: day_h = h[i]
        if l[i] < day_l: day_l = l[i]
        if h[i] > wk_h: wk_h = h[i]
        if l[i] < wk_l: wk_l = l[i]
        mi = mod[i]
        if mi >= 1080 or mi < 180:
            if h[i] > as_h: as_h = h[i]
            if l[i] < as_l: as_l = l[i]
        if mi >= 570 and mi < 960:
            tp = (h[i] + l[i] + c[i]) / 3.0
            pv += tp * v[i]; vv += v[i]
        if i < 80 or mi < t_start or mi >= t_end or ntr_day >= max_day or i <= busy_until:
            continue
        # levels
        lv[0] = pd_h; lv[1] = pd_l
        if mi >= 180 and mi < 1080:
            lv[2] = as_h; lv[3] = as_l
        else:
            lv[2] = np.nan; lv[3] = np.nan
        lv[4] = pw_h; lv[5] = pw_l
        if mi >= 600 and mi < 960 and vv > 0:
            lv[6] = pv / vv
        else:
            lv[6] = np.nan
        atr = (cs[i + 1] - cs[i + 1 - 60]) / 60.0
        if atr <= 0:
            continue
        mn = 1e18; mx = -1e18
        for j in range(i - K + 1, i + 1):
            if l[j] < mn: mn = l[j]
            if h[j] > mx: mx = h[j]
        best_score = -1
        bk = -1; bside = 0
        for k in range(NL):
            L = lv[k]
            if np.isnan(L) or ((lvmask >> k) & 1) == 0:
                continue
            for sd in range(2):
                if sd == 0:   # long reclaim
                    ok = (mn < L - brk * atr) and c[i] > L and c[i - 1] <= L
                else:
                    ok = (mx > L + brk * atr) and c[i] < L and c[i - 1] >= L
                if not ok or used[k, sd] == d:
                    continue
                nc = 0
                for k2 in range(NL):
                    if k2 != k and not np.isnan(lv[k2]) and abs(lv[k2] - L) <= cz * atr:
                        nc += 1
                if nc > 2: nc = 2
                if nc > best_score:
                    best_score = nc; bk = k; bside = 1 if sd == 0 else -1
        if bk < 0:
            continue
        L = lv[bk]
        if best_score < minconf:
            continue
        if tr > 0 and i > tr and trs * bside * (c[i] - c[i - tr]) <= 0:
            continue
        E0 = L + bside * off * atr
        if bside == 1:
            stop = mn - stopbuf * atr
            rk = E0 - stop
        else:
            stop = mx + stopbuf * atr
            rk = stop - E0
        used[bk, 0 if bside == 1 else 1] = d
        if rk > maxstop * atr or rk < 1.0:
            continue
        # target: nearest level beyond L with distance >= rrmin*rk
        tgt = np.nan
        bd = 1e18
        for k2 in range(NL):
            x = lv[k2]
            if np.isnan(x): continue
            dist = (x - E0) * bside
            if dist >= rrmin * rk and dist < bd:
                bd = dist; tgt = x
        if np.isnan(tgt):
            continue
        if bd > rrcap * rk:
            tgt = E0 + bside * rrcap * rk
        q = int((risk * (1.0 + 0.5 * best_score)) / (rk * mult))
        if q < 1: q = 1
        # session flat bar: find bar index at ET minute 'flat' (look ahead only in index space, using minute clock)
        # approximate: bars are 1/min; steps = flat - mi (minutes), exit_by bar index
        eb = i + (flat - mi)
        if eb >= n: eb = n - 1
        out[m, 0] = i; out[m, 1] = bside; out[m, 2] = E0; out[m, 3] = stop; out[m, 4] = tgt
        out[m, 5] = eb; out[m, 6] = i + N; out[m, 7] = q
        m += 1
        ntr_day += 1
        busy_until = i + N
    return m


def generate(d, p):
    out = np.zeros((200000, 8))
    m = _gen(d.ts, d.o, d.h, d.l, d.c, d.v.astype(np.float64), d.day, d.minute_of_day_et,
             p['K'], p['brk'], p['N'], p['rrmin'], p['cz'], p['risk'], p['maxstop'], p['stopbuf'],
             p['t_start'], p['t_end'], p['flat'], p['max_day'], p['rrcap'], p['lvmask'], p['off'], p['minconf'], p['tr'], p['trs'], d.mult, out)
    o = out[:m]
    return E.make_signals(o[:, 0], o[:, 1], np.ones(m, np.int64), o[:, 2], o[:, 3], o[:, 4], o[:, 5], o[:, 6], o[:, 7])
