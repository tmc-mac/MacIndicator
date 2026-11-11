# office/tools: the daily loop tool

`loop_daily.py` turns the bot's published trade journal into the day's review card and the state files the phone reads. One command, no human step, standard library only.

```
git -C <team-line clone> fetch origin agent-line
python3 -I office/tools/loop_daily.py --data-repo <team-line clone> --ref FETCH_HEAD --day 2026-11-10
python3 -I office/tools/loop_daily.py --data-repo <team-line clone> --ref FETCH_HEAD --day latest
python3 -I -m unittest discover -s office/tools -p 'test_*.py'
```

`--day latest` is the TradeDay of the newest journal row (it can be a day that is not over). `--row-types` prints the row-type table below and writes nothing. `--combine-start` moves the first virtual combine (default 2026-11-09). `--out` writes into another office directory (it must hold `state/experiments.json` and `LOOPHOLES.md`).

The tool only reads the data repository (`git ls-tree`, `git show`); it never checks the branch out and never writes there. A run takes about 5 seconds.

## What it writes

| File | Content |
|---|---|
| `office/state/ledger.json` | Every closed trade of every day in the data, keyed by journal id. Rebuilt whole on each run. |
| `office/reviews/daily/<TradeDay>.md` | The daily card. |
| `office/state/office.json` | The phone's state file, contract in `office/LOOP.md` section 10 (schema 1). Holds the day of the last run. |
| `office/state/experiments.json` | Machine copy of `office/EXPERIMENTS.md`. The tool reads `feeds` (which journal rows count) and rewrites `running` (n, value, cases, verdict). Everything except `running` is edited by hand together with EXPERIMENTS.md. |

The daily run also rewrites `office/reviews/STATUS.md`, the one screen to open first (objective, the chain, the week, top 3 leaks, experiments, what waits on Mac, when the data was last complete), and it carries the `weekly` block of office.json over untouched. ledger.json also lists every TradeDay (`tradeDays`: rows, complete, trades, net), which is what the weekly tool reads.

Running twice gives byte-identical files except `generatedAt` in office.json. Everything in the card and in office.json uses only TradeDays up to the requested one, so an old day can be re-run.

Two additions to the office.json contract, both because the honest answer needed them: each `blocked` entry has a `neither` count (60 minutes passed, neither +15 nor the stop was reached; `count = wouldHaveWon + wouldHaveLost + neither + unknown`), and `health.settingsChanges` lists code changes too. A leak's `n` is the number of losing trades in that class over the last 5 TradeDays (with `usd`), or, when the leak has an experiment and no loss class, the experiment's n.

## Method

**Rows.** All `slice-*.jsonl.gz` files and all `trade-journal-MNQ.jsonl.gz` files are read; a row that appears in more than one file is counted once (exact text match). The folder date is the TradeDay; the `1805` and `2205` slices of a folder hold the previous calendar evening. Coverage is judged from the time range of the rows inside each file, not from file names.

**TradeDay and session.** A TradeDay runs 15:00 PT the previous calendar day to 13:10 PT (bucket edge 15:00 PT). Sessions are the bot's own, from `lib/stopFloor.js sessionOf`, by the fill time in PT: london 00:00-06:30, ny 06:30-13:00, late 13:00-15:00, asia 15:00-24:00. Checked against the journal's own `floorSession` on 248 trades: 0 differences. PT is computed from the US daylight-time rule in the tool (no time-zone database needed).

