/** Inspect what a person brings for their avatar. Files are judged by their content, never by their
 * name or the type the browser claims. Nothing here fetches anything or trusts a path: files in a
 * pack are named by an index on disk, and the page only ever receives the logical paths listed here.
 * SVG is refused everywhere because it can carry script.
 */
import {invariant} from './policy.mjs';
import {jpegSize,webpSize} from './photo-frame.mjs';
import {AVATAR_MOODS} from '../web/avatar/pose.mjs';

export const MAX_VRM_BYTES=80*1024*1024;
export const MAX_PICTURE_BYTES=16*1024*1024;
export const MAX_PICTURE_PIXELS=40e6;
export const MAX_PACK_BYTES=96*1024*1024;
export const MAX_PACK_FILES=200;
export const MAX_LAYER_PIXELS=60e6;
const MAX_JSON_BYTES=16*1024*1024;
const MAX_RIG_BYTES=2*1024*1024;
const clip=(value,max=160)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const ascii=(bytes,from,to)=>bytes.subarray(from,to).toString('latin1');
const mb=n=>Math.round(n/1048576);

/* ---------------------------------------------------------------- VRM */

/** Parse and validate a GLB container that declares a VRM 1.0 or 0.x humanoid. */
export function inspectVRM(bytes){
 invariant(Buffer.isBuffer(bytes)&&bytes.length>=20,'VRMファイル（.vrm）を選んでください。',400);
 invariant(bytes.length<=MAX_VRM_BYTES,`VRMファイルは${mb(MAX_VRM_BYTES)}MBまでです。`,413);
 invariant(bytes.readUInt32LE(0)===0x46546c67&&bytes.readUInt32LE(4)===2,'glTF 2.0バイナリ（VRM）ではありません。',400);
 invariant(bytes.readUInt32LE(8)===bytes.length,'ファイルの長さが一致しません。破損している可能性があります。',400);
 const jsonLength=bytes.readUInt32LE(12);
 invariant(bytes.readUInt32LE(16)===0x4e4f534a&&jsonLength>0&&jsonLength<=MAX_JSON_BYTES&&20+jsonLength<=bytes.length,'VRMの構造を読み取れません。',400);
 let json;
 try{json=JSON.parse(bytes.subarray(20,20+jsonLength).toString('utf8'));}catch{invariant(false,'VRMの構造を読み取れません。',400);}
 invariant(json&&typeof json==='object'&&!Array.isArray(json),'VRMの構造を読み取れません。',400);
 const used=Array.isArray(json.extensionsUsed)?json.extensionsUsed:[];
 const v1=json.extensions?.VRMC_vrm,v0=json.extensions?.VRM;
 invariant((used.includes('VRMC_vrm')&&v1)||(used.includes('VRM')&&v0),'VRMの拡張情報がありません。VRoid Studioなどで書き出した.vrmを選んでください。',400);
 for(const list of [json.buffers,json.images])for(const item of Array.isArray(list)?list:[]){
  invariant(!item?.uri||/^data:/i.test(item.uri),'外部ファイルを参照するモデルは使えません。埋め込み形式のVRMを選んでください。',400);
 }
 const meta=v1?.meta||{},old=v0?.meta||{};
 return v1?{
  version:'1.0',name:clip(meta.name)||'VRMモデル',authors:(Array.isArray(meta.authors)?meta.authors:[]).map(a=>clip(a,80)).filter(Boolean).slice(0,6),
  license:clip(meta.licenseUrl,300),avatarPermission:clip(meta.avatarPermission,40),commercialUsage:clip(meta.commercialUsage,40),
  allowRedistribution:meta.allowRedistribution===true
 }:{
  version:'0.x',name:clip(old.title)||'VRMモデル',authors:[clip(old.author,80)].filter(Boolean),
  license:clip(old.otherLicenseUrl||old.licenseName,300),avatarPermission:clip(old.allowedUserName,40),commercialUsage:clip(old.commercialUssageName,40),
  allowRedistribution:false
 };
}

/* ---------------------------------------------------------------- pictures */

