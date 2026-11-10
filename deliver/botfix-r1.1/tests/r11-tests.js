'use strict';
// botfix r1.1 tests: node r11-tests.js <tree> <tmpdir>. The exitsafe-tests.js fake broker (stateful, order history, lost replies) plus sticky orders;
// covers the r1.1 fixes: [exits] line, phone/manual flatten on the safe-exit rule, through-stop cap/backoff/persistence, order-history field fail-safe,
// one push per full stop, entry-cancel 60 s age-out, the flatten acks. Real LiveStateMachine, real lib modules.
const path = require('path'), fs = require('fs');
const [TREE, TMP] = process.argv.slice(2).map(p => path.resolve(p));
fs.mkdirSync(TMP, { recursive: true });
const B = {};
function resetB(dir, size = 3) {
  Object.assign(B, { pos: { size, type: dir === 1 ? 1 : 2, averagePrice: dir === 1 ? 20010 : 19990 }, nextId: 100, log: [], marketMode: 'accept', modes: [], posLag: 0, lagPos: null, tpFillOnCancel: false,
    history: [], ghost: null, unstable: 0, posFail: 0, histFail: false, onMarket: null, sticky: new Set(), cancels: 0 });
  B.orders = [{ id: 11, size, stopPrice: dir === 1 ? 19980 : 20020, type: 4 }, { id: 12, size: 1, limitPrice: dir === 1 ? 20025 : 19975, type: 1 }];
}
const net = () => B.pos ? (B.pos.type === 1 ? B.pos.size : -B.pos.size) : 0;
const setNet = n => { B.pos = n === 0 ? null : { size: Math.abs(n), type: n > 0 ? 1 : 2, averagePrice: 20000 }; };
const p = require.resolve(path.join(TREE, 'lib/liveOrders.js')), real = require(p), { OrderType, OrderSide } = real;
require.cache[p].exports = { ...real,
  getOpenPosition: async () => { B.posReads = (B.posReads || 0) + 1;
    if (B.posFail > 0) { B.posFail--; const e = new Error('read timeout'); e.positionUnreadable = true; throw e; }
    if (B.unstable > 0) { B.unstable--; return B.unstable % 2 ? { size: 3, type: 1, averagePrice: 20010 } : null; }
    if (B.posLag > 0) { B.posLag--; return B.lagPos ? { ...B.lagPos } : null; }
    return B.pos ? { ...B.pos } : null; },
  getOpenOrders: async () => B.orders.map(o => ({ ...o })),
  getEntryOrder: async () => null,
  searchOrdersSince: async () => { if (B.histFail) throw new Error('Order history unreadable'); return B.history.map(o => ({ ...o, contractId: 'C' })); },
  cancelOrder: async (t, a, id) => { B.log.push('cancel ' + id); B.cancels++; if (B.sticky.has(id)) return false;
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
const PR = require(path.join(TREE, 'lib/phoneRequests.js'));
const ECR = require(path.join(TREE, 'lib/entryCancelRequests.js'));
const HA = require(path.join(TREE, 'lib/healthAlerts.js'));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
function mk(dir, extra = {}) {
  const journal = [], notif = [], logs = [];
  const sm = new LiveStateMachine({ token: 't', accountId: 1, contractId: 'C', pointValue: 2, tickSize: 0.25, log: m => logs.push(m), notify: (a, b) => notif.push(a + ' :: ' + b), journal: r => journal.push(r), ...extra });
  Object.assign(sm, { phase: 'LEG1_OPEN', dir, entryPrice: dir === 1 ? 20010 : 19990, contracts: 3, leg1Size: 1, leg2Size: 1, target1: dir === 1 ? 20025 : 19975, target2: dir === 1 ? 20050 : 19950,
    stopPriceIntended: dir === 1 ? 19980 : 20020, trailStop: dir === 1 ? 19980 : 20020, stopOrderId: 11, targetOrderId: 12, sessionConfirmMs: 0, settleReadMs: 0, fillHandled: true });
  resetB(dir);
  const codes = () => journal.filter(r => r.type === 'trade_manage').map(r => r.code);
  return { sm, journal, notif, logs, codes };
}
const markets = () => B.log.filter(x => x.startsWith('MARKET')).length;
const rests = () => B.log.filter(x => x.startsWith('REST'));
const stopsResting = () => B.orders.filter(o => o.stopPrice != null);
const tpResting = () => B.orders.filter(o => o.limitPrice != null);
const SRC = fs.readFileSync(path.join(TREE, 'live-executor.js'), 'utf8');
(async () => {
  // ---- 1. the [exits] startup line
  { const t = safeExit.rulesText();
    ok(/N = 20 s/.test(t) && /K = 3 market sends/.test(t) && /HALT/.test(t) && /unrecognised row/.test(t) && /phone\/manual flatten/.test(t) && /filled-through-stop/.test(t), '1 rulesText(): N = 20 s settle, K = 3 sends, the HALT conditions, every exit named :: ' + t.slice(0, 160));
    ok(/log\(`\[exits\] \$\{require\('\.\/lib\/safeExit'\)\.rulesText\(\)\}`\)/.test(SRC) && SRC.indexOf('[exits]') < SRC.indexOf("=== ${LIVE ? 'LIVE ORDER'"), '1b the executor prints "[exits] <rule>" at startup, before the executor banner, from the same constants'); }

  // ---- 2. phone / manual flatten on the safe-exit rule
  { const x = mk(1); const r = await x.sm.flattenNow();
    ok(r === 'sent' && x.sm.phase === 'FLATTENING' && markets() === 1 && B.log[0] === 'cancel 12' && B.log[1] === 'cancel 11' && B.log[2].startsWith('MARKET SELL 3') && x.sm.exitInFlight.kind === 'manual' && x.sm.exitInFlight.outcome === 'accepted'
      && x.journal.filter(j => j.type === 'manual_flatten').length === 1 && x.codes().includes('MANUAL_FLATTEN') && x.notif.some(n => /^Flatten requested/.test(n)), '2a flatten accepted: verified cancels first, ONE market 3x, FLATTENING, exitInFlight manual, the same journal row / push as before');
    await x.sm.tick();
    ok(x.sm.phase === 'FLAT' && x.notif.some(n => /^Flatten confirmed/.test(n)) && x.codes().includes('FLATTEN_CONFIRMED') && x.sm.flattenKind == null, '2b tick confirms flat: "Flatten confirmed" (same text as before), machine reset'); }
  { const x = mk(-1); B.marketMode = 'timeout-accepted'; const r = await x.sm.flattenNow();
    ok(r === 'sent' && markets() === 1 && rests().length === 0 && x.sm.phase === 'FLATTENING' && !x.sm.desynced && x.codes().includes('EXIT_UNKNOWN_RESOLVED'), '2c lost reply, the exit DID fill: settled flat, nothing re-placed, no second order'); }
  { const x = mk(1); B.marketMode = 'timeout-lost'; const r = await x.sm.flattenNow();
    ok(r === 'retry' && markets() === 1 && net() === 3 && stopsResting().length === 1 && stopsResting()[0].stopPrice === 19980 && tpResting().length === 1 && tpResting()[0].limitPrice === 20025 && x.sm.exitAttempts === 1 && x.sm.flattenKind === 'manual',
      '2d lost reply, NOT filled (position, orders and history agree): ONE order only while unknown; stop + TP1 back at the same prices; 1 of 3 attempts used');
    B.marketMode = 'accept'; const r2 = await x.sm.sessionFlatten('manual flatten (continuing)', 'manual');
    ok(r2 === 'sent' && markets() === 2 && net() === 0, '2e the executor driver (sessionFlatten manual) retries next poll: second send accepted, flat'); }
  { const x = mk(1); B.marketMode = 'timeout-accepted'; B.onMarket = () => { B.lagPos = { size: 3, type: 1, averagePrice: 20010 }; B.posLag = 1000; };
    const r = await x.sm.flattenNow(); B.posLag = 0; B.onMarket = null;
    const r2 = await x.sm.flattenNow(), r3 = await x.sm.sessionFlatten('manual flatten (continuing)', 'manual');
    ok(r === 'desynced' && x.sm.desynced && markets() === 1 && net() === 0 && /history/.test(x.sm._so1HaltWhy) && x.notif.some(n => /UNKNOWN - FLATTEN IN TOPSTEPX NOW/.test(n)) && r2 === 'desynced' && r3 === 'desynced' && x.codes().includes('MANUAL_FLATTEN_REFUSED_HALTED'),
      '2f lost reply + a stale position read, history shows the exit filled: HALT, no second order; a later flatten tap on the halted bot sends nothing :: ' + x.sm._so1HaltWhy); }
  { const x = mk(1); B.marketMode = 'reject'; const rs = [];
    rs.push(await x.sm.flattenNow());
    rs.push(await x.sm.sessionFlatten('manual flatten (continuing)', 'manual'));   // backoff after the 1st rejection = 0: next poll
    rs.push(await x.sm.sessionFlatten('manual flatten (continuing)', 'manual'));   // inside the 10 s backoff after the 2nd: nothing sent
    const mB = markets(); x.sm.exitRetryAt = 0;
    rs.push(await x.sm.sessionFlatten('manual flatten (continuing)', 'manual'));   // 3rd send rejected: cap -> HALT
    B.marketMode = 'accept'; rs.push(await x.sm.flattenNow());
    ok(JSON.stringify(rs) === JSON.stringify(['retry', 'retry', 'retry', 'desynced', 'desynced']) && mB === 2 && markets() === 3 && net() === 3 && stopsResting().length === 1 && tpResting().length === 1 && x.sm.desynced
      && x.notif.filter(n => /Manual flatten: exit REJECTED 3x - FLATTEN IN TOPSTEPX NOW/.test(n)).length === 1, '2g rejected 3x: backoff respected, K = 3 sends then HALT ("Manual flatten" named), stop + TP1 resting; no 4th order :: ' + JSON.stringify(rs)); }
  { const x = mk(1); B.sticky.add(11); const r = await x.sm.flattenNow();
    ok(r === 'retry' && markets() === 0 && net() === 3 && x.sm.flattenKind === 'manual' && !x.sm.exitAttempts && tpResting().length === 1, '2h the stop does not cancel (still resting): NO market order (both could fill), TP1 put back, no attempt counted, kept for the next poll');
    B.sticky.clear(); const r2 = await x.sm.sessionFlatten('manual flatten (continuing)', 'manual');
    ok(r2 === 'sent' && markets() === 1 && net() === 0, '2i next poll the driver finishes it: one market order, flat'); }
  { const x = mk(1); B.posFail = 1; let err = null; try { await x.sm.flattenNow(); } catch (e) { err = e; }
    ok(err && err.positionUnreadable === true && B.cancels === 0 && markets() === 0, '2j position unreadable: throws positionUnreadable before touching anything (the executor keeps the request, as before)'); }
  { const x = mk(1); x.sm.desynced = true; x.sm._so1HaltWhy = 'test halt'; B.posReads = 0; const r = await x.sm.flattenNow();
    ok(r === 'desynced' && B.log.length === 0 && B.posReads === 0, '2k halted bot: a flatten request sends nothing and reads nothing (flatten in TopstepX)'); }
  { const x = mk(1); x.sm.phase = 'FLAT'; ok(await x.sm.flattenNow() === 'none' && B.log.length === 0, '2l flat: no-op'); }
  { const x = mk(1); const r = await x.sm.flattenNow({ what: 'daily-floor', reason: 'daily floor hit' }); x.sm.phase = 'LEG1_OPEN';
    ok(r === 'sent' && x.sm._exitTitle() === 'Daily-floor flatten' && x.journal.some(j => j.type === 'manual_flatten' && j.what === 'daily-floor'), '2m daily floor / time stop use the same path, named in alerts and the journal'); }
  // restart while a manual flatten was in flight: the same settle rule; "still open" keeps the manual intent (flattenKind restored) for the driver
  { const sf = path.join(TMP, 'r11-state.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const a = mk(1, { stateFile: sf }); a.sm._stateArmed = true;
    let onDisk = null; B.marketMode = 'hang'; B.onMarket = () => { onDisk = JSON.parse(fs.readFileSync(sf, 'utf8')); };
    a.sm.flattenNow();
    for (let i = 0; i < 50 && !onDisk; i++) await new Promise(r => setImmediate(r));
    B.onMarket = null;
    ok(onDisk && onDisk.exitInFlight && onDisk.exitInFlight.kind === 'manual' && onDisk.exitInFlight.outcome === 'sending' && onDisk.exitAttempts === 1 && onDisk.flattenKind === 'manual', '2n the manual exit intent is on disk BEFORE the market order goes out');
    const keep = { pos: B.pos, orders: B.orders, history: B.history }; const b = mk(1, { stateFile: sf }); Object.assign(B, keep); B.log = []; Object.assign(b.sm, { phase: 'FLAT', stopOrderId: null, targetOrderId: null });
    const latch = await b.sm.so1HaltLatch(); const rr = await b.sm.restoreFromState(B.pos);
    ok(latch.latched === false && rr.ok && b.sm.flattenKind === 'manual' && b.sm.exitAttempts === 1 && stopsResting().length === 1 && markets() === 0, '2o restart, broker still long 3, history shows no order: no order at startup; trade restored with its stop, flattenKind manual kept for the driver, 1 attempt used');
    B.marketMode = 'accept'; const r3 = await b.sm.sessionFlatten('manual flatten (continuing)', 'manual');
    ok(r3 === 'sent' && net() === 0 && markets() === 1, '2p the driver then finishes the flatten after the restart'); }

  // ---- 3. through-stop exit on the rule
  const ts = (x) => { Object.assign(x.sm, { phase: 'PENDING_ENTRY', intendedEntryPrice: 20040, stopPriceIntended: 20020, fillHandled: true, targetOrderId: null, stopOrderId: null }); B.orders = []; };
  { const x = mk(1); ts(x); B.marketMode = 'reject';
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });
    const m1 = markets(), st1 = stopsResting().length;
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });           // 2nd send (backoff after the 1st = 0)
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });           // inside the 10 s backoff: nothing
    const mB = markets(); x.sm.exitRetryAt = 0;
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });           // 3rd rejected: HALT
    B.marketMode = 'accept'; x.sm.exitRetryAt = 0; await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 }); await x.sm.tick();
    ok(m1 === 1 && st1 === 1 && mB === 2 && markets() === 3 && x.sm.desynced && stopsResting().length === 1 && stopsResting()[0].stopPrice === 19990 && net() === 3
      && x.notif.filter(n => /Through-stop exit FAILED 3x - FLATTEN IN TOPSTEPX NOW/.test(n)).length === 1, '3a through-stop rejected: backup stop (fill 20010 - the planned 20 pts = 19990) each time, backoff respected, K = 3 sends then HALT (was: retried every poll, no cap); no 4th order'); }
  { const x = mk(1); ts(x); B.marketMode = 'timeout-lost';
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });
    ok(markets() === 1 && stopsResting().length === 1 && x.sm.exitAttempts === 1 && !x.sm.desynced && x.codes().includes('EXIT_UNKNOWN_NOT_FILLED'), '3b through-stop lost reply, not filled (settled + history): backup stop placed AFTER the settle, attempt 1 of 3');
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 }); await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });
    ok(markets() === 3 && x.sm.desynced && stopsResting().length === 1 && net() === 3, '3c ...three unknown-then-still-open sends: HALT with the backup stop resting (was: uncapped)'); }
  { const sf = path.join(TMP, 'r11-ts.json'); try { fs.unlinkSync(sf); } catch (_) {}
    const x = mk(1, { stateFile: sf }); x.sm._stateArmed = true; ts(x); let onDisk = null; B.onMarket = () => { onDisk = JSON.parse(fs.readFileSync(sf, 'utf8')); };
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 }); B.onMarket = null;
    ok(onDisk && onDisk.exitInFlight && onDisk.exitInFlight.kind === 'through-stop' && onDisk.exitAttempts === 1 && x.sm.phase === 'FLATTENING', '3d through-stop exit intent on disk before the send (restart runs the same settle)');
    const keep = { pos: { size: 3, type: 1, averagePrice: 20010 }, orders: [], history: [] }; const b = mk(1, { stateFile: sf }); Object.assign(B, keep); B.log = []; b.sm.phase = 'FLAT';
    fs.writeFileSync(sf, JSON.stringify({ ...onDisk }));
    const latch = await b.sm.so1HaltLatch();
    ok(latch.latched === true && markets() === 0 && B.orders.length === 0, '3e restart: through-stop exit in flight, broker still long 3 -> HALT at startup (no order; Mac flattens) :: ' + (latch.why || '').slice(0, 120)); }
  { const x = mk(1); ts(x); B.marketMode = 'timeout-accepted';
    await x.sm._exitFilledThroughStop(3, 20010, { delta: -30 });
    ok(net() === 0 && x.sm.phase === 'FLATTENING' && rests().length === 0 && markets() === 1, '3f through-stop lost reply then flat: no backup stop, FLATTENING (unchanged)'); }

  // ---- 4. order-history field names: verified shape passes, an unrecognised shape fails safe
  { const since = Date.now() - 1000, ts0 = new Date().toISOString().replace('Z', '123+00:00');
    const docRow = { id: 36598, accountId: 704, contractId: 'C', symbolId: 'F.US.EP', creationTimestamp: ts0, updateTimestamp: ts0, status: 2, type: 2, side: 1, size: 3, limitPrice: null, stopPrice: null, fillVolume: 3, filledPrice: 20000.25, customTag: null };
    const seen = rows => safeExit.exitOrderSeen(rows, { side: 1, size: 3, since });
    ok(Number.isFinite(Date.parse(ts0)) && seen([docRow]) === 'seen' && seen([{ ...docRow, status: 3 }]) === 'none' && seen([{ ...docRow, status: 5 }]) === 'none' && seen([{ ...docRow, status: 6 }]) === 'seen' && seen([{ ...docRow, side: 0 }]) === 'none' && seen([]) === 'none',
      '4a the ProjectX doc row shape (creationTimestamp with microseconds, status/type/side ints): filled/pending = seen, cancelled/rejected/other side = none');
    ok(seen([{ ...docRow, status: undefined }]) === 'unknown' && seen([{ ...docRow, side: null }]) === 'unknown' && seen([{ id: 1, contractId: 'C', creationTimestamp: ts0, orderType: 2, orderSide: 1, orderStatus: 2 }]) === 'unknown' && seen(null) === 'unknown' && seen([{ ...docRow, type: 'MARKET' }]) === 'unknown',
      '4b a row without integer type/side/status (renamed fields, enum strings) = UNKNOWN, never "none"');
    ok(seen([{ ...docRow, status: undefined, creationTimestamp: new Date(since - 600000).toISOString() }]) === 'none', '4c ...but only rows inside the window count (an old odd row does not halt)');
    const x = mk(1); B.marketMode = 'timeout-lost'; B.onMarket = () => { B.history.push({ id: 999, type: 2, side: 1, size: 3, creationTimestamp: new Date().toISOString() }); };   // no status field
    const r = await x.sm.sessionFlatten('session close at 13:05 PT');
    ok(r === 'desynced' && markets() === 1 && net() === 3 && /could not be recognised/.test(x.sm._so1HaltWhy || ''), '4d lost reply, still long, history row without a status: HALT (not proven), no retry :: ' + x.sm._so1HaltWhy); }

  // ---- 5. one push per full stop
  { const run = async (owner, lock) => { const x = mk(1); if (owner) x.sm.fullStopPushOwner = owner; if (lock) { x.sm.profitTrail = true; x.sm.profitTrailStop = 20000; } B.pos = null; B.orders = [{ id: 12, size: 1, limitPrice: 20025, type: 1 }]; await x.sm.tick(); return x; };
    const a = await run('health', false), b = await run(null, false), c = await run('health', true);
    ok(a.sm.phase === 'FLAT' && a.notif.filter(n => /^Stopped out/.test(n)).length === 0 && a.sm.lastExit && a.sm.lastExit.kind === 'stop' && a.sm.lastExit.lockStop == null, '5a full stop with the health push wired: the machine sends NO "Stopped out" (lastExit kind stop, no lock -> the executor\'s "Full stop" push)');
    ok(b.notif.filter(n => /^Stopped out/.test(n)).length === 1, '5b not wired (tests / old callers): "Stopped out" as before (never zero pushes)');
    ok(c.notif.filter(n => /^Stopped out.*profit lock/.test(n)).length === 1 && c.sm.lastExit.lockStop === 20000, '5c a profit-lock stop (no "Full stop" push for it) keeps its "Stopped out (profit lock)" push');
    const x = mk(1); x.sm.fullStopPushOwner = 'health'; x.sm.contracts = 1; x.sm.leg1Size = 1; B.pos = null; B.orders = [{ id: 12, size: 1, limitPrice: 20025, type: 1 }]; await x.sm.tick();
    ok(x.notif.filter(n => /^Stopped out/.test(n)).length === 0 && x.sm.lastExit && x.sm.lastExit.kind === 'stop', '5d the 1-lot path (_closeWholeLeg1) too');
    const pushes = []; const h = HA.createHealthAlerts({ notify: (t, b) => pushes.push(t), log: () => {}, label: '' });
    h.fullStop({ key: 'J1', dir: 1, qty: 3, entry: 20010, exit: 19980 }); h.fullStop({ key: 'J1', dir: 1, qty: 3, entry: 20010, exit: 19980 }); try { h.stop && h.stop(); } catch (e) { /* timers */ }
    ok(pushes.length === 1 && /^Full stop: LONG 3x/.test(pushes[0]), '5e the executor push: exactly one "Full stop" per trade');
    ok(/if \(stateMachine && health\) stateMachine\.fullStopPushOwner = 'health';/.test(SRC) && /if \(lx && lx\.kind === 'stop' && lx\.lockStop == null\) \{ const jid/.test(SRC) && !/lx\.lockStop == null && trendLife && trendLife\.filled/.test(SRC), '5f executor: the owner is wired at construction; the "Full stop" push fires for every full stop (no trendLife condition that could drop it after a restart)'); }

  // ---- 6. entry-cancel phone requests age out at 60 s
  { const dir = path.join(TMP, 'ecr'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    let t = 1_800_000_000_000; const clock = () => t;
    const st = ECR.store(dir, 'MNQ', { now: clock });
    const tgt = n => ({ accountId: 1, contractId: 'CON.F.US.MNQ.Z26', orderId: String(n), entryIdentity: '123e4567-e89b-12d3-a456-42661417400' + n });
    const calls = [], reports = []; const machine = { cancelEntryRequest: async tg => { calls.push(tg.orderId); return { outcome: 'cancelled', detail: 'ok' }; } };
    const r1 = st.enqueue(tgt(1)); t += 61000; await st.process(machine, r => reports.push(r));
    const rd = st.read(r1.requestId);
    ok(calls.length === 0 && rd.outcome === 'stale' && /STALE: written 61 s ago/.test(rd.detail) && reports.length === 1 && JSON.stringify(PR.cancelResult(rd).slice(0, 1)) === '["STALE"]', '6a a cancel request not picked up within 60 s: never acted on (no broker call), closed STALE, acked STALE');
    await st.process(machine, r => reports.push(r));
    ok(calls.length === 0 && reports.length === 1, '6b a stale request stays closed on later polls');
    const r2 = st.enqueue(tgt(2)); t += 30000; await st.process(machine, r => reports.push(r));
    ok(calls.length === 1 && calls[0] === '2' && st.read(r2.requestId).outcome === 'cancelled', '6c a fresh request (30 s) is unchanged: acted on once');
    const r3 = st.enqueue(tgt(1)); await st.process(machine, r => reports.push(r));
    ok(r3.outcome === 'requested' && r3.revision === 2 && calls.length === 2 && st.read(r1.requestId).outcome === 'cancelled', '6d a new tap for the same entry after a stale one queues a fresh request and is acted on');
    const um = { cancelEntryRequest: async () => ({ outcome: 'unknown', detail: 'tracking retained' }) };
    const r4 = st.enqueue(tgt(4)); await st.process(um); t += 120000; let n4 = 0; await st.process({ cancelEntryRequest: async () => { n4++; return { outcome: 'cancelled', detail: 'later' }; } });
    ok(n4 === 1 && st.read(r4.requestId).outcome === 'cancelled', '6e a request picked up in time (outcome unknown, tracking retained) is NOT aged out: still followed up');
    const pr = PR.createPhoneRequests({ dir, symbol: 'MNQ' }); ok(pr.pendingNew() === false, '6f a stale request does not wake the fast poll'); }

  // ---- 7. the flatten acks
  { const f = a => PR.flattenResult(a);
    ok(f({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'FLATTENING', result: 'sent' })[1] === "market exit sent through the bot's flatten path (phase now FLATTENING)" && f({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'FLATTENING' })[1] === "market exit sent through the bot's flatten path (phase now FLATTENING)"
      && f({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'LEG1_OPEN', result: 'retry' })[0] === 'APPLIED' && /retried every poll until flat or halt/.test(f({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'LEG1_OPEN', result: 'retry' })[1])
      && f({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'LEG1_OPEN', result: 'desynced' })[0] === 'REJECTED' && /HALTED/.test(f({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'LEG1_OPEN', result: 'desynced' })[1]),
      '7a flatten acks: sent (unchanged text), retry (under way, retried every poll), desynced (REJECTED HALTED: flatten in TopstepX)');
    ok(/const flatRes = await stateMachine\.flattenNow\(\);/.test(SRC) && /flattenResult\(\{ live: true, phaseBefore: flatPh0, phaseAfter: stateMachine\.phase, result: flatRes \}\)/.test(SRC)
      && /if \(LIVE && !flatRq && stateMachine\.flattenKind === 'manual' && stateMachine\.phase !== 'FLAT' && stateMachine\.phase !== 'PENDING_ENTRY' && !stateMachine\.desynced\)/.test(SRC)
      && /flattenNow\(\{ what: 'daily-floor'/.test(SRC) && /flattenNow\(\{ what: 'time-stop'/.test(SRC), '7b executor: the ack carries the result; an unfinished manual flatten is driven every poll (never on a halted bot); daily floor / time stop labelled'); }

  console.log(`\nr1.1 tests: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e.stack); process.exit(2); });
