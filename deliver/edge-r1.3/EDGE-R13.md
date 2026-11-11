# edge r1.3: the start-up memory fix, the owner flag (record only) and three edge r1.2 review fixes

Base: edge r1.2 (`0b53d2a`). Branch `edge13`. No new config key. `lib/liveStateMachine.js`, `lib/liveOrders.js` and every exit / entry module are byte-identical to r1.2.

## 1. What changed

| File | Change |
|---|---|
| `lib/journalLines.js` (new) | The start-up memory fix (section 10): chunked line reader + the shared start-up scan. Six journal readers and the replay-file reader in `live-executor.js` use it. |
| `lib/ownerFlags.js` (new) | The whole feature: the queue folder, validation, the rate limit, the journal row, the flags per trade, the proxy-side `enqueue`. Requires only `fs`, `path`, `crypto`. |
| `live-executor.js` | Creates the module; reads the queue on every main-loop pass and on every ~3 s sleep step; seeds it from the journal at startup; adds `capabilities.flag` and `flags` to the snapshot; `ownerFlagFacts()` copies the trade facts. F1 and F4 wiring (section 6). |
| `lib/phoneRequests.js` | A `flag` ack writes no journal row and no log line; `appliedAt.flag`; at most 5 flag acks in `recent`. `flattenReadGuard` (F1), the F3 text, `followCheck` with `brokerFlat` (F4). |
| `tmc-proxy.js` | New route `POST /flag`. **The proxy must be restarted at install**, and restored + restarted on rollback. |
| `test/owner-flag.test.js` (new), `test/phone-snapshot.test.js` | 19 new tests; one source-check line updated for F1. |

Why the proxy changed: the request channel has one route and one file per request type (`/flatten`, `/pause`, `/cancel-entry`); there is no generic route a new type could pass through. The new route is the minimum: it queues a file and does nothing else.

## 2. Request

The page posts to the proxy (same proxy key as `/flatten`):

```
POST /flag?symbol=MNQ            Content-Type: application/json
{ "id": "tap-7f3a91", "trade": "0b9c6a52-5d0e-4a8e-9a57-2f6d1c0e7b11", "reason": "stopped_then_worked", "note": "ran 40 pts after the stop" }
-> 202 { "success": true, "outcome": "requested", "requestId": "tap-7f3a91", "requestedAt": 1794378566860 }
```

- Fields may also be query parameters (`trade=`, `reason=`, `note=`, `id=`); the JSON body wins. Body limit 4 kB (413 above it). A body that is not a JSON object: 400.
- `id` is optional (1 to 80 characters of `A-Z a-z 0-9 . _ : -`). Send the same `id` when retrying the same tap: the bot then writes one row. Without it the proxy makes one (`g-` + 16 hex).
- `trade`: the trade row's `journalId` (`recentTrades[].journalId` / `whyJournalId`, `levels.trade.open.journalId`, `levels.trade.today[].journalId`). 1 to 120 printable characters, no spaces. For a missed move with no trade, send any id of the page's choice (for example `none` or a level event id): it is journaled with `tradeKnown: false`.
- `reason`: `stopped_then_worked` | `bad_entry` | `exit_too_early` | `missed_move` | `good_trade` | `other`.
- `note`: optional text, at most 280 characters.
- 429 `QUEUE_FULL` when 40 requests are waiting unread (the bot is down).

What the proxy writes, and the bot reads: `owner-flag-MNQ/<id>.json` =

```json
{ "type": "flag", "id": "tap-7f3a91", "requestedAt": 1794378566860, "trade": "0b9c6a52-5d0e-4a8e-9a57-2f6d1c0e7b11", "reason": "stopped_then_worked", "note": "ran 40 pts after the stop" }
```

## 3. Ack

In the snapshot, `requests.lastAck` and `requests.recent[]`, matched by `id` (same shape as every other ack):

