#!/usr/bin/env python3
"""F1 witness: heat bands, "levels stacked here" (Ignition spec r2 section 5 on r1 section 4). v2.7's own Pine runs through pinei;
a probe reads S where the Pine computes it, and the drawn boxes are read from the frame.
  1  the spec's fixtures: (a)-(d) at h = 10 to 4 decimals; (e) the real 10/30 00:30 PT board to 0.01, and its one very hot band
  2  the gates: never below 15m, hidden while ARMED, a stack of monthly / quarterly levels alone never makes a band
  3  random last bars (15m / 30m / 1H, calm / Full detail): S and the boxes against an independent reference written from the
     spec text (weights, Gaussian, 2-tick rule, 8 / 12, bands joined within h, M/Q never an anchor, nearest above / around /
     below price); the object budget (3 boxes, made once) and the colours (the chart's text colour at 88 / 93 %, or hidden)
Usage: nice -n 19 python3 -I heat_witness.py"""
import importlib.util, math, os, random, sys
from datetime import datetime, timezone

H = os.path.dirname(os.path.abspath(__file__))
sp = importlib.util.spec_from_file_location("pstate", os.path.join(H, "pstate.py")); ps = importlib.util.module_from_spec(sp); sp.loader.exec_module(ps)
P = ps.pinei
sys.path.insert(0, H)
import sw_mock; sw_mock.install(ps)
NEW = open(sys.argv[1], encoding="utf-8").read()
MODE = sys.argv[2] if len(sys.argv) > 2 else ""
UNIQ = MODE in ("uniq", "near")
NAMES, ABBR, IMP, TIER, _ = ps.registry(NEW)
print(__doc__.split("\n")[0])
PROBE_K = "if w_ka < 21 or w_ka > NL + 10"
PROBE_S = "if w_hs >= 8 and w_zb - w_pa <= w_hh"
ok = True


def weight(k):                                   # the spec text (r2 section 5), independent of the Pine
    if 21 <= k <= 37:
        return 1.0                               # monthly / quarterly: registry MO..PMoL, 16H QO..CML
    if k >= 38:
        return 2.5 * 1.5                         # the 16H weekly four (PWO's registry weight, weekly x 1.5)
    return IMP[k] * (1.5 if k >= 17 else 1.2 if TIER[k] == 2 else 1.0)


def ref_s(items, h, tick=0.25):
    if UNIQ:   # v2.7.1 oracle: each distinct price once, at its strongest weight (MacDot 6572147917 #1)
        out = []
        for pa, ka in items:
            best = {}
            for pb, kb in items:
                key = round(pb / tick) if MODE == "uniq" else min((q for q in best if abs(q - pb) <= tick * 2), default=pb)
                if abs(pa - pb) > tick * 2:
                    best[key] = max(best.get(key, 0.0), weight(kb) * math.exp(-0.5 * ((pa - pb) / h) ** 2))
                else:
                    best.setdefault(key, 0.0)
            out.append(sum(best.values()))
        return out
    return [sum(weight(kb) * math.exp(-0.5 * ((pa - pb) / h) ** 2) for pb, kb in items if abs(pa - pb) > tick * 2) for pa, ka in items]


def ref_boxes(items, S, h, close):
    bands, cur = [], None
    for (p, k), s in zip(items, S):
        if s >= 8 and not (21 <= k <= 37):
            if cur and cur[1] - p <= h:
                cur[1] = p; cur[2] = max(cur[2], s)
            else:
                if cur:
                    bands.append(cur)
                cur = [p, p, s]
    if cur:
        bands.append(cur)
    slots = [None, None, None]
    for t, b, s in bands:
        q = 0 if b > close else 2 if t < close else 1
        if q < 2 or slots[2] is None:
            slots[q] = (t + h / 2, b - h / 2, 88 if s >= 12 else 93)
    return slots


def run(env, probes=True):
    fr, I = ps.run(NEW, env, {PROBE_K: ["w_a", "w_pa", "w_ka"], PROBE_S: ["w_a", "w_pa", "w_hs"]} if probes else None)
    items = [(r["w_pa"], r["w_ka"]) for r in I.records if r["probe"] == PROBE_K]
    S = {r["w_a"]: r["w_hs"] for r in I.records if r["probe"] == PROBE_S}
    boxes = [o for o in I.objs if o.kind == "box"]
    return I, items, S, boxes


def box_state(b, fg):
    a = b.a
    vis = a.get("bgcolor") not in (None, (120, 123, 134, 100))
    return (round(a["top"], 6), round(a["bottom"], 6), a["bgcolor"][3]) if vis else None


