# NQ-2 log (train only)
- 2026-10-10 prereg written first. v0 (RM15, SF0.5, TM2, risk150): net +76, PF1.00, n529, maxDD 4260, roll bust 19%. Flat.
- Sweep SF/TM: removing the target (hold to 15:55) clearly better (SF0.5: TM1 -3560, TM2 +76, TM4 +5324, none +10147); wide stop SF 0.75-1.0 better. Trend-day capture.
- Sweep RM: 5 -> +1534 PF1.04; 15 -> 10147 (DD2944); 30 -> 7.8k DD2.2k; 45 -> 10.5k DD1.6k bust 0; 60 -> 7.3k. Plateau 30-60; chose 45 (entries to 11:30).
- SF 0.5/0.75/1.0 at RM45: 10.6k/13.6k/12.2k, DD 1.57k/1.70k/2.0k. Chose 0.75.
- RISK sizing: 60-200 identical (stop distance usually >$100 -> 1 contract); 300 -> 15.4k DD 2.0k; 450 -> bust 45%. Chose 200 (1-2 ct).
- Frozen: RM45 ENTRY_END690 SF0.75 no target RISK200 WMIN0.5 WMAX2.0 (filters untuned, ENTRY_END/WMAX variants only tested at RM15).
- Frozen result: net 13169 PF1.36 n433 (0.74/d) maxDD 1700 (cumulative, rules off); rolling 53 windows: pass 15%, bust 0%, pos 94%, median score 1.24, median net 1619. Lookahead clean. All 9 train quarters positive (weakest 2022Q4 +110, 2023Q1 +283).
