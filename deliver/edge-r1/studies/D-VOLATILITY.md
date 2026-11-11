# Desk D: should the fixed point distances scale with session and volatility?

Desk D, 11/11. Cohort: Desk C's 149 levels trades, 10/28-11/10 (Asia 65, London 51, NY 33). All counterfactuals are first-order (same entries) and none is replayed.

## Answer in short

**Yes for the profit side in NY, not proven anywhere else.** Candle ranges rose 50-70% from mid-October to the week of 11/02 while the distances stayed fixed, and the +15 target is now a small fraction of one candle. But only one family of changes shows a gain: a much larger TP1 (30-50 pts). Small steps (TP1 20 or 25, a wider or tighter lock, a scaled no-progress threshold) do nothing or lose. No result survives a correction for the ~45 rules tried.

1. **Volatility facts.** NY candles are 1.5-1.7x Asia's in every week with true 1m bars (1.33x in the two sampled days of 11/09-11/10) (5m mean: 40.6 vs 23.7 in the week of 10/12; 69.5 vs 43.7 in the week of 11/02). All three sessions jumped in the week of 11/02: NY +59%, Asia +50%, London +33% on the 5m range. The week of 11/09 (two days, sampled data) is lower in NY (-22%) but still 33% above mid-October.
2. **The fixed distances shrank in market terms.** TP1 +15 was 0.42x the median NY 5m candle in mid-October and 0.25x in the week of 11/02 (0.13x of the 15m ATR). The NY 50-pt stop went from 1.4x to 0.84x of a 5m candle. Asia's 30-pt stop did the same (1.41x to 0.84x).
3. **High volatility is where the bot loses.** Top ATR tercile (15m ATR above 61): 49 trades, -$896, 15 of the 26 full stops. Bottom tercile: 48 trades, +$639, 4 full stops. The loss is all in the second date half (H2 high tercile: 30 trades, -$1,201, 13 full stops; H1 high tercile: 19 trades, +$305).
4. **High-volatility winners run far and do not need more room.** In the top tercile the winners' median path MFE before the stop is 196 pts (69 in the bottom tercile), and their median MAE is 1 pt (p75 12). NY winners: MAE median 9, p75 13. A wider stop would not have saved winners; a larger target would have paid them more.
5. **NY's 15-for-50 does not add up.** P(+15 before -50) in NY is 67% (n = 33); break-even needs 77%. Every NY target below +40 has negative expectancy at a 50 or 40 stop. Asia is the opposite: 86% reach +15 before -50, and the wide stop is the better cell.

## Recommended rule set (shadow first; one live step)

| setting | Asia | London | NY |
|---|---|---|---|
| TP1 (2 of 3 lots) | 15 (no change) | 15 (no change) | **30** |
| Stop after the trade is seen at +15 | no change | no change | **all 3 lots to break-even** until TP1 fills |
| Runner stop after TP1 | +10, then the trail (no change) | no change | the trail as it is (gives +20 at a +30 fill) |
| No-progress threshold | 15 (no change) | 15 (no change) | 15 (no change) |
| Stop floor / cap | 30 / 50 (no change) | 30 / 50 (no change) | 50 / 50 (no change) |

- **Evidence for the NY step:** 33 NY trades (the other 116 are untouched). Model change +$660; 95% CI +$30..+$1,323 (trade bootstrap), -$22..+$1,522 (day-cluster); both halves positive (+$200, +$460); full stops unchanged at 22; 5 trades end at break-even after touching +15. NY TP1 30 without the break-even step: +$489, CI -$955..+$1,601.
- **Shadow-log candidate, all sessions:** TP1 = 0.75 x 15m ATR(14), clamped 15..60, with the same break-even step at +15. Model change +$1,636, CI -$421..+$4,014 (day-cluster +$231..+$3,104), both halves positive, full stops unchanged at 22. Without the break-even step it shows +$4,009 (CI +$224..+$7,543, worst leave-one-day-out +$1,587) but full stops rise from 22 to 39, which is against Mac's goal, and 47 later entries fall inside the longer holds (5 today), so the first-order sum overstates it.
- **Do not ship:** TP1 20 or 25 in any session (all negative or flat), no-progress scaled up with TP1 (87-114 no-progress exits, negative), lock +5 or break-even after a +15 TP1 (flat), a tighter NY stop (flat, and against the standing "never tighten" rule).

**How strong is this?** Weak to moderate. 149 trades over 8 trade days, about 45 rules compared, and the best intervals only just exclude zero, so nothing passes a multiplicity correction. The direction (bigger targets in high volatility) is consistent across both halves and all three sessions, which is the main reason to act on the smallest version of it.

**What would prove it wrong:**
- In the next 30 NY trades, fewer than half reach +30 before the full stop (the cohort shows 61%, 20 of 33; +15 is reached by 67%).
- The replay rig, with re-entries and position overlap honoured, shows NY TP1 30 at or below live on the same days.
- NY 5m mean range falls back under about 45 pts (mid-October level): the case for the larger target weakens with it.

## Limits

- First-order only. Longer holds block later entries; the table reports how many entries fall inside each rule's holds.
- The bot model reproduces the live exit class on 137 of 149 trades and nets +$238 against the real +$78. All changes are model against model.
- Volatility terciles are tangled with session: 26 of 33 NY trades are in the top ATR tercile and none is in the bottom.
- 20 trades (11/09-11/10) have no true 1m bars: in-trade minutes come from the bot's own per-minute rows and later minutes from one price sample per minute. 10 more paths touch sampled minutes late in their 240-minute window. Sampled ranges are scaled by the measured true/sampled ratio (5m 1.39, 15m 1.24) for the volatility tags.
- Stop first inside every bar; unresolved paths are marked at the last close after 240 minutes. Volatility tags use only bars closed before the entry.
- Scripts: `lib.py`, `prep.py`, `vol.py`, `trades.py` in the `d/` folder beside this file; run with `python3 -I <script> <that folder>`.

