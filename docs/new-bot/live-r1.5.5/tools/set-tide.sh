#!/bin/bash
# TIDE STAGE 2a (the new lv1 model). Run it ONLY when FLAT. One restart. In config-local.json:
#   bash set-tide.sh live     -> tide.mode "live" + tide.liveArmed: the new model sends REAL orders for its signals (entry, one stop, TP1 2/3, BE + 1 tick,
#                                TP2, the R-ladder / climax, the planner's flatten). The old levels path takes NO new entries (tide.oldPathEntries false)
#                                but still manages anything already open. Asks you to type YES (twice: flat, then live).
#   bash set-tide.sh shadow   -> tide.mode "shadow": the new model reads the market and JOURNALS + PUSHES every signal ("TIDE SHADOW ...").
#                                It never sends an order; the bot keeps trading exactly as before.
#   bash set-tide.sh off      -> tide.mode "off": the new model does nothing (the bot is r13.3.7 exactly).
#   bash set-tide.sh clear    -> removes tide.mode: the shipped "off" applies again.
#   bash set-tide.sh climax=off -> tide.climaxGate false (r1.5.1): the engine's CLIMAX with-trend entry block is bypassed; the TIDE mode is kept.
#   bash set-tide.sh climax=on  -> removes tide.climaxGate: the shipped ON applies again (the bot behaves as r1.5). Run it before rollback.sh to r1.5 or older.
#   bash set-tide.sh stale=on   -> tide.staleR 2 (r1.5.3): rule 18 ON, a far un-retested trap gives way to a nearer acceptance the same way; the TIDE mode is kept.
#   bash set-tide.sh stale=off  -> tide.staleR 0 (rule 18 OFF, setups as r1.5.1). r1.5.4 ships 2 (ON); stale=on removes the key again.
#   bash set-tide.sh lanes=off  -> tide.laneAccept, controlFree, nearestWins, ltfOpens, waveBiasTrend, releaseOnRefusal, controlAsBias (r1.5.5) false + staleR 0 (r1.5.4): the bot picks setups exactly as r1.5.3.
#   bash set-tide.sh lanes=on   -> removes those eight keys: the shipped r1.5.4 behaviour applies again. Run it before rollback.sh to r1.5.3 or older.
# Any other tide.* line you set by hand (useTimeBlocks, openWaitMin, push) is kept. The bot prints the override at startup
# ("[config-local]   tide.mode = ..." and "[tide] new model ..."); this script checks them, or puts the file back.
set -u
D=${MACBOT_DIR:-/opt/mac-bot}; SVC=mac-bot-live.service; CFG="$D/config-local.json"; WANT=${1:-}; TAG=tide
USAGE="usage: bash set-tide.sh live | shadow | off | clear | climax=on | climax=off | stale=on | stale=off | lanes=on | lanes=off"
case "$WANT" in live|shadow|off|clear|climax=on|climax=off|stale=on|stale=off|lanes=on|lanes=off) ;; *) echo "$USAGE"; exit 1;; esac
case "$WANT" in lanes=*) grep -q "laneAccept" "$D/lib/tideWire.js" 2>/dev/null || { echo "STOP: the installed bot does not know tide.laneAccept (install TIDE Stage 2a r1.5.4 first with go.sh). Nothing changed."; exit 1; };; esac
case "$WANT" in stale=*) grep -q "staleR" "$D/lib/tideWire.js" 2>/dev/null || { echo "STOP: the installed bot does not know tide.staleR (install TIDE Stage 2a r1.5.3 first with go.sh). Nothing changed."; exit 1; };; esac
case "$WANT" in climax=*) grep -q "climaxGate" "$D/lib/tideWire.js" 2>/dev/null || { echo "STOP: the installed bot does not know tide.climaxGate (install TIDE Stage 2a r1.5.1 first with go.sh). Nothing changed."; exit 1; };; esac
grep -q "require('./lib/tideWire')" "$D/live-executor.js" 2>/dev/null && [ -f "$D/lib/tideWire.js" ] || { echo "STOP: $D is not a TIDE bot (install it first with go.sh). Nothing changed."; exit 1; }
if [ "$WANT" = live ] || grep -q "liveArmed" "$D/lib/tideWire.js" 2>/dev/null; then grep -q "require('./lib/tideLive')" "$D/live-executor.js" 2>/dev/null && [ -f "$D/lib/tideLive.js" ] || { echo "STOP: $D is not the TIDE Stage 2a bot (install it first with go.sh). Nothing changed."; exit 1; }; fi
# the new tide object = the one in config-local.json with only "mode" changed (other tide.* lines kept); clear with nothing else left = the "tide" line removed
TOBJ=$(python3 -I - "$CFG" "$WANT" <<'PY'
import json, os, sys
path, want = sys.argv[1], sys.argv[2]
try: d = json.load(open(path)) if os.path.exists(path) else {}
except Exception: print('BAD'); sys.exit(0)
t = d.get('tide', {}) if isinstance(d, dict) else None
if not isinstance(t, dict): print('BAD'); sys.exit(0)
t = dict(t)
if want == 'clear': t.pop('mode', None); t.pop('liveArmed', None)
elif want == 'live': t['mode'] = 'live'; t['liveArmed'] = 'set-tide.sh live (stage 2a)'
elif want == 'climax=on': t.pop('climaxGate', None)
elif want == 'climax=off': t['climaxGate'] = False
elif want == 'stale=on': t.pop('staleR', None)
elif want == 'stale=off': t['staleR'] = 0
elif want == 'lanes=off': t.update({'staleR': 0, 'laneAccept': False, 'controlFree': False, 'nearestWins': False, 'ltfOpens': False, 'waveBiasTrend': False, 'releaseOnRefusal': False, 'controlAsBias': False})
elif want == 'lanes=on': [t.pop(k, None) for k in ('staleR', 'laneAccept', 'controlFree', 'nearestWins', 'ltfOpens', 'waveBiasTrend', 'releaseOnRefusal', 'controlAsBias')]
else: t['mode'] = want; t.pop('liveArmed', None)
print(json.dumps(t) if t else 'NONE')
PY
)
[ "$TOBJ" = BAD ] && { echo "STOP: config-local.json is not JSON, or its \"tide\" line is not an object { ... }. Nothing changed."; exit 1; }
if [ "$TOBJ" = NONE ]; then EDITS=(del tide); else EDITS=(set tide "$TOBJ"); fi
case "$WANT" in live) EXP='[config-local]   tide.mode = "live"'; EXP2='): LIVE (Stage 2a: REAL orders';; shadow) EXP='[config-local]   tide.mode = "shadow"'; EXP2='): SHADOW (journal + phone only';; off) EXP='[config-local]   tide.mode = "off"'; EXP2='(stage 1): off (tide.mode "off"';; clear) EXP=''; EXP2='(stage 1): off (tide.mode "off"';; climax=off) EXP='[config-local]   tide.climaxGate = false'; EXP2='climax gate OFF (';; climax=on) EXP=''; EXP2='climax gate ON (';; stale=on) EXP=''; EXP2='rule 18 ON (';; stale=off) EXP='[config-local]   tide.staleR = 0'; EXP2='rule 18 OFF (';; lanes=off) EXP='[config-local]   tide.laneAccept = false'; EXP2='lanes: accept-under-trap OFF, control-free OFF';; lanes=on) EXP=''; EXP2='lanes: accept-under-trap ON, control-free ON';; esac
read -r -p "Is the bot FLAT (no MNQ position, no working MNQ orders)? Type YES: " A
[ "$A" = YES ] || { echo "Nothing changed."; exit 1; }
if [ "$WANT" = live ]; then echo; echo "TIDE LIVE: the new model will send REAL orders on this account (one position at a time; the old levels path takes no new entries)."
  read -r -p "Type YES to switch TIDE to LIVE: " A2; [ "$A2" = YES ] || { echo "Nothing changed."; exit 1; }; fi
