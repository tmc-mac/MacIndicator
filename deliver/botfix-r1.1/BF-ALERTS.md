# BF-ALERTS r1: health pushes to Mac's phone (bot-fix desk C)

Notification and journal only. No order, gate, size, stop, target or state-machine decision reads any of it. No new config keys.
Every push goes through the bot's own `notifyPhone` (same ntfy topic and token, same `MacMillionz <SYMBOL>:` title prefix). All pushes are
priority `high` or `urgent`, so the INFO budget and the weekend quiet never hold them back. Each push also writes one journal row
`{ type: 'alert', t, kind, title, body, ...facts }` to the trade journal, and one `[health] ALERT <kind>: ...` log line.
A push that throws or rejects is caught and logged (`[health] push failed (non-fatal)`). The bot carries on.

## Files
- `lib/healthAlerts.js` (new): all the logic. `createHealthAlerts(opts)` returns `noteStart, warmupStart, warmupResult, pass, check, fullStop, alert, once, attachJournal, start, armedText`. It also exports `healthAlert(kind, details)`.
- `health-watchdog.js` (new): the external watchdog, run by cron or a systemd timer.
- `tests/health-alerts-tests.js` (new): 28 unit tests with a fake clock and a fake push sink.
- `live-executor.js`: small hooks, each tagged `bf-alerts r1`:

| line | hook |
|---|---|
| 63 | `require('./lib/healthAlerts')` |
| 1959-1963 | module-level `let health`, `healthAlert(kind, details)`, `HEALTH_HEARTBEAT_FILE` |
| 2047-2051 | creates the instance (before login), counts this start, starts the 30 s timer, logs the ARMED line |
| 2819-2822 | warm-up start / result (failed = rethrown after the push) |
| 3586-3587, 3589 | cap-guard log line de-dupe (same key as the journal row) |
| 4522-4523 | full stop (LIVE) in `watchLiveLifecycle` |
| 5779-5785, 6245, 6250 | journal attached before the loop; one `healthPass` per loop pass |
| 6085 | full stop (PAPER) |

Startup line (fake-broker boot, Node 18.19.1):
`[health] bf-alerts r1: alerts ARMED - not-LIVE 10+ min in trading hours (re-push every 30 min, "LIVE again" once; stall 5 min, data stale 5 min) | restarts 2 in 30 min | warm-up skipped / cut short (< 2000 15m bars) / failed / stopped | full stop (one per trade) | halt / safety healthAlert(kind, details) | heartbeat health-heartbeat-MNQ.json for health-watchdog.js | phone pushes on/off`

## The alerts

### 1. Not LIVE for 10+ min (kind `not-live`)
- **Trigger:** the bot is not in a healthy live loop for 10 continuous minutes inside trading hours. It counts as not live when:
  - it is starting or warming up (until the first good loop pass);
  - it is desynced, or the so1 HALT is latched (text `HALTED: <why>`);
  - broker auth is failing (`token.view().failed`);
  - a loop pass threw;
  - no loop pass completed for 5 min (stalled). The 30 s timer catches this even while the loop hangs in an await;
  - market data is stale: the newest 1m bar is more than 5 min old.
- **Trading hours:** the bot's own calendar (`NP.statusPushWindow`: Sun 15:00 PT to Fri 13:10 PT, excluding 13:10-15:00 PT). The session-close flatten window (`sessionCloseState(...).flattenDue`, which covers configured early closes) also counts as closed. Outside trading hours there is never a push. An open episode closes silently, and the 10-min clock restarts at the open.
- **Text:** `Bot NOT LIVE for <n> min`: "Not trading since HH:MMZ: <reason>. Repeats every 30 min while it lasts; "LIVE again" when it ends. Open positions keep their broker-side stops." Priority urgent.
- **Dedupe:** at most one push per 30 min per episode ("Reminder <n>"). `Bot is LIVE again` is sent once, and only if a not-LIVE push went out. A dip shorter than 10 min sends nothing.
- **Data-stale exemptions:** early-close candidate days (`sessionCloseState(...).candidate`) and an unverified full-closure list (2026-12-25, 2027-01-01).
- **Tests:** warm-up 45 min (push at 10, reminder at 40, one recovery), 9-min desync (nothing), failing passes, Saturday (nothing), Sunday open (first push 15:10), episode past the close (silent), custom hours, stall by timer only, data stale and its recovery, holiday and exempt days quiet.

