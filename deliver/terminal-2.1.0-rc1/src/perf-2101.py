#!/usr/bin/env python3
# Stage 2.1 perf edit of v2src/t210.js (the 1 s tick and the age-line patch), applied as text so it can go on top of any later t210.js
# (stage 2, or stage 2 + fix-qa/t210.patch). Usage: python3 -I perf-2101.py <t210.js in> <t210.js out>. Fails if an anchor is missing.
import re, sys
s = open(sys.argv[1]).read()
def R(a, b):
    global s
    assert s.count(a) == 1, 'anchor: ' + a[:90]
    s = s.replace(a, b)

R("""    if (i > 0 && typeof old === 'string' && old.lastIndexOf('<div class="t2-age"') === i && old.slice(0, i) === html.slice(0, i)) { var a = el.lastElementChild; if (a && a.className === 't2-age') { a.outerHTML = html.slice(i); el.__t2 = html; return true; } }""",
"""    if (i > 0 && typeof old === 'string' && old.lastIndexOf('<div class="t2-age"') === i && old.slice(0, i) === html.slice(0, i)) { var a = el.lastElementChild; if (a && a.className === 't2-age') {
      // 2.1 stage 2.1: the age line is one text node: when its tag is the same and it holds plain text, only that text node is written (no parse, no layout read)
      var nw = html.slice(i), ow = old.slice(i), g = nw.indexOf('>') + 1, body = nw.slice(g, nw.length - 6);
      if (g > 0 && nw.slice(0, g) === ow.slice(0, g) && nw.slice(-6) === '</div>' && body.indexOf('<') < 0 && body.indexOf('&') < 0 && a.childNodes.length === 1 && a.firstChild.nodeType === 3) a.firstChild.nodeValue = body;
      else a.outerHTML = nw;
      el.__t2 = html; return true; } }""")

# the stamp line in render(): stage 2 calls stampsModel(readStamp(), c); fix-qa adds a third argument (Date.now())
m = re.search(r"    try \{ put\(E\.stamp, stampsHtml\(stampsModel\(readStamp\(\), c(, Date\.now\(\))?\), c\)\); \} catch \(e\) \{ put\(E\.stamp, unk\('stamp view failed'\)\); \}", s)
assert m, 'anchor: stamp line in render()'
args = 'readStamp(), c' + (m.group(1) or '')
s = s[:m.start()] + ("    LAST.d = d; LAST.j = journalRef();\n    try { var sm = stampsModel(" + args + "); LAST.stampSt = sm.st; put(E.stamp, stampsHtml(sm, c)); } catch (e) { LAST.stampSt = null; put(E.stamp, unk('stamp view failed')); }") + s[m.end():]

R("  function start() { if (!mount()) return; render(); setInterval(render, 1000); document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); }); }",
"""  /* ── the 1 s tick (stage 2.1) ──
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
    var c = clock(snap(), Date.now()), m = stampsModel(""" + args + """); if (m.st !== LAST.stampSt) return false;
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
  function start() { if (!mount()) return; render(); setInterval(tick, 1000); document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); }); document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); }); }""")
open(sys.argv[2], 'w').write(s)
print('perf-2101: applied (stamp args: ' + args + ')')
