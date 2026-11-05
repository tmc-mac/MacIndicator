#!/usr/bin/env python3
# MacUI-C 2.0.9.24: the trade-row fixture t24-tide1105 (SYNTHETIC, shaped after today's live journal, 11/05): four bot trades of one TradeDay as the
# broker sees them (recentTrades, the old list's wrong sizes kept on purpose) and as the bot journals them (tide.rows signal / setup_arm / live_fill,
# tide.trades for the three closed in the ring). Base: t23-pnl1105. Usage: build-fixtures-20924.py <fixtures/states>
import json, os, sys, copy, datetime
D = sys.argv[1]
def load(s): return json.load(open(os.path.join(D, s, 'bias-snapshot-MNQ.json')))
def meta(s): return json.load(open(os.path.join(D, s, 'meta.json')))
def save(name, snap, m, note):
    p = os.path.join(D, name); os.makedirs(p, exist_ok=True)
    json.dump(snap, open(os.path.join(p, 'bias-snapshot-MNQ.json'), 'w'), separators=(',', ':'))
    mm = dict(m); mm['name'] = name; mm['synthetic'] = True; mm['note'] = 'MacUI-C 2.0.9.24 SYNTHETIC: ' + note
    json.dump(mm, open(os.path.join(p, 'meta.json'), 'w'), indent=1); open(os.path.join(p, 'trade-journal-MNQ.jsonl'), 'w').write('')
    print('wrote', name, 'clock', mm['clock'])
PT = -8 * 3600 * 1000
def pt(hhmm, day='11-03'):
    h, m = hhmm.split(':'); mo, dd = day.split('-')
    return int(datetime.datetime(2026, int(mo), int(dd), int(h), int(m), tzinfo=datetime.timezone.utc).timestamp() * 1000 - PT)
