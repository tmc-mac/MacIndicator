# EDGE-R15-REVIEW: independent review of edge r1.5 (NY runner profit lock), eaf14b6 on edge15 (r1.4 = 79b3c3b)

Reviewer desk (not the builder). Worked in archive copies (`review/edge15/wt` = eaf14b6, `review/edge15/r14` = 79b3c3b). Branch untouched, nothing committed or posted, no server touched.

## Verdict: SHIP WITH NOTES

The bot code moves money safely: I found no way for the lock to loosen a stop, leave the runner unprotected in normal running, put a stop on the wrong side, double-move, or fire on a non-atrTarget trade. Two things should be fixed before Mac is handed it (both cheap, neither changes order logic):

- **F1** `set-runnerlock.sh clear` can never succeed with the shipped default (lock ON), and an r1.5 `config-local.json` with a `lock` key REFUSES TO START r1.4 (rollback trap). Fix the script (3 lines) and tell Mac the rollback step.
- **F2** the "market already through the lock" exit writes NO `runner_exit` row at all (builder's test L5b hid this by allowing 0 rows). No money effect, but the row the office is told to expect (`profit_lock_market`) never exists.

Everything else is Low and can ride.

## Tests run
| suite | result |
|---|---|
| `node --test test/*.test.js` | 122 pass, 0 fail |
| `tests/health-alerts-tests.js` | 28 pass |
| `tests/edge1-tests.js . . tmp` | 79 pass |
| `tests/edge15-tests.js . <r1.4 tree> tmp` | 42 pass |
| my adversarial file `review/edge15/rev-tests.js` (run: `node rev-tests.js wt r14 tmp/rv`) | 14 pass, 2 FAIL (R1 = F2, R3 = F3); the fails are findings, not harness errors |
| config loader / validator probe `review/edge15/cfgtest.js`, `cfg14.js` | see 6 below |
| `set-runnerlock.sh` run against shimmed systemctl/journalctl/sleep in `review/edge15/sh` | see 6 below |

## Findings, ranked

### F1 (Medium, fix before handing to Mac): `set-runnerlock.sh clear` is broken; rollback to r1.4 crash-loops if a lock line is in config-local.json
Evidence (script run in a sandbox, bot shimmed to print what r1.5 would print):
- `off` writes `"lock": {"mode": "off"}`, restarts, startup line check passes, DONE. `on` the same. Both keep other `sessionRunnerNy` lines, back up with sha, put back on any failure. Good.
- `clear` removes `lock.mode`. In r1.5 the shipped default is **on**, so the bot then prints `NY runner profit lock: ON (`; the script expects `off (` (line 35, `clear) ... EXP2='NY runner profit lock: off ('`) and treats it as a failed start: it puts the old file back, restarts again, prints `FAIL: nothing changed`. Reproduced. Header line 7 ("the shipped 'off' applies again", "run it before rollback to r1.4") is false for r1.5.
- r1.4 refuses the key: loading `{"sessionRunnerNy":{"lock":{"mode":"off"}}}` into the r1.4 tree gives `unknown setting "sessionRunnerNy.lock"` (CONFIG-LOCAL ERROR, no start). So: Mac runs `off` (the documented undo), later rolls back to r1.4 -> r1.4 will not start, and the script that is supposed to remove the line cannot.
Fix: for `clear` set `EXP2='NY runner profit lock: ON ('` (the shipped default) and fix the header; add to the install notes "before rolling back to r1.4: `set-runnerlock.sh clear`, then roll back". Also consider that with default ON Mac never needs `on`; `off` is the only switch he needs.

### F2 (Medium for the office contract, no money effect): the "market already through the lock level" exit writes no `runner_exit` row
Builder could not verify (4); here is the trace and a test (R1 fails).
- `maybeRatchetTrail` -> `replaceTrailStop` -> `replaceStopSafely` rejected the stop, market was through, SELL at market confirmed, `this.leg3StopOrderId = null`, returns `exited`; builder sets `_lockExit = true`.
- Next tick, LEG23_OPEN: `leg3OpenBefore` is false (the id is null) so `expectedBefore === 0` and the branch at `liveStateMachine.js` ~2213 fires first: "every leg already exited at market - cleaning up and resetting" -> `reset()` (which clears `_lockExit`). `_atrRunnerClosed` is never reached, so no `runner_exit`, `profit_lock_market` is unreachable. Result of my test: `runner_exit rows 0`, codes `... ORDER_REJECTED, MARKET_EXIT`. The `MARKET_EXIT` trade_manage row is the only trace. Order side is fine: one market order, flat, nothing orphaned, `desynced` false.
- Same hole already existed for the audit path in r1.4, but the lock makes this path more likely (best price seeded at TP1, market gives it back before the stop goes out).
Fix: in `maybeRatchetTrail` after `lockWant && this[orderIdField] == null`, write the `runner_exit` row there (once, guarded by a flag cleared in reset), with `reason: 'profit_lock_market'`, `price` = the market price used (`px` from trailRefPrice; return it from `replaceStopSafely` as `{exited:true, px}`), `kind: 'stop'`, and journal it before the next tick. Make L5b assert exactly 1 row. Related: for this exit `trailStop` still holds the OLD stop (+2), so any row/estimate that reads `trailStop` as the exit price is wrong by up to the lock distance; the close estimate falls back to the bot's last price for a MARKET_EXIT, which is correct.

### F3 (Low-Medium): kill between "new stop placed" and "old stop cancelled" (builder did not test; I did, R2/R3)
State on disk is written before the replace (step reached, old stop id, old `trailStop`); nothing saves between place-new and cancel-old (saves are after the async wrapper).
- R2, kill after new lock stop placed, old still resting (state = old id): restore keeps the old (tracked) stop, **cancels the new lock stop as "unknown"**, then the ladder audit/ratchet re-applies: `cancel 104 | REST STOP 1 @ 20015 | cancel 102`. Final: exactly one 1x stop at the lock level. No duplicate or orphan persists, and the old stop protects throughout. PASS.
- R3, kill after the old stop was cancelled but before the save (state = old id, old `trailStop`; broker has only the lock stop): restore finds the tracked id missing, so the lock stop is "unknown" and **cancelled first**, then re-placed at the OLD level: `cancel 104 | REST STOP 1 @ 20002 | REST STOP 1 @ 20015 | cancel 105`. Final state is right (one stop @ lock) after the next poll, but there is a window with no stop at the broker (cancel then place; milliseconds to a second or two, longer if the place is rejected: then the code marks `missing-leg3StopOrderId` and the audit retries every poll with urgent alert) and the stop is briefly looser than the lock. Never permanent. Probability: needs a kill inside one replace (~0.3 s) of a once-per-trade event.
Fix (small): in `restoreFromState` for kind `runner` use `this._atrRunner() ? this._atrStopLevel() : this.trailStop` as the level, and skip cancelling an unknown stop that is the right size and on the protective side until the tracked one is rebuilt (adopt it as `leg3StopOrderId`). Not a blocker.

### F4 (Low): `runner_exit.reason` can say `profit_lock` when the lock stop never rested
`reason` is derived from `_lockLevel() != null` (a step reached) rather than from the stop that actually filled. If the replace failed/backed off and the +2 stop is hit, the row says `profit_lock` with `stop` = the +2 level. Fix: `reason = profit_lock` only when `stopPx` is at or beyond the lock level (`dir*(stopPx-fill) >= lockPts-tick`), else `runner_stop`.

### F5 (Low): `runner_lock` row is at-most-once, can be lost on a kill
State is saved before the row, so a kill between save and `journal()` leaves `rows:[i]` on disk and no row ever. By design (no duplicates) but the office must not assume one row per reached step; `runner_exit.lockStep` is the authority.

### F6 (Low, evidence ladder): the live keep/kill rule cannot be judged from the journal
Shipped ON, so the "recorded live, no orders, 20 cases" rung is skipped (Mac asked for it explicitly 11/11, so that is his call). But nothing records the counterfactual (what the +2 stop would have paid on the same trade: best after the lock, TP2 reached?). `runner_exit` has the lock result only. The study's pick (arm 50 / lock 10) was explored after seeing the other candidates, n = 18, edge vs the current rule +$0 to +$32 total at $2/pt; treat as insurance, not edge. Suggest: add `bestAfterLock` (poll best at exit) to `runner_exit`, or let the loop read it from `trade_state.best`.

### F7 (Info) other checks that passed or are notes
- Default-config upgrade: an r1.4 `config-local.json` loads unchanged and gets the lock ON by default (probe: `r1.4 style`, `empty overlay`). A config that raised `sessionRunnerNy.stopPts` to 10 or more now REFUSES start (default lock 10 must exceed stopPts); text is clear. Check Mac's live config-local.json for `sessionRunnerNy.stopPts` before install.
- A trade's lock is decided at the fill and saved with it; `set-runnerlock.sh` and a config change do not affect an open trade (needs flat anyway). Test L8 (r1.4 saved trade resumes with no lock) passes.

## Answers to the brief

1. **Off/absent = r1.4?** Yes. `lock` absent/off gives no `plan.lock`, `lockState` null, `_lockStep` never called, `_atrStopLevel` = the old formula (same rounding), no new row fields, snapshot rule shape unchanged, saved state has no `runnerLock`. Builder's L1 (orders, journal, state) passes and I read the diff to confirm. Note the SHIPPED default is ON, so "off" is the rollback/undo state, not the running state.
2. **On: loosening / unprotected / wrong side / double / wrong trade.** Loosen: no, `_atrStopLevel` is max/min of base and lock, the ratchet only fires for a strictly better level, the audit treats a stop dragged back to base as "worse" and raises it (R11). Unprotected: replace is `replaceStopSafely` (new stop first, then `cancelVerified`; stale ids are re-cancelled every poll). Wrong side: lock level is rounded INTO profit (long ceil, short floor, test L3h/R6); a stop the broker refuses because the market is through goes to the existing market-exit path, short side too (R5: BUY 1 at market). Double-move: one step index, ratchet and audit read the same level, and a stop already at the level is left alone. Non-runner trades: lock exists only when the plan resolved to `atrTarget` at the fill (atr15 missing = fallback live = no lock, R8a; `ny = 'live'` or allAtTp1 = no lock, R8b/L6; 1-lot exits all at TP1, no runner, R9; adopted positions never get a plan so they keep the old path; base-hit `runnerStopAtBE` returns before the lock). Shorts and longs: signs checked, R5/R6/L3f.
3. **Restart/kill.** Step saved before row and before replace (L4a, R12: a failed save moves nothing and writes no row, retried next poll). One restart: re-applies exactly once. Two restarts: no order, no row (R4). Kill between place and cancel: F3. Adopted positions: no lock by design.
4. **`profit_lock_market` row:** not guaranteed once, it is never written: F2.
5. **Best price.** `liveBar.c` is the current 1m bar's close, and the call is gated by `priceEvidenceOk` (the bar started after the fill and is less than 60 s old), so it is a traded price from this minute and cannot be stale or never-touched. Between polls highs are invisible: spikes up and back inside a poll never arm (R7) and a step arms late. The seed (`trailPeakPts` = TP1 distance) is a price the TP1 fill proves was touched. If the market has already fallen back through the lock level when the step is acted on, `replaceStopSafely` re-reads the price (`trailRefPrice`) and exits at market rather than placing a rejected stop (L5a/R5).
6. **Interactions.** earlyAdverseExit, level-loss and np1 act in LEG1 only, before TP1, so they never see the lock. Flatten and the session-close flat use the existing cancel-then-market paths, untouched by the diff. Display: the phone/proxy runner marker reads `trailStop`, which is set to the placed level after the replace, so it shows the moved stop (it shows the old one only until the replace succeeds). Scorecard ignores the row; `rulesView` shows `lock` only while log/on. Strict loader: r1.4 config loads; bad mode, typo key, lock >= arm, falling steps, empty steps, string steps, lock <= stopPts, bad step keys all refuse with clear text (probe output in `cfgtest.js` run). `set-runnerlock.sh`: reads fully, writes via temp file + fsync + readback + rename, backup with sha, requires typed YES for flat (and a second YES for `on`), restarts, checks the startup lines, restores and re-restarts on any mismatch, prints only config-local lines and the `[runner-lock]` line (no secrets); the undo `off` works, `clear` does not (F1).
7. **Office contract.** `loop_daily.py` parses neither new row: `PARSE_TYPES` (line ~425) lacks `runner_lock` and `runner_exit`, so they are dropped; the exit class stays `tp1-then-runner` for every lock outcome, and `rules.runner` carries only mode/session/atr15/tp2. What it must learn:
   - add `runner_lock` (once per `(journalId, step)`; mode `log` vs `on` kept apart; `superseded`; `wouldStop`, `from`, `bestPts`) and `runner_exit` (once per journalId) to `PARSE_TYPES`/`ONCE_TYPES`;
   - `rules.runner.lock` from `runner_rule.lock`, and `rules.runnerLock {mode, step, bestPts, wouldStop}` per trade;
   - an experiment calc (e.g. `runnerProfitLock`) with n = trades with `runner_exit.lockStep >= 1` and a split by `reason` (`tp2`, `runner_stop`, `profit_lock`, `profit_lock_market`);
   - tolerate the two known holes: no `runner_lock` row (F5) and no `runner_exit` row on the market path (F2) until fixed; use broker net for money, not `runner_exit.price`, for the market path;
   - the keep/kill needs the counterfactual (F6), which the journal does not carry.

## Files
- Review: `/tmp/claude-0/-home-user-MacIndicator/381b1833-c8be-58a5-b27d-e767976714fe/scratchpad/review/edge15/EDGE-R15-REVIEW.md`
- My tests: `.../review/edge15/rev-tests.js` (run from the tree copy: `node rev-tests.js <tree> <r1.4 tree> <tmp>`); probes `.../review/edge15/cfgtest.js`, `cfg14.js`; script sandbox `.../review/edge15/sh/`.

---

# Second review: fixes in 91b4a5b (`git diff eaf14b6 91b4a5b`)

## Verdict: SHIP (one Low note)

F1 to F4 are fixed and I could not break the fixes. Suites on 91b4a5b (extracted to `review/edge15/wt2`): `node --test` 122 pass, health-alerts 28, edge1 79, edge15 45 (builder added 3). My first file `rev-tests.js`: 16/16 now pass (R1 and R3, the two earlier fails, pass). New adversarial file `review/edge15/rev2-tests.js`: 12/12 pass (run `node rev2-tests.js wt2 r14 tmp`).

## Re-review questions
- **F3 adoption, wrong stop?** The adopt block runs only when phase is LEG23_OPEN, the saved runner stop id is GONE at the broker, the saved plan carries a lock, and it is an atrTarget runner. It takes only orders of type STOP, on the closing side, of the runner's size, at or past the base atrTarget level (tick/2 tolerance); the best of those. Tests: a 2x stop (S1), a stop below base (S2), a wrong-side stop (S3) are NOT adopted (cancelled by the existing cleanup, one correct stop re-placed at the lock level); a TP2 limit is never a candidate and stays the single TP2 (S4); two candidates (lock and base) leave exactly one stop, the better (S5). A stale or other-trade order cannot match: one contract, one position, and a stale old runner stop would carry the saved id (then `has()` is true and no adoption). Short side adopts correctly, no new stop placed (S6). Residual (Low, accepted): a foreign but correctly-sized, correctly-sided stop at or past base would be adopted; that is a protective stop of the right size on this contract, and the audit raises it to the lock next poll.
- **Two stops left?** No: adopted id goes in `keep`, every other order is cancelled by the unchanged cleanup (S5).
- **Lock-off restore unchanged?** Yes. The adopt block needs `runnerPlan.lock`; the re-place level change needs `_lockLevel() != null` (null for off, log, no lock). S10: with lock off the restore does exactly r1.4 (cancel unknown stop, re-place at +2).
- **F2 row exactly once?** The row is written in `maybeRatchetTrail` guarded by `!this._lockExit`, which is set at the same time and cleared only by reset; the next tick takes the reset branch and writes nothing. S8: two ratchet calls plus two ticks give 1 row, `profit_lock_market`, price = the market price used (20012), `stop` = the old stop. A failed replace (timeout, stop still resting) writes no row and the retry places the stop (S9); exit-unknown halts with the old stop id still set, so no row. Residual (Low): a market exit made by the ladder AUDIT (not the ratchet) still writes no runner_exit row; it existed in r1.4, and the ratchet runs first in the poll so it normally owns the lock exit.
- **F4 for shorts?** `dir*(stopPx - lockLevel) >= -tick/2` is correct for dir -1. S6b: short stop filled at 19985 gives `profit_lock`; S7: lock step reached but the stop never moved, short base stop 19998 fills, gives `runner_stop`.
- **set-runnerlock.sh, all four modes (shimmed sandbox, `review/edge15/sh`)**: `log`, `on`, `off` write the right value and pass the startup-line check; `clear` now succeeds (expects `ON (`), removes the line, and the config has no lock key; `off` after `clear` works. Notes print for off and clear; `bash -n` ok. Residual note: `clear` only removes `lock.mode`; if Mac hand-added `lock.steps`, a `lock` object remains and r1.4 would still refuse it. Say so in the rollback note: remove `sessionRunnerNy.lock` by hand if steps were customised.
