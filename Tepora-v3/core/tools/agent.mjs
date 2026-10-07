import path from 'node:path';
import {invariant} from '../policy.mjs';
import {oneLine} from './format.mjs';
import {readSharedSkill} from '../shared-assets.mjs';

const STATUS=['pending','in_progress','done','blocked'];
const mark={pending:'[ ]',in_progress:'[>]',done:'[x]',blocked:'[!]'};
export const renderTodo=items=>items.length?items.map((t,i)=>`${mark[t.status]||'[ ]'} ${i+1}. ${t.text}`).join('\n'):'(empty)';
function entryText(e){
 if(!e)return '';
 if(e.type==='input'||e.type==='notice')return e.text||'';
 if(e.type==='assistant')return [e.content||'',...(e.toolCalls||[]).map(c=>`→ ${c.name}(${c.arguments})`)].filter(Boolean).join('\n');
 if(e.type==='tool')return e.content||'';
 if(e.type==='checkpoint')return e.summary||'';
 return JSON.stringify(e);
}
/** Enabled skills, as listed to the model: name and description only. The full instructions load on demand
 * (progressive disclosure, as in the Agent Skills format), so the list costs little and never changes mid-session. */
export function skillIndex(store){
 return store.list('skill').filter(s=>s.enabled===true).map(s=>({name:s.name,description:oneLine(s.description||'',300)})).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,60);
}
/** Tools that act on the agent system itself: plans, memory of the transcript, artifacts, other sessions. */
export function agentTools(runtime){
 const {sessions,store}=runtime;
 return [{
  name:'skill',group:'core',readOnly:true,
  description:'Load the full instructions of a skill listed in your system prompt (by name). Follow them for the task at hand. A skill folder may hold scripts and references; its path is given.',
  parameters:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string'}}},
  summarize:a=>`skill ${a.name}`,
  async run(a){
   const all=store.list('skill').filter(s=>s.enabled===true),key=String(a.name||'').trim().toLowerCase();
   const s=all.find(x=>x.name.toLowerCase()===key)||all.find(x=>x.id===a.name)||all.find(x=>x.name.toLowerCase().includes(key));
   invariant(s,`No enabled skill "${a.name}". Available: ${all.map(x=>x.name).join(', ')||'none'}.`,404);
   const full=s.source==='shared'?await readSharedSkill(s):s;
   return {text:`# Skill: ${s.name}${s.sourcePath?`\nFolder: ${path.dirname(s.sourcePath)} (relative paths in the skill resolve here)`:''}\n\n${full.content||''}`,data:{name:s.name}};
  }
 },{
  name:'todo',group:'core',ephemeral:true,
  description:'Keep a short checklist for multi-step work. Send the whole list each time (it replaces the previous one). Status: pending, in_progress, done, blocked. Keep exactly one item in_progress while working.',
  parameters:{type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',maxItems:50,items:{type:'object',additionalProperties:false,required:['text','status'],properties:{text:{type:'string'},status:{type:'string',enum:STATUS}}}}}},
  ephemeralKey:()=>'todo',
  async run(a,ctx){
   const items=a.items.map(t=>({text:oneLine(t.text,300),status:t.status}));
   sessions.update(ctx.session.id,{todo:items});
   const open=items.filter(t=>t.status!=='done').length;
   return {text:`Todo (${items.length-open}/${items.length} done)\n${renderTodo(items)}`,data:{items}};
  }
 },{
  name:'recall',group:'core',readOnly:true,
  description:'Read an earlier transcript entry exactly, by its reference: "#123" (this session) or "<session id>#123". Use it for details that were shortened or compacted away. offset/limit page through long entries.',
  parameters:{type:'object',additionalProperties:false,required:['ref'],properties:{ref:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:100,maximum:60000}}},
  summarize:a=>`recall ${a.ref}`,
  async run(a,ctx){
   const m=/^(?:([\w-]+))?#(\d+)$/.exec(String(a.ref).trim());invariant(m,'ref must look like "#123" or "<session id>#123"');
   const sid=m[1]||ctx.session.id;invariant(runtime.visible(ctx.session,sid),'That session is not visible from here.',403);
   const e=sessions.entry(sid,Number(m[2]));invariant(e,`No entry ${a.ref}`,404);
   const full=e.type==='tool'&&e.evidenceId?sessions.evidence(e.evidenceId)?.content??e.content:entryText(e);
   const from=a.offset||0,size=a.limit||20000,part=full.slice(from,from+size);
   return {text:`${a.ref} (${e.type}${e.name?' '+e.name:''}, ${e.at}) characters ${from}–${from+part.length} of ${full.length}\n${part}${from+part.length<full.length?`\n[continues: recall("${a.ref}", offset=${from+part.length})]`:''}`};
  }
 },{
  name:'history_search',group:'core',readOnly:true,
  description:'Full-text search over this session\'s whole transcript, including parts compacted out of view. Returns references to read with recall.',
  parameters:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:30},scope:{type:'string',enum:['session','tree']}}},
  summarize:a=>`history_search ${JSON.stringify(a.query)}`,
  async run(a,ctx){
   const ids=a.scope==='tree'?runtime.tree(ctx.session.id):[ctx.session.id];
   const hits=sessions.search(a.query,{sessionIds:ids,limit:a.limit||10});
   return {text:hits.length?hits.map(h=>`${h.sessionId===ctx.session.id?'':h.sessionId}#${h.seq} ${h.type}${h.name?' '+h.name:''} (${h.at.slice(0,16)}): ${oneLine(h.stub||entryText(h),200)}`).join('\n'):'No matches.'};
  }
 },{
  name:'memory_search',group:'core',readOnly:true,
  description:'Search long-term memory: facts about the user, their preferences, projects and past decisions saved across conversations.',
  parameters:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:20}}},
  summarize:a=>`memory_search ${JSON.stringify(a.query)}`,
  async run(a,ctx){
   const hits=await runtime.memory.search(a.query,{limit:a.limit||8,signal:ctx?.signal});
   return {text:hits.length?hits.map(m=>`- (${m.id.slice(0,8)}${m.title?' '+m.title:''}) ${m.content}`).join('\n'):'No memories found.'};
  }
 },{
  name:'memory_write',group:'core',
  description:'Save a durable fact to long-term memory (preferences, standing instructions, important facts about the user or their work). One fact per call; write it so it makes sense on its own later.',
  parameters:{type:'object',additionalProperties:false,required:['content'],properties:{content:{type:'string'},title:{type:'string'}}},
  summarize:a=>`memory_write ${JSON.stringify(oneLine(a.content,60))}`,
  async run(a,ctx){const m=runtime.memory.write(a.content,{title:a.title||'',source:'session:'+ctx.session.id});return {text:`Saved memory ${m.id.slice(0,8)}.`};}
 },{
  name:'artifact',group:'core',
  description:'Publish a document the user sees in Tepora\'s work view (HTML, Markdown or text), revise it, or read it. publish with an id creates a new version; edit replaces an exact piece of text (expected version required); read returns the current text.',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['publish','edit','read','list']},id:{type:'string'},title:{type:'string'},kind:{type:'string',enum:['html','markdown','text']},content:{type:'string'},old_string:{type:'string'},new_string:{type:'string'},expected_version:{type:'integer',minimum:0}}},
  summarize:a=>`artifact ${a.action}${a.id?' '+a.id:''}${a.title?' '+JSON.stringify(a.title):''}`,
  async run(a,ctx){
   const sid=ctx.session.id;
   if(a.action==='list'){const items=store.list('artifact').filter(x=>x.sessionId===sid||x.jobId===sid);return {text:items.length?items.map(x=>`${x.id} v${x.version} ${x.kind} "${x.title}" (${x.content.length} chars)`).join('\n'):'No artifacts yet.'};}
   if(a.action==='read'){const x=store.get('artifact',String(a.id||''));invariant(x,'Artifact not found',404);return {text:`${x.id} v${x.version} ${x.kind} "${x.title}"\n${x.content}`};}
   if(a.action==='publish'){
    invariant(typeof a.title==='string'&&typeof a.content==='string','publish needs title and content');
    const existing=a.id?store.get('artifact',a.id):null;
    const doc=store.artifact(a.title,a.content,{...(a.id?{id:a.id}:{}),kind:a.kind||existing?.kind||'markdown',jobId:sid,sessionId:sid,expectedVersion:existing?existing.version:undefined});
    return {text:`Published artifact ${doc.id} v${doc.version} (${doc.kind}, ${doc.content.length} characters).`,data:{id:doc.id,version:doc.version,title:doc.title}};
   }
   const x=store.get('artifact',String(a.id||''));invariant(x,'Artifact not found',404);
   invariant(a.expected_version===undefined||a.expected_version===x.version,`The artifact is now version ${x.version}; read it again before editing.`,409);
   invariant(typeof a.old_string==='string'&&a.old_string&&typeof a.new_string==='string','edit needs old_string and new_string');
   const count=x.content.split(a.old_string).length-1;invariant(count===1,count?`old_string occurs ${count} times; include more context.`:'old_string was not found; read the artifact again.',409);
   const doc=store.artifact(a.title||x.title,x.content.replace(a.old_string,()=>a.new_string),{id:x.id,kind:x.kind,jobId:x.jobId||sid,sessionId:x.sessionId||sid,expectedVersion:x.version});
   return {text:`Edited artifact ${doc.id}: now v${doc.version}.`,data:{id:doc.id,version:doc.version,title:doc.title}};
  }
 },{
  name:'sessions_spawn',group:'core',
  description:'Start a work agent on a task in the background and return immediately. It works on its own and its final report arrives to you as a message. Give a complete, self-contained task (goal, context, constraints, what to deliver). persistent:true keeps it as a named specialist you can send more tasks to later.',
  parameters:{type:'object',additionalProperties:false,required:['task'],properties:{task:{type:'string'},title:{type:'string',description:'Short name shown to the user.'},
   context:{type:'string',enum:['isolated','fork'],description:'fork copies a summary of your current context into the agent.'},persistent:{type:'boolean'},cwd:{type:'string',description:'Folder to work in.'},
   toolset:{type:'string',enum:['worker','lean']},role:{type:'string',enum:['work','escalation'],description:'escalation uses the stronger configured model.'}}},
  summarize:a=>`sessions_spawn ${JSON.stringify(a.title||oneLine(a.task,50))}`,
  async run(a,ctx){
   const child=await runtime.spawn(ctx.session,{task:a.task,title:a.title,context:a.context,persistent:a.persistent,cwd:a.cwd,toolset:a.toolset,role:a.role});
   return {text:`Started ${child.kind} "${child.title}" (${child.id}). Its report will arrive as a message; you do not need to wait.`,data:{sessionId:child.id,title:child.title}};
  }
 },{
  name:'sessions_send',group:'core',
  description:'Send a message to another session: your requester ("parent"), a work agent you started, or a specialist. mode followup starts a new turn (default), steer is delivered at its next step while it works, notify only adds information. wait > 0 waits that many seconds for a message back from that session (its answer via sessions_send, or its final report). To answer a session that asked you something, send your answer to it with sessions_send.',
  parameters:{type:'object',additionalProperties:false,required:['session','message'],properties:{session:{type:'string',description:'Session id, label, or "parent".'},message:{type:'string'},mode:{type:'string',enum:['followup','steer','notify']},wait:{type:'integer',minimum:0,maximum:600}}},
  summarize:a=>`sessions_send ${a.session} ${JSON.stringify(oneLine(a.message,50))}`,
  async run(a,ctx){
   const target=runtime.resolveSession(ctx.session,a.session);
   const waiting=a.wait?runtime.waitForMessage(target.id,ctx.session.id,a.wait*1000,ctx.signal):null;
   runtime.send(target.id,{text:a.message,from:ctx.session.id,mode:a.mode||'followup',source:`message from "${ctx.session.title||ctx.session.kind}" (${ctx.session.id})${a.wait?' — it is waiting for your answer via sessions_send':''}`});
   if(!waiting)return {text:`Delivered to "${target.title||target.kind}" (${target.id}) as ${a.mode||'followup'}.`};
   const reply=await waiting;
   return {text:reply?`Reply from "${target.title||target.kind}":\n${reply}`:`No reply within ${a.wait} s; it will arrive as a message later.`};
  }
 },{
  name:'sessions_list',group:'core',readOnly:true,
  description:'List sessions you can see (your work agents, specialists, your requester) with their status.',
  parameters:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['idle','running','waiting','done','stopped']},limit:{type:'integer',minimum:1,maximum:100}}},
  ephemeralKey:()=>'sessions_list',
  async run(a,ctx){
   const list=runtime.visibleSessions(ctx.session).filter(s=>!a.status||s.status===a.status).slice(0,a.limit||30);
   return {text:list.length?list.map(s=>`${s.id} ${s.kind} [${s.status}] "${s.title}"${s.label?' @'+s.label:''} · ${s.stats?.steps||0} steps${s.note?' · '+oneLine(s.note,80):''}`).join('\n'):'No other sessions.'};
  }
 },{
  name:'sessions_history',group:'core',readOnly:true,
  description:'Read the recent conversation of another session you can see (tool results are left out unless include_tools).',
  parameters:{type:'object',additionalProperties:false,required:['session'],properties:{session:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},include_tools:{type:'boolean'}}},
  summarize:a=>`sessions_history ${a.session}`,
  async run(a,ctx){
   const target=runtime.resolveSession(ctx.session,a.session);
   const items=sessions.tail(target.id,(a.limit||20)*3).filter(e=>['input','assistant','notice'].includes(e.type)||a.include_tools&&e.type==='tool').slice(-(a.limit||20));
   return {text:`"${target.title||target.kind}" (${target.id}) [${target.status}]\n`+items.map(e=>`#${e.seq} ${e.type==='input'?'in':e.type}: ${oneLine(e.type==='tool'?e.stub:entryText(e),600)}`).join('\n')};
  }
 },{
  name:'sessions_stop',group:'core',
  description:'Stop a work agent you started (it keeps its transcript and can be resumed with a followup message).',
  parameters:{type:'object',additionalProperties:false,required:['session'],properties:{session:{type:'string'},reason:{type:'string'}}},
  summarize:a=>`sessions_stop ${a.session}`,
  async run(a,ctx){const target=runtime.resolveSession(ctx.session,a.session);invariant(target.kind!=='main','The main session cannot be stopped from a tool.',403);runtime.stop(target.id,a.reason||'stopped by '+ctx.session.id);return {text:`Stopped ${target.id}.`};}
 },{
  name:'tools_search',group:'core',readOnly:true,
  description:'Find additional tools (plugins, MCP servers, rarely used built-ins) by describing what you need. Returns names and parameter schemas to use with tools_call.',
  parameters:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string'}}},
  summarize:a=>`tools_search ${JSON.stringify(a.query)}`,
  async run(a,ctx){
   const hits=runtime.tools.search(a.query,{exclude:ctx.session.tools||[]});
   return {text:hits.length?hits.map(h=>`## ${h.name} (${h.source})\n${h.description}\nparameters: ${JSON.stringify(h.parameters)}`).join('\n\n'):'No matching tools.'};
  }
 },{
  name:'tools_call',group:'core',
  description:'Call a tool found with tools_search, by its exact name, with arguments matching its schema.',
  parameters:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string'},arguments:{type:'object'}}},
  summarize:a=>`tools_call ${a.name}`,
  async run(){throw new Error('tools_call is executed by the agent loop');}
 }];
}
