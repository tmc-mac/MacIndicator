// NEWS AWARENESS (2026-10-16, owner: "I want to trade the news; the bot just has to know when releases happen").
// Reads news-calendar.json from the bot folder: [{ t: ISO UTC, title, impact: 'high'|'medium', country: 'US', src? }].
// Optional refresh from a weekly ForexFactory-format feed (CONFIG.newsCalendarUrl), filtered to USD high/medium, written in the SAME format (atomic write).
// Never blocks trading: a missing/empty/unreadable calendar simply means "no known release" (logged once).
// All times are UTC instants; every display uses Intl with America/Los_Angeles (no hard-coded offsets, so DST on 11/01 is handled by the data).
const fs = require('fs');
const https = require('https');

// ROUND 4 (QA B3): a feed title is external text that reaches the phone page: strip markup characters, collapse spaces, cap the length.
const cleanTitle = s => String(s).replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

function normalize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e.title !== 'string') continue;
    const ms = Date.parse(e.t);
    if (!Number.isFinite(ms)) continue;
    const impact = String(e.impact || '').toLowerCase();
    if (impact !== 'high' && impact !== 'medium') continue;
    out.push({ t: new Date(ms).toISOString(), ms, title: cleanTitle(e.title), impact, country: e.country || 'US', ...(e.src ? { src: e.src } : {}) });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

// ForexFactory weekly JSON ([{ title, country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High'|'Medium'|'Low'|'Holiday', ... }]) -> our format.
function convertFF(ff) {
  if (!Array.isArray(ff)) throw new Error('feed is not a JSON array');
  const out = [];
  for (const e of ff) {
    if (!e || e.country !== 'USD') continue;
    const imp = String(e.impact || '').toLowerCase();
    if (imp !== 'high' && imp !== 'medium') continue;
    const ms = Date.parse(e.date);
    if (!Number.isFinite(ms) || typeof e.title !== 'string') continue;
    out.push({ t: new Date(ms).toISOString(), title: cleanTitle(e.title), impact: imp, country: 'US', src: 'forexfactory' });
  }
  return out;
}

function writeAtomic(file, list) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1) + '\n');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
}

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'mac-bot/1.0', Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let body = ''; res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 2e6) { req.destroy(new Error('response too large')); } });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('not JSON: ' + e.message)); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const fmtPt = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT';
const fmtPtDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
const shortTitle = t => String(t).split(' / ')[0];

