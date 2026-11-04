# Mac's Trading Playbook: how the bot must read and trade the market

Owner: Mac. Kept by MacArthur. Every desk reads this before working on entries, stops, sizing or exits.
Mac's words are quoted; the rules under them are the team's mechanical reading and must not drift from the quotes.
Started TradeDay 11/04. Add to it every time Mac teaches something; never delete a ruling, mark it superseded.

---

## 1. Timeframes are like the ocean

> "The 4H is the tide. The 15M, 5M, and 3M are merely waves. Waves move back and forth, but the tide determines the larger direction.
> Many traders lose because they allow non-controlling timeframes to make controlling decisions.
> The 4H provides direction. The lower timeframes provide execution."

> "4H — Identify structural control. 30M — Wait for the opposing move to fail and price to realign with that control.
> 5M — Execute after a defended retest. I don't predict. I react."

Rules:
- Direction comes **only** from the 4H. Nothing below the 4H can set direction or veto a trade the 4H supports
  (no 15m HTF-alignment vote and no 15m control-gate veto on this path).
- Lower timeframes only time the entry.
- "Within the first hour, control has already shifted." Do not trust the opening read of a 4H candle;
  let control show itself before acting.

## 2. Control is read intrabar with our bias score

> "30 min doesn't have to close it, it just has to take control on the 30 minute or 15 minute ... Intrabar."
> "Intrabar control with our bias score." "Lower [the threshold] for all versions of the bot" (±0.15, was ±0.22).

Rules:
- Acceptance at a level means price is past the level **and** the forming 15m **or** forming 30m candle shows control
  on the 4H's side, using our bias score (the Levels PRO / bot control score) at |score| ≥ 0.15.
- Read it live (intrabar), not at the candle close.

## 3. The trap: Mac's witness chart (TradeDay 11/04, MNQ)

> "Buyers pushed above the 4H open, failed to defend it, and got trapped between the open and the high.
> Now sellers have the advantage. But I don't chase red candles. I wait for 30M acceptance, 5M retest, and DEFENSE.
> The 4H gives information. The retest gives opportunity."

