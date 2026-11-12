# TEST-local: what was actually run (local r2), 2026-11-12

**Result on r2 (the patched scripts): 120 of 120 checks passed** in `test/run-tests.sh` (log `test/run-r2.log`, per-step outputs `test/out/`): the 114 checks of r1 plus 6 for the reviewer's findings. The r1 log is `test/run-final.log` (114 of 114). The time-zone runs (`test/tz-test.log`) are from r1 and were not repeated; the patch does not touch the bot. These are the builder's runs. **Nothing ran on Windows, on WSL, on real systemd or on the server, by the builder or by the reviewer.**

The reviewer desk ran its own sandbox and the ship gate on the restored folder (`local1-review/GATE-LOCAL.md`, verdict SEND WITH RULES): Mac-box boot under 1 core and a 961 MB cgroup with a 150 MB journal (live loop 4.4 s, peak RSS 315 MB), restart soak with 3 kills, trade witness on the 11/02 replay (the same 5 fills as the edge r1.6 gate), `install-edge.sh` plus rollback over the restored folder. Those are the reviewer's results, not mine.

Added for r2 (reviewer cases): F1 stop timer gets `Persistent=false` on the PC only, start timer untouched; F3 clock push at most once per 30 minutes; F4 added watchdog at second 30 with the bot unit's `User=`; F5 a bundle with no heap setting restores to DONE with a NOTE; F6 the guard refuses `{}`; F7 a crash-looping server unit reads RUNNING. **Not exercised: F8** (`resume` marking the weekend timers as just run): the line is skipped in the sandbox because it writes systemd's own stamp files; it has never run on real systemd.

## Where it ran
This container: Ubuntu 24.04.5, kernel without systemd as PID 1, 4 cores, 16 GB. All commands at `nice 19`, one heavy process at a time.

