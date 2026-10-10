# ES-6 preregistration (MES, ES data) - 2026-10-10

**Core concept (one sentence):** Trade the first minutes after recurring scheduled-release clock times (08:30, 10:00, 14:00 ET)
and the 15:50 cash-close imbalance window, entering only when the clock-defined window shows a volatility-spike impulse
(event times from clock rules; spike must be visible in already-closed bars), with structure stops and risk-based sizing.

## Entry rules (all times ET, minute_of_day_et; weekdays only; one trade per event per day)
Reference vol R1 = mean(high-low) of the 60 one-minute bars ending the bar before the event (needs all bars present).

**Module A - release impulse continuation**, events E in {510 (08:30), 600 (10:00), 840 (14:00)}:
- Window = bars at minutes E, E+1, E+2 (must exist, consecutive). Decide at the close of bar E+2.
- impulse = close[E+2] - open[E]; rng = max high - min low of the 3 bars.
- Trigger if |impulse| >= K_IMP * R1 (K_IMP=3) AND the E+2 close lies in the outer CLOSE_FRAC (0.30) of rng in the impulse direction.
- Enter market in the impulse direction at the next open.
- 14:00 has no known calendar: FOMC-type days are detected only by this spike filter at that time (no lookahead).

**Module B - 15:50 close-imbalance continuation**: at the close of the 15:50 bar (minute 950), mv = close - close of the 14:30 bar... (minute 870).
Trigger if |mv| >= MOC_K * R1 (MOC_K=12); enter market in the direction of mv (imbalance continues into the close).

## Exit rules
- A: stop at opposite extreme of the 3-bar window (rejected if stop distance D > STOP_CAP*R1, STOP_CAP=12). Target = entry +/- TGT_R * D (TGT_R=1.5). Time exit HOLD_A=45 bars after entry decision.
- B: stop = MOC_STOP*R1 (=3) from entry, no target, forced exit at the 15:59 bar close.
- Hard session flat by 16:00 for all.

## Filters
None beyond the impulse thresholds and stop-cap. No day-of-week or turn-of-month filter at first; any such filter
is considered only afterwards, as a documented amendment, if train evidence shows a plateau-shaped effect.

## Sizing
contracts = floor(RISK_USD / (D_points * 5)), RISK_USD = 120, min 1, cap 40. (D = stop distance in points.)

## Parameters (9): K_IMP, CLOSE_FRAC, STOP_CAP, TGT_R, HOLD_A, MOC_K, MOC_STOP, RISK_USD, vol lookback (60).
Expectation: directional momentum after genuine spikes; fade alternative is NOT pre-registered (would be an amendment).

## Amendments (2026-10-10, after v0 backtest; honest disclosure)
v0 (continuation at all events) lost at 10:00 and 14:00 (PF 0.64 / 0.41) and was too sparse (0.33 trades/day). Amendment: allow a
per-event `fade` set (trade against the impulse, stop beyond the window extreme) and lower thresholds / extra clock events
to reach >=0.5 trades/day. All such choices were made on train only.

## v2 amendments (2026-10-10)
Added RISK_KEY='risk_usd' and TUNABLE list. Goal now pass-before-bust. No new legs adopted beyond one test of 08:30 continuation.
