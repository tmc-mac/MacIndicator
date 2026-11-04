#!/usr/bin/env node
'use strict';
// [r1.3] snapshot.tide.board tests (MacUI-N Addendum r1.3). usage: nice -n 19 node tests/tide-board.test.cjs [--sample <out.json>]
//   the 11/04 witness day through the real engine; the board at 16:00 PT (the 4H Open trap armed before the 16:08 A+) and at its end; the cap; p95 build time.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), W = require(path.join(ROOT, 'lib/tideWire.js')), S = require(path.join(ROOT, 'lib/structure.js'));
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 700) : '')); } };
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/witness-1104.json'), 'utf8'));
const sh = { engine: W.createAdapter(S, {}), seen: new Set() }, NAMES = ['4H Open', '1H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low'], book = W.createBiasBook();
const CF = { tide: { ...W.DEFAULTS.tide, mode: 'shadow' }, money: W.moneyDefaults() }, mc = W.moneyCfg(CF, 2, 0.25);
const sess = t => { const m = W.ptMinute(t), wd = new Date(t - 8 * 3600e3).getUTCDay(), wk = wd >= 1 && wd <= 5; return { noEntry: wk && m >= 775 && m < 900, flattenDue: wk && m >= 785 && m < 900 }; };
const at1600 = Date.parse('2026-11-04T00:00:00Z') / 1000; let b1600 = null, last = null; const DAY = [], CTL = []; let ARMED = null;
for (const r of fx.m1) {
  const T = r[0] + 60, rd = fx.readings[String(T)];
  const board = rd ? NAMES.map((n, i) => ({ name: n, price: rd[2 + i] })).filter(x => Number.isFinite(x.price)) : [];
  if (rd) W.noteBias(book, T * 1000, rd[0], rd[1]);
  W.shadowStep(sh, { nowMs: T * 1000, m1New: [{ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }], warm: false, board, biasAt: t => W.biasAt(book, t), sessionAt: sess }, CF, { flat: true });
  last = r[4];
  if (T % 900 === 0) { const v = sh.engine.view(), b = W.boardView(v, { lastPx: r[4], now: T * 1000, mc, gates: {} }); DAY.push(b);
    if (v.period && v.period.control) CTL.push([b.control && b.control.since, v.period.control.formedT * 1000]);
    if (!ARMED && v.setups.some(x => x.status === 'armed' && !x.entered)) ARMED = JSON.parse(JSON.stringify(v)); }
  if (T === at1600) b1600 = W.boardView(sh.engine.view(), { lastPx: r[4], now: T * 1000, mc, gates: { timeBlock: W.blockAt({ tide: W.DEFAULTS.tide }, T * 1000) } });
}
const bEnd = W.boardView(sh.engine.view(), { lastPx: last, now: (fx.m1[fx.m1.length - 1][0] + 60) * 1000, mc, gates: {} });
const out = process.argv.indexOf('--sample'); if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify({ at1600PT: b1600, atEnd: bEnd }, null, 1));
const shape = b => b && ['at', 'price', 'O4', 'control', 'range1h', 'levels', 'truncated'].every(k => k in b) && b.levels.every(l => ['name', 'price', 'side', 'state', 'since', 'dir', 'lane', 'setup', 'closesOut', 'retestNo', 'plan', 'blockedBy', 'targetOnly'].every(k => k in l));
ok(shape(b1600) && shape(bEnd), 'B1 the MacUI-N shape: board { at, price, O4, control, range1h, levels, truncated }, each level with every contract field');
const STATES = new Set(['watching', 'broken', 'accepted', 'failed', 'retest-pending', 'armed', 'rejected', 'cancelled', 'expired']), CODES = new Set(['ROUND_NUMBER', 'MID_RANGE', 'TIME_BLOCK', 'OPEN_WAIT', 'AGAINST_CONTROL', 'ZONE_USED', 'RETEST_NOT_FIRST', 'SESSION_CLOSE', 'NEWS_WAIT']);
ok([b1600, bEnd].every(b => b.levels.every(l => STATES.has(l.state) && l.blockedBy.every(x => CODES.has(x.code) && typeof x.text === 'string'))), 'B2 states and blockedBy codes only from the contract lists');
ok([b1600, bEnd].every(b => b.levels.filter(l => /round/i.test(l.name) || l.blockedBy.some(x => x.code === 'ROUND_NUMBER')).every(l => l.blockedBy.some(x => x.code === 'ROUND_NUMBER') && l.plan === null)), 'B3 round numbers: ROUND_NUMBER, never a plan');
ok(b1600.levels.some(l => l.blockedBy.some(x => x.code === 'TIME_BLOCK')), 'B4 16:00 PT is inside TIDE\'s 15:00-17:00 block: TIME_BLOCK on the levels', b1600.levels.map(l => l.blockedBy.map(x => x.code)));
const armed = [b1600, bEnd].flatMap(b => b.levels.filter(l => l.plan));
ok(armed.length > 0 && armed.every(l => l.plan.plan === true && l.plan.basis === 'reference' && l.plan.tp1 === null && l.plan.tp2 === null && l.plan.tp1Pool === null && l.plan.tp2Pool === null && Number.isFinite(l.plan.entry) && Number.isFinite(l.plan.stop) && Number.isFinite(l.plan.R) && 'stopTf' in l.plan), 'B5 an armed setup: plan:true with entry / stop / stopTf / R; TP1 / TP2 null (never a guess: the signal picks them from its own pools)', armed.map(l => l.plan));
{ const id = (b1600.levels.find(l => l.name === '4H Open' && l.lane === 'failed-break' && l.state === 'armed') || {}).setup, g = id ? b1600.levels.filter(l => l.setup === id) : []; /* [rule 18 v2] the 4H-Open trap by role, not by its seq id (extra setups earlier in the day renumber it) */ ok(g.length > 1 && g.every(l => l.group === id), 'B5b a grouped trap setup: every level it spans carries group = the setup id (the phone collapses them)', g.map(l => [l.name, l.group])); }
ok([b1600, bEnd].every(b => b.levels.length <= W.BOARD_MAX_LEVELS && JSON.stringify(b).length <= W.BOARD_MAX_BYTES), 'B6 <= 30 levels and <= 8 KB on the real day', [b1600.levels.length, JSON.stringify(b1600).length, bEnd.levels.length, JSON.stringify(bEnd).length]);
// the cap on a synthetic state: 200 zones, one armed setup far away
{ const st = JSON.parse(JSON.stringify(sh.engine.view())); const z0 = st.zones[0] || { members: [] };
  st.zones = Array.from({ length: 200 }, (_, i) => ({ ...z0, key: 'K' + i, name: 'Swing ' + i + ' ' + 'x'.repeat(30), price: 28000 + i * 5, lo: 27998 + i * 5, hi: 28002 + i * 5, src: 'swing', setup: true, type: 'H' }));
  st.setups = [{ id: 'SFAR', kind: 'failed-break', dir: -1, status: 'armed', zone: { key: 'K199' }, zones: ['Swing 199'], level: 28995, ext: 29010, stopType: '4H', retestNo: 0, armT: 1 }];
  const b = W.boardView(st, { lastPx: 28010, now: 1, mc, gates: { timeBlock: 'TIDE block 15:00-17:00 PT', openWait: 'open wait', newsWait: 'CPI' } });
  ok(b.levels.length <= 30 && JSON.stringify(b).length <= 8192 && b.truncated === 200 - b.levels.length && b.levels.some(l => l.setup === 'SFAR' && l.plan && l.plan.plan === true), 'B7 the cap: 200 zones -> <= 30 levels and <= 8 KB; the far armed setup is kept; truncated counted', [b.levels.length, JSON.stringify(b).length, b.truncated]); }
