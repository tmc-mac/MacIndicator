# Edge r1.2 ship gate (executor d0413a7c) - INCOMPLETE: stopped for the heap-limit crash on the server

| Item | Result |
|---|---|
| F2 trade witness | **PASS** on the rig (one session, r1.2 and r1.1 run the same way) |
| F3 restart soak (SIGKILL) | **NOT RUN** - started, stopped in its first segment before any kill |
| Ship | **Not cleared by this desk.** r1.2 crash-looped on the server; see `review/edge12-oom/OOM-R12.md` (journal size, both builds) |

## F2 evidence
Rig `harness/h2c-n18` (copy of qa-exit5 h2c-n18, unchanged), real bars 11/02 14:10-15:25Z, `config-live-pine.json` (= qa-sizecap config-live + `levelsParity: "pine"`), Node 18.19.1, nice 19. Startup lines confirm: early adverse exit ON, Asia / London all out at TP1, NY ATR runner, tp1 ATR shadow LOG, Pine parity.

Both trades are NY session, rule `atrTarget` (ATR15 57.07). Times are the fake broker's.

| Trade | Order | Time (Z) | Price | Outcome |
|---|---|---|---|---|
| 1 SHORT 3x | entry sell limit 3 @ 28712.50 | 14:45:06 | filled 28712.50 at 14:45:15 | |
| | stop buy 3 @ 28762.50 | 14:45:18 | | cancelled 14:50:47 after its replacement was placed |
| | TP1 buy limit 2 @ 28697.50 | 14:45:18 | filled 14:50:42 | |
| | runner stop buy 1 @ 28710.50 (entry -2) | 14:50:47 | filled 14:51:31 | flat |
| | TP2 buy limit 1 @ 28598.25 | 14:50:48 | | cancelled 14:51:35 |
| 2 SHORT 3x | entry sell limit 3 @ 28685.75 | 14:57:09 | filled 28689.75 | |
| | stop buy 3 @ 28743.75 | 14:57:10 | | replaced by 3 @ 28739.75 at 14:57:17 (50-pt cap from the fill) |
| | TP1 buy limit 2 @ 28674.75 | 14:57:11 | filled 14:57:36 | |
| | runner stop buy 1 @ 28687.75 (entry -2) | 14:57:40 | filled 14:58:02 | flat |
| | TP2 buy limit 1 @ 28575.50 | 14:57:40 | | cancelled 14:58:07 |

- r1.2 against r1.1: the broker trace is identical event for event (38 events: orders, fills, cancels, pushes) and the trade journal has the same 298 rows by type. No difference found.
- Against the earlier r1.1 witness (no pine): different trades. That run took a London short at 14:22 and an NY short at 14:46 closed by the early exit; with pine neither build takes the London trade. This is the setting, not the build.
- Not witnessed: the early adverse exit firing (it did not trigger), a TP2 fill, an Asia / London all-at-TP1 trade.

## Numbers (witness runs, no memory limit, 16 GB machine)
| | r1.2 | r1.1 |
|---|---|---|
| Warm-up | 2000 15m bars, "after 1 s" (bot clock) | same |
| Real s to "Entering live loop" | 3.45 | 3.41 |
| Peak RSS (MB) | 404.6 | 424.9 |
| "fetch failed" lines | 0 | 0 |
| "ERROR in loop" lines | 0 | 0 |
| FATAL | 0 | 0 |

- The rig replaces `fetch` and never goes through `tmc-proxy.js`, so **this run cannot show the "fetch failed" fix**: r1.1 also shows 0.
- These runs used a 345 KB journal. They say nothing about start-up memory on the server (98.7 MB journal): see the OOM file.

## F3: what exists
- `driver.py` (runs the rig in segments, SIGKILLs the bot on a condition, restarts from the killed run's files) and `harness/h2c-kill` (the rig with one change: the fake broker saves its position and orders after every event, so a SIGKILL does not lose them). Neither has completed a run; the soak was planned as 5 kills (armed, position open, runner phase, armed, position open).
- Another desk's folder `review/edge12/rig` holds restarts by clean stop (SIGINT), not SIGKILL. I did not review it.