class NewsCalendar {
  constructor({ file, log = () => {}, fetchJson = httpGetJson } = {}) {
    this.file = file; this.log = log; this.fetchJson = fetchJson;
    this.events = []; this.loadedAt = null; this.mtime = null; this.refreshedAt = null; this.lastError = null; this.loggedEmpty = false; this.loggedFail = false;
  }
  // (Re)load the file when it changed. Never throws.
  load() {
    try {
      if (!this.file || !fs.existsSync(this.file)) { this.events = []; if (!this.loggedEmpty) { this.loggedEmpty = true; this.log(`  [news] no news calendar (${this.file}) - the bot trades normally and does not know release times. Add news-calendar.json to enable news awareness.`); } return this.events; }
      const st = fs.statSync(this.file);
      if (this.mtime === st.mtimeMs) return this.events;
      this.events = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.mtime = st.mtimeMs; this.loadedAt = Date.now(); this.lastError = null;
      const hi = this.events.filter(e => e.impact === 'high');
      if (!this.events.length) { if (!this.loggedEmpty) { this.loggedEmpty = true; this.log('  [news] news calendar is EMPTY - the bot trades normally and does not know release times.'); } }
      else { this.loggedEmpty = false; this.log(`  [news] calendar loaded: ${this.events.length} US releases (${hi.length} high impact), ${this.events[0].t.slice(0, 10)} to ${this.events[this.events.length - 1].t.slice(0, 10)}.`); }
    } catch (e) {
      this.lastError = e.message;
      if (!this.loggedFail) { this.loggedFail = true; this.log(`  [news] calendar unreadable (${e.message}) - keeping the last good copy (${this.events.length} events); trading is not affected.`); }
    }
    return this.events;
  }
  // Refresh from the feed. On any failure the file is left exactly as it is (logged once per failure streak). Returns true when the file was rewritten.
  async refresh(url) {
    if (!url) return false;
    try {
      const list = convertFF(await this.fetchJson(url));
      if (!list.length) throw new Error('feed had no USD high/medium events');
      // keep events from the existing file that the weekly feed does not cover (e.g. the seed's later weeks)
      const have = this.load();
      const feedMs = list.map(e => Date.parse(e.t)), lo = Math.min(...feedMs) - 86400000, hi = Math.max(...feedMs) + 86400000;
      const merged = have.filter(e => e.ms < lo || e.ms > hi).map(({ ms, ...rest }) => rest).concat(list).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      writeAtomic(this.file, merged);
      this.loggedFail = false; this.mtime = null; this.load(); this.refreshedAt = Date.now();
      this.log(`  [news] calendar refreshed from the feed: ${list.length} USD high/medium releases this week.`);
      return true;
    } catch (e) {
      if (!this.loggedFail) { this.loggedFail = true; this.log(`  [news] calendar refresh failed (${e.message}) - keeping the last file (${this.events.length} events); trading is not affected.`); }
      return false;
    }
  }
  nextHigh(nowMs, impact = 'high') { return this.events.find(e => e.impact === impact && e.ms > nowMs) || null; }
  nextAny(nowMs) { return this.events.find(e => e.ms > nowMs) || null; }
  // nearest high-impact release (past or future), as signed minutes (negative = already happened), or null
  nearestHighMin(nowMs) {
    let best = null;
    for (const e of this.events) if (e.impact === 'high') { const d = (e.ms - nowMs) / 60000; if (best == null || Math.abs(d) < Math.abs(best)) best = d; }
    return best == null ? null : Math.round(best * 10) / 10;
  }
  // The high-impact release that resting entry orders must be pulled for right now: release within (now, now + sec]. null otherwise.
  restingBlock(nowMs, sec) {
    if (!(sec > 0)) return null;
    return this.events.find(e => e.impact === 'high' && e.ms > nowMs && e.ms - nowMs <= sec * 1000) || null;
  }
  // TRADE THE REACTION (10/16): after a HIGH-impact release no new entries until the first 15m bar that STARTS at or after the release has CLOSED, and never
  // sooner than minMs after it. Returns { title, ms, until } while waiting, else null. (Bars are UTC-aligned 15m bars, like the bot's own.)
  waitBlock(nowMs, minMs = 15 * 60000, barMs = 15 * 60000) {
    let best = null;
    for (const e of this.events) {
      if (e.impact !== 'high' || e.ms > nowMs) continue;
      const until = Math.max(Math.ceil(e.ms / barMs) * barMs + barMs, e.ms + (minMs || 0));
      if (nowMs < until && (!best || until > best.until)) best = { title: e.title, ms: e.ms, until };
    }
    return best;
  }
  // 10/16 phone "Upcoming news" panel: the next `days` days of releases (capped), plus where the calendar came from
  upcoming(nowMs, days = 7, cap = 40) {
    return this.events.filter(e => e.ms >= nowMs && e.ms < nowMs + days * 86400000).slice(0, cap).map(e => ({ t: e.ms, title: e.title, impact: e.impact }));
  }
  sourceInfo() {
    const ff = this.events.some(e => e.src === 'forexfactory');
    return { source: this.refreshedAt ? 'ForexFactory' : ff ? 'ForexFactory (saved file)' : this.events.length ? 'seed file' : null, refreshedAt: this.refreshedAt, fileAt: this.mtime || null };
  }
  // phone / checklist view of the next catalyst
  view(nowMs, sec, minMs) {
    const n = this.nextAny(nowMs), h = this.nextHigh(nowMs);
    const pick = h && (!n || h.ms - nowMs <= 6 * 3600000) ? h : n;
    const w = minMs === undefined ? null : this.waitBlock(nowMs, minMs);
    const wait = w ? { title: shortTitle(w.title), released: w.ms, until: w.until, text: `${shortTitle(w.title)} out ${fmtPt(w.ms).replace(' PT', '')} - waiting for the ${fmtPt(w.until).replace(' PT', '')} close` } : null;
    if (!pick) return { next: null, wait, text: this.events.length ? 'No more releases in the calendar' : 'No news calendar loaded', count: this.events.length };
    const mins = Math.max(0, Math.round((pick.ms - nowMs) / 60000));
    const sameDay = fmtPtDay(pick.ms) === fmtPtDay(nowMs) && pick.ms - nowMs < 86400000;
    const when = `${sameDay ? '' : fmtPtDay(pick.ms) + ' '}${fmtPt(pick.ms)}`;
    const inTxt = mins < 120 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
    return { next: { title: shortTitle(pick.title), fullTitle: pick.title, t: pick.ms, impact: pick.impact, when, minutes: mins }, wait, text: `${shortTitle(pick.title)} ${when} ${inTxt}`, count: this.events.length, cancelSec: sec };
  }
}

module.exports = { cleanTitle, NewsCalendar, convertFF, normalize, writeAtomic, fmtPt, shortTitle };