// latency: p95 of the board build on the real end-of-day state
{ const ts = []; for (let i = 0; i < 200; i++) { const t0 = process.hrtime.bigint(); W.boardView(sh.engine.view(), { lastPx: last, now: 1, mc, gates: {} }); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  ts.sort((a, b) => a - b); const p95 = ts[Math.floor(ts.length * 0.95)];
  ok(p95 < 5, 'B8 board build p95 < 5 ms (200 builds, the real state)', { p50: ts[100].toFixed(2), p95: p95.toFixed(2), max: ts[199].toFixed(2) }); console.log(`  board build ms: p50 ${ts[100].toFixed(2)} p95 ${p95.toFixed(2)} max ${ts[199].toFixed(2)}`); }
ok(Object.isFrozen(W.DEFAULTS) && sh.engine.view() === sh.engine.view(), 'B9 view() returns the engine state itself (read only use; the board copies, never mutates)');
{ const st = sh.engine.view(), before = JSON.stringify(st); W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }); ok(JSON.stringify(st) === before, 'B10 building the board does not change the engine state'); }
// review (a): the engine keys break episodes by zone AND side: broken / accepted / closesOut must appear through the day
{ const st = DAY.flatMap(b => b.levels.map(l => l.state)); ok(st.includes('accepted') && st.includes('broken') && DAY.some(b => b.levels.some(l => Number.isFinite(l.closesOut))), 'B12 (review a) through the real day the board shows broken AND accepted levels with closesOut (the engine\'s zone|side episode keys)', [...new Set(st)]); }
// review (b): FIRST_RETEST_USED only for the engine's own used key (period|zone|kind|dir): the OTHER direction being used never blocks a setup
{ const st = JSON.parse(JSON.stringify(ARMED)), s0 = st.setups.find(x => x.status === 'armed' && !x.entered), other = s0.ukey.replace(/\|(-?1)$/, (m, d) => '|' + (-d));
  st.used = { [other]: 1 }; const lv = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.filter(l => l.setup === s0.id);
  st.used = { [s0.ukey]: 1 }; const lv2 = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.filter(l => l.setup === s0.id);
  ok(lv.length && lv.every(l => !l.blockedBy.some(x => x.code === 'ZONE_USED')) && lv2.length && lv2.every(l => l.blockedBy.some(x => x.code === 'ZONE_USED')), 'B13 (review b) the other direction used: not blocked; its own kind + dir used: ZONE_USED', { other, own: s0.ukey }); }
