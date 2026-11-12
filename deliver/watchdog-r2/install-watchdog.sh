#!/usr/bin/env bash
# install-watchdog.sh - schedules the outside health watchdog (health-watchdog.js, already in the bot folder)
# with a systemd timer, once a minute. It adds two small unit files and nothing else.
# It NEVER starts, stops or restarts mac-bot-live or mac-bot-proxy and changes no bot file.
#
#   bash install-watchdog.sh           install (safe to run again)
#   bash install-watchdog.sh undo      disable the timer and remove both unit files
#   bash install-watchdog.sh proof     optional: send ONE test push from a throw-away folder (the bot folder is not used)
#
# Any failed check prints STOP and changes nothing.
set -euo pipefail

# The WD_* variables exist only for the test harness. On the server none is set and the real paths below are used.
BOT_DIR="${WD_BOT_DIR:-/opt/mac-bot}"
ENV_FILE="${WD_ENV_FILE:-/etc/mac-bot.env}"
UNIT_DIR="${WD_UNIT_DIR:-/etc/systemd/system}"
NODE="${WD_NODE:-/usr/bin/node}"
SYSTEMCTL="${WD_SYSTEMCTL:-systemctl}"
JOURNALCTL="${WD_JOURNALCTL:-journalctl}"
FRESH_S="${WD_FRESH_S:-300}"

SYMBOL=MNQ
BOT_UNIT=mac-bot-live.service
SVC=mac-bot-watchdog.service
TMR=mac-bot-watchdog.timer
WD_JS="$BOT_DIR/health-watchdog.js"
HB="$BOT_DIR/health-heartbeat-$SYMBOL.json"
STATE="$BOT_DIR/health-watchdog-state-$SYMBOL.json"
# sha256 of health-watchdog.js in edge r1.6 (7030 bytes)
WANT_SHA=31ca61ba59b95c45007f437054747848276fc4ca647777f81a2c6ecf17c68e14
UNDO_CMD="bash $(cd "$(dirname "$0")" && pwd)/$(basename "$0") undo"

for v in WD_BOT_DIR WD_ENV_FILE WD_UNIT_DIR WD_NODE WD_SYSTEMCTL WD_JOURNALCTL; do
  if [ -n "${!v:-}" ]; then echo "TEST MODE ($v is set): not the real server paths"; break; fi
done

stop() { echo "STOP: $1"; echo "Nothing was changed."; exit 1; }
sc() { "$SYSTEMCTL" "$@"; }

need_root() { [ "$(id -u)" = "0" ] || stop "run this as root (the same login you use for the bot installs)."; }

# ---------- undo ----------
do_undo() {
  sc disable --now "$TMR" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$SVC" "$UNIT_DIR/$TMR"
  sc daemon-reload || true
  sc reset-failed "$SVC" >/dev/null 2>&1 || true
}

# ---------- checks shared by install and proof ----------
check_node_and_watchdog() {
  [ -x "$NODE" ] || stop "node was not found at $NODE."
  "$NODE" -v >/dev/null 2>&1 || stop "node at $NODE does not run."
  [ -f "$WD_JS" ] || stop "$WD_JS is missing (the watchdog comes with edge r1.6)."
  local got; got="$(sha256sum "$WD_JS" | cut -d' ' -f1)"
  [ "$got" = "$WANT_SHA" ] || stop "$WD_JS is not the edge r1.6 file (sha256 starts ${got:0:8}, expected ${WANT_SHA:0:8})."
}
check_env() {
  [ -f "$ENV_FILE" ] || stop "$ENV_FILE is missing."
  # the value is never printed
  # at least one real character after optional quotes (NTFY_TOPIC="" is empty for systemd)
  grep -Eq "^[[:space:]]*NTFY_TOPIC=[\"']?[^[:space:]\"']" "$ENV_FILE" || stop "$ENV_FILE has no NTFY_TOPIC line with a value: there is nowhere to push to."
}

MODE="${1:-install}"
[ $# -le 1 ] || stop "too many arguments (use: install, undo or proof)."

case "$MODE" in
undo)
  need_root
  command -v "$SYSTEMCTL" >/dev/null 2>&1 || stop "systemctl was not found."
  do_undo
  echo "watchdog timer removed. The bot was not touched."
  echo "(the small file $STATE may remain; it is harmless)"
  echo "DONE"
  exit 0 ;;

