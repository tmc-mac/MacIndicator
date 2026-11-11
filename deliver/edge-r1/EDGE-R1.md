# edge r1: two measured exit rules, each behind a switch

Built on botfix r1.1 (cc47b40, executor 725b19ff). Branch `edge1`, local commits only. Mac, 11/11: "Our losses still seem too big in comparison to our wins" /
"Our bot's strategy has to be dynamic for the market type/session" / on the early exit: "I can agree with this".
Evidence: the live-journal studies A-LOSS-ANATOMY (full stops never worked: median MFE +0.75, stopped in a median 3.7 min) and B-RUNNER (the runner exits at
+10.5 or less on 76% of TP1 trades; NY runner with stop +2 / TP2 2.0 x ATR15: +$1,240 over 18 trades, small n).

Entries, sizing, the stop distance and np1's rule are not changed. Capped sizing stays off. Nothing here ran on the replay rig or a soak (Mac's stop order).

## 1. What changed

| File | Change |
|---|---|
| `lib/edgeExits.js` (new, pure) | config validation, the two startup lines, which 1m close the early exit reads, ATR15, the runner plan per session |
| `lib/liveStateMachine.js` | `earlyAdverseStep`, the `early-adverse` kind of `sessionFlatten`, `_decideRunnerPlan`, the ATR runner (stop, TP2, no trail, close), state save / restore |
| `live-executor.js` | 3 config keys, strict-loader enums, fail-closed startup checks, `[eae]` and `[runner]` lines, the poll-loop call, the runner TP2 in the close estimate |
| `lib/phoneSnapshot.js` | an early exit reports `exitReason: EARLY_EXIT` instead of UNKNOWN |
| `lib/safeExit.js` | the `[exits]` line names the early adverse exit |
| `tests/edge1-tests.js` (new) | 79 tests |

## 2. Rule A: early adverse exit

**Rule.** Once per trade, before TP1. At the first completed 1m close that is 120 s or more after the fill: if that close is 10 pts or more against the
position AND the trade has never been seen at +3 since the fill, the whole position is closed at market.

- **Exit path:** `sessionFlatten(reason, 'early-adverse')`, the same safe-exit path as np1 and level-loss: protective orders cancelled and verified first, the
  decision and the exit intent on disk before the market order, a lost reply = read the broker until it settles, at most 3 sends, then HALT. The stop is never moved.
- **MFE:** np1's own tracker (`npBestPts`: complete 1m bars that start after the fill minute). The poll price is journaled (`pollPeakPts`) but is not evidence.
- **Timing:** the close used must be within 180 s of the fill. With a 20 s poll the close is first seen up to about 20 s after it prints, so the decision is
  allowed up to 45 s after that close (`EAE_DECIDE_GRACE_MS`). Later than that, or the bar never arrives, or a 1m bar between the fill and the close was missed
  (MFE unknown), or the fill time is unknown (adopted position): the rule is **unassessed**, journaled, and the trade is left alone. There is never a late exit.
- **One owner per trade:** the executor calls the tracker, then the early step, then np1, then level-loss. The early step decides nothing while another exit is
  under way or decided. Once it decides to exit, np1 and level-loss stand down (one guard line each; np1's rule is untouched). A session close or a phone flatten
  that arrives while the early exit is retrying drives the same exit and keeps its label. TP1 filling before the order goes out = abandoned, runner managed as normal.
- **Alert:** `Early exit: never worked, −X pts`, then `Early exit: flat`. A cap halt is titled `Early adverse exit: exit REJECTED 3x`.

**Config** (`live-executor.js`, overridable in config-local.json):

```
earlyAdverseExit: { mode: 'exit', afterSec: 120, lossPts: 10, minSeenPts: 3 }
```

| mode | behaviour |
|---|---|
| `'exit'` (shipped) | the rule closes the trade |
| `'log'` | the same journal row with `wouldExit: true`, no order, no cancel, no alert |
| `'off'` | r1.1 exactly: the step is not called, no row, nothing in the saved state |

A value outside the enum stops the bot at the config-local check; a bad number stops it at startup (`earlyAdverseExit is unusable: ...`).
Startup line: `[eae] early adverse exit: ON (...)` / `LOG (...)` / `off`.

**Journal rows**

| type | when | fields |
|---|---|---|
| `early_adverse_exit` | the rule fires (`decision: 'exit'`, `orderSent: true`) or would fire in log mode (`decision: 'log'`, `wouldExit: true`, `orderSent: false`) | fill, fillSeenAt, close, closeAt, secAfterFill, pts, mfe, pollPeakPts, mode, the original stop / tp1 and their distances |
| `early_adverse_check` | assessed and kept (`decision: 'keep'`, why) or `unassessed` (why) | same |
| `early_adverse_flatten` | the market exit starts | contractsAtFlatten, reason |
| `early_adverse_outcome` | the trade ends, both modes, every trade the rule looked at | decision, wouldExit, exited, endedBy (early-adverse / full-stop / after-tp1 / session ...), tp1Reached, and `shadow` = where the original stop and TP1 were |
| `trade_manage` | `EARLY_ADVERSE_EXIT`, `_WOULD_EXIT`, `_UNASSESSED`, `_ABANDONED`, `_FLAT_CONFIRMED` | |

For the scorecard: in exit mode, walk the bars after `closeAt` against `shadow.stop` / `shadow.tp1` to see whether the exit helped; in log mode `endedBy` and
`tp1Reached` say what the trade went on to do.

## 3. Rule B: session runner rule

The session is the **fill's** session, from `stopFloor.sessionOf` (the stop floor's helper): london 00:00-06:30, ny 06:30-13:00, late 13:00-15:00, asia 15:00-24:00 PT.
The plan is decided once, at the first observation of the fill, and saved with the trade.

