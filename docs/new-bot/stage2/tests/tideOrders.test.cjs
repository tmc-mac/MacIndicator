'use strict';
// nice -n 19 node tests/tideOrders.test.cjs   (lib/tideOrders.js r1.1 against a FAKE broker + a fake FSM post-fill path; pure, no network, no clock)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require(path.join(__dirname, '..', 'lib', 'tideOrders.js'));
const M = require(path.join(__dirname, '..', 'lib', 'moneyRule.js'));
let n = 0, failed = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n  ', process.env.V ? e.stack : e.message.split('\n').slice(0, 14).join('\n   ')); } };
const base = JSON.parse(JSON.stringify(M.DEFAULTS));
const CFG = (s = {}) => ({ ...base, sizing: { ...base.sizing, enabled: true, ...s }, pointValue: 2, tickSize: 0.25 });
const GRADE = CFG({ mode: 'grade' }), FLAT = CFG();
const SEEN_PAIRS = new Set();

// ---------------------------------------------------------------- the fake broker (+ the FSM's own post-fill bracket path, refused by the guard)
class Broker {
  constructor(dir) {
    this.dir = dir; this.orders = new Map(); this.pos = 0; this.cash = 0; this.lastPx = null; this.rejects = []; this.partials = {}; this.holdCancels = false; this.held = [];
    this.holdReads = false; this.heldReads = []; this.flattenMode = 'normal'; this.heldFlatten = []; this.flattensExecuted = 0; this.violations = []; this.fills = []; this.eid = 0;
    this.guardOn = false; this.ignoreGuard = false; this.fsmBracketStop = null; this.fsmN = 0; this.stopFallback = null; this.fillOnCancel = false;
  }
  ev(e) { return { ...e, id: `b${++this.eid}` }; }
  reject(pred, reason = 'rejected by the fake exchange') { this.rejects.push({ pred, reason }); }
  _rej(it) { const i = this.rejects.findIndex(r => r.pred(it)); if (i < 0) return null; const r = this.rejects[i]; this.rejects.splice(i, 1); return r.reason; }
  readNow(key) { const q = Math.abs(this.pos); return this.ev({ type: 'reconcile', key, position: { qty: q, dir: this.pos > 0 ? this.dir : this.pos < 0 ? -this.dir : null }, orders: this.working().map(o => ({ key: o.key, qty: o.qty - o.filled, price: o.price })) }); }
  releaseReads() { const out = this.heldReads.map(k => this.readNow(k)); this.heldReads = []; this.holdReads = false; return out; }
  _stopAck(it) {   // replaceStopSafely may place a different VALID level: the ack says which (ruling 4)
    let px = it.price; if (this.stopFallback) { px = this.stopFallback.px; this.stopFallback = null; }
    this.orders.set(it.key, { ...it, price: px, filled: 0 }); return this.ev({ type: 'ack', key: it.key, price: px });
  }
  exec(it) {
    SEEN_PAIRS.add(`${it.op}|${it.kind}`);
    if (it.op === 'alert') return [];
    if (it.op === 'guard') { if (!this.ignoreGuard) this.guardOn = true; return []; }
    const why = this._rej(it); if (why) return [this.ev({ type: 'reject', key: it.key, reason: why, lastPx: this.lastPx })];
    if (it.op === 'place') { if (it.kind === 'stop') return [this._stopAck(it)]; this.orders.set(it.key, { ...it, filled: 0 }); return [this.ev({ type: 'ack', key: it.key }), ...this._now(it.key)]; }
    if (it.op === 'modify') {
      if (it.kind === 'stop') { const out = [this._stopAck(it)]; if (this.orders.delete(it.replaces)) out.push(this.ev({ type: 'cancel-ack', key: it.replaces })); return out; }   // new first, then the old
      this.orders.delete(it.replaces); this.orders.set(it.key, { ...it, filled: 0 }); return [this.ev({ type: 'ack', key: it.key })];   // a target: the old cancelled first
    }
    if (it.op === 'cancel') {
      if (this.holdCancels) { this.held.push(it); return []; }
      const o = this.orders.get(it.target), out = [];
      if (o && o.kind === 'stop' && this.fillOnCancel) { this.fillOnCancel = false; const q = o.qty - o.filled; o.filled = o.qty; o.avg = o.price; this._fill(o, q, o.price); out.push(this.ev({ type: 'fill', key: o.key, filledQty: o.qty, avgPx: o.price })); }   // the market ran through it first
      this.orders.delete(it.target); out.push(this.ev({ type: 'cancel-ack', key: it.target })); return out;
    }
    if (it.op === 'flatten') return this.runFlatten(it);
    if (it.op === 'read') { if (this.holdReads) { this.heldReads.push(it.key); return []; } return [this.readNow(it.key)]; }
    throw new Error('fake broker: unknown op ' + it.op);
  }
  // the executor's market close of min(intent qty, the position it re-reads); the stop was already cancelled (verified) by the lifecycle.
  // modes: normal | partial:N | noack (no answer; it may still execute) | hold | manualClose (1 contract closed by hand between the read and the send: the
  //        market order then closes the intent qty - the case a reduce-only flag would close; the planner's backstop must catch it)
  runFlatten(it) {
    const out = [], mode = this.flattenMode;
    if (mode === 'hold') { this.heldFlatten.push(it); return out; }
    if (mode === 'noack') { this.heldFlatten.push(it); this.flattenMode = 'normal'; return [this.ev({ type: 'no-ack', key: it.key, reason: 'timeout (fake)' })]; }
    if (mode === 'manualClose') { this.pos -= 1; this.flattenMode = 'normal'; this.flattensExecuted++; this._fill({ kind: 'position' }, it.qty, this.lastPx); out.push(this.ev({ type: 'fill', key: it.key, filledQty: it.qty, avgPx: this.lastPx })); return out; }
    let q = Math.min(it.qty, Math.max(0, this.pos));
    if (mode.startsWith('partial:')) { q = Math.min(q, Number(mode.split(':')[1])); this.flattenMode = 'normal'; }
    this.flattensExecuted++;
    if (q > 0) { this._fill({ kind: 'position' }, q, this.lastPx); out.push(this.ev({ type: 'fill', key: it.key, filledQty: q, avgPx: this.lastPx })); }
    if (q < it.qty) out.push(this.ev({ type: 'cancel-ack', key: it.key }));   // the market order ended with the rest unfilled (or was never needed)
    return out;
  }
  releaseCancels() { const out = []; for (const it of this.held) { this.orders.delete(it.target); out.push(this.ev({ type: 'cancel-ack', key: it.target })); } this.held = []; this.holdCancels = false; return out; }
  _now(key) {   // a LIMIT that is marketable when it arrives fills at once
    const o = this.orders.get(key); if (!o || o.orderType !== 'LIMIT' || this.lastPx === null) return [];
    const buy = o.side === 'BUY'; if (!(buy ? this.lastPx <= o.price : this.lastPx >= o.price)) return [];
    const q = o.qty; o.filled = q; o.avg = o.price; this._fill(o, q, o.price); this.orders.delete(key);
    return [this.ev({ type: 'fill', key, filledQty: q, avgPx: o.price })];
  }
  _fill(o, q, px) {
    const opening = o.kind === 'entry' || o.kind === 'add';
    if (opening) { this.pos += q; this.cash -= this.dir * q * px; } else { if (q > this.pos) this.violations.push(`closing ${q} > position ${this.pos} (${o.kind}): REVERSED`); this.pos -= q; this.cash += this.dir * q * px; }
    this.fills.push({ kind: o.kind, q, px });
    if (o.kind === 'entry' && !this.guardOn && this.fsmBracketStop !== null) {   // the FSM's own post-fill bracket path (refused for a TIDE position by the guard)
      const k = `fsm:stop:${++this.fsmN}`; this.orders.set(k, { key: k, kind: 'stop', side: this.dir === 1 ? 'SELL' : 'BUY', orderType: 'STOP', qty: q, price: this.fsmBracketStop, filled: 0 });
    }
  }
  tick(px) {
    this.lastPx = px; const out = [];
    for (const [k, o] of [...this.orders]) {
      const buy = o.side === 'BUY', left = o.qty - o.filled;
      let hit = false;
      if (o.orderType === 'MARKET') hit = true; else if (o.orderType === 'STOP') hit = buy ? px >= o.price : px <= o.price; else hit = buy ? px <= o.price : px >= o.price;
      if (!hit || left <= 0) continue;
      const q = this.partials[o.kind] ? Math.min(left, this.partials[o.kind]) : left; if (this.partials[o.kind]) delete this.partials[o.kind];
      const fpx = o.orderType === 'STOP' || o.orderType === 'MARKET' ? px : o.price;
      o.avg = ((o.avg || 0) * o.filled + fpx * q) / (o.filled + q); o.filled += q; this._fill(o, q, fpx);
      if (o.filled >= o.qty) this.orders.delete(k);
      out.push(this.ev({ type: 'fill', key: k, filledQty: o.filled, avgPx: o.avg }));
    }
    return out;
  }
  working() { return [...this.orders.values()]; }
  pnl() { return 2 * (this.cash + this.dir * this.pos * (this.lastPx || 0)); }   // MNQ $2 / pt
}

