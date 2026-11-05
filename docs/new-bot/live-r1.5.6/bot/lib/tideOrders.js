'use strict';
// OFFLINE CANDIDATE r0. This variant is coupled to tideLive candidate and its
// explicitly verified execution-safety contract; not a standalone live upgrade.
// tideOrders r1.2 (Stage 2a groundwork, MacMoney): the TIDE order PLANNER. PURE: no I/O, no clock, no timers, no broker calls, nothing from live-executor.js.
// It ships OFF: nothing calls it unless Mac switches Stage 2 on. The executor turns its intents into its OWN existing primitives (MAP.md).
//   plan(state, event, ctx) -> { intents, state, notes }   (state is never mutated; the returned state is a new JSON-safe object)
//   configProblem(cfg) -> null | text   (the executor refuses to start Stage 2 on a non-null answer)
//   intent = { op: guard | place | modify | cancel | flatten | read | alert, kind: entry | stop | tp1 | tp2 | add | position | alert, side: BUY | SELL, qty, price,
//              orderType: LIMIT | STOP | MARKET, key (position id : kind : seq), replaces? (the order a modify replaces), target? (the order a cancel removes),
//              expectOpen (the open quantity the intent assumes), noWiden (stops), ... }
// MacArthur's rulings (r1.1) on the r1 open questions:
//   1. OWNER: for a TIDE position the planner alone emits every post-fill order (stop, TP1, TP2, add, flatten). A `guard` intent goes out BEFORE the entry:
//      the executor flags the position so the FSM's own post-fill bracket path is refused (one TIDE fill = exactly one stop).
//   2. No resting B half in Stage 2a: configProblem refuses sizing.entryByGrade true (and the grade-upgrade add, which this planner does not run).
//   3. NO WIDENING, EVER: stop intents carry noWiden (placeProtectiveStop's widen-on-reject OFF). A rejected stop: the level already crossed -> the flatten
//      lifecycle; else ONE retry at the SAME price; a second reject -> alert + block, whatever protects stays (a later crossing of the level -> flatten).
//      r1.2 (MacArthur): a TIDE position with NO working protective stop is never left open: a second reject with no stop resting -> the flatten lifecycle at
//      once (+ alert); a reconcile (a restart included) that finds open contracts without a working stop -> the flatten lifecycle at once (+ alert).
//   4. The planner records the BROKER-ACKED stop price, never its own. An ack looser than the protective stop it replaces (or than the structural stop) is
//      alerted, blocks, and is tightened back at once. An ack between the two (a fallback level) is adopted as the level.
//   5. The pyramid add: money.addAllowed (house money at the acked stop) first; then the stop is TIGHTENED to the combined break-even + 1 tick at the add's
//      limit price (when tighter) and acked BEFORE the add is sent; the stop quantity is resized on the add's fill; an add that never fills leaves the tighter stop.
//   6. The FLATTEN uses the reviewed sessionFlatten order: non-protective orders cancelled -> the stop cancelled (VERIFIED; not verified -> no market order:
//      one retry, then alert, the stop keeps working) -> a position read -> a market close of exactly that quantity -> a second read; terminal only on a read of
//      0. The market order rejected / unacknowledged / ending with contracts left -> the protective stop is re-placed at its last ACKED price at once + alert.
//      ONE flatten per position (a continuation only for what a read shows left after a confirmed end). Exit fills are recorded against the ladder price.
//      A closing fill larger than the position or a read on the opposite side: alert, our closing orders cancelled, nothing else sent (backstop).
// Kept from r1: idempotency (an event already seen gives nothing), the stop sized to the open quantity and only tightening (money.nextStop with lastPx),
//   reserved exposure (open + live entry/add remainders <= maxContracts and <= the budget), TP1 2/3 (money.partialFor) -> break-even, TP2 the rest,
//   fail closed on unknown / late / rejected broker state (block + alert; only a clean reconcile clears it). NO daily loss limit, no timed exits.
const money = require('./moneyRule');
const VERSION = 'tideOrders-r1.2';   // r1.2 + [2a] MacLive 11/04: a NO_FIT_TAKE1 plan's exposure budget = its 1-MNQ risk (the take1 ceiling is enforced upstream: tideWire + tideLive)
const EPS = 1e-9;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const r2 = x => Math.round(x * 100) / 100;
const OPENING = new Set(['entry', 'add']);
const LIVE = new Set(['sent', 'working', 'unknown', 'cancel-sent']);   // an order that may still rest at the broker (and may still fill)
const KEEP_STOP_PHASES = new Set(['clearing', 'reprotect', 'stalled', 'cancel-failed']);   // flatten phases in which the protective stop must rest

function configProblem(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : null, s = (c && c.sizing) || {};
  if (!c) return 'tideOrders needs the money cfg';
  if (s.entryByGrade === true) return 'tideOrders r1.1 (Stage 2a): sizing.entryByGrade true (the resting B half) needs a second FSM entry slot (Stage 2c): set it false';
  if (s.upgradeAdd && s.upgradeAdd.enabled === true) return 'tideOrders r1.1 (Stage 2a) has no grade-upgrade add: set sizing.upgradeAdd.enabled false';
  const m = money.problem(c); return m ? `money: ${m}` : null;
}
function initState(id) {
  if (typeof id !== 'string' || !id) throw new Error('tideOrders.initState needs a position id');
  return { version: VERSION, id, seq: 0, phase: 'FLAT', dir: null, grade: null, plan: null, orders: {}, intents: {}, guardSent: false, stopKey: null, stopNext: null,
    stopPx: null, protPx: null, stopHist: [], stopRetry: null, stopFailed: null, open: 0, tp1Done: false, tp1Traded: false, R: null, tp1Px: null, tp1Qty: 0, tp2Px: null,
    originalContracts: null, addsDone: 0, addPending: null, restPlaced: false, closing: false, flat: null, block: null, alerted: {}, seen: [] };
}
const clone = s => JSON.parse(JSON.stringify(s));
function stable(v) { if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`; if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`; return JSON.stringify(v); }
const eventId = ev => (ev && ev.id != null ? `id:${ev.id}` : `ev:${stable(ev)}`);
const sideOf = (dir, closing) => ((dir === 1) !== closing ? 'BUY' : 'SELL');
function cfgOf(ctx) { const c = ctx && ctx.cfg; if (!c || typeof c !== 'object') throw new Error('tideOrders.plan needs ctx.cfg (the money cfg the executor sizes with)'); return c; }
function pvOf(cfg) { return isNum(cfg.pointValue) && cfg.pointValue > 0 ? cfg.pointValue : 2; }
function tickOf(cfg) { return isNum(cfg.tickSize) && cfg.tickSize > 0 ? cfg.tickSize : 0.25; }

