# Edge r1.5 ship gate (G1-G3, G5-G7) - reviewer desk, 11/11

Tested: branch edge15 at 91b4a5b (git archive in pkg/t15). Baseline r1.4 = 79b3c3b (pkg/t14). The earlier freeze eaf14b6 was superseded; only boot numbers from it were taken and all were re-run on 91b4a5b. Changed files vs eaf14b6: lib/liveStateMachine.js, tools/set-runnerlock.sh, tests, EDGE-R15.md. proxy, healthAlerts.js, health-watchdog.js are byte-identical to r1.4. G4 (install path) not run, as ordered.

| Gate | Result |
|---|---|
| F1 set-runnerlock.sh clear/off, against a stub | PASS |
| F2 runner_exit once on market-through-lock | NOT EXERCISED on the rig (unit test L5b only, see below) |
| F3 restart after old stop cancelled does not loosen | PASS (rig, kill hook) |
| G1 Mac-box boot, 98.7 MB and 150 MB, r1.5 and r1.4 | PASS |
| G2 SIGKILL soak incl. lock kills | PASS (3 notes) |
| G3 trade witness: a55, a45, lock off, natural 11/02 | PASS |
| G5 health alerts | PASS |
| G6 proxy, 24 responses | PASS |
| G7 real clock 13 min, 1 core each | PASS (no regression) |
| loop_daily.py field names | PASS, no mismatch |

Builder suite on the archive (node 18.19.1): tests/edge15-tests.js 45 passed 0 failed; tests/health-alerts-tests.js 28/0.

## Fixes re-confirmed
- F1 `set-runnerlock.sh` against a stub (stub systemctl / journalctl / sleep, MACBOT_DIR temp dir, answer YES): `clear` on {"sessionRunnerNy":{"stopPts":2,"lock":{"mode":"off"}},"foo":1} leaves {"sessionRunnerNy":{"stopPts":2},"foo":1}; `clear` on a file holding only lock.mode removes the sessionRunnerNy line and keeps "foo". Both print the new NOTE (clear = shipped default ON applies; to keep it off use `off`) and expect the startup line "profit lock: ON" (it matched). `off` writes lock.mode "off", expects "off (" and prints the REMINDER to run clear before a rollback. Confirmed on the rig that r1.4 REFUSES such a file: "CONFIG-LOCAL ERROR ... unknown setting sessionRunnerNy.lock" (rollback order: clear, then roll back; `off` is not enough).
- F2 NOT run on the rig. Reaching it needs a >35-point jump between the arming poll and the stop placement (about 0.3 s); only a bar-boundary gap does that and the poll phase would have to land within a second of a minute boundary. Covered only by the builder's unit test L5b (profit_lock_market, one row, price 20012). Rig-level: not shown.
- F3 rig, kill hook after the broker processed the old-stop cancel and before the state save (soakD): restart printed "the saved runner stop is gone but a 1x stop rests @ 28563.75 (the profit lock's) - adopted, not cancelled", placed no order, runner exit at 28563.75, one runner_lock row, book empty at the end. Not loosened to +2.

## G1 Mac-box boot
taskset one core, 961 MB memory cgroup (this machine has no swap, harder than the server), Node 18.19.1, --max-old-space-size=493, pine config, real 2000-bar warm-up ("warm-up OK: 2000 15m bars ... after 1 s"), 10 virtual minutes 11/02 14:10-14:20Z, exit 0, no OOM, 0 ERROR in loop / FATAL / heap errors. 150 MB journal = j99 + the first 51.5 MB of j99 appended (copied, never linked; 175,344 valid lines).

| Run | Seconds to live loop | Peak heapUsed | Peak RSS (sampler / VmHWM) | Cgroup peak, failcnt |
|---|---|---|---|---|
| r1.5, 98.7 MB | 4.48 | 83 MB | 320 / 348 MB | 354 MB, 0 |
| r1.4, 98.7 MB | 4.97 | 81 MB | 323 / 328 MB | 325 MB, 0 |
| r1.5, 150 MB | 4.23 | 99 MB | 306 / 322 MB | 326 MB, 0 |
| r1.4, 150 MB | 4.50 | 91 MB | 305 / 325 MB | 322 MB, 0 |
Startup line prints: `[runner-lock] NY runner profit lock: ON (... +50 -> stop entry +10 ...)`. r1.5 is within noise of r1.4 (box shared with other desks, +/- 10-30 MB, journals in r1.5 grew to 98.74 / 150.2 MB).

## G2 SIGKILL soak (real SIGKILL, rig = fake broker with fill history, unpinned, small journal except chain J)
Every start in every chain reached the live loop (2.5-4.4 s; chain J on 98.7 MB journal heap 493 pinned: 3.3-4.2 s, RSS 224-325 MB). 0 FATAL, 0 ERROR in loop, 0 heap errors in all segments of all chains. No duplicate orders: no order placed twice, no placement by a restart except the intended re-protection or lock replace below.
Scenario for the lock chains: data-a55 (11/02 NY short, entry 28573.75, TP1 28558.75, price then runs to entry-55 and back), lock ON, arm +50 / lock +10 (stop level 28563.75).

