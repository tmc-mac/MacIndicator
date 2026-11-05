'use strict';
// lib/trendLane.js: TIDE live r1.6 "trend lane" (MacTrend, 11/05), Mac's execution spec (11/05 addenda 1, 2, 7, 9):
//   "The 4H provides information, NOT an entry." "No alignment = No trade." "It doesn't have to be a pullback, it can just be price action at a level of
//   interest including the institutional levels." "I don't care to get the perfect institutional level, I care to get into the trades and execute!"
//
// PURE and deterministic: no I/O, no clock, no randomness. It READS the structure engine's state (lib/structure.js: its own 5m / 15m / 30m / 1H / 4H bars,
// htfContext, climax, zones, 15m pivots, the level board) after each engine step and never writes to it. One decision per CLOSED 5m bar: nothing here
// waits for a 15m or 30m close.
//   STEP 1 DIR     (4H) : the PREVIOUS 4H candle's close direction (st.htf.prev4h.dir: +1 closed bullish, -1 bearish, 0 doji / flat -> no DIR, idle).
//                         The current 4H open (st.period.O4) is plotted as a reference level.
//   STEP 2 HARMONY (30M): the most recently COMPLETED 30M candle closed in DIR (close above its open for DIR up, below for DIR down); re-read at every
//                         5m close (so at every 30M close). The forming 30M's open is the PRIMARY reference R, with the 4H open.
//   STEP 3 TRIGGER (5M) : references R = every level the bot already tracks (the Levels PRO board the executor hands the engine: PDH / PDL, PWH / PWL,
//                         week / month / quarter opens, Asia / London ranges, ORH / ORL, IB ... whatever it carries; the TIDE zones; the 4H / 1H / 30M / 15m
//                         opens; the last 15m swing). Nearest R to the close wins. A COMPLETED 5m candle that traded at R and CLOSED on the DIR side of R:
//                           reject = opened on the DIR side, traded within retestTol of R or through it, closed back on the DIR side, with a rejection wick
//                                    of >= wickMin pts (the wick minimum applies to this case only);
//                           break  = opened on the far side of R and closed on the DIR side (no wick minimum).
//                         No pullback is required. A 5m extreme within retestTol of R journals trend_arm (once per R per 15m, nearest 3).
//   EXECUTION           : market at that 5m close; stop = the extreme against DIR of the 30M candle the trigger closed in -/+ stopTicks ticks (Mac 11/05: "beyond
//                         the 30 minute wick"); a 30M younger than minAge30 min at the trigger -> the previous completed 30M's extreme (stopBasis '30m-wick' |
//                         'prev-30m-wick' + the candle's open time journaled). The trigger 5m's own extreme is always covered. Accurate; never tightened.
//                         Sizing is lib/moneyRule.js's: a wide stop sizes DOWN; a stop no contract fits is a trend_skip (tideWire). Targets as every TIDE signal.
//   RE-ENTRY            : another entry on the next trigger while DIR + HARMONY hold; at most capHour entries per clock hour and capDay per TradeDay (15:00 PT).
//                         One open position at a time is the executor's rule (tideWire TIDE_OPEN + tideLive), not this file's.
//   CLIMAX              : cfg.climax 'defense-confirms' (default, Mac 11/05): a defended 5m candle IS the structure confirmation, the engine's climax state
//                         never blocks a lane entry (journaled on trend_signal); 'block' = a same-way climax refuses (why CLIMAX).
//   NOT applied         : ONE_IDEA slot, waveBias, retest-closed-inside, nearest-level, the 4H-control veto, rule 18 (no grade table). The executor's kept gates
//                         (TIDE entry blocks, open wait, session close, news wait, flat, broker checks) apply in tideWire.shadowStep. At 07:30 PT (Mac's example:
//                         the first 30M after the NY open + wait) nothing blocks: the 06:30-07:10 block and the 30-min waits after 06:30 / 07:00 are over.
//   TIE                 : an engine (level) signal and a lane signal on the same bar -> the engine's wins; the lane journals trend_tie.
let S_ = null; const S = () => S_ || (S_ = require('./structure'));   // ptMin / ptLabel only (America/Los_Angeles, deterministic); loaded on first use

