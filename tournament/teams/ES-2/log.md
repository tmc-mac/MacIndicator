# ES-2 log (train 2021-09-27..2023-12-31, rules off unless noted)
- v1 prereg params (L15 K2.5 stop1.5u tgt1.0u t30 risk100): net -8484 PF 0.76 WR56% n921 (1.6/d) DD 8488; rolling pos 4%. Fails. lookahead clean.
- Sweep 1 (72 combos: L{10,30,60} K{2,2.5,3} stop{1.5,3}u tgt{1,2}u tmax{30,60}), train raw: nearly all negative; best L60 K2 stop1.5 tgt2 t60 net+889 PF1.05 DD1256 (noise-level). Short-horizon z-fade has ~no edge on MES after 1-tick slippage; shorter L worse. Next: longer horizons + reversal confirmation (amendment appended to prereg).
