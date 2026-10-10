# NQ-9 prereg (2026-10-10) - written before any backtest
Instrument: MNQ (data NQ). Lane: Market Profile / auction value area.
Core concept: build the prior RTH session (09:30-16:00 ET) volume profile from 1-min bars (volume distributed over
the bar's high-low range in 1-pt bins), derive POC and 70% value area (VAH/VAL); trade the "80% rule":
open outside prior value, then price re-enters value and is ACCEPTED (N consecutive 1-min closes inside) -> trade toward
the opposite value edge.
Entry: day's RTH open (09:30 print) is outside [VAL,VAH] by >= gap_min pts. Between 09:35 and 11:30 ET, after
`accept` consecutive closes back inside value, enter market in direction of the opposite edge (open above VAH -> short).
One trade per day.
Stop: beyond the extreme of the excursion outside value (session extreme so far) + buffer, capped at max_stop pts
(skip if cap exceeded). Target: opposite value edge (or POC for partial-width variant; fixed design choice: opposite edge).
Time exit: 15:45 ET. 
Sizing: contracts = floor(risk / (stop_pts*2)), min 1, scales linearly with `risk`.
Params (planned tunables): accept(2-3), gap_min, buf, max_stop, va_pct(0.70), latest entry minute.
Rejection/no-trade: if open inside value, no trade (maybe later variant: acceptance-break continuation, appended as amendment).
Honesty: if no sizing passes design (>=40% pass, <=30% bust), report no edge and stop.
