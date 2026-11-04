#!/usr/bin/env python3
"""Read-only: build tests/fixtures/witness-1104.json from the replay bars and the setup-log desk's 1m readings.
Usage: python3 -I tools/build-fixture.py <replay data dir> <readings.csv> <out.json>
m1 bars from 2026-11-02 00:00 PT to the end of the data; readings (forming 15m/30m bias + level board) keyed by
decision time T (unix sec, = the close of the 1m bar that ends at T)."""
import csv, json, sys, datetime as dt
from zoneinfo import ZoneInfo
Z = ZoneInfo('America/Los_Angeles')
ddir, rpath, out = sys.argv[1:4]
start = int(dt.datetime(2026, 11, 2, 0, 0, tzinfo=Z).timestamp())
m1 = [b for b in json.load(open(ddir + '/m1.json')) if b['t'] >= start]
rd = {}
num = lambda s: None if s in ('', 'None', 'nan') else float(s)
for row in csv.DictReader(open(rpath)):
    mo, rest = row['time_pt'].split('-'); dd, hm = rest.split(' '); h, mi = hm.split(':')
    T = int(dt.datetime(2026, int(mo), int(dd), int(h), int(mi), tzinfo=Z).timestamp())
    if T <= start:
        continue
    rd[str(T)] = [num(row['score15']), num(row['score30'])] + [num(row[k]) for k in ('O4', 'O1', 'PDH', 'PDL', 'AsiaH', 'AsiaL', 'LonH', 'LonL')]
json.dump({'note': 'MNQ continuous, replay1104; readings from tide/study (Python port of the bot bias score)', 'readingCols': ['s15', 's30', 'O4', 'O1', 'PDH', 'PDL', 'AsiaH', 'AsiaL', 'LonH', 'LonL'], 'm1': [[b['t'], b['o'], b['h'], b['l'], b['c'], b['v']] for b in m1], 'readings': rd}, open(out, 'w'), separators=(',', ':'))
print(len(m1), 'm1 bars,', len(rd), 'readings ->', out)
