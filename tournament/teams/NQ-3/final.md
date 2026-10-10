# NQ-3 final (overnight / gap momentum)
Concept: Asia-session (18:00->03:00 ET) direction persists into the first ~90 minutes of the cash session when the pre-open (03:00->09:29) move does not oppose it.
Frozen params: AGREE=1, AGTOL=0.05 ATR, AS=0.25 ATR stop (ATR = mean 10-day RTH range), AMIN=659 (exit 11:00 ET), ARISK=$200, NATR=10; one trade/day max, no target.
Train (2021-09-27..2023-12-31, rules off): net +$6,871, PF 1.28, 331 trades (0.57/day), WR 46%, max DD $2,223.
Rolling 3-month fresh evals (53): pass 0%, bust 0%, positive 70%, median score 0.54, median net +$840.
Quarterly net: +162, -574, +1988, +1708, +112, -307, +1774, +750, +1257. Lookahead clean.
Sensitivity: stop 0.2-0.3 ATR PF 1.2-1.3 plateau; exit 10:30-11:30 PF 1.33-1.36 plateau; exit 09:40 fails (PF 0.98). Disagree-days traded either way: no edge.
Weaknesses: modest edge (Asia effect t~2.7 on 30 min, small points); low profit per quarter (~$800) so rarely hits +$3k; 1-contract granularity makes sizing coarse
(ARISK>=250 raises bust risk); frequency 0.57/d close to 0.5 gate floor; two flat quarters (2022Q1, 2023Q1) are losers; dead parameters of abandoned legs remain in PARAMS (disabled).
