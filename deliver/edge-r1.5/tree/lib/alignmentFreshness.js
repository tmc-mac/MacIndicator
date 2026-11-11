'use strict';
// ALIGNMENT FRESHNESS, read-age rule (Mac 10/19 option 2; r8 after MacDot's R7 review 6280077930). ONE pure evaluator used by both the
// producer (lib/levelsPro.js, the current decision bar only) and the consumer (lib/alignmentRuntime.js, every entry recheck).
// A slot is CURRENT only when ALL hold at the evaluation instant:
//   - its timeframe's bars and the chart (price) bars came from the SAME successful poll generation, and that generation is still the
//     executor's current valid one (a failed or in-progress refresh revokes every slot);
//   - both reads COMPLETED at most MAX_AGE_MS ago by the wall clock AND by the monotonic clock; a wall or monotonic time that runs
//     backwards past a read refuses (no revival after a clock regression);
//   - the slot's bar start and the chart bar start EQUAL the expected current period start (calendar mapping below), not just contain now;
//   - instrument, chart timeframe and finite open/price are present.
// Calendar mapping (documented; checked against the bot's own logged slots 10/19: H4 starts 02/06/10/14/18 UTC = 21/01/05/09/13 CDT):
//   M3/M5/M10/M15/M30/H1: UTC grid (now - now % duration); every US offset is a whole hour, so CME's 17:00 CT session open is on that grid.
//   H4: anchored to the CME session open, 17:00 America/Chicago = 15:00 America/Los_Angeles (both zones change DST on the same dates):
//       start = latest 15:00 PT at or before now, + k * 4 h.
// Session validity (r8.1, MacDot R8): outside the regular CME equity-futures week (Sun 15:00 PT - Fri 14:00 PT) and inside the daily break
// (14:00-15:00 PT) every slot is UNKNOWN (MARKET_CLOSED), so weekend and break bars can never be CURRENT and the H4 anchor is only computed
// inside an open session (no DST step can fall between the anchor and now: US DST changes Sunday 02:00, while the market is closed).
// NOT modeled: exchange holidays and shortened sessions. On a full holiday the provider returns no bar for the expected current period, so
// equality fails (UNKNOWN); a bar the provider did return on such a day is judged on the ordinary grid. This is a stated limit, not a guarantee.
const { ptInfo } = require('./helpers');
const TF_MS = Object.freeze({ M3: 180000, M5: 300000, M10: 600000, M15: 900000, M30: 1800000, H1: 3600000, H4: 14400000 });
const MAX_AGE_MS = 60000;
const POLICY = 'read-age-60s';
const isInt = Number.isSafeInteger;
const PT_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
function marketOpenAt(nowMs) {
  const wd = PT_WEEKDAY.format(new Date(nowMs)), m = ptInfo(nowMs).minutesOfDay;
  if (m >= 14 * 60 && m < 15 * 60) return false;        // daily maintenance break
  if (wd === 'Sat') return false;
  if (wd === 'Fri' && m >= 14 * 60) return false;        // weekly close
  if (wd === 'Sun' && m < 15 * 60) return false;         // weekly open 15:00 PT
  return true;
}
function sessionOpenMs(nowMs) {
  const m = ptInfo(nowMs).minutesOfDay, since = (m - 15 * 60 + 1440) % 1440;
  return nowMs - (nowMs % 60000) - since * 60000;
}
function expectedPeriodStart(tf, nowMs) {
  const d = TF_MS[tf];
  if (!d || !isInt(nowMs) || nowMs < 0) return null;
  if (tf !== 'H4') return nowMs - (nowMs % d);
  const open = sessionOpenMs(nowMs);
  return open + Math.floor((nowMs - open) / d) * d;
}
// Wall and monotonic elapsed time since a read must agree within this much; a wall clock stepped (back or forward) inside the 60 s window
// is refused as CLOCK_DIVERGENCE instead of trusted (r8.1, MacDot R8).
const CLOCK_DIVERGENCE_MS = 2000;
function readOk(r, gen, nowMs, monoNowMs, instrument) {
  if (!r || typeof r !== 'object' || !isInt(r.doneAt) || !Number.isFinite(r.mono) || r.gen !== gen) return 'READ_NOT_IN_CURRENT_POLL';
  if (r.instrument !== instrument) return 'INSTRUMENT_MISMATCH';
  if (r.doneAt > nowMs || r.mono > monoNowMs) return 'CLOCK_REGRESSION';
  if (Math.abs((nowMs - r.doneAt) - (monoNowMs - r.mono)) > CLOCK_DIVERGENCE_MS) return 'CLOCK_DIVERGENCE';
  if (nowMs - r.doneAt > MAX_AGE_MS || monoNowMs - r.mono > MAX_AGE_MS) return 'STALE_READ';
  return null;
}
// s: { timeframe, chartTf, instrument, open, price, barStart, priceBarStart, read, priceRead }; env: { nowMs, monoNowMs, currentGen, instrument }
function evaluateSlot(s, env) {
  const fail = code => ({ ok: false, code });
  if (!s || !env) return fail('MISSING_INPUT');
  if (!isInt(env.nowMs) || env.nowMs < 0 || !Number.isFinite(env.monoNowMs)) return fail('INVALID_EVALUATION_TIME');
  if (!isInt(env.currentGen)) return fail('NO_CURRENT_POLL');   // failed or in-progress refresh
  if (!TF_MS[s.timeframe] || !TF_MS[s.chartTf]) return fail('UNKNOWN_TIMEFRAME');
  if (typeof env.instrument !== 'string' || !env.instrument || s.instrument !== env.instrument) return fail('INSTRUMENT_MISMATCH');
  if (!Number.isFinite(s.open) || !Number.isFinite(s.price)) return fail('INVALID_PERIOD_OPEN_MEASUREMENT');
  if (!isInt(s.barStart) || !isInt(s.priceBarStart)) return fail('INVALID_BAR_START');
  if (!marketOpenAt(env.nowMs)) return fail('MARKET_CLOSED');
  const bad = readOk(s.read, env.currentGen, env.nowMs, env.monoNowMs, env.instrument) || readOk(s.priceRead, env.currentGen, env.nowMs, env.monoNowMs, env.instrument);
  if (bad) return fail(bad);
  if (s.barStart !== expectedPeriodStart(s.timeframe, env.nowMs) || s.priceBarStart !== expectedPeriodStart(s.chartTf, env.nowMs)) return fail('NOT_CURRENT_PERIOD');
  return { ok: true, code: 'READ_AGE_CURRENT' };
}
module.exports = { TF_MS, MAX_AGE_MS, POLICY, CLOCK_DIVERGENCE_MS, expectedPeriodStart, sessionOpenMs, marketOpenAt, evaluateSlot };
