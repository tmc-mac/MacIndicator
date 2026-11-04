"""pinei: a small interpreter for the Pine v5 subset Daily Levels PRO's display code uses (sections 2, 11, 13, 16).
It runs the shipped Pine text itself (not a hand model): every function definition in the file is registered, and the global
statements of the chosen sections are executed on a mocked engine state for ONE last bar. Drawing calls are recorded as object
state (lines, labels, boxes, table cells, barcolor), so two files can be compared frame for frame.

Semantics kept from Pine v5 (the ones the display code can observe):
  * `and` / `or` evaluate BOTH sides (v5); the ternary evaluates only the branch it takes.
  * `for i = a to b` is inclusive and counts DOWN when a > b (so `0 to -1` runs i = 0 and -1).
  * na is None: arithmetic with na is na, a comparison with na is false, math.max / min with an na argument is na.
  * array.get / set / insert, str.substring out of range RAISE (the RE10045 class): a trap is an error here, never a skip.
  * `%` truncates toward zero (C), `/` is float division, math.floor / ceil / round return int.
Not modelled (stated): TradingView's pixel layout, realtime rollback, request.* (mocked by name), ta.* history (mocked).
Usage: imported by the v2.7 witnesses (importlib, by path)."""
import math, re
from decimal import Decimal, ROUND_HALF_UP

# ---------------------------------------------------------------- lexer
TOKRE = re.compile(r'\s*(?:(?P<str>"(?:[^"\\]|\\.)*")|(?P<col>#[0-9A-Fa-f]{8}\b|#[0-9A-Fa-f]{6}\b)|(?P<num>\d+\.\d*(?:[eE]-?\d+)?|\.\d+|\d+(?:[eE]-?\d+)?)'
                   r'|(?P<name>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)|(?P<op>:=|\+=|-=|\*=|/=|==|!=|<=|>=|=>|[-+*/%<>=?:(),\[\]]))')


def strip_comment(l):
    out, q, i = [], False, 0
    while i < len(l):
        ch = l[i]
        if q:
            out.append(ch)
            if ch == "\\":
                out.append(l[i + 1:i + 2]); i += 2; continue
            if ch == '"':
                q = False
        else:
            if ch == '"':
                q = True
            elif l.startswith("//", i):
                break
            out.append(ch)
        i += 1
    return "".join(out).rstrip()


def lex(s, ln):
    toks, i = [], 0
    while i < len(s):
        m = TOKRE.match(s, i)
        if not m or m.end() == i:
            if s[i:].strip() == "":
                break
            raise SyntaxError(f"line {ln}: cannot lex at {s[i:i + 30]!r}")
        i = m.end()
        for k in ("str", "col", "num", "name", "op"):
            if m.group(k) is not None:
                toks.append((k, m.group(k)))
                break
    return toks


