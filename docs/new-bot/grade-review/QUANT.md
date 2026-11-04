# Setup GRADE, quant desk (MacGradeQuant, 11/04)

## Recommendation (read this first)
- **Effective sample: 114 independent episodes** (537 setups collapse at a median of 3 per episode, up to 28), and 77 taken-if-flat trades. The base rate is 29% 2R-first, avg -0.11R per episode (taken-if-flat: 38%, +0.14R).
- **Only one factor clearly separates good from bad: the breaking-wave bias peak, and it is a BAND, not "higher is better".**
  - Episodes by peak: <0.20 17% (avg -0.50R, n=24); 0.20-0.30 20% (-0.37R, n=25); **0.30-0.40 59% (+0.78R, n=32)**; >=0.40 15% (-0.49R, n=33).
  - Peak >=0.40 is **exhaustion**: -19 pp per episode [90% CI -32, -5], -31 pp taken-if-flat [-48, -13]. Out of sample (11/03-11/04) it went **0 for 11 (-0.83R)**. This is the one result that held forward.
- **Recommended grade** (2 points, honest for n=114):
  - REQUIRED: 4H control + valid trigger + control taken (wave peak >= 0.20 our way). Nothing at the entry minute.
  - **+1 impulse in band:** 0.30 <= wave peak < 0.40 (the band was fitted on 10/28-11/02).
  - **+1 volume rhythm:** pullback mean 5m volume < break-candle volume (weak evidence; see the table).
  - A+ = 2, B = 1, C = 0 (C = the required items only).
  - **Peak >= 0.40 must never score the impulse point.** Better: cap it at C until a lower-timeframe confirmation (playbook §12.5 climax rule).
  - Result: episodes A+ 19% of trades at 64% 2R-first (+0.91R), B 37% at 21% (-0.29R), C 23% at 23% (-0.31R), no trade 21% at 17% (-0.50R).
    Taken-if-flat: A+ 18% at 79% (+1.36R), B 43% at 33% (+0.03R), C 26% at 25% (-0.25R).
- **Drop from the points (no positive effect measured):** strong pool, trap kind, displacement, touch count, session, entry-minute bias, growing turn, stop distance. Keep journaling all of them.
- **The current proposal does not order its grades:** its A+ hit 27% (-0.10R), below its own B at 38% (+0.13R). Out of sample its A+ went 0/5.

## Caveats (where the sample is too small)
- **Walk-forward is too small to confirm the A+ band.** The test set (11/03-11/04) has 19 episodes. A+ = 1 (won); the 0.30-0.40 band has 2 test episodes. B went 0/9 in test.
  Only the >= 0.40 exhaustion finding has real out-of-sample support.
- **"First retest" is not testable here.** With 60-min chaining almost every episode is the first at its level in the 4H (111 of 114). The 3 later ones all stopped. Mac's §13.7 stays as a rule, not a measured point.
- **Displacement is my proxy.** It is the best 5m candle in the wave (body % and range vs the 20-bar average), not the r2 structure engine's shift candle.
  It showed no gain, and at 1.5x range it was negative (-17 pp [-30, -3]): big candles behave like the exhaustion peak.
  Re-test this once the r2 engine journals the real shift candle.
- **Market state (1H trend/range) was skipped** for the 20-min deadline.
- The setups come from the r1 fixes-on generator (5m-close retest entries), not the r2 engine. Outcomes are 2R vs the auto rule-C stop, not the r2 exit ladder. 11/04 has only 3 episodes (data ends 11/03 19:48 PT).

## Method
- `quant.py` (stdlib; `nice -n 19 python3 -I quant.py SCRATCH`) recomputes everything from setups.csv, readings.csv, m1 and m5.
- **Episode rule:** setups join one episode if they are the same direction, the level price is within 3 pts, and the setup comes <= 60 min after the previous member or before the first member's trade resolved. An episode is scored by its first setup.
- **Wave:** from the last 1m close that crossed the level our way (<= 240 min back) to the retest bar.
  - Peak = max over those minutes of max(dir x forming-15m, dir x forming-30m).
