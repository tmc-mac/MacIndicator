# ES-4 Pre-registration (written 2026-10-10, before any backtest)
Team: ES-4 (MES, ES data). Lane: ML / STATISTICAL.

## Core concept
A frozen, strongly L2-regularized logistic regression (trained once on train-period data only) estimates the
probability that the next-30-minute return is positive from ~8 volatility-normalized features; trade only when
the probability is far from 0.5, with ATR-based stop/target and risk-fixed sizing.

## Features (all causal, computed at the decision bar close, normalized by ATR so scale-free)
r5, r15, r60 (returns over 5/15/60 bars / ATR60), distance from session (RTH-open anchored) VWAP / ATR,
distance from prior-day close / ATR, position within the last-120-bar range (0..1, centered), short-vs-long
realized vol ratio, minute-of-day (sin/cos of RTH time). Standardized with train mean/std (frozen).

## Label / model
y = 1 if close[t+30] > close[t]. LogisticRegression(C small, e.g. 0.05). Fit on 2021-09-27..2022-12-31
(inner train); 2023 is the pseudo-out-of-sample used to choose the single entry threshold and sanity check;
final weights are then refit on the full train period and frozen into model.json (no retraining at signal time).

## Entries
Decision every 5 bars (5-min grid) during RTH 09:45-15:00 ET. Long if p > 0.5+T, short if p < 0.5-T (single param T,
chosen on plateau, ~0.03-0.06). Market order at next open. One trade at a time (engine enforces).

## Exits
Stop = k_s * ATR30 (k_s~1.5), target = k_t * ATR30 (k_t~1.5), time exit 30 bars after entry, hard flat by 15:55 ET.

## Sizing
contracts = floor(RISK / (stop_distance_pts * $5)), RISK ~ $120 per trade, min 1, capped; target max DD << $1000.

## Filters
RTH only, no entries after 15:00 ET. No other filters planned.

## Overfit guards
Few features, strong regularization, single threshold, report sensitivity over C, T, k; accept only plateaus;
judge by pseudo-OOS 2023 and consecutive-quarter consistency.

## Amendments (rework) 2026-10-10
Gate failed (validate PF 0.97). Rework plan, same lane: refit the frozen logistic model on train + 2024-01..2024-06 (C=0.01),
score only on 2024-07..2025-06 (never fit on the scored window). Also consider higher threshold T and a simpler feature set
(drop time-of-day / vol-ratio). Pick by train+early-validation plateau, then one official re-validation.

## v2 amendments (2026-10-10)
Added RISK_KEY='risk', TUNABLE list. Model frozen (fit through 2024-06-30). Plan: walk-forward check (fit <=2023-06, test 2023-07..2024-06); declare no edge if pass>=50%/bust<=25% not reachable.
