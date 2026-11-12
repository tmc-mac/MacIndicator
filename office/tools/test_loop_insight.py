"""Tests for office/tools/loop_insight.py (terminal 2.3 additions to the daily loop). From the repository root, with the patch applied:
    python3 -I -m unittest discover -s office/tools -p 'test_loop_insight.py'
The acceptance tests read the real journal: set TEAM_LINE_REPO to a clone of the team line that has origin/agent-line fetched
(TEAM_LINE_REF, default origin/agent-line). Without it they are skipped and say so; the rule tests always run."""
import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import loop_daily as ld  # noqa: E402
import loop_insight as li  # noqa: E402

REPO, REF = os.environ.get("TEAM_LINE_REPO"), os.environ.get("TEAM_LINE_REF", "origin/agent-line")
OFFICE_SRC = os.environ.get("OFFICE_SRC") or os.path.dirname(HERE)      # where experiments.json and LOOPHOLES.md are read from


def load(p):
    with open(p, encoding="utf8") as f:
        return json.load(f)


def rows(*r):
    return [{"k": i, "min": m, "close": c, "best": b, "worst": w, "t": 1000000 + int(m * 60000)} for i, (m, c, b, w) in enumerate(r)]


def trade(**kw):
    t = {"id": "t1", "contracts": 3, "fees": 3.66, "net": -254.16, "stopPts": 40.25, "tp1": 100.0, "entry": 115.0, "session": "asia", "tp1Hit": False,
         "fullStop": True, "mfePts": 15.0, "mfeSource": "trade_state 1m bars", "rules": {}}
    t.update(kw)
    return t