// ---------------------------------------------------------------- the driver (= the executor's job) and the invariants
function env(cfg, dir, id = 'pos-1') { return { st: T.initState(id), b: new Broker(dir), ctx: { cfg }, intents: [], notes: [], events: [], best: null, bestSince: null, adds: 0, li: 0 }; }
function settle(E, events, { check = true } = {}) {
  const q = [...events]; let guard = 0;
  while (q.length) {
    if (++guard > 500) throw new Error('no quiet point');
    const e = q.shift(), before = E.st, r = T.plan(E.st, e, E.ctx);
    const again = T.plan(r.state, e, E.ctx); assert.deepStrictEqual(again.intents, [], `replay of ${JSON.stringify(e)} gave intents`); assert.deepStrictEqual(again.state, r.state);
    for (const it of r.intents) {
      assert.ok(it.key.startsWith(`${E.st.id}:${it.kind}:`), `key ${it.key}`); assert.ok(!E.intents.some(x => x.key === it.key), `duplicate key ${it.key}`);
      if (it.op === 'cancel' && it.kind === 'stop') assert.ok(r.state.open === 0 || r.state.flat || r.state.stopKey !== it.target, 'a protective stop was cancelled outside the flatten');
      if ((it.op === 'place' || it.op === 'modify') && it.kind === 'stop') {   // ruling 3: never wider than the structural stop or the acked protective stop
        assert.strictEqual(it.noWiden, true);
        assert.ok(before.dir * (it.price - before.plan.stop) >= -1e-9, `stop ${it.price} wider than the structural stop ${before.plan.stop}`);
        if (typeof before.protPx === 'number' && !(before.block === 'stop-looser')) assert.ok(before.dir * (it.price - before.protPx) >= -1e-9, `stop ${it.price} wider than the acked protective stop ${before.protPx}`);
      }
    }
    E.st = r.state; E.intents.push(...r.intents); E.notes.push(...r.notes); E.events.push(e);
    for (const it of r.intents) q.push(...E.b.exec(it));
  }
  if (check) invariants(E);
  return E;
}
function invariants(E) {
  const { st, b } = E;
  assert.deepStrictEqual(b.violations, [], 'a closing fill larger than the position (reversal)');
  assert.strictEqual(st.open, b.pos, `planner open ${st.open} vs broker ${b.pos}`);
  for (let i = 1; i < st.stopHist.length; i++) assert.ok(st.dir * (st.stopHist[i] - st.stopHist[i - 1]) > 0, 'the acked stop only tightens');
  const stops = b.working().filter(o => o.kind === 'stop'), tps = b.working().filter(o => o.kind === 'tp1' || o.kind === 'tp2');
  assert.ok(stops.length <= 1, `at most ONE stop rests (${stops.length})`);
  if (b.pos > 0 && !st.flat && !st.block) { assert.strictEqual(stops.length, 1, 'one protective stop'); assert.strictEqual(stops[0].qty, b.pos, 'sized to the open quantity'); assert.strictEqual(stops[0].price, st.protPx, 'the planner records the broker-acked level'); }
  if (st.flat && b.pos > 0 && ['clearing', 'stalled', 'cancel-failed'].includes(st.flat.phase)) assert.ok(stops.length === 1 && stops[0].qty === b.pos, `the open contracts keep their stop during ${st.flat.phase}`);
  assert.ok(tps.reduce((a, o) => a + o.qty - o.filled, 0) <= b.pos, 'targets never exceed the position');
  if (b.pos === 0 && st.phase === 'DONE') assert.deepStrictEqual(b.working(), [], 'nothing left working when DONE');
}
function walk(E, path, hook = () => {}) {
  for (let i = 0; i < path.length; i++) {
    const px = path[i];
    settle(E, E.b.tick(px));
    if (E.st.open > 0) {
      E.best = E.best === null || E.st.dir * (px - E.best) > 0 ? px : E.best; E.bestSince = E.bestSince === null || E.st.dir * (px - E.bestSince) > 0 ? px : E.bestSince;
      settle(E, [{ type: 'ladder', id: `L${++E.li}`, bestPx: E.adds ? E.bestSince : E.best, lastPx: px, invalidated: false }]);
    }
    hook(i, px);
  }
  return E;
}
const sig = (o) => ({ type: 'signal', id: 'sig', entryType: 'LIMIT', ...o });
const ofKind = (E, op, kind) => E.intents.filter(i => i.op === op && i.kind === kind);
const POOLS = [{ price: 20090, name: 'swing H' }, { price: 20300, major: true, name: 'PDH' }];
const longA = (cfg = GRADE, pools = POOLS) => { const E = env(cfg, 1); settle(E, [sig({ dir: 1, grade: 'A+', entryPx: 20000, stop: 19854, pools })]); return E; };

