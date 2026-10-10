# ES-6 research log (train 2021-09-27..2023-12-31)
- 2026-10-10 prereg.md written, strategy v0 coded exactly as prereg (continuation, K_IMP=3, MOC_K=12).
- v0 train: net -1119 PF 0.86 n=187 (0.33/d) DD 2445. By module: 08:30 cont PF1.22 n74 net+588; 10:00 cont PF0.64 n63; 14:00 cont PF0.41 n27; MOC PF1.77 n23 net+403. Too sparse (<0.5/d), 10:00/14:00 continuation loses -> suggests fade at those times.
- Fade variants all lose badly (PF 0.3-0.4). A-module continuation: 08:30 PF1.2 n74 only mildly positive, 10:00/14:00 negative, tgt/hold changes don't fix. MOC module (15:50 continuation of 14:30->15:50 move) positive on a plateau: k 4-10, stop 2-4R1: e.g. k4 stop4 PF1.48 n272 DD723 net+2606 roll pos .85; k8 stop4 PF2.14 n93. => drop 10:00/14:00 modules, focus on close window.
- k/stop sweep (risk 120): k1-3 x stop4-6 all PF 1.16-1.38, positive plateau; 0.58-0.84 tr/d. Chose moc_k=3, moc_stop=5 (>=0.5/d with margin). Risk 160: net+2594 PF1.34 n336 DD969; risk 200 DD1256 (too high).
- Diagnostics: 7/9 quarters positive (2023Q2,Q3 slightly neg); long +1463, short +404; DOW Tue/Wed flat, Mon/Thu/Fri positive - NOT filtered (overfit risk).
- FROZEN: use_a=False (release-impulse module dropped: noise/negative at 10:00,14:00; fade loses), MOC-only, risk 160.
