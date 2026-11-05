#!/bin/bash
S=/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad; H=/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/macui/harness; N2=/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/macui-n; P=/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/macui-n/cand23/mobile.html; T=/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/macui-n/gate23; N="nice -n 19"
export MACUI_V1="$H/src/mobile.r133.html" MACUI_V2="$P" MACUI_REEL_NUMBERS=labelled MACUI_REF="$S/mac-lv1/terminal2096-preview/mobile.html"
run() { name=$1; shift; echo "$name $(date -u +%T)Z load $(cut -d' ' -f1-3 /proc/loadavg) page $(sha256sum $P | cut -c1-8)"; timeout 1500 "$@" > "$T/$name.txt" 2>&1; rc=$?; echo "  exit $rc"; tail -1 "$T/$name.txt" | cut -c1-200 | sed 's/^/  /'; }
cd $H; echo "B .23 gate start $(date -u +%T)Z page $(sha256sum $P)"
run 01-qc-20923 $N node $N2/tests/qc-20923.test.cjs
run 65-feat-20922 $N node $N2/tests/feat-20922.test.cjs
run 02-plan-leak-20921 $N node $N2/tests/plan-leak-20921.test.cjs
run 03-qc-20922 $N node $N2/tests/qc-20922.test.cjs
run 42-shots $N node $N2/tools/shot-20920.cjs "$P" $N2/shots23 qc155-flat,qc154-pos,tide21-leak,mac1814
run 57-no-sideways $N node tests/no-sideways.test.cjs
run 30-identity-vs-2.0.9.22 $N node $N2/tests/identity-20918.test.cjs "$N2/cand22/mobile.html" "$P"
echo "B .23 GATE DONE $(date -u +%T)Z"
