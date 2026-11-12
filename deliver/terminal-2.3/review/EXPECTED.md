# EXPECTED numbers for terminal 2.3 (MacCheck-23, 11/12)

Computed by my own parser from the journal (`agent-line` at 453e1306, 76 slice files, 109,895 distinct rows, 418 closed trades), scripts in `calc/` (`ledger.py`, `trades.py`, `report.py`, `r2.py`, `r3.py`). I did not read the builder's page code, tool or tests. Rules taken from INSIGHT.md and the full-stop definition of `office/tools/loop_daily.py` (stop filled with no TP1 fill and no profit trail before it, or filled through the stop). Cross-check: every net, full-stop flag and best-excursion value equals the published `office/state/ledger.json` on the 416 trades both hold (0 differences).

Money is broker net for 3 MNQ unless stated. pts are per contract. Times are PT; TradeDay rolls at 15:00 PT.

## 1. Full stops, TradeDay 2026-11-10 (complete day): 2 stops, −$550.32

| | Stop 1 | Stop 2 |
|---|---|---|
| id (first 8) | 26e07b5b | 667680f7 |
| Entry | Mon 11/09 20:10:15 PT, Asia SHORT | Mon 11/09 23:57:40 PT, Asia SHORT |
| Level, event, grade | 1H Open, SWEEP-LOSS, B | 15m Open, SWEEP-LOSS, B |
| Control score | −0.33 (−0.3336) | −0.25 (−0.2546) |
| Fill / stop / exit | 27,891.75 / 27,932.00 / 27,933.50 | 27,970.25 / 28,018.75 / 28,019.00 |
| Stop distance | 40.25 pts | 48.50 pts |
| Gross / fees / commission / net | −250.50 / 2.16 / 1.50 / **−$254.16** | −292.50 / 2.16 / 1.50 / **−$296.16** |
| R (net ÷ stop pts × 3 × $2) | −1.05 (−1.052) | −1.02 (−1.018) |
| Minutes to the stop | 9.8 (9.799) | 4.2 (4.247) |
| Best (MFE) | **+15.00**, first reached in the minute ending 6.74 min (1-minute rows; the polls alone say +11.25) | **+11.75**, minute ending 3.33 min (polls alone say +6.00) |
| Worst (MAE) | **−41.75** (exit fill; last 1-minute row −32.25) | **−48.75** (exit fill; last 1-minute row −17.75) |
| Stop slip | 1.50 pts worse | 0.25 pts worse |
| Class by INSIGHT's bands | +15 or more ("touched TP1, no fill"); its TP1 was 15.00 away, so true here | +10 to +15 (near miss) |
| Rank in the day | 6th of 16 | 9th of 16 |
| 1-minute close path | 1.75, 1.75, 9.5, 4, 4.25, 10, 6.5, −4.5, −16.5, −29.75 | −3, −6.75, 7.5, −12.25 |
| Early exit (−10 at 120 s, never +3) | no (close +9.50 at 2.74 min) | no (close +7.50 at 2.33 min, best 9) |
| Break-even after +10 (rule as written) | fires at 7.74 min on close −4.50; INSIGHT prices it at entry: −$3.66, saved $250.50. Priced at the close that triggers it: −$30.66, saved **$223.50** | UNKNOWN: +11.75 and −17.75 in the same minute, no later row |
| TP1 on touch | fires: +$86.34, swing $340.50 (estimate) | not touched |

## 2. Full stops, TradeDay 2026-11-11 (INCOMPLETE day: journal hole 10:00 to 10:30 PT): 1 stop, −$192.66

