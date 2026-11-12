# Terminal 2.3: tests on the frozen candidate

Candidate: `mobile.html` sha256 `042bbb6b3f82c2d16e2038d1e52c0cf5def2db9974e2af0f1eebd30a67218268`, 1740780 bytes (2.2.2: 1,661,936; growth 78844 bytes, 4.7 %). Sha after all runs: `042bbb6b3f82c2d1…`. Base check in the build: removing the appended script and stylesheet and the 27 clock-formatter sites gives 2.0.9.10 back byte for byte. Installer `set-terminal.sh` unchanged (not touched, not copied).
Gate log: `gate/GATE-LOG.txt`; each suite's output beside it. Node v22.22.0, one browser at a time, nice 19.

## Suite counts (gate run on the frozen bytes)
| Suite | Result |
|---|---|
| autopsy-23 (Full stops, new) | autopsy-23: 270 passed, 0 failed ( |
| board-23 (scoreboard + three counters, new) | board-23: 133 passed, 0 failed |
| batchA-23 (audit batch A, new) | batchA-23: 64 passed, 0 failed  |
| trades-222 (resolver) | trades-222: 175 passed, 0 failed ( |
| office-22 | office-22: 409 passed, 0 failed ( |
| surfaces-213 (painted) | surfaces-213: 570 passed, 0 failed ( |
| control-receipts-210 | control-receipts-210: 319 passed, 0 failed |
| cascade-210 | cascade-210: 1030 passed, 0 failed |
| surfaces-210 | surfaces-210: 235 passed, 0 failed  |
| control-identity vs 2.0.9.10 | control-identity-210: 92 passed, 0 failed  |
| budgets-210 (3 states x 3 widths x 2 themes x 7 tabs, contrast, clocks) | budgets-210: 912 passed, 0 failed |
| requests vs 2.2.2 | see below |
| perf-23 (Review open at 4x CPU vs 2.2.2) | perf-23: 11 passed, 1 failed (3 alternating runs per page, C |
| replay smoothness A/B vs 2.2.2 | replay-smooth-2099: 28 passed, 0 failed |
| office tool: test_loop_insight.py | 23 tests OK on the real journal (agent-line 453e1306) |
| office tool: test_loop_daily.py with the patch applied | 31 tests OK |

Existing-suite assertions changed in this folder's copies, each because 2.3 changes that fact on purpose: office-22 (2: Review now leads with the Office; Full stops sits after "Today and the week"), surfaces-210 (1: the day tie line sits between the Trades day figures and the rows). No other existing test file was edited.

**perf-23: 11 of 12 pass; the one failure is stated, not hidden.** Review-open at 4x CPU, median of 3 alternating runs: 2.2.2 4 long tasks / worst 125 ms / 332 ms total; 2.3 4 tasks / worst 153 ms / 348 ms total. The task count no longer rises (an earlier build added 2 tasks; the scoreboard cards, what-if blocks and stop cards are now built one per task). The worst task is 28 ms (22%) above the 15% limit I set; 2.2.2 itself is far over 50 ms on Review open at this profile (the Office section's first paint). Run-to-run spread on this shared machine is of the same size (2.2.2 alone ranged 105 to 185 ms in one batch). Treat as a known limit, not a pass.

**autopsy-23 (earlier note):** "no long task over 50 ms from the tap to the painted section at 4x CPU" on a synthetic 150 KB file (201 stops, twice the real file). It read [] in the pre-freeze run and [53] in the gate run. INSIGHT's own limit for that file (paint under 200 ms) passes at 36 to 46 ms. The real 72 KB file is covered by perf-23.
150 KB file (201 stops) at 4x CPU: repaint 36.0 ms; long tasks after the tap []

## Requests
`drop1-requests.cjs` against the 2.2.2 page (`gate/13f-requests-vs-222.txt`):
- r133eod      requests IDENTICAL (10)  dialogs IDENTICAL (0)  /bias IDENTICAL  per-step IDENTICAL  external 1  errors live 0 drop 0 (drop-only 0)
- r133paused   requests IDENTICAL (1)  dialogs IDENTICAL (0)  /bias IDENTICAL  per-step IDENTICAL  external 0  errors live 0 drop 0 (drop-only 0)
- r133trade    requests IDENTICAL (2)  dialogs IDENTICAL (2)  /bias IDENTICAL  per-step IDENTICAL  external 0  errors live 0 drop 0 (drop-only 0)
- r133pending  requests IDENTICAL (1)  dialogs IDENTICAL (0)  /bias IDENTICAL  per-step IDENTICAL  external 0  errors live 1 drop 1 (drop-only 0)
The file's last line reads "DIFFERENCES FOUND" as it did in the 2.2.2 gate: the capture flags the one external read (the Office file) in the r133eod scenario; the four request lists are identical. Flatten, pause, resume and cancel: same method, path, query and empty body as 2.2.2 (the POST lines in that file).

Every request the page makes:
| Request | When | In 2.2.2? |
|---|---|---|
| GET /mobile.html, GET /bias (poll), GET /trade-list, /trade-stats, /signal-journal, /trade-blocks, /trade-why, /trade-journal-download | as in 2.2.2 | yes, unchanged |
| POST /pause, /flatten, /cancel-entry | two-tap controls | yes, byte-identical |
| GET raw.githubusercontent.com …/office/state/office.json | Review opened, refresh at most once per 5 min | yes, unchanged |
| **GET raw.githubusercontent.com …/office/state/autopsy.json** | **only after "Show the full stops" is tapped; refresh button at most once per 5 min while open** | **new: the one added request** (INSIGHT 3.1; not a request to the bot) |
Checked in autopsy-23: no request when Review opens; exactly one on the tap; GET, no credentials, no referrer, cache no-store, no redirects; no second request inside 5 minutes. The scoreboard and the counters make no request.

## Budgets
- Page size: see the first line.
- Review open at 4x CPU, alternating with 2.2.2 (`gate/70-perf-23.txt`):
  - Review open at 4x CPU, long tasks per run (ms): 2.2.2 [[85,117,52,68,75],[62,125,53,92],[86,169]] | 2.3 [[82,153,77],[86,112,66,84],[92,52,291,82,67,95]]
  - median run: 2.2.2 4 tasks, worst 125 ms, total 332 ms | 2.3 4 tasks, worst 153 ms, total 348 ms
  -   Review open at 4x: worst long task 153 ms vs 125 ms on 2.2.2 (limit: 50 ms, or the reference + 15%)
- Opening Full stops (real 72 KB file), a class filter and an experiment's cases at 4x: see the same file (each "no long task over 50 ms").
- budgets-210: no sideways scroll at 360 / 390 / 428, contrast, 24-hour clock sweep: line above.
- Replay smoothness against 2.2.2 (`gate/15-replay-smooth-ab-vs-222.txt`):
  - CASE DONE reel 1x at 08:52:16Z | ref p95 33.4 max 100 lt 381 shapes 3 | page p95 33.4 max 117 lt 402 shapes 3 brain 0/0 errors 0
  - CASE DONE reel 4x at 08:56:12Z | ref p95 50.1 max 417 lt 2034 shapes 3 | page p95 50.0 max 467 lt 2065 shapes 3 brain 0/0 errors 0
  - CASE DONE chart 1x at 08:58:25Z | ref p95 33.4 max 133 lt 383 shapes 20 | page p95 33.4 max 83 lt 320 shapes 20 brain 0/0 errors 0
  - CASE DONE chart 4x at 09:00:37Z | ref p95 33.4 max 450 lt 1567 shapes 18 | page p95 50.0 max 517 lt 1839 shapes 17 brain 0/0 errors 0

## Acceptance numbers
**The reviewer's corrections are in. Old (INSIGHT's rule) against corrected, both from the same tool run on the real journal:**
| | INSIGHT / ledger flag | 2.3 (corrected) |
|---|---|---|
| Full stops in the window | 100, −$21,146.82 | **99 losing, −$21,159.10**; 1 stop fill on the profit side (10/19, +$12.28) is listed as not counted |
| Classes | never +3 31 / −6,376.30; +3 to +10 20 / −3,676.14; +10 to +15 13 / −3,067.08; "touched TP1, no fill" 9 / −2,078.44; no reading 27 / −5,948.86 | bands of the best SEEN, by points: under +3 31 / −6,376.30; +3 to +10 **19 / −3,688.42**; +10 to +15 13 / −3,067.08; +15 or more 9 / −2,078.44; no reading 27 / −5,948.86. From 1-minute bars 13 / 4 / 2 / 1, from polls or the exit only ("at least") 18 / 15 / 11 / 8 |
| "Touched TP1" | 9, −$2,078.44, credited to X-08 | **reached its own TP1 distance, not filled: 1, −$254.16** (27 cannot be told); no class is credited to an experiment |
| By session | Asia 40 / −7,767.62 | Asia **39 / −7,779.90**; London 27 / −5,138.24; NY 33 / −8,240.96 |
| Break-even after +10 | priced at entry: +474 on 2 stops, net +$141 | priced at the trigger close: **+442.50 on 2 stops, 6 winners cut −767.00, 4 losers +175.50, net −$149.00** (estimate, small) |
| Early exit | +687 on 5 stops; winners 0 | +687.00 on 5 of the 21 stops with a minute path; **all other trades −10.50 (4 losers, one −$5.16 becomes −$150.66)**; net +676.50 |
| TP1 on touch | +340.50, 1 stop | same |
| X-02 value | +$229.50 | **+$195.00 broker** shown first; +$229.50 labelled "estimate at the decision price" |
| X-03 | n 7 of 20, $86.34 | n 7 with "13 fills carried the rule, the verdict rule counts live trades"; value marked as a constant; no time to verdict |

Unchanged and reproduced: overlays re-entry ≤ 30 min 21 / −$4,036.10, NY after 09:00 PT 22 / −$5,095.82; TradeDay 11/10 two stops −$254.16 (best +15.00, worst −41.75) and −$296.16 (best +11.75, worst −48.75, break-even UNKNOWN: same minute), −$550.32; TradeDay 11/11 one stop −$192.66 (best +3.75, worst −31.50). Scoreboard: X-05 n UNKNOWN; verdict in about 6 (X-07, 71 in the window), 12 (X-06, 35), 50 (X-10, 8) TradeDays; X-03 / X-04 / X-05 not judgeable, X-10 partly. Counters on a real r1.6 snapshot shape with nothing counted: 0 with "no rows yet" / "no cases yet"; without the keys: UNKNOWN "bot build does not report this yet".
The closed-net table of TradeDay 11/10 (gross −49.50, fees −34.56, commissions −24.00, net −108.06) is not painted by a 2.3 view; the tool's ledger gives the same net (−108.06, 16 trades).

**Signature (path strip):** scale rule = 1.5 px per point on every strip (entry-to-stop gap measured on 4 strips at 360 / 390 / 428: within 0.04 px per point); values beyond −80 / +40 pts sit at the edge with a starred true number. Labels: 0 overlaps, 0 clipped, order kept on the 5-stop fixture at three widths and on 48 real strips at 360 px light; packer fuzz 2,000 sets, 0 overlaps.

## Batch A (audit)
In: defect 1 (day tie; reproduced on the flat-day fixture: $86.00 apart on the same 30 round trips, reads UNKNOWN; a difference is never printed as a sum), defect 3 (reason slot 134 px → about 240 px, tap for all, stale never cut), defect 5 (route times), defect 8 ("This bot": code hash and last restart, version UNKNOWN), Review leads with the Office. Out (2.3.1): Control reorder (fails control-identity, switched off), Trade Rail.
On the real journal, TradeDays 11/10 and 11/11: ledger = broker receipts to the cent (the daily cards). The account-day figure is not in the journal, so the gap was not reproduced on a real day.

## Screenshots
`shots/` 390x844 at 2x, replay-marked: stops-* (closed, loading, good, filter, UNKNOWN, stale, empty, 404, not recognised, light), board-* (loading, good, cases, n UNKNOWN, stale, old file, empty, decision due), counters-* (zero, counted, stale, UNKNOWN, office not loaded), a-* (batch A), options/ (mocks for OPTIONS.md).
