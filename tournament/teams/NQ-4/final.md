# NQ-4 final
Concept: multi-timeframe trend pullback. Hourly (from 1m) EMA8/EMA34 trend filter; 1m pullback beyond 0.5 ATR from EMA30 then reclaim above prior bar high (long; mirror short); RTH 09:45-15:15 ET, flat 15:55.
Frozen params: hf 8, hs 34, pb_len 30, atr_len 60, depth 0.5, look 20, stop 2.0 ATR (min 8pt), target 2.5R, risk $60/trade, max 3/day, cooldown 90 bars, max hold 180 bars (~14 tunable).
Train: net $6676 raw, PF 1.13, 1515 trades (2.59/d), raw maxDD $1450. Rolling 3-mo evals (53): pass 0%, bust 0%, positive 79%, median score 1.09, median net ~$1019.
Quarterly PF: .79, 1.29, 1.03, 1.14, 1.41, 1.27, 1.35, .91, 1.01.
Weaknesses: thin edge (PF ~1.1), never reaches the $3k target in a quarter at this size, 2 of 9 quarters losing, parameters chosen on train (cooldown/ATR length tuned; plateau moderate), no live trailing (engine fixed stops), 1-tick slippage on many small-stop trades is costly. Could scale risk up (risk 80 gave more net but DD ~2800 in earlier test).
