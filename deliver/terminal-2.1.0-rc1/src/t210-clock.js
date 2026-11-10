/* MacUI-T terminal 2.1 stage 2.1: every clock a user reads is PT, 12-hour (Mac, 11/10: "all times seen in the terminal are PT based on 12HR times").
   Stage 2.1: the page's own clock formatters now write 12-hour where the text is produced (build-2101.cjs, clock-sources-2101.cjs: Levels, Position,
   Review, Signal path, Checklist path, Robot Brain, MacCharts readout and axis, the reel). What is left for this module is text the page does not
   format itself: the bot's own words ("12:55-15:00 PT", "flat by 13:05", the level name "06:30 Open"), which are PT wall-clock times written 24-hour.
   It rewrites how they are written, never the data. Cost (stage 2 failed the 4x replay gate with a whole-subtree walk on every mutation):
   - a MutationObserver that only queues the changed nodes; one pass per animation frame (before paint), not per mutation;
   - a node is checked once per text value (its last checked text is remembered on the node) and a subtree is walked only when its text
     contains a 24-hour clock at all (one native textContent read and one regex);
   - nodes removed before the frame are skipped.
   Not converted, on purpose: countdowns written mm:ss (the pause countdown, "09:59 left", "in 09:59"), anything followed by AM / PM already, the reel's
   own subtree (its timers are mm:ss; its clocks are 12-hour at the source). */
(function () {
  'use strict';
  var RE = /(^|[^\d:.])((?:[01]\d|2[0-3])):([0-5]\d)(:[0-5]\d)?(?![\d:])(?!\s*[AP]M\b)(?!\s*(?:left|remaining|\/))/g;
  var ANY = /(?:^|[^\d:.])(?:[01]\d|2[0-3]):[0-5]\d(?![\d:])(?!\s*[AP]M\b)/;   // cheap pre-test: is there a 24-hour clock in this text at all
  var LOOSE = /(?:[01]\d|2[0-3]):[0-5]\d/;   // the subtree pre-test: textContent joins adjacent nodes with no separator ("29,561.50" + "06:30 Open"), so no boundary test there
  var SKIP = '#ctl-big, .ctl-big, #ctl-paused-mmss, script, style, textarea, input, select, [contenteditable], [class*="reel"], [id*="reel"], [data-noclock]';
  function conv(s, after) {
    return s.replace(RE, function (m, pre, h, mi, sec, off) {
      if (/(?:\b(?:in|for)|\/)\s*$/.test(s.slice(0, off + pre.length))) return m;                       // "in 09:59": a countdown
      if (off + m.length === s.length && /^\s*(?:[AP]M\b|left|remaining|\/)/.test(after)) return m;   // AM / PM (or "left") sits in the next node
      h = Number(h); return pre + (h % 12 === 0 ? 12 : h % 12) + ':' + mi + (sec || '') + (h < 12 ? ' AM' : ' PM');
    });
  }
  var SEEN = '__t12';   // the text this node had when it was last checked (or written by us)
  var SKIPPED = '__t12skip';   // on an element: true / false, whether it sits in a skipped subtree (the reel's per-frame numbers: decided once, not per frame)
  function skipped(p) { var v = p[SKIPPED]; if (v === undefined) v = p[SKIPPED] = !!p.closest(SKIP); return v; }
  function fix(n) {
    var d = n.data; if (n[SEEN] === d) return; n[SEEN] = d;
    if (!d || d.length < 5 || !ANY.test(d)) return;
    var p = n.parentElement; if (!p || skipped(p)) return;
    var nx = n.nextSibling, c = conv(d, nx ? String(nx.textContent || '').slice(0, 12) : ''); if (c !== d) { n[SEEN] = c; n.data = c; }
  }
  function walk(root) {
    if (root.nodeType === 3) { fix(root); return; }
    if (root.nodeType !== 1 || !LOOSE.test(root.textContent) || root.closest(SKIP)) return;   // nothing to convert under it, or a skipped subtree
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n; while ((n = w.nextNode())) fix(n);
  }
  var Q = [], queued = false;
  function flush() { queued = false; var q = Q; Q = []; for (var i = 0; i < q.length; i++) { var n = q[i]; if (n.isConnected) walk(n); } }
  function add(n) { Q.push(n); if (!queued) { queued = true; requestAnimationFrame(flush); } }
  function start() {
    walk(document.body);
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) { var m = ms[i];
        if (m.type === 'characterData') { var t = m.target, pe = t.parentElement; if (t[SEEN] !== t.data && !(pe && pe[SKIPPED] === true)) add(t); }   // a text node known to be in a skipped subtree queues nothing
        else for (var k = 0; k < m.addedNodes.length; k++) add(m.addedNodes[k]); }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    // a hidden page runs no animation frames: what queued while hidden is converted on the first frame back, before it is painted
  }
  if (window.T210) { window.T210.clock12 = conv; window.T210.clockFlush = flush; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
