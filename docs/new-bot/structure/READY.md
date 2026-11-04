# lib/structure.js READY (MacStructure, tide-structure-r3.2)

- file: lib/structure.js (90140 bytes)
- sha256: 2a2249f17efc202c7d88a54ddd7329a5d1bda59b6a3ea287d19eb79a88694853
- tests: `nice -n 19 node tests/structure.test.cjs` -> **181 passed, 0 failed** (groups 1-7; 6 and 7 are new in r3.2).
- reviewer witnesses: `node review/witness-r3engine.cjs tools/offline-shim.cjs <moneyRule-r4.1>` -> **6 passed, 0 failed** (A1 trap hold, B1/B2 no Round exits,
  C1/C2 retest per break, D1 real bounce). That script feeds bare {s15, s30} scalars, so it needs the offline shim; run directly against lib/structure.js
  (strict by default) it gets 0 signals, which is the intended fail-closed behaviour.
- witness 11/04 unchanged: SHORT failed-break at the 4H Open, entry 16:08 PT @ 28,366.75, stop 28,513, **A+ (4)**, TP2 PDL 28,035.25.
  Only TP1 changed: it is now the 1H Open 28,324.5 (0.29R). Before, it was Round 28,350 (0.11R).

## r3.2 changes (rulings 11/04 + MacDot's review of r3.1 at f0c6180)
1. **A trap control holds (spec A).** It stays until price takes back its failed-breakout extreme (CONTROL_VOID) or the 4H closes. An opposite trap is blocked
   (new event CONTROL_HOLD) and stays a candidate. If the old extreme is taken back, the candidate can then FORM (never FLIP). A bias control (below/above) is
   still replaced by an opposite trap at once (ruling). cfg `trapControlHolds` (true).
2. **Round numbers are context only.** cfg `pools.roundAsTarget` (false). Rounds never reach `signal.targets` / `pools` (TP1/TP2); they are listed in the new
   `signal.contextPools` (display). With `roundAsSetup` false they are never setups and never merge into (widen) a real pool's zone.
3. **The first retest is counted per break** (failed or accepted), not per zone per 4H. A cancelled setup's touch or the other lane's touch never uses up
   a later break's first retest; a 2nd touch of the same break counts 2 (RETEST_2_SKIP).
4. **The failed-break bounce must be a real counter-move.** The RETEST bar must make a 1m higher high (short) / lower low (long) than the previous 1m bar,
   after the shift candle. A continuation bar sitting within retestTolPts of the broken swing is journalled BOUNCE_NOT_COUNTER, not a retest.
   cfg `bounceNeedsCounter` (true).
5. **Bias provenance (MacDot 6623647326).** cfg `biasInput` 'strict' (default) | 'offline'.
   - Strict accepts only `{ m15: {score, valid: true, observedAt}, m30: {...} }` with a finite score and T - biasMaxAgeSec <= observedAt <= T.
   - In strict, a bare scalar (s15/s30, or m15 as a number), or s15/s30 next to nested readings, rejects the whole minute (no bias).
   - 'offline' (fixtures and tools only) also takes bare scalars and metadata-free nested readings.
   - `tools/offline-shim.cjs` gives the same API in offline mode for study and review scripts.
6. **Volume completeness (MacDot 6623659839).** normBar keeps `vk` (volume known) apart from an observed 0, and it flows into every 5m / 15m / 1H / 4H aggregate.
   If ANY contributing minute of the pullback bars (closed or forming), or of the break candle, has an unknown volume, the volume comparison is null and the
   point is withheld.
   - MacDot's case (the 11-03 16:06 minute without its volume field): volume point null -> the witness grades **B (3)**, same entry and stop. That is under that test only; the real fixture stays A+ (4).
   - An observed 0 is data, not missing.
7. **No change (rulings):**
   - C.1 accepted-break without a §8.2 shift stays a valid lane.
   - An unknown 1H range keeps failing notMidRange. **Warm-up need:** >= 2 confirmed swing highs AND 2 swing lows on the 1H (2 bars each side), about 1,500 1m bars of history, before any trade can pass the gate.

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
- **bias (live = strict, the default):** `{ m15: {score, valid: true, observedAt}, m30: {...} }`. observedAt (ms or s) must be the as-of time of the reading
  (the 1m close it was computed from, T or earlier). A reading is ignored if it is not `valid === true`, has a non-numeric score or observedAt, is observed after T
  (look-ahead) or before T - biasMaxAgeSec (stale). Any bare scalar in the input rejects the minute. Fixtures and tools that feed `{s15, s30}` set `cfg.biasInput = 'offline'`.