proof)
  need_root
  check_node_and_watchdog
  check_env
  P="$(mktemp -d)"; trap 'rm -rf "$P"' EXIT
  # a pretend heartbeat, 11 minutes old, in a throw-away folder under the name PROOF
  "$NODE" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 1, t: Date.now() - 11 * 60000, pid: 0, live: true }))' "$P/health-heartbeat-PROOF.json"
  topic="$(sed -n 's/^[[:space:]]*NTFY_TOPIC=//p' "$ENV_FILE" | tail -n 1 | sed 's/[[:space:]]*$//')"; topic="${topic%\"}"; topic="${topic#\"}"; topic="${topic%\'}"; topic="${topic#\'}"
  token="$(sed -n 's/^[[:space:]]*NTFY_TOKEN=//p' "$ENV_FILE" | tail -n 1 | sed 's/[[:space:]]*$//')"; token="${token%\"}"; token="${token#\"}"; token="${token%\'}"; token="${token#\'}"
  line="$(NTFY_TOPIC="$topic" NTFY_TOKEN="$token" "$NODE" "$WD_JS" --dir "$P" --symbol PROOF)"
  echo "$line"
  case "$line" in
    *"-> sent"*) echo "PROOF OK: your phone should show \"MacMillionz PROOF: Bot NOT RUNNING (no heartbeat)\". It is only this test." ;;
    *"outside trading hours"*) echo "PROOF NOT RUN: it is outside trading hours, when the watchdog stays silent by design. Try again after 15:00 PT." ;;
    *) echo "PROOF FAILED: the push did not go out. Send me the line above." ;;
  esac
  echo "The bot and its folder were not touched."
  exit 0 ;;

install) ;;
*) stop "unknown word \"$MODE\" (use: install, undo or proof)." ;;
esac

# ---------- install: checks first, no change before all pass ----------
need_root
command -v "$SYSTEMCTL" >/dev/null 2>&1 || stop "systemctl was not found."
[ -d "$UNIT_DIR" ] || stop "$UNIT_DIR is missing."
[ "$(sc show -p LoadState --value "$BOT_UNIT" 2>/dev/null || true)" = "loaded" ] || stop "$BOT_UNIT was not found on this server."
# this installer reloads systemd; a bot or phone-server unit edited on disk and not reloaded yet would start to count then. Must read "no" for both.
RELOAD_SEEN=""
for u in "$BOT_UNIT" mac-bot-proxy.service; do
  nr="$(sc show -p NeedDaemonReload --value "$u" 2>/dev/null || true)"
  [ "$nr" != "yes" ] || stop "$u was edited on disk and not reloaded yet. This installer reloads systemd, which would make that edit count at the bot's next start. Send me this line first."
  [ "$nr" = "no" ] || stop "could not read whether $u has an edit waiting for a reload (expected \"no\", got \"$nr\")."
  RELOAD_SEEN="${RELOAD_SEEN:+$RELOAD_SEEN/}$nr"
done
for f in "$UNIT_DIR/$SVC" "$UNIT_DIR/$TMR"; do
  if [ -e "$f" ] && ! grep -q '^# Written by install-watchdog.sh' "$f"; then stop "$f already exists and was not written by this installer."; fi
done
check_node_and_watchdog
check_env
sc show -p EnvironmentFiles --value "$BOT_UNIT" 2>/dev/null | grep -Fq -- "$ENV_FILE" || stop "$BOT_UNIT does not use $ENV_FILE as its EnvironmentFile."
RUN_USER="$(sc show -p User --value "$BOT_UNIT" 2>/dev/null)" || stop "could not read User= from $BOT_UNIT."
if [ -n "$RUN_USER" ]; then
  printf '%s' "$RUN_USER" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' || stop "User= of $BOT_UNIT reads oddly."
fi
[ -f "$HB" ] || stop "$HB is missing: the bot is not writing its heartbeat (is it running edge r1.6?)."
age=$(( $(date +%s) - $(stat -c %Y "$HB") ))
[ "$age" -ge 0 ] && [ "$age" -le "$FRESH_S" ] || stop "the heartbeat is $age s old (must be under $FRESH_S s): the bot is not running right now. Run this while the bot is running (not between Friday 14:00 and Sunday 15:00 PT)."
echo "checks passed: node $("$NODE" -v), watchdog file is the edge r1.6 one, push settings present, heartbeat $age s old"
echo "unit edits waiting for a reload (bot/phone server): $RELOAD_SEEN"
# what is there now, so that a failure further down puts exactly this back
PRE=0; OLD_SVC=""; OLD_TMR=""; WAS_ACTIVE=0
if [ -f "$UNIT_DIR/$SVC" ] && [ -f "$UNIT_DIR/$TMR" ]; then
  PRE=1; OLD_SVC="$(cat "$UNIT_DIR/$SVC")"; OLD_TMR="$(cat "$UNIT_DIR/$TMR")"
  [ "$(sc is-active "$TMR" 2>/dev/null || true)" = "active" ] && WAS_ACTIVE=1
fi