| id | 2976540b |
|---|---|
| Entry | Tue 11/10 22:55:51 PT, Asia LONG, 30m Open, SWEEP-RECLAIM, grade B, control +0.25 |
| Fill / stop / exit | 28,248.00 / 28,218.00 / 28,216.50; stop 30.00 pts; slip 1.50 worse |
| Gross / fees / commission / net | −189.00 / 2.16 / 1.50 / **−$192.66**; R −1.07; 6.2 min |
| Best / worst | **+3.75** (minute ending 1.14 min; polls alone +1.50) / **−31.50** (exit fill) |
| Class | +3 to +10 (middle). By polls alone it would read "never +3": a boundary case |
| Path | −3.25, 1.75, −5, −5.25, −11.25, −15, −25.5 |
| What-ifs | early exit: no (close −5.00 at 2.14 min); break-even after +10: never armed; TP1 on touch: not touched |

Day totals the page may paint beside them: 11/10: 16 trades, 10 wins, 6 losses, 2 full stops; Asia 9 / −$453.44 / 2 stops, London 5 / +$192.70, NY 2 / +$152.68. 11/11: 21 trades, 15 wins, 6 losses, 1 full stop; Asia 11 / +$168.74 / 1 stop, London 8 / +$291.72, NY 2 / +$277.68.

## 3. The 20-TradeDay class table (10/15 to 11/11): REPRODUCED

346 trades, net −$4,914.68, 17 TradeDays with trades. Full stops 100, −$21,146.82 (99 stop fills, 1 filled through the stop; all broker money).

| Class (INSIGHT band) | n | $ | INSIGHT | Difference |
|---|---|---|---|---|
| never +3 | 31 | −6,376.30 | 31 / −6,376.30 | none |
| +3 to +10 | 20 | −3,676.14 | 20 / −3,676.14 | none |
| +10 to +15 | 13 | −3,067.08 | 13 / −3,067.08 | none |
| +15 or more, TP1 not filled | 9 | −2,078.44 | 9 / −2,078.44 | none |
| no reading | 27 | −5,948.86 | 27 / −5,948.86 | none |
| **Total** | **100** | **−21,146.82** | 100 / −21,146.82 | none (the five rows add to the cent) |

Overlays (not additive): same-side re-entry within 30 min of a full stop: 21 stops, −$4,036.10. NY entered at or after 09:00 PT: 22 stops, **−$5,095.82** (INSIGHT gives no dollar figure). By session: Asia 40 / −$7,767.62, London 27 / −$5,138.24, NY 33 / −$8,240.96.

**What the reproduced table does not say (see DEFECTS at the end):**
- Only **21 of the 100** stops have 1-minute rows (first on 10/30). **51** are classed from 20-second price polls alone, 1 from its own exit fill, **27** have nothing (all on 10/15 to 10/20, not "before 11/10").
- One of the 100 is not a loss: 6980a062 (10/19, Asia LONG, 1 contract) is flagged a full stop and closed **+$12.28**, 6.75 pts in profit. Losing full stops: 99, −$21,159.10.
- Of the 9 "touched TP1" stops only **1** (−$254.16) reached its own TP1 distance; the TP1 on the other 8 was 20 to 50 pts away.

What-if totals over the window by INSIGHT's rules (estimates; coverage 21 of 100 stops and 68 of 195 winners):
- Early exit: fires on 5 stops, saved $687.00; also changes 4 other losing trades by −$10.50 in sum (one −$5.16 trade becomes −$150.66); 0 winners.
- Break-even after +10: 2 stops fire (+$474.00 priced at entry, +$442.50 priced at the trigger close), 1 stop UNKNOWN; 6 winners cut (−$599.00 at entry, −$767.00 at the close); 4 other losers (+$265.50 at entry, +$175.50 at the close). **Net +$140.50 or −$149.00 depending on the price assumed.**
- TP1 on touch: 1 stop, +$340.50.

## 4. Experiment scoreboard (repo `office/state/experiments.json`, as of TradeDay 11/11)

