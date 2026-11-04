'use strict';
// TIDE r2 WIRING (lv1 new model, MacTide): the executor-side glue between live-executor.js, the structure engine (lib/structure.js, MacStructure) and the
// grade sizing / exits (lib/moneyRule.js, MacMoney; imported unchanged). Shipped OFF: tide.mode "off", money.sizing.enabled false.
// With tide.mode "off" the executor calls nothing here except configProblem() / startupLines() at startup (identity with r13.3.7).
//
// STAGE 1 (MacArthur 11/04 deadline plan): this build accepts tide.mode "off" | "shadow" only. Shadow = the engine runs on the bot's own closed 1m bars,
// level board and bias readings, and every signal is JOURNALED (levels journal, lv_tide rows) and PUSHED to the phone with the plan it would get (grade,
// size per leg, stop, TP1, TP2, the scale-in / upgrade / pyramid adds). shadowStep() is handed no order function, no state machine and no takeEntry: it
// can only return rows and push lines. "add" / "only" (the order paths) are Stage 2 and are refused at startup (CONFIG-LOCAL ERROR).
//
// Playbook (knowledge/MAC-TRADING-PLAYBOOK.md): §1/§2 direction from the 4H only; §5 option C stops (strict: 4H-type level / trap -> the 4H wick, hour-type ->
// the 1H wick, never a tighter wick to fit); §17/§19 grade-dollar sizing, MNQ only; §22 entry by grade (A+ all at once, B half + half at the retest / FVG,
// C one entry, the grade-upgrade add up to the A+ dollars at the SAME stop); §18/§21 TP1 2/3 at the first pool, break-even, one house-money pyramid add of
// 1/3, TP2 everything at the pool >= 2R; §20 protection (the money ladder). NO daily loss limit of any kind (§17): there is no day / loss counter here.
const path = require('path');
const moneyRule = require('./moneyRule');   // money-r4.1 (MacMoney; pure, no requires; imported unchanged)

const VERSION = 'tide-wire-r2.5-live';   // r2.5: + tide.mode "live" (Stage 2a, MacLive 11/04): the live takes go to lib/tideLive.js (planner tideOrders r1.2)
const STAGE = 1;
const MODES = Object.freeze(['off', 'shadow', 'add', 'only']);
const STAGE_MODES = Object.freeze(STAGE === 1 ? ['off', 'shadow', 'live'] : MODES.slice());   // [2a] + 'live' (armed only by tools/set-tide.sh live)
const LIVE_ARM = 'set-tide.sh live (stage 2a)';   // [2a] the token set-tide.sh live writes as tide.liveArmed: a hand-typed tide.mode "live" alone is refused
// Mac 11/04 FINAL (SPEC GRADE r3 + TIME BLOCKS): the new model IGNORES the old time blocks (useTimeBlocks false) and has its own open wait (openWaitMin 30)
const DEFAULTS = Object.freeze({ tide: Object.freeze({ mode: 'off', useTimeBlocks: true, openWaitMin: 30, push: true, liveArmed: null, oldPathEntries: false, blocks: Object.freeze([Object.freeze(['15:00', '17:00']), Object.freeze(['06:30', '07:10'])]) }) });   // [2a r1.1] TIDE's OWN entry blocks (PT, start inclusive, end exclusive), independent of the old path's keys   // [2a] liveArmed (set-tide.sh live only); oldPathEntries: with tide.mode "live" the old levels path takes NO new entries unless true
// what the new model does NOT take (playbook §1, SPEC E "DO NOT APPLY"; money EXEMPT) and what it keeps (SPEC E "STILL APPLY")
const VETOES_SKIPPED = Object.freeze(['HTF_ALIGN', 'CONTROL_GATE', 'NO_CHASE', 'CANDLE_WAIT', 'STOP_FLOOR', 'STOP_CAP_FROM_FILL', 'NO_PROGRESS', 'TIME_STOP', 'SCALE_OUT_RUNNER']);
const GATES_KEPT = Object.freeze(['DESYNCED', 'NOT_FLAT', 'SESSION_CLOSE', 'OPEN_WAIT', 'NEWS_WAIT', 'PAUSED']);   // TIME_BLOCK only with tide.useTimeBlocks true
// journal bounds (the levels journal has its own 256 KB / row and 40 MB / day caps): rows per engine step, and the chatty engine rows kept only for setups
// that produced a signal
const ROWS_PER_STEP = 40;
const SETUP_ONLY = new Set(['GRADE_LIVE', 'SIGNAL_SKIP', 'RETEST_2_SKIP']);

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const r2 = x => (isNum(x) ? Math.round(x * 100) / 100 : null);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ascii = s => String(s).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();

let structureLib = null;
function structure() { if (!structureLib) structureLib = require(path.join(__dirname, 'structure.js')); return structureLib; }   // loaded only when tide.mode is not "off"
function setStructureForTest(s) { structureLib = s; }

// ------------------------------------------------------------------ sizing (money-r4 owns it; this file only reads it)
// money.sizing.mode "flat" (shipped, team position 11/04 "common risk first"): every grade risks flatDollars (450 = a placeholder until Mac decides), every grade
// all at once (entryByGrade false), no grade-upgrade add. mode "grade": the grade dollars gradeRiskUsd { A: 900, B: 600, C: 300 } (playbook §17); with
// entryByGrade true the §22 styles (A+ all at once, B half + half resting, C one entry); upgradeAdd.enabled for the §22 top-up. Switching is config only.
// Every signal also carries moneyRule.shadowSize(): the size of the OTHER mode at the same stop, for the journal and the phone (logging only, never placed).
function moneyDefaults() { const d = JSON.parse(JSON.stringify(moneyRule.DEFAULTS)); d.sizing.flatDollars = 400; d.sizing.noFit = 'take1'; d.sizing.take1MaxUsd = 400; d.sizing.nearFloor = { enabled: false, cushionUsd: 1000, dollars: 200 }; return d; }   // [2a] Mac 11/04 07:45Z (50K combine size from the first trade): flat $400; noFit take1 = 1 MNQ only while its risk <= take1MaxUsd $400 (else GRADE_NO_FIT_CEILING); nearFloor $1,000 -> $200
// [2a] sizing.take1MaxUsd is TIDE's own key (money-r4.1 has no ceiling): it is taken out before every money-r4.1 call and applied here, after the size
const TAKE1_MAX_DEFAULT = 400;
function moneyOnly(money) { if (!isObj(money)) return money; const m = { ...money }; if (isObj(m.sizing) && Object.prototype.hasOwnProperty.call(m.sizing, 'take1MaxUsd')) { const { take1MaxUsd, ...rest } = m.sizing; m.sizing = rest; } return m; }
function take1Max(cfg) { const s = cfg && cfg.money && cfg.money.sizing; return s && isNum(s.take1MaxUsd) ? s.take1MaxUsd : TAKE1_MAX_DEFAULT; }   // [2a] Mac 11/04: flat $300 is the live default (money-r4.1 itself unchanged)   // shipped CONFIG.money: mode "flat" written out (the startup line shows it)
function sizingMode(cfg) { const s = cfg && cfg.money && cfg.money.sizing; return s && typeof s.mode === 'string' ? s.mode : moneyRule.DEFAULTS.sizing.mode; }