# ---------------------------------------------------------------- AST (tuples) and parser
class P:
    def __init__(self, toks, ln):
        self.t, self.i, self.ln = toks, 0, ln

    def peek(self, k=0):
        return self.t[self.i + k] if self.i + k < len(self.t) else (None, None)

    def take(self, v=None):
        tk = self.peek()
        if v is not None and tk[1] != v:
            raise SyntaxError(f"line {self.ln}: expected {v!r}, got {tk!r}")
        self.i += 1
        return tk

    def expr(self):
        c = self.binop(0)
        if self.peek()[1] == "?":
            self.take("?")
            a = self.expr()
            self.take(":")
            b = self.expr()
            return ("tern", c, a, b)
        return c

    PREC = [("or",), ("and",), ("==", "!="), ("<", ">", "<=", ">="), ("+", "-"), ("*", "/", "%")]

    def binop(self, lvl):
        if lvl == len(self.PREC):
            return self.unary()
        left = self.binop(lvl + 1)
        while self.peek()[1] in self.PREC[lvl]:
            op = self.take()[1]
            right = self.binop(lvl + 1)
            left = ("bin", op, left, right)
        return left

    def unary(self):
        tk = self.peek()
        if tk[1] == "not":
            self.take(); return ("not", self.unary())
        if tk[1] == "-":
            self.take(); return ("neg", self.unary())
        if tk[1] == "+":
            self.take(); return self.unary()
        return self.postfix()

    def postfix(self):
        e = self.primary()
        while True:
            tk = self.peek()
            if tk[1] == "(" and e[0] == "name":
                self.take("(")
                args, kw = [], {}
                while self.peek()[1] != ")":
                    if self.peek()[0] == "name" and self.peek(1)[1] == "=":
                        k = self.take()[1]; self.take("=")
                        kw[k] = self.expr()
                    else:
                        args.append(self.expr())
                    if self.peek()[1] == ",":
                        self.take(",")
                self.take(")")
                e = ("call", e[1], args, kw)
            elif tk[1] == "[":
                self.take("[")
                k = self.expr()
                self.take("]")
                e = ("hist", e, k)
            else:
                return e

    def primary(self):
        k, v = self.take()
        if k == "num":
            return ("lit", float(v) if any(c in v for c in ".eE") else int(v))
        if k == "str":
            return ("lit", re.sub(r'\\(.)', lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), v[1:-1]))
        if k == "col":
            h = v[1:]
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            t = 0 if len(h) == 6 else round((255 - int(h[6:8], 16)) / 255 * 100)
            return ("lit", (r, g, b, t))
        if k == "name":
            if v == "true":
                return ("lit", True)
            if v == "false":
                return ("lit", False)
            return ("name", v)
        if v == "(":
            e = self.expr(); self.take(")"); return e
        if v == "[":
            items = []
            while self.peek()[1] != "]":
                items.append(self.expr())
                if self.peek()[1] == ",":
                    self.take(",")
            self.take("]")
            return ("tuple", items)
        raise SyntaxError(f"line {self.ln}: unexpected {v!r}")


TYPES = {"int", "float", "bool", "string", "color", "line", "label", "box", "table"}


def logical_lines(src_lines, lo=0, hi=None):
    """[(lineno, indent, text)] for code lines in [lo, hi), continuation lines joined (open parens / brackets)"""
    hi = len(src_lines) if hi is None else hi
    out, i = [], lo
    while i < hi:
        c = strip_comment(src_lines[i])
        if not c.strip():
            i += 1; continue
        ind = len(c) - len(c.lstrip(" "))
        txt, start = c.strip(), i
        depth = txt.count("(") + txt.count("[") - txt.count(")") - txt.count("]")
        while depth > 0 and i + 1 < hi:
            i += 1
            nx = strip_comment(src_lines[i]).strip()
            txt += " " + nx
            depth += nx.count("(") + nx.count("[") - nx.count(")") - nx.count("]")
        out.append((start + 1, ind, txt))
        i += 1
    return out


def parse_stmt(ln, txt):
    toks = lex(txt, ln)
    p = P(toks, ln)
    k0 = toks[0][1]
    if k0 in ("if",):
        p.take(); return ("if", ln, p.expr())
    if k0 == "else":
        p.take()
        if p.peek()[1] == "if":
            p.take(); return ("elif", ln, p.expr())
        return ("else", ln)
    if k0 == "for":
        p.take(); var = p.take()[1]; p.take("=")
        a = p.expr(); p.take("to"); b = p.expr()
        return ("for", ln, var, a, b)
    if k0 == "while":
        p.take(); return ("while", ln, p.expr())
    if k0 in ("break", "continue"):
        return (k0, ln)
    # function definition
    if toks[0][0] == "name" and len(toks) > 1 and toks[1][1] == "(" and "=>" in [t[1] for t in toks]:
        j = [t[1] for t in toks].index("=>")
        # params between ( and the matching )
        params, cur = [], []
        for t in toks[2:j - 1]:
            if t[1] == ",":
                params.append(cur); cur = []
            else:
                cur.append(t[1])
        if cur:
            params.append(cur)
        names = [x[-1] for x in params]
        body = None
        if j + 1 < len(toks):
            body = P(toks[j + 1:], ln).expr()
        return ("def", ln, toks[0][1], names, body)
    # tuple declaration
    if k0 == "[":
        j = [t[1] for t in toks].index("]")
        if j + 1 < len(toks) and toks[j + 1][1] == "=":
            names = [t[1] for t in toks[1:j] if t[1] != ","]
            p.i = j + 2
            return ("tdecl", ln, names, p.expr())
        return ("expr", ln, p.expr())
    # declaration / assignment
    i, mode = 0, None
    if toks[i][1] in ("var", "varip"):
        mode = toks[i][1]; i += 1
    if toks[i][1] in TYPES or (toks[i][1] in TYPES | {"float", "int"} and i + 1 < len(toks) and toks[i + 1][1] == "["):
        i += 1
        if toks[i][1] == "[":
            i += 2
    if toks[i][0] == "name" and i + 1 < len(toks) and toks[i + 1][1] in ("=", ":=", "+=", "-=", "*=", "/="):
        name, op = toks[i][1], toks[i + 1][1]
        p.i = i + 2
        e = p.expr()
        if op == "=":
            return ("decl", ln, name, e, mode)
        return ("assign", ln, name, op, e)
    return ("expr", ln, p.expr())


