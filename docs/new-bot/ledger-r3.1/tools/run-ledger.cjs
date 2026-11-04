#!/usr/bin/env node
'use strict';
// Causal shadow ledger (MacStructure, analysis only). Runs lib/structure.js UNCHANGED with the default cfg over every 1m bar in
// replay1104/data (10/22 .. 11/04 03:47Z; the bars before the first TradeDay are warm-up with no bias), feeding the per-TradeDay
// bias fixtures (bot r13.3.7 lib/levelsPro.js evaluateLevelsPro, intrabar, tools/build-bias-fixture.cjs) in the executor shape
// {m15:{score, valid, observedAt}, m30:{...}} with observedAt = T, the close of the last completed 1m bar.
// TP1 / TP2 pool names come from the money lib (tide/v2/build/lib/moneyRule.js targetFor / partialFor, read-only).
// Usage: node run-ledger.cjs <structure.js> <moneyRule.js> <m1.json> <fixtures dir> <out.json>
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [SJ, MJ, M1, FXD, OUT] = process.argv.slice(2);
const S = require(path.resolve(SJ)), MR = require(path.resolve(MJ));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const m1 = JSON.parse(fs.readFileSync(M1)).sort((a, b) => a.t - b.t);
const readings = {}, fxFiles = fs.readdirSync(FXD).filter(f => /^bias-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
for (const f of fxFiles) Object.assign(readings, JSON.parse(fs.readFileSync(path.join(FXD, f))).readings);
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const PT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const tradeDay = T => PT.format(new Date((T + 9 * 3600) * 1000));   // CME day: 15:00 PT opens the next day's session (Sun 15:00 -> Mon)
const one = (v, T) => (isNum(v) ? { score: v, valid: true, observedAt: T * 1000 } : { score: null, valid: false, observedAt: T * 1000 });
const nul = (ev, fs_) => fs_.every(f => ev[f] === null || ev[f] === undefined);
function pointsOf(gp, ev) {   // 1 / 0 / null (null = the evidence it reads is unknown)
  return {
    trap: nul(ev, ['trapStacked']) ? null : gp.trap ? 1 : 0,
    force: nul(ev, ['forceLegAtrX', 'dispRangeX']) ? null : gp.force ? 1 : 0,
    volume: nul(ev, ['pullbackVsBreak5m']) ? null : gp.volume ? 1 : 0,
    timing: nul(ev, ['sweepMinutesFromOpen']) ? null : gp.timing ? 1 : 0,
    impulseBand: nul(ev, ['wavePeakBias']) ? null : gp.impulseBand ? 1 : 0,
  };
}
function tps(entry, stop, dir, pools, grade) {
  const tp2 = MR.targetFor(entry, stop, dir, pools, grade);
  const tp1 = tp2 ? MR.partialFor({ entry, stop, dir, tp: tp2.price, pools, contracts: 3 }) : null;
  return { tp2: tp2 ? { price: tp2.price, rr: tp2.rr, basis: tp2.basis, name: tp2.pool ? tp2.pool.name : '2R' } : null,
    tp1: tp1 ? { price: tp1.price, basis: tp1.basis, name: tp1.pool ? tp1.pool.name : '1R' } : null };
}
let st = S.createState(); const refs = new Map(), sigs = [], notrade = [], skips = [], arms = [], fails = [], controls = [];
let nIn = 0, nBias = 0;
for (const b of m1) {
  const T = b.t + 60, rd = readings[String(T)];
  for (const s of st.setups) refs.set(s.id, s);
  const input = { m1: b, bias: rd ? { m15: one(rd[0], T), m30: one(rd[1], T) } : null,
    levels: rd ? { O4: rd[2], O1: rd[3], PDH: rd[4], PDL: rd[5], AsiaH: rd[6], AsiaL: rd[7], LonH: rd[8], LonL: rd[9] } : null };
  nIn++; if (rd) nBias++;
  const out = S.step(st, input); st = out.state;
  for (const s of st.setups) refs.set(s.id, s);
  const all = out.signal ? [out.signal] : [];
  for (const e of out.events) {
    if (e.type === 'SIGNAL_EXTRA') all.push(e.signal);
    if (e.type === 'GRADE_NO_TRADE') {
      const s = refs.get(e.setup); if (!s) continue;
      const ev = S.evidenceFor(st, S.resolveCfg(), s, T, s.retestNo || 0, { stopLogical: !e.missing.includes('logicalStop') });   // read-only re-read of the evidence emit() graded
      notrade.push({ td: tradeDay(T), t: T, at: S.ptLabel(T), setupId: s.id, dir: s.dir, kind: s.kind, level: s.zone.name, levelPx: s.level, members: s.zone.members,
        entry: b.c, missing: e.missing, why: e.why, total: e.total, points: pointsOf(e.points, ev), wavePeak: ev.wavePeakBias, retestNo: s.retestNo || 0, ev });
    }
    if (['SIGNAL_SKIP', 'RETEST_2_SKIP', 'SETUP_SKIP', 'SETUP_CANCEL', 'SETUP_EXPIRE'].includes(e.type)) skips.push(Object.assign({ td: tradeDay(T) }, e));
    if (e.type === 'SETUP_ARM') arms.push(Object.assign({ td: tradeDay(T) }, e));
    if (e.type === 'FAIL' || e.type === 'ACCEPT') fails.push(Object.assign({ td: tradeDay(T) }, e));
    if (/^CONTROL_/.test(e.type)) controls.push(Object.assign({ td: tradeDay(T) }, e));
  }
  for (const g of all) {
    const ev = g.evidence, tp = tps(g.entryPrice, g.chosenStop, g.dir, g.pools, g.grade);
    sigs.push({ td: tradeDay(g.t), t: g.t, at: g.at, id: g.id, setupId: g.setupId, dir: g.dir, kind: g.kind, grade: g.grade, total: g.gradeTotal, tags: g.tags,
      points: pointsOf(g.gradePoints, ev), wavePeak: ev.wavePeakBias, entry: g.entryPrice, stop: g.chosenStop, stopPts: g.riskPts, stopType: g.stops.stopType,
      level: g.level.name, levelPx: g.level.price, members: g.level.members, retestNo: ev.retestNo, firstRetest: ev.retestNo <= 1, tp1: tp.tp1, tp2: tp.tp2, ev });
  }
}
const o = { note: 'MacStructure causal shadow ledger: lib/structure.js unchanged, default cfg; bias = bot r13.3.7 levelsPro (intrabar), observedAt = T.',
  structureSha256: sha(SJ), structureVersion: S.VERSION, moneySha256: sha(MJ), m1Sha256: sha(M1), fixtures: fxFiles.map(f => ({ f, sha256: sha(path.join(FXD, f)) })),
  bars: nIn, barsWithBias: nBias, firstBar: S.ptLabel(m1[0].t), lastBar: S.ptLabel(m1[m1.length - 1].t), signals: sigs, notrade, skips, arms, fails, controls };
fs.writeFileSync(OUT, JSON.stringify(o));
console.log(`bars ${nIn} (bias ${nBias}) signals ${sigs.length} no-trade ${notrade.length} skips ${skips.length}`);
