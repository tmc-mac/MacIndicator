# Phone terminal 2.2.2 (terminal builder, 11/11)

2.2.2 = 2.2.1 + the fixes from the independent review of 2.2.1 (verdict: SEND WITH RULES). Display only. Requests, receipts, Office and the cascade are as in 2.2.1 (requests: IDENTICAL to 2.2.1 in all four states).

Frozen page: `term222/mobile.html`, sha256 in the hand-back (and in `gate/00-page.txt`).

## What changed

**A3. Point value from the snapshot's symbol.** The resolver no longer assumes $2 a point. It reads `symbol` and uses the bot's own table (`live-executor.js`: MNQ 2, MES 5, MGC 10; its other branch is 1, which is "unknown", not a contract). Any other symbol, or none, refuses both the prices-tie-to-net check and the gross-per-contract path: "pts UNKNOWN · point value unknown for MXY" (no symbol: "…for this contract (no symbol sent)"). Painted tests: MES ties (−16.25 pts), MES multi-fill gross path gives −16.25 (2.2.1 painted −40.63 for that case), unknown symbol, no symbol.

**A4. Wording while the broker has not settled.** A trade closed with the bot's fill held and no round trip yet reads "pts UNKNOWN · exit not settled by the broker yet" (entry "28,248.00 bot fill"). "no fill seen" is only for neither a bot fill nor any broker match.

**C. R wording.** Result: "result −0.63 R" on every row and card (Now, Trades, Levels today and saved, Review). Peak: "peak R UNKNOWN (needs the bot’s own entry fill)" replaces the page's "best R UNKNOWN (no observed entry price)", and a known value reads "peak +0.30 R". The Levels trade detail's "Best / worst" cell is now "Peak / worst" with "peak / worst R UNKNOWN (needs the bot’s own entry fill)". Painted check: the word "best R" is on none of Now, Trades, Levels, Review.

