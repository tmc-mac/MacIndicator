# r3.2 vs r3.1: shadow ledger re-run (in-sample, default cfg, same fixtures and tools)

- r3.1: tide-structure-r3.1 sha256 da0c5c081d1586cc; r3.2: tide-structure-r3.2 sha256 2a2249f17efc202c; money money-r4.1 (both runs, so TP1/TP2 differences are the engine's).
- ledger.csv (r3.2) sha256 ba5183241482250072108dd015df2d9aefdfa24fa90b71488e7826ee24a97f37

## Totals

- r3.1 all: 20 signals (A+ 1 / B 5 / C 14): proxy 1R/2R +9.00R verbatim, +9.00R with the 13:05 flat; flat $450 proxy $+3490 verbatim, $+3490 with the 13:05 flat; REAL exit plan conservative $+2664 (+6.36R) / optimistic $+4130 (+10.50R), 9 trades with 9 ambiguous 1m bars
- r3.2 all: 22 signals (A+ 2 / B 6 / C 14): proxy 1R/2R +9.33R verbatim, +9.33R with the 13:05 flat; flat $450 proxy $+3434 verbatim, $+3434 with the 13:05 flat; REAL exit plan conservative $+3561 (+9.61R) / optimistic $+3988 (+10.68R), 7 trades with 7 ambiguous 1m bars
- r3.1 taken-if-flat: 20 signals (A+ 1 / B 5 / C 14): proxy 1R/2R +9.00R verbatim, +9.00R with the 13:05 flat; flat $450 proxy $+3490 verbatim, $+3490 with the 13:05 flat; REAL exit plan conservative $+2664 (+6.36R) / optimistic $+4130 (+10.50R), 9 trades with 9 ambiguous 1m bars
- r3.2 taken-if-flat: 22 signals (A+ 2 / B 6 / C 14): proxy 1R/2R +9.33R verbatim, +9.33R with the 13:05 flat; flat $450 proxy $+3434 verbatim, $+3434 with the 13:05 flat; REAL exit plan conservative $+3561 (+9.61R) / optimistic $+3988 (+10.68R), 7 trades with 7 ambiguous 1m bars

- **Session close (live-executor.js sessionClose):** no new entries 12:55 -> 15:00 PT, flat at 13:05 PT (Topstep: flat by 13:10). The engine itself DOES emit signals in that window (it has no session clock): 10-29 12:58 LONG failed-break B, 11-03 13:33 LONG accepted-break C. They are SESSION_CLOSE (not taken) here and are left out of every total; live, the executor blocks them.
- **14:00 flat finding:** the proxy walk (risk.py r2exit / risk_int.py parts) flattens on a bar with PT minute 840-899, but the data has no 14:00-14:59 bars, so it never fires; 0 r3.2 / 0 r3.1 signals ride past the close into the next session in the verbatim columns. The `sc_*` columns and the REAL exit flatten at the 13:05 bar open. The risk_int.py study has the same issue.
- REAL exit = money money-r4.1 planExits as lib/tideWire.js calls it (pools = targets, partialPools = non-major targets), whole contracts at flat $450, TP1 partial (a 1-lot has no TP1 order: TP1 is its BE trigger), stop to BE + 1 tick after TP1, the rest at TP2; flat at the 13:05 bar open, $0.62/side; no ladder, trail or adds. A 1m bar whose OHLC cannot order two events (stop + TP1, TP1 + BE, BE/stop + TP2) is flagged and the trade is run both ways: conservative (the adverse event first) and optimistic (the favourable first); both bounds are in ledger.csv (real_* = conservative, real_opt_* = optimistic, ambiguous_bars_pt).

## TP1 distance (R) and source

- r3.1: n 20, min 0.01R, median 0.39R, < 0.5R 14 (70%), < 1R 18 (90%). Source: Round 12, opening range 6, 1R (no pool inside 1R) 2
- r3.2: n 24, min 0.01R, median 0.57R, < 0.5R 10 (42%), < 1R 15 (62%). Source: 1R (no pool inside 1R) 9, opening range 9, 4H period extreme 4, swing (1H/4H) 1, 1H Open 1

## Signals added in r3.2 (5)

- 10-29 04:47 SHORT failed-break 4H Open A+(4) @29653.75 stop 29737.25 TP1 4H ORL + 4H ORL 29653 TP2 Asia Low + Asia Low + 1H swing low + 4H swing low 29483.25; why: r3.1 RETEST_2_SKIP at the same minute: the first retest is now counted per break
- 10-29 12:58 LONG failed-break 4H Open B(3) @29551 stop 29450.25 TP1 4H period high 29561 TP2 1H swing high 29764.75; why: r3.1 RETEST_2_SKIP at the same minute: the first retest is now counted per break
- 10-29 17:13 SHORT failed-break PDL C(2) @29075.75 stop 29136 TP1 1R 29015.5 TP2 2R 28955.25; why: r3.1 RETEST_2_SKIP at the same minute: the first retest is now counted per break
- 11-01 23:40 SHORT failed-break 4H Open B(3) @28732.5 stop 28803.25 TP1 4H period low 28728 TP2 Asia ORL + Asia Low + Asia ORL 28582.75; why: r3.1 RETEST_2_SKIP at the same minute: the first retest is now counted per break
- 11-03 13:33 LONG accepted-break 4H ORH C(1) @28413.5 stop 28269.5 TP1 1H swing high 28443.75 TP2 1H swing high 28803.25; why: no r3.1 setup at that minute (upstream: control / zone / retest count changed)

## Signals removed in r3.2 (1)

- 10-30 01:04 SHORT accepted-break 4H ORL C(2) @28918.25 stop 28953 TP1 Round 28900 TP2 EQL 28835; why: no r3.2 setup at that minute (upstream: control / zone / earlier trade changed)

## Signals changed (18 of 19 kept)

- 10-27 20:03 LONG failed-break 4H Open C(2) @29889.25 stop 29838.75 TP1 1R 29939.75 TP2 2R 29990.25: TP1 Round 29900 -> 1R 29939.75; TP2 Round 30000 -> 2R 29990.25
- 10-28 12:43 LONG accepted-break PDH C(2) @29918.5 stop 29877 TP1 London ORL 29941.75 TP2 2R 30001.5: TP2 Round 30050 -> 2R 30001.5
- 10-28 16:01 SHORT accepted-break PDL C(1) @29652.25 stop 29682 TP1 4H ORL + Asia ORL + Asia ORL + 4H ORL 29635.25 TP2 1H swing low 29494: TP1 Round 29650 -> 4H ORL + Asia ORL + Asia ORL + 4H ORL 29635.25; TP2 Round 29550 -> 1H swing low 29494
- 10-28 16:38 SHORT accepted-break 1H Open C(2) @29633.75 stop 29737.75 TP1 1R 29529.75 TP2 1H swing low 29411.5: TP1 Round 29600 -> 1R 29529.75
- 10-28 23:45 SHORT failed-break PDL B(3) @29635.75 stop 29685 TP1 Asia ORL + Asia ORL 29635.25 TP2 1H swing low 29494: TP2 Round 29500 -> 1H swing low 29494
- 10-29 15:40 SHORT accepted-break PDL C(2) @29098.5 stop 29112.5 TP1 4H ORL + Asia ORL + Asia ORL + 4H ORL 29090.5 TP2 4H swing low 29027.25: TP2 Round 29050 -> 4H swing low 29027.25
- 10-30 04:16 SHORT accepted-break 1H Open C(2) @28834 stop 28862.75 TP1 1R 28805.25 TP2 2R 28776.5: TP2 Round 28750 -> 2R 28776.5
- 11-01 16:27 LONG accepted-break 4H ORH B(3) @28688 stop 28661.5 TP1 1R 28714.5 TP2 London Low + London Low 28754.25: TP1 Round 28700 -> 1R 28714.5; TP2 Round 28750 -> London Low + London Low 28754.25
- 11-02 03:55 SHORT failed-break EQH C(2) @28749.75 stop 28793.25 TP1 London ORL + London ORL 28728.25 TP2 Asia Low + Asia Low + Asia ORL 28582.75: TP2 Round 28650 -> Asia Low + Asia Low + Asia ORL 28582.75
- 11-02 09:03 SHORT accepted-break London Low C(2) @28660.25 stop 28688.5 TP1 NY ORL + NY ORL 28639.75 TP2 Asia Low + Asia Low + Asia ORL 28582.75: TP1 Round 28650 -> NY ORL + NY ORL 28639.75; TP2 Round 28600 -> Asia Low + Asia Low + Asia ORL 28582.75
- 11-02 20:15 SHORT failed-break 4H ORL C(3) @28160.5 stop 28183 TP1 4H period low 28150 TP2 PDL + EQL + PDL + 1H swing low + 4H swing low 28101.25: TP1 Round + 4H period low 28150 -> 4H period low 28150
- 11-02 20:55 SHORT failed-break 1H Open B(3) @28121.5 stop 28200.25 TP1 1R 28042.75 TP2 2R 27964: TP1 Round 28100 -> 1R 28042.75; TP2 Round 27950 -> 2R 27964
- 11-03 01:35 LONG accepted-break London ORH B(3) @28180.5 stop 28131 TP1 1R 28230 TP2 Asia High + Asia High + Asia ORH 28284.25: TP1 Round 28200 -> 1R 28230
- 11-03 07:36 LONG accepted-break 4H Open C(3) @28319.5 stop 28286.25 TP1 1R 28352.75 TP2 London High + London High 28426.5: TP1 Round 28350 -> 1R 28352.75; TP2 Round 28400 -> London High + London High 28426.5
- 11-03 09:19 LONG accepted-break 4H ORH C(2) @28384.75 stop 28333 TP1 NY ORH + NY ORH 28385.75 TP2 1H swing high 28803.25: TP2 Round 28500 -> 1H swing high 28803.25
- 11-03 10:03 LONG accepted-break 1H Open C(2) @28382.5 stop 28355 TP1 NY ORH + NY ORH 28385.75 TP2 1H swing high 28803.25: TP2 Round 28450 -> 1H swing high 28803.25
- 11-03 12:04 SHORT failed-break 4H ORL B(3) @28254 stop 28272.75 TP1 4H period low 28235.75 TP2 NY ORL + NY ORL 28213: TP1 Round 28250 -> 4H period low 28235.75
- 11-03 16:08 SHORT failed-break 4H Open A+(4) @28366.75 stop 28513 TP1 1H Open 28324.5 TP2 PDL + PDL + 1H swing low + 4H swing low 28035.25: TP1 Round 28350 -> 1H Open 28324.5

## The 16 r3.1 trap -> opposite-trap CONTROL_FLIPs and what each becomes in r3.2

| r3.1 flip (PT) | old -> new | r3.2 at that minute | r3.2 old trap control then |
|---|---|---|---|
| 10-28 09:05 | SELL trap ext 29874.25 -> BUY trap ext 29825.5 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 10-28 09:55) |
| 10-28 09:10 | BUY trap ext 29825.5 -> SELL trap ext 29865.75 | nothing to flip: r3.2 still holds the earlier trap (this was r3.1 flipping back) | held until its extreme was taken back (VOID 10-28 09:55) |
| 10-28 13:25 | BUY trap ext 29821.5 -> SELL trap ext 29880.25 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 10-28 13:28), then SELL 29880.25 trap FORM 10-28 13:28 |
| 10-29 02:25 | SELL trap ext 29734.5 -> BUY trap ext 29647.75 | CONTROL_HOLD (blocked) | held to the 4H close (10-29 03:01) |
| 10-29 02:30 | BUY trap ext 29647.75 -> SELL trap ext 29705.5 | nothing to flip: r3.2 still holds the earlier trap (this was r3.1 flipping back) | held to the 4H close (10-29 03:01) |
| 10-29 04:25 | SELL trap ext 29718.5 -> BUY trap ext 29682 | CONTROL_HOLD (blocked) | held to the 4H close (10-29 07:01) |
| 10-29 09:50 | BUY trap ext 29448.25 -> SELL trap ext 29571.25 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 10-29 10:55), then SELL 29604.75 trap FORM 10-29 10:55 |
| 10-29 10:10 | BUY trap ext 29532.75 -> SELL trap ext 29604.75 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 10-29 10:55), then SELL 29604.75 trap FORM 10-29 10:55 |
| 10-29 12:15 | BUY trap ext 29424.75 -> SELL trap ext 29491 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 10-29 13:02) |
| 10-29 12:25 | SELL trap ext 29491 -> BUY trap ext 29443 | nothing to flip: r3.2 still holds the earlier trap (this was r3.1 flipping back) | held until its extreme was taken back (VOID 10-29 13:02) |
| 10-30 02:05 | BUY trap ext 28971 -> SELL trap ext 29007.75 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 10-30 02:06), then SELL 29007.75 trap FORM 10-30 02:06 |
| 11-01 22:50 | SELL trap ext 28792 -> BUY trap ext 28759.5 | CONTROL_HOLD (blocked) | held to the 4H close (11-01 23:01) |
| 11-01 22:55 | BUY trap ext 28759.5 -> SELL trap ext 28785.5 | nothing to flip: r3.2 still holds the earlier trap (this was r3.1 flipping back) | held to the 4H close (11-01 23:01) |
| 11-02 01:40 | SELL trap ext 28801.25 -> BUY trap ext 28762.5 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 11-02 01:51), then BUY 28762.5 trap FORM 11-02 01:51 |
| 11-02 06:15 | BUY trap ext 28683.25 -> SELL trap ext 28781.5 | CONTROL_HOLD (blocked) | held until its extreme was taken back (VOID 11-02 06:33), then SELL 28781.5 trap FORM 11-02 06:33 |
| 11-02 16:45 | BUY trap ext 28132 -> SELL trap ext 28242.5 | CONTROL_HOLD (blocked) | held to the 4H close (11-02 19:01) |

