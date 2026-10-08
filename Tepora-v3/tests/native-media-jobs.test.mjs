/** Ordinary media job lifecycle parity. Only a synthetic loopback capability
 * provider is used; no external accounts, paid generation, private inputs or
 * model quality are exercised. Build core and this exact native binary first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
const mp3=Buffer.from('ID3synthetic'),mp4=Buffer.from('0000ftyp00000');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){for(let n=0;n<400;n++){const result=await fn();if(result)return result;await pause(25);}throw new Error('Timed out: '+label);}
async function client(launchUrl,close,data){
 const launch=await fetch(launchUrl,{redirect:'manual'});assert.equal(launch.status,303);const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(launchUrl).origin;
 const bootstrap=await (await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(body===undefined?{}:{body:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const json=async(route,method,body,status=200)=>{const r=await request(route,method,body);const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
 const state=async(id,status)=>wait(async()=>{const j=(await json('/api/media/jobs')).jobs.find(j=>j.id===id);return j?.status===status&&j;},status);
 return {request,json,state,close,data};
}
async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-media-http-'))),empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty);await writeFile(bundle,'// Synthetic media fixture\n');
 const records=[],heldDownloads=[],sockets=new Set();let origin;
 const mock=createServer(async(req,res)=>{
  let chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks),text=raw.toString();let body={};try{body=JSON.parse(text);}catch{}
  records.push({method:req.method,url:req.url,body,raw});
  if(body.prompt==='lost'){req.socket.destroy();return;}
  if(body.prompt==='held')return;
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(body.prompt==='held-download'){json({data:[{url:origin+'/held-download'}]});return;}
  if(req.url==='/held-download'){const held={res,closed:false};res.once('close',()=>{held.closed=true;});heldDownloads.push(held);return;}
  if(req.url==='/v1/audio/speech'){res.end(mp3);return;}
  if(req.url==='/v1/images/generations'||req.url==='/v1/images/edits'){json({data:[{b64_json:png.toString('base64')}]});return;}
  if(req.url==='/v1/videos/generations'){json({request_id:'synthetic-video'});return;}
  if(req.url==='/v1/videos/synthetic-video'){json({status:'done',video:{url:origin+'/video-result'}});return;}
  if(req.url==='/video-result'){res.end(mp4);return;}
  res.writeHead(404);res.end();
 });
 mock.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${mock.address().port}`;
 cleanup.service({close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>mock.close(resolve));}});
 const data=[path.join(dir,'node-data'),path.join(dir,'native-data')];
 const start=async index=>{
  if(index===0){const app=cleanup.service(await startServer({dir:data[0],runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})}));return client(app.launchUrl,app.close,data[0]);}
  const child=spawn(binary,['--dev-native','--agent','--sidecar','--port','0','--data-dir',data[1],'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  let stderr='',exit;child.stderr.on('data',v=>stderr=(stderr+v).slice(-20000));child.stdin.on('error',()=>{});const exited=new Promise(resolve=>child.once('exit',code=>{exit={code};resolve(exit);}));const lines=createInterface({input:child.stdout});
  const owned=cleanup.service({close:async()=>{if(!exit){child.stdin.write('shutdown\n');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);try{assert.equal((await exited).code,0,stderr);}finally{clearTimeout(timer);}}lines.close();}});
  const ready=await Promise.race([new Promise((resolve,reject)=>lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(e){reject(e);}})),exited.then(()=>{throw new Error('Native startup: '+stderr);})]);return {...await client(ready.url,owned.close,data[1]),trayStop:()=>child.stdin.write('stop\n')};
 };
 const clients=[await start(0),await start(1)];
 const profiles=['image','tts','video','image_edit'].map((role,i)=>({id:role,name:'Synthetic '+role,protocol:['openai-images','openai-speech','xai-video','openai-image-edit'][i],baseUrl:origin+'/v1',domain:'device',model:'synthetic',enabled:true}));
 for(const c of clients){const before=await c.json('/api/capabilities');await c.json('/api/capabilities','PUT',{expectedRevision:before.revision,config:{profiles,routes:Object.fromEntries(profiles.map(p=>[p.id,p.id]))}});}
 const body=async(c,kind,id,prompt='synthetic')=>({kind,requestId:id,prompt,profileIdentity:(await c.json('/api/capabilities')).profiles.find(p=>p.id===kind).identity,consent:true});
 return {clients,start,body,records,heldDownloads};
}
test('native media: source-parity jobs, all modalities, ranges, replay and cleanup',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const c of f.clients){
  for(const [kind,bytes,mime] of [['image',png,'image/png'],['tts',mp3,'audio/mpeg'],['video',mp4,'video/mp4']]){
   const body=await f.body(c,kind,kind+'-fixture'),created=await c.json('/api/media/jobs','POST',body,202),ready=await c.state(created.id,'ready');
   assert.equal(ready.asset.mime,mime);assert.equal(ready.providerMayContinue,false);assert.equal(ready.canResume,false);
   const replay=await c.json('/api/media/jobs','POST',body,202);assert.equal(replay.id,created.id);await c.json('/api/media/jobs','POST',{...body,prompt:'changed'},409);
   const route='/api/media/assets/'+ready.asset.id;let r=await c.request(route);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),mime);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
   r=await c.request(route+'?download=1','HEAD');assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(bytes.length));assert.match(r.headers.get('content-disposition'),/^attachment; filename="tepora-/);assert.equal((await r.arrayBuffer()).byteLength,0);
   r=await c.request(route,'GET',undefined,{Range:'bytes=1-3'});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes 1-3/${bytes.length}`);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(1,4));
   if(kind==='image'){
    const edit=await f.body(c,'image_edit','edit-fixture');edit.sourceAssetId=ready.asset.id;const j=await c.json('/api/media/jobs','POST',edit,202);const edited=await c.state(j.id,'ready');assert.equal(edited.asset.mime,'image/png');await c.json('/api/media/jobs/'+j.id,'DELETE');
   }
   assert.deepEqual(await readFile(path.join(c.data,'media',ready.asset.id)),bytes);await c.json('/api/media/jobs/'+created.id,'DELETE');await c.json(route,undefined,undefined,404);
  }
  assert.deepEqual((await c.json('/api/media/jobs')).jobs,[]);
 }
 assert.equal(f.records.filter(r=>r.url==='/v1/images/generations').length,2);
 assert.equal(f.records.filter(r=>r.url==='/v1/images/edits').length,2);
 assert.ok(f.records.filter(r=>r.url==='/v1/images/edits').every(r=>r.raw.includes(Buffer.from('name="image[]"'))));
});
test('native media: lost submission stays unknown across restart, cancellation never replays',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(let i=0;i<2;i++){
  let c=f.clients[i];const lost=await c.json('/api/media/jobs','POST',await f.body(c,'image','lost-request','lost'),202);await c.state(lost.id,'unknown');await c.json('/api/media/jobs/'+lost.id+'/resume','POST',{},409);
  const held=await c.json('/api/media/jobs','POST',await f.body(c,'image','held-request','held'),202);await c.state(held.id,'submitting');const cancelled=await c.json('/api/media/jobs/'+held.id+'/cancel','POST',{});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.providerMayContinue,true);
  await c.close();const count=f.records.length;c=await f.start(i);assert.equal((await c.state(lost.id,'unknown')).canResume,false);await pause(100);assert.equal(f.records.length,count);
 }
 assert.equal(f.records.filter(r=>r.body.prompt==='lost').length,2);
});
test('native media: ordinary request validation and JavaScript input defaults match',{timeout:40000},async t=>{
 const f=await fixture(t),ids=[];
 for(const c of f.clients){
  const base=await f.body(c,'image','defaults');
  for(const [patch,status] of [[{consent:false},403],[{profileIdentity:'stale'},409],[{prompt:'\ufeff'},400],[{options:null},400],[{options:{duration:0}},400],[{options:{size:'tiny'}},400],[{options:{aspectRatio:'bad'}},400],[{requestId:''},400],[{inputId:'missing'},400]])await c.json('/api/media/jobs','POST',{...base,...patch},status);
  const created=await c.json('/api/media/jobs','POST',{...base,options:true,inputId:'',sourceAssetId:''},202);ids.push(created.id);await c.state(created.id,'ready');await c.json('/api/media/jobs/'+created.id,'DELETE');
 }
 assert.equal(ids[0],ids[1]);assert.equal(f.records.length,2);
});

// Deliberate native lifecycle improvement; the Node source status-only Stop All
// currently misses a live worker persisted as awaiting-download.
test('native media: Stop All and tray Stop cancel held downloads without late ready',{timeout:40000},async t=>{
 const f=await fixture(t),c=f.clients[1];
 for(const stop of ['http','tray']){
  const before=f.heldDownloads.length;
  const created=await c.json('/api/media/jobs','POST',await f.body(c,'image','download-stop-'+stop,'held-download'),202);
  await c.state(created.id,'awaiting-download');
  await wait(()=>f.heldDownloads.length===before+1,'download entered transport');
  const held=f.heldDownloads[before];
  if(stop==='http')assert.deepEqual(await c.json('/api/stop','POST',{}),{stopped:true});else c.trayStop();
  const stopped=await c.state(created.id,'cancelled');assert.equal(stopped.providerMayContinue,true);assert.equal(stopped.asset,undefined);
  await wait(()=>held.closed,'owned download connection cancelled');
  held.res.end(png); // A late provider result cannot restore the cancelled job.
  const final=await c.state(created.id,'cancelled');assert.equal(final.asset,undefined);
  await c.json('/api/media/jobs/'+created.id,'DELETE');
 }
 assert.equal(f.records.filter(r=>r.url==='/v1/images/generations').length,2);
 assert.equal(f.records.filter(r=>r.url==='/held-download').length,2);
});
