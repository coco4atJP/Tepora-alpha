import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let total=0;
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
 const file=path.join(dir,e.name);if(e.isDirectory()){await walk(file);continue;}
 if(!/\.(mjs|js)$/.test(e.name))continue;
 const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
 if(result.status!==0){console.error(result.stderr);process.exit(1);}total++;
}}
for(const dir of ['core','web','scripts','tests','spec'])await walk(path.join(root,dir));
console.log(`Syntax checked ${total} JavaScript modules.`);
