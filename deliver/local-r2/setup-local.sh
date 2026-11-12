#!/bin/bash
# setup-local.sh - runs INSIDE WSL2 (Ubuntu 24.04) on Mac's own PC, as root. Local r2 (r1 + reviewer patch). After "install" it is also the command  mac-local.
#   check [base|bot|run]  read-only. Prints PASS / STOP lines (base = the Linux side; bot = + the restored bot; run = + the running bot; default run)
#   install               idempotent: systemd on in /etc/wsl.conf, Node 18.19.1 exactly, folders, this script as /usr/local/sbin/mac-local
#   restore <bundle.tgz>  lays down the bundle made by vps-handoff.sh pack (bot folder, env file, unit files). Starts NOTHING
#   vps-proof             reads the output of "vps-handoff.sh status" (piped in over ssh) and records that the server bot is OFF and DISABLED
#   start                 the only way to start the bot here: refuses if a file is missing or there is no fresh vps-proof; asks YES (flat)
#   stop                  flat check, YES, stops and disables the local bot.   status = unit lines + LOCAL-STATE: OFF | RUNNING
#   vps-address [none]    store (or forget) the server address for the "is the server bot answering?" guard. Kept only on this PC
#   deadman set|off       optional outside alarm: every minute this PC pings a monitoring address you paste; the service alerts you when pings stop
#   guard                 (run by systemd before every bot start) refuses the start if the server's phone server answers or the clock is off
#   tick                  (run by a timer every minute) keeps the Linux clock on the PC clock and sends the deadman ping
# No secret is in this file; it never prints one. It never edits config-local.json, the journal or a bot file.
set -euo pipefail
NODE_V=v18.19.1
NODE_TAR=node-v18.19.1-linux-x64.tar.xz
NODE_SHA=f35f24edd4415cd609a2ebc03be03ed2cfe211d7333d55c752d831754fb849f0   # nodejs.org SHASUMS256.txt for v18.19.1
SYM=MNQ; LIVE=mac-bot-live.service; PROXY=mac-bot-proxy.service
R=""; TEST=0
if [ "${MACLOCAL_TEST:-0}" = 1 ]; then   # test rig only: everything under a prefix, never the real system
  R=${MACLOCAL_ROOT:-}; TEST=1
  case "$R" in /*/*) ;; *) echo "STOP: test mode needs MACLOCAL_ROOT=<a sandbox folder>. Nothing changed."; exit 1;; esac
  echo "[TEST MODE prefix $R]"
fi
BOT=$R/opt/mac-bot; LST=$R/opt/mac-local; SYSD=$R/etc/systemd/system; WSLCONF=$R/etc/wsl.conf; LCONF=$R/etc/mac-bot-local.conf
SELF_DST=$R/usr/local/sbin/mac-local; MODE=${1:-}
die() { echo "STOP: $1. Nothing changed."; exit 1; }
line() { echo; echo "==================== $1 ===================="; }
tv() { if [ "$TEST" = 1 ]; then eval "echo \"\${$1:-$2}\""; else echo "$2"; fi; }   # test-only override of a probe value

is_root() { [ "$(id -u)" = 0 ]; }
is_wsl() { grep -qi microsoft "$(tv MACLOCAL_PROC_VERSION /proc/version)" 2>/dev/null; }
pid1() { tv MACLOCAL_FAKE_PID1 "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')"; }
os_id() { ( . "$(tv MACLOCAL_OS_RELEASE /etc/os-release)" 2>/dev/null && echo "$ID $VERSION_ID" ); }
node_bin() { local p; for p in "$R/usr/bin/node" "$R/usr/local/bin/node"; do [ -x "$p" ] && { echo "$p"; return 0; }; done; return 1; }
node_ok() { local n; n=$(node_bin) && [ "$("$n" -v 2>/dev/null)" = "$NODE_V" ]; }
units() { ls "$SYSD" 2>/dev/null | grep -E '^mac-bot.*\.(service|timer)$' | sort || true; }
is_on() { case "$(systemctl is-enabled "$1" 2>/dev/null || true)" in enabled|enabled-runtime) return 0;; *) return 1;; esac; }
is_up() { [ "$(systemctl is-active "$1" 2>/dev/null || true)" = active ]; }
envfiles() { [ -f "$LST/meta/ENVFILES.txt" ] && cat "$LST/meta/ENVFILES.txt" || true; }
envval() { local f v; for f in $(envfiles); do v=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?$1=//p" "$R$f" 2>/dev/null | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'); [ -n "$v" ] && { echo "$v"; return 0; }; done; return 1; }
port() { envval PROXY_PORT || echo 8787; }
local_state() {  # 0 = OFF
  local u on=0; for u in $(units); do if is_up "$u" || is_on "$u"; then on=1; fi; done
  [ -n "$(pgrep -f "$(tv MACLOCAL_PGREP 'live-executor\.js|tmc-proxy\.js')" 2>/dev/null || true)" ] && on=1
  return $on
}
state_lines() { local u; for u in $(units); do echo "  unit $u  active=$(systemctl is-active "$u" 2>/dev/null || true)  enabled=$(systemctl is-enabled "$u" 2>/dev/null || true)"; done; }
rtc_offset() {  # Linux clock minus the PC (hardware) clock, seconds; "unknown" when the PC clock cannot be read
  local h t; h=$(tv MACLOCAL_FAKE_RTC "$(hwclock --get 2>/dev/null || true)"); [ -n "$h" ] && t=$(date -d "$h" +%s 2>/dev/null) && echo $(( $(date +%s) - t )) || echo unknown
}
conf_get() { [ -f "$LCONF" ] && sed -n "s/^$1=//p" "$LCONF" | tail -1 || true; }
conf_set() { ( umask 077; { [ -f "$LCONF" ] && grep -v "^$1=" "$LCONF" || true; [ -n "${2:-}" ] && printf '%s=%s\n' "$1" "$2"; } > "$LCONF.tmp"; mv "$LCONF.tmp" "$LCONF" ); chmod 600 "$LCONF"; }
vps_host() { conf_get VPS_HOST; }
vps_answers() {  # 0 = the server's phone server ANSWERS (its bot may be running); 1 = no answer; 2 = no address stored
  local h c; h=$(vps_host); [ -n "$h" ] || return 2
  c=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$h:$(port)/" 2>/dev/null || true)
  case "$c" in [1-5][0-9][0-9]) return 0;; *) return 1;; esac
}
clock_offset() {  # prints local-minus-internet seconds, or "unknown"
  local d t; d=$(curl -sI -m 8 "$(tv MACLOCAL_CLOCK_URL https://api.topstepx.com/)" 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p' | head -1)
  [ -n "$d" ] && t=$(date -d "$d" +%s 2>/dev/null) && echo $(( $(date +%s) - t )) || echo unknown
}
json_ok() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d,dict) else 1)' "$1" 2>/dev/null; }

# ------------------------------------------------------------------ check
NP=0; NS=0
PASS() { NP=$((NP+1)); echo "PASS  $1"; }
STOPL() { NS=$((NS+1)); echo "STOP  $1"; }
NOTE() { echo "NOTE  $1"; }
check_base() {
  if is_wsl; then PASS "WSL: this is Linux inside WSL"; else STOPL "WSL: this is not WSL (run it inside Ubuntu-24.04 on your PC)"; fi
  if [ "$(os_id)" = "ubuntu 24.04" ]; then PASS "Ubuntu 24.04"; else STOPL "Linux is '$(os_id)', the sheet needs Ubuntu 24.04"; fi
  if [ "$(pid1)" = systemd ]; then PASS "systemd is running (services work)"; else STOPL "systemd is not running: run 'install', then in PowerShell: wsl --shutdown, wait 10 s, try again"; fi
  if node_ok; then PASS "Node $NODE_V at $(node_bin | sed "s|^$R||")"; else STOPL "Node $NODE_V not installed (found: $(n=$(node_bin) && "$n" -v 2>/dev/null || echo none)): run 'install'"; fi
  if [ -x "$SELF_DST" ]; then PASS "mac-local command installed"; else STOPL "mac-local command not installed: run 'install'"; fi
  local m; m=$(awk '/^MemTotal/{print int($2/1024)}' /proc/meminfo)
  if [ "$m" -ge "$(tv MACLOCAL_MIN_MEM_MB 1900)" ]; then PASS "memory for Linux: $m MB (the server had 961 MB)"; else STOPL "memory for Linux is only $m MB: check .wslconfig (memory=3GB)"; fi
  local f; f=$(df -PB1 "$R/opt" 2>/dev/null | awk 'NR==2{print int($4/1048576)}')
  if [ "${f:-0}" -ge "$(tv MACLOCAL_MIN_DISK_MB 5120)" ]; then PASS "disk: $f MB free"; else STOPL "disk: only ${f:-0} MB free (need 5 GB)"; fi
  local o; o=$(clock_offset)
  if [ "$o" = unknown ]; then STOPL "clock: could not read the internet time (no internet from Linux?)"
  elif [ "${o#-}" -le 3 ]; then PASS "clock: within ${o#-} s of internet time"
  else STOPL "clock: off by $o s from internet time. Linux follows the Windows clock, so fix Windows: in PowerShell (Admin) run  w32tm /resync  wait 1 minute, then check again (try the check twice before believing it)"; fi
}
check_bot() {
  local f ok=1
  if [ -f "$LST/meta/MANIFEST.bot.sha256" ]; then PASS "restore record present ($(sed -n 's/^packed_utc=//p' "$LST/meta/FACTS.txt") from the server)"; else STOPL "no restore record: run 'restore <bundle>'"; return 0; fi
  for f in live-executor.js tmc-proxy.js lib/bars.js; do [ -f "$BOT/$f" ] || { STOPL "bot file missing: $f"; ok=0; }; done
  if [ "$ok" = 1 ]; then
    local bad; bad=$(cd "$BOT" && grep -E '\.(js|cjs|sh|html)$' "$LST/meta/MANIFEST.bot.sha256" | sha256sum -c --quiet 2>/dev/null | grep -c . || true)
    if [ "$bad" = 0 ]; then PASS "bot code = what came from the server (executor $(sha256sum < "$BOT/live-executor.js" | cut -c1-8), phone page $( [ -f "$BOT/mobile.html" ] && sha256sum < "$BOT/mobile.html" | cut -c1-8 || echo none))"
    else NOTE "bot code differs from the server copy in $bad file(s) (normal after an install here; executor now $(sha256sum < "$BOT/live-executor.js" | cut -c1-8))"; fi
  fi
  if [ -s "$BOT/config-local.json" ] && json_ok "$BOT/config-local.json"; then PASS "config-local.json present and readable"; else STOPL "config-local.json missing or not valid JSON"; fi
  if [ -s "$BOT/trade-journal-$SYM.jsonl" ]; then PASS "journal present ($(( $(stat -c %s "$BOT/trade-journal-$SYM.jsonl") / 1048576 )) MB)"; else STOPL "journal trade-journal-$SYM.jsonl missing or empty"; fi
  local k miss=""; for k in PTX_USER PTX_KEY PTX_CONFIRM_LIVE PROXY_SECRET NTFY_TOPIC; do envval "$k" >/dev/null || miss="$miss $k"; done
  if [ -z "$(envfiles)" ]; then STOPL "no env file restored"
  elif [ -z "$miss" ]; then PASS "env file has the settings the bot reads (names only checked, values not shown)"
  else STOPL "env file lacks:$miss (names only; values are yours to enter)"; fi
  for f in $(envfiles); do [ "$(stat -c %a "$R$f" 2>/dev/null)" = 600 ] || NOTE "env file $f is not mode 600"; done
  local pp; pp=$(port); if [ "$pp" = "$(tv MACLOCAL_EXPECT_PORT 8787)" ]; then PASS "phone server port $pp (the bot is hard-wired to 8787)"; else STOPL "PROXY_PORT is $pp: the bot only talks to 8787"; fi
  if [ "$(envval MACBOT_NEWS_FETCH || true)" = 0 ]; then STOPL "MACBOT_NEWS_FETCH=0 is in the env file (test-only setting: the news calendar would never download)"; fi
  local wtz htz; wtz=$(sed -n 's/^timezone=//p' "$LST/meta/FACTS.txt"); htz=$(tv MACLOCAL_FAKE_TZ "$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)")
  if [ "$htz" = "$wtz" ]; then PASS "time zone $htz = the server's (the weekend timers fire at the same moments)"; else STOPL "time zone here is '$htz', the server's was '$wtz': fix when flat: timedatectl set-timezone $wtz"; fi
  if [ -f "$SYSD/mac-local-tick.timer" ]; then if is_up mac-local-tick.timer; then PASS "clock-keeper timer active"; else STOPL "clock-keeper timer mac-local-tick.timer is not active: systemctl enable --now mac-local-tick.timer"; fi; else STOPL "clock-keeper timer missing: run restore again or tell your assistant"; fi
  if [ -f "$SYSD/$LIVE" ] && [ -f "$SYSD/$PROXY" ]; then PASS "unit files in place: $(units | tr '\n' ' ')"; else STOPL "unit files missing ($LIVE / $PROXY)"; fi
  if [ -f "$SYSD/$LIVE.d/10-maclocal-guard.conf" ]; then PASS "start guard installed"; else STOPL "start guard missing: run 'restore' again or tell your assistant"; fi
  local h; h=$(cat "$SYSD/$LIVE" "$SYSD/$LIVE.d"/*.conf 2>/dev/null | { grep -o 'max-old-space-size=[0-9]*' || true; } | tr '\n' ' ')
  if [ -n "$h" ]; then PASS "bot memory limit setting travels with the unit: $h"; else NOTE "no --max-old-space-size in the bot unit (the server sheet says 493): tell your assistant"; fi
}
check_run() {
  local u ok=1; for u in $LIVE $PROXY; do
    if is_up "$u"; then PASS "$u is active"; else STOPL "$u is NOT active"; ok=0; fi
    is_on "$u" || NOTE "$u is not enabled (it will not start by itself after a restart)"
  done
  local P; P=$(port)
  if [ "$ok" = 1 ]; then
    local LOG; LOG=$(journalctl -u "$LIVE" -n 6000 --no-pager 2>/dev/null || true)
    local st; st=$(echo "$LOG" | grep "session stamp" | tail -1 | grep -o 'executor [0-9a-f]*' || true); local e8; e8=$(sha256sum < "$BOT/live-executor.js" | cut -c1-8)
    if [ "$st" = "executor $e8" ]; then PASS "start line: session stamp, executor $e8"; else STOPL "no session stamp for executor $e8 in the log (found: ${st:-none})"; fi
    if echo "$LOG" | grep -q "Entering live loop"; then PASS "start line: Entering live loop"; else STOPL "no 'Entering live loop' in the log"; fi
    local wu; wu=$(echo "$LOG" | grep -o 'warm-up OK: [0-9]* 15m bars[^.]*' | tail -1 || true)
    if echo "$wu" | grep -q 'warm-up OK: 2000 15m bars'; then PASS "$wu"; else STOPL "no 'warm-up OK: 2000 15m bars' line (found: ${wu:-none})"; fi
    echo "$LOG" | grep -q "FATAL" && NOTE "the log has FATAL lines: $(echo "$LOG" | grep -c FATAL)"
    local hb="$BOT/health-heartbeat-$SYM.json"
    if [ -f "$hb" ]; then local age=$(( $(date +%s) - $(stat -c %Y "$hb") ))
      local lv; lv=$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print("LIVE" if d.get("live") else "NOT LIVE: "+str(d.get("reason"))[:120])' "$hb" 2>/dev/null || echo unreadable)
      if [ "$age" -le 180 ]; then if [ "$lv" = LIVE ]; then PASS "heartbeat $age s old: TIDE LIVE"; else STOPL "heartbeat $age s old: $lv"; fi
      else STOPL "heartbeat is $age s old (the bot is not writing it)"; fi
    else STOPL "no heartbeat file yet (wait 1 min after a start)"; fi
    if [ -f "$BOT/mobile.html" ]; then local sv fl; sv=$(curl -s -m 10 "http://127.0.0.1:$P/mobile.html" | sha256sum | cut -c1-8); fl=$(sha256sum < "$BOT/mobile.html" | cut -c1-8)
      if [ "$sv" = "$fl" ]; then PASS "phone page served = file on disk: $sv"; else STOPL "phone page served ($sv) is not the file on disk ($fl)"; fi
    else STOPL "mobile.html missing in the bot folder"; fi
    local ip c; ip=$(tv MACLOCAL_OWN_IP "$(hostname -I 2>/dev/null | awk '{print $1}')")
    if [ -n "$ip" ]; then c=$(curl -s -m 6 -o /dev/null -w '%{http_code}' "http://$ip:$P/mobile.html" 2>/dev/null || true)
      if [ "$c" = 401 ]; then PASS "phone server refuses a request without the key (401)"; else STOPL "phone server answered $c without the key from $ip (want 401): do not link a phone, tell your assistant"; fi
    fi
  fi
  local wt; wt=$(units | grep 'watchdog.*\.timer$' | head -1 || true)
  if [ -n "$wt" ]; then if is_up "$wt"; then PASS "heartbeat watchdog timer active"; else STOPL "heartbeat watchdog timer $wt is not active"; fi; else NOTE "no heartbeat watchdog timer"; fi
  local rc=0; vps_answers || rc=$?
  case $rc in 0) STOPL "THE SERVER'S PHONE SERVER ANSWERS: the server bot may be running. Never two bots on one account: stop this one or that one NOW";;
    1) PASS "server check: its phone server does not answer (server bot off)";; 2) NOTE "no server address stored (mac-local vps-address): the two-bots guard is off";; esac
  local ro; ro=$(rtc_offset); if [ "$ro" = unknown ]; then NOTE "PC clock not readable from Linux (hwclock): the clock-keeper cannot correct drift"; elif [ "${ro#-}" -le 2 ]; then PASS "Linux clock = PC clock (off by ${ro#-} s)"; else STOPL "Linux clock is $ro s off the PC clock (the clock-keeper should fix this within a minute; check again; if it stays, send the lines)"; fi
  if [ -n "$(conf_get DEADMAN_URL)" ]; then local la; la=$(( $(date +%s) - $(cat "$LST/deadman.last" 2>/dev/null || echo 0) )); if [ "$la" -le 180 ]; then PASS "outside alarm: last ping sent $la s ago"; else STOPL "outside alarm: no ping sent for $la s"; fi
  else NOTE "NO OUTSIDE ALARM is set (mac-local deadman set): if this PC sleeps, loses power or internet, or restarts, NOTHING tells you"; fi
  local nf; nf=$(systemctl --failed --no-legend 2>/dev/null | grep -c . || true); [ "${nf:-0}" != 0 ] && NOTE "$nf failed Linux unit(s): systemctl --failed"
  if command -v tailscale >/dev/null 2>&1; then NOTE "tailscale: $(tailscale status --peers=false 2>/dev/null | head -1 || echo not-connected)"; fi
}

# ------------------------------------------------------------------ helpers that change things
wslconf_set() {  # wslconf_set <section> <key> <value>   line-based, keeps everything else
  python3 -I - "$WSLCONF" "$1" "$2" "$3" <<'PY'
import sys, os, re
p, sec, key, val = sys.argv[1:5]
L = open(p).read().split('\n') if os.path.exists(p) else []
out, cur, done, seen = [], None, False, False
for ln in L:
    m = re.match(r'\s*\[([^\]]+)\]\s*$', ln)
    if m:
        if cur == sec and not done: out.append('%s=%s' % (key, val)); done = True
        cur = m.group(1).strip(); seen = seen or cur == sec
    elif cur == sec and re.match(r'\s*%s\s*=' % re.escape(key), ln, re.I):
        if done: continue
        ln = '%s=%s' % (key, val); done = True
    out.append(ln)
while out and out[-1] == '': out.pop()
if not done:
    if not (seen and cur == sec): out += ([''] if out else []) + ['[%s]' % sec]
    out.append('%s=%s' % (key, val))
open(p + '.tmp', 'w').write('\n'.join(out) + '\n'); os.replace(p + '.tmp', p)
PY
}
wslconf_get() { [ -f "$WSLCONF" ] && awk -v s="[$1]" -v k="$2" 'BEGIN{IGNORECASE=1} /^[[:space:]]*\[/{c=$0; gsub(/[[:space:]]/,"",c)} c==s && $0 ~ "^[[:space:]]*"k"[[:space:]]*=" {v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); gsub(/[[:space:]]+$/,"",v); r=v} END{print r}' "$WSLCONF" || true; }
exec_node_path() { sed -n 's/^[[:space:]]*ExecStart=[-@:+!]*\([^[:space:]]*\).*/\1/p' "$1" | tail -1; }

