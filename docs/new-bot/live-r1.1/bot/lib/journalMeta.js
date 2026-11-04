'use strict';
// Journal metadata r1 (Mac-approved spec, MacMillionz 6327675865; MacDot acceptance 6327743954, HOLD findings 6328175259, 6328545796, 6328973444 and 6329183975). JOURNAL ONLY: nothing
// here is read by a trading decision. Every builder is pure; the executor persists rows and calls commit() ONLY after a successful write.
//   session_stamp  - code bytes + EFFECTIVE trading settings (explicit allowlist), once per run after settings are final
//   level_board    - the 15m Levels PRO board, written when any level's raw value / source changes; references carry { runId, boardSeq }
//   evaluation snapshot - the exact evaluation a signal_check consumed (tf, row time, raw VWAP, vwapSource, bar volume/forming), else identity unknown
//   blockId        - a stable id on every trade_block
//   plan_terminal  - versioned plan outcomes: one EFFECTIVE outcome per plan, later better evidence appends a correction
const crypto = require('crypto');

const SCHEMA = 'journal-meta-r1.5';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const SECRET_KEY = /key|token|secret|pass|user|account|webhook|topic|chat|url|auth|cred/i;   // defence in depth inside allowlisted values

// Explicit allowlist of TRADING settings (r9.15.1 CONFIG). Excluded on purpose: newsCalendarUrl, statusPushIntervalMs, notifyInfoBudget,
// notifyInfoReserveFrac, tokenRefreshHours, levelCrossPush, levelCrossKeyCooldownMs, accountStartingBalance, accountMllLimit (I/O, notifications, account).
// A key that is in CONFIG but in neither list is reported by NAME only (unlistedKeys), never by value.
const TRADING_SETTINGS = Object.freeze(['minMacScore', 'requireLevelsAlignment', 'sessionAnchor', 'vwapBuildTf', 'levelsUsePersistedPlan', 'macStrongRequired',
  'levelsTriggerRequired', 'controlDirectionGate', 'controlGateMin', 'controlContestedMinSize', 'macRequire4hAnchor', 'tfMode', 'align30', 'alignmentFreshnessPolicy',
  'tfModeApplyToMac', 'levelsTriggerTimeframes', 'leg1StopCapMultiple', 'nyStopMultiple', 'smartStopHold', 'sweepGraceMultiple', 'target1DollarGoal', 'target2Multiple',
  'offPeakTarget1DollarGoal', 'offPeakTarget2Multiple', 'blockMacGradeB', 'blockGradeCAsia', 'blockMacCompression', 'asiaStructuralTarget2', 'asiaTarget2MinPoints',
  'asiaTarget2MaxPoints', 'asiaTarget2FallbackPoints', 'trailStepPoints', 'stopCapDollarsPerContract', 'dailyStopLoss', 'trailArmThreshold', 'trailGiveback',
  'blockNyOpenMinutes', 'morningHold', 'asiaBlockUntilMinutes', 'sessionClose', 'sessionNoEntryFromPt', 'sessionFlattenPt', 'sessionFlattenAlertSec', 'sessionEarlyCloses',
  'flagsRequire4hAnchor', 'pendingExpireMs', 'pendingCancelOnStopTouch', 'fillSlipGuard', 'noChase', 'noChaseExemptMacGrades', 'noChaseExemptMomentum', 'waveMomentumPath',
  'newsAware', 'newsWaitAfter', 'pollIntervalMs', 'historyRefreshLimit', 'evaluationMode', 'evaluationIntrabarPollMs', 'intrabarRequireVolSpike',
  'intrabarRestrictToLevelsSource', 'intrabarAllowMacGrades', 'macIntrabarOnlyGrades', 'macSeenOnOrder', 'macIntrabarAllGrades', 'farLimitSwitch', 'farLimitIncludeStops',
  'levelCrossCooldownMs', 'baseContracts', 'riskBudgetedSizing', 'maxRiskPerTradeUsd', 'firstScalePts', 'profitLockUnit', 'profitLockPts', 'controlFilter', 'trendFilter',
  'pullbackRule', 'waveMode', 'sameLevelBan', 'reclaimReentry', 'rsiVetoes', 'exhaustionReversal', 'asiaBlackout', 'entryGuard', 'reentryCooldown',
  'reentryCooldownCandleMin', 'reentryWinMinMinutes', 'reentryCooldownAfterWin', 'reentryFreshStop', 'stopLadderAudit', 'openPositionPollMs', 'profitTrail', 'sessionExits',
  'trendMaxBarsToTP1', 'exhaustionGate', 'chopSkipEnabled', 'gradeLeg1Extra', 'gradeLeg2Extra', 'baseLeg1Extra', 'profitLockDollars', 'profitLockPct',
  'marketableLimitBufferPoints', 'macOnlyPullbackMaxAtr', 'brokerCosts', 'entryAttemptHoldMs', 'controlAcceptTf', 'controlLineBySession', 'pullbackBasis',
  // r1.3 (MacDot 6328545796 #2): every remaining decision setting in the shipped CONFIG, reconciled against the executor's CONFIG.<key> reads (test 10)
  'chopSkipExemptLowVolume', 'controlBufferPts', 'dollarRiskPerTrade', 'entryGuardBlockOnWorkingOrders', 'entryGuardReadRetries', 'entryGuardRetryMs', 'entryNearAtr1h',
  'entryNearPts', 'exhaustionMinRR', 'exhaustionRsiLevel', 'exhaustionRsiLookbackBars', 'exhaustionStopBufferPts', 'farLimitAtr', 'newsCancelRestingSec', 'newsWaitMinMs',
  'noChaseAtr', 'noChaseLevelNearExempt', 'noChaseMode', 'pullbackVoid', 'pullbackZone', 'reclaimStopBufferPts', 'reclaimWindowMin', 'reentryCooldownBars',
  'reentryCooldownScope', 'riskSizingMaxContracts', 'riskSizingMinContracts', 'riskSizingSlipPts', 'sameLevelBanTolPts', 'trendInside4h', 'trendUseDayType',
  'waveConfirmBars', 'waveLineBufferAtr', 'waveMinLowerHighs', 'waveMinSwingAtr', 'waveMomentumBreakBars', 'waveMomentumGrades', 'waveMomentumSessions', 'waveShelfAtr',
  'waveStopBufferPts', 'waveSwingStrength',
  // read by the executor but set only by config-local / runtime (absent from the shipped literal): projected when present
  'minBiasAgreementMacSource', 'minBiasAgreementLevelsSource', 'standdownWeek1', 'entryWindowLeadSec',
  'noRestingAcrossBlock', 'entryStopFloor',
  'planEndsAtTargetTrend',   // lv1 r13.3.7d (the plan-end trend allowance)
  'htfOpenEntryBlockMin',   // lv1 r13.3.7e (the 4H-open entry wait)
  'tide', 'money',   // TIDE r2 stage 1 (MacTide): the new model's mode / open wait and money-r4.1's sizing + exits (recorded by value, like every trading setting)
  'scaleOutRunner', 'stopOutSameDirBlockMin', 'sameDirBlockAfterWin', 'noProgressExit', 'minContracts', 'reversalExit', 'htfLevels', 'levelsParity', 'tp1FromFill', 'planEndsAtTarget', 'maxEntryPastLevelPts', 'stretchCheck', 'flatSizeContracts', 'po3Observe', 'srAreas', 'levelsOnlyEntries', 'levelEvents', 'levelEventControl', 'levelEventIntrabar', 'levelEventIntrabarBufPts', 'levelsAlignWithTrade', 'levelRetest', 'levelRetestChasePts', 'levelStopMaxFromFillPts']);   // so1 (Mac 10/22 live trial)   // combined build: time blocks r5 + stop floor r1
