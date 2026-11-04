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
const DONE_PHASES = new Set(['FLAT', 'DONE']);

function create(o) {
  const { token, accountId, contractId, orders, cfgFn, log = () => {}, notify = () => {}, journal = () => {}, stateFile, now = () => Date.now(),
    sleep = ms => new Promise(r => setTimeout(r, ms)), onEnd = () => {}, onTp1 = () => {} } = o;
  const { OrderType, OrderSide, placeOrder, cancelOrder, getOpenPosition, getOpenOrders, getEntryOrder } = orders;
  const tokenOf = () => (typeof token === 'function' ? token() : token);
  let S = load();
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  function blank() { return { version: VERSION, pos: null, ids: {}, sentAt: {}, ev: 0, best: null, fillAt: null, closedAt: null, takeId: null, endTold: false, tp1Told: false, lastPx: null, guard: null, staleStop: null, pushed: {} }; }
  function load() {
    try { if (stateFile && fs.existsSync(stateFile)) { const d = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (d && d.version === VERSION) return { ...blank(), ...d }; log(`  [tide-live] state file ${path.basename(stateFile)} has another version: ignored (kept on disk).`); } }
    catch (e) { log(`  [tide-live] state file unreadable (${e.message}): starting empty; the restart reconcile decides.`); }
    return blank();
  }
  function save() {
    if (!stateFile) return;
    const tmp = `${stateFile}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, stateFile);
  }
  const ctx = () => ({ cfg: cfgFn() });
  function owned() { return !!(S.pos && S.pos.plan && !DONE_PHASES.has(S.pos.phase)); }   // a TIDE position exists (pending, open, closing, reversed)
  function phase() { return S.pos ? S.pos.phase : 'FLAT'; }
  const J = (what, data) => { try { journal({ type: 'lv_tide', phase: 'live_' + what, version: VERSION, t: now(), position: S.pos ? S.pos.id : null, take: S.takeId, ...data }); } catch (e) { /* journal only */ } };
  const P = (key, title, text, opts = { priority: 'high', tags: 'chart_with_upwards_trend' }) => { if (key && S.pushed[key]) return; if (key) S.pushed[key] = true; try { notify(title, text, opts); } catch (e) { /* push only */ } };

  // ---- one planner step per event, then every intent executed in order; results come back as events (a queue, bounded)
  async function run(firstEvent) {
    const q = [firstEvent]; let steps = 0;
    while (q.length) {
      if (++steps > MAX_STEPS) { log('  [tide-live] CRITICAL: the event loop did not settle (200 steps) - stopping this pass; the next poll continues.'); P(null, 'TIDE live: loop fence', 'The TIDE order loop hit its fence. Check the account.', { priority: 'urgent', tags: 'warning' }); break; }
      const ev = q.shift(); if (ev.id == null) ev.id = `${S.pos.id}:ev:${++S.ev}`;
      const r = T.plan(S.pos, ev, ctx()); S.pos = r.state; save();
      if (r.intents.length || (ev.type !== 'ladder' && ev.type !== 'tp1-traded')) J('step', { event: brief(ev), intents: r.intents.map(i => ({ op: i.op, kind: i.kind, qty: i.qty, price: i.price, key: i.key, code: i.code })), notes: r.notes, statePhase: r.state.phase });
      for (const it of r.intents) { const back = await exec(it); q.push(...back); save(); }
    }
    afterRun();
  }
  function afterRun() {
    const p = S.pos; if (!p) return;
    if (p.tp1Done && !S.tp1Told) { S.tp1Told = true; save(); try { onTp1(S.takeId); } catch (e) { /* feedback only */ } P(`tp1:${p.id}`, 'TIDE live: TP1', `TP1 done (${p.tp1Qty ? p.tp1Qty + 'x @ ' + p.tp1Px : '1 lot: price ' + p.tp1Px + ' traded'}); the stop goes to break-even + 1 tick. ${p.open}x open.`); }
    if (DONE_PHASES.has(p.phase) && p.plan && !S.endTold) {
      S.endTold = true; S.closedAt = now(); save();
      const rz = p.flat && p.flat.realized, ex = exitsOf(p), stopped = !p.tp1Done && ex.stop > 0 && !(ex.tp1 || ex.tp2 || ex.position);
      const filled = Object.values(p.orders).some(x => x.kind === 'entry' && x.filled > 0);
      const txt = filled ? `exit ${Object.entries(ex).map(([k, v]) => `${k} ${v}x`).join(', ') || '(no closing fill seen)'}${rz && rz.qty ? ` avg ${round(rz.avgPx)}` : ''}` : 'the entry never filled (cancelled)';
      log(`  [tide-live] position ${p.id} ${p.phase}: ${txt}.`);
      J('end', { exits: ex, realized: rz || null, tp1Done: p.tp1Done, stopped, entryFilled: filled });
      P(`end:${p.id}`, filled ? 'TIDE live: FLAT' : 'TIDE live: entry cancelled', `TIDE position ${p.id}: ${txt}. Flat.`, { priority: 'high', tags: 'checkered_flag' });
      try { onEnd(S.takeId, { closed: true, tp1Done: p.tp1Done, stopped, why: filled ? 'live-exit' : 'entry-not-filled' }); } catch (e) { /* feedback only */ }
    }
  }
  function exitsOf(p) { const ex = {}; for (const x of Object.values(p.orders)) if (x.kind !== 'entry' && x.kind !== 'add' && x.filled > 0) ex[x.kind === 'position' ? 'market' : x.kind] = (ex[x.kind === 'position' ? 'market' : x.kind] || 0) + x.filled; return ex; }
  const round = x => (isNum(x) ? Math.round(x * 100) / 100 : x);
  function brief(ev) { const { orders: os, ...rest } = ev; return os ? { ...rest, orders: os.length } : rest; }

  // ---- intents -> the broker (MAP.md rows)
  const sideNum = s => (s === 'BUY' ? OrderSide.BUY : OrderSide.SELL);
  const base = () => ({ accountId, contractId });
  const posSize = async () => { const p = await getOpenPosition(tokenOf(), accountId, contractId); return p ? p.size : 0; };
  async function cancelVerified(orderId) {
    for (let i = 0; i < 3; i++) {
      let ok = false; try { ok = await cancelOrder(tokenOf(), accountId, orderId); } catch (e) { ok = false; }
      let open; try { open = await getOpenOrders(tokenOf(), accountId, contractId); } catch (e) { open = null; }
      if (open && !open.some(x => String(x.id) === String(orderId))) return true;   // verified: no longer resting
      if (ok && open === null) continue;
    }
    return false;
  }
  function req(it, body, extra = {}) { J('order', { key: it.key, op: it.op, kind: it.kind, side: it.side, qty: body.size, type: body.type, limitPrice: body.limitPrice ?? null, stopPrice: body.stopPrice ?? null, ...extra }); }
  async function placed(it, body) {
    req(it, body);
    try {
      const d = await placeOrder(tokenOf(), body); const id = d && (d.orderId ?? d.id);
      if (id == null) { S.needReconcile = true; save(); return [{ type: 'no-ack', key: it.key, reason: 'no order id' }]; }
      S.ids[it.key] = id; S.sentAt[it.key] = now(); save();
      if (it.kind !== 'stop') return [{ type: 'ack', key: it.key }];
      // ruling 4: the broker-ACKED level = the stop price the broker shows resting for this order id
      let px = body.stopPrice, src = 'sent';
      try { const os = await getOpenOrders(tokenOf(), accountId, contractId); const r = os.find(x => String(x.id) === String(id)); if (r && isNum(r.stopPrice)) { px = r.stopPrice; src = 'broker'; } else if (!r) src = 'not-listed'; } catch (e) { src = 'unread'; }
      J('stop_ack', { key: it.key, orderId: id, sent: body.stopPrice, acked: px, source: src });
      return [{ type: 'ack', key: it.key, price: px }];
    } catch (e) {
      J('order_fail', { key: it.key, rejected: e.orderRejected === true, reason: e.message }); if (e.orderRejected !== true) { S.needReconcile = true; save(); }   // no answer: a keyless reconcile on the next poll
      return e.orderRejected === true ? [{ type: 'reject', key: it.key, reason: e.message, lastPx: S.lastPx }] : [{ type: 'no-ack', key: it.key, reason: e.message }];
    }
  }
  async function exec(it) {
    try {
      if (it.op === 'guard') { S.guard = it.position; save(); log(`  [tide-live] guard: position ${it.position} is planner-owned (the state machine's own post-fill path, adoption and every old-path entry are refused).`); J('guard', { position: it.position, reason: it.reason }); return []; }
      if (it.op === 'alert') { log(`  [tide-live] ALERT ${it.code}: ${it.text}`); J('alert', { code: it.code, text: it.text, level: it.level }); P(null, `TIDE live: ${it.code}`, it.text, { priority: it.level === 'critical' ? 'urgent' : 'high', tags: 'warning' }); return []; }
      if (it.op === 'place' && it.kind === 'entry') {
        const type = it.orderType === 'MARKET' ? OrderType.MARKET : it.orderType === 'STOP' ? OrderType.STOP : OrderType.LIMIT;
        const body = { ...base(), type, side: sideNum(it.side), size: it.qty, ...(type === OrderType.LIMIT ? { limitPrice: it.price } : type === OrderType.STOP ? { stopPrice: it.price } : {}) };
        log(`  [LIVE ORDER] TIDE entry: ${it.side} ${it.qty}x ${it.orderType}${type === OrderType.MARKET ? '' : ' @ ' + it.price} (${it.key})`);
        const back = await placed(it, body);
        if (back[0].type === 'ack') P(`entry:${it.key}`, `TIDE live: ${it.side === 'BUY' ? 'LONG' : 'SHORT'} entry sent`, `${it.side} ${it.qty} MNQ ${it.orderType}${type === OrderType.MARKET ? '' : ' @ ' + it.price}; stop ${S.pos.plan.stop} (structural, never widened).`);
        if (back[0].type === 'ack' && type === OrderType.MARKET) {   // a market order fills at once: read it back so the stop goes out in the same pass
          for (let i = 0; i < MARKET_FILL_READS; i++) { const h = await history(it.key, { quiet: i < MARKET_FILL_READS - 1 }); if (h.length) { back.push(...h); break; } await sleep(MARKET_FILL_WAIT_MS); }
        }
        return back;
      }
      if (it.op === 'place' && it.kind === 'stop') { log(`  [LIVE ORDER] TIDE stop: ${it.side} ${it.qty}x STOP @ ${it.price} (never widened; ${it.key})`);
        const back = await placed(it, { ...base(), type: OrderType.STOP, side: sideNum(it.side), size: it.qty, stopPrice: it.price });
        P(`stopplace:${it.key}`, back[0].type === 'ack' ? 'TIDE live: stop placed' : 'TIDE live: stop NOT placed', back[0].type === 'ack' ? `Stop ${back[0].price ?? it.price} for ${it.qty}x (protective, never widened).` : `The stop ${it.price} for ${it.qty}x was ${back[0].type} (${back[0].reason || ''}); the planner retries once at the same price or closes the position.`, { priority: 'high', tags: back[0].type === 'ack' ? 'shield' : 'warning' });
        return back; }
      if (it.op === 'place' && (it.kind === 'tp1' || it.kind === 'tp2')) {
        if ((await posSize()) !== it.expectOpen) return [{ type: 'reject', key: it.key, reason: `the position is not ${it.expectOpen}: target not sent` }];
        log(`  [LIVE ORDER] TIDE ${it.kind}: ${it.side} ${it.qty}x LIMIT @ ${it.price} (${it.key})`);
        return placed(it, { ...base(), type: OrderType.LIMIT, side: sideNum(it.side), size: it.qty, limitPrice: it.price });
      }
      if (it.op === 'place' && it.kind === 'add') { J('ADD_WOULD_FIRE', { qty: it.qty, price: it.price }); log(`  [tide-live] ADD_WOULD_FIRE ${it.qty}x @ ${it.price}: Stage 2a sends no pyramid add.`); return [{ type: 'reject', key: it.key, reason: 'Stage 2a: no pyramid add (addsEnabled false)' }]; }
      if (it.op === 'modify' && it.kind === 'stop') {   // the new stop first; the old one cancelled (verified) only after it is accepted
        log(`  [LIVE ORDER] TIDE stop change: ${it.qty}x STOP @ ${it.price} (replaces ${it.replaces}; never widened)`);
        const back = await placed(it, { ...base(), type: OrderType.STOP, side: sideNum(it.side), size: it.qty, stopPrice: it.price });
        if (back[0].type !== 'ack') return back;
        const old = S.ids[it.replaces];
        if (old != null && (await cancelVerified(old))) back.push({ type: 'cancel-ack', key: it.replaces });
        else if (old != null) { log(`  [tide-live] CRITICAL: the old stop ${old} could not be cancelled after its replacement was placed - two stops may rest. Retried every poll.`); P(null, 'TIDE live: old stop not cancelled', `Order ${old} would not cancel after its replacement. Check the account.`, { priority: 'urgent', tags: 'warning' }); S.staleStop = it.replaces; }
        P(`stop:${it.key}`, 'TIDE live: stop moved', `Stop now ${back[0].price ?? it.price} for ${it.qty}x (tighter only).`, { priority: 'default', tags: 'shield' });
        return back;
      }
      if (it.op === 'modify' && (it.kind === 'tp1' || it.kind === 'tp2')) {   // a target: the old one cancelled first (verified), then the new one
        const old = S.ids[it.replaces];
        if (old != null && !(await cancelVerified(old))) return [{ type: 'reject', key: it.key, reason: 'the old target could not be cancelled' }];
        if ((await posSize()) !== it.expectOpen) return [{ type: 'reject', key: it.key, reason: `the position is not ${it.expectOpen}: target not sent` }];
        log(`  [LIVE ORDER] TIDE ${it.kind} change: ${it.qty}x LIMIT @ ${it.price} (${it.key})`);
        return placed(it, { ...base(), type: OrderType.LIMIT, side: sideNum(it.side), size: it.qty, limitPrice: it.price });
      }
      if (it.op === 'cancel') {
        let id = S.ids[it.target];
        if (id == null) {   // no order id (never sent, or sent without an answer): never assume it is gone - match the broker's working orders first
          await snapshot(null);   // matches an id-less order by side / type / size / price (records its id)
          id = S.ids[it.target];
          if (id == null) { if (S.unreadable) return [{ type: 'reject', key: it.key, reason: 'open orders unreadable: the id-less order may still rest' }]; return [{ type: 'cancel-ack', key: it.target }]; }   // a fresh read shows nothing matching: not resting
        }
        log(`  [LIVE ORDER] TIDE cancel ${it.kind} ${id} (${it.reason})`); J('cancel', { key: it.key, target: it.target, orderId: id, reason: it.reason });
        if (await cancelVerified(id)) { const h = await history(it.target, { quiet: true }); return h.filter(e => e.type === 'fill').concat([{ type: 'cancel-ack', key: it.target }]); }   // a fill that won the race first
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
  async function history(key, { quiet = false } = {}) {
    const id = S.ids[key]; if (id == null) return [];
    let h; try { h = await getEntryOrder(tokenOf(), accountId, contractId, id, S.sentAt[key] || now()); } catch (e) { if (!quiet) log(`  [tide-live] order ${id} history not readable yet (${e.message}).`); return []; }
    const out = [], fv = Number(h.fillVolume) || 0, fp = Number(h.filledPrice), o = S.pos && S.pos.orders[key];
    if (fv > 0 && isNum(fp) && (!o || fv > (o.filled || 0))) {
      out.push({ type: o && fv < o.qty ? 'partial-fill' : 'fill', key, filledQty: fv, avgPx: fp });
      if (o) { const k = o.kind; log(`  [tide-live] FILL ${k} ${fv}x @ ${fp} (${key})`); J('fill', { key, kind: k, filledQty: fv, avgPx: fp });
        P(`fill:${key}:${fv}`, `TIDE live: ${k === 'entry' ? 'FILLED' : k === 'stop' ? 'STOPPED' : k === 'position' ? 'closed at market' : k.toUpperCase() + ' filled'}`, `${k} ${fv}x @ ${fp}.`, { priority: 'high', tags: k === 'stop' ? 'x' : 'white_check_mark' }); }
    }
    if (h.status === 3 || h.status === 4) out.push({ type: 'cancel-ack', key });
    if (h.status === 5) out.push({ type: 'reject', key, reason: 'rejected (history)', lastPx: S.lastPx });
    return out;
  }
  async function snapshot(key) {
    let p, os; S.unreadable = false;
    try { p = await getOpenPosition(tokenOf(), accountId, contractId); os = await getOpenOrders(tokenOf(), accountId, contractId); } catch (e) { S.unreadable = true; throw e; }
    const byId = {}; for (const [k, id] of Object.entries(S.ids)) byId[String(id)] = k;
    // an order of ours placed without an answer has no id: adopt a working broker order that matches it exactly (side, type, size, price), once
    if (S.pos) for (const o of Object.values(S.pos.orders)) {
      if (S.ids[o.key] != null || !['sent', 'unknown', 'working', 'cancel-sent'].includes(o.status)) continue;
      const type = o.orderType === 'MARKET' ? OrderType.MARKET : o.orderType === 'STOP' ? OrderType.STOP : OrderType.LIMIT, side = o.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL, want = o.wantPx;
      const m = os.find(x => !byId[String(x.id)] && x.type === type && x.side === side && x.size === o.qty - (o.filled || 0) && (type === OrderType.MARKET || (type === OrderType.STOP ? x.stopPrice : x.limitPrice) === want));
      if (m) { S.ids[o.key] = m.id; S.sentAt[o.key] = S.sentAt[o.key] || now(); byId[String(m.id)] = o.key; J('order_matched', { key: o.key, orderId: m.id }); log(`  [tide-live] the unanswered ${o.kind} ${o.key} is broker order ${m.id} (matched by side / type / size / price).`); }
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
    if (!owned()) return;
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
        save();
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
    // the 3 s fast poll runs while an entry may still fill, or contracts are open without an acked stop (a fill is protected within ~3 s)
    fast: () => { if (!owned()) return false; const p = S.pos; if (S.needReconcile) return true;
      if (Object.values(p.orders).some(x => x.kind === 'entry' && ['sent', 'working', 'unknown'].includes(x.status))) return true;
      return p.open > 0 && !(p.stopKey && p.orders[p.stopKey] && p.orders[p.stopKey].status === 'working'); },
    // a taken TIDE signal. One TIDE position at a time; the planner sizes (money cfg) and refuses on its own config problem.
    signal: (sig, p, takeId) => serial(async () => {
      if (owned()) { log('  [tide-live] signal not taken: a TIDE position is already open.'); return { ok: false, why: 'owned' }; }
      if (typeof o.preCheck === 'function') { let w; try { w = await o.preCheck(); } catch (e) { w = `pre-check failed (${e.message})`; } if (w) { log(`  [tide-live] signal not taken: ${w}.`); return { ok: false, why: w }; } }   // the executor's own gates now (flat FSM, session)
      // one position account-wide: the broker shows NO position and NO working order on this contract (a manual order, a position not adopted yet, the old path)
      let bp, bo; try { bp = await getOpenPosition(tokenOf(), accountId, contractId); bo = await getOpenOrders(tokenOf(), accountId, contractId); } catch (e) { log(`  [tide-live] signal not taken: the broker state is unreadable (${e.message}).`); return { ok: false, why: 'broker-unreadable' }; }
      if (bp && bp.size) { log(`  [tide-live] signal not taken: the broker shows a ${bp.size}x position.`); return { ok: false, why: 'broker-position' }; }
      if (bo && bo.length) { log(`  [tide-live] signal not taken: ${bo.length} working order(s) at the broker.`); return { ok: false, why: 'broker-orders' }; }
      { const c = cfgFn(), pts = Math.abs(sig.entry - p.stop), z = isNum(pts) ? T_MONEY.sizeFor(pts, p.grade, c) : null, cap = typeof o.take1MaxFn === 'function' ? o.take1MaxFn() : 400;   // the take1 ceiling (defence in depth: tideWire refuses first)
        if (z && z.code === 'NO_FIT_TAKE1' && !(z.riskUsd <= cap + 1e-9)) { log(`  [tide-live] signal not taken: 1 MNQ risks $${z.riskUsd} > the take1 ceiling $${cap} (GRADE_NO_FIT_CEILING).`); return { ok: false, why: 'GRADE_NO_FIT_CEILING' }; } }
      S = blank(); S.takeId = takeId || null; S.pos = T.initState(`tide-${now()}`); save();
      await run({ type: 'signal', dir: sig.dir, grade: p.grade, entryPx: sig.entry, entryType: p.entryType, stop: p.stop, pools: Array.isArray(sig.pools) ? sig.pools : [], partialPools: Array.isArray(sig.internalPools) ? sig.internalPools : null });
      if (owned() && S.pos.plan && S.pos.plan.sizeCode === 'NO_FIT_TAKE1') { const pl = S.pos.plan; log(`  [tide-live] NO_FIT_TAKE1: 1 MNQ at a ${pl.stopPts}-pt stop risks $${pl.riskUsd} (budget $${pl.budgetUsd}).`); J('no_fit_take1', { stopPts: pl.stopPts, riskUsd: pl.riskUsd, budgetUsd: pl.budgetUsd });
        P(`take1:${S.pos.id}`, 'TIDE live: 1 MNQ over budget', `The ${pl.stopPts}-pt structural stop does not fit $${pl.budgetUsd}: 1 MNQ is taken (noFit take1), actual risk $${pl.riskUsd}.`, { priority: 'high', tags: 'warning' }); }
      if (!owned() && !S.endTold) { const why = (S.pos && S.pos.block) || 'refused by the planner'; S.pos = null; save(); return { ok: false, why }; }
      return { ok: true, phase: phase(), id: S.pos.id };
    }),
    // every main-loop poll: fills / cancels seen at the broker, the position check, then TP1-traded (1 lot) and the ladder
    poll: arg => serial(() => pollInner(arg || {})),
    // the session close / daily floor / a manual exit: the planner's flatten lifecycle (one per position; a repeat is a no-op)
    exitAtMarket: reason => serial(async () => { if (!owned()) return false; await run({ type: 'exit-at-market', reason, lastPx: S.lastPx }); return true; }),
    // startup: a saved TIDE position -> the keyless reconcile (the planner re-asserts the guard; no working stop -> it closes the position at once)
    start: () => serial(async () => {
      if (!owned()) { log(`  [tide-live] ${VERSION}: no TIDE position saved.`); return; }
      log(`  [tide-live] ${VERSION}: resuming TIDE position ${S.pos.id} (${S.pos.phase}, ${S.pos.open}x): reconciling with the broker.`);
      J('restart', { phase: S.pos.phase, open: S.pos.open });
      await run(await snapshot(null));
    }),
  };
}

module.exports = { VERSION, create, ENTRY_EXPIRE_MS };
