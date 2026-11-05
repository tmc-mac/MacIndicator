#!/bin/bash
# set-tide-money.sh (money-r4.1): Mac's sizing switches in config-local.json, one paste, atomic. Run it ONLY when FLAT.
# Sets any of money.sizing.mode (flat | grade), money.sizing.flatDollars (whole dollars 100-2000), money.sizing.noFit (skip | take1) and
# money.sizing.nearFloor.enabled (on | off). Only the keys you name change; every other key in config-local.json (and in its "money") stays as it was.
#   bash set-tide-money.sh mode=grade
#   bash set-tide-money.sh mode=flat flat=450 nofit=skip nearfloor=off
#   bash set-tide-money.sh flat=400 take1max=400      (take1max: 1 MNQ is taken over budget only while its risk <= this many dollars; Stage 2a)
# It restarts the bot and checks the bot's own "[money] config" startup line shows every value asked; anything else puts the backup back and restarts.
# Backup of config-local.json is made first and printed. Any failure puts the backup back and restarts the bot (shared core below, byte-identical to
# set-stop25.sh / set-retest.sh r13.6.1). The near-floor guard only caps the size near the trailing floor: it is NOT a daily loss limit.
set -u
D=${MACBOT_DIR:-/opt/mac-bot}; SVC=mac-bot-live.service; CFG="$D/config-local.json"; TAG=tide-money
usage() { echo "usage: bash set-tide-money.sh [mode=flat|grade] [flat=<whole dollars 100-2000>] [nofit=skip|take1] [nearfloor=on|off] [take1max=<whole dollars 100-2000>]   (one or more; run only when FLAT)"; }
no() { echo "STOP: $1"; usage; echo "Nothing changed."; exit 1; }
MODE=""; FLAT=""; NOFIT=""; NEAR=""; T1MAX=""
[ $# -ge 1 ] || no "no setting given."
for a in "$@"; do
  case "$a" in
    mode=*)      [ -z "$MODE" ] || no "mode given twice."; v=${a#mode=}; case "$v" in flat|grade) MODE=$v;; *) no "mode must be flat or grade, got '$v'.";; esac;;
    flat=*)      [ -z "$FLAT" ] || no "flat given twice."; v=${a#flat=}
                 [[ "$v" =~ ^[1-9][0-9]{2,3}$ ]] && [ "$v" -ge 100 ] && [ "$v" -le 2000 ] || no "flat must be whole dollars from 100 to 2000, got '$v'."; FLAT=$v;;
    nofit=*)     [ -z "$NOFIT" ] || no "nofit given twice."; v=${a#nofit=}; case "$v" in skip|take1) NOFIT=$v;; *) no "nofit must be skip or take1, got '$v'.";; esac;;
    nearfloor=*) [ -z "$NEAR" ] || no "nearfloor given twice."; v=${a#nearfloor=}; case "$v" in on|off) NEAR=$v;; *) no "nearfloor must be on or off, got '$v'.";; esac;;
    take1max=*)  [ -z "$T1MAX" ] || no "take1max given twice."; v=${a#take1max=}
                 [[ "$v" =~ ^[1-9][0-9]{2,3}$ ]] && [ "$v" -ge 100 ] && [ "$v" -le 2000 ] || no "take1max must be whole dollars from 100 to 2000, got '$v'."; T1MAX=$v;;
    *)           no "unknown setting '$a'.";;
  esac
done
# The build must know every key asked (else the bot would refuse the file) and must print the "[money] config" line this script checks.
[ -f "$D/live-executor.js" ] && [ -f "$D/lib/moneyRule.js" ] || { echo "STOP: $D is not a TIDE build (no live-executor.js / lib/moneyRule.js). Nothing changed."; exit 1; }
need() { grep -q "$1" "$D/lib/moneyRule.js" 2>/dev/null || { echo "STOP: this build's lib/moneyRule.js does not know $2 (money-r4.1 or later needed). Nothing changed."; exit 1; }; }
{ [ -n "$MODE" ] || [ -n "$FLAT" ]; } && need flatDollars "money.sizing.mode / flatDollars"
[ -n "$NOFIT" ] && need "noFit" "money.sizing.noFit"
[ -n "$NEAR" ] && need "nearFloor" "money.sizing.nearFloor"
[ -n "$T1MAX" ] && { grep -q "take1MaxUsd" "$D/lib/tideWire.js" 2>/dev/null || { echo "STOP: this build does not know money.sizing.take1MaxUsd (TIDE Stage 2a needed). Nothing changed."; exit 1; }; }
grep -q "configLine" "$D/live-executor.js" "$D/lib/tideWire.js" 2>/dev/null || { echo "STOP: this build does not print the [money] config startup line, so the change could not be checked. Nothing changed."; exit 1; }
read -r -p "Is the bot FLAT (no MNQ position, no working MNQ orders)? Type YES: " A
[ "$A" = YES ] || { echo "Nothing changed."; exit 1; }

