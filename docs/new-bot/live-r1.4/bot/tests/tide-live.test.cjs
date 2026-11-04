#!/usr/bin/env node
'use strict';
// TIDE Stage 2a LIVE tests (MacLive 11/04): lib/tideLive.js + lib/tideOrders.js + lib/tideWire.js against a FAKE lib/liveOrders.js. Every broker request is
// recorded with its order; the tests check the requests themselves (type, side, size, price), never only the planner's intents.
// usage: nice -n 19 node tests/tide-live.test.cjs [-v]      (run from the bot folder)
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'lib/tideLive.js')), W = require(path.join(ROOT, 'lib/tideWire.js')), M = require(path.join(ROOT, 'lib/moneyRule.js'));
const VERBOSE = process.argv.includes('-v');
let pass = 0, fail = 0; const fails = [];
function ok(c, name, extra) { if (c) { pass++; if (VERBOSE) console.log('  ok  ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 900) : '')); } }
const DIR = fs.mkdtempSync(path.join(process.env.TL_TMP || os.tmpdir(), 'tide-live-'));
const T = { LIMIT: 1, MARKET: 2, STOP: 4 }, SD = { BUY: 0, SELL: 1 };

// ---- the fake broker: one contract; MARKET fills at px at once; STOP / LIMIT fill on tick(px); partial(id, q) fills part of a resting order
function broker() {
  const B = { px: 28000, pos: 0, avg: null, book: [], hist: new Map(), id: 500, reqs: [], rejectIf: null, noAckIf: null, cancelFails: new Set(), stopPxShift: 0 };
  const iso = () => new Date().toISOString();
  function fillQty(o, q, px) {
    const s = o.side === SD.BUY ? 1 : -1, before = B.pos, after = before + s * q;
    if (before === 0 || Math.sign(before) === s) B.avg = ((B.avg || 0) * Math.abs(before) + px * q) / Math.abs(after); else if (after !== 0 && Math.sign(after) !== Math.sign(before)) B.avg = px;
    B.pos = after; if (!B.pos) B.avg = null;
    const h = B.hist.get(o.id); const fv = h.fillVolume + q; h.filledPrice = ((h.filledPrice || 0) * h.fillVolume + px * q) / fv; h.fillVolume = fv;
    o.left -= q; if (o.left === 0) { h.status = 2; B.book.splice(B.book.indexOf(o), 1); }
  }
  B.api = {
    OrderType: { LIMIT: 1, MARKET: 2, STOP: 4, TRAILING_STOP: 5 }, OrderSide: SD,
    async placeOrder(token, body) {
      const r = { req: 'place', type: body.type, side: body.side, size: body.size, price: body.type === T.STOP ? body.stopPrice : body.type === T.LIMIT ? body.limitPrice : null, px: B.px };
      B.reqs.push(r);
      if (B.rejectIf && B.rejectIf(body)) { r.result = 'rejected'; const e = new Error('Order/place failed: rejected (fake)'); e.orderRejected = true; throw e; }
      const o = { ...body, id: ++B.id, left: body.size }; if (o.type === T.STOP) o.stopPrice += B.stopPxShift;
      B.hist.set(o.id, { id: o.id, accountId: 1, contractId: 'C', status: 1, type: o.type, side: o.side, size: o.size, fillVolume: 0, filledPrice: null, creationTimestamp: iso() });
      B.book.push(o);
      if (o.type === T.MARKET) fillQty(o, o.size, B.px);
      r.id = o.id;
      if (B.noAckIf && B.noAckIf(body)) { r.result = 'no-ack'; throw new Error('timeout (fake no-ack)'); }
      return { success: true, orderId: o.id };
    },
    async cancelOrder(token, a, id) { B.reqs.push({ req: 'cancel', id }); if (B.cancelFails.has(id)) return false; const o = B.book.find(x => x.id === id); if (!o) return false; B.book.splice(B.book.indexOf(o), 1); B.hist.get(id).status = 3; return true; },
    async getOpenPosition() { return B.pos ? { contractId: 'C', type: B.pos > 0 ? 1 : 2, size: Math.abs(B.pos), averagePrice: B.avg } : null; },
    async getOpenOrders() { return B.book.map(o => ({ id: o.id, contractId: 'C', type: o.type, side: o.side, size: o.left, stopPrice: o.stopPrice, limitPrice: o.limitPrice })); },
    async getEntryOrder(token, a, c, id) { const h = B.hist.get(id); if (!h) throw new Error('Entry history missing or ambiguous'); return { ...h }; },
  };
  B.tick = px => { B.px = px; for (const o of [...B.book].sort((a, b) => a.id - b.id)) { if (!B.book.includes(o)) continue; const buy = o.side === SD.BUY;
    const hit = o.type === T.STOP ? (buy ? px >= o.stopPrice : px <= o.stopPrice) : o.type === T.LIMIT ? (buy ? px <= o.limitPrice : px >= o.limitPrice) : false;
    if (hit) fillQty(o, o.left, o.type === T.STOP ? o.stopPrice : o.limitPrice); } };
  B.partial = (id, q, px) => { const o = B.book.find(x => x.id === id); fillQty(o, q, px); };
  B.places = () => B.reqs.filter(r => r.req === 'place');
  B.str = () => B.reqs.map(r => r.req === 'cancel' ? `cancel#${r.id}` : `${r.side === 0 ? 'BUY' : 'SELL'} ${r.type === 2 ? 'MKT' : r.type === 4 ? 'STOP' : 'LMT'} ${r.size}${r.price != null ? '@' + r.price : ''}${r.result ? ' (' + r.result + ')' : ''}`);
  return B;
}
let fileN = 0;
const MONEY = (o = {}) => { const d = W.moneyDefaults(); d.sizing.flatDollars = 200; Object.assign(d.sizing, o); return d; };   // the mechanics tests size at $200 (3 MNQ at 30 pts); the SHIPPED $400 is checked in L12h
function drv(B, o = {}) {
  const rows = [], pushes = [], prios = [], ends = [], tp1s = [], file = o.file || path.join(DIR, `s${++fileN}.json`), money = o.money || MONEY();
  const D = L.create({ token: 'fake', accountId: 1, contractId: 'C', orders: B.api, log: VERBOSE ? (m => console.log('     ' + m)) : () => {}, notify: (t, x, op) => { pushes.push(t + ' | ' + x); prios.push(String(op && op.priority)); },
    journal: r => rows.push(r), stateFile: file, sleep: async () => {}, cfgFn: () => ({ ...W.moneyOnly(money), pointValue: 2, tickSize: 0.25, floorDistanceUsd: o.floor === undefined ? 50000 : o.floor }),
    take1MaxFn: () => W.take1Max({ money }), preCheck: o.preCheck, onEnd: (id, r) => ends.push([id, r]), onTp1: id => tp1s.push(id) });
  return { D, rows, pushes, prios, ends, tp1s, file };
}
// a SHORT at 28000; R = stop pts; pools: TP1 at a pool 1R below, TP2 a major pool >= 2R below
const sig = (stopPts, o = {}) => ({ dir: -1, entry: 28000, pools: [{ price: 28000 - stopPts, name: 'swing L' }, { price: 28000 - 3 * stopPts, major: true, name: 'PDL' }], ...o });
const plan = (stopPts, o = {}) => ({ grade: 'A+', entryType: 'MARKET', stop: 28000 + stopPts, ...o });
const stops = B => B.book.filter(x => x.type === T.STOP);

(async () => {
  console.log('L1 the full A+ life cycle (3 MNQ): entry -> ONE stop sized to the fill -> TP1 2/3 -> BE + 1 tick -> TP2 -> DONE');
  { const B = broker(), { D, ends, pushes, prios, tp1s } = drv(B);
    const r = await D.signal(sig(30), plan(30), 'take-1');
    ok(r.ok && D.owned(), 'L1a the signal is taken (guard + entry)', r);
    ok(JSON.stringify(B.str()) === JSON.stringify(['SELL MKT 3', 'BUY STOP 3@28030', 'BUY LMT 2@27970', 'BUY LMT 1@27910']), 'L1b requests: MARKET 3, then ONE stop 3 @ the structural 28030, TP1 2 @ 27970, TP2 1 @ 27910', B.str());
    ok(B.pos === -3 && stops(B).length === 1, 'L1c 3 short, one stop resting');
    const n0 = B.reqs.length; await D.poll({ lastPx: 27995 }); await D.poll({ lastPx: 27995 });
    ok(B.reqs.length === n0, 'L1d polls with nothing new send nothing (no duplicate orders)', B.str().slice(n0));
    B.tick(27970); await D.poll({ lastPx: 27970 });
    const after = B.str().slice(n0);
    ok(after[0] === 'BUY STOP 1@27999.75' && /^cancel#/.test(after[1]) && stops(B).length === 1 && stops(B)[0].stopPrice === 27999.75 && stops(B)[0].left === 1, 'L1e TP1 filled 2: the stop -> BE + 1 tick (27999.75) for the 1 left, placed first, the old one cancelled after', after);
    ok(tp1s.length === 1 && tp1s[0] === 'take-1', 'L1f the engine is told TP1 is done (once)');
    B.tick(27910); await D.poll({ lastPx: 27910 });
    ok(B.pos === 0 && B.book.length === 0 && !D.owned() && D.phase() === 'DONE', 'L1g TP2 filled: flat, nothing resting, DONE', { pos: B.pos, book: B.book, ph: D.phase() });
    ok(ends.length === 1 && ends[0][0] === 'take-1' && ends[0][1].closed && ends[0][1].tp1Done && !ends[0][1].stopped, 'L1h the REAL end is reported to the engine once (tp1Done, not stopped)', ends);
    { const ti = pushes.map(p => p.split(' | ')[0]); ok(JSON.stringify(ti) === JSON.stringify(['TIDE FILLED', 'TIDE ENTRY SHORT A+', 'TIDE TP1 filled', 'TIDE stop moved', 'TIDE TP1', 'TIDE TP2 filled', 'TIDE EXIT']) && /SHORT A\+ 3 MNQ @ 28000 \| stop 28030 \(30 pts, risk \$180\) \| TP1 27970 \(2x\) \| TP2 27910/.test(pushes[1]) && /SHORT 3 MNQ: \+\$300 \(\+1\.67R\) \| tp1 2x @ 27970, tp2 1x @ 27910/.test(pushes[6]) && prios.every(x => x === 'default'), 'L1i [r1.1] every in-trade push (fill, stop placed with the plan, TP1, the BE stop move, TP2, EXIT with $ and R): 7, all INFO (the notify budget counts them)', { pushes, prios }); }
    const st = stops(B).length; ok(st === 0 && B.places().filter(x => x.type === T.STOP).length === 2, 'L1j exactly two stop placements in the whole trade (the first + one BE move)'); }

  console.log('L2 the 1-lot (no TP1 order): TP1 price traded -> BE + 1 tick; TP2 for the lot');
  { const B = broker(), { D, ends } = drv(B);
    const r = await D.signal(sig(80), plan(80), 'take-2');
    ok(r.ok && JSON.stringify(B.str()) === JSON.stringify(['SELL MKT 1', 'BUY STOP 1@28080', 'BUY LMT 1@27760']), 'L2a 1 MNQ: entry, stop, TP2 only (no TP1 order)', B.str());
    const n0 = B.reqs.length; B.tick(27919); await D.poll({ lastPx: 27919, bar: { t: Date.now() + 60000, h: 27930, l: 27919 } });
    ok(B.str()[n0] === 'BUY STOP 1@27999.75' && stops(B).length === 1 && stops(B)[0].stopPrice === 27999.75, 'L2b the TP1 price (27920) traded: the stop -> BE + 1 tick', B.str().slice(n0));
    B.tick(28000); await D.poll({ lastPx: 28000 });
    ok(!D.owned() && B.pos === 0 && B.book.length === 0 && ends.length === 1 && ends[0][1].tp1Done === true, 'L2c stopped at BE + 1: flat, TP2 cancelled, end reported (tp1Done)', { pos: B.pos, book: B.book.length, ends }); }

  console.log('L3 partial entry fill: the stop follows the FILLED quantity; targets only after the entry is complete');
  { const B = broker(), { D } = drv(B);
    const r = await D.signal(sig(30), plan(30, { entryType: 'LIMIT' }), 'take-3');
    ok(r.ok && JSON.stringify(B.str()) === JSON.stringify(['SELL LMT 3@28000']), 'L3a a LIMIT entry rests; nothing else is sent', B.str());
    ok(D.fast() === true, 'L3b the 3 s fast poll is on while the entry can fill');
    B.partial(B.book[0].id, 1, 28000); const n0 = B.reqs.length; await D.poll({ lastPx: 27999 });
    ok(JSON.stringify(B.str().slice(n0)) === JSON.stringify(['BUY STOP 1@28030']), 'L3c 1 of 3 filled: a stop for 1 at once, no targets yet', B.str().slice(n0));
    const n1 = B.reqs.length; B.partial(B.book.find(x => x.type === T.LIMIT).id, 2, 28000); await D.poll({ lastPx: 27999 });
    const s1 = B.str().slice(n1);
    ok(s1[0] === 'BUY STOP 3@28030' && /^cancel#/.test(s1[1]) && s1.includes('BUY LMT 2@27970') && s1.includes('BUY LMT 1@27910') && stops(B).length === 1 && stops(B)[0].left === 3, 'L3d complete (3): the stop resized to 3 (new first, old cancelled), then TP1 2 + TP2 1', s1); }

  console.log('L4 a stop reject -> ONE retry at the SAME price -> flatten; a reject when the level is already crossed -> flatten');
  { const B = broker(), { D, pushes } = drv(B); B.rejectIf = b => b.type === T.STOP;
    await D.signal(sig(30), plan(30), 'take-4');
    const s = B.str();
    ok(s[0] === 'SELL MKT 3' && s[1] === 'BUY STOP 3@28030 (rejected)' && s.filter(x => / STOP /.test(x)).length === 2 && s.filter(x => / STOP /.test(x)).every(x => x === 'BUY STOP 3@28030 (rejected)') && s[s.length - 1] === 'BUY MKT 3' && s.filter(x => / MKT 3$/.test(x)).length === 2, 'L4a rejected twice at 28030 (never wider): the position is closed at market', s);
    ok(B.pos === 0 && !D.owned() && pushes.some(p => /no-stop/.test(p)), 'L4b flat, the no-stop alert pushed', { pos: B.pos, ph: D.phase() });
    const B2 = broker(), d2 = drv(B2); await d2.D.signal(sig(30), plan(30), 'take-4b');
    B2.rejectIf = b => b.type === T.STOP; B2.tick(27965); await d2.D.poll({ lastPx: 27965 });   // a ladder move gets rejected ... (the market is far from it)
    B2.rejectIf = b => b.type === T.STOP && b.stopPrice <= 28100; B2.px = 28040;
    const n0 = B2.reqs.length; await d2.D.exitAtMarket('test: crossed');
    ok(B2.pos === 0 && !d2.D.owned() && B2.str().slice(n0).filter(x => / MKT /.test(x)).length === 1, 'L4c an exit with the market through the stop: exactly one market close, flat', B2.str().slice(n0)); }

  console.log('L5 a naked position (the stop vanished at the broker) -> closed at market at once');
  { const B = broker(), { D, pushes } = drv(B); await D.signal(sig(30), plan(30), 'take-5');
    const st = stops(B)[0]; B.book.splice(B.book.indexOf(st), 1); B.hist.get(st.id).status = 3;   // cancelled by hand in TopstepX
    const n0 = B.reqs.length; await D.poll({ lastPx: 27995 }); await D.poll({ lastPx: 27995 });
    const s = B.str().slice(n0);
    ok(B.pos === 0 && s.filter(x => x === 'BUY MKT 3').length === 1 && !D.owned(), 'L5a the vanished stop is seen; the 3 short are closed at market (once); flat', { s, pos: B.pos, ph: D.phase() });
    ok(B.book.length === 0, 'L5b nothing is left resting (targets cancelled)', B.book); }

  console.log('L6 restart mid-trade: no duplicate orders, the stop kept, the guard re-sent');
  { const B = broker(), a = drv(B); await a.D.signal(sig(30), plan(30), 'take-6');
    const n0 = B.reqs.length, stopId = stops(B)[0].id;
    const b = drv(B, { file: a.file }); ok(b.D.owned() === true, 'L6a a new process reads the saved TIDE position: owned (the old path keeps out)');
    await b.D.start(); await b.D.poll({ lastPx: 27995 });
    ok(B.reqs.length === n0 && stops(B).length === 1 && stops(B)[0].id === stopId, 'L6b no order sent at the restart; the same stop rests', B.str().slice(n0));
    ok(b.rows.some(r => r.phase === 'live_guard'), 'L6c the guard is re-sent at the restart reconcile');
    B.tick(27970); await b.D.poll({ lastPx: 27970 }); B.tick(27910); await b.D.poll({ lastPx: 27910 });
    ok(!b.D.owned() && B.pos === 0 && B.book.length === 0, 'L6d the resumed trade runs to its end (TP1, BE, TP2)'); }

  console.log('L6e restart that finds a naked position -> closed at once');
  { const B = broker(), a = drv(B); await a.D.signal(sig(30), plan(30), 'take-6e');
    const st = stops(B)[0]; B.book.splice(B.book.indexOf(st), 1); B.hist.get(st.id).status = 3;
    const b = drv(B, { file: a.file }); const n0 = B.reqs.length; await b.D.start();
    ok(B.pos === 0 && B.str().slice(n0).filter(x => / MKT /.test(x)).length === 1 && !b.D.owned(), 'L6e the restart reconcile flattens the naked 3 (one market order)', B.str().slice(n0)); }

  console.log('L7 duplicate events / calls send nothing new');
  { const B = broker(), { D } = drv(B); await D.signal(sig(30), plan(30), 'take-7'); const n0 = B.reqs.length;
    const r2 = await D.signal(sig(30), plan(30), 'take-7');
    await Promise.all([D.poll({ lastPx: 27999 }), D.poll({ lastPx: 27999 }), D.poll({ lastPx: 27999 })]);
    ok(!r2.ok && r2.why === 'owned' && B.reqs.length === n0, 'L7a a second signal while owned is refused; concurrent polls send nothing', { r2, s: B.str().slice(n0) });
    await D.exitAtMarket('x'); const n1 = B.reqs.length; await D.exitAtMarket('x'); await D.exitAtMarket('y');
    ok(B.reqs.length === n1 && B.places().filter(x => x.type === T.MARKET).length === 2, 'L7b repeated exit requests: exactly one market close', B.str()); }

  console.log('L8 one position account-wide');
  { const B = broker(); B.pos = 2; B.avg = 28000; const { D } = drv(B);
    const r = await D.signal(sig(30), plan(30), 'take-8'); ok(!r.ok && r.why === 'broker-position' && B.places().length === 0, 'L8a the broker shows a position (old path / manual): TIDE does not enter', r);
    B.pos = 0; B.book.push({ id: 9, type: T.LIMIT, side: 0, size: 1, left: 1, limitPrice: 27000 });
    const r2 = await D.signal(sig(30), plan(30), 'take-8b'); ok(!r2.ok && r2.why === 'broker-orders' && B.places().length === 0, 'L8b a working order at the broker: TIDE does not enter', r2);
    B.book.length = 0; const d3 = drv(B, { preCheck: async () => 'the old path holds LEG1_OPEN' });
    const r3 = await d3.D.signal(sig(30), plan(30), 'take-8c'); ok(!r3.ok && /old path/.test(r3.why) && B.places().length === 0, 'L8c the executor pre-check (the old path holds a trade): refused', r3);
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    const te = EX.slice(EX.indexOf('  async function takeEntry('), EX.indexOf('  async function takeEntry(') + 4000);
    ok(/if \(tideOwned\(\) \|\| \(tideLiveOn\(\) && CONFIG\.tide\.oldPathEntries !== true\)\) \{ try \{ journalBlock\(/.test(te) && te.indexOf('tideOwned()') < te.indexOf('CONFIG.levelsOnlyEntries'), 'L8d takeEntry (every old-path route) refuses while TIDE holds a position, and in live mode unless tide.oldPathEntries', null);
    ok(/async function reconcileIfUnknownPosition\(reasonLabel\) \{\n[^\n]*\n    if \(tideOwned\(\)\) return false;/.test(EX), 'L8e the old path never adopts the TIDE position (reconcileIfUnknownPosition)');
    ok(/preCheck: async sig => \{[^\n]*stale[^\n]*stateMachine\.phase === 'FLAT' && !stateMachine\.desynced[^\n]*sessionCloseState\(n, CONFIG\)\.noEntry/.test(EX), 'L8f the executor pre-check: the FSM flat + not desynced, no entry from 12:55 PT'); }

  console.log('L9 12:55 no entry, 13:05 exactly one flatten (the executor wiring + the planner)');
  { const B = broker(), { D } = drv(B, { preCheck: async () => 'session close (no entry from 12:55 PT)' });
    const r = await D.signal(sig(30), plan(30), 'take-9'); ok(!r.ok && B.places().length === 0, 'L9a from 12:55 PT: refused, nothing sent', r);
    const B2 = broker(), d2 = drv(B2); await d2.D.signal(sig(30), plan(30), 'take-9b'); const n0 = B2.reqs.length;
    for (let i = 0; i < 6; i++) { await d2.D.exitAtMarket('session close at 13:05 PT'); await d2.D.poll({ lastPx: 27990 }); }
    const s = B2.str().slice(n0);
    ok(s.filter(x => / MKT /.test(x)).length === 1 && B2.pos === 0 && B2.book.length === 0 && !d2.D.owned(), 'L9b six session-close passes: ONE market close, flat, nothing resting', s);
    const iC = s.findIndex(x => x.startsWith('cancel#' + B2.hist.size && '')), iM = s.indexOf('BUY MKT 3'), stopCancel = s.slice(0, iM).filter(x => /^cancel#/.test(x)).length;
    ok(iM > 0 && stopCancel === 3, 'L9c the planner order: TP1, TP2, then the stop cancelled (verified) BEFORE the market close', s);
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8'), sc = EX.slice(EX.indexOf('  async function sessionCloseStep('), EX.indexOf('  async function morningFlattenStep('));
    ok(/if \(!st\.flattenDue\) return st\.noEntry \? 'no-entry' : null;[\s\S]*if \(LIVE && tideOwned\(\)\) \{[\s\S]*await tideDrv\.exitAtMarket\(/.test(sc), 'L9d sessionCloseStep (13:05 PT, early closes from sessionCloseState) sends the TIDE position to the planner flatten'); }

  console.log('L10 a re-entry is allowed after a closed TIDE trade');
  { const B = broker(), { D, ends } = drv(B); await D.signal(sig(30), plan(30), 'take-10'); B.tick(28030); await D.poll({ lastPx: 28030 });
    ok(!D.owned() && ends.length === 1 && ends[0][1].stopped === true && B.pos === 0, 'L10a stopped out (full structural stop): flat, the end reported as stopped', ends);
    B.px = 28000; const r = await D.signal(sig(30), plan(30), 'take-10b');
    ok(r.ok && D.owned() && B.pos === -3, 'L10b the next TIDE signal is taken', r);
    const sh = { virt: new Map([['A', { live: true, setup: 'S1', id: 'A', dir: -1, closed: null }]]), fb: [] };
    W.liveFeedback(sh, 'A', { closed: true, tp1Done: false, stopped: true });
    ok(sh.fb.length === 1 && sh.fb[0].closed && sh.fbStop && sh.fbStop.dir === -1 && !sh.virt.has('A'), 'L10c liveFeedback: the engine is told the setup closed (+ stoppedOut for a full stop), the TIDE_OPEN block lifts', sh); }

  console.log('L11 no-ack: an unanswered place is reconciled on the next poll; an id-less order is matched, never assumed gone');
  { const B = broker(), { D } = drv(B); B.noAckIf = b => b.type === T.STOP;   // the stop reached the broker but the answer was lost
    await D.signal(sig(30), plan(30), 'take-11'); B.noAckIf = null;
    ok(D.owned() && D.fast(), 'L11a the trade stays owned; the fast poll is on (reconcile pending)');
    const n0 = B.reqs.length; await D.poll({ lastPx: 27995 });
    const st = D.state(), sk = Object.values(st.pos.orders).find(o => o.kind === 'stop');
    ok(B.pos === -3 && B.str().slice(n0).filter(x => !/^cancel/.test(x)).length === 0 && D.owned() && stops(B).length === 1 && sk.status === 'working' && st.ids[sk.key] === stops(B)[0].id, 'L11b the reconcile matched the id-less stop (side / type / size / price): it is the working stop; no duplicate stop, no flatten', { s: B.str().slice(n0), sk });
    const B2 = broker(), d2 = drv(B2); B2.noAckIf = b => b.type === T.MARKET; await d2.D.signal(sig(30), plan(30), 'take-11c'); B2.noAckIf = null;
    await d2.D.poll({ lastPx: 27995 });
    ok(!(B2.pos !== 0 && stops(B2).length === 0), 'L11c an unanswered MARKET entry that filled is never left naked', { pos: B2.pos, s: B2.str() }); }

  console.log('L12 sizing (Mac 11/04, 50K): flat $200, take1 <= $400, nearFloor');
  { const B = broker(), { D, pushes } = drv(B);
    const r = await D.signal(sig(146.25), plan(146.25), 'take-12');
    ok(r.ok && B.str()[0] === 'SELL MKT 1', 'L12a the 11/04 A+ (146.25 pts, $292.50) at flat $200: take1 = 1 MNQ placed', B.str());
    const B2 = broker(), d2 = drv(B2); const r2 = await d2.D.signal(sig(200), plan(200), 'take-12b');
    ok(r2.ok && B2.str()[0] === 'SELL MKT 1' && d2.pushes.some(p => /take1: 1 MNQ over budget/.test(p) && /risk \$400/.test(p)), 'L12b a 200-pt stop at $200: 1 MNQ placed; the push names the actual risk $400', d2.pushes);
    const B3 = broker(), d3 = drv(B3); const r3 = await d3.D.signal(sig(250), plan(250), 'take-12c');
    ok(!r3.ok && r3.why === 'GRADE_NO_FIT_CEILING' && B3.places().length === 0, 'L12c a 250-pt stop ($500 > $400): skipped (GRADE_NO_FIT_CEILING)', r3);
    const cfg = { tide: { ...W.DEFAULTS.tide, mode: 'shadow' }, money: W.moneyDefaults() };
    const s250 = { dir: -1, entry: 28000, stop: 28250, grade: 'A+', gradePoints: 4, levelName: '4H Open', kind: 'trap', stopTf: '4H', pools: [{ price: 27000, major: true, name: 'PDL' }] };
    const p250 = W.plan(s250, cfg, 2, 0.25, null, 50000), p150 = W.plan({ ...s250, stop: 28150 }, cfg, 2, 0.25, null, 50000);
    ok(!p250.ok && p250.code === 'GRADE_NO_FIT_CEILING' && p150.ok && p150.qty === 1 && p150.riskUsd === 300, 'L12d the wire: 150 pts -> 1 MNQ ($300) taken; 250 pts -> GRADE_NO_FIT_CEILING (journaled + pushed)', [p150.code, p150.qty, p250.code]);
    const B4 = broker(), d4 = drv(B4, { money: MONEY({ flatDollars: 400 }), floor: 20000 }); await d4.D.signal(sig(50), plan(50), 'take-12e');
    ok(B4.str()[0] === 'SELL MKT 4', 'L12e flat $400 with the floor far away: the $400 size (4 MNQ at 50 pts) - the near-floor guard is fed the real distance', B4.str());
    const B5 = broker(), d5 = drv(B5, { money: MONEY({ flatDollars: 400, nearFloor: { enabled: true, cushionUsd: 1000, dollars: 200 } }), floor: 500 }); await d5.D.signal(sig(50), plan(50), 'take-12f');
    ok(B5.str()[0] === 'SELL MKT 2', 'L12f nearfloor=on (shipped OFF): flat $400 within $1,000 of the floor is capped at $200 (2 MNQ) - the planner gets the real floor distance', B5.str());
    { const SH = W.moneyDefaults(), B6 = broker(), d6 = drv(B6, { money: SH, floor: 20000 }); await d6.D.signal(sig(146.25), plan(146.25), 'take-12h');
      const B7 = broker(), d7 = drv(B7, { money: SH, floor: 20000 }); await d7.D.signal(sig(50), plan(50), 'take-12i');
      const B8 = broker(), d8 = drv(B8, { money: SH, floor: 20000 }); const r8 = await d8.D.signal(sig(250), plan(250), 'take-12j');
      ok(SH.sizing.flatDollars === 400 && B6.str()[0] === 'SELL MKT 1' && B7.str()[0] === 'SELL MKT 4' && !r8.ok && r8.why === 'GRADE_NO_FIT_CEILING', 'L12h the SHIPPED live money (flat $400, Mac 07:45Z): the 11/04 A+ 146.25 pts -> 1 MNQ ($292.50, fits); 50 pts far from the floor -> the full $400 (4 MNQ); 250 pts -> ceiling skip', [SH.sizing.flatDollars, B6.str()[0], B7.str()[0], r8]); }
    ok(W.configProblem({ tide: { ...W.DEFAULTS.tide }, money: MONEY({ take1MaxUsd: -5 }) }, { symbol: 'MNQ', pointValue: 2, minContracts: 1 }) !== null, 'L12g a bad take1MaxUsd is refused at startup'); }

  console.log('L13 the stop level is the BROKER-acked one; no pyramid add; config refusals');
  { const B = broker(); B.stopPxShift = -0.5; const { D, rows } = drv(B); await D.signal(sig(30), plan(30), 'take-13');
    const ack = rows.find(r => r.phase === 'live_stop_ack');
    ok(ack && ack.acked === 28029.5 && ack.source === 'broker' && D.state().pos.protPx === 28029.5, 'L13a the stop the broker shows (28029.5) is the recorded level, not the price sent (28030)', ack);
    const src = fs.readFileSync(path.join(ROOT, 'lib/tideLive.js'), 'utf8');
    ok(!/'pullback-add'/.test(src) && /ADD_WOULD_FIRE/.test(src), 'L13b no pyramid add: the driver never sends pullback-add; an add intent is journaled ADD_WOULD_FIRE and refused');
    const CTX = { symbol: 'MNQ', pointValue: 2, minContracts: 3 };
    const live = (t = {}, m = MONEY()) => W.configProblem({ tide: { ...W.DEFAULTS.tide, mode: 'live', ...t }, money: m }, CTX);
    ok(/liveArmed/.test(live() || '') && live({ liveArmed: W.LIVE_ARM }) === null, 'L13c mode live needs the set-tide.sh live token; with it the shipped config loads');
    ok(/entryByGrade/.test(live({ liveArmed: W.LIVE_ARM }, MONEY({ entryByGrade: true })) || ''), 'L13d live refuses entryByGrade true (no resting half)');
    ok(W.DEFAULTS.tide.mode === 'off' && W.DEFAULTS.tide.oldPathEntries === false && W.DEFAULTS.tide.useTimeBlocks === true && W.DEFAULTS.tide.openWaitMin === 30, 'L13e defaults: off, oldPathEntries false, TIDE time blocks ON (Mac 07:30Z), open wait 30');
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    ok(/tide: \{ mode: 'off',/.test(EX) && /if \(LIVE && tideLiveOn\(\)\) tideDrv = tideLive\.create\(/.test(EX), 'L13f the executor ships tide.mode off; the driver exists only with --live and mode live'); }

  console.log('L14 the 30-min entry expiry cancels an unfilled LIMIT entry (verified) and frees TIDE');
  { const B = broker(); let clock = 1e12; const rows = [];
    const D = L.create({ token: 'f', accountId: 1, contractId: 'C', orders: B.api, cfgFn: () => ({ ...W.moneyOnly(MONEY()), pointValue: 2, tickSize: 0.25, floorDistanceUsd: 50000 }), stateFile: path.join(DIR, 'exp.json'), journal: r => rows.push(r), now: () => clock, sleep: async () => {} });
    await D.signal(sig(30), plan(30, { entryType: 'LIMIT' }), 'take-14'); clock += 31 * 60000; await D.poll({ lastPx: 27990 });
    ok(!D.owned() && B.book.length === 0 && B.pos === 0 && B.str().filter(x => /^cancel/.test(x)).length === 1, 'L14a after 30 min: the entry cancelled once, TIDE free', B.str()); }

  console.log('L15 news lock: TP1 fills, the stop re-size is rejected -> URGENT oversize push (rate-limited), a re-size try each poll, cleared when it works');
  { const B = broker(), { D, pushes, rows } = drv(B); await D.signal(sig(30), plan(30), 'take-15');
    B.rejectIf = b => b.type === T.STOP && b.size === 1;   // the lock: the re-size to the runner is refused
    B.tick(27970); await D.poll({ lastPx: 27970 }); await D.poll({ lastPx: 27969 }); await D.poll({ lastPx: 27968 });
    const urg = pushes.filter(p => /TIDE URGENT: stop oversized 3 for 1 open - reversal risk, reduce stop in TopstepX/.test(p));
    ok(urg.length === 1 && stops(B).length === 1 && stops(B)[0].left === 3 && B.pos === -1, 'L15a one URGENT push (60 s limit) naming 3 for 1 open; the old stop kept (the runner is not left naked)', { urg: urg.length, stops: stops(B).map(s => s.left) });
    const tries = B.reqs.filter(r => r.req === 'place' && r.type === T.STOP && r.size === 1).length;
    ok(tries >= 3 && tries <= 8, 'L15b the re-size is retried each poll (bounded: <= 2 requests per poll)', tries);
    B.rejectIf = null; await D.poll({ lastPx: 27968 }); await D.poll({ lastPx: 27968 });
    ok(stops(B).length === 1 && stops(B)[0].left === 1 && rows.some(r => r.phase === 'live_stop_oversized_cleared') && D.state().oversize == null, 'L15c the lock ends: the stop is re-sized to 1, the alert clears', stops(B).map(s => s.left)); }

  console.log('L16 [r1.1] TIDE\'s OWN entry blocks (15:00-17:00, 06:30-07:10 PT), independent of the old path\'s block keys');
  { const at = (h, m) => Date.UTC(2026, 10, 4, h + 8, m), c = { tide: { ...W.DEFAULTS.tide, mode: 'live', liveArmed: W.LIVE_ARM }, money: W.moneyDefaults() };
    ok(/TIDE block 15:00-17:00/.test(W.blockAt(c, at(16, 8)) || '') && /TIDE block 06:30-07:10/.test(W.blockAt(c, at(7, 5)) || ''), 'L16a 16:08 and 07:05 PT -> TIME_BLOCK');
    ok(W.blockAt(c, at(17, 5)) === null && W.blockAt(c, at(7, 15)) === null && W.blockAt(c, at(5, 30)) === null, 'L16b 17:05, 07:15 and 05:30 PT (the morning hold is not a TIDE block) -> allowed');
    ok(W.blockAt({ ...c, tide: { ...c.tide, useTimeBlocks: false } }, at(16, 8)) === null, 'L16c tide.useTimeBlocks false -> no TIDE block');
    const g = W.tideGate({ flat: true, useTimeBlocks: true, timeBlock: W.blockAt(c, at(16, 8)), mode: 'add' });
    ok(!g.ok && g.code === 'TIME_BLOCK', 'L16d the gate journals TIME_BLOCK (not taken)', g);
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    ok(/timeBlock: soft\(\(\) => tideWire\.blockAt\(CONFIG, now\)\)/.test(EX) && /const tb = tideWire\.blockAt\(CONFIG, n\); if \(tb\) return 'TIME_BLOCK: ' \+ tb;/.test(EX) && !/timeBlock: soft\(\(\) => \(inMorningHold/.test(EX), 'L16e the executor gate and the pre-check use tideWire.blockAt (never asiaBlackout / blockNyOpenMinutes)');
    ok(/TIDE entry blocks ON \(15:00-17:00, 06:30-07:10 PT\)/.test(W.startupLines(c)[0]), 'L16f the startup line: TIDE entry blocks ON (15:00-17:00, 06:30-07:10 PT)'); }

  console.log('L17 [r1.1] old model off: in TIDE live the old path\'s signal pushes are journal / log only; safety pushes stay; off is untouched');
  { const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8'), a = EX.indexOf('const OLD_SIGNAL_PUSH'), b = EX.indexOf('function notifyPhone(');
    const mk = cfg => new Function('CONFIG', 'tideWire', EX.slice(a, b) + '; return oldPathSilenced;')(cfg, W);
    const live = mk({ tide: { ...W.DEFAULTS.tide, mode: 'live', liveArmed: W.LIVE_ARM, oldPathEntries: false } }), off = mk({ tide: { ...W.DEFAULTS.tide } }), both = mk({ tide: { ...W.DEFAULTS.tide, mode: 'live', oldPathEntries: true } });
    const sig = ['Signal: LONG A @ 28000', 'Entry refused by the broker guard', 'Control: SELLERS', 'Crossed PDH', 'Reclaim re-entry attempted: LONG'], safe = ['NOT FLAT - FLATTEN IN TOPSTEPX NOW', 'Executor crashed', 'BROKER AUTH FAILED', 'Status update', 'Daily floor hit', 'TIDE live: FILLED', 'TIDE live signal', 'Bot paused'];
    ok(sig.every(t => live(t)) && safe.every(t => !live(t)), 'L17a TIDE live: the old path\'s signal / refused / control / cross / reclaim pushes are silenced; safety, system and TIDE pushes are sent');
    ok(sig.every(t => !off(t)) && sig.every(t => !both(t)), 'L17b tide off (r13.3.7 identity) and tide.oldPathEntries true: nothing is silenced');
    ok(/if \(oldPathSilenced\(title\)\) \{ log\(/.test(EX) && /old levels path \$\{CONFIG\.tide\.oldPathEntries === true \? 'ON \(new entries too\)' : 'OFF \(manage-only; its signal pushes silenced\)'\}/.test(EX), 'L17c notifyPhone logs a silenced push instead; the startup line says old levels path OFF (manage-only)'); }

  console.log('L19 [r1.2] the phone view (snapshot.tide): the live position from the broker fills, today\'s trades and alerts');
  { const B = broker(), { D } = drv(B); await D.signal(sig(30), plan(30), 'take-19');
    const v1 = D.view(), p = v1.position;
    ok(p && p.dir === -1 && p.filledQty === 3 && p.open === 3 && p.avgEntry === 28000 && Number.isFinite(p.fillAt) && p.stopAcked === 28030 && p.stopAsked === 28030 && p.tp1.price === 27970 && p.tp1.qty === 2 && !p.tp1.done && p.tp2.price === 27910 && p.signalId === 'take-19', 'L19a the open position: qty, avgEntry, fillAt, the acked stop, TP1 / TP2', p);
    B.tick(27970); await D.poll({ lastPx: 27970 }); const v2 = D.view().position;
    ok(v2.tp1.done && v2.tp1.filled === 2 && v2.open === 1 && v2.stopAcked === 27999.75 && v2.lastPx === 27970 && v2.openUsd === 60, 'L19b after TP1: done flags, the BE stop acked, lastPx, openUsd', v2);
    B.tick(27910); await D.poll({ lastPx: 27910 }); const v3 = D.view();
    ok(v3.position === null && v3.trades.length === 1 && v3.trades[0].exitPath === 'tp2' && v3.trades[0].resultR === 1.67 && v3.trades[0].grossUsd === 300 && v3.trades[0].qty === 3 && v3.trades[0].avgEntry === 28000, 'L19c flat: position null, today\'s trade with exitPath, resultR, $', v3.trades);
    await D.signal(sig(30), plan(30), 'take-19b'); ok(D.view().trades.length === 1 && D.view().position && D.view().position.signalId === 'take-19b', 'L19d a new position keeps today\'s closed trades');
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    ok(/\.\.\.\(tideOn\(\) \? \{ tide: tideSnapshotView\(\) \} : \{\}\),/.test(EX) && /if \(row\.type === 'lv_tide'\) tideRowNote\(row\);/.test(EX), 'L19e snapshot.tide is written only with tideOn() (absent when off); the rows ring takes only lv_tide rows'); }

  console.log('L20 [r1.2] recentTrades[].model = "tide": a broker round trip holding a TIDE order\'s fill is tagged (live only)');
  { const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    const grab = name => { const a = EX.indexOf(`  function ${name}(`); let d = 0, i = EX.indexOf('{', a); for (; i < EX.length; i++) { if (EX[i] === '{') d++; else if (EX[i] === '}' && --d === 0) break; } return EX.slice(a, i + 1); };
    const B = broker(), { D } = drv(B); await D.signal(sig(30), plan(30), 'take-20'); B.tick(28030); await D.poll({ lastPx: 28030 });
    const ids = D.view().orderIds, e = B.hist.get(Number(ids[0])), st = [...B.hist.values()].find(h => h.type === T.STOP && h.status === 2);
    const fills = [{ orderId: e.id, contractId: 'C', side: 1, size: 3, price: 28000, creationTimestamp: '2026-11-04T00:08:11Z' }, { orderId: st.id, contractId: 'C', side: 0, size: 3, price: 28030, profitAndLoss: -180, fees: 1, creationTimestamp: '2026-11-04T00:20:00Z' },
      { orderId: 9999, contractId: 'C', side: 0, size: 1, price: 28100, creationTimestamp: '2026-11-04T01:00:00Z' }, { orderId: 9998, contractId: 'C', side: 1, size: 1, price: 28110, profitAndLoss: 20, creationTimestamp: '2026-11-04T01:05:00Z' }];
    const fn = new Function('CONFIG', 'tideDrv', grab('computeRecentTrades') + '\n' + grab('tideTagFills') + '\n return { computeRecentTrades, tideTagFills };')({ brokerCosts: { feePerContractSide: 0.36, commissionPerContractSide: 0.25 } }, D);
    const trips = fn.computeRecentTrades(fills), off = JSON.stringify(fn.computeRecentTrades(fills)); fn.tideTagFills(trips, fills);
    const tide = trips.find(t => t.entryPrice === 28000), old = trips.find(t => t.entryPrice === 28100);
    ok(tide && tide.model === 'tide' && old && old.model === undefined, 'L20a the TIDE trip is tagged model "tide"; the other trip is left untagged', trips.map(t => [t.entryPrice, t.model]));
    ok(!off.includes('"model"') && /if \(tideLiveOn\(\) && tideDrv\) tideTagFills\(lastBrokerRoundTrips, fills\);/.test(EX), 'L20b untagged trips are byte-unchanged; the tag runs only with TIDE live (off / shadow: the trips are r13.3.7\'s)'); }

  console.log('L21 [r1.2] the snapshot file is written atomically: a concurrent reader never sees an empty or partial file (1,000 writes)');
  { const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8'), a = EX.indexOf('function writeFileAtomic('), b = EX.indexOf('\n}\n', a) + 2;
    const writeFileAtomic = new Function('fs', EX.slice(a, b) + '; return writeFileAtomic;')(fs), F = path.join(DIR, 'bias-snapshot-TEST.json');
    writeFileAtomic(F, JSON.stringify({ n: -1, pad: 'x'.repeat(200000) }));
    const { spawn } = require('child_process');
    const rd = spawn(process.execPath, ['-e', `const fs=require('fs');let bad=0,ok=0;const end=Date.now()+60000;process.on('message',()=>{process.send({bad,ok});process.exit(0)});(function loop(){for(let i=0;i<50;i++){try{const t=fs.readFileSync(${JSON.stringify(F)},'utf8');if(!t.length){bad++;continue}JSON.parse(t);ok++}catch(e){bad++}}if(Date.now()<end)setImmediate(loop)})();`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 1000; i++) writeFileAtomic(F, JSON.stringify({ n: i, pad: 'x'.repeat(200000 + (i % 7) * 1000) }));
    const res = await new Promise(r => { rd.once('message', r); rd.send('done'); });
    const leftovers = fs.readdirSync(DIR).filter(f => f.startsWith('bias-snapshot-TEST.json.tmp'));
    ok(res.bad === 0 && res.ok > 100 && JSON.parse(fs.readFileSync(F, 'utf8')).n === 999 && leftovers.length === 0, 'L21a 1,000 atomic writes of a ~200 KB snapshot: the reader saw 0 empty / partial files; the last write is the file; no temp file left', { res, leftovers });
    ok(/writeFileAtomic\(BIAS_SNAPSHOT_FILE, JSON\.stringify\(\{/.test(EX) && !/fs\.writeFileSync\(BIAS_SNAPSHOT_FILE/.test(EX), 'L21b writeSnapshotFile uses the atomic write in every mode (same bytes)'); }

  console.log('L23 [r1.2] the rebuild WATCHDOG: progress every 60 s from the worker; no answer in 10 min -> the worker is terminated, the PRE_RESTART fallback, TIDE goes live');
  { const RB = require(path.join(ROOT, 'lib/tideRebuild.js')), slow = path.join(DIR, 'slowLevelsPro.js');
    fs.writeFileSync(slow, "exports.evaluateLevelsPro = () => { const t = Date.now(); while (Date.now() - t < 40) {} return [{ biasScore: 0.1, levels: [] }]; };");
    const m1 = [], t0 = Math.floor(Date.now() / 60000) * 60 - 7200; for (let t = t0; t < t0 + 7200; t += 60) m1.push({ t, o: 1, h: 2, l: 0, c: 1, v: 1 });
    const prog = []; let err = null; const s0 = Date.now();
    try { await RB.rebuildBias({ m1, htf: {}, now: (t0 + 7200) * 1000, hours: 2, levelsPro: require(slow), worker: true, levelsProPath: slow, timeoutMs: 2500, progressMs: 500, onProgress: x => prog.push(x) }); } catch (e) { err = e; }
    ok(err && err.timedOut === true && Date.now() - s0 < 6000, 'L23a no answer within the timeout: rejected (timedOut) and the worker terminated', err && err.message);
    ok(prog.length >= 2 && prog.every(x => Number.isFinite(x.done) && x.of === 120) && prog[prog.length - 1].done > prog[0].done, 'L23b progress (n of N minutes) arrives from the worker every progressMs', prog);
    const fast = await RB.rebuildBias({ m1: m1.slice(-20), htf: {}, now: (t0 + 7200) * 1000, hours: 0.25, levelsPro: { evaluateLevelsPro: () => [{ biasScore: 0.2, levels: [] }] }, timeoutMs: 600000 });
    ok(fast && fast.n > 0, 'L23c a rebuild that answers in time is used as before');
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    ok(/timeoutMs: 15 \* 60000, progressMs: 60000, onProgress: x => log\(`  \[tide\] rebuild progress:/.test(EX) && /if \(e && e\.timedOut\) notifyPhone\('TIDE warm-up rebuild timed out - using the PRE_RESTART fallback'/.test(EX), 'L23d the executor: 10-min watchdog, progress logged every 60 s, the timeout push, then the fallback (TIDE goes live)'); }

  console.log('L22 [r1.1a] the warm-up read ladder: 6000 -> 3000 -> 2000 -> 1500 at once; every failure logged with its cause; all failed -> alert + 30 s retry');
  { const err = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET' }; return e; };
    const logs = [], tried = []; const r = await W.warmRead(async l => { tried.push(l); if (l >= 6000) throw err(); return [{ t: 1, o: 1, h: 1, l: 1, c: 1 }]; }, m => logs.push(m));
    ok(r.bars && r.limit === 3000 && JSON.stringify(tried) === '[6000,6000,3000]' && logs.length === 2 && /limit 6000: fetch failed \[cause: UND_ERR_SOCKET\]/.test(logs[1]), 'L22a 6000 fails (fetch failed, cause logged) -> it warms on 3000 at once', { tried, logs });
    const logs2 = [], tried2 = []; const r2 = await W.warmRead(async l => { tried2.push(l); throw err(); }, m => logs2.push(m));
    ok(r2.bars === null && JSON.stringify(tried2) === '[6000,6000,3000,3000,2000,2000,1500,1500]' && logs2.length === 8 && r2.errors.length === 4, 'L22b every limit fails: all four tried in sequence, each failure logged', { tried2, n: logs2.length });
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    ok(/tideFeedNextAt = now \+ Math\.min\(60000, 30000 \* tideFeedFails\)/.test(EX) && /if \(!tideWarmAlerted\) \{ tideWarmAlerted = true; notifyPhone\("TIDE warm-up can't read 1m history - not trading yet"/.test(EX) && !/tideFeedFails === 1 \|\| tideFeedFails % 10 === 0/.test(EX), 'L22c the executor: all failed -> retry in 30 s (cap 60 s), ONE phone alert; every failure logged (no 1st / every-10th filter)'); }

  console.log('L24 [r1.2] a stale socket (UND_ERR_SOCKET / ECONNRESET): the same read is retried ONCE at once (warm-up and gap reads); counted for the hourly line');
  { const sock = code => { const e = new TypeError('fetch failed'); e.cause = { code }; return e; };
    let n = 0; const logs = []; const r = await W.socketRetry(async () => { if (++n === 1) throw sock('UND_ERR_SOCKET'); return 'bars'; }, m => logs.push(m), 'gap read');
    ok(r === 'bars' && n === 2 && logs.length === 1 && /stale socket: retrying once now/.test(logs[0]), 'L24a UND_ERR_SOCKET -> one immediate retry, which answers', { n, logs });
    let m = 0, e1 = null; try { await W.socketRetry(async () => { m++; throw sock('ECONNRESET'); }); } catch (e) { e1 = e; }
    ok(e1 && m === 2, 'L24b ECONNRESET twice -> exactly one retry, then the error goes to the 15 s schedule', m);
    let k = 0, e2 = null; try { await W.socketRetry(async () => { k++; throw new Error('HTTP 500'); }); } catch (e) { e2 = e; }
    ok(e2 && k === 1, 'L24c a non-socket error is not retried here', k);
    const tried = []; let first = true; const wr = await W.warmRead(async l => { tried.push(l); if (first) { first = false; throw sock('UND_ERR_SOCKET'); } return ['ok']; }, () => {});
    ok(wr.bars && wr.limit === 6000 && JSON.stringify(tried) === '[6000,6000]', 'L24d the warm-up: a stale socket at 6000 is retried at 6000 before the ladder steps down', tried);
    ok(W.readStats.socketRetries >= 3 && W.readStats.socketRetryOk >= 2, 'L24e the counters (for the hourly [tide] line)', W.readStats);
    const EX = fs.readFileSync(path.join(ROOT, 'live-executor.js'), 'utf8');
    ok(/tideWire\.socketRetry\(\(\) => fetchBars\(token, contractId, UNIT\.MINUTE, 1, \{ limit: lim \}\)/.test(EX) && /\[tide\] hourly: 1m reads - stale-socket retries/.test(EX) && /const m1 = await fetchBars\(token, contractId, UNIT\.MINUTE, 1, \{ limit: 3 \}\);/.test(EX), 'L24f the executor: TIDE\'s gap read retries; the hourly line; the old path\'s own reads are unchanged'); }

  console.log(`tide-live (${L.VERSION}, ${require(path.join(ROOT, 'lib/tideOrders.js')).VERSION}, ${W.VERSION}): ${pass} passed, ${fail} failed`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e.stack); process.exit(2); });
