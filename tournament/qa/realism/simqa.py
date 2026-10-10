"""QA copy of engine._sim with switchable realism options (engine files untouched).
opts defaults reproduce engine behaviour exactly (regression-tested in regress.py)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
os.environ['TOURNAMENT_COORDINATOR'] = '1'
import numpy as np
from numba import njit
import engine as E

# opts indices
O_ORDER, O_SLIPSTOP, O_THRU, O_NOSB, O_TRAIL, O_LOCK, O_COMM, O_STOPEXT, O_TGTSLIP, O_BUSTEXIT, O_DLLEXIT, O_TIMESLIP = range(12)
def default_opts(**kw):
    o = np.zeros(12); o[O_SLIPSTOP] = -1; o[O_THRU] = 1
    names = dict(order=O_ORDER, slip_stop=O_SLIPSTOP, thru=O_THRU, no_samebar=O_NOSB, trail=O_TRAIL, lock=O_LOCK,
                 comm=O_COMM, stop_ext=O_STOPEXT, tgt_slip=O_TGTSLIP, bust_exit=O_BUSTEXIT, dll_exit=O_DLLEXIT, time_slip=O_TIMESLIP)
    for k, v in kw.items(): o[names[k]] = v
    return o

@njit
def _simq(ts, o, h, l, c, day, mult, i0, i1,
         sbar, sside, skind, spx, sstop, starget, sexit, scancel, sqty, sn, enforce, slip, stop_on_pass,
         out_trades, out_dday, out_dpnl, opts):
    tick = 0.25
    sl = slip * 0.25
    slst = sl if opts[1] < 0 else opts[1] * 0.25
    thru = opts[2] * tick
    tslip = opts[8] * tick
    order_mode = int(opts[0])
    realized = 0.0
    floor = 50000.0 - 2000.0
    peak_eod = 50000.0
    peak_tr = 50000.0
    peak_intra = 50000.0
    max_dd = 0.0
    bust = 0
    bust_ts = 0
    passed_ts = 0
    ntr = 0
    nd = 0
    cur_day = -1
    day_start_eq = 50000.0
    paused_day = -1
    free_bar = i0
    cap = out_trades.shape[0]
    for k in range(sn):
        b = sbar[k] + 1
        if b < i0 or b < free_bar or b >= i1 or ntr >= cap:
            continue
        side = sside[k]
        q = sqty[k]
        if q < 1:
            continue
        stop = sstop[k]
        tgt = starget[k]
        entry = 0.0
        eb = -1
        if skind[k] == 0:
            entry = o[b] + side * sl
            eb = b
        else:
            lim = spx[k]
            last = scancel[k]
            if last > i1 - 1:
                last = i1 - 1
            j = b
            while j <= last:
                if side == 1 and l[j] <= lim - thru:
                    entry = lim if o[j] > lim else o[j]
                    eb = j
                    break
                if side == -1 and h[j] >= lim + thru:
                    entry = lim if o[j] < lim else o[j]
                    eb = j
                    break
                j += 1
            if eb < 0:
                continue
        if (side == 1 and stop >= entry) or (side == -1 and stop <= entry):
            continue
        if eb < free_bar:
            continue
        d = day[eb]
        if cur_day == -1:
            cur_day = d
            day_start_eq = 50000.0 + realized
        if d != cur_day:
            eq = 50000.0 + realized
            if eq > peak_eod:
                peak_eod = eq
            if eq > peak_tr:
                peak_tr = eq
            nd = nd
            if nd < out_dday.shape[0]:
                out_dday[nd] = cur_day
                out_dpnl[nd] = eq - day_start_eq
                nd += 1
            cur_day = d
            day_start_eq = eq
        if opts[4] == 0:
            floor = peak_eod - 2000.0
        else:
            floor = peak_tr - 2000.0
        if opts[5] > 0 and floor > 50000.0:
            floor = 50000.0
        if paused_day == cur_day:
            continue
        exit_px = 0.0
        exit_bar = -1
        reason = 0
        both = 0
        j = eb
        last_exit = sexit[k]
        if last_exit > i1 - 1 or last_exit < eb:
            last_exit = i1 - 1
        while True:
            if day[j] != cur_day:
                eq = 50000.0 + realized + side * (c[j - 1] - entry) * mult * q
                if eq > peak_eod:
                    peak_eod = eq
                if eq > peak_tr:
                    peak_tr = eq
                if nd < out_dday.shape[0]:
                    out_dday[nd] = cur_day
                    out_dpnl[nd] = eq - day_start_eq
                    nd += 1
                cur_day = day[j]
                day_start_eq = eq
            if side == 1:
                worst = l[j]
                best = h[j]
            else:
                worst = h[j]
                best = l[j]
            eq_best = 50000.0 + realized + side * (best - entry) * mult * q
            if opts[4] != 0 and eq_best > peak_tr:
                peak_tr = eq_best          # intraday trailing: unrealized peak counts (favourable extreme assumed first)
            if opts[4] == 0:
                floor = peak_eod - 2000.0
            else:
                floor = peak_tr - 2000.0
            if opts[5] > 0 and floor > 50000.0:
                floor = 50000.0
            stop_hit = (side == 1 and worst <= stop) or (side == -1 and worst >= stop)
            tgt_hit = False
            if not np.isnan(tgt):
                if (side == 1 and h[j] >= tgt + thru) or (side == -1 and l[j] <= tgt - thru):
                    tgt_hit = True
                if opts[3] > 0 and j == eb and skind[k] == 1:
                    if opts[3] == 1:
                        tgt_hit = False    # limit-filled bar: cannot know the high came after the fill
                    else:                  # 2 = allow only if OHLC path is consistent (buy: O-L-H-C needs close>=open)
                        if side == 1 and c[j] < o[j]:
                            tgt_hit = False
                        if side == -1 and c[j] > o[j]:
                            tgt_hit = False
            if stop_hit and tgt_hit:
                both = 1
                if order_mode == 1:
                    stop_hit = False
                elif order_mode == 2:
                    # OHLC heuristic: up-bar visits low first, down-bar visits high first
                    up = c[j] >= o[j]
                    if side == 1:
                        if not up:
                            stop_hit = False
                    else:
                        if up:
                            stop_hit = False
            if stop_hit:
                if opts[7] == 1:
                    exit_px = worst
                elif side == 1:
                    exit_px = (o[j] if (o[j] < stop and j > eb) else stop) - slst
                    if opts[7] == 2 and worst < exit_px:
                        exit_px = 0.5 * (exit_px + worst)
                else:
                    exit_px = (o[j] if (o[j] > stop and j > eb) else stop) + slst
                    if opts[7] == 2 and worst > exit_px:
                        exit_px = 0.5 * (exit_px + worst)
                exit_bar = j
                reason = 1
                break
            eq_w = 50000.0 + realized + side * (worst - entry) * mult * q
            if enforce and eq_w <= floor:
                bust = 1
                bust_ts = ts[j]
                exit_px = entry + side * (floor - 50000.0 - realized) / (mult * q)
                exit_bar = j
                reason = 3
                break
            if enforce and (eq_w - day_start_eq) <= -1250.0:
                exit_px = entry + side * (day_start_eq - 1250.0 - 50000.0 - realized) / (mult * q)
                exit_bar = j
                reason = 4
                paused_day = cur_day
                break
            if tgt_hit:
                exit_px = tgt - side * tslip
                exit_bar = j
                reason = 2
                break
            dd = peak_intra - eq_w
            if dd > max_dd:
                max_dd = dd
            if eq_best > peak_intra:
                peak_intra = eq_best
            if j >= last_exit or j >= i1 - 1:
                exit_px = c[j] - side * opts[11] * tick
                exit_bar = j
                reason = 5
                break
            j += 1
        comm = opts[6] * q
        pnl = side * (exit_px - entry) * mult * q - comm
        realized += pnl
        eq_now = 50000.0 + realized
        dd = peak_intra - eq_now
        if dd > max_dd:
            max_dd = dd
        if eq_now > peak_intra:
            peak_intra = eq_now
        if enforce and reason == 1:
            # stop-out may have crossed the floor / DLL (engine does not flag these)
            fl2 = (peak_tr if opts[4] != 0 else peak_eod) - 2000.0
            if opts[5] > 0 and fl2 > 50000.0:
                fl2 = 50000.0
            if opts[9] > 0 and eq_now <= fl2:
                bust = 1
                bust_ts = ts[exit_bar]
            if opts[10] > 0 and (eq_now - day_start_eq) <= -1250.0:
                paused_day = cur_day
        if passed_ts == 0 and eq_now >= 53000.0:
            passed_ts = ts[exit_bar]
        out_trades[ntr, 0] = eb
        out_trades[ntr, 1] = exit_bar
        out_trades[ntr, 2] = side
        out_trades[ntr, 3] = entry
        out_trades[ntr, 4] = exit_px
        out_trades[ntr, 5] = pnl
        out_trades[ntr, 6] = q
        out_trades[ntr, 7] = reason
        out_trades[ntr, 8] = eq_now
        out_trades[ntr, 9] = both
        out_trades[ntr, 10] = 1.0 if (exit_bar == eb) else 0.0
        out_trades[ntr, 11] = skind[k]
        ntr += 1
        free_bar = exit_bar + 1
        if bust == 1:
            break
        if stop_on_pass and passed_ts != 0:
            break
    if cur_day != -1 and nd < out_dday.shape[0]:
        out_dday[nd] = cur_day
        out_dpnl[nd] = 50000.0 + realized - day_start_eq
        nd += 1
    return ntr, nd, realized, max_dd, bust, bust_ts, passed_ts


def run(data, sig, i0, i1, enforce=True, slip=1.0, stop_on_pass=False, delay=0, **kw):
    opts = default_opts(**kw)
    s = {k: v.copy() for k, v in sig.items()}
    if delay: s['bar'] = s['bar'] + delay
    m = (s['bar'] + 1 >= i0) & (s['bar'] + 1 < i1)
    s = {k: v[m] for k, v in s.items()}
    sn = len(s['bar'])
    out_t = np.zeros((max(sn, 1), 12))
    out_dd = np.zeros(max(i1 - i0, 10) // 100 + 5000, np.int64); out_dp = np.zeros(len(out_dd))
    ntr, nd, realized, max_dd, bust, bust_ts, passed_ts = _simq(
        data.ts, data.o, data.h, data.l, data.c, data.day, data.mult, i0, i1,
        s['bar'], s['side'], s['kind'], s['px'], s['stop'], s['target'], s['exit_by'], s['cancel_by'],
        s['contracts'].astype(np.float64), sn, enforce, slip, stop_on_pass, out_t, out_dd, out_dp, opts)
    t = out_t[:ntr]; pnl = t[:, 5]
    gp = pnl[pnl > 0].sum(); gl = -pnl[pnl < 0].sum()
    return dict(net=float(pnl.sum()), trades=int(ntr), wins=int((pnl > 0).sum()), win_rate=float((pnl > 0).mean()) if ntr else 0.0,
                pf=float(gp / gl) if gl > 0 else (float('inf') if gp > 0 else 0.0), max_dd=float(max_dd), bust=bool(bust),
                passed=bool(passed_ts), passed_ts=int(passed_ts), tape=t, daily_pnl=out_dp[:nd].copy(), daily_day=out_dd[:nd].copy())


def combine(data, sig, i0, i1, step=3, max_days=60, slip=1.0, **kw):
    day = data.day[i0:i1]
    udays, first = np.unique(day, return_index=True); first = first + i0
    out = []
    for k in range(0, len(udays), step):
        if k + max_days >= len(udays): break
        a = int(first[k]); b = int(first[k + max_days])
        r = run(data, sig, a, b, enforce=True, slip=slip, stop_on_pass=True, **kw)
        res = 'bust' if r['bust'] else ('pass' if r['passed'] else 'timeout')
        dpass = (r['passed_ts'] - int(data.ts[a])) / 86400.0 if r['passed'] else np.nan
        out.append((int(data.ts[a]), res, r['net'], r['max_dd'], dpass, r['trades']))
    return out
