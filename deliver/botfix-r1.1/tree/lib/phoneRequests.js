'use strict';
// botfix-B: the phone request protocol (flatten / pause files written by tmc-proxy.js), shared by the executor's poll loop and its 3 s fast-poll sleep.
//   - A request file is { id, requestedAt (epoch ms), ...payload }. Older proxies wrote no id: the id is then "<type>-<requestedAt>"; no requestedAt: the
//     file's own mtime is used (labelled timeSource 'mtime').
//   - take() consumes the file (deleted BEFORE any action, as before) and returns the request, or null when there is nothing to act on:
//       not valid JSON / not an object -> REJECTED MALFORMED (a file younger than 2 s is left for the next poll: it may still be mid-write by an old proxy);
//       requestedAt older than maxAgeMs (60 s)  -> STALE (never acted on, journal row + ack): an old flatten can never fire later, e.g. after a restart;
//       requestedAt more than 60 s in the future -> REJECTED FUTURE_TIME;
//       an id already handled (not a retry)     -> REJECTED DUPLICATE.
//   - ack() records the result the phone reads in snapshot.requests: lastAck { id, type, requestedAt, receivedAt, at, result, reason }, the last 10 acks and
//     appliedAt { flatten, pause, cancel } (epoch ms the bot last APPLIED each kind). Results: APPLIED / REJECTED / STALE (final), PENDING (kept and retried).
//   - pendingNew() tells the fast poll a NEW request is waiting (a retry file is left to the normal 20 s pass, as before), so it wakes the main loop at once.
// Never decides how to flatten or pause: the executor calls its existing paths and reports the outcome here.
const fs = require('fs'), path = require('path');
const MAX_AGE_MS = 60000, FUTURE_MS = 60000, YOUNG_MS = 2000, ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function createPhoneRequests({ dir, symbol, maxAgeMs = MAX_AGE_MS, now = () => Date.now(), journal = null, log = null } = {}) {
  if (!dir || !/^[A-Z0-9]{1,10}$/.test(String(symbol))) throw new Error('phoneRequests: dir and symbol are required');
  const files = { flatten: path.join(dir, `flatten-request-${symbol}.json`), pause: path.join(dir, `pause-request-${symbol}.json`) };
  const cancelDir = path.join(dir, `entry-cancel-${symbol}`);
  const seen = new Set(), acks = [], appliedAt = { flatten: null, pause: null, cancel: null };
  let lastAck = null;
  const remember = id => { seen.add(id); if (seen.size > 200) seen.delete(seen.values().next().value); };

  function ack(rq, result, reason = null, extra = {}) {
    const a = { id: rq && rq.id != null ? String(rq.id) : null, type: rq && rq.type || null, requestedAt: rq && Number.isFinite(rq.requestedAt) ? rq.requestedAt : null,
      receivedAt: rq && Number.isFinite(rq.receivedAt) ? rq.receivedAt : now(), at: now(), result, reason: reason == null ? null : String(reason).slice(0, 300), ...extra };
    lastAck = a; acks.unshift(a); if (acks.length > 10) acks.length = 10;
    if (result === 'APPLIED' && a.type && Object.prototype.hasOwnProperty.call(appliedAt, a.type)) appliedAt[a.type] = a.at;
    if (result !== 'APPLIED' && result !== 'PENDING' && journal) { try { journal({ type: 'phone_request', t: a.at, id: a.id, request: a.type, result, reason: a.reason, requestedAt: a.requestedAt, ageMs: a.requestedAt != null ? a.receivedAt - a.requestedAt : null }); } catch (e) { /* journal only */ } }
    if (log && result !== 'APPLIED') { try { log(`  [phone] ${a.type || 'request'} ${a.id || ''} ${result}${a.reason ? ': ' + a.reason : ''}`); } catch (e) { /* log only */ } }
    return a;
  }

  function take(type) {
    const f = files[type]; if (!f) throw new Error('phoneRequests: unknown type ' + type);
    let raw, st;
    try { st = fs.statSync(f); raw = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }   // nothing there (or vanished between the two calls)
    const t = now();
    let req = null; try { req = JSON.parse(raw); } catch (e) { req = null; }
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      if (t - st.mtimeMs < YOUNG_MS) return null;   // possibly mid-write (a proxy that does not rename): read it again next poll
      try { fs.unlinkSync(f); } catch (e) { /* best effort */ }
      ack({ id: null, type, requestedAt: st.mtimeMs, receivedAt: t }, 'REJECTED', 'MALFORMED: the request file is not a JSON object');
      return null;
    }
    const timeSource = Number.isFinite(req.requestedAt) ? 'request' : 'mtime';
    const requestedAt = timeSource === 'request' ? req.requestedAt : st.mtimeMs;
    const id = typeof req.id === 'string' && ID_RE.test(req.id) ? req.id : `${type}-${Math.round(requestedAt)}`;
    try { fs.unlinkSync(f); } catch (e) { /* best effort: a second read is caught as a DUPLICATE */ }
    const rq = { id, type, requestedAt, receivedAt: t, ageMs: t - requestedAt, timeSource, retry: req.retry === true, firstRequestedAt: Number.isFinite(req.firstRequestedAt) ? req.firstRequestedAt : requestedAt, body: req };
    if (rq.ageMs > maxAgeMs) { ack(rq, 'STALE', `STALE: written ${Math.round(rq.ageMs / 1000)} s ago (limit ${Math.round(maxAgeMs / 1000)} s); not acted on`); return null; }
    if (-rq.ageMs > FUTURE_MS) { ack(rq, 'REJECTED', `FUTURE_TIME: requestedAt is ${Math.round(-rq.ageMs / 1000)} s ahead of the bot clock`); return null; }
    if (!rq.retry && seen.has(id)) { ack(rq, 'REJECTED', 'DUPLICATE: this request id was already handled'); return null; }
    remember(id);
    return rq;
  }

  // Keep a request the bot could not finish (e.g. the broker position was unreadable) for the next pass: same id, retry true, a fresh requestedAt.
  function requeue(rq) {
    const f = files[rq.type], tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...rq.body, id: rq.id, requestedAt: now(), firstRequestedAt: rq.firstRequestedAt, retry: true })); fs.renameSync(tmp, f);
  }

  function pendingNew() {
    for (const f of Object.values(files)) {
      let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
      try { const r = JSON.parse(raw); if (r && r.retry === true) continue; } catch (e) { /* malformed or mid-write: the main loop decides */ }
      return true;
    }
    let names; try { names = fs.readdirSync(cancelDir); } catch (e) { return false; }
    for (const n of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(n)) continue;
      try { if (JSON.parse(fs.readFileSync(path.join(cancelDir, n), 'utf8')).outcome === 'requested') return true; } catch (e) { /* torn: next poll */ }
    }
    return false;
  }

  // Sleep up to ms in steps of stepMs, returning early (true) when a new phone request is waiting. sleepFn = the executor's own sleep.
  async function sleepOrWake(ms, sleepFn, stepMs = 3000) {
    const end = now() + ms;
    while (now() < end) {
      await sleepFn(Math.min(stepMs, Math.max(0, end - now())));
      if (now() < end && pendingNew()) return true;
    }
    return false;
  }

  function setJournal(fn) { journal = typeof fn === 'function' ? fn : null; }
  function view() { return { lastAck, recent: acks.slice(), appliedAt: { ...appliedAt }, maxAgeMs, pollMs: 3000 }; }
  return { take, ack, requeue, pendingNew, sleepOrWake, view, setJournal, files };
}