```json
{ "id": "tap-7f3a91", "type": "flag", "requestedAt": 1794378566860, "receivedAt": 1794378567145, "at": 1794378567147, "result": "APPLIED", "reason": "flag recorded: stopped_then_worked" }
```

A refusal is `result: "REJECTED"` with `reason` starting with one code:

| Code | When |
|---|---|
| `BAD_REASON` | reason missing or not one of the six |
| `BAD_TRADE` | trade id missing, over 120 characters, or containing spaces / control characters |
| `NOTE_TOO_LONG` | note over 280 characters |
| `BAD_NOTE` | note is not text |
| `STALE` | read more than 60 s after `requestedAt` (the same limit as flatten / pause / cancel), or no request time |
| `FUTURE_TIME` | `requestedAt` more than 60 s ahead of the bot clock |
| `RATE_LIMIT` | 20 flags already recorded in the last 60 minutes |
| `BAD_ID`, `BAD_TYPE`, `MALFORMED` | a file the proxy would not write |
| `JOURNAL_WRITE_FAILED` | the row could not be written; nothing recorded, the same id can be sent again |

A stale flag answers `REJECTED` with `STALE: ...` (the brief asks for REJECTED; flatten / pause use the result `STALE`). A refused flag writes no journal row at all (no `phone_request` row either).

Timing: the bot reads the queue about every 3 s (measured on the boot: all four acks in the snapshot 0.5 s after the files were written). A flag never wakes or shortens the main loop.

Idempotence: an id already answered gets the same `result`, `reason` and `requestedAt` again and no second row. Accepted ids come back from the journal at startup, so this holds across a restart. A `RATE_LIMIT` or `JOURNAL_WRITE_FAILED` refusal is not remembered, so that id can be sent again later.

## 4. Journal row

Exactly one row per accepted flag, appended to `trade-journal-<SYMBOL>.jsonl` (file only: it never enters the in-memory journal history or any trade index):

```json
{ "type": "owner_flag", "t": 1794378567145, "requestId": "tap-7f3a91", "requestedAt": 1794378566860, "trade": "0b9c6a52-5d0e-4a8e-9a57-2f6d1c0e7b11",
  "reason": "stopped_then_worked", "note": "ran 40 pts after the stop", "tradeKnown": true,
  "tradeFacts": { "source": "broker_round_trip", "session": "ny", "side": "SHORT", "level": "IB High", "entry": 28752.75, "exit": 28740.5, "exitReason": "STOP",
                  "netUsd": -151.83, "closed": true, "contracts": 3, "entryTime": 1794370920000, "exitTime": 1794371400000 },
  "stampId": "488bb86e9fc0" }
```

