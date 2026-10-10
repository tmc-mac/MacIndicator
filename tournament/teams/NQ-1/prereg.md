# NQ-1 preregistration (written 2026-10-10, before any backtest)
Team NQ-1, trades MNQ ($2/pt), data NQ 1-min.

## Core concept (one sentence)
LEVELS-RECLAIM: when price breaks an institutional level (prior-session H/L, Asia H/L, prior-week H/L, RTH VWAP)
and then closes back across it (reclaim), rest a limit order at the reclaimed level, stop beyond the break
extreme, target the next institutional level; stacked levels (confluence) get larger size.

## Levels (all computed causally)
PDH/PDL = prior CME session high/low; AH/AL = Asia range 18:00-03:00 ET of current session (usable from 03:00 ET);
PWH/PWL = prior Mon-Fri week high/low; VWAP = volume-weighted average anchored 09:30 ET (usable from 10:00 ET, moving).

## Entry
Long (mirror for short) at bar i close: for level L, min(low over last K bars) < L - brk*ATR (a real break),
close[i] > L and close[i-1] <= L (the reclaim bar). Place limit buy at L (retest), live from bar i+1, canceled
after N bars. Each (level, side) used at most once per session. Entries only 03:30-15:00 ET, flat by 15:55 ET.
ATR = mean(high-low) of last 60 bars.
## Exit
Stop = break extreme (swing low of last K bars) - 0.5 ATR (long). Skip if stop distance > maxstop ATR.
Target = nearest institutional level beyond L giving >= rrmin * risk; if none, skip the trade (cap target at 4R).
Time exit 15:55 ET.
## Confluence
n = number of other levels within cz*ATR of L. Size risk$ = base * (1 + 0.5*min(n,2)).
## Sizing
contracts = floor(risk$ / (stop_dist_pts * 2)), min 1, risk base ~ $60 so max DD stays < ~$1000.
Daily: max 3 trades/session signaled (cheap guard); engine DLL handles the rest.
## Parameters (planned, few): K=20, brk=1.0, N=10, rrmin=1.0, cz=1.0, base risk, maxstop=8.
Success criteria: train PF>1.1, >=0.5 trades/day, plateau-shaped sensitivity, positive across quarters.

## Amendments (rework, 2026-10-10)
After validation gate failure (PF 0.96, DD 5150): added absolute stop cap maxpts=30 pts (skip setups whose 1-contract risk > $60,
so the 1-contract floor cannot inflate risk) and max_day 3 -> 2 (fewer, cleaner setups). Numba cache removed. Concept unchanged.
