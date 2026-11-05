/* MacUI 2.0.9.23: feat-20919-r23.js = feat-20919-r22.js (the HTF draft) + (1) the header reads 'TIDE warming up · n of N min' while the bot rebuilds (tide.warm, else
   tide.live false); (2) ONE Day P&L story in the header cell: the headline is the bot's broker day net (account.dayNet, else dayPnlNet), labelled; the TopstepX balance
   change is the second line only when it differs by more than $1, with a tap-through listing the broker round trips in the page's own sum; TIDE's closed net beside
   it. Never 'Old +$x'. (3) named UNKNOWNs. Mac 11/05. */
/* MacUI 2.0.9.22: feat-20919-r22.js = feat-20919-r21.js + the r1.5.6 HTF context: "HTF ↑/↓/—" at the end of the header line, the WITH / AGAINST HTF tag per armed level on Levels Now.
/* MacUI 2.0.9.21: feat-20919-r21.js = feat-20919-r2.js with the header's level distance in words ("37.25 above price", MacArthur 11/04), nothing else.
/* MacUI 2.0.9.19.2: v2src/feat-20919-r2.js = feat-20919.js (2.0.9.19.1) + (C) the header's mode pill and status line from TIDE while tide is shadow / live
   (mode, the position, the current hold, the next-to-act level or the 4H control; the old text stays with tide off) and (D) the Day P&L cell's
   TIDE / Old split (the Trades tab's numbers). Mac's 01:08-01:09 PT screenshots. 2.0.9.19 (MacUI-N, Nov 4). On top of 2.0.9.18 (feat-20918.js, unchanged):
   (1) LEVELS NOW in TIDE mode (sketch approved by MacArthur 11/04; Mac: "see how the bot is looking at the levels ... knowing what levels I can
       expect the bot to be trying to trade"): TIDE's own levels, the next one to act on first. Source: snapshot.tide.board (bot r1.3 / r1.4) when
       present; otherwise PHASE A from snapshot.tide.rows (setup_arm / retest / rejection / setup_cancel / setup_expire / grade_* / signal), with
       everything rows cannot carry shown as "needs bot r1.3". The state words and blockedBy codes are the contract's stable names.
   (2) THE POSITION CARD during a live TIDE trade (MacArthur ruling 3): while tide.mode is live and tide.position is not null, the Position card and
       the header's position cell read tide.position (fill, size, stop acked, TP1 / TP2, the bot's open $), source shown; the old path's FLAT is
       not shown as the position.
   Display only: no request, no write. With snapshot.tide absent or off nothing here touches the page. */
