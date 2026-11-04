'use strict';
// tideRebuild (MacStructure): rebuild the TIDE bias book after a MID-SESSION start, so the engine's warm-up sees the bias history it would have had live
// (otherwise every setup armed before the start is lost: the engine fails closed without bias). Pure: no I/O, no clock reads except timing; no executor edits.
//
// For every completed 1m minute T in (now - hours, now]: the bot's own Levels PRO (r13.3.7 lib/levelsPro.js evaluateLevelsPro, passed in) on the FORMING
// 15m and 30m chart built ONLY from bars that closed by T, exactly as structure/tools/build-bias-fixture.cjs (the r3.2 ledger fixtures) does it:
//   htf[k] = provider bars of k with T - 400 x tf <= t, the closed ones (t + tf <= T) plus the forming one rebuilt from the 1m bars in [t, T);
//   htf.W = weekly bars with t < T (levelsPro reads only the current week's OPEN and the previous completed week);
//   score = evaluateLevelsPro(htf[k].slice(-2000), htf, { sessionAnchor: 'cme', vwapBuild: '5m', vwapBars: htf.M5 }).at(-1).biasScore.
// If the provider array has no bar for the forming bucket (live arrays hold closed bars), it is synthesized from the 1m bars on the provider's grid.
// Each reading is stamped in r3.2's strict shape { m15: {score, valid: true, observedAt: T}, m30: {...} } (observedAt in unix seconds, as the wire's biasAt).
//
// Event loop: the work is cut into slices of `yieldEvery` levelsPro evaluations with setImmediate between them. One evaluation costs ~25-60 ms on this
// machine, so yieldEvery = 1 is the default; { worker: true } runs the whole rebuild in a worker_thread (main-thread slices ~0 ms).
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const TFS = Object.freeze({ M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 });
const BOARD = Object.freeze(['4H Open', '1H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low']);
const VERSION = 'tide-rebuild-r1.1';   // r1.1 (MacLive 11/04): progress every progressMs (onProgress, also from the worker) + a timeout that TERMINATES the worker
const sec = t => (t > 1e11 ? Math.floor(t / 1000) : t);
const norm = b => ({ t: sec(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: isNum(b.v) ? b.v : 0 });
const ms = b => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < x) lo = m + 1; else hi = m; } return lo; }
function prep(input) {
  const m1 = (input.m1 || []).map(norm).filter(b => [b.t, b.o, b.h, b.l, b.c].every(isNum)).sort((a, b) => a.t - b.t);
  const m1Idx = new Map(m1.map((b, i) => [b.t, i])), htf = {};
  for (const k of Object.keys(TFS)) htf[k] = ((input.htf && input.htf[k]) || []).map(norm).sort((a, b) => a.t - b.t);
  const W = ((input.htf && input.htf.W) || input.W || []).map(norm).sort((a, b) => a.t - b.t);
  return { m1, m1Idx, htf, W };
}
function formingFrom(m1, m1Idx, t0, T) {
  const bs = []; for (let t = t0; t < T; t += 60) { const i = m1Idx.get(t); if (i !== undefined) bs.push(m1[i]); }
  return bs.length ? { t: t0, o: bs[0].o, h: Math.max(...bs.map(x => x.h)), l: Math.min(...bs.map(x => x.l)), c: bs[bs.length - 1].c, v: bs.reduce((a, x) => a + x.v, 0) } : null;
}
function asof(D, k, T) {   // build-bias-fixture.cjs asof(src[k].filter(t >= T - 400 tf), tf, T)
  const tf = TFS[k], arr = D.htf[k], lo = lowerBound(arr, T - 400 * tf), hi = lowerBound(arr, T), out = [];
  let formingDone = false;
  for (let i = lo; i < hi; i++) {
    const b = arr[i];
    if (b.t + tf <= T) { out.push(ms(b)); continue; }
    const f = formingFrom(D.m1, D.m1Idx, b.t, T); if (f) out.push(ms(f)); formingDone = true;
  }
  if (!formingDone) {   // live: the provider holds closed bars only -> the forming bucket on the provider's grid
    const last = hi > lo ? arr[hi - 1] : null, x = T - 60;
    let t0 = tf <= 3600 ? x - (((x % tf) + tf) % tf) : last ? last.t + tf * Math.floor((x - last.t) / tf) : null;
    if (isNum(t0) && t0 >= T - 400 * tf && (!last || t0 > last.t)) { const f = formingFrom(D.m1, D.m1Idx, t0, T); if (f) out.push(ms(f)); }
  }
  return out;
}
function readingAt(D, levelsPro, T, opts) {
  const htf = {}; for (const k of Object.keys(TFS)) htf[k] = asof(D, k, T);
  htf.W = D.W.filter(b => b.t < T).map(ms);
  const one = k => { const o = levelsPro.evaluateLevelsPro(htf[k].slice(-2000), htf, Object.assign({ sessionAnchor: 'cme', vwapBuild: '5m', vwapBars: htf.M5 }, opts || {})); return o[o.length - 1] || null; };
  return { htf, one };
}
const r4 = x => (isNum(x) ? Math.round(x * 10000) / 10000 : null);   // the fixture's rounding; `raw` keeps the unrounded score
function stamp(T, a, b) {
  const side = r => (r && isNum(r.biasScore) ? { score: r.biasScore, valid: true, observedAt: T } : null);
  const lv = a && Array.isArray(a.levels) ? a.levels : [];
  const board = BOARD.map(name => { const x = lv.find(l => l && l.name === name && isNum(l.price)); return x ? { name, price: x.price } : null; }).filter(Boolean);
  return { T, bias: { m15: side(a), m30: side(b) }, s15: r4(a && a.biasScore), s30: r4(b && b.biasScore), board };
}
// rebuildBias({ m1, htf: { M5, M15, M30, H1, H4, W }, now, hours = 6, levelsPro, yieldEvery = 1, opts, worker = false }) -> Promise<book>
//   m1 / htf bars: { t (sec or ms, bar OPEN), o, h, l, c, v }; now: sec or ms (the last COMPLETED minute close <= now is the last T).
//   book = { version, readings: Map(T -> { T, bias: {m15, m30}, s15, s30, board }), rows: [{ t: T*1000, s15, s30 }] (for tideWire.noteBias), from, to, n,
//            evals, ms, maxSliceMs, missing: [T...] (minutes without a 1m bar: no reading) }
async function rebuildBias(p) {
  const { now, hours = 6, levelsPro, yieldEvery = 1, opts, worker = false, onProgress = null, progressMs = 60000 } = p || {};
  if (!levelsPro || typeof levelsPro.evaluateLevelsPro !== 'function') throw new Error('rebuildBias: levelsPro (lib/levelsPro.js) with evaluateLevelsPro is required');
  if (!isNum(now)) throw new Error('rebuildBias: now required');
  if (worker) return viaWorker(p);
  const D = prep(p), t0 = Date.now(), nowS = sec(now), last = nowS - (nowS % 60), first = last - Math.round(hours * 3600) + 60;
  const readings = new Map(), missing = []; let evals = 0, maxSlice = 0, slice = process.hrtime.bigint();
  const yieldNow = () => new Promise(r => setImmediate(r));
  let lastProg = Date.now(); const total = Math.max(0, Math.round((last - first) / 60) + 1);
  for (let T = first; T <= last; T += 60) {
    if (typeof onProgress === 'function' && Date.now() - lastProg >= progressMs) { lastProg = Date.now(); try { onProgress({ done: Math.round((T - first) / 60), of: total }); } catch (e) { /* progress only */ } }
    if (!D.m1Idx.has(T - 60)) { missing.push(T); continue; }   // no closed 1m bar ending at T: no reading (the engine gets none either)
    const { one } = readingAt(D, levelsPro, T, opts);
    const a = one('M15'); evals++;
    if (evals % yieldEvery === 0) { maxSlice = Math.max(maxSlice, Number(process.hrtime.bigint() - slice) / 1e6); await yieldNow(); slice = process.hrtime.bigint(); }
    const b = one('M30'); evals++;
    readings.set(T, stamp(T, a, b));
    if (evals % yieldEvery === 0) { maxSlice = Math.max(maxSlice, Number(process.hrtime.bigint() - slice) / 1e6); await yieldNow(); slice = process.hrtime.bigint(); }
  }
  maxSlice = Math.max(maxSlice, Number(process.hrtime.bigint() - slice) / 1e6);
  const keys = [...readings.keys()];
  return { version: VERSION, readings, rows: keys.map(T => { const r = readings.get(T); return { t: T * 1000, s15: r.bias.m15 ? r.bias.m15.score : null, s30: r.bias.m30 ? r.bias.m30.score : null }; }),
    from: keys.length ? keys[0] : null, to: keys.length ? keys[keys.length - 1] : null, n: readings.size, evals, ms: Date.now() - t0, maxSliceMs: Math.round(maxSlice * 10) / 10, missing };
}
// fill the wire's bias book (lib/tideWire.js createBiasBook / noteBias): rows oldest first, the book keeps its own cap (BIAS_KEEP)
function fillBook(book, rebuilt, noteBias) { for (const r of rebuilt.rows) noteBias(book, r.t, r.s15, r.s30); return book; }
// ---------------------------------------------------------------- worker mode: the same code in a worker_thread
function viaWorker(p) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const t0 = Date.now(), w = new Worker(__filename, { workerData: { m1: p.m1, htf: p.htf, W: p.W, now: p.now, hours: p.hours, opts: p.opts, yieldEvery: 1000000, levelsProPath: p.levelsProPath, progressMs: p.progressMs || 60000 } });
    let done = false; const fin = f => { if (done) return; done = true; if (timer) clearTimeout(timer); f(); };
    const timer = Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? setTimeout(() => fin(() => { try { w.terminate(); } catch (e) { /* gone */ } const e = new Error(`rebuild timed out after ${Math.round(p.timeoutMs / 1000)} s (worker terminated)`); e.timedOut = true; reject(e); }), p.timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    w.on('message', m => { if (m && m.progress) { if (typeof p.onProgress === 'function') { try { p.onProgress(m.progress); } catch (e) { /* progress only */ } } return; }
      fin(() => { if (m.error) return reject(new Error(m.error)); m.readings = new Map(m.readings); m.ms = Date.now() - t0; m.worker = true; resolve(m); }); });
    w.once('error', e => fin(() => reject(e)));
  });
}
const wt = (() => { try { return require('worker_threads'); } catch (e) { return null; } })();
if (wt && !wt.isMainThread && wt.workerData && wt.workerData.levelsProPath) {
  const d = wt.workerData;
  try { require('os').setPriority(19); } catch (e) { /* not permitted: the normal priority */ }   // r1.1 (MacLive): Linux lowers only THIS worker thread; the bot's main loop (polls, orders) keeps its priority
  rebuildBias(Object.assign({}, d, { levelsPro: require(d.levelsProPath), worker: false, onProgress: x => wt.parentPort.postMessage({ progress: x }) })).then(r => wt.parentPort.postMessage(Object.assign({}, r, { readings: [...r.readings] })),
    e => wt.parentPort.postMessage({ error: String(e && e.stack || e) }));
}
module.exports = { VERSION, rebuildBias, fillBook, readingAt, asof, TFS, BOARD };
