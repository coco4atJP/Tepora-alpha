import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../scripts/benchmark-product.mjs',import.meta.url));
test('product benchmark lists the requested model matrix and Jev Computer Use without credentials or inference',()=>{
 const r=spawnSync(process.execPath,[cli,'--list'],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);
 const v=JSON.parse(r.stdout);assert.deepEqual(v.models,['deepseek-v4.1-flash','minimax-m3.1-flash-free','step-5-preview','mimo-v2.6-flash','muse-spark-1.3-contributor']);
 assert.ok(v.cases.includes('computer-jev-form'));assert.ok(v.cases.includes('computer-jev-blocked'));assert.equal(new Set(v.cases).size,v.cases.length);
});
for(const args of [[],['--run'],['--run','--allow-cloud','--repeat','0'],['--run','--allow-cloud','--models','unknown'],['--run','--allow-cloud','--max-usd','NaN']])test('benchmark refuses invalid/missing explicit execution arguments: '+args.join(' '),()=>{
 const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:15000});assert.notEqual(r.status,0);assert.ok(!r.stdout.includes('"event":"provider"'));
});
