# ES-7 log (2026-10-10)
- NQ alignment causal: np.searchsorted(nq.ts, d.ts, 'right')-1 => latest NQ bar with ts <= ES bar ts; all rolling stats are trailing. (Truncating d cannot leak since NQ bars after d.ts[i] are never indexed for bar i. lookahead_check not run separately.)
- Hyp A (NQ-lead catch-up), default N=10,Z=2: combine x1/2/4: pass 0/1/14%, bust 73/99/86%; raw PF 0.85, 2387 trades.
- Grid (N 5/15/30, Z 1.5/2.5/3, H 15/60, both signs), design raw: sign=+1 PF 0.81-0.90 all negative; sign=-1 (spread mean-reversion) PF 0.68-0.78 all negative.
- Conclusion: no tradable edge after 1-tick slippage; the lead-lag is arbitraged below cost on 1m bars. Stopped, no further tuning.
