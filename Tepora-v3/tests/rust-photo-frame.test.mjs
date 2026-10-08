/** Ordinary photo-frame parity with synthetic inert bytes and a Node-free child. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {PhotoFrame} from '../core/photo-frame.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const png=(w,h,size=40)=>{const b=Buffer.alloc(size);b.set([137,80,78,71,13,10,26,10]);b.write('IHDR',12);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
const deadline=(promise,label,ms=15000)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms)})]).finally(()=>clearTimeout(timer));};
async function fixture(t,{agent=false}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-frame-'));const data=path.join(dir,'data'),empty=path.join(dir,'empty'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty);await writeFile(bundle,'// Synthetic service fixture; no GUI execution');
 const children=[];t.after(async()=>{for(const c of children.reverse())await c.close();await rm(dir,{recursive:true,force:true});});
 const start=async()=>{
  const child=spawn(binary,['--dev-native',...(agent?['--agent']:[]),'--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},windowsHide:true});
  const lines=createInterface({input:child.stdout});let stderr='',exited=false;child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
  const exit=new Promise(resolve=>{child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});});child.once('error',e=>{exited=true;resolve({error:e.message});});});
  const close=async()=>{if(!exited){child.stdin.write('shutdown\n');try{assert.equal((await deadline(exit,'photo service shutdown')).code,0,stderr);}catch(e){child.kill();throw e;}}lines.close();};children.push({close});
  const ready=await deadline(new Promise((resolve,reject)=>{lines.once('line',s=>{try{resolve(JSON.parse(s))}catch(e){reject(e)}});exit.then(v=>reject(new Error(`early exit ${JSON.stringify(v)} ${stderr}`)));}),'photo service readiness');
  const url=new URL(ready.url),origin=url.origin;const launch=await fetch(url,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
  const bootstrap=await (await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
  const request=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(body===undefined?{}:{body})});
  return {close,request,bootstrap};
 };return {dir,data,start};
}
const value=async r=>{assert.equal(r.status,200,await (r.status!==200?r.clone().text():Promise.resolve('')));return r.json();};
test('native photos match source CRUD, bytes, HEAD, ordering, events and restart',async t=>{
 const f=await fixture(t),app=await f.start();assert.deepEqual(app.bootstrap.frame.photos,[]);
 const sourceDir=path.join(f.dir,'source');await mkdir(sourceDir);const values=new Map(),events=[];
 const source=new PhotoFrame({dir:sourceDir,value(k,v){if(arguments.length>1)values.set(k,v);return values.get(k)},emit(type,data){events.push({type,data})}});
 const clean=s=>({...s,photos:s.photos.map(({id,addedAt,...p})=>p)});
 const inputs=[[png(800,600),'猫 と 窓.png'],[png(801,600),'a'.repeat(119)+'😀.png'],[png(802,600),'C:picture.png']];
 for(const [bytes,filename] of inputs){const actual=await value(await app.request('/api/frame/photos','PUT',bytes,{'X-Tepora-Filename':encodeURIComponent(filename)}));const expected=await source.add(bytes,{filename});assert.deepEqual(clean(actual),clean(expected));}
 let listed=await value(await app.request('/api/frame'));assert.equal(listed.photos.length,3);
 const id=listed.photos[0].id;
 const [a,b]=await Promise.all([app.request('/api/frame/photos','PUT',inputs[0][0]),app.request('/api/frame/photos','PUT',inputs[0][0])]);assert.deepEqual(await value(a),listed);assert.deepEqual(await value(b),listed);
 const read=await app.request('/api/frame/photos/'+id);assert.equal(read.headers.get('content-type'),'image/png');assert.equal(read.headers.get('cache-control'),'private, max-age=3600');assert.equal(read.headers.get('content-security-policy'),"default-src 'none'; sandbox");assert.deepEqual(Buffer.from(await read.arrayBuffer()),inputs[0][0]);
 const head=await app.request('/api/frame/photos/'+id,'HEAD');assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),inputs[0][0].length);assert.equal((await head.arrayBuffer()).byteLength,0);
 // Other configuration reset/import operations must not reset the photo list.
 let display=await value(await app.request('/api/display'));
 const preset=await value(await app.request('/api/display/export'));
 const reset=await value(await app.request('/api/display/reset','POST',JSON.stringify({expectedRevision:display.revision}),{'Content-Type':'application/json'}));
 await value(await app.request('/api/display/import','POST',JSON.stringify({expectedRevision:reset.revision,preset}),{'Content-Type':'application/json'}));
 assert.deepEqual(await value(await app.request('/api/frame')),listed);
 const eventResponse=await app.request('/api/events?since=0');const reader=eventResponse.body.getReader();let text='';while((text.match(/"type":"frame.updated"/g)||[]).length<3){const {value:chunk,done}=await deadline(reader.read(),'frame event replay');assert.equal(done,false);text+=new TextDecoder().decode(chunk);}await reader.cancel();
 assert.equal((text.match(/"type":"frame.updated"/g)||[]).length,3);
 await app.close();const restarted=await f.start();assert.deepEqual(restarted.bootstrap.frame,listed);
 const gone=await value(await restarted.request('/api/frame/photos/'+id,'DELETE'));assert.deepEqual(gone.photos.map(p=>p.id),listed.photos.slice(1).map(p=>p.id));assert.equal((await restarted.request('/api/frame/photos/'+id)).status,404);assert.equal((await restarted.request('/api/frame/photos/'+id,'DELETE')).status,404);
 assert.equal((await readdir(path.join(f.data,'frame'))).length,2);
});
test('native photo body limit, invalid-image errors, filenames and missing-file cleanup',async t=>{
 const f=await fixture(t,{agent:true}),app=await f.start();
 for(const bytes of [Buffer.alloc(4),Buffer.from('ordinary text is not an image'),png(0,10),png(20000,20000)]){
  let expected;try{await new PhotoFrame({dir:f.dir,value(){return[]}}).add(bytes)}catch(e){expected=e;}
  const r=await app.request('/api/frame/photos','PUT',bytes);assert.equal(r.status,expected.status);assert.equal((await r.json()).error,expected.message);
 }
 assert.deepEqual((await value(await app.request('/api/frame'))).photos,[]);
 const big=png(1024,768,24*1024*1024);let saved=await value(await app.request('/api/frame/photos','PUT',big,{'X-Tepora-Filename':'bad%escape'}));assert.equal(saved.photos[0].name,'写真');
 const over=await app.request('/api/frame/photos','PUT',Buffer.alloc(big.length+1));assert.equal(over.status,413);assert.equal((await over.json()).error,'ファイルが大きすぎます。');
 const id=saved.photos[0].id;await rm(path.join(f.data,'frame',id+'.png'));
 const missing=await app.request('/api/frame/photos/'+id);assert.equal(missing.status,404);assert.equal((await missing.json()).error,'写真のファイルが見つかりません。');assert.deepEqual((await value(await app.request('/api/frame/photos/'+id,'DELETE'))).photos,[]);
 assert.deepEqual(await readdir(path.join(f.data,'frame')),[]);
});