## 1. Volatility by session and week

Weeks 10/19 and 11/09 are partial (10/19: bars missing 10/20-10/22; 11/09: two days, sampled prices).

### Table 1a. Candle range by session and trade week (true 1m bars; points)

| week of | session | 1m bars | 1m mean | 5m mean | 5m median | 15m mean | 15m median | 15m ATR(14) mean | source |
|---|---|---|---|---|---|---|---|---|---|
| 10/12 | Asia | 2700 | 10.3 | 23.7 | 21.2 | 41.0 | 37.8 | 41.0 | true 1m |
| 10/12 | London | 1950 | 11.4 | 25.7 | 22.4 | 44.7 | 38.4 | 41.8 | true 1m |
| 10/12 | NY | 1950 | 18.1 | 40.6 | 35.6 | 72.4 | 60.9 | 71.0 | true 1m |
| 10/19 | Asia | 1620 | 12.3 | 28.0 | 24.8 | 49.6 | 41.9 | 47.3 | true 1m |
| 10/19 | London | 1170 | 12.5 | 27.6 | 25.0 | 47.1 | 43.2 | 46.0 | true 1m |
| 10/19 | NY | 959 | 20.2 | 44.9 | 39.6 | 76.5 | 67.4 | 71.6 | true 1m |
| 10/26 | Asia | 2700 | 12.7 | 29.2 | 27.0 | 50.7 | 47.2 | 56.0 | true 1m |
| 10/26 | London | 1950 | 12.3 | 28.0 | 24.5 | 50.6 | 44.8 | 48.0 | true 1m |
| 10/26 | NY | 1950 | 19.3 | 43.7 | 36.5 | 76.0 | 65.8 | 71.3 | true 1m |
| 11/02 | Asia | 2700 | 18.9 | 43.7 | 35.6 | 75.1 | 60.6 | 80.5 | true 1m |
| 11/02 | London | 1950 | 16.5 | 37.2 | 33.0 | 64.4 | 58.9 | 60.6 | true 1m |
| 11/02 | NY | 1950 | 31.0 | 69.5 | 59.8 | 122.9 | 99.5 | 118.0 | true 1m |
| 11/09 | Asia | 1190 | 18.0 | 40.5 | 32.5 | 72.8 | 57.1 | 59.6 | levels-minute samples x calibration |
| 11/09 | London | 760 | 18.9 | 44.8 | 35.5 | 76.5 | 59.1 | 72.2 | levels-minute samples x calibration |
| 11/09 | NY | 777 | 24.6 | 53.9 | 44.1 | 98.3 | 77.5 | 100.2 | levels-minute samples x calibration |

### Table 1b. NY against Asia and London, by week (ratio of mean ranges)

| week of | NY/Asia 1m | NY/Asia 5m | NY/Asia 15m | NY/Asia ATR15 | NY/London 5m | NY 5m vs prior week | Asia 5m vs prior week | London 5m vs prior week |
|---|---|---|---|---|---|---|---|---|
| 10/12 | 1.75x | 1.71x | 1.77x | 1.73x | 1.58x | - | - | - |
| 10/19 | 1.63x | 1.60x | 1.54x | 1.52x | 1.63x | +11% | +18% | +7% |
| 10/26 | 1.52x | 1.50x | 1.50x | 1.27x | 1.56x | -3% | +4% | +1% |
| 11/02 | 1.64x | 1.59x | 1.64x | 1.47x | 1.87x | +59% | +50% | +33% |
| 11/09 | 1.37x | 1.33x | 1.35x | 1.68x | 1.20x | -22% | -7% | +20% |

### Table 1c. The fixed distances as multiples of the session's median 5m range and mean 15m ATR

| week of | session | median 5m range | 15m ATR | TP1 15 / 5m | TP1 15 / ATR | lock 10 / 5m | stop floor / 5m | stop floor / ATR | reward:risk (15 : floor) |
|---|---|---|---|---|---|---|---|---|---|
| 10/12 | Asia | 21.2 | 41.0 | 0.71x | 0.37x | 0.47x | 1.41x | 0.73x | 1 : 2.0 |
| 10/12 | London | 22.4 | 41.8 | 0.67x | 0.36x | 0.45x | 1.34x | 0.72x | 1 : 2.0 |
| 10/12 | NY | 35.6 | 71.0 | 0.42x | 0.21x | 0.28x | 1.40x | 0.70x | 1 : 3.3 |
| 10/19 | Asia | 24.8 | 47.3 | 0.61x | 0.32x | 0.40x | 1.21x | 0.63x | 1 : 2.0 |
| 10/19 | London | 25.0 | 46.0 | 0.60x | 0.33x | 0.40x | 1.20x | 0.65x | 1 : 2.0 |
| 10/19 | NY | 39.6 | 71.6 | 0.38x | 0.21x | 0.25x | 1.26x | 0.70x | 1 : 3.3 |
| 10/26 | Asia | 27.0 | 56.0 | 0.56x | 0.27x | 0.37x | 1.11x | 0.54x | 1 : 2.0 |
| 10/26 | London | 24.5 | 48.0 | 0.61x | 0.31x | 0.41x | 1.22x | 0.62x | 1 : 2.0 |
| 10/26 | NY | 36.5 | 71.3 | 0.41x | 0.21x | 0.27x | 1.37x | 0.70x | 1 : 3.3 |
| 11/02 | Asia | 35.6 | 80.5 | 0.42x | 0.19x | 0.28x | 0.84x | 0.37x | 1 : 2.0 |
| 11/02 | London | 33.0 | 60.6 | 0.45x | 0.25x | 0.30x | 0.91x | 0.50x | 1 : 2.0 |
| 11/02 | NY | 59.8 | 118.0 | 0.25x | 0.13x | 0.17x | 0.84x | 0.42x | 1 : 3.3 |
| 11/09 | Asia | 32.5 | 59.6 | 0.46x | 0.25x | 0.31x | 0.92x | 0.50x | 1 : 2.0 |
| 11/09 | London | 35.5 | 72.2 | 0.42x | 0.21x | 0.28x | 0.85x | 0.42x | 1 : 2.0 |
| 11/09 | NY | 44.1 | 100.2 | 0.34x | 0.15x | 0.23x | 1.13x | 0.50x | 1 : 3.3 |