def iso(t): return datetime.datetime.fromtimestamp(t / 1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
def hm(t): return datetime.datetime.fromtimestamp((t + PT) / 1000, datetime.timezone.utc).strftime('%H:%M')
def row(phase, t, **kw):
    r = {'type': 'lv_tide', 't': t, 'version': 'tide-wire-r2.5-live', 'phase': phase, 'engine': 'tide-structure-r3.3', 'shadow': False, 'at': '11-03 ' + hm(t)}
    r.update(kw); return r
def sig(id_, t, dir_, kind, level, lp, entry, stop, tp1, tp2, grade='B', pts=3, taken=True, why='taken: 4H control + trap at the level', gates=None, orders=None):
    r = row('signal', t, order='placed', id=id_, setup=id_.split('-')[0], leg='entry', dir=dir_, side='LONG' if dir_ == 1 else 'SHORT', kind=kind, level=level, levelPrice=lp, entryType='MARKET', entry=entry, taken=taken, gatesNow='ALL PASS',
            gates=gates or {'control4h': True, 'htf': True, 'displacement': True, 'time': True}, takenWhy=why, htf='with', htfDir=dir_,
            plan={'mode': 'flat', 'budgetUsd': 400, 'grade': grade, 'gradeDetail': {'grade': grade, 'points': pts, 'names': ['control', 'trap', 'htf'][:pts]}, 'stop': stop, 'stopTf': '1H', 'stopPts': abs(entry - stop), 'tp1': {'price': tp1, 'qty': 1, 'pool': {'name': 'ORH'}}, 'tp2': {'price': tp2, 'rr': 2, 'pool': {'name': 'PDL'}}})
    if orders: r['orderIds'] = orders
    return r
def fill(id_, t, leg, qty, price, oid):
    return row('live_fill', t, id=id_, setup=id_.split('-')[0], leg=leg, qty=qty, price=price, orderId=oid, side=None)

base = load('t23-pnl1105'); mb = meta('t23-pnl1105'); s = copy.deepcopy(base)
# the four trades (times PT, 11/03 in the fixture clock)
A = [  # S425-E 01:48 LONG 4H ORH 28,354.75 accepted-break 1 lot entry 28381.25, stop at BE 28381.25
  dict(id='S425-E', t=pt('01:48'), dir=1, kind='accepted-break', level='4H ORH', lp=28354.75, entry=28381.25, stop=28347.25, tp1=28401.5, tp2=28460.0, fills=[('entry', 1, 28381.25, '3727401001', pt('01:48')), ('stop', 1, 28381.25, '3727401002', pt('02:05'))], broker=dict(size=1, net=-1.34)),
  # S437-E 03:39 LONG 4H Open 28,430.50 trap 4 lots entry 28430, tp1 3@28443.75, stop 1@28430
  dict(id='S437-E', t=pt('03:39'), dir=1, kind='trap', level='4H Open', lp=28430.5, entry=28430.0, stop=28406.0, tp1=28443.75, tp2=28520.0, fills=[('entry', 4, 28430.0, '3727441001', pt('03:39')), ('tp1', 3, 28443.75, '3727441002', pt('03:44')), ('stop', 1, 28430.0, '3727441003', pt('04:02'))], broker=dict(size=4, net=79.52)),
  # S448-E 04:30 SHORT 4H Open 28,430.50 trap 2 lots, planned 28368.75, fill 28377.25, tp1 1@28361.75 (04:32), tp2 1@28235.75 (06:13)
  dict(id='S448-E', t=pt('04:30'), dir=-1, kind='trap', level='4H Open', lp=28430.5, entry=28368.75, stop=28392.0, tp1=28361.75, tp2=28235.75, fills=[('entry', 2, 28377.25, '3727482853', pt('04:30')), ('tp1', 1, 28361.75, '3727486648', pt('04:32')), ('tp2', 1, 28235.75, '3727486649', pt('06:13'))], broker=dict(size=2, net=309.26)),
  # 12:29 SHORT 1 lot @ 26886.25 stop 26886.00 tp2 26731.50 (+$200.34 broker net) — journal rows only, not yet in tide.trades
  dict(id='S512-E', t=pt('12:29'), dir=-1, kind='trap', level='NY ORL', lp=26890.0, entry=26886.25, stop=26902.0, tp1=26870.5, tp2=26731.5, fills=[('entry', 1, 26886.25, '3727612001', pt('12:29')), ('tp2', 1, 26731.5, '3727612002', pt('12:58'))], broker=dict(size=3, net=200.34), ring=False),
]
rows = s['tide']['rows'][:]; trades = []; rt = []
for a in A:
    rows.append(row('setup_arm', a['t'] - 300000, setup=a['id'].split('-')[0], kind=a['kind'], dir=a['dir'], zone=a['level'], level=a['lp'], stopType='1H', event='SETUP_ARM'))
    rows.append(sig(a['id'], a['t'], a['dir'], a['kind'], a['level'], a['lp'], a['entry'], a['stop'], a['tp1'], a['tp2']))
    for leg, q, p, oid, t in a['fills']: rows.append(fill(a['id'], t, leg, q, p, oid))
    ent = a['fills'][0]; xs = a['fills'][1:]; xq = sum(q for _, q, _, _, _ in xs); xavg = sum(q * p for _, q, p, _, _ in xs) / xq
    if a.get('ring', True):
        trades.append({'id': a['id'], 'signalId': a['id'], 'setup': a['id'].split('-')[0], 'dir': a['dir'], 'qty': ent[1], 'avgEntry': ent[2], 'openedAt': ent[4], 'closedAt': xs[-1][4], 'exitAvgPx': round(xavg, 4), 'exitPath': xs[-1][0], 'tp1Done': any(l == 'tp1' for l, *_ in xs),
                       'path': ' · '.join(f'{l} {q}@{p}' for l, q, p, _, _ in xs), 'orderIds': [f[3] for f in a['fills']], 'grade': 'B', 'points': 3, 'resultR': round(sum((p - ent[2]) * q for _, q, p, _, _ in xs) * a['dir'] / xq / abs(a['entry'] - a['stop']), 2)})
    # the broker's round trip, with the old list's size (the 12:29 trade printed 3x)
    rt.append({'contractId': 'CON.F.US.MNQ.Z26', 'dir': a['dir'], 'entryTime': iso(ent[4] + 2000), 'entryPrice': ent[2], 'maxSize': a['broker']['size'], 'pnl': a['broker']['net'], 'closed': True, 'exitTime': iso(xs[-1][4]), 'entryAvgPrice': ent[2], 'exitPrice': round(xavg, 2), 'exitSize': a['broker']['size'], 'fees': 0.74 * a['broker']['size'], 'grossPnl': a['broker']['net'], 'commissions': 0.5 * a['broker']['size'], 'netPnl': a['broker']['net'], 'entryOrderId': ent[3], 'exitOrderId': xs[-1][3]})
rt.reverse()
s['tide']['rows'] = rows; s['tide']['trades'] = trades; s['recentTrades'] = rt
s['dayPnlNet'] = round(sum(a['broker']['net'] for a in A), 2); s['dayTrips'] = {'n': 4, 'sides': 14}
s['day'] = dict(s.get('day') or {}, rolling=s['dayPnlNet'])
clock = pt('13:00'); s['livePx'] = {'price': 26750.0, 't': clock}; s['tide']['board']['price'] = 26750.0
m = dict(mb); m['clock'] = clock; m['clockIso'] = iso(clock)
save('t24-tide1105', s, m, "four bot trades of one TradeDay shaped after the 11/05 live journal (S425-E, S437-E, S448-E, the 12:29 short) with their signal / setup_arm / live_fill rows, three in tide.trades; recentTrades carries the broker's view with the old list's sizes (the 12:29 trade as 3x)")
