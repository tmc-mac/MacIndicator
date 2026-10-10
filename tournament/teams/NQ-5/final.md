# NQ-5 final
Concept: ICT: NY AM killzone (08:30-11:00 ET) liquidity sweep of a 3-bar fractal swing high/low (wick through, close back),
then displacement bar (range >= 0.85*ATR30, closes beyond sweep bar, creates 3-bar FVG) within 8 bars; limit entry at FVG
midpoint (cancel 20 bars), stop beyond sweep extreme -2 ticks, target 0.5R, flat by 12:00 ET, max 2 trades/day.
Sizing: contracts = floor($175 / (stop pts * $2)), stop 4-60 pts.
Frozen PARAMS: k_disp .85, atr_n 30, frac 3, lookback 120, disp_win 8, rr .5, risk 175, kz 510-660, exit 720, max/day 2,
min/max stop 4/60, cancel 20, buf 2 ticks (about 6 real tunables).
Train: net $14.2k, PF 1.67, WR 77%, 587 trades (1.00/day), maxDD $933. Rolling 3-mo evals (53): pass 1.9%, bust 0%, positive 98%,
median net $1.58k, median score 2.52. lookahead_clean True. All 10 train quarters positive.
Weaknesses: rr deviates from the classic 2R+ ICT target (rr>=1.25 had no edge; high win-rate/small-win profile, so a loss
streak or widened slippage hurts; avg win ~0.5R vs loss 1R); rarely reaches $3k in 3 months at this risk (raise risk$ ~250 for ~$2.2k/qtr, DD ~1.4k);
parameters (rr, k_disp, frac) were chosen after seeing train results; edge not yet tested out-of-sample.
