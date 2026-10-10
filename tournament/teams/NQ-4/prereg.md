# NQ-4 Preregistration (2026-10-10), written before any backtest
Team NQ-4, trade MNQ ($2/pt), data NQ 1-min.

**Core concept:** multi-timeframe trend-following pullback: a higher-timeframe trend filter (60-minute bars resampled
from 1-min, fast EMA vs slow EMA of 60m closes, completed bars only) and a lower-timeframe (1-min) pullback-and-reclaim
entry with ATR-based stop and R-multiple target, risk-based sizing.

## Trend filter (HTF)
Build 60-min closes aligned to ET clock hours using only completed hourly bars. EMA(8) and EMA(34) of those closes.
Uptrend: EMA8 > EMA34 and last completed 60m close > EMA34. Downtrend: mirror. Otherwise no trade.
(Equivalent in 1m terms; implemented causally so a bar's value uses only bars through the previous hourly close.)

## Entry (1-min, RTH 09:45-15:15 ET)
Pullback measure: 1-min EMA(30) ("pullback line"). Long: in uptrend, within the last 20 bars price closed below the
EMA30 by at least 0.5*ATR (pullback) and the current bar closes back above EMA30 AND above the prior bar's high (reclaim).
Short: mirror. Market order next open. Max 3 signals per session day, 20-bar cooldown after any signal.
ATR = 30-bar average true range on 1-min.

## Exit
Stop = entry -/+ 3.0*ATR(30) of 1m (floored at 8 pts). Target = 1.5 x stop distance. Forced time exit at 15:55 ET and
max hold 180 bars. (Engine stops are fixed, so no live trailing; the ATR stop and R target serve as the risk model.)

## Filters
RTH window only; Wednesdays/any day not excluded; no parameter-tuned day filters.

## Sizing
Risk budget $150 per trade: contracts = floor(150 / (stop_pts * 2)), min 1, cap 40.

## Parameters (frozen starting set; ~9): ema fast/slow hourly (8/34), pullback EMA 30, ATR len 30, pullback depth 0.5 ATR,
stop mult 3.0, target R 1.5, risk $150, max signals/day 3.
Allowed tuning: only coarse grids on train around these; any change logged in log.md.

## Amendments (rework), 2026-10-10
Validation gate failed (PF 0.83). Principled fixes, declared before re-testing: (1) trend-strength gate: |EMA8-EMA34| of hourly closes must exceed
`strength` x hourly-scale ATR (8 x ATR1m(60)) so only established trends trade; (2) fewer trades via max 2/day and longer cooldown; (3) wider stop (3 ATR)
with risk-sized contracts. Validation used sparingly; train re-confirmed first.

## v2 amendments (2026-10-10)
Disclosure: I saw validation-window (2024-01..2025-06) results earlier in the rework (PF 0.83, then 0.97/0.93/0.84 for strength variants). That window overlaps the proof year, so my knowledge is contaminated; design-only evidence below. Plan: run combine_team on current params (strength 1.0) and strength 0 / 0.5 as the one principled variant; if design pass<40% or bust>30% at any size, declare no edge.
