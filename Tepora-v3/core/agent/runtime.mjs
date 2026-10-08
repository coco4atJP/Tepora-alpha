import {mkdirSync,existsSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {SessionStore} from './sessions.mjs';
import {ContextAssembler} from './context.mjs';
import {Compactor,transcriptText} from './compaction.mjs';
import {TokenCalibration} from './tokens.mjs';
import {AgentLoop} from './loop.mjs';
import {RuntimeHost} from './runtime-host.mjs';
import {NOTICE,isSilentReply,mayBeSilent} from './prompts.mjs';
import {ToolRegistry} from '../tools/registry.mjs';
import {ProcessManager,execTools} from '../tools/exec.mjs';
import {fsTools} from '../tools/fs.mjs';
import {WebTools} from '../tools/web.mjs';
import {agentTools,skillIndex} from '../tools/agent.mjs';
import {McpPool} from '../tools/mcp-pool.mjs';
import {Policy} from './policy.mjs';
import {Scheduler,scheduleTool} from './schedule.mjs';
import {Decisions} from './decisions.mjs';
import {reflectTool} from './metacog.mjs';
import {Dreamer} from './dream.mjs';
import {computerTool} from '../computer/index.mjs';
import {mediaTool} from '../tools/media.mjs';
import {renderTodo} from '../tools/agent.mjs';
import {sandboxConfig,SANDBOX_DEFAULT} from '../sandbox.mjs';
import {defaultPersonas,normalizePersonas} from '../persona.mjs';
import {fitTokens,oneLine} from '../tools/format.mjs';
import {invariant} from '../policy.mjs';
import {estimateModelUsage,modelUsageSnapshot} from '../model-usage.mjs';

export const AGENT_DEFAULTS=Object.freeze({workRoot:'',maxDepth:3,maxSteps:0,progressEvery:50,concurrency:8,verifyCompletion:'auto',delegationGuard:true,metacognition:true,dream:true,cacheRetention:{main:'long',worker:'short'},budget:{sessionUsd:0,dailyUsd:0},
 heartbeat:{enabled:false,minutes:30,text:''},sandbox:SANDBOX_DEFAULT,webSearch:{provider:'auto',searxngUrl:'',braveKeyEnv:'BRAVE_API_KEY'},policy:{rules:[]},idleCompactSeconds:20});
const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
export function stampHeader(date=new Date(),source=''){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'}).formatToParts(date).map(x=>[x.type,x.value]));
 return `[${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour}:${p.minute} ${p.timeZoneName}${source?' · '+source:''}]`;
}

/** Path grammar follows the host filesystem; foreign drive syntax is not a native root. */
export function claimPathPatterns(paths=path){
 const windows=paths.sep==='\\',separator=windows?String.raw`[\\/]`:'/',root=windows?String.raw`(?:[A-Za-z]:[\\/]|[\\/]{2}|[\\/]|~[\\/])`:String.raw`(?:/|~/)`;
 // Windows may expose 8.3 aliases (RUNNER~1, REPORT~1.TXT); retain POSIX's existing grammar.
 const component=windows?String.raw`[\w.~-]`:String.raw`[\w.-]`,first=windows?String.raw`[\w~-]`:String.raw`[\w-]`,continuation=windows?String.raw`[\w/\\~-]`:String.raw`[\w/\\-]`;
 const filePattern=new RegExp(String.raw`(?<![\w/\\:.~-])((?:${root}|\.${separator})?(?:${component}+${separator})*${first}${component}*\.[A-Za-z][A-Za-z0-9]{0,5})(?!${continuation}|\.[A-Za-z0-9])`,'gu');
 const directoryPattern=new RegExp(String.raw`["'\x60（(「『](${root}[^"'\x60）)」』\r\n]+)["'\x60）)」』]|(?:^|[\s：]|(?<![A-Za-z]):)(${root}[^\s"'\x60）)」』、。,]+)`,'gu');
 return {windows,filePattern,directoryPattern};
}

/** File paths the task or the final report names that do not exist in the agent's folder. Small models often
 * say "I saved notes/a.txt" without having called a tool; this catches that without any model, before the report is
 * accepted. Only relative or home/absolute paths with an extension count; URLs and code like `a.b` are ignored. */
export function missingFiles(s,report,inputs=[],tools=[]){
 if(!s.cwd)return [];
 // Relative names resolve against every folder the work actually happened in: the session folder, folders the
 // task names, and folders the agent's tools used (a task may say "in /path/to/project, write notes.md").
 const bases=new Set([s.cwd]),touched=[];
 for(const t of tools){if(t.error)continue;const p=t.data?.path||t.args?.path;if(typeof p==='string'){touched.push(p);bases.add(path.dirname(path.resolve(s.cwd,p)));}if(typeof t.args?.cwd==='string')bases.add(path.resolve(s.cwd,t.args.cwd));}
 const task=inputs.filter(e=>e.kind==='task'||e.from==='user'||e.from==='parent').map(e=>e.text).join('\n');
 const {windows,filePattern,directoryPattern}=claimPathPatterns();
 const names=new Set(),scan=text=>{for(const m of String(text||'').replace(/https?:\/\/\S+/g,' ').matchAll(filePattern))names.add(m[1]);};
 scan(task);const fromTask=new Set(names);scan(report);
 // Quoted / parenthesized roots may contain spaces; unquoted roots stop at whitespace.
 for(const m of task.replace(/https?:\/\/\S+/g,' ').matchAll(directoryPattern)){
  const named=m[1]||m[2],d=/^~[\\/]/.test(named)?path.join(os.homedir(),named.slice(2)):named;
  if(!path.isAbsolute(d))continue;
  try{if(existsSync(d)&&statSync(d).isDirectory())bases.add(d);}catch{}
 }
 const out=[];
 for(const n of names){
  if(/^\d|^v?\d+\.\d+/.test(n)||/^(e\.g|i\.e|etc)\.?$/i.test(n)||!/[\/.]/.test(n)||/\.\.\.|…/.test(n))continue;
  // A path only in the report must look like a file the agent claims to have made (with a folder, or a name the task used).
  if(!fromTask.has(n)&&!n.includes('/')&&!(windows&&n.includes('\\')))continue;
  const candidates=(n.startsWith('~/')||(windows&&n.startsWith('~\\')))?[path.join(os.homedir(),n.slice(2))]:path.isAbsolute(n)?[n]:[...bases].map(b=>path.resolve(b,n));
  if(!candidates.some(f=>existsSync(f))&&!touched.some(p=>path.normalize(p)===path.normalize(n)||path.normalize(p).endsWith(path.sep+path.normalize(n).replace(windows?/^\.[\\/]/:/^\.\//,''))))out.push(n);
  if(out.length>=8)break;
 }
 return out;
}

/** Owns every agent session: the resident main session (the character, an orchestrator) and any number
 * of asynchronous workers. Sessions talk through inboxes; nothing fails permanently — failures wait and retry. */
export class AgentRuntime{
 constructor(store,{registry,network,toolHub=null,capabilities=null,computer=null,media=null,semantic=null,workRoot,pluginDir=null,clock=()=>Date.now(),autoStart=true}={}){
  Object.assign(this,{store,registry,network,toolHub,capabilities,computer,media,semantic,clock});
  this.sessions=new SessionStore(store);this.assembler=new ContextAssembler(this.sessions);this.calibration=new TokenCalibration(store);
  this.compactor=new Compactor({sessions:this.sessions,assembler:this.assembler,registry,emit:(type,data)=>this.store.emit('agent.'+type,data)});
  this.loop=new AgentLoop(this);this.processes=new ProcessManager();this.policy=new Policy(this);
  this.workRoot=workRoot||this.settings().workRoot||path.join(os.homedir(),'Tepora');
  this.tools=new ToolRegistry({pluginDir,mcp:toolHub});this.mcp=new McpPool({store,toolHub,network});
  this.decisions=new Decisions(capabilities);this.dreamer=new Dreamer(this);
  // Pages built by JavaScript are rendered in the computer-use browser when one is available.
  this.web=new WebTools({network,settings:()=>this.settings(),keys:name=>this.store.value('search-keys')?.[name]||'',decisions:this.decisions,browser:computer?{render:(url,o)=>computer.render(url,o)}:null});
  this.scheduler=new Scheduler(this);
  this.tools.registerAll([...execTools({processes:this.processes,settings:()=>this.settings()}),...fsTools(),...this.web.tools(),...agentTools(this),scheduleTool(this.scheduler),reflectTool(this.sessions)]);
  if(media&&capabilities)this.tools.register(mediaTool({media,capabilities}));
  if(computer){computer.decisions||=this.decisions;computer.workRoot=()=>this.workRoot;this.tools.register(computerTool(computer));this.computerInfo=()=>computer.info();}
  // Memory search is by meaning when an embedding model is connected (local only unless the user allows more),
  // and by keywords otherwise. New memories are indexed in the background.
  this.memory={
   search:async(query,{limit=8,signal}={})=>{
    if(this.semantic&&this.capabilities?.get().routes?.embedding){try{return (await this.semantic.search(query,{limit,signal})).hits;}catch{}}
    return this.store.recall(query,{limit});
   },
   write:(content,{title='',source=''}={})=>{const m=this.store.memory(content,{title,source,confirmed:true});if(this.semantic&&this.capabilities?.get().routes?.embedding)this.semantic.index().catch(()=>{});return m;}
  };
  this.runs=new Map();this.timers=new Map();this.streams=new Map();this.closed=false;this.waiters=new Set();
  this.nativeRuntime=new RuntimeHost(this);
  this.entryListener=e=>{if(e.type==='session.inbox'&&e.data.item)for(const w of this.waiters)w(e.data);};
  store.listeners.add(this.entryListener);
  if(autoStart)this.start();
 }
 settings(){const s=this.store.value('agent-settings')||{};return {...AGENT_DEFAULTS,...s,heartbeat:{...AGENT_DEFAULTS.heartbeat,...s.heartbeat},cacheRetention:{...AGENT_DEFAULTS.cacheRetention,...s.cacheRetention},budget:{...AGENT_DEFAULTS.budget,...s.budget},sandbox:sandboxConfig(s.sandbox||{}),webSearch:{...AGENT_DEFAULTS.webSearch,...s.webSearch},policy:{...AGENT_DEFAULTS.policy,...s.policy}};}
 configure(patch){
  invariant(patch&&typeof patch==='object'&&!Array.isArray(patch),'Invalid agent settings');
  const old=this.store.value('agent-settings')||{},next={...old,...patch};
  if(patch.sandbox)next.sandbox=sandboxConfig(patch.sandbox,old.sandbox||SANDBOX_DEFAULT);
  for(const k of ['maxDepth','maxSteps','progressEvery','concurrency','idleCompactSeconds'])if(k in patch)invariant(Number.isInteger(patch[k])&&patch[k]>=0&&patch[k]<=100000,`Invalid ${k}`);
  if('dream' in patch)invariant(typeof patch.dream==='boolean','dream is true or false');
  if('metacognition' in patch)invariant(typeof patch.metacognition==='boolean','metacognition is true or false');
  if('delegationGuard' in patch)invariant(typeof patch.delegationGuard==='boolean','delegationGuard is true or false');
  if('verifyCompletion' in patch)invariant(['auto','self','off'].includes(patch.verifyCompletion),'verifyCompletion is auto, self or off');
  if(patch.budget)next.budget={...old.budget,...patch.budget};
  if(patch.budget)for(const k of ['sessionUsd','dailyUsd'])invariant(next.budget[k]===undefined||Number.isFinite(next.budget[k])&&next.budget[k]>=0&&next.budget[k]<=100000,`Invalid budget ${k}`);
  if(patch.cacheRetention){for(const v of Object.values(patch.cacheRetention))invariant(['short','long'].includes(v),'Cache retention is short or long');next.cacheRetention={...old.cacheRetention,...patch.cacheRetention};}
  this.store.value('agent-settings',next);this.store.emit('agent.settings',this.settings());this.scheduleHeartbeat();
  // A raised budget lets paused work continue at once.
  this.nativeRuntime.dispatch({type:'settingsChanged',budgetChanged:!!patch.budget});
  return this.settings();
 }
 personas(){return normalizePersonas(this.store.value('dialogue-personas')||defaultPersonas(this.store.settings.companion));}
 /** Persona, settings or tool changes reach live sessions as appended instructions (the cached prefix survives);
  * the system prompt itself is replaced at each session's next checkpoint. */
 refreshPrompts(filter=()=>true){let n=0;for(const s of this.sessions.list())if(filter(s)&&s.system&&!['done','stopped'].includes(s.status)&&this.loop.update(s))n++;return n;}
 /** Long-lived cache for the resident session (people come back after minutes), short for busy workers. */
 cacheRetention(session){const c=this.settings().cacheRetention;return session.kind==='main'?c.main:c.worker;}
 /** Prompt-processing progress from a local server (llama.cpp return_progress), shown as the session's note. */
 loadingNote(id,p){
  const total=p?.total||0,done=(p?.processed||0)+(p?.cache||0);if(!total)return;
  const pct=Math.min(99,Math.floor(done/total*100)),b=this.streams.get(id)||{};
  if(pct-(b.loadPct??-10)<5)return;b.loadPct=pct;this.streams.set(id,b);
  this.sessions.update(id,{note:`文脈を読み込み中 ${pct}%`});
 }
 sandboxPolicy(){return this.settings().sandbox;}
 skillIndex(){return skillIndex(this.store);}
 /** Whether the model serving this session takes images (declared, or learnt from a rejection). */
 sessionSees(session){const p=this.registry.chain(session.role).find(p=>this.registry.permitted(p));return this.registry.visionAllowed(p);}
 /** Another model looks at images for a session whose own model cannot see. Null when no vision model is connected. */
 async lookAt(images,question,signal){
  if(!this.registry.hasRoute('vision'))return null;
  const answer=await this.registry.invoke('vision',[{role:'system',content:'You look at images for an assistant that cannot see them. Be precise and concrete; transcribe visible text exactly; say what you are unsure of.'},
   {role:'user',content:[{type:'text',text:question},...images.map(i=>({type:'image_url',image_url:{url:`data:${i.mime};base64,${i.base64}`}}))]}],{signal,requirement:'vision',maxTokens:2000});
  return String(answer.content||'').trim();
 }
 excludedTools(session){
  const out=[];for(const n of ['computer','media'])if(!this.tools.has(n)||this.tools.get(n).available?.()===false)out.push(n);
  if((session.depth||0)>=this.settings().maxDepth)out.push('sessions_spawn');
  return out;
 }
 toolContext(session,signal){const mem=this.loop.state(session.id);mem.files||=new Map();return {session,signal,cwd:session.cwd||this.workRoot,sandbox:this.sandboxPolicy(),runtime:this,store:this.store,files:mem.files};}
 /** The transcript entry that already shows these lines of this (unchanged) file, if it is still in view. */
 priorRead(session,key,info){
  const r=this.loop.state(session.id).reads?.get(key);if(!r||r.mtimeMs!==info.mtimeMs||r.size!==info.size)return null;
  const view=this.assembler.view(session.id);return r.seq>view.clearUpTo&&r.seq>(view.checkpoint?.upTo||0)?r.seq:null;
 }
 /* ---------- sessions ---------- */
 main(){
  const existing=this.sessions.list({kind:'main'})[0];if(existing)return existing;
  const cwd=path.join(this.workRoot);mkdirSync(cwd,{recursive:true});
  return this.sessions.create({kind:'main',title:this.personas().character.name,cwd,role:'chat',toolset:'main'});
 }
 folder(id){const dir=path.join(this.workRoot,'sessions',id.slice(0,8));mkdirSync(dir,{recursive:true});return dir;}
 async spawn(parent,{task,title,context='isolated',persistent=false,cwd,toolset,role='work',from,signal}={}){
  invariant(typeof task==='string'&&task.trim(),'task is required');
  // Small context windows cannot afford the full tool set: pick the lean one unless asked otherwise.
  // A guessed window (Ollama before the model is loaded) is not evidence: the step-time check downgrades if needed.
  if(!toolset){try{const p=this.registry.chain(role==='escalation'?'escalation':'work')[0],l=p&&await this.registry.limits(p);toolset=l&&l.source!=='guess'&&l.context<16000?'lean':'worker';}catch{toolset='worker';}}
  signal?.throwIfAborted();
  const depth=(parent?.depth||0)+(parent&&parent.kind!=='main'?1:0);
  invariant(!parent||parent.kind==='main'||depth<=this.settings().maxDepth,`Work agents can be nested at most ${this.settings().maxDepth} deep.`,409);
  const id=randomUUID();
  const s=this.sessions.create({id,kind:persistent?'specialist':'worker',title:title||oneLine(task,48),parentId:parent?.id||null,rootId:parent?.rootId||parent?.id||null,depth,
   cwd:cwd?path.resolve(parent?.cwd||this.workRoot,cwd):this.folder(id),toolset:toolset==='lean'?'lean':'worker',role:role==='escalation'&&this.registry.hasRoute('escalation')?'escalation':'work',task,label:persistent?(title||null):null});
  let text=task;
  if(context==='fork'&&parent){
   const cp=this.sessions.latest(parent.id,'checkpoint'),recent=this.sessions.tail(parent.id,30).filter(e=>['input','assistant'].includes(e.type));
   text+=`\n\n--- Context from your requester (quoted, for reference) ---\n${cp?.summary?fitTokens(cp.summary,2500,'#'+cp.seq).text+'\n':''}${fitTokens(transcriptText(recent),2500,'recent').text}`;
  }
  signal?.throwIfAborted();
  this.send(s.id,{text,from:from||(parent?'parent':'user'),kind:'task',source:parent?`task from "${parent.title||parent.kind}"`:'task'});
  return this.sessions.get(s.id);
 }
 /** Queue input for a session. followup/steer wake it; notify is context only. */
 send(id,{text,from='user',kind='message',mode='followup',source='',images,meta={}}){
  const s=this.sessions.get(id);invariant(s,'Session not found',404);invariant(typeof text==='string'&&text.trim(),'message is required');
  const after=this.sessions.seq(id)-1;
  this.sessions.enqueue(id,{text,from,kind,mode,images,header:stampHeader(new Date(this.clock()),source||(from==='user'?'user':from)),...meta});
  if(mode==='notify'&&!this.runs.has(id)&&['idle','done','stopped'].includes(s.status))this.deliver(id);
  else if(mode!=='notify'){
   if(s.status==='stopped'&&!['user','parent'].includes(from)&&from!=='system')return {queued:true,after};
   if(['done','stopped'].includes(s.status)){this.sessions.update(id,{status:'idle',result:s.status==='done'?s.result:null});this.loop.update(this.sessions.get(id));}
   this.wake(id,{from});
  }
  return {queued:true,after};
 }
 deliver(id){
  const items=this.sessions.take(id);
  for(const {id:_,at,mode,...rest} of items){
   const {seq}=this.sessions.append(id,'input',{...rest,passive:mode==='notify'});
   if(mode!=='notify'&&(rest.from==='user'||rest.from?.startsWith?.('voice'))&&rest.kind==='message')this.route(id,rest.text,seq);
  }
  return items.filter(i=>i.mode!=='notify').length;
 }
 /** Delegation safety net. While the character thinks about a user message, the decision model judges in parallel
  * whether it asks for real work (files, code, research, operating apps). If it surely does and the character then
  * answers without any tool — small models often say "I can't create files" instead of delegating — that reply is
  * withheld and the harness starts the work agent itself; the character is told and answers again. The character's
  * text is held off the screen until the verdict is in, so a withheld reply is never shown or spoken. */
 route(id,text,seq){
  const s=this.sessions.get(id);
  if(s?.kind!=='main'||this.settings().delegationGuard===false||!this.decisions.available()||!String(text||'').trim())return;
  const owner=this.runs.get(id),mem=this.loop.state(id),q=this.dreamer.question('route'),state=JSON.stringify({message:fitTokens(text,1500,'message').text}),r={seq,text,p:null,raw:null,held:true,q,state,version:(mem.routeVersion||0)+1};mem.routeVersion=r.version;mem.route=r;
  r.promise=this.decisions.yes(state,q.text)
   .catch(()=>null).then(raw=>{if(this.closed||owner?.controller.signal.aborted||this.runs.get(id)!==owner||mem.routeVersion!==r.version)return null;r.raw=raw;const p=Dreamer.oriented(q,raw);r.p=p;if(!(p>=q.threshold)){r.held=false;this.flush(id);}return p;});
 }
 /** After a character turn: true when the harness delegated the request itself (the reply was withheld). */
 async delegated(id,text,signal){
  const mem=this.loop.state(id),r=mem.route;if(!r)return false;
  mem.route=null;const p=await r.promise;
  signal?.throwIfAborted();if(this.closed||p===null)return false;
  // The turn is an episode for dreaming (core/agent/dream.mjs): the character delegating by itself says the message
  // needed work; answering (with or without a quick lookup) says it did not; a harness delegation is judged later by
  // what the worker actually did.
  const tools=this.sessions.entries(id,{from:r.seq,types:['tool']}),act=p>=r.q.threshold&&!isSilentReply(text)&&!tools.length;
  const ep=this.dreamer.record(id,'route',{question:r.q.id,p:r.raw,threshold:r.q.threshold,action:act?1:0,state:r.state});
  if(!act){this.dreamer.label(id,ep,tools.some(t=>t.name==='sessions_spawn'&&!t.error)?1:0,tools.some(t=>t.name==='sessions_spawn')?'character':'answered');return false;}
  const reply=this.sessions.latest(id,'assistant');if(reply&&reply.seq>r.seq)this.sessions.patch(id,reply.seq,{withdrawn:true});
  const w=await this.spawn(this.sessions.get(id),{task:r.text,context:'fork',signal});
  signal?.throwIfAborted();
  this.sessions.update(w.id,{origin:{sessionId:id,episode:ep}});
  this.event(id,'auto-delegated',{probability:p,sessionId:w.id});
  this.sessions.append(id,'notice',{text:NOTICE.autoDelegated(w.title,w.id)});
  return true;
 }
 /** Whether the transcript ends in the middle of a turn (the model has not answered the latest input). */
 needsStep(id){return this.nativeRuntime.query('needsStep',{tail:this.sessions.tail(id,12)});}
 wake(id,{from}={}){this.nativeRuntime.dispatch({type:'wake',sessionId:id,from});}
 wakeDeferred(){this.nativeRuntime.dispatch({type:'wakeDeferred'});}
 async run(id){this.wake(id);await this.runs.get(id)?.promise;}
 probeClaimedFiles(session,report){return missingFiles(session,report,this.sessions.entries(session.id,{types:['input']}),this.sessions.entries(session.id,{types:['tool']}));}
 /** Once per task, before a substantial piece of work is reported as finished: is every part of it actually done?
  * The decision model judges the report against the task (one cheap call); without one, the work agent re-checks
  * its own result (one more turn, read from cache). Returns true when the agent was sent back to work. */
 async completionCheck(s,report,signal){
  const native=this.nativeRuntime,plan=native.query('completionPlan',{session:s,settings:this.settings(),decisionAvailable:this.decisions.available(),verified:!!native.state(s.id)?.verified});
  if(!plan.eligible)return false;
  native.dispatch({type:'markVerified',sessionId:s.id});
  const {brief,q,state}=this.completionContext(s,report);
  if(plan.decision){
   const raw=await this.decisions.yes(state,q.text,signal);signal?.throwIfAborted();
   const {probability:p,accepted}=native.query('completionVerdict',{raw,q});
   this.event(s.id,'completion-check',{method:'decision',probability:p,question:q.id});
   if(p===null)return false;
   this.dreamer.record(s.id,'completion',{question:q.id,p:raw,threshold:q.threshold,action:accepted?1:0,state});
   if(accepted)return false;
   this.sessions.append(s.id,'notice',{text:NOTICE.verify(brief,'the report does not clearly show that every part is done')});return true;
  }
  if(plan.method!=='self')return false;
  this.event(s.id,'completion-check',{method:'self'});
  this.sessions.append(s.id,'notice',{text:NOTICE.verify(brief,null)});return true;
 }
 completionContext(s,report){
  const task=this.sessions.entries(s.id,{types:['input']}).filter(e=>e.kind==='task'||e.from==='user'||e.from==='parent');
  const brief=fitTokens(task.map(e=>e.text).join('\n\n'),2500,'task').text;
  const actions=this.sessions.entries(s.id,{types:['tool']}).slice(-30).map(e=>`${e.error?'FAILED':'ok'}: ${oneLine(e.stub||e.name,220)}`).join('\n');
  const q=this.dreamer.question('completion'),r=s.reflection;
  const state=JSON.stringify({task:brief,checklist:s.todo?.length?renderTodo(s.todo):'(none)',actions:fitTokens(actions||'(none)',2500,'actions').text,
   ...(r?{agent_notes:{unverified_assumptions:r.assumptions||[],confidence:r.confidence??null}}:{}),report:fitTokens(report||'',2000,'report').text});
  return {brief,q,state};
 }
 later(id,ms){this.nativeRuntime.dispatch({type:'later',sessionId:id,ms});}
 reply(id,text){
  const silent=isSilentReply(text);
  this.store.emit('agent.reply',{sessionId:id,text:silent?'':text,silent,at:new Date(this.clock()).toISOString()});
 }
 finish(id,text,{status,atMs}={}){
  const s=this.sessions.get(id);this.computer?.release(id);
  this.sessions.update(id,{status:status||(s.kind==='specialist'?'idle':'done'),result:text||'',note:'',finishedAt:new Date(atMs??this.clock()).toISOString()});
  this.store.emit('agent.finished',{sessionId:id,title:s.title,result:text});
  if(s.kind!=='main'){
   this.dreamer.labelSession(id);
   const o=s.origin,st=this.sessions.get(id).stats||{};if(o?.sessionId&&this.sessions.get(o.sessionId))this.dreamer.label(o.sessionId,o.episode,(st.toolCalls||0)-(st.toolErrors||0)>0?1:0,'delegated-outcome');
  }
  if(s.parentId&&this.sessions.get(s.parentId)){
   const body=fitTokens(text||'(no report)',3000,`${id}#report`).text;
   this.send(s.parentId,{text:body,from:'child:'+id,kind:'report',mode:'followup',source:`report from "${s.title}" (${id}) · finished`,meta:{sessionId:id,title:s.title,status:'done'}});
  }
 }
 progress(id){
  const s=this.sessions.get(id),last=this.sessions.tail(id,40).filter(e=>e.type==='assistant'&&e.content).at(-1);
  const todo=s.todo?.length?s.todo.map(t=>`${t.status==='done'?'✓':'·'} ${t.text}`).join('\n'):'';
  this.send(s.parentId,{text:`${s.stats?.steps||0} steps.${todo?'\n'+todo:''}${last?'\nLatest: '+oneLine(last.content,300):''}`,from:'child:'+id,kind:'report',mode:'notify',source:`progress of "${s.title}" (${id})`,meta:{sessionId:id,title:s.title,status:'running'}});
 }
 stop(id,reason='stopped'){
  invariant(this.sessions.get(id),'Session not found',404);
  this.nativeRuntime.dispatch({type:'stop',sessionId:id,reason});return this.sessions.get(id);
 }
 resume(id,{mode='continue'}={}){
  invariant(this.sessions.get(id),'Session not found',404);
  this.nativeRuntime.dispatch({type:'resume',sessionId:id,mode});return this.sessions.get(id);
 }
 /** After a stretch of healthy steps on the stronger model, go back to the usual one (it is cheaper and faster). */
 deescalate(id){
  const s=this.sessions.get(id);if(s?.role!=='escalation'||!s.baseRole)return;
  this.sessions.update(id,{role:s.baseRole,baseRole:null});this.sessions.append(id,'notice',{text:NOTICE.deescalated()});this.event(id,'deescalated',{});
 }
 aborted(id){return !!this.runs.get(id)?.controller.signal.aborted;}
 escalate(id,reason){
  const s=this.sessions.get(id);
  if(s.role!=='escalation'&&this.registry.hasRoute('escalation')){
   const p=this.registry.chain('escalation')[0];this.sessions.update(id,{role:'escalation',baseRole:s.role});this.loop.state(id).healthy=0;this.sessions.append(id,'notice',{text:NOTICE.escalated(p?.model||'escalation')});this.event(id,'escalated',{reason});return;
  }
  if(s.parentId&&!this.loop.state(id).warned.has('parent:'+reason)){this.loop.state(id).warned.add('parent:'+reason);this.send(s.parentId,{text:`Work agent "${s.title}" seems stuck (${reason}). It keeps trying; you may want to give it guidance with sessions_send or stop it.`,from:'child:'+id,kind:'report',mode:'notify',source:`status of "${s.title}" (${id})`,meta:{sessionId:id,title:s.title,status:'stuck'}});}
 }
 /* ---------- visibility ---------- */
 tree(id){const out=[id];for(let i=0;i<out.length;i++)for(const c of this.sessions.list({parentId:out[i]}))out.push(c.id);return out;}
 visible(from,id){if(from.kind==='main'||from.id===id||from.parentId===id)return true;return this.tree(from.id).includes(id);}
 visibleSessions(from){return this.sessions.list().filter(s=>s.id!==from.id&&this.visible(from,s.id));}
 resolveSession(from,ref){
  const key=String(ref||'').trim();
  if(key==='parent'){invariant(from.parentId,'This session has no requester.',404);return this.sessions.get(from.parentId);}
  if(key==='main'){const m=this.main();invariant(this.visible(from,m.id)||from.kind!=='main','',403);return m;}
  const all=this.visibleSessions(from),hit=all.find(s=>s.id===key||s.id.startsWith(key)&&key.length>=6)||all.find(s=>s.label===key)||all.find(s=>s.title===key);
  invariant(hit,`No visible session "${key}". Use sessions_list.`,404);return hit;
 }
 /** Waits for a message from `fromId` to arrive in `toId`'s inbox (an answer sent with sessions_send, or the
  * final report of a child). The answer is taken out of the inbox, so it is not delivered a second time. */
 waitForMessage(fromId,toId,ms,signal){
  return new Promise(resolve=>{
   const done=v=>{clearTimeout(t);this.waiters.delete(check);signal?.removeEventListener('abort',stop);resolve(v);};
   const check=d=>{const i=d.item;if(d.sessionId===toId&&(i.from===fromId||i.from==='child:'+fromId)&&this.sessions.takeItem(toId,i.id))done(i.text);};
   const stop=()=>done(null);const t=setTimeout(()=>done(null),ms);this.waiters.add(check);signal?.addEventListener('abort',stop,{once:true});
  });
 }
 /* ---------- accounting and live output ---------- */
 /** Legacy budgets count successful normal turns only, separately from all dispatches. */
 account(id,answer,ms,reportedUsage=answer.usage){
  const s=this.sessions.get(id),u=answer.usage||{},st=s.stats||{},price=this.registry.price?.(answer.route);
  const estimate=estimateModelUsage({usage:reportedUsage,usageStatus:answer.usageStatus},price),cost=estimate.cost??0,unknown=estimate.cost===null?1:0;
  const unknownCostCalls=(st.unknownCostCalls||0)+unknown;
  this.sessions.update(id,{stats:{...st,steps:(st.steps||0)+1,input:(st.input||0)+(u.input||0),output:(st.output||0)+(u.output||0),cacheRead:(st.cacheRead||0)+(u.cacheRead||0),cacheWrite:(st.cacheWrite||0)+(u.cacheWrite||0),
   cost:(st.cost||0)+cost,unknownCostCalls,costStatus:unknownCostCalls?'incomplete':'estimated',modelMs:(st.modelMs||0)+ms,lastInput:u.input||0}});
  const day='agent-usage:'+new Date(this.clock()).toISOString().slice(0,10),d=this.store.value(day)||{input:0,output:0,cacheRead:0,cost:0,calls:0};
  const dailyUnknown=(d.unknownCostCalls||0)+unknown;
  this.store.value(day,{input:d.input+(u.input||0),output:d.output+(u.output||0),cacheRead:d.cacheRead+(u.cacheRead||0),cost:d.cost+cost,calls:d.calls+1,unknownCostCalls:dailyUnknown,costStatus:dailyUnknown?'incomplete':'estimated'});
 }
 usage(days=7){const out={};for(let i=0;i<days;i++){const d=new Date(this.clock()-i*86400000).toISOString().slice(0,10);out[d]=this.store.value('agent-usage:'+d)||null;}const today=new Date(this.clock()).toISOString().slice(0,10);return {today:out[today],days:out,modelCalls:modelUsageSnapshot(this.store,Object.keys(out),today)};}
 /** A spending limit the user set (none by default). Reaching it pauses the session, which the user can lift. */
 overBudget(session){const f=this.nativeRuntime.facts();return this.nativeRuntime.query('overBudget',{session,settings:f.settings,dailyCost:f.dailyCost});}
 /** Live text for the screen. The character's text is held back while it could still be NO_REPLY,
  * so a silent turn never flashes on screen or reaches the voice. */
 stream(id,kind,text){
  let b=this.streams.get(id);if(!b||b.text===undefined){b={...b,text:'',reasoning:'',timer:null,main:this.sessions.get(id)?.kind==='main'};this.streams.set(id,b);}
  b[kind]+=text;if(!b.timer)b.timer=setTimeout(()=>{b.timer=null;this.flush(id);},60);
 }
 held(id,b){return b.main&&(mayBeSilent(b.text)||!!this.loop.state(id).route?.held);}
 flush(id){const b=this.streams.get(id);if(b&&b.text!==undefined)this.store.broadcast('agent.delta',{sessionId:id,text:this.held(id,b)?'':b.text,reasoning:b.reasoning});}
 streamEnd(id,{discard=false}={}){const b=this.streams.get(id);if(b){clearTimeout(b.timer);this.streams.delete(id);this.store.broadcast('agent.delta',{sessionId:id,text:discard||b.main&&(isSilentReply(b.text)||this.loop.state(id).route?.held)?'':b.text||'',reasoning:discard?'':b.reasoning||'',done:true});}}
 event(id,type,data={}){this.sessions.append(id,'event',{event:type,...data});this.store.emit('agent.event',{sessionId:id,type,...data});if(this.tools.hooks.length)this.tools.hook('event',{type,sessionId:id,...data});}
 /* ---------- lifecycle ---------- */
 start(){
  const main=this.main();
  for(const s of this.sessions.list()){
   // A tool that was running when the service stopped has an unknown outcome: say so, then continue.
   const tail=this.sessions.tail(s.id,40),lastAssistant=tail.findLast(e=>e.type==='assistant');
   if(lastAssistant?.toolCalls?.length){const done=new Set(tail.filter(e=>e.type==='tool'&&e.seq>lastAssistant.seq).map(e=>e.callId));
    for(const c of lastAssistant.toolCalls)if(!done.has(c.id))this.sessions.append(s.id,'tool',{callId:c.id,name:c.name,content:NOTICE.restarted(),stub:`${c.name} interrupted by a restart`,error:true,errorText:'interrupted by restart',keep:true,chars:0});}
  }
  this.nativeRuntime.dispatch({type:'initialize'});
  this.scheduleHeartbeat();this.scheduler.start();
  this.idleTimer=setInterval(()=>this.idleCompact(main.id).catch(()=>{}),15000);this.idleTimer.unref?.();
  this.dreamTimer=setInterval(()=>this.dreamer.maybe().catch(e=>this.store.emit('agent.event',{type:'dream-failed',message:String(e?.message||e).slice(0,200)})),3600000);this.dreamTimer.unref?.();
 }
 /** What a check-in should look at. `key` covers only what changes meaningfully (who is working, waiting,
  * finished, or asking), not step counters, so an unchanged state never wakes the model. */
 heartbeatState(){
  const work=this.sessions.list().filter(s=>s.kind!=='main'&&(['running','waiting'].includes(s.status)||s.status==='done'&&!s.accepted));
  const approvals=this.store.list('approval').filter(a=>a.status==='pending');
  const lines=work.map(s=>`- "${s.title}" (${s.id.slice(0,8)}) ${s.status}${s.note?': '+oneLine(s.note,80):''} · ${s.stats?.steps||0} steps`);
  if(approvals.length)lines.push(`- ${approvals.length} approval request${approvals.length>1?'s':''} waiting for the user`);
  const key=createHash('sha256').update(JSON.stringify([work.map(s=>[s.id,s.status,s.status==='waiting'?s.note:'']),approvals.map(a=>a.id)])).digest('hex');
  return {text:lines.join('\n'),key,empty:!lines.length};
 }
 scheduleHeartbeat(){
  clearInterval(this.heartbeatTimer);const h=this.settings().heartbeat;
  if(!h.enabled||!(h.minutes>0)||this.closed)return;
  this.heartbeatTimer=setInterval(()=>this.heartbeat().catch(e=>this.store.emit('agent.event',{type:'heartbeat-failed',message:String(e?.message||e).slice(0,200)})),h.minutes*60000);
  this.heartbeatTimer.unref?.();
 }
 async heartbeat(){
  const h=this.settings().heartbeat,m=this.main();if(this.closed||this.runs.has(m.id)||this.sessions.pending(m.id).length)return false;
  const state=this.heartbeatState();
  // Nothing changed since the last check-in, or nothing at all is going on: no model call. Timed duties use schedule.
  if(state.key===this.lastHeartbeat||state.empty&&!h.text){this.lastHeartbeat=state.key;return false;}
  this.lastHeartbeat=state.key;
  // A change that plainly needs nobody (a step counter moved, work is just running) is filtered by the decision model.
  if(this.decisions.available()&&!h.text){
   const p=await this.decisions.yes(state.text,'Is there anything here the user should hear about now, or that the assistant must act on (a finished result to pass on, a question, a failure, an approval)? Plain progress needs nothing.');
   if(p!==null&&p<0.25)return false;
  }
  this.send(m.id,{text:`${h.text||'Check-in. Look at the work below and tell the user anything they should hear about now. Reply NO_REPLY if nothing needs attention.'}\n\nCurrent work:\n${state.text||'(nothing running)'}`,from:'timer',kind:'heartbeat',source:'check-in'});
  return true;
 }
 /** The resident session compacts while nobody is talking, so the next spoken reply is fast. */
 async idleCompact(id){
  this.nativeRuntime.dispatch({type:'auxiliary',sessionId:id,kind:'idleCompaction',lastAtMs:Date.parse(this.sessions.tail(id,1)[0]?.at)||0});
  const run=this.runs.get(id);if(run?.leaseKind==='idleCompaction')await run.promise;
 }
 async close(){
  this.nativeRuntime.dispatch({type:'close'});
  await this.nativeRuntime.drain();
  await Promise.allSettled([...this.runs.values()].map(r=>r.promise));
 }

}
