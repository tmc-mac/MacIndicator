# Sizing options A-E: risk desk (MacRisk, 11/04)

Full tables: `RISK_tables.md` (every option x outcome x grade x set). Raw numbers: `risk_results.json`. Code: `risk.py`
(`nice -n 19 python3 -I -B risk.py SCRATCH`, about 30 s; it imports `quant.py` for the episodes, waves and volume).

## Recommendation (read this first)
- **Combine: option D (A+ $600 / B $450 / C $300).** Optional add-on, which Mac has to OK: the cushion throttle (H2): every grade
  sizes at $300 while the balance is within $2,000 of the trailing floor. It is a size rule, not a stop: the bot keeps trading.
- **Option A's $900 A+ unlocks only after live data shows the grade is real.** Bar: at least 20 live A+ trades, and A+ average R at
  least 0.5R above C. Until then, A's extra $300 per A+ is a bet on 6-22 sample trades.
- **Practice account: option C (A on practice) is fine.** No real account is at risk there. Whether the grades are real comes from R by
  grade, which is the same at any size.
- **Why not A on the combine:** the danger is grades that don't hold up. If A+ trades only perform like C ("A+ like C" stress), the
  chance of hitting the max loss within 30 trades is:
  - option A: 10.8% (taken-if-flat) and 28.6% (episodes);
  - option D: 2.4% and 9.8%;
  - D + throttle: 1.7% and 5.8%;
  - option E: 0.7% and 2.1%.
  This uses quant's 2-point grade and the r2-exit proxy. When the grades are real, A earns the most: 30-trade median +$4,341 vs D +$2,829.
- **Why not B (flat $450):** it pays nothing extra for good grades, yet risks more than D on C trades. On the full episode sequence
  (r3 grade, 2R first-touch) it had the worst real drawdown: $4,367, 97% of the max loss.
- **E (flat $300)** is the safest in every stress, but it gives up the grade edge if the grades are real (median +$1,358 vs D +$2,829).
- **No sizing fixes a grade that isn't real.** On quant's grade every bit of the edge sits in A+. In the stress where A+ performs like C,
  even E ends 30 trades around break-even, and it loses on the 2R first-touch outcome.

## Headline table: taken-if-flat, 30-trade bootstrap (2,000), P(max-loss breach) / median end $
Grade proxy **r3** = the playbook §23 proxy, below. **q2** = quant's 2-point grade. r2 = the r2-exit proxy; 2R = 2R first-touch.
Stress = A+ keeps its size but draws C's outcomes.

| option | r3, r2 normal | r3, r2 stress | q2, r2 normal | q2, r2 stress | q2, 2R normal | q2, 2R stress | actual seq total / maxDD (r3, r2) |
|---|---|---|---|---|---|---|---|
| A $900/600/300 | 0.3% / +2,622 | 2.2% / +965 | 1.0% / +4,341 | **10.8% / +229** | 4.3% / +6,522 | **42.3% / -1,771** | +6,088 / 1,552 |
| B flat $450 | 0.2% / +2,419 | 0.8% / +1,701 | 0.2% / +2,419 | 1.6% / +460 | 3.3% / +2,452 | 23.8% / -1,631 | +5,418 / 1,903 |
| C = A (practice) | same as A | | | | | | |
| D $600/450/300 | 0.2% / +1,930 | 0.8% / +877 | 0.2% / +2,829 | 2.4% / +198 | 1.8% / +3,499 | 24.9% / -1,808 | +4,357 / 1,552 |
| E flat $300 | 0.2% / +1,358 | 0.4% / +842 | 0.2% / +1,358 | 0.7% / -252 | 1.1% / +1,428 | 13.5% / -1,726 | +3,052 / 1,722 |
| H2 = D + throttle | 0.2% / +1,930 | 0.7% / +871 | 0.2% / +2,829 | 1.7% / +180 | 1.5% / +3,472 | 20.8% / -1,977 | +4,357 / 1,552 |

**Episodes (n=90 that pass the gate, harsher):** stress, q2, r2, P(breach) in 30 trades:
- A 28.6%, B 9.4%, D 9.8%, E 2.1%, H2 5.8%.
- Normal: A 3.6%, D 1.0%, E 0.2%.

**Fewer trades per day (3 instead of 11-15) makes it stricter.** Episodes, stress, q2, r2: A 34.6%, D 12.8%, H2 7.4%, E 2.6%.
On r3 grades, every option stays under 3% (r2 exit), with or without the stress.

