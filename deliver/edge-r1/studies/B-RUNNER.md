# B-RUNNER: what the bot leaves after TP1, and which runner rule to test (quant desk B, 11/11)

Analysis only. Nothing in the bot, the rig or any repo was touched. Scripts: `edge/b/build.py` (cohort + bars), `edge/b/runner.py` (all tables), `edge/b/ny.py` (concentration check). Per-trade results: `edge/b/per_trade.json`.

## Summary

1. **The live runner pays less than the TP1 lots it rides with.** 68 runners: median +10.0 pts, 76% out at +10.5 or less, 57% out within 60 s of TP1; mean 14.4 pts against a TP1 of +15 / +20. Closing all contracts at TP1 would have paid +$350 more over the 6 TradeDays (trade-bootstrap CI −$46 to +$688; day-bootstrap +$106 to +$622). The 12 newest trades (11/09–11/10, desk C ledger) look the same: 11 of 12 at +10.5 or less.
2. **Price does keep going after TP1, but it comes back first about half the time.** Median further move beyond TP1: +22 pts in 15 min, +42 in 60 min, +65 by session close. From TP1, +30 came before a return to entry on 59% of trades (40 of 68; same in both halves: 56% / 62%). That is close to a coin flip from where TP1 sits, so fixed-point rules (c, d, e30, e40) come out near zero: every CI includes $0 in the favourable walk and most are negative in the pessimistic walk.
3. **The money is in NY / high-volatility trades, and only with a wide ATR-sized target.** Runner stop at entry +2 with TP2 = 2.0 x 15m ATR: NY n=18 (small), +$1,240 against live (CI +$216 to +$2,412) in walk N and +$907 in walk P; positive in both date halves in both walks (+$560 / +$680 N; +$560 / +$347 P). Outside NY the same rule is −$44 (N) / −$246 (P) on n=47. **Caveat: 3 trades on 2 days (10/30, 11/02) carry $905 of the $1,240; 12 of the 18 NY trades end worse than live (about −$16 each, the cost of stop +2 against +10).**
4. **The structural target is not a usable runner target as it stands.** It is beyond TP1 on only 42 of 68 trades (median 22 pts from the fill; behind the fill on 6). Where it is beyond TP1 it was reached before a return to entry on 43% (18 of 42).
5. **"1 off at TP1, 2 run" loses under the live runner rule**: −$358 on 63 three-lot trades (CI −$654 to −$10), worse on 52 of 63. Under the hold-to-close rule (b2) it shows +$2,085 but the CI is −$556 to +$5,418 and it is worse on 53 of 63 trades (−$1,568 on those). Not supported.
6. **Profit-securing holds for every rule tested**: the worst runner exit is the rule's own stop (+2, +5 or +10); no runner exit below fees in either walk.

## What I would test live first

**NY session only (entries 06:30–12:55 PT): runner stop at entry +2 pts, TP2 at 2.0 x ATR15 from the fill, flatten at 12:55 PT. Asia and London: leave as they are.** ATR15 = mean true range of the 14 completed 15m bars before the entry (NY median 82 pts, so TP2 is typically +150 to +165).
- On this data: +$1,033 per week in walk N, +$756 per week in walk P (18 NY trades in 6 TradeDays, scaled to 5).
- CI for walk N, per week: about +$180 to +$2,010. Small n; two days carry it.
- What it costs when it fails: the runner pays +2 instead of +10 (−$16 per trade); 12 of 18 NY trades.
- A simpler volatility switch gives the same picture: top ATR tercile (ATR15 above 59.7 pts, n=22, 12 of them NY): +$1,415 (CI +$317 to +$2,652) N, +$1,081 P.
- Not checked: the runner holds the bot's one position for longer (median 4 min, 1 in 10 over 75 min). On the whole cohort this rule would have blocked 32 later live trades that netted −$252 together. The sign of that figure moved between −$531 and +$709 across rules, so treat it as unknown.

## Limits

- **1m bars cannot say what happened inside the TP1 bar after the fill.** Two walks bracket it. N starts at the bar after TP1 (if that bar opens through the stop, the stop is taken as hit at its price). P also walks the TP1 bar as if its whole adverse range came after the fill. For the live rule, N gives $2,236, P gives $1,508 and the real fills were $1,952: the truth is between, nearer N. Any finding that changes sign between N and P is not a finding.
- 6 TradeDays, 68 runners. TP1 was +20 on the first 22 trades and +15 on the last 46.
- HTF agreement is 3/3 on every trade in the cohort, so that split cannot be made.
- The brief's 12.86 pts live average is not what this cohort shows (14.36 mean, 10.0 median); a few +50 / +60 runners lift the mean.
- Stops are filled at the stop price (no slippage). Fees are identical across rules (same contracts, same fills).
- The 11/09–11/10 trades have no 1m bars here (bars end 11/06); they are in the baseline only. One of them carries TRAIL_RATCHET codes and a +40 runner, so the live trail may behave differently in the newest build.
- Section 6 headers show each group's full n; 3 trades have no ATR (bars start too late before the entry) and are left out of the ATR rows (n=65).

## Concentration check for the ATR rules (and b2)

Columns: change vs live $, the top 3 trades' share of it, the rest, trades better / worse than live, date halves, by TradeDay.

