'use strict';
// botfix-B unit tests: node --test test/phone-snapshot.test.js (no broker, no network, no replay)
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Worker } = require('worker_threads');
const { createPhoneRequests, flattenResult, pauseResult, cancelResult } = require('../lib/phoneRequests');
const snap = require('../lib/phoneSnapshot'), reads = require('../lib/brokerReads');

const tmpDir = () => fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'pr-'));
function mk(clock) { const rows = [], logs = []; const pr = createPhoneRequests({ dir: clock.dir, symbol: 'MNQ', now: () => clock.t, journal: r => rows.push(r), log: m => logs.push(m) }); return { pr, rows, logs }; }
const put = (dir, name, obj, mtime) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000); return f; };

test('fresh flatten request is taken, file consumed, then acked APPLIED with its id', () => {
  const c = { dir: tmpDir(), t: 1_000_000 }; const { pr } = mk(c);
  const f = put(c.dir, 'flatten-request-MNQ.json', { id: 'f-abc', requestedAt: c.t - 2000 });
  const rq = pr.take('flatten');
  assert.equal(rq.id, 'f-abc'); assert.equal(rq.ageMs, 2000); assert.equal(fs.existsSync(f), false);
  pr.ack(rq, 'APPLIED', 'x');
  const v = pr.view(); assert.equal(v.lastAck.id, 'f-abc'); assert.equal(v.lastAck.result, 'APPLIED'); assert.equal(v.lastAck.receivedAt, c.t); assert.equal(v.appliedAt.flatten, c.t);
});

test('stale: a request older than 60 s is never acted on, gets a journal row and a STALE ack', () => {
  const c = { dir: tmpDir(), t: 5_000_000 }; const { pr, rows } = mk(c);
  const f = put(c.dir, 'flatten-request-MNQ.json', { id: 'f-old', requestedAt: c.t - 61_000 });
  assert.equal(pr.take('flatten'), null);
  assert.equal(fs.existsSync(f), false, 'consumed so it can never fire later');
  assert.equal(pr.view().lastAck.result, 'STALE'); assert.match(pr.view().lastAck.reason, /^STALE: written 61 s ago/);
  assert.equal(rows.length, 1); assert.equal(rows[0].type, 'phone_request'); assert.equal(rows[0].result, 'STALE'); assert.equal(rows[0].ageMs, 61_000);
  assert.equal(pr.view().appliedAt.flatten, null);
  // exactly 60 s is still accepted
  put(c.dir, 'flatten-request-MNQ.json', { id: 'f-60', requestedAt: c.t - 60_000 }); assert.ok(pr.take('flatten'));
});

test('stale: an old legacy file (no requestedAt) is aged by its mtime, e.g. after a restart', () => {
  const c = { dir: tmpDir(), t: Date.now() }; const { pr } = mk(c);
  put(c.dir, 'flatten-request-MNQ.json', {}, c.t - 10 * 60_000);
  assert.equal(pr.take('flatten'), null); assert.equal(pr.view().lastAck.result, 'STALE');
  put(c.dir, 'pause-request-MNQ.json', { minutes: 5 }, c.t - 1000);
  const rq = pr.take('pause'); assert.equal(rq.timeSource, 'mtime'); assert.equal(rq.body.minutes, 5); assert.match(rq.id, /^pause-\d+$/);
});

test('duplicate id: the second request with an id already handled is REJECTED DUPLICATE; a retry of it is accepted', () => {
  const c = { dir: tmpDir(), t: 9_000_000 }; const { pr, rows } = mk(c);
  put(c.dir, 'pause-request-MNQ.json', { id: 'p-1', minutes: 5, requestedAt: c.t - 100 }); assert.ok(pr.take('pause'));
  put(c.dir, 'pause-request-MNQ.json', { id: 'p-1', minutes: 5, requestedAt: c.t - 50 });
  assert.equal(pr.take('pause'), null); assert.equal(pr.view().lastAck.result, 'REJECTED'); assert.match(pr.view().lastAck.reason, /^DUPLICATE/); assert.equal(rows.at(-1).result, 'REJECTED');
  // requeue (retry) keeps the id, refreshes requestedAt and is taken again
  put(c.dir, 'flatten-request-MNQ.json', { id: 'f-9', requestedAt: c.t - 100 }); const rq = pr.take('flatten');
  c.t += 20_000; pr.requeue(rq);
  const again = JSON.parse(fs.readFileSync(path.join(c.dir, 'flatten-request-MNQ.json'), 'utf8'));
  assert.equal(again.id, 'f-9'); assert.equal(again.retry, true); assert.equal(again.requestedAt, c.t); assert.equal(again.firstRequestedAt, c.t - 20_100);
  assert.equal(pr.pendingNew(), false, 'a retry waits for the normal 20 s pass, as before');
  const r2 = pr.take('flatten'); assert.equal(r2.id, 'f-9'); assert.equal(r2.retry, true);
});

