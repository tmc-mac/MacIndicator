# Phone terminal 2.1.2 (terminal builder, 11/11)

2.1.2 = 2.1.1 + the four fixes of the independent review (`review/TERM-211-REVIEW.md`). Nothing else changed.

Frozen page: `term212/mobile.html`, sha256 `ff2e4b760deeeee7e2de4c0ead3b7714550ca8434ee17a7a572afc925bce1343` (read-only; unchanged after the gate).
Display only: requests are IDENTICAL to 2.1.1, handlers and the two-tap confirm untouched.

## The four fixes

**D1. Flatten receipt (`src/t210-control.js`, `flattenAck`).** The bot's APPLIED is now only "the bot answered".
- **Green BOT CONFIRMED** only when the bot's broker position read, taken after its answer, says FLAT. The chain has a fourth step: sent → bot received → bot answered → broker shows FLAT.
- **Amber BOT ANSWERED** until then: "Bot answered: <result> · waiting for the broker to show FLAT", with the live broker position and its read time on the receipt.
- **Red NOT FLAT** when a broker read 20 s or more after the answer still shows a position: "NOT FLAT: broker shows SHORT 3 · flatten in TopstepX".
- **Red, never green, when the bot is halted or desynced** (status says HALT or DESYNC): "NOT FLAT: broker shows …" or, with no position in the read, "NOT CONFIRMED: the bot is DESYNCED · check TopstepX".
- With no broker read in the snapshot it stays amber and says "Broker position UNKNOWN: this bot build sends no broker read."
- A kept answer is judged against the live broker read on every render, so it turns red or green after the bot's last-10 list has moved on.
- My own suite's assertion of a green "Already flat" on the in-position fixture is replaced by the review's repro A (amber, then red).

**D2. Broker card (`src/t210.js`, `brokerRead`).** While the bot is exiting (position.flattening, a FLATTENING phase or status) a qty difference is not a MISMATCH: the card says "closing: bot is exiting, broker still shows 3" in amber. A side difference still flags MISMATCH while exiting; a qty difference while not exiting still flags.

**D3. Cancel ack matching (`ackFor`).** A cancel ack must carry this tap's `requestedAt` as well as the id. A second tap on the same entry shows its own sent / waiting, then its own result. With no request time for the tap there is no match.

**D4. Scorecard (`src/t211.js`).** HELPED / HURT needs 20 or more trades with a known ending; the n printed for Early exit is that count ("n = 3 with a known ending, of 25 fired · too few to judge"). The ATR TP1 shadow's dollar rows are labelled "estimate".

## Review repros, now painted tests in `tests/surfaces-212.test.cjs`

| Repro | Before (2.1.1) | Now |
|---|---|---|
| A: APPLIED "already flat", broker SHORT 3 | BOT CONFIRMED, green, 60 s later | amber at 3 s, red NOT FLAT at 60 s, position on the receipt |
| B: APPLIED "no market order this poll", bot then DESYNCED | BOT CONFIRMED at 90 s | red as soon as the bot is desynced; never green even on a FLAT read |
| C: second cancel tap, old ack with the same id | old answer taken | not taken; own SENT / waiting, then own BOT CONFIRMED |
| H, H2: bot FLATTENING with openQty 1 or 0, broker 3 | MISMATCH "Check TopstepX" | "closing: bot is exiting, broker still shows 3", amber |
| K: 25 fired, 3 resolved | HELPED | no verdict, "too few to judge" |

Note on H: the reviewer's script sets only `openQty`. A qty difference with no exiting flag is still a MISMATCH by design, so the painted test also sets the FLATTENING phase and `position.flattening`, which is what the bot sends in that state.

## Trimmed gate (all on ff2e4b76…; logs in `term212/gate/`)

| Suite | 2.1.1 | 2.1.2 |
|---|---|---|
| New painted suite | 499 / 0 | **530 / 0** (`surfaces-212`) |
| Control receipts (spec-updated copy) | 319 / 0 | **319 / 0** |
| Surfaces (spec-updated copy) | 235 / 0 | **235 / 0** |
| Requests vs 2.1.1 | none | **IDENTICAL** |
| Control identity vs 2.0.9.10 | 92 / 0 | **92 / 0** |
| Budgets | 912 / 0 | **912 / 0** |
| Replay A/B, one interleaved pair | 28 / 0 | **25 / 3**: see below |
| Replay A/B, chart 1x re-measured, 3 interleaved runs | none | 7 / 0 |

**Replay pacing, the one thing not clean.** The single pair missed three limits, all on chart 1x and all from one stall in one run: long tasks 589 ms against the reference's 300, max frame gap 117 ms against 100, max step 1.67 % against 1.19 %. The other three cases passed (reel 4x long tasks 1831 against 1950; chart 4x 1607 against 1648). I re-measured chart 1x with three interleaved runs: 294 ms against 315, max gap 83 against 83, pass. Chart 1x on 2.1.1 read 288 to 335 ms in five runs. The 2.1.2 changes do not run on the Levels tab (no broker card, no receipt, no scorecard there), so I read it as a one-off stall, but the specified single pair did fail and I have not hidden that.

Not run (outside the trimmed gate): cascade, QA fixes, cascade perf, QA rcpt / adv, control identity vs 2.1.1.

## Not verified / limits

- "Halted or desynced" is read from the snapshot's `status` (HALT / DESYNC) or a `halted` flag. The review says a bot halted across a restart can sit with phase FLAT and no such status: in that case the receipt goes amber, then red NOT FLAT after 20 s on the broker read, not red at once. A halted bot also stops reading the broker (review note 5), so with no newer read the receipt stays amber "waiting", never green. The bot fix (answer REJECTED HALTED before checking phase) is still needed.
- D3 relies on the server returning `requestedAt` for the cancel; if a build does not, the receipt falls back to "waiting" / inferred and never matches an ack.
- The review's notes 2 to 7 (reload drops the receipt, clock skew wording, UTC times inside a bot reason, the journalId fallback on Review / Levels rows) are not addressed in 2.1.2.

## Files

- `term212/mobile.html`, `mobile.html.inputs.txt`
- `term212/src/` (`t210.js`, `t210-control.js`, `t211.js`, css, `build-2112.cjs`)
- `term212/tests/surfaces-212.test.cjs`, `gate-212.sh`, `shots-212.cjs`
- `term212/gate/GATE-LOG.txt`, `15-replay-ab-one-pair.txt`, `15b-replay-ab-chart1x-3runs.txt`
- `term212/shots/1-flatten-receipt-amber.png`, `1b-flatten-receipt-not-flat-red.png`, `2-broker-closing.png`