| rule | group | walk | n | change vs live $ | top 3 trades $ | all other trades $ | better / worse | H1 / H2 | by TradeDay |
|---|---|---|---|---|---|---|---|---|---|
| h1 | NY | N | 18 | +810 | +654 | +156 | 6 / 12 | +379 (n=6) / +431 (n=12) | 10-28 +16, 10-30 +347, 11-02 +478, 11-03 -31 |
| h1 | NY | P | 18 | +561 | +590 | -30 | 5 / 13 | +379 (n=6) / +182 (n=12) | 10-28 +16, 10-30 +347, 11-02 +229, 11-03 -31 |
| h1 | T3 high | N | 22 | +925 | +654 | +270 | 7 / 15 | +487 (n=9) / +438 (n=13) | 10-28 +60, 10-29 +80, 10-30 +331, 11-02 +544, 11-03 -46, 11-04 -45 |
| h1 | T3 high | P | 22 | +675 | +590 | +85 | 6 / 16 | +487 (n=9) / +188 (n=13) | 10-28 +60, 10-29 +80, 10-30 +331, 11-02 +295, 11-03 -46, 11-04 -45 |
| h1 | not NY | N | 47 | +240 | +378 | -138 | 10 / 37 | +347 (n=28) / -106 (n=19) | 10-28 +71, 10-29 +133, 10-30 +143, 11-02 -64, 11-03 +3, 11-04 -45 |
| h1 | not NY | P | 47 | -180 | +376 | -556 | 7 / 40 | +45 (n=28) / -225 (n=19) | 10-28 +71, 10-29 -18, 10-30 -8, 11-02 -64, 11-03 -116, 11-04 -45 |
| h2 | NY | N | 18 | +1240 | +905 | +336 | 6 / 12 | +560 (n=6) / +680 (n=12) | 10-28 +16, 10-30 +528, 11-02 +727, 11-03 -31 |
| h2 | NY | P | 18 | +907 | +854 | +53 | 5 / 13 | +560 (n=6) / +347 (n=12) | 10-28 +16, 10-30 +528, 11-02 +394, 11-03 -31 |
| h2 | T3 high | N | 22 | +1415 | +905 | +510 | 7 / 15 | +728 (n=9) / +687 (n=13) | 10-28 +60, 10-29 +139, 10-30 +512, 11-02 +793, 11-03 -46, 11-04 -45 |
| h2 | T3 high | P | 22 | +1081 | +854 | +227 | 6 / 16 | +728 (n=9) / +353 (n=13) | 10-28 +60, 10-29 +139, 10-30 +512, 11-02 +460, 11-03 -46, 11-04 -45 |
| h2 | not NY | N | 47 | -44 | +544 | -588 | 6 / 41 | +137 (n=28) / -181 (n=19) | 10-28 -46, 10-29 -108, 10-30 +290, 11-02 -64, 11-03 -72, 11-04 -45 |
| h2 | not NY | P | 47 | -246 | +535 | -780 | 5 / 42 | -65 (n=28) / -181 (n=19) | 10-28 -46, 10-29 -108, 10-30 +89, 11-02 -64, 11-03 -72, 11-04 -45 |
| g2 | NY | N | 18 | +1721 | +1729 | -8 | 6 / 12 | +1379 (n=6) / +342 (n=12) | 10-28 +16, 10-30 +1356, 11-02 +380, 11-03 -31 |
| g2 | NY | P | 18 | +1332 | +1484 | -152 | 5 / 13 | +1379 (n=6) / -47 (n=12) | 10-28 +16, 10-30 +1347, 11-02 +0, 11-03 -31 |
| g2 | T3 high | N | 22 | +1744 | +1729 | +15 | 7 / 15 | +1396 (n=9) / +348 (n=13) | 10-28 +60, 10-29 -12, 10-30 +1340, 11-02 +446, 11-03 -46, 11-04 -45 |
| g2 | T3 high | P | 22 | +1355 | +1484 | -129 | 6 / 16 | +1396 (n=9) / -40 (n=13) | 10-28 +60, 10-29 -12, 10-30 +1331, 11-02 +66, 11-03 -46, 11-04 -45 |
| g2 | not NY | N | 47 | -12 | +486 | -498 | 9 / 38 | +187 (n=28) / -198 (n=19) | 10-28 -3, 10-29 -109, 10-30 +299, 11-02 -45, 11-03 -108, 11-04 -45 |
| g2 | not NY | P | 47 | -346 | +376 | -722 | 7 / 40 | -110 (n=28) / -236 (n=19) | 10-28 -3, 10-29 -212, 10-30 +105, 11-02 -45, 11-03 -146, 11-04 -45 |
| b2 | NY | N | 18 | +2734 | +2460 | +274 | 5 / 13 | +453 (n=6) / +2281 (n=12) | 10-28 +16, 10-30 +421, 11-02 +2328, 11-03 -31 |
| b2 | NY | P | 18 | +1976 | +2167 | -191 | 4 / 14 | +453 (n=6) / +1523 (n=12) | 10-28 +16, 10-30 +421, 11-02 +1570, 11-03 -31 |
| b2 | T3 high | N | 22 | +2674 | +2460 | +213 | 5 / 17 | +386 (n=9) / +2288 (n=13) | 10-28 +60, 10-29 -96, 10-30 +405, 11-02 +2394, 11-03 -46, 11-04 -45 |
| b2 | T3 high | P | 22 | +1916 | +2167 | -252 | 4 / 18 | +386 (n=9) / +1530 (n=13) | 10-28 +60, 10-29 -96, 10-30 +405, 11-02 +1636, 11-03 -46, 11-04 -45 |
| b2 | not NY | N | 47 | -523 | +420 | -944 | 4 / 43 | -298 (n=28) / -224 (n=19) | 10-28 -46, 10-29 -342, 10-30 +90, 11-02 -64, 11-03 -116, 11-04 -45 |
| b2 | not NY | P | 47 | -748 | +277 | -1025 | 3 / 44 | -524 (n=28) / -224 (n=19) | 10-28 -46, 10-29 -342, 10-30 -135, 11-02 -64, 11-03 -116, 11-04 -45 |

## 0. Cohort

- TP1-hit levels trades, TradeDays 10-28 to 11-04: 70 trades; 68 have a runner and 1m bars at TP1 (2 excluded: 1-lot trades with nothing left after TP1).
- TradeDays: 10-28, 10-29, 10-30, 11-02, 11-03, 11-04 (6 days). Halves by date: H1 n=34 (10-27 to 10-30), H2 n=34 (10-30 to 11-03).
- TP1 distance: +20 on 22 trades (to 10-29 17:46 PT), +15 on 46 (the current rule). HTF agreement is 3/3 on all 70 trades.
- Runner contracts: {1: 68}. Bars: 15185 1m OHLC bars, 10-22 to 11-07 (replay rig file + TradingView MNQ1! pulls).

## 1. Baseline: what the live runner did

| cohort | n | runner pts mean | p25 | p50 | p75 | max | secs TP1 to exit p50 | p75 | exit within 60 s | exit at +10.5 or less |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 68 | 14.36 | 9.69 | 10.00 | 10.00 | 60.0 | 53 | 147 | 57% | 76% |
| TP1 +20 era | 22 | 15.08 | 9.75 | 10.00 | 17.12 | 60.0 | 90 | 176 | 45% | 73% |
| TP1 +15 era | 46 | 14.01 | 9.56 | 10.00 | 10.00 | 60.0 | 47 | 129 | 63% | 78% |
| H1 | 34 | 15.38 | 9.56 | 10.00 | 17.12 | 60.0 | 61 | 145 | 50% | 74% |
| H2 | 34 | 13.33 | 9.75 | 9.88 | 10.00 | 50.0 | 26 | 143 | 65% | 79% |

## 2. Continuation after TP1 (1m bars from the bar after the TP1 bar)

Further favourable move beyond the TP1 price, pts (0 = never traded beyond TP1 again):

| horizon | n | p25 | p50 | p75 | p90 | share that went +10 or more beyond TP1 | lowest point seen, p50 (pts from entry) | p25 |
|---|---|---|---|---|---|---|---|---|
| 5 min / all | 68 | 5.2 | 14.8 | 25.9 | 37.5 | 59% | 1.6 | -7.6 |
| 5 min / H1 | 34 | 5.0 | 11.5 | 18.6 | 34.1 | 56% | 1.6 | -5.4 |
| 5 min / H2 | 34 | 5.5 | 16.4 | 30.1 | 37.1 | 62% | 2.2 | -9.0 |
| 15 min / all | 68 | 7.7 | 22.1 | 38.5 | 59.1 | 72% | -5.4 | -16.6 |
| 15 min / H1 | 34 | 7.9 | 22.1 | 39.1 | 48.0 | 71% | -1.2 | -13.2 |
| 15 min / H2 | 34 | 7.8 | 22.1 | 35.9 | 64.0 | 74% | -8.2 | -25.2 |
| 30 min / all | 68 | 14.9 | 35.6 | 55.2 | 79.5 | 78% | -11.2 | -33.7 |
| 30 min / H1 | 34 | 16.4 | 40.4 | 56.9 | 74.7 | 79% | -1.4 | -23.7 |
| 30 min / H2 | 34 | 13.1 | 24.9 | 47.5 | 82.1 | 76% | -14.6 | -38.2 |
| 60 min / all | 68 | 19.5 | 42.0 | 64.8 | 143.5 | 85% | -13.9 | -47.9 |
| 60 min / H1 | 34 | 20.5 | 43.0 | 70.9 | 165.5 | 85% | -12.0 | -42.7 |
| 60 min / H2 | 34 | 19.9 | 35.4 | 62.4 | 114.2 | 85% | -21.5 | -55.1 |
| to session close / all | 68 | 32.6 | 64.5 | 171.7 | 461.5 | 93% | -52.6 | -97.1 |
| to session close / H1 | 34 | 34.6 | 67.5 | 161.1 | 224.1 | 91% | -41.1 | -82.4 |
| to session close / H2 | 34 | 31.9 | 64.5 | 184.2 | 538.6 | 94% | -71.6 | -123.1 |

