'use strict';
// Terminal 2.0.9.20 PREVIEW build (MacUI-N, 11/04): build-201992.cjs + MACUI_RELEASE=2.0.9.20 = 2.0.9.19.2 + v2src/feat-20920.js (the TIDE tape) + r20920.css, after MacFacts. MACUI_RELEASE=2.0.9.19.2 still gives 2.0.9.19.2.
// Terminal 2.0.9.19.2 PREVIEW build (MacUI-N, 11/04): build-20919.cjs + MACUI_RELEASE=2.0.9.19.2 = 2.0.9.19.1 with v2src/feat-20918-r2.js, feat-20919-r2.js, r20919-r2.css in place of feat-20918.js, feat-20919.js, r20919.css (the same insertion points). MACUI_RELEASE=2.0.9.19 still gives 2.0.9.19.1.
// Terminal 2.0.9.19 PREVIEW build (MacUI-N, 11/04): build-20918.cjs + MACUI_RELEASE=2.0.9.19 = 2.0.9.18 + v2src/feat-20919.js / r20919.css + one text patch in feat-20918.js as built (the ruler's STOP · ENTRY marker at break-even). MACUI_RELEASE=2.0.9.18 still gives 292e78ad.
// Terminal 2.0.9.18 PREVIEW build (MacUI-N, 11/04): build-20917.cjs + MACUI_RELEASE=2.0.9.18 = 2.0.9.17 with the TIDE card, position view, trade tags and alert strip (v2src/feat-20918.js, r20918.css). MACUI_RELEASE=2.0.9.17 still gives 3dbf9bf8.
// Terminal 2.0.9.17 PREVIEW build (MacUI-T, 11/03): build-20916.cjs + MACUI_RELEASE=2.0.9.17 = 2.0.9.16 with the Hour card v2 (v2src/feat-20917.js, r20917.css). MACUI_RELEASE=2.0.9.16 still gives 2.0.9.16.
// Terminal 2.0.9.16 PREVIEW build (MacUI-T, 11/03): build-20913.cjs + MACUI_RELEASE=2.0.9.16 = 2.0.9.13 with v2src/feat-20916.js (one new script last), v2src/r20916.css
// (one stylesheet last) and four exact text patches in the Signal Path (clpath.js as built; checklist parity, Mac 11/03). MACUI_RELEASE=2.0.9.13 still gives 7615adc8.
// Terminal 2.0.9.13 PREVIEW build (MacArthur, 11/02): build-20912.cjs + MACUI_RELEASE=2.0.9.13 = 2.0.9.12 with the Hour wave card (Mac: "I want the team to be
// able to see the charts like I do"): v2src/feat-20913.js, one new script last, and v2src/r20913.css, one stylesheet last. MACUI_RELEASE=2.0.9.12 still gives
// 31c373e6 (the page bytes do not depend on this script's name). Its 2.0.9.12 history:
// Terminal 2.0.9.12 PREVIEW build (MacUI-4, 11/02): build-20911.cjs + MACUI_RELEASE=2.0.9.12 = 2.0.9.11 with the Trades tab's UNKNOWNs resolved from
// the broker round trip the bot reconciled to each trade (v2src/fix-20912.js, one new script last; v2src/r20912.css). MACUI_RELEASE=2.0.9.11 still gives
// c22c6a64 (the page bytes do not depend on this script's name). Its 2.0.9.11 history:
// Terminal 2.0.9.11 PREVIEW build (MacUI-4, 11/02): build-20910.cjs + MACUI_RELEASE=2.0.9.11 = 2.0.9.10 with Mac's five trader-benefit features (the
// Why-not line, the Bot-is-managing block, the after-a-stop limits, the session strip, the alignment ladder): v2src/feat-20911.js, one new script
// last, and v2src/r20911.css, one stylesheet last. Nothing else changes; MACUI_RELEASE=2.0.9.10 still gives ca093989. Its 2.0.9.10 history:
// Terminal 2.0.9.10 PREVIEW build (MacUI-3, 11/02): build-2099.cjs + MACUI_RELEASE=2.0.9.10 = 2.0.9.9 with Mac's fixes stage 2 ((c) shorter long tabs,
// (b) one live-truth signal, the S3 shorter plot on short screens: v2src/fixes-20910.js, fixes-20910.cjs, v2src/r20910.css). Its 2.0.9.9 history:
// Terminal 2.0.9.9 PREVIEW build (MacUI-3, 11/02): build-2098.cjs + MACUI_RELEASE=2.0.9.9 = 2.0.9.8 with the brain pause (v2src/brain-bv-2099.js in place
// of brain-bv-2098.js: replays stay smooth) and Mac's four approved fixes (v2src/fixes-2099.js, one new script after review-cards; v2src/r2099.css).
// MACUI_RELEASE=2.0.9.8 / 2.0.9.7 / 2.0.9.6 still give 860504a2 / b721ccab / 12edef73 (the page bytes do not depend on this script).
// Terminal 2.0.9.8 PREVIEW build (MacUI-3, 11/01): build-2097.cjs + MACUI_RELEASE=2.0.9.8 = 2.0.9.7 with the Robot Brain's three truth fixes (MacDot #5,
// 6564080361): v2src/brainview-part1-2098.js (PART 1 + a 4-line opt-in patch), v2src/brain-adapter-2098.js, v2src/brain-bv-2098.js in place of the 2097
// files; everything else as 2.0.9.7. MACUI_RELEASE=2.0.9.7 / 2.0.9.6 still give b721ccab / 12edef73 (the page bytes do not depend on this script).
// Terminal 2.0.9.5 build (MacUI-L, 11/01): build-2094.cjs + MACUI_RELEASE=2.0.9.5 (fixes-2095.cjs, v2src/r2095.css).
// Terminal 2.0.9.7 build (MacUI-2, 11/01): build-2096.cjs + MACUI_RELEASE=2.0.9.7: the Robot Brain in Control's Level Reactor slot: v2src/brain-2097.css,
// v2src/brain-adapter-2097.js + v2src/brain-view-2097.js as ONE new script placed right after reactor.js and before integrate.js (it takes window.Reactor's
// mount contract; the main script block and integrate.js are unchanged and checked).
// Terminal 2.0.9.6 build (MacUI-2, 11/01): build-2095.cjs + MACUI_RELEASE=2.0.9.6: v2src/r2096.css, v2src/review-cards-2096.js (a new script, wrappers only)
// and one markup change (the Review tab's All-Time card -> the Combine card and the This-bot card; a hidden sink keeps the bot's own All-Time writes).
// Terminal 2.0.9.4 build (MacUI-L, 11/01): build-2093.cjs + the MACUI_RELEASE=2.0.9.4 path (fixes-2094.cjs; no CSS change; MacDot 6557300372).
// Terminal 2.0.9 build (MacUI-L, 11/01; build-208.cjs + the MACUI_RELEASE=2.0.9 path, marked "2.0.9"). Terminal 2.0.8 build (MacUI-L, 11/01; build-207.cjs plus the MACUI_RELEASE=2.0.8 hotfix path, marked "2.0.8"). Terminal 2.0.7 build: build-v2.cjs plus a MACUI_RELEASE=2.0.7 path (2.0.6 + the reviewers' correctness fixes, fixes-207.cjs).
// build-v2.cjs itself is left untouched so the 2.1.x build IDs (which hash it) do not move. With MACUI_RELEASE unset this script still
// rebuilds 2.0.6 (7be35de5) byte for byte; every 2.0.7 line below is marked "2.0.7".
// Builds macui/mobile-v2.html from the shipped mobile.html (harness/src/mobile.v1.html, sha256 189963d6...).
// Every edit is an exact, counted replacement (each must match exactly once) so a drift in the source fails loudly.
// The bot's main <script> block is copied byte for byte (checked at the end); the v2 display shell is a separate, appended <script>.
// Terminal 2.0.9.21 (MacUI-N2, 11/04): build-20920.cjs + MACUI_RELEASE=2.0.9.21 = 2.0.9.20 with the Hour card's type read and 4H anchor fixed (v2src/feat-20917-r21.js).
// Terminal 2.0.9.22 (MacUI-N3, 11/04): build-20921.cjs + MACUI_RELEASE=2.0.9.22 = 2.0.9.21 with the QC-UI items (v2src/feat-20918-r22.js, feat-20920-r22.js).
const R22 = process.env.MACUI_RELEASE === '2.0.9.22'; if (R22) process.env.MACUI_RELEASE = '2.0.9.21';
const R21 = process.env.MACUI_RELEASE === '2.0.9.21'; if (R21) process.env.MACUI_RELEASE = '2.0.9.20';   // every 2.0.9.20 step, then the .21 file swap and version
const fs = require('fs'), path = require('path'), crypto = require('crypto');
// Base page: MACUI_BASE=r133 builds on the LIVE r13.3 mobile.html (sha256 58d02279..., no S/R areas: terminal drop 1, served by the r13.3 proxy);
// the default builds on the r13.3.1/r13.3.2 package page (189963d6..., with the S/R areas card).
const BASE = process.env.MACUI_BASE === 'r133' ? { file: 'src/mobile.r133.html', sha: '58d02279', sr: false } : { file: 'src/mobile.v1.html', sha: '189963d6', sr: true };
const H = __dirname, SRC = path.join(H, BASE.file), OUT = process.env.MACUI_OUT ? path.resolve(process.env.MACUI_OUT) : path.resolve(H, '../mobile-v2.html');
// 2.1.0: every file the build reads is recorded (path relative to macui/, sha256) for the input manifest and the visible build ID
const INPUTS = new Map(), readIn = p => { const t = fs.readFileSync(p, 'utf8'); INPUTS.set(path.relative(path.resolve(H, '..'), p).split(path.sep).join('/'), t); return t; };
const R20920 = process.env.MACUI_RELEASE === '2.0.9.20', R201992 = process.env.MACUI_RELEASE === '2.0.9.19.2' || R20920, V2MAP = { 'feat-20918.js': 'feat-20918-r2.js', 'feat-20919.js': 'feat-20919-r2.js', 'r20919.css': 'r20919-r2.css', ...(R21 ? { 'feat-20917.js': 'feat-20917-r21.js', 'feat-20919.js': 'feat-20919-r21.js', 'feat-20920.js': 'feat-20920-r21.js' } : {}), ...(R22 ? { 'feat-20918.js': 'feat-20918-r22.js', 'feat-20920.js': 'feat-20920-r22.js' } : {}) };   // 2.0.9.21: the Hour card (r21), the header distance words (feat-20919-r21), the Levels plan-line fix (feat-20920-r21)
const V = p => readIn(path.join(H, 'v2src', R201992 && V2MAP[p] ? V2MAP[p] : p));
// MACUI_RELEASE=2.1.0 turns on the 2.1.0 changes (Signal Path truthfulness fixes, replay-slider clearance, MacScope mount, build ID); unset, this
// script still rebuilds 2.0.6 (7be35de5) byte for byte
// MACUI_RELEASE=2.1.1 is 2.1.0 plus fixes-211.cjs (the replay header, the reel fitted between the header and the tab bar) and v2src/r211.css
const REL = process.env.MACUI_RELEASE || '', R211 = REL === '2.1.1', R210 = REL === '2.1.0' || R211, R20919 = REL === '2.0.9.19' || REL === '2.0.9.19.2' || REL === '2.0.9.20', R20918 = REL === '2.0.9.18' || R20919, R20917 = REL === '2.0.9.17' || R20918, R20916 = REL === '2.0.9.16' || R20917, R20913 = REL === '2.0.9.13' || R20916, R20912 = REL === '2.0.9.12' || R20913, R20911 = REL === '2.0.9.11' || R20912, R20910 = REL === '2.0.9.10' || R20911, R2099 = REL === '2.0.9.9' || R20910, R2098 = REL === '2.0.9.8' || R2099, R2097 = REL === '2.0.9.7' || R2098, R2096 = REL === '2.0.9.6' || R2097, R2095 = REL === '2.0.9.5' || R2096, R2094 = REL === '2.0.9.4' || R2095, R2093 = REL === '2.0.9.3' || R2094, R2092 = REL === '2.0.9.2' || R2093, R2091 = REL === '2.0.9.1' || R2092, R209 = REL === '2.0.9' || R2091, R208 = REL === '2.0.8' || R209, R207 = REL === '2.0.7' || R208;   // 2.0.9 = 2.0.8 + fixes-209.cjs + r209.css; 2.0.9.1 = 2.0.9 + fixes-2091.cjs + r2091.css (build-2091.cjs; build-209.cjs is unchanged)   // 2.0.8 hotfix = 2.0.7 labelled + fixes-208.cjs + r208.css
if (REL && !R210 && !R207) throw new Error('unknown MACUI_RELEASE ' + REL);
// 2.0.7: MACUI_REEL_NUMBERS=strict | labelled (MacArthur 11/01 (b)): the reel's numbers without an observed fill (fixes-207.cjs RL_LABELLED_207)
const RN = process.env.MACUI_REEL_NUMBERS || '';
if (R207 && !/^(strict|labelled)$/.test(RN)) throw new Error('2.0.7 needs MACUI_REEL_NUMBERS=strict or labelled');
if (R208 && RN !== 'labelled') throw new Error('2.0.8 / 2.0.9 are the labelled flavour: MACUI_REEL_NUMBERS=labelled');
if (!R207 && RN) throw new Error('MACUI_REEL_NUMBERS is a 2.0.7 setting');
if (R207 && process.env.MACUI_VARIANT) throw new Error('2.0.7: no MACUI_VARIANT');
if (R211 && process.env.MACUI_VARIANT) throw new Error('2.1.1 ships one build: no MACUI_VARIANT');
readIn(__filename); if (R210) readIn(path.join(H, 'fixes-210.cjs')); if (R211) readIn(path.join(H, 'fixes-211.cjs'));
if (R207) { readIn(path.join(H, 'fixes-207.cjs')); readIn(path.join(H, 'fixes-210.cjs')); readIn(path.join(H, 'fixes-211.cjs')); }   // 2.0.7: fixes-207 takes its 2.1.x pairs from these
const F7 = R207 ? require('./fixes-207.cjs') : null;   // 2.0.7
if (R208) readIn(path.join(H, 'fixes-208.cjs'));
const F8 = R208 ? require('./fixes-208.cjs') : null;   // 2.0.8
if (R209) readIn(path.join(H, 'fixes-209.cjs')); if (R2091) readIn(path.join(H, 'fixes-2091.cjs')); if (R2092) readIn(path.join(H, 'fixes-2092.cjs')); if (R2093) readIn(path.join(H, 'fixes-2093.cjs')); if (R2094) readIn(path.join(H, 'fixes-2094.cjs')); if (R2095) readIn(path.join(H, 'fixes-2095.cjs'));
if (R2099) readIn(path.join(H, 'fixes-2099.cjs')); const F99 = R2099 ? require('./fixes-2099.cjs') : null;
if (R20910) readIn(path.join(H, 'fixes-20910.cjs')); const F910 = R20910 ? require('./fixes-20910.cjs') : null;
const F9 = R209 ? require('./fixes-209.cjs') : null, F91 = R2091 ? require('./fixes-2091.cjs') : null, F92 = R2092 ? require('./fixes-2092.cjs') : null, F93 = R2093 ? require('./fixes-2093.cjs') : null, F94 = R2094 ? require('./fixes-2094.cjs') : null, F95 = R2095 ? require('./fixes-2095.cjs') : null;   // 2.0.9.1   // 2.0.9
let h = readIn(SRC);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
if (!sha(h).startsWith(BASE.sha)) throw new Error('unexpected source mobile.html ' + sha(h).slice(0, 8) + ' (want ' + BASE.sha + ')');
const mainScript = src => { const i = src.indexOf('<script>\n// Same-origin by design'); return src.slice(i, src.indexOf('</script>', i) + 9); };
const MAIN = mainScript(h);
function rep(from, to, label) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`${label}: expected 1 match, found ${n}`);
  h = h.replace(from, () => to);
}
function repRange(startMark, endMark, to, label) {
  const i = h.indexOf(startMark), j = h.indexOf(endMark, i);
  if (i < 0 || j < 0 || h.indexOf(startMark, i + 1) >= 0 && h.indexOf(startMark, i + 1) < j) throw new Error(label + ': range not found / ambiguous');
  h = h.slice(0, i) + to + h.slice(j + endMark.length);
}

