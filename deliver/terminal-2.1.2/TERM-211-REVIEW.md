# Terminal 2.1.1 review (mobile.html sha256 fa931784…)

**Three defects can mislead Mac about a live order or position: D1 (a flatten receipt reads BOT CONFIRMED while the position is still open), D2 (a false MISMATCH alarm on every market exit before TP1) and D3 (a second cancel tap shows the old answer).**

## Verdict: FIX IN 2.1.2. Do not roll back.
2.1.1 adds the Broker truth card, which shows the bot's own broker read and is right in every case I tried. Rolling back to 2.1.0 removes that card and keeps the same receipt weakness in its inferred form. Until 2.1.2:

- **A flatten is done only when Broker truth says FLAT.** Do not rely on the receipt's "BOT CONFIRMED" headline for a flatten.
- **A MISMATCH on "qty" that appears while a trade is being closed at market, and clears within about 20 s, is the known false alarm (D2).** Any other MISMATCH is real.

Method: code reading of `term211/src`, the bot's ack code in edge r1.1, and my own painted-output scenarios on the frozen page (`review/term/rv-211.test.cjs`, output `rv-211.out`), run with no other browser active.

## Defects, ranked

### D1. Flatten receipt says BOT CONFIRMED while the position is open (misleads about a live position)
The receipt turns green on any ack whose result is APPLIED and prints only the bot's reason (`t210-control.js` `ackModel`). It never looks at the broker read. The bot answers APPLIED in two cases where nothing is flat:

| Case | What the bot sends | What the page shows | Repro |
|---|---|---|---|
| The bot's own phase is FLAT but the account holds a position. Confirmed for a halt latched across a restart: the machine is halted with phase FLAT | `APPLIED`, `ALREADY_FLAT: the bot was flat; no order sent` (`lib/phoneRequests.js:103`; `flattenNow` returns before the halt check, `lib/liveStateMachine.js:3037`) | "BOT CONFIRMED Flatten · Already flat: the bot was flat; no order sent", green, 60 s later, beside Broker truth "SHORT 3" | A |
| The exit is under way but no market order went out this poll, and the bot then halts | `APPLIED`, "exit under way … no market order this poll" (`lib/phoneRequests.js:107`); no later ack is ever sent | "BOT CONFIRMED Flatten", still green 90 s later with the bot DESYNCED and SHORT 3 open | B |

- The halted refusal itself renders correctly: an ack with `HALTED:` shows "BOT REFUSED · REFUSED: bot halted · flatten in TopstepX", red (G). The problem is that a bot halted across a restart does not send that ack.
- The builder's own suite asserts the green "Already flat" receipt on the in-position fixture, so the gate passes it.
- **Fix in 2.1.2 (terminal):** for a flatten, print BOT CONFIRMED only when a broker read newer than the ack says FLAT. Otherwise print "BOT ACCEPTED" with "broker still shows SHORT 3" and keep it amber.
- **Fix in the bot (next bot build):** check halted before phase in `flattenResult`, so a halted bot always answers `REJECTED HALTED`.

### D2. False MISMATCH during every market exit before TP1 (misleads about a live position)
- While the bot is FLATTENING it sends `openQty = contracts − leg1 − leg2` (`live-executor.js:4932`). Before TP1 that is 1 of 3, or 0 on an all-at-TP1 trade, while the broker read still says 3.
- The card compares the two and prints "MISMATCH the bot's own state and its broker read disagree on the qty. Check TopstepX." with "broker read SHORT 3 / bot's own state SHORT 1" (H, H2).
- It fires on the early exit, the no-progress exit, the session close and a phone flatten, and lasts until the next snapshot after the fill. The early exit fired on one of the two trades in tonight's rig witness.
- **Fix in 2.1.2:** do not compare qty while the bot's status is flattening. **Bot fix:** send the open size in FLATTENING.
- Entry, TP1 and stop fills do not trip it: the bot reads the broker and updates its state in the same pass.