Race to session close: which came first (a bar that touches both counts for the adverse side). Cells: favourable first / adverse first / neither.


**all** (n=68)

| back to first \ target first | +25 | +30 | +40 | structural target (only where it is beyond TP1) |
|---|---|---|---|---|
| +0 | 42 / 25 / 1 (62% of 68) | 40 / 27 / 1 (59% of 68) | 29 / 37 / 2 (43% of 68) | 18 / 24 / 0 (43% of 42) |
| +5 | 36 / 32 / 0 (53% of 68) | 33 / 35 / 0 (49% of 68) | 22 / 45 / 1 (32% of 68) | 16 / 26 / 0 (38% of 42) |
| +10 | 30 / 38 / 0 (44% of 68) | 25 / 43 / 0 (37% of 68) | 16 / 51 / 1 (24% of 68) | 15 / 27 / 0 (36% of 42) |

**TP1 +15 era** (n=46)

| back to first \ target first | +25 | +30 | +40 | structural target (only where it is beyond TP1) |
|---|---|---|---|---|
| +0 | 27 / 18 / 1 (59% of 46) | 27 / 18 / 1 (59% of 46) | 18 / 26 / 2 (39% of 46) | 15 / 17 / 0 (47% of 32) |
| +5 | 23 / 23 / 0 (50% of 46) | 22 / 24 / 0 (48% of 46) | 14 / 31 / 1 (30% of 46) | 13 / 19 / 0 (41% of 32) |
| +10 | 18 / 28 / 0 (39% of 46) | 16 / 30 / 0 (35% of 46) | 10 / 35 / 1 (22% of 46) | 12 / 20 / 0 (38% of 32) |

**H1** (n=34)

| back to first \ target first | +25 | +30 | +40 | structural target (only where it is beyond TP1) |
|---|---|---|---|---|
| +0 | 21 / 13 / 0 (62% of 34) | 19 / 15 / 0 (56% of 34) | 15 / 19 / 0 (44% of 34) | 6 / 11 / 0 (35% of 17) |
| +5 | 19 / 15 / 0 (56% of 34) | 17 / 17 / 0 (50% of 34) | 12 / 22 / 0 (35% of 34) | 6 / 11 / 0 (35% of 17) |
| +10 | 17 / 17 / 0 (50% of 34) | 14 / 20 / 0 (41% of 34) | 9 / 25 / 0 (26% of 34) | 6 / 11 / 0 (35% of 17) |

**H2** (n=34)

| back to first \ target first | +25 | +30 | +40 | structural target (only where it is beyond TP1) |
|---|---|---|---|---|
| +0 | 21 / 12 / 1 (62% of 34) | 21 / 12 / 1 (62% of 34) | 14 / 18 / 2 (41% of 34) | 12 / 13 / 0 (48% of 25) |
| +5 | 17 / 17 / 0 (50% of 34) | 16 / 18 / 0 (47% of 34) | 10 / 23 / 1 (29% of 34) | 10 / 15 / 0 (40% of 25) |
| +10 | 13 / 21 / 0 (38% of 34) | 11 / 23 / 0 (32% of 34) | 7 / 26 / 1 (21% of 34) | 9 / 16 / 0 (36% of 25) |

Structural target distance from the fill: p25 10.8, p50 22.0, p75 53.2, p90 146.0 pts. It is beyond TP1 on 42 of 68 trades; on 6 it was already behind the fill.

## 3. Runner rule counterfactuals

