"""pinei2: pinei (levels-pro-271/tools/pinei.py, the v2.7 desk interpreter) extended for the v2.8 TIDE section:
user-defined types (type / X.new / field read, write, +=), `for x in array`, postfix `.field` on call results,
array.remove / includes / indexof / median / slice / new<T>, str.contains, int(), hour / minute (IANA tz).
Same v5 semantics as pinei: `and` / `or` evaluate BOTH sides (an out-of-range array index on either side raises),
the ternary only its branch, `for a to b` counts down when a > b, na compares false.
Usage: I = load(path_of_pine_text); then I.call_fn('t_step', [...]) per bar; read globals from I.g.v."""
import importlib.util, math, re, os
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("pinei", os.path.join(HERE, "pinei.py"))
PI = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(PI)

# lexer: + a lone '.' before a name (postfix field access)
PI.TOKRE = re.compile(PI.TOKRE.pattern.replace(r"|(?P<op>", r"|(?P<dot>\.(?=[A-Za-z_]))|(?P<op>"))
def _lex(s, ln):
    toks, i = [], 0
    while i < len(s):
        m = PI.TOKRE.match(s, i)
        if not m or m.end() == i:
            if s[i:].strip() == "": break
            raise SyntaxError(f"line {ln}: cannot lex at {s[i:i + 30]!r}")
        i = m.end()
        if m.group("dot") is not None:
            toks.append(("op", ".")); continue
        for k in ("str", "col", "num", "name", "op"):
            if m.group(k) is not None:
                toks.append((k, m.group(k))); break
    return toks
PI.lex = _lex

UDT = {}            # name -> [(field, default_expr_or_None)]

_orig_postfix = PI.P.postfix
def postfix(self):
    e = _orig_postfix(self)
    while self.peek()[1] == ".":
        self.take(); nm = self.take()[1]
        for part in nm.split("."):
            e = ("field", e, part)
        # a call result's field may be followed by more (a.b().c) - only fields are needed here
    return e
PI.P.postfix = postfix

def preprocess(src):
    src = re.sub(r"array\.new<\w+>\(", "array.new_udt(", src)
    src = re.sub(r"array<\w+>", "array_t", src)
    return src

_orig_parse = PI.parse_stmt
def parse_stmt(ln, txt):
    m = re.match(r"^for\s+(\w+)\s+in\s+(.*)$", txt)
    if m:
        toks = PI.lex(m.group(2), ln); p = PI.P(toks, ln)
        return ("forin", ln, m.group(1), p.expr())
    m = re.match(r"^type\s+(\w+)$", txt)
    if m:
        return ("typedef", ln, m.group(1))
    return _orig_parse(ln, txt)
PI.parse_stmt = parse_stmt

_orig_build = PI.build_block
def build_block(lines, i, ind):
    out = []
    while i < len(lines) and lines[i][1] >= ind:
        ln, li, txt = lines[i]
        if li > ind: raise SyntaxError(f"line {ln}: unexpected indent")
        st = PI.parse_stmt(ln, txt); i += 1
        if st[0] in ("if", "elif", "else", "for", "while", "forin") or (st[0] == "def" and st[4] is None):
            if i < len(lines) and lines[i][1] > ind:
                body, i = build_block(lines, i, lines[i][1])
            else:
                body = []
            st = st + (body,)
        out.append(st)
    return out, i
PI.build_block = build_block

_orig_group = PI.group_ifs
def group_ifs(stmts):
    return _orig_group([st[:-1] + (group_ifs(st[-1]),) if st[0] == "forin" else st for st in stmts])
PI.group_ifs = group_ifs


class UObj:
    __slots__ = ("tn", "f")
    def __init__(self, tn, f): self.tn, self.f = tn, f
    def __repr__(self): return f"{self.tn}{self.f}"