### D3. A second cancel tap on the same entry shows the previous answer and keeps it (misleads about a live order)
- A cancel's id is a hash of the entry, so a second tap on the same entry reuses it (`lib/entryCancelRequests.js:12`). `ackFor` matches by id and type only and ignores `requestedAt`.
- The reachable case: the first cancel came back STALE (the bot did not pick it up in 60 s), the entry is still resting, Mac taps again. The page matches the old STALE ack at once, shows "NOT DONE", and keeps it as final. When the bot then cancels the entry the receipt never changes.
- Repro C: with only 5-minute-old acks in `requests.recent`, a tap made 1 s ago matched both an old STALE and an old APPLIED ack. The old-APPLIED form is not reachable in practice (a cancelled entry cannot be tapped again).
- **Fix in 2.1.2:** for a cancel, also require the ack's `requestedAt` to equal the receipt's.

### D4. Scorecard verdict on too few trades
- The early-exit tile prints HELPED / HURT when `fired` is 20 or more, but the estimate is built on the trades with a known ending. With 25 fired and 3 resolved it prints "HELPED +$180.00 … on the 3 with a known ending" (K).
- **Fix:** test the resolved count, not `fired`.

## Notes
1. **Shadow dollars are not labelled "estimate".** The ATR TP1 shadow section says "recorded only, not traded" and names its model, but only the early-exit "saved" tile carries the word.
2. **A page reload drops the receipt** (D). Nothing wrong is shown; the ack is in the snapshot but the page no longer knows its request id.
3. **Clock skew.** Matching does not use time, so skew cannot confirm a wrong request (G, G2). The chain can read out of order ("sent 12:51 PM, bot received 12:41 PM") with no word that the clocks differ.
4. **Times inside a bot reason** are rewritten 12-hour by pattern (`pt12`), with no zone shift. A UTC time in a reason would read as if it were PT.
5. **A halted bot stops reading the broker**, so Broker truth goes STALE after 60 s exactly when Mac needs it (J). It says STALE honestly. This is a bot change, not a page defect.
6. **Rule line uses today's settings** for the session name and "stop +2" (the builder's stated limit).
7. **Review and Levels rows fall back to `journalId`** to find the bot's round trip and do not check `whyAmbiguous`. Two broker trades that claim one journal id could show each other's money. The Now rows match by entry time and are not affected.

## Hunt list results

| # | Item | Result |
|---|---|---|
| 1 | Ack matching: other id, other type | Clean: stays SENT / waiting (builder's tests) |
| 1 | Two taps in quick succession | Clean: 2 POSTs, new id; the first id's ack does not confirm the second tap (E) |
| 1 | Older ack in `requests.recent` | Flatten and pause clean (random 64-bit ids, `tmc-proxy.js:219, 242`); **cancel: D3** |
| 1 | Page reload | No receipt (note 2) |
| 1 | Bot restart clears the acks | Clean: "NOT APPLIED YET … waiting for the bot" (F) |
| 1 | Clock skew | Clean for matching (note 3) |
| 1 | Halted refusal | Renders REFUSED when the bot says HALTED; **D1** when it does not |
| 2 | Entry fallback | Clean: "28,143.25 broker avg", "pts/ct (bot)", "from the broker entry fill"; best R stays UNKNOWN; entry and points both come from the bot's round trip in the rows I saw (L). UNKNOWN when neither exists is by code reading, not a painted check |
| 3 | Sparkline fallback | Clean: "too short to chart (41 s)" / "chart not available: 1 price read"; 1m bars are filtered to the trade's own window. The 1m-bar drawing path was not exercised: the fixture carries no `bars1m` |
| 4 | MISMATCH / STALE | **D2**. Thresholds as stated: position LIVE at 59 s, STALE at 61 s (I) |
| 5 | Scorecard | n labels and "too few to judge" present; n = 0 prints no NaN (K0); **D4**; note 1 |
| 6 | Parity | Requests IDENTICAL vs 2.0.9.10 and vs 2.1.0 (gate 13, 13b). Control identity 92/92 vs 2.0.9.10; the 4 misses vs 2.1.0 are the base page failing its own "fetch is native" check, not a difference. The only change to the fetch pass-through is reading `requestId` from the answer |
| 7 | Times | 12-hour PT on every new surface I painted; the builder's sweep covers the rest (note 4) |

Not re-run by me: the builder's gate suites. The replay A/B missed one pacing limit on the 3-run pass and passed on the single pair; I read that as load noise and did not re-measure.
