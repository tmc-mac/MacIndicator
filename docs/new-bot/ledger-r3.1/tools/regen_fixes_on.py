#!/usr/bin/env python3
"""Regenerates tide/study/fixes_on/setups.csv (missing from the scratchpad; quant.py / risk.py read it) with the study's own
tide_setups.py run(), FIXES-ON cfg exactly as its __main__ does, into the ledger's proxy_root. Read-only on the study dir."""
import sys, os, importlib.util
S, OUT = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location('tide_setups', os.path.join(S, 'tide/study/tide_setups.py'))
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)
FIX = dict(M.DEFAULT, fixes=True)
o = M.run(os.path.join(S, 'replay1104/data'), OUT, FIX, do_grid=False)
M.write_results(OUT, *o, M.xcheck_from_ref(os.path.join(S, 'tide/study')), label='FIXES-ON (regenerated for the MacStructure ledger)', cfg=FIX)
print('setups', len(o[2]), 'taken', sum(1 for x in o[2] if x['taken']))
