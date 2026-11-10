# UNKNOWN audit: every place the page prints UNKNOWN, and why (bot: r13.3.5 Phase A, A47)

"Always" = on this bot today, whatever the market does. "When" = only in that condition. Each row has a fixture assertion in `tests/`.

| Surface | Field | Text on screen | Always / when | Reason | BOT-ASK |
|---|---|---|---|---|---|
| Header stamps | build stampId | UNKNOWN: no journal row read yet (the snapshot carries no stamp; open Review once) | When: until the Review tab has polled the journal on this phone | `/bias` carries no stamp; the page polls the journal only on Review | 1 |
| Header stamps | build stampId | struck through, "read N min ago · open Review to re-read" (STALE) | When: 120 s after the last journal row read | same | 1 |
| Header stamps | exe / cfg | UNKNOWN: not sent in the snapshot, and this stamp is not in the page's checked table | When: the bot runs any stamp other than 44382b7fcf62 | the hashes exist only in the `session_stamp` journal row, which the page never receives | 1 |
| Eval score | whole strip | UNKNOWN: accountBalance not sent / paper mode: no account balance / no snapshot | When | no balance, no claim | 2 |
| Eval score | room now + full stops | UNKNOWN: open P&L not sent while a position is open / the open trade's price mark is stale / open P&L mark is N old / position state not sent | When | room now must include the open trade or say nothing | - |
| Eval score | trailing drawdown (bot's figure) | UNKNOWN: remainingDrawdown not sent | When | - | - |
| Eval score | balance age | (not printed as UNKNOWN: the age line is the snapshot's) | Always | the balance has no timestamp of its own | 2 |
| Broker truth | broker read time | Broker read time: UNKNOWN: not sent, the age below is the snapshot's | Always | no broker timestamp in the snapshot | 3 |
| Broker truth | qty per protective order | qty UNKNOWN: not sent | Always (while in a trade) | markers carry label and price only | 3 |
| Broker truth | set time per order | set time UNKNOWN: not sent | When: the marker has no history entry | - | 3 |
| Broker truth | position | UNKNOWN: position not sent; side / qty / avg price not sent | When | - | 3 |
| Trade rows | exit reason | "market exit (no-progress, session close or manual: which one is not sent)" | Always for market exits | no exit-reason field | 4 |
| Trade rows | exit reason | UNKNOWN: exit reason not sent | When: the exit matches neither the stop nor TP1 and no market exit was recorded | derived only | 4 |
| Trade rows | gross, fees | UNKNOWN: gross not sent for this trade / needs gross | Always for trades older than the last 10 round trips, until Review has loaded the journal | gross is only on `recentTrades` and journal close rows | 5 |
| Trade rows | fill ids | "(fill ids not sent)" beside the round-trip link | Always | - | 5 |
| Trade rows | net | UNKNOWN: broker net not settled | When: a close row is not broker-settled yet | - | - |
| Trade rows | day breakdown / rows total | UNKNOWN: … breakdown withheld / … total withheld | When: the parts do not add up to the header figure to the cent | one day figure, or none | - |
| Trade rows | any row field | UNKNOWN: <field> not sent | When | per field | - |
| Gates | news pause | UNKNOWN: no calendar loaded (the pause cannot fire without one) | When: `news.count` is 0 or absent | the pause is fail-open without a calendar | 8 |
| Gates | all rows | struck through, "results below are old, not current" | When: the evaluation is older than 90 s (always while in a trade) | the bot does not evaluate entries while in a trade | 9 |
| Gates / verdict | card | UNKNOWN: current.checklist not sent | When | - | - |
| Full-stop alert | room | room: UNKNOWN: <the eval strip's reason> | When: room now is unknown | - | - |
| HTF cascade | a node | UNKNOWN: N min old / stale bar / no valid control read / open or price not sent | When: the gate read is older than 90 s (always while in a trade), or the slot is not CURRENT | a node that is not current shows no direction | 9 |
| HTF cascade | 30m | NOT READ: not read by this build's gate | Always | 30m is not a gate input on this bot | 7 |
| HTF cascade | card | UNKNOWN: alignSlots and controlDisplay not sent | When | - | - |
| Control receipts | bot last seen | not applied yet — bot last seen UNKNOWN: no snapshot | When: no snapshot at all 45 s after a send | - | - |
