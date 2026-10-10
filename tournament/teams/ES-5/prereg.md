# ES-5 preregistration (2026-10-10)
Instrument: MES ($5/pt), data ES, 1-minute bars.

## Core concept (one sentence)
Order-flow proxy absorption/climax reversal: a volume spike at a rolling-range extreme where the close location
value (volume-delta proxy, CLV x volume) shows the aggressive side was absorbed (bar closes back against its
extreme) is faded, i.e. high effort with poor result at a value extreme.

## Definitions (all use data through the decision bar only)
- clv = (2c-h-l)/(h-l) in [-1,1]; delta_proxy = clv * v.
- volratio = v / mean(v, prior VW=60 bars). atr = mean true range over AW=30 bars.
- Range extreme: low of bar is <= lowest low of prior RW=60 bars + LOC*(rolling range) (near bottom), mirror for top.
  LOC = 0.15 of the 60-bar range.

## Entry
LONG on bar close when: volratio >= K (2.5); bar low in bottom LOC of 60-bar range (or makes new low);
clv >= +0.2 (closed off its low = sell aggression absorbed; delta proxy positive despite probing low);
bar range >= 0.8*atr (it was a real probe). SHORT mirrors (clv <= -0.2, top of range).
Market entry at next open. Regular session only 09:45-15:30 ET, no new entries after 15:30.
Max 3 trades per session day, cooldown 10 bars after an exit signal.
## Exit
Stop: beyond signal-bar extreme by 0.25*atr. Target: TM=1.5 x risk distance. Time exit 45 bars after entry.
Forced flat at 15:55 ET.
## Sizing
Contracts = floor(RISK$ / (stop distance pts * 5)), RISK$=120, min 1, max 20.
## Parameters (7 core): VW 60, K 2.5, RW 60, LOC 0.15, clv thresh 0.2, TM 1.5, time 45. Stop pad 0.25atr, RISK 120.
Plateau-shaped sensitivity to be checked on train only; no tuning for single best.

## Amendments
### 2026-10-10 (after v1 train backtest: PF 0.73, fade rejected)
Test the mirror hypothesis (pre-stated as a single flip, not a search): volume-delta CONTINUATION. Same signal bar
(volratio>=K, clv strong, bar at range extreme) but trade in the direction of the bar's close location:
bar at top of range with clv>=+CLV -> LONG (aggressive buying accepted), mirror short. Stop beyond opposite bar extreme
(bar low - pad*atr), target TM*risk, rest unchanged. Params unchanged.
### 2026-10-10 (after v2 continuation: PF 0.91 K=2.5; scans of K/TM on bar-climax variants all PF<1; feature studies on train)
Feature studies (no trading) showed: delta-proxy divergence and opening-delta carry no signal; but far-from-RTH-VWAP
excursions (|c-vwap|/atr60 large) with elevated 10-bar volume show forward continuation (effort confirms result).
v3 (MODE 2, replaces bar-climax): VWAP-distance volume-confirmed trend. LONG when z=(c-RTH VWAP)/atr60 >= ZT AND
10-bar volume / (300-bar mean volume) >= VR AND 10-bar delta proxy (sum clv*v / sum v) > 0 (flow agrees); short mirrored.
Stop = SW*atr60 away from close, no target, time exit 45 bars, flat 15:55, max 2 entries/day, cool 30 bars.
Sizing: RISK$ / (stop pts * 5). Entry window 10:00-15:00 ET.

## v2 amendments (2026-10-10)
Brief V2 adopted: added RISK_KEY='risk' (renamed from RISK), TUNABLE list, MAXC raised to 40. Strategy logic unchanged (MODE 2).
