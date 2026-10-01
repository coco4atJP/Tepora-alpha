import {workspaceFingerprint} from './workspace.mjs';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {invariant,text,workspacePath,safeError} from './policy.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
/** Declarative acceptance checks are data, not executable test strings. */
export function validateChecks(checks=[]) {
  invariant(Array.isArray(checks)&&checks.length<=16,'At most 16 acceptance checks');
  return checks.map(c=>{
    invariant(c&&typeof c==='object'&&!Array.isArray(c),'Invalid acceptance check');
    invariant(['file','json','artifact','command'].includes(c.type),'Unknown acceptance check');
    const out={type:c.type,label:text(c.label||c.type,'check label',200)};
    if(['file','json'].includes(c.type)) {
      out.path=text(c.path,'path',500);
      invariant(!path.isAbsolute(out.path)&&!out.path.includes('\\')&&!out.path.includes(':')&&!out.path.split('/').includes('..'),'Check must stay in this workspace');
    }
    if(c.type==='artifact'){if(c.any===true&&!c.title)out.any=true;else out.title=text(c.title,'artifact title',160);}
    if(c.type==='command'){
      out.executable=text(c.executable,'executable',2000);
      invariant(Array.isArray(c.args)&&c.args.length<=50&&c.args.every(a=>typeof a==='string'&&a.length<=2000),'Invalid command arguments');out.args=[...c.args];
    }
    if(c.contains!==undefined)out.contains=text(c.contains,'expected content',4000);
    if(c.keys!==undefined){invariant(Array.isArray(c.keys)&&c.keys.length<=30&&c.keys.every(k=>typeof k==='string'&&k.length<=100),'Invalid JSON keys');out.keys=[...c.keys];}
    return out;
  });
}
export async function verifyJob(store,job) {
  const checks=validateChecks(job.checks||[]),results=[];
  for(const check of checks){
    try{
      let data,version=null;
      if(check.type==='file'||check.type==='json'){
        const file=await workspacePath(path.join(store.dir,'workspace','tasks',job.id),check.path);
        const info=await stat(file);invariant(info.isFile()&&info.size>0&&info.size<=2_000_000,'File missing, empty or exceeds validation budget');
        data=await readFile(file);
        if(check.type==='json'){
          const parsed=JSON.parse(data.toString('utf8'));
          for(const key of check.keys||[])invariant(parsed!==null&&typeof parsed==='object'&&Object.hasOwn(parsed,key),`JSON key missing: ${key}`);
        }
      }else if(check.type==='artifact'){
        const a=store.list('artifact').find(a=>a.jobId===job.id&&(check.any||a.title===check.title));
        invariant(a&&a.content.trim(),'Required artifact is missing');data=Buffer.from(a.content);version=a.version;
      }else{
        // A matching successful command receipt is required; this check never starts a process.
        const receipts=store.list('effect').filter(e=>e.jobId===job.id&&e.revision===job.revision&&e.name==='run_command'&&e.status==='succeeded'&&
          e.args.executable===check.executable&&JSON.stringify(e.args.args)===JSON.stringify(check.args));
        invariant(receipts.some(e=>e.result?.exitCode===0),'No matching successful command receipt for current task revision');
        const fingerprint=await workspaceFingerprint(store,job.id);
        const receipt=receipts.find(e=>e.result?.workspaceFingerprint===fingerprint);
        invariant(receipt,'Workspace changed after the test; rerun the command');
        results.push({...check,passed:true,receiptId:receipt.id,scope:'Current source snapshot; .git, node_modules, .venv, __pycache__, target, and .cache are excluded. Dependency/environment changes need separate validation.'});continue;
      }
      if(check.contains)invariant(data.toString('utf8').includes(check.contains),'Expected content is missing');
      results.push({...check,passed:true,sha256:sha(data),version});
    }catch(e){results.push({...check,passed:false,error:safeError(e)});}
  }
  return {status:checks.length?(results.every(r=>r.passed)?'checks-passed':'checks-failed'):'not-specified',
    passed:checks.length>0&&results.every(r=>r.passed),results,checkedAt:new Date().toISOString(),revision:job.revision,
    note:'These explicit checks are not proof of every requirement or a model-judged quality score.'};
}
