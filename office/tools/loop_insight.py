#!/usr/bin/env python3
"""Team Mac daily loop, terminal 2.3 additions (proposed patch; lives beside loop_daily.py as office/tools/loop_insight.py).

Two things the phone terminal 2.3 paints and that the daily run does not write yet:

  1. office/state/autopsy.json   every full stop of the last 20 TradeDays: its class, its per-minute path and three what-if rules
                                 (early exit at 120 s, break-even after +10, TP1 taken on touch), plus the same rules measured on the
                                 winners and the other trades of the same window, so a rule that saves losers shows what it costs.
  2. office.json -> experiments  per experiment: the expectation and the kill rule (copied, never rewritten), whether the journal can
                                 judge it, the rate and the TradeDays to a verdict, the kill-rule clauses with their numbers, the cases.

loop_daily.py calls extend() once, just before it writes office.json (see loop_daily.patch). Standard library only. Nothing here reads
the data repository: it works on the journal index (J), the ledger rows (trades) and the experiments document loop_daily already built.

Every dollar figure of a what-if is an ESTIMATE from 1-minute trade_state rows (close, running best, running worst). None is a result.
"""
import json
import math
import os

SCHEMA = 1
WINDOW_DAYS = 20
POINT_USD = 2.0
FEE_SIDE = 0.61                      # per contract per side, when the broker row carries no fee
TP1_DEFAULT = 15.0
EARLY_MIN, EARLY_PTS, EARLY_NEVER = 2.0, -10.0, 3.0        # early exit: first row at or after 120 s; close <= -10; never seen +3
BE_ARM = 10.0                        # break-even after +10
RUNNER_PLUS = 2.0                    # NY: the runner's stop after TP1 (entry +2); the TP1-on-touch figure for NY is a floor
MAX_BYTES = 150000                   # hard cap of autopsy.json; the page refuses a file over 262,144 bytes
CASES_MAX = 20
NY_BEST_ARM = 50.0                   # X-10: first lock step
# Classes are bands of the best excursion SEEN, in points. They are not named after a rule: TP1 was 15 pts away only from 10/30 on, and a
# best read from 20-second polls is a lower bound. Whether a stop reached ITS OWN TP1 distance is counted separately (ownTp1).
CLASSES = [("under3", "best seen under +3"), ("b3to10", "best seen +3 to +10"), ("b10to15", "best seen +10 to +15"),
           ("b15plus", "best seen +15 or more"), ("noReading", "no excursion reading")]
BARS = "trade_state 1m bars"
RULES = [("earlyExit", "early exit: -10 at 120 s, never +3"), ("beAfter10", "break-even after +10"), ("tp1OnTouch", "TP1 taken on touch")]


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) != float("inf") else None


def _r2(x):
    return None if x is None else round(float(x) + 0.0, 2)


def _r1(x):
    return None if x is None else round(float(x) + 0.0, 1)


def stop_class(t):
    """Class of a full stop from the ledger's best excursion (the largest reading of every journal source)."""
    m = t.get("mfePts")
    if m is None:
        return "noReading"
    if m >= TP1_DEFAULT and not t.get("tp1Hit"):
        return "b15plus"
    if m >= 10:
        return "b10to15"
    if m < 3:
        return "under3"
    return "b3to10"


def losing_stop(t):
    """A full stop for this file: the ledger's full-stop flag AND a losing close. A stop fill on the profit side (the stop had been moved)
    is listed under 'excluded', never among the stops."""
    return bool(t.get("fullStop")) and (t.get("net") is None or t["net"] < 0)


