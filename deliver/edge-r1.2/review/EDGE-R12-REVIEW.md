# Edge r1.2 review (branch edge12, code da249d5, HEAD 0b53d2a, executor d0413a7c)

Reviewer desk, 2026-11-11. Base: edge r1.1 (7debdc4, executor dd2fdc4a). Reviewed `git diff 7debdc4..0b53d2a`, tested a `git archive` of each commit (hashes match) on Node 18.19.1.

## Verdict: SHIP WITH NOTES

Nothing I found can send an order twice, leave a position unmanaged or stop the bot from starting. On the replay day r1.2 sends exactly the orders r1.1 sends, to the millisecond.

Two notes Mac's desk should act on:
1. **F1 (medium): a Flatten tap while the bot is flat and the broker position cannot be read sends an urgent push on every pass (about 3 a minute) until the read works.** ntfy allows 250 messages a day, so about 80 minutes of this would silence every later alert that day. No order is involved. Fix before or soon after the install; until then, do not tap Flatten on a flat bot during a broker outage.
2. **F6 (packaging): `tmc-proxy.js` changed and the r1.1 installer restarts only the bot service.** The proxy fix does nothing until the proxy is restarted. The bot-side fix works without it.

One observation that is not an r1.2 fault but touches Mac's gate ("keep its armed setups"): a restart at 14:40Z on the replay day changes the level picture and the 14:46Z short is not taken. r1.1 does exactly the same (section F3).

## Findings

| Id | Severity | Where | What breaks | Evidence |
|---|---|---|---|---|
| F1 | Medium (alerts, no order) | `live-executor.js:5966`, `:5971`, `:5980-5983` | Bot flat, Flatten tapped, position unreadable: `flattenReadFails` is reset to 0 after `flattenNow()` returns, then the new read throws, the counter goes to 1, and the "attempt 1" urgent push fires. The request is requeued with a fresh time, so this repeats every pass. `notifyPhone` does not de-duplicate urgent pushes (`:1905`). r1.1 never read the broker here. | Traced, not run. The loop reaches the flatten block during an outage because the awaits before it are wrapped (`:5903-5957`). |
| F2 | Low | `lib/bars.js:159` with `:90-99`; stamp at `live-executor.js:2474` | A retried bar read resends the first attempt's body, so its `endTime` is the first attempt's start, while the read is stamped at completion. Normal dead-socket case: about 150 ms. Worst case (connection fails late, then a slow retry): the data can be up to about 30 s older than its stamp, against 15 s on r1.1 and a 60 s freshness limit. | `tests/a-retry.out`: both requests carry the same `endTime`; with a 3 s late reset the window ends 3160 ms before the completion stamp. |
| F3 | Low (wording) | `lib/phoneRequests.js:119` | A halted bot with a resting entry is acked `REJECTED HALTED ... sends no order` although the verified cancel of that entry did run. Mac may think the entry still rests. The position handling itself is unchanged. | `tests/d-flatten.out` row 2. |
| F4 | Low (display) | `lib/phoneRequests.js:94-102` | The follow-up checks `halted` before `flat`. A flatten that completed, followed by a halt in the same pass, gets `REJECTED ... halted before the position was flat`. | `tests/d-flatten.out` "flat AND halted". |
| F5 | Info | `live-executor.js:2539` | The po3 and sr-areas observer jobs (`setImmediate`, `:2231`, `:2284`) now run inside the new turn, before the caller's entry decision, instead of at the caller's next await. Budgets 100 ms and 50 ms. Timing only; they write display state. | Reading; replay orders and timestamps are identical. |
| F6 | Packaging | `tmc-proxy.js:655-656`; r1.1 `install-edge.sh:75,108` | The installer stops and starts the bot service only. The proxy must be restarted for the 75 s keep-alive, and rollback must restore and restart it too. | Reading of the r1.1 package scripts. I did not inspect the r1.2 zip. |

## A. Retry safety

**No order-changing request can be sent twice by the new retry.**

- The match is `RETRY_READ_PATHS.has(path)` on the literal string (`lib/bars.js:28`, `:93`). The bot calls only fixed literals; the only state-changing ones are `/api/Order/place` and `/api/Order/cancel` (`lib/liveOrders.js:14`, `:24`). `Order/modify` is not called.
- My test (`tests/a-retry.js`, raw TCP server counting arrivals, 33 of 33 pass on Node 18.19.1):
  - the 7 listed paths arrive twice and succeed;
  - `Order/place`, `Order/cancel`, `Order/modify`, `Position/closeContract`, `Position/partialCloseContract`, both Auth paths arrive once and throw;
  - 11 near-miss strings (trailing slash, query string, lower case, `//`, a fragment, `%20`, a path that contains a listed string, `/../place`) arrive once and throw;
  - `placeOrder` on a reset arrives once and the error is UNKNOWN (not `orderRejected`), so the safe-exit rule decides as before;
  - HTTP 500, a timeout (15.0 s) and a body cut mid-response on a read path are not retried.
