# GATE-LOCAL: "bot to Mac's own PC" package (S/local1, local r1 + ADDENDUM-1) — reviewer desk MacLocalCheck, 2026-11-12

## Verdict: SEND WITH RULES

No path was found by which the scripts start a second bot, start on a missing settings file, or lose a journal row on the way over. The bot from the restored folder boots, survives three kills and places the witness orders under Mac-box limits. One defect would leave the bot switched off for a week after a normal laptop weekend (F1); it and six smaller ones are fixed by a 67-line patch that passes my sandbox. Rule 1 is therefore: ship the patched scripts, not the ones in the zip.

Nothing in this package has run on Windows, WSL or real systemd, by the builder or by me. Stage B (which does not touch the bot) is the first real test, and the rules make Mac send its output before stage C.

Reviewed (sha256, first 16): `setup-local.sh` 6bc3f27d52d35e1b, `vps-handoff.sh` a90b796099736ccd, `INSTALL-local-DRAFT.txt` bf80bd95163e564b, `MacLocal-r1.zip` 378862390243b701 (its 3 files equal the folder's, no CRLF), `ADDENDUM-1/STAGE-autologon.txt` b2e25cdf6b6ca245 + `SHEET-rulings.patch`. `EXPECT.sha256` = the repo's edge r1.6 list (62 files) + phone page 99ec1630: confirmed against `deliver/edge-r1.6/tree/SHA256SUMS`.
Evidence: `S/local1-review/run/` (`pipe.sh`, `pipe2.out` = package as built, `pipe3.out` = with my patch, `rf.sh`, `rigruns/`, `inst/`). Patches: `S/local1-review/patch/`.
Not re-run: the builder's own 114-check harness (its log says 114/114; I ran my own sandbox instead, on a fake server with `User=`, real-shape weekend timers with `Persistent=true`, a 150 MB journal and extra state files).

## Rules for sending

1. **Apply `patch/setup-local.reviewer.patch` and `patch/vps-handoff.reviewer.patch`, rebuild the zip, re-take the hash Mac checks in A4.** They fix F1, F3, F4, F5, F6, F7, F8 below. Sandbox result with the patch: every earlier result unchanged except the intended ones (`pipe3.out`).
2. **Stage B first, alone, any day; Mac sends the output of B4, B5 and B6 before stage C.** These prove the three unverified Windows facts: `.wslconfig` was read (Mem 2800-3100), the logon task runs, Ubuntu is still up after 10 idle minutes. If B6 fails, stop: the keep-alive design does not hold on his WSL version.
3. **If the clock line says STOP in B4 or later: PS-ADMIN `w32tm /resync`, then check again.** The sheet's `hwclock -s` only copies the Windows clock into Ubuntu; when Windows itself is seconds off internet time (common on Home, which syncs weekly) it changes nothing and `start` keeps refusing (F2).
4. **Stage C on a weekday, market open, flat, Mac at the PC for the 15 minutes, C4 to C9 in one sitting** (the bundle with the broker key lies in Downloads in between). After DONE, Mac reads the account name on the page: it must be the combine account.
5. **On the server: start nothing, run no old sheet, ever** (ADDENDUM-1 adds this line to C9; keep it). Every old installer ends with `systemctl start mac-bot-live` and the server has no guard of its own (F9). The day the server is cancelled: first `mac-local vps-address none`, or a stranger's machine on that address can block every start of the PC bot (F10).
6. **Automatic sign-in: step 5 of STAGE-autologon.txt is the one test of the whole chain and is mandatory**, once after step 4 and again after step 6. With a Microsoft account, if the restart stops at the sign-in screen with the pre-filled name: in Autologon type the account's e-mail as Username and `MicrosoftAccount` as Domain (UNVERIFIED; settled by the same test). Repeat step 5 after every Windows feature update and every password change.
7. **The way back (stage G) is only complete while the PC bot has not traded.** After the first PC trade the server would restart from move-day journal and state. The copy-back step must be built before it is needed (builder's stated gap; Mac ruled the server is the way back, so this is the next piece of work, not an option).
8. **Option D1 (same Wi-Fi) stays off until Mac asks**, and then only at home: the firewall rule in the sheet is not limited to the home network profile.

## Ship gate (run by me on the restored folder)

Restored folder = output of the real `vps-handoff.sh pack` + `setup-local.sh restore` in the sandbox; its 62 code files match the repo's edge r1.6 list, config, journal and env file are byte-identical to the fake server's, env mode 600.

| Item | Result | Numbers |
|---|---|---|
| Mac-box boot: 1 core, 961 MB memory cgroup (no swap here, so harder than the server), Node 18.19.1, heap as the server's drop-in sets it (`NODE_OPTIONS=--max-old-space-size=1024`, measured limit 1072 MB), journal 150 MB (server: 103 MB), real 2000-bar warm-up | PASS | live loop after 4.4 s; "warm-up OK: 2000 15m bars ... after 1 s"; peak RSS 315 MB; cgroup peak 279 MB; no OOM, exit 0 |
| Restart soak: 3 SIGKILLs mid-session (entry resting, mid-trade, runner with TP2 resting), same limits, 150 MB journal | PASS | 4 segments, each reached the live loop with the full warm-up, each resumed the saved trade (3x, 3x, 1x); peak RSS 326 MB; ends flat, empty book |
| Trade witness: replay 11/02 17:00-18:20Z (a55 data, F config) | PASS | the same 5 fills as the edge r1.6 gate run (entry 3 @ 28640.25, stop-out; entry 3 @ 28570, TP1 2 @ 28558.75, runner lock stop 1 @ 28548.75); broker end state byte-identical to that run |
| Install path: `install-edge.sh` (r1.5 to r1.6) over the restored folder shape, then rollback | PASS | 62 files match, config / page / flatcheck / tide state / journal unchanged; rollback leaves the folder byte-identical |
| Second run of each script | PASS | second `install` changes nothing; second `stop` = "nothing to do"; second `restore` = "ALREADY RESTORED" |
| Live health alerts | PARTLY | covered: not-LIVE, crash loop, warm-up (in-bot, travel with the build), dead process (watchdog timer added on the PC). Not covered: sleep, power, internet, Ubuntu stopped (stage H is off by Mac's ruling; the sheet says so in bold). |

Memory on the laptop (question c): sane. The bot uses about 320 MB against a 1024 MB allowance; both services at their limits plus Ubuntu fit in the 3 GB cap without swap. Windows keeps 4.8 GB only in that worst case; normally the Ubuntu VM holds about 1 GB. Under Windows memory pressure the VM's memory is paged like any program's: the bot gets slow, it is not killed. Nothing to change.

## Interlock attacks (question a)

| Attack | Result |
|---|---|
| No proof / proof older than 10 min / used once | start refused; proof file deleted after YES |
| Old status text replayed (15 min) | refused (time stamp) |
| PC and server clocks 5 min apart | refused (safe side; the limit is 120 s) |
| Text as PowerShell 5.1 pipes it (CRLF, no last newline) | accepted, as it should be |
| UTF-16 or a byte-order mark in front | refused (safe side; if Mac ever sees this, he is in PowerShell 7 or used a redirect: send the lines) |
| Server stopped but still enabled; a weekend timer enabled; proxy line cut out of the text | refused |
| Server bot crash-looping ("activating", disabled, no process this second) | **server prints VPS-STATE: OFF** (F7), but the PC's own parser refuses the proof. With the patch the server says RUNNING too |
| MGC unit running on the server; a unit added after the stop (for example the watchdog timer from the other package) | refused |
| Server re-enabled after the proof, inside its 10 minutes | start goes ahead only if no server address is stored; with the address stored (sheet step C6 comes before C7) the start and every later start are refused |
| `Persistent` weekend-start timer on the server after the stop | cannot fire: a stopped, disabled timer is not evaluated. It matters at `resume` (F8) and on the PC (F1) |
| Undo with the PC still on / enabled | refused; resume needs the mirror proof; order proxy, bot, timers confirmed |

What the interlock does not cover (stated, not hidden): somebody starting the server bot by hand weeks later. The PC then sees it only at its next start or at the daily check, and only if the server's phone port answers from Mac's network (F9).

## Config, account, state (question b)

`start` cannot run without `config-local.json`, the journal, the env names `PTX_USER PTX_KEY PTX_CONFIRM_LIVE PROXY_SECRET NTFY_TOPIC` (an empty or `""` value counts as missing), port 8787, or with `MACBOT_NEWS_FETCH=0`. `restore` refuses a bundle whose files differ from the server's list by one byte, a truncated journal, a missing page or changed library (EXPECT list), and never overwrites an existing bot folder. The account id travels twice (env file and `account.conf`), both byte-identical; with neither present the bot itself refuses when the login has more than one account. State files travel as the stopped server left them; the five kinds that must not act (phone requests, queued flags, heartbeat, temp files) are removed on arrival and listed. One gap: an emptied `config-local.json` (`{}`) passed the every-start guard (F6).

## Findings, ranked by cost to Mac

**F1 (high; fixed by the patch): after a weekend with the laptop off, the bot can stay stopped all week.** The server's weekend timers travel to the PC: stop Friday 14:00 PT, start Sunday 15:00 PT, both `Persistent=true`. systemd's rule for that setting: a timer that missed its time while it was off fires at once when it starts. A laptop shut at Friday 13:30 and opened Monday has missed both; at start-up both fire together and nothing orders them. If the stop lands last, the bot is off until next Sunday. The sheet mentions this as a note ("the catch-up order is not guaranteed") and asks Mac to keep the laptop on at Sunday 3 PM. That is the ordinary case for a laptop, not a corner. Alert: the watchdog would push "NOT RUNNING" every 30 minutes in trading hours, so it is loud, but Mac has no instruction for it. Patch: on the PC only, a drop-in turns catch-up off for the stop timer (a missed stop needs no catching up; a missed start still catches up). The server's unit file itself stays byte-identical. Not run on real systemd; `systemd-analyze verify` accepts it.

**F2 (medium; rule 3): the clock check can refuse the start with a remedy that cannot work.** `start` and `check` demand Ubuntu's clock within 3 s of internet time. Ubuntu's clock follows Windows' clock. If Windows is off, `hwclock -s` (the printed fix) repeats the error. Mac would be stuck at B4 or, worse, at C7 with the server already stopped. Also: the 3 s test reads a web server's `Date` line with up to 8 s allowed for the answer; a slow answer can fail it falsely. Retry once before believing it.

**F3 (medium; fixed): the clock-keeper can use up the day's push allowance.** Every minute it compares Ubuntu's clock with the PC clock and, above 2 s, corrects and pushes "PC clock corrected", with no limit. If a correction ever fails to hold, that is a push a minute; ntfy's daily allowance is shared with the bot, whose alerts then stop arriving. Patch: at most one such push per 30 minutes.

**F4 (medium; fixed): the watchdog the package adds on the PC runs at second 0 and as root.** Second 0 is the second the weekend timer starts the bot on Sunday, so it reads Friday's heartbeat and pushes "Bot NOT RUNNING", then "back" a minute later, every Sunday (shown in the watchdog review, WATCH-REVIEW F1). As root, its state file in the bot folder is root-owned next to files owned by the bot's user. Patch: second 30 and the bot unit's `User=`. If the server watchdog package is installed before the move, its units travel and this code path is not used.

**F5 (low; fixed): `restore` and `check` die without a word when the units carry no heap setting.** A `grep` with no match ends the script under `set -e` after "PASS start guard installed": no STOP, no DONE, exit 1 (`rf.sh`, heap case). The real server has `heap.conf` on both units, so Mac would not hit it today.

**F6 (low; fixed): the every-start guard accepted `config-local.json` = `{}`** (the bot would trade shipped defaults). Restore itself cannot produce that; a later accident could. Patch: the guard wants a non-empty settings object.

**F7 (low; fixed): server `status` calls a crash-looping unit OFF.** Only "active" counted as on. The PC-side proof parser already rejects "activating", so no false proof reached the PC. Patch aligns the server side.

**F8 (medium for the way back; fixed for the server): `resume` after one or more weekends starts the timers with catch-up due.** Same rule as F1: both weekend timers fire the moment `resume` starts them, right after it started the bot. The stop can win; resume then reports STOP with both bots off. Safe, but the way back fails on the day it is needed. Patch: `resume` marks the timers as just run before starting them (the stamp file systemd reads). Not run on real systemd.

**F9 (residual; rule 5): the server has no guard of its own.** Its units are disabled, not blocked. A manual `systemctl start`, or any old install sheet run against the server, starts a second bot; nothing on the server objects. A block that survives until `resume` (a drop-in that makes the unit skip its start) is the right fix for r2. I did not put it in the patch: `restore` copies every drop-in, and my test shows it would accept such a block without comment and the PC bot would then never start. It needs the pack-side exclusion and a restore-side refusal built together.

**F10 (low; rule 5): a stored server address that later belongs to someone else blocks the PC bot for good.** The guard treats any answer on that address and port as "the server bot may be running". The sheet never tells Mac to clear the address when the server is cancelled.

**F11 (info): `restore` can end "STOP ... the files are in place but do NOT start"** (env file lacks a name). True and safe (`start` refuses), but it is the one STOP in the package after which something was changed, against the sheet's first line. Wording only.

**F12 (info): the phone server trusts every program on the PC.** `http://localhost:8787` needs no key and answers any web page open in a browser on the laptop (the proxy allows all origins). A hostile page could send flatten or pause. It cannot read the broker key. Same as the "original localhost use"; new only because a live bot now sits behind it. Not fixable in this package; worth a line to Mac: no casual browsing on the trading laptop during a session.

**F13 (info): future bot installs need a new transfer habit.** Old sheets scp a zip to the server; the new form of the command is in stage F, the new way to get a package into Ubuntu is not written yet.

## PowerShell lines, read one by one (question d; none could be run here)

No quoting, `$` or line-end fault found. Checked specifically: `root@${srv}:` (braces needed before the colon: present in every scp line); `ssh root@$srv "..."` (remote text holds no `$` or backtick); the two proof pipes (PowerShell 5.1 hands native output on as text lines with CRLF and no byte-order mark; both parsers strip CR, proven in the sandbox; a mark makes them refuse, never pass); `"$env:USERDOMAIN\$env:USERNAME"` (the backslash ends the first name); `Set-Content -Encoding ascii` with five strings = five lines; the Hyper-V rule's quoted GUID; `--since "-10 min"`; the scripts run from the unzip folder through `/mnt/c` with LF line ends (zip checked). Passwords and YES prompts reach the console in every piped line. Two soft spots, both fail safe: (1) a new PowerShell window forgets `$srv` (the command errors, nothing happens; G2 asks again); (2) the keep-alive is a visible black window that Mac must not close. If he does, the second lock (`instanceIdleTimeout=-1`) is all that holds Ubuntu up, and that key's behaviour on his WSL version is exactly what B6 tests. Suggested for r2, untested: let the task restart itself on failure (`-RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`), so a WSL update or `wsl --shutdown` is followed by a restart without waiting for the next sign-in.

## ADDENDUM-1 (automatic sign-in, server kept, alarm off)

- **Risk wording: accurate and plain.** It says both things that matter: whoever opens the laptop is in the account, and the stored password can be read back by an administrator of that laptop (Microsoft's own words, quoted). The tool choice is the right one of the three and the reasons are given. The password is typed only into the tool's window. Read-back 4b checks that no password sits in plain text and tells Mac not to send that line.
- **One test for the chain: yes, step 5.** Restart, hands off, then four read-only lines: task Running, Ubuntu up 2-5 min, units active + LOCAL-STATE RUNNING, daily check 0 STOP. If any link fails (sign-in, logon task, keep-alive, units, guard, warm-up) one of the four shows it. It needs the market open for "TIDE LIVE", which the sheet says. Rule 6 makes it mandatory and repeats it after step 6 and after updates.
- Gaps: the Microsoft-account case rests on an unverified pre-filled name (rule 6 gives the fallback); the lock-after-sign-in task (step 6) is untested and is what removes most of the open-laptop risk, so its test matters as much as step 5's; a Windows feature update or a password change silently ends automatic sign-in (the addendum says the second, not the first).
- The sheet patch applies to the sheet as reviewed and its nine changes match the three rulings. With F1 fixed, the "SUNDAY" paragraph of stage F should lose its "tell me if the service is not active" clause.

## Windows-only checks Mac must run, with the output to expect

| # | When | Command (PS = PowerShell) | Must see |
|---|---|---|---|
| 1 | A | `wsl -l -v` ; `wsl --version` | `Ubuntu-24.04 ... 2` ; a first line `WSL version: 2.x` (write the number down) |
| 2 | B4 | `wsl -d Ubuntu-24.04 -u root -- /usr/local/sbin/mac-local check base` | `CHECK base: 8 PASS, 0 STOP` (Node v18.19.1, systemd running, clock within 3 s) |
| 3 | B4 | `wsl -d Ubuntu-24.04 -- free -m` | Mem total 2800-3100, Swap about 2047. About 3900 = `.wslconfig` not read |
| 4 | B5 | `(Get-ScheduledTask -TaskName "MacBot-WSL").State` | `Running` |
| 5 | B6 | all windows closed 10 min, then `wsl -l --running` ; `wsl -d Ubuntu-24.04 -- uptime` | `Ubuntu-24.04` listed ; `up 10 min` or more |
| 6 | C3 | the `facts:` line of pack | `node_version=v18.19.1 executor_sha8=26089560 page_sha8=99ec1630` |
| 7 | C4/C5 | `Get-FileHash .\maclocal-bundle.tgz` ; restore | same 8 characters three times (server, PC, restore); `build check: 63 code files + phone page match`; `DONE restore` |
| 8 | C7 | proof line, then `mac-local start` | `PROOF OK: the server bot is OFF and DISABLED`; then the 6 PASS lines of the sheet and `DONE: the bot runs on this PC now` |
| 9 | C8 | browser on the PC: `http://localhost:8787/mobile.html` | page 2.2.2, the combine account, LIVE |
| 10 | after C | `wsl -d Ubuntu-24.04 -u root -- systemctl list-timers --all "mac-*"` | weekend start, weekend stop, watchdog, tick, each with a NEXT time |
| 11 | after C | `wsl -d Ubuntu-24.04 -u root -- systemctl show mac-bot-live -p Environment` | contains `NODE_OPTIONS=--max-old-space-size=1024` (and the account line; do not send this output on) |
| 12 | E1 | `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` ; `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION` | `Current AC Power Setting Index: 0x00000000` in both |
| 13 | E1 | `powercfg /a` | read it: "Standby (S0 Low Power Idle)" = Start > Sleep freezes the bot silently |
| 14 | flat, once | plugged in, lid closed 5 min, open, daily check | all PASS, heartbeat under 60 s, no "PC clock corrected" push |
| 15 | flat, once | Win+L for 10 min, unlock, daily check | all PASS |
| 16 | autologon step 5 | `Restart-Computer`, hands off 3 min, then the four lines of step 5 | `Running`; `up 2-5 min`; both units `active enabled`, `LOCAL-STATE: RUNNING`; `CHECK run: N PASS, 0 STOP` |
| 17 | autologon 4b | the Winlogon read-back line | `AutoAdminLogon = 1`, `DefaultPassword` empty |
| 18 | daily | `wsl -d Ubuntu-24.04 -u root -- /usr/local/sbin/mac-local check` | `CHECK run: N PASS, 0 STOP`; the line `NOTE  NO OUTSIDE ALARM is set` is expected |
| 19 | first Monday | daily check before the session | `mac-bot-live.service is active`, TIDE LIVE (this is the F1 case) |
| 20 | first Sunday 3 PM PT | phone | no "Bot NOT RUNNING" push at 3:00 (this is the F4 case) |
| 21 | weekly | PS-ADMIN `powercfg /sleepstudy` | no standby session inside trading hours |
| 22 | after any feature update | rows 3, 4, 12, 16 again | unchanged |
| 23 | D1 only | phone on home Wi-Fi, page address in a private tab, no key | the key screen and no data. Data without a key = undo D1 at once |

## What stays open after this gate

Everything in the right-hand column of my plan: real systemd (`ExecStartPre=+`, `Requires=`, timers, `Persistent`), WSL idle behaviour, the logon task, `hwclock` under WSL, Node from apt, a non-root service user being created, the real weekend units and env file, the 322 MB real folder. Rows 2-5 and 8 of the table are where each shows up first.

---

## r2 confirmation (2026-11-12): SEND

Checked: `MacLocal-r2.zip` 916ac567, `setup-local.sh` be6d6f33, `vps-handoff.sh` 07650be8, `INSTALL-local-DRAFT.txt` 67397f23, `EXPECT.sha256` c6e77e15 (unchanged, 63 lines).

1. **Patches: in as written.** `diff` of both r2 scripts against my `patch/new/` files shows only text: the two header lines (r1 to r2), the clock STOP line (now names `w32tm /resync` and "try twice"), the "Linux clock vs PC clock" STOP wording, and the restore line that now says "STOP (after the copy) ... the bot files ARE in place". No logic differs from the files my sandbox ran. `bash -n` clean. The builder's log says 120/120 (not re-run by me; my sandbox result stands for these exact code paths).
2. **Zip: exactly three files** (`setup-local.sh`, `vps-handoff.sh`, `EXPECT.sha256`) at those hashes, LF line ends.
3. **Sheet:** stage order A, B (ends with B7: stop, send B4/B5/B6 output and the WSL version, wait for the go), C (weekday, market open, flat, one sitting), D, E, E5 (lock step E5.6 marked optional and untested; restart test mandatory, repeated after feature updates and password changes; the Microsoft-account fallback is there), F, G (copy-back named as an open item), H (off). My eight rules are all present (order block at the top, clock fix in B4 and F, "never start anything on the server / old sheets void", clear the address before cancelling the server, account check on the page, D1 off until asked). The 23-row appendix is complete. "NOTHING IN THIS SHEET HAS RUN ON WINDOWS, ON WSL OR ON REAL SYSTEMD" is the second paragraph. No address, user name, account id or host path found. Hash prefixes in the sheet: executor 26089560 and page 99ec1630 match the files; the zip's prefix is not printed in the sheet ("the 8 characters I send you"), so the message that carries the zip must say **916AC567**.
4. **Watchdog on the PC at second 30 with no Sunday exclusion: acceptable to send; fix in the next revision.** What can happen: one false "Bot NOT RUNNING" followed by "heartbeat is back" a minute later, (a) on a Sunday when the weekend start lands after 15:00:30 PT, and (b) on the PC more often than on the server: whenever the laptop or Ubuntu starts inside trading hours after 10+ minutes off and the watchdog's first run comes before the bot's first heartbeat (the start guard takes some seconds first). It costs no trade and cannot start or stop anything. A Sunday exclusion window would cure only (a). The better fix for the PC is a short grace after Ubuntu starts (skip the watchdog run while uptime is under about 2 minutes) plus the Sunday window. Until then one sentence for Mac covers it: **"NOT RUNNING followed by 'back' within 2 minutes after a start is the start itself; NOT RUNNING with no 'back' is real."** The appendix row 20 already makes him report the Sunday case.

Open after r2, unchanged: nothing has run on Windows; copy-back for the way back is not built; the server has no guard of its own (rule in the sheet).
