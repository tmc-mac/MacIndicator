/* MacUI 2.0.9.23: v2src/feat-20918-r23.js = feat-20918-r22.js (the HTF draft) + (1) the warm-up state from tide.warm (r1.6) or tide.live false (r1.5.6): the card says
   'TIDE WARMING UP · n of N min', never 'no 4H control read'; (2) tide.day (r1.6: the WHOLE day file) feeds the TODAY line and the 4H control fallback, labelled
   'bot journal, whole day'; (3) the Trades tab: 'account day net, not a TIDE trade' (never 'Old path' under TIDE live), plus today's ACCOUNT trades (r1.6 account.fills
   tagged MANUAL, else the broker round trips the bot did not place) so today's card is never missing; (4) grade = a size tag, never a reason: the signal row shows
   gradeTags / gradeWaived as tags, the checklist's POINTS block becomes GRADE (neutral chips); (5) every UNKNOWN names its field. Mac 11/05. */
/* MacUI 2.0.9.22: v2src/feat-20918-r22.js = feat-20918-r2.js + QC-UI 2/3/5: 4H CONTROL since from tide.board.control.since (else barT), no invented zone text,
   a LAST REFUSAL line from the newest live grade_no_trade (zone from its setup_arm, waived gates), the 120-row ring note, board control when the control_form row is gone.
/* MacUI 2.0.9.19.2: v2src/feat-20918-r2.js = feat-20918.js + (A) one deterministic row source: the union of every lv_tide row this phone has seen this TradeDay
   (journal rows are immutable facts; a snapshot whose ring dropped or briefly lost rows can no longer flip the checklist), the 4H open from the fixed
   4H grid (never missing), (B) the last signal labelled apart from the current state, rows with rebuilt:true = "replayed during warm-up · not tradeable"
   (never NOT_FLAT, never counted as live). Mac's 01:08-01:09 PT screenshots. 2.0.9.18 (MacUI-N, Nov 4). TIDE, the new model, on the phone (sketch accepted by MacArthur 11/04).
   Display only: no request, no write to the bot, no timer of its own. It reads the snapshot the page already polls.
   Four parts:
   (1) the TIDE card on Now (above the Hour card): the mode (OFF / SHADOW / LIVE), the 4H control read and why, the setup stage
       (waiting for the failure / armed / retest / entered), the last signal (grade + points, entry / stop / TP1 / TP2, flat $ size and grade $ size);
   (2) the TIDE position (live): fill, stop asked vs acked, TP1 -> BE+1, ladder, TP2, R and $ now; a re-entry is its own trade;
   (3) Trades tab: an All / TIDE / Old path filter, TIDE rows tagged with grade and exit path, the TIDE day P&L and the old path's apart;
   (4) the TIDE alert strip at the top of Now (stop reject, no-stop / naked flatten, mode change): never a modal, OK clears it on this phone.
   Data: snapshot.tide (SNAPSHOT-CONTRACT v1: mode, rows = this TradeDay's lv_tide journal rows, position, trades, alerts). When the bot does
   not send it, only the mode is read from configLocal.overrides ("tide.mode") and every other TIDE value reads UNKNOWN ("TIDE details need
   bot update"). When neither is present, or the mode is off, NOTHING here touches the page: the old views stay byte-identical. */
