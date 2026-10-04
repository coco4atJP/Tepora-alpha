/** A local VRM avatar: strict container checks, local-only storage, and the routes that serve it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inspectVRM,MAX_VRM_BYTES} from '../core/character.mjs';
import {startServer} from '../core/server.mjs';

function glb(json,{version=2,lengthDelta=0}={}){
 let text=JSON.stringify(json);while(Buffer.byteLength(text)%4)text+=' ';
 const body=Buffer.from(text),header=Buffer.alloc(20),total=20+body.length;
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(version,4);header.writeUInt32LE(total+lengthDelta,8);header.writeUInt32LE(body.length,12);header.writeUInt32LE(0x4e4f534a,16);
 return Buffer.concat([header,body]);
}
const vrm1=(meta={})=>({asset:{version:'2.0'},extensionsUsed:['VRMC_vrm'],extensions:{VRMC_vrm:{specVersion:'1.0',meta:{name:'Fixture avatar',authors:['Fixture author'],licenseUrl:'https://vrm.dev/licenses/1.0/',avatarPermission:'onlyAuthor',commercialUsage:'personalNonProfit',...meta}}}});
const vrm0={asset:{version:'2.0'},extensionsUsed:['VRM'],extensions:{VRM:{meta:{title:'Legacy avatar',author:'Legacy author',licenseName:'CC_BY',allowedUserName:'Everyone',commercialUssageName:'Allow'}}}};

test('VRM 1.0 and 0.x metadata is read without trusting control characters',()=>{
 const one=inspectVRM(glb(vrm1({name:'Mika\u0000\u0007 avatar'})));
 assert.equal(one.version,'1.0');assert.equal(one.name,'Mika   avatar');assert.deepEqual(one.authors,['Fixture author']);assert.equal(one.commercialUsage,'personalNonProfit');
 const zero=inspectVRM(glb(vrm0));assert.equal(zero.version,'0.x');assert.equal(zero.name,'Legacy avatar');assert.deepEqual(zero.authors,['Legacy author']);assert.equal(zero.license,'CC_BY');
});
test('non-VRM, damaged, external-reference and oversized files are refused',()=>{
 assert.throws(()=>inspectVRM(Buffer.from('not a model at all')),/VRM/);
 assert.throws(()=>inspectVRM(glb(vrm1(),{version:1})),/glTF 2.0/);
 assert.throws(()=>inspectVRM(glb(vrm1(),{lengthDelta:4})),/長さ/);
 assert.throws(()=>inspectVRM(glb({asset:{version:'2.0'}})),/拡張/);
 assert.throws(()=>inspectVRM(glb({...vrm1(),images:[{uri:'https://example.com/face.png'}]})),/外部/);
 assert.throws(()=>inspectVRM(glb({...vrm1(),buffers:[{uri:'body.bin',byteLength:4}]})),/外部/);
 assert.doesNotThrow(()=>inspectVRM(glb({...vrm1(),images:[{uri:'data:image/png;base64,AAAA'}]})));
 assert.throws(()=>inspectVRM(Buffer.alloc(MAX_VRM_BYTES+1)),/MB/);
});

async function service(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-character-'));const app=await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(app.launchUrl,{redirect:'manual'});const cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await (await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(p,method='GET',data,headers={})=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(data!==undefined?{body:data}:{})});
 return {...app,request,cookie,bootstrap};
}
test('the avatar is stored locally, served byte-identical, and removable; uploads need CSRF',async t=>{
 const app=await service(t),bytes=glb(vrm1());assert.equal(app.bootstrap.character,null);
 assert.equal((await fetch(app.origin+'/api/character/model',{method:'PUT',headers:{Cookie:app.cookie},body:bytes})).status,403);
 const saved=await app.request('/api/character/model','PUT',bytes,{'Content-Type':'application/octet-stream','X-Tepora-Filename':encodeURIComponent('ミカ.vrm')});
 assert.equal(saved.status,200);const meta=await saved.json();assert.equal(meta.name,'Fixture avatar');assert.equal(meta.filename,'ミカ.vrm');assert.equal(meta.bytes,bytes.length);assert.equal(meta.revision,1);
 assert.equal((await (await app.request('/api/character')).json()).model.sha256,meta.sha256);
 const served=await app.request('/api/character/model');assert.equal(served.headers.get('content-type'),'model/gltf-binary');assert.deepEqual(Buffer.from(await served.arrayBuffer()),bytes);
 const refused=await app.request('/api/character/model','PUT',Buffer.from('plain text'),{'Content-Type':'application/octet-stream'});assert.equal(refused.status,400);
 assert.equal((await (await app.request('/api/character')).json()).model.sha256,meta.sha256,'a refused upload keeps the previous avatar');
 assert.equal((await app.request('/api/character/model','DELETE')).status,200);assert.equal((await app.request('/api/character/model')).status,404);
});
test('vendored renderer files are served as scripts from the allowlist only; textures may use blob URLs locally',async t=>{
 const app=await service(t);
 for(const file of ['/vrm-stage.mjs','/vendor/three.module.js','/vendor/three-vrm.module.min.js','/vendor/GLTFLoader.js']){const r=await app.request(file);assert.equal(r.status,200,file);assert.match(r.headers.get('content-type'),/javascript/);assert.match(r.headers.get('content-security-policy'),/connect-src 'self' blob:/);}
 for(const file of ['/vendor/VENDOR.json','/vendor/../../core/server.mjs','/vendor/LICENSE-three.txt'])assert.equal((await app.request(file)).status,404,file);
});
test('presence and stacked approval routes are explicit and validated',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/presence','POST',JSON.stringify({state:'asleep'}),{'Content-Type':'application/json'})).status,400);
 const away=await (await app.request('/api/presence','POST',JSON.stringify({state:'away'}),{'Content-Type':'application/json'})).json();assert.equal(away.presence,'away');
 const listed=await (await app.request('/api/approvals')).json();assert.deepEqual(listed.approvals,[]);assert.equal(listed.presence,'away');
 const batch=await (await app.request('/api/approvals','POST',JSON.stringify({ids:['missing'],allow:true}),{'Content-Type':'application/json'})).json();assert.equal(batch.results[0].ok,false);
 assert.equal((await app.request('/api/approvals','POST',JSON.stringify({ids:[],allow:true}),{'Content-Type':'application/json'})).status,400);
});
