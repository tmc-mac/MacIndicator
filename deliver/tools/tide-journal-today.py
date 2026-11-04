#!/usr/bin/env python3
# tide-journal-today.py - READ ONLY. Prints every TIDE journal row (setup armed, retest, rejection, signal,
# skip, gate) since a PT time today, oldest first, in plain one-line form.
# usage: python3 tide-journal-today.py [HH:MM PT start, default 06:00] [bot dir, default /opt/mac-bot]
import json, sys, glob, os, datetime
start = sys.argv[1] if len(sys.argv) > 1 else '06:00'
d = sys.argv[2] if len(sys.argv) > 2 else '/opt/mac-bot'
PT = datetime.timedelta(hours=-8)
now = datetime.datetime.utcnow()
today_pt = (now + PT).date()
h, m = map(int, start.split(':'))
t0 = (datetime.datetime.combine(today_pt, datetime.time(h, m)) - PT).timestamp() * 1000
def pt(ms):
    try: return (datetime.datetime.utcfromtimestamp(ms / 1000) + PT).strftime('%H:%M:%S')
    except Exception: return '?'
files = sorted(glob.glob(os.path.join(d, 'levels-journal-MNQ-*.jsonl')))[-2:]
rows = []
for f in files:
    for line in open(f, errors='replace'):
        if '"lv_tide"' not in line: continue
        try: r = json.loads(line)
        except Exception: continue
        if r.get('type') != 'lv_tide': continue
        ts = r.get('at') or r.get('barT') or r.get('t') or 0
        if (r.get('t') or 0) < t0: continue
        rows.append((ts, r))
rows.sort(key=lambda x: x[1].get('t') or 0)
SKIP = {'type', 'phase', 't', 'at', 'barT', 'id', 'v', 'run', 'session'}
counts = {}
for ts, r in rows:
    ph = r.get('phase', '?')
    counts[ph] = counts.get(ph, 0) + 1
    if ph in ('live_step',) and not r.get('intents'): continue
    lvl = r.get('levelName') or r.get('level') or r.get('name') or ''
    px = r.get('levelPrice') or r.get('price') or ''
    side = r.get('side') or r.get('dir') or ''
    bits = []
    for k in ('kind', 'setup', 'state', 'taken', 'gatesNow', 'gateWhy', 'why', 'reason', 'code', 'skip', 'late', 'rebuilt', 'order'):
        if k in r and r[k] not in (None, '', [], {}): bits.append(f"{k}={json.dumps(r[k])[:80]}")
    p = r.get('plan') or {}
    if isinstance(p, dict) and p:
        bits.append('plan=' + ','.join(f"{k}:{p[k]}" for k in ('entry', 'stop', 'tp1', 'tp2', 'qty', 'first', 'grade', 'skip') if k in p))
    if not bits:
        extra = {k: v for k, v in r.items() if k not in SKIP}
        bits.append(json.dumps(extra)[:200])
    print(f"{pt(r.get('t') or 0)} PT  {ph:<12} {r.get('id','') or '':<8} {side:<6} {lvl} {px}  " + '  '.join(bits))
print(f"-- {len(rows)} TIDE rows since {start} PT in {', '.join(os.path.basename(x) for x in files)}; by phase: {counts}")
if not any(r.get('phase') == 'signal' for _, r in rows):
    print('-- NO signal rows in this window: the engine saw no completed setup (retest + rejection) to trade.')
