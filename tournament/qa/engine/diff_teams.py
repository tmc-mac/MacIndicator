"""Trade-by-trade diff of production kernel vs QA reference on real team signals.
usage: python diff_teams.py TEAM [mult]   -> prints + appends JSON line to diff_results.jsonl"""
import sys, os, json, time, importlib.util
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); ENG = os.path.join(HERE, '..', '..', 'engine')
sys.path.insert(0, ENG); sys.path.insert(0, HERE)
import numpy as np, engine as E, refsim as RS

def load_strategy(team):
    p = os.path.join(ENG, '..', 'teams', team, 'strategy.py')
    spec = importlib.util.spec_from_file_location('strategy_' + team.replace('-', '_'), p)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def tape_diff(kt, rt, tol=1e-6):
    """kt: kernel tape ndarray (n,9); rt: list of ref tuples. returns (n_kernel, n_ref, n_mismatch, first_mismatch)"""
    n = min(len(kt), len(rt)); bad = 0; first = None
    for i in range(n):
        k = kt[i]; r = rt[i]
        ok = (int(k[0]) == r[0] and int(k[1]) == r[1] and int(k[2]) == r[2] and abs(k[3] - r[3]) < tol and abs(k[4] - r[4]) < tol
              and abs(k[5] - r[5]) < 1e-4 and int(k[6]) == r[6] and int(k[7]) == r[7])
        if not ok:
            bad += 1
            if first is None: first = dict(i=i, kernel=[float(x) for x in k[:8]], ref=list(r))
    return len(kt), len(rt), bad + abs(len(kt) - len(rt)), first

def main(team, mult=1.0):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    d = E.load(inst, phase='dev'); m = load_strategy(team)
    p = dict(m.PARAMS); p[m.RISK_KEY] = p[m.RISK_KEY] * mult
    t0 = time.time(); sig = m.generate(d, p); tg = time.time() - t0
    R = RS.Ref(d); out = dict(team=team, mult=mult, nsig=int(len(sig['bar'])), gen_s=round(tg, 1))
    # (a) continuous design-window slice 2023-01-01..2023-12-31, account rules ON, no stop_on_pass
    i0, i1 = d.idx('2023-01-01', '2023-12-31')
    for enforce in (True, False):
        k = E.run(d, sig, i0, i1, enforce=enforce)
        r = RS.simulate(R, sig, i0, i1, enforce=enforce, mode='mimic')
        nk, nr, bad, first = tape_diff(k['tape'], r['trades'])
        out[f'slice_enf{int(enforce)}'] = dict(n_kernel=nk, n_ref=nr, mismatches=bad, first=first, kernel_final=k['final_equity'],
                                               ref_final=r['final_equity'], kbust=k['bust'], rbust=r['bust'], kpass=k['passed'], rpass=r['passed'])
        # strict mode alongside (not expected to equal)
        rs = RS.simulate(R, sig, i0, i1, enforce=enforce, mode='strict')
        out[f'slice_enf{int(enforce)}']['strict'] = dict(n=len(rs['trades']), final=rs['final_equity'], bust=rs['bust'])
    # (b) combine() starts on the proof year (dev data = design + proof) and on a design chunk
    for name, (a, b) in dict(proof=E.WINDOWS['proof'], design23=('2022-07-01', '2023-12-31')).items():
        j0, j1 = d.idx(a, b)
        kc = E.combine(d, sig, j0, j1)
        rc = RS.combine_ref(R, sig, j0, j1, mode='mimic')
        sc = RS.combine_ref(R, sig, j0, j1, mode='strict')
        diffs = [(i, k_[1], r_[1], round(k_[2], 2), round(r_[2], 2)) for i, (k_, r_) in enumerate(zip(kc, rc)) if k_[1] != r_[1] or abs(k_[2] - r_[2]) > 1e-3 or k_[0] != r_[0]]
        cnt = lambda rows, ix: {x: sum(1 for r in rows if r[ix] == x) for x in ('pass', 'bust', 'timeout')}
        out['combine_' + name] = dict(n_kernel=len(kc), n_ref=len(rc), n_start_mismatch=len(diffs), first=diffs[:3], kernel=cnt(kc, 1), ref=cnt(rc, 1),
                                      strict_n=len(sc), strict=cnt(sc, 1), ref_stats=None)
    out['elapsed_s'] = round(time.time() - t0, 1)
    print(json.dumps(out, default=float), flush=True)
    with open(os.path.join(HERE, 'diff_results.jsonl'), 'a') as f: f.write(json.dumps(out, default=float) + '\n')

if __name__ == '__main__':
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 1.0)
