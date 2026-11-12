# Terminal 2.3: known limits (short)

**Moved to 2.3.1, not in this build:** Trade Rail on Now (not started); runner ladder ledger; Control reorder (built, switched off: it fails the control-identity gate, 12 of 92 checks); the header's short reason text (the slot is wider and opens on tap instead).

**Needs the office patch before it shows data.** Full stops reads `office/state/autopsy.json`; until `office-patch/` is applied and a daily run has written it, the section reads "UNKNOWN: the office has not published the full-stop file yet (HTTP 404)". The scoreboard keeps the 2.2 cards plus one UNKNOWN line until the new keys are in `office.json`. X-08 is not in `experiments.json`, so its office date reads UNKNOWN. A real 404 from raw.githubusercontent.com was not tested, only the test's own route.

**Estimates and coverage.**
- Every what-if dollar is an estimate from 1-minute rows; only 21 of the 99 stops (and about 90 of the 247 other trades) have them. The cells print that.
- Break-even after +10 is priced at the 1-minute close that triggers it; a real stop at entry would fill somewhere between the entry and that close, so the true figure lies between −$149 and +$141 on this window. One number is shown, labelled estimate and small.
- A best read from 20-second polls is a lower bound; the class rows and the cards say "at least".
- The 23:57 PT stop of TradeDay 11/10 reads break-even UNKNOWN as specified, although its own close (−12.25) came after its +11.75.
- TP1 on touch for NY is a floor. Time to verdict is a rate, labelled estimate; X-03 and X-04 show none.
- X-02's broker saving ($195.00) uses the stop the trade had; the decision-price figure stays beside it as an estimate.

**Budgets.** Review open at 4x CPU: worst long task 153 ms against 125 ms on 2.2.2 (both far over 50 ms; the task count is equal); the perf-23 check set at reference +15% fails by 7 points.  On a synthetic 150 KB full-stop file (twice the real one) at 4x CPU, one task measured 53 ms in the gate run and none in the run before; paint is 36 to 46 ms. Everything else is in TESTS-23.md.

**Batch A.** Defect 1 was reproduced on the flat-day fixture only; the account-day figure is not in the journal, so Mac's live days are not verified. The Review tie needs the trade list (open Trades once). "This bot" still counts from a day typed into the page, and now says so. Review opens on the Office, so Combine and the Rule scorecard are further down than in 2.2.2.

**Page behaviour.** Full stops opens on a tap and stays open for the page session. "Open the trade log" appears only for trades in the phone's own trade list. A strip is never shorter than its labels need. The counters' office dates repaint on the next snapshot poll after the office file loads.

**Not verified.** Anything on Mac's phone or server; the first full r1.6 day check of the counters (the journal has no tp1_touch / ny_late_trade / runner_shadow rows yet); the Live look (screenshots are replay-marked).
