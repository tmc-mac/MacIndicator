# ES-3 final
Concept: fade of closes beyond the Asia (18:00-03:00 ET) range during London 03:00-05:00 ET (back toward the range), flat 08:30 ET.
Frozen params: buf 0, sk 2.0, tg 2.0, rmin .5, rmax 2.0, risk $150 (mostly 1 MES), entry window to 05:00, exit 08:30.
Train: net +2500, PF 1.27, 348 trades (0.61/d), max DD 1068. Rolling 3m: pass 0%, bust 0%, positive 65%, median net +$143.
Honest weaknesses: edge is weak (~+$7/trade, mostly time-exit drift; t-stat ~1.5), originally preregistered breakout had
no edge. Too small to pass the $3k target; lumpy (2022 Q4/2023 Q1 negative). Sensitivity is only roughly plateau-shaped.
Validation gate risk: PF>1 uncertain.
