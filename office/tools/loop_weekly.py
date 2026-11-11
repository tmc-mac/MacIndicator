#!/usr/bin/env python3
"""Team Mac weekly roll-up: office/state/ledger.json -> office/reviews/weekly/<ISO week>.md and office.json 'weekly'.

    python3 -I office/tools/loop_weekly.py --week 2026-W46
    python3 -I office/tools/loop_weekly.py --week latest

Reads only what the daily tool wrote (ledger.json, experiments.json) plus the kill-rule text in office/EXPERIMENTS.md.
It reruns nothing and reads no journal. A week is the ISO week of the TradeDay (a Sunday-evening trade belongs to
Monday). Everything in the card uses TradeDays up to the end of that week, so an old week can be re-run.
The "Decisions for Mac" section sits between two marker comments; once somebody edits it by hand the tool keeps
that text and never writes over it.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loop_daily as ld  # noqa: E402

LEAK_DECISION_USD = 500.0     # a leak class that lost more than this in the week goes to "Decisions for Mac"
MAX_DECISIONS = 3
READY_DAYS = 10               # readiness line: average net per TradeDay over this many TradeDays
MARK_START = "<!-- decisions:start hash=%s -->"
MARK_END = "<!-- decisions:end -->"
RE_BLOCK = re.compile(r"<!-- decisions:start hash=([0-9a-f]+) -->\n(.*?)\n<!-- decisions:end -->", re.S)

# ----------------------------------------------------------------------------- pure helpers (unit tested)


def _ms(iso):
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$", iso or "")
    return ld._utc_ms(*[int(g) for g in m.groups()[:5]]) + int(m.group(6)) * 1000 if m else None


def week_of(day):
    return ld.iso_week(day)


def prev_week(week):
    y, w = int(week[:4]), int(week[6:])
    return ld.iso_week((datetime.date.fromisocalendar(y, w, 1) - datetime.timedelta(days=7)).isoformat())


def week_range(week):
    y, w = int(week[:4]), int(week[6:])
    mon = datetime.date.fromisocalendar(y, w, 1)
    return mon.isoformat(), (mon + datetime.timedelta(days=4)).isoformat()


def stop_streak(trades_by_day):
    """Worst run of full stops in a row inside one TradeDay, and the most full stops in one TradeDay.
    trades_by_day: {day: [trades in entry order]}. Returns {"streak", "streakDay", "mostInDay", "mostDay"}."""
    out = {"streak": 0, "streakDay": None, "mostInDay": 0, "mostDay": None}
    for d in sorted(trades_by_day):
        run = n = 0
        for t in trades_by_day[d]:
            run = run + 1 if t["fullStop"] else 0
            n += 1 if t["fullStop"] else 0
            if run > out["streak"]:
                out["streak"], out["streakDay"] = run, d
        if n > out["mostInDay"]:
            out["mostInDay"], out["mostDay"] = n, d
    return out


def readiness(cur, day_nets):
    """The readiness arithmetic: what the open chain still needs and how many TradeDays that is at the average of
    day_nets (the last READY_DAYS complete TradeDays). No forecast: days is None when the average is not positive."""
    if not cur or cur["status"] != "open":
        return {"need": None, "avgPerDay": None, "n": len(day_nets), "days": None, "status": cur["status"] if cur else None}
    need = round(cur["target"] - cur["profit"], 2)
    avg = round(sum(day_nets) / len(day_nets), 2) if day_nets else None
    days = None
    if avg is not None and avg > 0 and need > 0:
        days = int(-(-need // avg))
    return {"need": need, "avgPerDay": avg, "n": len(day_nets), "days": days, "status": "open"}


def readiness_line(r):
    if r["status"] is None:
        return "No virtual combine of the chain had started by the end of this week."
    if r["status"] != "open":
        return "The current chain is %s: nothing left to reach on it." % r["status"]
    small = ", small" if r["n"] < ld.SMALL_N else ""
    if r["avgPerDay"] is None:
        return "To pass, the current chain needs %s; there is no complete TradeDay yet to take an average from." % ld.usd(r["need"])
    if r["days"] is None:
        return "To pass, the current chain needs %s; the last %d days' average is %s per day (n=%d days%s), and at that average it does not get there." % (
            ld.usd(r["need"]), r["n"], ld.usd(r["avgPerDay"], True), r["n"], small)
    return "To pass, the current chain needs %s in %d more day%s at the last %d days' average of %s per day (n=%d days%s)." % (
        ld.usd(r["need"]), r["days"], "" if r["days"] == 1 else "s", r["n"], ld.usd(r["avgPerDay"], True), r["n"], small)


def block_hash(text):
    return hashlib.sha256(text.strip().encode("utf8")).hexdigest()[:12]


def merge_decisions(generated, existing_card):
    """The decisions block to write. If the card on disk holds a block whose text no longer matches the hash in its
    marker, somebody edited it by hand: that block is returned unchanged (marker included). Otherwise the generated
    text is wrapped with a fresh hash. Returns (block, kept_by_hand)."""
    m = RE_BLOCK.search(existing_card or "")
    if m and block_hash(m.group(2)) != m.group(1):
        return m.group(0), True
    g = generated.strip()
    return "%s\n%s\n%s" % (MARK_START % block_hash(g), g, MARK_END), False


def leak_rank(trades):
    g = {}
    for t in trades:
        if t.get("net") is not None and t["net"] < 0:
            k = t.get("leak") or "unclassified"
            if k == "unclassified":
                k = "unclassified: %s" % (t.get("leakWhy") or t.get("exitReason"))
            e = g.setdefault(k, {"n": 0, "usd": 0.0, "bySession": {s: {"n": 0, "usd": 0.0} for s in ld.SESSIONS}})
            e["n"] += 1
            e["usd"] += t["net"]
            if t.get("session") in e["bySession"]:
                e["bySession"][t["session"]]["n"] += 1
                e["bySession"][t["session"]]["usd"] += t["net"]
    return sorted(g.items(), key=lambda kv: (kv[1]["usd"], kv[0]))


def week_stats(trades, days):
    """trades: the week's ledger rows in entry order; days: the week's TradeDays present in the data."""
    sc = ld.score(trades)
    by_day = {d: [t for t in trades if t["tradeDay"] == d] for d in days}
    nets = {d: round(sum(t["net"] or 0 for t in by_day[d]), 2) for d in days}
    best = max(days, key=lambda d: (nets[d], d)) if days else None
    worst = min(days, key=lambda d: (nets[d], d)) if days else None
    sc.update({"days": len(days), "netPerDay": round(sc["net"] / len(days), 2) if days else None,
               "stopsPer10": round(10.0 * sc["fullStops"] / sc["trades"], 1) if sc["trades"] else None,
               "bestDay": {"day": best, "net": nets[best]} if best else None, "worstDay": {"day": worst, "net": nets[worst]} if worst else None,
               "bySession": {s: ld.score([t for t in trades if t["session"] == s]) for s in ld.SESSIONS},
               "streak": stop_streak(by_day), "dayNets": nets})
    return sc


QUIET_STATUSES = ("live", "recording", "kept", "killed")   # a leak with a rule already live or recording raises no item by dollars alone


def decision_items(xs, leaks_week, statuses, partial):
    """The generated decision list (before the cap). xs: experiments with state / line; leaks_week: leak_rank() output;
    statuses: {leak id: register status}. A partial week raises nothing. Returns (items, quiet leak ids over the line)."""
    if partial:
        return [], []
    dec, quiet = [], []
    for x in xs:
        if x["state"] == "verdict":
            dec.append("**%s %s** has its %d cases (value %s). %s Decide: keep, or switch it off." % (
                x["id"], x["title"], x["minN"], "unknown" if x["value"] is None else ld.usd(x["value"], True), x["line"]))
    for k, v in leaks_week:
        if -v["usd"] > LEAK_DECISION_USD:
            st = statuses.get(k, "observed")            # a class with no register row is a new, observed leak
            if st in QUIET_STATUSES:
                quiet.append(k)
                continue
            dec.append("**%s** (%s) lost %s on %d trade%s this week (n=%d%s), over the $%d line. Decide whether its next step in office/LOOPHOLES.md goes ahead now." % (
                k, st, ld.usd(-v["usd"]), v["n"], "" if v["n"] == 1 else "s", v["n"], small(v["n"]), LEAK_DECISION_USD))
    return dec, quiet


def kill_rules(path):
    out = {}
    try:
        for line in open(path, encoding="utf8"):
            m = re.match(r"\|\s*(X-\d+)\s*\|(.*)\|\s*$", line)
            if m:
                out[m.group(1)] = re.sub(r"[*`]", "", m.group(2).split("|")[-1]).strip()
    except OSError:
        pass
    return out


# ----------------------------------------------------------------------------- the run


def small(n):
    return ", small" if n < ld.SMALL_N else ""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Team Mac weekly roll-up")
    ap.add_argument("--week", required=True, help="ISO week like 2026-W46, or 'latest'")
    ap.add_argument("--out", default=None, help="office directory (default: the one this tool lives in)")
    ap.add_argument("--combine-start", default=ld.COMBINE_CHAIN_START)
    a = ap.parse_args(argv)
    office = os.path.abspath(a.out) if a.out else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        led = json.load(open(os.path.join(office, "state", "ledger.json"), encoding="utf8"))
    except (OSError, ValueError):
        raise SystemExit("office/state/ledger.json is missing: run loop_daily.py first")
    dinfo = led.get("tradeDays") or []
    if not dinfo:
        raise SystemExit("ledger.json has no tradeDays list: re-run loop_daily.py (it writes one)")
    all_days = [d["day"] for d in dinfo]
    complete = {d["day"]: d["complete"] for d in dinfo}
    trades = led["trades"]
    for t in trades:
        t["_tEntry"], t["_tExit"] = _ms(t["entryTime"]), _ms(t["exitTime"])
    trades.sort(key=lambda t: (t["_tEntry"], t["id"]))
    week = week_of(all_days[-1]) if a.week == "latest" else a.week
    if not re.match(r"\d{4}-W\d\d$", week):
        raise SystemExit("--week must look like 2026-W46, or latest")
    mon, fri = week_range(week)
    wdays = [d for d in all_days if week_of(d) == week]
    if not wdays:
        raise SystemExit("no TradeDay of %s in the ledger" % week)
    last = wdays[-1]
    days = [d for d in all_days if d <= last]
    upto = [t for t in trades if t["tradeDay"] <= last]
    week_over = last == all_days[-1] and (last < fri or not complete[last])
    week_over = not week_over                      # True when the week is finished in the data
    missing = [d for d in wdays if not complete[d]]
    pw = prev_week(week)
    pdays = [d for d in all_days if week_of(d) == pw]
    ws = week_stats([t for t in upto if t["tradeDay"] in wdays], wdays)
    ps = week_stats([t for t in upto if t["tradeDay"] in pdays], pdays) if pdays else None

    # ---- virtual combine up to the end of the week
    sim_days = [{"day": d, "complete": not (d == all_days[-1] and not complete[d]),
                 "trades": [{"net": t["net"] or 0.0, "worstOpen": (t["maePts"] * (t["contracts"] or 3) * ld.POINT_USD) if t["maePts"] is not None else None}
                            for t in upto if t["tradeDay"] == d]} for d in days]
    chain = ld.combine_chain(sim_days, a.combine_start)
    cur = chain[-1] if chain else None
    hist, runs = ld.combine_history(sim_days)
    full = [d for d in days if not (d == all_days[-1] and not complete[d])][-READY_DAYS:]
    nets = [round(sum(t["net"] or 0 for t in upto if t["tradeDay"] == d), 2) for d in full]
    ready = readiness(cur, nets)

    # ---- leaks
    lw = leak_rank([t for t in upto if t["tradeDay"] in wdays])
    d20 = days[-ld.HISTORY_DAYS:]
    l20 = leak_rank([t for t in upto if t["tradeDay"] in d20])

    # ---- experiments (as the last daily run left them)
    try:
        xdoc = json.load(open(os.path.join(office, "state", "experiments.json"), encoding="utf8"))
    except (OSError, ValueError):
        xdoc = {"experiments": []}
    kills = kill_rules(os.path.join(office, "EXPERIMENTS.md"))
    xs = []
    for x in xdoc.get("experiments", []):
        r = x.get("running") or {}
        n, need_n = r.get("n"), x.get("minN", ld.SMALL_N)
        started = x.get("started") or ""
        kill = kills.get(x["id"]) or x.get("killIf")
        if started > last:
            state, line = "not started", "not started in this week (starts %s)" % started
        elif n is not None and n >= need_n:
            state, line = "verdict", "VERDICT: %s. Kill rule: \"%s\"" % (r.get("verdict"), kill)
        else:
            state, line = "recording", "recording, %s of %d" % ("n unknown" if n is None else n, need_n)
        xs.append({"id": x["id"], "title": x.get("title"), "mode": x.get("mode"), "n": n, "minN": need_n, "value": r.get("value"), "unit": x.get("unit"),
                   "state": state, "line": line, "asOf": r.get("asOfTradeDay"), "note": r.get("note"), "kill": kill})

    # ---- decisions (at most 3): experiments at a verdict first, then leak classes over the weekly threshold
    statuses = {e["id"]: e["status"] for e in ld.read_register(os.path.join(office, "LOOPHOLES.md"))}
    partial = (not week_over) or bool(missing)
    dec, quiet = decision_items(xs, lw, statuses, partial)
    dropped = max(0, len(dec) - MAX_DECISIONS)
    dec = dec[:MAX_DECISIONS]
    gen = "\n".join("%d. %s" % (i + 1, d) for i, d in enumerate(dec)) if dec else (
        "Nothing to decide this week. (Partial week: no decision items are raised until the week is complete.)" if partial else "Nothing to decide this week.")
    path = os.path.join(office, "reviews", "weekly", week + ".md")
    try:
        existing = open(path, encoding="utf8").read()
    except OSError:
        existing = ""
    block, by_hand = merge_decisions(gen, existing)

    # ---- the card
    L = ["# Weekly card: %s (TradeDays %s to %s)" % (week, wdays[0], last), ""]
    if not week_over or missing:
        why = []
        if not week_over:
            why.append("the week is not over: %d of 5 TradeDays so far" % len(wdays))
        if missing:
            why.append("journal hours missing on " + ", ".join(missing))
        L += ["> **PARTIAL WEEK.** %s. Do not judge the week on these numbers." % ((lambda w: w[0].upper() + w[1:])("; ".join(why))), ""]
    L.append("**%s on %d trades over %d TradeDay%s; %d full stop%s. %s**" % (
        ld.usd(ws["net"], True), ws["trades"], ws["days"], "" if ws["days"] == 1 else "s", ws["fullStops"], "" if ws["fullStops"] == 1 else "s", readiness_line(ready)))
    L += ["", "Practice account, 3 MNQ contracts. Money is the broker's net per trade. n is printed beside every figure; under %d it is marked small." % ld.SMALL_N, ""]
    L += ["## Scoreboard", ""]

    def col(s, f):
        return "-" if s is None else f(s)
    rows = [
        ["net", lambda s: "%s (n=%d trades%s)" % (ld.usd(s["net"], True), s["trades"], small(s["trades"]))],
        ["net per TradeDay", lambda s: "%s (n=%d days, small)" % (ld.usd(s["netPerDay"], True), s["days"])],
    ]
    for sn in ld.SESSIONS:
        rows.append([sn, (lambda sn: lambda s: "%s (n=%d%s)" % (ld.usd(s["bySession"][sn]["net"], True), s["bySession"][sn]["trades"], small(s["bySession"][sn]["trades"])) if s["bySession"][sn]["trades"] else "no trades")(sn)])
    rows += [
        ["full stops per 10 trades", lambda s: "%.1f (%d in n=%d%s)" % (s["stopsPer10"], s["fullStops"], s["trades"], small(s["trades"])) if s["trades"] else "-"],
        ["average loss / average win", lambda s: "%.2f (%s over n=%d losses, %s over n=%d wins%s)" % (
            s["lossToWin"], ld.usd(s["avgLoss"]), s["losses"], ld.usd(s["avgWin"]), s["wins"], small(min(s["wins"], s["losses"]))) if s["lossToWin"] is not None else "-"],
        ["fees", lambda s: "%s (n=%d trades)" % (ld.usd(s["fees"]), s["feesTrades"]) if s["fees"] is not None else "-"],
        ["best day", lambda s: "%s on %s" % (ld.usd(s["bestDay"]["net"], True), s["bestDay"]["day"])],
        ["worst day", lambda s: "%s on %s" % (ld.usd(s["worstDay"]["net"], True), s["worstDay"]["day"])],
        ["worst run of full stops in a row", lambda s: "%d%s" % (s["streak"]["streak"], (" on %s" % s["streak"]["streakDay"]) if s["streak"]["streak"] else "")],
        ["most full stops in one day", lambda s: "%d%s" % (s["streak"]["mostInDay"], (" on %s" % s["streak"]["mostDay"]) if s["streak"]["mostInDay"] else "")],
    ]
    L.append(ld.table(["", "%s (%d day%s)" % (week, ws["days"], "" if ws["days"] == 1 else "s"), ("%s, the week before (%d day%s)" % (pw, ps["days"], "" if ps["days"] == 1 else "s")) if ps else "%s: no data" % pw],
                      [[name, f(ws), col(ps, f)] for name, f in rows]))
    L += ["", ld.table(["TradeDay", "net", "trades", "full stops"], [[d + ("" if complete[d] else " (incomplete)"), ld.usd(ws["dayNets"][d], True), sum(1 for t in upto if t["tradeDay"] == d),
                                                                          sum(1 for t in upto if t["tradeDay"] == d and t["fullStop"])] for d in wdays]), ""]
    L.append("Best and worst day and the stop runs are shown because the practice stage is also for seeing the most the system can win or lose in a day (Mac, 11/11).")
    L += ["", "## Virtual combine", ""]
    if chain:
        L.append(ld.table(["started", "status", "last day", "days", "profit", "room above floor", "best day", "target now"],
                          [[c["startDay"], c["status"] + (" (day not over)" if c["provisionalDay"] else ""), c["endDay"], c["days"], ld.usd(c["profit"], True), ld.usd(c["floorRoom"]),
                            ld.usd(c["bestDay"]), ld.usd(c["target"])] for c in chain]))
    else:
        L.append("The chain starts on %s: no TradeDay of it is in this week's data yet." % a.combine_start)
    L += ["", "**Readiness (arithmetic, no forecast):** " + readiness_line(ready), ""]
    L.append("If a combine had been started on each of the last %d TradeDays: %d passed, %d breached, %d still open." % (hist["started"], hist["passed"], hist["breached"], hist["open"]))
    L += ["", ld.table(["started", "result", "on", "days", "profit"], [[r["startDay"], r["status"], r["endDay"] if r["status"] != "open" else "-", r["days"], ld.usd(r["profit"], True)] for r in runs]), ""]
    miss = sum(c["tradesNoExcursion"] for c in runs)
    L.append("Open P&L inside a trade is tested where the journal has a worst-excursion reading (a lower bound); %d of the %d trade tests in this table had none and used closed P&L only." % (miss, sum(c["trades"] for c in runs)))
    L += ["", "## Leaks by dollars", "", "This week:", ""]
    L.append(ld.table(["leak class", "losing trades", "dollars"], [[k, "n=%d%s" % (v["n"], small(v["n"])), ld.usd(v["usd"], True)] for k, v in lw]) if lw else "No losing trades this week.")
    L += ["", "Last %d TradeDays (%s to %s), with the split by session:" % (len(d20), d20[0], d20[-1]), ""]
    if l20:
        L.append(ld.table(["leak class", "losing trades", "dollars"] + ld.SESSIONS,
                          [[k, "n=%d%s" % (v["n"], small(v["n"])), ld.usd(v["usd"], True)] + [("%s (n=%d)" % (ld.usd(v["bySession"][s]["usd"], True), v["bySession"][s]["n"])) if v["bySession"][s]["n"] else "-" for s in ld.SESSIONS] for k, v in l20]))
    else:
        L.append("No losing trades.")
    nmw = ld.near_miss_stats([t for t in upto if t["tradeDay"] in wdays])
    nm20 = ld.near_miss_stats([t for t in upto if t["tradeDay"] in d20])
    L += ["", "This week: " + ld.near_miss_line(nmw), "", "Last %d TradeDays: %s By session: %s." % (len(d20), ld.near_miss_line(nm20), "; ".join(
        "%s %s (n=%d)" % (sn, ld.usd(nm20["bySession"][sn]["usd"], True), nm20["bySession"][sn]["n"]) for sn in ld.SESSIONS if nm20["bySession"][sn]["n"]) or "none")]
    L += ["", "Classes are the ones in office/LOOPHOLES.md; a loss that fits none is unclassified and named by its exit.", "", "## Experiments", ""]
    L.append(ld.table(["id", "rule", "mode", "cases", "value", "state"],
                      [[x["id"], x["title"], x["mode"], "-" if x["state"] == "not started" else "n unknown of %d" % x["minN"] if x["n"] is None else "%d of %d%s" % (x["n"], x["minN"], small(x["n"])),
                        "-" if x["state"] == "not started" else "unknown" if x["value"] is None else "%s (%s)" % (ld.usd(x["value"], True), x["unit"]), x["line"]] for x in xs]))
    asof = sorted(set(x["asOf"] for x in xs if x["asOf"]))
    L += ["", "Counts are as of the last daily run (TradeDay %s). A verdict is written only when the cases reach the number needed; until then the rule is recording." % (", ".join(asof) or "unknown"), ""]
    L += ["## Decisions for Mac", ""]
    L.append("At most %d. Sources: an experiment that reached its verdict, or a leak with status observed or measured that lost more than $%d in a complete week. A leak whose rule is already live or recording is not raised here on dollars alone." % (MAX_DECISIONS, LEAK_DECISION_USD))
    if quiet:
        L.append("Over the line but already under a live or recording rule (leaks table only): %s." % ", ".join(quiet))
    if dropped and not by_hand:
        L.append("%d more item%s met the line and did not fit; see the leak table." % (dropped, "" if dropped == 1 else "s"))
    L += ["", block, ""]
    L.append("The block between the two markers can be edited by hand; once it is, the weekly tool keeps the edited text.")
    L.append("")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as f:
        f.write("\n".join(L))

    # ---- office.json: add 'weekly', touch nothing else
    opath = os.path.join(office, "state", "office.json")
    try:
        o = json.load(open(opath, encoding="utf8"))
    except (OSError, ValueError):
        o = None
    if o is not None:
        o["weekly"] = {
            "week": week, "days": wdays, "complete": week_over and not missing,
            "net": ws["net"], "trades": ws["trades"], "netPerDay": ws["netPerDay"], "fullStops": ws["fullStops"], "fullStopsPer10": ws["stopsPer10"],
            "lossToWin": ws["lossToWin"], "fees": ws["fees"], "bestDay": ws["bestDay"], "worstDay": ws["worstDay"],
            "worstStopStreak": ws["streak"]["streak"], "mostStopsInDay": ws["streak"]["mostInDay"],
            "bySession": {s: {"net": ws["bySession"][s]["net"], "trades": ws["bySession"][s]["trades"], "fullStops": ws["bySession"][s]["fullStops"]} for s in ld.SESSIONS},
            "previous": ({"week": pw, "net": ps["net"], "trades": ps["trades"], "netPerDay": ps["netPerDay"], "fullStopsPer10": ps["stopsPer10"], "lossToWin": ps["lossToWin"]} if ps else None),
            "readiness": {"need": ready["need"], "avgPerDay": ready["avgPerDay"], "avgDays": ready["n"], "daysAtAverage": ready["days"], "text": readiness_line(ready)},
            "leaks": [{"id": k, "n": v["n"], "usd": round(v["usd"], 2)} for k, v in lw],
            "nearMiss": {"id": "L-13", "n": nmw["n"], "usd": nmw["usd"], "note": "of which: inside the L-01 / L-07 dollars"},
            "decisions": ([] if by_hand else dec), "decisionsEditedByHand": by_hand, "card": "office/reviews/weekly/%s.md" % week,
        }
        ld.dump(opath, o)
    print("%s: %s on %d trades over %d days; %s%s" % (week, ld.usd(ws["net"], True), ws["trades"], ws["days"], readiness_line(ready), " [decisions kept as edited by hand]" if by_hand else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
