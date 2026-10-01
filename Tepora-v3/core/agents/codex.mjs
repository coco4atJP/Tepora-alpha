import path from 'node:path';
import {AgentRPC} from './rpc.mjs';
import {invariant,safeError} from '../policy.mjs';

/** Official Codex App Server adapter. Does not scrape ~/.codex/auth.json or enumerate threads.
 * Only Tepora-owned (or explicitly imported) thread IDs are eligible for resume.
 * Inference uses the user's Codex configuration; launching requires separate explicit consent.
 */
export class CodexAgent {
  constructor({command='codex',args=['app-server'],cwd,model='',network=false,
    rpcFactory=options=>new AgentRPC(options),onUpdate=()=>{},onApproval=async()=>false,
    onSession=()=>{},session=null,maxDurationMs=30*60*1000,maxItems=512,maxEvidenceChars=1_000_000}) {
    Object.assign(this,{command,args,cwd,model,network,rpcFactory,onUpdate,onApproval,onSession,session,maxDurationMs,maxItems,maxEvidenceChars});
    this.evidenceChars=0;this.startedItems=new Map();this.deferredRequests=[];this.output='';this.items=new Map();this.deferred=[];this.closed=false;this.pendingApprovals=new Map();
  }
  async connect(signal) {
    this.rpc=this.rpcFactory({command:this.command,args:this.args,cwd:this.cwd});
    this.rpc.on('notification',m=>this.notification(m));
    this.rpc.on('request',m=>{this.serverRequest(m).catch(()=>this.rpc.respond(m.id,{decision:'decline'}));});
    this.rpc.on('disconnect',error=>{if(this.finished)return;this.settle?.(error);});
    this.rpc.start();
    await this.rpc.request('initialize',{clientInfo:{name:'tepora',title:'Tepora',version:'3.0.0-beta.11'}},signal);
    this.rpc.notify('initialized');
  }
  async account(signal) {
    await this.connect(signal);
    const result=await this.rpc.request('account/read',{refreshToken:false},signal);
    // Do not copy account tokens, email addresses or profile details into the UI/state store.
    return {connected:true,authenticated:!!result.account,requiresOpenaiAuth:result.requiresOpenaiAuth!==false};
  }
  sandboxPolicy() {
    return {type:'workspaceWrite',writableRoots:[this.cwd],networkAccess:this.network,
      readOnlyAccess:{type:'restricted',includePlatformDefaults:true,readableRoots:[this.cwd]}};
  }
  async run(input,signal) {
    signal?.throwIfAborted();this.signal=signal;
    await this.connect(signal);
    const params={cwd:this.cwd,approvalPolicy:'on-request',sandbox:'workspaceWrite',
      ...(this.model?{model:this.model}:{})};
    const previous=this.session;
    const reply=await this.rpc.request(previous?.threadId?'thread/resume':'thread/start',
      previous?.threadId?{...params,threadId:previous.threadId}:params,signal);
    invariant(typeof reply.thread?.id==='string','Codex returned no thread id',502);
    this.threadId=reply.thread.id;
    invariant(!previous||previous.threadId===this.threadId,'Codex resumed a different thread',502);
    this.session={threadId:this.threadId,turnId:null,status:'starting',cwd:this.cwd};this.onSession({...this.session});
    const completion=new Promise((resolve,reject)=>{this.settle=(error,result)=>{
      if(this.finished)return;this.finished=true;clearTimeout(this.timer);clearTimeout(this.abortTimer);
      signal?.removeEventListener('abort',this.abortListener);
      error?reject(error):resolve(result);
    };});
    // Attach immediately: an abort can arrive before turn/start has responded.
    completion.catch(()=>{});
    this.abortListener=()=>{
      if(this.abortRequested){if(this.turnId)this.interrupt().catch(()=>{});return;}
      this.invalidateApprovals();
      this.abortRequested=true;
      if(this.turnId)this.interrupt().catch(()=>{});
      this.abortTimer=setTimeout(()=>{
        this.session.status='unknown';this.onSession({...this.session});
        this.settle(signal.reason||new Error('Agent interrupted; outcome needs reconciliation'));this.rpc.close();
      },2000);
    };
    signal?.addEventListener('abort',this.abortListener,{once:true});
    this.timer=setTimeout(()=>{
      this.session.status='unknown';this.onSession({...this.session});
      this.interrupt().catch(()=>{});this.settle(new Error('External task duration limit reached'));this.rpc.close();
    },this.maxDurationMs);
    try {
      const result=await this.rpc.request('turn/start',{threadId:this.threadId,
        input:[{type:'text',text:input}],cwd:this.cwd,approvalPolicy:'on-request',
        sandboxPolicy:this.sandboxPolicy(),...(this.model?{model:this.model}:{})},signal);
      invariant(typeof result.turn?.id==='string','Codex returned no turn id',502);
      this.turnId=result.turn.id;this.session={...this.session,turnId:this.turnId,status:'running'};this.onSession({...this.session});
      // Notifications are permitted to precede the reply to turn/start.
      for(const m of this.deferred.splice(0))this.notification(m);
      for(const m of this.deferredRequests.splice(0))this.serverRequest(m).catch(()=>this.rpc.respond(m.id,{decision:'decline'}));
      if(this.abortRequested||signal?.aborted)this.abortListener();
      return await completion;
    }catch(e){this.settle(e);throw e;}
  }
  notification(m) {
    if(this.finished||this.closed)return;
    const p=m.params||{};
    if(!this.threadId)return;
    if(p.threadId&&p.threadId!==this.threadId)return;
    if(!this.turnId){if(this.deferred.length<128)this.deferred.push(m);return;}
    if(p.turnId&&p.turnId!==this.turnId)return;
    if(m.method==='item/started'&&p.item){
      if(this.startedItems.size<64)this.startedItems.set(p.item.id,p.item);
    }else if(m.method==='item/agentMessage/delta') {
      invariant(typeof p.delta==='string','Invalid agent output',502);
      this.output+=p.delta;
      if(this.output.length>200000){this.settle?.(new Error('Agent output exceeded limit'));this.rpc.close();return;}
      this.onUpdate({type:'output',output:this.output});
    }else if(m.method==='item/completed'&&p.item){
      const item=p.item;
      const record={id:item.id,type:item.type,status:item.status,exitCode:item.exitCode,
        text:typeof item.text==='string'?item.text.slice(0,200000):undefined};
      const nextSize=this.evidenceChars-JSON.stringify(this.items.get(item.id)||'').length+JSON.stringify(record).length;
      if((!this.items.has(item.id)&&this.items.size>=this.maxItems)||nextSize>this.maxEvidenceChars){
        this.session.status='unknown';this.onSession({...this.session});
        this.settle?.(new Error('External agent evidence budget exceeded; inspect the saved workspace before resuming'));
        this.invalidateApprovals();this.rpc.close();return;
      }
      this.evidenceChars=nextSize;this.items.set(item.id,record);
      if(item.type==='agentMessage'&&typeof item.text==='string'&&!this.output)this.output=item.text.slice(0,200000);
      this.onUpdate({type:'item',item:{id:item.id,type:item.type,status:item.status,exitCode:item.exitCode}});
    }else if(m.method==='turn/plan/updated') {
      this.onUpdate({type:'plan',steps:Array.isArray(p.plan)?p.plan.slice(0,32).map(s=>({step:String(s.step||'').slice(0,500),status:s.status})):[]});
    }else if(m.method==='turn/completed'&&p.turn?.id===this.turnId){
      this.session.status=p.turn.status;this.onSession({...this.session});
      this.invalidateApprovals();
      if(p.turn.status==='completed')this.settle?.(null,{output:this.output,items:[...this.items.values()],session:{...this.session}});
      else this.settle?.(new Error(p.turn.status==='interrupted'?'Codex task interrupted':safeError(p.turn.error||'Codex task failed')));
    }
  }
  async serverRequest(m) {
    const p=m.params||{};
    if(this.threadId===p.threadId&&!this.turnId&&typeof p.turnId==='string'&&this.deferredRequests.length<16){this.deferredRequests.push(m);return;}
    if(!this.threadId||p.threadId!==this.threadId||!this.turnId||p.turnId!==this.turnId){this.rpc.respond(m.id,{decision:'decline'});return;}
    const supported=['item/commandExecution/requestApproval','item/fileChange/requestApproval'];
    if(!supported.includes(m.method)){this.rpc.reject(m.id,'Unsupported request; Tepora did not grant it');return;}
    // No session-wide amendments; an app-server request cannot broaden the configured boundary.
    const root=typeof p.grantRoot==='string'?path.resolve(p.grantRoot):null;
    if(root&&root!==this.cwd&&!root.startsWith(this.cwd+path.sep)){this.rpc.respond(m.id,{decision:'decline'});return;}
    if(p.additionalPermissions||p.proposedExecpolicyAmendment||p.networkApprovalContext&&!this.network){this.rpc.respond(m.id,{decision:'decline'});return;}
    const marker={valid:true};this.pendingApprovals.set(m.id,marker);
    let allow=false;
    try{allow=await this.onApproval({method:m.method,itemId:p.itemId,threadId:p.threadId,turnId:p.turnId,
      command:p.command,cwd:p.cwd,reason:p.reason,network:p.networkApprovalContext,changes:this.startedItems.get(p.itemId)?.changes});}catch{allow=false;}
    if(marker.valid&&!this.signal?.aborted)this.rpc.respond(m.id,{decision:allow===true?'accept':'decline'});
    this.pendingApprovals.delete(m.id);
  }
  invalidateApprovals() {
    for(const [id,marker] of this.pendingApprovals){marker.valid=false;this.rpc?.respond(id,{decision:'decline'});}
    this.pendingApprovals.clear();
  }
  async steer(text,signal) {
    invariant(this.turnId&&!this.finished,'Codex has no active turn yet',409);
    this.invalidateApprovals();
    return this.rpc.request('turn/steer',{threadId:this.threadId,expectedTurnId:this.turnId,input:[{type:'text',text}]},signal);
  }
  interrupt() {
    if(!this.turnId||this.finished)return Promise.resolve();
    this.invalidateApprovals();
    return this.rpc.request('turn/interrupt',{threadId:this.threadId,turnId:this.turnId},undefined,1500);
  }
  close() {this.closed=true;this.invalidateApprovals();clearTimeout(this.timer);clearTimeout(this.abortTimer);this.rpc?.close();}
}