- `tradeFacts.source`: `broker_round_trip` (the trade is in the broker round trips the bot read: every field filled), `open_trade` / `journal_entry` (only the journal's entry row or the open trade is known: `exit`, `netUsd` are `null`), `resting_entry`.
- No trade matches the id: `"tradeKnown": false, "tradeFacts": null`. The flag is still journaled.
- `note`: plain text. Line breaks and tabs become one space; control and invisible format characters are removed; `null` when empty. It is not HTML-escaped: a page that shows it must escape it.
- The example's `tradeFacts` values are illustrative (the fake-broker boot serves no fills). The row shape is the real one.

## 5. Snapshot

- `capabilities.flag` (new top-level key `capabilities`; none existed): `{ "reasons": [six], "maxNote": 280, "maxPerHour": 20, "maxAgeMs": 60000, "usedThisHour": 2, "keepPerTrade": 3 }`. Absent on an older bot: the page hides the button.
- `flags: [{ t, reason, note }]` on every trade row (`recentTrades[]`, `levels.trade.open`, `levels.trade.today[]`): the last 3 flags on that trade, oldest first, `[]` when none. Rebuilt from the journal at startup.
- `requests.appliedAt.flag`: epoch ms of the last accepted flag.
- `requests.recent` holds at most 5 flag acks of its 10, so flags cannot push a flatten ack out. `lastAck` can be a flag ack: match acks by `id`.

## 6. edge r1.2 review fixes (`review/edge12/EDGE-R12-REVIEW.md`)

**F1 (urgent push on every pass).** Failed broker position reads are now counted per flatten request id (`flattenReadGuard`), and cleared only by a pass that got its answer. The reset after `flattenNow()` is gone.
- One urgent push per request id, however many passes. One `PENDING` ack per id (before: one per pass).
- Flat bot, only the "already flat?" read fails: after 5 failed reads the request is acked `REJECTED BROKER_UNREADABLE: check TopstepX ...` and not requeued.
- **Deliberate difference from the addendum:** when `flattenNow()` itself cannot read the position (the bot may hold a position and an exit may be needed), the request is still kept and retried every pass without limit, exactly as in r1.1 / r1.2. Giving up there would drop a flatten of an open position, which would change when an exit order is sent. It also gets one push per id (before: attempt 1 and every 5th).
- Timing: a requeued flatten is retried on the normal main-loop pass (about 20 s), so 5 reads is about 100 s, not 15 s.
- `flattenNow` is untouched and is called exactly as before.

**F3 (wording).** A halted bot with a resting entry now answers `REJECTED`, `HALTED: flatten in TopstepX - the bot is halted by its exit-safety rule; the resting entry was cancelled (phase now FLAT), no exit order was sent` (or `... a verified cancel of the resting entry was requested and is not confirmed yet ...` while the phase is still PENDING_ENTRY). Other halted answers are word for word as before.

**F4 (false follow-up).** No follow-up ack when the flatten completed: the bot is flat AND a broker position read made after the request shows no position. A halt with phase FLAT but no such broker read still answers `REJECTED`, with the text `the bot halted and the broker position is not confirmed flat` (r1.2 said "halted before the position was flat", which could be false).

## 7. Zero trading effect

(a) Decision identity on the existing trace script (`botfix/edge11-tests/edge1-identity.js`): see section 8.

(b) Every reader of the new state:

| New state | Readers |
|---|---|
| `owner-flag-<SYMBOL>/` files | `ownerFlags.process()` only. `phoneReq.pendingNew()` (what wakes the main loop) does not look at the folder (tested). |
| `owner_flag` journal rows | Startup seed -> `ownerFlags.indexJournal()` only (the seed loop skips them before `indexTradeEvent`, so the scorecard, exit and why indexes never see one). Written with `persistJournalMeta` (file only), not `appendJournal`: never in `journalHistory`, so it cannot evict a row a decision reads. |
| The module's memory (flags per trade, answered ids, the hour's count) | `capability()`, `withFlags()`, `withPanelFlags()`: called only where the snapshot object is built. |
| Flag acks | `phoneReq.view()` -> snapshot. `appliedAt.flag` is a new key; no code reads `appliedAt`. |
| `ownerFlagFacts()` | Reads display lists (broker round trips already read, the journal entry index, the journal contexts); writes nothing; called only from the flag handler. |

`grep -n "ownerFlag" live-executor.js` lists 11 lines: the instance, the hooks, the seed, `capabilities`, the facts function, the step function, the row flags, the panel flags, and three call sites of `ownerFlagStep` (main loop, both sleep paths). None is inside an order, gate, size, stop or target path; a test pins this list. No file under `lib/` other than `ownerFlags.js` and `phoneRequests.js` mentions the feature. From the sleep step, a handled flag rewrites the snapshot (the same call the day tracker already makes there); with no flag waiting, the step is one directory read.

## 8. Tests

`botfix/edge13-tests/run-all.sh`, Node 18.19.1, nice 19, one suite at a time, all exit 0:

