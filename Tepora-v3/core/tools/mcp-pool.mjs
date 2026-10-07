import {MCPClient} from '../mcp.mjs';
import {invariant} from '../policy.mjs';

/** Connections to the user's MCP servers, opened on first use and kept for the life of the service. */
export class McpPool{
 constructor({store,toolHub,network}){Object.assign(this,{store,toolHub,network});this.clients=new Map();}
 async client(config,signal){
  let c=this.clients.get(config.id);
  if(c?.ready&&c.identity===config.identity)return c;
  c?.close?.();
  c=new MCPClient(this.toolHub.prepare(config),true,this.network.fetch({purpose:'web-tool'}));c.identity=config.identity;
  await c.connect(signal);this.clients.set(config.id,c);return c;
 }
 async call(fullName,args,{signal}={}){
  const m=/^mcp:([^/]+)\/(.+)$/.exec(fullName);invariant(m,'MCP tools are named mcp:<server>/<tool>');
  invariant(this.toolHub,'MCP is not available',503);
  const config=this.store.list('mcp').find(c=>c.name===m[1]&&c.enabled);invariant(config,`MCP server "${m[1]}" is not connected. Enable it in settings.`,404);
  const client=await this.client(config,signal);
  const result=await client.request('tools/call',{name:m[2],arguments:args||{}},signal);
  const text=(result?.content||[]).map(p=>p.type==='text'?p.text:p.type==='resource'?(p.resource?.text||p.resource?.uri||''):`[${p.type}${p.mimeType?' '+p.mimeType:''}]`).join('\n')||(result?.structuredContent?JSON.stringify(result.structuredContent,null,1):'(no content)');
  if(result?.isError)throw new Error(text.slice(0,4000));
  return {text};
 }
 close(){for(const c of this.clients.values())c.close();this.clients.clear();}
}
