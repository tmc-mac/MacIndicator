#!/bin/bash
# TIDE Stage 2a rollback: puts back the 8 files exactly as they were before go.sh (from its backup) = the bot it replaced: lv1 r13.3.7 (executor 7245b251)
# or TIDE Stage 1 shadow (executor b6eaa9c2). Only when flat (type YES). TIDE live must be off first (bash tools/set-tide.sh off).
# lv1 r13.3.7 does not know the "tide" / "money" settings: if config-local.json has them it would refuse to start, so this stops first and says so
# (bash tools/set-tide.sh clear removes tide.mode; remove any other "tide" / "money" line by hand).
SRC=$(cd "$(dirname "$0")" && pwd); D=${MACBOT_DIR:-/opt/mac-bot}; SVC=mac-bot-live.service
NEWLIBS="lib/tideWire.js lib/moneyRule.js lib/structure.js lib/tideOrders.js lib/tideLive.js lib/tideRebuild.js"; REPL="live-executor.js lib/journalMeta.js"
FROM_SHA=7245b251eeef2be6248acc566fd3bf1e43e757a21bcee0b2230a21af6e7c3fb9
BK=$(cat "$D/.last-backup-tide2a" 2>/dev/null)
[ -n "$BK" ] && [ -f "$BK/live-executor.js" ] || { echo "No backup recorded. Nothing changed."; exit 1; }
FROMF=$(cat "$BK/FROM.name" 2>/dev/null); case "$FROMF" in FROM-r1337.sha256) FROMN="lv1 r13.3.7 (executor 7245b251)"; STAMPX=7245b251;; FROM-stage1.sha256) FROMN="TIDE Stage 1 shadow (executor b6eaa9c2)"; STAMPX=b6eaa9c2;; FROM-r1.sha256) FROMN="TIDE Stage 2a r1 (executor bddbc56f)"; STAMPX=bddbc56f;; FROM-r11.sha256) FROMN="TIDE Stage 2a r1.1 (executor 1e85324b)"; STAMPX=1e85324b;; FROM-r11a.sha256) FROMN="TIDE Stage 2a r1.1a (executor c0241a20)"; STAMPX=c0241a20;; FROM-r12.sha256) FROMN="TIDE Stage 2a r1.2 (executor e4470ad2)"; STAMPX=e4470ad2;; FROM-r13.sha256) FROMN="TIDE Stage 2a r1.3 (executor ae013d7f)"; STAMPX=ae013d7f;; FROM-r14.sha256) FROMN="TIDE Stage 2a r1.4 (executor ae013d7f)"; STAMPX=ae013d7f;; FROM-r15.sha256) FROMN="TIDE Stage 2a r1.5 (executor d5eb1f84)"; STAMPX=d5eb1f84;; FROM-r151.sha256) FROMN="TIDE Stage 2a r1.5.1 (executor f00e9720)"; STAMPX=f00e9720;; FROM-r152.sha256) FROMN="TIDE Stage 2a r1.5.2 (executor d0dc0042)"; STAMPX=d0dc0042;; FROM-r153.sha256) FROMN="TIDE Stage 2a r1.5.3 (executor eeff40e0)"; STAMPX=eeff40e0;; FROM-r154.sha256) FROMN="TIDE Stage 2a r1.5.4 (executor 275b061c)"; STAMPX=275b061c;; *) echo "STOP: the backup does not say which bot it holds. Nothing changed."; exit 1;; esac
(cd "$BK" && sha256sum -c "$SRC/$FROMF" --quiet) || { echo "STOP: the backup is not $FROMN. Nothing changed."; exit 1; }
(cd "$D" && sha256sum -c "$SRC/INSTALL.sha256" --quiet) || { echo "STOP: the installed files are not TIDE Stage 2a - something else changed them. Nothing changed. Send these lines to your assistant."; exit 1; }
if [ -e "$D/config-local.json" ] && python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); t=d.get("tide",{}) if isinstance(d,dict) else {}; m=d.get("money",{}) if isinstance(d,dict) else {}; s=m.get("sizing",{}) if isinstance(m,dict) else {}
r1337 = sys.argv[2] == "FROM-r1337.sha256"; s1 = sys.argv[2] == "FROM-stage1.sha256"
bad = ("tide" in d or "money" in d) if r1337 else (t.get("mode") == "live" or "liveArmed" in t or "oldPathEntries" in t or (isinstance(s,dict) and "take1MaxUsd" in s)) if s1 else False
bad = bad or ("staleR" in t and sys.argv[2] not in ("FROM-r153.sha256", "FROM-r154.sha256")) or ("climaxGate" in t and sys.argv[2] not in ("FROM-r151.sha256", "FROM-r152.sha256", "FROM-r153.sha256", "FROM-r154.sha256")) or (any(k in t for k in ("laneAccept", "controlFree", "nearestWins", "ltfOpens")) and sys.argv[2] != "FROM-r154.sha256") or (any(k in t for k in ("waveBiasTrend", "releaseOnRefusal", "controlAsBias")) and sys.argv[2] != "FROM-r155.sha256") or "htfAgainst" in t
sys.exit(0 if bad else 1)' "$D/config-local.json" "$FROMF" 2>/dev/null; then
  echo "STOP: config-local.json has settings $FROMN does not know (tide / money lines, tide.mode live, tide.liveArmed, tide.oldPathEntries, tide.climaxGate, tide.staleR, tide.laneAccept / controlFree / nearestWins / ltfOpens / waveBiasTrend / releaseOnRefusal / controlAsBias, tide.htfAgainst (r1.5.6: no earlier build knows it) or money.sizing.take1MaxUsd); it would refuse to start. Run  bash $SRC/tools/set-tide.sh htf=tag  (removes tide.htfAgainst),  bash $SRC/tools/set-tide.sh lanes=on  first (the r1.5.4 / r1.5.5 keys; to r1.5.2 or older also stale=on, which removes tide.staleR),  bash $SRC/tools/set-tide.sh climax=on  (tide.climaxGate, any build before r1.5.1),  bash $SRC/tools/set-tide.sh clear  (r13.3.7) or  bash $SRC/tools/set-tide.sh shadow  (Stage 1), remove any other such line by hand, then run this again. Nothing changed."; exit 1; fi
