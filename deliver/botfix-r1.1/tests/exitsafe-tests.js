'use strict';
// bf-exitsafe tests: node exitsafe-tests.js <tree> <tmpdir>. Real LiveStateMachine (sessionFlatten, noProgressStep, levelLossStep, tick, so1HaltLatch,
// restoreFromState) against a stateful fake broker (QA's qa-tests.js pattern, extended: order history, lost/ghost orders, lagging and unstable reads).
const path = require('path'), fs = require('fs');
const [TREE, TMP] = process.argv.slice(2).map(p => path.resolve(p));
fs.mkdirSync(TMP, { recursive: true });
const B = {};
function resetB(dir, size = 3) {
  Object.assign(B, { pos: { size, type: dir === 1 ? 1 : 2, averagePrice: dir === 1 ? 20010 : 19990 }, nextId: 100, log: [], marketMode: 'accept', modes: [], posLag: 0, lagPos: null, tpFillOnCancel: false,
    history: [], ghost: null, unstable: 0, posFail: 0, histFail: false, onMarket: null });
  B.orders = [{ id: 11, size, stopPrice: dir === 1 ? 19980 : 20020, type: 4 }, { id: 12, size: 1, limitPrice: dir === 1 ? 20025 : 19975, type: 1 }];
}
const net = () => B.pos ? (B.pos.type === 1 ? B.pos.size : -B.pos.size) : 0;
const setNet = n => { B.pos = n === 0 ? null : { size: Math.abs(n), type: n > 0 ? 1 : 2, averagePrice: 20000 }; };
const p = require.resolve(path.join(TREE, 'lib/liveOrders.js')), real = require(p), { OrderType, OrderSide } = real;
require.cache[p].exports = { ...real,
  getOpenPosition: async () => {
    if (B.posFail > 0) { B.posFail--; const e = new Error('read timeout'); e.positionUnreadable = true; throw e; }
    if (B.unstable > 0) { B.unstable--; return B.unstable % 2 ? { size: 3, type: 1, averagePrice: 20010 } : null; }
    if (B.posLag > 0) { B.posLag--; return B.lagPos ? { ...B.lagPos } : null; }
    return B.pos ? { ...B.pos } : null; },
  getOpenOrders: async () => B.orders.map(o => ({ ...o })),
  getEntryOrder: async () => null,
  searchOrdersSince: async () => { if (B.histFail) throw new Error('Order history unreadable'); return B.history.map(o => ({ ...o, contractId: 'C' })); },
  cancelOrder: async (t, a, id) => { B.log.push('cancel ' + id);
    if (id === 12 && B.tpFillOnCancel) { B.tpFillOnCancel = false; B.orders = B.orders.filter(o => o.id !== 12); setNet(net() - Math.sign(net())); B.log.push('TP1 FILLED during cancel'); return false; }
    const had = B.orders.some(o => o.id === id); B.orders = B.orders.filter(o => o.id !== id); return had; },
  placeOrder: async (t, o) => {
    if (o.type === OrderType.MARKET) {
      const signed = o.side === OrderSide.BUY ? o.size : -o.size, mode = B.modes.length ? B.modes.shift() : B.marketMode, id = B.nextId++;
      B.log.push(`MARKET ${o.side === OrderSide.BUY ? 'BUY' : 'SELL'} ${o.size} [${mode}]`);
      if (B.onMarket) B.onMarket();
      const hist = status => B.history.push({ id, type: 2, side: o.side, size: o.size, status, creationTimestamp: new Date().toISOString() });
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'reject') { hist(5); const e = new Error('Order/place failed: rejected'); e.orderRejected = true; throw e; }
      if (mode === 'timeout-accepted') { hist(2); setNet(net() + signed); throw new Error('fetch timeout'); }       // delivered and filled, reply lost
      if (mode === 'timeout-lost') throw new Error('fetch timeout');                                                 // never reached the broker
      if (mode === 'timeout-overfill') { hist(2); setNet(net() + 2 * signed); throw new Error('fetch timeout'); }   // the account ends on the OPPOSITE side
      if (mode === 'timeout-ghost') { B.ghost = signed; throw new Error('fetch timeout'); }                          // invisible now, fills later (B.ghostFill())
      hist(2); setNet(net() + signed); return { success: true, orderId: id };
    }
    const id = B.nextId++; B.orders.push({ id, size: o.size, stopPrice: o.stopPrice, limitPrice: o.limitPrice, type: o.type }); B.log.push(`REST ${o.type === OrderType.STOP ? 'STOP' : 'LIMIT'} ${o.size} @ ${o.stopPrice ?? o.limitPrice}`); return { success: true, orderId: id };
  } };
