# Levels PRO basis: v2.4-dev (Mac, 11/05)

Mac: "We're also reverting back to 2.4 dev as I liked that version better than our current. The labels were better and it was easier to see the levels when trading intraday. This is now our basis for any improvements you decide to make."

- `LevelsPRO-v2.4-dev.pine` is the file Mac supplied (10/21 LEVELS + FIXES build on the 10/20 PARITY build), unchanged. sha256 in SHA256SUMS.
- v2.5 through v2.8 are superseded as the basis. Anything carried forward from them must earn its place one item at a time, with Mac's go, and must keep 2.4-dev's label style and level visibility.
- Rulings that still apply to any successor: PWC = last trade (Mac 11/02, option A); level-state colours are sacred (Mac 11/01); no notifications from the chart (Mac 11/01); compiled-token estimate ≤ 70,000 with a counter calibrated on known data; runtime index-guard scan before every paste; parity with the bot's level registry (`lib/levelsPro.js`).
