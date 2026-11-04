#!/usr/bin/env node
'use strict';
// r1.5.2 (MacLive): the executor's fetch wrapper, run from the executor's OWN source text in a sandbox with a fake fetch, plus a REAL local socket reset.
// usage: node tests/net-retry.test.cjs   (from the bot folder)
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'live-executor.js'), 'utf8');
const i = SRC.indexOf('{ const f0 = globalThis.fetch, DSYM'), j = SRC.indexOf("const tideWire = require('./lib/tideWire');");
let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 700) : '')); } }
const BLOCK = SRC.slice(i, j);
const reset = () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); return e; };
const stale = () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }); return e; };
function sandbox(fake) { const logs = [], ctx = { globalThis: null, console: { log: m => logs.push(String(m)) }, URL, Date, setTimeout, Symbol }; ctx.globalThis = ctx; ctx.fetch = fake; vm.createContext(ctx); vm.runInContext(BLOCK, ctx); return { f: ctx.fetch, logs }; }
(async () => {
  ok(i > 0 && j > i && BLOCK.includes('fx.__r152 = true'), 'N0 the wrapper block is in the executor, before the TIDE requires');
  { let n = 0; const { f, logs } = sandbox(async () => { n++; if (n === 1) throw reset(); return { ok: true, n }; });
    const r = await f('http://localhost:8787/api/Position/searchOpen', { method: 'POST', body: '{}' });
    ok(r.ok && n === 2 && /\[net\] POST localhost:8787\/api\/Position\/searchOpen: ECONNRESET - retry 1 \(at once, fresh connection\): OK/.test(logs.join('\n')), 'N1 a broker READ hit by a reset is sent once more (and logged)', { n, logs }); }
  { let n = 0; const { f } = sandbox(async () => { n++; throw reset(); });
    let err = null; try { await f('http://localhost:8787/api/Order/place', { method: 'POST', body: '{}' }); } catch (e) { err = e; }
    ok(err && n === 1 && /^fetch failed \[POST localhost:8787\/api\/Order\/place: ECONNRESET read ECONNRESET\]$/.test(err.message) && /^TypeError: fetch failed \[POST localhost:8787/.test(err.stack),
      'N2 an ORDER is never re-sent; the error (and its stack line, which the loop logs) names METHOD host/path and the cause', { n, msg: err && err.message }); }
  { let n = 0; const { f } = sandbox(async () => { n++; throw reset(); });
    let err = null; try { await f('http://localhost:8787/api/History/retrieveBars', { method: 'POST' }); } catch (e) { err = e; }
    ok(err && n === 5 && /\[POST localhost:8787\/api\/History\/retrieveBars: ECONNRESET/.test(err.message), 'N3 a read that keeps failing: retried at once, then after 400 / 1200 / 2500 ms (5 calls), then the tagged error', { n, msg: err && err.message }); }
  { let n = 0; const { f } = sandbox(async () => { n++; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; });
    let err = null; try { await f('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'); } catch (e) { err = e; }
    ok(err && n === 1 && /\[GET cdn\.cboe\.com\/api\/global\/us_indices\/daily_prices\/VIX_History\.csv\]$/.test(err.message), 'N4 a non-broker feed (VIX CDN) is not retried; its error names the host', err && err.message); }
  { // a REAL server that resets a kept-alive socket right after its answer: the next call on that socket fails exactly as Mac's log ("fetch failed", ECONNRESET);
    // through the wrapper the read succeeds (fresh connection)
    // the server answers the FIRST request on a connection and RESETS the connection when a second request arrives on it (a dropped keep-alive)
    const seen = new WeakSet(); const srv = http.createServer((q, r) => { const sk = q.socket; if (seen.has(sk)) { sk.resetAndDestroy ? sk.resetAndDestroy() : sk.destroy(); return; } seen.add(sk); q.resume(); q.on('end', () => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}'); }); });
    await new Promise(r => srv.listen(0, r)); const port = srv.address().port, url = `http://localhost:${port}/api/Order/searchOpen`, sleep = ms => new Promise(r => setTimeout(r, ms));
    const real = globalThis.fetch; let rawFail = 0, rawCause = null, wrapFail = 0, retried = 0;
    for (let t = 0; t < 40; t++) { await real(url, { method: 'POST', body: '{}' }).then(r => r.json()); await sleep(5); try { await real(url, { method: 'POST', body: '{}' }).then(r => r.json()); } catch (e) { rawFail++; rawCause = e.cause && e.cause.code; } }
    const { f, logs } = sandbox(real);
    for (let t = 0; t < 40; t++) { await f(url, { method: 'POST', body: '{}' }).then(r => r.json()); await sleep(5); try { await f(url, { method: 'POST', body: '{}' }).then(r => r.json()); } catch (e) { wrapFail++; } }
    retried = logs.filter(l => /retry \d \(at once, fresh connection\): OK/.test(l)).length; srv.close();
    ok(rawFail > 0 && rawCause === 'ECONNRESET' && wrapFail === 0 && retried > 0, 'N5 real sockets: a reset kept-alive socket fails the next plain fetch ("fetch failed", ECONNRESET); through the wrapper no read fails (retried on a fresh connection)', { rawFail, rawCause, wrapFail, retried }); }
  { let n = 0; const { f, logs } = sandbox(async () => { n++; if (n === 1) throw stale(); return { ok: true }; });
    const r = await f('http://localhost:8787/api/Order/searchOpen', { method: 'POST', body: '{}' });
    ok(r.ok && n === 2 && /UND_ERR_SOCKET - retry 1 \(at once, fresh connection\): OK/.test(logs.join('\n')), 'N6 UND_ERR_SOCKET ("other side closed", Mac\'s 14:24 log) on the open-orders read: retried at once, OK', { n, logs }); }
  { let n = 0; const { f } = sandbox(async () => { n++; throw stale(); }); let err = null;
    try { await f('http://localhost:8787/api/Order/cancel', { method: 'POST', body: '{}' }); } catch (e) { err = e; }
    ok(err && n === 1 && /UND_ERR_SOCKET other side closed\]$/.test(err.message), 'N7 an order cancel on a stale socket is NOT re-sent (one call; the caller reads the orders)', { n, msg: err && err.message }); }
  { // N8 the real process: the block installed over the real fetch; after the first fetch the global dispatcher is a NEW Agent (keepAlive 2 s / 5 s)
    const S = Symbol.for('undici.globalDispatcher.1'), srv = http.createServer((q, r) => r.end('{"ok":true}')); await new Promise(r => srv.listen(0, r));
    const before = globalThis[S]; const logs = []; const keep = console.log; console.log = m => logs.push(String(m)); try { new Function(BLOCK)(); await (await globalThis.fetch(`http://localhost:${srv.address().port}/x`)).json(); } finally { console.log = keep; }
    const after = globalThis[S]; srv.close();
    ok(globalThis.fetch.__r152 === true && after && after !== before && after.constructor.name === 'Agent' && logs.some(l => /idle sockets dropped after 2 s/.test(l)), 'N8 Node 22: the global dispatcher is replaced by a fresh Agent (keepAliveTimeout 2 s, keepAliveMaxTimeout 5 s), no npm', logs); }
  console.log(`net-retry: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e.stack); process.exit(2); });
