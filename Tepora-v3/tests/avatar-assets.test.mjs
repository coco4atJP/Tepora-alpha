/** What a person brings (a VRM, a picture, a set of pictures, a mesh-avatar-studio project) is judged by its
 * content, kept on this PC under names the person cannot choose, and served back only to the signed-in page. */
import test from 'node:test';
import {serviceCleanup} from './helpers/service-cleanup.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {MAX_PACK_BYTES,MAX_PICTURE_PIXELS,MAX_VRM_BYTES,PACK_MAGIC,inspectImageSet,inspectMeshPack,inspectPicture,inspectVRM,parsePack} from '../core/avatar-inspect.mjs';
import {startServer} from '../core/server.mjs';

/* ---------------- fixtures ---------------- */
function glb(json,{version=2,lengthDelta=0}={}){
 let text=JSON.stringify(json);while(Buffer.byteLength(text)%4)text+=' ';
 const body=Buffer.from(text),header=Buffer.alloc(20),total=20+body.length;
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(version,4);header.writeUInt32LE(total+lengthDelta,8);header.writeUInt32LE(body.length,12);header.writeUInt32LE(0x4e4f534a,16);
 return Buffer.concat([header,body]);
}
const vrm1=(meta={})=>({asset:{version:'2.0'},extensionsUsed:['VRMC_vrm'],extensions:{VRMC_vrm:{specVersion:'1.0',meta:{name:'Fixture avatar',authors:['Fixture author'],licenseUrl:'https://vrm.dev/licenses/1.0/',avatarPermission:'onlyAuthor',commercialUsage:'personalNonProfit',...meta}}}});
const vrm0={asset:{version:'2.0'},extensionsUsed:['VRM'],extensions:{VRM:{meta:{title:'Legacy avatar',author:'Legacy author',licenseName:'CC_BY',allowedUserName:'Everyone',commercialUssageName:'Allow'}}}};
/** Only the signature and header are read, so a header is enough to stand for a picture. */
function png(w=8,h=8,extra=0){
 const b=Buffer.alloc(33+extra);b.writeUInt32BE(0x89504e47,0);b.writeUInt32BE(0x0d0a1a0a,4);b.writeUInt32BE(13,8);b.write('IHDR',12,'latin1');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);b.writeUInt8(8,24);b.writeUInt8(6,25);return b;
}
function pack(kind,files,name='Fixture pack'){
 const list=files.map(([p,bytes])=>({path:p,bytes:Buffer.isBuffer(bytes)?bytes:Buffer.from(typeof bytes==='string'?bytes:JSON.stringify(bytes))}));
 const manifest=Buffer.from(JSON.stringify({kind,name,files:list.map(f=>({path:f.path,size:f.bytes.length}))})),len=Buffer.alloc(4);len.writeUInt32LE(manifest.length);
 return Buffer.concat([PACK_MAGIC,len,manifest,...list.map(f=>f.bytes)]);
}
const EYE=['ball','low','crease','lash'];
const EYE_SHAPE=()=>({x0:0,x1:8,top:Array(24).fill(2),bot:Array(24).fill(6)});
const meshFiles=({rig={},layers={},noEyeRects=false,drop=[],add=[]}={})=>{
 const eyeRects=noEyeRects?{}:Object.fromEntries([0,1].flatMap(i=>EYE.map(p=>[`eye${i}_${p}`,[0,0,8,8]])));
 const files=[['rig.json',{version:1,image:{width:64,height:64},head:{cx:1,cy:1},body:{},face:{},eyes:[EYE_SHAPE(),EYE_SHAPE()],mouth:{},cheeks:[[1,2],[3,4]],mesh:{baseCell:8},view:{padTop:0,padSide:0},...rig}],
  ['built/layers.json',{build:1,layers:{...eyeRects,...layers}}],['built/base.png',png(64,64)],['built/hairmask.png',png(64,64)],
  ...[0,1].flatMap(i=>EYE.map(p=>[`built/eye${i}_${p}.png`,png(8,8)]))];
 return files.filter(([p])=>!drop.includes(p)).concat(add);
};
const setFiles=({sheet={version:1,moods:{idle:'images/idle.png',happy:'images/happy.png'},talkOpen:'images/open.png'},drop=[],add=[]}={})=>
 [['imageset.json',sheet],['images/idle.png',png()],['images/happy.png',png()],['images/open.png',png()]].filter(([p])=>!drop.includes(p)).concat(add);

