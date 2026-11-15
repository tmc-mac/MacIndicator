# usage: python3 -I check_formulas-fixed.py <dir> [journal.jsonl ...]
# <dir>: g-*.json written by tests/edge17-tests.js ({row, shadow}); each journal: a trade journal with post_exit and runner_shadow rows (joined by journalId).
# EVERY row must agree with the bot's runner_shadow: same <-> same; runner_stop points equal (tolerance TOL pts, minute resolution: shadow uses 20 s polls).
import json, sys, glob, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
sp = importlib.util.spec_from_file_location("office_formulas_fixed", os.path.join(os.path.dirname(os.path.abspath(__file__)), "office_formulas.py")); F = importlib.util.module_from_spec(sp); sp.loader.exec_module(F)
TOL = 10.0   # one runner step: the formula works on minute buckets, the shadow on 20 s polls; a mismatch inside one step is resolution, beyond it is a failure
pairs = []
for f in sorted(glob.glob(sys.argv[1] + '/g-*.json')):
    d = json.load(open(f)); pairs.append((d['name'], d['row'], d['shadow'], 0.01))
for j in sys.argv[2:]:
    rows = [json.loads(l) for l in open(j) if '"type":"post_exit"' in l or '"type":"runner_shadow"' in l]
    pe = {r['journalId']: r for r in rows if r['type'] == 'post_exit'}; rs = {r['journalId']: r for r in rows if r['type'] == 'runner_shadow'}
    for k in pe:
        if k in rs and pe[k].get('oldRule') is not None: pairs.append((os.path.basename(os.path.dirname(os.path.dirname(j))) + ':' + k[:8], pe[k], rs[k], TOL))
bad = 0; note = ''
for name, row, sh, tol in pairs:
    note = ''
    hi, lo = F.old_runner(row, 'low_first'), F.old_runner(row, 'high_first')
    if sh['oldRuleExit'] == 'same': ok = hi['kind'] == 'same' and lo['kind'] == 'same'
    elif sh['oldRuleExit'] == 'runner_stop' and not row['oldRule'].get('tp1Seen') and sh.get('armedAt') is not None and sh['armedAt'] > row['exitDetectedAt']:
        # shadow artifact: the bot's shadow waits 3 minutes after a trade that ended before TP1 and arms if price then touches TP1; the old rule never held a runner. The formula says same.
        ok = hi['kind'] == 'same' and lo['kind'] == 'same'; note = 'shadow armed %.0f s AFTER the exit (shadow artifact)' % ((sh['armedAt'] - row['exitDetectedAt']) / 1000)
    elif sh['oldRuleExit'] == 'runner_stop': ok = hi['kind'] == 'runner_stop' and abs(hi['pts'] - sh['oldRunnerPts']) <= tol and abs(lo['pts'] - sh['oldRunnerPts']) <= tol
    else: ok = False   # session_close etc. not expected here: look at it by hand
    print('ok  ' if ok else 'FAIL', name, 'tp1Seen', row['oldRule'].get('tp1Seen'), '| shadow', sh['oldRuleExit'], sh.get('oldRunnerPts'), '| formula', hi['kind'], hi['pts'], lo['pts'], note)
    bad += (not ok)
print('%d rows, %d disagree' % (len(pairs), bad)); sys.exit(1 if bad else 0)
