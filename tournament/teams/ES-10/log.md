# ES-10 log (design data only)
- Sweep 1 (patterns x tf 5/15/60 x tgt 1/2): engulf and pin at swing: PF 0.72-0.93 everywhere; 5m PF<0.8 (slippage vs small stops); 60m produced no trades.
- Inside-bar breakout alone best: tf15 tgt1 min_atr1.0 PF 1.14 but 0.29 trades/day (<0.5 bar), 207 trades; neighbours PF 1.0-1.06.
- Combined (all 3) PF 0.89-0.96 at best. Sweep 2 (tf 10/15/30, tgt 1/3, min_atr .5/1): no plateau of PF>1.1 with >=0.5 trades/day.
- Conclusion: no certifiable edge; combine sizing not run (raw PF<1 / too few trades). Stopped, no further tuning.
