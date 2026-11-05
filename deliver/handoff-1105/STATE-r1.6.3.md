# STATE — bot r1.6.3 (5M trail), builder MacTrend-6, stopped 22:02Z 11/05. NOT SEALED, NOT SHIPPED.
Package: deliver/handoff-1105/wip/pkg-live-r1.6.3-wip (copy of r1.6.2 + the six files below). SHA256SUMS.txt, INSTALL.sha256, INSTALL.md, CHANGES-r1.6.md, go.sh, rollback.sh, set-tide.sh are still the r1.6.2 ones.

## Files changed vs r1.6.2 (diff -rq: exactly these six)
- bot/lib/tideLive.js: the 5M trail (trailMode/trailCfg/trailState/trailBar/trailSwing/trailWant/trailStep before pollInner; pollInner tail branches on cfg.trail: 'ladder' = r1.6.2 ladder verbatim; '5m' = 1m->5M aggregation into S.trail, after TP1 trailStep, before TP1 the ladder event with ladderOff:true). run() returns planner notes; ctx() strips trail keys before the money-cfg check; modify branch sets S.stopBy from S.trailBasis ('trail-5m' | 'floor-0.5R'); exitPath returns 'trail-5m' after a step. VERSION kept 'tide-live-r1.2' (state additive: S.trail).
- bot/lib/tideOrders.js onLadder (~line 266): ev.ladderOff -> protect.startR Infinity (R-ladder never fires; 15m structural + climax locks untouched); ev.wantStop/wantBy -> tighten() (in favour only, verified-replace modify path).
- bot/lib/tideWire.js: VERSION 'tide-wire-r2.10-live'; DEFAULTS.tide + trail:'5m', trailSwingStrength:2; configProblem validates both; TRAIL_MODES/TRAIL_SHIP/trailOf/trailSwingStrengthOf/trailLine exported; startup line adds " · trail: 5m structure after TP1 (+0.5R floor at +1R)" or " · trail: R-ladder".
- bot/live-executor.js: cfgFn passes trail + trailSwingStrength; CONFIG.tide default line gets trail:'5m', trailSwingStrength:2 (before htfAgainst); the 'startup' lv_tide row carries trail.
- bot/tests/tide-live.test.cjs: drv() cfgFn adds trail: o.trail || 'ladder'; new section "TR".
- bot/tests/trend-lane.test.cjs: identity norm regex tide-wire-r2\.\d-live -> r2\.\d+-live.
node --check passes on all libs + live-executor.js.

## Suites (node v22, nice 19), last complete runs
- net-retry 9/0; tide-board 24/0.
- tide2-exec 137 passed, 1 FAILED: D9 (CONFIG default-line witness does not expect the trail keys; update expectation or key placement).
- tide-live: last full run 143/1 (the failure was fixture t2, rewritten to a floor-based skip; rerun unverified). TRr0/TRr/TRr2/TRr3, TRs, TRt, TRu (34 rows / 12 requests byte-identical to the r1.6.2 driver with trail=ladder) were GREEN in that run.
- trend-lane: in flight when stopped (60/0 at r1.6.2; only the version regex changed).

## Wired (tested)
Swing detection (strength k, strict >, confirmed at the k-th later 5M close); short +2 ticks above swing high / long -2 ticks below swing low (long path coded, NOT witnessed); never backwards; 2-tick proximity skip with trail_skip row; +0.5R floor after +1R (hit1R latched); all moves via planner tighten -> modify (new stop first, ack, live_stop_ack, old cancelled verified); trail_step rows {t, from, to, basis, swingT, lastPx, best}; basis mapping; S.trail persisted (bars5, cur, lastT, swingT, swingPx, hit1R, steps); trail=ladder path identical to r1.6.2; config plumbing; startup line.

## NOT done
Witnesses (v) restart mid-trade resume and (w) long mirror; set-tide.sh trail=5m|ladder; rollback.sh known-since table (tide.trail / tide.trailSwingStrength since FROM-r163) and ORDER/name table; FROM-r162.sha256 and go.sh's FROM list; CHANGES-r1.6.md r1.6.3 section; INSTALL.md; SHA256SUMS.txt / INSTALL.sha256 regeneration; tide2-exec D9; identity witness with trail=ladder set explicitly.
Design decision for Mac: in trail '5m' mode the R-ladder is OFF (the +0.5R floor replaces it; 15m structural + climax stay). Note: 5M bars are collected only from the fill on, so the first swing confirms no earlier than ~(k+1) 5M closes after the fill. The shadow/replay virtual trade in tideWire (virtualBar) still uses the R-ladder.

## Fixture notes (tide-live.test.cjs section TR, after L50e)
T0 = next 5M boundary + 10 min; feed5(B, D, i, h, l, c) = five 1m bars of one 5M bucket; short 28000, TP1 27980 (0.67R) / TP2 27910, plan stop 28030 (R 30), 3 MNQ -> after TP1 1x runs at BE+1 tick 27999.75. (r)/(s): highs [27990, 27992, 27998, 27992, 27990, 27995, 27988, 27985, 27992, 27985, 27982], lows 27978, closes 27980 -> steps 27998.5 / 27995.5 / 27992.5, then tick 27993 -> stop fill, exits {tp1:2, stop:1}, realizedUsd 95. (t): bar0 c 27969 (+1R) then flat -> floor 27985; (t2, unverified): +1R then 27985.25 -> floor skipped, stop stays 27999.75; TRt3 price away -> floor placed. (u): r1.6.2 driver vs this one with trail 'ladder', same L-fixture, rows normalised on t / tide-<id> / version.
