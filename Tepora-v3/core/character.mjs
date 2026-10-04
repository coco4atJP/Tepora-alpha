/** A user-chosen VRM avatar stays on this PC. Only the binary GLB layout and VRM metadata are
 * read here; rendering happens in the browser with vendored, pinned libraries. External file
 * references are refused so a model can never make the page fetch something on its own.
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {invariant} from './policy.mjs';

export const MAX_VRM_BYTES=80*1024*1024;
const MAX_JSON_BYTES=16*1024*1024;
const clip=(value,max=160)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';

/** Parse and validate a GLB container that declares a VRM 1.0 or 0.x humanoid. */
export function inspectVRM(bytes){
 invariant(Buffer.isBuffer(bytes)&&bytes.length>=20,'VRMファイル（.vrm）を選んでください。',400);
 invariant(bytes.length<=MAX_VRM_BYTES,`VRMファイルは${Math.round(MAX_VRM_BYTES/1024/1024)}MBまでです。`,413);
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

export class CharacterModels {
 constructor(store){this.store=store;this.dir=path.join(store.dir,'character');this.file=path.join(this.dir,'model.vrm');}
 get(){return this.store.value('character-model')||null;}
 async save(bytes,{filename=''}={}){
  const meta=inspectVRM(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
  await mkdir(this.dir,{recursive:true});
  const temp=path.join(this.dir,`.upload-${randomUUID()}`);
  try{await writeFile(temp,bytes,{flag:'wx'});await rename(temp,this.file);}catch(e){await rm(temp,{force:true});throw e;}
  const previous=this.get();
  const value={...meta,revision:(previous?.revision||0)+1,bytes:bytes.length,sha256,filename:clip(path.basename(String(filename||'')),120),uploadedAt:new Date().toISOString()};
  this.store.value('character-model',value);this.store.emit('character.updated',value);return value;
 }
 async read(){
  const meta=this.get();invariant(meta,'キャラクターモデルはまだ設定されていません。',404);
  const bytes=await readFile(this.file);
  invariant(createHash('sha256').update(bytes).digest('hex')===meta.sha256,'保存したモデルが変更されています。設定し直してください。',409);
  return {meta,bytes};
 }
 async remove(){
  await rm(this.file,{force:true});this.store.value('character-model',null);this.store.emit('character.updated',null);return {removed:true};
 }
}
