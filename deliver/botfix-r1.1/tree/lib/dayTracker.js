'use strict';
// DISPLAY-ONLY day tracker (dashfix, 2026-10-13). Nothing in here is read by any trading, risk or order decision.
//  - Rolling P&L that ties to TopstepX: rolling = (account balance now - account balance at the start of the trading day) + open P&L.
//  - Day peak (max of rolling during the day) and "given back" (peak - rolling now). Persisted to a small state file.
//  - Wall-clock trading-day rollover at 5:00 PM CT (= 3:00 PM PT, year round), DST-safe, independent of 1m bars.
//  - Market-closed state (daily 4-5 PM CT break = 2-3 PM PT, and the weekend) for the "Session closed" label.
// Pure functions + a small stateful tracker. The clock is always passed in (nowMs), so tests can use a fake clock.
const fs = require('fs');
const path = require('path');
const { tradingDayKey } = require('./dailyRisk');

const FEE_PER_CONTRACT_SIDE = 0.36;       // TopstepX MNQ fee: $0.36 per contract per side; plus a $0.25 commission per contract per side ($6.10 per 5-lot round trip in all)
const COMMISSION_PER_CONTRACT_SIDE = 0.25;
const HOUR_MS = 3600000;
const CROSSCHECK_TOLERANCE = 5;           // dollars: fill-sum vs balance difference above this logs a warning
const CROSSCHECK_WARN_EVERY_MS = 10 * 60 * 1000;
const STATE_VERSION = 1;

function chicagoParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { wd: o.weekday, h: parseInt(o.hour, 10) % 24, m: parseInt(o.minute, 10) };
}

// 'daily' = the Mon-Thu 4-5 PM CT (2-3 PM PT) break; 'weekend' = Fri 4 PM CT until Sun 5 PM CT; null = market open.
function marketClosedKind(ms) {
  const { wd, h } = chicagoParts(ms);
  if ((wd === 'Fri' && h >= 16) || wd === 'Sat' || (wd === 'Sun' && h < 17)) return 'weekend';
  if (h === 16 && (wd === 'Mon' || wd === 'Tue' || wd === 'Wed' || wd === 'Thu')) return 'daily';
  return null;
}
// The trading day does not roll over the weekend (Fri 5 PM CT .. Sun 5 PM CT): Friday's final result stays on screen until Sunday 5 PM CT.
function inWeekendFreeze(ms) {
  const { wd, h } = chicagoParts(ms);
  return (wd === 'Fri' && h >= 17) || wd === 'Sat' || (wd === 'Sun' && h < 17);
}
// Trading-day key (start of the day in ms, from lib/dailyRisk.tradingDayKey) by WALL CLOCK, with the weekend frozen on Friday's day.
function effectiveDayKey(ms) {
  let t = ms, guard = 0;
  while (inWeekendFreeze(t) && guard++ < 60) t -= HOUR_MS;
  return tradingDayKey(t);
}
// The next 5 PM CT after ms (DST-safe: scans forward by the hour, then trims to the day key of the following session).
function nextRolloverMs(ms) {
  let t = ms, guard = 0;
  const k = effectiveDayKey(ms);
  while (effectiveDayKey(t) === k && guard++ < 24 * 5) t += HOUR_MS;
  // t is now inside the new day; walk back to the exact boundary by minutes
  let lo = t - HOUR_MS, hi = t;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (effectiveDayKey(mid) === k) lo = mid; else hi = mid; }
  return hi;
}
function round2(v) { return Math.round(v * 100) / 100; }

function sessionLabel(kind) {
  if (kind === 'daily') return 'Session closed · resets 3:00 PM PT';
  if (kind === 'weekend') return 'Market closed · resets Sun 3:00 PM PT';
  return null;
}

