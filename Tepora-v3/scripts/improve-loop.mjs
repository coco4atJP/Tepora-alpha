#!/usr/bin/env node
/** Change -> verify -> evidence. No automatic code mutation or pretend improvement count.
 * --watch rechecks only when source bytes change. --browser adds optional Playwright checks.
 * A model/provider is never called implicitly; live model evals remain an explicit separate step.
 */
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),outFlag=args.indexOf('--out');
const out=path.resolve(outFlag>=0?args[outFlag+1]||'validation/loop':path.join(root,'validation/loop'));
const watch=args.includes('--watch'),browser=args.includes('--browser'),computer=args.includes('--computer'),capabilities=args.includes('--capabilities');
const ignored=new Set(['.git','node_modules','target','binaries','resources','icons','gen','__pycache__','validation','native']);
const roots=['core','web','workers','speech','tests','scripts','spec','docs','ci','desktop','native-core'];
let closing=false,child=null;
async function fingerprint(){
 const entries=[];
 async function walk(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(ignored.has(e.name)||e.isSymbolicLink())continue;const f=path.join(dir,e.name);
  if(e.isDirectory())await walk(f);else if(e.isFile()&&!e.name.endsWith('.pyc'))entries.push([path.relative(root,f),await readFile(f)]);
 }}
 for(const r of roots)await walk(path.join(root,r));
 for(const f of ['package.json','README.md'])entries.push([f,await readFile(path.join(root,f))]);
 const hash=createHash('sha256');for(const [name,bytes]of entries)hash.update(name+'\0'+bytes.length+'\0').update(bytes);
 return hash.digest('hex');
}
async function command(name,executable,argv,folder){
 const log=createWriteStream(path.join(folder,name+'.log')),start=Date.now();
 const result=await new Promise(resolve=>{
  const processChild=spawn(executable,argv,{cwd:root,shell:false,env:process.env,stdio:['ignore','pipe','pipe']});child=processChild;
  let killTimer=null;
  let finished=false;const done=(code,error=null)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);resolve({name,code,error,ms:Date.now()-start});};
  const timer=setTimeout(()=>{processChild.kill('SIGTERM');killTimer=setTimeout(()=>processChild.kill('SIGKILL'),1500);killTimer.unref();},180000);
  processChild.stdout.pipe(log,{end:false});processChild.stderr.pipe(log,{end:false});
  processChild.once('error',e=>done(1,e.message));processChild.once('close',code=>done(code??1));
 });
 await new Promise(r=>log.end(r));child=null;return result;
}
async function verify(before){
 const folder=path.join(out,before.slice(0,12)+'-'+Date.now());await mkdir(folder,{recursive:true});
 const python=process.env.PYTHON|| (process.platform==='win32'?'python':'python3');
 const steps=[['rust-build',process.execPath,['scripts/build-core.mjs']],['rust-tests',process.env.CARGO||'cargo',['test','--locked','--no-default-features','--manifest-path','native-core/Cargo.toml']],['syntax',process.execPath,['scripts/check.mjs']],['node-tests',process.execPath,process.platform==='win32'?['--import','./scripts/ci-diagnostics.mjs','--test','--test-timeout=120000']:['--test']],
  ['worker-contracts',python,['-I','-S','-m','unittest','discover','-s','workers','-p','test_*.py','-v']],
  ['scenario-traceability',process.execPath,['scripts/verify-scenarios.mjs',folder]],['preview-build',process.execPath,['scripts/build-preview.mjs']]];
 if(browser){steps.push(['browser-first-use',python,['tests/browser-first-use.py',root,path.join(folder,'browser')]]);steps.push(['browser-routing',python,['tests/browser-routing.py',root,path.join(folder,'routing-ui')]]);steps.push(['browser-lamp',python,['tests/browser-lamp.py',root,path.join(folder,'lamp')]]);steps.push(['browser-avatar',python,['tests/browser-avatar.py',root,path.join(folder,'avatar')]]);}
 if(browser)steps.push(['browser-abilities',python,['tests/browser-capabilities.py',root,path.join(folder,'abilities-ui')]]);
 if(browser)steps.push(['browser-ability-components',python,['tests/browser-capability-components.py',root,path.join(folder,'ability-components')]]);
 if(capabilities)steps.push(['capability-live',process.execPath,['scripts/check-capabilities.mjs',path.join(folder,'capability-live')]]);
 if(computer)steps.push(['computer-live',process.execPath,['scripts/check-computer.mjs',path.join(folder,'computer-live')]]);
 const results=[];for(const [name,exe,argv]of steps){if(closing)break;console.log(`Checking ${name} …`);const result=await command(name,exe,argv,folder);results.push(result);if(result.code!==0)break;}
 const after=await fingerprint(),passed=!closing&&before===after&&results.length===steps.length&&results.every(r=>r.code===0);
 const report={sourceBefore:before,sourceAfter:after,passed,stable:before===after,results,
  realModel:false,browser:browser?'requested':'not-run',computer:computer?'requested-real-worker-with-model-fixtures':'not-run',capabilities:capabilities?'actual-harness-and-local-HTTP-with-model-fixtures':'not-run',sourceModifiedByThisScript:false,
  note:'A passing regression gate is not proof of autonomous improvement or real-model task quality.',finishedAt:new Date().toISOString()};
 await writeFile(path.join(folder,'result.json'),JSON.stringify(report,null,2));await writeFile(path.join(out,'latest.json'),JSON.stringify({...report,folder},null,2));
 console.log(`${passed?'PASS':'STOP'} — ${folder}`);return report;
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{closing=true;child?.kill('SIGTERM');});
await mkdir(out,{recursive:true});
let checked=null,failed=false;
do{
 const current=await fingerprint();
 if(current!==checked){checked=current;const result=await verify(current);failed=!result.passed;if(!watch)break;}
 if(watch&&!closing)await new Promise(r=>setTimeout(r,1000));
}while(watch&&!closing);
if(failed)process.exitCode=1;
