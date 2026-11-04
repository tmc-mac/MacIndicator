#!/bin/bash
# ONE COMMAND: TIDE STAGE 2a (the new lv1 model, LIVE-capable: off | shadow | live) on top of the INSTALLED lv1 r13.3.7 (executor 7245b251)
# or the INSTALLED TIDE Stage 2a shadow build (executor b6eaa9c2).
# Writes ONLY 8 files (+ lib/tideOrders.js, lib/tideLive.js, lib/tideRebuild.js, new): live-executor.js and lib/journalMeta.js (replaced; journalMeta records the new tide / money settings in the session stamp) and lib/tideWire.js,
# lib/moneyRule.js, lib/structure.js (new). NEVER config-local.json, NEVER mobile.html.
# As shipped the new model is OFF (tide.mode "off"): after the install the bot trades exactly as r13.3.7. Shadow is a separate step: bash tools/set-tide.sh shadow.
# Checks the upload, that the installed executor is 7245b251, that your config-local.json loads on the new bot, then ONLY WHEN FLAT (and you type YES):
# stop, back up the 8 files, install, start, verify the session stamp and the [tide] startup line. Any failure after the stop = automatic undo.
SRC=$(cd "$(dirname "$0")" && pwd); D=${MACBOT_DIR:-/opt/mac-bot}; SVC=mac-bot-live.service
SET="live-executor.js lib/journalMeta.js lib/tideWire.js lib/moneyRule.js lib/structure.js lib/tideOrders.js lib/tideLive.js lib/tideRebuild.js"; NEWLIBS="lib/tideWire.js lib/moneyRule.js lib/structure.js lib/tideOrders.js lib/tideLive.js lib/tideRebuild.js"; REPL="live-executor.js lib/journalMeta.js"
FROM_SHA=7245b251eeef2be6248acc566fd3bf1e43e757a21bcee0b2230a21af6e7c3fb9; FROM_S1=b6eaa9c2c44af4c3a30b7a8f24b621b7e837bbc8043a72cd32ce78b3de551cd9
line() { echo; echo "==================== $1 ===================="; }
cfgsum() { [ -e "$D/config-local.json" ] && sha256sum < "$D/config-local.json" | cut -c1-16 || echo ABSENT; }
pagesum() { [ -e "$D/mobile.html" ] && sha256sum < "$D/mobile.html" | cut -c1-16 || echo ABSENT; }
C0=$(cfgsum); M0=$(pagesum)
line "1/6 check the upload"
(cd "$SRC" && sha256sum -c SHA256SUMS.txt --quiet) && echo "ALL-FILES-OK" || { echo "STOP: the upload is damaged. Nothing changed."; exit 1; }
[ -f "$D/live-executor.js" ] || { echo "STOP: no bot found at $D. Nothing changed."; exit 1; }
WANT=$(grep '  live-executor.js$' "$SRC/INSTALL.sha256" | cut -c1-8)
line "2/6 which bot is installed?"
(cd "$D" && sha256sum -c "$SRC/INSTALL.sha256" --status 2>/dev/null) && { echo "Already installed: the 8 files already match TIDE Stage 2a (executor $WANT). Nothing to do."; exit 0; }
HAVE=$(sha256sum < "$D/live-executor.js" | cut -d' ' -f1)
if [ "$HAVE" = "$FROM_SHA" ]; then FROMF=FROM-r1337.sha256; FROMN="lv1 r13.3.7 (executor 7245b251)"; elif [ "$HAVE" = "$FROM_S1" ]; then FROMF=FROM-stage1.sha256; FROMN="TIDE Stage 1 shadow (executor b6eaa9c2)"; elif [ "$HAVE" = "bddbc56fb74e845562d1e8b3b4922424a76f2e0de6986b6fadc85dd16c5ebe6e" ]; then FROMF=FROM-r1.sha256; FROMN="TIDE Stage 2a r1 (executor bddbc56f)"; elif [ "$HAVE" = "1e85324b23edc9d6fddea0047695d676437913a21da5658b22804d1467693303" ]; then FROMF=FROM-r11.sha256; FROMN="TIDE Stage 2a r1.1 (executor 1e85324b)"; elif [ "$HAVE" = "c0241a205f427871541e8a2a499139ef928417c1425914ee64e56181ceef6b7c" ]; then FROMF=FROM-r11a.sha256; FROMN="TIDE Stage 2a r1.1a (executor c0241a20)"; elif [ "$HAVE" = "e4470ad293c5a1731cc5803bd6bec3602562dc8ab703f198b09edd1f3005923c" ]; then FROMF=FROM-r12.sha256; FROMN="TIDE Stage 2a r1.2 (executor e4470ad2)"; else
  echo "Installed executor: ${HAVE:0:8}"; echo "STOP: this package goes only on lv1 r13.3.7 (executor 7245b251), TIDE Stage 1 (executor b6eaa9c2) or TIDE Stage 2a r1 (executor bddbc56f) or TIDE Stage 2a r1.1 (executor 1e85324b) or TIDE Stage 2a r1.1a (executor c0241a20) or TIDE Stage 2a r1.2 (executor e4470ad2). Nothing changed. Send these lines to your assistant."; exit 1; fi
