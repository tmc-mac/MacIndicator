'use strict';
// For review / study tools that feed bare {s15, s30} bias scalars (OFFLINE input): the same API as lib/structure.js with cfg.biasInput 'offline'.
// Live code never uses this: the default (strict) rejects bare scalars (r3.2, MacDot 6623647326).
const S = require('../lib/structure.js'), CFG = { biasInput: 'offline' };
module.exports = Object.assign({}, S, { step: (st, input, cfg) => S.step(st, input, cfg ? Object.assign({ biasInput: 'offline' }, cfg) : CFG) });