do_install() {
  line "1/4 check (read-only)"
  is_root || die "run this as root (the sheet uses: wsl -d Ubuntu-24.04 -u root -- ...)"
  is_wsl || die "this is not WSL: run it inside Ubuntu-24.04 on your PC"
  [ "$(os_id)" = "ubuntu 24.04" ] || die "this Linux is '$(os_id)'; the sheet needs Ubuntu 24.04"
  command -v python3 >/dev/null || die "python3 is missing (Ubuntu 24.04 ships it; tell your assistant)"
  echo "ok: WSL, Ubuntu 24.04, root"

  line "2/4 systemd and time zone in /etc/wsl.conf"
  local chg=0
  if [ "$(wslconf_get boot systemd)" != true ] || [ "$(wslconf_get time useWindowsTimezone)" != false ]; then
    [ -f "$WSLCONF" ] && [ ! -f "$WSLCONF.maclocal-bak" ] && cp -p "$WSLCONF" "$WSLCONF.maclocal-bak"
    mkdir -p "$(dirname "$WSLCONF")"; wslconf_set boot systemd true; wslconf_set time useWindowsTimezone false; chg=1
    echo "written: [boot] systemd=true and [time] useWindowsTimezone=false (the old file is kept as wsl.conf.maclocal-bak)"
  else echo "already set: systemd=true, useWindowsTimezone=false"; fi

  line "3/4 Node $NODE_V exactly"
  if node_ok; then echo "already installed: $("$(node_bin)" -v) at $(node_bin | sed "s|^$R||")"
  else
    local viaapt=0
    if [ "$TEST" = 0 ] && [ -z "${MACLOCAL_NODE_TARBALL:-}" ]; then
      apt-get update -qq || echo "  (apt-get update had errors; trying anyway)"
      if apt-cache policy nodejs 2>/dev/null | grep -q 'Candidate: 18\.19\.1'; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nodejs && apt-mark hold nodejs >/dev/null && viaapt=1
      fi
    fi
    if [ "$viaapt" = 1 ] && node_ok; then echo "installed from Ubuntu 24.04's own package (held at this version): $("$(node_bin)" -v)"
    else
      echo "Ubuntu's package is not $NODE_V here: using the official nodejs.org build (sha256 pinned in this script)"
      local T; T=$(mktemp -d); local src=${MACLOCAL_NODE_TARBALL:-}
      if [ -z "$src" ]; then src="$T/$NODE_TAR"; curl -fsSL -m 300 -o "$src" "https://nodejs.org/dist/$NODE_V/$NODE_TAR" || { rm -rf "${T:?}"; echo "STOP: could not download Node. Only /etc/wsl.conf was written so far; run install again."; exit 1; }; fi
      [ "$(sha256sum < "$src" | cut -c1-64)" = "$NODE_SHA" ] || { rm -rf "${T:?}"; echo "STOP: the Node download does not match its sha256. Not installed; run install again."; exit 1; }
      mkdir -p "$R/opt" "$R/usr/local/bin"; rm -rf "${R:?}/opt/node-$NODE_V-linux-x64.new"; mkdir "$R/opt/node-$NODE_V-linux-x64.new"
      tar -xJf "$src" -C "$R/opt/node-$NODE_V-linux-x64.new" --strip-components=1
      rm -rf "${R:?}/opt/node-$NODE_V-linux-x64"; mv "$R/opt/node-$NODE_V-linux-x64.new" "$R/opt/node-$NODE_V-linux-x64"
      ln -sfn "/opt/node-$NODE_V-linux-x64/bin/node" "$R/usr/local/bin/node"
      [ "$TEST" = 1 ] && ln -sfn "$R/opt/node-$NODE_V-linux-x64/bin/node" "$R/usr/local/bin/node"
      rm -rf "${T:?}"
      node_ok || { echo "STOP: Node is not $NODE_V after the install (found $("$(node_bin)" -v 2>/dev/null || echo none)). Tell your assistant."; exit 1; }
      echo "installed: $("$(node_bin)" -v) at /usr/local/bin/node"
    fi
  fi
  command -v curl >/dev/null || { [ "$TEST" = 0 ] && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl; }

  line "4/4 folders and the mac-local command"
  mkdir -p "$R/opt" "$LST" "$SYSD" "$(dirname "$SELF_DST")"; chmod 700 "$LST"
  local me; me=$(readlink -f "$0")
  if [ "$me" != "$(readlink -f "$SELF_DST" 2>/dev/null || true)" ]; then install -m 755 "$me" "$SELF_DST"; echo "installed: /usr/local/sbin/mac-local ($(sha256sum < "$SELF_DST" | cut -c1-8))"; else echo "already installed: mac-local"; fi
  echo
  if [ "$(pid1)" != systemd ] || [ "$chg" = 1 ]; then echo "NEXT: in PowerShell run   wsl --shutdown   wait 10 seconds, then run the check line of the sheet."; fi
  echo "DONE install (the bot is not here yet and nothing was started)."
}