## TP1 floor variants (SMALL SAMPLE: n = 22 in-sample signals, 6 TradeDays; for a decision aid, not a result)

Same signals and TP2; whole contracts at flat $450; flat at 13:05; $0.62/side; the SESSION_CLOSE signals are out. cons / opt = the two intrabar bounds. win / BE / loss by net R (> +0.05 / within 0.05 / < -0.05). Note: partialFor never picks a pool beyond 1R (it caps TP1 at 1R), so (c-lib) is 1R in practice; (c) computes the intended rule in the tool.

| rule | n | $ flat450 cons / opt | R cons / opt | win / BE / loss (cons) | win / BE / loss (opt) | BE-stopped after TP1 cons / opt | median TP1 R | TP1 < 0.5R |
|---|---|---|---|---|---|---|---|---|
| (a) as now | 22 | +3561 / +3988 | +9.61 / +10.68 | 15 / 4 / 3 | 15 / 4 / 3 | 14 / 13 | 0.73 | 8 |
| (b) skip pools < 0.5R | 22 | +2853 / +3280 | +8.10 / +9.17 | 16 / 0 / 6 | 16 / 0 / 6 | 11 / 10 | 1.00 | 0 |
| (c-lib) pools < 1R dropped via partialFor (its 1R cap -> 1R) | 22 | +3250 / +3677 | +9.06 / +10.13 | 16 / 0 / 6 | 16 / 0 / 6 | 11 / 10 | 1.00 | 0 |
| (c) first pool at >= 1R before TP2, else 1R | 22 | +3838 / +3838 | +10.93 / +10.93 | 15 / 0 / 7 | 15 / 0 / 7 | 8 / 8 | 1.00 | 0 |