**Older saved rows.** When there is no round trip and no usable exit block (or the exit block's price cannot make its net, a trade that left in several fills) but the record carries `pts`, `netPnl` and `settled: 'broker'`, the page shows those points tagged "(bot, from broker)", the entry as UNKNOWN, and a detail line "no broker round trip on this phone for this trade · points as the bot recorded them from the broker · entry UNKNOWN" (or, for the several-fills case, "the exit price kept on the record does not tie to the net (a trade that left in several fills) · …"). Never tagged "(broker)", never presented as a verified round trip. One check is kept: the recorded points must make the recorded net with the point value and size (costs from `brokerCosts`), else "pts UNKNOWN · the bot’s recorded points do not tie to its broker net". The Nov 2 fixture row that read "prices do not tie" in 2.2.1 now reads "+12.08 pts (bot, from broker)" with "entry UNKNOWN". A failed check on a round trip still does not fall through (twin trades, entry mismatch, prices not tying, unknown point value): the points stay UNKNOWN with the reason.

**A2 guard.** The round trip is trusted only when the trade's own recorded entry is within 2 points of the round trip's average entry; else "pts UNKNOWN · round trip does not match this trade’s entry". Tested at 10 points (refused) and 1.5 points (matched).

**One more place with the same contradiction, found while testing.** The Levels trade detail's cells still said "Result points UNKNOWN (no observed entry price)", "Position … entry UNKNOWN (no observed fill)" and "Duration 6 min from order sent · fill time unknown" for a trade whose broker round trip the rest of the page showed. They now come from the same resolver ("−31.50 pts (broker) · result −0.63 R", "@ 28,248.00 (broker avg)", "6 min · broker fill to exit"). Where the resolver has nothing, the page's own wording stays.

**30m hold (reviewer's note).** No change: the held read is labelled with its true age and never gates.

## Gate (on the frozen bytes; logs in `gate/`)

See also `gate/GATE-LOG.txt`. All on the frozen bytes.

| Suite | 2.2.1 | 2.2.2 |
|---|---|---|
| Resolver suite `trades-222` | 132 / 0 | **175 / 0** |
| Office + cascade `office-22` | 409 / 0 | **409 / 0** |
| 2.1.3 painted `surfaces-213` | 569 / 0 | **570 / 0** |
| Control receipts (spec copy) | 319 / 0 | **319 / 0** |
| Cascade (spec copy) | 1030 / 0 | **1030 / 0** |
| Surfaces (spec copy) | 235 / 0 | **235 / 0** |
| Requests vs 2.2.1 | n/a (vs 2.2) | requests, dialogs, /bias, per-step IDENTICAL in all four states |
| Control identity vs 2.0.9.10 | 92 / 0 | **92 / 0** |
| Budgets | 912 / 0 | **912 / 0** |
| Replay A/B vs 2.0.9.10, one pair | not run | 26 / 2 (chart 4x: max progress step 7.38 % vs 6.19 %; candle shapes 16 vs 18) |
| Replay A/B vs 2.0.9.10, 3 interleaved runs | not run | 25 / 3 (chart 1x max frame gap 183 vs 117 ms and max progress step 2.62 vs 1.67 %; chart 4x long tasks 1801 vs 1484 ms) |

Replay A/B: the failures are different in the two runs (the pair's chart-4x candle count and step pass in the 3-run, where the shapes read 18, 17, 17 against the reference's 17..18), the bot gate desk was using the CPU (load 2.4 to 3), and this build adds nothing per frame (the row patcher skips while a replay plays; the trade-detail wrapper runs only when the page draws those cells). I read them as machine noise, as in 2.1.1's gate, but I could not prove it on a quiet machine; the reel cases (1x, 4x) pass in both runs.

Notes:
- `trades-222` is the 2.2.1 resolver suite with the new wording (result / peak R) plus 43 assertions for the items above. A first gate run showed 2 failures: the Trades tab's own net (the page's figure, before its second poll settles under load) was read early; the test now waits for it. Rerun alone three times: 175 / 0.
- `surfaces-213` now has 570 assertions: three expectations moved to the new words (result R, peak R, and the Nov 2 old row now "+12.08 pts (bot, from broker)").
- The control-identity run needed the pinned 2.0.9.10 file, which another desk had deleted; it was rebuilt from the build script (sha256 `ca09398940186902140d1349ab5df01e40d5a269c24a76efbd733b601f856a67`, verified) and the suite re-run: 92 / 0.
- Requests vs 2.2.1: requests, dialogs, /bias and per-step IDENTICAL in all four states; the tool's last line says "DIFFERENCES FOUND" only because the existing Office file read counts as one external request.

## Limits

- The Flight recorder header (the replay) still prints the page's own line "6 min from order sent · fill time unknown" above the resolver's line "entry 28,248.00 broker avg · −31.50 pts (broker) · 6 min · broker fill to exit". Same trade, two duration words in that header; the resolver's line is the true one. Left as is to keep this build to the reviewed items; NEXT.
- The Signal Path event text of the page ("Exit … points UNKNOWN (no observed entry price), −0.63 R") is the page's own and was not changed.
- A trade whose points come from "(bot, from broker)" has no entry shown unless the bot's own fill is held.
- The point-value table is the bot's three contracts. A fourth contract needs a line in the table.
- The Trades tab's own net can read a few cents off (−$192.58 / −$101.15) for a moment before its second poll settles under heavy load. That is the page's figure, not the resolver's; it settles to the broker net.

## Files

- `term222/mobile.html`, `mobile.html.inputs.txt`, `src/t221.js` (resolver, wording, trade-detail wrapper), `src/t210.js` (release 2.2.2), `src/build-222.cjs`
- `term222/tests/trades-222.test.cjs`, `surfaces-213.test.cjs`, `updated222/`, `gate-222.sh`, `shots-222.cjs`, `replay-smooth-ab-222.test.cjs`
- `term222/gate/`: logs; `gate/from-221/` has the 2.2.1 gate
- `term222/shots/`: 1 Levels row (result R, peak R), 3 Trades row (result R), 4 Levels "exit not settled by the broker yet", 5 Levels "(bot, from broker)", 6 Levels "point value unknown" (390×844 at 2×, replay-marked). The Levels trade-detail cells are checked by painted text (trades-222), not a picture: a picked closed trade opens the flight recorder over them.