test('malformed: a torn / non-object file is rejected MALFORMED once it is 2 s old, left alone while younger', () => {
  const c = { dir: tmpDir(), t: Date.now() }; const { pr, rows } = mk(c);
  const f = put(c.dir, 'flatten-request-MNQ.json', '{"id":"f-x","reque', c.t - 500);
  assert.equal(pr.take('flatten'), null); assert.equal(fs.existsSync(f), true, 'young: maybe mid-write'); assert.equal(pr.view().lastAck, null);
  fs.utimesSync(f, (c.t - 3000) / 1000, (c.t - 3000) / 1000);
  assert.equal(pr.take('flatten'), null); assert.equal(fs.existsSync(f), false);
  assert.equal(pr.view().lastAck.result, 'REJECTED'); assert.match(pr.view().lastAck.reason, /^MALFORMED/); assert.equal(rows.at(-1).result, 'REJECTED');
  put(c.dir, 'pause-request-MNQ.json', '[1,2]', c.t - 5000); assert.equal(pr.take('pause'), null); assert.match(pr.view().lastAck.reason, /^MALFORMED/);
  put(c.dir, 'pause-request-MNQ.json', { id: 'p-f', minutes: 5, requestedAt: c.t + 120_000 }); assert.equal(pr.take('pause'), null); assert.match(pr.view().lastAck.reason, /^FUTURE_TIME/);
});

test('flatten while flat: the ack says APPLIED / ALREADY_FLAT, no order; the other phases name what the existing path did', () => {
  const c = { dir: tmpDir(), t: 7_000_000 }; const { pr } = mk(c);
  put(c.dir, 'flatten-request-MNQ.json', { id: 'f-flat', requestedAt: c.t - 1000 });
  const rq = pr.take('flatten');
  // the executor's hook: phase before = FLAT, the state machine's flattenNow() is a logged no-op
  const sm = { phase: 'FLAT', calls: 0, async flattenNow() { this.calls++; if (this.phase === 'FLAT') return; } };
  return (async () => {
    const ph0 = sm.phase; await sm.flattenNow(); pr.ack(rq, ...flattenResult({ live: true, phaseBefore: ph0, phaseAfter: sm.phase }));
    assert.equal(sm.calls, 1); const a = pr.view().lastAck; assert.equal(a.result, 'APPLIED'); assert.match(a.reason, /^ALREADY_FLAT/);
    assert.deepEqual(flattenResult({ live: false, paperHad: false })[0], 'APPLIED');
    assert.match(flattenResult({ live: true, phaseBefore: 'LEG1_OPEN', phaseAfter: 'FLATTENING' })[1], /market exit sent/);
    assert.match(flattenResult({ live: true, phaseBefore: 'FLATTENING', phaseAfter: 'FLATTENING' })[1], /^ALREADY_FLATTENING/);
    assert.deepEqual(pauseResult('rejected')[0], 'REJECTED'); assert.deepEqual(pauseResult('paused')[0], 'APPLIED');
    assert.equal(cancelResult({ outcome: 'unknown' }), null); assert.equal(cancelResult({ outcome: 'filled', detail: 'd' })[0], 'REJECTED');
  })();
});

test('pendingNew / sleepOrWake: a new request wakes the loop within one 3 s step; nothing pending sleeps the full time', async () => {
  const dir = tmpDir(); const pr = createPhoneRequests({ dir, symbol: 'MNQ' });
  let slept = 0; const fakeSleep = async ms => { slept += ms; await new Promise(r => setImmediate(r)); };
  // virtual clock: Date.now is used by default; use a short real budget
  const t0 = Date.now(); assert.equal(await pr.sleepOrWake(30, async ms => new Promise(r => setTimeout(r, ms)), 10), false); assert.ok(Date.now() - t0 >= 25);
  put(dir, 'pause-request-MNQ.json', { id: 'p-w', minutes: 5, requestedAt: Date.now() });
  slept = 0; assert.equal(await pr.sleepOrWake(60_000, async ms => { slept += ms; }, 3000), true); assert.equal(slept, 3000);
  // a cancel receipt still 'requested' wakes it too; a terminal one does not
  fs.unlinkSync(path.join(dir, 'pause-request-MNQ.json'));
  const cd = path.join(dir, 'entry-cancel-MNQ'); fs.mkdirSync(cd); const id = 'a'.repeat(64);
  fs.writeFileSync(path.join(cd, id + '.json'), JSON.stringify({ outcome: 'cancelled' })); assert.equal(pr.pendingNew(), false);
  fs.writeFileSync(path.join(cd, id + '.json'), JSON.stringify({ outcome: 'requested' })); assert.equal(pr.pendingNew(), true);
  void fakeSleep;
});