// ── head: allow zoom again (accessibility); title unchanged ──
rep('<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no">', '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">', 'viewport');
rep('<meta name="theme-color" content="#06080d" id="meta-theme">', '<meta name="theme-color" content="#000000" id="meta-theme">', 'theme-color');

// ── style: tokens, one type scale, semantic colours, then the v2 layer ──
repRange('/* ── Design tokens (2026-10-14 terminal refresh). Dark first; light theme below. ── */', ':root[data-theme="dark"] { color-scheme: dark; }', V('tokens.css').trim(), 'tokens');
const s0 = h.indexOf('<style>'), s1 = h.indexOf('</style>');
let css = h.slice(s0, s1);
const tokEnd = css.indexOf(':root[data-theme="dark"] { color-scheme: dark; }');
const scale = n => (n <= 12.5 ? 12 : n <= 14 ? 14 : n <= 17 ? 16 : n <= 22 ? 20 : 28);
const sizes = {};
css = css.slice(0, tokEnd) + css.slice(tokEnd).replace(/font-size:\s*([\d.]+)px/g, (m, n) => { const t = scale(Number(n)); sizes[n] = t; return `font-size: ${t}px`; })
  .replace('font-size: clamp(34px, 11vw, 46px)', 'font-size: 28px');
// semantic tokens instead of raw hex inside components
const hexFix = [['.rt-row .ok { color: #22C55E; } .rt-row .no { color: #EF4444; }', '.rt-row .ok { color: var(--status-good); } .rt-row .no { color: var(--status-critical); }'],
  ['.flags-row .fl-v.sellers { color: #EF4444; } .flags-row .fl-v.buyers { color: #22C55E; } .flags-row .fl-v.mixed { color: #94A3B8; }', '.flags-row .fl-v.sellers { color: var(--bear); } .flags-row .fl-v.buyers { color: var(--bull); } .flags-row .fl-v.mixed { color: var(--t2); }'],
  ['background: var(--accent); color: #05070d; font-weight: 800;', 'background: var(--accent); color: var(--on-tone); font-weight: 800;'],
  ['.why-top .why-title { font-size: 16px; font-weight: 800; color: #fff; }', '.why-top .why-title { font-size: 16px; font-weight: 800; color: var(--t1); }'],
  ['#why-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.72);', '#why-overlay { display: none; position: fixed; inset: 0; background: var(--scrim);'],
  [':root { --ctl-teal: #2dd4bf;', ':root { --ctl-teal: #2dd4bf;'],
  ['@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --ctl-teal: #0f766e; } }', '@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --ctl-teal: #0f716a; } }'],
  [':root[data-theme="light"] { --ctl-teal: #0f766e; }', ':root[data-theme="light"] { --ctl-teal: #0f716a; }']];
