# Phone terminal 2.0.9.21 — what changes against 2.0.9.20 (caf73686)

Display only. The page sends the same requests as 2.0.9.20. With TIDE off or absent, every view is the same DOM as 2.0.9.20 (identity-tested; see the gate table below). The build is 2.0.9.20 with three scripts swapped: `feat-20920-r21.js` (the Levels fix), `feat-20919-r21.js` (the header words), `feat-20917-r21.js` (the Hour card). Rebuilding 2.0.9.20 from the same folder still gives caf73686 byte for byte.

## 1. Levels → "Live trade" card: no more old-path lines under TIDE (Mac's 08:34 PT screen, 11/04)

**What Mac saw.** TIDE live, flat. Header (right): "TIDE watching ▼ 1H Open 28,628.25 (+37.25) · ARMED · 4H ▼ sellers". The card (wrong): **Target 28,587** at price, **Stop 28,471.75** 120 pts below, a **Trigger** marker — the shape of a LONG — while TIDE's only setup was the 1H Open SHORT (journal: `setup_arm -1 28628.25 kind=accepted-break S281`). The footer said "Flat, no plan at a level".

**Root cause.** Those three are the OLD levels path's live level event (`snapshot.levels.live`: a 5m SWEEP-RECLAIM long at the 30m Open, target PWC 28,587, stop 28,471.75). Two renderers draw it when there is no trade and no plan, and neither knew about TIDE:
- MacCharts (`charts/maccharts.js`, the canvas chart that replaces the ladder on the Levels card, the Dash card and the full screen): in its flat mode it reads `levels.live` itself (`scene()`, the `ev` line) and draws that event's level, "Stop" and "Target" lines and the "Trigger" marker. Its data comes from the glue's `getData` (`charts/integrate-charts.js` `liveData` / `nowData`), which hands it the raw `levels`. 2.0.9.20 only redirected `lvPlanTrade`, so the plan path was TIDE's but the no-plan fallback was still the old path's.
- The page's own SVG ladder (`lvLadder` in the base page) does the same with `TGT` / `STOP` tags and a trigger-bar circle (hidden under MacCharts, but drawn in the DOM and shown when MacCharts is absent).

Why there was "no plan" at that moment cannot be read off the recording (the board plan may have been missing, or the plan read threw); both cases are covered below.

**The fix (2.0.9.21, `feat-20920-r21.js`).** With `tide.mode` shadow or live and the old-path toggle off:
- MacCharts gets its data through a guard: the same object with `levels.live` emptied. The guard wraps each chart handle's `getData` once (the glue exposes the handles read-only at `macui.charts`), the first time a render shows it, and updates that chart once more right then. The named level lines, candles and price stay.
- `lvLadder` gets `levels.live` emptied the same way (one wrapper; the page's own function, untouched, draws the rest).
- A throw inside the TIDE plan read no longer falls back to the old path's plan: the card shows "TIDE plan not read: nothing charted" and no lines.
- The TIDE plan label is now "`<level name> · SHORT/LONG · TIDE armed`" (from `tide.board.levels[].dir`); the card line reads "1H Open · SHORT · TIDE armed". Which level: the header's own rule (`lvModel.next`: the nearest unblocked armed / retest-pending level), unchanged.
- With no armed or retest-pending level, or an armed level whose board plan is null: no Target / Stop / Trigger lines anywhere (card, Dash card, full screen, ladder); the level lines, price and the footer stay, plus the TIDE note ("TIDE: nothing armed" / "TIDE next to act: … set at the signal").
- "Old levels path (manage-only)" on: the old event's lines are drawn on purpose, labelled, as in 2.0.9.20.
- TIDE off or absent: every wrapper is the page's own call. Identity-tested against 2.0.9.20.

**Witness** (`tests/plan-leak-20921.test.cjs`, fixture `tide21-leak` = that state: board 1H Open 28,628.25 dir -1 armed with a reference plan whose stop is 28,662 above; price 28,591; `levels.live` holds the old LONG event with stop 28,471.75 / target 28,587). On 2.0.9.20 it fails 6 of 16 (the canvas carries "Trigger", "Target", "Stop", "28,471.75", "28,587.00"); on 2.0.9.21, 16 of 16: stop 28,662 > entry 28,628.25 for the short, label "1H Open · SHORT", none of the old text on any canvas, footer consistent, the two no-plan cases draw no plan lines, the header in words.

## 2. Header: the distance in words (`feat-20919-r21.js`)
"(+37.25)" next to the armed level was the level's distance above price but read like price was up. It is now "· 37.25 above price" / "· 37.25 below price" ("at price" at 0). Nothing else in the file changed.

## 3. Hour card (`feat-20917-r21.js`, drafted by MacUI-N2, folded in)
- The candle type reads by its body: SWEEP (unchanged); REJECTION only when the wick past the open is at least 15m 8 / 1H 20 / 4H 40 pts AND the body is at most 35% of the range, shown with its arrow (REJECTION ↑ = the dip under the open was rejected); otherwise ACCEPTANCE ↑ / ↓ (the move itself); BUILDING when none of these. The 4H candle (open and price only) reads ACCEPTANCE or BUILDING, never REJECTION. A +396 hour that dipped 24 pts under its open no longer reads "⟂ REJECTION".
- The 4H open is TIDE's (`tide.board.O4`), the same figure as the TIDE card; the 4H start is on the bot's grid (03/07/11/15/19/23 PT). Without `tide.board.O4` the old model's open is used and labelled "old model".
- Unit-tested without a browser (`tests/hourtype-20921.test.cjs`, 11/11).

## 4. Version
`macui.pageVersion`, copies and exports say 2.0.9.21.

## Gate
See `gate/GATE-LOG.txt` and the per-step logs in `gate/`. Replay was skipped: the diff does not touch the replay path (MacCharts replays a picked trade, where `levels.live` is not read; the guard only empties `levels.live`).

## Not changed
No bot change, no request change, no change to what the old path's toggle shows. `set-terminal.sh` is the 2.0.9.20 file (d891ef9d).

## Gate note (frozen at MacArthur's order, 17:02Z)
TIDE-off identity vs 2.0.9.20: the first difference in every state is inside the Hour card (`#fx17-hour`: "REJECTION ↑" / "ACCEPTANCE ↓" / "old model", the feat-20917-r21 change, which is the old model's card and not TIDE-gated by design). A second run with the Hour card removed from both DOMs (`tests/identity-20921-nohour.test.cjs`) proves every other byte equal; its log lands in `gate/30b-identity-tide-off-vs-2.0.9.20-hour-card-excluded.txt` when it finishes (pending at freeze time).
