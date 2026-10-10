import sys, json, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import strategy as S, engine as E
from sklearn.linear_model import LogisticRegression
def fit(end, C=0.05, hold=30, start='2021-09-27', out=None):
    d = E.load('ES'); F, a = S.features(d)
    i0, i1 = d.idx(start, end)
    y = np.full(d.n, np.nan); y[:-hold] = (d.c[hold:] > d.c[:-hold]).astype(float)
    mod = d.minute_of_day_et
    sel = np.zeros(d.n, bool); sel[i0:i1] = True
    sel &= ~np.isnan(F).any(1) & ~np.isnan(y) & (mod >= 585) & (mod <= 900) & (mod % 5 == 0)
    # avoid label leaking past end
    sel[max(i1 - hold, 0):] = False
    X = F[sel]; mu = X.mean(0); sd = X.std(0)
    clf = LogisticRegression(C=C, max_iter=500).fit((X - mu) / sd, y[sel])
    m = dict(mu=mu.tolist(), sd=sd.tolist(), w=clf.coef_[0].tolist(), b=float(clf.intercept_[0]), C=C, n=int(sel.sum()), end=end)
    if out: json.dump(m, open(out, 'w'))
    return m
if __name__ == '__main__':
    end = sys.argv[1]; C = float(sys.argv[2]); out = sys.argv[3]
    m = fit(end, C, out=out); print(m['n'], np.round(m['w'], 3), round(m['b'], 3))
