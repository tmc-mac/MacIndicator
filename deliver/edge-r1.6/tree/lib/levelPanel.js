'use strict';
// lv1 r5 LEVELS JOURNAL + PHONE PANEL (Mac 10/27: "I need to know what levels are triggering our bot, which levels we're missing, why we're not taking trades at
// the triggered levels, why we are taking trades at the triggered levels - a real extensive journal useful to the team"). JOURNAL / DISPLAY ONLY: nothing here
// is read by a trading decision. Pure: no I/O, no clock reads (every call passes its time), no globals; the executor writes the returned rows to
// levels-journal-<SYMBOL>-<TradeDay>.jsonl and puts snapshot() in the phone snapshot.
//
// Rows (every row: type, t, v):
//   lv_scan     - one per trigger timeframe per COMPLETED bar: every level on the board with its verdict for that bar (lib/levelEvent.js judge(): EVENT /
//                 outranked / no-sweep / board-against / too-new / not-judged / touched / away), close-minus-level, cross direction, board labels.
//   lv_event    - an event's lifecycle: born (full geometry) | unassessed (bar gap: no trade until the run is unbroken) | recertified | ended (closed-back-across
//                 / expired-30m), with its outcome so far.
//   lv_decision - while an event is live: is it the trigger the bot picked, and if so its STATUS from the bot's own checklist (r6, MacDot 6454908744 #3):
//                 'blocked' (a gate is failing, or the bot journaled a block on this event since the previous decision), 'unknown' (no checklist, a gate
//                 reported no answer, or the verdict is not WOULD ENTER), 'gates-clear' (verdict WOULD ENTER, no failing or unanswered gate, no block since
//                 the previous decision). gates-clear is NOT admission: the order gates after the checklist still decide. Written on change, at most every 5 min.
//   lv_block    - a trade_block the bot journaled on the event the bot PICKED (r6 #2: the picked event's id, never the first same-direction event), deduped per
//                 event + code per 15 min (the trade journal's own dedupe is per code + direction, so it no longer hides a new event's block).
//   lv_attempt  - the central takeEntry guard accepted the event's proof (the entry is being checked by the remaining gates).
//   lv_order    - r6 (#1): the order's real progress, by journalId: handed (to the order state machine, or booked in paper) -> accepted (the broker / paper book
//                 holds a resting order) -> filled | not-admitted (the FSM / broker left it flat) | rejected | canceled | unfilled. Only 'filled' is Taken.
//   lv_trade    - r7 (Mac 10/27: "track our bot's positions intraday on the terminal"): the open position's life, from the state the bot already holds (the
//                 FSM in LIVE, the paper book in PAPER) - open (entry, stop, targets, the level event that triggered it), stop / target moves, phase changes
//                 (TP1 / TP2 scale-outs, flattening) and close, each with the bot's live price at that moment.
const VERSION = 'lv-journal-r2';
const STALE_MS = 90000;   // r10: a price read older than this is stale on the trade chart (the terminal itself runs ~20-30 s behind)
const OPEN_PHASES = new Set(['LEG1_OPEN', 'LEG23_OPEN', 'LEG3_OPEN', 'FLATTENING']);
const ORDER_FINAL = new Set(['filled', 'not-admitted', 'rejected', 'canceled', 'unfilled']);
const MISS_CODES = new Set(['outranked', 'no-sweep', 'board-against', 'too-new', 'not-judged', 'sweep-live']);   // r13.3: sweep-live = a retest a live sweep kept from firing
const RE_DECIDE_MS = 5 * 60000;
// r5 display extras: the board-label sets and sweep rule MIRROR lib/levelEvent.js exactly (the radar must never promise a trigger the tracker would not fire)
const LONG_BEH = ['SWEEP DN', 'FAIL DN', 'RECLAIM', 'ACCEPT+', 'HOLD+'], SHORT_BEH = ['SWEEP UP', 'FAIL UP', 'LOST', 'ACCEPT-', 'HOLD-'], SWEEP_PTS = 0.25;
// r13 (display): lib/levelEvent.js's BREAK-RETEST constants and labels, mirrored (a test pins them equal)
const RETEST_TOL = 2, RETEST_AWAY = 10, RETEST_HOLD = 1, RETEST_WINDOW_MS = 2 * 3600000, M5 = 300000;
const PERSIST_MS = 30 * 60000;   // r13.3: lib/levelEvent.js PERSIST_MS, mirrored (a test pins them equal) - how long a live sweep keeps a retest from being born
const RETEST_LONG_BEH = ['ACCEPT+', 'HOLD+', 'TESTING', 'RECLAIM', 'SWEEP DN', 'FAIL DN', 'support'], RETEST_SHORT_BEH = ['ACCEPT-', 'HOLD-', 'TESTING', 'LOST', 'SWEEP UP', 'FAIL UP', 'resist'];
const tfLabel = ms => (Number.isFinite(ms) ? `${Math.round(ms / 60000)}m` : '?');
function eventId(e) {
  if (!e || !e.level) return null;
  return `${tfLabel(e.tfMs)}:${e.level.name}@${e.level.price}:${e.bornT}:${e.dir > 0 ? 'L' : 'S'}`;
}
function proofId(pf) { return pf ? `${tfLabel(pf.tfMs)}:${pf.name}@${pf.price}:${pf.bornT}:${pf.dir > 0 ? 'L' : 'S'}` : null; }
const r2 = x => Math.round(x * 100) / 100;
const short = (x, n = 160) => (typeof x === 'string' ? (x.length > n ? x.slice(0, n - 1) + '…' : x) : x == null ? null : String(x).slice(0, n));

