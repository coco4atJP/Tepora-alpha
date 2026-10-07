/** Bundle the current, unmodified Node runtime; no SEA patching or runtime npm installation. */
import {cp,copyFile,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rust=spawnSync('rustc',['-vV'],{encoding:'utf8'});
if(rust.status!==0)throw new Error('Install the Rust toolchain before preparing the native package.');
const triple=process.env.TAURI_ENV_TARGET_TRIPLE||rust.stdout.match(/^host: (.+)$/m)?.[1];
if(!triple)throw new Error('Cannot detect native target.');
if(!['win32','darwin'].includes(process.platform))throw new Error('Native packaging targets Windows and macOS only.');
await mkdir(path.join(root,'desktop','binaries'),{recursive:true});
await mkdir(path.join(root,'desktop','resources','v3'),{recursive:true});
await mkdir(path.join(root,'desktop','resources','licenses'),{recursive:true});
const suffix=process.platform==='win32'?'.exe':'';
await copyFile(process.execPath,path.join(root,'desktop','binaries',`node-runtime-${triple}${suffix}`));
for(const dir of ['core','web','workers'])await cp(path.join(root,dir),path.join(root,'desktop','resources','v3',dir),{recursive:true,filter:src=>!src.includes('__pycache__')&&!src.endsWith('.pyc')});
const candidates=[path.join(path.dirname(process.execPath),'LICENSE'),path.resolve(path.dirname(process.execPath),'../LICENSE')];
let license='';for(const candidate of candidates){try{license=await readFile(candidate,'utf8');break;}catch{}}
if(!license){const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);if(!response.ok)throw new Error('Node license must be included in the distribution.');license=await response.text();}
await writeFile(path.join(root,'desktop','resources','licenses','NODE-LICENSE.txt'),license);
await copyFile(path.join(root,'LICENSE'),path.join(root,'desktop','resources','licenses','TEPORA-LICENSE.txt'));
console.log(`Prepared Node ${process.versions.node} and source resources for ${triple}.`);
