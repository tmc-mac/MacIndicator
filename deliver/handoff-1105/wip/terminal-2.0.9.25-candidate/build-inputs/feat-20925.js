/* MacUI 2.0.9.25: v2src/feat-20925.js (MacUI-D, Nov 5). Display only: no request, no write, no timer of its own (a MutationObserver on the body, flushed in a
   microtask, re-applies after every page render). Active ONLY while snapshot.tide is shadow / live (lastSnapForPoll.tide.mode); with TIDE off / absent nothing
   here touches the page (identity with 2.0.9.24).
   0. Branding (Mac 11/05 13:35 PT, "all TIDE needs to be changed to MacMillionz"): every user-facing label naming the bot reads MacMillionz. The header pill
      reads LIVE / SHADOW (no "TIDE "), and WARMING UP (neutral) while tide.warm is rebuilding. The word TIDE stays inside Why? dumps, signal-row text,
      <pre>/<code>, exports and setup ids.
   1. The Day P&L cell holds two lines under the number at 390 px: the balance line reads "balance +$712.65 · −$504.29 vs fills" in full; the trip list opens on
      tap only (a dropdown, never inline).
   2. ONE day number: the Rolling P&L card's headline is the same fills figure as the header (dayPnlNet / account.dayNet); its sub-line names the balance change
      and the non-trading adjustment when they differ. (Day peak / Given back are left as the page computes them: not recomputed on fills in this build.)
   0b. Trades: the day cards and the three tiles come from the merged set (feat-20924's bot records + the account round trips it could not match), by TradeDay
      (15:00 PT), newest first, deduped by id; a TradeDay the old list has no card for gets one in the resolved form. Review: the day net from the fills when the bot
      sent no realized ("net (from fills)"), no "net pending". The TIDE card carries LAST REJECT from tide.lastReject / order_reject rows.
   3. Decision card: under the TREND LANE verdict, Mac's 11 lane rows with the bot's values from the r1.6.1 trend_* rows (dirEv.prev4h, open4h, h30.open30 /
      last30, trend_arm / trend_signal / trend_skip / trend_idle), the next 30M close from the clock. An r1.5.6-style snapshot (no trend rows) says so. */
