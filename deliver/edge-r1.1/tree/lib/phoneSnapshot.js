'use strict';
// botfix-B: the phone snapshot (bias-snapshot-<SYMBOL>.json) - atomic write and the ADDITIVE fields the terminal could not get before.
// Display only: nothing here is read by an order, a gate, a size or an exit. Every existing snapshot key keeps its name and meaning: extras never replace a
// key the executor already wrote (write() drops a colliding extra), and the trade-row fields are added beside the existing row fields.
// All times are epoch ms (UTC); the phone formats them.
const fs = require('fs');
const fin = v => typeof v === 'number' && Number.isFinite(v);
const r2 = v => (fin(v) ? Math.round(v * 100) / 100 : null);

// ---- atomic write: a unique tmp file in the same folder, then rename (a reader sees the old file or the new one, never a torn one) ----
// The tmp name is per process (and thread): writes inside one process are synchronous, so it never collides, and a crash leaves at most one tmp per process.
const THREAD = (() => { try { return require('worker_threads').threadId; } catch (e) { return 0; } })();
function writeAtomic(file, str) {
  const tmp = `${file}.${process.pid}.${THREAD}.tmp`;
  try { fs.writeFileSync(tmp, str); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ } throw e; }
}
// base = the executor's snapshot object as before; extrasFn(base) -> { key: value } added only where base has no such key.
function write(file, base, extrasFn) {
  let extras = null;
  try { extras = extrasFn ? extrasFn(base) : null; } catch (e) { extras = { phoneExtrasError: String(e && e.message || e).slice(0, 200) }; }
  if (extras && typeof extras === 'object') for (const [k, v] of Object.entries(extras)) if (!Object.prototype.hasOwnProperty.call(base, k)) base[k] = v;
  writeAtomic(file, JSON.stringify(base));
}

// ---- build stamp (from lib/journalMeta.js buildSessionStamp, taken once at startup) ----
let build = null;
function setBuild(stamp) {
  if (!stamp || typeof stamp !== 'object') return;
  const exe = stamp.files && typeof stamp.files['live-executor.js'] === 'string' ? stamp.files['live-executor.js'] : null;
  build = { stampId: stamp.stampId || null, executor: exe ? exe.slice(0, 8) : null, settingsHash: typeof stamp.settingsHash === 'string' ? stamp.settingsHash.slice(0, 8) : null,
    overridesHash: typeof stamp.overridesHash === 'string' ? stamp.overridesHash.slice(0, 8) : null, startedAt: fin(stamp.startedAt) ? stamp.startedAt : null,
    runId: typeof stamp.runId === 'string' ? stamp.runId.slice(0, 8) : null, node: typeof stamp.node === 'string' ? stamp.node : null };
}
function buildView() { return build ? { ...build } : null; }

// ---- exit reasons: from the trade_manage rows (and manual_flatten rows) each journalId already writes ----
const EXIT_ROW_CODES = new Set(['TP1_FILLED', 'TP2_OR_BE', 'RUNNER_STOPPED', 'STOP_FILLED', 'POSITION_CLOSED', 'PROFIT_LOCK_CASH', 'MARKET_EXIT', 'SMART_HOLD_EXIT', 'TIME_STOP',
  'NO_PROGRESS_EXIT', 'NO_PROGRESS_ABANDONED', 'LEVEL_LOSS_EXIT', 'LEVEL_LOSS_ABANDONED', 'EARLY_ADVERSE_EXIT', 'EARLY_ADVERSE_ABANDONED', 'SESSION_FLATTEN', 'MORNING_FLATTEN', 'MANUAL_FLATTEN', 'FLATTEN_CONFIRMED']);
