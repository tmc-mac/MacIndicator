# PARITY: Levels PRO TIDE v2.8 (the Pine text) vs the bot's TIDE code, on the same 1m bars

## What is compared

**Engine side (ground truth): `parity/engine-dump.cjs`.** It runs the bot's own `pkg-live/bot/lib/structure.js` r3.2 through `tideWire.js` `shadowStep()`, the shadow loop with its virtual trades, which feed back into the engine.
- The adapter is a verbatim copy of `createAdapter` (W:282-301) that exposes the state. pkg-live was only read.
- `tide.mode "shadow"`, `useTimeBlocks true` (TIDE's own blocks), `money` = `moneyDefaults()` (flat $400, take1 ≤ $400).
- Session: 12:55 no entry, 13:05 flatten.
- Board and bias: `tide/study/readings.csv`, the bot's levelsPro port, the same loader as `tide/v2/review/witness-r3engine.cjs`.
- Each minute it writes: the 4H control, the 1H state, O4, the zone set, and each zone's state in the r1.4 board words, with codes.

**Chart side: `parity/pine-run.py`.** It **executes the Pine text of `LevelsPRO-TIDE-v2.8.pine` itself**:
- the engine section between the `TIDE ENGINE BEGIN` and `TIDE DISPLAY BEGIN` markers;
- through `tools/pinei2.py`, with v5 semantics (`and` / `or` evaluate both sides; an index or na-field error raises);
- one `t_step()` per closed 1m bar.

The view is read through the script's own `t_zs()`.
- **Mode A:** the bot's board + bias readings are fed in. This tests the ported logic.
- **Mode C:** the chart as installed. It uses its own board (built from the 1m bars), its own bias port (17B, W levels from the d1-built weeks) and its own warm-up.

**Data.** `replay1104/data/m1.json`: 11,333 1m bars, 10-22 13:55 → 11-03 20:47 PT. Readings run 10-27 15:01 → 11-03 19:48 PT. Full sessions: 10-28, 10-29, 11-02.

**Compare: `parity/compare.py`,** minute by minute over the readings window.

## Results

All figures below are on the **final bytes** (companion sha256 `0d1c9336eba6d38b…`, file dated 09:32Z, measured 09:50-10:50Z). Window: 10-27 15:01 → 11-03 19:48 PT, **7,188 minutes**, 3 full sessions + 4 partial ones. "Zone state" counts zone-minutes: every non-round zone present on both sides, every minute.

| Item | Mode A: the logic (the bot's board + bias fed in) | Mode C: the chart as installed |
|---|---|---|
| 4H control (dir + trap/bias + trap extreme) | 7,188 / 7,188 = **100.00 %** | 7,188 / 7,188 = **100.00 %** |
| 4H Open (period O4) | 100.00 % | 100.00 % |
| 1H state (TREND / RANGE / TRANSITION, range hi / lo, known) | 100.00 % | 100.00 % |
| Zone set (key, lo, hi, source) | 100.00 % | 100.00 % |
| Round-number zones (count) | 100.00 % | 100.00 % |
| Zone state, r1.4 words (state + dir + lane) | 75,284 / 75,284 = **100.00 %** | 75,284 / 75,284 = **100.00 %** |
| ... of which not "watching" | 25,903 / 25,903 = 100.00 % | 25,903 / 25,903 = 100.00 % |
| blockedBy codes from engine state (MID_RANGE, AGAINST_CONTROL, ZONE_USED, RETEST_NOT_FIRST) | 75,284 / 75,284 = 100.00 % | 75,284 / 75,284 = 100.00 % |
| Signals: same minute + direction | 40 / 40 | 40 / 40 |
| Signals: identical entry, stop, TP1, TP2, taken | **40 / 40** | **38 / 40** (see below) |

The time-based codes (TIME_BLOCK, OPEN_WAIT, SESSION_CLOSE) are pure PT-clock functions of the minute, cited to W:24 / W:105 / W:109-115 / S:374-380. They are identical by construction and are not counted above.

**The two mode-C signal differences are TP2 only:**
- 10-28 16:38 SHORT: engine TP2 29,288.75 (PDL), chart 29,411.50.
- 10-29 15:40 SHORT: engine TP2 29,070.50, chart 29,027.25.

Entry, stop, TP1 and "taken" are identical. Both signals were not taken (TIME_BLOCK / OPEN_WAIT).

The cause is **history depth, not an approximation**:
- The mode-C chart run starts 4 days earlier (10-22) than the engine run (10-26 15:00), so it holds older 1H / 4H swing pools (S:988-989 keep the last 8 / 6). One of them is the nearer pool at or beyond 2R.
- With the same start (mode A), the same signals are identical, 40 / 40.
- On a live chart, TP2 can likewise differ from the bot's when the chart's history (`td_hist`) and the bot's (its process lifetime + 2000-bar warm-up) hold different swing pools.

**The bias score ≈ (17B) vs the bot's readings (mode C, 7,188 minutes):**

| | median abs. diff | p90 | max | sign agrees |
|---|---|---|---|---|
| 15m | 0.0000 | 0.0015 | 0.0130 | 99.97 % |
| 30m | 0.0001 | 0.0007 | 0.0124 | 99.93 % |

- Both on the same side of TIDE's 0.15 line (−, inside, +): **99.83 %** of minutes.
- The reference is `tide/study/readings.csv`. That is the bot's levelsPro biasScore on the forming 15m / 30m, computed by `tide_setups.py` (whose own check against the JS is median 0.0005, max 0.0287), on the same replay bars, with the same d1-built weekly levels.
- **What this does not measure:**
  - TradingView's own W bars (the chart) vs the bot's weekly levels;
  - the bot's 2000-bar 15m warm-up vs the chart's `td_hist`;
  - live feed differences.

  Despite the 0.17 % of minutes on different sides of the line, bias-kind control matched 100 % (it needs 3 readings in a row).

**The board** the chart builds from 1m bars (4H Open, 1H Open, PDH, PDL, Asia H/L, London H/L) vs the bot's board: **8 × 7,188 / 7,188 = 100.00 %**.

**Warm-up as the chart loads it** (mode C started only `td_hist` = 3000 1m bars before the window, the default):

| Window | Minutes | Control, 1H state, zones, zone states, codes | Signals identical |
|---|---|---|---|
| 10-29 15:01 → 10-30 13:00 PT (16,079 zone-minutes) | 1,320 | 100.00 % each | 8 / 8 |
| 11-02 15:01 → 11-03 19:48 PT (16,313 zone-minutes) | 1,668 | 100.00 % each | 11 / 11 |

## Runtime smoke (the whole companion script)

`parity/smoke-tide.py` executed **every global statement** of the final companion bar by bar over all **11,333** replay bars: the engine loop, the focus, the chip debounce, the drawings, the HUD and the alerts. It reported **no runtime error** (index, na field, string + na, substring). The alert conditions fired 969 times.

Snapshots (`parity/smoke.txt`) show what the chart would draw. 11/03, the playbook §3 witness:

| Time (PT) | HUD | Bands / plan |
|---|---|---|
| 16:05 | `STAND DOWN / TIME_BLOCK`, `4H ▼ TRAP 28511.00 · 15:39`, `1H TREND ▲` | `4H Open B · retest-pending▼ R1 ✕ TIME_BLOCK`; ref E 28,414 / ref SL 28,513 |
| 16:09 | (as above) | `TIDE E 28366.75 SHORT TIME_BLOCK`, SL 28,513, TP1 2/3 28,324.50, TP2 28,035.25 (PDL) |

At 16:09 the stop is above the 28,511 failed-breakout extreme (4H type). This matches the playbook's expected short at about 16:08 near 28,367. The chip says why the bot does not take it (TIDE's own 15:00-17:00 block, ruling 11).

Earlier runs of the smoke found 2 real runtime bugs (an na-object field read in the plan block; a duplicate function name). The order check found 1 more (a function used before its definition). All are fixed in these bytes.

## How to rerun (nice 19, one process at a time; about 3 min each)
```
cd mac-lv1/levels280/parity
node engine-dump.cjs <pkg-live/bot/lib> <replay1104/data/m1.json> <tide/study/readings.csv> engine.jsonl
python3 -I pine-run.py ../LevelsPRO-TIDE-v2.8.pine <m1.json> <readings.csv> <d1.json> C pineC.jsonl   # A = the logic only
WARM_BEFORE='11-02 15:00' python3 -I pine-run.py ... C pineW2.jsonl
python3 -I compare.py engine.jsonl pineC.jsonl "10-27 15:01" "11-03 19:48" --diff 5
python3 -I biascmp.py pineC.jsonl <readings.csv>
python3 -I smoke-tide.py ../LevelsPRO-TIDE-v2.8.pine <m1.json> <d1.json> smoke.txt '11-03 16:09'
```
