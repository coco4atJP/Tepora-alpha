import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// RPM Version cannot contain SemVer's prerelease hyphen. Keep the built app's
// version and put prereleases below release 1 of the final RPM instead.
export function rpmConfig(version){
 const match=/^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
 if(!match)throw new Error(`Invalid application version: ${version}`);
 return {version:match[1],bundle:{linux:{rpm:{release:match[2]?`0.${match[2].replaceAll('-','_')}.1`:'1'}}}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.platform==='linux'){
 const root=fileURLToPath(new URL('../',import.meta.url));
 const {version}=JSON.parse(readFileSync(path.join(root,'desktop/tauri.conf.json'),'utf8'));
 const result=spawnSync(process.execPath,[path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),'bundle','--bundles','rpm','--config',JSON.stringify(rpmConfig(version))],{cwd:path.join(root,'desktop'),stdio:'inherit'});
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
}
