# NQ-5 preregistration (2026-10-10)
Team: NQ-5 (MNQ, data NQ). Lane: ICT / smart-money concepts.

Core concept: in the NY AM killzone (08:30-11:00 ET), trade the reversal after a liquidity sweep of a
confirmed swing high/low, entered on a limit retrace into the fair-value gap (FVG) created by the displacement leg.

Entry rules (long; short mirrored):
1. Swing low = 5-left/5-right fractal on 1m bars (confirmed 5 bars later), most recent swing lows within last 120 bars.
2. Sweep: a bar trades below the swing low (low < swing) and closes back above it.
3. Displacement: within 8 bars after the sweep bar (inclusive of the sweep bar's successors), a bar closes above the
   sweep bar's high with range >= k_disp * ATR(30), and forms a bullish FVG (low[i] > high[i-2]).
4. Entry: limit at FVG midpoint, cancelled after 20 bars. Decision on close of the displacement bar.
5. Stop: below sweep extreme minus 2 ticks. Target: 2.0R. Time exit: 12:00 ET (or 60 bars after fill window) -> exit_by at minute 720 of day.
Filters: signals only when displacement bar closes in 08:30-11:00 ET; max stop distance cap (reject if stop > 60 pts or < 4 pts); max 2 trades/day.
Sizing: contracts = floor(risk$ / (stop_pts * $2)), risk$ = $150 fixed, cap 40.
Parameters (few): k_disp=1.5, ATR len 30, swing fractal 5, lookback 120, R=2, risk$=150, killzone window.
Plateau checks to be done on k_disp, R, risk$, killzone end.
