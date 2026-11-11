# A - Loss anatomy: why losses are ~4x wins, and which exit rule would shrink them

Desk A, 2026-11-11. Source: live trade journal (11/09 full journal + the 11/10 and 11/11 slices from the team line), rebuilt with the audit `build.py`: **399 closed trades** (379 to 11/04 + 20 new on TradeDays 11/10-11/11). Scripts: `edge/a/` (merge.py, bars.py, load.py, analyze.py, extra.py, vol.py). Nothing here was run on the replay rig.

## Headline

1. **The 4x is the stop distance divided by a capped win, not a leak in the exits.** A TP1 win is 2 x 15 + a runner that exits at a median +9.75 (n=45; only 8 runners beat +15) = about +$78-84. A full stop is 3 x (30 to 50) pts = -$182 to -$304. On the current rule set (CORE, n=60) that is 36 TP1 wins at +$84, 17 no-progress exits at -$51, 7 full stops at -$261: win rate 67%, break-even 64%, expectancy +$5.6/trade (+1.3 pts/contract). Full stops are 64% of CORE's losing dollars, no-progress exits 36%.
2. **Full stops are trades that never worked, and they are over inside the first 5m candle.** Focus full stops n=19 (small): median MFE before the stop +0.75, median 3.7 min from fill to stop, all 19 inside 10 min. Only 4 had been +8 or more, 2 had been +10 or more, 1 had been +12 or more (and 2 of those 4 are single-bar trades whose MFE may pre-date the fill). So a protect-after-MFE rule has almost nothing to act on: over 86 evaluable focus trades every break-even or -5 variant loses money under stop-first ordering (for example +10 / entry-5: -$1,110, 95% CI [-2,196, -20], 14 winners killed for 2 full stops saved). The least-bad cell, +10 / entry-15, is +$187 [-346, +820].
3. **Tightening the stop is what made the losses pile up; volatility is where they sit.** The 25-pt stop stamps (S25, 11/03-11/04, n=28) had 12 full stops in 28 trades against 7 in 60 on the 30/50 stop, and -$38.6/trade against +$5.6 (difference $44/trade, CI [-9, +93], different days). Re-walked with the session stop, 3 of those 12 reach TP1 and 4 become small no-progress exits (+$688 in total). By volatility at entry (66 trades with a measure): the top tercile holds 11 of 16 full stops and runs -$52/trade; the low tercile has 1 full stop and +$14/trade. NY winners need room: MAE p90 31 pts, 2 of 13 needed more than 25.

**What does not hold up:** TP1 at +10 or +12 (focus +$205 [-734, +1,378] and +$37 [-532, +836]; it loses in NY, -$310 [-428, -200], n=21, because NY winners go on to +15); skipping entries in the last minute of a 15m candle (focus 4 trades, all full stops, +$787 [152, 1,693], but on 10/27-10/30 the same filter removes 5 winners and no full stop: -$468).

**The one rule I would test first (in log-only mode before live):** an adverse-move early exit - at the 2-minute close, if the trade is at -10 or worse and has never been seen at +3, close it. Focus: 9 trades changed, 0 winners killed, 5 full stops cut, +$663, 95% CI [0, +1,532]; CORE +$609 [-96, +1,470], positive in both halves. It is one cell of a 9-cell grid, its CI touches zero, and it loses on the 10/27-10/30 cohort (-$262 [-757, +169]), so it has not earned a live switch yet. It is also a form of tightening, which the standing rule forbids; that is Mac's call.

## Cohorts and data limits

