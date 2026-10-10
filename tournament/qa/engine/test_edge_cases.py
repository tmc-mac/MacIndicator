"""QA-Engine edge-case unit tests with hand-built bar arrays.  Each test states the expected values derived BY HAND from the
written rules, then asserts the production kernel (engine.run) and the QA reference (refsim) against them.
status: PASS = kernel == spec; FAIL = kernel deviates from spec (defect, see REPORT.md ID); CONV = convention differs from the
strict reading but is documented/benign (reported, not a failure).
Run:  python test_edge_cases.py
"""
import sys, os, types, tempfile, datetime as dt, zoneinfo
os.environ['TOURNAMENT_COORDINATOR'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..', '..', 'engine')); sys.path.insert(0, HERE)
import numpy as np, engine as E, refsim as RS

NAN = float('nan'); BIG = 10**9; MULT = 2.0     # $2/pt (MNQ); q=10 -> $20 per point


def mkdata(bars, day=None, mult=MULT, t0=1_700_000_000):
    o, h, l, c = (np.array(x, float) for x in zip(*bars)); n = len(o)
    return types.SimpleNamespace(ts=t0 + 60 * np.arange(n, dtype=np.int64), o=o, h=h, l=l, c=c, v=np.ones(n),
                                 day=np.asarray(day if day is not None else np.zeros(n), np.int64), mult=mult, n=n)


def S(bar, side=1, stop=None, kind=0, px=NAN, target=NAN, exit_by=BIG, cancel_by=BIG, q=10):
    return dict(bar=bar, side=side, kind=kind, px=px, stop=stop, target=target, exit_by=exit_by, cancel_by=cancel_by, contracts=q)


def mksig(items):
    f = lambda k: [it[k] for it in items]
    return E.make_signals(f('bar'), f('side'), f('kind'), f('px'), f('stop'), f('target'), f('exit_by'), f('cancel_by'), f('contracts'))


def run_both(bars, items, day=None, enforce=True, slip=1.0, stop_on_pass=False, i0=0, i1=None, mode='mimic'):
    d = mkdata(bars, day); sig = mksig(items); i1 = d.n if i1 is None else i1
    k = E.run(d, sig, i0, i1, enforce=enforce, slip=slip, stop_on_pass=stop_on_pass)
    r = RS.simulate(RS.Ref(d), sig, i0, i1, enforce=enforce, slip=slip, stop_on_pass=stop_on_pass, mode=mode)
    return k, r, d


def trades_k(k): return [(int(t[0]), int(t[1]), int(t[2]), float(t[3]), float(t[4]), float(t[5]), int(t[7])) for t in k['tape']]
def trades_r(r): return [(t[0], t[1], t[2], t[3], t[4], t[5], t[7]) for t in r['trades']]
def close(a, b): return all(abs(x - y) < 1e-6 for x, y in zip(a[3:6], b[3:6])) and a[:3] == b[:3] and a[6] == b[6]

def expect(k, r, want):
    """want: list of (eb, xb, side, entry, exit, pnl, reason) ; check kernel and mimic-ref both."""
    tk, tr = trades_k(k), trades_r(r)
    assert len(tk) == len(want), f'kernel trade count {len(tk)} != {len(want)}: {tk}'
    assert len(tr) == len(want), f'ref trade count {len(tr)} != {len(want)}: {tr}'
    for a, b, w in zip(tk, tr, want):
        assert close(a, w), f'kernel {a} != expected {w}'
        assert close(b, w), f'ref {b} != expected {w}'

RES = []
def test(name, kind_on_fail='FAIL', bug=None):
    def deco(fn):
        try:
            fn(); RES.append((name, 'PASS', '', bug))
        except AssertionError as e:
            RES.append((name, kind_on_fail, str(e)[:300], bug))
        except Exception as e:
            RES.append((name, 'ERROR', repr(e)[:300], bug))
        return fn
    return deco

F = [(100, 100.5, 99.5, 100)]*0     # (unused)
def flat(n, p=100.0, rng=0.5): return [(p, p + rng, p - rng, p)] * n

# ---------------------------------------------------------------- 1. fills
@test('01 market long: next-bar open + 1 tick; stop fill = stop - 1 tick')
def _():
    bars = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100), (100, 100.5, 97.0, 98), (98, 98.5, 97.5, 98)]
    k, r, _d = run_both(bars, [S(0, 1, stop=98.0)])
    # entry bar1 open 100 + .25 = 100.25 ; stop bar2 low 97<=98 -> exit 98-.25=97.75 ; pnl=(97.75-100.25)*2*10=-50
    expect(k, r, [(1, 2, 1, 100.25, 97.75, -50.0, 1)])

