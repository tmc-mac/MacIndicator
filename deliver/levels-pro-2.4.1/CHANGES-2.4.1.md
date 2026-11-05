# Levels PRO v2.4.1 — changes over v2.4-dev (basis, Mac 11/05)

## v2.4.3 (11/05, sealed under the hard cut): Mac's 15m phone screenshot (Mobile Mode ON, v2.4.1b) — plates cut under the price scale, plates over event tags, a board covering ~45 % of the pane
Built on v2.4.2 (sha 5f32e57c…). `LevelsPRO-v2.4.3.pine`, 2646 lines. Everything is gated on `mobile` (Mobile Mode); with it OFF the drawing is byte-identical to v2.4.2 (witness below). Main body 1,619 → **1,573** lines (functions 179 → 261).

**Item 0 — plate anchoring [ANCHOR] (in `f_drawLevels`).** Cause: plates at `bar_index + mob_off` with `label_left` extend RIGHT into the axis whenever the app's right margin (which Pine cannot read or set) is narrower than the plate. Fix: on mobile every plate is anchored at **x = bar_index − `mob_back`** (new input, default 1) with **`label.style_label_right`**, so the text hangs LEFT of the anchor and ends at the last candle — it can never enter the axis, whatever the margin. Lines still extend right to `mob_ext`; the ★ main lines the same. Packing stays vertical (`f_mobPack`). Alternative input `mob_anchor` = "left of last bar" (default) | "at the line start" (plates at the left end of the lines, `label_left`) if the plates cover too many recent candles. **Plates vs the newest event tag:** `f_mobPack` reads the newest live event label's y (`label.get_y` of `EV[(ev_head + EVN − 1) % EVN]`, only while `ev_last_born` is within `event_life`) and treats `[ev_y − gap, ev_y + gap]` as occupied: a plate landing inside moves to `ev_y + gap` and packing continues above it. What Mac should see: a single column of plates hugging the last candles on the LEFT side of the axis, none cut, the ★ 4H / 30m plates among them, the event tags (on their own candles) in clear bands.

**Item 2 — event markers glyph-only [EV-GLYPH] (`f_ev_set`).** On mobile the previously newest marker drops to its first character (▲ ▼ ■ ● ◆) when a new one is born; the newest keeps its words; every marker's tooltip carries the full text (desktop too — tooltip only, no visible change). Colours unchanged.

**Item 1 — mobile dashboard (`f_dashMobile`, the v2.4.2 mobile rows moved verbatim with `r → rr`, called once: `if mob_dash != "off" → r := f_dashMobile(r, planbg)`).** New input `mob_dash` = **compact** (default) | strip | off | full. compact = verdict/WAIT row · BIAS + "ST … · LT …" on one row · the nearest level row (ladder `shown = 1`) · TRIG · EV (plus the E/S/T row while a plan is valid); the LEVELS title, CTRL, TF ALIGN and OPEN POS rows are drawn only in `full`. strip = one row: verdict · bias + score · ">30O SELL"-style nearest level; no ladder rows. off = no board. Table anchored `position.bottom_right` on mobile unless `full` (`dp`); same table object, rows simply not written (the table is cleared every last bar as before); text size = Mobile: Text Size (small).

**Item 3 — TF ALIGN / OPEN POS on one line** (`"15m+ · 1h− · 4h−"`): mobile `full` board only (`str.replace_all(…, " ", " · ")` replaces the `"\n"` form). Desktop already prints `align_str` on one line; left untouched (0 tokens).

**Item 4 — mobile label wording:** near plates read `<abbr> · <state> · <price>` with `SWEEP UP/DN → SWEEP↑/↓`, e.g. `IBL · SWEEP↑ · 27084.75` (the control word stays in the board); far plates `ABBR price`; main lines keep the ★.

**Also:** the event-expiry loop is now `f_ev_expire()` (verbatim move, main-body budget).

**Witness by reading (Mobile OFF):** `f_drawLevels` — `m_ls` false, anchor/style/tag ternaries take their v2.4.2 branches; `f_mobPack` — not executed (`if mobile`); `f_ev_set` — the `if mobile` block skipped, `label.set_tooltip` is the only desktop difference (no pixels); `f_dashMobile` — not called; ladder `shown = n`; `dp` = `panel_pos` mapping. Desktop drawing identical to v2.4.2.