// ------------------------------------------------------------------ config
// cfg = the executor's CONFIG (cfg.tide, cfg.money). ctx = { symbol, pointValue, minContracts } for moneyRule.problem. -> null | text
function configProblem(cfg, ctx) {
  const p = [], t = cfg && cfg.tide;
  if (!isObj(t)) p.push('tide must be an object');
  else {
    for (const k of Object.keys(t)) if (!Object.prototype.hasOwnProperty.call(DEFAULTS.tide, k)) p.push(`unknown setting "tide.${k}"`);
    if (!STAGE_MODES.includes(t.mode)) p.push(`tide.mode must be one of ${STAGE_MODES.map(x => JSON.stringify(x)).join(', ')}${STAGE === 1 ? ' in this Stage-1 build ("add" / "only" come with Stage 2)' : ''}, got ${JSON.stringify(t.mode)}`);
    if (typeof t.useTimeBlocks !== 'boolean') p.push(`tide.useTimeBlocks must be true or false, got ${JSON.stringify(t.useTimeBlocks)}`);
    if (typeof t.push !== 'boolean') p.push(`tide.push must be true or false, got ${JSON.stringify(t.push)}`);
    if (!(Number.isInteger(t.openWaitMin) && t.openWaitMin >= 0 && t.openWaitMin <= 120)) p.push(`tide.openWaitMin must be a whole number of minutes 0-120, got ${JSON.stringify(t.openWaitMin)}`);
    if (t.mode === 'live' && t.liveArmed !== LIVE_ARM) p.push(`tide.mode "live" (Stage 2a: REAL TIDE orders) is accepted only when tools/set-tide.sh live set it (tide.liveArmed), got ${JSON.stringify(t.liveArmed)}`);   // [2a]
    if (t.liveArmed != null && t.liveArmed !== LIVE_ARM) p.push(`tide.liveArmed must be unset or written by tools/set-tide.sh live, got ${JSON.stringify(t.liveArmed)}`);   // [2a]
    if (t.blocks !== undefined && !(Array.isArray(t.blocks) && t.blocks.every(w => Array.isArray(w) && w.length === 2 && w.every(x => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x)) && hhmm(w[0]) < hhmm(w[1])))) p.push(`tide.blocks must be a list of ["HH:MM", "HH:MM"] PT windows (start before end), got ${JSON.stringify(t.blocks)}`);   // [2a r1.1]
    if (typeof t.oldPathEntries !== 'boolean') p.push(`tide.oldPathEntries must be true or false, got ${JSON.stringify(t.oldPathEntries)}`);   // [2a]
    if (t.mode === 'live') { const op = require('./tideOrders').configProblem({ ...moneyOnly(cfg && cfg.money), pointValue: ctx && ctx.pointValue, tickSize: 0.25 }); if (op) p.push(`tide.mode "live": ${op}`); }   // [2a] the planner refuses (entryByGrade / upgradeAdd)
    if (t.mode !== 'off' && ctx && ctx.symbol && ctx.symbol !== 'MNQ') p.push(`tide.mode ${JSON.stringify(t.mode)} is MNQ only (Mac 11/04), this bot runs ${ctx.symbol}: use "off"`);
  }
  const tm = cfg && cfg.money && cfg.money.sizing ? cfg.money.sizing.take1MaxUsd : undefined;
  if (tm !== undefined && !(isNum(tm) && tm > 0 && tm <= 5000)) p.push(`money.sizing.take1MaxUsd must be a dollar amount 1-5000, got ${JSON.stringify(tm)}`);   // [2a]
  const m = moneyRule.problem(moneyOnly(cfg && cfg.money), ctx);
  if (m) p.push(`money: ${m}`);
  if (STAGE === 1 && cfg && cfg.money && cfg.money.sizing && cfg.money.sizing.enabled === true) p.push('money.sizing.enabled must stay false in this Stage-1 build (shadow journals the grade size it WOULD take; real sizing comes with Stage 2)');
  return p.length ? p.join('; ') : null;
}
function modeOf(cfg) { const m = cfg && cfg.tide && cfg.tide.mode; return STAGE_MODES.includes(m) ? m : 'off'; }
// floorDistanceUsd (money-r4.1 near-floor guard, read only when money.sizing.nearFloor.enabled): balance - the executor's trailing floor; null = unknown (the lib fails safe)
function moneyCfg(cfg, pointValue = 2, tickSize = 0.25, floorDistanceUsd = null) { return { ...moneyOnly(cfg && cfg.money), pointValue, tickSize, floorDistanceUsd: isNum(floorDistanceUsd) ? floorDistanceUsd : null }; }
function gradeUsd(cfg) { const m = cfg && cfg.money, g = (m && m.sizing && m.sizing.gradeRiskUsd) || {}, d = moneyRule.DEFAULTS.sizing.gradeRiskUsd; return { A: isNum(g.A) ? g.A : d.A, B: isNum(g.B) ? g.B : d.B, C: isNum(g.C) ? g.C : d.C }; }
function maxContracts(cfg) { const s = cfg && cfg.money && cfg.money.sizing; return s && isNum(s.maxContracts) ? s.maxContracts : moneyRule.DEFAULTS.sizing.maxContracts; }
function startupLines(cfg, pointValue = 2, tickSize = 0.25) {
  const m = modeOf(cfg), t = cfg.tide, g = gradeUsd(cfg);
  const what = { off: 'off (tide.mode "off" - the bot trades as r13.3.7)', shadow: `SHADOW (journal + phone only: every TIDE signal is journaled as lv_tide in the levels journal${t.push ? ' and pushed as "TIDE SHADOW ..."' : ''}; NO order is ever sent)`, add: 'ADD', only: 'ONLY', live: `LIVE (Stage 2a: REAL orders for TIDE signals through the tideOrders r1.2 planner: entry, one stop, TP1 2/3, BE + 1 tick, TP2, the R-ladder / climax, the planner's flatten; no pyramid add, no resting half; one position account-wide; the old levels path ${t.oldPathEntries ? 'STILL takes new entries (tide.oldPathEntries true)' : 'takes NO new entries (it still manages anything already open)'})` }[m];
  const sz = (cfg.money && cfg.money.sizing) || {}, gg = gradeUsd(cfg), ebg = sz.entryByGrade === true, up = !!(sz.upgradeAdd && sz.upgradeAdd.enabled === true);
  const entryTxt = ebg ? 'A+ all at once, B half + half at the retest, C one entry' : 'every grade all at once', noFit = sz.noFit === 'take1' ? `no fit = 1 MNQ while its risk <= $${take1Max(cfg)} (take1MaxUsd; over budget logged + pushed), above = skip (GRADE_NO_FIT_CEILING)` : 'no fit = skip';
  const sizes = sizingMode(cfg) === 'flat' ? `mode flat $${sz.flatDollars} per trade at every grade (the grade size A+ $${gg.A} / B $${gg.B} / C $${gg.C} journaled beside it), ${entryTxt}, ${noFit}, upgrade add ${up ? 'on (grade mode only)' : 'off'}`
    : `mode grade A+ $${gg.A} / B $${gg.B} / C $${gg.C} per trade (the flat $${sz.flatDollars} size journaled beside it), ${entryTxt}, ${noFit}, upgrade add ${up ? 'on' : 'off'}`;
  return [
    `[tide] new model ${VERSION} (stage ${STAGE}): ${what}${m === 'off' ? '' : `; engine ${safeEngineVersion()}; ${m === 'live' ? 'LIVE sizes' : 'shadow sizes'} ${sizes} (MNQ, max ${maxContracts(cfg)}); TIDE entry blocks ${blocksText(cfg)}; TIDE open wait ${t.openWaitMin} min after 15:00 / 00:00 / 06:30 PT and each 4H open; news wait + session close kept; not applied to TIDE: HTF_ALIGN, the 15m control-gate veto, levels noChase, candle wait, stop cap / floor, timed exits; NO daily loss limit`}.`,
    moneyRule.startupLine(moneyCfg(cfg, pointValue, tickSize)),
    moneyRule.configLine(moneyCfg(cfg, pointValue, tickSize)),   // '[money] config money-r4.1: ...' (tools/set-tide-money.sh confirms a switch from it)
  ];
}
function safeEngineVersion() { try { const s = structure(); return s.VERSION || s.STUB_VERSION || 'structure'; } catch (e) { return `unavailable (${e.message})`; } }

