#!/usr/bin/env node
'use strict';
// Read-only fixture builder (MacStructure). The bias readings come from the BOT'S OWN lib/levelsPro.js evaluateLevelsPro (r13.3.7, run unchanged),
// evaluated the way the live executor does in intrabar-1m mode (live-executor.js ~2794/2817): the 15m (and 30m) chart INCLUDING the forming bar,
// built from 1m bars that had closed by T. No formula is ported.
// Usage: node tools/build-bias-fixture.cjs <levelsPro lib dir> <replay data dir> <weekly.json> <out.json> <fromUnix> <toUnix>
//   m1 bars from 2026-11-02 00:00 PT .. end; readings for decision times T in [from, to] (T = the close of the 1m bar ending at T).
// Output: { m1: [[t,o,h,l,c,v]...], readingCols, readings: { T: [s15, s30, O4, O1, PDH, PDL, AsiaH, AsiaL, LonH, LonL] } }
const fs = require('fs'), path = require('path');
const [LIB, D, WJ, OUT, FROM, TO] = process.argv.slice(2);
const { evaluateLevelsPro } = require(path.resolve(LIB, 'levelsPro.js'));
const ld = n => JSON.parse(fs.readFileSync(path.join(D, n + '.json'))).sort((a, b) => a.t - b.t);
const m1 = ld('m1'), W = JSON.parse(fs.readFileSync(WJ));
const TFS = { M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
const src = { M5: ld('m5'), M15: ld('m15'), M30: ld('m30'), H1: ld('h1'), H4: ld('h4') };
const ms = b => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
const m1Idx = new Map(m1.map((b, i) => [b.t, i]));
function asof(arr, tf, T) {   // closed bars + the forming bar rebuilt from the 1m bars that closed by T (no look-ahead)
  const out = [];
  for (const b of arr) {
    if (b.t >= T) break;
    if (b.t + tf <= T) { out.push(ms(b)); continue; }
    const bs = []; for (let t = b.t; t < T; t += 60) { const i = m1Idx.get(t); if (i !== undefined) bs.push(m1[i]); }
    if (bs.length) out.push(ms({ t: b.t, o: bs[0].o, h: Math.max(...bs.map(x => x.h)), l: Math.min(...bs.map(x => x.l)), c: bs[bs.length - 1].c, v: bs.reduce((a, x) => a + x.v, 0) }));
  }
  return out;
}
const NAMES = { O4: '4H Open', O1: '1H Open', PDH: 'PDH', PDL: 'PDL', AsiaH: 'Asia High', AsiaL: 'Asia Low', LonH: 'London High', LonL: 'London Low' };
const start = Date.UTC(2026, 10, 2, 7, 0) / 1000;   // 2026-11-02 00:00 PT (PST, UTC-8 after 11/01)
const from = +FROM, to = +TO, readings = {};
const Ts = m1.filter(b => b.t + 60 >= from && b.t + 60 <= to).map(b => b.t + 60);
let n = 0;
for (const T of Ts) {
  const htf = {}; for (const [k, tf] of Object.entries(TFS)) htf[k] = asof(src[k].filter(b => b.t >= T - 400 * tf), tf, T);
  htf.W = W.filter(b => b.t < T).map(ms);
  const row = {};
  for (const k of ['M15', 'M30']) {
    const o = evaluateLevelsPro(htf[k].slice(-2000), htf, { sessionAnchor: 'cme', vwapBuild: '5m', vwapBars: htf.M5 });
    row[k] = o[o.length - 1];
  }
  const lv = Array.isArray(row.M15.levels) ? row.M15.levels : [];
  const board = Object.values(NAMES).map(nm => { const x = lv.find(l => l && l.name === nm && Number.isFinite(l.price)); return x ? x.price : null; });
  const r4 = x => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  readings[String(T)] = [r4(row.M15.biasScore), r4(row.M30.biasScore), ...board];
  if (++n % 50 === 0) process.stderr.write(`${n}/${Ts.length}\n`);
}
fs.writeFileSync(OUT, JSON.stringify({ note: 'MNQ continuous (replay1104). Bias = bot r13.3.7 lib/levelsPro.js evaluateLevelsPro biasScore on the forming 15m / 30m, intrabar (tools/build-bias-fixture.cjs).',
  readingCols: ['s15', 's30', ...Object.keys(NAMES)], m1: m1.filter(b => b.t >= start).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]), readings }));
console.log(Ts.length, 'readings ->', OUT);
