# The Loop: how Team Mac improves the bot every day

Set up 11/11 at Mac's order: "orchestrating a workflow for our office that will make sure our bot continues to improve over the next few weeks".

**Objective, in order:** pass the Topstep $50K combine, get funded, take the first payout. Every piece of work is ranked by its measured effect on that.

**Working target (Mac, 11/11):** pass the practice combine first: "If we can focus on passing a practice combine we will eventually pass a real one." The practice stage also measures the most the system can win or lose in a day, so there is no daily stop rule.

## 1. The scoreboard (what "better" means)

The numbers below come from the journal, are recomputed every trading day, and are the only ones a change is judged on.

| Number | Target | Why |
|---|---|---|
| Virtual combine result | pass ($3,000) before a breach ($2,000 trailing floor) | The bot trades a practice account today. Each day we replay the combine's rules over the real results: would a combine started on day X have passed, breached, or still be open? |
| Full stops per 10 trades | down | Full stops are the main loss driver (NY 11/02 study: 41 of 131 trades = -$13.1k). |
| Average loss ÷ average win | down | Mac, 11/11: "losses still seem too big in comparison to our wins". |
| Net per TradeDay, by session | up, and positive in each session traded | "Strategy has to be dynamic for the market type/session." |
| Best day ÷ total profit | under 55% | Topstep's consistency rule. |
| Bot health | 0 unexplained restarts, 0 skipped checks | A bot that is not LIVE cannot earn. |