@test('02 market short mirror: entry open-1tick, stop+1tick')
def _():
    bars = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100), (100, 103, 99.5, 102), (102, 102.5, 101.5, 102)]
    k, r, _d = run_both(bars, [S(0, -1, stop=102.0)])
    expect(k, r, [(1, 2, -1, 99.75, 102.25, -50.0, 1)])

@test('03 gap through stop fills at the OPEN (worse than stop) minus slippage')
def _():
    bars = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100), (95, 96, 94, 95), (95, 95.5, 94.5, 95)]
    k, r, _d = run_both(bars, [S(0, 1, stop=98.0)])
    expect(k, r, [(1, 2, 1, 100.25, 94.75, (94.75 - 100.25) * 20, 1)])

@test('04 stop and target hit in the SAME bar -> stop first')
def _():
    bars = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100), (100, 106, 97, 101), (101, 101.5, 100.5, 101)]
    k, r, _d = run_both(bars, [S(0, 1, stop=98.0, target=105.0)])
    expect(k, r, [(1, 2, 1, 100.25, 97.75, -50.0, 1)])

@test('05 target needs 1-tick trade-through: high==target no fill; high==target+tick fills AT target')
def _():
    base = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100)]
    k, r, _d = run_both(base + [(100, 105.0, 100, 104), (104, 104.5, 103.5, 104)], [S(0, 1, stop=98.0, target=105.0, exit_by=3)])
    expect(k, r, [(1, 3, 1, 100.25, 104.0, (104 - 100.25) * 20, 5)])           # target merely touched -> time exit at close of bar3
    k, r, _d = run_both(base + [(100, 105.25, 100, 104), (104, 104.5, 103.5, 104)], [S(0, 1, stop=98.0, target=105.0, exit_by=3)])
    expect(k, r, [(1, 2, 1, 100.25, 105.0, (105 - 100.25) * 20, 2)])

@test('06 short target mirror (low must be target-1tick)')
def _():
    base = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100)]
    k, r, _d = run_both(base + [(100, 100, 95.0, 96), (96, 96.5, 95.5, 96)], [S(0, -1, stop=102.0, target=95.0, exit_by=3)])
    expect(k, r, [(1, 3, -1, 99.75, 96.0, (99.75 - 96) * 20, 5)])
    k, r, _d = run_both(base + [(100, 100, 94.75, 96), (96, 96.5, 95.5, 96)], [S(0, -1, stop=102.0, target=95.0, exit_by=3)])
    expect(k, r, [(1, 2, -1, 99.75, 95.0, (99.75 - 95) * 20, 2)])

@test('07 limit buy NOT filled when price only touches the limit; filled at limit when it trades 1 tick through')
def _():
    bars = [(100, 100.5, 99.5, 100), (100, 100.5, 99.5, 100), (100, 100.5, 99.0, 100), (100, 100.5, 98.75, 100), (100, 100.5, 99.5, 100)]
    # limit 99.0 : bar2 low == 99.0 (touch) -> no fill ; bar3 low 98.75 = lim-tick -> fills at 99.0
    k, r, _d = run_both(bars, [S(0, 1, stop=95.0, kind=1, px=99.0, exit_by=4)])
    expect(k, r, [(3, 4, 1, 99.0, 100.0, (100 - 99.0) * 20, 5)])
    # only touched, cancel window ends -> never filled
    k, r, _d = run_both(bars, [S(0, 1, stop=95.0, kind=1, px=99.0, cancel_by=2)])
    assert k['trades'] == 0 and len(r['trades']) == 0