const EXCLUDED_SETTINGS = Object.freeze(['newsCalendarUrl', 'statusPushIntervalMs', 'notifyInfoBudget', 'notifyInfoReserveFrac', 'tokenRefreshHours', 'levelCrossPush',
  'levelCrossKeyCooldownMs', 'accountStartingBalance', 'accountMllLimit', 'authReloginMinGapSec', 'newsCalendarRefreshMs']);   // r1.3: broker re-login pacing, calendar fetch cadence (I/O)
const ALLOW = new Set(TRADING_SETTINGS), EXCLUDE = new Set(EXCLUDED_SETTINGS);

// canonical value: sorted keys, functions/undefined dropped, secret-looking nested keys dropped
function canon(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' || v === undefined ? undefined : v;
  if (depth > 6) return '[depth]';
  if (Array.isArray(v)) return v.map(x => canon(x, depth + 1));
  const o = {}; for (const k of Object.keys(v).sort()) { if (SECRET_KEY.test(k)) continue; const x = canon(v[k], depth + 1); if (x !== undefined) o[k] = x; }
  return o;
}
// the SAME safe projection feeds the journalled fields and every hash input. r1.4 (MacDot 6328973444 #2): the VALUE of a key in neither list is never
// read into any field or hash (a benign-looking name can still hold a credential); its NAME is listed (secret-looking names only counted) and the
// stamp says settingsCoverage 'incomplete' until it is classified.
function projectSettings(cfg) {
  const settings = {}, unlistedKeys = []; let unlistedSecretNamed = 0;
  for (const k of Object.keys(cfg || {}).sort()) {
    if (ALLOW.has(k)) { const x = canon(cfg[k]); if (x !== undefined) settings[k] = x; }
    else if (!EXCLUDE.has(k)) { if (SECRET_KEY.test(k)) unlistedSecretNamed++; else unlistedKeys.push(k); }
  }
  return { settings, unlistedKeys, unlistedSecretNamed, coverage: unlistedKeys.length || unlistedSecretNamed ? 'incomplete' : 'complete' };
}
function projectOverrides(overrides) {
  return (overrides || []).filter(o => o && typeof o.key === 'string' && ALLOW.has(o.key.split('.')[0]) && !SECRET_KEY.test(o.key)).map(o => ({ key: o.key, to: canon(o.to), ...('requested' in o ? { requested: canon(o.requested) } : {}), ...(typeof o.note === 'string' ? { note: o.note } : {}) }));   // so1 r1.2: requested/note kept
}

