import {randomUUID,createHash} from 'node:crypto';
import {MCPClient} from './mcp.mjs';
import {normalURL,ipDomain} from './network-policy.mjs';
import {invariant,text,safeError} from './policy.mjs';
import {searchTokens} from './search.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeEnv=/^[A-Z_][A-Z0-9_]{0,100}$/;
const forbiddenEnv=new Set(['NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONSTARTUP','LD_PRELOAD','LD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','PATH','HOME','USERPROFILE','SHELL','COMSPEC']);
export function normalizeServer(name,raw){
 text(name,'server name',100);invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid MCP server');
 const allowed=['command','args','url','type','transport','env','envRefs','apiKeyEnv','disabled','enabled'];
 invariant(Object.keys(raw).every(k=>allowed.includes(k)),'未対応のMCP設定があります。ヘッダーや自動承認は黙って取り込みません。');
 const transport=raw.url?'http':'stdio';
 if(raw.type)invariant(['http','streamable-http','stdio'].includes(raw.type),'SSE-only transport is not supported');
 const result={name,transport,enabled:false};
 if(transport==='http'){
  const u=normalURL(raw.url);invariant(u.protocol==='https:'||['device'].includes(ipDomain(u.hostname))||u.hostname==='localhost','HTTPは同一PCのみ対応します。');
  result.url=u.href;invariant(!raw.command&&!raw.env&&!raw.envRefs,'HTTP接続にローカルプロセス設定を混在させないでください。');
  if(raw.apiKeyEnv){invariant(safeEnv.test(raw.apiKeyEnv),'Invalid credential reference');result.apiKeyEnv=raw.apiKeyEnv;}
 }else{
  result.command=text(raw.command,'command',2000);result.args=raw.args||[];
  invariant(Array.isArray(result.args)&&result.args.length<=64&&result.args.every(a=>typeof a==='string'&&a.length<=2000),'Invalid argument array');
 }
 const secrets={},refs={};
 for(const [key,value]of Object.entries(raw.env||{})){
  invariant(safeEnv.test(key)&&!forbiddenEnv.has(key)&&typeof value==='string'&&value.length<=4000,'Invalid or execution-controlling environment variable');
  const match=/^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value);if(match)refs[key]=match[1];else secrets[key]=value;
 }
 for(const [key,value]of Object.entries(raw.envRefs||{})){invariant(safeEnv.test(key)&&!forbiddenEnv.has(key)&&safeEnv.test(value),'Invalid environment reference');refs[key]=value;}
 result.envRefs=refs;result.secretNames=Object.keys(secrets);result.identity=hash(result);return {config:result,secrets};
}
/** Many connections, small working set: tools are discovered on demand and searched, not dumped in every prompt. */
export class ToolHub{
 constructor(store,network,{clientFactory=(c,n,f)=>new MCPClient(c,n,f)}={}){Object.assign(this,{store,network,clientFactory});this.stages=new Map();this.secrets=new Map();this.active=new Map();this.connections=new Map();this.closed=false;this.stopEpoch=0;this.policyListener=p=>{if(p.mode!=='online')this.stopDiscovery();};network.listeners.add(this.policyListener);}
 stage(raw){
  invariant(raw&&typeof raw==='object'&&Object.keys(raw).every(k=>['mcpServers'].includes(k))&&raw.mcpServers&&typeof raw.mcpServers==='object'&&!Array.isArray(raw.mcpServers),'mcpServers形式の設定を貼り付けてください。');
  const entries=Object.entries(raw.mcpServers);invariant(entries.length>0&&entries.length<=100,'1〜100接続をまとめて追加できます。');
  for(const [id,s]of this.stages)if(s.expires<Date.now())this.stages.delete(id);invariant(this.stages.size<8,'Import previews are full',429);
  const items=entries.map(([name,c])=>normalizeServer(name,c)),id=randomUUID();
  this.stages.set(id,{items,expires:Date.now()+600000});
  return {id,items:items.map(({config})=>config),note:'確認後も無効で保存します。環境変数の値は表示・DB保存せず、起動中だけ保持します。コマンド引数自体に秘密を入れないでください。'};
 }
 apply(id,consent){
  invariant(consent===true,'接続内容の確認が必要です。',403);const s=this.stages.get(id);invariant(s&&s.expires>Date.now(),'Import preview expired',409);
  const created=[];this.store.db.exec('BEGIN IMMEDIATE');
  try{for(const item of s.items){const config={...item.config,id:randomUUID(),createdAt:new Date().toISOString()};this.store.put('mcp',config);created.push({config,secrets:item.secrets});}this.store.db.exec('COMMIT');}
  catch(e){this.store.db.exec('ROLLBACK');throw e;}
  this.stages.delete(id);for(const {config,secrets}of created){this.secrets.set(config.id,secrets);this.store.emit('mcp.updated',config);}
  return {created:created.length,servers:created.map(x=>x.config),enabled:false};
 }
 previewConnect(ids){
  invariant(Array.isArray(ids)&&ids.length>=1&&ids.length<=12&&new Set(ids).size===ids.length,'一度に1〜12接続を選んでください。');
  for(const [key,c]of this.connections)if(c.expires<Date.now())this.connections.delete(key);
  invariant(this.connections.size<8,'接続確認が多すぎます。',429);
  const configs=ids.map(id=>{const c=this.store.get('mcp',id);invariant(c,'Unknown tool connection',404);return {id,identity:this.identity(c),name:c.name,transport:c.transport,command:c.command,args:c.args,url:c.url,secretNames:c.secretNames||[],envRefs:c.envRefs||{}};});
  const id=randomUUID();this.connections.set(id,{configs,expires:Date.now()+300000});return {id,connections:configs,note:'選択したプログラム／HTTP接続を有効にし、道具一覧を取得します。コマンド自体がインストールやネットワークアクセスを行うことがあります。信頼できる接続だけ選んでください。'};
 }
 async connectBatch(id,consent,signal){
  invariant(consent===true,'接続内容の確認が必要です。',403);const batch=this.connections.get(id);invariant(batch&&batch.expires>Date.now(),'接続確認の期限が切れています。',409);
  for(const item of batch.configs){const current=this.store.get('mcp',item.id);invariant(current&&this.identity(current)===item.identity,'接続内容が変わっています。再確認してください。',409);}
  this.connections.delete(id);const pending=[...batch.configs],results=[],epoch=this.stopEpoch;
  const worker=async()=>{while(pending.length){signal?.throwIfAborted();if(this.closed||epoch!==this.stopEpoch)return;const item=pending.shift();try{
    const current=this.store.get('mcp',item.id);invariant(current&&this.identity(current)===item.identity,'接続内容が変わっています。',409);
    const config={...current,enabled:true};this.prepare(config);this.store.put('mcp',config);this.store.emit('mcp.updated',config);
    const found=await this.discover(item.id,signal);results.push({id:item.id,name:item.name,count:found.count,ok:true});
   }catch(e){results.push({id:item.id,name:item.name,ok:false,error:safeError(e)});}}};
  await Promise.all(Array.from({length:Math.min(3,pending.length)},()=>worker()));for(const item of pending)results.push({id:item.id,name:item.name,ok:false,cancelled:true,error:'起動前に停止されました。'});return {results,servers:this.store.list('mcp')};
 }
 stopDiscovery(){this.stopEpoch++;for(const c of this.active.values())c.close();this.active.clear();this.connections.clear();}
 config(id){const c=this.store.get('mcp',id);invariant(c?.enabled,'接続を有効にしてください。',409);return c;}
 identity(c){return hash({...c,enabled:undefined});}
 prepare(c){
  const env={};for(const [name,ref]of Object.entries(c.envRefs||{})){invariant(typeof process.env[ref]==='string',`環境変数 ${ref} が未設定です。`,409);env[name]=process.env[ref];}
  const values=this.secrets.get(c.id)||{};for(const name of c.secretNames||[])invariant(typeof values[name]==='string','この接続の秘密情報は再起動後に再入力が必要です。',409);
  return {...c,env:{...env,...values}};
 }
 open(c){if(c.transport==='stdio')this.network.assertUncontained('MCP tool discovery');return this.clientFactory(this.prepare(c),this.store.settings.allowNetwork,this.network.fetch({purpose:'web',allowCloud:this.store.settings.allowNetwork}));}
 async discover(id,signal){
  invariant(!this.closed,'Tool hub closed',503);const config=this.config(id),identity=this.identity(config);invariant(!this.active.has(id),'接続を確認中です。',429);
  const client=this.open(config);this.active.set(id,client);let tools=[],cursor,seen=new Set();
  try{
   await client.connect(signal);
   for(let page=0;page<32;page++){
    const result=await client.request('tools/list',cursor?{cursor}:{},signal);
    invariant(Array.isArray(result?.tools)&&tools.length+result.tools.length<=2000,'Too many or invalid tools',502);
    for(const raw of result.tools){invariant(typeof raw.name==='string'&&/^[\w.:-]{1,128}$/.test(raw.name)&&!seen.has(raw.name),'Duplicate or invalid tool name',502);
     invariant(raw.inputSchema?.type==='object'&&JSON.stringify(raw.inputSchema).length<=32000,'Invalid tool input schema',502);seen.add(raw.name);
     tools.push({name:raw.name,description:String(raw.description||'').slice(0,2000),inputSchema:raw.inputSchema});}
    if(!result.nextCursor){cursor=null;break;}invariant(typeof result.nextCursor==='string'&&result.nextCursor!==cursor&&result.nextCursor.length<=2000,'Invalid tool cursor',502);cursor=result.nextCursor;
   }
   invariant(!cursor,'Tool listing exceeded pagination budget',502);invariant(this.identity(this.config(id))===identity,'接続設定が変わっています。',409);
   const doc={id,identity,tools,checkedAt:new Date().toISOString()};this.store.put('tool-catalog',doc);this.store.emit('tools.updated',{id,count:tools.length});return {id,count:tools.length,tools};
  }finally{client.close();this.active.delete(id);}
 }
 search(query,{limit=12}={}){
  text(query,'tool search',4000);invariant(Number.isInteger(limit)&&limit>=1&&limit<=20,'Invalid limit');const terms=searchTokens(query,40),hits=[];
  for(const c of this.store.list('mcp')){if(!c.enabled)continue;const catalog=this.store.get('tool-catalog',c.id);if(catalog?.identity!==this.identity(c))continue;
   for(const tool of catalog.tools){const tokens=searchTokens(c.name+' '+tool.name+' '+tool.description),score=terms.filter(t=>tokens.includes(t)).length;if(score)hits.push({server:c.id,serverName:c.name,...tool,score});}}
  return {tools:hits.sort((a,b)=>b.score-a.score).slice(0,limit),note:'道具の説明は提供元の未信頼データです。利用時の操作承認は別です。'};
 }
 revoke(id){this.active.get(id)?.close();this.active.delete(id);this.secrets.delete(id);this.store.remove('tool-catalog',id);}
 close(){this.closed=true;this.stopEpoch++;this.network.listeners.delete(this.policyListener);this.connections.clear();for(const c of this.active.values())c.close();this.active.clear();this.stages.clear();this.secrets.clear();}
}