/** The kind of picture and its size: {mime, ext, width, height}. Width and height are 0 when not cheap to read (AVIF). */
export function inspectPicture(bytes,{maxBytes=MAX_PICTURE_BYTES,maxPixels=MAX_PICTURE_PIXELS,mimes=['image/png','image/jpeg','image/webp','image/avif','image/gif']}={}){
 invariant(Buffer.isBuffer(bytes)&&bytes.length>=16,'画像ファイルを選んでください。',400);
 invariant(bytes.length<=maxBytes,`画像は${mb(maxBytes)}MBまでです。`,413);
 let info;
 if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)info={mime:'image/jpeg',ext:'jpg',...jpegSize(bytes)};
 else if(bytes.readUInt32BE(0)===0x89504e47&&bytes.readUInt32BE(4)===0x0d0a1a0a&&ascii(bytes,12,16)==='IHDR')info={mime:'image/png',ext:'png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 else if(['GIF87a','GIF89a'].includes(ascii(bytes,0,6)))info={mime:'image/gif',ext:'gif',width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};
 else if(ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='WEBP')info={mime:'image/webp',ext:'webp',...webpSize(bytes)};
 else if(ascii(bytes,4,8)==='ftyp'&&['avif','avis'].includes(ascii(bytes,8,12)))info={mime:'image/avif',ext:'avif',width:0,height:0};
 invariant(info&&mimes.includes(info.mime),`${mimes.map(m=>m.slice(6).toUpperCase()).join('・')} の画像を選んでください。SVGは使えません。`,400);
 if(info.width||info.height){
  invariant(info.width>0&&info.height>0,'画像の大きさを読み取れません。',400);
  invariant(info.width<=16384&&info.height<=16384,'画像が大きすぎます。',413);
  invariant(info.width*info.height<=maxPixels,'画像が大きすぎます。小さくしてから選んでください。',413);
 }
 return info;
}

/* ---------------------------------------------------------------- packs */

export const PACK_MAGIC=Buffer.from('TPAK1\n','latin1');
const SAFE_PATH=/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,60}(\/[A-Za-z0-9][A-Za-z0-9_.-]{0,60}){0,3}$/;
const SAFE_NAME=/^[A-Za-z0-9_-]{1,48}$/;

/** A pack is a small container the page builds from a chosen folder: TPAK1, a length, a JSON manifest
 * (kind, name, [{path,size}]) and then the file bytes, in order. Returns {kind, name, files:[{path,bytes}]}. */
export function parsePack(bytes,{maxBytes=MAX_PACK_BYTES,maxFiles=MAX_PACK_FILES}={}){
 invariant(Buffer.isBuffer(bytes)&&bytes.length>PACK_MAGIC.length+4,'素材のまとまりを読み取れません。',400);
 invariant(bytes.length<=maxBytes,`素材は${mb(maxBytes)}MBまでです。`,413);
 invariant(bytes.subarray(0,PACK_MAGIC.length).equals(PACK_MAGIC),'素材のまとまりを読み取れません。',400);
 const length=bytes.readUInt32LE(PACK_MAGIC.length),start=PACK_MAGIC.length+4;
 invariant(length>0&&length<=262144&&start+length<=bytes.length,'素材のまとまりを読み取れません。',400);
 let manifest;
 try{manifest=JSON.parse(bytes.subarray(start,start+length).toString('utf8'));}catch{invariant(false,'素材のまとまりを読み取れません。',400);}
 invariant(manifest&&typeof manifest==='object'&&!Array.isArray(manifest)&&['imageset','mesh'].includes(manifest.kind),'素材の種類が正しくありません。',400);
 invariant(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=maxFiles,`ファイルは1〜${maxFiles}個にしてください。`,400);
 let offset=start+length;const files=[],seen=new Set();
 for(const item of manifest.files){
  invariant(item&&typeof item==='object'&&typeof item.path==='string'&&item.path.length<=120&&SAFE_PATH.test(item.path),'使えないファイル名が含まれています。',400);
  const key=item.path.toLowerCase();invariant(!seen.has(key),'同じ名前のファイルが重なっています。',400);seen.add(key);
  invariant(Number.isSafeInteger(item.size)&&item.size>=0&&offset+item.size<=bytes.length,'ファイルの長さが一致しません。',400);
  files.push({path:item.path,bytes:bytes.subarray(offset,offset+item.size)});offset+=item.size;
 }
 invariant(offset===bytes.length,'ファイルの長さが一致しません。',400);
 return {kind:manifest.kind,name:clip(manifest.name,80),files};
}

