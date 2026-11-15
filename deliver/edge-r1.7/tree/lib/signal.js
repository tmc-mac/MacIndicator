const { classifyControl } = require('./entryControl');
const { ptInfo } = require('./helpers');
const { levelProof, alignDir, alignRequired } = require('./levelEvent');   // lv1 r3: the named-event proof every levels-only entry carries; r12.6: the HTF alignment's direction
// lv1 r3 (MacDot 6451687678: "MAC never read" must be literal): under levelsOnlyEntries decideSignal() swaps the caller's MAC object for this frozen
// neutral one BEFORE any field is read, so no MAC value can reach a levels-only decision.
const NO_MAC = Object.freeze({ activeDir: 0, activeScore: 0, biasStr: '', hardBlock: false, chopSkip: false, volCompression: false, volSpikeBull: false, volSpikeBear: false, entryGrade: null });

// Pure, stateless entry-decision function — extracted so live-executor.js can
// import the EXACT rule already validated in lib/simulate.js and
// lib/simulate3leg.js, instead of a hand-copied version that could quietly
// drift out of sync with what the backtest actually tested. Nothing in
// simulate.js/simulate3leg.js was changed to make this possible; their inline
// copies of this same logic are left exactly as validated, and this is just a
// second consumer of the same rule.
function decideSignal(mac, lv, { minMacScore = 7, requireLevelsAlignment = true, blockMacGradeB = false, blockGradeCAsia = false, blockMacCompression = false, minBiasAgreementMacSource = null, minBiasAgreementLevelsSource = null, requireVolSpike = false, blockMacSourceIntrabar = false, levelsUsePersistedPlan = false, intrabarAllowMacGrades = null, macStrongRequired = true, levelsTriggerRequired = true, macIntrabarAllGrades = false, controlDirectionGate = false, controlGateMin = 0.22, controlContestedMinSize = false, standdownWeek1 = false, onControlOpportunity = null, levelsOnlyEntries = false, levelEventControl = 'require', levelsAlignWithTrade = false, align30 = false } = {}, nowTs = Date.now()) {
  if (levelsOnlyEntries) mac = NO_MAC;   // lv1 r3: the MAC object is never read under levels-only
  // mac.hardBlock is MAC Trap's OWN gate (late buyer/seller exhaustion, the
  // 06:30 news window, or VIX) — it already zeroes out entryGrade when up,
  // but activeDir/activeScore are computed BEFORE that gate, so without this
  // check a "late buyers" bar could still fire a directional signal with a
  // worthless grade. This is what let the Sept 21 chase through.
  // 10-18b1 (Mac's ruling 10/16 09:06 PT, "MAC strong" REMOVED): macStrongRequired false = MAC's own direction counts at ANY score
  // (activeDir !== 0, so WATCH 3-4 / grade '-' too). The STRONG BULL/BEAR alternative, hardBlock and the compression zeroing below are
  // unchanged. true (and every caller that does not pass it) = the 10-18 rule, byte-identical.
  const macScoreOk = !macStrongRequired || mac.activeScore >= minMacScore;
  const macDirRaw = ((mac.activeDir === 1 && macScoreOk) || mac.biasStr === 'STRONG BULL') ? 1
    : ((mac.activeDir === -1 && macScoreOk) || mac.biasStr === 'STRONG BEAR') ? -1 : 0;
  // blockMacCompression (2026-10-08, bundle spec) — MAC Trap is a momentum
  // engine; it has no edge once volume compresses (volRatio < 0.7, already
  // computed as mac.volCompression). Levels-only entries are deliberately
  // unaffected — this only ever zeroes the mac-sourced direction.
  let macDir = (mac.hardBlock || (blockMacCompression && mac.volCompression)) ? 0 : macDirRaw;
  const lvGateOk = lv.alignmentStatus !== 'UNKNOWN' && (!requireLevelsAlignment || lv.alignedFull);
  // levelsUsePersistedPlan (2026-10-09, JayMac's live-dashboard observation —
  // Levels PRO reading BUYERS IN CONTROL/testing a level while the bot sat
  // idle) — sigLong/sigShort (the default) only fire on the RISING EDGE
  // (levelsPro.js: `planLong && !prevPlanLong`), i.e. the exact bar a
  // grade-B+ structural plan first qualifies. If that plan stays valid for
  // several more bars (price still working the same level), decideSignal()
  // never looks at it again — the opportunity is still on the board but the
  // one-bar trigger already came and went. planLong/planShort is the SAME
  // underlying quality gate (planValid && grade>=B) without the edge-only
  // restriction, so a persisting qualified setup can still fire on a later
  // bar. Off by default — every existing call site reproduces the exact
  // validated baseline unchanged; this is a backtest-first opt-in pending
  // real 5-year numbers, not yet a trusted improvement.
  const lvDirRaw = !lvGateOk ? 0
    : (levelsUsePersistedPlan ? lv.planLong : lv.sigLong) ? 1
    : (levelsUsePersistedPlan ? lv.planShort : lv.sigShort) ? -1
    : lv.biasStr === 'STRONG BUYER CONTROL' ? 1 : lv.biasStr === 'STRONG SELLER CONTROL' ? -1
    // 10-18b1 ("Levels trigger" REMOVED): levelsTriggerRequired false = when aligned (lvGateOk above, unchanged), the bias side counts
    // too: BUYERS IN CONTROL -> +1, SELLERS IN CONTROL -> -1 (lib/levelsPro.js labels, |biasScore| >= ctrlThresh). true = 10-18.
    : (!levelsTriggerRequired && lv.biasStr === 'BUYERS IN CONTROL') ? 1 : (!levelsTriggerRequired && lv.biasStr === 'SELLERS IN CONTROL') ? -1 : 0;
  // levels-sourced entries used to ignore mac.hardBlock entirely, so a "late
  // buyers"/"late sellers" bar (or the VIX/news-window gate) could still fire
  // a levels trade even though the identical mac-sourced signal would have
  // been zeroed above. Across both instruments' logs, every levels fill that
  // went through during hardBlock came out 1 win / 2 losses, and the win only
  // held because of a manual flatten — so levels entries now respect the same
  // gate mac-sourced ones already do.
  // chopSkip (2026-09-24, FIX 9): 15m ADX<15 means chop — skip ALL entries,
  // not just mac-sourced ones (unlike the RSI vetoes, which only ever block
  // one direction and only mac's own scoring path). Folded in alongside
  // hardBlock rather than as a separate flag since both mean the exact same
  // thing here: zero out lvDir entirely.
  // lv1 (Mac 10/27 "remove all MAC couplings ... only levels based; bias agreement comes from levels alignment"): levelsOnlyEntries true = the MAC object
  // is not an input at all - MAC never opens, relabels, replaces or vetoes a trade (no hard block / chop / VIX / data window / volume / grade / score);
  // the Levels trigger stands on Levels PRO alone (alignment above). false (every caller that does not pass it) = byte-identical selection.
  let lvDir = (mac.hardBlock || mac.chopSkip) ? 0 : lvDirRaw;   // under levelsOnlyEntries mac is NO_MAC (top of the function): never zeroed by MAC
  // lv1 r12.6 (Mac 10/28, agreed): levelsAlignWithTrade = under levels-only the HTF alignment (15m / 1H / 4H vs their opens, lib/levelEvent.js alignDir) must
  // point the trade's way. alignedFull alone (lvGateOk above: all three agreeing with EACH OTHER) let a SHORT through on 15m+ 1H+ 4H+. false = unchanged.
  if (levelsOnlyEntries && requireLevelsAlignment && levelsAlignWithTrade && lvDir !== 0 && lvDir !== alignDir(lv, alignRequired({ align30 }))) lvDir = 0;   // r12.6.1: the configured slot set (levelsAlignOpts)
  // lv1: levelEventControl 'exempt' = a Levels trigger that IS a level event (lib/levelEvent.js, lv.levelEvent) in this direction skips the control gate; 'require' = gated.
  const lvEventExempt = d => levelEventControl === 'exempt' && d !== 0 && !!lv.levelEvent && lv.levelEvent.dir === d;

  // Genuine CONFLICT (opposite directions) is always skipped. Full AGREEMENT
  // (same direction) used to be skipped too, on an old 2-leg-system finding
  // that "both max out at once" meant late-stage exhaustion rather than
  // confirmation — re-tested on real history and found the opposite:
  // allowing agreement outperformed skipping it (avg/day $925.88 vs $717.10,
  // same worst day), so agreement now trades. The real exhaustion gate is
  // mac.hardBlock above (H1 streak / RSI extremes, macTrap.js section 18),
  // which already zeroed macDir/lvDir before this point whenever the move is
  // genuinely overextended — that protection is unchanged and still applies
  // to an agreement entry exactly like any other.
  // 10-18b1 CONTROL GATE, part 1 (PDL-fade exam 10/16: a STRONG BEAR MAC short against a LONG Levels plan in seller control returned null on
  // CONFLICT before the gate below could decide). Mac's doctrine: direction = the side in control. With the gate on and a side in control, a
  // source pointing AGAINST that side is dropped BEFORE the conflict check, so the controlling side's source trades. Contested = nothing is
  // dropped here (the check below then refuses every direction). Gate off = byte-identical to 10-18.
  // Observe each source before control/conflict can erase a candidate. These are
  // opportunities, not claims that all downstream risk/setup guards passed.
  if (standdownWeek1 && typeof onControlOpportunity === 'function') {
    for (const [source, dir] of [['mac', macDir], ['levels', lvDir]]) if (dir) onControlOpportunity({ source, dir, setup: source === 'levels' ? (lv.plan?.entryType || 'levels-signal') : 'mac-signal' });
  }
  const ctlSide = standdownWeek1 ? classifyControl(lv, 1).side : controlDirectionGate ? controlSide(lv, controlGateMin) : 0;
  if (ctlSide !== 0) { if (macDir !== 0 && macDir !== ctlSide) macDir = 0; if (lvDir !== 0 && lvDir !== ctlSide && !lvEventExempt(lvDir)) lvDir = 0; }
  if (macDir !== 0 && lvDir !== 0 && macDir !== lvDir) return null;
  let result = null;
  if (macDir !== 0 && lvDir !== 0) {
    // Both agree — prefer Levels PRO's own structural grade/target when it
    // actually has a plan in this direction (gives takeEntry() a real level
    // to work with), otherwise fall back to mac's grade.
    const source = (lv.plan && lv.plan.dir === macDir) ? 'levels' : 'mac';
    const grade = (lv.plan && lv.plan.dir === macDir) ? lv.plan.grade : mac.entryGrade;
    result = { dir: macDir, source, grade };
  } else if (lvDir !== 0) {
    result = { dir: lvDir, source: 'levels', grade: (lv.plan && lv.plan.dir === lvDir) ? lv.plan.grade : null };
  } else if (macDir !== 0) {
    result = { dir: macDir, source: 'mac', grade: mac.entryGrade };
  }
  if (!result) return null;
  // lv1 "NO LEVEL, NO TRADE" (r3, MacDot 6451609719 #2): under levelsOnlyEntries the trigger needs a NAMED LEVEL EVENT in its direction - a level event of
  // lib/levelEvent.js, or Levels PRO's own plan whose in-play level shows a sweep / fail / reclaim / accept / hold for that side (levelProof). A STRONG-control
  // bias or a plan at a TESTING / CHOP level is no trade. The frozen proof travels with the result to takeEntry(), which refuses any entry without it.
  if (levelsOnlyEntries) { const pf = levelProof(lv, result.dir); if (!pf) return null; result.level = pf.name; result.levelProof = pf; }
  // blockMacSourceIntrabar (2026-10-08, intrabar economics backtest) —
  // intended for the INTRABAR caller only, exactly like requireVolSpike
  // below (bar-close callers leave it false/omitted and are unaffected).
  // A full walk-forward economics simulation of 627 intrabar candidates
  // (real leg1/leg2/leg3 management on 1-minute bars, not just signal
  // survival) found mac-sourced intrabar entries are economically dead
  // weight — PF 1.03, $1,095 total over 221 trades — even though they
  // survive to the real bar close MORE often than levels-sourced ones
  // (74.7% vs 49.5%). Levels-sourced intrabar entries carry essentially
  // the entire baseline's profit on their own (PF 1.29, $17,195 — 94% of
  // the unfiltered baseline's $18,290 — while dropping the weak
  // mac-sourced third entirely). Signal-survival and dollar economics are
  // NOT the same thing: a dwell-time/grade filter that looked best on
  // signal-survival alone (minute>=6 AND grade!=null) actually UNDERPERFORMS
  // doing nothing once real P&L is measured (PF 1.17/$8,201 vs baseline's
  // PF 1.20/$18,290) — this source-only rule is the one that survived
  // actual economics testing, not just precision/recall on whether the
  // signal held to close.
  // ROUND 4 (owner order 10/14, untested): MAC grades listed in intrabarAllowMacGrades (shipped ['A','B']) pass the intrabar restriction; the bar-close side of the
  // rule (those grades are NOT entered again at the close) lives in live-executor.js macIntrabarOnlyBlock(). Omitted/null = the old rule, byte-identical.
  // 10-18b1 (Mac 10/16 09:13 PT, "no grade blocks anymore"): macIntrabarAllGrades true = a mac-sourced signal of ANY grade (A/B/C/'-') passes this
  // intrabar restriction. false (and every caller that does not pass it) = the rule above, byte-identical.
  if (blockMacSourceIntrabar && result.source === 'mac' && !macIntrabarAllGrades && !(Array.isArray(intrabarAllowMacGrades) && intrabarAllowMacGrades.includes(result.grade))) return null;
  // requireVolSpike (2026-10-08, intrabar false-signal mitigation) — intended
  // for the INTRABAR caller only (the caller decides whether to pass this
  // true; bar-close callers leave it false/omitted and are unaffected,
  // preserving the already-validated bar-close behavior exactly). Polling
  // the still-forming bar more often raises the odds of catching a one-poll
  // price wick that momentarily satisfies score/grade/alignment but has no
  // real participation behind it and would un-print by the real close (see
  // live-executor.js's REPAINTING writeup). mac.volSpikeBull/volSpikeBear
  // (macTrap.js section 16: volRatio = this bar's volume / its own 20-bar
  // average, already > cfg.volSpikeMult, i.e. elevated — not just "not
  // compressed" like volOk/blockMacCompression above) are the same-bar,
  // direction-aligned volume confirmation: a real move should be showing
  // real participation, not just a price tick. Requires alignment with
  // result.dir, not just "a spike happened" — a bull signal on a bearish
  // volume spike is not confirmation, it's the opposite move overrunning.
  if (requireVolSpike && !levelsOnlyEntries) {   // lv1: the MAC volume veto never blocks a levels-only entry
    const volSpikeAligned = result.dir === 1 ? mac.volSpikeBull : mac.volSpikeBear;
    if (!volSpikeAligned) return null;
  }
  // blockMacGradeB / blockGradeCAsia (2026-10-08, PF investigation) — see
  // lib/simulate3leg.js's comments at its matching filter for the full
  // 5-year numbers (mac-sourced grade B alone: n=2203, PF=0.96, -$13,853;
  // grade C during Asia hours alone: n=311, PF=0.90, -$3,552). Applied here,
  // the single shared decideSignal() both live call sites use, instead of
  // duplicated inline so it can never drift from the backtested rule.
  if (blockMacGradeB && result.source === 'mac' && result.grade === 'B') return null;
  if (blockGradeCAsia && result.grade === 'C' && ptInfo(nowTs).isAsia) return null;
  // minBiasAgreementMacSource / minBiasAgreementLevelsSource (2026-10-08) —
  // see lib/simulate3leg.js's matching comment for the full 5-year numbers.
  // lv.biasScore is Levels PRO's own continuous buyer/seller-control
  // composite; signed so positive always means "agrees with this trade's
  // direction".
  const biasAgreement = result.dir === 1 ? lv.biasScore : -lv.biasScore;
  if (result.source === 'mac' && minBiasAgreementMacSource != null && biasAgreement < minBiasAgreementMacSource) return null;
  if (result.source === 'levels' && minBiasAgreementLevelsSource != null && biasAgreement < minBiasAgreementLevelsSource) return null;
  // 10-18b1 CONTROL GATE (Mac's control doctrine 10/16 09:19 PT: "we want trades when one or the other is in control... The control means
  // everything."). controlDirectionGate true = every source must trade WITH the side in control: |control score| < controlGateMin (contested /
  // leaning) -> no trade; otherwise result.dir must equal the controlling side. false (and every caller that does not pass it) = no gate.
  // 10-18b2c (TEAM DECISION 1, MacLedger 6227766281): controlContestedMinSize true = CONTESTED (|control score| < controlGateMin) no longer refuses:
  // the result is returned marked controlContested, and the caller (live-executor.js checkForNewEntry) sizes it at the minimum (1 contract, only if
  // 1 contract fits the risk cap). The direction selection above (part 1) and the wrong-side refusal below are unchanged. false (and every caller
  // that does not pass it) = the b1 / b2a rule, byte-identical.
  // r2 (MacLock B4): CONTESTED needs a KNOWN score - controlKnown(lv): a finite 15m score from a valid Levels PRO evaluation. Unknown falls through to the refusal.
  if ((standdownWeek1 || controlDirectionGate) && result.source === 'levels' && lvEventExempt(result.dir)) return { ...result, controlExempt: 'level-event' };   // lv1 (Mac's ruling)
  if (standdownWeek1) return classifyControl(lv, result.dir).ok ? result : null;
  if (controlDirectionGate && controlContestedMinSize && controlSide(lv, controlGateMin) === 0 && controlKnown(lv)) return { ...result, controlContested: true };
  if (controlDirectionGate && controlSide(lv, controlGateMin) !== result.dir) return null;
  return result;
}

