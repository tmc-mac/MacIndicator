# Handoff to MacDot, 11/04 (from MacArthur)

All times are PT. Replace `<server>` with Mac's bot server address. Mac gives it to you directly.
Rules that stay in force:
- Mac installs only when FLAT (no MNQ position, no working MNQ orders).
- Every bot package passes the ship gate in CLAUDE.md before it reaches Mac.
- No IPs, account ids or host paths in the repo or in posts.

## 1. What is live now
| Piece | Version | Proof |
|---|---|---|
| Bot | **TIDE live r1.5.2**, executor `d0dc0042`, installed 07:01. Mode LIVE, climax gate ON (shipped default), rule 18 not present | Mac's go.sh output: `DONE: TIDE Stage 2a installed (executor d0dc0042)` |
| Phone terminal | **2.0.9.19.2**, mobile.html `cf3d288a`. 2.0.9.20 is in its final gate (see 3) | set-terminal.sh: `before 292e78ad -> after cf3d288a` |
| Server | 1 core, 961 MB RAM, plus a 2 GB swap file Mac added 11/04 ~01:20 | the r1.5.x warm-up holds at about 210-250 MB RSS |

## 2. What happened 11/03-11/04 and why it matters
- **Overnight OOM crash loop.** The warm-up rebuild was killed by the out-of-memory killer 5 times.
  - Fixes: the swap file, plus r1.5's memory guards (250 ms RSS poll, relative limit).
  - Node 22 does NOT enforce the worker heap cap; the RSS poll is the real guard.
- **The 02:13 long was lost** (would have made about +$362): `signal S291-E: NOT taken (broker-unreadable)`, cause `UND_ERR_SOCKET`. The bot reused a keep-alive socket the far end had already closed.
  - r1.5.2 fixes it:
    - read-only broker calls retry on a fresh connection, then after 0.4 / 1.2 / 2.5 s;
    - keep-alive is cut to 2 s;
    - orders are never blind-retried: a lost stop/TP answer leads to an open-orders read, then the order is adopted or sent once.
  - Independent review (MacFixCheck): GREEN.
- **Rule 18** (cancel a far trap when a nearer same-way acceptance arms): NOT shipped.
  - On tonight's tape it makes the identical 02:13 trade.
  - Over 6 days it costs -$180 (one swap on 11/02).
- **sameBarNearest** (keep the nearest of several same-bar acceptances): REJECTED. -$126 / -$484 and +1-2 full stops over 6 days.
- **NY block (06:30-07:10) and the 30-min open wait** after 06:30 and each 4H open:
  - 6-day replay with openWait 30 / 15 / 0 and the NY block on/off: all identical, 32 trades, +$5,979, 1 full stop, DD -$397. No TIDE signal ever fell in those windows.
  - **Today is not measured yet.** Mac can run the journal check in section 5.
- **Main open gap: no continuation entry.** TIDE enters only on the retest of an armed level.
  - On trend days that never pull back (11/04 06:35-07:10, 28,415 → 28,971), it sits out.
  - A continuation entry is a design + 6-day test job. Do not ship it untested.
- **Phone mislabels found today**, all fixed in 2.0.9.20 or 2.0.9.21:
  - The WHY NOT card showed the old model's noChase/ATR reason as if it were TIDE's. TIDE does not use noChase.
  - The Live-trade chart drew the old model's Plan entry / Target / Stop.
  - Hour Wave said "REJECTION" on a +396 hour that closed near its high.
  - The Hour Wave's 4H open comes from the old model (alignSlots) and can disagree with TIDE's O4.

