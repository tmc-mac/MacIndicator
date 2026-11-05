# Independent review — phone terminal 2.0.9.25 candidate (MacQC-UI-25, 22:01–22:11Z 11/05)
Page 871fada5, SHA256SUMS 30/30 OK. 5 fixtures × 390/428 px × dark/light × 6 tabs. FACT = seen in the rendered DOM/screenshots; GUESS marked.

VERDICT: HOLD. The page still shows several different day-P&L figures for one account on one screen, "UNKNOWN (no $ sent)" and "net pending" sit next to rows that state the $ from fills, and the package's own CHANGES says DRAFT, NOT SEALED.

## BLOCKERS
- B1 One P&L number is not one (FACT, t24-tide1105 / t25-taken / t25-pnl). Header +$587.78; Rolling +$587.78; Trades tile +$587.78; old day card "+$587.78 broker day net · 4 closed"; NEW day card "+$706.00 · 4 trades"; Review "+$706.00 net (from fills)"; Position-and-risk "gross +$587.78 · net +$575.58 · balance +$716.09 (differs +$140.51)"; Rolling "Day peak +$716.09 · Given back +$0.00"; Sessions boxes "$0.00 · 0 trades" above "4 trades today · day net +$587.78"; Review stats "Strategy +$0.00 + other +$716.09 = account +$716.09", "No closed trades in this window". On t25-pnl: header +$1,216.94, new card/Review +$706.00, dropdown "+$587.78, differs by −$629.16", stats "account +$712.65". Expected: dayPnlNet on every card, the balance only as the one sub-line. (+$706.00 is the before-fees per-row sum. Witness J1 accepts any $ on Review, T5 only checks the tile; the cross-card disagreement was never asserted.)
- B2 Review per-trade cards still say pending/UNKNOWN beside known figures (FACT): "Result +3.38R · UNKNOWN gross (bot) · net UNKNOWN … net pending: no broker round trip is tagged" two lines above "LEVEL 4H Open 28,430.50 · trap · 2 lots · +78.50 pts · +$314.00 fills, before fees · broker net +$309.26". "Stop UNKNOWN" on S437/S425 while the LEVEL line shows the stop. "size planned UNKNOWN" beside "4 lots". Review headline is a before-fees sum labelled net. Ruling: net from fills, never pending.
- B3 Duplicate trade rows on Trades (FACT): the four 11/05 trades appear in the MACMILLIONZ BOT TRADES box + account box AND again in the new "Tue, Nov 3 +$706.00" card. Two day cards for one TradeDay with different totals; dedupe checks only `.tl-day` cards, the fx23 card is not one. An empty "No trades yet" shell remains under the new card.
- B4 Bare UNKNOWN $ next to known $ (FACT, Trades and Now): "MacMillionz today +3.81R UNKNOWN (no $ sent) 3 closed"; each row "UNKNOWN (no $ sent) net not reconciled yet" above "+$314.00 fills · broker net +$309.26"; Now rows keep orange "Level: not recorded" above "LEVEL 4H Open 28,430.50". t23-trade: "+1.52R" headline vs "+0.76R" LEVEL line for one trade.
- B5 Trades tiles contradict (FACT): "This TradeDay +$587.78" with "closed today: none yet", next to "Closed 4"; at 390 "Win / loss 3 / 0" clipped (3 px), Open tile wraps to a second row.
- B6 Day P&L header cell clipped at 390 AND 428, both themes (FACT): "MacMillionz Bot · Day P..." and "balance +$712.65 · −$..." — the lines the INSTALL sheet tells Mac to read cannot be read. Witness P2 asserts textContent, not painted width (r20925.css nowrap + ellipsis hides the overflow).
- B7 Wrong label on the money card (FACT): "includes a <delta> non-trading adjustment (payout/reset)" prints whenever day.rolling ≠ dayPnlNet. qc154-pos: "+$48.00 non-trading adjustment" where $48 is the open position's P&L; t23-trade: "−$411.68 non-trading adjustment" when the balance field is 0.
- B8 Package not sealed by its own account (FACT): CHANGES "DRAFT, NOT SEALED"; gate/ and shots/ empty; X1 red; sanity walk not done.

## SHOULD FIX
- S1 Levels tab "No positions since the bot started today" with 4 closed trades on the page.
- S2 Review decisions: "Fill ? @ ? journal live_fill" on all 9 fill rows, no reason.
- S3 Now LAST SIGNAL "size UNKNOWN (no plan.qty on the row) · grade size: not on this row" while rows show the 1-lot fill; code names as reasons.
- S4 Position-and-risk: "SESSION_CLOSE" code chip; calls the broker-net sum "gross" and subtracts fees again; three different reconciliation deltas on one page.
- S5 Warm-up: header pill WARMING UP right, but the MacMillionz card pill still "● LIVE".
- S6 Brand pass garbles sentences: "From MacMillionz (tide.rules, tide.board), the model the bot trades."
- S7 New day card rows: exits line larger than the meta line, rows use ~2/3 of the width.
- S8 Day P&L dropdown lists "12:29 SHORT 3 @ 26,886.25" while every row says 1 lot.

## NOTES
- N1 Fixtures mix two price regimes (armed "1H Open 28,628.25 · 1,878.25 above price"; "4H CONTROL OPEN 26,812.75" vs STEP 1 "4H control 28,813.75"). GUESS: the card reads the 4H open from two sources (trend rows vs board) and will contradict itself live when they differ.
- N2 Old-path "Live Signal: BUYERS IN CONTROL" beside "4H CONTROL SELLERS" (pre-existing).
- N3 Decision rows "30M OPEN not sent", "HARMONY unknown: no 30M candle sent": UNKNOWN with a reason, acceptable.

## VERIFIED
SHA256SUMS 30/30; feat-20925.js (c9fa4f8b) embedded byte-for-byte; INSTALL hashes match; 0 console errors and 0 sideways scroll in 26 contexts × 6 tabs; no user-visible "TIDE" outside Why?/signal dumps; WARMING UP pill on t23-warm, no "Blocked"; header = Rolling figure on every fixture; trade rows carry level · kind · lots · pts · $ · R · exits; decision card shows Mac's 11 rows in order; identity vs 2.0.9.24 on TIDE-off states IDENTICAL ×7 (the builder's DIFF was a poll-state artefact); vivid style unchanged.
