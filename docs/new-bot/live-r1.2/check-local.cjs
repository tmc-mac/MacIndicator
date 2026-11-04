#!/usr/bin/env node
'use strict';
// TIDE r2 STAGE 1: read-only check of YOUR config-local.json against the new bot's TIDE / money rules, before anything is installed.
// usage: node check-local.cjs <the package's bot folder> <config-local.json> [expect=<file>]
//   Loads ONLY the package's lib/tideWire.js (+ the lib/moneyRule.js and lib/structure.js it uses: pure, no I/O). The rest of config-local.json is not
//   touched by this package (the bot you run now already accepts it; this build adds settings, it removes none).
//   Prints OK and writes the "[tide] new model ..." startup line the bot must print for your settings (expect=<file>), or prints the problem and exits 1.
const fs = require('fs'), path = require('path');
const [bot, cfgFile, ...rest] = process.argv.slice(2);
if (!bot || !cfgFile) { console.error('usage: node check-local.cjs <bot folder> <config-local.json> [expect=<file>]'); process.exit(2); }
const W = require(path.join(path.resolve(bot), 'lib', 'tideWire.js'));
let local = {};
if (fs.existsSync(cfgFile)) { try { local = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { console.log(`STOP: config-local.json is not valid JSON (${e.message}).`); process.exit(1); } }
if (!local || typeof local !== 'object' || Array.isArray(local)) { console.log('STOP: config-local.json is not a JSON object.'); process.exit(1); }
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v), errors = [];
function merge(base, over, at) {   // the bot's own overlay rules for these two sections: objects merge key by key, the same type is required, a null default takes a number
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;
    if (!Object.prototype.hasOwnProperty.call(base, k)) { errors.push(`unknown setting "${at}${k}"`); continue; }
    const b = base[k], v = over[k];
    if (isObj(b)) { if (!isObj(v)) errors.push(`"${at}${k}" must be an object`); else merge(b, v, `${at}${k}.`); continue; }
    if (b === null) { if (!['number', 'string', 'boolean'].includes(typeof v) && v !== null) errors.push(`"${at}${k}" must be a number, string, true/false or null`); else base[k] = v; continue; }
    if (typeof v !== typeof b || v === null) { errors.push(`"${at}${k}" must be a ${typeof b}`); continue; }
    base[k] = v;
  }
}
const cfg = { tide: JSON.parse(JSON.stringify(W.DEFAULTS.tide)), money: W.moneyDefaults() };
if ('tide' in local) { if (isObj(local.tide)) merge(cfg.tide, local.tide, 'tide.'); else errors.push('"tide" must be an object'); }
if ('money' in local) { if (isObj(local.money)) merge(cfg.money, local.money, 'money.'); else errors.push('"money" must be an object'); }
if (errors.length) { console.log(`STOP: config-local.json: ${errors.join('; ')}`); process.exit(1); }
const p = W.configProblem(cfg, { symbol: 'MNQ', pointValue: 2, minContracts: local.minContracts ?? null });
if (p) { console.log(`STOP: config-local.json: ${p}`); process.exit(1); }
const line = W.startupLines(cfg, 2, 0.25)[0];
const ex = rest.find(a => a.startsWith('expect=')); if (ex) fs.writeFileSync(ex.slice(7), line + '\n');
console.log(`OK: your settings load on the new bot: tide.mode "${cfg.tide.mode}"${cfg.tide.mode === 'live' ? ' (LIVE: the new model sends REAL orders)' : cfg.tide.mode === 'shadow' ? ' (the new model journals + pushes, never orders)' : ' (the new model does nothing: the bot trades as r13.3.7)'}.`);
