# Handoff to MacDot, 11/04 afternoon (update to HANDOFF-MacDot-2026-11-04.md)

All times PT. Server address: Mac gives it to you directly; `<server>` below is the placeholder.

## Live now
| Piece | Version | Notes |
|---|---|---|
| Bot | **r1.5.5** (engine tide-structure-r3.6), live since 09:16 | Rules ON: rule 18, lanes (accepted break under trap control; retest must hold outside + displacement), controlAsBias (4H control is a bias check, not a veto), waveBias trend-relaxed, refused setup releases its slot. nearestWins and 15m/30m opens OFF. Node on the server: v18.19.1 |
| Phone terminal | **2.0.9.21** (mobile.html 0c1bd93e), installed | Live-trade card draws only TIDE's armed plan with its side; old-path plan leak closed; header distance in words; Hour Wave labels fixed |

## Ready, not installed
- **r1.5.6** (`deliver/MacBot-TIDE-live-r1.5.6.zip`, engine r3.7, zip 321F01B4): higher-timeframe context. Every setup is tagged WITH / AGAINST / neutral HTF from prior 4H, current 4H and daily. `tide.htfAgainst` = tag (shipped, display only) | half | skip. Install only when flat and nothing armed near price.
- **Terminal 2.0.9.22**: in build (Day P&L during a TIDE trade, "4H control since" time fix, LAST REFUSAL line, old-model remnants folded off Now while TIDE is live, HTF tags on the card).

## Code
- Branch `claude/eloquent-lovelace-onifko`, head de161d8. Deliverables under `deliver/`; source trees under `docs/new-bot/live-r1.5.x/`.
- Ship gate: r1.5.4, r1.5.5 and r1.5.6 went out on UNIT SUITES ONLY at Mac's order. No Mac-box run, restart soak, trade witness or install rehearsal. Needs the reviewer desk before further live change.
- Independent review of r1.5.5 / r1.5.6 running (MacQC-Bot-2), report pending.

## What the journal shows since 09:16
- 09:25–09:31: short at 1H Open 28,759.5 refused by laneTrigger: retest closed back inside the level (kept on purpose).
- 09:40–09:47: short at 4H ORL 28,743.25 refused by waveBias −0.07 (bias 15m/30m slightly bullish). Released.
- Price is chopping through 28,743–28,768. No setup has a clean retest since.

## Open items (ranked)
1. Review of r1.5.5/r1.5.6 (MacQC-Bot-2): order path, releaseOnRefusal re-arm, controlAsBias, htfStep, config plumbing.
2. HTF AGAINST decision (tag / half / skip). Six-day split: WITH 32 trades +$4,934 (2 full stops); AGAINST 8 trades +$557 (2 full stops). Recommend half. Not decided.
3. Replay evidence for r1.5.5 vs r1.5.3 on the six days: r1.5.4 as shipped was -$487 and +3 full stops vs r1.5.3. r1.5.5 has not been replayed.
4. Server runs Node 18.19.1 while the code was tested on Node 22. Confirm the r1.5.2 retry/keep-alive behaviour on Node 18.
5. Replay of the 11/04 morning (06:27 London ORH long, 07:40 4H-open short) is not possible yet: tape ends 11/03 19:47 PT.
6. Ship gate: Mac-box, soak, witness and install-path runs still owed before any further r1.5.x reaches Mac as "proven".

## Install commands (examples; PowerShell from Downloads, replace <server>)
```
Get-FileHash .\MacBot-TIDE-live-r1.5.6.zip        # must start with 321F01B4
scp .\MacBot-TIDE-live-r1.5.6.zip root@<server>:/root/
ssh root@<server> "mkdir -p /root/tide-r1.5.6 && cd /root/tide-r1.5.6 && python3 -m zipfile -e /root/MacBot-TIDE-live-r1.5.6.zip . && ls pkg-live"
ssh -t root@<server> "cd /root/tide-r1.5.6/pkg-live && bash go.sh"     # YES when flat
ssh root@<server> "journalctl -u mac-bot-live --since '-10 min' --no-pager | grep -iE 'HTF context|LIVE: the warm-up|Killed|NOT taken'"
ssh -t root@<server> "cd /root/tide-r1.5.6/pkg-live && bash tools/set-tide.sh htf=half"   # or htf=skip / htf=tag
ssh -t root@<server> "cd /root/tide-r1.5.6/pkg-live && bash tools/set-tide.sh lanes=off" # back to r1.5.3 trading rules
```
Read-only journal (any time):
```
ssh root@<server> "python3 /root/tide-journal-today.py 09:00 2>/dev/null"
ssh root@<server> "python3 /root/tide-board-now.py"
```
