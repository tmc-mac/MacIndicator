# Tournament v2 — brief for all teams (supersedes the profit-ratio scoring in TEAM_BRIEF.md; engine API there is unchanged)

## The new goal (set by the end user)
We want strategies that **actually hit +$3,000 before the trailing -$2,000 drawdown, repeatedly** — a funded-eval *pass*.
A strategy that earns a little but never reaches $53,000 has no value here and is OUT. Only strategies with a *proven*
pass-before-bust record enter the tournament; they then race each other.

**A "start" is a fresh $50K eval beginning at any session open.** It runs until PASS (closed-trade equity >= $53,000),
BUST (equity touches the trailing floor = highest end-of-day equity minus $2,000; daily loss limit $1,250 pauses the day),
or 60 sessions (TIMEOUT = fail). We measure over starts every 3 sessions: **pass rate, bust rate, median days-to-pass.**
Sizing is entirely yours (contracts per trade, up to 40 micros) and is THE main lever: the same edge that earns $1.4k a
quarter at 1x risk passes ~50-70% of starts at 2-3x risk. Edge without enough size never reaches $53k; size without edge busts.

## Certification bar (independent certifier runs it; you cannot see the proof year)
- PROOF year 2024-07-01..2025-06-30 (hidden): pass rate >= 50%, bust rate <= 25%, >= 100 trades & >= 0.5/day
- DESIGN window: pass >= 40%, bust <= 30% (sizing multiplier is chosen here, then frozen)
- each half of proof: pass >= 25%
- cost stress (2-tick slippage instead of 1): pass >= 40%, bust <= 30%
- parameter robustness: every TUNABLE parameter perturbed +/-20% keeps median proof pass >= 0.7x baseline, worst >= 25%
- lookahead clean (signal at bar i uses only data through bar i)
Strategies are certified or not — there is no partial credit. If your concept cannot get there with any sizing on the
design window, say so plainly and stop; do not torture the data. Honest "no edge" is a useful result.

## Data you may use
`E.load('NQ' or 'ES')` now returns DESIGN data only: 2021-09-27 .. 2024-06-30. Everything after that is hidden (proof year,
then the tournament hold-out 2025-07..2026-09). Do not try to load other phases (it is blocked and logged as a violation).
Tune ONLY on design. Prefer few parameters, plateau-shaped sensitivity, logic you can explain. No lookahead, no martingale,
one position at a time, every entry has a stop, commissions excluded, 1-tick slippage on market/stop fills.

## Required exports in strategy.py (new)
`PARAMS` (dict), `generate(d, params)` (unchanged), plus
- `RISK_KEY = 'risk'` — the PARAMS key that scales position size ~linearly (e.g. $ risked per trade). The certifier
  multiplies it by a grid (0.5x..8x) to pick sizing on design. Contracts must scale with it (don't hard-cap below 1x*8).
  Note the engine floors contracts at 1 and caps at 40 micros.
- `TUNABLE = [...]` — names of numeric PARAMS the certifier should perturb for the robustness test (all the real tunables;
  time-of-day constants count).
No `@njit(cache=True)` (breaks dynamic loading).

## Tools
`python3 tournament/engine/combine_team.py <TEAM> 1,2,3,4,6` — design-window pass/bust/timeout and median days-to-pass at each size multiplier.
`python3 tournament/engine/run_team.py <TEAM> train` — raw stats + rolling 3-month evals (legacy).
Self-check before reporting: run the certifier's own design sweep via combine_team and perturbation by hand.

## Deliverables / conduct
Your folder `tournament/teams/<TEAM>/`: prereg.md (written BEFORE first backtest for new teams; existing teams append a dated
'v2 amendments'), strategy.py, log.md (every meaningful step), final.md. Do not read other teams' folders. Distinct core
concept per team. Finish with a <200-word report: concept, params, design-window pass/bust/median-days at your chosen size, weaknesses.
