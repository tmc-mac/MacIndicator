"""ES-4: frozen regularized logistic regression -> thresholded entries, ATR stop/target, risk-fixed sizing."""
import sys, os, json
import numpy as np
from numba import njit
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine'))
import engine as E

HERE = os.path.dirname(os.path.abspath(__file__))
PARAMS = dict(T=0.065, ks=7.0, kt=0, hold=30, risk=150.0, step=5, first=585, last=900, flat=955,
              model='model.json')
NF = 8

@njit
def _roll_mean(x, w):
    n = len(x); out = np.full(n, np.nan); s = 0.0
    for i in range(n):
        s += x[i]
        if i >= w: s -= x[i - w]
        if i >= w - 1: out[i] = s / w
    return out

@njit
def _feats(o, h, l, c, v, day, mod):
    n = len(c)
    F = np.full((n, NF), np.nan)
    rng = h - l
    atr60 = _roll_mean(rng, 60)
    atr30 = _roll_mean(rng, 30)
    atr10 = _roll_mean(rng, 10)
    pv = 0.0; vv = 0.0; cur = -1; prev_close = np.nan; last_rth_close = np.nan
    for i in range(n):
        if day[i] != cur:
            if cur != -1:
                prev_close = last_rth_close
            cur = day[i]; pv = 0.0; vv = 0.0
        m = mod[i]
        if m >= 570 and m < 960:
            tp = (h[i] + l[i] + c[i]) / 3.0
            pv += tp * v[i]; vv += v[i]
            last_rth_close = c[i]
        if i < 120 or np.isnan(atr60[i]) or atr60[i] <= 0 or vv <= 0 or np.isnan(prev_close):
            continue
        a = atr60[i] * np.sqrt(30.0)   # ~ 30-bar scale of move
        F[i, 0] = (c[i] - c[i - 5]) / a
        F[i, 1] = (c[i] - c[i - 15]) / a
        F[i, 2] = (c[i] - c[i - 60]) / a
        F[i, 3] = (c[i] - pv / vv) / a
        F[i, 4] = (c[i] - prev_close) / a
        hi = h[i - 119]; lo = l[i - 119]
        for j in range(i - 119, i + 1):
            if h[j] > hi: hi = h[j]
            if l[j] < lo: lo = l[j]
        F[i, 5] = (c[i] - lo) / max(hi - lo, 1e-9) - 0.5
        F[i, 6] = np.log(max(atr10[i], 1e-9) / atr60[i])
        F[i, 7] = np.sin(2 * np.pi * (m - 570) / 390.0)
    return F, atr30

def features(d):
    return _feats(d.o, d.h, d.l, d.c, d.v.astype(np.float64), d.day, d.minute_of_day_et)

def prob(F, model):
    mu = np.array(model['mu']); sd = np.array(model['sd']); w = np.array(model['w']); b = model['b']
    z = ((F - mu) / sd) @ w + b
    return 1.0 / (1.0 + np.exp(-z))

def generate(d, params):
    p = params
    model = json.load(open(os.path.join(HERE, p['model'])))
    F, atr30 = features(d)
    ok = ~np.isnan(F).any(axis=1)
    pr = np.full(d.n, np.nan); pr[ok] = prob(F[ok], model)
    mod = d.minute_of_day_et
    idx = np.arange(d.n)
    sel = ok & (mod >= p['first']) & (mod <= p['last']) & (mod % p['step'] == 0) & (atr30 > 0)
    long_ = sel & (pr > 0.5 + p['T']); short_ = sel & (pr < 0.5 - p['T'])
    m = long_ | short_
    bar = idx[m]
    side = np.where(long_[m], 1, -1)
    a = atr30[m]
    px = d.c[m]
    sd_ = np.maximum(p['ks'] * a, 0.5)
    stop = px - side * sd_
    target = px + side * p['kt'] * a if p['kt'] > 0 else np.full(len(bar), np.nan)
    qty = np.maximum(np.floor(p['risk'] / (sd_ * d.mult)), 1).astype(np.int64)
    exit_by = np.minimum(bar + p['hold'] + 1, bar + 1 + np.maximum(p['flat'] - mod[m], 1))
    return E.make_signals(bar, side, np.zeros(len(bar), np.int64), px, stop, target, exit_by, bar, qty)
