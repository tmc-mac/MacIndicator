# Phone terminal 2.0.9.23 — what changes against 2.0.9.22 (8b92d047)

Display only. The page sends the same requests as 2.0.9.22 (poll paths unchanged: `/bias?symbol=…&key=…` is the snapshot, `/trade-list?symbol=&limit=200&key=`, `/trade-stats?symbol=&key=`, `/signal-journal?symbol=&limit=100[&filter=]&key=`; buttons `/pause`, `/flatten`, `/cancel-entry`, `/trade-why`, `/trade-blocks`, `/trade-journal-download` as before). Built by MacUI-B (11/05, 20:44Z) from MacUI-A's 2.0.9.23 inputs (`build-inputs/`: build-20923.cjs, feat-20918-r23.js, feat-20919-r23.js, feat-20920-r23.js, feat-20923.js, r20923.css); the rest of the chain is 2.0.9.22's. Page sha256 fc752789f60bdf28f015ece2a41bbce9cb03a4b29d21185509789472fdc12fc8 (build ID 8091373e).

## 1. ONE P&L (Mac 11/05: "There's not 2 different bots running, it should be MacMillionz Bot P&L")
- Header Day P&L cell: one number = the bot's broker day net (`dayPnlNet`; r1.6 `account.dayNet` first when present), sub-line `MacMillionz Bot · Day P&L · closed trades only · n trades`. When the TopstepX balance figure (`day.rolling` / r1.6 `account.balanceDelta`) differs by more than $1: a muted `balance +$716.09 · differs by −$300.51`. The page's own balance-change number in that cell is hidden while TIDE is on. No `TIDE $x · Old $y`, no `TIDE closed 0`.
- Trades tab: the day card reads `MacMillionz Bot day net +$1,016.60 · broker (dayPnlNet) · closed trades only`; today's card is `MACMILLIONZ BOT · <TradeDay>` with the broker day net, `n closed · n contract-sides`, `MacMillionz Bot · n trades`, the balance line, and the rows without a TIDE / UNTAGGED tag (an r1.6 `account.fills` row the bot itself marks `manual` keeps a MANUAL tag). The row filter reads All / Bot journal / Account (was All / TIDE / Old path).
- Review: the money figure is the broker day net (`+$1,016.60`, `MacMillionz Bot · broker day net`), never a bare `$0.00` or "no TIDE trade closed today"; with r1.6 `tide.day.trades` the journal's own closed net shows with its counts.
- Sessions today (Now): the plain line reads `MacMillionz Bot · 6 trades today · day net +$1,016.60 · by entry time: Asia 0 · London 4 · NY 2` (no "not placed by the bot", no "n bot · n manual").
- Witness (qc-20923 P1 P2 D1 D2 D3 D4 D5 E1 on fixture t23-pnl1105: dayPnlNet 1016.60 / balance 716.09): one headline, no split text in the DOM.

## 2. Warm-up state (MacUI-A, kept)
Header `TIDE warming up · n of 360 min` (`tide.warm`, else `tide.live` false); the TIDE card's warm-up line; Review's 4H control says `journal empty: warm-up in progress`, the counts' source line says the tape is rebuilding; never "no control read today" (W1–W3, W5, W6 on t23-warm and t23-warm156).

## 3. Hour Wave → the three-step decision card (MacUI-A, kept)
The TREND LANE card in the Hour card's slot: verdict (STAND DOWN / WAIT / GET READY / ACT + reason), STEP 1 DIRECTIONAL STRUCTURE (`tide.board.htf`), STEP 2 30M HARMONY and STEP 3 5M EXECUTION (r1.6 `trend_*` rows; on r1.5.6 the chips read NOT IN THIS BUILD), the Hour card's own content folded under "Candle detail". L1–L5 pass. Review gets the trend counts from `tide.day` (T3). Grade is a size tag with neutral chips, not a FAIL tile (G1, G3).

## 4. Small
Every UNKNOWN on the TIDE surfaces names its field (U1 passes on this page). Closed TIDE trade cards (Review, Trades) carry a `▶ Show on Levels` button that opens the trade on Levels. `macui.pageVersion`, copies and exports say 2.0.9.23.

