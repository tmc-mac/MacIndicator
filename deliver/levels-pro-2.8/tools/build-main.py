"""Build LevelsPRO-v2.8.pine from v2.7.4 + src/tide-engine.pine + src/tide-display.pine. Every edit is an exact, counted replacement.
usage: python3 -I build.py <v2.7.4.pine> <out.pine>"""
import sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.join(HERE, "..", "src")
s = open(sys.argv[1], encoding="utf-8").read()
def rep(a, b, n=1):
    global s
    c = s.count(a)
    if c != n: raise SystemExit(f"expected {n}, found {c}: {a[:100]!r}")
    s = s.replace(a, b)
def cut(a, b):
    """remove from the line starting with a (inclusive) to the line starting with b (exclusive); returns the removed text"""
    global s
    i = s.index(a); j = s.index(b, i)
    t = s[i:j]; s = s[:i] + s[j:]
    return t

# ---- header + title
rep("//@version=5\n// ===========================================================================\n",
    "//@version=5\n// ===========================================================================\n"
    "// DAILY LEVELS PRO v2.8  -  aligned with the TIDE bot (11/04, Mac: \"aligned with our current bot perspective of the market\"). TWO SCRIPTS\n"
    "//   (TradingView's 80k compiled-token limit): this one keeps every level line, tag, SWEPT, heat band, PWC = last trade, the vivid look and\n"
    "//   slim mode; the companion Levels PRO TIDE v2.8 draws the bot's TIDE view (zones and their states, 4H control, the 1H state, the plan,\n"
    "//   the blocks, the TIDE chip) and never draws a level line. Here: the old model (r13.x, manage-only since ruling 16) sits behind \"Old\n"
    "//   model\" (default OFF): the old CTRL / behaviour words on the tags, the old Ignition chip / board / glow / wake candles and the 24 old\n"
    "//   alerts. Section 15 (the old-model PARITY / EVENTS tables) is removed; its inputs stay so saved settings keep their places.\n"
    "//   Base: v2.7.4 (never installed; v2.7.3 is the last version sent). PARITY.md: the Pine text itself vs the bot's code on the replay tape.\n")
rep('indicator("Daily Levels PRO v2.7.3 - Scalp Engine", shorttitle="LVL 2.7.3"', 'indicator("Daily Levels PRO v2.8", shorttitle="LVL 2.8"')
rep('g_par = "PARITY (machine-readable)"', 'g_par = "PARITY (retired in v2.8: unused)"')

# ---- section 15 out; PWC (v2.7.3) and SWEPT (v2.7.1) stay, unchanged
s15 = cut("// ===========================================================================\n// 15. PARITY LAYER", "// ===========================================================================\n// 16. v2.5 LOOK")
for must in ("p_pwc_set = request.security", "pwc_lt := close[1]", "array.set(SW_ON, i, xd != 0 and xa < confirm_bars and array.get(FAILAGE, i) != xa + 1)"):
    assert must in s15, must
KEEP15 = '''// ===========================================================================
// 15. (v2.8) The PARITY / EVENTS layer is removed (old model only; TradingView's compiled-token budget). Two of its pieces
// stay, unchanged: PWC = the week's last trade (v2.7.3) and the SWEPT read (v2.7.1, MacDot 6572147917 #2).
// ===========================================================================
p_pwc_set = request.security("", "W", close[1], lookahead=barmerge.lookahead_on)   // CME settlement (TradingView's weekly close)
// v2.7.3 (Mac 11/03, option A): the bot's PWC is the week's LAST TRADE (the close of the last chart bar before the weekly roll),
// so the chart uses the same price. Falls back to the settlement above only until the chart's history reaches a weekly roll.
var float pwc_lt = na
if ta.change(time("W")) != 0 and bar_index > 0
    pwc_lt := close[1]
p_pwc = na(pwc_lt) ? p_pwc_set : pwc_lt
// v2.7.1 (MacDot 6572147917 #2): the SWEPT tag reads the engine's cross as of the last CLOSED bar (written only on a closed
// bar, so a forming bar's provisional cross or close back never sets or clears it) and the close time of the bar that crossed.
var bool[]   SW_ON   = array.new_bool(NL, false)
var int[]    SW_T    = array.new_int(NL, na)
for i = 0 to NL - 1
    float lpx = array.get(L_PX, i)
    if na(lpx)
        continue
    int  xa  = array.get(XAGE, i)
    int  xd  = array.get(XDIR, i)
    if barstate.isconfirmed
        array.set(SW_ON, i, xd != 0 and xa < confirm_bars and array.get(FAILAGE, i) != xa + 1)
        if xa == 0
            array.set(SW_T, i, time_close)


'''
i = s.index("// ===========================================================================\n// 16. v2.5 LOOK"); s = s[:i] + KEEP15 + s[i:]

# ---- section 14 alerts move to the end (they read the v2.8 inputs); the old ones fire only with "Old model" ON
alerts = cut("// ===========================================================================\n// 14. ALERTS", "// ===========================================================================\n// 15. (v2.8)")
old = [l for l in alerts.split("\n") if l.startswith("alertcondition(")]
assert len(old) == 24, len(old)
ALERTS = "\n\n// ===========================================================================\n// 14. ALERTS (v2.8: moved to the end; the old model's 24 fire only with \"Old model\" ON)\n// ===========================================================================\n"
import re
for l in old:
    m = re.match(r'^alertcondition\((.*?),\s+(".*)$', l); assert m, l
    ALERTS += "alertcondition(old_on and (" + m.group(1) + "), " + m.group(2) + "\n"
