# Nov 2 restore: Phase A tree, boot results, install path (status 11/09)

Target: TradeDay 2026-11-02 baseline (r13.3.5, executor 07e8e798), restored on the host from TIDE r1.6.2. Mac's ruling of 11/08 ("park TIDE, reinstall the Nov 2 baseline") is quoted in the restore handoff; Mac must confirm it still stands before any install.

## Status

| Gate | Result |
|---|---|
| Tree (47 files) | Built. 43 files match the Phase A stamp map; 4 extra files match the r13.3.5 build pin (`tmc-proxy.js`, `lib/alignmentEvidence/clock-gate.cjs`, `lib/alignmentEvidence/vendor/adapter.cjs`, `lib/alignmentEvidence/vendor/assess.cjs`). Stamp map alone does not start. |
| Boot to LIVE, Node 22.22.0 | PASS, 3 starts, 29 overrides applied, fake broker. |
| Boot to LIVE, Node 18.19.1 | PASS. |
| 961 MB memory limit (Node 18 and 22) | PASS, no OOM, peak RSS 180 to 236 MB. |
| Restart soak, Node 18, 961 MB | PASS, 3 of 3. |
| Real 2000-bar warm-up | Not run (fake gateway supplies 600 bars). |
| Trade witness | Not run. |
| Live health alerts | Not run. |
| Swap configuration | Not confirmed. |
| Install scripts on a scratch host | PASS, 13 checks (install, rollback byte-for-byte, refusals, automatic undo). |
| Live host check against the TIDE base | Not run. |

## Files

- `SHA256SUMS-PhaseA47.txt`: the 47 files of the tree.
- `STAMP-MAP-43.sha256`: the Phase A stamp map (43 files).
- `PIN-r13.3.5-extra4.sha256`: the four pin-verified extra files.
- `FROM-r162.sha256`: the nine managed TIDE r1.6.2 files the installer requires to match.
- `DELTA-r162-to-PhaseA47.tsv`: file-by-file delta, TIDE r1.6.2 to Phase A. 2 changed, 45 added, 14 removed (7 TIDE runtime files and 7 repo test files).
- `SETTINGS-DELTA-r162-vs-PhaseA43.txt`: settings delta (filename says 43; content applies to the 47-file tree).
- `install-nov2-phaseA.sh`, `rollback-nov2-phaseA.sh`: installer and rollback. `MACBOT_DIR` must be set; there is no default path.

The tree itself (zip) is not in the repo. It is sent to the operator directly.

## Before any install

1. Mac confirms the 11/08 ruling (TIDE comes off).
2. MacMillionz confirms whether the Nov 2 process loaded the four extra files.
3. The operator clears TIDE keys from `config-local.json` by hand. The installer refuses otherwise.
4. A live host check against FROM-r162.
5. The remaining gates above, or Mac's explicit waiver.