const VERSION = 'trend-lane-r2';   // r2: Mac's 11/05 execution spec (prior-4H DIR, 30M harmony, any tracked level, reject | break); r1 was 1H harmony + pullback
const DEFAULTS = Object.freeze({ enabled: true, retestTol: 6, wickMin: 4, stopTicks: 2, capHour: 2, capDay: 6, climax: 'defense-confirms', swingBars: 12, minAge30: 10, tick: 0.25 });   // minAge30: a 30M candle younger than this (minutes) at the trigger lends its stop to the previous 30M's wick
const CLIMAX_MODES = Object.freeze(['defense-confirms', 'block']);
const MAJOR = new Set(['4H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low', 'EQH', 'EQL']);
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => (isNum(x) ? Math.round(x * 100) / 100 : null);

function cfgOf(c) {
  const o = { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
  for (const k of ['retestTol', 'wickMin', 'stopTicks', 'capHour', 'capDay', 'swingBars', 'minAge30', 'tick']) if (!isNum(o[k]) || o[k] < 0) o[k] = DEFAULTS[k];
  if (!CLIMAX_MODES.includes(o.climax)) o.climax = DEFAULTS.climax;
  o.enabled = o.enabled !== false;
  return o;
}
// -> null | text (tideWire.configProblem calls it for tide.trendLane)
function configProblem(c) {
  if (c === undefined) return null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'tide.trendLane must be an object { enabled, retestTol, wickMin, stopTicks, capHour, capDay, climax }';
  const p = [];
  for (const k of Object.keys(c)) if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k) || k === 'tick') p.push(`unknown setting "tide.trendLane.${k}"`);
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') p.push('tide.trendLane.enabled must be true or false');
  for (const [k, lo, hi] of [['retestTol', 0, 50], ['wickMin', 0, 50], ['stopTicks', 0, 40]]) if (c[k] !== undefined && !(isNum(c[k]) && c[k] >= lo && c[k] <= hi)) p.push(`tide.trendLane.${k} must be a number ${lo}-${hi}`);
  for (const [k, lo, hi] of [['capHour', 1, 20], ['capDay', 1, 60], ['swingBars', 3, 96], ['minAge30', 0, 29]]) if (c[k] !== undefined && !(Number.isInteger(c[k]) && c[k] >= lo && c[k] <= hi)) p.push(`tide.trendLane.${k} must be a whole number ${lo}-${hi}`);
  if (c.climax !== undefined && !CLIMAX_MODES.includes(c.climax)) p.push('tide.trendLane.climax must be "defense-confirms" or "block"');
  return p.length ? p.join('; ') : null;
}
const tradeDayOf = T => T - (T % 60) - ((((S().ptMin(T) - 900) % 1440) + 1440) % 1440) * 60;   // the 15:00 PT start of this TradeDay (unix sec)
const hourOf = T => T - (T % 3600);