do_restore() {
  local B=${1:-}; local CREATED=()
  line "1/4 check the bundle (read-only)"
  is_root || die "run this as root"
  [ -n "$B" ] && [ -f "$B" ] || die "usage: mac-local restore <maclocal-bundle.tgz> (file not found: ${B:-none})"
  node_ok || die "Node $NODE_V is not installed: run install first"
  [ "$(pid1)" = systemd ] || die "systemd is not running: run install, then wsl --shutdown, first"
  [ -f "$B.sha256" ] || die "$B.sha256 is not next to the bundle (copy both files)"
  local want got; want=$(cut -c1-64 "$B.sha256"); got=$(sha256sum < "$B" | cut -c1-64)
  [ "$want" = "$got" ] || die "the bundle is damaged: its sha256 is $(echo "$got" | cut -c1-8 | tr a-f A-F), the server said $(echo "$want" | cut -c1-8 | tr a-f A-F). Copy it again"
  echo "bundle sha256 $(echo "$got" | cut -c1-8 | tr a-f A-F) = the .sha256 file from the server (compare with the BUNDLE line the server printed)"
  local bad; bad=$(tar -tzf "$B" | grep -Ev '^(meta|botdir)(/|$)' | head -3 || true); [ -z "$bad" ] || die "the bundle holds unexpected paths: $bad"
  tar -tzf "$B" | grep -q '\(^\|/\)\.\.\(/\|$\)' && die "the bundle holds '..' paths"
  local_state || die "the local bot is running or enabled (mac-local status). Restore only onto a stopped, empty install"
  mkdir -p "$LST"; chmod 700 "$LST"
  local NEED=$(( $(stat -c %s "$B") * 12 + 1073741824 )); local FREE; FREE=$(df -PB1 "$LST" | awk 'NR==2{print $4}')
  [ "$TEST" = 1 ] && NEED=$(( $(stat -c %s "$B") * 3 ))
  [ "$FREE" -ge "$NEED" ] || die "not enough disk in Linux: need about $NEED bytes, $FREE free"
  local ST="$LST/stage.$$"; rm -rf "${ST:?}"; mkdir -p "$ST"
  tar -xzf "$B" -C "$ST" meta || { rm -rf "${ST:?}"; die "cannot read the bundle"; }
  local M="$ST/meta"
  for f in FACTS.txt MANIFEST.bot.sha256 UNITS.txt ENVFILES.txt "systemd/$LIVE" "systemd/$PROXY"; do [ -s "$M/$f" ] || { rm -rf "${ST:?}"; die "the bundle lacks meta/$f"; }; done
  if [ -f "$BOT/live-executor.js" ]; then
    if [ -f "$LST/meta/MANIFEST.bot.sha256" ] && cmp -s "$M/MANIFEST.bot.sha256" "$LST/meta/MANIFEST.bot.sha256"; then rm -rf "${ST:?}"; echo "ALREADY RESTORED: this same bundle is in place. Nothing changed."; exit 0; fi
    rm -rf "${ST:?}"; die "a bot is already in /opt/mac-bot and it is not from this bundle. I never overwrite a journal: tell your assistant"
  fi
  [ -z "$(ls -A "$BOT" 2>/dev/null)" ] || { rm -rf "${ST:?}"; die "/opt/mac-bot is not empty"; }
  [ -z "$(units)" ] || { rm -rf "${ST:?}"; die "mac-bot unit files are already in /etc/systemd/system but no bot: tell your assistant"; }
  echo "bundle facts: $(grep -E '^(packed_utc|node_version|executor_sha8|page_sha8|journal_bytes|bot_files|timezone)=' "$M/FACTS.txt" | tr '\n' ' ')"
  [ "$(sed -n 's/^node_version=//p' "$M/FACTS.txt")" = "$NODE_V" ] || echo "NOTE: the server's Node was $(sed -n 's/^node_version=//p' "$M/FACTS.txt"), here it is $NODE_V (the version the gates use)"
  for u in $(cat "$M/UNITS.txt"); do grep -q '/opt/mac-bot' "$M/systemd/$u" || echo "NOTE: unit $u does not mention /opt/mac-bot"; done
  local SU; SU=$(cat "$M"/systemd/mac-bot*.service | sed -n 's/^[[:space:]]*User=//p' | sort -u | grep -vx root || true)

  line "2/4 unpack next to the target and verify every file"
  tar -xzf "$B" -C "$ST" botdir || { rm -rf "${ST:?}"; die "cannot unpack the bundle"; }
  (cd "$ST/botdir" && sha256sum -c "$M/MANIFEST.bot.sha256" --quiet) || { rm -rf "${ST:?}"; die "unpacked files do not match the server's list"; }
  [ "$(find "$ST/botdir" -type f | wc -l)" = "$(wc -l < "$M/MANIFEST.bot.sha256")" ] || { rm -rf "${ST:?}"; die "the unpacked folder has files the server's list does not have"; }
  json_ok "$ST/botdir/config-local.json" || { rm -rf "${ST:?}"; die "config-local.json is missing from the bundle or is not valid JSON"; }
  [ -s "$ST/botdir/trade-journal-$SYM.jsonl" ] || { rm -rf "${ST:?}"; die "the journal is missing from the bundle"; }
  local EX; EX="$(dirname "$B")/EXPECT.sha256"
  if [ -f "$EX" ]; then (cd "$ST/botdir" && sha256sum -c "$EX" --quiet) || { rm -rf "${ST:?}"; die "the bot code or phone page is not the build the sheet names (EXPECT.sha256; lines above). Tell your assistant"; }
    echo "build check: $(wc -l < "$EX") code files + phone page match EXPECT.sha256 (the build the sheet names)"
  else echo "NOTE: no EXPECT.sha256 next to the bundle: the code is compared with the server's own list only"; fi
  echo "verified: $(wc -l < "$M/MANIFEST.bot.sha256") files match the server's sha256 list; config-local.json and the journal ($(( $(stat -c %s "$ST/botdir/trade-journal-$SYM.jsonl") / 1048576 )) MB) are there"

  line "3/4 put in place"
  undo() { echo "UNDO: removing what this restore placed ..."; local p; for p in "${CREATED[@]:-}"; do [ -n "$p" ] && rm -rf "${p:?}"; done; rm -rf "${ST:?}"; echo "STOP: restore failed at: $1. Everything it placed was removed again."; exit 1; }
  for su in $SU; do id "$su" >/dev/null 2>&1 || { if [ "$TEST" = 1 ]; then echo "  [test] would create service user $su"; else useradd --system --home-dir /opt/mac-bot --shell /usr/sbin/nologin "$su" || undo "create user $su"; fi; echo "  service user: $su"; }; done
  rmdir "$BOT" 2>/dev/null || true; CREATED+=("$BOT"); mv "$ST/botdir" "$BOT" || undo "move the bot folder"
  # must not travel as live files: phone requests, queued phone actions, the heartbeat, torn temp files (they could act, or hide a dead bot)
  : > "$M/REMOVED-ON-ARRIVAL.txt"
  ( cd "$BOT" && { ls -d flatten-request-*.json pause-request-*.json health-heartbeat-*.json ./*.tmp ./*.tmp-* 2>/dev/null || true; find entry-cancel-* owner-flag-* -type f 2>/dev/null || true; } ) | while IFS= read -r f; do
    [ -f "$BOT/$f" ] && { rm -f "$BOT/$f"; echo "$f" >> "$M/REMOVED-ON-ARRIVAL.txt"; }; done
  echo "  removed on arrival (stale request / heartbeat / temp files): $(wc -l < "$M/REMOVED-ON-ARRIVAL.txt") file(s) $(tr '\n' ' ' < "$M/REMOVED-ON-ARRIVAL.txt" | cut -c1-200)"
  local OWN; OWN=$(sed -n 's/^owner=//p' "$M/FACTS.txt")
  if [ -n "$OWN" ] && [ "$OWN" != root:root ]; then if [ "$TEST" = 1 ]; then echo "  [test] would chown -R $OWN /opt/mac-bot"; else chown -R "$OWN" "$BOT" || undo "give the bot folder to $OWN"; echo "  owner: $OWN (as on the server)"; fi; fi
  while IFS= read -r ef; do [ -n "$ef" ] || continue
    [ -e "$R$ef" ] && undo "env file $ef already exists here"
    mkdir -p "$(dirname "$R$ef")"; CREATED+=("$R$ef"); install -m 600 "$M/envfiles$ef" "$R$ef" || undo "place $ef"; echo "  env file: $ef (mode 600, values not shown)"
  done < "$M/ENVFILES.txt"
  mkdir -p "$SYSD"
  for u in $(cat "$M/UNITS.txt"); do
    CREATED+=("$SYSD/$u" "$SYSD/$u.d"); install -m 644 "$M/systemd/$u" "$SYSD/$u" || undo "place $u"
    if [ -d "$M/systemd/$u.d" ]; then mkdir -p "$SYSD/$u.d"; cp "$M/systemd/$u.d"/*.conf "$SYSD/$u.d/" || undo "place the drop-ins of $u"; fi
    echo "  unit: $u$( [ -d "$M/systemd/$u.d" ] && echo " + $(ls "$M/systemd/$u.d" | tr '\n' ' ')" )"
  done
  mkdir -p "$SYSD/$LIVE.d"; CREATED+=("$SYSD/$LIVE.d")
  printf '# added by mac-local (not from the server): refuse the start while the server bot answers. The + runs it as root even when the unit has User=\n[Service]\nExecStartPre=+/usr/local/sbin/mac-local guard\n' > "$SYSD/$LIVE.d/10-maclocal-guard.conf"
  echo "  start guard: $LIVE.d/10-maclocal-guard.conf"
  local NP_; NP_=$(exec_node_path "$SYSD/$LIVE"); [ -n "$NP_" ] || undo "read the node path from $LIVE"
  if [ ! -x "$R$NP_" ]; then mkdir -p "$(dirname "$R$NP_")"; CREATED+=("$R$NP_"); ln -s "$( [ "$TEST" = 1 ] && node_bin || node_bin | sed "s|^$R||")" "$R$NP_" || undo "link node at $NP_"; echo "  node: the units start $NP_ -> linked to Node $NODE_V"; fi
  [ "$("$R$NP_" -v 2>/dev/null)" = "$NODE_V" ] || undo "the node the units start ($NP_) is not $NODE_V"
  if ! grep -q 'watchdog.*\.timer$' "$M/UNITS.txt" && [ -f "$BOT/health-watchdog.js" ]; then
    local ef1; ef1=$(head -1 "$M/ENVFILES.txt"); CREATED+=("$SYSD/mac-bot-watchdog.service" "$SYSD/mac-bot-watchdog.timer")
    local wu_; wu_=$(sed -n 's/^[[:space:]]*User=//p' "$SYSD/$LIVE" | tail -1)
    printf '# added by mac-local in the form BF-ALERTS.md documents (the server had no watchdog timer unit)\n[Unit]\nDescription=Mac bot heartbeat watchdog\n[Service]\nType=oneshot\n%sEnvironmentFile=%s\nExecStart=%s /opt/mac-bot/health-watchdog.js --dir /opt/mac-bot --symbol %s\n' "${wu_:+User=$wu_
}" "$ef1" "$NP_" "$SYM" > "$SYSD/mac-bot-watchdog.service"
    printf '# added by mac-local in the form BF-ALERTS.md documents\n[Unit]\nDescription=Mac bot heartbeat watchdog, every minute\n[Timer]\n# second 30: not the second the weekend timer starts the bot (a :00 run reads the heartbeat of Friday and pushes every Sunday)\nOnCalendar=*-*-* *:*:30\nAccuracySec=5s\n[Install]\nWantedBy=timers.target\n' > "$SYSD/mac-bot-watchdog.timer"
    echo "  heartbeat watchdog: mac-bot-watchdog.timer added (the server had none as a unit$( [ -s "$M/CRON.txt" ] && echo "; it ran from cron there" ))"
  fi
  local wt_; for wt_ in $(cat "$M/UNITS.txt" | grep 'stop.*\.timer$' || true); do
    if grep -qi '^[[:space:]]*Persistent=\(true\|yes\|1\|on\)' "$SYSD/$wt_"; then mkdir -p "$SYSD/$wt_.d"
      printf '# added by mac-local (not from the server): a laptop can be off across the Friday stop and the Sunday start.\n# A stop that is caught up late could run AFTER the start and leave the bot off all week. A missed stop is not caught up here.\n[Timer]\nPersistent=false\n' > "$SYSD/$wt_.d/10-maclocal-nocatchup.conf"
      echo "  weekend stop timer: no late catch-up on this PC ($wt_.d/10-maclocal-nocatchup.conf)"; fi; done
  CREATED+=("$SYSD/mac-local-tick.service" "$SYSD/mac-local-tick.timer")
  printf '# added by mac-local: every minute keep the Linux clock on the PC clock; send the optional outside-alarm ping\n[Unit]\nDescription=mac-local tick\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/mac-local tick\n' > "$SYSD/mac-local-tick.service"
  printf '# added by mac-local\n[Unit]\nDescription=mac-local tick, every minute\n[Timer]\nOnCalendar=*-*-* *:*:30\nAccuracySec=5s\n[Install]\nWantedBy=timers.target\n' > "$SYSD/mac-local-tick.timer"
  local tz; tz=$(sed -n 's/^timezone=//p' "$M/FACTS.txt")
  if [ "$TEST" = 0 ] && [ -n "$tz" ] && [ -e "/usr/share/zoneinfo/$tz" ]; then timedatectl set-timezone "$tz" 2>/dev/null && echo "  time zone: $tz (same as the server)" || echo "  NOTE: could not set the time zone to $tz"; fi
  rm -rf "${LST:?}/meta"; mv "$M" "$LST/meta"; rm -rf "${ST:?}"
  systemctl daemon-reload || true
  systemctl enable mac-local-tick.timer >/dev/null 2>&1 && systemctl start mac-local-tick.timer && echo "  clock-keeper timer started (it starts no bot)"

  line "4/4 verify (read-only)"
  if command -v systemd-analyze >/dev/null 2>&1 && [ "$TEST" = 0 ]; then systemd-analyze verify "$SYSD"/mac-bot*.service "$SYSD"/mac-bot*.timer "$SYSD"/mac-local-tick.* 2>&1 | grep -v 'man page\|Documentation' | head -8 || true; fi
  NP=0; NS=0; check_bot
  [ "$NS" = 0 ] || { echo "STOP (after the copy): the lines above say STOP. The bot files ARE in place, nothing is started, and start will refuse until this is fixed. Send these lines."; exit 1; }
  echo "DONE restore: the bot is in place and NOT started. Next: the server proof line of the sheet, then  mac-local start"
}

do_start() {
  line "1/3 check (read-only)"
  is_root || die "run this as root"
  NP=0; NS=0; check_base; check_bot
  [ "$NS" = 0 ] || die "$NS line(s) above say STOP"
  if is_up "$LIVE"; then die "the local bot is already running (mac-local check)"; fi
  local pa; pa=$(( $(date +%s) - $(cat "$LST/vps-proof" 2>/dev/null || echo 0) ))
  [ "$pa" -le 600 ] || die "no fresh proof that the server bot is OFF and DISABLED (last proof: $( [ -f "$LST/vps-proof" ] && echo "$pa s ago" || echo never )). Run the server proof line of the sheet first (it is valid for 10 minutes)"
  echo "PASS  server proof: OFF and DISABLED, checked over ssh $pa s ago"
  local rc=0; vps_answers || rc=$?
  case $rc in 0) die "THE SERVER'S PHONE SERVER ANSWERS, so the server bot may be running. Never two bots on one account. Stop the server first (sheet stage C)";;
    1) echo "PASS  server check from here: its phone server does not answer";; 2) echo "NOTE  no server address stored: the every-start guard is off (the ssh proof above still holds for this start)";; esac
  echo; echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders."
  read -r -p "Type YES to start the bot on this PC (anything else = stop here, nothing changed): " a
  [ "$a" = YES ] || { echo "Nothing changed."; exit 1; }

  line "2/3 start"
  off() { local u; for u in $(units | grep '\.timer$' || true) $LIVE $(units | grep '\.service$' | grep -vx "$LIVE" || true); do systemctl stop "$u" 2>/dev/null || true; systemctl disable "$u" >/dev/null 2>&1 || true; done
    echo "STOP: $1. The local bot was stopped and disabled again; the server was not touched (still off). Send these lines."; exit 1; }
  local T0; T0=$(date '+%Y-%m-%d %H:%M:%S'); local u e a2
  rm -f "$LST/vps-proof"   # one proof = one start
  # exactly what was enabled / running on the server (STATE.before), plus the watchdog timer added here; the bot and the phone server always
  was() { awk -v u="$1" -v c="$2" '$1==u{print $c}' "$LST/meta/STATE.before" 2>/dev/null; }
  for u in $(units | grep '\.service$' | grep -vx "$LIVE" || true) $LIVE $(units | grep '\.timer$' || true); do
    e=$(was "$u" 2); a2=$(was "$u" 3)
    case "$u" in "$LIVE"|"$PROXY") e=enabled; a2=active;; mac-bot-watchdog.timer) [ -z "$e" ] && { e=enabled; a2=active; };; esac
    case "$e" in enabled|enabled-runtime) systemctl enable "$u" >/dev/null 2>&1 || off "could not enable $u";; esac
    if [ "$a2" = active ]; then systemctl start "$u" || off "could not start $u"; echo "  started: $u"; else echo "  left as on the server: $u (enabled=${e:-no} active=${a2:-no})"; fi
  done

  line "3/3 verify"
  local LOG="" i; for i in $(seq 1 15); do sleep 10; LOG=$(journalctl -u "$LIVE" --since "$T0" --no-pager 2>/dev/null || true)
    echo "$LOG" | grep -q "Entering live loop\|FATAL" && break; is_up "$LIVE" || break; done
  is_up "$LIVE" || { echo "$LOG" | tail -25; off "the bot is not running"; }
  echo "$LOG" | grep -q "Entering live loop" || { echo "$LOG" | tail -25; off "no 'Entering live loop' line within 150 s"; }
  sleep "$(tv MACLOCAL_SETTLE 40)"
  NP=0; NS=0; check_run
  [ "$NS" = 0 ] || off "$NS check line(s) above say STOP"
  echo; echo "DONE: the bot runs on this PC now ($NP checks PASS). The server stays OFF. Daily check: mac-local check"
}

do_stop() {
  is_root || die "run this as root"
  if local_state; then echo "LOCAL-STATE: OFF"; echo "DONE: nothing to do."; exit 0; fi
  if [ -f "$BOT/flatcheck.sh" ]; then bash "$BOT/flatcheck.sh" "$BOT" || die "the bot is not flat (or cannot tell). Run this again when flat"; fi
  echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders."
  read -r -p "Type YES to stop the bot on this PC and keep it off (anything else = stop here, nothing changed): " a
  [ "$a" = YES ] || { echo "Nothing changed."; exit 1; }
  local u; for u in $(units | grep '\.timer$' || true) $LIVE $(units | grep '\.service$' | grep -vx "$LIVE" || true); do
    systemctl stop "$u" || echo "  could not stop $u"; systemctl disable "$u" >/dev/null 2>&1 || true; echo "  stopped: $u"; done
  sleep 2
  if local_state; then echo "LOCAL-STATE: OFF"; echo "DONE: the bot on this PC is off and will not start by itself."; else echo "LOCAL-STATE: RUNNING"; echo "STOP: something is still on. Send these lines."; exit 1; fi
}

do_guard() {  # ExecStartPre of the bot unit. exit 1 = the bot does not start.
  [ -s "$BOT/config-local.json" ] || { echo "mac-local guard: STOP config-local.json is missing"; exit 1; }
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d,dict) and len(d)>0 else 1)' "$BOT/config-local.json" 2>/dev/null || { echo "mac-local guard: STOP config-local.json is empty or not readable (the bot would trade on shipped defaults)"; exit 1; }
  [ -s "$BOT/trade-journal-$SYM.jsonl" ] || { echo "mac-local guard: STOP the journal is missing"; exit 1; }
  if is_wsl && [ "$TEST" = 0 ]; then hwclock -s 2>/dev/null || true; fi
  local ro; ro=$(rtc_offset); if [ "$ro" != unknown ] && [ "${ro#-}" -gt 5 ]; then echo "mac-local guard: STOP the Linux clock is $ro s off the PC clock. This bot does not start."; exit 1; fi
  local rc=0; vps_answers || rc=$?
  if [ $rc = 0 ]; then echo "mac-local guard: STOP the server's phone server answers: the server bot may be running. Never two bots on one account. This bot does not start."; exit 1; fi
  echo "mac-local guard: ok (server check: $( [ $rc = 1 ] && echo 'no answer' || echo 'no address stored' ))"; exit 0
}

do_vps_proof() {  # stdin = the output of: ssh root@<server> "bash /root/vps-handoff.sh status"
  is_root || die "run this as root"
  local IN; IN=$(cat | tr -d '\r'); echo "$IN" | sed 's/^/  server said: /'
  local bad=""
  echo "$IN" | tail -1 | grep -qx 'VPS-STATE: OFF' || bad="$bad; the last line is not VPS-STATE: OFF"
  for u in $LIVE $PROXY; do echo "$IN" | grep -Eq "^  unit $u  active=(inactive|failed)  enabled=disabled\$" || bad="$bad; $u is not shown as inactive AND disabled"; done
  echo "$IN" | grep '^  unit ' | grep -Eq 'active=(active|activating|reloading)|enabled=(enabled|enabled-runtime)' && bad="$bad; a server unit is still active or enabled"
  echo "$IN" | grep -q 'process still running\|cron: ' && bad="$bad; a bot process or cron line is still on"
  local vt; vt=$(echo "$IN" | sed -n 's/^VPS-TIME: //p' | tail -1); local d=$(( $(date +%s) - ${vt:-0} ))
  [ -n "$vt" ] && [ "${d#-}" -le 120 ] || bad="$bad; the server's time stamp is missing or ${d#-} s away from this PC's clock (old output, or a wrong clock)"
  if [ -n "$bad" ]; then rm -f "$LST/vps-proof"; echo "STOP: no proof (${bad#; }). The local bot stays off. Nothing changed."; exit 1; fi
  mkdir -p "$LST"; date +%s > "$LST/vps-proof"
  echo "PROOF OK: the server bot is OFF and DISABLED (server clock within ${d#-} s of this PC). Valid for one start within 10 minutes."
}

ntfy() {  # best-effort push with the bot's own topic; never prints it
  local tp tk; tp=$(envval NTFY_TOPIC || true); [ -n "$tp" ] || return 0; tk=$(envval NTFY_TOKEN || true)
  curl -s -m 10 -o /dev/null ${tk:+-H "Authorization: Bearer $tk"} -H "Title: $1" -H "Priority: high" -d "$2" "$(tv MACLOCAL_NTFY_BASE https://ntfy.sh)/$tp" 2>/dev/null || true
}
do_tick() {
  local ro; ro=$(rtc_offset)
  if [ "$ro" != unknown ] && [ "${ro#-}" -gt 2 ]; then
    if [ "$TEST" = 0 ]; then hwclock -s 2>/dev/null || true; fi
    echo "mac-local tick: Linux clock was $ro s off the PC clock; set from the PC clock"
    local lp_; lp_=$(( $(date +%s) - $(cat "$LST/clockpush.last" 2>/dev/null || echo 0) ))
    if [ "${lp_#-}" -ge 1800 ]; then date +%s > "$LST/clockpush.last"; ntfy "PC clock corrected" "The Linux clock on your PC was $ro s off (did the PC sleep?). It is set again. Check the bot: mac-local check"; fi
  fi
  local url; url=$(conf_get DEADMAN_URL); [ -n "$url" ] || exit 0
  # ping = this PC, Linux and the internet are up AND (the bot's heartbeat is fresh OR the bot service is off on purpose, e.g. the weekend stop)
  local hb="$BOT/health-heartbeat-$SYM.json" fresh=0
  [ -f "$hb" ] && [ $(( $(date +%s) - $(stat -c %Y "$hb") )) -le 180 ] && fresh=1
  if [ "$fresh" = 1 ] || ! is_up "$LIVE"; then
    curl -fsS -m 10 -o /dev/null "$url" 2>/dev/null && date +%s > "$LST/deadman.last" || echo "mac-local tick: the outside-alarm ping did not go out"
  else echo "mac-local tick: bot service is on but its heartbeat is stale: no ping (the outside alarm will fire)"; fi
}
do_deadman() {
  is_root || die "run this as root"
  case "${1:-}" in
    off) conf_set DEADMAN_URL ""; echo "DONE: outside alarm off. If this PC sleeps, loses power or internet, NOTHING tells you.";;
    set) local u; read -r -p "Paste the ping address from your monitoring service (kept only on this PC): " u
         echo "$u" | grep -Eq '^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{8,300}$' || die "that does not look like a web address"
         curl -fsS -m 10 -o /dev/null "$u" 2>/dev/null || die "the address did not answer a test ping"
         conf_set DEADMAN_URL "$u"; date +%s > "$LST/deadman.last"; echo "DONE: test ping sent; from now a ping goes out every minute while the PC, Linux, the internet and the bot's heartbeat are all up.";;
    *) echo "usage: mac-local deadman set | off"; exit 1;;
  esac
}

do_vps_address() {
  is_root || die "run this as root"
  if [ "${1:-}" = none ]; then conf_set VPS_HOST ""; echo "DONE: server address forgotten; the two-bots guard is off."; exit 0; fi
  local h; read -r -p "Server address (the one after root@ in your old sheets; kept only on this PC): " h
  echo "$h" | grep -Eq '^[A-Za-z0-9.-]{3,253}$' || die "that does not look like an address"
  conf_set VPS_HOST "$h"
  local rc=0; vps_answers || rc=$?
  echo "stored. Right now the server's phone server $( [ $rc = 0 ] && echo 'ANSWERS (server bot on)' || echo 'does not answer (server bot off, or the address is wrong)' )."
  echo "DONE"
}

case "$MODE" in
  check) lvl=${2:-run}; check_base; case "$lvl" in bot|run) check_bot;; esac; [ "$lvl" = run ] && check_run
         echo "CHECK $lvl: $NP PASS, $NS STOP"; [ "$NS" = 0 ] ;;
  install) do_install ;;
  restore) do_restore "${2:-}" ;;
  start) do_start ;;
  stop) do_stop ;;
  status) state_lines; echo "LOCAL-TIME: $(date +%s)"; if local_state; then echo "LOCAL-STATE: OFF"; else echo "LOCAL-STATE: RUNNING"; fi ;;
  vps-proof) do_vps_proof ;;
  tick) do_tick ;;
  deadman) do_deadman "${2:-}" ;;
  guard) do_guard ;;
  vps-address) do_vps_address "${2:-}" ;;
  *) echo "usage: mac-local check [base|bot|run] | install | restore <bundle.tgz> | vps-proof | start | stop | status | vps-address [none] | deadman set|off"; exit 1 ;;
esac
