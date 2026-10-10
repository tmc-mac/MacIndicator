"""Statistical meaning of the certification bar.
A) real teams: effective independent sample size of overlapping starts, block-bootstrap CI of proof pass/bust rate.
B) Monte-Carlo false-certification rate of the PROOF bar (pass>=.5, bust<=.25) under: zero-edge (demeaned daily P&L), half edge, full edge,
   using the certify.py sizing rule (grid chosen on synthetic design).  Daily-path approximation (EOD equity), validated against combine()."""
import sys, os, json
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from diff_teams import *
GRID = (0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8)

def starts_outcomes(x, step=3, max_days=60):
    """x: daily P&L array (one per session). returns outcome codes per start: 1 pass, -1 bust, 0 timeout (daily-EOD approximation)."""
    n = len(x); idx = np.arange(0, n - max_days, step)           # same censoring as combine(): k+60 < n
    W = np.stack([x[i:i + max_days] for i in idx]); cum = np.cumsum(W, 1)
    peak = np.maximum.accumulate(np.maximum(cum, 0.0), 1)         # start equity 0 is the first peak
    bust = cum <= peak - 2000.0; pas = cum >= 3000.0
    big = max_days + 1
    fb = np.where(bust.any(1), bust.argmax(1), big); fp = np.where(pas.any(1), pas.argmax(1), big)
    out = np.zeros(len(idx), int); out[(fp < fb)] = 1; out[(fb <= fp) & (fb < big)] = -1
    return out

def rates(o): return (o == 1).mean(), (o == -1).mean()

def acf_neff(z, maxlag=40):
    z = np.asarray(z, float); n = len(z); z = z - z.mean(); v = (z * z).mean()
    if v == 0: return float(n), 0.0
    s = 0.0
    for k in range(1, min(maxlag, n - 1)):
        rho = (z[:-k] * z[k:]).mean() / v
        if rho < 0.0: break
        s += (1 - k / n) * rho
    return n / (1 + 2 * s), s

def block_boot_ci(z, block=20, B=4000, seed=1):
    rng = np.random.default_rng(seed); z = np.asarray(z, float); n = len(z); nb = int(np.ceil(n / block)); res = []
    for _ in range(B):
        st = rng.integers(0, n - block + 1, nb); res.append(np.concatenate([z[s:s + block] for s in st])[:n].mean())
    return np.percentile(res, [2.5, 97.5])

def session_series(d, sig, i0, i1):
    r = E.run(d, sig, i0, i1, enforce=False)
    days = np.unique(d.day[i0:i1]); pn = np.zeros(len(days))
    pos = np.searchsorted(days, r['daily_day']); pn[pos] += r['daily_pnl']
    return days, pn

def part_A():
    rows = []
    for team, mult in [('NQ-3', 4), ('NQ-5', 4), ('NQ-1', 8), ('NQ-8', 4), ('NQ-11', 4), ('NQ-7', 4), ('ES-8', 8), ('ES-1', 4), ('ES-2', 8), ('NQ-2', 8)]:
        inst = 'NQ' if team.startswith('NQ') else 'ES'; d = E.load(inst, phase='dev'); m = load_strategy(team)
        p = dict(m.PARAMS); p[m.RISK_KEY] *= mult; sig = m.generate(d, p)
        j0, j1 = d.idx(*E.WINDOWS['proof']); kc = E.combine(d, sig, j0, j1)
        res = np.array([r[1] for r in kc]); pas = (res == 'pass').astype(float); bus = (res == 'bust').astype(float)
        n = len(pas); neff_p, _ = acf_neff(pas); neff_b, _ = acf_neff(bus)
        ci = block_boot_ci(pas); cib = block_boot_ci(bus)
        # non-overlapping windows: every 20th start (=60 sessions)
        no = [float(pas[o::20].mean()) for o in range(0, 20, 5)]
        nsess = len(np.unique(d.day[j0:j1]))
        # daily approximation check
        days, pn = session_series(d, sig, j0, j1); ao = starts_outcomes(pn)
        rows.append(dict(team=team, mult=mult, n_starts=n, sessions=nsess, pass_rate=pas.mean(), bust_rate=bus.mean(), neff_pass=round(neff_p, 1), neff_bust=round(neff_b, 1),
                         pass_ci95=[round(float(ci[0]), 2), round(float(ci[1]), 2)], bust_ci95=[round(float(cib[0]), 2), round(float(cib[1]), 2)],
                         nonoverlap_pass_rate_by_offset=[round(x, 2) for x in no], nonoverlap_n=len(pas[0::20]),
                         daily_approx_pass_bust=[round(float(rates(ao)[0]), 2), round(float(rates(ao)[1]), 2)], real_pass_bust=[round(float(pas.mean()), 2), round(float(bus.mean()), 2)]))
        print(json.dumps(rows[-1]), flush=True)
    return rows

