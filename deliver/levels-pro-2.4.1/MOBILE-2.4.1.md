# MOBILE 2.4.1 — iPhone 14 Plus pass (TradingView iOS app), in 2.4-dev's own style

Target: iPhone 14 Plus, 428 × 926 pt at 3x; the chart pane is about **428 × 560 pt** in portrait under the app chrome, **926 × 428 pt** in landscape. Everything here is inside `Mobile Mode` (the existing input, default OFF): Mac turns it ON on the phone's copy of the indicator and leaves it OFF on the desktop, which then draws exactly 2.4-dev. Level-state colours are 2.4-dev's, untouched.

## The rules (section 11 DRAWING, 2.4.1 lines 1659-1662, 1685-1732, 1749-1779)
1. **Interval packing, zero overlaps** `[MOB-PACK]`. Once per last bar: the visible levels are sorted by price; walking bottom-up each label is placed at its level, or at (label below + gap) when it would overlap. Gap = `mob_gap × 1H ATR`. Because every label is at least one gap above the previous one, no two labels overlap, by construction. Lines stay exactly on their prices; only the label plate slides up, never down, so a plate is always on or just above its line.
2. **Nearest-first text.** Distance rank to `close` (0 = nearest). Rank < `mob_near` (default 7): full 2.4-dev text — name (abbreviated with alias count when `Mobile: Compact Level Names` is on), control, state, price, `*` untested. Rank ≥ 7: `ABBR price`, ≤ 16 characters (longest: `PMoH 25123.50`, 13). The tooltip of an abbreviated label carries the full name, control, state and price.
3. **Right-edge anchoring.** Every mobile label is anchored at `bar_index + mob_off` (default 2 bars) with `label.style_label_left`, so the plate starts just right of the last candle and reads into the right margin; there is no horizontal stagger (2.4-dev's `stack × 7` bars pushed the 4th colliding label 27+ bars out, off a 428 pt screen). Lines end at `bar_index + mob_ext` (12 bars). Both are bar counts, so they hold at any zoom on 1m / 5m / 15m: the pixel distance is bars × bar width, which the app keeps similar across timeframes at the default zoom. Pine cannot read the app's right-margin width, so the one thing Mac sets once on the phone: Chart settings → Scales → **Right margin ≥ 20 bars** (the plates are ~110-170 pt wide at `small`; 20 bars ≈ 160-220 pt at the default 5m zoom). With a narrower margin the app clips the plate at the price axis; nothing is ever drawn under the axis itself.
4. **Line weights** `[MOB-W]`: rank < 7 → 2 px; others 1 px; the in-play level keeps 2.4-dev's 3 px violet; monthly levels (MO, MH, ML, PMO, PMoH, PMoL) dotted, like the rolling opens; untested levels dashed as before.
5. **Colours** `[BG]`: the label plate follows `chart.bg_color` (luminance > 140 ⇒ dark-grey `#263238` plate so the bright state text keeps ≥ 4.5:1, else 2.4-dev's `#060B14`; v2.4.1's near-white plate was withdrawn on review). Text colours = the level-state colours, unchanged in both themes.
6. **Objects** stay pooled: 27 lines + 1 halo, 27 labels + 12 event glyphs, allocated once at `barstate.isfirst`. The packing uses two local arrays per last bar, no drawings.
7. **Nothing desktop-only.** The mobile board (3 columns, `mob_rows` 5, `mob_ev` 4) is 2.4-dev's and unchanged.

## Exact constants
| Input (group Dashboard) | Default | Range | What it is |
|---|---|---|---|
| `mob_near` Mobile: Full Labels (nearest N) | 7 | 2-12 | full-text + 2 px set |
| `mob_gap` Mobile: Label Gap (x 1H ATR) | 0.11 | 0.03-0.40 | packing gap; 0.11 × 50 pt ATR = 5.5 pt ≈ 14 px ≈ one `small` plate on a portrait 5m MNQ chart showing ~200 pt over ~520 px (2.6 px/pt) |
| `mob_off` Mobile: Label Offset (bars) | 2 | 1-10 | plate anchor right of the last candle |
| `mob_ext` Mobile: Extend Right (bars) | 12 | 2-60 | line end right of the last candle |
| luminance cut | 140 / 255 | fixed | light vs dark plate |
Uncertainty: the gap-to-pixel mapping assumes the visible range above; with the chart zoomed out (≥ 400 pt visible) plates are ~7 px apart in price terms and may touch — raise `mob_gap` to 0.16-0.20; zoomed in (≤ 100 pt), labels sit a little above their lines — lower it to 0.06.

## Before / after, 5m MNQ, portrait 428 pt (what Mac should see)
Example board, price 25,120 at 07:45 PT, 1H ATR 50: PDH 25,180 · PWH 25,172 · MH 25,176 · Asia High 25,150 · 4H Open 25,131 · 30m Open 25,123 · 1H Open 25,118 · VWAP 25,112 · 06:30 Open 25,104 · IB Low 25,096 · London Low 25,084 · PDL 25,060 · Week Open 25,020 · PWL 24,980 · MO 24,900 (others off-screen).

**Before (2.4-dev, Mobile Mode ON):** every level carries the full text, e.g. `PDH  BUY  RESIST  25180.00`, at `bar_index + 6`; PDH / MH / PWH sit within 8 pt (0.16 ATR) so they stagger to +6, +13, +20 bars: the third plate starts ~160 pt right of the last candle and is clipped by the price axis; `4H Open` / `30m Open` / `1H Open` (13 pt apart, 0.26 ATR > 0.18) do not stagger and their plates overlap each other vertically (a `small` plate is ~5.5 pt tall here, the lines are 5-8 pt apart with the text 2.4-dev's full width). Width: weekly 3 px, daily 2 px, session 1 px regardless of distance; a dark plate on a light chart.

**After (2.4.1, Mobile Mode ON), bottom-up:**
- `MO 24900.00` — 1 px dotted, short plate (rank 14).
- `PWL 24980.00` — 1 px, short (rank 13).
- `WO 25020.00` — 1 px, short (rank 12).
- `PDL 25060.00` — 1 px, short (rank 11).
- `LL 25084.00` — 1 px, short (rank 7, 36 pt away).
- `IBL  BUY  SUPPORT  25096.00` — 2 px, full (rank 5, 24 pt); plate at 25,096 (12 pt above LL: no move).
- `NYO  SELL  SUPPORT  25104.00` — 2 px, full (rank 4); plate at 25,104 (8 pt ≥ 5.5 gap: no move).
- `VW  SELL  TESTING  25112.00` — 2 px, full (rank 2); plate at 25,112 (8 pt gap, no move).
- `1HO  BUY  SUPPORT  25118.00` — 2 px, full (rank 0, 2 pt); plate at 25,118 (6 pt, no move).
- `30O  ->SELL  TESTING  25123.00` — 2 px, full (rank 1); 5 pt above 1HO < 5.5 ⇒ plate slides to **25,123.5**; line stays at 25,123.
- `4HO  BUY  RESIST  25131.00` — 2 px, full (rank 3); 7.5 pt above the 30O plate ⇒ stays at 25,131.
- `AH  BUY  RESIST  25150.00` — 2 px, full (rank 6, 30 pt).
- `PWH 25172.00` — 1 px, short (rank 8, 52 pt); plate at 25,172.
- `MH 25176.00` — 1 px dotted, short (rank 9); 4 pt above PWH ⇒ plate slides to **25,177.5**.
- `PDH 25180.00` — 1 px, short (rank 10, 60 pt); 2.5 pt above the MH plate ⇒ slides to **25,183.0**.
All plates start 2 bars right of the last candle, in one column, each at least 5.5 pt (≈ 14 px) above the one below: 15 labels, zero overlaps, the 7 nearest in full text and 2 px lines, the far ones a short code and price that still read at 428 pt. On a light chart the plates are dark grey (#263238) so the same bright state colours keep ≥ 4.5:1 contrast.

**Landscape 926 × 428:** the same column; the vertical range shown is smaller, so more labels pack (slide up) — the stack keeps its order and reads top-down like the ladder. `mob_near` = 7 still fits.

**390 pt (iPhone 13/14):** identical behaviour; a full `small` plate (~150 pt) plus a 20-bar margin fits with ~60 pt spare.

Limits: no device or compiler on this desk; the pixel figures are derived from the app's default 5m zoom and TradingView's `small` label metrics, not measured. Mac's first look on the phone decides `mob_gap`.
