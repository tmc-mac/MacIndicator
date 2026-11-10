'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const terminal = new Set(['cancelled', 'resolved', 'filled']);
function validTarget(t) {
  return t && Number.isSafeInteger(t.accountId) && t.accountId > 0 && typeof t.contractId === 'string' && t.contractId.length < 100 &&
    /^[A-Za-z0-9-]{1,80}$/.test(String(t.orderId)) && /^[a-f0-9-]{36}$/.test(t.entryIdentity);
}
function requestId(symbol, target) {
  return crypto.createHash('sha256').update(JSON.stringify([symbol,target.accountId,target.contractId,String(target.orderId),target.entryIdentity])).digest('hex');
}
function store(dir, symbol) {
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Invalid symbol');
  const folder = path.join(dir, `entry-cancel-${symbol}`);
  function file(id) { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid request ID'); return path.join(folder, id + '.json'); }
  function read(id) { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
  function write(r) { const dest = file(r.requestId), tmp = dest + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, dest); }
  function enqueue(target, validate) {
    if (!validTarget(target)) throw new Error('Missing exact entry identity; refresh the terminal');
    const id = requestId(symbol, target);
    try { return read(id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (validate) validate(target);
    fs.mkdirSync(folder, { recursive: true });
    const r = { requestId: id, symbol, target, outcome: 'requested', detail: 'Queued; executor has not acknowledged', requestedAt: Date.now(), updatedAt: Date.now(), revision: 0 };
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
module.exports = { store, validTarget, requestId };
