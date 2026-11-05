# TIDE Stage 2a r1.6 (MacTrend / MacTrend-2, 11/05) - CHANGES vs r1.5.6

Base: r1.5.6 (engine tide-structure r3.7, HTF context). go.sh accepts the r1.5.6 install first (FROM-r156.sha256), r1.5.5 second.
Package status: all five suites green (MacTrend-3, 11/05 21:00 UTC; see "Witness status"); re-sealed.

## A. Trend lane - tide.trendLane (lib/trendLane.js trend-lane-r2; wire tide-wire-r2.7-live) - default ON, set-tide.sh trend=on|off
- DIR = the PREVIOUS 4H candle's close direction; flat -> trend_idle "no 4H direction (prior 4H flat)". The current 4H open is a reference level.
- HARMONY = the last COMPLETED 30M candle closed in DIR, re-read at every 5m close; else trend_idle "30M not in harmony (last 30M closed against DIR at hh:mm)".
- TRIGGER (5M only): a completed 5m candle that traded at a reference R (within retestTol 6 pts) and closed on the DIR side: 'reject' (wick >= 4 pts) or 'break'.
  R = every tracked level (board: PDH/PDL, PWH/PWL, opens, Asia/London, OR, IB ...), the TIDE zones, 4H/1H/30M/15m opens, the last 15m swing; nearest wins; no pullback.
