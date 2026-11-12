#!/bin/bash
# edge r1.6 (r1.5 + the 4-step default ladder): the NY runner profit lock switch. Run it ONLY when FLAT (show is read-only and can run any time). One restart. In config-local.json (sessionRunnerNy.lock.mode; any other sessionRunnerNy.* line you set by hand is kept):
#   bash set-runnerlock.sh show   -> prints the ladder in force (config-local.json, or the shipped default 50:25,75:45,100:65,150:110 when it has none) and the mode. Changes nothing, no restart.
#   bash set-runnerlock.sh steps "50:25,75:45,100:65,150:110"  -> sets sessionRunnerNy.lock.steps (arm:lock pairs in points from entry; 1 to 6 steps, arm and lock both strictly ascending,
#                                    lock below its arm and above sessionRunnerNy.stopPts; checked here before anything is written and again by the bot). The mode is kept. One restart; prints what changed.
#   bash set-runnerlock.sh on     -> sessionRunnerNy.lock.mode "on": once the best price since the fill reaches a step's armPts, the NY (atrTarget) runner's stop moves to entry +lockPts
#                                    through the safe replace (new stop first, verified cancel, market exit if the market is already through). One move per step, never loosening. TP2 unchanged.
#   bash set-runnerlock.sh log    -> mode "log": journals one runner_lock row per step with wouldStop; NO order is sent, the trades are r1.4 exactly.
#   bash set-runnerlock.sh off    -> mode "off" written explicitly (r1.4 behaviour for new trades). THE UNDO while flat. It leaves a "lock" line in config-local.json, which r1.4 REFUSES TO START with:
#                                    run clear before rolling back to r1.4.
#   bash set-runnerlock.sh clear  -> removes the whole sessionRunnerNy.lock line (mode AND steps; and the sessionRunnerNy line when nothing else is in it): the SHIPPED default of r1.6 applies again (ON, 4 steps).
#                                    Run it BEFORE rolling back to r1.4 or r1.5 (clear, then roll back); a config-local.json with no lock line starts r1.4, r1.5 and r1.6 alike.
# The shipped ladder is arm 50 -> lock 25, 75 -> 45, 100 -> 65, 150 -> 110 (points from entry); change it with  steps  (the bot refuses to start on a bad ladder and the script puts the file back).
# The bot prints the override at startup ("[config-local]   sessionRunnerNy.lock.mode = ...") and "[runner-lock] NY runner profit lock: ..."; this script checks both, or puts the file back.
set -u
D=${MACBOT_DIR:-/opt/mac-bot}; SVC=mac-bot-live.service; CFG="$D/config-local.json"; WANT=${1:-}; TAG=runnerlock
USAGE='usage: bash set-runnerlock.sh show | on | log | off | clear | steps "50:25,75:45,100:65,150:110"'
DEF_STEPS="50:25,75:45,100:65,150:110"; STEPSARG=${2:-}
case "$WANT" in show|on|log|off|clear) [ -z "$STEPSARG" ] || { echo "$USAGE"; exit 1; };; steps) [ -n "$STEPSARG" ] || { echo "$USAGE"; exit 1; };; *) echo "$USAGE"; exit 1;; esac
grep -q "lockLine" "$D/lib/edgeExits.js" 2>/dev/null || { echo "STOP: the installed bot does not know sessionRunnerNy.lock (install edge r1.5 first). Nothing changed."; exit 1; }
lockpy() { python3 -I - "$@" <<'PY'
import json, os, sys
op, path, arg, deflt = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def fmt(steps): return ','.join('%g:%g' % (a, l) for a, l in steps)
try: d = json.load(open(path)) if os.path.exists(path) else {}
except Exception: print('BAD'); sys.exit(0)
t = d.get('sessionRunnerNy', {}) if isinstance(d, dict) else None
if not isinstance(t, dict) or not isinstance(t.get('lock', {}), dict): print('BAD'); sys.exit(0)
l = t.get('lock', {}); stop = t.get('stopPts', 2)
def cur():
    st = l.get('steps')
    if st is None: return [tuple(map(float, x.split(':'))) for x in deflt.split(',')], 'shipped default'
    try: return [(float(s['armPts']), float(s['lockPts'])) for s in st], 'config-local.json'
    except Exception: return None, 'config-local.json (not a valid ladder)'
if op == 'show':
    st, src = cur(); mode = l.get('mode', 'on')
    print('mode: %s%s' % (mode, '' if 'mode' in l else ' (shipped default)'))
    print('ladder (%s): %s' % (src, fmt(st) if st else json.dumps(l.get('steps'))))
    print('runner base stop: entry +%g' % stop)
    if st:
        for i, (a, k) in enumerate(st, 1): print('  step %d: best price +%g pts from entry -> stop entry +%g' % (i, a, k))
elif op == 'steps':
    try:
        st = []
        for part in arg.split(','):
            a, k = part.strip().split(':'); a, k = float(a), float(k)
            if a != a or k != k or a in (float('inf'), float('-inf')) or k in (float('inf'), float('-inf')): raise ValueError('not a number')
            st.append((a, k))
    except Exception: print('ERR could not read "%s": use arm:lock pairs separated by commas, e.g. 50:25,75:45' % arg); sys.exit(0)
    if not 1 <= len(st) <= 6: print('ERR 1 to 6 steps, got %d' % len(st)); sys.exit(0)
    try: stop = float(stop)
    except Exception: print('ERR sessionRunnerNy.stopPts in config-local.json is not a number'); sys.exit(0)
    for i, (a, k) in enumerate(st, 1):
        if not (0 < a <= 200): print('ERR step %d: arm %g must be above 0 and at most 200' % (i, a)); sys.exit(0)
        if not (0 <= k <= 200): print('ERR step %d: lock %g must be 0 to 200' % (i, k)); sys.exit(0)
        if k >= a: print('ERR step %d: lock %g must be below its arm %g' % (i, k, a)); sys.exit(0)
        if k <= stop: print('ERR step %d: lock %g must be above the runner base stop sessionRunnerNy.stopPts (%g)' % (i, k, stop)); sys.exit(0)
        if i > 1 and not a > st[i-2][0]: print('ERR step %d: arm %g must be above the previous arm %g (steps must rise)' % (i, a, st[i-2][0])); sys.exit(0)
        if i > 1 and not k > st[i-2][1]: print('ERR step %d: lock %g must be above the previous lock %g (the stop never loosens)' % (i, k, st[i-2][1])); sys.exit(0)
    t = dict(t); nl = dict(l); nl['steps'] = [{'armPts': (int(a) if a == int(a) else a), 'lockPts': (int(k) if k == int(k) else k)} for a, k in st]; t['lock'] = nl
    old, _ = cur()
    print('OK ' + json.dumps(t)); print('mode ' + l.get('mode', 'on')); print('old ' + (fmt(old) if old else 'invalid')); print('new ' + fmt(st))
PY
}
if [ "$WANT" = show ]; then OUT=$(lockpy show "$CFG" "" "$DEF_STEPS"); [ "$OUT" = BAD ] && { echo "STOP: config-local.json is not JSON, or its \"sessionRunnerNy\" line (or its \"lock\") is not an object. Nothing changed."; exit 1; }
  echo "NY runner profit lock in $CFG:"; echo "$OUT"; exit 0; fi
