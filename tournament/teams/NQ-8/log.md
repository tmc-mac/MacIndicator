# NQ-8 log (design window only)
- Coarse grid N{60,120,240} x stop_atr{5,8,12} x tgt_r{1.5,3,6}: raw PF 1.13-1.33 everywhere, maxDD $2.7-5.5k at base size (plateau for raw edge).
- Base N=90 stop_atr=8 tgt_r=3 minw=10 risk=200: combine x2 pass .44/bust .35; x2.5 .59/.38; x4 .41/.59. Bust never <=25% when pass>=50%.
- Variants (max_day, windows, N=60, tgt 4) similar; none meets pass>=40 & bust<=30 robustly except isolated minw=14 (x2.5: .54/.16).
- minw 12/14/16 at x2.5: .56/.37, .54/.16, .17/.17 -> spike, not plateau => overfit; not adopted.