| id | mode | n of 20 | value | resolved / unresolved | file verdict | judgeable (my reading of the kill rule) | time to verdict |
|---|---|---|---|---|---|---|---|
| X-01 | recording | 1 (small) | +$296.00 | 1 / 0 by the file; its note says 13 resolve rows, 7 unresolved | too early | yes | not asked |
| X-02 | live | 2 (small) | +$229.50 from 1 resolved case | 1 / 1 ("another trade opened") | too early | yes; 0 of 1 would have reached TP1 | not asked |
| X-03 | live | 7 (small) | $86.34 per winning trade | 7 / 6 (13 fills carried the rule) | too early | **no**: old rule's pay not recorded | - |
| X-04 | live | 2 (small) | $138.84 per winning trade (217.34 and 60.34) | 2 / 0 | too early | **no**: same reason | - |
| X-05 | live | **UNKNOWN** | UNKNOWN | - | not measurable yet | **no**: needs controlScoreAlt rows | - |
| X-06 | counting | 0, "no cases yet" | none | 0 / 0 | too early | yes | about 12 TradeDays (35 cases in the window, net −$2,264.56; estimate) |
| X-07 | counting | 0, "no cases yet" | none | 0 / 0 | too early | yes | about 6 TradeDays (71 trades, −$1,625.08, 22 full stops; estimate) |
| X-10 | live | 0, "no cases yet" | none | 0 / 0 | too early | partly: the +2 comparison is not recorded | about 50 TradeDays (8 NY trades with best ≥ +50, 2 of them ≥ +75; estimate) |

No row may carry a coloured verdict (all n < 20). Kill-if and expectation text must be byte-equal to the file. The published `office.json` still titles X-10 "+50 arms, stop to entry +10" (stale; the ladder title is in experiments.json).

## 5. Closed-net reconciliation, TradeDay 2026-11-10 (16 round trips, each broker-sourced)

| Line | $ |
|---|---|
| Gross (points × $2 × contracts) | **−49.50** |
| Exchange fees, 16 × 2.16 | −34.56 |
| = broker realized, "before commissions" | **−84.06** |
| Commissions, 16 × 1.50 | −24.00 |
| = **closed net** | **−108.06** |

Each of the 16 trades satisfies gross − fees − commission = net to the cent. Wins +$701.40 (10), losses −$809.46 (6). Second day for a cross-check (incomplete day): 11/11 gross +815.00, fees −45.36, before commissions +769.64, commissions −31.50, net **+738.14** (21 trades).
In the window, 24 trades (10/15 and 10/16) carry no commission field, so a 20-day "fees" total is UNKNOWN for those two days, not $0.

