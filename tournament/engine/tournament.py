"""Coordinator.  python tournament.py gate | draw | round <R1|QF|SF|F> | board
State lives in hidden_files/quant-team/{tournament/{state,bracket}.json, strategy-tracker/activity.json}."""
import sys, os, json, random, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, engine as E
from run_team import load_strategy

ROOT = os.path.join(os.path.dirname(__file__), '..')
TDIR = os.path.join(ROOT, 'hidden_files/quant-team/tournament')
ADIR = os.path.join(ROOT, 'hidden_files/quant-team/strategy-tracker')
STATE, BRACKET, ACT = (os.path.join(TDIR, 'state.json'), os.path.join(TDIR, 'bracket.json'), os.path.join(ADIR, 'activity.json'))
SEED = 20261010
DATA_NOTE = ('NQ: 1-min MNQ proxy 2021-09-27→2026-09-25 · ES: 1-min ES (MES $5/pt) 2021-10-10→2026-10-09, '
             'outrights only, front-month by volume, back-adjusted at rolls')

LANES = {
 'NQ-1': ('Levels-reclaim', 'break → retest → reclaim at PDH/PDL, Asia, weekly levels & VWAP'),
 'NQ-2': ('Opening-range breakout', '09:30 ET opening range breakout'),
 'NQ-3': ('Overnight / gap momentum', 'overnight structure & gap into the cash open'),
 'NQ-4': ('MTF trend-following', 'hourly trend filter + 1-min pullback reclaim'),
 'NQ-5': ('ICT / SMC', 'liquidity sweep + displacement + FVG in killzones'),
 'NQ-6': ('Vol-regime adaptive', 'volatility-regime switch between breakout & fade'),
 'ES-1': ('Session VWAP', 'VWAP deviation-band reversion / pullback'),
 'ES-2': ('Mean reversion', 'oscillator / statistical exhaustion fades'),
 'ES-3': ('Asia / London session', 'cross-session structure into NY'),
 'ES-4': ('ML / statistical', 'regularized model on engineered features'),
 'ES-5': ('Order-flow proxy', 'volume-delta, absorption & climax from 1-min bars'),
 'ES-6': ('Event / time-of-day', 'scheduled-time & calendar effects'),
}
PHASES = ['Pre-register', 'Train', 'Validation gate', 'Round 1', 'Quarterfinals', 'Semifinals', 'Final', 'Champion']
RND = [('R1', 'Round 1'), ('QF', 'Quarterfinals'), ('SF', 'Semifinals'), ('F', 'Final')]

def now(): return dt.datetime.utcnow().replace(microsecond=0).isoformat()
def jload(p, default):
    return json.load(open(p)) if os.path.exists(p) else default
def jsave(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True); tmp = p + '.tmp'
    json.dump(obj, open(tmp, 'w'), indent=1, default=float); os.replace(tmp, p)
def log(action, detail, team='coordinator', rnd='T1'):
    a = jload(ACT, []); a.append(dict(ts=now(), round=rnd, team=team, action=action, detail=detail)); jsave(ACT, a)

def state():
    s = jload(STATE, None)
    if s is None:
        s = dict(phase_index=1, phase_label='Teams researching on train data (2021–2023)', data_note=DATA_NOTE, draw=[], teams={})
        for k, (lane, short) in LANES.items():
            s['teams'][k] = dict(lane=lane, concept_short=short, concept=short, status='research', gate=None)
    return s

def curve(tape, ts, i0, n=260):
    if len(tape) == 0: return [[int(ts[i0]), 50000.0]]
    pts = [[int(ts[int(r[1])]), float(r[8])] for r in tape]
    if len(pts) > n:
        idx = np.linspace(0, len(pts) - 1, n).astype(int); pts = [pts[i] for i in idx]
    return [[int(ts[i0]), 50000.0]] + pts

def daily(r):
    days = r['daily_day']; pnl = r['daily_pnl']; out = []; eq = 50000.0; peak = 50000.0
    for d, p in zip(days, pnl):
        eq += p; peak = max(peak, eq); out.append([int(d) * 86400, round(eq, 2), round(peak - 2000, 2), round(float(p), 2)])
    return out

