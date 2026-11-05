/* MacUI 2.0.9.23: v2src/feat-20923.js (MacUI-A, Nov 5). Mac: "The mobile terminal has too many lagging differences, missing replays, undetermined statuses ...
   I need everything aligned together correctly!" and "Make sure to make this hour wave section more useful". Display only: no request, no write, no timer of
   its own (the page's own 1 s heartbeat and poll drive it). Four parts, every one active ONLY while snapshot.tide is shadow / live; with TIDE off / absent
   nothing here touches the page (identity):
   (1) THE TREND LANE decision card in the Hour card's slot: the verdict line (STAND DOWN / WAIT / GET READY / ACT + its one reason) always first, then Mac's
       three steps, each a state chip + one line of evidence + its time: STEP 1 DIRECTIONAL STRUCTURE (tide.board.htf: the 4H opening control level, the
       previous 4H candle's close, structure established or no direction), STEP 2 30M HARMONY (the r1.6 trend rows' 30M fields; until the bot sends them the
       row says so), STEP 3 5M EXECUTION (trend_arm / trend_signal / trend_skip rows: at <level> <price> rejected / broke through, 5m close, taken or skipped
       with its why; watching <nearest level> while waiting). One small line: next 5m close, re-entries used this hour / today, climax. Every number comes
       from a bot field (board.htf, board.control, board.levels, the trend_* rows, tide.rules.trendLane); the page infers nothing from candles. The Hour
       card's own content (the three mini candles, the type chips, the FLIP line, the hour strip) folds, byte for byte, under "Candle detail", closed.
   (2) Review ("TIDE · the day"): the trend lane's counts (tide.day, the bot's whole day file, else the ring), the newest live signal with its why under the
       Signals count, the warm-up state instead of "no control read today", and the money line that never reads $0.00 as if nothing happened: with 0 TIDE
       trades closed it says so and names the account day net beside it. A Replay button on every closed TIDE trade card (Trades tab rows too).
   (3) Sessions today (Now): the orange "split is missing trades" warning becomes a plain line naming the account trades the bot did not place (r1.6
       account.fills by session: n bot · n manual).
   (4) U.feat20923.laneState(d, M): the lane's one-line state for the Levels card's "TIDE scanning" line (feat-20920-r23). */