// review (c): control.since = the engine's control formedT
ok(CTL.length > 0 && CTL.every(([a, b]) => a === b), 'B14 (review c) control.since = st.period.control.formedT (ms)', CTL.slice(0, 3));
// r1.4 (d) MID_RANGE: the setup LEVEL vs the engine's midFrac band (structure midRangeOf)
{ const st = JSON.parse(JSON.stringify(ARMED)), s0 = st.setups.find(x => x.status === 'armed' && !x.entered), EC = S.DEFAULTS, f = EC.state1h.midFrac;
  st.mstate = { known: true, state: 'RANGE', dir: 0, hi: s0.level + 100, lo: s0.level - 100 };   // the level is in the middle
  const b1 = W.boardView(st, { lastPx: s0.level + 95, now: 1, mc, gates: {} }), l1 = b1.levels.filter(l => l.setup === s0.id);
  st.mstate = { known: true, state: 'RANGE', dir: 0, hi: s0.level + 10, lo: s0.level - 190 };   // the level near the top edge, price in the middle
  const b2 = W.boardView(st, { lastPx: s0.level - 90, now: 1, mc, gates: {} }), l2 = b2.levels.filter(l => l.setup === s0.id), m = 200 * (1 - f) / 2;
  ok(l1.every(l => l.blockedBy.some(x => x.code === 'MID_RANGE')) && l2.every(l => !l.blockedBy.some(x => x.code === 'MID_RANGE')) && b1.range1h.midLo === Math.round((s0.level - 100 + m) * 100) / 100, 'B15 (r1.4 d) MID_RANGE tests the setup level with the engine midFrac band (not the price)', { l1: l1.map(l => l.blockedBy), r: b1.range1h }); }