const byJid = new Map();
function indexJournal(e) {
  if (!e || typeof e !== 'object' || typeof e.journalId !== 'string' || !e.journalId || !fin(e.t)) return;
  let code = null;
  if (e.type === 'trade_manage' && EXIT_ROW_CODES.has(e.code)) code = e.code;
  else if (e.type === 'manual_flatten') code = 'MANUAL_FLATTEN';
  else if (e.type === 'level_loss_exit') code = 'LEVEL_LOSS_EXIT';
  if (!code) return;
  const txt = typeof e.text === 'string' ? e.text : '';
  const x = { t: e.t, code, viaTarget: e.viaTarget === true || /closed at its TP2 target/.test(txt), whole: /TP1 filled: all /.test(txt), phase: typeof e.phase === 'string' ? e.phase : null,
    reason: typeof e.reason === 'string' ? e.reason : null };
  const k = `${x.t}|${x.code}|${x.phase}`;
  let r = byJid.get(e.journalId);
  if (!r) { r = []; byJid.set(e.journalId, r); while (byJid.size > 400) byJid.delete(byJid.keys().next().value); }
  if (r.some(y => y.k === k)) return;   // the same row from the file seed and the live feed counts once
  x.k = k; let i = r.length; while (i > 0 && r[i - 1].t > x.t) i--; r.splice(i, 0, x); if (r.length > 60) r.shift();
}
// exitReason: TP1 | TP2 | RUNNER_STOP | STOP | NO_PROGRESS | EARLY_EXIT (edge r1) | SESSION_CLOSE | MORNING_HOLD | LEVEL_LOSS | MANUAL_FLATTEN | UNKNOWN; exitCode = the deciding journal code.
// RUNNER_STOP = any stop that closed contracts after TP1 (break-even or trailing). A forced exit (no-progress, level loss, session, morning, manual) wins
// over the legs, unless its own ABANDONED row follows. TIME_STOP / SMART_HOLD_EXIT / PROFIT_LOCK_CASH before TP1 have no name in the list: UNKNOWN + exitCode.
function exitReasonOf(journalId, opts = {}) {
  const R = journalId ? byJid.get(journalId) : null;
  if (!R || !R.length) return opts.manualFlatten ? { exitReason: 'MANUAL_FLATTEN', exitCode: 'manual_flatten' } : { exitReason: 'UNKNOWN', exitCode: null };
  let forced = null, leg = null, tp1 = false, wholeTp1 = false;
  for (const x of R) {
    switch (x.code) {
      case 'TP1_FILLED': tp1 = true; leg = { exitReason: 'TP1', exitCode: x.code }; if (x.whole) wholeTp1 = true; break;
      case 'TP2_OR_BE': leg = x.viaTarget ? { exitReason: 'TP2', exitCode: x.code } : { exitReason: 'RUNNER_STOP', exitCode: x.code }; break;
      case 'RUNNER_STOPPED': leg = { exitReason: 'RUNNER_STOP', exitCode: x.code }; break;
      case 'STOP_FILLED': leg = { exitReason: tp1 ? 'RUNNER_STOP' : 'STOP', exitCode: x.code }; break;
      case 'MARKET_EXIT': case 'PROFIT_LOCK_CASH': leg = { exitReason: tp1 ? 'RUNNER_STOP' : (x.code === 'MARKET_EXIT' ? 'STOP' : 'UNKNOWN'), exitCode: x.code }; break;
      case 'POSITION_CLOSED': if (!wholeTp1 && tp1 && (x.phase === 'LEG3_OPEN' || (leg && leg.exitReason === 'TP1'))) leg = { exitReason: 'RUNNER_STOP', exitCode: x.code }; break;
      case 'SMART_HOLD_EXIT': case 'TIME_STOP': forced = { exitReason: 'UNKNOWN', exitCode: x.code }; break;
      case 'NO_PROGRESS_EXIT': forced = { exitReason: 'NO_PROGRESS', exitCode: x.code }; break;
      case 'LEVEL_LOSS_EXIT': forced = { exitReason: 'LEVEL_LOSS', exitCode: x.code }; break;
      case 'EARLY_ADVERSE_EXIT': forced = { exitReason: 'EARLY_EXIT', exitCode: x.code }; break;   // edge r1
      case 'EARLY_ADVERSE_ABANDONED': if (forced && forced.exitReason === 'EARLY_EXIT') forced = null; break;
      case 'NO_PROGRESS_ABANDONED': if (forced && forced.exitReason === 'NO_PROGRESS') forced = null; break;
      case 'LEVEL_LOSS_ABANDONED': if (forced && forced.exitReason === 'LEVEL_LOSS') forced = null; break;
      case 'MORNING_FLATTEN': forced = { exitReason: 'MORNING_HOLD', exitCode: x.code }; break;
      case 'SESSION_FLATTEN': if (!(forced && forced.exitReason === 'MORNING_HOLD')) forced = /^morning hold/i.test(x.reason || '') ? { exitReason: 'MORNING_HOLD', exitCode: x.code } : { exitReason: 'SESSION_CLOSE', exitCode: x.code }; break;
      case 'MANUAL_FLATTEN': forced = { exitReason: 'MANUAL_FLATTEN', exitCode: x.code }; break;
      default: break;
    }
    if (wholeTp1 && x.code === 'TP1_FILLED') break;   // a whole-position TP1 ends the trade
  }
  return forced || leg || (opts.manualFlatten ? { exitReason: 'MANUAL_FLATTEN', exitCode: 'manual_flatten' } : { exitReason: 'UNKNOWN', exitCode: null });
}

// ---- fill ids per broker round trip (same grouping as the executor's computeRecentTrades: a round trip starts when the position leaves 0) ----
let fillGroups = new Map();   // `${contractId}|${entryTime}` -> [fill ids]
function noteFills(fills) {
  if (!Array.isArray(fills)) return;
  const sorted = fills.filter(f => f && f.price != null).sort((a, b) => new Date(a.creationTimestamp) - new Date(b.creationTimestamp));
  const m = new Map(); let pos = 0, cur = null;
  for (const f of sorted) {
    if (pos === 0) { cur = []; m.set(`${f.contractId}|${f.creationTimestamp}`, cur); }
    if (f.id != null) cur.push(f.id);
    pos += f.side === 1 ? -f.size : f.size;
  }
  fillGroups = m;
}
const rtKey = b => `${b.contractId}|${b.entryTime}`;
function moneyOf(rt) {
  if (!rt) return { grossUsd: null, feesUsd: null, commissionsUsd: null, netUsd: null, fillIds: null };
  const gross = fin(rt.grossPnl) ? r2(rt.grossPnl) : null, net = fin(rt.netPnl) ? r2(rt.netPnl) : null;
  const ids = fillGroups.get(rtKey(rt));
  return { grossUsd: gross, feesUsd: gross != null && net != null ? r2(gross - net) : null, commissionsUsd: fin(rt.commissions) ? r2(rt.commissions) : null, netUsd: net, fillIds: ids ? ids.slice(0, 50) : null };
}

