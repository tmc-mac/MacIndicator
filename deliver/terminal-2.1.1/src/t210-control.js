/* MacUI-T terminal 2.1.1: the receipts are driven by the bot's own acks when it sends them (snapshot.requests, bot edge r1): the POST's requestId
   is matched to requests.lastAck / recent, and the receipt shows the chain sent -> bot received -> result with the bot's times. APPLIED = "BOT CONFIRMED".
   No ack yet: the 2.1.0 states, labelled "waiting for the bot". A bot with no requests block: the 2.1.0 inference, labelled "inferred".
   MacUI-T terminal 2.1.0 stage 2: receipts for the danger-zone and pause buttons (Mac, 11/10: "I don't need any buttons in the terminal for show").
   Every send shows its result AT the button, in an element the poll does not touch: SENDING -> SENT (with the PT time) -> APPLIED (the bot's
   snapshot shows the effect) or FAILED (the HTTP error, or no answer) with a retry; after 45 s without the effect: NOT APPLIED YET, with the bot's
   last-seen age. The page's own handlers, endpoints, request bodies, key and two-tap confirmation are unchanged: this module only WATCHES the three
   POSTs through a pass-through around window.fetch (same arguments in, the same promise out) and reads the snapshot the page already polls.
   The press-and-hold prototype is switched off and its toggle removed: with it on, releasing the hold sent the flatten with no confirming tap. */
