/** Ordinary media embed/view source parity. Synthetic IDs, authenticated local
 * HTTP and inert response-byte inspection only. No browser, video playback,
 * external opener, third-party request, credential or model is used.
 * Build the core and exact native binary before running this file. */
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
const video='Ab0_-Cd1_Ef';
const embedMessage='インターネットを使う道具を許可してください。';
const viewMessage='現在の通信設定では外部メディアを表示しません。';
const html=id=>`<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;overflow:hidden;background:#120c0a}</style><iframe title="YouTube player" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen src="https://www.youtube-nocookie.com/embed/${id}?autoplay=0&amp;playsinline=1&amp;rel=0"></iframe>`;
function deadline(promise,label,ms=20000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);})]).finally(()=>clearTimeout(timer));}
async function client(launchUrl,close,data){
 const launch=await fetch(launchUrl,{redirect:'manual'});assert.equal(launch.status,303);
 const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(launchUrl).origin;
 const bootstrapResponse=await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}});assert.equal(bootstrapResponse.status,200);const bootstrap=await bootstrapResponse.json();
 const request=(route,method='GET',body)=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const json=async(route,method,body,status=200)=>{const response=await request(route,method,body);const value=await response.json();assert.equal(response.status,status,`${route}: ${JSON.stringify(value)}`);assert.equal(response.headers.get('cache-control'),'no-store');return value;};
 const embed=async(id=video)=>{const value=await json('/api/media/embed','POST',{id});assert.deepEqual(Object.keys(value),['path']);assert.match(value.path,/^\/media-view\/[0-9a-f]{64}$/);return value.path;};
 const policy=async patch=>{const old=await json('/api/network');return json('/api/network','PATCH',{patch,expectedRevision:old.revision});};
 return {request,json,embed,policy,close,data,origin};
}
async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-media-embed-')));
 const empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty);await writeFile(bundle,'// Synthetic embed fixture\n');let serial=0,requests=0;
 const denyNetwork=()=>{requests++;throw new Error('Media embed must not fetch any external content');};
 t.after(()=>assert.equal(requests,0,'source media routes perform no outbound networking'));
 async function start(native,{agent=true,data=path.join(dir,`${native?'native':'node'}-${serial++}`)}={}){
  if(!native){const app=cleanup.service(await startServer({dir:data,networkOptions:{lookup:denyNetwork,transport:denyNetwork},runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})}));return client(app.launchUrl,app.close,data);}
  const child=spawn(binary,['--dev-native',...(agent?['--agent']:[]),'--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  let stderr='',exit;child.stderr.on('data',value=>stderr=(stderr+value).slice(-20000));child.stdin.on('error',()=>{});
  const exited=new Promise(resolve=>{child.once('error',error=>{exit={error};resolve(exit);});child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);});});
  const lines=createInterface({input:child.stdout});
  const owned=cleanup.service({close:async()=>{
   if(!exit){child.stdin.write('shutdown\n');try{await deadline(exited,'native shutdown');}catch(error){child.kill('SIGKILL');await exited;throw error;}}
   lines.close();assert.equal(exit.code,0,stderr||String(exit.error||exit.signal));
  }});
  const ready=await deadline(Promise.race([new Promise((resolve,reject)=>lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}})),exited.then(()=>{throw new Error('Native startup: '+stderr+(exit.error?.message||''));})]),'native readiness');
  return client(ready.url,owned.close,data);
 }
 return {start};
}
async function view(c,route,id=video){
 const response=await c.request(route);assert.equal(response.status,200);
 assert.equal(response.headers.get('content-type'),'text/html; charset=utf-8');
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('x-frame-options'),null);
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal(response.headers.get('permissions-policy'),'camera=(), microphone=(self), geolocation=()');
 assert.equal(response.headers.get('content-security-policy'),`default-src 'none'; style-src 'unsafe-inline'; frame-src https://www.youtube-nocookie.com; frame-ancestors ${c.origin}`);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(html(id)));
}
async function failure(c,route,method,body,status,message,blocked=false){
 const response=await c.request(route,method,body);assert.equal(response.status,status);
 assert.deepEqual(await response.json(),{error:message,...(blocked?{blocked:true}:{})});
 assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('x-frame-options'),'DENY');
}

