'use strict';
// REVIEW DESK tests (harness lines 1-80 copied from the builder edge1-tests.js): node edge1-tests.js <tree> <base-tree (r1.1)> <tmpdir>. Real LiveStateMachine (both trees) and real lib modules against ONE stateful fake broker
// (position, working orders, order history, lost replies, rejections, sticky cancels). A: early adverse exit. B: session runner rule.
const path = require('path'), fs = require('fs');
const [TREE, BASE, TMP] = process.argv.slice(2).map(p => path.resolve(p));
fs.mkdirSync(TMP, { recursive: true });
const B = {};
function resetB() { Object.assign(B, { pos: null, orders: [], nextId: 100, log: [], history: [], marketMode: 'accept', modes: [], limitModes: [], stopModes: [], sticky: new Set(), onMarket: null, px: 20000, posFail: 0, cancels: 0 }); }
resetB();
const net = () => B.pos ? (B.pos.type === 1 ? B.pos.size : -B.pos.size) : 0;
const setNet = (n, avg) => { B.pos = n === 0 ? null : { contractId: 'C', size: Math.abs(n), type: n > 0 ? 1 : 2, averagePrice: avg ?? (B.pos ? B.pos.averagePrice : B.px) }; };
let OrderType, OrderSide;
function stub(root) {
  const p = require.resolve(path.join(root, 'lib/liveOrders.js')), real = require(p); ({ OrderType, OrderSide } = real);
  require.cache[p].exports = { ...real,
    getOpenPosition: async () => { if (B.posFail > 0) { B.posFail--; throw new Error('read timeout'); } return B.pos ? { ...B.pos } : null; },
    getOpenOrders: async () => B.orders.map(o => ({ ...o })),
    getEntryOrder: async () => null,
    searchOrdersSince: async () => B.history.map(o => ({ ...o, contractId: 'C' })),
    cancelOrder: async (t, a, id) => { B.log.push('cancel ' + id); B.cancels++; if (B.sticky.has(id)) return false; const had = B.orders.some(o => o.id === id); B.orders = B.orders.filter(o => o.id !== id); return had; },
    placeOrder: async (t, o) => {
      const id = B.nextId++;
      if (o.type === real.OrderType.MARKET) {
        const signed = o.side === real.OrderSide.BUY ? o.size : -o.size, opening = net() === 0 || Math.sign(net()) === Math.sign(signed), mode = opening ? 'accept' : (B.modes.length ? B.modes.shift() : B.marketMode);
        B.log.push(`MARKET ${o.side === real.OrderSide.BUY ? 'BUY' : 'SELL'} ${o.size}${opening ? ' (entry)' : ` [${mode}]`}`);
        if (!opening && B.onMarket) B.onMarket();
        const hist = status => B.history.push({ id, type: 2, side: o.side, size: o.size, status, creationTimestamp: new Date().toISOString() });
        if (mode === 'hang') return new Promise(() => {});
        if (mode === 'reject') { hist(5); const e = new Error('Order/place failed: rejected'); e.orderRejected = true; throw e; }
        if (mode === 'timeout-accepted') { hist(2); setNet(net() + signed); throw new Error('fetch timeout'); }
        if (mode === 'timeout-lost') throw new Error('fetch timeout');
        hist(2); setNet(net() + signed, opening ? B.px : undefined); return { success: true, orderId: id };
      }
      const isStop = o.type === real.OrderType.STOP, mode = (isStop ? B.stopModes : B.limitModes).shift() || 'accept', kind = isStop ? 'STOP' : 'LIMIT', px = o.stopPrice ?? o.limitPrice;
      if (mode === 'reject') { B.log.push(`${kind} ${o.size} @ ${px} REJECTED`); const e = new Error('Order/place failed: rejected'); e.orderRejected = true; throw e; }
      if (mode === 'timeout') { B.log.push(`${kind} ${o.size} @ ${px} TIMEOUT (not resting)`); throw new Error('fetch timeout'); }
      B.orders.push({ id, size: o.size, stopPrice: o.stopPrice, limitPrice: o.limitPrice, type: o.type, side: o.side });
      B.log.push(`REST ${kind} ${o.size} @ ${px}`);
      if (mode === 'lost') throw new Error('fetch timeout');   // accepted and resting, the reply was lost
      return { success: true, orderId: id };
    } };
}
stub(TREE); stub(BASE);
const fill = id => { const o = B.orders.find(x => x.id === id); if (!o) throw new Error('no order ' + id); B.orders = B.orders.filter(x => x.id !== id); const n = net(); setNet(n - Math.sign(n) * o.size); B.log.push(`FILL ${o.stopPrice != null ? 'STOP' : 'LIMIT'} ${o.size} @ ${o.stopPrice ?? o.limitPrice}`); };
const fillPart = (id, k) => { const o = B.orders.find(x => x.id === id); o.size -= k; const n = net(); setNet(n - Math.sign(n) * k); B.log.push(`PARTIAL ${k}`); };
const { LiveStateMachine } = require(path.join(TREE, 'lib/liveStateMachine.js'));
const Base = require(path.join(BASE, 'lib/liveStateMachine.js')).LiveStateMachine;
const EE = require(path.join(TREE, 'lib/edgeExits.js')), SF = require(path.join(TREE, 'lib/stopFloor.js')), PS = require(path.join(TREE, 'lib/phoneSnapshot.js'));
const SRC = fs.readFileSync(path.join(TREE, 'live-executor.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const stops = () => B.orders.filter(o => o.stopPrice != null), limits = () => B.orders.filter(o => o.limitPrice != null);
const markets = () => B.log.filter(x => x.startsWith('MARKET') && !/entry/.test(x)).length;
function mkRaw(Cls, extra = {}) {
  const journal = [], notif = [], logs = [];
  const sm = new Cls({ token: 't', accountId: 1, contractId: 'C', pointValue: 2, tickSize: 0.25, log: m => logs.push(m), notify: (a, b) => notif.push(a + ' :: ' + b), journal: r => journal.push(r), runnerTrailRule: { lockPts: 10, stepPts: 10 }, tp1FromFill: true, ...extra });
  Object.assign(sm, { sessionConfirmMs: 0, settleReadMs: 0 });
  sm.trailRefPrice = async f => B.px;
  const codes = () => journal.filter(r => r.type === 'trade_manage').map(r => r.code), rows = t => journal.filter(r => r.type === t);
  return { sm, journal, notif, logs, codes, rows };
}
// ---------- A. early adverse exit: a LEG1_OPEN trade resting a 3x stop (id 11) and a 2x TP1 (id 12) ----------
const CFG = { mode: 'exit', afterSec: 120, lossPts: 10, minSeenPts: 3 }, LOG = { ...CFG, mode: 'log' };
const T0 = Math.floor((Date.now() - 600000) / 300000) * 300000, FILL = T0 + 30000;   // the fill is seen 30 s into a minute; the first 1m close >= 120 s later is T0 + 180 s
const bar = (i, h, l, c) => ({ t: T0 + i * 60000, o: c, h, l, c });
function mkA(dir, extra = {}, Cls = LiveStateMachine) {
  const x = mkRaw(Cls, extra); resetB();
  const e = dir === 1 ? 20010 : 19990;
  Object.assign(x.sm, { phase: 'LEG1_OPEN', dir, entryPrice: e, intendedEntryPrice: e, contracts: 3, leg1Size: 2, leg2Size: 0, target1: e + dir * 15, target2: e + dir * 40, stopPriceIntended: e - dir * 30, trailStop: null, stopOrderId: 11, targetOrderId: 12, fillHandled: true,
    npFillAt: FILL, npBestPts: 0, npCoveredTo: T0 + 60000, npGap: false, npState: null });
  B.pos = { contractId: 'C', size: 3, type: dir === 1 ? 1 : 2, averagePrice: e };
  B.orders = [{ id: 11, size: 3, stopPrice: e - dir * 30, type: 4 }, { id: 12, size: 2, limitPrice: e + dir * 15, type: 1 }];
  return x;
}
// one poll: np1's tracker first (as the executor does), then the early-exit step
async function poll(x, m1, now, cfg = CFG) { x.sm.noteNoProgressPrices(m1, null, now); return x.sm.earlyAdverseStep(cfg, m1, now); }
// long from 20010: bar 1 (T0+60..120) sets the MFE through its high; bar 2 (T0+120..180) is the 1m close the rule reads; bar 3 is forming
const m1L = (mfe, closePts) => [bar(1, 20010 + mfe, 20005, 20008), bar(2, 20008, 20010 + closePts - 1, 20010 + closePts), bar(3, 20000, 19999, 20000)];
const m1S = (mfe, closePts) => [bar(1, 19995, 19990 - mfe, 19992), bar(2, 19990 - closePts + 1, 19992, 19990 - closePts), bar(3, 20000, 19999, 20000)];
const NOW = T0 + 185000;
// ===================== reviewer desk, phase 2: the r1.1 fixes =====================
(async () => {
  const planFn = (mode, o = {}) => () => ({ session: o.session || 'ny', mode, stopPts: 2, tp2AtrMult: 2, atr15: 40, why: null });
  async function enter(Cls, dir, extra = {}, o = {}) {
    const x = mkRaw(Cls, extra); resetB(); B.px = 20000; const n = 3, e = 20000;
    Object.assign(x.sm, { phase: 'PENDING_ENTRY', dir, stopPriceIntended: e - dir * 50, target1: e + dir * 15, target2: e + dir * 40, tightStopPrice: null, smartHoldChecked: false, intendedEntryPrice: e, source: 'levels', grade: 'A', contracts: n,
      leg1Size: n - 1, leg2Size: 0, entrySignalTime: Date.now(), entryType: 'MARKET', fillHandled: false, throughStop: false, signalContext: null, sessionExit: null, entryOrderId: 90 });
    B.log.push('MARKET BUY 3 (entry)'); setNet(dir * n, B.px); await x.sm.tick(); return x;
  }
  const tpId = () => (limits()[0] || {}).id, stopId = () => (stops()[0] || {}).id;
  const ATR = { sessionRunnerFn: planFn('atrTarget') };
  const afterTp1 = async (dir, extra) => { const x = await enter(LiveStateMachine, dir, extra); fill(tpId()); await x.sm.tick(); return x; };
  const info = (name, v) => console.log('info ' + name + ' :: ' + v);

  // F1 S1a: halted, runner OPEN: only the TP2 limit goes; the stop is never cancelled, on any number of polls
  { const x = await afterTp1(1, ATR); x.sm.desynced = true; for (let i = 0; i < 6; i++) await x.sm.tick();
    ok(net() === 1 && stops().length === 1 && stops()[0].stopPrice === 20002 && limits().length === 0, 'F1 halted, runner open, 6 polls: TP2 limit cancelled, the 1x stop @ 20002 still rests'); }
  // F2 S1b: halted, the broker reads FLAT on two polls although the runner is still open (a wrong / lagging position read): is the protective stop cancelled?
  { const x = await afterTp1(1, ATR); x.sm.desynced = true; await x.sm.tick(); const real = B.pos; B.pos = null; await x.sm.tick(); const after1 = stops().length; await x.sm.tick(); B.pos = real;
    for (let i = 0; i < 4; i++) { await x.sm.tick(); await x.sm.auditStopLadder(20030); }
    info('F2', `stops after 1 wrong flat read ${after1}, after 2 ${stops().length}; position ${net()}x; later polls re-protect: ${stops().length > 0}`);
    ok(after1 === 1, 'F2a ONE wrong flat read while halted changes nothing');
    ok(stops().length === 1, 'F2b [EXPECTED TO FAIL = finding] TWO wrong flat reads while halted: the protective stop of a live 1x runner is still resting :: stops ' + stops().length + ', net ' + net()); }
  // F3 S1c: startup, saved LEG1 trade, the position read is wrongly flat: is the stop swept? how far apart are the two reads?
  { const sf = path.join(TMP, 'p2-sweep.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { stateFile: sf }); a.sm._stateArmed = true; a.sm.saveState();
    const keep = { orders: B.orders, nextId: B.nextId, real: B.pos }; const b = mkRaw(LiveStateMachine, { stateFile: sf }); Object.assign(B, { orders: keep.orders, nextId: keep.nextId, log: [], pos: null });
    const LO = require(path.join(TREE, 'lib/liveOrders.js')), orig = LO.getOpenPosition, times = []; LO.getOpenPosition = async (...a2) => { times.push(Date.now()); return orig(...a2); };
    const r = await b.sm.sweepSavedOrphans(); LO.getOpenPosition = orig; B.pos = keep.real;
    info('F3', `sweep ${JSON.stringify({ swept: r.swept, cancelled: (r.cancelled || []).map(o => o.kind + ' ' + o.size) })}; position really ${net()}x, stops now ${stops().length}`);
    const src = fs.readFileSync(path.join(TREE, 'lib/liveStateMachine.js'), 'utf8'), fn = src.slice(src.indexOf('async sweepSavedOrphans()'), src.indexOf('async earlyAdverseStep('));
    ok(/setTimeout|sessionConfirmMs|sleep/.test(fn), 'F3a [EXPECTED TO FAIL = finding] the startup sweep waits between its two flat reads (the session close waits sessionConfirmMs = 1 s before its confirming read); here they are back to back');
    ok(true, 'F3b (see info) with a wrong flat read at startup the saved stop and TP1 are cancelled'); }
  // F3c S1c really flat, a foreign order present: only the saved ids go
  { const sf = path.join(TMP, 'p2-sweep2.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { stateFile: sf }); a.sm._stateArmed = true; a.sm.saveState();
    B.orders.push({ id: 900, size: 1, limitPrice: 19900, type: 1, side: 0 }); const b = mkRaw(LiveStateMachine, { stateFile: sf }); B.pos = null; B.log = [];
    const r = await b.sm.sweepSavedOrphans();
    ok(r.swept && r.cancelled.length === 2 && r.notOurs === 1 && B.orders.length === 1 && B.orders[0].id === 900, 'F3c flat startup: the saved stop and TP1 are cancelled, the order the bot does not own is left :: ' + B.log.join(' | ')); }
  // F3d S1c position open: nothing
  { const sf = path.join(TMP, 'p2-sweep3.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { stateFile: sf }); a.sm._stateArmed = true; a.sm.saveState(); const b = mkRaw(LiveStateMachine, { stateFile: sf }); B.log = [];
    const r = await b.sm.sweepSavedOrphans(); ok(!r.swept && B.log.length === 0 && B.orders.length === 2, 'F3d position open at startup: the sweep cancels nothing (' + r.why + ')'); }
  // F3e S1c unreadable broker: nothing
  { const sf = path.join(TMP, 'p2-sweep4.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { stateFile: sf }); a.sm._stateArmed = true; a.sm.saveState(); const b = mkRaw(LiveStateMachine, { stateFile: sf }); B.pos = null; B.posFail = 1; B.log = [];
    const r = await b.sm.sweepSavedOrphans(); ok(!r.swept && B.log.length === 0 && B.orders.length === 2, 'F3e position unreadable at startup: nothing cancelled (' + r.why + ')'); }

  // F4 S2: expiry
  { const x = mkA(1); B.posFail = 3; await poll(x, m1L(1, -12), NOW); await poll(x, m1L(1, -12), NOW + 20000); B.posFail = 0; B.px = 20025;
    const r = await poll(x, [], NOW + 15 * 60000), r2 = await poll(x, [], NOW + 15 * 60000 + 20000);
    ok(r === 'expired' && r2 === null && markets() === 0 && B.orders.length === 2 && x.sm.eaeState.decided === 'abandoned' && !x.sm.sessionFlattenStarted, 'F4a decided, never sent, 15 min old: expired, no market order, stop and TP1 still resting'); 
    const s = await x.sm.sessionFlatten('13:05 PT session close', 'session'); await x.sm.tick();
    ok(s === 'sent' && x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0, 'F4b after the expiry the session close still flattens the trade normally'); }
  // F4c the exception: the stop is no longer tracked (cancelled inside a started exit, put-back failed): the exit is NOT expired, it goes on
  { const x = mkA(1); x.sm.eaeState = { decided: 'exit', at: NOW - 10 * 60000, pts: -11, mfe: 1, close: 19999, closeAt: NOW - 10 * 60000, reason: 'early exit: never worked', mode: 'exit' };
    x.sm.sessionFlattenStarted = true; x.sm.flattenKind = 'early-adverse'; x.sm.stopOrderId = null; B.orders = B.orders.filter(o => o.id !== 11);   // naked: the stop is gone
    const r = await x.sm.earlyAdverseStep(CFG, [], NOW); await x.sm.tick();
    ok(r === 'sent' && markets() === 1 && net() === 0, 'F4c exception: an old decision whose stop is no longer tracked is NOT expired - the exit goes out (the alternative is a position with no stop)'); }
  // F4d expiry after a started exit whose TP1 put-back failed: what protects / manages the trade afterwards?
  { const x = mkA(1); B.sticky.add(11); B.limitModes = ['reject']; const r0 = await poll(x, m1L(1, -12), NOW); B.sticky.clear();
    const mid = `${r0}: stops ${stops().length}, TP1 limits ${limits().length}, targetOrderId ${x.sm.targetOrderId}`;
    const r1 = await poll(x, [], NOW + 61000); for (let i = 0; i < 5; i++) { await x.sm.tick(); await x.sm.auditStopLadder(20005); }
    info('F4d', `${mid} -> ${r1}: stops ${stops().length}, TP1 limits ${limits().length} after 5 more polls, phase ${x.sm.phase}`);
    ok(stops().length === 1, 'F4d-1 the stop rests throughout');
    ok(limits().length === 1, 'F4d-2 [EXPECTED TO FAIL = finding] after the expiry the trade has its TP1 limit again :: limits ' + limits().length); }

  // F5 scorecard: a shape-valid file with garbage inside records never throws into the poll
  { const SC = require(path.join(TREE, 'lib/scorecard.js')), f = path.join(TMP, 'p2-score.json'); const rows = []; let threw = 0;
    const junk = [{ id: 'a', dir: 1, entry: 20000, open: true, tp1s: 'x', eaeShadow: 7, money: 'no' }, { id: 'b', dir: -1, entry: 1, open: false, closedAt: 'never', tp1s: { state: 'pending' }, eaeShadow: { state: 'pending' } }];
    fs.writeFileSync(f, JSON.stringify({ version: SC.VERSION, since: 1, updatedAt: 1, agg: SC.emptyAgg(), recs: junk }));
    const sc = SC.createScorecard({ file: f, journal: r => rows.push(r), log: () => {}, pointValue: 2, tp1AtrShadow: { mode: 'log', atrMult: 0.75, minPts: 15, maxPts: 60, beAfterPts: 15 }, eaeMode: () => 'exit' });
    for (const fn of [() => sc.load(), () => sc.onPoll({ now: Date.now(), price: 20000, bars: [{ t: 1 }], trade: { jid: 'j', dir: 1, entry: 20000, phase: 'LEG1_OPEN', stop: 19950, tp1: 20015, fillAt: Date.now() - 1000, atr15: 40 } }), () => sc.onPoll({ now: Date.now(), price: NaN, bars: null, trade: null }), () => sc.onBrokerTrades([{ journalId: 'j', netUsd: 5 }, null, 3]), () => sc.view(), () => sc.ruleOf('j', true), () => sc.indexJournal({ type: 'runner_rule', journalId: 'j', mode: 'atrTarget' })]) { try { fn(); } catch (e) { threw++; console.log('   threw: ' + e.message); } }
    ok(threw === 0, 'F5 scorecard: garbage inside a shape-valid state file - load, poll, broker trades, view, ruleOf, indexJournal never throw'); 
    for (const bad of ['', '{', 'null', '[]', '{"version":999}', JSON.stringify({ version: SC.VERSION, since: 'x', agg: {}, recs: [] })]) { fs.writeFileSync(f, bad); const s2 = SC.createScorecard({ file: f, journal: r => rows.push(r), log: () => {}, pointValue: 2, eaeMode: () => 'exit' }); let t = 0; try { s2.load(); s2.onPoll({ now: Date.now(), price: 1, bars: [], trade: null }); } catch (e) { t = 1; } if (t || !s2.view()) threw++; }
    ok(threw === 0 && rows.some(r => r.type === 'scorecard_state') && fs.readdirSync(TMP).some(n => /p2-score\.json\.corrupt-/.test(n)), 'F5b 6 corrupt files: a new scorecard each time, the old file kept as .corrupt-<time>, a scorecard_state row, no throw'); }

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(0);
})().catch(e => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
