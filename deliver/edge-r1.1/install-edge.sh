#!/bin/bash
# install-edge.sh <botfix-tree-dir>
# Moves the live bot from the edge r1 build (executor 9f8bcb8c) to the edge r1.1 tree
# (edge r1.1: scorecard + record-only shadows + three safety fixes; on top of edge r1).
# Ships with FROM-edge-r1.sha256 and rollback-edge.sh in the same folder.
#   1. the edge tree must match its SHA256SUMS, list exactly the files it ships, pass node --check, and ship no config-local.json / mobile.html
#   2. the installed files must match FROM-edge-r1.sha256 exactly (ANYBASE=1 skips this), else STOP (nothing changed)
#   3. the flat check go.sh uses (flatcheck.sh, when present), then you type YES
#   4. stop the service, back up the WHOLE bot dir to a timestamped folder next to it, verify the backup
#   5. copy the edge files in; remove only edge r1 files the edge tree does not ship (normally none); nothing else
#   6. verify: the tree matches the edge SHA256SUMS, and every other file is unchanged (full before/after check);
#      start; the session stamp must show the NEW executor sha8
# Any failure after the stop = automatic rollback from that backup (rollback-edge.sh --auto).
# config-local.json is never written. Env: MACBOT_DIR (required; no default), MACBOT_BACKUP_ROOT (default: the parent of MACBOT_DIR).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
[ -n "${1:-}" ] || { echo "usage: bash install-edge.sh <botfix-tree-dir>"; exit 1; }
SRC=$(cd "$1" && pwd) || { echo "STOP: no such folder: $1"; exit 1; }
D=${MACBOT_DIR:?set MACBOT_DIR to the bot directory on the host}; SVC=mac-bot-live.service
BACKROOT=${MACBOT_BACKUP_ROOT:-$(dirname "$D")}
FROMF="$HERE/FROM-edge-r1.sha256"; BASE8=9f8bcb8c
WANT=$(sha256sum < "$SRC/live-executor.js" 2>/dev/null | cut -c1-8)
line() { echo; echo "==================== $1 ===================="; }
die() { echo "STOP: $1. Nothing changed."; exit 1; }

line "1/6 check the edge tree (read-only)"
[ -f "$FROMF" ] || die "FROM-edge-r1.sha256 is missing next to this script"
[ -f "$HERE/rollback-edge.sh" ] || die "rollback-edge.sh is missing next to this script"
[ -f "$SRC/SHA256SUMS" ] || die "the edge tree has no SHA256SUMS"
(cd "$SRC" && sha256sum -c SHA256SUMS --quiet) || die "the edge tree is damaged (SHA256SUMS)"
diff <(awk '{print $2}' "$SRC/SHA256SUMS" | sort) <(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort) >/dev/null \
  || die "the edge tree has files its SHA256SUMS does not list, or the reverse"
for f in config-local.json mobile.html; do [ -e "$SRC/$f" ] && die "the edge tree ships $f, which this install never writes"; done
while IFS= read -r f; do case "$f" in *.js|*.cjs) node --check "$SRC/$f" >/dev/null 2>&1 || die "syntax check failed: $f";; esac
done < <(cd "$SRC" && find . -type f | sed 's|^\./||')
[ -n "$WANT" ] && [ "$WANT" != "$BASE8" ] || die "the edge tree has no new live-executor.js (executor ${WANT:-none})"
echo "edge tree OK: $(wc -l < "$SRC/SHA256SUMS") files, executor $WANT"

line "2/6 check the installed bot (read-only)"
[ -f "$D/live-executor.js" ] || die "no bot found at $D"
if [ "${ANYBASE:-0}" = 1 ]; then
  BASE8=$(sha256sum < "$D/live-executor.js" | cut -c1-8)
  echo "ANYBASE=1: the installed bot is not checked against the edge r1 build. Installed executor: $BASE8."
  echo "The whole bot dir is backed up first; rollback puts back exactly what is there now (executor $BASE8)."
elif ! (cd "$D" && sha256sum -c "$FROMF" --status 2>/dev/null); then
  (cd "$D" && sha256sum -c "$FROMF" 2>/dev/null | grep -v ': OK$')
  die "the installed files are not exactly the edge r1 build (executor 9f8bcb8c, 56 files; the lines above differ). If you know what is installed, run again with ANYBASE=1"
else
  echo "installed bot = edge r1 build (executor $BASE8): all $(wc -l < "$FROMF") files match FROM-edge-r1.sha256"
fi
MANAGED=$(awk '{print $2}' "$FROMF" | sort)
TARGET=$(awk '{print $2}' "$SRC/SHA256SUMS" | sort)
REMOVE=$(comm -23 <(echo "$MANAGED") <(echo "$TARGET") | sed '/^$/d' | while IFS= read -r f; do [ -e "$D/$f" ] && echo "$f"; done)
echo "to be removed (edge r1 files the edge tree does not ship): ${REMOVE:-none}"
NEW=0; CHG=0; SAME=0
while IFS= read -r f; do
  S=$(sha256sum < "$SRC/$f" | cut -c1-64)
  if [ ! -e "$D/$f" ]; then NEW=$((NEW+1)); echo "  added:   $f"
  elif [ "$(sha256sum < "$D/$f" | cut -c1-64)" = "$S" ]; then SAME=$((SAME+1))
  else CHG=$((CHG+1)); echo "  changed: $f"; fi
