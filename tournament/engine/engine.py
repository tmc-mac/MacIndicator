"""Tournament engine: data loading, trade simulation, $50K eval account rules, scoring.

Account rules (spec §3/§5):
  start 50,000 | target +3,000 | max DD 2,000 trailing the END-OF-DAY equity peak (intraday touch of the
  floor = bust) | daily loss limit -1,250 (flatten, pause until next session, account survives) |
  one position at a time | every entry has a stop | max 40 micros | commissions excluded (gross P&L).

Fill model (conservative, identical for every team):
  market entry  -> next bar open, 1 tick adverse slippage
  limit entry   -> must trade THROUGH the price by 1 tick (low <= px-tick for buys), then filled at px
  stop          -> fills at stop price with 1 tick adverse slippage (gap-through fills at the open)
  target (limit)-> must trade through by 1 tick, filled at target
  if stop and target are both hit inside one bar the STOP is assumed first.
  time exit (exit_by) -> that bar's close.

Signals are arrays (one row per intended trade, sorted by decision bar). A signal decided on bar i
becomes live on bar i+1. Signals that arrive while a position/pending order exists are ignored.
"""
import os
import numpy as np
from numba import njit

TICK = 0.25
START_EQ = 50_000.0
TARGET = 3_000.0
MAX_DD = 2_000.0
DLL = 1_250.0
MAX_CONTRACTS = 40
FILLMODE = 1      # default intra-bar model for limit-fill bars (see _sim); set 0 for the legacy optimistic ordering
DD_FLOOR_FOR_SCORE = 500.0
MULT = {'NQ': 2.0, 'ES': 5.0}          # MNQ $2/pt, MES $5/pt

# window boundaries (UTC dates).  Validation gate window and hold-out rounds.  See DECISIONS in README.
WINDOWS = {
    'train':    ('2021-09-27', '2023-12-31'),
    'validate': ('2024-01-01', '2025-06-30'),
    'R1':       ('2025-07-01', '2025-09-30'),
    'QF':       ('2025-10-01', '2025-12-31'),
    'SF':       ('2026-01-01', '2026-03-31'),
    'F':        ('2026-04-01', '2026-09-24'),   # final: ~6 months (data ends 2026-09-25 NQ)
    # --- v2 (pass-before-bust) protocol ---
    'design':   ('2021-09-27', '2024-06-30'),   # teams build/tune here (what research loaders show)
    'proof':    ('2024-07-01', '2025-06-30'),   # certification out-of-sample year (hidden from teams)
    'holdout':  ('2025-07-01', '2026-09-24'),   # tournament data (hidden from everyone)
}


class Data:
    """Bars + session-day ids.  Fields: ts (epoch s), o,h,l,c,v, day (CME session id), mult, name."""
    def __init__(self, name, path):
        z = np.load(path)
        self.name = name
        self.ts = z['ts']; self.o = z['o']; self.h = z['h']; self.l = z['l']; self.c = z['c']; self.v = z['v']
        self.mult = MULT[name]
        import pandas as pd
        t = pd.to_datetime(self.ts, unit='s', utc=True).tz_convert('America/New_York')
        # CME session rolls at 17:00 New York time: shift +7h so the calendar date is the session id
        sess = (t + pd.Timedelta(hours=7))
        self.day = (sess.normalize().tz_localize(None).values.astype('datetime64[D]').astype(np.int64))
        self.minute_of_day_et = (t.hour.values * 60 + t.minute.values).astype(np.int64)   # ET clock minute
        self.dow = t.dayofweek.values.astype(np.int64)
        self.n = len(self.ts)

    def idx(self, start, end):
        """Bar index range [i0,i1) for UTC dates start..end inclusive."""
        s = np.datetime64(start, 's').astype(np.int64); e = (np.datetime64(end, 's') + np.timedelta64(1, 'D')).astype(np.int64)
        return int(np.searchsorted(self.ts, s)), int(np.searchsorted(self.ts, e))