function create(cfgIn) {
  const cfg = cfgOf(cfgIn);
  const L = { v: VERSION, last5T: null, armed: {}, idleSeen: {}, entries: [], lastSigT: null };   // entries: [T] of TAKEN lane entries (the hour / day caps)
  const row = (phase, T, data) => ({ phase, event: 'TREND_' + phase.replace('trend_', '').toUpperCase(), t: T * 1000, at: S().ptLabel(T), lane: 'trend', ...data });
  const prune = T => { L.entries = L.entries.filter(t => T - t < 86400 + 3600); for (const o of [L.armed, L.idleSeen]) for (const k of Object.keys(o)) if (T - o[k] > 7200) delete o[k]; };
  function counts(T) { const h = hourOf(T), d = tradeDayOf(T); return { hour: L.entries.filter(t => hourOf(t) === h).length, day: L.entries.filter(t => tradeDayOf(t) === d).length }; }

  // st = the engine state after its step on the 1m bar that closed at T (unix sec); board = the executor's level board [{ name, price }] (may be empty).
  // -> { signal: null | sig, rows: [] }
  function step(st, T, board) {
    const rows = []; if (!cfg.enabled || !st || !st.bars) return { signal: null, rows };
    const m5 = st.bars.m5, bar = m5[m5.length - 1];
    if (!bar || bar.t === L.last5T || bar.t + 300 !== T) return { signal: null, rows };   // only the 1m close that CLOSED a 5m bar
    L.last5T = bar.t; prune(T);
    const idle = why => { const k = `${Math.floor(T / 900)}|${why.split(' (')[0]}`; if (!L.idleSeen[k]) { L.idleSeen[k] = T; rows.push(row('trend_idle', T, { why })); } return { signal: null, rows }; };
    // STEP 1 DIR: the previous 4H candle's close direction
    const H = st.htf, p4 = H && H.prev4h; if (!p4) return idle('no 4H direction (no completed 4H candle yet)');
    const dir = p4.dir; if (!(dir === 1 || dir === -1)) return idle('no 4H direction (prior 4H flat)');
    const dirEv = { prev4h: { at: p4.at, o: r2(p4.o), c: r2(p4.c), dir: p4.dir }, open4h: st.period && isNum(st.period.O4) ? r2(st.period.O4) : null, htfDir: H.dir };
    // STEP 2 HARMONY: the last COMPLETED 30M candle closed in DIR
    const m30 = st.bars.m30, cur30 = st.cur.m30 || null, last30 = cur30 ? m30[m30.length - 1] : m30[m30.length - 2], open30 = cur30 ? cur30.o : (m30.length ? m30[m30.length - 1].o : null);
    if (!last30 || !isNum(open30)) return idle('30M not in harmony (no completed 30M candle yet)');
    const h30 = { open30: r2(open30), last30: { at: S().ptLabel(last30.t), o: r2(last30.o), c: r2(last30.c), dir: Math.sign(last30.c - last30.o) } };
    if (!(dir * (last30.c - last30.o) > 0)) return idle(`30M not in harmony (last 30M closed ${last30.c === last30.o ? 'flat' : 'against DIR'} at ${S().ptLabel(last30.t)})`);
    // STEP 3 references: every level the bot tracks (the board), the TIDE zones, the 4H / 1H / 30M / 15m opens, the last 15m swing. Nearest to the close wins.
    const refs = [];
    const add = (name, price, kind) => { if (!isNum(price)) return; const q = refs.find(r => Math.abs(r.price - price) <= 0.5); if (q) { if (!q.name.split(' + ').includes(name)) q.name += ' + ' + name; return; } refs.push({ name, price, kind }); };
    add('30M Open', open30, 'open'); if (st.period && isNum(st.period.O4)) add('4H Open', st.period.O4, 'open');
    { const cur1 = st.cur.h1 || null, h1 = st.bars.h1; add('1H Open', cur1 ? cur1.o : (h1.length ? h1[h1.length - 1].o : null), 'open');
      const m15 = st.bars.m15, cur15 = st.cur.m15 || null; add('15m Open', cur15 ? cur15.o : (m15.length ? m15[m15.length - 1].o : null), 'open');
      const n = m15.length, from = n ? m15[Math.max(0, n - cfg.swingBars)].t : null, piv = st.piv && st.piv.m15 ? (dir > 0 ? st.piv.m15.lo : st.piv.m15.hi) : [];
      const sw = from === null ? [] : piv.filter(p => p.t >= from && p.confT <= T); if (sw.length) add(dir > 0 ? '15m swing low' : '15m swing high', sw[sw.length - 1].price, 'swing'); }
    for (const z of st.zones || []) if (z.src !== 'round') add(z.name, z.price, 'zone');
    const Lv = st.levels || {}; for (const [k, nm] of [['PDH', 'PDH'], ['PDL', 'PDL'], ['AsiaH', 'Asia High'], ['AsiaL', 'Asia Low'], ['LonH', 'London High'], ['LonL', 'London Low']]) add(nm, Lv[k], 'board');
    for (const b of Array.isArray(board) ? board : []) if (b && typeof b.name === 'string' && isNum(b.price) && !/round/i.test(b.name)) add(b.name, b.price, 'board');
    // arm rows: a 5m extreme within retestTol of R against DIR (once per R per 15m; the nearest 3)
    const ext = dir > 0 ? bar.l : bar.h, wick = dir > 0 ? Math.min(bar.o, bar.c) - bar.l : bar.h - Math.max(bar.o, bar.c);
    const arms = refs.filter(r => dir * (ext - r.price) <= cfg.retestTol && dir * (bar.c - r.price) > 0 && !L.armed[`${Math.floor(T / 900)}|${r.price}`]).sort((a, b) => Math.abs(a.price - bar.c) - Math.abs(b.price - bar.c)).slice(0, 3);
    for (const r of arms) { L.armed[`${Math.floor(T / 900)}|${r.price}`] = T; rows.push(row('trend_arm', T, { dir, R: r2(r.price), kind: r.kind, name: r.name, ext: r2(ext), dirEv, h30 })); }
    // the trigger: a completed 5m candle that traded at R and closed on the DIR side of R - a rejection (wick >= wickMin) or a break-and-close
    const trig = [];
    for (const r of refs) {
      if (!(dir * (bar.c - r.price) > 0)) continue;   // the close must be on the DIR side of R
      const openDirSide = dir * (bar.o - r.price) > 0, touched = dir * (ext - r.price) <= cfg.retestTol;
      if (openDirSide && touched && wick >= cfg.wickMin) trig.push({ ...r, trigger: 'reject' });
      else if (!openDirSide) trig.push({ ...r, trigger: 'break' });
    }
    if (!trig.length) return { signal: null, rows };
    trig.sort((a, b) => Math.abs(a.price - bar.c) - Math.abs(b.price - bar.c));
    // the STOP (Mac 11/05: "beyond the 30 minute wick"): the extreme against DIR of the 30M candle the trigger 5m closed in, 2 ticks beyond; a 30M candle younger
    // than minAge30 at the trigger gives way to the previous completed 30M's extreme (never behind a 2-minute-old wick). The trigger 5m's own extreme is always covered.
    const b30 = cur30 && cur30.t <= bar.t ? cur30 : (m30.length && m30[m30.length - 1].t <= bar.t ? m30[m30.length - 1] : null), age30 = b30 ? T - b30.t : null;
    const young = b30 && age30 < cfg.minAge30 * 60, prev30 = young ? (b30 === cur30 ? m30[m30.length - 1] : m30[m30.length - 2]) || null : null;
    const wickBar = young && prev30 ? prev30 : b30, basis = young && prev30 ? 'prev-30m-wick' : b30 ? '30m-wick' : '5m-extreme';
    const wickExt = wickBar ? (dir > 0 ? Math.min(wickBar.l, ext) : Math.max(wickBar.h, ext)) : ext;
    const R = trig[0], entry = bar.c, stop = dir > 0 ? wickExt - cfg.stopTicks * cfg.tick : wickExt + cfg.stopTicks * cfg.tick, risk = Math.abs(entry - stop);
    const stopEv = { basis, at: wickBar ? S().ptLabel(wickBar.t) : null, t30: wickBar ? wickBar.t * 1000 : null, wick: r2(wickExt), age30Min: age30 !== null ? Math.round(age30 / 60) : null };
    const climax = st.climax ? { dir: st.climax.dir, at: S().ptLabel(st.climax.T), sameWay: st.climax.dir === dir } : null;
    const base = { dir, side: dir > 0 ? 'LONG' : 'SHORT', trigger: R.trigger, level: { name: R.name, price: r2(R.price), kind: R.kind }, entry: r2(entry), stop: r2(stop), stopPts: r2(risk), stopBasis: basis, stopEv, R: r2(R.price), rKind: R.kind, rName: R.name,
      def: { t: bar.t * 1000, at: S().ptLabel(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, ext: r2(ext), wick: r2(wick) }, climax, dirEv, h30, others: trig.slice(1, 4).map(x => ({ name: x.name, price: r2(x.price), trigger: x.trigger })) };
    const skip = why => { rows.push(row('trend_skip', T, { ...base, why })); return { signal: null, rows }; };
    if (!(risk > 0)) return skip('NO_STOP: the trigger candle has no extreme beyond the entry');
    if (cfg.climax === 'block' && climax && climax.sameWay) return skip(`CLIMAX: a ${dir > 0 ? 'buying' : 'selling'} climax at ${climax.at} blocks the entry (tide.trendLane.climax "block")`);
    const c = counts(T);
    if (c.hour >= cfg.capHour) return skip(`CAP_HOUR: ${c.hour} trend entries this clock hour (cap ${cfg.capHour})`);
    if (c.day >= cfg.capDay) return skip(`CAP_DAY: ${c.day} trend entries this TradeDay (cap ${cfg.capDay})`);
    const targets = buildTargets(st, dir, entry, risk, board);
    const id = `TL${dir > 0 ? 'L' : 'S'}-${T}`;
    L.lastSigT = T;
    const sig = { id, setupId: id, leg: 'entry', t: T, at: S().ptLabel(T), dir, side: base.side, kind: 'trend', lane: 'trend',
      level: { name: R.name, price: R.price, members: [R.name] }, zone: { lo: R.price, hi: R.price, key: `trend|${R.kind}@${R.price}`, type: R.kind },
      entryType: 'market', entryPrice: entry, addZone: null,
      stops: { structural: stop, stopType: '30M', rule: `${basis} ${stopEv.at || ''}: the 30M candle's extreme against DIR ${dir > 0 ? '-' : '+'} ${cfg.stopTicks} ticks (trend lane ${R.trigger}; never tightened)`, basis, wick: wickExt }, chosenStop: stop, riskPts: r2(risk),
      grade: 'C', gradePoints: {}, gradeTotal: 0, gradeGates: {}, gradeWaived: [], gradeDetail: {}, tags: ['trend-lane', R.trigger],
      gradeEvidence: { lane: 'trend', trigger: R.trigger, level: base.level, def: base.def, dirEv, h30, climax, caps: c },
      targets, pools: targets, internalPools: targets.filter(t => !t.major), contextPools: [], marketState: st.mstate ? Object.assign({}, st.mstate) : null,
      control: st.period && st.period.control ? { dir: st.period.control.dir, kind: st.period.control.kind } : null,
      defended: { price: R.price, name: R.name, kind: R.kind }, shift: null, retest: { n: 1, extreme: ext, at: S().ptLabel(bar.t) },
      warnings: [], reason: [`trend lane ${R.trigger}: DIR ${dir > 0 ? 'up' : 'down'} (prior 4H ${p4.at} closed ${p4.dir > 0 ? 'bullish' : 'bearish'}), 30M harmony (last 30M ${h30.last30.at} closed ${dir > 0 ? 'up' : 'down'}, 30M open ${r2(open30)}), 5m ${R.trigger} at ${R.name} ${r2(R.price)} (close ${r2(entry)}, extreme ${r2(ext)})`],
      htf: H.dir === dir ? 'with' : H.dir === 0 ? 'neutral' : 'against', htfDir: H.dir, riskMult: 1, htfView: { prev4h: { dir: p4.dir, hh: p4.hh, ll: p4.ll }, daily: H.daily ? H.daily.side : 0, cur4h: H.cur4h ? H.cur4h.side : 0 },
      trend: base };
    return { signal: sig, rows };
  }
  // tideWire tells the lane whether its signal was TAKEN (an entry): the caps count entries, not signals
  function note(sig, taken, T) { if (sig && sig.lane === 'trend' && taken) { L.entries.push(isNum(T) ? T : sig.t); prune(isNum(T) ? T : sig.t); } }
  function describe() { return `trend lane ${cfg.enabled ? 'ON' : 'OFF'} (retestTol ${cfg.retestTol}, cap ${cfg.capHour}/h ${cfg.capDay}/day, reject wick ${cfg.wickMin}, stop ${cfg.stopTicks} ticks, climax ${cfg.climax})`; }
  return { VERSION, cfg, step, note, counts, describe, state: () => L };
}
// the ordered pools in the trade direction (the money rule picks TP1 / TP2): zone members (never Rounds), the board's levels, 1H / 4H swings
function buildTargets(st, d, entry, risk, board) {
  const out = [], tick = 0.25;
  const add = (price, name, kind, major, weight) => { if (isNum(price) && (d < 0 ? price < entry - tick : price > entry + tick)) out.push({ price, name, kind, major: !!major, weight: weight || null, touches: null }); };
  for (const z of st.zones || []) for (const m of z.members || []) if (m.src !== 'round') add(m.price, m.name, m.src, m.major || MAJOR.has(m.name), m.weight);
  const Lv = st.levels || {};
  for (const [k, nm] of [['PDH', 'PDH'], ['PDL', 'PDL'], ['AsiaH', 'Asia High'], ['AsiaL', 'Asia Low'], ['LonH', 'London High'], ['LonL', 'London Low']]) add(Lv[k], nm, 'board', true, k.startsWith('PD') ? 'strong' : 'obvious');
  for (const b of Array.isArray(board) ? board : []) if (b && typeof b.name === 'string' && isNum(b.price) && !/round/i.test(b.name)) add(b.price, b.name, 'board', /^P[DWMQ][HL]$|^PDH|^PDL/.test(b.name), 'obvious');
  const piv = st.piv || {};
  for (const p of ((piv.h1 && (d < 0 ? piv.h1.lo : piv.h1.hi)) || []).slice(-8)) add(p.price, d < 0 ? '1H swing low' : '1H swing high', 'swing1h', false, 'obvious');
  for (const p of ((piv.h4 && (d < 0 ? piv.h4.lo : piv.h4.hi)) || []).slice(-6)) add(p.price, d < 0 ? '4H swing low' : '4H swing high', 'swing4h', true, 'strong');
  out.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const ded = [];
  for (const t of out) { const q = ded.find(x => Math.abs(x.price - t.price) <= 0.5); if (q) { if (!q.name.split(' + ').includes(t.name)) q.name += ` + ${t.name}`; q.major = q.major || t.major; continue; } ded.push(t); }
  let minors = 0;
  return ded.filter(t => t.major || ++minors <= 12).map(t => Object.assign(t, { distancePts: r2(Math.abs(t.price - entry)), distanceR: risk > 0 ? r2(Math.abs(t.price - entry) / risk) : null }));
}

module.exports = { VERSION, DEFAULTS, CLIMAX_MODES, cfgOf, configProblem, create, buildTargets, tradeDayOf, hourOf };
