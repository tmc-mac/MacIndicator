# Edge r1.4 ship gate - ship-gate desk, 11/11

Tested tree: branch edge14 at 79b3c3b (executor 871d53ca, proxy a959fbc0, lib/scorecard.js 8e5d1cc2). The first gate pass was on aa2e057; the soak, G1 (all three boots), G3 and G6 below are on 79b3c3b. Reference: r1.3 tree from the previous gate.

| Item | Result |
|---|---|
| G1 Mac-box boot (core 0, 961 MB cgroup, heap 493) | PASS, 98.7 MB and 150 MB |
| G2 SIGKILL soak | PASS on 79b3c3b (6 hard-kill types). The duplicate-row FAIL found on aa2e057 is fixed |
| G3 trade witness vs r1.3 | PASS: broker trace identical (36/36 events), journal identical except new rows/keys |
| G5 health alerts | PASS: 28/28, healthAlerts.js and health-watchdog.js byte-identical to r1.3, restart push fired in the soak |
| G6 proxy, heap 256, 98.7 MB journal, bot appending | PASS: survived, 24/24 responses 200 + valid JSON, peak RSS 165 MB |
| G7 evaluation time | MEASURED, see caveat: cannot show timer misbehaviour on this rig |

## G1 Mac-box boot
taskset core 0 (separate core 1 for the r1.3 comparison run), memory cgroup 961 MB (no swap on this machine, so harder than the server), Node 18.19.1, --max-old-space-size=493, pine config, real 2000-bar warm-up, 10 virtual minutes 11/02 14:10-14:20Z, exit 0, no OOM, 0 ERROR in loop / FATAL.

| Run | Live loop (s) | Peak heapUsed | Peak RSS | Cgroup peak |
|---|---|---|---|---|
| r1.3, 98.7 MB | 3.5 | 87 MB | 351 MB | 313 MB |
| r1.4 aa2e057, 98.7 MB | 4.8 | 79 MB | 318 MB | 281 MB |
| r1.4 79b3c3b, 98.7 MB | 4.4 | 82 MB | 335 MB | 301 MB max over both r1.4 runs, failcnt 0 |
| r1.4 aa2e057, 150 MB | 4.6 | 89 MB | 334 MB | - |
| r1.4 79b3c3b, 150 MB | 4.5 | 97 MB | 337 MB | - |

Seconds to live loop are CPU only (virtual clock), +1 s vs r1.3 (second evaluation on the cold warm-up). The box was shared (load 3-7 from other desks), so seconds and RSS are +/- 10-30 MB noisy. Peak RSS of r1.3 in this same run (351) is above the previous gate's 316, which shows that noise. Cgroup failcnt 0.

## G2 SIGKILL soak (98.7 MB journal, heap 493, 11/02 14:29-15:02Z, unpinned)
Real SIGKILLs. Two chains on 79b3c3b (soak14c, soak14d) plus two earlier chains on aa2e057 (soak14, soak14b) and an r1.3 baseline for the fill-to-stop kill. Every start reached the live loop (2.9-4.4 s, RSS 220-353 MB), 0 FATAL, 0 heap errors, 0 ERROR in loop in all segments.

Kills done (79b3c3b): 
1. Flat, setup armed (5m/3m bias): restart FLAT, 5m bias back.
2. Between entry fill and protective stop placement (in-process hook: the process SIGKILLs itself when the stop place request arrives; entry filled, broker holds SHORT 3, book empty). The next start (5 virtual s later) placed STOP 3@28764 and TP1 2@28699, the original order ids, no second entry order, no duplicate. Position unprotected for about 9.5 virtual seconds including downtime. Chain soak14c.
3. Position open before TP1 with stop 3 and TP1 2 resting (soak14d): "RESUMED ... LEG1_OPEN; kept 2 resting order(s)", TP1 then filled normally, runner stop 1@28712 and TP2 1@28599.75 placed once each.
4. Position open after TP1 with runner stop and TP2 resting (both chains): "RESUMED ... LEG23_OPEN (TP1 already banked); kept 2 resting order(s)", runner stop filled, TP2 cancelled, once.
5. Flat in cooldown after a win (soak14b on aa2e057): restarted FLAT, cooldown restored.
6. Watch-row kills: (a) SIGKILL right after the runner_shadow row was appended (soak14c): the restart wrote NO second row, exactly 1 runner_shadow row for that trade (resolved, runner_stop, 13.33 pts). (b) SIGKILL right BEFORE the runner_shadow row was appended, after the key was persisted (soak14d): the restart wrote zero rows for that trade, no invented result, no duplicate; one record-only row is lost, as designed.
- Fill-to-stop kill, journal and shadow: the restart wrote a second `entry` row with journalId null (r1.3 does the same, run with the same kill; pre-existing, goes in the register). On 79b3c3b that trade's shadow is not written (scorecard shows `unresolved: no journalId`), no row carries a null journalId, and the next trade (journalId set) shadowed and resolved normally across two further restarts (soak14c: one `runner_shadow`, resolved, runner_stop).
- Orders on the fake broker: no order placed twice, no order placed by a restart other than the re-protection in kill 2.
- Pushes: "Bot restarted 2 times in 30 min" (high) fired at start 3 in every chain, "Position resumed after restart" at the resumed starts.
- Faults found on aa2e057 (now fixed in 79b3c3b, kept here for the record): the row kill (a) wrote the same runner_shadow row twice (same journalId, identical content, 13.5 s apart); and a trade whose journalId was null produced a `runner_shadow` row with journalId null.
- Still true on 79b3c3b: the scorecard state file is saved only about every few minutes while nothing changes (saved lastSeenAt was 14:46:59 at a kill at 14:50:44, a 3 min 45 s stale). In the aa2e057 soaks a restart in such a window ended the watch `unresolved: no price for 239 s` although the real downtime was 5 s. On 79b3c3b the trades in my chains resolved normally, but a kill more than 3 minutes after the last state save will still end that trade's shadow and TP1-touch watch unresolved. Never invented, but expect unresolved counts after restarts.
- Same as r1.3 and not caused by r1.4: an armed 3m plan is gone after a restart (trigger "none"). Log line "Startup reconciliation: no existing open position found - starting FLAT" is printed after a resumed pending entry although the trade is managed (misleading text only).

