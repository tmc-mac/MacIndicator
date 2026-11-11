# edge r1.2: the "fetch failed" after every 15m close, the entry fill on the phone, and three terminal-review fixes

Base: edge r1.1 (7debdc4, executor dd2fdc4a). Branch `edge12`. Builder desk, 2026-11-11.

**The bot skipped its first intrabar check after most 15m closes because it sent that request on a connection the proxy had already closed. This build removes the cause in two places and retries read-only calls once.**

**`tmc-proxy.js` CHANGED. Mac must restart the proxy service after the install for that part to take effect.** The bot-side fixes work without the proxy restart.

No trading decision changed. No order path gained a retry.

## 1. Root cause

One sentence: the bar-close evaluation blocks Node for more than 5 s, the proxy closes idle connections after 5 s, and the bot's next request goes out on one of those dead connections and fails at once with `UND_ERR_SOCKET "other side closed"`.

How it happens, step by step:

1. At a 15m close the bot reads 10 timeframes at once. Node's `fetch` opens 10 connections to the proxy and keeps them for reuse.
2. The evaluation that follows is one long synchronous block. Nothing else in the bot runs during it, including the timer that would drop connections older than 4 s.
3. `tmc-proxy.js` used Node's default `keepAliveTimeout` of 5 s. It closes the 10 idle connections.
4. The evaluation ends and the intrabar check starts at once (`live-executor.js`, `refreshAndEvaluate({ fast: true })`). Its requests go out on connections the proxy closed. Node reports `TypeError: fetch failed`.

### Evidence (repro on Node 18.19.1, the real `tmc-proxy.js`, the bot's real `lib/bars.js`)

`tests/fetchfail/repro.js` runs the bar-close pattern: `fetchAllTimeframes`, a synchronous block, then `fetchFastTimeframes`. Results are in `tests/fetchfail/results.jsonl`.

| Bot `lib/bars.js` | Proxy | Block | Loop turn | Cycles | Failed cycles | Cause |
|---|---|---|---|---|---|---|
| r1.1 | r1.1 | 5.3 s | no | 40 | **39** | `UND_ERR_SOCKET` "other side closed", 7 ms after the block |
| r1.2 (retry) | r1.1 | 5.3 s | no | 20 | 0 | 95 failed attempts, 95 recovered by the retry |
| r1.1 | r1.2 (75 s) | 5.3 s | no | 20 | 0 | none |
| r1.1 | r1.1 | 5.3 s | yes | 20 | 0 | none |
| r1.2 | r1.2 | 5.3 s | yes | 500 | **0** | none; 0 failed attempts, so nothing needed the retry (7,500 calls) |

Earlier sweep (6 cycles each, r1.1 on both sides): a block of 0 s or 4.5 s gave 0 failures; 5.2 s and 6 s gave 5 of 6. An idle wait of 4.5, 5.2 or 6 s with the event loop free gave 0 failures. So the trigger is the blocked loop across the 5 s mark, not the idle time alone.

This matches the live log:

- The error arrives about 100 ms after "New 15m bar closed", far below the 15 s timeout.
- It is at the intrabar check, the first request after the bar-close evaluation.
- It happens on almost every close (81 on 11/10), which a narrow timing race would not do.
- The one startup case ("broker position unreadable (fetch failed)") is the same pattern: the first read after the warm-up evaluation.
- 11/05 to 11/08 ran a different build against the same proxy with 0 errors.

### What is not proven

The length of the evaluation on Mac's server was not measured. On this rig the warm-up takes about 1 s, so the live block of 5 s or more is inferred from the pattern above. The new log line settles it: every failed call now logs how long the proxy had been silent, for example `[fetch] /api/History/retrieveBars failed: UND_ERR_SOCKET (5304 ms after the proxy's last answer)`. A value of 5000 ms or more confirms this cause.

## 2. Fixes for the fetch failure

| # | Where | What | Needs the proxy restart |
|---|---|---|---|
| 1 | `live-executor.js` `refreshAndEvaluate` | One event-loop turn after each evaluation (a 0 ms timer, then `setImmediate`). Node drops the closed connections before the next request. The evaluation result is returned untouched. | no |
| 2 | `tmc-proxy.js` | `keepAliveTimeout` 75 s (was 5 s), `headersTimeout` 80 s. Connections now outlive the evaluation. This is the only fix that also protects an order call sent right after a long block. | **yes** |
| 3 | `lib/bars.js` `rawPtxFetch` | A connection-level failure is retried once after 150 ms, on read-only paths only. | no |
| 4 | `lib/bars.js`, `live-executor.js` | Logging and a counter (below). | no |

### The retry rule

Retried once, 150 ms later, only when the error is `TypeError: fetch failed` whose cause is `ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, `ECONNREFUSED` or "other side closed". The second failure propagates.

