# NQ-8 prereg (2026-10-10)
Team NQ-8, MNQ (data NQ). Core concept: Donchian channel-breakout trend following on 1-min bars.
Entry: at bar close, if close > highest high of prior N bars (N=lookback, ~120 min) go long; if close < lowest low of prior N bars go short.
Only during entry window (ET 09:45-14:30), max 2 entries/session, no re-entry same side after a stop-out that day.
Stop: stop_atr * ATR(60 1-min bars) from entry (price-wise from the breakout close). Target: tgt_r * stop distance (R multiple).
Exit: forced flat at 15:55 ET.
Filter: breakout channel width must be >= minw * ATR (avoid dead range).
Sizing: contracts = floor(risk / (stop_pts*2)), min 1, cap 40. RISK_KEY='risk'.
TUNABLE: N, stop_atr, tgt_r, atr_n, minw, start, end.
Plan: coarse grid on design window only, pick plateau, size via combine_team. If no sizing gives pass>=40%/bust<=30% on design, report no edge.