(function () {
  'use strict';
  const U = window.macui || (window.macui = {}), T18 = U.feat20918; if (!T18 || typeof T18.model !== 'function') return;
  const fin = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = v => fin(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN (not sent)';
  const sg2 = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  const usd = v => fin(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN (no $ sent)';
  const F = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const hm = t => fin(t) ? F.format(new Date(t)).slice(0, 5) : '—', hms = t => fin(t) ? F.format(new Date(t)) : '—';
  const $ = id => document.getElementById(id), DOT = ' · ';
  const snapNow = () => { try { return (typeof lastSnapForPoll !== 'undefined' && lastSnapForPoll) || (typeof pcSnap !== 'undefined' && pcSnap) || null; } catch (e) { return null; } };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* per-phone only */ } } };
  const arrow = d => d === 1 ? '▲' : d === -1 ? '▼' : '';
  // the contract's stable names (MacLevels' chart uses the same words / codes)
  const STATE = { armed: ['ARMED', 0], 'retest-pending': ['RETEST PENDING', 1], broken: ['BROKEN', 3], accepted: ['ACCEPTED', 3], failed: ['FAILED', 3], rejected: ['REJECTED', 4],
    watching: ['WATCHING', 5], unknown: ['UNKNOWN', 5], cancelled: ['CANCELLED', 6], expired: ['EXPIRED', 6], signalled: ['SIGNAL', 2], 'no-trade': ['NO TRADE', 4] };
  const CODE = { ROUND_NUMBER: 'round: context only', MID_RANGE: 'mid-range', TIME_BLOCK: 'time block', OPEN_WAIT: 'open wait', AGAINST_CONTROL: 'against control',
    ZONE_USED: 'zone used', FIRST_RETEST_USED: 'zone used', RETEST_NOT_FIRST: 'retest 2+', SESSION_CLOSE: 'session close', NEWS_WAIT: 'news wait' };
  const codeWord = c => CODE[c] || String(c || '').toLowerCase().replace(/_/g, ' ');
  const HARD = new Set(['ZONE_USED', 'FIRST_RETEST_USED', 'RETEST_NOT_FIRST', 'MID_RANGE', 'AGAINST_CONTROL', 'ROUND_NUMBER']);   // blocked for this break; time holds pass with the clock

  // ── Levels Now model ──
  function lvModel(d, now) {
    const T = d && d.tide && typeof d.tide === 'object' ? d.tide : null, M = T18.model(d, now);
    if (!M || M.partial || M.off || !T) return M && M.partial ? { partial: true, M } : null;
    const B = T.board && typeof T.board === 'object' && Array.isArray(T.board.levels) ? T.board : null;
    const lp = d.livePx && fin(d.livePx.price) ? d.livePx.price : null, price = B && fin(B.price) ? { v: B.price, src: 'tide.board.price' } : lp != null ? { v: lp, src: 'livePx' } : null;
    const L = { M, boardKey: 'board' in T, src: B ? 'board' : 'rows', price, rows: [], next: null, truncated: !!(B && B.truncated), at: B && fin(B.at) ? B.at : null };
    if (B) {
      const c = B.control && typeof B.control === 'object' ? B.control : null;
      L.control = c ? { dir: c.dir, kind: c.kind || null, since: fin(c.since) ? c.since : null, src: 'tide.board.control' } : null;   // MacUICheck 4: the board only
      L.O4 = fin(B.O4) ? B.O4 : null; L.range = B.range1h && typeof B.range1h === 'object' ? B.range1h : null;
      const groups = new Map();
      for (const x of B.levels) { if (!x || !fin(x.price)) continue;
        const st = STATE[x.state] ? x.state : 'unknown', codes = Array.isArray(x.blockedBy) ? x.blockedBy.filter(b => b && b.code) : [];
        const r = { name: String(x.name || 'level'), price: x.price, side: x.side || null, sideSrc: 'board', state: st, since: fin(x.since) ? x.since : null, dir: x.dir === 1 || x.dir === -1 ? x.dir : null,
          lane: x.lane || null, setup: x.setup || null, closesOut: fin(x.closesOut) ? x.closesOut : null, retestNo: fin(x.retestNo) ? x.retestNo : null, plan: x.plan && typeof x.plan === 'object' ? x.plan : null,
          codes, round: codes.some(b => b.code === 'ROUND_NUMBER'), targetOnly: x.targetOnly === true, group: x.group || null, members: [], src: 'tide.board' };
        if (r.group) { const g = groups.get(r.group); if (g) { g.all.push(r); continue; } r.all = [r]; groups.set(r.group, r); }
        L.rows.push(r); }
      for (const [, g] of groups) { const pv = price ? price.v : null, near = pv == null ? g : g.all.slice().sort((a, b) => Math.abs(a.price - pv) - Math.abs(b.price - pv))[0];
        if (near !== g) { const i = L.rows.indexOf(g); L.rows[i] = near; } near.members = g.all.filter(x => x !== near).map(x => x.name); }
    } else {
      L.control = M.ctl ? { dir: M.ctl.dir, kind: M.ctl.kind, since: M.ctl.t, src: 'journal control_form' } : null;
      L.O4 = M.period && fin(M.period.O4) ? M.period.O4 : null; L.range = null;
      const rows = Array.isArray(T.rows) ? T.rows.filter(r => r && fin(r.t)).slice().sort((a, b) => a.t - b.t) : [];
      const S = new Map();
      for (const r of rows) { const id = r.setup; if (!id) continue; let s = S.get(id); if (!s && r.phase !== 'setup_arm') continue; if (!s) { s = { arm: r }; S.set(id, s); }
        if (r.phase === 'setup_arm') { s.arm = r; s.end = null; } else if (r.phase === 'retest') s.retest = r; else if (r.phase === 'rejection') s.rej = r; else if (r.phase === 'signal') s.sig = r;
        else if (r.phase === 'setup_cancel' || r.phase === 'setup_expire' || r.phase === 'grade_no_trade') s.end = r; }
      for (const [id, s] of S) { const a = s.arm; if (!fin(a.level)) continue;
        const st = s.sig ? 'signalled' : s.end ? (s.end.phase === 'setup_cancel' ? 'cancelled' : s.end.phase === 'setup_expire' ? 'expired' : 'no-trade') : 'armed';
        if ((st === 'cancelled' || st === 'expired' || st === 'no-trade') && now - s.end.t > 2 * 3600000) continue;
        const p = s.sig && s.sig.plan || null;
        L.rows.push({ name: String(a.zone || 'level'), price: a.level, side: price ? (price.v > a.level ? 'above' : price.v < a.level ? 'below' : 'at') : null, sideSrc: 'derived from livePx', state: st,
          since: (s.sig || s.end || s.retest || a).t, dir: a.dir === 1 || a.dir === -1 ? a.dir : null, lane: a.kind || null, setup: id, retestNo: s.retest && fin(s.retest.n) ? s.retest.n : null,
          plan: p && !p.skip ? { entry: s.sig.entry, stop: p.stop, stopTf: p.stopTf, tp1: p.tp1 && p.tp1.price, tp2: p.tp2 && p.tp2.price, tp1Pool: p.tp1 && p.tp1.pool && p.tp1.pool.name, tp2Pool: p.tp2 && p.tp2.pool && p.tp2.pool.name, basis: 'signal' } : null,
          stopType: a.stopType || null, note: s.end ? (Array.isArray(s.end.why) ? s.end.why.join('; ') : s.end.why || '') : s.retest ? `retest #${s.retest.n || 1} seen ${hm(s.retest.t)}${fin(s.retest.wick) ? ' (wick ' + px(s.retest.wick) + ')' : ''}` : a.note || '',
          codes: [], round: false, targetOnly: false, members: [], src: `journal ${(s.sig || s.end || s.retest || a).phase} ${hm((s.sig || s.end || s.retest || a).t)}` }); }
    }
    for (const r of L.rows) { r.dist = price && fin(r.price) ? r.price - price.v : null; r.pri = STATE[r.state] ? STATE[r.state][1] : 5; }
    const ad = r => (fin(r.dist) ? Math.abs(r.dist) : 1e9);   // MacArthur ruling: the nearest UNBLOCKED armed / retest-pending level; no armed-first rule
    const act = L.rows.filter(r => (r.state === 'armed' || r.state === 'retest-pending') && !r.round && !r.targetOnly).sort((a, b) => ad(a) - ad(b));
    const free = act.filter(r => !r.codes.some(b => HARD.has(b.code))); L.next = free[0] || act[0] || null; L.nextBlocked = !!(L.next && !free.length);
    L.list = L.rows.filter(r => r !== L.next).sort((a, b) => ((ad(a) === 0 ? 0 : 1) - (ad(b) === 0 ? 0 : 1)) || (a.round - b.round) || (a.targetOnly - b.targetOnly) || a.pri - b.pri || ad(a) - ad(b));   // MacUICheck 9: a level at distance 0 first
    return L;
  }
  function planLine(r) {
    const p = r.plan;
    if (!p) return r.state === 'armed' || r.state === 'retest-pending' ? `<span class="fx19-dim">${r.stopType ? r.stopType + ' stop · ' : ''}entry, stop and TPs set at the signal</span>` : '';
    const ref = p.basis === 'reference' || p.plan === true;
    const tps = fin(p.tp1) || fin(p.tp2) ? `TP1 <b>${px(p.tp1)}</b>${p.tp1Pool ? ' <span class="fx19-dim">' + esc(p.tp1Pool) + '</span>' : ''} · TP2 <b>${px(p.tp2)}</b>${p.tp2Pool ? ' <span class="fx19-dim">' + esc(p.tp2Pool) + '</span>' : ''}` : '<span class="fx19-dim">TPs set at signal</span>';
    return ref ? `level <b>${px(p.entry)}</b> · stop ref <b>${px(p.stop)}</b>${p.stopTf ? ' <span class="fx19-dim">(' + esc(p.stopTf) + ')</span>' : ''}${fin(p.R) ? ' · ' + p.R + ' pts' : ''} · ${tps} <span class="fx19-ref">reference, not an order</span>`
      : `entry <b>${px(p.entry)}</b> · stop <b>${px(p.stop)}</b>${p.stopTf ? ' <span class="fx19-dim">(' + esc(p.stopTf) + ')</span>' : ''} · ${tps}`;
  }
  const stChip = r => `<span class="fx19-st" data-st="${esc(r.state)}">${esc(STATE[r.state] ? STATE[r.state][0] : String(r.state).toUpperCase())}</span>`;
  // r1.5.6 (2.0.9.22): the WITH / AGAINST HTF tag on an armed / retest-pending level, from its setup's rows (T18.model htfOf); nothing without the fields
  const htfChip = (L, r) => { try { const M = L && L.M, f = T18.htfTag; return r && r.setup && (r.state === 'armed' || r.state === 'retest-pending') && M && M.htfOf && typeof f === 'function' ? f(M.htfOf[r.setup]) : ''; } catch (e) { return ''; } };
  const distT = r => fin(r.dist) ? `<span class="fx19-d" data-s="${Math.sign(r.dist)}">${sg2(r.dist)}</span>` : '<span class="fx19-d">—</span>';
  function lvHTML(L) {
    const M = L.M, mode = M.mode;
    const head = `<div class="fx18-hd"><span class="fx18-t">LEVELS NOW</span><span class="fx19-sub">TIDE</span><span class="fx18-mode" data-mode="${mode.key}"><span class="fx18-mdot" aria-hidden="true"></span>${esc(mode.word)}</span><span class="fx18-time">${L.price ? px(L.price.v) : 'price UNKNOWN'}</span></div>`;
    const c = L.control, ctl = c ? `<div class="fx19-ctl" data-dir="${c.dir}">4H control <b>${arrow(c.dir)} ${c.dir === -1 ? 'SELLERS' : c.dir === 1 ? 'BUYERS' : 'UNKNOWN'}</b>${c.kind ? ' · ' + esc(c.kind) : ''}${fin(c.since) ? ' · since ' + hm(c.since) : ''}${fin(L.O4) ? ` · 4H open ${px(L.O4)}${L.price ? ' (' + sg2(L.O4 - L.price.v) + ')' : ''}` : ''}</div>`
      : `<div class="fx19-ctl">4H control: none read yet${fin(L.O4) ? ' · 4H open ' + px(L.O4) : ''}</div>`;
    const rg = L.range && fin(L.range.midLo) && fin(L.range.midHi) ? `<div class="fx19-rg">1H mid band ${px(L.range.midLo)}–${px(L.range.midHi)} <span class="fx19-dim">no entries inside</span></div>` : '';
    const n = L.next;
    const next = n ? `<div class="fx19-next" data-dir="${n.dir}" title="${esc(n.src)}"><div class="fx19-nh"><span class="fx18-k">NEXT TO ACT</span>${stChip(n)}${htfChip(L, n)}${n.plan && n.plan.basis === 'live' ? '<span class="fx19-st" data-st="signalled">IN TRADE</span>' : ''}${L.nextBlocked ? '<span class="fx19-st" data-st="failed">BLOCKED</span>' : ''}<span class="fx19-dim">${fin(n.since) ? hm(n.since) : ''}</span></div>`
        + `<div class="fx19-nl"><b>${arrow(n.dir)} ${esc(n.name)} ${px(n.price)}</b> ${distT(n)} <span class="fx19-dim">pts${n.side === 'above' || n.side === 'below' ? DOT + 'price ' + n.side + ' the level' + (n.sideSrc !== 'board' ? ' (derived)' : '') : ''}${n.lane ? DOT + esc(n.lane) : ''}${fin(n.retestNo) && n.retestNo > 0 ? DOT + 'retest ' + n.retestNo : ''}</span></div>`
        + (n.members.length ? `<div class="fx19-mem">with ${n.members.map(esc).join(', ')}</div>` : '') + (n.note ? `<div class="fx19-dim">${esc(n.note)}</div>` : '')
        + `<div class="fx19-pl">${planLine(n)}</div>` + (n.codes.length ? `<div class="fx19-why">${n.codes.map(b => `<span class="fx19-b" title="${esc(b.text || b.code)}">${esc(codeWord(b.code))}</span>`).join('')}</div>` : '') + '</div>'
      : `<div class="fx19-next is-none"><span class="fx18-k">NEXT TO ACT</span> nothing armed${L.src === 'rows' ? ' (journal rows)' : ''}</div>`;
    const SHOW = 9, list = L.list, row = r => `<li class="fx19-r${r.round ? ' is-round' : ''}${r.targetOnly ? ' is-tgt' : ''}" data-st="${esc(r.state)}" title="${esc(r.src)}"><span class="fx19-nm">${arrow(r.dir)} ${esc(r.name)} <span class="fx19-px">${px(r.price)}</span>${r.members.length ? ' <span class="fx19-dim">+' + r.members.length + '</span>' : ''}</span>${distT(r)}${stChip(r)}${htfChip(L, r)}${r.targetOnly || r.codes.length || r.note ? `<span class="fx19-wy">${r.targetOnly ? 'targets only' : r.codes.length ? r.codes.map(b => esc(codeWord(b.code))).join(' · ') : esc(r.note)}</span>` : ''}</li>`;
    const ul = list.length ? `<ol class="fx19-list" aria-label="TIDE levels, nearest to acting first">${list.slice(0, SHOW).map(row).join('')}</ol>` + (list.length > SHOW ? `<details class="fx19-more"><summary>${list.length - SHOW} more levels</summary><ol class="fx19-list">${list.slice(SHOW).map(row).join('')}</ol></details>` : '') : '';
    const foot = L.src === 'board' ? `<div class="fx19-src">source: tide.board${L.at ? ' at ' + hms(L.at) : ''}${L.truncated ? ' · more levels not shown (30-level cap)' : ''}</div>`
      : `<div class="fx19-src">source: tide.rows (journal) · <span class="fx19-need">${L.boardKey ? 'board not in this snapshot' : 'untouched levels, broken / accepted / failed, mid-range and round-number flags: needs bot r1.3'}</span></div>`;
    const old = `<button type="button" class="fx18-oldb" data-fx19-old="1" aria-controls="lv-dash-card" aria-expanded="${store.get('fx19-oldlv') === '1'}">${store.get('fx19-oldlv') === '1' ? 'Hide' : 'Show'} the old Levels now card</button>`;
    return head + ctl + rg + next + ul + foot + old;
  }
  function lvPartialHTML(M) { return `<div class="fx18-hd"><span class="fx18-t">LEVELS NOW</span><span class="fx19-sub">TIDE</span><span class="fx18-mode" data-mode="${M.mode.key}"><span class="fx18-mdot" aria-hidden="true"></span>${esc(M.mode.word)}</span></div><div class="fx18-need"><b>TIDE details need bot update.</b> TIDE's levels read UNKNOWN until the bot puts TIDE in its snapshot.</div><button type="button" class="fx18-oldb" data-fx19-old="1" aria-controls="lv-dash-card" aria-expanded="${store.get('fx19-oldlv') === '1'}">${store.get('fx19-oldlv') === '1' ? 'Hide' : 'Show'} the old Levels now card</button>`; }

  // ── the TIDE position as THE Position card ──
  // MacUICheck .19 (1, 2, 7, 11, 12, 13): take over only with contracts open (open > 0, not REVERSED); staleness exactly as the page's own card
  // (PC_STALE_MS, "stale hh:mm:ss", "last known"); Pts and $ on the same base (the last price); the page's pointValueFor; the day row and the
  // risk-vs-cap bar kept; "Unrealized" only with a value. PENDING: a labelled "TIDE entry working, not filled" line above the page's own card.
  const G = n => { try { if (typeof window[n] !== 'undefined') return window[n]; return (0, eval)('typeof ' + n + " !== 'undefined' ? " + n + ' : undefined'); } catch (e) { return undefined; } };
  function tideP(d) {
    const T = d && d.tide; if (!T || typeof T !== 'object') return null;
    const M = T18.model(d, Date.now()); if (!M || M.partial || !M.position || M.mode.key !== 'live') return null;
    return { P: M.position, M };
  }
  function livePos(d) { const x = tideP(d); return x && fin(x.P.open) && x.P.open > 0 && String(x.P.phase).toUpperCase() !== 'REVERSED' ? x : null; }
  function pvOf(d) { const f = G('pointValueFor'), sym = String((d && d.symbol) || G('SYMBOL') || ''); try { const v = typeof f === 'function' ? f(sym) : null; return fin(v) ? { v, src: 'pointValueFor(' + sym + ')' } : null; } catch (e) { return null; } }
  function staleOf(d, now) { const ms = fin(G('PC_STALE_MS')) ? G('PC_STALE_MS') : 60000, upd = d && fin(d.updated) ? d.updated : null; return { stale: upd == null || now - upd > ms, upd }; }
  function posHTML(d, x, now) {
    const P = x.P, dir = P.dir, st = staleOf(d, now), hmsF = G('pcHms');
    const chip = st.stale ? `<span class="pc-chip stale"><i></i>stale ${st.upd != null ? esc(typeof hmsF === 'function' ? hmsF(st.upd) : hms(st.upd)) : '--:--:--'}</span>` : `<span class="pc-chip fx19-chip"><i></i>TIDE live · ${Math.max(0, Math.round((now - st.upd) / 1000))}s</span>`;
    const lp = fin(P.lastPx) ? { v: P.lastPx, src: 'tide.position.lastPx' } : d.livePx && fin(d.livePx.price) ? { v: d.livePx.price, src: 'livePx' } : null;
    const ent = fin(P.avgEntry) ? P.avgEntry : null, pts = lp && ent != null ? dir * (lp.v - ent) : null, pvx = pvOf(d), pv = pvx ? pvx.v : null, n = P.open;
    const $o = fin(P.openUsd) ? { v: P.openUsd, src: 'bot' } : pts != null && pv ? { v: pts * n * pv, src: 'calc' } : null;
    const cls = v => fin(v) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';
    const stop = fin(P.stopAcked) ? P.stopAcked : null;
    const lv = (nm, c, p) => { if (!fin(p)) return ''; const dp = lp ? dir * (p - lp.v) : null, du = dp != null && pv ? dp * n * pv : null;   // the old card's base: from the last price
      return `<div class="n ${c}">${nm}</div><div class="px pc-num">${p.toFixed(2)}</div><div class="pc-num ${cls(dp)}">${dp != null ? sg2(dp) : '—'}</div><div class="pc-num ${cls(du)}">${du != null ? usd(du) : '—'}</div>`; };
    // risk to stop vs the TIDE per-trade dollars (tide.sizing.flatUsd), else the page's own cap
    const T = d.tide || {}, z = T.sizing || {}, r = d.risk || (d.controls && d.controls.risk), capD = G('PC_RISK_CAP_DEFAULT');
    const cap = fin(z.flatUsd) && z.flatUsd > 0 ? z.flatUsd : r && r.on && fin(r.cap) && r.cap > 0 ? r.cap : fin(capD) ? capD : 250, capSrc = fin(z.flatUsd) && z.flatUsd > 0 ? 'TIDE $ per trade' : 'cap';
    const atStop = stop != null && ent != null && pv ? dir * (stop - ent) * n * pv : null;
    let risk;
    if (atStop == null) risk = `<div class="pc-risk"><div class="pc-risk-top"><span>Risk to stop</span><b class="pc-num">— <span>of $${cap.toFixed(0)} ${capSrc}</span></b></div><div class="pc-bar"><i style="width:0%"></i></div></div>`;
    else if (atStop >= -0.005) risk = `<div class="pc-risk"><div class="pc-risk-top"><span>Stop locks in</span><b class="pc-num pos">${usd(atStop)} <span>no risk left</span></b></div><div class="pc-bar locked"><i style="width:100%"></i></div></div>`;
    else { const fr = Math.min(1, -atStop / cap), over = -atStop > cap + 0.005;
      risk = `<div class="pc-risk"><div class="pc-risk-top"><span>Risk to stop${over ? ' · OVER' : ''}</span><b class="pc-num neg">${usd(atStop)} <span>of $${cap.toFixed(0)} ${capSrc}</span></b></div><div class="pc-bar${over ? ' over' : ''}" role="img" aria-label="risk ${Math.round(fr * 100)}% of the TIDE dollars"><i style="width:${(fr * 100).toFixed(1)}%"></i></div></div>`; }
    let day = ''; try { const dh = G('pcDayHtml'), dpn = G('pcDayPnl'); if (typeof dh === 'function' && typeof dpn === 'function') day = dh(dpn(d, now)) || ''; } catch (e) { day = ''; }
    const stopW = P.stopBy === 'be' ? 'BE+1' : P.stopBy === 'ladder' ? 'ladder' : P.stopBy === 'structural' ? 'structural' : null;
    return { tone: dir === 1 ? 'long' : 'short', stale: st.stale, html: `<div class="pc-top"><span>Position and risk</span>${chip}</div>`
      + `<div class="pc-head"><div><div class="pc-side">${dir === 1 ? '▲ LONG' : '▼ SHORT'}</div><div class="pc-sub pc-num"><b>${n}</b> ct @ <b>${ent != null ? ent.toFixed(2) : 'UNKNOWN'}</b> <span class="pc-ref" title="tide.position.avgEntry (the broker fill average the TIDE driver recorded)">fill</span>${st.stale ? ' · last known' : ''}</div></div>`
      + `<div class="pc-unreal" aria-live="polite">${$o ? `<div class="pc-lbl">Unrealized${$o.src === 'calc' ? ' (calc)' : ' (bot)'}${st.stale ? ' · last known' : ''}</div><b class="pc-num ${cls($o.v)}">${usd($o.v)}</b>` : '<div class="pc-lbl">Open $</div><b class="pc-num">UNKNOWN</b>'}<span class="pc-num ${cls(pts)}">${pts != null ? sg2(pts) + ' pts vs fill' : 'pts UNKNOWN'}</span></div></div>`
      + `<div class="fx11-mg fx19-mg"><div class="fx11-mg-h"><span class="fx11-mg-tag">TIDE IS MANAGING</span><span class="fx11-mg-ph">${esc(P.grade || '')}${fin(P.points) ? ' ' + P.points + '/5' : ''} · ${esc(String(P.phase || '').toLowerCase())} · ${P.tp1Done ? 'after TP1' : 'before TP1'}</span></div>`
      + `<div class="fx11-mg-g"><div><span>Fill</span><b class="pc-num">${ent != null ? px(ent) : 'UNKNOWN'}</b></div><div><span>Stop ${stop != null ? '✓ acked' : 'NOT acked'}</span><b class="pc-num neg">${stop != null ? px(stop) : fin(P.stopAsked) ? 'asked ' + px(P.stopAsked) : 'UNKNOWN'}</b></div><div><span>TP1${P.tp1Done ? ' ✓' : ''}</span><b class="pc-num pos">${px(P.tp1Px)}</b></div></div>`
      + `<div class="fx11-mg-l"><b>Stop </b>${stopW ? stopW + (fin(P.structuralStop) && P.stopBy !== 'structural' ? ' (structural was ' + px(P.structuralStop) + ')' : '') : 'UNKNOWN'}</div><div class="fx11-mg-l"><b>Fill time </b>${fin(P.fillAt) ? hms(P.fillAt) + ' PT' : 'UNKNOWN'}${fin(P.filledQty) && fin(P.plannedQty) ? DOT + P.filledQty + ' / ' + P.plannedQty + ' filled' : ''}</div></div>`
      + `<div class="pc-lvls"><div class="h hl" style="text-align:left">Level</div><div class="h">Price</div><div class="h">Pts</div><div class="h">$ ×${n}</div>${lv('STOP', 'stop', stop)}${lv('TP1', 'target', P.tp1Done ? null : P.tp1Px)}${lv('TP2', 'target', P.tp2Px)}</div>`
      + risk + `<div class="pc-meta"><span>${lp ? 'Pts and $ from the last price' : 'last price UNKNOWN'}</span><span class="r pc-num">${lp ? 'last ' + lp.v.toFixed(2) : ''}</span></div>` + day
      + `<div class="fx19-src">source: tide.position (${esc(P.id || '')}) · $: ${$o ? ($o.src === 'bot' ? 'the bot (tide.position.openUsd)' : 'calc, ' + esc(pvx.src)) : 'UNKNOWN'} · the old path is FLAT while TIDE holds this trade</div>` };
  }
  { const _pc = window.posCardHtml; if (typeof _pc === 'function') window.posCardHtml = function (d, now) { const t = fin(now) ? now : Date.now();
      try { const x = livePos(d); if (x) return posHTML(d, x, t);
        const y = tideP(d); if (y && String(y.P.phase).toUpperCase() === 'PENDING') { const r = _pc.apply(this, arguments); if (r && typeof r.html === 'string') r.html = `<div class="fx19-pend" role="status">TIDE entry working, not filled${fin(y.P.plannedQty) ? ' · ' + y.P.plannedQty + ' MNQ planned' : ''} <span class="fx19-dim">(tide.position ${esc(y.P.phase)})</span></div>` + r.html; return r; }
      } catch (e) { /* display only */ } return _pc.apply(this, arguments); }; }
  // the header's position cell: its own element while a TIDE position is live (the page's own cell stays, hidden)
  let gcell = null;
  function header(d) {
    const cell = $('g-pos-cell'); if (!cell) return; const x = d ? livePos(d) : null;
    if (!x) { if (cell.hasAttribute('data-fx19')) cell.removeAttribute('data-fx19'); return; }
    if (!gcell) { gcell = document.createElement('div'); gcell.className = 'fx19-gpos'; gcell.setAttribute('aria-live', 'polite'); cell.appendChild(gcell); }
    const P = x.P, st = staleOf(d, Date.now()), u = fin(P.openUsd) ? P.openUsd : null;
    const h = `<div class="g-val">${P.dir === 1 ? '▲ LONG' : '▼ SHORT'} ${P.open}</div><div class="g-sub">${st.stale ? '<span class="g-lk">Last known:</span> ' : ''}${u != null ? `<b class="${u > 0 ? 'pos' : u < 0 ? 'neg' : ''}">${usd(u)}</b> TIDE open (bot)` : 'TIDE · open $ UNKNOWN'}</div>`;
    if (gcell.__h !== h) { gcell.innerHTML = h; gcell.__h = h; } if (cell.getAttribute('data-fx19') !== 'tide') cell.setAttribute('data-fx19', 'tide');
  }

  // (C) the header pill + status line, (D) the Day P&L split: own elements beside the page's (hidden by CSS while TIDE is on), so the page's
  // own renderer keeps running unchanged and comes back the moment tide is off / absent.
  let hTag = null, hWhy = null, hDay = null;
  function tideHeaderModel(d, now) {
    const M = T18.model(d, now); if (!M) return null;
    const pill = 'TIDE ' + M.mode.word;
    if (M.partial) return { M, pill, why: '<b>TIDE ' + esc(M.mode.word) + '.</b> TIDE details need bot update', day: null };
    let why;
    const x = livePos(d);
    if (M.warm) { const w = M.warm; why = `<b>TIDE warming up</b> · ${fin(w.done) && fin(w.total) ? `${w.done} of ${w.total} min` : fin(w.startedAt) ? 'started ' + hm(w.startedAt) : 'rebuilding the 6-hour book (no counter in r1.5.6)'}${fin(w.startedAt) && fin(w.done) ? ' · started ' + hm(w.startedAt) : ''} · no live signal until done`; }
    else if (x) why = `<b>TIDE ${esc(x.P.dir === 1 ? 'LONG' : 'SHORT')} ${x.P.open}</b> · ${x.P.tp1Done ? 'after TP1' : 'TP1 next'}${fin(x.P.openUsd) ? ' · ' + usd(x.P.openUsd) + ' open' : ''}`;
    else {
      let hold = null; try { const C = T18.clModel(M, d, now); hold = C.rules.find(r => r.s === 'hold'); } catch (e) { hold = null; }
      const L = lvModel(d, now), n = L && !L.partial ? L.next : null;
      const ctl = L && !L.partial && L.control ? `4H ${L.control.dir === -1 ? '▼ sellers' : L.control.dir === 1 ? '▲ buyers' : 'control ?'}` : M.ctl ? `4H ${M.ctl.dir === -1 ? '▼ sellers' : '▲ buyers'}` : '4H control: none';
      if (hold) why = `<b>TIDE holding:</b> ${esc(hold.w)} · ${esc(hold.why)}`;
      else if (n) why = `<b>TIDE watching</b> ${arrow(n.dir)} ${esc(n.name)} ${px(n.price)}${fin(n.dist) ? ' · ' + px(Math.abs(n.dist)) + (n.dist > 0 ? ' above price' : n.dist < 0 ? ' below price' : ' at price') : ''} · ${esc(STATE[n.state] ? STATE[n.state][0] : n.state)}${L.nextBlocked ? ' · blocked' : ''} · ${ctl}`;
      else why = `<b>TIDE scanning.</b> ${ctl} · no setup armed now`;
      const h = d.tide && d.tide.board && d.tide.board.htf; if (h && typeof h === 'object' && fin(h.dir)) why += ` · HTF ${h.dir === 1 ? '↑' : h.dir === -1 ? '↓' : '—'}`;   // r1.5.6 (2.0.9.22)
    }
    return { M, pill, why, day: dayStory(M, d) };
  }
  // 2.0.9.23 (Mac 11/05: 'The top-right P&L is incorrect'): ONE story. Headline = the bot's broker day net (r1.6 account.dayNet, else dayPnlNet: the sum of every
  // closed round trip's broker net). Second line only when another figure differs by more than $1: the TopstepX balance change (account.balanceDelta, else
  // day.rolling) and the page's own sum of the broker round trips it holds (recentTrades, the last 10). TIDE's closed net is named apart. Tap: the trips in the page's sum.
  function dayStory(M, d) {
    if (!M || !M.day) return null; const A = M.acct, net = A && fin(A.dayNet) ? { v: A.dayNet, src: 'account.dayNet' } : fin(d.dayPnlNet) ? { v: d.dayPnlNet, src: 'dayPnlNet' } : fin(d.dayPnlAllFills) ? { v: d.dayPnlAllFills, src: 'dayPnlAllFills' } : null;
    const delta = A && fin(A.balanceDelta) ? A.balanceDelta : d.day && fin(d.day.rolling) ? d.day.rolling : null;
    let pageSum = null, trips = []; try { const R = T18.acctRows ? T18.acctRows(M) : null; if (R && !R.src.startsWith('account')) { trips = R.rows; if (trips.length && trips.every(r => fin(r.usd))) pageSum = Math.round(trips.reduce((a, r) => a + r.usd, 0) * 100) / 100; } } catch (e) { pageSum = null; }
    const closedN = A && fin(A.closedTrades) ? A.closedTrades : d.dayTrips && fin(d.dayTrips.n) ? d.dayTrips.n : trips.length || null;
    const lines = [];
    if (net && delta != null && Math.abs(delta - net.v) > 1) lines.push(`balance ${usd(delta)} · differs by ${usd(delta - net.v)}`);
    if (net && pageSum != null && Math.abs(pageSum - net.v) > 1) lines.push(`page sum of the ${trips.length} closed round trips it holds ${usd(pageSum)}, differs by ${usd(pageSum - net.v)}${d.recentTrades && d.recentTrades.length >= 10 ? ' (the list is the last 10 trips)' : ''}`);
    return { v: net ? net.v : null, src: net ? net.src : null, sub: net ? `MacMillionz Bot · Day P&L · closed trades only${closedN != null ? ` · ${closedN} ${closedN === 1 ? 'trade' : 'trades'}` : ''}` : 'MacMillionz Bot · Day P&L · UNKNOWN: no dayPnlNet / account.dayNet in the snapshot', lines, trips, pageSum };
  }
  function tideHeader(d) {
    const now = Date.now(), H = d ? tideHeaderModel(d, now) : null, id = $('g-id'), bn = $('g-banner'), dc = $('g-day-cell');
    if (!H) { for (const e of [id, bn, dc]) if (e && e.hasAttribute('data-fx192')) e.removeAttribute('data-fx192'); if (dc && dc.hasAttribute('data-fx23day')) dc.removeAttribute('data-fx23day'); return; }
    if (id && !hTag) { hTag = document.createElement('span'); hTag.className = 'tag fx19-tag'; hTag.title = 'TIDE mode (snapshot tide.mode)'; id.appendChild(hTag); }
    if (bn && !hWhy) { hWhy = document.createElement('span'); hWhy.className = 'g-why fx19-why'; hWhy.setAttribute('aria-live', 'polite'); const w = $('g-why'); if (w) w.after(hWhy); else bn.appendChild(hWhy); }
    if (dc && !hDay) { hDay = document.createElement('div'); hDay.className = 'g-sub fx19-daysplit'; dc.appendChild(hDay); }
    if (hTag && hTag.textContent !== H.pill) { hTag.textContent = H.pill; hTag.dataset.mode = H.M.mode.key; }
    if (hWhy && hWhy.__h !== H.why) { hWhy.innerHTML = H.why; hWhy.__h = H.why; }
    if (hDay) { const D = H.day; if (!D) { hDay.hidden = true; } else { const cls = D.v > 0 ? 'pos' : D.v < 0 ? 'neg' : '';
        const h = `<div class="g-val fx23-dayv ${cls}" title="${esc(D.src || 'no day net in the snapshot')}">${D.v != null ? usd(D.v) : 'UNKNOWN'}</div><div class="g-sub fx23-days">${esc(D.sub)}</div>${D.lines.map(l => `<div class="g-sub fx23-dayl">${esc(l)}</div>`).join('')}`
          + (D.lines.length && D.trips.length ? `<details class="fx23-daydet"><summary>which trips are in the page's sum</summary>${D.trips.slice().sort((a, b) => b.t - a.t).map(r => `<div>${hm(r.t)} ${esc(r.side)}${r.qty != null ? ' ' + r.qty : ''}${r.price != null ? ' @ ' + px(r.price) : ''} · ${fin(r.usd) ? usd(r.usd) : 'net not in the list'}</div>`).join('')}<div>the bot's ${esc(D.src || 'day net')} counts every closed round trip of the TradeDay; the page holds the last 10</div></details>` : '');
        if (hDay.__h !== h) { hDay.innerHTML = h; hDay.__h = h; } hDay.hidden = false; } }
    for (const e of [id, bn, dc]) if (e && e.getAttribute('data-fx192') !== 'tide') e.setAttribute('data-fx192', 'tide');
    if (dc) { const one = !!(H.day); if ((dc.getAttribute('data-fx23day') === '1') !== one) { if (one) dc.setAttribute('data-fx23day', '1'); else dc.removeAttribute('data-fx23day'); } }
  }

  // ── mount / update ──
  let lvc = null; const last = {}; const perf = { updates: 0, updateMax: 0, longTasks: 0 };
  function render(d) {
    const t0 = performance.now(), L = d ? lvModel(d, Date.now()) : null, v = $('view-dashboard');
    try { tideHeader(d); } catch (e) { /* display only */ }
    try { header(d); const vd = $('view-dashboard'), lp = d ? livePos(d) : null; if (vd) { if (lp) { if (vd.getAttribute('data-fx19pos') !== '1') vd.setAttribute('data-fx19pos', '1'); } else if (vd.hasAttribute('data-fx19pos')) vd.removeAttribute('data-fx19pos'); } } catch (e) { /* display only */ }
    if (!L) { if (lvc) { lvc.hidden = true; if (v) v.removeAttribute('data-fx19lv'); } U.feat20919.last = null; return; }
    if (!lvc) { const anchor = $('lv-dash-card'); if (!anchor || !anchor.parentNode) return; lvc = document.createElement('section'); lvc.id = 'fx19-lv'; lvc.className = 'card fx18 fx19-lv'; lvc.setAttribute('aria-label', "Levels now: TIDE's levels, the next one to act on first"); lvc.setAttribute('aria-live', 'polite'); anchor.before(lvc); }
    lvc.hidden = false; lvc.dataset.mode = L.partial ? L.M.mode.key : L.M.mode.key;
    const h = L.partial ? lvPartialHTML(L.M) : lvHTML(L); if (last.lv !== h) { lvc.innerHTML = h; last.lv = h; }
    const want = L.partial || store.get('fx19-oldlv') === '1' ? 'both' : 'tide'; if (v && v.getAttribute('data-fx19lv') !== want) v.setAttribute('data-fx19lv', want);   // MacUICheck 3: partial keeps the old card
    const dt = performance.now() - t0; perf.updates++; if (dt > perf.updateMax) perf.updateMax = dt; if (dt > 50) perf.longTasks++;
    U.feat20919.last = L.partial ? { partial: true } : { src: L.src, next: L.next ? `${L.next.name} ${L.next.state}${L.next.members.length ? ' +' + L.next.members.join('+') : ''}` : null, n: L.rows.length, list: L.list.slice(0, 12).map(r => `${r.name} ${r.state}${r.codes.length ? ' [' + r.codes.map(b => b.code).join(',') + ']' : ''}`) };
  }
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-fx19-old]'); if (b) { store.set('fx19-oldlv', store.get('fx19-oldlv') === '1' ? '0' : '1'); last.lv = null; render(snapNow()); } });
  U.pageVersion = '2.0.9.19.2';   // the ONE page-version source (exports read it; MacJournal 11/04)
  U.feat20919 = { release: '2.0.9.23', lvModel, livePos, dayStory, tideHeaderModel, perf, update: () => render(snapNow()), last: null };
  const _w = window.renderWhyNoTrade;
  if (typeof _w === 'function') window.renderWhyNoTrade = function (d) { const r = _w.apply(this, arguments); try { render(d || snapNow()); } catch (e) { /* display only */ } return r; };
  const _rh = window.renderHeartbeat;
  if (typeof _rh === 'function') window.renderHeartbeat = function () { const r = _rh.apply(this, arguments); try { if (lvc || gcell || hTag) render(snapNow()); } catch (e) { /* display only */ } return r; };
  try { const d = snapNow(); if (d) render(d); } catch (e) { /* display only */ }
})();
