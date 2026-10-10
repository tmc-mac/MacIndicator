# NQ-11 prereg (2026-10-10), written before any backtest
Team NQ-11, MNQ (data NQ). Lane: FIBONACCI RETRACEMENT PULLBACKS.
Concept: detect impulse legs causally from confirmed fractal swings (pivot of K bars each side, known K bars late);
when a leg (swing low->swing high or reverse) is >= LEGMIN x ATR(60) in size, place a limit order in the leg direction at
the FIB retracement (default 0.5; 0.382/0.618 explored as one param), stop beyond origin side at STOPFIB (default 0.786 + buffer),
target = leg extreme + EXT x leg (EXT=0 retest of the extreme, 0.272 extension).
Filters: RTH only (entries 09:45-15:15 ET), flat by 15:55 ET, limit cancelled after CANCEL bars or if price already exceeded the leg extreme.
Sizing: contracts = risk$ / (stop distance pts * $2), RISK_KEY='risk'.
Tunables: K, LEGMIN, FIB, STOPFIB, EXT, CANCEL. Honest outcome accepted if no edge on design; no data torturing.
