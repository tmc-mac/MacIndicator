#!/usr/bin/env python3
"""TIDE r1.2 SETUP LOG (fidelity check, not a P&L study). stdlib only; run: nice -n 19 python3 -I tide_setups.py DATADIR OUTDIR

Causal minute walk. Every 1m close T is a decision reading:
  price = 1m close; score15 / score30 = our Levels PRO board bias score (biasScore) on the FORMING 15m / 30m candle
  (port of bot-np1 r13.3.7 lib/levelsPro.js evaluateLevelsPro, see LevelsPro below; line refs are to that file).
Rules = SPEC-TIDE-r1 + addenda r1.1, r1.2 and the r1.2 confirmation (see RESULTS.md header for interpretations).
"""
import copy, csv, math, json, os, sys, bisect, datetime as D
from zoneinfo import ZoneInfo

PT = ZoneInfo('America/Los_Angeles')
TICK = 0.25
DEFAULT = dict(trapMinPts=5, retestTolPts=6, maxPokePts=12, closeBelowTicks=1, defenseBars=1,
               maxEntryFromLevelPts=25, stopBufferPts=2, controlLine=0.15)   # r1.3: stop buffer = lib/levelEvent.js:33 STOP_BUF = 2; no 8/60 clamp/skip
RISK_CAP, PT_VALUE, MAX_CONTRACTS = 375.0, 2.0, 3   # r1.3 sizing: riskRules.sizeForRisk (slipPts 0 assumed), minContracts off
TIDE_LEVELS = ['4H Open', 'PDH', 'PDL', 'London High', 'London Low', 'Asia High', 'Asia Low', '1H Open']
RANK = {'4H Open': 0, 'PDH': 1, 'PDL': 1, 'London High': 2, 'London Low': 2, 'Asia High': 3, 'Asia Low': 3, '1H Open': 4}

# ---------------------------------------------------------------- time helpers (helpers.js ptInfo :153-172)
_ptc = {}
def ptinfo(t):
    r = _ptc.get(t)
    if r is None:
        d = D.datetime.fromtimestamp(t, PT)
        m = d.hour * 60 + d.minute
        r = (d.strftime('%Y-%m-%d'), m, m >= 900, m < 390, m == 390, m == 900, 390 <= m < 450)
        _ptc[t] = r   # dateStr, minutesOfDay, isAsia, isLondon, is0630, is1500, isIB
    return r

def cme_day_key(pti):   # levelsPro.js :56-60
    ds, m = pti[0], pti[1]
    if m < 900:
        return ds
    y, mo, d = map(int, ds.split('-'))
    return (D.date(y, mo, d) + D.timedelta(days=1)).isoformat()

def crossed_into_0630(pti, prev):   # levelsPro.js :37-39
    return pti[1] >= 390 and (prev is None or prev[0] != pti[0] or prev[1] < 390)

def fmt(t, f='%m-%d %H:%M'):
    return D.datetime.fromtimestamp(t, PT).strftime(f)

def clamp(v, lo, hi):
    return max(min(v, hi), lo)

def agg(bars):
    return dict(t=bars[0]['t'], o=bars[0]['o'], h=max(b['h'] for b in bars), l=min(b['l'] for b in bars),
                c=bars[-1]['c'], v=sum(b['v'] for b in bars))

# ---------------------------------------------------------------- Levels PRO port (board bias score only)
LEVEL_DEFS = [  # levelsPro.js :63-84 (name, importance, rolling, periodMin)
    ('PDH', 3.0, False, 0), ('PDL', 3.0, False, 0), ('PDC', 2.5, False, 0), ('Daily Open', 2.0, False, 0),
    ('Asia High', 2.5, False, 0), ('Asia Low', 2.5, False, 0), ('London High', 2.5, False, 0), ('London Low', 2.5, False, 0),
    ('06:30 Open', 3.0, False, 0), ('15:00 Open', 2.5, False, 0), ('IB High', 2.0, False, 0), ('IB Low', 2.0, False, 0),
    ('VWAP', 3.0, False, 0), ('4H Open', 3.0, True, 240), ('1H Open', 2.5, True, 60), ('30m Open', 2.0, True, 30),
    ('15m Open', 1.5, True, 15), ('PWH', 3.5, True, 10080), ('PWL', 3.5, True, 10080), ('Week Open', 3.0, True, 10080)]
NL = len(LEVEL_DEFS)
CFG = dict(stMin=60, ltMin=360, wHold=0.35, wPush=0.40, wFlow=0.25, distantAtr=1.5, bandMult=0.25)   # :131-134 defaults


