#!/usr/bin/env node
'use strict';
// Read-only trace: replays the 11/04 TradeDay fixture through lib/structure.js and prints the engine's events minute by minute.
// Usage: node tools/trace-1104.cjs [fixture.json] [from "MM-DD HH:MM" PT] [to] [--all]   (default 11-03 15:00 .. 11-03 19:48 PT = TradeDay 11/04)
const path = require('path');
const S = require('../lib/structure.js');
const args = process.argv.slice(2).filter(a => !a.startsWith('--')), all = process.argv.includes('--all');
const fx = require(path.resolve(args[0] || path.join(__dirname, '../tests/fixtures/witness-1104-bot.json')));
const from = args[1] || '11-03 15:00', to = args[2] || '11-03 19:48';
const QUIET = new Set(['BREAK', 'BREAK_LOST', 'PERIOD', 'GRADE_LIVE']);
const CFG = { biasInput: 'offline' };   // r3.2: the fixture's bare {s15, s30} readings are offline input
let st = S.createState();
for (const r of fx.m1) {
  const T = r[0] + 60, rd = fx.readings[String(T)];
  const input = { m1: r, bias: rd ? { s15: rd[0], s30: rd[1] } : null,
    levels: rd ? { O4: rd[2], O1: rd[3], PDH: rd[4], PDL: rd[5], AsiaH: rd[6], AsiaL: rd[7], LonH: rd[8], LonL: rd[9] } : null };
  const out = S.step(st, input, CFG); st = out.state;
  const at = S.ptLabel(T); if (at < from || at > to) continue;
  const evs = out.events.filter(e => all || !QUIET.has(e.type));
  if (!evs.length && !out.signal) continue;
  const bias = rd ? ` bias15 ${rd[0]} bias30 ${rd[1]}` : '';
  console.log(`${at}  close ${r[4]}${bias}`);
  for (const e of evs) { const { t, at: _a, type, signal, ...rest } = e; console.log(`   ${type.padEnd(16)} ${JSON.stringify(rest)}`); }
  if (out.signal) {
    const g = out.signal;
    const v = g.evidence;
    console.log(`   >>> SIGNAL ${g.side} ${g.kind} ${g.entryType} @ ${g.entryPrice} stop ${g.chosenStop} (${g.riskPts} pts, ${g.stops.rule}) grade ${g.grade} [${g.gradeTotal}: ${Object.entries(g.gradePoints).map(([k, x]) => k + '=' + x).join(' ')}]`);
    console.log(`       level ${g.level.name} ${g.level.price}; stops trap ${g.stops.trapExtreme} 1H ${g.stops.hour1Wick} bounce ${g.stops.bounceExtreme}; addZone ${JSON.stringify(g.addZone)}`);
    console.log(`       evidence control ${v.controlKind}/${v.controlDir} pool ${v.poolName} ${v.poolType} ${v.poolWeight} touches ${v.poolTouches}; disp ${v.dispTf} body ${v.dispBodyPct} x${v.dispRangeX}; retest ${v.retestNo}; wavePeak ${v.wavePeakBias} (${v.wavePeakTf} ${v.wavePeakAt}) entryBias ${v.entryBias}; turn ${v.turnDelta} ${v.turnCandle ? v.turnCandle.at : '-'}; breakVol ${v.breakVol}/${v.breakVolMedian20} x${v.breakVolX} pullback/break ${v.pullbackVsBreak}; ${v.session} +${v.minutesFromSessionOpen}m; ${v.marketState}; climax ${v.climax}`);
    console.log(`       targets ${g.targets.slice(0, 6).map(x => `${x.name} ${x.price} (${x.distanceR}R${x.major ? ' major' : ''})`).join(', ')}`);
    if (g.warnings.length) console.log(`       warnings: ${g.warnings.join(' | ')}`);
  }
}
