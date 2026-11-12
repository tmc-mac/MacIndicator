# GATE 23: terminal 2.3 candidate (MacCheck-23, 11/12)

**Candidate:** `term23/mobile.html` sha256 `042bbb6b3f82c2d16e2038d1e52c0cf5def2db9974e2af0f1eebd30a67218268` (unchanged by my runs). Size is **1,740,780 bytes** (+4.7 %; gzip 514,685 against 491,182), not the 1,730,587 in the hand-off; the sha is the right one. Base 2.2.2 `99ec1630…`. One browser at a time, nice 19. Numbers below are against `EXPECTED.md`, computed by my own parser before I saw the builder's code.

## Verdict: SEND WITH RULES

No wrong number found, no control request changed, every UNKNOWN case tested reads UNKNOWN with its reason. Two rules and four small items below. The perf-23 Review-open check does **not** block.

**Rules**
1. **The new sections stay empty until the office patch is applied and its output is committed to the branch the phone reads.** The phone reads `autopsy.json` from the same branch and folder as `office.json` (the address is fixed in the page). Until then Full stops reads "UNKNOWN: the office has not published the full-stop file yet (HTTP 404)" and the scoreboard keeps the 2.2 cards plus one UNKNOWN line (both tested). Mac should be told that before he installs.
2. **Nobody hand-edits `autopsy.json`.** The page prints the header total, the class rows and the count from the file without checking that they agree with each other (finding 1). The tool's own output is consistent (checked to the cent); a hand edit would not be caught.

## Findings, ranked

| # | Severity | Finding | Evidence | Action |
|---|---|---|---|---|
| 1 | Medium | The page does not check that the class rows add to the header, or that the header count matches the cards. Class row changed by $100: header still −$21,159, no flag. `totals.fullStops` set to 98: "98 losing full stops" over "99 of 99 shown". The audit's rule was that a total that does not close cannot paint as a number | `rv-23-truth.cjs`; `out/rv-truth-out.json` | 2.3.1: add the check; rule 2 until then |
| 2 | Medium | Sections depend on an unapplied office patch (above) | `loop_daily.patch` applies cleanly to a copy of `office/`; see "Office patch" | Apply, run the daily tool, commit `office/state/autopsy.json` and the new `office.json`; tell Mac |
| 3 | Low | Time to verdict from one TradeDay of history: X-02 "about 9 TradeDays" (2 cases in 1 TradeDay), X-01 "about 19". Labelled estimate with its basis, but a one-day rate is weak | painted scoreboard | 2.3.1: say "needs 3 TradeDays" instead |
| 4 | Low | Missing `slipPts` or `rankInDay` on a stop makes the line disappear instead of reading UNKNOWN (all other deleted fields read UNKNOWN with a reason) | `rv-23-truth.cjs` | 2.3.1 |
| 5 | Low | Pre-existing 2.2.2 wording now sits next to the new line: on the Trades tab the ledger says "these 30 rows do not add up to the day's closed net (30 round trips), total withheld" while the new tie line directly above says the list sums to the broker's day | painted Trades tab, flat-day fixture | 2.3.1 |
| 6 | Low | The refresh button's top edge is at y = −1 px at 360 and 390 (negative margin). Header is 4 px taller (261 → 265) | `rv-23-batchA.cjs` | cosmetic |
| 7 | Watch | Reel replay at 4x CPU in my run: p95 gap 66.6 ms on 2.3 against 50.0 ms on 2.2.2 (frames 243 against 258). The suite's own rule passes (best of runs, 28/0), builder's run showed 50.0 vs 50.1. One run each way, noise on a shared machine; not a block | `out/replay-ab.txt` | re-check on Mac's phone |

## G0 diff and static scan
2.2.2 → 2.3 is 12 hunks: a new CSS block, two appended scripts (`t23`, `t23a`), release string `2.3`, three slot calls in the scorecard, one `x23` key in the experiments model, the ledger wording, and the Office-module hooks. No hunk touches a handler, the receipt model, the broker card or the cascade. Fetch / XHR / WebSocket call sites: 11 in 2.2.2, 12 in 2.3 (the one new `fetch`). No identifiers, addresses or paths added. No `innerHTML` from file text (new modules build nodes; the two `innerHTML` uses in `t23a` take numbers, fixed words and a hex hash checked by pattern). No `transition: all`, no click-only `div` (new buttons are `<button>`, the reason line has role, tabindex and a key handler), strips have an `aria-label`, reduced motion honoured, `tabular-nums` on figures. A constant `r13.3.7` still sits in the file (line 12621) but is not painted any more (tested). Web-design-guidelines pass (pinned rules): no failures beyond findings 4 and 6.

