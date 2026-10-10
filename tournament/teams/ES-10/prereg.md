# ES-10 prereg (2026-10-10) - written before any backtest
Core concept: candlestick price action on aggregated bars (TF min): engulfing, pin-bar/hammer and inside-bar breakout
patterns taken only at causally-detected swing structure (pattern extreme within 0.5*ATR of the lowest low / highest high
of the last LB aggregated bars), stop beyond the pattern extreme.
Entry: on close of a completed aggregated bar (decision on its last 1-min bar), market at next open. Long: bullish engulfing
(body engulfs prior body, close>prior high-ish: c>prev open & o<prev close, prev bearish), or hammer (lower wick >= 2x body,
close in upper third), or inside-bar breakout (prev bar inside the one before it; close above mother high). Mirror for shorts.
Pattern must sit at swing extreme (support for longs / resistance for shorts) except inside-bar breakout which needs none.
Stop: pattern low (high) -/+ 0.1*ATR buffer. Target: R-multiple TGT_R of stop distance. Time exit: 15:55 ET; entries 09:45-15:15 ET.
Filters: stop distance within [0.5,3]*ATR(14, agg bars); max 1 trade per pattern bar.
Sizing: contracts = risk$/(stop pts*5), floored 1, cap 40. RISK_KEY='risk'.
Tunables: tf, lb, wick ratio, tgt_r, swing tolerance, buffer. Plan: test few combos on design only; if no PF>1 edge, say so.
