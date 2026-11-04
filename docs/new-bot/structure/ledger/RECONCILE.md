# RECONCILE: engine shadow ledger (structure tide-structure-r3.2) vs the quant/risk proxy, IN-SAMPLE

## Top 3 differences (read these first)

1. **Same bias, different trigger.** The bias input is NOT the mismatch (section at the end: median |score diff| 0.0014, the 0.20 line differs on 0.6% of minutes, the board levels are identical). 34 of the 64 proxy-only trades have no engine entry because of the TRIGGER: 17 armed but never printed the retest-rejection (a real counter-move bounce >= 50% of the leg toward the broken swing / a defended retest, then a 1m close back), 17 never armed (no internal shift after the failure, or no 2-close acceptance). The proxy enters on the 5m-close level retest of the r1.x study rules.
2. **Engine rules the proxy does not have.** 16 proxy-only trades were armed by the engine and then cancelled (SETUP_CANCEL SUPERSEDED 8, SETUP_CANCEL RETEST_DEEP 5, SETUP_CANCEL RECLAIM 1, SETUP_EXPIRE 4H closed 1, SETUP_CANCEL ACCEPT_LOST 1), and 14 hit an engine gate or skip (SIGNAL_SKIP CLIMAX 3, GRADE_NO_TRADE waveBias 3, GRADE_NO_TRADE control4h 2, GRADE_NO_TRADE laneTrigger+waveBias 2, SIGNAL_SKIP OPEN_WAIT 2, GRADE_NO_TRADE laneTrigger 1, GRADE_NO_TRADE control4h+laneTrigger 1). RETEST_2_SKIP: 0 proxy trades (r3.2 counts the retest per break).
3. **Pool universe.** 8 engine-only trades sit on opening-range / equal-high-low pools the proxy does not have; 5 engine-only are proxy MONEY_NO_FIT (r1.x money fit) and 5 proxy "in trade". Grades: 3 trades match; 1 of them differ (engine B vs proxy C, wave peak 0.399 vs 0.41).

## The r3.1 findings, ruled and fixed in tide-structure-r3.2 (measured on this run)

- trap -> opposite-trap CONTROL_FLIP: 0 (r3.1: 16); bias control -> trap flips still allowed (ruling): 18.
- Round pools as TP1 / TP2: 0 / 0 of 24 signals (r3.1: 12 / 13 of 20 with money-r4.1).
- RETEST_2_SKIP on proxy trades: 0 (r3.1: 14); the retest is counted per break.
- still open (NOT a ruling yet): TP1 < 0.5R on 10 of 24 signals, min 0.01R: an opening-range pool right next to the entry becomes TP1 (see DIFF-r3.1.md).
- still open: the proxy outcome walk (risk.py r2exit / risk_int.py parts) never flattens on this data (it waits for a 14:00-14:59 bar that does not exist; the bot flattens at 13:05); see DIFF-r3.1.md.


**Analysis only, not a strategy gate.** In-sample: 6 TradeDays (10/28 .. 11/04, last bar 11/03 19:47 PT), the same days the grade review was fitted on.

## Sources

- engine: lib/structure.js tide-structure-r3.2 sha256 2a2249f17efc202c, default cfg, every 1m bar 10-22 13:55 .. 11-03 19:47 (11333 bars, 7188 with bias); bias = bot r13.3.7 lib/levelsPro.js evaluateLevelsPro on the forming 15m/30m, intrabar, observedAt = T (tools/build-bias-fixture.cjs, per TradeDay). Before 10/27 15:00 PT = warm-up, no bias.
- proxy: tide/grade/risk.py `grade_r3` on quant.py rows (`taken-if-flat`, wave peak >= 0.20): 67 trades. Input `tide/study/fixes_on/setups.csv` is MISSING from the scratchpad (quant/risk read it); it was regenerated with the study's own `tide_setups.py` FIXES-ON run (tools/regen_fixes_on.py): 537 setups / 77 taken = QUANT.md, and readings.csv, near_misses.csv, ranaway.csv are byte-identical to the originals.
- outcome (both sides): risk_int.py r2-exit proxy, whole contracts, integer partial (1 lot: no partial, BE after +1R), stop first on the same 1m bar, MTM at 14:00 PT, $0.62/side. R below = the fractional r2-exit R (risk.py r2exit), $ = whole contracts.
- match: same dir, |dt| <= 10 min, same level (proxy level name in the engine zone members, or level price within 3 pts); greedy nearest-first, one-to-one.

## Counts

| | n |
|---|---|
| engine signals | 24 (taken-if-flat 22) |
| engine GRADE_NO_TRADE | 60 |
| proxy trades (taken-if-flat, peak >= 0.20) | 67 |
| matched, same grade | 2 |
| matched, different grade | 1 |
| engine-only | 21 |
| proxy-only | 64 |

