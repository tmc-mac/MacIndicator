# Levels PRO v2.5-ui (dashboard display only)

Base: the v2.4-dev script Mac pasted on 11/11 as the best-looking version (`BASELINE-v2.4-dev-as-pasted.pine`).

**UNCOMPILED.** There is no Pine compiler on the desk; the TradingView compile governs.

What changed: only the dashboard table. Section 13 was cut and re-emitted at the end of the file as section 16, so the five new display inputs sit after every existing input. Every other line (levels, scores, plan, grade, signals, alerts, lines, labels, glyphs, PARITY / EVENTS tables) is byte-identical to the baseline; `build.py` reproduces the file from the baseline plus `section16.pine`.

Dashboard changes (each has a toggle in the "Dashboard UI (v2.5)" input group):
1. Long rows span columns, so the panel is narrower.
2. ACTION row: direction chip (LONG / SHORT / WATCH / SHIFT / CHOP / WAIT) and a tinted grade chip.
3. Strength meters on BIAS, PUSH, FLOW and R:R; PUSH and FLOW colored independently.
4. TAPE row: time-of-day RVOL and effort vs result (already computed, never shown before).
5. $ per contract beside stop and target points.
6. Title: symbol, timeframe, feed status (LIVE / NOT LIVE / STALE).
7. PRICE marker row shows the push direction.
8. Ladder tooltips, and an optional nearest-N cap for the desktop ladder (default 0 = all).

Known risks to check on the first compile:
- Column spans use `table.merge_cells`; the table is deleted and rebuilt on each last-bar update so spans cannot go stale.
- The dashboard table is now created after the PARITY / EVENTS tables. A reader that finds tables by position rather than by the `PARITY_SCHEMA` first row would be affected.
