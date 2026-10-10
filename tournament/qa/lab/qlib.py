"""QA-LAB independent combine harness (own simulator + own start/censoring logic).  Does NOT import lab_runner / lab_eval.
Uses engine.py only for data loading and (optionally) for cross-checking."""
import os, sys, importlib.util
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__))
TOUR = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(TOUR, 'engine'))
import numpy as np
from numba import njit
import engine as E

START, TARGET, MAXDD, DLL, TICK = 50_000.0, 3_000.0, 2_000.0, 1_250.0, 0.25


def load_strategy(path):
    spec = importlib.util.spec_from_file_location('qa_strat_%d' % (abs(hash(path)) % 10**8), path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def sess_ids(ts):
    """Own session id: ET wall clock + 7h -> calendar day number (CME 17:00 ET roll), via zoneinfo (no pandas)."""
    from zoneinfo import ZoneInfo
    import datetime as dt
    z = ZoneInfo('America/New_York'); u = np.unique(ts // 3600)            # hourly cache of offsets
    off = {}
    for hh in u:
        t = dt.datetime.fromtimestamp(int(hh) * 3600, dt.timezone.utc).astimezone(z)
        off[hh] = int(t.utcoffset().total_seconds())
    offs = np.array([off[x] for x in (ts // 3600)], np.int64)
    return (ts + offs + 7 * 3600) // 86400


@njit
def qsim(ts, o, h, l, c, day, mult, i0, i1, sbar, sside, skind, spx, sstop, star, sexit, scan, sqty,
         slip, stop_on_pass, strict, gov, tape):
    """Own account simulator.  Returns (bust, bust_ts, passed, passed_ts, realized, ntr).
    strict=1: after every stop/time/target exit, equity<=floor counts as BUST (closes the stop-before-floor gap)."""
    sl = slip * TICK
    realized = 0.0; peak = START; floor = START - MAXDD
    cur = -1; dstart = START; paused = -1; free = i0
    bust = 0; bts = 0; passed = 0; pts = 0; ntr = 0
    for k in range(len(sbar)):
        b = sbar[k] + 1
        if b < i0 or b < free or b >= i1: continue
        q = sqty[k]
        if q < 1: continue
        sd = sside[k]; stop = sstop[k]; tg = star[k]
        eb = -1; ent = 0.0
        if skind[k] == 0:
            eb = b; ent = o[b] + sd * sl
        else:
            lim = spx[k]; last = min(scan[k], i1 - 1)
            for j in range(b, last + 1):
                if sd == 1 and l[j] <= lim - TICK:
                    eb = j; ent = lim if o[j] > lim else o[j]; break
                if sd == -1 and h[j] >= lim + TICK:
                    eb = j; ent = lim if o[j] < lim else o[j]; break
            if eb < 0: continue
        if (sd == 1 and stop >= ent) or (sd == -1 and stop <= ent): continue
        if eb < free: continue
        if cur == -1:
            cur = day[eb]; dstart = START + realized
        elif day[eb] != cur:
            eq = START + realized
            if eq > peak: peak = eq
            floor = peak - MAXDD; cur = day[eb]; dstart = eq
        if paused == cur: continue
        if gov[7] > 0.5:
            eqg = START + realized
            if gov[6] > 0 and eqg - dstart <= -gov[6]: continue
            sc = 1.0; cu = eqg - floor
            if cu < gov[0]: sc = gov[1]
            elif cu > gov[2]: sc = gov[3]
            if gov[4] > 0 and (START + TARGET - eqg) < gov[4]: sc = min(sc, gov[5])
            q = np.floor(q * sc + 0.5)
            q = min(max(q, 1.0), 40.0)
        val = mult * q
        lastx = sexit[k]
        if lastx > i1 - 1 or lastx < eb: lastx = i1 - 1
        j = eb; xp = 0.0; xb = -1; why = 0
        while True:
            if day[j] != cur:
                eq = START + realized + sd * (c[j - 1] - ent) * val
                if eq > peak: peak = eq
                floor = peak - MAXDD; cur = day[j]; dstart = eq
            worst = l[j] if sd == 1 else h[j]
            if (sd == 1 and worst <= stop) or (sd == -1 and worst >= stop):
                base = stop
                if j > eb and ((sd == 1 and o[j] < stop) or (sd == -1 and o[j] > stop)): base = o[j]
                xp = base - sd * sl; xb = j; why = 1; break
            ew = START + realized + sd * (worst - ent) * val
            if ew <= floor:
                bust = 1; bts = ts[j]; xp = ent + sd * (floor - START - realized) / val; xb = j; why = 3; break
            if ew - dstart <= -DLL:
                xp = ent + sd * (dstart - DLL - START - realized) / val; xb = j; why = 4; paused = cur; break
            if not np.isnan(tg):
                if (sd == 1 and h[j] >= tg + TICK) or (sd == -1 and l[j] <= tg - TICK):
                    xp = tg; xb = j; why = 2; break
            if j >= lastx or j >= i1 - 1:
                xp = c[j]; xb = j; why = 5; break
            j += 1
        pnl = sd * (xp - ent) * val
        realized += pnl
        if strict == 1 and why in (1, 2, 5) and START + realized <= floor:
            bust = 1; bts = ts[xb]
        if passed == 0 and START + realized >= START + TARGET: passed = 1; pts = ts[xb]
        tape[ntr, 0] = eb; tape[ntr, 1] = xb; tape[ntr, 2] = sd; tape[ntr, 3] = ent; tape[ntr, 4] = xp
        tape[ntr, 5] = pnl; tape[ntr, 6] = q; tape[ntr, 7] = why; tape[ntr, 8] = START + realized
        ntr += 1; free = xb + 1
        if bust == 1: break
        if stop_on_pass and passed == 1: break
    return bust, bts, passed, pts, realized, ntr


def govarr(g):
    a = np.zeros(8)
    if not g: return a
    a[0] = g.get('cush_lo', -1e9); a[1] = g.get('scale_lo', 1.0); a[2] = g.get('cush_hi', 1e9); a[3] = g.get('scale_hi', 1.0)
    a[4] = g.get('tgt_buf', 0.0); a[5] = g.get('scale_near', 1.0); a[6] = g.get('day_stop', 0.0); a[7] = 1.0
    return a


def sim(d, sig, i0, i1, slip=1.0, stop_on_pass=True, strict=0, gov=None, day=None):
    day = d.day if day is None else day
    tape = np.zeros((max(len(sig['bar']), 1), 9))
    r = qsim(d.ts, d.o, d.h, d.l, d.c, day, d.mult, i0, i1, sig['bar'], sig['side'], sig['kind'], sig['px'], sig['stop'],
             sig['target'], sig['exit_by'], sig['cancel_by'], sig['contracts'].astype(np.float64), slip, stop_on_pass, strict,
             govarr(gov), tape)
    return dict(bust=bool(r[0]), bust_ts=int(r[1]), passed=bool(r[2]), passed_ts=int(r[3]), net=r[4], ntr=int(r[5]), tape=tape[:int(r[5])])


def session_table(d, i0, i1, day=None):
    """first-bar index of every session inside [i0,i1) (a session partially before i0 starts at i0)."""
    day = d.day if day is None else day
    dd = day[i0:i1]
    chg = np.flatnonzero(np.diff(dd) != 0) + 1
    first = np.concatenate([[0], chg]) + i0
    return dd[first - i0], first


def run_start(d, sig, a, b, cap_sessions=None, **kw):
    r = sim(d, sig, a, b, **kw)
    return ('bust' if r['bust'] else ('pass' if r['passed'] else 'timeout')), r


def sessions_to(d, a, b, ts_event, day=None):
    day = d.day if day is None else day
    ud = np.unique(day[a:b]); ev = day[np.searchsorted(d.ts, ts_event)]
    return int(np.searchsorted(ud, ev)) + 1


def dense_starts(d, i0, i1, cap, step=3):
    ud, first = session_table(d, i0, i1)
    out = []
    for k in range(0, len(ud), step):
        if k + cap >= len(ud): break                   # censored: need session k+cap to exist (window = exactly cap sessions)
        out.append((k, int(first[k]), int(first[k + cap])))
    return out


def month_starts(d, i0, i1, cap):
    """first session of each calendar month (month of the SESSION date), censored if < cap sessions follow in [i0,i1)."""
    ud, first = session_table(d, i0, i1)
    mon = ((ud.astype('datetime64[D]')).astype('datetime64[M]')).astype(str)
    out = []; seen = set()
    for k in range(len(ud)):
        if mon[k] in seen: continue
        seen.add(mon[k])
        if k + cap >= len(ud): continue
        out.append((mon[k], int(first[k]), int(first[k + cap])))
    return out


def outcomes(d, sig, starts, strict=0, slip=1.0, gov=None):
    rows = []
    for lab, a, b in starts:
        res, r = run_start(d, sig, a, b, strict=strict, slip=slip, gov=gov)
        ev = sessions_to(d, a, b, r['passed_ts'] if res == 'pass' else r['bust_ts']) if res != 'timeout' else None
        rows.append(dict(lab=lab, a=a, res=res, ev=ev, net=r['net'], ntr=r['ntr'],
                         days=(r['passed_ts'] - d.ts[a]) / 86400 if res == 'pass' else np.nan))
    return rows


def rates(rows, cap=None):
    n = len(rows)
    if n == 0: return dict(n=0, P=np.nan, B=np.nan, T=np.nan)
    def cls(r):
        if cap is None: return r['res']
        if r['res'] != 'timeout' and r['ev'] <= cap: return r['res']
        return 'timeout'
    x = [cls(r) for r in rows]
    return dict(n=n, P=x.count('pass') / n, B=x.count('bust') / n, T=x.count('timeout') / n)