def stationary_boot(x, L, mean_block, rng):
    n = len(x); out = np.empty(L); i = int(rng.integers(n))
    p = 1.0 / mean_block; u = rng.random(L); r = rng.integers(0, n, L)
    for t in range(L):
        if t == 0 or u[t] < p: i = r[t]
        else: i = (i + 1) % n
        out[t] = x[i]
    return out

def part_B(nsim=1500, teams=('NQ-5', 'NQ-3', 'ES-8', 'NQ-1')):
    # build a few base daily-P&L processes from real strategies on the DESIGN window at 1x
    bases = {}
    for team in teams:
        inst = 'NQ' if team.startswith('NQ') else 'ES'; d = E.load(inst, phase='dev'); m = load_strategy(team)
        sig = m.generate(d, m.PARAMS); j0, j1 = d.idx(*E.WINDOWS['design']); days, pn = session_series(d, sig, j0, j1)
        bases[team] = pn
    Ld, Lp = 690, 259
    rng = np.random.default_rng(42); out = {}
    for team, pn in bases.items():
        sd = pn.std(); mu = pn.mean()
        for label, drift in (('zero-edge', 0.0), ('half-edge', 0.5), ('real-edge', 1.0)):
            x = pn - mu + drift * mu
            cert = 0; cert_noh = 0; passes = []; hit_pass = 0; hit_bust = 0; n_des_ok = 0
            for s in range(nsim):
                xd = stationary_boot(x, Ld, 10, rng); xp = stationary_boot(x, Lp, 10, rng)
                best = None
                for g in GRID:
                    o = starts_outcomes(xd * g); p_, b_ = rates(o)
                    if b_ <= 0.30:
                        obj = p_ - b_
                        if best is None or obj > best[0]: best = (obj, g, p_, b_)
                if best is None: continue
                if not (best[2] >= .4 and best[3] <= .3): continue
                n_des_ok += 1
                o = starts_outcomes(xp * best[1]); p_, b_ = rates(o)
                passes.append(p_)
                ok = p_ >= .5 and b_ <= .25
                cert += ok
                h = len(o) // 2; ph = (o[:h] == 1).mean(); ph2 = (o[h:] == 1).mean()
                cert_noh += ok and ph >= .25 and ph2 >= .25
            out[(team, label)] = dict(design_gate_ok=n_des_ok / nsim, P_proof_bar=cert / nsim, P_proof_bar_and_halves=cert_noh / nsim, mean_proof_pass=float(np.mean(passes)) if passes else None,
                                      true_daily_mean=float(drift * mu), daily_sd=float(sd))
            print(team, label, json.dumps(out[(team, label)]), flush=True)
    return out

if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'AB'
    if 'A' in which: json.dump(part_A(), open(os.path.join(HERE, 'stats_A.json'), 'w'), indent=1, default=float)
    if 'B' in which:
        tm = sys.argv[3].split(',') if len(sys.argv) > 3 else ('NQ-5', 'NQ-3', 'ES-8', 'NQ-1')
        json.dump({f'{k[0]}|{k[1]}': v for k, v in part_B(int(sys.argv[2]) if len(sys.argv) > 2 else 1000, tm).items()}, open(os.path.join(HERE, 'stats_B_' + '_'.join(tm) + '.json'), 'w'), indent=1)