## 3. Deliverables (branch `claude/eloquent-lovelace-onifko`, tmc-mac/MacIndicator)
| Item | Where | sha256 (first 8) | Status |
|---|---|---|---|
| Bot r1.5.1 | `deliver/MacBot-TIDE-live-r1.5.1.zip` + INSTALL sheet | zip `451de5a6` | superseded by r1.5.2 |
| **Bot r1.5.2** | `deliver/MacBot-TIDE-live-r1.5.2.zip` + `INSTALL-TIDE-live-r1.5.2.txt`; tree in `docs/new-bot/live-r1.5.2` | zip `a00286de` | **LIVE** |
| Terminal 2.0.9.19.2 | `deliver/terminal-2.0.9.19.2/` | mobile `cf3d288a` | **LIVE** |
| Terminal 2.0.9.20 | `deliver/terminal-2.0.9.20/` once its gate is GREEN | see that folder | final gate running |
| Levels PRO v2.8 | `deliver/levels-pro-2.8/` (main + TIDE companion) | main `6200537e`, TIDE `0d1c9336` | **waiting for your review** (team line #5, comment 6629782978). Not compiled in TradingView yet |

Built and sealed but NOT sent (in MacArthur's session scratchpad; ask Mac before installing any of them):
- **r1.5.3:** r1.5.2 plus two things.
  - Reviewer hardening: a position-size guard before the lost-answer re-send, and a preCheck re-check after a slow entry read.
  - The `tide.staleR` rule 18 switch, shipped OFF.
  - It still needs its own ship gate run.
- **r1.7:** r1.5.2-era trading plus the phone fields: TIDE broker net per trade, position/openPnl during a TIDE trade, stopAck, stopHist, fill receipt.
  - Gated partly, on r1.5.1 trading. It must be rebased on r1.5.2 and gated again.
- **Terminal 2.0.9.21 draft:**
  - Hour Wave: REJECTION only when the wick past the open is at least 8 / 20 / 40 pts and the body is at most 35% of the range. Otherwise ACCEPTANCE ↑ / ↓.
  - The 4H open comes from tide.board.O4.
  - Ungated.

## 4. How to tell Mac to install (examples; he runs them in PowerShell from Downloads)

### Bot package (example: r1.5.2)
```
cd $env:USERPROFILE\Downloads
Get-FileHash .\MacBot-TIDE-live-r1.5.2.zip            # must start with A00286DE
scp .\MacBot-TIDE-live-r1.5.2.zip root@<server>:/root/
ssh root@<server> "mkdir -p /root/tide-r1.5.2 && cd /root/tide-r1.5.2 && python3 -m zipfile -e /root/MacBot-TIDE-live-r1.5.2.zip . && ls pkg-live"
ssh -t root@<server> "cd /root/tide-r1.5.2/pkg-live && bash go.sh"      # type YES (flat)
```
- The server has no `unzip`; always use `python3 -m zipfile -e`.
- go.sh checks the files, backs up the bot, installs, restarts once, and verifies. If anything fails it puts the old bot back.

### Check the warm-up (about 6-7 min after a restart)
```
ssh root@<server> "journalctl -u mac-bot-live --since '-10 min' --no-pager | grep -iE 'rebuild progress|LIVE: the warm-up|net\]|Killed|NOT taken'"
```
- Want: `[tide] LIVE: the warm-up is done`, and no `Killed`.
- `[net] ... retry ... OK` = r1.5.2 replaced a stale socket. Good.

### Switches (each restarts the bot plus a warm-up; YES twice; flat)
```
ssh -t root@<server> "cd /root/tide-r1.5.2/pkg-live && bash tools/set-tide.sh climax=off"   # or climax=on
ssh -t root@<server> "cd /root/tide-r1.5.2/pkg-live && bash tools/set-tide.sh off"          # TIDE off, old bot trades
ssh -t root@<server> "cd /root/tide-r1.5.2/pkg-live && bash rollback.sh"                    # back to the previous bot
```

### Phone terminal (example: 2.0.9.19.2; no bot restart)
```
certutil -hashfile mobile.html SHA256        # compare with the sheet
scp mobile.html set-terminal.sh root@<server>:/root/
ssh root@<server> "sha256sum /root/mobile.html /root/set-terminal.sh"
ssh -t root@<server> "bash /root/set-terminal.sh install /root/mobile.html <full sha256 of mobile.html>"   # type YES
ssh -t root@<server> "bash /root/set-terminal.sh rollback"     # undo
ssh root@<server> "bash /root/set-terminal.sh status"           # read-only
```
Then Mac fully closes and reopens the phone page.

## 5. Read-only checks to give Mac (they change nothing)
```
# Why was a signal not taken, 01:00-02:20 PT on 11/04 (adjust the UTC window; PT = UTC-8)
ssh root@<server> "journalctl -u mac-bot-live --since '2026-11-04 09:00:00 UTC' --until '2026-11-04 10:20:00 UTC' --no-pager | grep -iE 'LIVE: the warm-up|signal|buy|order|reject|Killed|rebuild|error|NOT_FLAT|blocked' | tail -60"

# Every TIDE setup / retest / signal today, with its gate (TIME_BLOCK / OPEN_WAIT / pass)
ssh root@<server> "grep -h lv_tide /opt/mac-bot/levels-journal-MNQ-*11-04*.jsonl | grep -E 'setup_arm|retest|rejection|signal' | tail -30"

# What TIDE is tracking right now (armed levels with direction, entry, stop, blockedBy)
ssh root@<server> "python3 /root/tide-board-now.py"
```

## 6. Open items, ranked by expected P&L effect
1. **Run today's journal check (section 5).** It answers whether the NY block or the open wait cost a trade on 11/04.
2. **Continuation entry design + 6-day replay.** This is the gap that left Mac out of the 11/04 NY run.
3. **r1.5.3:**
   - its ship gate: off identity, default = r1.5.2, the injected-failure witnesses, install, rollback;
   - then offer it to Mac. It's a safety hardening, with no trading change by default.
4. **Terminal 2.0.9.20 delivery,** if not yet sent, then the 2.0.9.21 gate.
5. **Levels PRO v2.8:** your review, then Mac's TradingView compile.
6. **r1.7:** rebase on r1.5.2 / r1.5.3, re-gate, deliver. The phone shows TIDE P&L, position and stops.
7. **The -$400.62 old-model loss in today's Day P&L:** trace when and why. Mac didn't recognise it.
