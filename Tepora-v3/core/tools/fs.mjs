import {readFile,writeFile,appendFile,mkdir,stat,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {assertWritable} from '../sandbox.mjs';
import {loadImage,isImagePath} from '../agent/images.mjs';
import {invariant} from '../policy.mjs';

const SKIP=new Set(['.git','node_modules','.venv','venv','__pycache__','.cache','dist','build','target','.next','.DS_Store']);
/** One read-modify-write at a time per file, across all sessions in this process. */
const locks=new Map();
async function withLock(file,fn){
 const prev=locks.get(file)||Promise.resolve();let release;const mine=new Promise(r=>{release=r;}),chain=prev.then(()=>mine);locks.set(file,chain);
 await prev;try{return await fn();}finally{release();if(locks.get(file)===chain)locks.delete(file);}
}
/** What this session last saw of a file. A file that changed since (the user, another agent, a build tool) must be
 * read again before it is overwritten or edited, so nobody's changes are silently lost. */
async function remember(ctx,file){try{const i=await stat(file);ctx.files?.set(file,{mtimeMs:i.mtimeMs,size:i.size});return i;}catch{return null;}}
async function assertFresh(ctx,file,op){
 const seen=ctx.files?.get(file);if(!seen)return;
 let info;try{info=await stat(file);}catch{return;}
 invariant(info.mtimeMs===seen.mtimeMs&&info.size===seen.size,`${file} changed since you last read or wrote it (the user, another agent or a program touched it). Read it again before you ${op} it.`,409);
}
const sha=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
export function resolvePath(ctx,p){
 invariant(typeof p==='string'&&p.length>0&&p.length<=4096&&!p.includes('\0'),'path is required');
 const expanded=p==='~'?os.homedir():p.startsWith('~/')?path.join(os.homedir(),p.slice(2)):p;
 return path.resolve(ctx.cwd,expanded);
}
async function isBinary(file){
 const h=await open(file,'r');try{const b=Buffer.alloc(8000);const {bytesRead}=await h.read(b,0,8000,0);return b.subarray(0,bytesRead).includes(0);}finally{await h.close();}
}
export function globRegex(glob){
 let re='';for(let i=0;i<glob.length;i++){const c=glob[i];
  if(c==='*'){if(glob[i+1]==='*'){re+='.*';i++;if(glob[i+1]==='/')i++;}else re+='[^/]*';}
  else if(c==='?')re+='[^/]';else if(c==='{'){const end=glob.indexOf('}',i);if(end>i){re+='('+glob.slice(i+1,end).split(',').map(x=>x.replace(/[.+^$()|[\]\\]/g,'\\$&').replace(/\*/g,'[^/]*')).join('|')+')';i=end;}else re+='\\{';}
  else re+=c.replace(/[.+^$()|[\]\\]/g,'\\$&');}
 return new RegExp('^'+re+'$',process.platform==='win32'?'i':'');
}
async function* walk(root,{maxDepth=25,signal}={}){
 const stack=[[root,0]];
 while(stack.length){
  signal?.throwIfAborted();const [dir,depth]=stack.pop();let entries;
  try{entries=await readdir(dir,{withFileTypes:true});}catch{continue;}
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const e of entries){
   if(SKIP.has(e.name))continue;const full=path.join(dir,e.name);
   if(e.isDirectory()){if(depth<maxDepth)stack.push([full,depth+1]);}
   else if(e.isFile())yield full;
  }
 }
}
export function fsTools(){
 return [{
  name:'read',group:'core',readOnly:true,
  description:'Read a text file with line numbers, or look at an image (PNG, JPEG, GIF, WebP, HEIC…). Use offset/limit (lines) for large files. Works on any path; relative paths are inside the session folder.',
  parameters:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string'},offset:{type:'integer',minimum:1,description:'First line (1-based).'},limit:{type:'integer',minimum:1,maximum:5000,description:'Number of lines (default 800).'},
   question:{type:'string',description:'For an image: what to look for. Used when your own model cannot see images and another model describes it.'}}},
  summarize:a=>`read ${a.path}`,
  async run(a,ctx){
   const file=resolvePath(ctx,a.path),info=await stat(file);
   if(info.isDirectory()){const names=(await readdir(file,{withFileTypes:true})).slice(0,500).map(e=>e.name+(e.isDirectory()?'/':''));return {text:`${file} is a directory:\n${names.join('\n')}`};}
   if(isImagePath(file)){
    const img={...await loadImage(file),name:path.basename(file)},size=`${img.width}×${img.height}, ${Math.round(img.bytes/1024)} KB`;
    if(ctx.runtime?.sessionSees?.(ctx.session)===false){
     const said=await ctx.runtime.lookAt([img],a.question||'Describe this image in detail. Transcribe any visible text exactly.',ctx.signal);
     return {text:said?`${file} (image ${size}). Your model cannot see images, so a vision model described it:\n${said}`:`${file} is an image (${size}), but no model that can see images is connected. Connect one for the "vision" role.`};
    }
    return {text:`${file} (image ${size})`,images:[img]};
   }
   if(await isBinary(file))return {text:`${file} is a binary file (${info.size} bytes). Use exec with an appropriate command (for example pdftotext, unzip -l, xxd) to inspect it.`};
   invariant(info.size<=50_000_000,'File is larger than 50 MB; use exec (head, sed, grep) instead.',413);
   // The same lines of an unchanged file, still visible above: say so instead of sending them again.
   const readKey=`${file}:${a.offset||1}:${a.limit||800}`,prior=ctx.runtime?.priorRead?.(ctx.session,readKey,info);
   if(prior)return {text:`${file} is unchanged since #${prior}, where these lines are shown in full above. Read another range (offset/limit) if you need other lines.`,data:{path:file,unchanged:true}};
   ctx.files?.set(file,{mtimeMs:info.mtimeMs,size:info.size});
   const lines=(await readFile(file,'utf8')).split('\n'),from=(a.offset||1)-1,count=a.limit||800,slice=lines.slice(from,from+count);
   const body=slice.map((l,i)=>`${String(from+i+1).padStart(5)}\t${l.length>2000?l.slice(0,2000)+'…':l}`).join('\n');
   const more=from+count<lines.length?`\n… ${lines.length-from-count} more lines (read with offset=${from+count+1})`:'';
   return {text:`${file} (${lines.length} lines)\n${body}${more}`,data:{path:file,readKey,mtimeMs:info.mtimeMs,size:info.size}};
  }
 },{
  name:'write',group:'core',
  description:'Create or overwrite a text file (parent folders are created). Set append:true to add to the end instead; write long files in several appends rather than one huge call.',
  parameters:{type:'object',additionalProperties:false,required:['path','content'],properties:{path:{type:'string'},content:{type:'string'},append:{type:'boolean'}}},
  summarize:a=>`${a.append?'append':'write'} ${a.path}`,
  async run(a,ctx){
   const file=resolvePath(ctx,a.path);assertWritable(ctx.sandbox,ctx.cwd,file);
   return withLock(file,async()=>{
    if(!a.append)await assertFresh(ctx,file,'overwrite');
    await mkdir(path.dirname(file),{recursive:true});
    if(a.append)await appendFile(file,a.content,'utf8');else await writeFile(file,a.content,'utf8');
    const now=await readFile(file,'utf8');await remember(ctx,file);
    return {text:`${a.append?'Appended':'Wrote'} ${a.content.length} characters to ${file} (now ${now.split('\n').length} lines, ${Buffer.byteLength(now)} bytes, sha ${sha(now)})`,data:{path:file,op:a.append?'append':'write',bytes:Buffer.byteLength(now),sha:sha(now)}};
   });
  }
 },{
  name:'edit',group:'core',
  description:'Replace an exact piece of text in a file. old_string must match exactly once (include enough surrounding lines), unless replace_all is true. Read the file first.',
  parameters:{type:'object',additionalProperties:false,required:['path','old_string','new_string'],properties:{path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'},replace_all:{type:'boolean'}}},
  summarize:a=>`edit ${a.path}`,
  async run(a,ctx){
   const file=resolvePath(ctx,a.path);assertWritable(ctx.sandbox,ctx.cwd,file);
   return withLock(file,async()=>{
   await assertFresh(ctx,file,'edit');
   const before=await readFile(file,'utf8');invariant(a.old_string.length>0,'old_string must not be empty');
   invariant(a.old_string!==a.new_string,'old_string and new_string are identical');
   const count=before.split(a.old_string).length-1;
   if(!count){
    const first=a.old_string.split('\n').find(l=>l.trim())?.trim()||'';const lines=before.split('\n');
    const near=first?lines.map((l,i)=>[i,l]).filter(([,l])=>l.includes(first.slice(0,40))).slice(0,3).map(([i,l])=>`${i+1}: ${l.slice(0,200)}`):[];
    invariant(false,`old_string was not found in ${file}.${near.length?' Similar lines:\n'+near.join('\n'):' Read the file again; it may have changed.'}`,409);
   }
   invariant(count===1||a.replace_all,`old_string occurs ${count} times; add surrounding lines to make it unique or set replace_all.`,409);
   const after=a.replace_all?before.split(a.old_string).join(a.new_string):before.replace(a.old_string,()=>a.new_string);
   await writeFile(file,after,'utf8');await remember(ctx,file);
   const at=before.slice(0,before.indexOf(a.old_string)).split('\n').length;
   return {text:`Edited ${file}: ${a.replace_all?count+' replacements':'line '+at} (sha ${sha(after)})`,data:{path:file,op:'edit',bytes:Buffer.byteLength(after),sha:sha(after)}};
   });
  }
 },{
  name:'find',group:'core',readOnly:true,
  description:'Find files by glob pattern (e.g. "**/*.md", "src/**/test_*.py") under a folder. Skips .git, node_modules and build output.',
  parameters:{type:'object',additionalProperties:false,required:['pattern'],properties:{pattern:{type:'string'},path:{type:'string',description:'Folder to search (default: session folder).'},limit:{type:'integer',minimum:1,maximum:2000}}},
  summarize:a=>`find ${a.pattern}${a.path?' in '+a.path:''}`,
  async run(a,ctx){
   const root=resolvePath(ctx,a.path||'.'),re=globRegex(a.pattern.includes('/')?a.pattern:'**/'+a.pattern),limit=a.limit||300,out=[];
   for await(const file of walk(root,{signal:ctx.signal})){const rel=path.relative(root,file).split(path.sep).join('/');if(re.test(rel)){out.push(rel);if(out.length>=limit)break;}}
   return {text:`${out.length}${out.length>=limit?'+':''} files under ${root}${out.length?'\n'+out.join('\n'):''}`};
  }
 },{
  name:'grep',group:'core',readOnly:true,
  description:'Search file contents with a regular expression under a folder (or one file). Returns matching lines with file:line. Use glob to filter files.',
  parameters:{type:'object',additionalProperties:false,required:['pattern'],properties:{pattern:{type:'string'},path:{type:'string'},glob:{type:'string'},ignore_case:{type:'boolean'},context:{type:'integer',minimum:0,maximum:10},limit:{type:'integer',minimum:1,maximum:2000}}},
  summarize:a=>`grep ${JSON.stringify(a.pattern)}${a.path?' in '+a.path:''}`,
  async run(a,ctx){
   let re;try{re=new RegExp(a.pattern,a.ignore_case?'i':'');}catch(e){invariant(false,`Invalid regular expression: ${e.message}`);}
   const root=resolvePath(ctx,a.path||'.'),info=await stat(root),filter=a.glob?globRegex(a.glob.includes('/')?a.glob:'**/'+a.glob):null,limit=a.limit||200,out=[],ctxLines=a.context||0;
   const files=info.isFile()?[root]:walk(root,{signal:ctx.signal});
   let scanned=0;
   for await(const file of files){
    const rel=info.isFile()?path.basename(file):path.relative(root,file).split(path.sep).join('/');
    if(filter&&!filter.test(rel))continue;
    try{const s=await stat(file);if(s.size>4_000_000||await isBinary(file))continue;}catch{continue;}
    scanned++;const lines=(await readFile(file,'utf8')).split('\n');
    for(let i=0;i<lines.length&&out.length<limit;i++){
     if(!re.test(lines[i]))continue;
     if(ctxLines){for(let j=Math.max(0,i-ctxLines);j<=Math.min(lines.length-1,i+ctxLines);j++)out.push(`${rel}:${j+1}${j===i?':':'-'}${lines[j].slice(0,400)}`);out.push('--');}
     else out.push(`${rel}:${i+1}:${lines[i].slice(0,400)}`);
    }
    if(out.length>=limit)break;
   }
   return {text:`${out.length?out.join('\n'):'No matches'} (searched ${scanned} files under ${root}${out.length>=limit?'; limit reached':''})`};
  }
 }];
}
