# Snapshot contract: edge r1.1 (bot builder desk, 11/11)

For the terminal desk. The file is the phone snapshot `bias-snapshot-<SYMBOL>.json`, written atomically (tmp + rename) about every 20 s and on events.
Everything below is **additive**: every key the edge r1 snapshot has keeps its name, type and meaning. All times are epoch ms (UTC). Money is USD, 2 decimals.
Points are index points, 2 decimals. `null` always means "not known", never zero.

A shape in this file does not change without a dated note appended at the bottom.

## 0. Where things live (key paths)

| What | Key path |
|---|---|
| Per-trade rows (closed and open broker round trips of the trading day, newest first, at most 10) | `recentTrades[]` (`closed: true/false`) |
| The open trade's rule facts (also) | `position.rule` (only while `position` is a filled trade: not null, not `pending: true`) |
| Rule settings and the market now | `rules` |
| Scorecard | `scorecard` |
| News gate state | `news.loaded`, `news.nextEvents`, `news.blocking`, `news.blockingWhat` (added INSIDE the existing `news` object) |
| Checklist evaluation time | `current.checklist.evaluatedAt` (and the same key on each `history[].checklist` written by this build) |
| Balance read time | `balanceReadAt` (top level, beside `accountBalance`) |
| Version of the edge r1.1 fields | `edgeFields: 1` (top level; absent = older build) |

`recentTrades` is `[]` in PAPER mode. A field can be missing on a row only when the whole build is older; in this build every key below is always present.

## 1. Existing fields (edge r1, unchanged; shapes copied from `lib/phoneSnapshot.js`)

```json
"build": { "stampId": "7ef6d73bffd3", "executor": "9f8bcb8c", "settingsHash": "42a6068e", "overridesHash": "1c0de5aa",
           "startedAt": 1794365460000, "runId": "a1b2c3d4", "node": "v18.19.1" },
"broker": {
  "readAt": 1794365478000, "positionReadAt": 1794365478000, "ordersReadAt": 1794365479000, "source": "broker",
  "position": { "side": "LONG", "qty": 3, "avgPrice": 25410.25, "openedAt": 1794365400000 },
  "workingOrders": [
    { "id": 123, "type": "STOP", "side": "SELL", "qty": 3, "price": 25380.25, "stopPrice": 25380.25, "limitPrice": null,
      "kind": "stop", "createdAt": 1794365401000, "updatedAt": 1794365401000 }
  ]
},
"requests": {
  "lastAck": { "id": "f-0123456789abcdef", "type": "flatten", "requestedAt": 1794365470000, "receivedAt": 1794365472000,
               "at": 1794365472500, "result": "APPLIED", "reason": "ALREADY_FLAT: no order sent" },
  "recent": [ "... the last 10 acks, same shape as lastAck ..." ],
  "appliedAt": { "flatten": 1794365472500, "pause": null, "cancel": null },
  "maxAgeMs": 60000, "pollMs": 3000
},
"phoneFields": 1
```

- `build`: any member can be `null`. `executor` = first 8 hex of sha256(live-executor.js).
- `broker.source`: `"broker"` or `"paper"` (paper: `readAt`, `position`, `workingOrders` are `null`, and `positionReadAt` / `ordersReadAt` are absent).
  `readAt` = the older of the two reads, `null` until both exist. `position.side`: `LONG` / `SHORT` / `FLAT` (FLAT: qty 0, avgPrice null, openedAt null).
  `workingOrders[].type`: `LIMIT` / `MARKET` / `STOP` / `TRAILING_STOP`; `side`: `BUY` / `SELL`;
  `kind`: `entry` / `stop` / `stop-after-tp1` / `runner-stop` / `tp1` / `tp2` / `target` / `other`.
- `requests`: `null` only if the request module is missing. `lastAck.type`: `flatten` / `pause` / `cancel`;
  `result`: `APPLIED` / `REJECTED` / `STALE` / `PENDING`.

## 2. New: per-trade fields on `recentTrades[]`

Existing row keys stay (`contractId, dir, entryTime, entryPrice, maxSize, pnl, closed, exitTime, entryAvgPrice, exitPrice, exitSize, fees, grossPnl, netPnl,
commissions, extraCost, source, grade, journalId, ...`). Added:

```json
{
  "closed": true, "dir": 1, "entryPrice": 25410.25, "maxSize": 3,
  "exitReason": "EARLY_EXIT",
  "exitCode": "EARLY_ADVERSE_EXIT",
  "grossUsd": -66.00,
  "feesUsd": 3.66,
  "netUsd": -69.66,
  "ptsPerContract": -11.00,
  "rule": {
    "runnerMode": "atrTarget",
    "atr15AtFill": 61.4,
    "tp2Price": 25533.00,
    "earlyExit": "fired",
    "earlyExitAt": 1794365580000,
    "earlyExitPts": -11.25
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `exitReason` | string or null | `TP1` / `TP2` / `RUNNER_STOP` / `STOP` / `NO_PROGRESS` / `EARLY_EXIT` / `SESSION_CLOSE` / `MORNING_HOLD` / `LEVEL_LOSS` / `MANUAL_FLATTEN` / `UNKNOWN`. `null` while the row is open (`closed: false`). `UNKNOWN` = closed and the journal does not say (never a guess). `TP1` as the final reason = all contracts left at TP1 (allAtTp1 or a 1-lot). `RUNNER_STOP` = any stop that closed contracts after TP1. `STOP` = the full protective stop. |
| `exitCode` | string or null | the journal code that decided `exitReason` (for a tooltip); `null` when unknown or open |
| `grossUsd` | number or null | broker gross of the round trip (sum of the fills' profitAndLoss). `null` while open |
| `feesUsd` | number or null | ALL costs: `grossUsd - netUsd` (exchange fees + commissions). `null` while open |
| `netUsd` | number or null | broker net (same number as the row's existing `netPnl`). `null` while open |
| `ptsPerContract` | number or null | `grossUsd / (pointValue x maxSize)`: gross points per contract over the whole trade. `null` while open |
| `rule` | object | always present (members can be null) |
| `rule.runnerMode` | string or null | `live` / `allAtTp1` / `atrTarget`: the plan this trade actually got (after any fallback). `null` = the bot has no journal match for this broker trade (manual trade, ambiguous match) |
| `rule.atr15AtFill` | number or null | the 15m ATR(14) captured at the fill |
| `rule.tp2Price` | number or null | the ATR runner's TP2 price; `null` unless `runnerMode` is `atrTarget` |
| `rule.earlyExit` | string or null | `fired` (the rule closed the trade) / `passed` (assessed and kept; also a fired decision abandoned because TP1 filled first) / `unassessed` (the check could not be made, or the trade ended before the check) / `off` (rule off) / `log-would-exit` (log mode: it would have exited, nothing sent). `null` = open trade not assessed yet, or no journal match |
| `rule.earlyExitAt` | number or null | the 1m close time the rule read (fired, passed, log-would-exit); else `null` |
| `rule.earlyExitPts` | number or null | points at that close, signed (negative = against the trade); else `null` |

`position.rule` has exactly the `rule` shape above, for the open trade.

## 3. New: `rules`

```json
"rules": {
  "earlyAdverseExit": { "mode": "exit", "afterSec": 120, "lossPts": 10, "minSeenPts": 3 },
  "sessionRunner": { "asia": "allAtTp1", "london": "allAtTp1", "ny": "atrTarget", "late": "live" },
  "sessionRunnerNy": { "stopPts": 2, "tp2AtrMult": 2.0 },
  "sessionNow": "ny",
  "atr15Now": 61.4,
  "atr15Median20d": 52.75,
  "runnerNow": { "mode": "atrTarget", "tp2Pts": 122.8 },
  "tp1AtrShadow": { "mode": "log", "atrMult": 0.75, "minPts": 15, "maxPts": 60, "beAfterPts": 15, "tp1PtsNow": 46.05 }
}
```

- `earlyAdverseExit.mode`: `exit` / `log` / `off`. `sessionRunner.*`: `live` / `allAtTp1` / `atrTarget`.
- `sessionNow`: `asia` / `london` / `ny` / `late` (the bot's own session helper; PT clock), or `null`.
- `atr15Now`: mean true range of the 14 completed 15m bars before now; `null` when the bars are missing or stale.
- `atr15Median20d`: median of the 15m ATR(14) at every completed 15m bar of the last 20 calendar days; `null` when the bot holds less than 20 days of 15m bars.
- `runnerNow.mode`: what a fill right now would get by config (`live` when the scale-out is off). `runnerNow.tp2Pts` = `tp2AtrMult x atr15Now`, only for `atrTarget` with a known ATR; else `null`.
- `tp1AtrShadow`: the shadow's config; `tp1PtsNow` = clamp(atrMult x atr15Now, minPts, maxPts) or `null`. With mode `off`: `{ "mode": "off" }` only.

## 4. New: `scorecard`

`null` in PAPER mode or if the scorecard could not be read. Counts start at `since` (this build's first start) and survive restarts.

```json
"scorecard": {
  "version": 1,
  "since": 1794365460000,
  "updatedAt": 1794372660000,
  "openRecords": 1,
  "earlyExit": {
    "fired": 4, "passed": 11, "unassessed": 2, "logWouldExit": 0,
    "firedNetUsd": -262.40,
    "shadow": { "wouldHaveHitStop": 3, "wouldHaveHitTp1": 0, "unresolved": 1, "pending": 0 },
    "estSavedUsd": 371.50
  },
  "runner": {
    "asia":   { "trades": 6, "tp1Hits": 4, "allAtTp1Count": 4,
                "atrRunner": { "n": 0, "tp2Hits": 0, "stoppedAtPlus2": 0, "sessionClosed": 0, "other": 0, "runnerNetUsd": 0, "reached30BeforeEntry": 0, "avgRunnerPts": null } },
    "london": { "trades": 5, "tp1Hits": 3, "allAtTp1Count": 3,
                "atrRunner": { "n": 0, "tp2Hits": 0, "stoppedAtPlus2": 0, "sessionClosed": 0, "other": 0, "runnerNetUsd": 0, "reached30BeforeEntry": 0, "avgRunnerPts": null } },
    "ny":     { "trades": 6, "tp1Hits": 4, "allAtTp1Count": 0,
                "atrRunner": { "n": 4, "tp2Hits": 1, "stoppedAtPlus2": 2, "sessionClosed": 1, "other": 0, "runnerNetUsd": 251.48, "reached30BeforeEntry": 3, "avgRunnerPts": 31.44 } },
    "late":   { "trades": 0, "tp1Hits": 0, "allAtTp1Count": 0,
                "atrRunner": { "n": 0, "tp2Hits": 0, "stoppedAtPlus2": 0, "sessionClosed": 0, "other": 0, "runnerNetUsd": 0, "reached30BeforeEntry": 0, "avgRunnerPts": null } }
  },
  "tp1AtrShadow": {
    "mode": "log",
    "n": 17, "resolved": 14, "unresolved": 2, "pending": 1,
    "shadowNetUsd": { "plain": 512.30, "beAfter15": 388.10 },
    "liveNetUsd": 141.72,
    "liveNetUsdMissing": 0,
    "extraFullStops": { "plain": 3, "beAfter15": 0 },
    "outcomes": { "plain": { "tp1": 9, "stop": 5 }, "beAfter15": { "tp1": 8, "stop": 2, "breakeven": 4 } }
  },
  "totals": {
    "asia":   { "trades": 6, "wins": 4, "fullStops": 1, "netUsd": 88.04, "ptsPerContract": 2.61 },
    "london": { "trades": 5, "wins": 3, "fullStops": 1, "netUsd": 20.70, "ptsPerContract": 1.02 },
    "ny":     { "trades": 6, "wins": 4, "fullStops": 1, "netUsd": 32.98, "ptsPerContract": 1.31 },
    "late":   { "trades": 0, "wins": 0, "fullStops": 0, "netUsd": 0, "ptsPerContract": null },
    "all":    { "trades": 17, "wins": 11, "fullStops": 3, "netUsd": 141.72, "ptsPerContract": 1.72 }
  }
}
```

Definitions (honest-number rules):

- A trade enters the scorecard when the bot sees its fill. Money always comes from the broker's round trip for that trade (the `recentTrades` numbers). A trade whose
  broker money is not matched yet is counted in the count fields and NOT in any USD field; `openRecords` = records still waiting for something (an open trade, broker money, a shadow).
- **`earlyExit`**: `fired` / `passed` / `unassessed` / `logWouldExit` = closed trades by their `rule.earlyExit` (rule off = not counted). `firedNetUsd` = broker net of the fired trades.
  - `shadow`: one result per fired trade. After the exit the bot keeps reading price on its existing polls: `wouldHaveHitStop` = the original stop was touched first,
    `wouldHaveHitTp1` = the original TP1 first, `unresolved` = neither within 30 minutes (or no price, or a new trade opened), `pending` = still watching.
  - `estSavedUsd` = sum over fired trades with a stop / TP1 shadow result AND broker money of `(actual gross) - (gross the original plan would have made)`, where the plan gross is
    `-stopPts x pointValue x contracts` (stop) or `+tp1Pts x pointValue x contracts` (TP1, all contracts valued at TP1). Positive = the rule saved money. Unresolved trades add 0. An estimate: costs are equal on both sides and left out.
- **`runner.<session>`** (session of the fill): `trades` = closed trades; `tp1Hits` = trades whose TP1 filled; `allAtTp1Count` = trades run as `allAtTp1`.
  - `atrRunner`: trades run as `atrTarget` whose TP1 filled (so a runner existed). `tp2Hits` / `stoppedAtPlus2` (the +stopPts stop) / `sessionClosed` / `other` (manual, level loss, unknown) = how the runner ended.
    `runnerNetUsd` = the broker net of those whole trades. `avgRunnerPts` = mean points the 1-lot runner made from the entry (TP2 distance, +stopPts, or the estimated market exit); `null` at n 0.
    `reached30BeforeEntry` = runners that were seen at +30 pts or more (poll prices) before coming back to their stop near the entry (the "would a +30 TP2 have paid" count).
- **`tp1AtrShadow`** (record only; mode `off` = `{ "mode": "off" }`): `n` = filled trades given a shadow; `resolved` / `unresolved` / `pending` add up to `n`.
  A shadow is resolved when both variants have an outcome. `shadowNetUsd.plain` = variant (i) original stop; `.beAfter15` = variant (ii) stop to entry once +15 was seen.
  Shadow money model: all contracts leave at the outcome (`tp1` = +shadowTp1Pts, `stop` = -stopPts, `breakeven` = 0) minus the configured round-trip cost. No runner is modelled.
  `liveNetUsd` = broker net of the SAME resolved trades (so the three sums compare like with like); `liveNetUsdMissing` = resolved trades whose broker money is not matched (left out of all three sums).
  `extraFullStops` = resolved trades the shadow stops out in full that were NOT a full stop live.
- **`totals.<session>`** and `all`: closed trades with broker money. `wins` = net above 0; `fullStops` = `exitReason STOP`; `ptsPerContract` = sum gross / (pointValue x sum contracts); `null` at 0 trades.

## 5. New: `news` members, `checklist.evaluatedAt`, `balanceReadAt`

```json
"news": { "...existing keys (next, wait, text, count, upcoming, source, refreshedAt, fileAt, off, resting, waitAfter) unchanged...": 0,
          "loaded": true,
          "nextEvents": [ { "t": 1794409800000, "title": "CPI m/m", "impact": "high" } ],
          "blocking": false,
          "blockingWhat": null },
