import {readFile,stat,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** Images in context: dimensions read from the bytes, a token estimate that follows them, and loading that
 * fits what vision APIs accept. Pure JavaScript; resizing and HEIC use macOS `sips` when it is there. */
export const IMAGE_MIME={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'};
const SENDABLE=new Set(Object.values(IMAGE_MIME));
export function imageInfo(b){
 if(!b||b.length<12)return null;
 if(b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47&&b.length>=24)return {mime:'image/png',width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
 if(b[0]===0x47&&b[1]===0x49&&b[2]===0x46)return {mime:'image/gif',width:b.readUInt16LE(6),height:b.readUInt16LE(8)};
 if(b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'&&b.length>=30){
  const kind=b.toString('latin1',12,16);
  if(kind==='VP8X')return {mime:'image/webp',width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};
  if(kind==='VP8L'){const bits=b.readUInt32LE(21);return {mime:'image/webp',width:(bits&0x3fff)+1,height:((bits>>14)&0x3fff)+1};}
  return {mime:'image/webp',width:b.readUInt16LE(26)&0x3fff,height:b.readUInt16LE(28)&0x3fff};
 }
 if(b[0]===0xff&&b[1]===0xd8){
  for(let i=2;i+9<b.length;){
   if(b[i]!==0xff){i++;continue;}
   const marker=b[i+1];if(marker===0xd8||marker===0x01||marker>=0xd0&&marker<=0xd7){i+=2;continue;}
   const len=b.readUInt16BE(i+2);
   if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return {mime:'image/jpeg',width:b.readUInt16BE(i+7),height:b.readUInt16BE(i+5)};
   i+=2+len;
  }
  return {mime:'image/jpeg',width:0,height:0};
 }
 return null;
}
const sizes=new Map();
/** Vision APIs scale large images down to about 1.15 megapixels; a token covers roughly 750 pixels. */
export function imageTokens(url){
 const s=String(url||''),key=s.length+':'+s.slice(-48);
 if(sizes.has(key))return sizes.get(key);
 let tokens=1200;
 const comma=s.indexOf(',');
 if(comma>0){try{const head=Buffer.from(s.slice(comma+1,comma+1+131072),'base64'),info=imageInfo(head);if(info?.width&&info?.height)tokens=Math.max(85,Math.min(1600,Math.ceil(info.width*info.height/750)));}catch{}}
 if(sizes.size>2000)sizes.clear();sizes.set(key,tokens);return tokens;
}
const run=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:30000},(e,out)=>e?reject(e):resolve(out)));
/** Reads an image file as something a vision model accepts: PNG/JPEG/GIF/WebP, at most `maxSide` pixels on
 * the long side and `maxBytes` large. Other formats (HEIC, TIFF, BMP) are converted with sips on macOS. */
export async function loadImage(file,{maxSide=1568,maxBytes=3_500_000}={}){
 let bytes=await readFile(file),info=imageInfo(bytes);
 const big=info&&(Math.max(info.width,info.height)>maxSide||bytes.length>maxBytes);
 if(!info||!SENDABLE.has(info.mime)||big){
  if(process.platform!=='darwin')throw new Error(info?`The image is too large (${info.width}×${info.height}, ${bytes.length} bytes) and cannot be resized here.`:'Unsupported image format.');
  const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-img-'));
  try{
   const out=path.join(dir,'image.jpg');
   await run('/usr/bin/sips',['-s','format','jpeg','-s','formatOptions','80','-Z',String(maxSide),file,'--out',out]);
   bytes=await readFile(out);info=imageInfo(bytes);
  }finally{await rm(dir,{recursive:true,force:true});}
  if(!info)throw new Error('The image could not be converted.');
 }
 return {mime:info.mime,width:info.width,height:info.height,bytes:bytes.length,base64:bytes.toString('base64')};
}
export const isImagePath=file=>/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i.test(file);
export async function imageFileSize(file){try{return (await stat(file)).size;}catch{return 0;}}
