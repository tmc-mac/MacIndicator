#!/bin/bash
# Builds the per-TradeDay bias fixtures (bot r13.3.7 levelsPro via tools/build-bias-fixture.cjs), two lanes, nice 19.
S="$1"; L="$S/tide/v2/structure/ledger"; B="$S/tide/v2/structure/tools/build-bias-fixture.cjs"; LIB="$S/tide/study/ref/lib"
lane() { for td in "$@"; do read -r _ from to _ < <(grep "^$td " "$L/fixtures/tradedays.txt");
  nice -n 19 node "$B" "$LIB" "$S/replay1104/data" "$S/tide/study/ref/w.json" "$L/fixtures/bias-$td.json" "$from" "$to" > "$L/logs/build-$td.log" 2>&1; echo "$td exit $?" >> "$L/logs/build.done"; done; }
: > "$L/logs/build.done"
lane 2026-10-28 2026-10-30 2026-11-03 &
lane 2026-10-29 2026-11-02 2026-11-04 &
wait
echo ALL >> "$L/logs/build.done"
