# TRADER: a setup grade that matches how Mac trades (MacGradeTrader, strategy desk, 11/04)

Source: knowledge/MAC-TRADING-PLAYBOOK.md (§ numbers below), SPEC-TIDE-r2 GRADE r2, tide/v2/structure/lib/structure.js (what the engine already computes),
the witness fixture tide/v2/structure/tests/fixtures/witness-1104.json (5m bars rebuilt from its 1m bars), tide/study/readings.csv (bias readings).
Analysis only. Nothing was run beyond reading bars around the witness.

---

## 0. The verdict in one paragraph

The current grade measures the wrong thing for quality: **bias size**. The bias score reads control that is already in place, so it is weakest
at the turn of a trap, and traps are what Mac's A+ is (§17: "a trap at an obvious pool"). That is why the witness reads only −0.27 and grades B.
Meanwhile two of the four current points are really **gates** the playbook already makes mandatory: displacement (§15: "Displacement is
required for the shift") and the first retest (§13.7: "trade only the FIRST retest"). At the trigger the engine scores "first retest" as true
because no retest has happened yet, so that point is free. My grade keeps the gates as gates and scores only what the playbook calls the
size of the edge:
- **who is trapped** (§10);
- **how big and obvious the pool is** (§14);
- **how hard price broke away** (§8.8, §15), measured in price, not in bias;
- **when it happened** (session-open sweeps: §10.6, §14.7, §15.2).

The witness scores 4/4 = **A+**.

---

## 1. Critique of the current proposal

| # | Current item | Problem | Playbook |
|---|---|---|---|
| 1 | "Strong impulse" = break-wave bias peak ≥ 0.30 | Bias size is a lagging, lower-timeframe reading. In a V-turn it is smallest exactly where the trade is best. On the witness the bias was **+0.40 for the buyers at 15:28** (the trapped side at its most confident), only reached **−0.27** (30m, 15:58) on the way down, and flipped to **+0.23** (30m, 16:06) on the bounce Mac sold. Your own data: ≥ 0.45 was no better (exhaustion), and it is only 6 days. The point penalises the best trap trades and rewards late drift trades. | §1 "Many traders lose because they allow non-controlling timeframes to make controlling decisions"; §8.8 "Strong structure ... breaks away with force"; §12.5 |
| 2 | "First retest" as +1 | §13.7 makes it a rule ("the second is journaled and skipped"), and the engine already skips second retests (`firstRetestOnly`). At the trigger the engine sets it to true because the retest count is 0 (structure.js emit: `trigger → retests === 0`). So the point is either free or a gate, never real information. | §13.7 |
| 3 | "Displacement shift (body ≥ 60%)" as +1 | §15 says displacement is *required* for the shift, and §8.2 says a reclaim without the shift "chops and stops you out". As a point it only splits 50–59% bodies from 60%+, and that line is fragile: the witness shift bar (15:35 5m) had a **144.8-pt range, 3.75× the 20-bar average, on about 2× median volume**, and a **59% body**. It misses "displacement" by 1%, and the engine falls back to the 15m close (28,334.5), 32 pts worse than Mac's entry. The force is in the range, not the body %. | §8.2, §15 |
| 4 | "Strong pool" | (a) It does not see **stacking**. The witness push went through four obvious pools: 4H Open 28,414, London High 28,426.5, PDH 28,449.75 and Asia High 28,462.75 (board values at 15:01). It scores the same as a lone PDH tap. (b) The proposal text counts session/OR highs and lows, but the engine's `strongPoolWeights: ['strong']` excludes them (Asia/London H/L and OR are weighted `obvious`). The text and the code disagree. | §14.1, §14.5 "Pool size grows with touches" |
| 5 | No "who's trapped" factor | A failed break (trapped traders) and an accepted-break continuation get the same pool point, because `acceptedUsesControlTrap` gives every continuation in that 4H period the credit of the earlier trap. The trapped side's fuel was spent on the first leg. | §10 "Their exit is your entry"; §8.5 "best trade is often in the direction of the traders who just got trapped" |
| 6 | No session timing | The study material raises timing five times (§10.6, §12.3, §12.4, §14.7, §15.2), and the witness *is* the §10.6 opening-range trap ("This is exactly Mac's 11/04 chart"). The grade ignores it. | §10.6, §14.7, §15.2 |
| 7 | Volume rhythm | Correctly a gate on the accepted-break path (§13.2–13.3; the engine has `VOL_RHYTHM` and `BREAK_LOW_VOL`). It must **not** apply to trap trades: the witness bounce ran on high volume (16:00 10.4k and 16:05 11.4k vs a median of about 7k) and the trade still went 700 pts. Keep it scoped. | §13.3 is about breakout retests |
| 8 | Middle of range, climax, room | Already engine gates (`MID_RANGE`, `TRANSITION`, `CLIMAX`). Keep them as gates, never points. Room (§8.3 "never build a trade ... into an external level against you") is only a warning today (`roomBlock: false`). I would make a major pool < 1R against a gate. | §8.3, §8.6, §8.7, §12.5, §14.8 |
| 9 | 4H "trap" vs plain "below" | Trap-kind control is §3's "the 4H gives information". The "below" kind (bias held under the open) can be range drift. My grade handles it without a new factor: only a failed break earns the Trap point, so "below"-kind continuations top out at B. | §3, §8.6 |

**Factors that don't belong as points:** bias size (strong impulse, STRONG 0.45, GROWING), first retest, plain displacement.
Keep "control taken" (bias ≥ 0.15 our way during the break wave) as a gate. That is §2's own definition of control. Grading size on top of it
is the lower timeframe making a controlling decision.

**Track record warning:** the old live grades ran *inverted* (10/14–10/20 journal: C +0.13R per trade, A −0.39R, B −1.03R; EOD 10/20 board).
A grade only earns a dollar spread once replays show A+ > B > C in mean R. Until then the spread should stay modest, and that is Mac's call.

---

## 2. The proposed grade

### Gates: all required, otherwise no trade (journal the failed gate)

| Gate | Plain words | Mechanical (engine terms) | Why |
|---|---|---|---|
| G1 Tide | The 4H is on our side | `P.control.dir === dir` (trap or below kind) | §1 |
| G2 Trigger | A failed break plus a shift with displacement, or an accepted break plus a defended retest | Failed: a break beyond the zone and a 5m body back inside within `failBars` 3; then a full-body (≥ 50%) candle closes through the defended swing with **range ≥ 1× the 20-bar average** (≥ 60% body not required). Accepted: ≥ 2 5m closes outside, breakout volume > the 20-bar median, pullback volume < breakout volume, rejection at the zone | §8.1, §8.2, §13.2–13.4, §15 |
| G3 Control taken | During the break/shift wave, the forming 15m or 30m bias reached the line our way at least once | the peak of dir·max(s15, s30) from the break to the shift close ≥ 0.15; **nothing at the entry minute** | §2 |
| G4 First retest | Never the second test of a zone | `retestNo <= 1` (`firstRetestOnly`) | §13.7 |
| G5 Location | A logical stop, not mid-range, room to move | `NO_STOP`, `MID_RANGE` (middle 50% of the 1H range), `TRANSITION` only at external levels, **and** no major pool < 1R against (`roomBlock: true`) | §8.3, §8.6, §8.7, §14.8 |
| G6 No climax against us | Don't add with the trend into a climax | the `CLIMAX` gate as built (cleared by a shift or acceptance) | §12.5 |
| G7 Open wait | Don't trade the first 30 min of a session or a 4H | `OPEN_WAIT` as built | §1, §10.6 |

### Points: 0 to 4, one each

| Point | Plain words | Mechanical | Why (Mac's words) |
|---|---|---|---|
| **TRAP** | Someone is trapped at this zone, and their stops are our fuel | `kind === 'failed-break'` at this zone (the sweep extreme is known). Accepted breaks score 0 here, even when the 4H control kind is trap. | §10 "Their exit is your entry"; §3 "got trapped between the open and the high"; §17 A+ is "a trap" |
| **POOL** | A big, obvious pool was swept or broken | The zone contains a §17 obvious pool (4H Open, PDH/PDL, Asia/London H/L, session or 4H opening-range H/L, EQH/EQL with ≥ 2 touches), **or** the sweep range (zone → extreme) holds ≥ 2 distinct board levels. Not the 1H Open, round numbers or single swings on their own. Journal the stack count for later weighting. | §14.1 "Obvious beats clever"; §14.5 "Pool size grows with touches"; §17 "(4H open, PDH/PDL, session high/low)" |
| **FORCE** | Price broke away hard, measured in price | Failed break: the leg from the sweep extreme to the shift close ≥ 2 × ATR14(5m), **or** the shift bar's range ≥ 2× the 20-bar average range. Accepted break: the breaking bar's range ≥ 2× average and its volume ≥ 1.5× the median. **No bias magnitude.** | §8.8 "breaks away with force and traps people"; §15 displacement; §13.2 volume spike |
| **TIMING** | The sweep or break came at a session open, when the stops get collected | The sweep extreme (failed) or first close outside (accepted) printed within 60 min of the Asia (15:00), London (00:00) or NY (06:30 PT) open. The entry still waits out G7. | §10.6; §14.7 "London usually sweeps one side of the Asia range ... New York does the same to London"; §15.2 "sweeps cluster at session opens" |

### Bands (dollars as config, Mac's §17 values)
- **A+ ($900): TRAP plus at least 2 of POOL / FORCE / TIMING (score ≥ 3 with TRAP).** That is §17's A+: a trap at an obvious pool with real
  displacement. Session timing can stand in for one of them.
- **B ($600):** score 2, or score 3 without TRAP. The best accepted-break continuation is a B. That is faithful: §17's A+ is a trap by definition.
- **C ($300):** score 1.
- **0:** no trade. The setup passed the gates at an unremarkable level, off-session, with no force (§14.1 "a level you must zoom in three
  times to justify is not a pool").

### Live re-grade (§22 grade-upgrade add)
TRAP, POOL and TIMING are fixed at the trigger. Only FORCE can still arrive later: a B trade can turn A+ before TP1 if the leg extends past
2 × ATR or a ≥ 2× range candle prints our way. This replaces the old "bias STRONG + GROWING" upgrade, which the data does not support.

### What changes in code (small: structure.js already holds every input)
- `grade.required`: `['control4h', 'controlTaken']`. `firstRetest` and displacement leave `points`: the trigger and `firstRetestOnly` already enforce them.
- `points: { trap, pool, force, timing }`. The bands need a "requires trap" flag for A+ (`bands: [['A+', 3, { needs: 'trap' }], ['B', 2], ['C', 1]]`).
- `pool`: allow `obvious` and `strong` weights, minus the 1H Open, plus the stack count from `st.zones` between the zone and `ext`.
- `force`: from `s.ext`, `s.shift.bar.c` and `atr(m5)`, plus `s.shift.xAvg` (already journaled).
- `timing`: `ptMin(s.extT)` against `cfg.sessionOpens` within 60 min.
- `roomBlock: true`. `acceptedUsesControlTrap` stops feeding the grade.

---

## 3. Scored examples

### 3.1 Mac's witness: TradeDay 11/04 short (the bars, not constructed)
- Gates:
  - G1: SELL, trap kind (a failed break of the 4H Open 28,414).
  - G2:
    - The 15:35 5m bar put the push to 28,511 back inside the zone, closing 28,378.75: failure.
    - The same bar is the shift through the 28,448 launch low: range 144.8 = 3.75× average, body 0.59.
    - Under my G2 it passes as displacement; under the current 60% rule it waits for the 15m close.
  - G3: −0.27 (30m, 15:58) ≥ 0.15.
  - G4: the bounce to 28,394 is the first retest.
  - G5: stop at 28,513 is logical. 1H state: verify on the fixture, but price is at the session's external levels, not mid-range.
  - G6: no climax (the 15:35 bar closed near its low).
  - G7: the 16:08 entry is after the 15:30 open wait.
- Points:
  - TRAP 1: longs trapped above the open. Their bias was +0.40 at 15:28, and the bot's own PDH longs at 15:25 and 15:30 stopped at 15:39.
  - POOL 1: 4H Open, London High, PDH and Asia High, four stacked pools inside 28,414–28,511.
  - FORCE 1: the leg 28,511 → 28,334.5 = 176.5 pts, about 4.6× the 38.6-pt average 5m range; the 15:35 bar alone was 3.75×.
  - TIMING 1: launched at the 15:00 Asia/4H open, extreme at 15:35.
- **Score 4 with TRAP → A+.** At $900 with stop 28,513 and entry ~28,367 (146 pts): **3 MNQ**.
- Current proposal: B (impulse 0.26 < 0.30), so 2 MNQ.

### 3.2 Constructed obvious A+: the London Judas swing (§14.7, §15)
- Setup:
  - 4H (23:00) control SELL.
  - Asia high 28,600 tested 3 times (EQH ×3); PDH 28,610.
  - At 00:12 PT a wick to 28,628 closes back at 28,596 within 2 bars.
  - At 00:20 a 5m bar closes through the 28,580 higher low: range 2.6× average, body 0.75.
  - At 00:40 the first bounce reaches 28,588 and a 1m rejection prints at 28,583.
- Gates all pass. The entry comes after the 00:30 open wait.
- Points: TRAP 1, POOL 1 (EQH ×3 + PDH stacked), FORCE 1, TIMING 1 (London open).
- **4 → A+.** Current proposal: A+ only if the bias happened to reach 0.30.

### 3.3 Constructed B: an NY continuation
- Setup:
  - 09:40 PT, 4H control SELL ("below" kind).
  - Accepted break of London Low: 2 closes below, breakout volume 1.7× median, breaking bar range 2.2× average.
  - The pullback runs on falling volume, then a first-retest wick and a 1m rejection.
- Points: TRAP 0 (continuation), POOL 1 (London Low), FORCE 1, TIMING 0 (3 h after the NY open).
- **2 → B ($600, scale in per §22).**
- Current proposal: strong pool (via the control trap if the 4H is trap kind) + displacement + first retest + impulse, so it can reach **A+**.
  It ranks a continuation above Mac's own trap.

### 3.4 Constructed no-trade: a trap in the middle of the range
- Setup:
  - 12:20 PT. The 1H is in RANGE 28,200–28,400.
  - A failed break of the 1H Open at 28,305, then a shift with body 0.55 and range 1.1× average.
  - Bias −0.33.
- **G5 MID_RANGE fails → no trade** (§8.6 "the middle is a no-trade zone"; §14.8 "Do nothing in the middle").
- Without the gate it would score TRAP 1 only, so C.
- Current proposal: if the filter were off, trap + displacement + first retest (free) + impulse 0.33 = A+. Gates are what protect it.

---

## 4. Where Mac's rulings conflict (blunt)

1. **§22 "A+: all at once at the trigger; the best moves often never retest" vs §3 / §13.6.** Mac's own words on the witness: "I don't chase red
   candles. I wait for 30M acceptance, 5M retest, and DEFENSE." §13.6: "Missing a runner is better than entering before the reset (FOMO rule)."
   The reference A+ was entered **on the retest** (~28,367). At the trigger the engine enters at the 15m shift close (28,334.5): 32 pts worse,
   with a wider stop, chasing the red candle.
   **Recommendation:** A+ enters in full at the FVG limit or the first retest rejection, whichever comes first. The trigger entry is only for a
   leg that never retests within N bars, and then at C size. Mac must choose.
2. **§17 makes displacement and the first retest optional ("B: one of those missing") vs §15 ("Displacement is required for the shift") and
   §13.7 ("trade only the FIRST retest").** Both cannot hold. The study material treats them as rules, so they are gates here.
3. **§19 strong/growing bias points vs GRADE r2 and §1.** §19 gave bias two points. r2 dropped them at the entry minute but brought bias size
   back as "strong impulse". §1 says lower timeframes "provide execution", not decisions. Sizing on 15m/30m bias magnitude is a controlling
   decision taken by a non-controlling timeframe.
4. **Time blocks vs the timing point.** Spec E keeps "time blocks". §16 notes the live bot blocks 06:30–07:10 PT, and the board has carried a
   15:00–17:00 PT block. The witness entry (16:08) and the NY-open sweeps are exactly the §10.6 / §14.7 setups. If any of those blocks applies
   to the tide path, the witness cannot be traded at any grade. **Verify before anything else.**
5. **Full stops vs A+ size.** Trap stops sit beyond the sweep extreme, the widest stops in the model. A+ all-at-once puts the biggest dollars on
   them. A witness full stop would be −$900 (3 × 146 × $2). That is consistent with §17 (never tighten, size down), but with full stops the main
   loss driver (41 of 131 NY trades), A+ must earn its dollars in replay first (see the inverted 10/14–10/20 grades).
6. **Small:** the proposal text counts session/OR highs and lows as strong pools, but the engine does not (`strongPoolWeights: ['strong']`).
   One of them must change. Mac's §17 says session high/low counts.