- ENTRY market at the 5m close through the existing tideOrders path; STOP = the 30M candle's extreme against DIR +/- 2 ticks (stopBasis '30m-wick'), the previous 30M's when the current one is < 10 min old ('prev-30m-wick'). Never tightened.
- RE-ENTRY while DIR + HARMONY hold; caps capHour 2 / capDay 6 (config keys tide.trendLane.capHour / capDay = the spec's maxPerHour / maxPerDay). Level setup wins a same-bar tie (trend_tie row).
- Gates kept: TIDE entry blocks, open wait, flat-only, broker checks, session close, news wait. Not applied: ONE_IDEA, waveBias, retest-closed-inside, nearest-level, 4H-control veto, rule 18, grade gates. tide.trendLane.climax 'defense-confirms' (default) | 'block'.
- Rows (TIDE_KEEP): trend_arm, trend_signal (taken / why), trend_skip, trend_idle, trend_tie.
## B. Sizing - tide.sizeCap default 8 (set-tide.sh sizecap=N, 1..30)
- qty = clamp(floor($400 / (stopPts x $2)), 1, sizeCap) for EVERY TIDE entry; 1 lot only while stop <= 200 pts; above: GRADE_NO_FIT_CEILING with why "stop <pts> pts = $<risk> for 1 MNQ > $400 max: needed a better entry". Level setups keep their structural stops.
## C. Grade gate - tide.gradeGate 'aligned-pass' (default) | 'strict' (set-tide.sh grade=aligned-pass|strict; engine tide-structure-r3.8)
- A WITH-HTF level setup is never refused by a grade gate (logicalStop excepted); gradeTags + gradeWaived:true on the signal. 'strict' = r1.5.6 grading.
## C2. Rule 18 v3 - stale ACCEPTED-BREAK setups (lib/structure.js staleAccepted; Mac 11/05: a retest 232 pts away "isn't coming back; we'd be waiting hours")
- At every 5M close an armed accepted-break whose retest is still pending and whose level is more than max(staleR x risk, 60 pts) from the close is cancelled: setup_cancel why "STALE: <pts> pts from the level (max <limit>); re-arms if price returns within 6 pts (rule 18)"; the slot is released and the board drops it (no armed setup = no "retest pending"). risk = |level - the break candle's far side|.
- It re-arms ONCE as a fresh setup id (rearmedFrom) at the first 5M close back within retestTol (6 pts) of the level, same 4H period, zone unused, no same-way idea holding the slot. Same switch as rule 18: tide.staleR (0 = both off). Engine-only key structure DEFAULTS.staleAccept (true) exists for the identity witness; it is not a tide switch and set-tide.sh does not expose it.
- Witness v0-v6 (trend-lane.test.cjs): 27,083.25 level, 26,850 close -> STALE 233.25 pts (max 60); 27,078 -> re-armed S261 from S259; staleR 0 leaves it armed; a new 4H period forgets it.
- Identity: this is the one intended engine divergence from r1.5.6 under the default config (witness g3 shows the extra rows are STALE setup_cancel rows only); g / l prove everything else byte-identical with staleAccept off.
## D. Restart safety (live-executor.js)
- tide.day counts EVERY lv_tide row of the TradeDay file (reloaded and rebuilt alike, the startup row too); signals.taken = signal rows taken:true and NOT rebuilt; signals.replayed = the rebuilt ones.
- At startup, before the warm-up: today's TradeDay lv_tide rows + closed TIDE trades reloaded from the on-disk journal into the ring (120 rows / 64 KB; reloaded:true); snapshot tide.day (whole-day summary, <= every 30 s) and tide.warm (rebuild progress). Read-only toward the files. 'startup' row.
## E. Realized P&L (lib/tideLive.js tide-live-r1.2)
- live_end + tide.trades carry realizedUsd, realizedPts, fees, realizedNetUsd, exitFills, realizedSource 'calc'; entry fills carry slipPts (sign follows the direction: + = filled worse than the signal close, - = better; S448-E's short sold 8.5 higher = -8.5).
- feePerContractSide is a tideLive create() option (the executor's brokerCosts), never a money key.
- State-file resume: an r1.1 (pre-r1.6) or r1.2 state file is read and the open TIDE position re-owned and reconciled exactly as r1.5.6 did (the version set is module-scoped: an in-create const was a TDZ throw that orphaned every saved position in the first seal; L6a-L6f witness it incl. the r1.1 -> r1.2 case).
## F. Broker rejections
- order_reject row {t, side, qty, reason, setup} in TIDE_KEEP + push; tide.lastReject in the snapshot.
## G. Startup line
grade gate: aligned-pass (a WITH-HTF level setup is not refused by the grade gates; the failed gates ride on the signal as gradeTags) · size: $400 max · cap 8 (tide.sizeCap; qty = clamp(floor($400 / risk), 1, 8); a stop over 200 pts is skipped: needed a better entry) · trend lane ON (prior-4H dir · 30M harmony · 5M trigger at any level · 30M-wick stop · 2/h 6/day · climax defense-confirms; retestTol 6, defense wick 4, stop 2 ticks) · journal reload ON; rule 18 ON (...; an un-retested acceptance that far at a 5M close is cancelled STALE and re-arms once price is back within retestTol)
With trend=off, grade=strict, sizecap=30 the journal and orders are meant to be byte-identical to r1.5.6 (witness g).

## Not in this build
- Halt re-send of rejected orders; account.fills export; realized P&L from the BROKER's figure (source is always 'calc').
- Spec key names maxPerHour / maxPerDay are capHour / capDay in this build.
- Trend lane in the warm-up replay (the lane starts counting at the first live 5m close after the warm-up).

## Witness status (node v22.22.0, nice -n 19; no v18 on the build box - the server's v18.19.1 run is Mac's rig smoke) - MacTrend-3 re-seal
- net-retry 9/0 · tide-board 24/0 · tide2-exec 138/0 · tide-live 136/0 (L6a-L6f incl. the r1.1 state-file resume, L50e) · trend-lane 52/0 (j rewritten: the aligned-pass run diverges at its first waived take, so the strict refusal count (18) is not the waived count - the rows are in the test; r2/r4 explicit about rebuilt rows; T1-T5 on the fake broker; v0-v6 rule 18 v3; g/g2/g3/l identity).
- Identity (g): trend=off + grade=strict + sizeCap 30 + staleAccept off = r1.5.6 rows and takes on 1500 synthetic bars; the 11/04 fixture strict run (l) = r1.5.6's 5 signals / 35 GRADE_NO_TRADE.
