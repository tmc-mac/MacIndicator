"""NQ-7: daily-structure conditioned intraday continuation. After a balanced (neutral close-location) prior
session, the morning move (09:36->11:00 ET) is followed in the afternoon. One trade/day, defined stop, time exit."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine'))
import numpy as np
import engine as E

PARAMS = dict(clv_lo=0.1, clv_hi=0.9, look=10, min_move=0.0, stop_mult=0.25, risk=150.0,
              open_min=576, entry_min=659, exit_min=955)


def generate(d, p):
    day = d.day; n = d.n
    starts = np.r_[0, np.flatnonzero(np.diff(day)) + 1]
    ends = np.r_[starts[1:], n]
    nd = len(starts)
    H = np.maximum.reduceat(d.h, starts); L = np.minimum.reduceat(d.l, starts)
    C = d.c[ends - 1]
    R = H - L
    bars, sides, stops, qty, exits = [], [], [], [], []
    mod = d.minute_of_day_et
    K = p['look']
    for k in range(K + 1, nd):
        s, e = starts[k], ends[k]
        seg = mod[s:e]
        ia = np.flatnonzero(seg == p['open_min']); ie = np.flatnonzero(seg == p['entry_min'])
        if len(ia) == 0 or len(ie) == 0:
            continue
        i = s + ie[0]
        xs = np.flatnonzero((seg <= p['exit_min']) & (seg >= p['entry_min']))
        if len(xs) < 5:
            continue
        xb = s + xs[-1]
        pr = R[k - 1]
        if pr <= 0:
            continue
        clv = (C[k - 1] - L[k - 1]) / pr
        if clv < p['clv_lo'] or clv > p['clv_hi']:
            continue
        mr = R[k - K:k].mean()
        mv = d.c[i] - d.o[s + ia[0]]
        if abs(mv) < p['min_move'] * mr or mv == 0:
            continue
        side = 1 if mv > 0 else -1
        S = p['stop_mult'] * mr
        if S < 5:
            continue
        q = int(max(1, min(40, np.floor(p['risk'] / (S * d.mult)))))
        bars.append(i); sides.append(side); stops.append(d.c[i] - side * S); qty.append(q); exits.append(xb)
    m = len(bars)
    return E.make_signals(bars, sides, np.zeros(m, np.int64), np.full(m, np.nan), stops,
                          np.full(m, np.nan), exits, np.zeros(m, np.int64), qty)

RISK_KEY = 'risk'
TUNABLE = ['clv_lo', 'clv_hi', 'look', 'stop_mult', 'open_min', 'entry_min', 'exit_min']