```
sessionRunner:   { asia: 'allAtTp1', london: 'allAtTp1', ny: 'atrTarget', late: 'live' }
sessionRunnerNy: { stopPts: 2, tp2AtrMult: 2.0 }
```

| mode | behaviour |
|---|---|
| `'live'` | today's runner: 2 of 3 off at TP1, runner stop +10, trail 10 behind in 10-pt steps |
| `'allAtTp1'` | the TP1 limit closes ALL contracts at the scale-out price. No runner. (The whole-position TP1 path a 1-lot already uses.) |
| `'atrTarget'` | TP1 as today. Then the runner's stop is replaced by a 1x stop at entry + stopPts in the profit direction (new stop first, verified cancel of the old one), and a TP2 limit rests at the fill ± tp2AtrMult x ATR15. No trail. The existing 13:05 PT session close flattens it. |

- **ATR15** = the mean true range of the 14 completed 15m bars before the fill (the forming bar is dropped; needs 15 completed bars, none stale), captured at the
  fill and stored in the trade state, so it survives a restart.
- **Fallback to `'live'` for that trade, journaled with the reason:** ATR15 unavailable, an ATR target that is not beyond TP1, a trade that is not a scale-out
  with one runner (a 1-lot, scale-out off), the rule function failing.
- **Profit-securing invariant:** after TP1 the ATR runner's resting stop is never worse than entry + stopPts. The level is rounded to the tick *into* profit.
  The ladder audit also holds it there. Asserted at every poll in the tests.
- **TP2 limit is never stacked:** a rejected placement retries after 15 s; an unknown reply waits 30 s; before every retry the working orders are read and a
  resting TP2 limit is adopted instead of placing a second one.
- All four sessions `'live'` = the rule is not wired into the order machine at all: no row, no log line, the saved state has the same keys as r1.1.
- With `scaleOutRunner.enabled: false` the rule is inactive and the startup line says so.

Startup line: `[runner] session runner: asia ...; london ...; ny ...; late ...`. Bad values stop the bot like rule A.

**Journal rows:** `runner_rule` at the fill (session, mode, requested, atr15, stopPts, tp2AtrMult, tp2, tp1, leg1Size, and `fallback` + `why` when it fell back);
`runner_exit` when an ATR runner closes at TP2 or its stop (kind, sure, price); `trade_manage` `RUNNER_TP2_PLACED` / `RUNNER_TP2_NOT_PLACED`, and the existing
`TP2_OR_BE` (viaTarget) / `RUNNER_STOPPED` codes so the phone shows TP2 / RUNNER_STOP.

Part C (`scaleOutRunner.atPtsBySession`) was not built: no per-session TP1 numbers were relayed during the task.

## 4. Tests (Node 18.19.1, nice 19)

`node tests/edge1-tests.js <this tree> <r1.1 tree> <tmpdir>`: the real state machine of both trees against one stateful fake broker (position, working
orders, order history, lost replies, rejections, sticky cancels). **79 / 79.**

| Area | Tests |
|---|---|
| Early exit fires / does not | fires at −10.00 with MFE 2.75 (long and short); not at −9.75; not with MFE 3.00; fires at −25 |
| Once only | a later worse close after "keep" is not evaluated; repeated polls while closing send one order, one row, one alert |
| Log mode | row with `wouldExit`, nothing sent; outcome row for a later full stop and for a later TP1 (the winner it would have killed) |
| Poll gap | before the close: nothing; seen 40 s late: evaluated; 50 s late: unassessed; bar never arrives: unassessed; tracker gap: unassessed; unknown fill time: unassessed; pure window check |
| np1 / level-loss ordering | early exit rejected once: np1 and level-loss stand down, its own driver finishes; np1 / level-loss / session close already deciding: early step silent; executor call order; TP1 first = abandoned |
| Lost reply | filled: settled flat, nothing re-placed; not filled: stop and TP1 back, one attempt used, retry closes; rejected 3x: HALT, no 4th order |
| Restart | decision and intent on disk before the order; restart mid-exit resumes and finishes; restart before the check; restart after "keep" |
| Off / config | mode off leaves no trace; validation; enums; startup lines |
| allAtTp1 | TP1 limit is 3x; all out, no runner stop ever placed; full stop; partial TP1 |
| atrTarget | +2 stop placed before the old stop is cancelled, TP2 at 2 x ATR15; no trail over 6 polls; TP2 fill; stop fill at +2 (no orphan limit); short; off-tick fill; session close flattens it |
| Fallbacks | ATR missing (order events equal r1.1), target not beyond TP1, function throws, 1-lot |
| Restart with the runner open | stop and TP2 kept, nothing cancelled or placed; TP2 missing at the broker is put back |
| Order failures | TP2 rejected then placed; TP2 reply lost then adopted (1 resting, never 2); +2 stop refused then moved to +2 and no further |
| `'live'` identical to r1.1 | same script on both trees: order events, journal, alerts and log lines identical (timestamps apart); full stop identical; saved-state keys identical |

