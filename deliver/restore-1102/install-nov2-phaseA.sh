#!/bin/bash
# install-nov2-phaseA.sh <phaseA-tree-dir>
# Moves the live bot from TIDE r1.6.2 (executor a78c4f0c) to the Phase A Nov 2 tree (43 files, its SHA256SUMS).
# Ships with FROM-r162.sha256 and rollback-nov2-phaseA.sh in the same folder.
#   1. the installed managed files must match FROM-r162.sha256 exactly, else STOP (nothing changed)
#   2. the Phase A tree must match its SHA256SUMS, list exactly the files it ships, and ship no config-local.json / mobile.html
#   3. the flat check go.sh uses (flatcheck.sh, when present), then you type YES
#   4. stop the service, back up the WHOLE bot dir to a timestamped folder next to it, verify the backup
#   5. copy the Phase A files in; remove the managed r1.6.2 files the Phase A tree does not ship; nothing else
#   6. verify: the tree matches the Phase A SHA256SUMS, and every other file is unchanged (full before/after check);
#      start; the session stamp must show executor <Phase A executor sha8>
# Any failure after the stop = automatic rollback from that backup (rollback-nov2-phaseA.sh --auto).
# Env: MACBOT_DIR (required; no default), MACBOT_BACKUP_ROOT (default: the parent of MACBOT_DIR).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
[ -n "${1:-}" ] || { echo "usage: bash install-nov2-phaseA.sh <phaseA-tree-dir>"; exit 1; }
SRC=$(cd "$1" && pwd) || { echo "STOP: no such folder: $1"; exit 1; }
D=${MACBOT_DIR:?set MACBOT_DIR to the bot directory on the host}; SVC=mac-bot-live.service
BACKROOT=${MACBOT_BACKUP_ROOT:-$(dirname "$D")}
FROMF="$HERE/FROM-r162.sha256"; BASE8=a78c4f0c
WANT=$(sha256sum < "$SRC/live-executor.js" 2>/dev/null | cut -c1-8)
line() { echo; echo "==================== $1 ===================="; }
die() { echo "STOP: $1. Nothing changed."; exit 1; }

line "1/6 check the Phase A tree (read-only)"
[ -f "$SRC/SHA256SUMS" ] || die "the Phase A tree has no SHA256SUMS"
(cd "$SRC" && sha256sum -c SHA256SUMS --quiet) || die "the Phase A tree is damaged (SHA256SUMS)"
diff <(awk '{print $2}' "$SRC/SHA256SUMS" | sort) <(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort) >/dev/null \
  || die "the Phase A tree has files its SHA256SUMS does not list, or the reverse"
# the Phase A tree = the 43-file stamp map (STAMP-MAP-43.sha256) + exactly four extra files that the bot cannot start without.
# The four extras are pin-verified against the r13.3.5 build pin (PIN-r13.3.5-extra4.sha256); they are labelled PIN below.
STAMP43="$HERE/STAMP-MAP-43.sha256"; PIN="$HERE/PIN-r13.3.5-extra4.sha256"
[ -f "$STAMP43" ] && [ -f "$PIN" ] || die "STAMP-MAP-43.sha256 or PIN-r13.3.5-extra4.sha256 is missing next to this script"
(cd "$SRC" && sha256sum -c "$STAMP43" --quiet) || die "a stamp-map file (43-file map) does not match the stamp"
EXTRA=$(comm -23 <(awk '{print $2}' "$SRC/SHA256SUMS" | sort) <(awk '{print $2}' "$STAMP43" | sort) | sed '/^$/d')
[ "$(echo "$EXTRA" | sort)" = "$(awk '{print $2}' "$PIN" | sort)" ] || die "the files outside the 43-file stamp map are not exactly the four pinned files"
(cd "$SRC" && sha256sum -c "$PIN" --quiet) || die "a pin-verified file does not match the r13.3.5 pin"
echo "Phase A tree: 43 stamp-map files [STAMP-MAP] + 4 pin-verified files [PIN r13.3.5]: $(echo $EXTRA | tr '\n' ' ')"
for f in config-local.json mobile.html; do [ -e "$SRC/$f" ] && die "the Phase A tree ships $f, which this install never writes"; done
while IFS= read -r f; do case "$f" in *.js|*.cjs) node --check "$SRC/$f" >/dev/null 2>&1 || die "syntax check failed: $f";; esac
done < <(cd "$SRC" && find . -type f | sed 's|^\./||')
echo "Phase A tree OK: $(wc -l < "$SRC/SHA256SUMS") files, executor $WANT"