- **Focus = TradeDay 11/02 onward, n=88.** These stamps all run levels-only r13.3.5 with `noProgressExit` on, `tp1FromFill` on and TP1 +15, 3 contracts. The stamp settings show two stop regimes inside it, so they are reported apart: **CORE** (n=60; stop floor 30 Asia/London, 50 NY, cap 50: 11/02, early 11/03, 11/10, 11/11) and **S25** (n=28; floor and cap 25: stamps 27338e and b2d99d, 11/03 07:56 PT to 11/04).
- Older cohorts, reported separately: 10/27-10/30 np-on stamps (n=88, TP1 +20 then +15, other entry rules) and everything before 10/27 (n=223).
- **Paths.** 68 focus trades walk on 1m high/low bars (11/02-11/04, the rig's bar files). The 18 trades of 11/10-11/11 have no 1m bars here, so they walk on the journal `trade_state` rows (1m, cumulative best/worst), which is coarser. 2 focus trades have no path. In the entry bar only the post-fill part counts (from the `trade_state` k=0 row where present).
- The ledger `mfe`/`mae` fields come from ~20 s polls and under-read (TP1 trades show mfe 0), so every MFE/MAE below is from the path.
- Fees check: ledger `fees` = $2.16 per 3-contract trade = $0.72 per contract round trip.
- No test here is a controlled experiment. All n are small; every CI is a trade-resampling bootstrap and ignores day clustering (most of the sample is 4 trading days).

## 1. Payoff math

Focus = stamps from TradeDay 11/02 on (levels-only r13.3.5 family, no-progress exit on, TP1 +15 from fill, 3 contracts). CORE = the current stop rule (30 Asia/London, 50 NY, cap 50): 11/02, early 11/03, 11/10, 11/11. S25 = the two 11/03-11/04 stamps that ran a 25-pt stop floor/cap (27338e, b2d99d), kept apart because the stop differs.

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| FOCUS all | 88 | 59% | 78.10 | -133.41 | 1.71 | -8.43 | -1.04 | 63% | -741.58 |
| CORE (current stop) | 60 | 67% | 79.52 | -142.11 | 1.79 | 5.64 | 1.30 | 64% | 338.40 |
| S25 (25-pt stop) | 28 | 43% | 73.38 | -122.53 | 1.67 | -38.57 | -6.07 | 63% | -1079.98 |
| focus 1st half (11-01..11-03) | 44 | 64% | 80.45 | -129.38 | 1.61 | 4.15 | 1.05 | 62% | 182.46 |
| focus 2nd half (11-03..11-10) | 44 | 55% | 75.36 | -136.63 | 1.81 | -21.00 | -3.14 | 64% | -924.04 |
| CORE 1st half (11-01..11-02) | 30 | 73% | 78.57 | -109.60 | 1.39 | 28.39 | 5.09 | 58% | 851.70 |
| CORE 2nd half (11-02..11-10) | 30 | 60% | 80.67 | -163.78 | 2.03 | -17.11 | -2.49 | 67% | -513.30 |
| older: 10/27-10/30 np-on stamps | 88 | 61% | 83.08 | -135.48 | 1.63 | -1.36 | -0.47 | 62% | -119.90 |
| older: before 10/27 | 223 | 49% | 178.39 | -225.45 | 1.26 | -26.25 | -2.85 | 56% | -5852.98 |

**CORE by exit type**

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| full-stop | 7 (small) | 0% | 0.00 | -260.80 | 0.00 | -260.80 | -43.11 | 100% | -1825.62 |
| no-progress-exit | 17 (small) | 24% | 38.72 | -78.20 | 2.02 | -50.69 | -8.09 | 67% | -861.72 |
| tp1-then-runner | 36 | 100% | 84.05 | 0.00 | -0.00 | 84.05 | 14.37 | -0% | 3025.74 |

**CORE by session**

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| Asia | 35 | 60% | 80.36 | -150.34 | 1.87 | -11.92 | -1.63 | 65% | -417.10 |
| London | 12 (small) | 67% | 65.34 | -32.91 | 0.50 | 32.59 | 5.79 | 33% | 391.08 |
| NY | 13 (small) | 85% | 88.20 | -302.91 | 3.43 | 28.03 | 5.03 | 77% | 364.42 |

**S25 by exit type**

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| full-stop | 12 (small) | 0% | 0.00 | -154.66 | 0.00 | -154.66 | -25.42 | 100% | -1855.92 |
| no-progress-exit | 7 (small) | 43% | 41.84 | -26.16 | 0.63 | 2.98 | 0.86 | 38% | 20.88 |
| tp1-then-runner | 9 (small) | 100% | 83.90 | 0.00 | -0.00 | 83.90 | 14.34 | -0% | 755.06 |

**S25 by session**

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| Asia | 7 (small) | 43% | 76.84 | -155.16 | 2.02 | -55.73 | -8.93 | 67% | -390.12 |
| London | 13 (small) | 46% | 72.92 | -81.23 | 1.11 | -10.08 | -1.32 | 53% | -131.08 |
| NY | 8 (small) | 38% | 70.84 | -154.26 | 2.18 | -69.85 | -11.28 | 69% | -558.78 |

**older 10/27-10/30 by exit type**

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| full-stop | 13 (small) | 0% | 0.00 | -235.14 | 0.00 | -235.14 | -40.77 | 100% | -3056.86 |
| no-progress-exit | 32 | 34% | 34.11 | -73.78 | 2.16 | -36.69 | -8.43 | 68% | -1174.14 |
| tp1-then-runner | 43 | 100% | 95.61 | 0.00 | -0.00 | 95.61 | 17.64 | -0% | 4111.10 |

**older 10/27-10/30 by session**

| group | n | win% | avg win $ | avg loss $ | loss/win | exp $/trade | exp pts/contract | break-even win% | total net $ |
|---|---|---|---|---|---|---|---|---|---|
| Asia | 33 | 58% | 84.47 | -105.86 | 1.25 | 3.72 | 1.96 | 56% | 122.92 |
| London | 31 | 71% | 80.82 | -139.83 | 1.73 | 16.76 | 2.66 | 63% | 519.48 |
| NY | 24 | 54% | 84.87 | -169.61 | 2.00 | -31.76 | -7.84 | 67% | -762.30 |

- CORE: gross losing dollars -2842; full stops -1826 (64%), losing no-progress exits -1017 (36%).
- S25: gross losing dollars -1961; full stops -1856 (95%), losing no-progress exits -105 (5%).
- FOCUS: gross losing dollars -4803; full stops -3682 (77%), losing no-progress exits -1121 (23%).

## 2. Full-stop anatomy (focus cohort)

| entry PT | cohort | session | dir | level | event | control | stop pts | MFE before stop | min fill->stop | min to 15m | min to 1H | min to 4H | net $ | path |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 11-02 10:00:59 | core | NY | S | PWC | SWEEP-LOSS | -0.34 | 50 | 0.75 | 5.7 | 14 | 59 | 59 | -303.66 | bars |
| 11-02 12:15:11 | core | NY | S | 1H Open | SWEEP-LOSS | -0.33 | 50.00 | 0 | 5.6 | 15 | 45 | 165 | -302.16 | bars |
| 11-02 15:14:06 | core | Asia | S | Daily Open | SWEEP-LOSS | -0.22 | 49 | 0 | 5.0 | 1 | 46 | 226 | -299.16 | bars |
| 11-02 16:15:15 | core | Asia | S | 30m Open | SWEEP-LOSS | -0.37 | 30.00 | 1.75 | 5.6 | 15 | 45 | 165 | -191.16 | bars |
| 11-02 21:14:38 | core | Asia | S | 30m Open | SWEEP-LOSS | -0.25 | 30.00 | 0.25 | 4.7 | 0 | 45 | 105 | -182.16 | bars |
| 11-03 04:11:53 | s25 | London | S | VWAP | SWEEP-LOSS | -0.23 | 25.00 | 5.25 | 2.4 | 3 | 48 | 168 | -153.66 | bars |
| 11-03 05:40:38 | s25 | London | L | PML | SWEEP-RECLAIM | 0.34 | 25.00 | 0 | 1.4 | 4 | 19 | 79 | -155.16 | bars |
| 11-03 06:12:31 | s25 | London | L | 1H Open | SWEEP-RECLAIM | 0.35 | 25 | 3.50 | 5.6 | 2 | 47 | 47 | -155.16 | bars |
| 11-03 07:10:11 | s25 | NY | L | Asia High | SWEEP-RECLAIM | 0.35 | 25.00 | 0 | 1.2 | 5 | 50 | 230 | -158.16 | bars |
| 11-03 09:10:18 | s25 | NY | L | 30m Open | SWEEP-RECLAIM | 0.39 | 25 | 1.25 | 6.5 | 5 | 50 | 110 | -153.66 | bars |
| 11-03 09:29:40 | s25 | NY | L | IB High | SWEEP-RECLAIM | 0.39 | 25.00 | 0.50 | 3.7 | 0 | 30 | 90 | -153.66 | bars |
| 11-03 10:44:47 | s25 | NY | L | 30m Open | SWEEP-RECLAIM | 0.23 | 25.00 | 2.25 | 3.7 | 0 | 15 | 15 | -152.16 | bars |
| 11-03 12:06:23 | s25 | NY | S | 15m Open | SWEEP-LOSS | -0.22 | 25.00 | 0 | 1.5 | 9 | 54 | 174 | -153.66 | bars |
| 11-03 17:01:12 | s25 | Asia | S | 30m Open | SWEEP-LOSS | -0.30 | 25.00 | 9.75 | 0.5 | 14 | 59 | 119 | -153.66 | bars |
| 11-03 18:55:45 | s25 | Asia | S | 15m Open | SWEEP-LOSS | -0.33 | 25 | 8.25 | 0.5 | 4 | 4 | 4 | -153.66 | bars |
| 11-03 19:45:08 | s25 | Asia | S | 4H Open | SWEEP-LOSS | -0.30 | 25.00 | 0 | 1.6 | 15 | 15 | 195 | -161.16 | bars |
| 11-03 20:01:39 | s25 | Asia | S | 4H Open | SWEEP-LOSS | -0.24 | 25.00 | 0 | 0.7 | 13 | 58 | 178 | -152.16 | bars |
| 11-09 20:10:15 | core | Asia | S | 1H Open | SWEEP-LOSS | -0.33 | 40.25 | 15 | 9.8 | 5 | 50 | 170 | -252.66 | state |
| 11-09 23:57:40 | core | Asia | S | 15m Open | SWEEP-LOSS | -0.25 | 48.50 | 11.75 | 4.3 | 2 | 2 | 182 | -294.66 | state |

4H boundaries assumed at 03/07/11/15/19/23 PT (session-anchored 4H bars). MFE is from the 1m path (bars = 1m high/low, state = journal trade_state rows), not the ledger `mfe` field, which is a ~20 s poll and under-reads.

- all focus full stops n=19 (small): MFE first >=+8: 4, >=+10: 2, >=+12: 1; median MFE 0.75; median min to stop 3.7; stopped within 10 min: 19; avg net $-194.
- CORE full stops n=7 (small): MFE first >=+8: 2, >=+10: 2, >=+12: 1; median MFE 0.75; median min to stop 5.6; stopped within 10 min: 7; avg net $-261.
- S25 full stops n=12 (small): MFE first >=+8: 2, >=+10: 0, >=+12: 0; median MFE 0.88; median min to stop 1.6; stopped within 10 min: 12; avg net $-155.

| focus group | n | entry <=3 min before 15m close | <=5 min before 1H close | <=10 min before 1H close | <=15 min before 4H close |
|---|---|---|---|---|---|
| full stops | 19 | 6 | 2 | 2 | 1 |
| TP1 winners | 45 | 4 | 3 | 7 | 3 |
| no-progress exits | 24 | 0 | 1 | 2 | 1 |

| session | focus trades | full stops | full-stop rate |
|---|---|---|---|
| Asia | 42 | 9 | 21% |
| London | 25 | 3 | 12% |
| NY | 21 | 7 | 33% |

| level | focus trades | full stops | full-stop rate |
|---|---|---|---|
| 30m Open | 18 | 5 | 28% |
| 1H Open | 16 | 3 | 19% |
| 15m Open | 16 | 3 | 19% |
| 4H Open | 8 | 2 | 25% |
| PML | 8 | 1 | 12% |
| VWAP | 5 | 1 | 20% |
| QL | 5 | 0 | 0% |
| 06:30 Open | 3 | 0 | 0% |
| Daily Open | 3 | 1 | 33% |
| London Low | 2 | 0 | 0% |
| PWC | 1 | 1 | 100% |
| CMO | 1 | 0 | 0% |
| Asia High | 1 | 1 | 100% |
| IB High | 1 | 1 | 100% |

| event | focus trades | full stops | full-stop rate |
|---|---|---|---|
| SWEEP-LOSS | 46 | 13 | 28% |
| SWEEP-RECLAIM | 42 | 6 | 14% |

| control score in trade direction | focus trades | full stops | rate |
|---|---|---|---|
| 0.22-0.4 | 86 | 19 | 22% |
| >=0.4 | 2 | 0 | 0% |

## 3. Protect-after-MFE counterfactual

Rule: once the trade has been seen at +X, the stop moves to entry -Y. Walked on each trade's real path up to its TP1 fill or real exit: 68 trades on 1m bars (11/02-11/04), 18 on journal trade_state rows (11/10-11/11, no 1m bars held for those days), 2 not evaluable (no path). New-stop fills priced at -Y minus 0.25 pts slip (median slip of the real full stops, n=19) on all 3 contracts, fees $2.16.

Two in-bar orderings. PESSIMISTIC (headline, stop-first): if the trigger bar also trades to the new stop, a trade that really won is counted as killed and a trade that really lost is counted as NOT saved in that bar. NEUTRAL: in that bar the order is taken from the bar colour (favourable close => low came first).

**Focus (CORE+S25), pessimistic ordering**

| X | new stop | n | changed | winners killed | full stops saved | np exits changed | net $ change | 95% CI (bootstrap) | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| +8 | -0 | 86 | 38 | 29 | 2 | 7 | -1804.50 | [-2954, -620] | -3.50 | -1547.00 | -257.50 |
| +8 | -5 | 86 | 23 | 16 | 2 | 5 | -1331.00 | [-2437, -227] | -2.58 | -952.50 | -378.50 |
| +8 | -10 | 86 | 9 | 5 | 2 | 2 | -280.50 | [-1164, 629] | -0.54 | -447.50 | 167.00 |
| +8 | -15 | 86 | 6 | 3 | 2 | 1 | -173.00 | [-927, 602] | -0.34 | -361.50 | 188.50 |
| +10 | -0 | 86 | 29 | 21 | 2 | 6 | -1122.00 | [-2180, 46] | -2.17 | -1040.50 | -81.50 |
| +10 | -5 | 86 | 21 | 14 | 2 | 5 | -1110.50 | [-2196, -20] | -2.15 | -842.00 | -268.50 |
| +10 | -10 | 86 | 8 | 4 | 2 | 2 | -140.50 | [-926, 727] | -0.27 | -447.50 | 307.00 |
| +10 | -15 | 86 | 4 | 1 | 2 | 1 | 187.00 | [-346, 820] | 0.36 | -171.50 | 358.50 |
| +12 | -0 | 86 | 21 | 18 | 1 | 2 | -1259.00 | [-2095, -364] | -2.44 | -969.50 | -289.50 |
| +12 | -5 | 86 | 15 | 12 | 1 | 2 | -1210.50 | [-2172, -298] | -2.35 | -651.00 | -559.50 |
| +12 | -10 | 86 | 5 | 3 | 1 | 1 | -225.50 | [-849, 426] | -0.44 | -301.50 | 76.00 |
| +12 | -15 | 86 | 3 | 1 | 1 | 1 | -14.00 | [-514, 474] | -0.03 | -171.50 | 157.50 |

**Focus (CORE+S25), neutral ordering**

| X | new stop | n | changed | winners killed | full stops saved | np exits changed | net $ change | 95% CI (bootstrap) | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| +8 | -0 | 86 | 19 | 8 | 4 | 7 | 296.50 | [-696, 1401] | 0.57 | -535.50 | 832.00 |
| +8 | -5 | 86 | 13 | 4 | 4 | 5 | 319.00 | [-542, 1282] | 0.62 | -379.50 | 698.50 |
| +8 | -10 | 86 | 9 | 3 | 4 | 2 | 202.00 | [-584, 1050] | 0.39 | -286.50 | 488.50 |
| +8 | -15 | 86 | 8 | 3 | 4 | 1 | -53.00 | [-865, 758] | -0.10 | -361.50 | 308.50 |
| +10 | -0 | 86 | 11 | 3 | 2 | 6 | 454.50 | [-298, 1384] | 0.88 | -172.50 | 627.00 |
| +10 | -5 | 86 | 9 | 2 | 2 | 5 | 319.00 | [-370, 1152] | 0.62 | -249.50 | 568.50 |
| +10 | -10 | 86 | 5 | 1 | 2 | 2 | 322.00 | [-254, 1029] | 0.62 | -126.50 | 448.50 |
| +10 | -15 | 86 | 4 | 1 | 2 | 1 | 187.00 | [-346, 820] | 0.36 | -171.50 | 358.50 |
| +12 | -0 | 86 | 5 | 2 | 1 | 2 | 135.00 | [-326, 794] | 0.26 | -202.50 | 337.50 |
| +12 | -5 | 86 | 4 | 1 | 1 | 2 | 88.00 | [-379, 657] | 0.17 | -189.50 | 277.50 |
| +12 | -10 | 86 | 3 | 1 | 1 | 1 | 76.00 | [-320, 596] | 0.15 | -141.50 | 217.50 |
| +12 | -15 | 86 | 3 | 1 | 1 | 1 | -14.00 | [-514, 474] | -0.03 | -171.50 | 157.50 |

**CORE only, pessimistic**

| X | new stop | n | changed | winners killed | full stops saved | np exits changed | net $ change | 95% CI (bootstrap) | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| +8 | -0 | 58 | 26 | 20 | 2 | 4 | -1000.00 | [-1988, 138] | -2.87 | -1257.50 | 257.50 |
| +8 | -5 | 58 | 15 | 9 | 2 | 4 | -525.50 | [-1455, 470] | -1.51 | -866.50 | 341.00 |
| +8 | -10 | 58 | 8 | 4 | 2 | 2 | -140.50 | [-982, 694] | -0.40 | -301.50 | 161.00 |
| +8 | -15 | 58 | 5 | 2 | 2 | 1 | -3.00 | [-732, 720] | -0.01 | -361.50 | 358.50 |
| +10 | -0 | 58 | 20 | 14 | 2 | 4 | -493.50 | [-1404, 606] | -1.42 | -933.00 | 439.50 |
| +10 | -5 | 58 | 14 | 8 | 2 | 4 | -415.00 | [-1314, 566] | -1.19 | -756.00 | 341.00 |
| +10 | -10 | 58 | 8 | 4 | 2 | 2 | -140.50 | [-982, 694] | -0.40 | -301.50 | 161.00 |
| +10 | -15 | 58 | 4 | 1 | 2 | 1 | 187.00 | [-356, 834] | 0.54 | -171.50 | 358.50 |
| +12 | -0 | 58 | 14 | 11 | 1 | 2 | -632.00 | [-1310, 204] | -1.82 | -888.00 | 256.00 |
| +12 | -5 | 58 | 9 | 6 | 1 | 2 | -485.00 | [-1184, 232] | -1.39 | -651.00 | 166.00 |
| +12 | -10 | 58 | 5 | 3 | 1 | 1 | -225.50 | [-858, 406] | -0.65 | -301.50 | 76.00 |
| +12 | -15 | 58 | 3 | 1 | 1 | 1 | -14.00 | [-516, 474] | -0.04 | -171.50 | 157.50 |

**S25 only, pessimistic**

| X | new stop | n | changed | winners killed | full stops saved | np exits changed | net $ change | 95% CI (bootstrap) | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| +8 | -0 | 28 | 12 | 9 | 0 | 3 | -804.50 | [-1262, -359] | -4.79 | -339.50 | -465.00 |
| +8 | -5 | 28 | 8 | 7 | 0 | 1 | -805.50 | [-1349, -282] | -4.79 | -252.00 | -553.50 |
| +8 | -10 | 28 | 1 | 1 | 0 | 0 | -140.00 | [-420, 0] | -0.83 | 0.00 | -140.00 |
| +8 | -15 | 28 | 1 | 1 | 0 | 0 | -170.00 | [-510, 0] | -1.01 | 0.00 | -170.00 |
| +10 | -0 | 28 | 9 | 7 | 0 | 2 | -628.50 | [-1092, -186] | -3.74 | -243.50 | -385.00 |
| +10 | -5 | 28 | 7 | 6 | 0 | 1 | -695.50 | [-1236, -192] | -4.14 | -252.00 | -443.50 |
| +10 | -10 | 28 | 0 | 0 | 0 | 0 | 0.00 | [0, 0] | 0.00 | 0.00 | 0.00 |
| +10 | -15 | 28 | 0 | 0 | 0 | 0 | 0.00 | [0, 0] | 0.00 | 0.00 | 0.00 |
| +12 | -0 | 28 | 7 | 7 | 0 | 0 | -627.00 | [-1034, -243] | -3.73 | -303.50 | -323.50 |
| +12 | -5 | 28 | 6 | 6 | 0 | 0 | -725.50 | [-1280, -222] | -4.32 | -282.00 | -443.50 |
| +12 | -10 | 28 | 0 | 0 | 0 | 0 | 0.00 | [0, 0] | 0.00 | 0.00 | 0.00 |
| +12 | -15 | 28 | 0 | 0 | 0 | 0 | 0.00 | [0, 0] | 0.00 | 0.00 | 0.00 |

**Older cohort 10/27-10/30 (np-on stamps; different TP1/stop rules), pessimistic, 88 of 88 evaluable**

| X | new stop | n | changed | winners killed | full stops saved | np exits changed | net $ change | 95% CI (bootstrap) | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| +8 | -0 | 88 | 55 | 34 | 8 | 13 | -1361.36 | [-3121, 609] | -2.58 | 78.90 | -1440.26 |
| +8 | -5 | 88 | 33 | 15 | 8 | 10 | -465.32 | [-2026, 1174] | -0.88 | 117.62 | -582.94 |
| +8 | -10 | 88 | 22 | 8 | 8 | 6 | 9.18 | [-1377, 1450] | 0.02 | 134.12 | -124.94 |
| +8 | -15 | 88 | 16 | 3 | 8 | 5 | 390.12 | [-737, 1494] | 0.74 | 261.84 | 128.28 |
| +10 | -0 | 88 | 41 | 30 | 7 | 4 | -1246.70 | [-2828, 620] | -2.36 | -80.44 | -1166.26 |
| +10 | -5 | 88 | 24 | 14 | 7 | 3 | -416.66 | [-1856, 1118] | -0.79 | -99.22 | -317.44 |
| +10 | -10 | 88 | 16 | 7 | 7 | 2 | 78.34 | [-1122, 1425] | 0.15 | 22.28 | 56.06 |
| +10 | -15 | 88 | 12 | 3 | 7 | 2 | 284.28 | [-796, 1358] | 0.54 | 156.00 | 128.28 |
| +12 | -0 | 88 | 38 | 28 | 7 | 3 | -1002.70 | [-2560, 832] | -1.90 | -80.44 | -922.26 |
| +12 | -5 | 88 | 23 | 13 | 7 | 3 | -285.16 | [-1675, 1268] | -0.54 | -99.22 | -185.94 |
| +12 | -10 | 88 | 16 | 7 | 7 | 2 | 78.34 | [-1122, 1425] | 0.15 | 22.28 | 56.06 |
| +12 | -15 | 88 | 12 | 3 | 7 | 2 | 284.28 | [-796, 1358] | 0.54 | 156.00 | 128.28 |

12 cells per table, 5 tables: read the whole grid, not the best cell. No cell was selected before looking.

## 4. MAE of winners (information only: the standing rule is "keep the accurate stop, never tighten")

| TP1 winners | n | MAE p50 | p75 | p90 (stop keeping 90%) | p95 (stop keeping 95%) | max | kept by 10 | kept by 15 | kept by 20 | kept by 25 |
|---|---|---|---|---|---|---|---|---|---|---|
| focus all | 43 | 5.50 | 11.25 | 16.60 | 20.47 | 44.75 | 31 | 38 | 40 | 41 |
| Asia | 21 | 4.50 | 7.75 | 12.50 | 17.00 | 20.75 | 17 | 19 | 20 | 21 |
| London | 9 (small) | 5.25 | 10.00 | 11.35 | 12.05 | 12.75 | 7 | 9 | 9 | 9 |
| NY | 13 (small) | 6.25 | 15.00 | 31.40 | 38.75 | 44.75 | 7 | 10 | 11 | 11 |
| CORE | 34 | 5.25 | 11.12 | 16.17 | 23.86 | 44.75 | 25 | 30 | 32 | 32 |
| S25 | 9 (small) | 5.50 | 11.00 | 16.15 | 18.45 | 20.75 | 6 | 8 | 8 | 9 |

MAE = worst adverse excursion before the TP1 fill, 1m path (TP1-bar low counted as before TP1, so it leans high). Survivorship: these are winners under the stop each trade actually had; S25 winners could not show MAE beyond 25.

**Adverse-move early exit**: at the first 1m close at or after N minutes from the fill, if the close is at or below -Z and the trade has not been seen at +3, close all 3 at that close minus 0.25 slip.

**Focus (CORE+S25)**

| Z | N min | n | changed | winners killed | full stops cut | np exits changed | net $ change | 95% CI | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| -5 | 1 | 86 | 22 | 5 | 9 | 8 | 335.50 | [-1030, 1692] | 0.65 | 495.00 | -159.50 |
| -5 | 2 | 86 | 18 | 1 | 7 | 10 | 489.50 | [-451, 1469] | 0.95 | 799.50 | -310.00 |
| -5 | 3 | 86 | 16 | 0 | 7 | 9 | 385.50 | [-466, 1366] | 0.75 | 693.00 | -307.50 |
| -10 | 1 | 86 | 8 | 1 | 5 | 2 | 313.00 | [-591, 1203] | 0.61 | 247.00 | 66.00 |
| -10 | 2 | 86 | 9 | 0 | 5 | 4 | 663.00 | [0, 1532] | 1.28 | 697.50 | -34.50 |
| -10 | 3 | 86 | 11 | 0 | 6 | 5 | 141.00 | [-528, 839] | 0.27 | 381.00 | -240.00 |
| -15 | 1 | 86 | 5 | 1 | 4 | 0 | 124.00 | [-732, 858] | 0.24 | 85.00 | 39.00 |
| -15 | 2 | 86 | 6 | 0 | 4 | 2 | 405.00 | [-187, 1095] | 0.78 | 498.00 | -93.00 |
| -15 | 3 | 86 | 10 | 0 | 5 | 5 | -67.50 | [-662, 446] | -0.13 | 172.50 | -240.00 |

**CORE only**

| Z | N min | n | changed | winners killed | full stops cut | np exits changed | net $ change | 95% CI | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| -5 | 1 | 58 | 15 | 3 | 6 | 6 | 560.00 | [-566, 1828] | 1.61 | 243.50 | 316.50 |
| -5 | 2 | 58 | 14 | 0 | 5 | 9 | 615.00 | [-168, 1550] | 1.77 | 312.00 | 303.00 |
| -5 | 3 | 58 | 14 | 0 | 5 | 9 | 289.50 | [-526, 1270] | 0.83 | 199.50 | 90.00 |
| -10 | 1 | 58 | 6 | 1 | 3 | 2 | 187.00 | [-669, 1063] | 0.54 | 144.00 | 43.00 |
| -10 | 2 | 58 | 8 | 0 | 4 | 4 | 609.00 | [-96, 1470] | 1.75 | 355.50 | 253.50 |
| -10 | 3 | 58 | 9 | 0 | 4 | 5 | 45.00 | [-632, 752] | 0.13 | 9.00 | 36.00 |
| -15 | 1 | 58 | 4 | 1 | 3 | 0 | 85.00 | [-711, 841] | 0.24 | 144.00 | -59.00 |
| -15 | 2 | 58 | 5 | 0 | 3 | 2 | 351.00 | [-231, 1042] | 1.01 | 373.50 | -22.50 |
| -15 | 3 | 58 | 8 | 0 | 3 | 5 | -163.50 | [-758, 330] | -0.47 | 9.00 | -172.50 |

**Older 10/27-10/30**

| Z | N min | n | changed | winners killed | full stops cut | np exits changed | net $ change | 95% CI | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| -5 | 1 | 88 | 14 | 3 | 3 | 8 | -298.88 | [-1086, 574] | -0.57 | -324.94 | 26.06 |
| -5 | 2 | 88 | 11 | 0 | 2 | 9 | -128.16 | [-696, 377] | -0.24 | -278.44 | 150.28 |
| -5 | 3 | 88 | 12 | 0 | 2 | 10 | -167.16 | [-682, 317] | -0.32 | -308.44 | 141.28 |
| -10 | 1 | 88 | 8 | 1 | 2 | 5 | -259.88 | [-802, 273] | -0.49 | -285.94 | 26.06 |
| -10 | 2 | 88 | 9 | 0 | 1 | 8 | -261.66 | [-757, 169] | -0.50 | -287.44 | 25.78 |
| -10 | 3 | 88 | 9 | 0 | 2 | 7 | -146.44 | [-622, 315] | -0.28 | -245.44 | 99.00 |
| -15 | 1 | 88 | 5 | 0 | 1 | 4 | -147.66 | [-505, 198] | -0.28 | -183.94 | 36.28 |
| -15 | 2 | 88 | 6 | 0 | 1 | 5 | -275.44 | [-743, 107] | -0.52 | -294.94 | 19.50 |
| -15 | 3 | 88 | 5 | 0 | 1 | 4 | -66.22 | [-395, 235] | -0.13 | -63.22 | -3.00 |

9 cells x 3 tables = 27 looks. With this n, one or two cells will look good by chance; a cell counts only if its neighbours and both halves agree.

## 5. TP1 distance

| cohort | n evaluable | did not reach TP1 | peaked +10..+14.75 | ...and lost | their net $ | peaked +12..+14.75 | peaked +8..+9.75 |
|---|---|---|---|---|---|---|---|
| focus | 86 | 43 | 11 | 6 | -326.76 | 6 | 3 |
| CORE | 58 | 24 | 7 | 4 | -372.12 | 4 | 0 |
| S25 | 28 | 19 | 4 | 2 | 45.36 | 2 | 3 |
| older 10/27-10/30 | 88 | 45 | 10 | 4 | -365.88 | 7 | 9 |

| cohort | TP1 | n | real TP1 winners (give up pts) | losers/np converted | $ given up on winners | $ gained on converted | net $ change vs +15 | 95% CI | pts/contract per trade | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| focus | +10 | 86 | 43 | 12 | -949.00 | 1153.50 | 204.50 | [-734, 1378] | 0.40 | -346.50 | 551.00 |
| focus | +12 | 86 | 43 | 7 | -541.50 | 578.00 | 36.50 | [-532, 836] | 0.07 | -269.00 | 305.50 |
| CORE | +10 | 58 | 34 | 8 | -759.00 | 1007.50 | 248.50 | [-662, 1384] | 0.71 | -295.00 | 543.50 |
| CORE | +12 | 58 | 34 | 5 | -427.50 | 511.00 | 83.50 | [-460, 962] | 0.24 | -180.50 | 264.00 |
| S25 | +10 | 28 | 9 | 4 | -190.00 | 146.00 | -44.00 | [-277, 264] | -0.26 | 66.00 | -110.00 |
| S25 | +12 | 28 | 9 | 2 | -114.00 | 67.00 | -47.00 | [-164, 123] | -0.28 | 11.00 | -58.00 |
| older 10/27-10/30 | +10 | 88 | 43 | 15 | -1169.00 | 2292.78 | 1123.78 | [-310, 2911] | 2.13 | 573.00 | 550.78 |
| older 10/27-10/30 | +12 | 88 | 43 | 12 | -737.50 | 2400.78 | 1663.28 | [206, 3474] | 3.15 | 771.00 | 892.28 |

Pricing: 2 contracts at +T; runner stop assumed at T-5 (the live rule locks TP1-5). Real winners keep their real runner result unless the path dips to T-5 between +T and +15. Converted trades have the runner valued at its lock (a lower bound; it also assumes the no-progress exit keys off the new TP1). Not modelled: more re-entries after earlier exits (same-direction block after a win).


## 6. Extra cuts that came out of the anatomy

### 6a. Where in the 15m candle the entry lands

**FOCUS**

| minute of 15m candle at entry | n | win% | full stops | net $ | $/trade |
|---|---|---|---|---|---|
| 0-3 | 28 | 61% | 6 | -304.48 | -10.87 |
| 3-6 | 16 (small) | 62% | 0 | 279.44 | 17.47 |
| 6-9 | 15 (small) | 73% | 1 | 443.10 | 29.54 |
| 9-12 | 19 (small) | 53% | 6 | -289.54 | -15.24 |
| 12-15 | 10 (small) | 40% | 6 | -870.10 | -87.01 |

**CORE**

| minute of 15m candle at entry | n | win% | full stops | net $ | $/trade |
|---|---|---|---|---|---|
| 0-3 | 21 | 67% | 3 | -56.86 | -2.71 |
| 3-6 | 9 (small) | 67% | 0 | 149.56 | 16.62 |
| 6-9 | 11 (small) | 73% | 0 | 364.74 | 33.16 |
| 9-12 | 13 (small) | 69% | 1 | 426.92 | 32.84 |
| 12-15 | 6 (small) | 50% | 3 | -545.96 | -90.99 |

**S25**

| minute of 15m candle at entry | n | win% | full stops | net $ | $/trade |
|---|---|---|---|---|---|
| 0-3 | 7 (small) | 43% | 3 | -247.62 | -35.37 |
| 3-6 | 7 (small) | 57% | 0 | 129.88 | 18.55 |
| 6-9 | 4 (small) | 75% | 1 | 78.36 | 19.59 |
| 9-12 | 6 (small) | 17% | 5 | -716.46 | -119.41 |
| 12-15 | 4 (small) | 25% | 3 | -324.14 | -81.03 |

**older 10/27-10/30**

| minute of 15m candle at entry | n | win% | full stops | net $ | $/trade |
|---|---|---|---|---|---|
| 0-3 | 19 (small) | 74% | 1 | 595.62 | 31.35 |
| 3-6 | 28 | 61% | 3 | -202.94 | -7.25 |
| 6-9 | 8 (small) | 50% | 2 | -55.06 | -6.88 |
| 9-12 | 16 (small) | 50% | 3 | -353.12 | -22.07 |
| 12-15 | 17 (small) | 65% | 4 | -104.40 | -6.14 |

| cohort | skip entries in | n | trades skipped | winners skipped | full stops skipped | net $ change | 95% CI | 1st half $ | 2nd half $ |
|---|---|---|---|---|---|---|---|---|---|
| FOCUS | last 1 min | 88 | 4 | 0 | 4 | 787.14 | [152, 1693] | 481.32 | 305.82 |
| FOCUS | last 2 min | 88 | 6 | 2 | 4 | 634.96 | [-76, 1566] | 481.32 | 153.64 |
| FOCUS | last 3 min | 88 | 10 | 4 | 6 | 870.10 | [-82, 2103] | 403.48 | 466.62 |
| FOCUS | last 5 min | 88 | 27 | 13 | 12 | 1187.32 | [-227, 2716] | 120.44 | 1066.88 |
| CORE | last 1 min | 60 | 2 | 0 | 2 | 481.32 | [0, 1262] | 0 | 481.32 |
| CORE | last 2 min | 60 | 4 | 2 | 2 | 329.14 | [-234, 1197] | 0 | 329.14 |
| CORE | last 3 min | 60 | 6 | 3 | 3 | 545.96 | [-230, 1613] | -77.84 | 623.80 |
| CORE | last 5 min | 60 | 17 | 11 | 4 | 146.72 | [-947, 1401] | -360.88 | 507.60 |
| S25 | last 1 min | 28 | 2 | 0 | 2 | 305.82 | [0, 765] | 0 | 305.82 |
| S25 | last 2 min | 28 | 2 | 0 | 2 | 305.82 | [0, 765] | 0 | 305.82 |
| S25 | last 3 min | 28 | 4 | 1 | 3 | 324.14 | [-239, 926] | 18.32 | 305.82 |
| S25 | last 5 min | 28 | 10 | 2 | 8 | 1040.60 | [272, 1857] | 485.30 | 555.30 |
| older 10/27-10/30 | last 1 min | 88 | 5 | 5 | 0 | -468.20 | [-935, -98] | -195.68 | -272.52 |
| older 10/27-10/30 | last 2 min | 88 | 11 | 8 | 2 | -152.40 | [-1035, 896] | -70.58 | -81.82 |
| older 10/27-10/30 | last 3 min | 88 | 17 | 11 | 4 | 104.40 | [-965, 1312] | 114.58 | -10.18 |
| older 10/27-10/30 | last 5 min | 88 | 29 | 17 | 6 | 230.38 | [-1096, 1699] | 182.48 | 47.90 |

16 looks (4 windows x 4 cohorts). Skipped trades are simply removed; a skipped entry may re-fire after the candle turns, which is not modelled.

### 6b. CORE by event / direction

| cohort | event | dir | n | win% | full stops | net $ | $/trade |
|---|---|---|---|---|---|---|---|
| CORE | SWEEP-LOSS | S | 36 | 64% | 7 | -520.76 | -14.47 |
| S25 | SWEEP-LOSS | S | 10 | 30% | 6 | -766.60 | -76.66 |
| older | SWEEP-LOSS | S | 45 | 73% | 7 | 757.00 | 16.82 |
| CORE | SWEEP-RECLAIM | L | 24 | 71% | 0 | 859.16 | 35.80 |
| S25 | SWEEP-RECLAIM | L | 18 | 50% | 6 | -313.38 | -17.41 |
| older | SWEEP-RECLAIM | L | 16 | 50% | 0 | 62.42 | 3.90 |

### 6c. What the 25-pt stop did (S25 full stops re-walked on 1m bars with the session stop 30/50 and the 5m no-progress exit)

| entry PT | session | session stop | outcome with the session stop | real net $ | cf net $ | change $ |
|---|---|---|---|---|---|---|
| 11-03 04:11:53 | London | 30 | full stop at -30 | -153.66 | -183.66 | -30.00 |
| 11-03 05:40:38 | London | 30 | full stop at -30 | -155.16 | -183.66 | -28.50 |
| 11-03 06:12:31 | London | 30 | full stop at -30 | -155.16 | -183.66 | -28.50 |
| 11-03 07:10:11 | NY | 50 | TP1 +15 (runner at +10) | -158.16 | 77.84 | 236.00 |
| 11-03 09:10:18 | NY | 50 | no-progress exit at -11.00 | -153.66 | -68.16 | 85.50 |
| 11-03 09:29:40 | NY | 50 | no-progress exit at -42.00 | -153.66 | -254.16 | -100.50 |
| 11-03 10:44:47 | NY | 50 | no-progress exit at -7.00 | -152.16 | -44.16 | 108.00 |
| 11-03 12:06:23 | NY | 50 | no-progress exit at -19.00 | -153.66 | -116.16 | 37.50 |
| 11-03 17:01:12 | Asia | 30 | full stop at -30 | -153.66 | -183.66 | -30.00 |
| 11-03 18:55:45 | Asia | 30 | TP1 +15 (runner at +10) | -153.66 | 77.84 | 231.50 |
| 11-03 19:45:08 | Asia | 30 | TP1 +15 (runner at +10) | -161.16 | 77.84 | 239.00 |
| 11-03 20:01:39 | Asia | 30 | full stop at -30 | -152.16 | -183.66 | -31.50 |

Total change on the 12 S25 full stops: $688. Stop-first in every bar; entry-bar favourable move ignored; np exit taken at the close of the first full 5m candle.

CORE minus S25 expectancy: $44.2 per trade, bootstrap 95% CI [-9.3, 93.4] (n=60 vs 28; different days, so not a controlled test). Full-stop rate 7/60 vs 12/28.

### 6d. Why the ratio is about 4x: it is the stop distance divided by the win size

| group | n | avg stop pts | TP1 wins | avg win $ | full stops | avg full stop $ | wins needed per full stop | np exits | avg np $ |
|---|---|---|---|---|---|---|---|---|---|
| CORE NY | 13 | 50.00 | 11 | 88.20 | 2 | -302.91 | 3.43 | 0 | 0.00 |
| CORE Asia | 35 | 38.68 | 19 | 83.68 | 5 | -243.96 | 2.92 | 11 | -71.57 |
| CORE London | 12 | 38.31 | 6 | 77.59 | 0 | 0.00 | 0.00 | 6 | -12.41 |

Runner on TP1 trades (focus, n=45): median 9.75 pts, p75 10.00, p90 19.75, max 50.00; runner beat +15 in 8.


## 7. Addendum: split by session and by volatility at entry (Mac 11/11: "the strategy has to be dynamic for the market type/session")

Volatility = average range of the twelve 5m blocks in the 60 minutes before the entry minute, built from 1m closes only (so the same measure works on 11/10-11/11, where only minute closes are held; it reads lower than a high/low range). Bars before the entry only. Terciles over the 66 focus trades with a path: low < 16.3 <= mid < 24.5 <= high. 20 trades without a measure.

| session | n | median vol (pts) | low | mid | high |
|---|---|---|---|---|---|
| Asia | 27 | 16.62 | 11 | 8 | 8 |
| London | 20 | 15.32 | 11 | 6 | 3 |
| NY | 19 | 25.92 | 0 | 8 | 11 |

**Payoff by group (focus, CORE+S25)**

| group | n | win% | avg win $ | avg loss $ | full stops | exp $/trade | net $ | of which S25 |
|---|---|---|---|---|---|---|---|---|
| Asia | 41 | 56% | 80.17 | -151.41 | 9 | -21.50 | -881.56 | 7 |
| London | 24 | 54% | 67.88 | -63.66 | 3 | 7.59 | 182.16 | 13 |
| NY | 21 | 67% | 84.48 | -196.73 | 7 | -9.26 | -194.36 | 8 |
| vol low | 22 | 59% | 73.42 | -72.66 | 1 | 13.66 | 300.48 | 6 |
| vol mid | 22 | 59% | 84.07 | -116.33 | 4 | 2.09 | 45.98 | 9 |
| vol high | 22 | 50% | 78.20 | -182.02 | 11 | -51.91 | -1142.02 | 13 |

**Protect-after-MFE, pessimistic stop-first ordering: net $ change (winners killed / full stops saved)**

| group | n | +8/-0 | +8/-5 | +8/-10 | +8/-15 | +10/-0 | +10/-5 | +10/-10 | +10/-15 | +12/-0 | +12/-5 | +12/-10 | +12/-15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Asia | 41 | -264 (12/2) | 36 (5/2) | 324 (1/2) | 189 (1/2) | 242 (6/2) | 257 (3/2) | 464 (0/2) | 358 (0/2) | -80 (5/1) | 56 (2/1) | 218 (0/1) | 158 (0/1) |
| London | 24 | -550 (6/0) | -442 (3/0) | -142 (1/0) | 0 (0/0) | -454 (5/0) | -442 (3/0) | -142 (1/0) | 0 (0/0) | -514 (5/0) | -472 (3/0) | -142 (1/0) | 0 (0/0) |
| NY | 21 | -991 (11/0) | -926 (8/0) | -462 (3/0) | -362 (2/0) | -910 (10/0) | -926 (8/0) | -462 (3/0) | -172 (1/0) | -666 (8/0) | -795 (7/0) | -302 (2/0) | -172 (1/0) |
| vol low | 22 | -546 (7/0) | -356 (3/0) | 0 (0/0) | 0 (0/0) | -206 (3/0) | -246 (2/0) | 0 (0/0) | 0 (0/0) | -222 (2/0) | -170 (1/0) | 0 (0/0) | 0 (0/0) |
| vol mid | 22 | -743 (8/0) | -385 (3/0) | -145 (1/0) | -190 (1/0) | -560 (6/0) | -385 (3/0) | -145 (1/0) | 0 (0/0) | -574 (6/0) | -430 (3/0) | -160 (1/0) | 0 (0/0) |
| vol high | 22 | -900 (11/0) | -1017 (9/0) | -442 (3/0) | -342 (2/0) | -820 (10/0) | -907 (8/0) | -302 (2/0) | -172 (1/0) | -720 (9/0) | -776 (7/0) | -142 (1/0) | -172 (1/0) |

Best cell per group (picked after the fact out of 12; the CI does not correct for that pick):

| group | n | best X / new stop | net $ change | 95% CI | winners killed | full stops saved |
|---|---|---|---|---|---|---|
| Asia | 41 | +10 / -10 | 463.50 | [15, 1114] | 0 | 2 |
| London | 24 | +8 / -15 | 0.00 | [0, 0] | 0 | 0 |
| NY | 21 | +10 / -15 | -171.50 | [-514, 0] | 1 | 0 |
| vol low | 22 | +8 / -10 | 0.00 | [0, 0] | 0 | 0 |
| vol mid | 22 | +10 / -15 | 0.00 | [0, 0] | 0 | 0 |
| vol high | 22 | +12 / -10 | -141.50 | [-424, 0] | 1 | 0 |

**TP1 at +10 / +12 against +15 (same pricing as section 5)**

| group | n | real TP1 winners | +10: converted | +10: net $ change | +10: 95% CI | +12: converted | +12: net $ change | +12: 95% CI |
|---|---|---|---|---|---|---|---|---|
| Asia | 41 | 21 | 6 | 519.50 | [-310, 1604] | 3 | 188.50 | [-316, 996] |
| London | 24 | 9 | 5 | -5.50 | [-256, 323] | 3 | 8.00 | [-148, 212] |
| NY | 21 | 13 | 1 | -309.50 | [-428, -200] | 1 | -160.00 | [-216, -102] |
| vol low | 22 | 10 | 4 | 6.00 | [-278, 342] | 1 | -73.00 | [-168, 57] |
| vol mid | 22 | 11 | 4 | -65.50 | [-318, 292] | 3 | -65.50 | [-196, 122] |
| vol high | 22 | 11 | 0 | -271.00 | [-401, -150] | 0 | -141.50 | [-204, -79] |

**MAE of TP1 winners before the TP1 fill**

| group | winners n | p50 | p75 | p90 | p95 | max | needed more than 25 |
|---|---|---|---|---|---|---|---|
| Asia | 21 | 4.50 | 7.75 | 12.50 | 17.00 | 20.75 | 0 |
| London | 9 (small) | 5.25 | 10.00 | 11.35 | 12.05 | 12.75 | 0 |
| NY | 13 (small) | 6.25 | 15.00 | 31.40 | 38.75 | 44.75 | 2 |
| vol low | 10 (small) | 5.38 | 7.56 | 11.17 | 11.96 | 12.75 | 0 |
| vol mid | 11 (small) | 3.00 | 7.38 | 15.00 | 16.50 | 18 | 0 |
| vol high | 11 (small) | 7.25 | 17.50 | 34.75 | 39.75 | 44.75 | 2 |

**Reading the splits.** The volatility terciles cover only the 66 focus trades of 11/02-11/04 (the 11/10-11/11 trades have no minute closes before entry in the files held here), and the high tercile is 13 of 22 S25 trades, so "high volatility" and "25-pt stop" are tangled in this sample. Protect-after-MFE differs by session: Asia is the only session where any cell is positive (best +10 / entry-10: +$464, CI [15, 1,114], n=41, 0 winners killed, 2 full stops saved, both on the coarser 11/09 evening paths); in London (n=24) and NY (n=21) every cell is zero or negative. Best cells are picked after the fact from 12.

**Full-stop MFE caveat.** The 11/03 17:01 and 18:55 full stops lasted about 30 s inside one bar; their MFE (9.75 and 8.25) uses the whole bar and may include prices before the fill.