class Rules(unittest.TestCase):
    def test_no_rows_is_unknown_for_every_rule(self):
        w = li.what_if(trade(), [])
        self.assertEqual([w[k]["fires"] for k, _ in li.RULES], [None, None, None])
        self.assertTrue(all("no per-minute rows" in w[k]["why"] for k, _ in li.RULES))

    def test_break_even_fires_at_a_later_close_under_the_entry(self):
        w = li.what_if(trade(), rows((0.7, 1.75, 1.75, 0), (1.7, 9.5, 10.75, -2), (2.7, 6.5, 15, -4.75), (3.7, -4.5, 15, -6.5), (4.7, -29.75, 15, -32.25)))
        self.assertEqual(w["beAfter10"], {"fires": True, "why": "close -4.50 at minute 3.7 after +15.00", "usd": -30.66, "savedUsd": 223.5, "atMin": 3.7, "basis": "priced at the 1-minute close that triggers it"})
        self.assertEqual((w["tp1OnTouch"]["fires"], w["tp1OnTouch"]["usd"], w["tp1OnTouch"]["savedUsd"]), (True, 86.34, 340.5))
        self.assertEqual(w["earlyExit"]["fires"], False)

    def test_break_even_unknown_when_high_and_low_share_the_last_row(self):
        w = li.what_if(trade(net=-296.16, stopPts=48.5, mfePts=11.75), rows((0.3, -3, 0, -3), (1.3, -6.75, 0, -7), (2.3, 7.5, 9, -7), (3.3, -12.25, 11.75, -17.75)))
        self.assertIsNone(w["beAfter10"]["fires"])
        self.assertIn("+11.75 and -17.75 fall in the same minute (minute 3)", w["beAfter10"]["why"])
        self.assertEqual(w["tp1OnTouch"], {"fires": False, "why": "not touched (best +11.75)"})
        self.assertEqual(w["earlyExit"], {"fires": False, "why": "close +7.50 at 2.3 min"})

    def test_the_stop_wins_a_minute_that_holds_both(self):
        w = li.what_if(trade(stopPts=30, mfePts=16), rows((0.5, -2, 0, -2), (1.5, -30, 16, -30.5)))
        self.assertEqual(w["beAfter10"]["fires"], False)
        self.assertEqual(w["tp1OnTouch"]["fires"], False)
        self.assertIn("the stop wins", w["tp1OnTouch"]["why"])

    def test_early_exit_fires_only_when_never_plus_3(self):
        w = li.what_if(trade(net=-300.0, mfePts=0), rows((1.0, -4, 0, -5), (2.2, -11, 0, -12), (3.2, -30, 0, -31)))
        self.assertEqual((w["earlyExit"]["fires"], w["earlyExit"]["usd"], w["earlyExit"]["savedUsd"], w["earlyExit"]["atMin"]), (True, -69.66, 230.34, 2.2))
        w = li.what_if(trade(net=-300.0, mfePts=4), rows((1.0, 2, 4, -5), (2.2, -11, 4, -12)))
        self.assertEqual(w["earlyExit"]["fires"], False)
        self.assertIn("had been +4.00", w["earlyExit"]["why"])

    def test_early_exit_already_on_is_never_an_estimate(self):
        w = li.what_if(trade(rules={"earlyAdverse": {"mode": "exit", "exited": False, "pts": -4.5}}), rows((1.0, -4, 0, -5), (2.2, -11, 0, -12)))
        self.assertEqual(w["earlyExit"]["fires"], False)
        self.assertIn("rule already on", w["earlyExit"]["why"])

    def test_a_winner_is_cut_only_when_the_close_under_entry_comes_before_tp1(self):
        r = rows((0.7, 2, 2, 2), (1.7, 3.75, 14.5, 0.5), (2.7, 1.5, 14.5, -2), (3.7, -2, 14.5, -7.25), (4.7, 2, 14.5, -7.25))
        t = trade(net=86.34, tp1Hit=True, fullStop=False)
        late = li.what_if(t, r, tp1_ms=r[-1]["t"] + 60000)
        self.assertEqual((late["beAfter10"]["fires"], late["beAfter10"]["savedUsd"]), (True, -102.0))
        early = li.what_if(t, r, tp1_ms=r[1]["t"] + 1000)
        self.assertEqual(early["beAfter10"], {"fires": False, "why": "TP1 filled first"})
        same = li.what_if(t, r, tp1_ms=r[3]["t"] - 1000)
        self.assertIsNone(same["beAfter10"]["fires"])
        self.assertEqual(late["tp1OnTouch"], {"fires": False, "why": "TP1 filled"})

    def test_ny_tp1_on_touch_is_a_floor(self):
        w = li.what_if(trade(session="ny"), rows((0.7, 2, 2, 0), (1.7, 9, 15.25, 0), (2.7, -40, 15.25, -41)))
        self.assertEqual((w["tp1OnTouch"]["usd"], w["tp1OnTouch"].get("floor")), (60.34, True))

    def test_classes(self):
        c = lambda m, hit=False: li.stop_class({"mfePts": m, "tp1Hit": hit})
        self.assertEqual([c(None), c(0), c(2.75), c(3), c(9.75), c(10), c(14.75), c(15), c(40), c(15, True)],
                         ["noReading", "under3", "under3", "b3to10", "b3to10", "b10to15", "b10to15", "b15plus", "b15plus", "b10to15"])