The three counters (#4): the journal has 0 `tp1_touch`, 0 `ny_late_trade`, 0 `runner_shadow`, 0 `runner_lock` rows. Expected on real data today: every counter "no cases yet" with its since-date; on an r1.3 snapshot (no such keys) "not reported by this bot build", never 0.

Runner ledger (#3, if built), TradeDay 11/11 replay rows: 08:43 PT LONG fill 28,567.75, peak +126.75 (polls), runner stop +2.00, net +$60.34, gross $64.00; 06:42 PT SHORT fill 28,318.50, TP2 +80.50, net +$217.34, gross $221.00, recorded best +47.75 so peak prints +80.50 from the exit. Both confirmed.

---

## DEFECTS already visible in the specs (a view built exactly to spec would still mislead)

**D1. "Touched TP1, no fill" is false for 8 of its 9 stops.** The band is "best ≥ +15", but TP1 was 20, 40, 46.25 or 50 pts away on those trades (15 pts starts 10/30). Printing the class as "touched TP1" and "addressed by X-08" credits X-08 with −$2,078 when the evidence is 1 stop, −$254.16. Same for "near miss (+10 to +15)": near to a 15-pt TP1 that most of those trades did not have. Fix: label the bands by points only, and count "reached its own TP1 distance, not filled" separately (1). INSIGHT feature 4 repeats the 9 / −$2,078.44 as the TP1-touch reference value.

**D2. The class is a lower bound and the table does not say so.** 51 stops are classed from 20-second polls only. On the 21 stops that have both sources, polls alone put 6 (29 %) one class too low, including both 11/10 stops and the 11/11 one. So "never +3: 31" is "never SEEN +3", 17 of them on polls only. Each row needs its source split or the words "at least".

**D3. "Never +3 → addressed by X-02" overstates what the early exit does.** On the 14 never-worked stops with 1-minute rows, the rule (−10 at 120 s) fires on 5, saving $687. The table would let a reader credit X-02 with −$6,376.

**D4. Break-even what-if: detection and price disagree, and the sign of the net depends on it.** The rule fires on a 1-minute close ≤ 0 but is priced as if filled at entry (−$3.66). Priced where it is detected, the first 11/10 stop saves $223.50, not $250.50, and the window net is −$149, not +$141. With n = 2 stops the cell should read "small" and give the range or UNKNOWN, not one positive number. INSIGHT's own text also counts the 15:18 PT trade of 11/10 as changed although +13.25 and −13.25 fall in its arming minute (its rule says UNKNOWN), and says 11/11 has 0 changed trades (the builder found the 03:15 PT winner; I confirm it: +$86.34 → cut).

**D5. "Cost on winners" leaves out losers the rule makes worse.** Early exit turns one −$5.16 no-progress exit into −$150.66. The column must be "all other trades".

**D6. What-if totals cover 21 of 100 stops and 68 of 195 winners but sit under a "20 TradeDays" heading.** The coverage must be in the row ("on the 21 stops with a minute path").

**D7. Scoreboard, X-02 value is not broker money.** +$229.50 = (50 − 11.75) × $6 at the decision close. The exit filled at −17.50 pts (net −$108.66 against −$303.66 at the stop): the broker saving is **$195.00**. Label it "estimate at the decision price" or use the broker figure.

**D8. Scoreboard, "n of 20" does not count what the verdict rule counts.** X-03: verdict at "20 live trades", 13 fills carried the rule, n shows 7 (TP1 winners only), and its value $86.34 is a constant (15 pts × 3 × $2 − $3.66), so it can never move. X-04 the same way. The bar and any time-to-verdict would be wrong; the card should say what n counts.

**D9. Audit fix 1, the bridge "strategy + other = account" closes by construction** if "other" is account minus strategy; the "UNKNOWN: differs by $X" branch can then never fire and a missing trade hides inside "other". "Other" must come from its own rows or be named "difference, not explained". The audit's own example mixes a before-commission figure (+$765.70) into an after-commission sum.

**D10. Audit fix 8, the snapshot's `build` is a code hash, not a version, and its `startedAt` is the last restart (17 restarts on 11/11).** "This bot · since …" must not reuse the constant date, and must not show the restart time as the install date. An r1.3 snapshot with `build: null` must read UNKNOWN.

**D11. Two files, two ages.** `autopsy.json` and `office.json` are fetched separately; if their `generatedAt` / `tradeDay` differ the page shows one day's class table under another day's Office with a single freshness chip. Until the office patch is in the repo the file does not exist at all: the view must say so, and CHANGES must tell Mac.

**D12. Card time label.** "TradeDay 11/10" stops happened on the evening of Mon 11/09. The card must print the clock date (INSIGHT's layout does); the register's "11/10 20:10 PT" does not.

**D13. One "full stop" made money.** 6980a062 (10/19) has a stop fill 6.75 pts beyond entry in profit, net +$12.28, and sits in the "+3 to +10" row (its best reading is its own exit). The stop had been moved; the ledger's rule (no trail code before the stop fill) still calls it a full stop. The header "100 full stops, −$21,146.82" is therefore 99 losing stops, −$21,159.10, plus one winner. Small in dollars, but the card for that trade would show a full stop with a green number. The tool should exclude a stop fill on the profit side, or the page should mark it.
