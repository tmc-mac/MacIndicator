# 4H Live Model v3.11

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

## A+ alert (v3.11, Mac 11/26 on MES 5m: "We retested the PDL and slammed down as expected with timeframe alignment in the direction of where price is headed")

An A+ fires when all of these are true at once:
1. The ENTRY gate says ENTER: 4H stage, a 3m/5m close confirming the reclaim, room ≥ min R, and not late in the 4H.
2. The extreme was a retest or sweep of a level (the chart candle's extreme, or else the 4H extreme, within the AT LEVEL tolerance; PDL in Mac's example).
3. The 3m and 5m closed beyond the 4H open in the trade direction, and the live price is beyond it too. 15m/30m/1H may still be on their earlier close: they confirm after the entry, they are not needed before it.

What you see:
- The ENTRY row reads "A+ ENTER SHORT …".
- One alert per 4H per direction, e.g. "MES1! A+ SHORT · 5m retest of PDL · 3m/5m closed below the 4H open 7145.25 · LIMIT 7145.25 (don't chase) · E/S/T · price".
- Create the alert with "Any alert() function call". Turn it off with "A+ alert" under Trade plan.

Not yet measured: how often an A+ fires and how it pays has not been backtested. It is a filter on the existing ENTER, built from one example.

## Steeper liquidity grab on the line chart (v3.10, Mac 11/26: "My extreme line is a little flat… so we can see how these candles do the same liquidity grabbing after opening")

- The open → extreme → reclaim legs are now 1 bar wide each (new input "Bars for the open → extreme → reclaim grab", default 1), so the grab after the open draws as a sharp spike. The expansion leg keeps the normal 5-bar step.
- To make room for the narrow spike, OPEN now sits beside-left of its point and RECLAIM beside-right. EXTREME stays at the spike tip, on the opposite side. The candle title moves to the other side of the open so it never covers the OPEN label.
- How steep the spike looks also depends on how far the extreme went from the open and on your chart's price zoom. A 2-pt poke still looks small.
- There are no logic changes.

## Line-chart labels readable (v3.9, Mac 11/26: "The labels for the line chart is hard to read")

- Every stage label now sits on a solid dark plate instead of a transparent background, so it reads over candles, level lines and the grid.
- Labels alternate above and below their points, so two stages at about the same price never print on top of each other. For a bull candle (extreme = the low), EXTREME goes below and OPEN, RECLAIM and EXPANSION go above. For a bear candle, it is the mirror. The live RETEST / CONSOLIDATING / RECLAIM LOST tag sits on the side opposite the expansion.
- More room between stages: the defaults are now 5 bars per stage step (was 3) and a path offset of 24 bars (was 26). In mobile mode the step is 3 bars (was 2). Both are still adjustable under Inputs.
- There are no logic changes. Stages, the dashboard and alerts are the same as v3.8.

## GRAB / SHIFT at the 4H open (v3.8, Mac 11/26: liquidity grab vs a real change of direction)
- **Original side:** taken from the highest timeframe that has closed inside this 4H (1H, else 30m, else 15m).
- **Row states:**
  - **HOLDING ▼/▲:** nothing has happened against the original side.
  - **POKE:** price is through the 4H open against the original side, with no 5m (3m) close beyond.
  - **LIQUIDITY GRAB ✓ <price>:** within the last hour, a 5m candle of this 4H wicked through the open and closed back. The original side is intact. A GRAB tag marks it on the chart.
  - **TESTING:** a 5m close beyond. One close is not a reversal.
  - **SHIFTING:** the 15m closed beyond while the 30m is still on the original side.
  - **DIRECTION CHANGED:** the 30m closed beyond, when the 1H is the original side.
- **Alerts:** one alert at each step from GRAB onwards.
- **Chosen by MacArthur when Mac asked "What do you think is best?" (not yet confirmed by Mac):**
  - the ladder is 5m → 15m → 30m, rather than going up to the 1H;
  - the row watches the 4H open only; grabs at other levels are chart tags only.

