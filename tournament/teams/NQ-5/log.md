# NQ-5 research log (train only)
- v1 (prereg params): net -1048 PF 0.93 n=172 (0.29/d) maxDD 2743; rolling pos 40%, no busts. Too few trades, no edge.
- Sweeps (train, rules off). RR is the dominant knob: rr 2.0/3.0 -> PF 0.8-0.93 (net negative); rr 1.0 PF 1.2; rr 0.75 1.29;
  rr 0.6 1.51; 0.5 1.62; 0.4 1.75; 0.3 1.93 (WR 87%, but smaller net). Wide plateau 0.3-0.75; RR>=1.25 has no edge.
  Interpretation: the FVG retrace gets a quick bounce (scalp) but no follow-through.
- frac 5 too few trades (0.29/d); frac 3 best (frac2 similar, frac4 weak PF 1.02 at rr1). k_disp 0.7-1.3 at rr .5: PF 1.73/1.62/1.41 (more trades = better).
- Killzone 08:30-13:00 slightly more net (PF 1.64), 08:00 start worse (PF 1.43). Kept declared 08:30-11:00.
- risk$ 150/200/250 scales linearly: DD 790/1203/1416.
- Frozen: k_disp .85, frac 3, rr .5, risk 175. Train: net 14220 PF 1.67 n=587 (1.00/d) maxDD 933; rolling 53 windows
  pass 1.9%, bust 0%, positive 98%, median net 1579, median score 2.52. Quarterly net (risk 200) positive all 10 quarters.
- Note: the sweep-based rr deviation from prereg (rr 2.0 -> 0.5, frac 5 -> 3, k 1.5 -> .85) is data-driven after backtest 1 (v1 failed).
- v2 (design data 2021-09..2024-06), combine_team, min_stop 4: x1 pass .01; x2 pass .61/bust .05/med 57d; x3 .76/.23/39d; x4 .69/.31/27d; x6 .58/.42/15d.
- Slip 2 (E.combine slip=2): barely degrades (x2.5: .77->.74, x3 .76->.75) because entries are limit orders (slip only hits stop exits); raw PF 1.66->1.63.
- Larger rr (.75/1.0) is worse on pass/bust and not less friction sensitive; k_disp 1.2 fewer trades, worse pass. min_stop 8: x2.5 pass .73 bust .05 med49d; slip2 .72/.06/49d.
- Perturbation at x2.5 (min_stop 8; +/-20% of k_disp, rr, kz_end, kz_start, lookback, disp_win, max_stop, atr_n): pass range .56-.79, bust 0-.12; worst is disp_win 6 (.57). All >= .78x baseline.
