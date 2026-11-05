# Levels PRO v2.4.1 — changes over v2.4-dev (basis, Mac 11/05)

Basis: `deliver/levels-pro-2.4-dev/LevelsPRO-v2.4-dev.pine` (sha256 3d6dad42…, 2513 lines), untouched. v2.4.1 = that file + the items below (2581 lines, 86 changed/added lines by `diff`). Nothing from v2.5–v2.8 was merged. With **Mobile Mode OFF (the default) the chart draws byte-for-byte what 2.4-dev draws on a dark chart**: every level value, name, state machine, level-state colour, desktop label text, stagger and width are 2.4-dev's.

## Withdrawn (Mac 11/05: "We have a lot in our indicator already and I don't want to mimic that one as that's someone else's")
- The item-3 one-line status label ("4H ▼ · 30M harmony") and the later 12-row trend-lane table (4H CLOSED … ACTION) were **not built**. No new table, panel, countdown or status text exists in v2.4.1.
- The only item-3 remnant was a check: the current **4H open** ("4H Open", registry slot 13) and the current **30M open** ("30m Open", slot 15) are already levels in 2.4-dev — dotted lines with 2.4-dev labels, values from `request.security("", "240"/"30", open, lookahead_on)` = the open of the period containing the bar, which is the bot's `st.period.O4` / `open30` definition (lib/trendLane.js, lib/levelsPro.js `h4Open`, `h30Open`). Nothing added.

## 1. Defect sweep (item 1) — what was found and what changed
Scan details in `SCAN-2.4.1.md`. Result: **no runtime defect** in 2.4-dev's `and`/`or` index guards, `while` loops or `barstate.islast` blocks; the two display defects below are fixed.

| # | Lines (2.4-dev) | Finding | Fix (2.4.1) |
|---|---|---|---|
| F1 | 1711 `label.set_color(lb, lbl_solid ? color.new(#060B14, 8) : …)` | The solid label plate is a hard-coded dark colour: on a light chart background the plate is a black box on white. | **[BG]** (2.4.1 lines 1659-1662, 1779): `lbl_bgc` follows `chart.bg_color` — luminance `0.299 R + 0.587 G + 0.114 B > 140` ⇒ near-white plate `#F2F5F9`, else 2.4-dev's `#060B14`. On a dark chart the bytes drawn are identical. Level-state text colours (`f_ctl_col`, violet in-play) are untouched. |
| F2 | 1701-1708 label stagger `bar_index + lbl_offset + stack * 7` | Each colliding label is pushed 7 bars further right; with 4+ levels within 0.18 ATR the last label sits past the line end (`extend_r` = 30) and, on a phone, off the screen. | Fixed on **mobile only** by the packing layout (§2). Desktop keeps the 2.4-dev stagger exactly (Mac: the labels were better). Listed so the desk knows it exists. |
| — | 1968 `while keep` (ladder sort) | Checked: the guard `keep := b >= 0` is evaluated before the body's `array.get(key, b)`; the v2.0 bug [e] stays fixed. | none |
| — | 2210 `p_pwc = request.security("", "W", close[1], lookahead_on)` | PWC = the close of the last completed TradingView W bar = the previous week's **last trade** = Mac's option A (11/02). Data-only row `PWC_PRICE`, not a drawn level, same as 2.4-dev. | none |
| — | object budget | lines 27 + 1 halo = 28 / 100; labels 27 + 12 event glyphs = 39 / 100; boxes 0 / 50; tables 4 (board, STALE badge, PARITY, EVENTS). All pooled at `barstate.isfirst`, reused on `barstate.islast`; `label.new`/`line.new` appear only inside `isfirst`. 2.4.1 adds **no objects**. | none |
| — | `na` arithmetic on labels | Every `str.tostring(px…)`/`label.set_xy(…, px)` is under `if na(px) or not L_ON → hide else …`; the packed `m_y` falls back to `px` when na. | none |

## 2. Mobile pass (item 2b, Mac 11/05: "elite UI wise and ready for my iPhone 14 Plus")
Rules, constants and the level-by-level before/after are in `MOBILE-2.4.1.md`. Code: section 11 DRAWING only (2.4.1 lines 1659-1662, 1685-1732, 1749-1779) and the four inputs at 199-203. Everything is gated on the existing `mobile` input (Mobile Mode, default OFF).
- **[MOB-PACK]** one pre-pass per last bar: visible levels sorted by price (insertion sort, the ladder's loop shape), then **interval packing bottom-up**: label y = its level, or the label below + `mob_gap × 1H ATR` when they would overlap ⇒ zero label overlaps by construction. Distance rank 0..n-1 picks the **nearest `mob_near`** levels for the full 2.4-dev label text; the rest read `ABBR price` (≤ 16 chars, e.g. `PMoH 25123.50`). Every mobile label is anchored `mob_off` bars right of the last candle (no horizontal stagger). The tooltip carries the full name, control, state and price for abbreviated labels.
- **[MOB-W]** nearest `mob_near` lines 2 px, the rest 1 px (the in-play level keeps 2.4-dev's 3 px), monthly levels (slots 21-26) dotted like the rolling opens, lines end `mob_ext` bars out.
- **[BG]** as F1 above (both modes).
- New inputs (appended after `mob_ev`, so every 2.4-dev input keeps its identity): `mob_near` 7, `mob_gap` 0.11, `mob_off` 2, `mob_ext` 12.

## 3. Parity (item 2)
`PARITY-2.4.1.md`: all 20 levels of the bot's `lib/levelsPro.js` registry are on the chart with the same name and the same price definition. No indicator-side change was needed. Indicator-only (PWO, MO, MH, ML, PMO, PMoH, PMoL) and bot-only (TIDE zones, 15m swing, ORH/ORL) items are listed, not changed.

## 4. Pine constructs new to this file (no compiler on the desk; documented semantics)
- `chart.bg_color` (built-in `color`, v5): the chart background colour from Chart settings → Appearance. `color.r/g/b(color)` → 0..255 float components.
- `array.new_float(NL, na)` / `array.new_int(NL, 99)` declared **inside** `if barstate.islast`: local arrays, re-created on each execution of the block (last bar only), no `var`.
- Ternary precedence: `a or (b and c) ? x : y` — `?:` is the lowest-precedence operator in Pine, so the whole `or` expression is the condition (same form 2.4-dev already uses at its line 1694).
- Everything else (insertion sort with `while keep`, `label.set_xy`, `line.set_width`, `str.tostring(px, format.mintick)`) already exists in 2.4-dev.

## 5. Tokens (item 4)
`TOKENS-2.4.1.md`: source 22,531 (2.4-dev 21,925), inline model 39,046 (38,281). Estimated compiled ≈ 68.0k (k_inline) / 73.0k (k_linear); 2.4-dev itself, which compiles and runs, measures 66.6k / 71.0k on the same model, so v2.4.1 adds ≈ +1.3k / +2.0k. Within the desk ceilings (source ≤ 22,900, inline ≤ 40,200).

## Not changed on purpose
- Level-state colours (sacred, Mac 11/01); no alerts added or changed; no notifications from the chart.
- PARITY/EVENTS machine-readable tables, the board, the plan, the event glyphs: 2.4-dev's.
- PWC stays data-only (the bot's registry has no PWC level either).
