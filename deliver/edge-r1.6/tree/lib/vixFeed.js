// FIX1015 (VIX gate): keeps the daily VIX closes that MAC Trap's VIX >= 32 hard block reads FRESH, and says how old they are.
// Before this, live-executor.js fetched VIX once at startup and never again, and a failed fetch silently turned the gate off.
//  - refreshed at startup, after every trading-day rollover (5pm CT), and hourly while CBOE has not yet published the newest close;
//  - a failed fetch KEEPS the last good closes (also across restarts, via a small cache file next to the journal), is logged, retried every 30 min, and
//    sends one phone alert per failure episode; with no data at all it alerts "VIX gate OFF (no data)" - it is never silent;
//  - view() feeds the checklist row (value, the date of the close, its age, when it was fetched, and the failure flag).
// Display + data freshness only: the gate itself (lib/macTrap.js) is unchanged and reads the same [{t, c}] list as before.
const fs = require('fs');
const { tradingDayKey } = require('./dailyRisk');

const DAY_MS = 86400000;
const RETRY_FAILED_MS = 30 * 60000;   // a failed fetch is retried every 30 min
const RETRY_BEHIND_MS = 60 * 60000;   // fetched fine but the newest close is not out yet: retry hourly
const STALE_WEEKDAYS = 2;             // newest close at least this many weekdays behind the expected one = stale (flagged)

