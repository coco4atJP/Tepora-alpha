/** The avatar on the home stage: its spec (a small validated recipe, saved with a revision and an undo
 * history) and the library of things a person has brought for it (a VRM, a picture, a set of
 * pictures, a mesh-avatar-studio project). Nothing here is sent anywhere; files stay under
 * <data>/avatar and are served only to the signed-in page.
 *
 * The avatar knows nothing about the persona. What the character says is configured elsewhere.
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {invariant} from './policy.mjs';
import {AVATAR_ASSET_KINDS,AVATAR_ASSET_ID,AVATAR_DEFAULT,defaultAvatar,exportAvatar,importAvatarPreset,avatarNeeds,validateAvatar} from '../web/avatar/model.mjs';
import {MAX_PACK_BYTES,MAX_VRM_BYTES,inspectImageSet,inspectMeshPack,inspectPicture,inspectVRM,parsePack} from './avatar-inspect.mjs';

export {MAX_PACK_BYTES,MAX_VRM_BYTES};
export const MAX_ASSETS=24;
export const MAX_LIBRARY_BYTES=1024*1024*1024;
/** The largest request body an upload may have, whatever its kind. */
export const MAX_ASSET_BYTES=MAX_PACK_BYTES;
const clip=(value,max=80)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export class AvatarAssets {
 constructor(store){this.store=store;this.dir=path.join(store.dir,'avatar');}
 list(){return this.store.value('avatar-assets')||[];}
 meta(id){return this.list().find(a=>a.id===id)||null;}
 /** What the page needs: no hashes and no names on disk, but the logical file paths of a pack. */
 snapshot(){
  return {assets:this.list().map(({id,kind,name,bytes,createdAt,meta,files})=>({id,kind,name,bytes,createdAt,meta,files:files.map(({path:p,mime,bytes:n})=>({path:p,mime,bytes:n}))})),
   limits:{maxAssets:MAX_ASSETS,maxBytes:MAX_ASSET_BYTES,maxVrmBytes:MAX_VRM_BYTES,maxLibraryBytes:MAX_LIBRARY_BYTES}};
 }
 changed(){const value=this.snapshot();this.store.emit('avatar.assets',value);return value;}
 async add(kind,bytes,{filename=''}={}){
  invariant(AVATAR_ASSET_KINDS.includes(kind),'素材の種類が正しくありません。',400);
  invariant(Buffer.isBuffer(bytes)&&bytes.length>0,'ファイルを選んでください。',400);
  let files,meta,name=clip(path.basename(String(filename||''))).replace(/\.[^.]+$/,'');
  if(kind==='vrm'){meta=inspectVRM(bytes);name=meta.name||name;files=[{path:'file',mime:'model/gltf-binary',bytes}];}
  else if(kind==='image'){const info=inspectPicture(bytes);meta={mime:info.mime,width:info.width,height:info.height};files=[{path:'file',mime:info.mime,bytes}];}
  else{
   const pack=parsePack(bytes);invariant(pack.kind===kind,'素材の種類が一致しません。',400);
   const checked=kind==='mesh'?inspectMeshPack(pack.files):inspectImageSet(pack.files);
   files=checked.files;meta=checked.meta;name=pack.name||name;
  }
  const digest=sha(bytes),list=this.list(),same=list.find(a=>a.kind===kind&&a.sha256===digest);
  if(same)return {asset:this.publicOf(same),...this.snapshot(),existing:true};
  invariant(list.length<MAX_ASSETS,`素材は${MAX_ASSETS}件までです。使わないものを削除してください。`,413);
  invariant(list.reduce((n,a)=>n+a.bytes,0)+bytes.length<=MAX_LIBRARY_BYTES,'保存できる素材の合計サイズを超えます。',413);
  const id=randomUUID(),temp=path.join(this.dir,`.upload-${randomUUID()}`),final=path.join(this.dir,id),stored=[];
  await mkdir(temp,{recursive:true});
  try{
   for(const [index,file] of files.entries()){await writeFile(path.join(temp,String(index)),file.bytes,{flag:'wx'});stored.push({path:file.path,mime:file.mime,bytes:file.bytes.length,sha256:sha(file.bytes),store:index});}
   await rename(temp,final);
  }catch(e){await rm(temp,{recursive:true,force:true});throw e;}
  const entry={id,kind,name:name||({vrm:'3Dモデル',image:'画像',imageset:'画像セット',mesh:'メッシュアバター'})[kind],bytes:bytes.length,sha256:digest,createdAt:new Date().toISOString(),meta,files:stored};
  this.store.value('avatar-assets',[...list,entry]);
  const snapshot=this.changed();
  return {asset:this.publicOf(entry),...snapshot};
 }
 publicOf(entry){return this.snapshot().assets.find(a=>a.id===entry.id);}
 /** One file of an asset by its logical path ('file' for single-file kinds). The stored bytes are checked again before they are served. */
 async read(id,filePath='file'){
  invariant(AVATAR_ASSET_ID.test(String(id)),'素材が見つかりません。',404);
  const meta=this.meta(id);invariant(meta,'素材が見つかりません。',404);
  const entry=meta.files.find(f=>f.path===filePath);invariant(entry,'素材のファイルが見つかりません。',404);
  let bytes;try{bytes=await readFile(path.join(this.dir,id,String(entry.store)));}catch{invariant(false,'素材のファイルが見つかりません。',404);}
  invariant(sha(bytes)===entry.sha256,'保存した素材が変更されています。追加し直してください。',409);
  return {meta,entry,bytes};
 }
 async remove(id){
  invariant(AVATAR_ASSET_ID.test(String(id)),'素材が見つかりません。',404);
  const list=this.list(),meta=list.find(a=>a.id===id);invariant(meta,'素材が見つかりません。',404);
  await rm(path.join(this.dir,id),{recursive:true,force:true});
  this.store.value('avatar-assets',list.filter(a=>a.id!==id));
  return {removed:id,...this.changed()};
 }
}

