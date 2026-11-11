# Terminal 2.1.3 review (mobile.html sha256 15e5d96f…, unchanged after my runs)

## Verdict: KEEP WITH RULES (keep 2.1.3; one rule about the amber "a later trade" line).

N1 and R3 are closed. I found no state in which a position that is still open shows green. The new guard has one case where a real problem shows amber instead of red (L4); Broker truth flags it red on the same screen.

## Status

| Item | Status | Evidence |
|---|---|---|
| N1 confirmed flatten turns red on the next trade | **CLOSED** | My unchanged 2.1.2 script on these bytes: R8 stays BOT CONFIRMED "broker showed FLAT at 12:51:44 PM PT" at +10 min with LONG 3 open, same under the position card (`rv-212-on-213.out`, no FINDING line). L1: still green after the bot goes DESYNCED in the next trade and its ack list is emptied; the later position is not printed on the receipt |
| R3 green with no bot answer | **CLOSED** | R3 now red NOT FLAT at 20 s and 70 s. No answer + bot FLAT + broker FLAT: amber "SENT · no answer from the bot yet", still amber at 70 s and when DESYNCED (N2). No answer, position on a read 22 s after the tap: red (N3); 18 s: amber. A late answer plus a FLAT read after it: green (N3) |
| Claim 1 latch | **TRUE** | Set only from the answer path, state CONFIRMED with a FLAT read time (page line 13856); a latched receipt returns before any other check (line 13742) |
| Claim 2 guard | **TRUE, with L4 below** | Slept through the FLAT read: amber "a later trade is open now; this phone did not see the FLAT read in between" (G2). The same trade still open 25 s after the answer is red, also with `openedAt` missing (G3, G3b): the guard needs `openedAt` later than the answer |
| Claim 3 no-answer rules | **TRUE** | N1 to N4. Red at once when DESYNCED with a position in the last read, even an old one (N4, labelled "read before the tap") |
| Claim 4 request bodies | **IDENTICAL** | Page diff 2.1.2 → 2.1.3 is 9 hunks: css, the release string, the receipt model. No handler, no `fetch`, not the POST pass-through; the pause / flatten / cancel fetch lines hash the same. Builder's capture: "DROP1 REQUESTS: IDENTICAL" (not re-run by me) |
| Claim 5 the 14 differences | **TRUE** | `term213/gate/33v-…txt`: 10 lines start "flatten /", 4 are the model checks r[0], r[1], r[2], r[5] of the flatten block (test line 86 to 87); the pause model checks on the same lines pass. Each reads NOANSWER where the old spec wants SENT or APPLIED. `flattenNoAnswer` runs only for `rec.key === 'flatten'` (line 13751); pause with and without an answer is unchanged (P) |

## The three questions

**Can the latch be set wrongly (green while the position is open)? I found no reachable case.**
- Green needs: bot not halted / desynced, a bot answer APPLIED, and a broker FLAT read whose time is later than the answer (equal is not enough, R4a2).
- The read time is stamped when a fresh broker reply is noted (`lib/liveOrders.js:54`, `lib/brokerReads.js:17`), never re-stamped from a cached list. A read taken after the answer but before the exit filled shows the position, not FLAT, so it cannot set the latch.
- A flatten on a resting entry (where "FLAT" is trivially true and the bot answers APPLIED even when its cancel did not finish, `lib/phoneRequests.js` `flattenResult`) is not reachable from the page: Flatten is enabled only with an open, non-pending position (page line 3301).
- "FLAT" means no position in the bot's contract on the bot's account, as in 2.1.2. A position in another contract or account is not seen.

**Does guard (2) hide a real NOT FLAT? Yes, in one case (L4).** If a flatten leaves an unintended position that the broker opened after the bot's answer (the exit and a stop both filling, a reversal), the receipt reads amber "a later trade is open now" and never turns red (still amber at 90 s). There was never a FLAT read, so the wording is wrong. At the same time Broker truth shows red "MISMATCH … disagree on the position. Check TopstepX" (bot FLAT, broker LONG 3). The bot cancels its protective orders, verified, before sending the exit, so this needs a bot fault. In 2.1.2 this case went red after 20 s. The same trade, opened before the answer, is not hidden (G3). Not verified: whether the broker changes a position's open time when its size changes (a TP1 fill during a failed flatten); if it did, the same trade would read amber.

**Are the 14 differences only flatten lines? Yes** (table, claim 5).

## Other notes

- **N5, brief false red.** The no-answer 20 s rule compares the phone's tap time with the bot's read time. With the phone clock 17 s or more behind the bot, the receipt reads red NOT FLAT about a second after the tap, until the bot's answer arrives (about 3 s). The builder named only the opposite direction (a late red).
- An old bot (no requests block, no broker read) can never show a green flatten receipt: always amber. Only matters if Mac's running bot is older than edge r1.

## What Mac must be told

1. A flatten is done when the receipt is green BOT CONFIRMED "broker showed FLAT at …", or Broker truth says FLAT. Amber means not confirmed yet. Red NOT FLAT means close it in TopstepX.
2. The green receipt now stays green; no need to tap Clear (the 2.1.2 rule is withdrawn).
3. If a flatten receipt says "a later trade is open now", read Broker truth. If Broker truth shows MISMATCH or a position you do not expect, close it in TopstepX.

## Not checked

- Replay pacing (the builder did not run it for 2.1.3 either), visual style, notes 2 to 7 of the 2.1.1 review, any bot change.
- The builder's gate suites and request capture were not re-run; identity rests on the diff reading plus the builder's log.
- D2, D3, D4 were not re-tested beyond my 2.1.2 script running clean on these bytes (their code is not in the diff).
- No real bot or broker; all snapshots are fixtures shaped from the edge r1.1 code. Broker open-time behaviour on a size change is unknown.
- A reload still drops the receipt and its latch.

Scripts and output: `review/term213/rv-213.test.cjs`, `rv-213.out`, `rv-212-on-213.out`, `page-212-213.diff`.