// files: { relPath: contentString }; effectiveConfig: CONFIG after defaults, config-local AND every later startup mutation
function buildSessionStamp({ files, effectiveConfig, overrides, node, startedAt, runId }) {
  const fileHashes = {}; for (const k of Object.keys(files || {}).sort()) fileHashes[k] = sha256(files[k]);
  const { settings, unlistedKeys, unlistedSecretNamed, coverage } = projectSettings(effectiveConfig);
  const safeOverrides = projectOverrides(overrides);
  const settingsHash = sha256(JSON.stringify({ settings, unlistedKeys, unlistedSecretNamed })), overridesHash = sha256(JSON.stringify(safeOverrides));
  const stampId = sha256(JSON.stringify({ fileHashes, settingsHash })).slice(0, 12);   // identical code + settings => same stampId; runId tells runs apart
  return { type: 'session_stamp', schema: SCHEMA, t: startedAt, stampId, runId: runId ?? null, files: fileHashes, settingsHash, overridesHash, settings, overrides: safeOverrides, unlistedKeys, unlistedSecretNamed, settingsCoverage: coverage, node: node ?? null, startedAt };
}

// The 15m level board. Change key = every level's raw value (1e-6) + source, so a within-tick raw move is a new board. VWAP is not a board level
// (it moves every poll and is on the evaluation snapshot). Per-level source-bar time is not produced by the evaluator: declared unknown.
function boardOf(lvRow, tick = 0.25) {
  if (!lvRow || !Array.isArray(lvRow.levels)) return null;
  const r = p => Math.round(p / tick) * tick;
  const levels = lvRow.levels.filter(L => L && typeof L.name === 'string' && L.name !== 'VWAP' && Number.isFinite(L.price))
    .map(L => ({ n: L.name, raw: Math.round(L.price * 1e6) / 1e6, p: r(L.price), src: L.src ?? L.group ?? L.source ?? null }));
  return { levels };
}
// observe() returns { row, commit } or null; the executor calls commit() only after the row was persisted, so no reference can point at an unwritten board.
function createBoardTracker({ tick = 0.25, runId = null } = {}) {
  let seq = 0, lastKey = null, current = null;
  return {
    observe(lvRow, meta = {}) {
      const b = boardOf(lvRow, tick); if (!b) return null;
      const key = JSON.stringify([b.levels.map(L => [L.n, L.raw, L.src]), meta.anchor ?? null, meta.vwapAnchor ?? null, meta.chartTf ?? null]);
      if (key === lastKey) return null;
      const next = seq + 1;
      const row = { type: 'level_board', schema: SCHEMA, runId, t: meta.t ?? Date.now(), boardSeq: next, chartTf: meta.chartTf ?? null, barTime: meta.barTime ?? null,
        anchor: meta.anchor ?? null, vwapAnchor: meta.vwapAnchor ?? null, perLevelSourceTime: 'unknown', levels: b.levels };
      return { row, commit() { seq = next; lastKey = key; current = { runId, boardSeq: next, chartTf: row.chartTf, barTime: row.barTime, levels: row.levels }; } };
    },
    ref: () => (seq > 0 ? { runId, boardSeq: seq } : null),   // immutable reference: boardSeq restarts per run, runId does not repeat
    // r1.3 (MacDot 6328545796 #1): the board result of ONE evaluation, bound to it by the executor. cand = observe()'s result, persisted = its write succeeded.
    //   current      - this evaluation's board IS boardSeq (unchanged, or just written)
    //   write-failed - this evaluation's board differs from boardSeq and was NOT persisted: boardSeq is the last persisted board, not this evaluation's
    //   none         - no board persisted yet in this run
    bind(cand, persisted) {
      if (cand && persisted) cand.commit();
      const r = seq > 0 ? { runId, boardSeq: seq } : { runId, boardSeq: null };
      return cand && !persisted ? { ...r, status: 'write-failed', lastPersisted: r.boardSeq } : { ...r, status: seq > 0 ? 'current' : 'none' };
    },
    current: () => current,
  };
}