Calibration of sampled ranges (true / sampled, overlap 10/23-11/06): 1m 2.03, 5m 1.39, 15m 1.24 (NY; other sessions within 0.06).

## 2. Trade outcomes by volatility at entry

"Path MFE" is the best favourable move on the 240-minute 1m path before the trade's own stop distance is hit; "live MFE / MAE" are the ledger values, cut short by the live exits.

### Table 2a. Live outcomes by 15m ATR(14) at entry (terciles; cuts 46.1 / 60.6 pts)

| bin | n | win% | net $ | pts/c | full stops | live MFE med / p75 | live MAE med / p75 | path MFE before -stop med / p75 | %reach +15 | +20 | +25 | +30 | winners: MAE med / p75 | winners: path MFE med / p75 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| low | 48 | 65 | +639 | +2.41 | 4 | 9 / 18 | -6 / -2 | 48 / 91 | 75 | 73 | 69 | 62 | 4 / 7 | 69 / 126 |
| mid | 48 | 60 | +23 | +0.58 | 7 | 12 / 19 | -9 / -3 | 37 / 94 | 71 | 56 | 54 | 52 | 3 / 8 | 78 / 128 |
| high | 49 | 59 | -896 | -3.75 | 15 | 8 / 22 | -12 / 0 | 56 / 231 | 69 | 63 | 61 | 57 | 1 / 12 | 196 / 375 |

### Table 2b. Live outcomes by mean 5m range of the last hour at entry (terciles; cuts 25.0 / 35.5 pts)

| bin | n | win% | net $ | pts/c | full stops | live MFE med / p75 | live MAE med / p75 | path MFE before -stop med / p75 | %reach +15 | +20 | +25 | +30 | winners: MAE med / p75 | winners: path MFE med / p75 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| low | 49 | 59 | +67 | +0.44 | 4 | 8 / 17 | -8 / -4 | 39 / 84 | 71 | 63 | 59 | 55 | 5 / 8 | 69 / 127 |
| mid | 50 | 68 | +597 | +3.02 | 8 | 13 / 24 | -7 / -0 | 68 / 127 | 78 | 72 | 72 | 66 | 3 / 7 | 94 / 186 |
| high | 50 | 60 | -585 | -3.17 | 14 | 8 / 18 | -13 / 0 | 41 / 215 | 68 | 60 | 56 | 54 | 2 / 13 | 130 / 347 |

### Table 2c. By session, and session x ATR tercile

| bin | n | win% | net $ | pts/c | full stops | live MFE med / p75 | live MAE med / p75 | path MFE before -stop med / p75 | %reach +15 | +20 | +25 | +30 | winners: MAE med / p75 | winners: path MFE med / p75 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Asia | 65 | 60 | -308 | +0.07 | 11 | 9 / 19 | -6 / -1 | 51 / 134 | 75 | 66 | 63 | 58 | 2 / 6 | 94 / 156 |
| London | 51 | 67 | +967 | +3.22 | 6 | 11 / 18 | -8 / -2 | 52 / 99 | 73 | 67 | 63 | 57 | 3 / 9 | 81 / 122 |
| NY | 33 | 61 | -581 | -4.69 | 9 | 9 / 22 | -14 / -8 | 53 / 210 | 67 | 61 | 61 | 61 | 9 / 13 | 124 / 395 |
| Asia / ATR low | 29 | 62 | +302 | +1.87 | 2 | 9 / 21 | -5 / -2 | 52 / 127 | 79 | 79 | 76 | 72 | 2 / 5 | 82 / 147 |
| Asia / ATR mid | 12 (small) | 42 | -684 | -7.30 | 3 | 10 / 17 | -11 / -6 | 17 / 67 | 67 | 33 | 33 | 33 | 5 / 6 | 78 / 94 |
| Asia / ATR high | 20 | 60 | -238 | -0.80 | 6 | 6 / 20 | -11 / 0 | 27 / 217 | 70 | 60 | 55 | 45 | 0 / 8 | 180 / 264 |
| London / ATR low | 19 (small) | 68 | +337 | +3.25 | 2 | 9 / 12 | -9 / -6 | 29 / 84 | 68 | 63 | 58 | 47 | 8 / 10 | 54 / 85 |
| London / ATR mid | 29 | 66 | +484 | +2.66 | 4 | 13 / 19 | -5 / -1 | 58 / 160 | 72 | 66 | 62 | 59 | 2 / 5 | 96 / 221 |
| London / ATR high | 3 (small) | 67 | +146 | +8.47 | 0 | 0 / 13 | -11 / -6 | 100 / 198 | 100 | 100 | 100 | 100 | 6 / 8 | 70 / 85 |
| NY / ATR low | 0 |
| NY / ATR mid | 7 (small) | 71 | +223 | +5.49 | 0 | 12 / 22 | -15 / -10 | 39 / 58 | 71 | 57 | 57 | 57 | 12 / 15 | 53 / 62 |
| NY / ATR high | 26 | 58 | -804 | -7.43 | 9 | 9 / 22 | -13 / -3 | 62 / 254 | 65 | 62 | 62 | 62 | 8 / 12 | 210 / 460 |

