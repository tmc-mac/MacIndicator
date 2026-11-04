#!/usr/bin/env python3
"""sha256 of every pinned input and every output of the shadow ledger (relative paths). stdlib only."""
import sys, os, json, hashlib
LD = sys.argv[1]
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
groups = {'engine (structure under test)': ['../lib/structure.js'], 'inputs': [], 'fixtures': [], 'proxy inputs': [], 'tools': [], 'outputs': []}
for root, _, files in os.walk(LD):
    for f in sorted(files):
        p = os.path.relpath(os.path.join(root, f), LD)
        if '__pycache__' in p or p == 'MANIFEST.json' or p.startswith('r3.1' + os.sep): continue
        g = ('inputs' if p.startswith('inputs') else 'fixtures' if p.startswith('fixtures') else 'tools' if p.startswith('tools') else
             'proxy inputs' if p.startswith('proxy_root') and not p.startswith(os.path.join('proxy_root', 'tide', 'study', 'fixes_on')) else
             'outputs' if not p.startswith('proxy_root') or p.endswith(('setups.csv', 'readings.csv', 'near_misses.csv', 'ranaway.csv')) else 'outputs')
        groups[g].append(p)
out = {g: {p: {'sha256': sha(os.path.join(LD, p)), 'bytes': os.path.getsize(os.path.join(LD, p))} for p in sorted(ps)} for g, ps in groups.items()}
out['r3.1 accepted ledger (frozen, not regenerated)'] = {os.path.join('r3.1', f): {'sha256': sha(os.path.join(LD, 'r3.1', f))} for f in sorted(os.listdir(os.path.join(LD, 'r3.1')))}
print(json.dumps(out, indent=1))
