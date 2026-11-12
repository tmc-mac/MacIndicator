# WINDOWS-FACTS: checked against primary documentation on 2026-11-12

Marking: **VERIFIED** = I read it on the page cited today. **UNVERIFIED** = not found in a primary source today; treat as a claim to test on Mac's PC. Quotes are verbatim.

Pages read:
- [WSL-CONFIG] https://learn.microsoft.com/en-us/windows/wsl/wsl-config (page dated 2026-10-16)
- [WSL-SYSTEMD] https://learn.microsoft.com/en-us/windows/wsl/systemd
- [WSL-NET] https://learn.microsoft.com/en-us/windows/wsl/networking
- [WSL-FAQ] https://learn.microsoft.com/en-us/windows/wsl/faq
- [WSL-TS] https://learn.microsoft.com/en-us/windows/wsl/troubleshooting
- [WSL-BG] https://devblogs.microsoft.com/commandline/background-task-support-in-wsl/ (linked from WSL-SYSTEMD)
- [POWERCFG] https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options
- [MS-S3] https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby-vs-s3
- [SCHTASKS] https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create
- [TS-WSL] https://tailscale.com/docs/install/windows/wsl2 (last validated Nov 3, 2025)
- [TS-SERVE] https://tailscale.com/docs/features/tailscale-serve
- [TS-WHAT] https://tailscale.com/docs/concepts/what-is-tailscale
- [TOPSTEP] https://help.topstep.com/en/articles/11187768-topstepx-api-access (dated September 17, 2026)

## 1. systemd in WSL — VERIFIED
- `/etc/wsl.conf`: `[boot]` / `systemd=true`, then `wsl.exe --shutdown` from PowerShell. Needs WSL 0.67.6 or newer (`wsl --version`). [WSL-SYSTEMD]
- "systemd now the default for the current version of Ubuntu that will be installed using the `wsl --install` command". Mac's Ubuntu-24.04 most likely already has it; check, do not assume: `systemctl is-system-running` inside WSL and `ps -p 1 -o comm=` must print `systemd`. [WSL-SYSTEMD]
- "The 8 second rule": config changes apply only after the distribution has fully stopped; `wsl --shutdown` is the fast path and "will shut down all running distributions". [WSL-CONFIG] **A `wsl --shutdown` kills the bot. Every sheet step that uses it must be a flat-only step.**
- `[boot] systemd` "Only supported on WSL 2". `[boot] command` exists ("run as the root user") but is not needed when systemd runs the units. [WSL-CONFIG]

## 2. WSL shuts itself down when idle; the supported way to keep it up
- VERIFIED: "systemd services will NOT keep your WSL instance alive. Your WSL instance will stay alive in the same way it did previous to this update". [WSL-SYSTEMD]
- VERIFIED: "If you have no open file handles to Windows processes, the WSL VM will automatically be shut down. This means if you are using it as a web server, SSH into it to run your server and then exit, the VM could shut down because it is detecting that users are finished using it". [WSL-FAQ, "Can I use WSL for production scenarios?"]
- VERIFIED: the same FAQ: WSL "has been designed and built to use with inner loop development workflows ... may make it challenging for production-related scenarios". Microsoft does not position WSL as an always-on server. Plain statement for Mac: this works, but it is held up by settings we add, and a Windows or WSL update can change them.
- VERIFIED keys in `%UserProfile%\.wslconfig` [WSL-CONFIG]:
  - `[general] instanceIdleTimeout` — default `15000` — "The number of milliseconds that a distro is idle, before it is shut down. Set to -1 to disable auto shutdown".
  - `[wsl2] vmIdleTimeout` — default `60000` — "The number of milliseconds that a VM is idle, before it is shut down." Windows 11 only. The page does **not** document `-1` for this key.
- UNVERIFIED: which WSL version first honours `[general] instanceIdleTimeout` (third-party notes say it arrived around WSL 2.5.x pre-release; community issues report idle shutdown still happening with `vmIdleTimeout=-1` on some versions). **So the key alone is not proof.** The package should (a) set the documented key, (b) also hold a Windows-side handle open (a hidden long-running `wsl.exe -d <distro> --exec sleep infinity` or similar started by the logon task), and (c) prove it: close every terminal, wait 10 minutes, `wsl --list --running` still shows the distro and the bot's heartbeat file is under 60 s old. Mac's check: `wsl --version` (record the number).
- VERIFIED: background processes "will continue running in the background even after the last console window has been closed"; "WSL doesn't support Linux startup tasks"; Task Scheduler is the suggested way. [WSL-BG, 2017] The article does not say whether they survive sign-out. UNVERIFIED: behaviour at Windows sign-out / fast user switching (expect: WSL is per-user and ends at sign-out). Sheet rule: Mac stays signed in; locking the screen (Win+L) is fine, signing out is not. Test on the box.

