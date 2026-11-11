# Terminal 2.2.2 review (mobile.html sha256 99ec1630…, unchanged after my runs)

## Verdict: SEND WITH RULES.

Every item I asked for is closed, the new trade-detail change works and is worth keeping, requests are the same as 2.2.1, and a quiet-as-possible replay A/B of 2.2.2 against 2.2 passed twice (28 / 0 and 14 / 0): 2.2.2 is not worse than 2.2. Two cosmetic limits remain, plus one rule.

**Rule:** the page reads the point value from the snapshot's `symbol`. If a snapshot ever arrives with no symbol or one outside MNQ / MES / MGC, every closed trade reads "pts UNKNOWN · point value unknown …" (safe, but blank). Mac's bot sends `MNQ` (`SYMBOL` upper-cased from its argument; checked in the sample snapshot and the r1.3 code). If rows go UNKNOWN after install, that is the first thing to look at.

## Items from the 2.2.1 review

| Item | Status | Evidence (`rv-222.out`, `rv-222b-term222.out`, `rv-222c`) |
|---|---|---|
| A3 point value from `symbol` | CLOSED | MES ordinary exit −16.25 pts; MGC −16.25; MES multi-fill gross path −16.67 (2.2.1 painted −40.63 for the MES case); lower-case / padded " mes " accepted. Unknown symbol (MXY), no symbol (checked in the first run), an object, "constructor", "__proto__": all UNKNOWN with "point value unknown for …", no number. Symbol text is cut to letters and digits before it is shown |
| A4 wording | CLOSED | Closed, bot fill held, no exit, no round trip: entry "28,000.25 bot fill", "pts UNKNOWN · exit not settled by the broker yet". Nothing held: "no fill seen" |
| C result R / peak R | CLOSED | "result −0.63 R" on Now, Trades, Levels (today and saved), Review; the Levels line reads "peak R UNKNOWN (needs the bot's own entry fill)" and "peak +0.09 R"; trade-detail "Best / worst" is "Peak / worst". No "best R" on any of the four tabs |
| Older saved rows | CLOSED | No exit block, no round trip, `settled: 'broker'`, `pts` 10, net 56.34: "10.00 pts (bot, from broker)", entry UNKNOWN, explanatory detail line, tooltip says the prices are not checked. Painted on Levels: "−16.25 pts (bot, from broker) · net −$101.16 … result −0.33 R", no "(broker)" tag on the row. Recorded pts that do not tie (12 vs 10), a sign flip (−10 vs +56.34), settled "paper" or no net: UNKNOWN. A multi-fill saved row whose exit price cannot make the net reads +30.00 (bot, from broker) with its own detail line |
| A2 entry guard | CLOSED | Bot entry 28,000 vs round trip 28,001.5 (1.5 away): resolves +30.00. 2.5 away: "round trip does not match this trade's entry". The cross-linked record (case 8a: another trade's round trip) is now refused. The bot's own match tolerance is 0.26, so real trades are not affected |
| A2, side contradiction (not asked) | still open, bot-impossible | A record with the opposite side to its round trip still reads +10.00 (broker) with an exit price on the wrong side. The bot's matcher requires equal direction, so this needs a bot fault |

## The unrequested change: trade-detail cells use the resolver. KEEP.

- What it does: wraps the page's `lvTradeStats` and rewrites the Result, Position (entry) and Duration cells of a closed trade from the same resolver. Painted: "Result −31.50 pts (broker) · result −0.63 R", "Exit 28,216.50 avg (broker)", "Duration 6 min · broker fill to exit", "Peak / worst +0.08 R / −0.63 R". Before, the same cells said "points UNKNOWN (no observed entry price)" for a trade the rest of the page showed.
- Safe by construction: it runs inside a try / catch and returns the page's own HTML on any error; the text it inserts comes from the resolver (numbers, fixed words, the symbol cut to letters and digits). The regexes fail to match rather than corrupt.
- Not a regression: for a paper trade with no exit the cell said "points UNKNOWN (no observed entry price)" in 2.2.1 and says "pts UNKNOWN · no fill seen" now; for a live closed-unsettled trade "Result —" became "pts UNKNOWN · no fill seen". Cost: the replay tick calls it once at the end of the 7 s replay (the per-frame stats are a different function); per call it is an index lookup plus a few regexes on a small string.
- One thing it does not do: for a trade whose bot fill differs from the broker average the Position cell still shows the bot's fill "(fill observed)" while the points come from the broker average. Both are labelled, and the row detail line says "bot saw the fill at … broker average … slip …".
- The builder's sentence "where the resolver has nothing, the page's own wording stays" is not quite true (the Result cell is replaced with the resolver's UNKNOWN text); harmless.

## Known limits, ruled
- **Flight-recorder header keeps "6 min from order sent · fill time unknown" above the resolver's line** "entry 28,248.00 broker avg · −31.50 pts (broker) · 6 min · broker fill to exit". Confirmed painted. It is the same two-stories-one-trade pattern Mac complained about, in the one place not yet fixed; both durations are the same number. Not a wrong number: **ship, fix in the next build** (hide the page's line when the resolver has a duration; also the header's "entry ref 28,248.00 (unverified)").
- **Signal Path event text** ("Exit … points UNKNOWN (no observed entry price)") unchanged: ship, same next build.

## Network
2.2.1 and 2.2.2 made the same requests across Now, Trades, Levels, Review and a replay: `/mobile.html`, `/bias`, `/trade-list`, `/trade-stats`, `/signal-journal`, and the one external read of the Office file. Identical sets (compared by path). Diff 2.2.1 → 2.2.2 is 17 hunks, all in the resolver, its wording and the new wrapper, plus the release string and a comment: none in a handler, `fetch`, the receipt model, the broker card, the Office module or the cascade. The builder's request capture is IDENTICAL; I did not re-run it.

## Replay A/B: 2.2 (768134e8) vs 2.2.2, alternating, 3 runs per case
Run on the harness with the 2.2 page as the reference and 2.2.2 as the page under test, nice 19, one browser, each run started below load 3 (2.5 to 3.0; another desk's bot boot tests were running throughout, so the machine was never quiet).

| Case | Run 1 | Run 2 |
|---|---|---|
| reel 1x | 3 runs each: p95 gap 33.4 vs 33.4, max gap 83 vs 117, long tasks 385 vs 441 ms | not repeated |
| reel 4x | p95 50.0 vs 50.0, max 483 vs 483, long tasks 2023 vs 1952 ms | not repeated |
| chart 1x | p95 33.4 vs 33.4, max 100 vs 100, long tasks 333 vs 349 ms | max 83 vs 83, 307 vs 314 ms |
| chart 4x | p95 33.4 vs 33.4, max 500 vs 450, long tasks 1803 vs 1609 ms (page higher) | p95 49.9 vs 33.4, max 433 vs 417, long tasks 1535 vs 1656 ms (page lower) |
| Result | **28 passed, 0 failed** | **14 passed, 0 failed** |

The one measure where the page read higher in run 1 (chart 4x long tasks, +12 %) read lower in run 2 (−7 %), and shape counts and brain checks were equal or better. That is noise, not a regression; the builder's earlier failures (against 2.0.9.10, different limits each time) look like the same noise. The skip while a replay plays is as in 2.2.1 (the row patcher and the Levels rows return when a reel is playing).

## Install risk
- Display only: no request, handler, receipt, Office or cascade change, so installing over 2.2 with `set-terminal.sh` needs no bot restart and cannot affect orders. Undo is reinstalling the 768134e8 page.
- The visible differences Mac will notice: "result" before R, "peak R" instead of "best R", "(bot, from broker)" on older saved rows, "exit not settled by the broker yet" in the minutes after a close, and (until the next build) the old duration line in the flight-recorder header.
- First thing to check after install: a closed trade on Now / Trades / Levels shows points with "(broker)" and the same number on each tab.

## Not checked
- The builder's gate suites (log clean except the known external-request line); visual style; bot changes.
- A true quiet-machine A/B (not possible while the bot desk was running).
- Real fills from Mac's bot; the "exit price is the volume-weighted exit average" claim is from the r1.3 code.
- In my painted runs the Trades tab showed SHORT for flipped-long fixtures; that is my fixture's journal, not the page.

Scripts and output: `rv-222.test.cjs` + `rv-222.out`, `rv-222b.test.cjs` + `rv-222b-term222.out` / `-term221.out`, `rv-222c.test.cjs`, `ab-22-vs-222-run1.out`, `ab-22-vs-222-run2.out`, `page-221-222.diff`.
