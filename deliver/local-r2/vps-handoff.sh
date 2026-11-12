#!/bin/bash
# vps-handoff.sh - runs ON THE SERVER (the Linux VPS), as root. Part of the "bot to Mac's own PC" transfer (local r2: r1 + reviewer patch).
#   status   read-only. Prints one line per mac-bot unit and a last line  VPS-STATE: OFF  or  VPS-STATE: RUNNING
#   stop     flat check, asks YES, then stops AND disables every mac-bot unit (and comments out mac-bot cron lines)
#   pack     only when VPS-STATE is OFF: builds ONE private file with the whole bot folder, the env file(s) and the unit files
#   local-proof  reads the output of "mac-local status" from the PC (piped in over ssh): records that the PC bot is OFF and DISABLED
#   resume   the undo (needs a fresh local-proof): puts back exactly the units (and cron lines) that "stop" turned off, starts them, checks the start line
#   clean    deletes the bundle file from the server (it holds your broker key)
# It never prints a secret, never edits config-local.json, the journal or any bot file.
# Env: MACBOT_DIR (default /opt/mac-bot), MACLOCAL_WORK (default /root/maclocal).
set -euo pipefail
D=${MACBOT_DIR:-/opt/mac-bot}; W=${MACLOCAL_WORK:-/root/maclocal}; SYM=MNQ
MODE=${1:-}
ER=""; [ "${MACLOCAL_TEST:-0}" = 1 ] && ER=${MACLOCAL_ROOT:-}   # test rig only: where the sandbox keeps its /etc
die() { echo "STOP: $1. Nothing changed."; exit 1; }
line() { echo; echo "==================== $1 ===================="; }
[ "$(id -u)" = 0 ] || die "run this as root"
command -v systemctl >/dev/null || die "systemctl not found (this is not the server?)"

units() { systemctl list-unit-files --no-legend 'mac-bot*' 2>/dev/null | awk '{print $1}' | grep -E '\.(service|timer)$' | sort || true; }
is_on() { case "$(systemctl is-enabled "$1" 2>/dev/null || true)" in enabled|enabled-runtime) return 0;; *) return 1;; esac; }
is_up() { [ "$(systemctl is-active "$1" 2>/dev/null || true)" = active ]; }
procs() { pgrep -f 'live-executor\.js|tmc-proxy\.js' 2>/dev/null | tr '\n' ' ' || true; }
cronlines() { crontab -l 2>/dev/null | grep -v '^#MACLOCAL# ' | grep -v '^[[:space:]]*#' | grep -c 'mac-bot' || true; }
ordered_stop() { units | grep '\.timer$' || true; units | grep -x 'mac-bot-live\.service' || true; units | grep '\.service$' | grep -vx 'mac-bot-live\.service' || true; }

state() {  # prints the per-unit lines; returns 0 when everything is off
  local bad=0 u a e
  for u in $(units); do
    a=$(systemctl is-active "$u" 2>/dev/null || true); e=$(systemctl is-enabled "$u" 2>/dev/null || true)
    echo "  unit $u  active=${a:-unknown}  enabled=${e:-unknown}"
    case "$a" in inactive|failed) ;; *) bad=1;; esac; case "$e" in enabled|enabled-runtime) bad=1;; esac
  done
  local p; p=$(procs); [ -n "$p" ] && { echo "  bot/phone-server process still running: pid $p"; bad=1; }
  local c; c=$(cronlines); [ "$c" != 0 ] && { echo "  cron: $c active line(s) mention mac-bot"; bad=1; }
  return $bad
}

case "$MODE" in
status)
  [ -n "$(units)" ] || { echo "  no mac-bot units found on this machine"; echo "VPS-STATE: UNKNOWN"; exit 1; }
  echo "VPS-TIME: $(date +%s)"
  if state; then echo "VPS-STATE: OFF"; else echo "VPS-STATE: RUNNING"; fi
  ;;

