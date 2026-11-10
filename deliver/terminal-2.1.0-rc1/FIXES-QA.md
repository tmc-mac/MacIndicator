# Terminal 2.1 stage 2: QA correctness fixes (fix-qa desk)

Display only. No request, endpoint, body, key, two-tap or Control-handler change. The clock module (`t210-clock.js/.css`), the time formatters (`timePT`, `datePT`, `clockPT`, `pt12`, `partsPT`) and the 1 s tick (`setInterval(render, 1000)`) are untouched: `t210.patch` has no hunk in them.

- **Patch:** `fix-qa/t210.patch`: unified diff of `v2src/` (stage-2 sources = `stage-2/build-inputs/v2src`) → `fix-qa/src/`. 6 files: `t210.js`, `t210.css`, `t210-cascade.js/.css`, `t210-control.js/.css`.
- **Test page:** `fix-qa/mobile.html`, built by `fix-qa/build/build-2100-fixqa.cjs`. That is `build-2100.cjs` with the v2src folder taken from `MACUI_V2SRC` and the harness from `MACUI_HARNESS`; nothing else is changed. The same wrapper over the stage-2 sources rebuilds `a26c2953…` byte for byte.
- **Merge note for the perf desk:** the patch also edits the `window.T210 = {…}` export line (adds `posState`, `px`) and the cascade `T.EXTRA` renderer (adds `flowSig(m)`). If the perf desk changes either line, take both edits.


## Findings → change → test → result
"Model" = `tests/models-qa-210.test.cjs` (node, no browser). "Painted" = `tests/fixes-qa-210.test.cjs` (browser, fixture server only).

