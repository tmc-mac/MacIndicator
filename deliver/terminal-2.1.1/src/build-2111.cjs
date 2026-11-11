'use strict';
// Terminal 2.1.1 (terminal builder, 11/11): build-2101.cjs with one more module (t211.js / t211.css) in the same single script / stylesheet, and the
// edited t210 sources of this folder. The base check is unchanged: undoing the insertions and the listed clock formatters gives 2.0.9.10 back byte for byte.
// Terminal 2.1 stage 2.1 (MacUI-T, 11/10): build-2100.cjs plus one step: the page's display-only 24-hour clock formatters are rewritten 12-hour
// where the text is produced (clock-sources-2101.cjs, each applied an exact number of times). The check: undoing those substitutions and removing
// the two 2.1 insertions gives 2.0.9.10 back byte for byte. MACUI_H = the harness folder (build-20910.cjs and its inputs, unchanged);
// the 2.1 sources are read from this file's folder.
// Terminal 2.1.0 build (MacUI-T, 11/10): build-20910.cjs + ONE step. It runs build-20910.cjs unchanged (MACUI_RELEASE=2.0.9.10), checks that the
// result is the 2.0.9.10 page byte for byte (sha256 ca093989...), then appends one feature module (one <script> last in <body>) and one stylesheet
// (last in the last <style>). Nothing else in the page changes: the diff against 2.0.9.10 is exactly those two insertions.
// MACUI_T210_STAGE=1 (default): v2src/t210.js + v2src/t210.css. Stage 2 adds v2src/t210-cascade.js/.css v2src/t210-control.js/.css and v2src/t210-clock.js/.css, stage 3 adds v2src/t210-motion.js/.css
// (each concatenated into the same single script / stylesheet).
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const H = process.env.MACUI_H || path.resolve(__dirname, '../../../macui/harness'), SRC = __dirname, OUT = path.resolve(process.env.MACUI_OUT || path.join(SRC, '../mobile.html')), STAGE = Number(process.env.MACUI_T210_STAGE || 2);
const BASE_SHA = 'ca09398940186902140d1349ab5df01e40d5a269c24a76efbd733b601f856a67';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
if (![1, 2, 3].includes(STAGE)) throw new Error('MACUI_T210_STAGE must be 1, 2 or 3');
const tmp = OUT + '.base-20910.tmp';
cp.execFileSync(process.execPath, [path.join(H, 'build-20910.cjs')], { cwd: H, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { MACUI_BRAIN: 'bv', MACUI_BASE: 'r133', MACUI_MODULES: 'sp,charts,reactor,reel,radarbg,clpath', MACUI_RELEASE: '2.0.9.10', MACUI_REEL_NUMBERS: 'labelled', MACUI_OUT: tmp }) });
let h = fs.readFileSync(tmp, 'utf8'); const baseManifest = fs.readFileSync(tmp + '.inputs.txt', 'utf8'); fs.unlinkSync(tmp); fs.unlinkSync(tmp + '.inputs.txt');
if (sha(h) !== BASE_SHA) throw new Error('the base is not 2.0.9.10: ' + sha(h));
const base = h, names = ['t210'].concat(STAGE >= 2 ? ['t210-cascade', 't210-control', 't210-clock', 't211'] : [], STAGE >= 3 ? ['t210-motion'] : []), IN = [];
const V = f => { const t = fs.readFileSync(path.join(SRC, f), 'utf8'); IN.push(sha(t) + '  term211/src/' + f); return t; };
IN.push(sha(fs.readFileSync(__filename, 'utf8')) + '  term211/src/build-2101.cjs');
const SUBS = require(path.join(SRC, 'clock-sources-2101.cjs')); IN.push(sha(fs.readFileSync(path.join(SRC, 'clock-sources-2101.cjs'), 'utf8')) + '  term211/src/clock-sources-2101.cjs');
for (const [label, from, to, n] of SUBS) { const k = h.split(from).length - 1; if (k !== n) throw new Error('clock source "' + label + '": found ' + k + ', want ' + n); if (h.split(to).length !== 1) throw new Error('clock source "' + label + '": the replacement is already in the page'); h = h.split(from).join(to); }
const js = names.map(n => '/* MacUI ' + (n === 't211' ? '2.1.1' : '2.1.0') + ': v2src/' + n + '.js */\n' + V(n + '.js').trimEnd()).join('\n');
const css = names.map(n => '/* MacUI ' + (n === 't211' ? '2.1.1' : '2.1.0') + ': v2src/' + n + '.css */\n' + V(n + '.css').trimEnd()).join('\n');
new Function(js);   // 2.1.1: a module that does not parse stops the build
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('a closing tag inside an input');
const one = (from, to, label, last) => { const i = last ? h.lastIndexOf(from) : h.indexOf(from); if (i < 0 || (!last && h.indexOf(from, i + 1) >= 0 && label !== 'style')) throw new Error(label + ': anchor'); h = h.slice(0, i) + to + h.slice(i); };
{ const n = h.split('</script>\n</body>').length - 1; if (n !== 1) throw new Error('body anchor: ' + n); h = h.replace('</script>\n</body>', () => '</script>\n<script>\n' + js + '\n</script>\n</body>'); }
{ const i = h.indexOf('</style>'); if (i < 0) throw new Error('style anchor'); h = h.slice(0, i) + '\n' + css + '\n' + h.slice(i); }
// the diff is two insertions: removing them gives 2.0.9.10 back
{ let u = h.replace('<script>\n' + js + '\n</script>\n', '').replace('\n' + css + '\n', ''); for (const [, from, to, n] of SUBS) { if (u.split(to).length - 1 !== n) throw new Error('undo: ' + to.slice(0, 40)); u = u.split(to).join(from); }
  if (u !== base) throw new Error('the page differs from 2.0.9.10 by more than the two insertions and the listed clock formatters'); }
const manifest = 'MACUI_RELEASE=2.1.1\nMACUI_T210_STAGE=' + STAGE + '.1\nclock formatters rewritten at the source: ' + SUBS.length + ' entries, ' + SUBS.reduce((a, x) => a + x[3], 0) + ' sites' + '\nbase=2.0.9.10 ' + BASE_SHA + '\n' + IN.sort().join('\n') + '\n# 2.0.9.10 inputs (build-20910.cjs):\n' + baseManifest;
fs.writeFileSync(OUT, h); fs.writeFileSync(OUT + '.inputs.txt', manifest);
console.log('terminal 2.1.1 stage ' + STAGE + '.1 | ' + h.length + ' chars | sha256 ' + sha(fs.readFileSync(OUT)) + ' | build ID ' + sha(manifest).slice(0, 8) + ' | base 2.0.9.10 byte-identical minus two insertions and ' + SUBS.reduce((a, x) => a + x[3], 0) + ' clock-formatter sites: true');
