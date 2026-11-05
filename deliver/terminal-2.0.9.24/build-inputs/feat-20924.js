/* MacUI 2.0.9.24: v2src/feat-20924.js (MacUI-C, Nov 5). Mac: "Why aren't the levels traded being reported?" Display only: no request, no write, no
   timer of its own (the page's own 1 s heartbeat drives it). Active ONLY while snapshot.tide is shadow / live; with TIDE off / absent nothing here touches
   the page (identity with 2.0.9.23).
   Every trade row (Now · Recent Trades, Trades · account box, the TIDE trade rows on Trades / Review) resolves to its TIDE record: match on the order ids /
   position id the bot wrote (tide.trades, the lv_tide live_* rows), else the entry time within 90 s and the side. A matched row shows the level and kind
   ("4H Open 28,430.50 · trap"), the qty from the entry fill(s), the points and $ from the fills (the bot's realizedUsd / netUsd when sent, else
   Σ(exit − entry) × qty × dir × $2 − fees), R against the planned stop, the exits (tp1 n @ px · tp2 · stop) and a Why? that opens the TIDE signal row
   (gates, grade tag, takenWhy / why). An unmatched row reads "account fill · not matched to a bot record" (muted). A qty with no fill in the journal reads
   "qty UNKNOWN: no fill in the journal". The account-box copy of a trade already listed as a TIDE trade is hidden (one row per trade, not two). */
