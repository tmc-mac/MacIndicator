# NQ-1 final (2026-10-10)
Concept: levels-reclaim (PDH/PDL, Asia H/L, PWH/PWL, RTH VWAP); limit retest entry, stop beyond break extreme, target next level.
Frozen params: K=20, brk=1.0, N=20 (cancel), rrmin=1.5, cz=1.0, risk=60, maxstop=7 ATR, stopbuf=0.5, off=2.0 ATR (limit placed 2 ATR on the
reclaimed side of the level, i.e. buy the pullback toward it before a 1-tick-through touch), window 03:30-15:00 ET, flat 15:55, max 3/day.
Train: n=1181 (2.0/d), PF 1.07, net +3704, maxDD 2855, WR 25%. Rolling 3-mo: pass 0%, bust 34%, positive 53%, median net +110.
Lookahead clean.
Honest weaknesses: no real edge. Event study shows raw reclaims drift ~0-1pt; limit exactly at the level is adversely selected (PF .83-.94).
Only the offset-entry config is marginally positive and the neighbourhood is noisy (PF .91-1.18), so the result is likely not robust.
1-contract floor means risk per trade (~$60) cannot be scaled down; DD too large for the arena. Expect a validation PF near 1.0 -- likely fails the gate.

## Rework (frozen): maxpts=30, max_day=2 (others as above)
Train: n472 (0.81/d) PF1.11 net+1371 DD1605. Validate (one run): n289 (0.75/d) PF1.16 net+1258 DD673, rolling pos 79%, bust 0%.
Caveat: train sensitivity to maxpts is noisy (25: PF1.01, 40: PF0.94); thin edge, PF only ~1.1.

## v2 verdict: NOT CERTIFIABLE
Design pass/bust by size multiplier (base risk $60): x3 13%/42%, x4 19%/63%, x6 26%/68%. No size reaches pass>=40% with bust<=30%.
Edge too thin (PF ~1.08, win rate ~20%). Honest result: no edge sufficient for pass-before-bust. Validation data (2024-01..2025-06) was seen earlier (disclosed).