## 3. Starting WSL at logon or boot on Windows 11 Home
- VERIFIED: WSL 2 "is available on all Desktop SKUs where WSL is available, including Windows 10 Home and Windows 11 Home." [WSL-FAQ]
- VERIFIED [SCHTASKS]: `schtasks /create /sc ONLOGON /tn <name> /tr <command>`; `/sc ONSTART` "runs every time the system starts"; `/delay mmmm:ss` valid for ONSTART/ONLOGON; `/rl HIGHEST`; `/it` = "run the scheduled task only when the run as user ... is logged on"; `/np` = "No password is stored. The task runs non-interactively as the given user. Only local resources are available."; "Only Administrators can schedule tasks"; "ONLOGON - ... runs whenever a user (any user) logs on" unless `/ru` narrows it. Task Scheduler exists on Home (schtasks is edition-independent; the page lists no edition limit).
- Consequence, stated plainly: **at-logon is the realistic design.** A boot-time (ONSTART) task must run as Mac's Windows user (WSL distros are registered per user) with a stored password or `/np`; UNVERIFIED that WSL starts correctly from a non-interactive ONSTART task on Home before anyone signs in. So after any Windows restart (update, power cut, crash) **the bot is down until Mac signs in**, unless automatic sign-in is configured (a security trade-off Mac must choose). The package must say this in one sentence and the health alert must cover it (see GATE-PLAN G9).
- Mac's check: `schtasks /query /tn <name> /v /fo list` shows the task, "Logon Mode", last result 0; then a real restart test: reboot, sign in, do nothing else, within N minutes the phone page shows LIVE.

## 4. `.wslconfig` memory and swap — VERIFIED [WSL-CONFIG]
- Location `%UserProfile%\.wslconfig`; "does not exist by default"; global to all WSL 2 distros; "If the file is missing or malformed ... WSL will continue to launch as normal without the configuration settings applied" (**a typo fails silently**: the gate must read the applied value back with `free -m` inside WSL, not trust the file).
- `[wsl2] memory` — default "50% of total memory on Windows". On Mac's 7,863 MB PC that is about 3.9 GB by default.
- `[wsl2] swap` — default "25% of memory size on Windows rounded up to the nearest GB"; "0 for no swap file". `swapFile` default `%Temp%\swap.vhdx`.
- `[wsl2] processors` — default all logical processors.
- `[experimental] autoMemoryReclaim` — default `dropCache`; values `disabled`, `gradual`, `dropCache`.
- Sizes: "default to B (bytes) ... the size unit must be appended, e.g.: `8GB` or `512MB`". Paths need escaped backslashes.
- Needs `wsl --shutdown` to apply (flat-only step).
- Sizing note (mine, not from the page): the VPS ran the bot in 961 MB with swap and it crash-looped when the journal grew. The cap on the PC bounds bot + proxy + systemd + journald + Ubuntu + page cache. A cap near 1 GB re-creates the VPS's tightness for no reason; the default 3.9 GB leaves Windows about 4 GB. The builder's number must come with a measured peak (`free -m` and VmHWM during the 2000-bar warm-up with the real journal), not a guess.

