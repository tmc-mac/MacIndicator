"""Build clean 1-minute continuous series (npz) for NQ and ES from raw uploads.
Usage: python prep_data.py <nq.csv> <mes_dir_glob...> <outdir>
ES: drop spread rows, keep outright ES[HMUZ]<digit>, per-day pick the highest-volume contract,
    back-adjust (additive) at each roll so the series is gap-free. Timestamps UTC.
"""
import sys, glob, re, numpy as np, pandas as pd

def prep_nq(path, out):
    d = pd.read_csv(path, parse_dates=['t'])
    d = d.rename(columns={'t':'ts','o':'open','h':'high','l':'low','c':'close','v':'volume'})
    d['ts'] = d['ts'].dt.tz_convert('UTC').dt.tz_localize(None)
    d = d.drop_duplicates('ts').sort_values('ts').reset_index(drop=True)
    save(d, out, 'nq')

def prep_es(files, out):
    parts = []
    for f in files:
        x = pd.read_csv(f, usecols=['ts_event','open','high','low','close','volume','symbol'])
        x = x[x['symbol'].str.match(r'^ES[HMUZ]\d$')]
        parts.append(x)
    d = pd.concat(parts, ignore_index=True)
    d['ts'] = pd.to_datetime(d['ts_event'], utc=True).dt.tz_localize(None)
    d = d.drop(columns='ts_event')
    d['day'] = d['ts'].dt.floor('D')
    vol = d.groupby(['day','symbol'])['volume'].sum().reset_index()
    # front = highest volume contract per day, never going backwards in expiry order
    vol = vol.sort_values(['day','volume'], ascending=[True, False])
    front = vol.drop_duplicates('day').set_index('day')['symbol']
    def key(s):  # expiry ordering: year digit then month code
        return (int(s[3]), 'HMUZ'.index(s[2]))
    cur=None; fl={}
    for day,s in front.items():
        if cur is None or key(s)>=key(cur): cur=s
        fl[day]=cur
    d['front'] = d['day'].map(fl)
    d = d[d['symbol']==d['front']].drop_duplicates('ts').sort_values('ts').reset_index(drop=True)
    # additive back-adjustment at roll points using the old contract's last close vs new contract's price at the same minute
    full = pd.concat(parts, ignore_index=True)
    full['ts'] = pd.to_datetime(full['ts_event'], utc=True).dt.tz_localize(None)
    px = full.set_index(['symbol','ts'])['close']
    sym = d['symbol'].values
    chg = np.flatnonzero(sym[1:]!=sym[:-1])+1
    adj = np.zeros(len(d))
    cum = 0.0
    for i in chg[::-1]:
        t = d['ts'].iloc[i]; old, new = sym[i-1], sym[i]
        try:
            gap = px.loc[(new, t)] - px.loc[(old, t)] if (old,t) in px.index else d['close'].iloc[i]-d['close'].iloc[i-1]
        except Exception:
            gap = 0.0
        if isinstance(gap, pd.Series): gap = gap.iloc[0]
        cum += gap
        adj[:i] -= 0  # placeholder
        d.loc[:i-1, ['open','high','low','close']] += gap
    d = d.drop(columns=['day','front'])
    save(d, out, 'es')

def save(d, out, name):
    d = d.dropna(subset=['open','high','low','close'])
    ts = d['ts'].values.astype('datetime64[s]').astype(np.int64)
    np.savez(f'{out}/{name}_1m.npz', ts=ts, o=d.open.values.astype('f8'), h=d.high.values.astype('f8'),
             l=d.low.values.astype('f8'), c=d.close.values.astype('f8'), v=d.volume.values.astype('f8'))
    print(name, len(d), d['ts'].iloc[0], d['ts'].iloc[-1])

if __name__=='__main__':
    nq, es_glob, out = sys.argv[1], sys.argv[2], sys.argv[3]
    prep_nq(nq, out); prep_es(sorted(glob.glob(es_glob)), out)