function parseJSONFile(file,max,label){
 invariant(file.bytes.length<=max,`${label}が大きすぎます。`,413);
 try{return JSON.parse(file.bytes.toString('utf8'));}catch{invariant(false,`${label}を読み取れません。`,400);}
}
/** Every number in a rig must be finite, and the shape must stay small. */
function boundedJSON(value,depth=0,counter={n:0}){
 invariant(depth<=14&&++counter.n<=200000,'設定ファイルが複雑すぎます。',400);
 if(typeof value==='number')invariant(Number.isFinite(value),'設定ファイルに数値でない値が含まれています。',400);
 else if(Array.isArray(value))for(const item of value)boundedJSON(item,depth+1,counter);
 else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){invariant(key.length<=80&&key!=='__proto__','設定ファイルの項目名が正しくありません。',400);boundedJSON(item,depth+1,counter);}
}

/** What the mesh engine would loop over or index: sizes and counts that could freeze the page, and parts it assumes exist. */
const MESH_CELLS=['baseCell','eyeBallCell','eyeCell','tasselCell','handCell','spriteCell'];
const MAX_GRID_CELLS=400000;
function checkMeshRig(rig,layers,byPath){
 const num=(v,lo,hi)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi;
 const mesh=rig.mesh;
 invariant(num(mesh.baseCell,1,1024),'rig.json のメッシュの細かさ（baseCell）が正しくありません。',400);
 for(const key of MESH_CELLS.slice(1))invariant(mesh[key]===undefined||num(mesh[key],1,1024),`rig.json のメッシュの細かさ（${key}）が正しくありません。`,400);
 invariant(rig.view&&typeof rig.view==='object'&&!Array.isArray(rig.view)&&['padTop','padSide'].every(k=>rig.view[k]===undefined||num(rig.view[k],-1,1)),'rig.json の view が正しくありません。',400);
 const cells=(w,h,cell)=>Math.ceil(w/cell)*Math.ceil(h/cell);
 invariant(cells(rig.image.width,rig.image.height,mesh.baseCell)<=MAX_GRID_CELLS,'メッシュが細かすぎます。baseCell を大きくしてください。',400);
 if(mesh.fine!==undefined){
  const f=mesh.fine;
  invariant(f&&typeof f==='object'&&['x0','x1','y0','y1'].every(k=>Number.isFinite(f[k]))&&num(f.cell,1,1024)&&f.x1>=f.x0&&f.y1>=f.y0,'rig.json の細かいメッシュの範囲が正しくありません。',400);
  invariant(cells(f.x1-f.x0,f.y1-f.y0,f.cell)<=MAX_GRID_CELLS,'メッシュが細かすぎます。fine.cell を大きくしてください。',400);
 }
 for(const [name,rect] of Object.entries(layers.layers)){
  invariant(rect[2]>0&&rect[3]>0&&rect[2]<=8192&&rect[3]<=8192,'layers.json の層の大きさが正しくありません。',400);
  const cell=/_ball$/.test(name)?mesh.eyeBallCell:/^eye\d_/.test(name)?mesh.eyeCell:name==='hand'?mesh.handCell:mesh.tasselCell;
  if(cell!==undefined)invariant(cells(rect[2],rect[3],cell)<=MAX_GRID_CELLS,'メッシュが細かすぎます。',400);
 }
 for(const e of rig.eyes)invariant(e&&typeof e==='object'&&Number.isFinite(e.x0)&&Number.isFinite(e.x1)&&e.x1>e.x0&&['top','bot'].every(k=>Array.isArray(e[k])&&e[k].length===24&&e[k].every(Number.isFinite)),'rig.json の目の形が正しくありません。',400);
 if(rig.strands!==undefined){
  invariant(Array.isArray(rig.strands)&&rig.strands.length<=64,'rig.json の髪の設定が多すぎます。',400);
  for(const st of rig.strands)invariant(st&&typeof st.name==='string'&&st.name.length<=40&&Array.isArray(st.nodes)&&st.nodes.length>=2&&st.nodes.length<=16&&st.nodes.every(n=>Array.isArray(n)&&n.length===2&&n.every(Number.isFinite))&&[st.sigma,st.max,st.k].every(Number.isFinite)&&st.sigma>0,'rig.json の髪の設定が正しくありません。',400);
 }
 if(rig.accessories!==undefined){
  invariant(Array.isArray(rig.accessories)&&rig.accessories.length<=16,'rig.json の飾りの設定が多すぎます。',400);
  for(const a of rig.accessories){
   invariant(a&&typeof a.name==='string'&&SAFE_NAME.test(a.name)&&[a.pivot,a.tip].every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite))&&Number.isFinite(a.split),'rig.json の飾りの設定が正しくありません。',400);
   invariant(layers.layers[a.name]&&byPath.has(`built/${a.name}.png`),`飾りの画像がありません: ${a.name}.png`,400);
  }
 }
 if(rig.hand!==undefined)invariant(rig.hand&&typeof rig.hand==='object'&&layers.layers.hand&&byPath.has('built/hand.png'),'手の画像（hand.png）がありません。',400);
}

