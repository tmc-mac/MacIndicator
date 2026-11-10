# BF-SNAPSHOT: bot-fix desk B (snapshot + phone control), deadline scope 11/10 05:58Z

Additive only. Every existing snapshot key keeps its name and meaning (key diff vs the base tree on the fake broker: 0 missing; added `build`, `broker`, `requests`, `phoneFields`). Terminal 2.0.9.10 needs no change. All times are epoch ms (UTC).

## Fields
| Field | Source | Meaning |
|---|---|---|
| (write) | `lib/phoneSnapshot.js` `write()` / `writeAtomic()` | snapshot written to `<file>.<pid>.<thread>.tmp`, then renamed: a reader sees the old or the new file, never a torn one. Extras never replace an existing key. |
| `build` | session stamp at startup (`journalMeta.buildSessionStamp`) | `{ stampId, executor (sha256 of live-executor.js, 8 chars), settingsHash (8), overridesHash (8), startedAt, runId (8), node }` |
| `broker` | `lib/brokerReads.js`, filled inside `lib/liveOrders.js` `getOpenPosition` / `getOpenOrders` / `getAccounts` (the reads the bot already makes; NO new API call) | `{ readAt (older of the two reads), positionReadAt, ordersReadAt, source:'broker'/'paper', position {side LONG/SHORT/FLAT, qty, avgPrice, openedAt}, workingOrders [{id, type, side, qty, price, stopPrice, limitPrice, kind entry/stop/stop-after-tp1/runner-stop/tp1/tp2/other, createdAt, updatedAt}] }`. A failed read records nothing, so the age grows. While flat, orders are read about once a minute (broker-guard view); while in a trade every ~3 s. |
| `requests` | `lib/phoneRequests.js` | `{ lastAck {id, type flatten/pause/cancel, requestedAt, receivedAt, at, result, reason}, recent [last 10 acks], appliedAt {flatten, pause, cancel}, maxAgeMs 60000, pollMs 3000 }` |
| `phoneFields` | constant | 1 = version of these additive fields |

## Request protocol
- Proxy (`tmc-proxy.js`, backward compatible): `/flatten` and `/pause` files now carry `{ id ('f-'/'p-' + 16 hex), requestedAt }`, written tmp + rename; responses keep their old fields and add `requestId`, `requestedAt`. `/cancel-entry` unchanged.
- Bot: the fast-poll sleep checks for a NEW request file every ~3 s (flatten, pause, or an entry-cancel receipt still `requested`) and wakes the main loop at once; the request is handled at the existing place in the pass by the existing code (`handlePauseRequest`, `entryCancelQueue.process`, `stateMachine.flattenNow()` called by name, no new exit logic). Paper mode / fast poll off: the 20 s sleep is chunked the same way.
- `take()`: file deleted before any action (as before). Rejections, each acked and journalled (`type:'phone_request'`): older than 60 s -> STALE (an old flatten can never fire later, e.g. after a restart; a legacy file without `requestedAt` is aged by its mtime); not a JSON object -> REJECTED MALFORMED (a file younger than 2 s is left for the next poll, it may be mid-write); id already handled -> REJECTED DUPLICATE; requestedAt > 60 s ahead -> REJECTED FUTURE_TIME.
- Results: APPLIED / REJECTED / STALE (final); PENDING = flatten kept and retried because the broker position was unreadable (same id, `retry:true`, fresh requestedAt; retries stay on the normal 20 s pass as before).
- Flatten while flat -> APPLIED `ALREADY_FLAT: ... no order sent` (flattenNow's existing no-op).
- Behaviour change to note: a malformed flatten file used to flatten anyway (the file was never parsed); now it is rejected once 2 s old. The proxy has always written valid JSON.
- Exception: entry-cancel requests are not aged out. They are bound to the exact entry order identity (a later order can never match), and are only acked here.

## Tests
`node --test test/phone-snapshot.test.js`: 12/12 pass on node 22 and node 18.19.1 (stale, legacy mtime stale, duplicate id + retry, malformed young/old + future time, flatten while flat, wake within one 3 s step, atomic write under 3 concurrent writer threads (0 torn reads; the same test with a plain writeFileSync: 1954 torn of 5224, so it catches the bug), additive-only write, build stamp, broker view / balance read time). Exit-reason / news / fee tests were written and passed but are removed with the dropped scope.

## Boot (fake broker, node 18.19.1, nice 19)
Live loop at 0.8 s, exit 0, peak RSS 235 MB, no errors, no tmp file left. Driven through the request files:
- stale flatten (91 s) -> STALE in 1.5 s, file removed, nothing done;
- pause 5 -> APPLIED in 3.3 s; resume -> APPLIED in 3.0 s;
- flatten while flat -> APPLIED ALREADY_FLAT in 3.0 s.
Sample (scrubbed): `build {stampId 7ef6d73bffd3, executor 7c93d220, settingsHash 42a6068e}`, `broker {source broker, position {side FLAT, qty 0}, workingOrders []}`, `requests.lastAck {id f-flat1, type flatten, result APPLIED}`. Full snapshot: `$S/botfix/snapboot/run2/final-snapshot.json`.

## NEXT (dropped at the 05:58Z deadline; helpers kept in lib/phoneSnapshot.js, not wired)
- per closed trade: exitReason (+exitCode) from trade_manage codes (`exitReasonOf`, `indexJournal`), grossUsd / feesUsd / commissionsUsd / netUsd / fillIds (`moneyOf`, `noteFills`);
- `checklist.evaluatedAt`;
- news gate state `{loaded, eventsNext, blocking}` (`newsGateView`), behaviour unchanged (fail-open);
- `balanceReadAt` (`brokerReads.balanceReadAt` is ready).

## Limits
- The wake runs one extra main-loop pass per phone request (same code as the 20 s pass; same broker reads).
- `broker.readAt` is null until both a position and an order read have happened; orders while flat can be up to ~1 min old.
- Merge: hooks are one-liners; the flatten block in the main loop changed (take/ack around the unchanged `flattenNow()` call), so desk A's edits there need a hand merge.
