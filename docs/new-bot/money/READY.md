# money-r4 READY (MacMoney)

r4 fixes MacDot's 6 review findings on money-r3. It also adds the team sizing position, "common risk first" (MacDot, MacMillionz, MacRisk). The dollar amount is Mac's decision.

## Breaking changes from r3
1. **Sizing defaults to `mode: 'flat'`.** Every grade risks `sizing.flatDollars`, which is 450, a placeholder until Mac sets it.
   - A config with no `mode` (every r2/r3 config) now sizes flat: A+ at 25 pts is 9, not 18.
   - `mode: 'grade'` keeps the 900/600/300 grade dollars.
   - An unknown `mode` or `noFit` refuses to start. At runtime an unknown mode sizes 0.
2. **`entryByGrade` defaults to false:** every grade enters all at once. The D⁵ styles (B half + half) need `entryByGrade: true`.
3. **`upgradeAdd` defaults to off** (`sizing.upgradeAdd.enabled`) and works in mode `'grade'` only. It is dormant by design: GRADE r3 freezes points at the decision.
4. **`gradeOf` always fails closed** (`grade: null`, `GRADE_NOT_IN_MONEY`), and the `GRADE_PARTS` export is gone. Money never grades; GRADE r3 is the structure engine's table. (Finding 1)
5. **`upgradeAdd` fails closed on unknown input.** (Findings 2, 3, 4)
   - Required lifecycle fields: `tp1Done`, `upgradedBefore`, `restingQty`, `restingPx` (when resting), `tp1Px`, `bestPx`. Any of them missing or malformed refuses with `unknown-state`.
   - Also required: `structuralStop` (`no-structural-stop`) and `addPx`.
   - A resting B half is now **RESERVED until terminal**, not cancelled: `cancelRestingQty` was replaced by `reservedRestingQty`, and `risk.restingUsd` and `ifRestingFills` are new.
   - The old race (24 contracts / $1,200 against a $900 intent) is now at most 18 contracts / $900.
6. **`secondLeg` requires `structuralStop`** (refusals `no-structural-stop`, `stop-moved`). **`restingCancel` requires every field** and cancels on anything unknown. (Findings 2, 3)
7. **Protection requires `lastPx`.** `protectStop`, `structuralTrail`, `climaxTighten` and `nextStop` never propose a stop the market has already crossed; a stop must rest ≥ 1 tick behind. They return `placeable` and `action`. (Finding 5) The rule for `action`:
   - `exit-at-market`: the earned ladder lock has already traded.
   - `hold-current`: the lock is too close to place, or price is at the current stop (the resting stop works), or `lastPx` is missing.
   - `place`, or `none`.
8. **Version:** `VERSION` is `'money-r4'`. `isMoneyEntry` accepts r2, r3 and r4.

Additive:
- `shadowSize`, and the `shadow` field on `entryRow` / `noFitRow`. These are logging only, for the paired comparison, e.g. `flat 450: 3 MNQ | grade A+ 900: 6 MNQ`.
- `noFit: 'skip' | 'take1'` (default skip; Mac's ruling pending). take1 gives 1 MNQ with code `NO_FIT_TAKE1` and `overBudgetUsd`.
- `sizeFor` gains `mode`, `budgetUsd` and `overBudgetUsd`.
- `PLACE_BUFFER_TICKS`.

Unchanged and identical in both modes: targets, the 2/3 partial, break-even, the pyramid add, the R-ladder lock math, the 15m and climax locks, option C (never a tighter wick), EXEMPT. **NO daily loss limit** (refused in config, absent in code: tested).

Docs (Finding 6): the r2 grade thresholds are gone from the lib, API.md and INTEGRATION.md. The ladder guarantee is now worded as GROSS, mark-at-stop math only.

## Package
- lib/moneyRule.js  sha256 e36a44ed0442ca071e8aa394ef2713671504a59a5261a7cb16554112dfadae60 (467 lines)
- tests/money.test.cjs  sha256 99114f566df74e824e9a893751e994c956cda2c94222882ecad5c48dcf2417ad
- `nice -n 19 node tests/money.test.cjs` → moneyRule money-r4: 42 passed, 0 failed (node v22.22.0).
  - All 21 r2 groups and the two r3 entry property groups kept. Input-only edits where the contract changed: `lastPx`, `structuralStop`, version, startup text, gradeOf.
  - The 10 r3 upgrade/resting groups were rewritten for the r4 contract.
  - 9 new r4 groups:
    - the placeable protection property (20k cases), with MacDot's 105/110 witness;
    - the docs check;
    - flat vs grade sizing;
    - unknown modes refuse to start and fail closed at runtime;
    - entryByGrade;
    - the upgrade add off by default;
    - the shadow size;
    - noFit skip/take1, with "the stop is never moved" over every stop;
    - exits, pyramid and ladder identical in both modes.
  - Plus the reservation property (>3k cases, every resting outcome ≤ $900).
- MacDot's `review/witness-r3money.cjs` against this lib:
  - **R18–R24, the 6 findings, all pass.**
  - With r4 defaults it scores 17/24. The failures are cases that assume the old grade/D⁵ defaults.
  - With grade mode, entryByGrade and upgrade switched on (in a scratch copy; their file is untouched) it scores 23/24.
  - The one remaining failure is R17, an r2 ambiguity outside this brief: `addQty(1)` = 1, while round(1/3) = 0.

## Design calls for the reviewer
- **Crossed ladder lock → `exit-at-market`.** This emulates the stop that would have filled. It goes through the executor's verified flatten path, never a blind opposite order. A crossed swing lock only holds.
- **`stop-moved`:** the upgrade window ends once protection has moved the stop.
- **Upgrade reservation:** the default is merge (the resting half keeps working). Cancel-first is allowed only with a confirmed terminal state.
- **Defaults in an old config:** absent `mode` / `noFit` take the safe defaults (flat / skip); only explicit unknown values are refused.

## Rulings and status
- Rulings: playbook §5 §11 §16–§22; SPEC-TIDE-r2 D′ D″ D‴ D⁗ D⁵, GRADE r3; the team sizing position.
- Docs: API.md (r4 diff notes at the top) and INTEGRATION.md (r4 summary at the top; §4c action handling; §4e/§4f reservation contract).
- Backups: `../money-r3-backup/` (sha feaa94a1…) and `../money-r2-backup/` (sha 98b00a7d…).
- Not yet done: executor/FSM wiring (MacTide), an independent re-review of r4, and the rig smoke run.