"current": { "checklist": { "verdict": "...", "items": [], "evaluatedAt": 1794365478123 } },
"balanceReadAt": 1794365470000
```

- `news.loaded`: a calendar with at least one event is loaded. `false` = the gate is failing open (unchanged behaviour). `news.nextEvents`: the next 3 releases
  (`impact`: `high` / `medium`). `news.blocking`: the news gate is stopping something right now; `news.blockingWhat`: `entries` / `resting-entries` / `null`. With news awareness off: `blocking` is always `false`.
- `checklist.evaluatedAt`: when that checklist was computed. `current` can be `null` right after a start.
- `balanceReadAt`: the time of the newest broker account read that returned the shown `accountBalance`; `null` if unknown or PAPER.

## 6. New journal rows (for a Review tab; not in the snapshot)

`early_adverse_shadow` (one per fired early exit, at resolution), `tp1_atr_shadow` (`phase: "open"` at the fill, `phase: "resolve"` at the end), `scorecard_state` (a corrupt or unreadable state file was replaced).

## Change notes

(none yet)

### 2026-11-11 03:25Z (builder desk), after the build. No existing shape changed; three clarifications and one added key.
1. **Added key `scorecard.moneyMissing`** (integer, top level of `scorecard`, after `totals`): closed trades whose broker round trip was not matched within 6 hours. They stay in the count fields and are in no USD field. Normally 0.
2. **`rule.earlyExit` after reviewer fix S2:** an early exit that was decided but not sent within 60 s now expires. Such a trade shows `earlyExit: "unassessed"` (the rule did not act), `earlyExitAt` / `earlyExitPts` `null`. No new enum value.
3. **`atrRunner.avgRunnerPts` source:** always from the broker money: `(grossUsd / pointValue - leg1Size x tp1Pts) / runner contracts`. It is `null` until at least one ATR runner has broker money.
4. **`rules.atr15Median20d` in practice:** the bot's warm-up window holds about 1371 15m bars (about 20.9 calendar days), so the value is normally present; it is `null` on any start that holds fewer than 20 calendar days (the 60 s fake-broker boot: `null`).
5. Files for the terminal desk: `sample-snapshot.json` (the real 60 s boot snapshot: flat, `recentTrades: []`, every scorecard count 0) and `sample-trades-synthetic.json` (invented trades through the real code, so the per-trade rows and a non-zero scorecard can be seen; marked SYNTHETIC).
6. While the trade is open and before the early-exit check, `rule.earlyExit` is `null`; `position.rule` is present whenever `position` is a filled trade, including `flattening: true`.

### 2026-11-11 05:10Z (builder desk), edge r1.2. Added keys only, plus two corrected values (flatten ack, `openQty`). No existing key removed or renamed.

1. **Entry fill on each trade: `fill`** on every `recentTrades[]` row, and on `levels.trade.open` and each `levels.trade.today[]` row.
   ```json
   "fill": { "price": 25410.25, "t": 1794365400123, "orderId": 123456, "source": "FILL_OBSERVED" }
   ```
   - It is the bot's own observation of the entry fill: the same note that writes the journal's `journal_receipt` row with `status: "FILL_OBSERVED"`.
   - `price` = the broker position's average price when the bot first saw the fill; `t` = when the bot saw it (epoch ms; up to one poll after the real fill); `orderId` = the entry order id.
   - `price` or `orderId` is `null` when the bot did not have it (never a guess). The first observation of a trade is kept; later re-reads never change it.
   - `fill` is `null` when no fill was observed for that row: a manual trade, an ambiguous journal match, a trade from before this build, PAPER.
   - It survives a restart (rebuilt from the journal file at startup).
2. **`fetchFailures`** (top level): `{ lastHour, recoveredLastHour, lastAt, lastPath, lastCause, lastIdleMs }`. Failed calls from the bot to its local proxy (connection level and timeouts; not HTTP error codes).
   `lastHour` counts failed attempts; `recoveredLastHour` counts the ones whose single retry then worked (read-only calls only). `lastPath` is the API path, `lastCause` a code such as `UND_ERR_SOCKET`. All `null` / 0 on a clean run. No alert is tied to it.
3. **`rule` gets three keys** (on `recentTrades[].rule` and `position.rule`), so labels come from the trade and not from today's settings:
   - `rule.session`: `asia` / `london` / `ny` / `late`: the session of the fill. `null` if the bot has no record of the trade.
   - `rule.stopPts`: the ATR runner's stop distance after TP1, in points, as this trade got it. `null` unless `runnerMode` is `atrTarget`. It is NOT the trade's initial stop distance.
   - `rule.tp2AtrMult`: the ATR multiple this trade's TP2 was sized with. `null` unless `runnerMode` is `atrTarget`.
4. **`scorecard.earlyExit.pts`**: `{ exit: { n, sum, avg }, shadow: { n, sum, avg } }`, in points per contract.
   - `exit`: what the fired early exits actually made, from the broker gross (`grossUsd / (pointValue x contracts)`); negative = lost. `n` = fired exits with broker money.
   - `shadow`: where the untouched plan ended for the same trades: minus the stop distance when the original stop came first, plus the TP1 distance when TP1 came first. `n` = resolved shadows.
   - `avg` is `null` while `n` is 0. Trades counted before this build have no points, so `n` can be lower than `earlyExit.fired`.
5. **Flatten acks changed (`requests.lastAck`, `requests.recent`).** Same shape; new reasons and one new optional key.
   - A halted bot now always answers `REJECTED` with a reason starting `HALTED: flatten in TopstepX`, whatever its phase. Before, a bot halted with phase FLAT answered `APPLIED, ALREADY_FLAT`.
   - `APPLIED` with `ALREADY_FLAT: ...` is sent only when a broker position read made for that request also says flat.
   - New refusals: `NOT_FLAT_AT_BROKER: the bot is flat but the broker shows SHORT 3 @ 25410.25; ...` and `BROKER_NOT_CHECKED: ...`.
   - **Follow-up ack:** when a flatten was acked `APPLIED` or `PENDING` with the position still open and the bot then halts before it is flat, a second ack with the SAME `id` is written: `result: "REJECTED"`, reason `HALTED: flatten in TopstepX - the bot halted before the position was flat ...`, and `followUp: true`. So one request id can appear twice in `requests.recent`; the newest wins.
6. **`levels.trade.open.openQty` (and the `qty` tape) while the bot is FLATTENING** is now the size the exit order was sent for (3 of 3 on a market exit before TP1; before it showed `contracts - leg1 - leg2` = 1, or 0 on an all-at-TP1 trade). Other phases are unchanged.
