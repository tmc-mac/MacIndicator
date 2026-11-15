'use strict';
// edge r1.3: the OWNER FLAG. Mac taps Flag on a trade in the phone terminal; the bot writes ONE journal row (owner_flag) and acks. RECORD ONLY.
// Nothing here is read by an order, a gate, a phase, a size, a stop or a target: the module holds no reference to the order machine, makes no broker call,
// and its only outputs are (1) the owner_flag journal row, (2) the ack handed to lib/phoneRequests.js, (3) the display fields view() / flagsOf() / withFlags().
//   - Channel: tmc-proxy.js POST /flag drops one file per request in owner-flag-<SYMBOL>/<id>.json (tmp + rename), { type:'flag', id, requestedAt, trade, reason, note }.
//     The executor calls process() on every main-loop pass and on every ~3 s fast-poll step. A flag never wakes the main loop.
//   - Validation (any failure = ack REJECTED with a reason code, NO journal row): MALFORMED, BAD_ID, BAD_TYPE, STALE (older than 60 s, the same limit as
//     flatten / pause / cancel), FUTURE_TIME, BAD_TRADE, BAD_REASON, BAD_NOTE, NOTE_TOO_LONG (over 280 characters), RATE_LIMIT (20 accepted in any 60 min),
//     JOURNAL_WRITE_FAILED (the row could not be written: nothing recorded, the same id may be sent again).
//   - Accept: exactly one row owner_flag { t, requestId, requestedAt, trade, reason, note, tradeKnown, tradeFacts }, then ack APPLIED (same id, same requestedAt).
//   - Idempotent: an id already answered gets the SAME answer again and no second row. Accepted ids are rebuilt from the journal at startup (indexJournal),
//     so a retry after a restart is still one row.
const fs = require('fs'), path = require('path');
const REASONS = Object.freeze(['stopped_then_worked', 'bad_entry', 'exit_too_early', 'missed_move', 'good_trade', 'other']);
const MAX_NOTE = 280, MAX_PER_HOUR = 20, HOUR_MS = 3600000, MAX_AGE_MS = 60000, FUTURE_MS = 60000, YOUNG_MS = 2000, KEEP_PER_TRADE = 3, MAX_BATCH = 50;
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/, TRADE_RE = /^[\x21-\x7e]{1,120}$/, FILE_RE = /^([A-Za-z0-9._:-]{1,80})\.json$/;
const fin = v => typeof v === 'number' && Number.isFinite(v);
const chars = s => Array.from(s).length;
// Plain text: line breaks and tabs become one space, every other control / invisible-format character is dropped (C0, DEL, C1, zero-width, bidi, separators).
function cleanNote(s) {
  if (typeof s !== 'string') return null;
  const out = s.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').replace(/ {2,}/g, ' ').trim();
  return out ? out : null;
}
// A request body -> { ok: true, trade, reason, note } or { ok: false, code, text }. Time and id are checked by process().
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'MALFORMED', text: 'the request is not a JSON object' };
  if (body.type !== undefined && body.type !== 'flag') return { ok: false, code: 'BAD_TYPE', text: 'type must be "flag"' };
  if (typeof body.trade !== 'string' || !TRADE_RE.test(body.trade)) return { ok: false, code: 'BAD_TRADE', text: 'trade id missing or not 1-120 printable characters without spaces' };
  if (typeof body.reason !== 'string' || !REASONS.includes(body.reason)) return { ok: false, code: 'BAD_REASON', text: 'reason must be one of ' + REASONS.join(', ') };
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return { ok: false, code: 'BAD_NOTE', text: 'note must be text' };
  if (typeof body.note === 'string' && chars(body.note) > MAX_NOTE) return { ok: false, code: 'NOTE_TOO_LONG', text: `note is ${chars(body.note)} characters (limit ${MAX_NOTE})` };
  return { ok: true, trade: body.trade, reason: body.reason, note: cleanNote(body.note) };
}

