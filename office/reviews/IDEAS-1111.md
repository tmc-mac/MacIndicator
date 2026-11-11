# Ideas desk, 11/11: ranked list (8)

Source: office/state/ledger.json (404 trades, 27 TradeDays, 9/25-11/11; journal has no TradeDays for 11/05-11/09 except 11/09-11/10 rows) plus studies A-D and the virtual combine in office.json. All figures are first-order (same entries, no replay). "3c" = 3 contracts. Early ledger days (9/25-10/26) mix 1-5 contracts (Mac-source trades), so I use the 10/27+ window (3c, 9 days, 182 trades, -$1,136, 32 full stops) where size matters, and "scaled to 3c" (net x 3/contracts) where I need all 27 days.

Context number: the virtual combine has 20 starts: 0 passed, 14 breached, 6 open. Last 10 days average -$58.83/day against the +$189/day needed. Ideas below protect the floor or remove known leaks; none of them alone makes the bot a +$189/day bot.

## Ranked

### 1. Fix "TP1 touched, limit not filled, then full stop" (type b, mechanism-based, nothing scanned)
- Moves: full stops per 10 trades; net per day.
- Evidence (ledger, full stops with a best-excursion reading, 72 of 131): 9 full stops had MFE of +15.0 or more and tp1Hit false: 10/20 x2, 10/22 x3, 10/23, 10/26, 10/29, 11/10. Net -$2,078 (n=9). Another 3 reached +14.0..14.9 (-$591 more, would not fill at 15 either). 6 of the 9 are NY or London. If each had filled TP1 (about +$84 as in study A) instead of -$231 average, first-order +$2.8k on 14 trading days. Upper bound: MFE comes mostly from price polls (52 of 72 readings), a touch may be a poll artifact; the 11/10 20:10 PT case is a witnessed exact touch with no fill (L-13).
- Tried, no effect: "protect after +10/+12 MFE" (study A, loses, L-10 killed). This differs: it only acts when the first target price itself has traded.
- Rule: once price has traded at entry+15 (or the limit price) and TP1 is unfilled for 1 poll, cancel and replace TP1 at the market, or place TP1 one tick inside from the start (14.75). Cost of the tick: about $1.5 per TP1 win. Risk to live: small (order placement); needs the rig witness.
- Pre-written kill rule: after 20 TP1 exits, if the count of "touched +15 unfilled then full stop" is not down from 9 per 14 days (0.64/day) to under 0.3/day, or TP1 hit rate falls below 60%, switch off.
- Undo: switch.

### 2. NY after 09:00 PT stand-down, shadow counter first (type a now, then b) - WHEN not to trade
- Moves: net per day in NY, full stops. NY is the biggest dollar drain in the window (-$1,021, 45 trades, 11 full stops).
- Evidence: NY trades entered 09:00-13:00 PT: n=92, -$3,147 raw, 30 full stops, 49 wins (53%); both date halves negative (scaled to 3c: H1 10/20 and before -$635, H2 -$2,234); 13 of 21 days negative; leave-worst-day-out still -$2,172; 10/27+ window n=31, -$1,025. NY 06:30-09:00 PT is positive in H2 (n=34, +$731, scaled) and -$224 in H1 (n=19), so the open is the working part, mid/late NY is not. Mechanism: lunch-hour chop after the open range is spent (candles in NY are the largest, 1.5-1.7x Asia, study D).
- Search caveat: I looked at about 12 time cuts (NY thirds, Asia 15-16 and 21-24, London 04-06:30, 24 single hours as a table). Asia and London cuts did NOT hold: Asia 21-24 -$448 n=43 (both halves small negative), London 04-06:30 H1 -$1,060 but H2 -$52. Single hours 9 and 11 PT are the worst (-$1,349 n=29, -$1,467 n=20) but that is a 24-bucket scan; I rely on the NY block only.
- Build: record a "would be blocked" flag per trade (journal field) and an X-07 block, 20 cases. Live rule only after Mac's go; kill if the blocked NY trades net zero or better over 20 cases.
- Undo: flag only; the live rule has a switch.

### 3. Daily-loss circuit breaker: what-if counter now, Mac decides later (type a + c) - risk against the floor
- Moves: worst day vs the $2,000 trailing floor. There is no daily loss limit in this combine, so one bad day is the main way to breach (11/03: -$1,532 = 77% of the floor, 11 full stops, 25-pt stop era).
- Evidence (4 thresholds tried, all in the table): stop for the day at cumulative -$400 / -$600 / -$800 / -$1,000. 27 days scaled to 3c, baseline -$5,832: -$3,839 / -$4,721 / -$5,354 / -$5,326 (+$1,993 / +$1,111 / +$478 / +$506). 10/27+ window baseline -$1,136: -$52 / +$88 / -$254 / -$812. Excluding 11/03 the effect shrinks to -$30 / +$392 / +$177 / -$86. So it is one day's story, small sample. Variants that did not help: "stop the day after 3 full stops" (+$975 window, but 2 gives only +$280); "stop one session after 2 full stops" -$744 (worse).
- Conflict: LOOP.md says "no daily stop rule" by Mac's design (practice measures the most the system can lose). So: record only, show on the terminal "day stop at -$600 would have saved $X today", and put one line in the next weekly card. Real-combine start is Mac's call.
- Undo: none needed (display).

