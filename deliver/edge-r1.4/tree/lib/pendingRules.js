// 10/16 package: pure entry-order rules shared by LIVE (lib/liveStateMachine.js) and PAPER (live-executor.js resolvePaperPending). No I/O, no requires.
// PENDING STOP-TOUCH (2026-10-16, owner: an unfilled far-away entry whose setup is already broken must not keep resting). Pure, no I/O, shared by LIVE (this file)
// and PAPER (live-executor.js resolvePaperPending). Has price traded at or beyond the planned stop since the entry order was placed?
//   dir 1 (long): the stop is below, touched when a price <= stop; dir -1 (short): the stop is above, touched when a price >= stop.
//   bars: 1-minute bars {t (bar start ms), h, l, c}. A bar that STARTED at/after sinceTs counts with its high/low; the bar that contains sinceTs counts with its
//   close only (its high/low may come from before the order existed); bars that ended before sinceTs are ignored. sinceTs null = closes only.
// Returns null, or { price, t } = the touching price and the bar time.
function pendingStopTouch(dir, stopPrice, bars, sinceTs, barMs = 60000) {
  if ((dir !== 1 && dir !== -1) || !Number.isFinite(stopPrice) || !Array.isArray(bars)) return null;
  for (const b of bars) {
    if (!b || !Number.isFinite(b.t)) continue;
    let px = null;
    if (sinceTs != null && b.t >= sinceTs) px = dir === 1 ? b.l : b.h;
    else if (sinceTs == null || b.t + barMs > sinceTs) px = b.c;
    if (!Number.isFinite(px)) continue;
    if (dir === 1 ? px <= stopPrice : px >= stopPrice) return { price: px, t: b.t };
  }
  return null;
}

// FILL-SLIPPAGE GUARD (2026-10-16, owner's 10/14 05:30 PT loss: a LONG limit at 30801.76 filled 66.76 pts lower at the 8:30 ET gap; the old code shifted the stop
// and targets by the whole gap, so the new stop sat 66 pts lower and was hit 8 s later). Pure, shared by LIVE and PAPER.
// guard = { enabled, minPts (4), frac (0.25) }. Slip threshold = max(minPts, frac x planned stop distance).
//   |fill - intended| <= threshold (or guard off): 'shift'  - today's behaviour: stop/targets move by the slip to keep the planned distances.
//   bigger slip, fill at or beyond the original stop: 'exit' - the setup is already stopped out: flatten at once.
//   bigger slip in the trader's FAVOUR (long filled lower / short filled higher), stop still valid: 'keep' - the original stop and targets are kept (more room).
//   bigger ADVERSE slip (long filled higher / short filled lower): 'shift' as today - keeps the planned $ risk (QA 10/16 R1, adopted by the lead).
function fillSlipDecision({ dir, intended, fill, stop, guard }) {
  const delta = fill - intended;
  const dist = Math.abs(intended - stop);
  const g = guard || {};
  const threshold = Math.max(Number.isFinite(g.minPts) ? g.minPts : 4, (Number.isFinite(g.frac) ? g.frac : 0.25) * (Number.isFinite(dist) ? dist : 0));
  if (!g.enabled || !Number.isFinite(delta) || Math.abs(delta) <= threshold) return { action: 'shift', delta, threshold };
  const through = dir === 1 ? fill <= stop : fill >= stop;
  if (through) return { action: 'exit', delta, threshold };
  return { action: delta * dir < 0 ? 'keep' : 'shift', delta, threshold, adverse: delta * dir > 0 };
}

module.exports = { pendingStopTouch, fillSlipDecision };
