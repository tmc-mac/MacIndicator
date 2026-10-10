# NQ-5 Combine Lab — improvement brief (user directive 2026-10-10)
Goal: raise the eval PASS RATE of the NQ-5 strategy (ICT sweep + displacement + FVG limit entry, MNQ) as far as honestly possible.
A "combine" = fresh $50K eval ($3,000 target, trailing -$2,000 drawdown off the end-of-day peak, -$1,250 daily loss limit) started at
a session open and run until PASS / BUST / timeout. Baseline (frozen v2, risk x3 = $525/trade), design window 2021-09..2024-06:
dense starts P60 77% | B120 17% | P120 83% | median 44 days; month-start starts P60 81%. On the hidden proof year it was P60 57% / B 27%
(first-half starts 100%, second-half 15%), so the edge is real but regime-sensitive and partly overfit.
YOUR success metric (design window, `lab_eval.py`): maximize dense P60 AND P120 while B120 <= 10%. Prefer fewer, principled changes.
## Rules
- Work ONLY in your own folder `tournament/lab/<YOUR-NAME>/` (copy `tournament/lab/base/strategy.py` there). Never edit other labs, `teams/`, `engine/`.
- Evaluate with `python3 tournament/engine/lab_eval.py tournament/lab/<NAME>/strategy.py --agent <NAME> --mult 3`. Design window only.
  `--proof` shows the hidden proof year's aggregate; you get EXACTLY 3 proof looks total — spend them on finished candidates, not on tuning.
  Never try to load phases 'dev'/'full' yourself. The hold-out 2025-07..2026-09 is reserved for the coordinator's final check.
- strategy.py contract: PARAMS, RISK_KEY, TUNABLE, generate(d, params) (causal; E.lookahead_check must pass), optional GOV dict for the
  risk governor (engine.py `_gov_array`: cush_lo/scale_lo, cush_hi/scale_hi, tgt_buf/scale_near, day_stop). No @njit(cache=True).
- Honest process: log every experiment (what, design numbers) in your log.md; prefer plateau-shaped results; check consistency per design year
  (2021-09..2022, 2023, 2024H1) — reject changes that help one year and hurt others; no martingale/averaging down; one position at a time.
- Final report (<250 words): what changed, design metrics before/after (dense + monthly), per-year consistency, proof-look result if any, risks.