The chart, from the bot's data:
- 4H open 28,414 (Mac's chart showed 28,412.50).
- The push topped at 28,511 (15:35 PT).
- The 15:30 15m candle closed 28,334.5, back under the open. It also broke 28,448, the 15:15 low that launched the push.
- The bounce stalled at 28,394 (16:05) under the open, and the 1m turned down at about 16:08 (~28,367).
- Price then fell to 27,732 within 2 hours and 27,611 by 19:07.

This is the reference trade. Every entry model must take it.

## 4. Levels where we trade (only in the 4H direction)

> "Yes exactly we need trades at the levels you mentioned!"

- Levels: 4H Open, PDH, PDL, Asia High/Low, London High/Low, 1H Open (the hour opens).
- Values come from the bot's own level board, the same as Levels PRO.
- These are the obvious levels, which is why they work: obvious levels collect orders (see §8).

## 5. Stops: at real structure, never timed, never tightened to fit

> "Stop losses also need to be at the structural wick." "4hr structural wick or 1 hr structural wick depending on the context of the trade." → Mac chose option **C**.
> "No timed stop losses either, unless we consider price action chopping."
> "Drawdown is expected in any trade to me. Some of my best trades have been in drawdown before great returns because the market moves in waves not straight lines."

Rules:
- **Option C:**
  - 4H-type levels (4H Open, PDH, PDL, a trap): stop beyond the 4H wick, which for a trap is the failed-breakout extreme.
  - Hour-type levels (1H Open, Asia/London highs and lows): stop beyond the current 1H candle's wick, up to entry, including the retest.
  - Add a 2-point buffer (the level-event STOP_BUF).
- No stop cap from the fill and no session floor on structural stops.
- No no-progress or timed exits. A chop-based exit is a future item, to be built only once Mac defines chop.
- A stop is never moved closer to make a trade fit. Size changes instead.

## 6. Size and money

> "We shouldn't be skipping trades because we can't size accordingly. Size down and catch the moves."
> "Wins should be $200 minimum, losses $150 max." Then: "$150 loss on 5 MNQ is just too tight."
> "10 MNQ is [1 mini] and it only takes 100 points to blow the account, so trades have to be good and risk management has to be on point.
> 5 contracts gives more breathing room and bigger wins on the partials."

Rules:
- Max **5 MNQ**.
- Contracts = min(5, floor(maxLoss / (stop pts × $2))). Always size down; never skip just because 3 lots don't fit.
- Max loss per trade: Mac first set **$150**, then found it **too tight** for structural stops.
  - The number is open. It is a config value (moneyRule.maxLossUsd); MacArthur proposed $300 plus a day limit of 2 full stops.
  - Do not hard-code it. Mac sets it at install.
- **Minimum win: $200.** All but one contract exit at the point where the position has made $200 (W = 200 / (2 × contracts)).
  - The runner's stop then moves to W, so a trade that has touched W never finishes under $200.
  - The runner goes on to the next level.
- 50K combine, $2,000 trailing drawdown. That is why risk management has to be on point.

## 7. Chasing

> "We need to eliminate the no chase rule or extend the ATR because we miss too many trades where momentum is in our favor."

Rules:
- On the new path, no fixed chase limit. The distance from entry to the structural stop is limited by the money rule (it must fit at ≥ 1 MNQ).
- On the current bot: set-nochase.sh off | 2.0–6.0 ATR (built and rig-booted, held for Mac).

## 8. Market structure is the record of control (Mac's study material, 11/04)

The core idea: a label (HH/HL/LH/LL) only says what price printed. Control shows up in the **reaction** when price comes back to the level:
does it defend, reject, break, or fail around it?

1. **Break, then acceptance or failure.**
   - Acceptance: price holds outside the level for several candles, and the retest wicks into the level without closing back inside.
     The level has flipped, so trade **with** the break on the defended retest.
   - Failure: price closes back inside quickly. That break was only a liquidity event, and the breakout traders are trapped.
2. **Failure warns; the structure shift gives the trade.**
   - After a failed break or a sweep and reclaim, do nothing until a full-body candle breaks the **last internal swing the trapped side defended**:
     for shorts, the higher low that launched the breakout; for longs, the last lower high.
   - A reclaim without that shift chops and stops you out.
3. **External vs internal structure.**
   - External swings (1H/4H turns, PDH/PDL, session highs and lows, range edges) are the map.
   - Internal swings (5m, or 1m inside it) are the trigger.
   - Never build a trade from an internal break that runs straight into an external level against you.
4. **Entry is on the retest of the broken internal level**, rejected from the other side. This gives a clean risk point.
   - Stop: beyond the sweep or failed-breakout extreme (the external invalidation).
   - Target: the next obvious liquidity pool (next level).
5. **Liquidity.** Obvious highs and lows collect stops and breakout orders. Attacks happen there.
   The best trade is often in the direction of the traders who just got trapped.
6. **Market state.**
   - Trend (expanding, protected lows hold): trade pullbacks as continuation.
   - Range (rotating): trade only the edges; the middle is a no-trade zone.
   - Transition (overlap, failed breaks both ways): stand aside until a new edge gets attacked cleanly.
7. **Location.** If the stop has no logical place, there is no trade. Structure should delete bad trades, not only find good ones.
8. **Strong structure leaves evidence.** It breaks away with force and traps people. A level that caused a sharp reaction outranks a neat line.

The video's routine:
1. Mark the external map.
2. See where price sits in it.
3. Ask one question at the level: *did price break and hold, or break and fail?*
   - Held: trade the retest with the break.
   - Failed: wait for the internal shift, then trade the retest against the break.

## 9. How the team works on this

> "I don't care about the replay, I care about the strategy." "You don't have to test it. We are looking to learn as much as we can
> to build a new version of the bot that will outperform the one we have."

- Build to Mac's rules. Strategy fidelity is the bar: the bot must take the trades Mac describes, starting with §3.
- Safety checks still run on every package:
  - mode off = identical to the live bot;
  - orders always carry their protective stop;
  - reviewer desk;
  - rig boot.
  These are plumbing checks, not strategy gates.

---

## 10. Trapped traders: "Who's trapped, and where are their stops?" (Mac's study material, 11/04, part 2)

The core idea: your job isn't to predict, it's to see where traders are trapped. Their exit is your entry: stops on a trapped side are fuel.
Every trap has the same structure: traders enter, price reverses, stops cluster, price hunts those stops.

The six trap patterns, with the trade:
1. **Wick trap (pin bar).** Long wick = people bought (or sold) up there and are now underwater, with stops just beyond the candle's body end.
   Don't trade the pin bar itself. Trade when price **rejects away from the wick zone**; trapped-side liquidation accelerates the move.
2. **Failed engulfing.** An engulfing "reversal" that is itself engulfed within 1–2 candles traps everyone who bought the pattern.
   Trade the failure direction.
3. **False breakout.** A strong close beyond a range edge, then a stall, then a slip back inside within ~3 candles.
   Trade opposite the breakout. Tight stops (just under the breakout candle) go first; the bigger cascade comes when price pushes toward the
   far side of the range and triggers the wide stops, so the target is the opposite range edge.
4. **Trendline break without momentum.** A break that doesn't accelerate usually fails. When price gets back above (below) the line,
   trade WITH the original trend, fuelled by the trapped breakers' stops.
5. **Failed pattern (double top/bottom, triangle).**
   - A double top broken upward → trapped shorts' stops sit above both peaks, so the move accelerates.
     Don't fight it: buy the pullback.
   - Triangle: if the first break fails and price breaks the opposite side, two sets of traders are trapped. That is the entry, and the most explosive one.
6. **Opening-range trap (session open: London, New York; for us also the 15:00 PT Asia open and each 4H open).**
   - The first 15–30 minutes set a direction and momentum traders pile in, then price reverses and trends the other way.
   - Don't trade the first 15–30 minutes. Mark the opening-range high and low.
   - If price breaks one side and fails, look for the opposite direction.
   - This is exactly Mac's 11/04 chart: the 15:00 opening push above the 4H open failed and trended down all session.

**Bot implications:**
- The opening range is a level: add the first-30-min high/low of each session and 4H as trap levels.
- A failed break / failed pattern / failed engulfing = the "failure" leg of playbook §8.2. It still needs the internal shift before entry.
- Targets: the far side of the range or the next liquidity pool (where the wider stops sit).
- Entry is never on the trap candle itself. It comes on the rejection away from it.

## 11. Size and the "override threshold" (Mac's study material, part 3)

The core idea: oversize turns a valid plan into survival mode. Four symptoms, each a binary rule:
1. Hesitating or entering late.
2. Moving the stop wider.
3. Closing before the target ("lock it in").
4. Revenge trading after a loss.

For a human the fix is a "boring" size, small enough that the click is automatic.

**Bot implications (the bot has no fear, but it must never copy those four behaviours):**
- Enter on the trigger. No extra "wait one more candle" filters added out of caution (Mac: late entries cost us, see §3).
- **Never widen a stop.** A stop only moves in the trade's favour (to W after the partial, then the trail).
- **No early exit before the plan's target** except the defined partial at W. No timed exits (§5).
- **After a loss, a cooling-off period before the next entry** (the video uses 30 minutes; the bot has re-entry cooldowns).
  Mac to confirm the minutes for the new model. NO daily loss limit (§17).
- Size must stay where Mac himself can watch every trade calmly. That is why the max-loss-per-trade number is Mac's to set (§6).

## 12. Big-money footprints: gaps, contraction, pin-bar illusions, climaxes (Mac's study material, part 4)

1. **Engulfing gaps.**
   - Bullish: open below the prior close, close above the prior open. Bearish: the mirror.
   - With the trend = strength (breakaway/runaway). Against a long trend = possible exhaustion.
   - High volume makes the gap matter. The stop goes beyond the gap's extreme.
   - The gap area later acts as support/resistance.
   - For MNQ: the 15:00 PT reopen after the 14:00–15:00 break, and Sunday's open, are our "gaps".
2. **Momentum recharge (contraction after a big move).**
   - After a strong momentum day or leg, price pauses in a range. Box it with the isolated pivot highs and lows.
   - Inside the box, expect **liquidity sweeps against the prior move** that trap reversal traders. A sweep below the box that reclaims = big
     players buying (mirror for down).
   - **Trade only in the direction of the prior move**, on a clear break out of the box (volume rising) or on the sweep-and-reclaim.
   - Sessions: Asia often contracts, London/NY opens often break out.
3. **Pattern pitfall.** Triangles and wedges get "liquidity clear-outs" (fake breaks back into the pattern).
   - Don't trade the first break blindly.
   - Prefer breaks WITH the larger trend, with volume, at session opens.
4. **Exhaustion-wick illusion.** A pin bar right after a big momentum move is often profit-taking or a breather, not a reversal.
   - It only counts at a real level (support/resistance, fresh supply/demand), with follow-through, ideally with volume, and at session opens.
5. **Buying / selling climax.**
   - Late in a trend, a final fast push on very high volume, with narrowing bars (effort without result) and closes back toward the middle
     (or the opposite end) of the bar. The market is running out of buyers (sellers).
   - Don't fade the climax candle. Wait for confirmation: a lower high (higher low), a trendline or level break, or a lower-timeframe change of character.
   - A higher-timeframe climax means a bigger reversal.

**Bot implications:**
- Volume is available on our bars and should join the reading: breakout volume, climax volume vs bar range, gap volume.
- "Momentum recharge" refines §8.6 market state: after an expansion, a contraction box is a RANGE whose breakout is traded only with the prior
  move, and sweeps against the prior move inside it are trap entries in the prior direction.
- Pin bars / wicks need location plus follow-through, never alone (matches §10.1).
- Climax detection (high volume, narrow spread, poor close) is a WARNING that blocks new with-trend entries until the structure confirms either way.

## 13. Breakout retests the way big money trades them (Mac's study material, part 5)

Why retests happen:
- Early big players take profit after the break, and the retrace gives late traders a second chance.
- Nervous breakout traders bail as their profit shrinks. Big money fills from those exits and from stopped-out traders.
- The retest "resets" the market (weak hands out), then the move continues with less resistance.
Rules:
1. **Zones, not lines.**
   - Mark the breakout area as a ZONE covering the cluster of highs (lows) that broke, not a single price.
   - Any return into the zone counts as the retest.
2. **A legit break** needs:
   - a CLOSE clearly through the zone (not just a wick);
   - a volume spike on the breaking candle. Low-volume breaks are suspect.
3. **Volume rhythm:** break on rising volume → pullback on FALLING volume → volume picks up again at the retest as the defenders step in.
   High volume on the pullback = the other side still in control = possible trap.
4. **Confirmation at the zone, not a bare touch:**
   - an engulfing candle or a pin-bar rejection at the zone, ideally on a lower timeframe (Mac: 4H map, 30m/5m trigger);
   - above-average volume on the rejection.
5. **Stop:** beyond the confirming candle, or a few points beyond the WHOLE zone (safer). Lower-timeframe entry with a zone-based stop.
6. **Wait for the retest.** Missing a runner is better than entering before the reset (FOMO rule).
7. **The FIRST retest is the strongest.** A second test of the same zone is weaker (the original breakout traders are gone, big money already
   filled), and a zone that fails twice loses its value.

**Bot implications:**
- Levels become zones: [min, max] of the clustered highs/lows within a tolerance, or level ± k ticks.
- Accepted-break continuation (§8.1, TIDE C.1) requires: a close-through + breakout volume > its 20-bar median;
  pullback volume < breakout volume; a rejection candle (engulfing or pin) at the zone on 5m/1m.
- Count retests per zone: trade only the FIRST retest after a break. The second is journaled and skipped.

## 14. The liquidity map: where the money sits and when it gets collected (Mac's study material, part 6)

1. **Price moves from one pool of money to the next.**
   - Above every obvious high: buy-side liquidity (breakout buys plus short stops).
   - Below every obvious low: sell-side liquidity (breakout sells plus long stops).
   - Obvious beats clever: a level you must zoom in three times to justify is not a pool.
2. **The close matters more than the wick.**
   - A sweep is not the break itself. It is the FAILURE after the break (wick through, close back inside, the next candle can't reclaim).
   - A break that keeps closing outside is a real breakdown/breakout: continuation, not a fade.
   - Don't fade a break until price proves failure.
3. **Liquidity explains why price went there; structure tells you if the move survives.**
   - Reversal = sweep + break of the last DEFENDED swing (the swing that protected the old trend: the last lower high in a downtrend,
     the last higher low in an uptrend).
   - Sweep + bounce without that break is NOT a reversal.
4. **Liquidity inside a trend.**
   - A sweep of a pullback low (high) that reclaims, while the major swing holds, is a CONTINUATION entry in the trend direction:
     enter after the reclaim plus the break of the pullback's small lower high (higher low).
   - Not every sweep is a reversal.
5. **Pool size grows with touches.**
   - Equal highs/lows and levels tapped 2–3+ times are loaded pools (a "dam"). The break floods.
   - Textbook trendlines and chart patterns are pools too (everyone's stop sits just beyond them).
   - Round numbers are pools.
   - **Previous day high/low:** fresh stops every day, the "daily collection run".
6. **Hidden pools.**
   - **Order block:** the last opposite candle before a major move (the last down candle before a big rally, the last up candle before a big drop).
     Institutions return to fill the rest of the order there.
   - **Liquidity void:** the area price ran through fast out of a long range has few orders. Price travels through it quickly to the next pool.
   - **All-time high:** the largest pool. Be suspicious of euphoric ATH breakouts.
7. **Time.**
   - Asia builds the range (stops stack both sides).
   - **London usually sweeps one side of the Asia range first**, then makes the real move.
   - **New York does the same to London.** Hold through the NY open only with that in mind: NY has its own pools to collect first.
   - The setup: equal highs at the Asia range high; London spikes above within ~15 min; wicks above, bodies close back inside.
     Enter on the reversal candle, stop above the wick, target the opposite side of the Asia range.
8. **Do nothing in the middle.** Between the last swing high and low there is no trade until price reaches an exposed pool and shows acceptance or rejection.

**Bot implications:**
- Add pools to the level board (weights by obviousness):
  - equal highs/lows (≥ 2 touches within a few ticks) with a touch count;
  - round numbers (MNQ: every 100 and 50 points);
  - order blocks (the last opposite 15m/1H candle before a ≥ 1.5×ATR move);
  - liquidity-void edges;
  - the session ranges (Asia 15:00–00:00 PT, London 00:00–05:30 PT) and the opening ranges (§10.6).
- Session sweep model: London open sweeping one side of the Asia range, and the NY open sweeping London, are high-priority trap setups
  (failed break → shift → entry; target the opposite side of the range).
- Targets: the next pool in the trade direction (bigger pool = more likely destination); voids are travelled quickly.
- Sweeps inside a trend whose major swing holds are continuation entries, not reversals (pairs with §8 and §12.2).

## 15. Daily extremes (PDH/PDL): sweep vs breakout, and the FVG entry (Mac's study material, part 7)

Why: big players need counterparty volume. Above the previous day high sit short stops (buy stops) plus breakout buy orders. A push through
triggers both in one sweep, and the big sellers fill their shorts into that buying. Mirror for the previous day low.
Rules:
1. **Tell the two apart by the candle:**
   - **True breakout = displacement:** large full-bodied candles that CLOSE decisively beyond the extreme.
   - **Sweep:** a long wick pierces the extreme and the BODY closes back inside the prior range.
2. **Timing:** sweeps cluster at session opens.
   - London open: the "Judas swing", a false first move that clears stops.
   - The New York handover often sweeps the new London extremes.
3. **The entry sequence (inverted retail habit):**
   1. Let price break the level and the trap spring. Wait for the candle CLOSE back inside (1H chart).
   2. Drop to 5m/15m. Wait for a **market structure shift with displacement**: a full-bodied candle closing through the recent swing low (short).
   3. Enter with a **limit order in the fair value gap (FVG)** that displacement left, catching the retracement before the continuation.
4. **Stop:** a few points BEYOND the absolute peak of the sweep wick, never exactly at the daily extreme (algorithms often spike once more).

Definitions for the bot:
- **Fair value gap (bearish):** a 3-candle pattern on the trigger timeframe where candle 1's LOW is above candle 3's HIGH.
  The gap [candle 3 high, candle 1 low] is the FVG. Bullish is the mirror.
- **Displacement:** a candle whose body is ≥ 60–70% of its range and ≥ 1× the recent average range, closing through the swing.

**Bot implications:**
- This is the concrete answer to Mac's "better way to enter on the waves": after the sweep and shift, place a LIMIT in the FVG instead of a
  market order on the close. Better price, a structural stop beyond the sweep wick, and no chasing.
  - Cancel the limit if it isn't filled within N trigger bars, or if price trades beyond the invalidation first.
- PDH/PDL sweep at the London open (00:00 PT) and the NY open (06:30 PT) are priority trap setups. The opening-range rule (§10.6) applies.
- Stop = sweep extreme + buffer (MNQ: STOP_BUF 2 pts or more). Size from it with the money rule (§6).
- Displacement is required for the shift (§8.2's "full-body" rule, sharpened here).

## 16. How Candace sizes and manages (ICT scalper; Mac: "I'm interested in mimicking her sizing") (Mac's study material, part 8)

Her process:
1. Higher timeframe: daily FVGs/volume imbalances, **1H FVGs** (her main HTF tool; she says the 4H "isn't that important" for her model),
   weekly/daily highs and lows.
2. Premium/discount.
3. A liquidity pool must exist (equal highs/lows, a low-resistance liquidity run). No pool, no setup.
4. A liquidity sweep inside a **kill zone**: London 2–5 am ET (23:00–02:00 PT; she never trades before 2 am ET; key times 2:30, 3:00, 3:30 ET),
   New York around the 9:30 ET open (06:30 PT). A sweep before the kill zone does not count.
5. Displacement + speed (watched on the 15s/30s chart), then the entry on a **valid inverted FVG (IFVG)**: a bearish FVG that a bullish candle
   BODY closes clearly through (or the mirror), or on the FVG the displacement left. The aggressive entry inside the FVG is for experts only.
6. Extra confluence: SMT divergence with ES, the NY-session RTH gap (the 16:00 ET close to the 09:30 open gap; 25/50/75% levels),
   the midnight opening price (00:00 ET), the new-day/new-week opening gaps.

Sizing and risk (the part Mac asked about):
- **Fixed maximum stop by session, not "wherever structure is"**: London 20–25 pts max (15 pts last year), NY 30–40 pts.
  "If I had to use a larger stop loss to enter, that means that is not the entry point." She does not size down to fit a wide stop.
  She waits for a tighter entry (a closer IFVG/FVG) or skips.
- **Size by setup grade**:
  - A+ = many stacked confluences, e.g. a sweep plus a 1H FVG plus a daily FVG plus the NDOG, inside the kill zone, tight stop.
    She enters full size at once (5 NQ in the example), holds longer, and targets the bigger pool.
  - Normal: she scales in (2 + 2) on the second FVG.
  - B/C setups: she still takes them, with SMALLER size and no scale-in. (Waiting only for A+ and then losing hurts more; B/C at small size made her more money.)
- On a 50K Apex account she trades 2 NQ (= 20 MNQ) in London because the stops are tight. A stop-out is about $500, so she has ~4 attempts
  before the drawdown is in danger. She calls that aggressive.
- **Daily loss limit in dollars, not a trade count** (e.g. $3,000/day on a 150K account with buffer).
- **The big payouts come from copy-trading the same trade across many accounts** (up to 20 Apex accounts): $4,000 × 20.
  The per-account risk stays modest. The scale comes from the account count.

Targets and management:
- A bracket at a **minimum 1:2 R:R**, extended to the nearest liquidity pool (1H FVG, equal highs/lows, RTH-gap 25/50/75%).
- Partial at the first internal pool. Stop to breakeven after that (risk-free trade).
- **Trail the stop each time a minor liquidity pool (even on the 15s chart) is swept.**
- She exits fast (often within 2–15 minutes, capturing 5–15% of the day's move) because holding through retracements costs mental capital.
  Swing-style holding is a personality choice, not a rule.

**Bot implications:**
- The bot has no fear, so "mental capital" exits are optional. But her rule "**if the stop must be wide, it is not the entry**" is a real
  edge: it pairs with the FVG/IFVG limit entry (§15) to give tight structural stops and bigger size at the same dollar risk.
- Grade-based risk (A+/B/C) maps onto the bot's existing grade concept. It needs objective confluence counting.
- Kill zones: London 23:00–02:00 PT and the NY open 06:30 PT are her prime windows. **The live bot currently BLOCKS 06:30–07:10 PT**,
  and the 15:00–17:00 PT Asia block is outside her windows anyway.
- Scale via accounts (copy-trading), not per-trade risk: the way to "leverage" a profitable model without risking the combine.

## 17. RULING: our trading style, Candace's SIZE style (Mac, 11/04)

> "I don't want her trading style, I want her SIZE style." "No daily loss limit! Don't forget that!"

- **Trading:** everything in §1–15 (Mac's model). None of her ICT-specific pieces (kill zones, IFVG, RTH gap, SMT) in the build.
- **Size by setup grade, in dollars per trade.** Contracts = grade dollars ÷ (our structural stop pts × $2), MNQ.
  - Grades in OUR terms:
    - **A+:** 4H control plus a trap at an obvious pool (4H open, PDH/PDL, session high/low), with a displacement shift and the first retest.
    - **B:** one of those missing.
    - **C:** two missing.
  - Starting values for a 150K account: A+ ~$900 / B ~$600 / C ~$300, as config per account size.
- **Scale in on A setups:** half on the first trigger, the rest on the retest/gap entry. B/C: one entry, no adds.
- **NO daily loss limit.** Not in the bot, not as a dollar cap, not as a trade count. (The account's own firm rules are the only outer limit.)
- **Stop:** OUR structural stop (§5, option C), sized down to fit the grade dollars. No skipping for stop width.
  - MNQ's small contract size makes this workable where NQ minis would not be. Rationale in MacArthur's 11/04 answer.
- **Grow by adding accounts** (copy-trading), not by raising per-trade risk.
- **Testing path:** the new model runs on Mac's $150K practice account sized as a real 150K first.
  Mac buys the 150K combine once it's on pace.

## 18. RULING: Candace's profit-taking style too (Mac, 11/04)

> "I don't want all but 1 contract at $200. If we're sizing up we're mimicking her PT style too."

Supersedes the "+W = $200, all but one contract out, runner locked at W" exit in §6/§17.
1. **Bracket at a minimum 1:2 R:R**, extended to the **nearest liquidity pool at or beyond 2R** (session/day highs and lows, equal highs/lows,
   4H/1H opens, round numbers, order blocks).
2. **Partial at the first internal pool** between entry and target (the nearest swing high/low or pool in the trade direction):
   about half the position (cfg; Mac to confirm). Then **stop to breakeven**: a risk-free trade.
3. **Trail the stop each time a minor pool is swept** in our direction: move it behind the last 1m/5m swing that just formed.
   Never widen.
4. **Grade changes the target:** A+ holds for the bigger (major) pool beyond 2R; B and C take the nearest pool at or beyond 2R.
5. No timed exits (unchanged). No daily loss limit (unchanged).

## 19. RULING: grading (Mac, 11/04)
- "Strong" bias = the Levels PRO STRONG line, |score| ≥ 0.45 ("Use the same as the levels indicator").
- "Growing" is measured on the fast timeframe that shows strong moves the way Candace sees them: the bias moving our way over the last few
  1m samples, plus a 1m (later 15s) displacement candle.
- Bias does NOT count double. Points:
  - Required: 4H control and bias past the line.
  - +1 each: strong-pool trap, displacement shift, first retest, strong bias, growing bias.
  - A+ = 4–5, B = 3, C = 2, below that no trade.
