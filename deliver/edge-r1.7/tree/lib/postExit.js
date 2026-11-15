'use strict';
// edge r1.7: RECORD ONLY. What price did after every trade exit, and the price path an old-rule counterfactual (X-03 / X-04) needs.
// Nothing here is read by an entry, an exit, a stop, a size, a cooldown or an alert. The module has no broker access (no token, no order function, no fetch).
// It is fed only what the poll already holds: the poll price, the last 1m bars, a read-only copy of the open trade (the scorecard's view) and the journal rows
// the bot already writes. Every public method catches its own errors; a tracker bug costs one post_exit_error row (at most one per 10 minutes), never a poll.
//
// One tracker per trade, from the first sight of the open trade to 60 minutes after the exit, whether or not another trade opens meanwhile. ONE `post_exit` row
// is written when the tracker ends (the window passed, or it was cut short, with `cut` and `cutWhy`). A trade whose old-rule shadow still runs (runnerMode
// allAtTp1 / atrTarget with TP1 reached) is followed until the old rule's own horizon (the shadow's: 240 min from the fill, or the session close), so the row
// carries the whole path the old runner rule would have seen. The path is kept per 1-minute bucket (high / low in points from the fill, trade direction).
// State: a small JSON file (tmp + rename), written at most once a minute and on every tracker change, read at startup (parse only; the trackers resume).
const M1 = 60000;
const WINDOW_MS = 60 * M1;           // the post-exit window
const OLD_RULE_MAX_MS = 240 * M1;    // the old-runner shadow's horizon from the fill (lib/scorecard.js RS_MAX_MS)
const MAX_TRACKERS = 6;              // per symbol, the open trade included; the oldest finished-side tracker is ended with cut 'cap' when a new one needs the room
const MAX_MINUTES = 720;             // path buckets per tracker (12 h of 1-minute buckets); beyond it pathTruncated, and the post statistics keep counting
const FRESH_MS = 5 * M1;             // the poll price counts only while the newest 1m bar is at most this old (market closed = no sample)
const IDLE_END_MS = 10 * M1;         // no sample for this long after the exit ends the tracker (session end, market break, lost price, restart)
const FIRST_SIGHT_MS = 90000;
const SAVE_EVERY_MS = M1;
const ERROR_EVERY_MS = 10 * M1;
const MAX_TRACKER_ERRORS = 5;
const LEVELS = [5, 10, 15, 25, 50];
const MODES = ['on', 'off'];
const RS_RULES = ['allAtTp1', 'atrTarget'];
const VERSION = 1;
const fin = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => (fin(x) ? Math.round(x * 100) / 100 : null);
const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function ptMinuteOfDay(t) { try { const o = {}; for (const p of PT_FMT.formatToParts(new Date(t))) o[p.type] = p.value; return (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10); } catch (e) { return null; } }
const BREAK_FROM_MIN = 12 * 60 + 50, BREAK_TO_MIN = 15 * 60;   // 12:50-15:00 PT: the session close (no entries 12:55, flat 13:05) and the market break

function validateMode(m) { return MODES.includes(m) ? [] : [`afterExitRecord must be "on" or "off", got ${JSON.stringify(m)}`]; }
function startLine(mode) {
  return mode === 'on'
    ? `[after-exit] afterExitRecord: ON (record only: one post_exit row per trade, ${WINDOW_MS / M1} min after every exit, up to ${OLD_RULE_MAX_MS / M1} min from the fill for old-runner-rule trades; no order, no request, no decision reads it)`
    : '[after-exit] afterExitRecord: OFF (no post_exit rows, no state file: the r1.6 journal exactly)';
}

