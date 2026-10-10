# ES-1 final (MES, session-VWAP)
Concept: RTH VWAP (09:30 anchor) + volume-weighted sd. Final design = VWAP-pullback continuation (fade module A failed, PF<0.97, kept as generate_a only).
Entry: VWAP 45-bar drift >= 0.5 sd in trend direction, price on trend side, bar touches within 0.6 sd of VWAP and closes back as a trend-colored bar; market next open. 10:00-15:00 ET, max 3/day.
Stop: VWAP (or pullback extreme) -/+ 2 sd. No target; time exit 15:55 ET. Sizing: floor($100 / stop $) contracts, min 1; skip if 1-contract stop risk > $150.
Frozen params: s_min .5, pb .6, stopk 2, rr 0, risk 100, slope_n 45, max_risk1 150, t0 600, t1 900, eod 955, max_tr 3, cool 15.
Train raw: net +6282, PF 1.31, WR 41%, 430 trades (0.75/d), maxDD 1684. Quarters: 8 of 9 positive (2021Q4 -622). Long +3536, short +2746.
Rolling 3-mo fresh evals (52): bust 0%, positive 85%, pass 0%, median net $786, median score 1.13.
Weaknesses: effectively one trade per day held to close (trade count ~0.75/d, near gate floor 0.5); median quarter well under $3k target; 1-contract floor means DD (~1.7k over 27 months, per-quarter smaller) cannot be sized down; slope lookback sensitive (edge fades at >=75 bars); fixed targets destroy edge; many full-stop losses (WR 41%).

## REWORK (supersedes numbers above)
Changes: pb 0.6->1.0, flat 14:00 ET (eod 840), max_risk1 150->90 (skip high-vol days). clean_n/htf options exist but are 0/off.
Train: PF 1.16, 315 trades (0.55/d), net +1870, DD 2268; rolling bust 4%, positive 69%, median net $378.
Validate: PF 1.07, 205 trades (0.53/d), net +630, DD 1582. lookahead_clean True.
Honest: edge is thin and regime dependent (strong-trend filters and fades failed validation); parameters were chosen with several validation looks.

## v2 (supersedes rework)
Reverted to original settings: s_min .5, pb .6, stopk 2, slope_n 45, cap $150, flat 15:55; risk=250 (x2.5 of 100).
Design (2021-09..2024-06) combine: pass 0.35, bust 0.26, timeouts remainder; x3 gives .44/.45. No variant reached pass>=40% with bust<=30%.
Conclusion: VWAP trend-pullback edge (PF ~1.2, ~41% WR, ~0.7 trades/day, one trade/day held for hours) is too weak/high-variance to certify. Not certifiable.
