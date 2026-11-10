/* MacUI-T terminal 2.1.0 stage 2: the HTF cascade (4H -> 1H -> 30m -> 15m -> control), the signature element.
   The view is a pure function of (snapshot, now): a finite-state render where every node is one of WITH, AGAINST, FLAT, UNKNOWN and the flow
   state is the longest agreeing prefix. The first node that is not WITH breaks the flow and names itself as the blocker.
   Sources: current.lv.alignSlots[] (the gate's period-open slots: the bot reads price against each timeframe's open) and controlDisplay (the
   control score against its threshold). A timeframe the gate does not read on this build (no slot in the snapshot) is drawn as a bypass: it never
   lights and never blocks. Motion is transform and opacity only. */
(function () {
  'use strict';
  var T = window.T210; if (!T) return;
  var fin = function (v) { return typeof v === 'number' && isFinite(v); }, esc = T.esc;
  var TFS = [['H4', '4H'], ['H1', '1H'], ['M30', '30m'], ['M15', '15m']], TFN = { M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m', H1: '1H', H4: '4H' };
  var px = function (v) { return Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  // one node: { id, label, state, dir (1 / -1 / 0 / null), value, why, age, skip }
  function slotNode(slot, tf, label, c, sst, evalT) {
    var n = { id: tf, label: label, state: 'UNKNOWN', dir: null, value: null, why: null, age: fin(evalT) ? c.now - evalT : null, skip: false };
    if (!slot) { n.skip = true; n.why = 'not read by this build’s gate'; return n; }
    var st = T.worst(sst, T.fresh(evalT, T.LIMIT.gate, c.now));
    if (st !== 'LIVE') { n.why = st === 'UNKNOWN' ? 'no evaluation time' : T.ageText(n.age) + ' old'; return n; }
    if (slot.status !== 'CURRENT') { n.why = String((Array.isArray(slot.reasonCodes) && slot.reasonCodes[0]) || slot.status || 'not current').toLowerCase().replace(/_/g, ' '); return n; }
    if (!fin(slot.open) || !fin(slot.price)) { n.why = 'open or price not sent'; return n; }
    n.dir = slot.price > slot.open ? 1 : slot.price < slot.open ? -1 : 0;
    if (slot.flag === true && n.dir !== 1 || slot.flag === false && n.dir === 1) { n.dir = null; n.why = 'the slot’s flag and its prices disagree'; return n; }
    n.value = 'price ' + px(slot.price) + (n.dir === 1 ? ' above' : n.dir === -1 ? ' below' : ' at') + ' open ' + px(slot.open); n.state = 'READ';
    return n;
  }
  function controlNode(cd, c, sst) {
    var tf = cd && typeof cd.timeframe === 'string' ? cd.timeframe : null, n = { id: 'control', label: 'control' + (tf ? ' (' + (TFN[tf] || tf) + ')' : ''), state: 'UNKNOWN', dir: null, value: null, why: null, age: cd && fin(cd.evaluatedAt) ? c.now - cd.evaluatedAt : null, skip: false };
    if (!cd || typeof cd !== 'object') { n.why = 'controlDisplay not sent'; return n; }
    var st = T.worst(sst, T.fresh(cd.evaluatedAt, T.LIMIT.gate, c.now));
    if (st !== 'LIVE') { n.why = st === 'UNKNOWN' ? 'no evaluation time' : T.ageText(n.age) + ' old'; return n; }
    if (cd.valid !== true || !fin(cd.score) || !fin(cd.threshold)) { n.why = 'no valid control read'; return n; }
    n.dir = Math.abs(cd.score) >= cd.threshold ? (cd.score > 0 ? 1 : -1) : 0;
    n.value = 'score ' + (cd.score > 0 ? '+' : cd.score < 0 ? '−' : '') + Math.abs(cd.score).toFixed(3) + (n.dir === 0 ? ' inside' : ' beyond') + ' ±' + cd.threshold.toFixed(2); n.state = 'READ';
    return n;
  }
  function cascadeModel(d, c) {
    var sst = T.snapState(d, c), cur = d && d.current, slots = cur && cur.lv && Array.isArray(cur.lv.alignSlots) ? cur.lv.alignSlots : null, evalT = cur && fin(cur.t) ? cur.t : null;
    var m = { st: sst, nodes: [], flow: 0, blocker: null, ref: null, refSrc: null, age: d && fin(d.updated) ? c.now - d.updated : null, at: d && fin(d.updated) ? d.updated : null };
    if (sst === 'UNKNOWN') { m.why = !d || d.available === false ? 'no snapshot' : 'snapshot has no time'; return m; }
    if (!slots && !(d.controlDisplay && typeof d.controlDisplay === 'object')) { m.st = 'UNKNOWN'; m.why = 'alignSlots and controlDisplay not sent'; return m; }
    var by = {}; (slots || []).forEach(function (s) { if (s && typeof s.timeframe === 'string') by[s.timeframe] = s; });
    TFS.forEach(function (x) { var s = by[x[0]]; m.nodes.push(slots || x[0] === 'M30' ? slotNode(s || (slots && x[0] !== 'M30' ? { status: 'MISSING' } : null), x[0], x[1], c, sst, evalT) : { id: x[0], label: x[1], state: 'UNKNOWN', dir: null, value: null, why: 'alignSlots not sent', age: null, skip: false }); });
    m.nodes.push(controlNode(d.controlDisplay, c, sst));
    // the reference direction: the bot's candidate direction when the checklist carries one, else the top timeframe's own
    var cl = cur && cur.checklist, cand = cl && (cl.direction === 1 || cl.direction === -1) ? cl.direction : null, chain = m.nodes.filter(function (n) { return !n.skip; });
    if (cand != null) { m.ref = cand; m.refSrc = 'candidate'; } else if (chain.length && chain[0].state === 'READ' && chain[0].dir) { m.ref = chain[0].dir; m.refSrc = chain[0].label; }
    var open = true;
    chain.forEach(function (n) {
      if (n.state === 'READ') n.state = n.dir === 0 ? 'FLAT' : m.ref == null ? 'UNKNOWN' : n.dir === m.ref ? 'WITH' : 'AGAINST';
      if (n.state === 'UNKNOWN' && !n.why) n.why = 'no direction to compare with';
      if (n.state === 'UNKNOWN') { n.dir = null; n.value = null; }   // a node that is not current never shows a direction or a value
      n.lit = open && n.state === 'WITH'; if (n.lit) m.flow++;
      else if (open) { open = false; m.blocker = n.label + (n.state === 'AGAINST' ? ' against' : n.state === 'FLAT' ? ' flat' : ' UNKNOWN: ' + n.why); m.blockId = n.id; }
    });
    m.total = chain.length; m.aligned = open && chain.length > 0;
    return m;
  }
  var ARW = { '1': '▲ up', '-1': '▼ down', '0': 'flat' };
  function cascadeHtml(m, c) {
    var head = '<div class="t2-head"><span class="t2-title">HTF cascade</span>' + T.chip(m.st, c, m.age) + '</div>';
    if (m.st === 'UNKNOWN') return head + '<div class="t2-big">' + T.unk(m.why) + '</div>' + T.ageLine(m.st, c, m.at, m.age);
    var dirW = m.ref === 1 ? 'LONG' : m.ref === -1 ? 'SHORT' : null;
    var sum = m.aligned ? '<b class="t2c-ok">Flow complete</b> ' + m.flow + ' of ' + m.total + ' agree ' + (m.ref === 1 ? 'up' : 'down') : '<b class="t2c-stop">Flow stops</b> <span data-k="blocker">' + esc(m.blocker || 'UNKNOWN') + '</span>';
    var h = head + '<div class="t2c-sum" data-k="flow" data-aligned="' + (m.aligned ? 1 : 0) + '">' + sum + '</div><div class="t2c-ref">' + (dirW ? 'compared with the ' + (m.refSrc === 'candidate' ? 'bot’s ' + dirW + ' candidate' : m.refSrc + '’s own direction (no candidate yet)') : 'no direction to compare with') + '</div>';
    h += '<ol class="t2c" data-dir="' + (m.ref === 1 ? 'up' : m.ref === -1 ? 'down' : 'none') + '" data-flow="' + m.flow + '">';
    // a link hangs under each node down to the next one; it is lit when the nearest gate node above and the nearest gate node below are both lit
    var N = m.nodes, up = [], down = [], k, carry = false, chainI = 0;
    for (k = 0; k < N.length; k++) { if (!N[k].skip) carry = !!N[k].lit; up[k] = carry; }
    carry = false; for (k = N.length - 1; k >= 0; k--) { down[k] = carry; if (!N[k].skip) carry = !!N[k].lit; }
    N.forEach(function (n, i) {
      var block = m.blockId === n.id && !n.skip, word = n.skip ? 'NOT READ' : n.state, link = i < N.length - 1 ? '<i class="t2c-link" data-lit="' + (up[i] && down[i] ? 1 : 0) + '" aria-hidden="true"><b style="animation-delay:' + (chainI * 200) + 'ms"></b></i>' : '';
      h += '<li class="t2c-n" data-id="' + n.id + '" data-state="' + (n.skip ? 'SKIP' : n.state) + '" data-lit="' + (n.lit ? 1 : 0) + '"' + (block ? ' data-block="1"' : '') + (n.dir != null && !n.skip ? ' data-ndir="' + n.dir + '"' : '') + '>' + link
        + '<span class="t2c-dot" aria-hidden="true"></span><span class="t2c-b"><span class="t2c-l">' + esc(n.label) + '</span>'
        + '<span class="t2c-s" data-k="state">' + word + (n.dir != null && !n.skip ? ' <span class="t2c-d" data-k="dir">' + ARW[String(n.dir)] + '</span>' : '') + (block ? ' <span class="t2c-blk">blocker</span>' : '') + '</span>'
        + '<span class="t2c-v" data-k="value">' + (n.skip ? esc(n.why) : n.state === 'UNKNOWN' ? T.unk(n.why) : T.txt(n.value, 'LIVE', '')) + '</span>'
        + (n.skip || !fin(n.age) ? '' : '<span class="t2c-a" data-k="nage">read ' + esc(T.ageText(n.age)) + ' ago</span>') + '</span></li>';
      chainI++;
    });
    h += '</ol><div class="t2-sub">Each node is what the bot’s gate reads: price against that timeframe’s open, then the control score. The line lights only through nodes that agree, top down.</div>';
    return h + T.ageLine(m.st, c, m.at, m.age);
  }
  var el = null;
  // the lit flow runs for 2 cycles (2 x 1.4 s) after the flow changes or the card comes on screen, then stops; off screen it never runs.
  // data-flow on the card (outside the markup the 1 s render replaces) gates the CSS animation.
  var FLOW_MS = 2800, FL = { sig: null, on: true, timer: null };
  function flowRun() { if (FL.timer) clearTimeout(FL.timer); FL.timer = null; if (!el) return; if (!FL.on) { el.dataset.flow = '0'; return; } el.dataset.flow = '1'; FL.timer = setTimeout(function () { FL.timer = null; if (el) el.dataset.flow = '0'; }, FLOW_MS); }
  function flowSig(m) { var s = m.st + '|' + m.ref + '|' + m.flow + '|' + (m.aligned ? 1 : 0); if (s !== FL.sig) { FL.sig = s; flowRun(); } }
  function mount() {
    var v = document.getElementById('t2-verdict'); if (!v || !v.parentNode) return false;
    el = T.mk('section', 't2-cascade', 'card t2-card t2-cascade'); el.setAttribute('aria-label', 'HTF cascade'); el.dataset.flow = '0'; v.parentNode.insertBefore(el, v.nextSibling);
    try { if (typeof IntersectionObserver === 'function') new IntersectionObserver(function (es) { var on = es[es.length - 1].isIntersecting; if (on !== FL.on) { FL.on = on; flowRun(); } }).observe(el); } catch (e) { /* no observer: it still stops after 2 cycles */ }
    return true;
  }
  T.models.cascade = cascadeModel; T.cascadeHtml = cascadeHtml;
  function start() { if (!mount()) return; T.EXTRA.push(function (d, c, vis) { if (vis && !vis.now) return; var m = { st: 'UNKNOWN', why: 'cascade view failed', nodes: [] }; try { m = cascadeModel(d, c); T.put(el, cascadeHtml(m, c)); } catch (e) { T.put(el, T.unk('cascade view failed')); } el.dataset.state = m.st; el.dataset.aligned = m.aligned ? '1' : '0'; flowSig(m); }); T.render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