@test('08 limit buy: bar OPENS below the limit -> fill at the open (price improvement); sell mirror')
def _():
    bars = [(100, 100.5, 99.5, 100), (98.0, 98.5, 97.5, 98), (98, 98.5, 97.5, 98)]
    k, r, _d = run_both(bars, [S(0, 1, stop=95.0, kind=1, px=99.0, exit_by=2)])
    expect(k, r, [(1, 2, 1, 98.0, 98.0, 0.0, 5)])
    bars = [(100, 100.5, 99.5, 100), (102.0, 102.5, 101.5, 102), (102, 102.5, 101.5, 102)]
    k, r, _d = run_both(bars, [S(0, -1, stop=105.0, kind=1, px=101.0, exit_by=2)])
    expect(k, r, [(1, 2, -1, 102.0, 102.0, 0.0, 5)])

@test('09 limit sell needs high >= px+tick; touch is not a fill')
def _():
    bars = [(100, 100.5, 99.5, 100), (100, 101.0, 99.5, 100), (100, 101.25, 99.5, 100), (100, 100.5, 99.5, 100)]
    k, r, _d = run_both(bars, [S(0, -1, stop=105.0, kind=1, px=101.0, exit_by=3)])
    expect(k, r, [(2, 3, -1, 101.0, 100.0, (101 - 100.0) * 20, 5)])

@test('10 time exit = that bar close, no slippage, bar(exit_by) included')
def _():
    bars = flat(6)
    bars[3] = (100, 101, 99.9, 100.75)
    k, r, _d = run_both(bars, [S(0, 1, stop=90.0, exit_by=3)])
    expect(k, r, [(1, 3, 1, 100.25, 100.75, 0.5 * 20, 5)])

@test('11 signal during an open trade is ignored; signal decided ON the exit bar is accepted (enters next bar)')
def _():
    bars = flat(10)
    bars[4] = (100, 100.5, 97.0, 98)                         # stop bar for trade 1 (stop 98)
    items = [S(0, 1, stop=98.0), S(2, 1, stop=90.0, exit_by=6), S(4, 1, stop=90.0, exit_by=7)]
    k, r, _d = run_both(bars, items)
    tk = trades_k(k)
    assert [t[0] for t in tk] == [1, 5] and [t[1] for t in tk] == [4, 7], tk
    assert [t[0] for t in trades_r(r)] == [1, 5]

@test('12 invalid stop (>= entry for long) -> signal skipped')
def _():
    k, r, _d = run_both(flat(5), [S(0, 1, stop=100.5)])
    assert k['trades'] == 0 and len(r['trades']) == 0

@test('13 window edges: signal on bar i0-1 enters at i0; signal on bar i1-1 would enter at i1 -> skipped')
def _():
    bars = flat(10)
    k, r, _d = run_both(bars, [S(2, 1, stop=90, exit_by=9)], i0=3, i1=8)
    assert [t[0] for t in trades_k(k)] == [3]
    k, r, _d = run_both(bars, [S(7, 1, stop=90, exit_by=9)], i0=3, i1=8)
    assert k['trades'] == 0

@test('14 forced flat at window end = close of last bar of the window')
def _():
    bars = flat(10); bars[7] = (100, 100.5, 99.5, 100.5)
    k, r, _d = run_both(bars, [S(0, 1, stop=90)], i0=0, i1=8)
    expect(k, r, [(1, 7, 1, 100.25, 100.5, 0.25 * 20, 5)])

# ---------------------------------------------------------------- 2. account rules
@test('20 DLL mid-trade: flatten at exactly -1250 from session start, account survives, rest of session paused, next session trades')
def _():
    n = 14
    bars = flat(n); day = [0] * 8 + [1] * 6
    bars[3] = (100, 100.5, 90.0, 91.0)                       # 100.25 -> -62.5pts = -1250  => DLL price 100.25-62.5=37.75?? (see below)
    # $20/pt -> 1250 = 62.5 pts: use a big bar
    bars = flat(n); bars[3] = (100, 100.5, 30.0, 31.0); bars[4] = (31, 31.5, 30.5, 31)
    for i in range(5, n): bars[i] = (31, 31.5, 30.5, 31)
    items = [S(0, 1, stop=10.0), S(5, 1, stop=5.0, exit_by=6), S(8, 1, stop=5.0, exit_by=10)]
    k, r, _d = run_both(bars, items, day=day)
    # DLL price = 100.25 - 1250/20 = 37.75 ; pnl -1250
    tk = trades_k(k)
    assert tk[0][4] == 37.75 and abs(tk[0][5] + 1250) < 1e-9 and tk[0][6] == 4, tk[0]
    assert not k['bust']
    # signal on bar 5 (same session 0) must be ignored (paused); signal at bar 8 (session 1) taken
    assert [t[0] for t in tk] == [1, 9], tk
    assert [t[0] for t in trades_r(r)] == [1, 9]

