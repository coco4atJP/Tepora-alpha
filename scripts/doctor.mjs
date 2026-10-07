import {spawnSync} from 'node:child_process';
import {access,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const [major,minor]=process.versions.node.split('.').map(Number);
const supported=major>22||major===22&&minor>=16;
console.log(`Tepora 3.0.0-beta.11 · Node ${process.versions.node}: ${supported?'OK':'requires 22.16+'}`);
if(!supported)process.exitCode=1;
for(const command of [process.platform==='win32'?'python':'python3','rustc','cargo','docker']){
 const result=spawnSync(command,['--version'],{encoding:'utf8',timeout:5000,shell:false});
 console.log(`${command}: ${result.status===0?result.stdout.trim():'not installed (optional)'}`);
}
try{await access(new URL('Tepora-v3/node_modules/@tauri-apps/cli/package.json',root));console.log('Tauri CLI: installed');}
catch{console.log('Tauri CLI: not installed; native builds need npm ci --prefix Tepora-v3 --ignore-scripts');}
const config=JSON.parse(await readFile(new URL('Tepora-v3/package.json',root),'utf8'));
console.log(`Service: ${fileURLToPath(new URL('Tepora-v3/core/server.mjs',root))} (${config.version})`);
console.log('Core startup needs only Node. Python is needed for worker tests. Rust/Tauri are needed for native builds.');
console.log('Docker is optional for approved container execution. This check does not run models or containers.');
