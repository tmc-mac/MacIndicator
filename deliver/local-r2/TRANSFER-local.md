# TRANSFER-local: steps and file list (local r2)

The commands Mac types are in `INSTALL-local-DRAFT.txt`, stage C (transfer) and stage G (undo). This file is the same thing for a reviewer: what each step does, and what travels, to be confirmed against the server inventory of 2026-11-12.

## Steps

| # | Where | Command | What it does | Refuses when |
|---|---|---|---|---|
| a1 | server | `vps-handoff.sh status` | read-only: one line per `mac-bot*` unit, `VPS-TIME`, `VPS-STATE: OFF/RUNNING` | - |
| a2 | server | `vps-handoff.sh stop` | flat check (`flatcheck.sh`), YES, remembers each unit's state, stops and disables timers, then `mac-bot-live`, then the other services; comments out cron lines naming mac-bot (none today) | not flat; answer not YES |
| b1 | server | `vps-handoff.sh pack` | sha256 list of every file in `/opt/mac-bot`; one `tar.gz` of the folder plus `meta/` (unit files, drop-ins, env file, facts, the list); re-checks the list after packing; writes the bundle's own `.sha256`; mode 600 | any unit active or enabled; config, journal or code missing; a file changed while packing; disk |
| b2 | PC | `scp` x2, `Get-FileHash` | bundle and `.sha256` to `Downloads\MacLocal-r1`; first 8 characters compared with the server's `BUNDLE` line | - |
| b3 | PC (WSL) | `mac-local restore ./maclocal-bundle.tgz` | bundle sha256 = `.sha256` file; only `meta/` and `botdir/` paths allowed; unpack to a staging folder; `sha256sum -c` of every file against the server's list, no extra file; `sha256sum -c EXPECT.sha256` (edge r1.6 tree + page 99ec1630); config is valid JSON; journal present; then moves the folder to `/opt/mac-bot`, removes the stale files listed below, places env file (600), units, drop-ins, the start guard, the watchdog timer, the clock timer; sets the server's time zone. Enables and starts no bot unit | any check above; a bot already in `/opt/mac-bot`; local units running; Node not 18.19.1; systemd not running |
| e0 | PC | `status` over ssh piped into `mac-local vps-proof` | records that the server is OFF and DISABLED (see DESIGN, interlock) | anything active or enabled; stale or missing time stamp |
| c | PC (WSL) | `mac-local start` | all `check base` and `check bot` lines must pass; proof at most 10 min old; server port must not answer; YES; enables what was enabled on the server, starts the phone server, the bot and the timers | any STOP line; no proof |
| d | PC (WSL) | (inside `start`, and `mac-local check`) | session stamp with executor sha8 of the file on disk; `Entering live loop`; `warm-up OK: 2000 15m bars`; heartbeat fresh and LIVE; page served = file on disk (99ec1630 in the sheet); 401 without the key from a non-loopback address | on any miss `start` stops and disables the local bot again |
| e | both | stage G: `mac-local stop`, `Disable-ScheduledTask`, `mac-local status` piped into `vps-handoff.sh local-proof`, `vps-handoff.sh resume` | the server gets back exactly the units that a2 switched off | PC not proven OFF and DISABLED |

Hard rule: never both running on one account. Steps e0 and e are the checks; the systemd pre-start guard repeats a weaker check at every start.

## What travels

Everything in `/opt/mac-bot` travels as one tar stream (322 MB on the server), each file checked by sha256 on arrival. Nothing is selected by hand, so nothing can be forgotten. Mapped to the inventory:

| Group | Files (inventory names) | Handling |
|---|---|---|
| Build | `live-executor.js`, `tmc-proxy.js`, `health-watchdog.js`, `lib/**`, `tools/**` | copied; also checked against `EXPECT.sha256` (62 tree files + `mobile.html`) |
| Mac's settings | `config-local.json` (850 B) | copied; sha256; must parse as JSON; never edited |
| Journal | `trade-journal-MNQ.jsonl` (103,246,385 B on 11/12), `trade-replays-MNQ.jsonl` | copied after the stop; sha256 |
| State | `trade-state-MNQ.json`, `tide-live-state-MNQ.json`, `tide-starts-MNQ.json`, `cooldown-state-MNQ.json`, `day-state-MNQ.json`, `pause-state-MNQ.json`, `notify-budget-MNQ.json`, `health-state-MNQ.json`, `scorecard-MNQ.json`, `stop-cap-owned-MNQ.json` if present | copied; sha256 |
| Caches and evidence | `bias-snapshot*.json`, `vix-cache.json`, `news-calendar.json`, `levels-journal-*`, `levels-minute-*`, `po3-journal-*`, `sr-areas-*`, `live-executor-MNQ-LIVE-*.log` | copied |
| Pages | `mobile.html` (2.2.2, 99ec1630), `terminal.html`, `prop-farm.html` | copied |
| Installer leftovers | `flatcheck.sh`, `bot/`, `backups/`, `baseline-*`, `*.bak*`, `.last-backup-*`, MGC files | copied (rollback pointers inside the folder keep working) |
| Outside the folder | `/etc/mac-bot.env` (names: PTX_USER, PTX_KEY, PTX_CONFIRM_LIVE, PROXY_SECRET, PTX_ACCOUNT_ID, NTFY_TOPIC) | copied to the same path, mode 600; `check` needs PTX_USER, PTX_KEY, PTX_CONFIRM_LIVE, PROXY_SECRET, NTFY_TOPIC by name |
| Units | `mac-bot-live.service` (+ `account.conf`, `heap.conf`), `mac-bot-proxy.service` (+ `heap.conf`), `mac-bot-live-mgc.service` (stays disabled), `mac-bot-weekend-start/stop.service` + `.timer` | byte for byte to `/etc/systemd/system`; enabled only at `start`, each as it was on the server |

Removed on arrival (after the sha check, listed in the output and in `/opt/mac-local/meta/REMOVED-ON-ARRIVAL.txt`): `flatten-request-*.json`, `pause-request-*.json`, files inside `entry-cancel-*/` and `owner-flag-*/`, `health-heartbeat-*.json`, `*.tmp`, `*.tmp-*`. Reason: a copied phone request could act, and a copied heartbeat looks fresh for 10 minutes.

Does not travel: installer backup folders next to the bot folder (`/opt/.edge16-backup-*`). Rolling the build back to an older edge build therefore stays a server-side option until the next install on the PC makes its own backup.

Added on the PC, not from the server: `mac-bot-live.service.d/10-maclocal-guard.conf`, `mac-bot-watchdog.service/.timer` (BF-ALERTS.md form), `mac-local-tick.service/.timer`, `/usr/local/sbin/mac-local`, `/opt/mac-local/`, `/etc/mac-bot-local.conf` (server address and optional alarm URL, mode 600).

## To confirm against the inventory before the run
1. `User=` in the two units is hidden in the inventory. If it is not root, `restore` creates that user and gives it the folder; say which it is.
2. The bundle will be well under 322 MB only if the journal compresses; `pack` needs free disk of folder size + 200 MB (server has 11 GB free).
3. `EXPECT.sha256` names edge r1.6 (the 62 files of `deliver/edge-r1.6/tree/SHA256SUMS`, executor 26089560) and page 2.2.2 (99ec1630); the reviewer confirmed it against the repo list. If another build or page is installed on the server before the move, `restore` refuses and the file must be regenerated first.
4. r2 adds on the PC only: `mac-bot-weekend-stop.timer.d/10-maclocal-nocatchup.conf` (`Persistent=false`); the added watchdog runs at second 30 as the bot unit's `User=`.