### Table 2d. ATR tercile x date half

| bin | n | win% | net $ | pts/c | full stops | live MFE med / p75 | live MAE med / p75 | path MFE before -stop med / p75 | %reach +15 | +20 | +25 | +30 | winners: MAE med / p75 | winners: path MFE med / p75 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 / ATR low | 16 (small) | 62 | +161 | +1.55 | 2 | 10 / 19 | -7 / -3 | 61 / 84 | 75 | 75 | 62 | 62 | 5 / 7 | 76 / 85 |
| H1 / ATR mid | 26 | 69 | +353 | +2.89 | 3 | 15 / 24 | -7 / -1 | 62 / 96 | 81 | 69 | 65 | 62 | 3 / 7 | 92 / 152 |
| H1 / ATR high | 19 (small) | 68 | +305 | +0.30 | 2 | 19 / 27 | -13 / -1 | 196 / 243 | 89 | 79 | 79 | 68 | 5 / 13 | 196 / 262 |
| H2 / ATR low | 32 | 66 | +477 | +2.85 | 2 | 8 / 17 | -6 / -2 | 42 / 105 | 75 | 72 | 72 | 62 | 3 / 6 | 62 / 145 |
| H2 / ATR mid | 22 | 50 | -330 | -2.14 | 4 | 6 / 14 | -14 / -5 | 16 / 63 | 59 | 41 | 41 | 41 | 5 / 9 | 62 / 97 |
| H2 / ATR high | 30 | 53 | -1201 | -6.31 | 13 | 2 / 12 | -12 / 0 | 29 / 207 | 57 | 53 | 50 | 50 | 1 / 12 | 184 / 427 |

Median 15m ATR at entry by session: Asia 47, London 51, NY 82; by half: H1 52, H2 53


## 3. Reach tables

Whole grids are shown; with 24 cells per table and 13 tables, the single best cell in a table is not evidence on its own.

### Table 3. Reach tables (1m paths, stop first inside a bar, no no-progress exit)

**All 149** (n = 149). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 69% / +0.7 | 60% / +1.1 | 53% / +1.2 | 50% / +2.3 | 46% / +3.2 | 38% / +2.6 | +30 (+3.2) |
| -30 | 75% / +0.1 | 68% / +0.5 | 60% / +0.2 | 58% / +1.7 | 52% / +1.4 | 46% / +1.9 | +40 (+1.9) |
| -40 | 79% / -0.4 | 72% / -0.5 | 64% / -1.3 | 61% / -0.3 | 56% / -0.5 | 52% / +1.9 | +40 (+1.9) |
| -50 | 84% / +0.3 | 78% / +0.6 | 71% / -0.2 | 68% / +0.8 | 63% / +0.5 | 57% / +1.5 | +40 (+1.5) |

**Asia** (n = 65). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 71% / +1.2 | 60% / +1.0 | 52% / +0.9 | 49% / +2.2 | 48% / +3.8 | 40% / +4.0 | +40 (+4.0) |
| -30 | 78% / +1.4 | 71% / +1.8 | 62% / +0.8 | 58% / +2.2 | 54% / +2.3 | 46% / +2.3 | +30 (+2.3) |
| -40 | 85% / +2.3 | 77% / +2.3 | 68% / +0.6 | 63% / +1.0 | 58% / +0.9 | 52% / +2.0 | +10 (+2.3) |
| -50 | 91% / +4.5 | 86% / +6.0 | 78% / +4.9 | 74% / +5.4 | 69% / +5.4 | 58% / +2.9 | +15 (+6.0) |

**London** (n = 51). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 71% / +1.2 | 65% / +2.6 | 57% / +2.7 | 51% / +2.9 | 45% / +2.5 | 35% / +1.2 | +25 (+2.9) |
| -30 | 76% / +0.6 | 69% / +0.9 | 63% / +1.4 | 59% / +2.4 | 51% / +0.6 | 45% / +1.6 | +25 (+2.4) |
| -40 | 80% / +0.2 | 71% / -1.2 | 65% / -1.2 | 61% / -0.5 | 55% / -1.6 | 53% / +2.4 | +40 (+2.4) |
| -50 | 84% / +0.6 | 75% / -1.6 | 69% / -2.0 | 65% / -1.5 | 59% / -2.9 | 57% / +1.2 | +40 (+1.2) |

**NY** (n = 33). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 64% / -0.9 | 55% / -0.9 | 48% / -0.6 | 48% / +1.8 | 45% / +2.7 | 36% / +1.8 | +30 (+2.7) |
| -30 | 67% / -3.3 | 61% / -2.7 | 55% / -2.7 | 55% / +0.0 | 52% / +0.9 | 45% / +1.8 | +40 (+1.8) |
| -40 | 67% / -6.7 | 64% / -5.0 | 58% / -5.5 | 58% / -2.6 | 55% / -1.8 | 52% / +1.2 | +40 (+1.2) |
| -50 | 70% / -8.2 | 67% / -6.7 | 61% / -7.6 | 61% / -4.5 | 58% / -3.9 | 55% / -0.9 | +40 (-0.9) |