### External watchdog (`health-watchdog.js`)
- The bot rewrites `health-heartbeat-<SYMBOL>.json` (paper: `-paper`) next to `live-executor.js` every ~30 s. The file holds `{ t, pid, live, reason, since, lastPassAt }`.
- Each run reads it. If the file is 10+ min old or missing, inside trading hours, the watchdog pushes `Bot NOT RUNNING (no heartbeat)` (urgent). It re-pushes every 30 min and sends `Bot heartbeat is back` once.
- It keeps its own state in `health-watchdog-state-<SYMBOL>.json` and always exits 0. It never starts, stops or restarts anything.
- **Tests:** decision sequence (fresh, 9 min, 10 min push, quiet to 39, reminder at 40, recovered once), missing file, outside hours, `main()` without a topic.

**Install notes for Mac (when flat; not installed by us):**
1. Copy `health-watchdog.js` into the bot folder, next to `live-executor.js`. It uses that folder's `lib/notifyPolicy.js`.
2. Give it the same `NTFY_TOPIC` (and `NTFY_TOKEN`, if used) as the bot's service.
3. With systemd, add two units next to the bot's service:
   ```
   # mac-bot-watchdog.service
   [Service]
   Type=oneshot
   EnvironmentFile=<the bot service's EnvironmentFile>
   ExecStart=<node> <bot folder>/health-watchdog.js --dir <bot folder> --symbol MNQ
   # mac-bot-watchdog.timer
   [Timer]
   OnCalendar=*-*-* *:*:00
   AccuracySec=5s
   [Install]
   WantedBy=timers.target
   ```
   Then `systemctl daemon-reload && systemctl enable --now mac-bot-watchdog.timer`.
   With cron instead: `* * * * * . <env file>; <node> <bot folder>/health-watchdog.js --dir <bot folder> --symbol MNQ >> <bot folder>/health-watchdog.log 2>&1`
4. To check it: `node health-watchdog.js --dir <bot folder>` prints one line (`ok: heartbeat 19 s old`).
5. To roll back: disable the timer or remove the cron line. The bot does not need the watchdog.

### 2. Restarts twice in 30 min (kind `restarts`)
- **Trigger:** 3 starts within 30 min (2 restarts). Start times persist in `health-state-<SYMBOL>.json` next to the bot.
- **Text:** `Bot restarted 2 times in 30 min`: "3 starts since HH:MMZ (list). It may be crash-looping; check the log. Open positions keep their broker-side stops."
- **Dedupe:** one push per 30 min. A 4th start inside the window only logs.
- **Tests:** 0/5/12 min (push at the 3rd), 20 (none), 50/55 (none), 58 (push again); starts 31 min apart never push; a corrupt state file does not throw.

### 3. Warm-up skipped, cut short, failed or stopped (kind `warmup`)
- **Cut short:** fewer 15m bars than `historyRefreshLimit` (2000) after the warm-up. Text: `Warm-up cut short`: "read N 15m bars of the 2000 it needs after S s".
- **Failed:** the warm-up threw. `Warm-up FAILED` is pushed, then the error is rethrown as before, so the existing `Executor crashed` push follows.
- **Skipped:** the loop ran a pass with no warm-up reported. `Warm-up SKIPPED`.
- **Stopped:** the previous process ended mid warm-up (the state file still holds its `warmup` mark). This is seen on the next start: `Warm-up STOPPED before it finished`.
- **Dedupe:** one result per process; the stopped mark is cleared when read.
- **Tests:** 2001 bars (none), 600 bars (once), error, skipped (once), stopped then a clean start (nothing).