// 10-18b1: the side in control, from Levels PRO's buyer/seller-control score (the 15m chart's when the caller supplies lv.controlBiasScore,
// else lv.biasScore). +1 buyers, -1 sellers, 0 = contested / leaning (|score| < min) or no score.
function controlSide(lv, min = 0.22) {
  const s = lv && Number.isFinite(lv.controlBiasScore) ? lv.controlBiasScore : lv && Number.isFinite(lv.biasScore) ? lv.biasScore : NaN;
  if (!Number.isFinite(s) || Math.abs(s) < min) return 0;
  return s > 0 ? 1 : -1;
}

// 10-18b2c r2 (MacLock B4): a contested reading is only a reading when it is KNOWN. lib/levelsPro.js maps "no data" to biasScore 0 / CONTESTED
// (levelsPro.js:428 `bden > 0 ? bnum / bden : 0`), so a finite 0 alone proves nothing. controlEvalValid(out, nBars) is the evaluation's own validity,
// read from fields Levels PRO already outputs (levelsPro.js:584 close, atrRef; :590 levels = exactly the priced, enabled levels that enter bden):
// bden finite and > 0 <=> at least one level, EVERY level price finite (a NaN price would poison bden to NaN -> 0), the close finite and atrRef > 0 (levelsPro.js:421-426). Plus enough history: nBars >= minBars
// (100, the bot's own floor for the 5m / 3m Levels charts). live-executor.js sets lv.controlValid from it for the 15m evaluation.
function controlEvalValid(out, nBars, minBars = 100) {
  return !!out && typeof out.biasScore === 'number' && Number.isFinite(out.biasScore) && Number.isFinite(out.close) && Number.isFinite(out.atrRef) && out.atrRef > 0
    && Array.isArray(out.levels) && out.levels.length > 0 && out.levels.every(l => l && typeof l.price === 'number' && Number.isFinite(l.price)) && Number.isFinite(nBars) && nBars >= minBars;
}
// true = the 15m control score is KNOWN: lv.controlValid (set by the bot from controlEvalValid) and a finite NUMBER controlBiasScore. No fallback to biasScore.
function controlKnown(lv) { return !!lv && lv.controlValid === true && typeof lv.controlBiasScore === 'number' && Number.isFinite(lv.controlBiasScore); }