## Patience tools (v3.7, Mac 11/26: "add nearby level warning ... continue to add things that will help the trader be patient")
- **IN THE WAY (row 3):** the nearest of your levels between price and the target, e.g. "⚠ London Low 25,738.75 · 33 pts".
  - **On the chart:** it is drawn as a thick amber line labelled "⚠ IN THE WAY" and stays highlighted until price trades beyond it.
  - **Alert:** when that happens, an alert says the level is no longer in the way.
  - **ENTER:** still allowed, but it carries "· ⚠ <level>".
  - **No level:** the row reads "clear to the target".
- **Don't chase:** if price has already run more than 0.3R (input) past the entry, ENTER reads "ENTER SHORT · LIMIT <entry> (don't chase)".
- **Late in the 4H:** no new ENTER in the last 20 minutes (input, 0 = off). It reads "WAIT · 4H closes in 12m · no new entries".
- **CHECK** adds "✓ time" and names the level, e.g. "★ P4H L".

## First move counts (v3.6, Mac's MNQ 15m screenshot, 11/25, 23:58 PT)
- **Problem:** the first segment's side came from the first 5m CLOSE. A candle that dipped below its open inside the first 5m candle and then closed above was read as having started above the open, so it showed "DRIVE ▲" and never a reclaim.
  - Case: 15m 23:45 PT, open 25,671.50, low 25,661, then up to 25,792.50.
- **Fix:** the side price visited FIRST after the open starts the first segment.
  - The same candle now reads BULL · extreme 25,661 · reclaimed by the first 5m close above · 4/4 EXPANSION · EXPANDING.
  - Checked on TradingView data.

## One dashboard (v3.5, Mac 11/25: "desktop version is way too big")
- **One layout:** the compact layout is now the only one, on desktop and phone. It has 12 rows: ENTRY, CHECK, 3m / 5m / 15m / 30m / 1H closes, TF ALIGN, 4H, chart candle, RISK, 4H CLOSE.
- **RISK row:** on desktop it shows the full entry / stop / target / R / $ line; on the phone, R and $ only.
- **Mobile mode** now only changes text size, position and drawing spacing.
- **Removed (the 28-row desktop board):** MODEL, P4H CANDLE, ALIGNMENT, LOCATION, C4H OPEN/EXTREME, P4H HIGH/LOW, RANGE, NEXT TARGET, FULL ALIGNMENT, ENGULF and PLAN. Their information is in the 4H / chart rows, the line chart and the level labels.

## v3.4 fixes from Mac's MES 30m phone screenshot (11/25, 11:29 PT)
- **Waiting rows:**
  - **Problem:** right after a new 4H opens, the 30m and 1H rows read "= AT OPEN". Their last close was the previous 4H's final close, which equals the new open.
  - **Fix:** a timeframe with no close yet inside this 4H now reads "… no close yet this 4H". It is shown with its live side and countdown, and does not count toward TF ALIGN.
  - TF ALIGN then reads e.g. "3/3 BELOW ▼ so far · 2 waiting" with a faint red background. Full red or green still needs all 5.
- **Target:**
  - **Problem:** the target was the nearest level beyond the entry, even when it was only a few points away. In the screenshot: P4H L 7,150 from a 7,154.25 entry gave 0.7R; AL 7,130.50 from 7,133 was 2.5 points.
  - **Fix:** the target is now the first level that pays at least the minimum R (1.5). When no level does, ENTRY reads "WAIT · no level 1.5R away · retest <open>".
- **Mobile labels:** the line chart's stage labels keep the stage names without prices: 1 OPEN, 2 EXTREME, 3 RECLAIM, 4 EXPANSION, with ◀ on the current one. Numbers alone (the first v3.4 build) were rejected by Mac on 11/25 as unreadable, and this was fixed in v3.4.1. Level labels sit 3 bars further right, so they no longer cover the path labels.

## Timeframe closes, TF alignment and the entry gate (v3.3, Mac 11/25)
- **Close rows:** 3m CLOSE, 5m CLOSE, 15m CLOSE, 30m CLOSE and 1H CLOSE. Each row shows that timeframe's **last completed close vs the 4H open**.
  - The row lights green (closed above) or red (closed below).
  - When the live candle is on the other side, the row adds "live ▲/▼". It also counts down to that candle's close.