@test('21 bust on the trailing floor AFTER the EOD peak rose (floor 49,000 < day-start-1250 so bust fires before DLL); exit at floor price; run stops')
def _():
    # $20/pt, q=10.  day0: trade A +1000 -> EOD peak 51,000, floor 49,000.  day1: trade B -1000 realised (eq 50,000 at day close).
    # day2: day_start=50,000: DLL level 48,750, floor 49,000 -> floor is touched first: bust price = 100.25 - 1000/20 = 50.25
    n = 16; bars = flat(n); day = [0] * 5 + [1] * 5 + [2] * 6
    bars[3] = (100, 150.5, 99.9, 150.25); bars[4] = (150.25, 150.5, 150, 150.25)
    bars[7] = (100, 100.5, 50.5, 50.25); bars[8] = (50.25, 50.5, 50.0, 50.25); bars[9] = (100, 100.5, 99.5, 100)
    bars[13] = (100, 100.5, 40.0, 41.0)
    items = [S(0, 1, stop=1.0, exit_by=3), S(5, 1, stop=1.0, exit_by=8), S(10, 1, stop=1.0, exit_by=15)]
    k, r, _d = run_both(bars, items, day=day)
    tk = trades_k(k)
    assert len(tk) == 3 and tk[0][5] == 1000.0 and tk[1][5] == -1000.0, tk
    assert k['bust'] and tk[2][6] == 3 and abs(tk[2][4] - 50.25) < 1e-9, tk
    assert r['bust'] and len(r['trades']) == 3

@test('22 EOD peak (not intraday peak) drives the floor: intraday spike that fades does NOT raise floor')
def _():
    # $20/pt, entry 10000.25 (market, bar1 open 10000).
    # day0 end mark: close 10050 -> EOD eq 50,995 -> floor 48,995.  day1: spike to 10100 (intraday eq 51,995) but closes 10000.25 (eq 50,000).
    # day2: low 9952 -> eq 49,035 (> 48,995, survive under EOD semantics; an intraday-peak floor of 49,995 would bust).  bar: low 9950 -> eq 48,995 -> BUST (<=).
    bars = [(10000, 10001, 9999, 10000), (10000, 10002, 9999, 10000), (10000, 10050, 9999, 10050),     # day0 : bars 0-2
            (10050, 10100, 10000, 10000.25), (10000.25, 10001, 10000, 10000.25),                       # day1 : bars 3-4
            (10000.25, 10001, 9952, 9960),                                                             # day2 : bar5 survives
            (9960, 9961, 9950.0, 9951)]                                                                # day2 : bar6 bust
    day = [0, 0, 0, 1, 1, 2, 2]
    k, r, _d = run_both(bars, [S(0, 1, stop=9000.0)], day=day)
    tk = trades_k(k)
    assert k['bust'] and tk[0][1] == 6 and tk[0][6] == 3 and abs(tk[0][4] - 9950.0) < 1e-9, tk
    assert r['bust'] and r['trades'][0][1] == 6
    # control: stop at 9952-> no bust but loss; and make bar6 low 9950.25 -> still alive (eq 49,000 > 48,995)
    bars2 = list(bars); bars2[6] = (9960, 9961, 9950.25, 9951)
    k2, r2, _d = run_both(bars2, [S(0, 1, stop=9000.0, exit_by=6)], day=day)
    assert not k2['bust'] and not r2['bust']

