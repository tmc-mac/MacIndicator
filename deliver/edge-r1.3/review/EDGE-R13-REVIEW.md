# Edge r1.3 review (branch edge13, HEAD 3f56bf1, executor 4168e4bb, proxy ae9f434f)

Reviewer desk, 2026-11-11. Base: edge r1.2 at 0b53d2a. Tested a `git archive` of 3f56bf1 (hashes match) on Node 18.19.1.

## Verdict: SHIP WITH NOTES

The start-up readers give the same adoption, TP1-banked and reconcile answers as r1.2, and the bot starts on the 98.7 MB journal inside a 493 MB heap limit. Nothing found can leave a position unmanaged, double-manage one or stop the bot from starting.

Notes, most important first:
1. **N1 (not new, not fixed): the proxy can still be killed by the phone.** With the 98.7 MB journal one `/trade-stats`, `/trade-list` or `/signal-journal?filter=traded` request took the proxy from 44 MB to 359 to 483 MB RSS; three at once reached 1066 MB RSS and 683 MB of heap. Mac's server has a 493 MB default heap limit and 961 MB RAM shared with the bot, so two or three overlapping requests end the proxy, and the bot reaches the broker only through it. Same in r1.1. Until fixed: give the proxy service the same heap setting, or keep the journal tabs closed.
2. **N2: a second place where a `null` journal line changes the answer.** `journalShowsTp1` on r1.2 returns false whenever the journal holds a line that is exactly `null` (it throws inside and the catch says "not banked"); r1.3 returns the true answer. The builder named only the orphan check. The bot never writes such a line, and r1.3's answer is the right one.
3. **N3: one urgent push per flatten request id.** r1.1 re-pushed every fifth failed read while a position could not be read; r1.3 pushes once. Accepted, but Mac gets one alert, not a repeat.
4. **N4 (display): every flag ack becomes `requests.lastAck`.** The last-10 list is protected (at most 5 flag acks), `lastAck` is not. A page that reads only `lastAck` can miss a flatten ack behind a flag ack. The page is out of my scope.

## A. Start-up reconciliation

**(1) The pre-parse filter is a superset.** Read from the code, then tested.
- The three reconcile readers and their helpers (`live-executor.js:215`, `:267`, `:350`, `:2984`) read only `entry`, `peak_unrealized` and `signal_check` rows with a truthy `journalId`. The collector keeps exactly those (`lib/journalLines.js:93-94`). A row the bot writes with `type: entry` always contains `"type":"entry"`; a signal_check with a journalId always contains `"journalId"`.
- `journalShowsTp1` (unchanged, `lib/liveStateMachine.js`) skips any line containing `"signal_check"` and uses only `entry` rows and `TP1_FILLED` / `TP1_PARTIAL` rows. The `tp1` collector passes those lines in file order.
- The plan restore keeps its own filter and row test, moved unchanged.
- Test `tests/j-equiv.js`: 400 random journals, 4 buffer sizes (16 bytes to 1 MB), hostile lines (torn rows, CRLF, multi-byte text, text containing `"journalId"` and `"type":"entry"`, spaced keys, other key order, primitives): reconcile rows and plan rows deep-equal to the r1.2 readers; `journalShowsTp1` equal on 25,296 (journal, position) pairs. Lines equal `readFileSync().split('\n')`.

**(2) The appended-bytes step does not miss or double a row.**
- A row half written at the first pass is not kept; it is read once when complete. Later rows are read once. The unterminated last line counts for that call only. All tested.
- A file that shrank is rescanned from the start (tested). A file replaced by one at least as long is not detected (tested, differs from a fresh read). The bot only appends to the journal and nothing in the tree rewrites it, and the window is the few seconds of start-up, so I rate this theoretical.

**(3) Restart mid-trade, full process, r1.2 against r1.3** (rig, 11/02 14:24Z, SHORT 3 @ 28752.75 open, saved trade state deleted so the journal decides):

| Case | Orders on the fake broker | r1.2 vs r1.3 |
|---|---|---|
| TP1 not banked (broker holds 3) | old stop and TP1 cancelled; stop 3 @ 28767.75 and TP1 2 @ 28737.75 placed; TP1 filled 14:27; runner stop 1 @ 28742.75 | identical trace, identical log timestamps |
| TP1 banked (broker holds 1 of 3) | old stop cancelled; break-even stop rejected (price already past it); market BUY 1, flat | identical trace, identical log timestamps |

The earlier same-day witness and soak are the second desk's.

## B. The `null` line

