#!/bin/bash
# edge r1.7: the after-exit record switch. Run it ONLY when FLAT (show is read-only and can run any time). One restart. In config-local.json (afterExitRecord):
#   bash set-afterexit.sh show   -> prints the setting in force (config-local.json, or the shipped default "on") and whether the installed bot knows it. Changes nothing, no restart.
#   bash set-afterexit.sh on     -> afterExitRecord "on" written explicitly: one post_exit journal row per trade, 60 minutes after every exit (record only, no order, no request).
#   bash set-afterexit.sh off    -> "off": no post_exit rows and no state file; the journal and every decision are r1.6 exactly. THE UNDO while flat. It leaves an afterExitRecord line in
#                                   config-local.json, which r1.6 and older REFUSE TO START with: run clear before rolling back to r1.6.
#   bash set-afterexit.sh clear  -> removes the afterExitRecord line: the shipped default of r1.7 applies again (on). Run it BEFORE rolling back to r1.6 or older (clear, then roll back):
#                                   a config-local.json with no afterExitRecord line starts r1.6 and r1.7 alike.
# The bot prints the override at startup ("[config-local]   afterExitRecord = ...") and "[after-exit] afterExitRecord: ON|OFF ..."; this script checks both, or puts the file back.
set -u
D=${MACBOT_DIR:-/opt/mac-bot}; SVC=mac-bot-live.service; CFG="$D/config-local.json"; WANT=${1:-}; TAG=afterexit
USAGE='usage: bash set-afterexit.sh show | on | off | clear'
case "$WANT" in show|on|off|clear) [ -z "${2:-}" ] || { echo "$USAGE"; exit 1; };; *) echo "$USAGE"; exit 1;; esac
if [ "$WANT" = show ]; then
  OUT=$(python3 -I - "$CFG" <<'PY'
import json, os, sys
path = sys.argv[1]
try: d = json.load(open(path)) if os.path.exists(path) else {}
except Exception: print('BAD'); sys.exit(0)
if not isinstance(d, dict): print('BAD'); sys.exit(0)
if 'afterExitRecord' in d: print('afterExitRecord: %s (config-local.json)' % json.dumps(d['afterExitRecord']))
else: print('afterExitRecord: "on" (shipped default; no line in config-local.json)')
PY
)
  [ "$OUT" = BAD ] && { echo "STOP: config-local.json is not a JSON object. Nothing changed."; exit 1; }
  echo "After-exit record in $CFG:"; echo "$OUT"
  grep -q "afterExitRecord" "$D/live-executor.js" 2>/dev/null && echo "installed bot: knows afterExitRecord (edge r1.7 or newer)" || echo "installed bot: does NOT know afterExitRecord (older than r1.7): a line in config-local.json would stop it from starting"
  exit 0
fi
grep -q "afterExitRecord" "$D/live-executor.js" 2>/dev/null || { echo "STOP: the installed bot does not know afterExitRecord (install edge r1.7 first; for clear on an older bot edit the line out by hand). Nothing changed."; exit 1; }
case "$WANT" in on|off) EDITS=(set afterExitRecord "\"$WANT\"");; clear) EDITS=(del afterExitRecord);; esac
case "$WANT" in off) EXP='[config-local]   afterExitRecord = "off"'; EXP2='[after-exit] afterExitRecord: OFF';; on) EXP='[config-local]   afterExitRecord = "on"'; EXP2='[after-exit] afterExitRecord: ON';; clear) EXP=''; EXP2='[after-exit] afterExitRecord: ON';; esac
read -r -p "Is the bot FLAT (no MNQ position, no working MNQ orders)? Type YES: " A
[ "$A" = YES ] || { echo "Nothing changed."; exit 1; }
if [ "$WANT" = off ]; then echo; echo "NOTE: off leaves an afterExitRecord line in config-local.json. r1.6 and older refuse to start with it: run  bash set-afterexit.sh clear  before rolling back to r1.6."; fi
if [ "$WANT" = on ]; then echo; echo "NOTE: on writes an afterExitRecord line; the shipped default is already on. Use  clear  to remove the line (needed before a rollback to r1.6)."; fi

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
write_cfg
start_and_read
ok=0
if [ -z "$EXP" ]; then echo "$LOG" | grep -qF "[config-local]   afterExitRecord" || ok=1; else echo "$LOG" | grep -qF "$EXP" && ok=1; fi
AL=$(echo "$LOG" | grep -F "[after-exit] afterExitRecord:" | tail -1)
[ "$ok" = 1 ] && { echo "$AL" | grep -qF "$EXP2" || ok=0; }
restart_or_restore "$ok"
echo "$LOG" | grep -F "[config-local]   afterExitRecord" | tail -2; echo "$AL" | cut -c1-300
case "$WANT" in off|on) echo "REMINDER: run  bash set-afterexit.sh clear  before rolling back to r1.6 (r1.6 refuses a config-local.json with an afterExitRecord line).";; esac
echo "DONE after-exit record $WANT.${BK:+ (backup: $BK)}"
