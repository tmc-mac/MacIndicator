# WATCH-REVIEW: server watchdog installer (S/watch1) — reviewer desk MacLocalCheck, 2026-11-12

## Verdict: SEND WITH RULES

The installer cannot start, stop or restart the bot or the phone server, every STOP leaves the server unchanged, and the builder's 243/243 reproduces. Nothing found can cost a trade. What it can do is push Mac falsely (Sunday open) or stay silently mute (one env-file shape), so it ships with the three rules below. A 46-line patch that removes most of the rules is in `S/watch1-review/patch/install-watchdog.reviewer.patch`; if the builder applies it, the sheet's hash prefix (1DC42DCE) must be re-taken.

Reviewed: `install-watchdog.sh` sha256 1dc42dce…e2b8 (matches NOTES.md and the sheet's prefix), `INSTALL-watchdog-DRAFT.txt` 2ef35dc4…, `test/`. Evidence: `S/watch1-review/harness-node18.txt` (my re-run), `S/watch1-review/adv.sh` + `adv-out.txt` (my 14 cases), all sandboxed. Not tested by anyone: real systemd (daemon-reload, the timer firing, journald returning the line), a real push.

## Rules for sending (if the patch is not applied)

1. **Before the install, Mac runs one read-only line** and sends the output:
   `ssh root@<server> "systemctl show -p NeedDaemonReload --value mac-bot-live.service mac-bot-proxy.service; systemctl show -p AccuracyUSec --value mac-bot-weekend-start.timer"`
   Wanted: `no`, `no`, then a time. If either of the first two says `yes`: do not install (see F2). If the third says `1min` (systemd's default): tell Mac to expect finding F1 on Sundays, or fix the weekend timer first.
2. **Run `proof` right after the install, in trading hours.** It is the only real evidence that a push reaches the phone. "PROOF OK" with no push on the phone = stop and report (see F3/F4).
3. **Tell Mac in the sheet:** the first Sunday 15:00 PT may bring one "Bot NOT RUNNING" followed a minute later by "Bot heartbeat is back". That pair is the weekend start being a few seconds late, not a fault. A "NOT RUNNING" with no "back" within two minutes is real.

## What was asked, and the answer

| # | Question | Answer |
|---|---|---|
| 1 | Can it start/stop/restart/reload-into-effect the bot or proxy? | **No.** The only verbs given a bot unit are `show -p LoadState/EnvironmentFiles/User`. The proxy unit is never named. Other calls: `daemon-reload`, `enable --now`/`disable --now`/`is-active` on the watchdog timer, `start`/`reset-failed` on the watchdog service. The new units have no Requires/PartOf/BindsTo/After/OnFailure, so they cannot pull the bot along. Checked by reading every `sc` call and by the call log in every sandbox run. daemon-reload: see F2. |
| 2 | STOP = nothing changed; undo complete? | **Yes for STOP**: all 12 checks run before the first write (line 162); my non-root, weekend, future-mtime and env cases left the tree byte-identical with zero non-`show` calls. **Undo is complete** for its own two files, also after a kill between write and enable (X12). Three edges: F5, F6, F7. |
| 3 | Units valid, bot's User, EnvironmentFile, no secrets printed? | `systemd-analyze verify` rc 0 on both (systemd 255); calendar `*-*-* *:*:30` normalises and iterates once a minute. User= is copied from the bot unit (omitted when the bot runs as root), EnvironmentFile and WorkingDirectory are the bot's. Topic, key and user name appear 0 times in the output of install, proof and undo. |
| 4 | Harness re-run + 5 adversarial cases | 243 passed, 0 failed on Node 18.19.1; output identical to the builder's apart from seconds. My cases: non-root x3 modes (STOP, unchanged; the builder could not test this), weekend / 20 h heartbeat (STOP), heartbeat missing (builder's C case, confirmed), env without or with empty `NTFY_TOPIC` (F3), timer present but disabled (re-enabled, files untouched, DONE), plus foreign unit, failed re-run, write failure, future mtime, kill mid-way, CRLF env, false-push timelines. |
| 5 | False pushes | Sunday start: F1. Friday 14:00 PT stop: quiet (the window closed at 13:10; at 14:15 the line is "outside trading hours: no push", and nothing on Saturday or Sunday 14:59). Holidays: bot left running = quiet (the heartbeat is the process, not the market); bot stopped by hand inside the weekly hours = a push every 30 min, as the sheet says. Routine install: F8. |
| 6 | Sheet as a non-engineer | Passes: every command has its expected output, the hash prefix matches the file, the PowerShell quoting is right (double quotes outside, single inside, no `$` or backtick in the remote part; `$env:USERPROFILE` is outside the remote string). Gaps: rule 3's Sunday note is missing; "dead or frozen" overstates (F9). |

## Findings, ranked

**F1 (medium, likely to be seen): one false "NOT RUNNING" + "heartbeat is back" pair every Sunday if the bot starts after 15:00:30 PT.**
The watchdog runs at second 30. At Sunday 15:00:30 the trading-hours window is already open and the last heartbeat is Friday's. The builder's second-30 choice works only if the bot process is up and has written its first beat within 30 s of 15:00:00 (the beat is written at start, before login: live-executor.js:2100, lib/healthAlerts.js:259, confirmed). The start is fired by `mac-bot-weekend-start.timer`, whose accuracy is not in the inventory; systemd's default is 1 minute, meaning the start may land anywhere up to 15:01:00, at an offset that is fixed per machine. Sandbox: start at 15:00:02 = "ok"; start at 15:00:45 = push at 15:00:30, "back" at 15:01:30. Whether Mac's server is the lucky or the unlucky case is unknown until rule 1's third line, or the first Sunday. Cost: one pair of pushes a week, and an alert Mac learns to ignore. Fix outside this package (when flat, not now): `AccuracySec=1s` on the weekend-start timer.

**F2 (low today, cheap to close): `daemon-reload` makes any bot unit or drop-in edited on disk the loaded version.**
It restarts nothing. But an unreloaded edit of `heap.conf`, `account.conf` or the unit would start to count at the bot's next start (a crash restart with Restart=always, or Sunday's weekend start at the latest). Is it a risk today? Only if such an edit is pending, which the inventory cannot tell. Two reasons it is probably not: the installer's own `systemctl enable` reloads anyway, as does any package update on the server; and the 1024 heap in heap.conf is evidently in force (the bot stopped crash-looping). The check is one read-only property, `NeedDaemonReload`: rule 1, and a STOP in the patch.

