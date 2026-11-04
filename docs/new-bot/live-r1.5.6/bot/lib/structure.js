'use strict';
// lib/structure.js: the TIDE r2 market-structure engine (MacStructure desk).
// Reads the market Mac's way (knowledge/MAC-TRADING-PLAYBOOK.md §1-23; tide/SPEC-TIDE-r2.md A, B, C, D'', GRADE r3 + TIME BLOCKS (FINAL, §23)).
//
// Pure and deterministic: no I/O, no clock, no randomness. One call per CLOSED 1m bar:
//   step(state, input, cfg) -> { state, events[], signal|null, swings }
// input = { m1: {t,o,h,l,c,v} (closed 1m bar, t = bar open, unix sec UTC),
//           bias: { s15, s30 } | null   (the bot's Levels PRO bias score on the FORMING 15m / 30m candle, read at this 1m close; playbook §2),
//           levels: { O4, O1, PDH, PDL, AsiaH, AsiaL, LonH, LonL } | null   (the bot's own level board, playbook §4),
//           speed: [15s bars] (optional, only when cfg.grade.speedTf === '15s'),
//           stoppedOut: { dir } (optional executor feedback: a TIDE trade in dir was fully stopped, spec C.4) }
// The engine aggregates 5m/15m/30m/1H/4H itself from the 1m bars (4H anchored at 15:00 PT like the CME/provider candles),
// so nothing it reads can come from the future. The state object is owned by the engine: step() updates it in place and
// returns it (use cloneState() for a snapshot). It is plain JSON.

const VERSION = 'tide-structure-r3.7';   // r3.7 (MacLive-5 r1.5.6, 11/04): r3.6 + htfContext (prior-4H / current-4H / CME-day direction on the state, every setup tagged with / against / neutral; cfg.htfAgainst tag | half | skip)
// r3.6 was: 'tide-structure-r3.6';   // r3.6 (MacLive-4 r1.5.5, 11/04): r3.5 + releaseOnRefusal (a refused trap frees the ONE_IDEA slot; the acceptance it blocked arms) + controlAsBias (gate control4h passes on 15m/30m bias not against the trade)
                                          // r3.5 (MacLive-4 r1.5.5, 11/04): r3.4 + waveBiasTrend (gate waveBias relaxed to >= 0 for with-trend setups) + laneAccept keeps the accepted lane's structure terms
                                          // r3.4 (MacLive-3 r1.5.4, 11/04): r3.3 + laneAccept / controlFree (grade gates), nearestWins (nearer same-way setup replaces the farther one), ltfOpens (30m / 15m Open zones)

const DEFAULTS = deepFreeze({
  tick: 0.25,
  stopBuf: 2,                       // lib/levelEvent.js STOP_BUF (playbook §5, §15 "a few points beyond")
  controlGateMin: 0.15,             // playbook §2 bias line (|score| >= 0.15)
  biasInput: 'strict',              // r3.2 (MacDot): 'strict' = live provenance rules (default); 'offline' = fixtures / tools only (bare scalars accepted)
  biasMaxAgeSec: 120,               // fail-closed: a {score, valid, observedAt} reading observed more than this before the 1m close is STALE and ignored (observedAt = the as-of time)
  firstMinutesWait: 30,             // playbook §1 "within the first hour control has already shifted"; spec A: no 4H read in the first 30 min
  controlHoldReadings: 3,           // spec A "held": consecutive 1m readings past the line before bias-kind control forms (no flip-flopping)
  h4AnchorPtMin: 900,               // 4H candles start 15:00, 19:00, 23:00, 03:00, 07:00, 11:00 PT
  sessions: { asia: [900, 1440], london: [0, 390], ny: [390, 780] },   // PT minutes; Asia/London H/L usable only outside their own session
  sessionOpens: { Asia: 900, London: 0, NY: 390 },                     // playbook §10.6 opening ranges + no-trade wait
  orMinutes: 30,
  sessionOpenWait: true,            // playbook §10.6 / §23 TIME BLOCKS: no new-model entries in the first openWaitMin of a session (15:00 / 00:00 / 06:30 PT) or of a 4H candle
  openWaitMin: 30,                  // spec TIME BLOCKS tide.openWaitMin (the old Asia / NY-open / morning-hold blocks are NOT the engine's concern: tide.useTimeBlocks=false is the executor's flag)
  zoneHalfPts: 2,                   // playbook §13.1 zones, not lines: level +/- 2 pts
  zoneMergePts: 1, zoneMaxWidthPts: 14,
  // r3.2 ruling: Round numbers are NOT on Mac's level list. With roundAsSetup false they never trade and never merge into (widen) a setup zone;
  // with roundAsTarget false (default) they never reach the signal's target pools (TP1 / TP2): they are listed in signal.contextPools only.
  pools: { round: true, roundStep: 50, roundSpan: 400, roundAsSetup: false, roundAsTarget: false, eq: true, eqTolPts: 2, eqMinTouches: 2, eqLookbackMin: 1440 },
  trapControlHolds: true,           // r3.2 ruling (spec A): a TRAP control holds until price takes back its failed-breakout extreme or the 4H closes; an opposite trap never replaces it
  internalPivot: { left: 1, right: 1 },   // spec B internal swings (see NOTES: the witness launch low 28,448 is a 1-bar-each-side 5m pivot)
  pivot5: { left: 2, right: 2 }, pivot1m: { left: 2, right: 2 }, pivot15: { left: 2, right: 2 } /* 15m swings: the D''' structural trail */, pivot1h: { left: 2, right: 2 }, pivot4h: { left: 1, right: 1 },
  acceptBars: 2,                    // spec C.1 >= 2 closed 5m outside
  acceptVolume: false,              // playbook §13.2/13.3 as a GATE (low-volume break never accepts; pullback >= break skips). GRADE r3 (§23) makes volume a POINT, so off by default
  volMedianBars: 20,
  breakMinPts: 1,                   // a break/sweep must trade >= 1 pt beyond the zone edge to count as a failure (a 1-tick poke is not a trap)
  failBars: 3,                      // playbook §10.3 / spec C.2: body back inside within 3 closed 5m candles of the breakout extreme
  launchLookbackBars: 24,
  shiftBodyPct: 0.5,                // spec B full body
  dispBodyPct: 0.5, dispRangeMult: 1.0, avgRangeBars: 20,   // GRADE r3 lane trigger (§23): displacement shift = body >= 50% of range, range >= 1x the 20-bar average
  shiftMaxBars: 12,                 // a failure must shift within 12 closed 5m bars (1 h) or it expires
  bounceMinRetrace: 0.5,            // spec C.2 lower high: the bounce retraces >= 50% of the displacement leg (or touches the FVG / zone)
  bounceNeedsCounter: true,         // r3.2 ruling: the failed-break RETEST bar must make a 1m higher high (short) / lower low (long) vs the previous 1m bar
  bounceMaxAwayAtr: 1.0,            // ... and comes back within 1 x ATR(5m) of the retest area (the broken swing / the level), else it is a new leg, not the retest
  retestTolPts: 6, retestDepthAtrFrac: 1 / 3, retestAwayPts: 10, atrBars: 14,   // spec C.1
  fvg: { enabled: true, entry: 'edge', minPts: 1, cancelBars: 12 },              // playbook §15.3 limit in the FVG
  setupMaxBars: 36,
  firstRetestOnly: true,            // playbook §13.7
  state1h: { lookbackBars: 48, touchTolAtr: 0.5, midFrac: 0.5 },                 // spec A market state + middle-of-range filter
  climax: { volMult: 2.0, legBars: 6, legAtr: 2.5, clearBars: 12 },              // playbook §12.5
  roomMinR: 1.0, roomBlock: false,  // playbook §8.3 (warning only by default)
  maxTargets: 12, swingsKept: 6,
  staleR: 2,                        // [rule 18 v2] an armed trap (failed-break) setup with no retest yet is FAR once price is more than max(staleR x its own risk
  staleMinPts: 60,                  //   (|level - sweep extreme|), staleMinPts) from its level; a NEARER acceptance the same way then replaces it. 0 = off (r3.2)
  climaxGate: true,                 // [r1.5.1] false = the CLIMAX with-trend entry block (§12.5) is bypassed (tide.climaxGate in the executor)
  laneAccept: true,                 // [r3.4] under TRAP control an accepted-break setup the control's way passes gate laneTrigger via the failed-break lane with the kind requirement dropped (its displacement must still hold); false = r3.3
  waveBiasTrend: true,              // [r3.5] gate waveBias passes at wavePeakBias >= 0 (not AGAINST the trade) for a WITH-TREND setup: under a same-way TRAP 4H control, or any accepted-break; everything else keeps >= 0.20. The bias is a board-proximity read: after a long move it sits near 0 and refused the 11/04 08:28 London High short. false = r3.4
  releaseOnRefusal: true,           // [r3.6] a setup whose rejection entry gradeOf refuses is CANCELLED (why REFUSED: <gate> - slot released) so ONE_IDEA stops blocking the direction; the same-way acceptance it had ONE_IDEA-skipped is armed then (Mac 11/04 08:45-08:52: S282 blocked two LONG acceptances, then was refused)
  htfAgainst: 'tag',                // [r3.7] HTF context (Mac 11/04 10:20: 'knowing if we're going with or against the high time frame trend'). 'tag' = every setup / signal / grade_no_trade row carries htf with | against | neutral, no trading change; 'half' = an against-HTF signal carries riskMult 0.5 (the planner halves the dollars; min 1 MNQ unchanged); 'skip' = against-HTF entries are refused (GRADE_NO_TRADE why HTF_AGAINST)
  controlAsBias: true,              // [r3.6] gate control4h (all kinds) also passes when the latest 15m AND 30m bias readings are not AGAINST the trade (dir*s15 >= 0 && dir*s30 >= 0); journal gates.control4h keeps the real value, waived lists 'control4h->bias'. false = r3.5 (controlFree for accepted-break only)
  controlFree: true,                // [r3.4] an accepted-break setup passes gate control4h whatever the 4H control says (opposed or none); failed-break setups keep it; false = r3.3
  nearestWins: false,               // [r3.4] SHIPPED OFF in r1.5.4 (it drops the 11/04 witness trade in the suite; needs a replay first) a new same-way setup whose level is NEARER to price replaces the armed one (any kind pairing); a farther new one is skipped; false = r3.3 precedence (trap wins, newer acceptance wins)
  ltfOpens: false,                  // [r3.4] SHIPPED OFF in r1.5.4 (a 15m Open acceptance replaces the witness's Asia Low one; needs a replay first) the 30m Open and 15m Open are tracked zones like the 1H Open (minor, rolling per period); false = r3.3 zones
  oneSetupPerDir: true,             // one live TIDE idea per direction: a trap setup supersedes an un-entered accepted-break setup the same way (no double entry on one move)
  openMaxMin: 480,                  // an entered setup counts as OPEN (live re-grade, C.4) until the executor reports it closed, the structural stop trades, or this many minutes pass
  upgradeAdd: true,                 // playbook §22: report when an open B/C trade re-grades to A+ before TP1 (live[].upgradeReady / addNow); sizing stays in lib/moneyRule.js
  // Grade evidence shaping (GRADE r3, playbook §23). These only SHAPE the evidence numbers; pass / fail lives in the grade TABLE below.
  evidence: {
    turnWindowMin: 5,               // GRADE r2 "growing turn" (reported only; not a r3 point): bias swing + 1m displacement in the last 5 min
    turnDispBodyPct: 0.6, turnDispRangeMult: 2.0, turnAvgBars: 20,
    speedTf: '1m',                  // '1m' | '15s' (15s bars passed in input.speed)
    acceptedUsesControlTrap: true,  // an accepted-break continuation inherits the trap that set the 4H tide (trap evidence = the control trap's pool)
    timingOpens: { Asia: 900, London: 0, NY: 390 },   // §23 TIMING: the 15:00 / 00:00 / 06:30 PT opens (minutes after the open, PT)
    stackedNames: ['4H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low', 'EQH', 'EQL',
      '4H ORH', '4H ORL', 'Asia ORH', 'Asia ORL', 'London ORH', 'London ORL', 'NY ORH', 'NY ORL', 'Session High', 'Session Low'],   // §23 "stacked/obvious pool" (session + OR highs/lows ARE pools)
    eqMinTouches: 2,                // an EQH/EQL is obvious with >= 2 touches
  },
  // THE GRADE TABLE: GRADE r3 (FINAL, SPEC-TIDE-r2 "GRADE r3", playbook §23). Supersedes GRADE FINAL / r2. MacArthur may drop a new one in as cfg.grade.
  // A condition is { field, op, value } on the signal's evidence (ops: eq ne gte gt lte lt in nin truthy falsy), or { any: [[cond...], [cond...]] }
  // (holds when ANY inner list ALL holds); `when` is a list that must ALL hold.
  // required: every gate must pass or there is no trade (GRADE_NO_TRADE). factors: points added when `when` holds (optional `group` capped by groupMax).
  // caps: when `when` holds the grade is at most `maxBand` (and `tag` is added). bands: first [name, minPoints] reached wins; below the last band = no trade.
  grade: {
    required: [
      { name: 'control4h', when: [{ field: 'control4h', op: 'eq', value: true }] },                                   // §1 / §23: direction only from the 4H (hold / void)
      { name: 'laneTrigger', when: [{ any: [                                                                            // §23 a valid trigger
        [{ field: 'kind', op: 'eq', value: 'failed-break' }, { field: 'dispBodyPct', op: 'gte', value: 0.5 }, { field: 'dispRangeX', op: 'gte', value: 1.0 }],   // failed break + displacement shift
        [{ field: 'kind', op: 'eq', value: 'accepted-break' }, { field: 'acceptClosesOut', op: 'gte', value: 2 }, { field: 'retestClosedInside', op: 'eq', value: false }],   // accepted break + defended retest
      ] }] },
      { name: 'waveBias', when: [{ field: 'wavePeakBias', op: 'gte', value: 0.20 }] },                                  // §23 breaking-wave bias peak >= 0.20 our way (frozen causally at the decision)
      { name: 'firstRetest', when: [{ field: 'retestNo', op: 'lte', value: 1 }] },                                      // §13.7 / §23
      { name: 'notMidRange', when: [{ field: 'midRange', op: 'eq', value: false }] },                                   // spec A / §8.6: not the middle 50% of the 1H range
      { name: 'logicalStop', when: [{ field: 'stopLogical', op: 'eq', value: true }] },                                 // §5 / §8.7: a structural stop beyond the entry
    ],                                                                                                                  // NO bias check at the entry minute (§23)
    factors: [
      { name: 'trap', points: 1, when: [{ field: 'trapStacked', op: 'eq', value: true }] },                              // §23 trap at a stacked/obvious pool
      { name: 'force', points: 1, when: [{ any: [[{ field: 'forceLegAtrX', op: 'gte', value: 2 }], [{ field: 'dispRangeX', op: 'gte', value: 2 }]] }] },   // §23 force
      { name: 'volume', points: 1, when: [{ field: 'pullbackVsBreak5m', op: 'lt', value: 1 }] },                         // §13.3 / §23 volume rhythm
      { name: 'timing', points: 1, when: [{ field: 'sweepMinutesFromOpen', op: 'gte', value: 0 }, { field: 'sweepMinutesFromOpen', op: 'lte', value: 60 }] },   // §14 / §23
      { name: 'impulseBand', points: 1, when: [{ field: 'wavePeakBias', op: 'gte', value: 0.30 }, { field: 'wavePeakBias', op: 'lt', value: 0.40 }] },   // §23
    ],
    caps: [{ name: 'exhaustionWatch', maxBand: 'C', tag: 'exhaustion-watch', when: [{ field: 'wavePeakBias', op: 'gte', value: 0.40 }] }],   // §23 peak >= 0.40 caps at C
    groupMax: {},
    bands: [['A+', 4], ['B', 3], ['C', 0]],
  },
});