for (const [a, b] of hexFix) { const n = css.split(a).length - 1; if (n !== 1) throw new Error('hexFix ' + a.slice(0, 40) + ' x' + n); css = css.replace(a, () => b); }
const TAPE = String(process.env.MACUI_MODULES || '').split(',').includes('tape');   // prototype: the Now hero "live tape" (MacUI's own module, off unless asked)
const LMAP = String(process.env.MACUI_MODULES || '').split(',').includes('lmap');   // prototype: the Levels hero "level map" (MacUI's own module, off unless asked)
const CLPATH = String(process.env.MACUI_MODULES || '').split(',').includes('clpath');   // prototype: the Checklist as a Signal Path (MacUI's own module, off unless asked)
const RADAR = String(process.env.MACUI_MODULES || '').split(',').includes('radarbg');   // prototype: the radar behind the pinned header (MacUI's own module, off unless asked)
css += '\n' + V('v2.css') + '\n' + V('v21.css') + (TAPE ? '\n' + V('tape.css') : '') + (LMAP ? '\n' + V('levelmap.css') : '') + (RADAR ? '\n' + V('radarbg.css') : '') + (CLPATH ? '\n' + V('clpath.css') : '');
h = h.slice(0, s0) + css + h.slice(s1);

// ── body: icon sprite, glance header, 5-tab bar, segmented sub-nav, regrouped Now view, S/R glance, settings into Control ──
rep('<body>\n', '<body>\n' + V('icons.html'), 'sprite');
repRange('  <div class="topbar">', '  <div id="error-slot"></div>', V('glance.html').trimEnd() + '\n\n  <div id="error-slot"></div>', 'topbar');
repRange('  <div id="view-dashboard">', '  <div id="view-journal" style="display:none">', V('dashboard.html').trimEnd() + '\n\n  <div id="view-journal" style="display:none">', 'dashboard');
rep('  <div id="view-risk" style="display:none">\n', '  <div id="view-risk" style="display:none">\n' + V('seg-trades.html'), 'seg-risk');
rep('  <div id="view-trades" style="display:none">\n', '  <div id="view-trades" style="display:none">\n' + V('seg-trades.html'), 'seg-trades');
rep('  <div id="view-checklist" style="display:none">\n', '  <div id="view-checklist" style="display:none">\n' + V('seg-now.html'), 'seg-checklist');
rep('<button class="action-btn" onclick="downloadTradeLog()">&#8595; Download Trade Log</button>', '<button class="action-btn" onclick="downloadTradeLog()"><svg class="ic" aria-hidden="true"><use href="#i-download"/></svg> Download Trade Log</button>', 'download');
rep('<button class="ctl-key wide resume" id="ctl-resume" style="display:none" onclick="ctlResumeTap(this)"><b>&#9654; Resume now</b></button>', '<button class="ctl-key wide resume" id="ctl-resume" style="display:none" onclick="ctlResumeTap(this)"><b>Resume now</b></button>', 'resume');
repRange('    <div class="card ctl-danger">', '  <div id="view-levels" style="display:none">', V('control-tail.html').trimEnd() + '\n\n  <div id="view-levels" style="display:none">', 'danger+settings');
if (BASE.sr) repRange('    <div class="card" id="sr-card">', '    <div class="card">\n      <div class="card-title">Armed levels', V('sr-card.html').trimEnd() + '\n    <div class="card">\n      <div class="card-title">Armed levels', 'sr-card');
repRange('<div class="tab-bar" id="tab-bar" style="display:none">', '</div>\n\n<div id="why-overlay"', V('tabbar.html').trimEnd() + '\n\n<div id="why-overlay"', 'tabbar');
rep('  <div id="view-control" style="display:none">\n', '  <div id="view-control" style="display:none">\n'
  + '    <section id="hero-root" class="hero-root" aria-label="Level reactor" hidden></section>\n'
  + '    <button type="button" id="sp-toggle" class="sp-toggle" aria-expanded="false" aria-controls="sp-root" hidden>Signal path details</button>\n'
  + '    <section id="sp-root" class="sp-root" aria-label="Signal path" hidden></section>\n', 'hero+sp-root');
rep('<div id="why-panel"><div class="why-top"><div class="why-title" id="why-title">Why this trade</div><button class="why-close" onclick="closeWhy()">Close</button></div>',
  '<div id="why-panel" role="dialog" aria-modal="true" aria-labelledby="why-title"><div class="why-top"><div class="why-title" id="why-title">Why this trade</div><button class="why-close" onclick="closeWhy()">Close</button></div>', 'why-dialog');