| # | Finding (QA-TERM210) | Change | Test | Stage 2 → fix |
|---|---|---|---|---|
| 1 | BLOCKER: a cancel reads green APPLIED when the entry FILLED | **Baseline:** each send keeps what the snapshot showed at the tap.<br>**APPLIED:** only when there is no resting entry AND no new position or fill since the send. A fill is a non-pending position, a new `levels.trade.open`, or a new `today` row.<br>**Fill shown:** new amber state `FILLED`, word "NOT CANCELLED", line "ENTRY FILLED before the cancel — you hold LONG 3 @ X" (or "that trade has since closed"), note "Cancel does not close a position; Flatten does.", `role=alert`.<br>**Bot receipt:** `outcome:filled` is amber too. `cancelled`/`resolved` turns APPLIED only once a snapshot agrees.<br>**Latch:** APPLIED stays correctable for 45 s of agreeing snapshots, then is kept. A fill, once seen, is kept. | Model 1 (13 checks); painted 1a (QA R1), 1b (looks cancelled at 22 s, fill row at 42 s → corrected; a real cancel is kept after 45 s); QA `qa-rcpt` R1 | R1: APPLIED (green) → FILLED (amber, with the position) |
| 2 | Pause while paused reads APPLIED from the old pause | **Pause:** APPLIED only when `pause.until` moves after the send. If it has not moved: "Already paused until X: waiting for the bot to apply the new pause"; after 45 s, amber "not applied yet — already paused until X (the bot has not changed it)". Once applied it shows "(was until Y)".<br>**Same class on the other 3 controls:** resume with no pause running, flatten when already flat, and cancel with nothing resting each say so and never turn green or escalate. Flatten from a resting entry is applied only when flat. A flatten that leaves a resting entry reads "flat: no open position; a resting entry is still working" (QA note 9 / R5). | Model 2 (14 checks); painted 2; QA R2 + new R2b | R2: APPLIED → SENT "already paused until 1:21 PM PT"; R2b: APPLIED "(was until 1:21 PM PT)" |
| 3 | Eval: room UNKNOWN but day P&L includes the open −$39 | When open P&L is UNKNOWN (missing, stale mark, or position UNKNOWN), the Eval row reads "day P&L realized (closed trades only: open P&L UNKNOWN)" from `day.realized`, else `dayTrips.net` | Model 3; painted qa-noopen / qa-noopen2 | +$671.86 "as the header" → +$710.86 "realized" |
| 4 | Eval says flat while Broker says SHORT 3 | One position read, `posState(d)`, is used by Eval, Broker truth, the Trades day line and the receipts.<br>**Empty markers:** an empty marker list is not flat.<br>**No levels trade:** `levels.trade.open = null` alone is not flat either (a TIDE trade has none, e.g. `tide20-r17live`).<br>**Disagreement:** a direct contradiction makes the position UNKNOWN on both cards, with the reason: position null with an open levels trade, a resting entry with an open levels trade, or opposite sides. | Model 4 (6 fixtures agree, nomarkers, contradiction, opposite sides, TIDE); painted nomarkers + contradiction | nomarkers: Eval "flat", room $524.16 → open −$39.00, room $485.16, SHORT 3 on both |
| 5 | Build stamp "read X ago" is the newest row's age | **Age:** the stamp keeps the time this phone read the journal (`readAt`; also stored). The age and LIVE/STALE come from that time: "live · read 5 s ago", or "read 10 min ago · open Review to re-read". A stamp restored from storage with no read time is STALE.<br>**Fixture:** `tests/fix-fixtures-210.py` drops the builder's synthetic `44382b7fcf62` row, so the real Nov 2 tail `059fa8dfc392` is current → `exe / cfg UNKNOWN` (not in the checked table). | Model 5; painted 5 (fixed fixture; re-opening Review re-reads → live again) | the real tail used to read "read 10 min ago" right after Review; now "live · read 0 s ago" |
| 6 | "against against" | The cascade's reference line reads "compared with the bot's LONG candidate". The node state "1H against" is unchanged. | Model 6; painted (9a) | fixed |
| 7 | 3-leg exit shown as one price; Trades ≠ Levels | **Trades row:** the exit painted is entry + side × pts/ct, so entry → exit always equals the pts shown. It carries "avg" when the exit was several fills (TP1 + runner, or the bot's exit price ≠ that average), never on a full stop.<br>**Fixture:** `fix-fixtures-210.py` sets `exit.price` to that average, as the real journal does (Review: "Exit 28126.67"). The base Levels list computes pts from `exit.price`, so on the fixed fixture it reads +16.58 like Trades. On the original fixture it read +16.50: a fixture fault, not a page fault. | Model 7; painted 7 | row 12:35: "28,143.25 → 28,126.75 +16.58" → "28,143.25 → avg 28,126.67 +16.58"; Levels +16.50 → +16.58 |
| 8 | Switched-off gates listed as PASS | `notMacGradeB`, `notGradeCAsia` (and any detail saying "block off" / "switched off", unless the row blocks) read **OFF** in grey dotted style. They are sorted last, counted as "· 2 off" and never counted as passing. | Model 8; painted 8 | PASS → OFF |
| 9 | Guidelines | **Cascade:** the flow animation runs 2 cycles (2.8 s) after the flow changes or the card comes on screen (IntersectionObserver), and never off screen. `data-flow` on the card gates it, outside the markup the 1 s render replaces. No `infinite` remains.<br>**No-answer alert:** the live-region text changes at most once per 15 s (13 → 28 → 43 s).<br>**Receipt buttons:** hover (pointer devices) and pressed states. Transform is the only transition. | Model 9; painted 9a, 9b, 9c | no-answer: 32 changes in 31 s → 3 |

Not done: Title Case on "Save lines", "Notify me" and "Dismiss" (QA 16; out of this brief). Clocks drawn on canvas are left to the perf/clock desk.

## Test results (final page `fix-qa/mobile.html`, sha256 `37ea575b7bf1d4a42f9256d68deb7fc0e554e267dad31a7c1ebf8b2e4f8c295b`)
| Suite | Stage 2 (`a26c2953`) | Fix (`37ea575b`) |
|---|---|---|
| models-qa-210 (new, node) | 24 / 57 | **81 / 0** |
| fixes-qa-210 (new, painted) | 22 / 44 | **66 / 0** |
| QA `qa-rcpt` (R1–R6 + R2b) | R1 APPLIED on a fill, R2 APPLIED on the old pause, R5 APPLIED | R1 FILLED, R2 SENT "already paused", R2b APPLIED with old → new, R5 SENT "position UNKNOWN" (QA's R5 fixture keeps `levels.trade.open` beside a resting entry); R3, R4, R6 unchanged: same POSTs, same request files |
| QA `qa-adv` (+ noopen, noopen2, nomarkers, realstamp, nov02) | findings 3–8 reproduce | all fixed; 0 page errors in 7 scenarios |
| surfaces | 235 / 0 | 234 / 1 (spec change) · updated copy **235 / 0** |
| cascade | 1030 / 0 | 1012 / 18 (spec change) · updated copy **1030 / 0** |
| control receipts | 318 / 0 | 317 / 1 (spec change) · updated copy **319 / 0** |
| Control identity vs 2.0.9.10 | 92 / 0 | **92 / 0** |
| budgets (SWEEP_SCOPE=all) | 912 / 0 | **912 / 0** |
| request parity vs 2.0.9.10 | IDENTICAL | **IDENTICAL** |

Stage-2 counts for the builder suites are QA's frozen-bytes gate. All fix counts are on the final bytes. Not run: cascade-perf (timing; the machine belongs to the perf desk) and replay-smooth A/B (perf desk).

**Spec-change failures in the unchanged builder suites.** These are the only failures. Each one is expected, and the updated copy in `tests/updated/` passes:
- **receipts −1:** the model table expected the bot's "filled" receipt to read red FAILED. Fix 1 makes it amber FILLED.
- **surfaces −1:** the gate-order check had no rank for OFF (fix 8).
- **cascade −18:** the 18 aligned cases (8 four-node + 10 five-node) check that every lit link is animating. The test never scrolls, so the card is off screen, and fix 9 stops the animation there. The updated copy scrolls the card into view: 1030/0.

## Files
- `src/` (fixed sources), `base-src/` (stage-2 sources), `t210.patch`, `mobile.html` (+ `.inputs.txt`), `build/build-2100-fixqa.cjs`
- `tests/models-qa-210.test.cjs`, `tests/fixes-qa-210.test.cjs`, `tests/fix-fixtures-210.py`, `tests/run-fix.sh`, `tests/updated/` (3 builder suites with the spec changes), `qa/` (QA's `qa-rcpt` / `qa-adv` with output redirected, plus R2b and the noopen / nomarkers / realstamp / nov02 scenarios)
- `gate/` (first full run; budgets, identity, parity, adv and the stage-2 comparisons), `gate2/` (final bytes: fixes, rcpt, receipts, surfaces, cascade, original and updated), `qa/rcpt-out-{s2,fix}.json`, `qa/adv-out-{s2,fix}.json`, `shots/1a-cancel-filled-390-dark.png`
- `hA/`, `hB/`: shadow harness folders (symlinks; `hB` holds the corrected t210 fixtures and the QA fixtures). Run dirs stay out of the shared harness.

