"""pstate: mocked engine state for one last bar of Daily Levels PRO (shared by the v2.7 witnesses), and the runner that
executes the display sections (2 colours, 11 drawing, 13 board, 16 look) of a Pine file through pinei.
Everything the display code reads from the engine (sections 1, 3-10, 15) is given here: inputs, the registry arrays, the
per-level engine state, the in-play read, the period opens, the 16H request results, bar / time built-ins and history."""
import importlib.util, math, os, random, re
from datetime import datetime, timezone

H = os.path.dirname(os.path.abspath(__file__))
_sp = importlib.util.spec_from_file_location("pinei", os.path.join(H, "pinei.py"))
pinei = importlib.util.module_from_spec(_sp)
_sp.loader.exec_module(pinei)

NL, HN = 27, 15
TF = {  # name: (timeframe.period, multiplier, kind, seconds)
    "45s": ("45S", 45, "s", 45), "1m": ("1", 1, "m", 60), "3m": ("3", 3, "m", 180), "5m": ("5", 5, "m", 300), "15m": ("15", 15, "m", 900),
    "30m": ("30", 30, "m", 1800), "1H": ("60", 60, "m", 3600), "4H": ("240", 240, "m", 14400), "100m": ("100", 100, "m", 6000),
    "1439m": ("1439", 1439, "m", 86340), "D": ("D", 1, "D", 86400), "W": ("W", 1, "W", 604800), "12M": ("12M", 12, "M", 31536000),
}


def registry(src):
    names = re.findall(r'^    array\.push\(L_NAME, "([^"]*)"\)$', src, re.M)
    abbr = re.findall(r'^    array\.push\(L_ABBR, "([^"]*)"\)$', src, re.M)
    imp = [float(x) for x in re.findall(r'^    array\.push\(L_IMP, ([0-9.]+)\)', src, re.M)]
    assert len(names) == len(abbr) == len(imp) == NL
    tier = [1] * NL
    for k in (0, 1, 2, 3, 12):
        tier[k] = 2
    for k in range(17, 27):
        tier[k] = 3
    roll = [k >= 13 for k in range(NL)]
    return names, abbr, imp, tier, roll


def month_start_ms(y, m):
    return int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp() * 1000) - 2 * 3600000   # the CME M bar opens the evening before (UTC-ish)


