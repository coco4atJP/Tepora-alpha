/** Photos for the idle-screen photo frame stay on this PC. Only the file's own signature (and its
 * size, where that is cheap to read) is looked at here; the browser decodes and draws the picture.
 * SVG is refused because it can carry script. Nothing is fetched and nothing leaves the data directory.
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {invariant} from './policy.mjs';

export const MAX_PHOTO_BYTES=24*1024*1024;
export const MAX_PHOTOS=300;
export const MAX_FRAME_BYTES=2*1024*1024*1024;
/** A picture this large would take more memory to draw than a frame should ask for. */
export const MAX_PHOTO_PIXELS=120e6;
const clip=(value,max=120)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const ascii=(bytes,from,to)=>bytes.subarray(from,to).toString('latin1');

export function jpegSize(b){
 let i=2;
 while(i+9<b.length){
  if(b[i]!==0xff){i++;continue;}
  const marker=b[i+1];
  if(marker===0xff){i++;continue;}
  i+=2;
  if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
  if(marker===0xd9)break;
  const length=b.readUInt16BE(i);
  if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return {height:b.readUInt16BE(i+3),width:b.readUInt16BE(i+5)};
  i+=Math.max(2,length);
 }
 return {width:0,height:0};
}
export function webpSize(b){
 const kind=ascii(b,12,16);
 if(kind==='VP8X'&&b.length>=30)return {width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};
 if(kind==='VP8 '&&b.length>=30&&b[23]===0x9d&&b[24]===0x01&&b[25]===0x2a)return {width:b.readUInt16LE(26)&0x3fff,height:b.readUInt16LE(28)&0x3fff};
 if(kind==='VP8L'&&b.length>=25&&b[20]===0x2f)return {width:1+(((b[22]&0x3f)<<8)|b[21]),height:1+(((b[24]&0x0f)<<10)|(b[23]<<2)|((b[22]&0xc0)>>6))};
 return {width:0,height:0};
}

/** The kind of picture and its size: {mime, ext, width, height}. Width and height are 0 when not cheap to read (AVIF). */
export function inspectPhoto(bytes){
 invariant(Buffer.isBuffer(bytes)&&bytes.length>=16,'画像ファイルを選んでください。',400);
 invariant(bytes.length<=MAX_PHOTO_BYTES,`写真は${Math.round(MAX_PHOTO_BYTES/1048576)}MBまでです。`,413);
 let info;
 if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)info={mime:'image/jpeg',ext:'jpg',...jpegSize(bytes)};
 else if(bytes.readUInt32BE(0)===0x89504e47&&bytes.readUInt32BE(4)===0x0d0a1a0a&&ascii(bytes,12,16)==='IHDR')info={mime:'image/png',ext:'png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 else if(['GIF87a','GIF89a'].includes(ascii(bytes,0,6)))info={mime:'image/gif',ext:'gif',width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};
 else if(ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='WEBP')info={mime:'image/webp',ext:'webp',...webpSize(bytes)};
 else if(ascii(bytes,4,8)==='ftyp'&&['avif','avis'].includes(ascii(bytes,8,12)))info={mime:'image/avif',ext:'avif',width:0,height:0};
 invariant(info,'JPEG・PNG・WebP・GIF・AVIFの写真を選んでください。',400);
 if(info.width||info.height){
  invariant(info.width>0&&info.height>0,'画像の大きさを読み取れません。',400);
  invariant(info.width*info.height<=MAX_PHOTO_PIXELS,'画像が大きすぎます。画面に十分な大きさに縮小して選んでください。',413);
 }
 return info;
}

export class PhotoFrame {
 constructor(store){this.store=store;this.dir=path.join(store.dir,'frame');}
 list(){return this.store.value('frame-photos')||[];}
 /** What the screen needs: the list without hashes or file names on disk, and the limits. */
 snapshot(){
  return {photos:this.list().map(({id,name,mime,bytes,width,height,addedAt})=>({id,name,mime,bytes,width,height,addedAt})),
   limits:{maxPhotos:MAX_PHOTOS,maxBytes:MAX_PHOTO_BYTES,maxTotalBytes:MAX_FRAME_BYTES}};
 }
 changed(){const value=this.snapshot();this.store.emit('frame.updated',value);return value;}
 async add(bytes,{filename=''}={}){
  const info=inspectPhoto(bytes),sha256=createHash('sha256').update(bytes).digest('hex'),list=this.list();
  // The same picture twice is one picture.
  if(list.some(p=>p.sha256===sha256))return this.snapshot();
  invariant(list.length<MAX_PHOTOS,`写真は${MAX_PHOTOS}枚までです。`,413);
  invariant(list.reduce((n,p)=>n+p.bytes,0)+bytes.length<=MAX_FRAME_BYTES,'保存できる写真の合計サイズを超えます。',413);
  const id=randomUUID(),file=path.join(this.dir,`${id}.${info.ext}`),temp=path.join(this.dir,`.upload-${randomUUID()}`);
  await mkdir(this.dir,{recursive:true});
  try{await writeFile(temp,bytes,{flag:'wx'});await rename(temp,file);}catch(e){await rm(temp,{force:true});throw e;}
  const name=clip(path.basename(String(filename||'')))||'写真';
  this.store.value('frame-photos',[...list,{id,name,mime:info.mime,ext:info.ext,bytes:bytes.length,sha256,width:info.width,height:info.height,addedAt:new Date().toISOString()}]);
  return this.changed();
 }
 async read(id){
  const meta=this.list().find(p=>p.id===id);invariant(meta,'写真が見つかりません。',404);
  let bytes;try{bytes=await readFile(path.join(this.dir,`${meta.id}.${meta.ext}`));}catch{invariant(false,'写真のファイルが見つかりません。',404);}
  return {meta,bytes};
 }
 async remove(id){
  const list=this.list(),meta=list.find(p=>p.id===id);invariant(meta,'写真が見つかりません。',404);
  await rm(path.join(this.dir,`${meta.id}.${meta.ext}`),{force:true});
  this.store.value('frame-photos',list.filter(p=>p.id!==id));
  return this.changed();
 }
}
