# REVIEW REQUEST for MacDot: Levels PRO v2.8 (two scripts), MacLevels 11/04

**Goal (Mac).** "My daily levels pro indicator … needs to be aligned with our current bot perspective of the market." On the chart, Mac must see the levels, states and setups that the live TIDE bot acts on, and why it skips the others.

**Files** in `mac-lv1/levels280/`; the sha256s are in the hand-back:
- `LevelsPRO-v2.8.pine`: the main script = v2.7.4, minus section 15, with the old model behind an input;
- `LevelsPRO-TIDE-v2.8.pine`: the companion, the TIDE engine + its drawing;
- `ALIGNMENT-MAP.md`, `CHANGES.md`, `PARITY.md`, `INSTALL.txt`;
- `src/`: the companion's parts. `tools/build-main.py` and `tools/build-tide.py` rebuild both scripts byte for byte from v2.7.4 and `src/`. Every edit is a counted exact replacement.
- `parity/`: the harness (run instructions are in PARITY.md).

**Nothing was compiled.** There is no TradingView on the desk, so the TradingView compile governs. What was done instead:
1. The companion's engine text was **executed** by an interpreter (`tools/pinei2.py`, the v2.7 desk's pinei + UDTs / for-in / fields). It uses v5 semantics: `and` / `or` evaluate both sides; an out-of-range index, a field of an na object or string + na raises.
2. The **whole** companion script ran bar by bar over 11,333 replay bars (`parity/smoke-tide.py`).
3. A declaration-order and int-from-`/` static check ran on both scripts (`tools/ordercheck.py`; v2.7.4 passes it clean).

These found and fixed, before you:
- 6 eager-`and` index reads;
- 5 field reads of possibly-na objects;
- a function used before its definition (`t_bias`);
- an int assigned a float;
- a duplicate function name;
- the shadowing of the built-ins `open` / `vwap`.

## What to check, in priority order

### 1. Compile risk (please paste both scripts into an editor first)
- **UDTs** (`type`, `X.new`, field `:=` on a global `var` object from inside functions, `array<TSet>`, `for x in`). They should be valid v5, but this is the first Levels PRO to use them.
- **`request.security_lower_tf(syminfo.tickerid, "1", [time, open, high, low, close, volume])` on a 1m chart** (the same timeframe as the chart). I believe this returns one intrabar. If it errors on 1m, the fix is a ternary to the chart's own bar on 1m.
- **`bool` na from `t_mid()` (v5 allows na bools).** Also `str.format_time` and `alert()` inside an `if`.
- **Runtime / loop budget on load.** TIDE steps every 1m bar of the last `td_hist` = 3000 1m bars. Per bar: zones on the 5m close (about 30 members, insertion sorts), and the bias port runs 2 × 20 levels every minute. Please watch for "calculation takes too long" on a 1m chart. The setting can go down to 1500.

### 2. Faithfulness to the bot's code
Each ported rule cites its line: `S:` structure.js r3.2, `W:` tideWire.js r2.5, `M:` moneyRule.js. The harness compares the Pine text with the bot's own `structure.js` + the `tideWire` shadow loop (`createAdapter` copied with the state exposed; nothing changed in pkg-live).