def state_rows(J, tid):
    """The trade's per-minute rows in k order: (k, minute after the fill, close pts, running best, running worst, row time)."""
    out = []
    for r in (J["by"].get(tid) or {}).get("trade_state") or []:
        k, m, c, b, w = _num(r.get("k")), _num(r.get("minAfterFill")), _num(r.get("closePts")), _num(r.get("best")), _num(r.get("worst"))
        if None in (k, m, c, b, w):
            continue
        out.append({"k": k, "min": m, "close": c, "best": b, "worst": w, "t": _num(r.get("t"))})
    out.sort(key=lambda r: (r["k"], r["min"]))
    seen, rows = set(), []
    for r in out:                    # one row per k (a later duplicate of the same minute is dropped)
        if r["k"] in seen:
            continue
        seen.add(r["k"])
        rows.append(r)
    return rows


def tp1_fill_ms(J, tid):
    for r in sorted((J["by"].get(tid) or {}).get("trade_manage") or [], key=lambda r: r.get("t") or 0):
        if r.get("code") == "TP1_FILLED" and _num(r.get("t")) is not None:
            return r["t"]
    return None


def _sgn(v, nd=2):
    return ("+" if v > 0 else "-" if v < 0 else "") + ("%.*f" % (nd, abs(v)))


def what_if(t, rows, tp1_ms=None):
    """The three what-if rules on one trade. Each: {"fires": True / False / None, "usd": new net, "savedUsd": new net - real net,
    "why": text, "atMin": minute after the fill where the rule acts}. fires None = cannot be told from the rows (why says so)."""
    c = t.get("contracts") or 3
    fee = t["fees"] if _num(t.get("fees")) is not None else round(FEE_SIDE * 2 * c, 2)
    net = t.get("net")
    stop_pts = _num(t.get("stopPts"))
    tp1_pts = abs(t["tp1"] - t["entry"]) if (_num(t.get("tp1")) is not None and _num(t.get("entry")) is not None) else TP1_DEFAULT
    rules = t.get("rules") or {}
    out = {}

    def res(fires, why=None, usd=None, at=None, **kw):
        d = {"fires": fires}
        if why:
            d["why"] = why
        if fires and usd is not None:
            d["usd"] = _r2(usd)
            d["savedUsd"] = _r2(usd - net) if net is not None else None
        if at is not None:
            d["atMin"] = _r1(at)
        d.update(kw)
        return d

    if not rows:
        why = "no per-minute rows for this trade"
        return {k: res(None, why) for k, _ in RULES}

    # ---- early exit
    ea = rules.get("earlyAdverse")
    if ea and ea.get("mode") == "exit":
        out["earlyExit"] = res(False, "rule already on: the bot's own check " + ("closed it" if ea.get("exited") else "kept it") +
                               (" at %s pts" % _sgn(ea["pts"]) if _num(ea.get("pts")) is not None else ""))
    else:
        r0 = next((r for r in rows if r["min"] >= EARLY_MIN), None)
        if r0 is None:
            out["earlyExit"] = res(False, "ended before the 120 s check")
        elif t.get("tp1Hit") and tp1_ms is not None and r0["t"] is not None and tp1_ms <= r0["t"]:
            out["earlyExit"] = res(False, "TP1 filled before the 120 s check")
        elif r0["close"] <= EARLY_PTS and r0["best"] < EARLY_NEVER:
            if stop_pts is not None and r0["worst"] <= -stop_pts:
                out["earlyExit"] = res(False, "the stop was reached in the same minute (%s)" % _sgn(r0["worst"]))
            else:
                out["earlyExit"] = res(True, "close %s at %.1f min, best %s" % (_sgn(r0["close"]), r0["min"], _sgn(r0["best"])),
                                       r0["close"] * c * POINT_USD - fee, r0["min"])
        else:
            out["earlyExit"] = res(False, "close %s at %.1f min" % (_sgn(r0["close"]), r0["min"]) if r0["close"] > EARLY_PTS else
                                   "had been %s by %.1f min" % (_sgn(r0["best"]), r0["min"]))

    # ---- break-even after +10
    i = next((n for n, r in enumerate(rows) if r["best"] >= BE_ARM), None)
    if i is None:
        out["beAfter10"] = res(False, "never +10 on the 1m rows (best %s)" % _sgn(rows[-1]["best"]))
    else:
        a = rows[i]
        prev_worst = rows[i - 1]["worst"] if i else 0.0
        if stop_pts is not None and a["worst"] <= -stop_pts:
            out["beAfter10"] = res(False, "the stop was reached in the minute it got to +10: the stop wins")
        else:
            j = next((n for n in range(i + 1, len(rows)) if rows[n]["close"] <= 0), None)
            if j is not None:
                f = rows[j]
                if t.get("tp1Hit") and tp1_ms is not None and f["t"] is not None and tp1_ms <= rows[j - 1]["t"]:
                    out["beAfter10"] = res(False, "TP1 filled first")
                elif t.get("tp1Hit") and tp1_ms is not None and f["t"] is not None and tp1_ms <= f["t"]:
                    out["beAfter10"] = res(None, "the TP1 fill and the close under the entry fall in the same minute (minute %d)" % int(f["min"]))
                elif t.get("tp1Hit") and tp1_ms is None:
                    out["beAfter10"] = res(None, "TP1 filled but its time is not in the journal")
                else:
                    out["beAfter10"] = res(True, "close %s at minute %.1f after %s" % (_sgn(f["close"]), f["min"], _sgn(rows[j - 1]["best"])), min(0.0, f["close"]) * c * POINT_USD - fee, f["min"],
                                           basis="priced at the 1-minute close that triggers it")
            elif t.get("tp1Hit"):
                out["beAfter10"] = res(False, "TP1 filled first")
            elif a["worst"] < prev_worst and a["worst"] <= 0 and i == len(rows) - 1:
                out["beAfter10"] = res(None, "%s and %s fall in the same minute (minute %d); the row cannot say which came first" % (_sgn(a["best"]), _sgn(a["worst"]), int(a["min"])))
            elif i == len(rows) - 1:
                out["beAfter10"] = res(None, "the trade ended before the next 1m row after %s" % _sgn(a["best"]))
            else:
                out["beAfter10"] = res(False, "no 1m close at or under the entry after %s" % _sgn(a["best"]))

    # ---- TP1 taken on touch
    tt = rules.get("tp1Touch")
    if t.get("tp1Hit"):
        out["tp1OnTouch"] = res(False, "TP1 filled")
    else:
        i = next((n for n, r in enumerate(rows) if r["best"] >= tp1_pts), None)
        touched = None
        if tt and tt.get("state") == "resolved":
            touched = bool(tt.get("touchedNotFilled"))
        if i is None and touched is not True:
            mfe = t.get("mfePts")
            if mfe is not None and mfe >= tp1_pts:
                out["tp1OnTouch"] = res(None, "%s seen by %s only, not on the 1m rows" % (_sgn(mfe), t.get("mfeSource") or "another source"))
            else:
                out["tp1OnTouch"] = res(False, "not touched (best %s)" % _sgn(rows[-1]["best"]))
        elif i is not None and stop_pts is not None and rows[i]["worst"] <= -stop_pts and rows[i]["worst"] < (rows[i - 1]["worst"] if i else 0.0):
            out["tp1OnTouch"] = res(False, "the stop was reached in the same minute: the stop wins")
        else:
            floor = t.get("session") == "ny"
            leg1 = max(1, int(round(c * 2.0 / 3.0))) if floor else c
            usd = (leg1 * tp1_pts + (c - leg1) * RUNNER_PLUS) * POINT_USD - fee
            at = rows[i]["min"] if i is not None else None
            out["tp1OnTouch"] = res(True, ("%d of %d out at %s, runner at %s: a floor" % (leg1, c, _sgn(tp1_pts), _sgn(RUNNER_PLUS))) if floor
                                    else "all %d out at %s" % (c, _sgn(tp1_pts)), usd, at, **({"floor": True} if floor else {}))
    return out


