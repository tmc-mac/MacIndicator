#!/bin/bash
S=/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad; H=$S/macui/harness; N2=$S/macui-n; P=$N2/cand24/mobile.html; T=$N2/gate24; N="nice -n 19"
export MACUI_V1="$H/src/mobile.r133.html" MACUI_V2="$P" MACUI_REEL_NUMBERS=labelled MACUI_REF="$S/mac-lv1/terminal2096-preview/mobile.html"
run() { name=$1; shift; echo "$name $(date -u +%T)Z load $(cut -d' ' -f1-3 /proc/loadavg) page $(sha256sum $P | cut -c1-8)"; timeout 1500 "$@" > "$T/$name.txt" 2>&1; rc=$?; echo "  exit $rc"; tail -1 "$T/$name.txt" | cut -c1-200 | sed 's/^/  /'; }
until ! pgrep -f identity-20918 >/dev/null; do sleep 5; done
cd $H; echo "C .24 gate RESUME (after the container restart; 00, 65, 02, 43 landed before it) $(date -u +%T)Z page $(sha256sum $P)"
run 01-qc-20923 $N node $N2/tests/qc-20923.test.cjs
run 03-qc-20922 $N node $N2/tests/qc-20922.test.cjs
run 57-no-sideways $N node tests/no-sideways.test.cjs
run 30-identity-vs-2.0.9.23 $N node $N2/tests/identity-20918.test.cjs "$N2/cand23/mobile.html" "$P"
echo "C .24 GATE DONE $(date -u +%T)Z"