def build_block(lines, i, ind):
    """statements at indentation `ind` from lines[i:], nested by indentation; returns (stmts, next_i)"""
    out = []
    while i < len(lines) and lines[i][1] >= ind:
        ln, li, txt = lines[i]
        if li > ind:
            raise SyntaxError(f"line {ln}: unexpected indent")
        st = parse_stmt(ln, txt)
        i += 1
        if st[0] in ("if", "elif", "else", "for", "while") or (st[0] == "def" and st[4] is None):
            if i < len(lines) and lines[i][1] > ind:
                body, i = build_block(lines, i, lines[i][1])
            else:
                body = []
            st = st + (body,)
        out.append(st)
    return out, i


def group_ifs(stmts):
    """fold if / else-if / else chains into ('ifc', ln, [(cond, body)...], else_body)"""
    out = []
    for st in stmts:
        if st[0] in ("if", "elif", "else", "for", "while", "def"):
            st = st[:-1] + (group_ifs(st[-1]),) if isinstance(st[-1], list) else st
        if st[0] == "if":
            out.append(["ifc", st[1], [(st[2], st[3])], None])
        elif st[0] == "elif":
            out[-1][2].append((st[2], st[3]))
        elif st[0] == "else":
            out[-1][3] = st[2]
        else:
            out.append(st)
    return [tuple(x) if isinstance(x, list) else x for x in out]


# ---------------------------------------------------------------- runtime values
class Arr:
    __slots__ = ("v",)

    def __init__(self, v):
        self.v = v


class Obj:
    def __init__(self, kind, oid, attrs):
        self.kind, self.id, self.a = kind, oid, attrs


class PineError(Exception):
    pass


class Brk(Exception):
    pass


class Cont(Exception):
    pass


def is_na(x):
    return x is None or (isinstance(x, float) and math.isnan(x))


def fmt_num(x, f=None):
    if is_na(x):
        return "NaN"
    if f is None:
        if isinstance(x, bool):
            return "true" if x else "false"
        if isinstance(x, int):
            return str(x)
        if float(x).is_integer():
            return str(int(x))
        s = f"{x:.8f}".rstrip("0").rstrip(".")
        return s
    if f == "mintick":
        return f"{Decimal(repr(float(x))).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"
    m = re.fullmatch(r"0(?:\.(0*)(#*))?", f)
    if not m:
        raise PineError(f"format {f!r} not modelled")
    nz_, nh = len(m.group(1) or ""), len(m.group(2) or "")
    q = Decimal(repr(float(x))).quantize(Decimal(1).scaleb(-(nz_ + nh)), rounding=ROUND_HALF_UP)
    s = f"{q:f}"
    if nh:
        whole, _, frac = s.partition(".")
        frac = frac.rstrip("0")
        frac = frac + "0" * max(0, nz_ - len(frac))
        s = whole + ("." + frac if frac else "")
    return s


CONSTS = {}
for _n in ("top_right middle_right bottom_right top_left middle_left bottom_left top_center bottom_center middle_center").split():
    CONSTS["position." + _n] = "position." + _n
for _n in ("tiny small normal large huge auto").split():
    CONSTS["size." + _n] = _n
for _n in ("align_left align_right align_center align_top align_bottom").split():
    CONSTS["text." + _n] = "text." + _n
