# ES-5 log
- 2026-10-10 prereg written, then v1 (absorption fade at range extreme) run on train: net -17030, PF 0.73, n=840 (1.46/d), maxDD 18.2k, rolling bust 83%, pos 0%. lookahead clean. Fade hypothesis rejected (consistently negative = the flow is continuation, not absorption).
- v2 continuation mode (MODE=1): n=1239 PF 0.91 net -7.6k. Scans K in {2.5,4,6} x TM in {1,2.5}: all PF 0.70-0.98 both modes; no signal beyond friction (2 ticks round trip on tight stops).
- Feature studies (train, forward return in pts): 30-bar delta proxy quintiles ~0; divergence price vs delta ~noise (n~200); first-30min delta vs rest-of-day corr -0.004. Far-from-VWAP + high volume => continuation (|z|>5: ~+/-1pt over 45 bars). Moving to v3.
- v3 scans (train raw): ZT 4-6 PF~1.0; ZT 8-10 PF 1.15-1.35 both halves >1 (plateau); ZT 12 dips (0.92-1.12), ZT16 n<100. Frozen ZT=9,VR=1.0,SW=6,TIME3=60,MAXDAY3=3,RISK=150 (a priori mid-plateau).
- Final run_team train: raw net=2006 PF=1.14 WR50% n=365 (0.63/d) maxDD=1196; rolling 52 windows: pass 0%, bust 0%, positive 71%, median net +261, median score 0.44; lookahead_clean True.