### Why engine-only (category: n, net R, $ flat450)

- no proxy setup (engine pool is an opening-range / equal-high-low pool the proxy does not have): 8, -0.67R, $-269
- proxy setup not taken (MONEY_NO_FIT): 5, +0.67R, $+289
- proxy setup not taken (in trade): 5, +1.33R, $+451
- no proxy setup: 3, +3.33R, $+1323

### Why proxy-only: what the engine did (category: n, net R, $ flat450)

- armed, no rejection entry: 17, +6.33R, $+1693
- level event, no setup armed: 17, +0.53R, $+139
- armed, then SETUP_CANCEL SUPERSEDED: 8, +0.67R, $+1123
- armed, then SETUP_CANCEL RETEST_DEEP: 5, -1.67R, $-230
- GRADE_NO_TRADE waveBias: 3, +2.67R, $+760
- SIGNAL_SKIP CLIMAX: 3, +2.67R, $+524
- GRADE_NO_TRADE control4h: 2, -0.33R, $-35
- GRADE_NO_TRADE laneTrigger+waveBias: 2, -0.33R, $-149
- SIGNAL_SKIP OPEN_WAIT: 2, -0.33R, $-231
- GRADE_NO_TRADE control4h+laneTrigger: 1, +1.33R, $+809
- GRADE_NO_TRADE laneTrigger: 1, +0.67R, $+253
- armed, then SETUP_CANCEL ACCEPT_LOST: 1, -1.00R, $-296
- armed, then SETUP_CANCEL RECLAIM: 1, +1.33R, $+468
- armed, then SETUP_EXPIRE 4H closed: 1, +0.67R, $+162

- proxy trades that are NOT the first retest of their level in the 4H (quant.py `first_retest`; risk.py grade_r3 has no first-retest gate): 0 of 67 (0 of the 64 proxy-only).
- proxy trades whose control_kind is below/above (no trap) vs trap: 26 / 41.

## Per grade (in-sample; the first three lines are the verbatim risk_int.py walk, the last applies the 12:55 / 13:05 session close)

- engine, all signals: A+ 2: +2.00R, $+748 flat450, $+1661 grade | B 7: -0.33R, $-306 flat450, $-153 grade | C 15: +5.67R, $+2297 flat450, $+1441 grade (total 24 trades, +7.33R, $+2739 flat450, $+2950 grade)
- engine, taken-if-flat: A+ 2: +2.00R, $+748 flat450, $+1661 grade | B 6: +0.67R, $+100 flat450, $+253 grade | C 14: +6.67R, $+2586 flat450, $+1730 grade (total 22 trades, +9.33R, $+3434 flat450, $+3644 grade)
- proxy: A+ 6: +5.33R, $+1568 flat450, $+4474 grade | B 8: +2.33R, $+1570 flat450, $+1752 grade | C 53: +6.53R, $+2321 flat450, $+650 grade (total 67 trades, +14.20R, $+5459 flat450, $+6877 grade)
- with the bot's session close (no entries 12:55 -> 15:00 PT, flat at 13:05 PT): engine A+ 2: +2.00R, $+748 flat450, $+1661 grade | B 6: +0.67R, $+100 flat450, $+253 grade | C 14: +6.67R, $+2586 flat450, $+1730 grade (total 22 trades, +9.33R, $+3434 flat450, $+3644 grade); proxy A+ 6: +5.33R, $+1568 flat450, $+4474 grade | B 8: +2.08R, $+1084 flat450, $+1267 grade | C 50: +9.28R, $+4030 flat450, $+2359 grade (total 64 trades, +16.69R, $+6683 flat450, $+8100 grade; 3 proxy trades fall in 12:55-15:00 and are dropped).

## Matched with a different grade (1)

