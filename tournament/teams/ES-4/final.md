# ES-4 final (ML/statistical lane)
Frozen: logistic regression (C=0.01, 8 ATR-normalized features, weights in model.json, fit on full train 2021-09-27..2023-12-31, never retrained).
Params (7): T=0.055 prob threshold, ks=7 (stop = 7 x mean 30-bar 1-min range), no target, hold=30 bars, step=5 min, window 09:45-15:00 ET, flat by 15:55, risk=$150/trade -> contracts = floor(150/(stop pts*5)).
Train raw: net +3121, PF 1.23, 617 trades (1.07/d), max DD 1628 (rules off). Rolling 3m evals (52): pass 0%, bust 0%, positive 71%, median score 0.44, median net +$313. lookahead_clean=True.
Pre-OOS check (fit to 2022, test on 2023): PF 1.1-1.4 across C, T=0.05-0.06, ks=6-10 (plateau).
Weaknesses: edge is thin (model coefficients tiny; momentum from prior close/VWAP); quarterly results uneven (3 of 9 train quarters negative, all with PF~0.7 in late 2021/early 2022 and Q3 2023); median quarter profit far below $3k target so it rarely passes; scaling risk up quickly raises bust rate. Gate (PF>1, >=100 trades, >=0.5/d) margin on PF is modest.

## Rework (post gate failure)
Gate: PF 0.97 original. Model refit on 2021-09..2024-06 (C=0.01), T raised to 0.065. Honest OOS (2024-07..2025-06, not fitted): net -36, PF 0.99, 206 trades, 0.80/d, DD 1099. Simpler-feature variants and lower T all worse OOS (PF 0.6-0.99). Conclusion: the logistic momentum edge does not persist; expect roughly breakeven.

## v2 verdict: NO EDGE (not certifiable)
Design combine (model fit on design, optimistic): best x4 pass 44% / bust 31%. Honest walk-forward: best pass 41% with bust 30% or 26%/24%; never 50/25. Earlier true OOS ~break-even. Stopped.
