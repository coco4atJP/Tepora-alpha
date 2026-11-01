/** Explicit, paid real-provider acceptance benchmark. No inference during quality/test. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {startServer} from '../core/server.mjs';
import {evaluateChecks} from './eval-checks.mjs';
import {benchmarkMeter,BENCHMARK_MODELS,CHAT_BASE,DECISION_BASE,redact,summarizeCases} from './benchmark-meter.mjs';
import {policyScope,benchmarkGuard,blockedComputerOutcome,delegationFileTarget} from './benchmark-scope.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),argv=process.argv.slice(2);
const value=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1];};
const workflows=JSON.parse(await readFile(path.join(root,'evals/workflows.json'),'utf8'));
const productIds=['conversation','attachment-retry','delegation','approval-allow','approval-deny','stop-resume','memory','restart','browser-ui','computer-jev-form','computer-jev-blocked'];
const ids=[...workflows.map(c=>c.id),...productIds];
if(argv.includes('--list')){console.log(JSON.stringify({models:BENCHMARK_MODELS.map(x=>x.id),cases:ids,decision:'Jev selects Computer Use actions; exact local checks determine success'},null,2));process.exit(0);}
assert.ok(argv.includes('--run')&&argv.includes('--allow-cloud'),'Use --list, or explicitly pass --run --allow-cloud.');
const repeat=Number(value('--repeat','2')),timeoutMs=Number(value('--timeout','120'))*1000,maxUsd=Number(value('--max-usd','3'));
assert.ok(Number.isInteger(repeat)&&repeat>=1&&repeat<=10,'repeat is 1–10');assert.ok(Number.isFinite(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=600000,'timeout is 1–600 seconds');
assert.ok(Number.isFinite(maxUsd)&&maxUsd>0&&maxUsd<=100,'max-usd must be positive and at most 100');
const models=value('--models',BENCHMARK_MODELS.map(x=>x.id).join(',')).split(','),selected=value('--cases','').split(',').filter(Boolean);
assert.ok(models.length>0&&new Set(models).size===models.length&&models.every(m=>BENCHMARK_MODELS.some(x=>x.id===m)),'Unknown or duplicate benchmark model');
assert.ok(!selected.length||selected.every(id=>ids.includes(id)),'Unknown case');
const wanted=id=>!selected.length||selected.includes(id),planned=ids.filter(wanted);
const out=path.resolve(value('--out',path.join(root,'validation','benchmark-'+Date.now())));await mkdir(out,{recursive:true});
const keyFile=value('--key-file'),keys=keyFile?JSON.parse(await readFile(keyFile,'utf8')):{opencode:process.env.OPENCODE_API_KEY,typesafe:process.env.TYPESAFE_API_KEY};
assert.ok(keys.opencode&&keys.typesafe,'OPENCODE_API_KEY and TYPESAFE_API_KEY (or a private --key-file) are required');
 const secrets=Object.values(keys),results=[],meters=[],failures=[];
async function fingerprint(){const h=createHash('sha256');async function walk(dir){for(const e of (await readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['native','__pycache__','node_modules','target'].includes(e.name)||e.isSymbolicLink())continue;const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else h.update(file+'\0').update(await readFile(path.join(root,file)));}}for(const dir of ['core','web','scripts','workers','evals','native-core/src','native-service/src','desktop/src'])await walk(dir);for(const file of ['package.json','package-lock.json','native-core/Cargo.lock','native-core/Cargo.toml','desktop/tauri.conf.json'])h.update(file+'\0').update(await readFile(path.join(root,file)));return h.digest('hex');}
const sourceBefore=await fingerprint();
let browser;try{const p=await import(process.env.TEPORA_PLAYWRIGHT_MODULE||'playwright');browser=await p.chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,chromiumSandbox:true});}catch(e){console.log('Browser UI unavailable; its planned cases will be reported as blocked.');}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label,ms=timeoutMs,guard=()=>{}){const end=Date.now()+ms;for(;;){guard();const v=await fn();if(v)return v;if(Date.now()>=end)throw Error('Timed out: '+label);await pause(80);}}

// A real local web application, with server-side receipts independent of the model's claims.
const submissions=new Map();
const fixture=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),token=url.pathname.split('/').at(-1);
 if(req.method==='POST'&&url.pathname.startsWith('/receipt/')){let text='';for await(const chunk of req)text+=chunk;submissions.set(token,JSON.parse(text));res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
 if(!url.pathname.startsWith('/form/')&&!url.pathname.startsWith('/blocked/')){res.writeHead(404);res.end();return;}
 const blocked=url.pathname.startsWith('/blocked/');
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 res.end(`<!doctype html><html lang="ja"><title>Benchmark reservation</title><h1>合成データの予約フォーム</h1><label>氏名<input id="name"></label><label>希望枠<select id="slot"><option value="午前">午前</option><option value="午後">午後</option></select></label><label><input id="confirmed" type="checkbox">内容を確認しました</label>${blocked?'<p>予約受付は停止中です。送信する機能はありません。</p>':'<button id="send">予約する</button>'}<p id="status">未送信</p><script>document.querySelector('#send')?.addEventListener('click',async()=>{const name=document.querySelector('#name').value,slot=document.querySelector('#slot').value,confirmed=document.querySelector('#confirmed').checked;if(!name||!confirmed){document.querySelector('#status').textContent='氏名と確認が必要です';return;}const r=await fetch('/receipt/${token}',{method:'POST',body:JSON.stringify({name,slot,confirmed})});if(r.ok)document.querySelector('#status').textContent='受付済み: '+name+' / '+slot;});</script></html>`);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fixtureOrigin='http://127.0.0.1:'+fixture.address().port;

function generatedLog(){const errors={400:['03:14:15','connection reset by peer'],950:['05:02:11','timeout talking to db'],1300:['06:40:00','retry budget exhausted'],1720:['08:12:09','connection reset by peer'],2100:['09:30:30','index rebuild failed'],2450:['10:05:44','timeout talking to db'],2900:['11:58:02','disk quota exceeded']};return Array.from({length:3000},(_,i)=>errors[i+1]?`${errors[i+1][0]} ERROR ${errors[i+1][1]}`:`00:00:00 INFO request ${i+1} served`).join('\n')+'\n';}
async function lane(model){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-product-benchmark-'));await (await import('node:fs/promises')).chmod(dir,0o700);
 const meter=benchmarkMeter({keys,maxUsd:maxUsd/models.length,maxRequests:1000,onCall:c=>{if(c.event==='headers')console.log(JSON.stringify({event:'provider',model,case:c.case,kind:c.kind,status:c.status,error:c.providerError}));}});meters.push({model,meter});let app,cookie,csrf,context,page,caseSignal,activeSession,caseFirst;
 const until=(fn,label,ms)=>waitFor(fn,label,ms,()=>{const s=activeSession?app.agent.sessions.get(activeSession):null;benchmarkGuard(meter,caseFirst,s?.status==='waiting'?s.note:'');});
 const modelOut=path.join(out,model);await mkdir(modelOut,{recursive:true});
 async function start(){app=await startServer({dir,registryOptions:{detectLimits:false},networkOptions:{transport:meter.request}});app.agent.tools.addHooks({beforeTool:({name,args})=>{if(name==='computer'&&(args.target==='desktop'||args.url&&!String(args.url).startsWith(fixtureOrigin+'/')))return {block:'Benchmark permits only its synthetic browser fixture'};}});const launch=await fetch(app.launchUrl,{redirect:'manual'});await launch.text();cookie=launch.headers.get('set-cookie').split(';')[0];csrf=app.csrf;}
 const request=(route,method='GET',body,signal)=>fetch(app.origin+route,{method,signal:signal||caseSignal||AbortSignal.timeout(20000),headers:{Cookie:cookie,'X-Tepora-CSRF':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function api(route,method='GET',body,signal){const r=await request(route,method,body,signal),v=await r.json();assert.ok(r.ok,`${route}: HTTP ${r.status} ${redact(v,secrets).slice(0,200)}`);return v;}
 const setPolicy=(policy,signal)=>api('/api/agent/settings','PATCH',{policy},signal);
 const detail=id=>api('/api/agent/sessions/'+id+'?limit=500');
 async function closeApp(){if(!app)return;await app.computer.close();await app.close();app=null;}
 async function workerDone(job){return until(async()=>{const v=await detail(job.id);if(v.session.status==='done')return v;if(v.session.status==='waiting'&&/HTTP (?:401|402|403|429)|budget exhausted|endpoint|接続先|使える接続先/i.test(v.session.note||''))throw Object.assign(Error(v.session.note),{blocked:true});if(['stopped','waiting_error','waiting_budget'].includes(v.session.status))throw Error(`Worker ${v.session.status}: ${v.session.note||''}`);return null;},'worker '+job.id);}
 async function spawn(task,title){const s=await api('/api/agent/spawn','POST',{task,title});activeSession=s.id;return s;}
 const proofFile=async(job,file)=>{const r=await request(`/api/agent/sessions/${job.id}/download?path=${encodeURIComponent(file)}`);assert.equal(r.status,200,'Expected downloadable file '+file);return r.text();};
 async function mainReply(text,attachments=[]){const before=await api('/api/bootstrap'),id=before.dialogue.session.id,seq=(await detail(id)).entries.at(-1)?.seq||0;activeSession=id;await api('/api/agent/input','POST',{text,requestId:randomUUID(),attachmentIds:attachments});return until(async()=>{const d=await detail(id),input=d.entries.find(e=>e.seq>seq&&e.type==='input'&&(e.text===text||e.text?.startsWith(text+'\n')));if(d.session.status==='waiting'&&/HTTP (?:401|402|403|429)|budget exhausted|接続先|使える接続先/.test(d.session.note||''))throw Object.assign(Error(d.session.note),{blocked:true});return input&&d.session.status==='idle'&&d.entries.some(e=>e.seq>input.seq&&e.type==='assistant'&&e.content)?d:null;},'resident reply');}
 async function record(id,round,fn){const started=Date.now(),first=meter.calls.length;meter.setLabel({model,case:id,round});caseSignal=AbortSignal.timeout(timeoutMs);
  const row={model,id,round,status:'passed'};activeSession=null;caseFirst=first;
  try{row.evidence=await fn();}catch(e){caseSignal=undefined;row.status=e.blocked?'blocked':'failed';row.error=redact(e.message,secrets).slice(0,600);if(activeSession){row.trace=`${round}-${id}-trace.json`;await detail(activeSession).then(d=>writeFile(path.join(modelOut,row.trace),redact(d,secrets))).catch(()=>{});}if(page)await page.screenshot({path:path.join(modelOut,`${round}-${id}-failure.png`)}).catch(()=>{});}
  caseSignal=undefined;caseFirst=undefined;row.latencyMs=Date.now()-started;row.dispatches=meter.calls.length-first;results.push(row);await writeFile(path.join(modelOut,'progress.json'),redact(results.filter(r=>r.model===model),secrets));console.log(JSON.stringify({model,round,case:id,status:row.status,ms:row.latencyMs,error:row.error}));
  if(row.status!=='passed'){await api('/api/stop','POST',{}).catch(()=>{});for(const s of await api('/api/agent/sessions').catch(()=>[]))if(s.kind!=='main'&&!['done','stopped'].includes(s.status))await api(`/api/agent/sessions/${s.id}/stop`,'POST',{}).catch(()=>{});}
 }
 try{
  await start();let boot=await api('/api/bootstrap');
  const auth=await api('/api/pi/auth/start','POST',{provider:'opencode-go',type:'api_key',consent:true});
  const pending=await until(()=>app.pi.snapshot().pending?.prompt?app.pi.snapshot().pending:null,'Pi key login',10000);
  await api('/api/pi/auth/respond','POST',{id:pending.id,promptId:pending.prompt.id,value:keys.opencode});await app.pi.pending.task;
  assert.ok(app.pi.status(auth.pending.accountId).connected,'Pi key must be registered');
  const catalog=await api('/api/pi/models/refresh','POST',{provider:'opencode-go',accountId:auth.pending.accountId,consent:true}),definition=catalog.models.find(m=>m.id===model);assert.ok(definition,'Selected model must exist in the Pi account catalog');
  await api('/api/providers','PUT',{expectedRevision:boot.providers.revision,config:{profiles:[{id:'bench',name:model,engine:'pi-ai',piProvider:'opencode-go',authMode:'pi-key',accountId:auth.pending.accountId,protocol:definition.protocol,baseUrl:definition.baseUrl,model,domain:'cloud',maxParallel:1,maxTokens:4096,contextTokens:131072,timeoutMs:120000,capabilities:{tools:true}}],routes:{main:{primary:'bench'}}}});
  const caps=await api('/api/capabilities');await api('/api/capabilities','PUT',{expectedRevision:caps.revision,config:{profiles:[{id:'jev',name:'Jev Computer Use',protocol:'system-one',baseUrl:DECISION_BASE,model:'jev-latest',domain:'cloud',timeoutMs:20000,maxParallel:1}],routes:{decision:'jev'}}});
  // Freeze learning across repeated cases. Keep the actual completion/decision implementation.
  const computer=await api('/api/computer');await api('/api/computer','PATCH',{expectedRevision:computer.config.revision,patch:{desktop:false,headless:true,control:'decision',browserExecutable:process.env.CHROMIUM_PATH||''}});
  await api('/api/agent/settings','PATCH',{dream:false,maxSteps:24,heartbeat:{enabled:false},policy:{rules:[{tool:'exec',action:'deny'},{tool:'process',action:'deny'},{tool:'web_fetch',action:'deny'},{tool:'web_search',action:'deny'},{tool:'computer',match:'"target":"desktop"',action:'deny'}]}});
  const basePolicy=(await api('/api/agent/settings')).policy;
  if(browser){context=await browser.newContext({viewport:{width:1440,height:960},timezoneId:'Asia/Tokyo'});page=await context.newPage();page.setDefaultTimeout(8000);}
  for(let round=1;round<=repeat;round++){
   for(const c of workflows.filter(c=>wanted(c.id)))await record(c.id,round,async()=>{
    const cwd=await mkdtemp(path.join(dir,'case-'));for(const f of c.setup||[]){const p=path.join(cwd,f.path);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,f.content??generatedLog());}if(c.setup?.length)await pause(1100);
    return policyScope(setPolicy,c.id==='script-and-run'?{rules:basePolicy.rules.filter(r=>r.tool!=='exec')}:basePolicy,basePolicy,async()=>{const session=await app.agent.spawn(null,{task:c.input,title:c.id,cwd,signal:caseSignal});activeSession=session.id;const d=await workerDone(session),checks=await evaluateChecks(c,cwd,app.store,d.entries.filter(e=>e.type==='tool'),session.id);assert.ok(checks.every(x=>x.ok),JSON.stringify(checks.filter(x=>!x.ok)));return {sessionId:session.id,checks,stats:d.session.stats};});
   });
   if(wanted('conversation'))await record('conversation',round,async()=>{
    const word='BENCH_'+randomUUID().slice(0,8),d=await mainReply(`会話の確認です。合言葉は「${word}」です。合言葉だけを返してください。`);assert.ok(JSON.stringify(d.entries.filter(e=>e.type==='assistant')).includes(word));
    const next=await mainReply('先ほど伝えた合言葉だけを返してください。新しい仕事は作らないでください。');assert.ok(String(next.entries.findLast(e=>e.type==='assistant')?.content).includes(word));return {sessionId:d.session.id,word};
   });
   if(wanted('attachment-retry'))await record('attachment-retry',round,async()=>{
    const word='ATTACH_'+randomUUID().slice(0,8),staged=await api('/api/inputs','POST',{files:[{name:'proof.txt',content:word}]}),id=(await api('/api/bootstrap')).dialogue.session.id,requestId=randomUUID(),text='添付ファイルを読み、その中に書かれた合言葉だけ返してください。';
    activeSession=id;
    const receipts=await Promise.all(Array.from({length:4},()=>api('/api/agent/input','POST',{requestId,text,attachmentIds:[staged.files[0].id]})));for(const r of receipts)assert.deepEqual(r,receipts[0]);
    const d=await until(async()=>{const v=await detail(id);return JSON.stringify(v.entries.filter(e=>e.type==='assistant')).includes(word)?v:null;},'attachment reading');
    const input=d.entries.filter(e=>e.type==='input'&&e.attachments?.some(a=>a.name==='proof.txt'&&a.path));const matching=[];for(const e of input){const p=e.attachments[0].path;if(await readFile(p,'utf8')===word)matching.push(e);}assert.equal(matching.length,1);assert.equal(matching[0].attachments.length,1);return {sessionId:id,duplicateReceipts:receipts.length,acceptedInputs:1};
   });
   if(wanted('delegation'))await record('delegation',round,async()=>{
    const word='DELEGATE_'+randomUUID().slice(0,8),old=new Set((await api('/api/agent/sessions')).map(s=>s.id)),before=await api('/api/bootstrap'),mainId=before.dialogue.session.id,seq=(await detail(mainId)).entries.at(-1)?.seq||0;
    await mainReply(`sessions_spawnで作業担当を1人起動してください。その担当は delegated.txt に「${word}」だけを書き、実物を確認して終了してください。会話担当自身では作成しないでください。`);
    const job=await until(async()=>{const list=await api('/api/agent/sessions');return list.find(s=>!old.has(s.id)&&s.kind!=='main');},'delegated worker');activeSession=job.id;
    const worker=await workerDone(job),main=await detail(mainId),target=delegationFileTarget({worker,mainEntries:main.entries.filter(e=>e.seq>seq),parentCwd:before.dialogue.session.cwd||path.join(dir,'work'),file:'delegated.txt',expected:word});
    assert.ok(target,'The delegate must write and read the requested file; the main session must not create it');
    const canonical=await realpath(target),relative=path.relative(await realpath(dir),canonical);assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Delegated file must stay in private benchmark data');
    assert.equal((await readFile(canonical,'utf8')).trim(),word);return {workerId:job.id,file:relative,verifiedWriter:'worker',contentMatches:true};
   });
   for(const allow of [true,false]){const id=allow?'approval-allow':'approval-deny';if(!wanted(id))continue;await record(id,round,async()=>{
    return policyScope(setPolicy,{rules:[...basePolicy.rules,{tool:'write',action:'ask'}]},basePolicy,async()=>{const job=await spawn('writeツールで approval.txt に APPROVAL_PROOF とだけ書いてください。拒否されたら再試行や別ツールへの迂回をせず、拒否されたと報告して終了してください。',id);
     const approval=await until(async()=>{const v=await api('/api/agent/approvals');return v.approvals.find(a=>a.jobId===job.id&&a.name==='write'&&a.status==='pending');},'write approval');
     const before=await request(`/api/agent/sessions/${job.id}/download?path=approval.txt`);assert.equal(before.status,404,'write must not happen before approval');
     await api('/api/agent/approvals/'+approval.id,'POST',{allow});await workerDone(job);
     if(allow)assert.equal((await proofFile(job,'approval.txt')).trim(),'APPROVAL_PROOF');else assert.equal((await request(`/api/agent/sessions/${job.id}/download?path=approval.txt`)).status,404);
     return {workerId:job.id,approvalId:approval.id,allowed:allow};
    });
   });}
   if(wanted('stop-resume'))await record('stop-resume',round,async()=>{
    const before=meter.calls.length,job=await spawn('writeツールで resumed.txt に RESUMED と書き、読み直して終了してください。','stop-resume');await until(()=>meter.calls.length>before,'inference dispatched');
    await api(`/api/agent/sessions/${job.id}/stop`,'POST',{});assert.equal((await detail(job.id)).session.status,'stopped');await pause(200);assert.equal((await detail(job.id)).session.status,'stopped');
    await api(`/api/agent/sessions/${job.id}/resume`,'POST',{});await workerDone(job);assert.equal((await proofFile(job,'resumed.txt')).trim(),'RESUMED');return {workerId:job.id,cancelledDispatches:meter.calls.slice(before).filter(c=>c.cancelled).length};
   });
   if(wanted('memory'))await record('memory',round,async()=>{
    const word='MEMORY_'+randomUUID().slice(0,8),subject='試験'+randomUUID().slice(0,6),m=await api('/api/memories','POST',{title:subject,content:subject+'の好きな飲み物は'+word,scope:'shared'});
    const d=await mainReply(`記憶を検索して、${subject}の好きな飲み物を答えてください。`);assert.ok(String(d.entries.findLast(e=>e.type==='assistant')?.content).includes(word));
    await api('/api/memories/'+m.id,'PATCH',{content:'更新済み '+word});assert.ok((await api('/api/bootstrap')).memories.some(x=>x.id===m.id&&x.content==='更新済み '+word));return {memoryId:m.id};
   });
   for(const blocked of [false,true]){const id=blocked?'computer-jev-blocked':'computer-jev-form';if(!wanted(id))continue;await record(id,round,async()=>{
    const token=randomUUID(),name='検証'+token.slice(0,6),url=fixtureOrigin+(blocked?'/blocked/':'/form/')+token,first=meter.calls.length;
    const task=`computerツールのaction doを使い、${url} で氏名「${name}」、希望枠「午後」を入力し、内容を確認しましたをチェックして予約してください。inputsに氏名と希望枠を指定し、checksにtext_includes「受付済み: ${name} / 午後」を必ず指定してください。直接クリックを繰り返す代わりにdoで操作してください。${blocked?'送信機能が無ければ成功を主張せず操作不可と報告し、終了してください。':'受付済みの表示を実際に確認してから終了してください。'}Web取得やHTTPの直接送信で代用しないでください。`;
    const job=await spawn(task,id),d=await workerDone(job),tools=d.entries.filter(e=>e.type==='tool'&&e.name==='computer'&&e.args?.action==='do');assert.ok(tools.length,'Planning model must call computer do');
    assert.ok(tools.some(e=>String(e.content).includes('decision model')),'Computer actions must be selected by Jev');assert.ok(!tools.some(e=>String(e.content).includes('chat model')),'Jev fallback is not a Jev success');
    const decisions=meter.calls.slice(first).filter(c=>c.decisionRole==='computer-action');assert.ok(decisions.length>0&&decisions.every(c=>c.status===200));
    if(blocked){assert.ok(blockedComputerOutcome(tools,`受付済み: ${name} / 午後`,submissions.get(token)||null,d.session.result),'Reservation must be blocked, unsubmitted and disclosed; completed input subgoals are allowed');}else{assert.ok(tools.some(e=>e.data?.status==='completed'));assert.deepEqual(submissions.get(token),{name,slot:'午後',confirmed:true});}
    const evidence={workerId:job.id,decisionCalls:decisions.length,toolResults:tools.map(e=>({status:e.data?.status,steps:e.data?.steps,content:String(e.content).slice(0,3500)})),serverReceipt:submissions.get(token)||null};
    const p=app.computer.browser?.pages.get(job.id);if(p&&!p.closed){const s=await p.screenshot();await writeFile(path.join(modelOut,`${round}-${id}.jpg`),Buffer.from(s.base64,'base64'));}return evidence;
   });}
   if(wanted('restart'))await record('restart',round,async()=>{
    const before=await api('/api/bootstrap'),snapshot={main:before.dialogue.session.id,artifacts:before.artifacts.map(a=>[a.id,a.version]),memories:before.memories.map(m=>[m.id,m.content]),provider:before.providers.profiles[0].model};
    await page?.goto('about:blank');await closeApp();await start();const after=await api('/api/bootstrap');assert.equal(after.dialogue.session.id,snapshot.main);assert.deepEqual(after.artifacts.map(a=>[a.id,a.version]),snapshot.artifacts);assert.deepEqual(after.memories.map(m=>[m.id,m.content]),snapshot.memories);assert.equal(after.providers.profiles[0].model,snapshot.provider);
    return {main:snapshot.main,artifacts:snapshot.artifacts.length,memories:snapshot.memories.length};
   });
   if(wanted('browser-ui'))await record('browser-ui',round,async()=>{
    if(!page)throw Object.assign(Error('Playwright/browser not configured'),{blocked:true});const errors=[],handler=e=>errors.push(e.message);page.on('pageerror',handler);
    try{await page.goto(app.launchUrl);await page.locator('#clock-display').waitFor();if(await page.getByRole('button',{name:'今は時計として使う',exact:true}).isVisible())await page.getByRole('button',{name:'今は時計として使う',exact:true}).click();
     const draft='PRIVATE_DRAFT_'+randomUUID().slice(0,8);await page.locator('.nav [data-view=home]').click();await page.locator('#composer-input').fill(draft);await page.getByRole('button',{name:'画面の表示',exact:true}).click();await page.getByRole('button',{name:'共有表示（個人の内容を隠す）',exact:true}).click();assert.equal(await page.locator('#composer-input').isVisible(),false);await page.getByRole('button',{name:'共有表示を終える',exact:true}).click();assert.equal(await page.locator('#composer-input').inputValue(),draft);
     await page.setViewportSize({width:390,height:844});await page.locator('.nav [data-view=settings]').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(modelOut,`${round}-mobile.png`)});assert.deepEqual(errors,[]);return {draftPreserved:true,sharedHidden:true,viewports:[[1440,960],[390,844]],pageErrors:errors};
    }finally{page.off('pageerror',handler);await page.setViewportSize({width:1440,height:960});}
   });
  }
 }catch(e){failures.push({model,error:redact(e.message,secrets)});}
 finally{await context?.close().catch(()=>{});try{await closeApp();}catch(e){failures.push({model,error:'Service cleanup: '+redact(e.message,secrets)});}try{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){failures.push({model,error:'Temporary data cleanup: '+e.code});}}
}
try{await Promise.all(models.map(lane));}finally{
 await browser?.close();await new Promise(r=>fixture.close(r));
 const sourceAfter=await fingerprint(),expected=planned.length*repeat;
 const perModel=models.map(model=>({model,...summarizeCases(results.filter(x=>x.model===model),expected)}));
 const missingCapabilities=['live OAuth accounts','ASR / microphone','TTS / audio output','image generation / editing','video generation','embedding semantics','real MCP / CLI integrations','native WebView / native desktop Computer Use and long-running operation'];
 const report={schema:1,createdAt:new Date().toISOString(),platform:process.platform,version:'3.0.0-beta.11',sourceBefore,sourceAfter,stable:sourceBefore===sourceAfter,repeat,planned,perModel,complete:sourceBefore===sourceAfter&&failures.length===0&&perModel.every(x=>x.complete),fullProductCertified:false,missingCapabilities,failures,results,providers:meters.map(({model,meter})=>({model,...meter.snapshot()})),method:'Real service, Rust SQLite, agent runtime, checked TLS transport, real main models and Jev Computer Use. Synthetic files/pages only; exact local oracles, never LLM-as-judge. Concurrent independent model lanes; repeated cases within a lane share normal durable state.',limitations:'Two trials are smoke/regression evidence, not a statistical reliability guarantee or proof that every product feature works. Provider prices are dated estimates; budget reservations are conservative dispatch bounds, not billing receipts.'};
 await writeFile(path.join(out,'report.json'),redact(report,secrets));
 const md=`# Tepora beta.11 実モデル基本動作ベンチマーク\n\n実行: ${report.createdAt}\n\n| 主モデル | 成功 | 失敗 | ブロック | 未実行 | 中央値秒 | p95秒 |\n|---|---:|---:|---:|---:|---:|---:|\n`+perModel.map(m=>`| ${m.model} | ${m.passed}/${m.expected} | ${m.failed} | ${m.blocked} | ${m.missing} | ${m.p50Ms==null?'-':(m.p50Ms/1000).toFixed(1)} | ${m.p95Ms==null?'-':(m.p95Ms/1000).toFixed(1)} |`).join('\n')+`\n\nComputer Useは主モデルが目標と入力を渡し、Jevが実Chromeの操作候補を選択します。実フォームの受信結果とツール履歴で判定し、chat modelへのフォールバックはJev成功に数えません。\n\n`+results.filter(r=>r.status!=='passed').map(r=>`- ${r.model} / ${r.id} #${r.round}: ${r.status} — ${r.error}`).join('\n')+`\n\n未検証: ${missingCapabilities.join(', ')}。完全な製品保証とは扱いません。詳細・呼出回数・使用量・推定費用・個別証拠は report.json を参照してください。\n`;
 await writeFile(path.join(out,'report.md'),redact(md,secrets));console.log(JSON.stringify({report:path.join(out,'report.json'),complete:report.complete,perModel}));if(!report.complete)process.exitCode=1;
}