test('media embed/view: exact source HTML bytes, headers and repeatable synthetic handles',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native);
  for(const id of [video,'00000000000','___________','-----------','aB9_zX7-wQ2']){
   const route=await c.embed(id);await view(c,route,id);await view(c,route+'?ignored=1',id);
  }
  const first=await c.embed(),second=await c.embed();assert.notEqual(first,second);await view(c,first);await view(c,second);
  await c.close();
 }
});

test('media embed/view: ordinary source validation, method and missing-handle errors',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native);
  for(const body of [{},{id:null},{id:12345678901},{id:true},{id:[]},{id:{}},{id:''},{id:'a'.repeat(10)},{id:'a'.repeat(12)},{id:' aaaaaaaaaa'},{id:'aaaaaaaaaaa\n'},{id:'あ'.repeat(11)},{id:'abcdefghij.'},{id:'\ud800abcdefghij'},{id:'\ue000abcdefghij'},false,42,[],JSON.stringify(video)]){
   await failure(c,'/api/media/embed','POST',body,400,'Invalid video ID');
  }
  await failure(c,'/api/media/embed','POST','{',400,'Invalid JSON body');
  await failure(c,'/api/media/embed','POST','',400,'Invalid video ID');
  await failure(c,'/api/media/embed','POST',null,500,"Cannot read properties of null (reading 'id')");
  for(const route of ['/media-view/','/media-view/missing','/media-view/missing/part'])await failure(c,route,'GET',undefined,404,'Media view expired');
  const route=await c.embed();
  for(const method of ['GET','PATCH','PUT','DELETE'])await failure(c,'/api/media/embed',method,undefined,404,'Unknown endpoint or HTTP method');
  for(const method of ['POST','PATCH','PUT','DELETE'])await failure(c,route,method,undefined,405,'Method not allowed');
  const head=await c.request(route,'HEAD');assert.equal(head.status,404);assert.equal(await head.text(),'');
  await view(c,route);await c.close();
 }
});

test('media embed/view: 32-entry source FIFO, access does not consume or refresh, restart invalidates',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  let c=await f.start(native);const routes=[];
  for(let i=0;i<32;i++)routes.push(await c.embed(String(i).padStart(11,'0')));
  for(let i=0;i<32;i++)await view(c,routes[i],String(i).padStart(11,'0'));
  await view(c,routes[0],'00000000000');
  const newest=await c.embed();
  await failure(c,routes[0],'GET',undefined,404,'Media view expired');
  await view(c,routes[1],'00000000001');await view(c,newest);
  await c.embed();await failure(c,routes[1],'GET',undefined,404,'Media view expired');
  const data=c.data;await c.close();c=await f.start(native,{data});
  await failure(c,newest,'GET',undefined,404,'Media view expired');
  await view(c,await c.embed());await c.close();
 }
});

test('media embed/view: source network validation order and internetTools disable/re-enable retention',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native),route=await c.embed();
  for(const viaSettings of [false,true]){
   if(viaSettings)await c.json('/api/settings','PATCH',{allowNetwork:false});else await c.policy({internetTools:false});
   await failure(c,'/api/media/embed','POST',{id:'short'},400,'Invalid video ID');
   await failure(c,'/api/media/embed','POST','{',400,'Invalid JSON body');
   await failure(c,'/api/media/embed','POST',{id:video},403,embedMessage,true);
   for(const p of [route,'/media-view/missing'])await failure(c,p,'GET',undefined,403,viewMessage,true);
   if(viaSettings)await c.json('/api/settings','PATCH',{allowNetwork:true});else await c.policy({internetTools:true});
   await view(c,route);
  }
  await c.close();
 }
});

test('media embed/view: offline and trusted-LAN mode changes clear source handles permanently',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native);
  for(const mode of ['offline','trusted-lan']){
   const route=await c.embed();await c.policy({mode});
   await failure(c,'/api/media/embed','POST',{id:'short'},400,'Invalid video ID');
   await failure(c,'/api/media/embed','POST',{id:video},403,embedMessage,true);
   await failure(c,route,'GET',undefined,403,viewMessage,true);
   await c.policy({mode:'online'});
   await failure(c,route,'GET',undefined,404,'Media view expired');
   await view(c,await c.embed());
  }
  await c.close();
 }
});

test('media embed/view: explicit agent-only native availability',{timeout:30000},async t=>{
 const f=await fixture(t),c=await f.start(true,{agent:false});
 assert.equal((await c.request('/api/media/embed','POST',{id:video})).status,503);
 assert.equal((await c.request('/media-view/missing')).status,503);
 await c.close();
});