function createPostExit(opts) {
  const fs = opts.fs || require('fs'), file = opts.file || null, nowFn = opts.now || Date.now;
  const journal = r => { try { if (opts.journal) opts.journal(r); } catch (e) { /* journal only */ } };
  const log = m => { try { if (opts.log) opts.log(m); } catch (e) { /* log only */ } };
  const exitReasonOf = jid => { try { return typeof opts.exitReasonOf === 'function' ? opts.exitReasonOf(jid) : null; } catch (e) { return null; } };
  const oldRunner = opts.runnerOld && fin(opts.runnerOld.lockPts) && fin(opts.runnerOld.stepPts) && opts.runnerOld.stepPts > 0 ? { lockPts: opts.runnerOld.lockPts, stepPts: opts.runnerOld.stepPts } : null;
  let trackers = [], dirty = false, lastSave = 0, lastErrorRow = -Infinity;

  // ---- persistence ----
  // load() parses one small file and nothing else: finishing or resuming a tracker happens in the first poll, never in the start-up path.
  function load() {
    try {
      if (!file || !fs.existsSync(file)) return { fresh: true, pending: 0 };
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!o || o.version !== VERSION || !Array.isArray(o.trackers)) throw new Error('the file does not have the post-exit shape');
      const at = nowFn();
      trackers = o.trackers.filter(t => t && typeof t.id === 'string' && (t.dir === 1 || t.dir === -1) && fin(t.entry) && (t.phase === 'open' || t.phase === 'post') && t.m && typeof t.m === 'object').slice(-MAX_TRACKERS);
      for (const t of trackers) { t.reloadedAt = at; t.restarts = (t.restarts || 0) + 1; }
      if (trackers.length) dirty = true;
      return { fresh: false, pending: trackers.length };
    } catch (e) {
      trackers = []; log('  [after-exit] the state file could not be used (' + String((e && e.message) || e).slice(0, 120) + ') - starting with no pending trackers');
      return { fresh: true, bad: true, pending: 0 };
    }
  }
  function save(force) {
    if (!file || !dirty) return true;
    const t = nowFn();
    if (!force && t - lastSave < SAVE_EVERY_MS) return true;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      try { fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, savedAt: t, trackers })); fs.renameSync(tmp, file); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ } throw e; }
      dirty = false; lastSave = t; return true;
    } catch (e) { log('  [after-exit] state save failed (non-fatal, retried): ' + (e && e.message)); return false; }
  }
  function errorRow(where, e, now) {
    log(`  [after-exit] ${where} failed (non-fatal): ${(e && e.message) || e}`);
    if (now - lastErrorRow < ERROR_EVERY_MS) return;
    lastErrorRow = now;
    journal({ type: 'post_exit_error', t: now, where, message: String((e && e.message) || e).slice(0, 200), pending: trackers.length, note: 'record only: a post-exit tracker step failed; no order or decision was affected; at most one row per 10 minutes' });
  }

  // ---- trackers ----
  const sameTrade = (tk, tr) => (tk.jid && tr.jid ? tk.jid === tr.jid : tk.dir === tr.dir && Math.abs(tk.entry - tr.entry) < 0.26);
  function arm(tr, now) {
    if (trackers.length >= MAX_TRACKERS) { const old = trackers.find(t => t.phase === 'post'); if (old) finish(old, 'cap', `${MAX_TRACKERS} trackers were running: the oldest was ended to make room`, now); }
    const fillKnown = fin(tr.fillAt);
    const tk = { id: String(tr.jid || `x|${tr.dir}|${tr.entry}|${fillKnown ? tr.fillAt : now}`), jid: tr.jid || null, dir: tr.dir, entry: tr.entry, phase: 'open', armedAt: now, fillAt: fillKnown ? tr.fillAt : null, pathFromFill: fillKnown && now - tr.fillAt <= FIRST_SIGHT_MS,   // first seen within 90 s of the fill time stamp the bot holds (an adopted position's stamp is its first sight)
     
      contracts: fin(tr.contracts) ? tr.contracts : null, stop: fin(tr.stop) ? tr.stop : null, tp1: fin(tr.tp1) ? tr.tp1 : null, tp2: fin(tr.tp2) ? tr.tp2 : null, atr15: fin(tr.atr15) ? tr.atr15 : null,
      session: tr.session || null, runnerMode: tr.runnerMode || 'live', closeAt: fin(tr.sessionCloseAt) ? tr.sessionCloseAt : null, oldRule: oldRunner ? { ...oldRunner } : null,
      barFrom: Math.ceil(((fillKnown ? tr.fillAt : now) + 1) / M1) * M1, lastBarT: null, m: {}, truncated: false, tp1Hit: false, tp1FilledAt: null, lastPx: null, errors: 0, hint: null };
    trackers.push(tk); dirty = true; save(true);
    return tk;
  }
  function refresh(tk, tr) {   // facts that were not known at the first sight
    if (!tk.jid && tr.jid) tk.jid = tr.jid;
    if (tk.stop == null && fin(tr.stop)) tk.stop = tr.stop;
    if (tk.tp1 == null && fin(tr.tp1)) tk.tp1 = tr.tp1;
    if (tk.tp2 == null && fin(tr.tp2)) tk.tp2 = tr.tp2;
    if (tk.atr15 == null && fin(tr.atr15)) tk.atr15 = tr.atr15;
    if (!tk.session && tr.session) tk.session = tr.session;
    if (tk.closeAt == null && fin(tr.sessionCloseAt)) tk.closeAt = tr.sessionCloseAt;
    if (tr.runnerMode && tr.runnerMode !== 'live' && tk.runnerMode === 'live') tk.runnerMode = tr.runnerMode;
    if (tr.phase && tr.phase !== 'LEG1_OPEN' && tr.phase !== 'FLATTENING' && !tk.tp1Hit) { tk.tp1Hit = true; dirty = true; }
    if (fin(tr.contracts) && (tk.contracts == null || tr.contracts > tk.contracts)) tk.contracts = tr.contracts;
  }
  function bucket(tk, k, hi, lo) {
    const b = tk.m[k];
    if (!b) { if (Object.keys(tk.m).length >= MAX_MINUTES) { tk.truncated = true; return; } tk.m[k] = [hi, lo]; dirty = true; return; }
    if (hi > b[0]) { b[0] = hi; dirty = true; } if (lo < b[1]) { b[1] = lo; dirty = true; }
  }
  function observe(tk, hiPx, loPx, t, src) {
    const fav = tk.dir === 1 ? hiPx : loPx, adv = tk.dir === 1 ? loPx : hiPx;
    const hi = r2(tk.dir * (fav - tk.entry)), lo = r2(tk.dir * (adv - tk.entry)), k = Math.floor(t / M1) * M1;
    bucket(tk, k, hi, lo);
    if (tk.phase === 'post') {
      if (src === 'poll' && k === tk.exitMinute) { if (!tk.xm) tk.xm = [hi, lo]; else { if (hi > tk.xm[0]) tk.xm[0] = hi; if (lo < tk.xm[1]) tk.xm[1] = lo; } dirty = true; }
      if (src === 'bar1m') { if (t < tk.exitDetectedAt + WINDOW_MS) tk.barSamples = (tk.barSamples || 0) + 1; else tk.xBar = (tk.xBar || 0) + 1; }
    }
  }
  function sample(tk, now, price) {   // one poll price
    if (tk.phase === 'open') tk.lastPx = price;
    tk.lastPts = r2(tk.dir * (price - tk.entry)); tk.lastAt = now;
    observe(tk, price, price, now, 'poll');
    if (tk.phase === 'post') {
      const prev = fin(tk.lastSampleAt) ? tk.lastSampleAt : tk.exitDetectedAt, gap = now - prev;   // the window counters stop at exit + 60 min; the horizon counters (xPoll, xMaxGap) go on to the end of an extended tracker
      if (now <= tk.exitDetectedAt + WINDOW_MS) { tk.pollSamples = (tk.pollSamples || 0) + 1; if (gap > (tk.maxGapMs || 0)) tk.maxGapMs = gap; tk.winLast = now; } else tk.xPoll = (tk.xPoll || 0) + 1;
      if (gap > (tk.xMaxGap || 0)) tk.xMaxGap = gap;
      tk.lastSampleAt = now; dirty = true;
    }
  }
  function feedBars(tk, now, bars) {
    for (const b of (Array.isArray(bars) ? bars : []).filter(x => x && fin(x.t) && fin(x.h) && fin(x.l) && x.t % M1 === 0).sort((x, y) => x.t - y.t)) {
      if (b.t < tk.barFrom || b.t + M1 > now || (fin(tk.lastBarT) && b.t <= tk.lastBarT) || (tk.phase === 'post' && b.t >= tk.endAt)) continue;
      tk.lastBarT = b.t; observe(tk, b.h, b.l, b.t, 'bar1m'); dirty = true;
    }
  }
  function toPost(tk, now) {
    tk.phase = 'post'; tk.exitDetectedAt = now; tk.exitMinute = Math.floor(now / M1) * M1; tk.pollSamples = 0; tk.barSamples = 0; tk.maxGapMs = 0; tk.lastSampleAt = null;
    tk.exitSeenAfterRestart = fin(tk.reloadedAt) && fin(tk.lastSeenOpenAt) && tk.lastSeenOpenAt < tk.reloadedAt;   // the trade was last seen open before a restart: the exit happened while the bot was down or just after
    const tp1Pts = fin(tk.tp1) ? tk.dir * (tk.tp1 - tk.entry) : null;
    const tp1Seen = tk.tp1Hit || fin(tk.tp1FilledAt) || (tp1Pts != null && Object.values(tk.m).some(b => b[0] >= tp1Pts - 1e-9));
    const oldRuleTrade = !!(tk.oldRule && RS_RULES.includes(tk.runnerMode) && tk.contracts >= 2 && tp1Seen);
    const base = now + WINDOW_MS;
    tk.endAt = oldRuleTrade ? Math.max(base, Math.min((fin(tk.fillAt) ? tk.fillAt : tk.armedAt) + OLD_RULE_MAX_MS, fin(tk.closeAt) && tk.closeAt > now ? tk.closeAt : Infinity)) : base;
    tk.extendedFor = oldRuleTrade && tk.endAt > base ? 'old-runner-rule' : null; tk.oldRuleTrade = oldRuleTrade;
    dirty = true; save(true);
  }
  function step(tk, now, price, barT, bars) {
    const fresh = fin(price) && fin(barT) && now - barT <= FRESH_MS;
    if (tk.phase === 'open') { feedBars(tk, now, bars); if (fresh) { sample(tk, now, price); tk.lastSeenOpenAt = now; } return; }
    const ref = fin(tk.lastSampleAt) ? tk.lastSampleAt : tk.exitDetectedAt, idle = now - ref > IDLE_END_MS, shortData = ref < tk.endAt - IDLE_END_MS;
    if (idle && shortData) {   // the prices stopped well before the window's end
      const restart = fin(tk.reloadedAt) && ref < tk.reloadedAt, h = ptMinuteOfDay(ref), why = restart ? 'restart' : h != null && h >= BREAK_FROM_MIN && h < BREAK_TO_MIN ? 'session_end' : 'price_gap';
      const text = why === 'restart' ? `the bot restarted and no price was read for ${Math.round((now - ref) / M1)} min of the window` : why === 'session_end' ? 'the session ended (12:50-15:00 PT, the session close and the market break): no price for more than 10 minutes' : `no price for ${Math.round((now - ref) / M1)} min`;
      return finish(tk, why, text, now, ref);
    }
    feedBars(tk, now, bars);
    if (now >= tk.endAt) return finish(tk, null, null, now);
    if (fresh) sample(tk, now, price);
  }

  // ---- the row ----
  function postStats(tk) {
    const d = tk.dir, exitPx = fin(tk.exitPx) ? tk.exitPx : null, buckets = [];
    for (const k of Object.keys(tk.m).map(Number).sort((a, b) => a - b)) if (k > tk.exitMinute && k < tk.exitDetectedAt + WINDOW_MS) buckets.push({ t: k, hi: tk.m[k][0], lo: tk.m[k][1] });
    if (tk.xm) buckets.unshift({ t: tk.exitDetectedAt, hi: tk.xm[0], lo: tk.xm[1] });
    const none = () => Object.fromEntries(LEVELS.map(l => ['p' + l, null]));
    const out = { fromEntry: { bestPts: null, worstPts: null, bestPrice: null, worstPrice: null, bestAt: null, worstAt: null }, fromExit: { bestPts: null, worstPts: null, bestAt: null, worstAt: null },
      firstTouch: { fromExit: none(), fromEntry: none(), stop: null, tp1: null, tp2: null, reclaim: null }, minutes: buckets.length };
    const exitPts = exitPx != null ? d * (exitPx - tk.entry) : null, ft = out.firstTouch;
    for (const b of buckets) {
      const fe = out.fromEntry, fx = out.fromExit;
      if (fe.bestPts == null || b.hi > fe.bestPts) { fe.bestPts = b.hi; fe.bestAt = b.t; }
      if (fe.worstPts == null || b.lo < fe.worstPts) { fe.worstPts = b.lo; fe.worstAt = b.t; }
      if (exitPts != null) {
        const hx = r2(b.hi - exitPts), lx = r2(b.lo - exitPts);
        if (fx.bestPts == null || hx > fx.bestPts) { fx.bestPts = hx; fx.bestAt = b.t; }
        if (fx.worstPts == null || lx < fx.worstPts) { fx.worstPts = lx; fx.worstAt = b.t; }
        for (const l of LEVELS) if (ft.fromExit['p' + l] == null && hx >= l - 1e-9) ft.fromExit['p' + l] = b.t;
      }
      for (const l of LEVELS) if (ft.fromEntry['p' + l] == null && b.hi >= l - 1e-9) ft.fromEntry['p' + l] = b.t;
      if (ft.stop == null && fin(tk.stop) && b.lo <= d * (tk.stop - tk.entry) + 1e-9) ft.stop = b.t;
      if (ft.tp1 == null && fin(tk.tp1) && b.hi >= d * (tk.tp1 - tk.entry) - 1e-9) ft.tp1 = b.t;
      if (ft.tp2 == null && fin(tk.tp2) && b.hi >= d * (tk.tp2 - tk.entry) - 1e-9) ft.tp2 = b.t;
      if (ft.reclaim == null && b.hi >= -1e-9) ft.reclaim = b.t;
    }
    if (fin(out.fromEntry.bestPts)) out.fromEntry.bestPrice = r2(tk.entry + d * out.fromEntry.bestPts);
    if (fin(out.fromEntry.worstPts)) out.fromEntry.worstPrice = r2(tk.entry + d * out.fromEntry.worstPts);
    return out;
  }
  function buildRow(tk, cut, cutWhy, now, lastAt) {
    const hint = tk.hint || {}, er = exitReasonOf(tk.jid) || {};
    const exitAt = fin(hint.endAt) ? hint.endAt : tk.exitDetectedAt;
    tk.exitPx = fin(hint.closePrice) ? hint.closePrice : fin(tk.lastPx) ? tk.lastPx : null;
    const exitPxSrc = fin(hint.closePrice) ? (hint.closePriceSource || 'trade_time row') : fin(tk.lastPx) ? 'last bot price while the trade was open' : null;
    const post = postStats(tk);
    const ks = Object.keys(tk.m).map(Number).sort((a, b) => a - b), from = ks.length ? ks[0] : null;
    const last = fin(lastAt) ? lastAt : fin(tk.lastSampleAt) ? tk.lastSampleAt : tk.exitDetectedAt;
    const winEnd = tk.exitDetectedAt + WINDOW_MS, reach = cut ? last : Math.min(now, tk.endAt), winLast = fin(tk.winLast) ? tk.winLast : tk.exitDetectedAt;
    let maxGap = tk.maxGapMs || 0; const tail = Math.min(reach, winEnd) - winLast; if (tail > maxGap) maxGap = tail;   // the silence at the end of the window counts as a gap
    const bar = tk.barSamples || 0, poll = tk.pollSamples || 0, windowComplete = !cut || last >= winEnd - IDLE_END_MS;
    return { type: 'post_exit', t: now, version: VERSION, journalId: tk.jid, session: tk.session, dir: tk.dir, runnerMode: tk.runnerMode, contracts: tk.contracts, fill: tk.entry, fillAt: tk.fillAt, pathFromFill: tk.pathFromFill,
      stopPrice: tk.stop, stopPts: fin(tk.stop) ? r2(Math.abs(tk.entry - tk.stop)) : null, tp1Price: tk.tp1, tp1Pts: fin(tk.tp1) ? r2(Math.abs(tk.tp1 - tk.entry)) : null, tp2Price: tk.tp2, atr15: tk.atr15,
      exitReason: er.exitReason || null, exitAt, exitPrice: tk.exitPx, exitSide: tk.dir === 1 ? 'SELL' : 'BUY', exitPriceSource: exitPxSrc, exitDetectedAt: tk.exitDetectedAt, exitSeenAfterRestart: tk.exitSeenAfterRestart === true,
      windowMin: WINDOW_MS / M1, horizonMin: r2((tk.endAt - tk.exitDetectedAt) / M1), extendedFor: tk.extendedFor || null,
      post: { fromExit: post.fromExit, fromEntry: post.fromEntry, firstTouch: post.firstTouch, minutes: post.minutes },
      samples: poll + bar, pollSamples: poll, barSamples: bar, maxGapMs: Math.round(maxGap), coveredMin: r2((Math.min(winLast, winEnd) - tk.exitDetectedAt) / M1), windowComplete,
      horizonSamples: tk.extendedFor ? poll + bar + (tk.xPoll || 0) + (tk.xBar || 0) : null, horizonMaxGapMs: tk.extendedFor ? Math.round(Math.max(tk.xMaxGap || 0, reach - last > 0 && !cut ? reach - last : 0)) : null, horizonCoveredMin: tk.extendedFor ? r2((last - tk.exitDetectedAt) / M1) : null, priceSource: poll && bar ? 'poll+bar1m' : poll ? 'poll' : bar ? 'bar1m' : 'none',
      cut: cut || null, cutWhy: cutWhy || null, restarts: tk.restarts || 0,
      oldRule: tk.oldRule && RS_RULES.includes(tk.runnerMode) ? { lockPts: tk.oldRule.lockPts, stepPts: tk.oldRule.stepPts, tp1FilledAt: tk.tp1FilledAt, tp1Seen: !!tk.oldRuleTrade, closeAt: tk.closeAt } : null,
      lastPts: fin(tk.lastPts) ? tk.lastPts : null, lastAt: fin(tk.lastAt) ? tk.lastAt : null, pathFrom: from, pathStepMs: M1, path: ks.map(k => [(k - from) / M1, tk.m[k][0], tk.m[k][1]]), pathTruncated: tk.truncated === true,
      note: 'record only, no order: the price after the exit from the polls and 1m bars the bot already reads. post, samples, maxGapMs and coveredMin = the 60 minutes after the exit (best and worst in points from the fill and from the exit price; first touch time of each level at minute resolution: a bar touching two levels gives both the same minute and the order is unknown). path = [minute offset from pathFrom, high, low] in points from the fill in the trade direction, from the fill to the end of the window (the exit minute mixes prices before and after the exit)' };
  }
  function finish(tk, cut, cutWhy, now, lastAt) {
    let row = null; try { row = buildRow(tk, cut, cutWhy, now, lastAt); } catch (e) { errorRow('row', e, now); }
    const i = trackers.indexOf(tk); if (i >= 0) trackers.splice(i, 1);
    dirty = true;
    if (!save(true) && (tk.finishTries = (tk.finishTries || 0) + 1) < 3) { trackers.push(tk); return; }   // the state could not be saved: the row waits a poll (a second copy after a restart is worse than a late row)
    if (row && row.journalId) journal(row);
  }

  // ---- public ----
  // Journal rows the bot already writes: the close time / price of a trade (trade_time) and the TP1 fill time (trade_manage TP1_FILLED).
  function indexJournal(e) {
    try {
      if (!e || typeof e.journalId !== 'string' || !e.journalId || !trackers.length) return;
      if (e.type === 'trade_time') { const tk = trackers.find(t => t.jid === e.journalId); if (tk) { tk.hint = { endAt: fin(e.endAt) ? e.endAt : null, closePrice: fin(e.closePrice) ? e.closePrice : null, closePriceSource: typeof e.closePriceSource === 'string' ? e.closePriceSource.slice(0, 80) : null }; dirty = true; } }
      else if (e.type === 'trade_manage' && e.code === 'TP1_FILLED' && fin(e.t)) { const tk = trackers.find(t => t.jid === e.journalId); if (tk && !fin(tk.tp1FilledAt)) { tk.tp1FilledAt = e.t; tk.tp1Hit = true; dirty = true; } }
    } catch (err) { /* record only */ }
  }
  // p: { now, price, barT (start of the newest 1m bar), bars (the 1m bars the poll read), trade (the open filled trade view or null),
  //      flat (the order machine is FLAT or PENDING_ENTRY and not desynced: the only state in which a missing trade means "exited") }
  function onPoll(p) {
    const now = fin(p.now) ? p.now : nowFn();
    try {
      const tr = p.trade && (p.trade.dir === 1 || p.trade.dir === -1) && fin(p.trade.entry) ? p.trade : null;
      const open = trackers.find(t => t.phase === 'open');
      if (open && (tr ? !sameTrade(open, tr) : p.flat === true)) { try { toPost(open, now); } catch (e) { const i = trackers.indexOf(open); if (i >= 0) trackers.splice(i, 1); errorRow('exit', e, now); } }
      if (tr && !trackers.some(t => t.phase === 'open')) { try { arm(tr, now); } catch (e) { errorRow('arm', e, now); } }
      const cur = tr ? trackers.find(t => t.phase === 'open') : null;
      if (cur) { try { refresh(cur, tr); } catch (e) { errorRow('refresh', e, now); } }
      for (const tk of trackers.slice()) {
        try { step(tk, now, p.price, p.barT, p.bars); }
        catch (e) { errorRow('step', e, now); if ((tk.errors = (tk.errors || 0) + 1) >= MAX_TRACKER_ERRORS) { const i = trackers.indexOf(tk); if (i >= 0) trackers.splice(i, 1); dirty = true; } }
      }
      save(false);
    } catch (e) { errorRow('poll', e, now); }
  }
  return { load, save: () => save(true), indexJournal, onPoll, pending: () => trackers.length, _trackers: () => trackers };
}

module.exports = { VERSION, WINDOW_MS, OLD_RULE_MAX_MS, MAX_TRACKERS, MAX_MINUTES, LEVELS, MODES, validateMode, startLine, createPostExit };
