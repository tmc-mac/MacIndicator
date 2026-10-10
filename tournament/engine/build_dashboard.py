"""Rebuild tournament/files/strategy-tracker-dashboard.html from state/bracket/activity JSON.
`--demo` writes a synthetic-data preview to the given path (never the real output)."""
import sys, os, json, datetime as dt
ROOT = os.path.join(os.path.dirname(__file__), '..')
TDIR = os.path.join(ROOT, 'hidden_files/quant-team/tournament'); ADIR = os.path.join(ROOT, 'hidden_files/quant-team/strategy-tracker')
OUT = os.path.join(ROOT, 'files/strategy-tracker-dashboard.html')

def build(state=None, bracket=None, activity=None, out=OUT):
    L = lambda p, d: json.load(open(p)) if os.path.exists(p) else d
    state = state or L(os.path.join(TDIR, 'state.json'), None)
    if state is None:
        sys.path.insert(0, os.path.dirname(__file__)); import tournament as T; state = T.state()
    bracket = bracket or L(os.path.join(TDIR, 'bracket.json'), None)
    if bracket is None:
        sys.path.insert(0, os.path.dirname(__file__)); import tournament as T; bracket = dict(rounds=T.mk_rounds())
    activity = activity if activity is not None else L(os.path.join(ADIR, 'activity.json'), [])
    for r in bracket['rounds']:
        for m in r['matches']:
            for k in ('curveA', 'curveB'): m.setdefault(k, None)
    payload = dict(state=state, bracket=bracket, activity=activity, generated=dt.datetime.utcnow().replace(microsecond=0).isoformat())
    html = open(os.path.join(os.path.dirname(__file__), 'dashboard_template.html')).read()
    html = html.replace('/*__DATA__*/null', json.dumps(payload, default=float).replace('</', '<\\/'))
    os.makedirs(os.path.dirname(out), exist_ok=True); open(out, 'w').write(html); print('dashboard ->', out, len(html) // 1024, 'KB')

if __name__ == '__main__':
    build()
