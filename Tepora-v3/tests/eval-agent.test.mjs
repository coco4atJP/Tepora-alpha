import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {scriptedModel} from './helpers/scripted-model.mjs';
import {evaluateChecks} from '../scripts/eval-checks.mjs';

test('a retained artifact from a previous evaluation cannot pass the current case',async()=>{
 const c={checks:[{type:'artifact',title:'Memo',contains:'revised',minVersion:2}]};
 const old={title:'Memo',content:'revised',version:2,sessionId:'old'};
 assert.equal((await evaluateChecks(c,'/unused',{list:()=>[old]},[],'current'))[0].ok,false);
 assert.equal((await evaluateChecks(c,'/unused',{list:()=>[{...old,sessionId:'current'}]},[],'current'))[0].ok,true);
 assert.equal((await evaluateChecks(c,'/unused',{list:()=>[{...old,version:1,sessionId:'current'}]},[],'current'))[0].ok,false);
});

test('required execution evidence rejects failed, interrupted and undispatched tools',async()=>{
 const c={checks:[{type:'tool',name:'exec',exitCode:0}]};
 const good={type:'tool',name:'exec',data:{exitCode:0}};
 for(const patch of [{error:true},{interrupted:true},{notExecuted:true},{data:{exitCode:1}}])
  assert.equal((await evaluateChecks(c,'/unused',{},[{...good,...patch}]))[0].ok,false);
 assert.equal((await evaluateChecks(c,'/unused',{},[good]))[0].ok,true);
});

async function evaluate(t,content,extra=[]){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-eval-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const model=await scriptedModel(body=>body.messages.some(m=>m.role==='tool')?{content:'完了しました。'}:{calls:[{name:'write',args:{path:'result.json',content:JSON.stringify(content)}}]},{context:16384});
 t.after(()=>model.close());
 const report=path.join(dir,'report.json');
 const child=spawn(process.execPath,['scripts/eval-agent.mjs','--run','--url',model.url,'--model','local-fixture','--cases','structured-japanese','--timeout','10','--context','16384','--state',dir,'--out',report,...extra],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const timer=setTimeout(()=>child.kill('SIGTERM'),20000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(timer));
 let result=null;try{result=JSON.parse(await readFile(report,'utf8'));}catch{}
 return {code,result,output};
}

test('eval rejects wrong JSON values and returns a failing process status',async t=>{
 const r=await evaluate(t,{title:'引き継ぎ',steps:[],uncertain:false});
 assert.equal(r.code,1,r.output);assert.equal(r.result.passed,0);assert.equal(r.result.total,1);
});

test('eval accepts the requested JSON values and array size',async t=>{
 const r=await evaluate(t,{title:'引き継ぎ',steps:['調査','修正','確認'],uncertain:true});
 assert.equal(r.code,0,r.output);assert.equal(r.result.passed,1);
});

for(const extra of [['--cases','missing-case'],['--repeat','0'],['--rounds','NaN'],['--timeout','-1']])test(`eval refuses an empty or invalid run: ${extra.join(' ')}`,async t=>{
 const r=await evaluate(t,{},extra);assert.notEqual(r.code,0,r.output);assert.equal(r.result,null);
});