local-proof)   # stdin = the output of "mac-local status" on the PC, piped in over ssh
  IN=$(cat | tr -d '\r'); echo "$IN" | sed 's/^/  PC said: /'; bad=""
  echo "$IN" | tail -1 | grep -qx 'LOCAL-STATE: OFF' || bad="$bad; the last line is not LOCAL-STATE: OFF"
  echo "$IN" | grep '^  unit ' | grep -Eq 'active=(active|activating|reloading)|enabled=(enabled|enabled-runtime)' && bad="$bad; a unit on the PC is still active or enabled"
  lt=$(echo "$IN" | sed -n 's/^LOCAL-TIME: //p' | tail -1); d=$(( $(date +%s) - ${lt:-0} ))
  [ -n "$lt" ] && [ "${d#-}" -le 120 ] || bad="$bad; the PC's time stamp is missing or ${d#-} s away from the server clock"
  mkdir -p "$W"; chmod 700 "$W"
  if [ -n "$bad" ]; then rm -f "$W/local-proof"; echo "STOP: no proof (${bad#; }). The server bot stays off. Nothing changed."; exit 1; fi
  date +%s > "$W/local-proof"; echo "PROOF OK: the bot on the PC is OFF and DISABLED. Valid for one resume within 10 minutes."
  ;;

stop)
  line "1/3 check (read-only)"
  [ -n "$(units)" ] || die "no mac-bot units found on this machine"
  [ -f "$D/live-executor.js" ] || die "no bot found at $D"
  if state >/dev/null; then echo "Already OFF:"; state || true; echo "VPS-STATE: OFF"; echo "DONE: nothing to do."; exit 0; fi
  state || true
  if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || die "the bot is not flat (or cannot tell). Run this again when flat"; echo "flat check ok"; else echo "no flatcheck.sh here: YOU confirm flat below"; fi
  echo; echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders."
  read -r -p "Type YES to stop the server bot and keep it off after a reboot (anything else = stop here, nothing changed): " a
  [ "$a" = YES ] || { echo "Nothing changed."; exit 1; }

  line "2/3 remember the state, then stop and disable"
  mkdir -p "$W"; chmod 700 "$W"
  if [ ! -f "$W/STATE.before" ]; then
    for u in $(units); do echo "$u $(systemctl is-enabled "$u" 2>/dev/null || true) $(systemctl is-active "$u" 2>/dev/null || true)"; done > "$W/STATE.before"
    echo "state remembered in $W/STATE.before ($(wc -l < "$W/STATE.before") units)"
  else echo "keeping the state remembered earlier ($W/STATE.before)"; fi
  for u in $(ordered_stop); do
    systemctl stop "$u" || echo "  could not stop $u"
    if is_on "$u"; then systemctl disable "$u" >/dev/null 2>&1 || echo "  could not disable $u"; fi
    echo "  stopped: $u"
  done
  if [ "$(cronlines)" != 0 ]; then
    [ -f "$W/crontab.before" ] || crontab -l > "$W/crontab.before"
    crontab -l | sed '/^#MACLOCAL# /!{/^[[:space:]]*#/!{/mac-bot/s/^/#MACLOCAL# /}}' | crontab -
    echo "  cron lines that mention mac-bot are commented out (original kept in $W/crontab.before)"
  fi
  sleep 2

  line "3/3 verify"
  if state; then echo "VPS-STATE: OFF"; echo "DONE: the server bot is OFF and will not start at a reboot. Undo: bash $0 resume"
  else echo "VPS-STATE: RUNNING"; echo "STOP: something above is still on. Do NOT start the bot on your PC. Send these lines."; exit 1; fi
  ;;