Exact retried paths (`RETRY_READ_PATHS`, exact match, anything else is not retried):

- `/api/History/retrieveBars`
- `/api/Position/searchOpen`
- `/api/Order/search`
- `/api/Order/searchOpen`
- `/api/Account/search`
- `/api/Trade/search`
- `/api/Contract/search`

`/api/Trade/search` and `/api/Contract/search` were not named in the brief. Both are read-only searches the bot already calls; say so if they should come off the list.

Never retried: `/api/Order/place`, `/api/Order/cancel`, `/api/Order/modify` (not called by this code, tested anyway), `/api/Auth/loginKey`, `/api/Auth/validate`, and any path not on the list. Those keep one attempt and the same error as before, so the order machine's UNKNOWN and safe-exit handling is unchanged.

Not treated as connection-level, so never retried even on a read path: a timeout, an abort, an HTTP status, `success: false`.

### Logging and counter

- Each failed call logs one line: `[fetch] <path> failed: <cause code> (<ms> after the proxy's last answer) - read-only path, retrying once in 150 ms` or `- not retried`. No token, no body.
- "ERROR in loop (continuing)" now ends with `[fetch <path> cause <code>]`.
- Phone snapshot, top level: `fetchFailures { lastHour, recoveredLastHour, lastAt, lastPath, lastCause, lastIdleMs }`. No alert is tied to it. It is in the snapshot, not in the health heartbeat file.

## 3. Entry fill in the snapshot

`fill: { price, t, orderId, source: 'FILL_OBSERVED' }` on each `recentTrades[]` row, on `levels.trade.open` and on each `levels.trade.today[]` row.

- Source: the same note that writes the journal's `journal_receipt` FILL_OBSERVED row (`lib/liveStateMachine.js`, three call sites). The executor's journal writer hands that row to `lib/phoneSnapshot.js`.
- The first observation per trade is kept. It is rebuilt from the journal file at startup.
- `null` when no fill was observed for the row. `price` or `orderId` is `null` when the bot did not have it.
- Added keys only.

## 4. Terminal review fixes (`review/TERM-211-REVIEW.md`)

### 4.1 Flatten ack order (D1)

| Case | Before | Now |
|---|---|---|
| Bot halted, any phase | `APPLIED, ALREADY_FLAT` when the phase was FLAT | `REJECTED`, `HALTED: flatten in TopstepX ...` |
| Bot flat, broker flat | `APPLIED, ALREADY_FLAT` without a broker read | `APPLIED, ALREADY_FLAT ... the broker position read says flat`, after a position read made for the request |
| Bot flat, broker holds a position | `APPLIED, ALREADY_FLAT` | `REJECTED`, `NOT_FLAT_AT_BROKER: ... the broker shows SHORT 3 @ price ...` |
| Bot flat, position unreadable | `APPLIED, ALREADY_FLAT` | `PENDING, POSITION_UNREADABLE`, kept and retried (the existing path) |
| Acked APPLIED or PENDING with the position open, then the bot halts | no further ack | a second ack, same id: `REJECTED`, `HALTED: flatten in TopstepX - the bot halted before the position was flat`, `followUp: true` |

- The change is in the executor's request handler and `lib/phoneRequests.js`. `flattenNow` in the order machine is untouched, so the daily floor and the time stop behave as before.
- The broker read for a flat bot is one extra `Position/searchOpen` per flatten request.
- A halted bot with a resting entry: `flattenNow` still runs its verified cancel as before; the ack now says `REJECTED HALTED` (it used to say `APPLIED, resting entry: verified cancel requested`).
- A flat bot that finds a position at the broker only reports it. Adopting or closing it stays with the existing reconciliation.

### 4.2 `openQty` while FLATTENING (D2)

While FLATTENING the open size is now the size the exit order was sent for (`exitInFlight.size`, the broker position read at the send). Before it was `contracts - leg1 - leg2`: 1 of 3, or 0 on an all-at-TP1 trade.

