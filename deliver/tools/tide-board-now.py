import json, time
s = json.load(open('/opt/mac-bot/bias-snapshot-MNQ.json'))
t = s.get('tide') or {}
age = round(time.time() - (s.get('updated') or 0) / 1000)
print('snapshot age', age, 's | tide.mode', t.get('mode'), '| tide keys', sorted(t.keys()))
b = t.get('board')
if not isinstance(b, dict):
    print('board is', 'MISSING (key absent)' if 'board' not in t else 'null (this write skipped it)')
    raise SystemExit
print('price', b.get('price'), '| 4H open', b.get('O4'), '| control', b.get('control'), '| levels', len(b.get('levels') or []))
lv = [l for l in b.get('levels') or [] if l.get('state') in ('armed', 'retest-pending')]
for l in lv:
    p = l.get('plan') or {}
    d = (l['price'] - b['price']) if b.get('price') else 0
    print(f"{l.get('state'):15} {l.get('name')} {l.get('price')} ({d:+.2f} pts) dir={l.get('dir')} setup={l.get('setup')} entry={p.get('entry')} stop={p.get('stop')} blocked={[x.get('code') for x in l.get('blockedBy') or []]}")
if not lv:
    print('no armed / retest-pending setup right now')
print('--- nearest 10 levels the engine is tracking ---')
near = sorted([l for l in b.get('levels') or [] if isinstance(l.get('price'), (int, float))], key=lambda l: abs(l['price'] - (b.get('price') or 0)))[:10]
for l in near:
    d = l['price'] - (b.get('price') or 0)
    print(f"{l.get('name','?'):14} {l['price']:>10} ({d:+8.2f} pts) state={l.get('state')} retest#={l.get('retestNo')} why_not={[x.get('code') for x in l.get('blockedBy') or []]}{' target-only' if l.get('targetOnly') else ''}")