class Shape(unittest.TestCase):
    def _doc(self, n=3, path=10):
        stops = [{"id": "%08d" % i, "path": [1.25] * path, "pathMin": [0.5] * path, "whatIf": {}} for i in range(n)]
        return {"schema": 1, "generatedAt": "2026-11-11T22:25:04Z", "stops": stops, "dropped": {"paths": 0}}

    def test_encode_is_json_one_stop_per_line_and_stable(self):
        d = self._doc()
        b = li.encode(d)
        self.assertEqual(json.loads(b.decode("utf8"))["stops"], d["stops"])
        self.assertEqual(b, li.encode(copy.deepcopy(d)))
        self.assertEqual(b.count(b"\n"), len(d["stops"]) + 2)

    def test_experiments_stay_small(self):
        # 10 experiments with 20 cases each (the real texts of experiments.json, the longest kill rule included): office.json stays under 60 KB
        src = load(os.path.join(OFFICE_SRC, "state", "experiments.json"))["experiments"]
        src = (src + src)[:10]
        self.assertEqual(len(src), 10)
        trades = [{"id": "%08x-aaaa" % i, "tradeDay": "2026-11-11", "entryTime": "2026-11-11T05:45:10Z", "session": "london", "net": -129.66, "rules": {}, "tp1Hit": True,
                   "afterFullStopMin": 12.5, "mfePts": 20.0, "exitReason": "tp1-then-runner", "_tEntry": 0} for i in range(20)]
        xdoc = {"experiments": []}
        for n, x in enumerate(src):
            x = dict(x, id="X-%02d" % n)
            x["running"] = {"n": 20, "value": 229.5, "resolved": 14, "unresolved": 6, "verdict": "too early", "note": "n" * 300,
                            "cases": [{"id": t["id"], "session": "london", "net": -129.66, "exitReason": "tp1-then-runner", "minAfterStop": 12.5, "exitPts": -10.25,
                                       "shadow": "unresolved" if i % 3 == 0 else "wouldHaveHitStop", "why": "another trade opened" if i % 3 == 0 else None, "usd": 229.5,
                                       "state": "unresolved" if i % 3 == 0 else "resolved", "reason": "profit_lock"} for i, t in enumerate(trades)]}
            xdoc["experiments"].append(x)
        base = load(os.path.join(OFFICE_SRC, "state", "office.json"))
        base["experiments"] = [{"id": x["id"], "title": x.get("title"), "mode": x.get("mode"), "n": 20, "minN": 20, "value": 229.5, "unit": x.get("unit"), "verdict": "too early"} for x in xdoc["experiments"]]
        J = {"by": {}}
        li.extend_experiments(ld, base, xdoc, J, trades, "2026-11-11", ["2026-11-10", "2026-11-11"])
        self.assertTrue(all(len(x["cases"]) == 20 and x["killIf"] for x in base["experiments"]))
        size = len(json.dumps(base, indent=1, ensure_ascii=False).encode("utf8"))
        self.assertLess(size, 60000, size)


