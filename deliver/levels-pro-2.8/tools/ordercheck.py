"""Pine declaration order: a function may call only functions defined above it, and read only globals declared above it.
Also: an `int` declaration whose expression has a '/' outside int()/math.round/floor/ceil (Pine: int / int is float).
usage: python3 -I ordercheck.py file.pine"""
import re, sys
L = open(sys.argv[1], encoding="utf-8").read().split("\n")
def strip(l):
    q = None; o = []; i = 0
    while i < len(l):
        c = l[i]
        if q:
            o.append(c)
            if c == q: q = None
        else:
            if c == '"': q = c
            elif l.startswith("//", i): break
            o.append(c)
        i += 1
    return "".join(o)
funcs, globs = {}, {}
cur = None
for n, l in enumerate(L, 1):
    c = strip(l)
    if not c.strip(): continue
    m = re.match(r"^([A-Za-z_]\w*)\(.*\)\s*=>", c)
    if m: funcs.setdefault(m.group(1), n); cur = m.group(1); continue
    if not c.startswith(" "):
        cur = None
        m = re.match(r"^(?:var\s+|varip\s+)?(?:[A-Za-z_][\w<>\[\]]*\s+)?([A-Za-z_]\w*)\s*=(?!=)", c)
        if m and not c.startswith("type "): globs.setdefault(m.group(1), n)
        m = re.match(r"^\[([^\]]+)\]\s*=", c)
        if m:
            for x in m.group(1).split(","): globs.setdefault(x.strip(), n)
bad = 0; cur = None; params = set(); locs = set()
for n, l in enumerate(L, 1):
    c = strip(l)
    if not c.strip(): continue
    m = re.match(r"^([A-Za-z_]\w*)\((.*)\)\s*=>(.*)$", c)
    if m:
        cur = m.group(1); params = {p.split()[-1] for p in m.group(2).split(",") if p.strip()}; locs = set(); body = m.group(3)
        if not body.strip(): continue
        c = " " + body
    if not c.startswith(" ") and not m: cur = None
    s = re.sub(r'"[^"]*"', '""', c)
    for f in re.findall(r"(?<![\w.])([A-Za-z_]\w*)\(", s):
        if f in funcs and funcs[f] > n: print(f"{n}: calls {f} defined at {funcs[f]}"); bad += 1
    if cur:
        md = re.match(r"^\s+(?:[A-Za-z_][\w<>\[\]]*\s+)?([A-Za-z_]\w*)\s*=(?!=)", s)
        if md: locs.add(md.group(1))
        mt = re.match(r"^\s+\[([^\]]+)\]\s*=", s)
        if mt: locs |= {x.strip() for x in mt.group(1).split(",")}
        mf = re.match(r"^\s+for\s+(\w+)", s)
        if mf: locs.add(mf.group(1))
        for w in re.findall(r"(?<![\w.])([A-Za-z_]\w*)(?![\w(])", s):
            if w in globs and globs[w] > n and w not in params and w not in locs and w not in funcs: print(f"{n}: in {cur} reads global {w} declared at {globs[w]}"); bad += 1
    mi = re.match(r"^\s*(?:var\s+)?int\s+\w+\s*=\s*(.*)$", s)
    if mi:
        e = mi.group(1)
        e2 = re.sub(r"(int|math\.round|math\.floor|math\.ceil)\((?:[^()]|\([^()]*\))*\)", "X", e)
        if "/" in e2: print(f"{n}: int declared from a '/' expression: {e.strip()[:90]}"); bad += 1
print("order/int problems:", bad)
