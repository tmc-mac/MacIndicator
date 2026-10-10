# NQ-3 research log (train 2021-09-27..2023-12-31)
- prereg written first. v1 gap strategy (09:35 entry, ATR-scaled stop, 11:30 exit): continuation+fade PF 0.93 (n=226, 0.39/d); fade alone PF 0.38 (bad, dropped);
  continuation alone G=0.15 PF 1.03; G=0 n=272 (0.46/d) PF 0.96; S=0.15 PF 1.06 but DD 6k, bust 38%; exit 10:00 or 15:55 no better; high ONR filter worse (PF 0.81).
  Conclusion: pure morning gap continuation has ~no edge and too few trades. Next: overnight-drift leg (hold from 16:00 close to 09:29).
- Overnight-drift long 16:00->09:29 (stop 0.3-0.8 ATR): PF 0.92-0.98, DD ~9k. No edge (2022 bear). Dropped.
- Exploratory stats on train (segment returns): Asia session return (18:00->03:00 ET) sign continues into first 30min of RTH:
  mean +8.0 pts, t=2.7, positive in 2021/22/23 (8.9/9.7/5.9). Gap itself ~zero/slightly negative at 30min; 03:00->09:25 move continues into the day weakly (t 1.3 to close).
  New plan: ASIA leg = trade sign(Asia return) at 09:30 open, exit ~10:00.
- ASIA leg (side=sign(open03:00-open18:00), market at 09:30, stop AS*ATR10, time exit): unfiltered PF 1.12, DD 7k (stop 0.15 ATR). AGREE=1 (also require 03:00->09:29 move same sign): PF 1.28, n=290 (0.50/d).
  Stop sweep AS 0.2/0.25/0.3 plateau PF 1.26; ARISK 250->DD ~1.8k at AS .25, ARISK 120 -> DD 1.2k PF 1.30. Exit 10:30 (AMIN=629): PF 1.36, pos 85% rolling. Exit 09:40 PF 0.98 (too short).
  Frequency borderline 0.50/d -> testing AGREE=2/3 (what to do when Asia and pre-open disagree).
- Sizing note: contracts=floor(ARISK/(stop_pts*2)) floors at 1, so ARISK<~250 is effectively 1 contract. ARISK 300 -> 28% bust, 250 -> 9%, 200 -> 0% bust, DD 2.2k raw (all-train, rules off), 150 -> DD 1.8k.
  AGTOL 0.05 (skip only if pre-open move opposes Asia by > 0.05 ATR) lifts frequency 0.50 -> 0.57/d at PF 1.28 (0.2 -> PF 1.19, not chosen).
- FROZEN: AGREE=1, AS=0.25, AMIN=659 (11:00 ET exit), ARISK=200, AGTOL=0.05, NATR=10. Train: net 6871, PF 1.28, n=331 (0.57/d), rawDD 2223.
  Rolling 3m: 53 windows, pass 0%, bust 0%, positive 70%, median score 0.54, median net +$840. Lookahead clean. Quarterly: +162,-574,+1988,+1708,+112,-307,+1774,+750,+1257.
  (Dead params from abandoned legs remain in PARAMS but are disabled: DRIFT=0, CONT=0, FADE=0.)
- v2 (design data 2021-09..2024-06): combine_team ARISK multipliers. raw PF 1.19, 403 trades. x1: pass 0 (timeout 100%); x2 pass .41 bust .50 med 46d; x3 pass .46 bust .54 med 27d; x4 .39/.61; x6 .33/.67.
  Wider stops (AS .4/.6), later exits (11:00->12:00/13:00), AGTOL 0: best pass .46 / bust .52 (AS .4, x4). Nowhere pass>=40% with bust<=30%. Pass/bust ratio ~0.9 = edge too thin. Stopped; no data torturing.
