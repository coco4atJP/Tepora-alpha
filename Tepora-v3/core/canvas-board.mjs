import {canvasApplyOps,canvasNormalizeOp,canvasDescribeOps} from '../web/canvas-engine.mjs';
import {CanvasParser} from './canvas-dom.mjs';
import {invariant} from './policy.mjs';

/** The shared canvas: one artifact that the character, work agents and the user all see and change.
 * It is an agent capability at the same level as computer use: a tool (`canvas`) writes it, the board keeps an
 * append-only version log (who made each version), live progress is broadcast for the UI, and what the user does
 * on it directly (select, remove, undo) is handed back to the agents as context.
 */
export const CANVAS_LIMITS=Object.freeze({html:200000,versions:30,ops:400,output:16000});
const BOARD='main';
const DEFAULT_CONFIG={enabled:true};
const PERSIST_BYTES=2_000_000;
const SNIPPET=280;
const oneLine=(s,n)=>{const t=String(s||'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};

export class CanvasBoard{
 /** paceMs: how long a drawing takes to appear (0 in tests). */
 constructor(store,{clock=Date.now,paceMs=1400,settleMs=1200}={}){
  Object.assign(this,{store,clock,paceMs,settleMs});
  this.doc=null;this.timer=null;this.onUserEvents=null;this.live=null;
 }
 config(){return {...DEFAULT_CONFIG,...(this.store.value('canvas-config')||{})};}
 configure(patch){
  invariant(patch&&typeof patch==='object'&&!Array.isArray(patch),'Invalid canvas settings');
  if('enabled' in patch)invariant(typeof patch.enabled==='boolean','enabled is true or false');
  const next={...this.config(),...('enabled' in patch?{enabled:patch.enabled}:{})};
  this.store.value('canvas-config',next);this.store.emit('canvas.updated',this.summary());return next;
 }
 available(){return this.config().enabled===true;}
 load(){
  if(!this.doc){const d=this.store.get('canvas',BOARD);this.doc=d?{selection:null,userEvents:[],lastAgent:null,...d}:{id:BOARD,versions:[],selection:null,userEvents:[],lastAgent:null,revision:0};}
  return this.doc;
 }
 latest(){const v=this.load().versions;return v[v.length-1]||null;}
 version(n){return this.load().versions.find(v=>v.n===n)||null;}
 info(){const v=this.latest();return v?`shared canvas, v${v.n} "${v.caption}" by ${v.by.kind==='user'?'the user':v.by.title||'an agent'}`:'shared canvas, empty';}
 summary(){
  const d=this.load(),v=this.latest();
  return {id:d.id,enabled:this.available(),revision:d.revision,version:v?.n??0,caption:v?.caption||'',by:v?.by||null,selection:d.selection?{id:d.selection.id,version:d.selection.version}:null};
 }
 /** Full state for the UI: the current HTML plus the log (without old HTML). */
 snapshot(){
  const d=this.load(),v=this.latest();
  return {...this.summary(),html:v?.html||'',versions:d.versions.map(({n,caption,by,source,createdAt})=>({n,caption,by,source,createdAt})),live:this.live?{...this.live}:null};
 }
 save(){
  const d=this.load();
  // Keep the newest versions; the version numbers stay as they were.
  while(d.versions.length>CANVAS_LIMITS.versions||d.versions.length>1&&JSON.stringify(d.versions).length>PERSIST_BYTES)d.versions.shift();
  d.revision++;this.store.put('canvas',d);
 }
 commit({html,caption,by,source}){
  invariant(typeof html==='string'&&html.length<=CANVAS_LIMITS.html,`The artifact HTML is limited to ${CANVAS_LIMITS.html} characters`,413);
  const d=this.load(),prev=this.latest(),v={n:(prev?.n||0)+1,html,caption:oneLine(caption||'更新',40),by,source,createdAt:new Date(this.clock()).toISOString()};
  d.versions.push(v);if(by.kind==='agent')d.lastAgent=by.sessionId||null;
  if(d.selection&&!html.includes(`data-id="${d.selection.id}"`))d.selection=null;
  this.save();this.store.emit('canvas.updated',{...this.summary(),source});
  return v;
 }
 stream(event){this.store.broadcast('canvas.stream',{board:BOARD,...event});}
 async pause(ms,signal){
  if(!(ms>0))return;
  await new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(signal.reason||Object.assign(new Error('aborted'),{name:'AbortError'}));},{once:true});});
 }
 /** Shows a drawing growing, element by element, then commits it. Aborting commits nothing. */
 async create({html,summary,by,signal}){
  invariant(typeof html==='string'&&html.trim(),'html is required');
  invariant(html.length<=CANVAS_LIMITS.html,`The artifact HTML is limited to ${CANVAS_LIMITS.html} characters`,413);
  const turn=`t${this.clock().toString(36)}${Math.random().toString(36).slice(2,6)}`,cuts=createCuts(html);
  this.live={turn,action:'create',by,caption:summary||''};this.stream({turn,kind:'start',action:'create',by,caption:summary||'',base:0});
  try{for(const cut of cuts){signal?.throwIfAborted?.();this.stream({turn,kind:'html',html:html.slice(0,cut)});await this.pause(this.paceMs/cuts.length,signal);}}
  catch(error){this.live=null;this.stream({turn,kind:'abort'});throw error;}
  this.live=null;const v=this.commit({html,caption:summary||'新しい作品',by,source:'create'});
  this.stream({turn,kind:'end',version:v.n});return {version:v,results:[]};
 }
 /** Applies ops one by one on screen, then commits the result as one version. */
 async patch({ops,summary,expectedVersion,by,signal}){
  invariant(Array.isArray(ops)&&ops.length,'ops must be a non-empty array');
  invariant(ops.length<=CANVAS_LIMITS.ops,`At most ${CANVAS_LIMITS.ops} ops at a time`);
  const base=this.latest();invariant(base,'The canvas is empty: use create first',409);
  invariant(expectedVersion==null||expectedVersion===base.n,`The canvas is now v${base.n}, not v${expectedVersion}: read it and patch again`,409);
  const turn=`t${this.clock().toString(36)}${Math.random().toString(36).slice(2,6)}`;
  this.live={turn,action:'patch',by,caption:summary||''};this.stream({turn,kind:'start',action:'patch',by,caption:summary||'',base:base.n});
  try{for(const op of ops){signal?.throwIfAborted?.();const n=canvasNormalizeOp(op);if(n)this.stream({turn,kind:'op',op:n});await this.pause(Math.min(220,this.paceMs/ops.length),signal);}}
  catch(error){this.live=null;this.stream({turn,kind:'abort'});throw error;}
  this.live=null;
  const r=canvasApplyOps(base.html,ops,CanvasParser);
  if(!r.results.some(x=>x.ok)){this.stream({turn,kind:'abort'});return {version:null,results:r.results};}
  const v=this.commit({html:r.html,caption:summary||canvasDescribeOps(ops),by,source:'patch'});
  this.stream({turn,kind:'end',version:v.n});return {version:v,results:r.results,added:r.added,removed:r.removed,changed:r.changed};
 }
 revert({version,by}){
  const old=this.version(version);invariant(old,`v${version} is not in the log (kept: ${this.load().versions.map(v=>v.n).join(', ')||'none'})`,404);
  const v=this.commit({html:old.html,caption:`v${version} に戻す`,by,source:'revert'});
  this.stream({turn:`r${v.n}`,kind:'end',version:v.n});return v;
 }
 /** What a model should know about the current element: a short opening tag and its text. */
 describe(id,html=this.latest()?.html||''){
  const root=new CanvasParser().parseFromString(`<body>${html}</body>`).body,el=root.querySelector(`[data-id="${String(id).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"]`);
  if(!el)return null;const text=oneLine(el.textContent,80);
  return {id,tag:el.localName,snippet:oneLine(el.outerHTML,SNIPPET),...(text?{text}:{})};
 }
 // ---- the user's own hands on the canvas ----
 select(id,{version}={}){
  const v=this.latest();invariant(v,'The canvas is empty',409);
  const d=this.load();
  if(id==null||id===''){d.selection=null;this.note({type:'deselect'});}
  else{const info=this.describe(String(id),v.html);invariant(info,`"${id}" is not on the canvas`,404);d.selection={...info,version:version??v.n};this.note({type:'select',...info,version:v.n});}
  this.save();this.store.emit('canvas.updated',this.summary());return this.summary();
 }
 edit({action,id,version}){
  invariant(['remove','revert'].includes(action),'action is remove or revert');
  const by={kind:'user'};let v;
  if(action==='remove'){
   const base=this.latest();invariant(base,'The canvas is empty',409);
   const info=this.describe(String(id),base.html);invariant(info,`"${id}" is not on the canvas`,404);
   const r=canvasApplyOps(base.html,[{op:'remove',id:String(id)}],CanvasParser);
   v=this.commit({html:r.html,caption:`「${id}」を削除`,by,source:'user'});this.note({type:'remove',...info,version:v.n});
  }else{
   const target=version??(this.latest()?.n||1)-1;v=this.revert({version:target,by});this.note({type:'revert',to:target,version:v.n});
  }
  this.stream({turn:`u${v.n}`,kind:'end',version:v.n});return this.snapshot();
 }
 note(event){
  const d=this.load();
  // A new selection replaces an unreported older one: only what the user points at now matters.
  if(event.type==='select'||event.type==='deselect')d.userEvents=d.userEvents.filter(e=>e.type!=='select'&&e.type!=='deselect');
  d.userEvents.push({...event,at:new Date(this.clock()).toISOString()});d.userEvents=d.userEvents.slice(-12);
  clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),this.settleMs);this.timer.unref?.();
 }
 /** Unreported user actions as one context note (or ''), and clears them. */
 takeUserEvents(){
  const d=this.load();if(!d.userEvents.length)return '';
  const lines=d.userEvents.map(userEventLine).filter(Boolean);d.userEvents=[];this.save();
  if(!lines.length)return '';
  const v=this.latest();
  return `The user acted on the shared canvas directly (it is now v${v?.n??0}):\n${lines.map(l=>'- '+l).join('\n')}\nWhen they say "this/これ/ここ", they mean the selected element. Use canvas read for the full current HTML.`;
 }
 flush(){clearTimeout(this.timer);this.timer=null;const text=this.takeUserEvents();if(text)this.onUserEvents?.(text,this.load().lastAgent);return text;}
 close(){clearTimeout(this.timer);this.timer=null;}
}

