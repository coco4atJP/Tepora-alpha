import {createHash,randomUUID} from 'node:crypto';
import {Companion} from './companion.mjs';
import {destination} from './context.mjs';
import {text,invariant} from './policy.mjs';
import {resolveInputs,inputMeta} from './input-files.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** An idempotent receipt for a user's intent; retrying a lost response never creates a second job. */
export class Requests{
 constructor(store,harness){this.store=store;this.harness=harness;}
 context(engine='builtin',role='work',targetJobId=null){
  invariant(['chat','work'].includes(role),'Unknown role');
  if(targetJobId){const job=this.store.get('job',targetJobId);invariant(job,'Task not found',404);const route=job.routeSnapshot,s=job.runtime||this.store.settings;return {id:route?.id||destination(s),engine:job.engine,remote:route?route.profiles.some(p=>p.domain!=='device'):this.harness.isCloud(s),label:route?route.profiles.map(p=>`${p.name} (${p.domain})`).join(' → '):`${s.model} · ${new URL(s.baseUrl).host}`,note:'選択中の仕事の既存の接続先と文脈を保持します。',route};}
  invariant(['builtin','codex'].includes(engine),'Unknown engine');
  if(engine==='builtin'&&this.harness.registry?.configured){
   const route=this.harness.registry.admit(this.harness.registry.pin(role)),recipients=[...new Map([...route.profiles,...route.vision,...(route.delegatedWork||[])].map(p=>[p.identity,p])).values()];
   return {id:route.id,engine,remote:recipients.some(p=>p.domain!=='device'),
    label:recipients.map(p=>`${p.name} (${p.domain})`).join(' → '),route,
    note:'依頼は登録した主系・代替先へ、画像は設定したVision先へ渡します。画像の説明文も個人情報になり得るため、主モデルへの共有範囲に含まれます。'};
  }
  const s=this.store.settings,remote=engine==='codex'||!['127.0.0.1','localhost','[::1]'].includes(new URL(s.baseUrl).hostname);
  return {id:engine==='codex'?hash(['codex',s.codexModel,s.codexBinary,s.codexNetwork]):destination(s),engine,remote,
   label:engine==='codex'?`Codex (${s.codexModel||'Codex側の選択モデル'})`:`${s.model||'未選択'} · ${new URL(s.baseUrl).host}`,
   note:engine==='codex'?'Codexの接続先へ送られます。接続先・料金はCodexの構成に従います。':remote?'選んだ接続先へ依頼と添付内容を送ります。':'このPCの接続先へ送ります。ローカルサーバー自身の外部転送設定も確認してください。'};
 }
 get(id){const r=this.store.get('request',id);invariant(r,'Request not found',404);return {id:r.id,job:this.store.get('job',r.jobId),status:r.status,resumeRequired:!!r.resumeRequired,error:r.error||null};}
 submit(raw){
  invariant(raw&&typeof raw==='object','Invalid request');
  const {requestId,input,engine='builtin',attachmentIds=[],attachmentConsent=null}=raw;
  invariant(typeof requestId==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(requestId),'A unique request id is required');
  const normalized={input:text(input),engine,attachmentIds,attachmentConsent,...(raw.intent?{intent:raw.intent,targetJobId:raw.targetJobId||null,expectedRevision:raw.expectedRevision??null,companionRevision:raw.companionRevision??null}:{})};
  const fingerprint=hash(normalized),old=this.store.get('request',requestId);
  if(old){invariant(old.fingerprint===fingerprint,'同じ送信番号に異なる依頼が指定されました。',409);const existing=this.store.get('job',old.jobId);
   if(existing)return {job:existing,duplicate:true,requestId,resumeRequired:!!old.resumeRequired};
   invariant(false,'前の送信は開始されませんでした。下書きを確認して新しい送信として実行してください。',409);
  }
  if(raw.intent){
   invariant(['new','side','continue'].includes(raw.intent),'Invalid intent');
   const focus=new Companion(this.store).check(raw.companionRevision);
   if(raw.intent!=='new'){
    invariant(raw.targetJobId&&focus.focusJobId===raw.targetJobId,'送信対象が変わりました。',409);
    const target=this.harness.live(raw.targetJobId);invariant(target,'Task not found',404);
    invariant(raw.expectedRevision===target.revision,'仕事の指示が変わりました。確認してください。',409);
    if(raw.intent==='continue')return this.continue(target,normalized,requestId,fingerprint);
   }
  }
  const docs=resolveInputs(this.store,attachmentIds),kind=docs.length||engine==='codex'?'work':'chat';
  const context=this.context(engine,kind),s=this.store.settings;
  invariant(engine==='codex'?s.codexEnabled:this.harness.registry?.configured||Boolean(s.model),'先にモデルの接続を確認してください。依頼と添付はそのまま残しています。',409);
  if(docs.length&&context.remote)invariant(attachmentConsent===context.id,'この接続先へ選んだファイルを送る許可が必要です。',403);
  const jobId=randomUUID();this.store.put('request',{id:requestId,jobId,fingerprint,status:'creating',createdAt:new Date().toISOString()});
  try{
   const job=this.harness.submit(normalized.input,kind,{
    id:jobId,engine,runtime:s,conversationLane:!!raw.intent,sideOfJobId:raw.intent==='side'?raw.targetJobId:null,routeSnapshot:context.route,inputFiles:docs.map(inputMeta),inputDestination:context.id,requestId,
    // A file-based task must publish a tangible result rather than just say it read the file.
    checks:docs.length?[{type:'artifact',label:'添付を使った成果物が存在する',any:true}]:[]
   });
   let companion=null;
   this.store.db.exec('BEGIN IMMEDIATE');
   try{
    this.store.put('request',{...this.store.get('request',requestId),status:'accepted'});
    if(raw.intent){const current=new Companion(this.store).check(raw.companionRevision),stack=current.returnStack.filter(id=>id!==job.id);if(raw.intent==='side'&&current.focusJobId)stack.push(current.focusJobId);companion={revision:current.revision+1,focusJobId:job.id,returnStack:[...new Set(stack)].slice(-20)};this.store.value('companion',companion);}
    this.store.db.exec('COMMIT');
   }catch(e){this.store.db.exec('ROLLBACK');throw e;}
   if(companion)this.store.emit('companion.updated',companion);
   return {job,duplicate:false,requestId,companion};
  }catch(e){this.store.put('request',{...this.store.get('request',requestId),status:'failed',error:'依頼を開始できませんでした。'});throw e;}
 }
 continue(target,normalized,requestId,fingerprint){
  invariant(!normalized.attachmentIds.length,'続きへの新しい添付は未対応です。別の依頼に添えてください。',409);
  invariant(!target.resumeBlocked,'Imported work requires a new explicitly scoped task.',409);
  invariant((target.consentEpoch||0)===(this.store.value('consent-epoch')||0),'権限が変わっています。文脈を再送できません。',409);
  const saved=this.harness.prepareSteer(target.id,normalized.input),runtime=target.runtime||this.store.settings;
  const message={id:randomUUID(),role:'user',content:normalized.input,jobId:target.id,cloud:this.harness.isCloud(runtime),destination:target.routeSnapshot?.id||destination(runtime),kind:target.kind,at:new Date().toISOString()};
  const receipt={id:requestId,jobId:target.id,fingerprint,status:'accepted',createdAt:message.at,resumeRequired:['paused','interrupted','blocked'].includes(saved.status)};
  this.store.db.exec('BEGIN IMMEDIATE');
  try{this.store.put('job',saved);this.store.put('message',message);this.store.put('request',receipt);this.store.db.exec('COMMIT');}
  catch(e){this.store.db.exec('ROLLBACK');throw e;}
  // Only committed instructions may invalidate an approval or reach an external runtime.
  let job=this.harness.notifySteer(saved);this.store.emit('message.created',message);
  if(receipt.resumeRequired){try{job=this.harness.resume(job.id);receipt.resumeRequired=false;this.store.put('request',receipt);}catch{/* Retain saved instruction and every normal replay guard. */}}
  return {job,duplicate:false,requestId,resumeRequired:receipt.resumeRequired};
 }

}