- **Volume:** break candle = the 5m bar holding the break, compared with its 20-bar median.
  - Pullback = the 5m bars from the wave extreme through the retest bar.
- **Bootstrap:** 2000 resamples per group, over episodes (or trades), 90% CI on the difference.

# Setup GRADE: quant evidence (MacGradeQuant, 11/04)

Data: tide/study/fixes_on/setups.csv (537 setups, TradeDays 10/28-11/04, last 1m bar 11/03 19:48 PT). Outcome = +2R before the auto rule-C stop (`stop` column), first touch on 1m from the entry minute, same 1m = stop, flat at 14:00 PT (MTM, clipped to [-1, +2]). Avg R = +2 / -1 / MTM.

**Episode rule:** setups join one episode when same direction, level price within 3 pts (so 4H Open / 1H Open at one price merge), and the setup comes <= 60 min after the previous member OR before the first member's trade has resolved. Each episode is scored by its FIRST setup (what a bot would take).

- All setups: 537 rows, 2R-first 158 (29%), stop 376, close/data-end 3, avg R -0.11
- Episodes (first setup): 114 rows, 2R-first 33 (29%), stop 79, close/data-end 2, avg R -0.11
- Taken-if-flat: 77 rows, 2R-first 29 (38%), stop 47, close/data-end 1, avg R +0.14
- Episodes per TradeDay: 10-28 29, 10-29 23, 10-30 15, 11-02 28, 11-03 16, 11-04 3
- Median setups per episode 3, max 28.

### Per episode (n=114), bootstrap over episodes, 2000 resamples