# ---- r13.6.1 shared core (byte-identical in set-open.sh, set-retest.sh and set-samedir.sh; tests/tools.r1361.test.cjs checks that) ----
# config-local.json is never written in place. A temp file in the same folder (same owner and mode) is written, fsynced, read back and parsed, then renamed over
# config-local.json and the folder is fsynced. A failure before that rename leaves config-local.json byte for byte as it was. After the rename, ANY failure
# (the write not confirmed, CONFIG-LOCAL ERROR, FATAL, the service not active, no startup line within 2 min, the startup line showing another value) puts the
# backup back the same way, checks its sha256, restarts the bot and checks that start too. "Nothing changed" is printed only when the file's sha256 equals the
# one read before the change (and, after a restart, the bot is active and printed its [lv1] startup line).
h16() { if [ -e "$1" ]; then sha256sum < "$1" | cut -c1-16; else echo ABSENT; fi; }
cfgpy() { python3 -I - "$@" <<'PY'
import errno, hashlib, json, os, sys, tempfile
op, path = sys.argv[1], sys.argv[2]
folder = os.path.dirname(os.path.abspath(path))
def die(code, why): print(why); sys.exit(code)
def load():
    try: d = json.load(open(path)) if os.path.exists(path) else {}
    except Exception: die(1, 'not JSON')
    if not isinstance(d, dict): die(1, 'not a JSON object')
    return d
def edits(d, a):
    while a:
        if a[0] == 'set': d[a[1]] = json.loads(a[2]); a = a[3:]
        elif a[0] == 'del': d.pop(a[1], None); a = a[2:]
        else: die(5, 'bad edit ' + a[0])
    return d
def fsync_folder():
    fd = os.open(folder, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
def stage(data, like):
    st = os.stat(like) if like and os.path.exists(like) else None
    um = os.umask(0); os.umask(um)
    try: fd, tmp = tempfile.mkstemp(dir=folder, prefix='.config-local.json.', suffix='.tmp')
    except Exception as e: die(2, f'no temp file: {e}')
    try:
        try:
            if st and (st.st_uid, st.st_gid) != (os.geteuid(), os.getegid()): os.fchown(fd, st.st_uid, st.st_gid)
            os.fchmod(fd, st.st_mode & 0o7777 if st else 0o666 & ~um)
            view, off = memoryview(data), 0
            while off < len(data): off += os.write(fd, view[off:])
            os.fsync(fd)
        finally: os.close(fd)
        with open(tmp, 'rb') as f: back = f.read()
        if back != data: raise OSError(errno.EIO, 'the temp file does not read back as written')
        if not isinstance(json.loads(back.decode('utf-8')), dict): raise ValueError('the temp file is not a JSON object')
        t = os.stat(tmp)
        if st and (t.st_uid, t.st_gid, t.st_mode & 0o7777) != (st.st_uid, st.st_gid, st.st_mode & 0o7777): raise OSError(errno.EPERM, 'owner / mode could not be kept')
    except Exception as e:
        try: os.unlink(tmp)
        except OSError: pass
        die(2, f'{type(e).__name__}: {e}')
    return tmp
def swap(tmp):
    try: os.rename(tmp, path)
    except Exception as e:
        try: os.unlink(tmp)
        except OSError: pass
        die(2, f'rename failed: {e}')
    try: fsync_folder()
    except Exception as e: die(3, f'the folder could not be fsynced after the rename: {e}')
if op == 'edit': swap(stage((json.dumps(edits(load(), sys.argv[3:]), indent=2) + '\n').encode(), path))
elif op == 'verify':
    d, a = load(), sys.argv[3:]
    while a:
        if a[0] == 'set' and (a[1] not in d or d[a[1]] != json.loads(a[2])): die(4, f'{a[1]} is not {a[2]}')
        if a[0] == 'del' and a[1] in d: die(4, f'{a[1]} is still there')
        a = a[3:] if a[0] == 'set' else a[2:]
elif op == 'restore':
    try: data = open(sys.argv[3], 'rb').read()
    except Exception as e: die(2, f'the backup cannot be read: {e}')
    if hashlib.sha256(data).hexdigest()[:16] != sys.argv[4]: die(2, 'the backup is not the file read before the change')
    swap(stage(data, sys.argv[3]))
elif op == 'remove':
    try:
        if os.path.lexists(path): os.unlink(path)
    except Exception as e: die(2, f'remove failed: {e}')
    try: fsync_folder()
    except Exception as e: die(3, f'the folder could not be fsynced after the remove: {e}')
else: die(5, 'bad op')
PY
}
backup() {   # BK = a verified copy of config-local.json (none when there is no file); H0 = its sha256 (ABSENT when there is no file)
  [ -L "$CFG" ] && { echo "STOP: $CFG is a symbolic link; this script only replaces a plain file. Nothing changed."; exit 1; }
  H0=$(h16 "$CFG"); BK=""
  if [ -e "$CFG" ]; then BK="$CFG.bak-$TAG-$(date +%Y%m%d-%H%M%S)"; [ -e "$BK" ] && BK="$BK-$$"
    { cp -a "$CFG" "$BK" && cmp -s "$CFG" "$BK" && { sync "$BK" 2>/dev/null || sync; }; } || { echo "STOP: could not back up $CFG. Nothing changed."; exit 1; }; fi
}
write_cfg() {   # the staged write of the EDITS; returns only when config-local.json holds them (else exits, or restores and exits)
  WHY=$(cfgpy edit "$CFG" "${EDITS[@]}" 2>&1); RC=$?
  if [ "$RC" != 0 ] && [ "$RC" != 3 ]; then
    if [ "$(h16 "$CFG")" = "$H0" ]; then
      if [ "$RC" = 1 ]; then echo "STOP: config-local.json could not be read as JSON. Nothing changed."; else echo "STOP: config-local.json could not be written safely ($WHY). Nothing changed."; fi; exit 1; fi
    RC=3; WHY="the write failed ($WHY) but config-local.json is no longer the file read before"; fi
  if [ "$RC" = 0 ]; then VW=$(cfgpy verify "$CFG" "${EDITS[@]}" 2>&1) || { RC=3; WHY="it does not read back as written: $VW"; }; fi
  if [ "$RC" != 0 ]; then echo "The new config-local.json could not be confirmed ($WHY): putting it back as it was ..."; restore_cfg
    if [ "$RS" = ok ]; then echo "config-local.json put back as it was (sha256 $H0 verified). The bot was not restarted."; echo "FAIL: nothing changed. Send these lines to your assistant."
    else echo "CHECK: config-local.json could NOT be put back as it was ($RWHY). The bot was not restarted and still runs with what it loaded at its last start.${BK:+ The backup is $BK.} Send these lines to your assistant."; fi; exit 1; fi
}
restore_cfg() {   # RS=ok only when config-local.json's sha256 is again H0 (or it is absent again when there was none)
  if [ -n "$BK" ]; then RWHY=$(cfgpy restore "$CFG" "$BK" "$H0" 2>&1); else RWHY=$(cfgpy remove "$CFG" 2>&1); fi
  if [ "$(h16 "$CFG")" = "$H0" ]; then RS=ok; else RS=fail; RWHY="${RWHY:+$RWHY; }sha256 now $(h16 "$CFG"), before $H0"; fi
}
start_and_read() {   # restart and read the start: ST = ok | refused | fatal | not-active | timeout (no [lv1] startup line within 12 x 10 s)
  T0=$(date '+%Y-%m-%d %H:%M:%S'); systemctl stop "$SVC"; systemctl start "$SVC"; LOG=""
  for i in $(seq 1 12); do sleep 10; LOG=$(journalctl -u "$SVC" --since "$T0" --no-pager 2>/dev/null); echo "$LOG" | grep -q "\[lv1\] levels-triggered\|CONFIG-LOCAL ERROR\|FATAL" && break; systemctl is-active --quiet "$SVC" || break; done
  if echo "$LOG" | grep -q "CONFIG-LOCAL ERROR"; then ST=refused; elif echo "$LOG" | grep -q "FATAL"; then ST=fatal; elif ! systemctl is-active --quiet "$SVC"; then ST=not-active
  elif ! echo "$LOG" | grep -q "\[lv1\] levels-triggered"; then ST=timeout; else ST=ok; fi
}
why_of() { case "$ST" in refused) echo "the bot refused the file";; fatal) echo "the bot stopped with FATAL";; not-active) echo "the service is not active";; timeout) echo "no [lv1] startup line within 2 min";; *) echo "the startup line does not show the new value";; esac; }
restart_or_restore() {   # $1 = 1 when the startup line shows what was asked; on ANY failure: the backup is put back, verified, and the bot restarted and checked
  [ "$ST" = ok ] && [ "$1" = 1 ] && return 0
  W=$(why_of); echo "$LOG" | grep -A3 "CONFIG-LOCAL ERROR\|FATAL" | head -6; [ "$ST" = ok ] && echo "$LOG" | grep "\[lv1\] levels-triggered" | tail -1
  restore_cfg
  if [ "$RS" != ok ]; then echo "CHECK: $W, and config-local.json could NOT be put back as it was ($RWHY). The bot was not restarted again (service: $(systemctl is-active "$SVC" 2>/dev/null)).${BK:+ The backup is $BK.} Send these lines to your assistant."; exit 1; fi
  echo "The bot did not start as asked ($W): config-local.json put back as it was (sha256 $H0 verified), restarting ..."; start_and_read
  if [ "$ST" = ok ]; then echo "$LOG" | grep "\[lv1\] levels-triggered" | tail -1; echo "FAIL: nothing changed (the bot is running again with the previous config-local.json). Send these lines to your assistant."
  else echo "CHECK: config-local.json is back as it was, but the restart with it did not come up cleanly ($(why_of)); the bot may be stopped (service: $(systemctl is-active "$SVC" 2>/dev/null)). Send these lines to your assistant."; fi
  exit 1
}
# ---- end of the shared core ----
backup
# The new "money" object = config-local.json's own "money" with only the asked keys set (the bot deep-merges it over its defaults).
NEWMONEY=$(python3 -I - "$CFG" "$MODE" "$FLAT" "$NOFIT" "$NEAR" "$T1MAX" <<'PY'
import json, os, sys
path, mode, flat, nofit, near, t1max = sys.argv[1:7]
try: d = json.load(open(path)) if os.path.exists(path) else {}
except Exception: print('config-local.json is not JSON'); sys.exit(1)
if not isinstance(d, dict): print('config-local.json is not a JSON object'); sys.exit(1)
m = d.get('money', {})
if not isinstance(m, dict): print('"money" in config-local.json is not an object'); sys.exit(1)
s = m.setdefault('sizing', {})
if not isinstance(s, dict): print('"money.sizing" in config-local.json is not an object'); sys.exit(1)
if mode: s['mode'] = mode
if flat: s['flatDollars'] = int(flat)
if nofit: s['noFit'] = nofit
if t1max: s['take1MaxUsd'] = int(t1max)
if near:
    n = s.setdefault('nearFloor', {})
    if not isinstance(n, dict): print('"money.sizing.nearFloor" in config-local.json is not an object'); sys.exit(1)
    n['enabled'] = (near == 'on')
print(json.dumps(m, sort_keys=True))
PY
) || { echo "STOP: $NEWMONEY. Nothing changed."; exit 1; }
SAME=$(python3 -I -c 'import json,os,sys; p=sys.argv[1]; d=json.load(open(p)) if os.path.exists(p) else {}; print(1 if d.get("money") == json.loads(sys.argv[2]) else 0)' "$CFG" "$NEWMONEY" 2>/dev/null)
if [ "$SAME" = 1 ]; then echo "config-local.json already has these values. Nothing changed (the bot was not restarted).${BK:+ (the backup $BK was not needed)}"; exit 0; fi
EDITS=(set money "$NEWMONEY")
write_cfg
start_and_read
L=$(echo "$LOG" | grep "\[money\] config" | tail -1)
ok=1; [ -n "$L" ] || ok=0
[ -n "$MODE" ] && { echo "$L" | grep -qF " mode $MODE;" || ok=0; }
[ -n "$FLAT" ] && { echo "$L" | grep -qF " flatDollars $FLAT;" || ok=0; }
[ -n "$NOFIT" ] && { echo "$L" | grep -qF " noFit $NOFIT;" || ok=0; }
[ -n "$NEAR" ] && { echo "$L" | grep -qF " nearFloor $NEAR;" || ok=0; }
[ -n "$T1MAX" ] && { echo "$LOG" | grep -F "[tide] mode LIVE:" | tail -1 | grep -qF "take1 ceiling \$$T1MAX;" || echo "$LOG" | grep -qF '[config-local]   money.sizing.take1MaxUsd = '"$T1MAX" || ok=0; }
L2=$(echo "$LOG" | grep "\[lv1\] levels-triggered" | tail -1)
restart_or_restore "$ok"
echo "$L"; echo "$L2"; echo "DONE: the bot is running with${MODE:+ mode $MODE}${FLAT:+ flatDollars $FLAT}${NOFIT:+ noFit $NOFIT}${NEAR:+ nearFloor $NEAR}${T1MAX:+ take1MaxUsd $T1MAX} (the [money] config line above).${BK:+ (backup: $BK)}"