// ---------------------------------------------------------------- life cycles
t('A+ 3-lot life cycle: guard -> entry -> ONE stop with the fill -> TP1 2/3 -> break-even -> ladder lock -> TP2 -> DONE', () => {
  const E = longA();
  assert.deepStrictEqual(E.intents.map(i => [i.op, i.kind, i.qty, i.price]), [['guard', 'position', undefined, undefined], ['place', 'entry', 3, 20000]]);   // the guard goes BEFORE the entry
  assert.deepStrictEqual([E.intents[0].fsmPostFill, E.intents[0].owner], ['refuse', 'tideOrders-r1.2']);
  const k0 = E.intents.length; walk(E, [20000]);
  assert.deepStrictEqual(E.intents.slice(k0, k0 + 3).map(i => [i.op, i.kind, i.side, i.qty, i.price]), [['place', 'stop', 'SELL', 3, 19854], ['place', 'tp1', 'SELL', 2, 20090], ['place', 'tp2', 'SELL', 1, 20300]]);
  walk(E, [20050, 20090]);
  const be = ofKind(E, 'modify', 'stop')[0]; assert.deepStrictEqual([be.qty, be.price], [1, 20000.25]);
  walk(E, [20150, 20220]); assert.strictEqual(E.st.protPx, 20073);
  walk(E, [20260, 20300]);
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.working(), []); assert.strictEqual(E.b.pnl(), 960);
});
t('ruling 1 (owner): a TIDE fill produces exactly ONE stop (the guard refuses the FSM bracket); without the executor switch there would be two', () => {
  let E = longA(); E.b.fsmBracketStop = 19854; walk(E, [20000]);
  assert.strictEqual(E.b.guardOn, true); assert.strictEqual(E.b.working().filter(o => o.kind === 'stop').length, 1); assert.strictEqual(ofKind(E, 'place', 'stop').length, 1);
  E = env(GRADE, 1); E.b.ignoreGuard = true; E.b.fsmBracketStop = 19854; settle(E, [sig({ dir: 1, grade: 'A+', entryPx: 20000, stop: 19854, pools: POOLS })]); settle(E, E.b.tick(20000), { check: false });
  assert.strictEqual(E.b.working().filter(o => o.kind === 'stop').length, 2, 'the negative witness: an executor that ignores the guard double-protects (and could reverse)');
  // the guard is re-asserted at a restart
  const R = longA(); walk(R, [20000]); const snap = R.b.readNow(null); delete snap.key; snap.id = 'boot';
  const r = T.plan(R.st, snap, R.ctx); assert.deepStrictEqual(r.intents.map(i => i.op), ['guard']); assert.ok(r.notes.includes('reconcile-clean'));
});
t('ruling 2: no resting B half in Stage 2a: entryByGrade true (and the upgrade add) are config problems; the signal is refused with an alert', () => {
  assert.strictEqual(T.configProblem(GRADE), null); assert.strictEqual(T.configProblem(FLAT), null);
  assert.match(T.configProblem(CFG({ mode: 'grade', entryByGrade: true })), /entryByGrade true .* second FSM entry slot \(Stage 2c\)/);
  assert.match(T.configProblem(CFG({ mode: 'grade', upgradeAdd: { enabled: true } })), /no grade-upgrade add/);
  assert.match(T.configProblem(CFG({ mode: 'grades' })), /^money: sizing\.mode/);
  const r = T.plan(T.initState('p2'), sig({ dir: 1, grade: 'B', entryPx: 20000, stop: 19975, entry2Px: 19990, pools: [] }), { cfg: CFG({ mode: 'grade', entryByGrade: true }) });
  assert.deepStrictEqual(r.intents.map(i => [i.op, i.code]), [['alert', 'config-problem']]); assert.ok(r.notes.includes('signal-refused:config')); assert.strictEqual(r.state.plan, null);
});
t('1 lot: no TP1 order; TP1 price traded -> break-even; TP2 -> DONE', () => {
  const E = env(FLAT, 1); settle(E, [sig({ dir: 1, grade: 'B', entryPx: 20000, stop: 19800, pools: [] })]); walk(E, [20000]);
  assert.deepStrictEqual(E.intents.filter(i => i.op === 'place').map(i => [i.kind, i.qty, i.price]), [['entry', 1, 20000], ['stop', 1, 19800], ['tp2', 1, 20400]]);
  walk(E, [20100]); settle(E, [{ type: 'tp1-traded', id: 'tp1px', px: 20200 }]);
  assert.strictEqual(E.st.tp1Done, true); assert.strictEqual(E.b.working().find(o => o.kind === 'stop').price, 20000.25);
  walk(E, [20300, 20400]); assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pnl(), 800);
});
t('partial entry fill: the stop follows the filled quantity; targets only once the entry is complete (or cancelled)', () => {
  let E = longA(); E.b.partials.entry = 1; walk(E, [20000]);
  assert.deepStrictEqual(E.intents.slice(2).map(i => [i.op, i.kind, i.qty]), [['place', 'stop', 1]]);
  const k = E.intents.length; walk(E, [19999]);
  assert.deepStrictEqual(E.intents.slice(k).map(i => [i.op, i.kind, i.qty, i.price]), [['modify', 'stop', 3, 19854], ['place', 'tp1', 2, 20090], ['place', 'tp2', 1, 20300]]);
  E = longA(); E.b.partials.entry = 1; walk(E, [20000]);
  const ek = E.intents[1].key; E.b.orders.delete(ek); settle(E, [{ type: 'cancel-ack', id: 'exp', key: ek }]);
  assert.deepStrictEqual(E.b.working().map(o => [o.kind, o.qty]).sort(), [['stop', 1], ['tp2', 1]]);
});
const WITNESS = [28366.75, 28341.25, 28353.25, 28338, 28343.25, 28335.75, 28326, 28315.5, 28313.75, 28304.25, 28267.5, 28239, 28232.75, 28223.75, 28239.75, 28243.25, 28212, 28180,
  28177.25, 28135.5, 28132.75, 28137, 28149.75, 28136.5, 28090, 28093, 28066, 28052.75, 28054.75, 28053.5, 28044.5, 28083, 28079, 28082.25, 28070.5, 28067, 28082, 28090.5, 28124.5,
  28116.5, 28128, 28143.25, 28145, 28149.75, 28156.75, 28162.75, 28167.75, 28196.5, 28190.75, 28172.5, 28168.75, 28168, 28153.25, 28149.5, 28150, 28163.5, 28068.75, 28071.25, 27986.5, 27896.5];