// 10-18b1 (journal only): WHICH requirement admitted a decideSignal() result, for the trade_plan row's candidateBasis. Pure; reads the same
// fields decideSignal() read. 'mac-score-ge-min' (score >= minMacScore) | 'mac-strong-bias' (MAC STRONG BULL/BEAR alternative) |
// 'mac-any-score' (admitted only because macStrongRequired is false) | 'levels-plan' | 'levels-strong' | 'levels-bias-side' (admitted only
// because levelsTriggerRequired is false). null = no signal, or an entry not from decideSignal(). Never read by an order.
function candidateBasis(mac, lv, sig, { minMacScore = 7, levelsUsePersistedPlan = false } = {}) {
  if (!sig || !sig.dir || (sig.source !== 'mac' && sig.source !== 'levels')) return null;   // wave / reversal / reclaim entries do not come from decideSignal()
  const d = sig.dir;
  if (sig.source === 'mac') {
    if (mac.activeDir === d && mac.activeScore >= minMacScore) return 'mac-score-ge-min';
    if (mac.biasStr === (d === 1 ? 'STRONG BULL' : 'STRONG BEAR')) return 'mac-strong-bias';
    return 'mac-any-score';
  }
  if (d === 1 ? (levelsUsePersistedPlan ? lv.planLong : lv.sigLong) : (levelsUsePersistedPlan ? lv.planShort : lv.sigShort)) return 'levels-plan';
  if (lv.biasStr === (d === 1 ? 'STRONG BUYER CONTROL' : 'STRONG SELLER CONTROL')) return 'levels-strong';
  return 'levels-bias-side';
}

module.exports = { decideSignal, candidateBasis, controlSide, controlKnown, controlEvalValid };