| factor | n with / without | 2R-first with / without | diff [90% CI] | avg R with / without | diff R [90% CI] |
|---|---|---|---|---|---|
| strong pool type (not 1H Open) | 72 / 42 | 31% / 26% | +4 pp [-11, +18] | -0.05 / -0.21 | +0.17 [-0.28, +0.59] |
| 4H Open | 43 / 71 | 30% / 28% | +2 pp [-12, +17] | -0.07 / -0.13 | +0.06 [-0.36, +0.51] |
| PDH/PDL | 10 / 104 | 20% / 30% | -10 pp [-31, +15] | -0.40 / -0.08 | -0.32 [-0.94, +0.41] |
| session H/L (Asia/London) | 19 / 95 | 37% / 27% | +9 pp [-9, +29] | +0.20 / -0.17 | +0.37 [-0.19, +0.95] |
| 1H Open | 42 / 72 | 26% / 31% | -4 pp [-18, +11] | -0.21 / -0.05 | -0.17 [-0.58, +0.29] |
| touches >= 2 (24h) | 93 / 21 | 27% / 38% | -11 pp [-30, +7] | -0.17 / +0.18 | -0.36 [-0.92, +0.19] |
| touches >= 3 (24h) | 71 / 43 | 30% / 28% | +2 pp [-13, +17] | -0.09 / -0.14 | +0.06 [-0.38, +0.50] |
| trap control (vs below/above) | 80 / 34 | 25% / 38% | -13 pp [-29, +3] | -0.23 / +0.17 | -0.40 [-0.89, +0.09] |
| strong-pool trap | 52 / 62 | 27% / 31% | -4 pp [-18, +10] | -0.16 / -0.07 | -0.09 [-0.52, +0.33] |
| real break found (vs no-break rejection) | too few | | | | |
| displacement 5m body>=50% range>=1.0x | 71 / 43 | 24% / 37% | -13 pp [-28, +2] | -0.26 / +0.14 | -0.39 [-0.83, +0.05] |
| displacement body>=60% range>=1.0x | 65 / 49 | 23% / 37% | -14 pp [-28, +1] | -0.28 / +0.12 | -0.40 [-0.83, +0.03] |
| displacement body>=70% range>=1.0x | 58 / 56 | 24% / 34% | -10 pp [-24, +4] | -0.24 / +0.03 | -0.28 [-0.69, +0.14] |
| displacement body>=60% range>=1.5x | 35 / 79 | 17% / 34% | -17 pp [-30, -3] | -0.43 / +0.04 | -0.47 [-0.87, -0.06] |
| first retest (first episode at level in 4H) | 111 / 3 | 30% / 0% | +30 pp [+23, +37] | -0.08 / -1.00 | +0.92 [+0.71, +1.13] |
| wave peak >= 0.20 | 90 / 24 | 32% / 17% | +16 pp [+1, +30] | -0.00 / -0.50 | +0.50 [+0.06, +0.92] |
| wave peak >= 0.25 | 77 / 37 | 35% / 16% | +19 pp [+6, +32] | +0.09 / -0.51 | +0.60 [+0.22, +0.99] |
| wave peak >= 0.30 | 65 / 49 | 37% / 18% | +19 pp [+4, +32] | +0.14 / -0.43 | +0.57 [+0.14, +0.96] |
| wave peak >= 0.35 | 54 / 60 | 31% / 27% | +5 pp [-10, +19] | -0.02 / -0.19 | +0.16 [-0.28, +0.58] |
| wave peak >= 0.40 (exhaustion test) | 33 / 81 | 15% / 35% | -19 pp [-32, -5] | -0.49 / +0.05 | -0.54 [-0.93, -0.11] |
| entry-minute bias with us >= 0.15 | 73 / 41 | 32% / 24% | +7 pp [-8, +21] | -0.02 / -0.27 | +0.25 [-0.20, +0.68] |
| entry-minute bias against <= -0.15 | 7 / 107 | 43% / 28% | +15 pp [-17, +47] | +0.29 / -0.13 | +0.42 [-0.52, +1.40] |
| growing turn (5-min swing >= 0.10) | 16 / 98 | 44% / 27% | +17 pp [-4, +39] | +0.31 / -0.18 | +0.49 [-0.14, +1.14] |
| break vol >= 1.5x 20-bar median | 39 / 75 | 23% / 32% | -9 pp [-23, +5] | -0.26 / -0.03 | -0.23 [-0.67, +0.20] |
| pullback vol < break vol | 69 / 45 | 32% / 24% | +7 pp [-7, +21] | -0.00 / -0.27 | +0.26 [-0.17, +0.68] |
| session NY | 35 / 79 | 34% / 27% | +8 pp [-8, +24] | +0.03 / -0.17 | +0.20 [-0.28, +0.68] |
| session London | 32 / 82 | 28% / 29% | -1 pp [-16, +14] | -0.16 / -0.09 | -0.07 [-0.52, +0.40] |
| session Asia | 47 / 67 | 26% / 31% | -6 pp [-20, +8] | -0.18 / -0.06 | -0.12 [-0.53, +0.29] |
| within 60 min of a session open | 15 / 99 | 40% / 27% | +13 pp [-8, +34] | +0.20 / -0.15 | +0.35 [-0.28, +0.99] |
| stop <= 40 pts | 22 / 92 | 23% / 30% | -8 pp [-24, +8] | -0.32 / -0.06 | -0.26 [-0.75, +0.24] |
| stop <= 60 pts | 40 / 74 | 35% / 26% | +9 pp [-6, +25] | +0.07 / -0.20 | +0.28 [-0.16, +0.74] |
| stop > 75 pts | 60 / 54 | 30% / 28% | +2 pp [-12, +16] | -0.07 / -0.15 | +0.08 [-0.32, +0.49] |

### Taken-if-flat (n=77)