for _n in ("style_solid style_dotted style_dashed style_label_left style_label_down style_none").split():
    CONSTS["line." + _n] = "style:" + _n
    CONSTS["label." + _n] = "style:" + _n
CONSTS["font.family_monospace"] = "monospace"
CONSTS["format.mintick"] = "mintick"
CONSTS["barmerge.lookahead_on"] = "lookahead_on"
CONSTS["barmerge.lookahead_off"] = "lookahead_off"
CONSTS["color.gray"] = (120, 123, 134, 0)
CONSTS["color.white"] = (255, 255, 255, 0)
CONSTS["color.black"] = (54, 58, 69, 0)
CONSTS["color.red"] = (242, 54, 69, 0)

SIG = {  # positional parameter names of the drawing constructors / table.cell
    "line.new": ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width"],
    "label.new": ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip"],
    "box.new": ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text",
                "text_size", "text_color", "text_halign", "text_valign"],
    "table.cell": ["table_id", "column", "row", "text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip"],
    "table.new": ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width"],
}
SETTERS = {
    "line.set_xy1": ("x1", "y1"), "line.set_xy2": ("x2", "y2"), "line.set_color": ("color",), "line.set_style": ("style",), "line.set_width": ("width",),
    "label.set_xy": ("x", "y"), "label.set_text": ("text",), "label.set_color": ("color",), "label.set_textcolor": ("textcolor",),
    "label.set_tooltip": ("tooltip",), "label.set_size": ("size",), "label.set_style": ("style",),
    "box.set_lefttop": ("left", "top"), "box.set_rightbottom": ("right", "bottom"), "box.set_bgcolor": ("bgcolor",),
    "box.set_text_color": ("text_color",), "box.set_text": ("text",), "box.set_border_color": ("border_color",),
}


class Scope:
    __slots__ = ("v", "up")

    def __init__(self, up=None):
        self.v, self.up = {}, up

    def find(self, n):
        s = self
        while s is not None:
            if n in s.v:
                return s
            s = s.up
        return None


