import {nativeCompute} from '../native-state.mjs';

/** Rust owns projection decisions, filtering, status, text and continuation
 * merging. This facade gathers facts and preserves the synchronous listener
 * ordering and undefined-own-property details of the public JavaScript API. */
const JOB_KEYS=['id','title','kind','status','note','step','output','createdAt','endedAt','revision','priority','engine','parentId','sessionKind','depth','todo','cwd','retryAt','stats','route','executionRoute','pendingApprovals','verification'];
const APPROVAL_KEYS=['id','jobId','jobTitle','name','args','status','createdAt','decidedAt','note','mode','stacked'];
const MESSAGE_PREFIX=['id','sessionId','role','kind','content'];
const SOURCE_EVENTS=new Set(['session.updated','session.entry','agent.delta','approval.updated']);
// JSON omits undefined. Reconstitute declared own properties without turning
// them into null, or putting the projection/business logic back into JS.
const shape=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
function publicJob(value,source){
 const out=shape(value,JOB_KEYS);
 if(out.executionRoute)out.executionRoute=shape(out.executionRoute,['profileId','model','domain']);
 // These fields are borrowed by the old read-only API, not transformed.
 if(source){for(const key of ['title','todo','stats','route'])if(source[key])out[key]=source[key];if(source.result)out.output=source.result;}
 return out;
}
function publicApproval(value,source){const out=shape(value,APPROVAL_KEYS);if(source)out.args=source.args;return out;}
function publicMessage(value,entry){
 if(!value)return null;
 const extra=value.role==='assistant'?['truncated','delegated']:value.kind==='worker-report'?['jobId','status','sourceName',...(value.untrusted===true?['source','untrusted']:[])]:['source'];
 const out=shape(value,[...MESSAGE_PREFIX,...extra,'at','seq']);
 if(entry&&entry.type==='input')out.content=entry.text;
 return out;
}
function publicDialogue(value,personas){
 value.session=shape(value.session,['id','revision','character']);
 value.messages=value.messages.map(message=>publicMessage(message));
 if(personas){value.personas=personas;value.session.character=personas.character;}
 return shape(value,['session','personas','messages','status','note']);
}
export function jobStatus(session){const status=nativeCompute('ui.jobStatus',{session});return session.status===undefined?undefined:status;}
export function jobOf(session,{approvals=0}={}){return publicJob(nativeCompute('ui.job',{session,approvals}),session);}
export function approvalOf(approval){return publicApproval(nativeCompute('ui.approval',{approval}),approval);}
export function messageOf(entry,main,{titles=new Map()}={}){return publicMessage(nativeCompute('ui.message',{entry,main,titles:[...titles]}),entry);}
export function mergeContinuations(messages){
 const {messages:merged,origins}=nativeCompute('ui.merge',{messages,withSources:true});
 return merged.map((message,i)=>{
  const [first,last]=origins[i];if(first===last)return messages[first];
  const tail=messages[last];return {...messages[first],content:message.content,truncated:tail.truncated,id:tail.id,at:tail.at};
 });
}
export class AgentUIModel{
 constructor(store,runtime){
  Object.assign(this,{store,runtime});
  this.listener=e=>{
   if(!SOURCE_EVENTS.has(e.type))return;
   const sessions=['session.entry','agent.delta'].includes(e.type)?runtime.sessions.list():[];
   const approvals=e.type==='session.updated'&&e.data.kind!=='main'?store.list('approval'):[];
   for(const projected of nativeCompute('ui.event',{event:e,sessions,approvals})){
    let data=projected.data;
    if(projected.type==='job.updated')data=publicJob(data,e.data);
    else if(projected.type==='approval.view')data=publicApproval(data,e.data);
    else if(projected.type==='dialogue.message')data=publicMessage(data,e.data.entry);
    else if(projected.type==='dialogue.delta')data=shape(data,['text','done']);
    else if(projected.type==='job.output')data=shape(data,['id','output','done']);
    // Synchronous, reentrant publication is intentional: SSE listeners added
    // later observe the projection before the originating source event.
    store.broadcast(projected.type,data);
   }
  };
  store.listeners.add(this.listener);
 }
 titles(){return new Map(this.runtime.sessions.list().map(s=>[s.id,s.title]));}
 approvals(){const approvals=this.store.list('approval');return nativeCompute('ui.approvals',{approvals}).map((a,i)=>publicApproval(a,approvals[i]));}
 job(session){return publicJob(nativeCompute('ui.job',{session,approvalRecords:this.store.list('approval')}),session);}
 jobs(){const sessions=this.runtime.sessions.list(),approvals=this.store.list('approval'),sources=new Map(sessions.map(s=>[s.id,s]));return nativeCompute('ui.jobs',{sessions,approvals}).map(job=>publicJob(job,sources.get(job.id)));}
 dialogue({limit=400}={}){
  const rt=this.runtime,main=rt.main(),personas=rt.personas(),sessions=rt.sessions.list(),entries=rt.sessions.tail(main.id,limit*3);
  return publicDialogue(nativeCompute('ui.dialogue',{main,personas,sessions,entries,limit}),personas);
 }
 snapshot(){
  const rt=this.runtime,main=rt.main(),personas=rt.personas(),sessions=rt.sessions.list(),entries=rt.sessions.tail(main.id,1200),approvals=this.store.list('approval');
  const settings=rt.settings(),usage=rt.usage();
  const out=nativeCompute('ui.snapshot',{main,personas,sessions,entries,approvals,settings,usage});
  out.dialogue=publicDialogue(out.dialogue,personas);
  const sources=new Map(sessions.map(s=>[s.id,s]));out.jobs=out.jobs.map(job=>publicJob(job,sources.get(job.id)));
  out.approvals=out.approvals.map((a,i)=>publicApproval(a,approvals[i]));
  out.agent={settings,main,usage};return out;
 }
 close(){this.store.listeners.delete(this.listener);}
}
