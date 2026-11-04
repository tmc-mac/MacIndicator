'use strict';
// debug: print the engine events of one synthetic test scenario (reads the test file's helpers by eval of its source; dev only)
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../tests/structure.test.cjs'), 'utf8');
const cut = src.indexOf("group('3.");
const m = new module.constructor(); m.paths = module.paths;
m._compile(src.slice(0, cut).replace("group('1. witness", "if (0) group('1. witness").replace(/const W = runFixture\(FX\);[\s\S]*?group\('2\. no look-ahead'\);[\s\S]*?\n}\n/, '') + '\nmodule.exports = { runScenario, S };', path.join(__dirname, '../tests/x.cjs'));
const { runScenario, S } = m.exports;
const R = runScenario(process.argv[2], process.argv[3] === 'm');
const Q = new Set(process.env.ALL ? [] : ['BREAK_LOST', 'PERIOD', 'GRADE_LIVE', 'STATE_1H']);
for (const e of R.evs) if (e.t > Date.UTC(2026, 10, 10, 15, 0) / 1000 && !Q.has(e.type)) { const { t, at, type, signal, ...r } = e; console.log(at, type, JSON.stringify(r).slice(0, 260)); }
console.log('mstate', JSON.stringify(R.st.mstate));
