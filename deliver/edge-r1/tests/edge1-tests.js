'use strict';
// edge r1 tests: node edge1-tests.js <tree> <base-tree (r1.1)> <tmpdir>. Real LiveStateMachine (both trees) and real lib modules against ONE stateful fake broker
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

(async () => {
  // ---- A1 fires at -10 with MFE < 3
  { const x = mkA(1); const r = await poll(x, m1L(2.75, -10), NOW); const row = x.rows('early_adverse_exit')[0];
    ok(r === 'sent' && x.sm.phase === 'FLATTENING' && x.sm.flattenKind === 'early-adverse' && B.log.join('|') === 'cancel 12|cancel 11|MARKET SELL 3 [accept]' && net() === 0, 'A1a long, 1m close at -10.00 with best +2.75: verified cancels (TP1, stop) then ONE market SELL 3x through sessionFlatten :: ' + B.log.join(' | '));
    ok(row && row.decision === 'exit' && row.wouldExit === true && row.orderSent === true && row.fill === 20010 && row.close === 20000 && row.pts === -10 && row.mfe === 2.75 && row.mode === 'exit' && row.secAfterFill === 150 && row.stop === 19980 && row.tp1 === 20025 && row.dir === 1, 'A1b journal early_adverse_exit: fill, close, pts, mfe, mode, decision, the original stop and TP1 :: ' + JSON.stringify(row).slice(0, 260));
    ok(x.notif.some(n => /^Early exit: never worked, −10\.00 pts :: Closing LONG 3x at market/.test(n)) && x.codes().includes('EARLY_ADVERSE_EXIT') && x.sm.exitInFlight.kind === 'early-adverse' && x.sm._exitTitle() === 'Early adverse exit', 'A1c the alert names it ("Early exit: never worked, −10.00 pts"); exitInFlight kind early-adverse :: ' + x.notif[0]);
    await x.sm.tick(); const out = x.rows('early_adverse_outcome')[0];
    ok(x.sm.phase === 'FLAT' && x.notif.some(n => /^Early exit: flat/.test(n)) && x.codes().includes('EARLY_ADVERSE_FLAT_CONFIRMED') && x.sm.eaeState === null && x.sm.flattenKind === null, 'A1d tick confirms flat: "Early exit: flat", machine reset');
    ok(out && out.decision === 'exit' && out.exited === true && out.endedBy === 'early-adverse' && out.shadow && out.shadow.stop === 19980 && out.shadow.tp1 === 20025 && out.shadow.stopPts === 30 && out.shadow.tp1Pts === 15 && out.closeAt === T0 + 180000 && /walk the bars/.test(out.shadow.note), 'A1e exit mode: early_adverse_outcome carries the shadow (original stop 19980 / TP1 20025, closeAt) for the scorecard'); }
  { const x = mkA(-1); const r = await poll(x, m1S(1, -12.5), NOW);
    ok(r === 'sent' && B.log[2] === 'MARKET BUY 3 [accept]' && net() === 0 && x.rows('early_adverse_exit')[0].pts === -12.5 && x.notif.some(n => /^Early exit: never worked, −12\.50 pts/.test(n)), 'A1f short, close 12.5 pts against with best +1: market BUY 3x; alert "−12.50 pts"'); }
  // ---- A2 / A3 does not fire
  { const x = mkA(1); const r = await poll(x, m1L(0, -9.75), NOW); const c = x.rows('early_adverse_check')[0];
    ok(r === 'keep' && B.log.length === 0 && x.sm.phase === 'LEG1_OPEN' && x.rows('early_adverse_exit').length === 0 && c && c.decision === 'keep' && c.pts === -9.75 && stops().length === 1 && limits().length === 1, 'A2 close at -9.75 (best 0): NOT fired, nothing sent, stop and TP1 untouched; early_adverse_check keep'); }
  { const x = mkA(1); const r = await poll(x, m1L(3, -10), NOW);
    ok(r === 'keep' && B.log.length === 0 && x.rows('early_adverse_check')[0].mfe === 3 && /seen at \+3\.00/.test(x.rows('early_adverse_check')[0].why), 'A3a close at -10 but the trade was seen at +3.00: NOT fired (MFE 3 is not below 3)'); }
  { const x = mkA(1); const r = await poll(x, m1L(2.75, -25), NOW);
    ok(r === 'sent' && markets() === 1, 'A3b close at -25 with best +2.75: fired'); }
  { const x = mkA(-1); const r = await poll(x, m1S(3.25, -15), NOW);
    ok(r === 'keep' && B.log.length === 0, 'A3c short seen at +3.25 then -15: NOT fired'); }
  // ---- A4 once only
  { const x = mkA(1); const r1 = await poll(x, m1L(0, -9.75), NOW);
    const later = [bar(2, 20000, 19995, 20000.25), bar(3, 20000, 19980, 19985), bar(4, 19985, 19984, 19985)];
    const r2 = await poll(x, later, NOW + 60000), r3 = await poll(x, later, NOW + 80000);
    ok(r1 === 'keep' && r2 === null && r3 === null && B.log.length === 0 && x.rows('early_adverse_check').length === 1, 'A4a decided once: after "keep", a later 1m close at -25 is NOT evaluated (the stop and np1 own it from here)'); }
  { const x = mkA(1); const rs = [await poll(x, m1L(0, -11), NOW), await poll(x, m1L(0, -11), NOW + 20000), await poll(x, m1L(0, -11), NOW + 40000)];
    ok(JSON.stringify(rs) === '["sent","sent","sent"]' && markets() === 1 && x.rows('early_adverse_exit').length === 1 && x.notif.filter(n => /^Early exit: never worked/.test(n)).length === 1, 'A4b exit decided once: repeated polls while FLATTENING send no second order, one row, one alert'); }
  // ---- A5 log mode
  { const x = mkA(1); const r = await poll(x, m1L(1, -10.5), NOW, LOG); const row = x.rows('early_adverse_exit')[0];
    ok(r === 'log' && B.log.length === 0 && B.cancels === 0 && x.sm.phase === 'LEG1_OPEN' && !x.sm.sessionFlattenStarted && row && row.wouldExit === true && row.orderSent === false && row.decision === 'log' && row.mode === 'log' && row.pts === -10.5 && row.mfe === 1 && x.notif.length === 0, 'A5a log mode: the same row with wouldExit true, NO order, no cancel, no alert; the trade runs on');
    const r2 = await poll(x, m1L(1, -10.5), NOW + 20000, LOG);
    fill(11); await x.sm.tick(); const out = x.rows('early_adverse_outcome')[0];
    ok(r2 === null && x.sm.phase === 'FLAT' && out && out.decision === 'log' && out.wouldExit === true && out.exited === false && out.endedBy === 'full-stop' && out.tp1Reached === false && out.shadow.stop === 19980, 'A5b log mode outcome: the trade then took its full stop -> early_adverse_outcome { decision log, wouldExit, endedBy full-stop } :: ' + JSON.stringify(out).slice(0, 200)); }
  { const x = mkA(1); await poll(x, m1L(1, -10.5), NOW, LOG); fill(12); await x.sm.tick(); const ph = x.sm.phase; fill(B.orders.find(o => o.stopPrice != null).id); await x.sm.tick(); const out = x.rows('early_adverse_outcome')[0];
    ok(ph === 'LEG23_OPEN' && x.sm.phase === 'FLAT' && out && out.decision === 'log' && out.tp1Reached === true && out.endedBy === 'after-tp1', 'A5c log mode outcome: a would-exit trade that went on to TP1 is recorded as tp1Reached (the winner the rule would have killed)'); }
  // ---- A6 timing / poll gap
  { const x = mkA(1); const r = await poll(x, [bar(0, 20011, 20009, 20010), bar(1, 20011, 19998, 19999), bar(2, 19999, 19990, 19991)], T0 + 170000);
    ok(r === null && x.sm.eaeState === null && B.log.length === 0, 'A6a before the first 1m close 120 s+ after the fill (T0+170 s): nothing decided, nothing sent (a -19 forming bar is not a close)'); }
  { const x = mkA(1); const r = await poll(x, m1L(0, -10), T0 + 180000 + 40000);
    ok(r === 'sent' && x.rows('early_adverse_exit')[0].decidedLateMs === 40000, 'A6b the close is first seen 40 s late (one missed poll): still evaluated on that close (inside the 45 s grace)'); }
  { const x = mkA(1); const r = await poll(x, m1L(0, -10), T0 + 180000 + 50000); const c = x.rows('early_adverse_check')[0];
    const r2 = await poll(x, m1L(0, -10), T0 + 180000 + 70000);
    ok(r === 'unassessed' && r2 === null && B.log.length === 0 && c && c.decision === 'unassessed' && /late/.test(c.why) && x.codes().includes('EARLY_ADVERSE_UNASSESSED') && x.sm.phase === 'LEG1_OPEN', 'A6c the close is first seen 50 s late (poll gap): UNASSESSED, journaled, no order, never a late exit :: ' + c.why); }
  { const x = mkA(1); const r1 = await poll(x, [bar(3, 20000, 19999, 20000)], T0 + 185000), r2 = await poll(x, [bar(4, 20000, 19999, 20000)], T0 + 250000); const c = x.rows('early_adverse_check')[0];
    ok(r1 === null && r2 === 'unassessed' && B.log.length === 0 && /poll gap/.test(c.why), 'A6d the 1m close never arrives in the bars (feed gap): waits inside the grace, then UNASSESSED :: ' + c.why); }
  { const x = mkA(1); const r = await poll(x, [bar(2, 20008, 19999, 20000), bar(3, 20000, 19999, 20000)], NOW); const c = x.rows('early_adverse_check')[0];
    ok(r === 'unassessed' && B.log.length === 0 && /best price is not known/.test(c.why) && x.sm.npGap === true, 'A6e a 1m bar between the fill and the close was never seen (np1 tracker gapped): MFE unknown -> UNASSESSED, no order'); }
  { const x = mkA(1); x.sm.npFillAt = null; const r = await poll(x, m1L(0, -10), NOW);
    ok(r === 'unassessed' && B.log.length === 0 && /fill time is not known/.test(x.rows('early_adverse_check')[0].why), 'A6f adopted / restored position without a fill time: UNASSESSED, left alone'); }
  { const c = { ...CFG }, f = T0;   // a fill exactly on the minute: closes at +120 s and +180 s are both inside the window
    const a = EE.eaeCloseBar([bar(1, 1, 1, 5), bar(2, 1, 1, 6)], f, T0 + 121000, c), b = EE.eaeCloseBar([bar(1, 1, 1, 5), bar(2, 1, 1, 6), bar(3, 1, 1, 7)], f, T0 + 181000, c), d = EE.eaeCloseBar([bar(2, 1, 1, 6), bar(3, 1, 1, 7)], f, T0 + 226000, c), e = EE.eaeCloseBar([bar(3, 1, 1, 8)], FILL, T0 + 245000, c);
    ok(a.bar && a.closeAt === T0 + 120000 && b.bar && b.closeAt === T0 + 180000 && b.bar.c === 6 && d.missed === true && e.missed === true, 'A6g pure: first close used when seen; if it is missed, the NEXT close is used only when it is within 180 s of the fill; a close 181+ s after the fill is never used'); }
  // ---- A7 one decision owner: np1 / level-loss ordering
  { const x = mkA(1); B.modes = ['reject']; const r1 = await poll(x, m1L(0, -11), NOW);
    const st = stops().length, tp = limits().length, ph = x.sm.phase;
    const npAt = Math.floor(FILL / 300000) * 300000 + 600000;
    x.sm.npCoveredTo = npAt; const rNp = await x.sm.noProgressStep({ enabled: true, mfePts: 15 }, npAt + 5000);
    x.sm.lossLevel = { price: 20009, name: 'PDH', jid: 1 }; const rLl = await x.sm.levelLossStep([{ t: T0, o: 20010, h: 20011, l: 19990, c: 19995 }, { t: T0 + 300000, o: 19995, h: 19996, l: 19990, c: 19992 }], T0 + 600000 + 5000);
    ok(r1 === 'retry' && ph === 'LEG1_OPEN' && st === 1 && tp === 1 && rNp === null && x.sm.npState === null && rLl === null && !Number.isFinite(x.sm.lossLevel.exitAt) && markets() === 1 && x.sm.flattenKind === 'early-adverse', 'A7a early exit rejected once (stop + TP1 put back): np1 at its 5m check and level-loss on a lost level BOTH stand down - the early exit owns the trade');
    const r2 = await x.sm.earlyAdverseStep(CFG, [], npAt + 6000);
    ok(r2 === 'sent' && markets() === 2 && net() === 0 && !x.rows('no_progress_exit').length && !x.rows('level_loss_exit').length && !x.notif.some(n => /No-progress|Level lost/.test(n)), 'A7b its own driver retries and closes it: 2 sends in total, no np1 / level-loss row or alert'); }
  { const x = mkA(1); x.sm.npState = { decided: 'exit', at: NOW, checkAt: 1 }; const r = await poll(x, m1L(0, -11), NOW);
    ok(r === null && x.sm.eaeState === null && B.log.length === 0, 'A7c np1 already decided to exit: the early exit decides nothing'); }
  { const x = mkA(1); x.sm.lossLevel = { price: 20009, exitAt: NOW - 1000, close5m: 20000 }; const r = await poll(x, m1L(0, -11), NOW);
    ok(r === null && x.sm.eaeState === null && B.log.length === 0, 'A7d level-loss already decided: the early exit decides nothing'); }
  { const x = mkA(1); await x.sm.sessionFlatten('session close', 'session'); const m = markets(); const r = await poll(x, m1L(0, -11), NOW);
    ok(m === 1 && r === null && markets() === 1 && x.sm.flattenKind === null, 'A7e a session close under way: the early exit decides nothing, no second order'); }
  { const x = mkA(1); B.sticky.add(11); const r1 = await poll(x, m1L(0, -11), NOW); B.sticky.clear();
    const r2 = await x.sm.sessionFlatten('session close', 'session');
    ok(r1 === 'retry' && r2 === 'sent' && markets() === 1 && net() === 0 && x.sm._exitTag() === 'early-adverse', 'A7f the session close arriving while the early exit is retrying drives the SAME exit (one market order, label kept)'); }
  { const iE = SRC.indexOf('stateMachine.earlyAdverseStep(CONFIG.earlyAdverseExit, m1'), iN = SRC.indexOf('await stateMachine.noProgressStep(CONFIG.noProgressExit'), iL = SRC.indexOf('await levelLossStep(Date.now())'), iT = SRC.indexOf('stateMachine.noteNoProgressPrices(m1, liveBar.c');
    ok(iT > 0 && iT < iE && iE < iN && iN < iL && /if \(CONFIG\.earlyAdverseExit\.mode !== 'off'\) \{ try \{ await stateMachine\.earlyAdverseStep/.test(SRC), 'A7g executor poll order: np1 tracker -> early adverse step -> np1 step -> level-loss step; the early step is not called at all in mode off'); }
  { const x = mkA(1); B.sticky.add(12); const r1 = await poll(x, m1L(0, -11), NOW); B.sticky.clear(); fill(12); await x.sm.tick(); const r2 = await x.sm.earlyAdverseStep(CFG, [], NOW + 20000), r3 = await x.sm.earlyAdverseStep(CFG, [], NOW + 40000);
    ok(r1 === 'retry' && x.sm.phase === 'LEG23_OPEN' && r2 === 'abandoned' && r3 === null && markets() === 0 && x.codes().includes('EARLY_ADVERSE_ABANDONED') && net() === 1, 'A7h TP1 filled before the exit could go out: ABANDONED, no market order, the runner is managed as normal'); }
  // ---- A8 lost reply -> the safe-exit settle
  { const x = mkA(1); B.marketMode = 'timeout-accepted'; const r = await poll(x, m1L(0, -11), NOW);
    ok(r === 'sent' && markets() === 1 && net() === 0 && B.orders.length === 0 && !x.sm.desynced && x.codes().includes('EXIT_UNKNOWN_RESOLVED'), 'A8a lost reply, the exit DID fill: settled flat, nothing re-placed, no second order'); }
  { const x = mkA(1); B.marketMode = 'timeout-lost'; const r = await poll(x, m1L(0, -11), NOW);
    ok(r === 'retry' && markets() === 1 && net() === 3 && stops().length === 1 && stops()[0].stopPrice === 19980 && stops()[0].size === 3 && limits().length === 1 && limits()[0].limitPrice === 20025 && x.sm.exitAttempts === 1 && x.sm.phase === 'LEG1_OPEN', 'A8b lost reply, NOT filled (position, orders, history agree): ONE order only while unknown; stop 3x @ 19980 and TP1 back; 1 of 3 attempts used');
    B.marketMode = 'accept'; const r2 = await x.sm.earlyAdverseStep(CFG, [], NOW + 20000);
    ok(r2 === 'sent' && markets() === 2 && net() === 0, 'A8c the next poll retries: second send accepted, flat'); }
  { const x = mkA(1); B.marketMode = 'reject'; const rs = [await poll(x, m1L(0, -11), NOW)];
    rs.push(await x.sm.earlyAdverseStep(CFG, [], NOW + 20000)); x.sm.exitRetryAt = 0; rs.push(await x.sm.earlyAdverseStep(CFG, [], NOW + 40000)); B.marketMode = 'accept'; rs.push(await x.sm.earlyAdverseStep(CFG, [], NOW + 60000));
    ok(JSON.stringify(rs) === '["retry","retry","desynced",null]' && markets() === 3 && net() === 3 && stops().length === 1 && limits().length === 1 && x.sm.desynced && x.notif.some(n => /Early adverse exit: exit REJECTED 3x - FLATTEN IN TOPSTEPX NOW/.test(n)), 'A8d rejected 3x: K = 3 sends then HALT (named "Early adverse exit"), stop + TP1 resting, no 4th order :: ' + JSON.stringify(rs)); }
  // ---- A9 restart mid-rule
  { const sf = path.join(TMP, 'eae-state.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = mkA(1, { stateFile: sf }); a.sm._stateArmed = true;
    let disk = null; B.marketMode = 'hang'; B.onMarket = () => { disk = JSON.parse(fs.readFileSync(sf, 'utf8')); };
    poll(a, m1L(0, -11), NOW);
    for (let i = 0; i < 80 && !disk; i++) await new Promise(r => setImmediate(r));
    B.onMarket = null;
    ok(disk && disk.eaeState && disk.eaeState.decided === 'exit' && disk.eaeState.pts === -11 && disk.flattenKind === 'early-adverse' && disk.exitInFlight && disk.exitInFlight.kind === 'early-adverse' && disk.exitInFlight.outcome === 'sending' && disk.exitAttempts === 1, 'A9a the decision AND the exit intent are on disk BEFORE the market order goes out');
    const keep = { pos: B.pos, orders: B.orders, history: [] }; const b = mkRaw(LiveStateMachine, { stateFile: sf }); Object.assign(B, keep, { log: [], marketMode: 'accept' });
    const latch = await b.sm.so1HaltLatch(), rr = await b.sm.restoreFromState(B.pos);
    ok(latch.latched === false && rr.ok && b.sm.flattenKind === 'early-adverse' && b.sm.eaeState && b.sm.eaeState.decided === 'exit' && b.sm.exitAttempts === 1 && stops().length === 1 && stops()[0].stopPrice === 19980 && markets() === 0, 'A9b restart, the broker still LONG 3 with no order in the history: nothing sent at startup, the trade is restored with its stop, the early-exit decision and label kept');
    const r3 = await b.sm.earlyAdverseStep(CFG, [], Date.now());
    ok(r3 === 'sent' && markets() === 1 && net() === 0, 'A9c the driver finishes the early exit after the restart (attempt 2 of 3)'); }
  { const sf = path.join(TMP, 'eae-state2.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = mkA(1, { stateFile: sf }); a.sm._stateArmed = true; a.sm.saveState();
    const keep = { pos: B.pos, orders: B.orders }; const b = mkRaw(LiveStateMachine, { stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos); const r = await poll(b, m1L(0, -11), NOW);
    ok(rr.ok && b.sm.npFillAt === FILL && r === 'sent' && net() === 0, 'A9d restart BEFORE the check: the fill time survives, the rule is evaluated at its 1m close as normal'); }
  { const sf = path.join(TMP, 'eae-state3.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = mkA(1, { stateFile: sf }); a.sm._stateArmed = true; await poll(a, m1L(0, -5), NOW); a.sm.saveState();
    const keep = { pos: B.pos, orders: B.orders }; const b = mkRaw(LiveStateMachine, { stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos); const r = await poll(b, m1L(0, -20), NOW + 20000);
    ok(rr.ok && b.sm.eaeState && b.sm.eaeState.decided === 'keep' && r === null && B.log.length === 0, 'A9e restart AFTER a "keep": the decision survives, the rule is not evaluated a second time'); }
  // ---- A10 off = nothing
  { const x = mkA(1); const r = await poll(x, m1L(0, -11), NOW, { ...CFG, mode: 'off' }); fill(11); await x.sm.tick();
    ok(r === null && x.sm.eaeState === null && !x.journal.some(j => /^early_adverse/.test(j.type)) && !('eaeState' in x.sm.stateSnapshot()) && !('runnerPlan' in x.sm.stateSnapshot()), 'A10 mode off: no decision, no row (not even an outcome row), nothing in the saved state'); }
  // ---- A11 config: enums, fail-closed validation, startup line
  { const v = EE.validateEae;
    ok(v(CFG).length === 0 && v({ ...CFG, mode: 'on' }).length === 1 && v({ ...CFG, lossPts: 0 }).length === 1 && v({ ...CFG, afterSec: '120' }).length === 1 && v({ ...CFG, minSeenPts: -1 }).length === 1 && v(null).length === 1, 'A11a validateEae: bad mode / lossPts / afterSec / minSeenPts / missing object are all refused');
    ok(/'earlyAdverseExit\.mode': edgeExits\.EAE_MODES/.test(SRC) && /earlyAdverseExit: \{ mode: 'exit', afterSec: 120, lossPts: 10, minSeenPts: 3 \}/.test(SRC) && /throw new Error\(`earlyAdverseExit is unusable/.test(SRC) && SRC.indexOf('log(edgeExits.eaeLine(CONFIG.earlyAdverseExit))') > 0, 'A11b executor: shipped { mode exit, 120, 10, 3 }, strict-loader enum on earlyAdverseExit.mode, startup throws on a bad value, prints the [eae] line');
    ok(/^\[eae\] early adverse exit: ON \(/.test(EE.eaeLine(CFG)) && /^\[eae\] early adverse exit: LOG \(/.test(EE.eaeLine(LOG)) && EE.eaeLine({ ...CFG, mode: 'off' }) === '[eae] early adverse exit: off', 'A11c startup line: ON (...) / LOG (...) / off :: ' + EE.eaeLine(CFG)); }
  { PS.indexJournal ? null : null; ok(/case 'EARLY_ADVERSE_EXIT': forced = \{ exitReason: 'EARLY_EXIT'/.test(fs.readFileSync(path.join(TREE, 'lib/phoneSnapshot.js'), 'utf8')), 'A11d phone snapshot: an early exit is reported as exitReason EARLY_EXIT (not UNKNOWN)'); }

  // ---------- B. session runner rule: real openEntry -> fill -> protection, 3 contracts, TP1 +15, stop 50 ----------
  const planFn = (mode, o = {}) => () => ({ session: o.session || 'ny', mode, stopPts: 2, tp2AtrMult: 2, atr15: 'atr15' in o ? o.atr15 : 40, why: o.why || null });
  async function enter(Cls, dir, extra = {}, o = {}) {
    const x = mkRaw(Cls, extra); resetB(); B.px = o.fillPx ?? 20000;
    const n = o.n ?? 3, e = 20000;
    // the state openEntry leaves after the broker acknowledged a MARKET entry (its admission gates - alignment receipts, control - are not under test here); the
    // fill itself is handled by the real tick(): slip guard, TP1 from the fill, stop floor, the runner plan, protection
    Object.assign(x.sm, { phase: 'PENDING_ENTRY', dir, stopPriceIntended: e - dir * 50, target1: e + dir * 15, target2: e + dir * 40, tightStopPrice: null, smartHoldChecked: false, intendedEntryPrice: e, source: 'levels', grade: 'A', contracts: n,
      leg1Size: Math.max(1, n - 1), leg2Size: 0, entrySignalTime: Date.now(), entryType: 'MARKET', fillHandled: false, throughStop: false, signalContext: null, sessionExit: null, entryOrderId: 90 });
    B.log.push(`MARKET ${dir === 1 ? 'BUY' : 'SELL'} ${n} (entry)`); setNet(dir * n, B.px);
    await x.sm.tick();
    return x;
  }
  const tpId = () => (limits()[0] || {}).id, stopId = () => (stops()[0] || {}).id;
  // ---- B1 allAtTp1
  { const x = await enter(LiveStateMachine, 1, { sessionRunnerFn: planFn('allAtTp1', { session: 'asia' }) }); const rr = x.rows('runner_rule')[0];
    ok(x.sm.phase === 'LEG1_OPEN' && limits().length === 1 && limits()[0].size === 3 && limits()[0].limitPrice === 20015 && stops().length === 1 && stops()[0].size === 3 && stops()[0].stopPrice === 19950 && x.sm.leg1Size === 3, 'B1a allAtTp1: the TP1 limit is for ALL 3 contracts at +15 (stop 3x unchanged) :: ' + B.log.join(' | '));
    ok(rr && rr.session === 'asia' && rr.mode === 'allAtTp1' && rr.tp2 === null && rr.leg1Size === 3 && rr.fill === 20000 && x.rows('entry')[0].leg1Size === 3, 'B1b journal runner_rule { session asia, mode allAtTp1, atr15, tp2 null }; the entry row shows leg1Size 3');
    fill(tpId()); await x.sm.tick();
    ok(x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && !B.log.some(l => /REST STOP 1 /.test(l)) && x.codes().includes('TP1_FILLED') && x.notif.some(n => /^Target 1 hit - position closed/.test(n)), 'B1c TP1 fills: all 3 out, FLAT, the stop cancelled, NO runner stop ever placed'); }
  { const x = await enter(LiveStateMachine, -1, { sessionRunnerFn: planFn('allAtTp1', { session: 'london' }) });
    ok(limits()[0].size === 3 && limits()[0].limitPrice === 19985, 'B1d short allAtTp1: TP1 3x @ 19985');
    fill(stopId()); await x.sm.tick();
    ok(x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && x.codes().includes('STOP_FILLED'), 'B1e allAtTp1 full stop: 3 out at the stop, the TP1 limit cancelled, FLAT'); }
  { const x = await enter(LiveStateMachine, 1, { sessionRunnerFn: planFn('allAtTp1') }); fillPart(tpId(), 2); await x.sm.tick();
    const mid = { ph: x.sm.phase, st: stops().map(s => s.size).join(), tp: limits().map(s => s.size).join(), n: net() };
    fill(tpId()); await x.sm.tick();
    ok(mid.ph === 'LEG1_OPEN' && mid.st === '1' && mid.tp === '1' && mid.n === 1 && x.sm.phase === 'FLAT' && B.orders.length === 0 && !x.sm.desynced, 'B1f allAtTp1 partial TP1 (2 of 3): the stop is resized to the 1 open, the rest of TP1 keeps resting, then FLAT - no runner, no desync'); }
  // ---- B2 atrTarget
  const afterTp1 = async (dir, extra, o) => { const x = await enter(LiveStateMachine, dir, extra, o); fill(tpId()); await x.sm.tick(); return x; };
  const ATR = { sessionRunnerFn: planFn('atrTarget') };
  const invariant = (dir, entry) => stops().length === 1 && stops()[0].size === 1 && dir * (stops()[0].stopPrice - entry) >= 2;
  { const x = await enter(LiveStateMachine, 1, ATR); const rr = x.rows('runner_rule')[0];
    ok(limits()[0].size === 2 && limits()[0].limitPrice === 20015 && rr.mode === 'atrTarget' && rr.session === 'ny' && rr.atr15 === 40 && rr.tp2 === 20080 && rr.stopPts === 2 && x.sm.runnerPlan.tp2 === 20080, 'B2a atrTarget entry: TP1 as today (2 of 3 at +15); runner_rule { ny, atrTarget, atr15 40, tp2 20080 } captured at the fill');
    const i0 = B.log.length; fill(tpId()); await x.sm.tick(); const ev = B.log.slice(i0).join(' | ');
    ok(x.sm.phase === 'LEG23_OPEN' && /^FILL LIMIT 2 @ 20015 \| REST STOP 1 @ 20002 \| cancel \d+ \| REST LIMIT 1 @ 20080$/.test(ev) && invariant(1, 20000) && limits().length === 1 && limits()[0].size === 1 && x.sm.trailStop === 20002 && x.sm.runnerArmed, 'B2b after TP1: NEW 1x stop at entry +2 first, then the 3x stop cancelled (verified replace), then the TP2 limit 1x @ 20080 :: ' + ev);
    const i1 = B.log.length; let inv = true;
    for (const px of [20020, 20035, 20050, 20075, 20030, 20004]) { B.px = px; await x.sm.tick(); await x.sm.maybeRatchetTrail(px, null); const a = await x.sm.auditStopLadder(px); inv = inv && invariant(1, 20000) && stops()[0].stopPrice === 20002 && a === 'ok'; }
    ok(B.log.length === i1 && inv && limits()[0].limitPrice === 20080, 'B2c NO trail: polls at +20 / +35 / +50 / +75 and back move nothing; the runner stop stays 1x @ entry +2 (invariant held at every poll, ladder audit ok)');
    fill(tpId()); await x.sm.tick(); const re = x.rows('runner_exit')[0];
    ok(x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && x.notif.some(n => /^Runner target hit :: Runner closed 1x @ 20080\.00/.test(n)) && re && re.kind === 'tp2' && re.sure === true && re.price === 20080 && x.journal.some(j => j.code === 'TP2_OR_BE' && j.viaTarget === true && j.runnerRule === 'atrTarget') && !x.codes().includes('POSITION_CLOSED') && x.sm.lastTarget2 === undefined && /if \(code === 'TP2_OR_BE' && r\.runnerRule === 'atrTarget' && r\.viaTarget\) return \[\{ c: n - l1 - l2, px: fin\(sm\.target2\)/.test(SRC), 'B3 TP2 fills: runner out at 20080, the +2 stop cancelled (no orphan), FLAT; journal TP2_OR_BE viaTarget + runner_exit tp2'); }
  { const x = await afterTp1(1, ATR); fill(stopId()); await x.sm.tick(); const re = x.rows('runner_exit')[0];
    ok(x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && re && re.kind === 'stop' && re.price === 20002 && x.codes().includes('RUNNER_STOPPED') && x.notif.some(n => /^Runner stopped :: Runner closed 1x @ 20002\.00/.test(n)), 'B4 the stop fills at +2: runner out at 20002, the TP2 limit cancelled (no orphan limit), FLAT; RUNNER_STOPPED + runner_exit stop'); }
  { const x = await afterTp1(-1, ATR);
    ok(stops()[0].stopPrice === 19998 && stops()[0].size === 1 && limits()[0].limitPrice === 19920 && invariant(-1, 20000), 'B4b short atrTarget: runner stop 1x @ entry -2 (19998), TP2 @ 19920'); }
  { const x = await afterTp1(1, ATR, { fillPx: 20000.1 });
    ok(x.sm.entryPrice === 20000.1 && stops()[0].stopPrice === 20002.25 && stops()[0].stopPrice - x.sm.entryPrice >= 2 && limits()[0].limitPrice === 20080, 'B4c off-tick average fill 20000.10: the stop rounds INTO profit (20002.25), never worse than entry +2'); }
  { const x = await afterTp1(1, ATR); const i0 = B.log.length; const r = await x.sm.sessionFlatten('13:05 PT session close', 'session'); const ev = B.log.slice(i0).join(' | '); await x.sm.tick();
    ok(r === 'sent' && /^cancel \d+ \| cancel \d+ \| MARKET SELL 1 \[accept\]$/.test(ev) && x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && x.notif.some(n => /^Session close: flat/.test(n)), 'B5 the session close flattens the runner: TP2 limit and stop cancelled (verified), ONE market SELL 1x, FLAT :: ' + ev); }
  // ---- B6 fallbacks
  const liveEv = async (Cls, extra) => { const x = await enter(Cls, 1, extra); fill(tpId()); await x.sm.tick(); for (const px of [20021, 20031, 20044]) { B.px = px; await x.sm.tick(); await x.sm.maybeRatchetTrail(px, null); } fill(stopId()); await x.sm.tick(); return { x, ev: B.log.join(' | ') }; };
  const baseRun = await liveEv(Base, {});
  { const { x, ev } = await liveEv(LiveStateMachine, { sessionRunnerFn: planFn('atrTarget', { atr15: null, why: 'ATR15 unavailable at the fill: only 9 completed 15m bars (needs 15)' }) }); const rr = x.rows('runner_rule')[0];
    ok(rr.mode === 'live' && rr.requested === 'atrTarget' && rr.fallback === true && /only 9 completed/.test(rr.why) && rr.tp2 === null && ev === baseRun.ev && /REST STOP 1 @ 20010/.test(ev) && !/20080/.test(ev), 'B6a ATR15 missing at the fill: this trade falls back to live (journaled with the reason) and its order events equal r1.1\'s (+10 stop, trail)'); }
  { const x = await enter(LiveStateMachine, 1, { sessionRunnerFn: planFn('atrTarget', { atr15: 7 }) }); const rr = x.rows('runner_rule')[0];
    ok(rr.mode === 'live' && rr.fallback === true && /not beyond TP1/.test(rr.why), 'B6b an ATR target that is not beyond TP1 (2 x 7 = +14 < +15): live for this trade, journaled'); }
  { const x = await enter(LiveStateMachine, 1, { sessionRunnerFn: () => { throw new Error('boom'); } }); const rr = x.rows('runner_rule')[0];
    ok(x.sm.phase === 'LEG1_OPEN' && rr.mode === 'live' && limits()[0].size === 2 && stops().length === 1, 'B6c the rule function throws: the fill is still protected as today (live)'); }
  { const x = await enter(LiveStateMachine, 1, { sessionRunnerFn: planFn('allAtTp1') }, { n: 1 }); const rr = x.rows('runner_rule')[0];
    ok(rr.mode === 'live' && /not a scale-out trade with one runner/.test(rr.why) && limits()[0].size === 1, 'B6d a 1-lot (no runner to change): live'); }
  // ---- B7 restart with the runner open
  { const sf = path.join(TMP, 'runner-state.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { ...ATR, stateFile: sf }); a.sm._stateArmed = true; fill(tpId()); await a.sm.tick(); a.sm.saveState();
    const disk = JSON.parse(fs.readFileSync(sf, 'utf8'));
    const keep = { pos: B.pos, orders: B.orders, nextId: B.nextId }; const b = mkRaw(LiveStateMachine, { ...ATR, stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos);
    ok(disk.runnerPlan && disk.runnerPlan.atr15 === 40 && disk.runnerPlan.tp2 === 20080 && disk.phase === 'LEG23_OPEN' && rr.ok && B.log.length === 0 && invariant(1, 20000) && stops()[0].stopPrice === 20002 && limits().length === 1 && limits()[0].limitPrice === 20080 && b.sm.runnerPlan.tp2 === 20080 && b.sm.targetOrderId === limits()[0].id, 'B7a restart with the runner open: ATR15 / TP2 were saved with the trade; the +2 stop and the TP2 limit are KEPT (nothing cancelled, nothing placed)');
    let inv = true; for (const px of [20040, 20070]) { B.px = px; await b.sm.tick(); await b.sm.maybeRatchetTrail(px, null); inv = inv && (await b.sm.auditStopLadder(px)) === 'ok' && invariant(1, 20000); }
    fill(tpId()); await b.sm.tick();
    ok(inv && b.sm.phase === 'FLAT' && b.rows('runner_exit')[0].kind === 'tp2' && B.orders.length === 0, 'B7b after the restart: still no trail, invariant held; the TP2 fill closes the runner'); }
  { const sf = path.join(TMP, 'runner-state2.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { ...ATR, stateFile: sf }); a.sm._stateArmed = true; fill(tpId()); await a.sm.tick(); a.sm.saveState();
    B.orders = B.orders.filter(o => o.limitPrice == null);   // the TP2 limit is gone at the broker (cancelled by hand / expired) while the bot was down
    const keep = { pos: B.pos, orders: B.orders, nextId: B.nextId }; const b = mkRaw(LiveStateMachine, { ...ATR, stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos); const none = limits().length; B.px = 20030; await b.sm.maybeRatchetTrail(20030, null);
    ok(rr.ok && none === 0 && limits().length === 1 && limits()[0].limitPrice === 20080 && limits()[0].size === 1 && invariant(1, 20000), 'B7c restart with the TP2 limit missing at the broker: the stop is kept and the TP2 limit is put back on the next poll (order list read first)'); }
  // ---- B8 TP2 placement failures: never stacked
  { const x = await enter(LiveStateMachine, 1, ATR); B.limitModes = ['reject']; fill(tpId()); await x.sm.tick();
    const a = { lim: limits().length, inv: invariant(1, 20000) }; await x.sm.maybeRatchetTrail(20020, null); const b1 = limits().length; x.sm.tp2RetryAt = 0; await x.sm.maybeRatchetTrail(20020, null);
    ok(a.lim === 0 && a.inv && b1 === 0 && limits().length === 1 && limits()[0].limitPrice === 20080 && x.codes().includes('RUNNER_TP2_NOT_PLACED'), 'B8a the TP2 limit is REJECTED at the scale-out: the runner keeps its +2 stop; not retried inside the 15 s back-off; then placed'); }
  { const x = await enter(LiveStateMachine, 1, ATR); B.limitModes = ['lost']; fill(tpId()); await x.sm.tick();
    const a = { lim: limits().length, tracked: x.sm.targetOrderId }; x.sm.tp2RetryAt = 0; await x.sm.maybeRatchetTrail(20020, null); await x.sm.maybeRatchetTrail(20025, null);
    ok(a.lim === 1 && a.tracked == null && limits().length === 1 && x.sm.targetOrderId === limits()[0].id, 'B8b the TP2 reply is LOST but the order rests: it is found in the order list and tracked - never a second TP2 limit (1 resting)'); }
  // ---- B9 the +2 stop refused at the scale-out
  { const x = await enter(LiveStateMachine, 1, ATR); B.stopModes = ['reject', 'reject', 'reject', 'reject', 'reject']; B.px = 20015; fill(tpId()); await x.sm.tick();
    const a = { st: stops().map(s => `${s.size}@${s.stopPrice}`).join(), ph: x.sm.phase, lim: limits().length, des: x.sm.desynced };
    x.sm.trailRetryAt = 0; B.stopModes = []; await x.sm.maybeRatchetTrail(20016, null); const s1 = stops().map(s => `${s.size}@${s.stopPrice}`).join(); await x.sm.maybeRatchetTrail(20060, null);
    ok(a.st === '1@19950' && a.ph === 'LEG23_OPEN' && !a.des && a.lim === 1 && s1 === '1@20002' && stops().map(s => `${s.size}@${s.stopPrice}`).join() === '1@20002', 'B9 the +2 stop is refused at the scale-out: the old stop is resized to the 1x runner (never unprotected, never oversized), then moved to entry +2 on the next poll - and no further :: ' + a.st + ' -> ' + s1); }
  // ---- B10 'live' is today's behaviour: same script on the r1.1 tree and on this tree
  { const strip = j => JSON.stringify(j.map(r => { const { t, at, ...rest } = r; return rest; })).replace(/\b1[5-9]\d{11}\b/g, 'T');   // every epoch-ms value (recordedAt, fillSeenAt, checkAt) is a clock reading, not behaviour
    const off = await liveEv(LiveStateMachine, {}), live = await liveEv(LiveStateMachine, { sessionRunnerFn: planFn('live', { session: 'late' }) });
    ok(off.ev === baseRun.ev && /REST STOP 1 @ 20010/.test(off.ev) && /REST STOP 1 @ 20020/.test(off.ev) && /REST STOP 1 @ 20030/.test(off.ev), 'B10a rule not wired (all sessions live): order events IDENTICAL to the r1.1 tree on TP1 -> trail -> runner stop :: ' + off.ev);
    ok(strip(off.x.journal) === strip(baseRun.x.journal) && JSON.stringify(off.x.notif) === JSON.stringify(baseRun.x.notif) && JSON.stringify(off.x.logs) === JSON.stringify(baseRun.x.logs), 'B10b ... and so are the journal rows, the alerts and the log lines (byte-for-byte apart from timestamps)');
    ok(live.ev === baseRun.ev && live.x.rows('runner_rule').length === 1 && live.x.rows('runner_rule')[0].mode === 'live' && strip(live.x.journal.filter(j => j.type !== 'runner_rule')) === strip(baseRun.x.journal) && JSON.stringify(live.x.notif) === JSON.stringify(baseRun.x.notif), 'B10c a session set to live while others are not: order events, alerts and journal identical to r1.1 apart from the one runner_rule row');
    const stopRun = async (Cls, extra) => { const x = await enter(Cls, -1, extra); fill(stopId()); await x.sm.tick(); return { x, ev: B.log.join(' | ') }; };
    const s0 = await stopRun(Base, {}), s1 = await stopRun(LiveStateMachine, {});
    ok(s0.ev === s1.ev && strip(s0.x.journal) === strip(s1.x.journal), 'B10d full stop before TP1: identical to r1.1 (orders and journal)');
    const snapKeys = async Cls => { const x = await enter(Cls, 1, {}); return Object.keys(x.sm.stateSnapshot()).sort().join(); };
    ok(await snapKeys(Base) === await snapKeys(LiveStateMachine), 'B10e the saved trade state has the same keys as r1.1 when both rules are off / live'); }
  // ---- B11 config, sessions, ATR
  { const v = EE.validateRunner, good = { asia: 'allAtTp1', london: 'allAtTp1', ny: 'atrTarget', late: 'live' }, ny = { stopPts: 2, tp2AtrMult: 2 };
    ok(v(good, ny).length === 0 && v({ ...good, ny: 'atr' }, ny).length === 1 && v({ asia: 'live', london: 'live', ny: 'live' }, ny).length === 1 && v(good, { stopPts: -1, tp2AtrMult: 2 }).length === 1 && v(good, { stopPts: 2, tp2AtrMult: 0 }).length === 1 && v(null, null).length === 2, 'B11a validateRunner: a bad mode, a missing session, a negative stop, a zero ATR multiple and missing objects are refused');
    ok(/sessionRunner: \{ asia: 'allAtTp1', london: 'allAtTp1', ny: 'atrTarget', late: 'live' \}/.test(SRC) && /sessionRunnerNy: \{ stopPts: 2, tp2AtrMult: 2\.0 \}/.test(SRC) && ['asia', 'london', 'ny', 'late'].every(s => SRC.includes(`'sessionRunner.${s}': edgeExits.RUNNER_MODES`)) && /throw new Error\(`sessionRunner is unusable/.test(SRC) && SRC.includes('log(edgeExits.runnerLine(CONFIG.sessionRunner, CONFIG.sessionRunnerNy, scaleOutRunnerOn(CONFIG)))'), 'B11b executor: shipped values, strict-loader enums for all four sessions, startup throws on a bad value, prints the [runner] line');
    ok(/sessionRunnerFn: scaleOutRunnerOn\(CONFIG\) && !edgeExits\.runnerAllLive\(CONFIG\.sessionRunner\) \? ts => edgeExits\.runnerPlanFor\(\{ session: stopFloor\.sessionOf\(ptInfo\(ts\)\.minutesOfDay\)/.test(SRC), 'B11c executor: the session is the FILL\'s session through stopFloor.sessionOf (the stop floor\'s helper); all four live = the rule is not wired at all');
    const line = EE.runnerLine(good, ny, true);
    ok(/^\[runner\] session runner: asia all contracts out at TP1 \(no runner\); london all contracts out at TP1 \(no runner\); ny runner stop entry \+2, TP2 2 x ATR15/.test(line) && /late live/.test(line) && EE.runnerAllLive({ asia: 'live', london: 'live', ny: 'live', late: 'live' }) && !EE.runnerAllLive(good), 'B11d startup line :: ' + line);
    const cfgP = (min) => EE.runnerPlanFor({ session: SF.sessionOf(min), cfg: good, ny, bars15: null, ts: Date.now() });
    ok(cfgP(100).mode === 'allAtTp1' && cfgP(389).session === 'london' && cfgP(390).mode === 'atrTarget' && cfgP(390).session === 'ny' && /ATR15 unavailable/.test(cfgP(390).why) && cfgP(779).session === 'ny' && cfgP(780).mode === 'live' && cfgP(900).mode === 'allAtTp1' && cfgP(900).session === 'asia', 'B11e sessions by PT minute: london < 06:30 allAtTp1, ny 06:30-13:00 atrTarget, late 13:00-15:00 live, asia from 15:00 allAtTp1'); }
  { const M15 = 900000, t0 = Math.floor(Date.now() / M15) * M15 - 20 * M15, bars = [];
    for (let i = 0; i < 20; i++) bars.push({ t: t0 + i * M15, h: 100 + i + 10, l: 100 + i - 10, c: 100 + i });   // TR = 20 each (|h - prevClose| = 11, h - l = 20)
    bars[19] = { t: t0 + 19 * M15, h: 1000, l: 0, c: 500 };   // a wild bar 19: must not count while it is forming
    const ts = t0 + 19 * M15 + 60000, a = EE.atr15At(bars, ts);
    const bars2 = bars.slice(0, 19); bars2[18] = { ...bars2[18], h: 100 + 18 + 24, l: 100 + 18 - 10 };   // one completed bar with TR 34: mean = (13 x 20 + 34) / 14 = 21
    ok(a.atr === 20 && EE.atr15At(bars2, ts).atr === 21 && EE.atr15At(bars.slice(8), ts).atr === null && /only 11/.test(EE.atr15At(bars.slice(8), ts).why) && EE.atr15At(bars.slice(0, 17), ts).atr === null && /stale/.test(EE.atr15At(bars.slice(0, 17), ts).why) && EE.atr15At(null, ts).atr === null && EE.atr15At(bars, ts + M15).atr > 20, 'B11f ATR15 = the MEAN true range of the 14 completed 15m bars before the fill (the forming bar excluded; fewer than 15 completed bars or stale bars = unavailable)'); }

  console.log(`\nedge r1 tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