| Suite | Result |
|---|---|
| journal-lines (new, piece B) | 7 pass, 0 fail |
| owner-flag (new) | 19 pass, 0 fail |
| phone-snapshot | 24 pass, 0 fail (one source-check line updated for F1) |
| fetch-retry | 10 pass |
| scorecard | 18 pass |
| health-alerts | 28 passed |
| edge1 | 79 passed |
| exitsafe | 63 passed |
| r11 | 42 passed |
| qa-r11 | 43 passed, findings 0 |
| c5 | 25 passed |
| review-edge1 | 29 passed |

Counts of the existing suites are the same as on r1.2.

Decision identity: the edge1 trace script on this tree and on r1.2 (`0b53d2a`): **entries 96 / 96, differing 0** (timestamps, uuids and tmp paths normalised). The script drives the real order machine and lib modules against the stateful fake broker; it does not run the executor's main loop, so for the loop the argument is 7(b) plus the boot. New: `test/owner-flag.test.js`, 19 tests (acceptance 2, 3, 4, 5, 7, the proxy route on loopback, F1 with 30 passes, F3, F4).

Boot (fake broker, 1 process, about 30 s, `botfix/edge13boot/result.json`): live loop entered, exit 0, no error line; `capabilities.flag` in the snapshot; 4 flag files -> 2 new `owner_flag` rows, 1 `REJECTED BAD_REASON`, 1 duplicate of an id journaled before the start answered `APPLIED` with no new row; 0 `phone_request` rows; queue empty; no main-loop wake.

## 9. Limits

