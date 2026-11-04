# TIDE Stage 2a: LIVE build (MacLive, 11/04)

This package puts the new TIDE model **inside the bot as a trading path**. It installs with TIDE **off**, so after the install the bot trades exactly like your current one. TIDE starts placing real orders only after you type YES in `set-tide.sh live`.

It goes on top of **either**:
- lv1 r13.3.7 (executor 7245b251), or
- the TIDE Stage 1 shadow build (executor b6eaa9c2).

`go.sh` checks which one you run and refuses anything else.

**Update from TIDE Stage 2a r1 (executor bddbc56f), r1.1 (executor 1e85324b) or r1.1a (executor c0241a20):** this is a drop-in. Run the same `bash go.sh` when flat. The bot restarts once, and your config-local.json (tide.mode live included) is kept. `rollback.sh` puts back the build you had.

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
   - `[tide] shas structure=2a2249f17efc202c money=15c7f68819bd7f5b wire=... orders=... live=...`
   - `[tide] rebuilt from N bars in X s`, then `[tide] LIVE: the warm-up is done - TIDE signals now place real orders.` This normally takes about 30 s; on a busy machine it can take several minutes. **The first live TIDE trade is possible only after the `[tide] LIVE` line.** A signal that fires during the rebuild is still judged when the rebuild finishes; it is taken only if every gate passes then and it is at most 10 min old.
   - `[sizing] off` is expected. It is the old Stage 1 flag; TIDE live sizes from the `[money] config` line.

Going back:
- `bash tools/set-tide.sh shadow`: journal and phone only, never orders.
- `bash tools/set-tide.sh off`: the bot trades as before.
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
