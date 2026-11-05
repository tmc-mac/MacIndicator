'use strict';
// OFFLINE CANDIDATE de161d8-r0, NOT DEPLOYMENT-CLEARED. Requires an independently verified
// reducing-order/native-amend/tag-history adapter; the delivered adapter is refused.
// No provider capability is established by this file or by the simulation tests.
// tideLive r1.1 (TIDE Stage 2a LIVE, MacLive 11/04; from MacMoney's r1 draft): runs ONE TIDE position at a time through lib/tideOrders.js (the pure planner
// r1.2) and executes its intents with the executor's own broker primitives (lib/liveOrders.js: placeOrder / cancelOrder / getOpenPosition / getOpenOrders /
// getEntryOrder), with the same request bodies the state machine sends. Used ONLY with tide.mode "live" (armed by tools/set-tide.sh live).
// OWNERSHIP (MAP.md ruling 1): the state machine never holds a TIDE position. It stays FLAT, so its own post-fill bracket path (stop / targets / BE / trail /
// lock / adoption) cannot act on it. The `guard` intent is persisted here (state file) and the executor asks owned() before EVERY old-path entry (takeEntry),
// before adopting an unknown broker position (reconcileIfUnknownPosition) and in TIDE's own flat gate.
// Executor switches (MAP.md): stops are never widened (no widen path exists here: a reject goes back to the planner, which retries the SAME price once or
// flattens); every stop ack requires actual broker price/side/remaining-quantity evidence. Missing readback stays unknown. Under the verified
// candidate contract, stop amendments keep one broker ID and reducing market exits keep the protective stop resting until confirmed flat.
// Stage 2a scope: entry + one stop + TP1 2/3 + BE + TP2 + the R-ladder / climax + the planner's flatten. No pyramid add (ADD_WOULD_FIRE is journaled only),
// no resting half (tideOrders.configProblem refuses entryByGrade). NO daily loss limit, no timed exits. The session close / daily floor reach this position
// through exitAtMarket() (the planner's flatten, one per position).
// Every call is serialized (one at a time): the background TIDE step (signal) and the main loop (poll / exit) never interleave on the state.
const fs = require('fs');
const path = require('path');
const T = require('./tideOrders');
const T_MONEY = require('./moneyRule');
const VERSION = 'tide-live-candidate-de161d8-r0';
const MAX_STEPS = 200;              // one call never runs away (the planner is bounded; this is a second fence)
const ENTRY_EXPIRE_MS = 30 * 60000; // a LIMIT entry with nothing filled after 30 min is cancelled (the planner's exit lifecycle clears it)
const MARKET_FILL_READS = 4, MARKET_FILL_WAIT_MS = 400;   // a market order's fill is read back at once (the stop goes out in the same pass)
const isNum = v => typeof v === 'number' && Number.isFinite(v);
// [r1.5.2] broker-state READS: 4 tries at 0 / 400 / 1200 / 2500 ms from the first, each with its own timeout (a reset keep-alive socket fails one call:
// "fetch failed", cause ECONNRESET; the next call on a fresh socket works)
const READ_AT_MS = [0, 400, 1200, 2500], READ_TIMEOUT_MS = 3000;
const errText = e => { const c = e && e.cause; return `${e && e.message}${c ? ` (${[c.code, c.message].filter(Boolean).join(' ')})` : ''}`; };
const DONE_PHASES = new Set(['FLAT', 'DONE']);
// [r1.1] pushes (Mac: "we def want our notifications during the trade"): EVERY in-trade event is pushed at INFO (priority default: the bot's notify budget counts
// them): each fill, the stop placed (with the full plan), TP1 -> BE, each stop move, the exit with $ and R. CRITICAL (urgent) = real safety only.
const INFO = { priority: 'default', tags: 'chart_with_upwards_trend' }, CRIT = { priority: 'urgent', tags: 'rotating_light' };
const SAFETY = new Set(['no-stop', 'naked-retry', 'naked-open', 'position-reversed', 'over-close', 'flatten-rejected', 'flatten-stalled', 'flatten-continue', 'stop-cancel-failed', 'stop-crossed', 'stop-looser', 'stop-cancelled', 'stop-rejected', 'stop-price-unknown']);

