"""Team research tool (design window only).  python combine_team.py <TEAM> [mult,mult,...]
Sweeps position-size multipliers on the design window and prints pass-before-bust stats per multiplier
(a start every 3 sessions, 60-session limit).  Requires strategy.py to export RISK_KEY (a PARAMS key that scales
size linearly, e.g. 'risk' = $ risked per trade) and TUNABLE (list of numeric PARAMS names)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, engine as E
from run_team import load_strategy

def main(team, mults):
    inst = 'NQ' if team.startswith('NQ') else 'ES'
    d = E.load(inst, phase='design'); m = load_strategy(team)
    rk = m.RISK_KEY; i0, i1 = d.idx(*E.WINDOWS['design'])
    print(f"{team} design window; RISK_KEY={rk}={m.PARAMS[rk]}; TUNABLE={getattr(m,'TUNABLE',None)}")
    for k in mults:
        p = dict(m.PARAMS); p[rk] = m.PARAMS[rk] * k
        sig = m.generate(d, p)
        st = E.combine_stats(E.combine(d, sig, i0, i1))
        raw = E.run(d, sig, i0, i1, enforce=False)
        print(f"x{k:<4} pass={st['pass_rate']:.2f} bust={st['bust_rate']:.2f} timeout={st['timeout_rate']:.2f} "
              f"med_days_to_pass={st['median_days_to_pass']:.0f} n_starts={st['n']} | raw PF={raw['pf']:.2f} trades={raw['trades']} ({raw['trades_per_day']:.2f}/d)", flush=True)

if __name__ == '__main__':
    main(sys.argv[1], [float(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '1,2,3,4,6').split(',')])
