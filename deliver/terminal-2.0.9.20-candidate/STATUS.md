# Terminal 2.0.9.20 CANDIDATE: gate NOT finished, do not send to Mac yet
mobile.html sha256 caf7368604cedde16cf137a9fde3daa972f4b2be21cfbb6136fc9748fa747f1c (set-terminal.sh d891ef9d unchanged).
Rebuild: `bi/build.sh 2.0.9.20` in MacUI's workspace (not in the repo).

Gate on caf73686 at handoff (15:36Z):
- PASS: feat-20920 27/0, r17-20920 23/0, whynot-20920 10/0 (with W3b: the side is shown only from board dir), feat-20919 26/0, feat-20918 36/0, fill-late 7/0, macfacts 37/0.
- reel 4x A/B vs 2.0.9.19.2: long tasks +2.2% over 6 pairs, under the 5% limit. Frames, p95 and max gap were within noise.
- TIDE-off identity vs 2.0.9.19.2: 34/35. The one diff was a timing difference; re-run it in a quiet slot.
- STILL TO RUN: browser-tj identity, no-sideways, render, shot-20920 on these bytes.

CHANGES-20920.md describes the build before the WHY NOT fix (e10ff381). This build adds two things:
- With TIDE live or shadow, the Now WHY NOT / CLEAR headline is TIDE's own reason (holding text + armed level + retest). The old checklist folds into "Old levels model (not trading)".
- An armed level's side is printed only from tide.board levels[].dir.
