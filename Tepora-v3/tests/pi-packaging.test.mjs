import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {bundleDependencies} from '../scripts/bundle-dependencies.mjs';
test('packaged production dependencies load the real pi-ai registry without dev modules',async t=>{
 const root=fileURLToPath(new URL('../',import.meta.url));const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-pi-package-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const count=await bundleDependencies(root,dir);assert.ok(count>1);
 await assert.rejects(access(path.join(dir,'node_modules/@tauri-apps/cli')));
 const pkg=JSON.parse(await readFile(path.join(dir,'node_modules/@earendil-works/pi-ai/package.json'),'utf8'));assert.equal(pkg.version,'1.3.0');
 await writeFile(path.join(dir,'probe.mjs'),"import {builtinModels} from '@earendil-works/pi-ai/providers/all';console.log(builtinModels().getProviders().length);");
 const probe=spawnSync(process.execPath,[path.join(dir,'probe.mjs')],{cwd:dir,encoding:'utf8',timeout:30000});assert.equal(probe.status,0,probe.stderr);assert.equal(probe.stdout.trim(),'42');
});