// ---------------------------------------------------------------- derived position facts
function avgEntry(st) {
  let q = 0, v = 0;
  for (const o of Object.values(st.orders)) if (OPENING.has(o.kind) && o.filled > 0 && isNum(o.avgPx)) { q += o.filled; v += o.filled * o.avgPx; }
  return q ? v / q : null;
}
const remaining = o => Math.max(0, o.qty - (o.filled || 0));
const liveOf = (st, kind) => Object.values(st.orders).filter(o => o.kind === kind && LIVE.has(o.status));
const entryLeg = (st, leg) => Object.values(st.orders).find(o => o.kind === 'entry' && o.leg === leg) || null;
const terminal = o => !o || !LIVE.has(o.status);
// Reserved exposure: what could be open if every live opening order filled, and its risk at the stop. extra = { qty, px } being considered.
function exposure(st, ctx, extra = null) {
  const cfg = cfgOf(ctx), pv = pvOf(cfg), stop = isNum(st.protPx) ? st.protPx : st.stopPx, dir = st.dir, avg = avgEntry(st);
  let reservedRestingQty = 0, inflightQty = 0, risk = 0;
  if (st.open > 0 && isNum(avg) && isNum(stop)) risk += st.open * dir * (avg - stop) * pv;
  for (const o of Object.values(st.orders)) {
    if (!OPENING.has(o.kind) || !LIVE.has(o.status)) continue;
    const q = remaining(o); if (!q) continue;
    if (o.kind === 'entry' && o.leg === 2) reservedRestingQty += q; else inflightQty += q;
    if (isNum(o.price) && isNum(stop)) risk += q * dir * (o.price - stop) * pv;
  }
  let extraQty = 0; if (extra && extra.qty > 0) { extraQty = extra.qty; if (isNum(extra.px) && isNum(stop)) risk += extra.qty * dir * (extra.px - stop) * pv; }
  const sz = cfg.sizing || {}, totalQty = st.open + reservedRestingQty + inflightQty + extraQty, maxContracts = Number.isInteger(sz.maxContracts) ? sz.maxContracts : money.DEFAULTS.sizing.maxContracts;
  const budgetUsd = st.plan ? st.plan.budgetUsd : null;
  return { openQty: st.open, reservedRestingQty, inflightQty, extraQty, totalQty, riskUsd: r2(risk), maxContracts, budgetUsd,
    ok: totalQty <= maxContracts && (budgetUsd === null || risk <= budgetUsd + EPS) };
}