### 4. Full stop (kind `full-stop`)
- **Trigger, LIVE:** the state machine's `lastExit.kind === 'stop'` with no profit-lock stop (the full protective stop; the FSM sets kind `stop` only from LEG1_OPEN, before TP1) on a filled trade.
- **Trigger, PAPER:** the paper stop hit before TP1.
- **Prices:** exit = the sf1 exit-fill estimate (else the stop price). Gross = the sf1 estimate (else pts x point value x qty). Net = gross - $1.22 x qty (CONFIG.brokerCosts).
- **Text:** `Full stop: LONG 3x -$123.66 net`: "LONG 3x entry 21000.00 -> exit 20980.00 = -20.00 pts/contract, -$123.66 net (est., incl. -$3.66 costs; the broker figure follows in the journal)."
- **Dedupe:** one push per journalId (fallback key: the exit time).
- **Tests:** contents and figures, same key twice, short with gross given.

### 5. Halt and safety events: `healthAlert(kind, details)` (for desk A)
- **Call it** from `live-executor.js` by name: `healthAlert('halt', { title, message, key, ...facts })`. Library code can use `require('./lib/healthAlerts').healthAlert(...)`, which forwards to the same instance.
- **details (all optional):**
  - `title`: default `HALT: <kind>`;
  - `message`: default, the other fields as `k=v`;
  - `key`: dedupe key, default `kind|title`;
  - `dedupeMin`: default 30; 0 means never de-dupe;
  - `priority`: default `urgent`;
  - `tags`: default `rotating_light`;
  - any other field goes into the `alert` journal row.
- **Returns:** `true` if pushed, `false` if de-duplicated, called before setup, or on error. It never throws.
- **Tests:** push, dedupe by key, a 2nd key, after 31 min, `dedupeMin: 0`, before setup.

### 6. `[cap-guard]` log spam
The line is now logged once per setup per 15-min bucket. It uses the journal row's own key, `cg|dir|levelPrice|floor(now/900000)`, which is now one shared variable (`cgKey`). The journal row and the skip decision are unchanged. **Test:** `once()` over 15 min of 20 s polls, plus another setup.

## Verification
- **Unit tests:** `node tests/health-alerts-tests.js` on Node 18.19.1 (the VPS version): **28 passed, 0 failed**. There was no replay and no soak, per Mac.
- **Boot:** one full-process boot on the fake broker (`boot/fake-broker.cjs`), Node 18.19.1, `nice 19`, `--live`, 55 s, log in `botfix/alerts-boot/out.txt`:
  - the ARMED line printed;
  - `Entering live loop` was reached;
  - the heartbeat said `live: true`;
  - no FATAL or ERROR lines.
- **Expected:** `Warm-up cut short` (600 of 2000 bars) fired, and its `alert` journal row was written. The fake broker serves at most 600 bars.
- **Watchdog:** run against that folder, it printed `ok: heartbeat 19 s old`.

## Limits
- Not-LIVE needs the process alive; the watchdog covers a dead or frozen process.
- The watchdog only checks the heartbeat's age. A live process that is not LIVE is the bot's own job.
- The full-stop push comes in addition to the state machine's existing `Stopped out` push (the FSM was not touched). The FSM push could be dropped later if Mac wants one.
- The full-stop figures are the bot's estimate; the broker-confirmed figure arrives later in the journal reconcile.
- An adopted position after a restart pushes only if `watchLiveLifecycle` saw it filled (`trendLife.filled`).
- "Data stale" may push on a full CME holiday that is not in the small unverified list, or on an unconfigured early close. The reason text says so plainly.
- An interactive start (TTY) waiting more than 10 min at the "Type LIVE" prompt counts as not LIVE (`starting up`). Cancelled starts count toward restarts.
- The not-LIVE episode does not survive a restart: each start restarts the 10-min clock. Crash loops are covered by the restart alert and the watchdog.
- New runtime files in the bot folder: `health-state-<SYM>.json`, `health-heartbeat-<SYM>.json` (`-paper` for paper), and the watchdog's `health-watchdog-state-<SYM>.json`.