@unittest.skipUnless(REPO, "TEAM_LINE_REPO not set: the acceptance tests on the real journal were NOT run")
class Acceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="insight-", dir=os.environ.get("INSIGHT_TMP"))
        cls.out = {}
        for tag, day in (("d10", "2026-11-10"), ("d11", "2026-11-11"), ("d11b", "2026-11-11")):
            o = os.path.join(cls.tmp, tag)
            os.makedirs(os.path.join(o, "state"))
            os.makedirs(os.path.join(o, "reviews", "daily"))
            shutil.copy(os.path.join(OFFICE_SRC, "state", "experiments.json"), os.path.join(o, "state"))
            shutil.copy(os.path.join(OFFICE_SRC, "LOOPHOLES.md"), o)
            ld.main(["--data-repo", REPO, "--ref", REF, "--day", day, "--out", o])
            cls.out[tag] = o
        cls.a10 = load(os.path.join(cls.out["d10"], "state", "autopsy.json"))
        cls.a11 = load(os.path.join(cls.out["d11"], "state", "autopsy.json"))
        cls.o11 = load(os.path.join(cls.out["d11"], "state", "office.json"))
        cls.led = load(os.path.join(cls.out["d11"], "state", "ledger.json"))
        cls.xsrc = load(os.path.join(OFFICE_SRC, "state", "experiments.json"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_1_tradeday_1110_two_stops_as_specified(self):
        s = [x for x in self.a10["stops"] if x["tradeDay"] == "2026-11-10"]
        self.assertEqual(len(s), 2)
        self.assertEqual(round(sum(x["net"] for x in s), 2), -550.32)
        b, a = s                                   # newest first: 23:57 PT, then 20:10 PT
        self.assertEqual({k: a[k] for k in ("id", "entryUtc", "session", "side", "level", "event", "grade", "controlScore", "stopPts", "net", "r", "minToStop", "mfePts", "mfeAtMin", "maePts", "class", "slipPts")},
                         {"id": "26e07b5b", "entryUtc": "2026-11-10T04:10:15Z", "session": "asia", "side": "short", "level": "1H Open", "event": "SWEEP-LOSS", "grade": "B", "controlScore": -0.33,
                          "stopPts": 40.25, "net": -254.16, "r": -1.05, "minToStop": 9.8, "mfePts": 15.0, "mfeAtMin": 6.7, "maePts": -41.75, "class": "b15plus", "slipPts": -1.5})
        self.assertEqual(a["path"], [1.75, 1.75, 9.5, 4, 4.25, 10, 6.5, -4.5, -16.5, -29.75])
        self.assertEqual(a["whatIf"]["earlyExit"], {"fires": False, "why": "close +9.50 at 2.7 min"})
        self.assertEqual({k: a["whatIf"]["beAfter10"][k] for k in ("fires", "usd", "savedUsd", "atMin")}, {"fires": True, "usd": -30.66, "savedUsd": 223.5, "atMin": 7.7})   # priced at the trigger close (-4.50), not at the entry
        self.assertEqual({k: a["whatIf"]["tp1OnTouch"][k] for k in ("fires", "usd", "savedUsd")}, {"fires": True, "usd": 86.34, "savedUsd": 340.5})
        self.assertEqual({k: b[k] for k in ("id", "session", "side", "level", "event", "grade", "controlScore", "stopPts", "net", "minToStop", "mfePts", "maePts", "class")},
                         {"id": "667680f7", "session": "asia", "side": "short", "level": "15m Open", "event": "SWEEP-LOSS", "grade": "B", "controlScore": -0.25, "stopPts": 48.5, "net": -296.16,
                          "minToStop": 4.2, "mfePts": 11.75, "maePts": -48.75, "class": "b10to15"})
        self.assertEqual(b["whatIf"]["earlyExit"]["fires"], False)
        self.assertIsNone(b["whatIf"]["beAfter10"]["fires"])
        self.assertIn("+11.75 and -17.75 fall in the same minute (minute 3)", b["whatIf"]["beAfter10"]["why"])
        self.assertEqual(b["whatIf"]["tp1OnTouch"]["fires"], False)

    def test_2_window_class_table(self):
        a = self.a11
        self.assertEqual(a["window"], {"from": "2026-10-15", "to": "2026-11-11", "tradeDays": 20, "complete": False, "note": a["window"]["note"]})
        self.assertEqual({k: a["totals"][k] for k in ("trades", "net", "fullStops", "fullStopNet", "fullStopsPer10")}, {"trades": 346, "net": -4914.68, "fullStops": 99, "fullStopNet": -21159.10, "fullStopsPer10": 2.9})
        # the ledger's own flag (the ORIGINAL rule): 100 / -21,146.82; one of them (10/19, +$12.28) is a stop fill on the profit side and is excluded
        self.assertEqual((a["totals"]["ledgerFullStops"], a["totals"]["ledgerFullStopNet"]), (100, -21146.82))
        self.assertEqual([(x["id"], x["net"]) for x in a["excluded"]], [("6980a062", 12.28)])
        self.assertEqual(a["ownTp1"], {"n": 1, "usd": -254.16, "unknown": 27})
        self.assertEqual([(c["fromBars"], c["fromLowerBound"]) for c in a["classes"]], [(13, 18), (4, 15), (2, 11), (1, 8), (0, 0)])
        self.assertTrue(all("addressedBy" not in c for c in a["classes"]))
        self.assertEqual([(c["k"], c["n"], c["usd"]) for c in a["classes"]],
                         [("under3", 31, -6376.30), ("b3to10", 19, -3688.42), ("b10to15", 13, -3067.08), ("b15plus", 9, -2078.44), ("noReading", 27, -5948.86)])
        self.assertEqual(sum(c["n"] for c in a["classes"]), 99)
        self.assertEqual(round(sum(c["usd"] for c in a["classes"]), 2), -21159.10)
        self.assertEqual([(o["k"], o["n"]) for o in a["overlays"]], [("reentry30", 21), ("nyLate", 22)])
        self.assertEqual(a["overlays"][0]["usd"], -4036.10)
        self.assertEqual({k: (v["n"], v["usd"]) for k, v in a["bySession"].items() if v["n"]}, {"asia": (39, -7779.90), "london": (27, -5138.24), "ny": (33, -8240.96)})   # Asia was 40 / -7,767.62 with the excluded +$12.28 stop fill

    def test_2b_break_even_rule_on_the_two_days(self):
        # TradeDay 11/10: two trades changed (the 20:10 full stop and the 15:18 no-progress exit), no winner cut, +$340.50.
        # TradeDay 11/11: ONE winner cut (-$90.00): London 03:15 PT went +14.50, closed a minute at -2.00, then filled TP1.
        J = ld.load_journal(ld.Repo(REPO, REF))
        tr = ld.build_ledger(J)
        got = {}
        for t in tr:
            if t["tradeDay"] in ("2026-11-10", "2026-11-11"):
                w = li.what_if(t, li.state_rows(J, t["id"]), li.tp1_fill_ms(J, t["id"]))["beAfter10"]
                if w["fires"]:
                    got.setdefault(t["tradeDay"], []).append((t["id"][:8], t["exitReason"], w["savedUsd"]))
        self.assertEqual(sorted(got["2026-11-10"]), [("26e07b5b", "full-stop", 223.5), ("5fac7ea1", "no-progress-exit", 88.5)])
        self.assertEqual(got["2026-11-11"], [("a0db6e95", "tp1-all-out", -102.0)])

    def test_3_every_full_stop_of_the_window_is_in_the_file_and_only_those(self):
        win = [d["day"] for d in self.led["tradeDays"] if d["day"] <= "2026-11-11"][-20:]
        want = sorted(t["id"][:8] for t in self.led["trades"] if t["fullStop"] and t["net"] < 0 and t["tradeDay"] in win)
        self.assertEqual(sorted(s["id"] for s in self.a11["stops"]), want)
        self.assertEqual(len(want), 99)

    def test_4_a_stop_without_rows_has_no_path_and_null_what_ifs(self):
        bare = [s for s in self.a11["stops"] if not s["path"]]
        self.assertTrue(bare)
        for s in bare:
            self.assertEqual([s["whatIf"][k]["fires"] for k, _ in li.RULES], [None, None, None], s["id"])
        for s in self.a11["stops"]:
            if s["mfePts"] is None:
                self.assertEqual(s["class"], "noReading")

    def test_5_two_runs_differ_only_in_generated_at(self):
        a, b = (load(os.path.join(self.out[k], "state", "autopsy.json")) for k in ("d11", "d11b"))
        a.pop("generatedAt"), b.pop("generatedAt")
        self.assertEqual(li.encode(a), li.encode(b))
        self.assertLess(os.path.getsize(os.path.join(self.out["d11"], "state", "autopsy.json")), li.MAX_BYTES)

    def test_6_what_if_totals_add_up(self):
        for w in self.a11["whatIf"]:
            self.assertTrue(w["estimate"])
            self.assertEqual(w["stops"]["n"] + w["others"]["n"], 346)
            self.assertEqual(round(w["stops"]["savedUsd"] + w["others"]["usd"], 2), w["netUsd"])
            self.assertEqual(round(w["others"]["winnersUsd"] + w["others"]["losersUsd"], 2), w["others"]["usd"])
            k = w["k"]
            self.assertEqual(w["stops"]["fires"], sum(1 for s in self.a11["stops"] if s["whatIf"][k]["fires"] and s["whatIf"][k].get("savedUsd") is not None))
            self.assertEqual(w["stops"]["savedUsd"], round(sum(s["whatIf"][k]["savedUsd"] for s in self.a11["stops"] if s["whatIf"][k]["fires"]), 2))

    def test_6b_what_if_window_totals(self):
        w = {x["k"]: x for x in self.a11["whatIf"]}
        self.assertEqual((w["earlyExit"]["stops"]["fires"], w["earlyExit"]["stops"]["savedUsd"], w["earlyExit"]["others"]["changed"], w["earlyExit"]["others"]["usd"], w["earlyExit"]["netUsd"]), (5, 687.0, 4, -10.5, 676.5))
        b = w["beAfter10"]
        self.assertEqual((b["stops"]["fires"], b["stops"]["savedUsd"], b["others"]["winnersCut"], b["others"]["winnersUsd"], b["others"]["losersChanged"], b["others"]["losersUsd"], b["netUsd"]), (2, 442.5, 6, -767.0, 4, 175.5, -149.0))
        self.assertEqual((w["tp1OnTouch"]["stops"]["fires"], w["tp1OnTouch"]["netUsd"]), (1, 340.5))

    def test_x1_experiments_1111(self):
        e = {x["id"]: x for x in self.o11["experiments"]}
        x = e["X-02"]
        self.assertEqual((x["n"], x["value"], x["resolved"], x["unresolved"], x["judgeable"]), (2, 229.5, 1, 1, True))
        self.assertEqual(x["cases"], [
            {"id": "26579d37", "tUtc": "2026-11-11T09:09:18Z", "session": "london", "pts": -11.75, "usd": 229.5, "usdBroker": 195.0, "state": "would have hit the stop"},
            {"id": "4380cced", "tUtc": "2026-11-11T05:45:09Z", "session": "asia", "pts": -10.25, "state": "unresolved", "why": "another trade opened"}])   # the exit row's own time (05:45:09.9Z, cut to the second)
        self.assertEqual(x["killCheck"][0], {"clause": "share that would have reached TP1", "value": 0.0, "limit": 0.25, "n": 1, "unit": "share"})
        self.assertEqual((x["valueBroker"], x["valueBasis"]), (195.0, "estimate at the decision price, on the exits whose shadow resolved"))
        self.assertEqual((e["X-03"]["n"], e["X-03"]["value"], e["X-03"]["judgeable"], e["X-03"]["carried"], e["X-03"]["rate"]["etaTradeDays"]), (7, 86.34, False, 13, None))
        self.assertIn("cannot move", e["X-03"]["valueBasis"])
        self.assertEqual((e["X-04"]["judgeable"],), (False,))
        self.assertEqual((e["X-05"]["n"], e["X-05"]["judgeable"]), (None, False))
        self.assertEqual((e["X-10"]["n"], e["X-10"]["judgeable"]), (0, "partly"))

    def test_x2_expectation_and_kill_rule_are_copied_never_rewritten(self):
        src = {x["id"]: x for x in self.xsrc["experiments"]}
        for x in self.o11["experiments"]:
            self.assertEqual(x["killIf"], src[x["id"]]["killIf"])
            self.assertEqual(x["expectation"], src[x["id"]]["expectation"])
        after = load(os.path.join(self.out["d11"], "state", "experiments.json"))
        for x in after["experiments"]:
            self.assertEqual({k: v for k, v in x.items() if k != "running"}, {k: v for k, v in src[x["id"]].items() if k != "running"})
            self.assertNotIn("judgeable", x)

    def test_x3_time_to_verdict(self):
        e = {x["id"]: x["rate"] for x in self.o11["experiments"]}
        self.assertEqual((e["X-07"]["etaTradeDays"], e["X-07"]["perTradeDay"]), (6, 3.55))
        self.assertIn("71 NY trades", e["X-07"]["basis"])
        self.assertEqual(e["X-06"]["etaTradeDays"], 12)
        self.assertIn("35 same-side", e["X-06"]["basis"])
        self.assertEqual(e["X-10"]["etaTradeDays"], 50)
        self.assertIn("8 NY trades", e["X-10"]["basis"])
        self.assertTrue(all(r["estimate"] for r in e.values()))

    def test_x4_office_json_size(self):
        self.assertLess(os.path.getsize(os.path.join(self.out["d11"], "state", "office.json")), 60000)


if __name__ == "__main__":
    unittest.main()
