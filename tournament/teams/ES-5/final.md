# ES-5 final (2026-10-10)
Concept as finally traded: volume-confirmed, delta-proxy-agreeing trend continuation away from RTH VWAP
(MODE 2). The pre-registered absorption-fade (v1) and bar-climax continuation (v2) both failed on train
(PF 0.73 / 0.91) and are retained in code (MODE 0/1) but not used. See prereg.md amendments and log.md.
Frozen PARAMS: ZT=9 (|c-VWAP|/ATR60), VR=1.0 (10-bar vol / 300-bar mean), 10-bar CLV*v delta sign agrees, SW=6 (stop in ATR60),
TIME3=60 bars, MAXDAY3=3, COOL3=30, entry 10:00-15:00 ET, flat 15:55, RISK=$150/trade, MAXC=20.
Train: PF 1.14, 365 trades (0.63/d), net +$2.0k over 27 months raw, maxDD $1,196, lookahead clean.
Rolling 3-mo evals (52): pass 0%, bust 0%, positive 71%, median net +$261, median score 0.44.
Weaknesses: low edge (PF 1.14), earns little per quarter (far from the $3k target), 29% negative quarters,
sensitivity cliff at ZT=12 (plateau 8-10), order-flow proxies from 1m OHLCV carry little standalone signal
(delta divergence, opening delta, climax fades were all noise or negative). Trade-frequency gate (0.5/d) only just met.