**Scan (touched lines):** `str.substring(pt, 0, 1)` only inside `if str.length(pt) > 1`; `array.get(EV, (ev_head + EVN − 1) % EVN)` index always 0..EVN−1; `array.get(EV_BORN, s)` loop variable (moved line); the strip row's `f_mobile_name(math.max(ip_i, 0))` clamped and under `engaged and ip_i >= 0 ? … : …` (ternary). No new access depends on the other side of an `and`/`or`. New constructs: `label.get_text`, `label.get_y`, `label.set_tooltip`, `str.length`, `str.substring`, integer `%` — all documented v5 built-ins; a user function returning an int (`rr`) assigned with `:=`.

**Tokens:** source 23,108 / inline 40,016 → est. compiled **69.7k (k_inline) / 74.8k (k_linear)**; +466 source tokens over v2.4.2. Source is **208 over the desk's 22,900 source ceiling** (inline 40,016 ≤ 40,200); the TradingView compile governs; fallback v2.4.2 → 2.4-dev.

**Next (not in v2.4.3, listed):** the compact board's EV cell still wraps `" @ "` to two lines; glyph-only also for markers older than the newest at birth time only (an old marker keeps its words until the next birth); a device check of `mob_back` (0 vs 1) and of `mob_gap` against the event band; desktop TF ALIGN unchanged by design.

---

## v2.4.2 (11/05): Mac — "make the lines for the 4H and 30 min opens different from the rest … maybe even a toggle mode where we can disable all the other lines"
Built on v2.4.1b (sha d53ea42f…, reviewer S3 applied). `LevelsPRO-v2.4.2.pine`, 2601 lines. Two changes, both inside `f_drawLevels`, plus one input line.

**[MAIN] the two main lines** = registry slot 13 "4H Open" (current 4H open, the bot's 4H control level) and slot 15 "30m Open" (the bot's primary 5M reference), desktop AND mobile:
- `bool is_main = i == 13 or i == 15` (line 1740).
- line width 3 (line 1765: `is_main ? 3 : isip ? math.max(tw, 3) : tw`), solid (1762: `is_main ? line.style_solid : …` — the rolling-open dotted style no longer applies to these two; the 1H Open stays dotted).
- label text prefixed `★ ` (1767) and one size up (1786: tiny→small, small→normal, normal→large, large→huge; `lsz` for every other level).
- mobile: never abbreviated and always in the full-text 2 px set (1755: `m_near = mobile and (is_main or rank < mob_near)`); their packed y is unchanged (packing stays by price, so the ★ plates keep their place in the column and no other plate is dropped).
- Level-STATE colours untouched: `cc`/`col_viol` text and line colours are exactly 2.4-dev's; the two are told apart by width, solid style, ★ and size only.

**[FOCUS] toggle** `focus_main = input.bool(false, "Focus: 4H + 30M opens only", group=g_dash, …)` (line 209, the Dashboard group with Mobile Mode; default OFF):
- ON → every level except slots 13/15 takes 2.4-dev's own hide path (1741: `if na(px) or not L_ON or (focus_main and not is_main)` → `line.set_color(col_hide)`, `label.set_color/set_textcolor(col_hide)`, `label.set_text("")`). Nothing is deleted or recreated; pools unchanged (28 lines, 39 labels, 0 boxes, 4 tables). The in-play violet level stays visible if it is one of the two (its `isip` colour/width path is inside the drawn branch). The halo, event glyphs, board, PARITY/EVENTS tables and alerts are unchanged (levels keep computing).
- OFF → identical to [MAIN] above.

**Main-body budget:** `f_mobPack()` now creates and returns `[M_Y, M_RK]` (tuple return) instead of filling passed arrays, so the last-bar block is two lines (`[M_Y, M_RK] = f_mobPack()`, `f_drawLevels(M_Y, M_RK)`). Main-body lines: v2.4.1b 1,620 → **v2.4.2 1,619** (function bodies 176 → 179) with the new input included.

