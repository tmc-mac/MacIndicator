# Edge r1.2 heap-limit crash: measurements (ship-gate desk, 11/11, partial - stopped for the CPU priority change)

## Answers
1. **Confirmed: the crash comes from the journal size, not from the build.** With a 98.7 MB journal, r1.1 and r1.2 both die at `--max-old-space-size=493` and both survive at 560, 640, 768 and 1024.
2. **r1.2 needs no more heap than r1.1.** Same pass/fail at every size and limit run; peaks within 3 MB in all but one pair.
3. Streaming plan below. The per-reader numbers are from one benchmark run on the 98.7 MB journal; the plan is not implemented or tested.

## Table (rig, Node 18.19.1, pine config, real 2000-bar warm-up, 10 virtual minutes after start)
Journal = the published 11/09 journal (92.2 MB, 103,579 rows): its last 25 / 50 MB of whole rows, or the whole file plus its own most recent rows again to reach 98.7 / 150 MB.

| Journal | Limit | r1.1 | r1.2 | Peak heapUsed r1.1 / r1.2 (MB) | Peak RSS r1.1 / r1.2 (MB) | Real s to live loop r1.1 / r1.2 |
|---|---|---|---|---|---|---|
| 25 MB | 493 | survives | survives | 196 / 196 | 479 / 468 | 3.1 / 3.3 |
| 50 MB | 493 | survives | survives | 372 / 372 | 576 / 576 | 2.7 / 2.8 |
| 50 MB | 1024 | survives | survives | 340 / 470 | 695 / 696 | 3.2 / 3.2 |
| 92 MB | 240, 256, 384 | dies | dies | - | - | - |
| 92 MB | 512 | survives | survives | 400 / 401 | 592 / 591 | not timed |
| 98.7 MB | 493 | **dies** (4th journal read) | **dies** (4th journal read) | 601 / 601 at death | 863 / 865 | 2.7 / 3.0 |
| 98.7 MB | 560 | survives | survives | 601 / 601 | 871 / 863 | 2.7 / 2.9 |
| 98.7 MB | 640 | survives | survives | 712 / 712 | 984 / 970 | 3.5 / 3.0 |
| 98.7 MB | 768 | survives | survives | 712 / 712 | 966 / 970 | 3.0 / 3.0 |
| 98.7 MB | 1024 | survives | survives | 715 / 716 | 983 / 985 | 2.9 / 3.2 |
| 150 MB | 493 | dies (3rd journal read) | dies (3rd journal read) | 608 / 611 at death | 944 / 919 | 3.0 / 2.9 |
| 150 MB | 1024 | survives | survives | 1073 / 1073 | 1385 / 1386 | 2.9 / 2.9 |

Not run (stopped): 25 MB at 1024, 150 MB at 800, the low-limit runs at 25 and 50 MB.

Reading the table:
- heapUsed is sampled every 250 ms and at each journal read; the sampler is blind inside a synchronous block, so a peak can be under-read. The 50 MB / 1024 pair (340 vs 470) is that, not a build difference: 372 / 372 at 493.
- Peak heapUsed can exceed the old-space limit (601 at 560, 1073 at 1024): heapUsed counts more than the limited space. Pass / fail is the reliable column.
- Seconds to live loop are CPU only on this machine: the rig answers broker calls on a virtual clock. On the server add the real call latency.
- After start-up the heap falls to 21-82 MB (98.7 MB journal, both builds). The peak lasts a few seconds.

## Growth and how long 1024 lasts
- Smallest surviving limit at 98.7 MB is between 493 and 560: about 5.0 to 5.7 MB of limit per MB of journal. The 92 MB runs agree (384 dies, 512 survives).
- On that slope 1024 stops being enough at a journal of about 180 to 205 MB. At 5 MB a day from 98.7 MB that is 16 to 21 trading days. Not measured directly: the only 150 MB runs are 493 (dies) and 1024 (survives).
- **RSS is the nearer problem.** At 98.7 MB the start-up peak RSS is 860-985 MB on a 961 MB server, so every start already leans on swap; at 150 MB it is 1.39 GB. Raising the limit does not lower it (970 MB at 640, 985 at 1024).

