# TIDE Stage 2a r1.6.1 - INSTALL (over r1.5.6; an r1.6 install or r1.5.5 accepted as the base too)

STATUS AT SEAL (r1.6.1, MacTrend-4, 11/05): all five suites green (net-retry, tide-board, tide2-exec, tide-live, trend-lane incl. the r1.6.1 witnesses w1-w5; counts in CHANGES-r1.6.md "r1.6.1"); the reviewer's r1.6 findings fixed (break trigger, no-chase, $400 binds multi-lot, rollback guard). Still to pass before Mac installs: the reviewer desk's Mac-box run / restart soak / trade witness / install-path run (CLAUDE.md ship gate).

What changes: the trend lane (lib/trendLane.js, new), sizing cap $400 / 8 MNQ, grade gate aligned-pass, journal reload + tide.day / tide.warm, realized P&L on live_end, broker-rejection rows. Files: lib/journalMeta.js lib/moneyRule.js lib/structure.js lib/tideLive.js lib/tideOrders.js lib/tideRebuild.js lib/tideWire.js lib/trendLane.js live-executor.js 
Install (Mac, when flat): unpack, `bash go.sh` (verifies SHA256SUMS.txt, then that the installed bot is r1.5.6 - FROM-r156.sha256 - or r1.5.5, stages, swaps, restarts, checks the startup line; undoes itself on failure). Run go.sh twice from a copy: the second run says "Already installed".
Switches (tools/set-tide.sh, each restarts the bot when flat and checks the startup line):
- trend=on | trend=off      -> tide.trendLane (on = key removed = shipped ON; off = {"enabled": false} = r1.5.6 level setups only)
- grade=aligned-pass | grade=strict -> tide.gradeGate (aligned-pass shipped; strict = r1.5.6 grading)
- sizecap=N (1..30)         -> tide.sizeCap (8 shipped)
- the r1.5.x switches unchanged: live | shadow | off | clear | climax= | stale= | lanes= | htf=
Startup line (shipped defaults): grade gate: aligned-pass (a WITH-HTF level setup is not refused by the grade gates; the failed gates ride on the signal as gradeTags) · size: $400 max · cap 8 (tide.sizeCap; qty = clamp(floor($400 / risk), 1, 8); a stop over 200 pts is skipped: needed a better entry) · trend lane ON (prior-4H dir · 30M harmony · 5M trigger at any level · 30M-wick stop · 2/h 6/day · climax defense-confirms; retestTol 6, defense wick 4, stop 2 ticks) · journal reload ON
Rollback: `bash rollback.sh` restores the files go.sh backed up (r1.5.6, or r1.6 when that was the base). Roll back only when FLAT: the r1.5.6 driver ignores an r1.6 state file, so an open position would NOT be re-owned. Before rolling back to r1.5.6 run `bash tools/set-tide.sh trend=on`, then `grade=aligned-pass`, then `sizecap=default` (one switch per call; they remove tide.trendLane / tide.gradeGate / tide.sizeCap) - rollback.sh STOPS while any of the three is still in config-local.json, because the r1.5.6 bot refuses unknown keys.

---- r1.5.6 INSTALL.md follows (unchanged) ----
# TIDE Stage 2a: LIVE build r1.5.6 (MacLive-5, 11/04)

**r1.5.6 = r1.5.5 + higher-timeframe context (Mac 11/04 10:20: "knowing if we're going with or against the high time frame trend").** The engine now reads, from its own 4H bars, the PRIOR 4H candle (direction, higher high / lower low vs the 4H before it), the CURRENT 4H (price vs the 4H open, the existing control) and the CME day (price vs the 15:00 PT day open), and votes them into one `htf.dir` (+1 / -1 / 0: majority of prior-4H direction, hh/ll, daily; a tie goes to price vs the current 4H open, 0 only when that is level too). Every setup and signal is tagged `htf: with | against | neutral` (at arm time, re-read at the entry) on the setup_arm, signal and grade_no_trade journal rows, the `TIDE SHADOW ...` push line (`WITH HTF` / `AGAINST HTF`) and the phone board (`tide.board.htf`). New setting `tide.htfAgainst`: **shipped `"tag"` = display and journal only, no trading change** (the r1.5.5 trades are identical); `"half"` = an against-HTF signal is sized at half the flat dollars (1 MNQ minimum unchanged); `"skip"` = against-HTF entries are refused with `GRADE_NO_TRADE why HTF_AGAINST`. Set it with `bash tools/set-tide.sh htf=tag|half|skip` (when flat; one restart). `go.sh` installs over r1.5.5 (or any earlier build below); `rollback.sh` refuses while `tide.htfAgainst` is in config-local.json (run `htf=tag` first). Mac decides half / skip from the with / against split of the replay, not before.

