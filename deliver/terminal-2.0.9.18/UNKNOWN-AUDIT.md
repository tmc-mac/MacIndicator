# UNKNOWN audit: terminal 2.0.9.18 (Now / Position / Trades / TIDE)

Rule: every value is recomputed from the newest snapshot and journal rows on each render. Nothing caches an UNKNOWN; the Position card is redrawn every second.

| where | text shown | resolved by (exact field) | flips when | 2.0.9.18 change |
|---|---|---|---|---|
| Position card + header cell (old path) | "fill price and time UNKNOWN", "entry ref · unverified …(recorded, not a fill)" | `journal_receipt` row, `status FILL_OBSERVED`, matched by `journalId` / `decisionId` = `levels.trade.open.journalId`; `averagePrice` + `recordedAt` (MacFillReceipt rule) | The receipt reaches the phone in `/signal-journal` | **Fixed.** 2.0.9.17 read the journal only on the Review tab, so on Now this UNKNOWN stayed until Mac opened Review. 2.0.9.18 reads the same route from Now while a LIVE position has no observed fill (≤ 1 read per 10 s, stops once the fill is observed). Witness: the fill shows about 10 s after the receipt is written, with no reload. |
| Position card "Duration … since order sent · fill time unknown" | same | same receipt's `recordedAt` | same | same fix |
| Position card size "n ct" | plan size vs broker | `recentTrades[]` open trip (`closed:false`) `maxSize − exitSize` | every snapshot | — (already live) |
| Position card entry ref value | broker trip average, labelled unverified (MacDot #5 ruling) | `recentTrades[]` open trip `entryAvgPrice`, else the entry marker | every snapshot | **Not changed.** Promoting the open trip average to "broker average" overrides a reviewed ruling, so that is the reviewer's call. The snapshot does carry it. |
| Unrealized | "(bot)" figure | `openPnl` (LIVE) | every snapshot | — |
| Trades tab rows (2.0.9.12) | "pts UNKNOWN · awaiting broker fills", "duration UNKNOWN", "Level: not recorded" | `recentTrades[]` reconciled trip (`whyJournalId`, `entryAvgPrice`, `exitPrice`, `netPnl`, entry / exit times); the level = the trade journal's level field | The trip is reconciled | — (2.0.9.12 rules) |
| TIDE card, partial | "TIDE details need bot update" + every TIDE value UNKNOWN | `snapshot.tide` (bot r1.2 `tideSnapshotView`) | The first snapshot with `tide` | — |
| TIDE position | fill / avgEntry / stop acked / TP1 / TP2 / $ | `tide.position.avgEntry`, `fillAt`, `stopAcked`, `tp1{price,qty,done,filled}`, `tp2{price,done,filled}`, `openUsd`, `lastPx` | every snapshot | **Mapped to the bot's real r1.2 shape** (nested TP, `stopBy 'break-even'`). `pointValue` is derived from `symbol` (MNQ 2); `stopHist` is not shown when absent. A filled view() position shows NO UNKNOWN (witness T10, F7). |
| TIDE trades | $ | `tide.trades[].netUsd`, else `grossUsd` (labelled "gross: the net is not reconciled yet") | Net reconciled | **New**: gross is shown while the net is null |
| TIDE checklist rules | Time blocks / Open wait / Size limit | `tide.rules.useTimeBlocks`, `rules.blocks`, `rules.openWaitMin`, `tide.sizing.take1MaxUsd` (all in r1.2) | every snapshot | — |
| TIDE checklist gates | WAITING / UNKNOWN | `tide.rows` grade_live / grade_no_trade / signal rows | each graded setup | — |

## Still UNKNOWN until the bot changes
1. **The fill on the old-path Position card can still lag by up to about 10 s plus the bot's receipt write.** For zero lag, the bot can put the receipt in the snapshot: for example `levels.trade.open.fill = { avgPx, t, orderId }` (the FILL_OBSERVED fields), which the phone would read at once.
2. **The old-path header during a live TIDE position.** `snapshot.position` (`getDisplayMarkers`, FSM) and `openPnl` describe the old path only. The FSM is FLAT while tideLive holds the TIDE position, so the header and Position card read **FLAT / $0** while the TIDE card shows the open TIDE trade. The bot (or the next phone release) should merge them. Not changed in 2.0.9.18.
3. `recentTrades[].model='tide'`: until it lands, no trip is shown as TIDE on the old trade list. The TIDE list comes only from `tide.trades`.