Combine rules used: `office/state/office.json → objective` (source: the 11/03 combine plan read from Topstep's pages).

## 2. Data in (already automatic)

- The bot writes its trade journal on the server.
- MacMillionz publishes it to the team line every 4 hours: repository `tmc-mac/team-mac-line`, branch `agent-line`, folder `data/<PT date>/` (`slice-HHMM.jsonl.gz`, `levels-minute-MNQ-<date>.jsonl.gz`, `config-local-live.json`).
- The 14:05 PT slice is the first one that holds the whole TradeDay (flat by 13:10 PT).
- Nothing in the loop needs the server, the account or an install.

## 3. Daily cycle (automatic, every TradeDay after the 14:05 PT slice)

Run by MacArthur's scheduled review. One run, same steps, same files:

1. **Pull** the new slices. Refuse to report on a day whose data is missing or stale; say so instead.
2. **Rebuild the ledger** (`office/tools/loop_daily.py`): every closed trade with its session, rule, exit reason, money, MFE / MAE.
3. **Score the day**: net by session, wins, losses, full stops, average loss ÷ average win, fees.
4. **Advance the virtual combines.**
5. **Autopsy every loss**: put it in a leak class (section 5). A loss that fits no class is a new leak candidate.
6. **Audit every blocked signal**: which gate blocked it, and what price did next (reached +TP1 before -stop, or not). Blocks that keep costing winners are leaks too.
7. **Update the experiments**: each recording-only rule gets its day's results added (n, effect, verdict so far).
8. **Read Mac's flags** (when the flag button ships): each flagged trade gets an answer in the next daily card.
9. **Check health**: restarts, warm-ups, failed reads, settings changes (a settings change splits before / after in every comparison).
10. **Publish**: `office/reviews/daily/<TradeDay>.md`, `office/state/office.json` (the phone reads this), a 10-line post on the team line, and a push to Mac only when something needs him.

## 4. Weekly cycle (Saturday)

1. Roll the week up: scoreboard trend, session table, virtual combine table.
2. Rank the leaks by dollars per week, with their sample sizes.
3. Decide each experiment against its own pre-written rule (section 6): promote, keep recording, or kill.
4. Write **one decision card for Mac with at most 3 decisions**, each with the evidence, the recommendation, the switch that undoes it, and what happens if he does nothing.
5. Plan the week's builds from Mac's answers. Nothing else gets built.

File: `office/reviews/weekly/<ISO week>.md`.

## 5. The loophole register

`office/LOOPHOLES.md` is the single list of everything known to cost money or block the objective. Each entry has an id, the evidence (n, dates, dollars), a status and a next step. Statuses, in order:

`observed` → `measured` (offline study with sample size) → `recording` (a record-only rule in the live bot) → `live` (a switched rule, Mac's go) → `kept` or `killed`.

Sources of new entries: the daily loss autopsy, the blocked-signal audit, Mac's flags and screenshots, reviewer findings, live incidents. An entry is never deleted; a killed idea stays with the reason, so nobody tests it twice.

## 6. The evidence ladder (how a rule earns its way into the live bot)

1. **Write the expectation first**: what the rule is, the number it should move, by how much, and the result that would kill it. Dated, in `office/EXPERIMENTS.md`, before looking at new data.
2. **Measure offline** on the journal. Report n, the effect, and how it splits by session. Searching many filters at once needs a multiple-comparison correction (the 11/11 filter study: 0 of 103 survived).
3. **Record live**: ship it record-only (a journal row, a scorecard line, no orders). Minimum 20 resolved cases before a verdict.
4. **Go live behind a switch**: only on Mac's go, with an on/off switch and a journal row (standing order 11/11). The undo line ships with it.
5. **Keep or kill** after 20 live cases against the expectation from step 1. A rule that does not beat its expectation is switched off and the register says why.

Guards: one live rule change at a time per session where possible, so its effect can be read; small samples are labelled small; an offline estimate is never reported as a result (11/10 lesson: a +$510 estimate was -$434 in the real replay).

## 7. Shipping (unchanged, from CLAUDE.md)

Builder desk → independent reviewer desk → ship gate (Mac-box run, restart soak, trade witness, install path, health alerts) → package with install sheet, dry-run install and rollback → Mac installs when flat. Terminal pages: builder → reviewer → page-only install with undo.

## 8. Who does what

| Desk | Job in the loop |
|---|---|
| MacArthur | Runs the daily and weekly cycles, keeps the register and the experiments, briefs the desks, writes Mac's decision card. |
| MacMillionz | Publishes the journal slices and the live settings; confirms build stamps after each install. |
| MacDot | Independent review of bot packages and of any study that leads to a live rule. |
| Builder / reviewer desks | Build and check what the decision card approved. |
| Mac | Flags trades from his phone, answers the weekly card, installs when flat. |

## 9. The phone terminal's part

- **Display:** an Office section reads `office/state/office.json` (published by the daily cycle): combine progress, the day and week, the leak board, the experiments with their sample sizes, and what is waiting on Mac.
- **Tool:** a Flag button on each trade ("stopped then worked", "bad entry", "exit too early", "missed move", free note). The bot journals the flag; the next daily cycle answers it. This turns Mac watching every trade live into data.

## 10. Data contract: `office/state/office.json`

Written by `loop_daily.py`, read by the phone. Public file: no account ids, addresses or names. A reader must tolerate missing keys and treat `null` as UNKNOWN.

```json
{
  "schema": 1,
  "generatedAt": "2026-11-11T22:25:00Z",
  "tradeDay": "2026-11-11",
  "data": { "lastSlice": "2026-11-11/slice-1405", "rows": 740, "complete": true, "note": null },
  "objective": { "name": "Topstep $50K Combine", "target": 3000, "maxLoss": 2000, "bestDayCap": 1650, "account": "practice" },
  "combine": {
    "mode": "virtual",
    "current": { "startDay": "2026-11-09", "profit": 0, "floorRoom": 2000, "bestDay": 0, "bestDayPct": null, "days": 0, "status": "open", "needPerDay": null },
    "history": { "started": 0, "passed": 0, "breached": 0, "open": 0, "window": "last 20 TradeDays" }
  },
  "day": { "net": 0, "trades": 0, "wins": 0, "losses": 0, "fullStops": 0, "avgWin": null, "avgLoss": null, "fees": null,
           "bySession": { "asia": { "net": 0, "trades": 0, "fullStops": 0 }, "london": {}, "ny": {}, "late": {} } },
  "week": { "net": 0, "trades": 0, "fullStops": 0, "lossToWin": null, "days": [ { "day": "2026-11-10", "net": 0, "trades": 0, "fullStops": 0 } ] },
  "health": { "restarts": 0, "settingsChanges": [ { "t": "2026-11-11T05:14:32Z", "what": "levelsParity pine" } ], "build": "dd2fdc4a", "notes": [] },
  "leaks": [ { "id": "L-03", "title": "NY first target is small against NY candles", "status": "recording", "n": 18, "usd": null, "next": "verdict at 20 resolved" } ],
  "experiments": [ { "id": "X-01", "title": "TP1 sized by volatility", "mode": "recording", "n": 0, "minN": 20, "value": null, "unit": "usd", "verdict": "too early" } ],
  "blocked": [ { "gate": "15m control", "count": 0, "wouldHaveWon": 0, "wouldHaveLost": 0, "unknown": 0 } ],
  "waitingOnMac": [ { "id": "D-01", "text": "...", "recommendation": "..." } ],
  "flags": [ { "t": "...", "trade": "...", "reason": "...", "answer": "..." } ]
}
```
