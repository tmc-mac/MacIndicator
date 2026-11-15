# edge r1.7: edge r1.6 + RECORD-ONLY after-exit rows (post_exit) and the old-rule path (X-02, X-03, X-04, X-10)

Mac, 11/14 (weekly card R-06): "approve a record-only journal build (price path for 60 minutes after every exit, old-rule counterfactual for X-03 and X-04)", together with a freeze of r1.6's trading logic for 10 complete TradeDays. This build changes NO entry, exit, stop, size, cooldown, alert or order. The order machine, exits, scorecard, proxy, watchdog and health alerts are the r1.6 files byte for byte.

Base: edge16 a6b4f0d (edge r1.6, executor sha8 26089560). Branch edge17, one local commit (see HANDOFF line at the end). Nothing pushed, installed or posted.

## What changed (files)
| File | Change |
|---|---|
| `lib/postExit.js` | NEW (254 lines). The tracker module: no broker access (requires only `fs`), no order, no fetch, no token. |
| `live-executor.js` | +14 lines, 1 line changed: `require` (line 65), the `afterExitRecord: 'on'` default and its comment (1503-1505), the enum entry in `CONFIG_ENUMS` (1678, the one changed line), startup validation + log line (2094-2095), the tracker object (2969-2971, only when LIVE and the switch is `on`), `indexJournal` feed (2975), `load()` (3127, before the state machine exists; its own try / catch), the poll call after `score.onPoll` inside its own try / catch (6311). |
| `tools/set-afterexit.sh` | NEW. `show | on | off | clear`, same shared safe-write core as `set-runnerlock.sh` (backup, staged write, verified read-back, startup-line check, automatic put-back). |
| `tests/edge17-tests.js` (54), `tests/afterexit-tool-tests.sh` (14) | NEW. |

Everything else (liveStateMachine, edgeExits, scorecard, liveOrders, safeExit, stopFloor, healthAlerts, phoneSnapshot, tmc-proxy, health-watchdog, set-runnerlock.sh) is identical to r1.6 (test H9 compares sha256).