## Findings the debate needs
1. **The min-1-contract rule sets the real C risk** (§17: no skipping for stop width). Stops run from 8 to 366 pts (median 89).
   - A C trade with a 366-pt stop risks 1 MNQ = **$733**, 2.4x its $300 budget. That is the worst single trade under every option.
   - Rounding down costs the A+ budget a little: A+ $900 averages $829-850 of real risk.
2. **The §23 r3 proxy is very C-heavy.**
   - Taken-if-flat: A+ 6 (8%), B 8 (10%), C 53 (69%), no-trade 10 (13%).
   - Episodes: A+ 5 / B 12 / C 73 / no-trade 24.
   - Its order is right (r2-exit avg: A+ +0.89R, B +0.29R, C +0.12R), but on n=6/8, so grade dollars barely move the totals.
   - Quant's 2-point grade puts 18-19% of trades in A+ (79% 2R-first). That is where the size choice really matters.
3. **The r2 exit, not the sizing, is what protects the account the most.**
   - It turns 26 of 77 trades into +0.67R instead of a later full stop.
   - It cuts the actual max drawdown by 20-40% (taken-if-flat, r3; A: $2,530 → $1,552).
   - It cuts the 30-trade breach odds 3x or more in every option.
4. **The "full swap" stress (A+ ↔ C) misleads on the r3 mix.** 69% of trades are C and would draw A+ outcomes, so it looks optimistic.
   The stress used above is the one-way **A+ performs like C**. The swap columns are in `RISK_tables.md`.

## Method and assumptions
- **Sample:** quant.py's 114 episodes (its episode rule, scored on the first setup) and the 77 taken-if-flat trades.
  - Only trades passing the §23 gate (wave peak ≥ 0.20) are sized: 90 episodes and 67 taken-if-flat. The 10 taken-if-flat trades that
    fail the gate would not be traded by the new model.
- **Grade proxy (§23 points):** all five factors could be computed for every row. Quant's 2-point grade is run beside it as the fallback.
  - Trap: control_kind = trap at a strong pool (4H Open, PDH/L, Asia/London H/L) or a stacked level (`also_in_tol`).
  - Force: breaking-wave leg beyond the level ≥ 2x the mean 5m range of the 20 bars before the wave.
  - Volume: pullback 5m volume < break-candle volume.
  - Timing: within 60 min after 15:00, 00:00 or 06:30 PT.
  - Band: 0.30 ≤ peak < 0.40.
  - A peak ≥ 0.40 caps the grade at C.
  - §23's "no entries in the first 30 min" rule was **not** applied, so the timing point is generous (11-14 rows score it).
- **Outcomes, on 1m bars from the entry minute:**
  - 2R first-touch: quant's outcome. +2R vs the structural `stop`; same bar = stop; flat at 14:00 PT, marked to market.
  - r2-exit proxy: 2/3 off at +1R, then the stop goes to breakeven, and the last 1/3 runs to +2R or back to BE.
    The stop is checked first on every bar. No pyramid add, no grade-upgrade add, no R-ladder beyond BE. Results are +1.33 / +0.67 / -1R.
- **Size:** contracts = floor(grade $ / (stop pts x $2)), at least 1.
  - Cost $0.62 per side per MNQ ($1.24 a round turn per contract; approximate).
  - Partials are treated as fractions of the position.
- **Account:** the trailing max loss of $4,500 is end-of-day.
  - Floor = highest end-of-day closed balance - $4,500. It stops rising once it reaches the starting balance (Topstep lock).
  - A breach is a closed balance below the floor after any trade; open-trade heat is ignored. There is no daily loss limit.
  - In the bootstrap, trades are grouped into days at the sample rate: 11/day taken, 15/day episodes. A 3/day run is above.
- **Bootstrap:** 2,000 resamples with replacement, of n and of 30 trades.
  - A plain shuffle of the full sequence gives only P(breach), because the ending P&L can't change. That column is in `RISK_tables.md`.
  - Stress "A+ like C": an A+ trade keeps its A+ size but draws its R from the C pool.
- **Limits:**
  - 6 TradeDays (10/28-11/04, 1m data ends 11/03 19:48 PT), with the r1 generator's setups.
  - n(A+) = 5-22, so every grade-dependent number is wide.
  - Taken-if-flat lets trades from different levels overlap in time. Running several trades at once would add heat that this
    one-at-a-time model does not show.