- 20 accepted flags per rolling 60 minutes (rebuilt from the journal after a restart). Note 280 characters. Request age 60 s. 40 queued files at the proxy. 50 files handled per pass. Last 3 flags shown per trade. Refusal log lines capped at 10 per hour.
- Not run: the replay rig, a trade on the rig, the installer. The `broker_round_trip` branch of `tradeFacts` has not run inside the executor (the boot's broker serves no fills); the `journal_entry` branch has.
- F1's executor block is tested through a copy of its call sequence in the unit test, plus source checks; it has not run in a full process with an unreadable broker.
- The page is not changed (another desk). Until it posts to `/flag`, the feature is dormant.
- Rollback: no config key to strip. Restore and restart the proxy as well as the bot. An r1.2 bot ignores `owner_flag` rows and the `owner-flag-<SYMBOL>/` folder.

## 10. Start-up memory fix (piece B)

**Problem.** The executor read the whole trade journal with `readFileSync(...).split('\n')` in six places. A 98.7 MB journal is a 188 MB string; it was read five times at start-up, and two readers also kept every parsed row (113 MB each). At the server's 493 MB heap limit the bot died in the fourth read.

**Fix.** `lib/journalLines.js` (new): a synchronous chunked line reader (one 1 MB buffer, one line decoded at a time) and a shared scan.
- One pass over the journal at the first start-up reader (the trade-context seed). The same pass fills three small collectors for the later readers.
- Each later reader first reads only the bytes appended since (the journal is append-only), so it sees exactly the rows a fresh read of the file would give at its own moment, including rows the bot wrote in between.
- `plan` collector: the plan restore's own line filter and row test, unchanged.
- `reconcile` collector: the only rows the three reconcile readers use (`entry`, `peak_unrealized`, signal_check rows with a journalId). A line is parsed only when it contains `"journalId"` or is one of the two types. The reconcile functions themselves are unchanged and run on this list.
- `tp1` collector: the lines `journalShowsTp1` can use (adopt without saved state). `lib/liveStateMachine.js` is unchanged.
- No window is tightened: every collector covers the whole file. The confirmed-id and used-broker-key sets are still all-history.
- The collectors are released after the start-up backfill. The trade replay file is read the same way (it was capped at 96 MB, so up to a 190 MB string).

**Memory and time** (the ship-gate desk's rig and method: Node 18.19.1, pine config, real 2000-bar warm-up, 10 virtual minutes; one run each):

| Journal | Heap limit | r1.2 | r1.3 | Peak heapUsed r1.2 / r1.3 (MB) | Peak RSS r1.2 / r1.3 (MB) | s to live loop r1.2 / r1.3 |
|---|---|---|---|---|---|---|
| none | 493 | survives | survives | not run / 76 | not run / 311 | not run / 2.8 |
| 92.2 MB (real) | 1024 | survives | survives | 670 / 75 | 936 / 313 | 3.2 / 3.1 |
| 98.7 MB | 493 | dies (desk) | **survives** | 601 at death / 88 | 865 / 310 | 3.0 / 2.8 |
| 98.7 MB | 256 | dies (desk, 92 MB) | **survives** | - / 85 | - / 317 | - / 2.7 |
| 150 MB | 493 | dies (desk) | **survives** | 611 at death / 85 | 919 / 324 | 2.9 / 3.0 |
| 150 MB | 256 | not run | **survives** | - / 88 | - / 329 | - / 3.0 |

The r1.3 peak no longer depends on the journal size (311 MB RSS with no journal, 310 to 329 MB with 92 to 150 MB). The one pass over the real 92 MB journal takes 0.6 s on this machine, against 1.7 s for one old whole-file read.

**Identical results** (r1.2 package against r1.3, same rig, same journal; timestamps, the run path, the stamp ids and the lib hash line normalised):

| Journal | Journal rows written | Reconcile-step log lines | All log lines |
|---|---|---|---|
| real 92.2 MB | 27 / 27, 0 differ | 3 / 3, 0 differ | 86 / 86, 0 differ |
| 3 MB tail + a malformed line, a torn row, two CRLF rows, an orphaned pending row, an open-without-close trade, a last row with no trailing newline | 29 / 29, 0 differ | 6 / 6, 0 differ | 88 / 88, 0 differ |
| the same, last row cut mid-write | 29 / 29, 0 differ | 6 / 6, 0 differ | 88 / 88, 0 differ |
| empty file | 29 / 29, 0 differ | 3 / 3, 0 differ | 85 / 85, 0 differ |
| no file | 29 / 29, 0 differ | 3 / 3, 0 differ | 85 / 85, 0 differ |

Reader level, on the real 92.2 MB journal (`botfix/edge13-oom/sets-diff.js`): the seed's 27,165 rows, the plan restore's 2,209 rows, the reconcile readers' 2,799 rows and the 498 TP1 lines are deep-equal to what the old whole-file readers used.

**Tests.** `test/journal-lines.test.js`, 7 tests: a 2-, 3- and 4-byte character at every offset of small buffers; the lines equal `readFileSync + split` for CRLF, empty lines, malformed lines, no trailing newline, a line longer than the buffer, a BOM and invalid UTF-8; the collectors against the old readers on seven fixture files and a missing file; rows appended between readers (including a row appended straight after an unterminated one); a 36 MB file read with a 1 MB buffer and under 8 MB kept; a source check that no reader holds the journal or the replay file as one string.

**One deliberate difference.** A journal line that is exactly `null` made the old orphan check throw at start-up (an unguarded `ev.type`). The new reader skips it. Every other malformed line is skipped by both.

**Not covered.**
- `tmc-proxy.js` still reads the whole journal as one string on every `/signal-journal`, `/trade-why`, `/trade-blocks`, `/trade-stats` and `/trade-list` request (four `fs.readFile` calls). That is a separate process with its own heap; at 98.7 MB each request holds a 188 MB string. Not changed here.
- The plan restore and the orphan check found nothing to act on in the real journal, so their identical output there is "no line, no row"; the fixture runs exercise the orphan check and the open-trade reconcile. The broker backfill matched no fill (the rig serves no fill history).
- The adopt-without-state path (`tp1` collector) is covered at reader level and by a source check, not by a boot with an adopted position.
- The 98.7 and 150 MB journals repeat recent rows, as in the desk's runs. One machine; the 493 MB limit is set by flag.
