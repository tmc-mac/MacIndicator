# GATE-R17: edge r1.7 (commit e327426c, branch edge17, executor 9d5bae71) and its install package (zip 0dc37d8a…), reviewer desk MacLocalCheck, 2026-11-15

No HOLD.
**Code: SEND WITH RULES. Install package: SEND WITH RULES.** Nothing found can change a decision, an order or a start. The rules are about what Mac is told and how the office reads the new rows.

S = $S. Evidence in S/review/r17/ (runs/, idcmp.py, hand.py, stress.cjs, collectors.cjs, tooltest.sh, killtest.sh, rbtest.sh, g4/, zip17/). All run by me, Node 18.19.1, nice 19. Deviation: during the identity runs I ran two replay processes at once (cores 1 and 3, load never above 2.5); everything else one at a time.

## Rules

1. **Office: do not use `office_formulas.old_runner` / `x03_x04_case` for the X-03 / X-04 verdict yet** (finding F1). Until it is fixed and reconciled with the bot's own `runner_shadow` row, read X-02 and the first-touch fields only.
2. **Office: treat bucket highs and lows as "within the last few seconds of a minute"** (F2). First-touch minutes can be one minute late and a best or worst can be short by the move in a few closing seconds.
3. **Sheet before it goes to Mac** (G4 findings S1 to S4): fill `@@CHECKED@@`, replace the two grep lines with quote-free ones, add the "bot may be left stopped" sentence, and say the first row can take up to four hours. Send the zip prefix **0DC37D8A** with the zip.
4. Rollback to r1.6 or older: `set-afterexit.sh clear` first, as the sheet says (the rollback script itself stops and says so; tested).
5. Tell Mac once: after this install the receipts' `configIdentity` hash changes (the settings hash covers a new key). That is the install, not a settings change.

## (1) Main claim: no decision can change

**Diff.** r1.7 against r1.6 (git archive of both): exactly six files differ: `lib/postExit.js` (new), `live-executor.js` (+14 lines, 1 changed), `tools/set-afterexit.sh` (new), `tests/edge17-tests.js`, `tests/afterexit-tool-tests.sh`, `EDGE-R17.md`. Every other file is byte-identical. The builder's patch file equals my diff.

**Every place live-executor.js calls into the tracker** (all read, none can throw into the loop):

| Where | What | Why it cannot reach a decision |
|---|---|---|
| line 65 | `require('./lib/postExit')` | start-up only; a load error would stop the bot at start, not in a poll |
| 1678 / 2094-2095 | enum entry; `validateMode` + start line | fail closed at start, like the other switches (tested: "maybe", true, 1, null, "ON" all refused) |
| 2970 | `createPostExit(...)` (LIVE and switch `on` only) | builds closures; no broker, token, order function or fetch in the module (requires only `fs`) |
| 2975 | `postExit.indexJournal(event)` | inside its own try/catch; only reads `journalId`, `type`, `code`, `t` |
| 3127 | `postExit.load()` | own try/catch; parses one small file; resumes happen in the first poll |
| 6311 | `postExit.onPoll({...})` after `score.onPoll`, before `pxOk` | inside its own try/catch, argument list included; no `await`, so it cannot reorder or delay the calls around it |

Other facts that matter:
- `m1` is the last 3 one-minute bars. The tracker filters and sorts a **copy**; it never mutates `m1`, the trade view or the event. `scoreTradeView()` is now called twice per poll; its only side effect is a once-per-trade ATR cache, so the second call changes nothing.
- Cost: 0.1 ms per poll on average and at most 10 ms (the moment a state file is written), measured in the stress run. The synchronous file write happens at most once a minute and at a tracker's start, exit and finish.
- The tracker's journal rows go through `appendJournal`. For a `post_exit` row: `controlParity` ignores it (not in its row list), `planTerminals` ignores it (not evidence), `phoneSnap`, `tradeWhy`, `tradeExit`, `score` ignore it (they test the type), `TRADE_EVENT_TYPES` excludes it. It does enter `journalHistory` (200-row cap) and the phone feed: see F3.

**My own identity replays** (S/review/r17/runs, `idcmp.py`; the same rig as the r1.6 gate: real executor, virtual clock, fake broker, seed 1; r1.6 = commit a6b4f0d archive):

