# Phone terminal 2.1.3 (terminal builder, 11/11)

2.1.3 = 2.1.2 + the two flatten-receipt fixes of the second review (`review/term212/TERM-212-REVIEW.md`: N1 and R3). The diff is in the receipt model only (`src/t210-control.js`, its css, the release string). D2, D3, D4 paths are untouched.

Frozen page: `term213/mobile.html`, sha256 `15e5d96fb7195ee4d670ab3eb87b6ebb2768f7d7f8a3db36d7c5e66826c477dd` (read-only; unchanged after the gate).
Requests are IDENTICAL to 2.1.2.

## What changed

**N1. A confirmed flatten is latched.** Once a broker FLAT read newer than the bot's answer has confirmed the flatten, the receipt stays green BOT CONFIRMED with the time of that read ("broker showed FLAT at 12:51:45 PM PT") and is never judged again: not against a later broker read, not against a later bot status, not after the bot's last-10 list moves on. A later position is a later trade and is not printed on this receipt.
- Extra guard for a phone that slept through the FLAT read: a broker position whose `openedAt` is after the bot's answer is a later trade. The receipt is then amber "a later trade is open now; this phone did not see the FLAT read in between", neither red nor green.
- Red NOT FLAT is still reachable before the latch (review repros A and B print red, unchanged).
- Reviewer's correction kept: a bot halted across a restart reports DESYNCED and the receipt is red at once.

**R3. With no answer from the bot a flatten is never green.** The bot's own state ("no open position in the snapshot") is no longer a confirmation.
- Amber: "SENT · no answer from the bot yet · broker shows SHORT 3", with the broker read time.
- Red NOT FLAT when a broker read taken 20 s or more after the tap still shows a position, or at once when the bot is halted / desynced with a position in the broker read.
- A FLAT broker read with no bot answer stays amber. Green needs both the answer and a FLAT read newer than it.

## Witnesses

- Reviewer's scripts run unchanged on these bytes (`gate/70-…`, `gate/71-…`): R8 stays BOT CONFIRMED at +10 min with LONG 3 on the broker card, and the copy under the position card is the same green receipt; R3 reads NOT FLAT at 20 s and 70 s, never a green state; repros A and B print red NOT FLAT. No FINDING line in the 2.1.2 script. The 2.1.1 script still prints its H line; the reviewer closed that as a script that sets a shape the live bot never writes.
- The same four are painted tests in `tests/surfaces-213.test.cjs`, plus: latch survives DESYNCED and an emptied ack list; the slept-through-FLAT guard; a bot-state-flat-with-no-answer case; a FLAT read with no answer.

## Trimmed gate (all on 15e5d96f…; logs in `term213/gate/`)

| Suite | 2.1.2 | 2.1.3 |
|---|---|---|
| New painted suite | 530 / 0 | **569 / 0** (`surfaces-213`; includes the D2, D3, D4 tests) |
| Control receipts (2.1.1 spec copy, old-bot harness) | 319 / 0 | **305 / 14**: see below |
| Surfaces (spec copy) | 235 / 0 | **235 / 0** |
| Requests vs 2.1.2 | none | **IDENTICAL** |
| Control identity vs 2.0.9.10 | 92 / 0 | **92 / 0** |
| Budgets | 912 / 0 | **912 / 0** |
| Replay A/B | 25 / 3 on the pair, 7 / 0 on the re-measure | not run |

**The 14 control-receipts differences are the R3 rule, not a regression.** That harness is a bot with no `requests` block and no broker read. All 14 are flatten lines (10 painted, 4 model checks) that expect the old states SENT / APPLIED and now read amber "SENT · no answer from the bot yet · broker position UNKNOWN". Pause, resume and cancel are unchanged (the other 305). I did not make a 2.1.3 spec copy of that suite; the expectations are stale, the behaviour is the one specified.

**Replay A/B skipped:** the diff runs only when a flatten receipt exists and the page renders it; nothing in it runs during a replay.

## Limits

- **An old bot (no `requests` block, no broker read) can never show a green flatten receipt in 2.1.3.** It stays amber with "this bot build sends no broker read". That is the stated rule (green needs a bot answer and a broker FLAT read); it is a visible change from 2.1.2 for anyone on a pre-r1 bot.
- **The 20 s rule on the no-answer path compares the phone's tap time with the bot's read time.** A phone clock far ahead of the bot delays the red; it cannot make the receipt green. With a bot answer both times are the bot's.
- **A halted bot that has stopped reading the broker**: with a bot answer and no newer read the receipt stays amber; on the no-answer path a halted / desynced status with a position in the last read is red at once, even if that read is old.
- The latch lives in the page's memory, like the receipt itself: a reload drops both (review note 2, not addressed).
- Not run: cascade, QA fixes, QA rcpt / adv, cascade perf, replay A/B.

## Files

- `term213/mobile.html`, `mobile.html.inputs.txt`
- `term213/src/` (`t210-control.js` is the only logic change; `build-2113.cjs`)
- `term213/tests/surfaces-213.test.cjs`, `gate-213.sh`, `shots-213.cjs`
- `term213/gate/GATE-LOG.txt`, `70-reviewer-rv-212-unchanged-on-213.txt`, `71-reviewer-rv-211-unchanged-on-213.txt`
- `term213/shots/1-flatten-no-answer-amber.png`, `2-flatten-latched-green-next-trade-open.png`
