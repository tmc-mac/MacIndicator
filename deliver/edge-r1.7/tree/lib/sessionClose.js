'use strict';
// SESSION CLOSE + SESSION FLAG COUNT (10/17 package). Pure helpers: no I/O, no broker, no clock of their own (the caller passes the time).
//
// 1. SESSION CLOSE (owner approved 10/14: "No need entries EOD, yes please").
//    Topstep (https://help.topstep.com/en/articles/8284206-when-and-what-products-can-i-trade, read 2026-10-14):
//      "All positions must be closed by 3:10 PM CT every weekday."  "Avoid opening new positions after 3:08 PM CT - Risk Managers begin flattening at that time."
//      "If you're trading a product with an earlier daily close than 3:10 PM CT, you must exit before that product's close."
//    3:10 PM CT = 13:10 PT. The CME equity halt is 14:00-15:00 PT; the next session opens at 15:00 PT.
//    Shipped: no NEW entries from sessionNoEntryFromPt (12:55 PT) until the 15:00 PT reopen; flatten at sessionFlattenPt (13:05 PT: 3 min before Topstep's risk desk starts at 3:08 PM CT = 13:08 PT; lead decision 10/14).
//    Every time is America/Los_Angeles wall-clock time computed through Intl, so the DST changes (11/01/2026, 03/14/2027) need nothing.
//
// 2. HOLIDAY EARLY CLOSES: CONFIG.sessionEarlyCloses = [{ date:'YYYY-MM-DD' (PT), flattenPt:'HH:MM', noEntryFromPt?:'HH:MM', note, source }].
//    SHIPPED EMPTY. The CME holiday calendar (cmegroup.com/trading-hours.html, /tools-information/holiday-calendar.html) could not be read
//    on 10/14 (HTTP 403/503 to this sandbox) and the third-party calendars disagree (Thanksgiving 12:00 vs 12:15 CT, which Mondays halt).
//    TODO (before 11/26/2026): verify each date on cmegroup.com and add it with  set-session.sh early <YYYY-MM-DD> <flatten HH:MM PT>.
//    Until then UNVERIFIED_EARLY_CLOSE_CANDIDATES below is used ONLY for a warning (log + one phone note): it never changes trading.
//
// 3. SESSION FLAG COUNT (owner request 10/14), display/logging only: MAC LONG/SHORT flags (fire-once grade A/B + retest held) on this timeframe
//    since the 15:00 PT session open, exactly like MAC Trap v4.2 (deliver/pine-2026-10-14/MAC_Trap_Machine_v4.2.txt, "SESSION FLAG COUNT"):
//      flag_td_key = dayofmonth(time + 9 * 3600000, "America/Los_Angeles"); count long_entry / short_entry; lead = sellers (S >= L + 2) | buyers | mixed.
//    lib/macTrap.js already computes longEntry / shortEntry per bar with the same fire-once rule (longEntryRaw && !previous longEntryRaw).

const TZ = 'America/Los_Angeles';
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ptParts(ts) {
  const o = {};
  for (const p of FMT.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, s: +o.second, wd: o.weekday, dateStr: `${o.year}-${o.month}-${o.day}` };
}
function hmToMin(s) { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? '' : s).trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function minToHm(n) { return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }
// offset of PT from UTC at instant ts (ms; -7 h in PDT, -8 h in PST)
function ptOffsetMs(ts) { const p = ptParts(ts); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000; }
// the UTC instant of PT wall-clock time `min` (minutes after midnight) on PT date dateStr. Two passes settle the offset on DST days.
function ptWallMs(dateStr, min) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  let t = wall - ptOffsetMs(wall); t = wall - ptOffsetMs(t);
  return t;
}
const REOPEN_MIN = 15 * 60;
const TOPSTEP_DEADLINE_MIN = 13 * 60 + 10;   // 3:10 PM CT = 13:10 PT   // CME reopens 15:00 PT (17:00 CT) after the daily halt
const DEFAULT_NOENTRY = '12:55', DEFAULT_FLATTEN = '13:05', EARLY_NOENTRY_LEAD_MIN = 13;   // an early-close day without noEntryFromPt stops entries 13 min before its flatten; this lead is used on an early-close day without noEntryFromPt

// UNVERIFIED (third-party calendars only, they disagree with each other). Used for a WARNING, never for trading. Verify on cmegroup.com and add with set-session.sh early.
const UNVERIFIED_EARLY_CLOSE_CANDIDATES = {
  '2026-11-26': 'Thanksgiving (CME equity halt ~12:00 CT reported)',
  '2026-11-27': 'day after Thanksgiving (early close 12:00 or 12:15 CT reported)',
  '2026-12-24': 'Christmas Eve (early close 12:15 CT reported)',
  '2027-01-18': 'Martin Luther King Jr. Day (Monday halt ~12:00 CT reported)',
  '2027-02-15': 'Presidents Day (Monday halt ~12:00 CT reported)',
  '2027-05-31': 'Memorial Day (check)',
  '2027-06-18': 'Juneteenth observed (check)',
  '2027-07-05': 'Independence Day observed (check)',
  '2027-09-06': 'Labor Day (check)',
  '2027-11-25': 'Thanksgiving (check)',
  '2027-11-26': 'day after Thanksgiving (check)',
  '2027-12-24': 'Christmas observed (check)',
  '2027-12-31': 'New Year observed (check)',
};

