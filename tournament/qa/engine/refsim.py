"""QA-Engine independent reference simulator (plain Python, bar-by-bar).  Written from the rules in engine.py's docstring,
NOT from the numba kernel.  Two modes:
  mode='mimic'  : reproduces the *conventions* the production engine documents/uses (stop checked before account breaches,
                  bust before DLL, unfilled limit orders do not block later signals, target allowed on limit-fill bar, no
                  slippage on time exits).  Used to prove the kernel has no implementation slip.
  mode='strict' : conservative / literal reading of the written rules (breach vs stop ordered by price level, post-exit
                  breach check, pending limit order blocks new signals until it is filled/cancelled, no target on the
                  limit-fill bar, 1 tick slippage on forced/time exits, DLL gap fills at the open).
Signals: dict of arrays exactly like engine.make_signals().
"""
import bisect
import numpy as np

TICK = 0.25
START, TARGET, MAXDD, DLL = 50_000.0, 3_000.0, 2_000.0, 1_250.0
REASON = {'stop': 1, 'target': 2, 'BUST': 3, 'DLL': 4, 'time': 5}


# ---------- session-day (CME 17:00 America/New_York roll) computed without pandas -------------
def _nth_sunday(year, month, n):
    import datetime as dt
    d = dt.date(year, month, 1)
    first_sun = d + dt.timedelta(days=(6 - d.weekday()) % 7)
    return first_sun + dt.timedelta(weeks=n - 1)


def et_offset_seconds(ts):
    """UTC->New York offset (sec) for epoch-second array, US rules: DST from 2nd Sun Mar 02:00 local to 1st Sun Nov 02:00 local."""
    import datetime as dt
    ts = np.asarray(ts, np.int64)
    off = np.full(ts.shape, -5 * 3600, np.int64)
    lo, hi = int(ts.min()), int(ts.max())
    y0 = dt.datetime.utcfromtimestamp(lo).year; y1 = dt.datetime.utcfromtimestamp(hi).year
    for y in range(y0, y1 + 1):
        s = _nth_sunday(y, 3, 2); e = _nth_sunday(y, 11, 1)
        s_utc = int(dt.datetime(s.year, s.month, s.day, 7, 0, tzinfo=dt.timezone.utc).timestamp())   # 02:00 EST = 07:00 UTC
        e_utc = int(dt.datetime(e.year, e.month, e.day, 6, 0, tzinfo=dt.timezone.utc).timestamp())   # 02:00 EDT = 06:00 UTC
        off[(ts >= s_utc) & (ts < e_utc)] = -4 * 3600
    return off


def session_day(ts):
    """Session id = calendar day number of (ET wall clock + 7h): 17:00 ET opens the next session."""
    ts = np.asarray(ts, np.int64)
    local = ts + et_offset_seconds(ts)
    return (local + 7 * 3600) // 86400


# ---------- data wrapper -----------------------------------------------------------------------
class Ref:
    def __init__(self, d, day=None):
        self.o = d.o.tolist(); self.h = d.h.tolist(); self.l = d.l.tolist(); self.c = d.c.tolist()
        self.ts = d.ts.tolist(); self.day = (day if day is not None else d.day).tolist(); self.mult = float(d.mult)