**Witness by reading (Mobile OFF + Focus OFF):** for every slot other than 13/15, `is_main` is false and each edited expression reduces to its v2.4.1b form: 1741 hide condition (`focus_main and false` = false), 1755 `m_near` (`false or …`), 1762 style, 1765 width, 1767 tag (`"" +`), 1786 size → byte-identical drawing. Slots 13/15 differ only in width (3), style (solid), ★ prefix and size. `diff v2.4.1b v2.4.2`: header (3 lines), title, SCRIPT row, the input, f_mobPack's 2 array lines + return, and f_drawLevels lines 1739-1741, 1755, 1762, 1765, 1767, 1786, plus the 2-line call block.

**Index-guard scan (touched lines):** 1741 `array.get(L_ON, i)` and 1755 `array.get(M_RK, i)` — `i` is the `for i = 0 to NL - 1` variable, both arrays NL-sized; 1762 `array.get(L_ROLL, i)` as before. No new access depends on the other side of an `and`/`or`. New construct: a tuple return `[M_Y, M_RK]` from a user function and tuple destructuring at the call (`[a, b] = f()`), the form 2.4-dev already uses for `f_p_period` / `f_p_level`. `size.huge` is a documented `size.*` constant.

**Tokens:** source 22,642 / inline 39,157 → est. compiled 68.2k (k_inline) / 73.3k (k_linear); +83 source tokens over v2.4.1b. 17 `request.security`, unchanged.

---

## v2.4.1b (11/05, same day): compile fix — paste THIS file
Mac's paste of v2.4.1 failed: TradingView **"The main body of the script is too long. Try wrapping code in functions."** (2.4-dev compiles.) That is the main-scope size limit, not the token limit. v2.4.1 had added ~50 main-scope lines to a build already near the limit.

