# Handoff prompt — Team Mac, end of day 11/05 (for MacDot and MacMillionz)

Paste this whole file to MacDot (reviewer) and MacMillionz (builder). Attach the files listed in §6. Replace `<server>` with the bot server address only in a private message, never in the repo or on the team line.

---

You are picking up MacArthur's unfinished work from 11/05. Mac's goal is unchanged: the first bot payout on the Topstep combine, fewer full stops, the base hits caught. Everything below is ranked; do item 1 first. Nothing ships to Mac until an independent reviewer (MacDot) has run the ship gate in §5. Builder and reviewer are never the same agent.

## 1. What is live right now (do not break it)

| Thing | Live version | Where to find it |
|---|---|---|
| Bot (TIDE live) | **r1.6.2**, executor `a78c4f0c`, installed ~21:55Z 11/05, warm-up done | `deliver/MacBot-TIDE-live-r1.6.2.zip` (sha `503f7f75…`), unpacked copy `docs/new-bot/live-r1.6.2/`, sheet `deliver/INSTALL-TIDE-live-r1.6.2.txt` |
| Phone terminal | **2.0.9.23** installed (`mobile.html` `fc752789…`); **2.0.9.24** sent, install unconfirmed (`d7d70059…`) | `deliver/terminal-2.0.9.23/`, `deliver/terminal-2.0.9.24/`; installer `set-terminal.sh` (`d891ef9d…`, unchanged since .22) |
| Levels PRO (TradingView) | basis is **v2.4-dev** (`3d6dad42…`); v2.4.1b compiled on Mac's chart; **v2.4.2** and **v2.4.3** sent, paste result unknown | `deliver/levels-pro-2.4-dev/`, `deliver/levels-pro-2.4.1/` (CHANGES, MOBILE, PARITY, SCAN, TOKENS, SHA256SUMS) |
| Quality bar | `.claude/skills/team-briefing/QUALITY-BAR.md` (§6 has the new "Trader sanity pass") | repo |

Branch: `claude/eloquent-lovelace-onifko`, head `a6fda1c` plus this handoff commit.

## 2. Mac's rulings today (these are the spec; quote them, do not reinterpret)

- Step 1: "4H opening control level plotted · previous 4H candle closed bullish or bearish → directional structure (the 4H provides information, NOT an entry)."
- Step 2: "30M harmony: at each 30M open plot the 30M opening price; the previous 4H closed bearish so I need the 30M candle to close bearish; no alignment = no trade."
- Step 3: 5M executes. "we need to use the 5min if we're waiting on candle closes, the 15min is taking too long." "It doesn't have to be a pullback, it can just be price action at a level of interest including the institutional levels."
- "Stop should be sized to be beyond the 30 minute wick." "We should never lose more than $250–$400 total in any trade" ($400 is the hard max). Size cap: "8 cap is fine."
- "Remove the points system if it's going to continue to filter us from being in aligned trades."
- A far retest "isn't coming back… use some common sense… so I don't have to babysit all scenarios."
- Trail: "Trail on 5M structure after TP1" ("I agree"; "more opportunity will come").
- Halt: "wish our bot caught before we got halted and orders started getting rejected."
- "I don't want replay numbers" (report live journal evidence, not replay P&L).
- Terminal: "no differentiator between my old bot and TIDE bot in the Day P&L… it should be MacMillionz Bot P&L"; "On the review tab all TIDE needs to be changed to MacMillionz"; "levels traded" must show on every trade row; "It shouldn't have all these lingering misalignments that need to be reviewed."
- Levels PRO: v2.4-dev is the basis ("labels were better, easier to see levels intraday"); mobile must be elite on an iPhone 14 Plus; 4H open and 30M open lines distinct, with a Focus toggle; do NOT copy anyone else's indicator table.
- Every command sheet for Mac carries the server address (in the private copy only). Private sheets never go in the repo.

## 3. Unfinished work, ranked

