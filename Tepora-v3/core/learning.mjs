import {randomUUID} from 'node:crypto';
import {text,invariant} from './policy.mjs';
/** Learned procedures are proposals with provenance, never self-installed privileges. */
export function proposeSkill(store,{jobId,name,description,content}) {
  const job=store.get('job',jobId);invariant(job,'Source task not found',404);
  invariant(job.status==='completed'||job.status==='review','Finish a concrete task before proposing a reusable skill',409);
  const sourceEffects=store.list('effect').filter(e=>e.jobId===jobId&&e.status==='succeeded').map(e=>e.id);
  const d={id:randomUUID(),name:text(name,'name',100),description:text(description,'description',300),content:text(content,'skill',32000),
    enabled:false,source:'learned-proposal',sourceJobId:jobId,sourceEffects,validation:'user-review-required',createdAt:new Date().toISOString()};
  store.put('skill',d);store.emit('skill.updated',d);return d;
}
