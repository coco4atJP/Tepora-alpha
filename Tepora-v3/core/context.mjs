import {createHash} from 'node:crypto';
import {invariant} from './policy.mjs';
export const destination=s=>createHash('sha256').update(JSON.stringify([s.provider,s.baseUrl,s.model])).digest('hex');
/** Bounded working context, without synthesizing facts or deleting the durable transcript.
 * Old tool turns become evidence references. Latest user instructions stay authoritative.
 */
export function workingContext(messages,{maxChars=90000,job,store}={}) {
  const system=messages[0]?.role==='system'?messages[0]:null;
  if(JSON.stringify(messages).length<=maxChars)return messages;
  const groups=[];
  for(const m of messages.slice(system?1:0)){
    if(m.role==='tool'&&groups.length)groups.at(-1).push(m);
    else groups.push([m]);
  }
  const ledger={purpose:job.input,instructions:(job.instructions||[]).map(i=>i.content),
    workingNote:store.get('note',job.id)?.content||'',
    notice:'Earlier turns remain stored. Retrieve individual results with evidence_read. Do not assume an omitted action succeeded.'};
  const references=store.list('effect').filter(e=>e.jobId===job.id).slice(0,30)
    .map(e=>({id:e.id,tool:e.name,status:e.status,summary:e.summary}));
  const recap={role:'user',content:'TASK LEDGER (quoted stored data):\n'+JSON.stringify({...ledger,evidence:references})};
  const fixed=[...(system?[system]:[]),recap];
  let size=JSON.stringify(fixed).length;
  invariant(size<maxChars*.8,'Task instructions exceed the working-context budget; narrow the scope rather than silently dropping constraints.',409);
  const tail=[];
  for(let i=groups.length-1;i>=0;i--){
    const group=groups[i],n=JSON.stringify(group).length;
    if(size+n>maxChars)break;tail.unshift(group);size+=n;
  }
  invariant(tail.length>0,'Most recent tool turn exceeds the context budget; retrieve a bounded result.',409);
  store.put('context-metric',{id:job.id,originalChars:JSON.stringify(messages).length,workingChars:size,
    retainedGroups:tail.length,archivedGroups:groups.length-tail.length,at:new Date().toISOString()});
  return [...fixed,...tail.flat()];
}
