'use strict';
// edge r1.3 (the start-up out-of-memory fix): read a JSON-lines file WITHOUT ever holding it as one string.
// Before, the executor did fs.readFileSync(journal, 'utf8').split('\n') in six places: a 98.7 MB journal became a 188 MB string five times at start-up, and
// two readers also kept every parsed row (113 MB each), which killed the bot at the server's 493 MB heap limit.
//
// forEachLineSync(file, onLine, { start, bufSize }): synchronous, one fixed buffer (default 1 MB), one line decoded at a time.
//   - The lines are exactly those of readFileSync(file, 'utf8').split('\n'): split on the newline BYTE (0x0A never occurs inside a multi-byte UTF-8 character),
//     each line decoded on its own from its complete bytes, so a character split across two buffer reads is decoded correctly. A '\r' before the newline stays
//     in the line, as before (JSON.parse accepts it as trailing white space).
//   - onLine(line) is called for every line that ENDS with a newline. The text after the last newline (a file with no trailing newline, or a row being
//     written right now) is returned as `tail` and is NOT passed to onLine. '' when the file ends with a newline.
//   - Returns { end, tail, size }: end = the byte offset just after the last newline consumed (a later call with start: end continues from there).
//   - Throws what fs throws (ENOENT for a missing file).
//
// createJournalScan({ file, collectors }): the shared start-up pass. collectors = { name: line => item | undefined }; an item that is not undefined is kept, in
// file order. advance(consumer) reads only the bytes added since the last call (the journal is append-only), feeds every NEW complete line to each collector
// and to the optional consumer, and returns { exists, tail }. get(name) = advance() + the kept items, plus the item of the unterminated last line when it
// yields one: the same rows a fresh readFileSync + split would give at that moment. A reader that runs later therefore sees the rows written in between.
// release() drops everything kept; a later get() scans again from the start. A file that shrank is scanned again from the start.
const fs = require('fs');
const NL = 0x0a;

function forEachLineSync(file, onLine, { start = 0, bufSize = 1 << 20, fsImpl = fs } = {}) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const size = fsImpl.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(Math.max(16, bufSize));
    let pos = start, end = start, carry = null;   // carry: the bytes of a line that began in an earlier read (kept as bytes, never decoded in pieces)
    for (;;) {
      const n = fsImpl.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      let from = 0;
      for (;;) {
        const i = buf.indexOf(NL, from);
        if (i < 0 || i >= n) break;
        let line;
        if (carry) { line = Buffer.concat([carry, buf.subarray(from, i)]).toString('utf8'); carry = null; }
        else line = buf.toString('utf8', from, i);
        from = i + 1; end = pos + from;
        onLine(line);
      }
      if (from < n) { const rest = Buffer.from(buf.subarray(from, n)); carry = carry ? Buffer.concat([carry, rest]) : rest; }
      pos += n;
    }
    return { end, tail: carry ? carry.toString('utf8') : '', size };
  } finally { try { fsImpl.closeSync(fd); } catch (e) { /* nothing to do */ } }
}

// edge r1.4: the ASYNC twin, for tmc-proxy.js. The proxy also carries the bot's own broker calls, so it must not block for a whole pass: this reader awaits
// each 1 MB read (the event loop runs between chunks), where the sync reader above holds the thread until the end of the file.
// forEachLine(file, onLine, { start, end, bufSize }) -> Promise<{ end, tail, size, limit }>. The same lines as forEachLineSync. `end` (a byte offset) bounds the
// read: without it the file's size at open is used, so rows appended while the read runs are not seen (a second pass given the first pass's `limit` reads
// exactly the same bytes). Rejects with what fs gives (ENOENT for a missing file), or with what onLine throws.
async function forEachLine(file, onLine, { start = 0, end = null, bufSize = 1 << 20, fsImpl = fs } = {}) {
  const fh = await fsImpl.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size, limit = end == null ? size : Math.min(end, size);
    const buf = Buffer.allocUnsafe(Math.max(16, bufSize));
    let pos = start, done = start, carry = null;
    while (pos < limit) {
      const { bytesRead: n } = await fh.read(buf, 0, Math.min(buf.length, limit - pos), pos);
      if (n <= 0) break;
      let from = 0;
      for (;;) {
        const i = buf.indexOf(NL, from);
        if (i < 0 || i >= n) break;
        let line;
        if (carry) { line = Buffer.concat([carry, buf.subarray(from, i)]).toString('utf8'); carry = null; }
        else line = buf.toString('utf8', from, i);
        from = i + 1; done = pos + from;
        onLine(line);
      }
      if (from < n) { const rest = Buffer.from(buf.subarray(from, n)); carry = carry ? Buffer.concat([carry, rest]) : rest; }
      pos += n;
    }
    return { end: done, tail: carry ? carry.toString('utf8') : '', size, limit };
  } finally { try { await fh.close(); } catch (e) { /* nothing to do */ } }
}
// Every line of readFile(file, 'utf8').split('\n') that is not empty, in order (the unterminated last line included). Resolves { limit }.
async function forEachNonEmptyLine(file, onLine, opts) {
  const r = await forEachLine(file, line => { if (line) onLine(line); }, opts);
  if (r.tail) onLine(r.tail);
  return r;
}