| factor | n with / without | 2R-first with / without | diff [90% CI] | avg R with / without | diff R [90% CI] |
|---|---|---|---|---|---|
| strong pool type (not 1H Open) | 53 / 24 | 40% / 33% | +6 pp [-14, +25] | +0.21 / +0.00 | +0.21 [-0.40, +0.76] |
| 4H Open | 35 / 42 | 37% / 38% | -1 pp [-20, +18] | +0.14 / +0.14 | -0.00 [-0.58, +0.56] |
| PDH/PDL | 8 / 69 | 38% / 38% | -0 pp [-29, +31] | +0.12 / +0.14 | -0.02 [-0.89, +0.91] |
| session H/L (Asia/London) | 10 / 67 | 50% / 36% | +14 pp [-13, +43] | +0.50 / +0.09 | +0.41 [-0.40, +1.25] |
| 1H Open | 24 / 53 | 33% / 40% | -6 pp [-25, +14] | +0.00 / +0.21 | -0.21 [-0.77, +0.40] |
| touches >= 2 (24h) | 62 / 15 | 37% / 40% | -3 pp [-28, +19] | +0.11 / +0.26 | -0.14 [-0.85, +0.50] |
| touches >= 3 (24h) | 48 / 29 | 38% / 38% | -0 pp [-19, +18] | +0.12 / +0.17 | -0.04 [-0.60, +0.51] |
| trap control (vs below/above) | 48 / 29 | 35% / 41% | -6 pp [-25, +13] | +0.06 / +0.27 | -0.21 [-0.78, +0.35] |
| strong-pool trap | 32 / 45 | 38% / 38% | -0 pp [-19, +18] | +0.12 / +0.15 | -0.03 [-0.58, +0.53] |
| real break found (vs no-break rejection) | too few | | | | |
| displacement 5m body>=50% range>=1.0x | 48 / 29 | 42% / 31% | +11 pp [-7, +29] | +0.25 / -0.04 | +0.29 [-0.25, +0.83] |
| displacement body>=60% range>=1.0x | 42 / 35 | 38% / 37% | +1 pp [-18, +19] | +0.14 / +0.14 | +0.00 [-0.57, +0.55] |
| displacement body>=70% range>=1.0x | 38 / 39 | 39% / 36% | +4 pp [-15, +22] | +0.18 / +0.10 | +0.09 [-0.46, +0.64] |
| displacement body>=60% range>=1.5x | 21 / 56 | 24% / 43% | -19 pp [-38, +0] | -0.29 / +0.30 | -0.59 [-1.14, -0.02] |
| first retest (first episode at level in 4H) | too few | | | | |
| wave peak >= 0.20 | 67 / 10 | 40% / 20% | +20 pp [-4, +42] | +0.22 / -0.40 | +0.62 [-0.11, +1.30] |
| wave peak >= 0.25 | 58 / 19 | 40% / 32% | +8 pp [-13, +29] | +0.20 / -0.05 | +0.26 [-0.37, +0.87] |
| wave peak >= 0.30 | 51 / 26 | 39% / 35% | +5 pp [-15, +24] | +0.18 / +0.07 | +0.10 [-0.48, +0.66] |
| wave peak >= 0.35 | 46 / 31 | 37% / 39% | -2 pp [-20, +18] | +0.11 / +0.19 | -0.08 [-0.63, +0.48] |
| wave peak >= 0.40 (exhaustion test) | 31 / 46 | 19% / 50% | -31 pp [-48, -13] | -0.42 / +0.52 | -0.94 [-1.46, -0.42] |
| entry-minute bias with us >= 0.15 | 34 / 43 | 38% / 37% | +1 pp [-18, +19] | +0.17 / +0.12 | +0.06 [-0.51, +0.60] |
| entry-minute bias against <= -0.15 | too few | | | | |
| growing turn (5-min swing >= 0.10) | 9 / 68 | 44% / 37% | +8 pp [-19, +37] | +0.33 / +0.12 | +0.22 [-0.58, +1.10] |
| break vol >= 1.5x 20-bar median | 33 / 44 | 45% / 32% | +14 pp [-5, +31] | +0.36 / -0.03 | +0.39 [-0.15, +0.92] |
| pullback vol < break vol | 48 / 29 | 44% / 28% | +16 pp [-1, +34] | +0.33 / -0.17 | +0.50 [-0.03, +1.02] |
| session NY | 34 / 43 | 35% / 40% | -4 pp [-22, +15] | +0.06 / +0.21 | -0.15 [-0.68, +0.40] |
| session London | 17 / 60 | 53% / 33% | +20 pp [-2, +42] | +0.59 / +0.01 | +0.57 [-0.08, +1.24] |
| session Asia | 26 / 51 | 31% / 41% | -10 pp [-30, +7] | -0.04 / +0.24 | -0.28 [-0.84, +0.26] |
| within 60 min of a session open | 11 / 66 | 45% / 36% | +9 pp [-18, +36] | +0.36 / +0.10 | +0.26 [-0.57, +1.08] |
| stop <= 40 pts | 18 / 59 | 28% / 41% | -13 pp [-33, +9] | -0.17 / +0.24 | -0.40 [-1.00, +0.25] |
| stop <= 60 pts | 28 / 49 | 36% / 39% | -3 pp [-21, +16] | +0.10 / +0.16 | -0.06 [-0.61, +0.51] |
| stop > 75 pts | 44 / 33 | 39% / 36% | +2 pp [-16, +21] | +0.16 / +0.12 | +0.04 [-0.50, +0.61] |

