"""NQ-5: ICT liquidity sweep + displacement + FVG limit entry in the NY AM killzone."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(k_disp=0.85, atr_n=30, frac=3, lookback=120, disp_win=8, rr=0.5, risk=175.0,
              kz_start=510, kz_end=660, exit_min=720, max_per_day=2, min_stop=4.0, max_stop=60.0,
              cancel=20, buf_ticks=2)


@njit(cache=False)
def _sweeps(h, l, c, frac, lookback):
    """sw_lo[j] = price of swing low swept at bar j (wick below, close back above), else nan; sw_hi mirrored."""
    n = len(h)
    sw_lo = np.full(n, np.nan); sw_hi = np.full(n, np.nan)
    for j in range(lookback + 2 * frac, n):
        # swing lows: pivot p confirmed at p+frac <= j-1
        best_lo = np.nan; best_hi = np.nan
        for p in range(j - 1 - frac, j - lookback, -1):
            isl = True; ish = True
            for q in range(p - frac, p + frac + 1):
                if q == p: continue
                if l[q] < l[p]: isl = False
                if h[q] > h[p]: ish = False
            if isl and l[j] < l[p] and c[j] > l[p] and np.isnan(best_lo):
                # not already broken between pivot and j
                ok = True
                for q in range(p + 1, j):
                    if l[q] < l[p]: ok = False; break
                if ok: best_lo = l[p]
            if ish and h[j] > h[p] and c[j] < h[p] and np.isnan(best_hi):
                ok = True
                for q in range(p + 1, j):
                    if h[q] > h[p]: ok = False; break
                if ok: best_hi = h[p]
        sw_lo[j] = best_lo; sw_hi[j] = best_hi
    return sw_lo, sw_hi


@njit(cache=False)
def _gen(o, h, l, c, day, mod, atr, sw_lo, sw_hi, k_disp, disp_win, rr, risk, mult, kz0, kz1, exit_min,
         max_per_day, min_stop, max_stop, cancel, buf, ob, os_, oside, opx, ostop, otgt, oexit, ocancel, oq):
    n = len(c); cnt = 0
    cur = -1; nday = 0; last_sig = -10**9
    for m in range(40, n):
        if day[m] != cur:
            cur = day[m]; nday = 0
        if mod[m] < kz0 or mod[m] >= kz1 or nday >= max_per_day or m - last_sig < cancel:
            continue
        if np.isnan(atr[m]) or atr[m] <= 0: continue
        rng = h[m] - l[m]
        if rng < k_disp * atr[m]: continue
        for side in (1, -1):
            if side == 1 and not (c[m] > o[m] and l[m] > h[m - 2]): continue
            if side == -1 and not (c[m] < o[m] and h[m] < l[m - 2]): continue
            jf = -1
            for j in range(m - 1, m - 1 - disp_win, -1):
                if side == 1 and not np.isnan(sw_lo[j]) and c[m] > h[j]: jf = j; break
                if side == -1 and not np.isnan(sw_hi[j]) and c[m] < l[j]: jf = j; break
            if jf < 0: continue
            if side == 1:
                ext = l[jf]
                for q in range(jf, m + 1):
                    if l[q] < ext: ext = l[q]
                entry = 0.5 * (l[m] + h[m - 2]); stop = ext - buf * 0.25
            else:
                ext = h[jf]
                for q in range(jf, m + 1):
                    if h[q] > ext: ext = h[q]
                entry = 0.5 * (h[m] + l[m - 2]); stop = ext + buf * 0.25
            sd = abs(entry - stop)
            if sd < min_stop or sd > max_stop: continue
            q_ = int(risk / (sd * mult))
            if q_ < 1: continue
            ob[cnt] = m; os_[cnt] = side; oside[cnt] = side; opx[cnt] = entry; ostop[cnt] = stop
            otgt[cnt] = entry + side * rr * sd
            oexit[cnt] = m + 1 + max(exit_min - mod[m], 2); ocancel[cnt] = m + cancel; oq[cnt] = q_
            cnt += 1; nday += 1; last_sig = m
            break
    return cnt


def generate(d, p):
    h, l, c, o = d.h, d.l, d.c, d.o
    tr = np.maximum(h - l, np.maximum(np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))))
    tr[0] = h[0] - l[0]
    a = 2.0 / (p['atr_n'] + 1)
    atr = _ema(tr, a)
    sw_lo, sw_hi = _sweeps(h, l, c, p['frac'], p['lookback'])
    cap = d.n // 20 + 100
    z = lambda t=np.float64: np.zeros(cap, t)
    ob, os_, oside = z(np.int64), z(np.int64), z(np.int64)
    opx, ostop, otgt = z(), z(), z()
    oexit, ocancel, oq = z(np.int64), z(np.int64), z(np.int64)
    cnt = _gen(o, h, l, c, d.day, d.minute_of_day_et, atr, sw_lo, sw_hi, p['k_disp'], p['disp_win'], p['rr'],
               p['risk'], d.mult, p['kz_start'], p['kz_end'], p['exit_min'], p['max_per_day'], p['min_stop'],
               p['max_stop'], p['cancel'], p['buf_ticks'], ob, os_, oside, opx, ostop, otgt, oexit, ocancel, oq)
    s = slice(0, cnt)
    return E.make_signals(ob[s], oside[s], np.ones(cnt, np.int64), opx[s], ostop[s], otgt[s], oexit[s], ocancel[s], oq[s])


@njit(cache=False)
def _ema(x, a):
    y = np.empty(len(x)); y[0] = x[0]
    for i in range(1, len(x)):
        y[i] = y[i - 1] + a * (x[i] - y[i - 1])
    return y
