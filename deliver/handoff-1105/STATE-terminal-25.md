# STATE — phone terminal 2.0.9.25, builder MacUI-D, stopped 22:01Z 11/05. NOT SEALED, NOT ZIPPED.
Candidate: deliver/handoff-1105/wip/terminal-2.0.9.25-candidate/mobile.html, sha256 871fada5deb74acedd39f63e68b274861c660d271ded4939d12017cea27da528. MACUI_RELEASE=2.0.9.24 through build-20925.cjs still gives d7d70059 (checked).
Build chain: build-20925.cjs (= build-20924.cjs + one R25 step), v2src/feat-20925.js (one script last), v2src/r20925.css (one stylesheet last); all other inputs byte-identical to .24. Copies in build-inputs/.

## Gate: NOT clean
- qc-20925 (47 checks) on 871fada5: 46 passed, 1 failed (X1 LAST REJECT).
- Earlier bytes 59bb18f6 (before the Trades-tab/Review additions): qc-20925 37/0, feat-20922 27/0, shot-tabs OK, sideways 0.
- identity vs 2.0.9.24, qc-20922/23/24, plan-leak-20921, no-sideways on 871fada5: NO RESULTS (the gate had just started when stopped).
- Expected by design: qc-20924 V1 fails (expects 2.0.9.24); plan-leak N3 and any assertion on the literal "TIDE" label fail on the rename; qc-20923 R2–R6 fail (not built).

## DONE (witnessed green in qc-20925; active only when snapshot.tide is shadow/live)
- MacMillionz naming: DOM text pass renames user-facing "TIDE" -> "MacMillionz", "TIDE TRADES" -> "MACMILLIONZ BOT TRADES", pill "LIVE", "MacMillionz warming up", "Bot trades" -> "MacMillionz trades"; Why? dumps, signal rows, pre/code, exports, setup ids kept.
- Nov 5 day card: Trades tab day cards from the merged set (feat-20924 records ∪ unmatched account trips, dedup by id, TradeDay 15:00 PT) for TradeDays the old list has no card for.
- Bot-trades stats tiles: This TradeDay (= header figure) · Closed · Win / loss by R (±0.1R even) · Open.
- One P&L per card; header and Rolling P&L both +$1,216.94 on the fixture; sub-line "balance change +$712.65 · includes a −$504.29 non-trading adjustment (payout/reset)".
- Clipping: Day P&L cell ≤ 2 lines at 360/375/390; trip list tap-only dropdown.
- WARMING UP pill + "MacMillionz warming up · n of 360 min".
- Review: "net (from fills)", no "net pending".
- Decision card: Mac's 11 rows from trend_arm/signal/skip/idle rows.
- STALE cancels already in the tape (× tick, why on tap); UNKNOWN-AUDIT-25.md written.

## BUILT, WITNESS RED
- LAST REJECT line (lastReject() in feat-20925.js; X1 fails: selector finds no .fx18-hd .fx18-t). Fix the selector or remove.

## NOT DONE
Sessions boxes $ from the single set; journal P&L beyond the day net; HTF H3/H5/H7; plan-leak N3 wording; Show on Levels scroll+highlight (R2–R6); Day peak / Given back on the fills series; trader-sanity walk across six tabs at 360/375/390/428; shots at 428 and dark+light review of 871fada5.

## Risks
- Rename is a DOM text pass under a MutationObserver (coalesced per frame, ≤12 passes/s then 1 s rest); first version froze the page against feat-20924's observer (fixed), flicker/ping-pong on heavy re-renders not ruled out: watch Trades/Review.
- Identity vs .24 on TIDE-off states unverified on final bytes.
- Day-card dedupe is by name of existing cards: a TradeDay that already has an old-list card gets no bot card.
- Fixtures are synthetic (field names from trendLane.js/tideWire.js r1.6.1, not captured rows): t25-pnl, t25-idle-nodir, t25-idle-harm, t25-watch, t25-taken, t25-skip, t25-caps, t25-stale (builder tests/build-fixtures-20925.py). Field review against a LIVE r1.6.2 export is mandatory before Mac sees it.
- Package docs: CHANGES-20925.md DRAFT; INSTALL sheet has <HOST>; set-terminal.sh unchanged d891ef9d.