| Day | Runs | Broker calls | Journal rows without `post_exit` / `session_stamp` / `configIdentity` | Trace lines | Scorecard, day, cooldown, trade-state, notify files | Broker end state |
|---|---|---|---|---|---|---|
| a55 (17:00-19:00Z; trade 1 exits 17:20, its window spans trade 2 which opens 17:31 and exits 17:59) | r1.6, r1.7 default (no key), r1.7 `off` | 39 / 39 / 39 identical | 475 / 475 / 475 identical | 81 identical | identical | byte-identical |
| a130 (17:00-19:30Z, four trades, runner, profit lock) | r1.6, r1.7 on, r1.7 off | 36 / 36 / 36 identical | 626 / 626 / 626 identical | 78 identical | identical | byte-identical |
| stop17 (prices end at 17:50Z while a trade is open and a tracker pending) | r1.6, r1.7 on | 14 / 14 identical | 236 / 236 identical | 35 identical | identical | byte-identical |
| a55, **every tracker method throwing and mutating its inputs** (reviewer fault injection: `load`, `save`, `indexJournal`, `onPoll`, `pending` all throw; `indexJournal` adds a field to the event, `onPoll` empties the bar list) | r1.7 | 39 identical | identical apart from the injected field | 81 identical | identical | byte-identical |

The only differences between r1.6 and r1.7 in these runs: the `session_stamp` row, `journal_receipt.configIdentity` (6 rows; it hashes the whole effective CONFIG and CONFIG has a new key; nothing reads it, grep confirms), log lines that carry run paths, timings, the lib list and the executor sha. The fault injection also shows that nothing after the tracker call reads `m1` or the event object back.

