# ES-9 prereg (2026-10-10) — written before any backtest
Team ES-9, MES, design data only. Core concept: ROUND-NUMBER / PSYCHOLOGICAL LEVELS (grid every G=25/50/100 ES pts):
price magnets and rejection/breakout at big/half figures, defined stops.

## Back-adjustment problem
ES series is additively back-adjusted (design start ~5257 vs real ~4350), so the adjusted price = true price + offset(contract
segment), offset constant within a contract and unknown (a sum of future roll gaps). The true round grid in adjusted space
is shifted by phase phi_seg = offset mod G, different per quarterly contract. Handling: (a) a descriptive diagnostic (NOT a
backtest): per calendar quarter segment, look for the grid phase with strongest price clustering / reversal at grid lines.
If no phase shows significant, consistent clustering, the concept has no detectable edge and I stop with a plain "no edge".
(b) If clustering exists, phase for each segment must be estimated CAUSALLY (only past bars of the same segment, after a
warm-up of N sessions), never from the full sample.
## Candidate rules (if (a) passes)
- Rejection fade: price probes within 2 pts of a level (G=50) and closes back inside on a 5-min bar -> enter against the probe,
  stop 1x ATR beyond the level, target the next 12.5-pt step or time exit end of RTH.
- Breakout: close beyond level + buffer after prior tests -> enter with, stop back through level.
- RTH only (09:30-15:45 ET), one trade at a time, flat by 15:55.
- Sizing: contracts = risk$ / (stop pts * $5), RISK_KEY='risk'. TUNABLE: buffer, stop ATR mult, touch tolerance, warm-up.
Few params; plateau required; <=2 variants tried; results logged in log.md.
