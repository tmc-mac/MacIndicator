# edge r1.1: rule visibility, scorecard, shadows (record only) + 4 reviewer fixes

Built on edge r1 (25d4c91, executor 9f8bcb8c). Branch `edge11`, local commits only. Node 18.19.1, nice 19. No replay rig, no soak (brief).

| Commit | What | Order flow |
|---|---|---|
| f6f1df3 + 045d37d | record and report only: snapshot fields, rule facts per trade, scorecard, early-exit shadow, ATR-sized TP1 shadow | none (`lib/liveStateMachine.js` untouched by these two) |
| c5dd62b | reviewer fixes S1, S2, S3 and the warm-up alert floor (MacArthur's addendum) | the only order-flow changes: cancels and one expiry, listed in section 3 |

Executor sha8: **dd2fdc4a** (sha256 of `live-executor.js`, first 8; edge r1: 9f8bcb8c).

## 1. Record-only work (Mac's approved set, 11/11)

New file `lib/scorecard.js`. It has no broker access: its only `require` is `fs`, and a test asserts that no order, fetch or token name appears in it.
It is fed three things the bot already has: journal rows, the poll's price and 1m bars, and the broker round trips read for Recent Trades. No new broker call.

**A. Deferred snapshot fields, now wired.** Per closed trade (`recentTrades[]`): `exitReason`, `exitCode`, `grossUsd`, `feesUsd`, `netUsd`, `ptsPerContract`.
`current.checklist.evaluatedAt`. `news.loaded / nextEvents / blocking / blockingWhat` (added inside the existing `news` object; the gate itself is untouched). `balanceReadAt`.

**B. Rule visibility.** `snapshot.rules` (settings, `sessionNow`, `atr15Now`, `atr15Median20d`, `runnerNow`, the shadow's config) and a `rule` object on every `recentTrades[]` row and on `position`.

**C. Scorecard.** `snapshot.scorecard`, kept in `scorecard-<SYMBOL>.json` beside the bot (tmp + rename). It counts from this build's first start (`since`) and survives restarts.
A corrupt or wrong-shaped file is renamed `…corrupt-<time>`, a new scorecard starts, and a `scorecard_state` row is journaled. Nothing in it can throw into the poll.
- Money is always the broker's round trip. A trade with no broker match yet is in the counts and in no USD field.
- Early-exit shadow: after a fired exit the bot keeps reading the price it already polls. Result when the original stop or TP1 is touched, or `unresolved` after 30 minutes, a price gap over 3 minutes, or a new trade. Row: `early_adverse_shadow`.

**D. ATR-sized TP1 shadow.** Config `tp1AtrShadow: { mode: 'log', atrMult: 0.75, minPts: 15, maxPts: 60, beAfterPts: 15 }`. For every trade seen from its fill with an ATR15:
shadow TP1 = clamp(0.75 x ATR15, 15, 60). Two variants: (i) the plain stop, (ii) the stop at entry once +15 was seen. Tracked past the live close until both variants have an outcome,
240 minutes pass, or the session close time arrives. Rows: `tp1_atr_shadow` `open` at the fill and `resolve` when the record is complete (the live exit reason and broker net beside the shadow result).
Mode `off`: no row, no shadow state, the snapshot says `{ mode: 'off' }`.

**E. Startup line.** `[score] scorecard since <ISO time> ; tp1 ATR shadow: LOG (...)` / `off`.

Shapes: scratchpad `edge2/SNAPSHOT-CONTRACT.md` (with its dated notes). Samples: `edge2/sample-snapshot.json` (the real boot snapshot, flat) and `edge2/sample-trades-synthetic.json` (invented trades through the real code).

## 2. New config key (the rollback must strip it)

| Key | Shipped | Bad value |
|---|---|---|
| `tp1AtrShadow` (`mode`, `atrMult`, `minPts`, `maxPts`, `beAfterPts`) | `{ mode: 'log', atrMult: 0.75, minPts: 15, maxPts: 60, beAfterPts: 15 }` | the bot does not start: enum check on `mode`, unknown sub-key refused by the config-local loader, numbers checked at startup (`tp1AtrShadow is unusable: ...`) |

It is the only new key. edge r1 refuses an unknown key, so a rollback to edge r1 must remove `tp1AtrShadow` from `config-local.json` if it was ever put there (it is not needed there: the default is in the executor).
New file on disk: `scorecard-<SYMBOL>.json` (edge r1 ignores it; safe to leave or delete).

## 3. Reviewer fixes (commit c5dd62b): the only order-flow changes

| Fix | Change | What the bot can now do that it could not |
|---|---|---|
| **S1a** halted with an ATR runner open | `tick()` on a halted machine calls `_haltedAtrRunnerStep()`. Position open: the TP2 limit is cancelled (verified), the stop is kept, one urgent push names both. | cancel its own TP2 limit while halted |
| **S1b** one of the pair filled while halted | Account flat on two polls in a row: the orders this trade placed that still work (by saved id) are cancelled. One flat read, or an unreadable broker, changes nothing. When the bot is running (not halted) the existing `_atrRunnerClosed` already cancels the other order in the same poll (edge1 tests B3, B4; unchanged). | cancel its own leftover stop while halted and flat |
| **S1c** startup on a flat account | `sweepSavedOrphans()`: after the startup reconciliation finds no position, two flat reads, then working STOP / LIMIT orders whose ids are in the saved trade state are cancelled. Other orders are never touched. Row `orphan_sweep`, one push. | cancel orders at startup, only its own |
| **S2** early-exit send age | `EAE_SEND_MAX_MS = 60 s`. A decided exit whose market order has not gone out (no exit intent on disk, no send counted, the stop still tracked, before TP1) expires: `early_adverse_exit` row with `result: 'expired'`, `EARLY_ADVERSE_ABANDONED`, nothing sent; np1 and level-loss own the trade again. The same rule on restore. An exit that already went out is still driven to its end by the safe-exit rule. | nothing new; it now does NOT send a stale exit |
| **S3** `pxBoundaryAt` | the statement is in front of the comment again (`restoreFromState`). | the runner trail, smart hold and TP2 put-back work again on a restored trade with no fill time |
| **Warm-up alert** | `HA.WARMUP_MIN_BARS = 1200`; "cut short" fires only under 1200 15m bars; text reworded. The bar request is unchanged. | no false alarm on the normal 1371-bar start |

The `[eae]` startup line gained "; a decided exit not sent within 60 s expires".

## 4. Tests (this tree; edge r1 = `botfix/repo` at 25d4c91)

| Suite | edge r1 | edge r1.1 |
|---|---|---|
| tests/edge1-tests.js (base r1.1 tree) | 79/79 | **79/79** |
| exitsafe-tests.js | 63/63 | **63/63** |
| test/phone-snapshot.test.js | 12/12 | **15/15** (12 unchanged + 3 new: exit reasons, superset, wiring) |
| test/scorecard.test.js (new) | - | **15/15** |
| tests/health-alerts-tests.js | 28/28 | **28/28** (the warm-up test rewritten for the 1200 floor) |
| c5-tests.js (CL = config-off) | 25/25 | **25/25** |
| r11-tests.js | 42/42 | **42/42** |
| qa-tests-r11.js | 43/43 | **43/43** |
| reviewer's file, as written | 19 pass, 2 fail (S3) | cannot finish: R1 takes the orphan stop from the broker and the stop is no longer there |
| reviewer's file, expectations updated (`botfix/edge11-tests/review-edge1-tests.js`) | - | **26/26**: R1, R2, R2b now assert the safe behaviour; R4, R5 pass unchanged; the other 16 pass unchanged; 5 new (R1c, R1d, R1e, R1f, R2c) |

`test/scorecard.test.js` covers: config fail-closed, the TP1 shadow in both variants (stop / TP1 / break-even, stop-first inside a bar, the fill minute's bar ignored), unresolved (240 min, session close, another trade, price gap),
the early-exit shadow (stop, TP1, 30-minute timeout), every early-exit class, the scorecard arithmetic, unmatched broker money, the state file across a restart, 8 kinds of corrupt file, mode `off`, and "no broker access".

**Decision identity.** `botfix/edge11-tests/edge1-identity.js` is the edge1 script plus a recorder. It writes every broker order event, journal row and alert of every scenario (55 machines, 41 broker event lists).
Run on edge r1 and on edge r1.1 (same base): **0 lines differ** (`identity-diff.txt`, timestamps normalised). So on the edge1 script, order events and decision rows are identical to edge r1, fixes included.
Expected differences, all outside that script and all from section 3:
1. a HALTED machine with an ATR runner cancels its TP2 limit, or its leftover order once flat (reviewer R1, R1c);
2. a flat startup with a saved trade cancels that trade's working orders (R1e);
3. a decided early exit older than 60 s that was never sent is not sent (R2, R2b), with its `expired` row;
4. a restored trade with no fill time gets `pxBoundaryAt`, so the runner trail / smart hold / TP2 put-back act (R4, R5);
5. the warm-up alert does not fire between 1200 and 1999 bars; the `[eae]` line text.
The executor's record-only hooks add journal rows of new types only (`tp1_atr_shadow`, `early_adverse_shadow`, `scorecard_state`); they run after every exit step of the poll.

## 5. Boot (60 s, fake broker, Node 18.19.1, nice 19, the edge r1 boot's config-local)

Exit 0 on SIGINT, 0 error / exception / FATAL lines, reached the live loop. Output: scratchpad `botfix/edge11boot/out.txt`.
```
[eae] early adverse exit: ON (... decided within 45 s of it, else unassessed; a decided exit not sent within 60 s expires)
[score] scorecard since 2026-11-11T03:16:46.800Z ; tp1 ATR shadow: LOG (TP1 = 0.75 x ATR15 at the fill, 15-60 pts; plain stop and stop-to-entry after +15; journal rows only, no order is ever sent or changed)
Startup reconciliation: no existing open position found — starting FLAT.
```
- Snapshot against the edge r1 boot snapshot: 0 keys missing; added `rules`, `scorecard`, `balanceReadAt`, `edgeFields`, `news.loaded / nextEvents / blocking / blockingWhat`, `current.checklist.evaluatedAt`.
- Restart on the same folder: `since` kept. Also booted: `mode: 'on'` and an unknown sub-key refused by the config-local check; `atrMult: -1` and `minPts: 80` refused at startup; `mode: 'off'` prints `tp1 ATR shadow: off`, no shadow row.
- "Warm-up cut short" fired in the boot (600 bars from the fake broker, under the 1200 floor), as it should.
- The boot was flat: no trade ran through the executor hooks. Their logic is unit-tested; the wiring itself (the poll hook, the broker-money hook, the per-row fields) has only been exercised with zero trades.

## 6. Limits

1. **Not run:** replay rig, soak, Mac-box run, restart soak, trade witness, install path. The ship gate (reviewer desk) is owed before this reaches Mac.
2. **The executor wiring has not seen a trade.** A fake-broker run with a scripted fill is the natural next check for the reviewer desk; the unit tests drive the module, not the executor.
3. **Shadow prices are the bot's polls**: completed 1m bars (high / low) that start after the watch began, plus one price per poll. A touch inside the fill minute or between polls of a forming bar can be seen one bar late. A bar that touches both levels counts as the stop.
4. **TP1 shadow money is a model**: all contracts leave at the outcome, minus the configured cost; no runner. It understates a shadow win in the runner sessions. The live figure beside it is broker net of the same trades.
5. **"Another trade opened" ends a pending shadow as unresolved** (brief). In busy sessions this will cut many shadows short; the count is visible (`unresolved`).
6. **Break-even variant, same observation:** the stop moves to entry from the observation after +15 was seen, so a single bar that prints +15 and then the entry is not a break-even exit.
7. **`estSavedUsd`** values the TP1 case with all contracts at TP1 and ignores costs (equal on both sides). It is an estimate and is labelled so.
8. **A trade the bot never saw open** (filled and closed inside one poll, or closed while the bot was down) is not in the scorecard. A trade first seen past TP1 gets no TP1 shadow.
9. **Broker money is matched only by a unique journal match** (the Recent Trades rule). Ambiguous or manual trades stay unpriced; after 6 hours they are counted in `moneyMissing`.
10. **`reached30BeforeEntry`** uses poll prices and completed 1m bars while the trade is open.
11. **Fix S1 uses broker reads while halted** (one position read and one order read per poll, only while an ATR runner is tracked and not yet cleaned up). A halted bot with any other trade is unchanged.
12. **Fix S1c covers a flat start only.** A restart with a position still open and a saved state marked desynced is adopted as before.
13. **Fix S2 does not expire an exit whose protective stop is no longer tracked** (cancelled during a started exit): that exit continues on the safe-exit rule, because abandoning it would leave the trade without a stop.
14. `fillIds` and `commissionsUsd` (helpers exist) are not sent: not in the approved set.

## 7. Reviewer follow-ups (after the SHIP verdict; one commit; the state machine only, the executor is unchanged: sha8 dd2fdc4a)

| Follow-up | Change |
|---|---|
| 1. Flat-startup sweep | The two position reads are `sessionConfirmMs` (1 s) apart. Both must succeed and both must show flat, and the order list must be readable. Anything else: nothing is cancelled and an `orphan_sweep` row with `result: 'skipped'` is written (a sweep that ran has `result: 'swept'`). |
| 1b. HALT cleanup | Not changed: its two flat reads are always on different polls (20 s apart), never in the same poll. |
| 2. TP1 after an expiry | If no TP1 limit is tracked when an early exit expires, it is put back once at its original price and quantity through the reject flow's `_exitPutTpBack`. A TP1 found resting is adopted, never doubled. An unreadable order list = retried next poll. Row `EARLY_ADVERSE_TP1_BACK`. After an expiry found on restore, this runs on the first poll. |
| 3. Push | One push per expiry: "Early exit not sent (broker did not answer in 60 s); trade back on its stop and TP1". |

Tests: builder's copy of the reviewer file **29/29** (3 new: R1g, R2d, R2e). The reviewer's phase-2 file on this tree: **14 pass, 1 fail** (F3a and F4d-2 now pass; F2b still fails as written:
two wrong flat reads on two polls while halted cancel the runner's stop; not in this follow-up).
Identity recorder against edge r1 on the edge1 script: still 0 lines differ. Expected differences are these three only, all outside that script.
