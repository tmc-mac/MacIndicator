// Levels PRO trigger from several chart timeframes (owner forward-test 2026-10-11, not backtested).
//
// levelsTriggerDir()/levelsTriggerInfo() replicate, EXACTLY, the `lvDirRaw` expression inside lib/signal.js decideSignal():
//   !lvGateOk ? 0 : (persisted ? planLong : sigLong) ? 1 : (persisted ? planShort : sigShort) ? -1
//             : biasStr === 'STRONG BUYER CONTROL' ? 1 : biasStr === 'STRONG SELLER CONTROL' ? -1 : 0
// Ordinary BUYERS/SELLERS IN CONTROL is also eligible when levelsTriggerRequired=false.
// with lvGateOk = !requireLevelsAlignment || lv.alignedFull. decideSignal() itself is NOT changed; it simply receives the lv
// object pickLevelsTrigger() hands back. Parity is asserted in smoke-test-owner-forward.js (against decideSignal itself).
//
// pickLevelsTrigger(lvByTf, cfg): lvByTf = { M15: lv, M5: lv|null, M3: lv|null } (each the LAST output row of evaluateLevelsPro on
// that chart). cfg.levelsTriggerTimeframes is the priority order (default ['M15'] = old behavior). The FIRST timeframe in that
// order whose levelsTriggerDir is non-zero wins; if none fires the 15m lv is returned. The result is always a SHALLOW COPY with
// two added fields (cached evaluator outputs are never mutated):
//   triggerTf  : '15m' | '5m' | '3m' | ... | null (null = no timeframe fired)
//   tfTriggers : { M15: { dir, via: 'plan'|'bias'|null, gateOk }, M5: {...}, M3: {...} }  (skipped/missing TF => { dir:0, via:null, skipped:true })
// Note the pick is independent of MAC's direction: a 15m trigger that conflicts with MAC wins priority over a 5m trigger that agrees.

const TF_LABEL = { M15: '15m', M10: '10m', M5: '5m', M3: '3m', M30: '30m' };

function levelsTriggerInfo(lv, cfg = {}) {
  if (!lv) return { dir: 0, via: null, gateOk: false };
  const requireLevelsAlignment = cfg.requireLevelsAlignment === undefined ? true : cfg.requireLevelsAlignment; // decideSignal default
  const levelsUsePersistedPlan = cfg.levelsUsePersistedPlan === undefined ? false : cfg.levelsUsePersistedPlan;   // decideSignal default
  const levelsTriggerRequired = cfg.levelsTriggerRequired === undefined ? true : cfg.levelsTriggerRequired;
  const gateOk = lv.alignmentStatus !== 'UNKNOWN' && (!requireLevelsAlignment || lv.alignedFull);
  const dir = !gateOk ? 0
    : (levelsUsePersistedPlan ? lv.planLong : lv.sigLong) ? 1
    : (levelsUsePersistedPlan ? lv.planShort : lv.sigShort) ? -1
    : lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1
    : (!levelsTriggerRequired && lv.biasStr === 'BUYERS IN CONTROL') ? 1
    : (!levelsTriggerRequired && lv.biasStr === 'SELLERS IN CONTROL') ? -1 : 0;
  let via = null;
  if (dir !== 0) via = ((levelsUsePersistedPlan ? lv.planLong : lv.sigLong) || (levelsUsePersistedPlan ? lv.planShort : lv.sigShort)) ? 'plan' : 'bias';
  const reason = !gateOk ? 'alignment-unavailable-or-not-full' : !dir ? 'no-plan-signal-or-eligible-bias' : via === 'plan' ? 'plan-signal' : lv.biasStr.startsWith('STRONG ') ? 'strong-control-bias' : 'ordinary-control-bias-trigger-requirement-off';
  return { dir, via, gateOk: !!gateOk, reason };
}

function levelsTriggerDir(lv, cfg = {}) { return levelsTriggerInfo(lv, cfg).dir; }

function pickLevelsTrigger(lvByTf, cfg = {}) {
  const order = (cfg.levelsTriggerTimeframes && cfg.levelsTriggerTimeframes.length) ? cfg.levelsTriggerTimeframes : ['M15'];
  const base = lvByTf.M15;
  const tfTriggers = {};
  let chosenKey = null;
  const keys = Array.from(new Set(['M15', ...order]));
  for (const k of keys) {
    const lv = lvByTf[k];
    if (!lv) { tfTriggers[k] = { dir: 0, via: null, gateOk: false, skipped: true }; continue; }
    tfTriggers[k] = levelsTriggerInfo(lv, cfg);
  }
  for (const k of order) {
    if (tfTriggers[k] && !tfTriggers[k].skipped && tfTriggers[k].dir !== 0) { chosenKey = k; break; }
  }
  const chosen = chosenKey ? lvByTf[chosenKey] : base;
  return Object.assign({}, chosen, { triggerTf: chosenKey ? (TF_LABEL[chosenKey] || chosenKey) : null, tfTriggers });
}

module.exports = { levelsTriggerDir, levelsTriggerInfo, pickLevelsTrigger, TF_LABEL };
