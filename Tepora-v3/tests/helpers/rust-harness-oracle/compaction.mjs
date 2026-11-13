// TEST-ONLY frozen JavaScript oracle from the current published19008a1 migration snapshot.
// Production imports are forbidden. Only imports/environment shims were adjusted.
import {rawTokens} from './tokens.mjs';
const SMALL_RESULT_TOKENS=300;
import {compactionInstruction,SUMMARIZER_SYSTEM,summarizerRequest,headingsFor,NOTICE} from './prompts.mjs';
import {fitTokens,oneLine} from './format.mjs';
const marks={pending:'[ ]',in_progress:'[>]',done:'[x]',blocked:'[!]'}; const renderTodo=items=>items.length?items.map((t,i)=>`${marks[t.status]||'[ ]'} ${i+1}. ${t.text}`).join('\n'):'(empty)';
import {renderReflection} from './metacog.mjs';

/** Thresholds as fractions of the message budget B (window − output reserve − tool definitions), so they follow the
 * model's context window. Every agent continues in fresh conversations (arXiv 2611.05306, EoCC): past the threshold
 * it writes a brief and the next conversation starts from a <handoff> of ledger + brief. A work agent keeps only
 * its original task beside them, and also hands off after each finished checklist step (SAC-like). The character
 * keeps its last COMPACTION.tailTurns exchanges verbatim (at most COMPACTION.tail of B) so the conversation flows
 * on, and hands off between turns: while the user is quiet past COMPACTION.idle, and inside a turn only when it is
 * about to overflow (COMPACTION.mainHard). The brief is 0.06B, 400–4000 tokens, so a fresh conversation starts well
 * under a third of the budget even on a 16k window, leaving room for real progress (App. D). */
export const COMPACTION={maxImages:6,keepImages:3,softClear:0.72,minClear:0.15,minClearTokens:500,hard:0.8,mainHard:0.9,tail:0.15,tailTurns:3,idle:0.55,briefShare:0.06,briefMin:400,briefMax:4000,ledgerShare:0.1,ledgerMax:8000,instructionShare:0.06,mainInstructions:12,hotSteps:2};
export const briefBudget=B=>Math.round(Math.min(COMPACTION.briefMax,Math.max(COMPACTION.briefMin,B*COMPACTION.briefShare)));
/** Checklist items done, and whether a step finished since the last handoff with work still open. */
const doneSteps=todo=>(todo||[]).filter(t=>t.status==='done').length;
const stepFinished=(todo,checkpoint)=>{const done=doneSteps(todo);return done>(checkpoint?.stepsDone||0)&&done<(todo||[]).length;};
export const ledgerLimits=B=>({instructionTokens:Math.round(Math.min(6000,Math.max(600,B*COMPACTION.instructionShare))),evidence:Math.round(Math.min(40,Math.max(8,B*0.03/30))),maxTokens:Math.round(Math.min(COMPACTION.ledgerMax,Math.max(500,B*COMPACTION.ledgerShare)))});

