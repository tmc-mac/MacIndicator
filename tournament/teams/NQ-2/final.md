# NQ-2 final: Opening-Range Breakout (MNQ)
Frozen params: RM=45 (range 09:30-10:15 ET), ENTRY_END=690 (11:30), SF=0.75 (stop = 0.75*range back inside range from the broken side),
no profit target, time exit 15:55 ET, RISK=200 ($ per trade -> 1-2 contracts), range filter 0.5x..2.0x of trailing-20-day mean range. One trade/day.
Train: net +13,169 (1-2 MNQ), PF 1.36, 433 trades (0.74/d), WR 52%, raw maxDD 1,700 over 2.25y. 9/9 quarters positive.
Rolling 3-month evals (53): pass 15%, bust 0%, positive 94%, median score 1.24, median net +$1.6k.
Weaknesses: slow (low pass rate; often net +$1-2k not +3k); stop is wide so 1 contract floor limits sizing control; chop quarters
(2022Q4, 2023Q1) near flat; range-filter bounds untuned; choice of RM=45 was selected on train (plateau 30-60 though); no short-term mean-reversion protection.