def empty_signals():
    return dict(bar=np.zeros(0, np.int64), side=np.zeros(0, np.int64), kind=np.zeros(0, np.int64),
                px=np.zeros(0), stop=np.zeros(0), target=np.zeros(0), exit_by=np.zeros(0, np.int64),
                cancel_by=np.zeros(0, np.int64), contracts=np.zeros(0, np.int64))


def make_signals(bar, side, kind, px, stop, target, exit_by, cancel_by, contracts):
    """kind: 0=market at next open, 1=limit at px.  target NaN = none.  exit_by/cancel_by: absolute bar idx."""
    s = dict(bar=np.asarray(bar, np.int64), side=np.asarray(side, np.int64), kind=np.asarray(kind, np.int64),
             px=np.asarray(px, np.float64), stop=np.asarray(stop, np.float64), target=np.asarray(target, np.float64),
             exit_by=np.asarray(exit_by, np.int64), cancel_by=np.asarray(cancel_by, np.int64),
             contracts=np.asarray(np.minimum(contracts, MAX_CONTRACTS), np.int64))
    o = np.argsort(s['bar'], kind='stable')
    return {k: v[o] for k, v in s.items()}


@njit
def _sim(ts, o, h, l, c, day, mult, i0, i1,
         sbar, sside, skind, spx, sstop, starget, sexit, scancel, sqty, sn, enforce, slip, stop_on_pass, gov, fillmode,
         out_trades, out_dday, out_dpnl):
    tick = 0.25
    sl = slip * 0.25
    realized = 0.0
    floor = START_EQ - MAX_DD
    peak_eod = START_EQ
    peak_intra = START_EQ
    max_dd = 0.0
    bust = 0
    bust_ts = 0
    passed_ts = 0
    ntr = 0
    nd = 0
    cur_day = -1
    day_start_eq = START_EQ
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
        # ---- find fill bar ----
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
                if side == 1 and l[j] <= lim - tick:
                    entry = lim if o[j] > lim else o[j]
                    eb = j
                    break
                if side == -1 and h[j] >= lim + tick:
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
        # ---- session bookkeeping up to the fill bar (flat) ----
        d = day[eb]
        if cur_day == -1:
            cur_day = d
            day_start_eq = START_EQ + realized
        if d != cur_day:
            eq = START_EQ + realized
            if eq > peak_eod:
                peak_eod = eq
            floor = peak_eod - MAX_DD
            if nd < out_dday.shape[0]:
                out_dday[nd] = cur_day
                out_dpnl[nd] = eq - day_start_eq
                nd += 1
            cur_day = d
            day_start_eq = eq
        if paused_day == cur_day:
            continue
        # ---- risk governor (optional, equity-aware sizing) ----
        if gov[7] > 0.5:
            eq_g = START_EQ + realized
            if gov[6] > 0 and (eq_g - day_start_eq) <= -gov[6]:
                continue
            sc = 1.0
            cushion = eq_g - floor
            if cushion < gov[0]:
                sc = gov[1]
            elif cushion > gov[2]:
                sc = gov[3]
            if gov[4] > 0 and (START_EQ + TARGET - eq_g) < gov[4]:
                sc = min(sc, gov[5])
            q = int(q * sc + 0.5)
            if q < 1:
                q = 1
            if q > 40:
                q = 40
        # ---- manage the position ----
        exit_px = 0.0
        exit_bar = -1
        reason = 0
        j = eb
        last_exit = sexit[k]
        if last_exit > i1 - 1 or last_exit < eb:
            last_exit = i1 - 1
        while True:
            if day[j] != cur_day:
                eq = START_EQ + realized + side * (c[j - 1] - entry) * mult * q
                if eq > peak_eod:
                    peak_eod = eq
                floor = peak_eod - MAX_DD
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
            if (side == 1 and worst <= stop) or (side == -1 and worst >= stop):
                if side == 1:
                    exit_px = (o[j] if (o[j] < stop and j > eb) else stop) - sl
                else:
                    exit_px = (o[j] if (o[j] > stop and j > eb) else stop) + sl
                exit_bar = j
                reason = 1
                break
            eq_w = START_EQ + realized + side * (worst - entry) * mult * q
            if enforce and eq_w <= floor:
                bust = 1
                bust_ts = ts[j]
                exit_px = entry + side * (floor - START_EQ - realized) / (mult * q)
                exit_bar = j
                reason = 3
                break
            if enforce and (eq_w - day_start_eq) <= -DLL:
                exit_px = entry + side * (day_start_eq - DLL - START_EQ - realized) / (mult * q)
                exit_bar = j
                reason = 4
                paused_day = cur_day
                break
            tgt_ok = True
            if skind[k] == 1 and j == eb:
                # limit filled on THIS bar: was the target reachable AFTER the fill?  Bar path is unknown at 1-min resolution.
                #  fillmode 0: always yes (legacy, optimistic) | 1: O-L-H-C path if bar closed up (buys), O-H-L-C if closed down (sells)
                #  fillmode 2: never (strict: a limit-fill bar cannot also exit at target)
                if fillmode == 2:
                    tgt_ok = False
                elif fillmode == 1:
                    tgt_ok = (c[j] >= o[j]) if side == 1 else (c[j] <= o[j])
            if tgt_ok and not np.isnan(tgt):
                if (side == 1 and h[j] >= tgt + tick) or (side == -1 and l[j] <= tgt - tick):
                    exit_px = tgt
                    exit_bar = j
                    reason = 2
                    break
            dd = peak_intra - eq_w
            if dd > max_dd:
                max_dd = dd
            eq_b = START_EQ + realized + side * (best - entry) * mult * q
            if eq_b > peak_intra:
                peak_intra = eq_b
            if j >= last_exit or j >= i1 - 1:
                exit_px = c[j]
                exit_bar = j
                reason = 5
                break
            j += 1
        pnl = side * (exit_px - entry) * mult * q
        realized += pnl
        eq_now = START_EQ + realized
        dd = peak_intra - eq_now
        if dd > max_dd:
            max_dd = dd
        if eq_now > peak_intra:
            peak_intra = eq_now
        if passed_ts == 0 and eq_now >= START_EQ + TARGET:
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
        ntr += 1
        free_bar = exit_bar + 1
        if bust == 1:
            break
        if stop_on_pass and passed_ts != 0:
            break
    if cur_day != -1 and nd < out_dday.shape[0]:
        out_dday[nd] = cur_day
        out_dpnl[nd] = START_EQ + realized - day_start_eq
        nd += 1
    return ntr, nd, realized, max_dd, bust, bust_ts, passed_ts