// Problems with ONE early-close entry ([] = fine). maxFlattenMin: an early flatten may not be later than the normal flatten (round 3, QA R2-2: a typo such as 13:20,
// or a CT time typed as PT, would otherwise flatten AFTER Topstep's cutoff) and never at or after 13:10 PT. seen: dates already accepted (a repeated date is refused).
function earlyEntryProblems(e, at, maxFlattenMin, seen) {
  const out = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [`${at} must be an object { "date": "YYYY-MM-DD", "flattenPt": "HH:MM" }`];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) || Number.isNaN(Date.parse(e.date + 'T12:00:00Z'))) out.push(`${at}.date must be "YYYY-MM-DD" (PT date), got ${JSON.stringify(e.date)}`);
  else if (seen && seen.has(e.date)) out.push(`${at}.date ${e.date} is listed twice (the first one is used)`);
  const f = hmToMin(e.flattenPt), n = e.noEntryFromPt == null ? (f == null ? null : f - EARLY_NOENTRY_LEAD_MIN) : hmToMin(e.noEntryFromPt);
  const maxF = Math.min(Number.isFinite(maxFlattenMin) ? maxFlattenMin : TOPSTEP_DEADLINE_MIN - 1, TOPSTEP_DEADLINE_MIN - 1);
  if (f == null) out.push(`${at}.flattenPt must be "HH:MM" PT, got ${JSON.stringify(e.flattenPt)}`);
  else if (f < 60) out.push(`${at}.flattenPt ${e.flattenPt} is before 01:00 PT`);
  else if (f > maxF) out.push(`${at}.flattenPt ${e.flattenPt} is later than the normal flatten ${minToHm(maxF)} PT (an early close must flatten EARLIER; a CT time typed as PT?)`);
  if (e.noEntryFromPt != null && n == null) out.push(`${at}.noEntryFromPt must be "HH:MM" PT, got ${JSON.stringify(e.noEntryFromPt)}`);
  if (f != null && n != null && n >= f) out.push(`${at}: noEntryFromPt ${minToHm(n)} must be before flattenPt ${e.flattenPt}`);
  return out;
}
// Splits a list into the valid entries (used) and the invalid ones (skipped, each with its problems). ONE bad entry never disables the others (QA R2-2).
function splitEarlyCloses(list, normalFlattenPt) {
  const good = [], bad = [];
  if (list == null) return { good, bad };
  if (!Array.isArray(list)) return { good, bad: [{ index: null, date: null, problems: ['sessionEarlyCloses must be a list [ ... ]'] }] };
  const maxF = hmToMin(normalFlattenPt) ?? hmToMin(DEFAULT_FLATTEN), seen = new Set();
  list.forEach((e, i) => { const p = earlyEntryProblems(e, `sessionEarlyCloses[${i}]`, maxF, seen); if (p.length) bad.push({ index: i, date: e && e.date ? String(e.date) : null, problems: p }); else { good.push(e); seen.add(e.date); } });
  return { good, bad };
}
// Problems with an early-close list (flat list of texts; [] = fine). normalFlattenPt: the normal flatten time (default the shipped 13:05).
function validateEarlyCloses(list, normalFlattenPt) { return splitEarlyCloses(list, normalFlattenPt).bad.flatMap(b => b.problems); }
// Problems with the main times (empty = fine). An invalid setting falls back to the shipped 12:55 / 13:05 (never to "no session close").
function validateSessionTimes(cfg) {
  const out = [], n = hmToMin(cfg.sessionNoEntryFromPt), f = hmToMin(cfg.sessionFlattenPt);
  if (n == null) out.push(`sessionNoEntryFromPt must be "HH:MM" PT, got ${JSON.stringify(cfg.sessionNoEntryFromPt)}`);
  if (f == null) out.push(`sessionFlattenPt must be "HH:MM" PT, got ${JSON.stringify(cfg.sessionFlattenPt)}`);
  if (n != null && f != null) {
    if (n > f) out.push(`sessionNoEntryFromPt ${cfg.sessionNoEntryFromPt} is after sessionFlattenPt ${cfg.sessionFlattenPt}`);
    if (f >= 13 * 60 + 10) out.push(`sessionFlattenPt ${cfg.sessionFlattenPt} is not before Topstep's 13:10 PT (3:10 PM CT) deadline`);
    if (n < 6 * 60 + 30) out.push(`sessionNoEntryFromPt ${cfg.sessionNoEntryFromPt} is before the NY open (06:30 PT)`);
  }
  return out;
}

