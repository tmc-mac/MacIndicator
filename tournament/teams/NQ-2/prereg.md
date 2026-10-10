# NQ-2 preregistration (2026-10-10)
Team NQ-2, trade MNQ, data NQ. Lane: Opening-Range Breakout on the US cash open.

**Core concept:** trade the first close beyond the 09:30-09:45 ET opening range, one trade per day, risk-sized by range width.

## Rules
- Range: high/low of 1-min bars 09:30..09:44 ET (RM=15 min). Range width W = H-L.
- Entry: first 1-min bar (09:45..ENTRY_END=11:00 ET) whose CLOSE is above H (long) or below L (short);
  market order at next open. One signal per session day (first breakout only).
- Filter: skip day if W < WMIN_ATR*ATR or W > WMAX_ATR*ATR, where ATR = mean 15-min-open-range width of the prior 20 days
  (scale-free "typical opening range"). Initial values: 0.5 and 2.0. No other filters.
- Stop: opposite side midpoint-ish: stop = mid of range (H+L)/2 minus nothing (stop distance ~W/2 from the breakout level), ie
  stop = H - SF*W for long (SF=0.5) / L + SF*W for short.
- Target: entry +/- TM * risk distance (TM=2.0). Time exit 15:55 ET.
- Sizing: contracts = floor(RISK_USD / (stop distance in pts * $2)), RISK_USD=150, min 1, cap 40 (and stop dist estimated from the breakout close).
- Parameters (5-7): RM, ENTRY_END, SF, TM, RISK_USD, WMIN/WMAX. Keep plateau-shaped; no per-year tuning.

## v2 amendments (2026-10-10)
Goal changed to pass-before-bust. Added RISK_KEY='RISK' and TUNABLE list to strategy.py; strategy logic unchanged. Did not see validation/proof data; design window (to 2024-06-30) overlaps old train.
