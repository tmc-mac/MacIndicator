# money-r3 READY (MacMoney)

## Breaking changes from r2 (D⁵ / playbook §22 supersede D′ "scale-in on A+ only")
1. **`VERSION` is `'money-r3'`.** `entryRow().version` is now `'money-r3'`.
   - `isMoneyEntry` accepts both `'money-r2'` and `'money-r3'` (`ENTRY_VERSIONS`), so readers keep working.
   - Any literal `=== 'money-r2'` compare must change.
2. **`scaleInPlan` changed which grade splits.**
   - A+ is ALL AT ONCE: `first = total`, `second = 0`.
   - B now splits: `first = ceil(total/2)`, the rest resting at the retest/FVG price.
   - C is one entry.
   - New field: `style`.
3. **`secondLeg` caps the combined risk at the B dollars** (it was the A dollars).
   - `grade` defaults to `'B'`.
   - A+ / C (or `scaleInB: false`) return 0, reason `no-scale-in`.
4. **Config: `DEFAULTS.sizing.scaleInA` is gone; `scaleInB: true` is new.**
   - `scaleInA` is still accepted (it must be boolean) and ignored. `problem()` no longer requires it.
   - The startup line notes when it is ignored.
5. **The `startupLine` text changed:** the entry clause, plus the grade-upgrade add.

Additive, non-breaking:
- `upgradeAdd` (with GRADE_UPGRADE / GRADE_UPGRADE_SKIP `row`), `restingCancel`, `ENTRY_VERSIONS`.
- Everything else is byte-for-byte r2 behaviour: sizeFor, chooseStop/option C, targets, the 2/3 partial, the R-ladder, the 15m and climax locks, the pyramid add, EXEMPT, noFitRow.
- **NO daily loss limit** (refused in config, absent in code: tested).

## Package
- lib/moneyRule.js  sha256 feaa94a17aa4456cce187c4873a34283cc4f3aeb6ebf4fac992f9462772926b9 (370 lines)
- tests/money.test.cjs  sha256 b2da46d0d0be728bc1a67eba895132a89c150a8a8d363597fe6df0130532b8e3
- `nice -n 19 node tests/money.test.cjs` → moneyRule money-r3: 33 passed, 0 failed (node v22.22.0).
  - The 21 r2 groups plus 12 new D⁵ groups.
  - 3 r2 groups were updated, only where D⁵ changed the rule: A+ split → entry by grade, the startup text, and the version.
  - The unmodified r2 test file against this lib: 18/21. The 3 failures are exactly those superseded groups.
- New tests:
  - B→A+ upgrade sizing, with and without a resting half (cancel + merge, the fill race);
  - C→A+ and the short mirror, with an upgrade ≤ $900 property sweep (and `worstAddPx`);
  - refused after TP1, refused twice;
  - other refusals (stop-moved, no-room, max-contracts);
  - the GRADE_UPGRADE row;
  - A+ and C never scale in (every stop, 4 configs);
  - B combined ≤ $600 (plan + secondLeg sweep, >5k cases, slipped fills, both directions);
  - restingCancel;
  - a D⁵ path (B half → A+ re-grade → merged → A+ re-plan);
  - r2-config compatibility.
- Design call to review: `upgradeAdd` refuses with `stop-moved` when protection already tightened the stop (pass `structuralStop`). Sizing to a tightened stop would inflate the add.
- Rulings: playbook §5 §11 §16–§22; SPEC-TIDE-r2 D′ D″ D‴ D⁗ D⁵.
- Docs: API.md, INTEGRATION.md (new §4e resting B half, §4f grade-upgrade add; anchors still on r13.3.7 live-executor 7245b251eeef2be6 / liveStateMachine 0023eada5d8ef930).
- The r2 package is kept at `../money-r2-backup/` (sha 98b00a7d…).
- Not yet done: executor/FSM wiring (MacTide), independent reviewer desk, rig smoke.