def _is_ny_late(t, LD):
    return LD.is_ny_late(t)


def build_autopsy(LD, J, trades, day, tdays, complete, data_note, generated_at):
    """autopsy.json for the window of the last WINDOW_DAYS TradeDays ending `day`. LD = the loop_daily module (time helpers)."""
    win = tdays[-WINDOW_DAYS:]
    wset = set(win)
    X = [t for t in trades if t["tradeDay"] in wset]
    FS = [t for t in X if losing_stop(t)]
    excluded = [t for t in X if t["fullStop"] and not losing_stop(t)]
    led_fs = [t for t in X if t["fullStop"]]
    fs_net = sum(t["net"] or 0 for t in FS)
    classes = []
    for k, label in CLASSES:
        g = [t for t in FS if stop_class(t) == k]
        bars = sum(1 for t in g if t.get("mfeSource") == BARS)
        classes.append({"k": k, "label": label, "n": len(g), "usd": _r2(sum(t["net"] or 0 for t in g)),
                        "share": _r2(sum(t["net"] or 0 for t in g) / fs_net) if fs_net else None,
                        "fromBars": bars, "fromLowerBound": 0 if k == "noReading" else len(g) - bars})
    # reached its OWN TP1 distance and TP1 did not fill (what X-08 counts); the distance is the trade's own, never an assumed 15
    def _own(t):
        if _num(t.get("tp1")) is None or _num(t.get("entry")) is None or t.get("mfePts") is None:
            return None
        return (not t.get("tp1Hit")) and t["mfePts"] >= abs(t["tp1"] - t["entry"]) - 1e-9
    own = [t for t in FS if _own(t) is True]
    own_tp1 = {"n": len(own), "usd": _r2(sum(t["net"] or 0 for t in own)), "unknown": sum(1 for t in FS if _own(t) is None)}
    re30 = [t for t in FS if t.get("afterFullStopMin") is not None]
    late = [t for t in FS if _is_ny_late(t, LD)]
    by_sess = {s: {"n": sum(1 for t in FS if t["session"] == s), "usd": _r2(sum(t["net"] or 0 for t in FS if t["session"] == s))} for s in LD.SESSIONS}

    # ---- the what-if rules on every trade of the window
    wi = {}
    for t in X:
        wi[t["id"]] = what_if(t, state_rows(J, t["id"]), tp1_fill_ms(J, t["id"]))
    agg = []
    for k, label in RULES:
        # two groups, so nothing the rule touches is left out: the full stops, and EVERY other trade of the window (winners and losers)
        g = {"stops": {"fires": 0, "savedUsd": 0.0, "unknown": 0, "n": 0},
             "others": {"changed": 0, "usd": 0.0, "unknown": 0, "n": 0, "winnersCut": 0, "winnersUsd": 0.0, "losersChanged": 0, "losersUsd": 0.0}}
        fs_ids = {t["id"] for t in FS}
        for t in X:
            r = wi[t["id"]][k]
            grp = "stops" if t["id"] in fs_ids else "others"
            g[grp]["n"] += 1
            if r["fires"] is None:
                g[grp]["unknown"] += 1
            elif r["fires"] and r.get("savedUsd") is not None:
                g[grp]["fires" if grp == "stops" else "changed"] += 1
                g[grp]["savedUsd" if grp == "stops" else "usd"] += r["savedUsd"]
                if grp == "others":
                    w = "winners" if (t["net"] or 0) > 0 else "losers"
                    g[grp]["winnersCut" if w == "winners" else "losersChanged"] += 1
                    g[grp][w + "Usd"] += r["savedUsd"]
        g["stops"]["savedUsd"] = _r2(g["stops"]["savedUsd"])
        for kk in ("usd", "winnersUsd", "losersUsd"):
            g["others"][kk] = _r2(g["others"][kk])
        agg.append({"k": k, "label": label, "basis": "1m rows", "stops": g["stops"], "others": g["others"],
                    "netUsd": _r2(g["stops"]["savedUsd"] + g["others"]["usd"]), "estimate": True})

    # ---- one card per stop, newest first
    stops = []
    prev_stop_exit = {}
    by_time = sorted(FS, key=lambda t: (t["_tEntry"], t["id"]))
    since_prev = {}
    for t in by_time:
        p = prev_stop_exit.get(t["tradeDay"])
        since_prev[t["id"]] = _r1((t["_tEntry"] - p) / 60000.0) if (p is not None and t["_tEntry"] >= p) else None
        if t["_tExit"]:
            prev_stop_exit[t["tradeDay"]] = t["_tExit"]
    for t in reversed(by_time):
        rows = state_rows(J, t["id"])
        plan = ((J["by"].get(t["id"]) or {}).get("trade_plan") or [None])[-1]
        ctl = _num(((plan or {}).get("control") or {}).get("score")) if isinstance((plan or {}).get("control"), dict) else None
        c = t.get("contracts") or 3
        sp = _num(t.get("stopPts"))
        d = t.get("_dir")
        mfe_at = None
        if rows and t.get("mfePts") is not None:
            top = max(r["best"] for r in rows)
            if abs(top - t["mfePts"]) < 0.005:
                mfe_at = next(r["min"] for r in rows if r["best"] == top)
        exit_pts = (t["exit"] - t["entry"]) * d if (_num(t.get("exit")) is not None and _num(t.get("entry")) is not None and d in (1, -1)) else None
        slip = (t["exit"] - t["stop"]) * d if (_num(t.get("exit")) is not None and _num(t.get("stop")) is not None and d in (1, -1)) else None
        stops.append({
            "id": t["id"][:8], "tradeDay": t["tradeDay"], "entryUtc": t["entryTime"], "session": t["session"], "side": t["side"],
            "level": t.get("level"), "event": t.get("event"), "grade": t.get("grade"), "controlScore": _r2(ctl),
            "stopPts": sp, "net": t["net"], "netSource": t.get("moneySource"), "r": _r2(t["net"] / (sp * c * POINT_USD)) if (sp and t["net"] is not None) else None,
            "minToStop": _r1(t["durationSec"] / 60.0) if t.get("durationSec") is not None else None,
            "mfePts": t.get("mfePts"), "mfeAtMin": _r1(mfe_at), "mfeSource": t.get("mfeSource"), "mfeLowerBound": t.get("mfePts") is not None and t.get("mfeSource") != BARS, "maePts": t.get("maePts"),
            "tp1Pts": _r2(abs(t["tp1"] - t["entry"])) if (_num(t.get("tp1")) is not None and _num(t.get("entry")) is not None) else None,
            "exitPts": _r2(exit_pts), "path": [r["close"] for r in rows], "pathMin": [_r1(r["min"]) for r in rows],
            "class": stop_class(t), "rankInDay": t.get("rankInDay"), "afterFullStopMin": t.get("afterFullStopMin"),
            "sincePrevStopMin": since_prev.get(t["id"]), "nyLate": _is_ny_late(t, LD), "slipPts": _r2(slip),
            "whatIf": wi[t["id"]]})
    doc = {
        "schema": SCHEMA, "generatedAt": generated_at, "tradeDay": day,
        "window": {"from": win[0] if win else None, "to": win[-1] if win else None, "tradeDays": len(win), "complete": bool(complete), "note": data_note},
        "totals": {"trades": len(X), "net": _r2(sum(t["net"] or 0 for t in X)), "fullStops": len(FS), "fullStopNet": _r2(fs_net),
                   "ledgerFullStops": len(led_fs), "ledgerFullStopNet": _r2(sum(t["net"] or 0 for t in led_fs)),
                   "fullStopsPer10": _r1(10.0 * len(FS) / len(X)) if X else None, "withPath": sum(1 for s in stops if s["path"])},
        "classes": classes,
        "ownTp1": own_tp1,
        "excluded": [{"id": t["id"][:8], "tradeDay": t["tradeDay"], "net": t["net"], "why": "stop fill on the profit side: the ledger flags it a full stop, it closed in profit"} for t in excluded],
        "overlays": [{"k": "reentry30", "leak": "L-07", "n": len(re30), "usd": _r2(sum(t["net"] or 0 for t in re30))},
                     {"k": "nyLate", "leak": "L-14", "n": len(late), "usd": _r2(sum(t["net"] or 0 for t in late))}],
        "bySession": by_sess,
        "whatIf": agg,
        "stops": stops,
        "dropped": {"paths": 0},
    }
    # hard cap: the oldest paths go first (the card then reads "path not in the file"), never a stop
    k = len(stops)
    while len(encode(doc)) > MAX_BYTES and k > 0:
        k -= 1
        if stops[k]["path"]:
            stops[k]["path"], stops[k]["pathMin"] = [], []
            stops[k]["pathDropped"] = True
            doc["dropped"]["paths"] += 1
    return doc


