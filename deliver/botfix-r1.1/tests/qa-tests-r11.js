'use strict';
// QA desk adversarial tests for exit 5 (independent of the builder's): node qa-tests-r11.js <tree> <base>
// botfix r1.1 copy: D1b, D2, D3 and F1 are REWRITTEN to assert the safe-exit behaviour (BF-EXITSAFE.md / BF-R11.md); every other test is unchanged.
const path = require('path'), fs = require('fs');
const [TREE, BASE] = process.argv.slice(2).map(p => path.resolve(p));
const exits5m = require(path.join(TREE, 'lib/exits5m.js'));
// stateful fake broker shared by both trees
const B = { pos: null, orders: [], nextId: 100, log: [], marketMode: 'accept', posLag: 0, lagPos: null, tpFillOnCancel: false };
function resetB(dir, size = 3) {
  Object.assign(B, { pos: { size, type: dir === 1 ? 1 : 2, averagePrice: dir === 1 ? 20010 : 19990 }, nextId: 100, log: [], marketMode: 'accept', posLag: 0, lagPos: null, tpFillOnCancel: false });
  B.orders = [{ id: 11, size, stopPrice: dir === 1 ? 19980 : 20020, type: 4 }, { id: 12, size: 1, limitPrice: dir === 1 ? 20025 : 19975, type: 1 }];
}
function net() { return B.pos ? (B.pos.type === 1 ? B.pos.size : -B.pos.size) : 0; }
function setNet(n) { B.pos = n === 0 ? null : { size: Math.abs(n), type: n > 0 ? 1 : 2, averagePrice: 20000 }; }
function stub(root) {
  const p = require.resolve(path.join(root, 'lib/liveOrders.js')); const real = require(p);
  const { OrderType, OrderSide } = real;
  require.cache[p].exports = { ...real,
    getOpenPosition: async () => { if (B.posLag > 0) { B.posLag--; return B.lagPos; } return B.pos ? { ...B.pos } : null; },
    getOpenOrders: async () => B.orders.map(o => ({ ...o })),
    getEntryOrder: async () => null,
    cancelOrder: async (t, a, id) => { B.log.push('cancel ' + id);
      if (id === 12 && B.tpFillOnCancel) { B.tpFillOnCancel = false; B.orders = B.orders.filter(o => o.id !== 12); setNet(net() - Math.sign(net())); B.log.push('TP1 FILLED during cancel'); return false; }
      const had = B.orders.some(o => o.id === id); B.orders = B.orders.filter(o => o.id !== id); return had; },
    placeOrder: async (t, o) => {
      if (o.type === OrderType.MARKET) {
        const signed = o.side === OrderSide.BUY ? o.size : -o.size;
        B.log.push(`MARKET ${o.side === OrderSide.BUY ? 'BUY' : 'SELL'} ${o.size} [${B.marketMode}]`);
        if (B.marketMode === 'reject') { const e = new Error('Order/place failed: rejected'); e.orderRejected = true; throw e; }
        if (B.marketMode === 'timeout-accepted') { setNet(net() + signed); const e = new Error('fetch timeout'); throw e; }   // delivered, reply lost
        if (B.marketMode === 'timeout-lost') { const e = new Error('fetch timeout'); throw e; }
        setNet(net() + signed); return { success: true, orderId: B.nextId++ };
      }
      const id = B.nextId++; B.orders.push({ id, size: o.size, stopPrice: o.stopPrice, limitPrice: o.limitPrice, type: o.type }); B.log.push(`REST ${o.type === OrderType.STOP ? 'STOP' : 'LIMIT'} ${o.size} @ ${o.stopPrice ?? o.limitPrice}`); return { success: true, orderId: id };
    } };
}
stub(TREE); stub(BASE);
const Cand = require(path.join(TREE, 'lib/liveStateMachine.js')).LiveStateMachine;
const Base = require(path.join(BASE, 'lib/liveStateMachine.js')).LiveStateMachine;
let pass = 0, fail = 0; const notes = [];
const ok = (c, name) => { if (c) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const finding = (name, txt) => { notes.push(name + ': ' + txt); console.log('FINDING ' + name + ': ' + txt); };
const M5 = 300000, T0 = Date.UTC(2026, 10, 3, 15, 0, 0);
const bar = (i, c, h, l) => ({ t: T0 + i * M5, o: c, h: h ?? c + 1, l: l ?? c - 1, c });
function mk(dir, Cls = Cand) {
  const journal = [], notif = [], logs = [];
  const sm = new Cls({ token: 't', accountId: 1, contractId: 'C', pointValue: 2, tickSize: 0.25, log: m => logs.push(m), notify: (a, b) => notif.push(a), journal: r => journal.push(r) });
  Object.assign(sm, { phase: 'LEG1_OPEN', dir, entryPrice: dir === 1 ? 20010 : 19990, contracts: 3, leg1Size: 1, leg2Size: 1, target1: dir === 1 ? 20025 : 19975, target2: dir === 1 ? 20050 : 19950,
    stopPriceIntended: dir === 1 ? 19980 : 20020, trailStop: dir === 1 ? 19980 : 20020, stopOrderId: 11, targetOrderId: 12, npFillAt: T0 + 60000, npCoveredTo: T0 + 120000, npBestPts: 3, npGap: false, sessionConfirmMs: 0, fillHandled: true });
  resetB(dir);
  return { sm, journal, notif, logs };
}
const LV = { price: 20000, name: 'PDH', jid: 7 };
const NOW = T0 + 11 * 60000;
const lossL = [bar(0, 20004), bar(1, 19999.75), bar(2, 19999)], lossS = [bar(0, 19995), bar(1, 20000.25), bar(2, 20001)];
const rows = j => j.filter(x => x.type === 'level_loss_exit').length;
(async () => {
  // ---- A. pure comparison
  ok(!exits5m.levelLost(1, 20000, 20000, 0.25) && !exits5m.levelLost(-1, 20000, 20000, 0.25), 'A1 close exactly AT the level: no (long, short)');
  ok(exits5m.levelLost(1, 20000, 19999.75, 0.25) && exits5m.levelLost(-1, 20000, 20000.25, 0.25), 'A2 exactly 1 tick through: yes (long below, short above)');
  ok(!exits5m.levelLost(1, 20000, 20000.25, 0.25) && !exits5m.levelLost(-1, 20000, 19999.75, 0.25) && !exits5m.levelLost(1, 20000, 25000, 0.25) && !exits5m.levelLost(-1, 20000, 15000, 0.25), 'A3 not inverted: a close on the trade side never fires');
  ok(!exits5m.levelLost(1, 20000.1, 20000, 0.25) && exits5m.levelLost(1, 20000.1, 19999.75, 0.25) && !exits5m.levelLost(-1, 19999.9, 20000, 0.25) && exits5m.levelLost(-1, 19999.9, 20000.25, 0.25), 'A4 off-tick level (VWAP-like): needs a full tick beyond the level');
  ok(exits5m.levelLost(1, 0.1 + 0.2, 0.3 - 0.25, 0.25) && exits5m.levelLost(1, 29874.3, 29874.3 - 0.25, 0.25), 'A5 float noise does not eat the 1-tick case');
  ok(!exits5m.levelLost(0, 20000, 1, 0.25) && !exits5m.levelLost(1, NaN, 1, 0.25) && !exits5m.levelLost(1, 20000, undefined, 0.25) && !exits5m.levelLost(1, 20000, 1, 0) && !exits5m.levelLost(1, null, 1, 0.25), 'A6 bad inputs never fire');
  // ---- B. bar completion
  { const cb = (bs, now) => exits5m.completedBars(bs, now).map(b => (b.t - T0) / M5);
    ok(JSON.stringify(cb([bar(0, 1), bar(1, 1)], T0 + M5)) === '[0]' && JSON.stringify(cb([bar(0, 1), bar(1, 1)], T0 + M5 - 1)) === '[]', 'B1 boundary: complete exactly at t+5m with a later bar; 1 ms earlier not');
    ok(JSON.stringify(cb([bar(0, 1)], T0 + 20 * M5)) === '[]', 'B2 the last bar in the read is never final, however old');
    ok(JSON.stringify(cb([bar(2, 1), bar(0, 1), bar(0, 99), bar(1, 1), null, { t: 'x' }, { t: T0 + 3 * M5, h: 1, l: 1, c: NaN }], NOW + M5)) === '[0,1]', 'B3 unsorted / duplicate / malformed rows');
    ok(JSON.stringify(cb([bar(0, 1), bar(3, 1)], T0 + 4 * M5)) === '[0]', 'B4 missing bars (gap) tolerated');
    ok(JSON.stringify(cb([{ ...bar(0, 1), t: new Date(T0).toISOString() }, { ...bar(1, 1), t: new Date(T0 + M5).toISOString() }], NOW)) === '[]', 'B5 ISO-string times are rejected (fail closed)');
    ok(JSON.stringify(cb(null, NOW)) === '[]' && JSON.stringify(cb([], NOW)) === '[]', 'B6 no read'); }
  // ---- C. machine decision with the REAL sessionFlatten
  { const { sm, journal } = mk(1); sm.lossLevel = { ...LV };
    const r = await sm.levelLossStep(lossL, NOW);
    ok(r === 'sent' && sm.phase === 'FLATTENING' && net() === 0 && B.orders.length === 0 && rows(journal) === 1, 'C1 long end to end: stop+TP cancelled, one market SELL 3, broker flat, 1 row :: ' + B.log.join(' | '));
    ok(B.log.filter(x => x.startsWith('MARKET')).length === 1 && B.log[B.log.length - 1].startsWith('MARKET SELL 3') && !B.log.some(x => x.startsWith('REST')), 'C1b no stop was moved or re-placed, cancels precede the market');
    const r2 = await sm.levelLossStep(lossL, NOW + 20000), r3 = await sm.levelLossStep(null, NOW + 40000);
    ok(r2 === 'sent' && r3 === 'sent' && B.log.filter(x => x.startsWith('MARKET')).length === 1 && rows(journal) === 1 && net() === 0, 'C2 double-fire: later polls send nothing more, still 1 row'); }
  { const { sm, journal } = mk(-1); sm.lossLevel = { ...LV };
    const r = await sm.levelLossStep(lossS, NOW);
    ok(r === 'sent' && net() === 0 && B.log.some(x => x.startsWith('MARKET BUY 3')) && rows(journal) === 1, 'C3 short, level above: close 1 tick above -> market BUY 3, flat'); }
  { const { sm, journal } = mk(-1); sm.lossLevel = { ...LV };
    const r = await sm.levelLossStep([bar(0, 19995), bar(1, 19990, 20030, 19985), bar(2, 20050)], NOW);
    ok(r === null && rows(journal) === 0 && B.log.length === 0, 'C4 short: wick 30 pts through + forming bar far through, close below: nothing'); }
  { const { sm } = mk(1); sm.lossLevel = { ...LV }; sm.npFillAt = T0 + M5 + 120000;   // filled inside bar 1 (15:07)
    const r = await sm.levelLossStep(lossL, NOW);
    ok(r === 'sent', 'C5 bar straddling the fill (opened before, closed after) DOES count');
    const x = mk(1); x.sm.lossLevel = { ...LV }; x.sm.npFillAt = T0 + 2 * M5;   // filled exactly when bar 1 ended
    ok(await x.sm.levelLossStep(lossL, NOW) === null && B.log.length === 0, 'C6 bar that completed exactly AT the fill time does not count');
    const y = mk(1); y.sm.lossLevel = { ...LV }; y.sm.npFillAt = T0 + 2 * M5 - 1;
    ok(await y.sm.levelLossStep(lossL, NOW) === 'sent', 'C6b ...1 ms before the bar end it counts'); }
  { const { sm, journal } = mk(1); sm.lossLevel = null;
    ok(await sm.levelLossStep(lossL, NOW) === null && B.log.length === 0 && rows(journal) === 0, 'C7 no level (no levelProof / adopted): never evaluated'); }
  { const { sm } = mk(1); sm.lossLevel = { ...LV }; sm.npFillAt = null; sm.pxBoundaryAt = null;
    ok(await sm.levelLossStep(lossL, NOW) === null && B.log.length === 0, 'C8 no fill time and no boundary: not evaluated'); }
  { // only the LAST completed bar: an earlier loss bar followed by a reclaim bar does not fire
    const { sm } = mk(1); sm.lossLevel = { ...LV };
    ok(await sm.levelLossStep([bar(0, 20004), bar(1, 19990), bar(2, 20006), bar(3, 20007)], NOW + M5) === null, 'C9 earlier loss bar then a reclaim close (missed poll): no late exit'); }
  // ---- D. close path failures
  { const { sm, journal, notif } = mk(1); sm.lossLevel = { ...LV }; B.marketMode = 'reject';
    const r = await sm.levelLossStep(lossL, NOW);
    const stops = B.orders.filter(o => o.stopPrice != null);
    ok(r === 'retry' && net() === 3 && stops.length === 1 && stops[0].size === 3 && stops[0].stopPrice === 19980 && sm.phase === 'LEG1_OPEN', 'D1 rejected market: stop put back 3x @ the SAME price, still long 3');
    { const tp = B.orders.filter(o => o.limitPrice != null);
      ok(tp.length === 1 && tp[0].size === 1 && tp[0].limitPrice === 20025 && sm.targetOrderId === tp[0].id, 'D1b (r1.1) the TP1 limit IS put back after a rejected exit: 1x @ the SAME price 20025, tracked'); }
    // D2 (r1.1): persistent rejection = K = 3 market sends with backoff, then HALT. Polls are 20 s apart, so the 10 s backoff after the 2nd rejection has
    // passed by the next poll: the test clears exitRetryAt to model that (the machine uses the real clock). One extra poll right after the 2nd rejection
    // (inside the backoff) must send nothing.
    const markets = () => B.log.filter(x => x.startsWith('MARKET')).length, rs = [];
    rs.push(await sm.levelLossStep(null, NOW + 20000));                                  // 2nd send (rejected): backoff 10 s
    const inBackoff = await sm.levelLossStep(null, NOW + 21000), mB = markets();          // inside the backoff: nothing sent
    for (let i = 2; i <= 4; i++) { sm.exitRetryAt = 0; rs.push(await sm.levelLossStep(null, NOW + i * 20000)); }
    const m = markets(), st = B.orders.filter(o => o.stopPrice != null), tp = B.orders.filter(o => o.limitPrice != null);
    ok(inBackoff === 'retry' && mB === 2 && m === 3 && rs[0] === 'retry' && rs[1] === 'desynced' && rs[2] === null && rs[3] === null && sm.desynced && sm.exitAttempts === 3
      && st.length === 1 && st[0].size === 3 && st[0].stopPrice === 19980 && tp.length === 1 && tp[0].limitPrice === 20025 && rows(journal) === 1
      && notif.filter(n => /FLATTEN IN TOPSTEPX NOW/.test(n)).length === 1 && journal.some(j => j.code === 'EXIT_HALT'),
      'D2 (r1.1) persistent rejection: nothing sent inside the backoff, at most K = 3 market sends, then HALT (1 urgent push, EXIT_HALT row); exactly one stop 3x @ 19980 + TP1 resting, 1 row :: ' + JSON.stringify({ rs, inBackoff, mB, m }));
    B.marketMode = 'accept'; const r6 = await sm.levelLossStep(null, NOW + 100000), r7 = await sm.sessionFlatten('session close at 13:05 PT');
    ok(r6 === null && r7 === 'desynced' && markets() === 3 && net() === 3 && B.orders.filter(o => o.stopPrice != null).length === 1, 'D3 (r1.1) after the cap HALT a broker that now accepts gets NO 4th order (level-loss or session close): still long 3, stop resting; Mac flattens in TopstepX');
    console.log('     notifications: ' + JSON.stringify(notif)); }
  { const { sm } = mk(1); sm.lossLevel = { ...LV }; B.marketMode = 'timeout-accepted';
    const r = await sm.levelLossStep(lossL, NOW);
    const st = B.orders.filter(o => o.stopPrice != null);
    console.log('     D4 trace: ' + B.log.join(' | ') + ' => r=' + r + ' net=' + net() + ' resting=' + JSON.stringify(B.orders));
    if (net() === 0 && st.length === 1) finding('D4', `market exit delivered but reply lost (timeout): machine treats it as rejected and RE-PLACES the stop ${st[0].size}x @ ${st[0].stopPrice} while the account is FLAT (naked stop until the next poll). np1 halts here instead.`);
    B.marketMode = 'accept'; const r2 = await sm.levelLossStep(null, NOW + 20000);
    console.log('     D4 next poll: r=' + r2 + ' phase=' + sm.phase + ' net=' + net() + ' resting=' + JSON.stringify(B.orders) + ' log+=' + B.log.slice(-4).join(' | '));
    ok(net() === 0, 'D4 flat-read next poll: no second market order (position stays flat)');
    if (B.orders.length) finding('D4b', 'after the next poll the re-placed stop is still resting while flat (waits for tick() sweep): ' + JSON.stringify(B.orders)); }
  { const { sm } = mk(1); sm.lossLevel = { ...LV }; B.marketMode = 'timeout-accepted';
    await sm.levelLossStep(lossL, NOW);
    B.marketMode = 'accept'; B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 5;   // the broker position read lags (still shows the 3 long)
    const r2 = await sm.levelLossStep(null, NOW + 20000);
    console.log('     D5 trace: ' + B.log.join(' | ') + ' => r=' + r2 + ' net=' + net());
    if (net() < 0) finding('D5', `timeout-accepted exit + a lagging position read on the next poll = a SECOND market order: account REVERSED to ${net()} (short ${-net()}) with ${B.orders.filter(o => o.stopPrice != null).length} stop(s) resting.`);
    ok(net() === 0, 'D5 no double close / flip when the first exit was delivered but the reply was lost and the position read lags'); }
  { const { sm, journal } = mk(1); sm.lossLevel = { ...LV }; B.tpFillOnCancel = true;
    const r = await sm.levelLossStep(lossL, NOW);
    console.log('     D6 trace: ' + B.log.join(' | ') + ' => r=' + r + ' net=' + net());
    ok(net() === 0 && B.log.some(x => x.startsWith('MARKET SELL 2')), 'D6 TP1 fills during the cancels: the remaining 2 are closed (not 3) - no flip'); }
  // ---- E. other exits
  { const { sm, journal } = mk(1); sm.lossLevel = { ...LV }; sm.npState = { decided: 'exit' };
    ok(await sm.levelLossStep(lossL, NOW) === null && B.log.length === 0, 'E1 np1 already decided its exit: level-loss stays out'); }
  { const { sm, journal } = mk(1); sm.lossLevel = { ...LV }; B.marketMode = 'reject';
    await sm.sessionFlatten('session close at 13:05 PT'); B.log.length = 0;
    ok(await sm.levelLossStep(lossL, NOW) === null && rows(journal) === 0 && B.log.length === 0, 'E2 session close / morning hold already flattening (retrying): level-loss stays out'); }
  { const { sm, journal } = mk(1); sm.lossLevel = { ...LV }; B.marketMode = 'reject';
    await sm.levelLossStep(lossL, NOW); B.marketMode = 'accept';
    const r = await sm.sessionFlatten('session close at 13:05 PT');
    ok(r === 'sent' && net() === 0 && sm.flattenKind === 'level-loss' && B.log.filter(x => /MARKET.*accept/.test(x)).length === 1, 'E3 13:05 close arriving while a level-loss exit retries: one exit, flat');
    ok(await sm.levelLossStep(null, NOW + 20000) === 'sent' && net() === 0, 'E3b and the pending level-loss step then sends nothing'); }
  { const { sm, journal } = mk(1); sm.lossLevel = { ...LV, exitAt: NOW, close5m: 19999.75, barT: T0 + M5 }; sm.phase = 'LEG23_OPEN';
    ok(await sm.levelLossStep(null, NOW + 1) === 'abandoned' && sm.lossLevel === null && B.log.length === 0, 'E4 TP1 beat a decided exit: abandoned, nothing sent'); }
  { const { sm } = mk(1); sm.lossLevel = { ...LV }; sm.desynced = true;
    ok(await sm.levelLossStep(lossL, NOW) === null && B.log.length === 0, 'E5 desynced machine: nothing'); }
  // ---- F. key false == base (machine level, real flatten paths, identical broker scripts)
  // r1.1: F1 = key off behaves as the base EXCEPT the documented exit-safety differences (BF-EXITSAFE.md, BF-R11.md):
  //   (a) the saved snapshot carries exitInFlight / exitAttempts (the exit intent on disk before the send; the K cap across restarts);
  //   (b) a REJECTED exit also puts TP1 back (one extra 'REST LIMIT' after the stop; it is cancelled again before the retry), so later order ids shift;
  //   (c) the rejection's SESSION_FLATTEN_RETRY journal row names the attempt count (text / fields differ; still exactly one row per rejection).
  // Everything else - the accepted flows, the no-progress flows, every other broker call in order, every other journal row - must be identical.
  { const run = async Cls => { const out = []; for (const mode of ['accept', 'reject']) for (const dir of [1, -1]) { const { sm, journal } = mk(dir, Cls); B.marketMode = mode;
        const r1 = await sm.sessionFlatten('session close at 13:05 PT'); sm.exitRetryAt = 0; const r2 = await sm.sessionFlatten('session close at 13:05 PT');
        const snap = sm.stateSnapshot(); delete snap.savedAt; out.push({ mode, dir, r: [r1, r2], log: B.log.slice(), orders: B.orders.map(o => ({ ...o })), net: net(), journal: journal.map(j => ({ ...j, t: 0 })), snap }); }
      for (const dir of [1, -1]) { const { sm, journal } = mk(dir, Cls); sm.npCoveredTo = NOW; const r = await sm.noProgressStep({ enabled: true, mfePts: 15 }, NOW); out.push({ mode: 'np', dir, r: [r], log: B.log.slice(), net: net(), journal: journal.map(j => ({ ...j, t: 0 })) }); }
      return out; };
    const J = x => JSON.stringify(x).replace(/\b1794\d{9}\b/g, '0');
    const norm = (c, isCand) => {
      const x = JSON.parse(J(c));
      if (x.snap) { delete x.snap.exitInFlight; delete x.snap.exitAttempts; }                                                   // (a)
      if (x.mode === 'reject') {
        const tp1 = x.dir === 1 ? 20025 : 19975;
        if (isCand) {                                                                                                           // (b)
          const tpIds = new Set(); let k = 100; const out = [];
          for (const l of x.log) { if (/^REST /.test(l)) { const id = String(k++); if (l === `REST LIMIT 1 @ ${tp1}`) { tpIds.add(id); continue; } out.push(l + ' #' + id); } else if (/^cancel /.test(l) && tpIds.has(l.slice(7))) continue; else out.push(l); }
          x.log = out; x.orders = x.orders.filter(o => !(o.limitPrice === tp1 && o.size === 1)); x.snap.targetOrderId = null;
        } else { let k = 100; x.log = x.log.map(l => /^REST /.test(l) ? l + ' #' + String(k++) : l); }
        const restIds = new Map(); x.log.forEach(l => { const m = l.match(/ #(\d+)$/); if (m) restIds.set(m[1], 'r' + restIds.size); });
        x.log = x.log.map(l => l.replace(/ #(\d+)$/, (_, id) => ' #' + restIds.get(id)).replace(/^cancel (\d+)$/, (_, id) => 'cancel ' + (restIds.get(id) || id)));
        x.orders = x.orders.map(o => ({ ...o, id: restIds.get(String(o.id)) || o.id })); x.snap.stopOrderId = restIds.get(String(x.snap.stopOrderId)) || x.snap.stopOrderId;
        x.retryRows = x.journal.filter(j => j.code === 'SESSION_FLATTEN_RETRY').length;                                          // (c)
        x.journal = x.journal.filter(j => j.code !== 'SESSION_FLATTEN_RETRY');
      }
      return x; };
    const a = await run(Cand), b = await run(Base);
    const na = a.map(x => J(norm(x, true))), nb = b.map(x => J(norm(x, false)));
    const docA = a.filter(x => x.snap).every(x => x.snap.exitAttempts >= 1), docB = a.filter(x => x.mode === 'reject').every(x => x.log.filter(l => l.startsWith('REST LIMIT 1 @')).length === 2);
    ok(a.length === 6 && na.every((x, i) => x === nb[i]) && docA && docB, 'F1 (r1.1) lossLevel never set (key false): session-close + no-progress flows identical to pkg-A47 except the documented exit-safety differences (a) snapshot exitInFlight/exitAttempts, (b) TP1 put back after a rejection, (c) the retry row wording');
    ok(na.slice(0, 2).every((x, i) => x === nb[i]) && J(a[4].log) === J(b[4].log) && J(a[5].journal) === J(b[5].journal) && J(a[0].journal) === J(b[0].journal), 'F1b (r1.1) accepted session close and no-progress: broker calls and journal byte-identical to pkg-A47');
    if (!na.every((x, i) => x === nb[i])) na.forEach((x, i) => { if (x !== nb[i]) { let k = 0; while (x[k] === nb[i][k]) k++; console.log('   case ' + i + ' first diff @' + k + '\n   cand: ' + x.slice(Math.max(0, k - 150), k + 150) + '\n   base: ' + nb[i].slice(Math.max(0, k - 150), k + 150)); } });
    const src = fs.readFileSync(path.join(TREE, 'live-executor.js'), 'utf8');
    const uses = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /levelLossStep\(|exitsLevelNote\(|exits5mRead\(|\.lossLevel/.test(l)).map(([n]) => n);
    console.log('     executor lines touching the feature: ' + uses.join(','));
    ok(/if \(CONFIG\.exitOnLevelLoss !== true \|\| journalId == null/.test(src) && /if \(CONFIG\.exitOnLevelLoss !== true \|\| !sm \|\|/.test(src) && /if \(CONFIG\.exitOnLevelLoss === true\) \{ try \{ await levelLossStep/.test(src), 'F2 every executor entry point is gated on the key'); }
  // ---- G. restore validation
  { const lsm = fs.readFileSync(path.join(TREE, 'lib/liveStateMachine.js'), 'utf8');
    const fn = new Function(lsm.match(/function lossLevelRestore\(o\) \{[\s\S]*?\n\}/)[0] + '; return lossLevelRestore;')();
    ok(fn(null) === null && fn({ price: 'x' }) === null && fn({ price: 1, exitAt: 'soon' }) === null && fn({ price: NaN }) === null && fn({ price: 5, name: 3 }).name === null && fn({ price: 5, exitAt: 9 }).exitAt === 9, 'G1 malformed saved level -> ignored (trade left alone)'); }
  // ---- H. is the unknown-outcome behaviour new, and how does np1 treat the same broker script?
  { const { sm } = mk(1, Base); B.marketMode = 'timeout-accepted';
    await sm.sessionFlatten('session close at 13:05 PT'); B.marketMode = 'accept'; B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 5;
    await sm.sessionFlatten('session close at 13:05 PT');
    console.log('     H1 pkg-A47 session close, same script: net=' + net() + ' :: ' + B.log.join(' | '));
    ok(net() === -3, 'H1 (context) the same flip exists TODAY in pkg-A47 for the 13:05 / morning-hold close: pre-existing path, not new code'); }
  { const { sm, notif } = mk(1); B.marketMode = 'timeout-accepted'; sm.npCoveredTo = NOW;
    const r = await sm.noProgressStep({ enabled: true, mfePts: 15 }, NOW); B.marketMode = 'accept'; B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 5;
    const r2 = await sm.noProgressStep({ enabled: true, mfePts: 15 }, NOW + 20000);
    console.log('     H2 np1, same script: r=' + r + ' r2=' + r2 + ' net=' + net() + ' halt=' + JSON.stringify(sm._so1HaltWhy || null).slice(0, 120) + ' :: ' + B.log.join(' | '));
    ok(net() === 0 && B.log.filter(x => x.startsWith('MARKET')).length === 1, 'H2 (context) np1 on the same script: halts, one market order, no flip'); }
  { const { sm, logs } = mk(1); sm.lossLevel = { ...LV }; B.marketMode = 'timeout-accepted';
    await sm.levelLossStep(lossL, NOW); B.marketMode = 'accept';
    let err = null; try { await sm.tick(); await sm.levelLossStep(null, NOW + 20000); await sm.tick(); } catch (e) { err = e.message; }
    console.log('     H3 after tick/step/tick: phase=' + sm.phase + ' net=' + net() + ' resting=' + JSON.stringify(B.orders) + (err ? ' ERR ' + err : '') + ' :: ' + B.log.slice(4).join(' | '));
    ok(sm.phase === 'FLAT' && B.orders.length === 0 && net() === 0, 'H3 flat read: the stray re-placed stop is swept within the following poll(s)'); }
  console.log(`\nQA tests: ${pass} passed, ${fail} failed; findings: ${notes.length}`); notes.forEach(n => console.log(' - ' + n));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e.stack); process.exit(2); });