function userEventLine(e){
 if(e.type==='select')return `selected "${e.id}" in v${e.version}: ${e.snippet}`;
 if(e.type==='deselect')return 'cleared the selection';
 if(e.type==='remove')return `removed "${e.id}" (${e.tag}), making v${e.version}`;
 if(e.type==='revert')return `went back to v${e.to}, making v${e.version}`;
 return '';
}

/** Cut points for showing a create progressively: after closing tags, about a dozen steps. */
function createCuts(html){
 const ends=[];for(const m of html.matchAll(/<\/[a-zA-Z][\w:-]*\s*>|\/>/g))ends.push(m.index+m[0].length);
 const steps=Math.min(16,ends.length),out=[];
 for(let i=1;i<=steps;i++)out.push(ends[Math.round(i*ends.length/steps)-1]);
 if(out[out.length-1]!==html.length)out.push(html.length);
 return [...new Set(out)];
}

const CANVAS_TOOL_DESCRIPTION=`The shared canvas: one visual artifact the user watches live and can select, remove or undo in. Use it unasked when a picture, diagram, circuit, chart or mock-up beats words.
read: HTML, log, the user's selection and direct changes. create {html,summary}: first version or full rebuild. patch {ops,summary,expected_version?}: small ops by data-id — set {id,attrs?,style?,text?}, add {parent,html,before?}, remove {id}, replace {id,html}. revert {version}.
html: a self-contained fragment, no scripts/on*/external URLs; inline <style> and SVG fine. Short stable data-id on every editable part ("flame", "R1"). Pictures: <svg viewBox="0 0 800 600" width="100%" height="100%">, background first, complete at once. Circuits: standard symbols, orthogonal wires, labels like "R1 330Ω". No overlapping text. summary: caption ≤20 Japanese chars. Then say in one sentence what you drew.`;