## What it records
One tracker per trade from the first sight of the open trade (the scorecard's trade view, the same one the scorecard uses) to 60 minutes after the exit, whether or not another trade opens. The exit is "the order machine is FLAT / PENDING_ENTRY, not desynced, and no trade is seen" (a halted or desynced machine never counts as an exit); a different trade appearing also ends the old one. ONE `post_exit` row is written when the tracker ends. Inputs are only what the poll already has: the poll price (20 s), the last three 1m bars it already fetched, the scorecard's trade view, and two journal rows the bot already writes (`trade_time`: close time / price; `trade_manage` TP1_FILLED: its time). No new request, no change of cadence.

Price counts as a sample only while the newest 1m bar is at most 5 minutes old (market closed = no sample, so a break is a gap, never a flat line). Bars count only when completed and started after the watch began; the poll price counts at the poll time. The exit minute: `post.*` uses only prices after the exit (polls after the exit; bars from the next minute); the path bucket of that minute mixes before and after.

### Row `post_exit` (schema version 1; example in `example-post_exit.json`)
```
type, t, version, journalId, session, dir, runnerMode, contracts,
fill, fillAt, pathFromFill, stopPrice, stopPts, tp1Price, tp1Pts, tp2Price, atr15,
exitReason (the bot's own exit-reason index: TP1 TP2 STOP RUNNER_STOP EARLY_EXIT NO_PROGRESS LEVEL_LOSS SESSION_CLOSE MORNING_HOLD MANUAL_FLATTEN UNKNOWN),
exitAt, exitPrice, exitSide (SELL for a long, BUY for a short), exitPriceSource, exitDetectedAt, exitSeenAfterRestart,
windowMin (60), horizonMin, extendedFor (null | "old-runner-rule"),
post: { fromExit: {bestPts, worstPts, bestAt, worstAt},                 points from the exit price, 60 min after the exit
        fromEntry: {bestPts, worstPts, bestPrice, worstPrice, bestAt, worstAt},   points from the fill and the prices
        firstTouch: { fromExit: {p5,p10,p15,p25,p50}, fromEntry: {p5,...,p50},    first minute each level was touched in the trade direction (ms, minute resolution) or null
                      stop, tp1, tp2, reclaim },                          the ORIGINAL stop price, TP1, TP2 prices; reclaim = price back at the fill
        minutes },
samples, pollSamples, barSamples, maxGapMs, coveredMin, windowComplete,   all for the 60-minute window
horizonSamples, horizonMaxGapMs, horizonCoveredMin,                       only when extendedFor is set
priceSource ("poll+bar1m" | "poll" | "bar1m" | "none"),
cut (null | "restart" | "session_end" | "price_gap" | "cap"), cutWhy, restarts,
oldRule: null | { lockPts, stepPts, tp1FilledAt, tp1Seen, closeAt },     the old runner rule's numbers (CONFIG.scaleOutRunner) and the TP1 fill time; only allAtTp1 / atrTarget trades
lastPts, lastAt (the last price seen, points from the fill), pathFrom, pathStepMs (60000),
path: [[minute offset from pathFrom, high, low], ...]  points from the fill, favourable positive; one bucket per minute from the fill to the end of the follow-up; at most 720 buckets,
pathTruncated, note
```
Why `exitCode` is not written: the bot's start-up TP1 reader keeps every journal line containing the quoted token `TP1_FILLED`; a row carrying it would be kept in memory at every start and read as TP1 evidence. The row has no key or value any of the three start-up collectors (plan, TP1, reconcile) keeps (test F1 runs the real collectors on a row). The `entry` key is called `fill`, the first-touch key `reclaim`, for the same reason.

### Old-rule counterfactual (X-03 / X-04), no dollars in the bot
For trades under `allAtTp1` / `atrTarget` (2+ contracts) that reached TP1 the tracker follows the price until the old runner shadow's own end (240 min from the fill or the session close, never less than 60 min after the exit): `extendedFor: "old-runner-rule"`. The row carries the whole path from the fill, the old rule's `lockPts / stepPts`, TP1 numbers and `lastPts`, so the office replays the old rule itself, with a range for the unknown order of high and low inside a minute. The formula, a Python module and the X-02 / X-10 / what-if formulas are in NOTE.md and `office_formulas.py`; on three test paths the formula gives exactly the bot's own `runner_shadow` row (points and dollars; `check_formulas.py`).

### Row `post_exit_error` (example in `example-post_exit_error.json`)
`{ type, t, where (poll | arm | exit | step | refresh | row), message (200 chars), pending, note }`, at most one per 10 minutes. A tracker that errors 5 times is dropped.

## Switch `afterExitRecord` ("on" default | "off")
- In `CONFIG` (default `'on'`) and `CONFIG_ENUMS`, so `config-local.json` accepts `"afterExitRecord": "on" | "off"` and refuses anything else (`"afterExitRecord" must be one of "on" or "off"`).
- Startup lines: `[after-exit] afterExitRecord: ON (record only: one post_exit row per trade, 60 min after every exit, up to 240 min from the fill for old-runner-rule trades; no order, no request, no decision reads it)` or `[after-exit] afterExitRecord: OFF (no post_exit rows, no state file: the r1.6 journal exactly)`; then `[after-exit] no pending trackers` / `N tracker(s) resume from the state file`.
- `off` = no tracker object is created, no state file is written or read, no row: journal rows, orders and state equal r1.6's (rig result below).
- `tools/set-afterexit.sh show | on | off | clear` (show is read-only; the others need the bot flat and one restart; checked against the startup lines, put back on any failure).
- **Rollback to r1.6:** r1.6's strict loader REFUSES an `afterExitRecord` line (`unknown setting "afterExitRecord"`, test H5). Before rolling back run `bash set-afterexit.sh clear` (flat), then roll back. `off` leaves the line (so does `on`); only `clear` removes it. A config-local.json with no `afterExitRecord` line starts r1.6 and r1.7 alike. The tool refuses to run on a bot that does not know the key (it would write a line r1.6 cannot start with): on an r1.6 bot remove the line by hand.

## Restart behaviour (chosen: persist and resume; the simpler option that loses nothing)
State file `postexit-MNQ.json` beside the bot (tmp + rename, written at most once a minute and on every tracker start / exit / finish; at most 6 trackers, 720 buckets each: under about 120 KB). `load()` (before the state machine exists, one small file, parse only, in try / catch) never writes a row, never blocks the live-trade restore. In the first poll a resumed tracker continues (`restarts` + 1; the downtime shows as the largest gap), or, when the window ended while the bot was down or no price came for more than 10 minutes, ends with `cut: "restart"`. A trade that was open at the restart and is flat afterwards: `exitSeenAfterRestart: true`, the window starts at the first poll that sees it flat (the exit price / time then come from the `trade_time` row when the journal has it). A SIGKILL loses at most the last minute of samples and the in-memory minute buckets of that minute. Order of events at the end of a tracker: removed from the state file and saved FIRST, row appended SECOND: a kill between them loses that one row, never writes it twice.

## Limits (memory and time)
- At most 6 trackers per symbol including the open trade; a seventh ends the oldest with `cut: "cap"` (it still writes its row). More than 720 path buckets: `pathTruncated`, the 60-minute statistics are unaffected. Per-row size: a few KB; the journal grows about 13 rows x 5-15 KB a day. Nothing is appended to a structure read at start: the rows go to the journal file through `appendJournal` and are invisible to the start-up collectors.
- Minute resolution; the order of high and low inside a minute is unknown. A trade that opens and closes between two polls (under 20 s) has no row. `pathFromFill` is true when the trade was first seen within 90 s of the fill time stamp the bot holds; an adopted position's stamp is its first sight, so a trade adopted after a restart WITHOUT a state file reads `true` from the restart on (with the state file the tracker simply resumes). The old-rule replay is valid only with `pathFromFill: true`.
- A tracker error writes one `post_exit_error` row per 10 minutes at most and never reaches the state machine: the poll call is inside its own try / catch, every method catches its own errors.
- The state file is written at most once a minute and only while a tracker exists: no cost when flat.

## Tests and gate results (offline and rig; Node 18.19.1; nothing was run against the server, the broker or the account)
Suites on the r1.7 tree (`suites.sh`, nice 19): edge17 54/54, edge1 79/79, edge15 45/45, edge16 43/43, health-alerts 28/28, runnerlock tool tests 23/23, afterexit tool tests 14/14, node:test files (test/*.test.js) 122/122 (control-parity 6, day-counters 10, emit-once 11, fetch-retry 10, journal-lines 9, owner-flag 19, phone-snapshot 24, proxy-journal 2, runner-shadow 13, scorecard 18). Office formula check (`check_formulas.py`): 3/3 paths give the bot's own `runner_shadow` row exactly.

`tests/edge17-tests.js`: A first touches long / short on hand-built paths (exact minutes, best / worst from the fill and from the exit); B two trades, the second opens inside the first one's window: two independent rows at their own +60 min; C session end / price gap / restart resume / window passed while down / trade open across a restart / first seen late; D tracker cap (6, `cut: "cap"`) and sample cap (720 buckets, truncated, statistics unaffected, state under 120 KB); E error injection (failing journal, failing reason lookup, garbage inputs, a throwing step: no throw, one error row per 10 minutes, dropped after 5 errors); F rows invisible to the start-up collectors (real collectors from lib/journalLines.js), exact key list, extended horizon vs 60-minute statistics, trade_time / TP1 hints; G old-rule formula = the real scorecard's `runner_shadow` on three paths; H loader accepts / refuses, r1.6 loader refuses the key, source-level identity (nine r1.6 files byte-identical, the only removed executor line is the `CONFIG_ENUMS` line), `lib/postExit.js` requires only `fs`; I tool.

Whole-executor replay (the gate rig of the r1.6 gate: real `live-executor.js` on virtual time against the fake broker, synthetic +130 NY runner day on the 11/02 data, 17:00-19:30Z, 4 trades, one early exit, one profit-lock runner; Node 18.19.1, heap 1024, one core each, seed 1; r1.6 = commit a6b4f0d archive):
| run | broker calls | journal rows without post_exit and session_stamp | scorecard / day state | post_exit rows |
|---|---|---|---|---|
| r1.7 `afterExitRecord` on (config-local "on") vs r1.6 | 78 / 78 identical | 626 / 626 identical | identical | 1 (the other trackers were still inside their window or extended horizon) |
| r1.7 `off` vs r1.6 | 78 / 78 identical | 626 / 626 identical | identical | 0, no state file, no startup tracker line other than OFF |
| r1.7 with EVERY tracker method throwing (module replaced by one that throws from load / indexJournal / onPoll) vs r1.6 | 78 / 78 identical | 626 / 626 identical | identical | 0; `[after-exit] state load failed (non-fatal)` logged, bot ran to the end |
The only journal row that differs is `session_stamp` (code file list and the settings key list, by design). The phone snapshot differs only in `build.*` ids and `configLocal.overrides` (the new key). Scripts: `idrun.sh`, `idcompare.py`.

Restart soak (rig, `rsrun.sh`): the bot is stopped at 17:40 with one tracker in its post window and one trade still open, and started again 5 s later from the carried state: `[after-exit] 2 tracker(s) resume from the state file`; the post tracker finishes at its own +60 min with `restarts: 1`, `cut: null`, `windowComplete: true`, largest gap 61.6 s; the open trade's tracker resumes with its path from the fill and finishes its exit (`restarts: 1`).

Mac-box run (`memrun2.sh`): 1 core, a 961 MB memory cgroup (swap limit 1.96 GB), Node 18.19.1, `--max-old-space-size=1024` (the live drop-in), the 98.7 MB real-size journal (j99, grows to 99.7 MB over the run), real 2000-bar warm-up, virtual 17:00-21:20Z with all four trades and six trackers: live loop after 4.3 s, peak RSS 337 MB (sampler 347 MB; the r1.6 gate on the same journal: 316-326 MB at heap 493), peak heapUsed 106 MB, cgroup peak 318 MB, cgroup failcnt 0, exit 0, no heap error. Six trackers were still pending at the end (the rig's data stops at 20:47Z): in the state file, resumed or ended with a cut at the next start. Not measured: a restart soak on the 98.7 MB journal, the proxy under load (tmc-proxy.js is byte-identical).