| Chain | Hard kills | Outcome |
|---|---|---|
| soakA (standard, natural data) | 4: open (resting LIMIT after entry), between entry fill and stop placement, open pre-TP1, runner open | all resumed (RESUMED ... LEG1_OPEN / LEG23_OPEN, kept 2 resting orders). Restart push "Bot restarted 2 times in 30 min" at start 3. Detail: the stop-gap kill restarted into a different trade later (journalId null, see notes). |
| soakJ (98.7 MB journal, heap 493, core 0, cgroup) | 3: open, stop, runner | 4 segments, all LIVE, ends flat. |
| soakB | 1: pre:runner_lock (step saved, row not yet appended) | restart placed the +10 stop ONCE (place, then cancel old), exit 28563.75 reason profit_lock, runner_exit lockStep 1. The runner_lock row is LOST (0 rows; record only, as designed). |
| soakC | 1: after the lock stop was placed, before the old stop's cancel arrived (2 stops resting) | restart: "cancelled order 9111 (1x) that the saved trade does not know" (that was the NEW lock stop), then re-placed the lock stop @28563.75 and cancelled the old +2 stop. One lock stop at the end, exit 28563.75, 1 runner_lock row, book empty. Never unprotected (old stop rested the whole time). Churn: one extra place/cancel. |
| soakD | 1: after the old stop was cancelled, before the state save (F3) | see F3 above. No order placed. |
| soakL2 (lock, 5 kills) | vat 17:35 (open pre-TP1), vat 17:45 (runner open, lock not armed), row:runner_lock (step reached + row written, before the replace), vat 17:55:30 and vat 17:58 (two restarts with the lock stop active) | 6 segments all LIVE. After the row kill the restart placed 28563.75 once and cancelled the old stop; the two later restarts "kept 2 resting order(s)" and placed nothing. Exactly 1 runner_lock row (step 1, bestPts 50.75), no duplicate (type, journalId, step), runner_exit reason profit_lock lockStep 1 at 28563.75 (18:01:17), final broker book empty, 0 orphan stops. |
Per chain: stop at the broker at the +10 level once; no orphan stop remained in any chain.
Notes (not r1.5 regressions, same code as r1.4; they go in the register):
1. A kill in the ~1.5 s between the TP1 fill and the runner stop / TP2 placement restarts into "RECOVERY: adopted pre-existing SHORT 1x ... TP1 already filled, a break-even stop rests, phase LEG3_OPEN". That trade is then a live-rule runner (trail), NOT an atrTarget runner: no TP2 limit, no lock (seen in chains L1 and J). r1.5 does not add a lock mid-trade (by design, test L8).
2. After the stop-gap kill (entry filled, stop not placed) the resumed trade has journalId null (pre-existing r1.4 behaviour). In soakA the lock moved the stop anyway (log line "no journalId for this trade - no runner_lock row written"): the move is not in the journal. Rare, record only.
3. A kill before the row append (soakB) loses the runner_lock row; loop_daily counts the trade by the exit row's lockStep (see below).
Not run: soak pinned to one core on the lock chains (G1 and chain J were pinned), 4+ kills on chain J (3 kills; chains A and L2 have 4 and 5).

## G3 trade witness (config-live-F.json: r1.5 accepted it, "applied 32 setting(s)", no rejected key; F config = profitTrail on etc., not the pine config)
- a55 (+55 then back to +5 and on): r1.4 and r1.5, 17:00-18:20Z. Same entries/stops/TP1 to the lock (events identical through 17:39:37). r1.5: arm poll 17:53:27 (best +51), places buy STOP 1@28563.75 then cancels the old @28571.75, fills 28563.75 at 18:01:17 = entry +10 (r1.4 exits 28571.75 = +2 at 18:06:16). Rows: runner_rule carries lock {mode on, steps [{50,10}]}, runner_lock step 1 (armPts 50, lockPts 10, bestPts 51, wouldStop 28563.75, from 28571.75), runner_exit reason profit_lock lockStep 1 lockMode on. Journal differs from r1.4 only by that and later signal_check rows (r1.5 was flat 5 min longer). No other trade placed.
- a45 (+45 then back through entry): trace identical, 20/20 broker events, no runner_lock row, runner_exit lockStep 0 reason runner_stop at 28571.75; journal 264 rows each, 261 identical, the 3 others differ only in runner_rule.lock, runner_exit lockStep/lockMode/reason. Lock did NOT arm.
- Lock mode off (config sessionRunnerNy.lock.mode off) on the a55 data vs r1.4: broker trace identical 20/20, 213/213 journal rows identical after mapping run uuids and stamp hashes, trade-state / day-state / cooldown-state files byte-identical, scorecard differs only in uuids. Startup line "profit lock: off (... r1.4 exactly)".
- Natural 11/02 17:00-18:15Z (3 NY shorts): the lock fires on the real prices: price reaches +65, arm poll 17:45:42 (best +65), stop moved to 28563.75, runner exit 28563.75 at 17:50:21 vs r1.4's 28571.75 at 17:50:27. All other orders same (3rd trade 1 tick different from the later poll phase), no FATAL, 0 ERROR in loop.
- Expected "orders identical unless the price reaches +50 after TP1": true in all three.