/* ---------------- inspection ---------------- */
test('VRM 1.0 and 0.x metadata is read without trusting control characters',()=>{
 const one=inspectVRM(glb(vrm1({name:'Mika\u0000\u0007 avatar'})));
 assert.equal(one.version,'1.0');assert.equal(one.name,'Mika   avatar');assert.deepEqual(one.authors,['Fixture author']);assert.equal(one.commercialUsage,'personalNonProfit');
 const zero=inspectVRM(glb(vrm0));assert.equal(zero.version,'0.x');assert.equal(zero.name,'Legacy avatar');assert.deepEqual(zero.authors,['Legacy author']);assert.equal(zero.license,'CC_BY');
});
test('non-VRM, damaged, external-reference and oversized models are refused',()=>{
 assert.throws(()=>inspectVRM(Buffer.from('not a model at all')),/VRM/);
 assert.throws(()=>inspectVRM(glb(vrm1(),{version:1})),/glTF 2.0/);
 assert.throws(()=>inspectVRM(glb(vrm1(),{lengthDelta:4})),/長さ/);
 assert.throws(()=>inspectVRM(glb({asset:{version:'2.0'}})),/拡張/);
 assert.throws(()=>inspectVRM(glb({...vrm1(),images:[{uri:'https://example.com/face.png'}]})),/外部/);
 assert.throws(()=>inspectVRM(glb({...vrm1(),buffers:[{uri:'body.bin',byteLength:4}]})),/外部/);
 assert.doesNotThrow(()=>inspectVRM(glb({...vrm1(),images:[{uri:'data:image/png;base64,AAAA'}]})));
 assert.throws(()=>inspectVRM(Buffer.alloc(MAX_VRM_BYTES+1)),/MB/);
});
test('a picture is recognised by its signature; SVG and anything else are refused',()=>{
 assert.deepEqual([inspectPicture(png(40,30)).mime,inspectPicture(png(40,30)).width,inspectPicture(png(40,30)).height],['image/png',40,30]);
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,20,0,30,3,1,0x22,0,2,0x11,1,3,0x11,1,0,0,0,0]);assert.equal(inspectPicture(jpeg).mime,'image/jpeg');
 assert.equal(inspectPicture(Buffer.concat([Buffer.from('GIF89a'),Buffer.from([4,0,3,0,0,0,0,0,0,0])])).mime,'image/gif');
 const webp=Buffer.alloc(30);webp.write('RIFF',0,'latin1');webp.write('WEBP',8,'latin1');webp.write('VP8X',12,'latin1');webp.writeUIntLE(99,24,3);webp.writeUIntLE(49,27,3);
 assert.deepEqual([inspectPicture(webp).mime,inspectPicture(webp).width,inspectPicture(webp).height],['image/webp',100,50]);
 for(const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),Buffer.from('plain text file here'),Buffer.from('<?xml version="1.0"?><svg/>padpadpad'),Buffer.alloc(8)])assert.throws(()=>inspectPicture(bad),/画像|SVG/);
 assert.throws(()=>inspectPicture(png(20000,20)),/大きすぎ/);assert.throws(()=>inspectPicture(png(9000,9000)),/小さく/);assert.ok(9000*9000>MAX_PICTURE_PIXELS);
 assert.throws(()=>inspectPicture(png(0,10)),/読み取れ/);
 assert.throws(()=>inspectPicture(png(10,10),{mimes:['image/jpeg']}),/JPEG/);
});
test('a pack is only what it says it is: safe names, exact sizes, no overlap',()=>{
 const ok=parsePack(pack('imageset',[['imageset.json','{}'],['images/a.png',png()]]));assert.equal(ok.kind,'imageset');assert.deepEqual(ok.files.map(f=>f.path),['imageset.json','images/a.png']);assert.equal(ok.name,'Fixture pack');
 assert.throws(()=>parsePack(Buffer.from('TPAK2\n....')),/読み取れ/);assert.throws(()=>parsePack(Buffer.alloc(40)),/読み取れ/);
 for(const bad of ['../x.png','a/../b.png','/abs.png','a//b.png','.hidden','a/.b.png','a\\b.png','dir/','C:/x.png','x'.repeat(130)+'.png','a/b/c/d/e/f.png',''])assert.throws(()=>parsePack(pack('mesh',[[bad,'x']])),/ファイル名|ファイル/,`path ${JSON.stringify(bad).slice(0,30)}`);
 assert.throws(()=>parsePack(pack('mesh',[['a.png','x'],['A.PNG','y']])),/重なって/);
 assert.throws(()=>parsePack(pack('vrm',[['a.png','x']])),/種類/);
 const lie=pack('mesh',[['a.png','12345']]);assert.throws(()=>parsePack(Buffer.concat([lie,Buffer.from('extra')])),/長さ/);assert.throws(()=>parsePack(lie.subarray(0,lie.length-2)),/長さ/);
 assert.throws(()=>parsePack(pack('mesh',Array.from({length:201},(_,i)=>[`f${i}.png`,'x']))),/個/);
 assert.throws(()=>parsePack(pack('mesh',[['a.png','x']]),{maxBytes:10}),/MB/);assert.ok(MAX_PACK_BYTES>=96*1024*1024);
});
test('a mesh-avatar-studio project is accepted when complete and refused when anything is off',()=>{
 const parsed=files=>inspectMeshPack(parsePack(pack('mesh',files)).files);
 const ok=parsed(meshFiles());assert.deepEqual(ok.meta,{rigVersion:1,width:64,height:64,layers:8,sprites:false});assert.equal(ok.files.find(f=>f.path==='rig.json').mime,'application/json');assert.equal(ok.files.find(f=>f.path==='built/base.png').mime,'image/png');
 assert.equal(parsed(meshFiles({add:[['built/sprites/sprites.json',{build:1,layers:{mouth_a:[0,0,4,4]}}],['built/sprites/mouth_a.png',png(4,4)]]})).meta.sprites,true);
 assert.throws(()=>parsed(meshFiles({drop:['built/hairmask.png']})),/必要なファイル/);assert.throws(()=>parsed(meshFiles({drop:['rig.json']})),/rig\.json/);
 assert.throws(()=>parsed(meshFiles({add:[['source.png',png()]]})),/使えないファイル/);assert.throws(()=>parsed(meshFiles({add:[['built/evil.svg','<svg/>']]})),/使えないファイル/);assert.throws(()=>parsed(meshFiles({add:[['built/x.png.exe','MZ']]})),/使えないファイル/);
 assert.throws(()=>parsed(meshFiles({rig:{version:2}})),/version 1/);assert.throws(()=>parsed(meshFiles({rig:{image:{width:1e6,height:10}}})),/画像サイズ/);assert.throws(()=>parsed(meshFiles({rig:{image:{width:64.5,height:64}}})),/画像サイズ/);
 assert.throws(()=>parsed(meshFiles({rig:{eyes:[{}]}})),/目・頬/);assert.throws(()=>parsed(meshFiles({rig:{head:'x'}})),/構成/);
 assert.throws(()=>inspectMeshPack(parsePack(pack('mesh',[...meshFiles({drop:['rig.json']}),['rig.json','{"version":1,"image":{"width":64,"height":64},"x":1e999,"head":{},"body":{},"face":{},"eyes":[{},{}],"mouth":{},"cheeks":[1,2],"mesh":{}}']])).files),/数値でない/);
 assert.throws(()=>inspectMeshPack(parsePack(pack('mesh',[...meshFiles({drop:['rig.json']}),['rig.json','{"version":1,"__proto__":{"x":1},"image":{"width":64,"height":64}}']])).files),/項目名|構成/);
 assert.throws(()=>parsed(meshFiles({layers:{bad:[1,2,3,4]}})),/層の画像がありません/);assert.throws(()=>parsed(meshFiles({layers:{'../x':[1,2,3,4]}})),/層の指定/);assert.throws(()=>parsed(meshFiles({layers:{eye0_ball:'nope'}})),/層の指定/);
 assert.throws(()=>parsed(meshFiles({noEyeRects:true})),/目の層/);
 assert.throws(()=>parsed(meshFiles({drop:['built/base.png'],add:[['built/base.png','not a png at all, really']]})),/画像/);
 assert.throws(()=>parsed(meshFiles({drop:['built/base.png'],add:[['built/base.png',png(9000,100)]]})),/大きすぎ/);
});
test('a mesh rig cannot ask the engine for a mesh that would freeze the page, or for parts the project does not have',()=>{
 const parsed=files=>inspectMeshPack(parsePack(pack('mesh',files)).files);
 // a cell of zero or less would never finish; a huge grid would hang for minutes
 for(const bad of [0,-8,Infinity,'8',null])assert.throws(()=>parsed(meshFiles({rig:{mesh:{baseCell:bad}}})),/baseCell|数値でない/,String(bad));
 assert.throws(()=>parsed(meshFiles({rig:{mesh:{baseCell:8,eyeCell:0}}})),/eyeCell/);assert.throws(()=>parsed(meshFiles({rig:{mesh:{baseCell:8,spriteCell:5000}}})),/spriteCell/);
 assert.throws(()=>parsed(meshFiles({rig:{mesh:{baseCell:1},image:{width:8000,height:8000}}})),/細かすぎ/);
 assert.throws(()=>parsed(meshFiles({rig:{mesh:{baseCell:8,fine:{x0:0,x1:64,y0:0,y1:64,cell:0}}}})),/細かい/);assert.throws(()=>parsed(meshFiles({rig:{mesh:{baseCell:8,fine:{x0:0,x1:8000,y0:0,y1:8000,cell:1}}}})),/細かすぎ/);
 assert.doesNotThrow(()=>parsed(meshFiles({rig:{mesh:{baseCell:8,eyeBallCell:4,eyeCell:4,tasselCell:8,handCell:8,spriteCell:4,fine:{x0:8,x1:40,y0:8,y1:40,cell:4}}}})));
 assert.throws(()=>parsed(meshFiles({layers:{eye0_ball:[0,0,-1,8]}})),/層の大きさ/);assert.throws(()=>parsed(meshFiles({layers:{eye0_ball:[0,0,9000,8]}})),/層の大きさ/);
 assert.throws(()=>parsed(meshFiles({rig:{view:undefined}})),/view/);assert.throws(()=>parsed(meshFiles({rig:{view:{padTop:7}}})),/view/);
 // the shape of the eyes: 24 samples from corner to corner
 assert.throws(()=>parsed(meshFiles({rig:{eyes:[{},{}]}})),/目の形/);assert.throws(()=>parsed(meshFiles({rig:{eyes:[EYE_SHAPE(),{...EYE_SHAPE(),top:[1,2,3]}]}})),/目の形/);assert.throws(()=>parsed(meshFiles({rig:{eyes:[EYE_SHAPE(),{...EYE_SHAPE(),x1:-1}]}})),/目の形/);
 // hair, tassels and the hand: bounded and complete
 const strand={name:'bang0',nodes:[[1,1],[2,5],[3,9],[4,13]],sigma:6,max:4,k:1};
 assert.doesNotThrow(()=>parsed(meshFiles({rig:{strands:[strand]}})));
 assert.throws(()=>parsed(meshFiles({rig:{strands:Array.from({length:65},()=>strand)}})),/多すぎ/);assert.throws(()=>parsed(meshFiles({rig:{strands:[{...strand,name:7}]}})),/髪/);assert.throws(()=>parsed(meshFiles({rig:{strands:[{...strand,nodes:[[1,1]]}]}})),/髪/);assert.throws(()=>parsed(meshFiles({rig:{strands:[{...strand,sigma:0}]}})),/髪/);
 const tassel={name:'tassel',pivot:[2,2],tip:[2,12],split:.5};
 assert.throws(()=>parsed(meshFiles({rig:{accessories:[tassel]}})),/飾りの画像/);assert.throws(()=>parsed(meshFiles({layers:{tassel:[0,0,8,8]},rig:{accessories:[tassel]}})),/層の画像がありません/);
 assert.doesNotThrow(()=>parsed(meshFiles({layers:{tassel:[0,0,8,8]},add:[['built/tassel.png',png(8,8)]],rig:{accessories:[tassel]}})));
 assert.throws(()=>parsed(meshFiles({rig:{accessories:[{...tassel,name:'../x'}]}})),/飾り/);assert.throws(()=>parsed(meshFiles({rig:{hand:{}}})),/手の画像/);
 assert.doesNotThrow(()=>parsed(meshFiles({layers:{hand:[0,0,8,8]},add:[['built/hand.png',png(8,8)]],rig:{hand:{}}})));
 assert.throws(()=>parsed(meshFiles({drop:['built/base.png'],add:[['built/base.png',png(8000,7000)]]})),/小さく|大きすぎ/);
});
test('a mood set needs an idle picture and only names pictures it contains',()=>{
 const parsed=files=>inspectImageSet(parsePack(pack('imageset',files)).files);
 const ok=parsed(setFiles());assert.deepEqual(ok.meta,{moods:['idle','happy'],talkOpen:true,width:8,height:8});
 assert.throws(()=>parsed(setFiles({sheet:{version:1,moods:{happy:'images/happy.png'}}})),/いつも/);
 assert.throws(()=>parsed(setFiles({sheet:{version:1,moods:{idle:'images/idle.png',angry:'images/happy.png'}}})),/気分/);
 assert.throws(()=>parsed(setFiles({sheet:{version:1,moods:{idle:'images/none.png'}}})),/気分/);
 assert.throws(()=>parsed(setFiles({sheet:{version:1,moods:{idle:'images/idle.png'},talkOpen:'images/none.png'}})),/口を開けた/);
 assert.throws(()=>parsed(setFiles({sheet:{version:1,moods:{idle:'images/idle.png'},script:'x'}})),/使えない項目/);
 assert.throws(()=>parsed(setFiles({drop:['imageset.json']})),/imageset\.json/);
 assert.throws(()=>parsed(setFiles({add:[['images/x.svg','<svg/>']]})),/使えないファイル/);assert.throws(()=>parsed(setFiles({add:[['other/x.png',png()]]})),/使えないファイル/);
 assert.throws(()=>parsed(setFiles({add:Array.from({length:12},(_,i)=>[`images/e${i}.png`,png()])})),/12枚/);
 assert.throws(()=>parsed(setFiles({add:[['images/big.png',png(5000,5000)]]})),/小さく/);
});