ALERTS += '''// TIDE (v2.8): the bot's engine events as the chart sees them (control, a setup armed, its first retest, the 1m trigger)
int td_cd = G.cDir
int td_na = 0
int td_nr = 0
for x in SU
    td_na += x.stat == 0 and x.rno == 0 ? 1 : 0
    td_nr += x.stat == 0 and x.rno > 0 ? 1 : 0
int td_sg = nz(G.sigT)
alertcondition(td_ok and td_cd != 0 and td_cd != td_cd[1], "TIDE CONTROL", "Levels PRO TIDE: 4H control formed / changed (trap or bias)")
alertcondition(td_ok and td_na > td_na[1], "TIDE SETUP ARMED", "Levels PRO TIDE: a setup armed (failed break + shift, or accepted break)")
alertcondition(td_ok and td_nr > td_nr[1], "TIDE RETEST", "Levels PRO TIDE: first retest of an armed setup; the 1m rejection close is the trigger")
alertcondition(td_ok and td_sg != td_sg[1], "TIDE TRIGGER", "Levels PRO TIDE: a 1m rejection passed the chart-visible gates (the bot decides: grade, news, broker)")
'''

# ---- the v2.8 input, after the last v2.7.4 input (ui_wake): input order is input identity
INPUTS = '''// v2.8 input: declared after every earlier input (input order is input identity: saved settings keep their places).
g_tide   = "Old model (v2.8)"
old_on   = input.bool(false, "Old model (r13.x, manage-only)", group=g_tide, tooltip="OFF (v2.8 default): the bot trades TIDE only (ruling 16), so the old levels-path reads are hidden: the per-level CTRL / behaviour words on the tags, the old Ignition chip / board / glow / wake candles, the 24 old alerts. The TIDE view is the companion script Levels PRO TIDE v2.8. ON: v2.7.4 exactly.")
'''
anchor = s.index("ui_wake = input.bool(true, \"Wake candles\"")
eol = s.index("\n", anchor) + 1
s = s[:eol] + INPUTS + s[eol:]
rep("barcolor(ui_wake and ig_rank == 0 ? color.new(chart.fg_color, 72) : na)", "barcolor(old_on and ui_wake and ig_rank == 0 ? color.new(chart.fg_color, 72) : na)   // v2.8: the old gate mirror, Old model only")
rep("    bool  w_on = st == 3 and ig_k >= 0\n", "    bool  w_on = old_on and st == 3 and ig_k >= 0   // v2.8: Old model only\n")
rep("""                label.set_text(w_lb, (w_sw == "" and str.length(w_t1) <= ui_tag_room and w_bh != 0 ? w_t1 : f_cut(w_t0, ui_tag_room) + w_sw) + w_pz + (w_q == w_gk and st > 0 ? " " + (ig_15 ? "" : v_tfc) + f_ig_m(st == 3 ? 4 : math.min(ig_n, 3)) : ""))
                label.set_tooltip(w_lb, array.get(w_gt, w_q) + "  " + w_st)""",
"""                // v2.8: the old behaviour word and the old meter only with "Old model"; SWEPT stays (Mac 11/02)
                label.set_text(w_lb, (old_on and w_sw == "" and str.length(w_t1) <= ui_tag_room and w_bh != 0 ? w_t1 : f_cut(w_t0, ui_tag_room) + w_sw) + w_pz + (old_on and w_q == w_gk and st > 0 ? " " + (ig_15 ? "" : v_tfc) + f_ig_m(st == 3 ? 4 : math.min(ig_n, 3)) : ""))
                label.set_tooltip(w_lb, array.get(w_gt, w_q) + (old_on or w_sw != "" ? "  " + w_st : ""))""")
rep("""            else
                label.set_xy(w_lb, bar_index + (full ? lbl_offset : 1), w_y)
""", """            else
                label.set_xy(w_lb, bar_index + (full ? lbl_offset : 1), w_y)
                // v2.8 Full detail: without "Old model" a level label is its name (+ price), not the old CTRL / behaviour words
                if full and w_a < NL and not old_on
                    int w_ak = math.min(w_a, NL - 1)
                    label.set_text(w_lb, (mobile and mob_compact ? f_mobile_name(w_ak) : array.get(L_NAME, w_ak) + array.get(L_MRG, w_ak)) + ((lbl_price or (mobile and mob_compact)) ? "  " + str.tostring(array.get(L_PX, w_ak), format.mintick) : "") + (array.get(TESTED, w_ak) ? "" : "  *"))
""")
rep("""    if show_dash and ui_board != "Off"
        f_ui_board(st)
    0""", """    if show_dash and ui_board != "Off" and old_on   // v2.8: the old gate-mirror board, Old model only (the TIDE board is the companion's)
        f_ui_board(st)
    0""")
s = s.rstrip("\n") + ALERTS[:ALERTS.index("// TIDE (v2.8)")]
open(sys.argv[2], "w", encoding="utf-8").write(s)
print("built", sys.argv[2], len(s.split("\n")), "lines")
