# Levels PRO v2.8: changes from v2.7.4

**Base.** v2.7.4 was built on 11/03 but never installed; v2.7.3 is the last version sent to Mac. v2.7.4 differs from v2.7.3 only in one thing: in Mobile Mode the price is always on the level label. Upgrading from v2.7.3 therefore also brings that change.

**v2.8 is two scripts.** TradingView refuses a script above 80,000 compiled tokens. Merged into one script, the TIDE engine came out at about 96-116k. MacArthur approved the split on 11/04.

| Script | Job |
|---|---|
| **Daily Levels PRO v2.8** (`LevelsPRO-v2.8.pine`) | Mac's levels, as in v2.7.4 |
| **Levels PRO TIDE v2.8** (`LevelsPRO-TIDE-v2.8.pine`) | The bot's TIDE view of those levels |

## Daily Levels PRO v2.8 (main)

**Unchanged from v2.7.4:**
- every level and its value, the engine, the line colours, widths and styles;
- the tags, prices on the tags, SWEPT, the heat bands, PWC = last trade, slim mode / Full detail, Mobile Mode;
- all requests and every saved setting.

**Changes:**
1. **New input "Old model (r13.x, manage-only)", default OFF.** Its group is "Old model (v2.8)", and it is declared after every v2.7.4 input, so saved settings keep their places. With it OFF, which is the v2.8 view:
   - the tags no longer carry the old per-level CTRL / behaviour words. They show the level name, the merge count, the price and SWEPT, as Mac ruled on 11/02;
   - in Full detail the level labels read name (+ price, + `*` while untested) instead of `CTRL / behaviour`;
   - the old Ignition gate mirror is not drawn: the chip and its board, the glow and the wake candles;
   - the 24 old alerts never fire.

   With it ON, everything is exactly v2.7.4. Ruling 16: the bot takes no old-path entries when TIDE is live.
2. **Section 15 removed:** the PARITY / EVENTS machine-readable tables and the STALE badge, which mirrored the old model.
   - Its 6 inputs stay declared and unused (group "PARITY (retired in v2.8: unused)"), so input positions do not move.
   - Two of its pieces stay, byte for byte:
     - PWC = the week's last trade (v2.7.3);
     - the SWEPT read SW_ON / SW_T (v2.7.1).
   - One W request fewer (`open[1]`, PWO data only).
3. **Section 14 (alerts) moved to the end of the script**, so it can read the new input. Each old alert is `old_on and (<its v2.7.4 condition>)`. The titles and messages are unchanged.
4. **Header and title:** "Daily Levels PRO v2.8", short title "LVL 2.8".

