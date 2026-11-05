#!/usr/bin/env node
'use strict';
// LOCAL ONLY: original assertions unmodified; swap only the broker implementation.
const fs=require('fs'),path=require('path'),Module=require('module');
const original=fs.readFileSync(path.join(__dirname,'tide-live.test.cjs'),'utf8');
const safety=fs.readFileSync(path.join(__dirname,'candidate-safety.test.cjs'),'utf8');
const fake=safety.slice(safety.indexOf('// LOCAL SIMULATION ONLY.'),safety.indexOf('async function scenario('));
const source=original.replace('\n(async () => {\n','\n'+fake+'\nbroker = safeBroker;\n(async () => {\n');
const m=new Module(__filename,module);m.filename=__filename;m.paths=module.paths;m._compile(source,__filename);
