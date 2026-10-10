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

## Amendments (rework) 2026-10-10 - written before any rework backtest
v1 failed validation (PF 0.98). Rework makes the regime classifier the centerpiece and drops 09:30 OR geometry.
- Regime (rolling, any time 10:00-15:30 ET): ratio = ATR(15 bars)/ATR(240 bars) of 1-min true range (continuous series).
- ratio < LO (0.6) = compression: trade breakout of prior 30-bar box (close beyond high/low), stop box midpoint, target 2R.
- ratio > HI (1.5) = expansion/stretch: fade when |close - mean60| > Z(2.5) x std60; stop beyond the excursion by 1 ATR(15), target mean60.
- Middle regime: no trade. Risk $60/trade, contracts=floor(60/(stop*2)). Cooldown 30 bars after any signal; max 3 trades/day; flat 15:55 ET.
- Params: LO, HI, Z, box 30, plus fixed windows. Few sanity checks only; validation used sparingly.

## v2 amendments (2026-10-10)
Disclosure: I saw 2024-01..2025-06 validation results earlier (v1 PF 0.98, v2 PF 1.06) and used one official run to confirm v2; the v2 design (compression gate, box 90) was chosen on train before that run, but the earlier validation knowledge is not blind. Added RISK_KEY='risk', TUNABLE list. No logic changes under v2 rules; only design-window sizing sweep and a small sensitivity grid.
