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