### All setups, for reference only (n=537, NOT independent: CIs too narrow)

| factor | n with / without | 2R-first with / without | diff [90% CI] | avg R with / without | diff R [90% CI] |
|---|---|---|---|---|---|
| strong pool type (not 1H Open) | 404 / 133 | 29% / 32% | -3 pp [-10, +5] | -0.13 / -0.05 | -0.07 [-0.30, +0.16] |
| 4H Open | 267 / 270 | 25% / 34% | -9 pp [-15, -2] | -0.24 / +0.02 | -0.27 [-0.47, -0.08] |
| PDH/PDL | 62 / 475 | 37% / 28% | +9 pp [-2, +19] | +0.11 / -0.14 | +0.25 [-0.09, +0.57] |
| session H/L (Asia/London) | 75 / 462 | 35% / 29% | +6 pp [-3, +16] | +0.09 / -0.14 | +0.23 [-0.05, +0.52] |
| 1H Open | 133 / 404 | 32% / 29% | +3 pp [-5, +10] | -0.05 / -0.13 | +0.07 [-0.15, +0.29] |
| touches >= 2 (24h) | 467 / 70 | 28% / 36% | -7 pp [-17, +2] | -0.14 / +0.08 | -0.22 [-0.51, +0.07] |
| touches >= 3 (24h) | 343 / 194 | 31% / 27% | +4 pp [-2, +11] | -0.06 / -0.19 | +0.13 [-0.07, +0.33] |
| trap control (vs below/above) | 350 / 187 | 27% / 35% | -8 pp [-15, -1] | -0.19 / +0.05 | -0.24 [-0.44, -0.03] |
| strong-pool trap | 268 / 269 | 28% / 31% | -3 pp [-9, +3] | -0.15 / -0.07 | -0.08 [-0.27, +0.12] |
| real break found (vs no-break rejection) | 534 / 3 | 29% / 33% | -4 pp [-41, +31] | -0.11 / +0.00 | -0.11 [-1.22, +0.95] |
| displacement 5m body>=50% range>=1.0x | 354 / 183 | 32% / 24% | +8 pp [+1, +15] | -0.02 / -0.27 | +0.25 [+0.04, +0.44] |
| displacement body>=60% range>=1.0x | 307 / 230 | 31% / 28% | +3 pp [-4, +9] | -0.07 / -0.16 | +0.09 [-0.10, +0.27] |
| displacement body>=70% range>=1.0x | 263 / 274 | 31% / 28% | +3 pp [-3, +10] | -0.05 / -0.16 | +0.11 [-0.07, +0.30] |
| displacement body>=60% range>=1.5x | 147 / 390 | 29% / 29% | -0 pp [-8, +7] | -0.10 / -0.11 | +0.02 [-0.21, +0.25] |
| first retest (first episode at level in 4H) | 514 / 23 | 31% / 0% | +31 pp [+27, +34] | -0.07 / -1.00 | +0.93 [+0.83, +1.03] |
| wave peak >= 0.20 | 463 / 74 | 32% / 15% | +17 pp [+9, +24] | -0.04 / -0.55 | +0.52 [+0.28, +0.73] |
| wave peak >= 0.25 | 385 / 152 | 32% / 22% | +10 pp [+3, +16] | -0.02 / -0.33 | +0.31 [+0.10, +0.50] |
| wave peak >= 0.30 | 317 / 220 | 36% / 20% | +17 pp [+10, +23] | +0.10 / -0.41 | +0.51 [+0.31, +0.70] |
| wave peak >= 0.35 | 227 / 310 | 38% / 23% | +15 pp [+8, +21] | +0.15 / -0.30 | +0.45 [+0.25, +0.66] |
| wave peak >= 0.40 (exhaustion test) | 109 / 428 | 17% / 32% | -15 pp [-22, -8] | -0.44 / -0.02 | -0.42 [-0.63, -0.20] |
| entry-minute bias with us >= 0.15 | 254 / 283 | 34% / 25% | +8 pp [+2, +14] | +0.03 / -0.24 | +0.27 [+0.08, +0.45] |
| entry-minute bias against <= -0.15 | 25 / 512 | 36% / 29% | +7 pp [-9, +24] | +0.08 / -0.12 | +0.20 [-0.27, +0.70] |
| growing turn (5-min swing >= 0.10) | 116 / 421 | 30% / 29% | +1 pp [-6, +9] | -0.09 / -0.11 | +0.02 [-0.20, +0.26] |
| break vol >= 1.5x 20-bar median | 199 / 338 | 35% / 26% | +8 pp [+2, +15] | +0.06 / -0.21 | +0.27 [+0.06, +0.47] |
| pullback vol < break vol | 387 / 150 | 29% / 31% | -3 pp [-10, +5] | -0.13 / -0.06 | -0.07 [-0.29, +0.15] |
| session NY | 126 / 411 | 29% / 30% | -1 pp [-8, +7] | -0.14 / -0.10 | -0.04 [-0.27, +0.19] |
| session London | 185 / 352 | 33% / 28% | +5 pp [-2, +12] | -0.01 / -0.16 | +0.15 [-0.06, +0.36] |
| session Asia | 226 / 311 | 27% / 31% | -4 pp [-11, +2] | -0.17 / -0.06 | -0.11 [-0.30, +0.09] |
| within 60 min of a session open | 65 / 472 | 43% / 28% | +16 pp [+4, +26] | +0.29 / -0.16 | +0.46 [+0.12, +0.78] |
| stop <= 40 pts | 159 / 378 | 26% / 31% | -4 pp [-11, +3] | -0.21 / -0.07 | -0.14 [-0.35, +0.07] |
| stop <= 60 pts | 270 / 267 | 29% / 30% | -0 pp [-6, +6] | -0.12 / -0.10 | -0.02 [-0.21, +0.18] |
| stop > 75 pts | 202 / 335 | 35% / 26% | +9 pp [+3, +16] | +0.07 / -0.22 | +0.29 [+0.09, +0.48] |

