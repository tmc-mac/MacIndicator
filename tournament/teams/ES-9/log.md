# ES-9 log (2026-10-10)
1. prereg.md written first.
2. Diagnostic (no trading): swing highs/lows (30-min, +-4 bars) per contract-aligned segment, Rayleigh test of price mod G.
   G=25: mean nR2 0.89 (null 1). G=50: 1.13. G=100: 4.6 (R~0.10, phase drifts 1..92 across segments, consistent w/ roll offsets).
   => only the 100-pt grid shows weak clustering; 25/50 grids none.
3. Oracle test (optimistic: phase per segment taken from the in-sample fit, NOT causal), 100-pt grid, RTH, 1 MES, 1 tick slip,
   rejection fade, 60-bar time exit: stop/tgt 6/10 PF1.03 n=1108 net+630; 10/10 PF1.08 net+1549 DD1056; 10/20 PF1.03.
   Breakout version (inverse): PF 0.74-0.75 (the mirror, i.e. same edge-cost).
   Even the oracle gives net ~$1.5k over 2.75 yrs at 1x: far below needed for pass in 60 sessions at any sane size.
4. Conclusion: no tradable edge; causal phase estimation (unknown per-contract offset) can only be worse. Stopped; no strategy certified.