B.ghostFill = () => { setNet(net() + B.ghost); B.ghost = null; B.log.push('GHOST FILL'); };
const { LiveStateMachine } = require(path.join(TREE, 'lib/liveStateMachine.js'));
const safeExit = require(path.join(TREE, 'lib/safeExit.js'));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const M5 = 300000, T0 = Date.UTC(2026, 10, 3, 15, 0, 0), NOW = T0 + 11 * 60000;
const bar = (i, c) => ({ t: T0 + i * M5, o: c, h: c + 1, l: c - 1, c });
const lossL = [bar(0, 20004), bar(1, 19999.75), bar(2, 19999)];
const LV = { price: 20000, name: 'PDH', jid: 7 };
function mk(dir, extra = {}) {
  const journal = [], notif = [], logs = [];
  const sm = new LiveStateMachine({ token: 't', accountId: 1, contractId: 'C', pointValue: 2, tickSize: 0.25, log: m => logs.push(m), notify: (a, b) => notif.push(a + ' :: ' + b), journal: r => journal.push(r), ...extra });
  Object.assign(sm, { phase: 'LEG1_OPEN', dir, entryPrice: dir === 1 ? 20010 : 19990, contracts: 3, leg1Size: 1, leg2Size: 1, target1: dir === 1 ? 20025 : 19975, target2: dir === 1 ? 20050 : 19950,
    stopPriceIntended: dir === 1 ? 19980 : 20020, trailStop: dir === 1 ? 19980 : 20020, stopOrderId: 11, targetOrderId: 12, npFillAt: T0 + 60000, npCoveredTo: T0 + 120000, npBestPts: 3, npGap: false, sessionConfirmMs: 0, settleReadMs: 0, fillHandled: true });
  resetB(dir);
  const codes = () => journal.filter(r => r.type === 'trade_manage').map(r => r.code);
  return { sm, journal, notif, logs, codes };
}
const markets = () => B.log.filter(x => x.startsWith('MARKET')).length;
const rests = () => B.log.filter(x => x.startsWith('REST'));
const stopsResting = () => B.orders.filter(o => o.stopPrice != null);
const SC = 'session close at 13:05 PT', MH = 'morning hold 06:00-07:10 PT';
// the four exits through the real entry points
const EXITS = {
  session: async (x, t = NOW) => x.sm.sessionFlatten(SC),
  morning: async (x, t = NOW) => x.sm.sessionFlatten(MH),
  np1: async (x, t = NOW) => x.sm.noProgressStep({ enabled: true, mfePts: 15 }, t),
  exit5: async (x, t = NOW) => { if (!x.sm.lossLevel) x.sm.lossLevel = { ...LV }; return x.sm.levelLossStep(x.started ? null : lossL, t).finally(() => { x.started = true; }); },
};
function prep(kind, dir = 1) { const x = mk(dir); if (kind === 'np1') x.sm.npCoveredTo = NOW; return x; }
(async () => {
  // ---- 0. pure helpers
  { const seq = list => { let i = 0; return { readPos: async () => { const v = list[Math.min(i, list.length - 1)]; i++; if (v === 'ERR') throw new Error('x'); return v == null ? null : { size: Math.abs(v), type: v > 0 ? 1 : 2 }; }, readOrders: async () => [], sleep: async () => {} }; };
    ok((await safeExit.settle(seq([0, 0]), 1, 3, { readMs: 0 })).verdict === 'flat', 'U1 settle: two flat reads = flat');
    ok((await safeExit.settle(seq([3, 3, 3, 3, 3, 0, 0]), 1, 3, { readMs: 0 })).verdict === 'flat', 'U2 settle: 5 stale same reads then flat = flat (same needs 6)');
    ok((await safeExit.settle(seq([3]), 1, 3, { readMs: 0 })).verdict === 'same', 'U3 settle: 6 agreeing same reads, nothing working = same');
    ok((await safeExit.settle(seq([-3]), 1, 3, { readMs: 0 })).verdict === 'opposite' && (await safeExit.settle(seq([2]), 1, 3, { readMs: 0 })).verdict === 'mismatch', 'U4 settle: opposite / other size');
    ok((await safeExit.settle(seq(['ERR']), 1, 3, { readMs: 0 })).verdict === 'unsettled' && (await safeExit.settle(seq([3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0]), 1, 3, { readMs: 0 })).verdict === 'unsettled', 'U5 settle: unreadable / alternating = unsettled');
    const wk = { readPos: async () => ({ size: 3, type: 1 }), readOrders: async () => [{ id: 9 }], sleep: async () => {} };
    ok((await safeExit.settle(wk, 1, 3, { readMs: 0 })).verdict === 'unsettled', 'U6 settle: same position with a working order (our exit may be in flight) never = same');
    const now = Date.now();
    ok(safeExit.exitOrderSeen([], { side: 1, size: 3, since: now }) === 'none' && safeExit.exitOrderSeen([{ type: 2, side: 1, size: 3, status: 5, creationTimestamp: new Date(now).toISOString() }], { side: 1, size: 3, since: now }) === 'none'
      && safeExit.exitOrderSeen([{ type: 2, side: 1, size: 3, status: 2, creationTimestamp: new Date(now).toISOString() }], { side: 1, size: 3, since: now }) === 'seen'
      && safeExit.exitOrderSeen([{ type: 2, side: 1, size: 3, status: 2 }], { side: 1, size: 3, since: now }) === 'seen'
      && safeExit.exitOrderSeen([{ type: 2, side: 1, size: 3, status: 2, creationTimestamp: new Date(now - 600000).toISOString() }], { side: 1, size: 3, since: now }) === 'none', 'U7 exitOrderSeen: absent / rejected = none; filled = seen; undated = seen (conservative); old = none');
    ok(safeExit.EXIT_MAX_ATTEMPTS === 3 && safeExit.SETTLE_MAX_MS === 20000 && safeExit.backoffMs(1) === 0 && safeExit.backoffMs(2) === 10000, 'U8 N = 20 s, K = 3, backoff 0 s then 10 s'); }

  // ---- 1. lost reply then FLAT, every exit path
  for (const kind of Object.keys(EXITS)) {
    const x = prep(kind); B.marketMode = 'timeout-accepted';
    const r = await EXITS[kind](x);
    ok(r === 'sent' && net() === 0 && markets() === 1 && rests().length === 0 && x.sm.phase === 'FLATTENING' && x.codes().includes('EXIT_UNKNOWN_RESOLVED'), `1 ${kind}: lost reply then flat -> one market, no stop put back, FLATTENING :: ${B.log.join(' | ')}`);
    B.marketMode = 'accept'; await x.sm.tick(); await EXITS[kind](x, NOW + 20000);
    ok(x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && markets() === 1, `1 ${kind}: next poll confirms FLAT, nothing resting, no second order`);
  }
  // ---- 2. lost reply then STILL IN POSITION (never reached the broker), every path
  for (const kind of Object.keys(EXITS)) {
    const x = prep(kind); B.marketMode = 'timeout-lost';
    const r = await EXITS[kind](x);
    const st = stopsResting(), tp = B.orders.filter(o => o.limitPrice != null);
    ok(r === 'retry' && net() === 3 && markets() === 1 && st.length === 1 && st[0].size === 3 && st[0].stopPrice === 19980 && tp.length === 1 && tp[0].size === 1 && tp[0].limitPrice === 20025 && x.sm.exitAttempts === 1 && x.codes().includes('EXIT_UNKNOWN_NOT_FILLED'),
      `2 ${kind}: lost reply, still long 3 (history: no order) -> stop 3 @ 19980 + TP1 1 @ 20025 back, retry, 1 attempt used`);
    B.marketMode = 'accept'; const r2 = await EXITS[kind](x, NOW + 20000);
    ok(r2 === 'sent' && net() === 0 && markets() === 2, `2 ${kind}: the retry closes it (2 market orders in total, flat)`);
  }
  // ---- 3. lagging position reads
  { const x = prep('exit5'); B.marketMode = 'timeout-accepted'; B.onMarket = () => { B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 4; };
    const r = await EXITS.exit5(x);
    ok(r === 'sent' && net() === 0 && markets() === 1 && rests().length === 0, '3a lagging read (4 stale reads during the settle) -> settles flat, no stop back, one market'); }
  { const x = prep('exit5'); B.marketMode = 'timeout-accepted'; B.onMarket = () => { B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 40; };
    const r = await EXITS.exit5(x);
    ok(r === 'desynced' && x.sm.desynced && net() === 0 && markets() === 1 && rests().length === 0 && x.notif.some(n => /UNKNOWN/.test(n)) && /history/.test(x.sm._so1HaltWhy), '3b position read stale for > N (shows the old long): order history shows the exit filled -> HALT, no retry, no stop, loud alert :: ' + x.sm._so1HaltWhy);
    B.posLag = 0; const r2 = await EXITS.exit5(x, NOW + 20000); await x.sm.tick();
    ok(r2 === null && markets() === 1 && net() === 0, '3b halted machine sends nothing more'); }
  { const x = prep('session'); B.marketMode = 'timeout-lost'; B.histFail = true;
    const r = await EXITS.session(x);
    ok(r === 'desynced' && markets() === 1 && rests().length === 0 && net() === 3, '3c "same" but the order history is unreadable -> not proven -> HALT (no retry, nothing placed)'); }
  { const x = prep('exit5'); B.marketMode = 'timeout-accepted'; await EXITS.exit5(x); B.marketMode = 'accept'; B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 5;
    const r2 = await EXITS.exit5(x, NOW + 20000);
    ok(net() === 0 && markets() === 1, 'D5 (QA) timeout-accepted + lagging read on the next poll: no second market order, no flip'); }
  // ---- 4. explicit reject (S4) and wording (S3)
  const titles = { session: 'Session close: exit FAILED', morning: 'Morning-hold close: exit FAILED', np1: 'No-progress exit: exit FAILED', exit5: 'Level-loss exit: exit FAILED' };
  for (const kind of Object.keys(EXITS)) {
    const x = prep(kind); B.marketMode = 'reject';
    const r = await EXITS[kind](x);
    const st = stopsResting(), tp = B.orders.filter(o => o.limitPrice != null);
    ok(r === 'retry' && net() === 3 && st.length === 1 && st[0].size === 3 && st[0].stopPrice === 19980 && tp.length === 1 && tp[0].limitPrice === 20025 && !x.sm.desynced, `4 ${kind}: rejected -> stop AND TP1 put back at the same prices`);
    ok(x.notif.some(n => n.startsWith(titles[kind])) && !(kind !== 'session' && x.notif.some(n => n.startsWith('Session close'))), `4 ${kind}: alert names the exit ("${titles[kind]}")`);
  }
  // ---- 5. reject cap + backoff
  { const x = prep('exit5'); B.marketMode = 'reject';
    await EXITS.exit5(x); await EXITS.exit5(x, NOW + 20000);
    const m2 = markets(); const rb = await EXITS.exit5(x, NOW + 21000);
    ok(m2 === 2 && rb === 'retry' && markets() === 2 && stopsResting().length === 1, '5 backoff: after the 2nd rejection the next immediate poll sends nothing (stop still resting)');
    x.sm.exitRetryAt = 0;   // 10 s later
    const r3 = await EXITS.exit5(x, NOW + 40000);
    ok(r3 === 'desynced' && x.sm.desynced && markets() === 3 && stopsResting().length === 1 && stopsResting()[0].size === 3 && B.orders.some(o => o.limitPrice === 20025) && x.notif.some(n => /REJECTED 3x - FLATTEN IN TOPSTEPX/.test(n)), '5 cap K=3: the 3rd rejection -> stop + TP back, HALT, urgent alert');
    x.sm.exitRetryAt = 0; B.marketMode = 'accept'; await EXITS.exit5(x, NOW + 60000);
    ok(markets() === 3, '5 after the cap: nothing more is sent'); }
  // ---- 6. opposite position
  { const x = prep('session'); B.marketMode = 'timeout-overfill';
    const r = await EXITS.session(x);
    ok(r === 'desynced' && net() === -3 && markets() === 1 && rests().length === 0 && x.notif.some(n => /OPPOSITE/.test(n)), '6 lost reply then the OPPOSITE side -> HALT, nothing sent, alert names the opposite side'); }
  // ---- 7. reads that never settle
  { const x = prep('np1'); B.marketMode = 'timeout-accepted'; B.onMarket = () => { B.unstable = 1000; };
    const r = await EXITS.np1(x);
    ok(r === 'desynced' && markets() === 1 && rests().length === 0 && x.notif.some(n => /did not settle/.test(n)), '7 unstable reads -> HALT after N, nothing placed, alert'); B.unstable = 0; }
  { const x = prep('session'); B.marketMode = 'timeout-accepted'; B.onMarket = () => { B.posFail = 1000; };
    const r = await EXITS.session(x);
    ok(r === 'desynced' && markets() === 1 && rests().length === 0, '7b unreadable position for the whole window -> HALT, nothing placed'); B.posFail = 0; }
  { const x = prep('exit5'); B.marketMode = 'timeout-accepted'; B.onMarket = () => { B.lagPos = { size: 2, type: 1 }; B.posLag = 40; B.history = []; };
    const r = await EXITS.exit5(x);
    ok(r === 'desynced' && B.orders.some(o => o.stopPrice === 19980 && o.size === 2) && markets() === 1, '7c lost reply then same side OTHER size (2) -> stop 2x @ the stop level, HALT'); }
  // ---- 8. restart mid-UNKNOWN (state persisted before the send)
  const sf = path.join(TMP, 'trade-state.json');
  const restartCase = async (brokerAfter, kind = 'exit5') => {
    try { fs.unlinkSync(sf); } catch (_) {}
    const a = mk(1, { stateFile: sf }); a.sm._stateArmed = true; a.sm.lossLevel = { ...LV }; if (kind === 'np1') a.sm.npCoveredTo = NOW;
    let onDisk = null; B.marketMode = 'hang'; B.onMarket = () => { onDisk = JSON.parse(fs.readFileSync(sf, 'utf8')); };
    EXITS[kind](a);   // the process "dies" while the market order is in flight: the reply never comes, machine a never runs again
    for (let i = 0; i < 50 && !onDisk; i++) await new Promise(r => setImmediate(r));
    B.onMarket = null;
    const keep = { pos: B.pos, orders: B.orders, history: B.history }; const b = mk(1, { stateFile: sf }); Object.assign(B, keep); brokerAfter(); B.log = []; Object.assign(b.sm, { phase: 'FLAT', stopOrderId: null, targetOrderId: null, lossLevel: null, npFillAt: null });
    const latch = await b.sm.so1HaltLatch();
    return { a, b, onDisk, latch };
  };
  { const { onDisk, latch, b } = await restartCase(() => { setNet(0); B.history.push({ type: 2, side: 1, size: 3, status: 2, creationTimestamp: new Date().toISOString() }); });
    ok(onDisk && onDisk.exitInFlight && onDisk.exitInFlight.outcome === 'sending' && onDisk.exitInFlight.size === 3 && onDisk.exitAttempts === 1, '8 the in-flight exit is on disk BEFORE the market order goes out');
    const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    ok(latch.latched === false && latch.cleared && st.phase === 'FLAT' && !st.exitInFlight && !b.sm.desynced && B.log.filter(x => x.startsWith('MARKET') || x.startsWith('REST')).length === 0, '8a restart: broker flat -> exit confirmed, state FLAT, nothing sent'); }
  { const { latch, b } = await restartCase(() => {});
    const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    ok(latch.latched === false && !latch.cleared && !st.exitInFlight && st.exitAttempts === 1 && st.lossLevel && st.lossLevel.exitAt, '8b restart: broker still long 3, history shows no order -> marker cleared, trade kept (attempts 1, exit decision kept)');
    const rr = await b.sm.restoreFromState(B.pos);
    ok(rr.ok && b.sm.phase === 'LEG1_OPEN' && stopsResting().length === 1 && stopsResting()[0].size === 3 && B.orders.some(o => o.limitPrice === 20025) && b.sm.exitAttempts === 1, '8b ...restore re-places the stop and TP1, keeps the attempt count');
    B.marketMode = 'accept'; b.started = true; const r = await EXITS.exit5(b, NOW + 30000);
    ok(r === 'sent' && net() === 0 && B.log.filter(x => x.startsWith('MARKET')).length === 1, '8b ...the decided level-loss exit is then retried once and closes the trade'); }
  { const { latch, b } = await restartCase(() => { setNet(-3); });
    ok(latch.latched === true && b.sm.desynced && JSON.parse(fs.readFileSync(sf, 'utf8')).so1Halt && b.sm.notify && B.log.length === 0, '8c restart: broker OPPOSITE -> halt latched on disk, nothing sent'); }
  { const { latch } = await restartCase(() => { B.unstable = 1000; });
    ok(latch.latched === true && B.log.length === 0, '8d restart: reads never settle -> halt latched'); B.unstable = 0; }
  { const { latch } = await restartCase(() => { B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 40; setNet(0); B.history.push({ type: 2, side: 1, size: 3, status: 2, creationTimestamp: new Date().toISOString() }); });
    ok(latch.latched === true && B.log.length === 0, '8e restart: stale position read but history shows the exit filled -> halt (never a second exit)'); }
  { const { latch, b } = await restartCase(() => {}, 'np1');
    ok(latch.latched === false && !JSON.parse(fs.readFileSync(sf, 'utf8')).npState.sending && !b.sm.desynced, '8f np1: restart mid-UNKNOWN, still in position -> the old np1 "sending" halt is replaced by the settle rule (resumes)'); }
  // ---- 9. late fill after a retry (defence in depth)
  { const x = prep('session'); B.marketMode = 'timeout-ghost';
    const r = await EXITS.session(x);
    ok(r === 'retry' && stopsResting().length === 1, '9 ghost order (invisible, not in history): settles "same" -> stop back, retry');
    B.marketMode = 'accept'; await EXITS.session(x, NOW + 20000);
    ok(net() === 0 && x.sm.phase === 'FLATTENING', '9 retry sent and filled');
    B.ghostFill();
    ok(net() === -3, '9 the original exit fills late: account short 3');
    await x.sm.tick();
    ok(net() === 0 && x.sm.phase === 'FLAT' && B.log.some(l => l === 'MARKET BUY 3 [accept]') && x.notif.some(n => /REVERSED/.test(n)), '9 next tick: the reversal is closed at once (BUY 3) and alerted :: ' + B.log.join(' | ')); }
  // ---- 10. exit ordering (S2) and exit 5 on/off
  { const src = fs.readFileSync(path.join(TREE, 'live-executor.js'), 'utf8'), iNp = src.indexOf('await stateMachine.noProgressStep(CONFIG.noProgressExit'), iLl = src.indexOf('if (CONFIG.exitOnLevelLoss === true) { try { await levelLossStep(');
    ok(iNp > 0 && iLl > iNp, '10 executor: np1 runs before level-loss in the poll');
    const x = prep('np1'); x.sm.lossLevel = { ...LV };
    await x.sm.noProgressStep({ enabled: true, mfePts: 15 }, NOW); const rl = await x.sm.levelLossStep(lossL, NOW);
    ok(rl === null && x.sm.flattenKind === 'no-progress' && x.journal.filter(j => j.type === 'no_progress_exit').length === 1 && x.journal.filter(j => j.type === 'level_loss_exit').length === 0 && markets() === 1, '10 same poll, both would fire: np1 decides and labels the exit; level-loss stays out (no row, no second order)');
    const y = prep('exit5'); y.sm.lossLevel = null; B.marketMode = 'timeout-accepted'; y.sm.npCoveredTo = NOW;
    const rn = await y.sm.noProgressStep({ enabled: true, mfePts: 15 }, NOW);
    ok(rn === 'sent' && net() === 0 && markets() === 1 && !y.sm.desynced, '10 exit 5 off (no level): np1 alone, lost reply -> settles flat (previously: halt)'); }
  // ---- 11. TP not restored after a shrink; accepted-but-stuck alert; through-stop exit
  { const x = prep('session'); B.tpFillOnCancel = true; B.marketMode = 'reject';
    await EXITS.session(x);
    ok(net() === 2 && stopsResting().length === 1 && stopsResting()[0].size === 2 && !B.orders.some(o => o.limitPrice != null), '11 TP1 filled during the cancels, exit rejected: stop 2x back, TP NOT put back (it may have filled)'); }
  { const x = prep('session'); B.marketMode = 'accept'; B.onMarket = () => { B.posLag = 1000; B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; };
    await EXITS.session(x); x.sm.exitInFlight.at -= 61000; await x.sm.tick(); await x.sm.tick();
    ok(x.notif.filter(n => /still NOT FLAT/.test(n)).length === 1 && markets() === 1, '11 accepted exit still showing the position after 60 s: one urgent alert, no second order'); B.posLag = 0; }
  { const x = prep('session'); Object.assign(x.sm, { phase: 'PENDING_ENTRY', intendedEntryPrice: 20040, stopPriceIntended: 20020, fillHandled: true, targetOrderId: null }); B.orders = B.orders.filter(o => o.id === 11); B.marketMode = 'timeout-accepted';
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });
    ok(net() === 0 && x.sm.phase === 'FLATTENING' && rests().length === 0 && markets() === 1, '11 through-stop exit, lost reply then flat: no backup stop, FLATTENING'); }
  console.log(`\nexitsafe tests: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e.stack); process.exit(2); });
