"""Office formulas on edge r1.7 post_exit rows (X-02, X-03, X-04, X-10, full-stop what-ifs).
Pure standard library. Every function takes ONE post_exit row (a dict). Prices and points are as the row gives them:
points from the fill in the trade direction (favourable positive), buckets of one minute.
"""
import math

PV = 2.0                       # MNQ dollars per point per contract (the bot's pointValue)
COST_RT = 2 * (0.36 + 0.25)    # broker costs per contract round trip (CONFIG.brokerCosts): 1.22


def buckets(row):
    """[(start_ms, hi_pts, lo_pts)] in time order. Bucket 0 is the fill minute; the exit minute mixes prices before and after the exit."""
    return [(row["pathFrom"] + i * row["pathStepMs"], hi, lo) for i, hi, lo in row["path"]]


def old_runner(row, bar_order="low_first"):
    """What the OLD runner rule would have paid its one runner contract, in points per contract, on this trade's path.
    Old rule: all contracts but one leave at TP1; the runner's stop rests at offset(peak) = max(lock, floor(peak/step)*step - lock) points from the fill, where peak
    is the best price since TP1 (at least TP1), so it trails in `step` steps; the runner is flat at the end of the follow-up.
    The stop applies from the bucket AFTER the one in which TP1 was reached (the bot's own rule). The order of high and low inside a one-minute bucket is unknown:
    bar_order = 'low_first' (the minute's low is tested against the stop of the PREVIOUS peak, then the high counts: the shadow's own rule) or 'high_first' (the
    minute's high raises the stop first, then the low is tested). Neither is the better case for the old rule: report both and call a verdict only when they agree.
    Runs only on trades that reached TP1 (oldRule.tp1Seen or tp1FilledAt); every other trade is 'same'.
    Returns {kind, pts, at}: kind runner_stop | horizon_end | same (TP1 never reached) | unknown (no path or no old-rule numbers)."""
    o = row.get("oldRule")
    if not o or not row.get("path"):
        return {"kind": "unknown", "pts": None, "at": None}
    if not o.get("tp1Seen") and o.get("tp1FilledAt") is None:
        # The trade ended before TP1 (early exit, stop, no-progress ...): the old and the live rule are the same trade. The path AFTER the exit
        # may touch TP1, but the old rule never held a runner then (the bot's runner_shadow says "same").
        return {"kind": "same", "pts": None, "at": None}
    tp1, lock, step = row["tp1Pts"], o["lockPts"], o["stepPts"]
    off = lambda pk: max(lock, math.floor(pk / step + 1e-9) * step - lock)
    phase, peak = "pre", None
    fill_t = o.get("tp1FilledAt")
    for t, hi, lo in buckets(row):
        if phase == "pre":
            if hi >= tp1 - 1e-9:
                phase, peak = "run", max(hi, tp1)
            elif fill_t is not None and t + row["pathStepMs"] > fill_t:
                phase, peak = "run", tp1            # TP1 filled though the polled prices did not show the touch
            continue
        if bar_order == "high_first" and hi > peak:
            peak = hi
        if lo <= off(peak) + 1e-9:
            return {"kind": "runner_stop", "pts": off(peak), "at": t}
        if hi > peak:
            peak = hi
    if phase == "pre":
        return {"kind": "same", "pts": None, "at": None}
    return {"kind": "horizon_end", "pts": row.get("lastPts"), "at": row.get("lastAt")}


def old_rule_whole_trade(row, bar_order="low_first"):
    """The whole trade under the old rule, points per contract and net dollars: (n-1) contracts at TP1 + the runner."""
    r = old_runner(row, bar_order)
    n = row["contracts"]
    if r["kind"] in ("same", "unknown") or r["pts"] is None or not n or n < 2:
        return {**r, "wholePts": None, "netUsd": None}
    whole = round(((n - 1) * row["tp1Pts"] + r["pts"]) / n, 2)   # rounded to 2 decimals before the dollars, as the bot's runner_shadow row does
    return {**r, "wholePts": whole, "netUsd": round(whole * n * PV - COST_RT * n, 2)}


