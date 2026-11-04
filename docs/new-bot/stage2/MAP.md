# tideOrders r1.2: intent → executor primitive map (Stage 2a groundwork, MacMoney)

`lib/tideOrders.js` is a pure planner. It makes no broker calls and imports nothing from live-executor.js; it requires only `./moneyRule` (money-r4.1, a byte-identical copy). It ships OFF, and nothing calls it until Mac switches Stage 2 on. At startup the executor must refuse Stage 2 when `tideOrders.configProblem(moneyCfg)` returns text.

The executor turns each intent into one of its **existing** primitives below and reports the outcome back as an event. The broker layer has exactly these calls:
- `lib/liveOrders.js` (sha256 96746b6874aa3c80): `placeOrder` (LIMIT / MARKET / STOP), `cancelOrder`, `getOpenPosition`, `getOpenOrders`, `getEntryOrder`.
- There is no modify and no linked bracket.

Line numbers are for tide/v2/build `lib/liveStateMachine.js` (the FSM). The right-hand column names the matching method of MacTide's Stage-2 draft `stage2/lib/tideFsm.js`.

## MacArthur's rulings (r1.1, r1.2) and the executor switches they need (MacTide)
| # | ruling | required executor switch |
|---|---|---|
| 1 | **Owner.** For a TIDE position the planner alone emits every post-fill order (stop, TP1, TP2, add, flatten). The FSM records state and executes intents. | On the `guard` intent (sent BEFORE the entry, again at every restart reconcile), set a per-position flag, e.g. `stateMachine.tideOwned = <position id>`, persisted in saveState. With it set, the FSM's own post-fill bracket path (tick() after the entry fill: `placeProtectiveStop` / `placeTargetLimit`, BE / trail / profit lock) is REFUSED for that position. Witness: a TIDE fill gives exactly ONE stop. |
| 2 | **No resting B half in Stage 2a.** | `tideOrders.configProblem` refuses `sizing.entryByGrade: true` until the FSM has a second entry slot (Stage 2c). It also refuses `sizing.upgradeAdd.enabled: true`, because this planner has no grade-upgrade add: my addition, failing closed. |
| 3 | **No widening, ever.** A rejected stop → if its level is already crossed, the flatten lifecycle; otherwise ONE retry at the same price. A second reject while an older stop still protects → alert + block new entries, the old stop kept (a later crossing of the failed level → the flatten). **r1.2:** a second reject with NO stop working → the flatten lifecycle at once + alert (`no-stop`); never a third try, never wider. | Every stop intent carries `noWiden: true`. `placeProtectiveStop(size, price, { noWiden: true })` must skip its widen-and-retry loop (20/50/100/200 ticks) and throw the original reject, which becomes the `reject` event (with `lastPx`). The same applies to `replaceStopSafely`'s placement. |
| 4 | **The broker-acked level is the level.** The `replaceStopSafely` fallback may only place a stop equal to or tighter than the current protective stop; a wider one → keep the old stop + alert. | Every stop `ack` carries `price` = the level the broker accepted. The "best VALID level" fallback may only choose `better(cand)` levels; it already breaks on `!better(cand)`, so keep that. The planner adopts an acked level between the current and the asked one. An acked level LOOSER than the protective stop (or the structural stop) is alerted (`stop-looser`), blocks, and is tightened back at once. A stop `ack` with no price → `stop-price-unknown`: block, and no change until a reconcile reads the level. |
| 5 | **The add's stop timing.** `addAllowed` (Mac's D⁗ house money at the ACKED stop) first. Then the stop is TIGHTENED to the combined break-even + 1 tick at the add's limit price, when that is tighter, and the add is sent only after that raise is ACKED. The quantity is resized on the add's fill. An add that never fills leaves the tighter stop. | None beyond the rows below (a stop `modify`, then a `place add`). |
| 6 | **The flatten uses sessionFlatten's reviewed order** (lifecycle below): the stop cancelled (verified) → a market close of the broker-read quantity → a second read. The market close rejected / unacknowledged / ending with contracts left → the protective stop is re-placed at its last ACKED price at once + alert. The stop cancel not verified → no market order; one retry, then alert. | The `flatten` intent = `getOpenPosition` (re-read) + `placeOrder` MARKET of `min(expectOpen, actual)`. The stop was already cancelled through its own verified `cancel` intent: do NOT cancel anything inside the flatten. `sessionFlatten` (:1146) is the reference for this order, and its put-back is what the planner's re-protect does. A market order not acknowledged within the executor's timeout → `no-ack`. |
| 7 | **r1.2: a TIDE position with no working protective stop is never left open.** After two stop rejects, or when ANY reconcile (a restart included) finds open contracts with no working stop → the flatten lifecycle at once + alert (`no-stop`), with no repair-and-wait. The cancel-verify step is moot with no stop resting: clear the targets → read → market close → confirming read. Inside an exit: if the market close was rejected AND its re-placed stop is rejected twice → exactly ONE more market close (`naked-retry`); if even that cannot proceed → `naked-open` (close it by hand). | None new (the existing rows). |