// The date (UTC midnight, the same t the CBOE rows use) of the newest VIX close that should exist at `now`: today's (New York date) from 16:30 ET on a
// weekday, else the previous weekday. Exchange holidays are not known here; they only cause an hourly retry and a one-day "behind" note, never a flag.
function expectedCloseT(now) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const g = k => Number(p.find(x => x.type === k).value);
  let t = Date.UTC(g('year'), g('month') - 1, g('day'));
  const afterClose = g('hour') * 60 + g('minute') >= 16 * 60 + 30;
  const wd = d => new Date(d).getUTCDay();
  if (!(afterClose && wd(t) >= 1 && wd(t) <= 5)) { do { t -= DAY_MS; } while (wd(t) === 0 || wd(t) === 6); }
  return t;
}
function nyDateT(now) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const g = k => Number(p.find(x => x.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'));
}
function weekdaysBetween(fromT, toT) { let n = 0; for (let t = fromT + DAY_MS; t <= toT; t += DAY_MS) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; }

class VixFeed {
  constructor({ fetchFn, cacheFile = null, log = () => {}, notify = () => {}, days = 120, dayKeyFn = tradingDayKey }) {
    this.fetchFn = fetchFn; this.cacheFile = cacheFile; this.log = log; this.notify = notify; this.days = days; this.dayKeyFn = dayKeyFn;
    this.bars = []; this.fetchedAt = null; this.lastAttemptAt = null; this.lastError = null; this.okDayKey = null; this.alerted = false; this.fromCache = false;
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c && Array.isArray(c.bars) && c.bars.length) { this.bars = c.bars.filter(b => Number.isFinite(b.t) && Number.isFinite(b.c)); this.fetchedAt = c.fetchedAt || null; this.fromCache = true; }
    } catch (e) { this.log(`VIX cache unreadable (${e.message}) - ignoring it.`); }
  }

  async init(now = Date.now()) { this.loadCache(); await this.refresh('startup', now); return this.bars; }

  // true when a fetch is due: never fetched OK in this trading day, a failed fetch older than 30 min, or the newest close still missing (hourly).
  needsRefresh(now = Date.now()) {
    if (this.inFlight) return false;
    if (this.lastAttemptAt == null) return true;
    if (this.lastError) return now - this.lastAttemptAt >= RETRY_FAILED_MS;
    if (this.okDayKey !== this.dayKeyFn(now)) return true;
    const newest = this.bars.length ? this.bars[this.bars.length - 1].t : null;
    return (newest == null || newest < expectedCloseT(now)) && now - this.lastAttemptAt >= RETRY_BEHIND_MS;
  }

  async maybeRefresh(now = Date.now()) { if (!this.needsRefresh(now)) return false; await this.refresh('daily refresh', now); return true; }

  // Never throws. Returns true when fresh closes were stored.
  async refresh(reason, now = Date.now()) {
    this.lastAttemptAt = now; this.inFlight = true;
    try {
      const bars = await this.fetchFn(this.days);
      if (!Array.isArray(bars) || !bars.length) throw new Error('CBOE returned no VIX rows');
      this.bars = bars; this.fetchedAt = now; this.lastError = null; this.okDayKey = this.dayKeyFn(now); this.fromCache = false;
      const last = bars[bars.length - 1];
      this.log(`VIX ${reason}: ${bars.length} daily closes, newest ${new Date(last.t).toISOString().slice(0, 10)} = ${last.c}`);
      if (this.alerted) { this.alerted = false; this.notify('VIX data back', `The VIX refresh works again: newest close ${new Date(last.t).toISOString().slice(0, 10)} = ${last.c}. The VIX gate uses it.`, { tags: 'white_check_mark' }); }
      if (this.cacheFile) { try { const tmp = this.cacheFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: now, bars })); fs.renameSync(tmp, this.cacheFile); } catch (e) { this.log(`VIX cache write failed (non-fatal): ${e.message}`); } }
      return true;
    } catch (e) {
      this.lastError = e.message || String(e);
      const v = this.view(now);
      this.log(`VIX ${reason} FAILED (${this.lastError}) - ${this.bars.length ? `keeping the last value: ${v.value} (close of ${v.closeDate}, ${v.ageDays} day(s) old); the VIX gate stays ON with it` : 'NO VIX data at all: the VIX >= 32 gate cannot block anything until a fetch works'}. Retrying in 30 min.`);
      if (!this.alerted) {
        this.alerted = true;
        if (this.bars.length) this.notify('VIX refresh failed - using the last value', `Could not refresh VIX (${this.lastError}). The VIX gate keeps using the close of ${v.closeDate} (${v.value}, ${v.ageDays} day(s) old). Retrying every 30 min.`, { priority: 'high', tags: 'warning' });
        else this.notify('VIX gate OFF (no data)', `Could not fetch VIX (${this.lastError}) and no earlier value is saved, so the VIX >= 32 block cannot fire. Retrying every 30 min.`, { priority: 'urgent', tags: 'rotating_light' });
      }
      return false;
    } finally { this.inFlight = false; }
  }

  // For the checklist: { value, closeDate, ageDays, behindDays, fetchedAt, lastError, missing, stale, warn, text }
  view(now = Date.now()) {
    const last = this.bars.length ? this.bars[this.bars.length - 1] : null;
    if (!last) return { value: null, closeDate: null, ageDays: null, behindDays: null, fetchedAt: this.fetchedAt, lastError: this.lastError, missing: true, stale: true, warn: true, text: `NO VIX DATA: the VIX >= 32 gate is OFF${this.lastError ? ` (last fetch failed: ${this.lastError})` : ''}` };
    const closeDate = new Date(last.t).toISOString().slice(0, 10);
    const ageDays = Math.max(0, Math.round((nyDateT(now) - last.t) / DAY_MS));   // calendar days (New York date): 1 = yesterday's close
    const behindDays = weekdaysBetween(last.t, expectedCloseT(now));
    const stale = behindDays >= STALE_WEEKDAYS;
    const warn = !!this.lastError || stale;
    const mins = this.fetchedAt ? Math.max(0, Math.round((now - this.fetchedAt) / 60000)) : null;
    const fetched = mins != null ? `fetched ${mins < 120 ? mins + ' min' : Math.round(mins / 60) + ' h'} ago${this.fromCache ? ' (saved copy)' : ''}` : 'never fetched';
    let text = `VIX ${last.c} (close of ${closeDate}, ${ageDays} day${ageDays === 1 ? '' : 's'} old; ${fetched})`;
    if (this.lastError) text = `STALE: last refresh FAILED (${this.lastError}), using ${text}`;
    else if (stale) text = `STALE: ${behindDays} newer close(s) not received yet - ${text}`;
    else if (behindDays === 1) text += '; the newest close is not published yet';
    return { value: last.c, closeDate, ageDays, behindDays, fetchedAt: this.fetchedAt, lastError: this.lastError, missing: false, stale, warn, text };
  }
}

module.exports = { VixFeed, expectedCloseT };