class LevelsPro:
    """Incremental port of evaluateLevelsPro (sessionAnchor 'cme', vwapBuild '5m', levelsParity 'off' = shipped defaults,
    live-executor.js :1128 / :1132 / :1160 / :2013-2015). Only what feeds biasScore (:421-429) is ported: level registry (:111-161),
    roll resets (:179-196), PUSH/FLOW EMAs (:198-218), per-level hold/delta/defense/inband (:244-260), composite score (:300-336)."""

    def __init__(self, tf_sec):
        self.tf = tf_sec
        tfMin = tf_sec / 60
        self.stBars = max(round(CFG['stMin'] / tfMin), 3)
        self.ltBars = max(round(CFG['ltMin'] / tfMin), 10)
        self.aSt = 2.0 / (self.stBars + 1)
        self.aLt = 2.0 / (self.ltBars + 1)
        self.on = [(not r) or pm > tfMin for (_, _, r, pm) in LEVEL_DEFS]   # :166 hide_sub (dedupeLevels off)
        self.S = dict(dayHi=None, dayLo=None, pdh=None, pdl=None, pdc=None, dayOpen=None,
                      asiaHiL=None, asiaLoL=None, asiaHiK=None, asiaLoK=None, lonHiL=None, lonLoL=None, lonHiK=None, lonLoK=None,
                      o0630=None, o1500=None, ibHiL=None, ibLoL=None, ibHi=None, ibLo=None, vwPV=0.0, vwVol=0.0,
                      momStE=0.0, momLtE=0.0, flwStE=0.0, flwLtE=0.0, prevKey=None, prevAsia=None, prevLon=None, prevPt=None,
                      prevC=None, vols=[],
                      lv=[dict(holdSt=0.0, holdLt=0.0, dlt=0.0, df=0.0, inband=False, lLast=None, lastOpen=None) for _ in range(NL)])

    def step(self, bar, ctx, commit):
        S = self.S if commit else copy.deepcopy(self.S)
        pti = ptinfo(bar['t'])
        key = cme_day_key(pti)
        newDay = S['prevKey'] is not None and key != S['prevKey']
        isAsia, isLon = pti[2], pti[3]
        asiaStart = isAsia and S['prevAsia'] is False
        asiaEnd = (not isAsia) and S['prevAsia'] is True
        lonStart = isLon and S['prevLon'] is False
        lonEnd = (not isLon) and S['prevLon'] is True
        atrRef = ctx['atrRef']
        band = atrRef * CFG['bandMult']
        # :114-116
        if S['dayHi'] is None:
            S['dayHi'], S['dayLo'], S['dayOpen'] = bar['h'], bar['l'], bar['o']
        if newDay:
            S['pdh'], S['pdl'] = S['dayHi'], S['dayLo']
            S['pdc'] = S['prevC'] if S['prevC'] is not None else bar['c']
            S['dayHi'], S['dayLo'], S['dayOpen'] = bar['h'], bar['l'], bar['o']
        else:
            S['dayHi'] = max(S['dayHi'], bar['h']); S['dayLo'] = min(S['dayLo'], bar['l'])
        # :118-126
        if asiaStart:
            S['asiaHiL'], S['asiaLoL'] = bar['h'], bar['l']
        if isAsia:
            S['asiaHiL'] = bar['h'] if S['asiaHiL'] is None else max(S['asiaHiL'], bar['h'])
            S['asiaLoL'] = bar['l'] if S['asiaLoL'] is None else min(S['asiaLoL'], bar['l'])
        if asiaEnd and S['asiaHiL'] is not None:
            S['asiaHiK'], S['asiaLoK'] = S['asiaHiL'], S['asiaLoL']
        asiaHi = S['asiaHiL'] if isAsia else S['asiaHiK']
        asiaLo = S['asiaLoL'] if isAsia else S['asiaLoK']
        if lonStart:
            S['lonHiL'], S['lonLoL'] = bar['h'], bar['l']
        if isLon:
            S['lonHiL'] = bar['h'] if S['lonHiL'] is None else max(S['lonHiL'], bar['h'])
            S['lonLoL'] = bar['l'] if S['lonLoL'] is None else min(S['lonLoL'], bar['l'])
        if lonEnd and S['lonHiL'] is not None:
            S['lonHiK'], S['lonLoK'] = S['lonHiL'], S['lonLoL']
        lonHi = S['lonHiL'] if isLon else S['lonHiK']
        lonLo = S['lonLoL'] if isLon else S['lonLoK']
        if pti[4]: S['o0630'] = bar['o']
        if pti[5]: S['o1500'] = bar['o']
        if newDay: S['ibHiL'] = S['ibLoL'] = S['ibHi'] = S['ibLo'] = None
        if pti[6]:
            S['ibHiL'] = bar['h'] if S['ibHiL'] is None else max(S['ibHiL'], bar['h'])
            S['ibLoL'] = bar['l'] if S['ibLoL'] is None else min(S['ibLoL'], bar['l'])
            S['ibHi'], S['ibLo'] = S['ibHiL'], S['ibLoL']
        # chart VWAP (:134-136) and 5m VWAP override (:139-146, resolved by ctx)
        if crossed_into_0630(pti, S['prevPt']) or newDay:
            S['vwPV'] = 0.0; S['vwVol'] = 0.0
        if pti[1] >= 390:
            S['vwPV'] += (bar['h'] + bar['l'] + bar['c']) / 3 * bar['v']; S['vwVol'] += bar['v']
        vw = S['vwPV'] / S['vwVol'] if S['vwVol'] > 0 else None
        vsrc = 'chart'
        if ctx['vwap5'] is not None:
            ok, val = ctx['vwap5']
            if ok:
                vw, vsrc = val, '5m'
        px = [S['pdh'], S['pdl'], S['pdc'], S['dayOpen'], asiaHi, asiaLo, lonHi, lonLo, S['o0630'], S['o1500'], S['ibHi'], S['ibLo'],
              vw, ctx['h4o'], ctx['h1o'], ctx['h30o'], ctx['h15o'], ctx['pwh'], ctx['pwl'], ctx['wko']]
        rollIds = [None] * 13 + [ctx['h4id'], ctx['h1id'], ctx['h30id'], ctx['h15id'], ctx['wid'], ctx['wid'], ctx['wid']]
        LV = S['lv']
        for k in range(NL):   # :179-195
            if LEVEL_DEFS[k][2]:
                s = LV[k]
                rolled = s['lastOpen'] is not None and rollIds[k] is not None and rollIds[k] != s['lastOpen']
                if rolled or (px[k] is not None and s['lLast'] is None):
                    s.update(holdSt=0.0, holdLt=0.0, dlt=0.0, df=0.0, inband=False)
                s['lLast'] = px[k]; s['lastOpen'] = rollIds[k]
        # :199-218
        rng = max(bar['h'] - bar['l'], 0.0001)
        buyV = bar['v'] * (bar['c'] - bar['l']) / rng
        sellV = bar['v'] * (bar['h'] - bar['c']) / rng
        deltaN = (buyV - sellV) / bar['v'] if bar['v'] > 0 else 0.0
        win = S['vols'][-19:] + [bar['v']]
        volAvg = sum(win) / len(win)
        volW = min(bar['v'] / volAvg, 3.0) if volAvg > 0 else 1.0
        momRaw = (bar['c'] - (S['prevC'] if S['prevC'] is not None else bar['c'])) / atrRef
        aSt, aLt = self.aSt, self.aLt
        S['momStE'] = S['momStE'] * (1 - aSt) + momRaw * aSt
        S['momLtE'] = S['momLtE'] * (1 - aLt) + momRaw * aLt
        S['flwStE'] = S['flwStE'] * (1 - aSt) + deltaN * aSt
        S['flwLtE'] = S['flwLtE'] * (1 - aLt) + deltaN * aLt
        pushSt = clamp(S['momStE'] * self.stBars * 0.50, -1, 1)
        pushLt = clamp(S['momLtE'] * self.ltBars * 0.35, -1, 1)
        flowSt = clamp(S['flwStE'] * 2.5, -1, 1)
        flowLt = clamp(S['flwLtE'] * 2.5, -1, 1)
        wsumC = max(CFG['wHold'] + CFG['wPush'] + CFG['wFlow'], 0.01)
        bnum = bden = 0.0
        for k in range(NL):
            p, s = px[k], LV[k]
            if p is None:   # :246-248
                s['holdSt'] *= 0.95; s['holdLt'] *= 0.98; s['dlt'] *= 0.95; s['df'] *= 0.98
                continue
            inc = (1 if bar['c'] > p else -1) * volW   # :250-260
            s['holdSt'] = s['holdSt'] * (1 - aSt) + inc * aSt
            s['holdLt'] = s['holdLt'] * (1 - aLt) + inc * aLt
            atLvl = bar['l'] <= p + band and bar['h'] >= p - band
            if atLvl: s['dlt'] = s['dlt'] * (1 - aSt) + deltaN * aSt
            else: s['dlt'] *= 0.995
            s['inband'] = atLvl
            bdef = bar['l'] < p and bar['c'] > p and bar['o'] >= p
            sdef = bar['h'] > p and bar['c'] < p and bar['o'] <= p
            s['df'] = clamp(s['df'] * 0.99 + (1 if bdef else 0) - (1 if sdef else 0), -3, 3)
            # composite :304-332
            distA = abs(bar['c'] - p) / atrRef
            distant = distA > CFG['distantAtr']
            hSt = clamp(s['holdSt'] / 1.5, -1, 1); hLt = clamp(s['holdLt'] / 1.5, -1, 1)
            dl = clamp(s['dlt'] * 2.0, -1, 1); df = clamp(s['df'] / 3.0, -1, 1)
            fEff = clamp((flowSt + dl) / 1.6, -1, 1) if s['inband'] else flowSt
            scSt = (CFG['wHold'] * hSt + CFG['wPush'] * pushSt + CFG['wFlow'] * fEff) / wsumC
            scLt = (CFG['wHold'] * hLt + CFG['wPush'] * pushLt + CFG['wFlow'] * flowLt) / wsumC
            raw = 0.55 * scSt + 0.25 * scLt + 0.12 * dl + 0.08 * df
            comp = raw * (max(0.25, CFG['distantAtr'] / distA) if distant else 1.0)
            if self.on[k]:   # :421-429
                w = LEVEL_DEFS[k][1] * (1.0 / (1.0 + abs(bar['c'] - p) / atrRef))
                bnum += comp * w; bden += w
        S['prevKey'] = key; S['prevAsia'] = isAsia; S['prevLon'] = isLon; S['prevPt'] = pti
        S['prevC'] = bar['c']; S['vols'] = win[-19:]
        return dict(score=bnum / bden if bden > 0 else 0.0, px=dict(zip([d[0] for d in LEVEL_DEFS], px)), vsrc=vsrc)


# ---------------------------------------------------------------- data + causal HTF context
def load(d, n):
    p = os.path.join(d, n + '.json')
    with open(p) as f:
        a = json.load(f)
    a.sort(key=lambda b: b['t'])
    return a


