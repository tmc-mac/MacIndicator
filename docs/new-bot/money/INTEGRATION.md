# money-r4 integration (for MacTide, the only editor of live-executor.js and lib/liveStateMachine.js)

**What r4 changes for the wiring.** This covers MacDot's review and the team sizing position, "common risk first". Everything not listed is the same as r3.
- **§1 sizing:**
  - the default is `mode: 'flat'` (every grade risks `flatDollars`, 450 for now, which is Mac's to set);
  - the grade is logged, and `entryRow().shadow` logs the grade-mode size for the paired comparison. It is never placed;
  - `noFit: 'take1'` (Mac's ruling pending) takes 1 MNQ and journals NO_FIT_TAKE1 with `overBudgetUsd` (§2).
- **Entry:** `entryByGrade` defaults to false, so every grade is ONE order of the full size. §4e and §4f apply only with `entryByGrade: true` / `upgradeAdd.enabled: true` (both off).
- **Grades:** money never grades. The grade and every re-grade come from the structure engine's GRADE r3 table. `gradeOf` returns no trade.
- **§4c:** `nextStop` requires `lastPx` and returns `action`. Follow it exactly (place / hold-current / exit-at-market).
- **§4e:** `secondLeg` needs `structuralStop`; `restingCancel` needs every field and cancels on anything unknown.
- **§4f:** `upgradeAdd` needs every lifecycle field plus `structuralStop`/`addPx`. The resting half is RESERVED until terminal (the reservation contract below) instead of cancel-then-add.
- **Version:** it is `money-r4`. `isMoneyEntry` accepts r2, r3 and r4.

Base: lv1 r13.3.7 bot-np1, which is the same file as tide/build:
- `live-executor.js`: sha256 7245b251eeef2be6…, 6894 lines.
- `lib/liveStateMachine.js` (FSM): sha256 0023eada5d8ef930…

Line numbers are for that base. Each anchor also quotes the text to grep for, because the TIDE edits will shift the numbers.
Copy `lib/moneyRule.js` in unchanged (check READY.md for its sha256).

## Scope
- A **graded entry** is a TIDE signal that carries `grade` ('A+' | 'B' | 'C'), and only when `CONFIG.money.sizing.enabled === true`.
- Every other entry path keeps r13.3.7 sizing and exits. Shipped `sizing.enabled: false` is byte-identical in behaviour.
- Mark each graded entry with `signalContext.money = moneyRule.entryRow(...)`. The guards below test `moneyRule.isMoneyEntry(signalContext)`. It is true when `money.version` is `'money-r4'`, or `'money-r2'` / `'money-r3'` for a trade restored across the upgrade.
- **No daily loss limit.** Do not add one anywhere: not as dollars, not as a trade count, not as a "day full stops" setting.
- The old `set-money.sh` design in SPEC-TIDE-r2 §E included `dayFullStops 2`. Drop it. `problem()` refuses that key.

## 0. Require, config, startup
1. **Require.** Near line 64 (`const { sizeForRisk, maxStopPtsForOneLot, legSplit, …} = require('./lib/riskRules');`), add:
   ```js
   const moneyRule = require('./lib/moneyRule');
   ```
   After line 533 (`function scaleOutOn() {`), add:
   ```js
   function moneyCfg() { return { ...CONFIG.money, pointValue, tickSize }; }
   function gradedOn() { return CONFIG.money?.sizing?.enabled === true; }
   ```
   `pointValue` and `tickSize` are the executor's own values. If they are not in scope at line 533, define `moneyCfg` inside main next to `riskCapOn` (line 3821) instead.
2. **CONFIG default.** After line 1644 (`  scaleOutRunner: { enabled: true, atPts: 20, …`), add:
   ```js
   money: JSON.parse(JSON.stringify(moneyRule.DEFAULTS)),   // money-r4: flat common risk (grade logged + shadow), Candace exits; sizing.enabled false = r13.3.7
   ```
   The config-local override goes per account:
   ```json
   "money": { "sizing": { "enabled": true, "gradeRiskUsd": { "A": 900, "B": 600, "C": 300 } } }
   ```
   That override sizes FLAT (the default mode) and logs the grade dollars as the shadow. Grade sizing needs `"mode": "grade"`.
   - `"flatDollars"` is the common risk.
   - `"noFit": "take1"` takes a 1-lot when even 1 MNQ exceeds the budget.
   - `"entryByGrade": true` turns on the D⁵ styles; `"scaleInB": false` then keeps B to one entry.
   - `"upgradeAdd": { "enabled": true }` turns on the grade-upgrade add (mode grade only).
   - `problem()` refuses any unknown mode or noFit value. An r2 `"scaleInA"` key still loads but is ignored.
   Deep-merge it: `sizing`, `sizing.gradeRiskUsd`, `exits` and `exits.protect` each merge over the defaults. This matters because `problem()` needs the complete object.
3. **Startup check.** After line 2268 (`{ const np = CONFIG.noProgressExit; if (!np …`), add:
   ```js
   { const p = moneyRule.problem(CONFIG.money, { symbol: SYMBOL, pointValue, minContracts: CONFIG.minContracts }); if (p) throw new Error(`money is unusable: ${p}`); }
   ```
   This is the CONFIG-LOCAL ERROR path, so the bot refuses to start.
4. **Startup line.** Next to the `[np1] no-progress exit:` log at line 2288, add:
   ```js
   log(moneyRule.startupLine(moneyCfg()));
   ```

## 1. Sizing: quantityForStop (line 5499, `function quantityForStop(stopPoints, sig) {`)
Put this first in the body:
```js
if (gradedOn() && sig && moneyRule.gradeKey(sig.grade) && (sig.source === 'tide' || sig.moneyGraded === true)) {
  const ms = moneyRule.sizeFor(stopPoints, sig.grade, moneyCfg());
  return Object.freeze({ contracts: ms.contracts, reason: ms.code === 'GRADE_NO_FIT' || ms.code === 'SIZING_MODE_INVALID' ? 'grade-no-fit' : ms.reason, money: ms, stopPoints, confidence: null });
}
```
- `globalMax` (baseContracts 5), `flatSizeContracts` and `minContractsGate` do **not** apply here. The cap is `sizing.maxContracts`.
- Pass the TIDE source label your router uses (`'tide'` or `planInfo.path === 'tide-market'`). Keep it identical across the 3 callers: `riskCapSkip`, `entryQuantityAllowed` (line 5510) and `takeEntry` (line 5789, `const sizing = quantityForStop(`).
- `entryQuantityAllowed` (line 5510) needs `sig.grade` passed through, and its `minContractsOk` must stay true. minContracts 3 is refused at startup, so it is.
- **Stop choice:** call `moneyRule.chooseStop(cands, grade, moneyCfg(), { levelName, isTrap })` in the TIDE signal builder.
  - This is option C, strict: 4H-type levels and traps use the 4H wick; hour-type levels use the 1H wick.
  - Remove tideEntry's "4H wick → 1H wick when it does not fit" fallback (tideEntry.js lines 16 and 224–235). Under grade dollars the stop is never swapped for a tighter one to fit.
- **Flat or grade:** `ms.mode` says which budget sized it (`ms.budgetUsd`). The grade still travels with the signal and the journal.
  - `ms.code === 'NO_FIT_TAKE1'` means 1 contract with `ms.overBudgetUsd` > 0. Journal it (§2) and take the trade at the SAME stop.
  - `SIZING_MODE_INVALID` sizes 0; `problem()` refuses it at startup anyway.
- **Entry by grade (D⁵, only with `entryByGrade: true`):** `const si = moneyRule.scaleInPlan(stopPts, sig.grade, moneyCfg())`. The trigger order is `si.first` contracts. With `entryByGrade` false (the default), `si.first === si.total` for every grade: one order.
  - **A+:** `si.first === si.total` (all at once).
  - **C:** one entry.
  - **B:** `si.first = ceil(total / 2)`. `si.second` rests at TIDE's retest/FVG price as a limit with the same stop; see §4e.
  - Put `si` on `signalContext.scaleIn` so `entryRow` journals it.
  - `quantityForStop` still returns `ms.contracts` (the full grade size). The first order uses `si.first` when `si.scaleIn`.

## 2. GRADE_NO_FIT journaling: riskCapSkip (line 3830, `function riskCapSkip(mac, lv, sig, stopPts, info = {}) {`)
Add this ahead of the `below-min-contracts` branch:
```js
if (sizing.reason === 'grade-no-fit') {
  const row = moneyRule.noFitRow({ stopPts, grade: sig.grade, stopTf: info.stopTf, stop: info.stop, entry: info.entry }, moneyCfg());
  log(`  [sizing] ${sig.dir === 1 ? 'LONG' : 'SHORT'} ${sig.grade} SKIPPED (GRADE_NO_FIT): stop ${row.stopPts} pts, 1 MNQ = $${row.oneLotUsd} > $${row.gradeRiskUsd} (fits up to ${row.maxFitPts} pts).`);
  journalBlock('GRADE_NO_FIT', sig.dir, { source: sig.source, ...row, path: info.path || null });
  try { journalSignalSnapshot(mac || lastMac, lv || lastLv, 'sat_out', { reason: 'GRADE_NO_FIT', dir: sig.dir, source: sig.source, grade: sig.grade }); } catch (e) { /* journal only */ }
  return 'blocked';
}
```
Also add an lv_tide `skip` row with reason GRADE_NO_FIT, in place of MONEY_NO_FIT.
With `noFit: 'take1'`, `sizing.money.code === 'NO_FIT_TAKE1'`. The trade proceeds with 1 contract; journal `NO_FIT_TAKE1` with `moneyRule.noFitRow(...)` (`overBudgetUsd`, `shadow`) and log the actual dollars at risk. The stop is the option C stop, unchanged.

## 3. takeEntry (line 5624): legs, targets, the money row
Replace the leg block at lines 5762–5764 (`let leg1Size = leg1SizeForContracts(contracts);` … `if (signalContext && signalContext.fullExit)`) with this for graded entries:
```js
let moneyPlan = null;
if (gradedOn() && signalContext && moneyRule.gradeKey(grade) && signalContext.tide) {
  moneyPlan = moneyRule.planExits({ dir, entry: entryPrice, contracts, stop: stopPrice, pools: signalContext.tide.pools, partialPools: signalContext.tide.internalPools, grade }, moneyCfg());
  if (!moneyPlan) return;   // a bad geometry fails closed (journal INITIAL_QUANTITY_REFUSED)
  target1 = moneyPlan.partial.contracts > 0 ? moneyPlan.partial.price : moneyPlan.tp.price;
  target2 = moneyPlan.tp.price;
  leg1Size = moneyPlan.legs.leg1 || contracts;   // a 1-lot: leg1 = 1 at TP2
  leg2Size = moneyPlan.legs.leg1 ? moneyPlan.legs.leg2 : 0;
  tightStopPrice = null;   // no smart-hold early exit on graded entries
}
```
- **Pools come from TIDE**, as `[{ price, major, name }]`:
  - major: PDH/PDL, 4H Open, session and opening-range highs and lows, equal highs/lows;
  - minor: 1H Open, internal swings, round numbers.
  - `internalPools` holds the minor swing highs/lows between entry and TP (used for TP1).
- Skip `sessionExit` for graded entries: wrap line 5767 as `if (LIVE && !moneyPlan)`.
- After the second `entryQuantityAllowed` (line 5794), add:
  ```js
  signalContextTl.money = moneyRule.entryRow({ stopPts: Math.abs(entryPrice - stopPrice), grade, contracts, scaleIn: signalContext.scaleIn || null, exits: moneyPlan }, moneyCfg());
  appendJournal({ type: 'money_entry', t: Date.now(), journalId, dir, source, grade, entryType, entryPrice, stopPrice, ...signalContextTl.money });
  ```
- `openEntry` (FSM line 418 / executor line 5837) then receives target1, target2, leg1Size and leg2Size as above, with `signalContext.money`.

## 4. FSM: per-trade behaviour when `moneyRule.isMoneyEntry(this.signalContext)`
Add a getter `get graded() { return moneyRule.isMoneyEntry(this.signalContext); }`. The FSM needs `require('./moneyRule')` next to line 30. Pass `moneyCfg` into the constructor as `moneyCfg: () => moneyCfg()` (executor line 3250).

a. **TP from the fill** (line 1451, `if (this.tp1FromFill && this.runnerTrailRule) {`). For graded trades, do not shift by the planned distance. Re-plan from the real fill and the real filled size:
   ```js
   moneyRule.planExits({ dir, entry: realFillPrice, contracts: filledSize, stop: this.stopPriceIntended, pools, partialPools, grade }, cfg)
   ```
   Then set target1, target2, leg1Size and leg2Size from it.
   - Keep the pools on `signalContext.tide`.
   - A partial entry fill gets the plan for the size that actually filled. TP2 stays ≥ 2R and TP1 ≤ 1R from the actual fill.
b. **After TP1 fills** (line 1576, `if (size === afterLeg1) {`; for a fully-filled 1-lot see line 1360). For graded trades:
   - Never take the `_so1Activate` branch (line 1583) or the cancel-first `cancelIfSet('stopOrderId')` path.
   - Move the ONE remaining stop with `replaceStopSafely('stopOrderId', afterLeg1, lvl, …, 'break-even after TP1')`. Here `lvl = moneyRule.stopOnlyInFavour(this.stopPriceIntended, moneyRule.beStopAfterPartial(this.entryPrice, this.dir, cfg), this.dir)`.
   - Leg 2 keeps its limit at TP2. Set `this.tp1Done = true` and persist it in saveState.
   - A partial TP1 fill (line 1785) keeps the existing resize-to-the-open-size; the ladder (c) then protects the rest.
c. **Protection on every poll** (executor line 6248, next to `maybeProfitLock`). For graded trades, in phases LEG1_OPEN and LEG23_OPEN, before TP1 and after:
   ```js
   const ns = moneyRule.nextStop({
     dir, entry: avgEntry, R: plan.R, bestPx /* best high/low since the fill, or since the add */,
     currentStop: this.stopPriceIntended, lastPx: liveBar.c,
     majorSwept /* TIDE: a major pool in our direction traded through since the fill */,
     swings15m /* confirmed 15m pivots */, climax: moneyRule.isClimax(closed5m, dir, cfg).climax, swings5m,
     cfg,
   });
   if (ns.action === 'place') await this.replaceStopSafely(field, openSize, ns.stop, liveBar.c, this.stopPriceIntended, `protect: ${ns.by}`);
   else if (ns.action === 'exit-at-market') await this.flattenVerified('protect: ladder lock crossed');   // the executor's existing verified flatten (cancel-then-close, reconciled)
   // 'hold-current' / 'none': nothing is sent; the resting stop stays and the next poll re-evaluates
   ```
   - `lastPx` is REQUIRED. Without it, nextStop holds.
   - A stop is proposed only if it rests ≥ 1 tick behind `lastPx`. money-r4 never returns a stop the market has already crossed.
   - `exit-at-market` means the earned ladder lock has already traded, which is where the stop would have filled.
     - Never send a blind opposite market order: the resting stop may be triggering at the same time.
     - When price is at/through the current stop, nextStop returns `hold-current`, so the resting stop does the exit.
   - Journal a `MONEY_PROTECT` manage row with `ns.action`, `ns.ladder.lockR`, `ns.ladder.wantStop` and `ns.by`.
   - `bestPx` must come from 1m highs/lows, not closes.
   - The ladder's "touched +1R closes ≥ BE + 1 tick, touched +2R closes ≥ +1R" is GROSS, mark-at-stop math only. It holds when the stop rests in time and fills at its price. Gaps, slippage, fees and a crossed-lock exit can close worse.
   - Skip `maybeRatchetTrail` (line 6247), `maybeProfitLock`, `updateProfitTrail` and `maybeSmartHoldExit` (line 6235) for graded trades. Minor 1m/5m swings must not move the stop.
d. **Pyramid add** (D⁗: once, after TP1, any grade). When TIDE reports a rejected pullback (a retest of a broken minor swing or a 5m FVG plus a 1m rejection) while `tp1Done`, call:
   ```js
   moneyRule.addAllowed({ dir, runner: { entry: this.entryPrice, contracts: openSize }, originalContracts, addPx,
     stop: this.stopPriceIntended, tp2: this.target2, tp1Done: true, addsDone: this.addsDone || 0,
     bias: { m15, m30, line: CONFIG.controlGateMin }, control4h, rejection: true, cfg })
   ```
   - On `ok`, place the add as a MARKET (or marketable limit) order of `qty`. Do not open a second FSM trade.
   - On its fill:
     1. Run `replaceStopSafely` on the ONE stop to the combined size, at the same stop price.
     2. Replace the TP2 limit with the combined size, at the same TP2 price.
     3. Set `this.entryPrice` to the exact `combined.avgEntry`, keep `R` from the original plan, and reset `bestPx` from the add.
     4. Set `addsDone = 1` and persist.
   - On `!ok`, journal `ADD_SKIP` with `reason` and `combined`.
   - If the add's fill is unknown, use the existing halt path. Never guess the size.
e. **The resting B half** (D⁵: B only, before TP1, only with `entryByGrade: true`). It works like (d), with these differences:
   - Size, once the first half has filled:
     ```js
     moneyRule.secondLeg({ dir, stop: this.stopPriceIntended, structuralStop: this.structuralStop, firstFill, firstContracts, entry2, plannedSecond: si.second, grade: 'B' }, cfg).contracts
     ```
     The combined risk is ≤ the B dollars at the one structural stop, counting the real first fill. Place it as a resting limit at `entry2`; with 0 contracts, place nothing.
   - When it fills:
     1. Run `replaceStopSafely` on the ONE stop to the combined size, at the same price.
     2. Re-plan the exits with `planExits({ legs: [{ price: fill1, contracts: n1 }, { price: fill2, contracts: n2 }], stop, pools, partialPools, grade: 'B' })`.
     3. Replace TP1 and TP2 for the combined size.
   - `structuralStop` (the stop the trade was sized at) is required. Persist it at entry as `this.structuralStop`.
   - On every poll while it rests, call `moneyRule.restingCancel({ dir, bestPx, tp1Px: plan.partial.price, tp1Done: this.tp1Done === true, invalidated: !!tideInvalidated, closed: openSize === 0 })`.
     - Every field must be known. Anything missing cancels (`unknown-state`).
     - On `cancel`, run a verified cancel and journal `RESTING_CANCEL` with the reason.
     - `invalidated` is TIDE's: the setup is invalid, or its retest window has ended.
     - `bestPx` comes from 1m highs/lows.
     - A position that is already flat cancels it too.
   - A grade upgrade (f) RESERVES it (see the reservation contract); it does not need to cancel it.
   - Never leave it resting on a flat account. Bot restart reconciliation must treat an orphan resting entry as a cancel.
   - With `sizing.scaleInB false`, B is one entry of the full size, which is the safe build until (e) is done.
f. **Grade-upgrade add** (D⁵, §22: B or C only, before TP1, once per trade). It is OFF by default (`sizing.upgradeAdd.enabled`) and works in mode `'grade'` only. It is dormant by design: GRADE r3 freezes points at the decision, so a live re-grade is rare.
   - **When:** the structure engine re-grades the open trade with its GRADE r3 table. Money never grades. When the re-grade reaches A+, wait for the next rejected pullback (the same pullback evidence as (d)). Then call:
     ```js
     moneyRule.upgradeAdd({ grade: this.grade, newGrade: 'A+', dir, openQty, entry: this.entryPrice, stop: this.stopPriceIntended,
       structuralStop: this.structuralStop, addPx,
       restingQty: this.restingOpenQty /* NOT terminal: working or cancel unconfirmed; 0 = none */, restingPx: this.restingPx,
       tp1Done: this.tp1Done === true, tp1Px: plan.partial.price, bestPx /* 1m best since the first fill */,
       upgradedBefore: this.upgraded === true, oldPoints, newPoints, cfg })
     ```
     Every lifecycle field must be known (booleans true/false, numbers finite). Otherwise it refuses with `unknown-state`.
   - **Reservation contract.**
     - `restingQty` counts the resting B half's contracts that are not terminal.
     - Lower it only on a broker-confirmed cancel, or when fills arrive. Fold fills into `openQty`/`entry`; a partial fill folds the filled part and leaves the rest reserved.
     - `upgradeAdd` sizes as if all reserved contracts fill at `restingPx`. So open + reserved + add ≤ the A dollars in every outcome, including a fill that lands during a cancel.
     - Default (merge): leave the resting half working; `restingCancel` still removes it at TP1, on invalidation or at close.
     - Optional (cancel first): send the cancel, wait for the confirmed terminal state, then call again with `restingQty: 0` for the full top-up. Never size on an unconfirmed cancel.
   - **On `ok`:**
     1. Set `this.upgraded = true` and persist it BEFORE sending, so a restart cannot add twice.
     2. Place the add: `qty` contracts as a limit at `worstAddPx`. Do not open a second FSM trade.
     3. On its fill, run `replaceStopSafely` on the ONE stop to the combined size, at the same stop price.
     4. Re-plan the exits with `planExits({ legs: [...open legs, { price: addFill, contracts: qty }], stop, pools, partialPools, grade: 'A+' })`. The trade is A+ now, so TP2 is the next major pool. Replace TP1 and TP2 for the combined size.
     5. Set `this.grade = 'A+'`, set `this.entryPrice` to the combined average, and persist both in saveState (`upgraded` is already persisted). If the reserved half fills later, it joins the same way (stop replace, exit re-plan).
     6. The pyramid add (d) later uses the combined size as `originalContracts`.
   - **Journal:** `GRADE_UPGRADE` with `res.row` (old/new points, the risk including `restingRiskUsd`, qty, `reservedRestingQty`).
   - **On `!ok`:** journal `GRADE_UPGRADE_SKIP` with `res.row`, once per reason per trade, to keep the journal quiet.
   - If the add's fill is unknown, use the existing halt path. Never guess the size.
   - After TP1 the pyramid add (d) is the only add; `upgradeAdd` refuses with `after-tp1`.
   - `stop-moved`: a protection move before TP1 (for example the climax lock) ends the upgrade window. Never size the add to a tightened stop.

## 5. Exemptions for graded entries (`EXEMPT`; spec D′ and playbook §5)
- **noProgressExit:** at executor line 6233 (`await stateMachine.noProgressStep(CONFIG.noProgressExit, Date.now())`), pass `{ ...CONFIG.noProgressExit, enabled: false }` when `stateMachine.graded`. As a second guard, FSM `noProgressStep` (line 1051) should return null when `this.graded`.
- **Stop cap from the fill:** in `levelStopCapStep` (line 3755), right after the `sm.source !== 'levels'` line 3761, add `if (moneyRule.isMoneyEntry(sm.signalContext)) return rec || 'n/a';`. Pending old-stop reconciliation (`rec`) still runs.
- **Session stop floors:**
  - Signal side: skip `floorEntryStop` (line 3811) for TIDE signals. Use the structural stop as is.
  - Fill side: in the FSM, `_entryFloorForFill` (line 656) returns null when `this.graded`.
  - A floor would WIDEN the stop beyond what was sized, which breaks the grade dollars.
- **Still apply:** time blocks, news wait, session flatten and no-entry times (`sessionFlattenPt`), flat-only, the protective stop, the ladder audit and reconciliation.

## 6. Tests MacTide should add (executor wiring)
- Mode off is byte-identical to r13.3.7.
- A graded paper or rig entry shows:
  - `[sizing]` startup line;
  - a `money_entry` row with `version money-r4`, `mode flat` and a `shadow.line`;
  - TP1 at 2/3, BE after TP1, and a `MONEY_PROTECT` row at +1R;
  - an `ADD_SKIP not-house-money` row in a forced case;
  - A+ sends one order of the full size; C sends one order; B sends `ceil(n/2)` plus one resting limit, and that limit is cancelled when TP1's price trades;
  - a forced B→A+ re-grade with the half still resting: `RESTING_CANCEL` (or the merge cancel), then one add of `qty`, the stop replaced to the combined size at the same price, and a `GRADE_UPGRADE` row; a second re-grade gives `GRADE_UPGRADE_SKIP already-upgraded`, and a re-grade after TP1 gives `after-tp1`;
  - no `NO_PROGRESS` row and no `STOP_CAP_FROM_FILL` row on graded trades.
- A config-local `"money": { "sizing": { "dayFullStops": 2 } }` refuses to start.