# ---------- the account simulation -------------------------------------------------------------
def simulate(R, sig, i0, i1, enforce=True, slip=1.0, stop_on_pass=False, mode='mimic'):
    F = set(['breach_order', 'post_check', 'pend_block', 'fillbar_tgt', 'time_slip', 'pause_orders']) if mode == 'strict' else \
        (set() if mode == 'mimic' else set(mode.split(',')))
    o, h, l, c, day, ts, mult = R.o, R.h, R.l, R.c, R.day, R.ts, R.mult
    sl = slip * TICK
    bars = sig['bar'].tolist() if hasattr(sig['bar'], 'tolist') else list(sig['bar'])
    side_a, kind_a, px_a = sig['side'].tolist(), sig['kind'].tolist(), sig['px'].tolist()
    stop_a, tgt_a, xb_a = sig['stop'].tolist(), sig['target'].tolist(), sig['exit_by'].tolist()
    can_a, q_a = sig['cancel_by'].tolist(), sig['contracts'].tolist()
    realized = 0.0; peak_eod = START; floor = START - MAXDD
    cur_day = day[i0]; day_start = START; paused = None
    free = i0; bust = False; bust_ts = 0; passed_ts = 0; trades = []

    def roll(new_day, eq):
        nonlocal peak_eod, floor, cur_day, day_start
        if eq > peak_eod: peak_eod = eq
        floor = peak_eod - MAXDD
        cur_day = new_day; day_start = eq

    kstart = bisect.bisect_left(bars, i0 - 1)
    for k in range(kstart, len(bars)):
        b = bars[k] + 1
        if b >= i1: break
        if b < i0 or b < free: continue
        side = side_a[k]; q = q_a[k]
        if q < 1: continue
        stop = stop_a[k]; tgt = tgt_a[k]
        if 'pause_orders' in F and paused is not None and day[b] == paused: continue          # no new orders on a paused session
        # ----- entry -----
        if kind_a[k] == 0:
            eb = b; entry = o[b] + side * sl
        else:
            lim = px_a[k]; last = min(can_a[k], i1 - 1); eb = -1; entry = 0.0
            for j in range(b, last + 1):
                if side == 1 and l[j] <= lim - TICK:
                    eb = j; entry = lim if o[j] > lim else o[j]; break
                if side == -1 and h[j] >= lim + TICK:
                    eb = j; entry = lim if o[j] < lim else o[j]; break
            if eb < 0:
                if 'pend_block' in F: free = max(free, last + 1)                            # order was live (blocking) until cancel_by
                continue
        if (side == 1 and stop >= entry) or (side == -1 and stop <= entry):
            if 'pend_block' in F and kind_a[k] == 1: free = max(free, eb + 1)
            continue
        if eb < free:
            continue
        if day[eb] != cur_day:                                              # flat session roll(s)
            roll(day[eb], START + realized)
        if paused == cur_day:
            continue
        val = mult * q
        last_exit = xb_a[k]
        if last_exit > i1 - 1 or last_exit < eb: last_exit = i1 - 1
        j = eb; xpx = None; xbar = -1; why = None
        while True:
            if day[j] != cur_day:
                roll(day[j], START + realized + side * (c[j - 1] - entry) * val)
            worst = l[j] if side == 1 else h[j]
            # price levels (absolute) of account breaches
            p_bust = entry + side * (floor - START - realized) / val
            p_dll = entry + side * (day_start - DLL - START - realized) / val
            def touched(p): return side * (worst - p) <= 0 if True else False
            stop_hit = (side == 1 and worst <= stop) or (side == -1 and worst >= stop)
            gap = (j > eb)
            if 'breach_order' not in F:
                # ---- mimic: stop first, then bust, then DLL, then target, then time ----
                if stop_hit:
                    base = (o[j] if ((o[j] < stop if side == 1 else o[j] > stop) and gap) else stop)
                    xpx = base - side * sl; xbar = j; why = 'stop'; break
                eq_w = START + realized + side * (worst - entry) * val
                if enforce and eq_w <= floor:
                    bust = True; bust_ts = ts[j]; xpx = p_bust; xbar = j; why = 'BUST'; break
                if enforce and eq_w - day_start <= -DLL:
                    xpx = p_dll; xbar = j; why = 'DLL'; paused = cur_day; break
            else:
                cands = []
                if stop_hit: cands.append((side * stop, 'stop'))
                if enforce:
                    if side * (worst - p_bust) <= 0: cands.append((side * p_bust, 'BUST'))
                    if side * (worst - p_dll) <= 0: cands.append((side * p_dll, 'DLL'))
                if cands:
                    # level touched first by the adverse price path = the one nearest entry (largest side*price)
                    cands.sort(key=lambda x: (-x[0], 0 if x[1] == 'BUST' else (1 if x[1] == 'DLL' else 2)))
                    why = cands[0][1]; xbar = j
                    if why == 'stop':
                        base = (o[j] if ((o[j] < stop if side == 1 else o[j] > stop) and gap) else stop)
                        xpx = base - side * sl
                    elif why == 'BUST':
                        bust = True; bust_ts = ts[j]
                        xpx = p_bust
                        if gap and side * (o[j] - p_bust) < 0: xpx = o[j]
                    else:
                        xpx = p_dll
                        if gap and side * (o[j] - p_dll) < 0: xpx = o[j]
                        paused = cur_day
                    break
            if not np.isnan(tgt):
                tgt_ok = not ('fillbar_tgt' in F and j == eb and kind_a[k] == 1)
                if tgt_ok and ((side == 1 and h[j] >= tgt + TICK) or (side == -1 and l[j] <= tgt - TICK)):
                    xpx = tgt; xbar = j; why = 'target'; break
            if j >= last_exit or j >= i1 - 1:
                xpx = c[j] - (side * sl if 'time_slip' in F else 0.0); xbar = j; why = 'time'; break
            j += 1
        pnl = side * (xpx - entry) * val
        realized += pnl
        eq_now = START + realized
        if 'post_check' in F and enforce and why in ('stop', 'time', 'target'):
            if eq_now <= floor: bust = True; bust_ts = ts[xbar]
            elif eq_now - day_start <= -DLL: paused = cur_day
        if passed_ts == 0 and eq_now >= START + TARGET: passed_ts = ts[xbar]
        trades.append((eb, xbar, side, entry, xpx, pnl, q, REASON[why]))
        free = xbar + 1
        if bust: break
        if stop_on_pass and passed_ts: break
    return dict(trades=trades, bust=bust, bust_ts=bust_ts, passed=bool(passed_ts), passed_ts=passed_ts,
                net=realized, final_equity=START + realized)


# ---------- combine harness (own implementation) -------------------------------------------------
def combine_ref(R, sig, i0, i1, step=3, max_days=60, slip=1.0, mode='mimic', include_exact=False):
    day = np.asarray(R.day[i0:i1])
    chg = np.flatnonzero(np.diff(day) != 0) + 1
    starts = np.concatenate([[0], chg]) + i0                 # first bar of every session in the window
    ns = len(starts); out = []
    for k in range(0, ns, step):
        end_idx = k + max_days
        if end_idx > ns or (end_idx == ns and not include_exact): break
        a = int(starts[k]); b = int(starts[end_idx]) if end_idx < ns else i1
        r = simulate(R, sig, a, b, True, slip, True, mode)
        res = 'bust' if r['bust'] else ('pass' if r['passed'] else 'timeout')
        out.append((R.ts[a], res, r['net'], len(r['trades']), r))
    return out
