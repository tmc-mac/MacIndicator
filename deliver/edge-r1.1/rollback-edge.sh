#!/bin/bash
# rollback-edge.sh <backup-folder> [--auto] [--full]
# Puts the bot back as the backup holds it: the edge r1 build (executor 9f8bcb8c), or the ANYBASE base recorded in META.base8.
# config-local.json: only the tp1AtrShadow key are removed if present (a copy is kept in the backup folder).
# Default: restores byte-for-byte ONLY the files the edge install touched (the edge files and any removed
# edge r1 files), and removes the files the install added (e.g. a new lib file). The bot's own state is not touched; config-local.json only loses those two keys if present (see above).
# --full: restores the whole bot dir to the backup (anything written since the install is reverted too).
# --auto: used by the installer when an install step fails (no prompt, no flat check: the bot is stopped by the installer).
# The bot is stopped for the restore and started again; the session stamp must show the executor in META.base8 (9f8bcb8c unless ANYBASE).
set -u
BK="${1:-}"; [ -n "$BK" ] || { echo "usage: bash rollback-edge.sh <backup-folder> [--auto] [--full]"; exit 1; }; shift
AUTO=0; FULL=0; for a in "$@"; do case "$a" in --auto) AUTO=1;; --full) FULL=1;; *) echo "unknown option $a"; exit 1;; esac; done
[ -d "$BK/bot" ] && [ -f "$BK/PRE-INSTALL.sha256" ] && [ -f "$BK/META.dir" ] || { echo "STOP: not a backup folder of this install. Nothing changed."; exit 1; }
D=$(cat "$BK/META.dir"); SVC=$(cat "$BK/META.svc"); BASE8=$(cat "$BK/META.base8")
line() { echo; echo "==================== $1 ===================="; }
fail() { echo "CHECK: $1. The bot is stopped. Send these lines to your assistant."; exit 1; }

line "check the backup"
(cd "$BK/bot" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | cmp -s - "$BK/PRE-INSTALL.sha256" || { echo "STOP: the backup does not match its own list. Nothing changed."; exit 1; }
echo "backup OK: $(wc -l < "$BK/PRE-INSTALL.sha256") files in $BK/bot"

if [ "$AUTO" -eq 0 ]; then
  if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || { echo "STOP: not flat (or cannot tell). Nothing changed."; exit 1; }; fi
  echo "NO open MNQ position and NO working MNQ orders in TopstepX?"
  read -r -p "Type YES to roll back to the previous build (executor $BASE8): " a
  [ "$a" = YES ] || { echo "Nothing changed."; exit 1; }
fi

line "stop, restore, start"
systemctl stop "$SVC" || fail "could not stop $SVC"
if [ "$FULL" -eq 1 ]; then
  (cd "$D" && find . -type f | sed 's|^\./||' | sort) > "$BK/.now.list"
  sed 's|^\./||' "$BK/PRE-INSTALL.sha256" | awk '{print $2}' | sort > "$BK/.pre.list"
  comm -23 "$BK/.now.list" "$BK/.pre.list" | while IFS= read -r f; do rm -f "$D/$f" || fail "could not remove $f"; done
  cp -a "$BK/bot/." "$D/" || fail "full copy back failed"
else
  while IFS= read -r f; do [ -n "$f" ] || continue
    if [ -e "$BK/bot/$f" ]; then mkdir -p "$(dirname "$D/$f")" && cp -a "$BK/bot/$f" "$D/$f" || fail "could not restore $f"
    else rm -f "$D/$f" || fail "could not remove $f"; fi
  done < "$BK/TOUCHED.list"
fi

line "config-local: remove tp1AtrShadow if present (the previous build does not know these keys and would refuse to start)"
CL="$D/config-local.json"
if [ -f "$CL" ] && grep -qE '"(tp1AtrShadow)"' "$CL"; then
  cp -a "$CL" "$BK/config-local.before-rollback.json" || fail "could not back up config-local.json"
  python3 -c 'import json,sys;p=sys.argv[1];c=json.load(open(p));c.pop("tp1AtrShadow",None);t=p+".tmp";json.dump(c,open(t,"w"),indent=2);import os;os.replace(t,p)' "$CL" || fail "could not remove the new keys from config-local.json"
  echo "removed tp1AtrShadow from config-local.json (copy kept: $BK/config-local.before-rollback.json)"
else echo "config-local.json has neither key: unchanged"; fi

line "verify the restore byte-for-byte"
if [ "$FULL" -eq 1 ]; then
  (cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | cmp -s - "$BK/PRE-INSTALL.sha256" || fail "the bot dir is not the backup"
  echo "whole bot dir == backup ($(wc -l < "$BK/PRE-INSTALL.sha256") files)"
else
  BAD=0; while IFS= read -r f; do [ -n "$f" ] || continue
    EXP=$(awk -v p="./$f" '$2==p{print $1}' "$BK/PRE-INSTALL.sha256")
    if [ -n "$EXP" ]; then GOT=$(sha256sum < "$D/$f" 2>/dev/null | cut -d' ' -f1); [ "$GOT" = "$EXP" ] || { echo "DIFF $f"; BAD=1; }
    else [ ! -e "$D/$f" ] || { echo "STILL PRESENT $f"; BAD=1; }; fi
  done < "$BK/TOUCHED.list"
  [ "$BAD" -eq 0 ] || fail "touched files are not the backup"
  echo "touched files == backup ($(wc -l < "$BK/TOUCHED.list") paths)"
fi

line "start and check the stamp"
T0=$(date "+%Y-%m-%d %H:%M:%S"); systemctl start "$SVC" || fail "could not start $SVC"
for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u "$SVC" --since "$T0" --no-pager 2>/dev/null)
  echo "$LOG" | grep -q "session stamp\|FATAL" && break; systemctl is-active --quiet "$SVC" || break; done
systemctl is-active --quiet "$SVC" || { echo "$LOG" | tail -20; fail "the bot is not running after the rollback"; }
STAMP=$(echo "$LOG" | grep "session stamp" | tail -1)
echo "$STAMP" | grep -q "executor $BASE8" || { echo "$LOG" | tail -20; fail "no session stamp with executor $BASE8"; }
echo "$STAMP"
echo "DONE: rolled back to the previous build (executor $BASE8)."
exit 0