class Interp2(PI.Interp):
    def __init__(self, src, env):
        src = preprocess(src)
        # collect the type definitions (top level: `type X` then indented `T name [= default]`)
        L = src.split("\n"); keep = []; i = 0
        while i < len(L):
            m = re.match(r"^type\s+(\w+)\s*$", L[i])
            if m:
                fields = []; i += 1
                while i < len(L) and L[i].startswith("    "):
                    c = PI.strip_comment(L[i]).strip()
                    if c:
                        mm = re.match(r"^(\S+)\s+(\w+)(?:\s*=\s*(.*))?$", c)
                        fields.append((mm.group(2), mm.group(3)))
                    keep.append(""); i += 1
                UDT[m.group(1)] = fields; PI.TYPES.add(m.group(1)); keep.insert(len(keep), "")
                continue
            keep.append(L[i]); i += 1
        PI.TYPES.add("array_t")
        src = "\n".join(keep)
        super().__init__(src, env)

    def run_all_globals(self):
        """execute every top-level statement once (the first bar: var declarations initialise)"""
        lines = PI.logical_lines(self.L)
        stmts, i = [], 0
        while i < len(lines):
            ln, ind, txt = lines[i]
            if ind == 0 and re.match(r"^[A-Za-z_]\w*\(.*\)\s*=>", txt):
                i += 1
                while i < len(lines) and lines[i][1] > 0: i += 1
                continue
            j = i + 1
            while j < len(lines) and lines[j][1] > 0: j += 1
            blk, _ = PI.build_block(lines[i:j], 0, 0)
            stmts += blk; i = j
        self.exec_block(PI.group_ifs(stmts), self.g, None)

    def call_fn(self, name, args):
        params, body, ln = self.funcs[name]
        fs = PI.Scope(self.g)
        for p_, v in zip(params, args): fs.v[p_] = v
        return self.exec_block(body, fs, name) if isinstance(body, list) else self.ev(body, fs)

    # ---- names with dots: a UDT field path
    def resolve(self, n, sc):
        parts = n.split(".")
        s = sc.find(parts[0])
        if s is None: return False, None
        v = s.v[parts[0]]
        for f in parts[1:]:
            if not isinstance(v, UObj): raise PI.PineError(f"field {f} of non-object {parts[0]} ({v!r})")
            v = v.f[f]
        return True, v

    def ev(self, e, sc):
        k = e[0]
        if k == "name" and "." in e[1]:
            ok, v = self.resolve(e[1], sc)
            if ok: return v
        if k == "field":
            o = self.ev(e[1], sc)
            if not isinstance(o, UObj): raise PI.PineError(f"field {e[2]} of {o!r}")
            return o.f[e[2]]
        return super().ev(e, sc)

    def exec_stmt(self, st, sc, fn):
        k = st[0]
        if k == "assign" and "." in st[2]:
            _, ln, name, op, e = st
            parts = name.split(".")
            s = sc.find(parts[0])
            if s is not None and isinstance(s.v[parts[0]], UObj):
                o = s.v[parts[0]]
                for f in parts[1:-1]: o = o.f[f]
                if not isinstance(o, UObj): raise PI.PineError(f"line {ln}: field write on {o!r}")
                v = self.ev(e, sc)
                o.f[parts[-1]] = v if op == ":=" else self.arith(op[0], o.f[parts[-1]], v)
                return None
        if k == "forin":
            _, ln, var, ex, body = st
            A = self.ev(ex, sc)
            if not isinstance(A, PI.Arr): raise PI.PineError(f"line {ln}: for-in over {A!r}")
            n0 = len(A.v)
            for x in list(A.v):
                inner = PI.Scope(sc); inner.v[var] = x
                try: self.exec_block(body, inner, fn)
                except PI.Brk: break
                except PI.Cont: continue
                if len(A.v) != n0: raise PI.PineError(f"line {ln}: array resized inside for-in")
            return None
        if k == "assign" and "." not in st[2]:
            r = super().exec_stmt(st, sc, fn)
            if sc.find(st[2]) is self.g and st[2] in self.varstore_g:
                self.varstore_g[st[2]] = self.g.v[st[2]]
            return r
        if k == "decl" and st[4] in ("var", "varip") and fn is None:
            _, ln, name, e, mode = st
            if name not in self.varstore_g:
                self.varstore_g[name] = self.ev(e, sc)
            sc.v[name] = self.varstore_g[name]
            return None
        return super().exec_stmt(st, sc, fn)

    varstore_g = None

    def call(self, f, args, kw, sc):
        E = lambda i: self.ev(args[i], sc)
        tn = f[:-4] if f.endswith(".new") else None
        if tn in UDT:
            vals = {}
            fields = UDT[tn]
            for i, (fn_, d) in enumerate(fields):
                if i < len(args): vals[fn_] = self.ev(args[i], sc)
                elif fn_ in kw: vals[fn_] = self.ev(kw[fn_], sc)
                else: vals[fn_] = None if d is None else self.ev(PI.P(PI.lex(d, 0), 0).expr(), PI.Scope())
            return UObj(tn, vals)
        if f == "array.new_udt":
            n = E(0) if args else 0
            return PI.Arr([E(1) if len(args) > 1 else None] * int(n))
        if f == "array.remove":
            A, i = E(0), E(1)
            if PI.is_na(i) or not (0 <= i < len(A.v)): raise PI.PineError(f"array.remove index {i} (size {len(A.v)})")
            return A.v.pop(i)
        if f == "array.includes": return E(1) in E(0).v
        if f == "array.indexof":
            A, x = E(0), E(1)
            return A.v.index(x) if x in A.v else -1
        if f == "array.median":
            v = sorted(E(0).v); n = len(v)
            return None if not n else (v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2)
        if f == "array.slice":
            A, a, b = E(0), E(1), E(2)
            if not (0 <= a <= b <= len(A.v)): raise PI.PineError("array.slice range")
            return PI.Arr(A.v[a:b])
        if f == "str.contains": return E(1) in E(0)
        if f == "float":
            v = E(0); return None if PI.is_na(v) else float(v)
        if f == "int":
            v = E(0); return None if PI.is_na(v) else int(v)
        if f in ("hour", "minute"):
            import datetime as D
            d = D.datetime.fromtimestamp(E(0) / 1000, ZoneInfo(E(1)))
            return d.hour if f == "hour" else d.minute
        if f in ("math.max", "math.min") and any(isinstance(self.ev(x, sc), str) for x in args[:1]):
            pass
        return super().call(f, args, kw, sc)


def load(path, env=None):
    txt = open(path, encoding="utf-8").read()
    a = txt.index("// == TIDE ENGINE BEGIN"); b = txt.find("// == TIDE DISPLAY BEGIN")
    b = b if b > a else txt.index("// == TIDE ENGINE END")
    I = Interp2(txt[a:b], env or {})
    I.varstore_g = {}
    I.run_all_globals()
    return I

_orig_fmt = PI.fmt_num
def fmt_num(x, f=None):
    if f == "#":
        return "NaN" if PI.is_na(x) else str(int(PI.Decimal(repr(float(x))).quantize(PI.Decimal(1), rounding=PI.ROUND_HALF_UP)))
    return _orig_fmt(x, f)
PI.fmt_num = fmt_num