// ------------------------------------------------------------------ TIDE's own open wait (Mac 11/04 FINAL): no new-model entry in the first openWaitMin minutes
// after a session open (15:00 Asia, 00:00 London, 06:30 NY, PT) or a 4H open (15:00, 19:00, 23:00, 03:00, 07:00, 11:00 PT). Pure: Intl America/Los_Angeles.
const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
// [2a r1.1] TIDE's own entry blocks: the PT window that holds ms (start inclusive, end exclusive) -> 'TIDE block HH:MM-HH:MM PT', else null. Only with tide.useTimeBlocks true.
function hhmm(s) { const m = /^(\d{2}):(\d{2})$/.exec(String(s)); return m ? +m[1] * 60 + +m[2] : NaN; }
function tideBlocks(cfg) { const b = cfg && cfg.tide && Array.isArray(cfg.tide.blocks) ? cfg.tide.blocks : DEFAULTS.tide.blocks; return b.filter(w => Array.isArray(w) && w.length === 2 && hhmm(w[0]) < hhmm(w[1])); }
function blockAt(cfg, ms) { if (!(cfg && cfg.tide && cfg.tide.useTimeBlocks === true)) return null; const m = ptMinute(ms); for (const w of tideBlocks(cfg)) if (m >= hhmm(w[0]) && m < hhmm(w[1])) return `TIDE block ${w[0]}-${w[1]} PT`; return null; }
function blocksText(cfg) { return cfg && cfg.tide && cfg.tide.useTimeBlocks === true ? `ON (${tideBlocks(cfg).map(w => w[0] + '-' + w[1]).join(', ')} PT)` : 'OFF'; }
function ptMinute(ms) { const o = {}; for (const x of PT_FMT.formatToParts(new Date(ms))) o[x.type] = x.value; return (+o.hour % 24) * 60 + (+o.minute); }
const SESSION_OPENS = Object.freeze([['Asia open', 900], ['London open', 0], ['NY open', 390]]);
function openWait(nowMs, minutes) {
  if (!isNum(nowMs) || !(minutes > 0)) return null;
  const m = ptMinute(nowMs), since = a => ((m - a) % 1440 + 1440) % 1440;
  for (const [name, a] of SESSION_OPENS) if (since(a) < minutes) return `${name} + ${since(a)} min (wait ${minutes})`;
  const h4 = ((m - 900) % 240 + 240) % 240; if (h4 < minutes) return `4H open + ${h4} min (wait ${minutes})`;
  return null;
}

// ------------------------------------------------------------------ gates (SPEC E "still apply"), pure. shadow: journal note only.
// ctx: { mode, flat, desynced, sessionNoEntry, openWait (reason|null), timeBlock (reason|null), useTimeBlocks, newsWait (reason|null), paused }
function tideGate(ctx) {
  const c = ctx || {};
  if (c.mode !== 'add' && c.mode !== 'only') return { ok: false, code: c.mode === 'shadow' ? 'TIDE_SHADOW' : 'TIDE_OFF' };
  if (c.desynced) return { ok: false, code: 'DESYNCED' };
  if (c.flat !== true) return { ok: false, code: 'NOT_FLAT' };
  if (c.sessionNoEntry) return { ok: false, code: 'SESSION_CLOSE' };
  if (c.openWait) return { ok: false, code: 'OPEN_WAIT', why: String(c.openWait) };
  if (c.useTimeBlocks === true && c.timeBlock) return { ok: false, code: 'TIME_BLOCK', why: String(c.timeBlock) };   // the old blocks only when asked (default false)
  if (c.newsWait) return { ok: false, code: 'NEWS_WAIT', why: String(c.newsWait) };
  if (c.paused) return { ok: false, code: 'PAUSED' };
  return { ok: true, code: 'OK' };
}

// ------------------------------------------------------------------ grade: the ENGINE's table decides (SPEC GRADE r3 FINAL: gates + 5 equal points, A+ 4-5 / B 3 /
// C 0-2, wave peak >= 0.40 caps at C). The wiring never re-grades: a signal without a grade is no trade (GRADE_NONE). pointNames() is for the phone.
const POINT_LABEL = [[/trap/i, 'trap'], [/force|displacement/i, 'force'], [/volume/i, 'volume'], [/timing/i, 'timing'], [/impulse/i, 'impulse'], [/firstRetest/i, 'first retest'],
  [/biasStrong|strong/i, 'strong bias'], [/grow/i, 'growing']];
function pointNames(points) {
  if (!isObj(points)) return [];
  const out = []; for (const [k, v] of Object.entries(points)) if ((v === true || (isNum(v) && v > 0))) { const l = POINT_LABEL.find(([re]) => re.test(k)); const n = l ? l[1] : k; if (!out.includes(n)) out.push(n); }
  return out;
}

