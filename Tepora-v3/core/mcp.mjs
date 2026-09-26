import { killTree } from './connectors.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { endpoint, invariant, safeError } from './policy.mjs';
// Deliberately small client: stdio and Streamable HTTP tools. No sampling, OAuth or Tasks-extension claim.
export class MCPClient {
  constructor(config,allowNetwork=false) {this.config=config;this.allowNetwork=allowNetwork;this.pending=new Map();this.buffer='';this.session=null;this.ready=false;}
  async connect(signal) {
    if(this.ready) return;
    if(this.config.transport==='stdio') {
      invariant(typeof this.config.command==='string' && Array.isArray(this.config.args),'MCP command and args required');
      const env={PATH:process.env.PATH,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,...this.config.env};
      this.child=spawn(this.config.command,this.config.args,{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32',env});
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data',chunk=>{
        this.buffer+=chunk;
        if(this.buffer.length>2_000_000){this.close();return;}
        let at; while((at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at);this.buffer=this.buffer.slice(at+1);try{this.receive(JSON.parse(line));}catch{/* Non-protocol stdout is ignored, never executed. */}}
      });
      this.child.stderr.on('data',()=>{});
      this.child.on('error',e=>this.fail(e)); this.child.on('exit',()=>this.fail(new Error('MCP process exited')));
    }
    const result=await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'tepora-v3',version:'3.0.0-beta.1'}},signal);
    invariant(result?.protocolVersion,'MCP server did not negotiate a version',502);this.protocolVersion=result.protocolVersion;
    await this.notify('notifications/initialized',{});this.ready=true;
  }
  receive(message) {
    if(message.id!==undefined && !message.method){const p=this.pending.get(String(message.id));if(p){this.pending.delete(String(message.id));p.cleanup();message.error?p.reject(new Error(message.error.message||'MCP error')):p.resolve(message.result);}}
    else if(message.method && message.id!==undefined) this.child?.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Server-initiated requests are not supported'}})+'\n');
  }
  async http(message,signal) {
    const url=endpoint(this.config.url,this.allowNetwork);
    const r=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(this.session?{'Mcp-Session-Id':this.session}:{}),...(this.protocolVersion?{'MCP-Protocol-Version':this.protocolVersion}:{}),...(this.config.apiKeyEnv && process.env[this.config.apiKeyEnv]?{Authorization:`Bearer ${process.env[this.config.apiKeyEnv]}`}:{})},body:JSON.stringify(message),signal});
    invariant(r.ok,`MCP HTTP ${r.status}`,502);
    this.session=r.headers.get('Mcp-Session-Id')||this.session;
    if(r.status===202 || message.id===undefined){await r.body?.cancel();return null;}
    if((r.headers.get('content-type')||'').includes('text/event-stream')) {
      const {sseData}=await import('./runtime.mjs');
      for await(const data of sseData(r.body)){try{const b=JSON.parse(data);if(b.id===message.id)return b;}catch{}}
      throw new Error('MCP stream ended without response');
    }
    return r.json();
  }
  async notify(method,params) {
    const body={jsonrpc:'2.0',method,params};
    if(this.child) {this.child.stdin.write(JSON.stringify(body)+'\n');return;}
    return this.http(body,AbortSignal.timeout(10000));
  }
  async request(method,params={},signal) {
    const id=randomUUID(),body={jsonrpc:'2.0',id,method,params};
    const combined=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(30000)]);
    combined.throwIfAborted();
    if(this.config.transport!=='stdio') {
      const r=await this.http(body,combined);if(r?.error)throw new Error(safeError(r.error));return r?.result;
    }
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.pending.delete(id);this.notify('notifications/cancelled',{requestId:id,reason:'Cancelled'}).catch(()=>{});reject(combined.reason);};
      const cleanup=()=>combined.removeEventListener('abort',abort);
      this.pending.set(id,{resolve,reject,cleanup});combined.addEventListener('abort',abort,{once:true});
      this.child.stdin.write(JSON.stringify(body)+'\n',e=>{if(e){this.pending.delete(id);cleanup();reject(e);}});
    });
  }
  fail(error){for(const p of this.pending.values()){p.cleanup();p.reject(error);}this.pending.clear();this.ready=false;}
  close(){this.fail(new Error('MCP connection closed'));if(this.child){this.child.stdout.removeAllListeners('data');killTree(this.child);}this.child=null;this.buffer='';}
}