- **TF ALIGN:** "5/5 CLOSED ABOVE ▲" (green) or "5/5 CLOSED BELOW ▼" (red); otherwise the count, e.g. "3▲ 2▼ MIXED". The dashboard title lights the same way.
- **ENTRY gate:** the top row reads WAIT until the setup is confirmed, then ENTER LONG / ENTER SHORT (★ when the extreme is at a level).
  - **NOT CONFIRMED · 5m closes in m:ss:** price is through the open but no 3m/5m candle has closed through it.
  - **TOO FAR · retest <open>:** confirmed, but from the current price the R to the next level is below the minimum.
  - **Waiting for the retest:** in "Enter on: Retest" mode, ENTER also needs RETEST HELD. That means price came back within N ticks of the open and a 3m/5m candle closed on the reclaim side.
- **CHECKLIST:** ✓ 4H · ✓ 5m close · (✓ retest) · ✓ room · ★ level.
- **Alerts** (with "Any alert() function call"): 5m close confirmed, retest held, ENTER, reclaim lost.
- **Mobile rows:** ENTRY, CHECK, the five close rows, TF ALIGN, 4H, chart candle, RISK, 4H CLOSE.

## Mac's definitions, no percentages (v3.2, Mac 11/25)
- **RECLAIM:** a **3m or 5m candle closes** through the open. The confirmation timeframe is an input (default 5m); on charts at or below it, 1m closes are used. Direction = the side it closes on, and every such close counts, so the latest one wins.
- **EXTREME:** the far point the candle reached on the other side of the open before that close.
- **EXPANSION:** after the reclaim, price **visits new prices for the candle** in the reclaim direction: a new candle high for a bullish reclaim, a new candle low for a bearish one.
- **What price is doing now, after the reclaim:**
  - **EXPANDING:** new prices right now.
  - **RETEST:** back at the open without closing through.
  - **CONSOLIDATING:** inside the range, no new prices.
  - Before any new prices, the stage reads "3/4 RECLAIM · HOLDING / RETEST"; after them, "4/4 EXPANSION · EXPANDING / CONSOLIDATING / RETEST".
- **Line chart:** the expansion point is the new price the candle reached, and the live price is marked separately.
- **4H:** the same rules, using the 5m (or 3m) closes inside the 4H candle.
- **Checked on MNQ 30m, 11/25, 4H open 25,925.75:**
  - The 30m candle from Mac's screenshot (open 25,886.25, high 25,959.25, low 25,860) now reads BEARISH, extreme 25,959.25, reclaimed, no new low since → 3/4 RECLAIM · RETEST. v3.1 called it 4/4 EXPAND.
  - The 4H reads BEARISH, extreme 25,959.25, reclaimed, consolidating.
- **Removed:** the v3.1 percentage thresholds.

## Every reclaim counts (v3.1, Mac 11/24: "it's only taking the original 1-2-3-4")
- **Segments:** the candle is read as segments between confirmed crosses of its open. A cross is confirmed when a 1-minute bar closes on the other side; on a 1m chart, each tick counts.
- **Real move:** when the segment that just ended went 10 % of a normal candle's range away from the open, its far point becomes the EXTREME and the cross is the RECLAIM, in the direction of the cross. So the **latest** cycle always wins.
  - In the same direction as before, it reads "×2".
  - In the opposite direction, the candle has flipped.
- **Smaller segment:** price was only testing the open. Falling back to the extreme's side is RECLAIM LOST; crossing again is a repeat reclaim.
- **Removed:** the v2.6 30 % "flipPct" rule. It ignored real reclaims, e.g. the 11/23 16:30 PT MNQ 30m: open 26,845.50, low 26,775, back above the open. v2.6 called it BEARISH; v3.1 calls it BULLISH, extreme 26,775, reclaimed.

