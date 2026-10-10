# ES-2 preregistration (written before any backtest) - 2026-10-10
Team ES-2, MES. Lane: mean reversion via statistical exhaustion (not VWAP).

**Core concept:** fade short-horizon return z-score extremes (15-minute return measured in units of trailing 1-minute
volatility) during RTH, betting on snap-back after an exhaustion move.

**Signal (bar close i, RTH 09:45-15:30 ET only):**
- r = c[i]-c[i-L], L=15. sigma = std of 1-min close diffs over trailing W=390 bars. z = r/(sigma*sqrt(L)).
- Long if z <= -K, short if z >= +K (K=2.5). Market entry at next open.
- Filter: skip if the session's |close - RTH open| exceeds 3 x (sigma*sqrt(390)) (strong trend day), to avoid fading trends.
- Cooldown: a new signal is only considered after prior trade closed (engine); also at most 4 entries per session.

**Exit:** unit u = sigma*sqrt(L). Stop = 1.5u beyond entry; target = 1.0u back toward the pre-move price;
time exit after 30 bars; forced flat 15:55 ET. All trades flat by session end.

**Sizing:** risk budget R=$100 per trade: contracts = floor(R / (stop_pts*5)), min 1, max 40.

**Parameters (6):** L=15, K=2.5, stop mult 1.5, target mult 1.0, time exit 30, risk $100.
Sensitivity to be checked over K in {2,2.5,3}, L in {10,15,30}. Expect plateau; no further tuning beyond this grid.

## Amendments (2026-10-10, after sweep 1 on train)
Pure z-fade of 10-60 min moves showed no edge (PF<=1.05). Exploring longer horizons (L 60-240) and an optional
reversal-confirmation filter (current bar closes against the move). Same concept (return z-score exhaustion fade).

## v2 amendments (2026-10-10)
Added RISK_KEY='risk' and TUNABLE to strategy.py. No logic changes. Design sweep shows no sizing meets the bar; declared no edge.