line "2/6 check the installed bot (read-only)"
[ -f "$D/live-executor.js" ] || die "no bot found at $D"
if ! (cd "$D" && sha256sum -c "$FROMF" --status 2>/dev/null); then
  (cd "$D" && sha256sum -c "$FROMF" 2>/dev/null | grep -v ': OK$')
  die "the installed managed files are not exactly TIDE r1.6.2 (the lines above differ)"
fi
echo "installed bot = TIDE r1.6.2 (executor $BASE8): all 9 managed files match FROM-r162.sha256"
# the Phase A loader is strict: an unknown top-level key in config-local.json makes the bot refuse to start.
# TIDE keeps its settings under "tide" and "money": clear them before the Phase A install (see the settings delta list).
if [ -f "$D/config-local.json" ]; then
  BADKEYS=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!c || typeof c!=="object" || Array.isArray(c)) { console.log("(not an object)"); process.exit(0); } console.log(Object.keys(c).filter(k => /^(tide|money)/i.test(k)).join(" "));' "$D/config-local.json" 2>/dev/null) \
    || die "config-local.json is not valid JSON"
  [ -z "$BADKEYS" ] || die "config-local.json has TIDE settings the Phase A bot does not know (top-level: $BADKEYS); it would refuse to start. Remove those keys first (tools/set-tide.sh clear for tide.mode; remove the rest by hand), then run this again"
  echo "config-local.json: no tide/money keys"
fi
MANAGED=$(awk '{print $2}' "$FROMF" | sort)
PHASE=$(awk '{print $2}' "$SRC/SHA256SUMS" | sort)
REMOVE=$(comm -23 <(echo "$MANAGED") <(echo "$PHASE") | sed '/^$/d')
echo "to be removed (managed r1.6.2 files the Phase A tree does not ship): ${REMOVE:-none}"
NEW=0; CHG=0; SAME=0
while IFS= read -r f; do
  S=$(sha256sum < "$SRC/$f" | cut -c1-64)
  if [ ! -e "$D/$f" ]; then NEW=$((NEW+1)); elif [ "$(sha256sum < "$D/$f" | cut -c1-64)" = "$S" ]; then SAME=$((SAME+1)); else CHG=$((CHG+1)); fi
done < <(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort)
echo "Phase A files: $SAME same, $CHG changed, $NEW added; removed: $(echo "$REMOVE" | sed '/^$/d' | wc -l)"

line "3/6 flat check and disk (read-only)"
if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || die "the bot is not flat (or cannot tell). Run this again when flat"; fi
NEED=$(( $(du -sb "$D" | cut -f1) + $(du -sb "$SRC" | cut -f1) ))
FREE=$(df -PB1 "$BACKROOT" | awk 'NR==2{print $4}')
[ $((FREE - NEED)) -ge 1073741824 ] || die "not enough disk: the backup needs about $NEED bytes and 1 GB must stay free ($FREE free)"
echo "flat check ok (or no flatcheck.sh); disk ok ($FREE bytes free)"
echo; echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders (cancel any resting MNQ entry/stop/target first)."
read -r -p "Type YES to stop the bot and install the Phase A tree (anything else = stop here, nothing changed): " a
[ "$a" = YES ] || { echo "Nothing changed."; exit 1; }