done < <(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort)
echo "edge files: $SAME same, $CHG changed, $NEW added; removed: $(echo "$REMOVE" | sed '/^$/d' | wc -l)"

line "3/6 flat check and disk (read-only)"
if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || die "the bot is not flat (or cannot tell). Run this again when flat"; fi
NEED=$(( $(du -sb "$D" | cut -f1) + $(du -sb "$SRC" | cut -f1) ))
FREE=$(df -PB1 "$BACKROOT" | awk 'NR==2{print $4}')
[ $((FREE - NEED)) -ge 1073741824 ] || die "not enough disk: the backup needs about $NEED bytes and 1 GB must stay free ($FREE free)"
echo "flat check ok (or no flatcheck.sh); disk ok ($FREE bytes free)"
echo; echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders (cancel any resting MNQ entry/stop/target first)."
read -r -p "Type YES to stop the bot and install edge r1.1 (anything else = stop here, nothing changed): " a
[ "$a" = YES ] || { echo "Nothing changed."; exit 1; }

line "4/6 stop, back up the whole bot dir"
systemctl stop "$SVC" || die "could not stop $SVC"
BK="$BACKROOT/.edge11-backup-$(date -u +%Y%m%d-%H%M%S)-$$"
case "$BK" in "$D"/*) echo "STOP: backup folder would be inside the bot dir."; systemctl start "$SVC"; exit 1;; esac
restart_only() { echo "STOP: $1. Nothing was changed on disk except the backup folder; the bot is started again."; systemctl start "$SVC"; exit 1; }
[ -e "$BK" ] && restart_only "backup name already exists"
mkdir -p "$BK" && cp -a "$D" "$BK/bot" || restart_only "backup copy failed (partial backup at $BK)"
(cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$BK/PRE-INSTALL.sha256" || restart_only "backup list failed"
(cd "$BK/bot" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | cmp -s - "$BK/PRE-INSTALL.sha256" || restart_only "backup does not match the bot dir"
cp "$FROMF" "$BK/FROM-edge-r1.sha256"; cp "$SRC/SHA256SUMS" "$BK/EDGE.SHA256SUMS"
cp "$HERE/rollback-edge.sh" "$BK/rollback-edge.sh"
printf '%s\n' "$D" > "$BK/META.dir"; printf '%s\n' "$SVC" > "$BK/META.svc"; printf '%s\n' "$BASE8" > "$BK/META.base8"
{ (cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||'); echo "$REMOVE"; } | sed '/^$/d' | sort -u > "$BK/TOUCHED.list"
cp "$BK/TOUCHED.list" "$BK/skip.list"
echo "backup OK: $BK ($(wc -l < "$BK/PRE-INSTALL.sha256") files)"
echo "BACKUP FOLDER: $BK"

undo() { echo; echo "UNDO: rolling back from $BK ..."; bash "$BK/rollback-edge.sh" "$BK" --auto
  echo "The install did not complete (see above). The bot is back on the build it had before (executor $BASE8) if the last line says DONE."; exit 1; }

line "5/6 install"
OWN=$(stat -c %U "$D/live-executor.js"); GRP=$(stat -c %G "$D/live-executor.js")
while IFS= read -r f; do [ -n "$f" ] || continue
  install -D -m "$(stat -c %a "$SRC/$f")" -o "$OWN" -g "$GRP" "$SRC/$f" "$D/$f" || { echo "install failed: $f"; undo; }
done < <(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort)
while IFS= read -r f; do [ -n "$f" ] || continue; rm -f "$D/$f" || { echo "remove failed: $f"; undo; }; done <<< "$REMOVE"
(cd "$D" && sha256sum -c "$SRC/SHA256SUMS" --quiet) || { echo "the installed tree does not match the edge SHA256SUMS"; undo; }
(cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sed 's|  \./|  |' | sort > "$BK/.post.n" || undo
{ sed 's|  \./|  |' "$BK/PRE-INSTALL.sha256" | awk 'NR==FNR{skip[$0]=1; next} !($2 in skip)' "$BK/skip.list" -; cat "$SRC/SHA256SUMS"; } | sort > "$BK/.exp.n"
cmp -s "$BK/.post.n" "$BK/.exp.n" || { echo "files other than the edge set changed:"; diff "$BK/.exp.n" "$BK/.post.n" | head -20; undo; }
echo "installed: $(wc -l < "$SRC/SHA256SUMS") edge files match; $(echo "$REMOVE" | sed '/^$/d' | wc -l) files removed; every other file unchanged (config-local.json, state, flatcheck.sh, etc.)"

line "6/6 start and verify"
T0=$(date '+%Y-%m-%d %H:%M:%S')
systemctl start "$SVC" || undo
for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u "$SVC" --since "$T0" --no-pager 2>/dev/null)
  echo "$LOG" | grep -q "session stamp\|FATAL\|ERROR" && break; systemctl is-active --quiet "$SVC" || break; done
systemctl is-active --quiet "$SVC" || { echo "$LOG" | tail -30; echo "FAIL: the bot is not running."; undo; }
STAMP=$(echo "$LOG" | grep "session stamp" | tail -1)
if echo "$STAMP" | grep -q "executor $WANT"; then echo "$STAMP"; else echo "$LOG" | tail -30; echo "FAIL: no session stamp with executor $WANT."; undo; fi
echo
echo "DONE: edge r1.1 installed (executor $WANT). Rollback to the previous build (executor $BASE8): bash $BK/rollback-edge.sh $BK"
exit 0