## 5. Clock drift after sleep
- UNVERIFIED in Microsoft Learn: neither [WSL-TS] nor [WSL-FAQ] has a clock section (searched both pages for clock/hwclock/sleep/hibernate: no hits).
- From issue reports only (microsoft/WSL #4245, #5324; community answers): the WSL 2 clock could fall behind after the host sleeps or hibernates; reported fixed in WSL kernel 5.10.16.3 and later, with later reports of it still occurring on some kernels; the usual manual fix is `sudo hwclock -s`, or `wsl --shutdown`. Treat as: **may still happen; must be tested on Mac's PC.**
- Why it matters here: the bot's session windows, the 13:10 PT flat rule, news blocks and the 60 s phone-request age limit all read the system clock (GROUND-TRUTH (c)).
- What the package must contain: a clock check that compares the WSL clock with an outside reference (for example the `Date:` header of an HTTPS response) and fails above a few seconds; run at every service start (as an `ExecStartPre` or in the keep-alive script) and on a timer; plus `hwclock -s` on resume or on a timer. Mac's check: one command that prints "clock ok: off by N s". Sleep itself should be prevented (item 9), so drift after sleep is the second line of defence.
- VERIFIED: `[time] useWindowsTimezone` default `true`: "make WSL use and sync to the timezone set in Windows". [WSL-CONFIG] The bot does not depend on the system zone, only shell tools and `journalctl --since`.

## 6. Networking: NAT vs mirrored, and port 8787
- VERIFIED default is NAT (`networkingMode` default `NAT`). [WSL-CONFIG]
- VERIFIED NAT: from Windows, a server in WSL is reached "using `localhost` (just like you normally would)" (`localhostForwarding` default `true`: "ports bound to wildcard or localhost in the WSL 2 VM should be connectable from the host via `localhost:port`"). From the LAN it is **not** reachable by default: "WSL 2 has a virtualized ethernet adapter with its own unique IP address"; the documented way is `netsh interface portproxy add v4tov4 listenport=... listenaddress=0.0.0.0 connectport=... connectaddress=(wsl hostname -I)`. [WSL-NET] The WSL address is found each time with `wsl hostname -I`; a portproxy rule holds a fixed address. UNVERIFIED on the docs page that the address changes at every WSL restart (widely observed); a rule written once should be assumed to break after a restart.
- VERIFIED mirrored (`networkingMode=mirrored`, Windows 11 22H2+; Mac's build 26200 qualifies): "Connect to WSL directly from your local area network (LAN)"; Windows and WSL reach each other on `127.0.0.1` ("IPv6 localhost address `::1` is not supported"); inbound needs a Hyper-V firewall rule, e.g. `New-NetFirewallHyperVRule -Name ... -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8787` (admin PowerShell). "Improved networking compatibility for VPNs". [WSL-NET] The troubleshooting page still calls mirrored mode experimental and lists VPNs known to be incompatible, and says "some inbound traffic received by the Windows host will never be steered to the Linux VM". [WSL-TS] No Windows-edition limit is stated; UNVERIFIED that the Hyper-V firewall cmdlets exist on Home (test: `Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore`).
- **What this means for Tailscale and port 8787:**
  - VERIFIED: Tailscale recommends "that users run Tailscale on the Windows host only, and not inside WSL 2"; running both breaks ("Tailscale packets not being able to fit in Tailscale packets"); WSL 2's default MTU of 1280 "is not large enough for Tailscale to function" (tailscaled raises it to 1340 as a workaround). [TS-WSL] So: Tailscale on Windows, not in WSL.
  - With Tailscale on Windows + NAT mode: the phone reaches the PC's tailnet address, but nothing on Windows listens on 8787 on that address (localhost forwarding serves `localhost` only). A forwarder is needed: `tailscale serve` to `http://127.0.0.1:8787` ("route traffic from other devices on your Tailscale network ... to a local service running on your device"; tailnet-only; "requires you to enable HTTPS certificates in your tailnet") [TS-SERVE], or a `netsh portproxy` rule.
  - With mirrored mode: 8787 is bound on the PC's own interfaces; UNVERIFIED whether the Tailscale interface is mirrored into WSL and whether tailnet traffic reaches the WSL listener (not covered by either vendor's page). Test only.
  - **Key-bypass risk (from the code, GROUND-TRUTH (d)2):** the proxy skips the key for requests from 127.0.0.1. `tailscale serve` and `portproxy ... connectaddress=127.0.0.1` both deliver to localhost; [TS-SERVE] does not state the source address the backend sees. If it is loopback, every device on the tailnet can flatten, pause and relay broker calls with no key. Mandatory test on Mac's PC: from the phone, open the page address without the key and call a keyed route: it must answer 401. The same test from Windows Chrome at `http://localhost:8787` tells Mac whether the PC itself needs the key (if it does not, any web page open on the PC can call the proxy, since CORS is `*`).

## 7. Windows Update on Home: active hours and restarts
- UNVERIFIED against a primary page today (the Microsoft Support article URL I had returned 404; the search returned only Microsoft Q&A community answers). What those answers say, to be confirmed on Mac's own Settings screens: active hours stop automatic restarts during the chosen window but not downloads or installs; updates can be paused for a limited time (answers say up to 5 weeks / 35 days) and then resume; Home has no Group Policy editor, so updates cannot be turned off for good.
- Known from the product (UNVERIFIED today): the active-hours window is at most 18 hours. The futures session Mac trades spans more than 18 hours (Sun 15:00 PT to Fri 13:10 PT with a daily break), so **active hours alone cannot cover the whole session**; the daily 13:10-15:00 PT break and the weekend are the windows where a restart is harmless.
- What the package should do: set active hours to cover the hours the bot actually trades; tell Mac to install updates by hand on Saturday ("Check for updates", restart, sign in, confirm LIVE); use Pause in the weeks he cannot. Mac's checks: Settings > Windows Update > Advanced options shows the active hours; `Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' | Select ActiveHoursStart,ActiveHoursEnd` (UNVERIFIED registry names; test on the box).
- Not only Windows Update restarts WSL: a WSL update from the Store, a `wsl --update`, or a driver update can stop the VM. The health alert is the real protection, not the settings.

## 8. Lid and sleep via powercfg — syntax VERIFIED [POWERCFG]; aliases UNVERIFIED on the page
- VERIFIED: `powercfg /change standby-timeout-ac <minutes>`, `standby-timeout-dc`, `hibernate-timeout-ac`, `hibernate-timeout-dc`, `monitor-timeout-ac` ("Specifies the new value, in minutes"). The page does not state that `0` means never (UNVERIFIED on the page; it is the standing convention; confirm by reading the value back).
- VERIFIED: `powercfg /setacvalueindex <scheme> <sub> <setting> <index>` and `/setdcvalueindex`, then `powercfg /setactive <scheme>` to apply; `/aliases` "Displays a list of aliases ... may be used instead of a GUID"; `/hibernate off`; `/availablesleepstates` (`/a`); `/requests` ("Power Requests prevent the computer from automatically powering off the display or entering a low-power sleep mode"); `/lastwake`; `/sleepstudy`.
- UNVERIFIED on the page (not listed there; confirm with `powercfg /aliases` on Mac's PC): the aliases `SCHEME_CURRENT`, `SUB_BUTTONS`, `LIDACTION`, and that index `0` = "Do nothing". Expected commands: `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0`, same with `/setdcvalueindex`, then `powercfg /setactive SCHEME_CURRENT`.
- Mac's read-back checks: `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION` shows "Current AC Power Setting Index: 0x00000000" and the same for DC; `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` shows 0 for AC.
- Battery: "never sleep on battery" on a laptop means the bot runs until the battery is empty and then dies hard with no alert. The sheet must say: plugged in, always. A lid-closed laptop on a soft surface also overheats; "lid = do nothing" is a setting, not advice to close it.
- Some OEM tools and "Energy recommendations" in Settings reset these values; a feature update can too. The gate needs a one-line "show me all five values" command Mac can rerun.

## 9. Modern Standby caveats — VERIFIED [MS-S3]
- "When Modern Standby-capable systems enter sleep, the system is still in S0 ... Desktop apps are stopped by the Desktop Activity Moderator (DAM)". "Some timers are postponed indefinitely until the system is awake or plugged into AC power". In disconnected standby the network is off.
- Consequence: on a Modern Standby laptop, "sleep" does not look like power-off. The WSL VM is frozen or throttled, the bot stops polling, the watchdog stops too, the clock inside WSL can fall behind, and on wake everything resumes as if nothing happened. This is the "bot silently not LIVE" case. Open positions keep broker-side stops, but the 13:10 PT flat step would not run.
- How to tell: `powercfg /a` — "Standby (S0 Low Power Idle)" listed = Modern Standby; "Standby (S3)" = classic sleep. [POWERCFG: "/availablesleepstates ... Reports the sleep states available on the system"]
- On Modern Standby systems the sleep timeout and the lid action still apply, so items 8's settings are the control; but the power button, Start > Sleep, and a low-battery action still put it into standby. UNVERIFIED: whether the user can switch a Modern Standby machine to S3 (the page does not say; assume no).
- Evidence after the fact: `powercfg /sleepstudy` ("diagnostic report of modern standby quality over the last three days") and `powercfg /lastwake`. A session with a standby entry in the sleep study = the bot was not trading then.

## 10. Topstep's rule and whether Tailscale fits it

Article: "TopstepX™ API Access", section heading "VPNs, VPS, and Remote Servers" [TOPSTEP], dated September 17, 2026. Verbatim:

> "All trading activity must originate from your personal device."
>
> "The use of VPS, VPNs, and remote servers is prohibited by Topstep's Terms of Use."
>
> "Running automation on a VPS can result in account suspension or removal from the program."
>
> "You may still use your own private server for supporting work that doesn't touch order flow:" (table: allowed on a private server = historical data storage, research and backtesting, logging and analytics, a read-only dashboard, receiving copies of your own fills, positions and P&L; not allowed = placing, modifying or cancelling orders, any automated trigger that can reach the order endpoints, routing or relaying orders on your behalf)
>
> "The line is order transmission: your server can watch and record, but it cannot trade."

Corrections to the brief:
- The article's wording is "VPS, VPNs, and remote servers". The phrase "remote access tools" does **not** appear in the article as fetched today (checked explicitly; a search-engine summary used that phrase, the article does not). The Terms of Use themselves were not read (UNVERIFIED what they add).
- The move to Mac's own PC is exactly what the first sentence asks for. The current VPS setup is what the third sentence warns about.

Could Tailscale, used only to view the phone page, be read as a "VPN"?
- Tailscale's own description [TS-WHAT]: "Tailscale is a Zero Trust identity-based connectivity platform that replaces your legacy VPN, SASE, and PAM"; "Tailscale creates a peer-to-peer mesh network (known as a tailnet)"; "you can still use Tailscale like a traditional VPN by routing all traffic through an exit node." It is VPN software by its maker's own words.
- The sentence at issue is: **"The use of VPS, VPNs, and remote servers is prohibited by Topstep's Terms of Use."** It has no "for trading" qualifier. The sentence before it scopes the purpose to where "trading activity must originate", and the closing line says "The line is order transmission".
- Reading in Mac's favour: with no exit node, the bot's orders leave the PC over his home internet from his home IP; Tailscale carries only phone-to-PC traffic. Order origin is his personal device.
- Reading against him: (1) VPN software is installed and running on the trading device, and the rule as written bans "the use of ... VPNs" with no carve-out. (2) The phone page is **not read-only**: it has flatten, pause, cancel-entry and owner-flag buttons (PX:219-303), and the proxy relays `/api/*` to the broker. A flatten sent from the phone over Tailscale is an order instruction that travelled through a VPN to reach the order endpoint. That sits on the wrong side of "The line is order transmission". (3) If an exit node is ever switched on, the PC's own broker traffic leaves through another machine: a plain violation.
- **Plain risk statement:** nobody on this team can tell Mac that Topstep will accept Tailscale. The wording gives Topstep room to treat any VPN on the trading PC as a violation, and the stated consequence for the neighbouring case is "account suspension or removal from the program". The risk is small in likelihood (home IP, no exit node) and large in cost (the combine account and the payout goal). Only Topstep can settle it: a written answer from Topstep support to "may I view my bot's status page on my phone over Tailscale; no exit node; orders originate from my PC" turns this from a guess into a fact.

Safer alternatives, in order of safety:
1. **No remote viewing.** The phone gets only ntfy pushes (outbound HTTPS from the PC to a public service; no VPN, no inbound path). Mac looks at the page on the PC itself at `http://localhost:8787/mobile.html`. Zero VPN question. Cost: no phone flatten/pause away from the PC; TopstepX's own app is his remote flatten.
2. **Same-Wi-Fi only.** Phone on the home Wi-Fi opens `http://<PC's LAN address>:8787/mobile.html?key=...`. Needs a path from the LAN into WSL (portproxy rule kept current, or mirrored mode + Hyper-V firewall rule) and a Windows Firewall rule limited to the Private profile. No VPN software. Works only at home; the proxy key is the only gate on the LAN; plain HTTP.
3. **Tailscale, view-only use, after Topstep says yes in writing.** No exit node, ever; `tailscale serve` tailnet-only (never Funnel); the 401-without-key test passed; Mac understands the phone's flatten button is the part most exposed to the rule.
4. Not acceptable under the quoted wording: any relay through the VPS or another server that forwards the phone's flatten/pause to the PC ("Routing or relaying orders on your behalf" is in the not-allowed column).

Recommendation to carry to Mac: ship option 1 or 2 as the default, offer Tailscale as an opt-in step with the quoted sentence and the risk statement in front of it, and have him ask Topstep before turning it on.
