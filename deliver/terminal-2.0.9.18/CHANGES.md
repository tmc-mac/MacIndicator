# Phone terminal 2.0.9.18 (preview): TIDE, the new model, on your phone

This is your 2.0.9.17 page plus TIDE. It changes the display only: the bot, its settings and your trades are not touched, and the page asks the server for nothing new (it only reads the journal from Now while a fill is missing; see section 6).

**When TIDE is off, the page is 2.0.9.17** (every screen on every test state compared). The one exception is the fill fix in section 6.

## 1. The TIDE card on Now (above the Hour card)
- **Mode, impossible to confuse:**
  - SHADOW is a violet ring ("phone pushes only · no orders");
  - LIVE is a filled green glowing badge ("orders ON · the old levels path takes no new entries").
  - The card's glowing edge takes the same colour.
- **4H CONTROL:** sellers ▼ or buyers ▲, since when, and the 15m / 30m bias. It also says why: "failed break above the 4H open · 4H open 28,414.00", or bias control.
- **STAGE rail:** wait for fail → armed → retest → entered, with the setup and level in words, for example "Asia High 28,284.25 trap: waiting for the defended retest".
- **LAST SIGNAL:**
  - side and grade badge (A+ gold, B cyan, C grey), with the 5 points as named chips (trap, force, volume, timing, impulse);
  - entry, stop (wick type, points), TP1 and TP2 with their pools;
  - the flat size and the grade size beside it, for example "flat $450: 1 MNQ · grade A+ $900: 3 MNQ (logged only)".
  - In shadow it is tagged SIMULATED.
- **TODAY:** signals, taken, open, and the closed R and $ ("SIM" in shadow). Buttons go to Checklist › and Trades ›.

## 2. The TIDE position (live)
- Side, size, grade and phase.
- **R and $ right now:** the bot's own $ when it sends it; otherwise "calc: 107.75 pts × 1 × $2".
- **A price ruler:** STOP, ENTRY, TP1 and TP2 on one line, with the live price dot. Profit is always to the right.
- **The stop:**
  - "✓ stop 28,366.50 acked · BE+1" only when the broker acked it;
  - otherwise, in amber, "asked …: not acked yet", or "stop NOT acked".
- TP1 hit → stop BE+1, TP2, the ladder, and how many times the stop moved.
- A re-entry is its own trade, never merged.
- In shadow, the open simulated trade shows its R only: the shadow does not write its BE / ladder moves until the exit, and the card says so.

## 3. Trades tab
- An **All / TIDE / Old path** filter.
- TIDE rows are tagged ‹TIDE› ‹grade› (‹SIM› in shadow), with the exit path: TP1→TP2, TP1→BE, STOP, LADDER, FLATTEN 13:05, NO-STOP FLATTEN.
- The $ on each row is the broker net, or "R × plan risk" for shadow trades.
- **The day:** TIDE P&L, with the old path shown apart. In shadow, the old path = the account day; in live, the account day minus TIDE's net. It reads UNKNOWN until every TIDE trade has its broker net.

## 4. TIDE alerts at the top of Now
- Stop rejected, no stop / naked flatten, a mode change.
- Red with a slow glow for the dangerous ones; amber for the others.
- They never block a tap. OK clears an alert on this phone, and the card keeps the day's log.

## 5. The checklist is TIDE's when TIDE is on
- The Checklist tab shows the new model, in the spec's order:
  - the 6 GRADE r3 gates;
  - the 5 points with the grade key;
  - the rules: time blocks, open wait 30 min, session close 12:55 / 13:05, news pause, one position at a time, size.
- Each row reads PASS / FAIL / WAITING / HOLDING / UNKNOWN from the bot's TIDE rows.
- "Show the old path checklist" brings back the old one. With TIDE off, the old checklist is the only one, as before.

## 6. The fill shows up as soon as the bot records it (your 23:51 screenshot)
- **The problem:** "3 ct · fill price and time UNKNOWN" and "entry ref · unverified" stayed on Now because the page read the bot's fill receipt only when you opened the Review tab.
- **Now:** while a live position has no observed fill, the page reads that same journal from Now, at most every 10 s, and stops once the fill is seen.
- The card switches to "@ price fill" in place, with no reload. In the test, the fill showed about 10 s after the bot wrote it.
- **The same goes for the duration line** ("since order sent · fill time unknown").
- **For TIDE trades,** the card reads the bot's own fields: fill price and time, the acked stop, TP1 / TP2 and the bot's $. A filled TIDE position shows no UNKNOWN.
- **While TIDE holds a position, a green banner on top of Now says so.** The bot's Position card covers the old path only and reads FLAT then.

## When TIDE is off: what is NOT identical
- **The Now tab with a live old-path position whose fill was not yet on the phone:** it now shows the observed fill (section 6) where 2.0.9.17 said UNKNOWN.
- **The requests:** the page makes extra reads of the journal it already reads on the Review tab, only during that window.
- **Everything else is identical.**

## One honest gap
The bot build running now does not put TIDE in its snapshot. The new live bot package does. Until it is installed:
- the card shows the mode from your config-local.json;
- it says **"TIDE details need bot update"**;
- every other TIDE value reads UNKNOWN.

Nothing is made up. The pushes on your phone still come.

## Same as before
The look, the colours, the tabs and the buttons are the same, and so is every request to the bot (except the fill read in section 6). Undo is one command (see the install sheet).
