# Phone terminal 2.1.0-rc1 (mobile.html sha256 c56ce29de1d2c91f42ebf3fe603fb6bc5cd98f3a69107f12c0dd921f4d74a536)

Display only. Base: 2.0.9.10 (ca093989, Mac's installed page) plus two insertions (one style block, one script block) and 22 formatter
rewrites at build time (src/clock-sources-2101.cjs). The page sends exactly the same requests as 2.0.9.10 (gate 13/14: IDENTICAL).

## What Mac gets
- Every clock in page text is 12-hour PT, all tabs, Robot Brain text and the chart time axis included (formatted at the source, no DOM rewriter in replay).
- Header: build stamp / executor / settings hash (UNKNOWN when the bot does not report them).
- Eval card: room incl. open P&L; day P&L labelled "realized" when open P&L is UNKNOWN. Eval and Broker truth read the position from one source; disagreement = UNKNOWN on both.
- Trade rows: pts/contract, R, worst excursion, exit, event, level, gross/fees/net; exit labelled "avg" for multi-fill exits and always consistent with pts/contract.
- "Can the bot enter now?" verdict + gate list; switched-off checks read OFF and never count as passing.
- HTF cascade view.
- Danger-zone receipts on all 4 controls: SENT -> APPLIED / FAILED / NOT APPLIED YET (bot last seen N ago) / amber "ENTRY FILLED before the cancel" / "already paused until X" /
  "already flat". Same handlers, endpoints and two-tap confirm as 2.0.9.10; the hold-to-arm prototype is removed (proven unable to send).
- Full-stop banner + browser notification (page open only; a push with the page closed needs the bot).

## Gate on these exact bytes (gate/GATE-LOG.txt)
| suite | result |
|---|---|
| surfaces (updated for OFF rows) | 235 / 0 |
| HTF cascade (updated: off-screen card stays still) | 1030 / 0 |
| control receipts (updated: "filled" is amber) | 319 / 0 |
| QA findings 1-9 (painted) | 66 / 0 |
| budgets 360/390/428 x dark/light x 7 tabs | 912 / 0 |
| Control identity vs 2.0.9.10 | 92 / 0 |
| requests vs 2.0.9.10 and vs live r13.3 | IDENTICAL |
| cascade perf | 12 / 0 |
| QA receipts + adversarial scenarios | pass |
| **replay smoothness A/B vs 2.0.9.10 (1x and 4x CPU)** | **27 / 1** |

The one open item: at 4x CPU throttle the chart replay drew 16 candle shapes vs the reference's 17 in one pair (frame-gap and long-task limits passed).
Testing was stopped by Mac at 05:28Z before a rerun; it is reported, not waived.

## Not in this build
- Bot-side fields (see BOT-ASKS.md / UNKNOWN-AUDIT.md); the bot-fix package (desk B) adds them.
- Receipts do not survive a page reload; APPLIED = the bot's snapshot shows the effect, not a broker confirmation.