### Wave-peak buckets (episodes)

| peak our way | n | 2R-first | avg R |
|---|---|---|---|
| -1.00-0.15 | 10 | 10% | -0.70 |
| 0.15-0.20 | 14 | 21% | -0.36 |
| 0.20-0.25 | 13 | 15% | -0.54 |
| 0.25-0.30 | 12 | 25% | -0.18 |
| 0.30-0.35 | 11 | 64% | +0.91 |
| 0.35-0.40 | 21 | 57% | +0.71 |
| 0.40-0.45 | 15 | 7% | -0.80 |
| 0.45-1.00 | 18 | 22% | -0.23 |

## Walk-forward

Band fitted on TRAIN episodes (10/28-11/02) by avg-R difference vs peak>=0.20 outside the band:

- band [0.20, 0.35): n_in 30, diff avg R -0.19
- band [0.20, 0.40): n_in 51, diff avg R +0.61
- band [0.20, 0.45): n_in 58, diff avg R +0.39
- band [0.25, 0.35): n_in 18, diff avg R +0.30
- band [0.25, 0.40): n_in 39, diff avg R +0.92
- band [0.25, 0.45): n_in 46, diff avg R +0.70
- band [0.25, inf): n_in 61, diff avg R +0.73
- band [0.30, 0.35): n_in 9, diff avg R +1.02
- band [0.30, 0.40): n_in 30, diff avg R +1.17
- band [0.30, 0.45): n_in 37, diff avg R +0.87
- band [0.30, inf): n_in 52, diff avg R +0.76

