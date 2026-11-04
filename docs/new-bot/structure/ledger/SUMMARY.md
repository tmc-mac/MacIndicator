# Ledger summary (engine tide-structure-r3.2, in-sample, default cfg)

ledger.csv sha256 ba5183241482250072108dd015df2d9aefdfa24fa90b71488e7826ee24a97f37 (24 signal rows, 60 GRADE_NO_TRADE rows)

| TradeDay | signals | A+ / B / C | taken-if-flat | GRADE_NO_TRADE | net R (all) | $ flat450 (all) | $ grade (all) |
|---|---|---|---|---|---|---|---|
| 2026-10-28 | 2 | 0 / 0 / 2 | 2 | 17 | +2.00 | +873 | +427 |
| 2026-10-29 | 6 | 1 / 2 / 3 | 5 | 11 | -0.33 | -229 | +340 |
| 2026-10-30 | 3 | 0 / 0 / 3 | 3 | 7 | +4.00 | +1555 | +1107 |
| 2026-11-02 | 4 | 0 / 2 / 2 | 4 | 11 | +1.00 | +355 | +120 |
| 2026-11-03 | 8 | 0 / 3 / 5 | 7 | 14 | -0.67 | -399 | -210 |
| 2026-11-04 | 1 | 1 / 0 / 0 | 1 | 0 | +1.33 | +584 | +1166 |

Contracts at flat $450 (floor($450 / (stop pts x $2)), min 1): 1 MNQ x 2, 2 MNQ x 4, 3 MNQ x 2, 4 MNQ x 4, 5 MNQ x 2, 6 MNQ x 1, 7 MNQ x 3, 8 MNQ x 2, 9 MNQ x 1, 10 MNQ x 1, 12 MNQ x 1, 16 MNQ x 1

GRADE_NO_TRADE failed gates: waveBias 44, control4h 42, laneTrigger 13

Other engine skips (SIGNAL_SKIP / RETEST_2_SKIP) in the TradeDays: SIGNAL_SKIP OPEN_WAIT 14, SIGNAL_SKIP NEED_SHIFT 5, SIGNAL_SKIP CLIMAX 4

## Exits (see DIFF-r3.1.md)

- r3.2 taken (SESSION_CLOSE out): 22 signals (A+ 2 / B 6 / C 14): proxy 1R/2R +9.33R verbatim, +9.33R with the 13:05 flat; flat $450 proxy $+3434 verbatim, $+3434 with the 13:05 flat; REAL exit plan conservative $+3561 (+9.61R) / optimistic $+3988 (+10.68R), 7 trades with 7 ambiguous 1m bars
- r3.2 taken-if-flat: 22 signals (A+ 2 / B 6 / C 14): proxy 1R/2R +9.33R verbatim, +9.33R with the 13:05 flat; flat $450 proxy $+3434 verbatim, $+3434 with the 13:05 flat; REAL exit plan conservative $+3561 (+9.61R) / optimistic $+3988 (+10.68R), 7 trades with 7 ambiguous 1m bars
- SESSION_CLOSE (not taken): 10-29 12:58, 11-03 13:33
- TP1 r3.2: n 22, min 0.01R, median 0.73R, < 0.5R 8 (36%), < 1R 13 (59%); source 1R (no pool inside 1R) 9, opening range 9, 4H period extreme 3, 1H Open 1

## TP1 floor variants (small sample, n = 22)

| rule | n | $ flat450 cons / opt | R cons / opt | win / BE / loss (cons) | win / BE / loss (opt) | BE-stopped after TP1 cons / opt | median TP1 R | TP1 < 0.5R |
|---|---|---|---|---|---|---|---|---|
| (a) as now | 22 | +3561 / +3988 | +9.61 / +10.68 | 15 / 4 / 3 | 15 / 4 / 3 | 14 / 13 | 0.73 | 8 |
| (b) skip pools < 0.5R | 22 | +2853 / +3280 | +8.10 / +9.17 | 16 / 0 / 6 | 16 / 0 / 6 | 11 / 10 | 1.00 | 0 |
| (c-lib) pools < 1R dropped via partialFor (its 1R cap -> 1R) | 22 | +3250 / +3677 | +9.06 / +10.13 | 16 / 0 / 6 | 16 / 0 / 6 | 11 / 10 | 1.00 | 0 |
| (c) first pool at >= 1R before TP2, else 1R | 22 | +3838 / +3838 | +10.93 / +10.93 | 15 / 0 / 7 | 15 / 0 / 7 | 8 / 8 | 1.00 | 0 |