- Real: both scripts end to end; Node v18.19.1 installed from the official tarball (sha256 pinned); tar and sha256 of a full bot folder with the 98,699,731-byte journal; the edge r1.6 tree (executor 26089560) booted from the restored folder on the gate harness (fake broker, virtual clock, 11/02 data, real 2000-bar warm-up); the real `tmc-proxy.js` serving the 2.2.2 page (99ec1630); real `curl` against it; `systemd-analyze verify` on the unit files.
- Stubbed: `systemctl`, `journalctl`, `pgrep`, `crontab`, `sleep` (state kept in files; the start hook for `mac-bot-live` runs the pre-start guard and then the real bot). The two roots (`/opt`, `/etc`, `/usr/local`) are sandbox folders selected by a test-only switch in the scripts.
- Fixtures: unit files rebuilt from the server inventory (live with `User=root`, proxy, `heap.conf` 1024 on both, `account.conf`, disabled MGC unit, weekend services and timers in the inventory's shape: `Fri 14:00` / `Sun 15:00 America/Los_Angeles`, `Persistent=true`). The real files are not in hand.

## Counts by group

| Group | Checks | What they cover |
|---|---|---|
| A. Server side | 21 | status RUNNING/OFF; pack refuses while running; stop refuses on "no" and when not flat; stop disables all 7 units, timers before the bot, bot before the phone server; state remembered; second stop is a no-op; bundle, `.sha256`, mode 600, manifest = every file, units + drop-ins + env file inside; no secret value in any output |
| B. Install | 10 | STOP lines before install; refuses outside WSL; Node exactly v18.19.1; a truncated Node download is refused; `wsl.conf` keys added with earlier lines kept and a backup; second install changes nothing (file hashes and inode equal); `check base` 8 PASS |
| C. Restore refusals | 9 | no `.sha256`; one flipped byte; no `config-local.json`; no journal; a bot file that differs from the server's list; an extra file; a path outside `meta/` and `botdir/`; systemd not running. After each one nothing is in `/opt/mac-bot`, `/etc` or the staging folder |
| D. Restore | 19 | wrong build against `EXPECT.sha256` refused; real-size bundle restored in 2 s; all files and the journal byte-identical; modes kept; env file 600; units and drop-ins byte-identical; 5 stale files removed and listed; guard, watchdog and clock timer added; only the clock timer enabled; second restore = ALREADY RESTORED; a different bundle refused; `check bot` all PASS; another time zone = STOP; `systemd-analyze verify` |
| E. Start refusals, proofs, guard, tick | 28 | no proof; proof from a RUNNING server; server stopped but still enabled; a weekend timer still enabled; 15-minute-old output; missing unit line; 11-minute-old proof; answer "no"; config missing / broken; journal missing; broker key line missing; server port answering (start and guard); clock unverifiable; clock 90 s off (guard, tick); alarm set / refused / ping sent / ping withheld; failed boot rolls everything back |
| F. Real start | 24 | DONE; the 8 PASS lines of the sheet; heap from the drop-in; MGC left off, weekend timers on; proof used up; page 99ec1630 with the key from a non-loopback address, 401 with a wrong key and with none; daily check 31 PASS; second start refused; restore refused while running; stop "no" / YES; config and journal untouched |
| G. Undo | 9 | resume refuses with no proof, with a RUNNING PC, with an enabled PC unit; accepts the real status; "no"; YES puts back enabled and active states, cron, order; MGC and weekend services not started; clean |

## Measured
- Boot from the restored folder, Node 18.19.1, `NODE_OPTIONS=--max-old-space-size=1024`, 98.7 MB journal: live loop after 4.3 s, peak RSS 320 and 325 MB (two runs), "warm-up OK: 2000 15m bars", exit 0. No memory cap was applied (the laptop design gives 3 GB; a 3 GB cgroup run was not done).
- Bundle for a 100 MB test folder: 8.1 MB (the test journal compresses about 12:1; the real folder is 322 MB and will be larger).
- Time zone: three boots identical except `TZ` (UTC, Asia/Tokyo, America/Los_Angeles): 27 new journal rows each, 0 rows differ; 8 of 90 log lines differ, all of them the run folder name or measured milliseconds. ICU check on Node 18.19.1 prints the right local times for Los Angeles, Chicago and New York.
- `health-watchdog.js` runs on Node 18.19.1 from the restored folder and prints its one line.

## Not tested here
- The Ubuntu `nodejs` package path of `install` (apt). The package version was read from packages.ubuntu.com (18.19.1+dfsg-6ubuntu5); the tarball path is the tested one.
- Real systemd: `enable`, `Requires=`, `Restart=`, timers firing, `Persistent=`, the `+` prefix on `ExecStartPre`, journald. `systemd-analyze verify` parsed 11 unit files and 5 drop-ins with no complaint except this host's missing `/usr/bin/node` and `/usr/local/sbin/mac-local`.
- A non-root `User=` (user creation and `chown` are skipped in the sandbox).
- `hwclock` under WSL (the sandbox feeds a fake PC clock).
- The real weekend units, the real env file, the real 322 MB folder.
- Ship-gate items that belong to the reviewer desk: 1 core / memory cgroup run, restart soak, trade witness on a replay day, `go.sh`/`install-edge.sh` run over the restored folder.
- PowerShell: every command in the sheet, including the two pipes that carry the proofs (`ssh ... | wsl ...` and `wsl ... | ssh ...`).

## Windows-only items: the command Mac runs and what he must see

| Item | Command (PS = PowerShell) | Expected |
|---|---|---|
| WSL2 and distro | `wsl -l -v` | `Ubuntu-24.04` ... `2` |
| systemd on | `wsl -d Ubuntu-24.04 -u root -- ps -p 1 -o comm=` | `systemd` |
| Node | `wsl -d Ubuntu-24.04 -u root -- /usr/bin/node -v` | `v18.19.1` |
| `.wslconfig` applied | `wsl -d Ubuntu-24.04 -- free -m` | Mem total 2800 to 3100, Swap about 2047 |
| Stays up when idle | close all windows, wait 10 min, `wsl -l --running` and `wsl -d Ubuntu-24.04 -- uptime` | distro listed; up 10 min or more |
| Logon task | `(Get-ScheduledTask -TaskName "MacBot-WSL").State`; then restart Windows, sign in, wait 3 min, run the daily check | `Running`; `CHECK run: N PASS, 0 STOP` |
| Sleep off on AC | `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` | `Current AC Power Setting Index: 0x00000000` |
| Lid on AC | `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION` | `Current AC Power Setting Index: 0x00000000` |
| Modern Standby | `powercfg /a` | read only: `Standby (S0 Low Power Idle)` listed means Start > Sleep freezes the bot |
| Did it sleep? | `powercfg /sleepstudy` (admin), open the report | no standby session inside trading hours |
| Clock | `wsl -d Ubuntu-24.04 -u root -- /usr/local/sbin/mac-local check base` | `PASS  clock: within N s of internet time` |
| Clock vs PC clock | `wsl -d Ubuntu-24.04 -u root -- hwclock --get` then `wsl -d Ubuntu-24.04 -- date` | same second (UTC); the daily check prints `PASS  Linux clock = PC clock` |
| Time zone | `wsl -d Ubuntu-24.04 -- timedatectl show -p Timezone --value` | `Etc/UTC` |
| Timers | `wsl -d Ubuntu-24.04 -u root -- systemctl list-timers --all "mac-*"` | 4 lines: weekend start, weekend stop, watchdog, tick, each with a NEXT time |
| Key gate | phone or second device on the Wi-Fi (option D1 only): page address with no key | the key screen, no data |
| Key gate from Linux | daily check | `PASS  phone server refuses a request without the key (401)` |
| Windows Update hours | Settings > Windows Update > Advanced options | the active hours set in E3 |
| Tailscale | not installed by this package | - |
| Outside alarm (stage H) | daily check; then lid closed on battery 10 min when flat | `PASS  outside alarm: last ping sent N s ago`; the alert arrives |
