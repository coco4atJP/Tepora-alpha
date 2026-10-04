import {STATUS_LABELS} from './status.mjs';
/** The conversation belongs to a session. A job selection is only a detail view. */
export function characterName(dialogue){
 const character=dialogue?.session?.character;
 return (typeof character==='string'?character:character?.name)||dialogue?.personas?.character?.name||'Tepora';
}
export function dialogueDestination(session,reply=null){
 if(!session?.id)throw new Error('会話を読み込んでいます。少し待ってから送信してください。');
 return Object.freeze({sessionId:session.id,reply:reply?Object.freeze({...reply}):null});
}
export class DialogueDraftContext {
 constructor(){this.destination=null;this.epoch=0;}
 pin(session){return this.destination||=(dialogueDestination(session));}
 selectQuestion(session,message,jobs){
  if(!questionIsCurrent(message,jobs))throw new Error('この質問は更新済みです。最新の質問を確認してください。');
  this.clear();return this.destination=dialogueDestination(session,{questionId:message.questionId,jobId:message.jobId,jobRevision:message.jobRevision});
 }
 clear(){this.destination=null;this.epoch++;}
 anchor(draft,selection){return {...draft.snapshot(),...selection,destination:this.destination,epoch:this.epoch};}
 accepts(anchor,draft){return anchor.epoch===this.epoch&&anchor.revision===draft.revision&&anchor.destination===this.destination;}
}
export function questionIsCurrent(message,jobs){
 const job=jobs.find(j=>j.id===message?.jobId);
 return Boolean(message?.kind==='worker-question'&&message.questionId&&message.questionStatus==='pending'&&job&&job.revision===message.jobRevision&&job.pendingQuestionId===message.questionId&&job.status==='paused');
}
export function currentReplyQuestion(destination,dialogue,jobs){
 const reply=destination?.reply;if(!reply)return null;
 return dialogue?.messages?.find(m=>m.questionId===reply.questionId&&m.jobId===reply.jobId&&m.jobRevision===reply.jobRevision&&questionIsCurrent(m,jobs))||null;
}
export function latestCharacterReply(dialogue){return [...(dialogue?.messages||[])].reverse().find(m=>m.role==='assistant'&&!['worker-report','worker-question'].includes(m.kind))?.content||'';}
const dialogueStatusNames={...STATUS_LABELS,paused:'回答待ち'};
const dialogueTones={queued:'active',running:'active',waiting_approval:'attention',paused:'attention',interrupted:'attention',blocked:'attention',failed:'danger',cancelled:'idle',review:'attention',completed:'done'};
const dialogueWorkerLabel=name=>!name||name==='作業担当'?'作業担当':`作業担当（${name}）`;
export function dialogueMessagePresentation(message,dialogue,jobs){
 const worker=['worker-report','worker-question'].includes(message.kind),job=jobs.find(j=>j.id===message.jobId);
 const status=message.status||job?.status||'',accepted=message.verificationStatus==='accepted-by-user';
 const parked=message.kind==='worker-report'&&status==='waiting_approval';
 return {
  speaker:message.role==='user'?'あなた':characterName(dialogue),
  source:worker?`${dialogueWorkerLabel(message.sourceName||job?.personaSnapshot?.worker?.name||dialogue?.personas?.worker?.name||'')}からの${message.kind==='worker-question'?'確認':'報告'} · ${job?.title||message.jobId||'仕事'}`:'',
  status:worker?(accepted?'ユーザー確認済み':dialogueStatusNames[status]||status):'',
  tone:worker?(accepted?'done':message.kind==='worker-question'?'attention':dialogueTones[status]||'idle'):'',
  // Start/progress notices are shown as one quiet line; results and questions stay full.
  compact:message.kind==='worker-report'&&['queued','running'].includes(status),
  parked,
  caution:message.kind==='worker-report'&&status==='review'&&!accepted?'作業担当の報告です。成果の内容はまだ確認されていません。':'',
  canReply:questionIsCurrent(message,jobs),
  questionState:message.kind==='worker-question'?(questionIsCurrent(message,jobs)?'回答を待っています':message.questionStatus==='answered'?'回答済み':'更新済みの質問です'):'',
  content:String(message.content||'')
 };
}

/** Replayed snapshots cannot erase a newer message or reopen a answered question. */
export function mergeDialogueMessages(previous=[],incoming=[]){
 const messages=new Map(previous.map(m=>[m.id,m]));
 for(const message of incoming){const old=messages.get(message.id);messages.set(message.id,old&&['answered','stale'].includes(old.questionStatus)&&message.questionStatus==='pending'?old:message);}
 return [...messages.values()].sort((a,b)=>String(a.at||'').localeCompare(String(b.at||'')));
}
