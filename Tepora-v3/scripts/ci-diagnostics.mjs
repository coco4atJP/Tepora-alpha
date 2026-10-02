import path from 'node:path';
import {mkdirSync,appendFileSync} from 'node:fs';
// Opt-in CI observation only. No test filtering, forced exit or resource teardown.
const entry=process.argv[1];
if(entry&&/\.test\.[cm]?js$/.test(entry)){
 const file=path.relative(process.cwd(),entry),started=Date.now();
 const folder=path.resolve('validation/test-diagnostics');mkdirSync(folder,{recursive:true});
 const log=path.join(folder,`${path.basename(entry)}-${process.pid}.jsonl`);
 const report=(event,extra={})=>{
  const line=JSON.stringify({event,file,pid:process.pid,elapsedMs:Date.now()-started,
   node:process.version,platform:process.platform,resources:process.getActiveResourcesInfo(),...extra});
  appendFileSync(log,line+'\n');console.error('[test-worker] '+line);
 };
 report('start');
 const timer=setInterval(()=>report('still-running'),30000);timer.unref();
 process.once('beforeExit',()=>{clearInterval(timer);report('before-exit');});
 process.once('exit',code=>report('exit',{code}));
}
