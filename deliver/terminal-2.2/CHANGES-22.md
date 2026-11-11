# Phone terminal 2.2 (terminal builder, 11/11)

2.2 = 2.1.3 + the Office section on Review, a one-line Office note on Now, and the HTF cascade's 30m node made informed (Mac's ruling of 11/11).

Frozen page: `term22/mobile.html`, sha256 `768134e8a089f5901487d7dfbfc0dc7caa56c2a368b790cd766062300c1ab403` (read-only; unchanged after the gate).
The bot's snapshot poll and the three Control POSTs are untouched. The page now makes one request that is not to the bot's server: the office file.

## 1. Office section (Review)

**Where.** Review: Combine, This bot, Rule scorecard, **Office**, journal. No new bottom tab. Now tab: one line in the Eval card's footer, "Office: updated 3 h ago · combine open", only after a copy has loaded this session (+16 px or less).

**What it reads.** One public file, `office/state/office.json` (office/LOOP.md section 10, schema 1), from the one constant `OFFICE_URL` in `src/t22.js`.

**Fetch.** A GET when Review is opened, or when the page's refresh button is tapped while Review is open; at most once per 5 minutes; cache no-store, credentials omit, no referrer (so neither the page address nor its key is sent to the file's host), redirects refused, aborted after 8 s. Nothing waits for it: with the office request hanging, the snapshot poll still ran (tested).

**Untrusted text.** The file is read into a model through `cap()` / `num()` / `cnt()` only: strings cut to a length (12 to 280 characters by field), control and direction-override characters removed, numbers finite and bounded, lists cut (40 leaks, 30 experiments, 20 blocked, 20 flags, 12 waiting), unknown keys ignored. It is painted with `createElement` + text nodes only; no markup from the file reaches `innerHTML`. Schema other than 1: "Office data format not recognised" and nothing else, also when a good copy was on screen before.

**Content-Security-Policy.** None in the page and none in the proxy's HTML headers (`tmc-proxy.js` sends only Content-Type), so the fetch is not blocked by them. Not checked: anything in front of the proxy on Mac's host.

**Freshness.** "TradeDay <day> · generated <real age> ago". The amber / red rule counts weekday hours only (Saturday and Sunday PT do not count): OLD (amber) at 30 weekday hours, STALE (red, every figure struck through, track greyed) at 54. `data.complete: false` shows "partial day" in amber with the file's note one line below. A file with no readable time is "AGE UNKNOWN", never fresh. Fetch failure: "Office board unavailable · last seen <age>" over the last good copy, which is kept in memory only (nothing in localStorage). First-load failure: the unavailable line alone, with the reason; no empty cards.

**Order.** Waiting on Mac (only when non-empty) → Virtual combine → Today and the week → Leaks → Experiments → Blocked signals → Flags (only when present).

**Signature element: the combine track.** One horizontal track is the whole combine on one scale: left end = the floor (breach), right end = the target (pass), marker = the profit. Its position is `floorRoom ÷ (floorRoom + (target − profit))`, two numbers straight from the file, so "how close to passing, how close to breaching" is one look. The start (profit 0) is a tick `floorRoom − profit` from the left, so it moves when the floor trails. Tests (`office-22.test.cjs`): profit +$820, floor room $2,000, target $3,000 puts the marker at 2000 / 4180 of the track within 1 px and the tick at 1180 / 4180; the real file puts it at 2354.5 / 5000; passed sits at the right end, breached at the left.
- Under the track: "room to the floor $X" and "to pass $Y". When the floor is not at −max loss, one line says where it is: "floor trailed up to −$1,180 from the start" or "floor locked at the start balance". No line when it has not trailed.
- Best day against the cap as a second, quiet bar; status word; need per day; "of N started: P passed, B breached, O open (window)". Zero is shown as 0; null as UNKNOWN.

