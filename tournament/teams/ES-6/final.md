# ES-6 final (MES) - 15:50 close-window momentum
Concept: time-of-day effect. If ES moved >= 3x R1 (R1 = mean 1-min range of prior 60 bars) from the 14:30 ET close to the 15:50 close,
enter in that direction at 15:51 open (MOC imbalance continuation), stop 5*R1, no target, flat at 15:59-16:00 bar close. Weekdays, 1 trade/day max.
Sizing: contracts = floor(160 / (stop_pts*5)), min 1.
Frozen params: moc_k=3, moc_stop=5, risk_usd=160, lookback=60, anchor 80 min (14:30). use_a=False (release-impulse module A at 08:30/10:00/14:00 dropped: PF 1.2 / 0.64 / 0.41 continuation; fades PF ~0.35).
Train: net +2594, PF 1.34, 336 trades (0.58/d), WR 53%, maxDD 969, lookahead clean.
Rolling 3-mo evals (52): pass 0%, bust 0%, positive 77%, median score 0.70, median net +352.
Quarters positive 7/9 (see log). Long +1463 / short +404.
Weaknesses: modest return per quarter (~$350 median; never reaches +3k target within 3 months); concept reduced to one window after
event-release modules failed (amended prereg disclosed); effect size modest and depends on a single daily trade; Tue/Wed flat; k/stop chosen on train
(plateau-shaped, PF 1.16-1.38 across grid). Raising risk raises DD proportionally (200 -> DD 1256).