// ── the v2 display shell, after the bot's script ──
// team modules are integrated only once reviewed: MACUI_MODULES=sp,charts (default: none), so a half-written file never lands in the build
const WANT = String(process.env.MACUI_MODULES || '').split(',');
const MOD = (rel, key) => { const p = path.resolve(H, '..', rel); return WANT.includes(key) && fs.existsSync(p) ? readIn(p) : null; };
// Signal Path: MacSignal's files as delivered, plus MacUI's display fixes (MacArthur 10/30: MacSignal finished, MacUI owns these). Each fix is an exact,
// counted replacement on a copy at build time, so the delivered files stay as MacSignal left them and the diff is this list.
const SP_FIX_JS = [
  // 2) "0 of 6 gates clear" next to a lit Level event read as a contradiction: say what is counted
  ["var g = m.clearCount + ' of ' + GATES.length + ' gates clear',", "var g = m.clearCount + ' of ' + GATES.length + ' checks after the level event clear',"],
  ["m.clearCount + ' of ' + GATES.length + ' gates clear' + (m.origin ?", "m.clearCount + ' of ' + GATES.length + ' checks after the level event clear' + (m.origin ?"],
  ["m.clearCount + ' of ' + GATES.length + ' clear; the order checks run next.'", "m.clearCount + ' of ' + GATES.length + ' checks after the level event clear; the order checks run next.'"],
];
const SP_FIX_CSS = [
  // 1) no ellipsis on meaningful content: node sub-lines, level / distance lines, the mode line and the plate wrap instead of hiding text
  [".sp-root .sp-mode { font: 12px/16px var(--sp-text); color: var(--sp-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }", ".sp-root .sp-mode { font: 12px/16px var(--sp-text); color: var(--sp-ink-2); white-space: normal; overflow-wrap: anywhere; min-width: 0; }"],
  [".sp-root .sp-n-lvl { grid-area: lvl; min-width: 0; font: 12px/16px var(--sp-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }", ".sp-root .sp-n-lvl { grid-area: lvl; min-width: 0; font: 12px/16px var(--sp-text); white-space: normal; overflow-wrap: anywhere; }"],
  [".sp-root .sp-n-sub { grid-area: sub; min-width: 0; font: 12px/16px var(--sp-text); color: var(--sp-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }", ".sp-root .sp-n-sub { grid-area: sub; min-width: 0; font: 12px/16px var(--sp-text); color: var(--sp-ink-2); white-space: normal; overflow-wrap: anywhere; }"],
  [".sp-root .sp-n-dist { grid-area: dist; font: 12px/16px var(--sp-text); font-variant-numeric: tabular-nums; color: var(--sp-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }", ".sp-root .sp-n-dist { grid-area: dist; font: 12px/16px var(--sp-text); font-variant-numeric: tabular-nums; color: var(--sp-ink-2); white-space: normal; overflow-wrap: anywhere; }"],
  [".sp-root .sp-plate-h { margin: 0; font: 14px/20px var(--sp-text); color: var(--sp-ink); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }", ".sp-root .sp-plate-h { margin: 0; font: 14px/20px var(--sp-text); color: var(--sp-ink); }"],
  [".sp-root .sp-rl-n { overflow: hidden; text-overflow: ellipsis; min-width: 0; }", ".sp-root .sp-rl-n { min-width: 0; }"],
];
const fixWith = (src, list, label) => { if (src == null) return src; let out = src; for (const [a, b] of list) { const n = out.split(a).length - 1; if (n !== 1) throw new Error(`${label} fix: expected 1 match, found ${n}: ${a.slice(0, 60)}`); out = out.replace(a, () => b); } return out; };
// MacReel (2.0.5, Mac 10/30 08:40 PT; MacArthur's spec A-C): counted replacements on a copy of reel.js
//  - touching or dragging the chart no longer pauses the replay ("scrolling while the replay is showing stops it anyways");
//  - scrolling the reel off screen no longer pauses it: its clock keeps running and it draws again when it is back in view; leaving the app
//    stops the frames (no rAF in the background) and the replay goes on from where it was;
//  - a rebuild of the same trade while it plays (new journal rows, the broker's fill) keeps playing from the same moment;
//  - Play fits the whole replay window into the chart (the same span the reel opens with);
//  - the line under the controls says how to stop it.
const RL_FIX_JS = [
  ["          D.chart.addEventListener('pointerdown', () => pause('touch'), { passive: true });\n", ''],
  ['<p class="rl-rate">1× = one trade minute per second. Touch the chart to pause.</p>', '<p class="rl-rate">1× = one trade minute per second. Pause stops it; × Exit on the chart goes back to live.</p>'],
  ['      render();\n      if (S.playing && S.visible) S.raf = W.requestAnimationFrame(loop); else S.last = 0;', '      if (S.visible) render(); else S.dirty = true;\n      if (S.playing) S.raf = W.requestAnimationFrame(loop); else S.last = 0;'],
  ['const kick = () => { if (!S.raf && S.visible && !(doc.hidden)) S.raf = W.requestAnimationFrame(loop); };', 'const kick = () => { if (!S.raf && (S.visible || S.playing) && !(doc.hidden)) S.raf = W.requestAnimationFrame(loop); };'],
  ['const onVis = () => { if (doc.hidden) { pause(); if (S.raf) { W.cancelAnimationFrame(S.raf); S.raf = 0; } } else kick(); };', 'const onVis = () => { if (doc.hidden) { if (S.raf) { W.cancelAnimationFrame(S.raf); S.raf = 0; } S.last = 0; } else kick(); };'],
  ['S.visible = x.isIntersecting; if (!S.visible) { pause(); if (S.raf) { W.cancelAnimationFrame(S.raf); S.raf = 0; } } else kick();', 'S.visible = x.isIntersecting; if (S.visible) kick();'],
  ['      S.key = key; S.T = T; S.L = g && g.levels; pause();', '      const keep = S.playing && S.T && T && S.T.key === T.key ? S.cur : null;\n      S.key = key; S.T = T; S.L = g && g.levels; pause();'],
  ['      build(S.m); if (ro && D.wrap) { ro.disconnect(); ro.observe(D.wrap); }', '      build(S.m); if (ro && D.wrap) { ro.disconnect(); ro.observe(D.wrap); }\n      if (keep != null && S.m && S.m.ok) { S.cur = Math.max(S.m.a, Math.min(S.m.b, keep)); play(); }'],
  ["      S.playing = true; S.last = 0; playLabel(); say('Playing from ' + hms(S.cur) + ' PT.'); kick();", "      if (S.chart) S.chart.setView(m.a, m.b + 2 * M5);\n      S.playing = true; S.last = 0; playLabel(); say('Playing from ' + hms(S.cur) + ' PT.'); kick();"],
];
const RL0 = fixWith(MOD('reel/reel.js', 'reel'), R211 ? RL_FIX_JS.concat(require('./fixes-211.cjs').RL_FIX_JS_211) : R207 ? RL_FIX_JS.concat(F7.RL_FIX_JS_207) : RL_FIX_JS, 'reel.js');
const RL = ((x) => R209 ? fixWith(x, F9.RL_FIX_JS_209.concat(R2091 ? F91.RL_FIX_JS_2091.concat(R2093 ? F93.RL_FIX_JS_2093.concat(R2094 ? F94.RL_FIX_JS_2094 : []) : []) : []), 'reel.js (2.0.9)') : x)(R207 && RN === 'labelled' ? fixWith(RL0, F7.RL_LABELLED_207, 'reel.js (2.0.7 labelled)') : RL0), RLG = MOD('reel/reel-grade.js', 'reelgrade')   /* 2.0.2 (Mac: "All grade related stuff needs to be removed"): the reel's hindsight-grade end card is opt-in, off by default; the reel works without it */, RLCSS = MOD('reel/reel.css', 'reel');
// Reactor (MacReactor, done): one MacUI fix by counted replacement, per MacArthur's perf caveat "render only while Control is visible".
// The page coming back to the foreground set the loop visible from document.visibilityState alone, so with another tab open (the hero
// display:none, IntersectionObserver false) the Reactor woke and drew at its ambient rate off screen. Now foreground AND in view.
const RX_FIX_JS = [
  // r13.3.4 HTF levels (MacArthur 10/30): quarter and month levels draw on past frames like PWH / PWL, while the frame is in the same
  // quarter / month as the snapshot (by the CME trading day, which starts 15:00 PT). QO / CMO and the previous-period PQH / PQL / PMH / PML /
  // PMO are fixed for the whole period; QH / QL / CMH / CML are the period's running extremes (drawn the same way, as asked).
  ['  function levelValidAt(name, t, snapT) {', "  var HTF_Q = /^(QO|PQH|PQL|QH|QL)$/, HTF_M = /^(CMO|PMH|PML|PMO|CMH|CML)$/, tdF = null;\n  function tradeYM(t) { try { if (!tdF) tdF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric' }); var p = tdF.formatToParts(new Date(sessStart(t) + 12 * 3600000)), y = 0, m = 0; p.forEach(function (x) { if (x.type === 'year') y = +x.value; if (x.type === 'month') m = +x.value; }); return { y: y, m: m }; } catch (e) { var dd = new Date(t); return { y: dd.getUTCFullYear(), m: dd.getUTCMonth() + 1 }; } }\n  function samePeriod(name, t, snapT) { var a = tradeYM(t), b = tradeYM(snapT); if (a.y !== b.y) return false; return HTF_M.test(name) ? a.m === b.m : Math.floor((a.m - 1) / 3) === Math.floor((b.m - 1) / 3); }\n  function levelValidAt(name, t, snapT) {"],
  ["    if (!sameSess(t, snapT)) return /^(PWH|PWL|Week Open|PWO)$/.test(name) && Math.abs(t - snapT) < 6 * 3600000;", "    if (!sameSess(t, snapT)) return (/^(PWH|PWL|Week Open|PWO)$/.test(name) || ((HTF_Q.test(name) || HTF_M.test(name)) && samePeriod(name, t, snapT))) && Math.abs(t - snapT) < 6 * 3600000;"],
  ["      case 'PDH': case 'PDL': case 'PDC': case 'Daily Open': case '15:00 Open': case 'PWH': case 'PWL': case 'PWO': case 'Week Open': return true;", "      case 'PDH': case 'PDL': case 'PDC': case 'Daily Open': case '15:00 Open': case 'PWH': case 'PWL': case 'PWO': case 'Week Open': return true;\n      case 'QO': case 'PQH': case 'PQL': case 'QH': case 'QL': case 'CMO': case 'PMH': case 'PML': case 'PMO': case 'CMH': case 'CML': return samePeriod(name, t, snapT);"],
  ["var v = es[es.length - 1].isIntersecting; setVisible(v && doc.visibilityState !== 'hidden');", "var v = es[es.length - 1].isIntersecting; S.inView = v; setVisible(v && doc.visibilityState !== 'hidden');"],
  ["function onVis() { setVisible(doc.visibilityState !== 'hidden'); }", "function onVis() { setVisible(doc.visibilityState !== 'hidden' && S.inView !== false); }"],
];
const RX_RAW = MOD('concepts/reactor/reactor.js', 'reactor'), RXCSS = MOD('concepts/reactor/reactor.css', 'reactor');
const RX = fixWith(RX_RAW, RX_FIX_JS, 'reactor.js');
// MacCharts (done): filled up-candles, as Mac knew them and as drop 1.1 restored on the bot's own SVG chart (one candle language on every chart:
// Levels, Now, the reel). The chart key says so. Counted replacements on a copy; the vendored library itself is untouched (verify-vendor).
const CH_FIX_JS = [
  // r13.3.4 HTF level names (MacArthur 10/30): quarter / month opens style as opens, the previous quarter as prior, the running quarter /
  // month extremes as ranges (the month's PMH / PML / PMO already matched P[DWM][HLCO])
  ["    if (/\\bopen$/i.test(n)) return 'opens';", "    if (/\\bopen$/i.test(n) || /^(QO|CMO)$/.test(n)) return 'opens';"],
  ["    if (/^P[DWM][HLCO]$/.test(n)) return 'prior';", "    if (/^P[DWMQ][HLCO]$/.test(n)) return 'prior';\n    if (/^(QH|QL|CMH|CML)$/.test(n)) return 'range';"],
  ["prior: 'Prior day / week'", "prior: 'Prior day / week / month / quarter'"],
  ["upColor: 'rgba(0,0,0,0)', borderUpColor: C.bull,", "upColor: C.bull, borderUpColor: C.bull,"],
  ["this.candle.applyOptions({ borderUpColor: C.bull, wickUpColor: C.bull, downColor: C.bear,", "this.candle.applyOptions({ upColor: C.bull, borderUpColor: C.bull, wickUpColor: C.bull, downColor: C.bear,"],
  ["color: up ? 'rgba(0,0,0,0)' : C.formDn,", "color: up ? C.formUp : C.formDn,"],
  ["[box('none', 'var(--bull)'), 'Up candle: hollow']", "[box('var(--bull)', 'var(--bull)'), 'Up candle: filled']"],
  // 2.0.5 (Mac 10/30 08:40 PT: "it should always show the latest bar during replay and live mode"; MacArthur's spec A-E):
  //  - an Exit (×) on the plot while a replay is active (playing, paused or at its end): stops it and returns to the live view, latest bar;
  //  - a replay fits its whole window [10 min before the fill, the close] + 10 min of room into the plot at the current width (setView), and
  //    keeps it fitted frame by frame (Lightweight Charts drifts the view as the tail bar is popped / re-added, and a chart sized after the
  //    fit loses it); after a person's own drag / pinch / wheel the view is theirs while the newest bar stays in the plot, and the next frame
  //    re-fits when it does not;
  //  - scrolling the chart off screen no longer pauses a replay (only Pause, the scrub bar or Exit stop it);
  //  - live: every refresh (update) brings the latest bar back into view when it is off the plot (a pan back lasts until the next poll).
  ['<button type="button" class="mc-btn mc-latest" data-act="latest" hidden>Latest bar</button></div>', '<button type="button" class="mc-btn mc-latest" data-act="latest" hidden>Latest bar</button><button type="button" class="mc-btn mc-exit" data-act="exit" hidden aria-label="Exit the replay and go back to live">× Exit</button></div>'],
  ["latest: q('[data-act=\"latest\"]'),", "latest: q('[data-act=\"latest\"]'), exit: q('[data-act=\"exit\"]'),"],
  ["      else if (a === 'latest') { this.chart.timeScale().scrollToRealTime(); }", "      else if (a === 'latest') { this.chart.timeScale().scrollToRealTime(); }\n      else if (a === 'exit') { this.stopReplay(); this.snapLatest(); }"],
  ['      const now = performance.now(); if (now - (this.gestureAt[type] || -1e9) < 80) return; this.gestureAt[type] = now;', "      if (type === 'pointer' || type === 'wheel' || type === 'key') this.userMoved = true;\n      const now = performance.now(); if (now - (this.gestureAt[type] || -1e9) < 80) return; this.gestureAt[type] = now;"],
  ["      this.d.play.textContent = t; this.d.rp.textContent = R && R.playing ? 'Pause replay' : 'Replay';", "      this.d.play.textContent = t; this.d.rp.textContent = R && R.playing ? 'Pause replay' : 'Replay';\n      if (this.d.exit) { const on = !!R; if (this.d.exit.hidden === on) this.d.exit.hidden = !on; }"],
  ['this.visible = e.isIntersecting; if (this.visible) this.resumeWork(); else this.pauseWork();', 'this.visible = e.isIntersecting; if (this.visible) this.resumeWork();'],
  ['      if (document.hidden || !this.visible) R.pausedByHide = true; else R.raf = requestAnimationFrame(this._tick);', '      if (document.hidden) R.pausedByHide = true; else R.raf = requestAnimationFrame(this._tick);'],
  ['      this.playLabel(); this.setCut(R.a + (R.b - R.a) * R.f);\n      return this;', '      this.playLabel(); this.setCut(R.a + (R.b - R.a) * R.f); this.setView(R.a, R.b + 2 * FIVE);\n      return this;'],
  ['      if (this.reduced()) { R.playing = false; this.stepBar(restart); return this; }', '      if (this.reduced()) { R.playing = false; this.stepBar(restart); this.setView(R.a, R.b + 2 * FIVE); return this; }'],
  // (setView keeps at least the last 3 drawn bars in the frame: at the start of a replay the cursor has drawn nothing of the window yet, and
  //  Lightweight Charts refuses a range with no bar in it)
  ['      const i0 = this.idxAt(from), i1 = this.idxAt(to); if (i0 == null || i1 == null) return;', '      const i1 = this.idxAt(to), i0 = Math.min(this.idxAt(from), this.bars.length - 3); if (i0 == null || i1 == null) return;'],
  ['    setView(from, to) {\n      if (!this.bars.length || !fin(from) || !fin(to) || to <= from) return;', '    setView(from, to) {\n      if (fin(from) && fin(to) && to > from) { this.viewSpan = [from, to]; this.userMoved = false; }\n      if (!this.bars.length || !fin(from) || !fin(to) || to <= from) return;'],
  ['      this.apply(scene(this.data, this.kind, { cut }));\n      this.d.scrub.value', '      this.apply(scene(this.data, this.kind, { cut })); if (cut != null) this.followView();\n      this.d.scrub.value'],
  ["      this.replayState = null; this.chart.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: this.kind !== 'replay' } });", "      this.replayState = null; this.viewSpan = null; this.chart.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: this.kind !== 'replay' } });"],
  ['      return this.apply(scene(data, this.kind, { cut }));', '      this.apply(scene(data, this.kind, { cut })); if (!this.replayState) this.keepLatest();\n      return this;'],
  ['    cursor() { return this.replayState ? this.replayState.cut : null; }', `    cursor() { return this.replayState ? this.replayState.cut : null; }
    // 2.0.5: is the newest drawn bar inside the plot (its centre within the visible logical range)?
    lastInView() { const n = this.bars.length; if (!n) return true; const r = this.chart.timeScale().getVisibleLogicalRange(); return !!r && n - 1 >= r.from + 0.3 && n - 1 <= r.to - 0.3; }
    // is the whole replay window (the bars from its start to its end) inside the plot?
    spanInView() { const vs = this.viewSpan, r = this.chart.timeScale().getVisibleLogicalRange(); if (!vs || !r || !this.bars.length) return true; const i0 = this.idxAt(vs[0]), i1 = this.idxAt(vs[1]); return i0 == null || i1 == null || (r.from <= i0 + 0.01 && r.to >= i1 - 0.51); }
    // a replay frame: keep the window fitted; after a person's own drag, only bring the newest bar back when it left the plot
    followView() { if (!this.viewSpan || !this.replayState) return; if (this.userMoved ? !this.lastInView() : !this.spanInView()) this.setView(this.viewSpan[0], this.viewSpan[1]); }
    // live: every refresh shows the latest bar (a pan into history lasts until the next poll); immediate, the user's zoom kept
    snapLatest() { const ts = this.chart.timeScale(); ts.scrollToPosition(ts.options().rightOffset, false); }
    keepLatest() { if (this.bars.length && !this.lastInView()) this.snapLatest(); }`],
];
const SP = fixWith(MOD('signal-path/signal-path.js', 'sp'), R210 ? SP_FIX_JS.concat(require('./fixes-210.cjs').SP_TRUTH_JS) : R2094 ? SP_FIX_JS.concat(F94.SP_FIX_JS_2094) : SP_FIX_JS, 'signal-path.js'), SPCSS = fixWith(MOD('signal-path/signal-path.css', 'sp'), SP_FIX_CSS, 'signal-path.css'), CH = fixWith(MOD('charts/maccharts.js', 'charts'), R211 ? CH_FIX_JS.concat(require('./fixes-211.cjs').CH_FIX_JS_211) : R207 ? CH_FIX_JS.concat(F7.CH_FIX_JS_207, R209 ? F9.CH_FIX_JS_209.concat(R2093 ? F93.CH_FIX_JS_2093.concat(R2094 ? F94.CH_FIX_JS_2094.concat(R2095 ? F95.CH_FIX_JS_2095.concat(R2099 ? F99.CH_FIX_JS_2099 : []) : []) : []) : []) : []) : CH_FIX_JS, 'maccharts.js'), CHN = MOD('charts/NOTICE', 'charts');
const CHLIB = MOD('charts/lwc-inline.html', 'charts'),   // MacCharts' delimited block: one <script> carrying the vendoring header (sha256 e21cc5ca...), unedited
     CHRAW = MOD('charts/vendor/lightweight-charts.standalone.production.js', 'charts'), CHCSS = MOD('charts/maccharts.css', 'charts'), CHGLUE = MOD('charts/integrate-charts.js', 'charts');