class Interp:
    def __init__(self, src_text, env):
        self.L = src_text.split("\n")
        self.env = env                     # mocked engine globals, inputs, hist, requests, probes
        self.funcs = {}
        self.objs = []                     # every drawing object in creation order
        self.tables = {}
        self.barcolor = "unset"
        self.varstore = {}                 # function-local var / varip (once per site)
        self.probes = env.get("probes", {})   # {source line text substring: [names]} -> records
        self.records = []
        self.steps = 0
        lines = logical_lines(self.L)
        for ln, ind, txt in lines:
            if ind == 0 and re.match(r"^[A-Za-z_]\w*\([^)]*\)\s*=>", txt):
                pass
        # register every top-level function definition of the file
        i = 0
        while i < len(lines):
            ln, ind, txt = lines[i]
            if ind == 0 and re.match(r"^[A-Za-z_]\w*\(.*\)\s*=>", txt):
                st = parse_stmt(ln, txt)
                if st[4] is None:
                    j = i + 1
                    while j < len(lines) and lines[j][1] > 0:
                        j += 1
                    body, _ = build_block(lines, i + 1, lines[i + 1][1]) if j > i + 1 else ([], 0)
                    self.funcs[st[2]] = (st[3], group_ifs(body), ln)
                    i = j
                    continue
                self.funcs[st[2]] = (st[3], st[4], ln)
            i += 1
        self.g = Scope()
        for k, v in env.get("globals", {}).items():
            self.g.v[k] = v

    # ------------------------------------------------------------ running global code
    def run_range(self, lo_pat, hi_pat):
        lo = next(i for i, l in enumerate(self.L) if re.match(lo_pat, l))
        hi = next((i for i, l in enumerate(self.L) if i > lo and re.match(hi_pat, l)), len(self.L)) if hi_pat else len(self.L)
        lines = [x for x in logical_lines(self.L, lo, hi)]
        stmts, i, out = [], 0, []
        while i < len(lines):
            ln, ind, txt = lines[i]
            if ind == 0 and re.match(r"^[A-Za-z_]\w*\(.*\)\s*=>", txt):
                i += 1
                while i < len(lines) and lines[i][1] > 0:
                    i += 1
                continue
            j = i + 1
            while j < len(lines) and lines[j][1] > 0:
                j += 1
            blk, _ = build_block(lines[i:j], 0, 0)
            out += blk
            i = j
        self.exec_block(group_ifs(out), self.g, None)

    # ------------------------------------------------------------ statements
    def exec_block(self, stmts, sc, fn):
        last = None
        for st in stmts:
            last = self.exec_stmt(st, sc, fn)
        return last

    def exec_stmt(self, st, sc, fn):
        self.steps += 1
        if self.steps > 5_000_000:
            raise PineError("step limit")
        k = st[0]
        if k == "decl":
            _, ln, name, e, mode = st
            if mode in ("var", "varip"):
                key = (fn, name, ln)
                if fn is not None:
                    if key not in self.varstore:
                        self.varstore[key] = self.ev(e, sc)
                    sc.v[name] = self.varstore[key]
                    sc.v.setdefault("__varkeys__", {})[name] = key
                    return None
                # one bar (the first is the last): a global var / varip starts from its initial value, or from a given state
                sc.v[name] = self.env["var_override"][name] if name in self.env.get("var_override", {}) else self.ev(e, sc)
                return None
            if e[0] == "call" and e[1] == "request.security_lower_tf":
                key = (self.ev(e[2][1], sc), e[2][2][1])         # (timeframe, the requested series' name)
                sc.v[name] = Arr(list(self.env.get("ltf", {}).get(key, [])))
                return None
            if e[0] == "call" and e[1].startswith("request."):
                sc.v[name] = self.env["req"][name]
                return None
            if e[0] == "call" and e[1].startswith("input."):
                sc.v[name] = self.env.get("inputs", {}).get(name, self.ev(e[2][0], sc))
                return None
            sc.v[name] = self.ev(e, sc)
            return None
        if k == "tdecl":
            _, ln, names, e = st
            if e[0] == "call" and e[1].startswith("request."):
                for n in names:
                    sc.v[n] = self.env["req"][n]
                return None
            v = self.ev(e, sc)
            if not isinstance(v, tuple) or len(v) != len(names):
                raise PineError(f"line {ln}: tuple arity")
            for n, x in zip(names, v):
                sc.v[n] = x
            return None
        if k == "assign":
            _, ln, name, op, e = st
            s = sc.find(name)
            if s is None:
                raise PineError(f"line {ln}: assign to undeclared {name}")
            v = self.ev(e, sc)
            if op == ":=":
                nv = v
            else:
                cur = s.v[name]
                nv = self.arith(op[0], cur, v)
            s.v[name] = nv
            vk = s.v.get("__varkeys__", {}).get(name)
            if vk:
                self.varstore[vk] = nv
            return None
        if k == "ifc":
            _, ln, arms, els = st
            for cond, body in arms:
                c = self.ev(cond, sc)
                self.probe(ln, sc)
                if self.truth(c):
                    return self.exec_block(body, Scope(sc), fn)
            if els is not None:
                return self.exec_block(els, Scope(sc), fn)
            return None
        if k == "for":
            _, ln, var, a, b, body = st
            a, b = self.ev(a, sc), self.ev(b, sc)
            if is_na(a) or is_na(b):
                return None
            a, b = int(a), int(b)
            rng = range(a, b + 1) if a <= b else range(a, b - 1, -1)
            for i in rng:
                inner = Scope(sc)
                inner.v[var] = i
                try:
                    self.exec_block(body, inner, fn)
                except Brk:
                    break
                except Cont:
                    continue
            return None
        if k == "while":
            _, ln, cond, body = st
            n = 0
            while self.truth(self.ev(cond, sc)):
                n += 1
                if n > 100000:
                    raise PineError(f"line {ln}: while runaway")
                try:
                    self.exec_block(body, Scope(sc), fn)
                except Brk:
                    break
                except Cont:
                    continue
            return None
        if k == "break":
            raise Brk()
        if k == "continue":
            raise Cont()
        if k == "expr":
            return self.ev(st[2], sc)
        if k == "def":
            return None
        raise PineError(f"statement {k} not modelled")

    def probe(self, ln, sc):
        txt = self.L[ln - 1]
        for key, names in self.probes.items():
            if key in txt:
                rec = {"probe": key}
                for n in names:
                    s = sc.find(n)
                    rec[n] = s.v[n] if s else "?"
                self.records.append(rec)

    # ------------------------------------------------------------ expressions
    @staticmethod
    def truth(v):
        return bool(v) and not is_na(v)

    def arith(self, op, a, b):
        if op == "+" and (isinstance(a, str) or isinstance(b, str)):
            if is_na(a) or is_na(b):
                raise PineError("string + na")
            return a + b
        if is_na(a) or is_na(b):
            return None
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            if b == 0:
                return None
            return a / b
        if op == "%":
            if b == 0:
                return None
            r = math.fmod(a, b)
            return int(r) if isinstance(a, int) and isinstance(b, int) else r
        raise PineError(op)

    def ev(self, e, sc):
        k = e[0]
        if k == "lit":
            return e[1]
        if k == "name":
            n = e[1]
            s = sc.find(n)
            if s is not None:
                return s.v[n]
            if n in CONSTS:
                return CONSTS[n]
            if n == "na":
                return None
            if n in self.env.get("builtins", {}):
                return self.env["builtins"][n]
            raise PineError(f"undefined name {n}")
        if k == "tern":
            return self.ev(e[2], sc) if self.truth(self.ev(e[1], sc)) else self.ev(e[3], sc)
        if k == "not":
            return not self.truth(self.ev(e[1], sc))
        if k == "neg":
            v = self.ev(e[1], sc)
            return None if is_na(v) else -v
        if k == "bin":
            op = e[1]
            a, b = self.ev(e[2], sc), self.ev(e[3], sc)       # both sides, always (v5 and / or)
            if op == "and":
                return self.truth(a) and self.truth(b)
            if op == "or":
                return self.truth(a) or self.truth(b)
            if op in ("==", "!="):
                if is_na(a) or is_na(b):
                    return False                                  # any comparison with na is false
                return (a == b) if op == "==" else (a != b)
            if op in ("<", ">", "<=", ">="):
                if is_na(a) or is_na(b):
                    return False
                return {"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]
            return self.arith(op, a, b)
        if k == "tuple":
            return tuple(self.ev(x, sc) for x in e[1])
        if k == "hist":
            base, off = e[1], self.ev(e[2], sc)
            if base[0] != "name":
                raise PineError("history of an expression")
            key = (base[1], int(off))
            if off == 0:
                return self.ev(base, sc)
            return self.env.get("hist", {}).get(key)
        if k == "call":
            return self.call(e[1], e[2], e[3], sc)
        raise PineError(f"expr {k}")

    # ------------------------------------------------------------ calls
    def new_obj(self, kind, fname, args, kw, sc):
        a = {"kind": kind}
        sig = SIG[fname]
        for i, x in enumerate(args):
            a[sig[i]] = self.ev(x, sc)
        for kk, x in kw.items():
            a[kk] = self.ev(x, sc)
        o = Obj(kind, len(self.objs), a)
        self.objs.append(o)
        return o

    def call(self, f, args, kw, sc):
        if f in self.funcs:
            params, body, ln = self.funcs[f]
            vals = [self.ev(x, sc) for x in args]
            fs = Scope(self.g)
            for p_, v in zip(params, vals):
                fs.v[p_] = v
            if isinstance(body, list):
                return self.exec_block(body, fs, f)
            return self.ev(body, fs)
        E = lambda i: self.ev(args[i], sc)
        if f in ("na",):
            return is_na(E(0))
        if f == "nz":
            v = E(0)
            return (E(1) if len(args) > 1 else 0) if is_na(v) else v
        if f in ("math.max", "math.min"):
            vs = [self.ev(x, sc) for x in args]
            if any(is_na(v) for v in vs):
                return None
            return max(vs) if f == "math.max" else min(vs)
        if f == "math.abs":
            v = E(0); return None if is_na(v) else abs(v)
        if f in ("math.floor", "math.ceil", "math.round"):
            v = E(0)
            if is_na(v):
                return None
            return int(math.floor(v)) if f == "math.floor" else int(math.ceil(v)) if f == "math.ceil" else int(Decimal(repr(float(v))).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        if f == "math.exp":
            v = E(0); return None if is_na(v) else math.exp(v)
        if f == "str.tostring":
            v = E(0)
            fm = E(1) if len(args) > 1 else None
            return fmt_num(v, fm)
        if f == "str.length":
            return len(E(0))
        if f == "str.substring":
            s, a = E(0), E(1)
            b = E(2) if len(args) > 2 else len(s)
            if not (0 <= a <= len(s)) or not (a <= b <= len(s)):
                raise PineError(f"str.substring({s!r}, {a}, {b}) out of range")
            return s[a:b]
        if f == "str.split":
            return Arr(E(0).split(E(1)))
        if f == "str.trim":
            return E(0).strip()
        if f == "color.new":
            c, t = E(0), E(1)
            return (c[0], c[1], c[2], t)
        if f in ("color.r", "color.g", "color.b"):
            return E(0)["rgb".index(f[-1])]
        if f.startswith("array.new_"):
            n = E(0) if args else 0
            init = E(1) if len(args) > 1 else None
            return Arr([init] * int(n))
        if f == "array.from":
            return Arr([self.ev(x, sc) for x in args])
        if f == "array.size":
            return len(E(0).v)
        if f in ("array.get", "array.set", "array.insert"):
            A, i = E(0), E(1)
            if is_na(i) or not (0 <= i < len(A.v) or (f == "array.insert" and i == len(A.v))):
                raise PineError(f"{f} index {i} out of bounds (size {len(A.v)})")
            if f == "array.get":
                return A.v[i]
            if f == "array.set":
                A.v[i] = E(2); return None
            A.v.insert(i, E(2)); return None
        if f == "array.push":
            E(0).v.append(E(1)); return None
        if f == "array.pop":
            A = E(0)
            if not A.v:
                raise PineError("array.pop on empty")
            return A.v.pop()
        if f == "array.clear":
            E(0).v.clear(); return None
        if f == "line.new":
            return self.new_obj("line", f, args, kw, sc)
        if f == "label.new":
            return self.new_obj("label", f, args, kw, sc)
        if f == "box.new":
            return self.new_obj("box", f, args, kw, sc)
        if f in SETTERS:
            o = E(0)
            if not isinstance(o, Obj):
                raise PineError(f"{f} on {o!r}")
            for i, at in enumerate(SETTERS[f]):
                o.a[at] = E(i + 1)
            return None
        if f == "table.new":
            t = {"cells": {}, "args": [self.ev(x, sc) for x in args], "kw": {k2: self.ev(v, sc) for k2, v in kw.items()}}
            tid = len(self.tables)
            self.tables[tid] = t
            return ("table", tid)
        if f == "table.cell":
            t = self.tables[E(0)[1]]
            cell = {}
            sig = SIG[f]
            for i, x in enumerate(args):
                cell[sig[i]] = self.ev(x, sc)
            for kk, x in kw.items():
                cell[kk] = self.ev(x, sc)
            cell.setdefault("tooltip", None)
            t["cells"][(cell["column"], cell["row"])] = cell
            return None
        if f == "table.clear":
            t = self.tables[E(0)[1]]
            c0, r0 = E(1), E(2)
            c1 = E(3) if len(args) > 3 else c0
            r1 = E(4) if len(args) > 4 else r0
            for key in list(t["cells"]):
                if c0 <= key[0] <= c1 and r0 <= key[1] <= r1:
                    del t["cells"][key]
            return None
        if f == "barcolor":
            self.barcolor = E(0); return None
        if f in self.env.get("mockfns", {}):
            return self.env["mockfns"][f](self, args, kw, sc)
        raise PineError(f"call {f} not modelled")

    # ------------------------------------------------------------ the frame
    def frame(self):
        objs = [(o.kind, o.id, tuple(sorted((k, repr(v)) for k, v in o.a.items()))) for o in self.objs]
        tabs = {tid: tuple(sorted((k, tuple(sorted((a, repr(b)) for a, b in c.items()))) for k, c in t["cells"].items())) for tid, t in self.tables.items()}
        return {"objs": objs, "tables": tabs, "barcolor": repr(self.barcolor)}
