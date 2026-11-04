# lib/moneyRule.js — money-r4 API (MacMoney)

Pure CommonJS. No requires, no clock, no timers, no state. Import this exact file and do not edit a copy.

Rulings:
- Playbook §5, §11, §16–§18, §20–§22.
- SPEC-TIDE-r2 D′ (sizing), D″ (exits), D‴ (protection), D⁗ (2/3 partial and pyramid), D⁵ (entry by grade and the grade-upgrade add).
- The team sizing position of 11/04, "common risk first" (MacDot, MacMillionz, MacRisk).

MNQ only. **NO daily loss limit of any kind.** `problem()` refuses any config key that names one.

**Grades are never computed here.** The grade comes from the structure engine's GRADE r3 table (SPEC-TIDE-r2 "GRADE r3": gates plus points). Money takes it as a label (`'A+' | 'B' | 'C'`) and sizes and logs it. `gradeOf` is deprecated and always returns `grade: null` (no trade).

## What changed in r4 (API diff notes)
Breaking changes:
- `DEFAULTS.sizing.mode` is `'flat'`: every grade risks `flatDollars` (450, a placeholder until Mac sets it). A config with no `mode` (every r2/r3 config) now sizes flat. Use `mode: 'grade'` for the grade dollars.
- `entryByGrade` defaults to false, so every grade enters all at once. The D⁵ styles need `entryByGrade: true`.
- `upgradeAdd` is off by default (`sizing.upgradeAdd.enabled`), and it only works in mode `'grade'`.
- `gradeOf` always fails closed; `GRADE_PARTS` is gone.
- `upgradeAdd`:
  - every lifecycle field is required: `tp1Done`, `upgradedBefore`, `restingQty`, `restingPx` (when resting), `tp1Px`, `bestPx`;
  - `structuralStop` and `addPx` are required;
  - a resting B half is RESERVED, not cancelled: `cancelRestingQty` was replaced by `reservedRestingQty`, and `ifRestingFills` and `risk.restingUsd` are new.
- `secondLeg` requires `structuralStop`.
- `restingCancel` requires every field; anything unknown cancels.
- `protectStop`, `structuralTrail`, `climaxTighten` and `nextStop` require `lastPx`. They return `placeable` and `action`, and never propose a stop the market has already crossed.
- `VERSION` is `'money-r4'`.

Additive:
- `shadowSize`.
- `sizeFor` gains `mode`, `budgetUsd` and `overBudgetUsd`, plus the codes `NO_FIT_TAKE1` and `SIZING_MODE_INVALID`.
- `entryRow` gains `mode`, `budgetUsd`, `overBudgetUsd`, `sizeCode`, `entryByGrade` and `shadow`. `noFitRow` gains `mode`, `budgetUsd`, `overBudgetUsd` and `shadow`, and its code is `NO_FIT_TAKE1` under take1.
- `PLACE_BUFFER_TICKS` (1) and `ENTRY_VERSIONS` (r2, r3, r4).

Unchanged and the same in both modes: targets, the 2/3 partial, break-even, the pyramid add, the R-ladder lock math, the 15m and climax locks, option C, EXEMPT.

## Config
```js
cfg = {
  sizing: { enabled: false,
    mode: 'flat',                // 'flat' | 'grade'. flat = every grade risks flatDollars; grade = gradeRiskUsd[grade]
    flatDollars: 450,            // placeholder until Mac sets it
    gradeRiskUsd: { A: 900, B: 600, C: 300 },   // used in mode 'grade', and always logged as the shadow in mode 'flat'
    maxContracts: 30,
    noFit: 'skip',               // 'skip' | 'take1' (Mac's ruling pending)
    entryByGrade: false,         // false = every grade all at once; true = the D5 styles
    scaleInB: true,              // only matters with entryByGrade
    upgradeAdd: { enabled: false } },   // dormant by design: GRADE r3 freezes points at the decision
  exits:  { partialFrac: 2/3, trailBufferPts: 2,
            protect: { enabled: true, startR: 1, stepR: 0.5, trailR: 1, structural15m: true, climax: true, climaxVolMult: 2 } },
  pointValue: 2, tickSize: 0.25            // optional; the executor passes its own
}
```

Validation (`problem`; anything unknown refuses to start):
- **Modes:** `mode` is `'flat'` or `'grade'` and `noFit` is `'skip'` or `'take1'`. Any other value is refused, including case variants and null. When absent, they take the default.
- **Dollars and sizes:**
  - `flatDollars` is 50–2000.
  - `gradeRiskUsd` values are each 50–2000 and must step down (A ≥ B ≥ C).
  - `maxContracts` is a whole number 1–150.