## Your levels + the trade plan (v3.0, Mac 11/24: "bring the levels in, leave the control engine out")
- **Levels:** Levels PRO **v2.4.2**'s level set, computed with the same code: PDH, PDL, PDC, Daily Open, Asia H/L, London H/L, 06:30 / 15:00 opens, IB H/L, session VWAP, PWH, PWL, Week Open, PWO, MO, MH, ML, PMO, PMoH and PMoL.
  - Each group has a toggle, as in Levels PRO.
  - Levels within 2 ticks merge into the heavier one, in Levels PRO's weight order.
  - The nearest 12 are drawn (6 on mobile), coloured weekly/monthly gold, daily cyan, session slate (dotted).
  - The control engine (HOLD/PUSH/FLOW, RVOL, ladder, parity tables) is not included.
- **AT LEVEL:** set when the chart candle's extreme, or the 4H extreme, formed within 10 % of a normal candle's range of one of these levels, or of a P4H / C4H line. The dashboard shows "30m extreme at PDL", and GO/ARMED carry a ★.
- **PLAN row (top of the dashboard)** — states, with an alert on ARMED, GO and INVALID ("Any alert() function call"):
  - **WAIT · reason:** 4H no extreme, 4H DRIVE, P4H against, 4H reclaim <price>, 4H reclaim lost, 30m against, or 30m no extreme yet.
  - **ARMED LONG/SHORT · reclaim <open>:** the 4H is past its reclaim with P4H agreeing, and the chart candle has its extreme in the same direction.
  - **GO:** full alignment. **SKIP:** GO, but below the minimum R (1.5). **INVALID:** the chart candle's reclaim was lost.
- **RISK row:** entry = the chart candle's open; stop = 4 ticks beyond its extreme; target = the next level beyond the entry. It shows R and $ for the Contracts input (default 1).
- **Testing:** the new parts compile on TradingView. They have not yet been watched live on a chart.

## Extremes and repeated reclaims (v2.6, Mac 11/24, MNQ 30m screenshot)
- **DRIVE fix:** DRIVE now shows only while price is still beyond the previous candle's far side.
  - A sweep of the P4H low that comes back inside the range is a bullish EXTREME waiting for its reclaim, not a bearish drive.
  - Case: 11/24, 03:00 PT 4H. It opened at 26,888.25 and swept to 26,683.75, under the P4H low of 26,692.75. v2.5 called it BEARISH DRIVE; v2.6 calls it BULLISH, extreme 26,683.75.
- **Exact extreme prices:** the extreme is now the candle's own exact low or high unless the model has flipped. The 1m feed can be a few ticks off.
  - Case: 04:00 PT 30m. The extreme now reads 26,731.25; v2.5 showed 26,733.50.
- **Testing the open:**
  - A move back through the open counts as RECLAIM LOST, or as a flip, only once it goes 30 % of the reference range past the open. This is the new "flipPct" input.
  - Smaller moves are just testing the open and the stage stays RECLAIM.
  - The reference range is the larger of the previous candle's range and the 14-candle ATR on the chart, or the P4H range on the 4H.
  - The same 04:00 30m candle flipped 4 times in v2.5 and 0 times in v2.6.
- **Repeated reclaims:** the reclaim is counted, e.g. "3 RECLAIM ×2".

## Four stages only (v2.5, Mac 11/22: "I only care for the first 4")
- Stages are OPEN → EXTREME → RECLAIM → EXPANSION, shown as n/4 for both the 4H and the chart candle.
- The TARGET and CLOSED stages were removed.
- NEXT TARGET stays as a price row and the countdown is unchanged.
- FULL ALIGNMENT counts stage 3 (reclaim closed) or stage 4.

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
- **Compact dashboard:** 7 rows at Normal text size, in the top-right by default (v2.4, Mac's call; the position is an input):
  - 4H, e.g. BULL 4/6 EXPAND
  - the chart candle, e.g. 30m BEAR 2/6 EXTREME
  - P4H direction
  - ALIGN: LONG ✓, SHORT ✓, or the missing condition
  - the 4H OPEN, with ▲ or ▼ for where price is now
  - TARGET
  - 4H CLOSE countdown
  - The title bar still turns green or red when fully aligned.
- **Drawings packed close to the last bar:** P4H at +3, C4H at +8, the path from +10 (v2.4) with 2 bars per step. Labels are shorter and Normal size.
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