if [ "$WANT" = steps ]; then SOUT=$(lockpy steps "$CFG" "$STEPSARG" "$DEF_STEPS"); [ "$SOUT" = BAD ] && { echo "STOP: config-local.json is not JSON, or its \"sessionRunnerNy\" line (or its \"lock\") is not an object. Nothing changed."; exit 1; }
  case "$SOUT" in ERR*) echo "STOP: ${SOUT#ERR }. Nothing changed."; exit 1;; esac
  TOBJ=$(echo "$SOUT" | sed -n 1p | cut -c4-); SMODE=$(echo "$SOUT" | sed -n 2p | cut -c6-); OLDS=$(echo "$SOUT" | sed -n 3p | cut -c5-); NEWS=$(echo "$SOUT" | sed -n 4p | cut -c5-); fi
# the new sessionRunnerNy object = the one in config-local.json with only lock.mode changed (other lines kept); clear with nothing else left = the "sessionRunnerNy" line removed
[ "$WANT" = steps ] || TOBJ=$(python3 -I - "$CFG" "$WANT" <<'PY'
import json, os, sys
path, want = sys.argv[1], sys.argv[2]
try: d = json.load(open(path)) if os.path.exists(path) else {}
except Exception: print('BAD'); sys.exit(0)
t = d.get('sessionRunnerNy', {}) if isinstance(d, dict) else None
if not isinstance(t, dict): print('BAD'); sys.exit(0)
t = dict(t); l = t.get('lock', {})
if not isinstance(l, dict): print('BAD'); sys.exit(0)
l = dict(l)
if want == 'clear': l = {}
else: l['mode'] = want
if l: t['lock'] = l
else: t.pop('lock', None)
print(json.dumps(t) if t else 'NONE')
PY
)
[ "$TOBJ" = BAD ] && { echo "STOP: config-local.json is not JSON, or its \"sessionRunnerNy\" line (or its \"lock\") is not an object { ... }. Nothing changed."; exit 1; }
if [ "$TOBJ" = NONE ]; then EDITS=(del sessionRunnerNy); else EDITS=(set sessionRunnerNy "$TOBJ"); fi
LADDER=$(echo "${NEWS:-}" | tr ',' '\n' | awk -F: '{printf "%s+%s -> stop entry +%s", (NR>1?"; ":""), $1, $2}')
case "$WANT" in steps) EXP=''; if [ "$SMODE" = off ]; then EXP2='NY runner profit lock: off ('; elif [ "$SMODE" = log ]; then EXP2="$LADDER"; else EXP2="NY runner profit lock: ON (atrTarget runners only; best price since the fill $LADDER;"; fi;; on) EXP='[config-local]   sessionRunnerNy.lock.mode = "on"'; EXP2='NY runner profit lock: ON (';; log) EXP='[config-local]   sessionRunnerNy.lock.mode = "log"'; EXP2='NY runner profit lock: LOG (';; off) EXP='[config-local]   sessionRunnerNy.lock.mode = "off"'; EXP2='NY runner profit lock: off (';; clear) EXP=''; EXP2='NY runner profit lock: ON (';; esac
read -r -p "Is the bot FLAT (no MNQ position, no working MNQ orders)? Type YES: " A
[ "$A" = YES ] || { echo "Nothing changed."; exit 1; }
if [ "$WANT" = off ]; then echo; echo "NOTE: off leaves a sessionRunnerNy.lock line in config-local.json. r1.4 refuses to start with it: run  bash set-runnerlock.sh clear  before rolling back to r1.4."; fi
if [ "$WANT" = steps ]; then echo; echo "STEPS: sessionRunnerNy.lock.steps  $OLDS  ->  $NEWS   (mode stays $SMODE). ROLLBACK NOTE: this leaves a sessionRunnerNy.lock line that r1.4 REFUSES to start with: run  bash set-runnerlock.sh clear  before going back to r1.4 (or r1.5, whose shipped ladder is one step)."; fi
if [ "$WANT" = clear ]; then echo; echo "NOTE: clear removes the whole lock line (mode and steps), so the shipped default applies: the profit lock is ON with the 4-step ladder (r1.6). To keep it off, use  off  instead (and run clear before a rollback to r1.4)."; fi
if [ "$WANT" = on ]; then echo; echo "PROFIT LOCK ON: a NY runner that has run to a step's armPts gets its stop moved up to entry +lockPts (real stop orders on this account). Every other rule stays."
  read -r -p "Type YES to switch the NY runner profit lock ON: " A2; [ "$A2" = YES ] || { echo "Nothing changed."; exit 1; }; fi

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
if [ "$WANT" = steps ]; then ok=1; elif [ -z "$EXP" ]; then echo "$LOG" | grep -qF "[config-local]   sessionRunnerNy.lock.mode" || ok=1; else echo "$LOG" | grep -qF "$EXP" && ok=1; fi
RL=$(echo "$LOG" | grep -F "[runner-lock] NY runner profit lock" | tail -1)
[ "$ok" = 1 ] && { echo "$RL" | grep -qF "$EXP2" || ok=0; }
restart_or_restore "$ok"
echo "$LOG" | grep -F "[config-local]   sessionRunnerNy." | tail -4; echo "$RL" | cut -c1-400
case "$WANT" in off) echo "REMINDER: run  bash set-runnerlock.sh clear  before rolling back to r1.4 (r1.4 refuses a config-local.json with a lock line).";; esac
[ "$WANT" = steps ] && echo "CHANGED: ladder $OLDS -> $NEWS"
echo "DONE runner lock $WANT.${BK:+ (backup: $BK)}"