// ---- broker truth from the reads the bot already makes (lib/brokerReads.js) ----
const OTYPE = { 1: 'LIMIT', 2: 'MARKET', 4: 'STOP', 5: 'TRAILING_STOP' };
function brokerView({ live, accountId, contractId, reads, sm }) {
  if (!live) return { readAt: null, source: 'paper', position: null, workingOrders: null };
  const P = reads.positionRead(accountId), O = reads.ordersRead(accountId);
  const kindOf = o => { if (!sm) return null; const id = String(o.id);
    if (sm.entryOrderId != null && String(sm.entryOrderId) === id) return 'entry';
    if (sm.stopOrderId != null && String(sm.stopOrderId) === id) return sm.phase === 'LEG1_OPEN' ? 'stop' : 'stop-after-tp1';
    if (sm.leg3StopOrderId != null && String(sm.leg3StopOrderId) === id) return 'runner-stop';
    if (sm.targetOrderId != null && String(sm.targetOrderId) === id) return sm.phase === 'LEG1_OPEN' ? 'tp1' : sm.phase === 'LEG23_OPEN' ? 'tp2' : 'target';
    return 'other'; };
  const p = P ? P.list.find(x => x && x.contractId === contractId) : null;
  const position = !P ? null : p && p.size > 0 ? { side: p.type === 1 ? 'LONG' : p.type === 2 ? 'SHORT' : null, qty: p.size, avgPrice: fin(p.averagePrice) ? p.averagePrice : null, openedAt: p.creationTimestamp ? Date.parse(p.creationTimestamp) || null : null }
    : { side: 'FLAT', qty: 0, avgPrice: null, openedAt: null };
  const workingOrders = !O ? null : O.list.filter(o => o && o.contractId === contractId).map(o => ({ id: o.id, type: OTYPE[o.type] || String(o.type), side: o.side === 0 ? 'BUY' : o.side === 1 ? 'SELL' : null,
    qty: o.size, price: fin(o.stopPrice) ? o.stopPrice : fin(o.limitPrice) ? o.limitPrice : null, stopPrice: fin(o.stopPrice) ? o.stopPrice : null, limitPrice: fin(o.limitPrice) ? o.limitPrice : null,
    kind: kindOf(o), createdAt: o.creationTimestamp ? Date.parse(o.creationTimestamp) || null : null, updatedAt: o.updateTimestamp ? Date.parse(o.updateTimestamp) || null : null }));
  const times = [P && P.readAt, O && O.readAt].filter(fin);
  return { readAt: times.length === 2 ? Math.min(...times) : null, positionReadAt: P ? P.readAt : null, ordersReadAt: O ? O.readAt : null, source: 'broker', position, workingOrders };
}

// ---- news gate STATE (what the existing gate is doing now; its behaviour is unchanged and stays fail-open without a calendar) ----
function newsGateView(news, aware) {
  if (!news || typeof news !== 'object') return { loaded: false, eventsNext: [], blocking: false, blockingWhat: null, failOpen: true, aware: !!aware };
  const loaded = fin(news.count) && news.count > 0;
  const entries = !!news.wait, resting = !!news.resting;
  return { loaded, count: fin(news.count) ? news.count : 0, eventsNext: (Array.isArray(news.upcoming) ? news.upcoming : []).slice(0, 3).map(e => ({ t: e.t, title: e.title, impact: e.impact })),
    blocking: entries || resting, blockingWhat: entries ? 'entries' : resting ? 'resting-entries' : null, until: entries && news.wait && fin(news.wait.until) ? news.wait.until : null,
    failOpen: !loaded, aware: !!aware && !news.off, refreshedAt: fin(news.refreshedAt) ? news.refreshedAt : null, fileAt: fin(news.fileAt) ? news.fileAt : null };
}

// ---- the extras for one snapshot write (deadline scope 11/10: build, broker, requests; exit reason / fees / checklist time / news state are NEXT) ----
function extras(base, ctx) {
  const out = {};
  out.build = buildView();
  try { out.broker = brokerView(ctx); } catch (e) { out.broker = null; }
  out.requests = ctx.requests ? ctx.requests.view() : null;
  out.phoneFields = 1;   // version of the botfix-B additive fields
  return out;
}
function _reset() { build = null; byJid.clear(); fillGroups = new Map(); }
module.exports = { writeAtomic, write, setBuild, buildView, indexJournal, exitReasonOf, noteFills, moneyOf, brokerView, newsGateView, extras, _reset };