// The ack for a flatten request from the phase before and after the bot's existing flatten path ran. LIVE phases are the state machine's.
// r1.1: `result` = flattenNow()'s return (the safe-exit sessionFlatten result): 'desynced' = the bot is halted and sent nothing; 'retry' = the exit is under way
// but no market order went out this poll (a protective order still resting, a rejected send in its backoff, or a lost reply that settled "still open"); the
// executor keeps driving it every poll until flat or halt. Without `result` (older callers) the texts are as before.
function flattenResult({ live, phaseBefore, phaseAfter, paperHad, result } = {}) {
  if (!live) return paperHad ? ['APPLIED', 'paper: the simulated position / resting order was cleared'] : ['APPLIED', 'ALREADY_FLAT: nothing to close (paper)'];
  if (phaseBefore === 'FLAT') return ['APPLIED', 'ALREADY_FLAT: the bot was flat; no order sent'];
  if (phaseBefore === 'FLATTENING') return ['APPLIED', 'ALREADY_FLATTENING: an exit was already under way'];
  if (phaseBefore === 'PENDING_ENTRY') return ['APPLIED', `resting entry: verified cancel requested (phase now ${phaseAfter})`];
  if (result === 'desynced') return ['REJECTED', `HALTED: the bot is halted by its exit-safety rule and sends no order - flatten in TopstepX (phase ${phaseAfter})`];
  if (result === 'retry') return ['APPLIED', `exit under way on the safe-exit rule: no market order this poll (protection still resting, a retry backoff or a settle); retried every poll until flat or halt (phase now ${phaseAfter})`];
  return ['APPLIED', `market exit sent through the bot's flatten path (phase now ${phaseAfter})`];
}
// The ack for a pause request from handlePauseRequest()'s return value.
function pauseResult(r) {
  if (r === 'paused') return ['APPLIED', 'paused: no new entries'];
  if (r === 'resumed') return ['APPLIED', 'resumed: new entries allowed'];
  if (r === 'not-paused') return ['APPLIED', 'NOT_PAUSED: resume asked while not paused'];
  return ['REJECTED', 'INVALID_MINUTES: allowed 5, 10, 15, 30 or 0'];
}
// The ack for an entry-cancel receipt (lib/entryCancelRequests.js outcome); null = not final yet (no ack).
function cancelResult(r) {
  if (!r) return null;
  if (r.outcome === 'cancelled') return ['APPLIED', 'cancelled: ' + (r.detail || '')];
  if (r.outcome === 'resolved') return ['APPLIED', 'resolved: ' + (r.detail || '')];
  if (r.outcome === 'filled') return ['REJECTED', 'FILLED_FIRST: ' + (r.detail || '')];
  if (r.outcome === 'stale') return ['STALE', r.detail || 'STALE: not acted on'];   // r1.1: aged out like flatten / pause
  return null;
}

module.exports = { createPhoneRequests, flattenResult, pauseResult, cancelResult, MAX_AGE_MS };
