# Terminal 2.3: what Mac will see (candidate, built on 2.2.2)

Display only. No bot, proxy or config change; installing it cannot affect orders. The tab bar and its order are unchanged.

## Review
- **Review now opens on the Office section.** The Download Trade Log card is the last card of the tab.
- **Office → Full stops (new).** One button, "Show the full stops". Until the office publishes its new file the section reads "UNKNOWN: the office has not published the full-stop file yet". Once it does:
  - the total of the losing full stops of the last 20 TradeDays (99, −$21,159 on the 11/11 file), the section's own TradeDay and age, and a banner if the window has journal hours missing;
  - five rows by the best the trade was seen to reach, in points (under +3, +3 to +10, +10 to +15, +15 or more, no reading), each with how many were read from 1-minute bars and how many from 20-second polls only ("at least this much"). Tap a row to list only its stops. No row is credited to an experiment;
  - "Reached its own TP1 distance without a fill": 1 stop, −$254 (the count X-08 is about);
  - what three rules would have changed, each an estimate with its coverage in the cell: saved on full stops, all other trades (winners cut and losers changed), net. Break-even after +10 is priced at the 1-minute close that triggers it: net −$149 on this file;
  - one card per stop, newest first, 8 at a time: clock date and time PT, session, side, net (broker) and R, level, event, grade, stop size, minutes to the stop, best and worst, control score, and a price-path strip with the entry, TP1 and stop lines, the best point and a diamond where the best rule would have acted. Under it the three what-ifs: yes with the dollars, no with the reason, or UNKNOWN with the reason.
- **Office → Experiments is now a scoreboard** (when the office file carries the new keys): per experiment the time to verdict (estimate, with its basis), the expectation and the kill rule as written, "Can it be judged" (yes / no / partly, with the missing row), the value so far (the broker figure first where there is one), what n counts, the kill-rule numbers, and a fold-out with the cases. Experiments with their sample move to the top with "decision due". Under 20 cases nothing is coloured. With today's office file each card looks exactly as in 2.2.2 and one line says which key is missing.
- **Rule scorecard: three new blocks** from counters the bot already sends: "Runner rule against the old rule", "TP1 touched, not filled", "NY by entry time". With nothing counted yet they show 0 and "no rows yet"; on a bot build that does not send them, "UNKNOWN: bot build does not report this yet". Each prints the bot's since-date and the office's.
- **"This bot"** shows the code hash the bot reports and its last restart; version reads UNKNOWN. The typed-in "r13.3.7" is gone.
- **The reconcile line** under Trade Stats no longer adds a before-commission figure to an after-commission one (see Trades).

## Trades
- Under the day figures, one line: "This TradeDay, tied to the broker": the trade list's before-commission sum, commissions and net, then the broker's day. If they agree to the cent it says so; if not it reads UNKNOWN with the difference, and a difference is never shown as a sum.
- The ledger's withheld total now reads "1 of 30 round trips is itemised here; total withheld".

## Header (every tab)
- The refresh button moved up beside the bot's name. The reason line is about twice as wide; tap it to read all of it. A stale warning is never cut.

## Levels
- Flight recorder route: the time no longer runs into the event text.

## What the office has to do for the new sections to fill
Apply `office-patch/` (one new tool file, 15 lines in loop_daily.py, tests). The next daily run then writes `office/state/autopsy.json` and the scoreboard keys.

## Not in 2.3 (moved to 2.3.1)
Trade Rail on Now, the runner ladder ledger, the header's short reason text, and the Control tab reorder (Take a break and Danger zone above the hero): it changes the Control tab's DOM order, which the control-identity gate pins, so it was switched off rather than shipped against a failing gate. Options for Mac are in OPTIONS.md.
