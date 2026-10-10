"""ES-9: no edge found; stub only (emits no signals). See final.md."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'engine'))
import engine as E
PARAMS = {'risk': 100.0}
RISK_KEY = 'risk'
TUNABLE = []
def generate(d, params):
    return E.empty_signals()