// ------------------------------------------------------------------ plan: what one TIDE signal (one leg) gets. Shadow journals it; Stage 2 orders it.
// sig = normSignal(...): { dir, entry, stop, stopTf, levelName, kind, grade, gradePoints, leg ('trigger'|'retest'|'upgrade-add'), entryType, pools[], internalPools[], addZone }
// prior = what this setup already holds (shadow memory, or the open trade in Stage 2): { grade, points, stop (the structural stop it was sized at), legs:[{price, contracts}],
//   second (the resting B half: RESERVED until terminal), secondPx, tp1Done, tp1Px, bestPx, upgraded } | null. Unknown lifecycle fields = moneyRule refuses (fail closed).
// -> { ok, code?, mode, budgetUsd, grade, gradeDetail, leg, legNote, stop, stopTf, stopPts, qty (this leg), total, planned, first, second, reservedQty, riskUsd, totalRiskUsd,
//      exits (moneyRule.planExits on the combined legs), addQty (the D4 pyramid after TP1), shadow (moneyRule.shadowSize, first leg only), upgrade (row) }
function legRisk(legs, stop, dir, pv) { return legs.reduce((a, l) => a + l.contracts * Math.max(0, dir * (l.price - stop)) * pv, 0); }
function plan(sig, cfg, pointValue = 2, tickSize = 0.25, prior = null, floorDistanceUsd = null) {
  const mc = moneyCfg(cfg, pointValue, tickSize, floorDistanceUsd), dir = sig && sig.dir, entry = sig && sig.entry, pv = pointValue, mode = sizingMode(cfg);
  if (!(dir === 1 || dir === -1) || !isNum(entry)) return { ok: false, code: 'TIDE_BAD_SIGNAL' };
  const g = { grade: sig.grade ? String(sig.grade) : null, points: isNum(sig.gradePoints) ? sig.gradePoints : null, names: pointNames(sig.pointDetail), capTag: sig.capTag || null, reason: 'engine' };
  // MacDot money-r3 review (d) / money-r4: the grade comes ONLY from the structure engine's GRADE r3 table (moneyRule.gradeOf is never called); a grade without its
  // point total is missing evidence = no trade
  if (!g.grade || !moneyRule.gradeKey(g.grade) || !isNum(g.points)) return { ok: false, code: 'GRADE_NONE', mode, grade: g.grade || null, gradeDetail: g };
  const leg = sig.leg === 'upgrade-add' ? 'upgrade-add' : sig.leg === 'retest' ? 'retest' : sig.leg === 'trigger' ? 'trigger' : 'entry';
  const held = prior && Array.isArray(prior.legs) && prior.legs.length ? prior.legs.filter(l => l && isNum(l.price) && Number.isInteger(l.contracts) && l.contracts > 0) : [];
  const isTrap = sig.kind === 'trap';
  // option C strict (playbook §5): the engine's structural stop and its wick type; a later leg keeps the FIRST leg's stop (§22 "the SAME structural stop")
  const stopPx = held.length && prior && isNum(prior.stop) ? prior.stop : sig.stop;
  const tf0 = String(sig.stopTf || moneyRule.levelStopTf(sig.levelName, isTrap) || '4H').toUpperCase(), tf = tf0 === 'H' ? '1H' : tf0;
  if (!isNum(stopPx) || !(dir === 1 ? stopPx < entry : stopPx > entry)) return { ok: false, code: 'TIDE_NO_STOP', mode, grade: g.grade, gradeDetail: g, leg };
  const stopPts = r2(Math.abs(entry - stopPx));
  const ch = moneyRule.chooseStop([{ tf, stop: stopPx, stopPts }], g.grade, mc, { tf });   // the engine names the wick; no tighter wick is ever tried
  const z = moneyRule.sizeFor(stopPts, g.grade, mc), planned = ch && ch.contracts > 0 ? ch.contracts : 0;
  if (z.code === 'NO_FIT_TAKE1' && !held.length && !(stopPts * pv <= take1Max(cfg) + 1e-9)) return { ok: false, code: 'GRADE_NO_FIT_CEILING', mode, grade: g.grade, gradeDetail: g, leg, stopPts, stopTf: tf, stop: stopPx, oneLotUsd: r2(stopPts * pv), gradeRiskUsd: z.budgetUsd ?? null, budgetUsd: take1Max(cfg), shadow: null };   // [2a] 1 MNQ over the take1 ceiling: not taken
  const heldQty = held.reduce((a, l) => a + l.contracts, 0), heldRisk = legRisk(held, stopPx, dir, pv), per = stopPts * pv;
  const shadow = held.length ? null : moneyRule.shadowSize(stopPts, g.grade, mc);
  let qty, legNote, first = planned, second = 0, upgrade = null;
  if (leg === 'upgrade-add') {   // §22: a B / C trade re-graded A+ before TP1 tops up to the A+ dollars at the SAME stop, once. money-r4 refuses unless mode grade + upgradeAdd.enabled,
    // and on any unknown lifecycle field; a resting B half stays RESERVED (counted as filled) until the broker reports it terminal
    const c = held.length ? moneyRule.combine(held.map(l => ({ price: l.price, contracts: l.contracts }))) : null, rq = prior && Number.isInteger(prior.second) ? prior.second : 0;
    upgrade = c ? moneyRule.upgradeAdd({ dir, grade: prior.grade, newGrade: 'A+', entry: c.avgEntry, openQty: c.contracts, stop: stopPx, structuralStop: prior.stop, addPx: entry, restingQty: rq,
      restingPx: rq > 0 ? prior.secondPx : undefined, tp1Done: prior.tp1Done, tp1Px: prior.tp1Px, bestPx: prior.bestPx, upgradedBefore: prior.upgraded === true, oldPoints: prior.points ?? null, newPoints: g.points, cfg: mc }) : null;
    qty = upgrade && upgrade.ok ? upgrade.qty : 0;
    legNote = upgrade ? (upgrade.ok ? `UPGRADE ${prior.grade}->A+: +${qty} (open ${heldQty}${upgrade.reservedRestingQty ? ` + ${upgrade.reservedRestingQty} resting reserved` : ''}, risk <= $${upgrade.risk && upgrade.risk.gradeRiskUsd})` : `UPGRADE skipped (${upgrade.reason})`) : 'UPGRADE: no open trade in this setup (nothing to top up)';
  } else if (held.length && moneyRule.gradeKey(g.grade) === 'B' && prior && Number.isInteger(prior.second) && prior.second > 0) {   // §22: the resting B half (entryByGrade only)
    const sl = held.length === 1 ? moneyRule.secondLeg({ dir, stop: stopPx, structuralStop: prior.stop, firstFill: held[0].price, firstContracts: held[0].contracts, entry2: entry, plannedSecond: prior.second, grade: 'B' }, mc) : { contracts: 0, reason: 'already-scaled-in' };
    qty = sl.contracts; legNote = qty > 0 ? `B 2nd half +${qty} (total ${heldQty + qty}${sl.reason === 'sized-down' ? ', sized down to the B dollars' : ''})` : `B 2nd half: none (${sl.reason})`;
  } else if (held.length) {   // one entry per setup otherwise; only the upgrade add or the D4 pyramid add later
    qty = 0; legNote = `already entered (one entry; no retest add)`;
  } else {   // the first leg: moneyRule.scaleInPlan (entryByGrade false = all at once; true = A+ all at once, B half rounded up + the rest resting, C one entry)
    const sp = moneyRule.scaleInPlan(stopPts, g.grade, mc);
    first = sp.first; second = sp.second; qty = sp.first;
    legNote = second > 0 ? `B half now, +${second} resting at ${sig.addZone && isNum(sig.addZone.price) ? 'the FVG ' + r2(sig.addZone.price) : 'the retest'}`
      : sp.style === 'one-entry' ? `${g.grade} one entry` : `all at once`;
    if (z.code === 'NO_FIT_TAKE1') legNote += ` (take1: $${z.overBudgetUsd} over the $${z.budgetUsd} budget)`;
  }
  if (!(planned > 0) && !held.length) return { ok: false, code: (ch && ch.code) || 'GRADE_NO_FIT', mode, grade: g.grade, gradeDetail: g, leg, stopPts, stopTf: tf, stop: stopPx, oneLotUsd: r2(per), gradeRiskUsd: z.budgetUsd ?? null, budgetUsd: z.budgetUsd ?? null, shadow };
  if (!(qty > 0)) return { ok: false, code: leg === 'upgrade-add' ? 'GRADE_UPGRADE_SKIP' : 'LEG_NO_ROOM', mode, grade: g.grade, gradeDetail: g, leg, legNote, stopPts, stopTf: tf, stop: stopPx, held: heldQty, upgrade: upgrade ? upgrade.row : null };
  const legs = [...held, { price: entry, contracts: qty }];
  const exits = moneyRule.planExits({ dir, legs, stop: stopPx, pools: Array.isArray(sig.pools) ? sig.pools : [], partialPools: Array.isArray(sig.internalPools) ? sig.internalPools : undefined, grade: leg === 'upgrade-add' ? 'A+' : g.grade }, mc);
  if (!exits) return { ok: false, code: 'TIDE_BAD_GEOMETRY', mode, grade: g.grade, leg };
  const total = heldQty + qty, reservedQty = leg === 'upgrade-add' ? (upgrade && upgrade.reservedRestingQty) || 0 : second;   // (a) a resting B half is RESERVED exposure until terminal
  return { ok: true, mode, budgetUsd: z.budgetUsd ?? null, grade: leg === 'upgrade-add' ? 'A+' : g.grade, fromGrade: leg === 'upgrade-add' ? (prior && prior.grade) || g.grade : null, gradeDetail: g, leg, legNote, stop: stopPx, stopTf: tf, stopPts,
    qty, total, planned, first, second, reservedQty, scaleZone: second > 0 ? (sig.addZone && isNum(sig.addZone.price) ? sig.addZone : { price: null, kind: 'retest' }) : null,
    riskUsd: r2(qty * per), totalRiskUsd: r2(heldRisk + qty * per), exits, addQty: moneyRule.addQty(total), shadow, upgrade: upgrade ? upgrade.row : null, sizeCode: z.code || null, nearFloor: z.nearFloor || null,
    sizing: `${mode}${cfg.money && cfg.money.sizing && cfg.money.sizing.enabled === true ? '' : ' (shadow: money.sizing.enabled false)'}`, entryType: sig.entryType === 'LIMIT' ? 'LIMIT' : 'MARKET' };
}
// one ASCII line for the phone (Mac's format + the money-r4 shadow size):
// "TIDE SHADOW SHORT A+ (4: trap force volume timing) flat 450: 1 MNQ | grade A+ 900: 3 MNQ @28366.75 stop 28513 TP1 28350 TP2 28035.25 | all at once | 4H Open trap, ..."
function pushLine(sig, p, gate = null) {
  const side = sig.dir === 1 ? 'LONG' : 'SHORT', px = x => (isNum(x) ? String(r2(x)) : '?'), where = `${sig.levelName || ''}${sig.kind === 'trap' ? ' trap' : sig.kind ? ' ' + sig.kind : ''}`;
  if (!p.ok) return ascii(`TIDE SHADOW ${side} ${p.grade || ''} no trade (${p.code}) @${px(sig.entry)}${isNum(p.stop) ? ' stop ' + px(p.stop) : ''}${isNum(p.stopPts) ? ` (${p.stopPts} pts${isNum(p.oneLotUsd) ? ', 1 MNQ $' + p.oneLotUsd + ' > $' + p.budgetUsd : ''})` : ''}${p.shadow ? ' | ' + p.shadow.line : ''} | ${where}`);
  const e = p.exits, gd = p.gradeDetail || {};
  const pts = isNum(gd.points) ? ` (${gd.points}${gd.names && gd.names.length ? ': ' + gd.names.join(' ') : ''})` : '';
  const size = p.shadow ? p.shadow.line : `${p.mode} ${isNum(p.budgetUsd) ? p.budgetUsd : '?'}: +${p.qty} MNQ (${p.leg})`;
  const lim = p.entryType === 'LIMIT' ? ' LIMIT' : '', oneLot = !(e.partial && e.partial.contracts > 0);
  return ascii(`TIDE SHADOW ${side} ${p.grade}${pts}${gd.capTag ? ' [' + gd.capTag + ']' : ''} ${size}${lim} @${px(sig.entry)} stop ${px(p.stop)}` +
    ` TP1 ${px(e.partial && e.partial.price)} TP2 ${px(e.tp.price)}` +
    ` | ${p.legNote}${oneLot ? ', 1 lot: BE at TP1, no partial' : ''} | ${where}, ${p.stopTf} stop ${p.stopPts} pts, risk $${Math.round(p.totalRiskUsd)}${p.addQty ? `, +${p.addQty} after TP1` : ''}${gate && gate !== 'OK' && gate !== 'NOT_FLAT' ? ` | Stage 2 would wait: ${gate}` : ''}`);
}

