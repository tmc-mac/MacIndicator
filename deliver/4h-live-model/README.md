# 4H Live Model v1.1

A Pine Script v5 overlay (`4H-Live-Model.pine`) that draws the current 4H candle beside live price. It works on any chart timeframe at or below 4H.

Install: in TradingView open Pine Editor, choose New, paste the file, then Save and Add to chart.

## What it draws
- **Side candles:** P4H (the previous completed 4H candle, muted) at +6 bars and C4H LIVE at +16 bars. Both are 4 bars wide and sit at true prices.
- **Formation path (v1.1, drawn to Mac's sketch 11/22):** starts at +26 bars and is 8 bars wide.
  - The 4H open is a flat line across the full width.
  - A V runs from its left end to the EXTREME in the middle, then back up to the RECLAIM at its right end. The reclaim leg is drawn only once the reclaim has happened.
  - EXPANSION is a vertical leg from the middle of the open line to the live price, labelled LIVE, TARGET or CLOSE. A dotted extension marks the candle's HIGH (bullish) or LOW (bearish) beyond it.
- **Level lines:** P4H HIGH, P4H LOW, P4H OPEN (dashed) and C4H OPEN (solid, thick). They run from the start of the P4H candle to the P4H side candle, with text labels at the left.
- **Dashboard:** MODEL, STAGE n/6, LOCATION, C4H OPEN, C4H EXTREME, P4H HIGH, P4H LOW, RANGE / P4H O, NEXT TARGET and 4H CLOSE IN.

## Rules as built
- **P4H** comes from `request.security(…"240", [open[1], high[1], low[1], close[1]], lookahead_on)`. It holds confirmed values only and never repaints.
- **C4H** comes from `request.security(…"240", [open, high, low, close], lookahead_off)` and is read on the last bar, so it updates live.
- **MODEL** names itself by whichever side first moves away from the C4H open by at least `extPct` % of the P4H range (default 10 %, minimum 2 ticks).
  - Low side first means BULLISH; high side first means BEARISH.
  - If both sides pass the threshold inside one chart bar, the bar's colour decides: a green bar means the low came first.
  - Once named, the model never flips inside the candle.
- **Reclaim:** after the current extreme, price trades back through the C4H open (FORMING). It becomes CLOSED once a chart candle closes back through the open.
  - If the extreme extends to a new low (bullish) or new high (bearish), the reclaim resets.
- **EXPANSION:** a reclaim has happened and live price is beyond the open in the model's direction.
- **TARGET:** the live high reaches the P4H HIGH (bullish), or the live low reaches the P4H LOW (bearish). This holds until the candle closes.
- **CLOSED:** the 4H close time from `time_close("240")` has passed and no new candle has started, for example after the session close or at the weekend. The countdown then shows "—".
- **Drawing objects:** everything is deleted and redrawn on the last bar only. That is about 2 boxes, 12 lines and 12 labels.

## Verified (TradingView server, CME_MINI:MNQ1! 30m, 2026-11-21)
- Compiles with no errors or warnings.
- On the last bar, the C4H open/high/low from `request.security` (25621.5 / 25653.5 / 24976) equal the values tracked bar by bar.
- The P4H values (26434 / 26504.75 / 25493 / 25621.5) equal the previous candle as tracked.
- `time_close("240")` returned the shortened 14:00–17:00 ET last candle correctly.

## Not yet checked
- **Live behaviour on a chart:** the tick-by-tick update, the CLOSED → new P4H handover, and the visual layout against the reference screenshots.
- **Other symbols:** MGC, YM and BTC.

## Limits
- **Countdown:** it updates only when a tick arrives, because Pine has no timer. In quiet markets it can lag by a few seconds.
- **Phase timing:** it is only as fine as the chart timeframe. On 1H, the extreme and the reclaim can fall in the same bar; on 1m–5m they separate properly.
- **Chart history:** the phase tracker needs the chart's history to reach back to the start of the current 4H candle. Every normal chart does.