What reads `openQty`: only `lib/levelPanel.js` (the trade's `qty` tape and `levels.trade.open.openQty`, which also go into the saved trade replay record). No trading decision reads it. When no exit size is on record the old figure stays.

### 4.3 Rule facts on the trade

- `rule.session`: the session of the fill.
- `rule.stopPts`, `rule.tp2AtrMult`: the ATR runner's numbers this trade got; `null` unless `runnerMode` is `atrTarget`. `rule.stopPts` is the runner's stop after TP1, not the initial stop.
- `scorecard.earlyExit.pts { exit { n, sum, avg }, shadow { n, sum, avg } }`: points per contract the fired exits made (broker gross), and where the untouched plan ended.
- The scorecard file gained four counters. A file written by edge r1.1 loads with its counts kept (tested); trades counted before this build have no points.

Shapes: `edge2/SNAPSHOT-CONTRACT.md`, note dated 2026-11-11 05:10Z.

## 5. Tests

| Suite | edge r1.1 | edge r1.2 |
|---|---|---|
| test/fetch-retry.test.js (new) | - | **10/10** |
| test/phone-snapshot.test.js | 15/15 | **24/24** (15 kept, 9 new) |
| test/scorecard.test.js | 15/15 | **18/18** (15 kept, 3 new) |
| tests/health-alerts-tests.js | 28/28 | **28/28** |
| tests/edge1-tests.js | 79/79 | **79/79** |
| exitsafe-tests.js | 63/63 | **63/63** |
| r11-tests.js | 42/42 | **42/42** |
| qa-tests-r11.js | 43/43 | **43/43** |
| c5-tests.js (CL = config-off) | 25/25 | **25/25** |
| reviewer file `review-edge1-tests.js` | 29/29 | **29/29** |

- The three `node --test` suites also pass on Node 18.19.1 (52/52).
- Existing tests edited, because the behaviour they pinned was changed on purpose: one phone-snapshot test (ALREADY_FLAT now needs the broker read) and three `ruleOf` equality checks in the scorecard suite (three added keys).
- **Decision identity** against edge r1.1 on the edge1 script (`edge1-identity.js`): 96 trace entries each, **0 differ**.
- **Repro as a test:** `node tests/fetchfail/repro.js --bars <r1.1 lib/bars.js> --proxy <r1.1 tmc-proxy.js> --turn 0 --expect fail` shows the failure; `node tests/fetchfail/repro.js` (this tree, 500 cycles) must show 0. Needs port 8787 free. Result of the 500-cycle run: **0 failed cycles of 500**, 0 failed attempts, 2,674 s.
- **Boot:** one 60 s full-process boot on Node 18.19.1, the bot on Node's real `fetch` through the real `tmc-proxy.js` (r1.2) to the fake gateway. Warm-up complete, live loop entered, clean shutdown, no error line. Snapshot carries `fetchFailures` (all zero), `scorecard.earlyExit.pts`, `recentTrades: []`. Output: `botfix/edge12boot/out.txt`.

Test results: `botfix/edge12-tests/results/`. Runner: `botfix/edge12-tests/run-all.sh`.

## 6. Limits

1. The live evaluation time is inferred, not measured (section 1). The first failed call after the install logs the idle time and confirms or refutes it.
2. The boot was flat and did not cross a 15m close. The fill, the flatten follow-up and the FLATTENING size are unit-tested; their executor wiring has not seen a trade.
3. Not run here, by instruction: the replay rig, the restart soak, the trade witness, the Mac-box cgroup run and the install path. They are the reviewer desk's ship gate.
4. The proxy's 75 s keep-alive moves the stale-connection window instead of removing it: a block that straddles the 74 s to 75 s mark of an idle connection could still hit it. The loop turn and the read retry cover that case for reads.
5. An order call sent on a dead connection is still not retried, by design. With the proxy restarted and the loop turn in place that situation should no longer arise after an evaluation; if it does, the order machine handles it as before.
6. Other long synchronous blocks outside `refreshAndEvaluate` are not covered by the loop turn. The proxy change and the read retry cover them.
7. The suites were run one at a time at nice 19 with a load gate, except one short re-run (three suites) that started while the load was above 2.5.

## 7. Install note

- Files changed: `live-executor.js`, `lib/bars.js`, `lib/phoneRequests.js`, `lib/phoneSnapshot.js`, `lib/scorecard.js`, `tmc-proxy.js`.
- **Restart the proxy service as well as the bot.** Restarting the proxy drops the phone's and terminal's open connections for a moment.
- Executor sha8: d0413a7c.