/* ---------------- ledger: exact state, derived from the log, never written by a model ---------------- */
export function emptyLedger(){return {task:null,instructions:[],omittedInstructions:0,files:{},reads:{},sources:{},searches:[],artifacts:{},sessions:{},processes:{},errors:[],evidence:[]};}
export function foldLedger(previous,entries,{kind,instructionTokens=4000,evidence=40}={}){
 const l={...emptyLedger(),...structuredClone(previous||{})};
 for(const e of entries){
  if(e.type==='input'){
   const item={seq:e.seq,at:e.at,from:e.from||'user',header:e.header||'',text:e.text};
   if(e.kind==='task'&&!l.task)l.task=item;
   else if(['task','message'].includes(e.kind||'message')&&!e.from?.startsWith?.('child:'))l.instructions.push(item);
   if(e.kind==='report'&&e.sessionId)l.sessions[e.sessionId]={...(l.sessions[e.sessionId]||{}),title:e.title||l.sessions[e.sessionId]?.title||'',status:e.status||'reported',seq:e.seq};
  }
  if(e.type!=='tool')continue;
  const d=e.data||{};
  if(e.error)l.errors.push({seq:e.seq,tool:e.name,error:oneLine(e.errorText||e.content,160)});
  if(['write','edit'].includes(e.name)&&d.path)l.files[d.path]={op:d.op,bytes:d.bytes,sha:d.sha,seq:e.seq};
  if(e.name==='artifact'&&d.id)l.artifacts[d.id]={title:d.title,version:d.version,seq:e.seq};
  if(e.name==='sessions_spawn'&&d.sessionId)l.sessions[d.sessionId]={...(l.sessions[d.sessionId]||{}),title:d.title,status:'started',seq:e.seq};
  if(e.name==='exec'&&d.processId)l.processes[d.processId]={command:oneLine(e.args?.command,100),seq:e.seq};
  // What was looked at, so a long task neither re-reads blindly nor loses where its facts came from.
  if(e.name==='read'&&e.args?.path&&!e.error){delete l.reads[e.args.path];l.reads[e.args.path]=e.seq;}
  if(e.name==='web_fetch'&&(d.url||e.args?.url)&&!e.error){const url=d.url||e.args.url;delete l.sources[url];l.sources[url]={title:oneLine(/^# (.+)$/m.exec(e.content||'')?.[1]||'',90),seq:e.seq};}
  if(e.name==='web_search'&&e.args?.query)l.searches.push({query:oneLine(e.args.query,90),seq:e.seq});
  if(!e.ephemeralKey)l.evidence.push({seq:e.seq,stub:e.stub||e.name});
 }
 l.errors=l.errors.slice(-8);l.evidence=l.evidence.slice(-evidence);l.searches=l.searches.slice(-12);
 const newest=(o,n)=>Object.fromEntries(Object.entries(o).slice(-n));l.reads=newest(l.reads,40);l.sources=newest(l.sources,40);
 // Instructions are kept verbatim. Workers keep as many as fit a budget (newest first); the main
 // session keeps its latest utterances, older ones live in the brief and in recall.
 if(kind==='main'){const over=l.instructions.length-COMPACTION.mainInstructions;if(over>0){l.omittedInstructions+=over;l.instructions=l.instructions.slice(over);}}
 else{let total=0,keep=0;for(let i=l.instructions.length-1;i>=0;i--){total+=rawTokens(l.instructions[i].text);if(total>instructionTokens&&keep>0)break;keep++;}
  const over=l.instructions.length-keep;if(over>0){l.omittedInstructions+=over;l.instructions=l.instructions.slice(over);}}
 return l;
}
const fmtBytes=n=>n===undefined?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
/** Sections in priority order; when over `maxTokens` the least important (evidence index first) shrink. */
export function renderLedger(l,{todo=null,reflection=null,live={},maxTokens=Infinity,task=true}={}){
 let evidence=l.evidence.length,files=60;
 for(;;){const text=ledgerSections(l,{todo,reflection,live,evidence,files,task});if(rawTokens(text)<=maxTokens||evidence===0&&files<=5)return text;if(evidence>0)evidence=Math.floor(evidence/2);else files=Math.max(5,Math.floor(files/2));}
}
function ledgerSections(l,{todo,reflection,live,evidence,files:fileCount,task}){
 const s=[];
 if(task&&l.task)s.push(`### Task (verbatim, #${l.task.seq})\n${l.task.text}`);
 if(l.instructions.length)s.push(`### Instructions received (verbatim, oldest first${l.omittedInstructions?`; ${l.omittedInstructions} older ones only in the brief and recall`:''})\n`+l.instructions.map(i=>`- #${i.seq} ${i.header||'['+i.from+']'} ${i.text}`).join('\n'));
 if(todo?.length)s.push(`### Checklist\n${renderTodo(todo)}`);
 if(reflection)s.push(`### Self-assessment (your reflect notes, verbatim)\n${renderReflection(reflection)}`);
 const files=Object.entries(l.files);if(files.length)s.push(`### Files written or edited${files.length>fileCount?` (latest ${fileCount} of ${files.length})`:''}\n`+files.slice(-fileCount).map(([p,f])=>`- ${p} (${f.op}, ${fmtBytes(f.bytes)}, sha ${f.sha}, #${f.seq})`).join('\n'));
 const reads=Object.entries(l.reads||{}).filter(([p])=>!l.files[p]);if(reads.length)s.push(`### Files read\n`+reads.slice(-Math.min(fileCount,30)).map(([p,seq])=>`- ${p} (#${seq})`).join('\n'));
 const sources=Object.entries(l.sources||{});if(sources.length)s.push(`### Web pages read\n`+sources.slice(-Math.min(fileCount,30)).map(([u,x])=>`- ${u}${x.title?` "${x.title}"`:''} (#${x.seq})`).join('\n')+(l.searches?.length?`\nSearches: `+l.searches.map(q=>JSON.stringify(q.query)).join(', '):''));
 const arts=Object.entries(l.artifacts);if(arts.length)s.push(`### Artifacts\n`+arts.map(([id,a])=>`- ${id} "${a.title}" v${a.version} (#${a.seq})`).join('\n'));
 const sessions=Object.entries(l.sessions);if(sessions.length)s.push(`### Agent sessions\n`+sessions.map(([id,x])=>`- ${id} "${x.title||''}" [${live.sessions?.[id]||x.status}]`).join('\n'));
 const procs=Object.entries(l.processes);if(procs.length)s.push(`### Background processes\n`+procs.map(([id,p])=>`- ${id} ${JSON.stringify(p.command)} [${live.processes?.[id]||'unknown'}]`).join('\n'));
 if(l.errors.length)s.push(`### Recent errors\n`+l.errors.map(e=>`- #${e.seq} ${e.tool}: ${e.error}`).join('\n'));
 if(evidence)s.push(`### Evidence index (recall("#n") reads one in full)\n`+l.evidence.slice(-evidence).map(e=>`- #${e.seq} ${e.stub}`).join('\n'));
 return s.join('\n\n')||'(nothing recorded yet)';
}
/** A fresh conversation: the exact ledger and the brief, with a work agent's original task verbatim. The character
 * has no task; its latest exchanges follow the handoff verbatim instead. */
export function handoffText({kind='worker',upTo,at,method,reason,task,ledger,brief}){
 const main=kind==='main';
 return `<handoff covers="#1–#${upTo}" made="${at}" method="${method}" reason="${reason}">
${main?'This is a fresh conversation continuing your conversation with the user; the latest exchanges follow this message verbatim. Earlier turns are stored in full':'This is a fresh conversation continuing the task below. Earlier conversations are stored in full'}: recall("#n") reads any entry exactly and history_search finds older details.
${main?'':`
## Original task (verbatim${task?`, #${task.seq}`:''})
${task?task.text:'(not recorded)'}
`}
## Ledger (exact, kept by the harness)
${ledger}

## Brief (written at the handoff)
${brief}
</handoff>`;
}
/** What `fork` hands a new agent: its requester's ledger and latest brief in the handoff shape, plus the turns since
 * that brief (a requester has not written a brief for this moment). References point into the requester's log. */
export function forkContext({parentId,kind,checkpoint=null,entries=[],todo=null,reflection=null}){
 const ledger=foldLedger(checkpoint?.ledger,entries,{kind,instructionTokens:1500,evidence:8});
 const recent=entries.filter(e=>['input','assistant'].includes(e.type)).slice(-30);
 return `--- Context from your requester (quoted, for reference; #n refers to its log: recall("${parentId}#n")) ---
## Requester's ledger
${renderLedger(ledger,{todo,reflection,maxTokens:2500})}

## Requester's brief${checkpoint?` (#${checkpoint.seq})`:''}
${checkpoint?.summary?fitTokens(checkpoint.summary,2500,'#'+checkpoint.seq).text:'(none yet)'}${recent.length?`

## Since the brief
${fitTokens(transcriptText(recent),2500,'recent').text}`:''}`;
}
const URLS=/https?:\/\/[^\s)>\]"'`<]+/g,PATHS=/(?:^|[\s"'`(=])((?:~|\/)(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8})\b/g;
/** URLs and file paths that came up in a stretch but appear in neither the brief nor the ledger. A brief that
 * forgets the one link the next step needs is the classic compaction failure; this list is the safety net. */
export function missingIdentifiers(entries,known,limit=25){
 const seen=new Map();
 for(const e of entries){
  const text=e.type==='assistant'?[e.content,...(e.toolCalls||[]).map(c=>c.arguments)].join('\n'):e.type==='tool'?String(e.content||'').slice(0,20000):e.type==='input'?e.text:'';
  for(const m of String(text||'').matchAll(URLS)){const u=m[0].replace(/[.,;:!?]+$/,'');if(u.length<300)seen.set(u,e.seq);}
  for(const m of String(text||'').matchAll(PATHS))if(m[1].length<240)seen.set(m[1],e.seq);
 }
 return [...seen].filter(([id])=>!known.includes(id)).slice(-limit).map(([id,seq])=>`- ${id} (#${seq})`);
}
export function validSummary(text,maxTokens,kind='worker'){
 const t=String(text||'').trim();if(t.length<60)return false;
 const headings=(t.match(/^#{1,3} +\S/gm)||[]).length,named=headingsFor(kind).filter(h=>t.toLowerCase().includes(h.toLowerCase())).length;
 return (named>=5||headings>=5)&&rawTokens(t)<=maxTokens*2;
}
/** A transcript rendering for out-of-context summarisation: bounded per entry, with references. */
export function transcriptText(entries,clearUpTo=0){
 return entries.map(e=>{
  if(e.type==='input')return `#${e.seq} ${e.header||'['+(e.from||'user')+']'} ${fitTokens(e.text,1500,'#'+e.seq).text}`;
  if(e.type==='notice')return `#${e.seq} [harness] ${oneLine(e.text,300)}`;
  if(e.type==='assistant')return `#${e.seq} assistant: ${fitTokens(e.content||'',1000,'#'+e.seq).text}${(e.toolCalls||[]).map(c=>`\n  → ${c.name}(${oneLine(c.arguments,200)})`).join('')}`;
  if(e.type==='tool')return `#${e.seq} result: ${e.seq<=clearUpTo&&!e.keep||e.ephemeralKey?e.stub:fitTokens(e.content||'',500,'#'+e.seq).text}`;
  return '';
 }).filter(Boolean).join('\n');
}
function chunks(text,maxTokens){
 const lines=text.split('\n'),out=[];let cur=[],size=0;
 for(const line of lines){const n=rawTokens(line)+1;if(size+n>maxTokens&&cur.length){out.push(cur.join('\n'));cur=[];size=0;}cur.push(line);size+=n;}
 if(cur.length)out.push(cur.join('\n'));return out;
}

const imagesIn=x=>Array.isArray(x.message.content)?x.message.content.filter(p=>p.type==='image_url').length:0;
const countImages=rendered=>rendered.reduce((n,x)=>n+imagesIn(x),0);
/** The seq of the entry holding the COMPACTION.keepImages-th newest image: an image clear stops below it. */
const keepImagesFrom=r=>{let n=0;for(let i=r.length-1;i>=0;i--){n+=imagesIn(r[i]);if(n>=COMPACTION.keepImages)return r[i].entry.seq;}return -Infinity;};
/* ---------------- compactor ---------------- */
export class Compactor{
 constructor({sessions,assembler,registry,emit=()=>{}}){Object.assign(this,{sessions,assembler,registry,emit});}
 /** Decide what to do before a model call. `ratio` converts raw estimates into the model's tokens. */
 plan(built,B,ratio,{idle=false,force=false,session=null}={}){
  const used=built.tokens*ratio,main=session?.kind==='main';
  if(force)return {action:'compact',used,forced:true};
  if(idle)return used>COMPACTION.idle*B?{action:'compact',used}:{action:'none',used};
  // Step handoff: a work agent that finished a checklist step starts the next one in a fresh conversation, when the
  // conversation it drops is larger than the brief it writes.
  if(session&&!main&&stepFinished(session.todo,built.view.checkpoint)&&built.rendered.reduce((n,x)=>n+x.tokens,0)*ratio>=2*briefBudget(B))return {action:'compact',used,reason:'step'};
  // Screenshots pile up fast in computer use: past COMPACTION.maxImages in view, clear the older ones in one batch
  // even below the usual threshold, keeping the newest COMPACTION.keepImages. Clearing in batches (not one image per
  // turn) keeps the cached prompt prefix intact until the next batch.
  const images=countImages(built.rendered);
  if(images>COMPACTION.maxImages){const c=this.clearCandidate(built,ratio,keepImagesFrom(built.rendered));if(c&&c.images<images)return {action:'clear',used,...c,images};}
  if(used<=COMPACTION.softClear*B)return {action:'none',used};
  const clear=this.clearCandidate(built,ratio);
  // The character hands off between turns (idle, above); inside a turn only when it is about to overflow.
  const minClear=Math.max(COMPACTION.minClear*B,COMPACTION.minClearTokens),hard=(main?COMPACTION.mainHard:COMPACTION.hard)*B;
  if(clear&&clear.savings>=minClear&&used-clear.savings<=hard)return {action:'clear',used,...clear};
  if(used>hard)return {action:'compact',used,clear};
  if(clear&&clear.savings>=minClear)return {action:'clear',used,...clear};
  return {action:'none',used};
 }
 /** Moving the clear watermark up to the hot window (the last COMPACTION.hotSteps steps stay verbatim):
  * what it would save, measured by rendering both ways. Results, superseded ephemeral results, handled
  * reports and long arguments of old calls all shrink in the same batch, so the cache breaks once. */
 clearCandidate(built,ratio,keepFrom=Infinity){
  const r=built.rendered,assistants=r.filter(x=>x.entry.type==='assistant');
  const hot=assistants.length>=COMPACTION.hotSteps?assistants[assistants.length-COMPACTION.hotSteps].entry.seq:Infinity;
  const below=r.filter(x=>x.entry.seq>built.view.clearUpTo&&x.entry.seq<Math.min(hot,keepFrom));
  if(!below.length)return null;
  const upTo=below.at(-1).entry.seq,before=r.reduce((n,x)=>n+x.tokens,0);
  const preview=this.assembler.renderEntries(built.view,{clearUpTo:upTo,vision:built.vision}),after=preview.reduce((n,x)=>n+x.tokens,0);
  const savings=Math.max(0,(before-after)*ratio);
  return savings>0?{savings,upTo,images:countImages(preview)}:null;
 }
 clear(session,upTo){
  const e=this.sessions.append(session.id,'clear',{upTo});
  this.sessions.update(session.id,{stats:{...this.sessions.get(session.id).stats,clears:(session.stats?.clears||0)+1}});
  this.emit('compaction',{sessionId:session.id,action:'clear',upTo});return e;
 }
 /** A handoff drops the whole conversation: the boundary is the end of the last step. Only input that arrived
  * after it (a new instruction, a harness notice) stays in view. */
 handoffBoundary(built){
  const r=built.rendered,last=r.findLastIndex(x=>['assistant','tool'].includes(x.entry.type));
  return last<0?null:{upTo:r[last].entry.seq,tailFrom:r[last+1]?.entry.seq??null};
 }
 /** Where the character's verbatim tail starts: the last COMPACTION.tailTurns exchanges (an exchange starts at an
  * input after anything else), at most COMPACTION.tail of the budget, beginning at a turn boundary. */
 boundary(built,B,ratio,tailShare=COMPACTION.tail){
  const r=built.rendered;if(r.length<2)return null;
  const starts=i=>r[i].entry.type==='input'&&(i===0||r[i-1].entry.type!=='input');
  let size=0,i=r.length,turns=0;
  while(i>0&&turns<COMPACTION.tailTurns&&size+r[i-1].tokens*ratio<=tailShare*B){i--;size+=r[i].tokens*ratio;if(starts(i))turns++;}
  // At least the last step (the newest assistant call with its results) stays verbatim.
  const lastAssistant=r.findLastIndex(x=>x.entry.type==='assistant'),lastStep=lastAssistant>=0?lastAssistant:r.findLastIndex(x=>x.entry.type!=='tool');
  if(i>lastStep)i=lastStep;
  while(i>0&&r[i].entry.type==='tool')i--;
  if(i===0){const lastAssistant=r.findLastIndex(x=>x.entry.type==='assistant');i=lastAssistant>0?lastAssistant:r.length-1;while(i>0&&r[i].entry.type==='tool')i--;}
  if(i<=0)return null;
  return {upTo:r[i-1].entry.seq,tailFrom:r[i].entry.seq};
 }
 /** Hand off to a fresh conversation: the character keeps its latest exchanges verbatim after the handoff, a work
  * agent drops its whole conversation. Never throws for a model failure: degrades to a deterministic brief. */
 async compact(session,{built,B,ratio,system,toolDefs,chain,signal,reason='budget',tailShare,todo=null,reflection=null,live={},cacheRetention='short'}){
  const kind=session.kind,main=kind==='main';
  const bound=main?this.boundary(built,B,ratio,tailShare):this.handoffBoundary(built);
  if(!bound)return null;
  const prev=built.view.checkpoint,from=(prev?.upTo||0)+1;
  const folded=this.sessions.entries(session.id,{from,to:bound.upTo}).filter(e=>['input','notice','assistant','tool'].includes(e.type));
  const limits=ledgerLimits(B);
  const ledger=foldLedger(prev?.ledger,folded,{kind:session.kind,...limits});
  const ledgerText=renderLedger(ledger,{todo,reflection,live,maxTokens:limits.maxTokens,task:main});
  const maxTokens=briefBudget(B);
  let summary=null,method='in-context',usage=null;
  // 1) In-context: same prefix as the next call, so it is read from cache; the model sees every detail.
  if(reason!=='overflow'){
   for(let attempt=0;attempt<2&&!summary;attempt++){
    try{
     const messages=[...built.messages,{role:'user',content:compactionInstruction({ledger:ledgerText,previous:!!prev,maxTokens,kind})+(attempt?'\n\nYour previous attempt did not follow the required headings. Use exactly the headings listed.':'')}];
     const answer=await this.registry.invoke(chain,messages,{tools:toolDefs,toolChoice:'none',maxTokens:Math.round(maxTokens*1.5)+512,signal,cacheKey:session.id,slotKey:session.id,cacheRetention,priority:session.kind==='main'?5:0});
     usage=answer.usage;if(answer.finish!=='length'&&validSummary(answer.content,maxTokens,kind))summary=answer.content.trim();
    }catch(e){if(signal?.aborted)throw e;if(e.kind!=='overflow'&&e.kind!=='bad-request')break;}
   }
  }
  // 2) Out of context: fold the segment in chunks on the compaction route.
  if(!summary){
   method='rolling';
   try{
    let rolling=prev?.summary||'';
    for(const part of chunks(transcriptText(folded,built.view.clearUpTo),Math.max(1500,Math.floor(B*0.45)))){
     const answer=await this.registry.invoke('compaction',[{role:'system',content:SUMMARIZER_SYSTEM},{role:'user',content:summarizerRequest({previous:rolling,ledger:ledgerText,transcript:part,maxTokens,kind})}],{maxTokens:Math.round(maxTokens*1.5)+512,signal,priority:session.kind==='main'?5:0});
     if(validSummary(answer.content,maxTokens,kind))rolling=answer.content.trim();else throw new Error('invalid summary');
    }
    summary=rolling;
   }catch(e){if(signal?.aborted)throw e;}
  }
  // 3) Deterministic: the previous summary plus a list of what happened. The loop never stops on this.
  if(!summary){
   method='deterministic';
   const steps=transcriptText(folded.filter(e=>e.type!=='tool'||e.error||!e.ephemeralKey),built.view.clearUpTo).split('\n').map(l=>oneLine(l,240));
   summary=fitTokens(`${prev?.summary?prev.summary+'\n\n':''}## Steps since the previous checkpoint (automatic list; the model summary failed)\n${steps.join('\n')}`,maxTokens,'#'+bound.upTo).text;
  }
  const at=new Date().toISOString(),tokensBefore=Math.round(built.tokens*ratio);
  summary=fitTokens(summary,maxTokens*2,'#'+bound.upTo).text;
  const extra=missingIdentifiers(folded,ledgerText+'\n'+summary);
  const fullLedger=ledgerText+(extra.length?`\n\n### Links and paths seen in this stretch but not in the brief\n${extra.join('\n')}`:'');
  const text=handoffText({kind,upTo:bound.upTo,at,method,reason,task:ledger.task,ledger:fullLedger,brief:summary});
  const cp=this.sessions.append(session.id,'checkpoint',{upTo:bound.upTo,text,summary,ledger,method,reason,previous:prev?.seq||null,tokensBefore,stepsDone:doneSteps(todo)});
  this.sessions.append(session.id,'notice',{text:main?NOTICE.conversationHandedOff(bound.upTo):NOTICE.handedOff(bound.upTo),compaction:cp.seq});
  const s=this.sessions.get(session.id);this.sessions.update(session.id,{stats:{...s.stats,compactions:(s.stats?.compactions||0)+1}});
  this.emit('compaction',{sessionId:session.id,action:'compact',upTo:bound.upTo,method,reason,usage});
  return cp;
 }
}

export {chunks};
