/* MacUI-T terminal 2.1.1: v2src/t211.js. Three surfaces on the bot's edge r1.1 fields (snapshot.rules, snapshot.scorecard, recentTrades[].rule):
   (1) "Market now" on the Now tab, (2) the rule line on the page's own trade rows (Now: recent trades; Review: closed-trade cards), (3) the rule
   scorecard, a section of the Review tab. Read-only: no request, no wrapped page function. Each renderer runs from T210's 1 s render (never per
   frame), only while its tab is shown, and rebuilds its markup only when the snapshot object changed. A field the bot build does not send is
   UNKNOWN: "bot build does not report this yet". */
(function () {
  'use strict';
  var T = window.T210; if (!T) return;
  var fin = function (v) { return typeof v === 'number' && isFinite(v); }, esc = T.esc, unk = T.unk, txt = T.txt, cell = T.cell, obj = T.objOf;
  var NOT_YET = 'bot build does not report this yet', FEW = 20;
  var int = function (v) { return String(Math.round(v)); }, x1 = function (v) { return v.toFixed(1) + '×'; };
  var E = {};

  /* ── (1) market now ── */
  var EARLY = { exit: 'ON', log: 'LOG ONLY', off: 'OFF' }, PLAN = { live: 'TP1, then the runner stop', allAtTp1: 'all out at TP1', atrTarget: 'ATR runner' };
  function marketModel(d, c) {
    var st = T.snapState(d, c), m = { st: st, at: d && fin(d.updated) ? d.updated : null, age: d && fin(d.updated) ? c.now - d.updated : null };
    if (st === 'UNKNOWN') { m.why = !d || d.available === false ? 'no snapshot' : 'snapshot has no time'; return m; }
    var r = obj(d.rules); if (!r) { m.st = 'UNKNOWN'; m.why = NOT_YET; return m; }
    m.session = typeof r.sessionNow === 'string' ? T.SESSION[r.sessionNow] || r.sessionNow : null;
    m.atr = fin(r.atr15Now) ? r.atr15Now : null; m.med = fin(r.atr15Median20d) && r.atr15Median20d > 0 ? r.atr15Median20d : null; m.x = m.atr != null && m.med != null ? m.atr / m.med : null;
    var rn = obj(r.runnerNow), ea = obj(r.earlyAdverseExit), sh = obj(r.tp1AtrShadow), ny = obj(r.sessionRunnerNy);
    m.runner = rn && typeof rn.mode === 'string' ? rn.mode : null; m.tp2 = rn && fin(rn.tp2Pts) ? rn.tp2Pts : null; m.stopPts = ny && fin(ny.stopPts) ? ny.stopPts : null; m.mult = ny && fin(ny.tp2AtrMult) ? ny.tp2AtrMult : null;
    m.early = ea && typeof ea.mode === 'string' ? ea.mode : null; m.earlyAfter = ea && fin(ea.afterSec) ? ea.afterSec : null; m.earlyLoss = ea && fin(ea.lossPts) ? ea.lossPts : null;
    m.shadow = sh && typeof sh.mode === 'string' ? sh.mode : null; m.shadowPts = sh && fin(sh.tp1PtsNow) ? sh.tp1PtsNow : null;
    // the open trade's own plan (position.rule), only while a filled trade is open
    var p = obj(d.position); if (p && !p.pending && 'rule' in p) { var e = p.markers && p.markers.filter ? p.markers.filter(function (k) { return k && k.kind === 'entry'; })[0] : null, ot = d.levels && d.levels.trade && obj(d.levels.trade.open);
      m.open = T.ruleLine({ rule: p.rule, entryPrice: ot && fin(ot.entry) ? ot.entry : e && fin(e.price) ? e.price : null }, r, true); }
    return m;
  }
  function marketHtml(m, c, noAge) {   // noAge: the caller appends the age line (the body is cached while the snapshot object is the same)
    var AGE = noAge ? '' : T.ageLine(m.st, c, m.at, m.age);
    var head = '<div class="t2-head"><span class="t2-title">Market now <span class="t2-title-sub">the rules in force</span></span>' + T.chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-mk-line" data-k="line">' + unk(m.why) + '</div><div class="t2-sub">Session, ATR and the active rules come from the bot’s rules block.</div>' + AGE;
    var S = m.st, sep = ' <span class="t2-mk-dot" aria-hidden="true">·</span> ';
    var atr = '<span data-k="atr">ATR ' + cell(m.atr != null ? m.atr : NaN, int, S, 'the bot has no fresh 15m bars') + (m.atr != null ? ' <span class="t2-note">(' + (m.x != null ? cell(m.x, x1, S, '') + ' normal' : 'vs normal ' + unk('needs 20 days of 15m bars')) + ')</span>' : '') + '</span>';
    var run = '<span data-k="runner">' + (m.runner === 'atrTarget' ? 'runner target ' + (m.tp2 != null ? cell(m.tp2, function (v) { return '+' + int(v); }, S, '') : unk('needs the ATR')) : m.runner ? txt(PLAN[m.runner] || m.runner, S, '') : 'runner plan ' + unk('not sent')) + '</span>';
    var early = '<span data-k="early">early exit ' + (m.early ? txt(EARLY[m.early] || m.early, S, '', 't2-mk-' + (m.early === 'exit' ? 'on' : 'off')) : unk('not sent')) + '</span>';
    var h = head + '<div class="t2-mk-line" data-k="line"><b data-k="session">' + txt(m.session, S, 'session not known to the bot') + '</b>' + sep + atr + sep + run + sep + early + '</div>';
    var det = [];
    if (m.atr != null && m.med != null) det.push('15m ATR ' + m.atr.toFixed(1) + ' against a 20-day median of ' + m.med.toFixed(1) + '.');
    if (m.runner === 'atrTarget') det.push('A fill now: TP1, then a 1-lot runner' + (m.stopPts != null ? ' with its stop at +' + T.num(m.stopPts) : '') + (m.mult != null ? ' and its target at ' + T.num(m.mult) + '×ATR' : '') + '.');
    if (m.early === 'exit' && m.earlyAfter != null && m.earlyLoss != null) det.push('Early exit: out when a trade is ' + T.num(m.earlyLoss) + ' pts against it ' + Math.round(m.earlyAfter / 60 * 10) / 10 + ' min after the fill and never worked.');
    if (m.early === 'log') det.push('Early exit is recorded only: nothing is sent.');
    if (m.shadow === 'log') det.push('ATR TP1 is recorded only, not traded' + (m.shadowPts != null ? ' (it would be ' + T.num(Math.round(m.shadowPts * 10) / 10) + ' pts now)' : '') + '.');
    if (det.length) h += '<div class="t2-sub" data-k="detail">' + esc(det.join(' ')) + '</div>';
    if (m.open) h += '<div class="t2-mk-open" data-k="open"><small>open trade</small> ' + T.ruleHtml(m.open, S) + '</div>';
    return h + AGE;
  }

  /* ── (2) the rule line on the page's own rows ── */
  // Now: #trades-body .trade-row[data-j="rt-<entryTime>"] = recentTrades rows. One small line is appended per row; a row the page re-rendered gets it again.
  var NR = { d: null, first: null };
  function nowRows(d, st) {
    var body = document.getElementById('trades-body'); if (!body) return;
    var first = body.firstElementChild; if (d === NR.d && first === NR.first && NR.st === st) return; NR.d = d; NR.first = first; NR.st = st;
    var by = {}; (Array.isArray(d && d.recentTrades) ? d.recentTrades : []).forEach(function (t) { if (t && t.entryTime != null) by['rt-' + String(t.entryTime)] = t; });
    var rows = body.querySelectorAll('.trade-row[data-j]');
    for (var i = 0; i < rows.length; i++) { var row = rows[i], t = by[row.getAttribute('data-j')], old = row.querySelector('.t2-rule'), host = row.firstElementChild || row;
      var rl = t ? T.ruleLine(t, d.rules, !t.closed) : { absent: true, unk: NOT_YET }, html = '<small>rule</small> ' + T.ruleHtml(rl, st === 'UNKNOWN' ? 'STALE' : st) + moneyHtml(t, st);
      if (old && old.__t2 === html) continue; if (!old) { old = document.createElement('div'); old.className = 't2-rule t2-rule-pg'; old.setAttribute('data-k', 'rule'); host.appendChild(old); }
      old.innerHTML = html; old.__t2 = html; try { if (t) fixRow(row, t, d); } catch (e) { /* display only */ } }
  }
  function moneyHtml(t, st) { if (!t || !t.closed || !fin(t.grossUsd) || !fin(t.netUsd)) return ''; var S = st === 'UNKNOWN' ? 'STALE' : st;
    return '<span class="t2-rule-m" data-k="money"><small>gross</small> ' + cell(t.grossUsd, T.usdS, S, '') + ' <small>fees</small> ' + cell(fin(t.feesUsd) ? t.feesUsd : t.grossUsd - t.netUsd, T.usd, S, '') + ' <small>net</small> ' + cell(t.netUsd, T.usdS, S, '') + '</span>'; }
  // Review: a trade's card carries the time of one of that trade's journal rows (data-t). A card is matched through the journal row's
  // journalId to the bot's round trip; no match, no line.
  var RR = { d: null, j: null, first: null };
  function reviewRows(d, st) {
    var body = document.getElementById('journal-body'); if (!body) return;
    var je = null; try { je = typeof journalEntries !== 'undefined' ? journalEntries : null; } catch (e) { je = null; }
    var first = body.firstElementChild; if (d === RR.d && je === RR.j && first === RR.first && RR.st === st) return; RR.d = d; RR.j = je; RR.first = first; RR.st = st;
    var rj = {}; (Array.isArray(d && d.recentTrades) ? d.recentTrades : []).forEach(function (t) { if (t && t.journalId) rj[t.journalId] = t; });
    var byT = {}; (Array.isArray(je) ? je : []).forEach(function (e) { if (e && e.journalId && fin(e.t)) byT[String(e.t)] = e.journalId; });
    var cards = body.querySelectorAll('[data-t]');
    for (var i = 0; i < cards.length; i++) { var card = cards[i], jid = byT[card.getAttribute('data-t')], t = jid ? rj[jid] : null, host = card.querySelector(':scope > summary') || card, old = host.querySelector(':scope > .t2-rule'); if (!jid) { if (old) old.remove(); continue; }
      var rl = t ? T.ruleLine(t, d.rules, !t.closed) : { absent: true, unk: (d && 'edgeFields' in d ? 'this trade is no longer in the bot’s recent list' : NOT_YET) }, html = '<small>rule</small> ' + T.ruleHtml(rl, st === 'UNKNOWN' ? 'STALE' : st) + moneyHtml(t, st);
      if (old && old.__t2 === html) continue; if (!old) { old = document.createElement('div'); old.className = 't2-rule t2-rule-pg t2-rule-rv'; old.setAttribute('data-k', 'rule'); host.appendChild(old); }
      old.innerHTML = html; old.__t2 = html; }
  }

  /* ── (2b) the page's own trade rows, where this phone holds no fill receipt (Mac 11/11: "missing the chart next to the trade on the most recent trade") ──
     The page takes a trade's entry price, points and fill time only from a FILL_OBSERVED journal receipt, which reaches the phone when Review loads
     the journal. Without one it prints "entry UNKNOWN / points UNKNOWN / fill time unknown". The bot's own broker round trip for that trade
     (recentTrades: entryAvgPrice, ptsPerContract, entryTime / exitTime) is shown in those places instead, each labelled with its source; with no
     round trip the UNKNOWN stays. The exit chip of an all-at-TP1 trade reads "TP1 · all N out". On the Levels day list the sparkline is drawn from
     the trade's own price reads; under 2 reads the page drew nothing: here it is drawn from 1m bars around the trade (entry - 2 min to close + 2 min)
     when the snapshot has them, else the row says "too short to chart (7 s)". Rows are patched once per page render of the row, never during a replay. */
  var grp2 = function (v) { return T.px(v); }, dur = function (ms) { if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + ' s'; var mn = Math.round(ms / 60000); return mn < 60 ? mn + ' min' : Math.floor(mn / 60) + ' h' + (mn % 60 ? ' ' + (mn % 60) + ' min' : ''); };
  function fixRow(row, t, d) {   // t = the bot's round trip for this row (or null)
    var n = 0, e, rl = t ? T.ruleLine(t, d.rules, !t.closed) : null;
    var entry = t && fin(t.entryAvgPrice) ? t.entryAvgPrice : t && fin(t.entryPrice) ? t.entryPrice : null, ppc = t && t.closed && fin(t.ptsPerContract) ? t.ptsPerContract : null;
    if ((e = row.querySelector('small.lv-unk')) && entry != null) { e.className = 't2-lvsrc'; e.setAttribute('data-k', 'entry'); e.innerHTML = '<span class="num">' + esc(grp2(entry)) + '</span> <i>broker avg</i>'; e.title = 'Entry: the average of the bot’s broker round trip for this trade (no fill receipt on this phone)'; n++; }
    if ((e = row.querySelector('.res-unk')) && ppc != null) { e.className = 't2-lvsrc'; e.setAttribute('data-k', 'pts'); e.removeAttribute('aria-label'); e.title = 'Points per contract from the bot: broker gross ÷ (point value × contracts)'; e.textContent = T.ptsS(ppc) + ' pts/ct (bot)'; n++; }
    if ((e = row.querySelector('.lv-sub')) && ppc != null) { var w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), tn; while ((tn = w.nextNode())) if (tn.data.indexOf('points UNKNOWN (no observed entry price)') >= 0) { tn.data = tn.data.replace('points UNKNOWN (no observed entry price)', T.ptsS(ppc) + ' pts/ct (bot, broker gross ÷ contracts)'); n++; break; } }
    if ((e = row.querySelector('.lv-durx')) && /fill time unknown/.test(e.textContent) && t && t.closed) { var a = Date.parse(t.entryTime), b = Date.parse(t.exitTime); if (isFinite(a) && isFinite(b) && b >= a) { e.textContent = dur(b - a) + ' from the broker entry fill'; e.title = 'From the entry to the exit of the bot’s broker round trip: ' + T.timePT(a, true) + ' → ' + T.timePT(b, true); e.setAttribute('data-k', 'held'); n++; } }
    if (rl && rl.kind === 'tp1all' && rl.exit === 'TP1') { var word = 'TP1 · all ' + (fin(t.maxSize) ? t.maxSize + ' ' : '') + 'out', tip = 'All contracts left at TP1 (the bot’s rule for this trade)', host;
      if ((e = row.querySelector('.x-badge'))) { var last = e.lastChild; if (last && last.nodeType === 3) { last.data = word; e.title = tip; e.setAttribute('data-k', 'chip'); n++; } }
      else if ((host = row.querySelector('.lvr-res .res-chip'))) { e = document.createElement('span'); e.className = 'x-badge x-tp'; e.title = tip; e.setAttribute('data-k', 'chip'); e.textContent = word; host.parentNode.insertBefore(e, host.nextSibling); n++; } }
    return n;
  }
  function bars1mFor(Tr, L) {   // 1m closes around the trade, from rows the snapshot already carries: [[t, o, h, l, c] ...]
    var src = Array.isArray(Tr.bars1m) ? Tr.bars1m : L && Array.isArray(L.bars1m) ? L.bars1m : null; if (!src || !fin(Tr.openedAt)) return null;
    var from = Tr.openedAt - 120000 - 60000, to = (fin(Tr.closedAt) ? Tr.closedAt : Tr.openedAt) + 120000, out = [];
    for (var i = 0; i < src.length; i++) { var b = src[i]; if (Array.isArray(b) && fin(b[0]) && fin(b[4]) && b[0] >= from && b[0] <= to) { if (!out.length && fin(b[1])) out.push(b[1]); out.push(b[4]); } }   // the first bar's open, then each close
    return out.length >= 2 ? out : null;
  }
  function sparkFix(row, Tr, L) {
    var cell = row.children[2]; if (!cell || cell.nodeName !== 'SPAN' || cell.querySelector('svg') || cell.textContent.trim()) return 0;
    var pts = bars1mFor(Tr, L), ent = fin(Tr.entry) ? Tr.entry : null;
    if (pts) { var all = ent != null ? pts.concat([ent]) : pts, mn = Math.min.apply(null, all), mx = Math.max.apply(null, all), sx = function (i) { return 2 + i / Math.max(1, pts.length - 1) * 76; }, sy = function (p) { return 20 - (p - mn) / Math.max(0.25, mx - mn) * 18; };
      cell.innerHTML = '<svg viewBox="0 0 80 22" width="80" height="22" role="img" aria-label="1-minute bars around the trade (the trade has fewer than 2 price reads of its own)">' + (ent != null ? '<line x1="2" x2="78" y1="' + sy(ent).toFixed(1) + '" y2="' + sy(ent).toFixed(1) + '" stroke="var(--accent)" stroke-width="1" stroke-dasharray="2 2"/>' : '')
        + '<polyline points="' + pts.map(function (p, i) { return sx(i).toFixed(1) + ',' + sy(p).toFixed(1); }).join(' ') + '" fill="none" stroke="var(--t2)" stroke-width="1.5" stroke-dasharray="3 2"/></svg>'; cell.setAttribute('data-k', 'spark'); cell.setAttribute('data-src', 'bars1m'); cell.title = '1-minute bars around the trade'; return 1; }
    var ms = fin(Tr.openedAt) && fin(Tr.closedAt) ? Tr.closedAt - Tr.openedAt : null, n = Array.isArray(Tr.px) ? Tr.px.length : 0;
    cell.innerHTML = '<small class="t2-nospark">' + esc(ms != null && ms < 120000 ? 'too short to chart (' + dur(ms) + ')' : !fin(Tr.closedAt) ? 'chart starts at the 2nd price read' : 'chart not available: ' + n + ' price read' + (n === 1 ? '' : 's')) + '</small>'; cell.setAttribute('data-k', 'spark'); cell.setAttribute('data-src', 'none'); return 1;
  }
  var LR = { d: null };
  function levelsRows(d) {
    var body = document.getElementById('lv-day-body'); if (!body || !d || T.replaying()) return;
    var rows = body.querySelectorAll('.lv-trow[data-j]'), L = d.levels, tr = L && L.trade, list = tr ? (Array.isArray(tr.today) ? tr.today : []).concat(obj(tr.open) ? [tr.open] : []) : [], byKey = null, rj = null, rk = null;
    for (var i = 0; i < rows.length; i++) { var row = rows[i]; if (row.__t2d === d && row.hasAttribute('data-t2fx')) continue;
      if (!byKey) { byKey = {}; rj = {}; rk = {}; list.forEach(function (x) { if (x && x.key != null) byKey['lv-' + x.key] = x; }); (Array.isArray(d.recentTrades) ? d.recentTrades : []).forEach(function (t) { if (!t) return; if (t.journalId) rj[t.journalId] = t; if (t.entryTime != null) rk[t.contractId + '|' + t.entryTime] = t; }); }
      var Tr = byKey[row.getAttribute('data-j')]; row.__t2d = d; row.setAttribute('data-t2fx', '0'); if (!Tr) continue;
      var t = Tr.exit && rk[Tr.exit.rt] || Tr.journalId && rj[Tr.journalId] || null;
      try { row.setAttribute('data-t2fx', String(fixRow(row, t, d) + sparkFix(row, Tr, L))); } catch (e) { /* display only: the page's own row stays */ } }
  }

  /* ── (3) scorecard ── */
  // n is printed beside every figure; under 20 the block says "too few to judge" and gives no verdict.
  function few(n) { return fin(n) && n < FEW; }
  function scoreModel(d, c) {
    var st = T.snapState(d, c), m = { st: st, at: d && fin(d.updated) ? d.updated : null, age: d && fin(d.updated) ? c.now - d.updated : null };
    if (st === 'UNKNOWN') { m.why = !d || d.available === false ? 'no snapshot' : 'snapshot has no time'; return m; }
    if (!('scorecard' in d)) { m.st = 'UNKNOWN'; m.why = NOT_YET; return m; }
    var s = obj(d.scorecard); if (!s) { m.st = 'UNKNOWN'; m.why = d.mode === 'PAPER' ? 'paper mode: the bot keeps no scorecard' : 'the bot could not read its scorecard'; return m; }
    m.s = s; m.since = fin(s.since) ? s.since : null; m.updatedAt = fin(s.updatedAt) ? s.updatedAt : null; m.open = fin(s.openRecords) ? s.openRecords : null; m.rules = obj(d.rules);
    return m;
  }
  function nTag(n, what) { return '<span class="t2-sc-n" data-k="n">n = ' + (fin(n) ? n : '?') + (what ? ' ' + esc(what) : '') + (few(n) ? ' · <b class="t2-sc-few">too few to judge</b>' : '') + '</span>'; }
  function tile(k, label, valHtml, sub) { return '<div class="t2-sc-tile" data-k="' + k + '"><div class="t2-lbl">' + label + '</div><div class="t2-sc-v">' + valHtml + '</div>' + (sub ? '<div class="t2-sc-s">' + sub + '</div>' : '') + '</div>'; }
  function cnt(v, S, why) { return cell(fin(v) ? v : NaN, String, S, why || 'not sent'); }
  function money(v, S, why) { return cell(fin(v) ? v : NaN, T.usdS, S, why || 'not sent'); }
  function pts(v, S, why) { return cell(fin(v) ? v : NaN, T.ptsS, S, why || 'not sent'); }
  function scoreHtml(m, c, noAge) {
    var AGE = noAge ? '' : T.ageLine(m.st, c, m.at, m.age);
    var head = '<div class="t2-head"><span class="t2-title">Rule scorecard <span class="t2-title-sub">is each rule making or losing money</span></span>' + T.chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-big" data-k="sc-unk">' + unk(m.why) + '</div><div class="t2-sub">Per rule: how often it fired and what it made or cost, counted by the bot.</div>' + AGE;
    var s = m.s, S = m.st, h = head;
    h += '<div class="t2-sc-since" data-k="since">since ' + (m.since != null ? txt(T.datePT(m.since) + ' ' + T.timePT(m.since), S, '') : unk('start time not sent')) + (m.open ? ' <span class="t2-note" data-k="openrec">· ' + m.open + ' record' + (m.open === 1 ? '' : 's') + ' still waiting (an open trade, broker money or a shadow)</span>' : '') + '</div>';

    // early exit
    var e = obj(s.earlyExit); h += '<section class="t2-sc-b" data-k="sc-early" aria-label="Early exit"><h3 class="t2-sc-h">Early exit</h3>';
    if (!e) h += '<div>' + unk('early exit not in the bot’s scorecard') + '</div>';
    else { var sh = obj(e.shadow) || {}, assessed = [e.fired, e.passed, e.unassessed, e.logWouldExit].every(fin) ? e.fired + e.passed + e.unassessed + e.logWouldExit : null, res = fin(sh.wouldHaveHitStop) && fin(sh.wouldHaveHitTp1) ? sh.wouldHaveHitStop + sh.wouldHaveHitTp1 : null;
      var verdict = !fin(e.estSavedUsd) || res == null ? '' : few(e.fired) ? '' : e.estSavedUsd > 0 ? '<b class="t2-sc-verd" data-v="good">HELPED</b> ' : e.estSavedUsd < 0 ? '<b class="t2-sc-verd" data-v="bad">HURT</b> ' : '';
      h += nTag(e.fired, 'fired') + '<div class="t2-sc-tiles">'
        + tile('fired', 'fired', cnt(e.fired, S), 'of ' + (assessed != null ? assessed : '?') + ' closed trades with the rule on')
        + tile('saved', 'saved <span class="t2-sc-est">estimate</span>', verdict + money(e.estSavedUsd, S), 'vs the original plan, on the ' + (res != null ? res : '?') + ' with a known ending; costs left out')
        + tile('firednet', 'net of the fired trades', money(e.firedNetUsd, S), 'broker net, n = ' + (fin(e.fired) ? e.fired : '?'))
        + '</div>';
      h += '<table class="t2-sc-t" data-k="early-shadow"><caption>What would have happened to the fired trades</caption><tbody>'
        + '<tr><th scope="row">the stop would have hit</th><td>' + cnt(sh.wouldHaveHitStop, S) + '</td></tr><tr><th scope="row">TP1 would have hit</th><td>' + cnt(sh.wouldHaveHitTp1, S) + '</td></tr>'
        + '<tr><th scope="row">unresolved (neither in 30 min)</th><td>' + cnt(sh.unresolved, S) + '</td></tr>' + (fin(sh.pending) && sh.pending > 0 ? '<tr><th scope="row">still watching</th><td>' + cnt(sh.pending, S) + '</td></tr>' : '') + '</tbody></table>';
      h += '<div class="t2-sc-s" data-k="early-rest">Kept after the check: ' + cnt(e.passed, S) + ' · check not made: ' + cnt(e.unassessed, S) + (fin(e.logWouldExit) && e.logWouldExit > 0 ? ' · log only, would have exited: ' + cnt(e.logWouldExit, S) : '') + '. Points saved: ' + unk('not in the bot’s scorecard') + '</div>'; }
    h += '</section>';

    // runner by session
    var r = obj(s.runner), plan = m.rules && obj(m.rules.sessionRunner); h += '<section class="t2-sc-b" data-k="sc-runner" aria-label="Runner by session"><h3 class="t2-sc-h">Runner by session</h3>';
    if (!r) h += '<div>' + unk('runner not in the bot’s scorecard') + '</div>';
    else { h += '<table class="t2-sc-t t2-sc-grid" data-k="runner-t"><thead><tr><th scope="col">session</th><th scope="col">plan now</th><th scope="col">trades</th><th scope="col">TP1 hits</th></tr></thead><tbody>';
      ['asia', 'london', 'ny', 'late'].forEach(function (k) { var x = obj(r[k]); h += '<tr data-s="' + k + '"><th scope="row">' + T.SESSION[k] + '</th><td class="t2-sc-l">' + (plan && typeof plan[k] === 'string' ? txt(PLAN[plan[k]] || plan[k], S, '') : unk('not sent')) + '</td><td>' + (x ? cnt(x.trades, S) : unk('not sent')) + '</td><td>' + (x ? cnt(x.tp1Hits, S) : unk('not sent')) + '</td></tr>'; });
      h += '</tbody></table>';
      ['asia', 'london', 'ny', 'late'].forEach(function (k) { var x = obj(r[k]), a = x && obj(x.atrRunner); if (!a || !(fin(a.n) && a.n > 0) && !(plan && plan[k] === 'atrTarget')) return;
        h += '<div class="t2-sc-sub" data-k="atr-' + k + '"><div class="t2-sc-sh">' + T.SESSION[k] + ' ATR runner ' + nTag(a.n, 'runners') + '</div><div class="t2-sc-tiles">'
          + tile('runnernet', 'net of those trades', money(a.runnerNetUsd, S), 'broker net, whole trades')
          + tile('avgpts', 'average runner', (fin(a.avgRunnerPts) ? pts(a.avgRunnerPts, S) + ' <small>pts</small>' : unk(fin(a.n) && a.n === 0 ? 'no runner yet' : 'not sent')), 'from the entry, 1 lot')
          + tile('r30', 'reached +30, then back to the stop', cnt(a.reached30BeforeEntry, S), 'of ' + (fin(a.n) ? a.n : '?') + ' runners')
          + '</div><div class="t2-sc-s" data-k="ends">How the runner ended: target hit ' + cnt(a.tp2Hits, S) + ' · stopped at the + stop ' + cnt(a.stoppedAtPlus2, S) + ' · session close ' + cnt(a.sessionClosed, S) + ' · other ' + cnt(a.other, S) + '</div></div>'; }); }
    h += '</section>';

    // ATR TP1 shadow
    var a = obj(s.tp1AtrShadow); h += '<section class="t2-sc-b" data-k="sc-shadow" aria-label="ATR TP1 shadow"><h3 class="t2-sc-h">ATR TP1 shadow <span class="t2-sc-est">recorded only, not traded</span></h3>';
    if (!a) h += '<div>' + unk('ATR TP1 shadow not in the bot’s scorecard') + '</div>';
    else if (a.mode === 'off') h += '<div data-k="shadow-off">' + txt('OFF: nothing is recorded', S, '') + '</div>';
    else { var sn = obj(a.shadowNetUsd) || {}, xs = obj(a.extraFullStops) || {};
      h += nTag(a.resolved, 'resolved of ' + (fin(a.n) ? a.n : '?') + ' shadowed') + '<table class="t2-sc-t t2-sc-grid" data-k="shadow-t"><thead><tr><th scope="col">on the same ' + (fin(a.resolved) ? a.resolved : '?') + ' trades</th><th scope="col">net</th><th scope="col">extra full stops</th></tr></thead><tbody>'
        + '<tr data-r="live"><th scope="row">live (what the bot did)</th><td>' + money(a.liveNetUsd, S) + '</td><td>—</td></tr>'
        + '<tr data-r="plain"><th scope="row">shadow, original stop</th><td>' + money(sn.plain, S) + '</td><td>' + cnt(xs.plain, S) + '</td></tr>'
        + '<tr data-r="be"><th scope="row">shadow, stop to entry after +15</th><td>' + money(sn.beAfter15, S) + '</td><td>' + cnt(xs.beAfter15, S) + '</td></tr></tbody></table>'
        + '<div class="t2-sc-s" data-k="shadow-rest">Unresolved ' + cnt(a.unresolved, S) + ' · pending ' + cnt(a.pending, S) + (fin(a.liveNetUsdMissing) && a.liveNetUsdMissing > 0 ? ' · ' + a.liveNetUsdMissing + ' resolved left out (broker money not matched)' : '') + '. Shadow model: all contracts leave at the outcome, minus the round-trip cost; no runner.</div>'; }
    h += '</section>';

    // totals per session
    var t = obj(s.totals); h += '<section class="t2-sc-b" data-k="sc-totals" aria-label="Totals per session"><h3 class="t2-sc-h">Totals per session</h3>';
    if (!t) h += '<div>' + unk('totals not in the bot’s scorecard') + '</div>';
    else { h += nTag(obj(t.all) ? t.all.trades : NaN, 'closed trades with broker money') + '<table class="t2-sc-t t2-sc-grid t2-sc-5" data-k="totals-t"><thead><tr><th scope="col">session</th><th scope="col">trades</th><th scope="col">wins</th><th scope="col">full stops</th><th scope="col">net</th><th scope="col">pts/ct</th></tr></thead><tbody>';
      ['asia', 'london', 'ny', 'late', 'all'].forEach(function (k) { var x = obj(t[k]); h += '<tr data-s="' + k + '"' + (k === 'all' ? ' class="t2-sc-all"' : '') + '><th scope="row">' + (k === 'all' ? 'All' : T.SESSION[k]) + '</th>' + (x ? '<td>' + cnt(x.trades, S) + '</td><td>' + cnt(x.wins, S) + '</td><td>' + cnt(x.fullStops, S) + '</td><td>' + money(x.netUsd, S) + '</td><td>' + (fin(x.ptsPerContract) ? pts(x.ptsPerContract, S) : x.trades === 0 ? '<span class="t2-note">no trades</span>' : unk('not sent')) + '</td>' : '<td colspan="5">' + unk('not sent') + '</td>') + '</tr>'; });
      h += '</tbody></table><div class="t2-sc-s">Net = broker net. Pts/ct = gross points per contract.</div>'; }
    h += '</section>';
    return h + AGE;
  }

  /* ── mount + step ── */
  function mount() {
    var v = T.E && T.E.verdict, jb = document.getElementById('journal-body'), jc = jb && jb.closest ? jb.closest('.card') : null, ok = false;
    if (v && v.parentNode) { E.market = T.mk('section', 't2-market', 'card t2-card t2-market'); E.market.setAttribute('aria-label', 'Market now'); v.parentNode.insertBefore(E.market, v); ok = true; }   // Eval, Broker truth, Position, Market now, Can the bot enter
    if (jc && jc.parentNode) { E.score = T.mk('section', 't2-score', 'card t2-card t2-score'); E.score.setAttribute('aria-label', 'Rule scorecard'); jc.parentNode.insertBefore(E.score, jc); ok = true; }
    return ok;
  }
  var MC = { d: null, st: null, m: null }, SC = { d: null, st: null, h: null, m: null };
  function step(d, c, vis) {
    var st = T.snapState(d, c);
    if (vis.now) {
      if (E.market) { try { var m = MC.d === d && MC.st === st && MC.m ? MC.m : marketModel(d, c); if (MC.m !== m) MC = { d: d, st: st, m: m, h: null }; m.age = d && fin(d.updated) ? c.now - d.updated : null; var mb = MC.h && MC.m === m && st === 'LIVE' ? MC.h : marketHtml(m, c, true); MC.h = mb; T.put(E.market, mb + T.ageLine(m.st, c, m.at, m.age)); E.market.dataset.state = m.st; } catch (e) { T.put(E.market, unk('market view failed')); E.market.dataset.state = 'UNKNOWN'; } }
      try { nowRows(d, st); } catch (e) { /* display only */ }
    }
    if (T.shown('view-levels')) { try { levelsRows(d); } catch (e) { /* display only */ } }
    if (T.shown('view-journal')) {
      if (E.score) { try { var s = SC.d === d && SC.st === st && SC.m ? SC.m : scoreModel(d, c); if (SC.m !== s) SC = { d: d, st: st, m: s, h: null }; s.age = d && fin(d.updated) ? c.now - d.updated : null; var sb = SC.h && SC.m === s && st === 'LIVE' ? SC.h : scoreHtml(s, c, true); SC.h = sb; T.put(E.score, sb + T.ageLine(s.st, c, s.at, s.age)); E.score.dataset.state = s.st; } catch (e) { T.put(E.score, unk('scorecard view failed')); E.score.dataset.state = 'UNKNOWN'; } }
      try { reviewRows(d, st); } catch (e) { /* display only */ }
    }
  }
  T.models.market = marketModel; T.models.score = scoreModel; T.html211 = { market: marketHtml, score: scoreHtml };
  function start() { if (!mount()) return; T.EXTRA.push(step); T.render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
