# 4H Live Model v1.6

A Pine Script v5 overlay (`4H-Live-Model.pine`) that draws the current 4H candle beside live price. It works on any chart timeframe at or below 4H.

Install: in TradingView open Pine Editor, choose New, paste the file, then Save and Add to chart.

## What it draws
- **Side candles:** P4H (the previous completed 4H candle, muted) at +6 bars and C4H LIVE at +16 bars. Both are 4 bars wide and sit at true prices.
- **Formation path: the candle of the timeframe being viewed (v1.4, Mac 11/22).** On a 30m chart it follows the forming 30m candle, not the 4H.
  - It is drawn as a purple line at +26 bars, labelled "30m CANDLE": OPEN → EXTREME → RECLAIM → EXPANSION, with a dot at the live price.
  - **v1.6 (Mac, 11/22): "each candle has 4 stages".** The line follows what the candle actually does, read point by point from its 1-minute bars:
    - OPEN → EXTREME: the first side to move 10 % of the previous chart candle's range.
    - → RECLAIM: back through the open.
    - → EXPANSION: 10 % or more beyond the open on the other side.
    - If an expansion of at least that size reverses back through the open, the expansion becomes the new EXTREME, and the cross is the new RECLAIM. The candle's direction flips to match.
    - If a reclaim falls back through the open before expanding, the stage is RECLAIM LOST.
    - TARGET: the previous chart candle's high or low. CLOSED: the bar has closed.
  - Checked on BTC 30m 11/22, 14:00 PT candle (open 60,829.22): it reads BEARISH, with the extreme near the high of 60,882, a reclaim down through the open, and EXPANSION down to 60,682. That matches Mac's reading.
  - The 4H dashboard rows still use the original rule: whichever side moves first names the model, and it does not flip.
  - The order of moves inside the candle comes from its 1-minute bars (`request.security_lower_tf`), or 5-minute bars above 1H. On a 1m chart it comes from live ticks.
  - The side candles, level lines and the first 10 dashboard rows stay on the 4H. Two dashboard rows, "<tf> CANDLE" and "<tf> STAGE", show the chart candle.
- **Level lines:** P4H HIGH, P4H LOW, P4H OPEN (dashed) and C4H OPEN (solid, thick). They run from the start of the P4H candle to the end of the path, with coloured price labels at the left.
- **Dashboard:** MODEL, STAGE n/6, LOCATION, C4H OPEN, C4H EXTREME, P4H HIGH, P4H LOW, RANGE / P4H O, NEXT TARGET and 4H CLOSE IN.

## Rules as built
- **P4H** comes from `request.security(…"240", [open[1], high[1], low[1], close[1]], lookahead_on)`. It holds confirmed values only and never repaints.
- **C4H (v1.2)** comes from the chart's own bars inside the current 4H candle: the first bar's open, the running high and low, and the live close. `request.security(…lookahead_off)` is kept only as a fallback.
  - Reason: on a last bar that is calculated as history, `request.security(…lookahead_off)` returns the PREVIOUS candle's values. That happens on chart load before the first tick and in bar replay.
  - Seen on CRYPTO:BTCUSD 30m on 11/22: `request.security` gave the open as 60770.76, which is the P4H open. The true C4H open is 60614.15.
- **MODEL** names itself by whichever side first moves away from the C4H open by at least `extPct` % of the P4H range (default 10 %, minimum 2 ticks).
  - Low side first means BULLISH; high side first means BEARISH.
  - If both sides pass the threshold inside one chart bar, the bar's colour decides: a green bar means the low came first.
  - Once named, the model never flips inside the candle.
- **Reclaim:** after the current extreme, price trades back through the C4H open (FORMING). It becomes CLOSED once a chart candle closes back through the open.
  - If the extreme extends to a new low (bullish) or new high (bearish), the reclaim resets.
- **EXPANSION:** a reclaim has happened and live price is beyond the open in the model's direction.
- **RECLAIM LOST (v1.5, Mac 11/22):** a reclaim happened, but price is back on the extreme's side of the open.
  - It shows in red on the dashboard (for both the 4H and the chart candle).
  - On the path it is a red dashed leg from the reclaim point to the live price.
  - If price crosses back through the open in the model's direction, the stage goes to EXPANSION.
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
