import {isSilentReply} from './prompts.mjs';
/** Presents agent sessions in the shapes the screen draws: the main session as the character
 * conversation, worker sessions as work items, policy approvals as slips. Read-only: the screen
 * acts through the agent API, never through these projections. */
const STATUS={running:'running',waiting:'blocked',idle:'completed',done:'review',stopped:'paused'};
const silent=isSilentReply;
export function jobStatus(s){
 if(s.status==='waiting'&&/承認待ち/.test(s.note||''))return 'waiting_approval';
 if(s.status==='waiting'&&/空きを待って/.test(s.note||''))return 'queued';
 if(s.status==='done'&&s.accepted)return 'completed';
 return STATUS[s.status]||s.status;
}
export function jobOf(s,{approvals=0}={}){
 return {id:s.id,title:s.title||s.task?.slice(0,60)||'仕事',kind:'work',status:jobStatus(s),note:s.status==='waiting'?s.note||'':s.note||'',
  step:s.stats?.steps||0,output:s.result||'',createdAt:s.createdAt,endedAt:s.finishedAt||null,revision:0,priority:0,engine:'builtin',
  parentId:s.parentId,sessionKind:s.kind,depth:s.depth||0,todo:s.todo||[],cwd:s.cwd,retryAt:s.retryAt||null,stats:s.stats||{},
  route:s.route||null,executionRoute:s.route?{profileId:s.route.profileId,model:s.route.model,domain:s.route.domain}:null,pendingApprovals:approvals,
  verification:{status:s.accepted?'accepted-by-user':s.status==='done'?'needs-review':null}};
}
export function approvalOf(a){
 return {id:a.id,jobId:a.sessionId,jobTitle:a.sessionTitle||'',name:a.tool,args:a.args,status:a.status,createdAt:a.createdAt,decidedAt:a.decidedAt||null,note:a.note||'',mode:'live',stacked:false};
}
/** One displayable conversation message per main-session entry; null for internals. */
export function messageOf(e,main,{titles=new Map()}={}){
 if(e.type==='input'){
  if(e.passive&&e.kind!=='report')return null;
  if(e.kind==='report')return {id:'m'+e.seq,sessionId:main.id,role:'tool',kind:'worker-report',content:e.text,jobId:e.sessionId||null,status:e.status==='done'?'review':e.status==='stuck'?'blocked':'running',
   sourceName:e.title||titles.get(e.sessionId)||'',source:'worker',untrusted:true,at:e.at,seq:e.seq};
  if(['heartbeat','event','reminder'].includes(e.kind)||['timer','system','schedule'].includes(e.from))return null;
  if(e.from&&e.from!=='user'&&!e.from.startsWith('voice'))return {id:'m'+e.seq,sessionId:main.id,role:'tool',kind:'worker-report',content:e.text,jobId:e.from.replace(/^child:/,''),status:'running',sourceName:titles.get(e.from.replace(/^child:/,''))||'',at:e.at,seq:e.seq};
  return {id:'m'+e.seq,sessionId:main.id,role:'user',kind:'utterance',content:e.text,source:e.source||'text',at:e.at,seq:e.seq};
 }
 if(e.type==='assistant'){
  const text=String(e.content||'').trim();if(!text||silent(text))return null;
  return {id:'m'+e.seq,sessionId:main.id,role:'assistant',kind:'character',content:text,truncated:!!e.truncated,delegated:(e.toolCalls||[]).filter(c=>c.name==='sessions_spawn').length,at:e.at,seq:e.seq};
 }
 return null;
}
/** A truncated reply and its continuation read as one message. */
export function mergeContinuations(messages){
 const out=[];
 for(const m of messages){const prev=out.at(-1);if(prev?.role==='assistant'&&prev.truncated&&m.role==='assistant'){out[out.length-1]={...prev,content:prev.content+m.content,truncated:m.truncated,id:m.id,at:m.at};continue;}out.push(m);}
 return out;
}
export class AgentUIModel{
 constructor(store,runtime){
  Object.assign(this,{store,runtime});
  this.listener=e=>{
   if(e.type==='session.updated'&&e.data.kind!=='main')this.store.broadcast('job.updated',this.job(e.data));
   if(e.type==='session.entry'){
    const main=this.runtime.sessions.list({kind:'main'})[0];
    if(main&&e.data.sessionId===main.id){const m=messageOf(e.data.entry,main,{titles:this.titles()});if(m)this.store.broadcast('dialogue.message',m);}
   }
   if(e.type==='agent.delta'){const main=this.runtime.sessions.list({kind:'main'})[0];
    if(main&&e.data.sessionId===main.id)this.store.broadcast('dialogue.delta',{text:e.data.text,done:!!e.data.done});
    else this.store.broadcast('job.output',{id:e.data.sessionId,output:e.data.text,done:!!e.data.done});}
   if(e.type==='approval.updated')this.store.broadcast('approval.view',approvalOf(e.data));
  };
  store.listeners.add(this.listener);
 }
 titles(){return new Map(this.runtime.sessions.list().map(s=>[s.id,s.title]));}
 approvals(){return this.store.list('approval').map(approvalOf);}
 job(s){return jobOf(s,{approvals:this.store.list('approval').filter(a=>a.sessionId===s.id&&a.status==='pending').length});}
 jobs(){return this.runtime.sessions.list().filter(s=>s.kind!=='main').map(s=>this.job(s));}
 dialogue({limit=400}={}){
  const rt=this.runtime,main=rt.main(),personas=rt.personas(),titles=this.titles();
  const entries=rt.sessions.tail(main.id,limit*3).filter(e=>e.type==='input'||e.type==='assistant');
  const messages=mergeContinuations(entries.map(e=>messageOf(e,main,{titles})).filter(Boolean)).slice(-limit);
  return {session:{id:main.id,revision:personas.revision,character:personas.character},personas,messages,status:main.status,note:main.note||''};
 }
 snapshot(){return {dialogue:this.dialogue(),jobs:this.jobs(),approvals:this.approvals(),agent:{settings:this.runtime.settings(),main:this.runtime.main(),usage:this.runtime.usage()}};}
 close(){this.store.listeners.delete(this.listener);}
}
