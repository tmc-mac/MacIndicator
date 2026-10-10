import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(risk=100.0, N=15, rmult=2.0, buf=1.0, max_stop=12.0, min_stop=2.0,
              tenkan=9, kijun=26, senkou=52, start=585, last=900, flat=955, lookback=2)
RISK_KEY = 'risk'
TUNABLE = ['N', 'rmult', 'buf', 'max_stop']

@njit
def _gen(h, l, c, day, mod, mult, N, rmult, buf, max_stop, min_stop, T, K, S, start, last, flat, lb, risk,
         ob, os_, ost, otg, oex, oq):
    n = len(c)
    # aggregated bars
    ah = np.zeros(n // N + 10); al = np.zeros(n // N + 10); ac = np.zeros(n // N + 10)
    aday = np.zeros(n // N + 10, np.int64)
    m = 0
    ch = -1e18; cl = 1e18; cur = -1
    k = 0
    sh = np.zeros(n // N + 10)  # unused placeholder
    lastsig_day = -1
    for i in range(n):
        b = mod[i] // N
        key = day[i] * 2000 + b
        if key != cur:
            cur = key; ch = h[i]; cl = l[i]
        else:
            if h[i] > ch: ch = h[i]
            if l[i] < cl: cl = l[i]
        if (mod[i] + 1) % N == 0:        # last minute of the bucket -> bar complete
            ah[m] = ch; al[m] = cl; ac[m] = c[i]; aday[m] = day[i]
            m += 1
            cur = -1
            if m < S + K + 5:
                continue
            if mod[i] < start or mod[i] > last:
                continue
            j = m - 1
            def_ok = aday[j - S - K] == aday[j - S - K]
            # tenkan/kijun at j and previous bars
            # cloud at j uses spans computed at j-K
            tn = 0.0; kj = 0.0
            side = 0
            # compute helper values inline
            for off in range(lb + 1):
                jj = j - off
                t1 = -1e18; t2 = 1e18
                for q in range(jj - T + 1, jj + 1):
                    if ah[q] > t1: t1 = ah[q]
                    if al[q] < t2: t2 = al[q]
                tn_ = (t1 + t2) / 2
                k1 = -1e18; k2 = 1e18
                for q in range(jj - K + 1, jj + 1):
                    if ah[q] > k1: k1 = ah[q]
                    if al[q] < k2: k2 = al[q]
                kj_ = (k1 + k2) / 2
                if off == 0:
                    tn = tn_; kj = kj_
                    ktop = k1; kbot = k2
                if off == lb:
                    tn_old = tn_; kj_old = kj_
                if off == 0:
                    pass
            # cloud at j: spans at j-K
            jc = j - K
            t1 = -1e18; t2 = 1e18
            for q in range(jc - T + 1, jc + 1):
                if ah[q] > t1: t1 = ah[q]
                if al[q] < t2: t2 = al[q]
            tc = (t1 + t2) / 2
            k1 = -1e18; k2 = 1e18
            for q in range(jc - K + 1, jc + 1):
                if ah[q] > k1: k1 = ah[q]
                if al[q] < k2: k2 = al[q]
            kc = (k1 + k2) / 2
            s1 = -1e18; s2 = 1e18
            for q in range(jc - S + 1, jc + 1):
                if ah[q] > s1: s1 = ah[q]
                if al[q] < s2: s2 = al[q]
            sb = (s1 + s2) / 2
            sa = (tc + kc) / 2
            top = max(sa, sb); bot = min(sa, sb)
            cl_now = ac[j]
            chik_ref = ac[j - K]
            if tn > kj and tn_old <= kj_old and cl_now > top and cl_now > chik_ref and cl_now > kj:
                side = 1
            elif tn < kj and tn_old >= kj_old and cl_now < bot and cl_now < chik_ref and cl_now < kj:
                side = -1
            if side == 0:
                continue
            if aday[j] == lastsig_day:
                continue
            if side == 1:
                st = min(kj, bot, cl_now - min_stop) - buf if False else min(kj, top) - buf
                dist = cl_now - st
            else:
                st = max(kj, bot) + buf
                dist = st - cl_now
            if dist < min_stop:
                dist = min_stop; st = cl_now - side * dist
            if dist > max_stop:
                continue
            q = int(risk / (dist * mult))
            if q < 1: q = 1
            ob[k] = i; os_[k] = side; ost[k] = st; otg[k] = cl_now + side * dist * rmult
            oex[k] = i + (flat - mod[i]); oq[k] = q
            k += 1
            lastsig_day = aday[j]
    return k

def generate(d, p):
    n = d.n
    cap = n // 20 + 10
    ob = np.zeros(cap, np.int64); os_ = np.zeros(cap, np.int64); ost = np.zeros(cap); otg = np.zeros(cap)
    oex = np.zeros(cap, np.int64); oq = np.zeros(cap, np.int64)
    k = _gen(d.h, d.l, d.c, d.day, d.minute_of_day_et, d.mult, int(round(p['N'])), p['rmult'], p['buf'], p['max_stop'],
             p['min_stop'], int(p['tenkan']), int(p['kijun']), int(p['senkou']), int(p['start']), int(p['last']),
             int(p['flat']), int(p['lookback']), p['risk'], ob, os_, ost, otg, oex, oq)
    z = np.zeros(k)
    return E.make_signals(ob[:k], os_[:k], np.zeros(k, np.int64), z, ost[:k], otg[:k], oex[:k], z.astype(np.int64), oq[:k])