function create(o) {
  const { token, accountId, contractId, orders, cfgFn, log = () => {}, notify = () => {}, journal = () => {}, stateFile, now = () => Date.now(),
    sleep = ms => new Promise(r => setTimeout(r, ms)), onEnd = () => {}, onTp1 = () => {} } = o;
  const { OrderType, OrderSide, placeOrder, cancelOrder, getOpenPosition, getOpenOrders, getEntryOrder, amendStop, lookupByTag } = orders;
  function contractProblem() { const c = orders.safetyContract; return !c || c.version !== 'tide-safety-r1' || !['reduceOnlyAtExecution','atomicStopAmend','uniqueClientTag','terminalLookupByTag'].every(k => c[k] === true) || typeof amendStop !== 'function' || typeof lookupByTag !== 'function' ? 'reviewed provider execution contract unavailable: entries refused' : null; }
  const tokenOf = () => (typeof token === 'function' ? token() : token);
  let S = load();
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  function blank() { return { version: VERSION, pos: null, ids: {}, sentAt: {}, ev: 0, best: null, fillAt: null, closedAt: null, takeId: null, endTold: false, tp1Told: false, lastPx: null, guard: null, staleStop: null, pushed: {}, dispatch: {}, fillOffsets: {}, loadIncident: null, generation: 0 }; }
  function record(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function savedStateProblem(d) {
    if (!record(d)) return 'saved state is not an object';
    if (d.version !== VERSION) return 'saved driver version requires explicit migration';
    for (const [key,value] of Object.entries(blank())) {
      if (!Object.prototype.hasOwnProperty.call(d,key)) return `saved state missing ${key}`;
      if (value !== null && (typeof value === 'object' ? !record(d[key]) : typeof d[key] !== typeof value)) return `saved state invalid ${key}`;
    }
    if (d.loadIncident !== null && typeof d.loadIncident !== 'string') return 'saved incident invalid';
    for (const key of ['ids', 'sentAt', 'pushed', 'dispatch', 'fillOffsets']) if (!record(d[key])) return `saved state invalid ${key}`;
    for (const key of ['ev', 'generation']) if (!Number.isSafeInteger(d[key]) || d[key] < 0) return `saved state invalid ${key}`;
    if (Object.values(d.ids).some(x => !(typeof x === 'string' && x.length || Number.isSafeInteger(x) && x > 0))) return 'saved order IDs invalid';
    if (Object.values(d.sentAt).some(x => !isNum(x))) return 'saved dispatch times invalid';
    if (Object.entries(d.dispatch).some(([k,x]) => !record(x) || !['unknown','accepted','terminal'].includes(x.status) || !record(x.body) || x.cancelEvidence !== undefined && (!record(x.cancelEvidence) || x.cancelEvidence.type !== 'cancel-ack' || x.cancelEvidence.key !== k || x.cancelEvidence.filledQty !== undefined && (!Number.isSafeInteger(x.cancelEvidence.filledQty) || x.cancelEvidence.filledQty < 0 || !isNum(x.cancelEvidence.avgPx) || x.cancelEvidence.avgPx <= 0)))) return 'saved dispatch record invalid';
    if (Object.values(d.fillOffsets).some(x => !record(x) || !Number.isSafeInteger(x.qty) || x.qty < 0 || !isNum(x.value))) return 'saved fill offsets invalid';
    if (d.hist !== undefined && (!record(d.hist) || typeof d.hist.day !== 'string' || !Array.isArray(d.hist.trades) || !Array.isArray(d.hist.alerts) || d.hist.orderIds !== undefined && !Array.isArray(d.hist.orderIds))) return 'saved history invalid';
    if (d.pendingInitialStop !== undefined && (!record(d.pendingInitialStop) || d.pendingInitialStop.op !== 'place' || d.pendingInitialStop.kind !== 'stop' || typeof d.pendingInitialStop.key !== 'string' || !Number.isSafeInteger(d.pendingInitialStop.qty) || d.pendingInitialStop.qty <= 0 || !isNum(d.pendingInitialStop.price) || !['BUY','SELL'].includes(d.pendingInitialStop.side))) return 'saved pending initial stop invalid';
    const p = d.pos;
    if (p === null) return ['dispatch','ids','sentAt','fillOffsets'].some(k => Object.keys(d[k]).length) || d.guard != null ? 'saved ownership missing position' : null;
    if (d.pendingInitialStop && (!p || !p.orders || !p.orders[d.pendingInitialStop.key])) return 'saved pending stop ownership invalid';
    if (!record(p) || typeof p.id !== 'string' || !p.id || p.version !== T.VERSION) return 'saved planner identity invalid';
    const shape = T.initState(p.id);
    for (const [key,value] of Object.entries(shape)) {
      if (!Object.prototype.hasOwnProperty.call(p,key)) return `saved planner missing ${key}`;
      if (Array.isArray(value) ? !Array.isArray(p[key]) : value !== null && (typeof value === 'object' ? !record(p[key]) : typeof p[key] !== typeof value)) return `saved planner invalid ${key}`;
    }
    if (!['FLAT','PENDING','OPEN','CLEANUP','CLOSING','REVERSED','DONE'].includes(p.phase)) return 'saved planner phase invalid';
    for (const key of ['flat','stopRetry','stopFailed','addPending']) if (p[key] !== null && !record(p[key])) return `saved planner invalid ${key}`;
    for (const key of ['stopKey','stopNext','block','grade']) if (p[key] !== null && typeof p[key] !== 'string') return `saved planner invalid ${key}`;
    if (p.flat && (!['clearing','cancel-stop','reading','sent','confirming','reprotect','stalled','cancel-failed','rejected','flat-unresolved','done','reversed'].includes(p.flat.phase) || !Array.isArray(p.flat.orderKeys) || !Array.isArray(p.flat.exits))) return 'saved exit lifecycle invalid';
    if (!Number.isSafeInteger(p.open) || p.open < 0 || !Number.isSafeInteger(p.seq) || p.seq < 0) return 'saved planner quantities invalid';
    if (p.plan !== null && (!record(p.plan) || ![1,-1].includes(p.dir) || !Number.isSafeInteger(p.plan.contracts) || p.plan.contracts <= 0 || !isNum(p.plan.stop))) return 'saved plan invalid';
    if (p.plan === null && (p.open !== 0 || Object.keys(p.orders).length || ['dispatch','ids','sentAt','fillOffsets'].some(k => Object.keys(d[k]).length) || d.guard != null)) return 'saved orders without plan';
    if (['dispatch','ids','sentAt','fillOffsets'].some(k => Object.keys(d[k]).some(id => !Object.prototype.hasOwnProperty.call(p.orders,id)))) return 'saved order ownership is inconsistent';
    if (Object.entries(p.orders).some(([key,x]) => !record(x) || x.key !== key || !['entry','add','stop','tp1','tp2','position'].includes(x.kind) || !['BUY','SELL'].includes(x.side) || !['MARKET','LIMIT','STOP'].includes(x.orderType) || !['sent','working','unknown','cancel-sent','done','cancelled','rejected','superseded'].includes(x.status) || !Number.isSafeInteger(x.qty) || x.qty < 0 || !Number.isSafeInteger(x.filled) || x.filled < 0 || x.filled > x.qty)) return 'saved order record invalid';
    if (Object.entries(d.dispatch).some(([key,x]) => x.cancelEvidence && x.cancelEvidence.filledQty !== undefined && x.cancelEvidence.filledQty > p.orders[key].qty)) return 'saved cancellation fill exceeds quantity';
    for (const key of ['stopKey','stopNext']) if (p[key] !== null && (!Object.prototype.hasOwnProperty.call(p.orders,p[key]) || p.orders[p[key]].kind !== 'stop')) return 'saved stop reference invalid';
    if (DONE_PHASES.has(p.phase) && (p.open !== 0 || Object.values(p.orders).some(x => ['sent','working','unknown','cancel-sent'].includes(x.status)))) return 'saved terminal phase still owns exposure';
    if (p.phase === 'FLAT' && p.plan !== null) return 'saved flat phase has a plan';
    return null;
  }
  function load() {
    try { if (stateFile && fs.existsSync(stateFile)) {
      const d = JSON.parse(fs.readFileSync(stateFile, 'utf8')), problem = savedStateProblem(d);
      // Do not merge untrusted/foreign state into runtime objects. Keep the disk
      // evidence byte-for-byte and retain ownership until explicit recovery.
      return problem ? { ...blank(), loadIncident: `${problem}; no orders sent` } : { ...blank(), ...d };
    } }
    catch (e) { return { ...blank(), loadIncident: 'unreadable saved state; no orders sent' }; }
    return blank();
  }
  function save() {
    if (!stateFile) throw new Error('durable stateFile is required before any broker action');
    const tmp = `${stateFile}.tmp-${process.pid}`, fd=fs.openSync(tmp,'w');
    try {fs.writeFileSync(fd,JSON.stringify(S));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(tmp,stateFile);const dirfd=fs.openSync(path.dirname(stateFile),'r');try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
  }
  const ctx = () => ({ cfg: cfgFn(), executionSafetyContract: contractProblem() ? null : 'tide-safety-r1' });
  function owned() { return !!(S.loadIncident || S.pos && S.pos.plan && (!DONE_PHASES.has(S.pos.phase) || Object.values(S.dispatch || {}).some(x => x.status === 'unknown' || x.cancelEvidence))); }   // a TIDE position exists (pending, open, closing, reversed)
  function phase() { return S.loadIncident ? 'BLOCKED_STATE' : S.pos ? S.pos.phase : 'FLAT'; }
  const J = (what, data) => { try { journal({ type: 'lv_tide', phase: 'live_' + what, version: VERSION, t: now(), position: S.pos ? S.pos.id : null, take: S.takeId, ...data }); } catch (e) { /* journal only */ } };
  const P = (key, title, text, opts = { priority: 'high', tags: 'chart_with_upwards_trend' }) => { if (key && S.pushed[key]) return; if (key) S.pushed[key] = true; try { notify(title, text, opts); } catch (e) { /* push only */ } };

  // ---- one planner step per event, then every intent executed in order; results come back as events (a queue, bounded)
  async function run(firstEvent) {
    const q = [firstEvent]; let steps = 0;
    while (q.length) {
      if (++steps > MAX_STEPS) { log('  [tide-live] CRITICAL: the event loop did not settle (200 steps) - stopping this pass; the next poll continues.'); P(null, 'TIDE URGENT: loop fence', 'The TIDE order loop hit its fence. Check the account.', CRIT); break; }
      let ev = q.shift(); if (ev.type === 'cancel-ack' && S.dispatch[ev.key] && S.dispatch[ev.key].cancelEvidence) ev = S.dispatch[ev.key].cancelEvidence;
      if (ev.id == null) ev.id = `${S.pos.id}:ev:${++S.ev}`;
      const r = T.plan(S.pos, ev, ctx()); S.pos = r.state;
      const initialStop = r.intents.find(i => i.op === 'place' && i.kind === 'stop' && !S.pos.stopKey);
      if (initialStop) S.pendingInitialStop = initialStop;
      if (ev.type === 'cancel-ack' && S.dispatch[ev.key]) delete S.dispatch[ev.key].cancelEvidence; save();
      if (r.intents.length || (ev.type !== 'ladder' && ev.type !== 'tp1-traded')) J('step', { event: brief(ev), intents: r.intents.map(i => ({ op: i.op, kind: i.kind, qty: i.qty, price: i.price, key: i.key, code: i.code })), notes: r.notes, statePhase: r.state.phase });
      for (const it of r.intents) { const back = await exec(it); if (S.pendingInitialStop && S.pendingInitialStop.key === it.key) delete S.pendingInitialStop; q.push(...back); save(); }
    }
    afterRun();
  }
  function afterRun() {
    const p = S.pos; if (!p) return;
    if (p.tp1Done && !S.tp1Told) { S.tp1Told = true; save(); try { onTp1(S.takeId); } catch (e) { /* feedback only */ } P(`tp1:${p.id}`, 'TIDE TP1', `TP1 ${p.tp1Qty ? p.tp1Qty + 'x @ ' + p.tp1Px : '(1 lot) ' + p.tp1Px + ' traded'}: stop -> break-even + 1 tick; ${p.open}x running to TP2 ${p.tp2Px}.`, INFO); }
    if (DONE_PHASES.has(p.phase) && p.plan && !S.endTold) {
      S.endTold = true; S.closedAt = now(); save();
      const rz = p.flat && p.flat.realized, ex = exitsOf(p), stopped = !p.tp1Done && ex.stop > 0 && !(ex.tp1 || ex.tp2 || ex.position);
      const filled = Object.values(p.orders).some(x => x.kind === 'entry' && x.filled > 0);
      const txt = filled ? `exit ${Object.entries(ex).map(([k, v]) => `${k} ${v}x`).join(', ') || '(no closing fill seen)'}${rz && rz.qty ? ` avg ${round(rz.avgPx)}` : ''}` : 'the entry never filled (cancelled)';
      log(`  [tide-live] position ${p.id} ${p.phase}: ${txt}.`);
      J('end', { exits: ex, realized: rz || null, tp1Done: p.tp1Done, stopped, entryFilled: filled });
      const res = filled ? result(p) : null; if (res) J('result', res);
      if (res) { const e1 = Object.values(p.orders).filter(x => x.kind === 'entry' && x.filled > 0), xs = Object.values(p.orders).filter(x => x.kind !== 'entry' && x.kind !== 'add' && x.filled > 0 && isNum(x.avgPx)), xq = xs.reduce((a, x) => a + x.filled, 0);
        hist().trades.push({ id: p.id, setup: S.setup || null, signalId: S.takeId, dir: p.dir, grade: p.grade, points: S.points ?? null, pointNames: S.pointNames || null, qty: res.qty, avgEntry: res.entry, openedAt: S.fillAt, closedAt: S.closedAt,
          exitPath: exitPath(p, ex), exitAvgPx: xq ? round(xs.reduce((a, x) => a + x.avgPx * x.filled, 0) / xq) : null, resultR: res.r, netUsd: null, grossUsd: res.usd, path: res.path }); while (hist().trades.length > 40) hist().trades.shift(); save(); }
      P(`end:${p.id}`, filled ? 'TIDE EXIT' : 'TIDE entry cancelled', filled ? `${p.dir === 1 ? 'LONG' : 'SHORT'} ${res.qty} MNQ: ${res.usd >= 0 ? '+' : ''}$${res.usd} (${res.r >= 0 ? '+' : ''}${res.r}R) | ${res.path}. Flat.` : 'The TIDE entry never filled: cancelled. Flat.', { ...INFO, tags: 'checkered_flag' });
      try { onEnd(S.takeId, { closed: true, tp1Done: p.tp1Done, stopped, why: filled ? 'live-exit' : 'entry-not-filled' }); } catch (e) { /* feedback only */ }
    }
  }
  function result(p) {   // the realized result from the fills: $ (MNQ point value), R (vs the initial risk at the structural stop), the exit path
    const pv = (cfgFn() || {}).pointValue || 2, ent = T.avgEntry(p), q = Object.values(p.orders).filter(x => x.kind === 'entry' && x.filled > 0).reduce((a, x) => a + x.filled, 0);
    const ex = Object.values(p.orders).filter(x => x.kind !== 'entry' && x.kind !== 'add' && x.filled > 0 && isNum(x.avgPx));
    const usd = Math.round(ex.reduce((a, x) => a + p.dir * (x.avgPx - ent) * x.filled * pv, 0) * 100) / 100, risk = Math.abs(ent - p.plan.stop) * q * pv;
    return { qty: q, entry: round(ent), usd, r: risk > 0 ? Math.round(usd / risk * 100) / 100 : null, path: ex.map(x => `${x.kind === 'position' ? 'market' : x.kind} ${x.filled}x @ ${round(x.avgPx)}`).join(', ') || 'no closing fill seen' };
  }
  function hist() { const d = dayOf(now()); if (!S.hist || S.hist.day !== d) S.hist = { day: d, trades: [], alerts: [] }; return S.hist; }
  function rememberOrderId(id) { const hi = hist(), value = String(id); hi.orderIds = hi.orderIds || [];
    if (hi.orderIds.includes(value)) return false; hi.orderIds.push(value); while (hi.orderIds.length > 400) hi.orderIds.shift(); return true; }
  function verifiedStopFeedback(key, price, qty, amended) {
    const p = S.pos; if (!p || !p.plan) return;
    if (amended) {
      const ent = T.avgEntry(p), lockR = isNum(ent) && isNum(p.R) && p.R > 0 ? p.dir * (price - ent) / p.R : null;
      S.stopBy = isNum(lockR) && lockR > 0.01 ? 'ladder' : p.tp1Done ? 'break-even' : 'structural';
      P(`stop:${key}`, 'TIDE stop moved', `Stop now ${price} for ${qty}x (native same-order amendment)${isNum(lockR) ? ` = ${lockR >= 0 ? '+' : ''}${Math.round(lockR * 100) / 100}R locked` : ''}.`, { ...INFO, tags: 'shield' });
    } else if (S.entryPushed) P(`stopplace:${key}`, 'TIDE stop placed', `Stop ${price} for ${qty}x (protective, never widened).`, { ...INFO, tags: 'shield' });
    else { const e1 = Object.values(p.orders).find(x => x.kind === 'entry' && x.filled > 0); if (e1) { S.entryPushed = true;
      P(`entrypush:${p.id}`, `TIDE ENTRY ${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.grade}`, `${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.grade} ${qty} MNQ @ ${round(e1.avgPx)} | stop ${price} (${p.plan.stopPts} pts, risk $${Math.round(Math.abs(e1.avgPx - price) * qty * ((cfgFn() || {}).pointValue || 2))}) | TP1 ${p.tp1Px}${p.tp1Qty ? ' (' + p.tp1Qty + 'x)' : ' (1 lot: BE trigger)'} | TP2 ${p.tp2Px}${p.plan.sizeCode === 'NO_FIT_TAKE1' ? ' | take1: 1 MNQ over budget' : ''}`, INFO); } }
    save();
  }
  function dayOf(t) { return new Date(t + 9 * 3600000).toISOString().slice(0, 10); }   // the TradeDay starts 15:00 PT (= 23:00 UTC in PST): +9 h -> the UTC date of the session's end
  function exitPath(p, ex) { const r = (p.flat && p.flat.reason) || ''; if (ex.tp2) return p.tp1Done && ex.tp1 ? 'tp2' : 'tp2'; if (/session close/.test(r)) return 'session-flatten'; if (/naked|no-stop/.test(r)) return 'no-stop-flatten'; if (/manual/.test(r)) return 'manual';
    if (/ladder/.test(r)) return 'ladder'; if (ex.stop) return p.tp1Done ? (isNum(p.protPx) && isNum(T.avgEntry(p)) && p.dir * (p.protPx - T.avgEntry(p)) > 0.5 ? 'ladder' : 'tp1-be') : 'stop'; if (ex.position || ex.market) return 'market'; return 'unknown'; }
  function exitsOf(p) { const ex = {}; for (const x of Object.values(p.orders)) if (x.kind !== 'entry' && x.kind !== 'add' && x.filled > 0) ex[x.kind === 'position' ? 'market' : x.kind] = (ex[x.kind === 'position' ? 'market' : x.kind] || 0) + x.filled; return ex; }
  const round = x => (isNum(x) ? Math.round(x * 100) / 100 : x);
  function brief(ev) { const { orders: os, ...rest } = ev; return os ? { ...rest, orders: os.length } : rest; }

  // ---- intents -> the broker (MAP.md rows)
  const sideNum = s => (s === 'BUY' ? OrderSide.BUY : OrderSide.SELL);
  const base = () => ({ accountId, contractId });
  // [r1.5.2] fn() retried at READ_AT_MS (each try raced against READ_TIMEOUT_MS); every failed try is logged; after the last one: the error, tagged tries = 4
  async function readRetry(what, fn) {
    let last = null, waited = 0;
    for (let i = 0; i < READ_AT_MS.length; i++) {
      if (READ_AT_MS[i] > waited) { await sleep(READ_AT_MS[i] - waited); waited = READ_AT_MS[i]; }
      let to = null;
      try { const v = await Promise.race([fn(), new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`timed out after ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS); if (to.unref) to.unref(); })]); clearTimeout(to); if (i > 0) { log(`  [tide-live] ${what}: read OK on try ${i + 1}.`); J('read_retry_ok', { what, tries: i + 1 }); } return v; }
      catch (e) { clearTimeout(to); last = e; log(`  [tide-live] ${what}: broker read failed (try ${i + 1} of ${READ_AT_MS.length}): ${errText(e)}.`); }
    }
    J('read_failed', { what, tries: READ_AT_MS.length, error: errText(last) });
    if (S.pos && S.pos.open > 0) P(`unreadable:${S.pos.id}:${Math.floor(now() / 300000)}`, 'TIDE URGENT: broker unreadable', `${what}: the broker was unreadable after ${READ_AT_MS.length} tries (${errText(last)}) with ${S.pos.open}x open. TIDE retries every poll; check the stop in TopstepX.`, CRIT);
    const e = new Error(`${last && last.message} - broker unreadable after ${READ_AT_MS.length} tries`); e.cause = last && last.cause; e.last = last; e.tries = READ_AT_MS.length; throw e;
  }
  const posSize = async () => { const p = await readRetry('position read', () => getOpenPosition(tokenOf(), accountId, contractId)); return p ? p.size : 0; };
  async function cancelVerified(orderId) {
    for(let i=0;i<3;i++) {
      try {await cancelOrder(tokenOf(),accountId,orderId);} catch(e) {}
      try { const h=await getEntryOrder(tokenOf(),accountId,contractId,orderId,0); if(h && String(h.id)===String(orderId) && String(h.accountId)===String(accountId) && h.contractId===contractId && [2,3,4].includes(h.status) && Number.isSafeInteger(h.fillVolume) && h.fillVolume>=0) return h; } catch(e) {}
    }
    return false;
  }
  function req(it, body, extra = {}) { J('order', { key: it.key, op: it.op, kind: it.kind, side: it.side, qty: body.size, type: body.type, limitPrice: body.limitPrice ?? null, stopPrice: body.stopPrice ?? null, ...extra }); }
  async function placed(it, body) {
    if (it.kind === 'stop' && S.osPoll != null && S.osPoll === S.pollN) { if (S.osSent === S.pollN) { J('order_held', { key: it.key, why: 'stop oversized: one re-size try per poll' }); return [{ type: 'reject', key: it.key, reason: 'one re-size try per poll (stop oversized, e.g. a news lock)', lastPx: S.lastPx }]; } S.osSent = S.pollN; }
    body = { ...body, customTag: it.key, ...(it.kind === 'entry' ? {} : { reduceOnly: true }) };
    if (S.dispatch[it.key]) return [{type:'no-ack',key:it.key,reason:'durable dispatch already exists; never resent'}];
    S.dispatch[it.key] = { status: 'unknown', kind: it.kind, body }; save(); // durable BEFORE transport
    req(it, body);
    try {
      const d = await placeOrder(tokenOf(), body); const id = d && (d.orderId ?? d.id);
      if (!d || d.success !== true) { if(id!=null)S.ids[it.key]=id;S.needReconcile=true;save();return [{type:'no-ack',key:it.key,reason:'placement acceptance not explicitly verified'}]; }
      if (id == null) { S.needReconcile = true; save(); return [{ type: 'no-ack', key: it.key, reason: 'no order id' }]; }
      S.ids[it.key] = id; S.sentAt[it.key] = now(); S.dispatch[it.key].status = 'accepted'; rememberOrderId(id); save();
      if (it.kind !== 'stop') return [{ type: 'ack', key: it.key }];
      // ruling 4: the broker-ACKED level = the stop price the broker shows resting for this order id
      let r = null;
      try { const os = await getOpenOrders(tokenOf(), accountId, contractId); r = os.find(x => String(x.id) === String(id)); } catch (e) {}
      if (!r || !isNum(r.stopPrice) || r.side !== body.side || r.size !== body.size) { S.needReconcile = true; save(); J('stop_ack_unknown', {key:it.key,orderId:id}); return [{type:'no-ack',key:it.key,reason:'stop price/side/remaining quantity not verified'}]; }
      J('stop_ack', { key: it.key, orderId: id, sent: body.stopPrice, acked: r.stopPrice, source: 'broker' });
      return [{ type: 'ack', key: it.key, price: r.stopPrice }];
    } catch (e) {
      if (e.orderRejected === true) S.dispatch[it.key].status = 'terminal';
      J('order_fail', { key: it.key, rejected: e.orderRejected === true, reason: e.message }); if (e.orderRejected !== true) { S.needReconcile = true; save(); }   // no answer: a keyless reconcile on the next poll
      return e.orderRejected === true ? [{ type: 'reject', key: it.key, reason: e.message, lastPx: S.lastPx }] : [{ type: 'no-ack', key: it.key, reason: e.message }];
    }
  }
  async function exec(it) {
    try {
      if (it.op === 'guard') { S.guard = it.position; save(); log(`  [tide-live] guard: position ${it.position} is planner-owned (the state machine's own post-fill path, adoption and every old-path entry are refused).`); J('guard', { position: it.position, reason: it.reason }); return []; }
      if (it.op === 'alert') { log(`  [tide-live] ALERT ${it.code}: ${it.text}`); J('alert', { code: it.code, text: it.text, level: it.level }); hist().alerts.push({ t: now(), code: it.code, level: it.level || null, text: it.text }); while (hist().alerts.length > 20) hist().alerts.shift(); if (SAFETY.has(it.code)) P(`alert:${it.code}:${S.pos ? S.pos.stopPx : ''}`, `TIDE URGENT: ${it.code}`, it.text, CRIT); return []; }   // once per code and stop level (no repeat each poll in a news lock)   // [r1.1] non-safety alerts: journal + log only
      if (it.op === 'place' && it.kind === 'entry') {
        const type = it.orderType === 'MARKET' ? OrderType.MARKET : it.orderType === 'STOP' ? OrderType.STOP : OrderType.LIMIT;
        const body = { ...base(), type, side: sideNum(it.side), size: it.qty, ...(type === OrderType.LIMIT ? { limitPrice: it.price } : type === OrderType.STOP ? { stopPrice: it.price } : {}) };
        log(`  [LIVE ORDER] TIDE entry: ${it.side} ${it.qty}x ${it.orderType}${type === OrderType.MARKET ? '' : ' @ ' + it.price} (${it.key})`);
        const back = await placed(it, body);
        if (back[0].type === 'ack' && type === OrderType.MARKET) {   // a market order fills at once: read it back so the stop goes out in the same pass
          for (let i = 0; i < MARKET_FILL_READS; i++) { const h = await history(it.key, { quiet: i < MARKET_FILL_READS - 1 }); if (h.length) { back.push(...h); break; } await sleep(MARKET_FILL_WAIT_MS); }
        }
        return back;
      }
      if (it.op === 'place' && it.kind === 'stop') { log(`  [LIVE ORDER] TIDE stop: ${it.side} ${it.qty}x STOP @ ${it.price} (never widened; ${it.key})`);
        const back = await placed(it, { ...base(), type: OrderType.STOP, side: sideNum(it.side), size: it.qty, stopPrice: it.price });
        if (back[0].type !== 'ack') P(null, 'TIDE URGENT: stop NOT placed', `The stop ${it.price} for ${it.qty}x was ${back[0].type} (${back[0].reason || ''}); the planner retries once at the same price or closes the position.`, CRIT);
        else verifiedStopFeedback(it.key, back[0].price, it.qty, false);
        return back; }
      if (it.op === 'place' && (it.kind === 'tp1' || it.kind === 'tp2')) {
        if ((await posSize()) !== it.expectOpen) return [{ type: 'reject', key: it.key, reason: `the position is not ${it.expectOpen}: target not sent` }];
        log(`  [LIVE ORDER] TIDE ${it.kind}: ${it.side} ${it.qty}x LIMIT @ ${it.price} (${it.key})`);
        return placed(it, { ...base(), type: OrderType.LIMIT, side: sideNum(it.side), size: it.qty, limitPrice: it.price });
      }
      if (it.op === 'place' && it.kind === 'add') { J('ADD_WOULD_FIRE', { qty: it.qty, price: it.price }); log(`  [tide-live] ADD_WOULD_FIRE ${it.qty}x @ ${it.price}: Stage 2a sends no pyramid add.`); return [{ type: 'reject', key: it.key, reason: 'Stage 2a: no pyramid add (addsEnabled false)' }]; }
      if (it.op === 'modify' && it.kind === 'stop') {
        const old = S.ids[it.replaces];
        if (old == null || contractProblem()) return [{type:'no-ack',key:it.key,reason:'native amendment identity or contract unavailable'}];
        if (S.dispatch[it.key]) return [{type:'no-ack',key:it.key,reason:'amendment outcome unresolved; never replayed'}];
        const prev = S.pos.orders[it.replaces];
        S.ids[it.key] = old; S.sentAt[it.key] = now();
        const priorOffset=S.fillOffsets[it.replaces]||{qty:0,value:0};
        S.fillOffsets[it.key] = {qty:priorOffset.qty+(prev.filled||0),value:priorOffset.value+(prev.filled||0)*(prev.avgPx||0)};
        S.dispatch[it.key] = {status:'unknown',kind:'stop',amends:it.replaces,body:{side:sideNum(it.side),size:it.qty,stopPrice:it.price}}; save();
        try {
          const d = await amendStop(tokenOf(), {...base(),orderId:old,remainingQty:it.qty,stopPrice:it.price,requestId:it.key,reduceOnly:true});
          if (!d || d.success !== true || String(d.orderId) !== String(old)) { S.needReconcile=true;save();return [{type:'no-ack',key:it.key,reason:'amendment response unverified'},{type:'order-superseded',key:it.replaces}]; }
          const os=await getOpenOrders(tokenOf(),accountId,contractId), r=os.find(x=>String(x.id)===String(old));
          if (!r || r.size!==it.qty || r.side!==sideNum(it.side) || !isNum(r.stopPrice)) {S.needReconcile=true;save();return [{type:'no-ack',key:it.key,reason:'amendment readback unverified'},{type:'order-superseded',key:it.replaces}];}
          S.dispatch[it.key].status='accepted';save();
          verifiedStopFeedback(it.key, r.stopPrice, r.size, true);
          return [{type:'ack',key:it.key,price:r.stopPrice},{type:'order-superseded',key:it.replaces}]; // logical old generation ended; no broker cancellation
        } catch(e) { if(e.orderRejected===true){S.dispatch[it.key].status='terminal';delete S.ids[it.key];save();return [{type:'reject',key:it.key,reason:e.message,lastPx:S.lastPx}];}S.needReconcile=true;save();return [{type:'no-ack',key:it.key,reason:e.message},{type:'order-superseded',key:it.replaces}]; }
      }
      if (it.op === 'modify' && (it.kind === 'tp1' || it.kind === 'tp2')) {
        const old = S.ids[it.replaces];
        if (old == null) return [{ type: 'no-ack', key: it.key, reason: 'old target identity unresolved; replacement not sent' }];
        const rec = await cancelVerified(old);
        if (!rec) return [{ type: 'reject', key: it.key, reason: 'the old target could not be cancelled' }];
        const ack = await verifiedCancelEvent(it.replaces, rec);
        if (!ack) return [{ type: 'no-ack', key: it.key, reason: 'cancel fill evidence invalid' }];
        // An intervening fill changes the position. The original request cannot
        // safely be reused; hold until a reviewed regeneration path exists.
        const message = `${it.kind} was cancelled; its replacement is not working. Check the account and manage the missing target.`;
        log(`  [tide-live] URGENT: ${message}`); J('target_missing', { kind: it.kind, key: it.key, reason: 'replacement deferred' });
        P(null, 'TIDE URGENT: target missing', message, CRIT);
        return [ack, { type: 'reject', key: it.key, reason: 'target cancelled; replacement not sent; manual intervention required' }];
      }
      if (it.op === 'cancel') {
        if (supersedingKey(it.target)) return [{type:'order-superseded',key:it.target}];
        let id = S.ids[it.target];
        if (id == null) {   // no order id: resolve exact persisted customTag through terminal history, never infer absence
          await snapshot(null);   // resolves an id-less order only by exact durable customTag
          id = S.ids[it.target];
          if (id == null) { S.needReconcile=true; save(); return [{type:'no-ack',key:it.key,reason:'id-less request remains unresolved; absence is not cancellation'}]; }   // absence is not terminal evidence
        }
        log(`  [LIVE ORDER] TIDE cancel ${it.kind} ${id} (${it.reason})`); J('cancel', { key: it.key, target: it.target, orderId: id, reason: it.reason });
        const rec = await cancelVerified(id); if (rec) { const ack = await verifiedCancelEvent(it.target, rec); return ack ? [ack] : [{ type: 'no-ack', key: it.key, reason: 'cancel fill evidence invalid' }]; }
        return [{ type: 'reject', key: it.key, reason: 'cancel not verified' }];
      }
      if (it.op === 'flatten') {   // re-read; a MARKET close of min(expectOpen, actual); NO stop cancel here (the lifecycle cancelled it, verified, before)
        const size = Math.min(it.expectOpen, await posSize());
        if (!(size > 0)) return [{ type: 'cancel-ack', key: it.key }];
        log(`  [LIVE ORDER] TIDE flatten: ${it.side} ${size}x MARKET (${it.reason})`);
        const back = await placed(it, { ...base(), type: OrderType.MARKET, side: sideNum(it.side), size });
        if (back[0].type === 'ack') {
          for (let i = 0; i < MARKET_FILL_READS; i++) { const h = await history(it.key, { quiet: i < MARKET_FILL_READS - 1 }); if (h.length) { back.push(...h); break; } await sleep(MARKET_FILL_WAIT_MS); }
          if (size < it.expectOpen && !back.some(e => e.type === 'cancel-ack')) back.push({ type: 'cancel-ack', key: it.key });
        }
        return back;
      }
      if (it.op === 'read') return [await snapshot(it.key)];
      log(`  [tide-live] unknown intent ${it.op}/${it.kind}: not executed.`); return [{ type: 'reject', key: it.key, reason: 'unknown intent' }];
    } catch (e) {
      log(`  [tide-live] ${it.op} ${it.kind} failed (${e.message}) - reported as unknown.`); S.needReconcile = true; save();
      return it.op === 'read' ? [{ type: 'reject', key: it.key, reason: e.message }] : [{ type: 'no-ack', key: it.key, reason: e.message }];
    }
  }
  // the order's history -> fill / cancel-ack / reject events (ProjectX status 1 open, 2 filled, 3 cancelled, 4 expired, 5 rejected); fills are CUMULATIVE
  function supersedingKey(key) { return Object.keys(S.dispatch||{}).find(k=>S.dispatch[k].amends===key && S.ids[k]!=null && String(S.ids[k])===String(S.ids[key])); }
  async function history(key, { quiet = false, record: supplied } = {}) {
    if (supersedingKey(key)) return [];
    const id = S.ids[key]; if (id == null) return [];
    let h; try { h = supplied || await getEntryOrder(tokenOf(), accountId, contractId, id, S.sentAt[key] || now()); } catch (e) { if (!quiet) log(`  [tide-live] order ${id} history not readable yet (${e.message}).`); return []; }
    if (!h || !Number.isSafeInteger(h.fillVolume) || h.fillVolume<0) return [];
    if (rememberOrderId(id)) save();
    const off=S.fillOffsets[key]||{qty:0,value:0}, fv=h.fillVolume-off.qty, fp=fv>0?(h.fillVolume*Number(h.filledPrice)-off.value)/fv:null;
    if(fv<0 || fv>0 && (!isNum(fp)||fp<=0)) {S.needReconcile=true;return [];}
    const out = [], o = S.pos && S.pos.orders[key];
    if([2,3,4,5].includes(h.status) && S.dispatch[key]) S.dispatch[key].status='terminal';
    if (fv > 0 && isNum(fp) && (!o || fv > (o.filled || 0))) {
      out.push({ type: o && fv < o.qty ? 'partial-fill' : 'fill', key, filledQty: fv, avgPx: fp });
      if (o && o.kind === 'entry' && S.fillAt == null) { const bt = Date.parse(h.updateTimestamp || h.creationTimestamp || ''); S.fillAt = Number.isFinite(bt) ? bt : now(); }   // [r1.2] the fill time (the broker's stamp when given)
      if (o) { const k = o.kind; log(`  [tide-live] FILL ${k} ${fv}x @ ${fp} (${key})`); J('fill', { key, kind: k, filledQty: fv, avgPx: fp });
        P(`fill:${key}:${fv}`, `TIDE ${k === 'entry' ? 'FILLED' : k === 'stop' ? 'STOPPED' : k === 'position' ? 'closed at market' : k.toUpperCase() + ' filled'}`, `${k} ${fv}x @ ${fp}.`, { ...INFO, tags: k === 'stop' ? 'x' : 'white_check_mark' }); }
    }
    if (h.status === 3 || h.status === 4 || h.status === 2 && o && fv < o.qty) out.push({ type: 'cancel-ack', key });
    if (h.status === 5) out.push({ type: 'reject', key, reason: 'rejected (history)', lastPx: S.lastPx });
    return out;
  }
  async function verifiedCancelEvent(key, h) {
    const d = S.dispatch[key], order = S.pos && S.pos.orders[key];
    if (!d || !order) return null;
    const off = S.fillOffsets[key] || { qty: 0, value: 0 }, qty = h.fillVolume - off.qty;
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > order.qty || qty < order.filled) return null;
    const events = await history(key, { quiet: true, record: h });
    const fill = events.find(x => x.type === 'fill' || x.type === 'partial-fill');
    if (qty > order.filled && !fill) return null;
    const ev = { type: 'cancel-ack', key, ...(fill ? { filledQty: fill.filledQty, avgPx: fill.avgPx } : {}) };
    d.cancelEvidence = ev; save(); return ev;
  }
  // A saved planner transition may precede its first stop dispatch. Only the exact
  // initial stop with no durable dispatch can be retried; an uncertain dispatch is
  // reconciled by identity and is never retransmitted.
  async function recoverInitialStop() {
    const it = S.pendingInitialStop; if (!it) return true;
    if (S.dispatch[it.key]) { if (S.dispatch[it.key].status === 'unknown') P(null, 'TIDE URGENT: stop outcome unknown', 'The stop dispatch outcome is unknown. Check the account immediately; it will not be resent.', CRIT); delete S.pendingInitialStop; save(); return true; }
    const p = S.pos, order = p && p.orders[it.key];
    if (!p || !order || p.stopKey || p.stopNext !== it.key || order.status !== 'sent' ||
        order.qty !== it.qty || order.wantPx !== it.price || order.side !== it.side ||
        p.open !== it.qty || it.side !== (p.dir === 1 ? 'SELL' : 'BUY') || contractProblem()) {
      log('  [tide-live] initial stop recovery evidence inconsistent; manual intervention required.'); P(null, 'TIDE URGENT: stop recovery held', 'Initial stop recovery could not be verified. Check the account immediately.', CRIT); return false;
    }
    const position = await readRetry('initial stop recovery position', () => getOpenPosition(tokenOf(), accountId, contractId));
    const os = await readRetry('initial stop recovery orders', () => getOpenOrders(tokenOf(), accountId, contractId));
    if (!position || position.size !== p.open || position.type !== (p.dir === 1 ? 1 : 2) || os.some(x => x.type === OrderType.STOP)) {
      log('  [tide-live] initial stop recovery broker evidence inconsistent; manual intervention required.'); P(null, 'TIDE URGENT: stop recovery held', 'Initial stop recovery could not be verified. Check the account immediately.', CRIT); return false;
    }
    const back = await exec(it); delete S.pendingInitialStop; save();
    for (const ev of back) await run(ev);
    return true;
  }
  async function replayCancelEvidence() {
    for (const d of Object.values(S.dispatch || {})) if (d.cancelEvidence) await run(d.cancelEvidence);
  }
  async function snapshot(key) {
    let p, os; S.unreadable = false;
    try { p = await readRetry('reconcile: position read', () => getOpenPosition(tokenOf(), accountId, contractId)); os = await readRetry('reconcile: open orders read', () => getOpenOrders(tokenOf(), accountId, contractId)); } catch (e) { S.unreadable = true; throw e; }
    const byId = {}; for (const [k, id] of Object.entries(S.ids)) byId[String(id)] = k;
    // Exact durable custom tags only. Similar manual orders are NEVER adopted.
    if(S.pos) for(const x of Object.values(S.pos.orders)) {
      if(S.ids[x.key]!=null || !['sent','unknown','working','cancel-sent'].includes(x.status)) continue;
      let h=null;try{h=await lookupByTag(tokenOf(),accountId,contractId,x.key);}catch(e){}
      if(h && h.customTag===x.key && h.id!=null) {S.ids[x.key]=h.id;S.sentAt[x.key]=S.sentAt[x.key]||now();byId[String(h.id)]=x.key;rememberOrderId(h.id);save();}
      else {S.needReconcile=true;save();}
    }
    return { type: 'reconcile', ...(key != null ? { key } : {}), position: { qty: p ? p.size : 0, dir: p ? (p.type === 1 ? 1 : p.type === 2 ? -1 : null) : null },
      orders: os.map(x => ({ key: byId[String(x.id)] || null, orderId: x.id, qty: x.size, price: x.type === OrderType.STOP ? x.stopPrice : x.limitPrice })) };
  }
  // ---- what the planner cannot see by itself: each poll, the state of our live orders (terminal ones + a working entry's partial fills)
  async function observe() {
    await transferAmendmentGenerations();
    const live = Object.values(S.pos.orders).filter(x => ['sent', 'working', 'unknown', 'cancel-sent'].includes(x.status) && S.ids[x.key] != null);
    if (!live.length) return [];
    let open; try { open = await getOpenOrders(tokenOf(), accountId, contractId); } catch (e) { log(`  [tide-live] open orders unreadable (${e.message}) - nothing changed this poll.`); return []; }
    const openIds = new Set(open.map(x => String(x.id))), out = [];
    for (const x of live) {
      const h = await history(x.key, { quiet: openIds.has(String(S.ids[x.key])) });
      out.push(...h);
    }
    if (S.staleStop && S.ids[S.staleStop] != null && openIds.has(String(S.ids[S.staleStop]))) { const rec = await cancelVerified(S.ids[S.staleStop]); if (rec) { const ack = await verifiedCancelEvent(S.staleStop, rec); if (ack) { out.push(ack); S.staleStop = null; } } }
    return out;
  }

  async function transferAmendmentGenerations() {
    // One broker order has exactly one logical fill owner, including a crash or
    // timeout during native amendment. Never count its cumulative fill twice.
    for(const [key,d] of Object.entries(S.dispatch||{})) {
      const next=S.pos&&S.pos.orders[key],old=d.amends&&S.pos&&S.pos.orders[d.amends];
      if(d.amends && d.status!=='terminal' && next && ['sent','unknown','working','cancel-sent'].includes(next.status) && old && ['sent','unknown','working','cancel-sent'].includes(old.status)) await run({type:'order-superseded',key:d.amends});
    }
  }
  async function recoverStopAcks() {
    if(!S.pos) return; let os;try{os=await getOpenOrders(tokenOf(),accountId,contractId);}catch(e){return;}
    for(const x of Object.values(S.pos.orders)) {
      if(x.kind!=='stop'||!['sent','unknown'].includes(x.status)||S.ids[x.key]==null) continue;
      const r=os.find(b=>String(b.id)===String(S.ids[x.key])), d=S.dispatch[x.key];
      if(!r||!isNum(r.stopPrice)||r.side!==sideNum(x.side)||r.size!==x.qty-(x.filled||0)) continue;
      if(d&&d.amends&&r.stopPrice!==d.body.stopPrice) continue; // unknown amend may still execute later
      if(d)d.status='accepted';save();await run({type:'ack',key:x.key,price:r.stopPrice});
      if(d&&d.amends) await run({type:'order-superseded',key:d.amends});
      verifiedStopFeedback(x.key, r.stopPrice, r.size, !!(d&&d.amends));
    }
  }
  async function pollInner({ lastPx, bar }) {
    if (!owned()) return;
    if (S.loadIncident || contractProblem()) { log(S.loadIncident || contractProblem()); return; }
    await replayCancelEvidence(); if (!await recoverInitialStop() || !owned()) return;
    S.pollN = (S.pollN || 0) + 1;
    if (isNum(lastPx)) S.lastPx = lastPx;
    if (S.pos.stopNext || Object.values(S.dispatch||{}).some(d=>d.status==='unknown')) S.needReconcile=true;
    if (S.needReconcile) { S.needReconcile = false; save(); log('  [tide-live] an order went unanswered: reconciling with the broker (position + working orders).');
      try { const snap = await snapshot(null); for (const e of await observe()) await run(e); await recoverStopAcks(); await run(await snapshot(null)); } catch (e) { S.needReconcile = true; save(); log(`  [tide-live] reconcile read failed (${e.message}) - retried next poll.`); return; }
      if (!owned()) return; }
    for (const ev of await observe()) { await run(ev); if (!owned()) return; }
    const p = S.pos;
    // a LIMIT entry with nothing filled for 30 min: the exit lifecycle (it cancels the entry; nothing was open)
    const e1 = Object.values(p.orders).find(x => x.kind === 'entry' && x.leg === 1);
    if (e1 && !(e1.filled > 0) && ['sent', 'working'].includes(e1.status) && now() - (S.sentAt[e1.key] || now()) > ENTRY_EXPIRE_MS && !S.expireSent) {
      S.expireSent = true; save(); log('  [tide-live] the TIDE entry did not fill in 30 min: cancelled.'); J('entry_expire', { key: e1.key });
      const id = S.ids[e1.key]; const rec = id == null ? null : await cancelVerified(id);
      const ack = rec ? await verifiedCancelEvent(e1.key, rec) : null;
      if (!ack) { S.expireSent = false; save(); log('  [tide-live] the expired entry cancel is not verified yet - retried next poll.'); return; }
      await run(ack); return;
    }
    if (!(p.open > 0)) return;
    // the broker position must match the plan; a mismatch (a manual close, a fill not yet seen) -> a keyless reconcile (no order of ours is in flight here: every call is awaited)
    let bq = null; try { bq = await posSize(); } catch (e) { bq = null; }
    const stopLive = p.stopKey && p.orders[p.stopKey] && ['working', 'sent', 'unknown'].includes(p.orders[p.stopKey].status);
    if (bq !== null && (bq !== p.open || (!stopLive && !p.stopNext && !p.flat))) { log(`  [tide-live] broker ${bq}x vs plan ${p.open}x${stopLive ? '' : ', no working stop'}: reconciling.`); await run(await snapshot(null)); if (!owned() || !(S.pos.open > 0)) return; }
    // the stop is LARGER than the position (TP1 filled, its re-size rejected, e.g. in a news lock): a stop fill would REVERSE the account. The old stop stays
    // (cancelling it leaves the runner naked); URGENT push now and every 60 s (max 5); one re-size try per poll (a keyless reconcile clears the planner's
    // failed-level memory, so it re-sends the re-size once); the alert clears when the stop matches the position.
    { const p2 = S.pos, sk = p2.stopKey && p2.orders[p2.stopKey], sq = sk && ['working', 'unknown'].includes(sk.status) ? sk.qty : null;
      if (sq != null && p2.open > 0 && sq > p2.open && !p2.flat) {
        const t = now(), O = S.oversize || (S.oversize = { n: 0, at: 0 });
        if (O.n < 5 && t - O.at >= 60000) { O.n++; O.at = t; const txt = `TIDE URGENT: stop oversized ${sq} for ${p2.open} open - reversal risk, reduce stop in TopstepX`;
          log('  [tide-live] ' + txt); J('stop_oversized', { stopQty: sq, open: p2.open, n: O.n }); P(null, 'TIDE URGENT: stop oversized', txt, { priority: 'urgent', tags: 'rotating_light' }); }
        S.osPoll = S.pollN; save();
        if (!p2.stopNext) { await run(await snapshot(null)); if (!owned() || !(S.pos.open > 0)) return; }
      } else if (S.oversize) { J('stop_oversized_cleared', { n: S.oversize.n }); log('  [tide-live] the stop matches the position again (oversize alert cleared).'); S.oversize = null; save(); } }
    if (S.fillAt == null) { S.fillAt = now(); save(); }
    const d = S.pos.dir, ext = bar && isNum(bar.h) && isNum(bar.l) && isNum(bar.t) && bar.t >= S.fillAt ? (d === 1 ? bar.h : bar.l) : lastPx;   // bar extremes only from bars that began after the fill
    if (isNum(ext) && (S.best === null || d * (ext - S.best) > 0)) S.best = ext;
    if (isNum(lastPx) && (S.best === null || d * (lastPx - S.best) > 0)) S.best = lastPx;
    if (S.pos.tp1Qty === 0 && !S.pos.tp1Done && isNum(S.pos.tp1Px) && isNum(S.best) && d * (S.best - S.pos.tp1Px) >= 0) await run({ type: 'tp1-traded', px: S.pos.tp1Px });
    if (owned() && S.pos.open > 0 && isNum(lastPx) && isNum(S.best)) await run({ type: 'ladder', bestPx: S.best, lastPx, invalidated: false });
  }

  return {
    VERSION, owned, phase,
    state: () => S,
    // the phone's view (display only; MacUI-N SNAPSHOT-CONTRACT): the live position (null when none), today's closed trades and alerts
    view: () => { if (S.loadIncident) return { position: null, trades: [], alerts: [{ code: 'saved-state-blocked', level: 'critical', text: S.loadIncident }], orderIds: [], blocked: S.loadIncident };
      const p = S.pos, h = hist(), live = owned() && p && p.plan;
      const e = live ? Object.values(p.orders).filter(x => x.kind === 'entry') : [], fq = e.reduce((a, x) => a + (x.filled || 0), 0), ae = live ? T.avgEntry(p) : null, pv = (cfgFn() || {}).pointValue || 2;
      const tp1o = live ? Object.values(p.orders).filter(x => x.kind === 'tp1') : [], tp2o = live ? Object.values(p.orders).filter(x => x.kind === 'tp2') : [];
      const position = live ? { id: p.id, setup: S.setup || null, signalId: S.takeId, phase: p.phase, dir: p.dir, grade: p.grade, points: S.points ?? null, pointNames: S.pointNames || null, entryType: p.plan.entryType,
        plannedQty: p.plan.contracts, filledQty: fq, open: p.open, avgEntry: isNum(ae) ? round(ae) : null, fillAt: S.fillAt, stopAsked: p.stopPx, stopAcked: p.protPx, stopBy: S.stopBy || (p.tp1Done ? 'break-even' : 'structural'), structuralStop: p.plan.stop,
        R: p.R, tp1: { price: p.tp1Px, qty: p.tp1Qty, done: !!p.tp1Done, filled: tp1o.reduce((a, x) => a + (x.filled || 0), 0) }, tp2: { price: p.tp2Px, done: tp2o.some(x => x.status === 'done'), filled: tp2o.reduce((a, x) => a + (x.filled || 0), 0) },
        best: S.best, lastPx: S.lastPx, openUsd: isNum(ae) && isNum(S.lastPx) && p.open > 0 ? Math.round(p.dir * (S.lastPx - ae) * p.open * pv * 100) / 100 : null, block: p.block || null, closing: !!p.closing } : null;
      return { position, trades: h.trades.slice(), alerts: h.alerts.slice(), orderIds: [...new Set([...Object.values(S.ids || {}).map(String), ...(h.orderIds || [])])] }; },
    // the 3 s fast poll runs while an entry may still fill, or contracts are open without an acked stop (a fill is protected within ~3 s)
    fast: () => { if (S.loadIncident || !owned() || !S.pos) return false; const p = S.pos; if (S.needReconcile) return true;
      if (Object.values(p.orders).some(x => x.kind === 'entry' && ['sent', 'working', 'unknown'].includes(x.status))) return true;
      return p.open > 0 && !(p.stopKey && p.orders[p.stopKey] && p.orders[p.stopKey].status === 'working'); },
    // a taken TIDE signal. One TIDE position at a time; the planner sizes (money cfg) and refuses on its own config problem.
    signal: (sig, p, takeId) => serial(async () => {
      const problem=S.loadIncident||(!stateFile?'durable stateFile required':null)||contractProblem();if(problem){log(problem);return {ok:false,why:'execution-contract-unavailable',detail:problem};}
      if (owned()) { log('  [tide-live] signal not taken: a TIDE position is already open.'); return { ok: false, why: 'owned' }; }
      if (typeof o.preCheck === 'function') { let w; try { w = await o.preCheck(sig); } catch (e) { w = `pre-check failed (${e.message})`; } if (w) { log(`  [tide-live] signal not taken: ${w}.`); return { ok: false, why: w }; } }   // the executor's own gates now (flat FSM, session)
      // one position account-wide: the broker shows NO position and NO working order on this contract (a manual order, a position not adopted yet, the old path)
      const readT0 = now();   // [r1.5.3] preserve rechecking entry gates after slow broker reads
      let bp, bo; try { bp = await readRetry('entry check: position read', () => getOpenPosition(tokenOf(), accountId, contractId)); bo = await readRetry('entry check: open orders read', () => getOpenOrders(tokenOf(), accountId, contractId)); }
      catch (e) { const side = sig.dir === 1 ? 'LONG' : 'SHORT', lvl = sig.levelName || 'level ?';
        log(`  [tide-live] signal not taken: the broker state is unreadable after ${READ_AT_MS.length} tries (${errText(e.last || e)}).`);
        P(null, 'TIDE URGENT: signal NOT taken', `${takeId || sig.setupId || 'TIDE signal'} ${side} at ${lvl}: broker unreadable after ${READ_AT_MS.length} tries (${errText(e.last || e)}). No order was sent.`, CRIT);
        return { ok: false, why: 'broker-unreadable' }; }
      if (bp && bp.size) { log(`  [tide-live] signal not taken: the broker shows a ${bp.size}x position.`); return { ok: false, why: 'broker-position' }; }
      if (bo && bo.length) { log(`  [tide-live] signal not taken: ${bo.length} working order(s) at the broker.`); return { ok: false, why: 'broker-orders' }; }
      if (now() - readT0 > 3000 && typeof o.preCheck === 'function') { let w2; try { w2 = await o.preCheck(sig); } catch (e) { w2 = `pre-check failed (${e.message})`; }   // [r1.5.3]
        if (w2) { log(`  [tide-live] signal not taken: the broker reads took ${Math.round((now() - readT0) / 100) / 10} s and the gates now say: ${w2}.`); J('precheck_after_slow_read', { ms: now() - readT0, why: w2, take: takeId || null }); return { ok: false, why: w2 }; } }
      { const c = cfgFn(), pts = Math.abs(sig.entry - p.stop), z = isNum(pts) ? T_MONEY.sizeFor(pts, p.grade, T_MONEY.withRiskMult(c, sig.riskMult)) : null, cap = typeof o.take1MaxFn === 'function' ? o.take1MaxFn() : 400;   // the take1 ceiling (defence in depth: tideWire refuses first)
        if (z && z.code === 'NO_FIT_TAKE1' && !(z.riskUsd <= cap + 1e-9)) { log(`  [tide-live] signal not taken: 1 MNQ risks $${z.riskUsd} > the take1 ceiling $${cap} (GRADE_NO_FIT_CEILING).`); return { ok: false, why: 'GRADE_NO_FIT_CEILING' }; } }
      const H = S.hist, generation = (S.generation || 0) + 1; S = blank(); S.hist = H; S.generation = generation; S.takeId = takeId || null; S.setup = sig.setupId || null; S.points = p.gradeDetail && isNum(p.gradeDetail.points) ? p.gradeDetail.points : null; S.pointNames = p.gradeDetail && Array.isArray(p.gradeDetail.names) ? p.gradeDetail.names : null; S.pos = T.initState(`tide-${now()}-${generation}`); save();
      await run({ type: 'signal', dir: sig.dir, grade: p.grade, entryPx: sig.entry, entryType: p.entryType, stop: p.stop, riskMult: isNum(sig.riskMult) && sig.riskMult > 0 ? sig.riskMult : 1, htf: sig.htf || null, pools: Array.isArray(sig.pools) ? sig.pools : [], partialPools: Array.isArray(sig.internalPools) ? sig.internalPools : null });
      if (owned() && S.pos.plan && S.pos.plan.sizeCode === 'NO_FIT_TAKE1') { const pl = S.pos.plan; log(`  [tide-live] NO_FIT_TAKE1: 1 MNQ at a ${pl.stopPts}-pt stop risks $${pl.riskUsd} (budget $${pl.budgetUsd}).`); J('no_fit_take1', { stopPts: pl.stopPts, riskUsd: pl.riskUsd, budgetUsd: pl.budgetUsd });
 }   // [r1.1] the ENTRY push carries the take1 note
      if (!owned() && !S.endTold) { const why = (S.pos && S.pos.block) || 'refused by the planner'; S.pos = null; save(); return { ok: false, why }; }
      return { ok: true, phase: phase(), id: S.pos.id };
    }),
    // every main-loop poll: fills / cancels seen at the broker, the position check, then TP1-traded (1 lot) and the ladder
    poll: arg => serial(() => pollInner(arg || {})),
    // the session close / daily floor / a manual exit: the planner's flatten lifecycle (one per position; a repeat is a no-op)
    exitAtMarket: reason => serial(async () => { if(S.loadIncident||contractProblem())return false; if (!owned()) return false; await run({ type: 'exit-at-market', reason, lastPx: S.lastPx }); return true; }),
    // startup: a saved TIDE position -> the keyless reconcile (the planner re-asserts the guard; no working stop -> it closes the position at once)
    start: () => serial(async () => {
      if(S.loadIncident||contractProblem()){log(S.loadIncident||contractProblem());return;} 
      if (!owned()) { log(`  [tide-live] ${VERSION}: no TIDE position saved.`); return; }
      await replayCancelEvidence(); if (!await recoverInitialStop() || !owned()) return;
      log(`  [tide-live] ${VERSION}: resuming TIDE position ${S.pos.id} (${S.pos.phase}, ${S.pos.open}x): reconciling with the broker.`);
      J('restart', { phase: S.pos.phase, open: S.pos.open });
      await snapshot(null); for(const e of await observe()) await run(e); await recoverStopAcks(); await run(await snapshot(null));
    }),
  };
}

module.exports = { VERSION, create, ENTRY_EXPIRE_MS };