test('atomic write under concurrent writers: a reader never sees a torn or empty snapshot', async () => {
  const dir = tmpDir(), file = path.join(dir, 'bias-snapshot-MNQ.json');
  snap.writeAtomic(file, JSON.stringify({ w: -1, i: -1, pad: 'x' }));
  const code = `const { workerData } = require('worker_threads'); const s = require(${JSON.stringify(path.resolve(__dirname, '../lib/phoneSnapshot.js'))});
    const pad = 'y'.repeat(200000); for (let i = 0; i < 150; i++) s.writeAtomic(workerData.file, JSON.stringify({ w: workerData.w, i, pad }));`;
  const workers = [0, 1, 2].map(w => new Worker(code, { eval: true, workerData: { file, w } }));
  const done = Promise.all(workers.map(wk => new Promise((res, rej) => { wk.on('exit', res); wk.on('error', rej); })));
  let reads = 0, bad = 0, finished = false; done.then(() => { finished = true; });
  while (!finished) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof o.w !== 'number') bad++; } catch (e) { bad++; } reads++; await new Promise(r => setImmediate(r)); }
  await done;
  assert.equal(bad, 0, `torn reads: ${bad} of ${reads}`); assert.ok(reads > 20);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'no tmp file left behind');
  const o = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(o.i, 149);
});