Not the only difference: see N2. Both differences go the same way: r1.2 throws on the line, r1.3 skips it and still sees every row after it (tested). On r1.2 the orphan check's throw is not caught, so the bot would not start at all; r1.3 starts. No row the old code acted on is hidden.

## C. Owner flag

- **No trading effect.** `lib/ownerFlags.js` holds no order-machine reference and makes no broker call. The row goes to the journal file through `persistJournalMeta`, not into `journalHistory` or a trade index. Readers of its state: the snapshot (`capabilities.flag`, `flags[]`), the ack list and the start-up seed.
- **Route limits.** `/flag` sits after the proxy key gate (`tmc-proxy.js:166`, route at `:258`), exactly as `/flatten`: loopback is exempt, everything else needs the key. Body limit 4 kB. The id must match `[A-Za-z0-9._:-]{1,80}`, else a random one is used, so no slash and no path outside the queue folder (an id of `..` becomes the file `...json` inside it). At most 40 queued files; fields cut at 2000 characters.
- **Disk.** Refused flags write no journal row; accepted ones are capped at 20 an hour; flag log lines at 10 an hour.
- **Loop.** Flags are read on each pass and on each 3 s sleep step; `pendingNew` does not look at the flag folder, so a flag never wakes the loop. Cost per step: one directory read, at most 50 small files.
- **Acks.** At most 5 of the last 10 are flag acks, so a flood leaves at least 5 flatten / pause / cancel acks. `lastAck` is not protected (N4).

## D. F1, F3, F4 from the r1.2 review

- **F1 closed.** One urgent push per request id; a flat bot's check gives up after 5 reads with REJECTED BROKER_UNREADABLE and is not requeued. The counter is cleared only after an answer. I accept the unbounded retry when `flattenNow()` itself cannot read the position: an exit may be needed and that is r1.1 behaviour. See N3.
- **F3 closed.** The ack now says the resting entry was cancelled, or that the cancel is not confirmed yet.
- **F4 closed.** A flat bot with a broker read made after the request that shows no position gets no follow-up; otherwise the text says the broker is not confirmed flat.

Read from the diff; not re-run in a full process.

## E. Config and install

- **No new config key.** No hunk touches the config defaults or the loader; no json or installer file in the diff.
- **Rollback state.** An r1.1 start on files written by r1.3 (trade state, scorecard, journal with an `owner_flag` row) reached the live loop, resumed the open position and exited 0. New on disk: the folder `owner-flag-MNQ/` and `owner_flag` journal rows; r1.1 ignores both.
- **Restart on install:** the bot service and the proxy service (the proxy file changed: `/flag`, plus the 75 s keep-alive from r1.2).
- **Restart on rollback:** both again, with the r1.1 proxy file restored. An r1.1 proxy has no `/flag` route, so the phone's Flag button would fail; nothing else depends on it.
- The heap setting 1024 on the bot service can stay; r1.3 does not need it.

## F. Memory spot-check

One boot of r1.3 on the rig with the 98.7 MB journal, `--max-old-space-size=493`, Node 18.19.1: live loop reached, exit 0, index seeded, backfill ran. **Peak RSS 291 MB** (VmHWM, sampled every 0.1 s). **Peak heap used 92 MB** as reported by `--trace-gc` lines; a timer cannot sample inside the synchronous pass, so this is the GC log's figure, not a sampler's.

## G. Proxy journal routes

Real `tmc-proxy.js` of this build, local port, 98.7 MB journal, never `/api/`:

| Request | Time | Proxy peak RSS after it |
|---|---|---|
| idle | | 44 MB |
| `/trade-stats` | 0.8 s | 359 MB |
| `/trade-list` | 0.7 s | 391 MB |
| `/signal-journal?filter=traded` | 0.9 s | 483 MB |
| those three at once | | 1066 MB (heap 683 MB) |

This machine's default heap limit is 8240 MB, so the proxy survived here. At 493 MB it would not survive the three-at-once case, and a single request is close. `/trade-why` without a trade id returned 400 before reading; not measured with one.

## Not checked

- The witness, the SIGKILL soak and the Mac-box gate (second desk).
- The flatten fixes and the flag path in a full process; the phone page; the zip and its install scripts.
- The proxy at a real 493 MB limit (sized from the measured heap, not run).

## Files

- `review/edge13/tests/j-equiv.js` and `j-equiv.out`
- `review/edge13/run/`: `ns12`, `ns13`, `bk12`, `bk13` (adoption), `rb11` (rollback), `f13` (memory boot), `px/px.log` (proxy)