// ------------------------------------------------------------------ bars TIDE builds from what the bot already read (no request of its own)
const WARM_CLOCK_MIN = 6000, WARM_KEEP = 2000;
// [r1.1a] the warm-up read ladder (Mac's live bot 11/04: the 6000-minute read failed with 'fetch failed'): 6000 -> 3000 -> 2000 -> 1500, one after the other, no wait.
const WARM_LADDER = Object.freeze([6000, 3000, 2000, 1500]);
const errText = e => `${e && e.message}${e && e.cause ? ` [cause: ${e.cause.code || e.cause.message || e.cause}]` : ''}`;
// fetchFn(limit) -> Promise<bars>. -> { bars, limit } from the first limit that answers, or { bars: null, errors: [{ limit, error }] } when every one failed. log() gets every failure.
// [r1.2] a stale keep-alive socket (undici UND_ERR_SOCKET / ECONNRESET, seen on Mac's VPS even for 13-bar reads): the SAME read is retried ONCE at once
const SOCKET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_CLOSED', 'EPIPE']);
const readStats = { socketRetries: 0, socketRetryOk: 0, readFailures: 0 };
const isSocketErr = e => !!(e && ((e.cause && SOCKET_CODES.has(e.cause.code)) || SOCKET_CODES.has(e.code)));
async function socketRetry(fn, log = () => {}, what = 'read') {
  try { return await fn(); }
  catch (e) {
    if (!isSocketErr(e)) { readStats.readFailures++; throw e; }
    readStats.socketRetries++; log(`  [tide] ${what}: ${errText(e)} - a stale socket: retrying once now`);
    try { const r = await fn(); readStats.socketRetryOk++; return r; } catch (e2) { readStats.readFailures++; throw e2; }
  }
}
async function warmRead(fetchFn, log = () => {}, ladder = WARM_LADDER) {
  const errors = [];
  for (const limit of ladder) {
    try { const bars = await socketRetry(() => fetchFn(limit), log, `1m warm-up read (limit ${limit})`); return { bars, limit, errors }; }
    catch (e) { const error = errText(e); errors.push({ limit, error }); log(`  [tide] 1m warm-up read FAILED at limit ${limit}: ${error}${limit !== ladder[ladder.length - 1] ? ' - trying the next limit now' : ''}`); }
  }
  return { bars: null, errors };
}   // the first 1m read: 6000 minutes of clock (a weekend still yields ~2000 bars); the engine warms on the last 2000
// 30m bars from 15m bars (aligned :00 / :30; o of the first, h max, l min, c of the last, v sum; the forming 15m makes the forming 30m)
function agg30(m15) {
  const out = []; for (const b of Array.isArray(m15) ? m15 : []) { if (!b || !isNum(b.t)) continue; const t = b.t - (b.t % 1800000), last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v = (isNum(last.v) ? last.v : 0) + (isNum(b.v) ? b.v : 0); }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); }
  return out;
}
// the 15m series with a fresher tail (the probe's last bars replace / extend it)
function mergeTail(base, tail) {
  if (!Array.isArray(base)) return base; if (!Array.isArray(tail) || !tail.length) return base;
  const t0 = tail[0].t, keep = base.filter(b => b.t < t0); return [...keep, ...tail.filter(b => b && isNum(b.t)).sort((a, b) => a.t - b.t)];
}