Five mutations of the new code (`<=` to `<` on the loss, `<` to `<=` on the MFE, the np1 guard removed, the no-trail branch removed, the TP2 restore tracking
removed) each fail the tests that name them.

Existing suites, this tree against r1.1:

| Suite | r1.1 | edge r1 |
|---|---|---|
| exitsafe-tests.js | 63/63 | **63/63** |
| test/phone-snapshot.test.js | 12/12 | **12/12** |
| tests/health-alerts-tests.js | 28/28 | **28/28** |
| c5-tests.js (CL = config-off) | 25/25 | **25/25** |
| r11-tests.js | 42/42 | **42/42** |
| qa-tests-r11.js | 43/43 | **43/43** |

Outputs: scratchpad `botfix/edge1-tests/results/` (and `results-r11/` for the r1.1 run on the same machine).

## 5. Boot (60 s, nice 19, fake broker, Node 18.19.1, the r1.1 boot's config-local)

Exit 0 on SIGINT, 0 error / exception / FATAL lines, reached `Entering live loop, polling every 20s`. Output: scratchpad `botfix/edge1boot/out.txt`.

```
[np1] no-progress exit: ON (not seen at +15 pts by the first full 5m close after the fill = closed at market). ...
[eae] early adverse exit: ON (first 1m close 120 s+ after the fill, before TP1: at -10 pts or worse and never seen at +3 = closed at market on the safe-exit rule; close used within 180 s of the fill, decided within 45 s of it, else unassessed)
[runner] session runner: asia all contracts out at TP1 (no runner); london all contracts out at TP1 (no runner); ny runner stop entry +2, TP2 2 x ATR15 from the fill, no trail, flat at the session close; late live (unchanged) (by the fill's session; ATR15 missing at the fill = live for that trade)
[exits] safe-exit rule ON for every market exit (session close, morning hold, no-progress, level-loss, early adverse, filled-through-stop, ...
=== LIVE ORDER EXECUTOR starting for MNQ ===
```

Also booted briefly: `mode: 'on'` and `sessionRunner.ny: 'atr'` are refused by the config-local check; `sessionRunnerNy.stopPts: -3` is refused at startup;
`off` + all `live` prints `[eae] early adverse exit: off` and `[runner] ... live (unchanged)` four times; `log` prints the LOG line.

## 6. Limits

1. **Not run on the replay rig, no soak, no Mac-box run, no install-path run.** The ship gate (reviewer desk) is still owed before this reaches Mac.
2. **Decision window.** The brief says "only up to 180 s after the fill". Read literally (no decision after 180 s) a 20 s poll would leave a large share of trades
   unassessed (my estimate: around a third, not measured), depending only on the second the fill landed. Built as: the *close used* is within 180 s of the fill, and the decision is made within 45 s of
   that close. Change `EAE_DECIDE_GRACE_MS` in `lib/edgeExits.js` if the literal reading is wanted.
3. **MFE excludes the rest of the fill minute** (np1's tracker counts complete 1m bars that start after the fill minute). A trade that touched +3 only inside
   its fill minute and then closed at −10 would be exited. The study counted the post-fill part of the entry bar. `pollPeakPts` is journaled so the scorecard can see these.
4. **The exit fills at market after the close is seen** (0 to 45 s later), not at the 1m close price the study assumed.
5. **Evidence is small-n.** The early-exit CI touches zero and it lost on the 10/27-10/30 cohort; 3 trades on 2 days carry $905 of the NY runner's $1,240, and
   12 of 18 NY runners end about $16 worse than live. Both rules journal what is needed to score them live.
6. **ATR runner, TP2 and stop both rest at the broker** (no OCO), like TP1 + stop today. The poll after one fills cancels the other.
7. **A +2 stop refused at the scale-out** leaves the runner on its old stop (resized to 1x) until the next poll moves it to +2; if the market is already
   through +2 the runner is closed at market, as the +10 stop does today. In those moments the runner can end below +2.
8. **The ATR runner holds the bot's one position longer** (until TP2, +2 or 13:05 PT), so it can block later NY entries. Study B could not sign that effect.
9. **Paper mode is not changed**: both rules live in the LIVE order machine only.
10. **Adopted positions** (a restart with no usable saved state) take today's runner and are unassessed by the early exit.
11. The entry plan text and the phone's "x of n exit at TP1" line still describe the 2-of-3 split on an `allAtTp1` trade; the `runner_rule` row and the entry
    row's `leg1Size` are right. How the phone terminal displays the new `EARLY_EXIT` reason was not checked.
