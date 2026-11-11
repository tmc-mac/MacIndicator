# Loophole register

Everything known to cost money or block the objective (pass the $50K combine, then a payout). Rules for this file are in `office/LOOP.md` section 5. Statuses: `observed` → `measured` → `recording` → `live` → `kept` / `killed`. Entries are never deleted.

Seeded 11/11 from the 11/11 edge studies (149 levels trades, 10/28-11/10, live journal), the 11/02 NY study, the combine plan and tonight's live session. Dollar figures are from those studies and are first-order: they are estimates until the daily cycle measures them live.

## Strategy leaks

| Id | Leak | Evidence | Status | Next step |
|---|---|---|---|---|
| L-01 | Full stops never work: the trades that go to the full stop were almost never in profit | Median best excursion +0.75 pts, 3.7 min in. Early exit estimated +$663 on 9 trades | **live** since 11/11 (early exit, switchable) | Keep / kill at 20 live cases. Watch "early exits that would have hit TP1" (rig witness: 1 of 1) |
| L-02 | The runner is dead weight in Asia and London | Runner study B | **live** since 11/11 (all out at TP1 in Asia / London) | First live trade +$86.34 against +$75.84 under the old rule. Keep / kill at 20 |
| L-03 | NY: the first target is small against NY candles | TP1 +15 is 0.25x an NY 5m candle. NY reaches +15 before -50 in 67% of trades; break-even needs 77% | **recording** (TP1 = 0.75 x ATR, record-only) | Offline it showed +$4,009 but nearly doubled full stops. Verdict at 20 resolved |
| L-04 | NY runner: fixed runner leaves money in trends | NY ATR runner +$1,240 on n=18 | **live** since 11/11 | Small sample. Keep / kill at 20 |
| L-05 | Control gate reads "flat" while the indicator shows a side | 10/28 study: 56 of 57 disagreements, 15% of 15m bars. 11/11 live: 0.158 vs 0.22, blocked | **live** since 11/11 05:14Z (bot uses the indicator's formula) | P&L effect not measured. Compare gate passes and their results before / after the switch |
| L-06 | Trades skipped when the planned stop is wider than the 50-pt cap | Mac, 11/10: "I don't want to continue to skip these trades". Capped sizing on the rig, 5 days: -$21 to -$434 with 7-8 full stops against -$53 with 3 | **measured**, held OFF (switch exists) | Count skipped signals per day and what they did next; revisit with that data |
| L-07 | Re-entry right after a full stop | Idea from the loss study; not measured | **observed** | Measure: result of the next trade in the same direction within 30 min of a full stop |
| L-08 | High-volatility days: same size and stop as quiet days | NY candles 1.5-1.7x Asia's; "moves have been way bigger than they were historically" (Mac) | **observed** | Measure by ATR tercile: stops, wins, net. Candidate: a volatility gauge, record-only |
| L-09 | Tightening the stop to 25 pts | 11/03-11/04: 12 full stops in 28 trades (tripled) | **killed** | Keep the accurate stop distance (standing order) |
| L-10 | Protect-after-profit (move the stop up once in profit) | Loss study A: loses | **killed** | None |
| L-11 | Entry filters (103 tested) | 0 survive the multiple-comparison correction | **killed** as a group | A new filter needs a reason first, then a test, not a search |

## Bot and data leaks

| Id | Leak | Evidence | Status | Next step |
|---|---|---|---|---|
| B-01 | One skipped fast check (about 20 s blind) at each 15m close: "fetch failed" | Per-day counts 0,0,0,0,10,81,17 since the 11/09 restore. Cause: proxy closes idle connections after 5 s while the bar-close evaluation blocks the bot | Fixed in edge r1.2 (reviewed: ship with notes). Installed 11/11 06:24Z and ROLLED BACK at 06:28Z because of B-08, which is not caused by r1.2 | Reinstall once B-08 is mitigated and the r1.2 boot is re-measured with a server-size journal |
| B-02 | Flatten answered "already flat" from the bot's own state | Terminal 2.1.1 review | Phone side fixed in 2.1.3; bot side in edge r1.2 | Install r1.2 |
| B-03 | Entry price shows UNKNOWN on the phone until Review is opened | Mac's 11/10 screenshot | Phone side fixed in 2.1.1; bot side (fill on the trade row) in edge r1.2 | Install r1.2 |
| B-04 | The full ship gate (Mac-box run, restart soak) has not been run on the edge builds | Mac's "stop running replays & tests" (11/10) | **open** | Run it once on r1.2 in the reviewer desk; ask Mac before any long replay loop |
| B-05 | Indicator and bot read the forming candle seconds apart | 0.03 residual on 11/11 after the parity switch | **observed**, accepted | Only if it flips a gate for more than a minute |
| B-06 | After a restart the bot shows different levels from an uninterrupted run and skipped a short it otherwise takes | r1.2 restart soak, 11/02 window: the 14:46Z short was not taken after a 14:40Z restart. edge r1.1 does the same, so it is not new. Not established whether it is the rig or the bot | **observed** | Find out which. If it is the bot, every restart mid-session can cost trades |
| B-07 | Flatten tapped while the bot is already flat and the broker position cannot be read: repeated urgent pushes | r1.2 review F1 (code trace, not reproduced). Alerts only, no orders; could use up the day's push allowance | **observed**, new in edge r1.2 | Fix in edge r1.3 |
| B-08 | **The bot loads its whole trade journal into memory at every start and runs out of memory** | 11/11 06:25Z: edge r1.2 crash-looped right after install (heap limit FATAL 13 s after the live loop). After the rollback edge r1.1 died the same way at 06:29Z. Journal 98.7 MB, server heap limit 493 MB, six full-file reads at startup. Every restart is at risk and it gets worse daily | **live incident**; mitigation: heap limit raised to 1,024 MB on the service (Mac, 11/11) | Next build: read the journal as a stream and keep only what each reader needs. Ship gate now boots with a server-size journal under the server's heap limit |
| B-09 | No trade taken while the bot crash-loops; restarts add rows to the journal | Same incident | **observed** | The health alert "restarts twice in 30 min" should have pushed Mac; check whether it did |

## Objective risks (Mac's decisions)

| Id | Risk | Evidence | Status |
|---|---|---|---|
| R-01 | Topstep's terms prohibit trading from a VPS or remote server | Combine plan, source dated 2026-09-17: a pass can be voided whatever the P&L | **Mac's ruling 11/11:** not a concern during the practice stage; Topstep's team gave him permission to use the VPS in practice. Revisit before connecting to a real combine |
| R-02 | No daily loss limit: 7 full stops in one day breaches the combine the same day | Combine plan section 3 | **Mac's ruling 11/11:** accepted for the testing stage ("seeing the max our system can win or lose in a day"). No daily stop rule. The daily cycle reports each day's best and worst result and the worst stop streak |
| R-03 | Consistency: one day over $1,650 raises the target | Combine plan section 4 | Tracked daily (`bestDayPct`) |
| R-04 | The bot is on a practice account; no combine is running | 11/11 phone header | **Mac's ruling 11/11:** "If we can focus on passing a practice combine we will eventually pass a real one." The working target is passing the practice (virtual) combine; no real-combine start date is being chased |