**15m ATR tercile: low** (n = 48). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 77% / +3.1 | 65% / +2.6 | 62% / +5.0 | 56% / +5.3 | 52% / +6.0 | 42% / +5.0 | +30 (+6.0) |
| -30 | 77% / +0.8 | 69% / +0.9 | 67% / +3.3 | 62% / +4.4 | 54% / +2.5 | 46% / +2.1 | +25 (+4.4) |
| -40 | 83% / +1.7 | 73% / +0.1 | 71% / +2.5 | 65% / +2.0 | 58% / +0.8 | 52% / +1.9 | +20 (+2.5) |
| -50 | 88% / +2.5 | 79% / +1.5 | 77% / +4.0 | 71% / +3.1 | 65% / +1.7 | 56% / +1.0 | +20 (+4.0) |

**15m ATR tercile: mid** (n = 48). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 71% / +1.2 | 60% / +1.1 | 48% / -0.8 | 46% / +0.6 | 42% / +0.8 | 31% / -1.2 | +10 (+1.2) |
| -30 | 79% / +1.7 | 67% / +0.0 | 54% / -2.9 | 52% / -1.4 | 48% / -1.2 | 42% / -0.8 | +10 (+1.7) |
| -40 | 79% / -0.4 | 69% / -2.2 | 54% / -7.5 | 52% / -6.1 | 48% / -6.5 | 44% / -5.0 | +10 (-0.4) |
| -50 | 83% / +0.0 | 75% / -1.2 | 60% / -7.7 | 58% / -6.2 | 54% / -6.7 | 48% / -6.9 | +10 (+0.0) |

**15m ATR tercile: high** (n = 49). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 57% / -2.9 | 53% / -1.4 | 45% / -2.0 | 43% / -0.7 | 41% / +0.4 | 35% / +0.8 | +40 (+0.8) |
| -30 | 67% / -3.1 | 65% / -0.6 | 57% / -1.4 | 55% / +0.3 | 51% / +0.6 | 45% / +1.4 | +40 (+1.4) |
| -40 | 73% / -3.3 | 71% / -0.7 | 65% / -0.8 | 63% / +1.1 | 59% / +1.4 | 57% / +5.7 | +40 (+5.7) |
| -50 | 80% / -2.2 | 78% / +0.4 | 73% / +1.4 | 71% / +3.6 | 67% / +3.9 | 63% / +6.9 | +40 (+6.9) |

**Asia, half H1** (n = 23). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 74% / +2.2 | 65% / +2.8 | 57% / +2.6 | 52% / +3.5 | 48% / +3.9 | 39% / +3.5 | +30 (+3.9) |
| -30 | 83% / +3.0 | 74% / +3.3 | 61% / +0.4 | 57% / +1.1 | 48% / -1.3 | 43% / +0.4 | +15 (+3.3) |
| -40 | 87% / +3.5 | 78% / +3.0 | 65% / -0.9 | 61% / -0.4 | 52% / -3.5 | 52% / +1.7 | +10 (+3.5) |
| -50 | 91% / +4.8 | 87% / +6.5 | 74% / +1.7 | 70% / +2.2 | 61% / -1.3 | 61% / +4.8 | +15 (+6.5) |

**London, half H1** (n = 26). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 81% / +4.2 | 81% / +8.3 | 77% / +10.8 | 69% / +11.2 | 62% / +10.8 | 50% / +10.0 | +25 (+11.2) |
| -30 | 85% / +3.8 | 85% / +8.1 | 81% / +10.4 | 73% / +10.2 | 65% / +9.2 | 62% / +13.1 | +40 (+13.1) |
| -40 | 85% / +2.3 | 85% / +6.5 | 81% / +8.5 | 73% / +7.5 | 69% / +8.5 | 69% / +15.4 | +40 (+15.4) |
| -50 | 85% / +0.8 | 85% / +5.0 | 81% / +6.5 | 73% / +4.8 | 69% / +5.4 | 69% / +12.3 | +40 (+12.3) |

**NY, half H1** (n = 12 (small)). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 67% / +0.0 | 58% / +0.4 | 50% / +0.0 | 50% / +2.5 | 42% / +0.8 | 25% / -5.0 | +25 (+2.5) |
| -30 | 67% / -3.3 | 58% / -3.8 | 50% / -5.0 | 50% / -2.5 | 42% / -5.0 | 33% / -6.7 | +25 (-2.5) |
| -40 | 67% / -6.7 | 58% / -7.9 | 50% / -10.0 | 50% / -7.5 | 42% / -10.8 | 33% / -13.3 | +10 (-6.7) |
| -50 | 67% / -10.0 | 58% / -12.1 | 50% / -15.0 | 50% / -12.5 | 42% / -16.7 | 33% / -20.0 | +10 (-10.0) |

**Asia, half H2** (n = 42). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 69% / +0.7 | 57% / +0.0 | 50% / +0.0 | 48% / +1.4 | 48% / +3.8 | 40% / +4.3 | +40 (+4.3) |
| -30 | 76% / +0.5 | 69% / +1.1 | 62% / +1.0 | 60% / +2.7 | 57% / +4.3 | 48% / +3.3 | +30 (+4.3) |
| -40 | 83% / +1.7 | 76% / +1.9 | 69% / +1.4 | 64% / +1.8 | 62% / +3.3 | 52% / +2.1 | +30 (+3.3) |
| -50 | 90% / +4.3 | 86% / +5.7 | 81% / +6.7 | 76% / +7.1 | 74% / +9.0 | 57% / +1.9 | +30 (+9.0) |

