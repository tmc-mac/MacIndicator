# BF-R11: botfix r1.1 (closes the limits declared in r1)

Branch `r1.1` on top of r1 (a9271d8). Code commit 8624b23. Executor sha8 **725b19ff** (r1: 16395252).

The trading decisions are unchanged: entries, sizing, stop distances, TP1, the runner, np1's rule and capped sizing (OFF) are all the same as in r1. There are no new config keys. The changes touch only how exits are sent and confirmed, the alerts, and the handling of phone requests.

## 1. `[exits]` startup line
- **What changed:** `lib/safeExit.js` now has `rulesText()`, which builds the rule text from the module's own constants, so the log can never disagree with the code. `live-executor.js` prints `[exits] <rule>` right after the `[np1]` line.
- **What the line says:**
  - N = 20 s settle;
  - K = 3 sends, with 0 s / 10 s backoff;
  - every exit it covers;
  - every HALT condition.

## 2. Phone flatten on the safe-exit rule (and the through-stop "still open" path)
- **`flattenNow(opts)`** no longer has its own exit code. It becomes a `manual` kind of `sessionFlatten`, which brings:
  - protective orders cancelled **verified** first (r1 used unverified `cancelIfSet`);
  - the exit intent written to disk before the send;
  - a lost reply = UNKNOWN: settle, history check, never a second order while unknown;
  - a rejection: stop and TP1 put back, backoff, K = 3, then HALT.
- **Kept from r1:**
  - an unreadable position still throws before anything is touched, so the executor still requeues the request;
  - the same `MANUAL_FLATTEN` journal entries (row + `manual_flatten`) and the same "Flatten requested" / "Flatten confirmed" pushes.
- **Persistence and the driver:** `flattenKind: 'manual'` is persisted and restored. A new executor driver runs `sessionFlatten(..,'manual')` every poll until the bot is FLAT or HALTED. This covers a stop still resting, a backoff after a rejection, a lost reply that settled "still open", and a restart. The driver never runs on a halted bot or in PENDING_ENTRY.
- **Other callers:** the daily floor and the trend time stop use the same path, labelled `Daily-floor flatten` / `Time-stop flatten`.
- **Halted bot:** a flatten request sends nothing and is acked `REJECTED HALTED: … flatten in TopstepX`. This is deliberate: on an unexplained position, a market exit in the bot's direction could add to the position.
- **New phone acks** (`flattenResult` gets `result`):
  - `sent`: unchanged text;
  - `retry`: "exit under way … retried every poll until flat or halt";
  - `desynced`: REJECTED HALTED.
- **Through-stop exit (`_exitFilledThroughStop`):** in r1, a rejection or an unknown-then-still-open reply retried every poll with no cap. Now:
  - a backoff after each rejection;
  - K = 3 sends in total, after which it HALTS with the backup stop resting;
  - the cap is checked **before** the backup stop is touched;
  - `exitInFlight` (kind `through-stop`) is written to disk before the send;
  - after an unknown reply, the backup stop is placed only after the settle says "same".
- **Restart with a through-stop exit in flight:**
  - flat: the bot starts FLAT;
  - anything else: HALT. This is conservative; the trade never existed as a managed position.

## 3. Order-history field names: evidence
`searchOrdersSince` and `exitOrderSeen` read `type`, `side`, `size`, `status` and `creationTimestamp` from `/api/Order/search` `orders[]`. The evidence, in the brief's order:

- **(a) Bot code that already reads the same API.**
  - `lib/brokerAuth.js` `orderMatches()` reads `type`, `side`, `size`, `limitPrice`, `stopPrice` and `creationTimestamp` from `/api/Order/search` rows. This is live since the auth package (recovering an order after a 401).
  - `liveStateMachine` `closeCancelledFill` / `resolvePendingCancel` read `status` (2/3/4/5), `fillVolume` and `filledPrice` from the same rows.
  - `lib/phoneSnapshot.js` reads `creationTimestamp` and `updateTimestamp`.
  - `liveOrders.placeOrder` sends `type` and `side` with the documented enums (MARKET 2, BUY 0, SELL 1).