- The seven retried paths are ProjectX searches and the bar read; none changes broker state. A retry can count twice against the rate limit, at most 2 per call.
- Freshness: see F2. Every other retried read is simply taken later, so it is newer than a first attempt would have been, not older.

## B. The event-loop turn

**No re-entrancy.** The turn comes after `refreshAndEvaluateCore` has returned, so every variable it writes is complete before the gap; nothing is half-updated.

- There is one caller chain: the main loop, which awaits each of the four calls (`:2857`, `:6303`, `:6345`, `:6377`). No second evaluation can start in the gap. The phone requests are files read by that same loop. The fast poll is the loop's own sleep. The `lib/safeExit.js` settle reads are awaited inside state-machine calls the loop awaits, so none is pending while an evaluation runs.
- What can run in the gap: the health timer (its own state, `lib/healthAlerts.js:259`), the po3 and sr-areas jobs (F5), the notify-budget save, the display-only 30m candle read (`:2496`), ntfy callbacks, SIGINT. None reads the variables below.
- Written before the turn, read after it by the caller or the entry path: `entryControlBoard`, `alignBoard` / `alignValidGen` / `alignReads`, `cachedSlowHtf`, `journalBars` / `journalReadAt`, `noChaseBars` / `noChase5Bars`, `latestLevelBoard`, `latestEvalBoard`, `sessionFlags` / `flagJob` / `lastFlagEvalAt`, `lastLoggedTriggerTf`, `levelEventTrackers`, `lvReqStart`, `po3ReqStart`, `candleReadAt`, `lastDerivedPeriods`. During the gap these are new while the caller's `lastMac` / `lastLv` / `lastClosedBarTime` are still old; no code that runs in the gap reads both.
- The alignment board is a few milliseconds older when the entry check reads it (limit 60 s).
- Is one turn enough? `tests/b-yield.js` on Node 18.19.1 against a 5 s keep-alive server with a 5.3 s blocked loop: without the turn an order call failed 2 of 4 (ECONNRESET, and the order never arrived); with the turn 0 of 4.

## C. Proxy

- `keepAliveTimeout` 75 s, `headersTimeout` 80 s: consistent (headers above keep-alive, below the 300 s request timeout).
- Measured on the real file, local port, `GET /` only: r1.2 advertises `Keep-Alive: timeout=75` and closed an idle connection after 75.0 s; r1.1 after 5.0 s. An incomplete request head was cut with 408 after 88.6 s.
- No effect on the bot's 15 s `AbortSignal` timeouts or the proxy's 15 s upstream timeout: the keep-alive timer runs only on an idle connection.
- Node 18.19.1's `fetch` still drops its own idle connections after about 4 s when its loop is free (`tests/c-reuse.out`: a new connection after 12 s idle with either proxy). So the 75 s only matters while the bot's loop is blocked, which is the case it is for.

## D. Flatten ack

- **A real flatten is not delayed.** `flattenNow()` runs first, unchanged (`:5966`; `lib/liveStateMachine.js` is not in the diff). The new position read (`:5971`) runs only afterwards, only when the bot was FLAT and not halted. It can add up to about 30 s to that one pass in an outage, with nothing open.
- **A halted bot's position is handled exactly as in r1.1.** Same call, same arguments; only the ack text and result differ. Halted with a resting entry: the verified cancel still runs and the ack says REJECTED HALTED (F3).
- Flat bot, position unreadable: PENDING and retried, which is where F1 comes from.
- Flat bot, broker holds a position: REJECTED NOT_FLAT_AT_BROKER, no order. r1.1 said APPLIED ALREADY_FLAT, so this is an improvement.

## E. Config and install

