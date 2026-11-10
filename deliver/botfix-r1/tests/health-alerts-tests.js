'use strict';
// bf-alerts r1 unit tests: fake clock, fake push sink, temp files. Offline. Run: node tests/health-alerts-tests.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const HA = require('../lib/healthAlerts');
const WD = require('../health-watchdog');

const MIN = 60000;
const TUE_10PT = Date.parse('2026-11-10T18:00:00Z');   // Tue 10:00 PT (in trading hours)
const SAT_NOON = Date.parse('2026-11-14T20:00:00Z');   // Sat 12:00 PT (closed)
const SUN_1450 = Date.parse('2026-11-15T22:50:00Z');   // Sun 14:50 PT (opens 15:00 PT)
const XMAS = Date.parse('2026-12-25T18:00:00Z');       // Fri 10:00 PT, a full CME closure (unverified list)

let passed = 0, failed = 0;
const fail = (name, e) => { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n     ')); };
function test(name, fn) { try { HA._resetActive(); const p = fn(); if (p && typeof p.then === 'function') { pendingTests++; p.then(() => { passed++; console.log('ok   ' + name); }, e => fail(name, e)).then(() => pendingTests--); return; } passed++; console.log('ok   ' + name); } catch (e) { fail(name, e); } }
let pendingTests = 0;
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-')); }
function rig(t0, extra = {}) {
  const clock = { t: t0 }, pushes = [], rows = [], logs = [];
  const h = HA.createHealthAlerts({ now: () => clock.t, notify: (title, body, o) => { pushes.push({ title, body, ...o }); return Promise.resolve(); }, log: m => logs.push(m), setIntervalFn: () => null, ...extra });
  h.attachJournal(r => rows.push(r));
  return { h, clock, pushes, rows, logs, adv(ms) { clock.t += ms; } };
}
const titles = r => r.pushes.map(p => p.title);
// drive passes every 20 s for `ms`
function run(r, ms, passArgs) { const end = r.clock.t + ms; while (r.clock.t < end) { r.adv(20000); if (passArgs) r.h.pass(typeof passArgs === 'function' ? passArgs(r.clock.t) : passArgs); else r.h.check(); } }

// ---------- 1. not LIVE ----------
test('not-live: warm-up 45 min in hours -> push at 10 min, re-push at 40 min, recovered once', () => {
  const r = rig(TUE_10PT); r.h.warmupStart();
  run(r, 9.5 * MIN); assert.strictEqual(r.pushes.length, 0);
  run(r, 1 * MIN); assert.deepStrictEqual(titles(r), ['Bot NOT LIVE for 10 min']);
  assert.match(r.pushes[0].body, /warming up/); assert.strictEqual(r.pushes[0].priority, 'urgent');
  run(r, 25 * MIN); assert.strictEqual(r.pushes.length, 1, 'no re-push before 30 min');
  run(r, 6 * MIN); assert.strictEqual(r.pushes.length, 2); assert.match(r.pushes[1].body, /Reminder 2/);
  r.h.warmupResult({ bars: 2000, need: 2000 });
  run(r, 5 * MIN, { ok: true, barT: null }); 
  assert.strictEqual(r.pushes.length, 3); assert.strictEqual(r.pushes[2].title, 'Bot is LIVE again');
  run(r, 60 * MIN, { ok: true }); assert.strictEqual(r.pushes.length, 3, 'recovered fires once');
  assert.strictEqual(r.rows.filter(x => x.type === 'alert').length, 3);
});
test('not-live: a 9-min desync -> no push and no recovered', () => {
  const r = rig(TUE_10PT); r.h.warmupResult({ bars: 2000 });
  run(r, 2 * MIN, { ok: true }); run(r, 9 * MIN, { ok: true, reason: 'DESYNCED' }); run(r, 30 * MIN, { ok: true });
  assert.strictEqual(r.pushes.length, 0);
});
test('not-live: failing passes (auth / errors) for 12 min -> one push, then recovered', () => {
  const r = rig(TUE_10PT); r.h.warmupResult({ bars: 2000 }); run(r, MIN, { ok: true });
  run(r, 12 * MIN, { ok: false, reason: 'a loop pass failed: HTTP 401' });
  assert.deepStrictEqual(titles(r), ['Bot NOT LIVE for 10 min']); assert.match(r.pushes[0].body, /HTTP 401/);
  run(r, MIN, { ok: true }); assert.deepStrictEqual(titles(r).slice(1), ['Bot is LIVE again']);
});
test('not-live: no alerts outside trading hours (Saturday all day)', () => {
  const r = rig(SAT_NOON); r.h.warmupResult({ bars: 2000 });
  run(r, 2 * 60 * MIN, { ok: true, reason: 'DESYNCED' }); assert.strictEqual(r.pushes.length, 0);
});
test('not-live: clock starts at the session open (Sun 15:00 PT) -> first push 15:10', () => {
  const r = rig(SUN_1450); r.h.warmupResult({ bars: 2000 });
  run(r, 19 * MIN, { ok: true, reason: 'DESYNCED' }); assert.strictEqual(r.pushes.length, 0, 'not before 15:10');
  run(r, 1.5 * MIN, { ok: true, reason: 'DESYNCED' }); assert.strictEqual(r.pushes.length, 1);
});
test('not-live: an episode that runs past the close ends silently (no recovered outside hours)', () => {
  const t = Date.parse('2026-11-10T20:55:00Z');   // Tue 12:55 PT; closes 13:10
  const r = rig(t); r.h.warmupResult({ bars: 2000 });
  run(r, 12 * MIN, { ok: true, reason: 'DESYNCED' }); assert.strictEqual(r.pushes.length, 1);
  run(r, 30 * MIN, { ok: true, reason: 'DESYNCED' }); run(r, 5 * MIN, { ok: true });
  assert.strictEqual(r.pushes.length, 1);
});
test('not-live: custom inTradingHours (session-close flatten window) is honoured', () => {
  const r = rig(TUE_10PT, { inTradingHours: () => false }); r.h.warmupResult({ bars: 2000 });
  run(r, 60 * MIN, { ok: true, reason: 'DESYNCED' }); assert.strictEqual(r.pushes.length, 0);
});
test('not-live: loop stalled (no pass for 5 min) detected by the timer alone -> push 10 min after the last pass', () => {
  const r = rig(TUE_10PT); r.h.warmupResult({ bars: 2000 }); run(r, MIN, { ok: true });
  const last = r.clock.t; run(r, 9 * MIN); assert.strictEqual(r.pushes.length, 0);
  run(r, 1.5 * MIN); assert.strictEqual(r.pushes.length, 1); assert.match(r.pushes[0].body, /no loop pass completed for 1[01] min/);
  assert.ok(r.pushes[0].body.includes(new Date(last).toISOString().slice(11, 16)));
  r.h.pass({ ok: true }); assert.strictEqual(r.pushes[1].title, 'Bot is LIVE again');
});
test('not-live: market data stale (1m bar 5+ min old) -> push after 10 min; fresh bar recovers', () => {
  const r = rig(TUE_10PT); r.h.warmupResult({ bars: 2000 }); const barT = TUE_10PT;
  run(r, 16 * MIN, { ok: true, barT }); assert.deepStrictEqual(titles(r), ['Bot NOT LIVE for 10 min']); assert.match(r.pushes[0].body, /market data stale/);
  run(r, MIN, t => ({ ok: true, barT: t })); assert.strictEqual(r.pushes[1].title, 'Bot is LIVE again');
});
test('not-live: data stale is quiet on a full CME closure day and on staleExempt days', () => {
  const r = rig(XMAS); r.h.warmupResult({ bars: 2000 }); run(r, 60 * MIN, { ok: true, barT: XMAS }); assert.strictEqual(r.pushes.length, 0);
  const r2 = rig(TUE_10PT, { staleExempt: () => true }); r2.h.warmupResult({ bars: 2000 }); run(r2, 60 * MIN, { ok: true, barT: TUE_10PT }); assert.strictEqual(r2.pushes.length, 0);
});

// ---------- 2. restarts ----------
test('restarts: 3 starts in 30 min -> one push; a 4th -> none; a new window -> again', () => {
  const d = tmpdir(), sf = path.join(d, 'health-state.json'); const all = [];
  const start = t => { const r = rig(t, { stateFile: sf }); r.h.noteStart(); all.push(...r.pushes); return r; };
  start(TUE_10PT); start(TUE_10PT + 5 * MIN); assert.strictEqual(all.length, 0);
  start(TUE_10PT + 12 * MIN); assert.strictEqual(all.length, 1); assert.strictEqual(all[0].title, 'Bot restarted 2 times in 30 min');
  start(TUE_10PT + 20 * MIN); assert.strictEqual(all.length, 1, '4th start in the same window: no push');
  start(TUE_10PT + 50 * MIN); assert.strictEqual(all.length, 1, 'only 2 starts within 30 min of 10:50 (10:20, 10:50)');
  start(TUE_10PT + 55 * MIN); assert.strictEqual(all.length, 1, 'still only 2 in the window (10:50, 10:55)');
  start(TUE_10PT + 58 * MIN); assert.strictEqual(all.length, 2, '3 starts within 30 min again and the last push > 30 min ago');
  const st = JSON.parse(fs.readFileSync(sf, 'utf8')); assert.ok(Array.isArray(st.starts) && st.starts.length === 3 && st.starts.every(x => TUE_10PT + 58 * MIN - x < 30 * MIN));
});
test('restarts: starts 31 min apart never alert', () => {
  const d = tmpdir(), sf = path.join(d, 's.json'); let n = 0;
  for (let i = 0; i < 6; i++) { const r = rig(TUE_10PT + i * 31 * MIN, { stateFile: sf }); r.h.noteStart(); n += r.pushes.length; }
  assert.strictEqual(n, 0);
});
test('restarts: an unreadable state file does not throw', () => {
  const d = tmpdir(), sf = path.join(d, 's.json'); fs.writeFileSync(sf, '{not json');
  const r = rig(TUE_10PT, { stateFile: sf }); assert.strictEqual(r.h.noteStart(), 1);
});

// ---------- 3. warm-up ----------
test('warm-up: 2000 bars -> no push; 600 bars -> "cut short" once', () => {
  const a = rig(TUE_10PT); a.h.warmupStart(); a.h.warmupResult({ bars: 2001, need: 2000 }); a.h.pass({ ok: true }); assert.strictEqual(a.pushes.length, 0);
  const b = rig(TUE_10PT); b.h.warmupStart(); b.adv(90000); b.h.warmupResult({ bars: 600, need: 2000 }); b.h.warmupResult({ bars: 600, need: 2000 });
  assert.deepStrictEqual(titles(b), ['Warm-up cut short']); assert.match(b.pushes[0].body, /600 15m bars of the 2000.*after 90 s/);
});
test('warm-up: an error -> "FAILED"', () => {
  const r = rig(TUE_10PT); r.h.warmupStart(); r.h.warmupResult({ error: new Error('History fetch HTTP 500') });
  assert.deepStrictEqual(titles(r), ['Warm-up FAILED']); assert.match(r.pushes[0].body, /HTTP 500/);
});
test('warm-up: the loop starting without one -> "SKIPPED" once', () => {
  const r = rig(TUE_10PT); r.h.pass({ ok: true }); r.h.pass({ ok: true }); assert.deepStrictEqual(titles(r), ['Warm-up SKIPPED']);
});
test('warm-up: the previous process ended mid warm-up -> "STOPPED" on the next start; a finished one -> nothing', () => {
  const d = tmpdir(), sf = path.join(d, 's.json');
  const a = rig(TUE_10PT, { stateFile: sf, pid: 111 }); a.h.noteStart(); a.h.warmupStart();   // killed here
  const b = rig(TUE_10PT + 3 * MIN, { stateFile: sf, pid: 222 }); b.h.noteStart(); assert.deepStrictEqual(titles(b), ['Warm-up STOPPED before it finished']);
  b.h.warmupStart(); b.h.warmupResult({ bars: 2000 });
  const c = rig(TUE_10PT + 40 * MIN, { stateFile: sf, pid: 333 }); c.h.noteStart(); assert.strictEqual(c.pushes.length, 0);
});

// ---------- 4. full stop ----------
test('full stop: one push per trade with side, qty, entry, exit, pts/contract, $ net', () => {
  const r = rig(TUE_10PT, { pointValue: 2, costPerContractRoundTrip: 1.22 });
  r.h.fullStop({ key: 'J1', dir: 1, qty: 3, entry: 21000, exit: 20980 });
  r.h.fullStop({ key: 'J1', dir: 1, qty: 3, entry: 21000, exit: 20980 });
  assert.strictEqual(r.pushes.length, 1);
  const p = r.pushes[0]; assert.strictEqual(p.title, 'Full stop: LONG 3x -$123.66 net');
  assert.match(p.body, /LONG 3x entry 21000\.00 -> exit 20980\.00 = -20\.00 pts\/contract, -\$123\.66 net/);
  const row = r.rows.find(x => x.kind === 'full-stop'); assert.strictEqual(row.netUsd, -123.66); assert.strictEqual(row.ptsPerContract, -20);
  r.h.fullStop({ key: 'J2', dir: -1, qty: 1, entry: 21000, exit: 21012.5, grossUsd: -25 }); assert.strictEqual(r.pushes[1].title, 'Full stop: SHORT 1x -$26.22 net');
});

// ---------- 5. healthAlert ----------
test('healthAlert(kind, details): pushes, de-dupes 30 min per key, journals, module forwarder works', () => {
  const r = rig(TUE_10PT);
  assert.strictEqual(HA.healthAlert('halt', { title: 'EXIT SAFETY HALT', message: 'stop not verified', key: 'exit-safety|J7', journalId: 'J7' }), true);
  assert.strictEqual(HA.healthAlert('halt', { title: 'EXIT SAFETY HALT', message: 'stop not verified', key: 'exit-safety|J7' }), false);
  assert.strictEqual(r.h.alert('halt', { title: 'EXIT SAFETY HALT', key: 'exit-safety|J8' }), true);
  r.adv(31 * MIN); assert.strictEqual(HA.healthAlert('halt', { title: 'EXIT SAFETY HALT', message: 'still', key: 'exit-safety|J7' }), true);
  assert.strictEqual(r.pushes.length, 3); assert.strictEqual(r.pushes[0].priority, 'urgent');
  const row = r.rows.find(x => x.kind === 'halt'); assert.strictEqual(row.type, 'alert'); assert.strictEqual(row.journalId, 'J7');
  assert.strictEqual(HA.healthAlert('halt', { dedupeMin: 0, title: 'x' }), true); assert.strictEqual(HA.healthAlert('halt', { dedupeMin: 0, title: 'x' }), true);
});
test('healthAlert before setup: returns false, no throw', () => { HA._resetActive(); assert.strictEqual(HA.healthAlert('halt', { a: 1 }), false); });

// ---------- push failures never crash ----------
test('a push that throws or rejects is logged, never thrown', async () => {
  const logs = []; let calls = 0;
  const h = HA.createHealthAlerts({ now: () => TUE_10PT, log: m => logs.push(m), setIntervalFn: () => null, notify: () => { calls++; if (calls === 1) throw new Error('boom'); return Promise.reject(new Error('net down')); } });
  assert.strictEqual(h.alert('halt', { title: 'A' }), true); assert.strictEqual(h.alert('halt', { title: 'B' }), true);
  h.fullStop({ key: 'k', dir: 1, qty: 1, entry: 1, exit: 0 });
  return new Promise(res => setImmediate(() => { assert.ok(logs.some(l => /push failed \(non-fatal\): boom/.test(l))); assert.ok(logs.some(l => /net down/.test(l))); assert.strictEqual(h.view().counts.pushFails, 3); res(); }));
});
test('bad inputs never throw', () => {
  const r = rig(TUE_10PT, { inTradingHours: () => { throw new Error('x'); }, staleExempt: () => { throw new Error('y'); } });
  r.h.pass(); r.h.pass(null || undefined); r.h.check(); r.h.fullStop(); r.h.fullStop(null || undefined); r.h.alert(); r.h.alert('k', 'a string'); r.h.warmupResult();
  run(r, 20 * MIN, { ok: false });
});

// ---------- journal + heartbeat ----------
test('alert rows from before the journal is attached are queued, then written in order', () => {
  const clock = { t: TUE_10PT }, rows = [];
  const h = HA.createHealthAlerts({ now: () => clock.t, notify: () => Promise.resolve(), setIntervalFn: () => null });
  h.warmupStart(); h.warmupResult({ bars: 10 }); h.alert('halt', { title: 'H' });
  h.attachJournal(r => rows.push(r)); assert.deepStrictEqual(rows.map(r => r.kind), ['warmup', 'halt']); assert.ok(rows.every(r => r.type === 'alert' && r.t === TUE_10PT));
});
test('heartbeat file: written on start and on checks, carries live/reason', () => {
  const d = tmpdir(), hb = path.join(d, 'hb.json'); const r = rig(TUE_10PT, { heartbeatFile: hb });
  r.h.start(); let j = JSON.parse(fs.readFileSync(hb, 'utf8')); assert.strictEqual(j.t, TUE_10PT); assert.strictEqual(j.live, false);
  r.h.warmupResult({ bars: 2000 }); r.adv(20000); r.h.pass({ ok: true }); j = JSON.parse(fs.readFileSync(hb, 'utf8')); assert.strictEqual(j.live, true); assert.strictEqual(j.t, TUE_10PT + 20000);
});

// ---------- 6. cap-guard log de-dupe ----------
test('once(): the cap-guard key logs once per setup per 15-min bucket', () => {
  const r = rig(TUE_10PT); const key = t => `cg|1|21000|${Math.floor(t / 900000)}`; let n = 0;
  for (let i = 0; i < 45; i++) { if (r.h.once(key(r.clock.t))) n++; r.adv(20000); }   // 15 min of 20-s polls, one bucket boundary at most
  assert.ok(n >= 1 && n <= 2, 'n=' + n);
  assert.strictEqual(r.h.once(`cg|-1|21000|${Math.floor(r.clock.t / 900000)}`), true, 'another setup logs');
});

// ---------- watchdog ----------
test('watchdog: fresh -> ok; stale 10+ min in hours -> push; re-push after 30; recovered once', () => {
  const inHours = true; let st = {};
  let d = WD.decide({ hb: { t: TUE_10PT, live: true }, st, now: TUE_10PT + 60000, inHours }); assert.strictEqual(d.push, null); st = d.st;
  d = WD.decide({ hb: { t: TUE_10PT }, st, now: TUE_10PT + 9 * MIN, inHours }); assert.strictEqual(d.push, null); st = d.st;
  d = WD.decide({ hb: { t: TUE_10PT }, st, now: TUE_10PT + 10 * MIN, inHours }); assert.strictEqual(d.push.title, 'Bot NOT RUNNING (no heartbeat)'); st = d.st;
  for (let m = 11; m < 40; m++) { d = WD.decide({ hb: { t: TUE_10PT }, st, now: TUE_10PT + m * MIN, inHours }); assert.strictEqual(d.push, null, 'm=' + m); st = d.st; }
  d = WD.decide({ hb: { t: TUE_10PT }, st, now: TUE_10PT + 40 * MIN, inHours }); assert.match(d.push.body, /Reminder 2/); st = d.st;
  d = WD.decide({ hb: { t: TUE_10PT + 41 * MIN, live: true }, st, now: TUE_10PT + 41 * MIN, inHours }); assert.strictEqual(d.push.title, 'Bot heartbeat is back'); st = d.st;
  d = WD.decide({ hb: { t: TUE_10PT + 42 * MIN }, st, now: TUE_10PT + 42 * MIN, inHours }); assert.strictEqual(d.push, null);
});
test('watchdog: missing heartbeat in hours -> push; outside hours -> nothing', () => {
  assert.ok(WD.decide({ hb: null, st: {}, now: TUE_10PT, inHours: true }).push);
  assert.strictEqual(WD.decide({ hb: null, st: {}, now: SAT_NOON, inHours: false }).push, null);
  assert.strictEqual(WD.inTradingHours(null, SAT_NOON), false); assert.strictEqual(WD.inTradingHours(null, TUE_10PT), true);
  assert.strictEqual(WD.inTradingHours(require('../lib/notifyPolicy'), TUE_10PT), true);
});
test('watchdog main(): no NTFY_TOPIC -> logs, writes its state, no network', async () => {
  const d = tmpdir(); fs.writeFileSync(path.join(d, 'health-heartbeat-MNQ.json'), JSON.stringify({ t: TUE_10PT - 20 * MIN }));
  const out = []; const orig = console.log; console.log = m => out.push(m);
  try { await WD.main(['--dir', d], {}, TUE_10PT); } finally { console.log = orig; }
  assert.match(out[0], /push 1 \[Bot NOT RUNNING \(no heartbeat\)\] -> not sent \(NTFY_TOPIC not set\)/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, 'health-watchdog-state-MNQ.json'), 'utf8')).alertedAt === TUE_10PT);
});

setTimeout(() => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }, 200);
