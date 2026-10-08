import {nativeCore} from '../native-state.mjs';
import {NOTICE} from './prompts.mjs';
import {oneLine} from '../tools/format.mjs';

/** Mechanical effect host. Admission, timers and turn phases belong to Rust;
 * these maps contain only native lease-associated JS handles. */
export class RuntimeHost {
 constructor(rt){this.rt=rt;this.core=new nativeCore.RuntimeCore();this.timerTokens=new Map();this.leases=new Map();this.pending=new Set();this.resourcesClosed=false;this.events=[];this.dispatching=false;}
 facts(){
  const rt=this.rt,nowMs=rt.clock();
  return {nowMs,settings:rt.settings(),dailyCost:rt.store.value('agent-usage:'+new Date(nowMs).toISOString().slice(0,10))?.cost||0,
   decisionAvailable:rt.decisions.available(),hasHooks:!!rt.tools.hooks.length,
   sessions:rt.sessions.list().map(session=>{const tail=rt.sessions.tail(session.id,12);return {session,tail,pending:rt.sessions.pending(session.id),lastAtMs:Date.parse(tail.at(-1)?.at)||0};})};
 }
 query(operation,payload){return JSON.parse(this.core.query(operation,JSON.stringify(payload)));}
 dispatch(event){
  if(this.resourcesClosed)return {actions:[],commands:[],closed:true,draining:0,complete:true};
  this.events.push(event);
  if(this.dispatching)return {queued:true};
  this.dispatching=true;let first;
  try{
   // Storage listeners can synchronously call stop/resume/wake. Process them
   // only after the current native action batch is fully reflected in storage.
   // Command effects start in microtasks, after this entire FIFO is drained.
   while(this.events.length&&!this.resourcesClosed){
    const next=this.events.shift(),response=JSON.parse(this.core.dispatch(JSON.stringify(next),JSON.stringify(this.facts())));
    first??=response;this.rt.closed=response.closed;
    for(const action of response.actions||[])this.action(action);
    for(const command of response.commands||[])this.command(command);
   }
   return first;
  }finally{this.dispatching=false;if(this.resourcesClosed)this.events.length=0;}
 }
 state(id){return JSON.parse(this.core.state(id));}
 action(a){
  const rt=this.rt,id=a.sessionId,run=rt.runs.get(id);
  // Epoch-tagged continuation effects cannot mutate a replacement lease.
  if(a.runEpoch!==undefined&&!['createRun','releaseRun','abortRun'].includes(a.kind)){const state=this.state(id);if(run?.runEpoch!==a.runEpoch||state.epoch!==a.runEpoch||state.draining)return;}
  switch(a.kind){
   case 'createRun':{
    const controller=new AbortController();let resolve;
    const promise=new Promise(done=>{resolve=done;});
    const handle={kind:a.sessionKind||rt.sessions.get(id)?.kind,leaseKind:a.leaseKind,runEpoch:a.runEpoch,controller,promise,resolve};
    this.leases.set(id+':'+a.runEpoch,handle);rt.runs.set(id,handle);break;
   }
   case 'releaseRun':{const key=id+':'+a.runEpoch,lease=this.leases.get(key);this.leases.delete(key);if(run?.runEpoch===a.runEpoch)rt.runs.delete(id);lease?.resolve();break;}
   case 'refreshPrompt':rt.loop.update(rt.sessions.get(id));break;
   case 'updateSession':rt.sessions.update(id,{...a.patch,...(a.retryAtMs!==undefined?{retryAt:a.retryAtMs===null?null:new Date(a.retryAtMs).toISOString()}:{})});break;
   case 'cancelTimer':clearTimeout(rt.timers.get(id));rt.timers.delete(id);this.timerTokens.delete(id);break;
   case 'armTimer':{
    clearTimeout(rt.timers.get(id));this.timerTokens.set(id,a.timerToken);
    const t=setTimeout(()=>{
     if(rt.closed)return;
     if(this.timerTokens.get(id)===a.timerToken){rt.timers.delete(id);this.timerTokens.delete(id);}
     this.dispatch({type:'timerFired',sessionId:id,timerToken:a.timerToken});
    },Math.max(0,a.deadlineMs-rt.clock()));t.unref?.();rt.timers.set(id,t);break;
   }
   case 'abortRun':if(run?.runEpoch===a.runEpoch){run.controller.abort(Object.assign(new Error(a.reason||'Stopped'),{stopped:true}));rt.streamEnd(id,{discard:true});}break;
   case 'stopResources':run?.controller.abort(Object.assign(new Error(a.reason||'Stopped'),{stopped:true}));rt.streamEnd(id,{discard:true});rt.processes.killSession(id);rt.policy.cancel(id);rt.computer?.release(id);break;
   case 'cancelAllApprovals':rt.policy.cancelAll();break;
   case 'shutdownSchedulers':for(const r of rt.runs.values())r.controller.abort(Object.assign(new Error('Service closing'),{stopped:true}));clearInterval(rt.heartbeatTimer);clearInterval(rt.idleTimer);clearInterval(rt.dreamTimer);rt.scheduler.close();break;
   case 'closeResources':if(!this.resourcesClosed){this.resourcesClosed=true;rt.processes.close();rt.mcp.close();rt.policy.cancelAll();rt.store.listeners.delete(rt.entryListener);}break;
   case 'appendNotice':rt.sessions.append(id,'notice',{text:a.text});break;
   case 'notice':rt.sessions.append(id,'notice',{text:NOTICE[a.notice](...(a.args||[]))});break;
   case 'event':rt.event(id,a.event,a.data);break;
   case 'progress':rt.progress(id);break;
   case 'reply':rt.reply(id,a.text);break;
   case 'finish':rt.finish(id,a.text,{status:a.status,atMs:a.atMs});break;
   case 'dreamRecord':rt.dreamer.record(id,a.recordKind||'completion',a.data);break;
   default:throw new Error('Unknown Rust runtime action: '+a.kind);
  }
 }
 command(c){
  const rt=this.rt,run=rt.runs.get(c.sessionId);
  const promise=Promise.resolve().then(()=>{
   const state=this.state(c.sessionId);
   if(!run||run.runEpoch!==c.runEpoch||state.epoch!==c.runEpoch||state.draining||rt.runs.get(c.sessionId)!==run||run.controller.signal.aborted)throw run?.controller.signal.reason||new Error('Stale runtime lease');
   return this.effect(c,run);
  }).then(value=>({type:'resolved',value}),error=>({type:'rejected',error})).then(result=>{
   let event;
   try{event=JSON.parse(JSON.stringify(result.type==='resolved'?{type:'resolved',value:result.value??null}:{type:'rejected',error:{message:oneLine(result.error?.stack||result.error,600)}}));}
   catch{event={type:'rejected',error:{message:'Host runtime effect returned an invalid JSON value'}};}
   return this.dispatch({...event,sessionId:c.sessionId,runEpoch:c.runEpoch,operationId:c.operationId});
  });
  this.pending.add(promise);promise.finally(()=>this.pending.delete(promise)).catch(error=>{if(!rt.closed)rt.event(c.sessionId,'crash',{message:String(error?.message||error).slice(0,600)});});
 }
 async effect(c,run){
  const rt=this.rt,id=c.sessionId,signal=run.controller.signal;
  switch(c.kind){
   case 'deliver':return {delivered:rt.deliver(id)};
   case 'step':return rt.loop.step(id,signal);
   case 'probeFiles':return rt.probeClaimedFiles(c.session,c.report);
   case 'turnEndHook':{const value=await rt.tools.hook('turnEnd',{session:c.session,text:c.text});return typeof value?.continue==='string'?{continue:value.continue}:{};}
   case 'completionContext':return rt.completionContext(c.session,c.report);
   case 'completionDecision':return rt.decisions.yes(c.state,c.q.text,signal);
   case 'mainTurn':return {delegated:await rt.delegated(id,c.text,signal)};
   case 'yield':return new Promise(resolve=>{const t=setTimeout(()=>resolve(null),0);t.unref?.();});
   case 'idleCompact':{
    const session=rt.loop.prompt(rt.sessions.get(id)),toolDefs=rt.tools.definitions(session.tools),b=await rt.loop.budget(session,toolDefs,signal);
    signal.throwIfAborted();if(!b.chain.length||b.B<1200)return null;
    const built=rt.assembler.build(id,{system:session.system});
    if(rt.compactor.plan(built,b.B,b.ratio,{idle:true}).action!=='compact')return null;
    await rt.loop.compact(session,{built,B:b.B,ratio:b.ratio,toolDefs,chain:b.chain,signal,reason:'idle'});return null;
   }
   default:throw new Error('Unknown Rust runtime command: '+c.kind);
  }
 }
 async drain(){while(this.pending.size)await Promise.allSettled([...this.pending]);}
}