line "4/6 stop, back up the whole bot dir"
systemctl stop "$SVC" || die "could not stop $SVC"
BK="$BACKROOT/.nov2-phaseA-backup-$(date -u +%Y%m%d-%H%M%S)-$$"
case "$BK" in "$D"/*) echo "STOP: backup folder would be inside the bot dir."; systemctl start "$SVC"; exit 1;; esac
restart_only() { echo "STOP: $1. Nothing was changed on disk except the backup folder; the bot is started again."; systemctl start "$SVC"; exit 1; }
[ -e "$BK" ] && restart_only "backup name already exists"
mkdir -p "$BK" && cp -a "$D" "$BK/bot" || restart_only "backup copy failed (partial backup at $BK)"
(cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$BK/PRE-INSTALL.sha256" || restart_only "backup list failed"
(cd "$BK/bot" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | cmp -s - "$BK/PRE-INSTALL.sha256" || restart_only "backup does not match the bot dir"
cp "$FROMF" "$BK/FROM-r162.sha256"; cp "$SRC/SHA256SUMS" "$BK/PHASE-A.SHA256SUMS"
cp "$HERE/rollback-nov2-phaseA.sh" "$BK/rollback-nov2-phaseA.sh"
printf '%s\n' "$D" > "$BK/META.dir"; printf '%s\n' "$SVC" > "$BK/META.svc"; printf '%s\n' "$BASE8" > "$BK/META.base8"
{ (cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||'); echo "$REMOVE"; } | sed '/^$/d' | sort -u > "$BK/TOUCHED.list"
cp "$BK/TOUCHED.list" "$BK/skip.list"
echo "backup OK: $BK ($(wc -l < "$BK/PRE-INSTALL.sha256") files; rollback: bash $BK/rollback-nov2-phaseA.sh $BK)"

undo() { echo; echo "UNDO: rolling back from $BK ..."; bash "$BK/rollback-nov2-phaseA.sh" "$BK" --auto
  echo "The install did not complete (see above). The bot is on TIDE r1.6.2 again if the last line says DONE."; exit 1; }

line "5/6 install"
OWN=$(stat -c %U "$D/live-executor.js"); GRP=$(stat -c %G "$D/live-executor.js")
while IFS= read -r f; do [ -n "$f" ] || continue
  install -D -m "$(stat -c %a "$SRC/$f")" -o "$OWN" -g "$GRP" "$SRC/$f" "$D/$f" || { echo "install failed: $f"; undo; }
done < <(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort)
while IFS= read -r f; do [ -n "$f" ] || continue; rm -f "$D/$f" || { echo "remove failed: $f"; undo; }; done <<< "$REMOVE"
(cd "$D" && sha256sum -c "$SRC/SHA256SUMS" --quiet) || { echo "the installed tree does not match the Phase A SHA256SUMS"; undo; }
(cd "$D" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sed 's|  \./|  |' | sort > "$BK/.post.n" || undo
{ sed 's|  \./|  |' "$BK/PRE-INSTALL.sha256" | awk 'NR==FNR{skip[$0]=1; next} !($2 in skip)' "$BK/skip.list" -; cat "$SRC/SHA256SUMS"; } | sort > "$BK/.exp.n"
cmp -s "$BK/.post.n" "$BK/.exp.n" || { echo "files other than the Phase A set changed:"; diff "$BK/.exp.n" "$BK/.post.n" | head -20; undo; }
echo "installed: $(wc -l < "$SRC/SHA256SUMS") Phase A files match; $(echo "$REMOVE" | sed '/^$/d' | wc -l) managed files removed; every other file unchanged (config-local.json, state, flatcheck.sh, etc.)"

line "6/6 start and verify"
systemctl start "$SVC" || undo
T0=$(date '+%Y-%m-%d %H:%M:%S')
for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u "$SVC" --since "$T0" --no-pager 2>/dev/null)
  echo "$LOG" | grep -q "session stamp\|FATAL\|ERROR" && break; systemctl is-active --quiet "$SVC" || break; done
systemctl is-active --quiet "$SVC" || { echo "$LOG" | tail -30; echo "FAIL: the bot is not running."; undo; }
STAMP=$(echo "$LOG" | grep "session stamp" | tail -1)
if echo "$STAMP" | grep -q "executor $WANT"; then echo "$STAMP"; else echo "$LOG" | tail -30; echo "FAIL: no session stamp with executor $WANT."; undo; fi
echo
echo "DONE: Phase A tree installed (executor $WANT). Rollback to TIDE r1.6.2: bash $BK/rollback-nov2-phaseA.sh $BK"
exit 0
