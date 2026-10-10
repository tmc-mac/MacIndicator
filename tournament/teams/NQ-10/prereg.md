# NQ-10 prereg (2026-10-10)
Core concept: floor-trader Camarilla pivots from prior RTH (09:30-16:00 ET) high/low/close: R=H-L; H3=C+1.1R/4, H4=C+1.1R/2, L3, L4 (mirrored).
Two modes, both tested on design only, evaluated separately then optionally combined:
A FADE: after 09:45 ET until 15:00, bar whose range touches H3 (L3) but CLOSES back below H3 (above L3) -> market short (long) next open.
   Stop = H4 (L4) +/- buffer 2 ticks; target = prior close C (pivot). Exit by 15:55 ET. Max 1 trade per level per day.
B BREAK: bar closes beyond H4 (L4) -> market long (short). Stop = H3 (L3) ; target = H4 + k*(H4-H3), k=2. Exit 15:55.
Filters: skip if R below a minimum fraction of price (degenerate), skip stop distance < 10 pts. Max 2 trades/day.
Sizing: contracts = risk$/(stop pts*2), floor 1, cap 40; RISK_KEY='risk' (base 100).
Tunables: entry start minute, last-entry minute, stop buffer, target k, min stop. Acceptance: design pass>=40% bust<=30% at some size; otherwise report no edge and stop.
