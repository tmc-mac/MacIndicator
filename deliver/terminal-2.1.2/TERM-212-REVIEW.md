# Terminal 2.1.2 review (mobile.html sha256 ff2e4b76…, unchanged after my runs)

## Verdict: KEEP WITH RULES. Do not roll back to 2.1.1.

2.1.2 closes the dangerous direction of all four defects: on the bot's answer path the Flatten receipt no longer says BOT CONFIRMED while the broker read shows a position. It adds one new false alarm in the same code (N1) and leaves one narrow old path green (R3). Both are covered by the rules below; 2.1.1 is worse on every point.

## Per-defect table

| Defect | Status | Evidence |
|---|---|---|
| D1 Flatten receipt | **PARTLY** | Answer path closed: my unchanged repros A and B now print "NOT FLAT … broker shows SHORT 3 · flatten in TopstepX" (`rv-211-on-212.out`). Live shapes: amber while FLATTENING, green only on a FLAT read after the answer (R1a to R1c); red at once for a bot halted across a restart (R2); never green on a FLAT read older than or equal to the answer, on DESYNCED, on a missing position or broker block (R4a to R4d). Two faults remain: **N1** and **R3** below |
| D2 False qty MISMATCH | **CLOSED** | The live bot sets all three exit flags during a market exit: status `FLATTENING` (`live-executor.js:4844`), `position.flattening` (`:4795`), `levels.trade.open.phase` FLATTENING (`lib/levelPanel.js:26, 395`), with openQty = contracts − leg1 − leg2 (`:4932`). With that snapshot the card prints "closing: bot is exiting, broker still shows 3", no MISMATCH (H-live, H-live1, also with AUTH_FAILED masking the status). A side difference while exiting still flags MISMATCH (H-side); a qty difference while not exiting still flags (H-noexit). My unchanged H script still prints MISMATCH only because it sets openQty with no exit flag, which the live bot never writes: limit (b) leaves no realistic false alarm |
| D3 Cancel ack matching | **CLOSED** | `ackFor` requires `a.requestedAt === reqAt` for a cancel (page line 13693). The live ack carries it: `phoneReq.ack({ id: first 16, type: 'cancel', requestedAt: r.requestedAt … })` (`live-executor.js:5938`); the server's answer to the tap is the stored record, which always has `requestedAt` (`lib/entryCancelRequests.js:29`), and a tap after a STALE gets a new one. Second tap with only the old STALE ack: "SENT · waiting for the bot"; with its own ack: BOT CONFIRMED, also when listed after the old one; the first tap still shows its own STALE (C block). Unchanged repro C: no match |
| D4 Scorecard | **CLOSED** | 19 resolved: no verdict, "too few to judge"; 20 resolved: HELPED / HURT; estimate $0: no verdict; n printed is the resolved count. Both shadow dollar rows read "shadow estimate …" (K block). Unchanged repro K: "K ok", estimate label true |
| Regression: request bodies | **IDENTICAL** | The whole-page diff 2.1.1 → 2.1.2 is 18 hunks (`page-211-212.diff`), none in a handler, a `fetch` call or the POST pass-through; the pause / flatten / cancel-entry fetch lines hash the same in both pages. Builder's capture for the four controls: "DROP1 REQUESTS: IDENTICAL" (`term212/gate/13c-requests-vs-211.txt`), not re-run by me |

## New fault and residual

**N1 (new in 2.1.2, false alarm). A confirmed flatten turns red when the bot opens its next trade.** The kept answer is re-judged against the live broker read on every render (`flattenAck`, page line 13728), with no end. Repro R8: receipt green BOT CONFIRMED at 8 s; not cleared; 10 min later the bot holds its next trade LONG 3 and the same receipt reads "NOT FLAT · broker shows LONG 3 · flatten in TopstepX. 10 min later its broker read still shows the position", red, as an alert, at the Flatten button and under the position card. It tells Mac to close a healthy trade. Fix for 2.1.3: once the receipt has been green, keep it (or ignore a broker position whose `openedAt` is after the answer).

**R3 (old 2.1.0 path, not covered by the D1 fix). With no answer from the bot, the receipt can still go green from the bot's own state.** Repro R3: flatten tapped in a position; the bot restarts before answering (its answers are lost) and comes back halted (status DESYNCED, its own state FLAT) while the broker read shows SHORT 3. The receipt reads "APPLIED Flatten · waiting for the bot · No open position in the bot's snapshot", green, still at 70 s. Narrow: it needs a bot restart between the tap and the answer (about 3 s). The headline is APPLIED, not BOT CONFIRMED. Fix for 2.1.3: on the no-answer path, apply the same broker-read and halted checks.

Builder's limit (a) is weaker than stated: a halt latched across a restart sets `desynced` (`lib/liveStateMachine.js:330, 394`), so the live status is DESYNCED and the receipt is red at once (R2). A position the bot does not know about (status SCANNING) goes amber, then red on a read 20 s after the answer (R2b).

## What Mac must be told (interim rules)

1. **A flatten is done when the receipt is green BOT CONFIRMED with "broker shows FLAT", or Broker truth says FLAT.** Amber BOT ANSWERED means not yet. Red NOT FLAT means close it in TopstepX.
2. **Tap Clear on the Flatten receipt once it is green.** If left on screen it turns red "NOT FLAT" when the bot opens its next trade; that red is about the new trade, not the old flatten. A NOT FLAT that appears on a receipt that was already green is this false alarm.
3. **A green "APPLIED · waiting for the bot" on a flatten is not a confirmation.** Only BOT CONFIRMED is. If it stays "waiting for the bot", read Broker truth.
4. "closing: bot is exiting" on Broker truth is normal during a market exit and should clear in seconds. If it stays, or the card says DESYNCED, check TopstepX.

## Not checked

- Replay pacing, visual style, notes 2 to 7 of the 2.1.1 review, any bot change (out of scope).
- The builder's gate suites were not re-run; the request capture is the builder's, backed by my diff reading.
- The cancel flow was checked on the receipt model with live-shaped acks and by code reading of the bot and server, not by a painted two-tap run against a real cancel store.
- No real bot or broker: all snapshots are fixtures shaped from the edge r1.1 code. Whether a FLAT-phase bot keeps reading the broker position (needed for amber to turn red in R2b) was not verified.
- A broker block with `positionReadAt` null and a newer `readAt` would count as a fresh read (R4e); the live bot cannot write that shape (`lib/phoneSnapshot.js:122, 128`).
- "closing" has no time limit; a stuck exit shows amber "closing" plus the DESYNCED line when the bot halts (H stuck).

Scripts and output: `review/term212/rv-212.test.cjs`, `rv-212.out`, `rv-211-on-212.out` (my 2.1.1 script, unchanged, on the 2.1.2 bytes), `page-211-212.diff`.
