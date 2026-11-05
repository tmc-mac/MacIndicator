/* MacUI 2.0.9.22: v2src/feat-20920-r22.js = feat-20920-r21.js + QC-UI 1 (Day P&L header during a TIDE trade), 3 (tape detail: zone + gate text for refusals, r1.5.5
   REFUSED cancels as ⊘), 4 (Now under TIDE live: the old checklist card and the old flat reasons fold under "Old levels model (not trading)").
/* MacUI 2.0.9.21: v2src/feat-20920-r21.js (MacUI-N3, Nov 4) = feat-20920.js + the Levels plan-line fix (Mac's 08:34 PT screen: the old path's LONG event
   drawn under TIDE while TIDE's only setup was a SHORT). 2.0.9.20: v2src/feat-20920.js (MacUI-N, Nov 4). TIDE TAPE (Mac: replace the Hour wave history strip "with something more useful for our
   trading bot UI"; sketch approved by MacArthur). In the Hour card's strip slot while tide is shadow / live (the old strip hidden, never removed;
   with tide off / absent nothing here touches the page). ONE SVG, one time -> x scale over the previous + the current 4H period (8 h on the
   03 / 07 / 11 / 15 / 19 / 23 PT grid):
     control lane  tide.board.control (dir, kind, since) to now; trap = solid, bias = striped; none = grey; no board = the journal's control_form,
                   its end labelled "needs bot r1.3";
     no-entry      the bot's TIDE blocks (tide.rules.blocks when useTimeBlocks), the open wait (openWaitMin after 15:00 / 00:00 / 06:30 and each 4H
                   open), the session close (no entry from 12:55, flat 13:05: snapshot.session), each with its blockedBy code word;
     events        tide rows (the TradeDay union): setup_arm, retest #n, rejection, signal (grade colour; a rebuilt row = replay), cancel / expire, no-trade;
     trades        TIDE trades + the open position: entry -> exit bars by result; $ on the last two only;
     unknown       the span before the first row the phone holds is hatched "not in snapshot".
   Tap a tick: one aria-live line (time, level, price, why). Render <= 4 ms; the now marker is a transform; no animation but a fade (none under
   reduced motion). */
