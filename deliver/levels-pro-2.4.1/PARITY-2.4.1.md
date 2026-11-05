# PARITY 2.4.1 — Levels PRO v2.4.1 level set vs the bot's level registry

Sources: indicator `LevelsPRO-v2.4.1.pine` section 5 LEVEL REGISTRY (slots 0-26, unchanged from 2.4-dev); bot `lib/levelsPro.js` `LEVEL_DEFS` (20 levels, lines 62-81) and its level computation (lines 166-287); bot `lib/trendLane.js` r2 (the 5M references); bot `lib/structure.js` (TIDE zones, ORH/ORL). Prior rulings honoured: PWC = last trade (Mac 11/02 option A); `deliver/levels-pro-2.8/PARITY.md` measured the chart-built board (4H Open, 1H Open, PDH, PDL, Asia H/L, London H/L) at 100.00 % against the bot on 7,188 minutes — those definitions are the agreed ones and are the same code in 2.4-dev.

Both sides roll the trading day at the 15:00 PT CME session open (indicator `time("D", "America/Los_Angeles")`; bot `cme` roll). Both read HTF opens as the open of the period bar CONTAINING the current bar (indicator `request.security(…, open, lookahead_on)`; bot `bsearchOpenIndex` on the HTF bars).

| # | Indicator name (slot) | Bot name (levelsPro.js) | Price definition | Verdict |
|---|---|---|---|---|
| 0 | PDH | PDH | high of the previous completed trading day (15:00 PT roll), prior day rolled before the current bar is folded in ([FIX-PDH]) | MATCH |
| 1 | PDL | PDL | low, as above | MATCH |
| 2 | PDC | PDC | close of the last bar of the previous trading day (`close[1]` at the roll / `chartBars[i-1].c`) | MATCH |
| 3 | Daily Open | Daily Open | open of the bar that opens the trading day ([OPEN-EXACT]; bot `dayOpen = bar.o` on `newDay`) | MATCH |
| 4 | Asia High | Asia High | running high 15:00-00:00 PT while in session, then the kept value | MATCH |
| 5 | Asia Low | Asia Low | running low, as above | MATCH |
| 6 | London High | London High | running high 00:00-06:30 PT, then kept | MATCH |
| 7 | London Low | London Low | running low, as above | MATCH |
| 8 | 06:30 Open | 06:30 Open | open of the bar opening exactly at 06:30 PT (`time == ts0630`; bot exact-bar `is0630`) | MATCH |
| 9 | 15:00 Open | 15:00 Open | open of the bar opening exactly at 15:00 PT | MATCH |
| 10 | IB High | IB High | high 06:30-07:30 PT | MATCH |
| 11 | IB Low | IB Low | low 06:30-07:30 PT | MATCH |
| 12 | VWAP | VWAP | session VWAP (hlc3 × volume) from 06:30 PT | MATCH |
| 13 | 4H Open | 4H Open | open of the 4H bar containing the current bar (TradingView "240" / bot `htf.H4`) — the bot's "4H control level" (`st.period.O4`, trendLane `open4h`) | MATCH |
| 14 | 1H Open | 1H Open | open of the containing 1H bar | MATCH |
| 15 | 30m Open | 30m Open | open of the containing 30M bar — trendLane's primary reference `open30` | MATCH (trendLane spells it "30M Open" in its journal; the registry name is "30m Open" on both sides) |
| 16 | 15m Open | 15m Open | open of the containing 15M bar (indicator toggle `show_15o`, default OFF; bot `hide_sub` rule hides it on ≥ 15m charts the same way) | MATCH (visibility rule equal: `periodMin > tfMin`) |
| 17 | PWH | PWH | high of the previous completed W bar (`high[1]` on "W", lookahead_on / `htf.W[pwIdx].h`) | MATCH |
| 18 | PWL | PWL | low of the previous completed W bar | MATCH |
| 19 | Week Open | Week Open | open of the current W bar | MATCH |
| 20 | PWO | — | open of the previous completed W bar (`open[1]` on "W") | indicator only; the bot's registry has no PWO. Listed, not changed. |
| 21 | MO | — | open of the current M bar | indicator only |
| 22 | MH | — | month high through the last closed bar, from the exact month-start bar | indicator only |
| 23 | ML | — | month low, as above | indicator only |
| 24 | PMO | — | open of the previous M bar | indicator only |
| 25 | PMoH | — | high of the previous M bar | indicator only |
| 26 | PMoL | — | low of the previous M bar | indicator only |
| data | PWC_PRICE (PARITY table row, not drawn) | — | close of the previous completed W bar = the week's last trade (option A) | indicator data only; the bot's registry has no PWC level. No change. |
| — | — | TIDE zones (`st.zones`, structure.js) | engine-built zones; trendLane 5M references | bot only (TIDE engine; v2.8's companion ported it, not part of the 2.4 basis) |
| — | — | 15m swing high/low (trendLane `piv.m15`) | last confirmed 15m pivot within `swingBars` | bot only (not a board level) |
| — | — | ORH / ORL (structure.js) | opening-range high/low | bot only; the indicator's nearest equivalents are IB High / IB Low (06:30-07:30), a different window. Listed, not changed (no ruling that the chart should carry ORH/ORL). |
| — | — | quarterly open (QO, live-executor mention) | — | not in `LEVEL_DEFS`; not on the chart. Listed. |

Summary: **20 / 20 bot registry levels on the chart with the same name and definition; 0 indicator-side fixes needed.** 7 indicator-only levels (weekly/monthly extras from 10/21) and 4 bot-only references listed. The trendLane 5M reference set is "every level the bot tracks" = the 20 above + zones + 15m swing; the chart shows the 20.

Limit: this is a definition-level comparison read from source. The numeric minute-by-minute check (v2.8 PARITY.md: 100.00 % on the 8 board levels over 7,188 minutes) covered the same 2.4-dev computations and was not re-run here (no CPU-heavy work on this desk).