function createJournalScan({ file, collectors = {}, bufSize, fsImpl = fs } = {}) {
  const names = Object.keys(collectors);
  let offset = 0, kept = Object.fromEntries(names.map(n => [n, []])), lastTail = '';
  const stats = { passes: 0, lines: 0, bytes: 0 };
  function reset() { offset = 0; kept = Object.fromEntries(names.map(n => [n, []])); lastTail = ''; }
  // Reads what was appended since the last call. consumer(line) sees each new complete line and then the unterminated tail (when not empty), once.
  function advance(consumer = null) {
    let size;
    try { size = fsImpl.statSync(file).size; } catch (e) { if (e && e.code === 'ENOENT') { reset(); return { exists: false, tail: '' }; } reset(); throw e; }
    if (size < offset) reset();   // the file was replaced by a shorter one: nothing kept is trusted
    let r;
    try {
      r = forEachLineSync(file, line => {
        stats.lines++;
        for (const n of names) { const item = collectors[n](line); if (item !== undefined) kept[n].push(item); }
        if (consumer) consumer(line);
      }, { start: offset, bufSize, fsImpl });
    } catch (e) { reset(); if (e && e.code === 'ENOENT') return { exists: false, tail: '' }; throw e; }
    stats.passes++; stats.bytes += r.end - offset;
    offset = r.end; lastTail = r.tail;
    if (consumer && r.tail) consumer(r.tail);
    return { exists: true, tail: r.tail };
  }
  // The kept items of one collector as of now (null = no file). A copy; the unterminated last line counts for this call only.
  function get(name) {
    if (!Object.prototype.hasOwnProperty.call(collectors, name)) throw new Error('journalScan: unknown collector ' + name);
    const a = advance();
    if (!a.exists) return null;
    const out = kept[name].slice();
    if (a.tail) { const item = collectors[name](a.tail); if (item !== undefined) out.push(item); }
    return out;
  }
  function release() { reset(); }
  return { advance, get, release, stats, _offset: () => offset, _tail: () => lastTail };
}

// The three collectors of the executor's start-up readers. Each keeps exactly the rows its reader used when it read the whole file:
//   plan      = the plan restore's own line filter and row test, unchanged (evidenceOf = lib/journalMeta.js evidenceOf);
//   reconcile = the only rows the three reconcile readers use (orphaned pending rows, open-without-close trades, the broker backfill): `entry`,
//               `peak_unrealized`, and signal_check rows that carry a journalId. A line is parsed only when it contains "journalId" or is one of the two types;
//   tp1       = the LINES lib/liveStateMachine.js journalShowsTp1 can use: not a signal_check line, and an `entry` row or a TP1_FILLED / TP1_PARTIAL row.
// No window is tightened: every collector covers the whole file.
const TYPE_RE = /"type"\s*:\s*"(entry|peak_unrealized)"/, PLAN_RE = /"(trade_plan|plan_terminal|entry|ENTRY_FILLED|ENTRY_EXPIRED|canceled|PLAN_CANCELED|PLAN_RESET|FILL_OBSERVED)"/, TP1_RE = /"type"\s*:\s*"entry"|"TP1_FILLED"|"TP1_PARTIAL"/;
function startupCollectors({ evidenceOf }) {
  return {
    plan: line => { if (!(line.includes('"journalId"') && PLAN_RE.test(line))) return undefined; try { const r = JSON.parse(line); return r.type === 'trade_plan' || r.type === 'plan_terminal' || evidenceOf(r) ? r : undefined; } catch (_) { return undefined; } },
    reconcile: line => { if (!(line.includes('"journalId"') || TYPE_RE.test(line))) return undefined; let e; try { e = JSON.parse(line); } catch (_) { return undefined; }
      return e && (e.type === 'entry' || e.type === 'peak_unrealized' || (e.type === 'signal_check' && e.journalId)) ? e : undefined; },
    tp1: line => (line && line.indexOf('"signal_check"') < 0 && TP1_RE.test(line) ? line : undefined),
  };
}

module.exports = { forEachLineSync, forEachLine, forEachNonEmptyLine, createJournalScan, startupCollectors };
