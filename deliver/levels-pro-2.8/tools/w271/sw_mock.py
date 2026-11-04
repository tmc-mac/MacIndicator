"""v2.7.1: give the mocked engine state the two section-P4 arrays (SW_ON / SW_T) as of the last CLOSED bar, gap-free."""
def install(ps):
    P = ps.pinei
    orig = ps.make_state
    def make_state(*a, **k):
        env = orig(*a, **k)
        G, B = env["globals"], env["builtins"]
        xa, xd, fa = G["XAGE"].v, G["XDIR"].v, G["FAILAGE"].v
        secs = ps.TF_SECS(env) if hasattr(ps, "TF_SECS") else 900
        tc = B.get("time_close")
        on, t = [], []
        for i in range(len(xa)):
            on.append(bool(xd[i] != 0 and xa[i] < G["confirm_bars"] and fa[i] != xa[i] + 1))
            t.append(None if tc is None or xa[i] >= 9999 else tc - xa[i] * secs * 1000)
        G["SW_ON"], G["SW_T"] = P.Arr(on), P.Arr(t)
        return env
    ps.make_state = make_state
