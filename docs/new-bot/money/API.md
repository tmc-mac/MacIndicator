# lib/moneyRule.js — money-r3 API (MacMoney)

Pure CommonJS. No requires, no clock, no timers, no state. Import this exact file and do not edit a copy.
Rulings: playbook §5, §11, §16, §17, §18, §20, §21, §22 and SPEC-TIDE-r2 D′ (sizing), D″ (exits), D‴ (protection), D⁗ (2/3 partial and pyramid), D⁵ (entry by grade and the grade-upgrade add; it supersedes D′'s "scale-in on A+ only").
MNQ only. **NO daily loss limit of any kind.** `problem()` refuses any config key that names one.

## Config
```js
cfg = {
  sizing: { enabled: false, gradeRiskUsd: { A: 900, B: 600, C: 300 }, maxContracts: 30, scaleInB: true },  // 150K values; per account
  exits:  { partialFrac: 2/3, trailBufferPts: 2,
            protect: { enabled: true, startR: 1, stepR: 0.5, trailR: 1, structural15m: true, climax: true, climaxVolMult: 2 } },
  pointValue: 2, tickSize: 0.25            // optional; the executor passes its own
}
```
Validation (`problem`):
- `gradeRiskUsd` values are each 50–2000 and must step down (A ≥ B ≥ C).
- `maxContracts` is a whole number 1–150. `partialFrac` is 0.1–0.9. `trailBufferPts` is 0–10.
- `scaleInB` (default true) and `scaleInA` are optional booleans. `scaleInA` is the r2 key: it is still accepted so an r2 config loads, but it does nothing (A+ is always all at once), and the startup line says so.
- `protect`: startR 0.5–3, stepR 0.25–1, trailR 0.5–3, climaxVolMult 1–5; `enabled`, `structural15m` and `climax` are booleans.
- Unknown keys are refused, and so is any key matching day / daily / loss limit / max loss / full stops.
- When `sizing.enabled` is true, it also needs the ctx check to pass: symbol MNQ, pointValue 2, and minContracts not 3.

## Sizing (D′)
| function | returns |
|---|---|
| `gradeOf({control4h, trapAtPool, displacementShift, firstRetest, validTrigger})` | `{grade 'A+'\|'B'\|'C'\|null, missing[], reason}` (0/1/2 missing; more = GRADE_NONE). Use it when TIDE does not already grade with §19 points. |
| `sizeFor(stopPts, grade, cfg)` | frozen `{version, grade, stopPts, contracts, riskUsd, gradeRiskUsd, perContractUsd, maxFitPts, reason: grade-fit\|grade-max-contracts\|grade-no-fit\|invalid-stop\|invalid-grade, code: GRADE_NO_FIT\|GRADE_INVALID\|null}` |
| `chooseStop(cands, grade, cfg, {levelName, isTrap} \| {tf})` | Option C, strict. A 4H-type level or a trap uses the 4H wick; an hour-type level uses the 1H wick. **There is no fallback to a tighter wick.** Returns the candidate's own fields plus the size, or GRADE_NO_FIT / GRADE_NO_WICK, with `tried[]`. |
| `levelStopTf(name, isTrap)` | `'4H'` (4H Open, PDH, PDL, trap) \| `'1H'` (1H Open, Asia/London H/L) \| null |
| `combine(legs)` | `{contracts, avgEntry}` (exact) |

Examples at A+ $900: 25 pts → 18, 60 → 7, 120 → 3, 450 → 1, 451 → GRADE_NO_FIT. 10 pts → 30 (the cap).

## Entry by grade and the grade-upgrade add (D⁵, playbook §22). New in r3.
| function | returns |
|---|---|
| `scaleInPlan(stopPts, grade, cfg)` | `{total, first, second, scaleIn, style: all-at-once\|scale-in\|one-entry, gradeRiskUsd, reason, code}`. **A+: all at once** (first = total). **B: scale in**: first = ceil(total/2), second = the rest, resting at the retest/FVG price. **C: one entry.** A 1-lot B, or `scaleInB: false`, is one entry. |
| `secondLeg({dir, stop, firstFill, firstContracts, entry2, plannedSecond, grade?}, cfg)` | The resting B half. `{contracts, grade: 'B', combinedRiskUsd, gradeRiskUsd, reason: as-planned\|sized-down\|no-room\|no-scale-in\|stop-not-behind-entry\|invalid-input}`. Same stop price; at most the planned rest; **the combined risk is ≤ the B dollars**, counting the real first fill. `grade` defaults to 'B'. A+ or C gives 0 (`no-scale-in`). |
| `restingCancel({dir, bestPx, tp1Px, tp1Done, invalidated, closed})` | `{cancel, reason: tp1-reached\|invalidated\|position-closed\|keep\|invalid-input}`. Cancel the resting B half when TP1's price trades (filled or not; a 1-lot has no TP1 order), when TIDE invalidates the setup or its retest window ends, or when the position is flat. Bad input fails closed (cancel). |
| `upgradeAdd({grade, newGrade, openQty, entry, stop, dir, restingQty, tp1Done, upgradedBefore, addPx?, structuralStop?, oldPoints?, newPoints?, cfg})` | `{ok, qty, reason, code: GRADE_UPGRADE\|GRADE_UPGRADE_SKIP, cancelRestingQty, worstAddPx, risk: {openUsd, addUsd, totalUsd, gradeRiskUsd}, combined: {contracts, avgEntry}, row}` (frozen). See below. |

`upgradeAdd` rules:
- **Only B or C, re-graded A+, before TP1, once per trade.** `entry` is the average entry of the open contracts and `stop` is the one protective stop. `addPx` is the rejected-pullback price; it defaults to `entry`.
- **qty** = floor((A dollars − the open risk at the stop) ÷ (the add's risk per contract)), capped at `maxContracts − openQty`. The total risk is ≤ the A+ dollars at the SAME stop. The stop never moves to fit.
- **A resting B half** (`restingQty`) is cancelled first and merged in. `cancelRestingQty` says how many to cancel; their risk is not counted because they never fill. A refusal leaves it resting (`cancelRestingQty` 0).
- **worstAddPx** is the worst add fill that still keeps the total ≤ the A dollars at `qty`. Use it as the add's limit price; slippage past it is extra.
- **Skip reasons:**
  - `not-b-or-c`, `not-a-plus`;
  - `after-tp1` (after TP1 the D⁗ pyramid is the only add);
  - `already-upgraded`;
  - `stop-moved`: the stop is not the structural one, because it differs from `structuralStop` or sits at/past the entry. Sizing to a tightened stop would buy more contracts than the grade dollars allow at the structure;
  - `stop-not-behind-add`, `no-room` (the open risk already uses the A dollars), `max-contracts`, `invalid-input`.
- **row** is the journal payload: `{code, version, from, to, reason, oldPoints, newPoints, dir, openQty, entry, stop, addPx, qty, worstAddPx, cancelRestingQty, restingQty, openRiskUsd, addRiskUsd, totalRiskUsd, gradeRiskUsd}`.

Examples at B $600 / A+ $900, long, entry 20000, stop 19975 (25 pts):
- B 12 open, add at 20000 → 6 (18 total, $900). Add at 20010 → 4 ($880; worstAddPx 20012.5). Add at 19990 → 10 (22 total, $900).
- B 6 open + 6 resting → cancel the 6, add 12 at 20000 (18 total, $900).
- C 6 open → 12 (18 total, $900).

## Exits (D″ + D⁗)
| function | returns |
|---|---|
| `targetFor(entry, stop, dir, pools, grade, cfg)` | **TP2**: `{price, pts, rr, R, basis: pool\|major-pool\|2R, pool}`. This is the nearest pool ≥ 2R. A+ takes the next MAJOR pool beyond 2R; if there is none, the nearest pool beyond 2R. With no pool beyond 2R it is 2R exactly. The pool price rounds toward the entry and never falls under 2R. |
| `partialFor({entry, stop, dir, tp, pools, contracts}, cfg)` | **TP1**: `{price, pts, basis: pool\|1R, contracts: round(n × 2/3) clamped to 1..n−1, rest}`. A 1-lot has no TP1 order. |
| `beStopAfterPartial(entry, dir, cfg)` | entry ± 1 tick toward profit |
| `planExits({dir, legs\|entry+contracts, stop, pools, partialPools?, grade}, cfg)` | `{contracts, avgEntry, R, tp, partial, beStop, addQty, legs: {leg1, leg2, runner: 0}}` |
| `addQty(original)` | max(1, round(original / 3)). Examples: 3 → 1, 6 → 2, 18 → 6. |
| `addAllowed({dir, runner:{entry, contracts}, originalContracts, addPx, stop, tp2, tp1Done, addsDone, bias:{m15, m30, line}, control4h, rejection, cfg})` | `{ok, qty, reason, code: ADD_OK\|ADD_SKIP, combined:{contracts, avgEntry, atStopUsd, runnerLockedUsd, addRiskUsd}}`. Each skip has its own reason: before-tp1, already-added, tp2-reached, 4h-control-changed, bias-not-ours, no-rejection, stop-not-behind-add, max-contracts, **not-house-money** (the combined position closed at the current stop would be below 0). |

## Profit protection (D‴). Every helper only tightens.
| function | returns |
|---|---|
| `protectStop({entry, R, dir, bestPx, currentStop, cfg})` | R-ladder: lock = max(0, floor(bestR / 0.5) × 0.5 − 1) R. At +1R that is 0, so the stop goes to BE + 1 tick. +1.5R locks 0.5R, +2R locks 1R, then the lock follows in 0.5R steps. Returns `{stop, moved, reason, lockR, bestR, ladderStop}`. |
| `structuralTrail({dir, currentStop, swings15m, majorSwept, lastPx, cfg})` | Only after a MAJOR pool sweep: the stop goes behind the last confirmed 15m swing ± trailBufferPts, when that is tighter |
| `isClimax(bars5m, dir, cfg)` | `{climax, volRatio, narrowing, backToMid}`. Volume ≥ 2× the 20-bar median, a narrowing push, and a close ≥ 30% of the range back from the extreme. |
| `climaxTighten({dir, currentStop, climax, swings5m, lastPx, cfg})` | On a climax, the stop goes behind the last 5m swing |
| `nextStop({...the union of the above})` | `{stop, moved, by, ladder, structural, climax}`: the tightest of all of them |
| `stopOnlyInFavour(prev, want, dir)` | prev, or want when want is tighter |

Minor 1m/5m swings never move the stop (D‴). The D″ minor-swing `trailStop` was removed, and so were the W, runner-at-W and lockedUsd helpers.

## Journal and wiring helpers
- `entryRow({stopPts, grade, contracts, scaleIn?, exits?}, cfg)`: put it on every graded entry as `signalContext.money`. It carries `version: 'money-r3'` and `exempt`.
- `noFitRow({stopPts, grade, stopTf, stop, entry}, cfg)` gives the GRADE_NO_FIT journal payload.
- `EXEMPT = {noProgressExit, stopCapFromFill, sessionStopFloor}`. `isMoneyEntry(signalContext)` is true when `signalContext.money.version` is in `ENTRY_VERSIONS` (`'money-r2'`, `'money-r3'`), so an r2 trade restored across the upgrade keeps its graded behaviour.
- `upgradeAdd(...).row` gives the GRADE_UPGRADE / GRADE_UPGRADE_SKIP journal payload.
- `problem(cfg, ctx?)` returns null or the reason. `startupLine(cfg)` returns `'[sizing] off'` or the full rule line.

Tests: `nice -n 19 node tests/money.test.cjs`. There are 33 groups: the 21 r2 groups (three updated where D⁵ changed the rule) and 12 new D⁵ groups. They include the 11/04 witness path, a 400-path property test of the ladder, a B ≤ $600 sweep and an upgrade ≤ $900 sweep.