**Recorded choice for ruling 6 and its residual risk.**
- **The choice:** the stop is cancelled before the market close. MacArthur chose this because a reversal opens an unplanned opposite position (Topstep exposure), and this is the path already reviewed and live.
- **What remains:**
  - the position is unprotected only while the market order itself executes;
  - if that order fails or is unanswered, the stop is re-placed at its last acked price at once and alerted;
  - a manual close between the planner's read and the executor's send can still reverse the position. The planner's confirming read catches that (`position-reversed`: alert, its closing orders cancelled, nothing else sent). A broker reduce-only flag would remove it.

## Intents
Every intent has `key = <position id>:<kind>:<seq>`. The executor stores key → broker orderId, and it must never send the same key twice. `expectOpen` is the open quantity the intent assumed.

| op | kind | executor primitive (existing) | how it runs / what it reports back | tideFsm draft |
|---|---|---|---|---|
| `guard` | `position` | the FSM state flag (ruling 1), set by the executor | Not an order. Sent before the entry and at every restart reconcile: `{ fsmPostFill: 'refuse', owner, position }`. No event comes back. | — |
| `place` | `entry` | `stateMachine.openEntry({ dir, entryType, entryPrice, stopPrice, target1, target2, contracts, leg1Size, leg2Size, signalContext })` (FSM :418) → `placeOrder` | openEntry's admission gates still run: time blocks, alignment, control, quantity. Reports `ack` / `reject` / `no-ack`. Fills come from `getEntryOrder` / `getOpenPosition`: `fill` / `partial-fill` with the cumulative `filledQty` and `avgPx`. Leg 2 (the resting B half) is Stage 2c only (ruling 2). | — |
| `place` | `stop` | `placeProtectiveStop(size, stopPrice, { noWiden: true })` (FSM :511) → `placeOrder` STOP, closing side | The first intent on the first fill (there is no broker bracket), sized to the open quantity. Reports `ack` WITH `price` (ruling 4) / `reject` with `lastPx` (ruling 3). | `_tidePlaceStop` |
| `place` | `tp1` / `tp2` | `placeTargetLimit(size, limitPrice)` (FSM :556) → `placeOrder` LIMIT, closing side | First re-read `getOpenPosition`. If the size is not `expectOpen`, do not send; report `reject`. | `_tidePlaceTarget` |
| `place` | `add` | `placeOrder({ type: LIMIT, side: sideFor(dir, false), size, limitPrice })` | Sent only after the house-money stop raise is acked (ruling 5). Reports `ack` / `fill` / `cancel-ack`. | `tideAdd` |
| `modify` | `stop` | `replaceStopSafely(orderIdField, size, newStop, refPrice, curStop, label)` (FSM :1964), with `noWiden` | The new stop is placed first, and the old one is cancelled (verified) only after it is accepted. Reports `ack` (new key, WITH the acked `price`), then `cancel-ack` (`replaces`). A reject → `reject` with `lastPx`. Its "market exit when through" branch → report the fills. | `_tidePlaceStop` |
| `modify` | `tp1` / `tp2` | `cancelVerified(oldOrderId, label)` (FSM :1866), then `placeTargetLimit(size, price)` (FSM :556) | The old target is cancelled first (verified). Re-read the position (it must equal `expectOpen`, or report `reject`), then place the new one. Reports `ack` for the new key. | `_tideReplaceTarget` |
| `cancel` | `stop` | `cancelVerified(orderId, label, sizeHint, priceHint)` (FSM :1866) | A protective stop is cancelled ONLY in the flatten lifecycle (`cancel-stop`: verified before any market order), when the position is flat, or when a replacement is confirmed resting (restart). `true` → `cancel-ack`. `false` (not verified) → `reject`, and the planner sends no market order (ruling 6). A stop that filled instead → its `fill` + `cancel-ack`. | — |
| `cancel` | `tp1` / `tp2` / `add` | `cancelVerified(orderId, label)` (FSM :1866) | Reports `cancel-ack` / `reject` (and any `fill` that won the race). | `tideAddCancel` (an add) |
| `cancel` | `entry` | leg 1: `cancelIfSet('entryOrderId')` → `resolvePendingCancel()` (FSM :567 / :781) | Reports `cancel-ack` once terminal. A live entry quantity stays RESERVED until then. | — |
| `flatten` | `position` | `getOpenPosition` (re-read), then `placeOrder({ type: MARKET, side: closing, size: min(expectOpen, actual position) })`, the calls `flattenNow` (:2467) and `replaceStopSafely`'s market exit use | Sent only after the stop cancel was VERIFIED and a position read (`stopCancelledVerified: true`). Reports `fill` (cumulative) with the flatten key. When the order ends with part unfilled, or was not needed, it also reports `cancel-ack` for the flatten key. No ack within the timeout → `no-ack` (the planner re-protects and never re-sends). A refusal → `reject` (re-protect, no second flatten). | — |
| `read` | `position` | `getOpenPosition` + `getOpenOrders` | Not an order. Answer with a `reconcile` event carrying the SAME `key`: the position (qty, dir) and the open orders mapped to their keys, with their broker prices. An answer with an old key, or a second answer to the same key, is ignored. | — |
| `alert` | `alert` | `this.notify(title, text, { priority: 'high', tags: 'warning' })` + `this._manage(code, text, extra)` | One per block reason (`code`): config-problem, no-stop, stop-rejected, stop-looser, stop-price-unknown, stop-cancel-failed, flatten-rejected, flatten-stalled, broker-state-unknown, position-reversed, reconcile-*, …. | — |

