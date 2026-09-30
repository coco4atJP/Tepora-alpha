import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {killTree} from '../connectors.mjs';
import {invariant} from '../policy.mjs';

/** Bounded, newline-delimited JSON RPC. Only the configured executable is launched.
 * Stdout is protocol, stderr is diagnostic only; neither is exposed as executable code.
 */
export class AgentRPC extends EventEmitter {
  constructor({command,args=[],cwd,env={},inheritEnv=true,timeoutMs=15000,maxFrame=2_000_000}) {
    super();Object.assign(this,{command,args,cwd,timeoutMs,maxFrame});
    this.env=env;this.inheritEnv=inheritEnv;this.next=1;this.pending=new Map();this.incoming=new Set();this.ended=false;
  }
  start() {
    invariant(!this.child,'Agent process already started',409);
    invariant(typeof this.command==='string'&&this.command.length>0,'An agent executable is required');
    this.child=spawn(this.command,this.args,{cwd:this.cwd,shell:false,windowsHide:true,
      detached:process.platform!=='win32',env:{...(this.inheritEnv?process.env:Object.fromEntries(['PATH','HOME','USERPROFILE','SYSTEMROOT','TEMP','TMP','LANG','DISPLAY','XDG_RUNTIME_DIR','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))),...this.env}});
    this.child.stdin.on('error',error=>this.fail(error));
    let buffer='';this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.length>this.maxFrame){this.fail(new Error('Agent protocol frame exceeds limit'));return;}
      let index;
      while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;
        try{this.receive(JSON.parse(line));}catch(e){this.fail(e);return;}
      }
    });
    this.child.stderr.on('data',()=>{}); // Do not persist inherited credentials or prompts from stderr.
    this.child.once('error',e=>this.fail(e));
    this.child.once('exit',()=>this.fail(new Error('Agent process disconnected')));
    return this;
  }
  write(message) {
    invariant(!this.ended&&this.child?.stdin.writable,'Agent connection is closed',503);
    const wire=JSON.stringify(message)+'\n';invariant(wire.length<=this.maxFrame,'Agent request exceeds limit',413);
    // A slow child must not accumulate unbounded input in Node's write buffer.
    invariant(this.child.stdin.writableLength<this.maxFrame,'Agent input is backpressured',429);
    this.child.stdin.write(wire);
  }
  request(method,params={},signal,timeoutMs=this.timeoutMs) {
    signal?.throwIfAborted();invariant(this.pending.size<64,'Too many outstanding agent requests',429);
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);};
      const finish=(error,result)=>{cleanup();error?reject(error):resolve(result);};
      const abort=()=>finish(signal.reason||new Error('Agent request cancelled'));
      const timer=setTimeout(()=>finish(new Error(`Agent request timed out: ${method}`)),timeoutMs);
      this.pending.set(id,{finish});signal?.addEventListener('abort',abort,{once:true});
      try{this.write({id,method,params});}catch(e){finish(e);}
    });
  }
  notify(method,params={}) {this.write({method,params});}
  respond(id,result) {
    if(!this.incoming.delete(id)||this.ended)return false;
    this.write({id,result});return true;
  }
  reject(id,message='Unsupported server request') {
    if(!this.incoming.delete(id)||this.ended)return;
    this.write({id,error:{code:-32601,message}});
  }
  receive(m) {
    if(this.ended)return;
    invariant(m&&typeof m==='object'&&!Array.isArray(m),'Invalid agent protocol message',502);
    if(typeof m.method==='string') {
      if(m.id!==undefined){
        invariant(['number','string'].includes(typeof m.id)&&!this.incoming.has(m.id),'Duplicate/invalid agent request id',502);
        invariant(this.incoming.size<32,'Agent approval queue overflow',429);this.incoming.add(m.id);
        if(!this.listenerCount('request'))this.reject(m.id);else this.emit('request',m);
      }else this.emit('notification',m);
    } else if(m.id!==undefined) {
      const pending=this.pending.get(m.id);if(!pending)return;
      pending.finish(m.error?Object.assign(new Error(String(m.error.message||'Agent RPC failed').slice(0,600)),{rpcCode:m.error.code}):null,m.result);
    } else throw new Error('Agent message has neither method nor id');
  }
  fail(error) {
    if(this.ended)return;this.ended=true;
    for(const p of [...this.pending.values()])p.finish(error);
    this.incoming.clear();this.emit('disconnect',error);killTree(this.child);
  }
  close() {this.fail(new Error('Agent client closed'));}
}