/** mesh-avatar-studio output: rig.json plus the layer pictures under built/. Returns {files:[{path,mime,bytes}], meta}. */
export function inspectMeshPack(files){
 const byPath=new Map(files.map(f=>[f.path,f]));
 const allowed=path=>path==='rig.json'||path==='built/layers.json'||path==='built/sprites/sprites.json'||
  /^built\/[A-Za-z0-9_-]{1,48}\.png$/.test(path)||/^built\/sprites\/[A-Za-z0-9_-]{1,48}\.png$/.test(path);
 for(const f of files)invariant(allowed(f.path),`メッシュアバターに使えないファイルが含まれています: ${f.path}`,400);
 const need=['rig.json','built/layers.json','built/base.png','built/hairmask.png',...[0,1].flatMap(i=>['ball','low','crease','lash'].map(p=>`built/eye${i}_${p}.png`))];
 for(const path of need)invariant(byPath.has(path),`メッシュアバターに必要なファイルがありません: ${path}`,400);
 const rig=parseJSONFile(byPath.get('rig.json'),MAX_RIG_BYTES,'rig.json');
 boundedJSON(rig);
 invariant(rig&&typeof rig==='object'&&!Array.isArray(rig)&&rig.version===1,'rig.json は version 1 のものだけ使えます。',400);
 invariant(Number.isInteger(rig.image?.width)&&Number.isInteger(rig.image?.height)&&rig.image.width>0&&rig.image.height>0&&rig.image.width<=8192&&rig.image.height<=8192,'rig.json の画像サイズが正しくありません。',400);
 for(const key of ['head','body','face','mouth','mesh'])invariant(rig[key]&&typeof rig[key]==='object','rig.json の構成が正しくありません。',400);
 invariant(Array.isArray(rig.eyes)&&rig.eyes.length===2&&Array.isArray(rig.cheeks)&&rig.cheeks.length===2,'rig.json の目・頬の設定が正しくありません。',400);
 const layers=parseJSONFile(byPath.get('built/layers.json'),256*1024,'layers.json');
 boundedJSON(layers);
 invariant(layers&&typeof layers==='object'&&layers.layers&&typeof layers.layers==='object'&&!Array.isArray(layers.layers),'layers.json の構成が正しくありません。',400);
 for(const [name,rect] of Object.entries(layers.layers)){
  invariant(SAFE_NAME.test(name)&&Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite),'layers.json の層の指定が正しくありません。',400);
  invariant(byPath.has(`built/${name}.png`),`層の画像がありません: ${name}.png`,400);
 }
 for(const i of [0,1])for(const part of ['ball','low','crease','lash'])invariant(Array.isArray(layers.layers[`eye${i}_${part}`]),`layers.json に目の層の位置がありません: eye${i}_${part}`,400);
 checkMeshRig(rig,layers,byPath);
 if(byPath.has('built/sprites/sprites.json')){
  const sheet=parseJSONFile(byPath.get('built/sprites/sprites.json'),256*1024,'sprites.json');
  boundedJSON(sheet);
  invariant(sheet&&typeof sheet==='object'&&sheet.layers&&typeof sheet.layers==='object','sprites.json の構成が正しくありません。',400);
  for(const name of Object.keys(sheet.layers)){invariant(SAFE_NAME.test(name)&&byPath.has(`built/sprites/${name}.png`),`スプライトの画像がありません: ${name}.png`,400);}
 }
 let pixels=0;const out=[];
 for(const f of files){
  if(f.path.endsWith('.png')){
   const info=inspectPicture(f.bytes,{maxBytes:MAX_PICTURE_BYTES,maxPixels:MAX_PICTURE_PIXELS,mimes:['image/png']});
   invariant(info.width<=8192&&info.height<=8192,'層の画像が大きすぎます。',413);
   pixels+=info.width*info.height;out.push({path:f.path,mime:'image/png',bytes:f.bytes});
  }else out.push({path:f.path,mime:'application/json',bytes:f.bytes});
 }
 invariant(pixels<=MAX_LAYER_PIXELS,'層の画像の合計が大きすぎます。',413);
 return {files:out,meta:{rigVersion:1,width:rig.image.width,height:rig.image.height,layers:Object.keys(layers.layers).length,sprites:byPath.has('built/sprites/sprites.json')}};
}

