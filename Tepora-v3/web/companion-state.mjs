/** Pure presentation/draft policy. Navigation is not execution. */
export function companionDestination(companion,jobs,intent='continue',engine='builtin') {
 const focus=jobs.find(j=>j.id===companion?.focusJobId);
 const mode=intent==='continue'&&!focus?'new':intent;
 return Object.freeze({intent:mode,targetJobId:mode==='new'?null:focus?.id||null,
  companionRevision:companion?.revision||0,jobRevision:focus?.revision??null,engine});
}
export function companionArtifacts(artifacts,focusJobId) {
 return focusJobId?artifacts.filter(a=>a.jobId===focusJobId):[];
}
export function companionReply(jobs,messages,focusJobId) {
 if(!focusJobId)return '';
 const job=jobs.find(j=>j.id===focusJobId);
 const message=[...messages].reverse().find(m=>m.role==='assistant'&&m.jobId===focusJobId);
 return job?.output||message?.content||'';
}
export function companionSideJob(job) {return Boolean(job.sideOfJobId);}
export function companionRole(destination,jobs,attachmentCount=0) {
 return destination.intent==='continue'?(jobs.find(j=>j.id===destination.targetJobId)?.kind==='work'?'work':'chat'):
  attachmentCount||destination.engine==='codex'?'work':'chat';
}
/** The first keystroke/voice start owns the destination, even after remote focus changes. */
export class CompanionDraftContext {
 constructor(){this.destination=null;this.epoch=0;}
 pin(companion,jobs,intent,engine){return this.destination||=(companionDestination(companion,jobs,intent,engine));}
 replace(companion,jobs,intent,engine){this.clear();return this.pin(companion,jobs,intent,engine);}
 clear(){this.destination=null;this.epoch++;}
 anchor(draft,selection){return {...draft.snapshot(),...selection,destination:this.destination,epoch:this.epoch};}
 accepts(anchor,draft){return anchor.epoch===this.epoch&&anchor.revision===draft.revision&&anchor.destination===this.destination;}
}
