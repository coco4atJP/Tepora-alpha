import {verifyJob} from './verification.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {text,invariant} from './policy.mjs';
import {validateChecks} from './verification.mjs';
import {destination} from './context.mjs';
export function validatePlan(input) {
  invariant(input&&Array.isArray(input.nodes)&&input.nodes.length>0&&input.nodes.length<=12,'A plan needs 1–12 stages');
  const seen=new Set();
  const nodes=input.nodes.map(n=>{
    invariant(n&&typeof n.key==='string'&&/^[a-zA-Z][\w-]{0,31}$/.test(n.key)&&!seen.has(n.key),'Invalid or duplicate stage key');seen.add(n.key);
    invariant(!n.engine||['builtin','codex'].includes(n.engine),'Unknown execution engine');
    const dependencies=n.dependsOn||[];invariant(Array.isArray(dependencies)&&dependencies.length<=12&&dependencies.every(d=>typeof d==='string'),'Invalid dependencies');
    return {key:n.key,title:text(n.title||n.key,'stage title',120),input:text(n.input),dependsOn:[...new Set(dependencies)],
      engine:n.engine||'builtin',checks:validateChecks(n.checks),gate:n.gate==='accepted'?'accepted':n.gate==='checked'?'checked':'produced'};
  });
  for(const n of nodes)for(const d of n.dependsOn)invariant(seen.has(d)&&d!==n.key,'Missing or self-dependent stage');
  const visiting=new Set(),visited=new Set();
  const visit=key=>{invariant(!visiting.has(key),'Dependency cycle');if(visited.has(key))return;visiting.add(key);for(const d of nodes.find(n=>n.key===key).dependsOn)visit(d);visiting.delete(key);visited.add(key);};
  for(const n of nodes)visit(n.key);
  return {title:text(input.title,'plan title',160),nodes};
}
const jid=(id,key)=>'plan-'+createHash('sha256').update(`${id}:${key}`).digest('hex').slice(0,40);
export class Plans {
  constructor(store,harness){Object.assign(this,{store,harness});this.ticking=false;this.queued=false;
    this.listener=e=>{if(e.type==='job.updated'&&!this.queued){this.queued=true;queueMicrotask(()=>{this.queued=false;this.tick().catch(()=>{});});}};
    store.listeners.add(this.listener);
  }
  create(input){const p={...validatePlan(input),id:randomUUID(),status:'proposed',revision:1,createdAt:new Date().toISOString(),jobs:{}};this.persist(p);return p;}
  activate(id,revision){
    const p=this.store.get('plan',id);invariant(p&&p.revision===revision,'Plan changed or missing',409);
    invariant(['proposed','paused','needs-consent'].includes(p.status),'Plan cannot start in this state',409);
    Object.assign(p,validatePlan(p));
    if(p.nodes.some(n=>n.engine==='codex'))invariant(this.store.settings.codexEnabled,'Enable the Codex adapter explicitly first',403);
    p.status='running';p.revision++;p.runtime=structuredClone(this.store.settings);p.routeSnapshot=this.harness.registry?.configured?this.harness.registry.pin('work'):null;p.destination=p.routeSnapshot?.id||destination(p.runtime);p.consentEpoch=this.store.value('consent-epoch')||0;
    this.persist(p);this.tick().catch(()=>{});return this.store.get('plan',id);
  }
  pause(id){const p=this.store.get('plan',id);invariant(p,'Plan not found',404);p.status='paused';p.revision++;this.persist(p);
    for(const id of Object.values(p.jobs))if(['queued','running','waiting_approval'].includes(this.store.get('job',id)?.status))this.harness.pause(id);return p;}
  async tick(){
    if(this.closed||this.ticking||this.store.closed)return;this.ticking=true;
    try{for(const p of this.store.list('plan')){
      if(p.status!=='running')continue;
      if(p.destination!==(this.harness.registry?.configured?this.harness.registry.pin('work').id:destination(this.store.settings))||p.consentEpoch!==(this.store.value('consent-epoch')||0)){p.status='needs-consent';this.persist(p);continue;}
      let changed=false;
      for(const n of p.nodes){
        if(p.jobs[n.key])continue;
        const dependencies=n.dependsOn.map(key=>this.store.get('job',p.jobs[key]));
        for(let i=0;i<dependencies.length;i++){const job=dependencies[i],parent=p.nodes.find(x=>x.key===n.dependsOn[i]);
          if(parent.gate==='checked'&&['review','completed'].includes(job?.status)){
            const checks=await verifyJob(this.store,job);job.verification={...job.verification,checks};
          }
        }
        if(this.store.get('plan',p.id)?.revision!==p.revision)break;
        const ready=dependencies.every((job,i)=>{
          const parent=p.nodes.find(x=>x.key===n.dependsOn[i]);
          if(parent.gate==='accepted')return job?.status==='completed';
          if(parent.gate==='checked')return ['review','completed'].includes(job?.status)&&job.verification?.checks?.passed===true;
          return ['review','completed'].includes(job?.status)&&job.verification?.checks?.status!=='checks-failed';
        });
        if(!ready)continue;
        const id=jid(p.id,n.key);
        const existing=this.store.get('job',id);
        if(!existing){
          try{this.harness.submit(n.input,'work',{id,engine:n.engine,runtime:p.runtime,routeSnapshot:p.routeSnapshot,planId:p.id,
            dependencies:dependencies.map(j=>j.id),checks:n.checks,isolated:true,priority:0});}
          catch(e){p.note=String(e.message).slice(0,300);continue;}
        }
        p.jobs[n.key]=id;changed=true;
      }
      const jobs=Object.values(p.jobs).map(id=>this.store.get('job',id));
      if(jobs.length===p.nodes.length&&jobs.every(j=>['review','completed'].includes(j?.status))){p.status='review';changed=true;}
      else if(jobs.some(j=>['failed','interrupted','cancelled','paused','blocked'].includes(j?.status))){p.note='停止・エラーの段階があります。途中の仕事を確認・再開してください。';changed=true;}
      if(changed&&this.store.get('plan',p.id)?.revision===p.revision)this.persist(p);
    }}finally{this.ticking=false;}
  }
  persist(p){this.store.put('plan',p);this.store.emit('plan.updated',p);}
  close(){this.closed=true;this.store.listeners.delete(this.listener);}
}