// ack(rq, result, reason) = lib/phoneRequests.js ack; journal(row) -> true when the row reached the journal file; tradeFacts(tradeId) -> plain object or null.
function createOwnerFlags({ dir, symbol, now = () => Date.now(), ack = null, journal = null, tradeFacts = null, log = null, maxAgeMs = MAX_AGE_MS } = {}) {
  if (!dir || !/^[A-Z0-9]{1,10}$/.test(String(symbol))) throw new Error('ownerFlags: dir and symbol are required');
  const folder = path.join(dir, `owner-flag-${symbol}`);
  const answered = new Map();   // request id -> { result, reason, requestedAt } (the answer given; bounded)
  const accepted = [];          // epoch ms of each accepted flag in the last hour (the rate limit)
  const byTrade = new Map();    // trade id -> [{ t, reason, note }] oldest first, the last KEEP_PER_TRADE
  let logged = 0, loggedHour = 0;
  const say = m => { if (!log) return; const h = Math.floor(now() / HOUR_MS); if (h !== loggedHour) { loggedHour = h; logged = 0; } if (logged++ < 10) { try { log(m); } catch (e) { /* log only */ } } };
  const remember = (id, a) => { answered.delete(id); answered.set(id, a); while (answered.size > 500) answered.delete(answered.keys().next().value); };
  const prune = t => { while (accepted.length && t - accepted[0] >= HOUR_MS) accepted.shift(); };
  function noteFlag(trade, f) {
    let l = byTrade.get(trade);
    if (!l) { l = []; byTrade.set(trade, l); while (byTrade.size > 400) byTrade.delete(byTrade.keys().next().value); }
    let i = l.length; while (i > 0 && l[i - 1].t > f.t) i--; l.splice(i, 0, f);
    while (l.length > KEEP_PER_TRADE) l.shift();
  }
  // Startup seed: every owner_flag row already in the journal (flags per trade, answered ids, the last hour's count). Never called for a row this run wrote.
  function indexJournal(e) {
    try {
      if (!e || typeof e !== 'object' || e.type !== 'owner_flag' || !fin(e.t) || typeof e.trade !== 'string' || !REASONS.includes(e.reason)) return;
      if (typeof e.requestId === 'string' && e.requestId) {
        if (answered.has(e.requestId)) return;   // the same request twice in the file counts once
        remember(e.requestId, { result: 'APPLIED', reason: appliedText(e), requestedAt: fin(e.requestedAt) ? e.requestedAt : null });
      }
      noteFlag(e.trade, { t: e.t, reason: e.reason, note: typeof e.note === 'string' ? e.note : null });
      if (now() - e.t < HOUR_MS) { let i = accepted.length; while (i > 0 && accepted[i - 1] > e.t) i--; accepted.splice(i, 0, e.t); }
    } catch (err) { /* display / record only */ }
  }
  const appliedText = r => `flag recorded: ${r.reason}${r.tradeKnown === false ? ' (no trade matched this id)' : ''}`;
  const send = (rq, result, reason) => { try { return ack ? ack(rq, result, reason) : null; } catch (e) { return null; } };
  const reject = (rq, code, text, keep = true) => {
    const reason = `${code}: ${text}`;
    if (keep && rq.id != null) remember(rq.id, { result: 'REJECTED', reason, requestedAt: rq.requestedAt });
    say(`  [flag] ${rq.id || 'request'} REJECTED ${reason}`);
    return send(rq, 'REJECTED', reason);
  };

  // One request body (already parsed) -> the ack. receivedAt = when the bot read it.
  function handle(body, { fallbackTime = null, fileId = null } = {}) {
    const t = now();
    const rawId = body && typeof body === 'object' && !Array.isArray(body) ? body.id : null;
    const id = typeof rawId === 'string' && ID_RE.test(rawId) ? rawId : null;
    const requestedAt = body && fin(body.requestedAt) ? body.requestedAt : fallbackTime;
    const rq = { id: id || fileId, type: 'flag', requestedAt, receivedAt: t };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(rq, 'MALFORMED', 'the request is not a JSON object', false);
    if (!id) return reject(rq, 'BAD_ID', 'id missing or not 1-80 characters of A-Z a-z 0-9 . _ : -', false);
    const old = answered.get(id);
    if (old) return send({ ...rq, requestedAt: old.requestedAt }, old.result, old.reason);   // idempotent: the same answer, no second row
    if (!fin(requestedAt)) return reject(rq, 'STALE', 'no request time; not recorded');
    const age = t - requestedAt;
    if (age > maxAgeMs) return reject(rq, 'STALE', `written ${Math.round(age / 1000)} s ago (limit ${Math.round(maxAgeMs / 1000)} s); not recorded`);
    if (-age > FUTURE_MS) return reject(rq, 'FUTURE_TIME', `requestedAt is ${Math.round(-age / 1000)} s ahead of the bot clock`);
    const v = validate(body);
    if (!v.ok) return reject(rq, v.code, v.text);
    prune(t);
    if (accepted.length >= MAX_PER_HOUR) return reject(rq, 'RATE_LIMIT', `${MAX_PER_HOUR} flags already recorded in the last 60 min; try again later`, false);
    let facts = null;
    try { facts = tradeFacts ? tradeFacts(v.trade) : null; } catch (e) { facts = null; }
    if (!facts || typeof facts !== 'object') facts = null;
    const row = { type: 'owner_flag', t, requestId: id, requestedAt, trade: v.trade, reason: v.reason, note: v.note, tradeKnown: facts != null, tradeFacts: facts };
    let wrote = false;
    try { wrote = journal ? journal(row) === true : false; } catch (e) { wrote = false; }
    if (!wrote) return reject(rq, 'JOURNAL_WRITE_FAILED', 'the journal row could not be written; nothing recorded, send again', false);
    accepted.push(t);
    noteFlag(v.trade, { t, reason: v.reason, note: v.note });
    const reason = appliedText(row);
    remember(id, { result: 'APPLIED', reason, requestedAt });
    return send(rq, 'APPLIED', reason);
  }

  // Read the queue folder: each file is consumed (deleted) BEFORE it is handled, oldest first, at most MAX_BATCH per call. Returns the number handled.
  function process() {
    let names;
    try { names = fs.readdirSync(folder); } catch (e) { return 0; }
    const list = [];
    for (const n of names) {
      const m = FILE_RE.exec(n); if (!m) continue;
      const f = path.join(folder, n);
      try { const st = fs.statSync(f); list.push({ f, fileId: m[1], mtime: st.mtimeMs }); } catch (e) { /* vanished */ }
    }
    list.sort((a, b) => a.mtime - b.mtime);
    let done = 0;
    for (const it of list.slice(0, MAX_BATCH)) {
      let raw; try { raw = fs.readFileSync(it.f, 'utf8'); } catch (e) { continue; }
      let body = null; try { body = JSON.parse(raw); } catch (e) { body = null; }
      if ((!body || typeof body !== 'object') && now() - it.mtime < YOUNG_MS) continue;   // possibly mid-write: next poll
      try { fs.unlinkSync(it.f); } catch (e) { continue; }   // cannot consume it: do not act (it would be read again)
      try { handle(body, { fallbackTime: null, fileId: it.fileId }); } catch (e) { say('  [flag] request failed (record only): ' + (e && e.message)); }
      done++;
    }
    return done;
  }
  function flagsOf(trade) { const l = typeof trade === 'string' && trade ? byTrade.get(trade) : null; return l ? l.map(f => ({ t: f.t, reason: f.reason, note: f.note })) : []; }
  // A copy of a trade row with flags: [...] added (never replaces an existing key). keys = the row fields that can hold the trade's journal id.
  function withFlags(row, keys = ['journalId', 'whyJournalId', 'key']) {
    if (!row || typeof row !== 'object' || Object.prototype.hasOwnProperty.call(row, 'flags')) return row;
    let out = [];
    for (const k of keys) { const l = flagsOf(row[k]); if (l.length) { out = l; break; } }
    return { ...row, flags: out };
  }
  // The Levels panel's trade rows (trade.open, trade.today[]) + flags. A copy; the panel object is not changed.
  function withPanelFlags(panel) {
    try {
      if (!panel || typeof panel !== 'object' || !panel.trade || typeof panel.trade !== 'object') return panel;
      return { ...panel, trade: { ...panel.trade, open: withFlags(panel.trade.open), today: Array.isArray(panel.trade.today) ? panel.trade.today.map(r => withFlags(r)) : panel.trade.today } };
    } catch (e) { return panel; }
  }
  function capability() { prune(now()); return { reasons: REASONS.slice(), maxNote: MAX_NOTE, maxPerHour: MAX_PER_HOUR, maxAgeMs, usedThisHour: accepted.length, keepPerTrade: KEEP_PER_TRADE }; }
  function setHooks(h = {}) { if (typeof h.ack === 'function') ack = h.ack; if (typeof h.journal === 'function') journal = h.journal; if (typeof h.tradeFacts === 'function') tradeFacts = h.tradeFacts; if (typeof h.log === 'function') log = h.log; }
  return { process, handle, indexJournal, flagsOf, withFlags, withPanelFlags, capability, setHooks, folder };
}

