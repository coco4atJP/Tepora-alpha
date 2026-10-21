import path from 'node:path';

/** Cleanup owns a fresh deadline: a cancelled case must not retain its policy. */
export async function policyScope(setPolicy,policy,baseline,run){
 try{await setPolicy(policy);return await run();}
 finally{await setPolicy(baseline,AbortSignal.timeout(20000));}
}

export function benchmarkGuard(meter,first,waitingNote=''){
 if(first===undefined)return;
 if(meter.blockedReason)throw Object.assign(Error(meter.blockedReason),{blocked:true});
 const rejected=meter.calls.slice(first).find(c=>[401,402,403,429].includes(c.status));
 if(rejected)throw Object.assign(Error(`Provider HTTP ${rejected.status}: ${rejected.providerError||'request rejected'}`),{blocked:true});
 if(/HTTP (?:401|402|403|429)|budget exhausted|接続先|使える接続先/i.test(waitingNote))throw Object.assign(Error(waitingNote),{blocked:true});
}

/** Completing an input subgoal is distinct from completing a reservation. */
export function blockedComputerOutcome(tools,confirmation,receipt,result){
 const submissions=tools.filter(t=>t.args?.checks?.some(c=>c.text_includes===confirmation));
 return submissions.length>0&&submissions.some(t=>t.data?.status==='blocked')&&
  submissions.every(t=>!['completed','model_completed'].includes(t.data?.status))&&
  receipt===null&&/操作不可|送信でき|予約でき|blocked|cannot|unable/i.test(String(result));
}

/** A delegate may be instructed to save in its own folder or the parent folder.
 * Require the delegate's successful write + read, not merely a matching file. */
export function delegationFileTarget({worker,mainEntries,parentCwd,file,expected}){
 if(worker.session?.kind==='main'||worker.session?.status!=='done'||!worker.session?.cwd||file!==path.basename(file))return null;
 const childCwd=worker.session.cwd,allowed=new Set([path.resolve(childCwd,file),path.resolve(parentCwd,file)]);
 const ok=e=>e.type==='tool'&&!e.error&&!String(e.content).startsWith('Error:');
 const target=(e,cwd)=>typeof e.args?.path==='string'?path.resolve(cwd,e.args.path):null;
 for(const e of worker.entries){
  if(!ok(e)||e.name!=='write'||String(e.args?.content).trim()!==expected)continue;
  const dest=target(e,childCwd);if(!allowed.has(dest))continue;
  if(!worker.entries.some(r=>ok(r)&&r.name==='read'&&target(r,childCwd)===dest))continue;
  if(mainEntries.some(r=>ok(r)&&(['write','edit'].includes(r.name)&&target(r,parentCwd)===dest||r.name==='exec')))continue;
  return dest;
 }
 return null;
}