Fix (`LevelsPRO-v2.4.1b.pine`, 2593 lines): the section 11 drawing code is now two global functions, declared right before the last-bar block and called once from it:
- `f_mobPack(float[] M_Y, int[] M_RK)` — the mobile pre-pass (sort, interval packing, distance rank), fills the two arrays in place with `array.set`; nothing else.
- `f_drawLevels(float[] M_Y, int[] M_RK)` — the per-level line/label loop, **moved verbatim** (dedented 4 spaces; the 2.4-dev loop body and the 2.4.1 mobile branches unchanged byte for byte). It reads the engine arrays and globals (`L_PX`, `L_ON`, `CTL_ST`, `STATE`, `TESTED`, `BEH`, `L_TIER`, `L_ROLL`, `ip_i`, `engaged`, `lsz`, `lbl_bgc`, inputs) and writes only the pooled `LN` / `LB` drawings through `line.*` / `label.*` setters.
- The last-bar block keeps the halo (2.4-dev) and then: `float[] M_Y = array.new_float(NL, na)`, `int[] M_RK = array.new_int(NL, 99)`, `f_mobPack(M_Y, M_RK)`, `f_drawLevels(M_Y, M_RK)`.
- Pine rules respected: no `request.security`, `plot*`, `alert*` or `var` inside either function (checked by grep: 0 hits); both end in `true` (a function must return a value; the result is discarded); declared before use (`f_mobile_name`, `f_ctl_col`, `f_ctl_str`, `f_beh_str`, `lsz`, `lbl_bgc`, `ip_i`, `engaged` are all declared above them); global arrays are mutated in place only; parameters are the two local arrays created in the caller.
- Reviewer findings folded in: **S1** the pre-pass local `mo` shadowed the global `mo = month(time, TZ)` (2.4-dev line 259) → renamed `m_ord` inside `f_mobPack`. **S2** the light-chart plate is now dark grey `#263238` (near-white left 2.4-dev's green/amber/violet/cyan text at 1.4-2.0:1); dark-chart bytes identical to 2.4-dev. Noted, not changed: packing only slides plates up, so a clustered top can float above its line (knob: `mob_gap`).
- Title / short title / PARITY `SCRIPT` row read "v2.4.1b". Nothing else differs from v2.4.1 (`diff`: the moved block plus the 4 call lines and the header).

Main-body size (non-blank, non-comment lines at indentation 0 plus their nested blocks; function bodies excluded):

| Build | Main-body lines | Function-body lines |
|---|---|---|
| 2.4-dev (compiles) | 1,647 | 91 |
| v2.4.1 (failed: main body too long) | 1,699 | 91 |
| **v2.4.1b** | **1,620** | 176 |

v2.4.1b's main body is 27 lines (1.6 %) **below** the compiling 2.4-dev and 79 below the failed v2.4.1. The margin is thin because the limit is TradingView's compiled main-scope size, not source lines; if the paste still fails, the next lift is the CONFLUENCE last-bar block (section 12, 2.4-dev lines 1723-1746, pure: no `var` writes except `conf_*`, which would become return values). Fallback remains the untouched 2.4-dev.

Scan of the moved code (SCAN method): 7 `and`/`or` lines with array accesses inside the two functions (v2.4.1b lines 1685, 1719, 1732, 1746, 1753, 1758, 1764) — all loop-variable indexes; the `while keep` at 1695 guards its read as before. Tokens: source 22,571 / inline 39,086 → est. compiled 68.0k (k_inline) / 73.1k (k_linear); +40 source tokens over v2.4.1 (the two headers and `true` returns).

---

Basis: `deliver/levels-pro-2.4-dev/LevelsPRO-v2.4-dev.pine` (sha256 3d6dad42…, 2513 lines), untouched. v2.4.1 = that file + the items below (2581 lines, 86 changed/added lines by `diff`). Nothing from v2.5–v2.8 was merged. With **Mobile Mode OFF (the default) the chart draws byte-for-byte what 2.4-dev draws on a dark chart**: every level value, name, state machine, level-state colour, desktop label text, stagger and width are 2.4-dev's.

## Withdrawn (Mac 11/05: "We have a lot in our indicator already and I don't want to mimic that one as that's someone else's")
- The item-3 one-line status label ("4H ▼ · 30M harmony") and the later 12-row trend-lane table (4H CLOSED … ACTION) were **not built**. No new table, panel, countdown or status text exists in v2.4.1.
- The only item-3 remnant was a check: the current **4H open** ("4H Open", registry slot 13) and the current **30M open** ("30m Open", slot 15) are already levels in 2.4-dev — dotted lines with 2.4-dev labels, values from `request.security("", "240"/"30", open, lookahead_on)` = the open of the period containing the bar, which is the bot's `st.period.O4` / `open30` definition (lib/trendLane.js, lib/levelsPro.js `h4Open`, `h30Open`). Nothing added.

## 1. Defect sweep (item 1) — what was found and what changed
Scan details in `SCAN-2.4.1.md`. Result: **no runtime defect** in 2.4-dev's `and`/`or` index guards, `while` loops or `barstate.islast` blocks; the two display defects below are fixed.

| # | Lines (2.4-dev) | Finding | Fix (2.4.1) |
|---|---|---|---|
| F1 | 1711 `label.set_color(lb, lbl_solid ? color.new(#060B14, 8) : …)` | The solid label plate is a hard-coded dark colour: on a light chart background the plate is a black box on white. | **[BG]** (2.4.1 lines 1659-1662, 1779): `lbl_bgc` follows `chart.bg_color` — luminance `0.299 R + 0.587 G + 0.114 B > 140` ⇒ dark-grey plate `#263238` (v2.4.1b; v2.4.1's near-white `#F2F5F9` left the bright state text at 1.4-2.0:1 and was withdrawn on review), else 2.4-dev's `#060B14`. On a dark chart the bytes drawn are identical. Level-state text colours (`f_ctl_col`, violet in-play) are untouched. |
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

### v2.4.1b, reviewer S3 (MacArthur, 11/05 21:30Z)
The two new functions take untyped parameters (`f_mobPack(M_Y, M_RK) =>`, `f_drawLevels(M_Y, M_RK) =>`): the file had no precedent for an array-typed parameter, untyped parameters infer the array type from the call site, behaviour identical. Note: the v2.4.1 refusal was the main-body size limit, not the token limit; TOKENS-2.4.1.md estimates the token limit only.