t('TP1 then the pyramid add then TP2 (the 11/04 witness, A+ short 3 MNQ): $1,180.50; the stop already house money, so no raise is needed', () => {
  const E = env(GRADE, -1);
  settle(E, [sig({ dir: -1, grade: 'A+', entryPx: 28366.75, stop: 28513, pools: [{ price: 28306, name: 'swing L' }, { price: 28104.25, name: 'London Low' }, { price: 28035.25, major: true, name: 'PDL' }] })]);
  walk(E, WITNESS, (i, px) => { if (i === 49) { settle(E, [{ type: 'pullback-add', id: 'add1', addPx: px, lastPx: px, bias: { m15: -0.3, m30: -0.3, line: 0.15 }, control4h: -1, rejection: true }]); E.adds = 1; E.bestSince = px; } });
  const add = ofKind(E, 'place', 'add'); assert.deepStrictEqual(add.map(a => [a.qty, a.price, a.side]), [[1, 28172.5, 'SELL']]);
  const after = E.intents.slice(E.intents.indexOf(add[0]) + 1);
  assert.deepStrictEqual(after.slice(0, 2).map(i => [i.op, i.kind, i.qty, i.price]), [['modify', 'stop', 2, 28220.5], ['modify', 'tp2', 2, 28035.25]]);   // the fill resizes the stop + TP2
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pnl(), 2 * 60.75 * 2 + 331.5 * 2 + 137.25 * 2);
});
t('ruling 5: the stop is TIGHTENED to the combined break-even BEFORE the add is sent (acked first); qty resized on the fill; an unfilled add leaves the tighter stop', () => {
  const run = (fillIt) => {
    const E = longA(); walk(E, [20000, 20090, 20220]); assert.strictEqual(E.st.protPx, 20073);   // 1 open @ 20000, stop +0.5R locked
    E.b.lastPx = 20146; const k = E.intents.length;
    if (!fillIt) E.b.lastPx = 20150;   // the add (BUY limit 20146) rests below the market: it may never fill
    settle(E, [{ type: 'pullback-add', id: 'ra', addPx: 20146, lastPx: E.b.lastPx, bias: { m15: 0.3, m30: 0.3, line: 0.15 }, control4h: 1, rejection: true }]);
    const s = E.intents.slice(k).map(i => [i.op, i.kind, i.qty, i.price]);
    assert.deepStrictEqual(s.slice(0, 2), [['modify', 'stop', 1, 20073.25], ['place', 'add', 1, 20146]], 'the raise first, the add only after its ack');   // combined avg 20073 -> BE + 1 tick
    return E;
  };
  let E = run(true);
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => [o.qty, o.price]), [[2, 20073.25]]);   // the add filled: the stop covers both
  assert.ok(1 * (20073.25 - 20000) + 1 * (20073.25 - 20146) >= 0, 'house money at the acked stop');
  E = run(false); const addKey = ofKind(E, 'place', 'add')[0].key; E.b.orders.delete(addKey); settle(E, [{ type: 'cancel-ack', id: 'addgone', key: addKey }]);
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => [o.qty, o.price]), [[1, 20073.25]], 'the add never filled: the tighter stop stays');
  // the raise rejected twice: no add
  const F = longA(); walk(F, [20000, 20090, 20220]); F.b.lastPx = 20146; F.b.reject(it => it.kind === 'stop'); F.b.reject(it => it.kind === 'stop');
  settle(F, [{ type: 'pullback-add', id: 'rb', addPx: 20146, lastPx: 20146, bias: { m15: 0.3, m30: 0.3, line: 0.15 }, control4h: 1, rejection: true }], { check: false });
  assert.strictEqual(ofKind(F, 'place', 'add').length, 0); assert.ok(F.notes.includes('add-refused:stop-raise-rejected'));
});
// ---------------------------------------------------------------- stops: never wider, the acked level
t('ruling 3: a rejected stop is NEVER widened: the same price once more; a second reject alerts + blocks (whatever protects stays); crossed -> the exit', () => {
  let E = longA(); E.b.reject(it => it.op === 'place' && it.kind === 'stop'); walk(E, [20000]);
  assert.deepStrictEqual(ofKind(E, 'place', 'stop').map(i => i.price), [19854, 19854]); assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => o.price), [19854]);
  // a modify rejected twice: the previous stop keeps protecting
  E = longA(); walk(E, [20000, 20090]); E.b.reject(it => it.op === 'modify' && it.kind === 'stop'); E.b.reject(it => it.op === 'modify' && it.kind === 'stop');
  settle(E, E.b.tick(20220)); settle(E, [{ type: 'ladder', id: 'Lr', bestPx: 20220, lastPx: 20220, invalidated: false }], { check: false });
  assert.deepStrictEqual(ofKind(E, 'modify', 'stop').slice(-2).map(i => i.price), [20073, 20073]); assert.strictEqual(E.st.block, 'stop-rejected');
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => [o.qty, o.price]), [[1, 20000.25]]);
  const add = T.plan(E.st, { type: 'pullback-add', id: 'blk', addPx: 20200, bias: { m15: 0.3, m30: 0.3, line: 0.15 }, control4h: 1, rejection: true }, E.ctx);
  assert.ok(!add.intents.some(i => i.kind === 'add' || i.kind === 'entry')); assert.strictEqual(add.notes[0], 'add-refused:blocked:stop-rejected');
  const snap = { type: 'reconcile', id: 'rc', position: { qty: 1, dir: 1 }, orders: E.b.working().map(o => ({ key: o.key, qty: o.qty - o.filled, price: o.price })) };
  const Ex = { ...E, st: E.st, intents: [...E.intents] };   // (a copy for the crossing check below)
  settle(E, [snap], { check: false }); assert.strictEqual(E.st.block, null); assert.ok(E.notes.includes('reconcile-clean'));
  E.b.lastPx = 20070; settle(Ex, [{ type: 'ladder', id: 'Lc', bestPx: 20221, lastPx: 20070, invalidated: false }], { check: false });   // the failed tighter level 20073 now traded
  assert.ok(Ex.st.flat && Ex.st.flat.reason.includes('unplaceable stop level 20073'), 'the failed level is crossed: the exit starts');
  // rejected with the market already through the level: the flatten lifecycle (never a wider stop)
  const H = longA(); let r = T.plan(H.st, { type: 'fill', id: 'hf', key: H.intents[1].key, filledQty: 3, avgPx: 20000 }, H.ctx); const stopIt = r.intents.find(i => i.kind === 'stop');
  r = T.plan(r.state, { type: 'reject', id: 'hr', key: stopIt.key, reason: 'through the market', lastPx: 19850 }, H.ctx);
  assert.strictEqual(r.state.flat.phase, 'clearing'); assert.ok(!r.intents.some(i => (i.op === 'place' || i.op === 'modify') && i.kind === 'stop'));
});
t('ruling 4: the BROKER-ACKED level is recorded: a fallback tighter than the current stop is adopted; one looser is alerted, blocks and is tightened back', () => {
  let E = longA(); walk(E, [20000, 20090]);   // BE 20000.25 acked
  E.b.stopFallback = { px: 20060 };   // replaceStopSafely could not place 20073 and put the best VALID level 20060 (tighter than 20000.25, short of the wish)
  settle(E, E.b.tick(20220)); settle(E, [{ type: 'ladder', id: 'Lf', bestPx: 20220, lastPx: 20220, invalidated: false }]);
  assert.deepStrictEqual([E.st.protPx, E.st.stopPx], [20060, 20060]); assert.ok(E.notes.includes('stop-fallback-level:20060'));
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => o.price), [20060]);
  const nextModify = ofKind(E, 'modify', 'stop').length; settle(E, [{ type: 'ladder', id: 'Lf2', bestPx: 20221, lastPx: 20221, invalidated: false }]);
  assert.deepStrictEqual(ofKind(E, 'modify', 'stop').slice(nextModify).map(i => i.price), [20073], 'the next step works from the broker level (re-proposes the lock)');
  E = longA(); walk(E, [20000, 20090]); E.b.stopFallback = { px: 19990 };   // a fallback LOOSER than the protective 20000.25: never accepted as the level
  settle(E, E.b.tick(20220)); settle(E, [{ type: 'ladder', id: 'Ll', bestPx: 20220, lastPx: 20220, invalidated: false }], { check: false });
  assert.ok(E.intents.some(i => i.code === 'stop-looser')); assert.strictEqual(E.st.block, 'stop-looser');
  const back = ofKind(E, 'modify', 'stop').slice(-1)[0]; assert.ok(back.price >= 20000.25, `tightened back (${back.price})`);
  assert.ok(E.b.working().filter(o => o.kind === 'stop').every(o => o.price >= 20000.25));
});
t('restart mid-trade: the saved state + a broker reconcile -> only the guard when they agree; protective repairs and a block when not', () => {
  const E = longA(); walk(E, [20000, 20090]);
  const saved = JSON.stringify(E.st), snap = () => E.b.working().map(o => ({ key: o.key, qty: o.qty - o.filled, price: o.price }));
  let r = T.plan(JSON.parse(saved), { type: 'reconcile', id: 'boot1', position: { qty: 1, dir: 1 }, orders: snap() }, E.ctx);
  assert.deepStrictEqual([r.intents.map(i => i.op), r.state.block, r.notes.includes('reconcile-clean')], [['guard'], null, true]);
  r = T.plan(JSON.parse(saved), { type: 'reconcile', id: 'boot2', position: { qty: 1, dir: 1 }, orders: snap().filter(o => !o.key.includes(':stop:')) }, E.ctx);
  assert.ok(r.intents.some(i => i.code === 'no-stop')); assert.strictEqual(r.state.flat.phase, 'clearing'); assert.ok(!r.intents.some(i => i.op === 'place'), 'r1.2: no repair-and-wait: the exit');
  r = T.plan(JSON.parse(saved), { type: 'reconcile', id: 'boot3', position: { qty: 2, dir: 1 }, orders: snap() }, E.ctx);
  assert.deepStrictEqual(r.intents.filter(i => i.op !== 'alert' && i.op !== 'guard').map(i => [i.op, i.kind, i.qty]), [['modify', 'stop', 2]]); assert.ok(r.state.block);
  r = T.plan(JSON.parse(saved), { type: 'reconcile', id: 'boot4', position: { qty: 1, dir: 1 }, orders: snap().concat([{ key: null, orderId: 999, qty: 1, price: 19000 }]) }, E.ctx);
  assert.deepStrictEqual(r.intents.map(i => i.op), ['guard', 'alert']); assert.strictEqual(r.state.block, 'reconcile-unknown-order');
  r = T.plan(T.initState('pos-9'), { type: 'reconcile', id: 'boot5', position: { qty: 3, dir: 1 }, orders: [] }, E.ctx); assert.deepStrictEqual(r.intents.map(i => [i.op, i.code]), [['alert', 'reconcile-position']]);
});
t('duplicate events: every event replayed gives no intents and the same state (checked inside settle); a content-identical event without an id too', () => {
  const E = longA(); walk(E, [20000, 20090, 20220, 20300]); assert.ok(E.events.length > 15);
  for (const e of E.events) assert.deepStrictEqual(T.plan(E.st, e, E.ctx).intents, []);
  const s0 = T.initState('pos-d'), ev = { type: 'signal', dir: 1, grade: 'C', entryPx: 20000, stop: 19950, pools: [] }, a = T.plan(s0, ev, { cfg: FLAT });
  assert.strictEqual(a.intents.length, 2); assert.deepStrictEqual(T.plan(a.state, { ...ev }, { cfg: FLAT }).intents, []); assert.deepStrictEqual(s0, T.initState('pos-d'), 'plan never mutates its input');
});
t('reserved exposure (Stage 2c groundwork): a live resting entry counts until its cancel is acked; an add over maxContracts is refused', () => {
  const E = longA(); walk(E, [20000, 20090, 20220]);   // 1 open, stop 20073 acked
  const st = JSON.parse(JSON.stringify(E.st)), k = `${st.id}:entry:999`;
  st.orders[k] = { key: k, kind: 'entry', leg: 2, side: 'BUY', orderType: 'LIMIT', qty: 4, price: 20100, wantPx: 20100, status: 'cancel-sent', filled: 0, avgPx: null };
  let x = T.exposure(st, E.ctx); assert.deepStrictEqual([x.openQty, x.reservedRestingQty, x.totalQty], [1, 4, 5]);
  const r = T.plan(st, { type: 'pullback-add', id: 'capadd', addPx: 20146, lastPx: 20146, bias: { m15: 0.3, m30: 0.3, line: 0.15 }, control4h: 1, rejection: true }, { cfg: CFG({ mode: 'grade', maxContracts: 5 }) });
  assert.deepStrictEqual([r.intents.length, r.notes.includes('add-refused:exposure-cap')], [0, true]);   // 1 open + 4 reserved + 1 add = 6 > 5
  const r2 = T.plan(st, { type: 'cancel-ack', id: 'relq', key: k }, E.ctx); x = T.exposure(r2.state, E.ctx); assert.deepStrictEqual([x.reservedRestingQty, x.totalQty], [0, 1]);
});
t('fail closed on unknown broker state: no-ack, a fill for an unknown order, an unknown event -> blocked + alert, the stop kept, no new entry/add', () => {
  const E = longA(); walk(E, [20000]);
  for (const ev of [{ type: 'no-ack', id: 'u1', key: E.st.stopKey }, { type: 'fill', id: 'u2', key: 'nobody:1', filledQty: 1, avgPx: 1 }, { type: 'weird', id: 'u3' }]) {
    const r = T.plan(E.st, ev, E.ctx);
    assert.ok(r.state.block, ev.type); assert.ok(r.intents.some(i => i.op === 'alert'), ev.type); assert.ok(!r.intents.some(i => i.op === 'cancel' && i.kind === 'stop'));
    assert.ok(!r.intents.some(i => i.op === 'place' && (i.kind === 'entry' || i.kind === 'add')));
  }
});
// ---------------------------------------------------------------- the flatten lifecycle (ruling 6: sessionFlatten's reviewed order)
const flatEnv = (mode = 'normal') => { const E = longA(GRADE, [{ price: 20500 }, { price: 20600, major: true }]); walk(E, [20000]); E.b.lastPx = 20140; E.b.flattenMode = mode; return E; };
const crossLadder = (E, id = 'LX', check = true) => settle(E, [{ type: 'ladder', id, bestPx: 20292, lastPx: 20140, invalidated: false }], { check });
t('flatten: targets cleared -> the stop cancelled (VERIFIED) -> position read -> ONE market close of that quantity -> second read -> DONE; exit vs ladder recorded', () => {
  const E = flatEnv(), before = E.intents.length; crossLadder(E);
  assert.deepStrictEqual(E.intents.slice(before).map(i => [i.op, i.kind]), [['cancel', 'tp1'], ['cancel', 'tp2'], ['cancel', 'stop'], ['read', 'position'], ['flatten', 'position'], ['read', 'position']]);
  const fl = ofKind(E, 'flatten', 'position')[0]; assert.deepStrictEqual([fl.qty, fl.side, fl.orderType, fl.expectOpen, fl.stopCancelledVerified], [3, 'SELL', 'MARKET', 3, true]);
  assert.deepStrictEqual(T.plan(E.st, { type: 'ladder', id: 'Ly', bestPx: 20300, lastPx: 20130, invalidated: false }, E.ctx).intents, []);
  assert.strictEqual(E.st.phase, 'DONE'); assert.deepStrictEqual(E.b.working(), []); assert.strictEqual(E.b.pos, 0);
  assert.deepStrictEqual(E.st.flat.realized, { qty: 3, avgPx: 20140, vsLadderPts: -6, vsTriggerPts: 0, byKind: { position: 3 } });
});
t('flatten: the stop cancel is NOT verified -> no market order; one retry, then alert; the stop keeps working', () => {
  const E = flatEnv(); E.b.reject(it => it.op === 'cancel' && it.kind === 'stop', 'not confirmed'); E.b.reject(it => it.op === 'cancel' && it.kind === 'stop', 'not confirmed');
  crossLadder(E, 'LXc', false);
  assert.strictEqual(ofKind(E, 'cancel', 'stop').length, 2); assert.strictEqual(ofKind(E, 'flatten', 'position').length, 0);
  assert.strictEqual(E.st.flat.phase, 'cancel-failed'); assert.ok(E.intents.some(i => i.code === 'stop-cancel-failed'));
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => o.qty), [3]); invariants(E);
});
t('flatten: a retry storm (exit requests, crossed ladders, duplicate read answers, replays) sends ONE market close, never an opposite order', () => {
  const E = flatEnv(); E.b.holdReads = true; crossLadder(E, 'LXs', false);
  const storm = [];
  for (let i = 0; i < 15; i++) storm.push({ type: 'exit-at-market', id: `x${i}`, reason: 'storm', lastPx: 20140 }, { type: 'ladder', id: `ls${i}`, bestPx: 20300 + i, lastPx: 20130, invalidated: false }, { type: 'exit-at-market', id: 'x0', reason: 'dup' });
  storm.push({ type: 'pullback-add', id: 'sadd', addPx: 20130, bias: { m15: 0.3, m30: 0.3, line: 0.15 }, control4h: 1, rejection: true }, { type: 'tp1-traded', id: 'stp1', px: 20146 });
  settle(E, storm, { check: false });
  assert.strictEqual(ofKind(E, 'flatten', 'position').length, 0, 'nothing sent before the position read');
  const readKey = E.st.flat.readKey; settle(E, E.b.releaseReads(), { check: false });
  for (let i = 0; i < 5; i++) settle(E, [{ ...E.b.readNow(readKey), id: `dupread${i}` }], { check: false });
  const fl = ofKind(E, 'flatten', 'position'); assert.strictEqual(fl.length, 1); assert.strictEqual(E.b.flattensExecuted, 1); assert.strictEqual(fl[0].side, 'SELL');
  const afterTrigger = E.intents.slice(E.intents.findIndex(i => i.op === 'cancel' && i.kind === 'tp1'));
  assert.ok(!afterTrigger.some(i => i.op === 'place' || i.op === 'modify'), 'no new order of any kind after the exit began');
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.violations, []);
});
t('flatten: restart mid-flatten (the market went through / never left / half filled) -> re-protected at the last acked price, one real exit, no duplicate, no reversal', () => {
  for (const [label, brokerDoes, expectQty] of [['went through before the crash', 'all', 0], ['never reached the broker', 'none', 3], ['filled 2 before the crash', 2, 1]]) {
    const E = flatEnv('hold'); crossLadder(E, `L-${label}`, false);
    const sent = ofKind(E, 'flatten', 'position'); assert.strictEqual(sent.length, 1, label);
    const saved = JSON.stringify(E.st); E.b.heldFlatten = []; E.b.flattenMode = 'normal';
    if (brokerDoes === 'all') E.b.runFlatten(sent[0]); else if (brokerDoes !== 'none') { E.b.flattenMode = `partial:${brokerDoes}`; E.b.runFlatten(sent[0]); }
    const R = { ...E, st: JSON.parse(saved), intents: [...E.intents] }, k = R.intents.length;
    const snap = E.b.readNow(null); delete snap.key; snap.id = `boot-${label}`; settle(R, [snap], { check: false });
    const fresh = R.intents.slice(k);
    if (expectQty) assert.deepStrictEqual(fresh.filter(i => i.op === 'place' && i.kind === 'stop').map(i => [i.qty, i.price]), [[expectQty, 19854]], `${label}: re-protected at the last acked price first`);
    assert.deepStrictEqual(fresh.filter(i => i.op === 'flatten').map(i => i.qty), expectQty ? [expectQty] : [], label);
    assert.strictEqual(R.st.phase, 'DONE', label); assert.strictEqual(R.b.pos, 0, label); assert.deepStrictEqual(R.b.violations, [], label); assert.deepStrictEqual(R.b.working(), [], label);
  }
});
t('flatten: a partial market fill -> the rest re-protected at once (last acked price), then the next pass for the rest only', () => {
  const E = flatEnv('partial:2'); crossLadder(E);
  const tail = E.intents.slice(E.intents.findIndex(i => i.op === 'cancel' && i.kind === 'stop'));
  assert.deepStrictEqual(tail.filter(i => i.op !== 'read').map(i => [i.op, i.kind, i.qty]), [['cancel', 'stop', 3], ['flatten', 'position', 3], ['place', 'stop', 1], ['cancel', 'stop', 1], ['flatten', 'position', 1]]);
  assert.strictEqual(ofKind(E, 'place', 'stop').slice(-1)[0].price, 19854);
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.violations, []); assert.deepStrictEqual([E.st.flat.realized.qty, E.st.flat.realized.byKind], [3, { position: 3 }]);
});
t('flatten: the stop fills during its cancel -> no market order, no reverse position, the exit recorded as the stop fill; a hand-close race is caught (backstop)', () => {
  let E = flatEnv(); E.b.fillOnCancel = true; E.b.lastPx = 20140; crossLadder(E);
  assert.strictEqual(ofKind(E, 'flatten', 'position').length, 0); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.violations, []); assert.strictEqual(E.st.phase, 'DONE');
  assert.deepStrictEqual([E.st.flat.realized.qty, E.st.flat.realized.byKind, E.st.flat.realized.avgPx], [3, { stop: 3 }, 19854]);
  E = flatEnv('manualClose'); const k = E.intents.length; crossLadder(E, 'LXr', false);
  const after = E.intents.slice(E.intents.findIndex((i, j) => j >= k && i.op === 'flatten') + 1);
  assert.ok(E.b.violations.length > 0, 'the broker did reverse (a hand close between the read and the send)'); assert.ok(E.intents.some(i => i.code === 'position-reversed'), 'the confirming read catches it');
  assert.ok(!after.some(i => i.op === 'place' || i.op === 'modify' || i.op === 'flatten'), 'nothing that could add to the reversal');
  assert.strictEqual(E.st.phase, 'REVERSED'); assert.strictEqual(E.st.block, 'position-reversed');
});
t('flatten: no answer for the market close -> the stop re-placed at once at its last acked price + alert; NEVER re-sent; its late fill completes the exit', () => {
  const E = flatEnv('noack'); crossLadder(E, 'LXn', false);
  assert.strictEqual(ofKind(E, 'flatten', 'position').length, 1); assert.ok(E.intents.some(i => i.code === 'flatten-stalled'));
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => [o.qty, o.price]), [[3, 19854]], 're-protected at once');
  assert.strictEqual(E.st.flat.phase, 'stalled'); invariants(E);
  settle(E, [{ type: 'exit-at-market', id: 'n2', lastPx: 20130 }, { type: 'ladder', id: 'Ln2', bestPx: 20292, lastPx: 20130, invalidated: false }], { check: false });
  assert.strictEqual(ofKind(E, 'flatten', 'position').length, 1);
  settle(E, E.b.runFlatten(E.b.heldFlatten.shift()), { check: false });
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.violations, []); assert.strictEqual(E.b.flattensExecuted, 1); assert.deepStrictEqual(E.b.working(), []);
});
t('flatten: a broker reject of the market close -> the stop re-placed at once at its last acked price + alert; no second flatten ever', () => {
  const E = flatEnv(); E.b.reject(it => it.op === 'flatten', 'rejected (fake)'); crossLadder(E, 'LXj', false);
  assert.ok(E.intents.some(i => i.code === 'flatten-rejected')); assert.strictEqual(E.st.flat.phase, 'rejected'); assert.strictEqual(E.st.block, 'flatten-rejected');
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => [o.qty, o.price]), [[3, 19854]]);
  settle(E, [{ type: 'exit-at-market', id: 'again', lastPx: 20120 }, { type: 'ladder', id: 'Lagain', bestPx: 20292, lastPx: 20120, invalidated: false }], { check: false });
  assert.strictEqual(ofKind(E, 'flatten', 'position').length, 1); assert.strictEqual(E.b.pos, 3);
  settle(E, [{ type: 'ladder', id: 'Lup', bestPx: 20292, lastPx: 20200, invalidated: false }], { check: false });
  assert.deepStrictEqual(E.b.working().filter(o => o.kind === 'stop').map(o => [o.qty, o.price]), [[3, 20146]], 'still protected, still only tightening');
});
t('r1.2: a naked position after the SECOND stop reject is closed at once (flatten lifecycle, + alert); never a third try, never wider', () => {
  const E = longA(); E.b.reject(it => it.op === 'place' && it.kind === 'stop'); E.b.reject(it => it.op === 'place' && it.kind === 'stop');
  settle(E, E.b.tick(20000), { check: false });
  assert.deepStrictEqual(ofKind(E, 'place', 'stop').map(i => i.price), [19854, 19854], 'the same price once more, then no third try');
  assert.ok(E.intents.some(i => i.code === 'no-stop')); assert.ok(E.notes.includes('naked:flatten'));
  assert.deepStrictEqual(ofKind(E, 'flatten', 'position').map(i => i.qty), [3]);
  assert.ok(!E.intents.some(i => i.op === 'cancel' && i.kind === 'stop'), 'no stop rests: the cancel-verify step is moot');
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.violations, []); assert.deepStrictEqual(E.b.working(), []);
  // the stop cancelled unexpectedly at the broker and its re-placement rejected twice: closed too
  const F = longA(); walk(F, [20000, 20090]); const sk = F.st.stopKey; F.b.orders.delete(sk); F.b.reject(it => it.kind === 'stop'); F.b.reject(it => it.kind === 'stop');
  settle(F, [{ type: 'cancel-ack', id: 'gone', key: sk }], { check: false });
  assert.strictEqual(ofKind(F, 'flatten', 'position').length, 1); assert.strictEqual(F.st.phase, 'DONE'); assert.strictEqual(F.b.pos, 0);
});
t('r1.2: a restart that finds the position with NO working stop closes it at once (flatten lifecycle, + alert)', () => {
  const E = longA(); walk(E, [20000, 20090]);   // 1 open, BE stop working, TP2 working
  const saved = JSON.stringify(E.st); const sk = E.st.stopKey; E.b.orders.delete(sk);   // the stop is gone at the broker (lost while the bot was down)
  const R = { ...E, st: JSON.parse(saved), intents: [...E.intents] }, k = R.intents.length;
  const snap = E.b.readNow(null); delete snap.key; snap.id = 'boot-naked'; settle(R, [snap], { check: false });
  const fresh = R.intents.slice(k);
  assert.ok(fresh.some(i => i.code === 'no-stop')); assert.ok(!fresh.some(i => i.op === 'place'), 'no repair-and-wait');
  assert.deepStrictEqual(fresh.filter(i => i.op === 'flatten').map(i => i.qty), [1]);
  assert.strictEqual(R.st.phase, 'DONE'); assert.strictEqual(R.b.pos, 0); assert.deepStrictEqual(R.b.violations, []); assert.deepStrictEqual(R.b.working(), []);
  // a restart that finds a working stop is NOT closed (only the guard)
  const G = longA(); walk(G, [20000, 20090]); const s2 = G.b.readNow(null); delete s2.key; s2.id = 'boot-ok';
  const r = T.plan(JSON.parse(JSON.stringify(G.st)), s2, G.ctx); assert.deepStrictEqual(r.intents.map(i => i.op), ['guard']); assert.strictEqual(r.state.flat, null);
});
t('r1.2: inside the exit, a rejected market close whose re-placed stop is also rejected twice gets exactly ONE more market close (never left naked)', () => {
  const E = flatEnv(); E.b.reject(it => it.op === 'flatten', 'rejected (fake)'); E.b.reject(it => it.op === 'place' && it.kind === 'stop'); E.b.reject(it => it.op === 'place' && it.kind === 'stop');
  crossLadder(E, 'LXnk', false);
  assert.ok(E.intents.some(i => i.code === 'naked-retry')); assert.strictEqual(ofKind(E, 'flatten', 'position').length, 2);
  assert.strictEqual(E.st.phase, 'DONE'); assert.strictEqual(E.b.pos, 0); assert.deepStrictEqual(E.b.violations, []);
});
t('every intent op/kind the tests produced has a row in MAP.md; the planner is pure (no I/O, clock, executor import, day limit)', () => {
  const map = fs.readFileSync(path.join(__dirname, '..', 'MAP.md'), 'utf8');
  const rows = map.split('\n').filter(l => l.startsWith('| `')).map(l => l.split('|').map(c => c.trim()));
  const has = (op, kind) => rows.some(c => c[1] === `\`${op}\`` && (c[2].match(/`([^`]+)`/g) || []).includes(`\`${kind}\``) && /\(|`/.test(c[3]));
  assert.ok(SEEN_PAIRS.size >= 12, `${SEEN_PAIRS.size} op/kind pairs seen`);
  for (const pair of SEEN_PAIRS) { const [op, kind] = pair.split('|'); assert.ok(has(op, kind), `MAP.md has no row for ${op} / ${kind}`); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tideOrders.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.deepStrictEqual(src.match(/require\([^)]*\)/g), ["require('./moneyRule')"]);
  assert.ok(!/Date\.now|new Date|setTimeout|setInterval|process\.|\bfs\b|live-executor|liveStateMachine|liveOrders/.test(src));
  assert.ok(!/day|daily|lossLimit|fullStop/i.test(src.replace(/NO daily loss limit/g, '')), 'no day / loss-limit logic');
});

console.log(`tideOrders ${T.VERSION}: ${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
