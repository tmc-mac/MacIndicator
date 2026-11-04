#!/bin/bash
# Reproduces the MacStructure shadow ledger (r3.2 + the r3.1 baseline) from the pinned inputs in this folder. Relative paths only; nice 19;
# at most 2 node processes. REBUILD_FIXTURES=1 also rebuilds the bias fixtures (bot r13.3.7 levelsPro, ~11 min); REGEN_PROXY=1 rebuilds the
# proxy's fixes_on/setups.csv with the study's own tide_setups.py. MANIFEST.json lists the sha256 of every input and output.
set -euo pipefail
cd "$(dirname "$0")/.."
D=proxy_root/replay1104/data
if [ "${REBUILD_FIXTURES:-0}" = 1 ]; then
  lane() { for td in "$@"; do read -r _ from to _ < <(grep "^$td " fixtures/tradedays.txt)
    nice -n 19 node ../tools/build-bias-fixture.cjs inputs/levelsPro-lib "$D" inputs/w.json "fixtures/bias-$td.json" "$from" "$to"; done; }
  lane 2026-10-28 2026-10-30 2026-11-03 & lane 2026-10-29 2026-11-02 2026-11-04; wait
fi
if [ "${REGEN_PROXY:-0}" = 1 ]; then nice -n 19 python3 -I tools/regen_fixes_on.py proxy_root proxy_root/tide/study/fixes_on; fi
mkdir -p r3.1-m41
nice -n 19 node tools/run-ledger.cjs inputs/structure-r3.1.js inputs/moneyRule-r4.1.js "$D/m1.json" fixtures r3.1-m41/engine-out.json &
nice -n 19 node tools/run-ledger.cjs ../lib/structure.js inputs/moneyRule-r4.1.js "$D/m1.json" fixtures engine-out.json
wait
nice -n 19 python3 -I tools/ledger_analysis.py . .
nice -n 19 python3 -I tools/manifest.py . > MANIFEST.json
