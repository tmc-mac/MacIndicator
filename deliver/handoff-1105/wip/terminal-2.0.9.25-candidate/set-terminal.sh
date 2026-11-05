#!/bin/bash
# The phone page (mobile.html in the bot folder), replaced in ONE atomic step. DISPLAY ONLY: no restart is needed, and the bot is not touched.
# tmc-proxy.js (the small proxy that serves the phone page) reads mobile.html from disk on EVERY request: its STATIC_PAGES route calls fs.readFile per page
# load (43a5e642 L576-578; the older bac3048d, L562-564, is the same). So a new mobile.html shows on the next page load. live-executor.js, config-local.json
# and every service are left alone: this tool never restarts, stops or signals anything, never writes any other file in the bot folder (only mobile.html,
# its own new backups and its own short-lived .tmp files), and never deletes a backup. MACBOT_DIR (default /opt/mac-bot) says where the bot is.
#   bash set-terminal.sh install /root/mobile.html <sha256>   -> puts the uploaded page in place, once its sha256 is the one on the sheet
#   bash set-terminal.sh rollback                             -> puts back the newest backup that is not the page now installed (the page as it was
#                                                                before the last install or rollback; a second rollback undoes the first)
#   bash set-terminal.sh rollback <backup file>               -> puts back that backup (a mobile.html.bak... file in the bot folder; status lists them)
#   bash set-terminal.sh status                               -> the installed page, the proxy and every backup; changes nothing, asks nothing
# What install does, in order:
#  1. tmc-proxy.js must be there and still read the page from disk on every request: its three STATIC_PAGES / fs.readFile lines, word for word, one after
#     the other, inside its request handler. If not, STOP: a new page would then need a proxy restart, and this tool does not restart anything.
#  2. The uploaded file's sha256 must be the one on the sheet (all 64 characters; capitals are fine).
#  3. "Is the bot FLAT? Type YES" - the house rule for every change, even a display-only one.
#  4. A backup of the current mobile.html first: mobile.html.bak-<UTC time>-<its first 8 sha256 characters>, e.g. mobile.html.bak-20261030T171500Z-4178f1a2.
#     It is written to a temp file and then linked to that name, so a failed backup never leaves a half file under a backup name. Every backup is kept; a
#     backup's 8 characters are checked against its content before it is ever put back. Two backups never share a time (the tool waits for the next second).
#  5. mobile.html is never written in place: a temp file in the same folder (same owner and mode) is written, fsynced and read back, then renamed over
#     mobile.html, and the folder is fsynced. A page load during the swap gets the old page or the new one, never half of one.
#  6. The installed file's sha256 must be the new page's. After the rename, ANY failure puts the backup back the same way and checks its sha256.
#  7. Before and after (first 8 sha256 characters), then: open the phone page and pull to refresh.
#  8. If curl is there (optional): the page is fetched from the proxy on this server, http://127.0.0.1:<port>/mobile.html, and its sha256 compared with the
#     installed file. The port is the running proxy's own: PROXY_PORT from that process's environment, else the default in tmc-proxy.js's PORT line
#     (L21: 8787). From 127.0.0.1 the proxy asks for no key (its loopback rule, L165-166, runs before every route), so the key is never read, used or
#     printed: only the PROXY_PORT entry of the proxy's environment is read out. If the port or the loopback rule cannot be confirmed, or the proxy asks
#     for its key anyway, the check is skipped and the reason printed. curl is told never to use a web proxy (--noproxy '*').
# "Nothing changed" is printed only when mobile.html's sha256 equals the one read before the change. A failure before the rename leaves mobile.html byte
# for byte as it was. If the backup cannot be put back, the last line says CHECK and names the backup, never "nothing changed".
set -u
D=${MACBOT_DIR:-/opt/mac-bot}; PG="$D/mobile.html"; PX="$D/tmc-proxy.js"; CMD=${1:-}
NAMERE='^mobile\.html\.bak-[0-9]{8}T[0-9]{6}Z-([0-9a-f]{8})$'
usage() { echo "usage: bash set-terminal.sh install <uploaded mobile.html> <sha256> | rollback [<backup file>] | status"; exit 1; }
hfull() { if [ -e "$1" ]; then sha256sum < "$1" 2>/dev/null | cut -c1-64; else echo ABSENT; fi; }   # "" when it cannot be read: never equal to a sha256
h8() { local h; h=$(hfull "$1"); echo "${h:0:8}"; }
# ---- tmc-proxy.js: the lines this tool relies on, word for word (the same in 43a5e642 and bac3048d) ----
LS="const server = http.createServer((req, res) => {"
K1="  const isLoopback = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';"
K2="  if (PROXY_SECRET && !isLoopback) {"
L1="  const STATIC_PAGES = { '/mobile.html': 'mobile.html', '/terminal.html': 'terminal.html', '/prop-farm.html': 'prop-farm.html' };"
L2="  if (STATIC_PAGES[reqUrl.pathname]) {"
L3="    fs.readFile(path.join(__dirname, STATIC_PAGES[reqUrl.pathname]), 'utf8', (err, data) => {"
LL="server.listen(PORT, () => {"
at() { local n; n=$(grep -cxF -- "$1" "$PX" 2>/dev/null); [ "$n" = 1 ] && grep -nxF -- "$1" "$PX" | cut -d: -f1; }   # the line number of a line found exactly once
per_request_read() {   # 0 when the page is read from disk on every request: L1, L2, L3 one after the other, inside the request handler (after LS, before LL)
  local s l1 l2 l3 e
  s=$(at "$LS") && l1=$(at "$L1") && l2=$(at "$L2") && l3=$(at "$L3") && e=$(at "$LL") || return 1
  [ $((l1 + 1)) = "$l2" ] && [ $((l2 + 1)) = "$l3" ] && [ "$s" -lt "$l1" ] && [ "$l3" -lt "$e" ]
}
loopback_free() {   # 0 when a request from 127.0.0.1 needs no key: the loopback rule (K1, then K2 on the next line) comes before the static pages
  local k1 k2 l1
  k1=$(at "$K1") && k2=$(at "$K2") && l1=$(at "$L1") || return 1
  [ $((k1 + 1)) = "$k2" ] && [ "$k2" -lt "$l1" ]
}
guard() {
  [ -f "$PX" ] || { echo "STOP: $PX is not there, so this tool cannot tell how the phone page is served. Nothing changed. Send this line to your assistant."; exit 1; }
  per_request_read || { echo "STOP: $PX ($(h8 "$PX")) does not read mobile.html from disk on every request (its STATIC_PAGES / fs.readFile lines are not as expected). A new page would then need a proxy restart, and this tool does not restart anything. Nothing changed. Send this line to your assistant."; exit 1; }
}
plain_page() {
  [ -L "$PG" ] && { echo "STOP: $PG is a symbolic link; this tool only replaces a plain file. Nothing changed."; exit 1; }
  [ -e "$PG" ] && [ ! -f "$PG" ] && { echo "STOP: $PG is not a plain file. Nothing changed."; exit 1; }
  return 0
}
flat() {   # the house question, word for word
read -r -p "Is the bot FLAT (no MNQ position, no working MNQ orders)? Type YES: " A
[ "$A" = YES ] || { echo "Nothing changed."; exit 1; }
}
# ---- the only writes: pagepy (a backup, a staged replace of mobile.html, or removing a mobile.html that was not there before) ----
pagepy() { python3 -I - "$@" <<'PY'
import errno, hashlib, os, sys, tempfile
op = sys.argv[1]
def die(code, why): print(why); sys.exit(code)
def fsync_folder(folder):
    fd = os.open(folder, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
def read_checked(src, want):   # the bytes written are the bytes whose sha256 was checked, read once
    try:
        with open(src, 'rb') as f: data = f.read()
    except Exception as e: die(2, f'{os.path.basename(src)} cannot be read: {e}')
    got = hashlib.sha256(data).hexdigest()
    if got != want: die(2, f'{os.path.basename(src)} is no longer the file that was checked (sha256 now {got[:8]}, checked {want[:8]})')
    return data
def stage(data, folder, prefix, like):   # a temp file in the folder, with like's owner and mode, written, fsynced and read back; returns its path
    st = os.stat(like) if like and os.path.exists(like) else None
    um = os.umask(0); os.umask(um)
    try: fd, tmp = tempfile.mkstemp(dir=folder, prefix=prefix, suffix='.tmp')
    except Exception as e: die(2, f'no temp file: {type(e).__name__}: {e}')
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
        t = os.stat(tmp)
        if st and (t.st_uid, t.st_gid, t.st_mode & 0o7777) != (st.st_uid, st.st_gid, st.st_mode & 0o7777): raise OSError(errno.EPERM, 'owner / mode could not be kept')
    except Exception as e:
        try: os.unlink(tmp)
        except OSError: pass
        die(2, f'{type(e).__name__}: {e}')
    return tmp
if op == 'put':   # put SRC DST SHA: DST replaced by SRC's bytes. Exit 2 = DST not touched; 3 = renamed, but the folder fsync failed
    src, dst, want = sys.argv[2:5]; folder = os.path.dirname(os.path.abspath(dst))
    tmp = stage(read_checked(src, want), folder, '.mobile.html.', dst if os.path.exists(dst) else None)
    try: os.rename(tmp, dst)
    except Exception as e:
        try: os.unlink(tmp)
        except OSError: pass
        die(2, f'rename failed: {e}')
    try: fsync_folder(folder)
    except Exception as e: die(3, f'the folder could not be fsynced after the rename: {e}')
elif op == 'backup':   # backup SRC DST SHA: a NEW file DST with SRC's bytes, owner and mode. A link, not a rename: an existing file is never replaced
    src, dst, want = sys.argv[2:5]; folder = os.path.dirname(os.path.abspath(dst))
    tmp = stage(read_checked(src, want), folder, '.mobile.html.bak.', src)
    try: os.link(tmp, dst)
    except Exception as e:
        try: os.unlink(tmp)
        except OSError: pass
        die(2, f'{type(e).__name__}: {e}')
    try: os.unlink(tmp)
    except OSError: pass
    try: fsync_folder(folder)
    except Exception as e: die(2, f'the folder could not be fsynced after the backup: {e}')
elif op == 'remove':   # remove DST: only ever mobile.html, only when there was none before the change
    dst = sys.argv[2]
    if os.path.basename(dst) != 'mobile.html': die(5, 'remove is only for mobile.html')
    try:
        if os.path.lexists(dst): os.unlink(dst)
    except Exception as e: die(2, f'remove failed: {e}')
    try: fsync_folder(os.path.dirname(os.path.abspath(dst)))
    except Exception as e: die(3, f'the folder could not be fsynced after the remove: {e}')
else: die(5, 'bad op')
PY
}
backup_page() {   # BK = a new, verified copy of mobile.html (none when there is no mobile.html); H0 = its sha256, read before
  BK=""; [ "$H0" = ABSENT ] && return 0
  local ts n=0
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  while compgen -G "$PG.bak-$ts-*" > /dev/null; do
    n=$((n + 1)); [ "$n" -ge 5 ] && { echo "STOP: no free backup name (mobile.html.bak-$ts-...: is the clock stuck?). Nothing changed."; exit 1; }
    sleep 1; ts=$(date -u +%Y%m%dT%H%M%SZ); done
  BK="$PG.bak-$ts-${H0:0:8}"
  WHY=$(pagepy backup "$PG" "$BK" "$H0" 2>&1) && [ "$(hfull "$BK")" = "$H0" ] && return 0
  [ -n "$WHY" ] || WHY="the copy does not read back as mobile.html"
  LEFT=""; if [ -e "$BK" ]; then if [ "$(hfull "$BK")" = "$H0" ]; then LEFT=" (a full copy was left as $BK; it is kept)"; else LEFT=" (a damaged copy was left as $BK; rollback refuses it)"; fi; fi
  if [ "$(hfull "$PG")" = "$H0" ]; then echo "STOP: could not back up mobile.html ($WHY). Nothing changed.$LEFT Send these lines to your assistant."
  else echo "CHECK: could not back up mobile.html ($WHY), and mobile.html is no longer the file read before (sha256 now $(h8 "$PG"), before ${H0:0:8}). Send these lines to your assistant."; fi
  exit 1
}
restore_page() {   # RS=ok only when mobile.html's sha256 is again H0 (or it is absent again when there was none)
  if [ -n "$BK" ]; then RWHY=$(pagepy put "$BK" "$PG" "$H0" 2>&1); else RWHY=$(pagepy remove "$PG" 2>&1); fi
  if [ "$(hfull "$PG")" = "$H0" ]; then RS=ok; else RS=fail; RWHY="${RWHY:+$RWHY; }sha256 now $(h8 "$PG"), before ${H0:0:8}"; fi
}
replace_page() {   # $1 = the file to put in place, $2 = its sha256 (checked again as it is read). The backup first; returns only when mobile.html is $2
  backup_page
  WHY=$(pagepy put "$1" "$PG" "$2" 2>&1); RC=$?
  if [ "$RC" != 0 ] && [ "$RC" != 3 ]; then
    if [ "$(hfull "$PG")" = "$H0" ]; then echo "STOP: the new mobile.html could not be written safely ($WHY). Nothing changed.${BK:+ (backup kept: $BK)} Send these lines to your assistant."; exit 1; fi
    RC=3; WHY="the write failed ($WHY) but mobile.html is no longer the file read before"; fi
  if [ "$RC" = 0 ] && [ "$(hfull "$PG")" != "$2" ]; then RC=3; WHY="it does not read back as the new page (sha256 now $(h8 "$PG"))"; fi
  if [ "$RC" != 0 ]; then echo "The new mobile.html could not be confirmed ($WHY): putting it back as it was ..."; restore_page
    if [ "$RS" = ok ]; then echo "mobile.html put back as it was (sha256 ${H0:0:8} verified)."; echo "FAIL: nothing changed. Send these lines to your assistant."
    else echo "CHECK: mobile.html could NOT be put back as it was ($RWHY).${BK:+ The backup is $BK.} Send these lines to your assistant."; fi; exit 1; fi
}
# ---- step 8 (optional): what the running proxy serves, fetched from this server ----
proxy_pids() {   # the node processes running $D/tmc-proxy.js (by its real path)
  local want p a0 a f
  want=$(readlink -f "$PX")
  for p in /proc/[0-9]*; do
    { IFS= read -r -d '' a0; } 2>/dev/null < "$p/cmdline" || continue
    case "${a0##*/}" in node|nodejs) ;; *) continue;; esac
    a=$(tr '\0' '\n' 2>/dev/null < "$p/cmdline" | grep -m1 '\(^\|/\)tmc-proxy\.js$') || continue
    case "$a" in /*) f=$a;; *) f="$(readlink "$p/cwd" 2>/dev/null)/$a";; esac
    [ "$(readlink -f "$f" 2>/dev/null)" = "$want" ] && echo "${p#/proc/}"
  done
}
proxy_port() {   # PORT = the port the running proxy from $D listens on; WHYP says why when it cannot be told
  PORT=""; WHYP=""
  local def e rc
  def=$(sed -n 's/^const PORT = process\.env\.PROXY_PORT ? parseInt(process\.env\.PROXY_PORT, 10) : \([0-9][0-9]*\);$/\1/p' "$PX" | head -1)
  [ -n "$def" ] || { WHYP="tmc-proxy.js has no PORT line this tool knows, so its port is not known"; return 1; }
  set -- $(proxy_pids)
  [ $# = 1 ] || { if [ $# = 0 ]; then WHYP="no running tmc-proxy.js from $D was found, so its port is not known"; else WHYP="more than one tmc-proxy.js from $D is running (pids $*)"; fi; return 1; }
  e=$(grep -az -m1 '^PROXY_PORT=' "/proc/$1/environ" 2>/dev/null | tr -d '\0'; exit "${PIPESTATUS[0]}"); rc=$?
  if [ "$rc" = 1 ]; then PORT=$def; return 0; fi
  [ "$rc" = 0 ] || { WHYP="the environment of the proxy (pid $1) cannot be read, so its port is not known"; return 1; }
  e=${e#PROXY_PORT=}
  [ -z "$e" ] && { PORT=$def; return 0; }
  [[ "$e" =~ ^[0-9]+$ ]] || { WHYP="the proxy's PROXY_PORT is not a plain number, so its port is not known"; return 1; }
  PORT=$e
}
served_check() {   # $1 = the sha256 now installed. 0 = the same page is served, or the check was skipped (reason printed); 1 = CHECK printed
  command -v curl > /dev/null 2>&1 || { echo "Served-page check skipped: curl is not installed here."; return 0; }
  loopback_free || { echo "Served-page check skipped: this tmc-proxy.js may ask for its key even from this server, and this tool never uses the key."; return 0; }
  proxy_port || { echo "Served-page check skipped: $WHYP."; return 0; }
  local tf code sv
  tf=$(mktemp) || { echo "Served-page check skipped: no temp file for the fetched page."; return 0; }
  code=$(curl --noproxy '*' -s -o "$tf" -w '%{http_code}' --connect-timeout 3 --max-time 10 "http://127.0.0.1:$PORT/mobile.html" 2>/dev/null)
  sv=$(hfull "$tf"); rm -f "$tf"
  case "$code" in
    200) if [ "$sv" = "$1" ]; then echo "Served-page check: the proxy on 127.0.0.1:$PORT serves ${sv:0:8}, the installed page."; return 0; fi
         echo "CHECK: the proxy on 127.0.0.1:$PORT serves ${sv:0:8}, not the installed ${1:0:8}. mobile.html IS in place in $D (verified). Send these lines to your assistant."; return 1;;
    401) echo "Served-page check skipped: the proxy asked for its key, and this tool never uses the key."; return 0;;
    *) echo "CHECK: the proxy on 127.0.0.1:$PORT did not serve mobile.html (HTTP ${code:-000}). mobile.html IS in place in $D (verified). Send these lines to your assistant."; return 1;;
  esac
}
finish() {   # $1 = the sha256 now installed
  echo "Open the phone page and pull to refresh. No restart was needed; the bot was not touched."
  served_check "$1" || exit 2
  exit 0
}
# ---- the commands ----
if [ "$CMD" = install ]; then
  [ $# = 3 ] || usage
  UP=$2; WANT=$(printf '%s' "$3" | tr 'A-F' 'a-f')
  [[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: \"$3\" is not a sha256 (all 64 characters from the sheet). Nothing changed."; exit 1; }
  guard
  [ -f "$UP" ] && [ -r "$UP" ] && [ -s "$UP" ] || { echo "STOP: $UP is not there, or it is empty (upload mobile.html to the server first). Nothing changed."; exit 1; }
  GOT=$(hfull "$UP")
  [ "$GOT" = "$WANT" ] || { echo "STOP: $UP is not the file on the sheet: its sha256 is $GOT, the sheet says $WANT. Upload it again; if it still differs, send this line to your assistant. Nothing changed."; exit 1; }
  plain_page; H0=$(hfull "$PG")
  [ "$H0" = "$WANT" ] && { echo "DONE: mobile.html is already ${WANT:0:8} (the file on the sheet) - nothing to install. No restart was needed; the bot was not touched."; exit 0; }
  flat
  replace_page "$UP" "$WANT"
  echo "DONE: mobile.html installed (sha256 verified): before ${H0:0:8} -> after ${WANT:0:8}.${BK:+ Backup of the page it replaced: $BK}"
  finish "$WANT"
fi
if [ "$CMD" = rollback ]; then
  [ $# -le 2 ] || usage
  guard; plain_page
  if [ -z "${2:-}" ]; then   # the newest backup that is not the page now installed (a rollback that stopped after its backup still goes back on a retry)
    L=$(ls -1 "$D" 2>/dev/null | grep -E "$NAMERE" | LC_ALL=C sort -r); H0=$(hfull "$PG"); SRC=""
    [ -n "$L" ] || { echo "STOP: there is no backup in $D (mobile.html.bak-<UTC time>-<sha8>), so there is nothing to roll back to. Nothing changed."; exit 1; }
    for N in $L; do [ "$(hfull "$D/$N")" = "$H0" ] || { SRC="$D/$N"; break; }; done
    [ -n "$SRC" ] || { echo "DONE: mobile.html is already ${H0:0:8}, the same as every backup - nothing to roll back. No restart was needed; the bot was not touched."; exit 0; }
  else
    case "$2" in */*) SRC=$2;; *) SRC="$D/$2";; esac
    case "$(basename "$SRC")" in mobile.html.bak*) OK=1;; *) OK=0;; esac
    [ "$OK" = 1 ] && [ -f "$SRC" ] && [ ! -L "$SRC" ] && [ "$(cd "$(dirname "$SRC")" 2>/dev/null && pwd -P)" = "$(cd "$D" && pwd -P)" ] ||
      { echo "STOP: $2 is not a backup of mobile.html in $D (a plain mobile.html.bak... file there; status lists them). Nothing changed."; exit 1; }
  fi
  B=$(basename "$SRC"); FULL=$(hfull "$SRC")
  [ -n "$FULL" ] || { echo "STOP: $B cannot be read. Nothing changed."; exit 1; }
  if [[ "$B" =~ $NAMERE ]] && [ "${FULL:0:8}" != "${BASH_REMATCH[1]}" ]; then
    echo "STOP: $B is damaged: its content is ${FULL:0:8}, its name says ${BASH_REMATCH[1]}. It was not put back. Nothing changed.$([ -z "${2:-}" ] && echo ' (rollback <file> can name another backup; status lists them.)') Send this line to your assistant."; exit 1; fi
  H0=$(hfull "$PG")
  [ "$H0" = "$FULL" ] && { echo "DONE: mobile.html is already ${FULL:0:8}, the same as $B - nothing to roll back. No restart was needed; the bot was not touched."; exit 0; }
  flat
  replace_page "$SRC" "$FULL"
  echo "DONE: mobile.html rolled back (sha256 verified): before ${H0:0:8} -> after ${FULL:0:8}, from $B.${BK:+ Backup of the page it replaced: $BK}"
  finish "$FULL"
