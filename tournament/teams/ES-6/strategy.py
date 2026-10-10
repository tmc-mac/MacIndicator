import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine'))
import numpy as np
import engine as E

RISK_KEY = 'risk_usd'
TUNABLE = ['moc_k', 'moc_stop', 'k_imp', 'close_frac', 'stop_cap', 'tgt_r']
PARAMS = dict(events=(510, 600, 840), k_imp=3.0, close_frac=0.30, stop_cap=12.0, tgt_r=1.5, hold_a=45,
              moc_k=3.0, moc_stop=5.0, risk_usd=160.0, lookback=60, use_moc=True, use_a=False, fade=())


def _r1(d, i, lb):
    # mean 1-min range of lb bars ending at bar i-1; contiguous check
    if i - lb < 0 or d.ts[i] - d.ts[i - lb] != 60 * lb:
        return np.nan
    return float(np.mean(d.h[i - lb:i] - d.l[i - lb:i]))


def generate(d, p):
    bars, sides, px, stops, tgts, exits, qty = [], [], [], [], [], [], []
    mult = d.mult
    mod = d.minute_of_day_et
    lb = p['lookback']
    if p['use_a']:
        for ev in p['events']:
            for i in np.nonzero(mod == ev)[0]:
                if i + 2 >= d.n or i < lb or d.dow[i] > 4:
                    continue
                if d.ts[i + 2] - d.ts[i] != 120:
                    continue
                r1 = _r1(d, i, lb)
                if not r1 > 0:
                    continue
                dec = i + 2
                imp = d.c[dec] - d.o[i]
                hi = d.h[i:i + 3].max(); lo = d.l[i:i + 3].min(); rng = hi - lo
                if rng <= 0 or abs(imp) < p['k_imp'] * r1:
                    continue
                simp = 1 if imp > 0 else -1
                pos = (d.c[dec] - lo) / rng
                if simp == 1 and pos < 1 - p['close_frac']:
                    continue
                if simp == -1 and pos > p['close_frac']:
                    continue
                side = -simp if ev in p['fade'] else simp
                stop = lo if side == 1 else hi
                D = abs(d.c[dec] - stop) + 0.5  # approx entry distance incl. slippage buffer
                if D > p['stop_cap'] * r1 or D <= 0.5:
                    continue
                q = int(p['risk_usd'] // (D * mult))
                q = max(1, min(q, 40))
                bars.append(dec); sides.append(side); px.append(0.0); stops.append(stop)
                tgts.append(d.c[dec] + side * p['tgt_r'] * D); exits.append(dec + p['hold_a']); qty.append(q)
    if p['use_moc']:
        for i in np.nonzero(mod == 950)[0]:
            if i < lb + 100 or d.dow[i] > 4 or d.day[i] != d.day[i - 80]:
                continue
            j = i - 80
            if d.ts[i] - d.ts[j] != 80 * 60 or mod[j] != 870:
                continue
            r1 = _r1(d, i, lb)
            if not r1 > 0:
                continue
            mv = d.c[i] - d.c[j]
            if abs(mv) < p['moc_k'] * r1:
                continue
            side = 1 if mv > 0 else -1
            D = p['moc_stop'] * r1
            stop = d.c[i] - side * D
            q = max(1, min(int(p['risk_usd'] // ((D + 0.5) * mult)), 40))
            ex = i + 9
            bars.append(i); sides.append(side); px.append(0.0); stops.append(stop)
            tgts.append(np.nan); exits.append(ex); qty.append(q)
    n = len(bars)
    return E.make_signals(bars, sides, np.zeros(n, np.int64), px, stops, tgts, exits, np.zeros(n, np.int64), qty)