# ---------- write the two unit files (only when they differ) ----------
svc_text() {
  cat <<EOF
# Written by install-watchdog.sh. Remove with: bash install-watchdog.sh undo
[Unit]
Description=Mac bot outside health watchdog (reads the heartbeat, pushes when it is stale; never touches the bot)

[Service]
Type=oneshot
${RUN_USER:+User=$RUN_USER
}WorkingDirectory=$BOT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $WD_JS --dir $BOT_DIR --symbol $SYMBOL
Nice=19
TimeoutStartSec=60
EOF
}
tmr_text() {
  cat <<EOF
# Written by install-watchdog.sh. Remove with: bash install-watchdog.sh undo
[Unit]
Description=Run the Mac bot health watchdog every minute

[Timer]
# At second 30 of every minute, EXCEPT Sunday 15:00:30 and 15:01:30 Pacific: the weekend timer starts the bot at
# Sunday 15:00 PT with up to a minute of slack, and trading hours open that same minute, so a run before the bot's
# first heartbeat would push a false "NOT RUNNING". First Sunday run after the open: 15:02:30.
OnCalendar=Mon..Sat *-*-* *:*:30 America/Los_Angeles
OnCalendar=Sun *-*-* 00..14:*:30 America/Los_Angeles
OnCalendar=Sun *-*-* 15:02..59:30 America/Los_Angeles
OnCalendar=Sun *-*-* 16..23:*:30 America/Los_Angeles
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
}

changed=0
put() { # put <path> <text>
  if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then return 0; fi
  printf '%s\n' "$2" > "$1.new" && chmod 644 "$1.new" && mv -f "$1.new" "$1" || { rm -f "$1.new"; return 1; }
  changed=1
}
fail_undo() {
  echo "PROBLEM: $1"
  if [ "$PRE" = "1" ]; then
    # a watchdog was installed before this run: put its two files back exactly and leave it as it was
    [ "$(cat "$UNIT_DIR/$SVC" 2>/dev/null)" = "$OLD_SVC" ] || printf '%s\n' "$OLD_SVC" > "$UNIT_DIR/$SVC" || true
    [ "$(cat "$UNIT_DIR/$TMR" 2>/dev/null)" = "$OLD_TMR" ] || printf '%s\n' "$OLD_TMR" > "$UNIT_DIR/$TMR" || true
    sc daemon-reload || true
    if [ "$WAS_ACTIVE" = "1" ]; then sc enable --now "$TMR" >/dev/null 2>&1 || true; [ "$tmr_changed" = "1" ] && { sc restart "$TMR" >/dev/null 2>&1 || true; }
    else sc disable --now "$TMR" >/dev/null 2>&1 || true; fi
    echo "KEPT: the watchdog that was installed before this run was left as it was (its two files are back as they were). The bot was not touched. Send me the lines above."
    exit 1
  fi
  do_undo
  echo "UNDO: the timer and both unit files were removed again. The bot was not touched. Send me the lines above."
  exit 1
}

tmr_changed=0
put "$UNIT_DIR/$SVC" "$(svc_text)" || fail_undo "could not write $UNIT_DIR/$SVC."
c0="$changed"; changed=0
put "$UNIT_DIR/$TMR" "$(tmr_text)" || fail_undo "could not write $UNIT_DIR/$TMR."
tmr_changed="$changed"; [ "$c0" = "1" ] && changed=1
if [ "$changed" = "1" ]; then echo "unit files written: $SVC, $TMR"; else echo "unit files already in place, unchanged"; fi

sc daemon-reload || fail_undo "systemctl daemon-reload failed."
sc enable --now "$TMR" >/dev/null 2>&1 || fail_undo "the timer could not be enabled."
# a timer that was already running keeps its old schedule until it is restarted (this restarts the watchdog's timer only)
if [ "$WAS_ACTIVE" = "1" ] && [ "$tmr_changed" = "1" ]; then sc restart "$TMR" >/dev/null 2>&1 || fail_undo "the timer could not take its new schedule."; fi
[ "$(sc is-active "$TMR" 2>/dev/null || true)" = "active" ] || fail_undo "the timer is not active."

# ---------- one run now, through the new unit (same user and settings as the timer will use) ----------
t0=$(( $(date +%s) - 1 ))
sc start "$SVC" || fail_undo "the watchdog did not run as a service."
line=""
for _ in 1 2 3 4 5; do
  line="$("$JOURNALCTL" -u "$SVC" --since "@$t0" -o cat --no-pager 2>/dev/null | grep 'health-watchdog' | tail -n 1 || true)"
  [ -n "$line" ] && break
  sleep 1
done
[ -n "$line" ] || fail_undo "the watchdog ran but printed no line."
echo "watchdog says: $line"
[ -f "$STATE" ] || fail_undo "the watchdog could not save its state file in $BOT_DIR (without it, it would push every minute)."
case "$line" in
  *"state not saved"*) fail_undo "the watchdog could not save its state file in $BOT_DIR (without it, it would push every minute)." ;;
  *"ok: heartbeat"*) ;;
  *) echo "NOTE: the line is not the usual \"ok: heartbeat ... s old\". Send it to me." ;;
esac

echo "The timer runs it every minute from now on (not Sunday 15:00-15:02 PT, while the bot starts). The bot was not started, stopped or restarted."
echo "To remove it: $UNDO_CMD"
echo "DONE"
