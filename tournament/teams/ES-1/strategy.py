import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS_A = dict(k_entry=2.0, slope_max=0.6, buf=0.25, risk=120.0, max_tr=3, t0=600, t1=900, eod=955,
              max_hold=90, min_rr=0.8, lookback=5, slope_n=30, max_risk1=250.0)


@njit
def _gen(o, h, l, c, v, day, mod, mult, k, slope_max, buf, risk, max_tr, t0, t1, eod, max_hold, min_rr,
         lookback, slope_n, max_risk1):
    n = len(c)
    vw = np.full(n, np.nan); sd = np.full(n, np.nan)
    out_bar = np.zeros(n, np.int64); out_side = np.zeros(n, np.int64); out_px = np.zeros(n)
    out_stop = np.zeros(n); out_tgt = np.zeros(n); out_exit = np.zeros(n, np.int64); out_q = np.zeros(n, np.int64)
    m = 0
    sv = 0.0; spv = 0.0; spv2 = 0.0
    cur = -1
    ntoday = 0
    last_sig = -10**9
    ex_hi = np.nan; ex_lo = np.nan
    below = -10**9; above = -10**9
    eod_bar = -1
    for i in range(n):
        if day[i] != cur:
            cur = day[i]; sv = 0.0; spv = 0.0; spv2 = 0.0; ntoday = 0
            below = -10**9; above = -10**9
        mi = mod[i]
        if mi < 570 or mi >= 960:
            continue
        tp = (h[i] + l[i] + c[i]) / 3.0
        vol = v[i] if v[i] > 0 else 1.0
        sv += vol; spv += tp * vol; spv2 += tp * tp * vol
        w = spv / sv
        var = spv2 / sv - w * w
        if var < 0: var = 0.0
        vw[i] = w; sd[i] = np.sqrt(var)
        if mi < t0 or mi >= t1:
            continue
        s = sd[i]
        if s < 1.0: continue
        # excursion tracking
        if c[i] < w - k * s:
            below = i
        if c[i] > w + k * s:
            above = i
        if ntoday >= max_tr or i - last_sig < 20:
            continue
        if i - slope_n < 0 or np.isnan(vw[i - slope_n]):
            continue
        slope = (w - vw[i - slope_n]) / s
        if abs(slope) > slope_max:
            continue
        side = 0
        if i - below <= lookback and below != i and c[i] >= w - k * s:
            side = 1
            ext = l[below]
            for j in range(below, i + 1):
                if l[j] < ext: ext = l[j]
            stop = ext - buf * s
        elif i - above <= lookback and above != i and c[i] <= w + k * s:
            side = -1
            ext = h[above]
            for j in range(above, i + 1):
                if h[j] > ext: ext = h[j]
            stop = ext + buf * s
        if side == 0: continue
        entry = c[i]
        risk_pts = abs(entry - stop)
        reward = side * (w - entry)
        if reward <= 0.5 or risk_pts <= 0 or reward < min_rr * risk_pts: continue
        if risk_pts * mult > max_risk1: continue
        q = int(risk / (risk_pts * mult))
        if q < 1: q = 1
        # exit bar: eod or max hold (index of eod bar found by scan)
        ex = i + max_hold
        j = i
        while j < n - 1 and j < i + max_hold and mod[j + 1] < eod and day[j + 1] == day[i] and mod[j+1] >= 570:
            j += 1
        ex = j
        out_bar[m] = i; out_side[m] = side; out_px[m] = entry; out_stop[m] = np.round(stop * 4) / 4
        out_tgt[m] = np.round(w * 4) / 4; out_exit[m] = ex; out_q[m] = q
        m += 1; ntoday += 1; last_sig = i
        below = -10**9; above = -10**9
    return m, out_bar[:m], out_side[:m], out_px[:m], out_stop[:m], out_tgt[:m], out_exit[:m], out_q[:m]


def generate_a(d, p):
    m, bar, side, px, stop, tgt, ex, q = _gen(d.o, d.h, d.l, d.c, d.v.astype(np.float64), d.day, d.minute_of_day_et,
        d.mult, p['k_entry'], p['slope_max'], p['buf'], p['risk'], p['max_tr'], p['t0'], p['t1'], p['eod'],
        p['max_hold'], p['min_rr'], p['lookback'], p['slope_n'], p['max_risk1'])
    return E.make_signals(bar, side, np.zeros(m, np.int64), px, stop, tgt, ex, ex, q)


