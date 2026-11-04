#!/usr/bin/env node
'use strict';
// TIDE r2 STAGE 1 identity: tide.mode "off" must behave exactly as r13.3.7 (playbook §9 "mode off = identical to the live bot").
// usage: node tests/identity-tide1.cjs <r13.3.7 run dir> <TIDE Stage 1 run dir (tide off)> [--json]
//   Run dirs from the virtual-clock replay harness (run.sh): trace.jsonl (every broker call, fill, gate and market event the harness saw), polls.jsonl,
//   broker-state.json and tree/ (every file the bot wrote). Time is virtual and deterministic: NO time normalisation, no float tolerance.
//   Normalised (both runs): each run's own folder path (<RUN>), random ids (runId, stampId, run, publication, mapPublication, journalId, any UUID) and measured durations (computeMs, ageMs, seenLagMs).
//   Allowed (the build itself, nothing it decides): in the session_stamp row the hashes of live-executor.js and of the three new lib files
//   (lib/tideWire.js, lib/moneyRule.js, lib/structure.js) and of lib/journalMeta.js (it records the two new settings), settingsHash, the two new settings sections
//   (settings.tide, settings.money), and configIdentity (the settings hash) on any row; journal ids (random) in log lines are normalised too; in the bot's own
//   log the "Config:" line, the "lib versions:" line, the session-stamp line and the three new startup lines ("[tide] new model ...", "[sizing] ...", "[money] config ...").
//   Everything else, in every file, must be equal. Exit 0 = identical.
const fs = require('fs'), path = require('path');
const [A, B] = process.argv.slice(2).filter(a => !a.startsWith('--')), JSONOUT = process.argv.includes('--json'), SHADOW = process.argv.includes('--shadow');
// --shadow (A1: shadow must never change the live path): B runs tide.mode shadow. Its OWN rows are set aside - lv_tide journal rows, the "TIDE shadow" push,
// the [tide] log lines and the tide.mode echo, and its 1m history reads in polls.jsonl (unit 2 / 1 rows that the base run does not have) - and every other
// row, the old path's broker calls WITH their virtual times and prices included, must be equal. Use the h2t rig (TIDE's history read on its own latency stream).
if (!A || !B) { console.error('usage: node tests/identity-tide1.cjs <base run> <tide-off run>'); process.exit(2); }
const ID_KEYS = new Set(['runId', 'stampId', 'run', 'publication', 'mapPublication', 'journalId']), MS_KEYS = new Set(['computeMs', 'ageMs', 'seenLagMs']);
// the display's alignment expiry subtracts a REAL measured elapsed time (performance.now(), not the virtual clock): <= 5 ms apart is measurement, listed as wobble
const WOBBLE = /alignmentDisplay\.slots\.\d+\.expiresAt$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAMP_OK = [/^files\.live-executor\.js$/, /^files\.lib\/(tideWire|moneyRule|structure|journalMeta|tideOrders|tideLive|tideRebuild)\.js$/, /^settingsHash$/, /^settings\.(tide|money)(\.|$)/];
const ROW_OK = [/^configIdentity$/];
// --shadow: counters TIDE itself moves - the phone snapshot's levels-journal row count and config-local echo, the INFO push budget's count
const SHADOW_OK = [/^levels\.journal\.rows$/, /^configLocal\.overrides(\.|$)/, /^configLocal\.(overridesHash|count)$/, /^info(\.|$)/];
if (SHADOW) STAMP_OK.push(/^overrides(\.|$)/, /^overridesHash$/, /^configLocal(\.|$)/, /^safeOverrides(\.|$)/);   // B's config-local holds tide.mode shadow   // the hash of the settings (which now hold tide / money): every row that carries it
const LOG_OK = [/\] Config: \{/, /\] lib versions: /, /\] \[journal\] session stamp /, /\] \[tide\] new model /, /\] \[sizing\] /, /\] \[money\] config /, /\] \[tide\] shas /, /^exit -?\d+$/];   // + the harness's own "exit N" line in bot.log (run.sh appends it)
const SRC = new Set(['live-executor.js', 'mobile.html', 'config-local.json', 'peer-parity.cjs', 'test-alignment-integration.js', 'test-required-slots.cjs', 'test-trigger-parity.js', 'tmc-proxy.js']);
function norm(v, k) {
  if (ID_KEYS.has(k) && v !== null && v !== undefined) return 'ID';
  if (MS_KEYS.has(k) && typeof v === 'number') return 'MS';
  if (typeof v === 'string' && UUID.test(v)) return 'UUID';
  if (Array.isArray(v)) return v.map(x => norm(x, k));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, norm(x, kk)]));
  return v;
}
function dd(a, b, p, out) {
  if (a === b) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) dd(a[k], b[k], p ? `${p}.${k}` : k, out);
    return;
  }
  if (typeof a === 'number' && typeof b === 'number' && WOBBLE.test(p || '') && Math.abs(a - b) <= 5) { rep.wobble.push(`${p}: ${a} vs ${b}`); return; }
  out.push(p || '(root)');
}
// every journalId a run wrote (random UUIDs): in text they also appear as their first 8 characters (log lines)
function journalIds(run) { const ids = new Set(); for (const f of ['trade-journal-MNQ.jsonl']) { const p = path.join(run, 'tree', f); if (!fs.existsSync(p)) continue; for (const m of fs.readFileSync(p, 'utf8').matchAll(/"journalId":"([0-9a-f-]{36})"/g)) ids.add(m[1]); } return [...ids]; }
const JA = journalIds(A), JB = journalIds(B);
function jid(t, ids) { for (const id of ids) t = t.split(id).join('JID').split(id.slice(0, 8)).join('JID8'); return t; }
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && !SRC.has(e.name)).map(e => e.name).sort();
const rep = { identical: true, files: [], diffs: [], allowed: [], wobble: [], rows: 0 };
function cmpFile(fa, fb, label) {
  if (SHADOW && !fs.existsSync(fa) && fs.existsSync(fb) && fs.readFileSync(fb, 'utf8').split('\n').filter(Boolean).every(l => /"type":"lv_tide"/.test(l))) { rep.allowed.push(`${label}: only in the shadow run, every row lv_tide`); return; }
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) { rep.diffs.push(`${label}: only in ${fs.existsSync(fa) ? 'the base run' : 'the second run'}`); return; }
  rep.files.push(label);
  const ta = jid(fs.readFileSync(fa, 'utf8').split(path.resolve(A)).join('<RUN>'), JA), tb = jid(fs.readFileSync(fb, 'utf8').split(path.resolve(B)).join('<RUN>'), JB);   // each run's own folder name and journal ids
  if (label.endsWith('.log') || label === 'bot.log') {
    const la = ta.split('\n'), lb = tb.split('\n'), keep = l => !LOG_OK.some(re => re.test(l));
    const tideLine = l => SHADOW && (/\[tide\]|\[config-local\]   tide\.|"tide":\{"mode":"shadow"/.test(l) || /\] \[config-local\] .* applied: \d+ setting/.test(l) || /TIDE shadow/.test(l));
    const ka = la.filter(keep).filter(l => !tideLine(l)), kb = lb.filter(keep).filter(l => !tideLine(l)); rep.allowed.push(`${label}: ${la.length - ka.length}/${lb.length - kb.length} build lines set aside`);
    const n = Math.max(ka.length, kb.length); for (let i = 0; i < n; i++) { rep.rows++; if (ka[i] !== kb[i]) { rep.diffs.push(`${label} line ${i + 1}: ${JSON.stringify((ka[i] || '').slice(0, 160))} vs ${JSON.stringify((kb[i] || '').slice(0, 160))}`); break; } }
    return;
  }
  const parse = t => (fa.endsWith('.json') ? [t] : t.split('\n').filter(Boolean)).map(l => { try { return JSON.parse(l); } catch (e) { return { unparsed: l }; } });
  let ra = parse(ta), rb = parse(tb);
  if (SHADOW) { const own = r => r && (r.type === 'lv_tide' || (r.kind === 'notify' && /TIDE shadow/.test(r.title || '')));
    const nb = rb.length; rb = rb.filter(r => !own(r)); ra = ra.filter(r => !own(r));
    if (label === 'polls.jsonl') { const keyA = new Map(); for (const r of ra) { const k = JSON.stringify(r); keyA.set(k, (keyA.get(k) || 0) + 1); } rb = rb.filter(r => { const k = JSON.stringify(r); if (keyA.get(k)) { keyA.set(k, keyA.get(k) - 1); return true; } return !(Array.isArray(r) && r[1] === 2 && r[2] === 1); }); }
    if (nb !== rb.length) rep.allowed.push(`${label}: ${nb - rb.length} TIDE rows set aside`); }
  if (ra.length !== rb.length) rep.diffs.push(`${label}: ${ra.length} vs ${rb.length} rows`);
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    rep.rows++; const out = []; dd(norm(ra[i], ''), norm(rb[i], ''), '', out); if (!out.length) continue;
    const stamp = ra[i] && ra[i].type === 'session_stamp';
    const ok = out.filter(x => (stamp && STAMP_OK.some(re => re.test(x))) || ROW_OK.some(re => re.test(x)) || (SHADOW && /bias-snapshot|notify-budget/.test(label) && SHADOW_OK.some(re => re.test(x)))), bad = out.filter(x => !ok.includes(x));
    if (ok.length) rep.allowed.push(`${label} row ${i + 1}${stamp ? ' (session_stamp)' : ''}: ${ok.join(', ')}`);
    if (bad.length) { rep.diffs.push(`${label} row ${i + 1}: ${bad.slice(0, 6).join(', ')}`); }
  }
}
for (const f of ['trace.jsonl', 'polls.jsonl', 'broker-state.json', 'bot.log']) cmpFile(path.join(A, f), path.join(B, f), f);
const fa = files(path.join(A, 'tree')), fb = files(path.join(B, 'tree'));
for (const f of new Set([...fa, ...fb])) cmpFile(path.join(A, 'tree', f), path.join(B, 'tree', f), 'tree/' + f);
rep.identical = rep.diffs.length === 0;
if (JSONOUT) console.log(JSON.stringify(rep, null, 1));
else { console.log(`identity ${rep.identical ? 'IDENTICAL' : 'DIFF'}: ${rep.files.length} files, ${rep.rows} rows/lines compared`); for (const x of rep.allowed) console.log('  allowed: ' + x); for (const x of rep.wobble) console.log('  measured wobble (<= 5 ms): ' + x); for (const x of rep.diffs.slice(0, 30)) console.log('  DIFF: ' + x); }
process.exitCode = rep.identical ? 0 : 1;