- **Switches:** `entryByGrade`, `scaleInB` and `scaleInA` (the r2 key, accepted and ignored) are booleans. `upgradeAdd` is exactly `{ enabled: boolean }`.
- **Exits:** `partialFrac` is 0.1–0.9 and `trailBufferPts` is 0–10. `protect`: startR 0.5–3, stepR 0.25–1, trailR 0.5–3, climaxVolMult 1–5; the switches are booleans.
- **Refused keys:** unknown keys, and any key matching day / daily / loss limit / max loss / full stops.
- **With `sizing.enabled` true:** symbol MNQ, pointValue 2, and minContracts not 3.
- **At runtime (if `problem()` was skipped):**
  - an unknown mode sizes 0 (`SIZING_MODE_INVALID`) and the startup line says `INVALID: no trades`;
  - an unknown `noFit` acts as `'skip'`;
  - `entryByGrade` and `upgradeAdd.enabled` count as on only when exactly `true`.

## Sizing
| function | returns |
|---|---|
| `sizeFor(stopPts, grade, cfg)` | frozen `{version, mode, grade, stopPts, contracts, riskUsd, budgetUsd, gradeRiskUsd (= budgetUsd, old name), perContractUsd, maxFitPts, overBudgetUsd, reason, code}`. contracts = min(maxContracts, floor(budget ÷ (stopPts × $2))). The budget is `flatDollars` in mode flat and `gradeRiskUsd[grade]` in mode grade. **`stopPts` comes back unchanged in every branch: the stop is never moved to fit.** reason/code: grade-fit, grade-max-contracts, grade-no-fit / GRADE_NO_FIT, no-fit-take1 / NO_FIT_TAKE1, invalid-mode / SIZING_MODE_INVALID, invalid-grade or invalid-stop / GRADE_INVALID. |
| `shadowSize(stopPts, grade, cfg)` | `{logOnly: true, used, shadow, line}`: the size used and what the other mode would size at the same stop. `line` is used first, then the shadow, e.g. `flat 450: 3 MNQ \| grade A+ 900: 6 MNQ` (75 pts, mode flat). **Logging only; never placed.** |
| `chooseStop(cands, grade, cfg, {levelName, isTrap} \| {tf})` | Option C, strict. A 4H-type level or a trap uses the 4H wick; an hour-type level uses the 1H wick. **There is no fallback to a tighter wick**, in either noFit mode. Returns the candidate's own fields plus the size, or GRADE_NO_FIT / GRADE_NO_WICK, with `tried[]`. |
| `levelStopTf(name, isTrap)` | `'4H'` (4H Open, PDH, PDL, trap) \| `'1H'` (1H Open, Asia/London H/L) \| null |
| `combine(legs)` | `{contracts, avgEntry}` (exact) |
| `gradeOf()` | **Deprecated.** Always `{grade: null, reason: 'GRADE_NOT_IN_MONEY', deprecated: true}`. |

Examples:
- Flat $450: 75 pts → 3 for every grade.
- Grade A+ $900: 25 pts → 18, 75 → 6, 450 → 1, 451 → GRADE_NO_FIT.
- noFit take1, flat: 226 pts → 1 MNQ, riskUsd 452, overBudgetUsd 2.

## Entry by grade and the grade-upgrade add (D⁵, §22)
| function | returns |
|---|---|
| `scaleInPlan(stopPts, grade, cfg)` | `{mode, total, first, second, scaleIn, style: all-at-once\|scale-in\|one-entry, entryByGrade, …}`. With `entryByGrade: false` (the default), every grade is all at once. With `true`: A+ all at once; B first = ceil(total/2) with the rest resting at the retest/FVG price; C one entry. |
| `secondLeg({dir, stop, structuralStop, firstFill, firstContracts, entry2, plannedSecond, grade?}, cfg)` | Sizes the resting B half: `{contracts, combinedRiskUsd, gradeRiskUsd, reason}`. The combined risk is ≤ the B trade's dollars (`flatDollars` in mode flat), counting the real first fill. 0 with reason: `no-scale-in` (A+/C, scaleInB off, entryByGrade off), `no-structural-stop`, `stop-moved`, `stop-not-behind-entry`, `no-room`, `invalid-input`, `invalid-mode`. |
| `restingCancel({dir, bestPx, tp1Px, tp1Done, invalidated, closed})` | `{cancel, reason: position-closed\|tp1-reached\|invalidated\|keep\|unknown-state}`. **Every field is required.** Any missing, non-boolean or non-finite field cancels (`unknown-state`). |
| `upgradeAdd({...})` | See below. |

### `upgradeAdd`: inputs, all required unless marked
`{grade, newGrade, dir, openQty, entry, stop, structuralStop, addPx, restingQty, restingPx (when restingQty > 0), tp1Done, tp1Px, bestPx, upgradedBefore, oldPoints?, newPoints?, cfg}`