// r1.4 (e) the reference stop: 4H = the sweep extreme + stopBuf; 1H = the 1H wick + stopBuf
{ const st = JSON.parse(JSON.stringify(ARMED)), s0 = st.setups.find(x => x.status === 'armed' && !x.entered), buf = S.DEFAULTS.stopBuf, h1 = st.cur.h1 || st.bars.h1[st.bars.h1.length - 1];
  s0.kind = 'failed-break'; s0.stopType = '4H'; if (!Number.isFinite(s0.ext)) s0.ext = s0.level - s0.dir * 40; const p4 = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.find(l => l.setup === s0.id).plan;
  s0.stopType = '1H'; const p1 = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.find(l => l.setup === s0.id).plan;
  ok(p4.stop === Math.round((s0.dir < 0 ? s0.ext + buf : s0.ext - buf) * 100) / 100 && p1.stop === Math.round((s0.dir < 0 ? h1.h + buf : h1.l - buf) * 100) / 100 && p1.stopTf === '1H', 'B16 (r1.4 e) reference stop = the engine rule (4H: extreme + stopBuf; 1H: the 1H wick + stopBuf)', { p4: p4.stop, p1: p1.stop, ext: s0.ext, h1h: h1.h, h1l: h1.l }); }
// r1.4 (f) RETEST_NOT_FIRST for retest 2+ of a break; (g) rejected = the engine's rejection fired (status done, never entered)
{ const st = JSON.parse(JSON.stringify(ARMED)), s0 = st.setups.find(x => x.status === 'armed' && !x.entered);
  s0.retestNo = 2; const l2 = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.filter(l => l.setup === s0.id);
  s0.retestNo = 1; const l1 = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.filter(l => l.setup === s0.id);
  ok(l2.every(l => l.blockedBy.some(x => x.code === 'RETEST_NOT_FIRST')) && l1.every(l => !l.blockedBy.some(x => x.code === 'RETEST_NOT_FIRST')), 'B17 (r1.4 f) retest 2 of a break: RETEST_NOT_FIRST; retest 1: not', l2.map(l => l.blockedBy));
  s0.status = 'done'; s0.entered = false; const lr = W.boardView(st, { lastPx: last, now: 1, mc, gates: {} }).levels.filter(l => l.setup === s0.id);
  ok(lr.length && lr.every(l => l.state === 'rejected' && l.plan === null), 'B18 (r1.4 g) a setup the engine set done at its 1m rejection (never entered): state rejected', lr.map(l => l.state)); }
{ const st0 = DAY.flatMap(b => b.levels.map(l => l.state)); ok(st0.includes('rejected'), 'B18b the real day shows the rejected state (the 16:08 A+ rejection, S291)', [...new Set(st0)]); }
// r1.4 (h) the 8 KB cap in UTF-8 bytes
{ const st = JSON.parse(JSON.stringify(sh.engine.view())); const z0 = st.zones[0];
  st.zones = Array.from({ length: 60 }, (_, i) => ({ ...z0, key: 'U' + i, name: 'Niveau éèê–—€ ' + i + ' ' + 'é'.repeat(40), price: 28000 + i, lo: 27999 + i, hi: 28001 + i, src: 'swing', setup: true }));
  const b = W.boardView(st, { lastPx: 28010, now: 1, mc, gates: {} }), bytes = Buffer.byteLength(JSON.stringify(b), 'utf8');
  ok(bytes <= 8192 && JSON.stringify(b).length < bytes, 'B19 (r1.4 h) the 8 KB cap is measured in UTF-8 bytes (multi-byte names)', { bytes, chars: JSON.stringify(b).length, n: b.levels.length }); }
const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
ok(/board: tideBoardSafe\(\),/.test(EX) && /\.\.\.\(tideOn\(\) \? \{ tide: tideSnapshotView\(\) \} : \{\}\),/.test(EX) && /if \(ms > 25\) \{ tideBoardSlow\+\+; tideBoardHourN\+\+; return tideBoardLast \? \{ \.\.\.tideBoardLast, stale: true \} : null; \}/.test(EX) && /tideBoardLast = b; return b;/.test(EX) && /board: \$\{tideBoardHourN\} build\(s\) over the 25 ms budget in the last hour/.test(EX), 'B11 the board is inside the tide block (absent with tide off); [r1.5] over the 25 ms budget the LAST good board is kept with stale:true (its own at), null only before any good board; the overruns logged once per hour');
console.log(`tide-board (${W.VERSION}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
