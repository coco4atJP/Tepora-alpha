/** Photos for the idle-screen frame: recognised by signature, kept on this PC, served back unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../core/store.mjs';
import {PhotoFrame,inspectPhoto,MAX_PHOTO_BYTES,MAX_PHOTOS,MAX_PHOTO_PIXELS} from '../core/photo-frame.mjs';
import {startServer} from '../core/server.mjs';

const jpeg=(w,h,pad=0)=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0]),
 Buffer.from([0xff,0xc0,0,17,8,h>>8,h&255,w>>8,w&255,3,1,0x22,0,2,0x11,1,3,0x11,1]),Buffer.alloc(32+pad,7),Buffer.from([0xff,0xd9])]);
const png=(w,h,pad=0)=>{const ihdr=Buffer.alloc(25);ihdr.writeUInt32BE(13,0);ihdr.write('IHDR',4,'latin1');ihdr.writeUInt32BE(w,8);ihdr.writeUInt32BE(h,12);ihdr[16]=8;ihdr[17]=2;
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),ihdr,Buffer.alloc(16+pad,1)]);};
const gif=(w,h)=>Buffer.concat([Buffer.from('GIF89a','latin1'),Buffer.from([w&255,w>>8,h&255,h>>8]),Buffer.alloc(24)]);
const webp=(w,h)=>{const b=Buffer.alloc(34);b.write('RIFF',0,'latin1');b.writeUInt32LE(26,4);b.write('WEBP',8,'latin1');b.write('VP8X',12,'latin1');b.writeUInt32LE(10,16);b.writeUIntLE(w-1,24,3);b.writeUIntLE(h-1,27,3);return b;};
const avif=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypavif','latin1'),Buffer.alloc(32)]);

test('photos are recognised by their signature and measured where that is cheap',()=>{
 assert.deepEqual(inspectPhoto(jpeg(4000,3000)),{mime:'image/jpeg',ext:'jpg',width:4000,height:3000});
 assert.deepEqual(inspectPhoto(png(1600,1000)),{mime:'image/png',ext:'png',width:1600,height:1000});
 assert.deepEqual(inspectPhoto(gif(320,240)),{mime:'image/gif',ext:'gif',width:320,height:240});
 assert.deepEqual(inspectPhoto(webp(2048,1365)),{mime:'image/webp',ext:'webp',width:2048,height:1365});
 assert.deepEqual(inspectPhoto(avif()),{mime:'image/avif',ext:'avif',width:0,height:0});
});
test('SVG, text, truncated, oversized and decompression-bomb files are refused',()=>{
 assert.throws(()=>inspectPhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),/JPEG・PNG/);
 assert.throws(()=>inspectPhoto(Buffer.from('just some text, not a picture at all')),/JPEG・PNG/);
 assert.throws(()=>inspectPhoto(Buffer.from([0xff,0xd8,0xff])),/画像ファイル/);
 assert.throws(()=>inspectPhoto(Buffer.concat([jpeg(10,10),Buffer.alloc(MAX_PHOTO_BYTES)])),/MB/);
 assert.throws(()=>inspectPhoto(png(0,10)),/大きさ/);
 assert.throws(()=>inspectPhoto(png(20000,20000)),/大きすぎ/);
 assert.equal(MAX_PHOTO_PIXELS,120e6);
});

async function withStore(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-frame-'));const store=new Store(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return {dir,store,frame:new PhotoFrame(store)};
}
test('adding is idempotent for the same picture, ignores hostile names and keeps no stray files',async t=>{
 const {dir,store,frame}=await withStore(t),events=[];store.listeners.add(e=>events.push(e));
 const first=await frame.add(png(800,600),{filename:'/etc/passwd\u0000/猫.png'});
 assert.equal(first.photos.length,1);assert.equal(first.photos[0].name,'猫.png');assert.ok(!('sha256' in first.photos[0]));
 const again=await frame.add(png(800,600),{filename:'copy.png'});assert.equal(again.photos.length,1);
 const files=await readdir(path.join(dir,'frame'));assert.equal(files.length,1);assert.ok(files.every(f=>!f.startsWith('.upload-')));
 assert.deepEqual(events.map(e=>e.type),['frame.updated'],'an unchanged list is not announced');
 assert.equal(events[0].data.photos.length,1);
 assert.equal((await frame.add(png(801,600),{filename:''})).photos[1].name,'写真');
});
test('the number of photos is limited, and a rejected one leaves nothing behind',async t=>{
 const {dir,frame}=await withStore(t);
 for(let i=0;i<MAX_PHOTOS;i++)await frame.add(png(100+i,100));
 await assert.rejects(frame.add(png(5000,100)),e=>e.status===413&&/300枚/.test(e.message));
 assert.equal(frame.list().length,MAX_PHOTOS);assert.equal((await readdir(path.join(dir,'frame'))).length,MAX_PHOTOS);
});
test('removing a photo deletes its file and an unknown id is a 404',async t=>{
 const {dir,frame}=await withStore(t);
 const {photos:[photo]}=await frame.add(jpeg(1200,800));
 const {bytes}=await frame.read(photo.id);assert.deepEqual(bytes,jpeg(1200,800));
 const left=await frame.remove(photo.id);assert.deepEqual(left.photos,[]);assert.deepEqual(await readdir(path.join(dir,'frame')),[]);
 await assert.rejects(frame.read(photo.id),e=>e.status===404);await assert.rejects(frame.remove('nope'),e=>e.status===404);
});

async function serviceAt(dir,t){
 const app=await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})});
 t.after(()=>app.close());
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await (await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(p,method='GET',data,headers={})=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(data!==undefined?{body:data}:{})});
 return {...app,request,cookie,bootstrap};
}
test('photos are stored locally, listed, served byte-identical and removable; uploads need CSRF',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-frame-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=await serviceAt(dir,t),bytes=png(1600,1000);
 assert.deepEqual(app.bootstrap.frame.photos,[]);assert.equal(app.bootstrap.frame.limits.maxPhotos,MAX_PHOTOS);
 assert.equal((await fetch(app.origin+'/api/frame/photos',{method:'PUT',headers:{Cookie:app.cookie},body:bytes})).status,403);
 const saved=await (await app.request('/api/frame/photos','PUT',bytes,{'Content-Type':'image/png','X-Tepora-Filename':encodeURIComponent('猫 と 窓.png')})).json();
 assert.equal(saved.photos.length,1);const [photo]=saved.photos;
 assert.equal(photo.name,'猫 と 窓.png');assert.equal(photo.mime,'image/png');assert.equal(photo.width,1600);
 assert.ok(!('sha256' in photo)&&!('ext' in photo),'the list exposes neither hashes nor names on disk');
 const again=await (await app.request('/api/frame/photos','PUT',bytes,{'Content-Type':'image/png'})).json();assert.equal(again.photos.length,1,'the same picture is not added twice');
 const served=await app.request(`/api/frame/photos/${photo.id}`);
 assert.equal(served.status,200);assert.equal(served.headers.get('content-type'),'image/png');assert.match(served.headers.get('cache-control'),/private/);
 assert.equal(served.headers.get('x-content-type-options'),'nosniff');assert.match(served.headers.get('content-security-policy'),/sandbox/);
 assert.deepEqual(Buffer.from(await served.arrayBuffer()),bytes);
 assert.equal((await fetch(`${app.origin}/api/frame/photos/${photo.id}`)).status,401,'photos need the session');
 for(const bad of ['00000000-0000-0000-0000-000000000000','..%2F..%2Fcore%2Fserver.mjs','x'])assert.equal((await app.request(`/api/frame/photos/${bad}`)).status,404,bad);
 const svg=await app.request('/api/frame/photos','PUT',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),{'Content-Type':'image/svg+xml'});
 assert.equal(svg.status,400);assert.equal((await (await app.request('/api/frame')).json()).photos.length,1,'a refused upload changes nothing');
 const gone=await (await app.request(`/api/frame/photos/${photo.id}`,'DELETE')).json();
 assert.deepEqual(gone.photos,[]);assert.equal((await app.request(`/api/frame/photos/${photo.id}`)).status,404);
});
test('photos survive a restart and other windows hear about changes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-frame-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const first=await serviceAt(dir,t),heard=[];first.store.listeners.add(e=>heard.push(e));
 const {photos:[photo]}=await (await first.request('/api/frame/photos','PUT',jpeg(2400,1600),{'Content-Type':'image/jpeg'})).json();
 assert.equal(heard.find(e=>e.type==='frame.updated').data.photos[0].id,photo.id);
 await first.close();
 const second=await serviceAt(dir,t);
 assert.equal(second.bootstrap.frame.photos.length,1);assert.equal(second.bootstrap.frame.photos[0].id,photo.id);
 assert.deepEqual(Buffer.from(await (await second.request(`/api/frame/photos/${photo.id}`)).arrayBuffer()),jpeg(2400,1600));
});
