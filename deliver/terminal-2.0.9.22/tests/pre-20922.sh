#!/bin/bash
S=<SCRATCH>; H=$S/macui/harness; N2=$S/macui-n; P=$N2/cand22/mobile.html; T=$N2/gate22; N="nice -n 19"
export MACUI_V1="$H/src/mobile.r133.html" MACUI_V2="$P" MACUI_REEL_NUMBERS=labelled MACUI_REF="$S/mac-lv1/terminal2096-preview/mobile.html"
while pgrep -f "identity-2092" >/dev/null; do sleep 5; done
cd $H; echo "pre start $(date -u +%T)Z"
echo "30c-macctl-recheck-21-vs-20 $(date -u +%T)Z"; env STATES=macctl MACUI_V2=$N2/cand21/mobile.html $N timeout 600 node $N2/tests/identity-20921-nohour.test.cjs $N2/cand20/mobile.html $N2/cand21/mobile.html > $N2/gate21/30c-identity-macctl-recheck.txt 2>&1; echo "  exit $?"; tail -1 $N2/gate21/30c-identity-macctl-recheck.txt | cut -c1-200
echo "01-qc-20922 $(date -u +%T)Z"; $N timeout 900 node $N2/tests/qc-20922.test.cjs > $T/01-qc-20922.txt 2>&1; echo "  exit $?"; grep -v "^PASS" $T/01-qc-20922.txt | cut -c1-900
echo "pre done $(date -u +%T)Z"
