import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const probe=fileURLToPath(new URL('../ci/installed-probe.mjs',import.meta.url));
test('installed service import probe handles relocated paths with spaces without starting the service',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora installed '));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'core'));await mkdir(path.join(dir,'node_modules','fixture'),{recursive:true});
 await writeFile(path.join(dir,'node_modules','fixture','index.js'),'module.exports=42;');
 await writeFile(path.join(dir,'core','server.mjs'),"import answer from 'fixture';if(answer!==42)throw Error('missing runtime dependency');export function startServer(){throw Error('must not start');}");
 const result=spawnSync(process.execPath,[probe,dir],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{installed_service_imported:true});
});
test('installed service import probe preserves missing dependency errors and fails',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora missing '));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'core'));await writeFile(path.join(dir,'core','server.mjs'),"import './missing-packaged-module.mjs';");
 const result=spawnSync(process.execPath,[probe,dir],{encoding:'utf8',timeout:30000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/missing-packaged-module\.mjs/);assert.equal(result.stdout,'');
});
test('absolute sidecar entry handles relocated Unicode paths, imports and stdin shutdown',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora native 日本語 '));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'core'));
 await mkdir(path.join(dir,'node_modules','fixture'),{recursive:true});await writeFile(path.join(dir,'node_modules','fixture','index.js'),'module.exports=42;');
 await writeFile(path.join(dir,'core','server.mjs'),`import path from 'node:path';import {pathToFileURL} from 'node:url';import answer from 'fixture';
 if(import.meta.url!==pathToFileURL(path.resolve(process.argv[1])).href)throw Error('entry did not match');
 if(answer!==42||!process.argv.includes('--sidecar'))throw Error('sidecar contract missing');
 console.log(JSON.stringify({ready:true}));process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{if(s.trim()==='shutdown')process.exit(0);});`);
 const result=spawnSync(process.execPath,[path.join(dir,'core','server.mjs'),'--sidecar'],{input:'shutdown\n',encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{ready:true});
 const host=await readFile(new URL('../desktop/src/main.rs',import.meta.url),'utf8');
 assert.match(host,/\.arg\(node_path\(&source\)\)/);assert.match(host,/dunce::simplified\(path\)/);
 assert.doesNotMatch(host,/\.args\(\[source\.to_string_lossy/);
});
test('native startup gate preserves failure evidence and rejects unexpected backend exits',async()=>{
 const script=await readFile(new URL('../ci/native-smoke.ps1',import.meta.url),'utf8');
 const host=await readFile(new URL('../desktop/src/main.rs',import.meta.url),'utf8');
 assert.match(script,/-RedirectStandardError/);assert.match(script,/failure\.json/);assert.match(script,/if \(\$app\.HasExited\) \{ throw/);
 assert.match(host,/CommandEvent::Stderr\(bytes\) if !opened/);assert.match(host,/handle\.exit\(status\.code\.filter/);
 assert.doesNotMatch(host,/CommandEvent::Terminated\(_\) => \{ handle.exit\(0\)/);
});