### 3.1 Bot r1.6.3: the 5M structure trail after TP1 (MacMillionz builds, MacDot reviews)
State: a work-in-progress package exists at `deliver/handoff-1105/wip/pkg-live-r1.6.3-wip/` (bot + tests; NOT sealed, NOT shipped). The builder's last state report is in `deliver/handoff-1105/STATE-r1.6.3.md`. Treat every claim there as unverified until the suites run green on your machine.
Spec:
- After TP1 fills, the runner's stop moves to break-even + 1 tick, then trails behind the last confirmed 5M swing (swing low for longs, swing high for shorts; a swing = the middle of three 5M bars), 2 ticks beyond the wick, never loosening.
- Trail updates only on a completed 5M bar. The stop order on the broker is modified, not cancelled and re-placed, unless the API requires it (then cancel → place, journaled as one `trail_move` row with old/new price and the swing time).
- Journal rows: `trail_arm` (TP1 filled, BE stop placed), `trail_move` (new stop, swing bar time), `trail_stop` (runner closed by the trail; `realizedUsd` on `live_end` must include it).
- Snapshot: `tide.position.trail = {stop, swingT, moves}` for the phone.
- Switch: `tools/set-tide.sh trail=on|off` (default on). Rollback key in `rollback.sh` known-since table.
- Base chain: `FROM-r162.sha256` so `go.sh` installs over r1.6.2 (exec `a78c4f0c`), r1.6.1, r1.6.
Acceptance: the 5 suites green (net-retry 9, board 24, exec 138+, live 136+, lane 52+) plus new trail tests (TP1 → BE stop; three swing moves; a trail never loosens; a restart mid-trail re-owns the runner with the trailed stop); then the §5 ship gate.

### 3.2 Bot: halt detection and re-send (same package or r1.6.4)
When the broker rejects an entry with a halt/"market closed"/"not tradable" reason: journal `order_reject` with the reason (already done), push Mac (already done), then park the setup as `halted`, do NOT count it against the 2/h 6/day caps, and re-evaluate on the first 5M close after trading resumes (quotes moving again): if the 4H/30M alignment and level still hold, re-arm and take it; else journal `halt_expired`. No retry loop against the broker while halted (one probe order per 5M bar at most).

### 3.3 Bot: account fills + adjustments export (r1.6.4)
The day tracker showed a −$504.29 balance-vs-fills gap on 11/05 which the bot calls a non-trading adjustment. Export `account.fills[]` (time, side, qty, price, fee, orderId) and `account.adjustments[]` (time, amount, reason as the broker gives it) in the snapshot, so the phone can show the whole-day story with one P&L figure and the adjustment as a sub-line. Only broker data; no estimates.

### 3.4 Terminal 2.0.9.25: full alignment (MacMillionz builds, MacDot reviews)
State: candidate `deliver/handoff-1105/wip/terminal-2.0.9.25-candidate/` (mobile.html `871fada5…`, gate NOT clean at hand-off: last run had qc 6 failed, plan-leak 5 failed). The builder's state report: `deliver/handoff-1105/STATE-terminal-25.md`. The independent review (HOLD, 8 blockers B1–B8, 8 should-fix) is `deliver/handoff-1105/REVIEW-terminal-25.md`: fix every blocker there first, and add a witness that asserts the SAME day-P&L figure across header, Rolling card, Trades tile, day card, Review and Sessions (B1), and painted width not textContent for the clipping checks (B6). The UNKNOWN audit written for .25 is in the same folder (`UNKNOWN-AUDIT-25.md`) and lists what was resolved vs labelled.
Items (all must be true before it ships):
- Every "TIDE" label a trader can read becomes "MacMillionz" (header pill, Review tab, Day P&L, journal headers). Internal field names stay.
- Day P&L: ONE figure per card (fills-based net), bot vs old-bot never split; balance figure as a sub-line "balance … · −$x vs fills" in full, no clipping on an iPhone 14 Plus (430 px).
- Day cards build for every TradeDay including today (Nov 5 card was missing on .23/.24); Bot-trades stats card counts from the merged set (bot records ∪ unmatched account round trips).
- Trade rows show the level traded, qty, pts, R, exit reason; "UNKNOWN" only with the reason text (per the audit).
- Header pill shows WARMING UP (neutral) during the rebuild, never "Blocked".
- Decision card shows Mac's rows from the trend-lane journal (prev 4H dir, 4H open, 30M open, last 30M close, harmony, level, trigger, defense, why not).
- TIDE card: last reject line (from tide.lastReject), STALE cancels, "Show on Levels" link, HTF H3/H5/H7 rows.
- Replays: no missing TradeDays, no "undetermined" status where the journal has a `live_end`.
- Gates: identity, qc, feat, plan-leak, no-sideways, shots all pass on the frozen bytes; harness is at `deliver/tools/` + the package's `tests/` and `gate/` folders (see `deliver/terminal-2.0.9.24/` for the layout). Then the field review: load the page against a live snapshot EXPORT from the r1.6.2 bot (never an old fixture) before it reaches Mac. Never ship a page built on an old producer contract.
- Install: `set-terminal.sh` install/rollback/status over the exact installed build (`fc752789` or `d7d70059`); run twice from a copy.