def board(levels, close, atr, tf="15m", full=True, st_force=None, extra=None):
    env = ps.make_state(random.Random(7), NEW, tf, {"inputs:ui_detail": full, "builtins:close": close, "bias_score": 0.0,
                                                   "builtins:barstate.isrealtime": False, "builtins:barstate.isconfirmed": True})
    G = env["globals"]
    px = [None] * 27
    for k, p in levels.items():
        px[k] = p
    G["L_PX"] = P.Arr(px); G["L_ON"] = P.Arr([px[k] is not None for k in range(27)]); G["L_MRG"] = P.Arr([""] * 27)
    G["atr_ref"], G["band"], G["distant_atr"], G["engaged"], G["ip_i"] = atr, atr * 0.25, 1.5, False, -1
    env["inputs"]["ui_hw"] = env["inputs"]["ui_hm"] = False
    env["var_override"] = {}
    if extra:
        extra(env)
    return env


# 1 fixtures
print("\n1  the spec's fixtures")
fx = [("a: one level alone", {12: 100.0}, {12: 0.0}), ("b: VWAP 100.00 + PDH 105.00", {12: 100.0, 0: 105.0}, {12: 3.1770, 0: 3.1770}),
      ("c: VWAP 100.00 + PDH 100.25 (within 2 ticks)", {12: 100.0, 0: 100.25}, {12: 0.0, 0: 0.0}), ("d: VWAP 100.00 + PDH 110.00", {12: 100.0, 0: 110.0}, {12: 2.1835, 0: 2.1835})]
for nm, lv, want in fx:
    I, items, S, _ = run(board(lv, 100.0, 40.0))                    # band = 0.25 x 40 = 10 = h
    got = {k: S[i] for i, (p, k) in enumerate(items)}
    good = all(abs(round(got[k], 4) - v) < 1e-9 for k, v in want.items())
    ok = ok and good
    print(f"   {nm:46s} -> " + ", ".join(f"{NAMES[k]} S={got[k]:.4f}" for k in want) + ("   ok" if good else "   MISMATCH"))
for nm, lv in [("MacDot-style: VWAP 100 + PDH/PWH/Week Open all 105", {12: 100.0, 0: 105.0, 18: 105.0, 20: 105.0})]:
    ks = [k for k in lv]
    I, items, S, bx = run(board(lv, 100.0, 40.0))
    got = {k: S[i] for i, (p, k) in enumerate(items)}
    print(f"   {nm} -> " + ", ".join(f"{NAMES[k]} S={got[k]:.7f}" for k in ks) + f"; weights {[round(weight(k),3) for k in ks]}; bands drawn {sum(box_state(b, None) is not None for b in bx)}")
E = {NAMES.index(n): p for n, p in {"PDH": 29794.25, "PDL": 29111, "PDC": 29217.75, "Asia High": 29180.75, "Asia Low": 28820.25, "London High": 29011,
     "London Low": 28957.25, "06:30 Open": 29612.5, "15:00 Open": 29180, "VWAP": 28984.63, "4H Open": 28980, "1H Open": 28997, "30m Open": 28965.75,
     "PWH": 30114, "PWL": 28986.25, "Week Open": 29268.5}.items()}          # Daily Open (29,180) off: the engine's dedupe keeps 15:00 Open
SPEC_E = {"London High": 12.29, "1H Open": 15.75, "PWL": 14.16, "VWAP": 15.84, "4H Open": 16.32, "30m Open": 15.12, "London Low": 12.31}
for full in (True, False):
    I, items, S, boxes = run(board(E, 28960.75, 132.24, full=full))
    got = {NAMES[k]: S[i] for i, (p, k) in enumerate(items)}
    good = all(abs(got[n] - v) <= 0.01 for n, v in SPEC_E.items())
    bx = [box_state(b, None) for b in boxes]
    h = 132.24 * 0.25
    want_b = [None, (round(29011 + h / 2, 6), round(28957.25 - h / 2, 6), 88), None]
    ok = ok and good and bx == want_b
    print(f"   e: 10/30 00:30 PT ({'Full detail' if full else 'calm'}, {len(items)} listed): " + ", ".join(f"{n} {got[n]:.2f}" for n in SPEC_E) + ("   ok (spec to 0.01)" if good else "   MISMATCH"))
    print(f"      boxes: {bx}  (want one very hot band 28,957.25-29,011 +/- h/2 around price, 88 %)" + ("   ok" if bx == want_b else "   MISMATCH"))

# 2 gates
print("\n2  the gates")
for tf in ("1m", "5m", "15m", "30m", "1H"):
    I, items, S, boxes = run(board(E, 28960.75, 132.24, tf=tf))
    vis = sum(box_state(b, None) is not None for b in boxes)
    exp = 0 if ps.TF[tf][3] < 900 else 1
    ok = ok and vis == exp
    print(f"   {tf:4s} chart: bands drawn {vis} (want {exp})")
