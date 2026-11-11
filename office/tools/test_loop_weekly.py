"""Unit tests for office/tools/loop_weekly.py. From the repository root:
    python3 -I -m unittest discover -s office/tools -p 'test_*.py'"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loop_daily as ld  # noqa: E402
import loop_weekly as lw  # noqa: E402


def tr(day, net, full_stop=False, session="asia", leak=None):
    return {"tradeDay": day, "net": net, "fullStop": full_stop, "session": session, "fees": 3.66, "leak": leak, "leakWhy": None, "exitReason": "x"}


class WeekBoundaries(unittest.TestCase):
    def test_week_is_the_iso_week_of_the_tradeday(self):
        sunday_evening = ld._utc_ms(2026, 11, 8, 23, 30)            # Sunday 15:30 PT
        self.assertEqual(ld.trade_day(sunday_evening), "2026-11-09")
        self.assertEqual(lw.week_of(ld.trade_day(sunday_evening)), "2026-W46")     # belongs to Monday's week
        friday_morning = ld._utc_ms(2026, 11, 6, 20, 0)             # Friday 12:00 PT
        self.assertEqual(lw.week_of(ld.trade_day(friday_morning)), "2026-W45")
        self.assertEqual(lw.week_range("2026-W46"), ("2026-11-09", "2026-11-13"))
        self.assertEqual(lw.prev_week("2026-W46"), "2026-W45")
        self.assertEqual(lw.prev_week("2027-W01"), "2026-W53")       # 2026 has 53 ISO weeks
        self.assertEqual(lw.week_of("2026-12-31"), "2026-W53")
        self.assertEqual(lw.week_of("2027-01-01"), "2026-W53")       # the ISO year, not the calendar year


class Streaks(unittest.TestCase):
    def test_streak_and_most_in_a_day(self):
        by = {"d1": [tr("d1", -1, True), tr("d1", 5), tr("d1", -1, True), tr("d1", -1, True)],
              "d2": [tr("d2", -1, True), tr("d2", 1), tr("d2", -1, True), tr("d2", 1), tr("d2", -1, True), tr("d2", 1), tr("d2", -1, True)],
              "d3": [tr("d3", 9)]}
        s = lw.stop_streak(by)
        self.assertEqual((s["streak"], s["streakDay"]), (2, "d1"))
        self.assertEqual((s["mostInDay"], s["mostDay"]), (4, "d2"))

    def test_a_streak_does_not_run_across_days(self):
        s = lw.stop_streak({"d1": [tr("d1", 1), tr("d1", -1, True)], "d2": [tr("d2", -1, True), tr("d2", 1)]})
        self.assertEqual(s["streak"], 1)
        self.assertEqual(lw.stop_streak({"d1": [tr("d1", 1)]}), {"streak": 0, "streakDay": None, "mostInDay": 0, "mostDay": None})

    def test_week_stats(self):
        t = [tr("d1", 100), tr("d1", -250, True), tr("d2", 80, session="ny"), tr("d2", 60, session="ny")]
        s = lw.week_stats(t, ["d1", "d2", "d3"])                     # d3: the bot ran and took no trade
        self.assertEqual((s["net"], s["days"], s["netPerDay"]), (-10.0, 3, -3.33))
        self.assertEqual(s["stopsPer10"], 2.5)
        self.assertEqual(s["bestDay"], {"day": "d2", "net": 140.0})
        self.assertEqual(s["worstDay"], {"day": "d1", "net": -150.0})
        self.assertEqual(s["lossToWin"], 3.12)                       # 250 / 80
        self.assertEqual((s["bySession"]["ny"]["net"], s["bySession"]["london"]["trades"]), (140.0, 0))


class Readiness(unittest.TestCase):
    CUR = {"status": "open", "target": 3000.0, "profit": 354.5}

    def test_arithmetic(self):
        r = lw.readiness(self.CUR, [100.0, 300.0, 200.0])
        self.assertEqual((r["need"], r["avgPerDay"], r["n"], r["days"]), (2645.5, 200.0, 3, 14))    # 2,645.50 / 200 = 13.2 -> 14 days
        self.assertIn("needs $2,645.50 in 14 more days at the last 3 days' average of +$200.00 per day (n=3 days, small)", lw.readiness_line(r))
        self.assertEqual(lw.readiness(dict(self.CUR, profit=2800.0), [200.0])["days"], 1)           # exactly one day

    def test_no_forecast_when_the_average_is_not_positive(self):
        r = lw.readiness(self.CUR, [-100.0, 50.0])
        self.assertIsNone(r["days"])
        self.assertIn("does not get there", lw.readiness_line(r))
        self.assertIsNone(lw.readiness(self.CUR, [])["avgPerDay"])
        self.assertIn("no complete TradeDay", lw.readiness_line(lw.readiness(self.CUR, [])))

    def test_consistency_target_and_closed_chains(self):
        r = lw.readiness({"status": "open", "target": 3636.36, "profit": 3000.0}, [100.0] * 20)
        self.assertEqual((r["need"], r["days"]), (636.36, 7))
        self.assertNotIn("small", lw.readiness_line(r))              # 20 days is not a small sample
        self.assertIsNone(lw.readiness({"status": "breached", "target": 3000.0, "profit": -2100.0}, [1.0])["need"])


class HandEditedDecisions(unittest.TestCase):
    def test_generated_block_is_replaced_and_hand_edit_is_kept(self):
        b1, kept = lw.merge_decisions("Nothing to decide this week.", "")
        self.assertFalse(kept)
        card = "# card\n\n## Decisions for Mac\n\n%s\n\ntail\n" % b1
        # untouched block: a new run may replace it
        b2, kept = lw.merge_decisions("1. **X-02** has its 20 cases.", card)
        self.assertFalse(kept)
        self.assertIn("X-02", b2)
        # the same text again gives the same bytes (idempotent)
        self.assertEqual(lw.merge_decisions("Nothing to decide this week.", card)[0], b1)
        # edited by hand: the text between the markers changed, the hash in the marker did not
        edited = card.replace("Nothing to decide this week.", "1. Mac: start the practice combine count on 11/16.")
        b3, kept = lw.merge_decisions("1. **X-02** has its 20 cases.", edited)
        self.assertTrue(kept)
        self.assertIn("start the practice combine count on 11/16", b3)
        self.assertNotIn("X-02", b3)
        # and it stays kept on every later run, because the block is written back unchanged
        again = edited.replace(lw.RE_BLOCK.search(edited).group(0), b3)
        self.assertEqual(lw.merge_decisions("anything", again), (b3, True))

    def test_whitespace_only_changes_are_not_a_hand_edit(self):
        b1, _ = lw.merge_decisions("Nothing to decide this week.", "")
        self.assertFalse(lw.merge_decisions("new", b1.replace("week.\n", "week.  \n"))[1])


class QuietDecisions(unittest.TestCase):
    LW = [("L-01", {"n": 15, "usd": -2850.9}), ("L-12", {"n": 12, "usd": -712.92}), ("L-07", {"n": 3, "usd": -483.48}), ("unclassified: manual-flatten", {"n": 1, "usd": -600.0})]
    ST = {"L-01": "live", "L-12": "measured", "L-07": "measured"}
    X = [{"id": "X-02", "title": "Early exit", "minN": 20, "value": 410.0, "state": "verdict", "line": "VERDICT: ready."},
         {"id": "X-01", "title": "TP1", "minN": 20, "value": None, "state": "recording", "line": "recording, 3 of 20"}]

    def test_live_leak_is_quiet_and_measured_leak_over_the_line_is_raised(self):
        dec, quiet = lw.decision_items(self.X, self.LW, self.ST, partial=False)
        self.assertEqual(quiet, ["L-01"])                                    # live rule: leaks table only
        self.assertEqual(len(dec), 3)
        self.assertTrue(dec[0].startswith("**X-02"))                         # experiments at a verdict come first
        self.assertTrue(dec[1].startswith("**L-12** (measured)"))
        self.assertTrue(dec[2].startswith("**unclassified: manual-flatten** (observed)"))   # no register row = observed
        self.assertFalse(any("L-07" in d for d in dec))                      # under the $500 line

    def test_partial_week_raises_nothing(self):
        self.assertEqual(lw.decision_items(self.X, self.LW, self.ST, partial=True), ([], []))


class WeeklyBlocks(unittest.TestCase):
    def test_pass_probability_block_shape_and_refusal(self):
        r = ld.pass_probability([(100.0, -10.0)] * 3, {"profit": 0.0, "floor": -2000.0, "bestDay": 0.0, "status": "open"}, 14)
        self.assertEqual((r["p"], r["n"], r["resamples"]), (None, 3, 5000))
        self.assertEqual(ld.RULES_SINCE_DAY, "2026-11-12")

    def test_trade_days_left_feeds_the_bootstrap(self):
        self.assertEqual(ld.trade_days_left("2026-11-10", True, "2026-11-30"), 14)


class LeakRank(unittest.TestCase):
    def test_rank_and_session_split(self):
        t = [tr("d", -100, leak="L-12"), tr("d", -50, leak="L-12", session="ny"), tr("d", -300, True, leak="L-01"), tr("d", 80), tr("d", -20)]
        r = lw.leak_rank(t)
        self.assertEqual([(k, v["n"], v["usd"]) for k, v in r], [("L-01", 1, -300.0), ("L-12", 2, -150.0), ("unclassified: x", 1, -20.0)])
        self.assertEqual(r[1][1]["bySession"]["ny"], {"n": 1, "usd": -50.0})


if __name__ == "__main__":
    unittest.main()