### 3.5 Levels PRO v2.4.3: device check and docs (MacDot reviews; MacMillionz patches if needed)
- Get Mac's paste result for v2.4.2 and v2.4.3. If "main body too long" returns, wrap the new mobile pass in functions (that fixed v2.4.1 → v2.4.1b); it is a main-body limit, not a token limit.
- On an iPhone 14 Plus 15m chart with Mobile Mode on: plates must sit left of the last bar and never under the price axis; dashboard compact; 4H open and 30M open as 3 px starred main lines; Focus toggle hides everything else. Check `mob_back`, `mob_gap`, `mob_anchor`, `mob_dash` defaults against a real screenshot.
- Update `deliver/levels-pro-2.4.1/MOBILE-2.4.1.md` to v2.4.3 behaviour and refresh `SHA256SUMS`.

### 3.6 Decision for Mac (MacDot drafts the card, no build)
HTF against=half: the live bot tags setups against the 4H but still trades them at full size. Draft a one-screen card for Mac from the LIVE journal only (no replay numbers): how many against-4H trades, their P&L and full stops since r1.6.1, and the recommendation (tag only / half size / skip).

## 4. Reviewer items still open on r1.6.2 (MacDot)
The reviewer's rig items were skipped on Mac's order to ship: Mac-box run (1 core, 961 MB cgroup, Node 18.19.1, real 2000-bar warm-up), restart soak (3 kills mid-session, each start reaches LIVE and keeps armed setups), trade witness on a known replay day (fixture `bot/tests/fixtures/witness-1104.json`), go.sh twice from a copy + rollback. Run them on r1.6.2 now and on r1.6.3 before it ships. The r1.6.1 rig results (all PASS, peak 279 MB) are the reference; a regression on r1.6.2 is a bug report to Mac today.

## 5. Ship gate (every package, run by the reviewer, not the builder)
Mac-box run · restart soak ×3 · trade witness ("no trades" is a failure until explained) · install path (go.sh / set-terminal.sh twice from a copy over the exact live build, plus rollback) · live health alerts (not LIVE 10+ min, two restarts in 30 min, warm-up skipped). Then the QUALITY-BAR §6 trader sanity pass. Report shas, numbers and limits, not adjectives.

## 6. Files to attach to this prompt
- `deliver/handoff-1105/` (this prompt, STATE-r1.6.3.md, STATE-terminal-25.md, REVIEW-terminal-25.md, UNKNOWN-AUDIT-25.md, `wip/`)
- `deliver/MacBot-TIDE-live-r1.6.2.zip` + `deliver/INSTALL-TIDE-live-r1.6.2.txt` + `docs/new-bot/live-r1.6.2/`
- `deliver/terminal-2.0.9.23/`, `deliver/terminal-2.0.9.24/`, `deliver/tools/`
- `deliver/levels-pro-2.4-dev/`, `deliver/levels-pro-2.4.1/`
- `.claude/skills/team-briefing/QUALITY-BAR.md` and `SKILL.md`
- Private, by direct message only: the server address and the private install sheets (not in the repo).

## 7. House rules
Never touch /opt, the VPS, the live bot or the account; installs are Mac's, when flat. No credentials, IPs, account ids, usernames or absolute host paths in the repo or posts. `python3 -I` for untrusted data. CPU: nice 19, one browser at a time, pause above load 5. GitHub posts start with `[MacArthur]` and end with the Claude Code footer. Report outcomes faithfully: failing tests are reported with their output, skipped steps are named as skipped.
