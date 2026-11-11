'use strict';
// lib/notifyPolicy.js - bot-2026-10-18f1 (NOTIFICATION ONLY). Pure rules for WHICH phone pushes go to ntfy.sh and when.
// Nothing here is read by an order, a gate, a size, a stop, a target or the state machine: live-executor.js calls it only from
// notifyPhone(), the periodic status push and the level-cross log block, and every caller keeps doing exactly what it did before
// apart from (maybe) not sending the push. Diagnosis: notif/DIAGNOSIS.md (ntfy.sh: 250 messages per IP per UTC day; 448-568/day were sent).
//   F2  levelCrossDecision(): CONFIG.levelCrossPush 'off' (log only, the default) | 'key' (PWH, PWL, Week Open, PDH, PDL, 4H Open; 30-min cooldown per level) | 'all' (the old behaviour)
//   F3  statusPushWindow(): the periodic status push only between 15:00 and 13:10 PT on trading days (Sun 15:00 -> Fri 13:10, not 13:10-15:00)
//   F4  tierOf() + createNotifyBudget(): CRITICAL (fills, exits, stop-outs, errors = priority high/urgent, session close, auth) is always sent;
//       INFO is capped per UTC day (ntfy's counter resets at 00:00 UTC) with 30% of the cap kept for after 13:00 PT; over the cap = logged, not sent.
//       The weekend (Fri 13:10 PT -> Sun 15:00 PT) is silent except for CRITICAL.
const fs = require('fs');

const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function ptClock(ms) {
  const o = {}; for (const p of PT_FMT.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { wd: o.weekday, min: (+o.hour % 24) * 60 + (+o.minute), date: `${o.year}-${o.month}-${o.day}` };
}
const SESSION_OPEN_MIN = 15 * 60;          // 15:00 PT: the CME session opens (TopstepX trading day starts)
const SESSION_CLOSE_MIN = 13 * 60 + 10;    // 13:10 PT: Topstep's flat-by time
const RESERVE_FROM_MIN = 13 * 60;          // 13:00 PT: the INFO reserve opens

// true from Sun 15:00 PT to Fri 13:10 PT, except 13:10-15:00 PT on every weekday
function statusPushWindow(ms) {
  const { wd, min } = ptClock(ms);
  if (wd === 'Sat') return false;
  if (wd === 'Sun') return min >= SESSION_OPEN_MIN;
  if (wd === 'Fri') return min < SESSION_CLOSE_MIN;
  return min < SESSION_CLOSE_MIN || min >= SESSION_OPEN_MIN;
}
// the weekend: Fri 13:10 PT -> Sun 15:00 PT
function weekendQuiet(ms) {
  const { wd, min } = ptClock(ms);
  return wd === 'Sat' || (wd === 'Sun' && min < SESSION_OPEN_MIN) || (wd === 'Fri' && min >= SESSION_CLOSE_MIN);
}

// F4 tiers. Every push with priority high/urgent (every error, guard, desync, reversal, unprotected, auth and session-close alert) is CRITICAL,
// and so is every fill / exit / stop-out / flatten / session-close note sent at default priority. Everything else is INFO
// (Signal, Crossed <level>, Status update, session started, pause notes, entry-cancelled notes, VIX back, reclaim).
const CRITICAL_PRIORITIES = new Set(['urgent', 'high', 'max', '5', '4']);
const CRITICAL_TITLE = /^(Entry filled|Target 1 hit|Target 2 hit|Leg2 stopped|Leg3 trailed out|Position closed|TP1 partly filled|Profit lock|Stopped out|Smart-hold|Exit|Exited|EXIT FAILED|Flatten|Session close|NOT FLAT|Daily floor|Trend position time-stop|Recovered position|Unknown position|UNPROTECTED|DESYNC|POSITION REVERSED|REVERSED|NO STOP|Stop|Old stop|Filled through|Big slip|BROKER AUTH|Executor crashed|\[PAPER\] leg)/;
function tierOf(title, priority) {
  if (CRITICAL_PRIORITIES.has(String(priority || 'default'))) return 'critical';
  return CRITICAL_TITLE.test(String(title || '')) ? 'critical' : 'info';
}

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

// F4 daily budget, counted on the UTC day. file = where the counts survive a restart (null = memory only).
function createNotifyBudget({ file = null, infoBudget = 150, reserveFrac = 0.30, log = () => {} } = {}) {
  const st = { day: null, critical: 0, info: 0, infoSuppressed: 0, quotaHitAt: null };
  const cap = () => (Number.isFinite(+infoBudget) && +infoBudget >= 0 ? Math.floor(+infoBudget) : 150);
  const frac = () => (Number.isFinite(+reserveFrac) && +reserveFrac >= 0 && +reserveFrac <= 1 ? +reserveFrac : 0.30);
  function load() {
    if (!file) return;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.day === 'string') Object.assign(st, { day: j.day, critical: +j.critical || 0, info: +j.info || 0, infoSuppressed: +j.infoSuppressed || 0, quotaHitAt: j.quotaHitAt ?? null }); } catch (e) { /* no file yet */ }
  }
  // the file is written on the next turn of the event loop (coalesced), never inside the caller: a push decided right before an order adds no file I/O there
  let saveQueued = false;
  function saveNow() { saveQueued = false; try { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, file); } catch (e) { /* counts stay in memory; never throws */ } }
  function save() { if (!file || saveQueued) return; saveQueued = true; setImmediate(saveNow); }
  function roll(now) { const d = utcDay(now); if (st.day !== d) { st.day = d; st.critical = 0; st.info = 0; st.infoSuppressed = 0; st.quotaHitAt = null; } }
  // the INFO cap in force right now: (1 - reserveFrac) x budget until 13:00 PT of this UTC day, the full budget after it
  function capNow(now) { const p = ptClock(now); const reserveOpen = p.date === utcDay(now) && p.min >= RESERVE_FROM_MIN; return reserveOpen ? cap() : Math.floor(cap() * (1 - frac())); }
  // -> { send, tier, why } and counts it. why: null | 'weekend' | 'budget' | 'quota'
  function decide(title, priority, now = Date.now()) {
    roll(now);
    const tier = tierOf(title, priority);
    let why = null;
    if (tier === 'critical') st.critical++;
    else if (weekendQuiet(now)) why = 'weekend';
    else if (st.quotaHitAt != null) why = 'quota';
    else if (st.info >= capNow(now)) why = 'budget';
    else st.info++;
    if (why) st.infoSuppressed++;
    save();
    return { send: !why, tier, why, info: st.info, cap: capNow(now), critical: st.critical };
  }
  // ntfy answered 429 / 42908 "daily message quota reached": no more INFO today (CRITICAL keeps trying)
  function noteQuota(now = Date.now()) { roll(now); if (st.quotaHitAt == null) { st.quotaHitAt = now; save(); log(`  [ntfy] daily quota reached (HTTP 429): INFO pushes are logged only until 00:00 UTC; CRITICAL pushes are still attempted.`); } }
  load();
  return { decide, noteQuota, capNow, state: st, view: now => { roll(now); return { day: st.day, critical: st.critical, info: st.info, infoSuppressed: st.infoSuppressed, infoCap: capNow(now), infoBudget: cap(), quotaHit: st.quotaHitAt != null }; } };
}