**Tokens** (the v2.7 desk's tokcount model; the TradingView compile governs):
- Source: 23,097 → 18,949.
- Inline model: 38,848 → 21,485.
- Estimated compiled: about 61.4k (k_linear) / 37.4k (k_inline), down from 74.8k / 67.6k.

## Levels PRO TIDE v2.8 (new companion overlay)

**Section 17: the TIDE engine, a line-by-line port.**
- The sources:
  - `lib/structure.js` r3.2 (sha16 2a2249f1), cited as `S:n`;
  - the shadow / live wiring of `lib/tideWire.js` r2.5 (`W:n`);
  - the exits of `lib/moneyRule.js` (`M:n`).
- It runs on the closed 1m bars of the chart (one `request.security_lower_tf "1"`), the bot's own input, on any 1m-60m chart.
- What it computes:
  - the board (4H Open, PDH/PDL, Asia/London H/L, 1H Open), built by the bot's levelsPro rules;
  - the 5m / 15m / 1H / 4H aggregation;
  - the zones (board / OR / EQH-EQL, plus Rounds as context);
  - breaks, acceptance and failure on the 5m close;
  - the internal shift with displacement (5m, pending to the 15m);
  - failed-break and accepted-break setups;
  - the first retest per break with a 1m counter-move bounce;
  - the 1m rejection;
  - the emit gates: one per zone, open wait, climax, need shift, and GRADE r3's required gates;
  - the structural stop;
  - TP1 / TP2 from the pools (rounds never targets; PDH/PDL added as majors as the wire does);
  - the wire's virtual trade (stop, TP1 → BE+1, TP2, the R-ladder, 13:05 flat), which ends the engine's open setups as the shadow loop does;
  - 4H control: trap or bias, the trap holding (ruling 1);
  - the 1H TREND / RANGE / TRANSITION state with the mid band;
  - the open wait, TIDE's blocks and the session close.

**17B: the bias score ≈.**
- This is the bot's levelsPro biasScore on the forming 15m and 30m candle, ported from `tide/study/tide_setups.py`.
- It uses the 20-level board, VWAP 5m build, H1 ATR Wilder with the forming hour, and the hide_sub rule.
- It is labelled "≈" everywhere.

**17C: each zone in the snapshot contract r1.4 words** (the same rules as MacLive's `snapshot.tide.board` r1.4):
- **State:** watching / broken / accepted / failed / armed / retest-pending / rejected / cancelled / expired, with the lane and the direction.
- **blockedBy codes:** ROUND_NUMBER, MID_RANGE (the setup level against the mid band), TIME_BLOCK, OPEN_WAIT, SESSION_CLOSE, AGAINST_CONTROL, ZONE_USED, RETEST_NOT_FIRST. NEWS_WAIT cannot be seen from a chart.

**17D-17E: the drawings** (display only). This script never draws a level line; Daily Levels PRO keeps every line and tag.
- **Zone bands**, the 10 TIDE zones nearest price, each labelled with name, source letter, state, arrow, R1 / R2 and the codes.
- **Rounds:** the 2 above and 2 below, labelled "R 28400 ctx · never a target".
- **The 1H RANGE mid band:** "no TIDE entry (MID_RANGE)".
- **The 4H TRAP extreme**, labelled with its holding rule.
- **The plan:**
  - on a signal, the engine's E / SL / TP1 2/3 / TP2, for an hour or while the virtual trade is open;
  - on an armed setup, the reference E and SL only (contract r1.4).
- **Shading:** TIDE's blocks (15:00-17:00, 06:30-07:10) darker; the open waits (the union of the engine's and the wire's minute, see the map) lighter; the 12:55-15:00 session close amber.
- **The 12:55 and 13:05 lines** for the session in play.

**17F: the chip, the glow and the wake candles** (the v2.6 / v2.7 look and debounce):

| Chip | When |
|---|---|
| STAND DOWN | no control, against control, a block, open wait, session close, or the 1H range unknown |
| WAIT | control known, nothing armed |
| SET | a setup armed |
| ARMED + glow | retest-pending |

- The meter counts 4 TIDE gates.
- The SET countdown now counts to TIDE's own candles: the 5m close while a zone is broken / accepted / failed, the 1m close while retest-pending.
- **HUD rows:**
  - 4H control, e.g. `4H ▼ TRAP 28511 · 15:30` or `4H ▲ BIAS≈ · 07:42`;
  - the 1H state;
  - `CTRL≈ 15m / 30m`.
- **Default position Bottom Left.** Daily Levels PRO's board offers no Bottom Left, so the two boards never overlap.

**17G: 4 alerts** (TIDE CONTROL, TIDE SETUP ARMED, TIDE RETEST, TIDE TRIGGER) and one dynamic `alert()` for the trigger. The bot pushes only signals, so only the trigger uses its push words ("TIDE LIVE (chart view) SHORT @… stop … TP1 … TP2 …").

**Tokens:**
- Source: 17,624.
- Inline model: 32,356.
- Estimated compiled: about 57.1k (k_linear) / 56.3k (k_inline).

**Requests:** 4 security calls (1H ATR, 3 weekly) plus 1 security_lower_tf.

**Drawing limits:** max lines 20 (5 used), labels 20 (2 used), boxes 40 (20 used).

## Not changed on purpose

- The bot's packages: they were read, never touched.
- The old model: it stays computed in the main script, only hidden.
- Mac's palette (`col_buy` / `col_sell` / `col_amber` / `col_viol`, the board tokens).