class Market:
    def __init__(self, ddir):
        self.m1 = load(ddir, 'm1'); self.m5 = load(ddir, 'm5'); self.m15 = load(ddir, 'm15'); self.m30 = load(ddir, 'm30')
        self.h1 = load(ddir, 'h1'); self.h4 = load(ddir, 'h4'); self.d1 = load(ddir, 'd1')
        self.m1t = [b['t'] for b in self.m1]
        self.m1i = {b['t']: i for i, b in enumerate(self.m1)}
        self.m1_first, self.m1_end = self.m1[0]['t'], self.m1[-1]['t'] + 60
        for n in ('m5', 'm15', 'm30', 'h1', 'h4'):
            setattr(self, n + 't', [b['t'] for b in getattr(self, n)])
        # weekly bars synthesised from d1 (APPROXIMATION: no provider W series in the data; week = TradeDays Mon-Fri, bar t = first d1 t)
        wk = {}
        for b in self.d1:
            td = D.date.fromisoformat(cme_day_key(ptinfo(b['t'])))
            k = td.isocalendar()[:2]
            if k not in wk: wk[k] = dict(t=b['t'], o=b['o'], h=b['h'], l=b['l'], c=b['c'], v=b['v'])
            else:
                w = wk[k]; w['h'] = max(w['h'], b['h']); w['l'] = min(w['l'], b['l']); w['c'] = b['c']
        self.w = [wk[k] for k in sorted(wk)]; self.wt = [b['t'] for b in self.w]
        # H1 ATR(14) Wilder (:21-24) on closed provider bars
        self.h1atr = []
        prev = None; trs = []
        for i, b in enumerate(self.h1):
            tr = b['h'] - b['l'] if i == 0 else max(b['h'] - b['l'], abs(b['h'] - self.h1[i - 1]['c']), abs(b['l'] - self.h1[i - 1]['c']))
            trs.append(tr)
            if i < 13: self.h1atr.append(None); continue
            prev = sum(trs[i - 13:i + 1]) / 14 if prev is None else (prev * 13 + tr) / 14
            self.h1atr.append(prev)
        # 5m VWAP states (vwapFromBars :44-54)
        self.v5 = []
        st = (0.0, 0.0, None, None, False)
        for b in self.m5:
            st = self.vwap_step(st, b); self.v5.append(st)

    @staticmethod
    def vwap_step(st, b):
        pv, vol, pkey, ppt, comp = st
        pti = ptinfo(b['t']); key = cme_day_key(pti)
        newDay = pkey is not None and key != pkey
        if (ppt is not None and crossed_into_0630(pti, ppt)) or newDay:
            pv, vol, comp = 0.0, 0.0, True
        if pti[1] >= 390:
            pv += (b['h'] + b['l'] + b['c']) / 3 * b['v']; vol += b['v']
        return (pv, vol, key, pti, comp)

    def m1_range(self, a, b):
        i = bisect.bisect_left(self.m1t, a); j = bisect.bisect_left(self.m1t, b)
        return self.m1[i:j]

    def bar_asof(self, name, tf, start, T):
        """The bar of series `name` starting at `start` as known at time T (partial from 1m when still forming)."""
        if start + tf <= T or not (self.m1_first <= start < self.m1_end):
            arr, ts = getattr(self, name), getattr(self, name + 't')
            i = bisect.bisect_left(ts, start)
            if i < len(ts) and ts[i] == start: return arr[i]
            return None
        bs = self.m1_range(start, T)
        return agg(bs) if bs else None

    def last_le(self, name, t):
        ts = getattr(self, name + 't'); i = bisect.bisect_right(ts, t) - 1
        return i

    def ctx(self, row_t, tf, T):
        c = {}
        for nm, key in (('h4', 'h4'), ('h1', 'h1'), ('m30', 'h30'), ('m15', 'h15')):
            i = self.last_le(nm, row_t)
            arr = getattr(self, nm)
            c[key + 'o'] = arr[i]['o'] if i >= 0 else None
            c[key + 'id'] = arr[i]['t'] if i >= 0 else None
        # ATR ref: H1 bar containing the row, as known at T (:105-108)
        i = self.last_le('h1', row_t); atr = None
        if i >= 0:
            hb = self.h1[i]
            if hb['t'] + 3600 > T and self.m1_first <= hb['t'] < self.m1_end:
                part = self.bar_asof('h1', 3600, hb['t'], T)
                pc = self.h1[i - 1]['c']
                tr = max(part['h'] - part['l'], abs(part['h'] - pc), abs(part['l'] - pc))
                atr = (self.h1atr[i - 1] * 13 + tr) / 14 if self.h1atr[i - 1] is not None else None
            else:
                atr = self.h1atr[i]
        c['atrRef'] = max(atr if atr is not None else 0, 0.05) or 0.05
        wi = self.last_le('w', row_t)
        c['wid'] = self.w[wi]['t'] if wi >= 0 else None
        c['wko'] = self.w[wi]['o'] if wi >= 0 else None
        c['pwh'] = self.w[wi - 1]['h'] if wi > 0 else None
        c['pwl'] = self.w[wi - 1]['l'] if wi > 0 else None
        # 5m VWAP through the last 5m bar that ends by the row end and has started by T (:139-146; forming 5m bar = partial)
        endT = row_t + tf
        lastT = None
        cand = min(endT - 300, ((T - 1) // 300) * 300)
        if cand >= row_t:
            lastT = cand
        if lastT is None:
            c['vwap5'] = (False, None)
        else:
            k = bisect.bisect_left(self.m5t, lastT)
            if lastT + 300 <= T and k < len(self.m5t) and self.m5t[k] == lastT:
                st = self.v5[k]
            else:
                part = self.bar_asof('m5', 300, lastT, T)
                if part is None:
                    c['vwap5'] = (False, None); return c
                st = self.vwap_step(self.v5[k - 1] if k > 0 else (0.0, 0.0, None, None, False), part)
            pv, vol, _, _, comp = st
            c['vwap5'] = (True, pv / vol if vol > 0 else None) if comp else (False, None)
        return c


# ---------------------------------------------------------------- readings (forming 15m / 30m bias score at every 1m close)
def build_readings(mk, study_start):
    lp = {900: LevelsPro(900), 1800: LevelsPro(1800)}
    chart = {900: mk.m15, 1800: mk.m30}
    # warm-up: closed provider bars before the study window (last <= 2000 bars like historyRefreshLimit, live-executor.js :1479)
    for tf in (900, 1800):
        bars = [b for b in chart[tf] if b['t'] + tf <= study_start][-2000:]
        for b in bars:
            lp[tf].step(b, mk.ctx(b['t'], tf, b['t'] + tf), True)
    out = []
    for b1 in mk.m1:
        if b1['t'] < study_start: continue
        T = b1['t'] + 60
        rec = dict(t=T, c=b1['c'], h=b1['h'], l=b1['l'])
        for tf in (900, 1800):
            s0 = b1['t'] - b1['t'] % tf
            if T == s0 + tf:   # bar complete: reading = the closed provider bar, committed
                bar = mk.bar_asof('m15' if tf == 900 else 'm30', tf, s0, T)
                r = lp[tf].step(bar, mk.ctx(s0, tf, T), True)
            else:
                bar = agg(mk.m1_range(s0, T))
                r = lp[tf].step(bar, mk.ctx(s0, tf, T), False)
            rec['s%d' % (tf // 60)] = r['score']
            if tf == 900:
                rec['px'] = r['px']; rec['vsrc'] = r['vsrc']
        h4i = mk.last_le('h4', b1['t']); rec['h4t'] = mk.h4[h4i]['t']; rec['O4'] = mk.h4[h4i]['o']
        h1i = mk.last_le('h1', b1['t']); rec['O1'] = mk.h1[h1i]['o']
        pti = ptinfo(b1['t'])
        lv = {'4H Open': rec['O4'], '1H Open': rec['O1'], 'PDH': rec['px']['PDH'], 'PDL': rec['px']['PDL']}
        if not pti[2]:   # Asia levels only once the Asia session (15:00-24:00 PT) has ended (r1.1)
            lv['Asia High'] = rec['px']['Asia High']; lv['Asia Low'] = rec['px']['Asia Low']
        if not pti[3]:   # London levels only outside the London session (00:00-06:30 PT)
            lv['London High'] = rec['px']['London High']; lv['London Low'] = rec['px']['London Low']
        rec['lv'] = {k: v for k, v in lv.items() if v is not None}
        rec['td'] = cme_day_key(pti)
        out.append(rec)
    return out


# ---------------------------------------------------------------- TIDE rule engine
def run_tide(mk, R, cfg, log_detail=True):
    line = cfg['controlLine']; tol = 25 if cfg.get('fixes') else cfg['retestTolPts']; poke = cfg['maxPokePts']; cb = cfg['closeBelowTicks'] * TICK
    setups, near, ranaway, ctl_events = [], [], [], []
    periods = {}
    P = None
    prev_rec = None
    pending = None   # defense-2 candidate
    m5c_prev = None
    for idx, r in enumerate(R):
        T = r['t']
        if P is None or r['h4t'] != P['t']:
            if P is not None: finish_period(P, ranaway, setups)
            P = dict(t=r['h4t'], O4=r['O4'], hi=r['h'], lo=r['l'], ctl=None, buyAbove=False, sellBelow=False, ep={}, acc={}, crossed={}, events=[], td=r['td'], setups=0)
            periods[P['t']] = P
            pending = None
            prev_rec = None
        acc_before = {k: dict(v) for k, v in P['acc'].items()} if log_detail or True else None
        ctl_before = P['ctl']
        P['hi'] = max(P['hi'], r['h']); P['lo'] = min(P['lo'], r['l'])
        O4, px, s15, s30 = P['O4'], r['c'], r['s15'], r['s30']
        sell = [(tf, s) for tf, s in (('15m', s15), ('30m', s30)) if s <= -line]
        buy = [(tf, s) for tf, s in (('15m', s15), ('30m', s30)) if s >= line]
        # crossing memory per level (price traded at/above or at/below L in this period)
        for nm, L in r['lv'].items():
            c = P['crossed'].setdefault((nm, L), [False, False])
            if r['h'] >= L: c[0] = True
            if r['l'] <= L: c[1] = True
        # ---- 4H control (§1 as amended by r1.2)
        c = P['ctl']
        if c is not None:
            if c['kind'] == 'trap' and ((c['dir'] < 0 and r['h'] > c['trapX']) or (c['dir'] > 0 and r['l'] < c['trapX'])):
                P['events'].append((T, 'VOID', c['dir'], 'price %s trap extreme %.2f' % ('above' if c['dir'] < 0 else 'below', c['trapX'])))
                P['ctl'] = c = None
            elif not (cfg.get('fixes') and c['kind'] == 'trap') and ((c['dir'] < 0 and px > O4 and buy) or (c['dir'] > 0 and px < O4 and sell)):
                rd = buy if c['dir'] < 0 else sell
                P['events'].append((T, 'CANCEL', c['dir'], 'price %.2f %s O4 with %s' % (px, 'above' if c['dir'] < 0 else 'below', fmtrd(rd))))
                P['ctl'] = c = None
        if c is None:
            if px < O4 and sell:
                trap = (P['hi'] >= O4 + 25 or P['buyAbove']) if cfg.get('fixes') else P['hi'] >= O4 + cfg['trapMinPts']
                c = dict(dir=-1, kind='trap' if trap else 'below', trapX=P['hi'], at=T, rd=sell)
            elif px > O4 and buy:
                trap = (P['lo'] <= O4 - 25 or P['sellBelow']) if cfg.get('fixes') else P['lo'] <= O4 - cfg['trapMinPts']
                c = dict(dir=1, kind='trap' if trap else 'above', trapX=P['lo'], at=T, rd=buy)
            if c is not None:
                P['ctl'] = c
                P['events'].append((T, 'FORM', c['dir'], '%s %s, price %.2f, %s, %s %.2f' % (
                    'SELL' if c['dir'] < 0 else 'BUY', c['kind'], px, fmtrd(c['rd']),
                    'trapHigh' if c['dir'] < 0 else 'trapLow', c['trapX'])))
        # ---- level acceptance (r1.2): price beyond L + forming 15m/30m score on that side
        for nm, L in r['lv'].items():
            a = P['acc'].setdefault((nm, L), dict(s=None, l=None))
            if px < L and sell:
                a['s'] = (T, sell, P['crossed'][(nm, L)][0], P['ctl']['dir'] if P['ctl'] else 0)
                a.setdefault('s_first', a['s'])
            if px > L and buy:
                a['l'] = (T, buy, P['crossed'][(nm, L)][1], P['ctl']['dir'] if P['ctl'] else 0)
                a.setdefault('l_first', a['l'])
            if px > L and buy: a['s'] = None   # lost: back above with buyer control
            if px < L and sell: a['l'] = None
        # ---- 5m close decisions
        if cfg.get('defense1m'):   # PROPOSED-2 (a): 1m defense of a failed bounce
            ctl = P['ctl']
            cands = []
            for nm, L in r['lv'].items():
                for d in (-1, 1):
                    key = (nm, L, d)
                    ep = P['ep'].get(key)
                    if ep is not None:
                        trig = (r['c'] < ep['prev']) if d < 0 else (r['c'] > ep['prev'])
                        if trig:
                            P['ep'].pop(key)
                            if ep['ok'] and ctl is not None and ctl['dir'] == d:
                                close_ok = (r['c'] <= L - cb) if d < 0 else (r['c'] >= L + cb)
                                a = acc_before.get((nm, L), {}).get('s' if d < 0 else 'l')
                                if close_ok and a is not None:
                                    cands.append((RANK[nm], nm, L, a, ep, d))
                                elif log_detail:
                                    near.append(dict(t=T, td=P['td'], dir=d, level=nm, L=L, bar=dict(t=T - 60, h=r['h'], l=r['l'], c=r['c']),
                                                     why='1m defense: ' + ('close not back %s level' % ('below' if d < 0 else 'above') if not close_ok else 'no acceptance before')))
                            continue
                    side = (r['c'] < L) if d < 0 else (r['c'] > L)
                    inzone = side and ((r['h'] >= L - tol) if d < 0 else (r['l'] <= L + tol))
                    if inzone:
                        if ep is None:
                            ep = P['ep'][key] = dict(start=T - 60, ext=r['h'] if d < 0 else r['l'], lo=r['l'], hi=r['h'], ok=True)
                        else:
                            ep['ext'] = max(ep['ext'], r['h']) if d < 0 else min(ep['ext'], r['l'])
                            ep['lo'] = min(ep['lo'], r['l']); ep['hi'] = max(ep['hi'], r['h'])
                        ep['prev'] = r['l'] if d < 0 else r['h']
                        ep['ok'] = (ep['ext'] - L <= poke) if d < 0 else (L - ep['ext'] <= poke)
                    elif ep is not None:
                        P['ep'].pop(key)
            for d in (-1, 1):
                cd_ = sorted([c for c in cands if c[5] == d], key=lambda c: c[0])
                if cd_:
                    _, nm, L, a, ep, _ = cd_[0]
                    sb = dict(t=ep['start'], o=None, h=ep['ext'] if d < 0 else ep['hi'], l=ep['lo'] if d < 0 else ep['ext'], c=r['c'])
                    b1 = dict(t=T - 60, h=r['h'], l=r['l'], c=r['c'])
                    emit(mk, setups, near, P, dict(dir=d, nm=nm, L=L, acc=a, bar=sb, also=[c[1] for c in cd_[1:]]), b1, T, r['c'], cfg, r)
        if T % 300 == 0 and not cfg.get('defense1m'):
            b5 = mk.bar_asof('m5', 300, T - 300, T)
            ctl = P['ctl']
            if b5 is not None and b5['t'] >= P['t']:
                # defense-2 pending resolution
                if pending is not None:
                    d = pending['dir']; L = pending['L']
                    ok = (b5['c'] <= L - cb if d < 0 else b5['c'] >= L + cb) and (b5['h'] <= pending['bar']['h'] if d < 0 else b5['l'] >= pending['bar']['l'])
                    if ok and ctl is not None and ctl['dir'] == d:
                        emit(mk, setups, near, P, pending, b5, T, r['c'], cfg, r)
                    elif log_detail:
                        near.append(dict(t=T, td=P['td'], dir=d, level=pending['nm'], L=L, why='defense bar failed (%s)' % (
                            'close back through level' if not (b5['c'] <= L - cb if d < 0 else b5['c'] >= L + cb) else
                            'new extreme beyond retest bar' if ctl and ctl['dir'] == d else 'control lost'), bar=b5))
                    pending = None
                for d in (-1, 1):
                    cands, misses = [], []
                    for nm, L in r['lv'].items():
                        # was price coming from the control side? (previous 5m close / bar open on the control side of L)
                        hit = (b5['h'] >= L - tol) if d < 0 else (b5['l'] <= L + tol)
                        side_ok = (b5['o'] < L or (m5c_prev is not None and m5c_prev < L)) if d < 0 else (b5['o'] > L or (m5c_prev is not None and m5c_prev > L))
                        if not hit: continue   # side_ok (came from the control side) is used only to filter near-miss noise
                        fails = []
                        ext = b5['h'] - L if d < 0 else L - b5['l']
                        if ext > poke: fails.append('poke %.2f > %g' % (ext, poke))
                        if not (b5['c'] <= L - cb if d < 0 else b5['c'] >= L + cb): fails.append('close %.2f not back %s level' % (b5['c'], 'below' if d < 0 else 'above'))
                        a = acc_before.get((nm, L), {}).get('s' if d < 0 else 'l')
                        if a is None: fails.append('no %s acceptance before bar close' % ('seller' if d < 0 else 'buyer'))
                        if ctl is None: fails.append('4H control neutral')
                        elif ctl['dir'] != d: fails.append('4H control is %s' % ('SELL' if ctl['dir'] < 0 else 'BUY'))
                        if not fails:
                            cands.append((RANK[nm], nm, L, a))
                        elif side_ok and len(fails) == 1 and not fails[0].startswith('4H control is'):
                            misses.append(dict(t=T, td=P['td'], dir=d, level=nm, L=L, why=fails[0], bar=b5))
                    if cands:
                        cands.sort(key=lambda x: x[0])
                        _, nm, L, a = cands[0]
                        cd = dict(dir=d, nm=nm, L=L, acc=a, bar=b5, also=[x[1] for x in cands[1:]])
                        if cfg['defenseBars'] == 1:
                            emit(mk, setups, near, P, cd, b5, T, r['c'], cfg, r)
                        else:
                            pending = cd
                    elif log_detail:
                        # one near-miss per bar & direction: highest-rank level
                        if misses:
                            misses.sort(key=lambda x: RANK[x['level']]); near.append(misses[0])
            if b5 is not None: m5c_prev = b5['c']
        if px > O4 and buy: P['buyAbove'] = True
        if px < O4 and sell: P['sellBelow'] = True
        prev_rec = r
    if P is not None: finish_period(P, ranaway, setups)
    return setups, near, ranaway, periods


def fmtrd(rd):
    return ' / '.join('%s %+.3f' % (tf, s) for tf, s in rd)


def emit(mk, setups, near, P, cd, b5, T, last, cfg, r):
    d, L = cd['dir'], cd['L']
    entry = last
    rb = cd['bar']
    ext = max(rb['h'], b5['h']) if d < 0 else min(rb['l'], b5['l'])
    stop = ext + cfg['stopBufferPts'] if d < 0 else ext - cfg['stopBufferPts']
    dist = (stop - entry) if d < 0 else (entry - stop)
    chase = (L - entry) if d < 0 else (entry - L)
    if cfg.get('fixes'):
        chase = (ext - entry) if d < 0 else (entry - ext)   # PROPOSED fix 4: chase from the bounce extreme
        if T < P['t'] + 1800:   # PROPOSED fix 1: no entries in the first 30 min of the 4H candle
            near.append(dict(t=T, td=P['td'], dir=d, level=cd['nm'], L=L, why='FIX1 first 30 min of 4H', bar=b5)); return
    base = dict(t=T, td=P['td'], dir=d, level=cd['nm'], L=L, also=cd['also'], acc=cd['acc'], rbar=rb, dbar=b5, entry=entry,
                ctl=P['ctl'], p4=P['t'], O4=P['O4'])
    if chase > cfg['maxEntryFromLevelPts']:
        near.append(dict(t=T, td=P['td'], dir=d, level=cd['nm'], L=L, why='TIDE_CHASE %.2f > %g' % (chase, cfg['maxEntryFromLevelPts']), bar=b5)); return
    # r1.4 structural stops: 4H wick / 1H wick (+ STOP_BUF), provisional auto map; r1.3 retest-wick stop kept for reference
    if P['ctl']['kind'] == 'trap':
        x4 = P['ctl']['trapX']
    else:
        x4 = P['hi'] if d < 0 else P['lo']
    h1s = (T - 1) - (T - 1) % 3600
    hb = mk.m1_range(h1s, T)
    x1 = max(b['h'] for b in hb) if d < 0 else min(b['l'] for b in hb)
    x1 = max(x1, ext) if d < 0 else min(x1, ext)   # r1.6a: current 1H candle up to the defense close, incl. retest/defense bars; no previous-hour fallback
    stops = {}
    for k, xe in (('wick', ext), ('4h', x4), ('1h', x1)):
        sp = xe + STOP_BUF if d < 0 else xe - STOP_BUF
        pts = (sp - entry) if d < 0 else (entry - sp)
        stops[k] = (sp, pts) + size_for(pts)
    auto = '4h' if (cd['nm'] in ('4H Open', 'PDH', 'PDL') or P['ctl']['kind'] == 'trap') else '1h'
    base.update(stops=stops, auto=auto)
    stop, dist = stops[auto][0], stops[auto][1]
    base['contracts'] = stops[auto][2]
    base.update(stop=stop, stopPts=dist)
    # r1.5 MONEY RULE (money/SPEC-MONEY-r1.md): stop = 4H wick if <= 75 pts, else 1H wick if <= 75, else MONEY_NO_FIT
    # r1.6 context C: 4H-type (4H Open, PDH, PDL, any trap setup) = 4H wick, fallback 1H; hour-type = 1H only; else MONEY_NO_FIT
    four = cd['nm'] in ('4H Open', 'PDH', 'PDL') or P['ctl']['kind'] == 'trap'
    base['ctxType'] = '4H-type' if four else 'hour-type'
    mtf = ('4h' if stops['4h'][1] <= 75 else '1h' if stops['1h'][1] <= 75 else None) if four else ('1h' if stops['1h'][1] <= 75 else None)
    base['mtf'] = mtf
    if mtf:
        mstop, mpts = stops[mtf][0], stops[mtf][1]
        for mx in (3, 5):
            c = min(mx, int(MONEY_LOSS / (mpts * PT_VALUE) + 1e-9))
            W = math.ceil(MONEY_WIN / (PT_VALUE * c) / TICK - 1e-9) * TICK
            base['m%d' % mx] = dict(c=c, W=W, risk=c * mpts * PT_VALUE, res=first_touch(mk, T, d, mstop, entry - W if d < 0 else entry + W))
        base.update(mstop=mstop, mpts=mpts)
    base.update(after(mk, T, entry, d, dist))
    # proxy target = nearest board level >= MIN_TGT (10) beyond entry, else PROJ_PTS (40) (lib/levelEvent.js:33); APPROXIMATION of the levels plan
    lvls = [(v, k) for k, v in r['px'].items() if v is not None and k != '15m Open' and ((entry - v) if d < 0 else (v - entry)) >= 10]
    tgt = (max(lvls) if d < 0 else min(lvls)) if lvls else (entry + 40 * d, 'proj 40')
    base.update(target=tgt[0], targetName=tgt[1])
    if mtf:   # flat-only proxy follows the money rule: exit at the money stop or +W (3-lot max)
        r3 = base['m5']['res']   # Mac ruling: maxContracts = 5
        base.update(exitT=r3[1], exitWhy=r3[0])
    else:
        base.update(exitT=T, exitWhy='MONEY_NO_FIT')
    P['setups'] += 1
    setups.append(base)


STOP_BUF = 2   # lib/levelEvent.js:33


def size_for(pts):
    """r1.4: 3 -> 2 -> 1 MNQ under $375 (riskRules.sizeForRisk, slip 0); never skip: 1 MNQ up to $600 (provisional maxRiskOneLotUsd)."""
    per = pts * PT_VALUE
    if per <= 0: return (0, 0.0, 'bad stop')
    n = int(RISK_CAP / per + 1e-9)
    if n >= 1: c = min(MAX_CONTRACTS, n); return (c, c * per, '')
    return (1, per, '')


MONEY_LOSS, MONEY_WIN = 150.0, 200.0


def first_touch(mk, T, d, stop, tgt):
    """First touch on 1m after the entry: +W target vs stop (same 1m = stop); no timed exit, flat at the 14:00 PT close."""
    for b in mk.m1_range(T, T + 86400):
        pti = ptinfo(b['t'])
        if 840 <= pti[1] < 900: return ('session close', b['t'])
        hs = (b['h'] >= stop) if d < 0 else (b['l'] <= stop)
        ht = (b['l'] <= tgt) if d < 0 else (b['h'] >= tgt)
        if hs: return ('stop', b['t'] + 60)
        if ht: return ('win', b['t'] + 60)
        if pti[1] == 839: return ('session close', b['t'] + 60)
    return ('data end', mk.m1_end)


def exit_proxy(mk, T, d, stop, tgt):
    """Flat-only occupancy proxy: first of stop / target on 1m bars (both in one bar = stop), else flat at the 14:00 PT close."""
    for b in mk.m1_range(T, T + 86400):
        pti = ptinfo(b['t'])
        if 840 <= pti[1] < 900: return dict(exitT=b['t'], exitWhy='session close')
        hs = (b['h'] >= stop) if d < 0 else (b['l'] <= stop)
        ht = (b['l'] <= tgt) if d < 0 else (b['h'] >= tgt)
        if hs: return dict(exitT=b['t'] + 60, exitWhy='stop')
        if ht: return dict(exitT=b['t'] + 60, exitWhy='target')
        if pti[1] == 839 or (b is mk.m1[-1]): return dict(exitT=b['t'] + 60, exitWhy='session close' if pti[1] == 839 else 'data end')
        nxt = mk.m1i.get(b['t'] + 60)
        if nxt is None and not (b['t'] + 60 >= mk.m1_end): return dict(exitT=b['t'] + 60, exitWhy='session close (gap)')
    return dict(exitT=mk.m1_end, exitWhy='data end')


def occupancy(setups, one_per_level=False):
    """Mark which signals a flat-only bot could take (spec §3 re-entry: new retest bar after the exit; after a stop also a new acceptance reading)."""
    busy_until, last, spent = -1, None, set()
    for x in setups:
        x['taken'] = False; x['blocked'] = ''
        if not x.get('mtf'):
            x['blocked'] = 'MONEY_NO_FIT'; continue
        if one_per_level and (x['p4'], x['level']) in spent:   # PROPOSED-2 (b)
            x['blocked'] = 'level spent this 4H'; continue
        if x['t'] < busy_until:
            x['blocked'] = 'in trade (%s %s)' % (fmt(last['t']), last['level']); continue
        if last is not None and last['p4'] == x['p4'] and x['rbar']['t'] < last['exitT']:
            x['blocked'] = 'retest bar not after previous exit'; continue
        if last is not None and last['p4'] == x['p4'] and last['exitWhy'] == 'stop' and x['acc'][0] <= last['exitT']:
            x['blocked'] = 'no new acceptance after previous stop'; continue
        x['taken'] = True; busy_until = x['exitT']; last = x; spent.add((x['p4'], x['level']))
    return setups


def after(mk, T, entry, d, dist):
    bars = mk.m1_range(T, T + 7200)
    mfe = mae = 0.0; first15 = first30 = stopAt = None
    for b in bars:
        fav = (entry - b['l']) if d < 0 else (b['h'] - entry)
        adv = (b['h'] - entry) if d < 0 else (entry - b['l'])
        tm = fmt(b['t'] + 60, '%H:%M')
        for th, nm in ((15, 'f15'), (30, 'f30')):
            cur = first15 if th == 15 else first30
            if cur is None:
                hf, ha = fav >= th, adv >= th
                if hf or ha:
                    v = ('both same 1m' if hf and ha else ('+%d' % th if hf else '-%d' % th)) + ' @' + tm
                    if th == 15: first15 = v
                    else: first30 = v
        if stopAt is None and adv >= dist: stopAt = tm
        mfe = max(mfe, fav); mae = max(mae, adv)
    return dict(mfe=mfe, mae=mae, first15=first15 or 'neither', first30=first30 or 'neither', stopHit=stopAt or 'no', aftMin=len(bars))


def finish_period(P, ranaway, setups):
    got = {(s['level'], s['L'], s['dir']) for s in setups if s['p4'] == P['t']}
    for (nm, L), a in P['acc'].items():
        for d, k in ((-1, 's_first'), (1, 'l_first')):
            f = a.get(k)
            if f is None: continue
            T, rd, crossed, cdir = f
            if not crossed or cdir != d: continue   # only levels price actually traded through, accepted while 4H control agreed
            if (nm, L, d) in got: continue
            ranaway.append(dict(td=P['td'], p4=P['t'], dir=d, level=nm, L=L, accT=T, rd=rd))


# ---------------------------------------------------------------- output
def run(ddir, odir, base_cfg=DEFAULT, mk=None, R=None, do_grid=True):
    mk = mk or Market(ddir)
    days = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04']
    study_start = int(D.datetime(2026, 10, 27, 15, 0, tzinfo=PT).timestamp())
    R = R or build_readings(mk, study_start)
    # extremes after acceptance for ran-away
    setups, near, ranaway, periods = run_tide(mk, R, base_cfg)
    occupancy(setups, base_cfg.get('onePerLevel', False))
    for ra in ranaway:
        p_end = ra['p4'] + 14400
        seg = [r for r in R if ra['accT'] <= r['t'] <= p_end]
        ra['away'] = (ra['L'] - min(r['l'] for r in seg)) if ra['dir'] < 0 else (max(r['h'] for r in seg) - ra['L'])
        ra['nearest'] = (ra['L'] - max(r['h'] for r in seg)) if ra['dir'] < 0 else (min(r['l'] for r in seg) - ra['L'])
    grid = []
    for tol, ch in (((6, 25), (10, 25), (20, 25), (25, 25), (20, 1000), (25, 1000)) if do_grid else ()):
        for db in (1, 2):
            for ln in (ch,):
                cfg = dict(DEFAULT, retestTolPts=tol, defenseBars=db, maxEntryFromLevelPts=ch)
                s, _, _, _ = run_tide(mk, R, cfg, log_detail=False)
                occupancy(s)
                cnt = {d: [0, 0] for d in days}
                for x in s:
                    if x['td'] in cnt: cnt[x['td']][0] += 1; cnt[x['td']][1] += x['taken']
                grid.append((tol, db, ln, cnt, len(s), sum(x['taken'] for x in s)))
    os.makedirs(odir, exist_ok=True)
    with open(os.path.join(odir, 'setups.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['tradeday', 'time_pt', 'dir', 'level', 'level_px', 'also_in_tol', 'h4_open_pt', 'O4', 'control_kind', 'control_formed_pt',
                    'acc_time_pt', 'acc_reading', 'retest_bar_pt', 'retest_high', 'retest_low', 'retest_close', 'close_vs_level',
                    'entry_ref', 'auto_stop_tf', 'stop', 'stop_pts', 'contracts',
                    'wick_stop', 'wick_pts', 'wick_ctr', 'wick_usd', '4h_stop', '4h_pts', '4h_ctr', '4h_usd', '1h_stop', '1h_pts', '1h_ctr', '1h_usd',
                    'money_stop_tf', 'money_stop', 'money_stop_pts', 'contracts_max5', 'risk_usd', 'W_pts', 'first_touch_W_vs_stop', 'mfe_2h', 'mae_2h', 'first_15', 'first_30', 'auto_stop_hit_2h', 'proxy_exit', 'flat_only_taken', 'blocked_by'])
        for s in setups:
            rb = s['rbar']
            w.writerow([s['td'], fmt(s['t']), 'SHORT' if s['dir'] < 0 else 'LONG', s['level'], s['L'], '|'.join(s['also']), fmt(s['p4']), s['O4'],
                        s['ctl']['kind'], fmt(s['ctl']['at']), fmt(s['acc'][0]), fmtrd(s['acc'][1]), fmt(rb['t']), rb['h'], rb['l'], rb['c'],
                        round(rb['c'] - s['L'], 2), s['entry'], s['auto'], s['stop'], round(s['stopPts'], 2), s['contracts'],
                        *[v for k in ('wick', '4h', '1h') for v in (s['stops'][k][0], round(s['stops'][k][1], 2), s['stops'][k][2], round(s['stops'][k][3], 2))],
                        *(([s['mtf'].upper(), s['mstop'], round(s['mpts'], 2), s['m5']['c'], round(s['m5']['risk'], 2), s['m5']['W'], '%s %s' % (s['m5']['res'][0], fmt(s['m5']['res'][1], '%H:%M'))]) if s['mtf'] else ['MONEY_NO_FIT'] + [''] * 6),
                        round(s['mfe'], 2), round(s['mae'], 2),
                        s['first15'], s['first30'], s['stopHit'], '%s %s' % (s['exitWhy'], fmt(s['exitT'])),
                        int(s['taken']), s['blocked']])
    with open(os.path.join(odir, 'near_misses.csv'), 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['tradeday', 'time_pt', 'dir', 'level', 'level_px', 'bar_high', 'bar_low', 'bar_close', 'failing_condition'])
        for n in near:
            b = n['bar']; w.writerow([n['td'], fmt(n['t']), 'SHORT' if n['dir'] < 0 else 'LONG', n['level'], n['L'], b['h'], b['l'], b['c'], n['why']])
    with open(os.path.join(odir, 'ranaway.csv'), 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['tradeday', 'h4_period_pt', 'dir', 'level', 'level_px', 'acceptance_pt', 'reading', 'max_away_pts', 'closest_return_pts'])
        for a in ranaway:
            w.writerow([a['td'], fmt(a['p4']), 'SHORT' if a['dir'] < 0 else 'LONG', a['level'], a['L'], fmt(a['accT']), fmtrd(a['rd']), round(a['away'], 2), round(a['nearest'], 2)])
    with open(os.path.join(odir, 'readings.csv'), 'w', newline='') as f:   # every decision reading, for chart checks
        w = csv.writer(f); w.writerow(['time_pt', 'close', 'score15', 'score30', 'O4', 'O1', 'PDH', 'PDL', 'AsiaH', 'AsiaL', 'LonH', 'LonL', 'vwap_src'])
        for r in R:
            px = r['px']
            w.writerow([fmt(r['t']), r['c'], round(r['s15'], 4), round(r['s30'], 4), r['O4'], r['O1'], px['PDH'], px['PDL'], px['Asia High'],
                        px['Asia Low'], px['London High'], px['London Low'], r['vsrc']])
    json.dump(dict(last_m1=fmt(mk.m1[-1]['t'] + 60, '%Y-%m-%d %H:%M PT')), open(os.path.join(odir, 'run_meta.json'), 'w'))
    return mk, R, setups, near, ranaway, periods, grid, days



# ---------------------------------------------------------------- RESULTS.md
def stp(x, k):
    sp, pts = x['stops'][k][0], x['stops'][k][1]
    return '%.2f (%.1f)' % (sp, pts)


def money(x):
    if not x.get('mtf'):
        return 'MONEY_NO_FIT', '-'
    m5 = x['m5']
    return ('%s %.2f (%.1f)' % (x['mtf'].upper(), x['mstop'], x['mpts']),
            '%d ctr $%.0f, W %.2f: **%s** %s' % (m5['c'], m5['risk'], m5['W'], m5['res'][0], fmt(m5['res'][1], '%H:%M')))


def dirs(d):
    return 'SHORT' if d < 0 else 'LONG'


def summarize(setups, periods, days):
    from collections import Counter
    out = {}
    for d in days:
        xs = [x for x in setups if x['td'] == d]
        tk = [x for x in xs if x['taken']]
        ev = Counter(e[1] for P in periods.values() if P['td'] == d for e in P['events'])
        out[d] = dict(sig=len(xs), fit=sum(1 for x in xs if x.get('mtf')), taken=len(tk), win=sum(1 for x in tk if x['m5']['res'][0] == 'win'),
                      stop=sum(1 for x in tk if x['m5']['res'][0] == 'stop'), form=ev['FORM'], cancel=ev['CANCEL'], void=ev['VOID'])
    return out


def witness_lines(setups, periods, label):
    L = []
    wp = [P for t, P in periods.items() if fmt(t) == '11-03 15:00']
    if not wp: return L
    P = wp[0]
    L.append('**%s** control: ' % label + '; '.join('%s %s %s' % (fmt(e[0], '%H:%M'), e[1], e[3].split(',')[0] if e[1] == 'FORM' else '') for e in P['events']))
    xs = [x for x in setups if x['p4'] == P['t']]
    if not xs: L.append('  no signals in the period')
    for x in xs:
        m = money(x)
        L.append('  - %s %s %s %.2f, entry %.2f, 4H stop %s, 1H stop %s -> %s; max5 %s; %s' % (fmt(x['t'], '%H:%M'), dirs(x['dir']), x['level'], x['L'], x['entry'],
                 stp(x, '4h'), stp(x, '1h'), m[0], m[1], 'TAKEN' if x['taken'] else x['blocked']))
    return L


def write_results(odir, mk, R, setups, near, ranaway, periods, grid, days, xcheck, label='DEFAULT rules', cfg=DEFAULT, compare=None):
    from collections import Counter, defaultdict
    L = []
    A = L.append
    A('# TIDE setup log — %s — MNQ, TradeDays %s .. %s' % (label, days[0], days[-1]))
    if cfg.get('fixes'):
        A('')
        A('**PROPOSED fixes on (MacArthur, not yet ruled by Mac):** (1) no entries in the first 30 min of a 4H candle; (2) trap control holds until the trapped '
          'extreme is taken or the 4H closes (no CANCEL on opposite readings); (3) trap needs the period extreme 25+ pts beyond O4, or a 15m/30m reading >= 0.15 on the '
          'push side while price was beyond O4 — otherwise kind below/above; (4) retest = failed bounce within 25 pts of the level (high >= L-25), no-chase 25 measured '
          'from the bounce extreme (retest high - entry). Everything else as in the default run.')
    A('')
    A('Fidelity check of the strategy rules, not a P&L study. Data: replay1104 m1/m5/m15/m30/h1/h4/d1 (continuous series), last 1m bar ends **%s**. '
      'All times America/Los_Angeles. "time" of a setup = the 5m close where the bot would decide (retest bar close, or defense bar close).' % fmt(mk.m1_end, '%Y-%m-%d %H:%M PT'))
    A('')
    A('Generated by `tide_setups.py` (stdlib, causal minute walk). Files: `setups.csv` (every signal, incl. ones a flat-only bot could not take), '
      '`near_misses.csv`, `ranaway.csv`, `readings.csv` (every 1m decision reading: price, forming 15m/30m score, level board).')
    A('')
    if compare is not None:
        f_mk, f_R, f_set, f_near, f_ra, f_per, _, _ = compare
        A('## Default vs PROPOSED fixes-on (full run in `fixes_on/`)')
        A('')
        sd, sf = summarize(setups, periods, days), summarize(f_set, f_per, days)
        A('| TradeDay | default: signals / money-fit / taken-if-flat / +W first / stop first / control FORM-CANCEL-VOID | fixes-on: same |')
        A('|---|---|---|')
        for d in days:
            a, b = sd[d], sf[d]
            A('| %s | %d / %d / **%d** / %d / %d / %d-%d-%d | %d / %d / **%d** / %d / %d / %d-%d-%d |' % ((d,) + tuple(a[k] for k in ('sig', 'fit', 'taken', 'win', 'stop', 'form', 'cancel', 'void'))
                                                                      + tuple(b[k] for k in ('sig', 'fit', 'taken', 'win', 'stop', 'form', 'cancel', 'void'))))
        tot = lambda S, k: sum(S[d][k] for d in days)
        A('| total | %d / %d / **%d** / %d / %d / %d-%d-%d | %d / %d / **%d** / %d / %d / %d-%d-%d |' % (tuple(tot(sd, k) for k in ('sig', 'fit', 'taken', 'win', 'stop', 'form', 'cancel', 'void'))
                                                                + tuple(tot(sf, k) for k in ('sig', 'fit', 'taken', 'win', 'stop', 'form', 'cancel', 'void'))))
        A('')
        A('"+W first / stop first" = first touch on 1m for the taken-if-flat trades (money stop vs +W at max-5 size, Mac ruling).')
        A('')
        A('Witness period (11/03 15:00-19:00 PT) under both runs:')
        A('')
        for ln in witness_lines(setups, periods, 'Default') + witness_lines(f_set, f_per, 'Fixes-on'):
            A(ln)
        A('')
    A('## Rules as implemented (SPEC-TIDE-r1 + r1.1 + r1.2 + r1.3 + r1.4 + r1.5 + r1.6/r1.6a)')
    A('- **Control score** = our Levels PRO board bias score (`biasScore`, lib/levelsPro.js:421-429; the bot reads `lvByTf.M15.biasScore` at live-executor.js:2849), '
      'evaluated at every 1m close on the **forming** 15m and forming 30m candle (30m = same function on 30m bars). Line = 0.15 (r1.3: controlGateMin set to 0.15).')
    A('- **4H control**: SELL forms when price < 4H open and forming 15m or 30m score <= -0.15; kind *trap* if the period high had reached O4+5 before, else *below*; '
      'trapHigh = period high at formation. CANCEL when price > O4 with 15m/30m score >= +0.15 (the opposite control may form on the same reading). '
      'VOID when price trades above trapHigh. BUY = mirror. New 4H period = start from scratch.')
    A('- **Levels**: 4H Open, PDH, PDL, London H/L, Asia H/L, 1H Open from the port\'s 15m board (sessionAnchor cme: day = 15:00 PT; Asia = 15:00-24:00 PT, '
      'London = 00:00-06:30 PT per helpers.js ptInfo). Asia H/L usable only outside the Asia session, London H/L only outside London (r1.1 "once it exists").')
    A('- **Acceptance at L** (r1.2): a reading with price below L and forming 15m/30m score <= -0.15 (short). Lost again by a reading above L with score >= +0.15. '
      'Must be seen at a reading taken **before** the retest bar\'s close (the last allowed reading is the 1m close one minute before the 5m close). Reset each 4H period.')
    A('- **Retest** (closed 5m): high >= L-6, high <= L+12, close <= L-0.25, while 4H control = SELL at that 5m close. Defense 1 = the retest bar. '
      'Several levels on one bar -> one setup labelled with the top rank (4H Open > PDH/PDL > London > Asia > 1H Open).')
    A('- **Entry ref** = the 5m close. **No chase**: skip if L - entry > 25. **Stop** (r1.3) = retest wick extreme + 2 (lib/levelEvent.js:33 STOP_BUF = 2), '
      'no 8-pt clamp, no 60-pt skip. r1.4 adds the **4H-wick stop** (trap kind: trapHigh/trapLow; else the current 4H candle\'s high/low before entry) and the **1H-wick stop** '
      '(current 1H candle high/low up to entry; if that extreme is the retest bar itself, also the previous 1H candle), each + 2. **Auto** (provisional map) = 4H for 4H Open / PDH / PDL '
      'or any trap-kind control, else 1H. **Size** = min(3, floor($375 / (pts x $2))) (riskRules.sizeForRisk, slip 0); never skipped: 1 MNQ when even 1 > $375 '
      '(r1.4 sizing kept in setups.csv only).')
    A('- **Money rule r1.5** (money/SPEC-MONEY-r1.md): money stop = 4H wick if <= 75 pts (incl. +2), else 1H wick if <= 75, else **MONEY_NO_FIT** (not traded). '
      'Contracts = min(5, floor($150 / (pts x $2))) (Mac ruling: maxContracts 5). W = ceil_tick($200 / ($2 x contracts)). **First touch** on 1m after the entry: +W vs the money stop '
      '(same minute = stop), no timed exit, flat at the 14:00 PT close. The flat-only proxy now uses this (exit at +W or the money stop).')
    A('- **Stop context C (r1.6, final) + r1.6a**: 4H-type setups (4H Open, PDH, PDL, or any trap-kind control) use the 4H wick, fallback the 1H wick, else MONEY_NO_FIT; '
      'hour-type setups (1H Open, Asia, London levels under non-trap control) use the 1H wick only. 1H wick = the current 1H candle\'s extreme up to the defense close, '
      'including the retest/defense bars, no previous-hour fallback.')
    A('- **What price did next** (descriptive): max favourable / max adverse points over the next 2 h (1m highs/lows), which side reached 15 / 30 points first.')
    A('- **Flat-only column** (proxy, not the bot\'s exit engine): a signal is *taken* if it fits the money rule and no earlier taken signal is still open '
      '(open until +W or the money stop, max-5 sizing). '
      'Re-entry needs a retest bar after the exit, and after a stop a new acceptance reading (spec §3).')
    A('')
    A('### Bias-score port check (Python port vs the bot\'s own JS)')
    A('The bot\'s r13.3.7 `evaluateLevelsPro` was run in node at %d sampled minutes, as the bot would at that minute (closed bars + forming bars from 1m, full re-evaluation of the '
      'last 2000 bars, same opts). |Python - JS|: 15m median %.4f, max %.4f; 30m median %.4f, max %.4f. The port is incremental (closed rows are not re-evaluated when the '
      'forming H1 ATR changes), which explains the small residual.' % xcheck)
    A('')
    A('Approximations (inputs not in OHLCV / not in the data): weekly bars (PWH/PWL/Week Open) are built from d1 (TradeDays Mon-Fri); levelsParity = shipped "off" and '
      'vwapBuildTf = shipped "5m" (live config-local could differ); bars are the continuous series (Mac\'s chart = contract: 4H open 28,412.50 vs data 28,414, 1.5 pt).')
    A('')
    # ---- headline findings (computed)
    A('## Headline (as of the last bar above)')
    ev = Counter((P['td'], e[1]) for P in periods.values() for e in P['events'])
    A('- Signals per TradeDay (default: tol 6, defense 1, no-chase 25) — all / flat-only taken: ' + ', '.join(
        '%s %d / %d' % (d[5:], sum(1 for x in setups if x['td'] == d), sum(1 for x in setups if x['td'] == d and x['taken'])) for d in days) + '.')
    A('- 4H control changes per TradeDay (FORM / CANCEL / VOID): ' + ', '.join('%s %d/%d/%d' % (d[5:], ev[(d, 'FORM')], ev[(d, 'CANCEL')], ev[(d, 'VOID')]) for d in days)
      + '. The intrabar 0.15 line flips control back and forth whenever price crosses the 4H open; it is not one tide per 4H.')
    for scope, xs in (('all signals', setups), ('taken flat-only', [x for x in setups if x['taken']])):
        fit = [x for x in xs if x.get('mtf')]
        rc = Counter(x['m5']['res'][0] for x in fit)
        A('- Money rule, %s: %d of %d fit (4H %d, 1H %d, NO_FIT %d); max-5 first touch: win %d, stop %d, other %d.' % (
            scope, len(fit), len(xs), sum(x['mtf'] == '4h' for x in fit), sum(x['mtf'] == '1h' for x in fit), len(xs) - len(fit), rc['win'], rc['stop'], len(fit) - rc['win'] - rc['stop']))
    lc = Counter(x['level'] for x in setups)
    A('- Signals by level: ' + ', '.join('%s %d' % kv for kv in lc.most_common()) + '. Most come from consecutive 5m bars hovering at the 4H / 1H open.')
    A('- r1.2 acceptance does not require a prior break: any reading with price below L and seller score accepts L, so a level far above price is "accepted" '
      'long before price comes back to it (the retest then behaves as a rejection-at-resistance entry).')
    A('')
    # ---- witness
    A('## Priority 1 — Mac\'s witness, TradeDay 11/04, 4H 15:00-19:00 PT (11/03)')
    wp = [P for t, P in periods.items() if fmt(t) == '11-03 15:00']
    if wp:
        P = wp[0]
        A('4H open (data) **%.2f**, period high %.2f, low %.2f.' % (P['O4'], P['hi'], P['lo']))
        A('')
        A('Control timeline:')
        for e in P['events']:
            A('- %s **%s** %s' % (fmt(e[0], '%H:%M'), e[1], e[3]))
        A('')
        A('Signals in the period (default rules):')
        A('')
        A('| time | dir | level | retest 5m bar (H / L / C) | entry ref | 4H stop (pts) | 1H stop (pts) | money stop | max 5 (ruled): size, $risk, W, first touch | flat-only | next 2 h |')
        A('|---|---|---|---|---|---|---|---|---|---|---|')
        for x in setups:
            if x['p4'] == P['t']:
                rb = x['rbar']
                A('| %s | %s | %s %.2f | %s-%s %.2f / %.2f / %.2f | %.2f | %s | %s | %s | %s | %s | MFE %.1f / MAE %.1f; 15: %s; 30: %s |' % (
                    fmt(x['t'], '%H:%M'), dirs(x['dir']), x['level'], x['L'], fmt(rb['t'], '%H:%M'), fmt(rb['t'] + 300, '%H:%M'), rb['h'], rb['l'], rb['c'],
                    x['entry'], stp(x, '4h'), stp(x, '1h'), *money(x), 'taken' if x['taken'] else x['blocked'], x['mfe'], x['mae'], x['first15'], x['first30']))
        A('')
        A('Near-misses in the period:')
        for n in near:
            if P['t'] <= n['t'] < P['t'] + 14400:
                b = n['bar']
                A('- %s %s %s %.2f: %s (bar %.2f / %.2f / %.2f)' % (fmt(n['t'], '%H:%M'), dirs(n['dir']), n['level'], n['L'], n['why'], b['h'], b['l'], b['c']))
        A('')
        W = [r for r in R if P['t'] <= r['t'] <= P['t'] + 14400]
        if not cfg.get('fixes'):
            A('What-if (same period, only the retest tolerance / no-chase changed; SHORT signals before 17:00):')
            A('')
            A('| retestTol | no-chase | shorts before 17:00 (time level entry / stop) |')
            A('|---|---|---|')
        for tol, ch in (((6, 25), (10, 25), (20, 25), (25, 25), (20, 1000), (25, 1000)) if not cfg.get('fixes') else ()):
            s2, n2, _, _ = run_tide(mk, W, dict(DEFAULT, retestTolPts=tol, maxEntryFromLevelPts=ch), log_detail=True)
            sh = ['%s %s %.2f, 4H %s / 1H %s -> money %s; max5 %s' % (fmt(x['t'], '%H:%M'), x['level'], x['entry'], stp(x, '4h'), stp(x, '1h'), money(x)[0], money(x)[1])
                  for x in s2 if x['dir'] < 0 and x['t'] <= P['t'] + 7200]
            sh += ['(blocked %s %s: %s)' % (fmt(n['t'], '%H:%M'), n['level'], n['why']) for n in n2 if n['dir'] < 0 and n['t'] <= P['t'] + 4800 and n['level'] == '4H Open']
            A('| %g | %s | %s |' % (tol, 'off' if ch >= 1000 else ch, '; '.join(sh) or 'none'))
        A('')
    # ---- per day
    for td in days:
        A('## TradeDay %s' % td)
        A('')
        A('### 4H periods')
        for t in sorted(periods):
            P = periods[t]
            if P['td'] != td: continue
            ev = P['events']
            c = Counter(e[1] for e in ev)
            A('- **%s** O4 %.2f (H %.2f / L %.2f) — %d FORM, %d CANCEL, %d VOID:' % (fmt(t, '%m-%d %H:%M'), P['O4'], P['hi'], P['lo'], c['FORM'], c['CANCEL'], c['VOID']))
            A('  ' + '; '.join('%s %s %s' % (fmt(e[0], '%H:%M'), e[1], e[3] if e[1] == 'FORM' else ('' if e[1] == 'CANCEL' else 'trap broken')) for e in ev))
        S = [x for x in setups if x['td'] == td]
        A('')
        A('### Setups (%d signals; %d taken flat-only; the rest are in `setups.csv`)' % (len(S), sum(x['taken'] for x in S)))
        A('')
        A('| time | dir | level | control (kind, formed) | acceptance (time, reading) | retest 5m bar H / L / C (close-L) | entry | 4H stop (pts) | 1H stop (pts) | money stop | max 5 (ruled): size, $risk, W, first touch | MFE / MAE 2h | first ±15 | first ±30 |')
        A('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        for x in S:
            if not x['taken']: continue
            rb = x['rbar']
            A('| %s | %s | %s %.2f%s | %s %s | %s %s | %s %.2f / %.2f / %.2f (%+.2f) | %.2f | %s | %s | %s | %s | %.1f / %.1f | %s | %s |' % (
                fmt(x['t'], '%H:%M'), dirs(x['dir']), x['level'], x['L'], (' (+' + ','.join(x['also']) + ')') if x['also'] else '',
                x['ctl']['kind'], fmt(x['ctl']['at'], '%H:%M'), fmt(x['acc'][0], '%H:%M'), fmtrd(x['acc'][1]),
                fmt(rb['t'], '%H:%M'), rb['h'], rb['l'], rb['c'], rb['c'] - x['L'], x['entry'], stp(x, '4h'), stp(x, '1h'), *money(x),
                x['mfe'], x['mae'], x['first15'], x['first30']))
        N = [n for n in near if n['td'] == td]
        A('')
        A('### Near-misses (%d; one per 5m bar and direction, exactly one failing condition)' % len(N))
        rc = Counter(n['why'].split(' ')[0] if n['why'].startswith('TIDE') or n['why'].startswith('RISK') else
                     ('poke' if n['why'].startswith('poke') else 'close not back' if n['why'].startswith('close') else 'no acceptance' if n['why'].startswith('no ') else
                      'control neutral' if 'neutral' in n['why'] else n['why']) for n in N)
        A('By failing condition: ' + ', '.join('%s %d' % kv for kv in rc.most_common()))
        A('')
        for n in N[:25]:
            b = n['bar']
            A('- %s %s %s %.2f: %s (bar %.2f / %.2f / %.2f)' % (fmt(n['t'], '%H:%M'), dirs(n['dir']), n['level'], n['L'], n['why'], b['h'], b['l'], b['c']))
        if len(N) > 25: A('- ... %d more in near_misses.csv' % (len(N) - 25))
        RA = [a for a in ranaway if a['td'] == td]
        A('')
        A('### Ran away (%d): level traded through, accepted while the 4H agreed, no setup at it in the period' % len(RA))
        for a in RA:
            A('- %s %s %s %.2f accepted %s (%s); went %.1f pts away, closest return %.1f pts from L' % (
                fmt(a['p4'], '%H:%M'), dirs(a['dir']), a['level'], a['L'], fmt(a['accT'], '%H:%M'), fmtrd(a['rd']), a['away'], a['nearest']))
        A('')
    # ---- grid
    if not grid:
        with open(os.path.join(odir, 'RESULTS.md'), 'w') as f:
            f.write('\n'.join(L) + '\n')
        return
    A('## Grid (counts only; control line 0.15 per r1.3) — signals / taken flat-only; "+x" = extra signals vs retestTol 6 at the same defense/no-chase')
    A('')
    A('| retestTol | no-chase | defenseBars | ' + ' | '.join(d[5:] for d in days) + ' | total |')
    A('|---|---|---|' + '---|' * (len(days) + 1))
    base = {db: cnt for tol, db, ch, cnt, tot, tk in grid if tol == 6}
    for tol, db, ch, cnt, tot, tk in grid:
        A('| %g | %s | %d | ' % (tol, 'off' if ch >= 1000 else ch, db) + ' | '.join('%d / %d (%+d)' % (cnt[d][0], cnt[d][1], cnt[d][0] - base[db][d][0]) for d in days)
          + ' | %d / %d |' % (tot, tk))
    A('')
    with open(os.path.join(odir, 'RESULTS.md'), 'w') as f:
        f.write('\n'.join(L) + '\n')


def xcheck_from_ref(odir):
    import statistics as st
    try:
        s = json.load(open(os.path.join(odir, 'ref', 'samp.json')))
        d15 = []; d30 = []
        for ln in open(os.path.join(odir, 'ref', 'node_out.txt')):
            T, a, b = ln.split(); p = s[T]; d15.append(abs(float(a) - p[0])); d30.append(abs(float(b) - p[1]))
        return (len(d15), st.median(d15), max(d15), st.median(d30), max(d30))
    except Exception:
        return (0, float('nan'), float('nan'), float('nan'), float('nan'))


if __name__ == '__main__':
    import pickle
    mk, R, setups, near, ranaway, periods, grid, days = run(sys.argv[1], sys.argv[2])
    FIX = dict(DEFAULT, fixes=True)
    fdir = os.path.join(sys.argv[2], 'fixes_on')
    os.makedirs(fdir, exist_ok=True)
    f_out = run(sys.argv[1], fdir, FIX, mk=mk, R=R, do_grid=False)
    write_results(fdir, *f_out, xcheck_from_ref(sys.argv[2]), label='FIXES-ON (PROPOSED, not ruled by Mac)', cfg=FIX)
    write_results(sys.argv[2], mk, R, setups, near, ranaway, periods, grid, days, xcheck_from_ref(sys.argv[2]), compare=f_out)
    print('setups', len(setups), 'near', len(near), 'ranaway', len(ranaway), '| fixes-on setups', len(f_out[2]))
    # PROPOSED-2 variants on top of fixes-on
    var = [('fixes_on2', 'PROPOSED-2: fixes-on + (a) 1m defense + (b) one trade per level per 4H', dict(FIX, defense1m=True, onePerLevel=True)),
           ('fixes_on2/a_only', 'PROPOSED-2 (a) only: fixes-on + 1m defense', dict(FIX, defense1m=True)),
           ('fixes_on2/b_only', 'PROPOSED-2 (b) only: fixes-on + one trade per level per 4H', dict(FIX, onePerLevel=True)),
           # Mac 11/04 "eliminate the no chase rule or extend"
           ('chase/fixes_nochase', 'fixes-on, NO chase limit (money 75-pt fit only)', dict(FIX, maxEntryFromLevelPts=1e9)),
           ('chase/fixes_chase50', 'fixes-on, chase 50 from the bounce extreme', dict(FIX, maxEntryFromLevelPts=50)),
           ('chase/a_nochase', 'fixes-on + (a) 1m defense, NO chase limit', dict(FIX, defense1m=True, maxEntryFromLevelPts=1e9)),
           ('chase/b_nochase', 'fixes-on + (b) one per level per 4H, NO chase limit', dict(FIX, onePerLevel=True, maxEntryFromLevelPts=1e9))]
    summ = [('fixes-on', f_out)]
    for sub, lab, cfgv in var:
        vd = os.path.join(sys.argv[2], sub); os.makedirs(vd, exist_ok=True)
        o = run(sys.argv[1], vd, cfgv, mk=mk, R=R, do_grid=False)
        write_results(vd, *o, xcheck_from_ref(sys.argv[2]), label=lab, cfg=cfgv)
        summ.append((sub, o))
    rows = []
    for name, o in summ:
        st_ = o[2]; tk = [x for x in st_ if x['taken']]
        win = [x for x in tk if x['m5']['res'][0] == 'win']; los = [x for x in tk if x['m5']['res'][0] == 'stop']
        usd = 200 * len(win) - sum(x['m5']['risk'] for x in los)
        w = [x for x in st_ if x['p4'] == 1793746800 and x['dir'] < 0 and x['t'] < 1793746800 + 6600]
        rows.append(dict(name=name, perday_win={d: sum(1 for x in win if x['td'] == d) for d in days}, sig=len(st_), taken=len(tk), win=len(win), stop=len(los), other=len(tk) - len(win) - len(los), usd=usd,
                         wr=len(win) / max(1, len(win) + len(los)),
                         witness=['%s %s %.2f stop %s W %s %s %s' % (fmt(x['t'], '%H:%M'), x['level'], x['entry'], ('%.2f (%.1f, %d ctr)' % (x['mstop'], x['mpts'], x['m5']['c'])) if x.get('mtf') else 'NO_FIT',
                                   x['m5']['W'] if x.get('mtf') else '-', x['m5']['res'][0] if x.get('mtf') else '', 'TAKEN' if x['taken'] else x['blocked']) for x in w],
                         perday={d: sum(1 for x in tk if x['td'] == d) for d in days}))
    json.dump(rows, open(os.path.join(sys.argv[2], 'fixes_on2', 'variants_summary.json'), 'w'), indent=1)
    for r_ in rows: print(json.dumps(r_))