// ---------------------------------------------------------------- the planner
function plan(state, event, ctx) {
  const st = clone(state), out = [], notes = [], cfg = cfgOf(ctx), ev = event || {}, tick = tickOf(cfg);
  const safeExit = ctx.executionSafetyContract === 'tide-safety-r1';
  if (st.version !== VERSION) throw new Error(`tideOrders: state version ${st.version} is not ${VERSION}`);
  const eid = eventId(ev);
  if (st.seen.includes(eid)) return { intents: [], state: st, notes: ['duplicate-event'] };
  st.seen.push(eid);
  const key = kind => `${st.id}:${kind}:${++st.seq}`;
  const emit = (it) => { st.intents[it.key] = { op: it.op, kind: it.kind, target: it.target || it.replaces || null }; out.push(Object.freeze(it)); return it; };
  const alert = (code, text, level = 'critical') => { if (st.alerted[code]) return; st.alerted[code] = true; emit({ op: 'alert', kind: 'alert', level, code, text, key: key('alert') }); };
  const block = (code, text) => { if (!st.block) st.block = code; alert(code, text); notes.push(`block:${code}`); };
  const newOrder = (k, kind, o) => { st.orders[k] = { key: k, kind, leg: o.leg || null, side: o.side, orderType: o.orderType, qty: o.qty, price: kind === 'stop' ? null : o.price, wantPx: o.price, status: 'sent', filled: 0, avgPx: null }; };
  const placeOrder = (kind, o) => { const k = key(kind); newOrder(k, kind, o);
    return emit({ op: 'place', kind, side: o.side, qty: o.qty, price: o.price, orderType: o.orderType, key: k, ...(o.leg ? { leg: o.leg } : {}), ...(kind === 'stop' ? { noWiden: true } : {}), expectOpen: st.open }); };
  let quietRead = false;

  switch (ev.type) {
    case 'signal': onSignal(); break;
    case 'ack': onAck(); break;
    case 'fill': case 'partial-fill': onFill(); break;
    case 'cancel-ack': onCancelAck(); break;
    case 'order-superseded': { const old=st.orders[ev.key]; if(old&&LIVE.has(old.status)){old.status='superseded';if(st.stopKey===old.key)st.stopKey=null;} break; }
    case 'reject': onReject(); break;
    case 'no-ack': case 'unknown': onUnknown(); break;
    case 'tp1-traded': onTp1Traded(); break;
    case 'ladder': onLadder(); break;
    case 'pullback-add': onAdd(); break;
    case 'exit-at-market': startFlatten(ev.reason || 'exit-at-market requested', { lastPx: ev.lastPx, ladderPx: ev.ladderPx }); break;
    case 'reconcile': onReconcile(); break;
    default: block('unknown-event', `tideOrders got an event it does not know (${JSON.stringify(ev.type)}): new entries and adds are blocked until a clean reconcile.`);
  }
  sync();
  st.phase = phaseOf();
  return { intents: out, state: st, notes };

  // ---- events
  function onSignal() {
    if (st.phase !== 'FLAT' || st.plan) { notes.push('signal-refused:not-flat'); return; }
    if (st.block) { notes.push(`signal-refused:blocked:${st.block}`); return; }
    const cp = configProblem(cfg); if (cp) { notes.push('signal-refused:config'); alert('config-problem', cp); return; }
    const dir = ev.dir, okGeo = (dir === 1 || dir === -1) && isNum(ev.entryPx) && isNum(ev.stop) && dir * (ev.entryPx - ev.stop) > 0 && money.gradeKey(ev.grade);
    if (!okGeo) { notes.push('signal-refused:invalid'); return; }
    const cfgR = money.withRiskMult(cfg, ev.riskMult);   // [r1.5.6] preserve HTF-adjusted budget and existing one-MNQ minimum
    const stopPts = Math.abs(ev.entryPx - ev.stop), sz = money.scaleInPlan(stopPts, ev.grade, cfgR), z = money.sizeFor(stopPts, ev.grade, cfgR);
    if (!(sz.total >= 1)) { notes.push(`signal-refused:${z.code || z.reason}`); return; }
    st.dir = dir; st.grade = money.gradeKey(ev.grade) === 'A' ? 'A+' : money.gradeKey(ev.grade); st.stopPx = ev.stop;
    st.plan = { entryPx: ev.entryPx, entryType: ev.entryType === 'MARKET' || ev.entryType === 'STOP' ? ev.entryType : 'LIMIT', stop: ev.stop, stopPts: r2(stopPts),
      contracts: sz.total, first: sz.first, second: sz.second, entry2Px: isNum(ev.entry2Px) ? ev.entry2Px : null, pools: ev.pools || [], partialPools: ev.partialPools || null,
      budgetUsd: z.code === 'NO_FIT_TAKE1' && isNum(z.riskUsd) ? Math.max(z.budgetUsd, z.riskUsd) : z.budgetUsd, riskUsd: z.riskUsd, sizeCode: z.code, mode: z.mode };
    const ex = exposure(st, ctx, { qty: sz.first, px: ev.entryPx });
    if (!ex.ok) { notes.push('signal-refused:exposure-cap'); st.plan = null; st.dir = null; st.grade = null; st.stopPx = null; return; }
    guard('the TIDE position is planner-owned');
    placeOrder('entry', { leg: 1, side: sideOf(dir, false), qty: sz.first, price: ev.entryPx, orderType: st.plan.entryType });
  }
  function guard(why) { emit({ op: 'guard', kind: 'position', key: key('position'), fsmPostFill: 'refuse', owner: VERSION, position: st.id, reason: why }); st.guardSent = true; }
  function orderOf(k) { const o = k != null ? st.orders[k] : null; return o || null; }
  function onAck() {
    const o = orderOf(ev.key); if (!o) { if (st.intents[ev.key]) { notes.push('ack-noted'); return; } return unknownOrder(); }
    if (o.kind === 'stop') return onStopAck(o);
    if (o.status === 'sent' || o.status === 'unknown') o.status = 'working';
    if (isNum(ev.price) && o.kind !== 'position') o.price = ev.price;
    const it = st.intents[ev.key];
    if (it && it.op === 'modify' && it.target && (o.kind === 'tp1' || o.kind === 'tp2')) { const prev = st.orders[it.target]; if (prev && LIVE.has(prev.status)) prev.status = 'cancelled'; }   // a TP modify cancels first
  }
  // Ruling 4: the level the broker ACCEPTED is the level (replaceStopSafely may place a different, valid one). Never the planner's own wish.
  function onStopAck(o) {
    if (o.status === 'sent' || o.status === 'unknown') o.status = 'working';
    const P = isNum(ev.price) ? ev.price : null, wasNext = o.key === st.stopNext, old = wasNext ? st.stopKey : null;
    const prev = old && st.orders[old] ? st.orders[old].price : (isNum(st.protPx) ? st.protPx : null), ref = isNum(prev) ? prev : st.plan.stop;
    o.price = P;
    if (wasNext) { st.stopKey = o.key; st.stopNext = null; if (old && st.orders[old] && LIVE.has(st.orders[old].status)) st.orders[old].status = 'cancel-sent'; }   // replaceStopSafely cancels the old one (verified)
    st.stopRetry = null; st.stopFailed = null;
    if (P === null) { block('stop-price-unknown', `The broker accepted the stop ${o.key} without a price: its level is unknown, so it is not changed until a reconcile reads it.`); return; }
    st.protPx = P; if (st.stopHist[st.stopHist.length - 1] !== P) st.stopHist.push(P);
    if (st.dir * (P - ref) < -EPS) {   // looser than the stop it replaced (or than the structural stop): a widening. Alert, block, tighten back now (st.stopPx keeps the tighter level).
      block('stop-looser', `The broker placed the stop at ${P}, LOOSER than the protective level ${ref}. Stops never widen: it is tightened back at once; entries and adds are blocked.`);
      if (st.dir * (st.stopPx - ref) < -EPS) st.stopPx = ref;
    } else if (st.dir * (P - st.stopPx) < -EPS) { notes.push(`stop-fallback-level:${P}`); st.stopPx = P; }   // tighter than before but short of the wish: the broker's level is the level
    if (st.addPending && st.addPending.waitKey === o.key) {
      const a = st.addPending; st.addPending = null;
      if (st.dir * (P - a.hm) >= -EPS && !st.block) sendAdd(a); else notes.push('add-refused:stop-raise-short');
    }
  }
  function onFill() {
    const o = orderOf(ev.key); if (!o) return unknownOrder();
    if (!(Number.isInteger(ev.filledQty) && ev.filledQty >= 0 && ev.filledQty <= o.qty) || !isNum(ev.avgPx)) return block('bad-fill', `A fill for ${o.key} could not be read (${JSON.stringify(ev)}). Entries and adds are blocked; the stop stays.`);
    const delta = ev.filledQty - (o.filled || 0);
    if (delta <= 0) { notes.push('fill-already-counted'); return; }
    const incPx = (ev.filledQty * ev.avgPx - (o.filled || 0) * (o.avgPx || 0)) / delta;   // this fill's own price (the event carries the cumulative average)
    o.filled = ev.filledQty; o.avgPx = ev.avgPx; if (o.filled === o.qty) o.status = 'done'; else if (o.status === 'sent') o.status = 'working';
    if (OPENING.has(o.kind)) st.open += delta;
    else {
      if (st.flat) st.flat.exits.push({ kind: o.kind, qty: delta, px: incPx });
      if (delta > st.open) { const over = delta - st.open; st.open = 0; overClose(over, o); return; }
      st.open -= delta;
      if (st.flat && st.open === 0) { fillsSayFlat(); return; }
      if (st.flat && o.kind === 'position' && o.status === 'done' && st.open > 0) { reprotect('continue', 'the market close ended with contracts left'); return; }
    }
    if (o.kind === 'entry' && o.leg === 1 && o.status === 'done') afterEntryComplete();
    else if (o.kind === 'entry' && o.leg === 2 && !st.tp1Done) replanTargets();
    if (o.kind === 'tp1' && o.status === 'done') afterTp1();
    if (o.kind === 'stop' && st.open === 0) notes.push('stopped-out');
  }
  function onCancelAck() {
    const o = orderOf(ev.key); if (!o) return unknownOrder();
    if (LIVE.has(o.status)) o.status = o.filled > 0 && o.filled === o.qty ? 'done' : 'cancelled';
    if (o.kind === 'stop' && ev.key === st.stopKey) { st.stopKey = null; if (st.open > 0 && !st.flat) { naked('terminal history confirms protective stop cancellation'); return; } }
    if (o.kind === 'entry' && o.leg === 1) afterEntryComplete();
    if (o.kind === 'position' && st.flat && (st.flat.phase === 'sent' || st.flat.phase === 'stalled')) { if (st.open > 0) reprotect('continue', 'the market close ended with contracts left'); else readPosition('the market close ended'); }
  }
  function onReject() {
    const it = st.intents[ev.key], o = orderOf(ev.key);
    if (!it) return unknownOrder();
    if (it.op === 'flatten') { if (o) o.status = 'rejected'; reprotect('rejected', 'the market close was rejected'); block('flatten-rejected', `The market close was rejected (${ev.reason || 'no reason'}): the protective stop is re-placed at its last acked price at once; no second flatten is sent. Check the account.`); return; }
    if (it.op === 'read' && st.flat && ev.key !== st.flat.readKey) { notes.push('stale-read-failure'); return; }
    if (it.op === 'read') { if (st.intents[ev.key]) st.intents[ev.key].answered = true; block('read-failed', `The position read for the flatten failed (${ev.reason || ''}): retried on the next event.`); if (st.flat) st.flat.readKey = null; quietRead = true; return; }
    if (it.op === 'cancel') {
      const tg = orderOf(it.target); if (tg && tg.status === 'cancel-sent') tg.status = 'working';
      if (tg && tg.kind === 'stop' && st.flat && st.flat.phase === 'cancel-stop') {   // ruling 6: the stop cancel is NOT verified -> no market order; one retry, then alert
        st.flat.cancelTries = (st.flat.cancelTries || 0) + 1;
        if (st.flat.cancelTries < 2) { cancelOrder(tg.key, 'flatten: retry the stop cancel (not verified)', true); return; }
        st.flat.phase = 'cancel-failed'; st.stopKey = tg.key;
        block('stop-cancel-failed', `The stop ${tg.key} could not be cancelled (verified) for the flatten: NO market order is sent; the stop keeps working. Check the account.`); return;
      }
      block('cancel-rejected', `A cancel of ${it.target} was not confirmed (${ev.reason || ''}); it may still rest.`); return;
    }
    if (o) o.status = 'rejected';
    if (o && o.kind === 'stop') return onStopReject(o);
    if (o && o.kind === 'entry' && o.leg === 1) { if (!o.filled) notes.push('entry-rejected'); else afterEntryComplete(); return block('entry-rejected', `The entry was rejected (${ev.reason || ''}).`); }
    if (o && o.kind === 'add') { st.addsDone = Math.max(st.addsDone, 1); return block('add-rejected', `The add was rejected (${ev.reason || ''}); no further add.`); }
    if (it.op === 'modify' && it.target && st.orders[it.target] && LIVE.has(st.orders[it.target].status)) st.orders[it.target].status = 'cancelled';   // a TP modify had cancelled the old one first
    block(`${it.kind}-rejected`, `The ${it.kind} order was rejected (${ev.reason || ''}); the stop keeps protecting. No new targets, entries or adds until a clean reconcile.`);
  }
  // Ruling 3: never wider. Crossed -> the flatten; else the SAME price once more; then alert + block, keeping whatever protects.
  function onStopReject(o) {
    if (o.key === st.stopNext) st.stopNext = null;
    if (st.addPending && st.addPending.waitKey === o.key) { st.addPending = null; notes.push('add-refused:stop-raise-rejected'); }
    if (!(st.open > 0) || st.flat && !KEEP_STOP_PHASES.has(st.flat.phase) && st.flat.phase !== 'rejected') return;
    if (isNum(ev.lastPx) && st.dir * (ev.lastPx - o.wantPx) <= EPS) {   // the level is already crossed: the exit (never a wider stop)
      st.stopFailed = { px: o.wantPx, qty: o.qty }; st.stopRetry = null;   // an unplaceable level is not re-sent
      if (!st.flat) startFlatten(`the stop at ${o.wantPx} was rejected and the market (${ev.lastPx}) is already through it`, { lastPx: ev.lastPx, ladderPx: o.wantPx });
      else if (st.flat.phase === 'reprotect' && st.flat.after === 'continue') { st.flat.phase = 'cancel-stop'; notes.push('reprotect-crossed:continue-the-exit'); }
      else alert('stop-crossed', `The stop at ${o.wantPx} was rejected and the market (${ev.lastPx}) is through it; no second flatten is sent. Check the account.`);
      return;
    }
    const same = st.stopRetry && st.stopRetry.px === o.wantPx && st.stopRetry.qty === o.qty;
    if (!same) { st.stopRetry = { px: o.wantPx, qty: o.qty, tries: 1 }; notes.push('stop-retry-same-price'); emitStop(o.qty, o.wantPx); return; }
    st.stopRetry = null; st.stopFailed = { px: o.wantPx, qty: o.qty };
    const cover = st.stopKey && st.orders[st.stopKey];
    if (!cover || remaining(cover) !== st.open || cover.status !== 'working') return naked(`the stop at ${o.wantPx} was rejected twice (${ev.reason || ''}); never widened`);
    else block('stop-rejected', `The stop change to ${o.wantPx} was rejected twice (${ev.reason || ''}); the previous stop keeps protecting. Entries and adds are blocked until a clean reconcile.`);
  }
  // r1.2: open contracts with no working protective stop are never left open: the flatten lifecycle at once (+ alert). Inside a flatten: the exit goes on.
  function naked(why) {
    alert('no-stop', `NO protective stop works for ${st.open} contracts (${why}): the position is closed at market now (flatten lifecycle).`);
    notes.push('naked:flatten');
    if (!st.flat) { startFlatten(`naked: ${why}`, { lastPx: ev.lastPx, ladderPx: st.stopPx }); if (st.flat) st.flat.naked = true; if (!st.block) st.block = 'no-stop'; return; }
    const F = st.flat;
    if (F.phase === 'reprotect' && F.after === 'continue') { F.phase = 'cancel-stop'; return; }
    if (F.phase === 'reprotect' && F.holdAs === 'rejected' && !F.nakedRetry) { F.nakedRetry = true; F.after = 'continue'; F.holdAs = null; F.phase = 'cancel-stop'; st.closing = true;
      alert('naked-retry', 'The market close was rejected AND the protective stop could not be re-placed: ONE more market close is sent (a position is never left without protection).'); return; }
    alert('naked-open', `The position is open with NO working stop and the exit cannot proceed on its own (${F.phase}/${F.holdAs || F.after}): close it by hand NOW.`);
  }
  function onUnknown() {
    const ri = st.intents[ev.key];
    if (ri && ri.op === 'read' && st.flat) { if (ev.key !== st.flat.readKey) return; ri.answered = true; st.flat.readKey = null; quietRead = true; block('read-failed', 'Position read unresolved; retained protection and invalidated this read generation.'); return; }
    const o = orderOf(ev.key); if (o && o.status === 'sent') o.status = 'unknown';
    if (o && o.kind === 'position' && st.flat) { reprotect('stalled', 'no answer for the market close'); readPosition('no answer for the market close: never re-sent; the position is read'); }
    block('broker-state-unknown', `No answer for ${ev.key} (${ev.reason || 'no ack'}): treated as possibly working. Entries and adds are blocked; the protection stays until a reconcile.`);
  }
  function unknownOrder() { block('unknown-order', `An event names an order this position does not know (${JSON.stringify(ev.key)}). Entries and adds are blocked until a reconcile.`); }
  function onTp1Traded() {
    if (!(st.open > 0) || st.flat) return;
    st.tp1Traded = true;
    if (st.tp1Qty === 0 && !st.tp1Done) afterTp1();   // a 1-lot has no TP1 order: TP1 counts as done once its price trades
    cancelRestingIf('tp1-reached');
  }
  function onLadder() {
    if (!(st.open > 0) || !isNum(st.R)) return;
    const flatRejected = !!(st.flat && st.flat.phase === 'rejected');
    if (st.flat && !flatRejected) return;
    if (st.stopFailed && isNum(ev.lastPx) && st.dir * (ev.lastPx - st.stopFailed.px) <= EPS && !flatRejected) { startFlatten(`the unplaceable stop level ${st.stopFailed.px} is now crossed (last ${ev.lastPx})`, { lastPx: ev.lastPx, ladderPx: st.stopFailed.px }); return; }
    if (liveOf(st, 'entry').some(o => o.leg === 2)) {
      const rc = money.restingCancel({ dir: st.dir, bestPx: ev.bestPx, tp1Px: st.tp1Px, tp1Done: st.tp1Done, invalidated: ev.invalidated === true, closed: false });
      if (rc.cancel) cancelRestingIf(rc.reason);
    }
    const ns = money.nextStop({ dir: st.dir, entry: avgEntry(st), R: st.R, bestPx: ev.bestPx, currentStop: st.stopPx, lastPx: ev.lastPx, majorSwept: ev.majorSwept === true,
      swings15m: ev.swings15m, climax: ev.climax === true, swings5m: ev.swings5m, cfg });
    notes.push(`ladder:${ns.action}`);
    if (ns.action === 'place') tighten(ns.stop, `protect: ${ns.by}`);
    else if (ns.action === 'exit-at-market') { if (flatRejected) notes.push('flatten-already:rejected'); else startFlatten(`the ladder lock ${ns.ladder && ns.ladder.wantStop} was already crossed (last ${ev.lastPx})`, { lastPx: ev.lastPx, ladderPx: ns.ladder && ns.ladder.wantStop }); }
  }
  // Ruling 5: addAllowed at the ACKED stop; then the stop is tightened to the combined break-even + 1 tick at the add's limit (when tighter) and ACKED before the add goes.
  function onAdd() {
    if (st.block) { notes.push(`add-refused:blocked:${st.block}`); return; }
    if (!(st.open > 0) || st.closing || st.flat) { notes.push('add-refused:not-open'); return; }
    if (liveOf(st, 'add').length || st.addPending) { notes.push('add-refused:add-in-flight'); return; }
    if (st.stopNext || !isNum(st.protPx)) { notes.push('add-refused:stop-not-settled'); return; }
    const a = money.addAllowed({ dir: st.dir, runner: { entry: avgEntry(st), contracts: st.open }, originalContracts: st.originalContracts, addPx: ev.addPx, stop: st.protPx,
      tp2: st.tp2Px, tp1Done: st.tp1Done, addsDone: st.addsDone, bias: ev.bias, control4h: ev.control4h, rejection: ev.rejection, cfg });
    if (!a.ok) { notes.push(`add-refused:${a.reason}`); return; }
    const ex = exposure(st, ctx, { qty: a.qty, px: ev.addPx });
    if (!ex.ok) { notes.push('add-refused:exposure-cap'); return; }
    const combinedAt = (st.open * avgEntry(st) + a.qty * ev.addPx) / (st.open + a.qty), hm = money.beStopAfterPartial(combinedAt, st.dir, cfg);
    const want = money.stopOnlyInFavour(st.protPx, hm, st.dir), mkt = isNum(ev.lastPx) ? ev.lastPx : ev.addPx;
    const add = { qty: a.qty, px: ev.addPx, hm };
    if (st.dir * (want - st.protPx) > EPS) {
      if (!(st.dir * (mkt - want) >= tick - EPS)) { notes.push('add-refused:raise-not-placeable'); return; }
      tighten(want, 'house money for the add (before it is sent)'); syncStop();
      if (!st.stopNext) { notes.push('add-refused:raise-not-sent'); return; }
      st.addPending = { ...add, waitKey: st.stopNext }; notes.push('add-waits-for-the-stop-raise'); return;
    }
    sendAdd(add);
  }
  function sendAdd(a) {
    st.addsDone = 1;   // counted when SENT (persisted): a restart can never add twice
    placeOrder('add', { side: sideOf(st.dir, false), qty: a.qty, price: a.px, orderType: 'LIMIT' });
  }
  function onReconcile() {
    const pos = ev.position || {}, orders = Array.isArray(ev.orders) ? ev.orders : null;
    if (!(Number.isInteger(pos.qty) && pos.qty >= 0) || !orders) return block('reconcile-unreadable', 'The reconcile could not read the broker position / orders.');
    if (st.flat && !['done', 'reversed', 'rejected'].includes(st.flat.phase)) return flattenReconcile(pos, orders);
    if (ev.key != null && st.flat) { notes.push('stale-read'); return; }
    let clean = true, unknownSeen = false;
    const bdir = pos.qty > 0 ? pos.dir : null;
    if (pos.qty > 0 && (!st.plan || bdir !== st.dir)) { block('reconcile-position', `The broker shows ${pos.qty} contracts ${bdir === 1 ? 'long' : bdir === -1 ? 'short' : '?'} that this plan does not own: nothing is sent; the executor's own adopt / recovery path decides.`); return; }
    if (ev.key == null && st.plan && pos.qty > 0) guard('restart: the TIDE position stays planner-owned');
    const seenKeys = new Set();
    for (const b of orders) {
      const o = b && b.key != null ? st.orders[b.key] : null;
      if (!o) { clean = false; unknownSeen = true; block('reconcile-unknown-order', `The broker shows an order this plan does not own (${JSON.stringify(b && (b.key ?? b.orderId))}): it is left alone; entries and adds are blocked.`); continue; }
      seenKeys.add(o.key); if ((o.status === 'sent' || o.status === 'unknown') && !(safeExit && o.key === st.stopNext)) o.status = 'working';
      if (Number.isInteger(b.qty) && b.qty >= 0 && b.qty !== remaining(o) && o.kind !== 'stop') { o.qty = (o.filled || 0) + b.qty; clean = false; }
      if (o.kind === 'stop' && Number.isInteger(b.qty)) { o.brokerRemainingQty=b.qty; if(!(safeExit && o.key===st.stopNext)) o.qty=(o.filled||0)+b.qty; }
      if (isNum(b.price) && !(safeExit && o.key===st.stopNext)) o.price = b.price;   // the broker's level
    }
    for (const o of Object.values(st.orders)) if (LIVE.has(o.status) && !seenKeys.has(o.key)) { clean = false; if (o.status !== 'cancel-sent') o.status = 'unknown'; block('reconcile-unresolved-order', 'Open-order absence is not a terminal outcome; the original intent remains reserved.'); }
    if (!safeExit && st.stopNext && st.orders[st.stopNext] && st.orders[st.stopNext].status === 'working') { const old = st.stopKey; st.stopKey = st.stopNext; st.stopNext = null; if (old && st.orders[old] && st.orders[old].status === 'working') cancelOrder(old, 'the replacement stop rests: the old one goes', true); }
    else if (st.stopNext && terminal(st.orders[st.stopNext])) st.stopNext = null;
    if (st.stopKey && !(st.orders[st.stopKey] && LIVE.has(st.orders[st.stopKey].status))) st.stopKey = null;
    if (st.stopKey && isNum(st.orders[st.stopKey].price)) { st.protPx = st.orders[st.stopKey].price; if (st.dir * (st.stopPx - st.protPx) < -EPS) st.stopPx = st.protPx; }
    if (st.addPending) { st.addPending = null; notes.push('add-refused:reconcile'); }
    if (pos.qty !== st.open) { clean = false; notes.push(`reconcile-qty:${st.open}->${pos.qty}`); if(safeExit){st.brokerQty=pos.qty;block('reconcile-qty-unresolved','Broker quantity differs from applied fills; preserve accounting and reconcile exact order history.');return;} st.open = pos.qty; }
    if (st.open > 0 && !st.stopKey && safeExit && st.stopNext && !terminal(st.orders[st.stopNext])) { block('stop-amend-unresolved', 'Same-order stop evidence unresolved; retain its identity and block risk increases.'); return; }
    if (st.open > 0 && !st.stopKey) { clean = false; return naked(ev.key == null ? 'a restart reconcile found no working stop' : 'a reconcile found no working stop'); }   // r1.2: flatten, never repair-and-wait
    if (clean) { st.block = null; st.alerted = {}; st.stopFailed = null; notes.push('reconcile-clean'); }
    else if (!unknownSeen) block('reconcile-mismatch', 'The reconcile found the broker different from the saved plan: the stop is (re)sized to the broker position; entries, adds and new targets are blocked.');
  }

  // ---- transitions
  function afterEntryComplete() { if (st.R === null && st.open > 0) replanTargets(); maybePlaceResting(); }
  function replanTargets() {
    const legs = Object.values(st.orders).filter(o => o.kind === 'entry' && o.filled > 0).map(o => ({ price: o.avgPx, contracts: o.filled }));
    const p = money.planExits({ dir: st.dir, legs, stop: st.plan.stop, pools: st.plan.pools, partialPools: st.plan.partialPools, grade: st.grade }, cfg);
    if (!p) return block('plan-failed', 'The exit plan could not be computed from the fills: the stop protects; no targets are placed.');
    st.R = p.R; st.tp1Px = p.partial.price; st.tp1Qty = p.partial.contracts; st.tp2Px = p.tp.price; st.originalContracts = p.contracts;
  }
  function maybePlaceResting() {   // Stage 2c only: configProblem refuses entryByGrade true in Stage 2a, so plan.second is 0 here
    const p = st.plan, l1 = entryLeg(st, 1);
    if (st.restPlaced || !p || !(p.second > 0) || !isNum(p.entry2Px) || !l1 || !(l1.filled > 0) || st.tp1Done || st.tp1Traded) return;
    st.restPlaced = true;
    if (st.block || configProblem(cfg)) { notes.push('resting-refused'); return; }
    const s = money.secondLeg({ dir: st.dir, stop: st.stopPx, structuralStop: p.stop, firstFill: l1.avgPx, firstContracts: l1.filled, entry2: p.entry2Px, plannedSecond: p.second, grade: 'B' }, cfg);
    if (!(s.contracts > 0)) { notes.push(`resting-refused:${s.reason}`); return; }
    const ex = exposure(st, ctx, { qty: s.contracts, px: p.entry2Px });
    if (!ex.ok) { notes.push('resting-refused:exposure-cap'); return; }
    placeOrder('entry', { leg: 2, side: sideOf(st.dir, false), qty: s.contracts, price: p.entry2Px, orderType: 'LIMIT' });
  }
  function afterTp1() {
    if (st.tp1Done) return;
    st.tp1Done = true; st.tp1Traded = true;
    tighten(money.beStopAfterPartial(avgEntry(st), st.dir, cfg), 'break-even after TP1');
    cancelRestingIf('tp1-reached');
  }
  function tighten(px, why) { const want = money.stopOnlyInFavour(st.stopPx, px, st.dir); if (want !== st.stopPx) { st.stopPx = want; notes.push(`stop:${want}:${why}`); } }
  function cancelRestingIf(why) { for (const o of liveOf(st, 'entry')) if (o.leg === 2 && o.status !== 'cancel-sent') cancelOrder(o.key, `resting B half: ${why}`); }
  function cancelOrder(k, why, allowProtective = false) {
    const o = st.orders[k]; if (!o || !LIVE.has(o.status)) return;
    if (o.status === 'cancel-sent' && !allowProtective) return;
    if (o.kind === 'stop' && st.open > 0 && (k === st.stopKey || k === st.stopNext) && !allowProtective) return;   // the protective stop goes only by a modify, or in the flatten (ruling 6)
    o.status = 'cancel-sent'; emit({ op: 'cancel', kind: o.kind, side: o.side, qty: remaining(o), price: o.price, key: key(o.kind), target: k, reason: why, expectOpen: st.open, ...(o.leg ? { leg: o.leg } : {}) });
  }
  function emitStop(qty, px) {   // place (no stop rests) or modify (replace the resting one): new first; never wider (noWiden)
    const cur = st.stopKey ? st.orders[st.stopKey] : null, side = sideOf(st.dir, true);
    if (!cur) { const it = placeOrder('stop', { side, qty, price: px, orderType: 'STOP' }); st.stopNext = it.key; return; }
    const k = key('stop'); newOrder(k, 'stop', { side, orderType: 'STOP', qty, price: px });
    emit({ op: 'modify', kind: 'stop', side, qty, price: px, orderType: 'STOP', key: k, replaces: cur.key, noWiden: true, expectOpen: st.open }); st.stopNext = k;
  }

  // ---- the flatten lifecycle (ruling 6: sessionFlatten's reviewed order)
  function startFlatten(why, ref = {}) {
    if (st.flat) { notes.push(`flatten-already:${st.flat.phase}`); return; }
    if (!(st.open > 0)) { notes.push('flatten-skipped:no-position'); return; }
    st.closing = true; if (st.addPending) { st.addPending = null; notes.push('add-refused:flatten'); }
    st.flat = { phase: 'clearing', reason: why, ladderPx: isNum(ref.ladderPx) ? ref.ladderPx : null, triggerPx: isNum(ref.lastPx) ? ref.lastPx : null, readKey: null, orderKeys: [],
      exits: [], overClose: 0, realized: null, cancelTries: 0, after: null, holdAs: null, passes: 0 };
    notes.push('flatten-started');
    for (const o of Object.values(st.orders)) if (LIVE.has(o.status) && o.kind !== 'stop' && o.kind !== 'position') cancelOrder(o.key, 'flatten: the non-protective orders go first (a target filling during the exit could over-close)');
  }
  function liveNonProtective() { return Object.values(st.orders).some(o => LIVE.has(o.status) && o.kind !== 'stop' && o.kind !== 'position'); }
  function advanceFlatten() {
    const F = st.flat;
    if (F.phase === 'clearing') { if (liveNonProtective()) return; F.phase = 'cancel-stop'; }
    if (F.phase === 'reprotect') {
      if (st.open === 0) { readPosition('flat while re-protecting'); return; }
      const s = st.stopKey ? st.orders[st.stopKey] : null;
      if (!s || !LIVE.has(s.status) || st.stopNext || !isNum(s.price)) return;   // wait for the re-placed stop to be acked
      if (F.after === 'continue') { F.passes++; F.phase = 'cancel-stop'; } else { F.phase = F.holdAs; if (F.phase === 'rejected') st.closing = false; return; }
    }
    if (F.phase === 'cancel-stop') {
      if (safeExit) { F.phase = 'reading'; readPosition('verified reducing close: retain protective stop during read and market close'); return; }
      if (st.stopNext && st.orders[st.stopNext] && LIVE.has(st.orders[st.stopNext].status) && st.orders[st.stopNext].status !== 'cancel-sent') return;   // a stop change in flight: let it resolve
      for (const o of liveOf(st, 'stop')) if (o.status !== 'cancel-sent') cancelOrder(o.key, 'flatten: the stop is cancelled (verified) before the market close', true);
      if (!liveOf(st, 'stop').length) { F.phase = 'reading'; readPosition('the stop cancel is verified: read the quantity to close'); }
      return;
    }
    if (F.phase === 'flat-unresolved' && !Object.values(st.orders).some(o => LIVE.has(o.status))) { F.phase = 'confirming'; F.readKey = null; }
    if ((F.phase === 'reading' || F.phase === 'confirming') && !F.readKey && !quietRead) readPosition('retry the read');
  }
  function readPosition(why) {
    const F = st.flat; if (!F) return;
    if (F.readKey && st.intents[F.readKey] && !st.intents[F.readKey].answered) { notes.push('read-pending'); return; }
    const k = key('position'); F.readKey = k; if (F.phase === 'sent') F.phase = 'confirming';   // other phases are set by their callers
    emit({ op: 'read', kind: 'position', key: k, reason: why, expectOpen: st.open });
  }
  function reprotect(after, why) {   // ruling 6: the protective stop back at its LAST ACKED price at once (alerted unless this is the planned next pass)
    const F = st.flat; if (!F) return;
    F.after = after === 'continue' ? 'continue' : 'hold'; F.holdAs = after === 'continue' ? null : after; F.phase = 'reprotect';
    if (after !== 'continue') alert(`flatten-${after}`, `The market close: ${why}. The protective stop is re-placed at its last acked price ${st.protPx} at once.`);
    if (isNum(st.protPx)) st.stopPx = st.protPx;
    st.stopRetry = null; st.stopFailed = null;
  }
  function fillsSayFlat() {   // the fills say 0: any stop still resting protects nothing (it could open a position): cancel it, then confirm with a read
    for (const o of liveOf(st, 'stop')) if (o.status !== 'cancel-sent') { if (st.stopKey === o.key) st.stopKey = null; cancelOrder(o.key, 'the fills say flat', true); }
    st.stopNext = null; st.flat.phase = 'confirming'; readPosition('the fills say flat: confirm with the broker position');
  }
  function overClose(over, o) {
    alert('over-close', `A closing fill (${o.kind}) was ${over} larger than the position: the position may be REVERSED. The broker position is read now; nothing else is sent.`);
    if (!st.flat) { st.closing = true; st.flat = { phase: 'confirming', reason: 'over-close', ladderPx: null, triggerPx: null, readKey: null, orderKeys: [], exits: [{ kind: o.kind, qty: over, px: o.avgPx }], overClose: 0, realized: null, cancelTries: 0, after: null, holdAs: null, passes: 0 }; }
    else st.flat.phase = 'confirming';
    st.flat.overClose += over; fillsSayFlat();
  }
  function flattenReconcile(pos, orders) {
    const F = st.flat;
    if (ev.key != null && ev.key !== F.readKey) { notes.push('stale-read'); return; }
    if (ev.key != null && st.intents[ev.key] && st.intents[ev.key].answered) { notes.push('read-already-answered'); return; }   // a second answer never re-drives anything
    if (ev.key != null && st.intents[ev.key]) st.intents[ev.key].answered = true;
    const restart = ev.key == null;   // the executor sends a keyless reconcile only at a restart: no order of ours can still be in flight then
    const seenKeys = new Set();
    for (const b of orders) { const o = b && b.key != null ? st.orders[b.key] : null; if (!o) { alert('reconcile-unknown-order', `The broker shows an order this plan does not own (${JSON.stringify(b && (b.key ?? b.orderId))}): it is left alone.`); continue; } seenKeys.add(o.key); if (o.status === 'sent' || o.status === 'unknown') o.status = 'working'; if (isNum(b.price) && o.kind === 'stop') o.price = b.price; }
    for (const o of Object.values(st.orders)) if (LIVE.has(o.status) && !seenKeys.has(o.key)) { if (o.status !== 'cancel-sent') o.status = 'unknown'; block('reconcile-unresolved-order', 'Order absent from open snapshot; preserve durable identity until terminal history is applied.'); }
    if (st.stopKey && !(st.orders[st.stopKey] && LIVE.has(st.orders[st.stopKey].status))) st.stopKey = null;
    if (st.stopNext && !(st.orders[st.stopNext] && LIVE.has(st.orders[st.stopNext].status))) st.stopNext = null;
    if (!st.stopKey) { const s = liveOf(st, 'stop').find(o => o.status === 'working'); if (s) st.stopKey = s.key; }
    if (pos.qty > 0 && pos.dir !== st.dir) return reversed(pos);
    if(safeExit && pos.qty!==st.open){st.brokerQty=pos.qty;block('reconcile-qty-unresolved','Exit snapshot differs from applied fills; no new close or terminal claim until exact history is applied.');return;}
    st.open = pos.qty;
    if (pos.qty === 0) return confirmFlat();
    if (restart) { if (Object.values(st.orders).some(o => o.kind === 'position' && LIVE.has(o.status))) return; reprotect('continue', 'restart: contracts are still open'); return; }
    if (Object.values(st.orders).some(o => o.kind === 'position' && LIVE.has(o.status))) { if (F.phase === 'confirming' || F.phase === 'reading') F.phase = 'sent'; notes.push('flatten-in-flight'); return; }   // never a second one
    if (F.phase === 'stalled' || F.phase === 'cancel-failed') { notes.push(`flatten-${F.phase}:protected`); return; }
    if (F.phase === 'reading') {
      if (!safeExit && liveOf(st, 'stop').length) { F.phase = 'cancel-stop'; return; }   // a stop rests again: cancel it (verified) before any market order
      return sendMarket(pos.qty);
    }
    reprotect('continue', 'contracts are left after the market close');   // 'confirming' / 'sent': the rest is protected first, then the next pass
  }
  function sendMarket(qty) {
    const F = st.flat, k = key('position'), side = sideOf(st.dir, true);
    newOrder(k, 'position', { side, orderType: 'MARKET', qty, price: null });
    F.orderKeys.push(k); F.phase = 'sent';
    emit({ op: 'flatten', kind: 'position', side, qty, price: null, orderType: 'MARKET', key: k, reason: F.reason, expectOpen: qty, stopCancelledVerified: !safeExit, ...(safeExit ? { reduceOnly: true, retainedProtection: true } : {}) });
  }
  function confirmFlat() {
    const F = st.flat; st.open = 0;
    for (const o of Object.values(st.orders)) if (LIVE.has(o.status) && o.status !== 'cancel-sent' && o.kind !== 'position') { if (o.kind === 'stop' && st.stopKey === o.key) st.stopKey = null; cancelOrder(o.key, 'confirmed flat', true); }
    st.stopNext = null;
    if (Object.values(st.orders).some(o => LIVE.has(o.status))) { F.phase = 'flat-unresolved'; notes.push('flat-but-orders-unresolved'); return; }
    F.phase = 'done'; F.realized = realizedExit(); notes.push('flatten-confirmed-flat');
  }
  function reversed(pos) {
    const F = st.flat; F.phase = 'reversed'; st.open = 0;
    for (const o of Object.values(st.orders)) if (LIVE.has(o.status) && o.status !== 'cancel-sent' && o.kind !== 'position') { if (o.kind === 'stop' && st.stopKey === o.key) st.stopKey = null; cancelOrder(o.key, 'the position is reversed: our closing orders would add to it', true); }
    st.stopNext = null; F.realized = realizedExit();
    block('position-reversed', `The broker shows ${pos.qty} contracts on the OPPOSITE side after the exit. Our closing orders are cancelled (they would add to it); nothing else is sent. Close it by hand.`);
  }
  function realizedExit() {
    const F = st.flat, q = F.exits.reduce((a, e) => a + e.qty, 0);
    if (!q) return { qty: 0, avgPx: null, vsLadderPts: null, vsTriggerPts: null, byKind: {} };
    const avg = F.exits.reduce((a, e) => a + e.qty * e.px, 0) / q, byKind = {};
    for (const e of F.exits) byKind[e.kind] = (byKind[e.kind] || 0) + e.qty;
    return { qty: q, avgPx: avg, vsLadderPts: isNum(F.ladderPx) ? r2(st.dir * (avg - F.ladderPx)) : null, vsTriggerPts: isNum(F.triggerPx) ? r2(st.dir * (avg - F.triggerPx)) : null, byKind };
  }

  // ---- desired state -> intents (stop first, then targets); runs after every event
  function sync() {
    if (st.flat && st.flat.phase !== 'rejected') {
      const F = st.flat;
      if (F.phase === 'done' || F.phase === 'reversed') return;
      if (st.open > 0 && KEEP_STOP_PHASES.has(F.phase) && !(F.naked && F.phase === 'clearing')) syncStop();   // the protective stop rests in these phases; a NAKED exit goes straight out (no repair-and-wait)
      advanceFlatten();
      return;
    }
    if (st.open === 0) { if (st.plan && terminal(entryLeg(st, 1)) && !liveOf(st, 'add').length && !st.flat) sweep('flat'); return; }
    syncStop();
    syncTargets();
  }
  function syncStop() {   // the ONE protective stop = the open quantity at the (only tightening) level; one change at a time; never a want that failed twice
    if (st.stopNext) return;
    const cur = st.stopKey ? st.orders[st.stopKey] : null;
    if (cur && cur.price === null) return;   // its acked level is unknown (blocked): a reconcile reads it first
    if (st.stopFailed && st.stopFailed.px === st.stopPx && st.stopFailed.qty === st.open) return;
    if (!cur || cur.qty !== st.open || cur.price !== st.stopPx) emitStop(st.open, st.stopPx);
  }
  function syncTargets() {
    if (st.block || st.flat || !isNum(st.R) || !terminal(entryLeg(st, 1))) return;   // targets only on a known, complete entry (and never after a flatten began)
    const tp1Left = st.tp1Done ? 0 : Math.max(0, st.tp1Qty - ((Object.values(st.orders).filter(o => o.kind === 'tp1').reduce((a, o) => a + (o.filled || 0), 0))));
    const want = { tp1: tp1Left > 0 ? { qty: Math.min(tp1Left, st.open), price: st.tp1Px } : null, tp2: null };
    const tp2Qty = st.open - (want.tp1 ? want.tp1.qty : 0); want.tp2 = tp2Qty > 0 ? { qty: tp2Qty, price: st.tp2Px } : null;
    for (const kind of ['tp1', 'tp2']) {
      const live = liveOf(st, kind); if (live.some(o => o.status === 'sent' || o.status === 'cancel-sent' || o.status === 'unknown')) continue;   // one change at a time
      const cur = live[0] || null, w = want[kind];
      if (!w && cur) cancelOrder(cur.key, `${kind} no longer needed`);
      else if (w && !cur) { if (!(st.tp1Done && kind === 'tp1')) placeOrder(kind, { side: sideOf(st.dir, true), qty: w.qty, price: w.price, orderType: 'LIMIT' }); }
      else if (w && cur && (remaining(cur) !== w.qty || cur.price !== w.price)) {
        const k = key(kind); newOrder(k, kind, { side: cur.side, orderType: 'LIMIT', qty: w.qty, price: w.price });
        emit({ op: 'modify', kind, side: cur.side, qty: w.qty, price: w.price, orderType: 'LIMIT', key: k, replaces: cur.key, expectOpen: st.open });
      }
    }
  }
  function sweep(why) { for (const o of Object.values(st.orders)) if (LIVE.has(o.status) && o.status !== 'cancel-sent') { if (o.kind === 'stop') { if (st.stopKey === o.key) st.stopKey = null; } cancelOrder(o.key, why); } }
  function phaseOf() {
    if (!st.plan) return 'FLAT';
    const anyLive = Object.values(st.orders).some(o => LIVE.has(o.status));
    if (st.flat && st.flat.phase !== 'rejected') { if (st.flat.phase === 'reversed') return 'REVERSED'; return st.flat.phase === 'done' && !anyLive ? 'DONE' : 'CLOSING'; }
    if (st.open > 0) return 'OPEN';
    if (!anyLive) return 'DONE';
    return terminal(entryLeg(st, 1)) ? 'CLEANUP' : 'PENDING';
  }
}

module.exports = { VERSION, initState, plan, exposure, avgEntry, eventId, configProblem };
