#!/usr/bin/env python3
"""v2.7.1 SWEPT witness (MacDot 6572147917 #2). The engine's own cross tracking (section 7, quoted from the file) drives
XDIR / XAGE / FAILAGE bar by bar on a timeline WITH GAPS; the section-P4 shadow (SW_ON / SW_T, written only on a closed bar)
is transliterated from the file's own lines; the file's Pine renders the PDL tag through pinei (last bar, history or live).
Usage: nice -n 19 python3 -I swept_witness_271.py <file.pine>"""
import importlib.util, os, random, sys
H = os.path.dirname(os.path.abspath(__file__))
sp = importlib.util.spec_from_file_location("pstate", os.path.join(H, "pstate.py")); ps = importlib.util.module_from_spec(sp); sp.loader.exec_module(ps)
P = ps.pinei
NEW = open(sys.argv[1], encoding="utf-8").read()
V271 = "SW_ON" in NEW
SHADOW = """    if barstate.isconfirmed
        array.set(SW_ON, i, xd != 0 and xa < confirm_bars and array.get(FAILAGE, i) != xa + 1)
        if xa == 0
            array.set(SW_T, i, time_close)"""
if V271:
    assert SHADOW in NEW
K, PX, CONF, M = 1, 28500.0, 3, 60000
T0 = 1793345400000


class Level:   # section 7 transliteration (as in v2.7's swept_witness.py) + the P4 shadow
    def __init__(s):
        s.xdir, s.xage, s.side, s.fage, s.on, s.t = 0, 9999, 0, 9999, False, None

    def bar(s, close, t_close, confirmed):
        xd_prev, xa_prev = s.xdir, s.xage
        ns = 1 if close > PX else -1
        cross = s.side != 0 and ns != s.side
        if cross:
            s.xdir, s.xage = ns, 0
        else:
            s.xage = min(s.xage + 1, 9999)
        s.side = ns
        if cross and xd_prev != 0 and xa_prev < CONF:
            s.fage = 0
        s.fage += 1 if s.fage < 9999 else 0
        if confirmed:
            s.on = s.xdir != 0 and s.xage < CONF and s.fage != s.xage + 1
            if s.xage == 0:
                s.t = t_close
        return s


def copy(l):
    n = Level(); n.__dict__.update(l.__dict__); return n


def render(lv, live, t_open, t_close, tnow):
    env = ps.make_state(random.Random(11), NEW, "15m", {"inputs:ui_detail": False, "inputs:ui_tag_room": 6, "confirm_bars": CONF,
                        "builtins:barstate.isrealtime": live, "builtins:barstate.isconfirmed": not live,
                        "builtins:time": t_open, "builtins:timenow": tnow, "builtins:close": PX + 60})
    G = env["globals"]
    px = [None] * 27; px[K] = PX; px[0] = PX + 900
    G["L_PX"] = P.Arr(px); G["L_ON"] = P.Arr([k in (0, K) for k in range(27)]); G["L_MRG"] = P.Arr([""] * 27)
    G["atr_ref"], G["band"], G["engaged"], G["ip_i"] = 132.0, 33.0, False, -1
    for nm, v, d in (("XDIR", lv.xdir, 0), ("XAGE", lv.xage, 9999), ("FAILAGE", lv.fage, 9999), ("SW_ON", lv.on, False), ("SW_T", lv.t, None)):
        a = [d] * 27; a[K] = v; G[nm] = P.Arr(a)
    env["builtins"]["time_close"] = t_close
    env["inputs"]["ui_hw"] = env["inputs"]["ui_hm"] = False
    env["var_override"] = {}
    fr, I = ps.run(NEW, env)
    lb = I.g.v["LB"].v[K]
    return lb.a.get("text"), lb.a.get("tooltip", "")


def hm(t):
    return f"{(t - T0) // M // 60 + 14:02d}:{(t - T0) // M % 60:02d}"


ok = True
res = []
def check(name, got, want):
    global ok
    good = got == want
    ok = ok and good
    res.append(f"   {name}: {got!r}  (want {want!r}) {'ok' if good else 'MISMATCH'}")

# timeline: T0 = 14:00. 15m bars: 13:30-13:45 close 28530 (above), 13:45-14:00 close 28480 (crosses DN, closes 14:00);
# then a 60-minute gap (no bars 14:00-15:00, e.g. the CME daily halt); the 15:00 bar is forming.
base = Level()
base.bar(28530, T0 - 15 * M, True)
base.bar(28480, T0, True)                       # the crossing bar, closed 14:00
B = T0 + 60 * M                                 # 15:00 bar open, closes 15:15
print("A  gap: crossing bar closed 14:00, next bar opens 15:00, tick at 15:04 (MacDot's fixture)")
l = copy(base).bar(28470, B + 15 * M, False)    # forming, still below: provisional state
check("A1 live 15:04, forming bar still through", render(l, True, B, B + 15 * M, B + 4 * M)[0], "PDL SWEPT 64m" if V271 else "PDL SWEPT 64m")
print("B  provisional close back on the forming bar (no candle has closed back)")
l = copy(base).bar(28520, B + 15 * M, False)
check("B1 live 15:04, forming bar back above", render(l, True, B, B + 15 * M, B + 4 * M)[0], "PDL SWEPT 64m")
l2 = copy(base).bar(28470, B + 15 * M, False)
check("B2 next tick 15:05, forming bar below again", render(l2, True, B, B + 15 * M, B + 5 * M)[0], "PDL SWEPT 65m")
l3 = copy(base).bar(28520, B + 15 * M, True)
check("B3 the 15:15 close is back above (the reclaim, confirmed)", render(l3, False, B, B + 15 * M, B + 15 * M)[0], "PDL")
print("C  the forming bar crosses with no closed sweep")
c0 = Level(); c0.bar(28530, T0 - 15 * M, True); c0.bar(28520, T0, True)
c1 = copy(c0).bar(28490, T0 + 15 * M, False)
t, tip = render(c1, True, T0, T0 + 15 * M, T0 + 5 * M)
check("C1 live, forming bar below", t, "PDL SWEPT now")
okt = ("has not closed" in tip) if V271 else True
ok = ok and okt
res.append(f"   C1 tooltip says the forming candle has not closed: {okt}")
c2 = copy(c0).bar(28510, T0 + 15 * M, False)
check("C2 next tick, forming bar back above", render(c2, True, T0, T0 + 15 * M, T0 + 6 * M)[0], "PDL")
print("\n".join(res)); res.clear()

print("D  history property run (closed bars, 15m, random gaps): shown <=> the engine rule; age = clock minutes since the crossing close")
rng = random.Random(9)
n = bad = 0
for _ in range(300):
    lv = Level(); t = T0; times = []
    for b in range(rng.randint(2, 8)):
        t += 15 * M + (rng.choice([0, 0, 0, 45, 60, 1035]) * M)
        lv.bar(PX + rng.choice([-40, -10, 10, 40]), t, True)
    txt, tip = render(lv, False, t - 15 * M, t, t + 1)
    rule = lv.xdir != 0 and lv.xage < CONF and lv.fage != lv.xage + 1
    want = "PDL" if not rule else f"PDL SWEPT {(t - lv.t) // M}m"
    n += 1
    bad += txt != want
print(f"   {n} closed-bar histories: tag different from the rule / clock age {bad}")
ok = ok and bad == 0
print(f"VERDICT: {'PASS' if ok else 'FAIL'}")
