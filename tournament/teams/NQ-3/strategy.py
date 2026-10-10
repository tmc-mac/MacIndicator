"""NQ-3: overnight / gap momentum.  Continuation of confirmed gaps, fade of failed gaps, scaled by ATR."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
from numba import njit
import engine as E

PARAMS = dict(AGTOL=0.05, DFAC=0.5, ASIA=1, AS=0.25, ARISK=200.0, AMIN=659, AGREE=1, ATHR=0.0, DRIFT=0, DS=0.5, DRISK=250.0, DMODE=0, G=0.15, S=0.25, RISK=250.0, EXIT_MIN=690, F=0.5, R=0.0, FADE=0, CONT=0, NATR=10)


@njit
def _gen(o, h, l, c, v, mod, day, G, S, RISK, EXIT_MIN, F, R, FADE, CONT, NATR, mult):
    n = len(c)
    rng = np.zeros(NATR); nr = 0; rp = 0
    curHi = -1e18; curLo = 1e18
    pc = np.nan; O = np.nan; Oday = -1
    onHi = -1e18; onLo = 1e18
    prev_m = -1
    out = np.zeros((n // 100 + 10, 9)); k = 0
    for i in range(n):
        m = mod[i]
        if prev_m != -1 and prev_m < 960 and m >= 960:
            onHi = -1e18; onLo = 1e18
            if curHi > -1e17:
                rng[rp] = curHi - curLo; rp = (rp + 1) % NATR
                if nr < NATR: nr += 1
            curHi = -1e18; curLo = 1e18
        if m >= 570 and m < 960:
            if m == 570:
                O = o[i]; Oday = day[i]
                curHi = -1e18; curLo = 1e18
            if h[i] > curHi: curHi = h[i]
            if l[i] < curLo: curLo = l[i]
            pc_live = c[i]
            if m == 959: pc = c[i]
        else:
            if h[i] > onHi: onHi = h[i]
            if l[i] < onLo: onLo = l[i]
        prev_m = m
        if m == 574 and Oday == day[i] and nr >= NATR and not np.isnan(pc) and k < out.shape[0]:
            atr = 0.0
            for j in range(NATR): atr += rng[j]
            atr /= NATR
            if atr <= 0: continue
            gap = O - pc
            gn = abs(gap) / atr
            if gn < G: continue
            if R > 0:
                on = onHi - onLo
                if on / atr < R: continue
            m5 = c[i] - O
            gs = 1 if gap > 0 else -1
            side = 0; tgt = np.nan
            if CONT == 1 and m5 * gs > 0 and (c[i] - pc) * gs > 0:
                side = gs
            elif FADE == 1 and m5 * gs < 0 and abs(m5) >= F * abs(gap):
                side = -gs
                tgt = pc
            if side == 0: continue
            sd = S * atr
            entry = c[i]
            stop = entry - side * sd
            q = int(RISK / (sd * mult))
            if q < 1: q = 1
            out[k, 0] = i; out[k, 1] = side; out[k, 2] = stop; out[k, 3] = tgt
            out[k, 4] = i + (EXIT_MIN - 574); out[k, 5] = q
            k += 1
    return out[:k]


def generate(d, p):
    r = _gen(d.o, d.h, d.l, d.c, d.v, d.minute_of_day_et, d.day, p['G'], p['S'], p['RISK'], p['EXIT_MIN'],
             p['F'], p['R'], p['FADE'], p['CONT'], p['NATR'], d.mult)
    z = np.zeros(len(r))
    bar, side, stop, tgt, ex, q = r[:, 0], r[:, 1], r[:, 2], r[:, 3], r[:, 4], r[:, 5]
    if p['ASIA']:
        ar = _asia(d.o, d.h, d.l, d.c, d.minute_of_day_et, d.day, p['AS'], p['ARISK'], p['AMIN'], p['AGREE'], p['ATHR'], p['NATR'], d.mult, p['DFAC'], p['AGTOL'])
        bar = np.concatenate([bar, ar[:, 0]]); side = np.concatenate([side, ar[:, 1]]); stop = np.concatenate([stop, ar[:, 2]])
        tgt = np.concatenate([tgt, ar[:, 3]]); ex = np.concatenate([ex, ar[:, 4]]); q = np.concatenate([q, ar[:, 5]])
    if p['DRIFT']:
        dr = _drift(d.c, d.h, d.l, d.minute_of_day_et, p['DS'], p['DRISK'], p['DMODE'], d.mult, p['NATR'])
        e569 = np.nonzero(d.minute_of_day_et == 569)[0]
        db = dr[:, 0].astype(np.int64)
        j = np.searchsorted(e569, db, side='right')
        dex = np.where(j < len(e569), e569[np.minimum(j, len(e569) - 1)], d.n - 1)
        bar = np.concatenate([bar, db]); side = np.concatenate([side, dr[:, 1]]); stop = np.concatenate([stop, dr[:, 2]])
        tgt = np.concatenate([tgt, np.full(len(db), np.nan)]); ex = np.concatenate([ex, dex]); q = np.concatenate([q, dr[:, 5]])
        z = np.zeros(len(bar))
    z = np.zeros(len(bar))
    return E.make_signals(bar, side, z, z, stop, tgt, ex, bar + 1, q)


@njit
def _drift(c, hh, ll, mod, DS, DRISK, DMODE, mult, NATR):
    n = len(c)
    rng = np.zeros(NATR); nr = 0; rp = 0
    hi = -1e18; lo = 1e18; prev_m = -1
    rc = np.nan; ro = np.nan
    out = np.zeros((n // 500 + 10, 6)); k = 0
    for i in range(n):
        m = mod[i]
        if m >= 570 and m < 960:
            if m == 570: hi = -1e18; lo = 1e18; ro = c[i]
            if hh[i] > hi: hi = hh[i]
            if ll[i] < lo: lo = ll[i]
        if m == 959 and nr >= NATR and k < out.shape[0]:
            rng[rp] = hi - lo; rp = (rp + 1) % NATR
            if nr < NATR: nr += 1
            atr = 0.0
            for j in range(NATR): atr += rng[j]
            atr /= NATR
            sd = DS * atr
            # DMODE 0: always long; 1: long only if RTH return <= 0 (fade weak day); 2: long only if RTH return > 0
            ret = c[i] - ro
            ok = True
            if DMODE == 1 and ret > 0: ok = False
            if DMODE == 2 and ret <= 0: ok = False
            if ok:
                q = int(DRISK / (sd * mult))
                if q < 1: q = 1
                # exit at 09:29 next session: ~ 17.5h = 1050 min later in contiguous bars; use search handled outside
                out[k, 0] = i; out[k, 1] = 1; out[k, 2] = c[i] - sd; out[k, 5] = q; k += 1
        elif m == 959:
            rng[rp] = hi - lo; rp = (rp + 1) % NATR
            if nr < NATR: nr += 1
    return out[:k]


@njit
def _asia(o, h, l, c, mod, day, AS, ARISK, AMIN, AGREE, ATHR, NATR, mult, DFAC, AGTOL):
    """Asia return = open(03:00) - open(18:00); trade sign at 09:30 open (decide on 09:29 close)."""
    n = len(c)
    rng = np.zeros(NATR); nr = 0; rp = 0
    hi = -1e18; lo = 1e18
    o18 = np.nan; o03 = np.nan; o925 = np.nan
    out = np.zeros((n // 500 + 10, 6)); k = 0
    for i in range(n):
        m = mod[i]
        if m == 1080: o18 = o[i]
        if m == 180: o03 = o[i]
        if m == 565: o925 = o[i]
        if m >= 570 and m < 960:
            if m == 570: hi = -1e18; lo = 1e18
            if h[i] > hi: hi = h[i]
            if l[i] < lo: lo = l[i]
        if m == 959:
            rng[rp] = hi - lo; rp = (rp + 1) % NATR
            if nr < NATR: nr += 1
        if m == 569 and nr >= NATR and k < out.shape[0] and not np.isnan(o18) and not np.isnan(o03):
            atr = 0.0
            for j in range(NATR): atr += rng[j]
            atr /= NATR
            a1 = o03 - o18
            if abs(a1) < ATHR * atr: continue
            rk = ARISK
            side = 1 if a1 > 0 else -1
            if AGREE == 1:
                a3 = c[i] - o03
                if a3 * side < -AGTOL * atr: continue
            elif AGREE == 2:
                a3 = c[i] - o03
                if a3 * side <= 0:
                    side = 1 if a3 > 0 else -1
                    rk = ARISK * DFAC
            elif AGREE == 3:
                a3 = c[i] - o03
                if a3 * side > 0: continue
                side = 1 if a3 > 0 else -1
            sd = AS * atr
            q = int(rk / (sd * mult))
            if q < 1: q = 1
            out[k, 0] = i; out[k, 1] = side; out[k, 2] = c[i] - side * sd; out[k, 3] = np.nan
            out[k, 4] = i + (AMIN - 569); out[k, 5] = q; k += 1
    return out[:k]


RISK_KEY = 'ARISK'
TUNABLE = ['AS', 'AMIN', 'ARISK', 'AGTOL', 'NATR']