(cd "$D" && sha256sum -c "$SRC/$FROMF" --quiet) || { echo "STOP: the installed files are not exactly $FROMN. Nothing changed. Send these lines to your assistant."; exit 1; }
for f in $NEWLIBS; do [ -e "$D/$f" ] && echo "note: $f already exists ($(sha256sum < "$D/$f" | cut -c1-8)); it is backed up and replaced"; done
echo "Installed bot: $FROMN  ->  will become TIDE Stage 2a (executor $WANT, tide.mode as in your config-local.json; shipped off)"
STG="$SRC/stage"; rm -rf "${STG:?}"; mkdir -p "$STG/lib" || { echo "STOP: staging failed. Nothing changed."; exit 1; }
for f in $SET; do cp "$SRC/bot/$f" "$STG/$f" || { echo "STOP: staging failed. Nothing changed."; exit 1; }; done
(cd "$STG" && sha256sum -c "$SRC/INSTALL.sha256" --quiet) || { echo "STOP: staged files do not match. Nothing changed."; exit 1; }
line "3/6 check your settings on the new bot (read-only)"
for f in $SET; do node --check "$STG/$f" || { echo "STOP: syntax check failed ($f). Nothing changed."; exit 1; }; done
EXP="$STG/expected-tide-line.txt"
node "$SRC/check-local.cjs" "$STG" "$D/config-local.json" "expect=$EXP" || { echo "STOP: see the line above. Nothing changed. Send these lines to your assistant."; exit 1; }
[ -s "$EXP" ] && grep -q "^\[tide\] new model " "$EXP" || { echo "STOP: the startup line to expect could not be derived. Nothing changed."; exit 1; }
echo "After the restart the bot must print:"; cut -c1-160 "$EXP" | sed 's/^/   /'
line "4/6 flat check"
if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || { echo; echo "STOP: the bot is not flat (or cannot tell). Nothing changed. Run this again when flat:"; echo "    bash $SRC/go.sh"; exit 1; }; fi
echo; echo "Look at TopstepX now: NO open MNQ position and NO working MNQ orders (cancel any resting MNQ entry/stop/target first)."
read -r -p "Type YES to stop the bot and install (anything else = stop here, nothing changed): " a
[ "$a" = YES ] || { echo "Nothing changed."; exit 1; }
line "5/6 stop, back up, install"
BK="$D/.bak-tide2a-$(date +%Y%m%d-%H%M%S)-$$"; [ -e "$BK" ] && { echo "STOP: backup name already exists. Nothing changed."; exit 1; }
bkfail() { echo "STOP: backup failed. Nothing changed (the partial backup is left at $BK)."; exit 1; }
mkdir -p "$BK/lib" || bkfail
for f in $REPL; do { cp -a "$D/$f" "$BK/$f" && cmp -s "$D/$f" "$BK/$f"; } || bkfail; done
for f in $NEWLIBS; do if [ -e "$D/$f" ]; then { cp -a "$D/$f" "$BK/$f" && cmp -s "$D/$f" "$BK/$f"; } || bkfail; else : > "$BK/$f.absent" || bkfail; fi; done
sync
systemctl stop "$SVC" || { echo "STOP: could not stop $SVC. Nothing changed."; exit 1; }
echo "$FROMF" > "$BK/FROM.name"; echo "$FROMN" > "$BK/FROM.label"; echo "$BK" > "$D/.last-backup-tide2a"; echo "backup of the 8 files: $BK"
OWN=$(stat -c %U "$D/live-executor.js"); GRP=$(stat -c %G "$D/live-executor.js")
undo() { echo; echo "UNDO: putting back the 8 files as they were (from $BK) ..."; systemctl stop "$SVC"
  for f in $REPL; do install -m 644 -o "$OWN" -g "$GRP" "$BK/$f" "$D/$f"; done
  for f in $NEWLIBS; do if [ -e "$BK/$f.absent" ]; then rm -f "${D:?}/${f:?}"; else install -m 644 -o "$OWN" -g "$GRP" "$BK/$f" "$D/$f"; fi; done
  (cd "$D" && sha256sum -c "$SRC/$FROMF" --quiet) && systemctl start "$SVC" && echo "Old bot ($FROMN) restored and started. Send these lines to your assistant." || echo "UNDO INCOMPLETE - run: bash $SRC/rollback.sh"; exit 1; }
