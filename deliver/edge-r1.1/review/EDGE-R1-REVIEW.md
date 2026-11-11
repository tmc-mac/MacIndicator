# Edge r1 (LIVE) adversarial review

Reviewer desk. Tree: `botfix/pk/MacBot-edge-r1/tree` (executor 9f8bcb8c). Code reading plus my own tests on the builder's fake-broker pattern. No replay rig, no soak, no Mac-box run.

## Verdict
**No BLOCKER. Leave both switches as they are.** I found three SHOULD-FIX defects. None of them can leave a normal trade without a stop, fire the early exit after TP1, or fire it twice. Two need an unusual state first (a HALT or a dead bot; failed broker reads or a restart at the wrong second). The third is a regression from botfix r1.1 that edge r1 inherited.

What I did not do: the ship gate (Mac-box run, restart soak, trade witness, install path). It is still owed for this build; the brief excluded it.

## Tests
- Mine: `review/tests/review-edge1-tests.js`, output in `review/tests/review-edge1-tests.out`. 21 checks: 19 pass, 2 fail. Both failures are defect S3. Three of the passes are defect repros (R1, R2, R2b): they pass because the defect reproduces.
- Builder's suite re-run on Node 18.19.1: 79 passed, 0 failed.

Run: `node review-edge1-tests.js <edge-r1 tree> <botfix repo> <tmpdir>`.

## SHOULD-FIX

### S1. A halted or dead bot with the NY runner open leaves an order that can open a new position
- **Where:** the ATR runner rests two closing orders with no link between them: the +2 stop and the TP2 limit (`lib/liveStateMachine.js:1305-1320`). The poll after one fills cancels the other (`:2061`, `:1330-1353`). A halted machine does not poll (`:1802`), and a start on a flat account sweeps nothing (`live-executor.js:4680`).
- **Repro (R1):** long runner, bot halted, TP2 fills. The 1x SELL stop is still resting on a flat account five polls later. When price comes back to entry +2 it fills and the account is short 1 with no stop.
- **Control (R1b):** the same halt with today's runner leaves no order, because that runner has one order, not two. So this exposure is new with `atrTarget`.
- **How likely:** it needs a HALT, a crash or a restart loop while an NY runner is open, then a move of 2 × ATR15 back to the other order before anyone cleans up. The halt alert tells Mac to resolve by hand, but its text names only the stop, not the TP2 limit.
- **Same class already exists before TP1** (TP1 limit plus the full-size stop). The builder's limit 6 names the no-OCO design but not the halt or bot-down case.
- **Fix:** on any halt with an ATR runner, cancel the TP2 limit (verified) so only the stop rests, and name both orders in the alert. At startup on a flat account, alert when working orders rest on the contract.
- **Switch, if Mac wants it off now:** `config-local.json` `{ "sessionRunner": { "ny": "live" } }`, then restart when flat. The overlay deep-merges (`live-executor.js:1700-1716`), so the other three sessions keep their values.

### S2. The early exit's decision has a 45 s limit, but its send has none
- **Where:** once `eaeState.decided === 'exit'` is saved, every later poll calls `sessionFlatten` with no age check (`lib/liveStateMachine.js:1209-1217`). `eaeRestore` (`:73-78`) restores an `exit` decision of any age.
- **Repro (R2b):** decision made on time; the next three broker reads fail, so the exit returns `retry`; 15 minutes later the reads recover and the bot sells 3 at market with the trade at +15.
- **Repro (R2):** an `exit` decision saved 40 minutes before a restart, never sent, is executed on the first poll after the restart with the trade at +12.
- **Why it matters:** the startup line and the doc promise "decided within 45 s, else unassessed, never a late exit". That holds for the decision only. A late send closes a trade the rule no longer describes.
- **How likely:** it needs failed position or order reads, a cancel that will not verify, or a restart, all inside the seconds after the decision. Rejected sends are already capped at 3.
- **Fix:** give the send a deadline (for example 60 s after `eaeState.at`); past it, mark the decision `abandoned`, journal it, and leave the trade to its stop.
- **Switch, if Mac wants it off now:** `{ "earlyAdverseExit": { "mode": "log" } }`. It keeps journaling `wouldExit` rows and sends no order.

