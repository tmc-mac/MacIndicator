# NQ-4 research log (train 2021-09-27..2023-12-31)
- prereg.md written first. Baseline (risk150, atr30, stop3.0, rr1.5, cooldown20): net 5309, PF 1.06, n=1282, maxDD 3491, rolling bust 38%, pass 8%.
- Coarse grid (risk 80): stop_mult 2/3/4 x rr 1/1.5/2.5: PF 1.00-1.07, no clear edge, stop2/rr2.5 best; depth 0..1.5 flat/worse; hs=21 bad (PF .94), hs=55 weak; max_day 1/2 weaker.
- With stop2/rr2.5/risk60: pb_len 15/60 ok(PF1.03-1.04), hf5/hs13 bad, hf13/hs55 ok, atr_len 60 better (PF1.08), cooldown 45 better.
- Cooldown sweep (stop2,rr2.5,atr60,risk60): 45 PF1.08, 60 1.09, 75 1.07, 90 1.13, 120 1.10, 180 1.14 -> plateau PF 1.07-1.14; chose 90.
- Frozen: PARAMS in strategy.py (atr_len 60, stop 2.0 ATR, rr 2.5, cooldown 90, risk $60). Changed from prereg (stop 3.0/rr1.5/atr30/cd20/risk150) by tuning; prereg unedited.
- Final train: net 6676, PF 1.13, n=1515 (2.59/d), maxDD 1450 raw; rolling 53 windows: pass 0%, bust 0%, positive 79%, median score 1.09, median net $1019. lookahead_clean True.
- Quarterly PF: 0.79,1.29,1.03,1.14,1.41,1.27,1.35,0.91,1.01 (7/9 positive).
- Note: removed numba cache=True (dynamic module loading breaks cache).