@test('23 within a session realised profit does NOT raise the floor (EOD peak): +1000 then -1250 from session start is DLL, not bust')
def _():
    n = 12; bars = flat(n); day = [0] * n
    bars[3] = (100, 150.5, 99.9, 150.25)                      # trade A +1000 (time exit bar 3)
    bars[4] = (150.25, 150.5, 150, 150.25)
    bars[5] = (100, 100.5, 99.5, 100)
    bars[7] = (100, 100.5, 30.0, 31)                           # trade B: entry 100.25 ; DLL when eq = 50,000-1250 = 48,750 => loss(B)=2250 => 112.5pts -> price <0.. use q=20
    items = [S(0, 1, stop=1.0, exit_by=3), S(5, 1, stop=1.0, exit_by=10, q=20)]
    # q=20 -> $40/pt ; eq = 51,000 + (p-100.25)*40 ; intraday-peak floor would be 49,000 (bust at p=50.25); DLL eq 48,750 => p = 100.25 - 2250/40 = 44.0
    bars[7] = (100, 100.5, 40.0, 41)          # eq at low = 51,000 + (40-100.25)*40 = 48,590: <= DLL level 48,750 but > floor 48,000
    k, r, _d = run_both(bars, items, day=day)
    tk = trades_k(k)
    assert not k['bust'] and tk[1][6] == 4 and abs(tk[1][4] - 44.0) < 1e-9, tk
    assert not r['bust']

@test('24 position held across a session roll: day id changes mid-trade, EOD marking uses prior-bar close, trade continues')
def _():
    bars = flat(8); day = [0, 0, 0, 0, 1, 1, 1, 1]
    bars[3] = (100, 100.5, 99.5, 101)
    k, r, _d = run_both(bars, [S(0, 1, stop=90.0, exit_by=6)], day=day)
    expect(k, r, [(1, 6, 1, 100.25, 100.0, (100.0 - 100.25) * 20, 5)])

@test('25 DLL measured from session-open equity incl. open mark carried across the roll')
def _():
    # day0 close mark +500 (eq 50,500, day_start for day1 = 50,500). day1: DLL at 49,250 => price drop 1750/20 = 87.5 from 125.25 ... use q=10
    n = 8; bars = flat(n, 100.0); day = [0, 0, 0, 0, 1, 1, 1, 1]
    bars[2] = (100, 125.5, 99.5, 125.25)                      # mark at day0 close (bar3 close) -> make bar 3 close 125.25
    bars[3] = (125.25, 125.5, 125.0, 125.25)
    bars[4] = (125.25, 125.5, 125.0, 125.25); bars[5] = (125.25, 125.5, 37.0, 38); bars[6] = (38, 38.5, 37.5, 38); bars[7] = (38, 38.5, 37.5, 38)
    # eq at close day0 = 50,000 + (125.25-100.25)*20 = 50,500 ; floor day0 = 48,500; DLL eq = 49,250 -> price 125.25-1250/20 = 62.75 ; floor 48,500 -> price 125.25 -(2000/20)... bust price=100.25-... 
    k, r, _d = run_both(bars, [S(0, 1, stop=1.0)], day=day)
    tk = trades_k(k)
    assert tk[0][6] == 4 and abs(tk[0][4] - 62.75) < 1e-9, tk

@test('26 PASS is detected on CLOSED-trade equity only: unrealised > +3000 then retrace = no pass; stop_on_pass halts after pass trade')
def _():
    n = 14; bars = flat(n)
    bars[2] = (100, 300.0, 99.5, 120)                         # huge unrealised high, then trade closes small
    bars[3] = (120, 120.5, 119.5, 120)
    bars[6] = (100, 220.0, 99.5, 200.25)                       # trade 2 closes with +100pts*20 = +2000 ... need +3000 total
    items = [S(0, 1, stop=50.0, exit_by=3), S(4, 1, stop=50.0, exit_by=6, q=30)]
    k, r, _d = run_both(bars, items)
    # trade1: 100.25->120 : +395 ; unrealised peak ~ +3995 yet equity >= 53,000 only via closed pnl
    assert trades_k(k)[0][5] == (120 - 100.25) * 20 and not (k['final_equity'] - 50000 < 0)
    # trade2 +100pts*60 = +6000 -> closed equity 56,395 >=53,000 -> passed; check pass flag + time
    assert k['passed'] and r['passed']
    kk, rr, _d = run_both(bars, items + [S(7, 1, stop=50.0, exit_by=9)], stop_on_pass=True)
    assert len(trades_k(kk)) == 2 and len(rr['trades']) == 2, 'stop_on_pass must stop after the passing trade'
    ks, rs, _d = run_both(bars, items + [S(7, 1, stop=50.0, exit_by=9)], stop_on_pass=False)
    assert len(trades_k(ks)) == 3

