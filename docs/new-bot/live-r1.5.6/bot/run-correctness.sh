#!/usr/bin/env bash
# Synthetic offline review only. No historical replay, host, account or installer.
set -euo pipefail
cd -- "$(dirname -- "$0")"
NODE="${NODE:-node}"
for f in lib/tideLive.js lib/tideOrders.js live-executor.js; do "$NODE" --check "$f"; done
for t in candidate-load-incident candidate-safety candidate-metadata candidate-lost-answers r156-preservation independent-r156-lifecycle; do "$NODE" "tests/$t.test.cjs"; done
# Optional separate diagnostic: legacy-compat.test.cjs exits1 with11 documented conflicts.
# Do not run the historical witness board/engine tests for this task.
