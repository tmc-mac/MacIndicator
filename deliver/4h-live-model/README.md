# 4H Live Model v2.3

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
  - **v1.7:** the 4H dashboard rows (MODEL, STAGE, C4H EXTREME, NEXT TARGET) use the same 4-stage rule as the line (Mac, 11/22).
    - The extreme threshold is 10 % of the P4H range.
    - The sub-bars are the completed chart bars of the 4H candle, then the live bar's 1-minute bars (ticks on a 1m chart).
    - The model can now flip mid-candle, which replaces the original "never flips" rule.
  - **Path labels** sit to the LEFT of their points (Mac, 11/22).
  - The order of moves inside the candle comes from its 1-minute bars (`request.security_lower_tf`), or 5-minute bars above 1H. On a 1m chart it comes from live ticks.
  - The side candles, level lines and the first 10 dashboard rows stay on the 4H. Two dashboard rows, "<tf> CANDLE" and "<tf> STAGE", show the chart candle.
- **Level lines:** P4H HIGH, P4H LOW, P4H OPEN (dashed) and C4H OPEN (solid, thick). They run from the start of the P4H candle to the end of the path, with coloured price labels at the left.
- **Dashboard:** MODEL, P4H CANDLE (the previous 4H's direction: BULLISH, BEARISH or DOJI), ALIGNMENT (WITH P4H, or COUNTER P4H in amber, v1.8), STAGE n/6, LOCATION, C4H OPEN, C4H EXTREME, P4H HIGH, P4H LOW, RANGE / P4H O, NEXT TARGET and 4H CLOSE IN.

## DRIVE and ENGULFING (v2.3, Mac 11/22)
- **DRIVE ▲ / DRIVE ▼:** a candle that opens and runs straight one way, with no reclaim, past the previous candle's far side.
  - "Previous candle" means the P4H for the 4H, and the previous chart candle for the line.
  - It is shown as a drive in that direction: MODEL "BEARISH DRIVE", STAGE "2/6 DRIVE ▼", and the line point "2 DRIVE ▼".
  - Before v2.3 it showed as a bullish EXTREME FORMING, which read backwards.
  - A drive never counts toward FULL ALIGNMENT ("NO · 4H DRIVE").
  - If price later reclaims the open, the normal stages resume.
- **ENGULFING:** the body has opened beyond and moved past the previous candle's body.
  - FORMING ▲/▼ while the candle is live; CONFIRMED once it closes.
  - "LAST CANDLE ▲/▼" (chart) or "P4H ENGULFED ▲/▼" (4H) when the candle that just closed was an engulfing.
  - Rows: "4H ENGULF" and "<tf> ENGULF" in the full dashboard, and one "ENGULF" row in mobile mode (the 4H first, otherwise the chart candle).

## Line chart: all 4 stages, every candle (v2.1, Mac 11/22)
- **Labels:** the path shows 1 OPEN, 2 EXTREME (with its price), 3 RECLAIM and 4 EXPANSION, each one once it has happened. The stage price is in now is marked "◀" and has the dot.
- **v2.2 (Mac, 11/22):** each stage is drawn and labelled only once it has happened. The v2.1 dotted projection of stages still to come was removed.
- **Line styles:**
  - Before any extreme, it reads "1 OPEN ◀ waiting for the extreme".
  - A failed reclaim is a red dashed leg marked "RECLAIM LOST ◀".
- **New candle:** the whole path is rebuilt from the current chart bar on every tick, so it starts over at "1 OPEN" when a new chart candle opens.

## Mobile mode and label sides (v2.0, Mac 11/22, for an iPhone 14 Plus)
- **Turning it on:** Settings → "Mobile / labels" → MOBILE MODE.
- **Compact dashboard:** 7 rows at Normal text size, in the bottom-left by default (the position is an input):
  - 4H, e.g. BULL 4/6 EXPAND
  - the chart candle, e.g. 30m BEAR 2/6 EXTREME
  - P4H direction
  - ALIGN: LONG ✓, SHORT ✓, or the missing condition
  - the 4H OPEN, with ▲ or ▼ for where price is now
  - TARGET
  - 4H CLOSE countdown
  - The title bar still turns green or red when fully aligned.
- **Drawings packed close to the last bar:** P4H at +3, C4H at +8, the path from +13 with 2 bars per step. Labels are shorter and Normal size.
- **Label sides:** level-line labels and path labels sit on the RIGHT by default. Each has a Right/Left input.

## Full alignment (v1.9, Mac 11/22: "take trades when price is trading in full alignment")
FULL ALIGNMENT reads LONG ✓ or SHORT ✓ only when all three of these are true:
1. **P4H:** the previous 4H closed in the model's direction. There is a switch to drop this requirement.
2. **4H:** the 4H model is named, past its reclaim and not lost, so it is in RECLAIM, EXPANSION or TARGET.
3. **Chart candle:** it has the same model, past its reclaim and not lost.
   - RECLAIM counts only once it is CLOSED, meaning a 1m candle closed back through the open. There is a switch for this too.
   - EXPANSION and TARGET always count.

How it shows:
- **Otherwise:** the row reads "NO · <first missing condition>", for example "NO · P4H AGAINST" or "NO · 30m NOT RECLAIMED".
- **When aligned:** the dashboard title turns green (ALIGNED LONG) or red (ALIGNED SHORT).
- **Alert:** `alert()` fires once when alignment starts. Create it in TradingView with the condition "Any alert() function call".

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
