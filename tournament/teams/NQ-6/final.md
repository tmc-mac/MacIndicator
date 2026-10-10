# NQ-6 final
Concept: vol-regime-adaptive opening range. OR(30m) width vs trailing 20-session mean: <1.0 => OR breakout (stop OR mid, target 2R); >=1.0 => failed-breakout fade (stop excursion extreme, target OR mid). Risk $60/trade, contracts = floor(60/(stop_pts*2)), 1..40. Flat 15:55 ET. One trade/day, decisions 10:00-14:00.
Frozen params: lookback 20, thr 1.0, tm 2.0, fw 15, risk 60, OR end 10:00, last decision 14:00, flat 15:55 (6 tunable).
Train: PF 1.34, n=526 (0.90/d), net $8,790, maxDD $1,729 (raw, rules off over 27 months). Rolling 3m evals (53): pass 8%, bust 0%, positive 77%, median score 1.32, median net $957.
Weaknesses: ~$1k per quarter (low pass rate; target $3k rarely hit); max DD of 1.7k over the full period, peaked THR sensitivity (0.8/1.2 notably worse), 2023Q1 negative, intraday-only session so overnight regime ignored; avg contracts small (1-few) so 1-tick slippage matters more on narrow-stop fades.