- **No new config key.** The diff has no hunk in the config defaults or the loader. A rollback has nothing to strip.
- `levelsParity: "pine"`: the five lines that read it are byte-identical in both builds (`live-executor.js:902`, `:1790`, `:2036`, `:2063`, and the two evaluator calls); `lib/levelsPro.js` is unchanged. r1.2 booted with it: `[config-local] levelsParity = "pine"` and `control score: Pine parity`, live loop entered, exit 0.
- State written by r1.2 loads on r1.1: an r1.1 start on the r1.2 witness's files reached the live loop, exit 0, scorecard records kept (the four extra counters are ignored).
- Install and rollback scripts: not run by me (the coordinator dry-ran the r1.2 zip). See F6.

## F. Ship gate runs (replay rig `qa-exit5/rp/h2c-n18`, real bars of 11/02, Node 18.19.1, nice 19)

**F1 Mac-box boot.** 1 core (`taskset`), a 961 MB memory cgroup (v1, created by hand; systemd-run is not available here; this machine has no swap, so stricter than the server), config with `levelsParity: "pine"`.

| Run | Warm-up (wall) | Start to live loop | Peak RSS (VmHWM) | cgroup peak | OOM / limit hits |
|---|---|---|---|---|---|
| boot, pine config | 2.78 s | 3.02 s | 378 MB | 344 MB | 0 |
| soak starts 1 to 4 | 2.28 to 2.38 s | 2.54 to 2.65 s | 372 to 411 MB | 339 to 380 MB | 0 |

The warm-up read 2000 15m bars ("warm-up OK: 2000 15m bars"). The rig's broker calls cost no wall time, so 2.8 s is the evaluation itself on one core of this machine. The builder's root cause needs that block to exceed 5 s on Mac's server; this run does not show that, and does not refute it (a slower core would). The new log line will settle it.

**F2 Trade witness.** 11/02 14:10 to 15:25Z, `qa-sizecap/rp/config-live.json`, 5 minutes, exit 0, no error line.

| Trade | Orders on the fake broker |
|---|---|
| 14:22Z SHORT 3 @ 28752.75 | entry; stop 3 @ 28782.75; TP1 3 @ 28737.75; TP1 filled 14:27; both cancels |
| 14:46Z SHORT 3 @ 28702.50 | entry; stop 3 @ 28752.50; TP1 2 @ 28687.50; early exit 14:49: both cancelled, market BUY 3 @ 28725 |

7 places, 4 cancels. Against the r1.1 witness of the same window: the broker trace is identical (30 of 30 entries) and all 314 log lines carry the same timestamps. The snapshot carries `fetchFailures` (all zero), `scorecard.earlyExit.pts` and the entry `fill` on both `levels.trade.today` rows (price, time, order id). `recentTrades` is empty, as on every rig run. TP2 was not witnessed (same limit as the r1.1 review).

**F3 Restart soak.** 4 starts, 3 restarts, inside the Mac-box limits. Each run ends at its window end through the bot's shutdown handler, which only exits; this is not a SIGKILL.

| Start | Window | Reached live loop | What it kept |
|---|---|---|---|
| 1 | 14:10 to 14:24 | yes | fresh; entered 14:22, stop and TP1 placed |
| 2 | 14:24 to 14:40 | yes | resumed SHORT 3 @ 28752.75 in LEG1_OPEN; TP1 fill handled, both orders cancelled |
| 3 | 14:40 to 14:48 | yes | flat; **did not take the 14:46 short** |
| 4 | 14:48 to 15:00 | yes | flat; one limit entry 14:56, cancelled 14:57 |

The same four windows on r1.1 give identical broker traces and identical log timestamps, so r1.2 behaves as r1.1 under restart. Why start 3 misses the trade: after the 14:40 restart the bot shows different levels from the uninterrupted run at the same minute (IB High 28739.25 against 28729.75, VWAP 28700.39 against 28727.08, bias SELLERS against BUYERS LEANING at the 14:30 close). I did not establish whether that is the rig or the bot. It is in both builds and deserves its own look.

## Not checked

- F1 (the push repeat) is traced from the code, not reproduced on the rig.
- The 15m evaluation time on Mac's server.
- A true SIGKILL restart; the flatten paths in a full-process run; TP2 / the ATR runner; `recentTrades` rows (the rig broker serves no fills).
- The r1.2 zip, its install and rollback scripts, and the live health alerts gate.
- The phone terminal page, strategy and P&L (out of scope).

## Files

- Tests and outputs: `review/edge12/tests/` (`a-retry`, `b-yield`, `c-proxy`, `c-reuse`, `d-flatten`).
- Rig runs: `review/edge12/rig/` (`w12` witness, `boot-pine`, `s1` to `s4`, `r11s1` to `r11s4`, `rb11`, `*.macbox.json`).