**London, half H2** (n = 25). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 60% / -2.0 | 48% / -3.2 | 36% / -5.6 | 32% / -5.6 | 28% / -6.0 | 20% / -8.0 | +10 (-2.0) |
| -30 | 68% / -2.8 | 52% / -6.6 | 44% / -8.0 | 44% / -5.8 | 36% / -8.4 | 28% / -10.4 | +10 (-2.8) |
| -40 | 76% / -2.0 | 56% / -9.2 | 48% / -11.2 | 48% / -8.8 | 40% / -12.0 | 36% / -11.2 | +10 (-2.0) |
| -50 | 84% / +0.4 | 64% / -8.4 | 56% / -10.8 | 56% / -8.0 | 48% / -11.6 | 44% / -10.4 | +10 (+0.4) |

**NY, half H2** (n = 21). Cell: P(+X before -S) % / expectancy pts per contract (all out at +X, stop -S, unresolved after 240 min marked at the last close).

| stop S | +10 | +15 | +20 | +25 | +30 | +40 | best |
|---|---|---|---|---|---|---|---|
| -20 | 62% / -1.4 | 52% / -1.7 | 48% / -1.0 | 48% / +1.4 | 48% / +3.8 | 43% / +5.7 | +40 (+5.7) |
| -30 | 67% / -3.3 | 62% / -2.1 | 57% / -1.4 | 57% / +1.4 | 57% / +4.3 | 52% / +6.7 | +40 (+6.7) |
| -40 | 67% / -6.7 | 67% / -3.3 | 62% / -2.9 | 62% / +0.2 | 62% / +3.3 | 62% / +9.5 | +40 (+9.5) |
| -50 | 71% / -7.1 | 71% / -3.6 | 67% / -3.3 | 67% / +0.0 | 67% / +3.3 | 67% / +10.0 | +40 (+10.0) |


## 4. Scaled-rule counterfactuals

About 45 rules are compared; read the CI columns with that in mind. H1 = trade days 10/28-10/30, H2 = 11/02-11/11.

### Table 4. Scaled-rule counterfactuals (first-order, same entries, model against model)

Model check: the bot model on live rules gives net $+238 against the real $+78; exit class agrees on 137 of 149 trades; mean |pts/c error| 4.3. Model classes: {'no-progress': 50, 'tp1': 77, 'full-stop': 22}. All changes below are model variant minus model live, per trade, so the model's own bias cancels to first order.