(r1.5.4 / r1.5.5 text follows; everything in it still holds.)

This package puts the new TIDE model **inside the bot as a trading path**. It installs with TIDE **off**, so after the install the bot trades exactly like your current one. TIDE starts placing real orders only after you type YES in `set-tide.sh live`.

It goes on top of **either**:
- lv1 r13.3.7 (executor 7245b251), or
- the TIDE Stage 1 shadow build (executor b6eaa9c2).

`go.sh` checks which one you run and refuses anything else.

**Update from TIDE Stage 2a r1 (executor bddbc56f), r1.1 (executor 1e85324b) or r1.1a (executor c0241a20):** this is a drop-in. Run the same `bash go.sh` when flat. The bot restarts once, and your config-local.json (tide.mode live included) is kept. `rollback.sh` puts back the build you had.

**New in r1.5.4 (Mac 11/04: the 07:40 4H-Open short and the 06:27 London-ORH long TIDE refused). SHIP GATE SKIPPED at Mac's order ("I want the fixed strategy as quickly as possible"): unit suites only (structure 191, tide2-exec 138, tide-live 125, tide-board 21, all passing); NO 6-day replay, NO Mac-box run, NO restart soak, NO trade witness. Engine `tide-structure-r3.4`.**
- Drop-in from r1.5.3 (executor eeff40e0), r1.5.2, r1.5.1, r1.5, r1.4 and earlier: the same `bash go.sh` when flat. One restart; config-local.json is kept.
- `tide.laneAccept` (ships ON): under a TRAP 4H control, an accepted-break setup the control's way passes gate `laneTrigger` through the failed-break lane with the kind requirement dropped (its displacement body >= 50% / range >= 1x must still hold). The 07:40 case.
- `tide.controlFree` (ships ON): an accepted-break setup is no longer refused by gate `control4h` when the 4H control opposes it or there is none. Failed-break setups keep the requirement. The 06:27 case.
- `tide.staleR` now ships **2** (rule 18 ON): a far, un-retested trap gives way to a nearer same-way acceptance. `stale=off` writes 0.
- `tide.nearestWins` and `tide.ltfOpens` (30m / 15m Open zones) are in the build but ship **OFF**: with them on the engine's own suite loses the 11/04 witness trade (a nearer armed acceptance makes the trap skip; a 15m-Open acceptance replaces the Asia Low one). They need a replay before anyone turns them on; set-tide.sh has no switch for them yet (a hand edit of config-local.json would).
- The startup line prints `rule 18 ON (...) · nearest wins OFF · 15m/30m opens OFF · lanes: accept-under-trap ON, control-free ON`.
- `bash tools/set-tide.sh lanes=off` writes staleR 0 + the four switches false = the bot picks setups exactly as r1.5.3 (checked: the structure suite's 181 r3.3 cases run with the switches off and pass unchanged). `lanes=on` removes the keys (the shipped r1.5.4 behaviour).
- Before `rollback.sh`: run `bash tools/set-tide.sh lanes=on` first if you used `lanes=off` or `stale=off` (rollback.sh stops and tells you); to r1.5.2 or older also `stale=on` (removes tide.staleR), and to r1.5 or older `climax=on`.

**New in r1.5.3 (one more switch; trading unchanged with the shipped settings):**
- Drop-in from r1.5.2, r1.5.1 (executor f00e9720), r1.5 (d5eb1f84), r1.4 and earlier: the same `bash go.sh` when flat. One restart; config-local.json is kept (tide.climaxGate included).
- Rule 18 is in the build but ships **OFF** (`tide.staleR` 0): trading is exactly r1.5.2's (checked trade for trade on the 10/27-11/04 replay). `bash tools/set-tide.sh stale=on` turns it on (a far, un-retested trap gives way to a nearer acceptance the same way); `stale=off` removes it again. On the 10/27-11/04 replay it swaps one trade for $180 less.
- The startup line `[tide] new model ...` also says `rule 18 OFF (tide.staleR 0 ...)` or `rule 18 ON (...)`. The engine is `tide-structure-r3.3`.
- A stop / TP whose answer was lost is re-sent only when the broker position is the size it protects (after a 0.3 s wait for the broker's order list); otherwise the bot reconciles first.
- If the broker reads before an entry took more than 3 s, the entry gates are checked again (e.g. a time block that began meanwhile refuses it).
- Before `rollback.sh`: if you turned rule 18 on, run `bash tools/set-tide.sh stale=off` first; to r1.5 or older also `climax=on`.

**New in r1.5.2 (fix for the 02:13 PT long lost to "broker state unreadable (fetch failed)"):**
- Drop-in from r1.5.1 (executor f00e9720), r1.5 (d5eb1f84), r1.4 and earlier: the same `bash go.sh` when flat. One restart; config-local.json is kept.
- Before a TIDE entry the broker check (position + working orders) is tried up to 4 times (at 0, 0.4, 1.2 and 2.5 s, each with its own 3 s limit). The signal is refused only when all 4 fail; then an URGENT push names the signal, the side, the level and "broker unreadable after 4 tries".
- The same retry covers the reads behind the stop / TP1 / TP2 and the reconcile. If they still fail while contracts are open, an URGENT push (at most every 5 min), never silent.
- The cause in your logs: stale keep-alive connections ("fetch failed", UND_ERR_SOCKET / ECONNRESET: the far end had closed an idle connection and Node reused it). Now every broker READ (position, orders, trades, bars, the 15m-close reads too) that hits one is retried at once on a fresh connection, then after 0.4 / 1.2 / 2.5 s; and idle connections are dropped after 2 s, before the far end closes them.
- Orders are never re-sent blindly. If a stop / TP answer is lost on a dropped connection, the bot reads the open orders: if the order is there it is used; if not, the same order is sent once more.
- Every "fetch failed" in the log now names the call and the cause, e.g. `TypeError: fetch failed [POST localhost:8787/api/Position/searchOpen: ECONNRESET read ECONNRESET]`.
- Trading is otherwise exactly r1.5.1's (checked trade for trade on the 10/27-11/04 replay).

**New in r1.5.1 (one switch, nothing else changes):**
- Drop-in from r1.5 (executor d5eb1f84), r1.4 and earlier: the same `bash go.sh` when flat. One restart; config-local.json is kept.
- A switch for the engine's CLIMAX gate (`tide.climaxGate`). It ships **ON**: the bot behaves exactly as r1.5.
- With the gate ON, after a climax bar TIDE takes no with-trend entry until structure confirms. With it OFF that block is skipped; every other rule stays.
- Replay 10/27-11/04 (flat $400, session close 12:55 / 13:05 PT applied, warm-up rebuild working): gate ON 32 trades, +$5,979, 1 full stop, max drawdown -$397; gate OFF 33 trades, +$6,210, 1 full stop, max drawdown -$397. The one extra trade is 11/03 06:09 PT LONG at Asia High (+$232); every other trade is the same.
- Turn it off: `bash tools/set-tide.sh climax=off`. Back on: `bash tools/set-tide.sh climax=on`. Only when flat; type YES; one restart.
- The startup line `[tide] new model ...` now says `climax gate ON` or `climax gate OFF`.
- Before `rollback.sh` to r1.5 or older: run `bash tools/set-tide.sh climax=on` first (older builds do not know the setting; rollback.sh stops and tells you).

**New in r1.5 (memory, for the 1-core / 1 GB VPS):**
- The warm-up rebuild's worker heap is capped (64 MB old / 2 MB young).
- If the process RSS grows more than min(300, available memory plus swap minus 150) MB above its level at the rebuild start (checked every 250 ms), or the worker exits or runs out of memory, the rebuild stops and TIDE goes live on the PRE_RESTART fallback, with a push. It never kills the bot.
- Below 400 MB of available memory plus free swap the rebuild is skipped, with one push.
- RSS is logged at the rebuild start and every 60 s.
- Health alerts (HIGH pushes, once per event): TIDE not live 10 min after a start, and 2 restarts within 30 min.
- The `[tide] shas` startup line prints the Node version.
- Signal rows carry `at` (the signal's own bar time); rows written by the rebuild carry `barT`.
- The phone board allows 25 ms per build and keeps the last good board (`stale:true`) on an overrun.

**New in r1.4 (display only; ships with Levels PRO v2.8):** the phone board now follows the engine's own rules.
- MID_RANGE tests the setup level against the engine's 1H mid band.
- The reference stop uses the engine's stop rule: the sweep extreme or the 1H wick, plus the 2-point buffer.
- ZONE_USED and RETEST_NOT_FIRST replace FIRST_RETEST_USED.
- Levels can show the `rejected` state.
- The 8 KB cap is counted in UTF-8 bytes.
- Drop-in from r1.3 (executor ae013d7f) and earlier.

**New in r1.3:** the phone snapshot's `tide.board` shows how TIDE sees the levels (MacUI-N Addendum r1.3). It is built from the engine's memory, with no new request.
- For each level: its state, side, setup and lane, the plan for an armed setup (`plan:true`, or the real numbers once entered, `plan:false`), and `blockedBy` codes taken from the bot's own gates.
- At most 30 levels and 8 KB. It is absent with tide off.
- Drop-in from r1.2 (executor e4470ad2) or r1.1a (c0241a20).

**New in r1.2:**
- It includes the r1.1a warm-up read ladder.
- **Warm-up rebuild watchdog:** progress is logged every minute (`[tide] rebuild progress: n of N minutes`). The rebuild runs in a low-priority worker thread (nice 19), so the bot's polls and order management never wait behind it. If it has not finished in 15 min, the worker is stopped and the phone gets "TIDE warm-up rebuild timed out - using the PRE_RESTART fallback". TIDE then goes live without the rebuilt bias.
- **A 1m read that fails on a stale connection** (`UND_ERR_SOCKET` / `ECONNRESET`) is retried once at once. An hourly `[tide] hourly: 1m reads ...` line counts the retries.
- **The phone snapshot file is written atomically**, so the phone never reads an empty file.
- **Also new: the phone snapshot carries a `tide` block (mode, rules, sizing, today's TIDE journal rows; in live also the position from the broker fills: entry price and fill time, the acked stop, TP1 / TP2 and their done flags, open $; today's closed TIDE trades with their result; alerts). With tide off the snapshot is unchanged.

## Steps (when FLAT: no MNQ position and no working MNQ orders in TopstepX)
1. Upload the folder to the bot server and `cd` into it.
2. `bash go.sh`
   - It checks the upload (SHA256SUMS), the installed bot and your config-local.json, then asks you to type YES.
   - It stops the bot, makes a verified backup of the 8 files, installs, starts and checks the startup lines. **The bot restarts once.**
   - Any failure after the stop puts the old files back and restarts the old bot on its own.
3. `bash tools/set-tide.sh live`
   - Type YES twice: once for "flat", once for "live". The bot restarts once more.
   - The script checks that the bot printed `[config-local]   tide.mode = "live"`, the `[tide] new model ... LIVE (Stage 2a ...` line and the `[tide] mode LIVE:` line. Anything else puts config-local.json back and restarts.
4. Check the startup log. It must show these lines:
   - `[tide] mode LIVE: tide-live-r1.1 + planner tideOrders-r1.2 ...; take1 ceiling $400; TIDE entry blocks ON (15:00-17:00, 06:30-07:10 PT) (news wait + 12:55 PT always); open wait 30 min; old levels path OFF (manage-only; its signal pushes silenced); warm-up bias rebuild ON (lib/tideRebuild.js)`
   - `[money] config money-r4.1: mode flat; flatDollars 400; noFit take1; nearFloor off; ...`
   - `[tide] shas structure=7b6e8773fe9d8ca5 money=15c7f68819bd7f5b wire=... orders=... live=...`
   - `[tide] rebuilt from N bars in X s`, then `[tide] LIVE: the warm-up is done - TIDE signals now place real orders.` This normally takes about 30 s; on a busy machine it can take several minutes. **The first live TIDE trade is possible only after the `[tide] LIVE` line.** A signal that fires during the rebuild is still judged when the rebuild finishes; it is taken only if every gate passes then and it is at most 10 min old.
   - `[sizing] off` is expected. It is the old Stage 1 flag; TIDE live sizes from the `[money] config` line.

Going back:
- `bash tools/set-tide.sh shadow`: journal and phone only, never orders.
- `bash tools/set-tide.sh off`: the bot trades as before.
- `bash tools/set-tide.sh climax=off` / `climax=on`: the CLIMAX gate switch (r1.5.1); the TIDE mode is kept.
- `bash tools/set-tide.sh stale=on` / `stale=off`: the rule 18 switch (r1.5.3, shipped off); the TIDE mode is kept.
- `bash rollback.sh`: puts back the exact files go.sh replaced. Switch TIDE off first; the script tells you if a setting must go.

## What TIDE live does
- **One position account-wide.**
  - TIDE enters only when the broker shows no MNQ position and no working MNQ order, and the old path holds nothing.
  - While TIDE is live, the **old levels path takes no new entries** (`tide.oldPathEntries` false). It still manages anything it already has open. Its trade-signal pushes (Signal, Control, Crossed, Reclaim, "Entry refused by the broker guard") go to the log and journal only, so the phone reads as one model: TIDE. Safety and system pushes are unchanged.
  - While a TIDE position is open, every old-path entry and adoption is refused.
- **Orders for each trade:**
  - the entry;
  - one protective stop at the structural stop, sized to the filled quantity, placed right after the fill;
  - TP1 for 2/3 of the position, then the stop to break-even + 1 tick, then TP2 for the rest. A 1-lot has no TP1 order: when the TP1 price trades, the stop goes to break-even + 1 tick;
  - the R-ladder / climax tightening.
  - **Stops only tighten, never widen.**
- **No pyramid add and no resting half** in this stage.
- **Sizing (50K combine, your rulings):**
  - flat **$400** per trade: contracts = floor($400 / (stop points x $2)), at most 30. Topstep's own 50K contract cap also applies at the broker.
  - If even 1 MNQ does not fit $400, the trade is skipped and journaled / pushed as `GRADE_NO_FIT_CEILING` (take1 ceiling $400).
  - The stop is never moved to fit.
  - The near-floor guard is **off** to start. `bash tools/set-tide-money.sh nearfloor=on` turns it on: within $1,000 of the trailing floor the size drops to $200. For that guard, `accountStartingBalance` and `accountMllLimit` in your config-local.json must match the 50K (50000 / 2000).
  - Change sizes with `bash tools/set-tide-money.sh flat=<dollars> take1max=<dollars> nofit=skip|take1 nearfloor=on|off`.
  - If your config-local.json already has a `money` section from Stage 1 (for example flatDollars 450), it overrides these defaults: set it with the line above.
- **Timing (TIDE's own):**
  - TIDE has its OWN entry blocks (`tide.useTimeBlocks` true): no new TIDE entry 15:00-17:00 PT and 06:30-07:10 PT, whatever the old path's block settings are (the morning hold does not block TIDE entries);
  - a 30-min open wait;
  - the news wait;
  - no TIDE entry from 12:55 PT;
  - at 13:05 PT the TIDE position is closed **once**: stop cancel verified, then market, then a confirming read. Early-close dates come from the bot's session settings.
  - A TIDE position stays open through the morning hold and the daily floor (no timed exits and no daily loss limit for TIDE). A journal line says so.
- **Safety:**
  - A position with no working stop (the stop was rejected twice, or cancelled by hand in TopstepX) is closed at market at once.
  - The phone **Flatten** button closes a TIDE position through the same verified flatten.
  - After a restart, the saved TIDE position is reconciled: no duplicate orders, the stop kept.
- **Phone (inside the bot's daily INFO budget):** every in-trade TIDE event is pushed: the taken signal, each fill, the stop placed (with entry, stop, TP1, TP2 and grade), TP1 and the move to break-even, each ladder / climax stop move, TP2, and the EXIT with $ and R. That is about 8-10 pushes per trade. Blocked or skipped TIDE signals (TIME_BLOCK, NO_FIT_CEILING, SESSION_CLOSE) are journal only. Real safety alerts (no stop, naked flatten, oversized stop, reversal, flatten failed) are URGENT and always sent.

## Files
`bot/live-executor.js` and `bot/lib/{journalMeta,tideWire,moneyRule,structure,tideOrders,tideLive,tideRebuild}.js`, plus the tests in `bot/tests/`. The SHA256SUMS file lists every file. The bot also writes a new state file, `tide-live-state-MNQ.json` (the open TIDE position), in the bot folder.