const HTF_MODES = Object.freeze(['tag', 'half', 'skip']);   // [r3.7]
const TF = { m5: 300, m15: 900, m30: 1800, h1: 3600, h4: 14400 };
const CAP = { m1: 400, m5: 400, m15: 200, m30: 100, h1: 240, h4: 60, bias: 40, speed: 240, piv: 60 };
const WEIGHT_RANK = { strong: 3, obvious: 2, minor: 1 };
const NAME_RANK = ['4H Open', 'PDH', 'PDL', 'EQH', 'EQL', 'Asia High', 'Asia Low', 'London High', 'London Low', '4H ORH', '4H ORL',
  'Asia ORH', 'Asia ORL', 'London ORH', 'London ORL', 'NY ORH', 'NY ORL', '1H Open', '30m Open', '15m Open', 'Round'];

// ---------------------------------------------------------------- utils
function deepFreeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => (isNum(x) ? Math.round(x * 100) / 100 : x);
const pad = n => String(n).padStart(2, '0');
function pushCap(arr, x, n) { arr.push(x); if (arr.length > n) arr.splice(0, arr.length - n); }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mergeCfg(base, over) {
  if (over === undefined) return base;
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
  const o = {}; for (const k of Object.keys(base)) o[k] = mergeCfg(base[k], over[k]);
  for (const k of Object.keys(over)) if (!(k in o)) o[k] = over[k];
  return o;
}
const cfgCache = new WeakMap();
function resolveCfg(c) {
  if (!c) return DEFAULTS;
  if (cfgCache.has(c)) return cfgCache.get(c);
  const r = deepFreeze(mergeCfg(DEFAULTS, c)); cfgCache.set(c, r); return r;
}
function validateCfg(c) {
  const k = resolveCfg(c), err = [];
  const chk = (ok, m) => { if (!ok) err.push(m); };
  chk(isNum(k.stopBuf) && k.stopBuf >= 0 && k.stopBuf <= 20, 'stopBuf 0..20');
  chk(HTF_MODES.includes(k.htfAgainst), 'htfAgainst tag | half | skip');
  chk(isNum(k.controlGateMin) && k.controlGateMin > 0 && k.controlGateMin < 1, 'controlGateMin 0..1');
  chk(Number.isInteger(k.firstMinutesWait) && k.firstMinutesWait >= 0 && k.firstMinutesWait <= 120, 'firstMinutesWait 0..120');
  chk(Number.isInteger(k.failBars) && k.failBars >= 1 && k.failBars <= 12, 'failBars 1..12');
  chk(Number.isInteger(k.acceptBars) && k.acceptBars >= 1 && k.acceptBars <= 12, 'acceptBars 1..12');
  chk(k.dispBodyPct >= k.shiftBodyPct && k.dispBodyPct <= 1, 'dispBodyPct in [shiftBodyPct,1]');
  chk(k.bounceMinRetrace > 0 && k.bounceMinRetrace < 1, 'bounceMinRetrace 0..1');
  chk(['edge', 'mid'].includes(k.fvg.entry), "fvg.entry 'edge'|'mid'");
  chk(['1m', '15s'].includes(k.evidence.speedTf), "evidence.speedTf '1m'|'15s'");
  chk(['strict', 'offline'].includes(k.biasInput), "biasInput 'strict'|'offline'");
  for (const e of gradeTableProblems(k.grade)) err.push(e);
  return err;
}
const OPS = { eq: (a, v) => a === v, ne: (a, v) => a !== v, gte: (a, v) => isNum(a) && a >= v, gt: (a, v) => isNum(a) && a > v, lte: (a, v) => isNum(a) && a <= v,
  lt: (a, v) => isNum(a) && a < v, in: (a, v) => Array.isArray(v) && v.includes(a), nin: (a, v) => Array.isArray(v) && !v.includes(a), truthy: a => !!a, falsy: a => !a };
function condFieldsChk(c) { return c && c.any !== undefined ? (Array.isArray(c.any) && c.any.length && c.any.every(x => Array.isArray(x) && x.length) ? c.any.flat().flatMap(condFieldsChk) : [null]) : [c]; }
function gradeTableProblems(g) {
  const err = [], conds = (w, where) => {
    if (!Array.isArray(w) || !w.length) { err.push(`${where}.when must be a non-empty list`); return; }
    for (const c of w.flatMap(condFieldsChk)) {
      if (!c || typeof c.field !== 'string' || !OPS[c.op]) err.push(`${where}: each condition needs field + op (${Object.keys(OPS).join(' ')})`);
      else if (['gte', 'gt', 'lte', 'lt'].includes(c.op) && !isNum(c.value)) err.push(`${where}: ${c.field} ${c.op} needs a number`);
      else if (['in', 'nin'].includes(c.op) && !Array.isArray(c.value)) err.push(`${where}: ${c.field} ${c.op} needs a list`);
    }
  };
  if (!g || typeof g !== 'object') return ['grade table missing'];
  if (!Array.isArray(g.required)) err.push('grade.required must be a list'); else g.required.forEach((r, i) => conds(r && r.when, `grade.required[${i}] ${r && r.name}`));
  if (!Array.isArray(g.factors)) err.push('grade.factors must be a list');
  else g.factors.forEach((f, i) => { conds(f && f.when, `grade.factors[${i}] ${f && f.name}`); if (!f || typeof f.name !== 'string' || !(isNum(f.points) && f.points >= 0 && f.points <= 5)) err.push(`grade.factors[${i}] needs name + points 0..5`); });
  if (!(Array.isArray(g.bands) && g.bands.length && g.bands.every(b => Array.isArray(b) && typeof b[0] === 'string' && isNum(b[1])))) err.push('grade.bands [[name, minPoints], ...]');
  else for (let i = 1; i < g.bands.length; i++) if (!(g.bands[i][1] < g.bands[i - 1][1])) err.push('grade.bands must step down');
  if (g.caps !== undefined) { if (!Array.isArray(g.caps)) err.push('grade.caps must be a list'); else g.caps.forEach((c, i) => { conds(c && c.when, `grade.caps[${i}] ${c && c.name}`); if (!c || !(Array.isArray(g.bands) && g.bands.some(b => Array.isArray(b) && b[0] === c.maxBand))) err.push(`grade.caps[${i}] maxBand must be one of the bands`); }); }
  if (g.groupMax && typeof g.groupMax === 'object') for (const [k, v] of Object.entries(g.groupMax)) if (!(isNum(v) && v >= 0)) err.push(`grade.groupMax.${k} must be a number >= 0`);
  return err;
}

// ---------------------------------------------------------------- America/Los_Angeles clock (Intl, deterministic)
const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const offCache = new Map();
function ptOffsetMin(t) {
  const h = Math.floor(t / 3600); let o = offCache.get(h);
  if (o === undefined) {
    const p = {}; for (const x of PT_FMT.formatToParts(new Date(h * 3600000))) p[x.type] = x.value;
    o = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000 - h * 3600) / 60);
    if (offCache.size > 20000) offCache.clear(); offCache.set(h, o);
  }
  return o;
}
function ptMin(t) { return (((Math.floor(t / 60) + ptOffsetMin(t)) % 1440) + 1440) % 1440; }
function ptLabel(t) { const d = new Date((t + ptOffsetMin(t) * 60) * 1000); return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
const inWin = (m, w) => (w[0] <= w[1] ? m >= w[0] && m < w[1] : m >= w[0] || m < w[1]);
function bucketStart(tf, t, cfg) {
  if (tf === 'h4') { const off = (((ptMin(t) - cfg.h4AnchorPtMin) % 1440) + 1440) % 1440; return t - (t % 60) - (off % 240) * 60; }
  return t - (((t % TF[tf]) + TF[tf]) % TF[tf]);
}

// ---------------------------------------------------------------- state
function createState() {
  return {
    v: VERSION, lastT: null, seq: 0,
    m1: [], speed: [], bias: [], levels: {},
    bars: { m5: [], m15: [], m30: [], h1: [], h4: [] }, cur: { m5: null, m15: null, m30: null, h1: null, h4: null },
    period: null, zones: [], eps: {}, failures: [], setups: [], used: {}, retests: {},
    piv: { i5: { hi: [], lo: [] }, m5: { hi: [], lo: [] }, m1: { hi: [], lo: [] }, m15: { hi: [], lo: [] }, h1: { hi: [], lo: [] }, h4: { hi: [], lo: [] } },
    orb: {}, mstate: { state: 'TRANSITION', dir: 0 }, climax: null, needShift: {}, engulfSeen: {}, htf: null,   // [r3.7] htf: the HTF context (htfStep)
  };
}
const cloneState = s => JSON.parse(JSON.stringify(s));
function normBar(x) {
  if (!x) return null;
  const b = Array.isArray(x) ? { t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] } : x;
  if (![b.t, b.o, b.h, b.l, b.c].every(isNum)) return null;
  // r3.2 (MacDot 6623659839): a MISSING volume is not an observed 0. vk = volume known; v stays 0 for the sums, vk travels into every aggregate.
  const vk = isNum(b.v) && b.v >= 0;
  return { t: b.t, o: b.o, h: Math.max(b.h, b.o, b.c), l: Math.min(b.l, b.o, b.c), c: b.c, v: vk ? b.v : 0, vk };
}

// r3.2 (MacDot 6623647326): cfg.biasInput 'strict' (default, LIVE): only { m15: {score, valid: true, observedAt}, m30: {...} } is accepted; each
// reading needs valid === true, a finite score and a finite observedAt with T - biasMaxAgeSec <= observedAt <= T. A bare scalar anywhere (s15 / s30,
// or m15: 0.3), or s15/s30 alongside m15/m30, makes the whole minute ambiguous: rejected, the minute has no bias. 'offline' (fixtures and tools
// only) also takes bare { s15, s30 } numbers and nested readings without metadata.
// Bias readings: { s15, s30 } numbers, or { m15: { score, valid, observedAt }, m30: {...} } as the executor reads
// lvByTf.M15.biasScore / the M30 evaluation. A reading with valid === false, or observed after this 1m close, is ignored (no look-ahead).
function normBias(x, T, maxAge, mode) {
  if (!x || typeof x !== 'object') return null;
  if (mode !== 'offline') {
    const has = k => x[k] !== undefined && x[k] !== null;
    if (has('s15') || has('s30')) return null;   // a bare scalar (alone or next to nested readings) is never trusted live
    const strictOne = v => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'object' || v.valid !== true || !isNum(v.score) || !isNum(v.observedAt)) return undefined;   // present but untrusted
      const o = v.observedAt > 1e11 ? v.observedAt / 1000 : v.observedAt;
      return o <= T && (!isNum(maxAge) || T - o <= maxAge) ? v.score : undefined;
    };
    const a = strictOne(x.m15 !== undefined ? x.m15 : x.M15), b = strictOne(x.m30 !== undefined ? x.m30 : x.M30);
    const s15 = isNum(a) ? a : null, s30 = isNum(b) ? b : null;
    return isNum(s15) || isNum(s30) ? { T, s15, s30 } : null;
  }
  const one = (v, alt) => {
    if (isNum(alt)) return alt;
    if (!v || typeof v !== 'object' || v.valid === false || !isNum(v.score)) return null;
    if (isNum(v.observedAt)) { const o = v.observedAt > 1e11 ? v.observedAt / 1000 : v.observedAt; if (o > T || (isNum(maxAge) && T - o > maxAge)) return null; }   // future = look-ahead, too old = stale
    return v.score;
  };
  const s15 = one(x.m15 || x.M15, x.s15), s30 = one(x.m30 || x.M30, x.s30);
  return isNum(s15) || isNum(s30) ? { T, s15: isNum(s15) ? s15 : null, s30: isNum(s30) ? s30 : null } : null;
}

// ---------------------------------------------------------------- bar helpers
const range = b => b.h - b.l;
const bodyPct = b => (range(b) > 0 ? Math.abs(b.c - b.o) / range(b) : 0);
function avgRange(bars, n, endExcl) { const s = bars.slice(Math.max(0, endExcl - n), endExcl); return s.length ? s.reduce((a, b) => a + range(b), 0) / s.length : null; }
function atr(bars, n) {
  const k = bars.length; if (k < 2) return k ? range(bars[0]) : null;
  let s = 0, m = 0;
  for (let i = Math.max(1, k - n); i < k; i++) { const b = bars[i], p = bars[i - 1].c; s += Math.max(b.h - b.l, Math.abs(b.h - p), Math.abs(b.l - p)); m++; }
  return s / m;
}
function aggregate(st, b, cfg) {
  const closed = {};
  for (const tf of Object.keys(TF)) {
    const s = bucketStart(tf, b.t, cfg); let c = st.cur[tf];
    if (c && c.t !== s) { pushCap(st.bars[tf], c, CAP[tf]); closed[tf] = c; c = null; }
    if (!c) c = { t: s, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vk: b.vk !== false };
    else { c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; c.v += b.v; c.vk = c.vk && b.vk !== false; }
    if (b.t + 60 >= s + TF[tf]) { pushCap(st.bars[tf], c, CAP[tf]); closed[tf] = c; c = null; }
    st.cur[tf] = c;
  }
  return closed;
}
function pivotCheck(bars, left, right, T, out, lenSec) {   // confirms the bar `right` bars back
  const n = bars.length, i = n - 1 - right; if (i - left < 0) return;
  const p = bars[i]; let isH = true, isL = true;
  for (let k = i - left; k < i; k++) { if (bars[k].h >= p.h) isH = false; if (bars[k].l <= p.l) isL = false; }
  for (let k = i + 1; k < n; k++) { if (bars[k].h > p.h) isH = false; if (bars[k].l < p.l) isL = false; }
  if (isH) pushCap(out.hi, { t: p.t, price: p.h, confT: T, len: lenSec }, CAP.piv);
  if (isL) pushCap(out.lo, { t: p.t, price: p.l, confT: T, len: lenSec }, CAP.piv);
}
function formingOrLast(st, tf) { return st.cur[tf] || st.bars[tf][st.bars[tf].length - 1] || null; }

