'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const terminal = new Set(['cancelled', 'resolved', 'filled', 'stale']);
// r1.1: a cancel request the executor has not picked up within MAX_AGE_MS (60 s, the same limit as flatten / pause in lib/phoneRequests.js) is never acted on:
// it is closed as 'stale' (journaled and acked STALE) so an old tap can never cancel an entry later, e.g. after a restart. A request already picked up in
// time ('pending' / 'unknown', tracking retained) is unchanged. A new tap for the same entry after a stale one queues a fresh request.
const MAX_AGE_MS = 60000;
function validTarget(t) {
  return t && Number.isSafeInteger(t.accountId) && t.accountId > 0 && typeof t.contractId === 'string' && t.contractId.length < 100 &&
    /^[A-Za-z0-9-]{1,80}$/.test(String(t.orderId)) && /^[a-f0-9-]{36}$/.test(t.entryIdentity);
}
function requestId(symbol, target) {
  return crypto.createHash('sha256').update(JSON.stringify([symbol,target.accountId,target.contractId,String(target.orderId),target.entryIdentity])).digest('hex');
}
function store(dir, symbol, { maxAgeMs = MAX_AGE_MS, now = () => Date.now() } = {}) {
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Invalid symbol');
  const folder = path.join(dir, `entry-cancel-${symbol}`);
  function file(id) { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid request ID'); return path.join(folder, id + '.json'); }
  function read(id) { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
  function write(r) { const dest = file(r.requestId), tmp = dest + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, dest); }
  function enqueue(target, validate) {
    if (!validTarget(target)) throw new Error('Missing exact entry identity; refresh the terminal');
    const id = requestId(symbol, target);
    let old = null;
    try { old = read(id); if (old.outcome !== 'stale') return old; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (validate) validate(target);
    fs.mkdirSync(folder, { recursive: true });
    const r = { requestId: id, symbol, target, outcome: 'requested', detail: 'Queued; executor has not acknowledged', requestedAt: now(), updatedAt: now(), revision: old ? (old.revision || 0) + 1 : 0 };
    if (old) { write(r); return r; }   // r1.1: a fresh tap after a stale request
    try { fs.writeFileSync(file(id), JSON.stringify(r), { flag: 'wx' }); return r; }
    catch (e) { if (e.code === 'EEXIST') return read(id); throw e; }
  }
  const busy = new Set();
  async function process(machine, report) {
    let names;
    try { names = fs.readdirSync(folder); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const id = name.slice(0,-5);
      if (busy.has(id)) continue;
      busy.add(id);
      try {
        let r = read(id);
        if (terminal.has(r.outcome)) continue;
        if (r.symbol !== symbol || !validTarget(r.target) || requestId(symbol,r.target) !== id) throw new Error('Invalid request target');
        if (r.outcome === 'requested') {   // r1.1: never picked up within 60 s -> STALE, not acted on (no broker call)
          const age = Number.isFinite(r.requestedAt) ? now() - r.requestedAt : Infinity;
          if (!(age <= maxAgeMs)) {
            r = { ...r, outcome: 'stale', detail: Number.isFinite(age) ? `STALE: written ${Math.round(age / 1000)} s ago (limit ${Math.round(maxAgeMs / 1000)} s); not acted on` : 'STALE: no request time; not acted on', updatedAt: now(), revision: (r.revision || 0) + 1 };
            write(r);
            if (report) report(r);
            continue;
          }
        }
        // Persist consumption BEFORE any broker await. A crash leaves pending, not success.
        r = { ...r, outcome: 'pending', detail: 'Executor checking exact entry', updatedAt: Date.now(), revision: r.revision + 1 };
        write(r);
        let result;
        try { result = machine ? await machine.cancelEntryRequest(r.target) : { outcome: 'unknown', detail: 'No live entry manager; no action taken' }; }
        catch (e) { result = { outcome: 'unknown', detail: 'Cancellation check interrupted; tracking retained' }; }
        r = { ...r, ...result, updatedAt: Date.now(), revision: r.revision + 1 };
        write(r);
        if (report) report(r);
      } finally { busy.delete(id); }
    }
  }
  return { enqueue, read, process };
}
module.exports = { store, validTarget, requestId, MAX_AGE_MS };