**Cases the brief named.**
- Exit during a second open trade: a55 and a130 trade 1 exit at 17:20 inside trade 2's life; decisions identical.
- SIGKILL mid-window and restart: see (2).
- Data feed that stops: stop17. After the last price the bot's poll body stops running on stale data (r1.6 too), so the trackers freeze with their state saved at 17:50:49 and write nothing; when prices return they end with their true `cut`, and a restart gives `cut: "restart"`. Decisions identical. Rows are therefore late, never wrong, when the feed is down.
- Session end: **not replayed through the whole executor** (the rig's data ends 20:47Z, before 12:50 PT). The cut reason `session_end` is covered by the builder's unit test C, which I re-ran (54 of 54), and by reading `step()` (`ptMinuteOfDay` in 12:50-15:00). Open item, record-only.

## (2) Mac-box gate with the server's real settings

1 core (taskset), 961 MB memory cgroup (no swap here, so stricter than the server), Node 18.19.1, `NODE_OPTIONS=--max-old-space-size=1024`, journal 150,084,916 bytes (the server's was 103 MB), real 2000-bar warm-up.

| Run | Result |
|---|---|
| Start, r1.6 vs r1.7, two back-to-back pairs on the 150 MB journal | live loop after 4.21 / 3.67 s (r1.6) and 4.17 / 3.82 s (r1.7); "warm-up OK: 2000 15m bars after 1 s"; peak RSS 324 / 331 vs 332 / 330 MB; cgroup max 307-315 MB. **Start time unchanged.** |
| Busy replay a130 17:00-20:45Z (3 h 45 min of virtual time, four trades) on the 150 MB journal | live loop 4.41 s; peak RSS 336.7 MB; cgroup peak 320 MB of 961, failcnt 0; no OOM; exit 0; **6 trackers pending at the end** (the cap), state file 23,488 bytes |
| Long replay a130 17:00-21:15Z, no big journal | peak RSS 336.8 MB; two rows written |
| Restart soak: 3 SIGKILLs (at a resting entry order, at 17:33Z, at the runner target), journal 150 MB, trackers pending | every start reached the live loop with the full 2000-bar warm-up, no FATAL, peak RSS 318 / 339 / 244 / 311 MB; each start resumed the saved trade ("RESUMED the saved trade after a restart": 3x, 3x, 1x); after kills 2 and 3 the start line said "2 tracker(s) resume from the state file" and the state files show `restarts` 1 then 2. Kill 1 fell between a fill and the tracker's first poll, so there was nothing to resume (nothing lost either). |
| Module stress, 24 h of virtual time, up to 477 trades a day, with and without the old-rule extension | tracker count never above 6; state file at most 27 KB; 60-80 state writes an hour (about 9 KB each); heap flat at about 3.9 MB from hour 1 to hour 12; at most 15 KB per row, journal growth 190 KB to 1.1 MB a day. At more than 6 trades an hour, the oldest tracker is ended with `cut: "cap"` before its 60 minutes (each such row says so). With the real 3 to 13 trades a day this is rare. |

My sampler for per-minute RSS failed to start (a quoting slip), so heap and RSS are the driver's peak figures and the cgroup poller, not a time series. The journal copy of the long runs was too large to keep, so the rows of those runs were not re-read; the row checks below use the a55 / a130 runs.

## (3) Trade witness and the new rows against hand arithmetic

Witness: the same five fills as the r1.6 gate on a55 (entry 3 @ 28640.25, market exit 28657; entry 3 @ 28570, TP1 2 @ 28558.75, stop 1 @ 28548.75); broker end state byte-identical to r1.6's. Not "no trades".

`hand.py` recomputes every field of the a55 row (a short, EARLY_EXIT, fill 28640.5, exit 28659.5) from the replay's own one-minute bars: best and worst from the fill and from the exit, the first touch of +5/+10/+15/+25/+50 from both, the original stop, TP1, TP2 and "back at the fill", and the path bucket by bucket. Result: **every check agrees except one (F2)**; best from the fill 121.75 (row and bars), from the exit 140.75 = 121.75 + 19, TP1 first touched 17:21, +50 from the fill 17:27, stop and TP2 never. The a130 trade 1 row is the same trade and gives the same result. The one miss is F2.
`check_formulas.py` (the builder's) passes 3 of 3 on its hand-built paths; the builder's 54 tests pass on my re-run. Against the bot's own `runner_shadow` on real replay rows the formulas do not agree: F1.

## (4) Strict loader and switch

- Accepted: `"on"`, `"off"`, no key (default on). Refused with the line "must be one of on or off": `"maybe"`, `true`, `1`, `null`, `"ON"`. Unknown key `afterExitRecordX` still refused ("did you mean afterExitRecord?"). **r1.6's loader refuses `afterExitRecord`** ("unknown setting"), so `clear` before a rollback is a real requirement, and the packaged rollback enforces it (G4).
- `set-afterexit.sh` on real rig boots (journalctl = an actual boot of the tree): `show` (no file, no key, key, bad value, older bot), `on`, `off`, `off` twice, `clear`, "no" at the flat question (unchanged), invalid JSON and a JSON list (STOP, unchanged), file missing then `off` (creates it), extra comment key kept, symlinked config (STOP), against an r1.6 executor (`clear` STOPs, `show` says the bot does not know the key). A bad value `"maybe"` can be removed with `clear`. 15 of 15 as the sheet says. Each change leaves a `config-local.json.bak-afterexit-*` file in the bot folder.

## (5) Start-up collectors and the real journal

I fed the real rows (3.2 KB), a worst-case row (15 KB, 720 buckets, every exit reason) and an error row to the three start-up collectors from `lib/journalLines.js`: **plan keeps 0, reconcile keeps 0, tp1 keeps 0**, and `journalShowsTp1` stays false with the rows after an entry row. The builder's finding holds: a `post_exit` line carrying the quoted token `"TP1_FILLED"` *would* be kept by the tp1 collector (tested); the real row has `exitReason: "TP1"` and the key `tp1FilledAt`, neither of which matches. Start time with the 150 MB journal: unchanged (above).

## Findings, ranked by cost

**F1 (medium, for the office): the old-rule formula disagrees with the bot's own shadow on real rows.** `office_formulas.old_runner` starts the old rule at the first bucket where TP1 is touched, including buckets *after* the exit. For a trade that exited before TP1 (EARLY_EXIT, a stop, no-progress) the old and live rules are the same trade: NOTE.md says so and the bot's `runner_shadow` row says `same`. On my a130 replay both rows are early exits with `oldRule.tp1Seen: false`: for the second the shadow says `same`, the formula says a runner stop at +30 points (a payout of $116 that never existed); for the first the shadow says a runner stop at +10 and the formula +20 (minute resolution on a fast synthetic path; expected). Fix, one line in `office_formulas.py`: return `same` unless `oldRule.tp1Seen` is true or `tp1FilledAt` is set; then compare with `runner_shadow` on live rows before the X-03 / X-04 kill rule reads it. Nothing in the bot is affected.

**F2 (low, record quality): a bar is treated as complete by the clock at the time the tracker runs, not at the time the bars were read.** `feedBars` accepts a bar once `bar start + 1 min <= now`; the poll read the bars earlier (the API calls in between take seconds). A bar still forming at read time can be accepted with its partial high and low, and the final bar is then skipped. Proven on the a55 row: the request at 3.1 s before the close of one minute still showed that bar as the newest, the tracker took it, and the row's bucket high is 101.00 against the bar's 101.25 (one of 62 buckets; the other two buckets that differ are a fill minute that starts at first sight and a 0.25 rig rounding). Effect: a best / worst short by the last seconds' move, and a first touch that can be one minute late. Fix for a later record-only build: pass the time the bars were read and use it for the completeness test. Recorded as a lower bound until then (rule 2).

**F3 (low, display): `post_exit` rows reach `journalHistory` and the phone's Signal Journal feed.** `journalHistory` (200 rows) feeds only the journal reconcile queue ("display / journal only" in the code). The phone feed `/signal-journal` takes the last 150 lines that are not `trade_plan` / `trade_manage` / `trade_block`: a `post_exit` row takes one slot and, because it carries a `journalId` and no broker source, pulls that trade's cards in. Tested on the real proxy: 150 cards become 151 cards plus one extra row and the old trade's rows appear. The page keeps only `signal_check` rows. The owner-flag rows avoid this by being written to the file only; the same treatment would remove it (executor change, next build).

**F4 (info): late and cut rows.** After a feed outage or a restart, trackers end late with `cut` set. A gap of less than 10 minutes at the end of the window still gives `windowComplete: true` with `maxGapMs` up to about 580 s (the NOTE tells the office to read `maxGapMs`). A crash in the few milliseconds between the state save and the row append loses that row; it can never write it twice.

**F5 (info, by reading, not tested): an unwritable state file logs "state save failed" every poll (every 20 s)** until it can write; and a stale `postexit-MNQ.json` left after `off` is resumed when the switch goes back to `on` (its trackers end with `restart` / `exitSeenAfterRestart`).

**F6 (info): `configIdentity` changes** in the journal receipts (rule 5).

**F7 (info): sheet and tool wording** that is not a defect: `off` and `on` both leave a key, only `clear` removes it, and all three print the reminder.

## G4 r1.7: install package

Package: `MacBot-edge-r1.7.zip` sha256 0dc37d8acbe02641c7c81a0bfa02c65b501a542a1f280fd4fcd08c402b0d7d3f (prefix 0DC37D8A); sheet `INSTALL-edge-r1.7-PRIVATE.txt`; `G4-R17.md`.

**Verdict for the package: SEND WITH RULES** (rule 3 and rule 4; no installer or rollback defect found).

What I checked and found:
- **Zip = commit.** The zip unpacks to the folder in S/pk17 (identical). Its tree has 64 files plus SHA256SUMS; `sha256sum -c` passes and the list names exactly the shipped files; every shipped file is **byte-identical to the e327426c archive**; executor 9d5bae71, `set-afterexit.sh` 28438b58, `postExit.js` 2dc6b3eb. Against the r1.6 tree only `lib/postExit.js`, `live-executor.js` and `tools/set-afterexit.sh` differ. `FROM-edge-r1.6.sha256` equals the r1.6 tree's sums; the r1.5 / r1.4 / r1.3 lists equal the r1.6 package's. `install-edge.sh` and `rollback-edge.sh` differ from r1.6's only in names, lists, messages and the new key check (diff read line by line); no CR characters; no addresses or names.
- **Packager's G4 reproduced:** from the unzipped zip, 127 PASS, 0 FAIL (4 baselines: install, second install, rollback, `--full`, not flat, not YES, edited files, mixed builds, fail at file 3/20/37/60/62, kill -9 at file 3/20/49/60/62, stopPts, the new key, both lines).
- **Install over the exact r1.6 twice:** first = DONE with stamp 9d5bae71; second = STOP "already on r1.7", nothing changed, one backup.
- **My kill points** (SIGKILL on a stand-in; the installer survives SIGHUP under `nohup`, so that signal was not a valid test): before the stop (bot active, nothing changed, no backup): 8 points; right after the stop, during or just after the backup copy, before the rollback script is copied (5 points: **bot left stopped**, files unchanged, partial backup folder without a rollback script); after the backup, mid-copy (packager's K tests); after all files are in and before the start (new tree complete, **bot stopped**, printed rollback line restores the baseline byte for byte and starts the bot); after the start (new build running). In every case where a rollback script exists, it gives a byte-identical baseline and an active bot. After a kill that left a partial backup, **running the installer again is safe** (bot started, new tree complete, two backup folders): the sheet's "do not run it again" is conservative, not necessary.
- **Rollback:** a state file and a stray `.tmp` left by the bot after the install: plain rollback DONE, byte-for-byte check passes, both files stay (harmless); `--full` puts the folder back exactly and removes them. Config cases toward r1.6: key `off`, odd spacing and line breaks, and a duplicate key all STOP with "nothing changed" and name `set-afterexit.sh clear`; a nested copy of the key, `_afterExitRecord`, the word inside a text value, broken JSON and an empty file are not detected and the rollback proceeds (the first never exists, because r1.7 refuses it; for the rest r1.6 behaves as before). Both a lock line and the new key toward r1.4: STOP naming each, in turn; after both are cleared the rollback gives r1.4 (871d53ca). `--auto` (the installer's own undo) only warns.
- **The packaged `set-afterexit.sh clear` + rollback** was exercised on real boots (section 4); the clear-then-rollback chain by the packager's 14b-d.

Sheet read as a non-engineer. Stage order is right (flat, pre-check, hash, copy, install, optional phone-server restart, check, switch, rollback). Hash prefixes: zip 0DC37D8A and executor 9d5bae71 match the files. The freeze wording is right ("trading logic stays frozen, as you ruled on 11/14, r1.6 untouched for 10 complete TradeDays"). Only `<server>`. Findings:
- **S1 (must fix): line 21 still reads `Checked (independent desks, on the frozen build): @@CHECKED@@`.** Fill it from this file.
- **S2 (should fix, by reading; PowerShell not available here): the quoting of two `grep` lines.** `ssh root@<server> "grep -o '\"stopPts\"[^,}]*' ..."` (step 0, inherited from r1.5 and r1.6) and `ssh root@<server> "grep -c '\"type\":\"post_exit\"' ..."` (step 5, new): in PowerShell a backslash does not escape a double quote, so the double-quoted string ends at the first inner quote and the remote command is not the one meant. Step 5 then most likely prints `0` even when rows exist, which reads as "no rows"; step 0 can print nothing even for a bad value (the installer has its own check, so step 0 is only an early warning). Safer forms (single quotes inside a double-quoted string, no inner double quote): `"grep -o 'stopPts[^,}]*' /opt/mac-bot/config-local.json"` and `"grep -c post_exit /opt/mac-bot/trade-journal-MNQ.jsonl"` (the second also counts `post_exit_error` rows). Re-check on Mac's PowerShell or with the previous sheets' behaviour.
- **S3: "After the first trade has been flat for an hour you will see its row"** is too short: runner trades that reached TP1 are followed up to 240 minutes from the fill or the session close, so the first count can be 0 for hours.
- **S4: the connection-drop paragraph** says to send `ls -d /opt/.edge17-backup-*` but not that the bot may be **stopped** at that moment (five of my kill points leave it stopped). Add: "tell me at once; the bot may not be trading."
- S5: the title says "server address inside" while the text uses `<server>` only; harmless. The "after the install" check line expects `[runner-lock] ... ON`, true for r1.6 and r1.7.

## Not run, so not claimed

Real systemd, real broker, real PowerShell; the packager's rig stands in for systemd. The whole-executor session-end replay (above). The older suites (edge1, edge15, edge16, node tests): the builder's logs show them passing; I re-ran edge17 (54 of 54), the afterexit tool tests (14 of 14), health-alerts (28 of 28) and the real-boot tool tests only.