(function () {
  'use strict';
  const U = window.macui || (window.macui = {});
  const fin = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = v => fin(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN (not sent)';
  const sg2 = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  const usd = v => fin(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN (no $ sent)';
  const F = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const hm = t => fin(t) ? F.format(new Date(t)).slice(0, 5) : '—', hms = t => fin(t) ? F.format(new Date(t)) : '—';
  const $ = id => document.getElementById(id), DOT = ' · ';
  const snapNow = () => { try { return (typeof lastSnapForPoll !== 'undefined' && lastSnapForPoll) || (typeof pcSnap !== 'undefined' && pcSnap) || null; } catch (e) { return null; } };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* per-phone convenience only */ } } };
  const PTS = [['trap', 'trap'], ['force', 'force'], ['volume', 'volume'], ['timing', 'timing'], ['impulse', 'impulse']];
  const sideOf = d => d === 1 ? 'LONG' : d === -1 ? 'SHORT' : null;
  const arrow = d => d === 1 ? '▲' : d === -1 ? '▼' : '';

  // ── the mode ──
  function overrideMode(d) {
    const o = d && d.configLocal && Array.isArray(d.configLocal.overrides) ? d.configLocal.overrides : [];
    const m = o.find(x => x && x.key === 'tide.mode'); if (m && m.to != null) return String(m.to);
    const t = o.find(x => x && x.key === 'tide' && x.to && typeof x.to === 'object'); return t && t.to.mode != null ? String(t.to.mode) : null;
  }
  function modeInfo(m) {
    const k = String(m == null ? '' : m).toLowerCase();
    if (k === 'off') return { key: 'off', word: 'OFF', sub: 'the bot trades the old path only' };
    if (k === 'shadow') return { key: 'shadow', word: 'SHADOW', sub: 'phone pushes only · no orders' };
    if (k === 'live' || k === 'only') return { key: 'live', word: 'LIVE', sub: 'orders ON · the old levels path takes no new entries' };
    if (k === 'add') return { key: 'live', word: 'LIVE · ADD', sub: 'TIDE orders ON beside the old path (mode "add")' };
    return { key: 'unknown', word: 'UNKNOWN', sub: m == null ? 'the bot did not report the mode' : `the bot reported mode "${String(m).slice(0, 24)}"` };
  }

  // ── the model: everything shown comes from one snapshot field or one journal row (named in each line's title) ──
  function model(d, now) {
    const T = d && d.tide && typeof d.tide === 'object' && !Array.isArray(d.tide) ? d.tide : null, om = overrideMode(d);
    if (T && modeInfo(T.mode).key === 'off') return null;   // TIDE off: nothing on the page (the old views byte-identical)
    if (!T) { if (om == null || om.toLowerCase() === 'off') return null; return { partial: true, mode: modeInfo(om), modeSrc: 'config-local.json (tide.mode)', dayKey: d && d.dayKey, alerts: [], trades: [], now, armed: [], rowsKnown: false, ctl: null, period: null, lastSignal: null, lastEnd: null }; }
    const M = { partial: false, mode: modeInfo(T.mode), modeSrc: 'snapshot tide.mode', version: T.version || null, engine: T.engine || null, sizing: T.sizing || null, dayKey: T.dayKey != null ? T.dayKey : d.dayKey };
    M.now = now; if (M.mode.key === 'off') return Object.assign(M, { off: true, alerts: [], trades: [] });
    const rows = Array.isArray(T.rows) ? rowsUnion(M.dayKey, T.rows) : null;
    M.rowsKnown = !!rows; const R = rows || [];
    // 2.0.9.22 (QC-UI): the raw row count (the bot's ring holds 120: at 120 the earliest rows are gone) and the board's control (its since is the bar time)
    M.rowsRaw = Array.isArray(T.rows) ? T.rows.length : null; M.boardCtl = T.board && typeof T.board === 'object' && T.board.control && typeof T.board.control === 'object' ? T.board.control : null;
    // 2.0.9.23: the warm-up (r1.6 tide.warm: rebuilding, doneMin / totalMin, startedAt; r1.5.6: tide.live false with an empty ring and no engine = rebuilding, no counter)
    { const w = T.warm && typeof T.warm === 'object' ? T.warm : null;
      if (w && w.rebuilding === true) M.warm = { on: true, done: fin(w.doneMin) ? w.doneMin : null, total: fin(w.totalMin) ? w.totalMin : null, startedAt: fin(w.startedAt) ? w.startedAt : null, src: 'tide.warm' };
      else if (!w && T.live === false && M.mode.key === 'live' && (!Array.isArray(T.rows) || !T.rows.length) && !T.engine) M.warm = { on: true, done: null, total: null, startedAt: null, src: 'tide.live false, no rows, no engine (r1.5.6 sends no counter)' };
      else M.warm = null;
      M.dayFile = T.day && typeof T.day === 'object' && !T.day.error ? T.day : null;   // r1.6: the WHOLE on-disk TradeDay journal summarised (not the 120-row ring)
      M.acct = d && d.account && typeof d.account === 'object' ? d.account : null; }   // r1.6: the account's own day (fills the bot did or did not place)
    // 4H control: the last control_form, unless a newer 4H period started or a control_* end row came after it
    let ctl = null, period = null, ctlEnd = null;
    for (const r of R) {
      if (r.phase === 'control_form') { ctl = r; ctlEnd = null; }
      else if (r.phase === 'period') period = r;
      else if (/^control_(end|lost|flip|cancel|undone|expire)/.test(String(r.phase))) { ctlEnd = r; }
    }
    M.period = period;
    if (ctl && ((period && period.t > ctl.t) || (ctlEnd && ctlEnd.t > ctl.t))) { M.ctlGone = period && period.t > ctl.t ? { why: `new 4H candle from ${period.start ? String(period.start).slice(-5) : hm(period.t)} PT: control re-reads`, t: period.t } : { why: String(ctlEnd.why || ctlEnd.event || ctlEnd.phase), t: ctlEnd.t }; ctl = null; }
    M.ctl = ctl;
    // setups and their latest step
    const S = new Map(); const setup = id => { if (!S.has(id)) S.set(id, { id, arm: null, retest: null, rejection: null, grade: null, signal: null, end: null, last: null }); return S.get(id); };
    for (const r of R) {
      const id = r.setup; if (!id) continue; const s = setup(id); s.last = r;
      if (r.phase === 'setup_arm') { s.arm = r; s.end = null; }
      else if (r.phase === 'retest') s.retest = r; else if (r.phase === 'rejection') s.rejection = r;
      else if (r.phase === 'grade_live' || r.phase === 'grade_no_trade') s.grade = r;
      else if (r.phase === 'signal') s.signal = r;
      else if (r.phase === 'setup_cancel' || r.phase === 'setup_expire') s.end = r;
    }
    const live = [...S.values()].filter(s => s.arm && !s.end && !s.signal && !(s.grade && s.grade.phase === 'grade_no_trade' && s.grade.t >= s.arm.t)).sort((a, b) => b.arm.t - a.arm.t);
    M.armed = live;
    M.lastEnd = [...S.values()].filter(s => s.end || (s.grade && s.grade.phase === 'grade_no_trade')).map(s => s.end && (!s.grade || s.end.t >= s.grade.t) ? s.end : s.grade).sort((a, b) => b.t - a.t)[0] || null;
    // 2.0.9.22 (QC-UI): the newest LIVE refusal (grade_no_trade, not rebuilt) with its setup's zone, and a setup -> zone map for the tape's detail lines
    M.zoneOf = {}; for (const s of S.values()) if (s.arm && s.arm.zone) M.zoneOf[s.id] = String(s.arm.zone);
    // r1.5.6 HTF context (contract addendum): board.htf and the setup / signal rows' htf tag. Absent on an older bot: nothing drawn.
    M.htf = T.board && typeof T.board === 'object' && T.board.htf && typeof T.board.htf === 'object' ? T.board.htf : null;
    M.htfOf = {}; for (const s of S.values()) { const r = [s.signal, s.grade, s.arm].find(x => x && (x.htf === 'with' || x.htf === 'against' || x.htf === 'neutral')); if (r) M.htfOf[s.id] = { htf: r.htf, dir: fin(r.htfDir) ? r.htfDir : null, riskMult: fin(r.riskMult) ? r.riskMult : null }; }
    { const g0 = R.filter(r => r.phase === 'grade_no_trade' && r.rebuilt !== true).sort((a, b) => b.t - a.t)[0] || null; M.lastRefusal = g0 ? { r: g0, zone: M.zoneOf[g0.setup] || null } : null; }
    // signals and TIDE trades
    const sigsAll = R.filter(r => r.phase === 'signal'), sigs = sigsAll.filter(r => r.rebuilt !== true); M.replayed = sigsAll.length - sigs.length;
    M.lastSignal = sigs[sigs.length - 1] || null; M.lastReplay = sigsAll.filter(r => r.rebuilt === true).slice(-1)[0] || null; M.signals = sigs;
    const rb = R.filter(r => r.phase === 'rebuild').slice(-1)[0] || null; M.rebuild = rb;
    const exits = new Map(); for (const r of R) if (r.phase === 'shadow_exit' && r.id && r.rebuilt !== true) exits.set(r.id, r);
    M.position = M.mode.key === 'live' && T.position && typeof T.position === 'object' ? normPos(T.position, d) : null;
    if (M.position && ['FLAT', 'DONE'].includes(String(M.position.phase))) M.position = null;
    if (M.mode.key === 'live') {
      M.positionKnown = 'position' in T; M.tradesKnown = Array.isArray(T.trades);
      M.trades = (M.tradesKnown ? T.trades : []).filter(x => x && typeof x === 'object').map(x => liveTrade(x, sigs)).sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
    } else {
      M.trades = sigs.filter(s => s.taken === true).map(s => simTrade(s, exits.get(s.id) || null, d)).sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
    }
    M.simOpen = M.mode.key === 'shadow' ? M.trades.filter(t => t.open).slice(-1)[0] || null : null;
    M.held = M.simOpen ? M.simOpen.id : M.position ? M.position.signalId || null : null;
    // stage
    const a0 = live[0];
    if (M.position || M.simOpen) M.stage = { k: 'entered', text: M.position ? '' : 'a SIMULATED trade is open (no order)' };
    else if (M.warm) M.stage = { k: 'none', text: `warm-up in progress: the 6-hour book rebuilds first${M.dayFile ? ' (the day file keeps today\'s rows)' : ''}` };   // 2.0.9.23
    else if (T.board && typeof T.board === 'object' && Array.isArray(T.board.levels)) {   // Mac 01:45 PT: with a board, the stage is the board's (rows = history only)
      const bl = T.board.levels.filter(l => l && fin(l.price)), rp = bl.filter(l => l.state === 'retest-pending'), ar = bl.filter(l => l.state === 'armed'), pick = rp[0] || ar[0] || null;
      M.stage = pick ? { k: rp.length ? 'retest' : 'armed', text: `${pick.name || 'level'} ${px(pick.price)}: ${rp.length ? 'retest pending' : 'armed'}${rp.length + ar.length > 1 ? ' · ' + (rp.length + ar.length - 1) + ' more' : ''} (tide.board)` }
        : { k: 'wait', text: 'no setup armed (tide.board)' };
      M.armed = []; }
    else if (a0) { const rt = a0.retest && a0.retest.t >= a0.arm.t; M.stage = { k: rt ? 'retest' : 'armed', setup: a0, text: rt ? `retest ${a0.retest.n ? '#' + a0.retest.n + ' ' : ''}at ${a0.arm.zone || 'the level'}${fin(a0.retest.wick) ? ' (wick ' + px(a0.retest.wick) + ')' : ''}: waiting for the defended close` : `${a0.arm.zone || 'level'} ${fin(a0.arm.level) ? px(a0.arm.level) : ''} ${a0.arm.kind === 'failed-break' ? 'trap' : a0.arm.kind || ''}: ${a0.arm.note || 'waiting for the retest'}` }; }
    else if (ctl) M.stage = { k: 'wait', text: `waiting for the move against ${ctl.dir === -1 ? 'the sellers' : 'the buyers'} to fail at a level` };
    else M.stage = { k: 'none', text: M.warm ? `warm-up in progress: the 6-hour book rebuilds first${M.dayFile ? ' (the day file keeps today\'s rows)' : ''}` : M.rowsKnown ? (M.ctlGone ? M.ctlGone.why : 'no 4H control read yet this TradeDay') : 'UNKNOWN: the snapshot has no tide.rows' };
    // alerts: tide.alerts + any alert intent in a live_step row (deduped by time + code)
    const al = new Map(); const addA = (t, code, level, text, src) => { if (!fin(t) || !code) return; const k = t + '|' + code; if (!al.has(k)) al.set(k, { key: 'a:' + k, t, code: String(code), level: level || (/no-stop|naked|flatten|reject|reversed|looser|unknown/.test(code) ? 'critical' : 'warning'), text: text ? String(text) : '', src }); };
    if (Array.isArray(T.alerts)) for (const a of T.alerts) if (a) addA(a.t, a.code, a.level, a.text, 'snapshot tide.alerts');
    for (const r of R) if (r.phase === 'live_step' && Array.isArray(r.intents)) for (const i of r.intents) if (i && i.op === 'alert') addA(r.t, i.code, i.level, i.text, 'journal live_step');
    M.alerts = [...al.values()].sort((a, b) => a.t - b.t);
    // the day
    const closed = M.trades.filter(t => !t.open), rS = closed.map(t => t.resultR).filter(fin), uS = closed.map(t => t.usd);
    const liveOpen = M.position ? 1 : 0;
    M.day = { n: M.trades.length + liveOpen, closed: closed.length, open: M.trades.length - closed.length + liveOpen, signals: sigs.length, R: rS.length === closed.length && closed.length ? rS.reduce((a, b) => a + b, 0) : closed.length ? null : 0,
      usd: closed.length ? (uS.every(fin) ? uS.reduce((a, b) => a + b, 0) : null) : 0, sim: M.mode.key !== 'live' };
    const acct = fin(d && d.dayPnlNet) ? { v: d.dayPnlNet, src: 'dayPnlNet' } : fin(d && d.dayPnl) ? { v: d.dayPnl, src: 'dayPnl' } : null;
    { const an = M.acct && fin(M.acct.dayNet) ? { v: M.acct.dayNet, src: 'account.dayNet' } : acct;
      M.old = !an ? { v: null, label: 'account day net', why: 'the snapshot has no day P&L (dayPnlNet / account.dayNet)' } : M.mode.key !== 'live' ? { v: an.v, label: 'account day net', why: `broker (${an.src}): TIDE sends no orders in shadow` }
        : { v: an.v, label: 'MacMillionz Bot day net', why: `broker (${an.src}) · closed trades only` }; }
    M.d = d; M.now = now; M.price = d && d.livePx && fin(d.livePx.price) ? { v: d.livePx.price, t: d.livePx.t, src: 'livePx' } : null;
    return M;
  }
  // the bot's r1.2 view() shape (tideLive.view, MacArthur 11/04: the terminal adapts, the bot is not renamed): tp1 / tp2 nested { price, qty, done, filled },
  // stopBy 'break-even', no pointValue (the snapshot's symbol: MNQ 2, MGC 10), no stopHist. The flat contract names still work.
  function normPos(P0, d) {
    const P = Object.assign({}, P0), t1 = P0.tp1 && typeof P0.tp1 === 'object' ? P0.tp1 : null, t2 = P0.tp2 && typeof P0.tp2 === 'object' ? P0.tp2 : null;
    if (P.tp1Px == null && t1) P.tp1Px = t1.price; if (P.tp1Qty == null && t1) P.tp1Qty = t1.qty; if (P.tp1Done == null && t1 && typeof t1.done === 'boolean') P.tp1Done = t1.done;
    if (t1 && fin(t1.filled)) P.tp1Filled = t1.filled; if (P.tp2Px == null && t2) P.tp2Px = t2.price; if (t2) { P.tp2Done = !!t2.done; if (fin(t2.filled)) P.tp2Filled = t2.filled; }
    if (P.stopBy === 'break-even') P.stopBy = 'be';
    if (!fin(P.pointValue)) { const sym = String(d && d.symbol || '').toUpperCase(); P.pointValue = sym === 'MNQ' ? 2 : sym === 'MGC' ? 10 : null; P.pvSrc = 'symbol ' + sym; }
    return P;
  }
  // (A) one deterministic row source: every lv_tide row seen this TradeDay (keyed by its own fields), so a snapshot whose ring evicted or briefly
  // lost a row cannot change the checklist backwards. A new TradeDay starts empty. Bounded (800 rows).
  const memo = { day: null, map: new Map(), dropped: 0 };
  function rowsUnion(day, list) {
    const dk = String(day);
    if (memo.day !== dk) { memo.day = dk; memo.map = new Map(); memo.dropped = 0; }
    let seen = 0;
    for (const r of list) { if (!r || typeof r !== 'object' || !fin(r.t)) continue; const k = JSON.stringify([r.t, r.phase, r.setup || null, r.id || null, r.event || null, r.failure || null, r.zone || null]);
      if (memo.map.has(k)) seen++; else memo.map.set(k, r); }
    if (memo.map.size > 800) { const keep = [...memo.map.entries()].sort((a, b) => a[1].t - b[1].t).slice(-800); memo.map = new Map(keep); }
    memo.dropped = Math.max(0, memo.map.size - list.length);
    return [...memo.map.values()].sort((a, b) => a.t - b.t);
  }
  function exitWord(why, tp1Done) {
    const w = String(why || '').toLowerCase();
    if (!w) return 'EXIT UNKNOWN (no exitPath)';
    if (w === 'tp2') return tp1Done ? 'TP1→TP2' : 'TP2';
    if (w === 'be-stop' || w === 'tp1-be' || w === 'be') return 'TP1→BE';
    if (w === 'stop') return 'STOP';
    if (w === 'ladder-stop' || w === 'ladder') return tp1Done ? 'TP1→LADDER' : 'LADDER';
    if (w === 'ladder-lock-crossed') return 'LADDER LOCK';
    if (/session/.test(w)) return 'FLATTEN 13:05';
    if (/no-stop|naked/.test(w)) return 'NO-STOP FLATTEN';
    if (/manual/.test(w)) return 'MANUAL';
    if (w === 'market') return 'MARKET EXIT';
    return w.toUpperCase().slice(0, 20);
  }
  function gradeOf(sig) { const p = sig && sig.plan, gd = p && p.gradeDetail; return { g: (p && p.grade) || (gd && gd.grade) || null, pts: gd && fin(gd.points) ? gd.points : null, names: gd && Array.isArray(gd.names) ? gd.names : [], cap: gd && gd.capTag || null }; }
  function simTrade(s, x, d) {
    const p = s.plan || {}, g = gradeOf(s), risk = fin(p.riskUsd) ? p.riskUsd : null;
    const t = { id: s.id, setup: s.setup, sim: true, dir: s.dir, grade: g.g, pts: g.pts, names: g.names, qty: fin(p.qty) ? p.qty : null, entry: fin(p.avgEntry) ? p.avgEntry : s.entry, stop0: p.stop,
      tp1: p.tp1 && p.tp1.price, tp2: p.tp2 && p.tp2.price, R: fin(p.R) ? p.R : null, level: s.level, kind: s.kind, openedAt: s.t, open: !x, risk };
    if (x) { t.closedAt = x.t; t.exit = x.exit; t.path = exitWord(x.why, x.tp1Done); t.resultR = fin(x.resultR) ? x.resultR : null; t.usd = fin(t.resultR) && fin(risk) ? t.resultR * risk : null; t.usdNote = 'sim: R × the plan risk'; }
    return t;
  }
  function liveTrade(x, sigs) {
    const s = sigs.find(r => r.id && (r.id === x.signalId || (x.setup && r.setup === x.setup))) || null, g = s ? gradeOf(s) : { g: null, pts: null, names: [] };
    return { id: x.id, setup: x.setup, sim: false, dir: x.dir, grade: x.grade || g.g, pts: fin(x.points) ? x.points : g.pts, names: Array.isArray(x.pointNames) ? x.pointNames : g.names, qty: fin(x.qty) ? x.qty : null,
      entry: x.avgEntry, exit: x.exitAvgPx, openedAt: x.openedAt, closedAt: x.closedAt, open: false, path: exitWord(x.exitPath, typeof x.tp1Done === 'boolean' ? x.tp1Done : /\btp1\b/.test(String(x.path || ''))), resultR: fin(x.resultR) ? x.resultR : null,
      usd: fin(x.netUsd) ? x.netUsd : fin(x.grossUsd) ? x.grossUsd : null, usdNote: fin(x.netUsd) ? 'broker net' : fin(x.grossUsd) ? 'gross: the net is not reconciled yet' : 'net not reconciled yet', fills: typeof x.path === 'string' ? x.path : null, level: s && s.level, kind: s && s.kind };
  }

  // ── rendering helpers (write only when changed: a settled card costs no DOM mutation on the 1 s beat) ──
  const last = {};
  function setHTML(el, key, h) { if (el && last[key] !== h) { el.innerHTML = h; last[key] = h; } }
  function badge(M) { return `<span class="fx18-mode" data-mode="${M.mode.key}"><span class="fx18-mdot" aria-hidden="true"></span>${esc(M.mode.word)}</span>`; }
  function gradeChip(g, pts) { const k = g === 'A+' ? 'a' : g === 'B' ? 'b' : g === 'C' ? 'c' : 'u'; return `<span class="fx18-g" data-g="${k}">${esc(g || 'grade ?')}${fin(pts) ? ` <i>${pts}/5</i>` : ''}</span>`; }
  function pointDots(names) {
    const has = n => names.some(x => String(x).toLowerCase().indexOf(n) === 0);
    const extra = names.filter(x => !PTS.some(([k]) => String(x).toLowerCase().indexOf(k) === 0));
    return PTS.map(([k, w]) => `<span class="fx18-pt${has(k) ? ' is-on' : ''}"><span aria-hidden="true">${has(k) ? '●' : '○'}</span>${esc(w)}</span>`).join('') + extra.map(x => `<span class="fx18-pt is-on is-x">+ ${esc(x)}</span>`).join('');
  }
  // 2.0.9.23 (Mac 11/05): the grade is a SIZE TAG, never a reason not to trade (r1.6: an HTF-aligned setup is never refused by its grade; flat $400 at every grade).
  // Tags from the signal row: gradeTags / plan.gradeTags (r1.6), gradeWaived / waived, the point names as plain tags. Nothing reads FAIL.
  function gradeRow(s, g) { const p = s.plan || {}, tags = [].concat(Array.isArray(s.gradeTags) ? s.gradeTags : Array.isArray(p.gradeTags) ? p.gradeTags : g.names.map(x => String(x))).map(x => String(x).toLowerCase());
    const wv = Array.isArray(s.gradeWaived) ? s.gradeWaived : Array.isArray(p.gradeWaived) ? p.gradeWaived : Array.isArray(s.waived) ? s.waived : [];
    return `<div class="fx18-pts fx23-tags"><span class="fx23-tag is-g" title="the grade sets the size tag only; it never refuses an HTF-aligned setup (r1.6)">grade ${esc(g.g || '?')} · size tag</span>${tags.map(t => `<span class="fx23-tag">${esc(t)}</span>`).join('')}${wv.map(t => `<span class="fx23-tag is-w">waived ${esc(t)}</span>`).join('')}${s.lane === 'trend' ? '<span class="fx23-tag is-l">trend lane</span>' : ''}</div>`; }
  const STAGES = [['wait', 'wait for fail'], ['armed', 'armed'], ['retest', 'retest'], ['entered', 'entered']];
  function rail(st) { const i = STAGES.findIndex(s => s[0] === st.k);
    return `<ol class="fx18-rail" aria-label="Setup stage: ${esc(st.k === 'none' ? 'no setup' : STAGES[i][1])}">` + STAGES.map(([k, w], j) => `<li class="${j < i ? 'is-done' : j === i ? 'is-now' : ''}"${j === i ? ' aria-current="step"' : ''}><span class="fx18-rd" aria-hidden="true"></span>${esc(w)}</li>`).join('') + '</ol>'; }
  function sizeLine(p) {
    const sh = p && p.shadow, used = sh && sh.used, gr = sh && sh.shadow;
    const a = used && fin(used.contracts) ? `${esc(used.mode || 'flat')} $${esc(used.budgetUsd)}: <b>${used.contracts} MNQ</b>` : p && fin(p.qty) ? `${esc(p.mode || '')} $${esc(p.budgetUsd)}: <b>${p.qty} MNQ</b>` : 'size UNKNOWN (no plan.qty on the row)';
    const b = gr && fin(gr.contracts) ? `${esc(gr.mode || 'grade')} ${esc(gr.grade || '')} $${esc(gr.budgetUsd)}: ${gr.contracts} MNQ <span class="fx18-dim">(logged only)</span>` : 'grade size: not on this row';
    return `${a}${DOT}${b}`;
  }
  // the signal's own time: row.at (the signal bar, bot r1.5) when present; a row's t is its journal WRITE time, which for a rebuilt:true row is the replay
  function sigTime(s) { const at = s && s.at; if (fin(at)) return hm(at > 1e11 ? at : at * 1000); if (typeof at === 'string' && /\d\d:\d\d$/.test(at)) return esc(at.slice(-5)); return s && s.rebuilt === true ? '· signal time not in the log' : hm(s.t); }
  function signalBox(M) {
    const s = M.lastSignal || M.lastReplay; if (!s) return `<div class="fx18-sig is-empty"><span class="fx18-k">LAST SIGNAL</span> ${M.rowsKnown ? 'none yet this TradeDay' : 'UNKNOWN: the snapshot has no tide.rows'}</div>`;
    const p = s.plan || {}, g = gradeOf(s), skip = p.skip, side = s.side || sideOf(s.dir) || 'UNKNOWN';
    const tag = M.mode.key === 'live' && s.shadow !== true ? '' : '<span class="fx18-sim">SIMULATED</span>';
    const tp1 = p.tp1 ? `TP1 <b>${px(p.tp1.price)}</b>${p.tp1.pool && p.tp1.pool.name ? ` <span class="fx18-dim">${esc(p.tp1.pool.name)}</span>` : ''}${p.tp1.qty === 0 ? ' <span class="fx18-dim">(1 lot: BE trigger)</span>' : fin(p.tp1.qty) ? ` <span class="fx18-dim">−${p.tp1.qty}</span>` : ''}` : 'TP1 UNKNOWN';
    const tp2 = p.tp2 ? `TP2 <b>${px(p.tp2.price)}</b>${fin(p.tp2.rr) ? ` <span class="fx18-dim">${p.tp2.rr.toFixed(2)}R${p.tp2.pool && p.tp2.pool.name ? ' · ' + esc(p.tp2.pool.name) : ''}</span>` : ''}` : 'TP2 UNKNOWN';
    const gate = s.rebuilt === true ? 'replayed during warm-up · not tradeable' : s.taken === true ? 'taken' : s.taken === false ? `not taken${s.gatesNow && s.gatesNow !== 'pass' ? ' (' + esc(s.gatesNow) + ')' : ''}` : '';
    return `<div class="fx18-sig" data-dir="${s.dir}" title="journal lv_tide signal ${esc(s.id || '')}">`
      + `<div class="fx18-sh"><span class="fx18-k">${s.rebuilt === true ? 'REPLAYED AT WARM-UP (not tradeable)' : 'LAST SIGNAL'} ${sigTime(s)}</span>${tag}</div>`
      + `<div class="fx18-sl"><span class="fx18-side" data-dir="${s.dir}">${arrow(s.dir)} ${esc(side)}</span>${gradeChip(g.g, g.pts)}${g.cap ? `<span class="fx18-cap">${esc(g.cap)}</span>` : ''}<span class="fx18-dim">${esc(s.level || '')}${s.kind === 'trap' ? ' trap' : s.kind ? ' ' + esc(s.kind) : ''}${gate ? DOT + gate : ''}</span></div>`
      + gradeRow(s, g)
      + (M.held && M.held === s.id ? '' : skip ? `<div class="fx18-ln">no trade: <b>${esc(skip)}</b>${fin(p.stop) ? ` · stop ${px(p.stop)}` : ''}${fin(p.stopPts) ? ` (${p.stopPts} pts)` : ''}</div>`
        : `<div class="fx18-ln">entry <b>${px(fin(p.avgEntry) ? p.avgEntry : s.entry)}</b>${DOT}stop <b>${px(p.stop)}</b> <span class="fx18-dim">${esc(p.stopTf || '')}${fin(p.stopPts) ? ', ' + p.stopPts + ' pts' : ''}</span></div>`
        + `<div class="fx18-ln">${tp1}</div><div class="fx18-ln">${tp2}</div>`)
      + `<div class="fx18-ln fx18-size">${sizeLine(p)}</div></div>`;
  }
  // 2.0.9.22 (QC-UI 2): the control's SINCE is the bar it formed on: tide.board.control.since first, else the row's barT; a rebuilt row's write time (t) is the
  // warm-up time, never shown as the since. A refusal line: "<gate> <metric> <got> < <limit>" from the grade_no_trade why ("waveBias: wavePeakBias gte 0.2 got 0.0842").
  function ctlSince(M) { const c = M.ctl, B = M.boardCtl; if (B && fin(B.since)) return { t: B.since, src: 'tide.board.control.since' }; if (c && fin(c.barT)) return { t: c.barT, src: 'row barT' }; if (c && c.rebuilt !== true && fin(c.t)) return { t: c.t, src: 'row t' }; return { t: null, src: c && c.rebuilt === true ? 'rebuilt row: no bar time' : 'UNKNOWN' }; }
  function refusalText(r) { const whys = Array.isArray(r.why) ? r.why : r.why ? [String(r.why)] : [];
    const one = w => { const m = String(w).match(/^(\w+):\s*(\w+)\s+(gte|gt|lte|lt|ge|le)\s+(-?[\d.]+)\s+got\s+(-?[\d.]+)/); return m ? `${m[1]} ${m[2]} ${m[5]} ${/^g/.test(m[3]) ? '<' : '>'} ${m[4]}` : String(w); };
    const gates = Object.keys(r.gates || {}).filter(k => r.gates[k] === false);
    return (whys.length ? whys.map(one).join(' · ') : gates.length ? 'failed ' + gates.join(', ') : 'gate UNKNOWN') + (Array.isArray(r.waived) && r.waived.length ? ' · waived ' + r.waived.join(', ') : ''); }
  function refusalLine(M) { const x = M.lastRefusal; if (!x) return ''; const r = x.r;
    return `<div class="fx18-ctl fx22-ref" title="journal lv_tide grade_no_trade ${hm(r.t)}"><span class="fx18-k">LAST REFUSAL</span> ${hm(fin(r.barT) ? r.barT : r.t)} ${esc(r.setup || '')}${x.zone ? ' ' + esc(x.zone) : ''}${DOT}${esc(refusalText(r))}</div>`; }
  // r1.5.6 HTF: the words. dir +1 ↑ / -1 ↓ / 0 —; the tag WITH HTF (green) / AGAINST HTF (amber) / nothing for neutral.
  function htfArrow(v) { return v === 1 ? '↑' : v === -1 ? '↓' : v === 0 ? '—' : ''; }
  function htfTag(x) { if (!x || x.htf === 'neutral' || !x.htf) return ''; return `<span class="fx22-htf" data-htf="${esc(x.htf)}">${x.htf === 'with' ? 'WITH' : 'AGAINST'} HTF ${htfArrow(x.dir)}${x.htf === 'against' && fin(x.riskMult) && x.riskMult < 1 ? ' · ' + x.riskMult + '× size' : ''}</span>`; }
  function htfLine(M) { const h = M.htf; if (!h || !fin(h.dir)) return ''; const p = h.prev4h, side = v => v === 1 ? 'above' : v === -1 ? 'below' : v === 0 ? 'at' : null;
    const parts = [p && fin(p.dir) ? `prior 4H ${htfArrow(p.dir)}${p.hh && !p.ll ? ' (HH)' : p.ll && !p.hh ? ' (LL)' : p.hh && p.ll ? ' (HH+LL)' : ''}` : null, h.cur4h && side(h.cur4h.side) ? `4H open ${side(h.cur4h.side)}` : null, h.daily && side(h.daily.side) ? `day open ${side(h.daily.side)}` : null].filter(Boolean);
    return `<div class="fx18-ctl fx22-htfl" data-dir="${h.dir}" title="tide.board.htf (the engine's own 4H bars)"><span class="fx18-k">HTF</span> <b>${htfArrow(h.dir)}</b>${parts.length ? DOT + parts.map(esc).join(DOT) : ''}</div>`; }
  // 2.0.9.23: the warm-up line (r1.6 tide.warm counter; r1.5.6: the fact alone). The journal is not empty: the day file has it (r1.6) or the ring refills as the bot runs.
  function warmLine(M) { const w = M.warm; if (!w) return ''; const n = fin(w.done) && fin(w.total) ? `${w.done} of ${w.total} min` : fin(w.startedAt) ? `started ${hm(w.startedAt)}` : 'no counter in this bot build (r1.5.6)';
    return `<div class="fx18-ctl fx23-warm" role="status" title="${esc(w.src)}"><span class="fx18-k">TIDE WARMING UP</span> <b>${esc(n)}</b>${fin(w.startedAt) && fin(w.done) ? DOT + 'started ' + hm(w.startedAt) : ''}<div class="fx18-why">rebuilding the 6-hour bias book; no live signal until it is done${M.dayFile ? DOT + `the day file keeps today's ${fin(M.dayFile.rows) ? M.dayFile.rows + ' ' : ''}rows` : DOT + 'the phone ring is empty until the rebuild ends'}</div></div>`; }
  function ringNote(M) { return fin(M.rowsRaw) && M.rowsRaw >= 120 ? `<div class="fx18-why fx22-ring">journal rows ${M.rowsRaw}/120${DOT}earliest dropped (the phone keeps what it saw)</div>` : ''; }
  function controlLine(M) {
    if (!M.rowsKnown && !M.boardCtl) return '<div class="fx18-ctl"><span class="fx18-k">4H CONTROL</span> UNKNOWN: the snapshot has no tide.rows</div>';
    const c = M.ctl; const o4 = M.period && fin(M.period.O4) ? `4H open ${px(M.period.O4)}` : null, B = M.boardCtl;
    if (!c && B && (B.dir === 1 || B.dir === -1) && !M.ctlGone) { const k = String(B.kind || ''); return `<div class="fx18-ctl" data-dir="${B.dir}" title="tide.board.control"><span class="fx18-k">4H CONTROL</span> <b class="fx18-who">${arrow(B.dir)} ${B.dir === -1 ? 'SELLERS' : 'BUYERS'}</b>${DOT}since ${fin(B.since) ? hm(B.since) : 'UNKNOWN'}<div class="fx18-why">${esc(k || 'kind not journaled')}${DOT}from tide.board (the control_form row is not in the snapshot)${o4 ? DOT + o4 : ''}</div></div>`; }
    { const DC = !c && !M.ctlGone && M.dayFile && M.dayFile.control && (M.dayFile.control.dir === 1 || M.dayFile.control.dir === -1) ? M.dayFile.control : null;   // 2.0.9.23: r1.6 tide.day.control (the whole day file) when the ring lost the row
      if (DC) return `<div class="fx18-ctl" data-dir="${DC.dir}" title="tide.day.control (the bot's whole TradeDay journal file)"><span class="fx18-k">4H CONTROL</span> <b class="fx18-who">${arrow(DC.dir)} ${DC.dir === -1 ? 'SELLERS' : 'BUYERS'}</b>${DOT}since ${fin(DC.since) ? hm(DC.since) : 'time not in the day file'}<div class="fx18-why">${esc(String(DC.kind || 'kind not journaled'))}${DOT}bot journal, whole day${o4 ? DOT + o4 : ''}</div></div>`; }
    if (!c) return `<div class="fx18-ctl" data-dir="0"><span class="fx18-k">4H CONTROL</span> <b>${M.warm ? 'rebuilding' : 'none'}</b>${DOT}${esc(M.warm ? 'read again when the warm-up ends' : M.ctlGone ? M.ctlGone.why : 'not formed this TradeDay')}${o4 ? DOT + o4 : ''}</div>`;
    const who = c.dir === -1 ? 'SELLERS' : c.dir === 1 ? 'BUYERS' : 'UNKNOWN', k = String(c.kind || '');
    const zone = c.zone || (typeof c.level === 'string' ? c.level : null), S0 = ctlSince(M);
    const why = /trap|fail/.test(k) ? (zone ? `failed break ${c.dir === -1 ? 'above' : 'below'} ${esc(zone)}${fin(c.price) ? ' ' + px(c.price) : ''}` : `trap${fin(c.ext) ? DOT + 'extreme ' + px(c.ext) : ''}`) : k === 'below' || k === 'above' ? `price ${k} the 4H open, ${c.dir === -1 ? 'seller' : 'buyer'} bias held` : esc(k || 'kind not journaled');
    const bias = [fin(c.s15) ? `15m ${sg2(c.s15)}` : null, fin(c.s30) ? `30m ${sg2(c.s30)}` : null].filter(Boolean).join(' / ');
    const trap = M.lastSignal && M.lastSignal.dir === c.dir && M.lastSignal.t >= c.t && M.lastSignal.kind === 'trap' && M.lastSignal.level && !(M.period && M.lastSignal.levelPrice === M.period.O4) ? `trap: ${esc(M.lastSignal.level)}${fin(M.lastSignal.levelPrice) ? ' ' + px(M.lastSignal.levelPrice) : ''}` : null;
    return `<div class="fx18-ctl" data-dir="${c.dir}" title="journal lv_tide control_form written ${hm(c.t)} · since: ${esc(S0.src)}"><span class="fx18-k">4H CONTROL</span> <b class="fx18-who">${arrow(c.dir)} ${who}</b>${DOT}since ${S0.t != null ? hm(S0.t) : 'UNKNOWN'}${bias ? DOT + bias : ''}<div class="fx18-why">${why}${o4 ? DOT + o4 : ''}${trap ? DOT + trap : ''}</div></div>`;
  }
  // the live (or simulated) position
  function posBlock(M) {
    const P = M.position, S = M.simOpen; if (!P && !S) return '';
    if (S) {
      const pr = M.price, rNow = pr && fin(S.entry) && fin(S.R) && S.R > 0 ? S.dir * (pr.v - S.entry) / S.R : null;
      return `<div class="fx18-pos is-sim" data-dir="${S.dir}"><div class="fx18-ph"><b>${arrow(S.dir)} ${esc(sideOf(S.dir))} ${fin(S.qty) ? S.qty + ' MNQ' : ''}</b>${gradeChip(S.grade, S.pts)}<span class="fx18-sim">SIM · NO ORDER</span></div>`
        + `<div class="fx18-pn"><span class="fx18-r">${fin(rNow) ? sg2(rNow) + 'R' : 'R UNKNOWN'}</span><span class="fx18-dim">at ${pr ? px(pr.v) : 'price UNKNOWN'} vs entry ${px(S.entry)} (calc from livePx)</span></div>`
        + ruler({ dir: S.dir, stop: S.stop0, entry: S.entry, tp1: S.tp1, tp2: S.tp2, price: pr && pr.v, tp1Done: null })
        + `<div class="fx18-ln fx18-dim">The shadow journals its BE / ladder stop moves only at the exit: the stop shown is the structural one.</div></div>`;
    }
    const d = P.dir, R = fin(P.R) && P.R > 0 ? P.R : null, lp = fin(P.lastPx) ? { v: P.lastPx, src: 'tide.position.lastPx' } : M.price ? { v: M.price.v, src: 'livePx' } : null;
    const open = fin(P.open) ? P.open : null, ent = fin(P.avgEntry) ? P.avgEntry : null;
    const rNow = lp && ent != null && R ? d * (lp.v - ent) / R : null;
    const pv = fin(P.pointValue) ? P.pointValue : null;
    const $now = fin(P.openUsd) ? { v: P.openUsd, note: 'the bot\'s open P&L' } : lp && ent != null && open != null && pv ? { v: d * (lp.v - ent) * open * pv, note: `calc: ${sg2(d * (lp.v - ent))} pts × ${open} × $${pv}` } : { v: null, note: 'needs lastPx, avgEntry, open and pointValue' };
    const acked = fin(P.stopAcked), same = acked && fin(P.stopAsked) && Math.abs(P.stopAcked - P.stopAsked) < 1e-9;
    const stopW = P.stopBy === 'be' ? 'BE+1' : P.stopBy === 'ladder' ? 'ladder lock' : P.stopBy === 'structural' ? 'structural' : '';
    const stopLn = acked ? `<span class="fx18-ok" aria-hidden="true">✓</span> stop <b>${px(P.stopAcked)}</b> acked${stopW ? ' · ' + stopW : ''}${fin(P.stopAsked) && !same ? ` <span class="fx18-warn">asked ${px(P.stopAsked)}: not acked yet</span>` : ''}`
      : `<span class="fx18-bad" aria-hidden="true">!</span> <b class="fx18-warn">stop NOT acked</b>${fin(P.stopAsked) ? ' · asked ' + px(P.stopAsked) : ' · no stop asked'}`;
    const tp1Ln = P.tp1Done === true ? `<span class="fx18-ok" aria-hidden="true">✓</span> TP1 ${px(P.tp1Px)} hit${fin(P.tp1Qty) && P.tp1Qty > 0 ? ` (−${P.tp1Qty})` : ' (1 lot: no partial)'} → stop BE+1` : P.tp1Done === false ? `<span aria-hidden="true">○</span> TP1 ${px(P.tp1Px)}${fin(P.tp1Qty) ? (P.tp1Qty > 0 ? ` takes ${P.tp1Qty}` : ' (1 lot: BE trigger)') : ''}` : 'TP1 UNKNOWN';
    const moves = Array.isArray(P.stopHist) ? Math.max(0, P.stopHist.length - 1) : null;
    const fill = `${fin(P.filledQty) ? P.filledQty : '?'}${fin(P.plannedQty) && P.plannedQty !== P.filledQty ? '/' + P.plannedQty : ''} filled ${hms(P.fillAt)} @ ${px(ent)}`;
    return `<div class="fx18-pos" data-dir="${d}" data-phase="${esc(P.phase || '')}" title="snapshot tide.position ${esc(P.id || '')}"><div class="fx18-ph"><b>${arrow(d)} ${esc(sideOf(d) || 'side UNKNOWN (no dir)')} ${open != null ? open + ' MNQ' : 'qty UNKNOWN (no open)'}</b>${gradeChip(P.grade, P.points)}${htfTag(M.htfOf[P.setup])}<span class="fx18-pphase">${esc(P.phase || 'phase UNKNOWN (not sent)')}</span></div>`
      + `<div class="fx18-pn"><span class="fx18-r" data-s="${fin(rNow) ? Math.sign(rNow) : 0}">${fin(rNow) ? sg2(rNow) + 'R' : 'R UNKNOWN'}</span><span class="fx18-usd" data-s="${fin($now.v) ? Math.sign($now.v) : 0}">${usd($now.v)}</span><span class="fx18-dim">${esc($now.note)}</span></div>`
      + `<div class="fx18-ln fx18-dim">${esc(fill)}${lp ? DOT + 'price ' + px(lp.v) : ''}${fin(P.best) ? DOT + 'best ' + px(P.best) : ''}</div>`
      + ruler({ dir: d, stop: acked ? P.stopAcked : P.stopAsked, entry: ent, tp1: P.tp1Px, tp2: P.tp2Px, price: lp && lp.v, tp1Done: P.tp1Done })
      + `<div class="fx18-ln">${stopLn}</div><div class="fx18-ln">${tp1Ln}</div><div class="fx18-ln">${P.tp2Done ? '<span class="fx18-ok" aria-hidden="true">✓</span> TP2 ' + px(P.tp2Px) + ' filled' : '<span aria-hidden="true">○</span> TP2 ' + px(P.tp2Px)}${moves != null ? DOT + `stop moves ${moves}` : ''}${fin(P.structuralStop) && P.stopBy !== 'structural' ? DOT + 'structural stop was ' + px(P.structuralStop) : ''}</div>`
      + (P.block ? `<div class="fx18-ln fx18-warn">BLOCK ${esc(P.block.code || '')}: ${esc(P.block.text || '')}</div>` : '')
      + (P.closing || P.flat ? `<div class="fx18-ln fx18-warn">CLOSING${P.flat ? ': ' + esc(P.flat.reason || '') + ' · ' + esc(P.flat.phase || '') : ''}</div>` : '') + '</div>';
  }
  function ruler(o) {
    const vals = [o.stop, o.entry, o.tp1, o.tp2, o.price].filter(fin); if (vals.length < 2) return '<div class="fx18-ln fx18-dim">price ruler: not enough levels</div>';
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.04 || 1; lo -= pad; hi += pad;
    const pos = v => ((o.dir === -1 ? hi - v : v - lo) / (hi - lo) * 100).toFixed(2);   // profit is always to the right
    const placed = []; const mk = (v, cls, w, lab) => { if (!fin(v)) return ''; const p = +pos(v), tight = placed.some(q => Math.abs(q - p) < 16); placed.push(p);
      return `<span class="fx18-m ${cls}${tight ? ' is-tight' : ''}" style="left:${p.toFixed(2)}%"><span class="fx18-mt">${w}</span><span class="fx18-mv">${tight ? '' : lab}</span></span>`; };
    return `<div class="fx18-ruler" role="img" aria-label="stop ${px(o.stop)}, entry ${px(o.entry)}, TP1 ${px(o.tp1)}, TP2 ${px(o.tp2)}, price ${px(o.price)}">`
      + `<span class="fx18-bar" aria-hidden="true"></span>`
      + mk(o.stop, 'is-stop', 'STOP', px(o.stop)) + mk(o.entry, 'is-entry', 'ENTRY', px(o.entry)) + mk(o.tp1, 'is-tp1' + (o.tp1Done ? ' is-hit' : ''), 'TP1', px(o.tp1)) + mk(o.tp2, 'is-tp2', 'TP2', px(o.tp2))
      + (fin(o.price) ? `<span class="fx18-dotp" style="left:${pos(o.price)}%" aria-hidden="true"></span>` : '') + '</div>';
  }
  function dayLine(M) {
    const D = M.day, r = fin(D.R) ? sg2(D.R) + 'R' : D.closed ? 'R UNKNOWN' : '0R';
    const DF = M.dayFile, tl = DF && DF.trend && typeof DF.trend === 'object' ? DF.trend : null;
    if (DF && DF.signals && typeof DF.signals === 'object') { const tr = DF.trades && typeof DF.trades === 'object' ? DF.trades : null;
      return `<div class="fx18-day" title="tide.day: the bot's whole TradeDay journal file, not the 120-row ring"><span><span class="fx18-k">TODAY</span> ${fin(DF.signals.live) ? DF.signals.live : '?'} live signal${DF.signals.live === 1 ? '' : 's'}${DOT}${fin(DF.signals.taken) ? DF.signals.taken : '?'} taken${fin(DF.signals.replayed) && DF.signals.replayed ? ` (+${DF.signals.replayed} replayed at warm-up)` : ''}${tl ? DOT + `trend lane armed ${tl.armed} · taken ${tl.taken} · skipped ${tl.skipped}` : ''}${DOT}${tr && tr.closed ? `<b>${tr.closed} closed ${usd(tr.netUsd)}</b> <span class="fx18-dim">bot journal</span>` : `none closed yet${D.open || M.position ? ` (${D.open || 1} open)` : ''}`}${fin(DF.restarts) && DF.restarts > 1 ? DOT + `${DF.restarts} starts today` : ''} <span class="fx18-dim">bot journal, whole day</span></span>`
        + `<span class="fx18-gos"><button type="button" class="fx18-go" data-fx18-go="cl">Checklist ›</button><button type="button" class="fx18-go" data-fx18-go="tide">Trades ›</button></span></div>`; }
    return `<div class="fx18-day"><span><span class="fx18-k">TODAY</span> ${D.signals} live signal${D.signals === 1 ? '' : 's'}${DOT}${D.n} taken${M.replayed ? ` (+${M.replayed} replayed at warm-up)` : ''}${D.open ? ` (${D.open} open)` : ''}${DOT}${D.closed ? `<b>${D.sim ? 'SIM ' : ''}${r} ${usd(D.usd)}</b>` : 'none closed yet'}${M.warm ? '' : ' <span class="fx18-dim">journal ring' + (M.rowsRaw != null && M.rowsRaw >= 120 ? ', full' : '') + '</span>'}</span>`
      + `<span class="fx18-gos"><button type="button" class="fx18-go" data-fx18-go="cl">Checklist ›</button><button type="button" class="fx18-go" data-fx18-go="tide">Trades ›</button></span></div>`;
  }
  function cardHTML(M) {
    const head = `<div class="fx18-hd"><span class="fx18-t">TIDE</span>${badge(M)}<span class="fx18-time"></span></div>`;
    if (M.partial) return head + `<div class="fx18-sub">${esc(M.mode.sub)}</div><div class="fx18-need"><b>TIDE details need bot update.</b> The mode comes from ${esc(M.modeSrc)}, applied at the last restart. This bot build does not put TIDE in its snapshot, so the 4H control, the setup stage, the signals and any TIDE position read UNKNOWN here. The pushes still come.</div>`;
    if (M.off) return head + `<div class="fx18-sub">${esc(M.mode.sub)}</div>`;
    const al = M.alerts.length ? `<details class="fx18-alog"><summary>${M.alerts.length} TIDE alert${M.alerts.length === 1 ? '' : 's'} today</summary>${M.alerts.slice().reverse().map(a => `<div class="fx18-ln" data-level="${esc(a.level)}">${hms(a.t)} <b>${esc(a.code)}</b> ${esc(a.text)}</div>`).join('')}</details>` : '';
    const rbx = M.rebuild, rbt = v => (fin(v) ? hm(v > 1e11 ? v : v * 1000) : typeof v === 'string' ? esc(v.slice(-5)) : null), rbn = rbx ? `<div class="fx18-why">warm-up replayed ${rbt(rbx.from) || '?'}–${rbt(rbx.to) || '?'}${fin(rbx.bars) ? ' · ' + rbx.bars + ' bars' : ''} <span class="fx18-dim">(not tradeable)</span></div>` : '';
    return head + `<div class="fx18-sub">${esc(M.mode.sub)}</div>` + warmLine(M) + rbn + controlLine(M) + htfLine(M) + refusalLine(M) + ringNote(M)
      + `<div class="fx18-stage" data-stage="${M.stage.k}"><span class="fx18-k">STAGE</span>${rail(M.stage)}${M.stage.setup ? htfTag(M.htfOf[M.stage.setup.id]) : M.armed && M.armed[0] ? htfTag(M.htfOf[M.armed[0].id]) : ''}${M.stage.text || M.armed.length > 1 ? `<div class="fx18-why">${esc(M.stage.text)}${M.armed.length > 1 ? (M.stage.text ? DOT : '') + `${M.armed.length - 1} more armed` : ''}</div>` : ''}</div>`
      + posBlock(M) + signalBox(M) + dayLine(M) + al;
  }
  // ── the alert strip (top of Now) ──
  function acks() { try { return new Set(JSON.parse(store.get('fx18-ack') || '[]')); } catch (e) { return new Set(); } }
  function ack(key) { const s = acks(); s.add(key); store.set('fx18-ack', JSON.stringify([...s].slice(-60))); }
  let modeAlert = null;
  function noteMode(M) {
    const k = String(M.dayKey) + '', cur = M.mode.word, prev = store.get('fx18-mode');
    if (prev && prev !== cur) modeAlert = { key: `m:${prev}>${cur}:${Date.now()}`, t: Date.now(), code: 'mode change', level: 'warning', text: `TIDE ${prev} → ${cur}`, src: 'phone (mode differs from the last one seen)' };
    if (prev !== cur) store.set('fx18-mode', cur); void k;
  }
  function stripHTML(M) {
    const A = acks(), list = M.alerts.concat(modeAlert ? [modeAlert] : []).filter(a => !A.has(a.key));
    // the bot's snapshot.position / openPnl describe the OLD path only (its state machine stays FLAT while TIDE holds a position): say so while it does
    const P = M.position, oldOpen = M.d && M.d.position && Array.isArray(M.d.position.markers) && M.d.position.markers.length;
    const held = P && !oldOpen ? `<div class="fx18-al fx18-held" data-level="info" role="status"><span class="fx18-ai" aria-hidden="true">●</span><div class="fx18-at"><b>TIDE POSITION OPEN · ${esc(sideOf(P.dir) || '')} ${fin(P.open) ? P.open + ' MNQ' : ''}</b><span>The Position card shows the old path only (FLAT there is the old path). This trade is in the TIDE card below.</span></div></div>` : '';
    if (!list.length) return held;
    return held + list.slice(-3).reverse().map(a => `<div class="fx18-al" data-level="${esc(a.level)}" role="${a.level === 'critical' ? 'alert' : 'status'}"><span class="fx18-ai" aria-hidden="true">▲</span><div class="fx18-at"><b>TIDE ALERT · ${esc(a.code)}</b><span>${esc(a.text || '')}${DOT}${hms(a.t)} PT</span></div><button type="button" class="fx18-ack" data-fx18-ack="${esc(a.key)}" aria-label="Clear this TIDE alert on this phone">OK</button></div>`).join('')
      + (list.length > 3 ? `<div class="fx18-more">${list.length - 3} more in the TIDE card</div>` : '');
  }
  // ── Trades tab ──
  function tradeRow(t) {
    const st = t.open ? 'OPEN' : t.path || 'EXIT UNKNOWN (no exitPath)';
    return `<li class="fx18-tr" data-dir="${t.dir}" data-open="${t.open ? 1 : 0}"><div class="fx18-tl"><span class="fx18-tt">${hm(t.openedAt)}</span><b>${arrow(t.dir)} ${esc(sideOf(t.dir) || '?')}${fin(t.qty) ? ' ' + t.qty + ' MNQ' : ''}</b>`
      + `<span class="fx18-tag">TIDE</span>${gradeChip(t.grade, t.pts)}${t.sim ? '<span class="fx18-sim">SIM</span>' : ''}<span class="fx18-tx" data-s="${fin(t.resultR) ? Math.sign(t.resultR) : 0}">${fin(t.resultR) ? sg2(t.resultR) + 'R' : t.open ? '' : 'R ?'}</span></div>`
      + `<div class="fx18-tl2"><span class="fx18-path" data-path="${esc(st)}">${esc(st)}</span> ${px(t.entry)}${t.open ? '' : ' → ' + px(t.exit)}${t.level ? DOT + esc(t.level) + (t.kind === 'trap' ? ' trap' : '') : ''}${t.open ? '' : DOT + `<b>${usd(t.usd)}</b> <span class="fx18-dim">${esc(t.usdNote || '')}</span>`}${t.fills ? `<div class="fx18-dim">${esc(t.fills)}</div>` : ''}${!t.open && !t.sim && t.id ? ` <button type="button" class="fx18-go fx23-rb" data-fx23-replay="${esc(t.id)}" aria-label="Replay this TIDE trade on the Levels chart (journal markers)">▶ Replay</button>` : ''}</div></li>`;
  }
  function tradesHTML(M) {
    const f = filt();
    const seg = `<div class="fx18-seg" role="group" aria-label="Show trades">${[['all', 'All'], ['tide', 'Bot journal'], ['old', 'Account']].map(([k, w]) => `<button type="button" class="fx18-fb" data-fx18-f="${k}" aria-pressed="${f === k}">${w}</button>`).join('')}</div>`;
    if (M.partial) return seg + `<div class="card fx18-tbox"><div class="fx18-k">TIDE TRADES</div><div class="fx18-need">UNKNOWN: TIDE details need bot update (mode ${esc(M.mode.word)} from config-local.json).</div></div>`;
    const D = M.day;
    const day = `<div class="fx18-tday"><span><span class="fx18-tag">TIDE</span> today <b>${D.sim ? 'SIM ' : ''}${fin(D.R) ? sg2(D.R) + 'R' : D.closed ? 'R UNKNOWN' : '0R'} ${usd(D.usd)}</b> <span class="fx18-dim">${D.closed} closed${D.open ? ', ' + D.open + ' open' : ''}</span></span>`
      + `<span>${esc(M.old.label)} <b>${usd(M.old.v)}</b> <span class="fx18-dim">${esc(M.old.why)}</span></span></div>`;
    const rowsT = M.position ? M.trades.concat([{ id: M.position.id, dir: M.position.dir, grade: M.position.grade, pts: M.position.points, qty: M.position.open, entry: M.position.avgEntry, openedAt: M.position.fillAt, open: true, sim: false }]) : M.trades;
    const list = rowsT.length ? `<ol class="fx18-tlist" aria-label="TIDE trades today, oldest first">${rowsT.map(tradeRow).join('')}</ol>` : `<div class="fx18-dim">${M.mode.key === 'live' && !M.tradesKnown ? 'UNKNOWN: the snapshot has no tide.trades' : 'No TIDE trade today.'}</div>`;
    return seg + `<div class="card fx18-tbox"><div class="fx18-k">TIDE TRADES · ${esc(M.mode.word)}</div>${day}${list}</div>` + acctBox(M);
  }
  // 2.0.9.23 (Mac 11/05: 'The trades page is not updated with today's trades'): the ACCOUNT's trades of this TradeDay. r1.6 account.fills (source bot | manual |
  // unknown) when sent; else the broker round trips in recentTrades closed this TradeDay (the bot's own list; the ones it did not place are untagged).
  const TDF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  function tradeDayOf(t) { const o = {}; for (const x of TDF.formatToParts(new Date(t))) o[x.type] = x.value; const d = new Date(Date.UTC(+o.year, +o.month - 1, +o.day + (+o.hour >= 15 ? 1 : 0))); return d.toISOString().slice(0, 10); }
  function dayLabel(day) { const d = new Date(day + 'T12:00:00Z'), p = new Date(d.getTime() - 86400000), f = (x, o) => x.toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, o)); return `${f(d, { weekday: 'short', month: 'short', day: 'numeric' })} · from ${f(p, { weekday: 'short' })} 3:00 PM PT`; }
  function acctRows(M) {
    const d = M.d, today = tradeDayOf(M.now), A = M.acct, out = { day: today, rows: [], src: null, net: null, closed: null, sides: null, costs: null, delta: null, why: null };
    if (A) { out.src = 'account (r1.6)'; out.net = fin(A.dayNet) ? A.dayNet : null; out.closed = fin(A.closedTrades) ? A.closedTrades : null; out.sides = fin(A.contractSides) ? A.contractSides : null; out.costs = fin(A.costsUsd) ? A.costsUsd : null; out.delta = fin(A.balanceDelta) ? A.balanceDelta : null;
      if (Array.isArray(A.fills)) for (const f of A.fills) { if (!f || !fin(f.t) || tradeDayOf(f.t) !== today) continue; out.rows.push({ t: f.t, side: String(f.side || '').toUpperCase(), qty: fin(f.qty) ? f.qty : null, price: fin(f.price) ? f.price : null, usd: fin(f.pnlUsd) ? f.pnlUsd : null, src: f.source === 'bot' ? 'BOT' : f.source === 'manual' ? 'MANUAL' : 'UNTAGGED', fill: true }); }
      else out.why = A.fillsWhy || A.reason || 'the broker gives aggregates only (account.fills null)'; return out; }
    const rt = Array.isArray(d && d.recentTrades) ? d.recentTrades : []; out.src = 'recentTrades (broker round trips)';
    for (const t of rt) { if (!t || t.closed !== true) continue; const xt = Date.parse(t.exitTime), et = Date.parse(t.entryTime); if (!fin(xt) || tradeDayOf(xt) !== today) continue;
      out.rows.push({ t: fin(et) ? et : xt, xt, side: t.dir === -1 ? 'SHORT' : 'LONG', qty: fin(t.maxSize) ? t.maxSize : fin(t.exitSize) ? t.exitSize : null, price: fin(t.entryAvgPrice) ? t.entryAvgPrice : fin(t.entryPrice) ? t.entryPrice : null, exit: fin(t.exitPrice) ? t.exitPrice : null, usd: fin(t.netPnl) ? t.netPnl : null, src: t.model === 'tide' ? 'TIDE' : 'UNTAGGED' }); }
    out.net = fin(d && d.dayPnlNet) ? d.dayPnlNet : null; out.delta = d && d.day && fin(d.day.rolling) ? d.day.rolling : null; const dt = d && d.dayTrips; if (dt && fin(dt.n)) { out.closed = dt.n; out.sides = fin(dt.sides) ? dt.sides : null; }
    return out; }
  function acctBox(M) {
    if (M.partial) return ''; const A = acctRows(M), n = A.rows.length, tideN = A.rows.filter(r => r.src === 'TIDE' || r.src === 'BOT').length, manN = n - tideN;
    if (!n && A.net == null) return '';
    const F2 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }), hmm = t => F2.format(new Date(t));
    const rows = A.rows.slice().sort((a, b) => b.t - a.t).map(r => `<li class="fx23-ar" data-src="${r.src}"><span class="fx18-tt">${hmm(r.t)}</span><b>${r.side === 'BUY' || r.side === 'LONG' ? '▲' : '▼'} ${esc(r.side)}${r.qty != null ? ' ' + r.qty : ''}</b>${r.src === 'MANUAL' ? `<span class="fx23-tag is-m" title="account.fills source manual">MANUAL</span>` : ''}<span class="fx18-dim">${r.price != null ? px(r.price) : ''}${r.exit != null ? ' → ' + px(r.exit) : ''}</span><span class="fx18-tx" data-s="${fin(r.usd) ? Math.sign(r.usd) : 0}">${fin(r.usd) ? usd(r.usd) : ''}</span></li>`).join('');
    const head = `<div class="fx18-k">MACMILLIONZ BOT · ${esc(dayLabel(A.day))}</div>`;
    const sum = `<div class="fx18-tday fx23-asum"><span><b>${A.net != null ? usd(A.net) : 'UNKNOWN (no dayPnlNet / account.dayNet in the snapshot)'}</b> <span class="fx18-dim">broker day net${A.closed != null ? ` · ${A.closed} closed` : ''}${A.sides != null ? ` · ${A.sides} contract-sides` : ''}${fin(A.costs) ? ` · costs ${usd(-Math.abs(A.costs))}` : ''}</span></span>`
      + `<span><span class="fx18-dim">${n ? `MacMillionz Bot · ${n} ${n === 1 ? 'trade' : 'trades'}${A.src.startsWith('account') && manN ? ` · ${manN} manual` : ''}` : A.why ? esc(A.why) : 'no fills listed'}${A.delta != null && A.net != null && Math.abs(A.delta - A.net) > 1 ? ` · balance ${usd(A.delta)} · differs by ${usd(A.delta - A.net)}` : ''}</span></span></div>`;
    return `<div class="card fx18-tbox fx23-acct" title="${esc(A.src)}">${head}${sum}${n ? `<ol class="fx18-tlist" aria-label="account trades today, newest first">${rows}</ol>` : ''}<div class="fx18-dim fx23-src">source: ${esc(A.src)}</div></div>`; }
  function filt() { const f = store.get('fx18-filter'); return f === 'tide' || f === 'old' ? f : 'all'; }

  // ── the TIDE checklist (Checklist tab; Mac 11/04 "update our checklist ... to reflect our new model"): GRADE r3 gates, then the points, then the rules.
  // Each row: pass / fail / waiting / UNKNOWN, read from the TIDE journal rows (signal = every gate passed; grade_no_trade = its gates / points / why;
  // setup_arm = waiting for the engine's grade at the retest) and, for the rules, the snapshot's own session / news / tide fields. Nothing is guessed.
  const GATES = [['control4h', '4H control', 'the 4H read: a trap at a level, or bias control'],
    ['laneTrigger', 'Lane trigger', 'failed break + displacement (body ≥ 50%, range ≥ 1× the 20-bar average), or accepted break (≥ 2 closes outside + a retest that does not close back inside)'],
    ['waveBias', 'Wave bias peak ≥ 0.20 our way', 'frozen at the decision'],
    ['firstRetest', 'First retest of this break', 'with a real bounce (a 1m counter-move)'],
    ['notMidRange', 'Not mid-range', 'outside the middle 50% of the 1H range'],
    ['logicalStop', 'Logical structural stop', 'a 4H / 1H wick']];
  const POINTS = [['trap', 'TRAP', 'at a stacked / obvious pool'], ['force', 'FORCE', 'leg ≥ 2× ATR 5m, or shift bar ≥ 2× average range'], ['volume', 'VOLUME', 'pullback 5m volume < the break candle'],
    ['timing', 'TIMING', 'within 60 min of the 15:00 / 00:00 / 06:30 PT opens'], ['impulseBand', 'IMPULSE BAND', '0.30 ≤ wave peak < 0.40']];
  const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  const ptMin = t => { const o = {}; for (const x of PT.formatToParts(new Date(t))) o[x.type] = x.value; return (+o.hour % 24) * 60 + +o.minute; };
  function clModel(M, d, now) {
    const R = { gates: [], points: [], rules: [], subject: null, grade: null };
    const sig = M.lastSignal, nt = (M.armed && M.armed.length ? null : null);
    void nt;
    // the subject: the newest of the last signal, the last grade_no_trade, the newest armed setup
    const cands = [];
    if (sig) cands.push({ k: 'signal', t: sig.t, r: sig });
    const gnt = M.lastEnd && M.lastEnd.phase === 'grade_no_trade' ? M.lastEnd : null; if (gnt) cands.push({ k: 'graded', t: gnt.t, r: gnt });
    if (M.armed && M.armed[0]) cands.push({ k: 'armed', t: M.armed[0].arm.t, r: M.armed[0].arm, s: M.armed[0] });
    const sub = cands.sort((a, b) => b.t - a.t)[0] || null; R.subject = sub;
    const st = (s, why) => ({ s, why });
    const ctlNow = M.ctl ? st('pass', `${M.ctl.dir === -1 ? 'SELLERS ▼' : 'BUYERS ▲'} since ${(s0 => s0.t != null ? hm(s0.t) : 'UNKNOWN')(ctlSince(M))}${/trap|fail/.test(String(M.ctl.kind)) ? ' · trap' : M.ctl.kind ? ' · bias control (' + M.ctl.kind + ' the 4H open)' : ''}`) : M.rowsKnown ? st('wait', M.ctlGone ? M.ctlGone.why : 'no 4H control read yet') : st('unknown', 'the snapshot has no tide.rows');
    for (const [k, w, sub2] of GATES) {
      let v;
      if (M.partial) v = st('unknown', 'TIDE details need bot update');
      else if (!sub) v = k === 'control4h' ? ctlNow : st('wait', M.rowsKnown ? 'no setup armed yet' : 'the snapshot has no tide.rows');
      else if (sub.k === 'signal') v = sub.r.rebuilt === true ? st('unknown', `replayed during warm-up (${hm(sub.t)}): not a live decision`) : st('pass', `passed at ${hm(sub.t)} (signal ${sub.r.id || ''})`);
      else if (sub.k === 'graded') { const g = sub.r.gates || {}, why = (Array.isArray(sub.r.why) ? sub.r.why : []).find(x => String(x).indexOf(k) === 0);
        v = g[k] === true ? st('pass', `passed at ${hm(sub.t)}`) : g[k] === false ? st('fail', why ? String(why).replace(/^[a-zA-Z0-9]+:\s*/, '') : `failed at ${hm(sub.t)}`) : st('unknown', 'not in the grade row'); }
      else { const a = sub.r; v = k === 'control4h' ? (M.ctl && M.ctl.dir === a.dir ? ctlNow : M.ctl ? st('fail', 'the setup is against the 4H control') : ctlNow)
          : k === 'laneTrigger' ? st('wait', `armed ${hm(a.t)}: ${a.kind || 'break'} at ${a.zone || 'a level'}${fin(a.level) ? ' ' + px(a.level) : ''}`)
          : k === 'waveBias' && fin(a.wavePeakBias) ? st('wait', `peak so far ${sg2(a.wavePeakBias)} (graded at the decision)`) : st('wait', 'graded at the retest'); }
      R.gates.push({ k, w, sub: sub2, ...v });
    }
    // points
    const names = sub && sub.k === 'signal' ? gradeOf(sub.r).names.map(x => String(x).toLowerCase()) : null, pts = sub && sub.k === 'graded' && sub.r.points && typeof sub.r.points === 'object' ? sub.r.points : null;
    for (const [k, w, sub2] of POINTS) { let v;   // 2.0.9.23: neutral tags (on / not on), never FAIL: the grade is a size tag
      if (M.partial) v = st('unknown', 'TIDE details need bot update');
      else if (names) v = names.some(n => n.indexOf(k === 'impulseBand' ? 'impulse' : k) === 0) ? st('tag', 'tagged on this signal') : st('tag', 'not tagged');
      else if (pts) v = pts[k] > 0 ? st('tag', 'tagged') : fin(pts[k]) || pts[k] === false ? st('tag', 'not tagged') : st('unknown', 'not in the grade row');
      else v = st('tag', sub ? 'tagged at the retest' : 'no setup yet');
      R.points.push({ k, w, sub: sub2, ...v }); }
    if (sub && sub.k === 'signal') { const g = gradeOf(sub.r); R.grade = { g: g.g, pts: g.pts, cap: g.cap, at: sub.t }; }
    else if (sub && sub.k === 'graded') R.grade = { g: 'no trade', pts: fin(sub.r.total) ? sub.r.total : null, cap: null, at: sub.t };
    // rules
    const T = d && d.tide || {}, rules = T.rules && typeof T.rules === 'object' ? T.rules : null, mn = ptMin(now), ov = d && d.configLocal && Array.isArray(d.configLocal.overrides) ? d.configLocal.overrides : [];
    const utb = rules && typeof rules.useTimeBlocks === 'boolean' ? { v: rules.useTimeBlocks, src: 'tide.rules' } : (o => o ? { v: !!o.to, src: 'config-local' } : null)(ov.find(o => o && o.key === 'tide.useTimeBlocks'));
    const hh = x => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x)); return m ? +m[1] * 60 + +m[2] : null; };
    const wins = rules && Array.isArray(rules.blocks) ? rules.blocks.map(w => Array.isArray(w) ? [hh(w[0]), hh(w[1]), w[0] + '–' + w[1]] : null).filter(w => w && w[0] != null && w[1] != null) : [[900, 1020, '15:00–17:00'], [390, 430, '06:30–07:10']];
    const inW = wins.find(w => mn >= w[0] && mn < w[1]), inAsia = !!inW, inNy = false;
    R.rules.push({ k: 'time', w: 'Time blocks', sub: 'no entries ' + wins.map(w => w[2]).join(' and ') + ' PT',
      ...(utb == null ? st('unknown', `the bot's tide.useTimeBlocks is not in the snapshot${inAsia || inNy ? ' · the clock is inside a block' : ''}`) : !utb.v ? st('fail', `OFF on the bot (${utb.src}): Mac reinstated them`) : inAsia || inNy ? st('hold', `holding: ${inW[2]} PT`) : st('pass', `on (${utb.src}) · not in a block now`)) });
    const ow = rules && fin(rules.openWaitMin) ? rules.openWaitMin : (o => o && fin(o.to) ? o.to : null)(ov.find(o => o && o.key === 'tide.openWaitMin'));
    const sessOpen = [900, 0, 390].map(m0 => ((mn - m0) + 1440) % 1440).filter(x => x < 1440).sort((a, b) => a - b)[0];
    const p4 = Math.min(...[180, 420, 660, 900, 1140, 1380].map(o => (mn - o + 1440) % 1440));   // (A) the 4H opens on the fixed grid: never missing
    const owN = ow == null ? 30 : ow, since = [sessOpen, p4].filter(fin);
    R.rules.push({ k: 'openwait', w: `Open wait ${owN} min`, sub: 'after each 4H open and the 15:00 / 00:00 / 06:30 PT opens',
      ...(Math.min(...since) < owN ? st('hold', `holding: ${Math.min(...since)} min after ${p4 <= sessOpen ? 'the 4H open' : 'the session open'}`) : st('pass', `${p4} min into this 4H${ow == null ? ' (wait length: shipped 30, the bot did not report it)' : ''}`)) });
    const se = d && d.session;
    R.rules.push({ k: 'session', w: 'Session close', sub: `no entry from ${se && se.noEntryPt || '12:55'} PT · flat ${se && se.flattenPt || '13:05'} PT`,
      ...(!se ? st('unknown', 'no session in the snapshot') : se.phase && se.phase !== 'open' ? st('hold', String(se.text || se.phase)) : st('pass', 'open')) });
    const nw = d && d.news;
    R.rules.push({ k: 'news', w: 'News pause', sub: 'early-morning releases 04:00–07:30 PT, plus FOMC at any time',
      ...(!nw ? st('unknown', 'no news in the snapshot') : nw.wait ? st('hold', String(nw.wait.title || nw.wait.text || nw.text || 'news wait')) : st(nw.count ? 'pass' : 'unknown', String(nw.text || '')) ) });
    const busy = M.position || M.simOpen;
    R.rules.push({ k: 'one', w: 'One position at a time', sub: 'one TIDE trade open at once',
      ...(M.partial ? st('unknown', 'TIDE details need bot update') : busy ? st('hold', `a TIDE ${M.simOpen ? 'SIMULATED ' : ''}trade is open: no new entry`) : st('pass', 'no TIDE trade open')) });
    const z = M.sizing || (T && T.sizing) || null, p = sig && sig.plan;
    R.rules.push({ k: 'size', w: 'Size', sub: 'flat $ per trade · 1 MNQ on wide stops up to $400',
      ...(!z ? st('unknown', 'tide.sizing not in the snapshot') : st('pass', `${z.mode || '?'}${fin(z.flatUsd) ? ' $' + z.flatUsd + ' per trade' : ''}${p && fin(p.qty) ? ` · last signal ${p.qty} MNQ, risk $${Math.round(p.riskUsd)}` : ''}${fin(z.take1MaxUsd) ? ` · 1 MNQ up to $${z.take1MaxUsd}` : ' · the 1-MNQ wide-stop limit is not in the snapshot'}`)) });
    return R;
  }
  const ST_W = { pass: 'PASS', fail: 'FAIL', wait: 'WAITING', hold: 'HOLDING', unknown: 'UNKNOWN', tag: 'TAG' }, ST_G = { pass: '✓', fail: '✕', wait: '…', hold: '‖', unknown: '?', tag: '◦' };
  const clRow = r => `<li class="fx18-cr" data-s="${r.s}"><span class="fx18-cg" aria-hidden="true">${ST_G[r.s]}</span><div class="fx18-cb"><div class="fx18-cw"><b>${esc(r.w)}</b><span class="fx18-cs">${ST_W[r.s]}</span></div><div class="fx18-cd">${esc(r.why)}</div><div class="fx18-cx">${esc(r.sub)}</div></div></li>`;
  function clHTML(M, R) {
    const sub = R.subject, head = `<div class="fx18-hd"><span class="fx18-t">TIDE CHECKLIST</span>${badge(M)}</div>`;
    const subj = M.partial ? '<div class="fx18-need"><b>TIDE details need bot update.</b> Every row reads UNKNOWN until the bot puts TIDE in its snapshot.</div>'
      : `<div class="fx18-now"><span class="fx18-k">NOW</span> ${nowText(M)}</div><div class="fx18-sub">${sub ? (sub.k === 'signal' ? `Last signal ${esc(sub.r.id || '')} · ${hm(sub.t)} PT (grade ${esc(gradeOf(sub.r).g || '?')})${sub.r.rebuilt === true ? ' · replayed during warm-up, not tradeable' : ''}` : sub.k === 'graded' ? `Last graded: setup ${esc(sub.r.setup || '')} · ${hm(sub.t)} PT: no trade` : `Current setup ${esc(sub.r.setup || '')} armed ${hm(sub.t)} at ${esc(sub.r.zone || '')}`) : 'No setup yet this TradeDay'}</div>`;
    const r16 = /r2\.[7-9]|r[3-9]\./.test(String(M.version || '')), gnote = r16 ? 'size tag only: an HTF-aligned setup is never refused by its grade; flat $400 at every grade. It still applies against or neutral to the HTF, and with grade=strict.' : 'flat $400 at every grade; the gates may still refuse until r1.6 (this bot is r1.5.6)';
    const g = R.grade, gl = `<div class="fx18-cgrade">${g ? (g.g === 'no trade' ? '<span class="fx18-g" data-g="u">no trade</span>' : gradeChip(g.g, null)) : ''}<span class="fx18-dim">${gnote}</span></div>`;
    const old = `<button type="button" class="fx18-oldb" data-fx18-old="1" aria-expanded="${clOld()}">${clOld() ? 'Hide' : 'Show'} the old path checklist <span class="fx18-dim">(${M.mode.key === 'live' ? 'no new entries in live' : 'still trading in shadow'})</span></button>`;
    return head + subj + `<div class="fx18-ck">GATES <span class="fx18-dim">any fail = no trade</span></div><ol class="fx18-cl">${R.gates.map(clRow).join('')}</ol>`
      + `<div class="fx18-ck">GRADE <span class="fx18-dim">size tag only · never a filter for aligned setups</span></div>${gl}<ol class="fx18-cl is-pts fx23-tagrows">${R.points.map(clRow).join('')}</ol>`
      + `<div class="fx18-ck">RULES</div><ol class="fx18-cl">${R.rules.map(clRow).join('')}</ol>` + old;
  }
  const clOld = () => store.get('fx18-oldcl') === '1';
  // (B) the CURRENT state, apart from the last signal: the board's next-to-act (2.0.9.19) when the bot sends a board, else the newest armed setup
  function nowText(M) {
    if (M.position) return `TIDE position open: ${esc(sideOf(M.position.dir) || '')} ${fin(M.position.open) ? M.position.open + ' MNQ' : ''}`;
    let nx = null; try { const L = U.feat20919 && typeof U.feat20919.lvModel === 'function' ? U.feat20919.lvModel(snapNow(), Date.now()) : null; nx = L && !L.partial && L.src === 'board' ? { n: L.next, blocked: L.nextBlocked } : null; } catch (e) { nx = null; }
    if (nx) return nx.n ? `next to act: ${esc(nx.n.name)} ${px(nx.n.price)} · ${esc(String(nx.n.state).toUpperCase())}${nx.blocked ? ' · BLOCKED' : ''} <span class="fx18-dim">(tide.board)</span>` : 'no setup armed now <span class="fx18-dim">(tide.board)</span>';
    const a = M.armed && M.armed[0]; return a ? `setup ${esc(a.id)} armed ${hm(a.arm.t)} at ${esc(a.arm.zone || '')} <span class="fx18-dim">(journal)</span>` : 'no setup armed now <span class="fx18-dim">(journal)</span>';
  }
  // ── mount / update ──
  let card = null, strip = null, tsec = null, clsec = null; const perf = { updates: 0, updateMax: 0, longTasks: 0 };
  function ensure(M) {
    if (!card) { const anchor = $('fx17-hour') || $('fx11-deck'); if (!anchor || !anchor.parentNode) return false;
      card = document.createElement('section'); card.className = 'card fx18'; card.id = 'fx18-tide'; card.setAttribute('aria-label', 'TIDE: the new model, its mode, 4H control, setup stage, last signal and position');
      if ($('fx17-hour')) anchor.before(card); else anchor.after(card); }
    if (!strip) { const deck = $('fx11-deck'), col = deck ? deck.parentNode : card.parentNode; strip = document.createElement('section'); strip.id = 'fx18-alerts'; strip.className = 'fx18-alerts'; strip.setAttribute('aria-label', 'TIDE alerts'); strip.setAttribute('aria-live', 'polite'); col.insertBefore(strip, col.firstChild); }
    if (!clsec) { const v = $('view-checklist'); if (v) { clsec = document.createElement('section'); clsec.id = 'fx18-cl'; clsec.className = 'card fx18 fx18-clc'; clsec.setAttribute('aria-label', 'TIDE checklist: the new model\'s gates, points and rules'); v.insertBefore(clsec, v.firstChild); } }
    if (!tsec) { const hero = $('tl-hero'); if (hero) { tsec = document.createElement('section'); tsec.id = 'fx18-trades'; tsec.className = 'fx18-trades'; hero.after(tsec); } }
    return true;
  }
  function onClick(e) {
    const a = e.target.closest && e.target.closest('[data-fx18-ack]'); if (a) { ack(a.getAttribute('data-fx18-ack')); if (modeAlert && modeAlert.key === a.getAttribute('data-fx18-ack')) modeAlert = null; render(snapNow()); return; }
    const f = e.target.closest && e.target.closest('[data-fx18-f]'); if (f) { store.set('fx18-filter', f.getAttribute('data-fx18-f')); render(snapNow()); return; }
    const o = e.target.closest && e.target.closest('[data-fx18-old]'); if (o) { store.set('fx18-oldcl', clOld() ? '0' : '1'); render(snapNow()); return; }
    const g = e.target.closest && e.target.closest('[data-fx18-go]'); if (g) { const cl = g.getAttribute('data-fx18-go') === 'cl'; if (!cl) store.set('fx18-filter', 'tide'); try { switchView(cl ? 'checklist' : 'trades'); } catch (x) { /* display only */ } render(snapNow()); }
  }
  let bound = false, lastMode = null;
  function render(d) {
    const t0 = performance.now(), M = d ? model(d, Date.now()) : null;
    if (!M) { if (card) { card.hidden = true; strip.hidden = true; if (tsec) tsec.hidden = true; if (clsec) clsec.hidden = true; const v = $('view-trades'); if (v) v.removeAttribute('data-fx18f'); const vc = $('view-checklist'); if (vc) vc.removeAttribute('data-fx18cl'); } U.feat20918.last = null; return; }   // nothing was ever mounted unless TIDE was on
    if (!ensure(M)) return;
    if (!bound) { bound = true; document.addEventListener('click', onClick); }
    if (lastMode !== M.mode.word) { noteMode(M); lastMode = M.mode.word; }
    card.hidden = false; strip.hidden = false; card.dataset.mode = M.mode.key; card.dataset.partial = M.partial ? '1' : '';
    setHTML(card, 'card', cardHTML(M));
    const sh = stripHTML(M); setHTML(strip, 'strip', sh); strip.hidden = !sh;
    if (tsec) { tsec.hidden = false; setHTML(tsec, 'trades', tradesHTML(M)); const v = $('view-trades'), f = M.partial ? 'all' : filt(); if (v && v.getAttribute('data-fx18f') !== f) v.setAttribute('data-fx18f', f); }
    if (clsec) { const vc0 = $('view-checklist'); if (vc0 && clsec.parentNode !== vc0) vc0.insertBefore(clsec, vc0.firstChild);   // the Signal Path folds the view's cards into #clp-full: keep this one outside
      clsec.hidden = false; clsec.dataset.mode = M.mode.key; const CR = clModel(M, d, Date.now()); setHTML(clsec, 'cl', clHTML(M, CR)); const vc = $('view-checklist'), cv = clOld() ? 'both' : 'tide'; if (vc && vc.getAttribute('data-fx18cl') !== cv) vc.setAttribute('data-fx18cl', cv);
      U.feat20918.cl = { gates: CR.gates.map(r => r.k + ':' + r.s), points: CR.points.map(r => r.k + ':' + r.s), rules: CR.rules.map(r => r.k + ':' + r.s), subject: CR.subject ? CR.subject.k : null }; }
    const tm = card.querySelector('.fx18-time'), tt = hms(M.now) + ' PT'; if (tm && tm.textContent !== tt) tm.textContent = tt;
    const dt = performance.now() - t0; perf.updates++; if (dt > perf.updateMax) perf.updateMax = dt; if (dt > 50) perf.longTasks++;
    U.feat20918.last = { mode: M.mode.word, partial: M.partial, stage: M.stage && M.stage.k, ctl: M.ctl ? M.ctl.dir : null, signal: M.lastSignal ? M.lastSignal.id : null, trades: (M.trades || []).map(t => `${t.id} ${t.open ? 'OPEN' : t.path} ${fin(t.resultR) ? t.resultR : ''}`), alerts: (M.alerts || []).map(a => a.code), position: M.position ? M.position.phase : null };
  }
  // ── the old path's fill (Mac 11/04 23:51 PT: "fill price and time UNKNOWN" stayed on Now): the fill receipt (journal_receipt FILL_OBSERVED) only
  // reaches the phone in /signal-journal, which the page read only on the Review tab. While a LIVE position is open and its fill is not observed yet,
  // this reads the same route the Review tab reads (journalUrl('all'), every 10 s at most, never two at once) and passes the answer through the
  // page's own safeJson, where the 2.1.1 receipt tap keeps the rows; the Position card (redrawn every second) then flips UNKNOWN to the observed fill
  // in place. It stops as soon as the fill is observed, the position closes, or the Review tab (which reads the journal itself) is open.
  let fjAt = 0, fjBusy = false; const fj = { reads: 0, last: null };
  function fillChase(d) {
    if (!d || d.mode !== 'LIVE' || typeof journalUrl !== 'function' || typeof currentView === 'undefined' || currentView !== 'dashboard' || document.hidden) return;   // Now only (where the Position card is; a journal answer redraws the Levels tab's trade cards)
    if (/[?&]source=replay\b/.test(location.search)) return;   // a replay page reads recorded data only
    const pos = d.position; if (!pos || !Array.isArray(pos.markers) || !pos.markers.length || pos.pending || pos.flattening) return;
    const T = d.levels && d.levels.trade && d.levels.trade.open, jid = T && typeof T.journalId === 'string' ? T.journalId : null; if (!jid) return;
    const v = typeof U.fillVerdict === 'function' ? U.fillVerdict(jid) : null; if (v && v.status === 'observed') return;
    const now = Date.now(); if (fjBusy || now - fjAt < 10000) return; fjAt = now; fjBusy = true; fj.reads++;
    fetch(journalUrl('all')).then(r => (r.ok ? r.json() : null)).then(j => { if (!j) return; j = safeJson(j) || j;
      // keep this trade's own receipts here too: the page's 30-trade row memory can drop them when a journal tail names many trades
      const mine = (Array.isArray(j.entries) ? j.entries : []).filter(e => e && e.type === 'journal_receipt' && (e.status === 'FILL_OBSERVED' || e.status === 'ACKNOWLEDGED') && (e.journalId === jid || e.decisionId === jid));
      const have = rcKeep.get(jid) || [], seen = new Set(have.map(x => JSON.stringify(x))); for (const e of mine) if (!seen.has(JSON.stringify(e))) have.push(Object.assign({}, e));
      rcKeep.clear(); rcKeep.set(jid, have); fj.last = typeof U.fillVerdict === 'function' ? U.fillVerdict(jid).status : null; }).catch(() => {}).finally(() => { fjBusy = false; });
  }
  const rcKeep = new Map();   // the open trade's receipts read by fillChase (one trade at a time)
  { const _fv = U.fillVerdict; if (typeof _fv === 'function') U.fillVerdict = function (jid, now) {
      const v = _fv.apply(this, arguments); if ((v && v.status === 'observed') || !jid || !rcKeep.has(jid)) return v;
      const Fr = window.MacFillReceipt; if (!Fr || typeof Fr.verdict !== 'function') return v;
      const rows = (typeof U.reelHeld === 'function' ? U.reelHeld(jid) : []).concat(rcKeep.get(jid));   // the same shared rule over the same kind of rows, never a looser one
      return Fr.verdict(rows, { journalId: jid, now: fin(now) ? now : typeof U.dataNow === 'function' ? U.dataNow() : Date.now() });
    }; }
  U.feat20918 = { release: '2.0.9.23', refusalText, ctlSince, htfTag, htfArrow, acctRows, tradeDayOf, dayLabel, gradeRow, rowsMemo: memo, fillChase: fj, clModel, model, exitWord, modeInfo, overrideMode, perf, update: () => render(snapNow()), last: null };
  const _w = window.renderWhyNoTrade;
  if (typeof _w === 'function') window.renderWhyNoTrade = function (d) { const r = _w.apply(this, arguments); try { fillChase(d || snapNow()); } catch (e) { /* display only */ } try { render(d || snapNow()); } catch (e) { /* display only */ } return r; };
  const _rh = window.renderHeartbeat;
  if (typeof _rh === 'function') window.renderHeartbeat = function () { const r = _rh.apply(this, arguments); try { fillChase(snapNow()); } catch (e) { /* display only */ } try { if (card) render(snapNow()); } catch (e) { /* display only */ } return r; };   // the fill chase also on the 1 s beat: a snapshot that did not change is not re-rendered
  const _tl = window.renderTradeList;
  if (typeof _tl === 'function') window.renderTradeList = function () { const r = _tl.apply(this, arguments); try { if (card) render(snapNow()); } catch (e) { /* display only */ } return r; };
  try { const d = snapNow(); if (d) render(d); } catch (e) { /* display only */ }
})();
