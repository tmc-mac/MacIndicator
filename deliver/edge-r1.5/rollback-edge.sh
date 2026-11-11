#!/bin/bash
# rollback-edge.sh <backup-folder> [--auto] [--full]
# Puts the bot back as the backup holds it: the baseline the install replaced (edge r1.4, executor 871d53ca, or edge r1.3, executor 4168e4bb; recorded in META.base / META.base8).
# config-local.json is never touched. r1.4 and r1.3 do not know sessionRunnerNy.lock: if config-local.json has that line, a plain rollback STOPs first (nothing changed)
# and tells you to run "bash <bot dir>/tools/set-runnerlock.sh clear" (flat) while edge r1.5 is still installed.
# Default: restores byte-for-byte ONLY the files the edge install touched (the edge files and any removed
# edge r1.3 files), and removes the files the install added (e.g. a new lib file). The bot's own state and config-local.json are not touched.
# --full: restores the whole bot dir to the backup (anything written since the install is reverted too).
# --auto: used by the installer when an install step fails (no prompt, no flat check: the bot is stopped by the installer).
# The bot is stopped for the restore and started again; the session stamp must show the executor in META.base8.
set -u
BK="${1:-}"; [ -n "$BK" ] || { echo "usage: bash rollback-edge.sh <backup-folder> [--auto] [--full]"; exit 1; }; shift
AUTO=0; FULL=0; for a in "$@"; do case "$a" in --auto) AUTO=1;; --full) FULL=1;; *) echo "unknown option $a"; exit 1;; esac; done
[ -d "$BK/bot" ] && [ -f "$BK/PRE-INSTALL.sha256" ] && [ -f "$BK/META.dir" ] || { echo "STOP: not a backup folder of this install. Nothing changed."; exit 1; }
D=$(cat "$BK/META.dir"); SVC=$(cat "$BK/META.svc"); BASE8=$(cat "$BK/META.base8"); BASEN=$(cat "$BK/META.base" 2>/dev/null || echo old)
line() { echo; echo "==================== $1 ===================="; }
fail() { echo "CHECK: $1. The bot is stopped. Send these lines to your assistant."; exit 1; }

line "check the backup"
(cd "$BK/bot" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | cmp -s - "$BK/PRE-INSTALL.sha256" || { echo "STOP: the backup does not match its own list. Nothing changed."; exit 1; }
echo "backup OK: $(wc -l < "$BK/PRE-INSTALL.sha256") files in $BK/bot (baseline: edge $BASEN, executor $BASE8)"
LOCKCFG=$(python3 -I - "$D/config-local.json" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: d = {}
t = d.get('sessionRunnerNy') if isinstance(d, dict) else None
print('LOCK' if isinstance(t, dict) and 'lock' in t else 'NO')
PY
)
if [ "$LOCKCFG" = LOCK ]; then
  if [ "$AUTO" -eq 0 ]; then echo "STOP: config-local.json has a sessionRunnerNy.lock line, which edge $BASEN refuses to start with. Nothing changed."
    echo "First (flat, while r1.5 is still installed): bash $D/tools/set-runnerlock.sh clear     then run this rollback again."; exit 1
  else echo "WARNING: config-local.json has a sessionRunnerNy.lock line; edge $BASEN may refuse to start with it."; fi
fi

if [ "$AUTO" -eq 0 ]; then
  if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || { echo "STOP: not flat (or cannot tell). Nothing changed."; exit 1; }; fi
  echo "NO open MNQ position and NO working MNQ orders in TopstepX?"
  read -r -p "Type YES to roll back to edge $BASEN (executor $BASE8): " a
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

line "config-local.json: not touched"

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
echo "DONE: rolled back to edge $BASEN (executor $BASE8)."
exit 0