// maxBars (r10.2): 96 completed 5m candles (8 h) so a long trade keeps its run-up into the level on the trade chart; the ladder draws the newest 36
function createLevelPanel({ maxEvents = 60, maxMisses = 40, maxBoard = 16, maxBars = 96, armedPts = 80, maxTrades = 12, maxPx = 720, maxSaved = 300, savedFull = 10, ptMinutesFn = null, levelTFn = null } = {}) {
  // lv1 r13.3.4 levelT (MacUI, display only): levelTFn(name, t) = the start of the period whose open the level is (lib/levelEvent.js levelT), null when the
  // clock alone does not fix it; added to levels.events / misses / armed only when known (the phone labels "15m Open 04:30" instead of "15m Open prior")
  const lvT = (name, t) => { if (typeof levelTFn !== 'function') return null; try { const v = levelTFn(name, t); return Number.isFinite(v) ? v : null; } catch (_) { return null; } };
  const withT = (o, name, t) => { const v = lvT(name, t); return v === null ? o : { ...o, levelT: v }; };
  let day = null, dropped = 0, lastPickedId = null, bornToday = 0, openTrade = null, pendingPlan = null;
  const trades = [];                 // r7: today's positions, oldest first (bounded by maxTrades)
  const settledRt = new Set();       // r10: broker round trips already used to settle a trade (each settles one trade)
  const outbox = [];                 // r11: lv_replay rows not yet written by the executor
  const saved = new Map();           // r11 (Mac 10/28: "make sure my replay trades are stored somewhere I can review them even after a bot restart or update"):
                                     // key -> self-contained replay record (the trade's tape + its own candles + the levels near it), oldest first; the executor
                                     // appends every lv_replay row to trade-replays-<SYMBOL>.jsonl and hands them back here at start-up (loadSaved)
  const events = new Map();          // id -> record (today; the newest maxEvents are retained - `dropped` counts the older ones no longer shown)
  const byJournal = new Map();       // r6: journalId -> event id (orders handed on a level event)
  let misses = [];                   // newest last
  const lastScan = {};               // tf -> scan
  const liveByTf = {};               // tf -> id currently live / unassessed
  let bars5 = [];                    // r5 ladder: the completed 5m bars seen by scans [t, o, h, l, c], newest last
  let forming5 = null;               // r12.5 (Mac 10/28: "Price on the chart doesn't have an actual candle"): the 5m bar forming at the latest poll [t, o, h, l, c]
  const usableSince = new Map();     // r13: 5m level key (name|price) -> the first 5m bar it was usable from (the tracker's knowledge rule, as the scans showed it)
  let gateNow = null;                // r12.6: the entry gates' latest reading (HTF alignment direction, 15m control), from the executor with each decision
  const gateTally = new Map();       // gate key -> { label, events: Set(id) } (which gates held back which events today)

  function roll(dayKey) {
    if (dayKey === day) return null;
    // r10: an open position carries across the TradeDay roll (its tape and frozen risk stay); everything else starts empty
    const prev = day; day = dayKey; events.clear(); byJournal.clear(); dropped = 0; bornToday = 0; lastPickedId = null; misses = []; bars5 = []; forming5 = null; gateNow = null; usableSince.clear(); gateTally.clear(); trades.length = 0; if (openTrade) trades.push(openTrade); pendingPlan = null; for (const k of Object.keys(lastScan)) delete lastScan[k]; for (const k of Object.keys(liveByTf)) delete liveByTf[k];
    return prev == null ? null : { type: 'lv_day', t: null, v: VERSION, from: prev, to: dayKey };
  }

  // r10.1 (Mac 10/27: the ladder showed 2 candles after the install restart): the ladder / trade chart candles come from the bot's own 5m fetch - every bar
  // COMPLETED by the request time (the executor filters; the forming bar never enters) - merged by bar time, newest maxBars kept. Display only.
  function seedBars(bars) {
    if (!Array.isArray(bars) || !bars.length) return;
    const m = new Map(bars5.map(b => [b[0], b]));
    for (const b of bars) if (b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite)) m.set(b.t, [b.t, b.o, b.h, b.l, b.c, Number.isFinite(b.v) ? b.v : null]);
    bars5 = [...m.values()].sort((a, b) => a[0] - b[0]).slice(-maxBars);
  }
  // r12.5: the forming 5m bar from the same fetch (started by the request, not yet ended); null clears it. Display only - the phone draws it as the live candle.
  function seedForming(b) { forming5 = b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) ? [b.t, b.o, b.h, b.l, b.c] : null; }
  function scan(tf, sc, t) {
    if (!sc) return null;
    lastScan[tf] = { ...sc, tf, at: t };
    if (tf === '5m' && Number.isFinite(sc.open) && (!bars5.length || bars5[bars5.length - 1][0] < sc.barT)) { bars5.push([sc.barT, sc.open, sc.high, sc.low, sc.close]); if (bars5.length > maxBars) bars5 = bars5.slice(-maxBars); }
    for (const [name, price, code, dist, dir] of sc.levels) if (MISS_CODES.has(code)) misses.push(withT({ t: sc.barT, tf, name, price, code, dir, dist, close: sc.close }, name, t));   // r13.3.4: + levelT
    if (tf === '5m') {
      const onBoard = new Set(sc.levels.map(l => `${l[0]}|${l[1]}`));   // r13.3 (MacDot 6470196640): as the tracker's firstSeen - a level that left the board is a new level if it returns
      for (const k of [...usableSince.keys()]) if (!onBoard.has(k)) usableSince.delete(k);
      for (const [name, price, , , , , usable] of sc.levels) { const k = `${name}|${price}`; if (usable && !usableSince.has(k)) usableSince.set(k, sc.barT); }
    }
    if (misses.length > maxMisses) misses = misses.slice(-maxMisses);
    return { type: 'lv_scan', t, v: VERSION, tf, barT: sc.barT, close: sc.close, high: sc.high, low: sc.low, judged: sc.judgeable,
      events: sc.levels.filter(l => l[2] === 'EVENT').map(l => l[0]), levels: sc.levels };
  }

  function rec(e) {
    const id = eventId(e);
    let r = events.get(id);
    if (!r) {
      r = { id, tf: tfLabel(e.tfMs), name: e.level.name, price: e.level.price, ...(Array.isArray(e.level.alsoNames) && e.level.alsoNames.length ? { alsoNames: e.level.alsoNames.slice() } : {}), dir: e.dir, event: e.event, behavior: e.level.behavior || null, bornT: e.bornT,   // r13.3.4: alsoNames
        entry: e.entry, stop: e.stop, target: e.target, targetName: e.targetName, sweepExtreme: e.sweepExtreme, intrabar: !!e.intrabar, bornAt: Number.isFinite(e.bornAt) ? e.bornAt : null, state: 'live', endWhy: null, endAt: null,   // r12: born mid-bar; r12.2: bornAt = when its evidence was in hand (the response; null if unknown)
        reqAt: Number.isFinite(e.reqAt) ? e.reqAt : null, seen: e.seen ? { ...e.seen } : null,   // r12.2: the request time, and the forming bar exactly as observed at birth (never its final OHLC)
        picked: false, fails: [], unknown: [], status: 'live', decidedAt: null, decisionSig: null, evalAt: null, prevEvalAt: null, blocks: {}, blockSeen: {}, lastBlock: null,
        lastBlockAt: null, attempts: 0, order: null, taken: null, unassessedWhy: null };
      events.set(id, r); bornToday++;
      if (events.size > maxEvents) { events.delete(events.keys().next().value); dropped++; }
    }
    return r;
  }
  const outcomeOf = r => (r.taken ? 'taken (filled)' : r.state === 'ended' ? `ended-untaken (${r.endWhy})${r.order ? `; last order ${r.order.stage}` : ''}`
    : r.order && !ORDER_FINAL.has(r.order.stage) ? `order ${r.order.stage}` : r.state === 'unassessed' ? 'unassessed' : 'live');
  const evRow = (phase, r, t, extra = {}) => ({ type: 'lv_event', t, v: VERSION, phase, id: r.id, tf: r.tf, level: r.name, price: r.price, ...(r.alsoNames ? { alsoNames: r.alsoNames } : {}), dir: r.dir, event: r.event,   // r13.3.4: every name at the price
    behavior: r.behavior, bornT: r.bornT, entry: r.entry, stop: r.stop, target: r.target, targetName: r.targetName, sweepExtreme: r.sweepExtreme, outcome: outcomeOf(r),
    ...(r.intrabar ? { intrabar: true, reqAt: r.reqAt, bornAt: r.bornAt, seen: r.seen } : {}),   // r12.2: an intrabar birth's provenance in every lifecycle row
    lastFails: r.fails.map(f => f.key), blocks: { ...r.blocks }, ...extra });

  // out = tracker.step() result, st = tracker.state(); returns the lifecycle rows for this poll
  function eventState(tf, out, st, t) {
    const rows = [];
    if (out && out.event) {
      const prevId = liveByTf[tf], prev = prevId ? events.get(prevId) : null, r = rec(out.event);
      if (prev && prev !== r && prev.state !== 'ended') {   // the tracker replaced it with a newer event on this timeframe
        prev.state = 'ended'; prev.endWhy = 'superseded-by-newer-event'; prev.endAt = t;
        rows.push(evRow('ended', prev, t, { why: prev.endWhy, by: r.id }));
      }
      r.state = 'live'; rows.push(evRow('born', r, t)); liveByTf[tf] = r.id;
    }
    const curId = liveByTf[tf], r = curId ? events.get(curId) : null;
    if (!r) return rows;
    if (out && out.live && eventId(out.live) === curId) {
      if (r.state === 'unassessed') { r.state = 'live'; rows.push(evRow('recertified', r, t)); }
    } else if (st && st.event && eventId(st.event) === curId) {
      // r6 (MacDot 6454908744 #4): ANY poll that does not certify the retained event makes it unassessed - a bar gap since birth, a stale acquisition, or no
      // evidence at all this poll; prior eligibility is never carried over
      const why = out && out.observed ? 'gap in the completed bars since birth' : out && out.stale ? `bars not current (${out.stale}) - nothing certified` : 'no bar evidence this poll';
      if (r.state !== 'unassessed') { r.state = 'unassessed'; r.unassessedWhy = why; r.status = 'unassessed'; rows.push(evRow('unassessed', r, t, { why })); }
    } else if (r.state !== 'ended') {
      r.state = 'ended';
      const ended = st && st.ended && eventId(st.ended.event) === curId ? st.ended : null;
      r.endWhy = ended ? ended.why : 'superseded'; r.endAt = ended ? ended.at : t;
      rows.push(evRow('ended', r, t, { why: r.endWhy }));
      delete liveByTf[tf];
    }
    return rows;
  }

  // picked = the trigger board the bot evaluated this poll (pickLevelsTrigger output); checklist = computeEntryChecklist() of that board;
  // gate (r12.6) = { htf: { dir, status, text, withTrade } | null, control: { known, side, score, min, exempt, contestedMinSize } | null } (the radar's gate reading)
  function decision(picked, checklist, t, gate) {
    gateNow = gate && typeof gate === 'object' ? { htf: gate.htf || null, control: gate.control || null, at: t } : null;
    const rows = [], pickedId = picked && picked.levelEvent ? eventId(picked.levelEvent) : null;
    lastPickedId = pickedId;
    const items = checklist && Array.isArray(checklist.items) ? checklist.items : null;
    for (const id of Object.values(liveByTf)) {
      const r = events.get(id); if (!r || r.state === 'ended' || r.taken) continue;
      r.prevEvalAt = r.evalAt; r.evalAt = t;
      let fails = [], unknown = [], status;
      if (r.state === 'unassessed') { status = 'unassessed'; fails = [{ key: 'unassessed', label: 'Event evidence current and unbroken', detail: r.unassessedWhy || 'not certified this poll' }]; }
      else if (id !== pickedId) { status = 'not-picked'; fails = [{ key: 'notPicked', label: 'Trigger chosen', detail: picked && picked.triggerTf ? `the ${picked.triggerTf} trigger${picked.inPlayLevel ? ` (${picked.inPlayLevel.name})` : ''} ranked first` : 'no trigger timeframe was picked this poll' }]; }
      else {
        fails = (items || []).filter(i => i && i.pass === false).map(i => ({ key: i.key, label: short(i.label, 80), detail: short(i.detail) }));
        // r10 (MacDot 6455780460 #2): computeEntryChecklist's contract - pass is true / false, or null for an INFORMATIONAL / not-applicable row that is never part of
        // its verdict (MAC info rows, session anchor, bias strength, news...). The verdict is the authority: unknown = no checklist, or WAITING with no failing row.
        unknown = !items || !checklist || (checklist.verdict !== 'WOULD ENTER' && checklist.verdict !== 'WAITING') ? [{ key: 'noChecklist', label: 'Entry checklist', detail: 'no checklist verdict for this poll' }]
          : checklist.verdict === 'WAITING' && !fails.length ? [{ key: 'waitingUnlisted', label: 'Checklist says WAITING', detail: 'held by a condition with no failing row (e.g. not flat)' }] : [];
        const blockedSince = r.lastBlockAt != null && r.prevEvalAt != null && r.lastBlockAt >= r.prevEvalAt;
        if (blockedSince) fails = fails.concat([{ key: `block:${r.lastBlock.code}`, label: `Blocked (${r.lastBlock.code})`, detail: r.lastBlock.reason }]);
        status = fails.length ? 'blocked' : unknown.length || checklist.verdict !== 'WOULD ENTER' ? 'unknown' : 'gates-clear';
      }
      r.picked = id === pickedId; r.fails = fails; r.unknown = unknown; r.status = status;
      for (const f of fails) { const g = gateTally.get(f.key) || { label: f.label || f.key, events: new Set() }; g.events.add(id); gateTally.set(f.key, g); }
      if (r.picked) r.everPicked = true;
      if (status === 'gates-clear') r.everClear = true;
      const sig = `${status}|${fails.map(f => f.key).join(',')}|${unknown.map(f => f.key).join(',')}`;
      if (sig !== r.decisionSig || r.decidedAt == null || t - r.decidedAt >= RE_DECIDE_MS) {
        r.decisionSig = sig; r.decidedAt = t;
        rows.push({ type: 'lv_decision', t, v: VERSION, id, tf: r.tf, level: r.name, price: r.price, dir: r.dir, ageMs: t - r.bornT, picked: r.picked, status,
          verdict: checklist && id === pickedId ? short(checklist.verdict, 60) : null, fails, unknown });
      }
    }
    return rows;
  }

  // r6 (#2): a block belongs to the event the bot picked (the board it evaluated), in that direction; nothing else is guessed. Every block revokes gates-clear
  // until a later decision passes with no new block; a row is written once per event + code per 15 min.
  function block(code, dir, data, t) {
    if (code === 'LEVELS_ONLY' && data && data.source === 'mac') return null;   // MAC-only candidates are not level decisions
    const r = lastPickedId ? events.get(lastPickedId) : null;
    if (!r || r.dir !== dir || r.state === 'ended' || r.taken) return null;
    r.lastBlockAt = t; r.lastBlock = { code, t, reason: short((data && (data.reason || data.text || data.why)) || null) };
    if (r.status === 'gates-clear') r.status = 'blocked';
    const bucket = Math.floor(t / 900000);
    if (r.blockSeen[code] === bucket) return null;
    r.blockSeen[code] = bucket; r.blocks[code] = (r.blocks[code] || 0) + 1;
    return { type: 'lv_block', t, v: VERSION, id: r.id, level: r.name, dir, code, reason: r.lastBlock.reason, source: (data && data.source) || null };
  }
  function attempt(proof, info, t) {
    const r = events.get(proofId(proof)); if (r) r.attempts++;
    return { type: 'lv_attempt', t, v: VERSION, id: proofId(proof), kind: proof.kind, level: proof.name, price: proof.price, dir: proof.dir, event: proof.event, ...info };
  }
  // r6 (#1): the hand-off registers the order by journalId; every later stage comes from the executor's own order journal points (FSM phase after the send,
  // the broker fill / reject / cancel, the paper book). Only 'filled' makes the event Taken; a refused / rejected / canceled order leaves it live.
  function handed(proof, info, t) {
    const id = proofId(proof), r = events.get(id), jid = info && info.journalId;
    if (jid) byJournal.set(jid, id);
    if (r) r.order = { stage: 'handed', t, journalId: jid || null, entryType: info.entryType || null, entry: info.entry, stop: info.stop, contracts: info.contracts, live: !!info.live };
    return { type: 'lv_order', t, v: VERSION, stage: 'handed', id, kind: proof.kind, level: proof.name, price: proof.price, dir: proof.dir, event: proof.event, sweepExtreme: proof.sweepExtreme, ...info };
  }
  function orderUpdate(journalId, stage, info, t) {
    const id = journalId ? byJournal.get(journalId) : null; if (!id) return null;
    const r = events.get(id), o = r && r.order;
    if (o && (o.stage === stage || ORDER_FINAL.has(o.stage))) return null;   // a final stage is final; repeats add nothing
    if (r) { r.order = { ...(o || {}), stage, t, ...(info || {}) }; if (stage === 'filled') r.taken = { t, entryType: r.order.entryType, entry: Number.isFinite(info && info.fill) ? info.fill : r.order.entry, stop: r.order.stop, contracts: r.order.contracts, journalId, live: r.order.live, paper: !!(info && info.paper) }; }
    return { type: 'lv_order', t, v: VERSION, stage, id, journalId, ...(info || {}) };
  }

  // r7 TRADE TAPE (display / journal only): one call per phone-snapshot write with the position exactly as the bot holds it. s = { phase (FSM phase, or the
  // paper equivalent), markers (the executor's getDisplayMarkers(): entry / stop / target lines per phase), px + pxT (the live price the loop already read,
  // and when), journalId (the trade's), entryTime, contracts, openPnl (LIVE only: the executor's own unrealized $), dayPnl, live, broker (LIVE: the broker's
  // round trips - entryTime / entryAvgPrice / exitPrice / exitTime / netPnl / closed) }. Nothing is inferred: a stop or target is recorded only as the bot
  // reported it, a price only as the loop read it, and a gap in polls stays a gap. A closed trade's RESULT comes only from the broker's round trip (LIVE) or
  // the paper book's day P&L change (PAPER) - never from the last price read before the close (a stop can fill far from it).
  const rtKey = b => `${b.contractId}|${b.entryTime}`;
  function trade(t, s) {
    // r8: a resting entry order is the bot's PLAN (entry / planned stop / planned targets exactly as the FSM or paper book holds them) - not a position
    pendingPlan = s && s.phase === 'PENDING_ENTRY' && s.markers && Number.isFinite(s.markers.dir) ? { t: pendingPlan && pendingPlan.dir === s.markers.dir ? pendingPlan.t : t, dir: s.markers.dir,
      lines: (s.markers.markers || []).filter(m => Number.isFinite(m.price)).map(m => ({ kind: m.kind, label: m.label, price: m.price })), journalId: s.journalId || null } : null;
    const rows = [], inTrade = !!(s && OPEN_PHASES.has(s.phase) && s.markers && Number.isFinite(s.markers.dir));
    // r10 (MacDot 6456332727): a price without its own read time is no evidence (never stamped "now"); one older than STALE_MS is stale
    const px = s && Number.isFinite(s.px) && Number.isFinite(s.pxT) ? s.px : null, pxT = px != null ? s.pxT : null, pxStale = px == null || t - pxT > STALE_MS;
    const mkEntry = inTrade ? ((s.markers.markers || []).find(m => m.kind === 'entry') || {}).price : null;
    // a different trade: another journalId, the other direction, or (no ids) another entry price - never merged into the open one
    const otherTrade = inTrade && openTrade && ((s.journalId && openTrade.journalId && s.journalId !== openTrade.journalId) || s.markers.dir !== openTrade.dir
      || (!(s.journalId && openTrade.journalId) && Number.isFinite(mkEntry) && openTrade.entry != null && mkEntry !== openTrade.entry));
    if (openTrade && (!inTrade || otherTrade)) {
      const o = openTrade; o.closedAt = t; o.dayPnlAtClose = s && Number.isFinite(s.dayPnl) ? s.dayPnl : null;
      o.phases.push([t, 'CLOSED', o.lastPx]); openTrade = null;
      rows.push({ type: 'lv_trade', t, v: VERSION, phase: 'close', key: o.key, journalId: o.journalId, eventId: o.eventId, lastReadPx: o.lastPx, mfe: r2(o.mfe), mae: r2(o.mae), live: o.live,
        paperPnl: !o.live && o.dayPnlAtClose != null && o.dayPnlAtOpen != null ? r2(o.dayPnlAtClose - o.dayPnlAtOpen) : null }); save(replayRecord(o, t));
    }
    // LIVE: settle each closed trade from the broker's round trip (same match rule as the executor's enrichTradesWithJournal: direction, entry within 0.26
    // pt, entry within 5 min of the fill the bot recorded), once
    // r10: only a VERIFIED trade (journalId + recorded entry time + contract) settles, against a round trip on the SAME contract, and each round trip once
    const unsettled = o => o.live && o.closedAt && !o.exit && o.entry != null && o.verified && o.contractId;
    const settle = o => { const rt = s.broker.find(b => b && b.closed && b.contractId === o.contractId && !settledRt.has(rtKey(b)) && b.dir === o.dir && Number.isFinite(b.exitPrice)
        && Math.abs((Number.isFinite(b.entryAvgPrice) ? b.entryAvgPrice : b.entryPrice) - o.entry) <= 0.26 && Math.abs(new Date(b.entryTime).getTime() - o.openedAt) <= 5 * 60000);
      if (!rt) return null; settledRt.add(rtKey(rt));
      return { price: r2(rt.exitPrice), t: new Date(rt.exitTime).getTime(), entryAvg: Number.isFinite(rt.entryAvgPrice) ? r2(rt.entryAvgPrice) : o.entry, netPnl: Number.isFinite(rt.netPnl) ? rt.netPnl : null, size: rt.maxSize || null, src: 'broker', rt: rtKey(rt) }; };
    if (s && Array.isArray(s.broker)) {
      for (const o of trades) {
        if (!unsettled(o)) continue;
        const ex = settle(o); if (!ex) continue; o.exit = ex;
        rows.push({ type: 'lv_trade', t, v: VERSION, phase: 'settled', key: o.key, journalId: o.journalId, exit: o.exit }); save(replayRecord(o, t));
      }
      // r11: a trade closed before a restart settles from its saved record, by the same rule, once
      for (const rec of [...saved.values()]) {
        if (!unsettled(rec) || trades.some(o => o.key === rec.key)) continue;
        const ex = settle(rec); if (!ex) continue;
        const pts = r2(rec.dir > 0 ? ex.price - ex.entryAvg : ex.entryAvg - ex.price);
        rows.push({ type: 'lv_trade', t, v: VERSION, phase: 'settled', key: rec.key, journalId: rec.journalId, exit: ex, restored: true });
        save({ ...rec, exit: ex, settled: 'broker', netPnl: ex.netPnl, pts, r: rec.risk ? r2(pts / rec.risk) : null, savedAt: t });
      }
    }
    feed1m(t, s, rows);   // lv1 r13.3.3 bars1m: closed trades keep collecting until their window ends (the bot polls when flat too)
    if (!inTrade) return rows;
    const mk = s.markers.markers || [], entryM = mk.find(m => m.kind === 'entry');
    if (!openTrade) {
      const jid = s.journalId || null, evId = jid ? byJournal.get(jid) || null : null, ev = evId ? events.get(evId) : null;
      const stops0 = mk.filter(m => m.kind === 'stop' && Number.isFinite(m.price)), verified = !!(jid && Number.isFinite(s.entryTime));
      // the FROZEN initial risk: the stop handed with this order (level entries), else the first reported stop if seen within a minute of the recorded fill
      // in leg 1; an adopted / unmatched position, or a later (tightened) stop, never sets it - R is then unavailable
      const handedStop = ev && ev.order && ev.order.journalId === jid && Number.isFinite(ev.order.stop) ? ev.order.stop : null;
      const stop0 = !verified ? null : handedStop != null ? handedStop : s.phase === 'LEG1_OPEN' && stops0.length && t - s.entryTime <= 60000 ? stops0[0].price : null;
      openTrade = { key: jid || `t${t}`, journalId: jid, eventId: evId, dir: s.markers.dir, entry: entryM && Number.isFinite(entryM.price) ? entryM.price : null,
        verified, openedAt: verified ? s.entryTime : t, seenAt: t, contracts: Number.isFinite(s.contracts) ? s.contracts : null, live: !!s.live, contractId: s.contractId || null,
        qty: [], stop0, stop0Src: stop0 == null ? null : handedStop != null ? 'order plan' : 'first FSM stop at the fill', level: ev ? { name: ev.name, price: ev.price, event: ev.event, sweepExtreme: ev.sweepExtreme, bornT: ev.bornT, tf: ev.tf } : null,
        stops: {}, targets: {}, phases: [[t, s.phase, pxStale ? null : px]], px: [], lastPx: null, mfe: 0, mae: 0,   // r10: the last price is set only from an accepted read (fresh, after the fill)
        lastSig: null, openPnl: null, dayPnlAtOpen: Number.isFinite(s.dayPnl) ? s.dayPnl : null };
      const prior = jid ? saved.get(jid) : null;
      if (prior && !prior.closedAt && prior.dir === openTrade.dir && prior.entry === openTrade.entry && Number.isFinite(prior.openedAt)) {
        // r11: the bot restarted mid-trade - the saved tape (reads, stop / target paths, phases, frozen risk) carries on; nothing before the restart is re-invented
        Object.assign(openTrade, { openedAt: prior.openedAt, verified: openTrade.verified && !!prior.verified, stop0: prior.stop0, stop0Src: prior.stop0Src, level: prior.level || openTrade.level,
          eventId: prior.eventId || evId, px: (prior.px || []).slice(), stops: JSON.parse(JSON.stringify(prior.stops || {})), targets: JSON.parse(JSON.stringify(prior.targets || {})),
          qty: (prior.qty || []).slice(), mfe: Number.isFinite(prior.mfe) ? prior.mfe : 0, mae: Number.isFinite(prior.mae) ? prior.mae : 0, resumed: t,
          phases: (prior.phases || []).concat([[t, 'RESTART', null]], openTrade.phases) });
        for (const bag of [openTrade.stops, openTrade.targets]) for (const path of Object.values(bag)) { const last = path[path.length - 1]; if (last && last[2] !== 'ended') path.push([t, last[1], 'ended']); }
      }
      trades.push(openTrade); if (trades.length > maxTrades) trades.shift();
      rows.push({ type: 'lv_trade', t, v: VERSION, phase: 'open', key: openTrade.key, journalId: jid, eventId: evId, dir: openTrade.dir, entry: openTrade.entry, stop: openTrade.stop0,
        targets: mk.filter(m => m.kind === 'target').map(m => [m.label, m.price]), contracts: openTrade.contracts, live: openTrade.live, level: openTrade.level, px, verified, contractId: openTrade.contractId });
    }
    const o = openTrade;
    if (o.entry == null && entryM && Number.isFinite(entryM.price)) o.entry = entryM.price;
    if (o.phases[o.phases.length - 1][1] !== s.phase) { o.phases.push([t, s.phase, px]); rows.push({ type: 'lv_trade', t, v: VERSION, phase: 'phase', key: o.key, journalId: o.journalId, to: s.phase, px }); }
    // stop / target lines: a step path per label, a point only when the bot's reported value changes (FLATTENING reports no stops: the last ones stay drawn, ended)
    if (s.phase !== 'FLATTENING') {
      const live = new Set();
      for (const m of mk) {
        if ((m.kind !== 'stop' && m.kind !== 'target') || !Number.isFinite(m.price)) continue;
        const bag = m.kind === 'stop' ? o.stops : o.targets, path = bag[m.label] || (bag[m.label] = []);
        live.add(m.kind + m.label);
        const last = path[path.length - 1];
        if (!last || last[1] !== m.price || last[2] === 'ended') path.push([t, m.price]);
      }
      for (const [kind, bag] of [['stop', o.stops], ['target', o.targets]]) for (const [lab, path] of Object.entries(bag)) { const last = path[path.length - 1]; if (!live.has(kind + lab) && last && last[2] !== 'ended') path.push([t, last[1], 'ended']); }
      const sig = JSON.stringify(mk.filter(m => m.kind !== 'entry').map(m => [m.label, m.price]));
      if (o.lastSig !== null && sig !== o.lastSig) rows.push({ type: 'lv_trade', t, v: VERSION, phase: 'lines', key: o.key, journalId: o.journalId, lines: mk.filter(m => m.kind !== 'entry').map(m => [m.label, m.price]), px });
      o.lastSig = sig;
    }
    // the open quantity exactly as the bot reports it (FSM legs / paper book), a point on each change
    if (Number.isFinite(s.openQty) && (!o.qty.length || o.qty[o.qty.length - 1][1] !== s.openQty)) o.qty.push([t, s.openQty]);
    o.pxStale = pxStale;
    // a read from before the fill, or a stale read, is not an observation of this trade
    if (px != null && !pxStale && pxT >= o.openedAt && (!o.px.length || o.px[o.px.length - 1][0] < pxT)) {
      o.px.push([pxT, px]); o.lastPx = px;
      if (o.px.length > maxPx) o.px = o.px.filter((_, i) => i % 2 === 0 || i === o.px.length - 1);   // halve the resolution, keep the newest
    }
    if (o.entry != null) {
      const fav = q => (o.dir > 0 ? q - o.entry : o.entry - q);
      for (const [, q] of o.px.slice(-1).filter(() => !pxStale)) { o.mfe = Math.max(o.mfe, fav(q)); o.mae = Math.min(o.mae, fav(q)); }
      for (const b of bars5) if (b[0] >= o.openedAt && b[0] + 300000 <= t) { o.mfe = Math.max(o.mfe, fav(o.dir > 0 ? b[2] : b[3])); o.mae = Math.min(o.mae, fav(o.dir > 0 ? b[3] : b[2])); }   // completed 5m bars wholly inside the trade
    }
    o.openPnl = s.live && Number.isFinite(s.openPnl) ? s.openPnl : null;
    if (!(t - (o.savedT || 0) < 120000)) { o.savedT = t; save(replayRecord(o, t)); }   // r11: an open trade is saved every 2 min (a restart keeps its tape)
    feed1m(t, s, rows);
    return rows;
  }
  // lv1 r13.3.3 bars1m (display / journal only; MacReel's what-ifs and hindsight grade): each trade's completed 1m bars [t, o, h, l, c] from its fill minute to
  // min(its close + 60 min, 13:05 PT), collected from the executor's own 1m reads (s.m1: the last 3 bars each poll; nothing fetched here). A bar counts once a
  // later bar is in the same read (final when the broker built it). A minute never seen (polls more than 2 min apart, a restart) is listed in bars1mGaps.
  // Written only into the closing / settled replay records, one final record when the window ends, and today's trades in the snapshot (never the 2-min saves).
  const M1 = 60000, SESSION_END_MIN = 13 * 60 + 5;
  function m1End(o) {
    if (!o.closedAt) return Infinity;
    let end = o.closedAt + 60 * M1;
    if (typeof ptMinutesFn === 'function') { const m = ptMinutesFn(o.closedAt); if (Number.isFinite(m) && m < SESSION_END_MIN) end = Math.min(end, o.closedAt - (o.closedAt % M1) + (SESSION_END_MIN - Math.floor(m)) * M1); }
    return end;
  }
  function feed1m(t, s, rows) {
    const read = s && Array.isArray(s.m1) ? s.m1.filter(b => b && [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite)) : [];
    const lastT = read.length ? Math.max(...read.map(b => b.t)) : -Infinity, done = read.filter(b => b.t < lastT && b.t + M1 <= t);
    for (const o of trades) {
      if (o.m1Final || !Number.isFinite(o.openedAt)) continue;
      const from = o.openedAt - (o.openedAt % M1), end = m1End(o);
      if (!o.m1) o.m1 = new Map();
      for (const b of done) if (b.t >= from && b.t + M1 <= end) o.m1.set(b.t, [b.t, b.o, b.h, b.l, b.c]);
      if (o.closedAt && t >= end) { o.m1Final = true; save(replayRecord(o, t)); }   // the window is over: one last record with every bar
    }
  }
  function bars1mOf(o) {
    if (!o || !o.m1 || !Number.isFinite(o.openedAt)) return {};
    const bars = [...o.m1.values()].sort((a, b) => a[0] - b[0]), from = o.openedAt - (o.openedAt % M1), gaps = [];
    let next = from;
    for (const b of bars) { if (b[0] > next) gaps.push([next, b[0] - M1]); next = b[0] + M1; }   // [first missing minute, last missing minute]
    const end = m1End(o);
    return { bars1m: bars, bars1mGaps: gaps, bars1mTo: Number.isFinite(end) ? end : null, bars1mFinal: !!o.m1Final };
  }
  // r11 SAVED REPLAYS: one self-contained record per trade - the trade as the phone draws it, its own completed 5m candles (150 min run-up, never a bar
  // completed after the close / the save) and the named levels nearest the entry - so it replays the same after a restart, an update or a day roll
  function replayRecord(o, t) {
    const v = tradeView(o, o.closedAt || t, false), end = o.closedAt || t, from = o.openedAt - 150 * 60000, board = lastScan['5m'] || lastScan['3m'];
    const px = v.px.length > 100 ? v.px.filter((_, i, a) => i % Math.ceil(a.length / 100) === 0 || i === a.length - 1) : v.px;   // the snapshot carries these: kept small
    const near = l => (Number.isFinite(o.entry) ? Math.abs(l.price - o.entry) : 0);
    const levels = board ? board.levels.map(([name, price, code]) => ({ name, price, code })).filter(l => Number.isFinite(l.price)).sort((a, b) => near(a) - near(b)).slice(0, 12) : [];
    return { ...v, px, mfe: o.mfe, mae: o.mae, bars: bars5.filter(b => b[0] + 300000 > from && b[0] + 300000 <= end).slice(-72), levels, day, savedAt: t, resumed: o.resumed || null, ...(o.closedAt ? bars1mOf(o) : {}) };   // r13.3.3: bars1m only once closed
  }
  function save(rec) {
    saved.delete(rec.key); saved.set(rec.key, rec); while (saved.size > maxSaved) saved.delete(saved.keys().next().value);
    outbox.push({ type: 'lv_replay', t: rec.savedAt, v: VERSION, rec }); if (outbox.length > 50) outbox.shift();
  }
  function takeReplays() { return outbox.splice(0); }   // the executor drains these to trade-replays-<SYMBOL>.jsonl after each trade tick
  // start-up: the records the executor read back from its file (newest row per key); round trips they already used stay used
  function loadSaved(recs) {
    let n = 0;
    for (const r of (Array.isArray(recs) ? recs : []).filter(r => r && typeof r.key === 'string' && (r.dir === 1 || r.dir === -1) && Number.isFinite(r.openedAt)).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))) {
      saved.delete(r.key); saved.set(r.key, r); n++; if (r.exit && r.exit.rt) settledRt.add(r.exit.rt);
    }
    while (saved.size > maxSaved) saved.delete(saved.keys().next().value);
    return n;
  }
  function savedRows() { return [...saved.values()].map(rec => ({ type: 'lv_replay', t: rec.savedAt, v: VERSION, rec })); }
  function tradeView(o, now, full) {
    if (!o) return null;
    const risk = o.entry != null && o.stop0 != null ? Math.abs(o.entry - o.stop0) : null;
    // open: the live read; closed: ONLY the broker's average exit (LIVE) - a paper close carries its $ result (paperPnl) and no invented exit price
    const last = o.closedAt ? (o.exit ? o.exit.price : null) : o.lastPx, base = o.exit ? o.exit.entryAvg : o.entry;
    const pts = base != null && last != null ? r2(o.dir > 0 ? last - base : base - last) : null;
    const px = full ? o.px : o.px.filter((_, i, a) => a.length <= 240 || i % Math.ceil(a.length / 240) === 0 || i === a.length - 1);
    return { key: o.key, journalId: o.journalId, eventId: o.eventId, dir: o.dir, entry: o.entry, stop0: o.stop0, stop0Src: o.stop0Src, contracts: o.contracts, live: o.live, src: o.live ? 'FSM' : 'paper',
      verified: o.verified, contractId: o.contractId, qty: o.qty, openQty: o.qty.length ? o.qty[o.qty.length - 1][1] : null, priceStale: !o.closedAt && !!o.pxStale,
      openedAt: o.openedAt, seenAt: o.seenAt, closedAt: o.closedAt || null, level: o.level, phase: o.phases[o.phases.length - 1][1], phases: o.phases, stops: o.stops, targets: o.targets, px,
      lastPx: o.closedAt || o.pxStale ? null : o.lastPx, lastReadPx: o.lastPx, exit: o.exit || null, settled: o.closedAt ? (o.live ? (o.exit ? 'broker' : 'awaiting-broker') : 'paper') : null, pts, r: risk && pts != null ? r2(pts / risk) : null, risk: risk != null ? r2(risk) : null, mfe: r2(o.mfe), mae: r2(o.mae), mfeR: risk ? r2(o.mfe / risk) : null, maeR: risk ? r2(o.mae / risk) : null,
      openPnl: o.closedAt ? null : o.openPnl, netPnl: o.exit ? o.exit.netPnl : null, paperPnl: o.closedAt && !o.live && o.dayPnlAtClose != null && o.dayPnlAtOpen != null ? r2(o.dayPnlAtClose - o.dayPnlAtOpen) : null, ageMin: Math.round(((o.closedAt || now) - o.openedAt) / 60000) };
  }

  // r12.6 (Mac 10/28: "why with price being so bullish is the bot ready to short?"): whether the entry gates would let a trigger in direction dir through NOW -
  // the HTF alignment's direction and the 15m control side, as the executor read them at its latest decision (stale after STALE_MS = unknown). htf / control:
  // 'with' | 'aligned' (r12.5 rule: any full alignment) | 'against' | 'mixed' | 'contested' | 'contested-min' | 'exempt' | 'unknown' | 'off'. ok: true / false / null (unknown).
  function gateFor(dir, now) {
    const g = gateNow, stale = !g || !Number.isFinite(now) || g.at > now || now - g.at > STALE_MS, w = dir > 0 ? 'LONG' : 'SHORT', why = [];   // r12.6.1: a reading from the future is not current either
    if (stale) return { htf: 'unknown', control: 'unknown', ok: null, why: ['gate reading not current'] };
    let htf = 'off', control = 'off';
    if (g.htf) {
      const a = g.htf.dir, txt = g.htf.text ? ` (${g.htf.text})` : '';
      htf = g.htf.status !== 'CURRENT' ? 'unknown' : a === dir ? 'with' : a === 0 ? 'mixed' : g.htf.withTrade ? 'against' : 'aligned';
      if (htf === 'unknown') why.push('HTF alignment unknown');
      else if (htf === 'mixed') why.push(`HTF not aligned${txt}: no ${w} until all three agree with it`);
      else if (htf === 'against') why.push(`HTF ${a > 0 ? 'bullish' : 'bearish'}${txt}: a ${w} is against it`);
    }
    if (g.control) {
      const c = g.control, sc = Number.isFinite(c.score) ? ` (${c.score > 0 ? '+' : ''}${c.score.toFixed(2)})` : '';
      control = c.exempt ? 'exempt' : !c.known ? 'unknown' : c.side === dir ? 'with' : c.side === 0 ? (c.contestedMinSize ? 'contested-min' : 'contested') : 'against';
      if (control === 'unknown') why.push('15m control unknown (no valid reading)');
      else if (control === 'contested') why.push(`15m control contested${sc}, line ±${c.min}: no entry`);
      else if (control === 'against') why.push(`${c.side > 0 ? 'buyers' : 'sellers'} in control${sc}: a ${w} is against it`);
    }
    const bad = s => s === 'against' || s === 'mixed' || s === 'contested';
    return { htf, control, ok: bad(htf) || bad(control) ? false : htf === 'unknown' || control === 'unknown' ? null : true, why };
  }

  // ARMED LEVELS (display): for each level near price, the exact bar that would make it a trigger and what is still missing. A level ABOVE price arms a
  // LONG sweep-reclaim (a 5m close above it, after the run since the last close above traded SWEEP_PTS below it); a level BELOW price arms a SHORT
  // sweep-loss (mirror). Conditions mirror lib/levelEvent.js; the hierarchy and the entry gates still apply after the trigger (see lv_decision).
  // r12.6: each row carries gateFor(dir) - the HTF / control gates' current answer for that direction (the other entry gates still apply after them).
  // r13 (display): a level price BROKE (a 5m close through it after a close at/through it), HELD (every 5m close since beyond it), LEFT (traded RETEST_AWAY
  // beyond it) and has not come back since arms a BREAK-RETEST for the NEXT 5m bar - lib/levelEvent.js retestOf one bar ahead, on the 5m bars and the
  // level's first usable bar as the scans showed it. VWAP never (it is not a retest level).
  function retestArm(name, price) {
    const B = bars5, n = B.length, known = usableSince.get(`${name}|${price}`);
    if (name === 'VWAP' || n < 2 || known === undefined) return null;
    const dir = B[n - 1][4] > price ? 1 : B[n - 1][4] < price ? -1 : 0; if (!dir) return null;
    const held = c => (dir > 0 ? c > price : c < price), lo = Math.max(1, n - Math.floor(RETEST_WINDOW_MS / M5));
    if (B[n - 1][0] < known) return null;
    let j = n - 1;
    while (j > lo && B[j][0] - B[j - 1][0] === M5 && B[j - 1][0] >= known && held(B[j - 1][4])) j--;
    const q = B[j - 1];
    if (!q || B[j][0] - q[0] !== M5 || q[0] < known || held(q[4])) return null;
    let d = -1;
    for (let x = j; x < n; x++) if (dir > 0 ? B[x][2] >= price + RETEST_AWAY : B[x][3] <= price - RETEST_AWAY) { d = x; break; }
    if (d < 0) return null;
    for (let x = d + 1; x < n; x++) if (dir > 0 ? B[x][3] <= price + RETEST_TOL : B[x][2] >= price - RETEST_TOL) return null;
    const left = dir > 0 ? Math.max(...B.slice(j, n).map(b => b[2])) - price : price - Math.min(...B.slice(j, n).map(b => b[3]));
    return { dir, breakT: B[j][0], departT: B[d][0], left: r2(left) };
  }
  function armed(px, now, retestOn = false) {
    const sc = lastScan['5m']; if (!sc || !Number.isFinite(px) || !bars5.length) return [];
    const out = [];
    // r13.3: the 5m sweep event still live at the NEXT bar's close (live or unassessed, younger than PERSIST_MS then) - the tracker births no retest while it lives
    const lid = liveByTf['5m'], lr = lid ? events.get(lid) : null, nextT = bars5[bars5.length - 1][0] + M5;
    const sweepOn = lr && lr.state !== 'ended' && lr.event !== 'BREAK-RETEST' && nextT - lr.bornT < PERSIST_MS ? lr : null;
    for (const [name, price, , , , beh, usable, weekly] of sc.levels) {
      if (Math.abs(price - px) > armedPts) continue;
      // r10 (MacDot 6455162843): the tracker needs the PREVIOUS completed close on the other side (long: at/below the level, short: at/above), so the radar's
      // direction comes from the last completed close - a level the last bar already closed above can only arm a SHORT next bar, whatever the live price
      const lastC = bars5[bars5.length - 1][4], dir = lastC < price ? 1 : lastC > price ? -1 : (price > px ? 1 : -1);
      let lo = Infinity, hi = -Infinity;   // the run since price last CLOSED on the trigger side of the level (newest backwards)
      for (let i = bars5.length - 1; i >= Math.max(0, bars5.length - 11); i--) { const [, , h, l, c] = bars5[i]; if (dir > 0 ? c > price : c < price) break; lo = Math.min(lo, l); hi = Math.max(hi, h); }   // the trigger bar itself is the 12th of SWEEP_LOOKBACK
      const swept = dir > 0 ? lo <= price - SWEEP_PTS : hi >= price + SWEEP_PTS;
      const labelOk = !!weekly || (beh || []).some(b => (dir > 0 ? LONG_BEH : SHORT_BEH).includes(b));
      const need = [];   // a missing sweep is NOT a blocker: the trigger bar itself can sweep (trade through) and then close back across - the trigger text says so
      if (!labelOk) need.push(`a Levels PRO ${dir > 0 ? 'long' : 'short'} label at it (now ${(beh || []).join(' / ') || 'none'})`);
      if (!usable) need.push('more time on the board (level too new: known only from the first bar after the poll that first showed it)');
      const sweepTo = (dir > 0 ? price - SWEEP_PTS : price + SWEEP_PTS).toFixed(2);
      out.push({ name, price, dir, dist: Math.round((price - px) * 100) / 100, trigger: swept ? `a 5m close ${dir > 0 ? 'above' : 'below'} ${price.toFixed(2)}` : `a 5m bar that trades ${dir > 0 ? 'down' : 'up'} to ${sweepTo} and closes back ${dir > 0 ? 'above' : 'below'} ${price.toFixed(2)}`, swept, labelOk, usable, armed: !need.length, need, beh: beh || [], weekly: !!weekly, gates: gateFor(dir, now) });
      const ra = retestOn ? retestArm(name, price) : null;
      if (ra) {   // r13: the same level may also arm a BREAK-RETEST (the other side of it)
        const bs = beh || [], rOk = !!weekly || (bs.some(b => (ra.dir > 0 ? RETEST_LONG_BEH : RETEST_SHORT_BEH).includes(b)) && !bs.some(b => b === 'CHOP' || (ra.dir > 0 ? SHORT_BEH : LONG_BEH).includes(b)));
        const rNeed = rOk ? [] : [`a Levels PRO label at it that is not against a ${ra.dir > 0 ? 'long' : 'short'} and not CHOP (now ${bs.join(' / ') || 'none'})`];
        if (sweepOn) rNeed.push(`the live ${sweepOn.dir > 0 ? 'long' : 'short'} sweep at ${sweepOn.name} ${sweepOn.price} to end first (a retest never replaces a live sweep)`);   // r13.3
        out.push({ name, price, dir: ra.dir, kind: 'retest', dist: Math.round((price - px) * 100) / 100,
          trigger: `a 5m bar that comes back to ${(ra.dir > 0 ? price + RETEST_TOL : price - RETEST_TOL).toFixed(2)} and closes ${ra.dir > 0 ? 'at or above' : 'at or below'} ${(price + ra.dir * RETEST_HOLD).toFixed(2)}`,
          broke: true, left: ra.left, breakT: ra.breakT, departT: ra.departT, labelOk: rOk, usable: true, armed: !rNeed.length, need: rNeed, beh: bs, weekly: !!weekly, gates: gateFor(ra.dir, now),
          sweepLive: sweepOn ? { name: sweepOn.name, price: sweepOn.price, dir: sweepOn.dir, bornT: sweepOn.bornT } : null });
      }
    }
    return out.sort((a, b) => (b.armed - a.armed) || Math.abs(a.dist) - Math.abs(b.dist)).slice(0, 8).map(o => withT(o, o.name, sc.at));   // r13.3.4: + levelT
  }

  // The phone panel: what is live and why it is / is not tradable now, the level map, today's events with outcomes, and the near-misses.
  // journal = the executor's writer state ({ rows, capped, fails }): r6 exposes a capped / failing journal instead of a silently short one
  // pxT (r12.6, MacDot 6462423447): the start of the 1m bar the price px was read from - the phone carries px into the live 5m candle only inside that candle's period
  function snapshot(now, px, journal, pxT, opts = {}) {
    const list = [...events.values()];
    const view = r => withT({ id: r.id, tf: r.tf, level: r.name, price: r.price, ...(r.alsoNames ? { alsoNames: r.alsoNames } : {}), dir: r.dir, event: r.event, behavior: r.behavior, bornT: r.bornT, ageMin: Math.round((now - r.bornT) / 60000),
      entry: r.entry, stop: r.stop, target: r.target, targetName: r.targetName, intrabar: r.intrabar, bornAt: r.bornAt, reqAt: r.reqAt, seen: r.seen, state: r.state, outcome: outcomeOf(r), endWhy: r.endWhy, picked: r.picked,
      status: r.taken ? 'filled' : r.state === 'ended' ? 'ended' : r.state === 'unassessed' ? 'unassessed' : r.status, unassessedWhy: r.state === 'unassessed' ? r.unassessedWhy : null,
      fails: r.fails.slice(0, 6), unknown: (r.unknown || []).slice(0, 6), lastBlock: r.lastBlock, blocks: { ...r.blocks }, order: r.order, taken: r.taken }, r.name, r.bornT);   // r13.3.4: + levelT
    const board = (lastScan['5m'] || lastScan['3m']);
    const ranked = board ? board.levels.map(([name, price, code, dist, dir, beh]) => ({ name, price, code, dist: Number.isFinite(px) ? Math.round((px - price) * 100) / 100 : dist, dir, beh }))
      .sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist)).slice(0, maxBoard) : [];
    return { v: VERSION, day, at: now, px: Number.isFinite(px) ? px : null, pxT: Number.isFinite(px) && Number.isFinite(pxT) ? pxT : null,
      live: Object.values(liveByTf).map(id => events.get(id)).filter(Boolean).filter(r => r.state !== 'ended').map(view),
      events: list.slice().reverse().map(view),
      misses: misses.slice().reverse(),
      board: { tf: board ? board.tf : null, barT: board ? board.barT : null, levels: ranked },
      counts: { events: list.length, taken: list.filter(r => r.taken).length, endedUntaken: list.filter(r => r.state === 'ended' && !r.taken).length, live: Object.keys(liveByTf).length },
      window: { retained: list.length, max: maxEvents, dropped, bornToday },   // r6: the counts above cover the RETAINED events (newest maxEvents), not the whole day
      journal: journal ? { rows: journal.rows || 0, capped: journal.capped || 0, fails: journal.fails || 0 } : null,
      // r5 display extras: the ladder's candles, the armed-levels radar, and where today's triggers died (funnel + the gates that held them)
      bars: bars5.slice(),
      // r12.5: the live 5m candle (never one already completed); r12.6 (MacDot 6462423447): only while its own 5 minutes are running at `now` (never a future one, never after its end)
      forming: forming5 && (!bars5.length || forming5[0] > bars5[bars5.length - 1][0]) && forming5[0] <= now && now < forming5[0] + 300000 ? forming5.slice() : null,
      armed: armed(Number.isFinite(px) ? px : (bars5.length ? bars5[bars5.length - 1][4] : NaN), now, !!(opts && opts.retest === true)),   // r13: retest rows only when the bot's retest switch is on
      gate: gateNow ? { htf: gateNow.htf, control: gateNow.control, at: gateNow.at, long: gateFor(1, now), short: gateFor(-1, now) } : null,   // r12.6: the radar header
      funnel: { born: list.length, picked: list.filter(r => r.everPicked || r.taken).length, clear: list.filter(r => r.everClear || r.taken).length,
        attempted: list.filter(r => r.attempts > 0 || r.taken).length, handed: list.filter(r => r.order || r.taken).length, taken: list.filter(r => r.taken).length },
      trade: { open: tradeView(openTrade, now, true), today: trades.map(o => (o.closedAt ? { ...tradeView(o, now, false), ...bars1mOf(o) } : tradeView(o, now, false))), pending: pendingPlan, saved: savedView() },   // r13.3.3: + bars1m on today's closed trades   // r7: the live position tape + today's trades (replayable)
      gates: [...gateTally.entries()].map(([key, g]) => ({ key, label: g.label, events: g.events.size })).sort((a, b) => b.events - a.events).slice(0, 8) };
  }

  // r11: the saved trades not already in today's live list, newest first - the newest savedFull carry their chart data, older ones a summary (all stay on disk)
  function savedView() {
    const today = new Set(trades.map(o => o.key)), list = [...saved.values()].filter(r => !today.has(r.key)).reverse();
    return { count: saved.size, max: maxSaved, list: list.map((r, i) => (i < savedFull ? { ...r, chart: true } : { key: r.key, savedAt: r.savedAt, day: r.day, dir: r.dir, entry: r.entry, openedAt: r.openedAt, closedAt: r.closedAt,
      level: r.level, pts: r.pts, r: r.r, netPnl: r.netPnl, paperPnl: r.paperPnl, settled: r.settled, verified: r.verified, live: r.live, mfeR: r.mfeR, ageMin: r.ageMin, chart: false })) };
  }
  return { roll, seedBars, seedForming, loadSaved, savedRows, takeReplays, scan, eventState, decision, block, attempt, handed, orderUpdate, trade, snapshot };
}

