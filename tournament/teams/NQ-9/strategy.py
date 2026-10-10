import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import numpy as np
import engine as E

PARAMS = dict(risk=150.0, accept=3, gap_min=5.0, buf=3.0, max_stop=60.0, last_entry=660, min_width=20.0, rr_cap=0.0)
RISK_KEY = 'risk'
TUNABLE = ['accept', 'gap_min', 'buf', 'max_stop', 'last_entry', 'min_width']


def profile(d):
    """Per session day: VAL, VAH, POC of RTH (570..959 ET) session. Returns dict day->(val,vah,poc), RTH range."""
    day = d.day; m = d.minute_of_day_et
    sel = (m >= 570) & (m < 960)
    out = {}
    idxs = np.nonzero(sel)[0]
    if len(idxs) == 0:
        return out
    dd = day[idxs]
    bounds = np.nonzero(np.diff(dd))[0] + 1
    starts = np.r_[0, bounds]; ends = np.r_[bounds, len(idxs)]
    for s, e in zip(starts, ends):
        ii = idxs[s:e]
        if len(ii) < 200:
            continue
        lo = np.floor(d.l[ii].min()); hi = np.ceil(d.h[ii].max())
        nb = int(hi - lo) + 1
        vol = np.zeros(nb)
        for k in ii:
            a = int(np.floor(d.l[k] - lo)); b = int(np.floor(d.h[k] - lo))
            vol[a:b + 1] += d.v[k] / (b - a + 1)
        poc = int(vol.argmax()); tot = vol.sum(); acc = vol[poc]; lo_i = hi_i = poc
        while acc < 0.7 * tot:
            up = vol[hi_i + 1] if hi_i + 1 < nb else -1
            dn = vol[lo_i - 1] if lo_i - 1 >= 0 else -1
            if up < 0 and dn < 0:
                break
            if up >= dn:
                hi_i += 1; acc += up
            else:
                lo_i -= 1; acc += dn
        out[int(day[ii[0]])] = (lo + lo_i, lo + hi_i + 1, lo + poc + 0.5)
    return out


def generate(d, p):
    prof = profile(d)
    days = sorted(prof)
    nxt = {days[i]: days[i + 1] for i in range(len(days) - 1)}
    # prior-session value for each following day
    pv = {nxt[k]: prof[k] for k in nxt}
    day = d.day; m = d.minute_of_day_et
    n = d.n
    bar=[]; side=[]; px=[]; stop=[]; tgt=[]; exb=[]; qty=[]
    starts = np.r_[0, np.nonzero(np.diff(day))[0] + 1]
    ends = np.r_[starts[1:], n]
    for s, e in zip(starts, ends):
        dv = int(day[s])
        if dv not in pv:
            continue
        val, vah, poc = pv[dv]
        if vah - val < p['min_width']:
            continue
        seg = np.arange(s, e)
        rth = seg[(m[s:e] >= 570) & (m[s:e] < 960)]
        if len(rth) < 30:
            continue
        o = d.o[rth[0]]
        if o > vah + p['gap_min']:
            sd = -1
        elif o < val - p['gap_min']:
            sd = 1
        else:
            continue
        run = 0; ext = o; done = False
        for k in rth:
            mm = m[k]
            if sd == -1:
                ext = max(ext, d.h[k]); inside = d.c[k] <= vah
            else:
                ext = min(ext, d.l[k]); inside = d.c[k] >= val
            if mm > p['last_entry']:
                break
            if mm < 575:
                continue
            run = run + 1 if inside else 0
            if run >= p['accept']:
                # must be actually inside value (not beyond opposite edge)
                if val < d.c[k] < vah:
                    entry = d.c[k]
                    stp = ext + p['buf'] if sd == -1 else ext - p['buf']
                    dist = abs(stp - entry)
                    target = val if sd == -1 else vah
                    if dist <= p['max_stop'] and abs(target - entry) >= 4:
                        q = max(1, int(p['risk'] // (dist * d.mult)))
                        bar.append(k); side.append(sd); px.append(entry); stop.append(stp); tgt.append(target)
                        ei = rth[rth.searchsorted(k):]
                        x = ei[m[ei] >= 945]
                        exb.append(int(x[0]) if len(x) else int(rth[-1])); qty.append(q)
                break
    z = np.zeros(len(bar))
    return E.make_signals(bar, side, np.zeros(len(bar), np.int64), px, stop, tgt, exb, z, qty)