## G3 trade witness (11/02 14:10-15:25Z, pine config, small journal, unpinned)
r1.3 vs r1.4 79b3c3b, same rig and seed.
- Broker trace (requests, fills, pushes): 36 events each, identical. Same two NY shorts, same entries/stops/TP1/runner stops/cancels. 0 FATAL, 0 ERROR in loop, 0 fetch failed.
- Journal: 298 rows (r1.3) vs 300 (r1.4). Differences are exactly: 2 new `runner_shadow` rows (both resolved, runner_stop), the control keys on rows (`controlScoreAlt` on signal_check 166, trade_block 8, control_flip 5, trade_plan 2, control_exclusion 2; 24 rows `controlDisagree: true`; 68 rows with alt null / "not-near-line"), and per-run values (uuids, stampId, runId, and the file hashes in session_stamp). Every other field of every other row is identical, same order.
- No `tp1_touch` or `ny_late_trade` row: the rig serves no fill history, so they never write here (builder said the same). They were not exercised by this gate.
- Orders differ: none.

## G5 health alerts
`tests/health-alerts-tests.js` run in the packaged 79b3c3b tree on Node 18.19.1: 28 passed, 0 failed. lib/healthAlerts.js and health-watchdog.js are byte-identical to r1.3. Restart push fired in the soak (above).

## G6 proxy (79b3c3b tmc-proxy.js, Node 18.19.1, --max-old-space-size=256, nice 19)
Journal 98.7 MB, appended to by a running rig bot (grew 98,721,793 -> 98,726,265 bytes during the requests). Requests: /trade-list?limit=200, /trade-stats, /signal-journal?limit=100&filter=traded: singly, 2 at once (3 rounds), 5 at once (3 rounds), 24 requests.
- Proxy survived, no stderr. All 24 answered 200 with valid JSON. Sizes 79.7 KB / 1.3 KB / 595 KB.
- Peak RSS 165 MB (idle 43 MB). Times: single 165-421 ms, 2 at once 440-600 ms, 5 at once 1.1-1.6 s.
- Not run: 150 MB journal, the downloads, /trade-why, /trade-blocks (builder covered them).

## G7 evaluation time (real CPU on this machine, Node 18.19.1; evaluations are timed around every `evaluateLevelsPro` call; an "evaluation" = the 15m + 5m + 3m calls of one poll)
| | r1.3 | r1.4 |
|---|---|---|
| warm-up evaluation (2000 bars), unpinned 75-min runs | 2.2 s | 3.5-3.9 s |
| per 15m close (9 closes), mean / max | 1.41 / 2.05 s | 1.74-1.77 / 2.63-2.72 s |
| per 20 s intrabar poll (153), mean / median / max | 1.00 / 0.94 / 2.08 s | 1.18-1.22 / 1.27-1.30 / 2.22-2.34 s |
| pinned core 0, 10-min runs, per poll mean | 1.16 s | 1.35 s |
| slowest single evaluateLevelsPro call | 1.03 s | 1.02 s |
| longest event-loop block (real timer, 10 ms resolution) | 1.83 s (2.14 pinned) | 1.54-1.85 s (1.84-1.92 pinned) |
Bot's own counter at 15:25 (r1.4): second evaluation 100 runs, 67 skipped, avg 408 ms per run, whole evaluation avg 1325 ms, max 3754 ms, adds 244 ms per evaluation (+22.6%).
- The slowest loop turn did not grow: no single synchronous block is longer than r1.3's (about 1.8-1.9 s on this machine; the server may be slower).
- Caveat, important: this rig runs a VIRTUAL clock, so CPU time costs no virtual time. The 20 s cadence (median 23.6 s, p90 25.5 s, max 29.7 s), the heartbeat, health timers and pushes are therefore identical to r1.3 by construction and prove nothing about the real clock. What the run does show: 0 stale-data/stall/not-LIVE alerts, 0 ERROR in loop, identical push list, heartbeat live. A real-time-clock run (the OOM desk has `rtclock.cjs`) was NOT done; the risk to check on the server is that a 1.2-1.4 s evaluation every poll, 2.6-3.8 s at 15m close and warm-up, delays the poll by that much on a slower core.

## Not run / limits
- Install path / rollback (G4, not assigned).
- Real-time-clock evaluation run; a soak pinned to one core (soak was unpinned for speed, G1 was pinned); `tp1_touch` and `ny_late_trade` rows (rig has no fills); a kill between the 15m evaluation and its journal rows.
- Disk was at 1.0-1.2 GB free for part of the run (other desks); the 150 MB journal was hard-linked, not copied, to stay above the floor. Journals are deleted from all run folders; tails are kept as `new-rows.jsonl`.
- Rig = h2c with the fake broker saving its state after every event; broker model has no fees/partials and no fill history.
- Files: runs in `runs/`, driver `driver.py`, kill hooks `harness/h2c-kill/gk.cjs`, observer `obs14.cjs`, proxy script `g6.cjs`.
