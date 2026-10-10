# NQ-6 log (train 2021-09-27..2023-12-31, raw = rules off)
- Prereg written, then first run with prereg params (risk 150, tm 1.5): PF1.30 n526 (0.90/d) net12487 maxDD3075; rolling pass.43 bust.19 pos.58 -> too much risk.
- Regime ablation (risk 150): all-fade thr=0 PF1.16 net7800; all-breakout thr=9 PF1.05 net2071; mixed thr=1.0 PF1.30 -> the switch adds value.
- thr 0.8/1.2 worse (PF1.18/1.11): THR sensitivity is peaked at ~1.0 (0.9 looked better, not adopted).
- risk sweep: 150/100/75/50 -> maxDD 3075/2100/1736/1551, bust .19/.02/0/0 (PF flat ~1.29): risk is pure scaling.
- tm 1.0/1.5/2.0/2.5: PF 1.26/1.30/1.33/(1.38 at risk60). fw 10/15/25 flat (PF1.29-1.30). lookback 10/20/40: 1.20/1.30/1.25.
- Frozen: risk 60, tm 2.0 (others per prereg). Result: PF1.34 n526 net8790 maxDD1729; rolling pass .08 bust 0 pos .77 median score 1.32.
- Quarterly net: +979, +1650, +991, +2507, +1313, -532, +1286, +284, +314 (8/9 positive).

## Rework (after v1 failed validation: PF0.98, 365 trades, DD2712)
- v2: rolling ATR(15)/ATR(240) regime. Stretch-fade in expansion (z>2.5 from mean60) had no edge on train (PF 0.96-1.06 any thresholds); expansion-trend breakout also weak/high DD. Only compression (ratio<LO) box-breakout showed edge.
- Sensitivity (hi=99, tm 2, box60): lo .6/.65/.7/.75/.8/.9 PF 1.31(n165)/1.42/1.18/1.09/1.11/1.07 -> edge decays as regime filter loosens (supports the regime gate). box 45/60/90 at lo .7: PF 1.21/1.18/1.31.
- Frozen: lo .7, box 90, tm 2, risk 60, cool 30, maxday 3 (fade branch disabled: hi=99). Train PF1.31 n365 0.62/d net4654 DD1498, rolling pos .79 bust 0 median score 1.22.
- Validation (one official run): PF1.06 n253 0.65/d net770 maxDD2092; rolling pos .61 median score .05. Passes gate narrowly; no further validation tuning.

## v2 rules (design 2021-09..2024-06)
- combine_team x1/2/3/4/6 (lo .7, box 90): pass 0/0/.03/.17/.39; bust 0/0/.08/.29/.47. x8: pass .47 bust .52.
- Grid (lo .65/.7/.75, box 60/90, tm 3, maxday 6) at x4/6/8: best lo.65 box60 x6 pass .43 bust .37; x8 pass .50 bust .45. lo .75 much worse (bust .59+). Nothing meets design bar (pass>=.40 & bust<=.30) at any size; bust grows as fast as pass.
- Conclusion: edge too weak/peaked (PF ~1.2, ~0.6 trades/day); stop. Not certifiable.