**F3 (medium if it applies, unlikely): `NTFY_TOPIC=""` passes the check and the install says DONE with a watchdog that can never push.**
The check accepts any non-space character after `=`, including a quote. systemd reads `""` as empty; the watchdog then logs "not sent (NTFY_TOPIC not set)" only when it would have pushed. Install output is the normal "ok: heartbeat" and DONE (X4). The bot pushes today, so the server's value is almost certainly real; `proof` would show PROOF FAILED. Patch tightens the check; rule 2 covers it.

**F4 (low): `proof` reads the env file with sed, the timer reads it through systemd; they can disagree.**
A line ending in a carriage return or spaces: systemd strips them, `proof` does not, so proof pushes to a different topic name and prints PROOF OK while the phone stays silent (X5: path `/abc%0D`). The real timer would be right. Harmless but confusing; rule 2 says what to do. Patch strips trailing whitespace.

**F5 (low): a late failure on a re-run removes a working install.** Install once, re-run later, the service run fails: PROBLEM/UNDO removes both files and the timer (X9). The message says so truthfully. Mac ends with no watchdog and must re-run. Acceptable; say it in the sheet's re-run line.

**F6 (low): an existing unit of the same name not written by this installer is overwritten with no backup, and undo deletes it** (X8). The inventory says none exists. Patch: STOP unless the file carries the installer's first-line marker.

**F7 (low): `put` reports success when the write fails.** The function's last command is `changed=1`, so `put ... || fail_undo` never fires; the script prints "unit files written" and only a later step fails and undoes (X10). No harm reached the bot in any variant I could build; the message is wrong. Patch chains the three commands.

**F8 (info): a routine install does not push.** Stop-to-start under about 9.5 minutes is silent (sandbox: 2.5 and 9.5 min "ok", 10.5 min pushes, then "back"). `install-edge.sh` stops, copies and starts in seconds and undoes itself within about 2 minutes. An install that leaves the bot down 10+ minutes in trading hours pushes, which is correct. One side effect to know: the watchdog rewrites `health-watchdog-state-MNQ.json` in the bot folder every minute (same bytes unless it is alerting). `install-edge.sh` compares the whole folder before and after; if a bot stop inside an install ever lasts 10+ minutes, the state file changes and that installer would roll back a good install. Edge of an edge; listed so nobody is surprised.

**F9 (wording): "dead or frozen".** The heartbeat is written by a timer inside the bot, so a bot stuck waiting on the broker still beats (NOTES.md says this; the sheet does not). The watchdog catches a dead process, a hard hang and a stopped service. "Up but not trading" stays the in-bot alert's job. Suggest: "dead or completely hung".