**Chosen band: 0.30 <= peak < 0.40.** Grade = required peak >= 0.20; +1 band; +1 pullback volume < break-candle volume. A+ = 2, B = 1, C = 0.

- episodes TRAIN (n=95): A+ n=21 (22%) 2R 62% avgR +0.86; B n=33 (35%) 2R 27% avgR -0.18; C n=19 (20%) 2R 26% avgR -0.21; no trade n=22 (23%) 2R 14% avgR -0.59
- episodes TEST 11/03-11/04 (n=19): A+ n=1 (5%) 2R 100% avgR +2.00; B n=9 (47%) 2R 0% avgR -0.70; C n=7 (37%) 2R 14% avgR -0.57; no trade n=2 (11%) 2R 50% avgR +0.50
- taken-if-flat TRAIN (n=54): A+ n=13 (24%) 2R 77% avgR +1.31; B n=19 (35%) 2R 37% avgR +0.11; C n=14 (26%) 2R 29% avgR -0.14; no trade n=8 (15%) 2R 25% avgR -0.25
- taken-if-flat TEST (n=23): A+ n=1 (4%) 2R 100% avgR +2.00; B n=14 (61%) 2R 29% avgR -0.08; C n=6 (26%) 2R 17% avgR -0.50; no trade n=2 (9%) 2R 0% avgR -1.00
- episodes ALL (n=114): A+ n=22 (19%) 2R 64% avgR +0.91; B n=42 (37%) 2R 21% avgR -0.29; C n=26 (23%) 2R 23% avgR -0.31; no trade n=24 (21%) 2R 17% avgR -0.50
- taken-if-flat ALL (n=77): A+ n=14 (18%) 2R 79% avgR +1.36; B n=33 (43%) 2R 33% avgR +0.03; C n=20 (26%) 2R 25% avgR -0.25; no trade n=10 (13%) 2R 20% avgR -0.40

Current proposal (required peak>=0.20; +1 strong pool type, displacement 60%/1x, first retest, peak>=0.30; 4=A+, 3=B, 2=C, <2 none):

- episodes ALL (n=114): A+ n=22 2R 27% avgR -0.10; B n=45 2R 38% avgR +0.13; C n=19 2R 26% avgR -0.16; no trade n=28 2R 18% avgR -0.46
- taken-if-flat ALL (n=77): A+ n=22 2R 32% avgR -0.05; B n=29 2R 55% avgR +0.66; C n=13 2R 23% avgR -0.24; no trade n=13 2R 23% avgR -0.31
- episodes TEST (n=19): A+ n=5 2R 0% avgR -0.63; B n=6 2R 0% avgR -1.00; C n=5 2R 40% avgR +0.37; no trade n=3 2R 33% avgR +0.00