fi
if [ "$CMD" = status ]; then
  [ $# = 1 ] || usage
  if [ -L "$PG" ]; then echo "mobile.html : a symbolic link (install and rollback will STOP: they only replace a plain file)"
  elif [ -f "$PG" ]; then echo "mobile.html : $(h8 "$PG") ($(wc -c < "$PG") bytes)"; else echo "mobile.html : ABSENT"; fi
  if [ -f "$PX" ]; then echo "tmc-proxy.js: $(h8 "$PX") (reads mobile.html from disk on every request: $(per_request_read && echo yes || echo 'NO - install and rollback will STOP'))"
  else echo "tmc-proxy.js: ABSENT (install and rollback will STOP)"; fi
  L=$(ls -1 "$D" 2>/dev/null | grep -E "$NAMERE" | LC_ALL=C sort -r)
  if [ -z "$L" ]; then echo "Backups: none."; else echo "Backups, newest first:"; H0=$(hfull "$PG"); R=""
    for N in $L; do [[ "$N" =~ $NAMERE ]]; C=$(h8 "$D/$N"); if [ "$C" = "${BASH_REMATCH[1]}" ]; then T=ok; else T="DAMAGED: its content is ${C:-unreadable}"; fi
      echo "  $N  ($(wc -c < "$D/$N") bytes, $T)"; [ -z "$R" ] && [ "$(hfull "$D/$N")" != "$H0" ] && R=$N; done
    if [ -n "$R" ]; then echo "\"rollback\" (no file named) puts back: $R"; else echo "\"rollback\" (no file named): every backup is the page now installed."; fi; fi
  O=$(ls -1 "$D" 2>/dev/null | grep '^mobile\.html\.bak' | grep -vE "$NAMERE")
  [ -n "$O" ] && { echo "Other mobile.html.bak files (not made by this tool; \"rollback <file>\" can put one back):"; printf '%s\n' "$O" | sed 's/^/  /'; }
  exit 0
fi
usage