@test('27 pass via closed trade only: trade with big open profit that retraces below +3000 -> not passed')
def _():
    bars = flat(8); bars[2] = (100, 300, 99.5, 101); bars[3] = (101, 101.5, 100.5, 101)
    k, r, _d = run_both(bars, [S(0, 1, stop=50.0, exit_by=3, q=40)])
    assert not k['passed'] and not r['passed']

# ---------------------------------------------------------------- 3. known/suspected defects (assert SPEC behaviour)
@test('30 [BUG-1] stop-loss larger than the DLL/floor is filled at the stop with NO bust / NO DLL pause', bug='BUG-1')
def _():
    # $20/pt, entry 100.25, stop 0.25 away from -2010: stop 100 pts below -> loss 2010 > 2000 (trailing max DD) in ONE trade
    n = 8; bars = flat(n, 200.0); bars[2] = (200, 200.5, 99.0, 100); bars[3] = (100, 100.5, 99.5, 100)
    k, r, _d = run_both(bars, [S(0, 1, stop=100.0)], mode='strict')
    tk = trades_k(k)
    assert k['bust'], f'kernel did not flag bust although a single trade lost {tk[0][5]:.0f} (> $2,000 trailing limit); final eq {k["final_equity"]:.0f}'

@test('31 [BUG-1b] stop loss (-1815) > DLL: no pause, no flatten at -1250; the NEXT same-session trade is DLL-exited at a PHANTOM GAIN', bug='BUG-1')
def _():
    n = 14; bars = flat(n, 200.0); day = [0] * n
    bars[2] = (200, 200.5, 138.0, 140); bars[3] = (140, 140.5, 139.5, 140)
    for i in range(4, n): bars[i] = (200, 200.5, 199.5, 200)
    items = [S(0, 1, stop=140.0, q=5), S(4, 1, stop=100.0, exit_by=9, q=5)]
    k, r, _d = run_both(bars, items, day=day)
    tk = trades_k(k)
    # trade1: 200.25 -> 139.75 : -60.5*10 = -605 (q=5 -> $10/pt)  not > DLL; scale: use q=15 -> -1815
    items = [S(0, 1, stop=140.0, q=15), S(4, 1, stop=100.0, exit_by=9, q=15)]
    k, r, _d = run_both(bars, items, day=day)
    tk = trades_k(k)
    assert len(tk) == 2, tk
    assert tk[0][5] < -1250, tk[0]
    assert tk[1][5] <= 0, f'2nd trade pnl {tk[1][5]:+.1f} (reason {tk[1][6]}) is a phantom gain created by the DLL/bust exit formula after realised equity already breached'

@test('33 [CONV-limit-fillbar-target] limit entry + target on the SAME bar as the fill is credited (intrabar order unknown)', kind_on_fail='CONV', bug='CONV-A')
def _():
    bars = [(100, 100.5, 99.5, 100), (101, 106, 99.5, 105), (105, 105.5, 104.5, 105)]
    k, r, _d = run_both(bars, [S(0, 1, stop=95.0, kind=1, px=100.0, target=105.0, exit_by=2)])
    t = trades_k(k)
    assert not (len(t) and t[0][6] == 2 and t[0][0] == t[0][1]), 'target credited on limit-fill bar: bar high may have preceded the dip that filled the limit'

