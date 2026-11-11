# Warm-up gap: "read 1371 15m bars of the 2000 it needs"

Reviewer desk, code reading only (no rig, no live calls). Tree: MacBot-edge-r1 (executor 9f8bcb8c).

## Answer in one line
The 1371 is the request's own time window, not a fault. The bot asks for 2000 bars but only looks back 2010 × 15 minutes of **calendar** time (20.9 days), and the market is closed about a third of that. The alert is a false alarm that will fire on every start. Nothing the bot trades on is short of history.

## How the 15m history is requested
- `lib/bars.js:86-93` `fetchBars`: `startTime = now − barMs × (limit + 10)`, `endTime = now`, `limit`, `includePartialBar: true`. One request, no paging.
- `lib/bars.js:118` `fetchAllTimeframes` passes `limit` = `CONFIG.historyRefreshLimit` = 2000 (`live-executor.js:1216`, used at `:2541`).
- So the 15m window is 2010 × 15 min = 30,150 minutes = 20.94 calendar days.

## Why that returns about 1371
The futures session is 23 hours a day, Sunday evening to Friday afternoon: 92 15m bars per trading day, none on the weekend or in the daily one-hour break.

I modelled the window against that calendar for 9–11 November 2026 (window start 19–21 October, three weekends inside it):

| Start time of the bot | 15m bars inside the window |
|---|---|
| any hour outside the daily break | 1370 |
| during or just after the daily break | 1373 |
| range over two weeks of start times | 1370–1380 |

The model's 1370 against the observed 1371 is the forming bar or a boundary bar (`includePartialBar: true`). The count matches to within one bar.

- **Broker cap?** No. A cap would give a round number (the fake broker's is 600) and would not track the calendar. The documented per-request cap is far above 2000.
- **Contract roll?** No, not for 15m. The window reaches back only to about 20 October, well inside the current contract. Roll history does limit the 4H request (2010 × 4 h = 335 days asked, the contract has less), but that is a different series and no alert reads it.

## Did earlier builds get the same count silently?
Yes. `lib/bars.js` has one commit in the repo (base 8efb4f6); the window arithmetic has never changed. `historyRefreshLimit: 2000` is also from the base. Every build has warmed up on about 1370 15m bars. The alert that reports it arrived with bf-alerts r1 (45779c1), which compares the count with `historyRefreshLimit` (`live-executor.js:2843`, `lib/healthAlerts.js:144`). Its own test used a fake broker capped at 600 bars, so it never saw what the real window returns.

The other timeframes behave the same way: 5m about 1374, 30m about 1372, 1h about 1373, 3m about 990 on a start after a weekend.

## What depends on deep 15m history
The 15m series is the chart both indicators replay (`live-executor.js:2562-2584`). What they keep across bars:

| Reader | Depth it needs | Has enough at 1371? |
|---|---|---|
| MAC: EMA 9 / 21, cloud 20, ATR 14, RSI 14, ADX 14 (`lib/macTrap.js:67, 95, 226, 244`) | under 200 bars to converge | Yes |
| Levels PRO: day, Asia, London, IB levels, prior-day high/low/close, VWAP (`lib/levelsPro.js:172-179`) | 1–2 trading days | Yes |
| Levels PRO: chart ATR 14 (`lib/levelsPro.js:220`) | under 100 bars | Yes |
| Levels PRO: RVOL by time of day, mean of up to **20** prior days (`lib/levelsPro.js:359-368`) | 20 days × 92 = 1840 bars | **No: it averages about 14 days** |
| No-chase (`live-executor.js:2170`), runner ATR15 (`lib/edgeExits.js:63`), S/R areas (96 bars) | 16–96 bars | Yes |

RVOL is the only reader that falls short. It feeds `tapeHeavy` / `tapeDead`, which move the grade of setups 3 and 4 by +1.2 / −1.5 (`lib/levelsPro.js:706-707`). A 14-day mean against a 20-day mean is a small difference, and it has been that way on every build, so every replay and live result to date already includes it.

Daily, weekly and monthly levels come from their own requests (250 / 104 / 36 bars) and are not affected.

## Recommendation: fix the alert's threshold, not the request
Set the alert to what the window can return, and leave the request alone.

- In `live-executor.js:2843`, pass `need` as a floor that the window always clears, not `historyRefreshLimit`. The window never returned fewer than 1370 in the model, and a holiday week removes up to 92 more. **`need: 1200`** catches a genuinely cut-short warm-up (a broker cap, an error, a 600-bar answer) and stays quiet on a normal start.
- Change the text at `lib/healthAlerts.js:144` to match: "of the N it expects".

Why not widen the window or page the request:
- It changes the indicator inputs (RVOL) on the live bot, so replay results to date would no longer describe it. That needs a replay comparison first, not a hot fix.
- A wider window means more bars on ten timeframes on every bar close, on a box with 961 MB.
- Nothing that pays is short of history today.

If Mac wants the chart's full 20-day RVOL, that is a separate, measured change: multiply the lookback by 1.5 for intraday series (`barMs × limit × 1.5`), then compare replay P&L and warm-up memory before it ships.

## Not checked
- I did not call the broker. The explanation rests on the code and the calendar model; it matches the observed count to within one bar.
- The "7 s" in the alert is the warm-up duration and is normal.