// ---- proxy side (tmc-proxy.js POST /flag): queue one request file. Light checks only; the bot validates strictly and answers in the snapshot. ----
const MAX_QUEUED = 40;
function enqueue(dir, symbol, input, { now = () => Date.now(), newId = () => 'g-' + require('crypto').randomBytes(8).toString('hex') } = {}) {
  if (!/^[A-Z0-9]{1,10}$/.test(String(symbol))) throw new Error('Invalid symbol');
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : newId();
  const folder = path.join(dir, `owner-flag-${symbol}`);
  fs.mkdirSync(folder, { recursive: true });
  const waiting = fs.readdirSync(folder).filter(n => FILE_RE.test(n)).length;
  if (waiting >= MAX_QUEUED) { const e = new Error('QUEUE_FULL: the bot has not read the earlier flags yet'); e.code = 'QUEUE_FULL'; throw e; }
  const str = v => (typeof v === 'string' ? v.slice(0, 2000) : v == null ? undefined : null);   // not text -> null: the bot answers BAD_TRADE / BAD_REASON / BAD_NOTE
  const requestedAt = now();
  const body = { type: 'flag', id, requestedAt, trade: str(src.trade), reason: str(src.reason), note: str(src.note) };
  const dest = path.join(folder, id + '.json'), tmp = path.join(folder, `${id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body)); fs.renameSync(tmp, dest);
  return { requestId: id, requestedAt };
}

module.exports = { createOwnerFlags, enqueue, validate, cleanNote, REASONS, MAX_NOTE, MAX_PER_HOUR, MAX_AGE_MS, KEEP_PER_TRADE, MAX_QUEUED };