(function () {
  'use strict';
  const U = window.macui || (window.macui = {}), T18 = U.feat20918; if (!T18 || typeof T18.model !== 'function') return;
  const fin = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = v => fin(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN (not sent)';
  const usd = v => fin(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'UNKNOWN (no $ sent)';
  const sg2 = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  const F = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const hm = t => fin(t) ? F.format(new Date(t)).slice(0, 5) : '—';
  const PTF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ptSec = t => { const o = {}; for (const x of PTF.formatToParts(new Date(t))) o[x.type] = x.value; return (+o.hour % 24) * 3600 + +o.minute * 60 + +o.second; };
  const mmss = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const $ = id => document.getElementById(id), DOT = ' · ';
  const snapNow = () => { try { return (typeof lastSnapForPoll !== 'undefined' && lastSnapForPoll) || (typeof pcSnap !== 'undefined' && pcSnap) || null; } catch (e) { return null; } };
  const modeKey = d => T18.modeInfo(d.tide.mode).key;
  const tideless = d => !d || typeof d !== 'object' || !d.tide || typeof d.tide !== 'object' || modeKey(d) === 'off';
  function tideOn(d) { if (tideless(d)) return null; const M = T18.model(d, Date.now()); return M && !M.partial && !M.off && (M.mode.key === 'shadow' || M.mode.key === 'live') ? M : null; }
  const rowsOf = () => { const mo = T18.rowsMemo; return mo && mo.map ? [...mo.map.values()].sort((a, b) => a.t - b.t) : []; };
  const TREND = /^trend_(arm|signal|skip|idle|tie)$/;
  const arrow = d => d === 1 ? '▲' : d === -1 ? '▼' : '—';
  const bb = d => d === 1 ? 'BULLISH' : d === -1 ? 'BEARISH' : 'FLAT';
  const dayOf = (() => { const DF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); return t => { const o = {}; for (const x of DF.formatToParts(new Date(t))) o[x.type] = x.value; return `${o.year}-${o.month}-${o.day}${+o.hour >= 15 ? '+' : ''}`; }; })();

  // ── (1) the lane model: Mac's three steps, every value from a bot field ──
  function laneModel(d, M, now) {
    const T = d.tide, B = T.board && typeof T.board === 'object' ? T.board : null, H = B && B.htf && typeof B.htf === 'object' ? B.htf : null;
    const price = B && fin(B.price) ? B.price : d.livePx && fin(d.livePx.price) ? d.livePx.price : null;
    const rows = rowsOf().filter(r => r && TREND.test(String(r.phase)) && r.rebuilt !== true), laneOn = rows.length > 0 || !!(T.rules && T.rules.trendLane && T.rules.trendLane.enabled !== false && /r2\.[7-9]|r[3-9]\./.test(String(T.version || '')));
    const last = rows[rows.length - 1] || null, lastOf = ph => rows.filter(r => r.phase === ph).pop() || null;
    const arm = lastOf('trend_arm'), sig = lastOf('trend_signal'), skip = lastOf('trend_skip'), idle = lastOf('trend_idle');
    const L = { laneOn, rows, price, now, steps: [], verdict: null, small: '' };
    // STEP 1 · DIRECTIONAL STRUCTURE (tide.board.htf; the 4H opening control level = cur4h.o = board.O4)
    { const o4 = H && H.cur4h && fin(H.cur4h.o) ? H.cur4h.o : B && fin(B.O4) ? B.O4 : null, prev = H && H.prev4h && fin(H.prev4h.dir) ? H.prev4h.dir : null, dir = H && fin(H.dir) ? H.dir : null;
      const c = B && B.control && typeof B.control === 'object' && (B.control.dir === 1 || B.control.dir === -1) ? B.control : null;
      let chip, text, tone;
      if (dir == null && !c) { chip = 'NOT SENT'; tone = 'na'; text = o4 != null ? `4H opening control level ${px(o4)} · direction: not in this snapshot (board.htf)` : 'board.htf is not in this snapshot: this bot build sends no 4H structure read'; }
      else { const dd = dir != null ? dir : c.dir; chip = dd === 0 ? 'NO DIRECTION' : `STRUCTURE ${arrow(dd)}`; tone = dd === 0 ? 'na' : dd === 1 ? 'up' : 'dn';
        const rel = o4 != null && price != null ? `price ${Math.abs(price - o4).toFixed(2)} ${price > o4 ? 'above' : price < o4 ? 'below' : 'at'} the 4H control ${px(o4)}` : o4 != null ? `4H control ${px(o4)}` : '4H open not in the snapshot';
        text = `${rel}${prev != null ? DOT + 'previous 4H closed ' + bb(prev) + (H.prev4h.hh && !H.prev4h.ll ? ' (HH)' : H.prev4h.ll && !H.prev4h.hh ? ' (LL)' : '') : ''}${dd === 0 ? DOT + 'no direction: the 4H votes are neutral' : DOT + 'structure established' + (c && c.kind ? ' · ' + c.kind : '')}`; }
      L.steps.push({ n: 1, k: 'DIRECTIONAL STRUCTURE', chip, tone, text, time: c && fin(c.since) ? 'since ' + hm(c.since) : B && fin(B.at) ? hm(B.at) : '', src: 'tide.board.htf / board.control' }); L.dir = dir != null ? dir : c ? c.dir : null; L.o4 = o4; }
    // STEP 2 · 30M HARMONY (r1.6 trend rows: m30 { open, side, prevDir | prevBody, at }; the WIP build reads the 1H instead; else the rule is not in this build)
    { const src = sig && sig.t >= (arm ? arm.t : 0) ? sig : arm || skip || idle, m30 = src && (src.m30 || src.h30 || src.harmony30), h1 = src && src.h1, why = idle ? String(idle.why || '') : '';
      let chip, text, tone, time = src ? hm(src.t) : '';
      if (!laneOn) { chip = 'NOT IN THIS BUILD'; tone = 'na'; text = "the bot's trend lane is not in this build (r1.6)"; }
      else if (m30 && typeof m30 === 'object') { const o = fin(m30.open) ? m30.open : fin(m30.open30) ? m30.open30 : null, pd = fin(m30.prevDir) ? m30.prevDir : fin(m30.prevBody) ? Math.sign(m30.prevBody) : null, al = m30.aligned === true || (m30.side != null && L.dir != null && m30.side === L.dir && !m30.counter);
        chip = al ? 'ALIGNED' : 'NOT ALIGNED'; tone = al ? (L.dir === 1 ? 'up' : 'dn') : 'na';
        text = `30M open ${o != null ? px(o) : 'not sent'}${m30.at ? ' (' + String(m30.at).slice(-5) + ')' : ''}${pd != null ? DOT + 'last 30M closed ' + bb(pd) : ''}${price != null && o != null ? DOT + 'price ' + (price > o ? 'above' : price < o ? 'below' : 'at') + ' it' : ''}${al ? '' : DOT + 'no alignment = no trade'}`; }
      else if (/30M not in harmony/i.test(why)) { chip = 'NOT ALIGNED'; tone = 'na'; text = why.replace(/^HARMONY:\s*/i, '') + DOT + 'no alignment = no trade'; time = hm(idle.t); }
      else if (h1 && typeof h1 === 'object') { const al = fin(h1.side) && L.dir != null && h1.side === L.dir && !h1.counter; chip = al ? 'ALIGNED (1H)' : 'NOT ALIGNED (1H)'; tone = al ? (L.dir === 1 ? 'up' : 'dn') : 'na';
        text = `this bot build reads the 1H: open ${px(h1.open1h)}${fin(h1.prevBody) ? DOT + 'last 1H closed ' + bb(Math.sign(h1.prevBody)) : ''}${h1.counter ? DOT + 'strong counter-candle → wait' : ''}${al ? '' : DOT + 'no alignment = no trade'}`; }
      else if (/HARMONY/i.test(why)) { chip = 'NOT ALIGNED'; tone = 'na'; text = why.replace(/^HARMONY:\s*/i, '') + DOT + 'no alignment = no trade'; time = hm(idle.t); }
      else { chip = 'NOT SENT'; tone = 'na'; text = "the bot's 30M harmony rule is not in this build (r1.6)"; }
      L.steps.push({ n: 2, k: '30M HARMONY', chip, tone, text, time, src: 'trend_* rows' }); L.aligned = chip.startsWith('ALIGNED'); }
    // STEP 3 · 5M EXECUTION (trend_signal: trigger reject | break, level { name, price }, def.at the defending 5m close; trend_arm / the nearest board level while waiting)
    { const next5 = 300 - (ptSec(now) % 300); L.next5 = next5;
      let chip, text, tone, time = '';
      const lvOf = r => r && r.level && typeof r.level === 'object' ? { name: r.level.name, price: r.level.price } : r ? { name: r.rName || r.name || r.rKind || r.kind || 'R', price: fin(r.R) ? r.R : null } : null;
      const trig = r => r && r.trigger === 'break' ? 'broke through' : r && r.trigger === 'reject' ? 'rejected' : r && r.def ? 'defended' : 'triggered';
      const fresh = r => r && now - r.t < 4 * 3600000;
      if (!laneOn) { chip = 'NOT IN THIS BUILD'; tone = 'na'; text = "the bot's trend lane is not in this build (r1.6)"; }
      else if (sig && (!arm || sig.t >= arm.t) && (!skip || sig.t >= skip.t) && fresh(sig)) { const lv = lvOf(sig), close = sig.def && sig.def.at ? String(sig.def.at).slice(-5) : hm(sig.t);
        if (sig.taken === true) { chip = 'SIGNAL TAKEN'; tone = sig.dir === 1 ? 'up' : 'dn'; text = `at ${esc(lv.name)} ${px(lv.price)} · ${trig(sig)} · 5m close ${close} → ${sig.side || (sig.dir === 1 ? 'LONG' : 'SHORT')} entry ${px(sig.entry)} · stop ${px(sig.stop)}${fin(sig.size) ? ' · ' + sig.size + ' MNQ' : ''}`; }
        else { chip = 'SKIPPED'; tone = 'na'; text = `at ${esc(lv.name)} ${px(lv.price)} · ${trig(sig)} · 5m close ${close} → skipped: ${esc(sig.why || 'no why sent')}`; } time = hm(sig.t); L.sig = sig; }
      else if (skip && (!arm || skip.t >= arm.t) && fresh(skip)) { const lv = lvOf(skip); chip = 'SKIPPED'; tone = 'na'; text = `at ${esc(lv.name)} ${px(lv.price)} → skipped: ${esc(skip.why || 'no why sent')}`; time = hm(skip.t); }
      else if (arm && fresh(arm) && (!idle || arm.t >= idle.t)) { const lv = lvOf(arm), away = price != null && fin(lv.price) ? Math.abs(price - lv.price) : null; chip = 'WATCHING'; tone = 'arm'; text = `watching ${esc(lv.name)} ${px(lv.price)}${away != null ? ' (' + away.toFixed(2) + ' away)' : ''} · a 5m ${trig({ trigger: 'reject' })} or break-through close enters · next 5m close in ${mmss(next5)}`; time = hm(arm.t); L.arm = arm; L.watch = lv; }
      else { const lv = nearest(B, price); chip = L.dir && L.aligned ? 'WATCHING' : 'WAITING'; tone = 'na';
        text = lv ? `watching ${esc(lv.name)} ${px(lv.price)} (${Math.abs(price - lv.price).toFixed(2)} away) · next 5m close in ${mmss(next5)}` : `no board level near · next 5m close in ${mmss(next5)}`; L.watch = lv; }
      L.steps.push({ n: 3, k: '5M EXECUTION', chip, tone, text, time, src: 'trend_arm / trend_signal / trend_skip rows, tide.board.levels' }); }
    // the small line: re-entries used this clock hour / TradeDay (TAKEN trend signals), the caps from tide.rules.trendLane, the climax state from the newest signal
    { const cfg = T.rules && T.rules.trendLane && typeof T.rules.trendLane === 'object' ? T.rules.trendLane : {}, taken = rows.filter(r => r.phase === 'trend_signal' && r.taken === true);
      const hr = taken.filter(r => Math.floor(r.t / 3600000) === Math.floor(now / 3600000)).length, dy = taken.filter(r => dayOf(r.t) === dayOf(now)).length;
      const cx = (sig || skip || arm) && (sig || skip || arm).climax; const cxT = cx && typeof cx === 'object' ? `${cx.dir === 1 ? 'buying' : cx.dir === -1 ? 'selling' : ''} climax ${cx.at ? String(cx.at).slice(-5) : ''}${cx.sameWay ? ' (same way: defense confirms)' : ''}`.trim() : laneOn ? 'none noted' : 'not sent';
      L.small = `next 5m close in ${mmss(L.next5)}${laneOn ? ` · re-entries used ${hr}/${fin(cfg.capHour) ? cfg.capHour : 2} this hour · ${dy}/${fin(cfg.capDay) ? cfg.capDay : 6} today` : ''} · climax: ${cxT}`; }
    // the verdict: holds first (the bot's own windows), then the lane, then the TIDE setup state (r1.5.6)
    { let hold = null; try { hold = T18.clModel(M, d, now).rules.find(r => r.s === 'hold'); } catch (e) { hold = null; }
      const until = hold ? (String(hold.why).match(/(\d\d:\d\d)\s*PT\s*$/) || String(hold.why).match(/–(\d\d:\d\d)/) || [])[1] : null;
      if (hold) L.verdict = { k: 'stand', w: 'STAND DOWN', why: `${hold.w.toLowerCase()}${until ? ' until ' + until : ''} · ${String(hold.why).replace(/^holding:\s*/i, '')}` };
      else if (M.position) L.verdict = { k: 'act', w: 'ACT', why: `in trade · ${M.position.dir === 1 ? 'LONG' : 'SHORT'} ${fin(M.position.open) ? M.position.open + ' MNQ' : ''} · managed by the bot`, dir: M.position.dir };
      else if (L.sig && L.sig.taken === true && now - L.sig.t < 15 * 60000) L.verdict = { k: 'act', w: 'ACT', why: `defended · 5m close ${L.sig.def && L.sig.def.at ? String(L.sig.def.at).slice(-5) : hm(L.sig.t)} · entry ${px(L.sig.entry)} stop ${px(L.sig.stop)}`, dir: L.sig.dir };
      else if (L.sig && L.sig.taken !== true && (!L.arm || L.sig.t >= L.arm.t)) L.verdict = { k: 'wait', w: 'WAIT', why: `signal skipped: ${L.sig.why || 'no why sent'}` };
      else if (L.arm && L.watch) L.verdict = { k: 'ready', w: 'GET READY', why: `at ${L.watch.name} ${px(L.watch.price)}${price != null && fin(L.watch.price) ? ' (' + Math.abs(price - L.watch.price).toFixed(2) + ' pts)' : ''} · a defended 5m close enters`, dir: L.arm.dir };
      else if (laneOn && idle && (!arm || idle.t >= arm.t)) { const w = String(idle.why || ''); L.verdict = { k: 'wait', w: 'WAIT', why: /30M|HARMONY/i.test(w) ? '30M not in harmony' + (/\bat (\d\d:\d\d)/.test(w) ? ' (' + w.match(/\bat (\d\d:\d\d)/)[1] + ')' : '') : /DIR|direction/i.test(w) ? 'no 4H direction' : w.slice(0, 80) }; }
      else if (laneOn && L.dir != null && L.dir !== 0 && L.aligned) L.verdict = { k: 'wait', w: 'WAIT', why: `structure ${arrow(L.dir)} and 30M aligned · no 5m trigger yet` };
      else if (laneOn && L.dir === 0) L.verdict = { k: 'wait', w: 'WAIT', why: 'no 4H direction (the votes are neutral)' };
      else { const st = M.stage || {}; L.verdict = st.k === 'retest' ? { k: 'ready', w: 'GET READY', why: st.text || 'retest at the armed level' } : st.k === 'armed' ? { k: 'wait', w: 'WAIT', why: st.text || 'armed, waiting for the retest' } : { k: 'wait', w: 'WAIT', why: st.text || 'scanning' }; }
    }
    return L;
  }
  function nearest(B, price) { if (!B || !Array.isArray(B.levels) || price == null) return null; const ls = B.levels.filter(l => l && fin(l.price) && !(Array.isArray(l.blockedBy) && l.blockedBy.some(b => b && b.code === 'ROUND_NUMBER'))).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)); return ls[0] ? { name: ls[0].name || 'level', price: ls[0].price } : null; }
  function laneState(d, M) { const L = laneModel(d, M, Date.now()); const s3 = L.steps[2]; return `${L.verdict.w.toLowerCase()} · ${s3.chip.toLowerCase()}${/watching|skipped|taken/i.test(s3.chip) ? ' ' + s3.text.split(' · ')[0].replace(/^(watching|at) /, '') : ''}`; }
  function cardHTML(L, M) {
    const v = L.verdict, hd = `<div class="fx23-hd"><span class="fx18-t">TREND LANE</span><span class="fx18-mode" data-mode="${M.mode.key}"><span class="fx18-mdot" aria-hidden="true"></span>${esc(M.mode.word)}</span><span class="fx23-time">${hm(L.now)} PT</span></div>`;
    const vd = `<div class="fx23-verdict" data-k="${v.k}" data-dir="${v.dir || 0}" role="status"><b class="fx23-vw">${esc(v.w)}</b><span class="fx23-vr">${esc(v.why)}</span></div>`;
    const steps = `<ol class="fx23-steps">${L.steps.map(s => `<li class="fx23-step" data-tone="${s.tone}" title="${esc(s.src)}"><div class="fx23-sh"><span class="fx23-sn">STEP ${s.n}</span><span class="fx23-sk">${esc(s.k)}</span><span class="fx23-chip" data-tone="${s.tone}">${esc(s.chip)}</span><span class="fx23-st">${esc(s.time)}</span></div><div class="fx23-sx">${s.text}</div></li>`).join('')}</ol>`;
    return hd + vd + steps + `<div class="fx23-small">${esc(L.small)}</div>`;
  }
  // mount: the lane card's content at the top of the Hour card; the Hour card's own children fold under "Candle detail" (moved, not copied: byte-identical inside)
  let box = null, fold = null, lastH = '', folded = false;
  function mount(card) {
    if (!fold) { fold = document.createElement('details'); fold.className = 'fx23-fold'; fold.innerHTML = '<summary>Candle detail <span class="fx18-dim">Hour wave: the forming 4H / 1H / 15m candles, their type, the flip line and the hour strip</span></summary>'; }
    if (!box) { box = document.createElement('div'); box.className = 'fx23'; box.setAttribute('aria-label', 'Trend lane: the verdict and the three steps'); }
    if (!folded) { const kids = [...card.childNodes].filter(n => n !== box && n !== fold && !(n.classList && n.classList.contains('fx20-tape'))); for (const k of kids) fold.appendChild(k); card.insertBefore(box, card.firstChild); card.appendChild(fold); folded = true; card.setAttribute('data-fx23', 'lane'); }
    const tape = card.querySelector('.fx20-tape'); if (tape && tape.parentNode === fold) fold.before(tape);   // the TIDE tape stays in view, under the lane
  }
  function unmount(card) { if (!folded || !card) return; for (const k of [...fold.childNodes].slice(1)) card.appendChild(k); fold.remove(); box.remove(); folded = false; lastH = ''; card.removeAttribute('data-fx23'); }
  const perf = { updates: 0, updateMax: 0 }; let lastL = null;
  function render(d) {
    const t0 = performance.now(), card = $('fx17-hour'); if (!card) return;
    const M = d ? tideOn(d) : null; if (!M) { unmount(card); U.feat20923.last = null; return; }
    mount(card); const L = laneModel(d, M, Date.now()); lastL = L;
    const h = cardHTML(L, M); if (h !== lastH) { box.innerHTML = h; lastH = h; }
    box.dataset.k = L.verdict.k;
    const dt = performance.now() - t0; perf.updates++; if (dt > perf.updateMax) perf.updateMax = dt;
    U.feat20923.last = { verdict: L.verdict.w + ' · ' + L.verdict.why, watch: L.watch || null, chips: L.steps.map(s => s.chip), texts: L.steps.map(s => s.text), small: L.small, laneOn: L.laneOn };
  }

  // ── (2) Review: patches on MacJournal's rendered DOM (its file is not edited); re-applied after each of its renders ──
  function reviewPatch(d) {
    const root = $('tj-root'); if (!root) return; const M = tideOn(d); if (!M) return;
    const T = d.tide, DF = M.dayFile, warm = M.warm, kv = root.querySelector('.tj-kv'); if (!kv) return;
    const dds = [...kv.querySelectorAll('div')];
    const find = label => dds.find(x => (x.querySelector('dt') || {}).textContent === label);
    // the trend lane's counts (the day file first, else the ring)
    { const rows = rowsOf().filter(r => r && TREND.test(String(r.phase)) && r.rebuilt !== true), tl = DF && DF.trend && typeof DF.trend === 'object' ? DF.trend : null;
      const n = tl ? { a: tl.armed, t: tl.taken, s: tl.skipped, src: 'bot journal, whole day' } : { a: rows.filter(r => r.phase === 'trend_arm').length, t: rows.filter(r => r.phase === 'trend_signal' && r.taken === true).length, s: rows.filter(r => r.phase === 'trend_skip' || (r.phase === 'trend_signal' && r.taken !== true)).length, src: rows.length ? 'journal ring' : null };
      const txt = n.src ? `armed ${n.a} · taken ${n.t} · skipped ${n.s} <span class="tj-src">${esc(n.src)}</span>` : (/r2\.[7-9]|r[3-9]\./.test(String(T.version || '')) ? 'no trend row yet today <span class="tj-src">journal ring</span>' : 'not in this bot build (r1.6) <span class="tj-src">no trend rows</span>');
      let row = kv.querySelector('[data-fx23="trend"]'); if (!row) { row = document.createElement('div'); row.setAttribute('data-fx23', 'trend'); row.innerHTML = '<dt>Trend lane</dt><dd></dd>'; const after = find('Setups') || find('Signals'); if (after) after.after(row); else kv.appendChild(row); }
      const dd = row.querySelector('dd'); if (dd.innerHTML !== txt) dd.innerHTML = txt; }
    // the newest live signal under its count: never a count without its why
    { const sg = find('Signals'); if (sg) { const dd = sg.querySelector('dd'); const sigs = rowsOf().filter(r => r && (r.phase === 'signal' || r.phase === 'trend_signal') && r.rebuilt !== true), s = sigs[sigs.length - 1] || null;
        let line = s ? `newest ${hm(fin(s.at) ? s.at : s.t)} ${esc(s.setup || s.id || '')} ${esc(s.level || (s.rName || s.name) || '')} ${esc(s.side || (s.dir === 1 ? 'LONG' : s.dir === -1 ? 'SHORT' : ''))} · ${s.taken === true ? 'taken' : 'not taken: ' + esc(s.takenWhy || s.why || (s.plan && s.plan.skip) || s.gatesNow || 'no why on the row (needs r1.6 takenWhy)')}` : '';
        let sp = dd.querySelector('.fx23-sig'); if (line && !sp) { sp = document.createElement('div'); sp.className = 'fx23-sig tj-dim'; dd.appendChild(sp); } if (sp && sp.innerHTML !== line) sp.innerHTML = line; if (sp && !line) sp.remove(); } }
    // the 4H control line while warming / from the day file
    { const c4 = find('4H control'); if (c4) { const dd = c4.querySelector('dd'), t = dd.textContent;
        if (/no control read today/.test(t) || dd.hasAttribute('data-fx23')) { const DC = DF && DF.control && (DF.control.dir === 1 || DF.control.dir === -1) ? DF.control : null;
          const nt = DC ? `${DC.dir === 1 ? '▲ buyers' : '▼ sellers'} since ${fin(DC.since) ? hm(DC.since) : '?'} <span class="tj-src">bot journal, whole day</span>` : warm ? `journal empty: warm-up in progress${fin(warm.done) && fin(warm.total) ? ` (${warm.done} of ${warm.total} min)` : ''} <span class="tj-src">${esc(warm.src)}</span>` : M.ctl ? null : 'no control read today <span class="tj-src">journal ring</span>';
          if (nt != null && dd.innerHTML !== nt) { dd.innerHTML = nt; dd.setAttribute('data-fx23', '1'); } } } }
    // the counts' source line
    { const src = root.querySelector('.tj-dsrc'); if (src && !src.__fx23) { src.__fx23 = src.textContent; }
      if (src) { const base = src.__fx23 || src.textContent; const add = warm ? ' · journal counts from the bot\'s day file; tape rebuilding' : DF ? ` · day file: ${fin(DF.rows) ? DF.rows + ' rows' : 'read'}${fin(DF.restarts) ? `, ${DF.restarts} start${DF.restarts === 1 ? '' : 's'}` : ''} (tide.day)` : '';
        const want = base + add; if (src.textContent !== want) src.textContent = want; } }
    // the money: never a $0.00 that reads like a lie
    { const mo = root.querySelector('.tj-money'), mw = root.querySelector('.tj-mw'), big = root.querySelector('.tj-big'); if (mo && big) {
        const tr = DF && DF.trades && typeof DF.trades === 'object' ? DF.trades : null, closed = M.day ? M.day.closed : 0, acct = M.acct && fin(M.acct.dayNet) ? { v: M.acct.dayNet, src: 'account.dayNet' } : fin(d.dayPnlNet) ? { v: d.dayPnlNet, src: 'dayPnlNet' } : null;
        let note = big.nextElementSibling && big.nextElementSibling.classList.contains('fx23-money') ? big.nextElementSibling : null;
        if (!closed && !(tr && tr.closed)) { const nt = acct ? usd(acct.v) : `no closed trade today${M.position ? ' (1 open)' : ''}`; if (mo.textContent !== nt) { mo.textContent = nt; mo.setAttribute('data-fx23', '1'); mo.setAttribute('data-s', acct ? String(Math.sign(acct.v || 0)) : '0'); } if (mw) { const mwt = acct ? 'MacMillionz Bot · broker day net' : ''; if (mw.textContent !== mwt) mw.textContent = mwt; }
          const acctN = (() => { try { const R = T18.acctRows(M); return R.rows.length; } catch (e) { return 0; } })();
          const line = acct ? `MacMillionz Bot day net <b>${usd(acct.v)}</b> <span class="tj-src">broker, ${esc(acct.src)} · closed trades only</span>${acctN ? ` · ${acctN} ${acctN === 1 ? 'trade' : 'trades'} today` : ''}` : 'MacMillionz Bot day net UNKNOWN: no dayPnlNet / account.dayNet in the snapshot';
          if (!note) { note = document.createElement('p'); note.className = 'tj-why fx23-money'; big.after(note); } if (note.innerHTML !== line) note.innerHTML = line; }
        else if (tr && tr.closed && !closed) { const nt = usd(tr.netUsd); if (mo.textContent !== nt) { mo.textContent = nt; mo.setAttribute('data-fx23', '1'); mo.setAttribute('data-s', String(Math.sign(tr.netUsd || 0))); } if (mw) mw.textContent = 'net · bot journal, whole day';
          const line = `${tr.closed} closed · won ${tr.won} · lost ${tr.lost} · even ${tr.even} <span class="tj-src">tide.day.trades (live_result rows): the ring and tide.trades lost them at a restart</span>`; if (!note) { note = document.createElement('p'); note.className = 'tj-why fx23-money'; big.after(note); } if (note.innerHTML !== line) note.innerHTML = line; }
        else if (note) note.remove(); } }
    // Replay on every closed TIDE trade card
    { const trades = M.trades || []; for (const a of root.querySelectorAll('article.tj-trade')) { if (a.querySelector('.fx23-rb')) continue; const lab = (a.getAttribute('aria-label') || '').replace(/^TIDE trade /, '');
        const used = new Set([...root.querySelectorAll('.fx23-rb')].map(b => b.getAttribute('data-fx23-replay'))), t = trades.find(x => !x.open && !x.sim && (String(x.id) === lab || String(x.setup) === lab) && !used.has(String(x.id))) || null;
        if (!t || !(typeof U.canReplayTide === 'function' && U.canReplayTide(t.id))) continue;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'action-btn fx23-rb'; b.setAttribute('data-fx23-replay', String(t.id)); b.textContent = '▶ Show on Levels'; a.appendChild(b); } }
  }
  // ── (3) Sessions today: the warning becomes a plain line naming the account's trades; the r1.6 fills by session ──
  const SESS = [['Asia', 900, 1440], ['London', 0, 390], ['NY', 390, 785]];
  const ptMin = t => Math.floor(ptSec(t) / 60);
  function sessPatch(d) {
    const sess = $('fx11-sess'); if (!sess) return; const M = tideOn(d); if (!M) { for (const e of sess.querySelectorAll('[data-fx23]')) e.removeAttribute('data-fx23'); const l = sess.querySelector('.fx23-sess'); if (l) l.remove(); return; }
    let A; try { A = T18.acctRows(M); } catch (e) { A = null; } if (!A) return;
    const n = A.rows.length, bot = A.rows.filter(r => r.src === 'BOT' || r.src === 'TIDE').length, man = n - bot;
    const by = SESS.map(([k, a, b]) => { const rs = A.rows.filter(r => { const m = ptMin(r.t); return m >= a && m < b; }); return `${k} ${rs.length}`; }).join(' · ');
    const txt = n ? `MacMillionz Bot · ${n} ${n === 1 ? 'trade' : 'trades'} today${A.src.startsWith('account') && man ? ` (${man} manual)` : ''}${A.net != null ? ` · day net ${usd(A.net)}` : ''} · by entry time: ${by}` : A.net != null && Math.abs(A.net) > 0.005 ? `MacMillionz Bot day net ${usd(A.net)} · no trade list in the snapshot (${esc(A.src)})` : '';
    for (const e of sess.querySelectorAll('.fx11-warn, .fx11-sw, [role="alert"], .fx11-sess-warn, p, div')) { const t = e.textContent || ''; if (/the split is missing trades|Sessions add to/.test(t) && e.children.length === 0 && !e.hasAttribute('data-fx23')) { e.setAttribute('data-fx23', 'plain'); } }
    let l = sess.querySelector('.fx23-sess'); if (!txt) { if (l) l.remove(); return; } if (!l) { l = document.createElement('div'); l.className = 'fx23-sess fx11-sub'; sess.appendChild(l); } if (l.textContent !== txt) l.textContent = txt;
  }

  // ── wiring ──
  let obs = null;
  function patchAll(d) { try { reviewPatch(d); } catch (e) { /* display only */ } try { sessPatch(d); } catch (e) { /* display only */ } }
  function observe() { if (obs) return; const root = $('tj-root'); if (!root) return; obs = new MutationObserver(() => { if (obs.__busy) return; obs.__busy = true; try { patchAll(snapNow()); } finally { obs.__busy = false; } }); obs.observe(root, { childList: true, subtree: true }); }
  try { const st = document.createElement('style'); st.id = 'fx23-css'; st.textContent = '[data-fx23="plain"]{background:none!important;border-color:transparent!important;color:var(--t2)!important}#g-day-cell[data-fx23day="1"] > #g-day, #g-day-cell[data-fx23day="1"] > #g-day-sub{display:none!important}'; document.head.appendChild(st); } catch (e) { /* display only */ }
  U.feat20923 = { release: '2.0.9.23', laneModel, laneState, reviewPatch, sessPatch, perf, update: () => { const d = snapNow(); render(d); patchAll(d); }, last: null };
  const _w = window.renderWhyNoTrade;
  if (typeof _w === 'function') window.renderWhyNoTrade = function (d) { const r = _w.apply(this, arguments); try { render(d || snapNow()); } catch (e) { /* display only */ } try { observe(); patchAll(d || snapNow()); } catch (e) { /* display only */ } return r; };
  const _rh = window.renderHeartbeat;
  if (typeof _rh === 'function') window.renderHeartbeat = function () { const r = _rh.apply(this, arguments); try { if (box) render(snapNow()); } catch (e) { /* display only */ } return r; };
  const _sv = window.switchView;
  if (typeof _sv === 'function') window.switchView = function (v) { const r = _sv.apply(this, arguments); try { observe(); patchAll(snapNow()); } catch (e) { /* display only */ } return r; };
  try { const d = snapNow(); if (d) { render(d); observe(); patchAll(d); } } catch (e) { /* display only */ }
})();
