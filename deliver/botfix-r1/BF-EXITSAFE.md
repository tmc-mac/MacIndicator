# BF-EXITSAFE: market-exit safety (desk A)

**Rule (lib/safeExit.js, used by sessionFlatten = 13:05 session close, morning-hold close, np1, exit 5; also the filled-through-stop exit).** A broker `success:false` reply = REJECTED. Anything else (timeout, lost reply) = UNKNOWN. On UNKNOWN the bot sends nothing and puts no stop back. It reads position and working orders until they agree: 2 reads for flat, 6 reads (5 s) with nothing working for "same", within N = 20 s. "Same" must also be confirmed by the order history (`/api/Order/search`: our market exit absent or dead).
- flat: done (leftovers swept, FLATTENING, tick confirms). Journal EXIT_UNKNOWN_RESOLVED.
- same: stop + TP1 put back at the same prices, then one retry next poll. K = 3 market sends per exit in total.
- other size: stop for the real size, then HALT. Opposite / never settles / history unreadable or shows the exit filled: HALT.
- A HALT means: no new entries, no orders, an urgent push, `healthAlert('halt', why)` if defined, and journal EXIT_HALT. It is latched on disk.

**State:** `UNKNOWN -> settle -> {flat: FLATTENING->FLAT | same: protect -> retry (<=K) | mismatch: protect real size -> HALT | opposite/unsettled: HALT}`. `REJECTED -> stop+TP1 back -> backoff 0 s, 10 s -> HALT at K`.

**Also done (beyond the cut scope, already tested):**
- S2: np1 runs before exit 5 in live-executor.js. This is a 2-line swap.
- S3: every alert names its exit.
- S4: TP1 is restored, retries have a cap and backoff.
- Restart: `exitInFlight` and `exitAttempts` are saved atomically BEFORE the send. `so1HaltLatch` runs the same settle at startup.
- Late fill: the existing FLATTENING reversal guard closes the excess and alerts (test 9).
- An accepted exit that is still not flat after 60 s gets one alert.

**Why N and K:**
- N = 20 s: the HTTP timeout is 15 s, and 20 s of reads covers late processing, well before Topstep's 13:08 flatten.
- K = 3: a market exit refused 3 times is not transient.

**Tests:**
- Run with `node exitsafe-tests.js <tree> <tmp>` (scratchpad `botfix/exitsafe-tests/`): **63/63 pass**. Covered:
  - lost reply then flat, and still-in-position, on all 4 paths;
  - lagging reads, D5, rejects with wording, cap and backoff;
  - opposite position, never-settles, other size;
  - restart (flat, same, opposite, unsettled, stale, np1), late fill, S2 ordering, through-stop.
- QA qa-tests.js: **38/42**. D5 passes. The 4 fails each assert the old behaviour:
  - D1b: TP1 not restored;
  - D2: uncapped retry every poll;
  - D3: continuation of D2 after the cap halt;
  - F1: byte-identity with pkg-A47 (the snapshot now carries `exitInFlight`, and the reject flow restores TP1).
- c5-tests: **25/25**.

**Boot:** SKIPPED (deadline). There has been no full-process boot of this build.

**Limits / NEXT:**
- Manual flatten (`flattenNow`, desk B's area) is not on this rule.
- The through-stop "same" path keeps its old retry, with no cap.
- At startup, an "other size" result halts without placing a stop.
- The order-history field names (type/side/status/creationTimestamp) are assumed from ProjectX docs. A row without a time counts as "seen", which is conservative.
- A position feed that is stale for more than 5 s AND has no history row can still lead to one retry. The reversal guard then corrects it.