## Events
These are the executor's reads. `id` is a stable unique id; a replay with the same id, or exactly the same content, gives no intents.

| event | from (existing) |
|---|---|
| `signal` | the TIDE router (accepted signal: dir, grade, entryPx, entryType, stop = the option-C structural stop, pools, partialPools) |
| `ack` (+ `price` for a stop) / `reject` (+ `lastPx`) / `no-ack` | `placeOrder` result / throw (`e.orderRejected`, `e.authUnknownOrder`, timeout); `replaceStopSafely` / `placeProtectiveStop` results; for a stop, the level actually accepted |
| `fill` / `partial-fill` | `getEntryOrder` (orders), `getOpenPosition` changes. Always the CUMULATIVE `filledQty` per order. |
| `cancel-ack` | `cancelVerified` true / `resolvePendingCancel` terminal |
| `tp1-traded` | the 1m high/low reaching the plan's TP1 price (the 1-lot case) |
| `ladder` | every poll: `bestPx` (1m highs/lows since the fill or the add), `lastPx`, optional `majorSwept` / `swings15m` / `climax` / `swings5m`, `invalidated` |
| `pullback-add` | TIDE's rejected-pullback evidence: `addPx`, `lastPx`, `bias { m15, m30, line }`, `control4h`, `rejection` |
| `exit-at-market` | the executor asks for an exit (the planner starts the flatten lifecycle once) |
| `reconcile` | the answer to a `read` (with its `key`); or, with NO key, ONLY at a restart (no order of ours can still be in flight) or to clear a block: `getOpenPosition` + `getOpenOrders` mapped to intent keys (`key: null` when unknown) |

## The flatten lifecycle (ruling 6; MacDot 6623943578)
It is started by a crossed ladder lock, an `exit-at-market` event, a stop rejected at an already-crossed level, a failed stop level that later trades, or (r1.2) a naked position: two stop rejects with no stop working, or a reconcile / restart that finds no working stop.
1. **One per position.** `state.flat` exists once; every later exit request, crossed ladder, duplicate or replay is a no-op.
2. **Clear.** Cancel the targets / entries / add and wait until each is terminal. The protective stop still rests (and is resized if a target fills meanwhile).
3. **Cancel the stop, verified.** `cancel-ack` → step 4.
   - Not verified → one retry, then `stop-cancel-failed`: alert, the stop keeps working, NO market order.
   - A stop that fills instead → the fills say flat → step 6.
4. **Read the position.** 0 → step 7. The opposite side → step 8.
5. **Market close of exactly the quantity read.**
   - Its fills say 0 → step 6.
   - It ends with contracts left (a partial), or a later read shows contracts → re-protect at the last acked price at once, then the next pass (3 → 5) for the rest only.
   - `reject` → re-protect + alert, and no second flatten ever.
   - `no-ack` → re-protect + alert + read, never re-sent; its late fill completes the exit.
6. **Fills say flat.** Cancel any stop still resting (it protects nothing), then send a confirming read.
7. **Terminal only on a read of 0.** `state.flat.realized = { qty, avgPx, vsLadderPts, vsTriggerPts, byKind }` comes from the actual closing fills seen after the trigger. Nothing is assumed: fills lost to a crash are not invented.
8. **Backstop.** A closing fill larger than the position, or a read on the opposite side: alert, our closing orders cancelled, phase `REVERSED`, nothing else sent.
9. **Restart.** The saved state plus a keyless `reconcile`:
   - position 0 → confirmed flat;
   - position > 0 → re-protect at the last acked price, then ONE continuation pass for what is left;
   - the opposite side → step 8.

## Open questions (for MacTide / MacArthur)
1. **The `sessionFlatten` kind label** for a ladder-lock exit (journal only): 'protect'.
2. **The 1-lot TP1:** with no TP1 order, `tp1-traded` (the TP1 price trading) counts as TP1 done: break-even, and the add allowed. Confirm with Mac.
3. **The ladder before the entry is complete:** while a partially filled entry is still working, the plan's R is not known yet, so only the structural stop protects. Acceptable?
4. ~~A naked position after two stop rejects~~ **Decided (r1.2):** flatten at once, and the same for a restart that finds a naked position (ruling 7).