@test('34 [CONV-pending] an UNFILLED pending limit order does not block a later signal inside its cancel window', kind_on_fail='CONV', bug='CONV-B')
def _():
    bars = flat(12)
    items = [S(0, 1, stop=80.0, kind=1, px=90.0, cancel_by=9), S(3, 1, stop=80.0, exit_by=6)]
    k, r, _d = run_both(bars, items)
    assert k['trades'] == 0, 'spec: signals are ignored while a pending order exists; kernel took the 2nd signal'

@test('35 [CONV-time-exit-slip] time exit has no slippage although it is a market exit', kind_on_fail='CONV', bug='CONV-C')
def _():
    bars = flat(6); k, r, _d = run_both(bars, [S(0, 1, stop=90.0, exit_by=3)])
    assert trades_k(k)[0][4] == 99.75, f'time exit at {trades_k(k)[0][4]} (close=100.0, market exit would be 99.75 with 1 tick)'

@test('36 [DOC] contracts==0 signal: brief says engine floors at 1, kernel skips signal', kind_on_fail='CONV', bug='DOC-1')
def _():
    k, r, _d = run_both(flat(5), [S(0, 1, stop=90.0, q=0)])
    assert k['trades'] == 1, 'TEAM_BRIEF_V2 says "the engine floors contracts at 1"; kernel silently drops q<1 (and make_signals truncates floats to int)'

@test('37 [DOC] exit_by < entry bar silently means "hold to window end" (no time exit)', kind_on_fail='CONV', bug='DOC-2')
def _():
    bars = flat(10); k, r, _d = run_both(bars, [S(3, 1, stop=90.0, exit_by=0)])
    assert trades_k(k)[0][1] == 4, 'exit_by in the past: kernel holds to end of window'

@test('38 [CONV-gap-DLL] DLL gap: kernel exits at DLL level even if the bar opened beyond it (optimistic by the gap)', kind_on_fail='CONV', bug='CONV-D')
def _():
    bars = flat(8); bars[3] = (30.0, 30.5, 29.5, 30.0)           # gap from ~100 to 30
    k, r, _d = run_both(bars, [S(0, 1, stop=1.0)])
    t = trades_k(k)[0]
    assert t[4] <= 30.0, f'exited at {t[4]} but the market opened at 30.0'

@test('39 [CONV-bust-vs-DLL] one bar spans BOTH the DLL level and the trailing floor: kernel books BUST, price-path order says DLL first (flatten, survive)', kind_on_fail='CONV', bug='CONV-E')
def _():
    n = 12; bars = flat(n); day = [0] * n
    bars[3] = (100, 150.5, 99.9, 150.25); bars[4] = (150.25, 150.5, 150, 150.25)
    bars[7] = (100, 100.5, 20.0, 21)
    k, r, _d = run_both(bars, [S(0, 1, stop=1.0, exit_by=3), S(5, 1, stop=1.0, exit_by=10, q=20)], day=day)
    assert not k['bust'], 'kernel busts when a single bar covers both thresholds; the DLL level (higher) is touched first and would have flattened the position'

# ---------------------------------------------------------------- 4. session-day / DST
def _expected_session(utc_epoch):
    ny = dt.datetime.fromtimestamp(utc_epoch, zoneinfo.ZoneInfo('America/New_York'))
    return (ny.replace(tzinfo=None) + dt.timedelta(hours=7)).date()

