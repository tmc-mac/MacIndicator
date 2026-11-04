# TIDE r2 "control shift": the new entry model for lv1 (supersedes SPEC-TIDE-r1 and its addenda)

Knowledge source (read first, fully): <repo>/knowledge/MAC-TRADING-PLAYBOOK.md.
Every rule below implements a playbook section; cite it in code comments. Mac: "You don't have to test it": build to the rules.
The witness trade (playbook §3) must be taken.

## A. Map (external structure), per 4H candle
- O4 = 4H open. Control is read intrabar with the bias score (playbook §2) on the forming 15m / 30m, using controlGateMin (0.15).
- Do not trust the read in the first 30 min of a 4H candle (cfg tide.firstMinutesWait 30).
- SELL control forms by either:
  - a FAILED break above O4 (§C.2), or
  - price below O4 with seller bias ≥ 0.15 held after the first 30 min.
  It HOLDS until price takes back the failed-breakout high, or the 4H closes and the new candle re-reads. No flip-flopping on every wave.
- External levels (playbook §4): 4H Open, PDH, PDL, Asia H/L, London H/L, 1H Open, taken from the bot's own level board.
- Market state from 1H external swings (confirmed 1H pivots, 2 bars each side):
  - TREND: the last 2 swing highs and lows step in one direction and the protected swing holds.
  - RANGE: price rotates between a clear 1H high and low (≥ 2 touches each side, overlap).
  - TRANSITION: neither.
  - Middle-of-range filter: in RANGE, no entries in the middle 50% of the range.
  - In TRANSITION, no entries unless at an external level with a confirmed §C trigger.