- **(b) Real journal rows** (MacMillionz slices, `agent-line` `data/2026-11-10/`, 5 slices, read with `python3 -I`).
  - The journals hold **no raw broker order rows**: there are no `status` or `creationTimestamp` order objects.
  - They do confirm the request-side names and codes. `journal_receipt` `TRANSPORT_INTENT` rows carry `{type: 1, side: 1, size: 3, ...}`, which is a LIMIT sell, the same numeric codes the bot sends.
  - So (b) supports `type`, `side` and `size` only. It cannot confirm `status` or `creationTimestamp`.
- **(c) Public ProjectX Gateway API docs** (gateway.docs.projectx.com, fetched 2026-11-10):
  - `/api/Order/search` example response: `orders[]` with `id, accountId, contractId, symbolId, creationTimestamp ("2025-07-18T21:00:01.268009+00:00"), updateTimestamp, status, type, side, size, limitPrice, stopPrice, fillVolume, filledPrice, customTag`. Parameters: `accountId`, `startTimestamp`, optional `endTimestamp`.
  - Enum definitions: `OrderStatus { None = 0, Open = 1, Filled = 2, Cancelled = 3, Expired = 4, Rejected = 5, Pending = 6 }`.
  - Order/place: `OrderType 1 Limit, 2 Market, 4 Stop, 5 TrailingStop`; `side 0 = Bid (buy), 1 = Ask (sell)`.
  - Node 18.19.1 `Date.parse` reads the microsecond `+00:00` stamp correctly.

**Result:** no mismatch. The code's names and codes match the docs and the bot's existing readers. Dead statuses are 3, 4 and 5. Statuses 0 (None) and 6 (Pending) count as "may have acted", which leads to more halts but never a second exit.

**Fail-safe added anyway:** if any history row inside the window lacks an integer `type`, `side` or `status` (renamed fields, enum strings, a null row), or the list is not an array, `exitOrderSeen` returns `unknown`. The exit is then "not proven", so the bot HALTS with an urgent alert and sends no second order. The halt reason says "the order history has a row whose type/side/status could not be recognised". Rows older than the window are ignored.

## 4. One push per full stop
- **Before:** a full protective stop pushed twice, "Stopped out" from the machine and "Full stop: … net" from `health.fullStop`.
- **Now:** the executor sets `stateMachine.fullStopPushOwner = 'health'`. The machine then skips "Stopped out" for a stop with no profit lock, on both paths (`_closeWholeLeg1` and the LEG1 size-0 path).
- **Executor change:** the "Full stop" push no longer needs `trendLife.filled`, so a stop that fills right after a restart still pushes once.
- **Unchanged:** a profit-lock stop (which gets no "Full stop" push) keeps "Stopped out (profit lock)". A machine that is not wired (tests, old callers) keeps "Stopped out". Every full stop gets exactly one push.

## 5. Entry-cancel phone requests age out at 60 s
`lib/entryCancelRequests.js` uses the same limit as flatten and pause (60 s):
- **Stale:** a request still `requested` (never picked up) after 60 s is closed `stale`, "STALE: written N s ago (limit 60 s); not acted on". It makes no broker call, is journaled, and is acked **STALE** through `cancelResult`.
- **Already picked up:** a request picked up in time (`pending` or `unknown`, tracking retained) is unchanged.
- **Same entry again:** a new tap for the same entry after a stale one queues a fresh request.
- **Fast poll:** a stale request never wakes the fast poll.

