# ES-1 preregistration (2026-10-10)
Team ES-1, instrument MES (data ES). Written before any backtest.

## Core concept
RTH session-VWAP (anchored 09:30 ET) with volume-weighted standard-deviation bands: fade statistically
extended price back toward VWAP on non-trending sessions; optional VWAP-pullback continuation on trending sessions.

## Definitions
- VWAP_t = cumsum(typical*v)/cumsum(v) from 09:30 ET each session day; sd_t = sqrt(cumulative vol-weighted variance of typical about VWAP).
  Bands = VWAP +/- k*sd. Computed on bars with minute_of_day_et in [570, 960).
- Trend measure: slope = (VWAP_t - VWAP_{t-30}) / sd_t (VWAP drift in sd units over 30 min).

## Module A: band-fade reversion (primary)
- Window: 10:00-15:00 ET entries (sd needs ~30 min of data), min sd floor to avoid tiny stops.
- Setup: bar close beyond VWAP -/+ K_ENTRY*sd (K_ENTRY = 2.0). Entry (market next open) on the first bar
  whose close is back inside the band after having closed outside it within the last 5 bars (rejection confirm). Direction toward VWAP.
- Filter: |slope| < SLOPE_MAX (0.6): skip when VWAP is trending hard.
- Stop: extreme (high/low) of the excursion +/- 0.25*sd... bounded; Target: VWAP (current value at signal bar).
  Require reward/risk >= 0.8.
- Time exit: 15:55 ET close (also max hold 90 bars).
## Module B: VWAP pullback continuation (only if A alone fails the gate; documented as amendment if used)
## Sizing
- Risk per trade fixed R = $120; contracts = floor(R / (stop_pts*5)), min 1, max 40. Skip if stop risk of 1 contract > $250.
- One signal per side-direction per 20 bars; max 3 trades/day (cap by decision logic).
## Parameters (~7): K_ENTRY, SLOPE_MAX, stop buffer (sd), R, max trades/day, window start/end, max hold.
## Expected failure modes: trend days (stopped repeatedly), low-vol chop with small sd.

## Amendments (2026-10-10, after first backtests)
Module A (fade 1.5-3 sd, train): PF 0.62-0.80 everywhere, 1.5-3 sd, all slope filters; fading loses. Module B now primary:
VWAP-pullback continuation. Trend condition: slope_n-bar VWAP drift in sd units |slope| >= S_MIN and close on trend side of VWAP.
Entry: market after a bar whose low touched within PB*sd of VWAP (long) and closes back above VWAP + 0 and bullish (close>open).
Stop: VWAP -/+ STOPK*sd (below pullback low if lower). Target: entry +/- RR*risk. Same sizing (fixed $ risk), time exit 15:55, max 3 trades/day.

## Amendments (rework, 2026-10-10)
Validation gate failed (PF 0.95, 268 trades, DD 2044; weak 2024Q1-Q3 chop and 2025Q2 whipsaw). Principled fix: trend-quality
filter -- require the close to have stayed on the trend side of VWAP for the last HOLD_N bars before the pullback bar
(a clean trend, not a VWAP-straddling chop whose drift is just a transient). Options tested on train first; validation used once to confirm.
Rework outcome: clean-trend filter (price on trend side of VWAP for N bars), prior-close direction filter, stronger slope thresholds,
and module A fades all made validation WORSE (PF 0.72-0.91) or did not generalize. Kept: volatility-regime cap (skip trades whose 1-contract
stop risk > $90, i.e. skip high-vol days where 2-sd stops are huge), pb 1.0, and an earlier 14:00 ET flat (frees afternoon for a second trade; trend edge decays late).

## v2 amendments (2026-10-10)
Added RISK_KEY='risk', TUNABLE list. Reverted to the original design-robust settings (pb .6, flat 15:55, max_risk1 150), discarding the
validation-tuned rework values (pb 1.0, flat 14:00, cap 90), which were picked with many validation looks. Sizing chosen on design only.
