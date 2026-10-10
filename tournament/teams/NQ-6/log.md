# NQ-6 log (train 2021-09-27..2023-12-31, raw = rules off)
- Prereg written, then first run with prereg params (risk 150, tm 1.5): PF1.30 n526 (0.90/d) net12487 maxDD3075; rolling pass.43 bust.19 pos.58 -> too much risk.
- Regime ablation (risk 150): all-fade thr=0 PF1.16 net7800; all-breakout thr=9 PF1.05 net2071; mixed thr=1.0 PF1.30 -> the switch adds value.
- thr 0.8/1.2 worse (PF1.18/1.11): THR sensitivity is peaked at ~1.0 (0.9 looked better, not adopted).
- risk sweep: 150/100/75/50 -> maxDD 3075/2100/1736/1551, bust .19/.02/0/0 (PF flat ~1.29): risk is pure scaling.
- tm 1.0/1.5/2.0/2.5: PF 1.26/1.30/1.33/(1.38 at risk60). fw 10/15/25 flat (PF1.29-1.30). lookback 10/20/40: 1.20/1.30/1.25.
- Frozen: risk 60, tm 2.0 (others per prereg). Result: PF1.34 n526 net8790 maxDD1729; rolling pass .08 bust 0 pos .77 median score 1.32.
- Quarterly net: +979, +1650, +991, +2507, +1313, -532, +1286, +284, +314 (8/9 positive).