## G5 health alerts
healthAlerts.js and health-watchdog.js byte-identical to r1.4; tests/health-alerts-tests.js 28 passed 0 failed on Node 18.19.1; restart push fired in the soak.

## G6 proxy (r1.5 tmc-proxy.js, byte-identical to r1.4, node 18, heap 256, nice 19, 98.7 MB journal with a running rig bot appending: 98,717,920 -> 98,720,324 bytes)
24 requests (singles, 2 at once x3, 5 at once x3): all 200 and valid JSON, proxy survived, no stderr, peak RSS 162 MB (idle 43 MB). Times: single 142-287 ms, 2 at once 371-465 ms, 5 at once 0.93-1.02 s. Sizes 79.7 KB / 1.3 KB / 595 KB.

## G7 real-clock run (rtclock.cjs, one core each, cgroup 961 MB, heap 493, 11/02 14:10-14:23Z, 780 s, same data, both ran at the same time on cores 0 and 1)
| | r1.4 | r1.5 |
|---|---|---|
| polls | 28 | 28 |
| poll gap median / p90 / max | 27.09 / 28.63 / 30.73 s | 27.02 / 28.68 / 30.49 s |
| gaps over 30 s (over 40 s) | 1 (0) | 1 (0) |
| polls missed | none (no gap above 31 s) | none |
| eval per poll mean / median / max | 1647 / 1717 / 3486 ms | 1626 / 1699 / 3206 ms |
| warm-up evaluation | 3613 ms | 3337 ms |
| slowest single evaluateLevelsPro | 1252 ms | 1166 ms |
| longest event-loop block | 2900 ms | 3571 ms (one block, r1.4 runs earlier measured 3.9 s in the r1.4 gate) |
| health timer drift max | 1277 ms | 1441 ms |
| peak RSS | 302 MB | 297 MB (308 at exit) |
| ERROR in loop / FATAL / OOM | 0 / 0 / no | 0 / 0 / no |
| pushes | LIVE session started, Control: SELLERS | same |
No regression. The lock path costs nothing measurable when idle (no runner open in this window), so this does not test the lock's own CPU; that is one comparison per poll.

## loop_daily.py field names
`office/tools/loop_daily.py` run against the a55 / a45 r1.5 journals through load_journal / build_ledger / runner_lock_summary: runner_lock rows (step, armPts, lockPts, bestPts, wouldStop, mode, superseded) and runner_exit (kind, reason, lockStep, lockMode) are read correctly: rules.runnerLock armedStep 1 rowsSeen 1 steps [{step 1, armPts 50, lockPts 10, bestPts 51, wouldStop 28563.75}], rules.runnerExit reason profit_lock; a45: armedStep None, runnerExit reason runner_stop lockStep 0 (treated as not armed). runner_lock_summary ran without error. No field-name issue. (A trade whose runner_lock row was lost still counts by runnerExit.lockStep, as soakB shows.)

## What I could not run / limits
- G4 (not assigned). F2 on the rig (see above). A kill during the market-through-lock exit.
- Soak chains for the lock ran unpinned and with a small journal (speed); G1 and soak chain J cover the 98.7 MB / heap 493 / pinned case without the lock (chain J has the same NY shorts but no runner reached +50).
- The tool-level lock stop move was shown only for shorts (a55 and the natural window); a long runner was not run.
- Rig model: h2c with fill history, no fees or partials, constant-speed intrabar path; poll price is the bot's 20 s poll, so a spike between polls arms late (stated in EDGE-R15.md).
- Scenario price data was synthetic (m1 bars from 17:40Z rewritten, m5..h4 rebuilt from them, validated to reproduce the originals on untouched bars 395/395, 395/395, 155/155, 31/31).

## Files
Harness and runs: review/edge15-gate/ (driver.py with kill types open, stop, runner, at:, vat:, row:, pre:, cancel:pre|post; harness/h2c-kill/gk.cjs; mkscen.py + data-a55, data-a45; chain.py, cmp.py, fdiff.py; rtrun15.sh; runs/). Journals are deleted from all run folders (tails kept in the g1 runs); about 2.7 GB free on the disk.