Two walks per rule. **N** = from the bar after the TP1 bar (the brief's rule). **P** = pessimistic: the TP1 bar itself is walked too, as if its whole adverse range came after the TP1 fill. The truth sits between them; rule (a) against the realised live figure shows which is closer.


**Walk N: next bar onward; all runners, n=68, 6 TradeDays. $ are runner $ ($2/pt per contract).**

| rule | n | runner pts/trade | runner $ | live runner $ | change vs live $ | 95% CI trade bootstrap | 95% CI day bootstrap | worst runner pts | $ per week (5 days) | exits | hold min p50 / p90 | live trades it would have blocked: n, their net $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a  live: stop +10, trail 10 in 10-pt steps | 68 | 16.44 | 2236 | 1952 | +284 | +62 to +502 | +101 to +484 | +10.00 | +237 | {'stop': 54, 'gap-stop': 3, 'stop in TP1 bar': 10, 'time': 1} | 1 / 4 | 2, -159 |
| b  stop +2, structural target, session time stop | 68 | 17.24 | 2345 | 1952 | +393 | -182 to +1034 | -421 to +1270 | +2.00 | +327 | {'target': 18, 'tgt<=TP1': 26, 'stop': 22, 'stop in TP1 bar': 2} | 1 / 8 | 13, -81 |
| b2 stop +2, no target, session time stop | 68 | 31.79 | 4324 | 1952 | +2371 | -244 to +5890 | -1006 to +7396 | +2.00 | +1976 | {'stop': 54, 'time': 11, 'stop in TP1 bar': 3} | 4 / 195 | 69, -531 |
| c  stop +5, trail 15 | 68 | 16.24 | 2208 | 1952 | +256 | -44 to +604 | +23 to +508 | +5.00 | +213 | {'stop': 61, 'stop in TP1 bar': 3, 'time': 1, 'gap-stop': 3} | 2 / 6 | 6, +90 |
| d  stop +2; at +30 stop +15, then trail 20 | 68 | 15.73 | 2140 | 1952 | +187 | -212 to +638 | -119 to +604 | +2.00 | +156 | {'stop': 62, 'stop in TP1 bar': 3, 'time': 1, 'gap-stop': 2} | 2 / 10 | 14, +627 |
| e30 stop +2, TP2 +30 | 68 | 17.24 | 2344 | 1952 | +392 | -48 to +836 | -10 to +850 | +2.00 | +326 | {'target': 37, 'stop': 28, 'stop in TP1 bar': 3} | 1 / 5 | 7, +552 |
| e40 stop +2, TP2 +40 | 68 | 17.54 | 2385 | 1952 | +432 | -86 to +966 | +76 to +884 | +2.00 | +360 | {'stop': 37, 'target': 27, 'stop in TP1 bar': 3, 'time': 1} | 2 / 8 | 12, +464 |
| f  no runner: all contracts out at TP1 | 68 | 16.93 | 2302 | 1952 | +350 | -46 to +688 | +106 to +622 | +15.00 | +291 | {'out at TP1': 68} | -0 / -0 | 0, +0 |

**Walk P: TP1 bar included, adverse first; all runners, n=68, 6 TradeDays. $ are runner $ ($2/pt per contract).**

| rule | n | runner pts/trade | runner $ | live runner $ | change vs live $ | 95% CI trade bootstrap | 95% CI day bootstrap | worst runner pts | $ per week (5 days) | exits | hold min p50 / p90 | live trades it would have blocked: n, their net $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a  live: stop +10, trail 10 in 10-pt steps | 68 | 11.09 | 1508 | 1952 | -444 | -821 to -130 | -769 to -102 | +10.00 | -370 | {'stop': 67, 'gap-stop': 1} | -1 / 0 | 0, +0 |
| b  stop +2, structural target, session time stop | 68 | 15.92 | 2165 | 1952 | +213 | -333 to +901 | -418 to +826 | +2.00 | +177 | {'target': 16, 'tgt<=TP1': 26, 'stop': 26} | -0 / 4 | 10, +380 |
| b2 stop +2, no target, session time stop | 68 | 24.56 | 3340 | 1952 | +1388 | -894 to +4350 | -1053 to +5092 | +2.00 | +1157 | {'stop': 59, 'time': 9} | 2 / 119 | 56, -243 |
| c  stop +5, trail 15 | 68 | 10.56 | 1436 | 1952 | -517 | -900 to -175 | -962 to -199 | +5.00 | -431 | {'stop': 66, 'gap-stop': 2} | -0 / 4 | 3, -81 |
| d  stop +2; at +30 stop +15, then trail 20 | 68 | 10.72 | 1458 | 1952 | -494 | -915 to -56 | -852 to -148 | +2.00 | -412 | {'stop': 67, 'gap-stop': 1} | 1 / 9 | 10, +380 |
| e30 stop +2, TP2 +30 | 68 | 13.12 | 1784 | 1952 | -168 | -672 to +318 | -472 to +118 | +2.00 | -140 | {'target': 27, 'stop': 41} | 0 / 4 | 5, +459 |
| e40 stop +2, TP2 +40 | 68 | 12.51 | 1701 | 1952 | -252 | -780 to +302 | -534 to +47 | +2.00 | -210 | {'stop': 49, 'target': 18, 'time': 1} | 1 / 7 | 9, +294 |
| f  no runner: all contracts out at TP1 | 68 | 16.93 | 2302 | 1952 | +350 | -53 to +688 | +110 to +622 | +15.00 | +291 | {'out at TP1': 68} | -0 / -0 | 0, +0 |

**Halves and the TP1 +15 era (change vs live in runner $, with trade-bootstrap CI):**

| rule | walk | H1 (n) | H2 (n) | TP1 +15 era (n) | TP1 +20 era (n) |
|---|---|---|---|---|---|
| a  live: stop +10, trail 10 in 10-pt steps | N | +131 [-60, +293] (34) | +153 [+13, +296] (34) | +250 [+90, +422] (46) | +34 [-129, +172] (22) |
| a  live: stop +10, trail 10 in 10-pt steps | P | -266 [-582, -14] (34) | -178 [-395, -4] (34) | -320 [-637, -65] (46) | -124 [-362, +35] (22) |
| b  stop +2, structural target, session time stop | N | +295 [-178, +874] (34) | +98 [-202, +416] (34) | +347 [-145, +942] (46) | +46 [-226, +285] (22) |
| b  stop +2, structural target, session time stop | P | +274 [-201, +853] (34) | -61 [-359, +245] (34) | +130 [-345, +781] (46) | +82 [-206, +318] (22) |
| b2 stop +2, no target, session time stop | N | +154 [-688, +1317] (34) | +2216 [-214, +5378] (34) | +2209 [-255, +5244] (46) | +162 [-602, +1216] (22) |
| b2 stop +2, no target, session time stop | P | -70 [-821, +1083] (34) | +1458 [-497, +4292] (34) | +1226 [-776, +4082] (46) | +162 [-566, +1254] (22) |
| c  stop +5, trail 15 | N | +151 [-61, +422] (34) | +104 [-104, +322] (34) | +130 [-92, +362] (46) | +125 [-62, +368] (22) |
| c  stop +5, trail 15 | P | -205 [-490, +40] (34) | -312 [-576, -70] (34) | -406 [-688, -156] (46) | -112 [-400, +117] (22) |
| d  stop +2; at +30 stop +15, then trail 20 | N | +36 [-251, +371] (34) | +152 [-102, +448] (34) | +164 [-144, +498] (46) | +23 [-204, +310] (22) |
| d  stop +2; at +30 stop +15, then trail 20 | P | -306 [-621, -2] (34) | -188 [-481, +128] (34) | -314 [-610, +18] (46) | -180 [-504, +118] (22) |
| e30 stop +2, TP2 +30 | N | +98 [-225, +412] (34) | +294 [-12, +608] (34) | +295 [-82, +648] (46) | +96 [-162, +348] (22) |
| e30 stop +2, TP2 +30 | P | -126 [-476, +226] (34) | -42 [-385, +302] (34) | -153 [-540, +234] (46) | -16 [-334, +267] (22) |
| e40 stop +2, TP2 +40 | N | +78 [-270, +450] (34) | +354 [+4, +736] (34) | +324 [-95, +764] (46) | +108 [-174, +415] (22) |
| e40 stop +2, TP2 +40 | P | -150 [-552, +230] (34) | -102 [-444, +272] (34) | -208 [-596, +209] (46) | -44 [-426, +316] (22) |
| f  no runner: all contracts out at TP1 | N | +236 [-80, +494] (34) | +114 [-117, +302] (34) | +91 [-230, +356] (46) | +258 [+20, +419] (22) |
| f  no runner: all contracts out at TP1 | P | +236 [-96, +500] (34) | +114 [-107, +304] (34) | +91 [-226, +350] (46) | +258 [+25, +420] (22) |

**Profit-secured check.** The 2-contract TP1 profit is banked in every rule; the trade total can only fall below it if the runner exits below 0 pts (fees are the same in every rule: same contracts, same number of fills). Worst runner exit per rule and the number of runner exits below +0.36 pts (one contract's fees):

| rule | walk N worst | N exits below fees | walk P worst | P exits below fees | verdict |
|---|---|---|---|---|---|
| a  live: stop +10, trail 10 in 10-pt steps | +10.00 | 0 | +10.00 | 0 | holds |
| b  stop +2, structural target, session time stop | +2.00 | 0 | +2.00 | 0 | holds |
| b2 stop +2, no target, session time stop | +2.00 | 0 | +2.00 | 0 | holds |
| c  stop +5, trail 15 | +5.00 | 0 | +5.00 | 0 | holds |
| d  stop +2; at +30 stop +15, then trail 20 | +2.00 | 0 | +2.00 | 0 | holds |
| e30 stop +2, TP2 +30 | +2.00 | 0 | +2.00 | 0 | holds |
| e40 stop +2, TP2 +40 | +2.00 | 0 | +2.00 | 0 | holds |
| f  no runner: all contracts out at TP1 | +15.00 | 0 | +15.00 | 0 | holds |

**Whole grid: fixed stop x fixed TP2, session time stop. Cells: change vs live runner $ under N / under P.** n = 68.

| stop \ TP2 | +20 | +25 | +30 | +35 | +40 | +50 | +60 | +80 | none |
|---|---|---|---|---|---|---|---|---|---|
| +0 | +8 / -352 | +167 / -352 | +467 / -212 | +307 / -272 | +452 / -208 | +632 / +12 | +532 / -88 | +452 / -47 | +2386 / +1375 |
| +2 | -60 / -348 | +114 / -254 | +392 / -168 | +366 / -228 | +432 / -252 | +588 / -84 | +468 / -228 | +329 / -139 | +2371 / +1388 |
| +5 | -12 / -462 | +168 / -432 | +378 / -372 | +288 / -432 | +322 / -448 | +222 / -498 | -8 / -668 | -168 / -618 | +498 / -620 |
| +10 | +68 / -452 | +308 / -382 | +408 / -392 | +358 / -442 | +412 / -412 | +252 / -432 | +252 / -492 | +432 / -452 | +1128 / -102 |

**Whole grid: stop +X then trail Y behind best (continuous). Cells: change vs live $ under N / under P.**

| stop \ trail | 5 | 10 | 15 | 20 | 30 | 40 |
|---|---|---|---|---|---|---|
| +0 | +510 / -280 | +231 / -492 | +242 / -509 | +83 / -607 | +306 / -196 | +454 / -365 |
| +2 | +510 / -280 | +231 / -492 | +242 / -466 | +142 / -515 | +302 / -228 | +444 / -399 |
| +5 | +510 / -280 | +231 / -492 | +256 / -517 | +118 / -648 | +115 / -600 | -192 / -752 |
| +10 | +510 / -280 | +380 / -404 | +332 / -459 | +206 / -508 | +294 / -526 | +164 / -562 |

**Time-stop sensitivity (walk N): hold to the 12:55 PT flatten instead of the trade's own session end.**

| rule | change vs live $ | worst | hold min p50 / p90 | blocked live trades n, net $ |
|---|---|---|---|---|
| b  stop +2, structural target, session time stop | +393 [-165, +1052] | +2.00 | 1 / 8 | 13, -81 |
| b2 stop +2, no target, session time stop | +3344 [-14, +7512] | +2.00 | 5 / 195 | 98, +1531 |
| c  stop +5, trail 15 | +234 [-73, +556] | +5.00 | 2 / 6 | 6, +90 |
| d  stop +2; at +30 stop +15, then trail 20 | +156 [-234, +594] | +2.00 | 2 / 10 | 14, +627 |
| e30 stop +2, TP2 +30 | +392 [-68, +838] | +2.00 | 1 / 5 | 7, +552 |
| e40 stop +2, TP2 +40 | +448 [-70, +982] | +2.00 | 2 / 8 | 12, +464 |

## 4. Scale-out mix: 1 off at TP1 + 2 run, against 2 off + 1 runs (3-lot trades only)

n = 63 three-lot trades. Trade gross $ = TP1 lots x TP1 pts x $2 + runner lots x runner pts x $2.

| runner rule | walk | 2 off + 1 runs: total $ | 1 off + 2 run: total $ | difference $ | 95% CI | per trade $ | trades where 1+2 is worse | worst single-trade difference $ | reversal trades (runner exits under +5): n, 1+2 minus 2+1 $ |
|---|---|---|---|---|---|---|---|---|---|
| live rule, realised fills | live | 5978 | 5620 | -358 | -649 to -2 | -5.7 | 52 of 63 | -23 | 1, -23 |
| a  live: stop +10, trail 10 in 10-pt steps | N | 6304 | 6271 | -32 | -382 to +374 | -0.5 | 42 of 63 | -22 | 0, +0 |
| a  live: stop +10, trail 10 in 10-pt steps | P | 5632 | 4929 | -704 | -825 to -562 | -11.2 | 60 of 63 | -22 | 0, +0 |
| b  stop +2, structural target, session time stop | N | 6409 | 6483 | +73 | -529 to +894 | +1.2 | 23 of 63 | -36 | 23, -658 |
| b  stop +2, structural target, session time stop | P | 6229 | 6123 | -107 | -700 to +678 | -1.7 | 25 of 63 | -36 | 25, -700 |
| b2 stop +2, no target, session time stop | N | 8451 | 10566 | +2115 | -409 to +5371 | +33.6 | 53 of 63 | -36 | 53, -1538 |
| b2 stop +2, no target, session time stop | P | 7468 | 8600 | +1132 | -1160 to +4108 | +18.0 | 55 of 63 | -36 | 55, -1590 |
| c  stop +5, trail 15 | N | 6206 | 6075 | -130 | -552 to +326 | -2.1 | 40 of 63 | -30 | 0, +0 |
| c  stop +5, trail 15 | P | 5586 | 4835 | -750 | -1050 to -402 | -11.9 | 53 of 63 | -30 | 0, +0 |
| d  stop +2; at +30 stop +15, then trail 20 | N | 6156 | 5977 | -180 | -704 to +398 | -2.8 | 36 of 63 | -40 | 30, -870 |
| d  stop +2; at +30 stop +15, then trail 20 | P | 5584 | 4832 | -752 | -1156 to -287 | -11.9 | 45 of 63 | -37 | 39, -1114 |
| e30 stop +2, TP2 +30 | N | 6324 | 6312 | -12 | -450 to +420 | -0.2 | 31 of 63 | -36 | 30, -870 |
| e30 stop +2, TP2 +30 | P | 5820 | 5304 | -516 | -928 to -86 | -8.2 | 40 of 63 | -36 | 39, -1114 |
| e40 stop +2, TP2 +40 | N | 6361 | 6386 | +25 | -542 to +616 | +0.4 | 39 of 63 | -36 | 38, -1098 |
| e40 stop +2, TP2 +40 | P | 5753 | 5170 | -583 | -1057 to -56 | -9.3 | 47 of 63 | -36 | 46, -1316 |
| f  no runner: all contracts out at TP1 | N | 6336 | 6336 | +0 | +0 to +0 | +0.0 | 0 of 63 | +0 | 0, +0 |
| f  no runner: all contracts out at TP1 | P | 6336 | 6336 | +0 | +0 to +0 | +0.0 | 0 of 63 | +0 | 0, +0 |

## 5. Where continuation is best

Runner pts per trade by split. Columns: live realised; then each rule under walk N / walk P. n < 20 is marked.

| split | n | live | a | b | b2 | c | d | e30 | e40 | f | reached +30 before +2 (N) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| session Asia | 27 | 13.5 | 14.5 / 11.3 | 14.0 / 13.2 | 11.1 / 11.1 | 14.3 / 10.0 | 13.8 / 11.0 | 17.6 / 15.5 | 14.7 / 11.9 | 16.9 / 16.9 | 56% |
| session London | 23 | 13.4 | 17.1 / 10.9 | 12.5 / 11.2 | 8.2 / 3.3 | 17.5 / 11.1 | 13.8 / 7.9 | 15.4 / 10.5 | 16.5 / 11.6 | 16.5 / 16.5 | 48% |
| session NY (small n) | 18 | 16.9 | 18.5 / 11.1 | 28.2 / 26.0 | 92.9 / 71.8 | 17.6 / 10.7 | 21.2 / 13.9 | 19.1 / 12.9 | 23.1 / 14.7 | 17.6 / 17.6 | 61% |
| event BREAK-RETEST (small n) | 1 | 9.5 | 10.0 / 10.0 | 20.0 / 20.0 | 2.0 / 2.0 | 5.0 / 5.8 | 2.0 / 2.0 | 2.0 / 2.0 | 2.0 / 2.0 | 20.0 / 20.0 | 0% |
| event SWEEP-LOSS | 46 | 15.4 | 18.2 / 11.4 | 18.2 / 17.0 | 42.9 / 32.2 | 18.0 / 11.8 | 16.9 / 11.1 | 17.8 / 13.0 | 19.2 / 13.4 | 17.2 / 17.2 | 57% |
| event SWEEP-RECLAIM | 21 | 12.3 | 12.9 / 10.5 | 15.1 / 13.3 | 8.9 / 8.9 | 13.0 / 8.0 | 13.8 / 10.2 | 16.7 / 14.0 | 14.7 / 11.0 | 16.2 / 16.2 | 52% |
| TF open (15m/30m/1H/4H) | 41 | 13.4 | 15.9 / 10.7 | 17.7 / 16.5 | 29.0 / 26.3 | 14.6 / 10.3 | 14.0 / 10.3 | 15.7 / 12.2 | 13.9 / 10.2 | 16.0 / 16.0 | 49% |
| named level | 27 | 15.9 | 17.2 / 11.6 | 16.5 / 15.0 | 36.0 / 22.0 | 18.7 / 10.9 | 18.3 / 11.3 | 19.6 / 14.4 | 23.1 / 16.1 | 18.4 / 18.4 | 63% |
| level 30m Open (small n) | 14 | 14.4 | 20.9 / 10.0 | 25.1 / 20.3 | 15.9 / 7.8 | 17.8 / 11.4 | 16.7 / 8.0 | 16.0 / 8.0 | 15.0 / 6.9 | 15.4 / 15.4 | 50% |
| level 1H Open (small n) | 12 | 13.0 | 12.5 / 10.0 | 16.8 / 18.3 | 78.2 / 78.2 | 14.4 / 7.6 | 17.4 / 14.8 | 18.3 / 16.0 | 14.7 / 11.5 | 16.2 / 16.2 | 58% |
| level 15m Open (small n) | 8 | 15.2 | 16.2 / 12.5 | 7.5 / 7.5 | 2.0 / 2.0 | 15.0 / 15.4 | 11.3 / 11.6 | 16.0 / 16.0 | 21.0 / 21.0 | 15.6 / 15.6 | 50% |
| level 4H Open (small n) | 7 | 9.7 | 11.4 / 11.4 | 16.2 / 16.2 | 2.0 / 2.0 | 8.0 / 6.8 | 6.0 / 6.0 | 10.0 / 10.0 | 2.0 / 2.0 | 17.1 / 17.1 | 29% |
| level PDL (small n) | 7 | 12.7 | 15.7 / 10.0 | 17.4 / 17.4 | 13.0 / 13.0 | 23.8 / 14.1 | 18.1 / 11.1 | 18.0 / 14.0 | 18.3 / 12.9 | 20.0 / 20.0 | 57% |
| level VWAP (small n) | 5 | 28.8 | 27.7 / 14.0 | 11.1 / 11.1 | 23.1 / 23.1 | 31.1 / 11.4 | 33.4 / 14.6 | 30.0 / 18.8 | 32.4 / 17.2 | 18.0 / 18.0 | 100% |
| level PML (small n) | 4 | 9.8 | 11.1 / 11.1 | 5.6 / 5.6 | 18.1 / 18.1 | 7.9 / 7.3 | 5.1 / 5.1 | 9.0 / 9.0 | 11.5 / 11.5 | 15.0 / 15.0 | 25% |
| level WTD High (small n) | 3 | 9.9 | 10.0 / 10.0 | 21.0 / 21.0 | 14.8 / 14.8 | 10.1 / 7.8 | 20.2 / 20.2 | 20.7 / 20.7 | 27.3 / 27.3 | 20.0 / 20.0 | 67% |
| level 06:30 Open (small n) | 3 | 19.8 | 20.0 / 16.7 | 33.4 / 19.8 | 86.5 / 86.5 | 17.7 / 12.0 | 15.0 / 8.8 | 20.7 / 11.3 | 27.3 / 14.7 | 23.7 / 23.7 | 67% |
| level QL (small n) | 2 | 19.8 | 26.5 / 10.0 | 18.9 / 18.9 | 2.0 / 2.0 | 26.8 / 17.8 | 23.8 / 20.2 | 30.0 / 30.0 | 40.0 / 40.0 | 15.0 / 15.0 | 100% |
| level Asia Low (small n) | 1 | 9.8 | 10.0 / 10.0 | 15.0 / 15.0 | 2.0 / 2.0 | 5.0 / 5.0 | 2.0 / 2.0 | 2.0 / 2.0 | 2.0 / 2.0 | 15.0 / 15.0 | 0% |
| level London Low (small n) | 1 | 9.8 | 10.0 / 10.0 | 15.5 / 15.5 | 2.0 / 2.0 | 5.5 / 5.5 | 2.0 / 2.0 | 2.0 / 2.0 | 2.0 / 2.0 | 15.0 / 15.0 | 0% |
| level CMO (small n) | 1 | 8.8 | 10.0 / 10.0 | 15.0 / 15.0 | 381.0 / 2.0 | 5.0 / 5.0 | 23.5 / 2.0 | 30.0 / 2.0 | 40.0 / 2.0 | 15.0 / 15.0 | 100% |
| HTF 3/3 | 68 | 14.4 | 16.4 / 11.1 | 17.2 / 15.9 | 31.8 / 24.6 | 16.2 / 10.6 | 15.7 / 10.7 | 17.2 / 13.1 | 17.5 / 12.5 | 16.9 / 16.9 | 54% |
| H1 session Asia (small n) | 12 | 15.5 | 14.9 / 10.8 | 10.8 / 12.3 | 8.4 / 8.4 | 16.2 / 10.5 | 15.6 / 11.1 | 18.3 / 16.0 | 14.7 / 11.5 | 19.2 / 19.2 | 58% |
| H1 session London (small n) | 16 | 13.0 | 16.2 / 11.2 | 14.5 / 12.6 | 9.0 / 2.0 | 17.2 / 11.5 | 13.4 / 8.4 | 16.0 / 10.8 | 16.2 / 11.5 | 17.2 / 17.2 | 50% |
| H1 session NY (small n) | 6 | 21.4 | 25.0 / 13.3 | 51.7 / 51.7 | 59.1 / 59.1 | 21.5 / 18.5 | 23.1 / 17.0 | 16.0 / 16.0 | 21.0 / 21.0 | 22.7 / 22.7 | 50% |
| H1 SWEEP-LOSS | 27 | 15.0 | 18.1 / 11.5 | 20.4 / 20.0 | 20.3 / 16.1 | 17.6 / 13.5 | 14.5 / 10.2 | 15.5 / 12.4 | 14.7 / 11.9 | 18.7 / 18.7 | 48% |
| H1 SWEEP-RECLAIM (small n) | 6 | 18.2 | 15.0 / 11.7 | 16.5 / 16.5 | 8.4 / 8.4 | 19.8 / 8.4 | 24.5 / 15.5 | 25.3 / 20.7 | 27.3 / 21.0 | 19.2 / 19.2 | 83% |
| H1 TF open (15m/30m/1H/4H) (small n) | 19 | 14.0 | 17.4 / 10.5 | 20.6 / 20.0 | 10.6 / 4.7 | 14.0 / 11.6 | 12.5 / 8.9 | 13.8 / 10.8 | 12.0 / 10.0 | 17.1 / 17.1 | 42% |
| H1 named level (small n) | 15 | 17.1 | 17.2 / 12.7 | 18.6 / 18.6 | 26.6 / 26.6 | 22.1 / 13.3 | 20.2 / 13.4 | 20.7 / 16.9 | 22.3 / 17.2 | 21.1 / 21.1 | 67% |
| H2 session Asia (small n) | 15 | 11.9 | 14.3 / 11.6 | 16.5 / 13.9 | 13.3 / 13.3 | 12.8 / 9.6 | 12.2 / 10.9 | 16.9 / 15.1 | 14.7 / 12.1 | 15.0 / 15.0 | 53% |
| H2 session London (small n) | 7 | 14.1 | 18.9 / 10.0 | 8.0 / 8.0 | 6.4 / 6.4 | 18.1 / 10.2 | 14.7 / 6.8 | 14.0 / 10.0 | 17.2 / 11.8 | 15.0 / 15.0 | 43% |
| H2 session NY (small n) | 12 | 14.7 | 15.2 / 10.0 | 16.5 / 13.1 | 109.8 / 78.2 | 15.6 / 6.8 | 20.2 / 12.4 | 20.7 / 11.3 | 24.2 / 11.5 | 15.0 / 15.0 | 67% |
| H2 SWEEP-LOSS (small n) | 19 | 16.0 | 18.4 / 11.3 | 14.9 / 12.8 | 75.0 / 55.1 | 18.5 / 9.4 | 20.3 / 12.5 | 21.2 / 13.8 | 25.6 / 15.6 | 15.0 / 15.0 | 68% |
| H2 SWEEP-RECLAIM (small n) | 15 | 9.9 | 12.0 / 10.0 | 14.6 / 12.0 | 9.1 / 9.1 | 10.2 / 7.9 | 9.5 / 8.2 | 13.2 / 11.3 | 9.6 / 7.1 | 15.0 / 15.0 | 40% |
| H2 TF open (15m/30m/1H/4H) | 22 | 12.8 | 14.7 / 10.9 | 15.3 / 13.5 | 44.9 / 44.9 | 15.1 / 9.2 | 15.3 / 11.6 | 17.3 / 13.5 | 15.5 / 10.3 | 15.0 / 15.0 | 55% |
| H2 named level (small n) | 12 | 14.4 | 17.3 / 10.4 | 13.9 / 10.5 | 47.8 / 16.2 | 14.5 / 7.9 | 16.0 / 8.6 | 18.3 / 11.3 | 24.2 / 14.7 | 15.0 / 15.0 | 58% |

## 6. Addendum (Mac 11/11): ATR-scaled runner rules, by session and volatility tercile

15m ATR = mean true range of the last 14 completed 15m bars before the entry (built from 1m bars; nothing after the entry is used). n with ATR = 65. Tercile cuts: 49.2 and 59.7 pts. ATR by session (mean / median): Asia 58.1 / 51.0 (n=24); London 49.8 / 51.4 (n=23); NY 73.9 / 82.5 (n=18).

Session x tercile counts: Asia: T1 low 10, T2 mid 6, T3 high 8; London: T1 low 10, T2 mid 11, T3 high 2; NY: T1 low 1, T2 mid 5, T3 high 12.

Cells: change vs live runner $ for the group, walk N / walk P, then [trade-bootstrap 95% CI of the N figure]. Group n in the header; n < 20 is small.

| rule | all (n=68) | H1 (n=34) | H2 (n=34) | session Asia (n=27) | session London (n=23) | session NY (n=18, small) | vol T1 low (n=21) | vol T2 mid (n=22) | vol T3 high (n=22) |
|---|---|---|---|---|---|---|---|---|---|
| a  live: stop +10, trail 10 in 10-pt steps | +248 / -440 [+14, +468] | +131 / -266 [-58, +302] | +116 / -174 [-24, +259] | +21 / -116 [-136, +132] | +170 / -115 [+60, +308] | +56 / -210 [-69, +178] | +158 / -67 [+68, +272] | +30 / -168 [-130, +166] | +60 / -206 [-68, +179] |
| b  stop +2, structural target, session time stop | +287 / +184 [-283, +934] | +295 / +274 [-168, +873] | -8 / -90 [-296, +278] | -80 / -44 [-312, +116] | -40 / -98 [-307, +201] | +407 / +326 [+21, +955] | +58 / +58 [-215, +280] | -20 / -160 [-284, +223] | +249 / +286 [-138, +817] |
| b2 stop +2, no target, session time stop | +2211 / +1228 [-418, +5298] | +154 / -70 [-712, +1322] | +2056 / +1298 [-396, +4895] | -286 / -286 [-674, +158] | -237 / -462 [-602, +282] | +2734 / +1976 [+370, +5594] | -282 / -282 [-577, +72] | -180 / -406 [-640, +404] | +2674 / +1916 [+186, +5646] |
| c  stop +5, trail 15 | +244 / -484 [-62, +586] | +151 / -205 [-56, +432] | +94 / -278 [-124, +320] | +34 / -154 [-59, +134] | +188 / -106 [-26, +458] | +22 / -224 [-150, +212] | +82 / -90 [-35, +216] | +174 / -178 [-22, +428] | -12 / -216 [-182, +184] |
| d  stop +2; at +30 stop +15, then trail 20 | +137 / -504 [-248, +564] | +36 / -306 [-238, +372] | +102 / -198 [-143, +386] | -36 / -144 [-194, +161] | +20 / -250 [-206, +280] | +153 / -109 [-90, +431] | +48 / -56 [-130, +254] | +10 / -304 [-188, +254] | +78 / -144 [-166, +364] |
| e30 stop +2, TP2 +30 | +331 / -173 [-102, +779] | +98 / -126 [-222, +409] | +233 / -47 [-54, +536] | +160 / +104 [-110, +426] | +93 / -131 [-124, +332] | +78 / -146 [-180, +327] | +200 / +144 [-24, +433] | +112 / -168 [-154, +364] | +18 / -150 [-238, +282] |
| e40 stop +2, TP2 +40 | +332 / -276 [-172, +844] | +78 / -150 [-260, +448] | +254 / -126 [-82, +624] | -36 / -112 [-304, +262] | +146 / -82 [-115, +432] | +222 / -82 [-66, +516] | +46 / -30 [-176, +304] | +124 / -180 [-170, +449] | +162 / -66 [-144, +484] |
| f  no runner: all contracts out at TP1 | +323 / +323 [-60, +654] | +236 / +236 [-102, +496] | +87 / +87 [-133, +266] | +156 / +156 [-64, +322] | +145 / +145 [-22, +284] | +22 / +22 [-252, +236] | +114 / +114 [-65, +265] | +122 / +122 [-110, +282] | +86 / +86 [-200, +298] |
| g1 stop +2, trail 0.5 x ATR15 | +707 / -201 [-190, +1935] | +34 / -204 [-279, +400] | +673 / +3 [-134, +1790] | -88 / -184 [-248, +111] | +85 / -134 [-187, +428] | +709 / +118 [-59, +1781] | +15 / -57 [-152, +220] | -74 / -344 [-262, +141] | +765 / +201 [-62, +1867] |
| g2 stop +2, trail 1.0 x ATR15 | +1709 / +986 [-142, +4192] | +1566 / +1269 [-116, +3960] | +144 / -283 [-478, +1023] | -13 / -95 [-420, +663] | +1 / -251 [-300, +421] | +1721 / +1332 [+33, +4008] | -133 / -170 [-324, +84] | +98 / -199 [-400, +864] | +1744 / +1355 [+20, +4064] |
| h1 stop +2, TP2 1.5 x ATR15 | +1050 / +381 [+43, +2121] | +726 / +424 [+68, +1488] | +325 / -43 [-378, +1186] | -12 / -164 [-402, +470] | +253 / -16 [-161, +707] | +810 / +561 [+32, +1670] | +75 / -44 [-278, +475] | +51 / -250 [-328, +515] | +925 / +675 [+130, +1832] |
| h2 stop +2, TP2 2.0 x ATR15 | +1196 / +661 [-176, +2686] | +697 / +495 [-255, +1845] | +500 / +166 [-412, +1655] | -182 / -182 [-678, +461] | +138 / -64 [-391, +798] | +1240 / +907 [+216, +2412] | -75 / -75 [-468, +419] | -144 / -345 [-638, +506] | +1415 / +1081 [+317, +2652] |
| i1 stop +2, trail 0.5 x ATR, TP2 1.5 x ATR | +663 / -72 [-88, +1580] | +99 / -139 [-282, +558] | +564 / +67 [-73, +1356] | -54 / -151 [-246, +209] | +157 / -103 [-157, +569] | +560 / +182 [-70, +1280] | +89 / -24 [-131, +365] | -74 / -344 [-256, +142] | +648 / +296 [-14, +1436] |
| i2 stop +2, trail 1.0 x ATR, TP2 2.0 x ATR | +835 / +151 [-195, +2142] | +738 / +434 [-87, +1708] | +98 / -283 [-460, +930] | -111 / -194 [-421, +370] | +91 / -168 [-281, +570] | +856 / +513 [+8, +1866] | -49 / -87 [-307, +275] | +6 / -298 [-411, +585] | +879 / +536 [+4, +1864] |

**Best rule per group** (largest change vs live; walk N and walk P picked separately):

| group | n | best under N | best under P | same rule? |
|---|---|---|---|---|
| all | 65 | b2 (+2211) | b2 (+1228) | yes |
| H1 | 34 | g2 (+1566) | g2 (+1269) | yes |
| H2 | 31 | b2 (+2056) | b2 (+1298) | yes |
| session Asia | 24 | e30 (+160) | f (+156) | no |
| session London | 23 | h1 (+253) | f (+145) | no |
| session NY (small n) | 18 | b2 (+2734) | b2 (+1976) | yes |
| vol T1 low | 21 | e30 (+200) | e30 (+144) | yes |
| vol T2 mid | 22 | c (+174) | f (+122) | no |
| vol T3 high | 22 | b2 (+2674) | b2 (+1916) | yes |

**Runner pts per trade, live realised, by group:** all 14.4; H1 15.4; H2 13.3; session Asia 13.5; session London 13.4; session NY 16.9; vol T1 low 13.2; vol T2 mid 14.7; vol T3 high 15.6.

**ATR rules, per-rule detail (all runners with ATR):**

| rule | walk | n | runner pts/trade | change vs live $ | 95% CI | worst runner pts | exits | hold min p50 / p90 | blocked live trades n, net $ | $ per week |
|---|---|---|---|---|---|---|---|---|---|---|
| g1 stop +2, trail 0.5 x ATR15 | N | 65 | 19.97 | +707 | -166 to +1893 | +2.00 | {'stop': 62, 'stop in TP1 bar': 2, 'time': 1} | 3 / 24 | 19, +401 | +589 |
| g1 stop +2, trail 0.5 x ATR15 | P | 65 | 12.99 | -201 | -811 to +483 | +2.00 | {'stop': 64, 'time': 1} | 2 / 20 | 14, +456 | -167 |
| g2 stop +2, trail 1.0 x ATR15 | N | 65 | 27.68 | +1709 | -139 to +4316 | +2.00 | {'stop': 61, 'time': 2, 'stop in TP1 bar': 2} | 4 / 60 | 32, +547 | +1425 |
| g2 stop +2, trail 1.0 x ATR15 | P | 65 | 22.12 | +986 | -734 to +3375 | +2.00 | {'stop': 63, 'time': 2} | 2 / 55 | 25, +709 | +822 |
| h1 stop +2, TP2 1.5 x ATR15 | N | 65 | 22.61 | +1050 | +50 to +2174 | +2.00 | {'stop': 47, 'target': 14, 'time': 2, 'stop in TP1 bar': 2} | 4 / 35 | 25, +350 | +875 |
| h1 stop +2, TP2 1.5 x ATR15 | P | 65 | 17.46 | +381 | -527 to +1435 | +2.00 | {'stop': 53, 'target': 10, 'time': 2} | 2 / 33 | 20, +405 | +317 |
| h2 stop +2, TP2 2.0 x ATR15 | N | 65 | 23.73 | +1196 | -157 to +2862 | +2.00 | {'stop': 51, 'time': 2, 'target': 10, 'stop in TP1 bar': 2} | 4 / 75 | 32, -252 | +997 |
| h2 stop +2, TP2 2.0 x ATR15 | P | 65 | 19.62 | +661 | -562 to +2032 | +2.00 | {'stop': 55, 'time': 2, 'target': 8} | 2 / 66 | 25, -121 | +551 |
| i1 stop +2, trail 0.5 x ATR, TP2 1.5 x ATR | N | 65 | 19.63 | +663 | -120 to +1583 | +2.00 | {'stop': 56, 'target': 6, 'stop in TP1 bar': 2, 'time': 1} | 3 / 22 | 19, +401 | +552 |
| i1 stop +2, trail 0.5 x ATR, TP2 1.5 x ATR | P | 65 | 13.98 | -72 | -777 to +762 | +2.00 | {'stop': 60, 'target': 4, 'time': 1} | 2 / 18 | 14, +456 | -60 |
| i2 stop +2, trail 1.0 x ATR, TP2 2.0 x ATR | N | 65 | 20.96 | +835 | -227 to +2117 | +2.00 | {'stop': 55, 'time': 2, 'target': 6, 'stop in TP1 bar': 2} | 4 / 55 | 27, +358 | +696 |
| i2 stop +2, trail 1.0 x ATR, TP2 2.0 x ATR | P | 65 | 15.69 | +151 | -753 to +1268 | +2.00 | {'stop': 59, 'time': 2, 'target': 4} | 2 / 53 | 21, +336 | +126 |

**Newest live trades (desk C ledger, TradeDays 11-10 and 11-11, n=12, small n; no 1m bars for these dates, so baseline only):** runner pts mean 12.15, median 9.75, min 8.25, max 40.00; 11 of 12 at +10.5 or less; trades with a TRAIL_RATCHET code: 1. Per trade: 9.2, 9.5, 9.5, 10.0, 9.8, 10.0, 10.0, 10.0, 8.2, 9.8, 9.8, 40.0.
