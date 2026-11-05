# UNKNOWN audit — phone terminal 2.0.9.25 (MacUI-D, 11/05)

`grep -o "UNKNOWN…|not recorded|unavailable|undetermined"` over the built page: 300 occurrences of UNKNOWN, 11 of "not recorded", 7 of "unavailable", 1 of "undetermined". Most are code paths, comments or the Robot Brain's own vocabulary; the ones a trader can meet on screen are listed below with their fate in this build.

## Resolved in 2.0.9.25 (a field the r1.6.1 bot sends, or a figure the page can compute)
| Where | Text (2.0.9.24) | 2.0.9.25 |
|---|---|---|
| Review money line | `gross (bot)` + "net pending: n trips not yet tagged" | `net (from fills)`: Σ over the TradeDay's closed bot records of realizedUsd / netUsd, else Σ(exit − entry) × qty × dir × $2 − fees (feat-20924's records). Stays "gross (bot)" only when a closed trade has no exit fill. |
| Header pill (warm-up) | `TIDE LIVE` / page's `⊗ Blocked` while rebuilding | `WARMING UP` (neutral) from tide.warm.rebuilding / doneMin < totalMin. |
| Day P&L cell | `balance +$712.65 · differs by −$504.29` (clipped) | `balance +$712.65 · −$504.29 vs fills` in full; one figure (dayPnlNet / account.dayNet) on the header AND the Rolling P&L card. |
| Trades tiles / day cards | old /trade-list + /trade-stats only ("closed today: none yet" with 7 TIDE trades) | the merged set: bot records (tide.rows signal / setup_arm / live_* + tide.trades) ∪ unmatched account round trips, by TradeDay (15:00 PT); tiles This TradeDay (= the header figure) · Closed · Win / loss by R (±0.1R even) · Open (tide.position). |
| TIDE card | (no line) | `LAST REJECT 12:23 entry SELL 2x rejected: market halted` from tide.lastReject, else the newest order_reject row. |
| Decision card | STEP 1–3 chips only | Mac's 11 rows from trend_arm / trend_signal / trend_skip / trend_idle (dirEv.prev4h, open4h, h30.open30 / last30, R / rName / trigger / def / why), the next 30M close from the clock. |

## Left, labelled with the reason (the bot does not send it, or no fill exists)
| Where | Text | Why it stays |
|---|---|---|
| Decision card, r1.5.6 snapshot | "no trend-lane rows in this snapshot: this bot build sends none" | the trend lane ships in r1.6; an older bot has no rows to read. |
| Decision card rows 2–4, 6 | "not sent" | the idle row carries no dirEv / h30 (the bot journals them on arm / signal rows only); with no arm the 30M open is not in the snapshot. |
| Decision card row 7 | "unknown: no 30M candle sent" | as above: harmony needs h30.last30 or an idle why. |
| Trade row (feat-20924) | "qty UNKNOWN: no fill in the journal" | no live_fill row and no tide.trades fill for the record. |
| Trade row (feat-20924) | "pts UNKNOWN: no fill price" / "R UNKNOWN: no stop on the plan" | the fills carry no price / the plan row has no stop. |
| Account box | "account fill · not matched to a bot record" | a broker round trip the bot did not place (or no id / time match). |
| Day P&L cell | "UNKNOWN: no dayPnlNet / account.dayNet in the snapshot" | a snapshot without either field (pre-r1.6 bot). |
| Review (live, old bot) | "UNKNOWN: the snapshot has no tide.trades (needs the r1.2+ bot)" | field absent before r1.2. |
| Review, sim mode | "a simulated exit has no $ (R or plan risk missing)" | a shadow trade without a plan risk. |
| Review open card | "the bot has not computed the open $" | tide.position.openUsd absent. |
| Levels (old-path trade) | "not recorded" (level of an old-path trade) | the old journal never wrote the level; the TIDE record line (feat-20924) replaces it when the trade is matched. |
| Checklist / Robot Brain | the Brain's UNKNOWN neurons and "the checklist reader … is not on this page" | the Brain's own fail-closed vocabulary (2.0.9.8 truth fixes), untouched. |
| Control tab | "unavailable" (cancel-entry / retry wording) | the page's own control-path texts (r133), untouched: they describe the bot's answer, not a missing field. |

## Not audited
Texts inside the Why? dumps and the signal-row text are the bot's own words and were left as sent.
