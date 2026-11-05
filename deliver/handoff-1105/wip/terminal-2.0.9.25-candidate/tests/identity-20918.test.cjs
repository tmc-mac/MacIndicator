'use strict';
// MacUI-N 2.0.9.18: OLD-PATH IDENTITY with TIDE off. For every fixture state without TIDE (no snapshot.tide, no tide.mode override), plus 2 TIDE-off
// variants on mac1814 (tide:{mode:'off'}; override tide.mode 'off'), the body DOM (scripts removed) after opening each of the 7 views must be
// byte-identical between 2.0.9.17 (REF) and 2.0.9.18 (CAND); also the same errors and no new long task.
//   node identity-20918.test.cjs <ref.html> <cand.html>   (cwd = the harness folder; one browser; nice 19 by the caller)
const path = require('path'), fs = require('fs'), crypto = require('crypto'), { spawn } = require('child_process');
const REF = path.resolve(process.argv[2]), CAND = path.resolve(process.argv[3]), H = path.resolve('.');
const { chromium } = require('playwright');
const meta = s => JSON.parse(fs.readFileSync(path.join(H, 'fixtures/states', s, 'meta.json'), 'utf8'));
const ONLY = process.env.STATES ? process.env.STATES.split(',') : null;
const states = (ONLY || fs.readdirSync(path.join(H, 'fixtures/states'))).filter(s => !/^tide(1[89]|20)-/.test(s) && fs.existsSync(path.join(H, 'fixtures/states', s, 'meta.json')));
const VIEWS = ['dashboard', 'trades', 'checklist', 'levels', 'journal', 'control', 'risk'];
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
function server(state, clock) {   // lib.cjs's startServer, with REF as v=1 and CAND as v=2 (both opened with v=2 semantics: the page is the same file name)
  const run = path.join(H, 'run', `${state}-mn18id`); fs.rmSync(run, { recursive: true, force: true }); fs.mkdirSync(path.join(run, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(H, 'proxy/tmc-proxy.js'), path.join(run, 'tmc-proxy.js')); fs.copyFileSync(path.join(H, 'proxy/lib/entryCancelRequests.js'), path.join(run, 'lib/entryCancelRequests.js'));
  for (const f of ['bias-snapshot-MNQ.json', 'trade-journal-MNQ.jsonl']) fs.copyFileSync(path.join(H, 'fixtures/states', state, f), path.join(run, f));
  return (pg) => new Promise((res, rej) => { const p = spawn(process.execPath, [path.join(H, 'fixture-server.cjs'), run, String(clock), pg, pg], { stdio: ['ignore', 'pipe', 'inherit'] }); let buf = '';
    p.stdout.on('data', d => { buf += d; const m = /\{"port":(\d+)\}/.exec(buf); if (m) res({ port: +m[1], stop: () => p.kill('SIGTERM') }); }); p.on('exit', c => rej(new Error('server exited ' + c))); });
}
async function dump(b, port, clock, mutate) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' }), p = await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {} });
  try { await p.clock.setFixedTime(clock);
    if (mutate) await p.route(u => /\/bias\?/.test(u.href), async r => { const res = await r.fetch(), j = await res.json(); (new Function('d', mutate))(j); await r.fulfill({ response: res, body: JSON.stringify(j) }); });
    await p.goto(`http://127.0.0.1:${port}/mobile.html?key=fixture&v=2`); await p.waitForFunction(() => typeof pcSnap !== 'undefined' && pcSnap && pcSnap.updated, null, { timeout: 15000 }); await p.waitForTimeout(3500);   // the 2.0.9.18 fill chase answers within ~2 s: both pages settle before the dump
    const out = {}; for (const v of VIEWS) { await p.evaluate(v => switchView(v), v); await p.waitForTimeout(400);
      out[v] = await p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('script').forEach(s => s.remove()); [...c.childNodes].forEach(n => { if (n.nodeType === 3 && !n.data.trim()) n.remove(); }); return c.innerHTML.replace(/poll \d+ ms/g, 'poll <n> ms'); }); }
    out.__fx18 = await p.evaluate(() => [!!document.getElementById('fx18-tide'), !!document.getElementById('fx18-alerts'), !!document.getElementById('fx18-trades'), document.getElementById('view-trades') && document.getElementById('view-trades').getAttribute('data-fx18f')].join(','));
    return { out, errors, lt: await p.evaluate(() => window.__lt) };
  } finally { await ctx.close(); } }
(async () => {
  const b = await chromium.launch(); let pass = 0, fail = 0;
  const runs = states.map(s => [s, null, s]).concat(ONLY ? [] : [['mac1814', "d.tide = { v: 1, mode: 'off', rows: [] };", 'mac1814+tide-mode-off'], ['mac1814', "d.configLocal.overrides.push({ key: 'tide.mode', from: 'off', to: 'off' });", 'mac1814+override-off']]);
  try { for (const [st, mut, tag] of runs) { const m = meta(st), mk = server(st, m.clock);
      let A, B; for (let i = 0; i < 2; i++) { const s1 = await mk(REF); try { A = await dump(b, s1.port, m.clock, mut); } finally { s1.stop(); } const s2 = await mk(CAND); try { B = await dump(b, s2.port, m.clock, mut); } finally { s2.stop(); }
        if (VIEWS.every(v => A.out[v] === B.out[v])) break; }
      const diff = VIEWS.filter(v => A.out[v] !== B.out[v]), mounts = B.out.__fx18 !== 'false,false,false,';
      const ok = !diff.length && !mounts && JSON.stringify(A.errors) === JSON.stringify(B.errors);
      if (ok) pass++; else fail++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${tag.padEnd(26)} views ${diff.length ? 'DIFF ' + diff.join(',') : 'IDENTICAL x7'} (${VIEWS.map(v => sha(B.out[v]).slice(0, 6)).join(' ')}) fx18-mounted ${B.out.__fx18} errors ref ${A.errors.length} cand ${B.errors.length} longtasks ref [${A.lt}] cand [${B.lt}]`);
      if (diff.length) { const v = diff[0], a = A.out[v], c = B.out[v]; let i = 0; while (a[i] === c[i]) i++; console.log('   first difference in', v, 'at', i, '\n   ref : ' + a.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ') + '\n   cand: ' + c.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ')); }
    } } finally { await b.close(); }
  console.log(`identity-20918: ${pass} passed, ${fail} failed (${runs.length} runs x 7 views, TIDE off)`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