## G2 Requests (first priority): PASS
My own capture (`rv-23-requests.cjs`: method, URL, headers, body, dialogs, per step; browser level and server level), 2.2.2 against 2.3:
- **Pause (4 presets two-tap, one-tap arms only), resume, Flatten (dismissed confirm sends nothing; accepted sends one; Control two-tap), cancel-entry: byte-identical** (method, URL, headers, empty body, dialog text and order, request counts per step).
- All tabs and the Why sheet: identical request lists.
- Review → Full stops: **exactly one new request**, `GET …/office/state/autopsy.json` (no credentials, no referrer, no-store, no redirect). Sent only on the tap of "Show the full stops": 0 requests when Review opens, 0 on the refresh tap inside the 5-minute gap. The refresh button re-reads it after the gap while Full stops is open (same rule as the Office file). The builder's "DIFFERENCES FOUND" last line is the known external Office read, same in 2.2.2.
- Control tab child order identical to 2.2.2 (the reorder is off); control-identity 92/92.

## G3 Painted numbers: PASS
The office tool run on a **copy** of `office/` (patch applied, real journal at 453e1306) produced `autopsy.json`; I painted that file. All figures equal EXPECTED, with the builder's one agreed change (the 10/19 stop that closed +$12.28 is excluded):
- Header **99 losing full stops of 346, −$21,159.10** (page −$21,159); "Not counted: 1 stop fill on the profit side (+$12.28)". Classes 31 / 19 / 13 / 9 / 27 = −6,376.30 / −3,688.42 / −3,067.08 / −2,078.44 / −5,948.86, add to −21,159.10; "small" on 19, 13, 9 only, no colour; each row shows bars versus polls ("at least"). Own TP1 distance: 1, −$254.16, 27 cannot be told. Overlays 21 / −$4,036.10 and NY after 09:00 22 / −$5,095.82. Asia 39 / −7,779.90 (EXPECTED 40 / −7,767.62 minus the excluded stop), London 27, NY 33.
- What-ifs: early exit saved +$687 on 5 of 21 stops, other trades −$10.50 (4 losers, 0 winners), net +$676.50; break-even after +10 saved +$442.50 on 2, 6 winners cut −$767, 4 losers +$175.50, **net −$149.00**; TP1 on touch +$340.50. Each labelled estimate, "small", with "21 of 99 stops with a minute path".
- Cards: 11/10 20:10 (Mon Nov 9 8:10 PM PT, −$254.16, R −1.05, 9.8 min, best +15.00 at 6.7, worst −41.75, control −0.33, break-even yes −$30.66 saved $223.50, TP1 on touch +$86.34); 23:57 (−$296.16, best +11.75 at 3.3, worst −48.75, **break-even UNKNOWN: same minute**); 11/11 (−$192.66, best +3.75, worst −31.50, class +3 to +10). All as EXPECTED.
- Scoreboard: eight cards; X-02 "+$195.00 broker · +$230 estimate"; X-03 n 7 with "13 fills carried the rule" and "this figure cannot move", not judgeable, no ETA; X-05 n UNKNOWN with reason; ETAs 12 / 6 / 50 TradeDays as EXPECTED (X-06, X-07, X-10); kill-if text equals the file; no coloured verdict.
- Day tie (model + painted, 11 checks on my 11/10 trades): −84.06 before commissions − 24.00 = net −108.06 = the broker's day; one cent apart, an extra broker round trip, fewer trips than rows, a row without commission, a row without net, no `dayTrips`: each UNKNOWN or the parts withheld, **no plug printed as a sum**.
- Every defect D1 to D13 of EXPECTED.md is addressed in the build except as noted in findings 1, 3, 4.

## G5 UNKNOWN states: PASS
`rv-23-states.cjs`: 54 checks pass; the 3 reported failures are my own fixtures (an "empty" fixture that still reports all trades −$4,915; the word "null" inside a leak note that 2.2.2 prints identically). 404, not JSON, schema 2, truncated, 300 KB, connection refused, `{}`, `[]`: each says why, no dollar figure, the rest of the Office paints, one request. Empty window "No full stop in the last 20 TradeDays"; no `experiments` key; different day between the two files (banner names both); **r1.3-shaped snapshot** (no `build`, no counters): three counters "UNKNOWN: bot build does not report this yet", "This bot" hash/restart/version UNKNOWN, no `r13.3.7`; edge r1.6 zero counters read "no cases yet" (different from old-bot); counted counters equal the fixture; hostile strings run no script and cause no sideways scroll; 160 seeded key deletions / nulls / NaN / objects through the model and painter: 0 junk tokens, 0 exceptions.

