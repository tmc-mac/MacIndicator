# Phone terminal 2.1.1 (terminal builder, 11/11)

Frozen page: `term211/mobile.html`, sha256 `fa931784d1892996ec7b7641778fa1fb2216e1fbb3241fb286d41f99f3158411`, build ID in `mobile.html.inputs.txt`.
Base: 2.0.9.10 byte for byte, plus one script, one stylesheet and the 27 clock-formatter sites of 2.1.0 (the build checks this by undoing them).
Display only: no request added or changed, no page handler wrapped, the two-tap confirm untouched.

## What changed, in the order Mac sees it

1. **Header stamps come from the bot** (`snapshot.build`): build, exe, cfg, started (12-hour PT, with the date when it is not today), "from the bot N s ago". STALE when the snapshot is older than 60 s. The page's hardcoded stamp table is removed. With no `build` block: the build id is the journal's newest row, labelled "from the journal" (MacArthur's ruling), and exe / cfg read "UNKNOWN: bot build does not report this yet".
2. **Broker truth reads the bot's broker read** (`snapshot.broker`): position side / qty / average, every working order with kind, side, qty, price and set time, the read time with its age. The position goes STALE when its read is older than 60 s; the orders when theirs is older than 60 s in a trade or 150 s while flat (the bot reads orders about once a minute while flat). When the bot's own position state disagrees with the broker read (position, side or qty) both are shown under a red MISMATCH. A position with no working order says "NO working orders: this position has no stop at the broker". No `broker` block, or paper mode: the 2.1.0 view with its UNKNOWN labels.
3. **Danger-zone receipts are driven by the bot's acks** (`snapshot.requests.lastAck` / `recent`; `acks` is read too if a build sends it). The POST's `requestId` is matched by id and type, never by time.
   - APPLIED: "BOT CONFIRMED" + the bot's result + the chain **sent → bot received → applied**, each with its own 12-hour PT time. Painted on the first snapshot refresh that carries the ack.
   - REJECTED (red), STALE and DUPLICATE (amber), PENDING ("BOT RECEIVED", retrying), each with the bot's reason. A reason that says halted reads "REFUSED: bot halted · flatten in TopstepX".
   - No ack yet: the 2.1.0 states, labelled "waiting for the bot" with the chain open.
   - A bot with no `requests` block, or a server that returns no request id: the 2.1.0 inference, labelled "inferred" with one line saying why.
   - A final answer is kept on the receipt after the bot's last-10 list moves on.
4. **Rule line on trade rows** (Now recent trades, Trades rows, Review trade cards) from `recentTrades[].exitReason` / `rule` and `position.rule`: "Early exit · never worked · −10.25 pts", "All out at TP1", "NY runner · stop +2 · target +164 (2×ATR 82) · hit / stopped +2 / closed at session end", "No-progress exit", "Full stop", and so on. Gross, fees and net come from the bot (`grossUsd` / `feesUsd` / `netUsd`) when sent, with the source named. `exitReason: UNKNOWN` prints UNKNOWN, never a guess. On Trades the FULL STOP badge follows the bot's `exitReason STOP` when sent. No rule facts: "rule UNKNOWN: bot build does not report this yet" and the 2.1.0 exit line stays.
5. **Market now** on the Now tab from `snapshot.rules`: "NY · ATR 82 (1.4× normal) · runner target +164 · early exit ON", one sentence of detail, and the open trade's plan. Null members read UNKNOWN with the reason (no ATR, fewer than 20 days of bars, session not known).
6. **Rule scorecard**, a section of the Review tab (above the journal), from `snapshot.scorecard`, "since <date>": Early exit (fired, saved $ labelled "estimate", what would have happened), Runner by session (trades, TP1 hits, the NY ATR runner's n, net, average pts, reached +30), ATR TP1 shadow ("recorded only, not traded": shadow net against live net on the same trades, extra full stops), Totals per session. n is printed beside every block; under 20 it says "too few to judge" and gives no HELPED / HURT verdict. Figures use the text colour; only the verdict words and "too few" use status colours.
7. **Order of the Now tab**: Eval → Broker truth → Position → Market now → Can the bot enter → the rest.
8. **Levels day list, Mac's bug of 11/11** ("missing the chart next to the trade on the most recent trade"):
   - The chart cell is never blank. Under 2 price reads the row draws 1-minute bars around the trade when the snapshot carries them (dashed, labelled), else it says "too short to chart (7 s)" or "chart not available: N price reads".
   - Where this phone holds no fill receipt, the row shows the bot's broker round trip instead of UNKNOWN, each labelled: entry "broker avg", points "pts/ct (bot)", held time "from the broker entry fill". With no round trip the UNKNOWNs stay. "best R" stays UNKNOWN (no source).
   - An all-at-TP1 trade's chip reads "TP1 · all 3 out" (also on Now).
   - Rows are patched once per page render of the row and never while a replay plays.
9. Small: the gates' evaluation time uses `checklist.evaluatedAt` when sent; Eval shows "Balance read from the broker h:mm" when `balanceReadAt` is sent.

## Root causes found

- **Missing sparkline**: the Levels row's sparkline is drawn only from the trade's own price reads (`levels.trade.today[].px`) and the page printed nothing under 2 reads. A 7-second all-at-TP1 trade has 0 or 1. Hypothesis (c) in spirit: too few samples in the trade window, brought out by the new short trades. Not a layout regression, not an unknown row shape.
- **"entry UNKNOWN / points UNKNOWN / no fill seen / fill time unknown"**: the page takes the observed entry and fill time only from `journal_receipt` rows with status `FILL_OBSERVED`, which reach the phone only in a `/signal-journal` answer (requested when Review opens, 100-line tail). Reproduced on 2.1.0 with the Nov 2 fixture: 30 of 30 rows UNKNOWN before Review is opened, 17 of 30 after. Not caused by botfix r1's snapshot changes: the snapshot was never the source. Bot-side option: put the entry fill on the snapshot's trade record (`levels.trade.today[].fill = { price, t, orderId, source }`, written where `lib/liveStateMachine.js` notes FILL_OBSERVED), so no journal read is needed.

## Placement decision

Scorecard is a section of Review, not a 7th tab: six tabs already take the whole bar at 360 px (about 57 px each; a 7th leaves about 49 px, less than "Scorecard" or "Checklist" needs at 12 px), and a new tab would mean changing the page's own tab switch. Approved by MacArthur.

## Gate (all on fa931784…; logs in `term211/gate/`, `GATE-LOG.txt`)

| Suite | 2.1.0 | 2.1.1 | Note |
|---|---|---|---|
| New painted suite `surfaces-211` | none | **499 / 0** | every state of each new surface, every ack result, scorecard n = 0 / small / normal, Levels rows, 360 / 390 / 428 × dark / light, 12-hour sweep |
| Surfaces | 235 / 0 | **235 / 0** (spec-updated copy) | unchanged 2.1.0 file: 229 / 6, all six are the reworded stamp lines and the Now order with Market now |
| Cascade | 1030 / 0 | **1030 / 0** (spec-updated copy) | unchanged file: 1029 / 1, the Now order |
| Control receipts | 319 / 0 | **319 / 0** (spec-updated copy) | unchanged file: 303 / 16, each is the added "inferred" label (that harness is a bot with no requests block) |
| QA fixes | 66 / 0 | **66 / 0** (spec-updated copy) | unchanged file: 63 / 3, "inferred" once and the stamp tail "from the journal" twice |
| Budgets (contrast ≥ 4.5, taps ≥ 44 px, no sideways scroll, clock sweep) | 912 / 0 | **912 / 0** | unchanged file |
| Control identity vs 2.0.9.10 | 92 / 0 | **92 / 0** | handlers, onclicks, button words identical |
| Control identity vs 2.1.0 | none | 88 / 4 | see below |
| Requests vs 2.0.9.10 | IDENTICAL | **IDENTICAL** | |
| Requests vs 2.1.0 | none | **IDENTICAL** | |
| Cascade perf | 12 / 0 | **13 / 0** | |
| QA rcpt scenarios | 10 | 10: same state and same POSTs in all 20 state points | texts differ only by "inferred" and its one-line note |
| QA adv scenarios | ran | 7 ran, 0 page errors | texts differ where the stamp wording changed |
| Replay A/B, 3 interleaved runs | 27 / 1 | 27 / 1 | see below |
| Replay A/B, one interleaved pair (the trimmed gate) | none | **28 / 0** | pacing limits pass |

The spec-updated copies are in `term211/tests/updated211/`; each file's first line lists what changed (wording only).

**The 4 differences in control identity vs 2.1.0** are one check, once per state: "window.fetch is the browser's own on the base page". 2.1.0 is the base in that run and 2.1.0 already watches the three POSTs through its pass-through, so the base fails its own check. The other 88 (same buttons, same words, same inline handlers, same 16 handler functions, same control DOM) pass, and request parity vs 2.1.0 is IDENTICAL.

## Replay smoothness

- Known difference, accepted by Mac: the candle-shape count at chart 4x. It is one sample per animation frame, so it moves run to run on the same page. Reference readings in four earlier gates: 16, 17, 17, 19. On 2.1.1: reference 18, 18, 18 against page 17, 17, 18 (first freeze); reference 18, 18, 17 against page 18, 18, 17 (final bytes); 17 against 17 (single pair). The test now prints every run's count and compares the page with the reference's lowest of 3 or more runs (`tests/replay-smooth-ab-211.test.cjs`).
- Pacing on the final bytes, 3-run A/B: every p95 and max frame gap inside its limit; one miss, reel 4x long tasks 1988 ms against a limit of 1883 (1.15 × the reference's best-run 1585 + 60). The single interleaved pair read 2020 ms against the reference's 1923 and passed. The reference itself has read 1585, 1790, 1923 and 2072 ms on that case across gates, and 2.1.0 read 2086. I read the miss as run-to-run spread, not a cost of 2.1.1, but it is one failed run out of two and is recorded as such.
- Nothing new runs per frame. The new renderers run from the existing 1 s render, only on a shown tab, rebuild only when the snapshot object changes, and the Levels row patch is skipped while a replay plays.

## Not verified / limits

- Built against `edge2/SNAPSHOT-CONTRACT.md` and its sample; no live edge r1.1 snapshot with real trades was available. The bot's ack for a halted bot is not in the contract: any ack whose result or reason says "halt" is shown as REFUSED.
- "NY runner" uses the session name only when exactly one session runs the ATR plan in `rules.sessionRunner`, and "stop +2" comes from `rules.sessionRunnerNy`: both are today's settings, not facts stored on the trade. If the settings change, older rows would be labelled with the new ones. A `rule.session` and `rule.stopPts` on the trade would close this.
- Scorecard: the bot sends no points figure for early exit, so "points saved" reads UNKNOWN.
- Whether Mac's own journal holds FILL_OBSERVED rows for the two trades in his screenshot was not checked (no copy here).

## NEXT

- Review trade cards: the rule line sits in the card's summary; long lines wrap to three lines at 390 px.
- Levels row: "28,143.25 broker avg" wraps under the side word at 390 px.
- "Last request the bot handled" line on Control after a page reload (the receipts live in the page's memory).
- News row and balance age from the r1.1 `news.loaded` / `balanceReadAt` fields beyond the one line added.

## Files

- `term211/mobile.html` (read-only), `mobile.html.inputs.txt`
- `term211/src/`: `t210.js`, `t210-control.js`, `t211.js` (new), css, `build-2111.cjs`
- `term211/tests/`: `surfaces-211.test.cjs`, `fixtures-211.py`, `updated211/`, `replay-smooth-ab-211.test.cjs`, `gate-211.sh`, `shots-211.cjs`
- `term211/h211/`: the shadow harness with the edge r1 proxy and the e11-* fixture states
- `term211/gate/`: logs. `term211/gate-superseded-4e1927a6/`: the full gate of the first freeze
- `term211/shots/`: 8 screenshots, 390×844 at 2×, all marked Replay