test('write(): extras are additive only - an existing key is never replaced; a throwing extras builder still writes the base', () => {
  const dir = tmpDir(), file = path.join(dir, 's.json');
  snap.write(file, { a: 1, news: { count: 0 } }, () => ({ a: 2, news: 'x', build: { stampId: 's' } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, news: { count: 0 }, build: { stampId: 's' } });
  snap.write(file, { a: 3 }, () => { throw new Error('boom'); });
  const o = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(o.a, 3); assert.equal(o.phoneExtrasError, 'boom');
});

test('build stamp: 8-char executor sha and settings hash, startedAt ms', () => {
  snap._reset(); assert.equal(snap.buildView(), null);
  snap.setBuild({ stampId: 'abc123def456', files: { 'live-executor.js': '0123456789abcdef' }, settingsHash: 'fedcba9876543210', overridesHash: '11112222333', startedAt: 1700000000000, runId: 'r1r2r3r4r5', node: 'v18.19.1' });
  assert.deepEqual(snap.buildView(), { stampId: 'abc123def456', executor: '01234567', settingsHash: 'fedcba98', overridesHash: '11112222', startedAt: 1700000000000, runId: 'r1r2r3r4', node: 'v18.19.1' });
});

test('exit reasons from the journal codes each trade already writes', () => {
  snap._reset();
  const J = (jid, t, code, extra = {}) => snap.indexJournal({ type: 'trade_manage', journalId: jid, t, code, text: '', ...extra });
  J('stop', 1, 'STOP_FILLED'); J('stop', 2, 'POSITION_CLOSED');
  J('tp1all', 1, 'TP1_FILLED', { text: 'TP1 filled: all 2 contracts closed' }); J('tp1all', 2, 'POSITION_CLOSED');
  J('tp2', 1, 'TP1_FILLED'); J('tp2', 2, 'TP2_OR_BE', { viaTarget: true }); J('tp2', 3, 'POSITION_CLOSED', { phase: 'LEG23_OPEN' });
  J('run', 1, 'TP1_FILLED'); J('run', 2, 'TP2_OR_BE', { viaTarget: true }); J('run', 3, 'RUNNER_STOPPED');
  J('be', 1, 'TP1_FILLED'); J('be', 2, 'STOP_FILLED');
  J('np', 1, 'NO_PROGRESS_EXIT'); J('np', 2, 'POSITION_CLOSED');
  J('npab', 1, 'NO_PROGRESS_EXIT'); J('npab', 2, 'NO_PROGRESS_ABANDONED'); J('npab', 3, 'STOP_FILLED');
  J('sess', 1, 'TP1_FILLED'); J('sess', 2, 'SESSION_FLATTEN', { reason: '13:05 PT session close' });
  J('morn', 1, 'MORNING_FLATTEN'); J('morn', 2, 'SESSION_FLATTEN', { reason: 'morning hold 05:25-05:35 PT' });
  J('morn2', 2, 'SESSION_FLATTEN', { reason: 'morning hold 06:00 PT' });
  J('ll', 1, 'LEVEL_LOSS_EXIT');
  J('man', 1, 'MANUAL_FLATTEN');
  J('ts', 1, 'TIME_STOP');
  J('stop', 2, 'POSITION_CLOSED');   // a duplicate row (file seed + live feed) counts once
  const R = id => snap.exitReasonOf(id).exitReason;
  assert.equal(R('stop'), 'STOP'); assert.equal(R('tp1all'), 'TP1'); assert.equal(R('tp2'), 'TP2'); assert.equal(R('run'), 'RUNNER_STOP'); assert.equal(R('be'), 'RUNNER_STOP');
  assert.equal(R('np'), 'NO_PROGRESS'); assert.equal(R('npab'), 'STOP'); assert.equal(R('sess'), 'SESSION_CLOSE'); assert.equal(R('morn'), 'MORNING_HOLD'); assert.equal(R('morn2'), 'MORNING_HOLD');
  assert.equal(R('ll'), 'LEVEL_LOSS'); assert.equal(R('man'), 'MANUAL_FLATTEN'); assert.equal(R('nothing'), 'UNKNOWN');
  assert.deepEqual(snap.exitReasonOf('ts'), { exitReason: 'UNKNOWN', exitCode: 'TIME_STOP' });
  assert.equal(snap.exitReasonOf(null, { manualFlatten: true }).exitReason, 'MANUAL_FLATTEN');
});

test('broker view, balance read time and news gate state from existing reads only', () => {
  reads._reset();
  assert.equal(snap.brokerView({ live: true, accountId: 7, contractId: 'C', reads, sm: null }).readAt, null, 'no read yet = no time');
  reads.noteAccounts([{ id: 7, balance: 50000 }], 1000); reads.noteAccounts([{ id: 7, balance: 50120 }], 2000); reads.noteAccounts([{ id: 7, balance: 50000 }], 3000);
  assert.equal(reads.balanceReadAt(7, 50000), 3000); assert.equal(reads.balanceReadAt(7, 50120), 2000); assert.equal(reads.balanceReadAt(7, 1), null);
  reads.notePositions(7, [{ contractId: 'C', type: 2, size: 3, averagePrice: 21000.25 }, { contractId: 'X', type: 1, size: 1 }], 5000);
  reads.noteOrders(7, [{ id: 91, contractId: 'C', type: 4, side: 0, size: 3, stopPrice: 21020 }, { id: 92, contractId: 'C', type: 1, side: 0, size: 1, limitPrice: 20980 }, { id: 93, contractId: 'X', type: 1 }], 4000);
  const sm = { phase: 'LEG1_OPEN', stopOrderId: 91, targetOrderId: 92 };
  const b = snap.brokerView({ live: true, accountId: 7, contractId: 'C', reads, sm });
  assert.deepEqual(b.position, { side: 'SHORT', qty: 3, avgPrice: 21000.25, openedAt: null }); assert.equal(b.readAt, 4000); assert.equal(b.positionReadAt, 5000);
  assert.deepEqual(b.workingOrders.map(o => [o.id, o.type, o.side, o.qty, o.price, o.kind]), [[91, 'STOP', 'BUY', 3, 21020, 'stop'], [92, 'LIMIT', 'BUY', 1, 20980, 'tp1']]);
  reads.notePositions(7, [], 6000); assert.deepEqual(snap.brokerView({ live: true, accountId: 7, contractId: 'C', reads }).position, { side: 'FLAT', qty: 0, avgPrice: null, openedAt: null });
  assert.equal(snap.brokerView({ live: false }).source, 'paper');
  const g = snap.newsGateView({ count: 12, wait: { until: 99 }, resting: false, upcoming: [{ t: 1, title: 'CPI', impact: 'high' }, { t: 2, title: 'a', impact: 'medium' }, { t: 3, title: 'b' }, { t: 4, title: 'c' }], refreshedAt: 5 }, true);
  assert.equal(g.loaded, true); assert.equal(g.blocking, true); assert.equal(g.blockingWhat, 'entries'); assert.equal(g.until, 99); assert.equal(g.eventsNext.length, 3); assert.equal(g.failOpen, false);
  const g2 = snap.newsGateView({ count: 0, wait: null, resting: false, upcoming: [] }, true); assert.equal(g2.loaded, false); assert.equal(g2.blocking, false); assert.equal(g2.failOpen, true);
});
