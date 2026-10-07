import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {invariant} from '../policy.mjs';
import {searchTokens} from '../search.mjs';

const NAME=/^[a-zA-Z][\w-]{0,63}$/;
/** Fixed tool sets. A session keeps its set for life so the cached prompt prefix never changes;
 * everything else is reached through tools_search / tools_call. */
export const TOOLSETS={
 main:['sessions_spawn','sessions_send','sessions_list','sessions_history','sessions_stop','schedule','memory_search','memory_write','web_search','web_fetch','recall','history_search','skill','tools_search','tools_call'],
 worker:['exec','process','read','write','edit','find','grep','web_search','web_fetch','computer','media','todo','artifact','recall','history_search','memory_search','memory_write','skill','sessions_spawn','sessions_send','sessions_list','tools_search','tools_call'],
 lean:['exec','read','write','edit','web_search','web_fetch','computer','todo','recall','skill','sessions_send']
};
export function validateTool(def){
 invariant(def&&typeof def==='object','Tool definition must be an object');
 invariant(NAME.test(def.name),`Invalid tool name: ${def?.name}`);
 invariant(typeof def.description==='string'&&def.description.length>0,`Tool ${def.name} needs a description`);
 invariant(def.parameters?.type==='object','Tool parameters must be a JSON Schema object');
 invariant(typeof def.run==='function',`Tool ${def.name} needs run(args, ctx)`);
 return {group:'extra',readOnly:false,ephemeral:false,...def};
}
/** Hook points a plugin can implement (each optional, run in plugin load order, results compose):
 *  beforeTool({session,name,args})        → {block:'reason'} to refuse the call, or {args} to change it
 *  afterTool({session,name,args,text})    → {text} to replace what the model sees (redact, annotate)
 *  beforeRequest({session,messages})      → {messages} for this request only (it bypasses the cache if it rewrites the prefix)
 *  turnEnd({session,text})                → {continue:'message'} to send the agent back to work with that message
 *  event({type,sessionId,...})            → notification only */
export const HOOKS=['beforeTool','afterTool','beforeRequest','turnEnd','event'];
export class ToolRegistry{
 constructor({pluginDir=null,mcp=null}={}){this.tools=new Map();this.pluginDir=pluginDir;this.mcp=mcp;this.plugins=new Set();this.errors=[];this.hooks=[];}
 /** Runs one hook point across plugins. A failing hook is reported and skipped; it never stops the agent. */
 async hook(point,payload){
  let out={};
  for(const h of this.hooks){
   if(typeof h[point]!=='function')continue;
   try{const r=await h[point]({...payload,...out});if(r&&typeof r==='object')out={...out,...r};if(out.block)break;}
   catch(e){this.errors.push({file:h.file,error:`${point}: ${String(e?.message||e).slice(0,300)}`});if(this.errors.length>50)this.errors.shift();}
  }
  return out;
 }
 addHooks(hooks,file='inline'){invariant(hooks&&typeof hooks==='object','Hooks must be an object');for(const k of Object.keys(hooks))invariant(HOOKS.includes(k),`Unknown hook ${k}`);this.hooks.push({...hooks,file});}
 register(def,{plugin=false}={}){const t=validateTool(def);this.tools.set(t.name,t);if(plugin)this.plugins.add(t.name);return t;}
 registerAll(defs,options){for(const d of defs)this.register(d,options);return this;}
 get(name){return this.tools.get(name)||null;}
 has(name){return this.tools.has(name);}
 /** Names of a tool set that are actually available, in a stable order. */
 toolset(kind,{exclude=[]}={}){return (TOOLSETS[kind]||TOOLSETS.worker).filter(n=>this.tools.has(n)&&!exclude.includes(n)&&this.tools.get(n).available?.()!==false);}
 definitions(names){return names.map(n=>this.tools.get(n)).filter(Boolean).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));}
 /** Extension tools: everything not in the session's fixed set, plus MCP tools. */
 search(query,{exclude=[],limit=8}={}){
  const terms=searchTokens(query,40),hits=[];
  for(const t of this.tools.values()){
   if(exclude.includes(t.name)||t.available?.()===false)continue;
   const tokens=searchTokens(`${t.name.replace(/_/g,' ')} ${t.description} ${t.keywords||''}`),score=terms.filter(x=>tokens.includes(x)).length;
   if(score)hits.push({name:t.name,description:t.description,parameters:t.parameters,score,source:this.plugins.has(t.name)?'plugin':'builtin'});
  }
  for(const m of this.mcp?.search(query,{limit:20})?.tools||[])hits.push({name:`mcp:${m.serverName}/${m.name}`,description:m.description,parameters:m.inputSchema,score:m.score,source:'mcp'});
  return hits.sort((a,b)=>b.score-a.score).slice(0,limit);
 }
 async loadPlugins(){
  if(!this.pluginDir)return {loaded:0};
  for(const name of this.plugins)this.tools.delete(name);this.plugins.clear();this.errors=[];this.hooks=this.hooks.filter(h=>!h.plugin);
  let files=[];try{files=(await readdir(this.pluginDir)).filter(f=>f.endsWith('.mjs')).sort();}catch(e){if(e.code==='ENOENT')return {loaded:0,hooks:0};throw e;}
  let loaded=0,hooks=0;
  for(const file of files){
   try{
    // A plugin exports tools (default export: one tool, an array, or {tools, hooks}) and/or `hooks`.
    const module=await import(pathToFileURL(path.join(this.pluginDir,file)).href+'?v='+Date.now());
    const main=module.default,bundle=main&&!Array.isArray(main)&&(main.tools||main.hooks)?main:{tools:main};
    for(const d of [bundle.tools].flat().filter(Boolean)){invariant(!this.tools.has(d.name)||this.plugins.has(d.name),`Plugin tool ${d.name} would replace a built-in tool`);this.register(d,{plugin:true});loaded++;}
    const h=bundle.hooks||module.hooks;if(h){this.addHooks(h,file);this.hooks.at(-1).plugin=true;hooks++;}
   }catch(e){this.errors.push({file,error:String(e.message).slice(0,300)});}
  }
  return {loaded,hooks,errors:this.errors};
 }
}