env = board(E, 28960.75, 132.24)
fr, I = ps.run(NEW, env)
I.call("f_ui_tags", [("lit", 3), ("lit", True)], {}, I.g)
vis = sum(box_state(b, None) is not None for b in I.objs if b.kind == "box")
ok = ok and vis == 0
print(f"   ARMED (st 3) on the same board: bands drawn {vis} (want 0: the glow is the focus)")
# a stack of monthly / quarterly levels only: the registry's six M levels plus the 16H CMH / CML / QH / QL, inside 30 pts
t_bar = env["builtins"]["time"]
bm = (lambda d: d.year * 12 + d.month - 1)(datetime.fromtimestamp((t_bar + 10800000) / 1000, tz=timezone.utc))
MQ = {21: 28000.0, 22: 28004.0, 23: 28008.0, 24: 28012.0, 25: 28016.0, 26: 28020.0}


def mq_extra(with_pwl):
    def f(env):
        env["inputs"]["ui_hm"] = True
        env["req"].update({"h_dm": bm, "h_cmh": 28002.0, "h_cml": 28006.0, "h_qh": 28010.0, "h_ql": 28014.0})
        env["globals"].update({"mo_v": 27000.0, "pmo_v": 26000.0, "pmoh_v": 30000.0, "pmol_v": 25000.0})
    return f


for with_pwl in (False, True):
    lv = dict(MQ)
    if with_pwl:
        lv[18] = 28010.0
    I, items, S, boxes = run(board(lv, 28010.0, 132.24, full=True, extra=mq_extra(with_pwl)))
    mq_items = [(p, k) for p, k in items if 21 <= k <= 37]
    s_mq = max(ref_s(items, 33.06)[i] for i, (p, k) in enumerate(items) if 21 <= k <= 37)
    vis = [box_state(b, None) for b in boxes]
    nb = sum(v is not None for v in vis)
    ok = ok and nb == (1 if with_pwl else 0)
    print(f"   {len(mq_items)} monthly / quarterly levels inside 20 pts (highest S {s_mq:.2f})" + (" + PWL" if with_pwl else "") + f": bands drawn {nb} (want {1 if with_pwl else 0})")

# 3 random
print("\n3  random last bars against the spec reference")
rng = random.Random(30)
n = sbad = bbad = budget = colour = drawn = 0
for i in range(int(os.environ.get("NB", "200"))):
    env = ps.make_state(random.Random(5000 + i), NEW, rng.choice(["15m", "15m", "30m", "1H"]))
    G = env["globals"]
    c = env["builtins"]["close"]
    px = list(G["L_PX"].v)
    for _ in range(rng.randint(0, 8)):                                   # make stacks: several levels near one price
        k = rng.randrange(27)
        px[k] = round((c + rng.uniform(-60, 60)) * 4) / 4
    G["L_PX"] = P.Arr(px)
    env["var_override"] = {}
    I, items, S, boxes = run(env)
    st = I.g.v["ui_chip"]
    h = max(G["band"], 1.0)
    n += 1
    budget += len(boxes) != 3
    if st < 3:
        Sr = ref_s(items, h)
        near = any(0 < abs(p1 - p2) <= 0.5 for p1, _ in items for p2, _ in items)
        bad1 = any(abs(Sr[j] - S[j]) > 1e-9 for j, (p, k) in enumerate(items) if not (21 <= k <= 37))
        if bad1 and not near:
            print("   MISMATCH without a near-distinct pair", i)
        sbad += any(abs(Sr[j] - S[j]) > 1e-9 for j, (p, k) in enumerate(items) if not (21 <= k <= 37))
        want = ref_boxes(items, Sr, h, c)
        got = [box_state(b, None) for b in boxes]
        want = [None if w is None else (round(w[0], 6), round(w[1], 6), w[2]) for w in want]
        bbad += got != want
        drawn += sum(g is not None for g in got)
    for b in boxes:
        bg, tc = b.a.get("bgcolor"), b.a.get("text_color")
        colour += not (bg in ((120, 123, 134, 100),) or (bg[:3] == env["builtins"]["chart.fg_color"][:3] and bg[3] in (88, 93)))
        colour += b.a.get("text") != "levels stacked here" or b.a.get("border_color") != (120, 123, 134, 100)
print(f"   {n} last bars: S different from the reference {sbad}; boxes different from the reference {bbad}; bands drawn {drawn};"
      f" object budget breaks {budget}; colour / text outside the rule {colour}")
ok = ok and sbad == 0 and bbad == 0 and budget == 0 and colour == 0 and drawn > 0
print(f"\n   object budget: boxes 3 / 50 (pooled once at the first bar), lines 46 / 100 and labels 42 / 100 unchanged")
print(f"\nVERDICT: {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
