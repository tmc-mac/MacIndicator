# NQ-7 preregistration (2026-10-10)
Team NQ-7, MNQ (data NQ). Late replacement for NQ-4.

Core concept: DAILY-STRUCTURE bias. Build prior-session daily bars (CME session day) from 1-min data; trade ONE
intraday position per day in the direction implied by prior-day close-location value (CLV=(C-L)/(H-L)),
conditioned on prior-day structure (range expansion vs trailing 10-day mean range, inside/outside day).

Hypotheses (fixed before testing):
 H1 continuation: if prior CLV >= 0.7 go long; if <= 0.3 go short (close near extreme -> follow-through).
 H2 reversal after expansion: if prior day range > 1.3 x mean(range, prior 10 days) (expansion/outside-like) the
    sign flips (fade the extreme close) -- tested as a single switch, not tuned per-level.
 Neutral CLV (0.3..0.7): no trade.
Entry: market at the 09:35 ET bar close decision (fills next open). One trade/day.
Stop: S = 0.35 x mean daily range of prior 10 sessions, from entry. Target: none; time exit 15:55 ET.
Filters: none other than CLV and expansion switch; skip when stop distance is degenerate.
Sizing: contracts = floor(risk$ / (S pts x $2)), risk$ = 150, min 1, cap 40.
Parameters (count ~6): clv_hi/lo (0.7/0.3), lookback 10, expansion 1.3, stop mult 0.35, risk 150.
Success: PF>1, consistent across train quarters, >=0.5 trades/day, plateau-shaped sensitivity.

## Amendments (2026-10-10, after first backtest + feature study on TRAIN)
H1/H2 (CLV extreme bias) showed PF 1.08, DD >$4k, unstable quarters; feature study showed no open-to-close drift edge
in any prior-day bucket. Only structured finding: when prior CLV is NEUTRAL (balanced close, 0.3..0.7), the
09:36->11:00 move continues into the afternoon (both signs). New H3 (replaces H1/H2): if prior CLV in
[clv_lo, clv_hi] and |am move| >= m x mean10 range, enter at 11:00 ET in direction of the morning move,
stop = stop_mult x mean10 range, time exit 15:55, sizing as before. Band width is the only trade-count lever.

## v2 amendments (2026-10-10)
Added RISK_KEY='risk', TUNABLE list. No logic change. Design-window certifier sweep failed (see log); declared no edge.