// F2: the key levels ('key' mode) and the decision for one cross
const KEY_LEVELS = new Set(['PWH', 'PWL', 'Week Open', 'PDH', 'PDL', '4H Open']);
function levelCrossMode(v) { return v === 'key' || v === 'all' ? v : 'off'; }   // anything else (false, null, typo) = 'off'
// -> { push, onCooldown, note } ; note = the suffix for the console LEVEL CROSS line
function levelCrossDecision({ mode, name, lastAlertTime = 0, now = Date.now(), cooldownMs = 5 * 60000, keyCooldownMs = 30 * 60000 }) {
  const m = levelCrossMode(mode);
  if (m === 'off') return { push: false, onCooldown: false, note: '  [log only: levelCrossPush off]' };
  if (m === 'key' && !KEY_LEVELS.has(name)) return { push: false, onCooldown: false, note: '  [log only: not a key level]' };
  const cd = m === 'key' ? keyCooldownMs : cooldownMs;
  const onCooldown = now - (lastAlertTime || 0) < cd;
  return { push: !onCooldown, onCooldown, note: onCooldown ? '  [phone push suppressed — chopping this level]' : '' };
}

// NTFY_TOKEN: only a plain printable token (no spaces / control characters) is used; anything else = auth off (a bad header value would throw)
function ntfyToken(v) { const t = typeof v === 'string' ? v.trim() : ''; return /^[\x21-\x7e]{1,512}$/.test(t) ? t : null; }

// F1: the Signal push key - one push per direction / path / entry / stop / 15m bar
function signalPushKey({ dir, path, entry, stop, now = Date.now() }) {
  const r = v => (Number.isFinite(+v) ? (+v).toFixed(2) : String(v));
  return `${dir}|${path || '-'}|${r(entry)}|${r(stop)}|${Math.floor(now / 900000)}`;
}

module.exports = { tierOf, createNotifyBudget, statusPushWindow, weekendQuiet, levelCrossDecision, levelCrossMode, KEY_LEVELS, ntfyToken, signalPushKey, ptClock, utcDay };