- engine 11-02 20:55 SHORT failed-break 1H Open @28121.5 stop 28200.25 (78.75 pts) B [trap=0 force=1 volume=1 timing=0 impulseBand=1] **vs** proxy 11-02 21:05 SHORT below 1H Open @28115.75 stop 28126.5 (10.75 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.41; points that differ: force engine 1 / proxy 0, volume engine 1 / proxy 0, impulseBand engine 1 / proxy 0

## Matched with the same grade (2)

- engine 11-03 07:36 LONG accepted-break 4H Open @28319.5 stop 28286.25 (33.25 pts) C [trap=1 force=0 volume=1 timing=1 impulseBand=0] **vs** proxy 11-03 07:40 LONG trap 4H Open @28302.5 stop 28245.5 (57.00 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.46; points still differ: timing 1/0
- engine 11-03 10:03 LONG accepted-break 1H Open @28382.5 stop 28355 (27.5 pts) C [trap=1 force=0 volume=1 timing=0 impulseBand=0] **vs** proxy 11-03 09:55 LONG trap 1H Open @28362.5 stop 28245.5 (117.00 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.44; points still differ: trap 1/0, volume 1/0

## Engine-only (21)

- 10-27 20:03 LONG failed-break 4H Open @29889.25 stop 29838.75 (50.5 pts) C [trap=1 force=0 volume=0 timing=0 impulseBand=1]; R +0.67, $+298 flat450. Why not in the proxy: proxy setup 10-27 20:00 4H Open not taken-if-flat (in trade (10-27 15:30 4H Open))
- 10-28 12:43 LONG accepted-break PDH @29918.5 stop 29877 (41.5 pts) C [trap=1 force=0 volume=0 timing=0 impulseBand=1]; R +1.33, $+575 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 10-28 16:01 SHORT accepted-break PDL @29652.25 stop 29682 (29.75 pts) C [trap=0 force=0 volume=0 timing=1 impulseBand=0]; R -1.00, $-425 flat450. Why not in the proxy: proxy setup 10-28 16:00 PDL not taken-if-flat (MONEY_NO_FIT)
- 10-28 16:38 SHORT accepted-break 1H Open @29633.75 stop 29737.75 (104 pts) C [trap=0 force=0 volume=1 timing=0 impulseBand=1]; R -1.00, $-418 flat450. Why not in the proxy: proxy setup 10-28 16:45 1H Open not taken-if-flat (MONEY_NO_FIT)
- 10-28 22:04 LONG accepted-break Asia ORL @29654.75 stop 29630.75 (24 pts) C [trap=0 force=0 volume=1 timing=0 impulseBand=0]; R +1.33, $+565 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 10-28 23:45 SHORT failed-break PDL @29635.75 stop 29685 (49.25 pts) B [trap=1 force=0 volume=1 timing=0 impulseBand=1]; R +0.67, $+291 flat450. Why not in the proxy: proxy setup 10-28 23:45 PDL not taken-if-flat (MONEY_NO_FIT)
- 10-29 04:47 SHORT failed-break 4H Open @29653.75 stop 29737.25 (83.5 pts) A+ [trap=1 force=1 volume=1 timing=0 impulseBand=1]; R +0.67, $+165 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 10-29 12:58 LONG failed-break 4H Open @29551 stop 29450.25 (100.75 pts) B [trap=1 force=1 volume=1 timing=0 impulseBand=0]; R -1.00, $-405 flat450. Why not in the proxy: proxy setup 10-29 12:45 4H Open not taken-if-flat (in trade (10-29 12:40 4H Open))
- 10-29 15:40 SHORT accepted-break PDL @29098.5 stop 29112.5 (14 pts) C [trap=0 force=0 volume=1 timing=1 impulseBand=0]; R +1.33, $+568 flat450. Why not in the proxy: proxy setup 10-29 15:40 PDL not taken-if-flat (MONEY_NO_FIT)
- 10-29 17:13 SHORT failed-break PDL @29075.75 stop 29136 (60.25 pts) C [trap=1 force=0 volume=0 timing=0 impulseBand=1]; R +1.33, $+478 flat450. Why not in the proxy: proxy setup 10-29 17:15 PDL not taken-if-flat (in trade (10-29 16:45 PDL))
- 10-30 04:16 SHORT accepted-break 1H Open @28834 stop 28862.75 (28.75 pts) C [trap=0 force=0 volume=1 timing=0 impulseBand=1]; R +1.33, $+509 flat450. Why not in the proxy: proxy setup 10-30 04:15 1H Open not taken-if-flat (in trade (10-30 03:30 4H Open))
- 11-01 16:27 LONG accepted-break 4H ORH @28688 stop 28661.5 (26.5 pts) B [trap=0 force=0 volume=1 timing=1 impulseBand=1]; R +0.67, $+255 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-01 23:40 SHORT failed-break 4H Open @28732.5 stop 28803.25 (70.75 pts) B [trap=1 force=1 volume=1 timing=0 impulseBand=0]; R -1.00, $-428 flat450. Why not in the proxy: proxy setup 11-01 23:40 4H Open not taken-if-flat (in trade (11-01 22:35 4H Open))
- 11-02 03:55 SHORT failed-break EQH @28749.75 stop 28793.25 (43.5 pts) C [trap=1 force=0 volume=1 timing=0 impulseBand=0]; R +0.67, $+255 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-02 09:03 SHORT accepted-break London Low @28660.25 stop 28688.5 (28.25 pts) C [trap=1 force=0 volume=0 timing=0 impulseBand=1]; R +0.67, $+274 flat450. Why not in the proxy: proxy setup 11-02 09:00 London Low not taken-if-flat (MONEY_NO_FIT)
- 11-02 20:15 SHORT failed-break 4H ORL @28160.5 stop 28183 (22.5 pts) C [trap=1 force=1 volume=1 timing=0 impulseBand=0]; R -1.00, $-462 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-03 01:35 LONG accepted-break London ORH @28180.5 stop 28131 (49.5 pts) B [trap=1 force=0 volume=1 timing=0 impulseBand=1]; R +0.67, $+292 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-03 09:19 LONG accepted-break 4H ORH @28384.75 stop 28333 (51.75 pts) C [trap=1 force=0 volume=1 timing=0 impulseBand=0]; R -1.00, $-419 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-03 12:04 SHORT failed-break 4H ORL @28254 stop 28272.75 (18.75 pts) B [trap=1 force=1 volume=1 timing=0 impulseBand=0]; R -1.00, $-465 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-03 13:33 LONG accepted-break 4H ORH @28413.5 stop 28269.5 (144 pts) C [trap=0 force=0 volume=1 timing=0 impulseBand=0]; R -1.00, $-289 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min
- 11-03 16:08 SHORT failed-break 4H Open @28366.75 stop 28513 (146.25 pts) A+ [trap=1 force=1 volume=1 timing=1 impulseBand=0]; R +1.33, $+584 flat450. Why not in the proxy: proxy: no setup at this level/dir within 30 min

## Proxy-only (64)

- 10-27 15:30 LONG trap 4H Open @29828.75 stop 29781.5 (47.25 pts) A+ [trap=1 force=0 vol=1 timing=1 band=1] peak 0.37; R +1.33, $+468 flat450. first retest (quant.py) yes. Engine: engine armed S510 failed-break 4H Open at 10-27 15:45, then SETUP_CANCEL RECLAIM: a 5m close back through the broken swing / level
- 10-27 21:40 LONG trap 4H Open @29898.5 stop 29838.75 (59.75 pts) C [trap=1 force=1 vol=0 timing=0 band=0] peak 0.42; R +0.67, $+235 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT 4H ORH above, ACCEPT 1H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-28 07:30 SHORT trap 4H Open @29843.75 stop 29876.25 (32.50 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.48; R +0.67, $+253 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 10-28 07:33 accepted-break 4H Open (laneTrigger)
- 10-28 08:05 SHORT trap 4H Open @29839.75 stop 29876.25 (36.50 pts) B [trap=1 force=0 vol=1 timing=0 band=1] peak 0.38; R -1.00, $-445 flat450. first retest (quant.py) yes. Engine: engine armed S624 accepted-break 4H Open at 10-28 07:15, then no rejection entry in the window
- 10-28 10:05 LONG trap 4H Open @29890.0 stop 29782.0 (108.00 pts) A+ [trap=1 force=1 vol=1 timing=0 band=1] peak 0.36; R +0.67, $+214 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 10-28 10:05 failed-break 1H Open (control4h)
- 10-28 11:00 LONG trap 4H Open @29864.0 stop 29782.0 (82.00 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.21; R +0.67, $+162 flat450. first retest (quant.py) yes. Engine: engine armed S652 accepted-break 4H Open at 10-28 11:00, then SETUP_EXPIRE 4H closed
- 10-28 11:30 SHORT trap 4H Open @29859.75 stop 29920.0 (60.25 pts) A+ [trap=1 force=1 vol=1 timing=0 band=1] peak 0.38; R +0.67, $+237 flat450. first retest (quant.py) yes. Engine: engine armed S655 accepted-break 4H Open at 10-28 11:10, then SETUP_CANCEL RETEST_DEEP: through the level by 18.25
- 10-28 12:40 LONG trap 4H Open @29884.75 stop 29783.5 (101.25 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.24; R +1.33, $+605 flat450. first retest (quant.py) yes. Engine: engine armed S711 accepted-break PDH at 10-28 12:40, then no rejection entry in the window
- 10-28 13:10 LONG trap Asia High @29971.5 stop 29783.5 (188.00 pts) C [trap=1 force=1 vol=0 timing=0 band=0] peak 0.46; R -1.00, $-377 flat450. first retest (quant.py) yes. Engine: engine armed S711 accepted-break PDH at 10-28 12:40, then no rejection entry in the window
- 10-28 16:55 SHORT below PDL @29663.5 stop 29796.25 (132.75 pts) C [trap=0 force=0 vol=0 timing=0 band=1] peak 0.39; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine armed S742 accepted-break 1H Open at 10-28 16:35, then no rejection entry in the window
- 10-28 17:50 SHORT below 4H Open @29751.75 stop 29796.25 (44.50 pts) B [trap=0 force=1 vol=1 timing=0 band=1] peak 0.38; R +1.33, $+617 flat450. first retest (quant.py) yes. Engine: engine armed S753 accepted-break 1H Open at 10-28 18:20, then SETUP_CANCEL SUPERSEDED: the trap setup on 1H Open replaces it (one idea per direction)
- 10-28 19:55 SHORT below 4H Open @29555.0 stop 29587.0 (32.00 pts) C [trap=0 force=1 vol=1 timing=0 band=0] peak 0.46; R +0.67, $+311 flat450. first retest (quant.py) yes. Engine: engine armed S760 accepted-break 1H Open at 10-28 20:15, then SETUP_CANCEL RETEST_DEEP: through the level by 10.5
- 10-28 22:55 LONG trap PDL @29688.75 stop 29481.25 (207.50 pts) C [trap=1 force=1 vol=1 timing=0 band=0] peak 0.41; R -1.00, $-416 flat450. first retest (quant.py) yes. Engine: engine armed S771 accepted-break Asia ORL at 10-28 22:00, then no rejection entry in the window
- 10-29 00:05 SHORT trap 4H Open @29646.5 stop 29733.25 (86.75 pts) A+ [trap=1 force=1 vol=0 timing=1 band=1] peak 0.33; R +0.67, $+171 flat450. first retest (quant.py) yes. Engine: engine armed S777 failed-break PDL at 10-28 23:40, then no rejection entry in the window
- 10-29 00:20 SHORT trap 1H Open @29625.25 stop 29733.25 (108.00 pts) B [trap=0 force=0 vol=1 timing=1 band=1] peak 0.35; R -1.00, $-434 flat450. first retest (quant.py) yes. Engine: engine armed S777 failed-break PDL at 10-28 23:40, then no rejection entry in the window
- 10-29 02:15 LONG trap 1H Open @29673.75 stop 29550.0 (123.75 pts) C [trap=0 force=1 vol=1 timing=0 band=0] peak 0.30; R -1.00, $-249 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 10-29 02:07 failed-break London ORL (control4h)
- 10-29 03:00 LONG trap 4H Open @29697.5 stop 29550.0 (147.50 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.23; R -1.00, $-296 flat450. first retest (quant.py) yes. Engine: engine armed S816 accepted-break 4H Open at 10-29 03:10, then SETUP_CANCEL ACCEPT_LOST: a 5m close back inside
- 10-29 05:10 SHORT trap 1H Open @29596.25 stop 29737.25 (141.00 pts) C [trap=0 force=0 vol=0 timing=0 band=1] peak 0.37; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine armed S840 failed-break 4H Open at 10-29 04:40, then no rejection entry in the window
- 10-29 05:50 SHORT trap 1H Open @29613.75 stop 29737.25 (123.50 pts) B [trap=0 force=1 vol=1 timing=0 band=1] peak 0.40; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine armed S840 failed-break 4H Open at 10-29 04:40, then no rejection entry in the window
- 10-29 09:15 LONG trap 4H Open @29562.75 stop 29446.25 (116.50 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.25; R -1.00, $-234 flat450. first retest (quant.py) yes. Engine: engine armed S882 accepted-break 4H Open at 10-29 09:45, then SETUP_CANCEL RETEST_DEEP: through the level by 15.5
- 10-29 12:40 LONG trap 4H Open @29488.25 stop 29422.75 (65.50 pts) C [trap=1 force=1 vol=0 timing=0 band=0] peak 0.22; R +0.67, $+258 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 10-29 12:11 accepted-break 4H Open (laneTrigger; waveBias)
- 10-29 16:05 SHORT below 1H Open @29044.25 stop 29057.75 (13.50 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.51; R +0.67, $+277 flat450. first retest (quant.py) yes. Engine: engine armed S920 accepted-break PDL at 10-29 15:35, then no rejection entry in the window
- 10-29 16:25 SHORT below PDL @29085.25 stop 29182.75 (97.50 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.57; R +1.33, $+583 flat450. first retest (quant.py) yes. Engine: engine armed S920 accepted-break PDL at 10-29 15:35, then no rejection entry in the window
- 10-29 16:45 SHORT below PDL @29094.75 stop 29182.75 (88.00 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.29; R +1.33, $+526 flat450. first retest (quant.py) yes. Engine: engine armed S937 failed-break PDL at 10-29 17:10, then no rejection entry in the window
- 10-29 20:20 SHORT below 1H Open @28884.75 stop 28916.75 (32.00 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.21; R -1.00, $-457 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 1H Open below, ACCEPT 4H ORH above, ACCEPT 1H Open above, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 01:20 SHORT trap 1H Open @28898.0 stop 29064.5 (166.50 pts) C [trap=0 force=0 vol=0 timing=0 band=1] peak 0.36; R +1.33, $+665 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT 4H Open below, ACCEPT 4H ORL below, ACCEPT 1H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 03:30 SHORT below 4H Open @28861.25 stop 28891.0 (29.75 pts) C [trap=0 force=0 vol=1 timing=0 band=1] peak 0.39; R +1.33, $+527 flat450. first retest (quant.py) yes. Engine: engine SIGNAL_SKIP 10-30 03:38 4H Open: CLIMAX: with-trend entries blocked until structure confirms (§12.5)
- 10-30 05:00 SHORT below Asia Low @28799.75 stop 28862.75 (63.00 pts) C [trap=0 force=1 vol=0 timing=0 band=0] peak 0.40; R +1.33, $+500 flat450. first retest (quant.py) yes. Engine: engine armed S971 accepted-break 1H Open at 10-30 04:10, then no rejection entry in the window
- 10-30 06:40 SHORT below Asia Low @28802.5 stop 28823.5 (21.00 pts) C [trap=0 force=1 vol=0 timing=1 band=0] peak 0.53; R +1.33, $+534 flat450. first retest (quant.py) yes. Engine: engine saw FAIL Asia Low above, ACCEPT Asia Low below, ACCEPT 4H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 06:55 SHORT below Asia Low @28799.25 stop 28823.5 (24.25 pts) C [trap=0 force=1 vol=0 timing=1 band=0] peak 0.53; R +0.67, $+280 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT Asia Low below, ACCEPT 4H Open below, ACCEPT London Low below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 08:10 SHORT trap 1H Open @28760.25 stop 28861.0 (100.75 pts) C [trap=0 force=0 vol=1 timing=0 band=1] peak 0.39; R +1.33, $+602 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT 1H Open below, FAIL London Low above, ACCEPT London Low below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 10:05 SHORT trap 1H Open @28510.5 stop 28861.0 (350.50 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.47; R -1.00, $-702 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 4H ORL above, FAIL 4H ORL above, ACCEPT 1H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 10:25 SHORT trap 1H Open @28495.0 stop 28861.0 (366.00 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.41; R -1.00, $-733 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 4H ORL above, FAIL 4H ORL above, ACCEPT 1H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 12:10 SHORT below 4H Open @28373.5 stop 28401.5 (28.00 pts) C [trap=0 force=1 vol=0 timing=0 band=0] peak 0.42; R +0.67, $+270 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 4H Open above, FAIL 4H Open above, FAIL 4H ORH above, no setup armed the proxy way (no internal shift / no acceptance)
- 10-30 12:25 SHORT below 4H Open @28392.25 stop 28404.0 (11.75 pts) C [trap=0 force=1 vol=0 timing=0 band=0] peak 0.42; R -1.00, $-470 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 4H Open below, ACCEPT 4H ORH above, FAIL 4H ORH below, no setup armed the proxy way (no internal shift / no acceptance)
- 11-01 15:30 LONG above 4H Open @28629.25 stop 28580.75 (48.50 pts) A+ [trap=0 force=1 vol=1 timing=1 band=1] peak 0.35; R +1.33, $+480 flat450. first retest (quant.py) yes. Engine: engine armed S1028 accepted-break 4H Open at 11-01 15:10, then SETUP_CANCEL SUPERSEDED: the newer acceptance at 1H Open replaces it
- 11-01 17:15 LONG above 1H Open @28730.25 stop 28690.5 (39.75 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.28; R +0.67, $+232 flat450. first retest (quant.py) yes. Engine: engine armed S1032 accepted-break 1H Open at 11-01 16:10, then SETUP_CANCEL SUPERSEDED: the newer acceptance at 4H ORH replaces it
- 11-01 21:45 LONG above 1H Open @28827.0 stop 28773.75 (53.25 pts) C [trap=0 force=1 vol=1 timing=0 band=0] peak 0.30; R -1.00, $-431 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT 1H Open above, ACCEPT 4H ORH above, ACCEPT 1H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 11-02 06:50 SHORT trap 1H Open @28731.0 stop 28845.25 (114.25 pts) C [trap=0 force=1 vol=0 timing=1 band=0] peak 0.41; R -1.00, $-230 flat450. first retest (quant.py) yes. Engine: engine SIGNAL_SKIP 11-02 06:33 4H Open: OPEN_WAIT: NY open wait
- 11-02 08:00 LONG trap 4H Open @28727.0 stop 28661.5 (65.50 pts) C [trap=1 force=1 vol=1 timing=0 band=0] peak 0.46; R -1.00, $-397 flat450. first retest (quant.py) yes. Engine: engine armed S1139 accepted-break Asia High at 11-02 07:30, then SETUP_CANCEL SUPERSEDED: the newer acceptance at London High replaces it
- 11-02 08:35 SHORT trap 4H Open @28691.0 stop 28893.5 (202.50 pts) B [trap=1 force=0 vol=1 timing=0 band=1] peak 0.36; R +1.33, $+809 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 11-02 08:17 failed-break NY ORH (control4h; laneTrigger)
- 11-02 10:05 SHORT trap Asia Low @28581.25 stop 28893.5 (312.25 pts) C [trap=1 force=1 vol=0 timing=0 band=0] peak 0.52; R +1.33, $+1248 flat450. first retest (quant.py) yes. Engine: engine armed S1162 accepted-break 4H ORL at 11-02 08:45, then SETUP_CANCEL SUPERSEDED: the newer acceptance at London Low replaces it
- 11-02 10:20 SHORT trap Asia Low @28577.5 stop 28893.5 (316.00 pts) B [trap=1 force=0 vol=1 timing=0 band=1] peak 0.30; R +1.33, $+1263 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT Asia Low below, FAIL 1H Open below, ACCEPT 1H Open below, no setup armed the proxy way (no internal shift / no acceptance)
- 11-02 12:20 SHORT below 1H Open @28310.0 stop 28371.75 (61.75 pts) C [trap=0 force=0 vol=1 timing=0 band=1] peak 0.39; R +1.33, $+490 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 4H ORL above, ACCEPT 4H ORL below, ACCEPT PDL below, no setup armed the proxy way (no internal shift / no acceptance)
- 11-02 13:10 SHORT below PDL @28217.5 stop 28445.75 (228.25 pts) C [trap=0 force=1 vol=1 timing=0 band=0] peak 0.47; R -1.00, $-458 flat450. first retest (quant.py) yes. Engine: engine saw FAIL PDL above, ACCEPT PDL below, FAIL PDL above, no setup armed the proxy way (no internal shift / no acceptance)
- 11-02 13:40 SHORT below PDL @28224.75 stop 28445.75 (221.00 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.25; R -1.00, $-443 flat450. first retest (quant.py) yes. Engine: engine saw FAIL PDL below, FAIL PDL above, ACCEPT PDL below, no setup armed the proxy way (no internal shift / no acceptance)
- 11-02 20:10 SHORT below 1H Open @28157.5 stop 28183.0 (25.50 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.40; R -1.00, $-418 flat450. first retest (quant.py) yes. Engine: engine armed S1239 accepted-break 1H Open at 11-02 20:40, then SETUP_CANCEL SUPERSEDED: the trap setup on 1H Open replaces it (one idea per direction)
- 11-02 20:35 SHORT below 4H Open @28174.5 stop 28253.25 (78.75 pts) C [trap=0 force=1 vol=1 timing=0 band=0] peak 0.40; R +0.67, $+155 flat450. first retest (quant.py) yes. Engine: engine armed S1240 failed-break 1H Open at 11-02 20:45, then no rejection entry in the window
- 11-02 21:40 SHORT below PDL @28100.0 stop 28253.25 (153.25 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.41; R -1.00, $-308 flat450. first retest (quant.py) yes. Engine: engine armed S1240 failed-break 1H Open at 11-02 20:45, then no rejection entry in the window
- 11-03 00:05 LONG trap 4H Open @28119.75 stop 28033.25 (86.50 pts) B [trap=1 force=1 vol=0 timing=1 band=0] peak 0.21; R +0.67, $+171 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 11-02 23:54 failed-break 4H Open (waveBias)
- 11-03 00:15 LONG trap 4H Open @28146.0 stop 28033.25 (112.75 pts) A+ [trap=1 force=1 vol=1 timing=1 band=0] peak 0.21; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 11-02 23:54 failed-break 4H Open (waveBias)
- 11-03 01:15 LONG trap 1H Open @28181.25 stop 28033.25 (148.00 pts) C [trap=0 force=0 vol=1 timing=0 band=1] peak 0.33; R +1.33, $+591 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 11-03 01:03 failed-break 4H ORH (waveBias)
- 11-03 04:05 SHORT trap 1H Open @28164.75 stop 28253.5 (88.75 pts) C [trap=0 force=1 vol=0 timing=0 band=1] peak 0.32; R -1.00, $-357 flat450. first retest (quant.py) yes. Engine: engine armed S1302 accepted-break London ORH at 11-03 04:10, then SETUP_CANCEL SUPERSEDED: the newer acceptance at 1H Open replaces it
- 11-03 04:25 SHORT trap 4H Open @28225.0 stop 28253.5 (28.50 pts) B [trap=1 force=1 vol=0 timing=0 band=1] peak 0.39; R -1.00, $-408 flat450. first retest (quant.py) yes. Engine: engine GRADE_NO_TRADE 11-03 04:55 accepted-break 4H Open (laneTrigger; waveBias)
- 11-03 06:05 LONG trap Asia High @28293.25 stop 28111.5 (181.75 pts) C [trap=1 force=1 vol=1 timing=0 band=0] peak 0.55; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine SIGNAL_SKIP 11-03 06:09 Asia High: CLIMAX: with-trend entries blocked until structure confirms (§12.5)
- 11-03 06:20 LONG trap Asia High @28310.0 stop 28111.5 (198.50 pts) C [trap=1 force=0 vol=1 timing=0 band=0] peak 0.41; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine SIGNAL_SKIP 11-03 06:09 Asia High: CLIMAX: with-trend entries blocked until structure confirms (§12.5)
- 11-03 06:30 LONG trap 4H Open @28266.25 stop 28111.5 (154.75 pts) C [trap=1 force=1 vol=1 timing=1 band=0] peak 0.55; R +0.67, $-1 flat450. first retest (quant.py) yes. Engine: engine SIGNAL_SKIP 11-03 06:43 Asia High: OPEN_WAIT: NY open wait
- 11-03 08:35 LONG trap 4H Open @28288.25 stop 28245.5 (42.75 pts) C [trap=1 force=1 vol=1 timing=0 band=0] peak 0.55; R +1.33, $+592 flat450. first retest (quant.py) yes. Engine: engine armed S1338 accepted-break 4H Open at 11-03 07:15, then no rejection entry in the window
- 11-03 09:15 LONG trap 1H Open @28386.0 stop 28245.5 (140.50 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.42; R -1.00, $-282 flat450. first retest (quant.py) yes. Engine: engine armed S1354 accepted-break 1H Open at 11-03 09:15, then SETUP_CANCEL SUPERSEDED: the newer acceptance at 4H ORH replaces it
- 11-03 10:20 LONG trap 1H Open @28377.0 stop 28245.5 (131.50 pts) C [trap=0 force=0 vol=0 timing=0 band=0] peak 0.43; R -1.00, $-264 flat450. first retest (quant.py) yes. Engine: engine armed S1381 accepted-break NY ORH at 11-03 10:40, then SETUP_CANCEL RETEST_DEEP: through the level by 19.5
- 11-03 10:30 LONG trap 1H Open @28384.75 stop 28245.5 (139.25 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.24; R -1.00, $-280 flat450. first retest (quant.py) yes. Engine: engine armed S1381 accepted-break NY ORH at 11-03 10:40, then SETUP_CANCEL RETEST_DEEP: through the level by 19.5
- 11-03 12:05 SHORT below Asia High @28264.75 stop 28272.75 (8.00 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.28; R +0.67, $+269 flat450. first retest (quant.py) yes. Engine: engine armed S1392 failed-break 4H ORL at 11-03 11:55, then no rejection entry in the window
- 11-03 15:30 LONG above PDH @28459.25 stop 28404.25 (55.00 pts) C [trap=0 force=0 vol=0 timing=1 band=0] peak 0.48; R -1.00, $-445 flat450. first retest (quant.py) yes. Engine: engine saw ACCEPT 4H Open below, ACCEPT London High below, ACCEPT PDH below, no setup armed the proxy way (no internal shift / no acceptance)
- 11-03 19:45 SHORT below 4H Open @27707.5 stop 27760.0 (52.50 pts) C [trap=0 force=0 vol=1 timing=0 band=0] peak 0.26; R -0.13, $-61 flat450. first retest (quant.py) yes. Engine: engine saw FAIL 4H Open below, FAIL 4H Open above, ACCEPT 4H Open below, no setup armed the proxy way (no internal shift / no acceptance)

## Point definitions that differ (count of disagreements: in different-grade matches / in same-grade matches)

- **trap** 0 / 1: engine TRAP = the trap zone has an obvious pool (4H Open, PDH/PDL, session/OR H/L, EQ>=2) or the sweep crossed >= 2 board/OR levels; proxy = control_kind trap AND level in STRONG or also_in_tol
- **force** 1 / 0: engine FORCE = leg (sweep extreme -> shift close) >= 2x ATR14(5m), or shift bar >= 2x avg20 range; proxy = max 1m excursion beyond the level over the wave >= 2x mean 5m range
- **volume** 1 / 1: engine VOLUME = mean 5m vol after the last internal 5m low/high (forming bar pro-rated) < the shift/break 5m candle; proxy = 5m bars from the wave extreme to the retest vs the break 5m bar
- **timing** 0 / 1: engine TIMING = the SWEEP time (5m bar of the extreme) 0-60 min after 15:00/00:00/06:30; proxy = the ENTRY minute 0-60 min after the open
- **impulseBand** 1 / 0: both 0.30 <= wave peak < 0.40, but the waves differ: engine = readings (bot levelsPro, observedAt=T) from the sweep to the start of the pullback; proxy = readings.csv (python port) from the 1m break close to the retest bar

## The bias input: bot levelsPro (engine) vs readings.csv (proxy's python port), same 1m closes

- minutes compared: 7188. |score15 diff| median / p95 / max: 0.0014 / 0.0084 / 0.0831; |score30 diff|: 0.0008 / 0.0053 / 0.0295.
- minutes where "our-way >= 0.20" differs for either direction: 45 (0.6%).
- board levels that differ (> 0.01 pt), minutes differing / compared: 4H Open 0/7158, PDH 0/7188, PDL 0/7188, Asia High 0/7188, Asia Low 0/7188, London High 0/7188, London Low 0/7188.
- matched trades, wave peak engine vs proxy: 0.46/0.46, 0.45/0.44, 0.40/0.41.
