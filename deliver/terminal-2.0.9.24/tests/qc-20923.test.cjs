'use strict';
// MacUI-A 2.0.9.23 witness (fails on 2.0.9.22, passes on .23). One browser; cwd = the harness folder; MACUI_V2 = the candidate page; nice 19 by the caller.
//   L  the TREND LANE card in the Hour card's slot on five fixtures: the verdict text, the three step chips, no number contradicts another (above / below vs price − open)
//   P  the Day P&L story on Mac's 11/05 numbers: headline = broker day net +$1,016.60, the TopstepX balance line, never 'Old +$'
//   W  the warm-up state (11/05 11:47 shape): header 'TIDE warming up · 186 of 360 min', the card line, Review 'journal empty: warm-up in progress'
//   R  a TIDE trade's Replay: the Trades row and the Review card carry a Replay button; a tap opens Levels with the journal markers and the fill / stop / TP marks
//   D  today's account trades on the Trades tab (the 6 broker round trips the bot did not place), the Sessions line, Review's money line
//   G  the checklist's grade block is a size tag (no FAIL tile), the signal row carries tags
//   T  the tape glyphs and the Review trend counts; the Levels 'TIDE scanning' line
//   U  no bare UNKNOWN on the TIDE surfaces of these fixtures; no page errors
const path = require('path'); const { chromium } = require('playwright'), { startServer, openPhone, meta } = require(path.resolve('lib.cjs'));
let pass = 0, fail = 0; const ok = (c, n, g) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' got: ' + String(g).slice(0, 900)}`); };
async function withState(b, st, fn) { const m = meta(st), srv = await startServer(st, 'ma23', m.clock); try { const o = await openPhone(b, { port: srv.port, v: '2', clock: m.clock }); try { await fn(o.page, o.errors); } finally { await o.ctx.close(); } } finally { srv.stop(); } }
const txt = (page, sel) => page.evaluate(s => ((document.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim(), sel);
const upd = page => page.evaluate(async () => { switchView('dashboard'); for (const k of ['feat20918', 'feat20919', 'feat20920', 'feat20923']) { try { macui[k].update(); } catch (e) { /* */ } } await new Promise(r => setTimeout(r, 250)); });
const lane = async page => { await upd(page); return page.evaluate(() => { const L = macui.feat20923.last, box = document.querySelector('#fx17-hour .fx23'); return Object.assign({}, L, { verdictDom: ((box && box.querySelector('.fx23-verdict')) || {}).textContent || '', fold: !!document.querySelector('#fx17-hour .fx23-fold:not([open])'), foldKids: document.querySelectorAll('#fx17-hour .fx23-fold > *').length, tapeOut: !!document.querySelector('#fx17-hour > .fx20-tape'), heroInFold: !!document.querySelector('#fx17-hour .fx23-fold .fx17-hero'), h: box ? box.getBoundingClientRect().height : 0 }); }); };
// the contradiction check: 'price X above|below the 4H control O' must agree with price - O
function consistent(text, price) { const m = /price ([\d.]+) (above|below|at) the 4H control ([\d,]+\.\d\d)/.exec(text); if (!m) return { ok: false, why: 'no price-vs-control sentence' }; const o = +m[3].replace(/,/g, ''), d = price - o; return { ok: (m[2] === 'above' && d > 0) || (m[2] === 'below' && d < 0) || (m[2] === 'at' && d === 0), dist: Math.abs(d), said: +m[1] }; }
(async () => { const b = await chromium.launch();
  try {
    // ── L: the five lane fixtures ──
    await withState(b, 't23-standdown', async (page, errors) => { const L = await lane(page);
      ok(/^STAND DOWN · time blocks until 07:10/.test(L.verdict), 'L1 stand down in the 06:30–07:10 block: "STAND DOWN · time blocks until 07:10 …"', L.verdict);
      ok(L.chips[0] === 'STRUCTURE ▼' && L.chips[1] === 'NOT SENT' && /WAITING|WATCHING/.test(L.chips[2]), 'L1b chips: STRUCTURE ▼ · 30M NOT SENT (idle row carries no 30M fields) · waiting', JSON.stringify(L.chips));
      const c = consistent(L.texts[0], 28655.25); ok(c.ok && Math.abs(c.dist - c.said) < 0.01, 'L1c STEP 1 words match the arithmetic (price 28,655.25 vs the 4H control)', L.texts[0]);
      ok(L.fold && L.heroInFold && L.foldKids >= 9 && L.tapeOut, 'L1d the Hour card content is folded under "Candle detail" (closed), the TIDE tape stays out', JSON.stringify({ fold: L.fold, hero: L.heroInFold, kids: L.foldKids, tape: L.tapeOut }));
      ok(L.h > 0 && L.h < 844 * 1.2, 'L1e the lane card is at most 1.2 screens tall at 390', L.h);
      ok(!errors.length, 'E1 no page errors (t23-standdown)', errors.join(' | ')); });
    await withState(b, 't23-wait1h', async (page, errors) => { const L = await lane(page);
      ok(/^WAIT · 30M not in harmony/.test(L.verdict), 'L2 1H/30M out: "WAIT · 30M not in harmony …"', L.verdict);
      ok(L.chips[1] === 'NOT ALIGNED' && /no alignment = no trade/.test(L.texts[1]), 'L2b STEP 2 chip NOT ALIGNED with "no alignment = no trade"', JSON.stringify(L.chips) + ' ' + L.texts[1]);
      ok(!errors.length, 'E2 no page errors (t23-wait1h)', errors.join(' | ')); });
    await withState(b, 't23-getready', async (page, errors) => { const L = await lane(page);
      ok(/^GET READY · at 1H Open 28,650\.00 \(12\.00 pts\)/.test(L.verdict), 'L3 armed at R: "GET READY · at 1H Open 28,650.00 (12.00 pts) …"', L.verdict);
      ok(L.chips[0] === 'STRUCTURE ▼' && L.chips[1] === 'ALIGNED' && L.chips[2] === 'WATCHING' && /watching 1H Open 28,650\.00 \(12\.00 away\)/.test(L.texts[2]) && /next 5m close in \d+:\d\d/.test(L.texts[2]), 'L3b chips STRUCTURE ▼ · ALIGNED · WATCHING; STEP 3 names the level, the distance and the next 5m close', JSON.stringify(L.chips) + ' ' + L.texts[2]);
      const c = consistent(L.texts[0], 28638); ok(c.ok && Math.abs(c.dist - c.said) < 0.01, 'L3c STEP 1 arithmetic', L.texts[0]);
      ok(/re-entries used 0\/2 this hour · 0\/6 today/.test(L.small), 'L3d the small line: re-entries 0/2 · 0/6', L.small);
      ok(!errors.length, 'E3 no page errors (t23-getready)', errors.join(' | ')); });
    await withState(b, 't23-act', async (page, errors) => { const L = await lane(page);
      ok(/^ACT · defended · 5m close 08:25 · entry 28,641\.00 stop 28,654\.25/.test(L.verdict), 'L4 signal taken: "ACT · defended · 5m close 08:25 · entry 28,641.00 stop 28,654.25"', L.verdict);
      ok(L.chips[2] === 'SIGNAL TAKEN' && /at 1H Open 28,650\.00 · rejected · 5m close 08:25 → SHORT entry 28,641\.00 · stop 28,654\.25 · 3 MNQ/.test(L.texts[2]), 'L4b STEP 3: at <level> <price> · rejected · 5m close → entry, stop, size', L.texts[2]);
      ok(/re-entries used 1\/2 this hour · 1\/6 today · climax: selling climax 08:10 \(same way: defense confirms\)/.test(L.small), 'L4c re-entries 1/2 · 1/6 and the climax state', L.small);
      const ex = await page.evaluate(() => { const v = document.querySelector('#fx17-hour .fx23-verdict'); return v ? v.getAttribute('data-k') + '|' + v.getAttribute('data-dir') : ''; }); ok(ex === 'act|-1', 'L4d ACT carries the direction colour attribute (data-k act, dir -1)', ex);
      // the tape glyph for the taken trend signal
      const g = await page.evaluate(() => [...document.querySelectorAll('#fx17-hour .fx20-box text.fx20-e')].map(t => t.getAttribute('data-ph') + ':' + t.textContent).join(' ')); ok(/trend_signal:◆/.test(g), 'T1 the tape draws the taken trend signal as ◆', g);
      ok(!errors.length, 'E4 no page errors (t23-act)', errors.join(' | ')); });
    await withState(b, 'qc156-htf', async (page, errors) => { const L = await lane(page);
      ok(/^WAIT · /.test(L.verdict) && L.laneOn === false, 'L5 r1.5.6 (no lane): the verdict reads from the TIDE setup state, lane off', L.verdict + ' laneOn=' + L.laneOn);
      ok(L.chips[0] === 'STRUCTURE ▼' && L.chips[1] === 'NOT IN THIS BUILD' && L.chips[2] === 'NOT IN THIS BUILD' && /not in this build \(r1\.6\)/.test(L.texts[1]), 'L5b STEP 1 still from board.htf; STEPS 2–3 "the bot\'s trend lane is not in this build (r1.6)"', JSON.stringify(L.chips));
      const sc = await page.evaluate(() => macui.feat20920.scanLine(lastSnapForPoll, macui.feat20918.model(lastSnapForPoll, Date.now()), macui.feat20919.lvModel(lastSnapForPoll, Date.now())));
      ok(/^TIDE scanning · 4H ▼ sellers \(trap, since 07:40\) · HTF ↓ · nearest .+ · lane: wait/.test(sc), 'T2 the Levels "TIDE scanning" line: control, HTF, nearest level, lane', sc);
      const Z = await page.evaluate(async () => { delete lastSnapForPoll.tide.board.htf; macui.feat20923.update(); await new Promise(r => setTimeout(r, 100)); return macui.feat20923.last; });
      ok(/^WAIT/.test(Z.verdict) && Z.chips[0] === 'STRUCTURE ▼' && /trap/.test(Z.texts[0]), 'L5c no board.htf: STEP 1 falls back to board.control (▼ sellers · trap), no HTF word', JSON.stringify(Z));
      const noHtf = await page.evaluate(() => /HTF/.test(document.getElementById('fx17-hour').innerText)); ok(!noHtf, 'L5d with board.htf gone the lane card says nothing about HTF (H7 holds)', noHtf);
      ok(!errors.length, 'E5 no page errors (qc156-htf)', errors.join(' | ')); });
    // ── P + D: the 11/05 numbers ──
    await withState(b, 't23-pnl1105', async (page, errors) => { await upd(page);
      const H = await page.evaluate(() => ({ cell: document.getElementById('g-day-cell').innerText.replace(/\s+/g, ' ').trim(), v: (document.querySelector('#g-day-cell .fx23-dayv') || {}).textContent, gdayHidden: getComputedStyle(document.getElementById('g-day')).display === 'none', attr: document.getElementById('g-day-cell').getAttribute('data-fx23day') }));
      ok(H.v === '+$1,016.60' && H.gdayHidden && H.attr === '1', 'P1 the header Day P&L headline is the bot\'s broker day net +$1,016.60 (the page\'s balance-change number hidden)', JSON.stringify(H));
      ok(/MacMillionz Bot · Day P&L · closed trades only · 6 trades/.test(H.cell) && /balance \+\$716\.09 · differs by −\$300\.51/.test(H.cell) && !/Old|TIDE closed|TIDE \$/.test(H.cell), 'P2 ONE P&L: "MacMillionz Bot · Day P&L · closed trades only · 6 trades", the balance line; no TIDE / Old split', H.cell);
      await page.evaluate(() => switchView('trades')); await page.waitForTimeout(300);
      const T = await page.evaluate(() => ({ box: ((document.querySelector('#fx18-trades .fx18-tbox') || {}).innerText || '').replace(/\s+/g, ' '), acct: ((document.querySelector('.fx23-acct') || {}).innerText || '').replace(/\s+/g, ' '), rows: document.querySelectorAll('.fx23-ar').length, tags: [...document.querySelectorAll('.fx23-ar')].map(e => e.getAttribute('data-src')).join(',') }));
      ok(/MacMillionz Bot day net \+\$1,016\.60/.test(T.box) && !/Old path|not a TIDE trade|TIDE closed/.test(T.box), 'D1 Trades: "MacMillionz Bot day net +$1,016.60" (no Old path / TIDE split)', T.box);
      ok(T.rows === 6 && /MACMILLIONZ BOT · Tue, Nov 3 · from Mon 3:00 PM PT/i.test(T.acct) && /\+\$1,016\.60 broker day net · 6 closed · 40 contract-sides/.test(T.acct) && /MacMillionz Bot · 6 trades · balance \+\$716\.09 · differs by −\$300\.51/.test(T.acct) && !/UNTAGGED|not tagged|bot ·/.test(T.acct), 'D2 today\'s card: 6 trades of this TradeDay as the bot\'s, the broker day net and the balance difference, no tag split', T.acct.slice(0, 400) + ' rows=' + T.rows);
      await page.evaluate(() => switchView('dashboard')); await page.waitForTimeout(300);
      const Sx = await page.evaluate(() => ({ sess: ((document.getElementById('fx11-sess') || {}).innerText || '').replace(/\s+/g, ' ') }));
      ok(/MacMillionz Bot · 6 trades today · day net \+\$1,016\.60 · by entry time: Asia 0 · London 4 · NY 2/.test(Sx.sess) && !/not placed by the bot|not the bot's/.test(Sx.sess), 'D3 Sessions today: one set of trades split by entry time, no bot / not-bot split', Sx.sess.slice(-400));
      await page.evaluate(() => switchView('journal')); await page.waitForTimeout(500);
      const Rv = await page.evaluate(() => ({ money: (document.querySelector('#tj-root .tj-money') || {}).textContent, note: ((document.querySelector('#tj-root .fx23-money') || {}).innerText || ''), sig: ((document.querySelector('#tj-root .fx23-sig') || {}).innerText || ''), trend: ((document.querySelector('#tj-root [data-fx23="trend"] dd') || {}).innerText || '') }));
      ok(Rv.money === '+$1,016.60' && /MacMillionz Bot day net \+\$1,016\.60 broker, dayPnlNet · closed trades only · 6 trades today/.test(Rv.note), 'E1 Review money: the broker day net +$1,016.60 as the figure, never a bare $0.00 or a TIDE / account split', JSON.stringify(Rv));
      ok(Rv.sig === '', 'E2 Review Signals: live 0 → no newest-signal line (nothing to explain)', Rv.sig);
      ok(/not in this bot build \(r1\.6\)/.test(Rv.trend), 'E3 Review Trend lane row on r1.5.6: "not in this bot build (r1.6)"', Rv.trend);
      ok(!errors.length, 'E6 no page errors (t23-pnl1105)', errors.join(' | ')); });
    await withState(b, 't23-pnl1105-acct', async (page, errors) => { await upd(page); await page.evaluate(() => switchView('trades')); await page.waitForTimeout(300);
      const T = await page.evaluate(() => ({ acct: ((document.querySelector('.fx23-acct') || {}).innerText || '').replace(/\s+/g, ' '), rows: document.querySelectorAll('.fx23-ar').length, man: document.querySelectorAll('.fx23-ar[data-src="MANUAL"]').length }));
      ok(T.rows === 12 && T.man === 12 && /MacMillionz Bot · 12 trades · 12 manual/.test(T.acct) && /costs −\$24\.40/.test(T.acct) && /source: account \(r1\.6\)/.test(T.acct) && !/bot ·/.test(T.acct), 'D4 r1.6 account.fills: 12 fills tagged MANUAL (the bot\'s own source word), the costs, the source, no bot / not-bot split', T.acct.slice(0, 300) + ' rows=' + T.rows + ' man=' + T.man);
      await page.evaluate(() => switchView('dashboard')); await page.waitForTimeout(300);
      const s = await page.evaluate(() => ((document.getElementById('fx11-sess') || {}).innerText || '').replace(/\s+/g, ' ')); ok(/MacMillionz Bot · 12 trades today \(12 manual\) · day net \+\$1,016\.60 · by entry time: Asia 0 · London 8 · NY 4/.test(s) && !/not placed by the bot|bot ·/.test(s), 'D5 Sessions with account.fills: one set of trades by entry time (12 manual named from account.fills), no bot / not-bot split', s.slice(-300));
      ok(!errors.length, 'E7 no page errors (t23-pnl1105-acct)', errors.join(' | ')); });
    // ── W: the warm-up ──
    for (const st of ['t23-warm', 't23-warm156']) await withState(b, st, async (page, errors) => { await upd(page); const r16 = st === 't23-warm';
      const W = await page.evaluate(() => ({ why: (document.querySelector('#g-banner .fx19-why') || {}).textContent || '', card: ((document.querySelector('#fx18-tide .fx23-warm') || {}).innerText || '').replace(/\s+/g, ' '), ctl: ((document.querySelector('#fx18-tide .fx18-ctl:not(.fx23-warm)') || {}).innerText || '').replace(/\s+/g, ' '), stage: ((document.querySelector('#fx18-tide .fx18-stage') || {}).innerText || '').replace(/\s+/g, ' '), now: document.getElementById('view-dashboard').innerText }));
      ok(r16 ? /TIDE warming up · 186 of 360 min · started 03:41/.test(W.why) : /TIDE warming up · rebuilding the 6-hour book \(no counter in r1\.5\.6\)/.test(W.why), `W1 header (${st}): "TIDE warming up · …"`, W.why);
      ok(r16 ? /TIDE WARMING UP 186 of 360 min · started 03:41/.test(W.card) && /the day file keeps today's 41 rows/.test(W.card) : /TIDE WARMING UP no counter in this bot build \(r1\.5\.6\)/.test(W.card), `W2 the TIDE card's warm-up line (${st})`, W.card);
      ok(r16 ? /4H CONTROL ▼ SELLERS · since 00:40 trap · bot journal, whole day/.test(W.ctl) : /4H CONTROL rebuilding · read again when the warm-up ends/.test(W.ctl), `W3 4H control while warming (${st}): the day file, else "rebuilding"`, W.ctl);
      ok(!/no 4H control read yet/.test(W.now) && /warm-up in progress/.test(W.stage), `W4 nothing reads "no 4H control read yet" on Now (${st}); the stage says warm-up in progress`, W.stage);
      await page.evaluate(() => switchView('journal')); await page.waitForTimeout(500);
      const R = await page.evaluate(() => ({ ctl: [...document.querySelectorAll('#tj-root .tj-kv div')].map(x => x.innerText.replace(/\s+/g, ' ')).find(t => /^4H control/.test(t)) || '', src: (document.querySelector('#tj-root .tj-dsrc') || {}).textContent || '', all: document.getElementById('view-journal').innerText }));
      ok(r16 ? /4H control ▼ sellers since 00:40 bot journal, whole day/.test(R.ctl) : /journal empty: warm-up in progress/.test(R.ctl), `W5 Review 4H control (${st}): the day file, else "journal empty: warm-up in progress"`, R.ctl);
      ok(!/no control read today/.test(R.all) && (r16 ? /journal counts from the bot's day file; tape rebuilding/.test(R.src) : /tape rebuilding/.test(R.src)), `W6 Review never says "no control read today" while warming (${st}); the source line says the tape is rebuilding`, R.src);
      ok(!errors.length, `E8 no page errors (${st})`, errors.join(' | ')); });
    // ── R: the TIDE trade's Replay ──
    await withState(b, 't23-trade', async (page, errors) => { await upd(page); await page.evaluate(() => switchView('trades')); await page.waitForTimeout(300);
      const b1 = await page.evaluate(() => { const b = document.querySelector('#fx18-trades .fx23-rb'); return b ? b.getAttribute('data-fx23-replay') : null; }); ok(b1 === 'tide-1793720179416', 'R1 the Trades tab TIDE row carries a Replay button keyed by the trade id', b1);
      await page.evaluate(() => switchView('journal')); await page.waitForTimeout(500);
      const b2 = await page.evaluate(() => { const b = document.querySelector('#tj-root article.tj-trade .fx23-rb'); return b ? b.getAttribute('data-fx23-replay') + '|' + b.textContent : null; }); ok(b2 === 'tide-1793720179416|▶ Replay (journal markers)', 'R2 the Review trade card carries the Replay button', b2);
      const sg = await page.evaluate(() => ((document.querySelector('#tj-root .fx23-sig') || {}).innerText || '')); ok(/^newest 07:36 S279 4H Open LONG · taken$/.test(sg), 'E2b Review Signals: the newest live signal under the count (time, setup, zone, side, taken)', sg);
      const tr = await page.evaluate(() => ((document.querySelector('#tj-root [data-fx23="trend"] dd') || {}).innerText || '')); ok(/armed 2 · taken 1 · skipped 2 bot journal, whole day/.test(tr), 'T3 Review "Trend lane: armed 2 · taken 1 · skipped 2" from tide.day', tr);
      await page.evaluate(() => { document.querySelector('#tj-root .fx23-rb').click(); }); await page.waitForTimeout(700);
      const V = await page.evaluate(() => ({ view: currentView, key: window.lvTradeKey, sub: (document.getElementById('lv-trade-sub') || {}).textContent, jm: ((document.querySelector('#lv-trade-body .fx23-jm') || {}).textContent || ''), svg: !!document.querySelector('#lv-trade-chart svg'), labels: (document.getElementById('lv-trade-chart') || {}).innerText || '', replaying: window.lvReplayCut != null || !!window.lvReplayTimer, stats: ((document.getElementById('lv-trade-stats') || {}).innerText || '').replace(/\s+/g, ' ') }));
      ok(V.view === 'levels' && V.key === 'tide-1793720179416' && V.sub === 'TIDE TRADE REPLAY', 'R3 a tap opens Levels with the TIDE trade picked, sub "TIDE TRADE REPLAY"', JSON.stringify(V).slice(0, 300));
      ok(/journal markers only/.test(V.jm) && V.svg && /SL|STOP/i.test(V.labels) && /TP1|TP2/.test(V.labels), 'R4 the chart shows the journal markers (stop, TP1 / TP2) and says "journal markers only"', V.jm.slice(0, 120) + ' | ' + V.labels.replace(/\s+/g, ' ').slice(0, 200));
      ok(V.replaying, 'R5 the page\'s own replay is running after the tap', JSON.stringify({ cut: V.replaying }));
      const S2 = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 7500)); return ((document.getElementById('lv-trade-stats') || {}).innerText || '').replace(/\s+/g, ' '); });
      ok(/LONG 6x @ 28,?309\.25/.test(S2) && /28,?344\.17 avg \(broker\)/.test(S2) && /\+411\.68|\+\$411\.68/.test(S2), 'R6 after the replay the stats read the trade: LONG 6x @ 28,309.25, exit 28,344.17 avg (broker), net +411.68', S2);
      ok(!errors.length, 'E9 no page errors (t23-trade)', errors.join(' | ')); });
    // ── G: the grade as a size tag ──
    await withState(b, 'qc154-flat', async (page, errors) => { await upd(page); await page.evaluate(() => switchView('checklist')); await page.waitForTimeout(300);
      const G = await page.evaluate(() => ({ cl: ((document.getElementById('fx18-cl') || {}).innerText || '').replace(/\s+/g, ' '), fails: document.querySelectorAll('#fx18-cl .is-pts .fx18-cr[data-s="fail"]').length, tags: document.querySelectorAll('#fx18-cl .is-pts .fx18-cr[data-s="tag"]').length }));
      ok(G.fails === 0 && G.tags === 5 && /GRADE size tag only · never a filter for aligned setups/.test(G.cl) && !/POINTS \+1 each/.test(G.cl) && !/A\+ 4–5 · B 3/.test(G.cl), 'G1 checklist: GRADE block with 5 neutral tag rows, no FAIL tile, no points scale', JSON.stringify({ fails: G.fails, tags: G.tags }) + ' ' + G.cl.match(/GRADE.{0,160}/));
      ok(/flat \$400 at every grade; the gates may still refuse until r1\.6 \(this bot is r1\.5\.6\)/.test(G.cl), 'G2 the r1.5.6 note', G.cl.match(/flat \$400.{0,80}/));
      await page.evaluate(() => switchView('dashboard')); await page.waitForTimeout(200);
      const S = await page.evaluate(() => ({ tags: [...document.querySelectorAll('#fx18-tide .fx23-tags .fx23-tag')].map(e => e.textContent), dots: document.querySelectorAll('#fx18-tide .fx18-pt').length })); ok(S.tags.length >= 1 && /^grade .* · size tag$/.test(S.tags[0]) && S.dots === 0, 'G3 the signal row: grade as a size tag + tags, no point dots', JSON.stringify(S));
      ok(!errors.length, 'E10 no page errors (qc154-flat)', errors.join(' | ')); });
    // ── U: no bare UNKNOWN on the TIDE surfaces ──
    await withState(b, 't23-getready', async (page) => { await upd(page);
      const u = await page.evaluate(() => { const out = []; for (const sel of ['#fx18-tide', '#fx17-hour', '#fx19-lv', '#g-banner', '#g-day-cell']) { const e = document.querySelector(sel); if (!e) continue; const t = e.innerText; let m; const re = /UNKNOWN(?!\s*[:(])/g; while ((m = re.exec(t))) out.push(sel + ': …' + t.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, ' ')); } return out; });
      ok(!u.length, 'U1 every UNKNOWN on Now / header names its reason (": …" or "(…)")', u.join(' | ')); });
  } finally { await b.close(); }
  console.log(`qc-20923: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
