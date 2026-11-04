# Levels PRO v2.8 ALIGNMENT MAP: the chart vs the TIDE bot (MacLevels, 11/04)

**Base.** v2.7.4 (`levels274/LevelsPRO-v2.7.4.pine`, 3,033 lines). The desk board's last Levels PRO entries are v2.7.2 (sent) and v2.7.3 (sent, "PWC = last trade"). v2.7.4 sits beside them with no install receipt. **Assumed installed: v2.7.3 or v2.7.4.** They differ only in the Mobile-Mode tag text, so v2.8 builds on v2.7.4.

**Ground truth.** The bot's code, not the spec text:
- `tide/v2/pkg-live/bot/lib/structure.js` r3.2: `S:<line>` below;
- `lib/tideWire.js` r2.5-live: `W:<line>`;
- `lib/moneyRule.js`: `M:<line>`;
- `SPEC-TIDE-r2` rulings 1-16.

Where the brief and the code disagree, the code wins:
- Zone sources in the code are `board` / `or` / `eq` / `round` (S:278-296). Swings are not zones. 1H / 4H swings, the 1H range edges and the 4H period extremes appear only as **TP pools** (S:988-991).
- The open wait is applied twice, one bar apart:
  - the engine counts the bars that open in the first 30 min of the 4H or session (S:374-380);
  - the wire counts the bars that close in the first 30 min after each open (W:109-115).
  - The chart shades the union: open-1 min to open+30 min.

**Legend.**
- Computability:
  - **EXACT** = Pine computes it from chart data exactly as the engine does;
  - **APPROX** = close, but not identical (how and what differs is stated);
  - **NO** = not computable on a chart.
- Verdict: KEEP / CHANGE / REMOVE / ADD.
- **"behind OLD"** = kept, but only drawn when the new input `Old model (r13.x, manage-only)` is ON (default OFF).

## 1. What v2.7.4 draws or labels today