## Not in this build (left for 2.0.9.24)
- Trade rows resolved to the TIDE record (Level "4H Open 28,430.50 · trap", qty from fills, pts, R, exits per row; "account fill, not matched to a bot record"): not started. Recent Trades / Trades rows still carry the old-list tags (orange UNKNOWN chips show on the t23-pnl1105 rows).
- TIDE journal P&L on Review computed from fills (realizedUsd / entry-exit × qty × $2 − fees): the money line uses the broker day net instead.
- HTF tag lines H1–H7: partly in (H1 H2 H4 H6 pass, H3 H5 H7 fail; H7 = an UNKNOWN shows when the r1.5.5 bot sends no HTF fields).
- One-tap journal replay with markers (R3–R6): the button only opens the trade on Levels.
- The Sessions boxes' own $ figures (Asia / London / NY) still come from the page's TIDE-tagged split and read $0.00 on the 11/05 fixture; the plain line under them carries the single set of trades by entry time. Needs the row-matching item above.
- Known console error: `<rect> attribute width: A negative value` on the lane fixture t23-standdown (the tape box; cosmetic, the card renders). Not seen on t23-pnl1105, qc154/155, tide21-leak or mac1814.

## Gate (MacUI-B, 11/05 20:44–20:47Z, one browser at nice 19, logs in `gate/`, shots in `shots/`)
- qc-20923 (MacUI-A's witness, P/D wording updated to ONE P&L): **60 passed, 6 failed** — E1 (the rect console error above), R2–R6 (the replay tap, not in this build; R2 only because the button now says "Show on Levels").
- qc-20922 on the .23 page: **26 passed, 3 failed** (H3, H5, H7; .22 itself had 22/7).
- feat-20922: **26 passed, 1 failed** (V1 expects pageVersion 2.0.9.22; the page says 2.0.9.23).
- plan-leak-20921: **15 passed, 1 failed** (N3: the Levels flat line now reads `TIDE scanning · 4H ▼ sellers … · lane: wait · not in this build` instead of "TIDE: nothing armed / Flat, no plan at a level"; no plan line is drawn — MacUI-A's feat-20920-r23 wording).
- no-sideways: **64 passed, 0 failed**. shot-20920 (qc155-flat, qc154-pos, tide21-leak, mac1814 × dark/light): OK, 0 errors. shot-tabs-20923 (t23-pnl1105 Now/Trades/Levels/Review × dark/light at 390): OK, sideways 0, errors 0.
- identity vs 2.0.9.22 (TIDE-off states, identity-20918 pattern): **started 20:47Z, not finished at seal** (~13 min run); result lands in `gate/30-identity-vs-2.0.9.22.txt` in the scratchpad gate23 folder. Design note: with TIDE off feat-20923 / r23 scripts return before touching the DOM, same as .22's inputs.
- An earlier run on the first .23 build (7b834372, before the "Show on Levels" relabel and the test-wording fixes) is in `gate/run1-7b834372/`.
- Not run: replay, a physical iPhone, the Mac-box memory run (display-only page).

## Ship note (MacArthur, 11/05 ~13:00 PT)
Sent to Mac at his order ("HURRY") with the identity-vs-2.0.9.22 run still in progress: 19 TIDE-off states IDENTICAL x7 at send time; the differing states are the by-design TIDE-on fixtures (qc154-*, qc155-*, qc156-htf) and r1333stop, whose only difference is the Control tab's Reason sentence ("Neither side has fired — MAC: no input (levels only) | Levels: …" vs "Neither side has fired. Levels: …"), a wording change in feat-20920-r23, no plan or state change. The finished identity log is added in the next commit. Not in this build (next, 2.0.9.24): trade rows matched to TIDE records (level, qty, pts, R, exits), journal P&L from fills, H3/H5/H7, replay tap.
Identity vs 2.0.9.22 finished 21:04Z: 34 states IDENTICAL x7; the 17 that differ are the TIDE-on fixtures (qc154-*, qc155-*, qc156-htf, t23-*, tide21-leak: the .23 items by design) and r1333stop (Control tab Reason wording only, see above). Log: gate/30-identity-vs-2.0.9.22.txt.