@test('40 session-day: 17:00 ET roll (EST and EDT), Sunday 18:00 open, DST switch weekends -- kernel Data vs zoneinfo vs refsim')
def _():
    NY = zoneinfo.ZoneInfo('America/New_York')
    stamps = []
    for y, m, d_, hh, mm in [(2024, 3, 8, 16, 59), (2024, 3, 8, 17, 0), (2024, 3, 10, 18, 0), (2024, 3, 11, 16, 59), (2024, 3, 11, 17, 0),
                             (2024, 11, 1, 16, 59), (2024, 11, 1, 17, 0), (2024, 11, 3, 18, 0), (2024, 11, 4, 16, 59), (2024, 11, 4, 17, 0),
                             (2025, 1, 15, 16, 59), (2025, 1, 15, 17, 0), (2025, 7, 15, 16, 59), (2025, 7, 15, 17, 0), (2024, 3, 10, 1, 59), (2024, 3, 10, 3, 0)]:
        stamps.append(int(dt.datetime(y, m, d_, hh, mm, tzinfo=NY).timestamp()))
    ts = np.array(stamps, np.int64)
    p = os.path.join(tempfile.mkdtemp(), 'x.npz'); n = len(ts); z = np.ones(n)
    np.savez(p, ts=ts, o=z, h=z, l=z, c=z, v=z)
    dd = E.Data('NQ', p)
    exp = np.array([(_expected_session(int(t)) - dt.date(1970, 1, 1)).days for t in ts])
    mine = RS.session_day(ts)
    bad = [(dt.datetime.fromtimestamp(int(t), NY).strftime('%Y-%m-%d %H:%M %Z'), int(a), int(b), int(c)) for t, a, b, c in zip(ts, dd.day, exp, mine) if not (a == b == c)]
    assert not bad, f'mismatches (time, kernel, zoneinfo, refsim): {bad}'
    # 16:59 -> same date ; 17:00 -> next date
    assert dd.day[1] == dd.day[0] + 1 and dd.day[4] == dd.day[3] + 1 and dd.day[2] == dd.day[0] + 3   # Sun 18:00 -> Monday session
    # ET minute-of-day also correct across DST
    assert list(dd.minute_of_day_et[:2]) == [16 * 60 + 59, 17 * 60]

@test('41 session-day over the FULL NQ+ES arrays: kernel Data.day == independent numpy/zoneinfo-free implementation')
def _():
    for nm in ('NQ', 'ES'):
        d = E.load(nm, phase='dev')
        mine = RS.session_day(d.ts)
        assert np.array_equal(mine, d.day), f'{nm}: {np.sum(mine != d.day)} bars differ'

# ---------------------------------------------------------------- 5. combine harness
@test('50 combine(): number of starts / censoring off-by-one (start whose 60 sessions are all present is excluded when k+60==n_sessions)', bug='LOW-1', kind_on_fail='FAIL')
def _():
    # 63 sessions, 3 bars each; step=3, max_days=60.  Starts at session 0 and 3 both have 60 FULL sessions available (3..62).
    ns = 63; n = ns * 3; bars = flat(n); day = np.repeat(np.arange(ns), 3)
    d = mkdata(bars, day); sig = mksig([S(0, 1, stop=90.0, exit_by=1)])
    rows = E.combine(d, sig, 0, n)
    assert len(rows) == 2, f'kernel gives {len(rows)} starts, start k=3 (sessions 3..62 = exactly 60 sessions) is dropped'

@test('51 combine(): start with fresh equity each time; bust in one start does not leak into next', bug=None)
def _():
    ns = 130; n = ns * 3; bars = flat(n); day = np.repeat(np.arange(ns), 3)
    bars[1] = (100, 100.5, 30.0, 31); bars[2] = (31, 31.5, 30.5, 31)
    d = mkdata(bars, day); sig = mksig([S(0, 1, stop=1.0, q=40)])
    rows = E.combine(d, sig, 0, n)
    assert rows[0][1] == 'bust' and all(r[1] == 'timeout' for r in rows[1:]), [r[1] for r in rows[:6]]

@test('52 combine(): open trade at the end of the 60-session window is force-closed at the last bar and CAN be scored as a PASS', bug='LOW-2', kind_on_fail='CONV')
def _():
    ns = 70; n = ns * 3; bars = flat(n); day = np.repeat(np.arange(ns), 3)
    last = 60 * 3 - 1
    bars[last] = (100, 400, 99.5, 300)                      # last bar of the 60-session window closes +200pts
    d = mkdata(bars, day); sig = mksig([S(10, 1, stop=1.0, q=40)])
    rows = E.combine(d, sig, 0, n)
    assert rows[0][1] != 'pass', 'start counted PASS purely from the forced end-of-window flatten'

if __name__ == '__main__':
    w = max(len(r[0]) for r in RES)
    for name, st, det, bug in RES:
        print(f'{st:5s} {name}' + (f'\n        -> {det}' if det else ''))
    print('\nSUMMARY:', {s: sum(1 for r in RES if r[1] == s) for s in ('PASS', 'FAIL', 'CONV', 'ERROR')})