### S3. Regression since botfix r1.1: a restored trade with no fill time never gets its price boundary
- **Where:** `lib/liveStateMachine.js:412`. The statement `this.pxBoundaryAt = Date.now();` sits after a `//` on the same line, so it is a comment. It was live code in the base and exitsafe builds and went dead in r1.1 (commit 8624b23); edge r1 appended to the same comment.
- **Effect:** `priceEvidenceOk` (`:1391-1394`) is false for the rest of that trade. The executor gates three things on it (`live-executor.js:6075-6076, 6088`): the runner trail, the smart-hold exit, and, for an ATR runner, putting back a missing TP2 limit.
- **Repro (R4, R5 fail):** restore a trade whose saved record has no usable fill time; ten minutes later `pxBoundaryAt` is `undefined` and `priceEvidenceOk` is false. With an ATR runner and a missing TP2 limit, six polls later no TP2 limit rests.
- **Who is hit:** a position the bot adopted (no fill time) and then restarted on. `pxBoundaryAt` is not saved either, so the adoption's own boundary is lost. A normal trade keeps its fill time across a restart and is not affected.
- **What still protects it:** the resting stop and the ladder audit, which is not gated. For such a trade the runner's stop stays where it was.
- **Fix:** move the statement in front of the comment. One line. No switch covers it.

## NOTES
1. **The early exit's clock starts when the bot first sees the fill, not when it filled** (`lib/liveStateMachine.js:1900`; R6). A resting entry that filled while the bot was down is resumed at startup (`:940-976`) and timed from the restart, and "never seen at +3" covers only the time since. np1 has always worked this way. The builder's limit 10 covers adopted positions but not this path.
2. **MFE excludes the rest of the fill minute.** Builder's limit 3; confirmed in `noteNoProgressPrices` (`:1144-1158`).
3. **No "shrank during the cancels" guard for the early exit.** np1 halts if the position shrinks while its orders are being cancelled (`:1570`); the early exit sells whatever is left. TP1 filling in those milliseconds with the trade at −10 is not a realistic case.
4. **The 1m close is judged against the VPS clock** (`lib/edgeExits.js:36`). The bar is fetched before the tick, so its close can be a second or two early. Negligible at a 10-point threshold.
5. **+2 stop refused at the scale-out** (builder's limit 7). R9b: the old stop is resized to 1x at its old level, and the ladder audit in the same poll moves it to entry +2 if the broker accepts. If the broker keeps refusing, the retry backs off up to 5 minutes (`:2667-2669`); the runner then sits on its original stop, never without one.
6. **allAtTp1 with a partial TP1, then the stop** (R3): recorded as a stop on the contracts that were left, not on all of them. Correct.

## Hunt list: what I checked and found clean
| Hunt item | Result | Evidence |
|---|---|---|
| Early exit after TP1 | cannot | `:1218` phase guard; R7a |
| Early exit twice | cannot | `eaeState` once per trade, `FLATTENING` returns `sent`; R7c |
| Early exit on an adopted position | cannot | `:1228`; R7b |
| Runner with no stop | not found | new stop first, verified cancel (`:2500-2513`); R9a |
| Runner stop worse than entry +2 for more than one poll | only while the broker refuses it | note 5; R9b |
| TP2 and stop both live after one fills | one poll when the bot runs; **unbounded when halted or down** | builder B3/B4; S1 |
| Session close with a runner open | both orders cancelled, one market order | builder B5 |
| Restart with a runner open | ATR15 and TP2 saved and kept | builder B7; exception S3 |
| allAtTp1, partial TP1 | stop resized, rest keeps resting | builder B1f; R3; restart R10 |
| Phone flatten | one market order, with the runner open or after an early-exit decision | R8a, R8c |
| HALT | the early exit sends nothing | R8b |
| np1, level-loss, morning hold | one owner per trade | `:1177, 1219, 1374`; builder A7 |
| Points vs ticks, long vs short | clean | R7d, R7e, R11; builder B4b, B4c |
| Config switch | deep merge; a partial object is valid | `live-executor.js:1700-1716` |
