# Whole-contract re-run of the MacRisk sizing study (MacArthur, 11/04 05:50Z)

**Why:** `risk.py` treated the 2/3 partial as fractions of a position. The money lib's integer rule is:
- 1 MNQ → no partial; the runner only, with the stop to breakeven after +1R;
- n ≥ 2 → max(1, min(n−1, round(2n/3))).

Everything else is the same as `risk.py`: 67 taken-if-flat trades past the GRADE r3 wave-peak gate, the r2-exit proxy, $0.62/side, a $4,500 EOD trailing limit, and 2,000 resampled 30-trade runs.

**Script:** `risk_int.py` (imports `risk.py`). This is a six-day, in-sample simulation, not a breach probability.

Each cell is the breach odds within 30 trades / the median ending P&L. The last column is the share of trades sized at 1 MNQ / 2 MNQ.

| option | grade | whole contracts | stress (A+ like C) | fractional (old), normal ; stress | 1 / 2 MNQ |
|---|---|---|---|---|---|
| A $900/600/300 | r3 | 0.3% / +2917 | 2.2% / +1318 | 0.3% / +2622 ; 2.2% / +965 | 48% / 16% |
| B flat $450 | r3 | 0.5% / +2376 | 1.1% / +1842 | 0.2% / +2419 ; 0.8% / +1701 | 40% / 16% |
| D $600/450/300 | r3 | 0.4% / +2100 | 1.1% / +1117 | 0.2% / +1930 ; 0.8% / +877 | 49% / 19% |
| E flat $300 | r3 | 0.3% / +1290 | 0.5% / +1044 | 0.2% / +1358 ; 0.4% / +842 | 57% / 15% |
| A $900/600/300 | quant | 1.0% / +4442 | 12.8% / +86 | 1.0% / +4341 ; 10.8% / +229 | 27% / 21% |
| B flat $450 | quant | 0.5% / +2376 | 3.0% / +76 | 0.2% / +2419 ; 1.6% / +460 | 40% / 16% |
| D $600/450/300 | quant | 0.4% / +2767 | 4.4% / −206 | 0.2% / +2829 ; 2.4% / +198 | 40% / 22% |
| E flat $300 | quant | 0.3% / +1290 | 1.7% / −681 | 0.2% / +1358 ; 0.7% / −252 | 57% / 15% |

**Read:**
- Whole contracts barely move the medians, and breach odds rise slightly.
- At flat $450, **56% of trades are 1–2 MNQ** because structural stops are wide (median 89 pts). The designed 2/3 partial only happens at 3+ MNQ.
- Under the quant stress, every option earns about $0 over 30 trades. The edge itself is still unproven.