// ---------------------------------------------------------------- the map: pools as zones (playbook §4, §13.1, §14)
function buildZones(st, cfg, T) {
  const L = st.levels, pm = ptMin(T), raw = [], P = st.period;
  const price = st.m1.length ? st.m1[st.m1.length - 1].c : null;
  const add = (name, p, o) => { if (isNum(p)) raw.push(Object.assign({ name, price: p, key: o.key || `${name}@${p}`, touches: null }, o)); };
  add('4H Open', P ? P.O4 : L.O4, { type: '4H', weight: 'strong', major: true, src: 'board', setup: true });
  add('PDH', L.PDH, { type: '4H', weight: 'strong', major: true, src: 'board', setup: true });
  add('PDL', L.PDL, { type: '4H', weight: 'strong', major: true, src: 'board', setup: true });
  if (!inWin(pm, cfg.sessions.asia)) { add('Asia High', L.AsiaH, { type: 'H', weight: 'obvious', major: true, src: 'board', setup: true }); add('Asia Low', L.AsiaL, { type: 'H', weight: 'obvious', major: true, src: 'board', setup: true }); }
  if (!inWin(pm, cfg.sessions.london)) { add('London High', L.LonH, { type: 'H', weight: 'obvious', major: true, src: 'board', setup: true }); add('London Low', L.LonL, { type: 'H', weight: 'obvious', major: true, src: 'board', setup: true }); }
  const h1 = formingOrLast(st, 'h1');
  add('1H Open', isNum(L.O1) ? L.O1 : h1 && h1.o, { type: 'H', weight: 'minor', major: false, src: 'board', setup: true });
  if (cfg.ltfOpens) { const m30 = formingOrLast(st, 'm30'), m15 = formingOrLast(st, 'm15');   // [r3.4] rolling per period like the 1H Open
    add('30m Open', m30 && m30.o, { type: 'H', weight: 'minor', major: false, src: 'board', setup: true, key: m30 ? `30m Open@${m30.t}` : undefined });
    add('15m Open', m15 && m15.o, { type: 'H', weight: 'minor', major: false, src: 'board', setup: true, key: m15 ? `15m Open@${m15.t}` : undefined }); }
  for (const k of Object.keys(st.orb)) {
    const o = st.orb[k]; if (!o.done) continue;
    if (k === '4H' ? !(P && o.t0 === P.t) : !inWin(pm, sessionWin(cfg, k)) || T - o.t0 > 86400) continue;
    add(`${k} ORH`, o.h, { type: 'H', weight: 'obvious', major: false, src: 'or', setup: true, key: `${k} ORH@${o.t0}` });
    add(`${k} ORL`, o.l, { type: 'H', weight: 'obvious', major: false, src: 'or', setup: true, key: `${k} ORL@${o.t0}` });
  }
  if (cfg.pools.eq) for (const c of eqClusters(st, cfg, T)) raw.push(c);
  if (cfg.pools.round && isNum(price)) {
    const s = cfg.pools.roundStep;
    for (let p = Math.ceil((price - cfg.pools.roundSpan) / s) * s; p <= price + cfg.pools.roundSpan; p += s)
      add('Round', p, { type: 'H', weight: 'minor', major: p % 100 === 0 && false, src: 'round', setup: cfg.pools.roundAsSetup, key: `Round@${p}` });
  }
  for (const r of raw) { r.lo = isNum(r.zlo) ? r.zlo : r.price - cfg.zoneHalfPts; r.hi = isNum(r.zhi) ? r.zhi : r.price + cfg.zoneHalfPts; }
  raw.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const zones = []; let cur = null;
  const ctxOnly = r => r.src === 'round' && !cfg.pools.roundAsSetup;   // r3.2: a context-only Round is its own zone (setup false), never merged into a real pool's zone
  for (const r of raw) {
    if (ctxOnly(r)) { zones.push({ lo: r.lo, hi: r.hi, members: [r] }); continue; }
    if (cur && r.lo <= cur.hi + cfg.zoneMergePts && Math.max(cur.hi, r.hi) - Math.min(cur.lo, r.lo) <= cfg.zoneMaxWidthPts) { cur.members.push(r); cur.lo = Math.min(cur.lo, r.lo); cur.hi = Math.max(cur.hi, r.hi); }
    else { cur = { lo: r.lo, hi: r.hi, members: [r] }; zones.push(cur); }
  }
  zones.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  for (const z of zones) {
    z.members.sort(memberOrder); const p = z.members[0];
    Object.assign(z, { key: p.key, name: p.name, price: p.price, weight: p.weight, src: p.src,
      type: z.members.some(m => m.type === '4H') ? '4H' : 'H', major: z.members.some(m => m.major), setup: z.members.some(m => m.setup),
      hasO4: z.members.some(m => m.name === '4H Open'), external: z.members.some(m => m.src !== 'round'),
      touches: Math.max(0, ...z.members.map(m => m.touches || 0)) || null });
    if (!z.touches) { const t0 = T - cfg.pools.eqLookbackMin * 60, inZ = p => p.t >= t0 && p.price >= z.lo - cfg.tick && p.price <= z.hi + cfg.tick;
      z.touches = st.piv.m5.hi.filter(inZ).length + st.piv.m5.lo.filter(inZ).length; }
  }
  st.zones = zones;
  st.zoneBirth = st.zoneBirth || {};
  const live = {}; for (const z of zones) live[z.key] = st.zoneBirth[z.key] || T;
  st.zoneBirth = live;
}
function memberOrder(a, b) {
  const w = (WEIGHT_RANK[b.weight] || 0) - (WEIGHT_RANK[a.weight] || 0); if (w) return w;
  const ra = NAME_RANK.indexOf(a.name), rb = NAME_RANK.indexOf(b.name);
  return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
}
function eqClusters(st, cfg, T) {   // playbook §14.5 equal highs/lows; touch count; a pool is gone once a 5m bar CLOSES beyond it
  const out = [], m5 = st.bars.m5;
  for (const side of ['hi', 'lo']) {
    const pts = st.piv.m5[side].filter(p => p.t >= T - cfg.pools.eqLookbackMin * 60).sort((a, b) => a.price - b.price);
    let i = 0;
    while (i < pts.length) {
      let j = i; while (j + 1 < pts.length && pts[j + 1].price - pts[i].price <= cfg.pools.eqTolPts) j++;
      const cl = pts.slice(i, j + 1); i = j + 1;
      if (cl.length < 2) continue;
      const mx = Math.max(...cl.map(p => p.price)), mn = Math.min(...cl.map(p => p.price)), lastT = Math.max(...cl.map(p => p.t)), firstT = Math.min(...cl.map(p => p.t));
      let taken = false;
      for (let k = m5.length - 1; k >= 0 && m5[k].t > lastT; k--) if (side === 'hi' ? m5[k].c > mx : m5[k].c < mn) { taken = true; break; }
      if (taken) continue;
      const nm = side === 'hi' ? 'EQH' : 'EQL';
      out.push({ name: nm, price: side === 'hi' ? mx : mn, zlo: mn - cfg.tick, zhi: mx + cfg.tick, key: `${nm}@${firstT}`, touches: cl.length,
        type: 'H', weight: cl.length >= cfg.pools.eqMinTouches ? 'strong' : 'obvious', major: true, src: 'eq', setup: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------- period (4H) + opening ranges
function periodRoll(st, ctx) {
  const { cfg, b, E } = ctx, s4 = bucketStart('h4', b.t, cfg);
  if (st.period && st.period.t === s4) {
    const P = st.period;
    if (isNum(st.levels.O4) && st.levels.O4 !== P.O4 && b.t - P.t < 300) P.O4 = st.levels.O4;   // board catches up in the first minutes
    P.hi = Math.max(P.hi, b.h); P.lo = Math.min(P.lo, b.l);
    return false;
  }
  const O4 = isNum(st.levels.O4) && (!st.period || st.levels.O4 !== st.period.O4) ? st.levels.O4 : b.o;
  st.period = { t: s4, O4, hi: b.h, lo: b.l, waitUntil: s4 + cfg.firstMinutesWait * 60, control: null, trapCand: null, hold: { dir: 0, n: 0 } };
  for (const s of st.setups) if (s.status === 'armed') { s.status = s.entered ? 'done' : 'expired'; E('SETUP_EXPIRE', { setup: s.id, why: '4H closed' }); }
  st.setups = st.setups.filter(s => s.entered && !s.closed); st.failures = []; st.eps = {}; st.retests = {};
  E('PERIOD', { start: ptLabel(s4), O4 });
  return true;
}
// ---------------------------------------------------------------- [r3.7] HTF context: prior 4H, current 4H, CME day (Mac 11/04 10:20)
// From the engine's OWN 4H bars (aggregate(): st.bars.h4 closed, st.cur.h4 forming; the 4H anchor is 15:00 PT like the period). Nothing is requested.
//   prev4h = the last CLOSED 4H bar before the current period (the one the period replaced): dir +1 close > open, -1 close < open, 0 when the body is
//            within 0.1 x its range; hh / ll = it made a higher high / lower low than the 4H before it (null without one); openSide = price vs its close.
//   cur4h  = the current period: o = P.O4, side = price vs O4, control = the existing control (dir / kind) or null.
//   daily  = the CME day: o = the open of the 15:00 PT 4H candle of this day (the first 4H of the CME day: the day open is that candle's open), side = price vs it.
//   dir    = the majority of three votes: prev4h.dir, the hh/ll vote (+1 hh without ll, -1 ll without hh, else 0), daily.side; more + than - = +1, more - = -1;
//            a tie = cur4h.side (price vs the current 4H open; MacArthur 11/04), and only when that is 0 too -> 0 (neutral).
const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
function htfStep(st, ctx) {
  const { cfg, b } = ctx, P = st.period, px = b.c, h4 = st.bars.h4;
  const before = P ? h4.filter(x => x.t < P.t) : h4, prev = before[before.length - 1] || null, prev2 = before[before.length - 2] || null;
  const prev4h = prev ? { t: prev.t, at: ptLabel(prev.t), o: prev.o, h: prev.h, l: prev.l, c: prev.c, dir: Math.abs(prev.c - prev.o) <= 0.1 * range(prev) ? 0 : sgn(prev.c - prev.o),
    hh: prev2 ? prev.h > prev2.h : null, ll: prev2 ? prev.l < prev2.l : null, openSide: sgn(px - prev.c) } : null;
  const hhll = prev4h ? (prev4h.hh && !prev4h.ll ? 1 : prev4h.ll && !prev4h.hh ? -1 : 0) : 0;
  const cur4h = P ? { t: P.t, o: P.O4, side: sgn(px - P.O4), control: P.control ? { dir: P.control.dir, kind: P.control.kind } : null } : null;
  const dayT = b.t - (b.t % 60) - ((((ptMin(b.t) - cfg.h4AnchorPtMin) % 1440) + 1440) % 1440) * 60;   // the 15:00 PT 4H candle of this CME day
  const dayBar = (st.cur.h4 && st.cur.h4.t === dayT ? st.cur.h4 : null) || h4.find(x => x.t === dayT) || null;
  const daily = { t: dayT, o: dayBar ? dayBar.o : null, side: dayBar ? sgn(px - dayBar.o) : 0 };
  const votes = [prev4h ? prev4h.dir : 0, hhll, daily.side], pos = votes.filter(v => v > 0).length, neg = votes.filter(v => v < 0).length;
  st.htf = { prev4h, cur4h, daily, votes, dir: pos > neg ? 1 : neg > pos ? -1 : (cur4h ? cur4h.side : 0), tie: pos === neg };
  return st.htf;
}
function htfTag(st, dir) { const h = st.htf; return !h || !h.dir || !dir ? 'neutral' : h.dir === dir ? 'with' : 'against'; }
function orbStep(st, ctx) {
  const { cfg, b } = ctx, m = ptMin(b.t), opens = Object.assign({}, cfg.sessionOpens);
  for (const [k, om] of Object.entries(opens)) if (m === om) st.orb[k] = { t0: b.t, h: b.h, l: b.l, done: false };
  if (st.period && b.t === st.period.t) st.orb['4H'] = { t0: b.t, h: b.h, l: b.l, done: false };
  for (const o of Object.values(st.orb)) {
    if (o.done) continue;
    if (b.t > o.t0) { o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l); }
    if (b.t + 60 >= o.t0 + cfg.orMinutes * 60) o.done = true;
  }
}
function sessionWin(cfg, k) { return cfg.sessions[k.toLowerCase()] || [0, 1440]; }
function inOpenWait(st, cfg, T) {
  const P = st.period; if (P && T <= P.t + cfg.openWaitMin * 60) return `first ${cfg.openWaitMin} min of the 4H`;
  if (!cfg.sessionOpenWait) return null;
  const m = ptMin(T - 60);
  for (const [k, om] of Object.entries(cfg.sessionOpens)) { const d = (((m - om) % 1440) + 1440) % 1440; if (d < cfg.openWaitMin) return `${k} open wait`; }
  return null;
}

// ---------------------------------------------------------------- bias readings and grade evidence (spec GRADE FINAL)
function lastBias(st, T) { const r = st.bias[st.bias.length - 1]; return r && r.T === T ? r : null; }
const r4 = x => (isNum(x) ? Math.round(x * 10000) / 10000 : null);
const ourWay = (r, dir) => { const s = [r.s15, r.s30].filter(isNum).map(x => dir * x); return s.length ? Math.max(...s) : null; };   // the stronger of 15m / 30m, our way (bias never counts double)
// GRADE r2 "control taken" / "strong impulse": the peak bias OUR way during the break/shift wave [fromT, toT] (readings observed by toT only).
function waveEvidence(st, dir, fromT, toT) {
  let best = null;
  for (const r of st.bias) {
    if (r.T < fromT || r.T > toT) continue; const v = ourWay(r, dir); if (v === null) continue;
    if (!best || v > best.v) best = { v, T: r.T, tf: dir * (r.s15 ?? -Infinity) >= dir * (r.s30 ?? -Infinity) ? '15m' : '30m' };
  }
  return { wavePeakBias: best ? r4(best.v) : null, wavePeakTf: best ? best.tf : null, wavePeakAt: best ? ptLabel(best.T) : null, waveFrom: ptLabel(fromT), waveTo: ptLabel(toT) };
}
// GRADE r2 at the entry minute: entryBias (reported, never a gate) and the "growing turn" (bias swung back our way + a 1m displacement candle our way).
function entryBiasEvidence(st, cfg, dir, T) {
  const g = cfg.evidence, now = lastBias(st, T);
  const ev = { entryBias: now ? r4(ourWay(now, dir)) : null, entryBias15: now ? now.s15 : null, entryBias30: now ? now.s30 : null,
    turnDelta: null, turnDeltaTf: null, turnCandle: null, turnDisp: false, growingTurn: false };
  if (now) {
    const win = st.bias.filter(r => r.T >= T - g.turnWindowMin * 60 && r.T < T);
    for (const tf of ['s15', 's30']) {
      if (!isNum(now[tf])) continue; const prev = win.filter(r => isNum(r[tf])).map(r => dir * r[tf]); if (!prev.length) continue;
      const d = dir * now[tf] - Math.min(...prev);
      if (ev.turnDelta === null || d > ev.turnDelta) { ev.turnDelta = r4(d); ev.turnDeltaTf = tf === 's15' ? '15m' : '30m'; }
    }
  }
  const sp = g.speedTf === '15s' ? st.speed : st.m1, len = g.speedTf === '15s' ? 15 : 60;
  for (let i = sp.length - 1; i >= 0; i--) {
    const x = sp[i]; if (x.t + len <= T - g.turnWindowMin * 60) break; if (x.t + len > T) continue;
    const a = avgRange(sp, g.turnAvgBars, i);
    if (a && (dir > 0 ? x.c > x.o : x.c < x.o) && bodyPct(x) >= g.turnDispBodyPct && range(x) >= g.turnDispRangeMult * a) { ev.turnCandle = { at: ptLabel(x.t), tf: g.speedTf, range: r2(range(x)), bodyPct: r2(bodyPct(x)), rangeX: r2(range(x) / a) }; break; }
  }
  ev.turnDisp = !!ev.turnCandle;
  ev.growingTurn = ev.turnDisp && isNum(ev.turnDelta) && ev.turnDelta >= 0.10;   // convenience copy of the default table rule; the TABLE decides the point
  return ev;
}
const getField = (ev, f) => f.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), ev);
const condOk = (ev, c) => (c && Array.isArray(c.any) ? c.any.some(w => Array.isArray(w) && w.every(x => condOk(ev, x))) : OPS[c.op](getField(ev, c.field), c.value));
const condFields = c => (c && Array.isArray(c.any) ? c.any.flat().flatMap(condFields) : [c]);
// Table-driven grade (cfg.grade). Returns every gate and factor with the evidence values it read, so the journal shows WHY.
function gradeOf(ev, g, cfg) {
  const gates = {}, missing = [], points = {}, detail = {}, used = {}, waived = []; let total = 0;
  const acc = ev && ev.kind === 'accepted-break';
  for (const r of g.required) { let ok = r.when.every(c => condOk(ev, c)); const real = ok;
    // [r3.6] cfg.controlAsBias: the 4H control gate passes when the latest 15m and 30m bias readings are both not AGAINST the trade (Mac 11/04 08:52: 4H sellers, s15 +0.34 / s30 +0.32, LONG refused)
    if (!ok && cfg && cfg.controlAsBias !== false && r.name === 'control4h' && ev && isNum(ev.dir) && isNum(ev.bias15) && isNum(ev.bias30) && ev.dir * ev.bias15 >= 0 && ev.dir * ev.bias30 >= 0) { ok = true; waived.push('control4h->bias'); }
    // [r3.4] cfg.controlFree: an accepted break is not refused by the 4H control (Mac 11/04: the London ORH long against sellers' control ran +550)
    if (!ok && cfg && cfg.controlFree !== false && acc && r.name === 'control4h') ok = true;
    // [r3.4] cfg.laneAccept: under trap control an accepted break the control's way may use the failed-break lane with the kind requirement dropped (displacement kept)
    // [r3.5] kind and the 2-closes-out count are waived; the retest must NOT have closed back inside the level and the displacement terms must hold (reviewer, 11/04)
    if (!ok && cfg && cfg.laneAccept !== false && acc && r.name === 'laneTrigger' && ev.controlKind === 'trap' && ev.control4h === true && ev.retestClosedInside === false) ok = r.when.every(c => condOk(Object.assign({}, ev, { kind: 'failed-break' }), c));
    // [r3.5] cfg.waveBiasTrend: a with-trend setup (same-way trap 4H control, or an accepted break) passes gate waveBias when the peak is not AGAINST it (>= 0); the 0.20 floor stays for the rest (Mac 11/04: the 08:28 London High short, peak 0.08, refused)
    if (!ok && cfg && cfg.waveBiasTrend !== false && r.name === 'waveBias' && (acc || (ev.control4h === true && ev.controlKind === 'trap')) && isNum(ev.wavePeakBias) && ev.wavePeakBias >= 0) ok = true;
    gates[r.name] = waived.includes('control4h->bias') && r.name === 'control4h' ? real : ok; if (!ok) missing.push(r.name); }
  for (const f of g.factors) {
    const ok = f.when.every(c => condOk(ev, c)); let p = ok ? f.points : 0;
    if (p && f.group && g.groupMax && isNum(g.groupMax[f.group])) { p = Math.max(0, Math.min(p, g.groupMax[f.group] - (used[f.group] || 0))); used[f.group] = (used[f.group] || 0) + p; }
    points[f.name] = p; total += p; detail[f.name] = f.when.flatMap(condFields).map(c => ({ field: c.field, op: c.op, value: c.value, got: getField(ev, c.field) ?? null }));
  }
  let grade = null, uncapped = null; const tags = [], capped = [];
  if (!missing.length) for (const [n, min] of g.bands) if (total >= min) { grade = n; break; }
  uncapped = grade;
  if (grade && Array.isArray(g.caps)) for (const c of g.caps) {
    if (!c.when.every(x => condOk(ev, x))) continue;
    if (c.tag) tags.push(c.tag);
    const names = g.bands.map(x => x[0]), mi = names.indexOf(c.maxBand);
    if (mi >= 0 && names.indexOf(grade) < mi) { grade = c.maxBand; capped.push(c.name); }
  }
  return { waived, grade, total, points, gates, missing, detail, uncapped, capped, tags };
}

// ---------------------------------------------------------------- 4H control (spec A)
function controlStep(st, ctx, fails) {
  const { cfg, T, b, E } = ctx, P = st.period; if (!P) return;
  const C = P.control;
  if (C && C.kind === 'trap' && (C.dir < 0 ? b.h > C.ext : b.l < C.ext)) {   // "takes back the failed-breakout high"
    E('CONTROL_VOID', { dir: C.dir, ext: C.ext, why: 'price took back the failed-breakout extreme' }); P.control = null;
  }
  for (const f of fails) if (f.hasO4) {   // a FAILED break of the 4H open sets the opposite tide
    const cand = { dir: f.dir, ext: f.ext, poolWeight: 'strong', t: f.failT };
    if (!P.trapCand || P.trapCand.dir !== cand.dir || (cand.dir < 0 ? cand.ext > P.trapCand.ext : cand.ext < P.trapCand.ext)) P.trapCand = cand;
  }
  const after = T > P.waitUntil, px = b.c;
  if (P.trapCand && (P.trapCand.dir < 0 ? b.h > P.trapCand.ext : b.l < P.trapCand.ext)) P.trapCand = null;
  if (after && P.trapCand) {
    const k = P.trapCand, sideOk = k.dir < 0 ? px < P.O4 : px > P.O4;
    if (sideOk && cfg.trapControlHolds && P.control && P.control.kind === 'trap' && P.control.dir === -k.dir) {
      // r3.2 ruling (spec A): the trap control HOLDS until price takes back ITS extreme (CONTROL_VOID above) or the 4H closes. The opposite trap
      // stays a candidate: it can form only after the void (if its own extreme still holds), never as a flip.
      if (!k.heldSeen) { k.heldSeen = T; E('CONTROL_HOLD', { dir: P.control.dir, ext: P.control.ext, blockedDir: k.dir, blockedExt: k.ext, why: 'trap control holds until its extreme is taken back or the 4H closes (spec A)' }); }
    } else if (sideOk && !(P.control && P.control.kind === 'trap' && P.control.dir === k.dir)) {
      const prev = P.control;
      P.control = { dir: k.dir, kind: 'trap', ext: k.ext, poolWeight: k.poolWeight, formedT: T, bias: lastBias(st, T) };
      E(prev ? 'CONTROL_FLIP' : 'CONTROL_FORM', { dir: k.dir, kind: 'trap', ext: k.ext, from: prev ? prev.dir : 0 });
      P.trapCand = null;
    }
  }
  const rd = lastBias(st, T);
  let d = 0;
  if (rd && after) {
    const s = [rd.s15, rd.s30].filter(isNum);
    if (px < P.O4 && s.some(x => x <= -cfg.controlGateMin)) d = -1; else if (px > P.O4 && s.some(x => x >= cfg.controlGateMin)) d = 1;
  }
  P.hold = d && d === P.hold.dir ? { dir: d, n: P.hold.n + 1 } : { dir: d, n: d ? 1 : 0 };
  if (!P.control && P.hold.dir && P.hold.n >= cfg.controlHoldReadings) {
    P.control = { dir: P.hold.dir, kind: P.hold.dir < 0 ? 'below' : 'above', ext: null, poolWeight: null, formedT: T, bias: rd };
    E('CONTROL_FORM', { dir: P.hold.dir, kind: P.control.kind, s15: rd.s15, s30: rd.s30 });
  }
}

// ---------------------------------------------------------------- 5m close: breaks, acceptance, failure (playbook §8.1, §13, §14.2, spec C)
function on5m(st, ctx, bar) {
  const { cfg, T, E } = ctx, m5 = st.bars.m5, n = m5.length, idx = n - 1, prev = m5[n - 2];
  pivotCheck(m5, cfg.internalPivot.left, cfg.internalPivot.right, T, st.piv.i5, 300);
  pivotCheck(m5, cfg.pivot5.left, cfg.pivot5.right, T, st.piv.m5, 300);
  buildZones(st, cfg, T);
  const vols = m5.slice(Math.max(0, idx - cfg.volMedianBars), idx).map(x => x.v).filter(v => v > 0), vMed = median(vols);
  const fails = [], accepts = [], keys = new Set();
  for (const z of st.zones) {
    if (!z.setup) continue;
    for (const side of [1, -1]) {
      const k = `${z.key}|${side}`; keys.add(k); let ep = st.eps[k];
      const beyond = side > 0 ? bar.h > z.hi : bar.l < z.lo;
      if (!ep) {
        // a break needs price to come from the inside. On the zone's birth bar (a new 4H/1H open, a new pool) there is no prior
        // close inside it: then only the side the bar CLOSES on counts (the open's first wick the other way is not a break).
        const born = (st.zoneBirth[z.key] || 0) > (prev ? prev.t + 300 : 0);
        const from = born ? (side > 0 ? bar.o <= z.hi && bar.c > z.hi : bar.o >= z.lo && bar.c < z.lo)
          : prev ? (side > 0 ? Math.min(prev.c, bar.o) <= z.price : Math.max(prev.c, bar.o) >= z.price) : false;   // the break comes from the level's own side (not a zone entered from beyond)
        if (!(beyond && from)) continue;
        ep = st.eps[k] = { side, startT: bar.t, startPx: prev ? prev.c : bar.o, closesOut: 0, ext: side > 0 ? bar.h : bar.l, extT: bar.t, extIdxT: bar.t, breakBar: null, lowVol: false, accepted: false, acceptT: null };
        E('BREAK', { zone: z.name, level: z.price, side: side > 0 ? 'above' : 'below' });
      }
      if (side > 0 ? bar.h > ep.ext : bar.l < ep.ext) { ep.ext = side > 0 ? bar.h : bar.l; ep.extT = bar.t; }
      const out = side > 0 ? bar.c > z.hi : bar.c < z.lo, back = side > 0 ? bar.c < z.lo : bar.c > z.hi;
      if (out) {
        ep.closesOut++;
        if (!ep.breakBar) {
          ep.breakBar = Object.assign({}, bar); ep.breakVolMed = vMed;
          if (cfg.acceptVolume && bar.v > 0 && vMed && !(bar.v > vMed)) { ep.lowVol = true; E('BREAK_LOW_VOL', { zone: z.name, vol: bar.v, median: vMed }); }
          const a = avgRange(m5, cfg.avgRangeBars, idx);
          ep.breakDisp = !!a && bodyPct(bar) >= cfg.dispBodyPct && range(bar) >= cfg.dispRangeMult * a && (side > 0 ? bar.c > bar.o : bar.c < bar.o);
          ep.breakXAvg = a ? r2(range(bar) / a) : null;
        }
        if (!ep.accepted && !ep.lowVol && ep.closesOut >= cfg.acceptBars) {
          // spec C.1 + GRADE r3 (r3.1): accepted = >= acceptBars closed 5m outside. NO point-in-time bias check here: the frozen breaking-wave
          // peak (gate waveBias, >= 0.20 our way) is the bias gate for both lanes. The reading is journalled only (and used for CONTROL_CANCEL).
          const rd = lastBias(st, T), sb = rd ? [rd.s15, rd.s30].filter(isNum) : [];
          ep.accepted = true; ep.acceptT = T; ep.acceptBiasOurWay = sb.some(x => side * x >= cfg.controlGateMin); accepts.push({ z, ep, side });
          E('ACCEPT', { zone: z.name, level: z.price, side: side > 0 ? 'above' : 'below', closesOut: ep.closesOut, s15: rd ? rd.s15 : null, s30: rd ? rd.s30 : null });
        }
      } else if (back) {
        const barsFromExt = Math.round((bar.t - ep.extT) / 300) + 1;
        const depth = side > 0 ? ep.ext - z.hi : z.lo - ep.ext;   // a sweep must actually trade through the zone (cfg.breakMinPts), not tick its edge
        if (barsFromExt <= cfg.failBars && depth >= cfg.breakMinPts) {
          const f = { id: `F${++st.seq}`, dir: -side, zoneKey: z.key, zone: zoneSnap(z), hasO4: z.hasO4, ext: ep.ext, extT: ep.extT, failT: T, breakT: ep.startT,
            accepted: ep.accepted, launch: launchSwing(st, cfg, ep, side, T), live: true, armed: false, pending: null,
            breakVol: ep.breakBar ? { at: ptLabel(ep.breakBar.t), vol: ep.breakBar.v, volMedian20: ep.breakVolMed ?? null } : null };
          st.failures.push(f); fails.push(f);
          E('FAIL', { zone: z.name, level: z.price, side: side > 0 ? 'above' : 'below', ext: ep.ext, barsFromExt, acceptedFirst: ep.accepted, defended: f.launch });
        } else E('BREAK_LOST', { zone: z.name, side: side > 0 ? 'above' : 'below', barsFromExt, depth: r2(depth) });
        delete st.eps[k];
      }
    }
  }
  for (const k of Object.keys(st.eps)) if (!keys.has(k)) delete st.eps[k];
  climaxCheck(st, ctx, bar);
  engulfCheck(st, ctx);
  // setups: 5m-close cancels (and a trap setup armed before its FVG printed picks it up, §15.3)
  for (const s of st.setups) {
    if (s.status !== 'armed') continue;
    if (s.kind === 'failed-break' && !s.fvg && cfg.fvg.enabled) s.fvg = findFvg(st, cfg, s.dir, s.extT);
    if (s.kind === 'failed-break') {
      const cx = s.dir < 0 ? Math.min(s.swing, s.zone.hi) : Math.max(s.swing, s.zone.lo);
      if (s.dir < 0 ? bar.c > cx : bar.c < cx) cancelSetup(st, ctx, s, 'RECLAIM: a 5m close back through the broken swing / level');
    } else if (s.dir > 0 ? bar.c < s.zone.lo : bar.c > s.zone.hi) cancelSetup(st, ctx, s, 'ACCEPT_LOST: a 5m close back inside');
  }
  return { fails, accepts };
}
const zoneSnap = z => ({ key: z.key, name: z.name, price: z.price, lo: z.lo, hi: z.hi, type: z.type, weight: z.weight, members: z.members.map(m => m.name), touches: z.touches, external: z.external });
function launchSwing(st, cfg, ep, side, T) {   // spec B: the last internal swing the trapped side defended (the higher low that launched the push)
  const piv = side > 0 ? st.piv.i5.lo : st.piv.i5.hi, minT = ep.startT - cfg.launchLookbackBars * 300;
  for (let i = piv.length - 1; i >= 0; i--) {
    const p = piv[i]; if (p.t >= ep.extT || p.confT > T) continue; if (p.t < minT) break;
    return { price: p.price, t: p.t, at: ptLabel(p.t), src: '5m pivot' };
  }
  const bs = st.bars.m5.filter(x => x.t >= ep.startT && x.t < ep.extT);
  if (bs.length) { const x = bs.reduce((a, c) => (side > 0 ? (c.l < a.l ? c : a) : (c.h > a.h ? c : a))); return { price: side > 0 ? x.l : x.h, t: x.t, at: ptLabel(x.t), src: 'break-leg extreme' }; }
  const pb = st.bars.m5.filter(x => x.t < ep.extT).pop();
  return pb ? { price: side > 0 ? pb.l : pb.h, t: pb.t, at: ptLabel(pb.t), src: 'bar before the sweep' } : null;
}
function climaxCheck(st, ctx, bar) {   // playbook §12.5 climax = WARNING; §12.4 exhaustion wick = info
  const { cfg, T, E } = ctx, m5 = st.bars.m5, n = m5.length, c = cfg.climax;
  if (st.climax && (T - st.climax.T) / 300 >= c.clearBars) { E('CLIMAX_CLEAR', { dir: st.climax.dir, why: 'timeout' }); st.climax = null; }
  if (n < c.legBars + 2) return;
  const vm = median(m5.slice(Math.max(0, n - 1 - cfg.volMedianBars), n - 1).map(x => x.v).filter(v => v > 0));
  const a = atr(m5.slice(0, n - 1), cfg.atrBars), leg = m5.slice(n - 1 - c.legBars, n - 1);
  if (!a) return;
  const newHi = bar.h >= Math.max(...leg.map(x => x.h)), newLo = bar.l <= Math.min(...leg.map(x => x.l));
  const upLeg = newHi ? bar.h - Math.min(...leg.map(x => x.l)) : 0, dnLeg = newLo ? Math.max(...leg.map(x => x.h)) - bar.l : 0, rg = range(bar) || 1;
  const hiVol = vm && bar.v >= c.volMult * vm;
  if (upLeg >= c.legAtr * a && (bar.c - bar.l) / rg <= 0.5) {
    if (hiVol) { st.climax = { dir: 1, T }; E('CLIMAX_WARN', { dir: 1, note: 'buying climax: new longs blocked until structure confirms', vol: bar.v, median: vm }); }
    else if ((bar.h - Math.max(bar.o, bar.c)) >= 2 * Math.abs(bar.c - bar.o)) E('EXHAUSTION_WARN', { dir: 1, note: 'pin after an up leg (info only, §12.4)' });
  } else if (dnLeg >= c.legAtr * a && (bar.h - bar.c) / rg <= 0.5) {
    if (hiVol) { st.climax = { dir: -1, T }; E('CLIMAX_WARN', { dir: -1, note: 'selling climax: new shorts blocked until structure confirms', vol: bar.v, median: vm }); }
    else if ((Math.min(bar.o, bar.c) - bar.l) >= 2 * Math.abs(bar.c - bar.o)) E('EXHAUSTION_WARN', { dir: -1, note: 'pin after a down leg (info only, §12.4)' });
  }
}
function engulfCheck(st, ctx) {   // playbook §10.2 failed engulfing (evidence only; still needs the shift)
  const m5 = st.bars.m5, n = m5.length, cur = m5[n - 1];
  for (const back of [1, 2]) {
    const e = m5[n - 1 - back], p = m5[n - 2 - back]; if (!e || !p || st.engulfSeen[e.t]) continue;
    const bull = p.c < p.o && e.c > e.o && e.o <= p.c && e.c >= p.o, bear = p.c > p.o && e.c < e.o && e.o >= p.c && e.c <= p.o;
    if (bull && cur.c < e.l) { st.engulfSeen[e.t] = 1; ctx.E('ENGULF_FAILED', { dir: -1, engulfAt: ptLabel(e.t), note: 'bullish engulfing engulfed: buyers trapped' }); }
    if (bear && cur.c > e.h) { st.engulfSeen[e.t] = 1; ctx.E('ENGULF_FAILED', { dir: 1, engulfAt: ptLabel(e.t), note: 'bearish engulfing engulfed: sellers trapped' }); }
  }
  const ks = Object.keys(st.engulfSeen); if (ks.length > 50) for (const k of ks.slice(0, ks.length - 50)) delete st.engulfSeen[k];
}

// ---------------------------------------------------------------- 1H market state (spec A)
function on1h(st, ctx) {
  const { cfg, T, E } = ctx, h1 = st.bars.h1, c = cfg.state1h;
  pivotCheck(h1, cfg.pivot1h.left, cfg.pivot1h.right, T, st.piv.h1, 3600);
  const H = st.piv.h1.hi, L = st.piv.h1.lo, last = h1[h1.length - 1], prevState = st.mstate;
  let ms = { state: 'TRANSITION', dir: 0 };
  if (H.length >= 2 && L.length >= 2) {
    const [ha, hb] = H.slice(-2), [la, lb] = L.slice(-2);
    if (hb.price > ha.price && lb.price > la.price && last.c > lb.price) ms = { state: 'TREND', dir: 1, protected: lb.price };
    else if (hb.price < ha.price && lb.price < la.price && last.c < hb.price) ms = { state: 'TREND', dir: -1, protected: hb.price };
  }
  if (ms.state !== 'TREND') {
    const minT = last.t - c.lookbackBars * 3600, hs = H.filter(p => p.t >= minT), ls = L.filter(p => p.t >= minT), a = atr(h1, cfg.atrBars) || 0;
    if (hs.length >= 2 && ls.length >= 2) {
      const hi = Math.max(...hs.map(p => p.price)), lo = Math.min(...ls.map(p => p.price)), tol = c.touchTolAtr * a;
      const nh = hs.filter(p => p.price >= hi - tol).length, nl = ls.filter(p => p.price <= lo + tol).length;
      if (nh >= 2 && nl >= 2 && last.c <= hi && last.c >= lo) ms = { state: 'RANGE', dir: 0, hi, lo, touchesHi: nh, touchesLo: nl };
    }
  }
  ms.known = H.length >= 2 && L.length >= 2;   // fail-closed: until two 1H swing highs and lows exist the 1H range is UNKNOWN (midRange null -> gate notMidRange fails)
  st.mstate = ms;
  if (ms.state !== prevState.state || ms.dir !== prevState.dir || ms.hi !== prevState.hi || ms.lo !== prevState.lo) E('STATE_1H', ms);
}

// ---------------------------------------------------------------- internal shift with displacement (playbook §8.2, §14.3, §15.3; spec B)
function shiftCheck(st, ctx, tf, bar) {
  const { cfg, T, E } = ctx, bars = st.bars[tf], n = bars.length, prev = bars[n - 2]; if (!prev) return;
  const a = avgRange(bars, cfg.avgRangeBars, n - 1);
  for (const f of st.failures) {
    if (!f.live || f.armed || !f.launch) continue;
    const sw = f.launch.price, d = f.dir;
    if (tf === 'm15' && bar.t + 900 < f.extT) continue;
    const crosses = d < 0 ? bar.c < sw && prev.c >= sw : bar.c > sw && prev.c <= sw;
    if (!crosses) continue;
    const dirOk = d < 0 ? bar.c < bar.o : bar.c > bar.o, bp = bodyPct(bar);
    if (!dirOk || bp < cfg.shiftBodyPct) { if (!f.weakSeen) { f.weakSeen = 1; E('SHIFT_WEAK', { failure: f.id, tf, swing: sw, body: r2(bp) }); } continue; }
    const disp = !!a && bp >= cfg.dispBodyPct && range(bar) >= cfg.dispRangeMult * a;
    const sh = { tf, bar: Object.assign({}, bar), at: ptLabel(bar.t), body: r2(bp), xAvg: a ? r2(range(bar) / a) : null, disp };
    if (disp || tf === 'm15') armFailed(st, ctx, f, sh);
    else if (!f.pending) { f.pending = Object.assign(sh, { until: bucketStart('m15', bar.t, cfg) + 900 }); E('SHIFT_PENDING', { failure: f.id, tf, swing: sw, body: sh.body, xAvg: sh.xAvg, note: 'full body, no displacement yet: waiting for the 15m close' }); }
  }
}
function resolvePending(st, ctx) {
  for (const f of st.failures) if (f.live && !f.armed && f.pending && ctx.T >= f.pending.until) armFailed(st, ctx, f, f.pending);
}
function expireFailures(st, ctx) {
  const { cfg, T, b, E } = ctx;
  for (const f of st.failures) {
    if (!f.live || f.armed) continue;
    if (f.dir < 0 ? b.h > f.ext : b.l < f.ext) { f.live = false; E('FAIL_UNDONE', { failure: f.id, ext: f.ext }); }
    else if ((T - f.failT) / 300 > cfg.shiftMaxBars) { f.live = false; E('FAIL_EXPIRE', { failure: f.id, why: 'no internal shift: failure alone is not a trade' }); }
  }
  st.failures = st.failures.filter(f => f.live && !f.armed);
}

// ---------------------------------------------------------------- setups
// [rule 18 v2] FAR = price more than max(staleR x the trap's own risk, staleMinPts) from its level (risk = |level - sweep extreme|), no retest yet
function farTrap(cfg, px, level, ext, retestNo) { if (!(isNum(cfg.staleR) && cfg.staleR > 0) || retestNo || !isNum(px) || !isNum(level) || !isNum(ext)) return false; const risk = Math.abs(level - ext); return risk > 0 && Math.abs(px - level) > Math.max(cfg.staleR * risk, isNum(cfg.staleMinPts) ? cfg.staleMinPts : 0); }
function armFailed(st, ctx, f, sh) {   // playbook §8.2 / spec C.2: failure + the internal shift = a setup; the ENTRY waits for the retest rejection (§8.4, §13.6)
  const { cfg, T, E } = ctx, P = st.period;
  const group = st.failures.filter(g => g.live && !g.armed && g.dir === f.dir && g.launch && Math.abs(g.launch.price - f.launch.price) < 1e-9);
  group.forEach(g => { g.armed = true; });
  group.sort((x, y) => memberOrder(x.zone, y.zone) || (x.dir < 0 ? y.ext - x.ext : x.ext - y.ext));
  const p = group[0], ext = f.dir < 0 ? Math.max(...group.map(g => g.ext)) : Math.min(...group.map(g => g.ext));
  if (st.climax) { E('CLIMAX_CLEAR', { dir: st.climax.dir, why: 'structure confirmed (shift)' }); st.climax = null; }
  const ukey = `${P.t}|${p.zoneKey}|failed-break|${f.dir}`;
  E('SHIFT', { dir: f.dir, swing: f.launch.price, tf: sh.tf, at: sh.at, body: sh.body, xAvg: sh.xAvg, displacement: sh.disp, zones: group.map(g => g.zone.name) });
  if (st.used[ukey]) { E('SETUP_SKIP', { why: 'ONE_PER_ZONE: one trade per zone per 4H per kind (C.4)', zone: p.zone.name }); return; }
  if (cfg.oneSetupPerDir) {
    if (cfg.nearestWins) {   // [r3.4] the nearer same-way setup wins, whatever its kind (Mac 11/04: no trades 200 pts away with levels nearby)
      const px = ctx.b.c, dNew = Math.abs(px - p.zone.price);
      const near = st.setups.find(o => o.status === 'armed' && o.dir === f.dir && !o.entered && Math.abs(px - o.level) < dNew);
      if (near) { E('SETUP_SKIP', { why: `NEARER: ${near.zone.name} at ${r2(Math.abs(px - near.level))} pts stays; the trap on ${p.zone.name} at ${r2(dNew)} pts is farther`, zone: p.zone.name, kind: 'failed-break' }); return; }
      for (const o of st.setups) if (o.status === 'armed' && o.dir === f.dir && !o.entered) cancelSetup(st, ctx, o, `NEARER: ${p.zone.name} at ${r2(dNew)} pts replaces ${o.zone.name} at ${r2(Math.abs(px - o.level))} pts`);
    } else for (const o of st.setups) if (o.status === 'armed' && o.dir === f.dir && !o.entered) cancelSetup(st, ctx, o, `SUPERSEDED: the trap setup on ${p.zone.name} replaces it (one idea per direction)`);
    const open = st.setups.find(o => o.dir === f.dir && o.entered && !o.closed);
    if (open) { E('SETUP_SKIP', { why: `OPEN_TRADE: ${open.id} is still open the same way`, zone: p.zone.name }); return; }
  }
  const m1 = st.m1.filter(x => x.t >= p.extT);
  const s = { id: `S${++st.seq}`, kind: 'failed-break', dir: f.dir, status: 'armed', zone: p.zone, zones: group.map(g => g.zone.name), level: p.zone.price, ukey,
    stopType: p.zone.type === '4H' || (P.control && P.control.kind === 'trap') ? '4H' : '1H', ext, extT: p.extT, failT: p.failT, swing: f.launch.price, defended: f.launch,
    armT: T, shift: sh, disp: !!sh.disp, legExt: f.dir < 0 ? Math.min(...m1.map(x => x.l)) : Math.max(...m1.map(x => x.h)),
    bounce: null, retestNo: 0, fvg: findFvg(st, cfg, f.dir, p.extT), legs: {}, expiresT: T + cfg.setupMaxBars * 300,
    // grade evidence frozen at the shift: the break/shift wave runs from the failed-breakout extreme to the shift candle (GRADE r2)
    wave: waveEvidence(st, f.dir, p.extT, T), brk: shiftVolEvidence(st, cfg, sh), trapBreak: p.breakVol || null,
    // GRADE r3 setup facts (§23), fixed at the shift: sweep time (TIMING), the levels the sweep traded through (TRAP), the force leg (FORCE)
    breakT: p.breakT, sweepT: p.extT, legExtT: m1.length ? m1.reduce((a, x) => ((f.dir < 0 ? x.l <= a.l : x.h >= a.h) ? x : a)).t : T - 60,
    swept: sweptLevels(st, cfg, f.dir, f.dir < 0 ? Math.min(...group.map(g => g.zone.price)) : Math.max(...group.map(g => g.zone.price)), ext),
    force: forceEvidence(st, cfg, ext, sh.bar.c), groupMembers: [...new Set(group.flatMap(g => g.zone.members))], htf: htfTag(st, f.dir) };   // [r3.7] htf at arm time (re-read at the entry)
  st.setups.push(s);
  E('SETUP_ARM', { setup: s.id, kind: s.kind, dir: s.dir, zone: s.zone.name, level: s.level, ext: s.ext, swing: s.swing, fvg: s.fvg, stopType: s.stopType, wavePeakBias: s.wave.wavePeakBias, htf: s.htf, htfDir: st.htf ? st.htf.dir : 0,
    note: 'waiting for the retest of the broken swing / level and a 1m rejection (§8.4)' });
}
// GRADE r3 TRAP (§23): the board / opening-range levels a sweep traded through, from the failed zone to the sweep extreme (the forming
// session extreme itself is not a level: within a tick of the extreme is skipped).
function sweptLevels(st, cfg, dir, from, ext) {
  const L = st.levels, P = st.period, out = [], seen = new Set();
  const add = (name, p) => { if (!isNum(p)) return; const lo = dir < 0 ? from - cfg.zoneHalfPts : ext, hi = dir < 0 ? ext : from + cfg.zoneHalfPts;
    if (p < lo || p > hi || Math.abs(p - ext) <= cfg.tick) return; const k = `${name}@${p}`; if (!seen.has(k)) { seen.add(k); out.push({ name, price: p }); } };
  add('4H Open', P ? P.O4 : L.O4); add('PDH', L.PDH); add('PDL', L.PDL); add('Asia High', L.AsiaH); add('Asia Low', L.AsiaL); add('London High', L.LonH); add('London Low', L.LonL);
  for (const [k, o] of Object.entries(st.orb)) if (o.done && st.lastT - o.t0 <= 86400) { add(`${k} ORH`, o.h); add(`${k} ORL`, o.l); }
  return out.sort((a, b) => a.price - b.price);
}
// GRADE r3 FORCE (§23): the leg from the sweep extreme (or the break start) to the shift / acceptance close, in ATR(5m) units
function forceEvidence(st, cfg, from, to) {
  const a = atr(st.bars.m5, cfg.atrBars), leg = isNum(from) && isNum(to) ? Math.abs(to - from) : null;
  return { forceLegPts: r2(leg), forceAtr5: r2(a), forceLegAtrX: a && isNum(leg) ? r2(leg / a) : null };
}
// GRADE r3 VOLUME + wave end (§23, §13.3): the pullback starts after the last internal 5m low (short) / high (long) printed at or after the
// leg extreme and confirmed by T; its 5m bars are the closed ones after it plus the forming one pro-rated to 5 minutes (causal).
function pullbackEvidence(st, cfg, s, T) {
  const d = s.dir, legT = isNum(s.legExtT) ? s.legExtT : T - 60, legB = legT - (legT % 300);
  const piv = (d < 0 ? st.piv.i5.lo : st.piv.i5.hi).filter(p => p.t >= legB && p.confT <= T);
  const startB = piv.length ? piv[piv.length - 1].t : legB, bars = [];
  for (const x of st.bars.m5) if (x.t > startB && x.t + 300 <= T) bars.push({ at: ptLabel(x.t), vol: x.v, minutes: 5, vol5: x.v, volKnown: x.vk !== false });
  const cur = st.cur.m5; if (cur && cur.t > startB && T > cur.t) { const mins = (T - cur.t) / 60; bars.push({ at: ptLabel(cur.t), vol: cur.v, minutes: mins, vol5: r2(cur.v * 5 / mins), forming: true, volKnown: cur.vk !== false }); }
  if (!bars.length) {   // the whole pullback sits inside one 5m bar: the 1m bars after the leg extreme, pro-rated
    const m = st.m1.filter(x => x.t > legT && x.t + 60 <= T); if (m.length) bars.push({ at: ptLabel(m[0].t), volKnown: m.every(x => x.vk !== false), vol: m.reduce((a, x) => a + x.v, 0), minutes: m.length, vol5: r2(m.reduce((a, x) => a + x.v, 0) * 5 / m.length), from1m: true });
  }
  // fail-closed (r3.2): ANY contributing minute with an unknown volume withholds the comparison (point null); an observed 0 is a real 0
  const volMissing = bars.some(x => !x.volKnown);
  const mean = bars.length && !volMissing ? bars.reduce((a, x) => a + x.vol5, 0) / bars.length : null, brk5 = s.brk && s.brk.volKnown && s.brk.perMin > 0 ? s.brk.perMin * 5 : null;
  return { pullbackFrom: ptLabel(startB), pullbackFromSrc: piv.length ? 'internal 5m pivot' : 'leg extreme bar', pullbackBars5m: bars, pullbackVolMissing: volMissing || !bars.length,
    pullbackVol5mMean: r2(mean), breakVol5m: r2(brk5), pullbackVsBreak5m: isNum(mean) && brk5 ? r2(mean / brk5) : null, waveEndT: startB + 300 };
}
// break-candle volume vs its own 20-bar median (playbook §13.2), per minute so 5m and 15m candles compare with the 1m pullback (§13.3)
function shiftVolEvidence(st, cfg, sh) {
  const bars = st.bars[sh.tf] || [], i = bars.findIndex(x => x.t === sh.bar.t), mins = TF[sh.tf] / 60;
  const med = median(bars.slice(Math.max(0, i - cfg.volMedianBars), i < 0 ? bars.length : i).map(x => x.v).filter(v => v > 0));
  return { tf: sh.tf, vol: sh.bar.v, volKnown: sh.bar.vk !== false, volMedian20: med, volX: med ? r2(sh.bar.v / med) : null, perMin: sh.bar.v / mins, endT: sh.bar.t + TF[sh.tf] };
}
function findFvgFor(st, cfg, s) { if (!s.fvg) s.fvg = findFvg(st, cfg, s.dir, s.extT); return s.fvg; }
// where a B grade's resting second half / an add can sit (D5 "the retest/FVG level"): the FVG the displacement left, else the broken swing (trap) / the zone edge
function addZoneOf(st, cfg, s) {
  const d = s.dir;
  if (s.kind === 'failed-break') {
    const fv = cfg.fvg.enabled ? findFvgFor(st, cfg, s) : null;
    if (fv) return { kind: 'fvg', price: roundTick(cfg.fvg.entry === 'mid' ? (fv.lo + fv.hi) / 2 : d < 0 ? fv.lo : fv.hi, cfg, d), lo: fv.lo, hi: fv.hi, formedAt: fv.formedAt };
    return { kind: 'broken-swing', price: s.swing, lo: s.swing, hi: s.swing };
  }
  return { kind: 'zone', price: d < 0 ? s.zone.lo : s.zone.hi, lo: s.zone.lo, hi: s.zone.hi };
}
function armAccepted(st, ctx, a) {   // playbook §8.1 / §13 / spec C.1: an accepted break arms a continuation setup; the ENTRY is the defended retest's 1m rejection
  const { cfg, T, E } = ctx, P = st.period, z = a.z, dir = a.side;
  if (st.climax && st.climax.dir !== dir) { /* opposite-direction acceptance confirms structure */ E('CLIMAX_CLEAR', { dir: st.climax.dir, why: 'accepted break' }); st.climax = null; }
  // unchanged from r3.0: a bias-kind control is cancelled only by an acceptance of the 4H open against it WITH the bias past the line
  if (P.control && P.control.kind !== 'trap' && P.control.dir === -dir && z.hasO4 && a.ep.acceptBiasOurWay) { E('CONTROL_CANCEL', { dir: P.control.dir, why: 'accepted break of the 4H open against it' }); P.control = null; P.hold = { dir: 0, n: 0 }; }
  const ukey = `${P.t}|${z.key}|accepted-break|${dir}`;
  if (st.used[ukey] || st.setups.some(s => s.ukey === ukey && s.status === 'armed')) return;
  if (cfg.oneSetupPerDir) {   // one idea per direction: a trap setup or an open trade the same way wins; a newer acceptance replaces an older un-entered one
    for (const o of st.setups) if (o.status === 'armed' && o.dir === dir && !o.entered && o.kind === 'failed-break' && farTrap(cfg, ctx.b.c, o.level, o.ext, o.retestNo) && Math.abs(ctx.b.c - z.price) < Math.abs(ctx.b.c - o.level))
      cancelSetup(st, ctx, o, `FAR: ${r2(Math.abs(ctx.b.c - o.level))} pts from price (> max(${cfg.staleR} x risk ${r2(Math.abs(o.level - o.ext))}, ${cfg.staleMinPts}), no retest); the acceptance at ${z.name} is nearer (rule 18)`);
    if (cfg.nearestWins) {   // [r3.4] the nearer same-way setup wins, whatever its kind
      const px = ctx.b.c, dNew = Math.abs(px - z.price);
      const near = st.setups.find(o => o.status === 'armed' && o.dir === dir && !o.entered && Math.abs(px - o.level) < dNew);
      if (near) { E('SETUP_SKIP', { why: `NEARER: ${near.zone.name} at ${r2(Math.abs(px - near.level))} pts stays; the acceptance at ${z.name} at ${r2(dNew)} pts is farther`, zone: z.name, kind: 'accepted-break' }); return; }
      for (const o of st.setups) if (o.status === 'armed' && o.dir === dir && !o.entered) cancelSetup(st, ctx, o, `NEARER: ${z.name} at ${r2(dNew)} pts replaces ${o.zone.name} at ${r2(Math.abs(px - o.level))} pts`);
    }
    let blk = st.setups.find(s => s.dir === dir && ((s.status === 'armed' && s.kind === 'failed-break') || (s.entered && !s.closed)));
    if (blk && cfg.releaseOnRefusal !== false && !blk.entered && blk.refused) { cancelSetup(st, ctx, blk, `REFUSED trap gives way to the acceptance at ${z.name}`); blk = null; }   // [r3.6]
    if (blk && cfg.releaseOnRefusal !== false && !blk.entered) (st.pendingAcc || (st.pendingAcc = {}))[dir] = { a, T, pt: P.t };   // [r3.6] remembered: it arms if the trap is refused
    if (blk) { E('SETUP_SKIP', { why: `ONE_IDEA: ${blk.id} (${blk.kind}) is already ${blk.entered ? 'open' : 'armed'} the same way`, zone: z.name, kind: 'accepted-break' }); return; }
    for (const o of st.setups) if (o.status === 'armed' && o.dir === dir && o.kind === 'accepted-break' && !o.entered) cancelSetup(st, ctx, o, `SUPERSEDED: the newer acceptance at ${z.name} replaces it`);
  }
  if (st.setups.some(s => s.status === 'armed' && s.kind === 'failed-break' && s.dir === dir && s.zones.includes(z.name))) { E('SETUP_SKIP', { why: 'SAME_TRADE: an armed trap setup already covers this zone', zone: z.name, kind: 'accepted-break' }); return; }
  const bb = a.ep.breakBar;
  const s = { id: `S${++st.seq}`, kind: 'accepted-break', dir, status: 'armed', zone: zoneSnap(z), zones: [z.name], level: z.price, ukey, stopType: z.type === '4H' ? '4H' : '1H',
    armT: T, acceptT: T, breakBar: bb, breakVol: bb ? bb.v : null, disp: !!a.ep.breakDisp, maxAway: 0, retest: null, retestNo: 0, legs: {}, expiresT: T + cfg.setupMaxBars * 300,
    wave: waveEvidence(st, dir, a.ep.startT, T), shift: null,
    breakT: a.ep.startT, sweepT: a.ep.startT, legExtT: T - 60, acceptClosesOut: a.ep.closesOut, retestClosedInside: false, swept: null, groupMembers: z.members.map(m => m.name),
    force: forceEvidence(st, cfg, a.ep.startPx, st.bars.m5[st.bars.m5.length - 1].c),
    dispStats: { tf: 'm5', at: bb ? ptLabel(bb.t) : null, body: bb ? r2(bodyPct(bb)) : null, xAvg: a.ep.breakXAvg ?? null },
    brk: bb ? { tf: 'm5', vol: bb.v, volKnown: bb.vk !== false, volMedian20: a.ep.breakVolMed ?? null, volX: a.ep.breakVolMed ? r2(bb.v / a.ep.breakVolMed) : null, perMin: bb.v / 5, endT: bb.t + 300 } : null, htf: htfTag(st, dir) };   // [r3.7]
  st.setups.push(s);
  E('SETUP_ARM', { setup: s.id, kind: s.kind, dir, zone: z.name, level: z.price, stopType: s.stopType, breakDisp: s.disp, wavePeakBias: s.wave.wavePeakBias, htf: s.htf, htfDir: st.htf ? st.htf.dir : 0, note: 'waiting for the defended retest (§13)' });
}
function cancelSetup(st, ctx, s, why) { s.status = 'cancelled'; ctx.E('SETUP_CANCEL', { setup: s.id, kind: s.kind, dir: s.dir, zone: s.zone.name, why }); }
function roundTick(p, cfg, dir) { const k = p / cfg.tick; return (dir < 0 ? Math.floor(k + 1e-9) : Math.ceil(k - 1e-9)) * cfg.tick; }
function findFvg(st, cfg, dir, extT) {   // playbook §15 FVG: bearish when candle 1 LOW > candle 3 HIGH
  const m5 = st.bars.m5; let best = null;
  for (let i = 2; i < m5.length; i++) {
    const c1 = m5[i - 2], c3 = m5[i]; if (c3.t < extT) continue;
    const lo = dir < 0 ? c3.h : c1.h, hi = dir < 0 ? c1.l : c3.l;
    if (!(hi - lo >= cfg.fvg.minPts)) continue;
    const after = st.m1.filter(x => x.t >= c3.t + 300);
    if (after.some(x => (dir < 0 ? x.h >= lo : x.l <= hi))) continue;   // already retested
    const f = { lo, hi, formedAt: ptLabel(c3.t + 300), c1: ptLabel(c1.t), c3: ptLabel(c3.t), formedT: c3.t + 300 };
    if (!best || (dir < 0 ? lo < best.lo : hi > best.hi)) best = f;
  }
  return best;
}
// r3.2 ruling (§13.7): the retest count belongs to ONE break (failed or accepted), not to the zone per 4H. A cancelled setup's touch, or the
// other lane's touch, never uses up a later break's first retest; a 2nd touch of the same break counts 2 (RETEST_2_SKIP).
const retestKeyOf = s => `${s.kind}|${s.zone.key}|${s.dir}|${isNum(s.breakT) ? s.breakT : s.armT}`;
function noteRetest(st, s) { const k = retestKeyOf(s); return (st.retests[k] = (st.retests[k] || 0) + 1); }
function setups1m(st, ctx) {
  const { cfg, T, b, E } = ctx, a5 = atr(st.bars.m5, cfg.atrBars) || 0;
  for (const s of st.setups) {
    if (s.status !== 'armed' || s.armT === T) continue;
    if (T > s.expiresT) { s.status = 'expired'; E('SETUP_EXPIRE', { setup: s.id, why: 'no retest in time' }); continue; }
    const d = s.dir;
    if (s.kind === 'failed-break') {
      if (d < 0 ? b.h > s.ext : b.l < s.ext) { cancelSetup(st, ctx, s, 'TRAP_UNDONE: price took back the failed-breakout extreme'); continue; }
      if (!s.bounce) {
        const thr = s.legExt + cfg.bounceMinRetrace * (s.swing - s.legExt);
        const near = d < 0 ? Math.min(s.swing, s.zone.lo) - cfg.retestTolPts : Math.max(s.swing, s.zone.hi) + cfg.retestTolPts;
        const area = d < 0 ? Math.min(s.swing, s.zone.lo) : Math.max(s.swing, s.zone.hi), closeEnough = Math.abs((d < 0 ? b.h : b.l) - area) <= cfg.bounceMaxAwayAtr * a5 || (d < 0 ? b.h >= area : b.l <= area);
        const reach = closeEnough && (d < 0 ? (b.h >= thr || b.h >= near || (s.fvg && b.h >= s.fvg.lo)) : (b.l <= thr || b.l <= near || (s.fvg && b.l <= s.fvg.hi)));
        // r3.2 ruling (spec C.2 "a 1m/5m bounce toward it", §3 "I don't chase red candles"): the RETEST bar must be a real counter-move, a 1m higher
        // high (short) / lower low (long) than the previous 1m bar, after the shift candle. A continuation bar that merely sits within retestTolPts
        // of the broken swing is not a bounce.
        const pv = st.m1[st.m1.length - 2], counter = !cfg.bounceNeedsCounter || (!!pv && (d < 0 ? b.h > pv.h : b.l < pv.l));
        const hit = reach && counter;
        if (reach && !counter && !s.chaseSeen) { s.chaseSeen = T; E('BOUNCE_NOT_COUNTER', { setup: s.id, high: b.h, low: b.l, prevHigh: pv ? pv.h : null, prevLow: pv ? pv.l : null, note: 'a continuation bar near the broken swing is not a bounce (no chasing)' }); }
        if (hit) {
          s.bounce = { startT: T, ext: d < 0 ? b.h : b.l, ref: d < 0 ? b.l : b.h }; s.retestNo = noteRetest(st, s);
          E('RETEST', { setup: s.id, n: s.retestNo, kind: s.kind, bounce: s.bounce.ext, threshold: r2(thr), note: 'bounce toward the broken swing (a lower high under the level counts)' });
        } else if (d < 0 ? b.l <= s.legExt : b.h >= s.legExt) { s.legExt = d < 0 ? b.l : b.h; s.legExtT = b.t; }
      } else if (d < 0 ? b.h > s.bounce.ext : b.l < s.bounce.ext) { s.bounce.ext = d < 0 ? b.h : b.l; s.bounce.ref = d < 0 ? b.l : b.h; }
      else if (d < 0 ? b.c < s.bounce.ref : b.c > s.bounce.ref) {
        E('REJECTION', { setup: s.id, close: b.c, through: s.bounce.ref, bounce: s.bounce.ext });
        rejectionEntry(st, ctx, s);
      }
    } else {
      const z = s.zone;
      if (!s.retest) {
        { const away = d > 0 ? b.h - z.hi : z.lo - b.l; if (away >= s.maxAway) { s.maxAway = away; s.legExtT = b.t; } }
        if (s.maxAway < cfg.retestAwayPts) continue;
        const touch = d > 0 ? b.l <= z.hi + cfg.retestTolPts - (z.hi - z.price) : b.h >= z.lo - cfg.retestTolPts + (z.price - z.lo);
        if (!touch) continue;
        const through = d > 0 ? s.level - b.l : b.h - s.level;
        s.retestNo = noteRetest(st, s);
        if (through > a5 * cfg.retestDepthAtrFrac) { cancelSetup(st, ctx, s, `RETEST_DEEP: through the level by ${r2(through)} > ATR5/3 ${r2(a5 * cfg.retestDepthAtrFrac)}`); continue; }
        s.retest = { t: T, ext: d > 0 ? b.l : b.h, ref: d > 0 ? b.h : b.l, vol: b.v };
        E('RETEST', { setup: s.id, n: s.retestNo, kind: s.kind, wick: s.retest.ext, level: s.level });
      } else if (d > 0 ? b.l < s.retest.ext : b.h > s.retest.ext) {
        const through = d > 0 ? s.level - b.l : b.h - s.level;
        if (through > a5 * cfg.retestDepthAtrFrac) { cancelSetup(st, ctx, s, `RETEST_DEEP: through the level by ${r2(through)}`); continue; }
        s.retest.ext = d > 0 ? b.l : b.h; s.retest.ref = d > 0 ? b.h : b.l;
        if (d > 0 ? b.c < s.level : b.c > s.level) s.retestClosedInside = true;
      } else if (d > 0 ? b.c > s.retest.ref : b.c < s.retest.ref) {
        if (d > 0 ? b.c < s.level : b.c > s.level) s.retestClosedInside = true;
        E('REJECTION', { setup: s.id, close: b.c, through: s.retest.ref, wick: s.retest.ext });
        rejectionEntry(st, ctx, s);
      } else if (d > 0 ? b.c < s.level : b.c > s.level) s.retestClosedInside = true;   // §23 the defended retest never CLOSES back inside (gate laneTrigger)
    }
  }
  st.setups = st.setups.filter(s => s.status === 'armed' || (s.entered && !s.closed) || s.armT >= T - 3600);
}
// Session clock for the evidence (PT): the last session open at or before T (Asia 15:00, London 00:00, NY 06:30).
function sessionOf(cfg, T) {
  const m = ptMin(T - 60); let best = null;
  for (const [k, om] of Object.entries(cfg.sessionOpens)) { const d = (((m - om) % 1440) + 1440) % 1440; if (!best || d < best.d) best = { k, d }; }
  return best ? { session: best.k, minutesFromSessionOpen: best.d + 1 } : { session: null, minutesFromSessionOpen: null };
}
// GRADE r3 facts frozen causally at the DECISION (§23): the breaking-wave bias peak (sweep / break -> start of the pullback, readings
// observed by T only), the pullback volume, TRAP stacking, TIMING. Computed once at the entry decision and reused by the live re-grade.
function r3Facts(st, cfg, s, T) {
  const d = s.dir, pb = pullbackEvidence(st, cfg, s, T), w = waveEvidence(st, d, s.sweepT, Math.min(T, pb.waveEndT)), C = st.period && st.period.control, g = cfg.evidence;
  let obvious = [], swept = s.swept || [], stacked = false, trapFrom = null;
  if (s.kind === 'failed-break') {
    obvious = (s.groupMembers || []).filter(n => g.stackedNames.includes(n) && !(/^EQ[HL]$/.test(n) && !((s.zone.touches || 0) >= g.eqMinTouches)));
    stacked = obvious.length > 0 || swept.length >= 2; trapFrom = 'this sweep';
  } else if (g.acceptedUsesControlTrap && C && C.kind === 'trap' && C.dir === d) { obvious = ['4H Open']; stacked = true; trapFrom = `control trap (${C.ext})`; }
  let best = null; const m = ptMin(s.sweepT);
  for (const [k, om] of Object.entries(g.timingOpens)) { const x = (((m - om) % 1440) + 1440) % 1440; if (!best || x < best.x) best = { k, x }; }
  return Object.assign({}, w, { wavePeakAtShift: s.wave ? s.wave.wavePeakBias : null, waveFrozenAt: ptLabel(T) }, pb, {
    trapStacked: stacked, trapObviousPools: obvious, trapSweptLevels: swept.map(x => `${x.name} ${x.price}`), trapSweptCount: swept.length, trapFrom,
    sweepAt: ptLabel(s.sweepT), sweepOpen: best ? best.k : null, sweepMinutesFromOpen: best ? best.x : null }, s.force || {});
}
// Every evidence field on every signal and every live re-grade (the team's grade review reads these; the TABLE decides).
function evidenceFor(st, cfg, s, T, retestNo, extra) {
  const P = st.period, C = P && P.control, d = s.dir, eb = entryBiasEvidence(st, cfg, d, T), sess = sessionOf(cfg, T), lb = st.bias.length ? st.bias[st.bias.length - 1] : null;
  const trapW = s.kind === 'failed-break' ? s.zone.weight : (cfg.evidence.acceptedUsesControlTrap && C && C.kind === 'trap' && C.dir === d ? C.poolWeight : null);
  const disp = s.kind === 'failed-break' ? { tf: s.shift.tf, at: s.shift.at, body: s.shift.body, xAvg: s.shift.xAvg } : s.dispStats;
  const pull = st.m1.filter(x => s.brk && x.t >= s.brk.endT && x.t + 60 <= T), pullPerMin = pull.length ? pull.reduce((a, x) => a + x.v, 0) / pull.length : null;
  return Object.assign({
    dir: d, bias15: lb ? lb.s15 : null, bias30: lb ? lb.s30 : null,   // [r3.6] the latest bias-book readings (gate control4h as bias)
    control4h: !!(C && C.dir === d), controlDir: C ? C.dir : 0, controlKind: C ? C.kind : null, controlExt: C ? C.ext : null, controlFormedAt: C ? ptLabel(C.formedT) : null,
    kind: s.kind, poolName: s.zone.name, poolMembers: s.zone.members, poolType: s.zone.type === '4H' ? '4H' : '1H', poolSrc: s.zone.src || null, poolWeight: s.zone.weight,
    poolTouches: s.zone.touches || null, trapPoolWeight: trapW || null, trapPool: s.kind === 'failed-break' ? s.zone.name : (trapW ? `control trap (${C.ext})` : null),
    dispTf: disp ? disp.tf : null, dispAt: disp ? disp.at : null, dispBodyPct: disp ? disp.body : null, dispRangeX: disp ? disp.xAvg : null,
    retestNo: isNum(retestNo) ? retestNo : s.retestNo || 0,
    acceptClosesOut: s.kind === 'accepted-break' ? s.acceptClosesOut : null, retestClosedInside: s.kind === 'accepted-break' ? !!s.retestClosedInside : false,
    midRange: midRangeOf(st, cfg, s.level), stopLogical: extra && extra.stopLogical !== undefined ? extra.stopLogical : true,
  }, s.wave, s.frozen || r3Facts(st, cfg, s, T), eb, {
    breakTf: s.brk ? s.brk.tf : null, breakVol: s.brk ? s.brk.vol : null, breakVolMedian20: s.brk ? s.brk.volMedian20 : null, breakVolX: s.brk ? s.brk.volX : null,
    pullbackVolPerMin: pullPerMin === null ? null : r2(pullPerMin), pullbackVsBreak: pullPerMin !== null && s.brk && s.brk.perMin > 0 ? r2(pullPerMin / s.brk.perMin) : null,
    trapBreakVol: s.trapBreak ? s.trapBreak.vol : null, trapBreakVolMedian20: s.trapBreak ? s.trapBreak.volMedian20 : null,
    session: sess.session, minutesFromSessionOpen: sess.minutesFromSessionOpen, minutesFrom4hOpen: P ? Math.round((T - P.t) / 60) : null,
    marketState: st.mstate.state, marketDir: st.mstate.dir || 0, range1hKnown: !!st.mstate.known,
    climax: !!(st.climax && st.climax.dir === d), climaxAgainst: !!(st.climax && st.climax.dir === -d),
    measuredAt: ptLabel(T),
  });
}
// playbook §22: re-grade every OPEN setup each minute (same table, live evidence). A B/C trade that re-grades to A+ before TP1 reports
// upgradeReady, and addNow on the next rejected 1m pullback. Sizing of the add is lib/moneyRule.js's job.
function liveGrades(st, ctx) {
  const { cfg, T, b, E } = ctx, out = [], prev = st.m1[st.m1.length - 2];
  for (const s of st.setups) {
    if (!s.entered || s.closed) continue;
    const d = s.dir;
    if (d < 0 ? b.h >= s.firstStop : b.l <= s.firstStop) {   // virtual full stop (C.4): a new trigger the same way needs a new shift
      s.closed = T; s.closedWhy = 'stop'; st.needShift[d] = T; E('TRADE_STOPPED', { setup: s.id, stop: s.firstStop, note: 'engine view (virtual): a new trigger needs a new internal shift (C.4)' }); continue;
    }
    if (T - s.entered >= cfg.openMaxMin * 60) { s.closed = T; s.closedWhy = 'age'; E('TRADE_AGED', { setup: s.id, minutes: cfg.openMaxMin }); continue; }
    const ev = evidenceFor(st, cfg, s, T, s.entryRetestNo), g = gradeOf(ev, cfg.grade, cfg), was = s.liveGrade;
    s.liveGrade = g.grade;
    const upgradeReady = !!(cfg.upgradeAdd && s.entryGrade && s.entryGrade !== 'A+' && g.grade === 'A+' && !s.upgradeDone && !s.tp1Done);
    if (g.grade !== was) E('GRADE_LIVE', { setup: s.id, from: was || null, to: g.grade, total: g.total, upgradeReady });
    let addNow = false;
    if (upgradeReady && prev) {
      if (!s.pb) { if (d < 0 ? b.h > prev.h : b.l < prev.l) s.pb = { ext: d < 0 ? b.h : b.l, ref: d < 0 ? b.l : b.h }; }
      else if (d < 0 ? b.h > s.pb.ext : b.l < s.pb.ext) { s.pb.ext = d < 0 ? b.h : b.l; s.pb.ref = d < 0 ? b.l : b.h; }
      else if (d < 0 ? b.c < s.pb.ref : b.c > s.pb.ref) { addNow = true; s.upgradeDone = T; E('GRADE_UPGRADE', { setup: s.id, from: s.entryGrade, to: g.grade, oldPoints: s.entryPoints, newPoints: g.total, price: b.c, pullback: s.pb.ext, stop: s.firstStop }); s.pb = null; }
    } else s.pb = null;
    out.push({ setupId: s.id, signalId: s.firstSignal, dir: d, kind: s.kind, entryGrade: s.entryGrade, entryPoints: s.entryPoints, currentGrade: g.grade, total: g.total, points: g.points, tags: g.tags,
      frozenAt: s.frozen ? s.frozen.waveFrozenAt : null,
      missing: g.missing, upgradeReady, addNow, addPrice: addNow ? b.c : null, stop: s.firstStop, upgradeDone: !!s.upgradeDone, evidence: ev });
  }
  return out;
}
function midRangeOf(st, cfg, level) {   // spec A / §8.6: the middle 50% of the 1H range (RANGE state only)
  const ms = st.mstate; if (!ms.known || !isNum(level)) return null; if (ms.state !== 'RANGE') return false;
  const w = ms.hi - ms.lo, m = (w * (1 - cfg.state1h.midFrac)) / 2; return level > ms.lo + m && level < ms.hi - m;
}
function rejectionEntry(st, ctx, s) {   // spec C.1 / C.2: the first 1m close back away after the bounce toward the broken swing / level
  const { cfg, b } = ctx;
  s.status = 'done';
  if (cfg.firstRetestOnly && s.retestNo > 1) { ctx.E('RETEST_2_SKIP', { setup: s.id, n: s.retestNo, note: 'only the FIRST retest is traded (§13.7)' }); return; }
  emit(st, ctx, s, { entryType: 'market', entryPrice: b.c, trigger: 'retest-rejection' });
}

// ---------------------------------------------------------------- signal (gates, stops, grade, targets)
function emit(st, ctx, s, e) {
  const { cfg, T, E } = ctx, P = st.period, d = s.dir, buf = cfg.stopBuf, warn = [], reason = [];
  const skip = why => { E('SIGNAL_SKIP', { setup: s.id, kind: s.kind, dir: d, zone: s.zone.name, trigger: e.trigger, why }); return null; };
  const C = P.control;
  if (st.used[s.ukey]) return skip('ONE_PER_ZONE');
  s.htf = htfTag(st, d); const htfDir = st.htf ? st.htf.dir : 0;   // [r3.7] re-read at the entry
  if (cfg.htfAgainst === 'skip' && s.htf === 'against') {
    E('GRADE_NO_TRADE', { setup: s.id, total: null, points: null, missing: ['htf'], gates: null, waived: [], why: ['HTF_AGAINST'], htf: s.htf, htfDir });
    if (cfg.releaseOnRefusal !== false && !s.entered) { s.refused = T; cancelSetup(st, ctx, s, 'REFUSED: HTF_AGAINST - slot released'); const pend = st.pendingAcc && st.pendingAcc[d]; if (pend) { delete st.pendingAcc[d]; if (pend.pt === P.t && T - pend.T <= cfg.setupMaxBars * 300) armAccepted(st, ctx, pend.a); } }
    return skip('HTF_AGAINST');
  }
  const ow = inOpenWait(st, cfg, T); if (ow) return skip(`OPEN_WAIT: ${ow}`);
  if (cfg.climaxGate !== false && st.climax && st.climax.dir === d) return skip('CLIMAX: with-trend entries blocked until structure confirms (§12.5)');   // [r1.5.1] cfg.climaxGate
  const ms = st.mstate;
  if (ms.state === 'TRANSITION' && !s.zone.external) return skip('TRANSITION: not at an external level');
  if (isNum(st.needShift[d]) && !(s.kind === 'failed-break' ? s.armT > st.needShift[d] : s.armT > st.needShift[d] && s.disp)) return skip('NEED_SHIFT: after a full stop a new trigger needs a new shift (C.4)');
  if (s.kind === 'accepted-break' && cfg.acceptVolume && s.breakVol > 0) {
    const pull = st.bars.m5.filter(x => x.t + 300 > s.acceptT && x.t + 300 <= T).map(x => x.v);
    const pv = pull.length ? pull.reduce((a, c) => a + c, 0) / pull.length : 0;
    if (pull.length && !(pv < s.breakVol)) return skip(`VOL_RHYTHM: pullback volume ${r2(pv)} >= breakout volume ${s.breakVol} (§13.3 possible trap)`);
    reason.push(`volume rhythm ok: pullback ${r2(pv)} < breakout ${s.breakVol}`);
  }
  // stops (playbook §5 option C; spec C.1/C.2). Journal every candidate; chosenStop = the rule's stop. The stop is never moved to fit (§17).
  const h1 = formingOrLast(st, 'h1'), hour1Wick = h1 ? (d < 0 ? h1.h + buf : h1.l - buf) : null;
  const trapExtreme = s.kind === 'failed-break' ? (d < 0 ? s.ext + buf : s.ext - buf) : null;
  let structural, bounceExtreme = null;
  if (s.kind === 'failed-break') {
    bounceExtreme = s.bounce ? (d < 0 ? s.bounce.ext + buf : s.bounce.ext - buf) : null;
    structural = s.stopType === '4H' ? trapExtreme : hour1Wick;
  } else {
    const rx = d < 0 ? s.retest.ext + buf : s.retest.ext - buf;
    bounceExtreme = rx;
    structural = s.stopType === '4H' || !isNum(hour1Wick) ? rx : (d < 0 ? Math.max(hour1Wick, rx) : Math.min(hour1Wick, rx));   // hour-type: the 1H wick up to entry, including the retest
  }
  const entry = e.entryPrice;
  let stopLogical = true;
  if (!(d < 0 ? structural > entry : structural < entry)) {
    if (trapExtreme !== null && (d < 0 ? trapExtreme > entry : trapExtreme < entry)) { warn.push('hour-type stop was not beyond the entry: used the failed-breakout extreme'); structural = trapExtreme; }
    else stopLogical = false;
  }
  const risk = Math.abs(entry - structural);
  const retestNo = s.retestNo || 0;
  s.frozen = r3Facts(st, cfg, s, T);   // §23: frozen causally at the decision
  const ev = evidenceFor(st, cfg, s, T, retestNo, { stopLogical });
  const gr = gradeOf(ev, cfg.grade, cfg);
  if (!gr.grade) {
    const gateWhy = gr.missing.map(n => { const r = cfg.grade.required.find(q => q.name === n); return `${n}: ${r ? r.when.flatMap(condFields).map(c => `${c.field} ${c.op} ${JSON.stringify(c.value)} got ${JSON.stringify(getField(ev, c.field) ?? null)}`).join(', ') : ''}`; });
    E('GRADE_NO_TRADE', { setup: s.id, total: gr.total, points: gr.points, missing: gr.missing, gates: gr.gates, waived: gr.waived, why: gateWhy, htf: s.htf, htfDir });
    if (cfg.releaseOnRefusal !== false && !s.entered) {   // [r3.6] the refused setup frees its ONE_IDEA slot; the acceptance it blocked arms now
      s.refused = T; cancelSetup(st, ctx, s, `REFUSED: ${gr.missing[0]} - slot released`);
      const pend = st.pendingAcc && st.pendingAcc[d]; if (pend) { delete st.pendingAcc[d]; if (pend.pt === P.t && T - pend.T <= cfg.setupMaxBars * 300) armAccepted(st, ctx, pend.a); }
    }
    const why = gr.missing.map(n => n === 'notMidRange' ? `MID_RANGE: ${s.zone.name} ${s.level} in the middle of the 1H range ${ms.lo}-${ms.hi}` : n === 'logicalStop' ? 'NO_STOP: no logical stop beyond the entry (§8.7)' : `GATE ${n}`);
    return skip(why.join('; '));
  }
  const grade = gr.grade;
  // targets: the ordered pools in the trade direction (spec D''; the money rule picks TP1 / TP2)
  const targets = buildTargets(st, cfg, d, entry, risk, s);
  const room = targets.find(t => t.major && t.distanceR < cfg.roomMinR);
  if (room) { warn.push(`ROOM: major pool ${room.name} ${room.price} at ${room.distanceR}R in the way (§8.3)`); if (cfg.roomBlock) return skip('ROOM'); }
  const sig = {
    id: `${s.id}-E`, setupId: s.id, leg: 'entry', t: T, at: ptLabel(T), dir: d, side: d > 0 ? 'LONG' : 'SHORT', kind: s.kind,
    level: { name: s.zone.name, price: s.level, members: s.zone.members }, zone: { lo: s.zone.lo, hi: s.zone.hi, key: s.zone.key, weight: s.zone.weight, touches: s.zone.touches, type: ev.poolType, src: s.zone.src || null },
    entryType: e.entryType, entryPrice: entry, addZone: addZoneOf(st, cfg, s),
    stops: { structural, stopType: s.stopType, trapExtreme, hour1Wick, bounceExtreme,
      rule: s.kind === 'failed-break' ? (s.stopType === '4H' ? 'failed-breakout extreme + buf (§5 C, 4H-type / trap)' : 'current 1H wick + buf (§5 C, hour-type)') : (s.stopType === '4H' ? 'retest extreme + buf (C.1)' : '1H wick incl. the retest + buf (§5 C)') },
    chosenStop: structural, riskPts: r2(risk),
    grade, gradePoints: gr.points, gradeTotal: gr.total, gradeGates: gr.gates, gradeWaived: gr.waived, gradeDetail: gr.detail, gradeUncapped: gr.uncapped, gradeCapped: gr.capped, tags: gr.tags, gradeEvidence: ev, evidence: ev,
    targets, pools: targets, internalPools: targets.filter(t => !t.major), contextPools: contextPools(st, cfg, d, entry, risk), swings: swingsSnap(st, cfg), marketState: Object.assign({}, st.mstate),
    control: C ? { dir: C.dir, kind: C.kind, ext: C.ext, formedAt: ptLabel(C.formedT) } : null,
    defended: s.defended || null, shift: s.shift ? { tf: s.shift.tf, at: s.shift.at, body: s.shift.body, xAvg: s.shift.xAvg, displacement: s.shift.disp } : null,
    retest: s.kind === 'failed-break' ? (s.bounce ? { n: retestNo, extreme: s.bounce.ext, startAt: ptLabel(s.bounce.startT) } : null) : { n: retestNo, extreme: s.retest.ext, at: ptLabel(s.retest.t) },
    warnings: warn, reason,
    htf: s.htf, htfDir, riskMult: cfg.htfAgainst === 'half' && s.htf === 'against' ? 0.5 : 1, htfView: st.htf ? { prev4h: st.htf.prev4h ? { dir: st.htf.prev4h.dir, hh: st.htf.prev4h.hh, ll: st.htf.prev4h.ll } : null, daily: st.htf.daily.side, cur4h: st.htf.cur4h ? st.htf.cur4h.side : 0 } : null,   // [r3.7]
  };
  reason.unshift(s.kind === 'failed-break'
    ? `${s.zones.join('+')} failed ${d < 0 ? 'above' : 'below'} (extreme ${s.ext}); shift through ${s.swing} on ${s.shift.tf} ${s.shift.at}${s.disp ? ' with displacement' : ''}; retest ${retestNo} bounce ${s.bounce ? s.bounce.ext : '?'}; 1m rejection close ${entry}`
    : `${s.zone.name} ${s.level} accepted ${d > 0 ? 'above' : 'below'}; retest ${retestNo} wick ${s.retest.ext}; 1m rejection close ${entry}`);
  s.entered = T; s.firstStop = structural; s.firstSignal = sig.id; s.entryGrade = grade; s.entryPoints = gr.total; s.entryRetestNo = retestNo;
  st.used[s.ukey] = T;
  E('SIGNAL', { id: sig.id, dir: d, kind: s.kind, entryType: sig.entryType, entry, stop: structural, risk: sig.riskPts, grade, points: gr.total, htf: s.htf, htfDir, riskMult: sig.riskMult });
  ctx.sigs.push(sig);
  return sig;
}
function buildTargets(st, cfg, d, entry, risk, s) {
  const out = [];
  const add = (price, name, kind, major, weight, touches) => { if (isNum(price) && (d < 0 ? price < entry - cfg.tick : price > entry + cfg.tick)) out.push({ price, name, kind, major: !!major, weight: weight || null, touches: touches || null }); };
  const MAJOR = new Set(['4H Open', 'PDH', 'PDL', 'Asia High', 'Asia Low', 'London High', 'London Low', 'EQH', 'EQL']);   // D'' / §14: major pools (PDH/PDL, 4H open, session extremes, equal highs/lows)
  for (const z of st.zones) for (const m of z.members) if (m.src !== 'round' || cfg.pools.roundAsTarget) add(m.price, m.name, m.src, m.major || MAJOR.has(m.name), m.weight, m.touches);   // r3.2: Rounds are context, not targets
  const L = st.levels;   // the board's session extremes are pools even while their own session's zone is withheld (§23 "session highs/lows ARE pools")
  for (const [k, nm] of [['PDH', 'PDH'], ['PDL', 'PDL'], ['AsiaH', 'Asia High'], ['AsiaL', 'Asia Low'], ['LonH', 'London High'], ['LonL', 'London Low']]) add(L[k], nm, 'board', true, k.startsWith('PD') ? 'strong' : 'obvious');
  for (const [k, o] of Object.entries(st.orb)) if (o.done && st.lastT - o.t0 <= 86400) { add(o.h, `${k} ORH`, 'or', false, 'obvious'); add(o.l, `${k} ORL`, 'or', false, 'obvious'); }
  for (const p of (d < 0 ? st.piv.h1.lo : st.piv.h1.hi).slice(-8)) add(p.price, d < 0 ? '1H swing low' : '1H swing high', 'swing1h', false, 'obvious');
  for (const p of (d < 0 ? st.piv.h4.lo : st.piv.h4.hi).slice(-6)) add(p.price, d < 0 ? '4H swing low' : '4H swing high', 'swing4h', true, 'strong');
  if (st.mstate.state === 'RANGE') add(d < 0 ? st.mstate.lo : st.mstate.hi, d < 0 ? 'Range low (1H)' : 'Range high (1H)', 'range', true, 'strong');
  if (s.kind === 'failed-break' && st.period) add(d < 0 ? st.period.lo : st.period.hi, d < 0 ? '4H period low' : '4H period high', 'period', false, 'obvious');
  out.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const ded = [];
  for (const t of out) {
    const q = ded.find(x => Math.abs(x.price - t.price) <= 0.5);
    if (q) { q.name += ` + ${t.name}`; q.major = q.major || t.major; if ((WEIGHT_RANK[t.weight] || 0) > (WEIGHT_RANK[q.weight] || 0)) q.weight = t.weight; continue; }
    ded.push(t);
  }
  let minors = 0;   // every major pool is kept (TP2 / the A+ next major pool, D''); minor pools up to cfg.maxTargets
  return ded.filter(t => t.major || ++minors <= cfg.maxTargets).map(t => Object.assign(t, { distancePts: r2(Math.abs(t.price - entry)), distanceR: risk > 0 ? r2(Math.abs(t.price - entry) / risk) : null }));
}
// r3.2: the Round numbers in the trade direction, for display / context only (never TP1 / TP2, never setups)
function contextPools(st, cfg, d, entry, risk) {
  const out = [];
  for (const z of st.zones) for (const m of z.members) if (m.src === 'round' && (d < 0 ? m.price < entry - cfg.tick : m.price > entry + cfg.tick))
    out.push({ price: m.price, name: m.name, kind: 'round', context: true, distancePts: r2(Math.abs(m.price - entry)), distanceR: risk > 0 ? r2(Math.abs(m.price - entry) / risk) : null });
  return out.sort((a, b) => a.distancePts - b.distancePts).slice(0, 4);
}
function swingsSnap(st, cfg) {
  const k = cfg.swingsKept, f = a => a.slice(-k).map(p => ({ t: p.t, at: ptLabel(p.t), price: p.price }));
  const m15 = st.piv.m15 || { hi: [], lo: [] };
  return { m1: { highs: f(st.piv.m1.hi), lows: f(st.piv.m1.lo) }, m5: { highs: f(st.piv.m5.hi), lows: f(st.piv.m5.lo) },
    m15: { highs: f(m15.hi), lows: f(m15.lo) }, h1: { highs: f(st.piv.h1.hi), lows: f(st.piv.h1.lo) } };
}

// ---------------------------------------------------------------- step
function step(state, input, cfgIn) {
  const cfg = resolveCfg(cfgIn), st = state || createState(), events = [], sigs = [];
  const b = normBar(input && (input.m1 || input.bar));
  if (!b) throw new Error('structure.step: input.m1 {t,o,h,l,c,v} required');
  if (st.lastT !== null && b.t <= st.lastT) return { state: st, events: [{ t: b.t + 60, type: 'STALE_BAR', barT: b.t }], signal: null, swings: swingsSnap(st, cfg) };
  st.lastT = b.t;
  const T = b.t + 60, E = (type, o) => events.push(Object.assign({ t: T, at: ptLabel(T), type }, o || {})), ctx = { cfg, T, b, E, sigs };
  if (input.levels && typeof input.levels === 'object') { const L = {}; for (const k of ['O4', 'O1', 'PDH', 'PDL', 'AsiaH', 'AsiaL', 'LonH', 'LonL']) L[k] = isNum(input.levels[k]) ? input.levels[k] : null; st.levels = L; }
  const bz = normBias(input.bias, T, cfg.biasMaxAgeSec, cfg.biasInput);
  if (bz) pushCap(st.bias, bz, CAP.bias);
  if (Array.isArray(input.speed)) for (const x of input.speed) { const y = normBar(x); if (y && y.t + 15 <= T) pushCap(st.speed, y, CAP.speed); }
  pushCap(st.m1, b, CAP.m1);
  const closed = aggregate(st, b, cfg);
  const newPeriod = periodRoll(st, ctx);
  htfStep(st, ctx); if (newPeriod && st.htf) E('HTF', { dir: st.htf.dir, prev4h: st.htf.prev4h ? { dir: st.htf.prev4h.dir, hh: st.htf.prev4h.hh, ll: st.htf.prev4h.ll, c: st.htf.prev4h.c } : null, daily: st.htf.daily, votes: st.htf.votes });   // [r3.7]
  orbStep(st, ctx);
  if (newPeriod || !st.zones.length) buildZones(st, cfg, T);
  if (input.stoppedOut && (input.stoppedOut.dir === 1 || input.stoppedOut.dir === -1)) {
    const d = input.stoppedOut.dir; st.needShift[d] = T;
    for (const s of st.setups) if (s.status === 'armed' && s.dir === d) cancelSetup(st, ctx, s, 'STOPPED_OUT: a new trigger needs a new internal shift (C.4)');
    E('STOPPED_OUT', { dir: d });
  }
  if (Array.isArray(input.trades)) for (const tr of input.trades) {   // executor feedback per setup: { setupId, tp1Done, closed }
    const s = st.setups.find(x => x.id === tr.setupId || (tr.signalId && x.firstSignal === tr.signalId)); if (!s) continue;
    if (tr.tp1Done) s.tp1Done = true; if (tr.closed) { s.closed = T; if (s.status === 'armed') s.status = 'done'; }
  }
  pivotCheck(st.m1, cfg.pivot1m.left, cfg.pivot1m.right, T, st.piv.m1, 60);
  let fails = [], accepts = [];
  if (closed.m5) ({ fails, accepts } = on5m(st, ctx, closed.m5));
  if (closed.h1) on1h(st, ctx);
  if (closed.h4) pivotCheck(st.bars.h4, cfg.pivot4h.left, cfg.pivot4h.right, T, st.piv.h4, 14400);
  controlStep(st, ctx, fails);
  if (closed.m5) shiftCheck(st, ctx, 'm5', closed.m5);
  if (closed.m15) { if (!st.piv.m15) st.piv.m15 = { hi: [], lo: [] }; pivotCheck(st.bars.m15, cfg.pivot15.left, cfg.pivot15.right, T, st.piv.m15, 900); shiftCheck(st, ctx, 'm15', closed.m15); }
  resolvePending(st, ctx);
  expireFailures(st, ctx);
  for (const a of accepts) armAccepted(st, ctx, a);
  setups1m(st, ctx);
  const live = liveGrades(st, ctx);
  if (isNum(st.needShift[1]) && st.setups.some(s => s.dir === 1 && s.kind === 'failed-break' && s.armT > st.needShift[1])) delete st.needShift[1];
  if (isNum(st.needShift[-1]) && st.setups.some(s => s.dir === -1 && s.kind === 'failed-break' && s.armT > st.needShift[-1])) delete st.needShift[-1];
  let signal = null;
  if (sigs.length) {
    sigs.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'failed-break' ? -1 : 1) || (y.gradeTotal - x.gradeTotal));
    signal = sigs[0];
    for (const o of sigs.slice(1)) E('SIGNAL_EXTRA', { id: o.id, note: 'more than one signal this minute: the first is returned, the rest are listed here', signal: o });
  }
  return { state: st, events, signal, swings: swingsSnap(st, cfg), live };
}

module.exports = { VERSION, DEFAULTS, HTF_MODES, htfStep, htfTag, createState, step, cloneState, validateCfg, resolveCfg, gradeOf, ptLabel, ptMin, bucketStart, gradeTableProblems, evidenceFor, _internal: { waveEvidence, entryBiasEvidence, findFvg, buildZones, sessionOf, normBias, midRangeOf, pullbackEvidence, forceEvidence, sweptLevels, r3Facts, retestKeyOf, noteRetest, rejectionEntry, contextPools } };
