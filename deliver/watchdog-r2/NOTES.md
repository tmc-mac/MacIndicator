# watch1: schedule the outside watchdog on the server (desk MacWatch, 2026-11-12, revision 2 after review)

Nothing here is installed, committed or posted. No bot code changes. No bot restart.
Revision 2 answers `watch1-review/WATCH-REVIEW.md` (verdict SEND WITH RULES): the reviewer patch is applied and findings F1, F2, F3, F4, F5, F6, F7, F9, F11 are closed in the package. The reviewer has not re-checked this revision.

## Files
sha256 of each file: see the table at the end of this file (written after the last test run).

- `install-watchdog.sh`: the installer (install / undo / proof).
- `INSTALL-watchdog-DRAFT.txt`: Mac's sheet. Uses `<server>`; the Get-FileHash prefix in step 1 is this installer's.
- `test/run-tests.sh`, `test/fake/{systemctl,journalctl,node,hook.js}`: the harness. `test/RESULTS-node18.txt`, `test/RESULTS-node22.txt`: the runs.
- The watchdog itself is NOT shipped: the installer requires the server's `health-watchdog.js` to be the edge16 clone's file (sha256 31ca61ba...8e14, 7030 bytes, the size the inventory saw).

## What the installer does
1. Checks, and prints STOP with no change on the first failure: root; systemctl; unit folder; `mac-bot-live.service` loaded; `NeedDaemonReload` reads exactly `no` for the bot unit and the phone-server unit (printed as `no/no`); no unit of the watchdog's names that this installer did not write; node at /usr/bin/node runs; watchdog file present with the edge16 sha256; env file present with a non-empty `NTFY_TOPIC=` (`""` and `''` count as empty; value never printed); the bot unit's EnvironmentFiles include that env file; `User=` readable from the bot unit (never printed); heartbeat file present and under 300 s old.
2. Writes `mac-bot-watchdog.service` (Type=oneshot, the bot unit's User, WorkingDirectory and EnvironmentFile, `ExecStart=/usr/bin/node /opt/mac-bot/health-watchdog.js --dir /opt/mac-bot --symbol MNQ`, Nice=19, TimeoutStartSec=60) and `mac-bot-watchdog.timer` (four OnCalendar lines, below; AccuracySec=5s; WantedBy=timers.target). Files are rewritten only when their text differs.
3. `daemon-reload`, `enable --now` the timer (and `restart` of the watchdog's own timer only when it was already running and its file changed), starts the oneshot service once, prints the watchdog's line from the journal, checks the watchdog saved its state file, prints the undo command and DONE.
4. A failure after step 2 began: on a first install it removes both files again (PROBLEM, UNDO). On a re-run over a working install it puts the two files back exactly as they were and leaves the timer as it was (PROBLEM, KEPT).
- `undo`: `disable --now` the timer, remove both files, `daemon-reload`. Leaves `health-watchdog-state-MNQ.json` (harmless).
- `proof`: runs the same watchdog file once on a temp folder holding a pretend 11-min-old heartbeat under the symbol `PROOF`, with the topic read from the env file (trailing spaces / carriage return stripped, as systemd does). One real push titled "MacMillionz PROOF: Bot NOT RUNNING (no heartbeat)". No systemctl call, nothing written in the bot folder. Outside trading hours it prints PROOF NOT RUN. The sheet makes it a required step right after the install.
- systemctl verbs used on the bot and phone-server units: `show -p ...` only.

## The timer schedule (fix for review finding F1, timer only, no bot code change)
```
OnCalendar=Mon..Sat *-*-* *:*:30 America/Los_Angeles
OnCalendar=Sun *-*-* 00..14:*:30 America/Los_Angeles
OnCalendar=Sun *-*-* 15:02..59:30 America/Los_Angeles
OnCalendar=Sun *-*-* 16..23:*:30 America/Los_Angeles
```
Every minute at second 30, except Sunday 15:00:30 and 15:01:30 Pacific. The weekend timer starts the bot at Sunday 15:00 PT with systemd's default accuracy (up to 1 min late), and trading hours open that same minute, so a run before the bot's first heartbeat would push a false "NOT RUNNING". First Sunday run after the open is 15:02:30: at least 90 s after the latest scheduled start. The zone is explicit, so it follows summer time; the server's own weekend timers already use `America/Los_Angeles` in OnCalendar, so its systemd accepts the form.
Cost: a bot that truly fails to start on Sunday is reported at 15:02:30 instead of 15:00:30.

## Tested here (Node 18.19.1, the server's version; repeated on Node 22.22.0): 336 checks, 0 failed, both runs
Fake prefix (bot folder, env file, unit folder under a temp dir), fake systemctl/journalctl that log every call and fail the test on any state-changing verb aimed at the bot or proxy units. The watchdog is the real edge16 file with real file I/O; `https.request` is captured by a preload, so nothing left this machine.
- A fresh install: 31 (adds the `no/no` line, both NeedDaemonReload reads, no timer restart).
- B second run: 14 (byte-identical and not rewritten; hand-edited service restored; changed timer restored and the watchdog timer restarted once, nothing else).
- C STOP cases: 153 checks over 24 STOP cases plus one pass case. New: bot unit edited and not reloaded, phone-server unit the same, reload state unreadable, `NTFY_TOPIC=""`, `NTFY_TOPIC=''`, hand-made service unit of the same name, hand-made timer of the same name (file untouched); a quoted non-empty topic still installs.
- D bot unit without User=: 3. E undo: 12.
- F failures after writing: 54. First install undoes itself (service run fails, timer not enabled, state file not savable, no journal line, unit file not writable with the right message). Re-run over a working install keeps it byte-identical with the timer active (service run fails, no journal line, hand-edited timer then a failure).
- G watchdog behaviour: 45. As before (fresh = ok, no push; 11 min in hours = one urgent push to the env topic; reminder at +30; "back" once; outside hours quiet; no topic; HTTP 429), plus the Sunday open. Schedule, read from the installed timer file with `systemd-analyze calendar`: fires Sunday 14:59:30, does not fire 15:00:30 or 15:01:30, fires 15:02:30, 15:03:30, 16:00:30; Monday 15:00:30 and 15:01:30 fire; Saturday and Sunday 00:00:30 fire; the same skip in summer time; a whole Sunday has 1438 runs. Behaviour at those instants: 14:59:30 with the bot off = quiet; a run at 15:00:30 or 15:01:30 would have pushed (why they are skipped); 15:02:30 with a start at 15:00:02 or 15:00:59 = ok; 15:02:30 with no start = push.
- H proof mode: 16 (adds carriage-return and trailing-space env lines, empty quoted topic = STOP).
- I the two unit files through `systemd-analyze verify` (systemd 255, rc 0 both) and all four calendar lines parse: 3. J safety greps, reworded as the review asked (proxy and bot units only with `show`; `restart` only for the watchdog's own timer): 5.
- The clone's own `tests/health-alerts-tests.js`: 28 passed on Node 18.19.1. The clone is unchanged.

## Not tested here
- Real systemd: `daemon-reload`, `enable --now`, the timer actually firing on this schedule, the service running under the real User, journald returning the line (`journalctl -u ... --since @<epoch> -o cat`), `systemctl show --value` and `NeedDaemonReload` on the server's systemd version. First real run is Mac's.
- The not-root STOP in my harness (it runs as root); the reviewer's cases covered it on revision 1.
- The reviewer's 14 adversarial cases were not re-run against revision 2; the ones the patch targets are now cases in this harness.
- A real push to ntfy.sh, and the server's real env-file syntax. The sheet's required `proof` step covers the push on the server.
- The server's `health-watchdog.js` sha256: the inventory gave only the size (7030 bytes, equal to the clone's). If it differs the installer STOPs.
- The Sunday 15:00 open on the real box, and the weekend-start timer's real accuracy (not in the inventory; the fix assumes it is no worse than the 1 min default).

## Risks
- **Sunday open:** closed for a start up to about 15:02 PT. If the weekend start is later than that (a server reboot, a longer AccuracySec), Mac gets one "NOT RUNNING" and then "heartbeat is back".
- **Deliberate stops:** any stop of the bot for 10+ min in trading hours now pushes. The sheet says so. Normal installs restart in seconds.
- **Holidays / early closes:** the watchdog uses the plain weekly calendar. A bot stopped on a CME holiday inside those hours pushes every 30 min. The Friday 14:00 PT stop is outside hours: quiet.
- **Hung but still writing:** the heartbeat is written by a timer in the bot, so a bot stuck in an await still beats; that is the in-bot not-LIVE alert's job. The sheet now says "dead or completely hung" and names the difference.
- **Weekend install:** the freshness check makes the installer STOP between Friday 14:00 and Sunday 15:00 PT; `proof` is silent outside trading hours. The sheet says to do it in trading hours.
- **ntfy quota:** worst case 48 watchdog pushes a day, plus 1 per `proof` run, on the same 250/day limit as the bot.
- **daemon-reload:** now guarded. The installer STOPs unless both units read `NeedDaemonReload=no`. Edits to other units on the server are not checked.
- **State file and install-edge.sh (review F8):** the watchdog rewrites `health-watchdog-state-MNQ.json` in the bot folder every minute. If a bot stop inside an edge install ever lasts 10+ min, that file's content changes and the edge installer's whole-folder comparison could roll back a good install. Not fixed here (it is in the edge installer).
- **WD_* variables:** test-only path overrides. If one were set in root's shell on the server the installer prints "TEST MODE" first; the sheet's expected output has no such line.
- **Journal volume:** about 4 lines a minute (the watchdog's line plus systemd's own for a oneshot), roughly 5,800 a day.
- The sheet is a draft with `<server>`; the Get-FileHash prefix must be re-taken if the installer is edited.

## sha256
```
4bacaa5f409167b2bb161192f7be8fe4abe1c6fffa898070d31acfa7859b0f7a  install-watchdog.sh
31faae3ab27f7f4686d45864fa9b215d737d98ce09c93916083f24a981c7131b  INSTALL-watchdog-DRAFT.txt
8e525ea1cfca03fccb9fb113cf792e6a0706c98438d2e957f282c6bcd51be275  test/run-tests.sh
a380ecd70db8d754cc93d31de149495da7b52ab197e041a46debbbb03e002936  test/fake/systemctl
5af036b87f8ade7480e1bea41b809d7cd90c8963a84d334f3ccf527d9ce22714  test/fake/journalctl
2a068ccbf310878f737ff4fce150eaaa053275d0b6d871a95b1d671896f899f1  test/fake/node
0d984e385d89b61254c26f4a5049872338379a46dec55a33e3a8277145d98c48  test/fake/hook.js
31ca61ba59b95c45007f437054747848276fc4ca647777f81a2c6ecf17c68e14  health-watchdog.js (edge16 clone, not shipped; the installer's reference)
```