REASONS = {1: 'stop', 2: 'target', 3: 'BUST', 4: 'DLL', 5: 'time'}


def run(data, sig, i0, i1, enforce=True, slip=1.0, stop_on_pass=False, gov=None, fillmode=None):
    fm = FILLMODE if fillmode is None else fillmode
    g = np.zeros(8) if gov is None else _gov_array(gov)
    """Run the $50K eval on bars [i0,i1).  Returns metrics dict + trade tape (numpy)."""
    m = (sig['bar'] + 1 >= i0) & (sig['bar'] + 1 < i1)
    s = {k: v[m] for k, v in sig.items()}
    sn = len(s['bar'])
    out_t = np.zeros((max(sn, 1), 9))
    out_dd = np.zeros(max(i1 - i0, 10) // 100 + 5000, np.int64)
    out_dp = np.zeros(len(out_dd))
    ntr, nd, realized, max_dd, bust, bust_ts, passed_ts = _sim(
        data.ts, data.o, data.h, data.l, data.c, data.day, data.mult, i0, i1,
        s['bar'], s['side'], s['kind'], s['px'], s['stop'], s['target'], s['exit_by'], s['cancel_by'],
        s['contracts'].astype(np.float64), sn, enforce, slip, stop_on_pass, g, fm, out_t, out_dd, out_dp)
    t = out_t[:ntr]
    pnl = t[:, 5]
    gp = pnl[pnl > 0].sum(); gl = -pnl[pnl < 0].sum()
    net = float(pnl.sum())
    days = max(int(len(np.unique(data.day[i0:i1]))), 1)
    r = dict(net=net, trades=int(ntr), wins=int((pnl > 0).sum()), win_rate=float((pnl > 0).mean()) if ntr else 0.0,
             pf=float(gp / gl) if gl > 0 else (float('inf') if gp > 0 else 0.0),
             max_dd=float(max_dd), bust=bool(bust), bust_ts=int(bust_ts), passed=bool(passed_ts),
             passed_ts=int(passed_ts), final_equity=START_EQ + net, days=days,
             trades_per_day=ntr / days, avg_contracts=float(t[:, 6].mean()) if ntr else 0.0,
             daily_pnl=out_dp[:nd].copy(), daily_day=out_dd[:nd].copy(), tape=t)
    r['score'] = score(r)
    return r


def score(r):
    """Spec §5: net/max(maxDD,500); bust => 0; must be net-positive and >= 20 trades."""
    if r['bust'] or r['net'] <= 0 or r['trades'] < 20:
        return 0.0
    return r['net'] / max(r['max_dd'], DD_FLOOR_FOR_SCORE)


def brief(r):
    return (f"net={r['net']:.0f} PF={r['pf']:.2f} WR={r['win_rate']*100:.0f}% n={r['trades']} "
            f"({r['trades_per_day']:.2f}/d) maxDD={r['max_dd']:.0f} bust={r['bust']} pass={r['passed']} score={r['score']:.2f}")


def lookahead_check(data, generate, params, n_checks=3, span=60_000):
    """Integrity: signals for bars < k must be identical when the series is truncated at k + 1500 bars.
    Returns True if no lookahead was detected."""
    full = generate(data, params)
    ok = True
    rng = np.random.default_rng(7)
    for _ in range(n_checks):
        k = int(rng.integers(span, data.n - 5000))
        sub = _truncate(data, k + 1500)
        part = generate(sub, params)
        a = full['bar'] < k
        b = part['bar'] < k
        for key in ('bar', 'side', 'px', 'stop', 'contracts'):
            x = full[key][a]; y = part[key][b]
            if len(x) != len(y) or not np.allclose(np.nan_to_num(x), np.nan_to_num(y)):
                ok = False
    return ok


def _truncate(d, n):
    import copy
    e = copy.copy(d)
    for f in ('ts', 'o', 'h', 'l', 'c', 'v', 'day', 'minute_of_day_et', 'dow'):
        setattr(e, f, getattr(d, f)[:n])
    e.n = n
    return e


def rolling_evals(data, sig, i0, i1, months=3, step_days=14):
    """Fresh $50K eval on every rolling `months`-month window inside [i0,i1).  Robustness view used in research."""
    import pandas as pd
    t0 = pd.Timestamp(int(data.ts[i0]), unit='s'); t1 = pd.Timestamp(int(data.ts[i1 - 1]), unit='s')
    out = []
    s = t0
    while s + pd.DateOffset(months=months) <= t1:
        e = s + pd.DateOffset(months=months)
        a = int(np.searchsorted(data.ts, int(s.timestamp()))); b = int(np.searchsorted(data.ts, int(e.timestamp())))
        out.append(run(data, sig, a, b)); s = s + pd.Timedelta(days=step_days)
    return out


def summarize_rolling(rs):
    sc = np.array([r['score'] for r in rs]); net = np.array([r['net'] for r in rs])
    return dict(windows=len(rs), pass_rate=float(np.mean([r['passed'] for r in rs])),
                bust_rate=float(np.mean([r['bust'] for r in rs])), pos_rate=float(np.mean(net > 0)),
                mean_score=float(sc.mean()), median_score=float(np.median(sc)), median_net=float(np.median(net)))


def load(name, research=True, phase=None):
    """Load NQ/ES.  phase: 'design' (<=2024-06-30, what teams see), 'dev' (<=2025-06-30, certifier only),
    'full' (everything, tournament only).  research=True is the legacy flag == 'design'."""
    d = Data(name, f'/tmp/claude-0/cache/{name.lower()}_1m.npz')
    ph = phase or ('design' if research else 'full')
    if ph != 'design' and os.environ.get('TOURNAMENT_COORDINATOR') != '1':
        raise PermissionError("phase '%s' (proof/hold-out data) is reserved for the coordinator/certifier; teams use phase='design'" % ph)
    if ph == 'design':
        _, n = d.idx(*WINDOWS['design']); d = _truncate(d, n)
    elif ph == 'dev':
        _, n = d.idx(*WINDOWS['proof']); d = _truncate(d, n)
    return d


# ---------------------------------------------------------------------------------------------
# Combine (pass-before-bust) harness.  A "start" = fresh $50K eval beginning on the first bar of a
# session; it runs until +$3,000 (PASS, closed-trade equity >= 53,000), bust (equity touches the
# trailing floor), or `max_days` sessions elapse (TIMEOUT).  Starts without a full max_days of data
# before i1 are CENSORED (excluded) so the stats are never biased by truncation.
# ---------------------------------------------------------------------------------------------
def combine(data, sig, i0, i1, step=3, max_days=60, slip=1.0, gov=None, fillmode=None):
    day = data.day[i0:i1]
    udays, first = np.unique(day, return_index=True)
    first = first + i0
    out = []
    for k in range(0, len(udays), step):
        if k + max_days >= len(udays):
            break                                   # censored
        a = int(first[k]); b = int(first[k + max_days])
        r = run(data, sig, a, b, enforce=True, slip=slip, stop_on_pass=True, gov=gov, fillmode=fillmode)
        if r['bust']:
            res = 'bust'
        elif r['passed']:
            res = 'pass'
        else:
            res = 'timeout'
        dpass = (r['passed_ts'] - int(data.ts[a])) / 86400.0 if r['passed'] else np.nan
        out.append((int(data.ts[a]), res, r['net'], r['max_dd'], dpass, r['trades']))
    return out


def combine_stats(rows):
    n = len(rows)
    if n == 0:
        return dict(n=0, pass_rate=0.0, bust_rate=0.0, timeout_rate=0.0, median_days_to_pass=float('nan'), pass_bust_ratio=0.0)
    res = np.array([r[1] for r in rows]); dp = np.array([r[4] for r in rows], float)
    p = float((res == 'pass').mean()); b = float((res == 'bust').mean())
    return dict(n=n, pass_rate=p, bust_rate=b, timeout_rate=float((res == 'timeout').mean()),
                median_days_to_pass=float(np.nanmedian(dp)) if np.isfinite(dp).any() else float('nan'),
                pass_bust_ratio=float(p / b) if b > 0 else (float('inf') if p > 0 else 0.0),
                mean_net=float(np.mean([r[2] for r in rows])))


def _gov_array(g):
    """Risk governor (equity-aware sizing).  dict keys (all optional):
       cush_lo, scale_lo : if (equity - trailing floor) < cush_lo  -> multiply contracts by scale_lo
       cush_hi, scale_hi : if cushion > cush_hi                    -> multiply by scale_hi
       tgt_buf, scale_near: if remaining profit to target < tgt_buf -> multiply by min(.., scale_near)
       day_stop          : stop opening trades for the session once day P&L <= -day_stop
    Contracts are re-rounded (min 1, max 40)."""
    a = np.zeros(8)
    a[0] = g.get('cush_lo', -1e9); a[1] = g.get('scale_lo', 1.0)
    a[2] = g.get('cush_hi', 1e9);  a[3] = g.get('scale_hi', 1.0)
    a[4] = g.get('tgt_buf', 0.0);  a[5] = g.get('scale_near', 1.0)
    a[6] = g.get('day_stop', 0.0); a[7] = 1.0
    return a