### 4. Terminal "floor cockpit" (type a, terminal tool for Mac's decisions)
- One card: room above the trailing floor INCLUDING open P&L (Topstep monitors in real time; our ledger is closed trades only), today's net, full stops today, best day / $1,650 consistency headroom, days left and $/day needed (office.json already has these), plus "what a day stop at -$600 / the NY-late block would have done today" from ideas 2-3.
- Evidence it matters: open P&L lowers the day low in 3 of 9 recent days (11/04 -$551 closed vs -$676 with MAE; 11/10 -$453 vs -$566; 10/27 -$1,097 vs -$1,193) but never changed a pass/breach result in this sample. The value is for Mac's size/stop decisions in real time, not a P&L gain.
- Cost: a few hours, zero live risk; reads office.json only.

### 5. Process: one live change at a time, plus a package-level kill rule (type c)
- 11/11 turned on 5 rules at once (X-02..X-05 + parity): the ledger splits before/after, but the effects cannot be separated, and the per-rule 20-case clocks run at very different speeds (X-02 1 of 20, X-03 1 of 20, X-04 0 of 20 after the first day). Evidence: STATUS.md; the first live day is +$463 (n=9) against a -$58.83/day prior, which proves nothing either way.
- Proposal: (a) judge the package by net per day vs the previous regime, pre-written (kill the package if 10 days average below -$58.83/day or 2 days under -$800); (b) each rule still keeps its own shadow fields (earlyAdverse.shadow, tp1 ATR shadow) so per-rule counterfactuals come from the same trades; (c) from now on a new live rule waits for the previous one's 20 cases unless it fixes a bug. Cost: zero. Undo: none.

### 6. SIZE: re-run the virtual combines at 1, 2 and 3 contracts, record-only (type a), then a vol-tier size rule only if it shows
- Evidence (crude: 27 overlapping starts on days scaled linearly, ignores the 55% rule): 3c 24 breach / 3 open / 0 pass; 2c 17 / 10 / 0; 1c 10 / 17 / 0. Smaller size delays breaching, does not create a pass, and the target needs +$189/day. Size by after-full-stop state did NOT show an effect: next same-session trade after a full stop n=27 -$322 vs after anything else n=132 -$325 (the same per-trade level). Size by volatility (study D, top ATR tercile n=49, -$896, 15 of 26 full stops): going to 2c there saves about 1/3 = $300 over 17 days, small, one tercile definition, tangled with NY.
- So: do the cheap replay (an extra table in the weekly), not a live size rule. Seen at 5 contracts: n=102 trades -$5,115, but those are early Mac-era days; not evidence for or against size now.
- Floor arithmetic for the decision: a 50-pt full stop at 3c = about $300 + fees = 15% of the floor; 7 full stops in a day would breach. At 2c it takes 10.

### 7. Probability-of-pass number on the scoreboard (type a)
- Replace "passed/breached/open" with a bootstrap of the last N 3c days under the current rule set: chance to touch +$3,000 before -$2,000 EOD floor within the days left (14 TradeDays to 11/30), with the 55% best-day rule. It tells Mac in one number whether to change risk. Needs the data to exist first (only 3 days under the 11/11 rule set), so ship the tool now, read it from about 10 days.

### 8. Near-expiry housekeeping: tag each trade with its time-in-day rank and prior-trade result (type a)
- Evidence: trade #1 of the day -$504 (n=9 days), trade #7 +$724; no pattern at n=9. This is only a field that makes ideas 2, 3 and 6 testable later without re-deriving it. Lowest priority; do only if the journal change is already open.

## Drop or defer
- DEFER L-08 volatility gauge as a size-down: measured $300 per 17 days, small; keep it record-only inside idea 6.
- DEFER L-12 as a live rule: 59 no-progress exits in the 10/27+ window, -$2,206, but 19 of 59 are winners; without minute paths after exit it cannot be judged (already noted in the register). Keep as analysis.
- KEEP OFF L-06 (wide-stop trades): measured -$21 to -$434 with more full stops.
- DO NOT run more entry-filter or level scans: 0 of 103 survive; level cuts like "London Low -$2,148 n=13" come out of a ~26-level scan and both halves negative is not enough. If wanted, treat as a hypothesis with a stated reason first.
- DEFER X-01 live promotion of the ATR TP1 (offline it nearly doubled full stops); recording only.
- DEFER X-06 as a live rule: count first (0 of 20), Asia and London only.

## Number we are not measuring (single most useful)
The chance to pass: the distribution of net per TradeDay under the current rules, with a real-time floor room including open P&L. We have 3 days under the 11/11 rule set and the combine's own daily rule counts open P&L, so the answer to "can this get +$2,645 in 14 days" is currently unknown. Runner-up: how often price has touched the TP1 price without a fill (idea 1; only 52 of 72 MFE readings are poll-based).

## Numbers I could not get
- True intraday equity low including open P&L (only MAE per trade, one trade at a time).
- ATR at entry per trade for all 404 trades (only the 11/11 trades carry atr15; study D had 149).
- MFE for 59 of 131 full stops (so idea 1 is a floor).
- TradeDays 11/05-11/08 (missing from the ledger), so W45 and W46 are partial.
- Whether Topstep records a pass at touch or at day close (UNCONFIRMED in the combine plan).

## Best for the next live-rule experiment
Idea 1 (TP1 touched, not filled). It has a mechanism, a witnessed case, 13 sample trades and the smallest live risk. Idea 2 should run as a shadow counter beside it.