- Exports: VERSION, DEFAULTS, createState, step, cloneState, validateCfg, resolveCfg, gradeOf, gradeTableProblems, evidenceFor, ptLabel, ptMin, bucketStart, _internal.
- **signal fields:** id, setupId, t, at, dir, side, kind ('failed-break' | 'accepted-break'), entryType 'market', entryPrice, chosenStop, riskPts, stops, grade, gradeTotal,
  gradePoints, gradeGates, gradeDetail, gradeUncapped, gradeCapped, tags, evidence, targets / pools, internalPools, addZone, level, zone, control, defended, shift,
  retest, swings, marketState, warnings, reason, contextPools (r3.2: the Round numbers in the trade direction, display only).
  - entryPrice is the RETEST-REJECTION 1m close, never the shift candle.
  - chosenStop is structural and never moved.
  - tags can include 'exhaustion-watch'.
  - evidence holds every field.
  - targets / pools are ordered by distance, and every major pool is kept: PDH, PDL, 4H Open, Asia/London H/L, EQH/EQL, 4H swings. No Round pools (r3.2).
- new events (r3.2): CONTROL_HOLD {dir, ext, blockedDir, blockedExt}; BOUNCE_NOT_COUNTER {setup, high, low, prevHigh, prevLow}.
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
| volume missing | 7: "one pullback minute without volume -> the volume point is withheld (null evidence), not 1", "under that test only: the 11/04 witness grades B (3)"; 7: "an OBSERVED 0 volume is data, not missing"; 5: "witness with no volume: volume point 0 (null evidence), grade B (3)" (all-zero volume: the break candle has no usable volume) |
| bias provenance (strict) | 7: MacDot's 4 cases (nested {score} only; bare s15 next to an invalid / stale / future nested m15) rejected; "even a VALID nested reading next to a bare scalar is ambiguous"; "bare scalars rejected"; "the fixture with nested {score}-only readings: 0 signals in strict", "in offline: signals unchanged"; "bare-scalar fixture fed in strict mode: 0 signals" |
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
| volume | breakVol5m, pullbackBars5m (each with volKnown), pullbackVolMissing, pullbackVsBreak5m | T | the closed break bar; pullback 5m bars closed <= T plus the forming one built from 1m bars closed <= T, pro-rated; any unknown-volume minute -> null |
| timing | sweepAt, sweepMinutesFromOpen | the arm close | the 5m bar of the sweep extreme |

**No future-bar read.** Group 2 rewrites every bar and bias reading after the cut (cuts at 15:45, 16:05, 16:08 and 17:30). Up to the cut it requires 3 things to be identical: the events,
the signals (with their frozen evidence) and the live re-grades. That is 12 checks, plus "observed after the close is ignored" and "STALE_BAR".

## Grade-upgrade add (D5 / playbook §22): dormant by design
Every r3 point is frozen at the decision. Letting points arrive after the decision would leak post-entry information into the entry grade. So `live[].currentGrade` changes only
when a live gate changes (4H control voided, or the 1H state moves the level into mid-range), never upward from new points. `upgradeReady`/`addNow` stay in the API and are
wired, but under r3 they cannot fire. No new points were invented.

## Open items
- **TP1 is still often tiny.** TP1 < 0.5R on 10 of 24 ledger signals, min 0.01R: an opening-range pool right next to the entry becomes TP1.
  Not a ruling yet; see ledger/DIFF-r3.1.md.
- **Some old scripts need offline mode.** Review and study scripts that feed bare `{s15, s30}` must pass `{ biasInput: 'offline' }` or use tools/offline-shim.cjs.
- **Asia H/L during the Asia session.** The board's value is the forming session, so it is not counted as a swept level; it is kept as context.
- **Integration notes for lib/tideWire.js (r2.3, read-only check; not changed here):**
  - It passes `v: isNum(b.v) ? b.v : 0`, so a missing volume reaches the engine as an observed 0 and the r3.2 volKnown rule cannot see it. Pass the raw `v` (undefined when unknown).
  - It never sends `trades` (closed / tp1Done) or `stoppedOut` to step(). The engine then keeps its own virtual trade open until the structural stop
    or `openMaxMin` (480 min), and one-idea-per-direction blocks same-direction setups meanwhile. Ledger example: the 11-03 13:33 long, which the
    executor would skip (SESSION_CLOSE), blocked longs from 15:10 to 16:10 in the next session.
  - `biasAt()` must return the strict shape `{ m15: {score, valid: true, observedAt}, m30: {...} }`, or every minute has no bias.
  - The engine has no session clock: it does emit signals from 12:55 to 15:00 PT (2 in the ledger). The executor's session close blocks them live.
- **Not now:** FVG limit, order blocks, voids, 15s speed.