/* ---------------- the service ---------------- */
async function service(t,{dir}={}){
 const cleanup=serviceCleanup(t);dir||=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-avatar-')));
 const app=cleanup.service(await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})}));
 const close=app.close;
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await (await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(p,method='GET',data,headers={})=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(data!==undefined?{body:data}:{})});
 const json=async(p,method,data)=>request(p,method,data===undefined?undefined:JSON.stringify(data),{'Content-Type':'application/json'});
 const upload=(kind,bytes,filename='fixture.bin')=>request('/api/avatar/assets','PUT',bytes,{'Content-Type':'application/octet-stream','X-Tepora-Asset-Kind':kind,'X-Tepora-Filename':encodeURIComponent(filename)});
 return {...app,dir,request,json,upload,cookie,bootstrap,close};
}
const PNG=png(16,16,40);

test('the avatar starts as しろ・改 and its changes need the page\'s own token',async t=>{
 const app=await service(t);
 assert.equal(app.bootstrap.avatar.body,'shiro');assert.equal(app.bootstrap.avatar.revision,0);assert.deepEqual(app.bootstrap.avatarAssets.assets,[]);assert.ok(!('character' in app.bootstrap));assert.ok(!('companion' in app.bootstrap.display));
 assert.equal((await fetch(app.origin+'/api/avatar/assets',{method:'PUT',headers:{Cookie:app.cookie,'X-Tepora-Asset-Kind':'image'},body:PNG})).status,403);
 assert.equal((await fetch(app.origin+'/api/avatar',{method:'PATCH',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(app.origin+'/api/avatar',{headers:{}})).status,401);
 assert.equal((await app.request('/api/character')).status,404,'the old single-model routes are gone');
});

test('a VRM is stored once, served byte-identical with strict headers, and removable',async t=>{
 const app=await service(t),bytes=glb(vrm1());
 const saved=await app.upload('vrm',bytes,'ミカ.vrm');assert.equal(saved.status,200);const body=await saved.json(),asset=body.asset;
 assert.equal(asset.kind,'vrm');assert.equal(asset.name,'Fixture avatar');assert.equal(asset.meta.version,'1.0');assert.deepEqual(asset.files.map(f=>f.path),['file']);assert.ok(!JSON.stringify(body).includes('sha256'),'no hashes leave the service');
 assert.deepEqual((await (await app.request('/api/avatar/assets')).json()).assets.map(a=>a.id),[asset.id]);
 const served=await app.request(`/api/avatar/assets/${asset.id}/files/file`);
 assert.equal(served.status,200);assert.equal(served.headers.get('content-type'),'model/gltf-binary');assert.equal(served.headers.get('x-content-type-options'),'nosniff');assert.match(served.headers.get('content-security-policy'),/sandbox/);
 assert.deepEqual(Buffer.from(await served.arrayBuffer()),bytes);
 assert.equal((await app.request(`/api/avatar/assets/${asset.id}/files/file`,'HEAD')).status,200);
 const again=await (await app.upload('vrm',bytes,'copy.vrm')).json();assert.equal(again.existing,true);assert.equal(again.assets.length,1,'the same file twice is one file');
 assert.equal((await app.request(`/api/avatar/assets/${asset.id}`,'DELETE')).status,200);assert.equal((await app.request(`/api/avatar/assets/${asset.id}/files/file`)).status,404);
 assert.equal((await app.request(`/api/avatar/assets/${asset.id}`,'DELETE')).status,404);
 assert.deepEqual(await readdir(path.join(app.dir,'avatar')).catch(()=>[]),[]);
});

test('anything that is not what it claims is refused and leaves the library as it was',async t=>{
 const app=await service(t);
 const refuse=async(kind,bytes,status=400)=>{const r=await app.upload(kind,bytes);assert.equal(r.status,status,`${kind} ${String(bytes).slice(0,12)}`);};
 await refuse('vrm',Buffer.from('plain text'));await refuse('vrm',PNG);await refuse('image',glb(vrm1()));await refuse('image',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>padding padding'));
 await refuse('image',png(50000,50000),413);await refuse('mesh',PNG);await refuse('imageset',glb(vrm1()));await refuse('mesh',pack('imageset',setFiles()));await refuse('door',PNG);await refuse('',PNG);await refuse('mesh',Buffer.alloc(0));
 await refuse('mesh',pack('mesh',meshFiles({drop:['built/base.png']})));await refuse('mesh',pack('mesh',meshFiles({add:[['built/shell.sh','#!/bin/sh']]})));
 assert.deepEqual((await (await app.request('/api/avatar/assets')).json()).assets,[]);
});

test('pictures, mood sets and mesh projects are stored under index names and served by their logical paths',async t=>{
 const app=await service(t);
 const image=(await (await app.upload('image',PNG,'pic.png')).json()).asset;assert.equal(image.kind,'image');assert.deepEqual(image.meta,{mime:'image/png',width:16,height:16});
 const served=await app.request(`/api/avatar/assets/${image.id}/files/file`);assert.equal(served.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await served.arrayBuffer()),PNG);
 const set=(await (await app.upload('imageset',pack('imageset',setFiles(),'ミカの表情'))).json()).asset;assert.equal(set.name,'ミカの表情');assert.deepEqual(set.meta.moods,['idle','happy']);
 assert.equal((await app.request(`/api/avatar/assets/${set.id}/files/images/idle.png`)).headers.get('content-type'),'image/png');
 assert.equal((await app.request(`/api/avatar/assets/${set.id}/files/imageset.json`)).headers.get('content-type'),'application/json');
 const mesh=(await (await app.upload('mesh',pack('mesh',meshFiles(),'Miko test'))).json()).asset;assert.equal(mesh.kind,'mesh');assert.equal(mesh.meta.layers,8);assert.ok(mesh.files.some(f=>f.path==='built/eye1_lash.png'));
 const rig=await (await app.request(`/api/avatar/assets/${mesh.id}/files/rig.json`)).json();assert.equal(rig.version,1);
 const names=await readdir(path.join(app.dir,'avatar',mesh.id));assert.ok(names.every(n=>/^\d+$/.test(n)),`files are named by index: ${names.join(',')}`);
 for(const bad of ['..%2f..%2frig.json','%2e%2e/rig.json','built%2f..%2frig.json','..%2frig.json','%2e%2e%2frig.json','nothing.png','built/','built%2fbase.png%00'])assert.equal((await app.request(`/api/avatar/assets/${mesh.id}/files/${bad}`)).status,404,bad);
 assert.equal((await app.request(`/api/avatar/assets/${'0'.repeat(8)}-0000-4000-8000-000000000000/files/file`)).status,404);
 assert.equal((await app.request('/api/avatar/assets/../../etc/passwd/files/file')).status,404);
});

test('the avatar wears a file only when it exists and is the right kind; removing the file takes the avatar off it',async t=>{
 const app=await service(t);
 const patch=(p,rev)=>app.json('/api/avatar','PATCH',{patch:p,expectedRevision:rev});
 const vrm=(await (await app.upload('vrm',glb(vrm1()))).json()).asset,image=(await (await app.upload('image',PNG)).json()).asset;
 assert.equal((await patch({body:'vrm'},0)).status,409,'a body that wears a file needs one');
 assert.equal((await patch({body:'vrm',asset:'11111111-1111-4111-8111-111111111111'},0)).status,409,'a file that is not there');
 assert.equal((await patch({body:'vrm',asset:image.id},0)).status,409,'the wrong kind of file');
 assert.equal((await patch({body:'shiro',asset:vrm.id},0)).status,400,'a drawn body does not wear a file');
 const worn=await (await patch({body:'vrm',asset:vrm.id,lamp:{shape:'none'}},0)).json();assert.equal(worn.body,'vrm');assert.equal(worn.asset,vrm.id);assert.equal(worn.revision,1);
 assert.equal((await patch({palette:'sakura'},0)).status,409,'a stale window cannot overwrite a newer change');
 const gone=await (await app.request(`/api/avatar/assets/${vrm.id}`,'DELETE')).json();assert.equal(gone.removed,vrm.id);
 const after=await (await app.request('/api/avatar')).json();assert.equal(after.body,'shiro');assert.equal(after.asset,null);assert.equal(after.revision,2);
 const back=await (await app.json('/api/avatar/undo','POST',{expectedRevision:2})).json();assert.equal(back.body,'shiro','an earlier look that wore the removed file falls back instead of breaking');
});

test('settings can be undone, reset, exported and imported; hostile settings are refused',async t=>{
 const app=await service(t);
 const patch=(p,rev)=>app.json('/api/avatar','PATCH',{patch:p,expectedRevision:rev});
 const a=await (await patch({palette:'sakura',lamp:{hue:'plum',shape:'flame'},props:{hobby:'cup'},slots:{shape:'mochi'}},0)).json();assert.equal(a.palette,'sakura');assert.equal(a.revision,1);
 const b=await (await patch({body:'kitsune'},1)).json();assert.equal(b.body,'kitsune');assert.equal(b.palette,'sakura');assert.equal(b.lamp.hue,'plum');
 const undone=await (await app.json('/api/avatar/undo','POST',{expectedRevision:2})).json();assert.equal(undone.body,'shiro');assert.equal(undone.revision,3);assert.equal(undone.slots.shape,'mochi');
 assert.equal((await app.json('/api/avatar/undo','POST',{expectedRevision:0})).status,409);
 const preset=await (await app.request('/api/avatar/export')).json();assert.equal(preset.format,'tepora-avatar');assert.equal(preset.settings.palette,'sakura');assert.ok(!('asset' in preset.settings));
 const reset=await (await app.json('/api/avatar/reset','POST',{expectedRevision:3})).json();assert.equal(reset.body,'shiro');assert.equal(reset.palette,'washi');assert.deepEqual(reset.slots,{});
 const imported=await (await app.json('/api/avatar/import','POST',{preset,expectedRevision:4})).json();assert.equal(imported.palette,'sakura');assert.equal(imported.lamp.shape,'flame');
 for(const hostile of [{onclick:'x'},{lamp:{hue:'amber'}},{body:'vrm',asset:'../../x'},{endpoint:'http://evil.example'},{slots:{shape:'<script>'}},{size:99}]){
  assert.equal((await patch(hostile,5)).status,400,JSON.stringify(hostile));
 }
 assert.equal((await app.json('/api/avatar/import','POST',{preset:{format:'tepora-avatar',version:1,settings:{},capabilities:{shell:true}},expectedRevision:5})).status,400);
 assert.equal((await app.json('/api/avatar/import','POST',{preset:{format:'tepora-avatar',version:1,settings:{asset:'11111111-1111-4111-8111-111111111111'}},expectedRevision:5})).status,400);
 assert.equal((await (await app.request('/api/avatar')).json()).revision,5,'nothing hostile changed anything');
});

test('a preset for a body that wears a file uses the newest file of that kind, or says what is missing',async t=>{
 const app=await service(t);
 const wearing={format:'tepora-avatar',version:1,settings:{body:'vrm',palette:'sora'}};
 assert.equal((await app.json('/api/avatar/import','POST',{preset:wearing,expectedRevision:0})).status,409,'no model to wear yet');
 const first=(await (await app.upload('vrm',glb(vrm1({name:'First'})))).json()).asset,second=(await (await app.upload('vrm',glb(vrm1({name:'Second'})))).json()).asset;
 const result=await (await app.json('/api/avatar/import','POST',{preset:wearing,expectedRevision:0})).json();assert.equal(result.body,'vrm');assert.equal(result.asset,second.id);assert.notEqual(result.asset,first.id);assert.equal(result.palette,'sora');
});

test('the library has a size and a count limit, and everything survives a restart',async t=>{
 const first=await service(t);
 const dir=first.dir,ids=[];
 for(let i=0;i<24;i++){const r=await first.upload('image',png(10+i,10),`p${i}.png`);assert.equal(r.status,200);ids.push((await r.json()).asset.id);}
 assert.equal((await first.upload('image',png(99,10),'one-too-many.png')).status,413);
 await first.json('/api/avatar','PATCH',{patch:{body:'image',asset:ids[3],palette:'felt'},expectedRevision:0});
 await first.close();
 const second=await service(t,{dir});
 assert.equal(second.bootstrap.avatar.body,'image');assert.equal(second.bootstrap.avatar.asset,ids[3]);assert.equal(second.bootstrap.avatar.palette,'felt');assert.equal(second.bootstrap.avatarAssets.assets.length,24);
 assert.equal((await second.request(`/api/avatar/assets/${ids[3]}/files/file`)).status,200);
});

test('a changed file on disk is noticed before it is served',async t=>{
 const app=await service(t);
 const asset=(await (await app.upload('image',PNG)).json()).asset;
 const {writeFile}=await import('node:fs/promises');
 await writeFile(path.join(app.dir,'avatar',asset.id,'0'),Buffer.from('tampered'));
 assert.equal((await app.request(`/api/avatar/assets/${asset.id}/files/file`)).status,409);
});

test('the 3D renderers load only when chosen, with every file they import served and nothing else under vendor',async t=>{
 const app=await service(t);
 const get=p=>fetch(app.origin+p,{headers:{Cookie:app.cookie}});
 // crawl the relative imports of the three lazily loaded renderers: a missing file would only show up when someone picks that body
 const manifest=JSON.parse(await readFile(new URL('../web/vendor/VENDOR.json',import.meta.url),'utf8'));
 const seen=new Set(),queue=['/vrm-stage.mjs','/mesh-avatar.mjs','/three-body.mjs'];
 while(queue.length){
  const p=queue.shift();if(seen.has(p))continue;seen.add(p);
  const res=await get(p);assert.equal(res.status,200,`${p} is served`);assert.match(res.headers.get('content-type'),/javascript/);assert.match(res.headers.get('content-security-policy'),/script-src 'self'/);
  const bytes=Buffer.from(await res.arrayBuffer());
  if(p.startsWith('/vendor/')){const recorded=manifest.files[p.slice('/vendor/'.length)];assert.ok(recorded,`${p} is recorded in VENDOR.json`);assert.equal(createHash('sha256').update(bytes).digest('hex'),recorded.sha256,`${p} is byte-identical to the pinned file`);}
  const source=bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1');   // comments name types, not files
  for(const [,spec] of source.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g))queue.push(new URL(spec,'http://x'+p).pathname);
 }
 for(const need of ['/vendor/three.module.js','/vendor/three.core.js','/vendor/three-vrm.module.min.js','/vendor/GLTFLoader.js','/vendor/mesh-avatar/createMeshAvatar.js','/vendor/mesh-avatar/rig.js','/vendor/mesh-avatar/renderer.js','/vendor/mesh-avatar/motion.js','/vendor/mesh-avatar/kana.js'])assert.ok(seen.has(need),`${need} is reached from a renderer`);
 // the same walk sent as raw bytes, which a client library would tidy before sending
 const raw=p=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:new URL(app.origin).port,path:p,headers:{Cookie:app.cookie}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 for(const p of ['/vendor/%2e%2e/core/server.mjs','/vendor/mesh-avatar/%2e%2e/%2e%2e/core/server.mjs','/vendor/mesh-avatar/../../core/server.mjs','/vendor/%2e%2e/%2e%2e/etc/passwd'])assert.equal(await raw(p),404,p);
 for(const p of ['/vendor/VENDOR.json','/vendor/LICENSE-three.txt','/vendor/mesh-avatar/LICENSE','/vendor/mesh-avatar/unknown.js','/vendor/mesh-avatar/../VENDOR.json','/vendor/..%2fcore%2fserver.mjs','/vendor/mesh-avatar/%2e%2e%2f%2e%2e%2fcore%2fserver.mjs','/avatar/model.mjs','/avatar/stage.mjs','/web/app.mjs','/core/server.mjs','/vendor/mesh-avatar/'])assert.equal((await get(p)).status,404,p);
});
