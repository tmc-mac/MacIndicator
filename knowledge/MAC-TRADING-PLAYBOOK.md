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