for f in $SET; do install -D -m 644 -o "$OWN" -g "$GRP" "$STG/$f" "$D/$f" || undo; done
(cd "$D" && sha256sum -c "$SRC/INSTALL.sha256" --quiet) || undo
echo "installed: executor $WANT, lib/journalMeta.js, lib/tideWire.js, lib/moneyRule.js, lib/structure.js, lib/tideOrders.js, lib/tideLive.js, lib/tideRebuild.js - every other file unchanged (config-local.json $C0, mobile.html $M0)"
line "6/6 start and verify"
T0=$(date '+%Y-%m-%d %H:%M:%S'); systemctl start "$SVC" || undo
echo "Waiting for the startup stamp (up to 2 min)..."
for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u "$SVC" --since "$T0" --no-pager 2>/dev/null); echo "$LOG" | grep -q "\[journal\] session stamp\|CONFIG-LOCAL ERROR\|FATAL" && break; systemctl is-active --quiet "$SVC" || break; done
systemctl is-active --quiet "$SVC" || { echo "$LOG" | tail -30; echo "FAIL: the bot is not running."; undo; }
echo "$LOG" | grep -q "CONFIG-LOCAL ERROR\|FATAL" && { echo "$LOG" | grep -A6 "CONFIG-LOCAL ERROR\|FATAL"; echo "FAIL: the bot refused to start."; undo; }
STAMP=$(echo "$LOG" | grep "\[journal\] session stamp" | tail -1)
if echo "$STAMP" | grep -q "executor $WANT"; then echo "$STAMP"; else echo "$LOG" | tail -30; echo "FAIL: no session stamp with executor $WANT."; undo; fi
while IFS= read -r L; do [ -n "$L" ] || continue; if echo "$LOG" | grep -qF -- "$L"; then echo "$L" | cut -c1-200; else echo "$LOG" | tail -30; echo "FAIL: the bot did not print the startup line your settings give: $L"; undo; fi; done < "$EXP"
echo "$LOG" | grep "\[config-local\]   tide\.\|\[config-local\]   money\." | head -8
[ "$(cfgsum)" = "$C0" ] && echo "config-local.json: unchanged" || echo "WARNING: config-local.json changed while go.sh ran (it never writes it). Tell your assistant."
[ "$(pagesum)" = "$M0" ] && echo "phone page (mobile.html): unchanged" || echo "WARNING: mobile.html changed while go.sh ran (it never writes it). Tell your assistant."
echo; echo "DONE: TIDE Stage 2a installed (executor $WANT). The new model is $(grep -q ': LIVE (' "$EXP" && echo 'LIVE (real TIDE orders)' || { grep -q 'SHADOW' "$EXP" && echo 'in SHADOW (journal + phone, never orders); to trade it: bash tools/set-tide.sh live' || echo 'OFF (the bot trades as r13.3.7); to trade it: bash tools/set-tide.sh live'; })."
