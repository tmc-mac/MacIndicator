# Edge r1.1 review (branch edge11, HEAD 7ca3a99, executor dd2fdc4a)

Reviewer desk. Package `botfix/pk/MacBot-edge-r1.1.zip`, unzipped fresh; its code files are identical to the branch HEAD.

## Verdict: SHIP, with two witness criteria not met
Nothing I found can place a wrong order or leave a normal trade without a stop. The three fixes close my repros. The record-only parts send no order. The install path passes.

Two of the trade-witness criteria could not be shown on the single authorised run:
1. **Trade rows in the snapshot (`exitReason`, `rule`, money) were not witnessed.** The rig's fake broker returns no fill history (`rbroker.cjs:195`), so `recentTrades` is empty on every rig run, on any build. The scorecard's broker-money hook is unwitnessed for the same reason.
2. **The ATR runner path (stop +2, TP2 placed) was not witnessed.** The one NY trade in the window was closed by the early exit before TP1.

Both are covered only by unit tests. The first is display only and every hook is wrapped so a failure drops fields, not orders. The second is edge r1 code that is already live. One more 20-minute run would close the second; the first needs a rig broker that serves fills. Not run in this phase: Mac-box run, restart soak.

## 1. The fixes (commit c5dd62b)

| Fix | My repro | Result on r1.1 |
|---|---|---|
| S1 halted or dead bot, NY runner | R1 | closed: TP2 limit cancelled while halted, the stop kept (F1); flat startup sweeps the saved ids (F3c) |
| S2 stale early-exit send | R2, R2b | closed: expires after 60 s, no order (F4a); the session close still flattens afterwards (F4b) |
| S3 `pxBoundaryAt` | R4, R5 | closed: both pass unchanged in the builder's copy of my file (26 of 26) |
| Warm-up alert | n/a | floor 1200; the witness logged "warm-up OK" |

Answers to the three questions:

**Can the HALT cleanup cancel a protective stop on a live position?** Only if the broker reports the account flat on two polls in a row while the runner is in fact open.
- With the position reading open, it cancels the TP2 limit and never the stop (F1, six polls).
- One wrong flat read changes nothing (F2a). Two wrong flat reads cancel the stop and nothing re-protects it (F2b fails, as written to).
- This is no looser than the running bot, which resets and cancels every order on a single zero read (`lib/liveStateMachine.js` LEG23 branch, `_atrRunnerClosed`). An unreadable position changes nothing.

**Can the flat-startup sweep cancel an order on a wrong or lagging position read?** Yes, on a wrong flat read.
- It reads the position twice, but back to back with no wait (`sweepSavedOrphans`; F3a fails, as written to). The session close waits 1 s before its confirming read (`sessionConfirmMs`). Two reads milliseconds apart are not independent.
- With a wrong flat read at startup the saved stop and TP1 are cancelled on an open 3-lot (F3 info line).
- Position open, or unreadable: nothing is cancelled (F3d, F3e). Orders the bot does not own are left (F3c).
- Recommended follow-up: wait `sessionConfirmMs` between the reads, and sweep only when the saved phase is an open phase.

**Is the S2 exception safe?** Yes. An old decision is not expired when the stop is no longer tracked; the exit then goes out (F4c). The alternative is a position with no stop.
- One gap beside it: if a started exit could not cancel the stop and the TP1 put-back was rejected, the expiry leaves the trade with its stop but no TP1 limit, and nothing re-places it (F4d-2 fails, as written to). It needs two broker refusals in the same poll. Follow-up: re-place TP1 on expiry, or do not expire while TP1 is missing.
- The expiry sends no push. Mac was told "Closing … confirming shortly" and gets no word that it was abandoned. Follow-up: one push.

None of these three follow-ups holds the ship.

## 2. Record-only parts

**Order call sites.** In all added lines of `live-executor.js` and `lib/`:
- `cancelOrder` twice, `getOpenPosition` twice, `getOpenOrders` four times, all inside the two S1 functions.
- No `placeOrder`, no stop or target placement, no flatten, no fetch.
- `lib/scorecard.js` requires only `fs`. Its executor hooks are `load`, `indexJournal`, `onPoll`, `onBrokerTrades`, `view`, `ruleOf`.

