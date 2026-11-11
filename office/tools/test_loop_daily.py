"""Unit tests for office/tools/loop_daily.py. From the repository root:
    python3 -I -m unittest discover -s office/tools -p 'test_*.py'
(-I keeps the current directory off the import path, so `discover -s` is what finds the module.)"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loop_daily as ld  # noqa: E402


def day(name, *trades, complete=True):
    """trades: net, or (net, worstOpen)."""
    out = []
    for t in trades:
        net, wo = t if isinstance(t, tuple) else (t, min(0.0, float(t)))
        out.append({"net": float(net), "worstOpen": wo})
    return {"day": name, "trades": out, "complete": complete}


class VirtualCombine(unittest.TestCase):
    def test_a_clean_pass(self):
        # five days, +600 a day: total 3,000, best day 600 = 20% of profit
        r = ld.simulate_combine([day("d%d" % i, 400, -100, 300) for i in range(1, 7)])
        self.assertEqual(r["status"], "passed")
        self.assertEqual(r["endDay"], "d5")
        self.assertEqual(r["days"], 5)
        self.assertEqual(r["profit"], 3000.0)
        self.assertEqual(r["bestDay"], 600.0)
        self.assertEqual(r["bestDayPct"], 20.0)
        self.assertEqual(r["target"], 3000.0)
        self.assertTrue(r["floorLocked"])            # end-of-day +2,400 on day 4 locked the floor at the start balance
        self.assertIsNone(r["breach"])

    def test_b_intraday_breach_by_open_pnl(self):
        # day 1 ends -1,500 (floor stays -2,000). Day 2: a trade is 520 under water while open (equity -2,020),
        # then closes +100. Closed P&L never touches the floor; open P&L does.
        r = ld.simulate_combine([day("d1", -1500), day("d2", (100, -520.0)), day("d3", 500)])
        self.assertEqual(r["status"], "breached")
        self.assertEqual(r["breach"], {"day": "d2", "trade": 0, "how": "open", "equity": -2020.0, "floor": -2000.0})
        self.assertEqual(r["endDay"], "d2")
        self.assertEqual(r["floorRoom"], 0.0)
        # the same days on closed P&L only (no excursion data) stay open, and the run says how many trades lacked it
        r2 = ld.simulate_combine([day("d1", (-1500, None)), day("d2", (100, None)), day("d3", (500, None))])
        self.assertEqual(r2["status"], "open")
        self.assertEqual(r2["tradesNoExcursion"], 3)

    def test_b2_breach_on_closed_pnl_and_exact_floor(self):
        r = ld.simulate_combine([day("d1", (-2000, -1990.0))])
        self.assertEqual(r["status"], "breached")
        self.assertEqual(r["breach"]["how"], "closed")
        r = ld.simulate_combine([day("d1", (-1999.99, -1999.99))])
        self.assertEqual(r["status"], "open")

    def test_c_floor_trails_end_of_day_then_locks(self):
        days = [day("d1", 1000), day("d2", -300), day("d3", 1400), day("d4", -2050), day("d5", -60)]
        f = [ld.simulate_combine(days[:n]) for n in (1, 2, 3, 4, 5)]
        self.assertEqual(f[0]["floor"], -1000.0)     # EOD +1,000 -> floor -1,000
        self.assertEqual(f[1]["floor"], -1000.0)     # EOD +700: the floor never moves down
        self.assertEqual(f[1]["floorRoom"], 1700.0)
        self.assertEqual(f[2]["floor"], 0.0)         # EOD +2,100 -> locked at the start balance
        self.assertTrue(f[2]["floorLocked"])
        self.assertEqual(f[3]["status"], "open")     # +2,100 - 2,050 = +50: still above the locked floor
        self.assertEqual(f[3]["floorRoom"], 50.0)
        self.assertEqual(f[4]["status"], "breached") # +50 - 60 = -10: under the start balance
        self.assertEqual(f[4]["breach"]["floor"], 0.0)

    def test_c2_trail_uses_end_of_day_not_intraday_high(self):
        # intraday the balance is +1,500, the day ends +200: the floor follows the END-OF-DAY balance only
        r = ld.simulate_combine([day("d1", 1500, -1300)])
        self.assertEqual(r["floor"], -1800.0)
        # after the lock, a loss back to the start balance breaches
        r = ld.simulate_combine([day("d1", 2100), day("d2", -2100)])
        self.assertEqual(r["status"], "breached")
        self.assertEqual(r["breach"]["floor"], 0.0)
        # a later, higher end of day does not lift a locked floor above the start balance
        r = ld.simulate_combine([day("d1", 2100), day("d2", 500)])
        self.assertEqual(r["floor"], 0.0)

    def test_d_consistency_raises_the_target(self):
        # day 1 +2,000, day 2 +1,000: profit 3,000 but the best day is 67% of it -> target 2,000 / 0.55 = 3,636.36
        days = [day("d1", 2000), day("d2", 1000)]
        r = ld.simulate_combine(days)
        self.assertEqual(r["status"], "open")
        self.assertEqual(r["target"], 3636.36)
        self.assertEqual(r["bestDayPct"], 66.7)
        r = ld.simulate_combine(days + [day("d3", 600)])        # 3,600: still short
        self.assertEqual(r["status"], "open")
        r = ld.simulate_combine(days + [day("d3", 600), day("d4", 40)])   # 3,640 >= 3,636.36
        self.assertEqual(r["status"], "passed")
        self.assertLess(r["bestDay"] / r["profit"], 0.55)
        # one huge day can never pass alone
        self.assertEqual(ld.simulate_combine([day("d1", 5000)])["status"], "open")

    def test_incomplete_day_gets_no_end_of_day_step(self):
        r = ld.simulate_combine([day("d1", 500), day("d2", 2600, complete=False)])
        self.assertEqual(r["status"], "open")        # 3,100 on the books but the day is not over
        self.assertEqual(r["floor"], -1500.0)        # only d1's end of day moved the floor
        self.assertEqual(r["provisionalDay"], "d2")
        r = ld.simulate_combine([day("d1", 500), day("d2", (-100, -2600.0), complete=False)])
        self.assertEqual(r["status"], "breached")    # a breach inside an unfinished day still counts

    def test_need_per_day_is_plain_arithmetic(self):
        cur = {"status": "open", "target": 3000.0, "profit": 600.0}
        # Tuesday 11/10 complete: 11/11 .. 11/30 has 14 weekdays
        self.assertEqual(ld.trade_days_left("2026-11-10", True, "2026-11-30"), 14)
        self.assertEqual(ld.trade_days_left("2026-11-10", False, "2026-11-30"), 15)      # an unfinished day still counts
        self.assertEqual(ld.need_per_day(cur, "2026-11-10", True, "2026-11-30")["perDay"], round(2400 / 14, 2))
        self.assertIsNone(ld.need_per_day(cur, "2026-11-30", True, "2026-11-30")["perDay"])   # no day left: unknown, not a guess
        self.assertIsNone(ld.need_per_day(dict(cur, status="breached"), "2026-11-10", True, "2026-11-30")["perDay"])

    def test_chain_and_history(self):
        days = [day("d1", -2100), day("d2", 100), day("d3", -2500), day("d4", 50)]
        ch = ld.combine_chain(days, "d1")
        self.assertEqual([(c["startDay"], c["status"]) for c in ch], [("d1", "breached"), ("d2", "breached"), ("d4", "open")])
        h, runs = ld.combine_history(days, n=3)
        self.assertEqual((h["started"], h["breached"], h["open"]), (3, 2, 1))


class TimeAndSession(unittest.TestCase):
    def test_pt_and_tradeday(self):
        ms = ld._utc_ms(2026, 11, 10, 23, 0)                 # 15:00 PST on 11/10
        self.assertEqual(ld.trade_day(ms), "2026-11-11")
        self.assertEqual(ld.trade_day(ms - 1), "2026-11-10")
        self.assertEqual(ld.pt_offset_h(ld._utc_ms(2026, 10, 30, 12)), -7)   # still daylight time
        self.assertEqual(ld.pt_offset_h(ld._utc_ms(2026, 11, 1, 9)), -8)     # first Sunday of November, 09:00 UTC
        self.assertEqual(ld.pt_offset_h(ld._utc_ms(2026, 3, 8, 10)), -7)     # second Sunday of March, 10:00 UTC
        self.assertEqual(ld.pt_wall_ms("2026-11-10", 13, 10), ld._utc_ms(2026, 11, 10, 21, 10))
        self.assertEqual(ld.pt_wall_ms("2026-10-30", 15, 0), ld._utc_ms(2026, 10, 30, 22, 0))
        self.assertEqual(ld.trade_day(ld._utc_ms(2026, 11, 8, 23, 30)), "2026-11-09")   # Sunday 15:30 PT -> Monday

    def test_sessions_are_the_bots(self):
        at = lambda h, m: ld.pt_wall_ms("2026-11-10", h, m)
        self.assertEqual([ld.session_of(at(*x)) for x in [(0, 0), (6, 29), (6, 30), (12, 59), (13, 0), (14, 59), (15, 0), (23, 59)]],
                         ["london", "london", "ny", "ny", "late", "late", "asia", "asia"])


class BlockedWalk(unittest.TestCase):
    S = [(i * 60000, 100.0 + x) for i, x in enumerate([0, 2, 5, -3, 9, 16, -60])]

    def test_won_lost_neither_unknown(self):
        self.assertEqual(ld.walk_block(0, 1, self.S)[0], "won")                       # +16 at minute 5, before -60
        self.assertEqual(ld.walk_block(0, -1, self.S)[0], "won")                      # short: +16 against is inside the 50-pt stop, then -60
        self.assertEqual(ld.walk_block(0, 1, self.S[:5])[0], "unknown")               # undecided and the samples end after 4 minutes
        self.assertEqual(ld.walk_block(0, -1, self.S, stop_pts=10)[0], "lost")        # short with a 10-pt stop: +16 against
        flat = [(i * 60000, 100.0) for i in range(0, 70)]
        self.assertEqual(ld.walk_block(0, 1, flat)[0], "neither")
        gap = [(0, 100.0), (60000, 101.0), (400000, 130.0)]
        self.assertEqual(ld.walk_block(0, 1, gap)[0], "unknown")                      # a 340 s hole hides the path
        self.assertEqual(ld.walk_block(10 ** 9, 1, self.S)[0], "unknown")             # no sample near the block
        self.assertEqual(ld.walk_block(0, 0, self.S)[0], "unknown")                   # no direction
        self.assertEqual(ld.walk_block(0, 1, self.S, entry=90.0)[0], "won")           # the row's own entry price is the reference

    def test_default_stop_is_50(self):
        s = [(0, 100.0), (60000, 55.0), (120000, 120.0)]
        r, _, used = ld.walk_block(0, 1, s)
        self.assertEqual(used["stopPts"], 50.0)
        self.assertEqual(r, "won")                    # -45 is inside the 50-pt default stop
        self.assertEqual(ld.walk_block(0, 1, s, stop_pts=40)[0], "lost")


class Autopsy(unittest.TestCase):
    def t(self, i, net, exit_reason, t0, t1, d=1):
        return {"id": str(i), "net": net, "exitReason": exit_reason, "fullStop": exit_reason in ld.FULL_STOP_EXITS, "_tEntry": t0, "_tExit": t1, "_dir": d, "tradeDay": "x"}

    def test_classes(self):
        m = 60000
        tr = [self.t(1, -250, "full-stop", 0, 5 * m), self.t(2, -260, "full-stop", 20 * m, 25 * m), self.t(3, -40, "no-progress-exit", 200 * m, 210 * m),
              self.t(4, -70, "early-adverse-exit", 300 * m, 303 * m), self.t(5, 80, "tp1-all-out", 400 * m, 401 * m), self.t(6, -250, "full-stop", 10 * m, 12 * m, d=-1)]
        got = {x["trade"]["id"]: x["leak"] for x in ld.autopsy(sorted(tr, key=lambda t: t["_tEntry"]))}
        self.assertEqual(got, {"1": "L-01", "6": "L-01", "2": "L-07", "3": "L-12", "4": "L-01"})


if __name__ == "__main__":
    unittest.main()