/** A mood set: imageset.json maps moods to pictures under images/. idle is required; talkOpen is an optional second picture for talking. */
export function inspectImageSet(files){
 const byPath=new Map(files.map(f=>[f.path,f]));
 const picture=/^images\/[A-Za-z0-9_-]{1,48}\.(png|webp|jpg|jpeg|avif)$/;
 for(const f of files)invariant(f.path==='imageset.json'||picture.test(f.path),`画像セットに使えないファイルが含まれています: ${f.path}`,400);
 invariant(byPath.has('imageset.json'),'画像セットに imageset.json がありません。',400);
 const images=files.filter(f=>picture.test(f.path));
 invariant(images.length>=1&&images.length<=12,'画像は1〜12枚にしてください。',400);
 const sheet=parseJSONFile(byPath.get('imageset.json'),16*1024,'imageset.json');
 invariant(sheet&&typeof sheet==='object'&&!Array.isArray(sheet)&&sheet.version===1&&sheet.moods&&typeof sheet.moods==='object'&&!Array.isArray(sheet.moods),'imageset.json の構成が正しくありません。',400);
 for(const key of Object.keys(sheet))invariant(['version','moods','talkOpen'].includes(key),`imageset.json に使えない項目があります: ${key}`,400);
 invariant(typeof sheet.moods.idle==='string','「いつも」の画像が必要です。',400);
 for(const [mood,path] of Object.entries(sheet.moods))invariant(AVATAR_MOODS.includes(mood)&&typeof path==='string'&&byPath.has(path)&&picture.test(path),`気分「${clip(mood,20)}」の画像が正しくありません。`,400);
 invariant(sheet.talkOpen===undefined||(typeof sheet.talkOpen==='string'&&byPath.has(sheet.talkOpen)&&picture.test(sheet.talkOpen)),'口を開けた画像が正しくありません。',400);
 const out=[],dims={};
 for(const f of files){
  if(f.path==='imageset.json'){out.push({path:f.path,mime:'application/json',bytes:f.bytes});continue;}
  const info=inspectPicture(f.bytes,{maxBytes:8*1024*1024,maxPixels:16e6,mimes:['image/png','image/webp','image/jpeg','image/avif']});
  dims[f.path]=info;out.push({path:f.path,mime:info.mime,bytes:f.bytes});
 }
 const idle=dims[sheet.moods.idle];
 return {files:out,meta:{moods:Object.keys(sheet.moods),talkOpen:!!sheet.talkOpen,width:idle.width,height:idle.height}};
}
