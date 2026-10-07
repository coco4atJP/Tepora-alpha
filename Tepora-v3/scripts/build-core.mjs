/** Build the Rust persistence core for the Node N-API ABI (not a Node-version ABI).
 * Packaging calls this before copying core/, so users of the installed app do
 * not need Cargo. Source developers need the official stable Rust toolchain.
 */
import {spawnSync} from 'node:child_process';
import {assertNodeTarget} from './native-target.mjs';
import {mkdir,copyFile,readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const crate=path.join(root,'native-core'),out=path.join(root,'core','native');
const target=process.env.TAURI_ENV_TARGET_TRIPLE||process.env.CARGO_BUILD_TARGET||'';
if(target)assertNodeTarget(target);
const profile=process.argv.includes('--release')?'release':'debug';
const fingerprint=createHash('sha256').update(JSON.stringify({platform:process.platform,arch:process.arch,target,profile}));
async function hashTree(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
 const p=path.join(dir,e.name);if(e.isDirectory()){await hashTree(p);continue;}
 fingerprint.update(path.relative(crate,p)).update(await readFile(p));
}}
for(const name of ['Cargo.toml','Cargo.lock','build.rs'])fingerprint.update(name).update(await readFile(path.join(crate,name)));
await hashTree(path.join(crate,'src'));
fingerprint.update(await readFile(fileURLToPath(import.meta.url)));
fingerprint.update(await readFile(new URL('./native-target.mjs',import.meta.url)));
const digest=fingerprint.digest('hex'),stamp=path.join(out,'build.json'),binary=path.join(out,'tepora_core.node');
function smoke(){
 const result=spawnSync(process.execPath,['-e',`const {StateCore}=require(process.argv[1]);const s=new StateCore(':memory:');s.call('kv.set',JSON.stringify({key:'smoke',value:true}));if(s.call('kv.get',JSON.stringify({key:'smoke'}))!=='true')process.exit(2);s.call('close','{}');`,binary],{encoding:'utf8',timeout:10000});
 if(result.status!==0)throw new Error('Built Rust core cannot load under this Node executable: '+(result.stderr||result.error?.message||result.status));
}
let current;try{current=JSON.parse(await readFile(stamp,'utf8'));}catch{}
if(current?.digest===digest){try{
 await readFile(path.join(out,'THIRD-PARTY-LICENSES.txt'));
 const bytes=await readFile(binary);if(createHash('sha256').update(bytes).digest('hex')===current.sha256){smoke();console.log('Rust core is up to date.');process.exit(0);}
}catch{}}
const rustInfo=spawnSync('rustc',['-vV'],{encoding:'utf8'});
const host=target||rustInfo.stdout?.match(/^host: (.+)$/m)?.[1];
if(!host)throw new Error('Install the official Rust toolchain (https://rustup.rs), then rerun npm run build:core.');
assertNodeTarget(host);
const args=['build','--locked','--manifest-path',path.join(crate,'Cargo.toml')];
if(profile==='release')args.push('--release');args.push('--target',host);
const build=spawnSync(process.env.CARGO||'cargo',args,{stdio:'inherit'});
if(build.error)throw new Error('Install the official Rust toolchain (https://rustup.rs), then rerun npm run build:core.',{cause:build.error});
if(build.status!==0)process.exit(build.status||1);
const platform=target?(target.includes('windows')?'win32':target.includes('apple')?'darwin':'linux'):process.platform;
const name=platform==='win32'?'tepora_core.dll':platform==='darwin'?'libtepora_core.dylib':'libtepora_core.so';
// Ship the dependency license texts with the addon; installed apps never need
// access to Cargo's source cache to see their third-party notices.
const metadata=spawnSync(process.env.CARGO||'cargo',['metadata','--locked','--offline','--format-version','1','--filter-platform',host,'--manifest-path',path.join(crate,'Cargo.toml')],{encoding:'utf8',maxBuffer:16*1024*1024});
if(metadata.status!==0)throw new Error('Cannot collect Rust dependency notices: '+metadata.stderr);
const resolved=JSON.parse(metadata.stdout);
const source=path.join(resolved.target_directory,host,profile,name);
await mkdir(out,{recursive:true});await copyFile(source,binary);
const packages=resolved.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name));
const notices=['Tepora Rust persistence core — third-party dependency notices\n'];
for(const pkg of packages){
 const folder=path.dirname(pkg.manifest_path);
 notices.push(`\n=== ${pkg.name} ${pkg.version} (${pkg.license||'see license file'}) ===\n${pkg.repository||''}\n`);
 const files=(await readdir(folder)).filter(name=>/^(licen[cs]e|copying|copyright)([._-]|$)/i.test(name));
 if(pkg.license_file&&!files.includes(pkg.license_file))files.push(pkg.license_file);
 for(const name of files){try{notices.push(`\n--- ${name} ---\n`+await readFile(path.join(folder,name),'utf8'));}catch(error){if(error.code!=='EISDIR')throw error;}}
}
await writeFile(path.join(out,'THIRD-PARTY-LICENSES.txt'),notices.join('\n'));

smoke();
await writeFile(stamp,JSON.stringify({digest,sha256:createHash('sha256').update(await readFile(binary)).digest('hex')})+'\n');
console.log(`Built Tepora Rust core (${target||process.platform+'-'+process.arch}, ${profile}).`);
