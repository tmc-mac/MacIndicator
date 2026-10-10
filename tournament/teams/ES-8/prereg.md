# ES-8 preregistration (2026-10-10), MES, ES data, design window only
Core concept: Ichimoku system on causally aggregated N-minute bars (default 15m): Tenkan/Kijun cross with cloud (Kumo) filter, Chikou confirmation, cloud-based stops.
Aggregation: 1m bars grouped into N-minute buckets by ET clock (bucket = minute_of_day//N, within session day); a decision is made only at the close of the last 1m bar of a bucket, using completed buckets only.
Ichimoku standard 9/26/52, cloud displaced 26 bars forward (cloud at bar t uses spans computed at t-26).
Entry long (short mirrored), evaluated at agg-bar close, RTH 09:45-15:00 ET:
 - Tenkan crossed above Kijun on this bar (or within last 2 bars)
 - close above cloud top (current displaced cloud)
 - Chikou: close > close 26 bars ago (and > cloud-era price, i.e. above price 26 bars ago)
 Market entry next 1m open.
Stop: below cloud bottom or Kijun, whichever is nearer-but-farther-than-min (stop = min(kijun, cloud bottom) minus buffer), clipped to [min_stop, max_stop] points distance.
Exit: target = rmult x stop distance; forced flat 15:55 ET. One trade/day max-ish via cooldown (engine one position at a time).
Sizing: contracts = floor(risk $ / (stop pts * 5)), min 1. RISK_KEY='risk'.
Tunables: N, rmult, buffer (pts), max_stop (pts). Planned test: sweep sizing on design with combine_team; no more than a small grid. Honest stop if no edge.