## Why it scales: the start-up readers (r1.2 line numbers; r1.1 is the same code)
`readFileSync(journal,'utf8')` of the 98.7 MB file is a 188 MB string (the journal has non-ASCII characters, so 2 bytes per character). It is read five times at start-up, a sixth when a position is adopted without saved state.

| Reader | What it does now | Kept live on 98.7 MB (beyond the 188 MB string + 4 MB split) | What it actually needs |
|---|---|---|---|
| R1 `seedTradeEventIndex` :2923 | parses every non-signal_check row (28,220), one at a time | about 0 | the last 600 entry / manual / peak rows (`TRADE_EVENT_CAP`), plus the display indexes it feeds |
| R2 plan restore :3049 | substring filter, parses and keeps matching rows | 3,678 rows (about 10 MB) | trade_plan / plan_terminal / evidence rows of plans inside the retained outcome cache |
| R3 `reconcileOrphanedPendingJournalRows` :2970 | parses ALL rows, keeps signal_check rows with a journalId | 2,020 rows (3 MB) | per journalId: the row count and the row when it is the only one and `pending` |
| R4 `reconcileOpenJournalTrades` :4170 | parses and KEEPS ALL rows | **113 MB** (109,430 rows; 81,210 are signal_check, only 2,020 of those carry a journalId) | `entry`, `peak_unrealized` and signal_check-with-journalId rows; the open test uses a 30-trading-day window |
| R5 `backfillJournalFromBroker` :4227 | parses and KEEPS ALL rows | **113 MB** | `entry` rows and signal_check-with-journalId rows (confirmed ids and used broker keys come from all history, candidates from 30 trading days) |
| R6 adopt without state :4690 | splits, parses every non-signal_check row | not measured | the rows after the open trade's entry row: the current trading day |

R4 and R5 dominate: string 188 + parsed rows 113 + the split and filter arrays, about 310 MB each, and the 493 runs die in the 4th read (R4) at 98.7 MB. Why the measured need (500-560) is above 310 was not resolved: no heap snapshot was taken.

## Proposed fix for the next build (not implemented)
1. One synchronous chunked line reader (`fs.openSync` + `readSync` into a 1-4 MB buffer, split on the newline byte, decode one line at a time), called once at start-up. Synchronous because R1 and R2 run in synchronous start-up code.
2. Each consumer gets every line through a small collector and keeps only its rows:
   - R1: skip signal_check by substring as today; feed `indexTradeEvent`. No change in result.
   - R2: today's substring filter and regex unchanged.
   - R3, R4, R5: parse a line only when it contains `"journalId"` or is an `entry` / `peak_unrealized` row. That drops about 79,000 of 81,210 signal_check parses and the 113 MB arrays; the three functions then run on the same filtered list (a few MB). Results are identical because all three already ignore every other row.
   - R6: the same reader, keeping only non-signal_check rows from the last matching entry row on.
3. Expected start-up peak: one chunk plus a few MB of kept rows, independent of journal size. To prove before shipping: the same table, plus byte-identical journal rows and log lines from the three reconcile steps on the real 92 MB journal, old code against new.
4. Windows that could be tightened later (each changes behaviour, so each needs its own check): R3 to 30 trading days (today every lone pending row in all history is re-checked at every start); R5's confirmed / used-key sets must stay all-history or a broker round trip could be matched twice.

## Limits of this work
- One machine with 16 GB; the heap limit was set by flag. The server's 493 MB default was not reproduced by other means.
- The 98.7 and 150 MB journals repeat recent rows (repeated journalIds), and the rig clock is 11/02 while the journal runs to 11/09.
- The rig serves no fill history and no real scorecard history; the scorecard file was the witness run's (2 trades).

Files: `oomrun.sh`, `mem.cjs` (observer preload), `readers-bench.js`, `readers-bench-j99.out`, `runs/*.json` (one line per run), `runs/discarded/` (runs I interrupted; not used).
