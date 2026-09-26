import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let total=0;
for(const dir of ['core','web','scripts','tests'])for(const f of await readdir(path.join(root,dir)))if(f.endsWith('.mjs')){const r=spawnSync(process.execPath,['--check',path.join(root,dir,f)],{encoding:'utf8'});if(r.status!==0){console.error(r.stderr);process.exit(1);}total++;}
console.log(`Syntax checked ${total} JavaScript modules.`);