**Closed trade.** A journal id with a `signal_check` row whose outcome is `closed`. Money is the last such row with `pnlSource: "broker"` (the broker's realized P&L): `net` = the broker's net (gross - exchange fees - commissions), `realized` = gross - exchange fees (the journal's older basis, used by the 11/11 studies), `fees` = gross - net. Rows written before 10/18 carry no commission, so their `net` equals `realized` (`netBasis` says which). With no broker row the bot's estimate is used and the trade is marked `moneySource: "estimate"` (1 of 404 trades).

**Exit reason.** From the trade's `trade_manage` codes: `filled-through-stop`, `early-adverse-exit`, `no-progress-exit`, `session-flatten`, `manual-flatten`, `tp1-all-out`, `tp1-then-runner`, `trail-stop`, `full-stop`, `market-exit`, `full-stop(inferred)` (no code, loss of 85% of the stop distance or more), `unknown`. A full stop is `full-stop`, `full-stop(inferred)` or `filled-through-stop`.

**MFE / MAE.** The largest reading among the journal's sources, with the source named per trade: `trade_state` 1-minute bars, `trade_time` price polls (about 20 s), the no-progress and early-exit rows, the TP1 fill, the exit fill. These are lower bounds of the real excursion (the `trade_state` entry bar uses only the close after the fill, so its readings are post-fill). 61 of 404 trades, all older ones, have no MAE source and 69 no MFE source: `null`.

**Virtual combine.** `simulate_combine` (unit tested): target $3,000; floor at -$2,000 from the start; inside each trade the floor is tested against balance + the trade's worst open excursion (MAE points x contracts x $2), then against the closed balance; at the end of each day the floor moves up to end-of-day balance - $2,000, never down, and locks at the start balance; pass = end-of-day profit at or above max($3,000, best day / 0.55). A breach is at or below the floor. A day that is not over is applied trade by trade but gets no end-of-day step. Trades without an excursion reading are tested on closed P&L only and counted in the card. `current` is the last of a chain of back-to-back combines from `--combine-start`; `history` starts one combine on each of the last 20 TradeDays. `needPerDay` = (target now - profit) / TradeDays left to `--target-date` (default 2026-11-30; weekdays, the requested day included when it is not over). It is arithmetic, labelled so in the card, and `null` when the chain is not open or no day is left.

**Loss autopsy.** Each losing trade gets a class from `office/LOOPHOLES.md`: L-07 if it was entered on the same side within 30 minutes of a full stop; else L-01 if it went to the full stop or was closed by the early exit; else L-12 if it was a no-progress exit that closed at a loss; else `unclassified`, named by its exit reason. The class is stored on the trade in ledger.json (`leak`, `leakWhy`). L-13 (near-miss then full stop) is a sub-class, not a class of its own: a full stop whose best excursion was +10 points or more (`nearMiss` on the trade; `null` when the trade has no best-excursion reading). Its dollars stay inside L-01 / L-07 and are printed as "of which". Every trade also carries `afterFullStopMin`: minutes since the exit of an earlier same-side full stop when that is 0 to 30 (winners too), which is what experiment X-06 counts. L-08 (volatility) has no written threshold yet, so the tool does not assign it.

**Blocked-signal audit.** Every `trade_block` row of the TradeDay with a direction. Reference price: the row's own `entry` when it has one, else the price sample nearest the block (within 90 s). Stop distance: the row's own (`stopPts`, or entry - stop) or 50 points when it has none. The tool walks the price samples for 60 minutes: +15 first = won, the stop first = lost, neither = neither, a hole over 180 s in the samples or samples ending early = unknown. Price source: the `levels-minute-MNQ-<date>` files, one row about every 52-80 s, last price only.

**Settings changes.** Each `session_stamp` row is a bot start with the hashes of its code files and its settings; consecutive stamps are compared (changed settings, changed files). Keys the stamps do not carry are compared between consecutive `config-local-live.json` files, timed at the later pull. `restarts` is the number of stamps in the TradeDay. Values of keys that look like identifiers are never printed.

**Experiments.** X-01: `tp1_atr_shadow` resolve rows, NY, state resolved; value = shadow net - live net. X-02: `early_adverse_exit` rows that sent the order; value from each `early_adverse_shadow` result. X-03 / X-04: `runner_rule` rows joined to the ledger; n = trades under the rule that reached TP1; value = their average net. X-05: not measurable (see limits). X-06: counted from the ledger, no journal row: trades with `afterFullStopMin` set, in Asia or London, entered at or after the start time; value = their summed net; the other sessions are printed beside it as context.

**Check built in.** Each run compares the day's ledger with a second row family, the `journal_receipt` rows of status `ECONOMICS_MATCH_OBSERVED`; a difference is printed in the card and in `health.notes`.

## Weekly roll-up: `loop_weekly.py`

```
python3 -I office/tools/loop_weekly.py --week 2026-W46      (or --week latest)
```

Reads only `office/state/ledger.json`, `office/state/experiments.json`, the kill-rule column of `office/EXPERIMENTS.md` and the status column of `office/LOOPHOLES.md`; it reads no journal and reruns nothing, so run the daily tool first. Writes `office/reviews/weekly/<ISO week>.md` and the `weekly` block of office.json (no other key is touched). No timestamp is written: two runs give identical bytes.

- **Week** = the ISO week of the TradeDay, so a Sunday-evening trade belongs to Monday's week. The card uses TradeDays up to the end of that week only; a week that is not over, or has a day with journal hours missing, is headed PARTIAL WEEK.
- **Scoreboard** against the week before, n beside every figure: net, net per TradeDay, by session, full stops per 10 trades, average loss / average win, fees, best and worst day, the worst run of full stops in a row inside one TradeDay and the most full stops in one day.
- **Virtual combine**: the chain, one combine started on each of the last 20 TradeDays, and the readiness line: what the open chain still needs, and how many days that is at the average net of the last 10 complete TradeDays. When that average is not positive the line says so and gives no number of days. Nothing is forecast beyond that division.
- **Leaks** by dollars for the week and for the last 20 TradeDays (with the split by session), from the `leak` field of the ledger.
- **Experiments**: n of the number needed and the value as the last daily run left them; a VERDICT, quoted against the kill rule, only when n has reached it; otherwise "recording, n of 20".
- **Decisions for Mac**: at most 3, from experiments at a verdict (first) and leaks with register status observed or measured (or no register row) that lost more than $500 in the week (`LEAK_DECISION_USD`; $500 is a quarter of the combine's $2,000 floor). A leak whose rule is already live or recording is named under the block but raises no item on dollars alone, and a partial week raises no items at all. With none: "Nothing to decide this week." The block sits between `<!-- decisions:start hash=... -->` and `<!-- decisions:end -->`. The hash is of the text the tool wrote; if the text between the markers no longer matches it, somebody edited it by hand and the tool writes that text back unchanged on every later run (office.json then says `decisionsEditedByHand: true`). To hand the block back to the tool, delete it together with its markers.

## Shadow counters, what-ifs and readiness (added 11/11, all from the ledger)

Daily: ledger.json trades also carry `rankInDay` (1 = first trade of the TradeDay), `prevResult` (`win`, `loss`, `fullStop` or null for the first trade of the day) and `minutesSincePrev` (entry minus the previous trade's exit, same TradeDay). Experiment X-07 (NY late session, `calc: nyLate`): n = NY trades entered at or after 09:00 PT since 2026-11-11T07:30Z, value = their summed net; nothing is skipped; the 06:30-09:00 PT trades are the context.

Weekly card, after the experiments table:
- **NY late shadow counter** beside X-06: before / after 09:00 PT for the last 20 TradeDays and since the X-07 start (n, net, full stops, loss / win, TradeDays negative).
- **Daily-loss what-if** at -$400, -$600, -$800, -$1,000: the P&L the days would have had if no entry were taken once the day's net reached the threshold (the crossing trade is kept). Last 20 TradeDays and since 11/11, with and without 11/03, and a "with open" column that also counts a trade's worst open reading as the crossing (a lower bound). It is a what-if, not a rule.
- **Size table**: virtual combines started on each of the last 20 TradeDays at 1, 2 and 3 contracts (net, fees and worst open reading scaled linearly from the 3-contract result; starts overlap), with passed / breached / open and the median days to breach.
- **Chance to pass**: bootstrap, 5,000 resamples, fixed seed, of whole TradeDays (closed net and the day's lowest equity) played forward from the open chain over the TradeDays left to `--target-date`, against floor, target and the 55% rule. "Current rules" uses complete TradeDays from `--rules-since` (default 2026-11-12, the first complete day entirely under the 11/11 rule set) and prints nothing below 10 such days; the reference line uses every complete TradeDay in the data (old rules, days with no trade count as $0).

office.json `weekly` gains `passProbability` and `sizeTable` (the daily run carries them over):

```
"passProbability": { "current": null | 0.0-1.0, "n": days under the current rules, "needDays": 10, "daysLeft": N, "resamples": 5000,
                     "rulesSince": "2026-11-12", "why": null | "needs 10 days ...", "reference": { "p": 0.0-1.0 | null, "n": days, "label": "old rules, for reference" } },
"sizeTable": [ { "contracts": 1, "started": 20, "passed": 0, "breached": 0, "open": 0, "medianDaysToBreach": null | days } ]
```

Limits: the bootstrap treats days as independent and equally likely, and a day's low is only as good as the journal's excursion readings; the what-if days-stopped counts are a handful of days.

## Journal row types found (all files at 2026-11-11, 71 files, 106,319 rows after de-duplication, 0 unreadable)

| row type | rows | used for |
|---|---|---|
| signal_check | 80,539 | `closed` rows = the trade and its money; `traded` rows = entry facts. The rest (`sat_out`) is only counted |
| journal_receipt | 7,322 | `ECONOMICS_MATCH_OBSERVED` = the built-in money check |
| trade_block | 3,081 | blocked-signal audit (codes GATE, HTF_ALIGN, LEVELS_ONLY, SIZE_BELOW_MIN, COOLDOWN, ...) |
| trade_manage | 2,617 | fills, protection, exit reason (by `code`) |
| control_exclusion | 2,505 | counted only |
| level_board | 2,401 | counted only |
| control_flip | 1,323 | counted only |
| initial_quantity | 1,009 | counted only |
| stretch_check | 842 | counted only |
| stop_cap_shadow | 759 | counted only |
| trade_plan | 607 | level and event of the entry |
| trade_state | 500 | MFE / MAE (1-minute bars) |
| entry | 421 | level, event, contracts |
| peak_unrealized | 409 | counted only |
| initial_quantity_admission | 386 | counted only |
| entry_context | 372 | counted only |
| plan_terminal | 326 | counted only |
| trade_time | 279 | MFE / MAE (price polls) |
| no_progress_outcome | 201 | MFE |
| profit_trail | 121 | counted only |
| session_stamp | 77 | bot starts, settings and code changes, build |
| no_progress_exit, no_progress_flatten | 64 each | counted only (the exit reason comes from trade_manage) |
| reversal_signal 19, manual_flatten 13, reclaim 13, auth 11, reversal_event 9, reversal_event_outcome 7, manual_entry 2, session_flatten 2, early_adverse_flatten 1 | | counted only |
| tp1_atr_shadow | 5 | experiment X-01, MFE |
| runner_rule | 4 | experiments X-03, X-04, rule facts |
| alert | 2 | health notes (warm-up cut short) |
| early_adverse_check 2, early_adverse_outcome 2, early_adverse_exit 1, early_adverse_shadow 1 | | experiment X-02, rule facts, MAE |
| orphan_sweep, flag | 0 | read when they appear (health note; `flags`) |

## Limits of the data

- **No high / low after a block.** The blocked-signal audit sees one price about every minute, so a touch between two samples is missed (wins and losses are both under-counted), and about a fifth to a third of block rows come out unknown because of holes in the samples. A block row is written at most once per reason per 15-minute candle, so one setup can be counted several times. With +15 against a 50-point stop, a market with no edge wins about 77% of the time, so the counts alone do not show that a gate costs money.
- **GATE (15m control) rows carry no entry price and no stop**: the audit uses the nearest price sample and the 50-point default for them.
- **Open P&L is a lower bound.** The virtual combine can only be as strict as the journal's excursion readings.
- **X-05 (control parity) cannot be counted**: after the switch the journal does not carry the old formula's score, so the trades it would have blocked cannot be told apart. `n` is `null` until the bot writes both scores.
- **X-03 / X-04 kill rules need what the old runner rule would have paid** on the same trades; the journal does not hold that, so the tool reports n and the average only.
- **Skipped fast checks ("fetch failed", B-01)** are in the bot's log, not in the journal.
- **Estimated commissions before 10/18** are not added back: those trades' `net` is gross - exchange fees.
- A zero-trade TradeDay on which the bot ran (11/05, 11/06, 11/09) counts as a day with $0.
