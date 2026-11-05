'use strict';
// MacUI-B 2.0.9.23: full-tab shots (Now / Trades / Levels / Review) at 390, dark + light, on one fixture. node shot-tabs-20923.cjs <page> <outdir> <state>  (cwd = the harness folder)
const path = require('path'), fs = require('fs'); const P = path.resolve(process.argv[2]); process.env.MACUI_V2 = P; const OUT = path.resolve(process.argv[3]); fs.mkdirSync(OUT, { recursive: true });
const st = process.argv[4] || 't23-pnl1105'; const { chromium } = require('playwright'), { startServer, meta } = require(path.resolve('lib.cjs'));
(async () => { const b = await chromium.launch(); let bad = false;
  try { const m = meta(st), srv = await startServer(st, 'mb23s', m.clock);
    try { for (const theme of ['dark', 'light']) { const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: theme, reducedMotion: 'reduce' });
        const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', x => { if (x.type() === 'error') errors.push('console: ' + x.text()); });
        await page.clock.setFixedTime(m.clock); await page.goto(`http://127.0.0.1:${srv.port}/mobile.html?key=fixture&v=2`);
        await page.waitForFunction(() => typeof pcSnap !== 'undefined' && pcSnap && pcSnap.updated, null, { timeout: 15000 }); await page.waitForTimeout(1200);
        for (const [v, n] of [['dashboard', 'now'], ['trades', 'trades'], ['levels', 'levels'], ['journal', 'review']]) { await page.evaluate(v => switchView(v), v); await page.waitForTimeout(700);
          fs.writeFileSync(path.join(OUT, `${st}-${n}-${theme}-390.png`), await page.screenshot({ fullPage: true })); }
        const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        console.log(`${st} ${theme}: 4 tabs, sideways ${sw}px, errors ${errors.length}${errors.length ? ' ' + errors.join(' | ') : ''}`); if (sw > 0 || errors.length) bad = true; await ctx.close(); } } finally { srv.stop(); } } finally { await b.close(); }
  console.log(bad ? 'shot-tabs-20923: FAIL' : 'shot-tabs-20923: OK'); process.exit(bad ? 1 : 0); })();
