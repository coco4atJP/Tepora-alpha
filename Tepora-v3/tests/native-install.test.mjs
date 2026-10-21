import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,open,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installNativeBinary} from '../scripts/install-native-binary.mjs';

test('native staging preserves a mapped old binary while publishing complete new bytes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'new'),binary=path.join(dir,'runtime');await writeFile(source,'new-code');await writeFile(binary,'old-code');
 const old=await open(binary,'r');t.after(()=>old.close());
 await installNativeBinary(source,binary);
 assert.equal(await readFile(binary,'utf8'),'new-code');assert.equal(await old.readFile('utf8'),'old-code');
 assert.deepEqual((await readdir(dir)).sort(),['new','runtime']);
 await assert.rejects(installNativeBinary(path.join(dir,'missing'),binary),{code:'ENOENT'});
 assert.equal(await readFile(binary,'utf8'),'new-code');assert.deepEqual((await readdir(dir)).sort(),['new','runtime']);
});
