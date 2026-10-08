/** Synthetic, offline photo-signature parity fixtures; never reads user images. */
import {inspectPhoto} from '../core/photo-frame.mjs';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
const png=(w,h,n=40)=>{const b=Buffer.alloc(n);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IHDR',12);if(n>=20)b.writeUInt32BE(w,16);if(n>=24)b.writeUInt32BE(h,20);return b;};
const cases=[];const add=(name,b)=>{let expected;try{expected={value:inspectPhoto(b)}}catch(e){expected={status:e.status||500,message:e.message}}cases.push({name,hex:b.toString('hex'),expected})};
for(const [w,h] of [[800,600],[0,0],[0,10],[10,0],[12000,10000],[12001,10000],[4294967295,4294967295]])add(`png ${w}x${h}`,png(w,h));
for(let n=16;n<24;n++)add(`png truncated ${n}`,png(1,1,n));
for(let n=0;n<16;n++)add(`short ${n}`,Buffer.alloc(n));
add('unknown text',Buffer.from('ordinary text has no image signature'));
for(const type of ['avif','avis']){const b=Buffer.alloc(24);b.write('ftyp'+type,4);add(type,b)}
for(const type of ['GIF87a','GIF89a']){const b=Buffer.alloc(24);b.write(type);b.writeUInt16LE(320,6);b.writeUInt16LE(240,8);add(type,b)}
for(const type of ['VP8X','VP8 ','VP8L','????']){const b=Buffer.alloc(34);b.write('RIFF');b.write('WEBP'+type,8);if(type==='VP8X'){b.writeUIntLE(2047,24,3);b.writeUIntLE(1364,27,3)}if(type==='VP8 '){b.set([157,1,42],23);b.writeUInt16LE(640,26);b.writeUInt16LE(480,28)}if(type==='VP8L'){b[20]=47;b[21]=63;b[22]=64;b[23]=15;}add(type,b)}
for(const marker of [192,193,194,195,197,198,199,201,202,203,205,206,207]){const b=Buffer.alloc(32);b.set([255,216,255,marker,0,17,8,2,88,3,32]);add(`jpeg SOF ${marker}`,b)}
for(const b of [Buffer.from([255,216,255,...Array(20).fill(0)]),Buffer.from([255,216,255,255,255,1,...Array(20).fill(0)]),Buffer.from([255,216,255,217,...Array(20).fill(0)])])add('jpeg unmeasured '+cases.length,b);
await writeFile(new URL('../native-service/src/workspace/photo_frame/fixtures/source.json',import.meta.url),JSON.stringify({source:'core/photo-frame.mjs',cases,names:['','/','///','a//b///','C:','C:cat.png','C:\\cat\\dog.png','\\\\server\\share','a\u0000b.png','\ufeff x \ufeff','\u0085x\u0085','猫.png','a'.repeat(119)+'😀.png','\ue000\ue123.png'].map(input=>({input,posix:path.posix.basename(input).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120)||'写真',windows:path.win32.basename(input).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120)||'写真'}))},null,2)+'\n');
console.log(`${cases.length} frozen synthetic photo cases`);
