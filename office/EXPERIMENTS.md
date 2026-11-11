# Experiments: expectations written before the data

Rules in `office/LOOP.md` section 6. One block per rule. The "kill if" line is fixed when the block is written and is not edited afterwards; a changed rule gets a new id.

Machine copy for the daily tool: `office/state/experiments.json`.

| Id | Leak | Rule | Mode | Started | Expectation | Verdict at | Kill if |
|---|---|---|---|---|---|---|---|
| X-01 | L-03 | TP1 = 0.75 x ATR(15m) at the fill, min 15, max 60 pts, break-even after +15 (`tp1AtrShadow`) | recording | 11/11 | More dollars per trade than the fixed +15 in NY | 20 resolved NY cases | Net per trade is not above the fixed target's, or full stops per 10 trades rise by more than 1 |
| X-02 | L-01 | Early exit: after 120 s, at -10 pts, if never seen +3 (`earlyAdverseExit`) | live | 11/11 | Smaller average loss; few exits that would have reached TP1 | 20 live exits | More than 1 in 4 early exits would have reached TP1, or net effect is negative |
| X-03 | L-02 | Asia / London: all contracts out at TP1 (`sessionRunner`) | live | 11/11 | More dollars per winning trade than the old runner rule | 20 live trades | Average is below what the old rule would have paid on the same trades |
| X-04 | L-04 | NY runner by ATR: stop 2 pts, target 2.0 x ATR (`sessionRunnerNy`) | live | 11/11 | Runner pays more than the old fixed runner | 20 live NY trades with a runner | Runner net is below the old rule's on the same trades |
| X-05 | L-05 | Control score by the indicator's formula (`levelsParity: pine`) | live | 11/11 05:14Z | More entries pass the 15m control gate; the added entries are not worse than the rest | 20 trades that the old formula would have blocked | Those trades lose more per trade than the rest |
| X-06 | L-07 | Stand down 30 min on the same side after a full stop, in Asia and London only (NOT a bot rule yet: the trades are still taken and counted) | counting | 11/11 06:55Z | The Asia / London same-side trades entered within 30 min of a full stop keep losing money as a group; the NY ones keep making money | 20 further Asia + London cases | The next 20 Asia + London cases net zero or better. NY is excluded from the start: in-sample NY re-entries made +$1,130.64 (n=22). (In-sample figures corrected 11/11 to the tool's last-20-TradeDays window; the expectation and kill rule are unchanged) |

## Not started (candidates, each needs an expectation before any build)

- L-08 volatility gauge and size-down (measure offline first).
- L-06 skipped wide-stop signals (count and outcome, from the journal).
