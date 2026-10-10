# ES-3 preregistration (MES, ES data) — 2026-10-10

**Core concept:** Asia-range breakout traded inside the London session — the Asia session (18:00-03:00 ET) builds a
range; the first decisive close outside it after the London open (03:00 ET) is traded in the break direction,
flat before the US cash open. (Cross-session structure: Asia range -> London trade. No 09:30 opening range.)

## Rules (all clock times ET, from `minute_of_day_et`)
- Asia range: high/low of bars with minute in [1080,1440) U [0,180) belonging to the current CME session day
  (18:00 -> 02:59). Range R = H - L. Known fully at 03:00.
- Entry window: decision bars with minute in [180, 300] (03:00-05:00). At most 1 trade per session day.
  Long: first bar whose CLOSE > H + buf*R. Short: first CLOSE < L - buf*R. Market at next open.
- Filter: R must be between rmin*ATR and rmax*ATR, where ATR = mean 1m-derived 60-bar... (concretely: average
  Asia range of prior 20 sessions, `A`); require rmin*A <= R <= rmax*A (skip degenerate tiny/huge ranges).
- Stop: opposite side of the entry-bar-anchored level: long stop = H - sk*R (inside the range), short stop = L + sk*R.
  Target: entry +/- tg * stop distance (tg=1.5). Time exit: 08:30 ET (minute 510) close, before US data/open.
- Sizing: contracts = floor(risk$ / (stop_dist_pts * $5)), risk$ = 150, min 1, max 40.
- Params (target <= 7): buf=0.10, sk=0.5, tg=1.5, rmin=0.5, rmax=2.0, risk=150 (+ fixed windows).

## Variants permitted for exploration (declared before running)
Fade version (trade back into range after failed break), side filters; any adopted change logged in log.md.
Success criterion: PF>1, >=100 trades per 18 months, >=0.5 trades/day, max DD well under $1,000 on train,
plateau-shaped sensitivity, consistent across train quarters.

## Amendments (2026-10-10, after first backtests; see log.md)
Pre-registered breakout (mode 0) failed on train. Frozen candidate is the declared fade variant: mode=1, buf=0,
sk=2.0 (stop 2R beyond entry), tg=2.0 (x stop distance), rmin/rmax 0.5/2.0, risk 150, entry 03:00-05:00, exit 08:30.
