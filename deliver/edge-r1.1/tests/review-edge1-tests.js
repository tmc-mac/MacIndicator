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
// ===================== reviewer desk hunts =====================
(async () => {
  const planFn = (mode, o = {}) => () => ({ session: o.session || 'ny', mode, stopPts: 2, tp2AtrMult: 2, atr15: 'atr15' in o ? o.atr15 : 40, why: o.why || null });
  async function enter(Cls, dir, extra = {}, o = {}) {
    const x = mkRaw(Cls, extra); resetB(); B.px = o.fillPx ?? 20000;
    const n = o.n ?? 3, e = 20000;
    Object.assign(x.sm, { phase: 'PENDING_ENTRY', dir, stopPriceIntended: e - dir * 50, target1: e + dir * 15, target2: e + dir * 40, tightStopPrice: null, smartHoldChecked: false, intendedEntryPrice: e, source: 'levels', grade: 'A', contracts: n,
      leg1Size: Math.max(1, n - 1), leg2Size: 0, entrySignalTime: o.signalAt ?? Date.now(), entryType: o.entryType || 'MARKET', fillHandled: false, throughStop: false, signalContext: null, sessionExit: null, entryOrderId: 90 });
    B.log.push(`MARKET ${dir === 1 ? 'BUY' : 'SELL'} ${n} (entry)`); setNet(dir * n, B.px);
    await x.sm.tick();
    return x;
  }
  const tpId = () => (limits()[0] || {}).id, stopId = () => (stops()[0] || {}).id;
  const ATR = { sessionRunnerFn: planFn('atrTarget') };
  const afterTp1 = async (dir, extra, o) => { const x = await enter(LiveStateMachine, dir, extra, o); fill(tpId()); await x.sm.tick(); return x; };
  const info = (name, v) => console.log('info ' + name + ' :: ' + v);

  // ---- R1 HALT (desynced) with the ATR runner open: TP2 fills, the +2 stop is an orphan with no owner; when price comes back it OPENS a short
  { const x = await afterTp1(1, ATR); x.sm.desynced = true;   // any halt: DESYNC, so1 halt, exit halt
    fill(tpId()); for (let i = 0; i < 5; i++) { await x.sm.tick(); await x.sm.maybeRatchetTrail(20080, null); await x.sm.auditStopLadder(20080); }
    const orphan = net() === 0 && stops().length === 1;
    const s = stops()[0]; B.orders = B.orders.filter(o => o.id !== s.id); setNet(-s.size);   // the resting SELL stop triggers on a flat account
    for (let i = 0; i < 3; i++) await x.sm.tick();
    ok(orphan && net() === -1 && B.orders.length === 0, 'R1 [DEFECT REPRO] halted bot + ATR runner: after the TP2 fill the 1x SELL stop keeps resting on a FLAT account (5 polls); when it triggers the account is SHORT 1 with no stop :: net ' + net() + ', orders ' + B.orders.length); }
  // ---- R1b same halt, LIVE runner (today): only ONE order rests for the runner, so no orphan is possible after it fills
  { const x = await afterTp1(1, {}); x.sm.desynced = true; const s = stops()[0]; fill(s.id); for (let i = 0; i < 3; i++) await x.sm.tick();
    ok(net() === 0 && B.orders.length === 0, 'R1b control: halted bot + LIVE runner: the runner stop fills, the account is flat with NO order left (the orphan in R1 is new with atrTarget)'); }

  // ---- R2 a saved early-exit decision is executed after a restart however old it is
  { const sf = path.join(TMP, 'rv-eae-stale.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = mkA(1, { stateFile: sf }); a.sm._stateArmed = true;
    a.sm.eaeState = { decided: 'exit', at: Date.now() - 40 * 60000, pts: -10.5, mfe: 1, close: 19999.5, closeAt: Date.now() - 40 * 60000, reason: 'early exit: never worked', mode: 'exit' };
    a.sm.flattenKind = null; a.sm.saveState();
    const keep = { pos: B.pos, orders: B.orders, nextId: B.nextId }; const b = mkRaw(LiveStateMachine, { stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos); B.px = 20022;   // 40 min later the trade is +12
    const r = await b.sm.earlyAdverseStep(CFG, [], Date.now());
    ok(rr.ok && r === 'sent' && markets() === 1, 'R2 [DEFECT REPRO] an early-exit decision saved 40 min before a restart (send never went out) is executed at market on the first poll after the restart, with the trade now at +12 :: ' + B.log.join(' | ')); }

  // ---- R2b the decision has a 45 s limit, the SEND has none: while the broker reads fail the exit stays owed, and goes out whenever they recover
  { const x = mkA(1); B.posFail = 3; const r0 = await poll(x, m1L(1, -12), NOW); const r1 = await poll(x, m1L(1, -12), NOW + 20000); const r2 = await poll(x, m1L(1, -12), NOW + 40000);
    const m0 = markets(); B.px = 20025; const r3 = await poll(x, [], NOW + 15 * 60000);   // 15 min later, the trade at +15 (TP1 not filled)
    ok(r0 === 'retry' && r1 === 'retry' && r2 === 'retry' && m0 === 0 && r3 === 'sent' && markets() === 1, 'R2b [DEFECT REPRO] early exit decided, 3 broker reads fail, then 15 min later the exit is sent at market with the trade at +15 :: ' + [r0, r1, r2, r3].join(',') + ' :: ' + B.log.join(' | ')); }

  // ---- R3 allAtTp1, TP1 partly filled, then the stop takes the rest: labelled a FULL stop on all
  { const x = await enter(LiveStateMachine, 1, { sessionRunnerFn: planFn('allAtTp1') }); fillPart(tpId(), 2); await x.sm.tick(); fill(stopId()); await x.sm.tick();
    const le = x.sm.lastExit || {};
    info('R3 lastExit', JSON.stringify({ kind: le.kind, contracts: le.contracts }) + ' codes ' + x.codes().filter(c => /TP1|STOP/.test(c)).join(','));
    ok(x.sm.phase === 'FLAT' && B.orders.length === 0 && net() === 0, 'R3a allAtTp1: 2 of 3 at TP1, then the stop on the last 1: FLAT, no order left');
    ok(le.kind === 'stop' && le.contracts === 1, 'R3b the exit is recorded as a stop on the 1 contract that was left (not on all 3) :: kind ' + le.kind + ', contracts ' + le.contracts); }

  // ---- R4 restore with no usable fill time: the price-evidence boundary is never set (the assignment sits inside a comment), so priceEvidenceOk is false for the whole trade
  { const sf = path.join(TMP, 'rv-pxb.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { stateFile: sf }); a.sm._stateArmed = true; fill(tpId()); await a.sm.tick();
    a.sm.npFillAt = null; a.sm.npCoveredTo = null; a.sm.saveState();   // e.g. a trade that was itself adopted, or whose np record does not validate
    const keep = { pos: B.pos, orders: B.orders, nextId: B.nextId }; const b = mkRaw(LiveStateMachine, { stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos); const now = Date.now() + 10 * 60000, barT = Math.floor(now / 60000) * 60000;
    ok(rr.ok && Number.isFinite(b.sm.pxBoundaryAt) && b.sm.priceEvidenceOk(barT, now) === true, 'R4 after a restore without a fill time, the current 1m bar 10 min later is accepted as price evidence (runner trail / TP2 put-back / smart hold are gated on it) :: pxBoundaryAt ' + b.sm.pxBoundaryAt + ', ok ' + b.sm.priceEvidenceOk(barT, now)); }

  // ---- R5 ATR runner, restore with no usable fill time AND the TP2 limit missing: the executor only calls maybeRatchetTrail when priceEvidenceOk -> TP2 never put back
  { const sf = path.join(TMP, 'rv-pxb2.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { ...ATR, stateFile: sf }); a.sm._stateArmed = true; fill(tpId()); await a.sm.tick(); a.sm.npFillAt = null; a.sm.npCoveredTo = null; a.sm.saveState();
    B.orders = B.orders.filter(o => o.limitPrice == null);
    const keep = { pos: B.pos, orders: B.orders, nextId: B.nextId }; const b = mkRaw(LiveStateMachine, { ...ATR, stateFile: sf }); Object.assign(B, keep, { log: [] });
    await b.sm.restoreFromState(B.pos);
    for (let i = 1; i <= 6; i++) { const now = Date.now() + i * 60000, barT = Math.floor(now / 60000) * 60000; await b.sm.tick(); if (b.sm.priceEvidenceOk(barT, now)) await b.sm.maybeRatchetTrail(20030, null); await b.sm.auditStopLadder(20030); }   // the executor's gate (live-executor.js pxOk)
    ok(limits().length === 1 && stops().length === 1 && stops()[0].stopPrice >= 20002, 'R5 ATR runner restored without a fill time, TP2 limit missing: put back within 6 polls through the executor gate :: limits ' + limits().length + ', stop ' + (stops()[0] || {}).stopPrice); }

  // ---- R6 fill seen late (a resting entry that filled while the bot was down, resumed by recoverSavedPendingEntry -> tick): the fill clock starts at the observation
  { const x = await enter(LiveStateMachine, 1, {}, { signalAt: Date.now() - 45 * 60000, entryType: 'LIMIT' });
    ok(Math.abs(x.sm.npFillAt - Date.now()) < 5000, 'R6 (by design, see review) a fill first SEEN now on an entry sent 45 min ago: npFillAt = now, so the early exit times its 120 s from the observation and "never seen at +3" only covers the time since'); }

  // ---- R7 no early exit after TP1, on a runner, or on a position without a fill time
  { const x = await afterTp1(1, ATR); x.sm.npFillAt = FILL; x.sm.npCoveredTo = T0 + 180000; x.sm.npBestPts = 0; x.sm.eaeState = null; x.sm.entryPrice = 20010;
    const r = await x.sm.earlyAdverseStep(CFG, m1L(1, -12), NOW);
    ok(r === null && markets() === 0 && x.sm.eaeState === null, 'R7a LEG23_OPEN (after TP1): the early exit does nothing even with -12 at the close'); }
  { const x = mkA(1); x.sm.npFillAt = null; const r = await poll(x, m1L(1, -12), NOW); const r2 = await poll(x, m1L(1, -12), NOW + 20000);
    ok(r === 'unassessed' && r2 === null && markets() === 0, 'R7b no fill time (adopted): unassessed once, never an exit'); }
  { const x = mkA(1); const r = await poll(x, m1L(1, -12), NOW); const n1 = markets(); for (let i = 1; i < 6; i++) { await x.sm.tick(); await poll(x, m1L(1, -12), NOW + i * 20000); }
    ok(r === 'sent' && n1 === 1 && markets() === 1 && B.orders.length === 0 && x.sm.phase === 'FLAT', 'R7c fires once: 5 more polls after the exit send no second market order; FLAT, no order left'); }
  { const x = mkA(-1); const r = await poll(x, m1S(1, -12), NOW);   // short from 19990, close 20002 = -12
    ok(r === 'sent' && /MARKET BUY 3/.test(B.log.join('|')), 'R7d short: -12 against (close ABOVE entry) exits with a BUY 3'); }
  { const x = mkA(-1); const m = [bar(1, 19995, 19980, 19979), bar(2, 19980, 19978, 19978), bar(3, 19978, 19978, 19978)]; const r = await poll(x, m, NOW);   // short at +12 in favour
    ok(r === 'keep' && markets() === 0, 'R7e short sign: +12 in favour (close BELOW entry) is kept'); }

  // ---- R8 phone flatten / HALT interplay
  { const x = await afterTp1(1, ATR); const i0 = B.log.length; await x.sm.flattenNow({ what: 'manual', reason: 'phone' }); await x.sm.tick(); const ev = B.log.slice(i0).join(' | ');
    ok(x.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0 && (ev.match(/MARKET/g) || []).length === 1, 'R8a phone flatten with the ATR runner open: TP2 limit and stop cancelled, ONE market order, FLAT :: ' + ev); }
  { const x = mkA(1); x.sm.desynced = true; const r = await poll(x, m1L(1, -12), NOW);
    ok(r === null && markets() === 0 && B.orders.length === 2, 'R8b HALT: the early exit sends nothing and leaves the stop and TP1 resting'); }
  { const x = mkA(1); await x.sm.flattenNow({ what: 'manual', reason: 'phone' }); const m0 = markets(); const r = await poll(x, m1L(1, -12), NOW);
    ok(m0 === 1 && markets() === 1, 'R8c phone flatten first, then the early-exit poll: still ONE market order :: ' + r); }

  // ---- R9 the ATR runner's stop is missing at the broker (cancelled by hand): the ladder audit puts it back at entry +2 or better on that poll
  { const x = await afterTp1(1, ATR); B.orders = B.orders.filter(o => o.stopPrice == null); B.px = 20030; const a = await x.sm.auditStopLadder(20030);
    ok(a === 'fixed' && stops().length === 1 && stops()[0].size === 1 && stops()[0].stopPrice >= 20002, 'R9a runner stop missing: one poll later a 1x stop rests at ' + (stops()[0] || {}).stopPrice + ' (>= entry +2)'); }
  { const x = await enter(LiveStateMachine, 1, ATR); B.stopModes = ['reject', 'reject', 'reject', 'reject', 'reject']; B.px = 20015; fill(tpId()); await x.sm.tick(); B.stopModes = [];
    const before = stops().map(s => `${s.size}@${s.stopPrice}`).join(); const a = await x.sm.auditStopLadder(20016);   // the executor runs the audit in the SAME poll, after the tick
    info('R9b', `after the refused +2: ${before}; audit in the same poll -> ${a}: ${stops().map(s => `${s.size}@${s.stopPrice}`).join()} (auditRetryAt ${x.sm.auditRetryAt || 0}, trailRetryAt ${x.sm.trailRetryAt ? 'set' : 0})`);
    ok(stops().length === 1 && stops()[0].size === 1, 'R9b +2 refused at the scale-out: never unprotected, never oversized (how long it stays below +2 is in the info line)'); }

  // ---- R10 allAtTp1 across a restart: the 3x TP1 limit is kept, not shrunk to 2
  { const sf = path.join(TMP, 'rv-all.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = await enter(LiveStateMachine, 1, { sessionRunnerFn: planFn('allAtTp1'), stateFile: sf }); a.sm._stateArmed = true; a.sm.saveState();
    const keep = { pos: B.pos, orders: B.orders, nextId: B.nextId }; const b = mkRaw(LiveStateMachine, { sessionRunnerFn: planFn('allAtTp1'), stateFile: sf }); Object.assign(B, keep, { log: [] });
    const rr = await b.sm.restoreFromState(B.pos); const quiet = B.log.length === 0 && limits()[0].size === 3; fill(tpId()); await b.sm.tick();
    ok(rr.ok && quiet && b.sm.phase === 'FLAT' && net() === 0 && B.orders.length === 0, 'R10 allAtTp1 restart: the 3x TP1 is kept; its fill closes everything, FLAT, no order left :: ' + B.log.join(' | ')); }

  // ---- R11 atr15At units / staleness
  { const now = Math.floor(Date.now() / 900000) * 900000 + 5 * 60000; const mk = (k, r) => ({ t: now - 5 * 60000 - k * 900000, h: 100 + r, l: 100, c: 100 });
    const bars = []; for (let k = 16; k >= 1; k--) bars.push(mk(k, 10)); bars.push({ t: now - 5 * 60000, h: 500, l: 100, c: 300 });   // the forming bar must be ignored
    const a = EE.atr15At(bars, now), stale = EE.atr15At(bars.slice(0, -3), now + 0), old = EE.atr15At(bars.map(b => ({ ...b, t: b.t - 3 * 900000 })), now);
    ok(a.atr === 10 && old.atr === null, 'R11 ATR15 = mean true range in POINTS of the 14 completed bars (10), the forming bar ignored; bars 45 min stale = no ATR (trade falls back to live) :: ' + JSON.stringify([a.atr, stale.atr, old.why])); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch(e => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
