# Terminal 2.2 review (mobile.html sha256 768134e8…, unchanged after my runs)

## Verdict: SEND 2.2.

The controls are untouched, a hostile office file cannot execute anything or reach outside its card, the real file's numbers are shown correctly, and the 30m node behaves as Mac ruled. Four small faults, none about a live order or position, are listed for 2.2.1. One thing for the head agent to confirm before sending: the office file address (A5).

## A. Safety of the controls: CLEAN

1. **Diff 2.1.3 → 2.2 is 12 hunks** (`page-213-22.diff`): two css blocks, one added empty `<div>` in the Eval card footer, the release string, the cascade (7 hunks), the new Office module. No hunk is in a handler, a `fetch` call, the POST pass-through, the receipt model or the broker card. The pause / flatten / cancel-entry / snapshot fetch lines hash the same in both pages.
2. **Builder's capture** (`term22/gate/13e-…txt`): requests, dialogs, /bias and per-step IDENTICAL in all four states; the only difference is "external 1" in the state that opens Review. Not re-run by me.
3. **No shared path with the poll or a POST.** The Office read has its own abort controller, its own 8 s timer, its own state object and its own error text. It goes through the page's `fetch` wrapper, which returns at once for anything that is not a POST to pause / flatten / cancel-entry (`watch()`, unchanged). Nothing awaits it.
4. **A hung Office read changes nothing else.** With the request never answered: 4 snapshot polls were answered meanwhile, the header stamp was identical before, during and after, and after 8 s the card read "Office board unavailable · last seen … (no answer in 8 s)" over the last good copy. A failed read sets no page-level stale flag; it only repaints the card.
5. **To confirm:** the address is `raw.githubusercontent.com/…/claude/eloquent-lovelace-onifko/office/state/office.json`, a work branch, not the default branch. If the office publishes somewhere else, or that branch goes away, the card will say "unavailable" for good. No harm to anything else. The request carries no referrer, cookie or key (checked on 38 requests, all GET).

## B. Hostile file: PASS, with one cosmetic leak

| Input | Result |
|---|---|
| HTML / script / svg / javascript: strings in every string field | Shown as text. Nothing executed, no script, image, link or frame node in the card (0), none added to the page |
| 5 MB string; 10,000 leaks | "unavailable (file too large)" (limit 256 KB), last good copy kept |
| 200 KB of strings inside the limit | Painted, strings cut to their caps |
| Numbers as strings | UNKNOWN, never a number and never 0 |
| 1e308, −1e12, negative counts | UNKNOWN |
| NaN in the file, invalid JSON, 200 with an HTML body | "unavailable (not JSON)" |
| Nested objects / arrays where strings or objects belong | Each such field UNKNOWN; lists empty |
| Array root, null root, schema 2, schema "1", `__proto__`-only schema | "Office data format not recognised", nothing else, also over a good copy |
| `__proto__` / `constructor` keys | `Object.prototype` not polluted |
| Redirect, 404 | "unavailable (could not be reached)" / "(HTTP 404)" |
| Direction-override and control characters | Removed |

- Long tasks: the observer recorded none in any case (0 ms). I did not prove the observer fires in this headless setup, so treat this as "none seen", the same as the builder's.
- Two refresh taps inside 5 minutes made 0 extra requests.
- **The "live" split is safe.** It only cuts a string into text nodes inside one element; no markup is built. A "live" chip has 2 text nodes, 0 child elements, and `textContent` and `innerText` both read "live".
- **Fault B1 (cosmetic, hostile file only):** a combine or leak `status` equal to an inherited object key ("constructor", "toString") passes the status check; the card then prints "status function Object() { [native code] }". Text only, inside the card.
- A file that is schema 1 but otherwise empty paints the card with every figure UNKNOWN and "AGE UNKNOWN", not the "not recognised" line. That is per-field honesty, not garbage.

## C. Truth: CORRECT on the real file, two freshness faults