if [ -f "$D/flatcheck.sh" ]; then bash "$D/flatcheck.sh" "$D" || { echo "STOP: not flat (or cannot tell). Nothing changed."; exit 1; }; fi
read -r -p "NO open MNQ position and NO working MNQ orders in TopstepX? Type YES to roll back to $FROMN: " a
[ "$a" = YES ] || { echo "Nothing changed."; exit 1; }
OWN=$(stat -c %U "$D/live-executor.js"); GRP=$(stat -c %G "$D/live-executor.js")
systemctl stop "$SVC"
for f in $REPL; do install -m 644 -o "$OWN" -g "$GRP" "$BK/$f" "$D/$f"; done
for f in $NEWLIBS; do if [ -e "$BK/$f.absent" ]; then rm -f "${D:?}/${f:?}"; elif [ -e "$BK/$f" ]; then install -m 644 -o "$OWN" -g "$GRP" "$BK/$f" "$D/$f"; fi; done
(cd "$D" && sha256sum -c "$SRC/$FROMF" --quiet) || { echo "CHECK: the files are not $FROMN after the rollback. The bot is stopped. Send these lines to your assistant."; exit 1; }
T0=$(date '+%Y-%m-%d %H:%M:%S'); systemctl start "$SVC"
for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u "$SVC" --since "$T0" --no-pager 2>/dev/null); echo "$LOG" | grep -q "\[journal\] session stamp\|CONFIG-LOCAL ERROR\|FATAL" && break; systemctl is-active --quiet "$SVC" || break; done
if echo "$LOG" | grep "\[journal\] session stamp" | tail -1 | grep -q "executor $STAMPX"; then echo "$LOG" | grep "\[journal\] session stamp" | tail -1; echo "DONE: rolled back to $FROMN."
else echo "$LOG" | tail -20; echo "CHECK: $FROMN did not print its session stamp. Send these lines to your assistant."; exit 1; fi