def make_state(rng, src, tfname=None, overrides=None):
    """one random but plausible last bar"""
    names, abbr, imp, tier, roll = registry(src)
    o = overrides or {}
    tfname = tfname or rng.choice(list(TF))
    per, mult, kind, secs = TF[tfname]
    close = round(28500 + rng.uniform(-400, 400), 2)
    close = round(close * 4) / 4
    atr_ref = rng.choice([60.0, 95.5, 132.24, 155.06, 210.0])
    band = atr_ref * 0.25
    distant = rng.choice([1.5, 1.5, 1.0, 2.5])
    R = atr_ref * distant
    px = []
    for k in range(NL):
        r = rng.random()
        if r < 0.12:
            px.append(None)
        elif r < 0.22 and px and any(p is not None for p in px):
            px.append(rng.choice([p for p in px if p is not None]) + rng.choice([0.0, 0.25, 0.5, 0.75]))
        else:
            px.append(round((close + rng.gauss(0, R * 0.9)) * 4) / 4 if k != 12 else close + rng.gauss(0, R * 0.5))
    on = [rng.random() < (0.85 if k < 20 else 0.3) for k in range(NL)]
    mrg = ["" if rng.random() < 0.85 else " +" + rng.choice(abbr) for _ in range(NL)]
    beh = [rng.randint(0, 16) for _ in range(NL)]
    ctl = [rng.choice([8, 9, 2, -2, 3, -3, 1, -1, 0]) for _ in range(NL)]
    xdir = [rng.choice([-1, 0, 1]) for _ in range(NL)]
    xage = [rng.choice([0, 1, 2, 3, 4, 7, 9999]) for _ in range(NL)]
    fage = [rng.choice([1, 2, 3, 5, 9999, xa + 1]) for xa in xage]
    ip_i = rng.choice([-1] + list(range(NL)))
    engaged = ip_i >= 0 and rng.random() < 0.7
    t_bar = 1793345400000 + rng.randint(0, 2000) * secs * 1000 // max(1, secs // 60) if kind in "sm" else 1793345400000
    t_bar = (t_bar // (secs * 1000)) * secs * 1000 if kind in "sm" else t_bar
    realtime = rng.random() < 0.5
    confirmed = (not realtime) or rng.random() < 0.15
    timenow = t_bar + (rng.randint(0, secs * 1000 - 1) if realtime else rng.randint(secs * 1000, secs * 1000 + 3 * 86400000))
    # 16H: months / weeks
    y, mth = 2026, rng.choice([1, 2, 4, 5, 7, 8, 10, 11, 12])
    m_start = month_start_ms(y, mth)
    tm = lambda back: month_start_ms(y + (mth - 1 - back) // 12, (mth - 1 - back) % 12 + 1)
    gap = rng.random() < 0.1
    ts = [tm(k + (1 if gap and k >= 3 else 0)) for k in range(1, 6)]
    if rng.random() < 0.05:
        ts[4] = None
    hv = lambda: round(close + rng.uniform(-1500, 1500), 2)
    req = {n: hv() if rng.random() < 0.9 else None for n in
           ["h_cmh", "h_cml", "h_qh", "h_ql", "h_wh", "h_wl", "h_o2", "h_h2", "h_h3", "h_h4", "h_h5", "h_l2", "h_l3", "h_l4", "h_l5"]}
    # make a few 16H values land near price (so they are drawn and merge / stack)
    for n in ("h_wh", "h_wl", "h_cmh", "h_h3"):
        if rng.random() < 0.4:
            req[n] = round((close + rng.uniform(-R, R)) * 4) / 4
    t_now_bar = t_bar
    bot_m = lambda t: (datetime.fromtimestamp((t + 10800000) / 1000, tz=timezone.utc).year * 12 + datetime.fromtimestamp((t + 10800000) / 1000, tz=timezone.utc).month - 1)
    req.update({"h_dm": bot_m(t_now_bar) if rng.random() < 0.85 else bot_m(t_now_bar) - 1,
                "h_dw": 1793000000000 if rng.random() < 0.8 else 1792000000000,
                "h_t1": ts[0], "h_t2": ts[1], "h_t3": ts[2], "h_t4": ts[3], "h_t5": ts[4]})
    ltf = {}
    for tfk in ("15", "30", "60", per):
        n = rng.randint(0, 4)
        ltf[(tfk, "open")] = [close + rng.uniform(-30, 30) for _ in range(n)]
        ltf[(tfk, "time")] = [t_bar + i * 60000 for i in range(n)] if rng.random() < 0.9 else []
    inputs = {
        "ui_detail": rng.random() < 0.3, "ui_board": rng.choice(["Standard", "Standard", "Chip only", "Off"]),
        "ui_pos": rng.choice(["Middle Left", "Top Left", "Top Center", "Top Right", "Middle Right", "Bottom Right"]),
        "ui_theme": rng.choice(["Auto", "Dark", "Light"]), "ui_chart_px": rng.choice([300, 480, 900]), "ui_vis_bars": rng.choice([40, 70, 150]),
        "ui_tag_room": rng.choice([3, 6, 6, 12, 24]), "ui_tp1": 15.0, "ui_hw": rng.random() < 0.8, "ui_hm": rng.random() < 0.8, "ui_wake": rng.random() < 0.8,
    }
    G = {
        "NL": NL, "L_NAME": pinei.Arr(names), "L_ABBR": pinei.Arr(abbr), "L_IMP": pinei.Arr(imp), "L_TIER": pinei.Arr(tier), "L_ROLL": pinei.Arr(roll),
        "L_PX": pinei.Arr(px), "L_ON": pinei.Arr(on), "L_MRG": pinei.Arr(mrg), "BEH": pinei.Arr(beh), "CTL_ST": pinei.Arr(ctl),
        "STATE": pinei.Arr([rng.randint(0, 7) for _ in range(NL)]), "TESTED": pinei.Arr([rng.random() < 0.6 for _ in range(NL)]),
        "XDIR": pinei.Arr(xdir), "XAGE": pinei.Arr(xage), "FAILAGE": pinei.Arr(fage),
        "TZ": "America/Los_Angeles", "newDay": rng.random() < 0.05, "tf_min": max(secs / 60.0, 0.1), "atr_ref": atr_ref, "band": band,
        "engaged": engaged, "ip_i": ip_i, "ip_px": px[ip_i] if ip_i >= 0 else None, "beh_chop": rng.random() < 0.15,
        "setup": rng.choice([0, 0, 1, -1]), "ip_ctl": rng.choice([0, 1, -1, 2, -2]),
        "bias_score": rng.choice([0.0, 0.22, -0.22, 0.2199, -0.31, round(rng.uniform(-0.6, 0.6), 4)]),
        "h15_open": close + rng.uniform(-20, 20), "h30_open": close + rng.uniform(-30, 30), "h1_open": close + rng.uniform(-40, 40),
        "h4_open": close + rng.uniform(-80, 80), "mo_v": hv(), "pmo_v": hv(), "pmoh_v": hv() + 800, "pmol_v": hv() - 800, "pwo_v": hv(), "p_pwc": hv(),
        "m_start_t": m_start if rng.random() < 0.97 else None,
        "s15": rng.choice([None, -1, 0, 1]), "s30": rng.choice([None, -1, 0, 1]), "s60": rng.choice([None, -1, 0, 1]), "s240": rng.choice([None, -1, 0, 1]),
        "align_known": rng.random() < 0.7, "drive_known": rng.random() < 0.7, "st_bias": rng.uniform(-0.5, 0.5), "flow_st": rng.uniform(-0.3, 0.3),
        # section 1 inputs the display reads
        "distant_atr": distant, "confirm_bars": rng.choice([3, 3, 1, 5]), "extend_r": rng.choice([30, 10]), "lookback_l": rng.choice([150, 0]),
        "color_lines": rng.random() < 0.85, "dash_untest": rng.random() < 0.8, "lbl_state": rng.random() < 0.8, "lbl_price": rng.random() < 0.8,
        "lbl_offset": rng.choice([6, 2]), "lbl_size": rng.choice(["small", "small", "tiny", "normal", "large"]), "lbl_solid": rng.random() < 0.8,
        "show_halo": rng.random() < 0.8, "show_dash": rng.random() < 0.9, "mobile": rng.random() < 0.2, "mob_compact": rng.random() < 0.8,
        "show_15o": rng.random() < 0.3,
    }
    B = {
        "close": close, "open": close + rng.uniform(-10, 10), "high": close + rng.uniform(0, 25), "low": close - rng.uniform(0, 25),
        "time": t_bar, "time_close": t_bar + secs * 1000 if rng.random() < 0.97 else None, "timenow": timenow, "bar_index": rng.choice([60, 5000]),
        "barstate.isfirst": True, "barstate.islast": True, "barstate.isrealtime": realtime, "barstate.isconfirmed": confirmed,
        "syminfo.mintick": 0.25, "syminfo.tickerid": "CME_MINI:MNQ1!",
        "timeframe.period": per, "timeframe.multiplier": mult, "timeframe.isseconds": kind == "s", "timeframe.isminutes": kind == "m",
        "timeframe.isdaily": kind == "D", "timeframe.isweekly": kind == "W", "timeframe.ismonthly": kind == "M", "timeframe.isintraday": kind in "sm",
        "chart.is_standard": rng.random() < 0.95, "chart.bg_color": rng.choice([(19, 23, 34, 0), (255, 255, 255, 0), (12, 14, 20, 0)]),
        "chart.fg_color": rng.choice([(209, 212, 220, 0), (19, 23, 34, 0)]),
    }
    hist = {("low", 1): close - rng.uniform(0, 70), ("high", 1): close + rng.uniform(0, 70), ("xa_abs", 10): rng.choice([None, 0, 1, 2, 3])}
    sess = {"30": t_bar if rng.random() < 0.5 else t_bar - 900000, "60": t_bar if rng.random() < 0.3 else t_bar - 900000,
            "240": t_bar if rng.random() < 0.2 else t_bar - 900000, "W": req["h_dw"] if rng.random() < 0.8 else req["h_dw"] + 604800000}
    lock = rng.random() < 0.1
    env = {"globals": G, "builtins": B, "inputs": inputs, "req": req, "ltf": ltf, "hist": hist,
           "sess": sess, "lock": lock, "ta": (close + rng.uniform(5, 300), close - rng.uniform(5, 300)), "var_override": {}}
    # the chip's debounce state: a realtime tick may carry a higher live state from earlier ticks of this bar ("held")
    if realtime and not confirmed and rng.random() < 0.5:
        env["var_override"] = {"ui_live": rng.randint(0, 2), "ui_bar": t_bar, "ui_chip_c": rng.randint(0, 2)}
    for k, v in o.items():
        sec, key = k.split(":", 1) if ":" in k else ("globals", k)
        env[sec][key] = v
    return env


def mockfns(env):
    def time_fn(I, args, kw, sc):
        a = [I.ev(x, sc) for x in args]
        if len(a) == 0:
            return env["builtins"]["time"]
        if len(a) >= 2:                                  # time(tf, session, tz): the bot's 12:45 lock
            return env["builtins"]["time"] if env["lock"] else None
        return env["sess"].get(a[0], env["builtins"]["time"])

    def in_seconds(I, args, kw, sc):
        return TF_SECS(env)

    def ta_hl(which):
        return lambda I, args, kw, sc: env["ta"][0 if which == "h" else 1]

    def ymd(which):
        def f(I, args, kw, sc):
            t = I.ev(args[0], sc)
            if t is None:
                return None
            d = datetime.fromtimestamp(t / 1000, tz=timezone.utc)
            return d.year if which == "y" else d.month
        return f
    return {"time": time_fn, "timeframe.in_seconds": in_seconds, "ta.highest": ta_hl("h"), "ta.lowest": ta_hl("l"),
            "year": ymd("y"), "month": ymd("m")}


def TF_SECS(env):
    per = env["builtins"]["timeframe.period"]
    for k, v in TF.items():
        if v[0] == per:
            return v[3]
    return None


# v2.8 (MacLevels): the same ranges; section 14 moved to the end of v2.8, so 13 ends at the next 14 / 15 header and 16 at the moved 14
SECTIONS = [(r"// 2\. COLORS", r"// 3\. TIME"), (r"// 11\. DRAWING", r"// 12\. CONFLUENCE"), (r"// 13\. DASHBOARD", r"// 1[45]\. "), (r"// 16\. v2\.5 LOOK", r"// 14\. ALERTS \(v2\.8")]
WATCH = ["v_a_tok_f", "v_a_note", "v_a_star", "v_d_tok_f", "v_d_tag", "v_d_star", "v15_s", "v15_src", "v30_s", "v30_src", "v60_s", "v60_src",
         "v240_s", "v240_src", "v_tfl", "dp", "u_fill", "u_bd", "u_t1", "u_t2", "u_acc", "ig_n", "ig_k", "ig_sd", "ig_rank", "ui_chip", "ui_h"]


def run(src, env, probes=None):
    env = dict(env)
    env["mockfns"] = mockfns(env)
    env["builtins"] = dict(env["builtins"])
    env["builtins"]["timeframe.in_seconds"] = None
    if probes:
        env["probes"] = probes
    I = pinei.Interp(src, env)
    for lo, hi in SECTIONS:
        I.run_range(lo, hi)
    fr = I.frame()
    g = I.g.v
    fr["globals"] = {k: repr(g.get(k, "<absent>")) for k in WATCH}
    fr["HT_PX"] = repr(g["HT_PX"].v if "HT_PX" in g else None)
    fr["U_NM"] = repr(g["U_NM"].v if "U_NM" in g else None)
    fr["f_v_srcname"] = [I.call("f_v_srcname", [("lit", s)], {}, I.g) for s in range(5)]
    return fr, I