## 6. QA tests D1b / D2 / D3 / F1, rewritten
The copies are in `botfix/r11-tests/qa-tests-r11.js`. The original file is untouched, and every other test in it is unchanged.
- **D1b:** after a rejected exit, TP1 **is** put back, 1x at the same price, and tracked.
- **D2:** persistent rejection. Nothing is sent inside the backoff, there are at most K = 3 sends, then HALT (one urgent push, an EXIT_HALT row). Exactly one stop and TP1 stay resting.
- **D3:** after the cap HALT, a broker that now accepts gets **no** 4th order (level-loss or session close). The account is still long and protected.
- **F1:** with the key off, the bot behaves like pkg-A47 except for the documented exit-safety differences:
  - (a) the snapshot carries `exitInFlight` / `exitAttempts`;
  - (b) TP1 is put back after a rejection (an extra REST LIMIT, with order ids normalised);
  - (c) the wording of the retry row.
  
  Everything else must be identical. **F1b** (new): an accepted session close and no-progress are byte-identical to pkg-A47.

## 7. Tests (all on the committed tree, Node 18.19.1, nice 19)
| Suite | r1.1 |
|---|---|
| exitsafe-tests.js | **63/63** |
| test/phone-snapshot.test.js | **12/12** |
| tests/health-alerts-tests.js | **28/28** |
| c5-tests.js (CL = config-off) | **25/25** |
| r11-tests.js (new: [exits], manual flatten 16, through-stop 6, field fail-safe 4, full-stop push 6, entry-cancel 6, acks 2) | **42/42** |
| qa-tests-r11.js (D1b/D2/D3/F1 rewritten + F1b) | **43/43** |
| qa-tests.js original (for the record) | 38/42: only D1b, D2, D3 and F1 fail, the old unsafe asserts (same as r1) |

Outputs are in `botfix/r11-tests/results/`.

## 8. Boot (60 s, nice 19, fake broker, config-off, Node 18.19.1)
Result: exit 0 on SIGINT, 0 error/exception lines. It reached the live loop and printed `[exits]`.
```
[exits] safe-exit rule ON for every market exit (session close, morning hold, no-progress, level-loss, filled-through-stop, phone/manual flatten, daily floor, time stop): a broker success:false = REJECTED, anything else (timeout, lost reply) = UNKNOWN -> no second order, no stop put back until the position and orders settle (N = 20 s of reads 1 s apart; flat = 2 agreeing reads; "still open" = 6 agreeing reads with nothing working AND the order history showing no live/filled exit); K = 3 market sends per exit (backoff 0 s, 10 s; the count survives restarts). HALT (no entries, no orders, urgent push) when: K sends fail, the reads never settle, the broker shows the opposite side or another size, or the order history is unreadable / shows the exit live or filled / has an unrecognised row. An accepted exit not flat after 60 s: one urgent alert, no second order.
=== LIVE ORDER EXECUTOR starting for MNQ ===
Entering live loop, polling every 20s... [INTRABAR EVALUATION MODE — every 20s against the still-forming bar]
Startup reconciliation: no existing open position found — starting FLAT.
```
The only alert was "Warm-up cut short (600 of 2000 bars)". It comes from the fake broker's 600-bar cap and appears in r1's boot too. This is not the ship-gate Mac-box run.

## 9. Remaining limits
- **Field names (b):** the journals contain no raw broker order-history rows, so `status` and `creationTimestamp` rest on the docs and the bot's existing readers. An unexpected shape fails safe (HALT, never a second order). The docs do not say whether `startTimestamp` filters on the creation or the update time; the bot queries from 60 s before the send.
- **`flattenNow` at size 0:** a single zero read still cleans up and resets (the r1 behaviour). The double-read confirmation applies only once an exit is under way.
- **Manual flatten after a restart:** it resumes only when the saved trade state is restored. An adopted position with no saved state loses the manual intent, so Mac taps again. A through-stop exit that is still open at a restart HALTS rather than resumes.
- **Halted bot:** a halted bot refuses phone flatten by design. Mac flattens in TopstepX.
- **Missed full-stop push:** if `health.fullStop` fails internally, the stop gets no push (it logs instead). The function is tested and catches its own errors.
- **Not run (Mac said none):** replays, soaks, the restart soak, the trade witness and the 961 MB Mac-box gate. MacDot's HOLD findings have not been received, so they are not in scope yet.
