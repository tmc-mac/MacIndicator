#!/bin/bash
# MacUI-N3 2.0.9.22 gate (MacArthur 11/04): the QC witness + the .21 witness on the .22 page, the 2.0.9.20 suite, shots, no-sideways, identity vs 2.0.9.21.
# One browser at a time, nice 19. Replay skipped (no replay-path change).
S=<SCRATCH>; H=$S/macui/harness; N2=$S/macui-n; P=$N2/cand22/mobile.html; T=$N2/gate22; P21=$N2/cand21/mobile.html; N="nice -n 19"
mkdir -p $T; export MACUI_V1="$H/src/mobile.r133.html" MACUI_V2="$P" MACUI_REEL_NUMBERS=labelled MACUI_REF="$S/mac-lv1/terminal2096-preview/mobile.html"
run() { name=$1; shift; echo "$name $(date -u +%T)Z load $(cut -d' ' -f1-3 /proc/loadavg) page $(sha256sum $P | cut -c1-8)"; timeout 1500 "$@" > "$T/$name.txt" 2>&1; rc=$?; echo "  exit $rc"; tail -1 "$T/$name.txt" | cut -c1-200 | sed 's/^/  /'; return $rc; }
( while true; do for p in $(pgrep -x headless_shell; pgrep -x chrome; pgrep -f chromium); do renice -n 19 -p $p >/dev/null 2>&1; done; sleep 2; done ) & RN=$!
until grep -q "pre done" $T/pre-LOG.txt 2>/dev/null; do sleep 5; done
cd $H; echo "N3 .22 gate start $(date -u +%T)Z page $(sha256sum $P)"
run 01-qc-20922 $N node $N2/tests/qc-20922.test.cjs
run 02-plan-leak-20921-on-22 $N node $N2/tests/plan-leak-20921.test.cjs
run 03-hourtype-20921 $N node $N2/tests/hourtype-20921.test.cjs
run 65-feat-20922 $N node $N2/tests/feat-20922.test.cjs
run 66-r17-20920 $N node $N2/tests/r17-20920.test.cjs
run 41-feat-20919 $N node $N2/tests/feat-20919.test.cjs
run 31-feat-20918 $N node $N2/tests/feat-20918.test.cjs
run 32-fill-late-20918 $N node $N2/tests/fill-late-20918.test.cjs
run 62-macfacts sh -c "cd $S/macfacts/test && $N node macfacts.test.cjs $S/macui-n/pkg-20918/mobile.html $S/macfacts/fix-macfacts.js $S/macfacts/fixtures --patched $P"
run 57-no-sideways $N node tests/no-sideways.test.cjs
run 42-shots-20922 $N node $N2/tools/shot-20920.cjs "$P" $N2/shots22 qc155-flat,qc154-pos,tide21-leak,mac1814
# identity vs 2.0.9.21: the TIDE-on states (tide21-leak, qc154-*, qc155-*) differ by design (the .22 items); every other state must be byte-identical
run 30-identity-vs-2.0.9.21 $N node $N2/tests/identity-20918.test.cjs "$P21" "$P"
kill $RN 2>/dev/null; echo "N3 .22 GATE DONE $(date -u +%T)Z"