| # | v2.7.4 item (section) | Meaning in the OLD model (lv1 r13.x levels path) | TIDE equivalent | Verdict |
|---|---|---|---|---|
| 1 | 20-level registry lines: PDH/PDL/PDC, Daily Open, Asia/London H/L, 06:30/15:00 Opens, IB H/L, VWAP, 4H/1H/30m(/15m) Opens, PWH/PWL, Week Open (§4-5, §11) | Every level the old path could trade, coloured by control | Only 4H Open, PDH, PDL, Asia H/L (after Asia), London H/L (after London), 1H Open, the ORs and EQH/EQL are TIDE zones (S:278-291). The rest are context for the bias score. | **KEEP** lines and colours (Mac's look). **CHANGE**: a TIDE zone gets its TIDE state on its tag; the other levels say nothing TIDE. |
| 2 | Weekly / monthly / quarterly bot HTF levels (§16H) | Old path's levelEvent htfLevels | Not TIDE levels, and not TIDE pools (S:983-991 has none) | **KEEP** (knowledge tier), tooltip "not a TIDE level" |
| 3 | Per-level control BUY/SELL/->BUY/NEW/DIST and line colour (§7) | Old-model control per level | None. TIDE control is one 4H direction, not per level. | **KEEP** colours (look); state text **behind OLD** |
| 4 | Per-level behaviour SWEEP/FAIL/ACCEPT/RECLAIM/REJECT/CHOP/TESTING (§7, labels) | Old classifier (chart TF bars, confirm 3, accept 12) | TIDE states on closed 5m bars: watching / broken / accepted / failed / armed / retest-pending / rejected / cancelled / expired (S:482-547, S:769-822) | **CHANGE**: TIDE zones show TIDE states; the old behaviour text goes **behind OLD** |
| 5 | SWEPT tag (v2.7, §16 tags) | A level crossed and back within confirm bars | Not a TIDE term; closest is TIDE `failed`. | **KEEP** (Mac ruling 11/02) on non-TIDE levels and when OLD is on. On a TIDE zone the TIDE state replaces it (no double tag). |
| 6 | Heat bands "levels stacked here" (§16J) | Context (stacking) | Context: TIDE's TRAP point (S:835-836) uses stacked obvious pools | **KEEP** unchanged |
| 7 | Decision chip STAND DOWN / WAIT / SET / ARMED + meter (§16I, HUD row 0) | Mirror of the OLD entry gates: alignment 15m/1H/4H, control ±0.22, run ≤ 60.5 pts | TIDE: control, zone state, setup, gates | **CHANGE**: same words, colours and meter, driven by TIDE (§3 below) |
| 8 | SET countdown "3m/5m close m:ss" (v2.7 F3) | Time to the bot's 3m/5m trigger candles | TIDE decides breaks/acceptance/failure/shift on the 5m close and the rejection on the 1m close (S:1044, S:793) | **CHANGE** target: "5m close m:ss" while a zone is broken / failed; "1m close m:ss" when retest-pending. Same look. |
| 9 | Glow on the ARMED level (§16I) | Old ARMED | TIDE retest-pending level | **KEEP** look; it lights on the TIDE level |
| 10 | Wake candles (quiet bars in STAND DOWN) | Old STAND DOWN | TIDE STAND DOWN | **KEEP**, TIDE-driven |
| 11 | Trade plan LONG/SHORT, entry/stop/target, FILL NOW, ORDER TO PLACE, grade, SCALP LONG/SHORT (§10 + triggers) | Old structural entry model | TIDE plan: entry = 1m rejection close, structural stop (S:924-940), TP1/TP2 from pools (M:254-275) | **behind OLD** (still computed). TIDE plan **ADD** (§2.6) |
| 12 | 24 alerts (§14) | Old model events | TIDE events | Old alerts gated by the OLD input (they do not fire when OFF). **ADD** 4 TIDE alerts. |
| 13 | HUD rows DEST / GPS / CTRL score (§16 board) | Old context: weekly + 4H, 1H + 15m, chart score vs 0.22 | TIDE: 4H control (trap/bias), 1H state, gates | **CHANGE**: row 1 = TIDE 4H control, row 2 = 1H state + mid band, row 3 = CTRL (bias 15m / 30m vs TIDE's 0.15 line) |
| 14 | Full board (desktop, §13): BIAS, TF ALIGN, OPEN POS, DRIVER, TAPE, PLAN | Old model reads | Context | **KEEP** (Full detail only); PLAN rows **behind OLD** |
| 15 | PARITY + EVENTS hidden tables, STALE badge (§15, 4,475 source / 16,511 inline tokens) | Machine-readable old-model parity vs bot r9-r13 | None: the old path is manage-only. TIDE parity is measured offline (PARITY.md). | **REMOVE** the code (budget: see §4). Its 6 inputs stay declared (unused, "retired") so Mac's saved settings keep their positions. PWC (`p_pwc`) and SWEPT (`SW_ON`/`SW_T`) move out of it, unchanged. |
| 16 | In-play halo, dashed = untested, colour by control (§11) | Old in-play pick | Context | **KEEP** |
| 17 | PWC = last trade (v2.7.3), price on tags (v2.7.2 / v2.7.4), slim mode, vivid look | Mac rulings | Same | **KEEP** unchanged |

## 2. TIDE concepts the chart lacks today (all ADD)

| # | TIDE concept | Engine source | On the chart | Computability |
|---|---|---|---|---|
| 2.1 | **Zones by source**: board (4H Open, PDH, PDL, Asia H/L outside Asia, London H/L outside London, 1H Open), OR (4H / Asia / London / NY OR high/low, 30 min), EQH/EQL (≥ 2 confirmed 5m pivots within 2 pts over 24 h, gone once a 5m bar closes beyond), Round (every 50 within ±400) | S:274-345 | A zone band (level ±2, merged ≤ 14 wide) on the TIDE zones, with a source letter on the tag: `B` board / `OR` / `EQ`. Rounds drawn faint as `R ctx`, tooltip "context, never a target or setup (r3.2)". | **EXACT** from 1m bars. Board values = the same levels Pine computes (PDH/PDL/Asia/London = the bot's levelsPro rules; 4H Open = the 15:00-anchored 4H bucket, S:185). |
| 2.2 | **4H control**: TRAP (failed break of the 4H-Open zone after the 30-min wait; holds until its extreme is taken back or the 4H closes, never flipped by an opposite trap) or BIAS (price on its side of O4 + forming 15m/30m score past 0.15 for 3 readings; replaced by any trap at once) | S:443-479, rulings 1 / 14 | HUD row "4H ▼ TRAP 28,511 since 15:30" / "4H ▲ BIAS since 07:42" / "4H none (wait 07:30)". The trap extreme is drawn as a thin line. | Trap: **EXACT** (price only). Bias kind: **APPROX**. The bias score is the bot's levelsPro biasScore on the forming 15m / 30m candle; v2.8 ports it into the TIDE step (tide_setups.py LevelsPro, itself within 0.0005 median of the JS). It differs by the TradingView vs bot VWAP-5m build and by warm-up length. Labelled "≈" on the chart. |
| 2.3 | **1H market state** TREND / RANGE / TRANSITION, from confirmed 1H pivots (2/2); RANGE needs ≥ 2 touches each side within 0.5·ATR(1H) over 48 h; **unknown** until 2 swing highs and 2 swing lows exist (fail-closed: not-mid-range fails) | S:592-613, S:895-898, ruling 6 | HUD row "1H RANGE 27,980-28,240" + a faint **mid band** box (middle 50 %) while RANGE; "1H unknown (warm-up)" while not known | **EXACT** (needs ~2 days of 1m history on the chart for the pivots to exist; until then it says unknown, as the bot does) |
| 2.4 | **Setup state per level**, in the r1.3 contract words: watching / broken / accepted / failed / armed / retest-pending / rejected / cancelled / expired, with the lane (failed-break / accepted-break) and direction | S:482-547 (5m: break, accept, fail), S:616-676 (shift, arm), S:726-749 (accepted arm), S:769-822 (1m: bounce, retest, rejection, cancel, expire) | On each TIDE zone's tag: e.g. `4HO B · failed ▼`, `PDL B · retest-pending ▲ 1m 0:41`. Cancel / expire reasons in the tooltip. | **EXACT** on the 1m bars, except one coupling: an entered setup blocks the same direction (OPEN_TRADE / ONE_IDEA, S:657-661, S:733-736) until the bot's virtual trade ends (W:338-353). The chart runs the same virtual trade (stop / TP1→BE / TP2 / ladder / 13:05). It treats a rejection as entered only when the chart-visible gates pass; it cannot see the grade or news gates (NO), so that blocking is **APPROX**. |
| 2.5 | **First retest used** (counted per break, ruling 3) and **one trade per zone per 4H** (S:654-656) | S:765-768, S:902, S:911 | `R1` / `R2✕` on the tag (R2 = RETEST_2_SKIP, FIRST_RETEST_USED); `1/4H used` in the tooltip | **EXACT** |
| 2.6 | **TP pools / the plan**: TP1 = first internal pool strictly before TP2 and ≤ 1R, else 1R (takes 2/3); after TP1 the stop goes to BE + 1 tick; R-ladder; TP2 = nearest pool ≥ 2R (A+ = next major), else 2R; rounds never targets; board PDH/PDL added as majors (W:262-267) | S:980-1001, M:254-275, M:399-405, ruling 9 | For the active setup only: pooled lines E / SL / TP1 / TP2 with names (`TP1 1H swing low 28,350`). On `armed`: reference stop only (entry = level, stop = sweep extreme ± 2, as MacLive's board, labelled "ref"). On `rejected`: the engine's numbers. | Pools and stop: **EXACT** given the setup. TP2's A+ variant needs the grade (bias + volume points), which is **APPROX**, so both TP2 choices are shown when they differ (tooltip). |
| 2.7 | **TIDE time blocks** 15:00-17:00 and 06:30-07:10 PT (ruling 11/16, W:24, W:105) and **open wait** 30 min after 15:00 / 00:00 / 06:30 PT and each 4H open (S:374-380, W:109-115) | as cited | Background shading, Mac's palette, very faint: block = darker, open wait = lighter. Code TIME_BLOCK / OPEN_WAIT in the tag tooltip. | **EXACT** (PT clock). Early-close dates: **NO** (holiday calendar). |
| 2.8 | **12:55 no-entry and 13:05 flat** (ruling 8) | executor sessionNoEntryFromPt / sessionFlattenPt; W:360 | Two vertical lines on today (12:55 dashed, 13:05 solid), labels "TIDE no entry" / "flat". SESSION_CLOSE shading 12:55-15:00. | **EXACT** on normal days; early-close days **NO** |
| 2.9 | **blockedBy** codes ROUND_NUMBER, MID_RANGE, TIME_BLOCK, OPEN_WAIT, AGAINST_CONTROL, FIRST_RETEST_USED, SESSION_CLOSE, NEWS_WAIT | contract r1.3; the engine gates S:911-916, S:946-951 | In each TIDE tag's tooltip, the same codes and words as the phone | All **EXACT** except NEWS_WAIT (**NO**: economic calendar, Topstep lock; the tooltip says "news pause not visible on the chart") and AGAINST_CONTROL when control is bias-kind (**APPROX**, from 2.2) |
| 2.10 | **Shift / displacement**, the failed-break trigger (full body ≥ 50 %, 5m pending to the 15m close without displacement) | S:616-635 | `shift ✓ 5m 15:30 disp` in the tooltip of a failed zone, and the broken swing as a short dotted line | **EXACT** |
| 2.11 | **Grade** (A+/B/C) and size | S:79-101, S:422-440; W:149-199 | Not drawn. The tooltip lists the chart-visible points (trap stacked, force, timing) and says "grade = the bot's (needs its bias + volume)". | **APPROX** (points that need the bias are approx; volume is TradingView's). Never shown as the bot's grade. |
| 2.12 | **The bot's broker state**: position, fills, real stop, TP1 done, desync, pause, news lock | executor | Not drawn | **NO** |

## 3. The chip, in TIDE terms (same words, colours, meter and debounce as v2.7.4)

| Chip | When (TIDE) | Line 2 |
|---|---|---|
| STAND DOWN | No 4H control yet, OR the nearest TIDE zone's direction is against control, OR a global block (TIME_BLOCK / OPEN_WAIT / SESSION_CLOSE / unknown 1H range) | the reason code, e.g. `OPEN_WAIT 4H+12` |
| WAIT | Control known; zones watching / broken / accepted / failed (no setup yet) | `5m close m:ss` while broken or failed |
| SET | A setup is `armed` in the control direction (waiting for its first retest) | `armed ▼ 4HO, retest ≤ 6 pts` |
| ARMED (glow) | The setup is `retest-pending` (first retest seen, the 1m rejection close fires it) | `1m close m:ss` |

The meter counts TIDE gates met:
1. control;
2. lane trigger;
3. not mid-range / known;
4. first retest + no time block.

## 4. Budget and limits (the reason for item 15)

- **v2.7.4 tokens.** Source 23,097, inline model 38,848. That is about **74.8k compiled on k_linear**, against TradingView's limit of 80,000. About 1,600 source tokens are free.
- **TIDE port.** It needs about 4,500-5,500 source tokens: zones, 5m/1m state machines, control, 1H state, bias port, pools, drawing. Removing §15 frees 4,475 source and 16,511 inline tokens.
- **v2.8 target.** At most the v2.7.4 numbers (k_linear ≤ 75k).
- **Requests.**
  - +1: `request.security_lower_tf(…, "1", …)` (one tuple call, 1m intrabars), so the engine runs on 1m bars on any 1m-60m chart.
  - −2: §15's two W requests move into one shared call (PWO is already requested in §4b).
- **Drawing objects.**
  - Lines: +8 pooled (the trap extreme, broken swing, E/SL/TP1/TP2, 12:55/13:05).
  - Boxes: +2 pooled (the mid band, and the active zone band).
  - Labels: +0 (the TIDE text goes on the existing tags).
  - All inside max_lines 100 / boxes 50.
- **Loops.** Per 5m close, zones (~30) × sides × active eps (≤ 60). Per 1m, setups (≤ 6). The FVG scan is bounded to the setup's own bars.

## 5. Revisions after the checkpoint (MacArthur, 11/04)

1. **Two scripts (approved).** The faithful port measured 16.6k source tokens; one merged script would compile to about 96-116k, against TradingView's 80k. So items 7-10 and 13 (the chip, the countdown, the glow, the wake candles, the HUD rows) and all of §2 live in the companion Levels PRO TIDE v2.8. The main script keeps every line and tag. The companion never draws a level line: where both scripts show a level, the companion adds only the band and the state.
2. **The TIDE word sits on the zone band, not on the main tags.** The two scripts cannot share state. The tags in the main script show name, merge count, price and SWEPT. The band (companion) shows the TIDE state and codes.
3. **blockedBy codes, final r1.4:** ZONE_USED (`st.used` key, period|zone|kind|dir) and RETEST_NOT_FIRST (retest ≥ 2 of the same break) replace FIRST_RETEST_USED. `rejected` = done at the 1m rejection and never entered. MID_RANGE tests the setup level (or the zone price when there is no setup) against `state1h.midFrac`. The armed reference stop follows the engine's stop rule + stopBuf, and TP1 / TP2 stay empty until entered.
4. **Item 15:** PWC and SWEPT were kept byte-identical in form. The SW_ON block is v2.7.1's text, so the v2.7.1 SWEPT witness still finds it.
5. **The companion HUD** defaults to Bottom Left. Daily Levels PRO's own board offers no Bottom Left (its options are Middle Left, the default, Top Left, Top Center, Top Right, Middle Right and Bottom Right), so the two boards never overlap.
