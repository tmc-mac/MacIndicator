# NQ-6 final (rework v2)
Concept: rolling volatility-regime gate. Regime = ATR(15)/ATR(240) of 1-min true range. Compression (<0.7) => trade a close beyond the prior 90-bar box (stop box midpoint, target 2R, risk $60/trade, contracts=floor(60/(stop*2))). Otherwise stand aside (fade branch for expansion was tested, no edge, disabled via hi=99). 10:00-15:30 ET entries, 30-bar cooldown, max 3/day, flat 15:55.
Params: lo .7, box 90, tm 2, risk 60, cool 30, maxday 3 (+fixed windows 15/240).
Train: PF1.31, n365 (0.62/d), net $4,654, DD $1,498; rolling pos 79%, bust 0, pass 0, median score 1.22.
Validation (rules off): PF1.06, n253 (0.65/d), net $770, DD $2,092; rolling pos 61%, median score 0.05.
Weaknesses: thin edge out of sample, DD high vs net, regime threshold is peaked (lo .75+ degrades), mean-reversion leg has no edge on NQ 1-min, never reaches $3k target. v1 (OR regime switch) failed validation PF .98.

## v2 verdict (design-window pass-before-bust)
Concept (ATR-ratio compression-gated box breakout) cannot reach pass>=40% / bust<=30% at any sizing. Chosen reference x6: pass 39%, bust 47%, timeout 14%, median 49 days; x4: pass 17%, bust 29%. Best variant (lo .65, box 60, x6): pass 43%, bust 37%. Regime threshold is peaked (lo .75 -> bust 59%+). Disclosure: I saw validation (2024-01..2025-06) results before this phase. Recommend NOT certifying.
