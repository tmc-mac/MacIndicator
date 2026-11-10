/* MacUI-T terminal 2.1.0: v2src/t210.js. Eight truthful surfaces on the snapshot the live bot sends (levels-only r13.3.5).
   Read-only: this module sends NO request and wraps NO page function. It reads the page's own poll results (pcSnap, tlLast,
   journalEntries) once a second, builds a pure model per surface from (data, now), and patches the DOM only when the model's
   markup changed. Every figure is painted by cell()/txt(), which take the state from fresh(ts, limitMs): LIVE, STALE or UNKNOWN. */
(function () {
  'use strict';
  var fin = function (v) { return typeof v === 'number' && isFinite(v); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var arr = function (v) { return Array.isArray(v) ? v : []; };
  var LIMIT = { snap: 60000, gate: 90000, stamp: 120000, mark: 60000 };   // snap = the page's one live-truth rule (STALE after 60 s)
  var FULL_STOP_USD = 300;   // 3 contracts x 50 pts x $2
  // the session stamps this build was checked against: stampId = sha256(file hashes + settings hash)[0:12], so the pair is bound to the id
  var KNOWN_STAMPS = { '44382b7fcf62': { exe: '07e8e798', cfg: 'c25157e8' } };

  /* ── the one freshness helper ── */
  function fresh(ts, limitMs, now) { if (!fin(ts)) return 'UNKNOWN'; now = fin(now) ? now : Date.now(); return now - ts <= limitMs ? 'LIVE' : 'STALE'; }
  var RANK = { LIVE: 0, STALE: 1, UNKNOWN: 2 };
  function worst(a, b) { return RANK[a] >= RANK[b] ? a : b; }
  function ageText(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; }
  // recorded / test data: ages are measured at the snapshot's own time and the word LIVE is never used
  function clock(d, realNow) {
    var mode = 'LIVE'; try { var k = window.macui && window.macui.liveTruth ? window.macui.liveTruth(d, realNow).key : ''; if (k === 'REPLAY' || k === 'TEST') mode = k; else if (k === 'OFFLINE') mode = 'OFFLINE'; } catch (e) { mode = 'LIVE'; }
    var rec = mode === 'REPLAY' || mode === 'TEST';
    return { now: rec && d && fin(d.updated) ? d.updated : realNow, mode: mode, rec: rec };
  }
  function snapState(d, c) { if (!d || d.available === false) return 'UNKNOWN'; var s = fresh(d.updated, LIMIT.snap, c.now); return c.mode === 'OFFLINE' && s === 'LIVE' ? 'STALE' : s; }
  function stateWord(st, c) { return st === 'LIVE' ? (c.mode === 'REPLAY' ? 'REPLAY' : c.mode === 'TEST' ? 'TEST DATA' : 'LIVE') : st; }

  /* ── formatters (only ever called through cell()) ── */
  function grp(n, dp) { var s = Math.abs(n).toFixed(dp), i = s.indexOf('.'), a = i < 0 ? s : s.slice(0, i); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (i < 0 ? '' : s.slice(i)); }
  var usd = function (v) { return (v < -0.004 ? '−' : '') + '$' + grp(v, 2); };
  var usdS = function (v) { return (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + '$' + grp(v, 2); };
  var usd0 = function (v) { return (v < 0 ? '−' : '') + '$' + grp(v, 0); };
  var px = function (v) { return grp(v, 2); };
  var ptsS = function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2); };
  var one = function (v) { return (v < 0 ? '−' : '') + Math.abs(v).toFixed(1); };
  var rS = function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + 'R'; };
  // THE clock formatter: America/Los_Angeles, 12-hour, "h:mm AM PT" (the phone's own time zone never changes it; DST comes from the zone data)
  var TFS = {}; function partsPT(t, opt, key) { var f = TFS[key] || (TFS[key] = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'America/Los_Angeles' }, opt))), o = {}; f.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; }); return o; }
  function timePT(t, secs) { if (!fin(t)) return ''; var o = partsPT(t, secs ? { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true } : { hour: 'numeric', minute: '2-digit', hour12: true }, secs ? 's' : 'm'); return o.hour + ':' + o.minute + (secs ? ':' + o.second : '') + ' ' + o.dayPeriod + ' PT'; }
  function datePT(t) { if (!fin(t)) return ''; var o = partsPT(t, { weekday: 'short', month: 'short', day: 'numeric' }, 'd'); return o.weekday + ' ' + o.month + ' ' + o.day; }
  var clockPT = function (t) { return timePT(t, false); };
  // the bot's own words carry PT wall-clock times in 24-hour form ("12:55-15:00 PT", "flat by 13:05"): the same PT time, written 12-hour (no zone maths)
  function pt12(s) { return String(s).replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!:\d|\s*[AP]M)/g, function (m, h, mi) { h = Number(h); return (h % 12 === 0 ? 12 : h % 12) + ':' + mi + (h < 12 ? ' AM' : ' PM'); }); }
  function ageLine(st, c, at, ageMs, what) { return '<div class="t2-age" data-k="age" data-st="' + st + '">' + (st === 'UNKNOWN' || !fin(at) ? 'age ' + unk('no time on this data') : esc((what || 'bot snapshot') + ' ' + timePT(at) + ' · ' + ageText(ageMs) + ' ago' + (c.rec ? ' (recorded data)' : ''))) + '</div>'; }
  function unk(why) { return '<span class="t2-unk" data-st="UNKNOWN">UNKNOWN: ' + esc(why) + '</span>'; }
  // THE painter: a value is shown only with its state. LIVE = plain, STALE = struck through, UNKNOWN (or no value) = the word and the reason.
  function cell(v, fmt, st, why, cls) {
    if (!fin(v) || st === 'UNKNOWN') return unk(why || 'not sent');
    var t = esc(fmt(v));
    return st === 'STALE' ? '<s class="t2-v t2-old ' + (cls || '') + '" data-st="STALE">' + t + '</s>' : '<span class="t2-v ' + (cls || '') + '" data-st="LIVE">' + t + '</span>';
  }
  function txt(s, st, why, cls) {   // the same rule for a word (a side, a reason)
    if (s == null || s === '' || st === 'UNKNOWN') return unk(why || 'not sent');
    return st === 'STALE' ? '<s class="t2-v t2-old ' + (cls || '') + '" data-st="STALE">' + esc(s) + '</s>' : '<span class="t2-v ' + (cls || '') + '" data-st="LIVE">' + esc(s) + '</span>';
  }
  function chip(st, c, ageMs, extra) {
    var w = stateWord(st, c), a = st === 'STALE' && fin(ageMs) ? ' · ' + ageText(ageMs) + ' old' : '';
    return '<span class="t2-chip" data-st="' + st + '"><i aria-hidden="true"></i>' + esc(w + a) + (extra ? ' ' + esc(extra) : '') + '</span>';
  }

  /* ── settings on the phone (the three eval lines) ── */
  var DEF = { start: 150000, target: 153000, fail: 148000 }, mem = {};
  function lsGet(k) { try { var v = window.localStorage.getItem(k); return v == null ? (k in mem ? mem[k] : null) : v; } catch (e) { return k in mem ? mem[k] : null; } }
  function lsSet(k, v) { mem[k] = v; try { window.localStorage.setItem(k, v); } catch (e) { /* private mode: kept for this page only */ } }
  function evalCfg() {
    var o = null; try { o = JSON.parse(lsGet('t210.eval') || 'null'); } catch (e) { o = null; }
    var ok = o && fin(o.start) && fin(o.target) && fin(o.fail) && o.fail < o.start && o.start < o.target;
    return ok ? { start: o.start, target: o.target, fail: o.fail, custom: !(o.start === DEF.start && o.target === DEF.target && o.fail === DEF.fail) } : { start: DEF.start, target: DEF.target, fail: DEF.fail, custom: false };
  }

  /* ── shared reads ── */
  function openTrade(d) { var t = d && d.levels && d.levels.trade; return t && t.open && typeof t.open === 'object' ? t.open : null; }
  // THE position read (QA 11/10 #4): Eval, Broker truth, Trades and the receipts all take the position from here. Two sources: the bot's
  // position object and levels.trade.open. An empty marker list is not "flat" (the bracket may still be going in): the object itself says a
  // position is there. levels.trade.open = null alone is not "flat" either (a TIDE trade is not in the levels tracker). When the two sources
  // contradict each other (flat or a resting entry vs an open levels trade, or opposite sides) the position is UNKNOWN on every surface.
  function posState(d) {   // { kind: 'flat' | 'pending' | 'open' | null, why, side, dir, qty, avg }
    if (!d || !('position' in d)) return { kind: null, why: 'position not sent' };
    var p = d.position, o = openTrade(d), pd = p && (p.dir === 1 || p.dir === -1) ? p.dir : null, od = o && (o.dir === 1 || o.dir === -1) ? o.dir : null;
    if (p !== null && (typeof p !== 'object' || Array.isArray(p))) return { kind: null, why: 'position not readable' };
    if (p === null && o) return { kind: null, why: 'the bot’s position says flat but levels.trade.open holds an open trade' };
    if (p === null) return { kind: 'flat' };
    if (p.pending && o) return { kind: null, why: 'the bot’s position says resting entry but levels.trade.open holds an open trade' };
    if (pd != null && od != null && pd !== od) return { kind: null, why: 'the position and levels.trade.open give opposite sides' };
    var dir = pd != null ? pd : od, mk = arr(p.markers), ent = mk.filter(function (x) { return x && x.kind === 'entry'; })[0];
    var r = { kind: p.pending ? 'pending' : 'open', dir: dir, side: dir === 1 ? 'LONG' : dir === -1 ? 'SHORT' : null };
    r.qty = r.kind === 'open' && o && fin(o.openQty) ? o.openQty : null; r.avg = r.kind === 'open' && o && fin(o.entry) ? o.entry : ent && fin(ent.price) ? ent.price : null;
    return r;
  }
  function posOpen(d) { var k = posState(d).kind; return k == null ? null : k === 'open'; }   // true / false / null (not sent, or the sources disagree)
  function dayFigure(d, now) { try { var m = window.macui && window.macui.dayModel ? window.macui.dayModel(d, now) : null; return m && fin(m.v) ? m.v : null; } catch (e) { return null; } }

  /* ── (a) stamps ── */
  // J.t = the newest stamped row's own time (which stamp is current); J.readAt = when this phone read the journal (what "read X ago" means, QA 11/10 #5)
  var J = { ref: null, stampId: null, t: null, readAt: null };
  function readStamp() {
    var je = null; try { je = typeof journalEntries !== 'undefined' ? journalEntries : null; } catch (e) { je = null; }
    if (je && je !== J.ref) { J.ref = je; J.readAt = Date.now();
      for (var i = 0; i < je.length; i++) { var r = je[i]; if (r && typeof r.stampId === 'string' && /^[0-9a-f]{12}$/.test(r.stampId) && fin(r.t) && (J.t == null || r.t >= J.t)) { J.stampId = r.stampId; J.t = r.t; } }
      if (J.stampId) lsSet('t210.stamp', JSON.stringify({ stampId: J.stampId, t: J.t, readAt: J.readAt })); }
    if (!J.stampId) { try { var o = JSON.parse(lsGet('t210.stamp') || 'null'); if (o && typeof o.stampId === 'string' && /^[0-9a-f]{12}$/.test(o.stampId) && fin(o.t)) { J.stampId = o.stampId; J.t = o.t; J.readAt = fin(o.readAt) ? o.readAt : null; } } catch (e) { /* none */ } }
    return J;
  }
  function stampsModel(j, c, realNow) {
    realNow = fin(realNow) ? realNow : Date.now();
    var st = j && j.stampId ? fresh(j.readAt, LIMIT.stamp, realNow) : 'UNKNOWN', k = j && j.stampId ? KNOWN_STAMPS[j.stampId] : null;
    if (j && j.stampId && st === 'UNKNOWN') st = 'STALE';   // a stamp kept on this phone from an earlier read, read time not kept: old until re-read
    return { st: st, stampId: j ? j.stampId : null, age: j && j.stampId && fin(j.readAt) ? realNow - j.readAt : null, exe: k ? k.exe : null, cfg: k ? k.cfg : null,
      why: 'no journal row read yet (the snapshot carries no stamp; open Review once)',
      whyPair: j && j.stampId ? 'not sent in the snapshot, and this stamp is not in the page’s checked table' : 'needs the build stamp first' };
  }
  function stampsHtml(m, c) {
    var b = '<span class="t2-st-k">build</span> ' + txt(m.stampId, m.st, m.why, 't2-mono');
    var pair = m.st === 'UNKNOWN' ? '' : m.exe ? '<span class="t2-st-k">exe</span> ' + txt(m.exe, m.st, '', 't2-mono') + ' <span class="t2-st-k">cfg</span> ' + txt(m.cfg, m.st, '', 't2-mono') : '<span class="t2-st-k">exe / cfg</span> ' + unk(m.whyPair);
    var tail = m.st === 'STALE' ? '<span class="t2-st-age" data-st="STALE">' + esc(m.age != null ? 'read ' + ageText(m.age) + ' ago' : 'read time not kept') + ' · open Review to re-read</span>' : m.st === 'LIVE' ? '<span class="t2-st-age" data-st="LIVE">' + esc(stateWord('LIVE', c).toLowerCase() + ' · read ' + ageText(m.age) + ' ago') + '</span>' : '';
    return '<div class="t2-stamp-row" data-st="' + m.st + '" role="group" aria-label="Build and settings stamps">' + '<span class="t2-st-i">' + b + '</span>' + (pair ? '<span class="t2-st-i">' + pair + '</span>' : '') + tail + '</div>';
  }

  /* ── (b) eval score ── */
  function evalModel(d, cfg, c) {
    var st = snapState(d, c), bal = d && fin(d.accountBalance) ? d.accountBalance : null, m = { st: st, cfg: cfg, age: d && fin(d.updated) ? c.now - d.updated : null, at: d && fin(d.updated) ? d.updated : null };
    if (st === 'UNKNOWN' || bal == null) { m.st = 'UNKNOWN'; m.why = !d || d.available === false ? 'no snapshot' : !fin(d.updated) ? 'snapshot has no time' : d.mode === 'PAPER' ? 'paper mode: no account balance' : 'accountBalance not sent'; return m; }
    m.bal = bal; m.closedRoom = bal - cfg.fail; m.toTarget = cfg.target - bal;
    var ps = posState(d), po = ps.kind == null ? null : ps.kind === 'open', o = openTrade(d), op = fin(d.openPnl) ? d.openPnl : null;
    if (po === null) { m.nowWhy = ps.why === 'position not sent' ? 'position state not sent' : 'position UNKNOWN: ' + ps.why; }
    else if (po === false) { m.open = 0; m.flat = true; }
    else if (op == null) { m.nowWhy = 'open P&L not sent while a position is open'; }
    else if (o && o.priceStale === true) { m.nowWhy = 'the open trade’s price mark is stale'; }
    else if (d.livePx && fin(d.livePx.t) && fresh(d.livePx.t, LIMIT.mark + 60000, c.now) !== 'LIVE') { m.nowWhy = 'open P&L mark is ' + ageText(c.now - d.livePx.t) + ' old'; }
    else { m.open = op; m.flat = false; }
    if (m.open != null) { m.equity = bal + m.open; m.room = m.equity - cfg.fail; m.stops = Math.floor(m.room / FULL_STOP_USD * 10) / 10; m.tone = m.stops > 2 ? 'good' : m.stops >= 1 ? 'warn' : 'crit'; }
    else m.tone = 'unk';
    m.day = dayFigure(d, c.now);
    // the header's day figure carries the open mark; with open P&L UNKNOWN that mark cannot be used here, so the day is the realized part only (QA 11/10 #3)
    if (m.open == null) { m.dayRealized = true; m.day = d.day && fin(d.day.realized) ? d.day.realized : d.dayTrips && fin(d.dayTrips.net) ? d.dayTrips.net : null; }
    m.dd = fin(d.remainingDrawdown) ? d.remainingDrawdown : null; m.floor = m.dd != null && fin(d.equity) ? d.equity - m.dd : null;
    return m;
  }
  function roomLabel(m) { return m.st === 'UNKNOWN' || m.open == null ? null : (m.stops < 0 ? 'below the fail line' : 'room: ' + m.stops.toFixed(1) + ' full stops'); }
  function evalHtml(m, c) {
    var gear = '<button type="button" class="t2-gear" data-t2act="sheet" aria-label="Edit the eval lines"><svg class="ic" aria-hidden="true"><use href="#i-control"/></svg></button>';
    var head = '<div class="t2-head"><span class="t2-title">Eval score</span>' + chip(m.st, c, m.age) + gear + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-big" data-k="room">' + unk(m.why) + '</div>' + bar(null, m.cfg, 'unk') + '<div class="t2-sub">Lines: fail ' + esc(usd0(m.cfg.fail)) + ', start ' + esc(usd0(m.cfg.start)) + ', target ' + esc(usd0(m.cfg.target)) + '</div>' + ageLine(m.st, c, m.at, m.age);
    var tone = m.st === 'STALE' ? 'unk' : m.tone, word = { good: 'CLEAR', warn: 'TIGHT', crit: 'CRITICAL', unk: '' }[tone];
    var h = head + '<div class="t2-eval-top" data-tone="' + tone + '">'
      + '<div class="t2-eval-main"><div class="t2-lbl">room now (incl. open trade)</div><div class="t2-big" data-k="room">' + cell(m.open != null ? m.room : NaN, usd, m.st, m.nowWhy) + '</div>'
      + '<div class="t2-stops" data-k="stops">' + (m.open != null ? txt(roomLabel(m), m.st, '') + (word ? ' <b class="t2-tone-w">' + word + '</b>' : '') : unk('room in full stops needs room now')) + '</div></div>'
      + '<div class="t2-eval-side"><div class="t2-lbl">balance (closed)</div><div class="t2-mid" data-k="bal">' + cell(m.bal, usd, m.st, '') + '</div>'
      + '<div class="t2-lbl">open trade</div><div class="t2-mid" data-k="open">' + (m.flat ? txt('flat', m.st, '') : cell(m.open != null ? m.open : NaN, usdS, m.st, m.nowWhy)) + '</div></div></div>';
    h += bar(m, m.cfg, tone);
    h += '<dl class="t2-kv">'
      + '<div><dt>closed balance to fail</dt><dd data-k="closedRoom">' + cell(m.closedRoom, usd, m.st, '') + '</dd></div>'
      + '<div><dt>to target ' + esc(usd0(m.cfg.target)) + '</dt><dd data-k="toTarget">' + (m.toTarget <= 0 ? txt('reached', m.st, '') : cell(m.toTarget, usd, m.st, '')) + '</dd></div>'
      + (m.dayRealized ? '<div><dt>day P&amp;L realized <span class="t2-note">(closed trades only: open P&amp;L UNKNOWN)</span></dt><dd data-k="day">' + cell(m.day != null ? m.day : NaN, usdS, m.st, 'realized day P&L not sent') + '</dd></div>'
        : '<div><dt>day P&amp;L (as the header)</dt><dd data-k="day">' + cell(m.day != null ? m.day : NaN, usdS, m.st, 'day figure not sent') + '</dd></div>')
      + '<div><dt>trailing drawdown: bot’s own figure (4,500 rule)</dt><dd data-k="dd">' + (m.dd != null ? cell(m.dd, usd, m.st, '') + ' <span class="t2-note">not your fail line</span>' : unk('remainingDrawdown not sent')) + '</dd></div>'
      + '</dl>';
    h += '<div class="t2-sub">One full stop = 3 × 50 pts × $2 = $300. The fail line counts open P&amp;L in real time.' + (m.cfg.custom ? ' Lines edited on this phone.' : '') + '</div>';
    return h + ageLine(m.st, c, m.at, m.age);
  }
  function bar(m, cfg, tone) {
    var span = cfg.target - cfg.fail, f = function (v) { return Math.max(0, Math.min(1, (v - cfg.fail) / span)); };
    var eq = m && m.equity != null ? f(m.equity) : null, cb = m && m.bal != null ? f(m.bal) : null, s0 = f(cfg.start);
    return '<div class="t2-bar" data-tone="' + tone + '" data-k="bar" role="img" aria-label="' + (eq != null ? 'Equity is ' + Math.round(eq * 100) + ' percent of the way from the fail line to the target' : 'Bar greyed: room now is unknown') + '">'
      + '<div class="t2-bar-track">' + (eq != null ? '<i class="t2-bar-fill" style="transform:scaleX(' + eq.toFixed(4) + ')"></i>' : '')
      + '<i class="t2-bar-start" style="left:' + (s0 * 100).toFixed(2) + '%"></i>' + (cb != null && tone !== 'unk' ? '<i class="t2-bar-bal" style="left:' + (cb * 100).toFixed(2) + '%"></i>' : '') + '</div>'
      + '<div class="t2-bar-ax"><span>fail ' + esc(usd0(cfg.fail)) + '</span><span class="t2-bar-s" style="left:' + (s0 * 100).toFixed(2) + '%">start</span><span>target ' + esc(usd0(cfg.target)) + '</span></div></div>';
  }

  /* ── (c) broker truth ── */
  function lastOf(hist) { var a = arr(hist), l = a.length ? a[a.length - 1] : null; return l && fin(l[0]) ? l : null; }
  function brokerModel(d, c) {
    var st = snapState(d, c), m = { st: st, age: d && fin(d.updated) ? c.now - d.updated : null, at: d && fin(d.updated) ? d.updated : null, orders: [] };
    if (st === 'UNKNOWN') { m.why = !d || d.available === false ? 'no snapshot' : 'snapshot has no time'; return m; }
    var ps = posState(d); if (ps.kind == null) { m.st = 'UNKNOWN'; m.why = ps.why; return m; }
    var p = d.position, o = openTrade(d); m.status = typeof d.status === 'string' ? d.status : null; m.desync = m.status === 'DESYNCED';
    if (ps.kind === 'flat') { m.kind = 'flat'; return m; }
    m.kind = ps.kind; m.flattening = !!(p && p.flattening); m.side = ps.side; m.qty = ps.qty; m.avg = ps.avg;
    var mk = arr(p && p.markers);
    m.verified = o ? o.verified === true : null; m.src = o && typeof o.src === 'string' ? o.src : null;
    mk.forEach(function (x) { if (!x || x.kind === 'entry' || typeof x.label !== 'string') return;
      var h = o && (x.kind === 'stop' ? o.stops : o.targets), l = h ? lastOf(h[x.label]) : null;
      m.orders.push({ label: x.label, kind: x.kind, price: fin(x.price) ? x.price : null, setAt: l ? l[0] : null }); });
    return m;
  }
  function brokerHtml(m, c) {
    var head = '<div class="t2-head"><span class="t2-title">Broker truth</span>' + chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-big">' + unk(m.why) + '</div><div class="t2-sub">No position or order is shown without its age.</div>' + ageLine(m.st, c, m.at, m.age);
    var h = head;
    if (m.desync) h += '<div class="t2-warnline t2-crit" data-k="desync">The bot reports DESYNCED: what is below may not match the broker. Check TopstepX.</div>';
    if (m.kind === 'flat') h += '<div class="t2-pos" data-side="flat"><div class="t2-big" data-k="pos">' + txt('FLAT', m.st, '') + '</div><div class="t2-sub">No position and no working orders in the bot’s view.</div></div>';
    else {
      h += '<div class="t2-pos" data-side="' + (m.side || 'unk').toLowerCase() + '"><div class="t2-big" data-k="pos">' + (m.kind === 'pending' ? '<span class="t2-pend">resting entry</span> ' : '') + txt(m.side, m.st, 'side not sent', 't2-side')
        + ' ' + (m.kind === 'pending' ? '' : cell(m.qty != null ? m.qty : NaN, String, m.st, 'qty not sent')) + ' <span class="t2-at">@</span> ' + cell(m.avg != null ? m.avg : NaN, px, m.st, 'avg price not sent') + '</div>'
        + (m.flattening ? '<div class="t2-sub">flattening now</div>' : '') + '</div>';
      h += '<div class="t2-orders" role="table" aria-label="Protective orders">';
      if (!m.orders.length) h += '<div class="t2-ord" role="row"><span role="cell">' + unk('no protective order in the snapshot') + '</span></div>';
      m.orders.forEach(function (o) {
        h += '<div class="t2-ord" role="row" data-kind="' + o.kind + '" data-k="ord-' + esc(o.label) + '"><span class="t2-ord-l" role="cell">' + esc(o.label) + '</span><span class="t2-ord-p" role="cell">' + cell(o.price != null ? o.price : NaN, px, m.st, 'price not sent') + '</span>'
          + '<span class="t2-ord-q" role="cell">qty ' + unk('not sent') + '</span><span class="t2-ord-t" role="cell">' + (o.setAt != null ? 'set ' + esc(clockPT(o.setAt)) : 'set time ' + unk('not sent')) + '</span></div>'; });
      h += '</div>';
    }
    h += '<div class="t2-src" data-k="src">Source: the bot’s order state' + (m.kind === 'flat' || m.verified == null ? '' : m.verified ? ', entry matched to a broker fill' : ', entry NOT yet matched to a broker fill') + '. Broker read time: ' + unk('not sent, the age below is the snapshot’s') + '</div>';
    return h + ageLine(m.st, c, m.at, m.age);
  }

  /* ── (d) trade rows ── */
  function exitOf(r) {
    var ph = arr(r.phases).map(function (p) { return p && p[1]; }), tp1 = ph.indexOf('LEG23_OPEN') >= 0 || ph.indexOf('LEG3_OPEN') >= 0, flat = ph.indexOf('FLATTENING') >= 0;
    var ex = r.exit && fin(r.exit.price) ? r.exit.price : null, d = r.dir, stopK = null, stopP = null, stopT = -1, k;
    for (k in (r.stops || {})) { var l = lastOf(r.stops[k]); if (l && l[0] >= stopT && fin(l[1])) { stopT = l[0]; stopP = l[1]; stopK = k; } }
    var tpL = r.targets ? lastOf(r.targets.TP1) : null, tpP = tpL && fin(tpL[1]) ? tpL[1] : null;
    if (flat) return { text: tp1 ? 'TP1, then market exit' : 'market exit', note: 'no-progress, session close or manual: which one is not sent', tp1: tp1, stop: false };
    if (tp1) return { text: 'TP1, then runner stop', tp1: true, stop: false };
    if (ex != null && tpP != null && (ex - tpP) * d >= -0.5) return { text: 'TP1', tp1: true, stop: false };
    if (ex != null && stopP != null && (ex - stopP) * d <= 1) return { text: stopK === 'STOP' ? 'stop' : String(stopK).toLowerCase(), tp1: false, stop: true, initial: stopK === 'STOP' };
    return { text: null, why: 'exit reason not sent', tp1: false, stop: false };
  }
  // the exit painted on a row: entry + side x pts/contract when both are sent (a 3-leg exit has no single price; this is the average the pts
  // figure is made of, so entry -> exit always equals the pts shown), else the bot's own exit price (QA 11/10 #7)
  function exitPx(r) { if (fin(r.entry) && fin(r.pts) && (r.dir === 1 || r.dir === -1)) return Math.round((r.entry + r.dir * r.pts) * 100) / 100; return r.exit && fin(r.exit.price) ? r.exit.price : null; }
  // "avg" when more than one contract left in more than one fill: TP1 then the runner, or the bot's exit price is not the pts figure's price
  function exitIsAvg(r, e) { if (fin(r.contracts) && r.contracts === 1) return false; if (e && e.tp1) return true; var x = exitPx(r); return x != null && !(r.exit && fin(r.exit.price) && Math.abs(r.exit.price - x) < 0.005); }
  function ledgerModel(d, c) {
    var st = snapState(d, c), m = { st: st, age: d && fin(d.updated) ? c.now - d.updated : null, rows: [] };
    if (st === 'UNKNOWN') { m.why = !d || d.available === false ? 'no snapshot' : 'snapshot has no time'; return m; }
    var t = d.levels && d.levels.trade; if (!t || !Array.isArray(t.today)) { m.st = 'UNKNOWN'; m.why = 'levels.trade.today not sent'; return m; }
    var rt = {}; arr(d.recentTrades).forEach(function (x) { if (x && x.closed && typeof x.entryTime === 'string') rt[x.contractId + '|' + x.entryTime] = x; });
    var jc = {}; try { arr(typeof journalEntries !== 'undefined' ? journalEntries : null).forEach(function (e) { if (e && e.outcome === 'closed' && e.pnlSource === 'broker' && e.journalId) jc[e.journalId] = e; }); } catch (e) { /* not loaded */ }
    t.today.forEach(function (r) {
      if (!r || typeof r !== 'object' || r.closedAt == null) return;
      var e = exitOf(r), planned = fin(r.entry) && fin(r.stop0) ? Math.abs(r.entry - r.stop0) : null, b = r.exit && rt[r.exit.rt] || null, j = jc[r.journalId] || null;
      var net = fin(r.netPnl) && r.settled === 'broker' ? r.netPnl : null, gross = b && fin(b.grossPnl) ? b.grossPnl : j && fin(j.grossPnl) ? j.grossPnl : null;
      m.rows.push({ id: r.journalId || r.key, side: r.dir === 1 ? 'LONG' : r.dir === -1 ? 'SHORT' : null, dir: r.dir, qty: fin(r.contracts) ? r.contracts : null, entry: fin(r.entry) ? r.entry : null, exit: exitPx(r), exitAvg: exitIsAvg(r, e),
        pts: fin(r.pts) ? r.pts : null, R: fin(r.pts) && planned ? r.pts / planned : null, planned: planned, mae: fin(r.mae) ? r.mae : null, ex: e,
        event: r.level && typeof r.level.event === 'string' ? r.level.event : null, level: r.level && typeof r.level.name === 'string' ? pt12(r.level.name) : null, levelPx: r.level && fin(r.level.price) ? r.level.price : null,
        gross: gross, net: net, fees: gross != null && net != null ? gross - net : null, rt: r.exit && typeof r.exit.rt === 'string' ? r.exit.rt : null, rtSize: r.exit && fin(r.exit.size) ? r.exit.size : null, rtSrc: r.exit && r.exit.src || null,
        closedAt: r.closedAt, openedAt: fin(r.openedAt) ? r.openedAt : null, fullStop: !!(e.stop && e.initial && !e.tp1 && fin(r.pts) && r.pts < 0) });
    });
    m.rows.sort(function (a, b) { return b.closedAt - a.closedAt; });
    m.day = dayFigure(d, c.now);
    var sum = 0, all = m.rows.length > 0; m.rows.forEach(function (r) { if (r.net == null) all = false; else sum += r.net; });
    m.rowsNet = all && fin(d.dayPnlNet) && Math.round(sum * 100) === Math.round(d.dayPnlNet * 100) ? sum : null;
    m.trips = d.dayTrips && fin(d.dayTrips.n) ? d.dayTrips.n : null; m.at = fin(d.updated) ? d.updated : null;
    var dt = d.dayTrips, op = posOpen(d) === false ? 0 : posOpen(d) === true && fin(d.openPnl) ? d.openPnl : null;
    // the day line: closed net + gross + fees from the bot's whole-day round trips, shown only when closed net + open equals the header's figure to the cent
    if (dt && fin(dt.net) && fin(dt.gross) && m.day != null && op != null && Math.round((dt.net + op) * 100) === Math.round(m.day * 100)) m.dayLine = { net: dt.net, gross: dt.gross, fees: dt.gross - dt.net, open: op };
    else m.dayWhy = !dt || !fin(dt.net) || !fin(dt.gross) ? 'the day’s gross and net are not sent' : m.day == null ? 'day figure not sent' : op == null ? (posOpen(d) === null ? 'position UNKNOWN: ' + posState(d).why : 'open P&L not sent') : 'closed net plus open does not equal the header’s day figure, breakdown withheld';
    return m;
  }
  var ledgerAll = false;
  function rowHtml(r, st) {
    var tone = r.pts == null ? 'unk' : r.pts > 0 ? 'win' : r.pts < 0 ? 'loss' : 'flat', rtT = r.rt ? r.rt.split('|')[1] : null, rtMs = rtT ? Date.parse(rtT) : NaN;
    return '<li class="t2-row" data-tone="' + tone + '" data-id="' + esc(r.id) + '"' + (r.fullStop ? ' data-fullstop="1"' : '') + '>'
      + '<div class="t2-row-a"><span class="t2-row-side" data-k="side">' + txt(r.side, st, 'side not sent', 't2-side') + ' ' + cell(r.qty != null ? r.qty : NaN, function (v) { return v + 'x'; }, st, 'qty not sent') + '</span>'
      + '<span class="t2-row-px" data-k="px">' + cell(r.entry != null ? r.entry : NaN, px, st, 'entry not sent') + ' <span class="t2-at">→</span> ' + (r.exit != null && r.exitAvg ? '<small>avg</small> ' : '') + cell(r.exit != null ? r.exit : NaN, px, st, 'exit price not sent') + '</span><span class="t2-row-t" data-k="time">' + (r.openedAt != null ? esc(timePT(r.openedAt)) : 'time ' + unk('not sent')) + '</span></div>'
      + '<div class="t2-row-b"><span class="t2-pill" data-k="pts">' + cell(r.pts != null ? r.pts : NaN, ptsS, st, 'pts not sent') + (r.pts != null ? ' <small>pts/ct</small>' : '') + '</span>'
      + '<span class="t2-pill t2-pill-q" data-k="R">' + cell(r.R != null ? r.R : NaN, rS, st, r.pts == null ? 'R needs pts' : 'planned stop not sent') + '</span>'
      + '<span class="t2-pill t2-pill-q" data-k="mae"><small>worst</small> ' + cell(r.mae != null ? r.mae : NaN, ptsS, st, 'worst excursion not sent') + '</span>'
      + (r.fullStop ? '<span class="t2-pill t2-pill-fs">FULL STOP</span>' : '') + '</div>'
      + '<div class="t2-row-c"><span data-k="exit"><small>exit</small> ' + txt(r.ex.text, st, r.ex.why || 'exit reason not sent') + (r.ex.note ? ' <span class="t2-note">(' + esc(r.ex.note) + ')</span>' : '') + '</span></div>'
      + '<div class="t2-row-c"><span data-k="event">' + txt(r.event, st, 'event type not sent', 't2-ev') + '</span> <span data-k="level"><small>at</small> ' + txt(r.level, st, 'level not sent') + ' ' + cell(r.levelPx != null ? r.levelPx : NaN, px, st, 'level price not sent') + '</span></div>'
      + '<div class="t2-row-m"><span data-k="gross"><small>gross</small> ' + cell(r.gross != null ? r.gross : NaN, usdS, st, 'gross not sent for this trade') + '</span><span data-k="fees"><small>fees</small> ' + cell(r.fees != null ? r.fees : NaN, usd, st, r.gross == null ? 'needs gross' : 'net not settled') + '</span>'
      + '<span data-k="net"><small>net</small> ' + cell(r.net != null ? r.net : NaN, usdS, st, 'broker net not settled') + '</span></div>'
      + '<div class="t2-row-c t2-row-f" data-k="fills"><small>fills</small> ' + (r.rt && isFinite(rtMs) ? txt('broker round trip opened ' + clockPT(rtMs) + (r.rtSize != null ? ', ' + r.rtSize + ' closed' : ''), st, '') + ' <span class="t2-note">(fill ids ' + 'not sent)</span>' : unk('fill link not sent')) + '</div></li>';
  }
  function ledgerHtml(m, c) {
    var head = '<div class="t2-head"><span class="t2-title">Trade rows <span class="t2-title-sub">points per contract</span></span>' + chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-big">' + unk(m.why) + '</div>' + ageLine(m.st, c, m.at, m.age);
    var dl = m.dayLine, h = head + '<div class="t2-dayline"><div class="t2-lbl">day P&amp;L (as the header, incl. open)</div><div class="t2-big" data-k="day">' + cell(m.day != null ? m.day : NaN, usdS, m.st, 'day figure not sent') + '</div></div>'
      + '<div class="t2-row-m t2-daym" data-k="dayBreak">' + (dl ? '<span data-k="dnet"><small>closed net</small> ' + cell(dl.net, usdS, m.st, '') + '</span><span data-k="dgross"><small>gross</small> ' + cell(dl.gross, usdS, m.st, '') + '</span><span data-k="dfees"><small>fees</small> ' + cell(dl.fees, usd, m.st, '') + '</span>' : '<span class="t2-span3">closed net / gross / fees ' + unk(m.dayWhy) + '</span>') + '</div>'
      + '<dl class="t2-kv t2-kv-1 t2-kv-s"><div><dt>net of the rows below</dt><dd data-k="rowsNet">' + (m.rowsNet != null ? cell(m.rowsNet, usdS, m.st, '') + ' <span class="t2-note">= the bot’s closed net</span>' : unk(m.rows.length ? 'these ' + m.rows.length + ' rows do not add up to the day’s closed net' + (m.trips != null ? ' (' + m.trips + ' round trips)' : '') + ', total withheld' : 'no closed trade rows')) + '</dd></div></dl>';
    if (!m.rows.length) return h + '<div class="empty-state">No closed trades in today’s list.</div>' + ageLine(m.st, c, m.at, m.age);
    var rows = ledgerAll ? m.rows : m.rows.slice(0, 4);
    h += '<ol class="t2-rows">' + rows.map(function (r) { return rowHtml(r, m.st); }).join('') + '</ol>';
    if (m.rows.length > 4) h += '<button type="button" class="t2-more" data-t2act="ledger">' + (ledgerAll ? 'Show the last 4' : 'All ' + m.rows.length + ' trades today ›') + '</button>';
    return h + '<div class="t2-sub">Newest first. Older days are in the list below.</div>' + ageLine(m.st, c, m.at, m.age);
  }

  /* ── (e) gates ── */
  var OFF_KEYS = { notMacGradeB: 1, notGradeCAsia: 1 };   // blocks the owner switched off (grade-B 10/14, grade-C Asia): listed as OFF
  function gatesModel(d, c) {
    var sst = snapState(d, c), m = { st: sst, rows: [], age: null };
    if (sst === 'UNKNOWN') { m.why = !d || d.available === false ? 'no snapshot' : 'snapshot has no time'; return m; }
    var cur = d.current, cl = cur && cur.checklist, items = cl && Array.isArray(cl.items) ? cl.items : null;
    if (!items) { m.st = 'UNKNOWN'; m.why = 'current.checklist not sent'; return m; }
    var t = fin(cur.t) ? cur.t : null; m.st = worst(sst, fresh(t, LIMIT.gate, c.now)); m.age = t != null ? c.now - t : null;
    if (m.st === 'UNKNOWN') { m.why = 'the checklist has no evaluation time'; return m; }
    m.verdict = typeof cl.verdict === 'string' ? cl.verdict : null;
    items.forEach(function (it) {
      if (!it || typeof it.key !== 'string') return;
      var info = it.pass == null && (/\(info[:)]|informational|not a gate/i.test(String(it.label)) || /^Off\b|not an entry gate|Removed by owner/i.test(String(it.detail)) || /^mac/.test(it.key) || it.key === 'chopSkip');
      if (info || it.key === 'vixData') return;   // information-only rows never block on this build, and the VIX gate is inert for levels-only entries: not gates it consumes
      if (it.key === 'news' && !(d.news && fin(d.news.count) && d.news.count > 0)) { m.rows.push({ key: 'news', label: 'News pause', val: null, why: 'no calendar loaded (the pause cannot fire without one)', res: 'UNKNOWN' }); return; }
      var val = typeof it.detail === 'string' ? it.detail : null;
      if (it.key === 'controlGate' && d.controlDisplay && fin(d.controlDisplay.score) && fin(d.controlDisplay.threshold)) val = '15m control ' + d.controlDisplay.score.toFixed(3) + ' vs min ' + d.controlDisplay.threshold.toFixed(2) + (val ? ' · ' + val : '');
      var off = OFF_KEYS[it.key] || /(^|\b)(block|gate|filter|check) (is )?(switched )?off\b|\bswitched off\b/i.test(String(it.detail || ''));   // a block the owner switched off is not a gate that passed (QA 11/10 #8)
      m.rows.push({ key: it.key, label: pt12(it.label || it.key), val: val == null ? null : pt12(val), res: off && it.pass !== false ? 'OFF' : it.pass === true ? 'PASS' : it.pass === false ? 'BLOCK' : 'WAIT' });
    });
    if (d.pause && fin(d.pause.until)) m.rows.unshift({ key: 'pause', label: 'Manual pause', val: 'paused until ' + clockPT(d.pause.until), res: 'BLOCK' });
    m.n = { PASS: 0, BLOCK: 0, WAIT: 0, UNKNOWN: 0, OFF: 0 }; m.rows.forEach(function (r, i) { m.n[r.res]++; r.i = i; });
    var ORD = { BLOCK: 0, UNKNOWN: 1, WAIT: 2, PASS: 3, OFF: 4 }; m.rows.sort(function (a, b) { return ORD[a.res] - ORD[b.res] || a.i - b.i; });   // what blocks first, then the bot's own order
    m.at = t;
    return m;
  }
  function gatesHtml(m, c) {
    var head = '<div class="t2-head"><span class="t2-title">Gates this build reads</span>' + chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-big">' + unk(m.why) + '</div><div class="t2-sub">A gate the snapshot does not report is not listed as passing.</div>' + ageLine(m.st, c, m.at, m.age, 'bot evaluated');
    var old = m.st === 'STALE', h = head + '<div class="t2-gsum" data-k="sum">' + (old ? '<span class="t2-warnline">Last evaluated ' + esc(ageText(m.age)) + ' ago: results below are old, not current.</span>' : txt(m.n.BLOCK + ' block · ' + m.n.UNKNOWN + ' unknown · ' + m.n.WAIT + ' not evaluated yet · ' + m.n.PASS + ' pass' + (m.n.OFF ? ' · ' + m.n.OFF + ' off' : ''), m.st, '')) + '</div><ul class="t2-gates">';
    m.rows.forEach(function (r) {
      h += '<li class="t2-gate" data-res="' + (old ? 'OLD' : r.res) + '" data-key="' + esc(r.key) + '"><span class="t2-gate-r">' + (old ? '<s class="t2-old" data-st="STALE">' + r.res + '</s>' : r.res === 'WAIT' ? 'WAITING' : r.res) + '</span>'
        + '<span class="t2-gate-b"><span class="t2-gate-l">' + esc(r.label) + '</span><span class="t2-gate-v">' + (r.res === 'UNKNOWN' ? unk(r.why) : txt(r.val, m.st, 'value not sent')) + '</span></span></li>'; });
    return h + '</ul><div class="t2-sub">From the bot’s own entry checklist, in its order. What blocks comes first, then the bot’s own order. Information-only rows (MAC, VIX under levels-only) are left out. OFF = a block the owner switched off: it is not checked.</div>' + ageLine(m.st, c, m.at, m.age, 'bot evaluated');
  }

  function verdictHtml(m, c) {
    var link = '<button type="button" class="t2-more t2-vlink" data-t2act="checklist">Open the gates ›</button>', head = '<div class="t2-head"><span class="t2-title">Can the bot enter now?</span>' + chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-verd" data-v="UNKNOWN">' + unk(m.why) + '</div>' + link + ageLine(m.st, c, m.at, m.age, 'bot evaluated');
    var bl = m.rows.filter(function (r) { return r.res === 'BLOCK'; }), uk = m.rows.filter(function (r) { return r.res === 'UNKNOWN'; }), v = bl.length ? 'NO' : uk.length ? 'UNKNOWN' : m.n.WAIT ? 'WAITING' : 'YES';
    var line = bl.length ? 'blocked by ' + bl[0].label + (bl.length > 1 ? ' (+' + (bl.length - 1) + ' more)' : '') : uk.length ? 'no block reported, but ' + uk[0].label + ' is unknown: ' + uk[0].why : m.n.WAIT ? 'no block, ' + m.n.WAIT + ' gate' + (m.n.WAIT === 1 ? '' : 's') + ' not evaluated yet (no trigger to judge)' : 'all ' + m.n.PASS + ' reported gates pass';
    return head + '<div class="t2-verd" data-v="' + (m.st === 'STALE' ? 'OLD' : v) + '" data-k="verdict"><b>' + txt(v, m.st, '') + '</b> <span class="t2-verd-l">' + txt(line, m.st, '') + '</span></div>' + link + ageLine(m.st, c, m.at, m.age, 'bot evaluated');
  }

  /* ── (f) full-stop alert ── */
  var FS = { known: null, shown: [] };
  function ackSet() { try { var a = JSON.parse(lsGet('t210.fs.ack') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function alertStep(lm, em) {   // returns the full stops to show; fires the notification for ones that appear after the first read
    if (lm.st === 'UNKNOWN') return FS.shown;
    var ack = ackSet(), fs = lm.rows.filter(function (r) { return r.fullStop; }), first = FS.known === null; if (first) FS.known = {};
    fs.forEach(function (r) { if (!FS.known[r.id]) { FS.known[r.id] = 1; if (!first && lm.st === 'LIVE') notify(r, em); } });
    FS.shown = fs.filter(function (r) { return ack.indexOf(r.id) < 0; });
    return FS.shown;
  }
  function notifState() { try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; } catch (e) { return 'unsupported'; } }
  function notify(r, em) { try { if (notifState() === 'granted') new Notification('Full stop: ' + (r.side || '') + ' ' + ptsS(r.pts) + ' pts/contract', { body: (roomLabel(em) || 'room: UNKNOWN') + (r.level ? ' · ' + r.level : ''), tag: 't210-fs-' + r.id }); } catch (e) { /* in-page banner still shows */ } }
  function alertHtml(list, em, lm) {
    if (!list.length) return '';
    var r = list[0], room = roomLabel(em), ns = notifState();
    return '<div class="t2-alert" role="alert" data-id="' + esc(r.id) + '"><div class="t2-alert-t"><b>FULL STOP</b> ' + txt(r.side, lm.st, 'side not sent') + ' ' + cell(r.pts, ptsS, lm.st, 'pts not sent') + ' pts/contract' + (r.level ? ' at ' + esc(r.level) : '') + (list.length > 1 ? ' <span class="t2-alert-n">+' + (list.length - 1) + ' more</span>' : '')
      + '<div class="t2-alert-r" data-k="room">' + (room ? txt(room, em.st, '') + ' now' : 'room: ' + unk(em.nowWhy || em.why || 'room now not known')) + '</div></div>'
      + '<div class="t2-alert-b">' + (ns === 'default' ? '<button type="button" data-t2act="notif">Notify me</button>' : '') + '<button type="button" data-t2act="ack">Dismiss</button></div></div>';
  }

  /* ── mount + render loop ── */
  // patch, not re-render: nothing is written when the markup is the same, and when only the age line moved (every second) only that line is replaced
  function put(el, html) {
    if (!el || el.__t2 === html) return false;
    var old = el.__t2, i = html.lastIndexOf('<div class="t2-age"');
    if (i > 0 && typeof old === 'string' && old.lastIndexOf('<div class="t2-age"') === i && old.slice(0, i) === html.slice(0, i)) { var a = el.lastElementChild; if (a && a.className === 't2-age') {
      // 2.1 stage 2.1: the age line is one text node: when its tag is the same and it holds plain text, only that text node is written (no parse, no layout read)
      var nw = html.slice(i), ow = old.slice(i), g = nw.indexOf('>') + 1, body = nw.slice(g, nw.length - 6);
      if (g > 0 && nw.slice(0, g) === ow.slice(0, g) && nw.slice(-6) === '</div>' && body.indexOf('<') < 0 && body.indexOf('&') < 0 && a.childNodes.length === 1 && a.firstChild.nodeType === 3) a.firstChild.nodeValue = body;
      else a.outerHTML = nw;
      el.__t2 = html; return true; } }
    el.innerHTML = html; el.__t2 = html; return true;
  }
  function shown(id) { var v = document.getElementById(id); return !!v && v.style.display !== 'none'; }
  var LC = { d: null, st: null, m: null };
  function ledgerCached(d, c) { var st = snapState(d, c); if (d && d === LC.d && st === LC.st && LC.m) { LC.m.age = fin(d.updated) ? c.now - d.updated : null; LC.m.day = dayFigure(d, c.now); return LC.m; } LC = { d: d, st: st, m: ledgerModel(d, c) }; return LC.m; }
  var E = {};
  function mk(tag, id, cls) { var e = document.createElement(tag); e.id = id; e.className = cls; return e; }
  function mount() {
    var gi = document.querySelector('#glance .glance-inner'), dash = document.querySelector('#view-dashboard .dash-col'), tr = document.getElementById('tl-hero'), ck = document.getElementById('view-checklist');
    if (!gi || !dash || !tr || !ck) return false;
    E.stamp = mk('div', 't2-stamp', 't2-stamp'); E.alert = mk('div', 't2-alert', 't2-alert-slot'); gi.appendChild(E.stamp); gi.appendChild(E.alert);
    E.eval = mk('section', 't2-eval', 'card t2-card t2-eval'); E.eval.setAttribute('aria-label', 'Eval score');
    E.broker = mk('section', 't2-broker', 'card t2-card t2-broker'); E.broker.setAttribute('aria-label', 'Broker truth');
    E.verdict = mk('section', 't2-verdict', 'card t2-card t2-verdict'); E.verdict.setAttribute('aria-label', 'Can the bot enter now');
    // Now, by the question asked: (1) am I safe (2) what do I hold (3) may the bot trade, what blocks (4) what just happened (5) the rest, in its old order.
    // Whole cards are moved; none is restyled.
    var pc = document.getElementById('pc-card'), wnt = document.getElementById('wnt-card'), bias = document.getElementById('bias-card'), recent = null;
    var tb = document.getElementById('trades-body'); recent = tb && tb.closest ? tb.closest('.card') : null;
    if (recent && !recent.id) recent.id = 't2-recent-card';
    var first = dash.firstChild; [E.eval, E.broker, pc, E.verdict, wnt, recent, bias].forEach(function (el) { if (el) dash.insertBefore(el, first); });
    E.ledger = mk('section', 't2-ledger', 'card t2-card t2-ledger'); E.ledger.setAttribute('aria-label', 'Trade rows'); tr.parentNode.insertBefore(E.ledger, tr);
    E.gates = mk('section', 't2-gates', 'card t2-card t2-gates-card'); E.gates.setAttribute('aria-label', 'Gates this build reads'); ck.appendChild(E.gates);   // placed after the page's path card once that exists (render): the page takes the tab's first .card for its own wrapper
    E.sheet = mk('div', 't2-sheet', 't2-sheet'); E.sheet.hidden = true; document.body.appendChild(E.sheet);
    document.addEventListener('click', onClick);
    // a tab that was hidden is rendered as it is shown (tab bar, keyboard, deep link), not a second later
    var soon = function () { setTimeout(render, 0); }; document.addEventListener('click', function (ev) { if (ev.target && ev.target.closest && ev.target.closest('.tab-btn, .seg-btn, [onclick*="switchView"]')) soon(); }); document.addEventListener('keydown', soon); window.addEventListener('hashchange', soon);
    return true;
  }
  function snap() { try { return typeof pcSnap !== 'undefined' ? pcSnap : null; } catch (e) { return null; } }
  var EXTRA = [];   // later stages add (d, c) renderers here
  function render() {
    var d = snap(), c = clock(d, Date.now()), cfg = evalCfg(), vis = { now: shown('view-dashboard'), trades: shown('view-trades'), checklist: shown('view-checklist'), control: shown('view-control') };   // a hidden tab costs nothing; it is rendered the moment it is shown
    LAST.d = d; LAST.j = journalRef();
    try { var sm = stampsModel(readStamp(), c, Date.now()); LAST.stampSt = sm.st; put(E.stamp, stampsHtml(sm, c)); } catch (e) { LAST.stampSt = null; put(E.stamp, unk('stamp view failed')); }
    var em = { st: 'UNKNOWN', why: 'eval view failed', cfg: cfg }, lm = { st: 'UNKNOWN', rows: [], why: 'trade view failed' };
    try { em = evalModel(d, cfg, c); if (vis.now) put(E.eval, evalHtml(em, c)); } catch (e) { put(E.eval, unk('eval view failed')); }
    E.eval.dataset.state = em.st; E.eval.dataset.tone = em.st === 'LIVE' ? em.tone : 'unk';
    if (vis.now) try { var bm = brokerModel(d, c); put(E.broker, brokerHtml(bm, c)); E.broker.dataset.state = bm.st; E.broker.dataset.side = bm.st !== 'LIVE' ? 'unk' : (bm.side || 'flat').toLowerCase(); } catch (e) { put(E.broker, unk('broker view failed')); E.broker.dataset.state = 'UNKNOWN'; }
    try { lm = ledgerCached(d, c); if (vis.trades) put(E.ledger, ledgerHtml(lm, c)); } catch (e) { put(E.ledger, unk('trade view failed')); }
    E.ledger.dataset.state = lm.st;
    try { var cp = document.getElementById('clpath'); if (cp && cp.parentNode === E.gates.parentNode && cp.nextElementSibling !== E.gates) cp.parentNode.insertBefore(E.gates, cp.nextSibling); } catch (e) { /* order only */ }
    if (vis.now || vis.checklist) try { var gm = gatesModel(d, c); if (vis.checklist) put(E.gates, gatesHtml(gm, c)); E.gates.dataset.state = gm.st; if (vis.now) put(E.verdict, verdictHtml(gm, c)); E.verdict.dataset.state = gm.st; } catch (e) { put(E.gates, unk('gates view failed')); E.gates.dataset.state = 'UNKNOWN'; put(E.verdict, unk('gates view failed')); E.verdict.dataset.state = 'UNKNOWN'; }
    try { put(E.alert, alertHtml(alertStep(lm, em), em, lm)); } catch (e) { /* banner only */ }
    for (var i = 0; i < EXTRA.length; i++) { try { EXTRA[i](d, c, vis); } catch (e) { /* display only */ } }
  }
  function sheetHtml(cfg, err) {
    var f = function (k, lab) { return '<label class="t2-f"><span>' + lab + '</span><input type="number" inputmode="decimal" step="any" name="' + k + '" value="' + cfg[k] + '" autocomplete="off"></label>'; };
    return '<div class="t2-sheet-p" role="dialog" aria-modal="true" aria-labelledby="t2-sheet-h"><div class="t2-head"><span class="t2-title" id="t2-sheet-h">Eval lines</span></div>'
      + '<p class="t2-sub">Kept on this phone only. The balance always comes from the bot.</p>' + f('fail', 'Fail line ($)') + f('start', 'Start balance ($)') + f('target', 'Target ($)')
      + '<div class="t2-sheet-e" role="alert">' + (err ? esc(err) : '') + '</div><div class="t2-sheet-b"><button type="button" data-t2act="sheet-reset">Defaults</button><button type="button" data-t2act="sheet-close">Cancel</button><button type="button" class="t2-primary" data-t2act="sheet-save">Save lines</button></div></div>';
  }
  function closeSheet() { if (!E.sheet || E.sheet.hidden) return; E.sheet.hidden = true; var g = E.eval && E.eval.querySelector('[data-t2act="sheet"]'); if (g) g.focus(); }   // focus goes back to the button that opened it
  function onClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-t2act]') : null;
    if (!b) { if (ev.target === E.sheet) closeSheet(); return; }
    var a = b.getAttribute('data-t2act');
    if (a === 'sheet') { E.sheet.innerHTML = sheetHtml(evalCfg(), ''); E.sheet.hidden = false; var i = E.sheet.querySelector('input'); if (i) i.focus(); }
    else if (a === 'sheet-close') closeSheet();
    else if (a === 'sheet-reset') { lsSet('t210.eval', JSON.stringify(DEF)); closeSheet(); render(); }
    else if (a === 'sheet-save') { var o = {}; ['fail', 'start', 'target'].forEach(function (k) { o[k] = parseFloat(E.sheet.querySelector('[name=' + k + ']').value); });
      var badK = ['fail', 'start', 'target'].filter(function (k) { return !fin(o[k]); })[0], se = function (msg, k) { E.sheet.querySelector('.t2-sheet-e').textContent = msg; var f = E.sheet.querySelector('[name=' + k + ']'); if (f) f.focus(); };
      if (badK) se('Each line needs a number. Type one for the ' + badK + ' line.', badK);
      else if (!(o.fail < o.start && o.start < o.target)) se('Needs fail < start < target. Fix the line that is out of order.', o.fail >= o.start ? 'fail' : 'target');
      else { lsSet('t210.eval', JSON.stringify(o)); closeSheet(); render(); } }
    else if (a === 'ledger') { ledgerAll = !ledgerAll; render(); }
    else if (a === 'checklist') { try { switchView('checklist'); window.scrollTo(0, 0); } catch (e) { /* the tab bar still works */ } }
    else if (a === 'ack') { var ack = ackSet(); FS.shown.forEach(function (r) { if (ack.indexOf(r.id) < 0) ack.push(r.id); }); lsSet('t210.fs.ack', JSON.stringify(ack.slice(-200))); render(); }
    else if (a === 'notif') { try { var p = Notification.requestPermission(function () { render(); }); if (p && p.then) p.then(render, render); } catch (e) { render(); } }
  }
  window.T210 = { release: '2.1.0', fresh: fresh, worst: worst, ageText: ageText, LIMIT: LIMIT, cell: cell, txt: txt, unk: unk, chip: chip, clock: clock, snapState: snapState, stateWord: stateWord, put: put, mk: mk, EXTRA: EXTRA, E: E, timePT: timePT, datePT: datePT, pt12: pt12, ageLine: ageLine, esc: esc,
    models: { stamps: stampsModel, evalScore: evalModel, broker: brokerModel, ledger: ledgerModel, gates: gatesModel, exitOf: exitOf, posState: posState }, posState: posState, px: px, render: render };
  /* ── the 1 s tick (stage 2.1) ──
     Paused while the page is hidden (rendered again the moment it is shown). While a replay plays on a tab that shows none of the 2.1 cards (their age
     lines are not on screen) and no new data has arrived, the tick writes one text node: the header stamp's age. New data, a freshness change of the
     stamp, or a tab with 2.1 cards on it gets the full render, as before. No layout is read: views are checked by their inline display style. */
  var LAST = { d: undefined, j: undefined, stampSt: null };
  function journalRef() { try { return typeof journalEntries !== 'undefined' ? journalEntries : null; } catch (e) { return null; } }
  function replaying() {
    try { var U = window.macui || {}; if (U.reel && U.reel.state) { var rs = U.reel.state(); if (rs && rs.playing) return true; }
      var C = U.charts || {}; for (var k in C) { var ch = C[k] && C[k].h && C[k].h._c; if (ch && ch.replayState && ch.replayState.playing) return true; }
      if (window.lvReplayTimer) return true; } catch (e) { /* not known: full render */ }
    return false;
  }
  function stampAgeOnly() {   // the header stamp's tail is one text node; anything else changed -> false (full render)
    var c = clock(snap(), Date.now()), m = stampsModel(readStamp(), c, Date.now()); if (m.st !== LAST.stampSt) return false;
    var html = stampsHtml(m, c); if (E.stamp.__t2 === html) return true;
    var a = E.stamp.querySelector('.t2-st-age'), i = html.indexOf('<span class="t2-st-age"'), j = i < 0 ? -1 : html.indexOf('>', i) + 1, k = j > 0 ? html.indexOf('</span>', j) : -1, t = k > j ? html.slice(j, k) : null;
    if (!a || t == null || t.indexOf('<') >= 0 || t.indexOf('&') >= 0 || html.slice(0, j) !== String(E.stamp.__t2).slice(0, j) || a.childNodes.length !== 1 || a.firstChild.nodeType !== 3) return false;
    a.firstChild.nodeValue = t; E.stamp.__t2 = html; return true;
  }
  function tick() {
    if (document.hidden) return;
    if (snap() === LAST.d && journalRef() === LAST.j && !(shown('view-dashboard') || shown('view-trades') || shown('view-checklist') || shown('view-control')) && replaying() && stampAgeOnly()) return;
    render();
  }
  function start() { if (!mount()) return; render(); setInterval(tick, 1000); document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); }); document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