(function () {
  'use strict';
  const U = window.macui = window.macui || {}; const F = U.feat20925 = { v: '2.0.9.25', passes: 0, last: null };
  const fin = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = v => fin(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '?';
  const usd = v => (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const F2 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }), hm = t => fin(t) ? F2.format(new Date(t)) : '';
  const snap = () => { try { return typeof lastSnapForPoll !== 'undefined' ? lastSnapForPoll : null; } catch (e) { return null; } };
  const tideOn = d => { const T = d && d.tide; return T && typeof T === 'object' && (T.mode === 'live' || T.mode === 'shadow' || T.live === true) ? T : null; };
  const DOT = ' · ';
  // ── 0. branding: text nodes outside the engine's own dumps ──
  const KEEP = '.fx24-why, details.fx18-sig, .fx18-sigrow, pre, code, textarea, script, style, [data-fx25-keep]';
  const RE = /\bTIDE\b(?!\s*[-_]?(r\d|wire|structure|live-r))/g;
  function brand(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => RE.test(n.nodeValue) ? (RE.lastIndex = 0, n.parentElement && n.parentElement.closest(KEEP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : (RE.lastIndex = 0, NodeFilter.FILTER_SKIP) });
    const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
    for (const t of nodes) { const v = t.nodeValue.replace(/\bTIDE TRADES\b/g, 'MACMILLIONZ BOT TRADES').replace(RE, 'MacMillionz'); if (v !== t.nodeValue) t.nodeValue = v; }
    return nodes.length;
  }
  function pill(T) {
    const tag = document.querySelector('.fx19-tag'); if (!tag) return;
    const warm = T.warm && (T.warm.rebuilding === true || (fin(T.warm.doneMin) && fin(T.warm.totalMin) && T.warm.doneMin < T.warm.totalMin && !T.warm.finishedAt));
    const want = warm ? 'WARMING UP' : tag.textContent.replace(/^(TIDE|MacMillionz)\s+/, '');
    if (tag.textContent !== want) tag.textContent = want; if ((tag.dataset.fx25 === 'warm') !== !!warm) { if (warm) tag.dataset.fx25 = 'warm'; else delete tag.dataset.fx25; }
  }
  // ── 1 + 2. one day number ──
  function dayCell(d, T) {
    const cell = document.querySelector('.fx19-daysplit'); if (!cell || cell.hidden) return;
    const A = T.account || d.account || null, net = A && fin(A.dayNet) ? A.dayNet : fin(d.dayPnlNet) ? d.dayPnlNet : fin(d.dayPnlAllFills) ? d.dayPnlAllFills : null;
    const delta = A && fin(A.balanceDelta) ? A.balanceDelta : d.day && fin(d.day.rolling) ? d.day.rolling : null;
    const lines = [...cell.querySelectorAll('.fx23-dayl')];
    if (net != null && delta != null && lines[0] && /^balance /.test(lines[0].textContent)) { const want = `balance ${usd(delta)}${DOT}${usd(delta - net)} vs fills`; if (lines[0].textContent !== want) lines[0].textContent = want; }
    for (let i = 1; i < lines.length; i++) if (!lines[i].hidden) lines[i].hidden = true;   // at most two lines under the number
    const det = cell.querySelector('.fx23-daydet'); if (det) { const s = det.querySelector('summary'); if (s && s.textContent !== 'trips in the page sum') s.textContent = 'trips in the page sum'; }
    // the Rolling P&L card reads the same figure
    const pv = document.getElementById('pnl-value'), ps = document.getElementById('pnl-sub'), pc = document.getElementById('pnl-card');
    if (pv && net != null) { const want = usd(net); if (pv.textContent !== want) { pv.textContent = want; pv.classList.remove('skel'); } pv.dataset.fx25 = 'fills';
      if (pc) { pc.classList.toggle('pos', net > 0); pc.classList.toggle('neg', net < 0); }
      if (ps) { const adj = delta != null && Math.abs(delta - net) > 1; const want2 = adj ? `balance change ${usd(delta)}${DOT}includes a ${usd(delta - net)} non-trading adjustment (payout/reset)` : `realized from fills${DOT}closed trades only`; if (ps.textContent !== want2) ps.textContent = want2; ps.dataset.fx25 = '1'; }
      const t = pc && pc.querySelector('.card-title .title-sub'); if (t && t.textContent !== 'today · from fills') t.textContent = 'today · from fills'; }
  }
  // ── 3. Mac's eleven lane rows ──
  const bb = s => s > 0 ? 'BULLISH' : s < 0 ? 'BEARISH' : 'FLAT';
  function laneRows(d, T, now) {
    const rows = (Array.isArray(T.rows) ? T.rows : []).filter(r => r && typeof r.phase === 'string' && r.phase.startsWith('trend_'));
    if (!rows.length) return { none: true, text: T.rows && T.rows.length ? 'no trend-lane rows in this snapshot: this bot build sends none (r1.5.6-style journal)' : 'no journal rows in the snapshot yet' };
    const last = ph => rows.filter(r => r.phase === ph).sort((a, b) => a.t - b.t).pop() || null;
    const arm = last('trend_arm'), sig = last('trend_signal'), skip = last('trend_skip'), idle = last('trend_idle'), newest = rows.slice().sort((a, b) => a.t - b.t).pop();
    const src = sig && (!arm || sig.t >= arm.t) ? sig : arm || skip || null, ev = (src && src.dirEv) || (idle && idle.dirEv) || null, h30 = (src && src.h30) || (idle && idle.h30) || null;
    const B = T.board || {}, htf = B.htf || null, p4 = ev && ev.prev4h ? ev.prev4h : htf && htf.prev4h ? htf.prev4h : null;
    const why = idle && newest === idle ? String(idle.why || '') : '', dir = /no 4H direction/i.test(why) ? null : p4 && fin(p4.dir) ? p4.dir : null;   // the bot's own idle reason wins over the board's prev4h
    const open4 = ev && fin(ev.open4h) ? ev.open4h : fin(B.O4) ? B.O4 : htf && htf.cur4h && fin(htf.cur4h.o) ? htf.cur4h.o : null;
    const open30 = h30 && fin(h30.open30) ? h30.open30 : null, l30 = h30 && h30.last30 ? h30.last30 : null, price = fin(B.price) ? B.price : d.livePx && fin(d.livePx.price) ? d.livePx.price : null;
    const harmony = l30 && dir != null ? dir * (l30.c - l30.o) > 0 : /30M not in harmony/i.test(why) ? false : null;
    const sec = Math.floor(now / 1000) % 1800, to30 = 1800 - sec, to5 = 300 - (Math.floor(now / 1000) % 300), mm = s => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    const lv = r => r ? (r.level && typeof r.level === 'object' ? `${r.level.name} ${px(r.level.price)}` : `${r.rName || r.name || 'level'} ${px(r.R)}`) : null;
    const fresh = r => r && now - r.t < 4 * 3600000, S = sig && fresh(sig) && (!arm || sig.t >= arm.t) ? sig : null, K = !S && skip && fresh(skip) && (!arm || skip.t >= arm.t) ? skip : null, W = !S && !K && arm && fresh(arm) ? arm : null;
    const ctl = B.control && fin(B.control.dir) ? (B.control.dir < 0 ? 'SELLERS' : 'BUYERS') : null, acc5 = S || K ? ((S || K).dir > 0 ? 'BULL ACCEPTED' : 'BEAR ACCEPTED') : 'none yet';
    const trig = S || K ? `${(S || K).trigger === 'break' ? 'BREAK' : 'REJECT'} @ ${lv(S || K)}` : W ? `WAIT · watching ${lv(W)}${price != null && fin(W.R) ? ' (' + Math.abs(price - W.R).toFixed(2) + ' pts)' : ''}` : 'WAIT';
    const capHit = K && /^CAP_/.test(String(K.why || K.code || '')) || (S && /^CAP_/.test(String(S.why || '')));
    const action = S && S.taken === true ? `${S.side || (S.dir > 0 ? 'LONG' : 'SHORT')} READY → taken ${px(S.entry)} · stop ${px(S.stop)}${fin(S.size) ? ' · ' + S.size + ' MNQ' : ''}` : S ? `NO ENTRY · DEFENDED → skipped: ${S.why || 'no why sent'}` : K ? `NO ENTRY · ${capHit ? 'cap reached' : /GRADE_NO_FIT|stop .* pts/.test(String(K.why || K.code || '')) ? 'size: ' + String(K.why || K.code) : String(K.why || K.code || 'skipped')}` : W ? `${W.dir > 0 ? 'LONG' : 'SHORT'} READY if the 5m closes defended` : 'NO ENTRY';
    const R = [
      ['1. 4H CLOSED', dir == null ? (why && /no 4H direction/i.test(why) ? why.replace(/^.*?\(/, '(') : 'not sent') : `${bb(dir)} 4H${p4.at ? ' (' + String(p4.at).slice(-5) + ')' : ''}`],
      ['2. 4H CONTROL OPEN', open4 != null ? px(open4) : 'not sent'],
      ['3. 30M OPEN', open30 != null ? px(open30) : 'not sent'],
      ['4. 30M ACCEPTANCE', l30 ? `${l30.dir > 0 ? 'BULL' : l30.dir < 0 ? 'BEAR' : 'FLAT'} ACCEPTED (last 30M ${String(l30.at || '').slice(-5)} closed ${px(l30.c)})` : harmony === false ? why.replace(/^30M not in harmony\s*/i, '') : 'not sent'],
      ['5. NEXT 30M CLOSE', `${mm(to30)} TO CLOSE`],
      ['6. 5M OPEN', S || K ? ((S || K).def && fin((S || K).def.o) ? px((S || K).def.o) + ' (' + String((S || K).def.at || '').slice(-5) + ')' : 'not sent') : `next 5m close in ${mm(to5)}`],
      ['7. 4H/30M HARMONY', harmony === true ? 'YES' : harmony === false ? 'NO' : 'unknown: no 30M candle sent'],
      ['8. 5M ACCEPTANCE', acc5],
      ['9. 5M CONTROL', ctl ? `${ctl} RECLAIM` : 'none'],
      ['10. 5M TRIGGER', trig],
      ['11. ACTION', action]];
    return { none: false, R, dir, verdict: S && S.taken === true ? 'ACT' : W ? 'GET READY' : 'WAIT' };
  }
  function decision(d, T) {
    const card = document.getElementById('fx17-hour'); const box = card && card.querySelector('.fx23-verdict'); if (!box) return;
    let el = card.querySelector('.fx25-rows'); if (!el) { el = document.createElement('ol'); el.className = 'fx25-rows'; el.setAttribute('aria-label', "the bot's trend-lane state, Mac's eleven rows"); box.after(el); }
    const L = laneRows(d, T, Date.now()); F.last = L;
    const h = L.none ? `<li class="fx25-na">${esc(L.text)}</li>` : L.R.map(([k, v]) => `<li><span class="fx25-k">${esc(k)}</span><span class="fx25-v">${esc(v)}</span></li>`).join('');
    if (el.__h !== h) { el.innerHTML = h; el.__h = h; }
  }

  // ── 0b. the merged trade set (feat-20924's records + the unmatched account round trips), by TradeDay (15:00 PT) ──
  const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const ptParts = t => { const o = {}; for (const q of PT.formatToParts(new Date(t))) o[q.type] = q.value; return o; };
  const ptMs = t => { const o = ptParts(t); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute); };   // the PT wall clock as a UTC ms (for bucketing only)
  const tradeDay = t => Math.floor((ptMs(t) - 15 * 3600000) / 86400000);
  const DN = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }), WD = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
  const dayLabel = k => { const end = (k + 1) * 86400000 + 15 * 3600000 - 60000, from = k * 86400000 + 15 * 3600000; return { name: DN.format(new Date(end)), from: `from ${WD.format(new Date(from))} 3:00 PM PT` }; };
  function merged(d, T) {
    const F24 = U.feat20924; if (!F24 || typeof F24.model !== 'function') return null; let M; try { M = F24.model(d); } catch (e) { return null; } if (!M) return null;
    const items = [];
    for (const r of M.recs) { if (!(r.qty != null || r.closed)) continue; items.push({ id: r.tradeId || r.id, t: fin(r.fillT) ? r.fillT : r.t, side: r.side, qty: r.qty, usd: r.usd, pts: r.pts, R: r.R, level: r.level, levelPrice: r.levelPrice, kind: r.kind, exits: r.exits, closed: r.closed, src: 'bot' }); }
    for (const t of M.trips) { if (M.m.has(t)) continue; const et = ms(t.entryTime); if (!fin(et)) continue; const u = fin(t.netPnl) ? t.netPnl : fin(t.pnl) ? t.pnl : null; items.push({ id: String(t.positionId || t.entryOrderId || t.id || et), t: et, side: t.dir === 1 ? 'LONG' : t.dir === -1 ? 'SHORT' : '', qty: fin(t.size) ? t.size : fin(t.maxSize) ? t.maxSize : null, usd: u, pts: null, R: null, level: null, kind: null, exits: [], closed: t.closed !== false && t.exitTime != null, src: 'account' }); }
    const seen = new Set(); return items.filter(x => { const k = String(x.id); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.t - a.t);
  }
  const wlOf = list => { let w = 0, l = 0, e = 0; for (const x of list) { if (!x.closed) continue; if (fin(x.R)) { if (x.R > 0.1) w++; else if (x.R < -0.1) l++; else e++; } else if (fin(x.usd)) { if (x.usd > 0) w++; else if (x.usd < 0) l++; else e++; } } return { w, l, e }; };
  const rowHtml = x => { const lv = x.level ? `<b>${esc(x.level)}${x.levelPrice != null ? ' ' + px(x.levelPrice) : ''}</b>${x.kind ? DOT + esc(x.kind) : ''}` : '<span class="fx24-dim">account fill · not matched to a bot record</span>';
    const ex = x.exits && x.exits.length ? x.exits.map(f => `${f.leg || 'exit'} ${f.qty} @ ${px(f.px)}${fin(f.t) ? ' (' + hm(f.t) + ')' : ''}`).join(DOT) : '';
    return `<div class="tl-row fx25-tr" data-id="${esc(x.id)}"><div class="tl-l"><div class="tl-top"><span class="tl-time">${hm(x.t)}</span><span class="fx25-side" data-dir="${x.side === 'LONG' ? 1 : -1}">${esc(x.side)}</span><span class="tl-size">${x.qty != null ? x.qty + 'x' : ''}</span></div><div class="tl-meta fx25-lv">${lv}${x.qty != null ? DOT + x.qty + (x.qty === 1 ? ' lot' : ' lots') : ''}${fin(x.pts) ? DOT + (x.pts > 0 ? '+' : '') + x.pts.toFixed(2) + ' pts' : ''}${fin(x.usd) ? DOT + '<b data-s="' + Math.sign(x.usd) + '">' + usd(x.usd) + '</b>' : x.closed ? DOT + 'net not sent' : DOT + 'open'}${fin(x.R) ? DOT + (x.R > 0 ? '+' : '') + x.R.toFixed(2) + 'R' : ''}</div>${ex ? `<div class="tl-x">${esc(ex)}</div>` : ''}</div></div>`; };
  function tradesTab(d, T) {
    const body = document.getElementById('tl-body'), foot = document.getElementById('tl-hero-foot'); if (!body || !foot) return;
    const top = document.querySelector('#tl-hero .tl-hero-top > span'); if (top && top.textContent === 'Bot trades') top.textContent = 'MacMillionz trades';
    const items = merged(d, T); if (!items) return; const now = Date.now(), kToday = tradeDay(now), today = items.filter(x => tradeDay(x.t) === kToday);
    // the tiles: This TradeDay = the header's fills figure (dayPnlNet), else the merged sum; Win / loss by R (±0.1R even); Open = the bot's position
    const A = T.account || d.account || null, net = A && fin(A.dayNet) ? A.dayNet : fin(d.dayPnlNet) ? d.dayPnlNet : today.some(x => fin(x.usd)) ? Math.round(today.reduce((a, x) => a + (fin(x.usd) ? x.usd : 0), 0) * 100) / 100 : null;
    const wl = wlOf(today), openN = T.position && typeof T.position === 'object' ? 1 : 0, closedN = today.filter(x => x.closed).length;
    const tiles = [...foot.querySelectorAll('.ctl-stat')]; for (const el of tiles) { const l = el.querySelector('.ctl-stat-l'), v = el.querySelector('.ctl-stat-v'); if (!l || !v) continue; const k = l.textContent.trim(); let want = null;
      if (k === 'This TradeDay' && net != null) { want = usd(net); v.className = 'ctl-stat-v ' + (net > 0 ? 'tl-pnl pos' : net < 0 ? 'tl-pnl neg' : ''); }
      else if (k === 'Trades' || k === 'Closed') { want = String(closedN); l.textContent = 'Closed'; }
      else if (k === 'Win / loss') want = `${wl.w} / ${wl.l}`; else if (k === 'Open') want = String(openN);
      if (want != null && v.textContent !== want) { v.textContent = want; v.dataset.fx25 = '1'; } }
    if (tiles.length && !tiles.some(el => /Win \/ loss/.test(el.textContent))) { const ref = tiles.find(el => /Closed|Trades/.test((el.querySelector('.ctl-stat-l') || {}).textContent || '')) || tiles[0]; const el = document.createElement('div'); el.className = 'ctl-stat fx25-tile'; el.innerHTML = `<div class="ctl-stat-l">Win / loss</div><div class="ctl-stat-v" data-fx25="1">${wl.w} / ${wl.l}</div>`; ref.after(el); }
    // the day cards: a card for every TradeDay of the merged set that the old list has no card for (newest first), dedupe by id
    const have = new Set([...body.querySelectorAll('.tl-day:not(.fx25-day) .tl-day-name')].map(e => e.textContent.trim()));
    const days = new Map(); for (const x of items) { const k = tradeDay(x.t); if (!days.has(k)) days.set(k, []); days.get(k).push(x); }
    const want = []; for (const [k, list] of [...days.entries()].sort((a, b) => b[0] - a[0])) { const lab = dayLabel(k); if (have.has(lab.name)) continue; const pnl = Math.round(list.reduce((a, x) => a + (fin(x.usd) ? x.usd : 0), 0) * 100) / 100, s = wlOf(list), n = s.w + s.l + s.e, pct = v => (n ? (v / n * 100).toFixed(1) : 0) + '%', cls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '', nOpen = list.filter(x => !x.closed).length;
      want.push(`<div class="card tl-day fx25-day" data-day="${k}"><div class="tl-day-head ${cls}"><div><div class="tl-day-name">${lab.name}</div><div class="tl-day-sub">TradeDay ${lab.from}</div></div><div class="tl-day-r"><div class="tl-day-pnl ${cls}">${pnl > 0 ? '▲ ' : pnl < 0 ? '▼ ' : ''}${usd(pnl)}</div><div class="tl-day-n">${list.length} trade${list.length === 1 ? '' : 's'}${nOpen ? ', ' + nOpen + ' open' : ''}</div></div>`
        + (n ? `<div class="wl" role="img" aria-label="${s.w} wins, ${s.l} losses${s.e ? ', ' + s.e + ' even' : ''}"><div class="wl-bar"><i class="w" style="width:${pct(s.w)}"></i><i class="f" style="width:${pct(s.e)}"></i><i class="l" style="width:${pct(s.l)}"></i></div><div class="wl-cap"><span class="k-win">▲ ${s.w} won</span><span class="k-loss">▼ ${s.l} lost</span></div></div>` : '') + `</div><div class="tl-rows">${list.map(rowHtml).join('')}</div><div class="fx24-dim fx25-src">MacMillionz records (the bot's journal + fills); the old trade list has no card for this TradeDay</div></div>`); }
    const h = want.join(''); if (body.__fx25 !== h || (h && !body.querySelector('.fx25-day'))) { /* the list's own re-render wipes the body: put the cards back */ for (const e of body.querySelectorAll('.fx25-day')) e.remove(); const empty = body.querySelector('.tl-state, .tl-empty'); if (h && empty && /No trades yet/.test(empty.textContent)) empty.hidden = true; body.insertAdjacentHTML('afterbegin', h); body.__fx25 = h; }
  }
  // ── Review: the day net from the fills when the bot sent no realized; the "net pending" line goes ──
  function reviewNet(d, T) {
    const mw = document.querySelector('.tj-day .tj-mw'), mv = document.querySelector('.tj-day .tj-money'), pend = document.querySelector('.tj-day .tj-pend'); if (!mw || !mv) return;
    if (!/gross \(bot\)|net \(from fills\)/.test(mw.textContent) && !pend) return;
    const items = merged(d, T); if (!items) return; const k = tradeDay(Date.now()), closed = items.filter(x => x.src === 'bot' && x.closed && tradeDay(x.t) === k);
    if (!closed.length || !closed.every(x => fin(x.usd))) return;   // a closed trade with no exit fill: the bot's gross stays
    const net = Math.round(closed.reduce((a, x) => a + x.usd, 0) * 100) / 100, want = usd(net);
    if (mv.textContent !== want) { mv.textContent = want; mv.dataset.s = String(Math.sign(net)); } if (mw.textContent !== 'net (from fills)') mw.textContent = 'net (from fills)'; if (pend) pend.remove();
  }
  // ── the TIDE card: LAST REJECT from tide.lastReject, else the newest order_reject row ──
  function lastReject(T) {
    const t = [...document.querySelectorAll('.fx18-hd .fx18-t')].find(e => /^(TIDE|MacMillionz)$/.test(e.textContent.trim())); const card = t && (t.closest('.card') || t.closest('.fx18-hd').parentElement); if (!card) return;
    const rows = Array.isArray(T.rows) ? T.rows.filter(r => r && (r.phase === 'order_reject' || r.phase === 'live_order_reject')) : [], rj = T.lastReject && typeof T.lastReject === 'object' ? T.lastReject : rows.length ? rows[rows.length - 1] : null;
    let el = card.querySelector('.fx25-rej');
    if (!rj) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'fx25-rej'; el.setAttribute('role', 'status'); card.appendChild(el); }
    const h = `<b>LAST REJECT</b> ${hm(ms(rj.t))} ${esc(rj.kind || rj.key || 'order')}${rj.side ? ' ' + esc(rj.side) : ''}${fin(rj.qty) ? ' ' + rj.qty + 'x' : ''} rejected: ${esc(rj.reason || 'no reason sent')}`;
    if (el.__h !== h) { el.innerHTML = h; el.__h = h; }
  }
  // ── the pass ──
  let busy = false, queued = false;
  function pass() {
    if (busy) return; busy = true;
    try { const d = snap(), T = d ? tideOn(d) : null; if (!T) { const el = document.querySelector('.fx25-rows'); if (el) el.remove(); return; }
      F.passes++; brand(document.body); pill(T); dayCell(d, T); decision(d, T); tradesTab(d, T); reviewNet(d, T); lastReject(T); }
    catch (e) { F.error = String(e && e.message); } finally { busy = false; }
  }
  // one pass per animation frame after a DOM change (never a microtask loop with another script's observer); at most 12 passes a second, or the observer rests 1 s
  let stamps = [];
  const mo = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; const now = performance.now(); stamps = stamps.filter(t => now - t < 1000); if (stamps.length >= 12) { F.rests = (F.rests || 0) + 1; setTimeout(pass, 1000); return; } stamps.push(now); pass(); }); });
  const start = () => { mo.observe(document.body, { childList: true, subtree: true }); pass(); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  F.update = pass;
})();
