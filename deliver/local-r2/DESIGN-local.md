# DESIGN-local: the bot, the phone server and the phone page on Mac's own laptop (local r2)

Builder desk MacLocal, 2026-11-12. r2 = r1 + the reviewer's patch (gate verdict SEND WITH RULES) + Mac's three rulings. **Nothing here has run on Windows, WSL or real systemd; the stage checks in the sheet are the proof.** What was run is in `TEST-local.md`.

## The layout in one paragraph
The laptop runs Ubuntu 24.04 under WSL2 with systemd. The bot folder is the same path as on the server, `/opt/mac-bot`, and it arrives as one verified copy of the server's whole folder. The server's own unit files, drop-ins and env file are copied byte for byte. So `mac-bot-live`, `mac-bot-proxy`, the two weekend timers, `journalctl -u mac-bot-live`, every `install-edge.sh` and every `set-*.sh` behave as they do today; only the front of each command changes from `ssh root@<server> "..."` to `wsl -d Ubuntu-24.04 -u root -- ...`. No bot code changes.

## Choices and reasons

| Topic | Choice | Reason |
|---|---|---|
| Linux | WSL2, Ubuntu 24.04, `[boot] systemd=true` in `/etc/wsl.conf` | Already installed on Mac's PC. The server inventory shows plain systemd units; they run unchanged. |
| Path and units | Same `/opt/mac-bot`; units, drop-ins (`heap.conf`, `account.conf`) and `/etc/mac-bot.env` copied as they are | The units exist only on the server (no installer in the repo creates them). Copying keeps `Requires=mac-bot-proxy.service` (a phone-server restart restarts the bot), `User=`, and the heap setting. |
| Node | Exactly v18.19.1. First choice: Ubuntu 24.04's own `nodejs` package (version 18.19.1+dfsg-6ubuntu5, at `/usr/bin/node`, the path the units start), held. Fallback: the nodejs.org build with its sha256 pinned in the script. Any other version = STOP | The gates run on 18.19.1; the server has 18.19.1. |
| Heap | Unchanged: `NODE_OPTIONS=--max-old-space-size=1024` from `heap.conf` on both services, as the server runs today | Changing it would be a change to the running setup. With the 98.7 MB journal the bot peaked at 325 MB at start in my boot. |
| Memory cap | `.wslconfig`: `memory=3GB`, `swap=2GB` | Both services at their 1024 MB limit plus Ubuntu fit in 3 GB without swap; the server had 961 MB + 2 GB swap for the same limits. The laptop has 7,863 MB: Windows keeps about 4.8 GB. Default (50%) would take 3.9 GB. The value is read back with `free -m` because a typo in `.wslconfig` fails silently. |
| Keeping WSL up | Three layers: `[general] instanceIdleTimeout=-1`; a Task Scheduler task at logon that holds `wsl.exe ... sleep infinity` open; a 10-minute closed-window test in the sheet | Microsoft: "systemd services will NOT keep your WSL instance alive". Which WSL version honours the key is not verified, so the open handle is the part that is relied on. |
| Start after a restart | At logon, with automatic sign-in (Mac's ruling 11/12, stage E5: Sysinternals Autologon, password kept as an LSA secret, optional untested lock-after-sign-in task). A restart recovers in about 3 minutes **only if** automatic sign-in, the logon task, the keep-alive and the start guard all fire; if one fails the bot is down and silent | A boot-time start before sign-in is not proven on Windows 11 Home. Cost: whoever opens the laptop is in the account, and an administrator of the laptop can read the stored password back. A feature update or a password change can switch it off, so the restart test is repeated after both. |
| Power | AC: sleep never, hibernate off, lid / power button / sleep button = do nothing. Battery: untouched. Rule: plugged in | On battery "never sleep" only moves the failure to an empty battery. Modern Standby is detected with `powercfg /a`; Start > Sleep still freezes the bot. |
| Windows Update | Active hours (18 h) + manual update on Saturday | Home cannot switch updates off. |
| Time zone | Linux zone set to the server's (`Etc/UTC`), `[time] useWindowsTimezone=false` | The JS names its zone in every time format (22 Los Angeles, 7 Chicago, 2 New York; no local-time call) and the weekend timers name `America/Los_Angeles`, so both are zone-independent; my boots under UTC, Tokyo and Los Angeles agree (see TEST). UTC is kept anyway so logs read as before. `check` STOPs on another zone. |
| Clock | (1) every bot start: `hwclock -s`, then refuse the start if Linux is more than 5 s off the PC clock; (2) every minute a timer compares the two, corrects above 2 s and pushes "PC clock corrected"; (3) `check` compares with an internet `Date:` header, STOP above 3 s | Drift after sleep is reported, not documented. Sleep is prevented first; this is the second line. |
| Two bots | See next section | The code has no lock of its own. |
| Phone | Default: no phone page; pushes as before; page on the PC at `http://localhost:8787/mobile.html`. Option: same Wi-Fi. Tailscale: not in this package | See "Phone link". |
| Health alerts | In-bot pushes unchanged. `health-watchdog.js` gets the timer BF-ALERTS.md documents (the server never scheduled it), at second 30 and as the bot unit's user (reviewer F4). Outside alarm (stage H) built but OFF by Mac's ruling until Topstep answers | See "What is silent". |
| Weekend timers | Travel as they are; on the PC only, the stop timer gets a drop-in `Persistent=false` (reviewer F1) | A laptop off from Friday to Monday would catch up stop and start together in no fixed order and could stay stopped all week. A missed stop is simply not run; a missed start is caught up. |

## Two bots on one account: the interlock
1. `vps-handoff.sh stop` (server): flat check, YES, then stops and disables every `mac-bot*` unit, timers first. That includes `mac-bot-weekend-start.timer`, which would otherwise start the server bot on Sunday 3 PM PT. It remembers the previous state for the undo.
2. `vps-handoff.sh pack` refuses unless every unit is inactive and not enabled and no bot process runs.
3. `mac-local restore` puts the units in place but enables and starts none of them. A WSL restart between restore and start cannot start the bot.
4. `mac-local start` needs a proof file at most 10 minutes old. The proof is made by piping the server's own `status` output over ssh into `mac-local vps-proof`, which accepts it only if live and proxy show `inactive` and `disabled`, no unit is active or enabled, no process or cron line is on, the last line is `VPS-STATE: OFF`, and the server's time stamp is within 120 s of the PC clock. One proof, one start.
5. Every later start by systemd (sign-in, tool restart, `Restart=always`) runs `mac-local guard` first (a drop-in `ExecStartPre`): if the server's phone-server port answers, the bot does not start. This only sees a server whose phone server is up; it passes when the server cannot be reached.
6. Undo is the mirror: `mac-local stop` (stop and disable), `mac-local status` piped into `vps-handoff.sh local-proof`, then `resume`, plus `Disable-ScheduledTask MacBot-WSL`.

Limits: step 5 needs the server address stored on the PC; the proofs are text passed through Mac's PowerShell, so they stop mistakes, not intent.

## Phone link: is Tailscale needed? No.
Nothing in the transfer needs it. The bot reaches the broker and ntfy by outbound HTTPS from the laptop. Tailscale would only let the phone open the page away from home. Topstep's page says "The use of VPS, VPNs, and remote servers is prohibited by Topstep's Terms of Use" and Tailscale calls itself a VPN replacement, so it is left out until Topstep answers in writing.

- **Default (ships): no remote page.** Pushes arrive as today. Flatten away from the PC = the TopstepX app.
- **Option D1, same Wi-Fi, no VPN software:** `networkingMode=mirrored` plus one Hyper-V firewall rule for TCP 8787. The phone opens `http://<PC LAN address>:8787/mobile.html` with the key. No router port is opened. Mirrored mode was chosen over `netsh portproxy` because the phone's own address reaches the phone server (so the key is asked), and a portproxy to `127.0.0.1` would arrive from loopback, which the phone server trusts without a key (`tmc-proxy.js:197`). Not tested on Windows; the sheet makes Mac test for the key screen.
- **Tailscale:** only on Topstep's written yes, on Windows (Tailscale's own advice), and it must pass the same no-key test because `tailscale serve` may deliver from loopback.

Known and unchanged: any program on the PC itself reaches `localhost:8787` without the key.

## What is silent on a laptop
Sleep, lid on battery, empty battery, a restart with nobody signed in, WSL stopped, home internet down: bot, watchdog and network stop together and no push leaves. The sheet says so in bold. Stage H is switched off by Mac's ruling of 11/12 until Topstep answers. It would add an outside alarm: `mac-local tick` sends a GET to a monitoring URL each minute while the PC, Linux and the internet are up and the bot's heartbeat is fresh (or the bot is off on purpose, as at the weekend). No bot code is involved.

## What I did not design
A native Windows port, a boot-time start before sign-in, Tailscale, a combine account switch.

## Open items
- **Copy-back:** undo after the PC bot has traded needs the PC's journal and state copied back to the server first. Not built; named in stage G3 of the sheet. Mac ruled the server is the way back, so this is the next piece of work.
- **A block on the server** (reviewer F9): its units are disabled, not blocked; a manual start or an old sheet starts a second bot. The sheet carries the rule; a server-side block needs pack and restore changed together.
- The stored server address must be cleared the day the server is cancelled (`mac-local vps-address none`; in the sheet at C9).