// The session-close state at instant ts. { on:false } when CONFIG.sessionClose is off. Weekdays only (Mon-Fri PT); the window ends at the 15:00 PT reopen.
function sessionCloseState(ts, cfg = {}) {
  if (!cfg || !cfg.sessionClose) return { on: false };
  const p = ptParts(ts), weekday = p.wd !== 'Sat' && p.wd !== 'Sun';
  const timesOk = validateSessionTimes(cfg).length === 0;
  const early = splitEarlyCloses(cfg.sessionEarlyCloses, timesOk ? cfg.sessionFlattenPt : DEFAULT_FLATTEN).good.find(e => e.date === p.dateStr) || null;   // round 3: invalid entries are skipped one by one
  let noEntryMin, flattenMin;
  if (early) { flattenMin = hmToMin(early.flattenPt); noEntryMin = early.noEntryFromPt != null ? hmToMin(early.noEntryFromPt) : flattenMin - EARLY_NOENTRY_LEAD_MIN; }
  else { noEntryMin = hmToMin(timesOk ? cfg.sessionNoEntryFromPt : DEFAULT_NOENTRY); flattenMin = hmToMin(timesOk ? cfg.sessionFlattenPt : DEFAULT_FLATTEN); }
  const noEntryFrom = ptWallMs(p.dateStr, noEntryMin), flattenAt = ptWallMs(p.dateStr, flattenMin), reopenAt = ptWallMs(p.dateStr, REOPEN_MIN);
  const alertSec = Number.isFinite(cfg.sessionFlattenAlertSec) && cfg.sessionFlattenAlertSec >= 0 ? cfg.sessionFlattenAlertSec : 90;
  const alertAt = flattenAt + alertSec * 1000;
  const inDay = weekday && ts < reopenAt;
  const noEntry = inDay && ts >= noEntryFrom, flattenDue = inDay && ts >= flattenAt, alertDue = inDay && ts >= alertAt;
  return {
    on: true, date: p.dateStr, weekday, noEntry, flattenDue, alertDue,
    noEntryFrom, flattenAt, alertAt, reopenAt,
    noEntryPt: minToHm(noEntryMin), flattenPt: minToHm(flattenMin), reopenPt: '15:00',
    early: early ? { date: early.date, flattenPt: early.flattenPt, noEntryFromPt: minToHm(noEntryMin), note: early.note || null } : null,
    candidate: !early && UNVERIFIED_EARLY_CLOSE_CANDIDATES[p.dateStr] ? UNVERIFIED_EARLY_CLOSE_CANDIDATES[p.dateStr] : null,
    invalid: !timesOk && !early ? validateSessionTimes(cfg) : null,
    phase: !weekday ? 'weekend' : flattenDue ? 'flat' : noEntry ? 'noEntry' : 'open',
  };
}
// One line for logs / journal / the checklist.
function sessionCloseText(st) {
  if (!st || !st.on) return 'Session close: off';
  const e = st.early ? ` (early close ${st.early.date}${st.early.note ? ': ' + st.early.note : ''})` : '';
  if (st.phase === 'flat') return `Session close${e}: flat by ${st.flattenPt} PT; no new entries until the ${st.reopenPt} PT reopen`;
  if (st.phase === 'noEntry') return `Session close${e}: no new entries ${st.noEntryPt}-${st.reopenPt} PT; flat by ${st.flattenPt} PT`;
  return `Session close${e}: no entries ${st.noEntryPt}-${st.reopenPt} PT, flat by ${st.flattenPt}`;
}

// ── SESSION FLAG COUNT ──
// The Pine trading-day key: the calendar day of (bar open time + 9 h) in PT, so the day starts at the 15:00 PT session open.
function flagDayKey(t) { return ptParts(t + 9 * 3600000).dateStr; }
// out = lib/macTrap.js evaluateMacTrap() output (one row per bar, oldest first, with t / longEntry / shortEntry). Counts the rows of the LAST row's trading day.
// Returns null (no data) or { long, short, lead, text, since, bars, partial } - partial = the bar history starts inside the session (the count may be short).
function sessionFlagCount(out) {
  if (!Array.isArray(out) || !out.length) return null;
  const last = out[out.length - 1]; if (!last || !Number.isFinite(last.t)) return null;
  const key = flagDayKey(last.t);
  let long = 0, short = 0, since = last.t, bars = 0, partial = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]; if (!r || !Number.isFinite(r.t) || flagDayKey(r.t) !== key) break;
    if (i === 0) partial = true;
    if (r.longEntry) long++;
    if (r.shortEntry) short++;
    since = r.t; bars++;
  }
  const lead = short >= long + 2 ? 'sellers' : long >= short + 2 ? 'buyers' : 'mixed';
  return { long, short, lead, text: `S ${short} · L ${long} · ${lead}`, since, bars, partial };
}
const FLAG_COLORS = { sellers: '#EF4444', buyers: '#22C55E', mixed: '#94A3B8' };   // MAC Trap v4.2 col_bear / col_bull / col_neutral

module.exports = { ptParts, hmToMin, minToHm, ptWallMs, sessionCloseState, sessionCloseText, validateEarlyCloses, splitEarlyCloses, validateSessionTimes, sessionFlagCount, flagDayKey, FLAG_COLORS, UNVERIFIED_EARLY_CLOSE_CANDIDATES, REOPEN_MIN };