## B. Internal structure (the trigger layer)
- Internal swings: confirmed 5m pivots (2 closed 5m bars each side; reuse the bot's existing 5m swing logic in lib/noChase.js if it fits),
  plus 1m pivots inside the bounce for the entry timing.
- "Internal shift": a FULL-BODY candle (|close − open| ≥ 50% of range) closes through the last internal swing the trapped side defended.
  - Short: the higher low that launched the breakout or bounce.
  - Long: the last lower high.

## C. Entries (only in the 4H control direction)
### C.1 Accepted break → continuation on the defended retest
- Price breaks an external level in the control direction and holds outside it: ≥ 2 closed 5m candles outside, and the forming 15m/30m bias is on that side.
- Then a retest: a 5m wick touches back within retestTolPts (6) of the level, or through it by ≤ 1/3 of the 5m ATR, without CLOSING back inside.
- Entry on that retest's rejection: the first 1m close back in the break direction.
- Stop beyond the retest extreme + 2.
### C.2 Failed break → trade the trap after the internal shift
- Price breaks an external level AGAINST the control direction (or sweeps a level) and closes back inside within ≤ 3 closed 5m candles. That is failure.
- Then the internal shift (§B) against the trapped side. Failure alone is NOT a trade.
- Entry: on the retest of the broken internal swing (or the level), rejected from the other side.
  - Rejection = the first 1m close back away after a 1m/5m bounce toward it.
  - "Lower high under the level" counts: the bounce does not have to reach the level.
- Stop (playbook §5, option C):
  - 4H-type level / trap: beyond the failed-breakout extreme + 2.
  - Hour-type level: beyond the current 1H wick + 2.
  - Journal both, plus the bounce extreme, for later learning.
### C.3 No chase limit (playbook §7)
- The money rule (§D) is the only distance limit: it must fit ≥ 1 MNQ at maxLossUsd.
### C.4 Re-entry
- One trade per level per 4H candle per trigger kind.
- After a full stop, a new trigger needs a new internal shift.

## D. Money rule (playbook §6), shared lib/moneyRule.js, used by every entry path when moneyRule.enabled
- contracts = min(maxContracts 5, floor(maxLossUsd / (stopPts × 2))). 0 → MONEY_NO_FIT (journal).
- maxLossUsd: config, no hard-coded default in logic. Shipped value 300 for the switch, labelled "Mac sets this"; validated 100–500.
- minWinUsd 200: W = ceil_tick(200 / (2 × contracts)).
  - Scale-out at +W: every contract but 1 exits.
  - The runner's stop moves to +W, then trails runnerStepPts (10) as the scale-out runner does today.
  - A 1-lot exits fully at +W.
  - The runner's final target is the next external level in the trade direction, or the trail.
- NO day limit (Mac ruling 11/04: "No daily loss limit!"). Grade-based dollar risk per trade replaces maxLossUsd (playbook §17).
- The stop is never moved to fit. No stop cap from the fill and no session floor on these entries.
- No timed exit on these entries (noProgressExit off for them).

## E. Wiring and modes
- cfg tide: { mode: "off" | "shadow" | "add" | "only", ... }. Shipped "off" = byte-identical behaviour to r13.3.7.
  - shadow: journal only.
  - add: TIDE plus the existing level events.
  - only: TIDE is the only entry source; existing level-event orders are journaled TIDE_ONLY.
- cfg levelEventShift (bool, shipped false): when true, the EXISTING SWEEP-RECLAIM / SWEEP-LOSS entries also require the §B internal shift before ordering
  (playbook §8.2). Journal SHIFT_WAIT / SHIFT_OK.
- STILL APPLY: time blocks, news wait, session flatten/no-entry, flat-only, existing order placement + protective stop + reconciliation.
- DO NOT APPLY to TIDE: HTF_ALIGN, the 15m control-gate veto, levels noChase, candle-wait.
- Journal: lv_tide rows for state, control, acceptance, failure, shift, retest and signal, with all prices and the bias readings used; lv_attempt route "tide-market".
- Startup lines for tide, money rule and levelEventShift. Config validation: bad values → CONFIG-LOCAL ERROR.
- Tools on the shared atomic core: tools/set-tide.sh off|shadow|add|only|clear;
  tools/set-money.sh on <maxLoss>|off|clear (maxContracts 5, minWin 200, dayFullStops 2);
  tools/set-shift.sh on|off|clear.

## F. Safety checks (plumbing only; Mac said no strategy testing)
- Unit witnesses for every rule above, including the playbook §3 chart.
  - Expected short: shift at the 15:30 15m (28,511 failed, 28,448 broken), bounce to 28,394, 1m rejection ~16:08 ~28,367.
  - Stop above 28,511 (4H type) → 1 MNQ at $300.
- Each transcript case in playbook §8 as a witness:
  - reclaim without shift → no trade;
  - accepted break → continuation;
  - middle of range → no trade;
  - failed break without the internal low breaking → no trade.
- mode off identity (short replay), and one 'only' boot showing a signal reaching an order with its protective stop.
- Reviewer desk GREEN before it goes to Mac.

## D′ (FINAL, supersedes §D; Mac rulings 11/04, playbook §17): grade-based dollar sizing, MNQ only, no day limit
- Instrument: **MNQ only** (Mac: "we choose to trade one or the other, not both"; MacArthur chose MNQ for fine-grained size-down).
- Grade per signal, computed from the structure engine's evidence, in Mac's terms:
  - **A+:** all of
    - 4H control in the trade direction;
    - a trap (failed break) at an obvious pool: 4H Open, PDH/PDL, session/opening-range high/low, equal highs/lows;
    - a displacement shift;
    - the FIRST retest of the zone.
  - **B:** exactly one of those missing.
  - **C:** two missing, but still a valid §C trigger.
  - Fewer than C → no trade.
- Dollar risk per grade: cfg sizing.gradeRiskUsd { A: 900, B: 600, C: 300 }. These are the 150K values. Config per account; validated 50–2000.
  - Contracts = floor(gradeRiskUsd / (stopPts × 2)), capped by cfg sizing.maxContracts (account max, default 30 MNQ).
  - 0 → GRADE_NO_FIT (journal; only when the stop is so wide even 1 MNQ exceeds the grade dollars).
  - The stop is NEVER moved to fit.
- **Scale-in on A+ only:** half the contracts on the first trigger, the rest on the retest/FVG entry, both with the same structural stop and total risk ≤ A dollars.
  B/C: one entry, no adds.
- Minimum win shape from §D stays: W = ceil_tick(200 / (2 × contracts)) is the floor for the partial.
  - All but one contract exit at max(W, the first pool target).
  - The runner's stop moves to that point, then trails; the runner goes for the next pool.
  - (Mac's $200 minimum win; with bigger size W is small, so the first pool usually decides.)
- **NO daily loss limit of any kind. Do not build DAY_LIMIT.**
- No timed exits; no stop cap/floor; stops only move in the trade's favour.

## D″ EXITS (FINAL, Mac 11/04, playbook §18) — supersede the W / all-but-one / runner-at-W exit in D and D′
- TP: bracket target = nearest pool at or beyond 2R from entry (R = entry→structural stop); A+ = the next MAJOR pool beyond 2R.
  If no pool exists beyond 2R, use 2R exactly.
- Partial: cfg exits.partialFrac (default 0.5, Mac to confirm) at the first internal pool between entry and TP (if none before 1R, use 1R).
  After the partial fills: stop to breakeven (entry ± 1 tick toward profit).
- Trail: after the partial, each time a minor 1m/5m swing forms beyond the last and the previous minor pool is swept, move the stop behind that swing.
  Never widen.
- Scale-in on A+ (D′) keeps one combined position and one protective stop; the partial/TP apply to the combined size.
- No $200 W rule. No timed exits. No daily loss limit.

## GRADE (FINAL, Mac 11/04)
Points: control4h + bias past the bot line (0.15) are REQUIRED. Then +1 each:
- strong-pool trap;
- displacement shift;
- first retest;
- bias STRONG = |score| >= 0.45, the Levels PRO "STRONG BUYER/SELLER CONTROL" line (lib/levelsPro.js:576-577; Pine v2.7.4:1360);
- bias GROWING (below).
Bias does NOT count double.
A+ >= 4, B = 3, C = 2, < 2 no trade.
- GROWING, read fast the way Candace reads speed:
  - the forming 15m or 30m bias, sampled every 1m, moved >= 0.10 further in the trade direction within the last 5 minutes; AND
  - a 1m displacement candle in the trade direction (body >= 60% of the range, range >= 2x the 20-bar average 1m range) within those 5 minutes.
  - Live may use 15s bars built from the quote stream for the displacement check (cfg tide.speedTf '1m'|'15s'; default '1m'
    until the quote-built bars are verified).
  - All thresholds are config.

## D‴ PROFIT PROTECTION (Mac 11/04: "we still need to make sure we're protecting profits") — adds to D″, all config (exits.protect)
R = entry→structural stop distance. Stops only ever move in the trade's favour (never widen).
1. R-ladder, on the whole remaining position, whether or not the partial has filled:
   - +1R → stop to breakeven (+1 tick);
   - +1.5R → lock +0.5R;
   - +2R → lock +1R;
   - each further +0.5R → lock 0.5R more (lock = best R − 1R).
   Rule of thumb: a trade that touched +1R can't close red; one that touched +2R closes ≥ +1R.
2. Partial at the first pool (D″) still applies; afterwards the stop is at least breakeven.
3. Structural trail on the 15m (not the 1m/5m): after a MAJOR pool in our direction is swept, the stop may also move behind the last
   confirmed 15m swing, if that is tighter than the ladder. Minor 1m/5m swings do NOT move the stop (gives the runner room through
   bounces like 11/04 16:45).
4. Climax warning (playbook §12.5) in our favour (volume >= 2x the 20-bar median, narrowing progress, close back toward the middle):
   lock behind the last 5m swing.
5. The existing session flatten / no-entry times still apply. No timed exits otherwise.
   NO daily loss limit.

## D⁗ PARTIAL + PYRAMID (FINAL, Mac 11/04: "2 out of 3 and add 1 at the next pullback while it trends in our favor and dump the last 2 at TP2")
- TP1 (first internal pool, D″): exit 2/3 of the position (round to nearest; a 3-lot exits 2). The stop moves to at least breakeven; the ladder (D‴) keeps running.
- PYRAMID ADD (once per trade): after TP1, add 1/3 of the ORIGINAL size (3-lot → 1) on the next pullback, only if ALL hold:
  - the trend is still ours: forming 15m/30m bias on our side past the line, and the 4H control unchanged;
  - the pullback is a retest of a broken minor swing or a 5m FVG in our direction, with a 1m rejection candle;
  - HOUSE MONEY: with the add, the combined position closed at the current protective stop is >= breakeven
    (the runner's locked profit covers the add's risk). Otherwise no add (journal ADD_SKIP with the reason);
  - the price has not yet reached TP2.
  - The add shares the ONE protective stop (verified replace to the combined qty) and the ladder applies to the combined position
    from its average entry.
- TP2 = the D″ target (nearest pool ≥ 2R; A+ next major pool). Exit everything left (the runner + the add) there.
- Applies to every grade. Scale-in at entry (A+ only) still happens before TP1.

## D⁵ ENTRY BY GRADE + GRADE-UPGRADE ADD (FINAL, Mac 11/04 "yes, and add the grade-upgrade add too") — supersedes the "scale-in on A+ only" in D′
Matches Candace's actual method (playbook §16: "this one I'm just so confident ... I just enter five contracts at the same time"; normal setups 2+2).
- **A+ ($900): ALL AT ONCE** at the trigger. No entry scale-in.
- **B ($600): SCALE IN.** Half at the trigger (rounded up). The second half rests at the retest/FVG level with the same structural stop;
  combined risk ≤ $600. Cancel the resting half if price reaches TP1 first, or if the setup is invalidated.
- **C ($300): ONE small entry.** No entry scale-in.
- **GRADE-UPGRADE ADD (B or C trades only, once per trade):** while the trade is open and BEFORE TP1, if the live grade re-scores to A+
  (same evidence rules: e.g. bias reaches STRONG 0.45 and GROWING), add on the next rejected pullback the contracts that bring the total
  risk up to the A+ dollars ($900) at the SAME structural stop. Rules:
  - the stop never moves to fit;
  - the add joins the one protective stop (verified qty replace);
  - a B trade whose second scale-in half is still resting: cancel/merge it first, total risk ≤ $900;
  - journal GRADE_UPGRADE (old/new points);
  - not after TP1. After TP1 the D⁗ pyramid add is the only add.
- After TP1, every grade: 2/3 off, BE, one house-money pyramid add, everything out at TP2 (D⁗), with the R-ladder (D‴).

## GRADE r2 (Mac 11/04: "that strong bias filter is going to prevent a lot of trades ... market moves in waves") — supersedes the bias parts of GRADE (FINAL)
Data (6 days of 1m readings, stronger of forming 15m/30m): |bias| median 0.20, p75 0.31, p90 0.39; only 4% of minutes ≥ 0.45.
On 11/04 the bias peaked about −0.26 in the break wave and flipped to about 0 during the bounce (16:08 −0.01).
- NO bias requirement at the entry minute. The pullback is a counter-wave and is allowed to flip the bias.
- REQUIRED instead: "control taken". During the break/shift wave (from the break of the level to the shift candle), the forming 15m or
  30m bias reached the line (0.15) our way at least once.
- Point "STRONG IMPULSE": the peak bias our way during that break/shift wave ≥ cfg tide.grade.impulseBias (default 0.25, Mac to confirm).
- Point "GROWING TURN": at the trigger, within the last 5 min the forming 15m/30m bias swung ≥ 0.10 back our way (the counter-wave ending),
  AND a 1m displacement candle printed our way.
- If GROWING TURN arrives a minute after the trigger, the live re-grade (§22 grade-upgrade add) can still lift the trade.
- 4H control (structure) stays required.

## GRADE r3 (FINAL, Mac 11/04 "yes") + TIME BLOCKS (FINAL, Mac 11/04 "skip the old time blocks") — supersede GRADE (FINAL) and GRADE r2
GATES (any fail = no trade):
- 4H control;
- a lane trigger: failed break + displacement shift (body ≥ 50%, range ≥ 1× the 20-bar average), or accepted break + defended retest
  (≥ 2 closes outside, the retest doesn't close back inside);
- breaking-wave bias peak ≥ 0.20 our way, frozen causally at the decision;
- first retest only;
- not mid-range (middle 50% of the 1H range) and a logical stop.
POINTS (+1 each, equal weight):
- TRAP at a stacked/obvious pool;
- FORCE (leg ≥ 2× ATR5m, or shift bar ≥ 2× average range);
- VOLUME (pullback mean 5m volume < break-candle volume);
- TIMING (sweep/break within 60 min of the 15:00 / 00:00 / 06:30 PT opens);
- IMPULSE BAND (0.30 ≤ wave peak < 0.40).
CAP: wave peak ≥ 0.40 → max grade C (tag exhaustion-watch).
A+ = 4–5, B = 3, C = 0–2. 11/04 witness = A+ (4).
TIME BLOCKS:
- the new model IGNORES the old time blocks: Asia 15:00–17:00, NY-open 06:30–07:10, morning hold.
- Its own rule instead: no new-model entries in the first 30 min of a session (15:00, 00:00, 06:30 PT) or of a 4H candle.
- News wait and session flatten/no-entry times still apply.
- The old entry paths keep their blocks.
- cfg tide.useTimeBlocks default FALSE; tide.openWaitMin 30.