- `newGrade` is the structure engine's live re-grade.
- `entry` is the average entry of the open contracts. `stop` is the one protective stop. `structuralStop` is the stop the trade was sized at.
- `bestPx` is the best 1m high/low since the first fill. TP1 counts as done once its price trades, even with no TP1 order (a 1-lot).

### `upgradeAdd`: output
`{ok, qty, reason, code: GRADE_UPGRADE|GRADE_UPGRADE_SKIP, worstAddPx, reservedRestingQty, risk: {openUsd, restingUsd, addUsd, totalUsd, gradeRiskUsd}, combined (open + add), ifRestingFills (open + add + reserved), row}`

### `upgradeAdd`: rules
- **Only** mode `'grade'` with `upgradeAdd.enabled` true; only a B or C trade re-graded A+; only before TP1; only once per trade.
- qty = floor((A dollars − open risk − reserved resting risk) ÷ the add's risk per contract), capped at maxContracts − open − reserved. The stop never moves to fit.
- `worstAddPx` is the worst add fill that keeps the total ≤ the A dollars at `qty`. Send the add as a limit there; slippage past it is extra.
- **Refusals (all fail closed):**
  - `upgrade-off`, `flat-mode`, `invalid-mode`;
  - `invalid-input` (geometry, or a resting price at/through the stop), `no-structural-stop`, `unknown-state` (any lifecycle field missing or malformed);
  - `not-b-or-c`, `not-a-plus`, `after-tp1`, `already-upgraded`;
  - `stop-moved` (the stop differs from structuralStop, or sits at/past the entry);
  - `stop-not-behind-add`, `no-room`, `max-contracts`.
- `row` is the journal payload: `{code, version, from, to, reason, oldPoints, newPoints, dir, openQty, entry, stop, structuralStop, addPx, qty, worstAddPx, reservedRestingQty, restingPx, openRiskUsd, restingRiskUsd, addRiskUsd, totalRiskUsd, gradeRiskUsd}`.

### Reservation contract (the resting B half)
- **What `restingQty` counts:** the resting order's contracts that are NOT terminal, meaning still working, or with a cancel sent but not yet confirmed.
- **When it changes:** the integrator lowers it only when the broker confirms the cancel, or when fills arrive. Fills are folded into `openQty`/`entry`; a partial fill folds the filled part and leaves the rest reserved.
- **How it is sized:** upgradeAdd assumes every reserved contract fills at `restingPx`. So **open + reserved + add ≤ the A dollars, and ≤ maxContracts, in every outcome**: cancelled, filled, or filled during the cancel.
- **Merge (default):** leave the resting half working as part of the A+ total. `restingCancel` still removes it at TP1, on invalidation or at close.
- **Cancel first (optional):** send the cancel, wait for the confirmed terminal state, then call with `restingQty: 0` for the full top-up. Never size on an unconfirmed cancel.
- **Once:** set `upgradedBefore` true when the add is SENT, and persist it.

Examples (mode grade, entryByGrade on, upgrade on; long, entry 20000, stop 19975, 25 pts):
- B 12 open, add at 20000 → 6 (18, $900).
- B 6 open + 6 resting at 20000 → add 6 (18 contracts / $900 at most, even if the resting half fills).
- The same with resting at 19990 → add 8 ($880 if all of it fills).
- C 6 open → 12 (18, $900).

## Exits (D″ + D⁗), the same in both modes
| function | returns |
|---|---|
| `targetFor(entry, stop, dir, pools, grade, cfg)` | **TP2**: `{price, pts, rr, R, basis: pool\|major-pool\|2R, pool}`. This is the nearest pool ≥ 2R. A+ takes the next MAJOR pool beyond 2R; if there is none, the nearest pool beyond 2R. With no pool beyond 2R it is 2R exactly. The pool price rounds toward the entry and never falls under 2R. |
| `partialFor({entry, stop, dir, tp, pools, contracts}, cfg)` | **TP1**: `{price, pts, basis: pool\|1R, contracts: round(n × 2/3) clamped to 1..n−1, rest}`. A 1-lot has no TP1 order. |
| `beStopAfterPartial(entry, dir, cfg)` | entry ± 1 tick toward profit |
| `planExits({dir, legs\|entry+contracts, stop, pools, partialPools?, grade}, cfg)` | `{contracts, avgEntry, R, tp, partial, beStop, addQty, legs: {leg1, leg2, runner: 0}}` |
| `addQty(original)` | max(1, round(original / 3)). Examples: 3 → 1, 6 → 2, 18 → 6. |
| `addAllowed({dir, runner:{entry, contracts}, originalContracts, addPx, stop, tp2, tp1Done, addsDone, bias:{m15, m30, line}, control4h, rejection, cfg})` | `{ok, qty, reason, code: ADD_OK\|ADD_SKIP, combined:{contracts, avgEntry, atStopUsd, runnerLockedUsd, addRiskUsd}}`. Each skip has its own reason: before-tp1, already-added, tp2-reached, 4h-control-changed, bias-not-ours, no-rejection, stop-not-behind-add, max-contracts, **not-house-money** (the combined position closed at the current stop would be below 0). |

## Profit protection (D‴). Every helper only tightens, and only to a PLACEABLE stop.
`lastPx` is required everywhere. A stop is proposed only when it rests at least `PLACE_BUFFER_TICKS` (1 tick) behind `lastPx`. Otherwise the stop is not moved: `stop` is `currentStop`, `moved` false, `placeable` false. `action` then says what to do:
- `'exit-at-market'`: the ladder lock the trade earned has already traded (`lastPx` at/through it). This is where the stop would have filled. Flatten through the executor's verified flatten path, never a blind opposite order.
- `'hold-current'`:
  - the lock is inside the buffer;
  - or price is at/through the CURRENT stop (the resting stop does its job; never send a second exit);
  - or `lastPx` is missing;
  - or a swing lock is already crossed (swing locks never force an exit).

  Keep the resting stop and re-poll.
- `'place'` means send the replace; `'none'` means there is nothing to do.

| function | returns |
|---|---|
| `protectStop({entry, R, dir, bestPx, currentStop, lastPx, cfg})` | R-ladder: lock = max(0, floor(bestR / 0.5) × 0.5 − 1) R. At +1R that is 0, so the stop goes to BE + 1 tick. +1.5R locks 0.5R, +2R locks 1R, then the lock follows in 0.5R steps. Returns `{stop, moved, placeable, action, reason, lockR, bestR, ladderStop, wantStop}`. |
| `structuralTrail({dir, currentStop, swings15m, majorSwept, lastPx, cfg})` | Only after a MAJOR pool sweep: the stop goes behind the last confirmed 15m swing ± trailBufferPts, when that is tighter and placeable. |
| `isClimax(bars5m, dir, cfg)` | `{climax, volRatio, narrowing, backToMid}`. Volume ≥ 2× the 20-bar median, a narrowing push, and a close ≥ 30% of the range back from the extreme. |
| `climaxTighten({dir, currentStop, climax, swings5m, lastPx, cfg})` | On a climax, the stop goes behind the last 5m swing, when that is tighter and placeable. |
| `nextStop({...the union of the above})` | `{stop, moved, placeable, action, by, ladder, structural, climax}`: the tightest placeable stop. A crossed ladder lock gives `action: 'exit-at-market'`. |
| `stopOnlyInFavour(prev, want, dir)` | prev, or want when want is tighter |

The ladder's "touched +1R closes ≥ BE + 1 tick; touched +2R closes ≥ +1R" is **GROSS, mark-at-stop math only**. It holds when the stop rests in time and fills at its price. Gaps, slippage, fees, and an exit at market after a crossed lock can close worse.

Minor 1m/5m swings never move the stop (D‴).

## Journal and wiring helpers
- `entryRow({stopPts, grade, contracts, scaleIn?, exits?}, cfg)`: put it on every graded entry as `signalContext.money`.
  - It carries `version: 'money-r4'`, `mode`, `budgetUsd`, `riskUsd`, `overBudgetUsd`, `sizeCode`, `entryByGrade`, `exempt`.
  - It also carries **`shadow`** (from `shadowSize`, e.g. `shadow.line = 'flat 450: 3 MNQ | grade A+ 900: 6 MNQ'`) for the paired comparison.
- `noFitRow({stopPts, grade, stopTf, stop, entry}, cfg)` gives the GRADE_NO_FIT payload, or NO_FIT_TAKE1 under take1, with `overBudgetUsd` and `shadow`. The code name GRADE_NO_FIT is kept in both modes.
- `EXEMPT = {noProgressExit, stopCapFromFill, sessionStopFloor}`.
- `isMoneyEntry(signalContext)` is true when `signalContext.money.version` is in `ENTRY_VERSIONS` (`money-r2`, `money-r3`, `money-r4`).
- `upgradeAdd(...).row` gives the GRADE_UPGRADE / GRADE_UPGRADE_SKIP payload.
- `problem(cfg, ctx?)` returns null or the reason. `startupLine(cfg)` returns `'[sizing] off'` or the full rule line, which includes the mode used and the shadow mode, e.g. `[sizing] mode flat: $450 per trade, every grade (grades logged, not sized; shadow grade A+ $900 / B $600 / C $300, logged only) …`.

Tests: `nice -n 19 node tests/money.test.cjs` runs 42 groups.
