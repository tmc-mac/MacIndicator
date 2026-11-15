# Change 5: exitOnLevelLoss (exits5m r1, on top of the Nov 2 build lv1 r13.3.5, pkg-A47, executor 07e8e798)

## What it does
Before TP1 (phase LEG1_OPEN) only: when a completed 5m bar closes 1+ tick back through the trade's trigger level against the position
(long close < level, short close > level), the whole position is closed at market through the existing verified session-close
exit (`sessionFlatten`, kind `level-loss`): stop and TP cancelled verified, stops put back if the market exit is rejected.
The stop is never moved or tightened. A wick does not count, nor the still-forming bar. Never before the fill; a bar that ended
before the fill never counts. After TP1 it does nothing (a decided exit that TP1 beats is abandoned). The decision is saved before
the exit is sent; the journal row `level_loss_exit` {t, level, levelName, close5m, qty, entry, pnlPts, barT, dir, journalId} is written once.

Trigger level = the entry's `signalContext.levelProof.price` (the level event the order was taken on). No level proof (MAC-only entry,
adopted position) = never evaluated.

## Switch
`"exitOnLevelLoss": false` in config-local.json turns it off (shipped default true). Off: no 5m read, no level noted, no state field,
np1 runs as before; the trade-state file and decisions are identical to Nov 2 (test 5).

## Files (vs pkg-A47)
- lib/exits5m.js (new, pure): `completedBars`, `levelLost`.
- live-executor.js: :62 require; :1441 CONFIG default `exitOnLevelLoss: true`; :1982 startup log line; :4239-4268 level note map,
  one 5m read (12 bars) per 5m bucket, `levelLossStep` (arms `stateMachine.lossLevel` once the fill's journal id is known);
  :5528 level noted when the order is handed off; :5930 called each poll before np1 (np1 skipped while a level-loss exit is under way).
- lib/liveStateMachine.js: :33 require; :37 `levelLossStep` persisted; :63 `lossLevelRestore`; :154 field; :258 saved in the trade
  state; :346-347 restored (flattenKind 'level-loss' kept); :1094 `levelLossStep` decision; :1215 level-loss label in `sessionFlatten`;
  :1236 close cause `level_loss`; :1758 flat-confirm message; :2572 cleared on reset.
- lib/journalMeta.js:42 `exitOnLevelLoss` added to the projected trading settings.

## Restart
`lossLevel` (incl. a decided `exitAt`) is in the trade-state file. After a restart the machine evaluates only bars that ended after
the restored fill time; when the fill time does not restore (np1 coverage invalid) it uses the restore time, so a bar completed
before the restart is not evaluated. A decided exit resumes without a second journal row.

## Known limits (not changed, for the reviewer)
- The level is held in memory between the order and the first LEG1_OPEN poll: a restart while the entry is still resting, or before
  that first poll, leaves that trade without the level-loss exit (it trades exactly as Nov 2).
- It uses the session-close exit as is: an exit whose broker outcome is unknown (timeout) is treated like a rejection (stops put
  back, retried), as the session close does today; np1's halt-on-unknown is not applied to it.
- If TP1 fills during the exit's cancels, the remaining size is still closed at market (the exit was already decided).

## Tests (Node 18.19.1, offline, stubbed broker): exits-build/tests/c5-tests.js - 25 passed, 0 failed
1 fires long and short on a 5m close through (journal row fields checked; stop untouched; close exactly at the level does not fire);
2 wicks do not fire (incl. a forming bar beyond the level); 3 no fire in LEG23_OPEN / LEG3_OPEN; 4 no fire in PENDING_ENTRY / FLAT
or on a bar that ended before the fill; 5 off: executor gate, state snapshot and np1 decisions identical to the pkg-A47 machine;
6 save, restore (level + fill time kept), no fire on the same bars, fires once on the next bar, decision on disk, second restart
resumes the pending exit without a second row.

## Boot pass (boot-run.py, fake broker, Node 18.19.1, live config-local)
run1: Entering live loop at 1.5 s, 29 overrides applied, peak RSS 224 MB, no errors, clean SIGINT exit.
run2 (restart): live loop at 1.0 s, 29 overrides, peak RSS 232 MB, no errors.
run3 (config-local + exitOnLevelLoss:false): accepted by the strict loader (30 overrides), "level-loss exit off", live loop, no errors.
