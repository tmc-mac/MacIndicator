#!/usr/bin/env python3
"""Team Mac daily loop tool: journal slices -> ledger, daily card, office.json, experiments.json.

    python3 -I office/tools/loop_daily.py --data-repo <clone of the team line> --ref FETCH_HEAD --day 2026-11-10
    python3 -I office/tools/loop_daily.py --data-repo <clone> --ref FETCH_HEAD --day latest

Standard library only. Reads the data repository with `git show` / `git ls-tree` (never checks anything out,
never writes there). Writes only under office/ (state/ledger.json, state/office.json, state/experiments.json,
reviews/daily/<TradeDay>.md). Method notes and data limits: office/tools/README.md.
"""
import argparse
import datetime
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys

SCHEMA = 1
POINT_USD = 2.0                      # MNQ: $2 per point per contract
OBJECTIVE = {"name": "Topstep $50K Combine", "target": 3000, "maxLoss": 2000, "bestDayCap": 1650, "account": "practice"}
BEST_DAY_FRAC = 0.55
COMBINE_CHAIN_START = "2026-11-09"   # first virtual combine of the chain (the 11/09 restore); --combine-start overrides
HISTORY_DAYS = 20
LEAK_DAYS = 5
SMALL_N = 20
TP_PTS = 15.0                        # blocked-signal audit: favourable move that counts as a win
DEFAULT_STOP_PTS = 50.0              # ... stop distance when the block row carries none
WALK_MIN = 60                        # ... minutes walked after the block
REF_MAX_MS = 90000                   # ... a price sample must be this close to the block to be its reference
GAP_MAX_MS = 180000                  # ... a hole this long between price samples makes the walk unknown
REENTRY_MIN = 30                     # L-07: a loss that starts within this many minutes of a same-side full stop
SESSIONS = ["asia", "london", "ny", "late"]
FULL_STOP_EXITS = ("full-stop", "full-stop(inferred)", "filled-through-stop")
GATE_NAMES = {"GATE": "15m control", "HTF_ALIGN": "HTF alignment", "SIZE_BELOW_MIN": "size below 3 (stop too wide)",
              "RISK_CAP_SKIP": "risk cap (stop too wide)", "LEVELS_ONLY": "levels only (no level event)",
              "COOLDOWN": "cooldown", "LEVEL_BAN": "level ban", "NO_CHASE": "no chase", "SESSION_CLOSE": "session close",
              "STRETCH": "stretch", "FRESH_STOP": "fresh stop", "NEWS_RESTING": "news", "ENTRY_GUARD": "entry guard"}
SENSITIVE_KEY = re.compile(r"account|user|token|secret|passw|url|host|addr|path|key|login|email|phone", re.I)

# ----------------------------------------------------------------------------- time (PT without a tz database)


def _utc_ms(y, mo, d, h=0, mi=0):
    return int((datetime.datetime(y, mo, d, h, mi) - datetime.datetime(1970, 1, 1)).total_seconds() * 1000)


def _dst_bounds(year):
    """US daylight time: second Sunday of March 10:00 UTC to first Sunday of November 09:00 UTC."""
    a = datetime.date(year, 3, 8)
    a += datetime.timedelta(days=(6 - a.weekday()) % 7)
    b = datetime.date(year, 11, 1)
    b += datetime.timedelta(days=(6 - b.weekday()) % 7)
    return _utc_ms(a.year, a.month, a.day, 10), _utc_ms(b.year, b.month, b.day, 9)


def pt_offset_h(ms):
    y = datetime.datetime.utcfromtimestamp(ms / 1000).year
    s, e = _dst_bounds(y)
    return -7 if s <= ms < e else -8


def pt_dt(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000) + datetime.timedelta(hours=pt_offset_h(ms))


def pt_wall_ms(day, hh, mm):
    """UTC ms of a PT wall-clock time on calendar day 'YYYY-MM-DD'."""
    y, mo, d = (int(x) for x in day.split("-"))
    g = _utc_ms(y, mo, d, hh, mm) + 8 * 3600000
    return g - 3600000 if pt_offset_h(g - 3600000) == -7 else g


def iso_utc(ms):
    if ms is None:
        return None
    return datetime.datetime.utcfromtimestamp(int(ms) / 1000).strftime("%Y-%m-%dT%H:%M:%SZ")


def pt_hm(ms, with_date=False):
    if ms is None:
        return "?"
    return pt_dt(ms).strftime("%m/%d %H:%M PT" if with_date else "%H:%M PT")


def trade_day(ms):
    """TradeDay of an instant: 15:00 PT rolls to the next calendar day."""
    return (pt_dt(ms) + datetime.timedelta(hours=9)).strftime("%Y-%m-%d")


def day_add(day, n):
    return (datetime.date(*[int(x) for x in day.split("-")]) + datetime.timedelta(days=n)).isoformat()


def day_window(day):
    """(start, flat-by, end) in UTC ms: 15:00 PT the previous calendar day, 13:10 PT, 15:00 PT."""
    return pt_wall_ms(day_add(day, -1), 15, 0), pt_wall_ms(day, 13, 10), pt_wall_ms(day, 15, 0)


def session_of(ms):
    """The bot's own session of a fill (lib/stopFloor.js sessionOf): PT minutes of day,
    london 00:00-06:30, ny 06:30-13:00, late 13:00-15:00, asia 15:00-24:00."""
    d = pt_dt(ms)
    m = d.hour * 60 + d.minute
    return "london" if m < 390 else "ny" if m < 780 else "late" if m < 900 else "asia"


def iso_week(day):
    y, w, _ = datetime.date(*[int(x) for x in day.split("-")]).isocalendar()
    return "%04d-W%02d" % (y, w)


# ----------------------------------------------------------------------------- virtual combine (pure, unit tested)


def simulate_combine(days, target=3000.0, max_loss=2000.0, best_day_frac=BEST_DAY_FRAC):
    """Topstep $50K rules over a list of days, oldest first.

    days: [{"day": "YYYY-MM-DD", "complete": bool (default True),
            "trades": [{"net": dollars, "worstOpen": dollars at the worst open excursion (<= 0) or None}]}]
    Balance is relative to the start balance (0). The floor starts at -max_loss, is tested against intraday equity
    (balance + the open trade's worst excursion, then the closed balance), trails the END-OF-DAY balance up, never
    down, and locks at 0 once an end-of-day balance is +max_loss or more. Pass = end-of-day profit at or above
    max(target, bestDay / best_day_frac). A day with complete False is applied trade by trade but gets no end-of-day
    step (no trail, no pass). Stops at the first breach or pass.
    """
    bal, floor, best = 0.0, -float(max_loss), 0.0
    out = {"startDay": days[0]["day"] if days else None, "endDay": None, "status": "open", "profit": 0.0, "floor": floor,
           "floorRoom": float(max_loss), "floorLocked": False, "bestDay": 0.0, "bestDayPct": None, "days": 0,
           "target": float(target), "breach": None, "tradesNoExcursion": 0, "trades": 0, "provisionalDay": None,
           "worstRoom": float(max_loss)}
    for d in days:
        day_net = 0.0
        out["days"] += 1
        out["endDay"] = d["day"]
        for i, tr in enumerate(d.get("trades") or []):
            out["trades"] += 1
            wo = tr.get("worstOpen")
            if wo is None:
                out["tradesNoExcursion"] += 1
                wo = 0.0
            low = bal + min(0.0, wo)
            out["worstRoom"] = min(out["worstRoom"], low - floor)
            if low <= floor:
                out["breach"] = {"day": d["day"], "trade": i, "how": "open", "equity": round(low, 2), "floor": round(floor, 2)}
            bal += tr["net"]
            day_net += tr["net"]
            out["worstRoom"] = min(out["worstRoom"], bal - floor)
            if out["breach"] is None and bal <= floor:
                out["breach"] = {"day": d["day"], "trade": i, "how": "closed", "equity": round(bal, 2), "floor": round(floor, 2)}
            if out["breach"]:
                out["status"] = "breached"
                break
        if out["status"] == "breached":
            break
        if d.get("complete", True) is False:
            out["provisionalDay"] = d["day"]
            break
        best = max(best, day_net)
        out["target"] = max(float(target), best / best_day_frac)
        if bal >= out["target"]:
            out["status"] = "passed"
        floor = max(floor, min(bal - max_loss, 0.0))
        if out["status"] == "passed":
            break
    out["profit"] = round(bal, 2)
    out["floor"] = round(floor, 2)
    out["floorLocked"] = floor >= 0.0
    out["floorRoom"] = 0.0 if out["status"] == "breached" else round(bal - floor, 2)
    out["worstRoom"] = round(max(out["worstRoom"], 0.0), 2)
    out["bestDay"] = round(best, 2)
    out["bestDayPct"] = round(100.0 * best / bal, 1) if bal > 0 and best > 0 else None
    out["target"] = round(out["target"], 2)
    return out


