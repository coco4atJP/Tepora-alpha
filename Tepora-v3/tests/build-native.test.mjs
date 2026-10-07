import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const v8NoticePath='native-service/src/workspace/display_avatar/V8-LICENSE.txt';
const retainedV8Notice=await readFile(new URL('../'+v8NoticePath,import.meta.url),'utf8');

// Execute the real build script in an isolated fixture. Only its external Cargo
// and rustc subprocesses are replaced; no registry, compiler or shell is needed.
async function fixture(t,host){
 // ESM resolves the script's real path (for example macOS /var -> /private/var).
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'tepora-native-build-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const folder of ['scripts','core',path.dirname(v8NoticePath),'registry/rcgen','registry/asn1-rs'])await mkdir(path.join(root,folder),{recursive:true});
 await writeFile(path.join(root,v8NoticePath),retainedV8Notice);
 await copyFile(new URL('../scripts/build-native.mjs',import.meta.url),path.join(root,'scripts','build-native.mjs'));
 await writeFile(path.join(root,'core','frontend.mjs'),'export async function browserBundle(){return "fixture browser bundle";}\n');
 await writeFile(path.join(root,'registry','rcgen','LICENSE'),'fixture rcgen license');
 await writeFile(path.join(root,'registry','asn1-rs','COPYING'),'fixture asn1-rs license');
 const packages=[
  {name:'rcgen',version:'0.14.10',source:'registry+fixture',license:'MIT',manifest_path:path.join(root,'registry','rcgen','Cargo.toml')},
  {name:'tepora-native-service',version:'0.1.0',source:null,manifest_path:path.join(root,'native-service','Cargo.toml')},
  {name:'asn1-rs',version:'0.7.2',source:'registry+fixture',license:'MIT',manifest_path:path.join(root,'registry','asn1-rs','Cargo.toml')},
 ];
 const preload=path.join(root,'subprocess-fixture.mjs'),callsFile=path.join(root,'calls.json');
 await writeFile(preload,`
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
const calls=[];
childProcess.spawnSync=(command,args)=>{
 calls.push({command,args,offline:process.env.CARGO_NET_OFFLINE??null});
 writeFileSync(${JSON.stringify(callsFile)},JSON.stringify(calls));
 if(command==='rustc')return {status:0,stdout:${JSON.stringify('host: '+host+'\n')},stderr:''};
 if(command!==process.env.CARGO)throw new Error('Unexpected fixture subprocess: '+command);
 if(args[0]==='build')return {status:0};
 if(args[0]!=='metadata')throw new Error('Unexpected Cargo invocation');
 // A successful ordinary build has not cached this dev-only dependency.
 if(args.includes('--offline')||process.env.CARGO_NET_OFFLINE==='true')return {status:101,stderr:'failed to download asn1-rs v0.7.2: attempting an HTTP request, but offline was specified'};
 return {status:0,stdout:${JSON.stringify(JSON.stringify({packages}))},stderr:''};
};
syncBuiltinESMExports();
`);
 return {root,async run({offline,target,release=false}={}){
  const env={...process.env,CARGO:'fixture-cargo'};
  delete env.CARGO_NET_OFFLINE;delete env.CARGO_BUILD_TARGET;
  if(offline!==undefined)env.CARGO_NET_OFFLINE=offline;
  if(target!==undefined)env.CARGO_BUILD_TARGET=target;
  const result=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'scripts','build-native.mjs'),...(release?['--release']:[])],{env,encoding:'utf8',timeout:10000});
  return {...result,calls:JSON.parse(await readFile(callsFile,'utf8'))};
 }};
}

for(const host of ['aarch64-apple-darwin','x86_64-pc-windows-msvc','x86_64-unknown-linux-gnu'])test('native build resolves uncached dev-dependency notices with locked metadata: '+host,async t=>{
 const f=await fixture(t,host),result=await f.run();
 assert.equal(result.status,0,result.stderr||result.error?.message);
 assert.deepEqual(result.calls.map(c=>c.args[0]),['build','-vV','metadata']);
 const metadata=result.calls[2];
 assert.deepEqual(metadata.args,['metadata','--locked','--format-version','1','--filter-platform',host,'--manifest-path',path.join(f.root,'native-service','Cargo.toml')]);
 assert.ok(result.calls[0].args.includes('--locked'));assert.equal(metadata.offline,null);
 const noticesFile=path.join(f.root,'dist','native','THIRD-PARTY-LICENSES.txt'),notices=await readFile(noticesFile,'utf8');
 assert.match(notices,/asn1-rs 0\.7\.2[\s\S]*fixture asn1-rs license[\s\S]*rcgen 0\.14\.10[\s\S]*fixture rcgen license/);
 assert.doesNotMatch(notices,/=== tepora-native-service/);
 assert.match(notices,/=== V8 DateParser adaptation \(BSD-3-Clause; V8 tag 12\.4\.254\) ===/);
 assert.ok(notices.endsWith(retainedV8Notice),'distribution retains the complete V8 notice verbatim');
 assert.ok(notices.indexOf('=== V8 DateParser')>notices.indexOf('=== rcgen'),'local-source notices have deterministic placement after registry notices');
 assert.equal(await readFile(path.join(f.root,'dist','native','app.bundle.js'),'utf8'),'fixture browser bundle');
 assert.equal((await f.run()).status,0);assert.equal(await readFile(noticesFile,'utf8'),notices,'notices retain deterministic package order and contents');
});

test('native build honors an explicit offline Cargo policy and never silently drops notices',async t=>{
 const f=await fixture(t,'x86_64-unknown-linux-gnu'),result=await f.run({offline:'true'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Cannot collect native dependency notices:.*asn1-rs v0\.7\.2/);
 assert.equal(result.calls[0].offline,'true');assert.equal(result.calls[2].offline,'true');
 await assert.rejects(readFile(path.join(f.root,'dist','native','THIRD-PARTY-LICENSES.txt')),{code:'ENOENT'});
});

test('native build retains release and explicit target metadata selection',async t=>{
 const f=await fixture(t,'x86_64-unknown-linux-gnu'),target='aarch64-apple-darwin',result=await f.run({target,release:true});
 assert.equal(result.status,0,result.stderr);assert.ok(result.calls[0].args.includes('--release'));
 assert.equal(result.calls[2].args[result.calls[2].args.indexOf('--filter-platform')+1],target);
});

test('native build fails clearly instead of distributing a missing V8 notice',async t=>{
 const f=await fixture(t,'x86_64-unknown-linux-gnu');
 await rm(path.join(f.root,v8NoticePath));
 const result=await f.run();
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Required V8 date-parser license notice is missing or unreadable: src\/workspace\/display_avatar\/V8-LICENSE\.txt/);
 await assert.rejects(readFile(path.join(f.root,'dist','native','THIRD-PARTY-LICENSES.txt')),{code:'ENOENT'});
});

test('native build fails clearly for an empty retained V8 notice',async t=>{
 const f=await fixture(t,'x86_64-unknown-linux-gnu');
 await writeFile(path.join(f.root,v8NoticePath),' \n\t');
 const result=await f.run();
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Required V8 date-parser license notice is empty:/);
 await assert.rejects(readFile(path.join(f.root,'dist','native','THIRD-PARTY-LICENSES.txt')),{code:'ENOENT'});
});
