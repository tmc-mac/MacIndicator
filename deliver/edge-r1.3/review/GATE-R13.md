# Edge r1.3 ship gate (executor 4168e4bb, proxy ae9f434f, zip 0da09a2a) - ship-gate desk, 11/11

| Item | Result |
|---|---|
| G1 Mac-box boot, 493 MB heap limit | **PASS** at 98.7 MB and at 150 MB journal |
| G2 SIGKILL restart soak, 98.7 MB journal, 493 limit | **PASS on starts, memory, position and orders. One criterion NOT met: an armed 3m setup did not survive a restart.** The same loss shows on r1.1, so r1.3 did not cause it |
| G3 trade witness against r1.1 | **PASS** - identical |
| G4 install path | not mine, not run |
| G5 health alerts | **PASS** - 28 of 28, and the restart push fired in the soak |

## G1 Mac-box boot
One core (taskset), Node 18.19.1, `--max-old-space-size=493`, 961 MB memory cgroup (cgroup v1 group created for this run; this machine has no swap, so the cap was harder than the server's), pine config, real 2000-bar warm-up, 10 virtual minutes.

| Journal | Live loop | OOM | Real s to live loop | Peak heapUsed | Peak RSS | Cgroup peak / failures |
|---|---|---|---|---|---|---|
| 98.7 MB | yes, ran to the end, exit 0 | none | 3.6 | 86 MB | 316 MB | 278 MB / 0 |
| 150 MB | yes, ran to the end, exit 0 | none | 3.4 | 88 MB | 323 MB | 285 MB / 0 |

- Before the fix, at 98.7 MB and the same limit, r1.1 and r1.2 died with 601 MB heapUsed and 860+ MB RSS.
- The observer saw no whole-journal `readFileSync` in r1.3. Start-up memory no longer grows with the journal: 86 against 88 MB.
- Warm-up: 2000 15m bars, "after 1 s" on the bot's clock. Seconds to live loop are CPU only (the rig answers broker calls on a virtual clock); add real call latency on the server.

## G2 SIGKILL soak
r1.3 with the 98.7 MB journal in place and carried through every restart, 493 limit, pine config, 11/02 14:29-15:02Z. Four SIGKILLs, five starts, each restart 5 virtual seconds after the kill. Not pinned to one core (for the deadline). Rig = h2c with one change: the fake broker saves its position and orders after every event so a kill does not lose them.

| Start | At (Z) | Real s to live loop | Peak heapUsed / RSS (MB) | Killed when | What the next start did |
|---|---|---|---|---|---|
| 1 | 14:29:00 | 2.92 | 60 / 312 | 14:30:25, flat, trigger armed (5m and 3m SHORT bias) | started FLAT; 5m bias back at once, 3m gone |
| 2 | 14:30:30 | 3.07 | 88 / 335 | 14:45:00, SHORT 3 open before TP1, stop 3 @ 28764 and TP1 2 @ 28699 resting | "RESUMED ... LEG1_OPEN; kept 2 resting order(s)"; re-linked to its journal trade |
| 3 | 14:45:05 | 3.31 | 47 / 225 | 14:50:44, after TP1: SHORT 1 open, stop 1 @ 28712 and TP2 1 @ 28599.75 resting | "RESUMED ... LEG23_OPEN (TP1 already banked); kept 2 resting order(s)" |
| 4 | 14:50:49 | 3.49 | 75 / 301 | 14:54:49, flat, 3m SHORT plan armed, in the post-win cooldown | started FLAT; cooldown restored; trigger "none" |
| 5 | 14:54:54 | 3.07 | 87 / 317 | not killed, ran to 15:02, exit 0 | |

- **Orders on the fake broker, whole soak:** one entry (sell 3 @ 28712.50, filled 28714.00 at 14:44:58), one stop (28764), one TP1 (2 @ 28699, filled 14:50:41), one runner stop (1 @ 28712, filled 14:51:33), one TP2 (28599.75, cancelled 14:51:35). No order was placed twice; no order was placed by a restart. The trade ran its full plan across three processes.
- 0 FATAL, 0 heap errors, 0 "ERROR in loop", 0 "fetch failed", 0 unexpected network calls in all five segments.
- **Not met - armed setup:** the unkilled witness took a second short at 14:57:07 on a 3m plan. In the soak the bot was killed at 14:54:49 with that 3m plan armed; after the restart the trigger read "none", the 3m plan never came back, and no second trade was taken. So the planned fifth kill (position open on trade 2) never happened.
- **Same on r1.1:** I ran the same kills on r1.1 (small journal, because r1.1 cannot start with the large one at 493). After its first restart the 3m trigger was also gone ("M3:-") while 5m came back, line for line like r1.3. r1.1's trades then took a different path (entry 14:46:36, early exit, second entry 14:55:11), so the two soaks are not comparable trade for trade. One run each; whether the lost 3m plan is restart state or poll timing is not settled.

## G3 trade witness
11/02 14:10-15:25Z, pine config, 493 limit, small journal. r1.1 baseline = my r1.2-gate run of r1.1 on the same rig, config and window.
- Two NY shorts on the ATR runner rule, as r1.1: entry 28712.50 at 14:45:15 (stop 28762.50, TP1 2 @ 28697.50 filled 14:50:42, runner stop 28710.50 filled 14:51:31, TP2 28598.25 cancelled); entry filled 28689.75 at 14:57:09 (stop 28743.75 moved to 28739.75, TP1 2 @ 28674.75 filled 14:57:36, runner stop 28687.75 filled 14:58:02, TP2 28575.50 cancelled).
- Broker trace identical to r1.1 in all 38 events; journal 298 rows, same count per type. No difference.
- 0 "fetch failed", 0 "ERROR in loop", 0 FATAL. Peak heapUsed 80 MB, RSS 327 MB. The rig bypasses `tmc-proxy.js`, so this does not show the "fetch failed" fix.

## G5 health alerts
`tests/health-alerts-tests.js` from the builder's r1.3 folder, run against the packaged tree on Node 18.19.1: 28 passed, 0 failed. `lib/healthAlerts.js` is byte-identical to r1.1's.
- Not LIVE 10+ min: "not-live: warm-up 45 min in hours -> push at 10 min, re-push at 40 min, recovered once", plus 9 more not-live tests (stall, stale data, hours).
- Restarts: "restarts: 3 starts in 30 min -> one push; a 4th -> none; a new window -> again", "starts 31 min apart never alert".
- Warm-up: "1199 or 600 bars -> cut short once", "an error -> FAILED", "the loop starting without one -> SKIPPED once", "the previous process ended mid warm-up -> STOPPED on the next start".
- In the soak the push "Bot restarted 2 times in 30 min" (high priority) went out at start 3, and "Position resumed after restart" at starts 3 and 4.

## Extra: the proxy on the 98.7 MB journal
`tmc-proxy.js` from the same tree, Node 18.19.1 with no flags, on this 16 GB machine (so not under the server's heap limit).

| Request | Time | Proxy peak RSS after |
|---|---|---|
| idle | - | 44 MB |
| `/trade-list` (first) | 0.60 s | 383 MB |
| `/signal-journal` | 0.38 s | 383 MB |
| both again | 0.57 s / 0.42 s | 392 MB |

Each request takes the proxy from 44 MB to about 390 MB. On the 961 MB server that sits beside the bot (about 320 MB) and grows with the journal.

## Not run
- G4 (yours). The fifth kill. Kills between an entry fill and its stop placement. A soak pinned to one core. The 150 MB journal in the soak.
- The proxy was not measured under a 493 MB limit or the cgroup.
