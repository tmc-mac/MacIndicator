# Tournament team brief (read fully)

You are one of 12 teams in a futures-strategy tournament. Build a **profitable, risk-managed intraday/swing
strategy on 1-minute bars** that survives a simulated $50K prop-firm evaluation, repeatedly, on unseen data.

## Arena (identical for all)
$50,000 sim eval: target +$3,000, **trailing max drawdown $2,000 off the end-of-day equity peak (intraday touch = bust)**,
daily loss limit $1,250 (flatten + pause until next session), one position at a time, every entry has a stop,
no martingale / averaging down, max 40 micros, commissions excluded (gross), 1-tick slippage on market & stop fills.
NQ teams trade MNQ ($2/pt), ES teams trade MES ($5/pt). Sizing is FREE and part of your strategy.

**Match score** = net profit / max(intraday max drawdown, $500) over a 3-month unseen window. Bust => 0.
Must be net-positive with >= 20 trades. So: **small, steady drawdowns beat big spikes.** Size from stop distance /
volatility so a normal losing streak cannot approach $2,000 (aim for max DD well under ~$1,000) while still
making meaningful money (a good result is +$1.5k..+$3k per quarter with ~$400-800 DD).

## Validation gate (coordinator runs it on 2024-01-01..2025-06-30, account rules off, one fresh pass)
PF > 1.0, >= 100 trades, >= 0.5 trades/day. Missing any => one rework, then replaced.
Train = 2021-09-27..2023-12-31 (you may iterate on it). **You cannot see validation or later data**: the loader
physically truncates, and `run_team.py` refuses the validate window. Do not try to circumvent this.
Beware overfitting: prefer few parameters, plateau-shaped parameter sensitivity, logic you can explain.
Consecutive-quarter consistency matters more than a high backtest PF.

## What you deliver (in `tournament/teams/<TEAM>/`)
1. `prereg.md` — WRITE THIS FIRST, before running ANY backtest: team id, date (today 2026-10-10), core concept
   (one sentence — must be distinct from every other team's), entry rules, exit rules, filters, sizing logic.
   Do not edit it after your first backtest except by appending a dated "Amendments" section.
2. `strategy.py` — exposes `PARAMS` (dict) and `generate(d, params) -> signals` (see below).
3. `log.md` — append-only research log of every meaningful step and result (train numbers).
4. `final.md` — final summary: frozen parameters, train stats, rolling-eval stats, honest weaknesses.

## Engine API (`tournament/engine/engine.py`, import with sys.path insert; read it, it is short)
`d = E.load('NQ' or 'ES')` gives arrays `ts` (epoch s, UTC), `o,h,l,c,v`, `day` (CME session id, rolls 17:00 ET),
`minute_of_day_et` (ET clock minute 0..1439; 570 = 09:30), `dow`, `mult` ($/pt), `n`, and `d.idx(start,end)`.
Return `E.make_signals(bar, side, kind, px, stop, target, exit_by, cancel_by, contracts)` — arrays, one row per
intended trade. `bar` = index of the bar on whose CLOSE you decide; order is live from bar+1. side +1/-1.
kind 0 = market at next open; kind 1 = limit at `px` (cancelled after bar `cancel_by`). `stop` required (price).
`target` price or NaN. `exit_by` = absolute bar index of a forced time exit at that bar's close (use it for
session-flat logic). `contracts` int (capped 40). Signals that arrive while a trade/order is open are ignored.
**No lookahead**: a signal at bar i may use only data through bar i. `E.lookahead_check` verifies this by
truncation and `run_team.py` reports `lookahead_clean` — it must be True. Use numba (`@njit`) for loops; ~1.7M bars.

Run: `python3 tournament/engine/run_team.py <TEAM> train` -> raw stats (rules off) + rolling 3-month fresh-eval
stats (pass/bust/positive rate, median score). Use `E.run(d, sig, i0, i1)` for a single enforced eval, and
`E.rolling_evals` directly for more detail. Python 3 with numpy, pandas, numba, scipy, scikit-learn installed.

## Conduct
Original strategy only; public ideas/indicators are fine. Do not read other teams' folders. Stay within your lane's
core concept (declared in your prompt) so no two teams overlap. Finish with a SHORT report (<200 words): concept,
parameters count, train PF/trades/trades-per-day, rolling pass/bust/positive rates, known weaknesses.
Time-box: aim to finish within roughly 40-60 minutes of work.
