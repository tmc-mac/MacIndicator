# Phone terminal 2.0.9.20 (PREVIEW) — what changes against 2.0.9.19.2 (cf3d288a)

Display only. The page sends the same requests as 2.0.9.19.2. With TIDE off or absent, every view is the same DOM as 2.0.9.19.2 (identity-tested).

## 1. TIDE tape (Now → the Hour card)
With TIDE in shadow or live, the Hour card's history strip is hidden (not removed) and one SVG takes its place. It covers 8 hours on the 4H grid (03/07/11/15/19/23 PT): the previous period and the current one.
- **Control lane:** the direction and kind from `tide.board.control`, drawn up to now. A trap is solid, a bias is striped.
  - With no board, the lane comes from the journal's `control_form` and is labelled "needs bot r1.3".
- **No-entry shading:** the time blocks (`tide.rules`), the open wait, and the session close. Each carries its code word.
- **Events:** arm ◇, retest ↺n, rejection ⟂, signal ● (in its grade colour; a replayed row is marked), cancel/expire ×, no-trade ○.
  - All events come from the TradeDay row union (one row source).
  - Events closer than 12 px form one cluster: the most telling glyph plus "×n". Tapping a cluster lists them all (up to 4, then "+n more").
- **Trades:** TIDE trades and the open position as bars, coloured by result. Only the last two show a $ figure.
- **Unknown span:** the time before the first row the phone holds is hatched "not in snapshot".
- **Caption:** next 4H open countdown · open wait end · next block.
- **Tap a tick:** one aria-live detail line. The hit areas are 44 px.
- **Cost:** about 5 ms per update in the gate. The now marker moves by a transform.

## 2. Levels → "Live trade" card: the PLAN lines come from TIDE
Before this release, with TIDE on, the card drew the old levels path's level-event plan. That path takes no entries under TIDE. In tide19-live, for example, TIDE was in a short while the card showed an old "PLAN".
- **TIDE in a trade:** the lines come from `tide.position`: the fill, the stop (acked, or "STOP asked" when not acked), TP1 (until hit) and TP2. The card reads "TIDE IN TRADE".
  - The chart names that line "Fill", never "Plan entry". This is a minimal MacCharts change: the card passes `kind:'fill'`, and every other trade or plan draws as before.
- **Otherwise:** the board's NEXT TO ACT plan (the same pick as Levels Now). The card reads "TIDE PLAN".
  - A reference plan reads "Level / Stop ref · reference, not an order".
  - Missing TPs read "set at the signal".
- **No plan to draw:** no lines, and a TIDE note in their place:
  - "next to act: … entry, stop and TPs set at the signal", or
  - "fill price UNKNOWN".
  - The card never falls back to the old event plan.
- **"Old levels path (manage-only)" button:** off by default, remembered per phone. It shows the old path's lines, labelled "old path (manage-only)".
- Now's Levels dash card uses the same plan.

## 3. Review tab = the TIDE journal (MacJournal module, unedited: diff a9a702f5, js 48d92609, css 5222908b)
- The day's TIDE trades and net, one card per TIDE position, and the decisions (filterable, newest first).
- Warm-up replays are grouped and marked not tradeable.
- The old content is collapsed under "Old levels path (manage-only, takes no entries)".
- "Copy TIDE journal" uses the page's real version.
- MacArthur's ruling: the Open wait / Time block rule rows show only under "Control & rules".
- The module mounts only for shadow or live.

## 4. Version
`macui.pageVersion` = '2.0.9.20'. The signal-checks export and the TIDE journal export say "terminal 2.0.9.20".

## 5. Speed: no extra work with TIDE off (MacArthur 11/04, after the reel 4x replay gate)
The first 2.0.9.20 build (bf1ec0b9) did TIDE work on every Levels redraw even with TIDE off, which made the trade replay at 4x about 10% slower. This build fixes that:
- **TIDE off means no TIDE work.** Every new 2.0.9.20 hook (Levels plan, Levels plan stats, the Live trade card, the TIDE tape on each poll) now hands straight back to the page's own drawing when the snapshot has no `tide` or its mode is off. The Levels hooks also need mode shadow or live, the same rule the Levels tab already used.
- **The TIDE model is worked out once per poll.** Its result is kept for the snapshot it came from, so the tape, the Levels card and the 2.0.9.19 cards share it instead of each computing it again.
- Nothing you see changes: TIDE-off pages match 2.0.9.19.2 exactly (identity-tested), and the TIDE views are the same as in bf1ec0b9 (feature tests and screenshots).
