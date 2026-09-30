import {readdir,readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {invariant} from './policy.mjs';
const digest = s => createHash('sha256').update(s).digest('hex');
const within = (root,file) => file===root || file.startsWith(root+path.sep);

/** Explicitly invoked, read-only discovery; never recursively scans a user's home. */
export async function discoverSharedSkills({root=path.join(os.homedir(),'.agents','skills'),approvedRoots=[]}={}) {
  let base;
  try {base=await realpath(root);} catch(e) {if(e.code==='ENOENT') return {skills:[],issues:[]};throw e;}
  const allowed=[base,...await Promise.all(approvedRoots.map(p=>realpath(p)))];
  const skills=[],issues=[];
  for(const entry of (await readdir(base,{withFileTypes:true})).slice(0,256)) {
    if(!entry.isDirectory()&&!entry.isSymbolicLink()) continue;
    try {
      const file=await realpath(path.join(base,entry.name,'SKILL.md'));
      invariant(allowed.some(r=>within(r,file)),'Shared symlink needs explicit approval of its target root');
      const info=await stat(file);invariant(info.isFile()&&info.size<=65536,'Shared skill exceeds size limit');
      const content=await readFile(file,'utf8');
      const title=content.match(/^#\s+(.+)$/m)?.[1]||entry.name;
      skills.push({id:'shared-'+digest(file).slice(0,24),name:title.slice(0,120),
        description:content.replace(/^---[\s\S]*?---/,'').replace(/^#+.+$/gm,'').trim().slice(0,240),
        source:'shared',sourcePath:file,sha256:digest(content),readOnly:true,enabled:false});
    } catch(e) {issues.push({name:entry.name,reason:String(e.message).slice(0,300)});}
  }
  return {skills,issues};
}
export async function readSharedSkill(descriptor) {
  const file=await realpath(descriptor.sourcePath);
  invariant(file===descriptor.sourcePath,'Shared skill target changed',409);
  const info=await stat(file);invariant(info.isFile()&&info.size<=65536,'Invalid shared skill');
  const content=await readFile(file,'utf8');
  invariant(digest(content)===descriptor.sha256,'Shared skill changed. Rescan before the next task.',409);
  return {...descriptor,content};
}
