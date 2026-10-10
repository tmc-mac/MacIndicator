# ES-3 research log (train 2021-09-27..2023-12-31, rules off unless noted)
- Prereg written first. Breakout of Asia range (buf .1, sk .5, tg 1.5): net -2607 PF .84 n=283 DD 3337. Fade mode: PF .88.
- Event study (555 sessions): sessions-direction correlations (Asia->London, London->NY, overnight position in range) all ~0;
  first break of Asia range: signed fwd 30/60m returns -0.3/-0.4 pt (tiny, below costs). Time-of-day drift: none stable.
- Breakout variants (buf .3/0, sk1, tg3, range filters, to 09:00): all PF .64-.94. No continuation edge.
- Fade grid (buf x sk x tg): noisy; wide-stop fades (sk 1.5-3) PF 1.10-1.27, consistent across tg; narrow stops negative.
  Edge is mostly time-exit drift (316 of 348 trades exit at 08:30, +$5 avg at 1 contract), stops 15 trades -1908, targets 17 +2480.
- Chosen: mode1 buf0 sk2 tg2 risk150: net 2500 PF 1.27 n=348 (0.61/d) maxDD 1068. Qtrly P&L
  [-24,115,279,754,1214,121,-185,-315,541]. Rolling: pass 0, bust 0, pos 65%, median net +143. lookahead_clean True.
- Sensitivity: t_exit 450/540/565 PF 1.07/1.15/1.20; t_end 240/420 PF 1.26/1.19; risk 300 PF 1.11 (DD 2326); buf .1 sk1.5 PF 1.02-1.05.
