// Test-only differential oracle. Runs original JS file tools exclusively in a
// newly-created temp fixture; production native tools never invoke Node.
import {mkdtemp,writeFile,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fsTools} from '../../core/tools/fs.mjs';
const scenarios=[
 {label:'writes-edits-appends',setup:[],steps:[
  ['write',{path:'a/b.txt',content:'A😀\nB'}],['read',{path:'a/b.txt'}],['read',{path:'a/b.txt'}],
  ['write',{path:'a/b.txt',append:true,content:'\nB'}],['edit',{path:'a/b.txt',old_string:'B',new_string:'$&$1'}],
  ['edit',{path:'a/b.txt',old_string:'B',new_string:'$&$1',replace_all:true}],['read',{path:'a/b.txt',offset:2,limit:1}],
  ['edit',{path:'a/b.txt',old_string:'',new_string:'X'}],['edit',{path:'a/b.txt',old_string:'A',new_string:'A'}],
  ['read',{path:'a/b.txt',offset:1e30}],['read',{path:'a/b.txt',offset:3,limit:1}],
 ]},
 {label:'stale-and-unseen',setup:[{path:'existing',content:'existing content'}],steps:[
  ['write',{path:'existing',content:'bad'}],['edit',{path:'existing',old_string:'existing',new_string:'changed'}],
  ['external',{path:'existing',content:'someone else edited a longer thing'}],['write',{path:'existing',content:'bad'}],
  ['edit',{path:'existing',old_string:'someone',new_string:'bad'}],['write',{path:'existing',append:true,content:'\nappend anyway'}],
  ['write',{path:'existing',content:'fresh now'}],['read',{path:'existing'}],['clear',{}],['read',{path:'existing'}],
 ]},
 {label:'line-and-unicode',setup:[{path:'long',content:'a'.repeat(1999)+'😀tail\r\nnext\n'},{path:'\ue000\ue100�',content:'literal marker'}],steps:[
  ['read',{path:'long',limit:1}],['read',{path:'long',offset:2,limit:1}],['read',{path:'long',offset:9}],
  ['edit',{path:'long',old_string:'\ud83d',new_string:'X'}],['read',{path:'long',offset:1,limit:1}],
  ['write',{path:'lone\ud800',content:'\ud800\udfff 😀 \ue000\ue100'}],['read',{path:'lone\ud800'}],
  ['read',{path:'\ue000\ue100\ud800'}],
 ]},
 {label:'near-lines-and-directory',setup:[{path:'dir',directory:true},{path:'dir/a',content:'alpha\n  wanted line\nwanted line\n'},{path:'empty',content:''},{path:'bin',bytes:[120,0,255]}],steps:[
  ['read',{path:'.'}],['read',{path:'dir'}],['read',{path:'bin'}],['read',{path:'empty'}],
  ['edit',{path:'dir/a',old_string:'\ufeffwanted line\nmissing',new_string:'x'}],['write',{path:'empty',content:'allowed'}],
  ['write',{path:'dir',content:'bad'}],['write',{path:'dir',content:'bad',append:true}],
 ]},
];
const tools=new Map(fsTools().map(t=>[t.name,t]));
const fixtures=[];
for(const scenario of scenarios){
 const root=await mkdtemp(path.join(tmpdir(),'tepora-native-file-oracle-'));
 const reads=new Map();let clear=0;
 const ctx={cwd:root,sandbox:{mode:'off'},files:new Map(),session:{createdAt:'2100-01-01T00:00:00.000Z'},runtime:{priorRead(_s,key,info){const r=reads.get(key);return r&&r.seq>clear&&r.mtimeMs===info.mtimeMs&&r.size===info.size?r.seq:null;}}};
 const clean=value=>{
  if(typeof value==='string')return value.split(root).join('<ROOT>');
  if(Array.isArray(value))return value.map(clean);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='mtimeMs').map(([k,v])=>[k,clean(v)]));
  return value;
 };
 const write=async s=>{const name=path.join(root,s.path);if(s.directory)return mkdir(name,{recursive:true});await mkdir(path.dirname(name),{recursive:true});await writeFile(name,s.bytes?Buffer.from(s.bytes):s.content,'utf8');};
 try{
  for(const setup of scenario.setup)await write(setup);
  const steps=[];
  for(const [tool,args] of scenario.steps){
   let expected;
   if(tool==='external'){await write(args);expected=null;}
   else if(tool==='clear'){clear=steps.length;expected=null;}
   else try{const result=await tools.get(tool).run(args,ctx);if(result.data?.readKey)reads.set(result.data.readKey,{seq:steps.length+1,...result.data});expected={value:clean(result)};}
   catch(e){expected={error:{status:e.status||500,message:clean(e.message)}};}
   steps.push({tool,args,expected});
  }
  const files=[];
  async function walk(dir,relative=''){for(const e of await readdir(dir,{withFileTypes:true})){const rel=relative+e.name;if(e.isDirectory())await walk(path.join(dir,e.name),rel+'/');else files.push({path:rel,bytes:[...await readFile(path.join(dir,e.name))]});}}
  await walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));
  fixtures.push({label:scenario.label,setup:scenario.setup,steps,files});
 }finally{await rm(root,{recursive:true,force:true});}
}
await writeFile(new URL('../src/agent/files/source-fixtures.json',import.meta.url),JSON.stringify(fixtures,null,2)+'\n');
console.log(`Wrote ${fixtures.length} file scenarios, ${fixtures.reduce((n,f)=>n+f.steps.length,0)} steps`);
