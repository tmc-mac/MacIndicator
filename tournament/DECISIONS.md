# Coordinator decisions (ambiguities resolved toward sustained profitability)
2026-10-10
1. **Window plan.** Spec says validate on "2024–2026" but rounds need never-used data and total hold-out need is
   3+3+3+6 = 15 months. Data ends 2026-09-25 (NQ) / 2026-10-09 (ES). So: train 2021-09-27..2023-12-31;
   validate 2024-01-01..2025-06-30; R1 2025-07..09; QF 2025-10..12; SF 2026-01..03; Final 2026-04-01..2026-09-24.
   Teams' loaders are truncated after 2025-06-30 so hold-out rounds are unseen.
2. **Match runs the full window** (not stopped at +$3K); `passed` flag recorded. Trailing floor is literal (EOD peak - $2,000, no lock).
3. **Fills:** 1-tick slippage on market/stop fills; limits need 1-tick trade-through; stop-first if stop and target share a bar.
4. **ES data:** raw Databento outrights only (spreads dropped), front month by daily volume, additive back-adjusted at rolls.
   Gold (MGC) files were supplied but are out of scope (NQ/ES only).
5. **Gate** run with account rules off (so bust does not truncate the trade count), one continuous pass over validate.
6. **Lanes** assigned by coordinator to guarantee unique core concepts (see teams table).
7. Slippage/commission: commissions excluded per policy.
8. **Lane overlap ruling (NQ-2 vs NQ-6).** Both use the 09:30 ET opening range geometry. NQ-2 is a pure range-breakout; NQ-6's declared core concept is a volatility-regime *classifier* that switches between breakout and failed-breakout fade. Accepted as distinct (different edge source, different trade logic); logged as borderline.
9. Teams were told they cannot see validation/hold-out data (loader truncates at 2025-06-30). Several teams amended their prereg after first backtest on TRAIN (disclosed in each prereg.md "Amendments"); only train data was available to them.
10. **NQ-4 removed** after a second failed gate (PF 0.97 after rework). No alternates were registered, so the bracket shrinks (spec §4/§8). Handling for odd qualifier counts: byes in Round 1; quarterfinal pool topped up to 8 with best R1 losers where available.
11. **Qualifiers (11):** NQ-1, NQ-2, NQ-3, NQ-5, NQ-6, ES-1, ES-2, ES-3, ES-4, ES-5, ES-6. Five matches + one seeded bye in Round 1; QF pool = 5 winners + bye + 2 best R1 losers = 8. Caveats on record: ES-4 passed only partly in-sample (its own honest OOS PF 0.99); ES-1/NQ-6 passed with thin margins after validation looks; NQ-1 took one extra validation look; ES-2 clears PF>1.0 by a hair (1.003).
12. **Replacement entrant NQ-7 (user-directed, 2026-10-10).** Admitted for eliminated NQ-4 on a fresh lane (daily-structure patterns), before Round 1. Same rules: pre-register before backtest, train-only research, same validation gate, one rework. Caveat on record: a late entrant knows the format and that the gate exists, but has no access to validation/hold-out data or other teams' work. Round 1 draw is re-made once NQ-7's gate result is known (12 qualifiers → 6 matches, or 11 + bye if it fails).
13. **Both-net-negative rule (Round 1).** Spec: a losing strategy cannot win on ratio, but a bracket needs a winner. When neither team finishes net-positive (no bust), the smaller loss advances (3 of 6 R1 matches). Logged per instruction to reward sustained profitability over variance. Second-chance slots go to the best R1 losers by score, then by net.

## RULES v2 (user directive, 2026-10-10) — supersedes items 2, 5, 8, 11-13 where they conflict
14. **Goal changed:** find 12 strategies that are PROVEN to hit +$3,000 before the trailing -$2,000 drawdown (a funded-eval pass), then
    race them head-to-head. A strategy that never reaches $53,000 has no place in the tournament. No 'least-loss advances'.
15. **Round 1 (old format) VOIDED** as an exhibition (kept in hidden_files/.../archive/). Only 3 of 12 made money; none passed.
16. **Proof standard:** see TEAM_BRIEF_V2.md / engine/certify.py. Sizing chosen on DESIGN (2021-09-27..2024-06-30), scored once on PROOF
    (2024-07-01..2025-06-30), plus cost stress, parameter robustness, half-year consistency and lookahead checks. Hold-out 2025-07..2026-09 is reserved for the tournament.
17. **Caveat:** pre-v2 teams (NQ-1..7, ES-1..6) saw validation data (2024-01..2025-06) while reworking, so their PROOF is partly contaminated; they are re-certified under the same bar and flagged. New recruits (NQ-8..11, ES-7..10) design on 2021-09..2024-06 only.
18. **Quality team:** QA-Engine (independent simulator re-implementation) and QA-Realism (data + fill-realism audit) must sign off before any certification is published.