if (CH && !CHLIB) throw new Error('MacCharts needs its vendored Lightweight Charts block (charts/lwc-inline.html)');
if (CHLIB && CHRAW && !CHLIB.includes(CHRAW.trimEnd().slice(-2000))) throw new Error('lwc-inline.html does not carry the vendored library text');
if (RLCSS) { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacReel: reel.css (inlined, unedited) */\n' + RLCSS + '\n' + h.slice(i); }
if (RL) rep('<div id="lv-trade-body"><div class="empty-state">Flat.</div></div>', '<div id="rl-slot" class="rl-slot" hidden></div>\n      <div id="lv-trade-body"><div class="empty-state">Flat.</div></div>', 'rl-slot');
// ── 2.1.0 MacScope (MACUI_MODULES=...,scope): MacEng's Sweep Scope, MacSignal's Gate Scope and Flight Card, as delivered (one JS + one CSS each,
//    under macui/concepts/<name>/), mounted by MacUI's v2src/scope.js at the top of the Levels tab. A part that is not delivered is left out. ──
// 2.1.1 (MacDot #5 6548653893): MacSignal's shared fill rule, concepts/fillreceipt/fillreceipt.js (window.MacFillReceipt), inlined first so the
// scopes and MacUI's page code all call the one rule
const SCOPE_PARTS = (R211 ? [['fillreceipt', ['concepts/fillreceipt/fillreceipt']]] : []).concat([['sweepscope', ['concepts/sweepscope/sweepscope']], ['gatescope', ['concepts/gatescope/gatescope']], ['flightcard', ['concepts/flightcard/flightcard', 'concepts/gatescope/flightcard']]]);
const SCOPE_JS = [], SCOPE_CSS = [];
// (MACUI_SCOPE_DIR: a folder standing in for macui/ when looking for the parts; the harness's wiring test uses stand-in parts this way)
const SCOPE_DIR = process.env.MACUI_SCOPE_DIR ? path.resolve(process.env.MACUI_SCOPE_DIR) : path.resolve(H, '..');
const SMOD = rel => { const p = path.join(SCOPE_DIR, rel); return fs.existsSync(p) ? readIn(p) : null; };
if (R210 && WANT.includes('scope')) for (const [name, bases] of SCOPE_PARTS) { const b = bases.find(x => fs.existsSync(path.join(SCOPE_DIR, x + '.js'))); if (!b) continue;
  SCOPE_JS.push([b + '.js', SMOD(b + '.js')]); const c = SMOD(b + '.css'); if (c) SCOPE_CSS.push([b + '.css', c]); }
if (R210) { const i = h.indexOf('</style>'); h = h.slice(0, i) + SCOPE_CSS.map(([n, t]) => '\n/* ' + n + ' (unedited) */\n' + t).join('') + '\n/* MacUI 2.1.0: v2src/scope.css */\n' + V('scope.css') + '\n' + (R211 ? '/* MacUI 2.1.1: v2src/r211.css */\n' + V('r211.css') + '\n' : '') + h.slice(i); }
if (R210) rep('  <div id="view-levels" style="display:none">\n', '  <div id="view-levels" style="display:none">\n' + fixWith(V('scope.html'), R211 ? [['Terminal 2.1.0 · build', 'Terminal 2.1.1 · build']] : [], 'scope.html'), 'scope-root');
if (R210) rep('      <div class="card-title">About and credits</div>\n', '      <div class="card-title">About and credits</div>\n      <p class="credits build-id" id="build-id">Terminal ' + REL + ' · build <span class="num">__MACUI_BUILD_ID__</span></p>\n', 'build-id');
if (RXCSS) { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacReactor: reactor.css (inlined, unedited) */\n' + RXCSS + '\n' + h.slice(i); }
if (CHCSS) { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacCharts: maccharts.css (inlined, unedited) */\n' + CHCSS + '\n' + h.slice(i); }
// 2.0.7: MacSignal's shared fill rule, read here so it is an input (inlined unedited as the first script after the bot's, below)
const FR = R207 ? readIn(path.resolve(H, '..', 'concepts/fillreceipt/fillreceipt.js')) : null;
if (SPCSS) { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacSignal: signal-path.css + MacUI display fixes (build-v2.cjs SP_FIX_CSS) */\n' + SPCSS + '\n' + h.slice(i); }
if (CHN) rep('      <!--MACUI:CHART_NOTICE-->\n', '      <p class="credits"><b>Lightweight Charts NOTICE:</b></p><pre class="credits">' + CHN.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>\n', 'chart-notice');
else rep('      <!--MACUI:CHART_NOTICE-->\n', '', 'chart-notice');
if (R207) { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.7: v2src/r207.css */\n' + V('r207.css') + '\n' + (R208 ? '/* MacUI 2.0.8: v2src/r208.css */\n' + V('r208.css') + '\n' + (R209 ? '/* MacUI 2.0.9: v2src/r209.css */\n' + V('r209.css') + '\n' + (R2091 ? '/* MacUI 2.0.9.1: v2src/r2091.css */\n' + V('r2091.css') + '\n' + (R2092 ? '/* MacUI 2.0.9.2: v2src/r2092.css */\n' + V('r2092.css') + '\n' + (R2093 ? '/* MacUI 2.0.9.3: v2src/r2093.css */\n' + V('r2093.css') + (R2095 ? '\n/* MacUI 2.0.9.5: v2src/r2095.css */\n' + V('r2095.css') : '') + '\n' : '') : '') : '') : '') : '') + h.slice(i); }   // 2.0.7: last, so its rules win ties
rep('</script>\n</body>', '</script>\n' + (FR ? '<script>\n/* concepts/fillreceipt/fillreceipt.js (unedited) */\n' + FR.trimEnd() + '\n</script>\n' : '') + '<script>\n' + (R207 ? fixWith(V('shell.js'), F7.SHELL_FIX_JS_207.concat(R2093 ? F93.SHELL_FIX_JS_2093.concat(R2094 ? F94.SHELL_FIX_JS_2094.concat(R2099 ? F99.SHELL_FIX_JS_2099.concat(R20910 ? F910.SHELL_FIX_JS_20910 : []) : []) : []) : []), 'shell.js') : R210 ? fixWith(V('shell.js'), R211 ? require('./fixes-210.cjs').SHELL_FIX_JS.concat(require('./fixes-211.cjs').SHELL_FIX_JS_211) : require('./fixes-210.cjs').SHELL_FIX_JS, 'shell.js') : V('shell.js')).trimEnd() + '\n' + (R211 ? fixWith(V('results.js'), require('./fixes-211.cjs').RES_FIX_JS_211, 'results.js') : R207 ? fixWith(fixWith(V('results.js'), F7.RES_FIX_JS_207, 'results.js'), R208 ? F8.RES_FIX_JS_208.concat(R209 ? F9.RES_FIX_JS_209.concat(R2091 ? F91.RES_FIX_JS_2091 : [], R2092 ? F92.RES_FIX_JS_2092 : [], R2093 ? F93.RES_FIX_JS_2093.concat(R2094 ? F94.RES_FIX_JS_2094.concat(R2095 ? F95.RES_FIX_JS_2095 : []) : []) : []) : []) : [], 'results.js (2.0.8 / 2.0.9)') : V('results.js')).trimEnd() + '\n' + V('d11.js').trimEnd() + (TAPE ? '\n' + V('tape.js').trimEnd() : '') + (LMAP ? '\n' + V('levelmap.js').trimEnd() : '') + (RADAR ? '\n' + V('radarbg.js').trimEnd() : '') + (CLPATH ? '\n' + (R210 ? fixWith(V('clpath.js'), require('./fixes-210.cjs').CLPATH_FIX_JS, 'clpath.js') : V('clpath.js')).trimEnd() : '') + '\n</script>\n'
  + (SP ? '<script>\n/* MacSignal: signal-path.js + MacUI display fixes (build-v2.cjs SP_FIX_JS) */\n' + SP.trimEnd() + '\n</script>\n' : '')
  + (RX ? '<script>\n/* MacReactor: reactor.js + MacUI fixes (build-v2.cjs RX_FIX_JS: sleep off Control after the app returns to the foreground; r13.3.4 quarter / month levels on past frames); needs SignalPath.model */\n' + RX.trimEnd() + '\n</script>\n' : '')
  + (CH ? CHLIB.trimEnd() + '\n<script>\n/* MacCharts: maccharts.js + MacUI fixes (build-v2.cjs CH_FIX_JS: filled up-candles; r13.3.4 level families) */\n' + CH.trimEnd() + '\n</script>\n' + (CHGLUE ? '<script>\n/* MacCharts: integrate-charts.js (' + (R20910 ? 'with the 2.0.9.10 counted fix of fixes-20910.cjs: a shorter open-trade chart under 700 px tall' : 'unedited') + '; mounts the charts beside the bot\'s chart bodies) */\n' + (R20910 ? fixWith(CHGLUE, F910.GLUE_FIX_JS_20910, 'integrate-charts.js') : CHGLUE).trimEnd() + '\n</script>\n' : '')
    + (RL ? '<script>\n/* MacReel: reel.js (unedited; draws on MacCharts) */\n' + RL.trimEnd() + '\n</script>\n' + (RLG ? '<script>\n/* MacReel: reel-grade.js (unedited) */\n' + RLG.trimEnd() + '\n</script>\n' : '') : '') : '')
  + '<script>\n' + (R207 ? fixWith(V('integrate.js'), F7.INT_FIX_JS_207.concat(R209 ? F9.INT_FIX_JS_209.concat(R2091 ? F91.INT_FIX_JS_2091.concat(R2093 ? F93.INT_FIX_JS_2093.concat(R20910 ? F910.INT_FIX_JS_20910 : []) : []) : []) : []), 'integrate.js') : R210 ? fixWith(V('integrate.js'), R211 ? require('./fixes-211.cjs').INT_FIX_JS_211 : process.env.MACUI_VARIANT === 'chart-first' ? require('./fixes-210.cjs').INT_FIX_JS_CHART_FIRST : require('./fixes-210.cjs').INT_FIX_JS, 'integrate.js') : V('integrate.js')).trimEnd() + '\n</script>\n'
  + (R210 ? SCOPE_JS.map(([n, t]) => '<script>\n/* ' + n + ' (unedited) */\n' + t.trimEnd() + '\n</script>\n').join('') + '<script>\n' + V('scope.js').trimEnd() + '\n</script>\n' : '') + '</body>', 'shell');
// 2.0.9.6: the Review tab (markup only; the bot's main script block is unchanged and checked below)
if (R2096) {
  rep(`    <div class="card">
      <div class="card-title">Trade Stats &middot; All-Time</div>
      <div id="journal-stats-alltime-body"><div class="empty-state">Loading&hellip;</div></div>
    </div>`, `    <div class="card rc-card" id="combine-card"><div id="combine-body"><div class="card-title">Combine</div><div class="empty-state">Loading&hellip;</div></div></div>
    <div class="card rc-card" id="thisbot-card"><div id="thisbot-body"><div class="card-title">This bot</div><div class="empty-state">Loading&hellip;</div></div></div>
    <div id="journal-stats-alltime-body" hidden aria-hidden="true"></div>`, 'review-cards markup');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.6: v2src/r2096.css */\n' + V('r2096.css') + '\n' + h.slice(i); }
  rep('</body>', '<script>\n/* MacUI ' + (R2097 ? '2.0.9.7: v2src/review-cards-2097.js' : '2.0.9.6: v2src/review-cards-2096.js') + ' */\n' + V(R2097 ? 'review-cards-2097.js' : 'review-cards-2096.js').trimEnd() + '\n</script>\n</body>', 'review-cards script');
}
// 2.0.9.7: the Robot Brain (one script after reactor.js, before integrate.js; one stylesheet)
if (R2097) {
  const mark = '/* MacReactor: reactor.js + MacUI fixes', a = h.indexOf(mark); if (a < 0 || h.indexOf(mark, a + 1) >= 0) throw new Error('brain: the reactor.js script is not unique');
  const end = h.indexOf('</script>\n', a) + '</script>\n'.length, integ = h.indexOf('// ══ MacUI v2.1 integration glue'); if (!(end > a && integ > end)) throw new Error('brain: reactor.js must come before integrate.js');
  const BVIEW = (process.env.MACUI_BRAIN || 'bv') === 'bv';   /* MacArthur 19:40Z: MacReactor's BrainView PART 1 (byte-identical) + the live wrapper; MACUI_BRAIN=own: MacUI-2's SVG view (the fallback) */
  if (R2098 && !BVIEW) throw new Error('2.0.9.8 ships MacReactor\'s BrainView: MACUI_BRAIN=bv');
  h = h.slice(0, end) + '<script>\n/* MacUI ' + (R20910 ? '2.0.9.10' : R2099 ? '2.0.9.9' : R2098 ? '2.0.9.8' : '2.0.9.7') + ': ' + (R2098 ? 'v2src/brainview-part1-2098.js (MacReactor reactor/tools/src/brain.js PART 1 + the 2.0.9.8 opt-in patch) + v2src/brain-adapter-2098.js + v2src/brain-bv-' + (R2099 ? '2099' : '2098') + '.js' + (R20910 ? ' (both with the 2.0.9.10 counted fixes of fixes-20910.cjs)' : '') : BVIEW ? 'v2src/brainview-part1-2097.js (MacReactor reactor/tools/src/brain.js PART 1, byte-identical) + v2src/brain-adapter-2097.js + v2src/brain-bv-2097.js' : 'v2src/brain-adapter-2097.js + v2src/brain-view-2097.js') + ' (the Robot Brain; window.Reactor\'s mount contract) */\n' + (R2098 ? V('brainview-part1-2098.js').trimEnd() + '\n' + (R20910 ? fixWith(V('brain-adapter-2098.js'), F910.ADAPTER_FIX_JS_20910, 'brain-adapter-2098.js (2.0.9.10)') : V('brain-adapter-2098.js')).trimEnd() + '\n' + (R20910 ? fixWith(V('brain-bv-2099.js'), F910.BV_FIX_JS_20910, 'brain-bv-2099.js (2.0.9.10)') : V(R2099 ? 'brain-bv-2099.js' : 'brain-bv-2098.js')).trimEnd() : (BVIEW ? V('brainview-part1-2097.js').trimEnd() + '\n' : '') + V('brain-adapter-2097.js').trimEnd() + '\n' + V(BVIEW ? 'brain-bv-2097.js' : 'brain-view-2097.js').trimEnd()) + '\n</script>\n' + h.slice(end);
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.7: v2src/brain-2097.css */\n' + V('brain-2097.css') + '\n' + h.slice(i); }
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.7: v2src/r2097.css (the 2.0.9.6 review fixes) */\n' + V('r2097.css') + '\n' + h.slice(i); }
  rep('<section id="hero-root" class="hero-root" aria-label="Level reactor" hidden></section>', '<section id="hero-root" class="hero-root" aria-label="Robot brain" hidden></section>', 'hero label');
}
// 2.0.9.9: Mac's four approved fixes (P&L scope at the number, one live-truth signal, shorter long lists, reach at 375x667): one script last, one stylesheet
if (R2099) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.9: v2src/fixes-2099.js */\n' + V('fixes-2099.js').trimEnd() + '\n</script>\n</body>', 'fixes-2099 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.9: v2src/r2099.css */\n' + V('r2099.css') + '\n' + h.slice(i); }
}
// 2.0.9.10: Mac's fixes, stage 2 ((c) shorter long tabs, (b) one live-truth signal, S3): one script last, one stylesheet last
if (R20910) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.10: v2src/fixes-20910.js */\n' + V('fixes-20910.js').trimEnd() + '\n</script>\n</body>', 'fixes-20910 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.10: v2src/r20910.css */\n' + V('r20910.css') + '\n' + h.slice(i); }
}
// 2.0.9.11: Mac's five trader-benefit features (display only): one script last, one stylesheet last
if (R20911) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.11: v2src/feat-20911.js */\n' + V('feat-20911.js').trimEnd() + '\n</script>\n</body>', 'feat-20911 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.11: v2src/r20911.css */\n' + V('r20911.css') + '\n' + h.slice(i); }
}
// 2.0.9.12: the Trades tab's UNKNOWNs (Mac, Nov 2), from the broker round trip the bot reconciled: one script last, one stylesheet last
if (R20912) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.12: v2src/fix-20912.js */\n' + V('fix-20912.js').trimEnd() + '\n</script>\n</body>', 'fix-20912 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.12: v2src/r20912.css */\n' + V('r20912.css') + '\n' + h.slice(i); }
}
if (R20913) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.13: v2src/feat-20913.js */\n' + V('feat-20913.js').trimEnd() + '\n</script>\n</body>', 'feat-20913 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.13: v2src/r20913.css */\n' + V('r20913.css') + '\n' + h.slice(i); }
}
if (R20916) {
  // Signal Path (clpath.js as built), checklist parity (Mac 11/03 "in the event we are not in the trades we know why"):
  // (a) the side from r13.3.5's own wording "the SHORT disagrees" (it read 'HTF not aligned' on a fully aligned bullish HTF)
  rep("t.match(/the (LONG|SHORT) is against/); return m", "t.match(/the (LONG|SHORT) is against/) || t.match(/the (LONG|SHORT) disagrees/); return m", 'clpath dirOf disagrees');
  // (b) no side known: the bot's own detail, never the made-up 'HTF not aligned'
  rep(": a ${dir === 1 ? 'LONG' : 'SHORT'} is against it` : 'HTF not aligned';", ": a ${dir === 1 ? 'LONG' : 'SHORT'} is against it` : (first(r.detail) || 'HTF not aligned');", 'clpath align no-side');
  // (c) the bot's checks with no Signal Path node: biasAgreement under Control; reclaimWatch is information (pass null) like biasStrength
  rep("keys: ['controlGate'] },", "keys: ['controlGate', 'biasAgreement'] },", 'clpath control keys');
  rep("const INFO = new Set(['levelsSessionAnchor', 'directionGate', 'biasStrength', 'chopSkip']);", "const INFO = new Set(['levelsSessionAnchor', 'directionGate', 'biasStrength', 'chopSkip', 'reclaimWatch']);", 'clpath info keys');
  // (d) live values on every node, also when the node is not needed yet: control score vs its line, each HTF open vs price, the size rule
  rep("    if (state === 'na') return 'Not needed right now';\n    if (node.id === 'control') { const c = controlRead(d, rows); if (c) return `${c.side} ${sg(c.score)}${c.line != null ? ` · line ±${c.line.toFixed(2)}` : ''}`; }\n    if (node.id === 'align') { const sl = slots((rows[0] || {}).detail) .length ? slots((rows[0] || {}).detail) : slots((rows[0] || {}).label); if (sl.length) return sl.map(s => `${s.tf} ${s.up ? '↑' : '↓'}`).join('  '); }",
    "    const naT = state === 'na' ? ' · not needed yet' : '';   // 2.0.9.16: the live value shows also before a trigger\n    if (node.id === 'control') { const c = controlRead(d, rows); if (c) return `control ${sg(c.score)} / line ${c.line != null ? c.line.toFixed(2) : '?'} · ${c.side.toLowerCase()}${naT}`; }\n    if (node.id === 'align') { const sl = slots((rows[0] || {}).detail) .length ? slots((rows[0] || {}).detail) : slots((rows[0] || {}).label); const lp = d && d.livePx && fin(d.livePx.price) ? d.livePx.price : null; if (sl.length) return sl.map(s => `${s.tf} ${s.up ? '↑' : '↓'} open ${s.open}`).join(' · ') + (lp != null ? ` · price ${px(lp)}` : '') + naT; }\n    if (node.id === 'size') { const z = rows.find(x => x.key === 'riskCap'); if (z && z.detail) { let cap = ''; try { const o = d && d.configLocal && Array.isArray(d.configLocal.overrides) ? d.configLocal.overrides.filter(x => x && x.key === 'levelStopCapSizing').pop() : null; if (o) cap = ` · ${o.to} sizing`; } catch (e) { cap = ''; } return first(z.detail) + cap; } }\n    if (state === 'na') return 'Not needed right now';", 'clpath statusOf live values');
  rep('</body>', '<script>\n/* MacUI 2.0.9.16: v2src/feat-20916.js */\n' + V('feat-20916.js').trimEnd() + '\n</script>\n</body>', 'feat-20916 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.16: v2src/r20916.css */\n' + V('r20916.css') + '\n' + h.slice(i); }
}
if (R20917) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.17: v2src/feat-20917.js */\n' + V('feat-20917.js').trimEnd() + '\n</script>\n</body>', 'feat-20917 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.17: v2src/r20917.css */\n' + V('r20917.css') + '\n' + h.slice(i); }
}
if (R20918) {
  rep('</body>', '<script>\n/* MacUI 2.0.9.18: v2src/feat-20918.js */\n' + V('feat-20918.js').trimEnd() + '\n</script>\n</body>', 'feat-20918 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.18: v2src/r20918.css */\n' + V('r20918.css') + '\n' + h.slice(i); }
}
if (R201992) rep('full detail; terminal 2.0.9.16)', 'full detail; terminal ' + (R20920 ? (R22 ? '2.0.9.22' : R21 ? '2.0.9.21' : '2.0.9.20') : '2.0.9.19.2') + ')', 'feat-20916 export header: the page\'s real version');   // Mac 11/04: the export said 2.0.9.16 on a 2.0.9.18 page
if (R20919) {
  rep("+ mk(o.stop, 'is-stop', 'STOP', px(o.stop)) + mk(o.entry, 'is-entry', 'ENTRY', px(o.entry))", "+ (fin(o.stop) && fin(o.entry) && Math.abs(+pos(o.stop) - +pos(o.entry)) < 16 ? mk(o.stop, 'is-stop is-be', 'STOP · ENTRY', px(o.stop)) : mk(o.stop, 'is-stop', 'STOP', px(o.stop)) + mk(o.entry, 'is-entry', 'ENTRY', px(o.entry)))", 'feat-20918 ruler at BE');
  rep('</body>', '<script>\n/* MacUI 2.0.9.19: v2src/feat-20919.js */\n' + V('feat-20919.js').trimEnd() + '\n</script>\n</body>', 'feat-20919 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.19: v2src/r20919.css */\n' + V('r20919.css') + '\n' + h.slice(i); }
}
if (R201992) {   // MacFacts 3c5fa8e9 (MacUICheck GREEN 11/04) (Nov 4): the closed-trade facts from the broker settlement (v2src/fix-macfacts.js 3f0c027f, unedited; r-macfacts.css)
  rep('</body>', '<script>\n/* MacFacts: v2src/fix-macfacts.js (unedited) */\n' + V('fix-macfacts.js').trimEnd() + '\n</script>\n</body>', 'fix-macfacts script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacFacts: v2src/r-macfacts.css */\n' + V('r-macfacts.css') + '\n' + h.slice(i); }
}
if (R20920) {   // MacJournal tidejournal-1 (diff a9a702f5 on cf3d288a; feat-tidejournal.js 48d92609, r-tidejournal.css 5222908b; unedited): placed exactly as its build.cjs places it, right after MacFacts
  { const hi = h.indexOf('</head>'), si = h.lastIndexOf('</style>', hi); h = h.slice(0, si) + V('r-tidejournal.css') + h.slice(si);
    const bi = h.lastIndexOf('</body>'); h = h.slice(0, bi) + '<script>\n/* MacJournal 2.0.9.20: v2src/feat-tidejournal.js */\n' + V('feat-tidejournal.js') + '</script>\n' + h.slice(bi); }
  // MacArthur 11/04: a TIDE fill never reads "Plan entry": the card passes kind:'fill' (feat-20920 tidePlan, the open tide.position) and MacCharts names
  // that line "Fill"; every other trade / plan (the old path's included) draws exactly as before
  rep('planWhat: T.planWhat || null, src', "planWhat: T.planWhat || null, kind: T.kind || null, src", 'MacCharts scene: carry kind');
  rep("text: T.plan ? 'Plan entry' :", "text: T.kind === 'fill' ? 'Fill' : T.plan ? 'Plan entry' :", 'MacCharts pill: a TIDE fill reads Fill');
  rep("U.pageVersion = '2.0.9.19.2';", "U.pageVersion = '" + (R22 ? '2.0.9.22' : R21 ? '2.0.9.21' : '2.0.9.20') + "';", 'the page version');
  rep('</body>', '<script>\n/* MacUI 2.0.9.20: v2src/feat-20920.js */\n' + V('feat-20920.js').trimEnd() + '\n</script>\n</body>', 'feat-20920 script');
  { const i = h.indexOf('</style>'); h = h.slice(0, i) + '\n/* MacUI 2.0.9.20: v2src/r20920.css */\n' + V('r20920.css') + '\n' + h.slice(i); }
}
if (RL && !CH) throw new Error('the reel needs MacCharts: MACUI_MODULES=charts,reel');
if (R207 && WANT.some(k => !['sp', 'charts', 'reactor', 'reel', 'radarbg', 'clpath'].includes(k))) throw new Error('2.0.7 is 2.0.6\'s module set: MACUI_MODULES=sp,charts,reactor,reel,radarbg,clpath');
if (WANT.includes('scope') && !R210) throw new Error('MacScope ships in 2.1.0: MACUI_RELEASE=2.1.0 MACUI_MODULES=...,scope');
if (RX && !SP) throw new Error('the Reactor needs Signal Path (SignalPath.model): MACUI_MODULES=sp,reactor');
console.log('modules:', JSON.stringify({ release: REL || '2.0.6', reelNumbers: RN || null, scope: SCOPE_JS.map(x => x[0]), tape: TAPE, levelMap: LMAP, radarbg: RADAR, clpath: CLPATH, reel: !!RL, reelGrade: !!RLG, reactor: !!RX, signalPath: !!SP, signalPathCss: !!SPCSS, charts: !!CH, chartsLib: !!CHLIB, chartsCss: !!CHCSS, chartsGlue: !!CHGLUE, chartNotice: !!CHN }));

