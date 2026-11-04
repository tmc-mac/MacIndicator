# TIDE Stage 2b: the 1-contract house-money pyramid add (MacAdd, 11/04) - design for MacDot's review

Mac: "2 out of 3 and add 1 at the next pullback while it trends in our favor and dump the last 2 at TP2." Spec D⁗; MAP.md ruling 5.
Base: pkg-live (Stage 2a; SHA256SUMS.txt sha 21760086e256...). Planner tideOrders r1.2 -> **r1.3**, driver tideLive r1.1 -> **r1.2**, + `lib/tideAdd.js` (new, pure).
Switch: `tide.addsEnabled` (default **false**), `bash tools/set-tide.sh adds=on|off` (flat only, one restart, startup line checked).
With `false` nothing new runs: no detector call, no `pullback-add` event, no add intent (the Stage 2a ADD_WOULD_FIRE refusal stays as a second fence).

## Lifecycle (one add per trade, max)
1. **Arm.** Only with: adds on, a TIDE position OPEN, TP1 done (a 1-lot: the TP1 price traded), `addsDone` 0, no flatten, no block.
2. **Detect** (`lib/tideAdd.js`, each CLOSED 1m bar, after the engine step). The level is (a) a 5m swing in our direction broken after the fill (short: a 5m pivot LOW that a later 5m close went below), or (b) a 5m FVG in our direction that formed after the fill (short: bearish, candle-1 low > candle-3 high). A **rejection** is a 1m bar that touches the level (to within 1 pt, or into the gap) and closes back on our side, as a with-trend candle (short: close < open, in the lower half of its range), without closing through it. The event: `pullback-add { addPx = that bar's close (tick-rounded), lastPx, bias {m15, m30, line 0.15} at the bar's close (the bias book), control4h = the engine's 4H control dir, rejection: true }`. Nothing at all is sent for a bar with no rejection.
3. **Gate** (planner, unchanged r1.2 logic): `money.addAllowed` at the ACKED stop: tp1Done, once, before TP2, 4H control ours, bias m15/m30 past 0.15 and neither against us, rejection, the stop behind the add, maxContracts, **house money** (the runner + the add closed at the current stop >= $0). Then reserved exposure. A refusal is journaled (`add-refused:<reason>`), nothing is sent.
4. **Raise first.** The stop goes to the combined break-even + 1 tick at the add's limit, when that is tighter (only tightens). The add waits for the raise's ACK (`addPending`). Rejected / short / reconciled meanwhile -> no add.
5. **Send** the add: LIMIT `addQty` = max(1, round(original/3)) at addPx, opening side. `addsDone = 1` is saved before the request (a crash can never add twice).
6. **Fill** (the driver reads its history every poll while it rests, and before any qty-mismatch reconcile): the ONE stop resized to runner + add (new first, the old cancelled verified), TP2 resized to runner + add at the SAME TP2 price, the ladder from the combined average with best-price reset to the add's fill (MAP: "since the fill or the add").
7. **No fill.** The add is cancelled (verified) when: the position goes flat (TP2 / stop / by hand; the add goes BEFORE the stop sweep), any flatten starts (13:05, phone Flatten, ladder lock, naked), or the stop is tightened to or past the add's price (it would fill unprotected). The tighter stop stays.

## Failure table
| case | what happens | test |
|---|---|---|
| happy path | raise acked -> add 1 LIMIT -> fill -> stop qty 2, TP2 qty 2 same price, ladder on combined avg | A1 |
| add never fills, TP2 fills the runner | position 0 -> the add cancelled (verified) first, then the stop; DONE, nothing resting | A2 |
| add fills during a stop modify (ladder move in flight) | fill read before the mismatch reconcile; the stop resized to 2 in the next pass; one stop at the end | A3 |
| stop-raise rejected | the raise follows ruling 3 (same price once, then block / flatten); `addPending` dropped, no add | A4 |
| restart between the raise and the add | `addPending` dropped at the reconcile; raised stop kept; no add sent this pullback; an add order sent but unanswered is matched by side/type/size/price, never re-sent | A5 |
| duplicate `pullback-add` / fill event | planner seen-id: no second intent; `addsDone` stops any later add | A6 |
| manual flatten (phone) with the add resting | the flatten clears the add (verified) before the stop cancel -> one market close | A7 |
| closed by hand in TopstepX with the add resting | qty mismatch -> reconcile -> 0 -> add cancelled, then the stop | A7b |
| 13:05 flatten with the add resting | exitAtMarket twice -> exactly ONE market close; the add cancelled first | A8 |
| add rejected by the broker | block `add-rejected`, `addsDone` 1, the stop and TP2 unchanged | A9 |
| add cancel not verified | ruling 6 as for any non-protective order: the flatten waits (`clearing`); no market order while it may fill | A10 |
| adds off | identical requests to the Stage 2a package (rig 11/04 + the 2a suites unchanged) | ID |

## Risks for MacDot to rule on
1. **addPx = the rejection bar's close** (a LIMIT at the market, fills on the next tick back). Alternative: the level itself (fewer fills, better price).
2. House money at a BE stop is never met (the runner locks ~$0): in practice the add needs the ladder to have locked >= the add's risk first (e.g. +2R -> +1R lock). This is D⁗ as written.
3. The ladder after the add uses the plan R (original entry -> structural stop) from the combined average: it can lock sooner than from the runner alone. Stops still only tighten.
4. A partial add fill: stop and TP2 follow the filled quantity; the remainder is cancelled at TP2 / flatten like the whole.
