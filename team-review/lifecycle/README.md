# MacDot r1.5.6 lifecycle-only review transfer

NOT AN INSTALLER. NOT LIVE-READY. Provider and full ship gates remain BLOCKED.

Base: tmc-mac/MacIndicator commit de161d830e31a1a0d4ee2df0fe6286d1c9ffa868, docs/new-bot/live-r1.5.6/bot. Patch changes only lib/tideLive.js and lib/tideOrders.js. Keep all six other bot source files at the exact baseline. No strategy, HTF default or user-setting changes. This is a separate earlier review line; compare deliberately with later safety branches, never overwrite their work or apply directly to a running bot.

Reviewed resulting SHA256:
- lib/tideLive.js: 5982c0543c6d002daf614a7884a2a4469825958748bdb113886be4fcf6aa76df
- lib/tideOrders.js: de95398cebd884d8b468b1cafbc3bb60ab14a44bd332a7ed10f501b26e13c6ec

Reproduce in a disposable offline copy of the exact baseline bot directory:
1. Verify BASELINE-SHA256SUMS against that baseline.
2. Run patch --batch --fuzz=0 -p1 < candidate.patch in the disposable copy only.
3. Copy tests/ and run-correctness.sh beside the bot's lib/. Preserve the baseline tests/tide-live.test.cjs for optional legacy comparison.
4. Run bash run-correctness.sh with Node22.23.4 or a separately reviewed local runtime. No historical/strategy-performance replay is part of this runner.
5. Check the resulting module hashes above and six PRESERVED-SHA256SUMS.

Independent results: checkpoint257, safety53, metadata20, lost-answer68, r1.5.6 preservation33 and separately authored lifecycle113 all pass, 544 assertions total (overlapping coverage). Fresh archive and exact patch application were independently verified. Baseline original driver130/130; candidate under the enforcing fake119/130, with11 documented compatibility conflicts. Original assertions are not relabeled green.

Witnesses cover both-direction stop/target fill races during same-ID amendment, delayed unknown close after stop wins, delayed stop submission across restart, exact-tag recovery, shape-identical manual-order isolation, cumulative fills over amendments, malformed checkpoint quarantine, HTF half/tag sizing and slow-read gate rechecks.

The simulated adapter actually enforces the hypothetical execution contract; this is NOT evidence that the real provider does. Admission refuses an unqualified adapter. Do not turn capability flags on to make it trade. Need independently established execution-time reduction, atomic same-ID stop amendment, durable exact identity and terminal fill history. Initial entry-to-stop exposure, provider finality/late corrections, account/process ownership and old-state migration remain unresolved. The fake does not qualify Auto-OCO/Position Bracket/native-close behavior.

Exact Node18.19.1 execution was NOT RUN. The full 961MB/one-core warm-up, restart/armed-setup soak, integrated expected trades, health, install/rollback and flat-only release gates remain unfulfilled. No installation/deployment, broker calls or strategy-performance study was performed.
