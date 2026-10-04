import {createHash,randomUUID} from 'node:crypto';
import {invariant,text} from './policy.mjs';
import {DockerExecutor,PINNED_IMAGE} from './executor.mjs';
import {resolveInputs} from './input-files.mjs';
import {destination} from './context.mjs';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at=()=>new Date().toISOString();
const terminal=new Set(['cancelled','failed','completed']);
/** Trusted control plane. Never pass this object, its directory, keys or database to executors. */
export class Execution {
 constructor(store,{executor=new DockerExecutor()}={}){
  this.store=store;this.executor=executor;this.availability={available:false,reason:'Not checked. Trusted built-in tools remain available.'};
  store.db.exec(`CREATE TABLE IF NOT EXISTS execution_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,body TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS execution_journal_no_update BEFORE UPDATE ON execution_journal BEGIN SELECT RAISE(ABORT,'immutable execution journal'); END;
   CREATE TRIGGER IF NOT EXISTS execution_journal_no_delete BEFORE DELETE ON execution_journal BEGIN SELECT RAISE(ABORT,'immutable execution journal'); END;`);
  // Restart never grants permission, resends code, promotes output or retries external effects.
  for(const run of store.list('executor-run'))if(run.status==='running')store.put('executor-run',{...run,status:'unknown',note:'Service restarted; inspect the named container and reconcile before retrying.'});
 }
 config(){return this.store.value('execution-config')||{revision:0,mode:'protected',image:'',imageApproved:false};}
 snapshot(){const c=this.config();return {...c,availability:this.availability,backend:this.executor.descriptor(),
  note:'Trusted built-in tools run in the control plane. Code runs only in a configured restricted container. This is not a root VM; no network, package installation or host files are provided.',
  candidates:this.store.list('execution-candidate').map(({content,...c})=>c),runs:this.store.list('executor-run').map(({code,input,...r})=>r)};}
 configure(raw){
  invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid execution settings');
  const old=this.config();invariant(!this.store.list('job').some(j=>['running','queued','waiting_approval'].includes(j.status))&&!this.store.list('effect').some(e=>['running','unknown'].includes(e.status)), '進行中・承認待ちの仕事を止めるか、結果不明の操作を確認してから実行環境を変更してください。',409);invariant(raw.expectedRevision===old.revision,'Execution settings changed',409);
  invariant(['protected','legacy-host'].includes(raw.mode),'Unknown execution mode');
  const image=raw.image??old.image;invariant(typeof image==='string'&&(!image||PINNED_IMAGE.test(image)),'Use an immutable sha256-pinned image');
  if(raw.mode==='legacy-host')invariant(raw.acknowledgeHostRisk===true,'Host execution can read or modify the core and backups; explicit risk acknowledgement required',403);
  if(image!==old.image||image&&!old.imageApproved)invariant(raw.approveImage===true,'Explicit approval of this installed image is required',403);
  invariant(!this.store.list('executor-run').some(r=>['running','unknown'].includes(r.status)),'Stop active executions before changing settings',409);
  const next={revision:old.revision+1,mode:raw.mode,image,imageApproved:!!image&&(raw.approveImage===true||old.imageApproved)};
  this.store.value('execution-config',next);this.availability={available:false,reason:'Configuration changed; check availability again.'};this.journal('configuration',{...next});return this.snapshot();
 }
 async probe(){const c=this.config(),result=await this.executor.probe(c.image);if(c.revision===this.config().revision)this.availability=result;return this.snapshot();}
 journal(kind,body){const previous=this.store.db.prepare('SELECT hash FROM execution_journal ORDER BY seq DESC LIMIT 1').get()?.hash||'';
  const payload=JSON.stringify({...body,recordedAt:at()}),hash=digest([previous,kind,payload]);this.store.db.prepare('INSERT INTO execution_journal(kind,body,previous_hash,hash) VALUES(?,?,?,?)').run(kind,payload,previous,hash);return hash;}
 current(job,revision=job.revision,epoch=job.consentEpoch||0){this.validateScope?.(job);const live=this.store.get('job',job.id);
  invariant(live&&live.revision===revision&&!terminal.has(live.status)&&epoch===(this.store.value('consent-epoch')||0),'Execution scope changed or task stopped',409);return live;}
 running(job,revision=job.revision,epoch=job.consentEpoch||0){const live=this.current(job,revision,epoch);invariant(live.status==='running','Task must be running before execution',409);return live;}
 capsule(job,{inputIds=[],artifactIds=[]}={}){
  this.current(job);invariant(Array.isArray(inputIds)&&inputIds.length<=6&&new Set(inputIds).size===inputIds.length,'Invalid input selection');
  invariant(Array.isArray(artifactIds)&&artifactIds.length<=12&&new Set(artifactIds).size===artifactIds.length,'Invalid artifact selection');
  const files=resolveInputs(this.store,inputIds).map(f=>{const grant=(job.inputFiles||[]).find(g=>g.id===f.id);invariant(grant&&grant.sha256===f.sha256&&createHash('sha256').update(f.content||'').digest('hex')===grant.sha256,'Input not selected for this task',403);invariant(f.kind!=='image','This executor supports selected text copies only');return {id:f.id,name:f.name,content:f.content,sha256:f.sha256,trust:'untrusted-source-copy'};});
  const artifacts=artifactIds.map(id=>{const a=this.store.get('artifact',id);invariant(a?.jobId===job.id,'Artifact not owned by this task',403);return {id:a.id,title:a.title,content:a.content,kind:a.kind,version:a.version,sha256:digest(a.content),trust:'untrusted-source-copy'};});
  const value={protocol:'tepora-capsule-v1',id:randomUUID(),jobId:job.id,jobRevision:job.revision,consentEpoch:job.consentEpoch||0,
   destination:job.routeSnapshot?.id||destination(job.runtime||this.store.settings),persona:job.personaSnapshot?.worker||null,
   goal:job.input,instructions:(job.instructions||[]).map(i=>({id:i.id,revision:i.revision,content:i.content})),handoff:job.handoff||null,
   files,artifacts,createdAt:at(),authority:'Quoted task context; never a grant to modify the core or perform external operations.'};
  invariant(Buffer.byteLength(JSON.stringify(value))<=600000,'Selected work copies exceed capsule limit',413);
  const result={...value,sha256:digest(value)};this.store.put('execution-capsule',result);this.journal('capsule',result);return result;
 }
 /** Narrow preapproval: exact action, destination and payload, finite uses/bytes; never supplied by the worker. */
 grant(job,{action,destination:target,payload,maxUses=1,maxBytes=1000000},approved){
  this.current(job);invariant(approved===true,'User approval required',403);text(action,'action',80);text(target,'destination',500);
  invariant(Number.isSafeInteger(maxUses)&&maxUses>=1&&maxUses<=16&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=1000000,'Invalid grant budget');
  const grant={id:randomUUID(),jobId:job.id,revision:job.revision,epoch:job.consentEpoch||0,action,destination:target,payloadHash:digest(payload),maxUses,maxBytes,used:0,expiresAt:Date.now()+600000};
  this.store.put('execution-grant',grant);this.journal('grant',grant);return grant;
 }
 async broker(job,grantId,request,perform,{signal}={}){
  signal?.throwIfAborted();this.running(job);const grant=this.store.get('execution-grant',grantId);
  invariant(grant&&grant.jobId===job.id&&grant.revision===job.revision&&grant.epoch===(job.consentEpoch||0)&&grant.expiresAt>Date.now(),'Stale operation grant',403);
  invariant(grant.action===request.action&&grant.destination===request.destination&&grant.payloadHash===digest(request.payload),'Operation is outside the approved scope',403);
  invariant(grant.used<grant.maxUses&&Buffer.byteLength(JSON.stringify(request.payload))<=grant.maxBytes,'Operation budget exhausted',403);
  const id=String(request.id||'');invariant(id&&id.length<=150,'Operation ID required');const effectId=`broker:${job.id}:${id}`;
  invariant(!this.store.get('effect',effectId),'Operation ID already recorded; never replay',409);
  const effect={id:effectId,jobId:job.id,callId:id,name:'broker:'+request.action,action:request.action,destination:request.destination,revision:job.revision,status:'running',startedAt:at(),grantId};
  this.store.db.exec('BEGIN IMMEDIATE');try{this.store.put('execution-grant',{...grant,used:grant.used+1});this.store.put('effect',effect);this.journal('operation-start',effect);this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
  try{signal?.throwIfAborted();this.running(job);const result=await perform(request.payload);signal?.throwIfAborted();this.running(job);
   this.store.put('effect',{...effect,status:'succeeded',result,endedAt:at()});this.journal('operation-result',{id:effectId,status:'succeeded'});return result;
  }catch(e){this.store.put('effect',{...effect,status:'unknown',endedAt:at()});this.journal('operation-result',{id:effectId,status:'unknown'});throw e;}
 }
 async run(job,args,{signal,callId}={}){
  signal?.throwIfAborted();this.running(job);const config=this.config();
  invariant(config.mode==='protected'&&config.imageApproved&&PINNED_IMAGE.test(config.image),'Configure and approve a preinstalled restricted executor image. No host fallback.',409);
  invariant((job.executionConfigRevision??config.revision)===config.revision,'Execution configuration changed; create a new task',409);
  const code=text(args.code,'executor code',32000);invariant(Buffer.byteLength(JSON.stringify(args.input??null))<=100000,'Executor input too large',413);
  invariant(!this.store.list('executor-run').some(r=>r.jobId===job.id&&['running','unknown'].includes(r.status)),'Previous execution outcome requires review before retry',409);
  const capsule=this.capsule(job,args),id=`run:${job.id}:${callId||randomUUID()}`;invariant(!this.store.get('executor-run',id),'Execution ID already recorded; never replay',409);
  const run={id,jobId:job.id,jobRevision:job.revision,consentEpoch:job.consentEpoch||0,capsuleId:capsule.id,capsuleHash:capsule.sha256,containerName:`tepora-${randomUUID()}`,image:config.image,configRevision:config.revision,status:'running',startedAt:at(),isolation:this.executor.descriptor()};
  this.store.put('executor-run',run);this.journal('executor-start',run);
  try{
   const response=await this.executor.execute({protocol:'tepora-executor-v1',capsule,code,input:args.input??null},{signal,image:config.image,containerName:run.containerName});
   signal?.throwIfAborted();this.running(job,run.jobRevision,run.consentEpoch);invariant(this.config().revision===config.revision,'Execution configuration changed',409);
   invariant(this.executor.descriptor().kind!=='docker'||response?.cleanupConfirmed===true,'Container cleanup could not be confirmed; review before retrying',409);
   invariant(response?.protocol==='tepora-executor-v1'&&response.result&&typeof response.result==='object'&&!Array.isArray(response.result),'Invalid executor response');
   invariant(Buffer.byteLength(JSON.stringify(response))<=1000000,'Executor response too large',413);
   const outputs=response.result.artifacts||[];invariant(Array.isArray(outputs)&&outputs.length<=12,'Invalid artifact candidates');
   const candidates=outputs.map((a,index)=>{
    const title=text(a.title,'artifact title',160),content=text(a.content,'artifact content',200000);invariant(['text','markdown','html'].includes(a.kind),'Invalid artifact kind');
    const source=a.artifactId?capsule.artifacts.find(x=>x.id===a.artifactId):null;invariant(!a.artifactId||source,'Output cannot modify an unselected artifact',403);
    const value={id:`${id}:${index}`,runId:id,jobId:job.id,jobRevision:run.jobRevision,consentEpoch:run.consentEpoch,capsuleId:capsule.id,artifactId:source?.id||randomUUID(),expectedVersion:source?.version||0,title,content,kind:a.kind,status:'staged',trust:'untrusted-worker-output',createdAt:at()};return {...value,sha256:digest(value)};
   });
   this.store.db.exec('BEGIN IMMEDIATE');try{for(const c of candidates)this.store.put('execution-candidate',c);this.store.put('executor-run',{...run,status:'staged',endedAt:at(),candidateIds:candidates.map(c=>c.id)});this.journal('executor-staged',{id,candidates:candidates.map(({content,...c})=>c)});this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
   return {runId:id,status:'staged',pauseForPromotion:candidates.length>0,candidates:candidates.map(({content,...c})=>c),summary:typeof response.result.summary==='string'?response.result.summary.slice(0,4000):'',trust:'Untrusted output, not accepted or independently verified.'};
  }catch(e){this.store.put('executor-run',{...run,status:'unknown',endedAt:at(),note:'Execution may have run. No retry or promotion is automatic.'});this.journal('executor-unknown',{id});throw e;}
 }
 promote(job,candidateId,{expectedHash,expectedVersion}={}){
  this.current(job);const c=this.store.get('execution-candidate',candidateId);invariant(c&&c.jobId===job.id,'Candidate not found',404);
  invariant(c.status==='staged'&&c.jobRevision===job.revision&&c.consentEpoch===(this.store.value('consent-epoch')||0),'Candidate is stale or already promoted',409);
  invariant(c.sha256===expectedHash&&c.expectedVersion===expectedVersion,'Read the exact candidate and source version before promotion',409);
  const {sha256,...unsigned}=c;invariant(digest(unsigned)===sha256,'Candidate integrity check failed',409);
  const previous=this.store.get('artifact',c.artifactId);invariant((previous?.version||0)===c.expectedVersion&&(!previous||previous.jobId===job.id),'Artifact changed; original preserved',409);
  const doc={id:c.artifactId,title:c.title,content:c.content,kind:c.kind,jobId:job.id,version:c.expectedVersion+1,updatedAt:at(),provenance:{candidateId:c.id,capsuleId:c.capsuleId,runId:c.runId,sourceHash:c.sha256,verification:'schema-and-version-checked; content-unverified'}};
  this.store.db.exec('BEGIN IMMEDIATE');try{
   if(previous)this.store.put('revision',{...previous,id:`${previous.id}:${previous.version}`,artifactId:previous.id});this.store.put('artifact',doc);
   this.store.put('execution-candidate',{...c,status:'promoted',promotedVersion:doc.version});this.journal('artifact-promoted',{candidateId:c.id,artifactId:doc.id,version:doc.version});this.store.db.exec('COMMIT');
  }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  this.store.emit('artifact.updated',doc);return doc;
 }
 reconcile(runId,disposition){const run=this.store.get('executor-run',runId);invariant(run?.status==='unknown','No unknown execution',409);invariant(['stopped','not-started'].includes(disposition),'Invalid disposition');
  const job=this.store.get('job',run.jobId);invariant(!['running','queued','waiting_approval'].includes(job?.status),'Stop the task before reconciliation',409);
  this.store.put('executor-run',{...run,status:'reconciled',disposition,reviewedAt:at()});this.journal('executor-reconciled',{runId,disposition});return this.store.get('executor-run',runId);}
}