// ------------------------------------------------------------------ engine adapter
// MacStructure's engine: createState() + step(state, {m1, bias, levels}, cfg), one call per CLOSED 1m bar; it builds 5m-4H itself.
// ctx = { nowMs, m1New:[closed 1m bars, ms, oldest first], warm (true while feeding history), board:[{name, price}], biasAt(tSec) -> {m15, m30}|null }
//   -> { rows[], signals[] (normalized) }
const BOARD_KEYS = Object.freeze({ O4: '4H Open', O1: '1H Open', PDH: 'PDH', PDL: 'PDL', AsiaH: 'Asia High', AsiaL: 'Asia Low', LonH: 'London High', LonL: 'London Low' });
function boardMap(board) { const L = {}; for (const [k, n] of Object.entries(BOARD_KEYS)) { const x = (board || []).find(l => l && l.name === n && isNum(l.price)); L[k] = x ? x.price : null; } return L; }
// Day pools (playbook §14.5 'the daily collection run', §18 TP2 at the pool >= 2R): the engine caps its target list (maxTargets) and round numbers can push PDH / PDL
// out of it (11/04: PDL 28,035.25, the A+ major pool beyond 2R, was cut). The board's PDH / PDL in the trade direction join the pools as MAJOR when no listed pool
// sits within a tick of them. Only these two (always the completed prior day); session highs / lows stay the engine's call (it knows which session is forming).
function dayPools(L, dir, entry, tg, tick = 0.25) {
  const out = []; if (!L || !(dir === 1 || dir === -1) || !isNum(entry)) return out;
  for (const [k, name] of [['PDH', 'PDH'], ['PDL', 'PDL']]) { const px = L[k];
    if (isNum(px) && dir * (px - entry) > tick && !tg.some(t => Math.abs(t.price - px) <= tick + 1e-9)) out.push({ price: px, name, major: true, src: 'board' }); }
  return out;
}
function normSignal(s, version, L = null) {   // MacStructure signal -> the wiring's signal (L = the board the engine saw, boardMap shape)
  const d = s.dir, tg0 = Array.isArray(s.targets) ? s.targets.filter(t => t && isNum(t.price)) : [], added = dayPools(L, d, s.entryPrice, tg0);
  const tg = [...tg0, ...added].sort((a, b) => d * (a.price - b.price));
  const stopTf = s.stops && s.stops.stopType ? String(s.stops.stopType).toUpperCase() : null;
  return { id: s.id, setupId: s.setupId || null, leg: s.leg || null, dir: d, kind: s.kind === 'failed-break' ? 'trap' : (s.kind || null), levelName: s.level && s.level.name || null, levelPrice: s.level && isNum(s.level.price) ? s.level.price : null,
    entryType: String(s.entryType || 'market').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET', entry: s.entryPrice, stop: isNum(s.chosenStop) ? s.chosenStop : s.stops && s.stops.structural, stopTf,
    grade: s.grade || null, gradePoints: isNum(s.gradeTotal) ? s.gradeTotal : null, pointDetail: isObj(s.gradePoints) ? s.gradePoints : null, evidence: s.gradeEvidence || null,
    capTag: /exhaustion-watch/.test(JSON.stringify([s.tags || null, s.gradeCap || null, s.cap || null, s.capTag || null, s.warnings || null])) ? 'exhaustion-watch' : null,
    pools: tg.map(t => ({ price: t.price, name: t.name || null, major: !!t.major })), internalPools: tg.filter(t => !t.major).map(t => ({ price: t.price, name: t.name || null, major: false })),
    addZone: s.limit && isNum(s.limit.price) && String(s.entryType).toLowerCase() !== 'limit' ? { price: s.limit.price, kind: 'fvg' } : null, at: isNum(s.t) ? s.t * 1000 : null, engine: version,
    poolsAdded: added.map(p => p.name),
    raw: { leg: s.leg || null, setupId: s.setupId || null, sizeFrac: s.sizeFrac ?? null, limit: s.limit || null, cancelsLimit: s.cancelsLimit || null, stops: s.stops || null, shift: s.shift || null, control: s.control || null,
      marketState: s.marketState || null, warnings: s.warnings || null, reason: s.reason || null, scaleIn: s.scaleIn || null, gradePoints: s.gradePoints || null } };
}
function createAdapter(lib, engineCfg) {
  if (!lib || typeof lib.step !== 'function' || typeof lib.createState !== 'function') throw new Error('lib/structure.js has no createState()/step()');
  let st = lib.createState();
  const version = lib.VERSION || 'structure';
  return { version, kind: 'm1', info: () => ({ range1hKnown: !!(st && st.mstate && st.mstate.known) }), step(ctx) {
    const rows = [], signals = [], L = ctx.warm ? null : boardMap(ctx.board);
    for (const b of ctx.m1New || []) {
      const tSec = Math.floor((b.t > 1e11 ? b.t / 1000 : b.t)), bias = (ctx.warm && !ctx.warmBias) || typeof ctx.biasAt !== 'function' ? null : ctx.biasAt(tSec + 60);   // [2a] warmBias: the rebuilt causal book (tideRebuild hook)
      const fb = !ctx.warm && typeof ctx.tradesFor === 'function' ? ctx.tradesFor(b) : null;   // the shadow's virtual trades on this bar -> the engine's trade feedback
      // a MISSING volume is passed as null (structure r3.2 withholds the volume point); an observed 0 stays 0
      const out = lib.step(st, { m1: { t: tSec, o: b.o, h: b.h, l: b.l, c: b.c, v: isNum(b.v) ? b.v : null }, bias, levels: L,
        ...(fb && fb.trades && fb.trades.length ? { trades: fb.trades } : {}), ...(fb && fb.stoppedOut ? { stoppedOut: fb.stoppedOut } : {}) }, engineCfg);
      st = out.state;
      if (ctx.warm) { if (typeof ctx.onWarmSetup === 'function') for (const e of out.events || []) if (e && e.setup) ctx.onWarmSetup(e.setup); if (out.signal && out.signal.setupId && typeof ctx.onWarmSetup === 'function') ctx.onWarmSetup(out.signal.setupId); continue; }   // history: build the engine's state, journal nothing
      for (const e of out.events || []) rows.push({ ...e, event: e.type || 'event', phase: e.type === 'SIGNAL' ? 'engine_signal' : String(e.type || 'event').toLowerCase(), engine: version, t: isNum(e.t) ? e.t * 1000 : Date.now() });   // 'signal' is the wiring's own row (with the plan)
      if (out.signal) { const ns = normSignal(out.signal, version, L); if (typeof ctx.onSignal === 'function') ctx.onSignal(ns, b); else signals.push(ns); }
    }
    return { rows, signals };
  } };
}

// ------------------------------------------------------------------ the bias book (playbook §2: control is read intrabar with our bias score)
// The executor notes the forming 15m / 30m Levels PRO bias score at every evaluation; the engine gets, for each closed 1m bar, the latest reading taken at or
// before that bar's close (at most 120 s old, else none: the engine fails closed). Shape = what lib/structure.js normBias() reads: { m15: {score, valid,
// observedAt}, m30: {...} } (objects, so validity and the observation time survive; observedAt in unix seconds). A side with no reading is null.
const BIAS_MAX_AGE_MS = 120000, BIAS_KEEP = 400;
function createBiasBook() { return { rows: [] }; }
function noteBias(book, tMs, s15, s30) {
  if (!book || !Array.isArray(book.rows) || !isNum(tMs)) return;
  const v = x => (isNum(x) ? x : null), r = { t: tMs, s15: v(s15), s30: v(s30) };
  if (r.s15 === null && r.s30 === null) return;
  book.rows.push(r); while (book.rows.length > BIAS_KEEP) book.rows.shift();
}
function lastBiasAt(book) { const r = book && Array.isArray(book.rows) ? book.rows[book.rows.length - 1] : null; return r ? r.t : -Infinity; }
function biasAt(book, tSec) {
  if (!book || !Array.isArray(book.rows) || !isNum(tSec)) return null;
  const T = tSec * 1000;
  for (let i = book.rows.length - 1; i >= 0; i--) {
    const r = book.rows[i]; if (r.t > T) continue;
    if (T - r.t > BIAS_MAX_AGE_MS) return null;
    const one = x => (x === null ? null : { score: x, valid: true, observedAt: Math.floor(r.t / 1000) });
    return { m15: one(r.s15), m30: one(r.s30) };
  }
  return null;
}

