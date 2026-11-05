# Phone terminal 2.0.9.22 — what changes against 2.0.9.21 (0c1bd93e)

Display only. The page sends the same requests as 2.0.9.21. With TIDE off or absent, every view is the same DOM as 2.0.9.21 (identity-tested). The build is 2.0.9.21 with two scripts swapped: `feat-20918-r22.js` (the TIDE card) and `feat-20920-r22.js` (the Now folds, the Day P&L line, the tape detail). Rebuilding 2.0.9.21 and 2.0.9.20 from the same folder still gives 0c1bd93e and caf73686 byte for byte.

These are QC-UI's review items on 2.0.9.20 (MacArthur 11/04), in the order given.

## 1. Day P&L header during a TIDE trade
r1.5.4 never sets `openPnl` or `position` for a TIDE position, so the header read closed-only while TIDE was in a trade. Now, with `tide.position` open and the old path flat, the line under the day figure reads
`Day P&L (closed) $x · TIDE open +$y (bot)` — `bot` when the bot sends `tide.position.openUsd`; otherwise `(calc: last price − fill × contracts × point value)`, the same arithmetic as the TIDE position card (lastPx, else livePx; avgEntry; contracts; the page's point value). The day figure itself is the page's (the account's closed day). TIDE off, or the old path in a trade: the page's own line.

## 2. TIDE card: "4H CONTROL since" is the bar it formed on
`since` now comes from `tide.board.control.since` first, else the row's `barT`; a rebuilt row's write time (the warm-up time) is never shown as the since ("UNKNOWN" instead). The card's tooltip says which source. The Checklist's control step uses the same time.
The invented "failed break above the 4H open" text is gone: with no zone on the row the line reads `trap · extreme 28,829.50` (the row's `ext`); with a zone it still reads "failed break above/below <zone>".

## 3. TIDE card: LAST REFUSAL, and the r1.5.5 rows
A new line under the control: `LAST REFUSAL 08:28 S279 London High · waveBias wavePeakBias 0.0842 < 0.2`, from the newest non-rebuilt `grade_no_trade` row (its zone borrowed from the setup's `setup_arm`; the gate text parsed from the row's `why`, "gte 0.2 got 0.0842" → "0.0842 < 0.2"; an unparsed why is shown as written). An r1.5.5 row's `waived` list is appended: `· waived control4h->bias`.
The tape's ○ (no trade) detail line borrows the same zone and gate text. An r1.5.5 `setup_cancel` whose why starts with REFUSED ("REFUSED: waveBias - slot released", "REFUSED trap gives way to the acceptance at …") gets its own glyph ⊘ and reads "refused · <zone> · <why>".
Not done here: the `waived` list on the Review tab's No-trade rows — that is MacJournal's file (`feat-tidejournal.js`), which this desk does not edit; it shows the why text as before.

## 4. Now with TIDE live: nothing old-model reads as a reason
Mac's 08:53 recording: the old model's "Why no trade right now · from the bot's checklist" card and the Position card's "Score below threshold — long 5 / short 1, need ≥6" line still showed under TIDE live. Both now fold under the existing "Old levels model (not trading)" collapse in the TIDE why-not deck: the old checklist card is hidden and its content copied there under "Old checklist: … (not trading)"; the Position card's flat reasons are hidden, copied there under "Old model, flat reasons (not trading)", and the Position card says "TIDE live: the reasons are TIDE's …". Both come back the moment TIDE is off.

## 5. Row-ring fallback
The bot's snapshot keeps 120 rows. At 120 the TIDE card notes `journal rows 120/120 · earliest dropped (the phone keeps what it saw)`. When the `control_form` row itself has dropped out, the 4H CONTROL line comes from `tide.board.control` (dir, kind, since) and says so.

## 6. Not in this release
Review "Now" livePx fallback label, the tape legend line, rebuilt ticks at barT, the replay box collapse: not started (time).

## Version
`macui.pageVersion`, copies and exports say 2.0.9.22.

## Gate
See `gate/GATE-LOG.txt` and the per-step logs in `gate/`. Witness: `tests/qc-20922.test.cjs` on `qc154-flat`, `qc154-pos`, `qc154-pos2` (QC-UI's r1.5.4 fixtures) and `qc155-flat`, `qc155-ring` (this desk's r1.5.5 / ring variants). Identity vs 2.0.9.21: the TIDE-on states (`tide21-leak`, `qc154-*`, `qc155-*`) differ by design (the items above); every other state must be byte-identical.

## Gate result (MacArthur, 11/05 ~12:50 PT, after the rollback of MacDot's r4 review page)
Page 8b92d047 (built 11/04 17:20Z). Run 11/05 19:47–19:5xZ, one browser at nice 19; per-step logs in `gate/`, screenshots in `shots/`.
- qc-20922: 22 passed, 7 failed. The 7 (H1–H7) are the HTF-tag checks added to the witness at 17:34Z, after this page was built; the HTF tags are NOT in this page. They need the r1.5.6 bot (`tide.board.htf`), which is not installed; the live r1.5.5 bot sends no HTF fields, so nothing is lost on the phone today. They ship with the r1.5.6 terminal.
- feat-20922 27/27 · plan-leak-20921 16/16 · hourtype-20921 11/11 · feat-20918 36/36 · fill-late-20918 7/7 · feat-20919 26/26 · r17-20920 23/23 · macfacts 37/37 · no-sideways 64/64 (rerun; the first run died when a duplicate gate instance was stopped, log kept as 57-no-sideways.txt, rerun as 57-no-sideways.rerun.txt).
- identity vs 2.0.9.21 (42 states x 7 views, TIDE off): 34 identical; 8 differ: qc154-flat/pos/pos2, qc155-flat/ring, qc156-htf, tide21-leak are the TIDE-on states that differ by design (the items above); mac1814+tide-mode-off differs in the Journal view only because the REFERENCE capture still read "Loading…" in journal-stats-daily-body while the candidate had rendered the stat grid (a capture-timing artefact on the .21 side; the same state passed identity in the .21 gate's 30b run). No TIDE-off DOM difference attributable to .22.
- Field review (MacQC-UI-22, independent): every field .22 reads from snapshot.tide.* exists in r1.5.5/r1.5.6 at that path and type; no version gate or unguarded throw can take the card or page down (the r4 failure mode cannot recur). Notes: the refusal parser renders only the first condition of a multi-condition gate; the ring note keys on 120 rows, not the 64 KB cap. Display-only.
- Not run: replay (no replay-path change), a physical iPhone. Mac's install is the first Safari run. Verdict: SHIP.
