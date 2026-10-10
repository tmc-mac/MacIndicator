# NQ-3 preregistration (2026-10-10)

Team: NQ-3 (MNQ, NQ data). Written before any backtest.

## Core concept
Overnight/gap momentum: the direction and size of the overnight move (prior RTH close 16:00 ET -> 09:30 ET open),
confirmed by the first minutes of the cash session, predicts intraday continuation; unconfirmed/failed gaps are faded.

## Definitions (all causal)
- PC = close of the 15:59 ET bar of the prior session day (RTH close). O = open of the 09:30 bar.
- gap = O - PC. ATR = mean of the last 10 completed RTH ranges (09:30-15:59 high-low), prior days only.
- ONR = overnight range (18:00 ET -> 09:29 ET high-low) used as a conditioning variable; gap_n = |gap|/ATR.
- Decision at close of the 09:34 bar (first 5 RTH minutes): m5 = C(09:34) - O.

## Entry (one trade/day max, market order at 09:35 open)
- Continuation: gap_n >= G (default 0.15) and sign(m5) == sign(gap) and C(09:34) beyond PC in gap direction -> trade with the gap.
- Fade (failed gap): gap_n >= G and sign(m5) == -sign(gap) and |m5| >= 0.5*|gap|*... (simplified: price has retraced through O against the gap by >= F*|gap|, F=0.5) -> trade against the gap (toward PC).
- Small gap (gap_n < G): no trade.
- Optional conditioning: ONR/ATR high (>= R) required for continuation (overnight range expansion = information arrival); tested as one filter.

## Exit
- Stop: S * ATR from entry (default S=0.25 ATR), always set.
- Target: none for continuation (time exit); fade target = PC (gap fill) if distance reasonable.
- Time exit: 11:30 ET close (primary); alternative 15:55 tested as single sensitivity.

## Sizing
contracts = floor(RISK / (stop_pts * 2)), RISK default $250, clipped 1..40.

## Parameters (target <= 6)
G, S, RISK, time exit, F, R. Evaluate plateaus; choose in middle of plateau; no per-regime tweaking.

## Success criteria
Train PF > 1.1, trades/day >= 0.5, positive in most rolling windows, bust rate ~0.

## Amendments (2026-10-10, after first backtests; see log.md)
The original morning gap continuation/fade legs showed no edge and were disabled (CONT=0, FADE=0). The overnight-drift leg also failed.
Exploration of overnight segment returns on train found the Asia-session return (18:00->03:00 ET) continuing into the cash open.
Final strategy: side = sign(open03:00 - open18:00); require 03:00->09:29 move not opposing by > 0.05 ATR; market entry at 09:30 open;
stop 0.25*ATR10(RTH range); time exit 11:00 ET; contracts = floor(200/(stop_pts*2)) min 1. Same concept (overnight momentum into the open).

## v2 amendments (2026-10-10)
Added RISK_KEY='ARISK', TUNABLE=[AS,AMIN,ARISK,AGTOL,NATR]. No logic change. Design-window sizing sweep run; concept fails the bar (see log.md / final.md).
