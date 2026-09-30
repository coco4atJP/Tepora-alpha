import {readdir,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {workspacePath,invariant} from './policy.mjs';
export const workspaceRoot=(store,id)=>path.join(store.dir,'workspace','tasks',id);
const ignored=new Set(['.git','node_modules','.venv','__pycache__','target','.cache']);
export async function listWorkspace(store,id,{limit=200,depth=5}={}) {
  invariant(store.get('job',id),'Unknown task',404);const root=workspaceRoot(store,id),files=[];let depthLimited=false,symlinks=0;const excluded=new Set();
  async function walk(dir,remaining){
    let entries;try{entries=await readdir(path.join(root,dir),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const e of entries){
      if(files.length>=limit)return;
      if(e.isSymbolicLink()){symlinks++;continue;}
      if(ignored.has(e.name)){excluded.add(e.name);continue;}
      const relative=dir?`${dir}/${e.name}`:e.name;
      if(e.isDirectory()){if(remaining>0)await walk(relative,remaining-1);else depthLimited=true;}
      else if(e.isFile()){
        const safe=await workspacePath(root,relative),s=await stat(safe);
        files.push({path:relative,bytes:s.size,modifiedAt:s.mtime.toISOString()});
      }
    }
  }
  await walk('',depth);return {files,truncated:files.length>=limit||depthLimited,depthLimited,symlinks,excluded:[...excluded].sort()};
}
export async function workspaceFingerprint(store,id) {
  const list=await listWorkspace(store,id,{limit:300});invariant(!list.truncated&&!list.symlinks,'Source tree exceeds the command-check snapshot scope (count, depth, or symbolic links)',413);
  const hash=createHash('sha256');
  for(const f of list.files.sort((a,b)=>a.path.localeCompare(b.path))){
    invariant(f.bytes<=4_000_000,'File is too large for an exact command-check snapshot',413);
    const data=await readFile(await workspacePath(workspaceRoot(store,id),f.path));hash.update(f.path+'\0').update(data);
  }
  return hash.digest('hex');
}
export async function publishWorkspaceDocuments(store,job) {
  const list=await listWorkspace(store,job.id),published=[];
  // Sources handed to an external agent are inputs, never proof that it produced a result.
  for(const file of list.files.filter(f=>!f.path.startsWith('inputs/')&&/\.(md|txt|json|html?)$/i.test(f.path)&&f.bytes>0&&f.bytes<=200000).slice(0,12)){
    const content=await readFile(await workspacePath(workspaceRoot(store,job.id),file.path),'utf8');
    const id='external-'+createHash('sha256').update(job.id+'\0'+file.path).digest('hex').slice(0,40);
    const existing=store.get('artifact',id);if(existing?.content===content)continue;
    // Never overwrite a document that the person has subsequently edited in the UI.
    const sync=store.get('artifact-sync',id);if(existing&&sync?.version!==existing.version)continue;
    const kind=/\.html?$/i.test(file.path)?'html':/\.md$/i.test(file.path)?'markdown':'text';
    const a=store.artifact(file.path,content,{id,jobId:job.id,kind,expectedVersion:existing?.version||0});
    store.put('artifact-sync',{id,version:a.version,sourcePath:file.path});published.push({id:a.id,title:a.title,version:a.version});
  }
  return published;
}