def gate():
    s = state(); s['phase_index'] = 2; s['phase_label'] = 'Validation gate (2024-01 → 2025-06)'
    for k in LANES:
        if not os.path.exists(os.path.join(ROOT, 'teams', k, 'strategy.py')):
            continue
        inst = 'NQ' if k.startswith('NQ') else 'ES'
        d = E.load(inst, research=True); m = load_strategy(k)
        sig = m.generate(d, m.PARAMS); i0, i1 = d.idx(*E.WINDOWS['validate'])
        r = E.run(d, sig, i0, i1, enforce=False)
        roll = E.summarize_rolling(E.rolling_evals(d, sig, i0, i1))
        clean = E.lookahead_check(d, m.generate, m.PARAMS)
        ok = r['pf'] > 1.0 and r['trades'] >= 100 and r['trades_per_day'] >= 0.5 and clean
        t = s['teams'][k]
        if t.get('gate') and not t.get('gate1'): t['gate1'] = dict(t['gate'])
        t['gate'] = dict(pf=r['pf'], wr=r['win_rate'], trades=r['trades'], tpd=r['trades_per_day'], net=r['net'],
                         max_dd=r['max_dd'], pass_=bool(ok), lookahead_clean=bool(clean), attempt=(t.get('gate') or {}).get('attempt', 0) + 1)
        t['gate']['pass'] = bool(ok)
        t['roll'] = roll; t['nparams'] = len(m.PARAMS)
        t['val_curve'] = curve(r['tape'], d.ts, i0, 120); t['val_curve_full'] = curve(r['tape'], d.ts, i0, 400)
        t['status'] = 'qualified' if ok else 'failed_gate'
        log('gate', f"{k} {'PASS' if ok else 'FAIL'} PF={r['pf']:.2f} n={r['trades']} ({r['trades_per_day']:.2f}/d) net={r['net']:.0f} lookahead_clean={clean}", k)
        print(k, 'PASS' if ok else 'FAIL', E.brief(r), 'clean=', clean, flush=True)
    jsave(STATE, s); board()

def mk_rounds(pairs_r1=None):
    wins = dict(E.WINDOWS)
    rs = []
    sizes = [6, 4, 2, 1]
    for (key, name), n in zip(RND, sizes):
        a, b = wins[key]
        rs.append(dict(key=key, name=name, window=dict(start=a, end=b), matches=[dict(label=f'Match {i+1}' if key != 'F' else 'Grand Final', teamA=None, teamB=None) for i in range(n)]))
    if pairs_r1:
        for i, (a, b) in enumerate(pairs_r1):
            rs[0]['matches'][i].update(teamA=a, teamB=b)
    return rs

def draw():
    s = state(); q = sorted(k for k, t in s['teams'].items() if t['status'] == 'qualified')
    rng = random.Random(SEED); rng.shuffle(q)
    pairs = [(q[i], q[i + 1]) for i in range(0, len(q) - 1, 2)]; bye = [q[-1]] if len(q) % 2 else []
    s['draw'] = pairs; s['byes'] = bye; s['phase_index'] = 3; s['phase_label'] = 'Round 1 — draw published'
    rs = mk_rounds(pairs); rs[0]['matches'] = rs[0]['matches'][:len(pairs)]
    jsave(BRACKET, dict(rounds=rs)); jsave(STATE, s)
    log('draw', f"Seeded random draw (seed {SEED}): " + '; '.join(f'{a} vs {b}' for a, b in pairs) + (f' · bye {bye}' if bye else ''))
    print(pairs, bye); board()

def result_pack(r, d, i0):
    return dict(score=r['score'], net=r['net'], dd=r['max_dd'], pf=r['pf'] if np.isfinite(r['pf']) else 99.0, wr=r['win_rate'], trades=r['trades'],
                equity=r['final_equity'], avgq=r['avg_contracts'], passed=r['passed'], bust=r['bust'], bust_ts=r['bust_ts'],
                day=daily(r), curve=curve(r['tape'], d.ts, i0))

def play(a, b, key):
    out = {}
    for tid in (a, b):
        inst = 'NQ' if tid.startswith('NQ') else 'ES'
        d = E.load(inst, research=False); m = load_strategy(tid)
        sig = m.generate(d, m.PARAMS); i0, i1 = d.idx(*E.WINDOWS[key])
        out[tid] = result_pack(E.run(d, sig, i0, i1), d, i0)
    return out

def decide(a, b, ra, rb):
    ea = ra['score'] > 0; eb = rb['score'] > 0
    if ea != eb: return (a, 'only finisher net-positive & alive') if ea else (b, 'only finisher net-positive & alive')
    if ea and eb:
        if abs(ra['score'] - rb['score']) <= 0.05: return (a, 'tie→PF') if ra['pf'] >= rb['pf'] else (b, 'tie→PF')
        return (a, 'higher score') if ra['score'] > rb['score'] else (b, 'higher score')
    if ra['bust'] and rb['bust']:
        return (a, 'both bust: survived longer') if ra['bust_ts'] > rb['bust_ts'] else (b, 'both bust: survived longer')
    return (a, 'neither scored: higher net') if ra['net'] >= rb['net'] else (b, 'neither scored: higher net')

