# ES-7 prereg (2026-10-10) — written before any backtest
Core concept: INTERMARKET LEAD-LAG — trade MES using NQ-vs-ES relative-strength divergence.
Signal: on each 1m bar t (RTH 09:35-15:30 ET), D_t = (NQ return over last N bars) - beta*(ES return over last N bars),
both as log returns (beta=1 after vol-normalising each by its own 390-bar rolling std of N-bar returns). z = D_t / rolling std(D).
Hypothesis A (primary, pre-declared): LEAD-LAG CATCH-UP. z > +Z => ES lags NQ => go long ES; z < -Z => short ES.
Hypothesis B (tested once, only if A fails): SPREAD MEAN-REVERSION (opposite sign). Sign is a single binary choice, not tuned further.
Entry: market next open when |z|>=Z, flat, once per cooldown. Stop: k*ATR(30) of ES. Target: m*stop distance. Time exit H bars.
Filters: RTH only, flat by 15:55 ET. NQ aligned to ES by exact timestamp via searchsorted on ES ts with only bars <= t (causal; missing NQ bar -> previous NQ close, no future).
Sizing: contracts = risk$/(stop pts*5), RISK_KEY='risk'. Tunables: N, Z, stop ATR mult, target mult, H, cooldown.
Success criterion: design-window combine pass>=50%, bust<=25% at some size multiplier. Otherwise report no edge.
