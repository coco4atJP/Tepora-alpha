/** Ordinary streaming speech lifecycle parity. Only a synthetic loopback speech
 * worker is used; no external accounts, paid generation, private inputs or
 * model quality are exercised. Build core and this exact native binary first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){for(let n=0;n<400;n++){const result=await fn();if(result)return result;await pause(25);}throw new Error('Timed out: '+label);}
async function client(launchUrl,close,data){
 const launch=await fetch(launchUrl,{redirect:'manual'});assert.equal(launch.status,303);const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(launchUrl).origin;
 const bootstrap=await (await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(body===undefined?{}:{body:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const json=async(route,method,body,status=200)=>{const r=await request(route,method,body);const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
 return {request,json,close,data};
}
async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-speech-http-'))),empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty);await writeFile(bundle,'// Synthetic speech fixture\n');
 const records=[],held=[],sockets=new Set();let hold;
 const mock=createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');records.push({url:req.url,body});
  if(req.url===hold){const entry={res,closed:false};res.once('close',()=>{entry.closed=true;});held.push(entry);return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/start'?{session_id:'synthetic'}:req.url==='/api/chunk'?{text:'partial text'}:req.url==='/api/finish'?{text:'final text'}:{cancelled:true}));
 });
 mock.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${mock.address().port}`;
 cleanup.service({close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>mock.close(resolve));}});
 async function start(native,agent=true){
  const data=path.join(dir,native?'native-'+agent:'node');
  if(!native){const app=cleanup.service(await startServer({dir:data,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})}));return client(app.launchUrl,app.close,data);}
  const child=spawn(binary,['--dev-native',...(agent?['--agent']:[]),'--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  let stderr='',exit;child.stderr.on('data',v=>stderr=(stderr+v).slice(-20000));child.stdin.on('error',()=>{});const exited=new Promise(resolve=>child.once('exit',code=>{exit={code};resolve(exit);}));const lines=createInterface({input:child.stdout});
  const owned=cleanup.service({close:async()=>{if(!exit){child.stdin.write('shutdown\n');const timer=setTimeout(()=>child.kill('SIGKILL'),20000);try{assert.equal((await exited).code,0,stderr);}finally{clearTimeout(timer);}}lines.close();}});
  const ready=await Promise.race([new Promise((resolve,reject)=>lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(e){reject(e);}})),exited.then(()=>{throw new Error('Native startup: '+stderr);})]);return {...await client(ready.url,owned.close,data),trayStop:()=>child.stdin.write('stop\n')};
 }
 return {start,records,held,origin,setHold:route=>{hold=route;}};
}
const pcm=n=>Buffer.alloc(n*4).toString('base64');
test('native speech: ordinary source parity and effect-free mode availability',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native);await c.json('/api/settings','PATCH',{asrStreamUrl:f.origin,voiceEnabled:true});
  const s=await c.json('/api/voice/start','POST');assert.equal(s.sampleRate,16000);assert.equal(s.chunkMs,200);assert.equal(s.maxAudioSeconds,120);
  await c.json('/api/voice/start','POST',undefined,409);
  const body={id:s.id,sequence:0,pcm:pcm(3200)},before=f.records.length;
  const part=await c.json('/api/voice/chunk','POST',body);assert.equal(part.text,'partial text');assert.equal(part.final,false);
  assert.deepEqual(await c.json('/api/voice/chunk','POST',body),part);assert.equal(f.records.length,before+1);
  await c.json('/api/voice/chunk','POST',{...body,pcm:pcm(1)},409);await c.json('/api/voice/chunk','POST',{...body,sequence:2},409);
  for(const patch of [{sequence:-1},{sequence:0.5},{sequence:1,pcm:'%%%%'},{sequence:1,pcm:Buffer.from([0,0,128,127]).toString('base64')},{sequence:1,pcm:pcm(16001)}])await c.json('/api/voice/chunk','POST',{...body,...patch},400);
  assert.deepEqual(await c.json('/api/voice/finish','POST',{id:s.id}),{id:s.id,text:'final text',final:true,submitted:false});
  await c.json('/api/voice/chunk','POST',body,409);await c.json('/api/voice/cancel','POST',{id:s.id});
  const next=await c.json('/api/voice/start','POST');await c.json('/api/voice/cancel','POST',{id:next.id});await c.json('/api/voice/finish','POST',{id:next.id},409);
  await c.json('/api/settings','PATCH',{voiceEnabled:false});await c.json('/api/voice/start','POST',undefined,403);await c.close();
 }
 const offline=await f.start(true,false);for(const route of ['start','chunk','finish','cancel'])await offline.json('/api/voice/'+route,'POST',route==='start'?undefined:{},503);await offline.close();
});
test('native speech: Stop All, tray Stop and shutdown drain pending worker calls',{timeout:90000},async t=>{
 const f=await fixture(t);
 for(const stop of ['http','tray','close'])for(const route of ['start','chunk','finish']){
  const c=await f.start(true);await c.json('/api/settings','PATCH',{asrStreamUrl:f.origin,voiceEnabled:true});
  const s=route==='start'?null:await c.json('/api/voice/start','POST');f.setHold('/api/'+route);const count=f.held.length;
  const pending=c.request('/api/voice/'+route,'POST',route==='start'?undefined:{id:s.id,sequence:0,pcm:pcm(1)}).then(async r=>({status:r.status,body:await r.json()})).catch(error=>({error}));
  await wait(()=>f.held.length===count+1,'held worker '+route);const held=f.held[count];
  if(stop==='http')await c.json('/api/stop','POST',{});else if(stop==='tray')c.trayStop();else await c.close();
  await wait(()=>held.closed,'closed worker transport');const result=await pending;if(stop!=='close')assert.equal(result.status,499,JSON.stringify(result));
  held.res.end(JSON.stringify(route==='start'?{session_id:'late'}:{text:'late'}));f.setHold(undefined);
  if(stop!=='close'){const next=await c.json('/api/voice/start','POST');await c.json('/api/voice/cancel','POST',{id:next.id});await c.close();}
 }
});
