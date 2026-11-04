# Phone terminal 2.0.9.19.2 (preview): what your 01:08 screenshots showed, fixed

This is 2.0.9.19.1 plus fixes for what you saw on the live bot at 01:08–01:09 PT. It also carries MacFacts' fixes for the closed-trade UNKNOWNs. It changes the display only.

## 1. The checklist no longer changes between refreshes
At 01:08:34 the points read "WAITING" and the open wait read UNKNOWN. At 01:08:55, on the same bot, they read C 2/5 and PASS.
- **What happened:** the page read only the rows in each snapshot, and those can drop or briefly lose rows.
- **Now:** the page keeps every TIDE row it has seen this TradeDay, and journal rows never change. The open wait comes from the fixed 4H clock (03 / 07 / 11 / 15 / 19 / 23 PT), so it can't go missing.

## 2. "Last signal" is kept apart from "now"
- The checklist opens with **NOW**: the level the bot is closest to acting on, the current setup, or "no setup armed now".
- Below it: **"Last signal S264-E · 01:03 PT (grade C)"** with that signal's gates and points.

## 3. Warm-up replays are labelled
After a restart, the bot replays recent history. Those signals now read **"replayed during warm-up · not tradeable"**, never "not taken (NOT_FLAT)".
- They are not counted as live: "0 live signals · 0 taken (+1 replayed at warm-up)".
- A small line shows the replayed window, for example "warm-up replayed 00:31–01:03 · 360 bars".

## 4. The top of the page speaks TIDE when TIDE is on
- **The mode pill** reads TIDE SHADOW or TIDE LIVE instead of "Intrabar · Levels-only".
- **The status line** shows TIDE's state:
  - the TIDE position;
  - the current hold (time block, open wait, session, news);
  - the level TIDE is watching;
  - or the 4H control with "no setup armed now".
- **The Day P&L cell** gets a TIDE / Old split.
- With TIDE off, the old text is back, unchanged.

## 5. Also
- **Closed trades (MacFacts):** the Levels day strip and the trade detail show the broker fill, the points and the duration from the bot's broker settlement where they said UNKNOWN. Each value carries a "broker fill" note.
- **The signal-checks Copy** now says the page's real version, no longer "terminal 2.0.9.16".