// ------------------------------------------------------------------ the VIRTUAL TRADE (shadow only): what a taken signal would have done, bar by bar, so the engine
// learns when the trade ENDED (MacStructure r3.2 ledger: without feedback the engine keeps a virtual trade open until its structural stop or 480 min and blocks
// same-direction setups). Exits from money-r4.1 on the plan's own numbers: the structural stop; TP1 traded -> break-even + 1 tick (stopOnlyInFavour); TP2;
// the R-ladder (moneyRule.nextStop with lastPx = the bar close: a 'place' moves the stop, 'exit-at-market' closes at the close); the session flatten (13:05 PT).
// Inside one bar the stop is checked first (the worse case), then TP1, then TP2. A simulation only: it is journaled as phase 'shadow_exit', never traded.
function virtualOpen(sig, p, T) {
  const e = p.exits;
  return { id: sig.id || null, setup: sig.setupId || null, dir: sig.dir, entry: e.avgEntry, stop: p.stop, stop0: p.stop, R: e.R, tp1: e.partial && isNum(e.partial.price) ? e.partial.price : null,
    tp2: e.tp.price, tp1Done: false, bestPx: sig.entry, openedAt: T, by: 'structural', bars: 0, closed: null };
}
function virtualBar(vt, b, mc, sess) {   // b = a closed 1m bar (t = open, ms). -> the exit { px, why } or null; vt is updated in place
  if (vt.closed) return null;
  const d = vt.dir, T = b.t + 60000; vt.bars++;
  const close = (px, why) => { vt.closed = { at: T, px: r2(px), why, resultR: isNum(vt.R) && vt.R > 0 ? r2(d * (px - vt.entry) / vt.R) : null }; return vt.closed; };
  if (d < 0 ? b.h >= vt.stop : b.l <= vt.stop) return close(vt.stop, vt.by === 'structural' ? 'stop' : vt.by === 'be' ? 'be-stop' : 'ladder-stop');
  if (!vt.tp1Done && isNum(vt.tp1) && (d < 0 ? b.l <= vt.tp1 : b.h >= vt.tp1)) {
    vt.tp1Done = true; const be = moneyRule.stopOnlyInFavour(vt.stop, moneyRule.beStopAfterPartial(vt.entry, d, mc), d); if (be !== vt.stop) { vt.stop = be; vt.by = 'be'; }
  }
  if (d < 0 ? b.l <= vt.tp2 : b.h >= vt.tp2) return close(vt.tp2, 'tp2');
  vt.bestPx = d < 0 ? Math.min(vt.bestPx, b.l) : Math.max(vt.bestPx, b.h);
  const ns = moneyRule.nextStop({ dir: d, entry: vt.entry, R: vt.R, bestPx: vt.bestPx, currentStop: vt.stop, lastPx: b.c, cfg: mc });
  if (ns.action === 'exit-at-market') return close(b.c, 'ladder-lock-crossed');
  if (ns.action === 'place' && isNum(ns.stop) && d * ns.stop > d * vt.stop) { vt.stop = ns.stop; vt.by = 'ladder'; }
  if (sess && sess.flattenDue) return close(b.c, 'session-flatten');
  return null;
}

