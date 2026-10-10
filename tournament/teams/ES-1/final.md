# ES-1 final (MES, session-VWAP)
Concept: RTH VWAP (09:30 anchor) + volume-weighted sd. Final design = VWAP-pullback continuation (fade module A failed, PF<0.97, kept as generate_a only).
Entry: VWAP 45-bar drift >= 0.5 sd in trend direction, price on trend side, bar touches within 0.6 sd of VWAP and closes back as a trend-colored bar; market next open. 10:00-15:00 ET, max 3/day.
Stop: VWAP (or pullback extreme) -/+ 2 sd. No target; time exit 15:55 ET. Sizing: floor($100 / stop $) contracts, min 1; skip if 1-contract stop risk > $150.
Frozen params: s_min .5, pb .6, stopk 2, rr 0, risk 100, slope_n 45, max_risk1 150, t0 600, t1 900, eod 955, max_tr 3, cool 15.
Train raw: net +6282, PF 1.31, WR 41%, 430 trades (0.75/d), maxDD 1684. Quarters: 8 of 9 positive (2021Q4 -622). Long +3536, short +2746.
Rolling 3-mo fresh evals (52): bust 0%, positive 85%, pass 0%, median net $786, median score 1.13.
Weaknesses: effectively one trade per day held to close (trade count ~0.75/d, near gate floor 0.5); median quarter well under $3k target; 1-contract floor means DD (~1.7k over 27 months, per-quarter smaller) cannot be sized down; slope lookback sensitive (edge fades at >=75 bars); fixed targets destroy edge; many full-stop losses (WR 41%).
