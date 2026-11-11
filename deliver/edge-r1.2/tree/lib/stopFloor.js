'use strict';
// ENTRY STOP FLOOR (Mac 10/21: 6309102502, 6309188306, 6309508924, 6309831067; priority order 6330144245). Pure, no I/O, no requires.
// Every initial entry's protective stop is at least the session floor from the entry: Asia 30 / London 30 / NY 50 / late 30 points.
// A tighter natural stop (capped 0.5-ATR on the MAC paths, the structural stop on Levels / reclaim / wave / reversal) is moved OUT to the floor, never skipped;
// a wider natural stop is kept. Applied twice: at the signal from the planned entry (so sizing and the 6.1 fill thresholds see the floored distance), and again from
// the ACTUAL fill once it is observed (fill-relative). Entry-only: the recovery / adoption stop (stopCapDollarsPerContract x recoveryStopMultiple) never reads it.
// Later breakeven / trail / profit-lock moves still tighten from here; nothing in this file runs after the initial protection.
const VERSION = 'entry-stop-floor-v1';
const SESSIONS = ['asia', 'london', 'ny', 'late'];

// PT minutes of day -> floor session. Explicit boundaries (sessionKeyOf is not used: it maps 13:00-15:00 to 'ny').
//   london 00:00-06:30, ny 06:30-13:00, late 13:00-15:00, asia 15:00-24:00. A fill at or after 06:30 is NY whenever the order was sent (6309831067).
function sessionOf(minutesOfDay) {
  if (!Number.isFinite(minutesOfDay) || minutesOfDay < 0 || minutesOfDay >= 1440) return null;
  if (minutesOfDay < 390) return 'london';
  if (minutesOfDay < 780) return 'ny';
  if (minutesOfDay < 900) return 'late';
  return 'asia';
}

// Startup check. Returns a list of problems (empty = usable). enabled false = no floor anywhere (the r9.16.1 stops).
function validate(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['entryStopFloor must be an object'];
  if (typeof cfg.enabled !== 'boolean') errs.push('entryStopFloor.enabled must be true or false');
  for (const s of SESSIONS) if (!(Number.isFinite(cfg[s]) && cfg[s] > 0 && cfg[s] <= 200)) errs.push(`entryStopFloor.${s} must be a number of points above 0 and at most 200, got ${JSON.stringify(cfg[s])}`);
  return errs;
}

function floorPtsFor(session, cfg) {
  if (!cfg || cfg.enabled !== true || !SESSIONS.includes(session)) return null;
  const v = cfg[session];
  return Number.isFinite(v) && v > 0 ? v : null;
}

// minutesFn(ts) -> PT minutes of day (DST-aware, from the executor's ptInfo).
function floorAt(ts, cfg, minutesFn) {
  const session = sessionOf(minutesFn(ts));
  return { session, pts: floorPtsFor(session, cfg) };
}

// Largest floor over every instant an order sent at fromTs can fill (fromTs .. toTs). Session boundaries are whole PT minutes, so a one-minute walk plus both
// ends sees every session the window touches. Used for SIZING and the planned stop, so a resting order that fills after 06:30 was already sized for 50.
function floorOverWindow(fromTs, toTs, cfg, minutesFn) {
  let best = floorAt(fromTs, cfg, minutesFn), seen = [best.session];
  const end = Number.isFinite(toTs) && toTs > fromTs ? Math.min(toTs, fromTs + 86400000) : fromTs;
  const take = t => { const f = floorAt(t, cfg, minutesFn); if (!seen.includes(f.session)) seen.push(f.session); if (f.pts != null && (best.pts == null || f.pts > best.pts)) best = f; };
  for (let t = fromTs + 60000; t < end; t += 60000) take(t);
  take(end);
  return { session: best.session, pts: best.pts, sessions: seen };
}

const r2 = x => Math.round(x * 100) / 100;
// The floor itself. LONG stop = min(natural, entry - floor); SHORT stop = max(natural, entry + floor). The floor price is rounded OUTWARD to the tick, so the
// final distance is never under the floor even when the entry (an average fill) is off the tick. A natural stop that is already wider stays (rounded to the
// nearest tick, which can never land inside the floor price because that price is itself on the tick).
function applyFloor({ dir, entry, stop, floorPts, tickSize }) {
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.25;
  const valid = (dir === 1 || dir === -1) && Number.isFinite(entry) && Number.isFinite(stop) && (dir === 1 ? stop < entry : stop > entry);
  const naturalPts = Number.isFinite(entry) && Number.isFinite(stop) ? r2(Math.abs(entry - stop)) : null;
  if (!valid || !(Number.isFinite(floorPts) && floorPts > 0)) return { stop, floored: false, naturalPts, floorPts: Number.isFinite(floorPts) ? floorPts : null, finalPts: naturalPts, valid };
  const nearest = Math.round(stop / tick) * tick;
  const floorPrice = dir === 1 ? Math.floor((entry - floorPts) / tick + 1e-9) * tick : Math.ceil((entry + floorPts) / tick - 1e-9) * tick;
  const out = dir === 1 ? Math.min(nearest, floorPrice) : Math.max(nearest, floorPrice);
  const floored = dir === 1 ? floorPrice < nearest : floorPrice > nearest;
  return { stop: r2(out), floored, naturalPts, floorPts, finalPts: r2(Math.abs(entry - out)), valid };
}

// 6.1 REVISED (the post-fill stop). slip = pendingRules.fillSlipDecision() on the FLOORED planned stop, so its threshold is max(4, 0.25 x floored distance):
// 7.5 at 30, 12.5 at 50. 'exit' is never overridden (filled through the stop = stopped out). 'shift' moves the plan's stop with the fill (distance kept).
// 'keep' (a favourable fill beyond the threshold) keeps the plan's stop, which is now CLOSER to the fill - so the floor is applied again from the actual fill.
// Both branches end with the fill-relative floor. plannedStop is the plan's stop BEFORE any shift (callers keep it, so a retry never shifts twice).
function postFillStop({ dir, intended, fill, plannedStop, slip, floorPts, tickSize }) {
  if (!slip || slip.action === 'exit') return { action: 'exit', stop: plannedStop, natural: plannedStop, floor: null };
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.25;
  const natural = slip.action === 'shift' ? Math.round((plannedStop + (fill - intended)) / tick) * tick : plannedStop;
  const floor = applyFloor({ dir, entry: fill, stop: natural, floorPts, tickSize: tick });
  return { action: slip.action, stop: floor.valid ? floor.stop : natural, natural: r2(natural), floor };
}

module.exports = { VERSION, SESSIONS, sessionOf, validate, floorPtsFor, floorAt, floorOverWindow, applyFloor, postFillStop };
