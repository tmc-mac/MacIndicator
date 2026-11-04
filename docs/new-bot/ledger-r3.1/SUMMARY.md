# Ledger summary (engine r3.1, in-sample, default cfg)

ledger.csv sha256 83537ea99e6866138f3a9c138239141dfbaee16890b2348d187e18e7ab56c0ea (20 signal rows, 44 GRADE_NO_TRADE rows)

| TradeDay | signals | A+ / B / C | taken-if-flat | GRADE_NO_TRADE | net R (all) | $ flat450 (all) | $ grade (all) |
|---|---|---|---|---|---|---|---|
| 2026-10-28 | 2 | 0 / 0 / 2 | 2 | 11 | +2.00 | +873 | +427 |
| 2026-10-29 | 4 | 0 / 1 / 3 | 4 | 10 | -0.00 | +12 | +250 |
| 2026-10-30 | 3 | 0 / 0 / 3 | 3 | 8 | +3.33 | +1348 | +951 |
| 2026-11-02 | 3 | 0 / 1 / 2 | 3 | 6 | +2.00 | +784 | +691 |
| 2026-11-03 | 7 | 0 / 3 / 4 | 7 | 9 | +0.33 | -110 | +79 |
| 2026-11-04 | 1 | 1 / 0 / 0 | 1 | 0 | +1.33 | +584 | +1166 |

Contracts at flat $450 (floor($450 / (stop pts x $2)), min 1): 1 MNQ x 1, 2 MNQ x 2, 4 MNQ x 4, 5 MNQ x 2, 6 MNQ x 2, 7 MNQ x 3, 8 MNQ x 2, 9 MNQ x 1, 10 MNQ x 1, 12 MNQ x 1, 16 MNQ x 1

GRADE_NO_TRADE failed gates: control4h 33, waveBias 29, laneTrigger 9

Other engine skips (SIGNAL_SKIP / RETEST_2_SKIP) in the TradeDays: RETEST_2_SKIP only the FIRST retest is traded (§13.7) 38, SIGNAL_SKIP OPEN_WAIT 17, SIGNAL_SKIP CLIMAX 4, SIGNAL_SKIP NEED_SHIFT 2