// The snapshot of the exact Levels evaluation a decision consumed. tfKey/bars are that evaluation's own timeframe and bars.
function evaluationSnapshot(lvRow, { tfKey, bars, tfMs, instrument, feed, evaluatedAt }) {
  if (!lvRow) return { identity: 'unknown' };
  const v = Array.isArray(lvRow.levels) ? lvRow.levels.find(L => L && L.name === 'VWAP' && Number.isFinite(L.price)) : null;
  let bar = null; if (Array.isArray(bars)) for (let i = bars.length - 1; i >= 0 && i >= bars.length - 5; i--) if (bars[i].t === lvRow.t) { bar = bars[i]; break; }
  return { identity: 'evaluation', tf: tfKey ?? null, rowT: lvRow.t ?? null, vwap: v ? v.price : null, vwapSource: lvRow.vwapSource ?? null, instrument: instrument ?? null, feed: feed ?? null,
    barVol: bar && Number.isFinite(bar.v) ? bar.v : null, barForming: bar && Number.isFinite(tfMs) && Number.isFinite(evaluatedAt) ? evaluatedAt < bar.t + tfMs : null, evaluatedAt: evaluatedAt ?? null };
}

function blockIdFor(code, dir, t) { return `blk-${code}-${dir ?? 0}-${Math.floor(t / 900000)}`; }