In PARITY.md:
- **Mode A** (the bot's board + bias fed in) tests the ported logic.
- **Mode C** (the chart's own board + bias port) tests the chart as Mac will install it.

Spots worth a second pair of eyes:
- **The open wait is the union of two rules, one bar apart:**
  - the engine (`S:374-380`) blocks bars that open in the first 30 min;
  - the wire (`W:109-115`) blocks bars that close in them.

  The shading and the OPEN_WAIT code show both. The bot applies both, so the union is what it does.
- **The virtual trade (`t_vbar`) is the wire's `virtualBar`, with one simplification:** only the R-ladder part of `moneyRule.nextStop`. The 15m structural trail and the climax tighten are not ported, so a virtual trade can end later than the bot's. That moves only the OPEN_TRADE / ONE_IDEA blocking of later same-direction setups. Parity measured no case on the replay.
- **"Taken" in the chart = the shadow-mode rule with `flat: true`:**
  - plan fits (the $400 take1 ceiling: stop ≤ 200 pts);
  - no session close, no open wait, no TIDE block;
  - no TIDE trade open.

  The chart cannot see NOT_FLAT, NEWS_WAIT, PAUSED or DESYNCED.
- **Two signals in the same minute:** the engine sorts failed-break first, then gradeTotal. The chart has no grade total, so it takes the first failed-break. No case on the replay.

### 3. The board words (contract r1.4, MacLive's boardView)
`t_zs()` (section 17C) gives every zone a state, lane, direction and codes, by the r1.4 rules: ZONE_USED, RETEST_NOT_FIRST, MID_RANGE on the setup level, `rejected` = done and never entered. It reads `st.eps` by `key|side` (the r1.3 boardView bug (a) cannot happen here).

Please check that its priority matches MacLive's r1.4 build. The priority is:

> armed / retest-pending > failed > broken / accepted > the last setup's rejected / cancelled / expired > watching

### 4. Display and Mac's rulings
In the main script, check that with "Old model" OFF:
- the tags still show the name, merge count, price (v2.7.2 / v2.7.4) and SWEPT (v2.7.1 SW_ON block, byte-identical in form);
- the heat bands are unchanged;
- the levels / colours / lines are byte-unchanged.

The diff vs v2.7.4 is small. Apart from the removed section 15 and the moved alerts, it is about 25 added lines.

In the companion:
- it never draws a level line;
- its HUD defaults to Bottom Left (the main board has no Bottom Left);
- the wake candles are its own (the main's are off with Old model OFF).

## Known approximations (labelled on the chart)

| Item | What differs | Measured |
|---|---|---|
| Bias score ≈ (bias-kind 4H control, the wave-bias gate) | ported levelsPro on the chart's 1m bars; the bot warms on 2000 closed 15m bars and reads TradingView's W levels | 0.0000 / 0.0001 median vs the bot's study readings (PARITY.md) |
| TP2 on A+ trades | the chart does not compute the grade: TP2 = the nearest pool ≥ 2R; the bot's A+ = the next major pool | 0 of 40 signals differed (mode A) |
| TP2 vs history depth | TP2 can use older 1H / 4H swing pools (the last 8 / 6) that only one side holds | 2 of 40 in mode C (the chart run started 4 days earlier); 0 of 19 with the default 3000-bar warm-up |
| Virtual trade end | the R-ladder only (no 15m structural trail / climax tighten) | 0 differences on the replay |
| NEWS_WAIT, early-close days, NOT_FLAT, broker | not visible on a chart | n/a |
| Warm-up | a chart loads `td_hist` 1m bars; the 1H state needs 2 swing highs and lows | PARITY.md warm-up rows |

## Findings for MacLive (already relayed)
- r1.3 boardView: (a) the eps key (fixed in r1.3 91e59920); (b) MID_RANGE on the price; (c) FIRST_RETEST_USED semantics; (d) "rejected" never emitted. (b)-(d) are queued for r1.4. v2.8 follows the engine on all four.

## Still open (not run: a bot rig held the box at hand-back)
- **Main regression, differential: `parity/witness-diff.sh`** (nice 19; it waits for no rig and load < 4; about 5 min). It runs the v2.7.1 SWEPT and heat witnesses on v2.7.4 and on v2.8 and diffs their output. Expected: identical, with Old model OFF, for the SWEPT / heat parts.
  - The witnesses report FAIL on v2.7.4 itself: their expected tag strings predate v2.7.2's price on the tags. So only the differential is meaningful, not their verdict.
  - Their copies in `tools/w271/` change only the section ranges, because section 14 moved to the end in v2.8.
- `parity/*.jsonl` (about 37 MB) are run outputs. They are not needed in the repo; rerun them from PARITY.md.