**Decision identity.** I ran the builder's recorder on the edge r1 tree and on r1.1 myself and compared: 4,991 values across 96 records, 0 differ (40 market orders, 90 resting orders, 84 cancels in the trace). This covers the order machine, not the executor.

**No new API calls on the normal path.** The only new broker reads are in the halted-runner step and in the startup sweep, and the sweep returns before any broker call when the saved state tracks no order.

**State file.** Six kinds of corrupt file each start a new scorecard, keep the old file as `.corrupt-<time>`, and journal `scorecard_state` (F5b). Garbage inside a shape-valid file never throws from load, poll, broker trades, view, `ruleOf` or `indexJournal` (F5).

**Snapshot superset.** Against the edge r1 boot snapshot the witness snapshot is missing 0 keys at any depth. Added: `rules`, `scorecard`, `balanceReadAt`, `edgeFields`, the four `news` keys, `checklist.evaluatedAt`.

**Suites re-run on Node 18.19.1:**

| Suite | Result |
|---|---|
| edge1-tests | 79/79 |
| exitsafe | 63/63 |
| r11-tests | 42/42 |
| qa-tests-r11 (base pkg-A47) | 43/43 |
| scorecard | 15/15 |
| phone-snapshot | 15/15 |
| health-alerts | 28/28 |
| builder's copy of my file | 26/26 |
| my phase-2 file | 12 pass, 3 fail (the three findings above) |

I did not re-run c5-tests.

## 3. Trade witness (one run)
Rig `qa-exit5/rp/h2c-n18`, real bars, 11/02 14:10–15:25Z (75 simulated minutes), `qa-sizecap/rp/config-live.json`, package tree, Node 18, nice 19, one process, about 5 minutes. Exit 0. No error, exception or failed-step line in the log.

| Trade | What the fake broker saw |
|---|---|
| 14:22Z London SHORT 3x @ 28752.75, `allAtTp1` | stop 3x @ 28782.75, TP1 **3x** @ 28737.75; TP1 filled 14:27; stop cancelled; flat |
| 14:46Z NY SHORT 3x @ 28702.50, `atrTarget` (ATR15 57.07, TP2 28588.25) | stop 3x @ 28752.50, TP1 2x @ 28687.50; early exit at 14:49 (−24 pts at the 1m close, best +0): TP1 and stop cancelled, one market BUY 3 @ 28725; flat |

| Criterion | Result |
|---|---|
| Trades open and close | Pass (2) |
| `runner_rule` rows | Pass (2: london `allAtTp1`, ny `atrTarget`) |
| Scorecard rows | Pass: `early_adverse_check`, `early_adverse_exit`, `early_adverse_shadow` |
| `tp1_atr_shadow` rows | Pass for `open` (2). No `resolve` row: it waits for broker money, which this rig never supplies |
| Snapshot trade rows carry `exitReason` and `rule` | **Not witnessed** (rig broker has no fill history) |
| `scorecard-MNQ.json` updates | Pass: 2 records, counts right, `since` set at start |
| No errors | Pass |
| NY trade reaching TP1 (ATR runner) | **Not witnessed** |

One thing Mac should see, n = 1: the early exit closed the NY short at −24, and the shadow then recorded that the trade's original TP1 (+15) was touched before its stop. The scorecard shows `wouldHaveHitTp1: 1`. This is what the scorecard is for; one trade proves nothing.

## 4. Install path
Fresh unzip, fake `systemctl` / `journalctl` / `sleep`, bot dir = a copy of the edge r1 tree plus a config-local, a state file and a journal.

| Step | Result |
|---|---|
| Install over edge r1 | DONE, stamp dd2fdc4a; 4 files changed, 1 added (`lib/scorecard.js`); every other file unchanged |
| Second install | Refused at step 2 ("not exactly the edge r1 build"); nothing changed; no service call |
| Rollback with `tp1AtrShadow` in config-local | Key stripped (copy kept in the backup); stamp 9f8bcb8c; every file byte-identical to before the install, config-local included |

The only leftover is `scorecard-MNQ.json`, which edge r1 ignores. Cosmetic: the installer's header and two messages still say "capped-sizing tree" and "botfix".

## Files
- Tests: `review/tests/review-edge11-fix-tests.js` and `.out`
- Witness: `review/rig/witness/` (bot.log, trace.jsonl, tree with journal, snapshot, scorecard)
- Install: `review/inst/` (install1.out, install2.out, rollback.out, pre/post sums)
