# Phone terminal 2.0.9.25 — what changes against 2.0.9.24 (d7d70059)  — DRAFT, NOT SEALED (MacUI-D, 11/05 22:00Z)

Display only. The page sends the same requests as 2.0.9.24 (poll paths and buttons unchanged). Built from the 2.0.9.24 chain: `build-inputs/build-20925.cjs` = build-20924.cjs + the 2.0.9.25 step (ONE new script last, `feat-20925.js`, one stylesheet last, `r20925.css`; every other input byte-identical to 2.0.9.24). Page sha256 `871fada5deb74acedd39f63e68b274861c660d271ded4939d12017cea27da528`. `MACUI_RELEASE=2.0.9.24` through build-20925.cjs still gives d7d70059 (checked).

**Status at the FINAL CUT (Mac wrapping up): the page is built and its own witness is 46 passed / 1 failed (X1, LAST REJECT). The full gate was started at 22:00Z on these bytes and had NOT finished at the cut, so this package is NOT sealed.** The next desk reads `/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/macui-n/gate25/` (log `/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/macui-n/gate25-GATE-LOG.txt`), re-runs any TIDE-off identity diff alone, looks at the shots, and seals or fixes. Partial results on earlier bytes of this build (same features, earlier CSS / test fixes): qc-20925 37/0 and feat-20922 27/0 on 59bb18f6 (`gate25-run3-59bb18f6/`), shot-tabs OK sideways 0 errors 0.

## In this build (feat-20925.js, active only while snapshot.tide is shadow / live; TIDE off → nothing touched)
0. **MacMillionz naming** (Mac 11/05 13:35 PT). Every user-facing text node reading "TIDE" reads "MacMillionz" ("TIDE TRADES" → "MACMILLIONZ BOT TRADES"; the header pill "TIDE LIVE" → "LIVE"; "TIDE warming up" → "MacMillionz warming up"; "Bot trades" → "MacMillionz trades"). Kept as the engine's own words: the Why? dumps (.fx24-why), the signal-row dumps, pre / code, exports' technical fields, setup ids. Witness B1–B3.
0b. **Trades tab from the merged set.** Bot records (feat-20924's: tide.rows signal / setup_arm / live_* + tide.trades) ∪ the account round trips feat-20924 could not match, deduped by order / position id, bucketed by TradeDay (15:00 PT). A TradeDay the old /trade-list has no card for gets a card on top (name, "TradeDay from <Wed> 3:00 PM PT", total, won/lost bar, rows: time · side · size · level · kind · lots · pts · $ · R · exits). Existing cards (e.g. Nov 4) untouched. The tiles: This TradeDay = the header figure (account.dayNet / dayPnlNet, else the merged sum), Closed, Win / loss by R (±0.1R even; by $ sign when no R), Open = tide.position. Witness T1–T5 on t24-tide1105 (a Tue Nov 3 card, 4 rows, +$587.78 / 4 / W-L / 0).
1. **Day P&L cell**: at most two lines under the number at 360 / 375 / 390; "balance +$712.65 · −$504.29 vs fills" in full (nowrap + ellipsis, never clipped mid-word onto a third line); the trip list is a tap-only dropdown (never inline). Witness P2 / P3 at 390 / 375 / 360.
2. **One day number**: the Rolling P&L card headline = the same fills figure as the header; its sub-line "balance change +$712.65 · includes a −$504.29 non-trading adjustment (payout/reset)" when the balance differs by > $1; title sub "today · from fills". Day peak / Given back are NOT recomputed on the fills series (left as the page computes them from the balance; stated limit). Witness P1 / P4 on t25-pnl (dayPnlNet 1216.94, day.rolling 712.65).
3. **WARMING UP pill** (neutral, from tide.warm.rebuilding / doneMin < totalMin); "Blocked" never shows for the warm-up. Witness W1 / W2 on t23-warm.
4. **Review net from fills**: when the journal's money word is "gross (bot)" / a "net pending" line exists, the day net = Σ over the TradeDay's closed bot records of realizedUsd / netUsd, else Σ(exit − entry) × qty × dir × $2 − fees; word "net (from fills)"; the pending line removed. "gross (bot)" stays only when a closed trade has no exit fill. Witness J1.
5. **Decision card**: Mac's eleven rows under the TREND LANE verdict, from the r1.6.1 rows (trend_arm / trend_signal / trend_skip / trend_idle: dirEv.prev4h, open4h, h30.open30 / last30, R / rName / trigger / def / why / taken; tide.board.control; the next 30M / 5m close from the clock). The bot's idle reason wins over the board's prev4h. An r1.5.6-style snapshot (no trend rows) says so. Witness D1–D7 (idle-no-dir, idle-harmony, watching, taken, skipped GRADE_NO_FIT, CAP_HOUR, no rows).
6. **STALE cancels (rule 18 v3)**: already in the tape as the × tick with the bot's why on tap (2.0.9.20 design); witness X2 on t25-stale. No page change.
7. Version: macui.pageVersion / copies / exports say 2.0.9.25; feat-20922 V1 expects 2.0.9.25.

## Built but witness RED (do not count as in)
- **LAST REJECT line** on the bot card from tide.lastReject / order_reject rows: code in feat-20925.js (lastReject), witness X1 fails (the card lookup finds no .fx18-hd .fx18-t in the fixture's DOM) — the next desk fixes the selector or removes the function.

## Not in this build (left for 2.0.9.26, with the reason)
- Sessions boxes' own $ figures from the single trade set (feat-20911 boxes: not reached in the time box).
- TIDE journal P&L on Review beyond the day net (per-trade $ from fills is on the rows since .24).
- HTF H3 / H5 / H7 of qc-20922 (need the WITH HTF tag on the armed setup and the tape tick; not started).
- plan-leak N3 wording: not changed; the witness still reads "TIDE scanning · …" (now branded "MacMillionz scanning") — N3 will FAIL on wording; decision on the truthful wording still open.
- "Show on Levels" scroll-and-highlight (qc-20923 R2–R6): not started.
- Day peak / Given back on the fills series: not recomputed.
- The TRADER SANITY walk across the six tabs at 360 / 375 / 390 / 428: not done (the cut); the witness covers 360 / 375 / 390 of the Day P&L cell only.

## Known effects on the other suites (expected, to be confirmed by the gate)
- qc-20924 V1 (expects 2.0.9.24) fails by design on .25; M-lines may change where the text now reads "MacMillionz" (e.g. "TIDE TRADES").
- plan-leak N3 and any assertion on the literal word "TIDE" in user-facing text fail on the renamed label; qc-20923 R2–R6 unchanged (not in this build).
- Identity vs 2.0.9.24 (TIDE-off states) must be byte-identical: feat-20925 returns before touching the DOM when snapshot.tide is off/absent (witness I1 on 'flat').

## Limits
- The MutationObserver pass is coalesced per animation frame with a 12-passes-a-second budget (a microtask flush froze the page against feat-20924's observer in the first run).
- Fixtures are SYNTHETIC (field names from lib/trendLane.js and tideWire.js r1.6.1, not a captured live row).
- No identifiers in this package. No commit, no post, nothing touched outside the scratchpad.