PARAMS_B = dict(s_min=0.5, pb=0.6, stopk=2.0, rr=0, risk=100.0, max_tr=3, t0=600, t1=900, eod=955,
                slope_n=45, max_risk1=150.0, cool=15, clean_n=0, htf=0)


@njit
def _genb(o, h, l, c, v, day, mod, mult, s_min, pb, stopk, rr, risk, max_tr, t0, t1, eod, slope_n, max_risk1, cool, clean_n, htf):
    n = len(c)
    vw = np.full(n, np.nan)
    out_bar = np.zeros(n, np.int64); out_side = np.zeros(n, np.int64); out_px = np.zeros(n)
    out_stop = np.zeros(n); out_tgt = np.zeros(n); out_exit = np.zeros(n, np.int64); out_q = np.zeros(n, np.int64)
    m = 0
    sv = 0.0; spv = 0.0; spv2 = 0.0
    cur = -1; ntoday = 0; last_sig = -10**9
    prev_close = np.nan; last_rth = np.nan; day_open = np.nan
    for i in range(n):
        if day[i] != cur:
            cur = day[i]; sv = 0.0; spv = 0.0; spv2 = 0.0; ntoday = 0
            prev_close = last_rth
        mi = mod[i]
        if mi < 570 or mi >= 960:
            continue
        last_rth = c[i]
        tp = (h[i] + l[i] + c[i]) / 3.0
        vol = v[i] if v[i] > 0 else 1.0
        sv += vol; spv += tp * vol; spv2 += tp * tp * vol
        w = spv / sv
        var = spv2 / sv - w * w
        if var < 0: var = 0.0
        vw[i] = w; s = np.sqrt(var)
        if mi < t0 or mi >= t1 or s < 1.0: continue
        if ntoday >= max_tr or i - last_sig < cool: continue
        if i - slope_n < 0 or np.isnan(vw[i - slope_n]): continue
        slope = (w - vw[i - slope_n]) / s
        side = 0
        if slope >= s_min and c[i] > w and l[i] <= w + pb * s and c[i] > o[i]:
            side = 1; stop = min(w, l[i]) - stopk * s
        elif slope <= -s_min and c[i] < w and h[i] >= w - pb * s and c[i] < o[i]:
            side = -1; stop = max(w, h[i]) + stopk * s
        if side == 0: continue
        if htf == 1 and (np.isnan(prev_close) or side * (c[i] - prev_close) <= 0): continue
        if clean_n > 0:
            if i - clean_n < 0: continue
            okc = True
            for j in range(i - clean_n, i):
                if np.isnan(vw[j]) or side * (c[j] - vw[j]) <= 0:
                    okc = False
                    break
            if not okc: continue
        entry = c[i]
        rp = abs(entry - stop)
        if rp <= 0 or rp * mult > max_risk1: continue
        q = int(risk / (rp * mult))
        if q < 1: q = 1
        j = i
        while j < n - 1 and mod[j + 1] < eod and day[j + 1] == day[i] and mod[j + 1] >= 570:
            j += 1
        out_bar[m] = i; out_side[m] = side; out_px[m] = entry; out_stop[m] = np.round(stop * 4) / 4
        out_tgt[m] = np.round((entry + side * rr * rp) * 4) / 4 if rr > 0 else np.nan
        out_exit[m] = j; out_q[m] = q
        m += 1; ntoday += 1; last_sig = i
    return m, out_bar[:m], out_side[:m], out_px[:m], out_stop[:m], out_tgt[:m], out_exit[:m], out_q[:m]


def generate_b(d, p):
    m, bar, side, px, stop, tgt, ex, q = _genb(d.o, d.h, d.l, d.c, d.v.astype(np.float64), d.day, d.minute_of_day_et,
        d.mult, p['s_min'], p['pb'], p['stopk'], p['rr'], p['risk'], p['max_tr'], p['t0'], p['t1'], p['eod'],
        p['slope_n'], p['max_risk1'], p['cool'], p['clean_n'], p['htf'])
    return E.make_signals(bar, side, np.zeros(m, np.int64), px, stop, tgt, ex, ex, q)


PARAMS = PARAMS_B
generate = generate_b
