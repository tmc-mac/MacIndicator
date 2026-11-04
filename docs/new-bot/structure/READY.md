# lib/structure.js READY (MacStructure, tide-structure-r3.1)

- file: lib/structure.js (84522 bytes)
- sha256: da0c5c081d1586ccc2fd9cef76300c32a8b2c5f7e6f0c96f44c44df25b983018
- tests: `nice -n 19 node tests/structure.test.cjs` -> **134 passed, 0 failed**. The count is above 88 because the 4 redrawn scenarios now get through to their
  inner checks (in both directions), and the r3.1 witness and fail-closed tests are new.
- witness: `nice -n 19 node tools/trace-1104.cjs` (bias from the bot's own lib/levelsPro.js evaluateLevelsPro, tests/fixtures/witness-1104-bot.json)
- replay check: the whole 11/02-11/04 fixture gives the same 2 signals on r3.0 and r3.1 (11-03 12:04 SHORT B, 11-03 16:08 SHORT A+).

## r3.1 changes (only these)
1. Redrew the 4 failing synthetic scenarios. Only the fixture price paths changed, not the engine. The first 30 min now stay near the 4H open, so the 4H opening range
   sits with the 4H open. A quick stab to 975 makes only ONE 5m close below Asia Low, so there is no acceptance or retest of Asia Low before the trap. The sweep of Asia Low peaks at 07:53.
   The 08:00 1H open (~983) no longer bridges Asia Low and the 4H-open cluster into one zone. The trap bounce is now a lower high UNDER the broken swing,
   so there is no 5m reclaim. The accept scenario starts its 30 min at 998. Fixed a test bug: the mirror's control kind is 'above'.
2. C.1 acceptance no longer checks the bias at the 2nd close outside: accepted = >= 2 closed 5m outside. The frozen breaking-wave peak (gate `waveBias`,
   >= 0.20 our way) is the bias gate for both lanes. 4H control is still a gate. The bias reading at the acceptance is now only logged. It is still used for
   CONTROL_CANCEL: a bias-kind 4H control is cancelled only by an acceptance of the 4H open against it WITH the bias past the line, which is unchanged from r3.0.
   New witnesses (both directions):
   - accept-weak: bias 0.10 at the 2nd close, wave peak 0.25. The gate passes and the trade is taken.
   - accept-lowwave: wave peak 0.18. GRADE_NO_TRADE gives `missing: ['waveBias']` and `why: ['waveBias: wavePeakBias gte 0.2 got 0.18']`.
3. Fail-closed (MacDot):
   - `cfg.biasMaxAgeSec` (120): a {score, valid, observedAt} reading observed more than 120 s before the 1m close is stale and ignored.
   - A pullback bar with no volume makes the volume comparison unknown: no point.
   - Until two 1H swing highs and two swing lows exist, the 1H range is unknown: `midRange` is null and the notMidRange gate fails.
   - GRADE_NO_TRADE now carries `why` (each failed gate with the fields it read).

## API (pure, deterministic, CommonJS)
```
const S = require('./lib/structure.js');
let st = S.createState();
const out = S.step(st, input, cfg);   // once per CLOSED 1m bar
// input = { m1: {t,o,h,l,c,v} | [t,o,h,l,c,v]   (t = bar open, unix sec),
//           bias: { m15: {score, valid, observedAt}, m30: {...} } | { s15, s30 }   (forming 15m/30m),
//           levels: { O4, O1, PDH, PDL, AsiaH, AsiaL, LonH, LonL },
//           stoppedOut?: {dir}, trades?: [{setupId|signalId, tp1Done, closed}], speed?: [15s bars] }
// out = { state, events[], signal|null, swings, live[] }
```
- **observedAt** (ms or s) must be the as-of time of the reading, meaning the 1m close it was computed from (T or earlier). A reading is ignored if it is observed after T (that would be look-ahead),
  older than T - biasMaxAgeSec (stale), `valid: false`, or has a non-numeric score.
- Exports: VERSION, DEFAULTS, createState, step, cloneState, validateCfg, resolveCfg, gradeOf, gradeTableProblems, evidenceFor, ptLabel, ptMin, bucketStart, _internal.
- **signal fields:** id, setupId, t, at, dir, side, kind ('failed-break' | 'accepted-break'), entryType 'market', entryPrice, chosenStop, riskPts, stops, grade, gradeTotal,
  gradePoints, gradeGates, gradeDetail, gradeUncapped, gradeCapped, tags, evidence, targets / pools, internalPools, addZone, level, zone, control, defended, shift,
  retest, swings, marketState, warnings, reason.
  - entryPrice is the RETEST-REJECTION 1m close, never the shift candle.
  - chosenStop is structural and never moved.
  - tags can include 'exhaustion-watch'.
  - evidence holds every field.
  - targets / pools are ordered by distance, and every major pool is kept: PDH, PDL, 4H Open, Asia/London H/L, EQH/EQL, 4H swings.
  - addZone is the FVG or the broken swing.
- **live[]** (every open trade, each minute): setupId, signalId, entryGrade, entryPoints, currentGrade, total, points, tags, missing, upgradeReady, addNow, addPrice, stop, frozenAt, evidence.

## GRADE r3 (default cfg.grade, table-driven; conditions support {any: [[...],[...]]}; caps)
- **Gates:**
  - control4h;
  - laneTrigger: a failed break with shift body >= 0.5 and range >= 1x avg20, OR an accepted break with acceptClosesOut >= 2 and retestClosedInside === false;
  - waveBias: wavePeakBias >= 0.20;
  - firstRetest: retestNo <= 1;
  - notMidRange: midRange === false;
  - logicalStop.
  - There is no entry-minute or acceptance-minute bias check.
- **Points:**
  - trap: trapStacked;
  - force: forceLegAtrX >= 2 or dispRangeX >= 2;
  - volume: pullbackVsBreak5m < 1;
  - timing: sweepMinutesFromOpen 0..60 after 15:00 / 00:00 / 06:30 PT;
  - impulseBand: 0.30 <= wavePeakBias < 0.40.
- **Cap:** wavePeakBias >= 0.40 makes the grade at most C (tag exhaustion-watch).
- **Bands:** A+ 4-5, B 3, C 0-2.
- **Open-wait:** no signals in the first cfg.openWaitMin (30) after 15:00 / 00:00 / 06:30 PT or a 4H open. The old time blocks belong to the executor (tide.useTimeBlocks false).

## Witness 11/04 (playbook §3), unchanged from r3.0
- **Trade:** SHORT failed-break at the 4H Open. Entry 16:08 PT @ **28,366.75**, stop **28,513** (4H type: 28,511 + 2). Grade **A+ (4)**.
- **TP2:** PDL **28,035.25**, the next major pool past 2R (2.27R).
- **trap 1:** stacked pools swept: 4H Open, London High, PDH, 4H ORH.
- **force 1:** the leg is 132.25 pts = 3.16x ATR5, and the shift bar is 3.75x the average range.
- **volume 1:** the pullback 5m bars are 16:00 (10,424) and the forming 16:05 bar (6,871 in 3 min, 11,452 pro-rated). Their mean is 10,938 vs 13,911 for the break bar (15:35): ratio 0.79.
- **timing 1:** the sweep at 15:35 is 35 min after 15:00.
- **impulse 0:** the wave peak is 0.276.

## Fail-closed: a missing or unknown input never awards a point and never passes a gate (tests/structure.test.cjs)
| input | tests (group: name) |
|---|---|
| any table field | 5: "every table field (N) missing / null / NaN / wrong type: no gate it needs passes, no point it needs is awarded"; 5: "empty evidence: every gate fails, 0 points, no trade" |
| bias invalid | 2: "a bias reading observed after the 1m close (or invalid) is ignored"; 5: "bias valid:false ignored", "non-numeric score ignored", "witness with every bias reading invalid: no trade; GRADE_NO_TRADE at 16:08 names waveBias" |
| bias stale / future | 5: "bias observed 5 min before the close (stale) ignored", "bias observed after the close (future) ignored", "a fresh reading (60 s old) is used", "witness with every bias reading stale: no trade ..."; 5: "wave peak unknown: gate fails, no impulse point, no cap" |
| volume missing | 5: "witness with no volume: volume point 0 (null evidence), grade B (3)" |
| ATR missing | 5: "ATR missing: forceLegAtrX null"; 5: "ATR / average range missing: no force point, no lane" |
| 1H range unknown | 5: "1H range unknown: midRange null (gate notMidRange fails)"; 3: "1H range unknown (short) / (mirror, long): no trade, gate notMidRange fails" (engine run with 3 h of history) |
| pools missing | 5: "board missing: no PDH/PDL/session pool appears in any trap, swept list or target"; "board missing: a trap point is only ever backed by a pool the engine actually has"; "no levels: nothing swept" |
| lane input unknown | 5: "accepted lane with closes outside unknown fails" |

## Where each feature is frozen (decision time T = the close of the 1m bar that triggers the entry)
| feature | evidence fields | frozen at | reads only |
|---|---|---|---|
| control4h | control4h, controlKind, controlExt | live at T | the period's control as of T (the trap kind is voided when price takes back the extreme) |
| laneTrigger (failed) | dispBodyPct, dispRangeX, dispAt | the 5m/15m close that armed the setup (the shift) | the shift bar and the 20 closed bars before it |
| laneTrigger (accepted) | acceptClosesOut, retestClosedInside | the acceptance close; the retest's 1m closes <= T | closed 5m / 1m bars |
| waveBias, impulseBand, cap | wavePeakBias, waveFrom, waveTo, waveFrozenAt | T, stored on the setup and reused unchanged by every live re-grade | readings for T_r in [sweepAt, min(T, pullback start + 5m)], each observed in [T_r - 120 s, T_r], T_r <= T |
| firstRetest | retestNo | T | retest counter (per zone and direction per 4H) |
| notMidRange | midRange, range1hKnown, marketState | T | 1H bars closed <= T |
| logicalStop | stopLogical, stops | T | trap extreme, 1H wick so far, retest extreme |
| trap | trapStacked, trapObviousPools, trapSweptLevels | the arm (shift) close | zones and board levels at the arm |
| force | forceLegPts, forceAtr5, forceLegAtrX | the arm close | leg and ATR(14) of closed 5m bars |
| volume | breakVol5m, pullbackBars5m, pullbackVsBreak5m | T | the closed break bar; pullback 5m bars closed <= T plus the forming one built from 1m bars closed <= T, pro-rated |
| timing | sweepAt, sweepMinutesFromOpen | the arm close | the 5m bar of the sweep extreme |

**No future-bar read.** Group 2 rewrites every bar and bias reading after the cut (cuts at 15:45, 16:05, 16:08 and 17:30). Up to the cut it requires 3 things to be identical: the events,
the signals (with their frozen evidence) and the live re-grades. That is 12 checks, plus "observed after the close is ignored" and "STALE_BAR".

## Grade-upgrade add (D5 / playbook §22): dormant by design
Every r3 point is frozen at the decision. Letting points arrive after the decision would leak post-entry information into the entry grade. So `live[].currentGrade` changes only
when a live gate changes (4H control voided, or the 1H state moves the level into mid-range), never upward from new points. `upgradeReady`/`addNow` stay in the API and are
wired, but under r3 they cannot fire. No new points were invented.

## Open items
- The board's Asia H/L during the Asia session is the forming session. It is not counted as a swept level, but it is kept as a target pool.
- Not now: FVG limit, order blocks, voids, 15s speed.
