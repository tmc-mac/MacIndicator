#!/usr/bin/env python3
# MacUI-D 2.0.9.25 SYNTHETIC fixtures from t24-tide1105 (clock 13:00 PT): t25-pnl (one day number), t25-idle-nodir / t25-idle-harm / t25-watch / t25-taken / t25-skip / t25-caps (the r1.6.1 trend rows, field names from lib/trendLane.js + tideWire.js r1.6.1). Usage: build-fixtures-20925.py <fixtures/states>
import json, os, sys, copy
D = sys.argv[1]
def load(s): return json.load(open(os.path.join(D, s, 'bias-snapshot-MNQ.json')))
def meta(s): return json.load(open(os.path.join(D, s, 'meta.json')))
def save(name, snap, m, note):
    p = os.path.join(D, name); os.makedirs(p, exist_ok=True)
    json.dump(snap, open(os.path.join(p, 'bias-snapshot-MNQ.json'), 'w'), separators=(',', ':'))
    mm = dict(m); mm['name'] = name; mm['synthetic'] = True; mm['note'] = 'MacUI-D 2.0.9.25 SYNTHETIC: ' + note
    json.dump(mm, open(os.path.join(p, 'meta.json'), 'w'), indent=1); open(os.path.join(p, 'trade-journal-MNQ.jsonl'), 'w').write('')
    print('wrote', name)
base = load('t24-tide1105'); M = meta('t24-tide1105'); C = M['clock']
s = copy.deepcopy(base); s['dayPnlNet'] = 1216.94; s['day']['rolling'] = 712.65; s['day']['balance'] = 150712.65; s['day']['realized'] = 712.65
save('t25-pnl', s, M, 'dayPnlNet 1216.94 (fills) vs day.rolling 712.65 (balance): one number everywhere, the balance named as the adjustment')
dirEv = {'prev4h': {'at': '11-03 09:00', 'o': 26950.25, 'c': 26790.5, 'dir': -1}, 'open4h': 26812.75, 'htfDir': -1}
h30 = {'open30': 26760.25, 'last30': {'at': '11-03 12:30', 'o': 26771.0, 'c': 26748.5, 'dir': -1}}
def row(phase, t, **kw):
    r = {'type': 'lv_tide', 't': t, 'version': 'tide-wire-r2.8-live', 'phase': phase, 'event': 'TREND_' + phase[6:].upper(), 'lane': 'trend', 'engine': 'tide-structure-r3.8', 'shadow': False, 'at': '11-03 12:55'}; r.update(kw); return r
def mk(name, rows, note):
    s = copy.deepcopy(base); s['tide']['rows'] = s['tide']['rows'] + rows; save(name, s, M, note)
mk('t25-idle-nodir', [row('trend_idle', C - 300000, why='no 4H direction (prior 4H flat)')], 'trend_idle: no 4H direction')
mk('t25-idle-harm', [row('trend_idle', C - 300000, why='30M not in harmony (last 30M closed against DIR at 11-03 12:30)', dirEv=dirEv, h30={'open30': 26760.25, 'last30': {'at': '11-03 12:30', 'o': 26740.0, 'c': 26771.0, 'dir': 1}})], 'trend_idle: 30M not in harmony')
arm = row('trend_arm', C - 300000, dir=-1, R=26755.5, kind='board', name='NY ORL', ext=26752.0, dirEv=dirEv, h30=h30)
mk('t25-watch', [arm], 'trend_arm at NY ORL 26,755.50: watching')
defb = {'t': C - 600000, 'at': '11-03 12:50', 'o': 26749.0, 'h': 26758.75, 'l': 26738.0, 'c': 26741.25, 'ext': 26758.75, 'wick': 9.75}
sigk = dict(id='TLS-1793739300', dir=-1, side='SHORT', entry=26741.25, stop=26779.25, stopPts=38.0, size=2, sizeCode='FLAT', R=26755.5, rKind='board', rName='NY ORL', def_=None, trigger='reject', dirEv=dirEv, h30=h30, climax=None, tp1=26700.0, tp2=26650.0)
def sig(taken, why, **kw):
    k = dict(sigk); k.pop('def_'); k.update(kw); r = row('trend_signal', C - 300000, **k); r['def'] = defb; r['taken'] = taken; r['why'] = why; return r
mk('t25-taken', [arm, sig(True, 'taken')], 'trend_signal taken: SHORT 26,741.25, stop 26,779.25, 2 MNQ')
mk('t25-skip', [arm, sig(False, 'PLAN GRADE_NO_FIT', size=0, sizeCode='GRADE_NO_FIT'), row('trend_skip', C - 300000, id='TLS-1793739300', dir=-1, entry=26741.25, stop=26941.25, stopPts=200.0, stopBasis='30m-wick', R=26755.5, code='GRADE_NO_FIT', why='stop 200 pts = $400 for 1 MNQ > $400 max: needed a better entry')], 'trend_signal skipped: GRADE_NO_FIT (size > 200 pts)')
mk('t25-caps', [arm, row('trend_skip', C - 300000, dir=-1, side='SHORT', trigger='reject', R=26755.5, rKind='board', rName='NY ORL', entry=26741.25, stop=26779.25, stopPts=38.0, dirEv=dirEv, h30=h30, why='CAP_HOUR: 2 trend entries this clock hour (cap 2)')], 'trend_skip: CAP_HOUR reached')
# t25-stale: t24-tide1105 + a rule-18 STALE setup_cancel row and an order_reject row / tide.lastReject (12:23 entry rejected: market halted)
s = copy.deepcopy(base)
s['tide']['rows'].append({'type': 'lv_tide', 't': C - 1800000, 'phase': 'setup_cancel', 'event': 'SETUP_CANCEL', 'setup': 'S470', 'kind': 'accepted-break', 'dir': -1, 'zone': 'PWH', 'level': 26990.0, 'why': 'STALE: 232.5 pts from the level (max 60); re-arms if price returns within 6 pts (rule 18)', 'shadow': False, 'at': '11-03 12:30'})
rj = {'t': C - 2220000, 'key': 'entry', 'kind': 'entry', 'side': 'SELL', 'qty': 2, 'type': 'market', 'price': None, 'reason': 'market halted', 'setup': 'S448', 'take': None, 'position': None}
s['tide']['rows'].append(dict(rj, type='lv_tide', phase='order_reject', shadow=False, at='11-03 12:23')); s['tide']['lastReject'] = rj
save('t25-stale', s, M, 't24-tide1105 + a rule-18 STALE setup_cancel row and an order_reject row / tide.lastReject')
