import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {invariant,text,safeError} from './policy.mjs';
import {inspectImage} from './vision.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const token=/^[a-zA-Z0-9_-]{1,160}$/;
const activeStates=['queued','submitting','running','downloading'];
export function mediaType(bytes){
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE')return 'audio/wav';
 if(bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0)return 'audio/mpeg';
 if(bytes.length>12&&bytes.toString('ascii',4,8)==='ftyp')return 'video/mp4';
 throw Object.assign(new Error('配信されたファイルは対応する画像・音声・動画ではありません。'),{status:502});
}
export const mediaPublic=j=>({id:j.id,title:j.title,kind:j.kind,status:j.status,note:j.note,createdAt:j.createdAt,updatedAt:j.updatedAt,
 provider:j.providerName,model:j.model,jobId:j.jobId,asset:j.asset,providerMayContinue:j.providerMayContinue||false,canResume:!!(j.remoteId||j.downloadUrl||j.notSubmitted)&&['paused','awaiting-download'].includes(j.status)});
/** Durable media handles. A lost create response is UNKNOWN, never retried as a new paid job. */
export class MediaJobs{
 constructor(store,capabilities,{pollMs=5000}={}){
  Object.assign(this,{store,capabilities,pollMs});this.active=new Map();this.activeJobs=new Map();this.promises=new Map();this.timers=new Map();this.closed=false;this.pendingBytes=0;
  for(const j of store.list('media-job'))if(activeStates.includes(j.status))this.update(j,{status:j.status==='submitting'&&!j.remoteId?'unknown':'paused',notSubmitted:j.status==='queued'&&!j.remoteId&&!j.downloadUrl,note:'前回の状態を保持しました。生成要求は自動で再送しません。'});
 }
 list(){return this.store.list('media-job').map(mediaPublic);}
 snapshot(){return this.list();}
 update(j,patch){Object.assign(j,patch,{updatedAt:new Date().toISOString()});this.store.put('media-job',j);this.store.emit('media.updated',mediaPublic(j));return mediaPublic(j);}
 create({kind,prompt,inputId=null,sourceAssetId=null,requestId,profileIdentity,title,options={}},job=null){
  invariant(['tts','image','image_edit','video'].includes(kind),'Unsupported generation kind');text(prompt,'prompt',kind==='tts'?4096:12000);
  invariant(typeof requestId==='string'&&token.test(requestId),'A unique request ID is required');
  invariant(options&&Object.keys(options).every(k=>['size','duration','aspectRatio'].includes(k)),'Unsupported generation option');
  if(options.size)invariant(['1024x1024','1536x1024','1024x1536'].includes(options.size),'Unsupported size');
  if(options.duration!==undefined)invariant(Number.isInteger(options.duration)&&options.duration>=1&&options.duration<=15,'Use 1–15 seconds');
  if(options.aspectRatio)invariant(['16:9','9:16','1:1','4:3','3:4','3:2','2:3'].includes(options.aspectRatio),'Invalid aspect ratio');
  const id=hash((job?.id||'user')+':'+requestId),intentHash=hash(JSON.stringify({kind,prompt,inputId,sourceAssetId,options}));
  const existing=this.store.get('media-job',id);if(existing){invariant(existing.intentHash===intentHash,'Request ID reused with different content',409);return mediaPublic(existing);}
  const profile=this.capabilities.pin(kind);invariant(profileIdentity===profile.identity,'生成先を確認してから開始してください。',409);
  invariant(this.store.list('media-job').filter(j=>activeStates.includes(j.status)).length<16,'生成待ちがいっぱいです。',429);
  invariant(this.capabilities.network.permitted(profile.domain,'model'),'現在の通信モードでは生成先を利用できません。',403);
  invariant(!inputId&&!sourceAssetId||['image_edit','video'].includes(kind),'この生成種類には画像を添付できません。');
  invariant(!(inputId&&sourceAssetId),'Select one input image');
  if(kind==='image_edit')invariant(inputId||sourceAssetId,'編集する画像を選んでください。');
  if(inputId){const d=this.store.get('input-file',inputId);invariant(d?.kind==='image'&&!d.revoked,'選択した画像がありません。',404);
   if(job)invariant(job.inputFiles?.some(f=>f.id===inputId&&f.sha256===d.sha256),'This image is not attached to the task',403);}
  if(sourceAssetId){const a=this.store.get('media-asset',sourceAssetId);invariant(a?.mime.startsWith('image/'),'生成済みの画像を選んでください。',404);
   if(job)invariant(a.jobId===job.id,'Source image belongs to another task',403);}
  const inputSha256=inputId?this.store.get('input-file',inputId).sha256:sourceAssetId?this.store.get('media-asset',sourceAssetId).sha256:null;
  const j={id,intentHash,requestId,kind,prompt,inputId,sourceAssetId,inputSha256,options,jobId:job?.id||null,
   title:(title||prompt).slice(0,100),profile,providerName:profile.name,model:profile.model,status:'queued',createdAt:new Date().toISOString()};
  this.update(j,{note:'生成を待っています。会話は続けられます。'});this.pump();return mediaPublic(j);
 }
 pump(){if(this.closed)return;for(const j of this.store.list('media-job').reverse()){
  if(j.status!=='queued'||this.active.size>=2||this.active.has(j.id))continue;
  const controller=new AbortController();this.active.set(j.id,controller);this.activeJobs.set(j.id,j);const running=this.run(j,controller.signal).finally(()=>{this.active.delete(j.id);this.activeJobs.delete(j.id);this.promises.delete(j.id);this.pump();});this.promises.set(j.id,running);
 }}
 async input(j){
  if(j.inputId){const d=this.store.get('input-file',j.inputId);invariant(d&&!d.revoked&&d.sha256===j.inputSha256,'画像は削除または変更されています。',409);return {bytes:Buffer.from(d.base64,'base64'),mime:d.mime};}
  if(j.sourceAssetId){const asset=await this.readAsset(j.sourceAssetId);invariant(asset.sha256===j.inputSha256,'元画像は変更されています。',409);return asset;}return null;
 }
 async run(j,signal){
  try{
   invariant(this.capabilities.current(j.profile),'生成先が変わっています。',409);
   if(j.downloadUrl){await this.download(j,signal);return;}
   if(j.remoteId){await this.poll(j,signal);return;}
   const image=await this.input(j);signal.throwIfAborted();
   let route,json,body;
   if(j.kind==='tts'){route='/audio/speech';json={model:j.model,input:j.prompt,voice:j.profile.voice,response_format:'mp3'};}
   if(j.kind==='image'){route='/images/generations';json={model:j.model,prompt:j.prompt,n:1,size:j.options.size||'1024x1024'};}
   if(j.kind==='image_edit'){
    route='/images/edits';body=new FormData();body.set('model',j.model);body.set('prompt',j.prompt);body.set('n','1');
    body.set('image[]',new Blob([image.bytes],{type:image.mime}),image.mime==='image/jpeg'?'input.jpg':'input.png');
   }
   if(j.kind==='video'){
    route='/videos/generations';json={model:j.model,prompt:j.prompt,duration:j.options.duration||5,aspect_ratio:j.options.aspectRatio||'16:9'};
    if(image)json.image={url:`data:${image.mime};base64,${image.bytes.toString('base64')}`};
   }
   this.update(j,{status:'submitting',note:'生成先へ依頼しています。',providerMayContinue:true});
   const response=await this.capabilities.request(j.profile,route,{json,body,signal,maxBytes:24*1024*1024});signal.throwIfAborted();
   if(j.kind==='tts'){await this.finish(j,Buffer.from(await response.arrayBuffer()),signal);return;}
   const result=await response.json();
   if(j.kind==='video'){
    invariant(typeof result.request_id==='string'&&token.test(result.request_id),'動画の受付IDがありません。',502);
    this.update(j,{remoteId:result.request_id,status:'running',polls:0,note:'動画を生成しています。画面を切り替えても状態は残ります。'});this.schedule(j.id);return;
   }
   const first=result.data?.[0];invariant(first,'生成画像がありません。',502);
   if(first.b64_json){invariant(typeof first.b64_json==='string'&&first.b64_json.length<24*1024*1024&&/^[a-z0-9+/]*={0,2}$/i.test(first.b64_json),'Invalid generated image');await this.finish(j,Buffer.from(first.b64_json,'base64'),signal);}
   else if(typeof first.url==='string'){this.update(j,{downloadUrl:first.url,status:'awaiting-download',note:'生成済みファイルを取得します。'});await this.download(j,signal);}
   else throw new Error('Unsupported image response');
  }catch(e){
   if(this.closed||['cancelled','paused'].includes(j.status))return;
   const status=j.remoteId||j.downloadUrl?'paused':j.status==='submitting'&&!e.knownRejected?'unknown':'failed';
   this.update(j,{status,note:status==='unknown'?'生成依頼の結果を確認できません。二重課金を避けるため自動で再生成しません。':safeError(e)});
  }
 }
 schedule(id){if(this.closed)return;const old=this.timers.get(id);if(old)clearTimeout(old);
  const timer=setTimeout(()=>{this.timers.delete(id);const j=this.store.get('media-job',id);if(j?.status==='running'&&!this.active.has(id)){j.status='queued';this.store.put('media-job',j);this.pump();}},this.pollMs);timer.unref?.();this.timers.set(id,timer);
 }
 async poll(j,signal){
  if(j.downloadUrl){await this.download(j,signal);return;}
  invariant((j.polls||0)<180,'動画の状態確認を一時停止しました。再開すると同じ依頼を確認します。',409);
  const r=await this.capabilities.request(j.profile,'/videos/'+j.remoteId,{method:'GET',signal});const value=await r.json();signal.throwIfAborted();
  if(value.status==='pending'){this.update(j,{status:'running',polls:(j.polls||0)+1,note:'動画の完成を待っています。'});this.schedule(j.id);return;}
  if(['failed','expired'].includes(value.status)){this.update(j,{status:'failed',providerMayContinue:false,note:'動画の生成に失敗、または受付が失効しました。'});return;}
  invariant(value.status==='done'&&typeof value.video?.url==='string','Invalid video status',502);
  invariant(value.video.respect_moderation!==false,'動画サービスが配信を許可していません。',403);
  this.update(j,{downloadUrl:value.video.url,status:'awaiting-download',note:'生成済みの動画を保存しています。'});await this.download(j,signal);
 }
 async download(j,signal){const {bytes}=await this.capabilities.download(j.profile,j.downloadUrl,signal);await this.finish(j,bytes,signal);}
 async finish(j,bytes,signal){
  signal?.throwIfAborted();const mime=mediaType(bytes);invariant(mime.startsWith(j.kind==='tts'?'audio/':j.kind==='video'?'video/':'image/'),'Output modality mismatch',502);
  invariant(bytes.length>0&&bytes.length<=32*1024*1024,'Media exceeds local size budget',413);
  invariant(this.store.list('media-asset').reduce((n,a)=>n+a.bytes,0)+this.pendingBytes+bytes.length<=512*1024*1024,'保存容量512MBに達しました。不要な生成物を削除してください。',413);
  this.pendingBytes+=bytes.length;try{
  const id=randomUUID(),dir=path.join(this.store.dir,'media');await mkdir(dir,{recursive:true});const file=path.join(dir,id);
  await writeFile(file,bytes,{flag:'wx',mode:0o600});
  if(signal?.aborted||this.closed){await unlink(file);signal?.throwIfAborted();return;}
  const asset={id,mime,bytes:bytes.length,sha256:hash(bytes),jobId:j.jobId,generationId:j.id,title:j.title,createdAt:new Date().toISOString()};
  this.store.put('media-asset',asset);this.update(j,{status:'ready',asset,providerMayContinue:false,note:'生成物を保存しました。内容と品質は確認してください。',downloadUrl:null});
  }finally{this.pendingBytes-=bytes.length;}
 }
 async readAsset(id){invariant(typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id),'Invalid asset');const asset=this.store.get('media-asset',id);invariant(asset,'生成物がありません。',404);
  const file=path.join(this.store.dir,'media',id),info=await stat(file);invariant(info.size===asset.bytes&&info.size<=32*1024*1024,'Media integrity check failed',409);
  const bytes=await readFile(file);invariant(hash(bytes)===asset.sha256,'Media was modified',409);return {...asset,bytes};}
 cancel(id){const j=this.store.get('media-job',id);invariant(j,'Unknown media job',404);if(['ready','failed','cancelled'].includes(j.status))return mediaPublic(j);
  const c=this.active.get(id);if(c)c.abort(new Error('User stopped media generation'));clearTimeout(this.timers.get(id));this.timers.delete(id);
  const current=this.activeJobs?.get(id)||j;return this.update(current,{status:'cancelled',note:'Tepora側の処理を停止しました。送信済みの生成処理・課金は先方で続く場合があります。'});
 }
 resume(id){const j=this.store.get('media-job',id);invariant(j&&['paused','awaiting-download'].includes(j.status)&&(j.remoteId||j.downloadUrl||j.notSubmitted),'再送なしで確認できる受付IDがありません。',409);
  invariant(this.capabilities.current(j.profile),'接続先が変更されています。元の設定を確認してください。',409);this.update(j,{status:'queued',polls:0});this.pump();return mediaPublic(j);}
 async remove(id){const j=this.store.get('media-job',id);invariant(j&&!this.active.has(id)&&!activeStates.includes(j.status),'処理を停止してから削除してください。',409);
  if(j.asset){await unlink(path.join(this.store.dir,'media',j.asset.id)).catch(e=>{if(e.code!=='ENOENT')throw e;});this.store.remove('media-asset',j.asset.id);}
  this.store.remove('media-job',id);this.store.emit('media.deleted',{id});return {deleted:true};}
 stopAll(){for(const j of this.store.list('media-job'))if(activeStates.includes(j.status))this.cancel(j.id);}
 async close(){this.closed=true;for(const t of this.timers.values())clearTimeout(t);this.timers.clear();for(const saved of this.store.list('media-job'))if(activeStates.includes(saved.status)){const j=this.activeJobs.get(saved.id)||saved;this.update(j,{status:j.status==='submitting'&&!j.remoteId?'unknown':'paused',notSubmitted:j.status==='queued'&&!j.remoteId&&!j.downloadUrl,note:'停止前の受付状態を保存しました。再開はユーザーが選べます。'});this.active.get(j.id)?.abort(new Error('Service closing'));}await Promise.allSettled([...this.promises.values()]);}
}
