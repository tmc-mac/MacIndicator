'use strict';
// tideLive r1.1 (TIDE Stage 2a LIVE, MacLive 11/04; from MacMoney's r1 draft): runs ONE TIDE position at a time through lib/tideOrders.js (the pure planner
// r1.2) and executes its intents with the executor's own broker primitives (lib/liveOrders.js: placeOrder / cancelOrder / getOpenPosition / getOpenOrders /
// getEntryOrder), with the same request bodies the state machine sends. Used ONLY with tide.mode "live" (armed by tools/set-tide.sh live).
// OWNERSHIP (MAP.md ruling 1): the state machine never holds a TIDE position. It stays FLAT, so its own post-fill bracket path (stop / targets / BE / trail /
// lock / adoption) cannot act on it. The `guard` intent is persisted here (state file) and the executor asks owned() before EVERY old-path entry (takeEntry),
// before adopting an unknown broker position (reconcileIfUnknownPosition) and in TIDE's own flat gate.
// Executor switches (MAP.md): stops are never widened (no widen path exists here: a reject goes back to the planner, which retries the SAME price once or
// flattens); every stop ack carries the price the BROKER shows resting (read back from the open orders; the price sent only when the read fails); the flatten
// is a re-read + a MARKET close of min(expectOpen, actual) with NO stop cancel inside it (the planner cancels the stop, verified, before it).
// Stage 2a scope: entry + one stop + TP1 2/3 + BE + TP2 + the R-ladder / climax + the planner's flatten. No pyramid add (ADD_WOULD_FIRE is journaled only),
// no resting half (tideOrders.configProblem refuses entryByGrade). NO daily loss limit, no timed exits. The session close / daily floor reach this position
// through exitAtMarket() (the planner's flatten, one per position).
// Every call is serialized (one at a time): the background TIDE step (signal) and the main loop (poll / exit) never interleave on the state.
const fs = require('fs');
const path = require('path');
const T = require('./tideOrders');
const T_MONEY = require('./moneyRule');
const VERSION = 'tide-live-r1.1';
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
  const { OrderType, OrderSide, placeOrder, cancelOrder, getOpenPosition, getOpenOrders, getEntryOrder } = orders;
  const tokenOf = () => (typeof token === 'function' ? token() : token);
  let S = load();
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  function blank() { return { version: VERSION, pos: null, ids: {}, sentAt: {}, ev: 0, best: null, fillAt: null, closedAt: null, takeId: null, endTold: false, tp1Told: false, lastPx: null, guard: null, staleStop: null, pushed: {}, dispatch: null }; }
  function load() {
    try { if (stateFile) { const d = JSON.parse(fs.readFileSync(stateFile, 'utf8')); const obj = x => !!x && typeof x === 'object' && !Array.isArray(x);
      const valid = obj(d) && d.version === VERSION && Object.prototype.hasOwnProperty.call(d, 'pos') && obj(d.ids) && obj(d.sentAt) && obj(d.pushed) && Number.isFinite(d.ev) &&
        (d.pos === null || (obj(d.pos) && typeof d.pos.phase === 'string' && obj(d.pos.orders) &&
          (DONE_PHASES.has(d.pos.phase) || (obj(d.pos.plan) && typeof d.pos.id === 'string' && d.pos.id.length > 0 && (d.pos.dir === 1 || d.pos.dir === -1) && Number.isInteger(d.pos.open) && d.pos.open >= 0))));
      if (valid) return { ...blank(), ...d }; log('  [tide-live] state invalid or version not recognized: manual reconciliation required.'); return { ...blank(), dispatch: { kind: 'state', reason: 'invalid or unrecognized state' } }; } }
    catch (e) { if (e.code === 'ENOENT') return blank(); log(`  [tide-live] state unreadable (${e.message}): manual reconciliation required.`); return { ...blank(), dispatch: { kind: 'state', reason: 'unreadable state' } }; }
    return blank();
  }
  function save() {
    if (!stateFile) return;
    const tmp = `${stateFile}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(S)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, stateFile);
    const dir = fs.openSync(path.dirname(stateFile), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  const ctx = () => ({ cfg: cfgFn() });
  function owned() { return !!(S.dispatch || (S.pos && S.pos.plan && !DONE_PHASES.has(S.pos.phase))); }   // ambiguous dispatch retains ownership
  function phase() { return S.dispatch ? 'UNKNOWN' : S.pos ? S.pos.phase : 'FLAT'; }
  const J = (what, data) => { try { journal({ type: 'lv_tide', phase: 'live_' + what, version: VERSION, t: now(), position: S.pos ? S.pos.id : null, take: S.takeId, ...data }); } catch (e) { /* journal only */ } };
  const P = (key, title, text, opts = { priority: 'high', tags: 'chart_with_upwards_trend' }) => { if (key && S.pushed[key]) return; if (key) S.pushed[key] = true; try { notify(title, text, opts); } catch (e) { /* push only */ } };
  function dispatchAlert() { const msg = 'Order outcome or saved ownership is uncertain. Automatic order actions are held; check the position and all working orders directly.'; log(`  [tide-live] URGENT: ${msg}`); P('dispatch-hold', 'TIDE URGENT: order outcome unknown', msg, CRIT); }

  // ---- one planner step per event, then every intent executed in order; results come back as events (a queue, bounded)
  async function run(firstEvent) {
    const q = [firstEvent]; let steps = 0;
    while (q.length) {
      if (++steps > MAX_STEPS) { log('  [tide-live] CRITICAL: the event loop did not settle (200 steps) - stopping this pass; the next poll continues.'); P(null, 'TIDE URGENT: loop fence', 'The TIDE order loop hit its fence. Check the account.', CRIT); break; }
      const ev = q.shift(); if (ev.id == null) ev.id = `${S.pos.id}:ev:${++S.ev}`;
      const r = T.plan(S.pos, ev, ctx()); S.pos = r.state; save();
      if (r.intents.length || (ev.type !== 'ladder' && ev.type !== 'tp1-traded')) J('step', { event: brief(ev), intents: r.intents.map(i => ({ op: i.op, kind: i.kind, qty: i.qty, price: i.price, key: i.key, code: i.code })), notes: r.notes, statePhase: r.state.phase });
      for (const it of r.intents) { const back = await exec(it); q.push(...back); save(); if (S.dispatch) { dispatchAlert(); return; } }
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
  const placeChecked = new Set();   // [r1.5.2] (c) the order keys already checked after a lost place answer (one check + one re-send each)
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
  async function positionMatches(expected) {
    const p = await readRetry('position read', () => getOpenPosition(tokenOf(), accountId, contractId));
    return !!p && p.size === expected && (p.type === 1 ? 1 : p.type === 2 ? -1 : null) === S.pos.dir;
  }
  async function cancelVerified(orderId, holdAfter = false) {
    const key = Object.keys(S.ids).find(k => String(S.ids[k]) === String(orderId));
    const known = key && S.pos && S.pos.orders[key];
    if (!key || !known || !stateFile) return false;
    S.dispatch = { key, kind: 'cancel', at: now(), reason: 'cancellation pending' }; save();
    for (let i = 0; i < 3; i++) {
      try { await cancelOrder(tokenOf(), accountId, orderId); } catch (e) { /* outcome unknown */ }
      let h = null; try { h = await getEntryOrder(tokenOf(), accountId, contractId, orderId, S.sentAt[key] || now()); } catch (e) { /* unknown */ }
      // Absence from an open-order snapshot is not a terminal cancellation.
      // A new fill, even a partial fill, needs reconciliation before replacement.
      if (h && (h.status === 3 || h.status === 4) && h.fillVolume != null && Number.isFinite(Number(h.fillVolume)) && Number(h.fillVolume) === (known.filled || 0)) { const marker = S.dispatch; S.dispatch = holdAfter ? { key, kind: 'stop-change', reason: 'old stop canceled; replacement pending', at: now() } : null; try { save(); } catch (e) { S.dispatch = marker; throw e; } return true; }
    }
    return false;
  }
  function req(it, body, extra = {}) { J('order', { key: it.key, op: it.op, kind: it.kind, side: it.side, qty: body.size, type: body.type, limitPrice: body.limitPrice ?? null, stopPrice: body.stopPrice ?? null, ...extra }); }
  async function placed(it, body) {
    if (it.kind === 'stop' && S.osPoll != null && S.osPoll === S.pollN) { if (S.osSent === S.pollN) { J('order_held', { key: it.key, why: 'stop oversized: one re-size try per poll' }); return [{ type: 'reject', key: it.key, reason: 'one re-size try per poll (stop oversized, e.g. a news lock)', lastPx: S.lastPx }]; } S.osSent = S.pollN; }
    // Persist the possibility of a dispatch before crossing the broker boundary.
    // An unanswered call is never inferred absent from a later open-order snapshot.
    if (!stateFile) throw new Error('state file required before broker dispatch');
    S.dispatch = { key: it.key, kind: it.kind, op: it.op, at: now(), reason: 'dispatch pending' };
    save();
    req(it, body);
    try {
      const d = await placeOrder(tokenOf(), body); const id = d && (d.orderId ?? d.id);
      if (id == null) { S.dispatch.reason = 'response missing order id'; save(); return [{ type: 'no-ack', key: it.key, reason: S.dispatch.reason }]; }
      S.ids[it.key] = id; S.sentAt[it.key] = now();
      { const hi = hist(); hi.orderIds = hi.orderIds || []; hi.orderIds.push(String(id)); while (hi.orderIds.length > 400) hi.orderIds.shift(); }
      // Keep the marker until the ID and its association have been durably saved.
      save(); const marker = S.dispatch; S.dispatch = null;
      try { save(); } catch (e) { S.dispatch = marker; throw e; }
      if (it.kind !== 'stop') return [{ type: 'ack', key: it.key }];
      let px = body.stopPrice, src = 'sent';
      try { const os = await getOpenOrders(tokenOf(), accountId, contractId); const r = os.find(x => String(x.id) === String(id)); if (r && isNum(r.stopPrice)) { px = r.stopPrice; src = 'broker'; } else if (!r) src = 'not-listed'; } catch (e) { src = 'unread'; }
      J('stop_ack', { key: it.key, orderId: id, sent: body.stopPrice, acked: px, source: src });
      if (src !== 'broker') { S.dispatch = { key: it.key, kind: 'stop', reason: 'accepted stop not visible at broker', at: now() }; save(); return [{ type: 'no-ack', key: it.key, reason: S.dispatch.reason }]; }
      return [{ type: 'ack', key: it.key, price: px }];
    } catch (e) {
      if (e.orderRejected === true) {
        const marker = S.dispatch; S.dispatch = null;
        try { save(); } catch (saveErr) { S.dispatch = marker; throw saveErr; }
        J('order_fail', { key: it.key, rejected: true, reason: e.message });
        return [{ type: 'reject', key: it.key, reason: e.message, lastPx: S.lastPx }];
      }
      if (!S.dispatch) S.dispatch = { key: it.key, kind: it.kind, op: it.op, at: now() };
      S.dispatch.reason = 'unanswered dispatch';
      try { save(); } catch (saveErr) { log(`  [tide-live] cannot persist dispatch hold (${saveErr.message}).`); }
      J('order_fail', { key: it.key, rejected: false, reason: e.message });
      return [{ type: 'no-ack', key: it.key, reason: e.message }];
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
        if (!(await positionMatches(it.qty))) { S.dispatch = { key: it.key, kind: 'stop', reason: 'position quantity or direction changed' }; save(); dispatchAlert(); return [{ type: 'no-ack', key: it.key, reason: S.dispatch.reason }]; }
        const back = await placed(it, { ...base(), type: OrderType.STOP, side: sideNum(it.side), size: it.qty, stopPrice: it.price });
        if (back[0].type !== 'ack') P(null, 'TIDE URGENT: stop NOT placed', `The stop ${it.price} for ${it.qty}x was ${back[0].type} (${back[0].reason || ''}); the planner retries once at the same price or closes the position.`, CRIT);
        else if (S.entryPushed) P(`stopplace:${it.key}`, 'TIDE stop placed', `Stop ${back[0].price ?? it.price} for ${it.qty}x (protective, never widened).`, { ...INFO, tags: 'shield' });
        else if (!S.entryPushed) { const p = S.pos, e1 = Object.values(p.orders).find(x => x.kind === 'entry' && x.filled > 0); if (e1) { S.entryPushed = true; save();   // [r1.1] ONE entry push: fill + stop + targets
          P(`entrypush:${p.id}`, `TIDE ENTRY ${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.grade}`, `${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.grade} ${it.qty} MNQ @ ${round(e1.avgPx)} | stop ${back[0].price ?? it.price} (${p.plan.stopPts} pts, risk $${Math.round(Math.abs(e1.avgPx - (back[0].price ?? it.price)) * it.qty * ((cfgFn() || {}).pointValue || 2))}) | TP1 ${p.tp1Px}${p.tp1Qty ? ' (' + p.tp1Qty + 'x)' : ' (1 lot: BE trigger)'} | TP2 ${p.tp2Px}${p.plan.sizeCode === 'NO_FIT_TAKE1' ? ' | take1: 1 MNQ over budget' : ''}`, INFO); } }
        return back; }
      if (it.op === 'place' && (it.kind === 'tp1' || it.kind === 'tp2')) {
        if (!(await positionMatches(it.expectOpen))) { S.dispatch = { key: it.key, kind: 'target', reason: 'position quantity or direction changed' }; save(); dispatchAlert(); return [{ type: 'no-ack', key: it.key, reason: S.dispatch.reason }]; }
        log(`  [LIVE ORDER] TIDE ${it.kind}: ${it.side} ${it.qty}x LIMIT @ ${it.price} (${it.key})`);
        return placed(it, { ...base(), type: OrderType.LIMIT, side: sideNum(it.side), size: it.qty, limitPrice: it.price });
      }
      if (it.op === 'place' && it.kind === 'add') { J('ADD_WOULD_FIRE', { qty: it.qty, price: it.price }); log(`  [tide-live] ADD_WOULD_FIRE ${it.qty}x @ ${it.price}: Stage 2a sends no pyramid add.`); return [{ type: 'reject', key: it.key, reason: 'Stage 2a: no pyramid add (addsEnabled false)' }]; }
      if (it.op === 'modify' && it.kind === 'stop') {   // REVIEW: cancel the old stop first; never intentionally place two stops
        log(`  [LIVE ORDER] TIDE stop change: ${it.qty}x STOP @ ${it.price} (replaces ${it.replaces}; never widened)`);
        const old = S.ids[it.replaces];
        if (old == null || !(await cancelVerified(old, true))) { if (!S.dispatch) { S.dispatch = { key: it.key, kind: 'stop-change', reason: 'old stop identity unknown' }; save(); } P(null, 'TIDE URGENT: stop change held', 'The old stop cancellation or its fill state is not confirmed. Check position and working orders directly.', CRIT); return [{ type: 'no-ack', key: it.key, reason: 'old stop cancellation not confirmed' }]; }
        const pos = await readRetry('stop change: position read', () => getOpenPosition(tokenOf(), accountId, contractId));
        if (!pos || pos.size !== it.expectOpen || (pos.type === 1 ? 1 : pos.type === 2 ? -1 : null) !== S.pos.dir) {
          S.dispatch = { kind: 'stop-change', key: it.key, reason: 'position changed after stop cancellation' }; save(); dispatchAlert(); return [{ type: 'no-ack', key: it.key, reason: 'position changed after stop cancellation' }];
        }
        const back = await placed(it, { ...base(), type: OrderType.STOP, side: sideNum(it.side), size: it.qty, stopPrice: it.price });
        if (back[0].type !== 'ack') { if (!S.dispatch) { S.dispatch = { key: it.key, kind: 'stop-change', reason: 'old stop canceled; replacement not confirmed' }; save(); } dispatchAlert(); return back; }
        back.push({ type: 'cancel-ack', key: it.replaces });
        { const p = S.pos, px = back[0].price ?? it.price, ent = T.avgEntry(p), lockR = isNum(ent) && isNum(p.R) && p.R > 0 ? p.dir * (px - ent) / p.R : null;   // [r1.1] journal only, except the FIRST lock >= +1R
          S.stopBy = isNum(lockR) && lockR > 0.01 ? 'ladder' : p.tp1Done ? 'break-even' : 'structural';
          P(`stop:${it.key}`, 'TIDE stop moved', `Stop now ${px} for ${it.qty}x (tighter only)${isNum(lockR) ? ` = ${lockR >= 0 ? '+' : ''}${Math.round(lockR * 100) / 100}R locked` : ''}.`, { ...INFO, tags: 'shield' }); }
        return back;
      }
      if (it.op === 'modify' && (it.kind === 'tp1' || it.kind === 'tp2')) {   // a target: the old one cancelled first (verified), then the new one
        const old = S.ids[it.replaces];
        if (old != null && !(await cancelVerified(old))) return [{ type: 'reject', key: it.key, reason: 'the old target could not be cancelled' }];
        if (!(await positionMatches(it.expectOpen))) { S.dispatch = { key: it.key, kind: 'target', reason: 'position quantity or direction changed' }; save(); dispatchAlert(); return [{ type: 'no-ack', key: it.key, reason: S.dispatch.reason }]; }
        log(`  [LIVE ORDER] TIDE ${it.kind} change: ${it.qty}x LIMIT @ ${it.price} (${it.key})`);
        return placed(it, { ...base(), type: OrderType.LIMIT, side: sideNum(it.side), size: it.qty, limitPrice: it.price });
      }
      if (it.op === 'cancel') {
        let id = S.ids[it.target];
        if (id == null) {   // no order id (never sent, or sent without an answer): never assume it is gone - match the broker's working orders first
          S.dispatch = { key: it.target, kind: 'cancel', reason: 'order identity unresolved' }; save(); dispatchAlert(); return [{ type: 'no-ack', key: it.key, reason: 'order identity unresolved' }];
        }
        log(`  [LIVE ORDER] TIDE cancel ${it.kind} ${id} (${it.reason})`); J('cancel', { key: it.key, target: it.target, orderId: id, reason: it.reason });
        if (await cancelVerified(id)) { const h = await history(it.target, { quiet: true }); return h.filter(e => e.type === 'fill').concat([{ type: 'cancel-ack', key: it.target }]); }   // a fill that won the race first
        return [{ type: 'reject', key: it.key, reason: 'cancel not verified' }];
      }
      if (it.op === 'flatten') {   // close only a position on the owned side
        const pos = await readRetry('flatten: position read', () => getOpenPosition(tokenOf(), accountId, contractId));
        if (pos && (pos.type === 1 ? 1 : pos.type === 2 ? -1 : null) !== S.pos.dir) { S.dispatch = { key: it.key, kind: 'flatten', reason: 'position direction mismatch' }; save(); dispatchAlert(); return [{ type: 'no-ack', key: it.key, reason: 'position direction mismatch' }]; }
        const size = Math.min(it.expectOpen, pos ? pos.size : 0);
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
      log(`  [tide-live] ${it.op} ${it.kind} failed (${e.message}) - reported as unknown.`); S.needReconcile = true;
      if (it.op !== 'read' && !S.dispatch) S.dispatch = { key: it.key, kind: it.kind, reason: 'execution or preflight failed' };
      try { save(); } catch (saveErr) { log(`  [tide-live] could not save hold (${saveErr.message}).`); }
      return it.op === 'read' ? [{ type: 'reject', key: it.key, reason: e.message }] : [{ type: 'no-ack', key: it.key, reason: e.message }];
    }
  }
  // the order's history -> fill / cancel-ack / reject events (ProjectX status 1 open, 2 filled, 3 cancelled, 4 expired, 5 rejected); fills are CUMULATIVE
  async function history(key, { quiet = false } = {}) {
    const id = S.ids[key]; if (id == null) return [];
    let h; try { h = await getEntryOrder(tokenOf(), accountId, contractId, id, S.sentAt[key] || now()); } catch (e) { if (!quiet) log(`  [tide-live] order ${id} history not readable yet (${e.message}).`); return []; }
    const out = [], fv = Number(h.fillVolume) || 0, fp = Number(h.filledPrice), o = S.pos && S.pos.orders[key];
    if (fv > 0 && isNum(fp) && (!o || fv > (o.filled || 0))) {
      out.push({ type: o && fv < o.qty ? 'partial-fill' : 'fill', key, filledQty: fv, avgPx: fp });
      if (o && o.kind === 'entry' && S.fillAt == null) { const bt = Date.parse(h.updateTimestamp || h.creationTimestamp || ''); S.fillAt = Number.isFinite(bt) ? bt : now(); }   // [r1.2] the fill time (the broker's stamp when given)
      if (o) { const k = o.kind; log(`  [tide-live] FILL ${k} ${fv}x @ ${fp} (${key})`); J('fill', { key, kind: k, filledQty: fv, avgPx: fp });
        P(`fill:${key}:${fv}`, `TIDE ${k === 'entry' ? 'FILLED' : k === 'stop' ? 'STOPPED' : k === 'position' ? 'closed at market' : k.toUpperCase() + ' filled'}`, `${k} ${fv}x @ ${fp}.`, { ...INFO, tags: k === 'stop' ? 'x' : 'white_check_mark' }); }
    }
    if (h.status === 3 || h.status === 4) out.push({ type: 'cancel-ack', key });
    if (h.status === 5) out.push({ type: 'reject', key, reason: 'rejected (history)', lastPx: S.lastPx });
    return out;
  }
  async function snapshot(key) {
    let p, os; S.unreadable = false;
    try { p = await readRetry('reconcile: position read', () => getOpenPosition(tokenOf(), accountId, contractId)); os = await readRetry('reconcile: open orders read', () => getOpenOrders(tokenOf(), accountId, contractId)); } catch (e) { S.unreadable = true; throw e; }
    const byId = {}; for (const [k, id] of Object.entries(S.ids)) byId[String(id)] = k;
    // An absent snapshot is not terminal evidence and lookalike orders do not prove ownership.
    if (S.pos) { const visible = new Set(os.map(x => String(x.id)));
      const missing = Object.values(S.pos.orders).find(o => ['sent', 'unknown', 'working', 'cancel-sent'].includes(o.status) && (S.ids[o.key] == null || !visible.has(String(S.ids[o.key]))));
      if (missing) { S.dispatch = { key: missing.key, kind: missing.kind, reason: 'saved order not visible during reconciliation' }; save(); dispatchAlert(); throw new Error('saved order not visible; manual reconciliation required'); }
    }
    return { type: 'reconcile', ...(key != null ? { key } : {}), position: { qty: p ? p.size : 0, dir: p ? (p.type === 1 ? 1 : p.type === 2 ? -1 : null) : null },
      orders: os.map(x => ({ key: byId[String(x.id)] || null, orderId: x.id, qty: x.size, price: x.type === OrderType.STOP ? x.stopPrice : x.limitPrice })) };
  }
  // ---- what the planner cannot see by itself: each poll, the state of our live orders (terminal ones + a working entry's partial fills)
  async function observe() {
    const live = Object.values(S.pos.orders).filter(x => ['sent', 'working', 'unknown', 'cancel-sent'].includes(x.status) && S.ids[x.key] != null);
    if (!live.length) return [];
    let open; try { open = await getOpenOrders(tokenOf(), accountId, contractId); } catch (e) { log(`  [tide-live] open orders unreadable (${e.message}) - nothing changed this poll.`); return []; }
    const openIds = new Set(open.map(x => String(x.id))), out = [];
    for (const x of live) if (!openIds.has(String(S.ids[x.key])) || (x.kind === 'entry' && x.status !== 'cancel-sent')) {
      const h = await history(x.key, { quiet: openIds.has(String(S.ids[x.key])) });
      // a protective stop that ended WITHOUT our cancel and without a fill (cancelled by hand / expired at the broker): the position is NAKED ->
      // a keyless reconcile (ruling 7: the planner closes it at once; no repair-and-wait)
      if (x.kind === 'stop' && x.status !== 'cancel-sent' && h.some(e => e.type === 'cancel-ack') && !h.some(e => e.type === 'fill')) { S.needReconcile = true; save(); log(`  [tide-live] ALERT: the protective stop ${S.ids[x.key]} was cancelled at the broker (not by TIDE): the position is naked - closing it.`); continue; }
      out.push(...h);
    }
    if (S.needReconcile) { const rc = await snapshot(null); S.needReconcile = false; save(); return [rc]; }
    if (S.staleStop && S.ids[S.staleStop] != null && openIds.has(String(S.ids[S.staleStop]))) { if (await cancelVerified(S.ids[S.staleStop])) { out.push({ type: 'cancel-ack', key: S.staleStop }); S.staleStop = null; } }
    return out;
  }

  async function pollInner({ lastPx, bar }) {
    if (S.dispatch) { dispatchAlert(); return; }
    if (!owned()) return;
    S.pollN = (S.pollN || 0) + 1;
    if (isNum(lastPx)) S.lastPx = lastPx;
    if (S.needReconcile) { S.needReconcile = false; save(); log('  [tide-live] an order went unanswered: reconciling with the broker (position + working orders).');
      try { await run(await snapshot(null)); } catch (e) { S.needReconcile = true; save(); log(`  [tide-live] reconcile read failed (${e.message}) - retried next poll.`); return; }
      if (!owned()) return; }
    for (const ev of await observe()) { await run(ev); if (!owned()) return; }
    const p = S.pos;
    // a LIMIT entry with nothing filled for 30 min: the exit lifecycle (it cancels the entry; nothing was open)
    const e1 = Object.values(p.orders).find(x => x.kind === 'entry' && x.leg === 1);
    if (e1 && !(e1.filled > 0) && ['sent', 'working'].includes(e1.status) && now() - (S.sentAt[e1.key] || now()) > ENTRY_EXPIRE_MS && !S.expireSent) {
      S.expireSent = true; save(); log('  [tide-live] the TIDE entry did not fill in 30 min: cancelled.'); J('entry_expire', { key: e1.key });
      const id = S.ids[e1.key]; let ok = id == null; if (!ok) { log(`  [LIVE ORDER] TIDE cancel entry ${id} (not filled in 30 min)`); ok = await cancelVerified(id); }
      if (!ok) { S.expireSent = false; save(); log('  [tide-live] the expired entry cancel is not verified yet - retried next poll.'); return; }
      const h = await history(e1.key, { quiet: true }); for (const ev of h.filter(x => x.type === 'fill' || x.type === 'partial-fill')) await run(ev);   // a fill that won the race first
      await run({ type: 'cancel-ack', key: e1.key }); return;
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
    view: () => { const p = S.pos, h = hist(), live = owned() && p && p.plan;
      const e = live ? Object.values(p.orders).filter(x => x.kind === 'entry') : [], fq = e.reduce((a, x) => a + (x.filled || 0), 0), ae = live ? T.avgEntry(p) : null, pv = (cfgFn() || {}).pointValue || 2;
      const tp1o = live ? Object.values(p.orders).filter(x => x.kind === 'tp1') : [], tp2o = live ? Object.values(p.orders).filter(x => x.kind === 'tp2') : [];
      const position = live ? { id: p.id, setup: S.setup || null, signalId: S.takeId, phase: p.phase, dir: p.dir, grade: p.grade, points: S.points ?? null, pointNames: S.pointNames || null, entryType: p.plan.entryType,
        plannedQty: p.plan.contracts, filledQty: fq, open: p.open, avgEntry: isNum(ae) ? round(ae) : null, fillAt: S.fillAt, stopAsked: p.stopPx, stopAcked: p.protPx, stopBy: S.stopBy || (p.tp1Done ? 'break-even' : 'structural'), structuralStop: p.plan.stop,
        R: p.R, tp1: { price: p.tp1Px, qty: p.tp1Qty, done: !!p.tp1Done, filled: tp1o.reduce((a, x) => a + (x.filled || 0), 0) }, tp2: { price: p.tp2Px, done: tp2o.some(x => x.status === 'done'), filled: tp2o.reduce((a, x) => a + (x.filled || 0), 0) },
        best: S.best, lastPx: S.lastPx, openUsd: isNum(ae) && isNum(S.lastPx) && p.open > 0 ? Math.round(p.dir * (S.lastPx - ae) * p.open * pv * 100) / 100 : null, block: p.block || null, closing: !!p.closing } : null;
      return { position, blocked: S.dispatch ? 'broker-state-unknown' : null, trades: h.trades.slice(), alerts: h.alerts.slice(), orderIds: [...new Set([...Object.values(S.ids || {}).map(String), ...(h.orderIds || [])])] }; },
    // the 3 s fast poll runs while an entry may still fill, or contracts are open without an acked stop (a fill is protected within ~3 s)
    fast: () => { if (S.dispatch) return false; if (!owned()) return false; const p = S.pos; if (S.needReconcile) return true;
      if (Object.values(p.orders).some(x => x.kind === 'entry' && ['sent', 'working', 'unknown'].includes(x.status))) return true;
      return p.open > 0 && !(p.stopKey && p.orders[p.stopKey] && p.orders[p.stopKey].status === 'working'); },
    // a taken TIDE signal. One TIDE position at a time; the planner sizes (money cfg) and refuses on its own config problem.
    signal: (sig, p, takeId) => serial(async () => {
      if (owned()) { log('  [tide-live] signal not taken: a TIDE position is already open.'); return { ok: false, why: 'owned' }; }
      if (!stateFile) return { ok: false, why: 'state-file-required' };
      if (typeof o.preCheck === 'function') { let w; try { w = await o.preCheck(sig); } catch (e) { w = `pre-check failed (${e.message})`; } if (w) { log(`  [tide-live] signal not taken: ${w}.`); return { ok: false, why: w }; } }   // the executor's own gates now (flat FSM, session)
      // one position account-wide: the broker shows NO position and NO working order on this contract (a manual order, a position not adopted yet, the old path)
      const readT0 = now();   // [r1.5.3] a slow read (> 3 s): the executor's gates are asked again before the entry
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
      const H = S.hist; S = blank(); S.hist = H; S.takeId = takeId || null; S.setup = sig.setupId || null; S.points = p.gradeDetail && isNum(p.gradeDetail.points) ? p.gradeDetail.points : null; S.pointNames = p.gradeDetail && Array.isArray(p.gradeDetail.names) ? p.gradeDetail.names : null; S.pos = T.initState(`tide-${now()}`); save();
      await run({ type: 'signal', dir: sig.dir, grade: p.grade, entryPx: sig.entry, entryType: p.entryType, stop: p.stop, riskMult: isNum(sig.riskMult) && sig.riskMult > 0 ? sig.riskMult : 1, htf: sig.htf || null, pools: Array.isArray(sig.pools) ? sig.pools : [], partialPools: Array.isArray(sig.internalPools) ? sig.internalPools : null });
      if (owned() && S.pos.plan && S.pos.plan.sizeCode === 'NO_FIT_TAKE1') { const pl = S.pos.plan; log(`  [tide-live] NO_FIT_TAKE1: 1 MNQ at a ${pl.stopPts}-pt stop risks $${pl.riskUsd} (budget $${pl.budgetUsd}).`); J('no_fit_take1', { stopPts: pl.stopPts, riskUsd: pl.riskUsd, budgetUsd: pl.budgetUsd });
 }   // [r1.1] the ENTRY push carries the take1 note
      if (!owned() && !S.endTold) { const why = (S.pos && S.pos.block) || 'refused by the planner'; S.pos = null; save(); return { ok: false, why }; }
      return { ok: true, phase: phase(), id: S.pos.id };
    }),
    // every main-loop poll: fills / cancels seen at the broker, the position check, then TP1-traded (1 lot) and the ladder
    poll: arg => serial(async () => { try { await pollInner(arg || {}); } catch (e) { if (S.dispatch) { dispatchAlert(); return; } throw e; } }),
    // the session close / daily floor / a manual exit: the planner's flatten lifecycle (one per position; a repeat is a no-op)
    exitAtMarket: reason => serial(async () => { if (S.dispatch) { dispatchAlert(); return false; } if (!owned()) return false; await run({ type: 'exit-at-market', reason, lastPx: S.lastPx }); return true; }),
    // startup: a saved TIDE position -> the keyless reconcile (the planner re-asserts the guard; no working stop -> it closes the position at once)
    start: () => serial(async () => {
      if (S.dispatch) { dispatchAlert(); return; }
      if (!owned()) { log(`  [tide-live] ${VERSION}: no TIDE position saved.`); return; }
      if (Object.values(S.pos.orders || {}).some(x => ['sent', 'unknown', 'working', 'cancel-sent'].includes(x.status))) { S.dispatch = { kind: 'restart', reason: 'saved order requires exact reconciliation' }; save(); dispatchAlert(); return; }
      log(`  [tide-live] ${VERSION}: resuming TIDE position ${S.pos.id} (${S.pos.phase}, ${S.pos.open}x): reconciling with the broker.`);
      J('restart', { phase: S.pos.phase, open: S.pos.open });
      try { await run(await snapshot(null)); } catch (e) { if (S.dispatch) { dispatchAlert(); return; } throw e; }
    }),
  };
}

module.exports = { VERSION, create, ENTRY_EXPIRE_MS };