if [ "$WANT" = climax=off ]; then echo; echo "CLIMAX GATE OFF: after a climax bar TIDE may take with-trend entries before structure confirms (replay 10/27-11/04 with the session close: 33 trades instead of 32, the one extra = 11/03 06:09 LONG, +\$232). Every other rule stays."
  read -r -p "Type YES to switch the CLIMAX gate OFF: " A2; [ "$A2" = YES ] || { echo "Nothing changed."; exit 1; }; fi
if [ "$WANT" = stale=on ]; then echo; echo "RULE 18 ON: an armed trap that has had no retest gives way when price is more than max(2 x its risk, 60 pts) from it and a nearer acceptance the same way arms (replay 10/27-11/04 with the session close: the same number of trades, one swap: 11/02 09:03 SHORT at London Low becomes 08:37 SHORT at 4H Open, -\$180; no difference on the 11/04 night tape). Every other rule stays."
  read -r -p "Type YES to switch rule 18 ON: " A2; [ "$A2" = YES ] || { echo "Nothing changed."; exit 1; }; fi

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
ok=0; case "$WANT" in climax=*) KEY="[config-local]   tide.climaxGate";; stale=*) KEY="[config-local]   tide.staleR";; lanes=*) KEY="[config-local]   tide.laneAccept";; *) KEY="[config-local]   tide.mode";; esac
if [ -z "$EXP" ]; then echo "$LOG" | grep -qF "$KEY" || ok=1; else echo "$LOG" | grep -qF "$EXP" && ok=1; fi
NM=$(echo "$LOG" | grep -F "[tide] new model" | tail -1)
case "$WANT" in climax=*|stale=*|lanes=*) [ "$ok" = 1 ] && [ -n "$NM" ] || ok=0; [ "$ok" = 1 ] && ! echo "$NM" | grep -qF '): off (tide.mode "off"' && { echo "$NM" | grep -qF "$EXP2" || ok=0; };;   # with TIDE off the line has no gate text: the config-local line is the check
  *) [ "$ok" = 1 ] && { echo "$NM" | grep -qF "$EXP2" || ok=0; };; esac
[ "$ok" = 1 ] && [ "$WANT" = live ] && { echo "$LOG" | grep -qF "[tide] mode LIVE:" || ok=0; }
restart_or_restore "$ok"
echo "$LOG" | grep -F "[config-local]   tide." | tail -8; echo "$LOG" | grep -F "[tide] new model" | tail -1 | cut -c1-220
echo "$LOG" | grep -F "[tide] mode LIVE:" | tail -1 | cut -c1-300; echo "$LOG" | grep -F "[money] config" | tail -1
case "$WANT" in climax=*) echo "$NM" | grep -o "climax gate O[NF]*" | tail -1; echo "$NM" | grep -qF '): off (tide.mode "off"' && echo "(TIDE is off: the gate applies once TIDE is shadow or live.)";;
  stale=*) echo "$NM" | grep -o "rule 18 O[NF]* (tide.staleR [0-9.]*" | tail -1; echo "$NM" | grep -qF '): off (tide.mode "off"' && echo "(TIDE is off: rule 18 applies once TIDE is shadow or live.)";;
  lanes=*) echo "$NM" | grep -o "rule 18 O[NF]*.*control-free O[NF]*" | tail -1 | cut -c1-200; echo "$NM" | grep -qF '): off (tide.mode "off"' && echo "(TIDE is off: these apply once TIDE is shadow or live.)";; esac
echo "DONE tide $WANT.${BK:+ (backup: $BK)}"