// Evidence -> kind. A fill outranks a cancel/expiry/reset (a later confirmed fill CORRECTS an earlier cancel).
// 'traded' / 'pending' / 'attempted' mean an order was sent or rests, never that it filled.
function evidenceOf(row) {
  if (!row || !row.journalId) return null;
  const qty = Number.isFinite(row.quantity) ? row.quantity : Number.isFinite(row.contracts) ? row.contracts : null;
  if (row.type === 'entry') return { kind: 'fill', qty, via: 'entry' };
  if (row.type === 'trade_manage' && row.code === 'ENTRY_FILLED') return { kind: 'fill', qty: null, via: 'trade_manage:ENTRY_FILLED' };
  if (row.type === 'journal_receipt' && row.status === 'FILL_OBSERVED') return { kind: 'fill', qty, via: 'receipt:FILL_OBSERVED' };
  if (row.type === 'trade_manage' && row.code === 'ENTRY_EXPIRED') return { kind: 'end', outcome: 'expired', via: 'trade_manage:ENTRY_EXPIRED', reason: row.text ?? null };
  if (row.type === 'signal_check' && row.outcome === 'canceled') return { kind: 'end', outcome: 'cancelled', via: 'signal_check:canceled', reason: row.reason ?? null };
  if (row.type === 'journal_receipt' && row.status === 'PLAN_CANCELED') return { kind: 'end', outcome: 'cancelled', via: 'receipt:PLAN_CANCELED', reason: row.reason ?? null };
  if (row.type === 'journal_receipt' && row.status === 'PLAN_RESET') return { kind: 'end', outcome: 'reset', via: 'receipt:PLAN_RESET', reason: row.reason ?? null };
  return null;
}

