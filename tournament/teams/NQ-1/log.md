# NQ-1 log
- 2026-10-10 v0 defaults (K20 brk1 N10 rrmin1 cz1 risk60 maxstop8): train n=1021 PF0.88 WR27% net -6740 DD7755; rolling pos 19% bust 38%.
- levels mask/off added. Default-ish negative everywhere (PF .83-.94); limit AT level is adverse-selected (WR~26%). off=ATR offset of limit above level: off0 PF.94(maxstop4), off1 .94, off2 PF1.11 n390 DD1420 pos58%.
- Grid off/maxstop/rrmin: only off2/ms6 profitable (PF1.2) but neighbours lose = spike, rejected as overfit. Event study (fwd returns after raw reclaim, train): ~0 edge for all levels (+0.3..1pt, t<1.5); confluence no help. Counter-trend filter (reclaim against prior 390-bar move, tr=390 trs=-1) gives +1.4/2.2/2.3pt at 10/30/60 bars (t~2). Testing that.
- Fine grid around off2/ms6 shows PF 0.91-1.18 scattered (noise); frozen center-of-plateau-ish off=2, maxstop=7, rrmin=1.5, N=20: train n=1181 PF1.07 net+3704 DD2855; rolling bust 34%, pos 53%, pass 0%. lookahead_clean True.
- Counter-trend filter, minconf, max_day 1/2 all tested: no improvement (log of numbers: tr390 PF1.04; max_day1 PF1.05 DD2913).
- NOTE: shared scratchpad q.py was overwritten by another team mid-run; one accidental run executed it (printed only NQ-5 quarterly sums). Not used. Own helper now nq1_q.py.
- REWORK 2026-10-10: validate gate failed (PF .96). Added maxpts (absolute stop cap, skip trades), removed numba cache. Testing on train.
- Rework train: maxpts20 PF1.02 n249; 25 PF1.01; 30 PF1.06 n506 DD1815; 40 PF.94. maxpts30+max_day2: train n472 (0.81/d) PF1.11 net+1371 DD1605.
- Validation (first, accidentally unmodified params) PF.96. Rework validate (maxpts30,max_day2): n289 (0.75/d) PF1.16 net+1258 DD673; rolling pos 79% bust 0%, lookahead clean.