**The two combine cards.** The existing Review "Combine" card is the bot's own account: balance, open P&L, equity and remaining drawdown from the bot's snapshot. The Office card is a different thing: a virtual combine the office keeps on its own ledger of the bot's results. The Office one is titled "Virtual combine", tagged "virtual, on practice results", and says under its title: "The office's ledger of a Topstep $50K Combine run on the bot's results. Not the account: the bot's own account numbers are in the Combine card above." The existing card is unchanged.

**Leaks.** Header "Leaks · dollars over the last 5 TradeDays" (said once). Rows: id, status chip, n, dollars with the sign as given, title, "Next:". Order live → recording → measured → observed; killed in a closed "Killed (N)" list. An unmeasured figure reads "$ not measured" / "n not counted" inline in the muted text colour; amber and red are kept for freshness and partial day. Every row's first line is the same height, measured or not (tested at 360 / 390 / 428 on the real file).

**Experiments.** id, mode chip, "n 14 of 20" with a thin progress bar, value with its unit, verdict. **Blocked signals.** gate, blocked, would have won, lost, neither (when the file has it), unknown.

**The file's words are verbatim in every mode.** Under replay or test data the page relabels the word "live" everywhere ("live" → "replay"); that rule is about the bot's data. Office text is written so no single text node holds the whole word, which is what that relabelling looks for; what is read, copied or spoken is unchanged. Tested in replay mode with "live", "LIVE ACCT", "Live", "Back to live", "not live", "behind live", "snapshot": all shown as written. The page's 24-hour clock rewriter is also kept off Office text.

**Times inside file strings.** A 24-hour time the file itself marks PT ("22:05 PT") is written 12-hour ("10:05 PM PT"). A time with no PT after it (for example "05:14Z") is left as the file wrote it, because rewriting it as PT would be a guess. The office tool should write times in its strings as PT.

## 2. HTF cascade: the 30m node (Now)

Mac, 11/11: "no reason to have the 30 gate on here if we're not using it. If we are going to have it on here for information purposes it needs to light up and be informed like the other time frames."

- **No "NOT READ" placeholder in any case.**
- **Info node** when the gate does not read 30m and the bot publishes the 30m candle: fields `candleDisplay.slots.M30` with `status: "CURRENT"`, `open`, `last`, `readAt` no older than the cascade's existing 90 s limit. It renders like 4H / 1H / 15m ("WITH ▲ up" / "AGAINST ▼ down" against the same reference direction, "price X above / below open Y", "read N s ago"), carries an "info" tag, is not counted in the headline, is never the blocker, never produces "Flow stops", and the line passes through it. The footnote adds: "30m is shown for information and is not part of the gate."
- **Gate node** when the gate reads 30m: an `M30` entry in `current.lv.alignSlots` (what the bot sends with `align30` on). No info tag; it counts and can block like any other.
- **No row** when there is no usable 30m data (missing, status not CURRENT, no open, read older than 90 s, or an older bot with no `candleDisplay`).
- **What Mac sees on his current bot:** the edge r1 / r1.1 snapshots I have (`edge2/sample-snapshot.json`, the r1 boot tree) both publish `candleDisplay.slots.M30` as CURRENT with a read about 20 s old, and no M30 gate slot. So he should see the informed 30m info node. Not verified against his running bot; if its 30m read is ever older than 90 s the row is absent until the next read.

## 3. Gate (all on 768134e8…; logs in `term22/gate/`)

| Suite | 2.1.3 | 2.2 |
|---|---|---|
| New painted suite `office-22` (Office states, real file, verbatim, cascade 30m) | none | **361 / 0** |
| 2.1.3 painted suite `surfaces-213` | 569 / 0 | **569 / 0** (one change: its end-of-session check allows the office read) |
| Surfaces (spec copy) | 235 / 0 | **235 / 0** |
| Control receipts (old-bot harness) | 305 / 14 | **305 / 14**, the same 14 flatten lines as 2.1.3 |
| Cascade (spec copy) | 1030 / 0 in 2.1.1 | 934 / 96 |
| Requests vs 2.1.3 | none | requests, dialogs, /bias and per-step IDENTICAL in every state; overall "DIFFERENCES FOUND" |
| Control identity vs 2.0.9.10 | 92 / 0 | **92 / 0** |
| Budgets (contrast, taps, sideways scroll, clock sweep) | 912 / 0 | **912 / 0** |
| Replay A/B | not run | not run |

