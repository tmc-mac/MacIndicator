# NQ-6 preregistration (2026-10-10)
Team NQ-6, instrument MNQ (data NQ). Written before any backtest.

## Core concept
Volatility-regime-adaptive opening-range system: each RTH session is classified by its 30-minute opening-range (OR) width
relative to the trailing 20-session mean OR width (compression vs expansion), and compression sessions trade OR *breakouts*
while expansion sessions trade *failed-breakout fades* back into the range, with risk-per-trade fixed in dollars so size is
inversely proportional to volatility (stop distance).

## Rules
- Session: RTH 09:30-16:00 ET. OR = high/low of 09:30-09:59 bars. Decisions only from 10:00 (bar close) to 14:00 ET; flat by 15:55 (exit_by).
- Regime: rel = ORwidth_today / mean(ORwidth of previous 20 sessions). rel < THR (1.0) => BREAKOUT mode; else FADE mode.
  (Prior sessions only; today's OR is complete at the 10:00 decision.)
- BREAKOUT: first 1-min close above ORH => long (below ORL => short), market. Stop at OR midpoint, target = TM(1.5) x stop distance. Max one trade/day.
- FADE: a bar's high pierces ORH (low pierces ORL); if within FW(15) bars a close returns inside the OR => fade (short at ORH side, long at ORL side), market.
  Stop = extreme of excursion +/- 1 tick; target = OR midpoint. Skip if stop distance > 1.0 x OR width. One trade/day.
- Sizing: contracts = floor(RISK$ (150) / (stop_pts * $2)), clamped 1..40 (volatility targeting via stop distance).
- No parameter tuning beyond sanity checks on 3-4 plateau values (THR, TM, RISK). Parameters: OR minutes (30), lookback (20), THR, TM, FW, RISK = 6.