def combine_chain(days, start_day):
    """Back-to-back virtual combines: the first starts on start_day (or the first day after it that has data);
    when one passes or breaches, the next starts on the following TradeDay."""
    idx = [i for i, d in enumerate(days) if d["day"] >= start_day]
    chain = []
    i = idx[0] if idx else len(days)
    while i < len(days):
        r = simulate_combine(days[i:])
        chain.append(r)
        if r["status"] == "open":
            break
        i = [k for k, d in enumerate(days) if d["day"] == r["endDay"]][0] + 1
    return chain


def combine_history(days, n=HISTORY_DAYS):
    """One virtual combine started on each of the last n TradeDays, each run to the end of the data."""
    runs = [simulate_combine(days[i:]) for i in range(max(0, len(days) - n), len(days))]
    c = {"started": len(runs), "passed": 0, "breached": 0, "open": 0}
    for r in runs:
        c[r["status"]] += 1
    return c, runs


# ----------------------------------------------------------------------------- blocked-signal walk (pure, unit tested)


def walk_block(t0, direction, samples, entry=None, stop_pts=None, tp_pts=TP_PTS, minutes=WALK_MIN):
    """What price did after a blocked signal. samples: [(t ms, price)] sorted. Returns (result, why, used) with
    result 'won' (+tp_pts first), 'lost' (-stop first), 'neither' (60 min, no touch) or 'unknown'."""
    if direction not in (1, -1):
        return "unknown", "the block row has no direction", None
    stop = stop_pts if stop_pts else DEFAULT_STOP_PTS
    ref = entry
    if ref is None:
        before = [s for s in samples if s[0] <= t0 and t0 - s[0] <= REF_MAX_MS]
        after = [s for s in samples if s[0] > t0 and s[0] - t0 <= REF_MAX_MS]
        pick = before[-1] if before else (after[0] if after else None)
        if pick is None:
            return "unknown", "no price sample within %d s of the block" % (REF_MAX_MS // 1000), None
        ref = pick[1]
    used = {"ref": ref, "stopPts": stop}
    end = t0 + minutes * 60000
    prev, seen = t0, False
    for t, p in samples:
        if t <= t0 or t > end:
            continue
        if t - prev > GAP_MAX_MS:
            return "unknown", "a hole of more than %d s in the price samples" % (GAP_MAX_MS // 1000), used
        prev, seen = t, True
        fav = (p - ref) * direction
        if fav >= tp_pts:
            return "won", None, used
        if fav <= -stop:
            return "lost", None, used
    if not seen or end - prev > GAP_MAX_MS:
        return "unknown", "the price samples end before the 60 minutes are over", used
    return "neither", None, used


# ----------------------------------------------------------------------------- reading the data repository

RE_TYPE = re.compile(rb'"type":\s*"([A-Za-z_]+)"')
RE_T = re.compile(rb'"t":\s*(\d{12,13})')
RE_REC = re.compile(rb'"recordedAt":\s*(\d{12,13})')
RE_SLICE = re.compile(r"^data/(\d{4}-\d{2}-\d{2})/slice-[^/]*\.jsonl\.gz$")
RE_FULL = re.compile(r"^data/(\d{4}-\d{2}-\d{2})/(?:[^/]+/)?trade-journal-MNQ\.jsonl\.gz$")
RE_LM = re.compile(r"^data/(\d{4}-\d{2}-\d{2})/levels-minute-MNQ-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$")
RE_CFG = re.compile(r"^data/(\d{4}-\d{2}-\d{2})/config-local-live\.json$")
PARSE_TYPES = {"signal_check", "trade_manage", "trade_plan", "entry", "trade_time", "trade_state", "peak_unrealized",
               "trade_block", "session_stamp", "alert", "journal_receipt", "no_progress_outcome", "early_adverse_exit",
               "early_adverse_shadow", "early_adverse_outcome", "early_adverse_check", "runner_rule", "tp1_atr_shadow",
               "orphan_sweep", "flag", "trade_flag", "mac_flag"}


class Repo:
    def __init__(self, path, ref):
        self.path, self.ref = path, ref

    def _git(self, *args):
        r = subprocess.run(["git", "-C", self.path] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if r.returncode != 0:
            raise SystemExit("git %s failed: %s" % (" ".join(args[:2]), r.stderr.decode("utf8", "replace").strip()[:200]))
        return r.stdout

    def names(self):
        return sorted(n for n in self._git("ls-tree", "-r", "--name-only", self.ref, "--", "data").decode().split("\n") if n)

    def blob(self, name):
        return self._git("show", "%s:%s" % (self.ref, name))

    def lines(self, name):
        return [l for l in gzip.decompress(self.blob(name)).split(b"\n") if l.strip()]


def load_journal(repo, names=None):
    """Every journal file (4-hour slices and full journals), rows de-duplicated by their exact text."""
    names = names if names is not None else repo.names()
    J = {"files": [], "types": {}, "dayRows": {}, "by": {}, "blocks": [], "stamps": [], "alerts": [], "receipts": {},
         "flags": [], "orphans": [], "bad": 0, "rows": 0, "tmax": 0, "names": names}
    seen = set()
    for n in names:
        kind = "slice" if RE_SLICE.match(n) else "full" if RE_FULL.match(n) else None
        if not kind:
            continue
        lo, hi, k, new = None, None, 0, 0
        for l in repo.lines(n):
            k += 1
            m = RE_T.search(l) or RE_REC.search(l)
            t = int(m.group(1)) if m else None
            if t is not None:
                lo = t if lo is None or t < lo else lo
                hi = t if hi is None or t > hi else hi
            h = hashlib.blake2b(l, digest_size=10).digest()
            if h in seen:
                continue
            seen.add(h)
            new += 1
            m = RE_TYPE.search(l[:80]) or RE_TYPE.search(l)
            ty = m.group(1).decode() if m else "BAD"
            J["types"][ty] = J["types"].get(ty, 0) + 1
            if t is not None:
                td = trade_day(t)
                J["dayRows"][td] = J["dayRows"].get(td, 0) + 1
            if ty not in PARSE_TYPES or (ty == "signal_check" and b'"outcome":"sat_out"' in l):
                continue
            if ty == "journal_receipt" and b"ECONOMICS_MATCH_OBSERVED" not in l:
                continue
            try:
                r = json.loads(l)
            except ValueError:
                J["bad"] += 1
                continue
            _file_row(J, ty, r)
        J["files"].append({"name": n, "kind": kind, "rows": k, "new": new, "tmin": lo, "tmax": hi})
        J["rows"] += new
        if hi:
            J["tmax"] = max(J["tmax"], hi)
    return J


def _file_row(J, ty, r):
    if ty == "trade_block":
        J["blocks"].append(r)
    elif ty == "session_stamp":
        J["stamps"].append(r)
    elif ty == "alert":
        J["alerts"].append(r)
    elif ty in ("flag", "trade_flag", "mac_flag"):
        J["flags"].append(r)
    elif ty == "orphan_sweep":
        J["orphans"].append(r)
    elif ty == "journal_receipt":
        eo = r.get("legacyEconomicObservation")
        if isinstance(eo, dict) and eo.get("source") == "broker" and isinstance(eo.get("realizedPnl"), (int, float)):
            j = r.get("journalId")
            if j and (j not in J["receipts"] or (r.get("recordedAt") or 0) >= J["receipts"][j]["at"]):
                J["receipts"][j] = {"at": r.get("recordedAt") or 0, "realized": eo["realizedPnl"], "exitTime": eo.get("exitTime")}
    else:
        j = r.get("tradeJournalId") if ty == "trade_state" else r.get("journalId")
        if ty == "signal_check" and r.get("outcome") not in ("closed", "traded"):
            return
        if j:
            J["by"].setdefault(j, {}).setdefault(ty, []).append(r)
        elif ty == "peak_unrealized":
            pass


def load_price_samples(repo, names, day):
    """Price after a block: the levels-minute files (one row about every 52-80 s; price = the last price the bot saw
    when it wrote the row). No high / low between samples."""
    want = {day_add(day, -1), day}
    out = {}
    used = []
    for n in names:
        m = RE_LM.match(n)
        if not m or m.group(2) not in want:
            continue
        used.append(n)
        for l in repo.lines(n):
            try:
                r = json.loads(l)
            except ValueError:
                continue
            t, tf = r.get("t"), r.get("tf") or {}
            px = None
            for k in ("M15", "M5", "M3"):
                c = (tf.get(k) or {}).get("close")
                if isinstance(c, (int, float)):
                    px = c
                    break
            if isinstance(t, (int, float)) and px is not None:
                out[int(t)] = float(px)
    return sorted(out.items()), used


def load_configs(repo, names):
    out = []
    for n in names:
        m = RE_CFG.match(n)
        if not m:
            continue
        try:
            c = json.loads(repo.blob(n).decode("utf8", "replace"))
        except ValueError:
            continue
        ov = {}
        for o in ((c.get("configLocal") or {}).get("overrides") or []):
            if isinstance(o, dict) and isinstance(o.get("key"), str):
                ov[o["key"]] = o.get("to")
        t = None
        ts = c.get("pullTimestamp")
        if isinstance(ts, str):
            mm = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)([+-])(\d\d):(\d\d)$", ts)
            if mm:
                g = [int(x) if x not in "+-" else x for x in mm.groups()]
                t = _utc_ms(g[0], g[1], g[2], g[3], g[4]) + g[5] * 1000
                t -= (1 if g[6] == "+" else -1) * (g[7] * 60 + g[8]) * 60000
        out.append({"folder": m.group(1), "t": t, "overrides": ov})
    return out


# ----------------------------------------------------------------------------- ledger


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _r2(x):
    return None if x is None else round(float(x) + 0.0, 2)


def build_trade(j, d):
    closed = sorted([r for r in d.get("signal_check", []) if r.get("outcome") == "closed"], key=lambda r: r.get("t") or 0)
    if not closed:
        return None
    brk = [r for r in closed if r.get("pnlSource") == "broker"]
    fin = brk[-1] if brk else closed[-1]
    tm = sorted(d.get("trade_manage", []), key=lambda r: r.get("t") or 0)
    codes = [r.get("code") for r in tm]
    ent = (d.get("entry") or [None])[0]
    plan = (d.get("trade_plan") or [None])[-1]
    traded = [r for r in d.get("signal_check", []) if r.get("outcome") == "traded"]
    tr = traded[-1] if traded else None
    ef = [r for r in tm if r.get("code") == "ENTRY_FILLED"]
    t_entry = _num(fin.get("brokerEntryTime")) or (ef[0]["t"] if ef else None) or ((ent or {}).get("t")) or ((tr or {}).get("t")) or fin.get("t")
    fill = _num(fin.get("brokerEntryPrice")) or (_num(ef[0].get("fill")) if ef else None) or _num((ent or {}).get("entryPrice")) or _num((tr or {}).get("entryPrice"))
    dirn = fin.get("dir") or (ent or {}).get("dir") or (plan or {}).get("dir")
    contracts = _num(fin.get("brokerContracts")) or _num((ent or {}).get("contracts")) or _num((tr or {}).get("contracts"))
    if not contracts and ef:
        m = re.search(r"(\d+)x filled", ef[0].get("text") or "")
        contracts = int(m.group(1)) if m else None
    # money: the broker's realized P&L row; an estimate only when there is none
    gross, fees_exch, comm, realized, net = _num(fin.get("grossPnl")), _num(fin.get("fees")), _num(fin.get("commissions")), _num(fin.get("realizedPnl")), None
    if brk:
        source = "broker"
        if _num(fin.get("netPnl")) is not None:
            net, basis = fin["netPnl"], "broker net (gross - exchange fees - commissions)"
        else:
            net, basis = realized, "broker gross - fees (the row carries no commission)"
        if gross is None:
            gross = realized
    else:
        source, net, basis = "estimate", realized, "bot estimate: points x $2 x contracts, no fees"
        gross, fees_exch, comm = realized, None, None
    fees = _r2(gross - net) if (source == "broker" and gross is not None and net is not None and _num(fin.get("grossPnl")) is not None) else None
    # stop / targets
    pp = [r for r in tm if r.get("code") == "PROTECTION_PLACED"]
    stop0 = _num(pp[0].get("stop")) if pp else _num(((plan or {}).get("stop") or {}).get("price")) if isinstance((plan or {}).get("stop"), dict) else None
    if stop0 is None:
        stop0 = _num((tr or {}).get("stopPrice"))
    caps = [r for r in tm if r.get("code") == "STOP_CAP_FROM_FILL" and _num(r.get("stopAfter")) is not None]
    if caps:
        stop0 = caps[-1]["stopAfter"]
    tp1 = _num(pp[0].get("tp1")) if pp else None
    stop_pts = abs(fill - stop0) if (fill is not None and stop0 is not None) else None
    ppc = gross / (POINT_USD * contracts) if (contracts and gross is not None) else None
    tp1hit = "TP1_FILLED" in codes
    # exit reason
    if "FILLED_THROUGH_STOP" in codes:
        ex = "filled-through-stop"
    elif "EARLY_ADVERSE_EXIT" in codes:
        ex = "early-adverse-exit"
    elif "NO_PROGRESS_EXIT" in codes:
        ex = "no-progress-exit"
    elif "SESSION_FLATTEN" in codes or "MORNING_FLATTEN" in codes:
        ex = "session-flatten"
    elif ("MANUAL_FLATTEN" in codes or "FLATTEN_CONFIRMED" in codes) and not tp1hit:
        ex = "manual-flatten"
    elif tp1hit:
        whole = any(r.get("code") == "TP1_FILLED" and r.get("whole") for r in tm)
        ex = "tp1-all-out" if whole else "tp1-then-runner"
    elif "STOP_FILLED" in codes:
        sf = [r for r in tm if r.get("code") == "STOP_FILLED"][0]
        locked = any(r.get("code") in ("PROFIT_TRAIL", "TRAIL_RATCHET") and r.get("t", 0) < sf.get("t", 0) for r in tm)
        ex = "trail-stop" if locked else "full-stop"
    elif "MARKET_EXIT" in codes:
        ex = "market-exit"
    else:
        ex = "unknown"
    if ex == "unknown" and stop_pts and ppc is not None and ppc <= -0.85 * stop_pts:
        ex = "full-stop(inferred)"
    # level / event
    lp = (ent or {}).get("levelProof") or {}
    lc = (ent or {}).get("levelContext") or {}
    el = (ent or {}).get("entryLevel") or (tr or {}).get("entryLevel") or {}
    inplay = (((plan or {}).get("trigger") or {}).get("levels") or {}).get("inPlay") or {}
    if not isinstance(inplay, dict):
        inplay = {}
    level = lp.get("name") or el.get("name") or lc.get("name") or inplay.get("name")
    event = lp.get("event") or el.get("behavior") or lc.get("behavior") or inplay.get("behavior")
    exit_px = _num(fin.get("exitPrice"))
    t_exit = _num(fin.get("exitTime")) or fin.get("t")
    # excursions: the largest reading of every journal source (each is a lower bound of the real excursion)
    mfe_c, mae_c = [], []
    ts = d.get("trade_state") or []
    if ts:
        b = [_num(r.get("best")) for r in ts if _num(r.get("best")) is not None]
        w = [_num(r.get("worst")) for r in ts if _num(r.get("worst")) is not None]
        if b:
            mfe_c.append((max(b), "trade_state 1m bars"))
        if w:
            mae_c.append((min(w), "trade_state 1m bars"))
    for r in d.get("trade_time") or []:
        if _num(r.get("maxFavorablePts")) is not None:
            mfe_c.append((r["maxFavorablePts"], "trade_time price polls"))
        if _num(r.get("maxAdversePts")) is not None:
            mae_c.append((r["maxAdversePts"], "trade_time price polls"))
    for ty in ("no_progress_outcome", "early_adverse_outcome"):
        for r in d.get(ty) or []:
            if _num(r.get("bestPtsSeen")) is not None:
                mfe_c.append((r["bestPtsSeen"], ty))
    for r in (d.get("early_adverse_exit") or []) + (d.get("early_adverse_check") or []):
        if _num(r.get("pts")) is not None:
            mae_c.append((r["pts"], "early_adverse 1m close"))
    for r in d.get("tp1_atr_shadow") or []:
        if _num(r.get("bestPtsSeen")) is not None and r.get("live", {}).get("closedAt") is None:
            mfe_c.append((r["bestPtsSeen"], "tp1_atr_shadow"))
    if tp1hit and tp1 is not None and fill is not None:
        mfe_c.append((abs(tp1 - fill), "TP1 fill"))
    if exit_px is not None and fill is not None and dirn in (1, -1) and source == "broker":
        x = (exit_px - fill) * dirn
        (mfe_c if x > 0 else mae_c).append((x, "exit fill"))
    if ppc is not None and ppc < 0 and not tp1hit:
        mae_c.append((ppc, "realized points"))
    mfe = max(mfe_c, key=lambda c: c[0]) if mfe_c else None
    mae = min(mae_c, key=lambda c: c[0]) if mae_c else None
    # rule facts (edge r1 rows)
    rules = {}
    rr = (d.get("runner_rule") or [None])[-1]
    if rr:
        rules["runner"] = {"mode": rr.get("mode"), "session": rr.get("session"), "atr15": _num(rr.get("atr15")), "tp2": _num(rr.get("tp2"))}
    ea = (d.get("early_adverse_exit") or [None])[-1]
    eo = (d.get("early_adverse_outcome") or [None])[-1]
    if ea or eo:
        src = ea or eo
        rules["earlyAdverse"] = {"decision": src.get("decision"), "pts": _num(src.get("pts")), "exited": bool((eo or {}).get("exited") or (ea or {}).get("orderSent")), "mode": src.get("mode")}
        sh = (d.get("early_adverse_shadow") or [None])[-1]
        if sh:
            rules["earlyAdverse"]["shadow"] = sh.get("result")
    s1 = [r for r in d.get("tp1_atr_shadow") or [] if r.get("phase") == "resolve"]
    s0 = [r for r in d.get("tp1_atr_shadow") or [] if r.get("phase") == "open"]
    if s1 or s0:
        r = (s1 or s0)[-1]
        rules["tp1AtrShadow"] = {"shadowTp1Pts": _num(r.get("shadowTp1Pts")), "state": r.get("state") if s1 else "open",
                                 "beAfter": (r.get("shadow") or {}).get("beAfter") if s1 else None,
                                 "beAfterNetUsd": _num((r.get("shadow") or {}).get("beAfterNetUsd")) if s1 else None}
    stamp = None
    for r in ef + ([ent] if ent else []) + closed:
        if r.get("stampId"):
            stamp = r["stampId"]
            break
    return {
        "id": j, "tradeDay": trade_day(t_entry), "session": session_of(t_entry),
        "side": "long" if dirn == 1 else "short" if dirn == -1 else None, "level": level, "event": event,
        "grade": fin.get("grade"), "source": fin.get("source"), "contracts": contracts,
        "entryTime": iso_utc(t_entry), "exitTime": iso_utc(t_exit), "durationSec": int(round((t_exit - t_entry) / 1000.0)) if t_exit and t_entry else None,
        "entry": fill, "exit": exit_px, "stop": stop0, "stopPts": _r2(stop_pts), "tp1": tp1,
        "exitReason": ex, "fullStop": ex in FULL_STOP_EXITS, "tp1Hit": tp1hit,
        "gross": _r2(gross) if source == "broker" else None, "fees": fees, "net": _r2(net), "realized": _r2(realized),
        "moneySource": source, "netBasis": basis,
        "mfePts": _r2(max(0.0, mfe[0])) if mfe else None, "mfeSource": mfe[1] if mfe else None,
        "maePts": _r2(min(0.0, mae[0])) if mae else None, "maeSource": mae[1] if mae else None,
        "rules": rules, "stampId": stamp, "_tEntry": t_entry, "_tExit": t_exit, "_dir": dirn,
    }


def build_ledger(J):
    trades = [t for t in (build_trade(j, d) for j, d in J["by"].items()) if t]
    trades.sort(key=lambda t: (t["_tEntry"], t["id"]))
    return trades


# ----------------------------------------------------------------------------- scoring, autopsy, audit


def score(trades):
    w = [t["net"] for t in trades if t["net"] is not None and t["net"] > 0]
    l = [t["net"] for t in trades if t["net"] is not None and t["net"] < 0]
    fees = [t["fees"] for t in trades if t["fees"] is not None]
    aw = sum(w) / len(w) if w else None
    al = sum(l) / len(l) if l else None
    return {"net": _r2(sum(t["net"] or 0 for t in trades)), "trades": len(trades), "wins": len(w), "losses": len(l),
            "fullStops": sum(1 for t in trades if t["fullStop"]), "avgWin": _r2(aw), "avgLoss": _r2(al),
            "lossToWin": _r2(abs(al) / aw) if (aw and al) else None,
            "fees": _r2(sum(fees)) if fees else None,
            "feesTrades": len(fees)}


def classify_loss(t, prior):
    """Leak class of a losing trade, from office/LOOPHOLES.md. Returns (id or 'unclassified', reason)."""
    if t["exitReason"] in FULL_STOP_EXITS or t["exitReason"] == "early-adverse-exit":
        for p in reversed(prior):
            if p["fullStop"] and p["_dir"] == t["_dir"] and p["_tExit"] and 0 <= t["_tEntry"] - p["_tExit"] <= REENTRY_MIN * 60000:
                return "L-07", "same-side entry %d min after a full stop" % round((t["_tEntry"] - p["_tExit"]) / 60000.0)
        if t["exitReason"] == "early-adverse-exit":
            return "L-01", "never worked: closed by the early exit (the live L-01 rule)"
        return "L-01", "full stop"
    for p in reversed(prior):
        if p["fullStop"] and p["_dir"] == t["_dir"] and p["_tExit"] and 0 <= t["_tEntry"] - p["_tExit"] <= REENTRY_MIN * 60000:
            return "L-07", "same-side entry %d min after a full stop" % round((t["_tEntry"] - p["_tExit"]) / 60000.0)
    return "unclassified", t["exitReason"]


def autopsy(trades):
    out = []
    for i, t in enumerate(trades):
        if t["net"] is not None and t["net"] < 0:
            cid, why = classify_loss(t, trades[:i])
            out.append({"trade": t, "leak": cid, "why": why})
    return out


def gate_name(row):
    code = row.get("code") or "?"
    if code == "GATE":
        return "15m control" if "control" in str(row.get("reason") or row.get("text") or "") else "entry gate (other)"
    return GATE_NAMES.get(code, code.lower().replace("_", " "))


def audit_blocks(blocks, samples):
    rows, gates, order = [], {}, []
    for b in sorted(blocks, key=lambda r: (r.get("t") or 0, str(r.get("blockId")))):
        entry = _num(b.get("entry"))
        sp = _num(b.get("stopPts"))
        if sp is None and entry is not None and _num(b.get("stop")) is not None:
            sp = abs(entry - b["stop"])
        res, why, used = walk_block(b.get("t") or 0, b.get("dir"), samples, entry=entry, stop_pts=sp)
        g = gate_name(b)
        if g not in gates:
            gates[g] = {"gate": g, "count": 0, "wouldHaveWon": 0, "wouldHaveLost": 0, "neither": 0, "unknown": 0}
            order.append(g)
        gates[g]["count"] += 1
        gates[g][{"won": "wouldHaveWon", "lost": "wouldHaveLost", "neither": "neither", "unknown": "unknown"}[res]] += 1
        rows.append({"t": b.get("t"), "code": b.get("code"), "gate": g, "dir": b.get("dir"), "result": res, "why": why,
                     "stopPts": (used or {}).get("stopPts"), "stopFromRow": sp is not None})
    return [gates[g] for g in sorted(order, key=lambda g: (-gates[g]["count"], g))], rows


# ----------------------------------------------------------------------------- settings changes and health


def _flat(v, pre=""):
    out = {}
    if isinstance(v, dict):
        for k in sorted(v):
            out.update(_flat(v[k], pre + ("." if pre else "") + str(k)))
    else:
        out[pre] = v
    return out


def _val(k, v):
    if SENSITIVE_KEY.search(k):
        return "(hidden)"
    s = json.dumps(v, sort_keys=True) if not isinstance(v, str) else v
    return s if len(s) <= 40 else s[:37] + "..."


def settings_changes(stamps, configs):
    """Every change the journal can prove: session_stamp rows (a bot start; settings and code hashes) and, for keys
    the stamps do not carry, differences between consecutive config-local-live.json files."""
    out = []
    st = sorted([s for s in stamps if _num(s.get("t"))], key=lambda s: (s["t"], str(s.get("runId"))))
    seen_keys = []
    prev = None
    for s in st:
        if prev is not None:
            a, b = _flat(prev.get("settings") or {}), _flat(s.get("settings") or {})
            keys = [k for k in sorted(set(a) | set(b)) if a.get(k, "(unset)") != b.get(k, "(unset)")]
            for k in keys[:12]:
                out.append({"t": s["t"], "what": "%s %s -> %s" % (k, _val(k, a.get(k, "(unset)")), _val(k, b.get(k, "(unset)"))), "kind": "setting", "stampId": s.get("stampId")})
                seen_keys.append((s["t"], k))
            if len(keys) > 12:
                out.append({"t": s["t"], "what": "%d more settings changed" % (len(keys) - 12), "kind": "setting", "stampId": s.get("stampId")})
            fa, fb = prev.get("files") or {}, s.get("files") or {}
            ch = [f for f in sorted(set(fa) | set(fb)) if fa.get(f) != fb.get(f)]
            if ch:
                out.append({"t": s["t"], "what": "bot code changed (%d file%s: %s%s), build %s" % (
                    len(ch), "" if len(ch) == 1 else "s", ", ".join(os.path.basename(f) for f in ch[:3]), ", ..." if len(ch) > 3 else "", s.get("stampId")),
                    "kind": "code", "stampId": s.get("stampId")})
        prev = s
    cf = sorted([c for c in configs if c["t"]], key=lambda c: c["t"])
    for a, b in zip(cf, cf[1:]):
        for k in sorted(set(a["overrides"]) | set(b["overrides"])):
            va, vb = a["overrides"].get(k, "(unset)"), b["overrides"].get(k, "(unset)")
            if va == vb:
                continue
            if any(a["t"] < t <= b["t"] + 3600000 and (sk == k or sk.startswith(k + ".") or k.startswith(sk + ".")) for t, sk in seen_keys):
                continue
            out.append({"t": b["t"], "what": "%s %s -> %s (settings file; changed between the %s and %s pulls, exact time not journaled)" % (
                k, _val(k, va), _val(k, vb), pt_hm(a["t"], True), pt_hm(b["t"], True)), "kind": "config-file", "stampId": None})
    out.sort(key=lambda c: (c["t"], c["what"]))
    return out


def coverage(files, day):
    """Is the TradeDay's journal all here? Uses the time range of the rows inside each published file."""
    start, flat, _ = day_window(day)
    iv = sorted((f["tmin"], f["tmax"]) for f in files if f["tmin"] is not None and f["tmax"] >= start and f["tmin"] <= flat)
    holes, cur = [], start
    for a, b in iv:
        if a - cur > 10 * 60000 and cur < flat:
            holes.append((cur, min(a, flat)))
        cur = max(cur, b)
    reached = cur
    if reached < flat:
        holes.append((max(reached, start), flat))
    sl = [f for f in files if f["kind"] == "slice" and f["tmin"] is not None and f["tmax"] >= start and f["tmin"] <= flat]
    last = max(sl, key=lambda f: (f["tmax"], f["name"])) if sl else None
    return {"complete": not holes, "holes": holes, "reached": reached if iv else None, "lastSlice": last}


# ----------------------------------------------------------------------------- experiments


def _since_ms(x):
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$", x.get("startedAtUtc") or "")
    return _utc_ms(*[int(g) for g in m.groups()[:5]]) + int(m.group(6)) * 1000 if m else 0


def run_experiment(x, J, trades, day):
    """Running n and value of one experiment from its journal rows, for rows on TradeDays up to `day`."""
    since, calc = _since_ms(x), (x.get("feeds") or {}).get("calc")
    tmap = {t["id"]: t for t in trades}
    r = {"asOfTradeDay": day, "n": 0, "value": None, "resolved": None, "unresolved": None, "verdict": "too early", "note": None, "cases": []}

    def rows(ty):
        out = []
        for j in sorted(J["by"], key=lambda j: min((q.get("t") or 0) for q in sum(J["by"][j].values(), []))):
            for q in J["by"][j].get(ty, []):
                if (q.get("t") or 0) >= since and trade_day(q["t"]) <= day:
                    out.append(q)
        return sorted(out, key=lambda q: (q.get("t") or 0, str(q.get("journalId"))))

    if calc == "tp1AtrShadow":
        res = [q for q in rows("tp1_atr_shadow") if q.get("phase") == "resolve" and q.get("session") == "ny"]
        ok = [q for q in res if q.get("state") == "resolved" and _num((q.get("shadow") or {}).get("beAfterNetUsd")) is not None and _num((q.get("live") or {}).get("netUsd")) is not None]
        r["n"], r["resolved"], r["unresolved"] = len(ok), len(ok), len(res) - len(ok)
        if ok:
            r["value"] = _r2(sum(q["shadow"]["beAfterNetUsd"] - q["live"]["netUsd"] for q in ok))
        allr = [q for q in rows("tp1_atr_shadow") if q.get("phase") == "resolve"]
        r["note"] = "value = shadow (break-even after +15) net minus live net, summed over resolved NY cases; %d resolve rows in all sessions, %d of them unresolved" % (
            len(allr), sum(1 for q in allr if q.get("state") != "resolved"))
        r["cases"] = [{"id": q.get("journalId"), "session": q.get("session"), "state": q.get("state"), "why": q.get("why")} for q in allr]
    elif calc == "earlyAdverseExit":
        ex = [q for q in rows("early_adverse_exit") if q.get("decision") == "exit" and q.get("orderSent")]
        sh = {q.get("journalId"): q for q in rows("early_adverse_shadow")}
        val, nres, tp1 = 0.0, 0, 0
        for q in ex:
            s = sh.get(q.get("journalId"))
            c = (q.get("contracts") or 3) * POINT_USD
            case = {"id": q.get("journalId"), "exitPts": _num(q.get("pts")), "shadow": s.get("result") if s else None, "why": s.get("why") if s else "no shadow row yet"}
            if s and s.get("result") == "wouldHaveHitStop" and _num(q.get("stopPts")) is not None and _num(q.get("pts")) is not None:
                case["usd"] = _r2((q["stopPts"] - abs(q["pts"])) * c)
            elif s and s.get("result") == "wouldHaveHitTp1" and _num(q.get("tp1Pts")) is not None and _num(q.get("pts")) is not None:
                case["usd"] = _r2(-(q["tp1Pts"] + abs(q["pts"])) * c)
                tp1 += 1
            if "usd" in case:
                val += case["usd"]
                nres += 1
            r["cases"].append(case)
        r["n"], r["resolved"], r["unresolved"] = len(ex), nres, len(ex) - nres
        r["value"] = _r2(val) if nres else None
        r["note"] = "n = live early exits; value = dollars saved (+) or given up (-) against the stop / TP1 the trade had, from the %d exits whose shadow resolved (%d would have hit TP1)" % (nres, tp1)
        if len(ex) >= x.get("minN", SMALL_N):
            r["verdict"] = "ready: kill rule met" if (nres and (tp1 * 4 > nres or val < 0)) else "ready: kill rule not met" if nres else "ready: no resolved shadow to judge"
    elif calc in ("runnerAllAtTp1", "runnerAtrTarget"):
        mode = "allAtTp1" if calc == "runnerAllAtTp1" else "atrTarget"
        sess = (x.get("feeds") or {}).get("sessions") or SESSIONS
        rr = [q for q in rows("runner_rule") if q.get("mode") == mode and q.get("session") in sess]
        got = []
        for q in rr:
            t = tmap.get(q.get("journalId"))
            if t and t["tp1Hit"] and t["net"] is not None:
                got.append(t)
                r["cases"].append({"id": t["id"], "session": t["session"], "net": t["net"], "exitReason": t["exitReason"]})
        r["n"] = len(got)
        r["resolved"], r["unresolved"] = len(got), len(rr) - len(got)
        r["value"] = _r2(sum(t["net"] for t in got) / len(got)) if got else None
        r["note"] = "n = trades under the rule that reached TP1 (%d fills carried the rule); value = average net dollars of those trades. What the old runner rule would have paid on the same trades is not in the journal, so the kill rule cannot be judged by this tool" % len(rr)
        if len(got) >= x.get("minN", SMALL_N):
            r["verdict"] = "ready: needs the old-rule comparison"
    elif calc == "controlParity":
        post = [t for t in trades if t["_tEntry"] >= since and t["tradeDay"] <= day]
        r["n"] = None
        r["value"] = None
        r["resolved"] = len(post)
        r["note"] = "not measurable from the journal: after the switch the old formula's score is not written, so the trades it would have blocked cannot be told apart (%d trade%s since the switch, net %s)" % (
            len(post), "" if len(post) == 1 else "s", usd(sum(t["net"] or 0 for t in post), True))
        r["verdict"] = "not measurable yet"
    else:
        r["n"], r["note"], r["verdict"] = None, "no calculator for this experiment in loop_daily.py", "not measured"
    return r


# ----------------------------------------------------------------------------- register (LOOPHOLES.md)

STATUS_WORDS = ["killed", "kept", "live", "recording", "measured", "observed", "fixed", "tracked", "open"]


def read_register(path):
    out = []
    try:
        text = open(path, encoding="utf8").read()
    except OSError:
        return out
    for line in text.split("\n"):
        m = re.match(r"\|\s*([LBR]-\d+)\s*\|(.*)\|\s*$", line)
        if not m:
            continue
        cells = [c.strip() for c in m.group(2).split("|")]
        clean = lambda s: re.sub(r"[*`]", "", s).strip()
        status_raw = clean(cells[2]) if len(cells) > 2 else ""
        low = status_raw.lower()
        pos = [(low.find(w), w) for w in STATUS_WORDS if re.search(r"\b%s\b" % w, low)]
        out.append({"id": m.group(1), "title": clean(cells[0]), "statusText": status_raw,
                    "status": min(pos)[1] if pos else (low[:24] or None),
                    "next": clean(cells[3]) if len(cells) > 3 and m.group(1)[0] != "R" else None,
                    "macDecision": "mac's decision" in low})
    return out


# ----------------------------------------------------------------------------- output helpers


def usd(x, sign=False):
    if x is None:
        return "unknown"
    s = "%s$%s" % ("-" if x < 0 else ("+" if sign and x > 0 else ""), "{:,.2f}".format(abs(x)))
    return s


def navg(x, n):
    if x is None:
        return "n/a (n=0)"
    return "%s (n=%d%s)" % (usd(x), n, ", small" if n < SMALL_N else "")


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join(["---"] * len(head)) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as f:
        f.write(json.dumps(obj, indent=1, ensure_ascii=False) + "\n")


def public_trade(t):
    return {k: v for k, v in t.items() if not k.startswith("_")}


# ----------------------------------------------------------------------------- the run


def main(argv=None):
    ap = argparse.ArgumentParser(description="Team Mac daily loop: ledger, daily card, office.json")
    ap.add_argument("--data-repo", required=True, help="local clone of the team line (read only)")
    ap.add_argument("--ref", default="FETCH_HEAD", help="git ref that holds data/ (default FETCH_HEAD)")
    ap.add_argument("--day", required=True, help="TradeDay YYYY-MM-DD, or 'latest'")
    ap.add_argument("--out", default=None, help="office directory to write into (default: the one this tool lives in)")
    ap.add_argument("--combine-start", default=COMBINE_CHAIN_START, help="first TradeDay of the virtual combine chain")
    ap.add_argument("--row-types", action="store_true", help="print the journal row types and counts, write nothing")
    a = ap.parse_args(argv)
    office = os.path.abspath(a.out) if a.out else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    repo = Repo(a.data_repo, a.ref)
    names = repo.names()
    J = load_journal(repo, names)
    if not J["files"]:
        raise SystemExit("no journal files under data/ at %s" % a.ref)
    if a.row_types:
        print(table(["row type", "rows (de-duplicated)"], sorted(J["types"].items(), key=lambda kv: (-kv[1], kv[0]))))
        print("\n%d files, %d rows, %d unreadable" % (len(J["files"]), J["rows"], J["bad"]))
        return 0
    trades = build_ledger(J)
    day = trade_day(J["tmax"]) if a.day == "latest" else a.day
    if not re.match(r"\d{4}-\d\d-\d\d$", day):
        raise SystemExit("--day must be YYYY-MM-DD or latest")
    start, flat, end = day_window(day)
    cov = coverage(J["files"], day)

    # ---- ledger (all days, keyed by journal id)
    dump(os.path.join(office, "state", "ledger.json"), {
        "schema": SCHEMA, "source": {"ref": a.ref, "files": len(J["files"]), "rows": J["rows"], "lastRow": iso_utc(J["tmax"])},
        "note": "one row per closed trade, keyed by journal id; money from the broker's realized P&L row unless moneySource is 'estimate'; MFE / MAE are lower bounds from the named journal source",
        "trades": [public_trade(t) for t in trades]})

    # ---- days up to the requested one
    upto = [t for t in trades if t["tradeDay"] <= day]
    todays = [t for t in upto if t["tradeDay"] == day]
    tdays = sorted(d for d in J["dayRows"] if d <= day and datetime.date(*[int(x) for x in d.split("-")]).weekday() < 5 and (J["dayRows"][d] >= 50 or any(t["tradeDay"] == d for t in upto)))
    if day not in tdays:
        tdays.append(day)
    by_day = {d: [t for t in upto if t["tradeDay"] == d] for d in tdays}
    holes_past = [d for d in tdays[-HISTORY_DAYS:] if d != day and not coverage(J["files"], d)["complete"]]
    sim_days = [{"day": d, "complete": (d != day or cov["complete"]),
                 "trades": [{"net": t["net"] or 0.0, "worstOpen": (t["maePts"] * (t["contracts"] or 3) * POINT_USD) if t["maePts"] is not None else None} for t in by_day[d]]}
                for d in tdays]
    chain = combine_chain(sim_days, a.combine_start)
    cur = chain[-1] if chain else None
    hist, hist_runs = combine_history(sim_days)
    hist["window"] = "last %d TradeDays" % HISTORY_DAYS

    # ---- score
    sc = score(todays)
    by_sess = {s: score([t for t in todays if t["session"] == s]) for s in SESSIONS}
    wk = iso_week(day)
    wdays = [d for d in tdays if iso_week(d) == wk]
    wtr = [t for t in upto if t["tradeDay"] in wdays]
    wsc = score(wtr)

    # ---- autopsy
    ap_all = autopsy(upto)
    ap_day = [x for x in ap_all if x["trade"]["tradeDay"] == day]
    last5 = tdays[-LEAK_DAYS:]
    ap5 = [x for x in ap_all if x["trade"]["tradeDay"] in last5]
    leak5 = {}
    for x in ap5:
        key = x["leak"] if x["leak"] != "unclassified" else "unclassified: " + x["why"]
        g = leak5.setdefault(key, {"n": 0, "usd": 0.0})
        g["n"] += 1
        g["usd"] += x["trade"]["net"]
    leak_rank = sorted(leak5.items(), key=lambda kv: (kv[1]["usd"], kv[0]))

    # ---- blocked signals
    blocks = [b for b in J["blocks"] if _num(b.get("t")) and start <= b["t"] < end]
    samples, lm_used = load_price_samples(repo, names, day)
    gates, block_rows = audit_blocks(blocks, samples)

    # ---- settings changes, health
    configs = load_configs(repo, names)
    changes_all = settings_changes(J["stamps"], configs)
    changes = [c for c in changes_all if start <= c["t"] < end]
    stamps_day = sorted([s for s in J["stamps"] if _num(s.get("t")) and start <= s["t"] < end], key=lambda s: s["t"])
    stamps_upto = sorted([s for s in J["stamps"] if _num(s.get("t")) and s["t"] < end], key=lambda s: s["t"])
    build = stamps_upto[-1].get("stampId") if stamps_upto else None
    alerts = sorted([x for x in J["alerts"] if _num(x.get("t")) and start <= x["t"] < end], key=lambda x: x["t"])
    notes = []
    est = [t for t in todays if t["moneySource"] != "broker"]
    if est:
        notes.append("%d of %d trades have no broker P&L row yet: their money is the bot's estimate" % (len(est), len(todays)))
    rec_n = rec_sum = 0
    led_real = 0.0
    for t in todays:
        if t["moneySource"] == "broker":
            led_real += t["realized"] or 0.0
        r = J["receipts"].get(t["id"])
        if r:
            rec_n += 1
            rec_sum += r["realized"]
    brk_n = sum(1 for t in todays if t["moneySource"] == "broker")
    recon_ok = (rec_n == brk_n and abs(rec_sum - led_real) < 0.005)
    if not recon_ok:
        notes.append("ledger and broker receipts disagree: ledger %d trades $%.2f, receipts %d trades $%.2f (gross - fees basis)" % (brk_n, led_real, rec_n, rec_sum))
    for x in alerts:
        notes.append("%s alert at %s: %s" % (x.get("kind") or "bot", pt_hm(x["t"]), str(x.get("title") or x.get("reason") or "")[:60]))
    if holes_past:
        notes.append("earlier TradeDays with journal hours missing (their results may be short): " + ", ".join(holes_past))
    no_exc = sum(1 for t in todays if t["maePts"] is None)
    if no_exc:
        notes.append("%d trades have no open-excursion data: the virtual combine tests them on closed P&L only" % no_exc)
    for o in sorted([o for o in J["orphans"] if _num(o.get("t")) and start <= o["t"] < end], key=lambda o: o["t"]):
        notes.append("orphan sweep at %s (%s): %d order(s) cancelled" % (pt_hm(o["t"]), o.get("where"), len(o.get("cancelled") or [])))
    data_note = None
    if not cov["complete"]:
        if cov["reached"] is None:
            data_note = "no journal rows for this TradeDay"
        else:
            data_note = "TradeDay incomplete: journal missing " + "; ".join("%s to %s" % (pt_hm(h0, True), pt_hm(h1, True)) for h0, h1 in cov["holes"])
        notes.insert(0, data_note)

    # ---- experiments
    xpath = os.path.join(office, "state", "experiments.json")
    try:
        xdoc = json.load(open(xpath, encoding="utf8"))
    except (OSError, ValueError):
        raise SystemExit("office/state/experiments.json is missing or unreadable: it tells the tool which journal rows feed which experiment")
    for x in xdoc.get("experiments", []):
        x["running"] = run_experiment(x, J, trades, day)
    dump(xpath, xdoc)

    # ---- register
    reg = read_register(os.path.join(office, "LOOPHOLES.md"))
    x_by_leak = {x.get("leak"): x for x in xdoc.get("experiments", [])}
    leaks = []
    for e in reg:
        if e["id"][0] == "R":
            continue
        g = leak5.get(e["id"])
        n, u = (g["n"], _r2(g["usd"])) if g else (None, None)
        if g is None and e["id"] in x_by_leak:
            n = x_by_leak[e["id"]]["running"]["n"]
        leaks.append({"id": e["id"], "title": e["title"], "status": e["status"], "n": n, "usd": u, "next": e["next"]})
    waiting = []
    k = 0
    for c in chain:
        if c["status"] in ("passed", "breached") and c["endDay"] == day:
            k += 1
            waiting.append({"id": "D-%s-%02d" % (day, k), "text": "The virtual combine started %s %s on %s (profit %s)." % (c["startDay"], c["status"], day, usd(c["profit"], True)),
                            "recommendation": "Read the day's card before any change; no rule changes mid-session."})
    for x in xdoc.get("experiments", []):
        if str(x["running"]["verdict"]).startswith("ready"):
            k += 1
            waiting.append({"id": "D-%s-%02d" % (day, k), "text": "%s (%s) has its %d cases: %s." % (x["id"], x.get("title"), x.get("minN", SMALL_N), x["running"]["verdict"]),
                            "recommendation": "Decide keep / kill on the weekly card against the kill rule written in office/EXPERIMENTS.md."})
    for e in reg:
        if e["id"][0] == "R" and e["macDecision"]:
            waiting.append({"id": e["id"], "text": e["title"], "recommendation": None})

    office_json = {
        "schema": SCHEMA,
        "generatedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tradeDay": day,
        "data": {"lastSlice": re.sub(r"^data/|\.jsonl\.gz$", "", cov["lastSlice"]["name"]) if cov["lastSlice"] else None,
                 "rows": cov["lastSlice"]["rows"] if cov["lastSlice"] else None, "complete": cov["complete"], "note": data_note},
        "objective": dict(OBJECTIVE),
        "combine": {"mode": "virtual",
                    "current": ({"startDay": cur["startDay"], "profit": cur["profit"], "floorRoom": cur["floorRoom"], "bestDay": cur["bestDay"],
                                 "bestDayPct": cur["bestDayPct"], "days": cur["days"], "status": cur["status"], "needPerDay": None} if cur else None),
                    "history": hist},
        "day": {"net": sc["net"], "trades": sc["trades"], "wins": sc["wins"], "losses": sc["losses"], "fullStops": sc["fullStops"],
                "avgWin": sc["avgWin"], "avgLoss": sc["avgLoss"], "fees": sc["fees"],
                "bySession": {s: {"net": by_sess[s]["net"], "trades": by_sess[s]["trades"], "fullStops": by_sess[s]["fullStops"]} for s in SESSIONS}},
        "week": {"net": wsc["net"], "trades": wsc["trades"], "fullStops": wsc["fullStops"], "lossToWin": wsc["lossToWin"],
                 "days": [{"day": d, "net": score(by_day[d])["net"], "trades": len(by_day[d]), "fullStops": sum(1 for t in by_day[d] if t["fullStop"])} for d in wdays]},
        "health": {"restarts": len(stamps_day), "settingsChanges": [{"t": iso_utc(c["t"]), "what": c["what"]} for c in changes], "build": build, "notes": notes},
        "leaks": leaks,
        "experiments": [{"id": x["id"], "title": x.get("title"), "mode": x.get("mode"), "n": x["running"]["n"], "minN": x.get("minN", SMALL_N),
                         "value": x["running"]["value"], "unit": x.get("unit"), "verdict": x["running"]["verdict"]} for x in xdoc.get("experiments", [])],
        "blocked": gates,
        "waitingOnMac": waiting,
        "flags": [{"t": iso_utc(f.get("t")), "trade": f.get("journalId") or f.get("trade"), "reason": f.get("reason"), "answer": None}
                  for f in sorted([f for f in J["flags"] if _num(f.get("t")) and start <= f["t"] < end], key=lambda f: f["t"])],
    }
    dump(os.path.join(office, "state", "office.json"), office_json)

    # ---- the card
    card = render_card(day, cov, data_note, sc, by_sess, todays, chain, cur, hist, hist_runs, sim_days, ap_day, leak_rank, last5, gates, block_rows,
                       samples, lm_used, xdoc, changes, changes_all, stamps_day, build, notes, waiting, wdays, by_day, wsc, recon_ok, brk_n, led_real, rec_n, rec_sum, reg)
    p = os.path.join(office, "reviews", "daily", day + ".md")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf8") as f:
        f.write(card)
    print("TradeDay %s: %d trades, net %s, complete=%s; ledger %d trades over %d TradeDays; combine %s" % (
        day, sc["trades"], usd(sc["net"], True), cov["complete"], len(trades), len(set(t["tradeDay"] for t in trades)), cur["status"] if cur else "none"))
    return 0


def render_card(day, cov, data_note, sc, by_sess, todays, chain, cur, hist, hist_runs, sim_days, ap_day, leak_rank, last5, gates, block_rows,
                samples, lm_used, xdoc, changes, changes_all, stamps_day, build, notes, waiting, wdays, by_day, wsc, recon_ok, brk_n, led_real, rec_n, rec_sum, reg):
    L = []
    L.append("# Daily card: TradeDay %s" % day)
    L.append("")
    if not cov["complete"]:
        L.append("> **INCOMPLETE DAY.** %s. Every number below covers only the part of the day that is published; do not judge the day on it." % (data_note or "data missing"))
        L.append("")
    # headline
    if sc["trades"]:
        head = "%s on %d trade%s: %d win%s, %d loss%s, %d full stop%s." % (
            usd(sc["net"], True), sc["trades"], "" if sc["trades"] == 1 else "s", sc["wins"], "" if sc["wins"] == 1 else "s",
            sc["losses"], "" if sc["losses"] == 1 else "es", sc["fullStops"], "" if sc["fullStops"] == 1 else "s")
    else:
        head = "No closed trades."
    if cur:
        head += " Virtual combine (started %s): %s, profit %s, %s above the floor." % (cur["startDay"], cur["status"], usd(cur["profit"], True), usd(cur["floorRoom"]))
    L.append("**%s**" % head)
    L.append("")
    L.append("Practice account, 3 MNQ contracts. Money is the broker's net per trade (after fees and commissions). Times are PT.")
    L.append("")
    # scoreboard
    L.append("## Scoreboard")
    L.append("")
    rows = []
    for name, s in [(x, by_sess[x]) for x in SESSIONS] + [("**day**", sc)]:
        rows.append([name, usd(s["net"], True) if s["trades"] else "-", s["trades"], s["wins"], s["losses"], s["fullStops"],
                     navg(s["avgWin"], s["wins"]) if s["trades"] else "-", navg(s["avgLoss"], s["losses"]) if s["trades"] else "-",
                     ("%.2f" % s["lossToWin"]) if s["lossToWin"] is not None else "-", usd(s["fees"]) if s["fees"] is not None else "-"])
    L.append(table(["session", "net", "trades", "wins", "losses", "full stops", "average win", "average loss", "loss / win", "fees"], rows))
    L.append("")
    L.append("Sessions are the bot's own, by the fill time: asia 15:00-24:00, london 00:00-06:30, ny 06:30-13:00, late 13:00-15:00.")
    if sc["trades"]:
        streak = best = 0
        for t in todays:
            streak = streak + 1 if t["fullStop"] else 0
            best = max(best, streak)
        L.append("Worst run of full stops in a row: %d (risk R-02: there is no daily loss limit)." % best)
    L.append("")
    L.append("Week %s so far: %s on %d trades, %d full stops, loss / win %s." % (iso_week(day), usd(wsc["net"], True), wsc["trades"], wsc["fullStops"],
             ("%.2f (n=%d wins, %d losses%s)" % (wsc["lossToWin"], wsc["wins"], wsc["losses"], ", small" if min(wsc["wins"], wsc["losses"]) < SMALL_N else "")) if wsc["lossToWin"] is not None else "n/a"))
    L.append("")
    L.append(table(["TradeDay", "net", "trades", "full stops"], [[d, usd(score(by_day[d])["net"], True), len(by_day[d]), sum(1 for t in by_day[d] if t["fullStop"])] for d in wdays]))
    L.append("")
    # combine
    L.append("## Virtual combine")
    L.append("")
    L.append("Topstep $50K rules replayed over the real results: target $3,000; floor $2,000 below the start, trailing the end-of-day balance up and locking at the start balance; tested against open P&L inside each trade; best day under 55% of profit.")
    L.append("")
    if chain:
        rows = []
        for c in chain:
            how = ""
            if c["breach"]:
                how = " (%s P&L, equity %s at floor %s)" % ("open" if c["breach"]["how"] == "open" else "closed", usd(c["breach"]["equity"], True), usd(c["breach"]["floor"], True))
            rows.append([c["startDay"], c["status"] + how + (" (day not over)" if c["provisionalDay"] else ""), c["endDay"], c["days"], usd(c["profit"], True),
                         usd(c["floorRoom"]), usd(c["bestDay"]), ("%.0f%%" % c["bestDayPct"]) if c["bestDayPct"] is not None else "-", usd(c["target"])])
        L.append(table(["started", "status", "last day", "days", "profit", "room above floor", "best day", "best day share", "target now"], rows))
        L.append("")
        miss = sum(c["tradesNoExcursion"] for c in chain)
        tot = sum(c["trades"] for c in chain)
        L.append("Open P&L test: %d of %d trades in these runs carry a worst-excursion reading from the journal%s. The reading is a lower bound (1-minute bars and about 20 s price polls), so a real combine could have been closer to the floor than shown." % (
            tot - miss, tot, "" if not miss else "; the other %d are tested on closed P&L only" % miss))
    else:
        L.append("No virtual combine has started yet.")
    L.append("")
    L.append("If a combine had been started on each of the last %d TradeDays (%s to %s): %d passed, %d breached, %d still open." % (
        hist["started"], hist_runs[0]["startDay"] if hist_runs else "-", hist_runs[-1]["startDay"] if hist_runs else "-", hist["passed"], hist["breached"], hist["open"]))
    L.append("")
    # autopsy
    L.append("## Loss autopsy")
    L.append("")
    if ap_day:
        for x in ap_day:
            t = x["trade"]
            L.append("- %s %s %s at %s: %s, %s; worst %s pts, best %s pts, %s min -> **%s** (%s)" % (
                pt_hm(t["_tEntry"]), t["session"], (t["side"] or "?").upper(), t["level"] or "unknown level", t["exitReason"], usd(t["net"], True),
                ("%.2f" % t["maePts"]) if t["maePts"] is not None else "unknown", ("+%.2f" % t["mfePts"]) if t["mfePts"] is not None else "unknown",
                ("%.1f" % (t["durationSec"] / 60.0)) if t["durationSec"] is not None else "?", x["leak"], x["why"]))
    else:
        L.append("No losing trades.")
    L.append("")
    L.append("Leak classes by dollars, last %d TradeDays (%s to %s):" % (len(last5), last5[0], last5[-1]))
    L.append("")
    if leak_rank:
        L.append(table(["leak class", "losing trades", "dollars"], [[k, "%d%s" % (v["n"], " (small)" if v["n"] < SMALL_N else ""), usd(v["usd"], True)] for k, v in leak_rank]))
    else:
        L.append("No losing trades in the window.")
    L.append("")
    L.append("Classes come from office/LOOPHOLES.md. L-01 = went to the full stop or was closed by the early exit; L-07 = same-side entry within %d min of a full stop; anything else is unclassified and named by its exit, a candidate for the register." % REENTRY_MIN)
    L.append("")
    # blocked
    L.append("## Blocked-signal audit")
    L.append("")
    if gates:
        L.append(table(["gate", "block rows", "would have won", "would have lost", "neither in 60 min", "unknown"],
                       [[g["gate"], g["count"], g["wouldHaveWon"], g["wouldHaveLost"], g["neither"], g["unknown"]] for g in gates]))
        L.append("")
        why = {}
        for r in block_rows:
            if r["result"] == "unknown":
                why[r["why"]] = why.get(r["why"], 0) + 1
        if why:
            L.append("Unknown because: " + "; ".join("%s (%d)" % (k, v) for k, v in sorted(why.items(), key=lambda kv: (-kv[1], kv[0]))) + ".")
        nstop = sum(1 for r in block_rows if r["stopFromRow"])
        L.append("Won = price reached +%d pts before the stop distance within %d minutes of the block. Stop distance: the block row's own (%d rows) or %d pts when the row carries none (%d rows)." % (
            TP_PTS, WALK_MIN, nstop, DEFAULT_STOP_PTS, len(block_rows) - nstop))
        L.append("Price source: the levels-minute file (%d samples, one about every 52-80 s, last price only, no high / low). A touch between two samples is not seen, so wins and losses are both under-counted; a block row is written at most once per reason per 15-minute candle, so one setup can appear more than once." % len(samples))
    else:
        L.append("No blocked-signal rows in the journal for this TradeDay.")
    L.append("")
    # experiments
    L.append("## Experiments")
    L.append("")
    rows = []
    for x in xdoc.get("experiments", []):
        r = x["running"]
        n = "unknown" if r["n"] is None else "%d of %d%s" % (r["n"], x.get("minN", SMALL_N), " (small)" if r["n"] < SMALL_N else "")
        rows.append([x["id"], x.get("title"), x.get("mode"), "since " + pt_hm(_since_ms(x), True), n,
                     "unknown" if r["value"] is None else "%s (%s)" % (usd(r["value"], True), x.get("unit")), r["verdict"]])
    L.append(table(["id", "rule", "mode", "counted", "cases", "value", "verdict"], rows))
    L.append("")
    for x in xdoc.get("experiments", []):
        if x["running"].get("note"):
            L.append("- %s: %s." % (x["id"], x["running"]["note"]))
    L.append("")
    # health
    L.append("## Health")
    L.append("")
    L.append("- Data: %s. Last slice %s." % ("complete through 13:10 PT" if cov["complete"] else (data_note or "incomplete"),
             re.sub(r"^data/|\.jsonl\.gz$", "", cov["lastSlice"]["name"]) if cov["lastSlice"] else "none"))
    L.append("- Bot starts in the TradeDay: %d%s. Build now: %s." % (len(stamps_day), (" (" + ", ".join(pt_hm(s["t"], True) for s in stamps_day) + ")") if stamps_day else "", build or "unknown"))
    L.append("- Ledger against the broker receipts (gross - fees basis): ledger %d trades %s, receipts %d trades %s: %s." % (brk_n, usd(led_real, True), rec_n, usd(rec_sum, True), "match" if recon_ok else "MISMATCH"))
    for n in notes:
        if n != data_note and not n.startswith("ledger and broker receipts"):
            L.append("- %s." % n.rstrip("."))
    L.append("- Skipped fast checks (\"fetch failed\", B-01) are not in the journal: unknown from this data.")
    L.append("")
    if changes:
        L.append("Settings and code changes in this TradeDay, with the day's trades before and after each change time:")
        L.append("")
        rows = []
        times = sorted(set(c["t"] for c in changes))
        for tt in times:
            what = "; ".join(c["what"] for c in changes if c["t"] == tt)
            b = [t for t in todays if t["_tEntry"] < tt]
            af = [t for t in todays if t["_tEntry"] >= tt]
            rows.append([pt_hm(tt, True), what, "%d trade%s, %s" % (len(b), "" if len(b) == 1 else "s", usd(sum(t["net"] or 0 for t in b), True)), "%d trade%s, %s" % (len(af), "" if len(af) == 1 else "s", usd(sum(t["net"] or 0 for t in af), True))])
        L.append(table(["change time", "what changed", "before (this day)", "after (this day)"], rows))
        L.append("")
        L.append("Before / after splits of one day are small samples: they show what ran under which settings, not an effect.")
    else:
        last = [c for c in changes_all if c["t"] < day_window(day)[0]]
        L.append("No settings or code change in this TradeDay%s." % ((" (last one: %s, %s)" % (pt_hm(last[-1]["t"], True), last[-1]["what"])) if last else ""))
    L.append("")
    # Mac
    L.append("## What needs Mac")
    L.append("")
    new = [w for w in waiting if w["id"].startswith("D-")]
    old = [w for w in waiting if not w["id"].startswith("D-")]
    if new:
        for w in new:
            L.append("- **%s** %s %s" % (w["id"], w["text"], w["recommendation"] or ""))
    else:
        L.append("Nothing new from this day.")
    if old:
        L.append("")
        L.append("Still open in the register (Mac's decisions): " + "; ".join("%s %s" % (w["id"], w["text"]) for w in old) + ".")
    L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