// ------------------------------------------------------------------ SHADOW step: journal rows + push lines, NOTHING else
// sh = { engine, seen:Set, setups?:Map, virt?:Map }; input = the engine input + { sessionAt(ms) -> { noEntry, flattenDue } (the executor's sessionCloseState),
// floorDistanceUsd }; gate = the kept-gates ctx (journal note only). -> { rows[], pushes[] }
// A signal is TAKEN (a virtual trade starts) only when Stage 2 would take it: the plan fits, no TIDE trade is open, not late, and the kept gates pass (the old bot's
// own position does not count: shadow measures the model). Not taken = the engine is told at once that its trade is closed (no blocking of later setups).
// The engine has no session clock: a signal inside the session close (12:55-15:00 PT) is SESSION_CLOSE - journaled, silent, not taken (MacArthur 11/04).
function shadowStep(sh, input, cfg, gate, pointValue = 2, tickSize = 0.25) {
  const rows = [], sigRows = [], pushes = [], takes = [], now = input && input.nowMs, mc = moneyCfg(cfg, pointValue, tickSize, input && input.floorDistanceUsd);
  const liveMode = !!(cfg && cfg.tide && cfg.tide.mode === 'live');   // [2a] live: a taken signal is a REAL order (takes); its trade ends at the REAL position's end (liveFeedback)
  const sessionAt = input && typeof input.sessionAt === 'function' ? input.sessionAt : null, sessOf = T => { try { return sessionAt ? sessionAt(T) || null : null; } catch (e) { return null; } };
  sh.rowSeen = sh.rowSeen || new Set(); sh.setups = sh.setups || new Map(); sh.virt = sh.virt || new Map(); sh.fb = sh.fb || [];
  const tradesFor = b => {   // before the engine's step on bar b: run every open virtual trade through b; report the ones that ended (and the not-taken ones)
    const trades = sh.fb.splice(0), sess = sessOf(b.t + 60000); let stoppedOut = sh.fbStop || null; sh.fbStop = null;
    for (const vt of sh.virt.values()) {
      if (vt.live) continue;   // [2a] a live trade is never simulated: the executor reports its real end (liveFeedback)
      const x = virtualBar(vt, b, mc, sess); if (!x) continue;
      trades.push({ setupId: vt.setup, signalId: vt.id, tp1Done: vt.tp1Done, closed: true });
      if (x.why === 'stop') stoppedOut = { dir: vt.dir };   // C.4: only a FULL structural stop needs a new internal shift
      sigRows.push(tideRow('shadow_exit', { shadow: true, simulated: true, id: vt.id, setup: vt.setup, dir: vt.dir, side: vt.dir === 1 ? 'LONG' : 'SHORT', entry: vt.entry, stop0: vt.stop0,
        exit: x.px, why: x.why, resultR: x.resultR, tp1Done: vt.tp1Done, R: vt.R, tp1: vt.tp1, tp2: vt.tp2, bars: vt.bars, openedAt: vt.openedAt }, x.at));
    }
    for (const [k, vt] of sh.virt) if (vt.closed) sh.virt.delete(k);
    for (const vt of sh.virt.values()) if (vt.tp1Done && !vt.tp1Told) { vt.tp1Told = true; trades.push({ setupId: vt.setup, signalId: vt.id, tp1Done: true, closed: false }); }
    return { trades, stoppedOut };
  };
  const onSignal = (sig, bar) => {
    const id = sig.id || [sig.dir, sig.kind, sig.levelName, sig.at].join('|');
    if (sh.seen.has(id)) return;
    sh.seen.add(id); if (sh.seen.size > 500) sh.seen.delete(sh.seen.values().next().value);
    const T = bar && isNum(bar.t) ? bar.t + 60000 : now, sess = sessOf(T);
    const prior = sig.setupId ? sh.setups.get(sig.setupId) || null : null;
    let p; try { p = plan(sig, cfg, pointValue, tickSize, prior, input && input.floorDistanceUsd); } catch (e) { p = { ok: false, code: 'TIDE_PLAN_ERROR', error: String(e && e.message) }; }
    if (p.ok && sig.setupId) {   // shadow memory of what this setup "holds" (no order: a shadow assumption that each leg fills at its signal price)
      // the resting B half stays RESERVED (second, secondPx) until its own retest leg; the upgrade add merges with it (money-r4 default). The shadow has no
      // fills, so tp1Done / tp1Px / bestPx stay unknown and moneyRule.upgradeAdd refuses (unknown-state): fail closed, journaled.
      const s = prior || { grade: p.grade, stop: p.stop, legs: [], second: p.second, secondPx: p.scaleZone && isNum(p.scaleZone.price) ? p.scaleZone.price : null, points: p.gradeDetail ? p.gradeDetail.points : null };
      s.legs = [...s.legs, { price: sig.entry, contracts: p.qty, leg: p.leg }]; if (p.leg === 'upgrade-add') s.upgraded = true; else if (prior && moneyRule.gradeKey(p.grade) === 'B') { s.second = 0; s.secondPx = null; }
      sh.setups.set(sig.setupId, s); if (sh.setups.size > 200) sh.setups.delete(sh.setups.keys().next().value);
    }
    const g0 = tideGate({ ...(gate || {}), sessionNoEntry: sess ? !!sess.noEntry : !!(gate && gate.sessionNoEntry), openWait: openWait(T, cfg.tide && cfg.tide.openWaitMin), mode: 'add' });   // the kept gates at the bar's close (journal only)
    const tideOpen = [...sh.virt.values()].some(v => !v.closed && v.id !== sig.id && v.setup !== sig.setupId), firstLeg = !prior;
    const g = g0.ok && firstLeg && tideOpen ? { ok: false, code: 'TIDE_OPEN', why: 'a TIDE trade is still open (one TIDE position at a time)' } : g0;
    const pre = !!(sig.setupId && sh.preRestart && sh.preRestart.has(sig.setupId));   // a setup armed in the warm-up history (before this start): journal only (4b)
    if (pre) g.code = g.ok ? 'PRE_RESTART' : g.code, g.ok = false;
    const late = isNum(sig.at) && isNum(now) && now - sig.at > LATE_MS, silent = g.code === 'SESSION_CLOSE' || pre;   // a catch-up bar's signal / the session close: journal only
    const taken = liveMode ? p.ok && firstLeg && !late && g.ok : p.ok && firstLeg && !late && (g.ok || g.code === 'NOT_FLAT' || g.code === 'DESYNCED' || g.code === 'PAUSED');   // [2a] live: every kept gate must pass now
    if (taken) { sh.virt.set(id, liveMode ? { ...virtualOpen(sig, p, T), live: true } : virtualOpen(sig, p, T)); if (liveMode) takes.push({ id, sig, plan: p }); }   // [2a] live: lib/tideLive.js (re-checks flat / session / broker) reports the end back
    else if (firstLeg) sh.fb.push({ setupId: sig.setupId || null, signalId: sig.id || null, tp1Done: false, closed: true });   // not taken: the engine's trade ends now
    const line = pushLine(sig, p, g.code);
    sigRows.push(tideRow('signal', { shadow: !liveMode, order: liveMode ? (taken ? 'live (tideOrders planner)' : 'none') : 'none (shadow)', id, setup: sig.setupId || null, leg: sig.leg || null, dir: sig.dir, side: sig.dir === 1 ? 'LONG' : 'SHORT', kind: sig.kind || null, level: sig.levelName || null,
      levelPrice: sig.levelPrice ?? null, entryType: sig.entryType || 'MARKET', entry: r2(sig.entry), evidence: sig.evidence || null, engine: sig.engine || null,
      plan: p.ok ? { mode: p.mode, budgetUsd: p.budgetUsd, shadow: p.shadow || null, sizeCode: p.sizeCode, nearFloor: p.nearFloor, grade: p.grade, fromGrade: p.fromGrade, gradeDetail: p.gradeDetail, leg: p.leg, legNote: p.legNote, stop: p.stop, stopTf: p.stopTf, stopPts: p.stopPts, qty: p.qty, total: p.total, planned: p.planned,
        first: p.first, second: p.second, scaleZone: p.scaleZone, reservedQty: p.reservedQty, riskUsd: p.riskUsd, totalRiskUsd: p.totalRiskUsd, sizing: p.sizing,
        tp1: p.exits.partial ? { price: p.exits.partial.price, qty: p.exits.partial.contracts, basis: p.exits.partial.basis, pool: p.exits.partial.pool || null } : null,   // TP1 from moneyRule.planExits on the signal's pools (a 1-lot: qty 0, the price is the BE trigger)
        tp2: { price: p.exits.tp.price, basis: p.exits.tp.basis, rr: p.exits.tp.rr, pool: p.exits.tp.pool || null }, avgEntry: p.exits.avgEntry, beStop: p.exits.beStop, R: p.exits.R,
        pyramid: { qty: p.addQty, when: 'once after TP1 on a rejected pullback, trend + 4H control held, house money only (D4)' } }
        : { skip: p.code, mode: p.mode ?? sizingMode(cfg), shadow: p.shadow || null, grade: p.grade ?? null, leg: p.leg ?? null, legNote: p.legNote ?? null, stop: p.stop ?? null, stopPts: p.stopPts ?? null, stopTf: p.stopTf ?? null, error: p.error ?? null },
      poolsAdded: sig.poolsAdded && sig.poolsAdded.length ? sig.poolsAdded : null, late: late || null, taken, tradeable: !silent,
      gatesNow: g.ok ? 'pass' : g.code, gateWhy: g.why || null, push: PUSH_CODES(p) && !late && !silent ? line : null, raw: sig.raw || null }, now));
    if (PUSH_CODES(p) && !late && !silent) pushes.push(liveMode ? line.replace(/^TIDE SHADOW /, taken ? 'TIDE LIVE ' : 'TIDE LIVE (no order) ') : line);   // the phone gets every tradable leg and every GRADE_NO_FIT; a leg with no room, a late or a session-close signal is journal only
  };
  const out = sh.engine.step({ ...input, tradesFor, onSignal }) || {};
  for (const sig of Array.isArray(out.signals) ? out.signals : []) onSignal(sig, null);   // an engine adapter without the per-bar hook
  let dropped = 0;
  for (const e of Array.isArray(out.rows) ? out.rows : []) {
    if (SETUP_ONLY.has(e.event) && !(e.setup && sh.setups.has(e.setup))) continue;   // chatty rows only for setups that produced a signal
    const k = JSON.stringify([e.phase, e.id || e.setup || e.failure || null, e.reason || e.why || null, e.zone || e.levelName || e.level || null, e.t || null, e.dir ?? null]);
    if (sh.rowSeen.has(k)) continue;
    sh.rowSeen.add(k); if (sh.rowSeen.size > 4000) sh.rowSeen.delete(sh.rowSeen.values().next().value);
    if (rows.length >= ROWS_PER_STEP) { dropped++; continue; }
    rows.push({ ...e, type: 'lv_tide', version: VERSION, shadow: true });
  }
  if (dropped) rows.push(tideRow('rows_capped', { shadow: true, dropped, cap: ROWS_PER_STEP }, now));
  return { rows: [...rows, ...sigRows], pushes, takes };
}
// [2a] live: the REAL TIDE position's end (or a take the executor did not send) goes back to the engine on its next step, as the shadow's simulated exit does.
// res = { tp1Done, closed, stopped } (stopped = a FULL structural stop, before TP1: the engine's C.4 internal shift)
function liveFeedback(sh, takeId, res) {
  if (!sh || !sh.virt) return false; const vt = sh.virt.get(takeId); if (!vt || !vt.live || vt.closed) return false;
  sh.fb = sh.fb || [];
  if (res && res.closed) { vt.closed = { at: Date.now(), why: res.why || 'live-exit' }; sh.virt.delete(takeId); sh.fb.push({ setupId: vt.setup, signalId: vt.id, tp1Done: !!res.tp1Done, closed: true }); if (res.stopped && !res.tp1Done) sh.fbStop = { dir: vt.dir }; return true; }
  if (res && res.tp1Done && !vt.tp1Told) { vt.tp1Told = true; vt.tp1Done = true; sh.fb.push({ setupId: vt.setup, signalId: vt.id, tp1Done: true, closed: false }); return true; }
  return false;
}

const LATE_MS = 180000;   // a signal whose bar closed more than 3 min before this step came from a catch-up read after a gap: journaled, not pushed
const PUSH_CODES = p => !!(p && (p.ok || p.code === 'GRADE_NO_FIT' || p.code === 'GRADE_NO_FIT_CEILING'));
function tideRow(phase, data, t) { return { type: 'lv_tide', t: isNum(t) ? t : Date.now(), version: VERSION, phase, ...(data || {}) }; }

module.exports = { socketRetry, isSocketErr, readStats, warmRead, WARM_LADDER, errText, blockAt, blocksText, tideBlocks, LIVE_ARM, liveFeedback, moneyOnly, take1Max, TAKE1_MAX_DEFAULT, agg30, mergeTail, WARM_CLOCK_MIN, WARM_KEEP, createAdapter, normSignal, boardMap, dayPools, virtualOpen, virtualBar, createBiasBook, noteBias, biasAt, lastBiasAt, BIAS_MAX_AGE_MS, LATE_MS, moneyDefaults, sizingMode, BOARD_KEYS, VERSION, STAGE, MODES, STAGE_MODES, DEFAULTS, VETOES_SKIPPED, GATES_KEPT, ROWS_PER_STEP, configProblem, modeOf, moneyCfg, gradeUsd, startupLines,
  tideGate, openWait, ptMinute, pointNames, plan, pushLine, shadowStep, tideRow, structure, setStructureForTest };