def run_round(key):
    s = state(); br = jload(BRACKET, None); names = [k for k, _ in RND]; ri = names.index(key); R = br['rounds'][ri]
    log('round-start', f"{R['name']} window {R['window']['start']} → {R['window']['end']}", rnd=key)
    winners, losers = [], []
    for m in R['matches']:
        a, b = m['teamA'], m['teamB']
        if not (a and b): continue
        res = play(a, b, key); ra, rb = res[a], res[b]
        w, why = decide(a, b, ra, rb); l = b if w == a else a
        for side, tid, rr in (('A', a, ra), ('B', b, rb)):
            m['score' + side] = round(rr['score'], 3); m['equity' + side] = round(rr['equity'], 2); m['net' + side] = round(rr['net'], 2)
            m['dd' + side] = round(rr['dd'], 2); m['pf' + side] = round(rr['pf'], 3); m['wr' + side] = round(rr['wr'], 3); m['trades' + side] = rr['trades']
            m['avgq' + side] = round(rr['avgq'], 2); m['passed' + side] = rr['passed']; m['bust' + side] = rr['bust']; m['bust_ts' + side] = rr['bust_ts']
            m['day' + side] = rr['day']; m['curve' + side] = rr['curve']
        m['bust'] = ra['bust'] or rb['bust']; m['winner'] = w; m['decision'] = why; m['date'] = now()[:10]
        winners.append(w); losers.append((l, res[l]['score'], res[l]['net']))
        log('match', f"{key} {a} {ra['score']:.2f} (net {ra['net']:.0f}, dd {ra['dd']:.0f}{', BUST' if ra['bust'] else ''}) vs {b} {rb['score']:.2f} (net {rb['net']:.0f}, dd {rb['dd']:.0f}{', BUST' if rb['bust'] else ''}) → {w} advances ({why})", w, key)
        print(key, a, E.brief_s(ra) if hasattr(E, 'brief_s') else ra['score'], '|', b, rb['score'], '→', w, flush=True)
    pool = list(winners) + list(s.get('byes', []) if key == 'R1' else [])
    for t, tt in s['teams'].items():
        pass
    for l, _, _ in losers: s['teams'][l]['status'] = 'eliminated'
    nxt = ri + 1
    if key == 'R1':
        losers.sort(key=lambda x: (-x[1], -x[2])); size = 8; extra = []
        for l, sc, nt in losers:
            if len(pool) + len(extra) >= size: break
            extra.append(l); s['teams'][l]['status'] = 'qualified'
            log('second-chance', f'{l} re-enters as a best R1 loser (score {sc:.2f}, net {nt:.0f})', l, key)
        pool_ids = pool + extra; rng = random.Random(SEED + 1); rng.shuffle(pool_ids)
        nm = br['rounds'][1]['matches']
        for i in range(0, len(pool_ids) - 1, 2):
            nm[i // 2].update(teamA=pool_ids[i], teamB=pool_ids[i + 1], secondA=pool_ids[i] in extra, secondB=pool_ids[i + 1] in extra)
        br['rounds'][1]['matches'] = nm[:len(pool_ids) // 2]
    elif nxt < len(names):
        pool_ids = pool; nm = br['rounds'][nxt]['matches']
        for i in range(0, len(pool_ids) - 1, 2): nm[i // 2].update(teamA=pool_ids[i], teamB=pool_ids[i + 1])
        br['rounds'][nxt]['matches'] = nm[:max(1, len(pool_ids) // 2)]
    else:
        s['teams'][pool[0]]['status'] = 'champion'; log('champion', f'{pool[0]} is the champion', pool[0], key)
    for tid in pool: 
        if s['teams'][tid]['status'] not in ('champion',): s['teams'][tid]['status'] = 'qualified'
    s['phase_index'] = 3 + ri + 1 if key != 'F' else 7
    s['phase_label'] = f"{R['name']} complete" + ('' if key == 'F' else f" — next: {br['rounds'][nxt]['name']}")
    jsave(BRACKET, br); jsave(STATE, s); board()

def board():
    import build_dashboard; build_dashboard.build()

if __name__ == '__main__':
    c = sys.argv[1]
    {'gate': gate, 'draw': draw, 'board': board}.get(c, lambda: run_round(sys.argv[2]))()