// r13.1 (Mac 10/28 06:01 PT screenshot: "Stage, invalidation, & close mechanism either need to be fixed or removed"): HOW A TRADE ENDED, read from the
// trade_manage rows the bot already journals (display only; never read by a trading decision). The base trade-why index (lib/tradeWhy.js) names only a
// stop / whole-TP1 / fill-through-stop / flatten close; under the scale-out and the no-progress exit most trades end another way and read "not recorded".
// Facts only, each from its own row: the no-progress exit (best seen vs needed), a session-close flatten, a TP1 partial and what the rest did (runner trail
// stop out, profit lock, or flat with its stop at the recorded level). Nothing is inferred from the result's sign; nothing recorded = null (no line).
// r13.3 (MacDot 6470325875): (1) missing later evidence says "exit not recorded", never that the rest is open; (2) NO_PROGRESS_EXIT / SESSION_FLATTEN are
// requests until a confirmation row at or after the request; (3) rows are kept in time order (rows without a time are dropped), exact duplicates once; a
// confirmation counts only at/after its request, trail rows only up to the closing row; with the broker trade's own times (get(id, { entryMs, exitMs,
// closed })) rows before entry - 60 s or after its last fill + 120 s are not this trade's, and a closing row more than 120 s from that fill is not recorded.
// (4) The journalId itself comes from the executor's heuristic broker-trade <-> entry-row match (direction, price within a tick, 5 min, unique): these time
// checks narrow it but do not prove broker identity.
const EXIT_CODES = new Set(['TP1_FILLED', 'TRAIL_RATCHET', 'RUNNER_STOPPED', 'NO_PROGRESS_EXIT', 'NO_PROGRESS_FLAT_CONFIRMED', 'SESSION_FLATTEN', 'SESSION_FLAT_CONFIRMED', 'PROFIT_LOCK_CASH', 'POSITION_CLOSED']);
const EXIT_PRE_MS = 60000, EXIT_POST_MS = 120000;
function createExitIndex(cap = 300) {
  const byId = new Map(), fin = v => typeof v === 'number' && Number.isFinite(v), n2 = v => (fin(v) ? Number(v).toFixed(2) : null);
  function index(e) {
    if (!e || typeof e !== 'object' || e.type !== 'trade_manage' || typeof e.journalId !== 'string' || !e.journalId || !EXIT_CODES.has(e.code) || !fin(e.t)) return;   // r13.3: no time = no causal place
    const txt = typeof e.text === 'string' ? e.text : '', qty = (txt.match(/(?:TP1 filled: (?:all )?|so )(\d+) contracts?/) || [])[1];
    const x = { code: e.code, t: e.t, tp1: fin(e.tp1) ? e.tp1 : null, be: fin(e.be) ? e.be : null, to: fin(e.to) ? e.to : null, stop: fin(e.stop) ? e.stop : null,
      best: fin(e.bestPts) ? e.bestPts : null, need: fin(e.mfePts) ? e.mfePts : null, reason: typeof e.reason === 'string' ? e.reason : null, qty: qty ? Number(qty) : null, whole: /TP1 filled: all /.test(txt) };
    x.key = JSON.stringify(x);
    let r = byId.get(e.journalId);
    if (r && r.some(y => y.key === x.key)) return;   // r13.3: the same row twice (file seed + live feed) counts once
    if (!r) { r = []; byId.set(e.journalId, r); while (byId.size > cap) byId.delete(byId.keys().next().value); }
    let k = r.length; while (k > 0 && r[k - 1].t > x.t) k--;   // r13.3: time order (equal times keep arrival order)
    r.splice(k, 0, x);
    if (r.length > 40) r.shift();   // the oldest by time
  }
  function get(id, at = {}) {
    const R0 = byId.get(id); if (!R0 || !R0.length) return null;
    const a = at && typeof at === 'object' ? at : {}, closedAt = a.closed === true && fin(a.exitMs) ? a.exitMs : null;
    const lo = fin(a.entryMs) ? a.entryMs - EXIT_PRE_MS : -Infinity, hi = closedAt !== null ? closedAt + EXIT_POST_MS : Infinity;
    const R = R0.filter(x => x.t >= lo && x.t <= hi); if (!R.length) return null;   // r13.3: outside the broker trade's own window = not this trade's
    const closing = x => !!x && (closedAt === null || Math.abs(x.t - closedAt) <= EXIT_POST_MS);   // r13.3: a closing row must agree with the broker's last fill
    const last = (code, from = -Infinity) => { for (let k = R.length - 1; k >= 0; k--) if (R[k].code === code && R[k].t >= from) return R[k]; return null; };
    const best = np => `best ${fin(np.best) ? (np.best >= 0 ? '+' : '') + np.best.toFixed(2) : '?'} pts by the first full 5m close after the fill (needs +${fin(np.need) ? np.need : '?'})`;
    const np = last('NO_PROGRESS_EXIT');
    if (np) { const fl = last('NO_PROGRESS_FLAT_CONFIRMED', np.t), ok = closing(fl);
      return ok ? { kind: 'no-progress', at: fl.t, line: `No-progress exit: ${best(np)}, closed at market` }
        : { kind: 'no-progress-requested', at: np.t, line: `No-progress exit requested at market: ${best(np)} · flat not confirmed` }; }
    const se = last('SESSION_FLATTEN');
    if (se) { const fl = last('SESSION_FLAT_CONFIRMED', se.t), why = se.reason ? ` (${se.reason})` : '';
      return closing(fl) ? { kind: 'session', at: fl.t, line: `Session close: flattened at market${why}` } : { kind: 'session-requested', at: se.t, line: `Session close: flatten requested at market${why} · flat not confirmed` }; }
    const ti = R.findIndex(x => x.code === 'TP1_FILLED' && !x.whole); if (ti < 0) return null;   // a whole-position TP1 / stop / flatten: the base close facts name it
    const tp = R[ti], after = R.slice(ti + 1), parts = [`TP1: ${tp.qty != null ? tp.qty + 'x' : 'partial'} at ${n2(tp.tp1) || '?'}`];
    const rs0 = after.filter(x => x.code === 'RUNNER_STOPPED').pop(), pc0 = after.filter(x => x.code === 'POSITION_CLOSED').pop();
    const rs = closing(rs0) ? rs0 : null, pc = closing(pc0) ? pc0 : null, end = rs || pc, endT = end ? end.t : Infinity;
    const locks = after.filter(x => x.code === 'PROFIT_LOCK_CASH' && x.t <= endT); if (locks.length) parts.push(`profit lock closed ${locks.map(x => (x.qty != null ? x.qty + 'x' : '?')).join(' + ')} at market`);
    const tr = after.filter(x => x.code === 'TRAIL_RATCHET' && fin(x.to) && x.t <= endT).pop(), stopNow = tr ? tr.to : tp.be;   // r13.3: the stop AT the close, never a later row's
    if (rs) parts.push(`runner stopped out by its trailing stop at ${n2(rs.stop) || n2(stopNow) || '?'}`);
    else if (pc) parts.push(`the rest went flat with its stop at ${n2(stopNow) || '?'} (${tr ? 'trailed' : 'break-even'})`);
    else return { kind: 'tp1-partial', at: tp.t, line: parts.join(' · ') + ' · the rest: exit not recorded' };
    return { kind: 'tp1-then-rest', at: end.t, line: parts.join(' · ') };
  }
  return { index, get, size: () => byId.size };
}

module.exports = { createLevelPanel, createExitIndex, eventId, proofId, VERSION, MISS_CODES, ORDER_FINAL };