// ── checks ──
if (mainScript(h) !== MAIN) throw new Error('the main script block changed');
if (R210) {
  // the build ID: sha256 over the input manifest (each input's path and sha256, sorted, plus the build settings); 8 hex characters on the page
  const settings = ['MACUI_BASE=' + (process.env.MACUI_BASE || ''), 'MACUI_MODULES=' + (process.env.MACUI_MODULES || ''), 'MACUI_RELEASE=' + REL].concat(process.env.MACUI_VARIANT ? ['MACUI_VARIANT=' + process.env.MACUI_VARIANT] : []);
  const manifest = settings.join('\n') + '\n' + [...INPUTS.keys()].sort().map(k => sha(INPUTS.get(k)) + '  ' + k).join('\n') + '\n';
  const id = sha(manifest).slice(0, 8), n = h.split('__MACUI_BUILD_ID__').length - 1;
  if (n < 1) throw new Error('build ID placeholder missing'); h = h.split('__MACUI_BUILD_ID__').join(id);
  fs.writeFileSync(OUT + '.inputs.txt', manifest);   // sha256 of this file starts with the build ID
  console.log('build ID', id, '(' + INPUTS.size + ' inputs, ' + n + ' places; manifest ' + OUT + '.inputs.txt)');
}
if (R207) {
  // 2.0.7: the build ID is the first 8 hex of the sha256 of the input manifest (settings + every input's sha256 and path). It is not written
  // into the page (2.0.6 shows no version); it is in CHANGES-207.txt and SHA256SUMS, and the manifest sits next to the page.
  const settings = ['MACUI_BASE=' + (process.env.MACUI_BASE || ''), 'MACUI_MODULES=' + (process.env.MACUI_MODULES || ''), 'MACUI_REEL_NUMBERS=' + RN, 'MACUI_RELEASE=' + REL];
  const manifest = settings.join('\n') + '\n' + [...INPUTS.keys()].sort().map(k => sha(INPUTS.get(k)) + '  ' + k).join('\n') + '\n';
  if (h.indexOf('<script>\n/* concepts/fillreceipt/fillreceipt.js (unedited) */\n') !== h.indexOf(MAIN) + MAIN.length + 1) throw new Error('2.0.7: fillreceipt.js is not the first script after the bot\'s');
  fs.writeFileSync(OUT + '.inputs.txt', manifest);
  console.log('build ID', sha(manifest).slice(0, 8), '(' + INPUTS.size + ' inputs; manifest ' + OUT + '.inputs.txt)');
}
fs.writeFileSync(OUT, h);
console.log('base', BASE.file, BASE.sha, '| mobile-v2.html', h.length, 'bytes, sha256', sha(h).slice(0, 12), '| main script byte-identical:', mainScript(h) === MAIN, '| font-size map', JSON.stringify(sizes));