export class Avatar {
 constructor(store,assets){this.store=store;this.assets=assets;}
 get(){return this.store.value('avatar')||structuredClone(AVATAR_DEFAULT);}
 /** A body that wears a file needs that file to exist and to be the right kind. */
 assertUsable(spec){
  const need=avatarNeeds(spec);if(!need)return;
  invariant(spec.asset,'素材を選んでください。',409);
  const asset=this.assets.meta(spec.asset);invariant(asset&&asset.kind===need,'選んだ素材が見つかりません。',409);
 }
 commit(next,old){
  const history=this.store.value('avatar-history')||[];
  this.store.value('avatar-history',[...history,old].slice(-20));
  this.store.value('avatar',next);this.store.emit('avatar.updated',next);return next;
 }
 change(patch,expectedRevision){
  const old=this.get();
  invariant(expectedRevision===old.revision,'The character changed in another window. Reload before saving.',409);
  const next=validateAvatar(patch,old);this.assertUsable(next);
  next.revision=old.revision+1;
  return this.commit(next,old);
 }
 undo(expectedRevision){
  const current=this.get(),history=this.store.value('avatar-history')||[];
  invariant(current.revision===expectedRevision,'Avatar revision conflict',409);
  invariant(history.length,'Nothing to undo',409);
  let previous=history.pop();
  // An earlier look may have worn a file that has since been removed.
  try{this.assertUsable(previous);}catch{previous={...defaultAvatar('shiro'),revision:previous.revision};}
  const next={...previous,revision:current.revision+1};
  this.store.value('avatar-history',history);this.store.value('avatar',next);this.store.emit('avatar.updated',next);return next;
 }
 reset(expectedRevision){
  const old=this.get();invariant(old.revision===expectedRevision,'The character changed in another window. Reload before saving.',409);
  return this.commit({...defaultAvatar('shiro'),revision:old.revision+1},old);
 }
 export(){return exportAvatar(this.get());}
 /** A preset sets the look. A body that wears a file uses the newest file of that kind in the library. */
 import(preset,expectedRevision){
  const settings=importAvatarPreset(preset),old=this.get();
  const probe=validateAvatar(settings,old),need=avatarNeeds(probe);
  if(need&&!probe.asset){
   const latest=[...this.assets.list()].reverse().find(a=>a.kind===need);
   invariant(latest,'この設定には、先に素材（3Dモデル・画像など）の追加が必要です。',409);
   settings.asset=latest.id;
  }
  return this.change(settings,expectedRevision);
 }
 /** A removed file can no longer be worn: the avatar goes back to the default body. */
 assetRemoved(id){
  const current=this.get();if(current.asset!==id)return current;
  return this.commit({...defaultAvatar('shiro'),revision:current.revision+1},current);
 }
}
