import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('root serve starts beta.11 with protected execution, a persistent character and separate V3 data',{timeout:20000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-v3-root-'));
 const child=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','serve','--','--sidecar'],{
  cwd:root,env:{...process.env,TEPORA_DATA_DIR:dir,TEPORA_PORT:'0'},
  shell:process.platform==='win32',stdio:['pipe','pipe','pipe']
 });
 let ended=false,stderr='';
 const exited=new Promise(resolve=>{child.once('exit',code=>{ended=true;resolve(code);});child.once('error',()=>{ended=true;resolve(-1);});});
 child.stdin.on('error',()=>{});
 child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
 try{
  const ready=await new Promise((resolve,reject)=>{
   let buffer='';const timer=setTimeout(()=>reject(new Error('V3 root startup timed out')),10000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Root service exited ${code}: ${stderr}`));});
   child.stdout.on('data',b=>{
    buffer+=b;let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
     try{const message=JSON.parse(line);if(message.type==='ready'){clearTimeout(timer);resolve(message);}}catch{}
    }
   });
  });
  assert.equal(ready.version,'3.0.0-beta.11');
  const url=new URL(ready.url);
  assert.equal(url.hostname,'127.0.0.1');
  const health=await (await fetch(new URL('/health',url),{signal:AbortSignal.timeout(3000)})).json();
  assert.deepEqual(health,{ok:true,version:'3.0.0-beta.11'});
  const launch=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(3000)});
  assert.equal(launch.status,303);
  const cookie=launch.headers.get('set-cookie').split(';')[0];
  const get=async route=>{
   const response=await fetch(new URL(route,url),{headers:{cookie},signal:AbortSignal.timeout(3000)});
   assert.equal(response.status,200);return response.json();
  };
  assert.equal((await get('/api/execution')).mode,'protected');
  const session=(await get('/api/dialogue')).session;
  assert.ok(session.id);assert.ok(session.character.name);
  assert.equal((await get('/api/dialogue')).session.id,session.id);
  await access(path.join(dir,'tepora-v3.sqlite'));
  child.stdin.write('shutdown\n');
  assert.equal(await exited,0);
 }finally{
  if(!ended){child.stdin.end('shutdown\n');await Promise.race([exited,delay(2000)]);}
  if(!ended){
   if(process.platform==='win32')await new Promise(resolve=>spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'}).once('close',resolve));
   else child.kill('SIGTERM');
   await Promise.race([exited,delay(1000)]);
  }
  await rm(dir,{recursive:true,force:true});
 }
});

test('release notes run from the repository root and use the actual repository Git history',{timeout:10000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-release-'));
 try{
  const output=path.join(dir,'notes.md');
  const child=spawn(process.execPath,['scripts/release_notes.mjs','--to','HEAD','--version','3.0.0-beta.11','--output',output],{cwd:root,stdio:'ignore'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0);
  const notes=await readFile(output,'utf8');
  assert.match(notes,/3\.0\.0-beta\.11/);
  assert.ok(notes.trim().length>0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