(function () {
  'use strict';
  var T = window.T210; if (!T) return;
  var fin = function (v) { return typeof v === 'number' && isFinite(v); }, esc = T.esc;
  var NOANSWER_MS = 12000, LATE_MS = 45000, HOLD_MS = 45000, NA_STEP_MS = 15000, R = {}, seq = 0, last404 = false;
  // QA 11/10 #1, #2: APPLIED must mean the tap CHANGED something. Each send keeps what the bot's snapshot showed at the tap (base): a pause must
  // move the pause end, a resume must end a running pause, a flatten must close an open position, a cancel must leave no resting entry AND no
  // new position or fill. APPLIED is held open to correction by later snapshots for 45 s before it is kept.
  function snapNow() { try { return typeof pcSnap !== 'undefined' ? pcSnap : null; } catch (e) { return null; } }
  function pauseActive(d, now) { return !!(d && d.pause && fin(d.pause.until) && d.pause.until > now); }
  function openOf(d) { var t = d && d.levels && d.levels.trade; return t && t.open && typeof t.open === 'object' ? t.open : null; }
  function rowIds(d) { var t = d && d.levels && d.levels.trade; return t && Array.isArray(t.today) ? t.today.map(function (r) { return r && (r.journalId || r.key); }).filter(Boolean) : null; }
  function baseOf(d, now) {
    if (!d || d.available === false || !fin(d.updated)) return null;
    var o = openOf(d);
    return { updated: d.updated, pos: 'position' in d ? T.posState(d).kind : undefined, pauseKnown: 'pause' in d, pauseUntil: pauseActive(d, now) ? d.pause.until : null, rows: rowIds(d), openKey: o ? (o.key || o.journalId || null) : null };
  }
  function filledSince(d, base) {   // the snapshot shows a position or a fill that was not there at the tap
    var p = d.position, o = openOf(d), ps = T.posState(d), openNow = ps.kind === 'open' || !!(p && typeof p === 'object' && !p.pending) || !!o;
    if (openNow && !(base && base.pos === 'open')) return true;
    if (o && base && base.openKey != null && (o.key || o.journalId) !== base.openKey) return true;
    var ids = base && base.rows ? rowIds(d) : null; return !!(ids && ids.some(function (id) { return base.rows.indexOf(id) < 0; }));
  }
  function holding(d) { var ps = T.posState(d); if (ps.kind === 'pending') return 'the bot says so; its snapshot still shows the resting entry'; if (ps.kind == null) return 'position UNKNOWN: ' + ps.why; if (ps.kind !== 'open') return 'that trade has since closed (see Trades)';
    return 'you hold ' + (ps.side ? ps.side + (fin(ps.qty) ? ' ' + ps.qty : '') : 'a position') + (fin(ps.avg) ? ' @ ' + T.px(ps.avg) : ''); }
  var WHAT = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel entry', flatten: 'Flatten' };

  /* ── watch the three POSTs (pass-through) ── */
  var F0 = window.fetch;
  if (typeof F0 === 'function') window.fetch = function (input, init) {
    var p = F0.apply(this, arguments);
    try { watch(typeof input === 'string' ? input : (input && input.url) || '', init, p); } catch (e) { /* watching never changes the request */ }
    return p;
  };
  function watch(url, init, p) {
    if (!init || String(init.method || '').toUpperCase() !== 'POST') return;
    var m = /^\/(pause|flatten|cancel-entry)\?(.*)$/.exec(url); if (!m) return;
    var q = new URLSearchParams(m[2]), key = m[1] === 'pause' ? (q.get('minutes') === '0' ? 'resume' : 'pause') : m[1] === 'flatten' ? 'flatten' : 'cancel';
    var rec = { key: key, st: 'SENDING', at: Date.now(), id: ++seq, minutes: key === 'pause' ? Number(q.get('minutes')) : null }; rec.base = baseOf(snapNow(), rec.at);
    R[key] = rec; if (key === 'pause') R.resume = null; if (key === 'resume') R.pause = null; T.render();
    p.then(function (res) {
      var status = res.status, okHttp = res.ok;
      res.clone().json().then(function (j) { return j; }, function () { return null; }).then(function (j) {
        if (R[key] !== rec) return;
        var ok = okHttp && j && (key === 'cancel' ? typeof j === 'object' : j.success === true);
        if (key === 'pause' || key === 'resume') last404 = status === 404;
        if (ok) { rec.st = 'SENT'; rec.sentAt = Date.now(); if (typeof j.requestId === 'string' && j.requestId) rec.reqId = j.requestId; if (fin(j.requestedAt)) rec.reqAt = j.requestedAt; }
        else { rec.st = 'FAILED'; rec.why = 'HTTP ' + status + (j && typeof j.errorMessage === 'string' ? ': ' + j.errorMessage.slice(0, 120) : j && typeof j.reason === 'string' ? ': ' + j.reason.slice(0, 120) : ''); }
        T.render();
      });
    }, function () { if (R[key] !== rec) return; rec.st = 'FAILED'; rec.why = 'no answer: the request did not reach the bot’s server'; T.render(); });
  }

  /* ── the receipt: a pure function of (record, snapshot, now) ── */
  function effect(key, d, now, base) {   // has the bot's snapshot shown the effect? true / false / null (cannot tell). base undefined = not kept: the snapshot alone decides
    if (!d || d.available === false) return null;
    if (key === 'pause') { if (!('pause' in d)) return null; if (!pauseActive(d, now)) return false; return !(base && base.pauseUntil != null && Math.abs(d.pause.until - base.pauseUntil) < 1000); }
    if (key === 'resume') return 'pause' in d ? !pauseActive(d, now) : null;
    var ps = T.posState(d); if (ps.kind == null) return null;
    if (key === 'flatten') return base && base.pos === 'pending' ? ps.kind === 'flat' : ps.kind !== 'open';
    return ps.kind === 'flat' && !filledSince(d, base);
  }
  /* 2.1.1: the bot's ack for this send. requests = { lastAck, recent [last 10], appliedAt, pollMs }; an ack = { id, type flatten / pause / cancel,
     requestedAt, receivedAt, at, result APPLIED / REJECTED / STALE / PENDING, reason }. Matched by the id the server returned for THIS tap, never
     by time or type alone. A cancel ack carries the first 16 characters of the cancel request's id. */
  function reqsOf(d) { var q = d && d.requests; return q && typeof q === 'object' && !Array.isArray(q) ? q : null; }
  function ackFor(rec, d, cancelRc) {
    var q = reqsOf(d); if (!q) return null;
    var id = rec.reqId != null ? String(rec.reqId) : rec.key === 'cancel' && cancelRc && cancelRc.requestId != null ? String(cancelRc.requestId) : null; if (!id) return null;
    var type = rec.key === 'flatten' ? 'flatten' : rec.key === 'cancel' ? 'cancel' : 'pause', list = [q.lastAck].concat(Array.isArray(q.recent) ? q.recent : [], Array.isArray(q.acks) ? q.acks : []);
    for (var i = 0; i < list.length; i++) { var a = list[i]; if (a && typeof a === 'object' && a.id != null && typeof a.result === 'string' && (String(a.id) === id || type === 'cancel' && id.length > 16 && String(a.id) === id.slice(0, 16)) && (a.type == null || a.type === type)) return a; }
    return null;
  }
  var CODES = { ALREADY_FLAT: 'already flat', ALREADY_FLATTENING: 'already flattening', NOT_PAUSED: 'was not paused', INVALID_MINUTES: 'invalid minutes', FILLED_FIRST: 'the entry filled first', POSITION_UNREADABLE: 'the broker position could not be read', FUTURE_TIME: 'the request time is ahead of the bot’s clock', MALFORMED: 'unreadable request', DUPLICATE: 'duplicate', STALE: 'too old', HALTED: 'bot halted', ERROR: 'error' };
  function reasonText(a) { var r = a.reason == null ? '' : T.pt12(String(a.reason).slice(0, 200)); return r.replace(/^([A-Z][A-Z0-9_]{2,}):\s*/, function (x, code) { return (CODES[code] || code.toLowerCase().replace(/_/g, ' ')) + ': '; }); }
  function ackModel(m, rec, a, d, now) {
    var res = String(a.result).toUpperCase(), why = reasonText(a), halted = /\bHALT/i.test(String(a.result) + ' ' + String(a.reason || '')), dup = /^DUPLICATE\b/i.test(String(a.reason || '')) || res === 'DUPLICATE';
    m.ack = res; m.chain = { sentAt: fin(rec.sentAt) ? rec.sentAt : rec.at, recvAt: fin(a.receivedAt) ? a.receivedAt : null, at: fin(a.at) ? a.at : null }; m.appliedAt = m.chain.at;
    if (res === 'APPLIED') { m.state = 'CONFIRMED'; m.chain.word = 'applied';
      m.line = (rec.key === 'pause' && d && d.pause && fin(d.pause.until) && d.pause.until > now ? 'paused until ' + T.timePT(d.pause.until) + ' · ' : '') + (why || 'applied'); return m; }
    if (res === 'PENDING') { m.state = 'PENDING'; m.chain.word = 'retrying'; m.line = 'the bot has it and is retrying: ' + (why || 'not finished yet'); m.note = 'Not done yet. If you hold a position, check TopstepX.'; return m; }
    m.retry = !halted;
    if (halted || res === 'REFUSED') { m.state = 'REFUSED'; m.chain.word = 'refused'; m.line = halted ? 'REFUSED: bot halted' + (rec.key === 'flatten' || rec.key === 'cancel' ? ' · flatten in TopstepX' : '') : 'REFUSED: ' + (why || 'no reason given'); m.note = halted && why ? 'Bot: ' + why : ''; m.retry = false; return m; }
    if (res === 'STALE') { m.state = 'STALEREQ'; m.chain.word = 'not done'; m.line = 'NOT DONE: ' + (why || 'the request was too old when the bot read it'); return m; }
    if (rec.key === 'cancel' && /^FILLED_FIRST\b/.test(String(a.reason || ''))) { m.state = 'FILLED'; m.chain.word = 'not cancelled'; m.retry = false; m.line = 'ENTRY FILLED before the cancel — ' + (d && 'position' in d ? holding(d) : 'the bot says so'); m.note = 'Cancel does not close a position; Flatten does. Bot: ' + why; return m; }
    if (dup) { m.state = 'DUPLICATE'; m.chain.word = 'duplicate'; m.line = 'DUPLICATE: ' + (why.replace(/^duplicate:\s*/, '') || 'this request was already handled'); m.retry = false; return m; }
    m.state = 'REJECTED'; m.chain.word = res === 'REJECTED' ? 'rejected' : res.toLowerCase(); m.line = (res === 'REJECTED' ? 'REJECTED: ' : res + ': ') + (why || 'no reason given'); return m;
  }
  function receiptModel(rec, d, now, cancelRc) {
    var m = receiptModel0(rec, d, now, cancelRc); if (!m || rec.st === 'SENDING' || rec.st === 'FAILED') return m;
    var q = reqsOf(d), a = rec.ack || ackFor(rec, d, cancelRc);
    if (a) { var m2 = { key: m.key, what: m.what, at: m.at, seen: m.seen }; return ackModel(m2, rec, a, d, now); }
    // no ack (yet): the 2.1.0 state stands, and says what it is
    if (rec.sawReqs || q) { m.tag = 'waiting for the bot'; m.chain = { sentAt: fin(rec.sentAt) ? rec.sentAt : rec.at, recvAt: null, at: null };
      if (!rec.reqId && rec.key !== 'cancel') { m.tag = 'inferred'; m.chain = null; m.tagWhy = 'The server returned no request id, so the bot’s answer cannot be matched to this tap.'; }
      else if (m.state === 'SENT' && /^waiting for the bot \(/.test(m.line)) m.line = 'waiting for the bot to confirm (it checks about every ' + (q && fin(q.pollMs) ? Math.max(1, Math.round(q.pollMs / 1000)) : 3) + ' s)';
      else if (m.state === 'APPLIED') m.tagWhy = 'The snapshot shows the effect; the bot’s own confirmation has not arrived.'; }
    else { m.tag = 'inferred'; m.tagWhy = m.state === 'APPLIED' || m.state === 'FILLED' ? 'Read from the snapshot’s effect: this bot build does not confirm requests yet.' : 'This bot build does not confirm requests yet: the result will be read from the snapshot’s effect.'; }
    return m;
  }
  function receiptModel0(rec, d, now, cancelRc) {
    if (!rec) return null;
    var m = { key: rec.key, what: WHAT[rec.key] + (rec.key === 'pause' && fin(rec.minutes) ? ' ' + rec.minutes + ' min' : ''), at: rec.at, state: rec.st, seen: d && fin(d.updated) ? d.updated : null };
    if (rec.st === 'APPLIED') { m.line = rec.appliedLine; m.appliedAt = rec.appliedAt; return m; }
    if (rec.st === 'FILLED') { m.line = rec.filledLine; m.note = rec.filledNote; m.appliedAt = rec.filledAt; return m; }
    if (rec.st === 'FAILED') { m.line = rec.why; m.retry = true; return m; }
    if (rec.st === 'SENDING') { if (now - rec.at > NOANSWER_MS) { m.state = 'FAILED'; m.line = 'no answer after ' + Math.round((now - rec.at) / 1000) + ' s: not confirmed sent'; m.retry = true; } else m.line = 'sending…'; return m; }
    // SENT: applied only on a snapshot the bot wrote after the send
    var base = rec.base, newer = m.seen != null && m.seen > rec.at, eff = newer ? effect(rec.key, d, now, base) : null, rcOut = rec.key === 'cancel' && cancelRc && typeof cancelRc.outcome === 'string' ? cancelRc.outcome : null;
    var rcDetail = rcOut && cancelRc.detail ? String(cancelRc.detail).slice(0, 140) : '';
    // a cancel that lost the race: the entry filled first (the bot says so, or its snapshot shows a position or fill that was not there at the tap)
    if (rec.key === 'cancel' && (rcOut === 'filled' || newer && 'position' in d && filledSince(d, base))) { m.state = 'FILLED'; m.appliedAt = newer ? m.seen : now;
      m.line = 'ENTRY FILLED before the cancel — ' + (newer ? holding(d) : 'the bot says so'); m.note = 'Cancel does not close a position; Flatten does.' + (rcOut === 'filled' && rcDetail ? ' Bot: ' + rcDetail : ''); return m; }
    if (rcOut === 'unknown') m.note = String(cancelRc.detail || '').slice(0, 160);
    else if (rcOut === 'cancelled' || rcOut === 'resolved') m.note = 'The bot says the entry order was ' + rcOut + (rcDetail ? ': ' + rcDetail : '') + '.';
    // nothing to change when it was sent: said so, never green, never escalated
    var noop = !base ? null : rec.key === 'resume' && base.pauseKnown && base.pauseUntil == null ? 'no pause was running when sent: new entries were already allowed'
      : rec.key === 'flatten' && base.pos === 'flat' ? 'no position and no resting entry when sent: nothing to flatten'
      : rec.key === 'cancel' && (base.pos === 'flat' || base.pos === 'open') ? 'no resting entry when sent: nothing to cancel' : null;
    if (noop) { m.line = noop; return m; }
    if (eff === true) { m.state = 'APPLIED'; m.appliedAt = m.seen; var ps = T.posState(d);
      m.line = rec.key === 'pause' ? 'paused until ' + T.timePT(d.pause.until) + (base && base.pauseUntil != null ? ' (was until ' + T.timePT(base.pauseUntil) + ')' : '') : rec.key === 'resume' ? 'resumed: new entries allowed again'
        : rec.key === 'flatten' ? (ps.kind === 'pending' ? 'flat: no open position; a resting entry is still working' : 'no open position in the bot’s snapshot')
        : rcOut === 'cancelled' || rcOut === 'resolved' ? 'entry order ' + rcOut + (rcDetail ? ': ' + rcDetail : '') : 'no resting entry in the bot’s snapshot';
      if (rcOut === 'cancelled' || rcOut === 'resolved') m.note = ''; return m; }
    var again = rec.key === 'pause' && base && base.pauseUntil != null && pauseActive(d, now) && Math.abs(d.pause.until - base.pauseUntil) < 1000 ? 'already paused until ' + T.timePT(d.pause.until) : null;
    if (!m.note && (rec.key === 'flatten' || rec.key === 'cancel') && newer && 'position' in d && T.posState(d).kind == null) m.note = 'Position UNKNOWN: ' + T.posState(d).why + '.';
    if (now - rec.at > LATE_MS) { m.state = 'LATE'; m.line = 'not applied yet — ' + (again ? again + ' (the bot has not changed it); ' : '') + 'bot last seen ' + (m.seen != null ? T.ageText(now - m.seen) + ' ago' : 'UNKNOWN: no snapshot'); m.retry = true; return m; }
    m.line = again ? again + ': waiting for the bot to apply the new pause' : 'waiting for the bot (it reads requests about every 20 s)'; return m;
  }
  var WORD = { SENDING: 'SENDING', SENT: 'SENT', APPLIED: 'APPLIED', FAILED: 'FAILED', LATE: 'NOT APPLIED YET', FILLED: 'NOT CANCELLED', CONFIRMED: 'BOT CONFIRMED', PENDING: 'BOT RECEIVED', REFUSED: 'BOT REFUSED', STALEREQ: 'STALE', DUPLICATE: 'BOT REJECTED', REJECTED: 'BOT REJECTED' };
  // the chain: sent -> bot received -> result, each with its own time (the phone's clock for "sent", the bot's for the other two)
  function chainHtml(ch, state) {
    if (!ch) return '';
    var step = function (on, label, t, k) { return '<li data-on="' + (on ? 1 : 0) + '" data-k="' + k + '"><i aria-hidden="true"></i><span class="t2r-cl">' + esc(label) + '</span> <span class="t2r-ct">' + (on && fin(t) ? esc(T.timePT(t, true)) : on ? 'time not sent' : '…') + '</span></li>'; };
    var got = ch.recvAt != null || ch.at != null || !!ch.word;
    return '<ol class="t2r-chain" data-k="chain" aria-label="Sent, bot received, result">' + step(true, 'sent', ch.sentAt, 'c-sent') + step(got, 'bot received', ch.recvAt, 'c-recv') + step(!!ch.word, ch.word || 'result', ch.at, 'c-res') + '</ol>';
  }
  function receiptHtml(m, withButtons) {
    if (!m) return '';
    var acked = !!m.ack, seenSt = m.state === 'APPLIED' || m.state === 'FILLED' && !acked, t = (seenSt || acked) && fin(m.appliedAt) ? T.timePT(m.appliedAt, true) : T.timePT(m.at, true);
    var alert = m.state === 'FAILED' || m.state === 'FILLED' || m.state === 'REFUSED' || m.state === 'REJECTED' || m.state === 'STALEREQ';
    return '<div class="t2r" data-state="' + m.state + '" data-key="' + m.key + '"' + (m.ack ? ' data-ack="' + esc(m.ack) + '"' : '') + (m.tag ? ' data-tag="' + (m.tag === 'inferred' ? 'inferred' : 'waiting') + '"' : '') + ' role="' + (alert ? 'alert' : 'status') + '"><div class="t2r-t"><b class="t2r-w">' + WORD[m.state] + '</b> <span class="t2r-k">' + esc(m.what) + '</span> <span class="t2r-at">' + (acked ? (m.state === 'CONFIRMED' ? 'confirmed ' : 'bot answered ') : seenSt ? 'seen ' : m.state === 'SENDING' || m.state === 'FAILED' ? 'tapped ' : 'sent ') + esc(t) + '</span>'
      + (m.tag ? ' <span class="t2r-tag" data-k="tag">' + esc(m.tag) + '</span>' : '')
      + '<div class="t2r-l" data-k="line">' + esc(m.state === 'LATE' || acked && m.state !== 'CONFIRMED' && m.state !== 'PENDING' ? m.line : m.line.charAt(0).toUpperCase() + m.line.slice(1)) + '</div>' + (m.note ? '<div class="t2r-n">' + esc(m.note) + '</div>' : '') + (m.tagWhy ? '<div class="t2r-n" data-k="tagwhy">' + esc(m.tagWhy) + '</div>' : '')
      + chainHtml(m.chain, m.state)
      + (m.retry && withButtons ? '<div class="t2r-n">Retry arms the button again; the second tap still confirms.</div>' : '') + '</div>'
      + (withButtons ? '<div class="t2r-b">' + (m.retry ? '<button type="button" data-t2r="retry" data-key="' + m.key + '">Retry</button>' : '') + (m.state !== 'SENDING' ? '<button type="button" data-t2r="clear" data-key="' + m.key + '">Clear</button>' : '') + '</div>' : '') + '</div>';
  }

  /* ── mount at the buttons ── */
  var E = {};
  function mount() {
    var res = document.getElementById('ctl-resume'), cn = document.getElementById('ctl-cancel'), fl = document.getElementById('ctl-flatten'), pb = document.getElementById('position-body');
    if (!res || !cn || !fl) return false;
    E.pause = T.mk('div', 't2r-pause', 't2r-slot'); res.parentNode.insertBefore(E.pause, res.nextSibling);
    E.cancel = T.mk('div', 't2r-cancel', 't2r-slot'); cn.parentNode.insertBefore(E.cancel, cn.nextSibling);
    E.flatten = T.mk('div', 't2r-flatten', 't2r-slot'); fl.parentNode.insertBefore(E.flatten, fl.nextSibling);
    if (pb && pb.parentNode) { E.flattenPos = T.mk('div', 't2r-flatten-pos', 't2r-slot'); pb.parentNode.insertBefore(E.flattenPos, pb.nextSibling); }
    // the hold prototype: off for good (its own change handler clears its flag), toggle and hint removed from view
    var tg = document.getElementById('hold-toggle');
    if (tg) { if (tg.checked) { tg.checked = false; tg.dispatchEvent(new Event('change', { bubbles: true })); } tg.disabled = true; var lab = tg.closest('label'); if (lab) lab.style.display = 'none'; }
    try { window.localStorage.removeItem('macui-proto-hold-flatten'); } catch (e) { /* nothing stored */ }
    var hh = document.getElementById('hold-hint'); if (hh) { hh.textContent = ''; hh.style.display = 'none'; }
    document.addEventListener('click', onClick);
    return true;
  }
  function btnFor(key, rec) {
    if (key === 'flatten') return document.getElementById('ctl-flatten'); if (key === 'cancel') return document.getElementById('ctl-cancel'); if (key === 'resume') return document.getElementById('ctl-resume');
    var want = rec && fin(rec.minutes) ? rec.minutes : null, ks = document.querySelectorAll('.ctl-keys .ctl-key');
    for (var i = 0; i < ks.length; i++) if (new RegExp('ctlPauseTap\\(this,\\s*' + want + '\\)').test(ks[i].getAttribute('onclick') || '')) return ks[i];
    return null;
  }
  function onClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-t2r]') : null; if (!b) return;
    var key = b.getAttribute('data-key'), rec = R[key];
    if (b.getAttribute('data-t2r') === 'clear') { R[key] = null; T.render(); return; }
    // retry = the first tap on the page's own button (arms it). Nothing is sent until the user taps that button again.
    var btn = btnFor(key, rec); if (btn && !btn.disabled && !btn.classList.contains('armed')) { btn.click(); try { btn.focus(); } catch (e) { /* focus is a convenience */ } }
  }
  function step(d, c, vis) {
    var any = R.pause || R.resume || R.cancel || R.flatten; if (!any && vis && !vis.control) return;   // nothing sent and the tab is hidden: nothing to do
    var now = c.rec ? Date.now() : c.now, rc = null; try { rc = typeof cancelReceipt !== 'undefined' ? cancelReceipt : null; } catch (e) { rc = null; }
    var ms = {};
    ['pause', 'resume', 'cancel', 'flatten'].forEach(function (k) { var rec = R[k]; if (!rec) return; var m = receiptModel(rec, d, now, k === 'cancel' ? rc : null);
      // a fill is a fact: kept. APPLIED is kept only after later snapshots have agreed for 45 s (then a later change, the pause ending, does not rewrite it)
      if (reqsOf(d)) rec.sawReqs = true;
      if (m.ack && m.ack !== 'PENDING' && !rec.ack) { var a0 = ackFor(rec, d, k === 'cancel' ? rc : null); if (a0) rec.ack = { id: a0.id, type: a0.type, requestedAt: a0.requestedAt, receivedAt: a0.receivedAt, at: a0.at, result: a0.result, reason: a0.reason }; }   // a final answer is kept (the bot lists only its last 10)
      if (m.ack) { ms[k] = m; return; }
      if (m.state === 'FILLED' && rec.st !== 'FILLED') { rec.st = 'FILLED'; rec.filledLine = m.line; rec.filledNote = m.note; rec.filledAt = m.appliedAt; }
      if (m.state === 'APPLIED' && rec.st !== 'APPLIED') { if (rec.okSince == null) rec.okSince = now; if (now - rec.okSince >= HOLD_MS) { rec.st = 'APPLIED'; rec.appliedLine = m.line; rec.appliedAt = m.appliedAt; } }
      else if (rec.st !== 'APPLIED') rec.okSince = null;
      // no answer: the alert's text (a live region) changes at most once per 15 s, not every second
      if (m.state === 'FAILED' && rec.st === 'SENDING') { if (rec.naAt == null || now - rec.naAt >= NA_STEP_MS || now < rec.naAt) { rec.naAt = now; rec.naLine = m.line; } m.line = rec.naLine; }
      ms[k] = m; });
    T.put(E.pause, receiptHtml(ms.pause || ms.resume || null, true)); T.put(E.cancel, receiptHtml(ms.cancel || null, true)); T.put(E.flatten, receiptHtml(ms.flatten || null, true));
    if (E.flattenPos) T.put(E.flattenPos, receiptHtml(ms.flatten || null, false));
    // the page's own hints: the restart hint only when it is true; "sent" wording gives way to the receipt
    var h = document.getElementById('ctl-hint');
    if (h && !h.classList.contains('armed')) { var tx = h.textContent, idle = h.dataset.idle || '';
      if (/^Pause needs the bot restart/.test(tx) && d && d.available !== false && 'pause' in d && !last404) h.textContent = idle;
      else if (/^(Pause|Resume) sent:/.test(tx) && (ms.pause || ms.resume)) h.textContent = idle; }
  }
  T.models.receipt = receiptModel; T.models.ackFor = ackFor; T.models.effect = effect; T.models.receiptBase = baseOf; T.receipts = R;
  function start() { if (!mount()) return; T.EXTRA.push(step); T.render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