(function () {
  'use strict';
  const U = window.macui = window.macui || {};
  const fin = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = v => fin(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '?';
  const usd = v => (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sg2 = v => (v > 0 ? '+' : '') + v.toFixed(2);
  const F2 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }), hm = t => fin(t) ? F2.format(new Date(t)) : '';
  const DOT = ' · ';
  const snap = () => { try { return typeof lastSnapForPoll !== 'undefined' ? lastSnapForPoll : null; } catch (e) { return null; } };
  const tideOn = d => { const T = d && d.tide; return T && typeof T === 'object' && (T.mode === 'live' || T.mode === 'shadow' || T.live === true) ? T : null; };
  const ms = v => { if (fin(v)) return v > 1e11 ? v : v * 1000; if (typeof v === 'string') { const t = Date.parse(v); return fin(t) ? t : null; } return null; };
  // every order / position id a row or trade carries, as strings
  function ids(v, out, depth) { out = out || []; depth = depth || 0; if (v == null || depth > 3) return out; if (Array.isArray(v)) { v.forEach(x => ids(x, out, depth + 1)); return out; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) if (/(^|[a-z])(order|position|pos)?ids?$/i.test(k) || /^(entry|exit|stop|tp1|tp2)OrderId$/.test(k) || k === 'orders' || k === 'order') ids(v[k], out, depth + 1); return out; }
    if (typeof v === 'string' || typeof v === 'number') { const s = String(v); if (/^[A-Za-z0-9_-]{3,}$/.test(s) && !/^S\d+(-[A-Z])?$/.test(s)) out.push(s); } return out; }
  const legOf = r => { const w = String(r.leg || r.role || r.which || r.step || r.target || '').toLowerCase(); if (/tp1|target1|partial/.test(w)) return 'tp1'; if (/tp2|target2|runner/.test(w)) return 'tp2'; if (/stop|^sl$|be/.test(w)) return 'stop'; if (/entry|open/.test(w)) return 'entry'; if (/exit|flat|close|manual|session/.test(w)) return 'exit'; return null; };
  const pxOf = r => [r.price, r.px, r.fillPx, r.avgPx, r.fillPrice, r.avgFillPrice].find(fin);
  const qtyOf = r => [r.qty, r.size, r.filled, r.filledQty, r.contracts].find(fin);
  // ── the records: one per TIDE signal, merged from the setup_arm row, the live_* rows and tide.trades ──
  function records(T) {
    const rows = Array.isArray(T.rows) ? T.rows.filter(r => r && typeof r === 'object') : [], recs = [], byId = new Map(), bySetup = new Map();
    const get = (id, setup) => (id && byId.get(id)) || (setup && bySetup.get(setup)) || null;
    for (const r of rows) if (r.phase === 'signal' && r.id) {
      const rec = { id: r.id, setup: r.setup || null, dir: r.dir, side: r.side || (r.dir === 1 ? 'LONG' : r.dir === -1 ? 'SHORT' : null), kind: r.kind || null, level: r.level || null, levelPrice: fin(r.levelPrice) ? r.levelPrice : null, planned: fin(r.entry) ? r.entry : null, t: ms(r.t), sig: r, plan: r.plan || {}, oids: new Set(ids(r)), entries: [], exits: [], realized: null, fees: null, fillT: null, path: null };
      recs.push(rec); byId.set(rec.id, rec); if (rec.setup && !bySetup.has(rec.setup)) bySetup.set(rec.setup, rec); }
    for (const r of rows) if (r.phase === 'setup_arm' && r.setup) { const rec = bySetup.get(r.setup); if (!rec) continue; rec.kind = rec.kind || r.kind || null; rec.level = rec.level || r.zone || r.level && typeof r.level === 'string' && r.level || null; if (rec.levelPrice == null && fin(r.level)) rec.levelPrice = r.level; if (rec.levelPrice == null && fin(r.levelPrice)) rec.levelPrice = r.levelPrice; }
    for (const r of rows) if (/^live_/.test(String(r.phase || ''))) { const rec = get(r.id || r.signalId, r.setup); if (!rec) continue; ids(r).forEach(x => rec.oids.add(x));
      if (r.phase === 'live_fill' || r.phase === 'live_end') { const leg = legOf(r) || (r.phase === 'live_end' ? 'exit' : null), p = pxOf(r), q = qtyOf(r); if (!fin(p) || !fin(q)) continue; const f = { leg, px: p, qty: q, t: ms(r.t) }; if (leg === 'entry') rec.entries.push(f); else if (leg) rec.exits.push(f); }
      if (r.phase === 'live_result' || r.phase === 'live_end') { if (fin(r.realizedUsd)) rec.realized = r.realizedUsd; else if (fin(r.netUsd)) rec.realized = r.netUsd; if (fin(r.feesUsd)) rec.fees = r.feesUsd; if (fin(r.fees)) rec.fees = r.fees; } }
    for (const x of (Array.isArray(T.trades) ? T.trades : [])) { if (!x || typeof x !== 'object') continue; const rec = get(x.id || x.signalId, x.setup); if (!rec) continue; ids(x).forEach(v => rec.oids.add(v)); rec.tradeId = x.id || rec.id;
      if (Array.isArray(x.fills)) for (const f of x.fills) { if (!f || typeof f !== 'object') continue; const p = pxOf(f), q = qtyOf(f); if (!fin(p) || !fin(q)) continue; const leg = legOf(f) || (f.side && rec.dir && ((rec.dir === 1) === /buy|long/i.test(String(f.side))) ? 'entry' : 'exit'); const o = { leg, px: p, qty: q, t: ms(f.t) }; if (leg === 'entry') { if (!rec.entries.some(e => e.px === p && e.qty === q && e.t === o.t)) rec.entries.push(o); } else if (!rec.exits.some(e => e.px === p && e.qty === q && e.leg === leg)) rec.exits.push(o); }
      if (!rec.entries.length && fin(x.avgEntry) && fin(x.qty)) rec.entries.push({ leg: 'entry', px: x.avgEntry, qty: x.qty, t: ms(x.openedAt) });
      if (!rec.exits.length && fin(x.exitAvgPx) && fin(x.qty)) rec.exits.push({ leg: legOf({ leg: x.exitPath }) || 'exit', px: x.exitAvgPx, qty: x.qty, t: ms(x.closedAt) });
      if (fin(x.realizedUsd)) rec.realized = x.realizedUsd; else if (fin(x.netUsd)) rec.realized = x.netUsd; if (fin(x.feesUsd)) rec.fees = x.feesUsd; if (fin(x.fees)) rec.fees = x.fees; if (typeof x.path === 'string') rec.path = x.path; }
    for (const rec of recs) { const E = rec.entries, q = E.reduce((a, f) => a + f.qty, 0); rec.qty = E.length ? q : null; rec.avgEntry = E.length ? E.reduce((a, f) => a + f.px * f.qty, 0) / q : null; rec.fillT = E.length ? Math.min(...E.map(f => f.t).filter(fin)) : null; if (!fin(rec.fillT)) rec.fillT = null;
      const X = rec.exits, xq = X.reduce((a, f) => a + f.qty, 0); rec.closed = X.length > 0 && (rec.qty == null || xq >= rec.qty);
      rec.gross = fin(rec.avgEntry) && X.length ? X.reduce((a, f) => a + (f.px - rec.avgEntry) * f.qty * (rec.dir === -1 ? -1 : 1), 0) * 2 : null; rec.pts = fin(rec.gross) && xq ? rec.gross / 2 / xq : null;
      rec.usd = fin(rec.realized) ? rec.realized : fin(rec.gross) ? rec.gross - (fin(rec.fees) ? rec.fees : 0) : null; rec.usdSrc = fin(rec.realized) ? 'bot realized' : fin(rec.gross) ? (fin(rec.fees) ? 'fills − fees' : 'fills, before fees') : null;
      const stop = fin(rec.plan.stop) ? rec.plan.stop : null, e0 = fin(rec.avgEntry) ? rec.avgEntry : rec.planned, riskPts = fin(stop) && fin(e0) ? Math.abs(e0 - stop) : fin(rec.plan.stopPts) ? rec.plan.stopPts : null; rec.R = fin(rec.pts) && fin(riskPts) && riskPts > 0 ? rec.pts / riskPts : null; }
    return recs;
  }
  // ── the match: a broker round trip (recentTrades) / an account fill → its record ──
  function matchTrip(recs, trip, taken) {
    const tid = new Set(ids(trip)), et = ms(trip.entryTime), dir = trip.dir;
    let best = null, bd = Infinity;
    for (const rec of recs) { if (taken.has(rec)) continue; if (tid.size && [...tid].some(x => rec.oids.has(x))) { best = rec; bd = -1; break; }
      if (!fin(et) || (fin(dir) && fin(rec.dir) && dir !== rec.dir)) continue; const rt = fin(rec.fillT) ? rec.fillT : rec.t; if (!fin(rt)) continue; const dt = Math.abs(rt - et); if (dt <= 90000 && dt < bd) { best = rec; bd = dt; } }
    if (best) taken.add(best); return best ? { rec: best, how: bd < 0 ? 'order id' : 'entry time ±90 s + side' } : null;
  }
  function model(d) { const T = tideOn(d); if (!T) return null; const recs = records(T), trips = Array.isArray(d.recentTrades) ? d.recentTrades.filter(t => t && t.entryTime != null) : [], taken = new Set(), m = new Map();
    for (const t of trips) { const r = matchTrip(recs, t, taken); if (r) m.set(t, r); } return { T, recs, trips, m }; }
  // ── the resolved line ──
  function exitsText(rec) { if (!rec.exits.length) return rec.path ? rec.path : 'exits: none in the journal'; const order = { tp1: 1, tp2: 2, stop: 3, exit: 4 }; return rec.exits.slice().sort((a, b) => (order[a.leg] || 9) - (order[b.leg] || 9)).map(f => `${f.leg || 'exit'} ${f.qty} @ ${px(f.px)}${fin(f.t) ? ' (' + hm(f.t) + ')' : ''}`).join(' · '); }
  function lineHTML(rec, trip, how) {
    const lvl = rec.level ? `<b>${esc(rec.level)}${rec.levelPrice != null ? ' ' + px(rec.levelPrice) : ''}</b>${rec.kind ? DOT + esc(rec.kind) : ''}` : '<b>level not on the signal row</b>';
    const q = rec.qty != null ? `${rec.qty} ${rec.qty === 1 ? 'lot' : 'lots'}` : '<span class="fx24-unk">qty UNKNOWN: no fill in the journal</span>';
    const pts = fin(rec.pts) ? `${sg2(rec.pts)} pts` : rec.closed || rec.exits.length ? 'pts UNKNOWN: no fill price' : 'open';
    const money = fin(rec.usd) ? `<b data-s="${Math.sign(rec.usd)}">${usd(rec.usd)}</b> <span class="fx24-dim">${esc(rec.usdSrc)}</span>${trip && fin(trip.netPnl) && Math.abs(trip.netPnl - rec.usd) > 1 ? ` <span class="fx24-dim">· broker net ${usd(trip.netPnl)}</span>` : ''}` : '';
    const R = fin(rec.R) ? `${sg2(rec.R)}R` : 'R UNKNOWN: no stop on the plan';
    const P = rec.plan || {}, gd = P.gradeDetail || {}, s = rec.sig, gates = s.gates && typeof s.gates === 'object' ? Object.keys(s.gates).map(k => `${k}: ${s.gates[k] === true ? 'pass' : s.gates[k] === false ? 'fail' : esc(String(s.gates[k]))}`).join(', ') : (s.gatesNow != null ? String(s.gatesNow) : 'not on the row');
    const why = `<details class="fx24-why"><summary aria-label="Why the bot took this trade (the TIDE signal row)">Why?</summary><div class="fx24-wb"><div>signal <b>${esc(rec.id)}</b>${rec.setup ? ' · setup ' + esc(rec.setup) : ''} · ${hm(rec.t)} PT · ${esc(rec.side || '')} · planned entry ${px(rec.planned)}${fin(P.stop) ? ' · stop ' + px(P.stop) : ''}${P.tp1 && fin(P.tp1.price) ? ' · TP1 ' + px(P.tp1.price) : ''}${P.tp2 && fin(P.tp2.price) ? ' · TP2 ' + px(P.tp2.price) : ''}</div>`
      + `<div>grade <span class="fx24-tag">${esc(P.grade || gd.grade || 'not sent')}</span>${fin(gd.points) ? ' · ' + gd.points + ' pts' : ''}${Array.isArray(gd.names) && gd.names.length ? ' · ' + esc(gd.names.join(', ')) : ''}${s.htf ? ' · HTF ' + esc(s.htf) : ''}</div>`
      + `<div>gates: ${esc(gates)}</div><div>${s.takenWhy != null ? 'taken: ' + esc(s.takenWhy) : s.why != null ? 'why: ' + esc(s.why) : s.taken === true ? 'taken' : 'why: not on the row'}</div><div class="fx24-dim">matched by ${esc(how)}</div></div></details>`;
    return `<span class="fx24-k">Level</span> ${lvl}${DOT}${q}${DOT}${pts}${money ? DOT + money : ''}${DOT}${R}<div class="fx24-x">${esc(exitsText(rec))}</div>${why}`;
  }
  const UNMATCHED = '<span class="fx24-dim">account fill · not matched to a bot record</span>';
  function setLine(host, before, html, cls) { let l = host.querySelector(':scope > .fx24-lv'); if (!l) { l = document.createElement('div'); l.className = 'fx24-lv'; if (before && before.parentNode === host) host.insertBefore(l, before); else host.appendChild(l); } l.className = 'fx24-lv' + (cls ? ' ' + cls : ''); if (l.innerHTML !== html) l.innerHTML = html; }
  // (a) Now · Recent Trades (the bot's own list in #trades-body)
  function patchOld(M) { const body = document.getElementById('trades-body'); if (!body) return 0; let n = 0;
    for (const row of body.querySelectorAll('.trade-row')) { const b = row.querySelector('.why-btn'), a = b && /openWhy\((\{.*\})\)/.exec(b.getAttribute('onclick') || ''); let arg = null; try { arg = a ? JSON.parse(a[1]) : null; } catch (e) { arg = null; }
      const trip = arg ? M.trips.find(t => t.entryTime === arg.t && t.entryPrice === arg.p && t.dir === arg.d) : null, r = trip ? M.m.get(trip) : null, left = row.firstElementChild;
      if (!left) continue; if (r) { n++; row.setAttribute('data-fx24', 'matched'); const sz = row.querySelector('.trade-size'); if (sz) { const w = r.rec.qty != null ? r.rec.qty + 'x' : 'qty ?'; if (sz.textContent !== w) sz.textContent = w; sz.setAttribute('title', r.rec.qty != null ? 'qty from the entry fill(s) in the bot journal' : 'no fill in the journal'); } setLine(left, null, lineHTML(r.rec, trip, r.how)); }
      else { row.setAttribute('data-fx24', 'none'); setLine(left, null, UNMATCHED, 'is-muted'); } }
    return n; }
  // (b) Trades · the account box rows (fx23-ar: time · side qty · price → exit · $)
  function patchAcct(M) { const box = document.querySelector('.fx23-acct'); if (!box) return 0; let n = 0; const listed = new Set([...document.querySelectorAll('.fx18-tlist [data-fx23-replay]')].map(b => b.getAttribute('data-fx23-replay')));
    for (const li of box.querySelectorAll('li.fx23-ar')) { const tt = (li.querySelector('.fx18-tt') || {}).textContent || '', dim = ((li.querySelector('.fx18-dim') || {}).textContent || '').trim(), p0 = dim.split('→')[0].trim();
      const trip = M.trips.find(t => hm(ms(t.entryTime)) === tt && px(fin(t.entryAvgPrice) ? t.entryAvgPrice : t.entryPrice) === p0), r = trip ? M.m.get(trip) : null;
      if (r) { n++; const dup = listed.has(r.rec.tradeId) || listed.has(r.rec.id); li.setAttribute('data-fx24', dup ? 'dup' : 'matched'); li.hidden = dup; if (!dup) { const b = li.querySelector('b'); if (b) { const w = `${r.rec.dir === 1 ? '▲' : '▼'} ${r.rec.side || ''}${r.rec.qty != null ? ' ' + r.rec.qty : ''}`; if (b.textContent !== w) b.textContent = w; } setLine(li, null, lineHTML(r.rec, trip, r.how)); } }
      else { li.hidden = false; li.setAttribute('data-fx24', 'none'); setLine(li, null, UNMATCHED, 'is-muted'); } }
    return n; }
  // (c) the TIDE trade rows / cards (Trades, Review): the resolved line next to the Show-on-Levels button
  function patchTide(M) { let n = 0; for (const b of document.querySelectorAll('[data-fx23-replay]')) { const id = b.getAttribute('data-fx23-replay'), rec = M.recs.find(r => r.tradeId === id || r.id === id); const host = b.parentElement; if (!rec || !host) continue; n++; const trip = [...M.m.entries()].find(([, r]) => r.rec === rec); setLine(host, b, lineHTML(rec, trip ? trip[0] : null, trip ? trip[1].how : 'bot record')); } return n; }
  function clear() { for (const e of document.querySelectorAll('.fx24-lv')) e.remove(); for (const e of document.querySelectorAll('[data-fx24]')) { if (e.getAttribute('data-fx24') === 'dup') e.hidden = false; e.removeAttribute('data-fx24'); } }
  let lastOff = true;
  function update() { const d = snap(), M = model(d); if (!M) { if (!lastOff) clear(); lastOff = true; U.feat20924.last = null; return; } lastOff = false; const out = { old: 0, acct: 0, tide: 0, recs: M.recs.length, matched: M.m.size };
    try { out.old = patchOld(M); } catch (e) { /* display only */ } try { out.acct = patchAcct(M); } catch (e) { /* display only */ } try { out.tide = patchTide(M); } catch (e) { /* display only */ } U.feat20924.last = out; }
  U.feat20924 = { release: '2.0.9.24', model, records, update, last: null };
  // the heartbeat: after the page's own renders (the bot list and the fx18 / fx23 cards re-render on their 1 s beat); only while TIDE is on
  const tick = () => { try { update(); } catch (e) { /* display only */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(tick, 50)); else setTimeout(tick, 50);
  setInterval(tick, 1000);
  // the lists re-render on the page's own beat (innerHTML): re-apply right after a DOM change, idempotently (a settled row costs no mutation)
  let due = false; const mo = new MutationObserver(() => { if (due) return; due = true; requestAnimationFrame(() => { due = false; tick(); }); });
  try { mo.observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch (e) { /* display only */ }
})();