**F10 (info): journal volume** is about 4 lines a minute, not 1 (systemd's own Starting/Finished lines for a oneshot), roughly 5,800 lines a day. Fine on an 11 GB-free disk; the sheet's step 4 greps for the right line.

**F11 (info, test artefact): the builder's safety greps J1/J2** fail on the patched file by design (the patch reads `NeedDaemonReload` of the proxy unit with `show`). If the patch is taken, J1 should become "the proxy unit is only ever used with show". 241/243 otherwise; my X4, X5, X8, X10 cases turn green.

## Facts from the inventory that matter beyond this package
- The server's heap is **1024 MB** (drop-in `heap.conf`, `NODE_OPTIONS`), not the 493 the ship gate in CLAUDE.md names. Reviewer boots at 493 are stricter than the server; the transfer gate uses 1024 and the 103 MB journal.
- State files `tide-live-state-MNQ.json` and `tide-starts-MNQ.json` exist on the server and are not written by the edge r1.6 source I read. My GROUND-TRUTH list for the transfer package must add them (covered in the transfer gate; a whole-folder copy carries them).

---

## Revision 2 (install-watchdog.sh 4bacaa5f, sheet 31faae3a): SEND

Evidence: `harness-r2-node18.txt` (my re-run: 336 passed, 0 failed, Node 18.19.1), `adv-r2-out.txt` (my 14 cases on revision 2), `f8-t1.log` to `f8-t7.log` (installers on the g4 rig with the state file present).

1. **My patch is in.** Diff against my patched file shows only additions: an explicit "expected no, got ..." STOP when `NeedDaemonReload` cannot be read, a printed line with the two values, the four-line Sunday schedule, a restart of the watchdog's own timer when its schedule changed, and "a failed re-run puts the earlier install back" (was my F5).
2. **My 14 cases on revision 2:** all as wanted. Empty or quoted-empty topic = STOP; CRLF or trailing spaces in the env file no longer send `proof` to a wrong topic; a hand-made unit = STOP, untouched; a failed re-run keeps the working install (2 files, timer active); a write failure says PROBLEM at the write; non-root, weekend, future heartbeat time = STOP with nothing changed; kill mid-way is cleaned by undo; no topic, key or user printed.
3. **Sunday exclusion: correct.** Evaluated with `systemd-analyze calendar` (systemd 255) across the four lines: Sunday runs 14:58:30, 14:59:30, then 15:02:30, 15:03:30 PT; nothing at 15:00:30 or 15:01:30. Saturday and Monday 15:00:30 still run. Same result on a daylight-time Sunday (March). One oddity, harmless: on the autumn clock-change Sunday the repeated 1 AM hour is skipped (weekend, outside trading hours). This covers a weekend start up to 2.5 minutes late.
4. **Re-run restarts only its own timer.** Re-run over an installed copy with the old one-line schedule: calls were `daemon-reload`, `enable --now mac-bot-watchdog.timer`, `restart mac-bot-watchdog.timer`, `start mac-bot-watchdog.service`; no call names a bot unit except `show`. Cosmetic: it prints "unit files written: service, timer" when only the timer changed.

### F8 settled: the state file does not break an install, a rollback, the page tool or the transfer

`health-watchdog-state-MNQ.json` is rewritten every minute with the same bytes (`{"alertedAt":null,"since":null,"pushes":0}`) while the bot is healthy. Tested on the g4 rig with the real `install-edge.sh` / `rollback-edge.sh` (S/pk16/MacBot-edge-r1.6, identical to the repo's):

| Case | Result |
|---|---|
| State file present, install r1.5 to r1.6 | DONE; state file untouched |
| Watchdog rewrites the same bytes in the middle of the install (its normal run) | DONE |
| Rollback after an install, state file changed since | DONE; the newer state file is kept |
| Watchdog installed after the bot install, then rollback | DONE; state file kept. With `--full` the file is removed (that mode puts the folder back exactly); the watchdog writes it again within a minute, with no false push |
| `set-terminal.sh install` with the state file present | DONE (that tool only looks at `mobile.html`) |
| State file's content changes in the few seconds between the installer's "before" list and its "after" compare | **the installer says "files other than the edge set changed" and rolls itself back to the old build, bot running** |

The last row is the only way the file can interfere. The content changes only at the minute the watchdog starts or ends an alert, or re-pushes (every 30 min while the bot is dead). For that to land inside an install, the bot must already have been dead or frozen for about 10 minutes when the install starts, or be down that long inside it; the installer's own window is seconds. Outcome if it ever happens: a safe automatic rollback and a clear message; run the install again. No fix is needed before sending. If a fix is wanted later, the smallest one that does not touch the bot is on the installer side: leave `health-watchdog-state-*.json` out of that whole-folder compare (the watchdog script has no option to put its state file elsewhere: it always writes next to the heartbeat it reads).

Transfer package: unaffected. `vps-handoff.sh stop` stops and disables every `mac-bot*` unit, the watchdog timer included (and `status` refuses to say OFF while it is on, tested in the transfer gate), so nothing writes while the folder is packed. The state file travels as an ordinary file. `EXPECT.sha256` lists code and the phone page only. The watchdog units travel too, and the PC then uses them (second 30 with the Sunday window, the bot's user) instead of the ones the transfer package would add.

Still not run by anyone: real systemd (the timer firing, `NeedDaemonReload`, journald) and a real push. `proof` right after the install remains the rule.