| rule | TP1 pts used (med, range) | n | win% | net $ (model) | pts/c | full stops | no-progress exits | change vs live $ | 95% CI (trade bootstrap) | 95% CI (day-cluster) | H1 change (n=61) | H2 change (n=88) | Asia / London / NY change | median hold min | later entries inside the hold | protect stops |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) live: TP1 15, no-progress 15, lock 10 | 15 (15-15) | 149 | 61 | +238 | +0.20 | 22 | 50 | +0 | +0..+0 | +0..+0 | +0 | +0 | +0 / +0 / +0 | 6 | 5 | 0 |
| (b) TP1 = 0.5 x ATR15, floor 15 | 26 (15-68) | 149 | 51 | +245 | +0.55 | 37 | 50 | +7 | -2845..+2683 | -3548..+3184 | +59 | -52 | -419 / +34 / +392 | 8 | 29 | 0 |
| (b) TP1 = 0.75 x ATR15, floor 15 | 40 (15-103) | 149 | 50 | +4247 | +5.37 | 39 | 50 | +4009 | +224..+7543 | -233..+9101 | +2174 | +1835 | +880 / +1104 / +2024 | 9 | 47 | 0 |
| (b) TP1 = 1.0 x ATR15, floor 15 | 52 (15-137) | 149 | 46 | +6433 | +8.12 | 44 | 50 | +6195 | +1349..+10954 | -226..+14036 | +4008 | +2187 | +2095 / +1734 / +2366 | 9 | 66 | 0 |
| (b+) TP1 = 0.25 x ATR15, floor 15 | 15 (15-34) | 149 | 59 | +33 | +0.00 | 25 | 50 | -205 | -1473..+768 | -1205..+664 | -155 | -50 | -146 / +1 / -60 | 6 | 7 | 0 |
| (b+) TP1 = 0.33 x ATR15, floor 15 | 17 (15-45) | 149 | 56 | -371 | -0.38 | 30 | 50 | -609 | -2560..+1066 | -1629..+314 | -198 | -411 | -764 / +78 / +76 | 7 | 10 | 0 |
| (c) NY TP1 20, Asia/London 15 | 15 (15-20) | 149 | 60 | -193 | -0.26 | 24 | 50 | -431 | -1722..+460 | -1355..+273 | -311 | -120 | +0 / +0 / -431 | 6 | 5 | 0 |
| (c) NY TP1 25, Asia/London 15 | 15 (15-25) | 149 | 60 | +277 | +0.28 | 24 | 50 | +39 | -1310..+1042 | -1012..+747 | -181 | +220 | +0 / +0 / +39 | 6 | 5 | 0 |
| (c) NY TP1 30, Asia/London 15 | 15 (15-30) | 149 | 60 | +727 | +0.81 | 24 | 50 | +489 | -955..+1601 | -746..+1453 | -31 | +520 | +0 / +0 / +489 | 6 | 8 | 0 |
| (c+) TP1 20 in every session | 20 (20-20) | 149 | 55 | -648 | -0.71 | 31 | 50 | -886 | -2891..+799 | -2358..+495 | -304 | -582 | -385 / -70 / -431 | 7 | 13 | 0 |
| (c+) TP1 25 in every session | 25 (25-25) | 149 | 53 | -17 | +0.07 | 34 | 50 | -255 | -2641..+1865 | -2405..+1744 | -366 | +112 | -314 / +20 / +39 | 7 | 24 | 0 |
| (c+) Asia 20 / London 15 / NY 15 | 15 (15-20) | 149 | 58 | -147 | -0.17 | 26 | 50 | -385 | -1582..+590 | -1376..+607 | -253 | -132 | -385 / +0 / +0 | 6 | 10 | 0 |
| (c+) Asia 15 / London 20 / NY 15 | 15 (15-20) | 149 | 59 | +168 | +0.12 | 25 | 50 | -70 | -1060..+760 | -810..+780 | +260 | -330 | +0 / -70 / +0 | 6 | 8 | 0 |
| (d) TP1 = 0.5 x ATR15 and no-progress = TP1 | 26 (15-68) | 149 | 52 | -268 | -0.11 | 25 | 87 | -506 | -2121..+1000 | -1816..+948 | +197 | -704 | -731 / -358 / +583 | 7 | 10 | 0 |
| (d) TP1 = 0.75 x ATR15 and no-progress = TP1 | 40 (15-103) | 149 | 50 | -332 | -0.19 | 25 | 108 | -570 | -2408..+1268 | -1696..+709 | -201 | -369 | -715 / -318 / +462 | 8 | 11 | 0 |
| (d) TP1 = 1.0 x ATR15 and no-progress = TP1 | 52 (15-137) | 149 | 50 | -56 | +0.17 | 25 | 114 | -294 | -2218..+1628 | -1523..+1069 | -92 | -202 | -507 / -330 / +543 | 8 | 11 | 0 |
| (d) NY TP1 20 and NY no-progress 20 | 15 (15-20) | 149 | 60 | +115 | +0.08 | 22 | 54 | -123 | -776..+338 | -720..+273 | +72 | -195 | +0 / +0 / -123 | 6 | 5 | 0 |
| (d) NY TP1 25 and NY no-progress 25 | 15 (15-25) | 149 | 60 | +514 | +0.55 | 22 | 54 | +276 | -448..+863 | -132..+673 | +202 | +74 | +0 / +0 / +276 | 6 | 5 | 0 |
| (d) NY TP1 30 and NY no-progress 30 | 15 (15-30) | 149 | 59 | +703 | +0.77 | 22 | 56 | +464 | -372..+1214 | +40..+932 | +329 | +136 | +0 / +0 / +464 | 6 | 7 | 0 |
| (e) NY TP1 20, NY lock 15 (lock scaled too) | 15 (15-20) | 149 | 60 | -151 | -0.21 | 24 | 50 | -390 | -1682..+504 | -1322..+280 | -298 | -92 | +0 / +0 / -390 | 6 | 5 | 0 |
| (e) NY TP1 25, NY lock 20 (lock scaled too) | 15 (15-25) | 149 | 60 | +310 | +0.33 | 24 | 50 | +72 | -1303..+1078 | -976..+783 | -168 | +240 | +0 / +0 / +72 | 6 | 5 | 0 |
| (e) NY TP1 30, NY lock 25 (lock scaled too) | 15 (15-30) | 149 | 60 | +780 | +0.88 | 24 | 50 | +542 | -900..+1670 | -703..+1532 | -8 | +550 | +0 / +0 / +542 | 6 | 7 | 0 |
| (f) live TP1, runner lock +5 instead of +10 | 15 (15-15) | 149 | 61 | +127 | +0.07 | 22 | 50 | -111 | -270..+74 | -208..+9 | -7 | -104 | -54 / -10 / -47 | 6 | 8 | 0 |
| (f) live TP1, runner lock 0 (break-even) | 15 (15-15) | 149 | 61 | +154 | +0.10 | 22 | 50 | -84 | -320..+176 | -233..+80 | -33 | -51 | -4 / -60 / -20 | 6 | 10 | 0 |
| (g) live, no-progress exit off | 15 (15-15) | 149 | 72 | +802 | +1.10 | 41 | 0 | +564 | -1608..+2686 | -1667..+3173 | -247 | +811 | +773 / -39 / -170 | 6 | 27 | 0 |
| (h) live, NY stop 40 | 15 (15-15) | 149 | 60 | +68 | +0.06 | 25 | 48 | -170 | -1039..+462 | -739..+332 | +50 | -220 | +0 / +0 / -170 | 6 | 5 | 0 |
| (h) live, NY stop 30 | 15 (15-15) | 149 | 60 | +111 | +0.21 | 27 | 47 | -127 | -1102..+705 | -900..+549 | +172 | -300 | +0 / +0 / -127 | 6 | 5 | 0 |
| (h) live, Asia/London stop +10 (wider) | 15 (15-15) | 149 | 62 | +488 | +0.48 | 15 | 55 | +250 | -483..+1167 | -498..+1144 | +57 | +193 | +205 / +45 / +0 | 6 | 5 | 0 |
| (i) TP1 = 0.5 x ATR15, stop to +0 once +15 is seen | 26 (15-68) | 149 | 40 | +569 | +0.77 | 22 | 50 | +331 | -1080..+1811 | -702..+1320 | +260 | +70 | -245 / -138 / +714 | 7 | 19 | 31 |
| (i) TP1 = 0.5 x ATR15, stop to -10 once +15 is seen | 26 (15-68) | 149 | 46 | +433 | +0.76 | 22 | 50 | +195 | -1713..+2096 | -1027..+1500 | +530 | -334 | -127 / +28 / +294 | 7 | 21 | 23 |
| (i) TP1 = 0.75 x ATR15, stop to +0 once +15 is seen | 40 (15-103) | 149 | 34 | +1874 | +2.32 | 22 | 50 | +1636 | -421..+4014 | +231..+3104 | +1029 | +606 | +548 / +75 / +1012 | 7 | 27 | 41 |
| (i) TP1 = 0.75 x ATR15, stop to -10 once +15 is seen | 40 (15-103) | 149 | 39 | +1891 | +2.53 | 22 | 50 | +1653 | -1024..+4529 | -293..+4568 | +1696 | -44 | +713 / +568 / +372 | 8 | 32 | 33 |
| (i) TP1 = 1.0 x ATR15, stop to +0 once +15 is seen | 52 (15-137) | 149 | 30 | +2969 | +3.76 | 22 | 50 | +2731 | -40..+5849 | +469..+5542 | +1880 | +850 | +1015 / +166 / +1550 | 8 | 35 | 46 |
| (i) TP1 = 1.0 x ATR15, stop to -10 once +15 is seen | 52 (15-137) | 149 | 36 | +3318 | +4.38 | 22 | 50 | +3080 | -335..+6797 | -125..+8000 | +2555 | +525 | +1695 / +535 / +850 | 9 | 42 | 38 |
| (i) TP1 30 every session, stop to +0 once +15 is seen | 30 (30-30) | 149 | 40 | +1167 | +1.30 | 22 | 50 | +929 | -399..+2266 | -422..+2435 | +189 | +740 | +299 / -30 / +660 | 7 | 18 | 31 |
| (c+) TP1 30 every session (no protect) | 30 (30-30) | 149 | 51 | +597 | +0.86 | 37 | 50 | +359 | -2410..+2831 | -2939..+3189 | -259 | +618 | -250 / +120 / +489 | 8 | 31 | 0 |
| (i) TP1 40 every session, stop to +0 once +15 is seen | 40 (40-40) | 149 | 32 | +936 | +1.11 | 22 | 50 | +698 | -1114..+2682 | -228..+1484 | +129 | +568 | -35 / +70 / +662 | 8 | 27 | 44 |
| (c+) TP1 40 every session (no protect) | 40 (40-40) | 149 | 47 | +1633 | +2.23 | 43 | 50 | +1395 | -2255..+4714 | -1770..+5718 | +1021 | +374 | -304 / +1010 / +688 | 9 | 51 | 0 |
| (i) Asia/London 15, NY TP1 30, stop to +0 once +15 is seen | 15 (15-30) | 149 | 58 | +898 | +0.94 | 22 | 50 | +660 | +30..+1323 | -22..+1522 | +200 | +460 | +0 / +0 / +660 | 6 | 7 | 5 |
| (i) Asia/London 15, NY TP1 40, stop to +0 once +15 is seen | 15 (15-40) | 149 | 55 | +900 | +0.97 | 22 | 50 | +662 | -369..+1748 | -413..+1894 | +53 | +608 | +0 / +0 / +662 | 6 | 7 | 9 |
| (c) NY TP1 40, Asia/London 15 | 15 (15-40) | 149 | 58 | +926 | +1.09 | 26 | 50 | +688 | -1242..+2409 | -1063..+2558 | -190 | +878 | +0 / +0 / +688 | 6 | 10 | 0 |
| (j) TP1 = 0.75 x ATR15 capped at 40 | 40 (15-40) | 149 | 50 | +2315 | +2.97 | 38 | 50 | +2077 | -1189..+4954 | -1577..+6017 | +1101 | +976 | -80 / +965 / +1192 | 9 | 41 | 0 |
| (j) TP1 = 0.75 x ATR15 capped at 60 | 40 (15-60) | 149 | 50 | +3821 | +4.86 | 39 | 50 | +3583 | -100..+7016 | -436..+8352 | +1974 | +1609 | +606 / +1104 / +1872 | 9 | 45 | 0 |

Per trade day, change vs live for TP1 = 0.75 x ATR15: 10-28 +310, 10-29 -558, 10-30 +2422, 11-02 +1253, 11-03 -193, 11-04 +493, 11-10 +208, 11-11 +74. Worst leave-one-day-out total: +1587.
Per trade day, change vs live for TP1 = 1.0 x ATR15: 10-28 +7, 10-29 +209, 10-30 +3792, 11-02 +1724, 11-03 -894, 11-04 +842, 11-10 +384, 11-11 +132. Worst leave-one-day-out total: +2403.

Runner facts (live): 79 runners; 62 ended at the +10 lock or lower (78%); mean runner 14.1 pts. By session: Asia 27/34 at the lock, mean 13.5; London 21/26 at the lock, mean 13.0; NY 14/19 at the lock, mean 16.6

Path sources: {'true': 119, 'coarse': 30} ('coarse' = the 20 trades of 11/09-11/10: in-trade minutes from the bot's own trade_state rows, later minutes from one price sample per minute, which understates wicks by roughly a third on 5m). Vol tag sources: {'true': 124, 'sampled': 25}.