(function () {
  'use strict';
  const U = window.macui || (window.macui = {}), T18 = U.feat20918; if (!T18 || typeof T18.model !== 'function') return;
  // MacArthur 11/04 (reel 4x cost): T18.model memoized per snapshot object (a WeakMap keyed on d; reused within one task, i.e. one poll's render, and
  // while the clock moved < 1 s), so each poll computes it once whichever module asks first (feat-20919, this file). TIDE off: every wrapper here bails before it.
  if (!T18.model.__memo20) { const raw = T18.model, MEMO = new WeakMap(), memo = { hits: 0, miss: 0 };
    // reused only when the snapshot's TIDE inputs read the same (a cheap signature: updated, mode, board / rows / trades identity + length, the position's fields),
    // so a snapshot changed in place is read afresh; no tide object = the raw call (it returns at once).
    const sigOf = d => { const T = d.tide, P = T.position; return [d.updated, T.mode, T.board, T.rows, T.rows && T.rows.length, T.trades, T.trades && T.trades.length, T.alerts, P && typeof P === 'object' ? JSON.stringify(P) : P]; };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const m = function (d, now) { if (!d || typeof d !== 'object' || !d.tide || typeof d.tide !== 'object') return raw.apply(this, arguments); const c = MEMO.get(d), t = typeof now === 'number' ? now : Date.now(), sg = sigOf(d);
      if (c && Math.abs(t - c.t) < 1000 && same(c.sg, sg)) { memo.hits++; return c.M; } memo.miss++; const M = raw.call(this, d, t); MEMO.set(d, { t, M, sg }); Promise.resolve().then(() => MEMO.delete(d)); return M; };   // lives to the end of this task (one poll's render), never across tasks: a snapshot changed in place later is read afresh
    m.__memo20 = memo; m.raw = raw; T18.model = m; }
  // TIDE off = no snapshot tide object, or its mode reads off (feat-20918's own rule; a config-only mode is 'partial', which nothing here draws): no model work at all.
  const modeKey = d => typeof T18.modeInfo === 'function' ? T18.modeInfo(d.tide.mode).key : String(d.tide.mode == null ? '' : d.tide.mode).toLowerCase();
  const tideless = d => !d || typeof d !== 'object' || !d.tide || typeof d.tide !== 'object' || modeKey(d) === 'off';
  const fin = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = v => fin(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN';
  const F = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const hm = t => F.format(new Date(t)).slice(0, 5);
  const PTF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ptSec = t => { const o = {}; for (const x of PTF.formatToParts(new Date(t))) o[x.type] = x.value; return (+o.hour % 24) * 3600 + +o.minute * 60 + +o.second; };
  const snapNow = () => { try { return (typeof lastSnapForPoll !== 'undefined' && lastSnapForPoll) || (typeof pcSnap !== 'undefined' && pcSnap) || null; } catch (e) { return null; } };
  const W = 360, H = 168, X0 = 6, X1 = W - 6, GRID = [180, 420, 660, 900, 1140, 1380];
  const hh = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? +m[1] * 60 + +m[2] : null; };
  // PT minute-of-day intervals -> ms intervals clipped to [a, b]
  function spans(now, list, a, b) { const mid = now - ptSec(now) * 1000, out = [];
    for (const [f, t, code, word] of list) for (let k = -1; k <= 1; k++) { let s = mid + k * 86400000 + f * 60000, e = mid + k * 86400000 + t * 60000; if (t <= f) e += 86400000; if (e > a && s < b) out.push({ s: Math.max(a, s), e: Math.min(b, e), code, word }); }
    return out; }
  function model(d, now) {
    const M = T18.model(d, now); if (!M || M.partial || M.off) return null;
    const T = d.tide || {}, mn = Math.floor(ptSec(now) / 60), since = Math.min(...GRID.map(o => (mn - o + 1440) % 1440)), open4 = now - (since * 60 + ptSec(now) % 60) * 1000;
    const a = open4 - 4 * 3600000, b = open4 + 4 * 3600000, x = t => X0 + (Math.max(a, Math.min(b, t)) - a) / (b - a) * (X1 - X0);
    const R = { M, a, b, x, now, open4, next4: open4 + 4 * 3600000 };
    // control lane
    const B = T.board && typeof T.board === 'object' ? T.board : null, c = B && B.control && typeof B.control === 'object' ? B.control : null;
    R.ctl = c ? { dir: c.dir, kind: c.kind || null, from: fin(c.since) ? c.since : open4, src: 'tide.board.control', sinceKnown: fin(c.since) } : !B && M.ctl ? { dir: M.ctl.dir, kind: M.ctl.kind, from: M.ctl.t, src: 'journal control_form', needs: true } : null;
    // no-entry shading (the bot's own windows)
    const rules = T.rules || {}, ow = fin(rules.openWaitMin) ? rules.openWaitMin : 30, list = [];
    if (rules.useTimeBlocks === true) for (const w of (Array.isArray(rules.blocks) ? rules.blocks : [])) { const f = hh(w && w[0]), t = hh(w && w[1]); if (f != null && t != null) list.push([f, t, 'TIME_BLOCK', 'time block']); }
    for (const o of [900, 0, 390].concat(GRID)) list.push([o, o + ow, 'OPEN_WAIT', 'open wait']);
    const se = d.session, ne = se && hh(se.noEntryPt), fl = se && hh(se.flattenPt);
    if (ne != null) list.push([ne, 900, 'SESSION_CLOSE', 'no entry · flat ' + (se.flattenPt || '?')]);
    R.shade = spans(now, list, a, b);
    // rows (the TradeDay union) and trades
    const rows = U.feat20918.rowsMemo && U.feat20918.rowsMemo.map ? [...U.feat20918.rowsMemo.map.values()] : Array.isArray(T.rows) ? T.rows : [];
    const G = { setup_arm: '◇', retest: '↺', rejection: '⟂', signal: '●', setup_cancel: '×', setup_expire: '×', grade_no_trade: '○' };
    R.ticks = rows.filter(r => r && fin(r.t) && G[r.phase] && r.t >= a && r.t <= b).map(r => ({ r, g: (r.phase === 'setup_cancel' && /^REFUSED/i.test(String(r.why || '')) ? '⊘' : G[r.phase]) + (r.phase === 'retest' && r.n ? r.n : ''), t: r.phase === 'signal' && fin(r.at) ? r.at : r.t }));
    { const PRI = { signal: 6, rejection: 5, retest: 4, grade_no_trade: 3, setup_arm: 2, setup_cancel: 1, setup_expire: 1 }; R.groups = [];
      for (const k of R.ticks.slice().sort((p, q) => p.t - q.t)) { const G = R.groups[R.groups.length - 1];
        if (G && x(k.t) - x(G.t) < 12) { G.ks.push(k); if ((PRI[k.r.phase] || 0) >= (PRI[G.lead.r.phase] || 0)) G.lead = k; } else R.groups.push({ t: k.t, ks: [k], lead: k }); } }
    R.first = rows.length ? Math.min(...rows.filter(r => fin(r.t)).map(r => r.t)) : null;
    R.trades = (M.trades || []).filter(t => fin(t.openedAt)).map(t => ({ s: t.openedAt, e: t.open ? now : fin(t.closedAt) ? t.closedAt : now, r: t.resultR, usd: t.usd, open: t.open }));
    if (M.position && fin(M.position.fillAt)) R.trades.push({ s: M.position.fillAt, e: now, r: null, usd: fin(M.position.openUsd) ? M.position.openUsd : null, open: true });
    R.trades = R.trades.filter(t => t.e >= a && t.s <= b);
    // caption: next 4H open · open wait end · next block
    const inWait = R.shade.find(s => s.code === 'OPEN_WAIT' && s.s <= now && s.e > now), nb = R.shade.filter(s => s.code === 'TIME_BLOCK' && s.s > now).sort((p, q) => p.s - q.s)[0];
    const left = Math.max(0, Math.round((R.next4 - now) / 1000)), mm = `${Math.floor(left / 3600)}:${String(Math.floor(left / 60) % 60).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    R.caption = `next 4H open in ${mm}${inWait ? ' · open wait ends ' + hm(inWait.e) : ''}${nb ? ' · next block ' + hm(nb.s) : rules.useTimeBlocks === true ? '' : ' · time blocks off'}`;
    return R;
  }
  function svg(R) {
    const x = R.x, f = v => v.toFixed(1), L = { ctl: 18, sh: 38, ev: 66, tr: 104, ax: 140 };
    let o = `<svg class="fx20-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="TIDE tape: 4H control, no-entry windows, TIDE events and trades over the last 8 hours">`
      + `<defs><pattern id="fx20-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="fx20-hl"/></pattern><pattern id="fx20-b" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="4" height="8" class="fx20-bs"/></pattern></defs>`;
    // unknown before the first row
    if (fin(R.first) && R.first > R.a) o += `<rect class="fx20-unk" x="${f(x(R.a))}" y="8" width="${f(x(R.first) - x(R.a))}" height="${L.ax - 8}"/><text class="fx20-ut" x="${f(x(R.a) + 3)}" y="${L.ax - 4}">not in snapshot</text>`;
    // grid at the 4H opens
    for (const t of [R.a, R.open4, R.b]) o += `<line class="fx20-g" x1="${f(x(t))}" x2="${f(x(t))}" y1="8" y2="${L.ax}"/><text class="fx20-gt" x="${f(x(t))}" y="${H - 18}" text-anchor="${t === R.a ? 'start' : t === R.b ? 'end' : 'middle'}">${hm(t)}</text>`;
    // control lane
    o += `<rect class="fx20-cn" x="${X0}" y="${L.ctl - 7}" width="${X1 - X0}" height="14" rx="3"/>`;
    if (R.ctl) { const s = Math.max(R.a, R.ctl.from), trap = /trap|fail/.test(String(R.ctl.kind || ''));
      o += `<rect class="fx20-c" data-dir="${R.ctl.dir}" data-k="${trap ? 'trap' : 'bias'}" x="${f(x(s))}" y="${L.ctl - 7}" width="${f(x(R.now) - x(s))}" height="14" rx="3"/>`
        + `<text class="fx20-ct" x="${f(x(s) + 4)}" y="${L.ctl + 4}">${R.ctl.dir === -1 ? '▼ SELLERS' : R.ctl.dir === 1 ? '▲ BUYERS' : '?'} · ${trap ? 'trap' : 'bias'}${R.ctl.needs ? ' · needs bot r1.3' : ''}</text>`; }
    else o += `<text class="fx20-ct is-none" x="${X0 + 4}" y="${L.ctl + 4}">4H control: none</text>`;
    // shading with code words (labels packed: a label that would overlap the previous one is dropped to the tap detail)
    let lastEnd = -1;
    for (const s of R.shade.sort((p, q) => p.s - q.s)) { const x0 = x(s.s), w = Math.max(1, x(s.e) - x0);
      o += `<rect class="fx20-s" data-code="${s.code}" x="${f(x0)}" y="${L.sh - 8}" width="${f(w)}" height="16"><title>${esc(s.word + ' ' + hm(s.s) + '–' + hm(s.e) + ' PT')}</title></rect>`;
      if (w > 34 && x0 > lastEnd) { o += `<text class="fx20-st" x="${f(x0 + 2)}" y="${L.sh + 4}">${esc(s.word)}</text>`; lastEnd = x0 + Math.min(w, 70); } }
    // events: ticks closer than 12 px are one cluster (the most telling glyph + "×n"; the tap lists them all); 2 sub-rows by interval packing;
    // invisible 44 px hit rects
    const rowEnd = [-1, -1]; let hits = '';
    R.groups.forEach((G, i) => { const k = G.lead, xx = x(G.t), sub = rowEnd[0] <= xx - 24 ? 0 : rowEnd[1] <= xx - 24 ? 1 : 0; rowEnd[sub] = xx; const y = L.ev + sub * 16;
      const g = k.r.phase === 'signal' ? ((k.r.plan && k.r.plan.grade) || '') : '';
      o += `<text class="fx20-e" data-ph="${k.r.phase}" data-g="${g === 'A+' ? 'a' : g === 'B' ? 'b' : g === 'C' ? 'c' : ''}" data-rb="${k.r.rebuilt === true ? 1 : 0}" x="${f(xx)}" y="${y}" text-anchor="middle">${esc(k.g)}${G.ks.length > 1 ? `<tspan class="fx20-n">×${G.ks.length}</tspan>` : ''}</text>`;
      hits += `<rect class="fx20-hit" data-i="${i}" x="${f(xx - 22)}" y="${y - 30}" width="44" height="44" tabindex="0" role="button" aria-label="${esc(gDetail(G))}"/>`; });
    // trades
    const tr = R.trades.sort((p, q) => p.s - q.s), lastTwo = tr.slice(-2);
    for (const t of tr) { const x0 = x(t.s), w = Math.max(3, x(t.e) - x0), s = fin(t.r) ? Math.sign(t.r) : fin(t.usd) ? Math.sign(t.usd) : 0;
      o += `<rect class="fx20-t" data-s="${s}" data-open="${t.open ? 1 : 0}" x="${f(x0)}" y="${L.tr - 6}" width="${f(w)}" height="12" rx="2"/>`;
      if (lastTwo.includes(t) && fin(t.usd)) o += `<text class="fx20-tt" x="${f(x0 + w + 3)}" y="${L.tr + 4}">${t.usd > 0 ? '+' : t.usd < 0 ? '−' : ''}$${Math.abs(t.usd).toFixed(0)}</text>`; }
    // now marker (a transform)
    o += `<g class="fx20-now" transform="translate(${f(x(R.now))} 0)"><line x1="0" x2="0" y1="6" y2="${L.ax}"/><text x="0" y="${H - 4}" text-anchor="middle">now</text></g>`;
    o += `<line class="fx20-ax" x1="${X0}" x2="${X1}" y1="${L.ax}" y2="${L.ax}"/>` + hits + '</svg>';
    return o;
  }
  function gDetail(G) { const d = G.ks.map(detail); return G.ks.length > 1 ? `${G.ks.length} events: ` + d.slice(0, 4).join(' | ') + (d.length > 4 ? ` | +${d.length - 4} more` : '') : d[0]; }
  function detail(k) { const r = k.r, p = r.plan || {};
    const what = { setup_arm: 'armed', retest: 'retest #' + (r.n || 1), rejection: 'rejection', signal: 'signal', setup_cancel: /^REFUSED/i.test(String(r.why || '')) ? 'refused' : 'cancelled', setup_expire: 'expired', grade_no_trade: 'no trade' }[r.phase] || r.phase;
    let zoneOf = {}; try { const M0 = tideOn(snapNow()); if (M0 && M0.zoneOf) zoneOf = M0.zoneOf; } catch (e) { zoneOf = {}; }   // 2.0.9.22: the zone borrowed from the setup's setup_arm
    const zone = r.zone || (typeof r.level === 'string' ? r.level : null) || (r.setup && zoneOf[r.setup]) || '';
    const why = r.phase === 'signal' ? (r.rebuilt === true ? 'replayed at warm-up · not tradeable' : r.taken === true ? 'taken' : 'not taken' + (r.gatesNow ? ' (' + r.gatesNow + ')' : '')) + (p.grade ? ' · ' + p.grade : '')
      : r.phase === 'grade_no_trade' ? (typeof T18.refusalText === 'function' ? T18.refusalText(r) : 'failed ' + Object.keys(r.gates || {}).filter(g => r.gates[g] === false).join(', ')) : r.why ? String(Array.isArray(r.why) ? r.why.join('; ') : r.why) : r.note || '';
    return `${hm(k.t)} PT · ${what} · ${zone}${fin(r.level) ? ' ' + px(r.level) : fin(r.entry) ? ' @' + px(r.entry) : ''}${why ? ' · ' + why : ''}`; }
  // mount / update: in the Hour card, after its strip
  let tape = null, last = '', cur = null; const perf = { updates: 0, updateMax: 0 };
  function render(d) {
    const t0 = performance.now(), card = document.getElementById('fx17-hour'); if (!card) return;
    const R = d && !tideless(d) ? model(d, Date.now()) : null;
    if (!R) { if (tape) { tape.hidden = true; card.removeAttribute('data-fx20'); } return; }
    if (!tape) { const strip = card.querySelector('.fx17-strip'); if (!strip) return; tape = document.createElement('div'); tape.className = 'fx20-tape';
      tape.innerHTML = '<div class="fx20-hd"><span class="fx20-k">TIDE TAPE</span><span class="fx20-cap"></span></div><div class="fx20-box"></div><div class="fx20-det" aria-live="polite"></div>'; strip.after(tape);
      tape.addEventListener('click', e => { const h = e.target.closest && e.target.closest('.fx20-hit'); if (!h || !cur) return; const G = cur.groups[+h.getAttribute('data-i')]; if (G) tape.querySelector('.fx20-det').textContent = gDetail(G); });
      tape.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('fx20-hit')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } }); }
    tape.hidden = false; if (card.getAttribute('data-fx20') !== 'tide') card.setAttribute('data-fx20', 'tide'); cur = R;
    const sig = JSON.stringify([Math.floor(R.now / 30000), R.ctl, R.shade.length, R.ticks.length, R.trades.map(t => [t.s, t.e, t.usd]), R.first]);
    if (sig !== last) { last = sig; tape.querySelector('.fx20-box').innerHTML = svg(R); }
    else { const g = tape.querySelector('.fx20-now'); if (g) g.setAttribute('transform', `translate(${R.x(R.now).toFixed(1)} 0)`); }
    const cp = tape.querySelector('.fx20-cap'); if (cp.textContent !== R.caption) cp.textContent = R.caption;
    const dt = performance.now() - t0; perf.updates++; if (dt > perf.updateMax) perf.updateMax = dt;
  }
  // ── Levels "Live trade · PLAN" in TIDE mode (MacArthur: ".20"): the chart's plan lines come from TIDE (the open tide.position, else the board's
  // NEXT TO ACT plan), never from the old levels path, which takes no entries under TIDE. The old path's lines stay one tap away ("Old levels path
  // (manage-only)", off by default, per phone). TIDE off / absent: every wrapped function is the page's own call, unchanged.
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* per-phone only */ } } };
  const oldOn = () => store.get('fx20-oldlv') === '1';
  function tideOn(d) { if (tideless(d)) return null; const k = modeKey(d); if (k !== 'shadow' && k !== 'live') return null; /* the Levels rule: shadow / live only */ const M = T18.model(d, Date.now()); return M && !M.partial && !M.off && (M.mode.key === 'shadow' || M.mode.key === 'live') ? M : null; }
  function tideMode() { try { const d = snapNow(); if (tideless(d)) return false; const k = modeKey(d); return k === 'shadow' || k === 'live'; } catch (e) { return false; } }   // 2.0.9.21: the mode alone, no model
  // 2.0.9.21 (Mac's 08:34 PT 11/04 screen): the level ladder (lvLadder: the "Flat, no plan" chart on the Levels card, the full screen and the Dash card) drew
  // the OLD path's live level event (levels.live: its target / stop / trigger lines and TGT / STOP tags) whatever TIDE held. Under TIDE shadow / live
  // the ladder gets levels.live emptied: named level lines and price stay, no old-path plan shape. TIDE off / absent: the page's own ladder, untouched.
  const _ll = window.lvLadder;
  if (typeof _ll === 'function') window.lvLadder = function (L) { if (L && tideMode() && Array.isArray(L.live) && L.live.length) { const a = Array.prototype.slice.call(arguments); a[0] = Object.assign({}, L, { live: [] }); return _ll.apply(this, a); } return _ll.apply(this, arguments); };
  // 2.0.9.21, the same leak in MacCharts (the canvas chart that replaces the ladder on the Levels card, the Dash card and the full screen): in its flat
  // mode (no trade, no plan) maccharts.js reads levels.live itself and draws that old-path event's level / Stop / Target lines and the Trigger marker
  // (Mac's 08:34 PT screen: Target 28,587 / Stop 28,471.75 under a TIDE SHORT). Its data comes from the glue's getData (integrate-charts.js liveData /
  // nowData, read-only handles at macui.charts). Under TIDE shadow / live, with the old-path toggle off, each handle's getData hands MacCharts the
  // same data with levels.live emptied; the handle is wrapped once, the first time a render shows it, and updated once more right then.
  const stripLive = data => (data && data.levels && Array.isArray(data.levels.live) && data.levels.live.length && tideMode() && !oldOn() ? Object.assign({}, data, { levels: Object.assign({}, data.levels, { live: [] }) }) : data);
  function chartsGuard() {
    const Hs = U.charts; if (!Hs || typeof Hs !== 'object') return;
    for (const k of Object.keys(Hs)) { const x = Hs[k], c = x && x.h && x.h._c; if (!c || !c.opt || typeof c.opt.getData !== 'function' || c.opt.getData.fx21) continue;
      const g = c.opt.getData, w = function () { return stripLive(g.apply(this, arguments)); }; w.fx21 = true; c.opt.getData = w;
      if (tideMode()) { try { x.h.update(); } catch (e) { /* display only */ } } }
  }
  // undefined = TIDE off (the page's own plan); null = TIDE on, no plan to draw; else a plan in the page's lvPlanTrade shape + tide fields
  function tidePlan(d) {
    const M = tideOn(d); if (!M) return undefined; const T19 = U.feat20919, now = Date.now();
    const x = T19 && typeof T19.livePos === 'function' ? T19.livePos(d) : null;
    if (x) { const P = x.P, t = fin(P.fillAt) ? P.fillAt : now, acked = fin(P.stopAcked), st = acked ? P.stopAcked : fin(P.stopAsked) ? P.stopAsked : null;
      if (!fin(P.avgEntry)) return { none: 'position', why: 'TIDE position open · fill price UNKNOWN (no observed fill): nothing charted' };
      const tg = {}; if (fin(P.tp1Px) && P.tp1Done !== true) tg.TP1 = [[t, P.tp1Px]]; if (fin(P.tp2Px)) tg.TP2 = [[t, P.tp2Px]];
      return { plan: true, tide: 'position', kind: 'fill', planWhat: `TIDE position ${P.open} · ${P.grade || 'grade UNKNOWN'}`, dir: P.dir, entry: P.avgEntry, stop0: st, openedAt: t, src: 'tide.position',
        stops: st != null ? { [acked ? 'STOP' : 'STOP asked']: [[t, st]] } : {}, targets: tg, px: [], phases: [[t, 'TIDE']], level: null, acked, P }; }
    const L = T19 && typeof T19.lvModel === 'function' ? T19.lvModel(d, now) : null, n = L && L.next, p = n && n.plan;
    if (!n) return { none: 'board', why: 'TIDE: nothing armed' + (L && L.src === 'rows' ? ' (journal rows)' : '') };
    if (!p || !fin(p.entry) || !fin(p.stop)) return { none: 'board', why: `TIDE next to act: ${n.name} ${fin(n.price) ? px(n.price) : ''} · entry, stop and TPs set at the signal` };
    const t = fin(n.since) ? n.since : now, ref = p.basis === 'reference' || p.plan === true, tg = {};
    if (fin(p.tp1)) tg.TP1 = [[t, p.tp1]]; if (fin(p.tp2)) tg.TP2 = [[t, p.tp2]];
    return { plan: true, tide: 'board', planWhat: `${n.name} · ${n.dir > 0 ? 'LONG' : n.dir < 0 ? 'SHORT' : 'side UNKNOWN'} · TIDE ${String(n.state).replace('-', ' ')}`, dir: n.dir, entry: p.entry, stop0: p.stop, openedAt: t, src: 'tide.board',
      stops: { [ref ? 'STOP ref' : 'STOP']: [[t, p.stop]] }, targets: tg, px: [], phases: [[t, 'PLAN']], level: { name: n.name, price: n.price, event: n.lane || 'tide', sweepExtreme: null, bornT: t, tf: p.stopTf || '' }, ref, n, blocked: !!L.nextBlocked }; }
  function tideStats(T) {
    const rk = fin(T.stop0) ? Math.abs(T.entry - T.stop0) : null, tp = k => T.targets[k] ? px(T.targets[k][0][1]) : null, side = T.dir > 0 ? 'LONG' : T.dir < 0 ? 'SHORT' : 'side UNKNOWN';
    const tps = tp('TP1') || tp('TP2') ? `TP1 ${tp('TP1') || (T.P && T.P.tp1Done ? 'hit' : '—')} · TP2 ${tp('TP2') || '—'}` : 'set at the signal';
    const note = T.tide === 'position' ? `TIDE&#39;s open position (tide.position): fill ${px(T.entry)}, stop ${T.acked ? 'acked by the broker' : 'asked, NOT acked'}. The old levels path takes no entries under TIDE.`
      : `${T.ref ? 'Reference, not an order: the level and its stop reference from tide.board; entry, stop and TPs are set at the signal.' : 'TIDE&#39;s plan for its next setup (tide.board): nothing is filled.'}${T.blocked ? ' Held: ' + esc((T.n.codes || []).map(b => b.code).join(', ')) + '.' : ''} The old levels path takes no entries under TIDE.`;
    return `<div class="lv-stats fx20-lvs"><div><span>${T.tide === 'position' ? 'TIDE' : 'Plan'}</span><b>${T.tide === 'board' ? esc(T.planWhat) : side + ' &middot; ' + esc(T.planWhat)}</b></div><div><span>${T.tide === 'position' ? 'Fill' : T.ref ? 'Level' : 'Entry'}</span><b>${px(T.entry)}</b></div>`
      + `<div><span>${T.ref ? 'Stop ref' : 'Stop'}</span><b>${px(T.stop0)}${rk ? ` (${rk.toFixed(2)} pts = 1R)` : ''}</b></div><div><span>Targets</span><b>${tps}</b></div></div><div class="lv-sub fx20-lvn" style="margin-top:6px">${note}</div>`; }
  const _lp = window.lvPlanTrade, _ls = window.lvPlanStats, _rt = window.renderLevelTrade;
  if (typeof _lp === 'function') window.lvPlanTrade = function (L) {
    let tp; try { tp = tidePlan(snapNow()); } catch (e) { tp = tideMode() ? { none: 'error', why: 'TIDE plan not read: nothing charted' } : undefined; }   // 2.0.9.21: a throw under TIDE never falls back to the old path
    if (tp === undefined) return _lp.apply(this, arguments);
    if (oldOn()) { const o = _lp.apply(this, arguments); return o ? Object.assign({}, o, { planWhat: 'old path (manage-only) · ' + o.planWhat, oldPath: true }) : null; }
    return tp && tp.plan ? tp : null; };
  if (typeof _ls === 'function') window.lvPlanStats = function (T) {
    if (T && T.tide) { try { return tideStats(T); } catch (e) { /* display only */ } }
    const r = _ls.apply(this, arguments); return T && T.oldPath ? r + '<div class="lv-sub fx20-lvn">The old levels path is manage-only under TIDE: it takes no entries. These are its lines, not TIDE&#39;s.</div>' : r; };
  if (typeof _rt === 'function') window.renderLevelTrade = function (L) {
    const r = _rt.apply(this, arguments);
    try { chartsGuard(); } catch (e) { /* display only */ }
    try { const d = snapNow(), tp = tidePlan(d); if (tp === undefined) return r;
      const el = document.getElementById('lv-trade-body'), sub = document.getElementById('lv-trade-sub'), picked = !!window.lvTradeKey || !!(L && L.trade && L.trade.open);
      if (!el) return r;
      if (!picked && sub) sub.textContent = oldOn() ? (sub.textContent === 'PLAN' ? 'OLD PATH PLAN' : sub.textContent) : tp && tp.plan ? (tp.tide === 'position' ? 'TIDE IN TRADE' : 'TIDE PLAN') : sub.textContent;   // plain words: the page's de-templater rewrites ' · ' in titles
      if (!picked && !oldOn() && tp && tp.none) el.insertAdjacentHTML('afterbegin', `<div class="lv-sub fx20-lvn" data-none="${tp.none}">${esc(tp.why)}</div>`);
      if (!picked) el.insertAdjacentHTML('beforeend', ` <button class="lv-btn fx20-old" type="button" aria-pressed="${oldOn()}">Old levels path (manage-only)${oldOn() ? ': on' : ''}</button>`);
    } catch (e) { /* display only */ }
    return r; };
  const _rd = window.renderLevelsDash, _fr = window.lvFullRender;
  if (typeof _rd === 'function') window.renderLevelsDash = function () { const r = _rd.apply(this, arguments); try { chartsGuard(); } catch (e) { /* display only */ } return r; };
  if (typeof _fr === 'function') window.lvFullRender = function () { const r = _fr.apply(this, arguments); try { chartsGuard(); } catch (e) { /* display only */ } return r; };
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('.fx20-old'); if (!b) return; store.set('fx20-oldlv', oldOn() ? '0' : '1');
    try { renderLevels(lastSnapForPoll); } catch (er) { /* display only */ } try { renderLevelsDash(lastSnapForPoll); } catch (er) { /* display only */ } });

  // ── Now, the WHY NOT / CLEAR deck (Mac 11/04 07:18 PT: "Not chasing … item 20" under TIDE live, while TIDE held on the open wait): with TIDE
  // shadow / live the headline is TIDE's own reason (its holds: the same rule rows the top pill reads; then the armed level and what it waits for).
  // The old checklist lines, the stop card and the alignment ladder move under a collapsed "Old levels model (not trading)". The deck's own HTML is
  // kept as written and put back the moment TIDE is off: TIDE off / absent = the page's deck, untouched.
  const SW = { armed: 'armed, waiting for the retest', 'retest-pending': 'retest pending', signalled: 'signalled', watching: 'watching', broken: 'broken', accepted: 'accepted', failed: 'failed', rejected: 'rejected' };
  let deckOn = false, deckOrig = null, deckHtmlLast = '', oldOpen = false;
  const FX22_NOTE = '<div class="flat-reason-line fx22-note">TIDE live: the reasons are TIDE&#39;s (the TIDE card and "why not" above). The old model&#39;s reasons sit under "Old levels model (not trading)".</div>';
  function deckModel(d, now) {
    const M = tideOn(d); if (!M) return null; const T19 = U.feat20919, x = T19 && typeof T19.livePos === 'function' ? T19.livePos(d) : null;
    if (x) return { tag: 'TIDE IN TRADE', st: 'trade', lines: [`TIDE ${x.P.dir === 1 ? 'LONG' : x.P.dir === -1 ? 'SHORT' : ''} ${x.P.open}: managed by the bot, see the Position card.`] };
    let holds = []; try { holds = T18.clModel(M, d, now).rules.filter(r => r.s === 'hold'); } catch (e) { holds = []; }
    const L = T19 && typeof T19.lvModel === 'function' ? T19.lvModel(d, now) : null, n = L && !L.partial ? L.next : null, lines = [];
    for (const r of holds) lines.push(`Holding: ${r.w} · ${String(r.why).replace(/^holding:\s*/, '')}`);
    if (n) { const p = n.plan, retest = n.state === 'armed' || n.state === 'retest-pending';
      lines.push(`${n.name} ${px(n.price)} ${SW[n.state] || String(n.state).replace('-', ' ')}${retest && fin(n.price) ? ' at ' + px(n.price) : ''}${L.src === 'board' && (n.dir === 1 || n.dir === -1) ? (n.dir > 0 ? ' · long side' : ' · short side') : ''}`
        + (L.nextBlocked && Array.isArray(n.codes) && n.codes.length ? ' · held: ' + n.codes.map(b => b.text || b.code).join(', ') : '') + (p && fin(p.entry) && fin(p.stop) && p.basis !== 'reference' ? ` · entry ${px(p.entry)} stop ${px(p.stop)}` : '')); }
    const tag = holds.length ? 'TIDE WHY NOT' : n ? 'TIDE WAITING' : 'TIDE SCANNING';
    if (!lines.length) lines.push(L && L.partial ? 'TIDE details need bot update' : 'No setup armed now: TIDE is scanning.');
    return { tag, st: holds.length ? 'blocked' : n ? 'clear' : 'unknown', lines };
  }
  function deckPatch(d) {
    if (!deckOn && tideless(d)) return;   // TIDE off and never patched: nothing to do
    const deck = document.getElementById('fx11-deck'); if (!deck) return;
    const W = tideless(d) ? null : deckModel(d, Date.now());
    if (!W) { const wc = document.getElementById('wnt-card'); if (wc && wc.hasAttribute('data-fx22')) wc.removeAttribute('data-fx22'); const fr0 = document.querySelector('#position-body .flat-reasons[data-fx22]'); if (fr0) fr0.removeAttribute('data-fx22'); const nt0 = document.querySelector('#position-body .fx22-note'); if (nt0) nt0.remove();
      if (deckOn) { deckOn = false; if (deckOrig != null && deck.querySelector(':scope > .fx20-w')) deck.innerHTML = deckOrig; deck.removeAttribute('data-fx20w'); deckOrig = null; deckHtmlLast = ''; } return; }
    if (!deck.querySelector(':scope > .fx20-w')) deckOrig = deck.innerHTML;   // the deck re-rendered (or first time): its own HTML, kept as written
    const box = document.createElement('div'); box.innerHTML = deckOrig; const hd = box.querySelector(':scope > .fx11-hd'), fr = hd && hd.querySelector('.fx11-fresh'); if (hd) hd.remove();
    const wntB = document.getElementById('wnt-body'), wntC = document.getElementById('wnt-card'), frz = document.querySelector('#position-body .flat-reasons');   // 2.0.9.22 (QC-UI 4): the old model's reasons never read as a reason on Now under TIDE
    const oldWnt = wntC && wntB && wntC.style.display !== 'none' && wntB.innerHTML.trim() ? `<div class="fx22-oldwnt"><div class="fx11-wm">Old checklist: ${esc((document.getElementById('wnt-title') || {}).textContent || 'Why no trade right now')} (not trading)</div>${wntB.innerHTML}</div>` : '';
    const oldFr = frz && frz.innerHTML.trim() ? `<div class="fx22-oldfr"><div class="fx11-wm">Old model, flat reasons (not trading)</div>${fr.innerHTML}</div>` : '';
    const html = `<div class="fx20-w"><div class="fx11-hd"><span class="fx11-tag" data-st="${W.st}">${W.tag}</span>${fr ? fr.outerHTML : ''}</div>`
      + W.lines.map((l, i) => `<div class="fx11-why fx20-wl${i ? ' fx20-wl2' : ''}" data-st="${W.st}">${esc(l)}</div>`).join('') + `<div class="fx11-wm">From TIDE (tide.rules, tide.board), the model the bot trades.</div></div>`
      + `<details class="fx20-oldm"${oldOpen ? ' open' : ''}><summary>Old levels model (not trading)</summary><div class="fx20-oldb">${oldWnt}${oldFr}${box.innerHTML}</div></details>`;
    if (wntC && wntC.getAttribute('data-fx22') !== 'old') wntC.setAttribute('data-fx22', 'old'); if (frz && frz.getAttribute('data-fx22') !== 'old') frz.setAttribute('data-fx22', 'old'); if (frz && !(frz.nextElementSibling && frz.nextElementSibling.classList.contains('fx22-note'))) frz.insertAdjacentHTML('afterend', FX22_NOTE);
    if (html !== deckHtmlLast || !deck.querySelector(':scope > .fx20-w')) { deck.innerHTML = html; deckHtmlLast = html; const dt = deck.querySelector('.fx20-oldm'); if (dt) dt.addEventListener('toggle', () => { oldOpen = dt.open; }); }
    if (deck.getAttribute('data-fx20w') !== 'tide') deck.setAttribute('data-fx20w', 'tide'); deckOn = true;
  }

  // ── 2.0.9.22 (QC-UI 1): the Day P&L header during a TIDE trade. r1.5.4 never sets d.openPnl / d.position for a TIDE position, so the header read
  // closed-only. With tide.position open and the old path flat: "Day P&L (closed) $x · TIDE open +$y (bot|calc)", the same openUsd / lastPx / livePx
  // arithmetic as the TIDE position card (feat-20919 posHTML). TIDE off / absent, or the old path in a trade: the page's own line.
  function tideOpenUsd(d) { const T19 = U.feat20919, x = T19 && typeof T19.livePos === 'function' ? T19.livePos(d) : null; if (!x) return null; const P = x.P;
    if (fin(P.openUsd)) return { v: P.openUsd, src: 'bot', P };
    const lp = fin(P.lastPx) ? P.lastPx : d.livePx && fin(d.livePx.price) ? d.livePx.price : null, pvf = window.pointValueFor, pv = typeof pvf === 'function' ? pvf(String(d.symbol || window.SYMBOL || '')) : null;
    return fin(P.avgEntry) && lp != null && fin(pv) && fin(P.open) ? { v: (P.dir || 1) * (lp - P.avgEntry) * P.open * pv, src: 'calc', P } : { v: null, src: 'UNKNOWN', P }; }
  const _rpc = window.renderPosCard;
  if (typeof _rpc === 'function') window.renderPosCard = function (d) {
    const r = _rpc.apply(this, arguments);
    try { const sub = document.getElementById('pnl-sub'); if (!sub || !d || !tideOn(d)) return r;
      const oldOpen = (d.position && d.position.markers && d.position.markers.length) || (fin(d.openPnl) && d.openPnl !== 0); if (oldOpen) return r;
      const o = tideOpenUsd(d); if (!o) return r;
      const closed = d.day && fin(d.day.realized) ? d.day.realized : fin(d.dayPnlNet) ? d.dayPnlNet : fin(d.dayPnlAllFills) ? d.dayPnlAllFills : null;
      const fm = typeof window.fmtMoney === 'function' ? window.fmtMoney : v => (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2);
      sub.textContent = `Day P&L (closed) ${closed != null ? fm(closed) : 'UNKNOWN'} · TIDE open ${o.v != null ? fm(o.v) : 'UNKNOWN'} (${o.src === 'bot' ? 'bot' : o.src === 'calc' ? 'calc: last price − fill × contracts × point value' : 'no price'})`;
      sub.style.display = 'block'; sub.setAttribute('data-fx22', 'tide'); } catch (e) { /* display only */ }
    return r; };
  const _rpo = window.renderPosition;
  if (typeof _rpo === 'function') window.renderPosition = function () { const r = _rpo.apply(this, arguments);
    try { if (deckOn) { const fr = document.querySelector('#position-body .flat-reasons'); if (fr && !fr.hasAttribute('data-fx22')) { fr.setAttribute('data-fx22', 'old'); fr.insertAdjacentHTML('afterend', FX22_NOTE); deckPatch(snapNow()); } } } catch (e) { /* display only */ }
    return r; };
  try { const st = document.createElement('style'); st.id = 'fx22-css'; st.textContent = '#wnt-card[data-fx22="old"],#position-body .flat-reasons[data-fx22="old"]{display:none!important}.fx22-oldwnt,.fx22-oldfr{margin:4px 0 8px;padding:4px 0 6px;border-bottom:1px dashed var(--line,rgba(127,127,127,.25))}.fx22-ref{margin-top:4px}.fx22-ring{margin-top:4px;color:var(--t3)}'; document.head.appendChild(st); } catch (e) { /* display only */ }
  U.feat20920 = { release: '2.0.9.22', model, perf, tidePlan, oldOn, deckModel, update: () => render(snapNow()) };
  const _w = window.renderWhyNoTrade;
  if (typeof _w === 'function') window.renderWhyNoTrade = function (d) { const r = _w.apply(this, arguments); try { render(d || snapNow()); } catch (e) { /* display only */ } try { deckPatch(d || snapNow()); } catch (e) { /* display only */ } return r; };
  const _rh = window.renderHeartbeat;
  if (typeof _rh === 'function') window.renderHeartbeat = function () { const r = _rh.apply(this, arguments); try { if (tape) render(snapNow()); } catch (e) { /* display only */ } try { if (deckOn) deckPatch(snapNow()); } catch (e) { /* display only */ } return r; };
  try { const d = snapNow(); if (d) { render(d); deckPatch(d); } } catch (e) { /* display only */ }
})();
