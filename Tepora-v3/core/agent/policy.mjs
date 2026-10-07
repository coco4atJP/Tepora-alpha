import {randomUUID} from 'node:crypto';
import {invariant} from '../policy.mjs';

/** Rules decide allow / ask / deny per tool call. Everything is allowed unless the user adds a rule.
 * An "ask" pauses only that session's call; every other session keeps working. */
export function validateRules(rules){
 invariant(Array.isArray(rules)&&rules.length<=100,'At most 100 rules');
 return rules.map(r=>{
  invariant(r&&typeof r.tool==='string'&&/^[\w:*/.-]{1,120}$/.test(r.tool),'Each rule needs a tool name or "*"');
  invariant(['allow','ask','deny'].includes(r.action),'Rule action must be allow, ask or deny');
  if(r.match!==undefined){invariant(typeof r.match==='string'&&r.match.length<=500,'Invalid match');new RegExp(r.match);}
  return {tool:r.tool,action:r.action,...(r.match?{match:r.match}:{}),...(r.note?{note:String(r.note).slice(0,200)}:{})};
 });
}
export class Policy{
 constructor(runtime){this.rt=runtime;this.pending=new Map();
  for(const a of runtime.store.list('approval'))if(a.status==='pending')runtime.store.put('approval',{...a,status:'withdrawn',decidedAt:new Date().toISOString()});}
 rule(name,args){
  const json=JSON.stringify(args||{});
  return (this.rt.settings().policy.rules||[]).find(r=>(r.tool==='*'||r.tool===name||r.tool.endsWith('*')&&name.startsWith(r.tool.slice(0,-1)))&&(!r.match||new RegExp(r.match,'i').test(json)))||null;
 }
 async check(session,name,args,{signal}={}){
  const r=this.rule(name,args);if(!r||r.action==='allow')return 'allow';if(r.action==='deny')return 'deny';
  const id=randomUUID(),doc={id,sessionId:session.id,sessionTitle:session.title,tool:name,args,note:r.note||'',status:'pending',createdAt:new Date().toISOString()};
  this.rt.store.put('approval',doc);this.rt.store.emit('approval.updated',doc);
  const before=this.rt.sessions.get(session.id)?.note||'';this.rt.sessions.update(session.id,{note:`承認待ち: ${name}`});
  const allowed=await new Promise(resolve=>this.pending.set(id,{sessionId:session.id,resolve}));
  if(!signal?.aborted)this.rt.sessions.update(session.id,{note:before});
  return allowed?'allow':'declined';
 }
 decide(id,allow){
  invariant(typeof allow==='boolean','allow must be true or false');
  const p=this.pending.get(id),doc=this.rt.store.get('approval',id);invariant(p&&doc?.status==='pending','この承認はもう待っていません。',409);
  this.pending.delete(id);const next={...doc,status:allow?'approved':'denied',decidedAt:new Date().toISOString()};
  this.rt.store.put('approval',next);this.rt.store.emit('approval.updated',next);p.resolve(allow);return next;
 }
 list(){return this.rt.store.list('approval').slice(0,200);}
 cancel(sessionId){for(const [id,p] of this.pending)if(p.sessionId===sessionId){this.pending.delete(id);const d=this.rt.store.get('approval',id);if(d){this.rt.store.put('approval',{...d,status:'withdrawn'});this.rt.store.emit('approval.updated',{...d,status:'withdrawn'});}p.resolve(false);}}
 cancelAll(){for(const p of this.pending.values())p.resolve(false);this.pending.clear();}
}
