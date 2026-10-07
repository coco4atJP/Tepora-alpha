import {invariant} from './policy.mjs';
import {AVATAR_DEFAULT,defaultAvatar,exportAvatar,importAvatarPreset,avatarNeeds,validateAvatar} from './avatar-model.mjs';
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