// Versioned plan outcomes. propose(row) returns { row, commit } (or null); commit() is called only after the terminal row was persisted, so a failed
// write never suppresses a later attempt. One EFFECTIVE outcome per plan = its highest version. A later fill corrects a cancel; a larger fill
// quantity corrects a smaller one; evidence that adds nothing is not re-emitted.
// r1.3 (MacDot 6328545796 #3/#4): a terminal whose write failed is retried (retry()) and, after a restart, recovered from the durable evidence rows
// (restore() replays them); a plan evicted from the retained cache is never restarted at version 1: its evidence yields one 'out of scope' row.
function createPlanTerminals({ max = 4000, maxEvicted = 200000 } = {}) {
  const plans = new Map();   // journalId -> { t, planned, outcome|null, fillQty|null, version }
  const evicted = new Map();   // journalId -> reported-out-of-scope (bool); its version identity is no longer retained
  let evictedOverflow = false;   // more evictions than maxEvicted: any unknown id may be an evicted one
  let evictedMaxT = -Infinity;   // r1.5: newest plan time ever evicted; after an overflow a plan row no newer than this may be a forgotten eviction
  const pending = new Map();   // journalId -> [{ row, extra } evidence, in order] from the first one whose row failed to persist (r1.4: later evidence for that plan waits behind it)
  const touch = (id, st) => { plans.delete(id); plans.set(id, st); evicted.delete(id);
    if (plans.size > max) { const old = plans.keys().next().value; const ot = plans.get(old).t; if (Number.isFinite(ot) && ot > evictedMaxT) evictedMaxT = ot; plans.delete(old); evicted.set(old, false); if (evicted.size > maxEvicted) { evicted.delete(evicted.keys().next().value); evictedOverflow = true; } } };
  // r1.5 (MacDot 6329183975): ONE guard for live and restore. An evicted id's plan row never revives its version identity (only a durable plan_terminal
  // does); after an overflow (eviction markers forgotten) a plan row that is not newer than the newest evicted plan is treated the same (conservative).
  const planRowBlocked = (id, row) => evicted.has(id) || (evictedOverflow && !(Number.isFinite(row.t) && row.t > evictedMaxT));
  const outOfScope = (id, row, ev) => ({ row: { type: 'journal_meta_incomplete', schema: SCHEMA, t: row.t ?? row.recordedAt ?? Date.now(), kind: 'plan_terminal_out_of_scope', journalId: id, via: ev.via,
    error: 'evidence for a plan outside the retained outcome cache: its version identity is unknown, so no plan_terminal version is issued (unresolved)' }, evidence: row, commit() { if (evicted.has(id)) evicted.set(id, true); } });
  const api = {
    propose(row) {
      if (!row || !row.journalId) return null;
      const id = row.journalId, prev = plans.get(id);
      if (!prev && row.type !== 'trade_plan') { const ev0 = evidenceOf(row);
        if (ev0 && (evicted.has(id) || evictedOverflow)) return evicted.get(id) === true ? null : outOfScope(id, row, ev0); }
      if (row.type === 'trade_plan' && !prev && planRowBlocked(id, row)) return null;   // r1.4/r1.5: a replayed plan row never resets an evicted plan to version 0
      if (row.type === 'trade_plan') {
        const planned = row.sizes && Number.isFinite(row.sizes.contracts) ? row.sizes.contracts : null;
        if (!prev) touch(id, { t: row.t ?? null, planned, outcome: null, fillQty: null, version: 0 });
        else if (prev.planned == null && planned != null) prev.planned = planned;
        return null;
      }
      const ev = evidenceOf(row); if (!ev) return null;
      const st = prev || { t: null, planned: null, outcome: null, fillQty: null, version: 0, unseen: true };
      let outcome = st.outcome, fillQty = st.fillQty;
      if (ev.kind === 'fill') { fillQty = ev.qty != null ? Math.max(fillQty ?? 0, ev.qty) : fillQty; outcome = fillQty != null && st.planned != null && fillQty < st.planned ? 'filled-partial' : 'filled'; }
      else if (st.outcome == null) outcome = ev.outcome;   // an end after a fill never downgrades it
      if (outcome === st.outcome && fillQty === st.fillQty) return null;   // nothing new
      const version = st.version + 1;
      const out = { type: 'plan_terminal', schema: SCHEMA, t: row.t ?? row.recordedAt ?? Date.now(), journalId: id, planId: id, version, correction: version > 1,
        outcome, previousOutcome: st.outcome, correctionReason: version === 1 ? null : outcome !== st.outcome ? 'outcome changed' : st.fillQty == null ? 'fill quantity now known' : 'fill quantity changed', fill: outcome && outcome.startsWith('filled') ? { qty: fillQty, planned: st.planned } : null, via: ev.via, reason: ev.reason ?? null,
        planT: st.t, origin: st.unseen ? 'plan-not-seen-in-this-run' : 'tracked' };
      return { row: out, evidence: row, commit() { touch(id, { t: st.t, planned: st.planned, outcome, fillQty, version }); } };
    },
    // r1.4 (MacDot 6328973444 #1): the ONLY write path. A row is proposed against the COMMITTED state at the moment it is written, so a proposal is
    // never computed before an earlier retry commits. If this plan already has deferred evidence, the new row waits behind it (order kept: a deferred
    // fill can never be overtaken by a later cancel). persist(row) -> bool; extra is merged into the written row (e.g. the restart recovery flag).
    feed(row, persist, extra = null) {
      const id = row && row.journalId; if (!id) return null;
      if (pending.has(id)) { if (row.type === 'trade_plan' || evidenceOf(row)) pending.get(id).push({ row, extra }); return { deferred: true }; }
      const p = api.propose(row); if (!p) return null;
      if (extra && p.row.type === 'plan_terminal') Object.assign(p.row, extra);
      if (persist(p.row)) { p.commit(); return p.row; }
      pending.set(id, [{ row, extra }]); return { deferred: true };
    },
    // re-propose each plan's deferred evidence IN ORDER against the committed state; stops at that plan's first failed write (the rest stays queued)
    retry(persist) {
      const written = [];
      for (const [id, list] of [...pending]) {
        pending.delete(id);
        for (let i = 0; i < list.length; i++) { const p = api.propose(list[i].row); if (!p) continue; if (list[i].extra && p.row.type === 'plan_terminal') Object.assign(p.row, list[i].extra);
          if (persist(p.row)) { p.commit(); written.push(p.row); } else { pending.set(id, list.slice(i)); break; } }
      }
      return written;
    },
    pendingCount: () => pending.size,
    // restart: rebuild from the journal on disk (trade_plan rows + the latest plan_terminal version per plan), then replay the durable EVIDENCE rows:
    // persist(row) -> bool writes each recovered terminal through feed() (a failed write queues that plan's remaining evidence for retry()); returns the written rows.
    // Only plans a metadata-aware build wrote (trade_plan with a stampId) or that already have a plan_terminal are recovered: older history is not backfilled.
    restore(rows, persist = null) {
      const evidence = [], eligible = new Set();
      for (const r of rows || []) {
        if (!r || !r.journalId) continue;
        if (evidenceOf(r)) { evidence.push(r); continue; }
        if ((r.type === 'trade_plan' && r.stampId) || r.type === 'plan_terminal') eligible.add(r.journalId);
        if (r.type === 'trade_plan') { const p = plans.get(r.journalId); if (!p && !planRowBlocked(r.journalId, r)) touch(r.journalId, { t: r.t ?? null, planned: r.sizes && Number.isFinite(r.sizes.contracts) ? r.sizes.contracts : null, outcome: null, fillQty: null, version: 0 }); }
        else if (r.type === 'plan_terminal') { const p = plans.get(r.journalId) || { t: r.planT ?? null, planned: r.fill ? r.fill.planned ?? null : null, outcome: null, fillQty: null, version: 0 };
          if ((r.version || 1) >= p.version) touch(r.journalId, { ...p, outcome: r.outcome, fillQty: r.fill ? r.fill.qty ?? null : null, version: r.version || 1 }); }
      }
      const recovered = []; api.lastRestoreOutOfScope = 0;
      for (const r of evidence) { if (!eligible.has(r.journalId)) continue; if (!plans.has(r.journalId) && (evicted.has(r.journalId) || evictedOverflow)) { api.lastRestoreOutOfScope++; continue; } const w = api.feed(r, persist || (() => true), { recovered: 'from-durable-evidence-at-restart' }); if (w && !w.deferred) recovered.push(w); }
      return recovered;
    },
    effective: id => { const p = plans.get(id); return p ? { outcome: p.outcome, fillQty: p.fillQty, version: p.version, planned: p.planned } : null; },
    openCount: () => { let n = 0; for (const p of plans.values()) if (p.outcome == null) n++; return n; },
  };
  return api;
}

// Metadata failures are journalled as incomplete evidence (bounded: one row per kind per minute), never thrown into trading code.
function createMetaErrors() {
  const last = new Map();
  return { row(kind, err, t = Date.now()) { const k = kind + '|' + Math.floor(t / 60000); if (last.has(k)) return null; last.set(k, 1); if (last.size > 200) last.delete(last.keys().next().value);
    return { type: 'journal_meta_incomplete', schema: SCHEMA, t, kind, error: String(err && err.message || err).slice(0, 200) }; } };
}

// Row types this package adds; they are written to the journal file only, never into the bounded economic history/index.
const META_TYPES = Object.freeze(['session_stamp', 'level_board', 'plan_terminal', 'journal_meta_incomplete']);

module.exports = { SCHEMA, TRADING_SETTINGS, EXCLUDED_SETTINGS, META_TYPES, canon, projectSettings, projectOverrides, buildSessionStamp, boardOf, createBoardTracker,
  evaluationSnapshot, blockIdFor, evidenceOf, createPlanTerminals, createMetaErrors };
