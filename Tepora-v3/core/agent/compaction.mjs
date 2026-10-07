import {rawTokens} from './tokens.mjs';
import {SMALL_RESULT_TOKENS} from './context.mjs';
import {compactionInstruction,SUMMARIZER_SYSTEM,summarizerRequest,SUMMARY_HEADINGS,NOTICE} from './prompts.mjs';
import {fitTokens,oneLine} from '../tools/format.mjs';
import {renderTodo} from '../tools/agent.mjs';

/** Thresholds as fractions of the message budget B (window − output reserve − tool definitions). */
/** After a checkpoint the context should be well under half the budget (system + checkpoint ≤ ~0.25B,
 * verbatim tail ≈ 0.15B), leaving ~0.4B of room before the next one: compaction is a model call plus a cache
 * rebuild, so it must be rare. */
export const COMPACTION={maxImages:6,softClear:0.72,minClear:0.15,minClearTokens:500,hard:0.8,tail:0.15,idle:0.55,summaryShare:0.08,summaryMin:600,summaryMax:8000,ledgerShare:0.1,ledgerMax:8000,instructionShare:0.06,mainInstructions:12,hotSteps:2};
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
 // session keeps its latest utterances, older ones live in the summary and in recall.
 if(kind==='main'){const over=l.instructions.length-COMPACTION.mainInstructions;if(over>0){l.omittedInstructions+=over;l.instructions=l.instructions.slice(over);}}
 else{let total=0,keep=0;for(let i=l.instructions.length-1;i>=0;i--){total+=rawTokens(l.instructions[i].text);if(total>instructionTokens&&keep>0)break;keep++;}
  const over=l.instructions.length-keep;if(over>0){l.omittedInstructions+=over;l.instructions=l.instructions.slice(over);}}
 return l;
}
const fmtBytes=n=>n===undefined?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
/** Sections in priority order; when over `maxTokens` the least important (evidence index first) shrink. */
export function renderLedger(l,{todo=null,live={},maxTokens=Infinity}={}){
 let evidence=l.evidence.length,files=60;
 for(;;){const text=ledgerSections(l,{todo,live,evidence,files});if(rawTokens(text)<=maxTokens||evidence===0&&files<=5)return text;if(evidence>0)evidence=Math.floor(evidence/2);else files=Math.max(5,Math.floor(files/2));}
}
function ledgerSections(l,{todo,live,evidence,files:fileCount}){
 const s=[];
 if(l.task)s.push(`### Task (verbatim, #${l.task.seq})\n${l.task.text}`);
 if(l.instructions.length)s.push(`### Instructions received (verbatim, oldest first${l.omittedInstructions?`; ${l.omittedInstructions} older ones only in the summary and recall`:''})\n`+l.instructions.map(i=>`- #${i.seq} ${i.header||'['+i.from+']'} ${i.text}`).join('\n'));
 if(todo?.length)s.push(`### Checklist\n${renderTodo(todo)}`);
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
export function checkpointText({upTo,at,ledger,summary,method,chapters=''}){
 return `<checkpoint covers="#1–#${upTo}" made="${at}" method="${method}">
Earlier turns were compacted into this checkpoint. The full transcript is still stored: recall("#n") reads any entry exactly and history_search finds older details.

## Exact ledger (kept by the harness)
${ledger}
${chapters?`
## Chapters (one paragraph per earlier stretch, each written once and never rewritten)
${chapters}
`:''}
## Summary
${summary}
</checkpoint>`;
}
/** Chapters keep each stretch's account as it was written when its details were fresh, so repeated compaction
 * does not wear old facts down (a summary of a summary of a summary). The newest fit a budget; older ones stay
 * findable by range. */
export function renderChapters(chapters,maxTokens){
 const shown=[];let size=0;
 for(let i=chapters.length-1;i>=0;i--){const c=chapters[i],line=`- #${c.from}–#${c.upTo} (${String(c.at).slice(0,16).replace('T',' ')}): ${c.digest}`;size+=rawTokens(line);if(size>maxTokens&&shown.length)break;shown.unshift(line);}
 const hidden=chapters.length-shown.length;
 return (hidden?`- #${chapters[0].from}–#${chapters[hidden-1].upTo}: ${hidden} older chapter${hidden>1?'s':''}, kept in the transcript (history_search, recall)\n`:'')+shown.join('\n');
}
const SECTION=name=>new RegExp(`^#{1,3} *${name}\\s*\\n([\\s\\S]*?)(?=^#{1,3} |(?![\\s\\S]))`,'mi');
/** Splits the model's "Chapter digest" section off its summary. */
export function takeDigest(summary){
 const m=SECTION('Chapter digest').exec(summary);if(!m)return {summary,digest:''};
 return {summary:summary.replace(m[0],'').trim(),digest:oneLine(m[1],900)};
}
const URLS=/https?:\/\/[^\s)>\]"'`<]+/g,PATHS=/(?:^|[\s"'`(=])((?:~|\/)(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8})\b/g;
/** URLs and file paths that came up in a stretch but appear in neither the summary nor the ledger. A summary that
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
export function validSummary(text,maxTokens){
 const t=String(text||'').trim();if(t.length<60)return false;
 const headings=(t.match(/^#{1,3} +\S/gm)||[]).length,named=SUMMARY_HEADINGS.filter(h=>t.toLowerCase().includes(h.toLowerCase())).length;
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

const countImages=rendered=>rendered.reduce((n,x)=>n+(Array.isArray(x.message.content)?x.message.content.filter(p=>p.type==='image_url').length:0),0);
/* ---------------- compactor ---------------- */
export class Compactor{
 constructor({sessions,assembler,registry,emit=()=>{}}){Object.assign(this,{sessions,assembler,registry,emit});}
 summaryBudget(B){return Math.round(Math.min(COMPACTION.summaryMax,Math.max(COMPACTION.summaryMin,B*COMPACTION.summaryShare)));}
 /** Decide what to do before a model call. `ratio` converts raw estimates into the model's tokens. */
 plan(built,B,ratio,{idle=false,force=false}={}){
  const used=built.tokens*ratio;
  if(force)return {action:'compact',used,forced:true};
  if(idle)return used>COMPACTION.idle*B?{action:'compact',used}:{action:'none',used};
  // Screenshots pile up fast in computer use: past a handful in view, clear them in one batch even below the
  // usual threshold (the newest stays, as ephemeral results do).
  const images=countImages(built.rendered);
  if(images>COMPACTION.maxImages){const c=this.clearCandidate(built,ratio);if(c&&c.images<images)return {action:'clear',used,...c,images};}
  if(used<=COMPACTION.softClear*B)return {action:'none',used};
  const clear=this.clearCandidate(built,ratio);
  const minClear=Math.max(COMPACTION.minClear*B,COMPACTION.minClearTokens);
  if(clear&&clear.savings>=minClear&&used-clear.savings<=COMPACTION.hard*B)return {action:'clear',used,...clear};
  if(used>COMPACTION.hard*B)return {action:'compact',used,clear};
  if(clear&&clear.savings>=minClear)return {action:'clear',used,...clear};
  return {action:'none',used};
 }
 /** Moving the clear watermark up to the hot window (the last COMPACTION.hotSteps steps stay verbatim):
  * what it would save, measured by rendering both ways. Results, superseded ephemeral results, handled
  * reports and long arguments of old calls all shrink in the same batch, so the cache breaks once. */
 clearCandidate(built,ratio){
  const r=built.rendered,assistants=r.filter(x=>x.entry.type==='assistant');
  const hot=assistants.length>=COMPACTION.hotSteps?assistants[assistants.length-COMPACTION.hotSteps].entry.seq:Infinity;
  const below=r.filter(x=>x.entry.seq>built.view.clearUpTo&&x.entry.seq<hot);
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
 /** Where the verbatim tail starts: about COMPACTION.tail of the budget, beginning at a turn boundary. */
 boundary(built,B,ratio,tailShare=COMPACTION.tail){
  const r=built.rendered;if(r.length<2)return null;
  let size=0,i=r.length;
  while(i>0&&size+r[i-1].tokens*ratio<=tailShare*B){i--;size+=r[i].tokens*ratio;}
  // At least the last step (the newest assistant call with its results) stays verbatim.
  const lastAssistant=r.findLastIndex(x=>x.entry.type==='assistant'),lastStep=lastAssistant>=0?lastAssistant:r.findLastIndex(x=>x.entry.type!=='tool');
  if(i>lastStep)i=lastStep;
  while(i>0&&r[i].entry.type==='tool')i--;
  if(i===0){const lastAssistant=r.findLastIndex(x=>x.entry.type==='assistant');i=lastAssistant>0?lastAssistant:r.length-1;while(i>0&&r[i].entry.type==='tool')i--;}
  if(i<=0)return null;
  return {upTo:r[i-1].entry.seq,tailFrom:r[i].entry.seq};
 }
 /** Summarise into a checkpoint. Never throws for a model failure: degrades to a deterministic summary. */
 async compact(session,{built,B,ratio,system,toolDefs,chain,signal,reason='budget',tailShare,todo=null,live={},cacheRetention='short'}){
  const bound=this.boundary(built,B,ratio,tailShare);
  if(!bound)return null;
  const prev=built.view.checkpoint,from=(prev?.upTo||0)+1;
  const folded=this.sessions.entries(session.id,{from,to:bound.upTo}).filter(e=>['input','notice','assistant','tool'].includes(e.type));
  const limits=ledgerLimits(B);
  const ledger=foldLedger(prev?.ledger,folded,{kind:session.kind,...limits});
  const ledgerText=renderLedger(ledger,{todo,live,maxTokens:limits.maxTokens});
  const maxTokens=this.summaryBudget(B);
  let summary=null,method='in-context',usage=null;
  // 1) In-context: same prefix as the next call, so it is read from cache; the model sees every detail.
  if(reason!=='overflow'){
   for(let attempt=0;attempt<2&&!summary;attempt++){
    try{
     const messages=[...built.messages,{role:'user',content:compactionInstruction({ledger:ledgerText,previous:!!prev,maxTokens})+(attempt?'\n\nYour previous attempt did not follow the required headings. Use exactly the headings listed.':'')}];
     const answer=await this.registry.invoke(chain,messages,{tools:toolDefs,toolChoice:'none',maxTokens:Math.round(maxTokens*1.5)+512,signal,cacheKey:session.id,slotKey:session.id,cacheRetention,priority:session.kind==='main'?5:0});
     usage=answer.usage;if(answer.finish!=='length'&&validSummary(answer.content,maxTokens))summary=answer.content.trim();
    }catch(e){if(signal?.aborted)throw e;if(e.kind!=='overflow'&&e.kind!=='bad-request')break;}
   }
  }
  // 2) Out of context: fold the segment in chunks on the compaction route.
  if(!summary){
   method='rolling';
   try{
    let rolling=prev?.summary||'';
    for(const part of chunks(transcriptText(folded,built.view.clearUpTo),Math.max(1500,Math.floor(B*0.45)))){
     const answer=await this.registry.invoke('compaction',[{role:'system',content:SUMMARIZER_SYSTEM},{role:'user',content:summarizerRequest({previous:rolling,ledger:ledgerText,transcript:part,maxTokens})}],{maxTokens:Math.round(maxTokens*1.5)+512,signal,priority:session.kind==='main'?5:0});
     if(validSummary(answer.content,maxTokens))rolling=answer.content.trim();else throw new Error('invalid summary');
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
  const split=takeDigest(summary);summary=fitTokens(split.summary,maxTokens*2,'#'+bound.upTo).text;
  const at=new Date().toISOString();
  // This stretch's chapter: the model's digest, or a plain account when the summary came from the fallback.
  const digest=split.digest||oneLine([folded.find(e=>e.type==='input')?.text,folded.findLast(e=>e.type==='assistant'&&e.content)?.content].filter(Boolean).join(' … '),400)||'(no conversation in this stretch)';
  const chapters=[...(prev?.chapters||[]),{from,upTo:bound.upTo,at,digest}];
  const extra=missingIdentifiers(folded,ledgerText+'\n'+summary+'\n'+chapters.map(c=>c.digest).join('\n'));
  const fullLedger=ledgerText+(extra.length?`\n\n### Links and paths seen in this stretch but not in the summary\n${extra.join('\n')}`:'');
  const text=checkpointText({upTo:bound.upTo,at,ledger:fullLedger,summary,method,chapters:renderChapters(chapters,Math.round(Math.min(4000,Math.max(300,B*0.04))))});
  const cp=this.sessions.append(session.id,'checkpoint',{upTo:bound.upTo,text,summary,ledger,chapters,method,reason,previous:prev?.seq||null,tokensBefore:Math.round(built.tokens*ratio)});
  this.sessions.append(session.id,'notice',{text:NOTICE.compacted(bound.upTo),compaction:cp.seq});
  const s=this.sessions.get(session.id);this.sessions.update(session.id,{stats:{...s.stats,compactions:(s.stats?.compactions||0)+1}});
  this.emit('compaction',{sessionId:session.id,action:'compact',upTo:bound.upTo,method,reason,usage});
  return cp;
 }
}