def encode(doc):
    """Compact, one stop per line: stable bytes, readable diffs."""
    head = {k: v for k, v in doc.items() if k != "stops"}
    s = json.dumps(head, ensure_ascii=False, separators=(",", ":"))
    rows = ",\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in doc.get("stops", []))
    return (s[:-1] + ',"stops":[\n' + rows + "\n]}\n").encode("utf8")


# ----------------------------------------------------------------------------- experiments


def _case(calc, c, tmap):
    t = tmap.get(c.get("id"))
    out = {"id": (c.get("id") or "")[:8] or None, "tUtc": c.get("_tUtc") or (t["entryTime"] if t else None), "session": (t or {}).get("session") or c.get("session"),
           "pts": None, "usd": None, "usdBroker": None, "state": None, "why": None}
    if calc == "earlyAdverseExit":
        out["pts"] = _num(c.get("exitPts"))
        out["usd"] = _num(c.get("usd"))
        out["usdBroker"] = _num(c.get("_broker"))
        sh = c.get("shadow")
        out["state"] = "would have hit the stop" if sh == "wouldHaveHitStop" else "would have reached TP1" if sh == "wouldHaveHitTp1" else "unresolved"
        out["why"] = c.get("why") if out["state"] == "unresolved" else None
    elif calc == "tp1AtrShadow":
        out["state"] = c.get("state")
        out["why"] = c.get("why")
    elif calc in ("runnerAllAtTp1", "runnerAtrTarget"):
        out["usd"] = _num(c.get("net"))
        out["state"] = c.get("exitReason")
    elif calc == "reentryAfterFullStop":
        out["usd"] = _num(c.get("net"))
        out["state"] = "%s min after a full stop" % c.get("minAfterStop") if c.get("minAfterStop") is not None else None
    elif calc == "runnerProfitLock":
        out["usd"] = _num(c.get("net"))
        out["state"] = c.get("reason") or "no exit row"
        out["why"] = ("TP2 reached afterwards" if c.get("cut") is True else None)
    else:
        out["usd"] = _num(c.get("net"))
    return out