## G6 Budgets
- Size above. Existing suites re-run by me on the frozen bytes (`gate-rerun/GATE-LOG.txt`): autopsy 270, board 133, batchA 64, trades 175, office 409, surfaces-213 570, control-receipts 319, cascade 1030, surfaces-210 235, control-identity 92, budgets 912: all 0 failed, same counts as the builder's log. Builder edited three assertions in copies (office-22 ×2, surfaces-210 ×1) for the Review reorder and the new tie line; each is a fact 2.3 changes on purpose.
- **perf-23 Review open at 4x: does not block.** Builder's 3 runs: worst task 153 vs 125 ms. My 7 alternating runs: worst long task per run 2.2.2 [105, 119, 110, 99, 109, 107, 108], 2.3 [105, 122, 119, 118, 108, 125, 111]; medians 108 vs 118 ms (+9 %), task count 3 vs 3, total 224 vs 255 ms. The 3-run figure was the spread of the machine, not a step. Both pages are over the 50 ms house line on this opening (2.2.2 already); not made worse in count. Opening Full stops with the real 72 KB file, a class filter, an experiment's cases: no task over 50 ms in all 7 runs.
- Replay smoothness A/B: 28 passed, 0 failed (finding 7).

## G7 / G8 Batch A and the items not in 2.3
- Not in 2.3 (declared): Trade Rail, runner ledger, short-reason text, Control reorder. Not gated; nothing of them is in the bytes except the switched-off Control block. Control order test: identical to 2.2.2.
- Two totals: one tie line, no sum that does not close (above). Header: reason slot 158 → 241 px at 360 (188 → 271 at 390); still two lines for the 109-character reason, tap opens it whole (tested), stale never clamped; refresh button still polls once. Review leads with the Office, Download card last, no card lost (title inventory 2.2.2 against 2.3 at both widths). Tab bar text and order identical. Flight recorder time cell: 8 of 8 cells overran their 44 px box in 2.2.2, **0 of 8 in 2.3** (68 px), no overlap. "This bot": hash and last restart from the snapshot, version UNKNOWN; the "counted from Nov 2" note says it is a typed-in day.

## G9 Install and rollback: PASS (on a scratch copy; nothing real touched)
`set-terminal.sh` (sha d891ef9d, unchanged) with a copy of the bot's proxy file: wrong sha refused; install over 2.2.2 → 042bbb6b with a 99ec1630 backup; second install "already … nothing to install"; rollback → exactly 99ec1630; second rollback → 042bbb6b; proxy file byte-identical; no restart. **There is no INSTALL sheet for 2.3 yet**; it needs the sha above.

## Office patch (on a copy of `office/`)
`loop_daily.patch` applies cleanly; `loop_insight.py` added. `test_loop_insight.py` 23 tests OK with `TEAM_LINE_REPO` set (12 skipped without it); `test_loop_daily.py` 31 OK. Two full runs byte-identical except `generatedAt` (both files). Outputs: `autopsy.json` 76,170 bytes (cap 150,000), `office.json` 30,935 bytes; numbers equal EXPECTED. Only files under `office/` written. The existing office folder was not modified (repo clean).

## CHANGES read as a non-engineer
Clear and honest about estimates, what stays empty, and what moved. Add: (a) "Full stops stays on UNKNOWN until the office publishes its file; that is expected"; (b) the first thing to check after install: Review opens on the Office, the header reason is wider, a closed trade shows the same points everywhere; (c) the undo line (rollback). "Hash", "kill rule", "n counts" are fine for Mac but unexplained.

## Not verified
Mac's phone and server; a real 404 from the file host (tested with the harness route); real r1.6 counter rows (none in the journal yet); the Live look; the builder's perf and A/B numbers beyond my re-runs.

Scripts and output: `tests/rv-23-requests.cjs`, `rv-23-states.cjs`, `rv-23-truth.cjs`, `rv-23-tie.cjs`, `rv-23-batchA.cjs`, `rv-23-rl.cjs`; `out/`; `gate-rerun/`; `calc/`; `office-copy/`.