pack)
  line "1/3 check (read-only)"
  [ -n "$(units)" ] || die "no mac-bot units found on this machine"
  state || die "the server bot is not fully OFF (lines above). Run: bash $0 stop"
  echo "VPS-STATE: OFF"
  for f in live-executor.js tmc-proxy.js config-local.json "trade-journal-$SYM.jsonl"; do [ -s "$D/$f" ] || die "$D/$f is missing or empty"; done
  NEED=$(( $(du -sb "$D" | cut -f1) + 209715200 )); mkdir -p "$W"; chmod 700 "$W"
  FREE=$(df -PB1 "$W" | awk 'NR==2{print $4}')
  [ "$FREE" -ge "$NEED" ] || die "not enough disk for the bundle: needs up to $NEED bytes, $FREE free"
  echo "disk ok ($FREE bytes free)"

  line "2/3 collect"
  ST="$W/stage"; rm -rf "${ST:?}"; mkdir -p "$ST/meta/systemd" "$ST/meta/envfiles"
  : > "$ST/meta/UNITS.txt"; : > "$ST/meta/ENVFILES.txt"
  for u in $(units); do
    fp=$(systemctl show -p FragmentPath --value "$u" 2>/dev/null || true)
    [ -n "$fp" ] && [ -f "$fp" ] || die "cannot find the unit file of $u"
    cp "$fp" "$ST/meta/systemd/$u"
    for dp in $(systemctl show -p DropInPaths --value "$u" 2>/dev/null || true); do
      [ -f "$dp" ] || continue; mkdir -p "$ST/meta/systemd/$u.d"; cp "$dp" "$ST/meta/systemd/$u.d/$(basename "$dp")"
    done
    echo "$u" >> "$ST/meta/UNITS.txt"
    { grep -h '^[[:space:]]*EnvironmentFile=' "$ST/meta/systemd/$u" "$ST/meta/systemd/$u.d"/*.conf 2>/dev/null || true; } | sed 's/^[^=]*=//; s/^-//' | while IFS= read -r ef; do
      [ -n "$ef" ] && [ -f "$ER$ef" ] || continue
      grep -qxF "$ef" "$ST/meta/ENVFILES.txt" && continue
      mkdir -p "$ST/meta/envfiles$(dirname "$ef")"; cp -p "$ER$ef" "$ST/meta/envfiles$ef"; echo "$ef" >> "$ST/meta/ENVFILES.txt"
    done
  done
  [ -f "$ST/meta/systemd/mac-bot-live.service" ] || die "mac-bot-live.service is not among the units"
  [ -s "$ST/meta/ENVFILES.txt" ] || die "no EnvironmentFile found in the unit files (where are the broker settings? tell your assistant)"
  cp "$W/STATE.before" "$ST/meta/STATE.before" 2>/dev/null || { for u in $(units); do echo "$u unknown unknown"; done > "$ST/meta/STATE.before"; }
  [ -f "$W/crontab.before" ] && { grep 'mac-bot' "$W/crontab.before" | grep -v '^[[:space:]]*#' > "$ST/meta/CRON.txt" || true; }
  NODE=$(command -v node || true)
  { echo "packed_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "node_path=$NODE"; echo "node_version=$([ -n "$NODE" ] && "$NODE" -v || echo none)"
    echo "os=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
    echo "timezone=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
    echo "mem_total_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo)"; echo "swap_total_kb=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)"
    echo "bot_dir=$D"; echo "bot_files=$(find "$D" -type f | wc -l)"; echo "bot_bytes=$(du -sb "$D" | cut -f1)"
    echo "journal_bytes=$(stat -c %s "$D/trade-journal-$SYM.jsonl")"
    echo "executor_sha8=$(sha256sum < "$D/live-executor.js" | cut -c1-8)"
    echo "page_sha8=$([ -f "$D/mobile.html" ] && sha256sum < "$D/mobile.html" | cut -c1-8 || echo none)"
    echo "owner=$(stat -c %U:%G "$D/live-executor.js")"
  } > "$ST/meta/FACTS.txt"
  (cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$ST/meta/MANIFEST.bot.sha256"
  echo "collected: $(wc -l < "$ST/meta/MANIFEST.bot.sha256") bot files, $(wc -l < "$ST/meta/UNITS.txt") unit(s), $(wc -l < "$ST/meta/ENVFILES.txt") env file(s)"

  line "3/3 pack and verify"
  B="$W/maclocal-bundle.tgz"; rm -f "$B" "$B.sha256"
  ( umask 077; tar -czf "$B" -C "$ST" meta -C "$(dirname "$D")" --transform "s|^$(basename "$D")|botdir|" "$(basename "$D")" )
  (cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | cmp -s - "$ST/meta/MANIFEST.bot.sha256" || { rm -f "$B"; die "a bot file changed while packing (is something still writing?). The bundle was deleted; run pack again"; }
  tar -tzf "$B" >/dev/null || { rm -f "$B"; die "the bundle does not read back"; }
  (cd "$W" && sha256sum maclocal-bundle.tgz > maclocal-bundle.tgz.sha256); chmod 600 "$B" "$B.sha256"; rm -rf "${ST:?}"
  echo "facts: $(tar -xzOf "$B" meta/FACTS.txt | grep -E '^(node_version|executor_sha8|page_sha8|journal_bytes|bot_files)=' | tr '\n' ' ')"
  echo "BUNDLE: $B  $(stat -c %s "$B") bytes  sha256 $(cut -c1-8 "$B.sha256" | tr a-f A-F)"
  echo "DONE: bundle ready. It holds your broker key: copy it only to your own PC, then run: bash $0 clean"
  ;;

resume)
  line "1/2 check (read-only)"
  [ -f "$W/STATE.before" ] || die "no remembered state ($W/STATE.before): this script did not stop the bot"
  echo "Units to put back:"; awk '{print "  "$1"  was enabled="$2" active="$3}' "$W/STATE.before"
  pa=$(( $(date +%s) - $(cat "$W/local-proof" 2>/dev/null || echo 0) ))
  [ "$pa" -le 600 ] || die "no fresh proof that the bot on your PC is OFF and DISABLED. Run the PC proof line of the sheet (stage G) first; it is valid for 10 minutes"
  echo "PC proof: OFF and DISABLED, checked $pa s ago"
  echo; echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders."
  echo "NOTE: the server still has the journal and state from the moment it was stopped. If the PC bot traded since, tell your assistant first."
  read -r -p "Type YES to start the server bot again (anything else = stop here, nothing changed): " a
  [ "$a" = YES ] || { echo "Nothing changed."; exit 1; }
  rm -f "$W/local-proof"

  line "2/2 enable, start, verify"
  if [ -f "$W/crontab.before" ]; then crontab "$W/crontab.before" && echo "  cron lines restored"; fi
  T0=$(date '+%Y-%m-%d %H:%M:%S')
  { grep '\.service ' "$W/STATE.before" | grep -v '^mac-bot-live\.service ' || true; grep '^mac-bot-live\.service ' "$W/STATE.before" || true; grep '\.timer ' "$W/STATE.before" || true; } | while read -r u e a; do
    case "$e" in enabled|enabled-runtime) systemctl enable "$u" >/dev/null 2>&1 || echo "  could not enable $u";; esac
    case "$u" in *.timer) [ "$a" = active ] && [ "${MACLOCAL_TEST:-0}" != 1 ] && [ -d /var/lib/systemd/timers ] && touch "/var/lib/systemd/timers/stamp-$u" 2>/dev/null || true;; esac   # no catch-up run at this start
    [ "$a" = active ] && { systemctl start "$u" || echo "  could not start $u"; }
    echo "  back: $u (enabled=$e active=$a)"
  done
  LOG=""; for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u mac-bot-live.service --since "$T0" --no-pager 2>/dev/null || true)
    echo "$LOG" | grep -q "session stamp\|FATAL" && break; done
  echo "$LOG" | grep -E "session stamp|Entering live loop|FATAL" | tail -4 || true
  if is_up mac-bot-live.service && echo "$LOG" | grep -q "session stamp"; then echo "VPS-STATE: RUNNING"; echo "DONE: the server bot is back (check the phone page)."
  else echo "STOP: the server bot did not show its start line. Send these lines."; exit 1; fi
  ;;

clean)
  rm -f "$W/maclocal-bundle.tgz" "$W/maclocal-bundle.tgz.sha256"; rm -rf "${W:?}/stage"
  echo "DONE: bundle removed from the server (the remembered state for 'resume' is kept)."
  ;;

*) echo "usage: bash vps-handoff.sh status | stop | pack | local-proof | resume | clean"; exit 1;;
esac