- **Requests "DIFFERENCES FOUND"** is the new office read and nothing else: in all four states the request list, dialogs, /bias answers and per-step counts are IDENTICAL to 2.1.3; the one difference is "external 1" in the state whose script opens Review. That is the intended new request. In that one gate step the page really did read the public file from this machine.
- **Cascade 96** are all the removed placeholder: 32 × "five rows drawn", 32 × "top-down order", 32 × "30m is a bypass, never lit". That suite still expects the "NOT READ" row Mac ruled out; I did not rewrite it.
- **Replay A/B not run.** The diff adds one step to the 1 s render that returns after two tab checks, and the cascade change is on the Now tab. Nothing new runs per frame. No fetch happens unless Review is opened.
- **Long task on Review open with the fixture:** none over 50 ms (the observer recorded none).
- **Contrast:** every painted text run in the Office card is 4.5:1 or better, dark and light, at 360 / 390 / 428, and on the real file. **Reduced motion:** nothing in the section animates or transitions.

## 4. Flag button (not in this build)

For a "flag this trade" button the bot would need to accept and journal one new phone request. Request: type `flag`, written by the proxy like pause / flatten (`{ id, requestedAt, journalId or the broker round-trip key, reason (short text, capped), tradeEntryTime }`), acked through the existing `requests` block so the phone can show sent → bot received. Journal row: `{ type: "trade_flag", t, id, journalId, roundTrip, reason, requestedAt }`. The office's daily tool then reads those rows and writes them back in `flags[]` with its `answer`. Nothing in the bot's trading path changes.

## 5. Limits and not verified

- Built against the contract and the office's file of 11/11. The file's `weekly` block (week totals, readiness, decisions) is not in the contract and is ignored.
- `combine.current.bestDayPct` is not shown: the contract does not say what it is a percentage of.
- Leak dollars are labelled "over the last 5 TradeDays" on the head agent's word; the file itself does not carry the window.
- Whether anything on Mac's host adds a Content-Security-Policy or blocks outbound requests from his phone's browser was not checked. If the read is blocked the section says "Office board unavailable" with the reason.
- The file's host sees a request from Mac's phone each time (its network address, like any web request). No page address, key or cookie is sent.
- A weekday holiday counts as a weekday in the staleness rule.
- In the replay-marked screenshots the page header reads "No fresh snapshot for 203h" on the two real-file shots: the screenshot clock was set to 11/11 over a Nov 2 bot fixture. It is not an Office state.

## NEXT (cosmetic or out of scope)

- "· partial day" can wrap onto its own line with the dot left at the end of the first.
- The weekly block (week review, readiness, decisions) as a sub-section, once it is in the contract.
- A spec-updated cascade suite for the 30m change, and a control-receipts copy for the 2.1.3 flatten rule.

## Files

- `term22/mobile.html`, `mobile.html.inputs.txt`
- `term22/src/t22.js`, `t22.css` (new); `t210-cascade.js` / `.css` (30m); `t210.js` (the Now-line slot, release string); `build-22.cjs`
- `term22/tests/office-22.test.cjs`, `office-fixture.cjs`, `office-real-1111.json`, `surfaces-213.test.cjs`, `gate-22.sh`, `shots-22.cjs`
- `term22/gate/GATE-LOG.txt` and per-suite logs
- `term22/shots/`: 13 screenshots, 390×844 at 2×, replay-marked
