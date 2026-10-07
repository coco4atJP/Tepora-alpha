import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm,cp,appendFile} from 'node:fs/promises';
import os from 'node:os';
import {browserBundle} from '../core/frontend.mjs';
const webDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../web');
test('live and preview are the same parseable classic bundle, with explicit mode and caught async entry',async()=>{
 const live=await browserBundle(webDir),preview=await browserBundle(webDir,{preview:true});
 assert.doesNotThrow(()=>new vm.Script(live));
 assert.equal(live.replace('__TEPORA_PREVIEW__=false','__TEPORA_PREVIEW__=true'),preview);
 assert.match(live,/catch\(fail\)/);
 assert.doesNotMatch(live,/^import .+ from /m);
});
test('bundle rejects unsupported module syntax instead of silently breaking native startup',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-bundle-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await cp(webDir,dir,{recursive:true});await appendFile(path.join(dir,'demo.mjs'),'\nexport default {}\n');
 // A named export declaration is also rejected after the simple known-declaration transform.
 await appendFile(path.join(dir,'demo.mjs'),'\n  import { unknown } from "unregistered-package";\n');
 await assert.rejects(browserBundle(dir),/Unsupported module declaration/);
});