Real file (`office/state/office.json`, generated 11/10 10:51 PM PT; it has changed since the builder's copy):

| On the card | File |
|---|---|
| profit +$355, room $2,355, to pass $2,646, marker at 47.09 % (149.6 of 324 px) | 354.5, 2354.5, 3000 − 354.5; 2354.5 / 5000 = 47.09 % |
| "of 20 started: 0 passed, 14 breached, 6 open (last 20 TradeDays)" | 20 / 0 / 14 / 6 |
| today +$463, 9 trades, 7 won, 2 lost, 0 full stops; sessions Asia +$463 9 0, others $0 0 0 | same |
| week +$355, 25 trades, 2 full stops, 1.52×; Mon $0, Tue −$108 16 2, Wed +$463 9 0 | same |
| leaks: L-01 n 3 −$621.48, L-12 n 5 −$273.30, L-13 n 2 −$550.32; all 22 listed | same |
| experiments: n 0 / 1 / 1 / 0 / UNKNOWN / 0 of 20; X-03 +$86 per winning trade | same (86.34 rounded) |

- **null is never 0:** null profit "UNKNOWN: not in the file" and the track greys; null breached "UNKNOWN breached"; null leak dollars "$ not measured"; null n "n not counted". **0 is 0:** "0 passed", "full stops today 0", "week net $0", leak "n = 0 $0.00".
- Dollars are rounded to whole dollars except leak dollars (cents).
- **Freshness** (weekday hours, PT): just written FRESH; 29 h FRESH; 31 h OLD; 53 h OLD; 55 h STALE. Friday 2 PM PT file: Sunday FRESH, Monday 6:30 AM FRESH, Monday 3 PM FRESH (25 weekday hours), Tuesday 7 AM OLD. Missing or unreadable `generatedAt`: AGE UNKNOWN.
- **Fault C1: a file dated in the future reads FRESH, "generated 0 s ago".** Painted with a 2027 date: green FRESH chip. The "Written …" line does show the real date. It should read AGE UNKNOWN.
- **Fault C2: only `data.complete: false` shows "partial day".** `true`, `null`, `"false"`, `0` or no `data` block show no mark, so unknown completeness looks like a complete day. `false` itself always shows it.
- On a failed read over a good copy the chip keeps the file's own state (FRESH) beside the "unavailable · last seen" line.

## D. 30m node: AS RULED

| Case | Result |
|---|---|
| 1 info, agreeing | "Flow complete 4 of 4 agree up"; 30m "WITH ▲ up · info", lit; footnote "30m is shown for information and is not part of the gate" |
| 2 info AGAINST, four gate nodes agree | Still "Flow complete 4 of 4"; all links lit; 30m "AGAINST ▼ down · info"; no blocker tag, no "Flow stops" |
| 3 slot read 95 s old / status not CURRENT / no `candleDisplay` | No 30m row, four nodes, three links, no "NOT READ" text |
| 4 `alignSlots` has M30, against | "Flow stops 30m against"; 30m carries the blocker tag, no info tag; nodes below unlit. With: "5 of 5" |

- The info node uses the same reference direction as the others (`m.ref`: the bot's candidate, else the top timeframe's own).
- Live bot (edge r1.1): it publishes `candleDisplay.slots.M30` from its own 30m read each intrabar poll and no M30 gate slot, so Mac gets the info node. The bot marks the slot not CURRENT for one read after each 30m bar closes (`lib/candleDisplay.js:18`), so the row drops out briefly at :00 and :30.
- By code reading, not painted: when the gate stops above it, an agreeing info node is still drawn lit ("lit by its own direction") while the gate nodes beside it are dark. The headline and blocker are right.
- The info node's price is the 30m candle's last price at its own read time, printed with its own age; the gate nodes use the gate's price.

## E. Builder's judgement calls

- **"22:05 PT" → "10:05 PM PT": keep.** Only times the file marks PT are changed; "05:14Z" is left as written (checked).
- **Ignoring the `weekly` block: keep.** It is not in the contract.
- **Cascade 96: only the removed placeholder.** All 96 failure lines are "five rows drawn", "top-down order" or "30m is a bypass, never lit". Keep; the suite needs a 2.2 spec copy.
- **Control receipts 14: the same 14 flatten lines as 2.1.3** (failure lists identical). Keep.

## For 2.2.1

1. C1: a `generatedAt` later than the phone's clock by more than a few minutes → AGE UNKNOWN.
2. C2: completeness not stated → say so ("completeness not stated").
3. B1: check `status` with an own-key test.
4. Spec copies of the cascade and control-receipts suites.

## Not checked

- Replay pacing, visual style, bot changes (out of scope). Contrast, tap sizes and layout widths are the builder's.
- The real network: every Office read here was answered by a local stand-in. Whether Mac's phone can reach the address, and what its host caches, was not tested.
- The builder's gate suites and request capture were not re-run.
- The 2.1.3 receipt paths were not re-tested; their code is not in the diff.
- Cases 5 to 7 of my cascade run carried an M30 gate slot left over from case 4, so "info node below a blocker" is from code reading only.

Scripts and output: `review/term22/rv-22.test.cjs`, `rv-22.out`, `page-213-22.diff`.