def x03_x04_case(row, live_net_usd):
    """One trade's contribution to X-03 (runnerMode allAtTp1) or X-04 (atrTarget): live net (the ledger's broker net) minus the old rule's net.
    Positive = the live rule paid more. TP1 never reached = the two rules are the same trade: diff 0 (counted, not skipped).
    Returns {status, diff_lowfirst, diff_highfirst}: the diff under each bar-order assumption (see old_runner). status: ok | same (diff 0) |
    open (the follow-up was cut before the old runner ended: excluded) | unknown (no path, no old-rule numbers, or no live net: excluded)."""
    if row.get("runnerMode") not in ("allAtTp1", "atrTarget"):
        return None
    a, b = old_rule_whole_trade(row, "low_first"), old_rule_whole_trade(row, "high_first")
    if a["kind"] == "same":
        return {"status": "same", "diff_lowfirst": 0.0, "diff_highfirst": 0.0}
    if a["kind"] == "unknown" or a["netUsd"] is None or live_net_usd is None:
        return {"status": "unknown", "diff_lowfirst": None, "diff_highfirst": None}
    status = "open" if a["kind"] == "horizon_end" and row.get("cut") else "ok"
    return {"status": status, "diff_lowfirst": round(live_net_usd - a["netUsd"], 2), "diff_highfirst": round(live_net_usd - b["netUsd"], 2)}


def x03_x04_verdict(cases):
    """cases = [x03_x04_case(...)] for the trades under ONE rule. Mean diff per trade over the trades with status ok or same ('same' counts 0),
    under both bar-order assumptions. keep = both means >= 0; kill = both < 0; otherwise undetermined."""
    use = [c for c in cases if c and c["status"] in ("ok", "same")]
    if not use:
        return None
    a = sum(c["diff_lowfirst"] for c in use) / len(use)
    b = sum(c["diff_highfirst"] for c in use) / len(use)
    verdict = "keep" if min(a, b) >= 0 else "kill" if max(a, b) < 0 else "undetermined (the two bar-order assumptions disagree in sign)"
    return {"n": len(use), "excluded": len([c for c in cases if c]) - len(use), "mean_diff_lowfirst": round(a, 2), "mean_diff_highfirst": round(b, 2), "verdict": verdict}


def x02_class(row):
    """X-02 early exit (exitReason EARLY_EXIT): in the 60 minutes after the exit, did price touch TP1 before the original stop?
    Minute resolution: the same minute for both = 'unknown_order'."""
    ft = row["post"]["firstTouch"]
    t1, st = ft["tp1"], ft["stop"]
    if t1 is None and st is None:
        return "neither"
    if t1 is not None and (st is None or t1 < st):
        return "would_have_hit_tp1"
    if st is not None and (t1 is None or st < t1):
        return "would_have_hit_stop"
    return "unknown_order"


def stop_tp_whatif(row, stop_pts, tp_pts):
    """What-if for ANY stop / TP distance on the same path, from the fill to the end of the recorded path: which came first (full-stop what-ifs: a wider or
    tighter stop). Minute resolution, pessimistic on a shared minute (the stop wins). 'neither' = still open at the end of the recorded path."""
    for t, hi, lo in buckets(row):
        if lo <= -stop_pts + 1e-9:
            return {"result": "stop", "at": t}
        if hi >= tp_pts - 1e-9:
            return {"result": "tp", "at": t}
    return {"result": "neither", "at": None}


def runner_plus2(row):
    """X-10: what the old +2 runner stop would have done: after TP1 (price touch) the runner stop sits at +2 points from the fill; TP2 = row tp2Price.
    Returns {kind: stop2 | tp2 | open, pts}. Minute resolution, stop first on a shared minute."""
    tp1 = row["tp1Pts"]
    tp2 = abs(row["tp2Price"] - row["fill"]) if row.get("tp2Price") is not None else None
    run = False
    for t, hi, lo in buckets(row):
        if not run:
            if hi >= tp1 - 1e-9:
                run = True
            continue
        if lo <= 2 + 1e-9:
            return {"kind": "stop2", "pts": 2}
        if tp2 is not None and hi >= tp2 - 1e-9:
            return {"kind": "tp2", "pts": round(tp2, 2)}
    return {"kind": "open", "pts": row.get("lastPts")}
