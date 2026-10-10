# ES-2 final (MES, mean reversion via return z-score exhaustion)
Frozen PARAMS: L=75 (return horizon, min), W=780 (vol window), K=2.25 (|z| entry), stop 3.0u, target 2.5u (u=sigma1m*sqrt(L)),
tmax 180 bars, risk $130/trade (contracts=floor(risk/(stop*5)), min 1), RTH entries 09:45-15:00 ET, flat by 15:55 ET,
trend-day filter (|c-RTH open| > 3 daily-sigma skips), max 4 entries/session, confirm=0. (~10 params; 5 core.)
Train (rules off): net +3670, PF 1.17, 532 trades, 0.93/day, WR 53%, max DD 1153. lookahead_clean True.
Quarterly P&L (train, ~91d): 227,-589,1212,980,755,-223,702,72,221,313 (8/10 positive).
Rolling 3-mo fresh evals (52 windows): pass 0%, bust 0%, positive 75%, median score 0.54, median net +338.
Weaknesses: thin edge (~$1.2k/quarter at 1-2 MES), never reaches +$3k target in 3 months; shorter horizons (<=45 min) have no edge;
upsizing degrades PF and raises bust risk; some of the parameter choice (L75, tgt) came from sweeps on train; 1-min z-fade edge
could be regime dependent (weak in 2022H2 trend). Gate risk: PF 1.17 train, ~0.93 trades/day passes >0.5.

## v2 verdict: NO EDGE (does not meet certification)
Design-window combine: best size x3 gives pass 13% / bust 25%; x4 pass 27% / bust 47%; x6 24%/76%. Never reaches pass>=40% with bust<=30%.
Edge (PF ~1.07-1.15 design, ~1.00 validation) is too thin for pass-before-bust at any sizing. Not certified; no further work.