export function canvasTool(board){
 const by=ctx=>({kind:'agent',sessionId:ctx.session?.id||null,sessionKind:ctx.session?.kind||null,title:ctx.session?.kind==='main'?'会話':ctx.session?.title||'仕事'});
 const failures=results=>results.map((r,i)=>r.ok?null:`op ${i+1}: ${r.error}`).filter(Boolean);
 const pending=()=>{const t=board.takeUserEvents();return t?`\n\n${t}`:'';};
 return {
  name:'canvas',group:'core',available:()=>board.available(),
  description:CANVAS_TOOL_DESCRIPTION,
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
   action:{type:'string',enum:['read','create','patch','revert']},
   html:{type:'string'},
   ops:{type:'array',items:{type:'object'}},
   summary:{type:'string'},
   expected_version:{type:'integer'},
   version:{type:'integer'}
  }},
  summarize:a=>a.action==='create'?`キャンバスに描いています${a.summary?`: ${a.summary}`:''}`:a.action==='patch'?`キャンバスを手直ししています${a.summary?`: ${a.summary}`:''}`:a.action==='revert'?`キャンバスを v${a.version} に戻しています`:'キャンバスを見ています',
  ephemeral:true,ephemeralKey:a=>a.action==='read'?'canvas:read':null,
  async run(a,ctx){
   if(a.action==='read'){
    const s=board.snapshot(),sel=board.load().selection,text=board.takeUserEvents();
    if(!s.version)return {text:'The canvas is empty. Use create to draw the first version.'+(text?`\n\n${text}`:''),data:{version:0}};
    const log=s.versions.slice(-8).map(v=>`v${v.n} ${v.caption} (${v.by?.kind==='user'?'user':v.by?.title||'agent'})`).join('; ');
    return {text:`Canvas v${s.version} "${s.caption}". Log: ${log}.${sel?`\nSelected by the user: "${sel.id}" ${sel.snippet}`:''}${text?`\n\n${text}`:''}\n\nHTML:\n${s.html.slice(0,CANVAS_LIMITS.output)}${s.html.length>CANVAS_LIMITS.output?'\n…(truncated)':''}`,data:{version:s.version,selection:sel?.id||null}};
   }
   if(a.action==='create'){
    const r=await board.create({html:a.html,summary:a.summary,by:by(ctx),signal:ctx.signal});
    return {text:`Drew v${r.version.n} "${r.version.caption}" on the shared canvas; the user sees it now.${pending()}`,data:{version:r.version.n}};
   }
   if(a.action==='patch'){
    const r=await board.patch({ops:a.ops,summary:a.summary,expectedVersion:a.expected_version,by:by(ctx),signal:ctx.signal}),bad=failures(r.results);
    if(!r.version)return {text:`No change: none of the ${r.results.length} ops applied.\n${bad.join('\n')}\nUse canvas read to see the current ids.`,data:{version:board.latest()?.n??0}};
    return {text:`Made v${r.version.n} "${r.version.caption}" (${r.results.length-bad.length}/${r.results.length} ops applied).${bad.length?'\n'+bad.join('\n'):''}${pending()}`,data:{version:r.version.n,failed:bad.length}};
   }
   if(a.action==='revert'){
    invariant(Number.isInteger(a.version),'version is required');
    const v=board.revert({version:a.version,by:by(ctx)});return {text:`Brought back v${a.version} as v${v.n}.${pending()}`,data:{version:v.n}};
   }
   invariant(false,'action is read, create, patch or revert');
  }
 };
}