function createDayTracker({ file, log = () => {}, fsImpl = fs } = {}) {
  let s = { v: STATE_VERSION, dayKey: null, startBalance: null, startSource: null, startedAt: null, peak: 0, peakAt: null };
  let prevSample = null;       // { phase, balance } of the previous sample: a peak is only taken from a stable reading (see sample())
  let dirty = false;
  let lastWarnAt = 0;
  let lastRolloverTry = 0;
  let prevObs = null, pendingJump = null; // observe(): non-trading balance jump detection

  function persist() {
    if (!file) { dirty = false; return; }
    try {
      const tmp = file + '.tmp';
      fsImpl.writeFileSync(tmp, JSON.stringify(s));
      fsImpl.renameSync(tmp, file);
      dirty = false;
    } catch (e) { log('  [day-tracker] could not save ' + path.basename(file) + ' (non-fatal): ' + e.message); }
  }
  function validState(o) {
    return o && typeof o === 'object' && o.v === STATE_VERSION && Number.isFinite(o.dayKey)
      && (o.startBalance === null || Number.isFinite(o.startBalance)) && Number.isFinite(o.peak);
  }
  // Start-up: read the state file. If it belongs to today's trading day it is kept (start balance AND peak survive a restart);
  // any other day (or a missing/corrupt file) starts today with an unknown start balance, filled in by ensureStart().
  function load(nowMs) {
    const key = effectiveDayKey(nowMs);
    let loaded = null;
    if (file) {
      try { loaded = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
      catch (e) { if (e && e.code !== 'ENOENT') log('  [day-tracker] state file unreadable, starting fresh: ' + e.message); }
    }
    if (validState(loaded) && loaded.dayKey === key) {
      s = { v: STATE_VERSION, dayKey: loaded.dayKey, startBalance: loaded.startBalance, startSource: loaded.startSource || 'file', startedAt: loaded.startedAt || null, peak: loaded.peak, peakAt: loaded.peakAt || null };
      log(`  [day-tracker] restored day ${new Date(key).toISOString()}: start balance ${s.startBalance == null ? 'unknown' : '$' + s.startBalance.toFixed(2)}, peak $${s.peak.toFixed(2)}`);
      return 'restored';
    }
    s = { v: STATE_VERSION, dayKey: key, startBalance: null, startSource: null, startedAt: null, peak: 0, peakAt: null };
    dirty = true;
    return loaded ? 'new-day' : 'fresh';
  }
  // No start balance yet (fresh install / restart on a new day): estimate it as balance - realized so far today (the fill-sum), once.
  function ensureStart({ balance, realizedEstimate, nowMs }) {
    if (s.startBalance != null || balance == null || realizedEstimate == null) return false;
    s.startBalance = round2(balance - realizedEstimate);
    s.startSource = 'estimated-from-fills';
    s.startedAt = nowMs || null;
    persist();
    log(`  [day-tracker] start-of-day balance ESTIMATED $${s.startBalance.toFixed(2)} (balance $${balance.toFixed(2)} - realized today $${realizedEstimate.toFixed(2)}); exact from the next 3:00 PM PT rollover`);
    return true;
  }
  function needsRollover(nowMs) { return s.dayKey != null && effectiveDayKey(nowMs) !== s.dayKey; }
  // Throttle for the caller's balance read at rollover (retry at most every 10 s if the broker read fails).
  function mayTryRollover(nowMs) { if (nowMs - lastRolloverTry < 10000) return false; lastRolloverTry = nowMs; return true; }
  // Wall-clock rollover: snapshot the balance NOW as the new day's start balance. Nothing trades in the minutes around the 5 PM CT open
  // (Asia blackout 15:00-17:00 PT), so the balance read now is the closing balance of the day that just ended.
  function rollover(nowMs, balance) {
    const old = { dayKey: s.dayKey, startBalance: s.startBalance, peak: s.peak };
    s = { v: STATE_VERSION, dayKey: effectiveDayKey(nowMs), startBalance: round2(balance), startSource: 'rollover', startedAt: nowMs, peak: 0, peakAt: null };
    prevSample = null;
    persist();
    return old;
  }
  // One sample (call it every fast poll, ~3 s, with the freshest cached balance and open P&L). Returns the rolling P&L or null.
  // The peak only moves on a STABLE reading: the same position phase and the same balance as the previous sample. Right after a fill the
  // balance (read over HTTP) and the open-size (from the state machine) can disagree for a poll or two, which would count the realized
  // part twice for a moment; such transitional readings never become the peak.
  function sample(nowMs, { balance, openPnl, phase }) {
    if (s.startBalance == null || balance == null) return null;
    const rolling = round2(balance - s.startBalance + (openPnl || 0));
    const stable = prevSample && prevSample.phase === phase && prevSample.balance === balance;
    prevSample = { phase, balance };
    if (stable && rolling > s.peak) { s.peak = rolling; s.peakAt = nowMs; persist(); }
    return rolling;
  }
  function view(nowMs, { balance, openPnl }) {
    const kind = marketClosedKind(nowMs);
    const known = s.startBalance != null && balance != null;
    const realized = known ? round2(balance - s.startBalance) : null;
    const rolling = known ? round2(realized + (openPnl || 0)) : null;
    const peak = s.peak; // starts at 0 (the day starts at 0), only moves up on a stable reading
    return {
      dayKey: s.dayKey, startBalance: s.startBalance, startSource: s.startSource, balance: balance == null ? null : balance,
      realized, openPnl: round2(openPnl || 0), rolling,
      peak: round2(peak), peakAt: s.peakAt, givenBack: rolling == null ? null : (peak > 0 ? round2(Math.max(0, peak - rolling)) : 0), // nothing to give back until the day has been in profit
      sessionClosed: kind, sessionLabel: sessionLabel(kind), resetsAtMs: kind ? nextRolloverMs(nowMs) : null,
    };
  }
  // Non-trading balance changes (payout, account reset, correction): while FLAT, the balance moves by more than $5 but the broker fills do not move at all.
  // Called once per 20 s refresh with the fresh balance and fill-sum. A candidate must repeat unchanged on the NEXT refresh (a trade that closed between the
  // two broker reads shows up in the fills a refresh later and cancels the candidate). Confirmed: start balance is shifted by the jump and the peak is put
  // back to what it was before the jump, so Rolling P&L, Day peak and Given back keep meaning "trading result of the day". Returns {delta} or null.
  function observe(nowMs, { balance, fillSum, flat }) {
    if (!flat || balance == null || fillSum == null || s.startBalance == null) { prevObs = null; pendingJump = null; return null; }
    const cur = { balance, fillSum, peak: s.peak };
    let out = null;
    if (pendingJump) {
      if (Math.abs(balance - pendingJump.balance) < 0.005 && Math.abs(fillSum - pendingJump.fillSum) < 0.005) {
        s.startBalance = round2(s.startBalance + pendingJump.delta);
        s.peak = Math.min(s.peak, pendingJump.peakBefore);
        s.startSource = 'rebased';
        persist();
        out = { delta: round2(pendingJump.delta) };
        pendingJump = null; prevObs = { ...cur, peak: s.peak };
        return out;
      }
      pendingJump = null;
    }
    if (prevObs && Math.abs(fillSum - prevObs.fillSum) < 0.005 && Math.abs(balance - prevObs.balance) > CROSSCHECK_TOLERANCE) {
      pendingJump = { balance, fillSum, delta: round2(balance - prevObs.balance), peakBefore: prevObs.peak };
    }
    prevObs = cur;
    return null;
  }
  // Cross-check of the old fill-sum figure against the account: realized by balance vs realized by fills (pure, no side effects). The open
  // position's entry fees are already in the balance but not in the closed fill-sum (about $2 for 5 lots), well inside the tolerance.
  function crossCheck(fillSumRealized, balance) {
    if (s.startBalance == null || balance == null || fillSumRealized == null) return null;
    const byBalance = round2(balance - s.startBalance);
    const diff = round2(byBalance - fillSumRealized);
    return { fillSum: fillSumRealized, byBalance, diff, ok: Math.abs(diff) <= CROSSCHECK_TOLERANCE };
  }
  // true at most once per 10 minutes while the cross-check is outside the tolerance (for the log warning)
  function shouldWarn(nowMs, cc) {
    if (!cc || cc.ok || nowMs - lastWarnAt < CROSSCHECK_WARN_EVERY_MS) return false;
    lastWarnAt = nowMs; return true;
  }
  return { load, ensureStart, needsRollover, mayTryRollover, rollover, sample, view, crossCheck, shouldWarn, observe, get state() { return { ...s }; }, get dirty() { return dirty; }, flush: persist };
}

module.exports = { createDayTracker, effectiveDayKey, marketClosedKind, inWeekendFreeze, nextRolloverMs, sessionLabel, FEE_PER_CONTRACT_SIDE, CROSSCHECK_TOLERANCE };
