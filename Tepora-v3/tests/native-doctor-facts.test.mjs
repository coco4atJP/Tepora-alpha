/** Ordinary read-only doctor system facts. Compare the source response and both
 * native development modes against this host's Node OS facts. No model, GPU,
 * external service, browser or account is probed. Build the core/native service
 * first; the native processes run with an empty executable search path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const nativeNote='Rust開発用ローカル作業領域。モデル・GPU・外部操作の動作確認ではありません。';
const sourceNote='設定の有無であり、実モデル・GPUの動作確認ではありません。';
const systemFields=value=>Object.fromEntries(['platform','arch','ramBytes','cpuThreads'].map(key=>[key,value[key]]));
function deadline(promise,label,ms=20000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);})]).finally(()=>clearTimeout(timer));}

async function client(url,data,close){
 const launch=await fetch(url,{redirect:'manual'});assert.equal(launch.status,303);
 const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(url).origin;
 const json=async route=>{
  const response=await fetch(origin+route,{headers:{Cookie:cookie},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-type'),/^application\/json/);return response.json();
 };
 const bootstrap=await json('/api/bootstrap');
 return {json,data,workspace:bootstrap.workspace,close};
}

async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-doctor-facts-')));
 const empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty);await writeFile(bundle,'// Inert doctor fixture\n');
 let requests=0;
 const denyNetwork=()=>{requests++;throw new Error('Doctor must not query an external service');};
 t.after(()=>assert.equal(requests,0,'source doctor performs no outbound networking'));
 async function source(){
  const data=path.join(dir,'source-設定');
  const app=cleanup.service(await startServer({dir:data,networkOptions:{lookup:denyNetwork,transport:denyNetwork},runtimeFactory:()=>({decide:async()=>null,chat:async()=>{throw new Error('Doctor must not invoke a model');}})}));
  return client(app.launchUrl,data,app.close);
 }
 async function native(agent){
  const data=path.join(dir,agent?'native-agent-設定':'native-workspace-設定');
  const child=spawn(binary,['--dev-native',...(agent?['--agent']:[]),'--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  let stderr='',exit;child.stderr.on('data',value=>stderr=(stderr+value).slice(-20000));child.stdin.on('error',()=>{});
  const exited=new Promise(resolve=>{child.once('error',error=>{exit={error};resolve(exit);});child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);});});
  const lines=createInterface({input:child.stdout});
  const owned=cleanup.service({close:async()=>{
   if(!exit){child.stdin.write('shutdown\n');try{await deadline(exited,'native shutdown');}catch(error){child.kill('SIGKILL');await exited;throw error;}}
   lines.close();assert.equal(exit.code,0,stderr||String(exit.error||exit.signal));
  }});
  const ready=await deadline(Promise.race([new Promise((resolve,reject)=>lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}})),exited.then(()=>{throw new Error('Native startup: '+stderr+(exit.error?.message||''));})]),'native readiness');
  return client(ready.url,data,owned.close);
 }
 return {source,native};
}

test('doctor system facts match the source host in both explicit native modes',{timeout:60000},async t=>{
 const f=await fixture(t),source=await f.source(),baseline=await source.json('/api/doctor');
 const expected={platform:process.platform,arch:process.arch,ramBytes:os.totalmem(),cpuThreads:os.cpus().length};
 assert.deepEqual(systemFields(baseline),expected);
 assert.ok(expected.ramBytes>0);assert.ok(expected.cpuThreads>0);
 assert.equal(baseline.note,sourceNote);assert.equal(baseline.nativeDevelopment,undefined);
 assert.deepEqual(baseline.providers,[]);await source.close();
 for(const agent of [false,true]){
  const app=await f.native(agent),doctor=await app.json('/api/doctor');
  assert.deepEqual(systemFields(doctor),systemFields(baseline),`native --agent=${agent}`);
  assert.equal(doctor.dataLocation,app.data);assert.equal(doctor.workRoot,app.workspace);
  assert.equal(doctor.nativeDevelopment,true);assert.equal(doctor.note,nativeNote);
  assert.equal(doctor.sandbox.platform,process.platform);assert.deepEqual(doctor.providers,[]);
  assert.deepEqual(await app.json('/api/doctor'),doctor,'read-only repeated diagnostics are stable');
  await app.close();
 }
 t.diagnostic(JSON.stringify({...expected,availableParallelism:os.availableParallelism()}));
});