def extend_experiments(LD, office_json, xdoc, J, trades, day, tdays):
    """Adds the scoreboard keys to every office.json -> experiments[] entry. The expectation and the kill rule are copied as they
    stand in experiments.json; nothing in experiments.json is changed."""
    win = set(tdays[-WINDOW_DAYS:])
    X = [t for t in trades if t["tradeDay"] in win]
    nwin = len(tdays[-WINDOW_DAYS:]) or 1
    tmap = {t["id"]: t for t in trades}
    by_id = {x.get("id"): x for x in xdoc.get("experiments", [])}
    for e in office_json.get("experiments", []):
        x = by_id.get(e.get("id"))
        if not x:
            continue
        run = x.get("running") or {}
        calc = (x.get("feeds") or {}).get("calc")
        sess = (x.get("feeds") or {}).get("sessions") or LD.SESSIONS
        n, min_n = run.get("n"), x.get("minN", LD.SMALL_N)
        e["leak"], e["started"] = x.get("leak"), x.get("started")
        e["expectation"], e["killIf"], e["verdictAt"] = x.get("expectation"), x.get("killIf"), x.get("verdictAt")
        e["resolved"], e["unresolved"] = run.get("resolved"), run.get("unresolved")
        # can the journal judge the kill rule at all?
        judge, why = True, None
        if calc in ("runnerAllAtTp1", "runnerAtrTarget"):
            cmp_n = sum(1 for c in run.get("cases") or [] if _num(((tmap.get(c.get("id")) or {}).get("rules") or {}).get("runnerShadow", {}).get("oldRuleUsdEst")) is not None)
            if not cmp_n:
                judge, why = False, "the old rule's pay on the same trades is not in the journal until runner_shadow rows arrive"
        elif calc == "controlParity":
            if n is None:
                judge, why = False, "needs controlScoreAlt rows: none in the journal yet"
        elif calc == "runnerProfitLock":
            judge, why = "partly", "the +2 stop comparison is not recorded (no bestAfterLock field); TP2 cuts are counted"
        elif calc is None or run.get("verdict") == "not measured":
            judge, why = False, "no calculator for this experiment in the daily tool"
        e["judgeable"], e["judgeWhy"] = judge, why
        # what n counts, in words (the bar is n of minN; the verdict rule may count something else)
        e["nCounts"], e["carried"], e["valueBasis"], e["valueBroker"] = None, None, None, None
        if calc in ("runnerAllAtTp1", "runnerAtrTarget"):
            carried = (run.get("resolved") or 0) + (run.get("unresolved") or 0)
            e["carried"] = carried
            e["nCounts"] = "trades under the rule that reached TP1; %d fills carried the rule, and the verdict rule counts live trades" % carried
            if calc == "runnerAllAtTp1":
                e["valueBasis"] = "the same on every all-out trade (TP1 distance x contracts x $2 - fees): this figure cannot move"
        elif calc == "earlyAdverseExit":
            e["nCounts"] = "live early exits"
            e["valueBasis"] = "estimate at the decision price, on the exits whose shadow resolved"
            tot, k_ = 0.0, 0
            for c in run.get("cases") or []:
                t = tmap.get(c.get("id"))
                q = ((J["by"].get(c.get("id")) or {}).get("early_adverse_exit") or [None])[-1] or {}
                if not t or t.get("net") is None or c.get("usd") is None:
                    continue
                n_c = t.get("contracts") or 3
                fee = t["fees"] if _num(t.get("fees")) is not None else round(FEE_SIDE * 2 * n_c, 2)
                alt = None
                if c.get("shadow") == "wouldHaveHitStop" and _num(q.get("stopPts")) is not None:
                    alt = -q["stopPts"] * n_c * POINT_USD - fee
                elif c.get("shadow") == "wouldHaveHitTp1" and _num(q.get("tp1Pts")) is not None:
                    alt = q["tp1Pts"] * n_c * POINT_USD - fee
                if alt is not None:
                    c["_broker"] = _r2(t["net"] - alt)
                    tot += c["_broker"]
                    k_ += 1
            e["valueBroker"] = _r2(tot) if k_ else None
        # rate and time to verdict (estimate)
        cnt, basis = None, None
        if calc == "nyLate":
            cnt = sum(1 for t in X if t["session"] == "ny" and LD.is_ny_late(t))
            basis = "%d NY trades entered after 09:00 PT in the last %d TradeDays" % (cnt, nwin)
        elif calc == "reentryAfterFullStop":
            cnt = sum(1 for t in X if t.get("afterFullStopMin") is not None and t["session"] in sess)
            basis = "%d same-side re-entries within 30 min of a full stop (%s) in the last %d TradeDays" % (cnt, " + ".join(s.capitalize() if s != "ny" else "NY" for s in sess), nwin)
        elif calc == "runnerProfitLock":
            cnt = sum(1 for t in X if t["session"] == "ny" and (t.get("mfePts") or 0) >= NY_BEST_ARM)
            basis = "%d NY trades with a recorded best of +%d or more in the last %d TradeDays (best is a lower bound)" % (cnt, NY_BEST_ARM, nwin)
        elif calc in ("runnerAllAtTp1", "runnerAtrTarget"):
            cnt = sum(1 for t in X if t["session"] in sess and t["tp1Hit"])
            basis = "%d trades that reached TP1 (%s) in the last %d TradeDays" % (cnt, " + ".join(s.capitalize() if s != "ny" else "NY" for s in sess), nwin)
        rate, eta = None, None
        if cnt is not None:
            rate = cnt / float(nwin)
        elif _num(n) is not None and x.get("started"):
            own = [d for d in tdays if d >= x["started"] and d <= day]
            if own and n > 0:
                rate = n / float(len(own))
                basis = "since start: %d case%s in %d TradeDay%s" % (n, "" if n == 1 else "s", len(own), "" if len(own) == 1 else "s")
        if rate and _num(n) is not None:
            eta = 0 if n >= min_n else int(math.ceil((min_n - n) / rate))
        e["rate"] = {"perTradeDay": _r2(rate), "basis": basis or ("since start" if x.get("started") else None), "etaTradeDays": eta, "estimate": True}
        # the kill rule's clauses with their numbers
        kc = []
        if calc == "earlyAdverseExit":
            res = [c for c in run.get("cases") or [] if c.get("usd") is not None]
            tp1 = sum(1 for c in res if c.get("shadow") == "wouldHaveHitTp1")
            kc.append({"clause": "share that would have reached TP1", "value": _r2(tp1 / float(len(res))) if res else None, "limit": 0.25, "n": len(res), "unit": "share"})
            kc.append({"clause": "net effect", "value": run.get("value"), "limit": 0, "n": len(res), "unit": "usd", "killBelow": True})
        elif calc in ("reentryAfterFullStop", "nyLate"):
            kc.append({"clause": "net of the cases (kill at zero or better)", "value": run.get("value"), "limit": 0, "n": n or 0, "unit": "usd"})
        e["killCheck"] = kc
        raw = [dict(c) for c in run.get("cases") or []]
        if calc in ("runnerAllAtTp1", "runnerAtrTarget"):      # n counts TP1 winners, the verdict rule counts live trades: no honest time to verdict
            e["rate"] = {"perTradeDay": None, "basis": "n counts TP1 winners; the verdict rule counts live trades", "etaTradeDays": None, "estimate": True}
        if calc == "earlyAdverseExit":             # the case's time is the exit decision, not the entry
            for c in raw:
                q = ((J["by"].get(c.get("id")) or {}).get("early_adverse_exit") or [None])[-1]
                if q and _num(q.get("t")) is not None:
                    c["_tUtc"] = LD.iso_utc(q["t"])
        cases = [_case(calc, c, tmap) for c in raw]
        cases.sort(key=lambda c: (c["tUtc"] or "", c["id"] or ""), reverse=True)
        e["casesTotal"] = len(cases)
        e["cases"] = [{k: v for k, v in c.items() if v is not None} for c in cases[:CASES_MAX]]      # a key that is absent reads as null (keeps office.json small)
    return office_json


def extend(LD, office, office_json, xdoc, J, trades, day, tdays, complete, data_note):
    """Called by loop_daily.main() just before office.json is written."""
    extend_experiments(LD, office_json, xdoc, J, trades, day, tdays)
    doc = build_autopsy(LD, J, trades, day, tdays, complete, data_note, office_json["generatedAt"])
    p = os.path.join(office, "state", "autopsy.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(encode(doc))
    return doc
