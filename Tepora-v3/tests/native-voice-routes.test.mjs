/** Ordinary dictation-edit and one-shot transcription HTTP parity. All inputs
 * and provider responses are synthetic and loopback-only. No microphones,
 * external accounts, paid providers, real credentials or model quality checks.
 * Build core and this exact native binary before running this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){for(let n=0;n<400;n++){const value=await fn();if(value)return value;await pause(25);}throw new Error('Timed out: '+label);}
function deadline(promise,label,ms=20000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);})]).finally(()=>clearTimeout(timer));}
const syntheticAudio=Buffer.from([82,73,70,70,8,0,0,0,87,65,86,69,0,1,127,128,255]);
const editPath='/v1/chat/completions',asrPath='/asr';
const input={draft:'朝🌸の予定です',spoken:'予定を予約に直して',selection:{start:4,end:6},baseRevision:7,utteranceId:'synthetic-発話-1'};
const proposal={start:4,end:6,expectedText:'予定',replacement:'予約📝',summary:'予定を予約に変更'};
const editCall=(value=proposal,name='propose_draft_edit')=>({id:'synthetic-edit',type:'function',function:{name,arguments:typeof value==='string'?value:JSON.stringify(value)}});
const modelAnswer=(calls=[editCall()])=>({choices:[{finish_reason:calls.length?'tool_calls':'stop',message:{role:'assistant',content:calls.length?null:'synthetic response',tool_calls:calls}}]});

async function client(launchUrl,close,data){
 const launch=await fetch(launchUrl,{redirect:'manual'});assert.equal(launch.status,303);
 const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(launchUrl).origin;
 const bootstrapResponse=await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}});assert.equal(bootstrapResponse.status,200);const bootstrap=await bootstrapResponse.json();
 const request=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(body===undefined?{}:{body:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const json=async(route,method,body,status=200)=>{const response=await request(route,method,body);const value=await response.json();assert.equal(response.status,status,`${route}: ${JSON.stringify(value)}`);return value;};
 return {request,json,close,data};
}

async function fixture(t){
 // The compatibility connector reads this environment variable directly.
 // Refuse credential-bearing execution before making any provider request.
 assert.ok(!process.env.TEPORA_ASR_KEY,'Run synthetic voice fixtures without TEPORA_ASR_KEY');
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-voice-routes-')));
 const empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty);await writeFile(bundle,'// Synthetic voice routes fixture\n');
 const records=[],held=[],sockets=new Set(),holds=new Set();let editResponse=modelAnswer(),asrResponse={text:'合成音声🌸の文字起こし'},asrStatus=200,serial=0;
 const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 const mock=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);let body;
  if(req.url===editPath)body=JSON.parse(raw.toString());
  const record={method:req.method,url:req.url,headers:req.headers,body,raw};records.push(record);
  if(holds.has(req.url)){const entry={...record,res,closed:false};res.once('close',()=>{entry.closed=true;});held.push(entry);return;}
  if(req.url==='/api/start'){reply(res,200,{session_id:'synthetic-stream'});return;}
  if(req.url==='/api/cancel'){reply(res,200,{cancelled:true});return;}
  if(req.url==='/props'){reply(res,200,{n_ctx:8192,total_slots:1});return;}
  if(req.url===editPath){reply(res,200,editResponse);return;}
  if(req.url===asrPath){reply(res,asrStatus,asrResponse);return;}
  reply(res,404,{error:'Unrecognized synthetic endpoint'});
 });
 mock.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${mock.address().port}`;
 cleanup.service({close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>mock.close(resolve));}});
 async function start(native,{agent=true,data=path.join(dir,`${native?'native':'node'}-${serial++}`)}={}){
  if(!native){const app=cleanup.service(await startServer({dir:data,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})}));return client(app.launchUrl,app.close,data);}
  const child=spawn(binary,['--dev-native',...(agent?['--agent']:[]),'--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  let stderr='',exit;child.stderr.on('data',value=>stderr=(stderr+value).slice(-20000));child.stdin.on('error',()=>{});
  const exited=new Promise(resolve=>{child.once('error',error=>{exit={error};resolve(exit);});child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);});});
  const lines=createInterface({input:child.stdout});
  const owned=cleanup.service({close:async()=>{
   if(!exit){child.stdin.write('shutdown\n');try{await deadline(exited,'native shutdown');}catch(error){child.kill('SIGKILL');await exited;throw error;}}
   lines.close();assert.equal(exit.code,0,stderr||String(exit.error||exit.signal));
  }});
  const ready=await deadline(Promise.race([new Promise((resolve,reject)=>lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}})),exited.then(()=>{throw new Error('Native startup: '+stderr+(exit.error?.message||''));})]),'native readiness');
  return {...await client(ready.url,owned.close,data),trayStop:()=>child.stdin.write('stop\n')};
 }
 async function configureEditor(c,{enabled=true,route=true}={}){
  await c.json('/api/settings','PATCH',{dictationEditing:enabled});
  const before=await c.json('/api/providers');
  const profile={id:'synthetic-editor',name:'Synthetic local editor',protocol:'chat-completions',baseUrl:origin+'/v1',domain:'device',model:'synthetic-editor',server:'other',contextTokens:8192,capabilities:{text:true,tools:true}};
  await c.json('/api/providers','PUT',{expectedRevision:before.revision,config:{profiles:[profile],routes:{main:{primary:profile.id,fallbacks:[]},...(route?{dictation:{primary:profile.id,fallbacks:[]}}:{})}}});
 }
 const configureAsr=c=>c.json('/api/settings','PATCH',{asrUrl:origin+asrPath,asrModel:'synthetic-asr'});
 const configureStream=c=>c.json('/api/settings','PATCH',{asrStreamUrl:origin,voiceEnabled:true});
 return {start,configureEditor,configureAsr,configureStream,records,held,holds,reply,setEdit:value=>{editResponse=value;},setAsr:(value,status=200)=>{asrResponse=value;asrStatus=status;}};
}

function expectedEdit(request,edit=proposal){return {baseRevision:request.baseRevision,utteranceId:request.utteranceId,edits:[{start:edit.start,end:edit.end,text:edit.replacement}],summary:String(edit.summary||'').slice(0,240),preview:request.draft.slice(0,edit.start)+edit.replacement+request.draft.slice(edit.end),execution:false,source:'local-model-proposal'};}
async function error(c,route,body,status,message){assert.deepEqual(await c.json(route,'POST',body,status),{error:message});}
function shutdownResult(result){
 // The HTTP shutdown selector may win before the owned operation's 499.
 if(result.error){assert.notEqual(result.error.name,'TimeoutError','shutdown must settle without the client deadline');return;}
 assert.ok([499,503].includes(result.status),JSON.stringify(result));
 if(result.status===503)assert.deepEqual(result.body,{error:'Service is closing'});
}

test('native voice edit: source-parity Unicode proposals, defaults and local route admission',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native),before=f.records.length;
  await error(c,'/api/voice/edit',input,403,'Local dictation editing is not enabled');
  await c.json('/api/settings','PATCH',{dictationEditing:true});
  await error(c,'/api/voice/edit',input,409,'同一PCの音声編集モデルを設定してください。');
  await f.configureEditor(c,{route:false});
  await error(c,'/api/voice/edit',input,409,'同一PCの音声編集モデルを設定してください。');
  assert.equal(f.records.length,before,'disabled or unconfigured edits must not call the model');
  await f.configureEditor(c);
  for(const [request,edit] of [
   [input,proposal],
   [{...input,draft:'A🌸B',selection:{start:1,end:3}},{start:1,end:3,expectedText:'🌸',replacement:'📝',summary:'絵文字を変更'}],
   [{...input,draft:'A🌸B',selection:{start:1,end:2}},{start:1,end:2,expectedText:'\ud83c',replacement:'\ud83d',summary:'x'.repeat(239)+'🌸'}],
   [{...input,draft:'A\ue000\ud800Z',selection:{start:1,end:2}},{start:1,end:2,expectedText:'\ue000',replacement:'\ue000\udc00',summary:'マーカーもそのまま'}],
   [{...input,draft:'末尾🌸',selection:undefined},{start:4,end:4,expectedText:'',replacement:'に追加',summary:'追記'}],
   [{...input,draft:'',selection:null},{start:0,end:0,expectedText:'',replacement:'合成テキスト',summary:'説明'.repeat(160)}],
   [{...input,draft:'e\u0301🌸',selection:{start:0,end:2}},{start:0,end:2,expectedText:'e\u0301',replacement:'é',summary:0}],
  ]){
   f.setEdit(modelAnswer([editCall(edit)]));
   assert.deepEqual(await c.json('/api/voice/edit','POST',request),expectedEdit(request,edit));
   const record=f.records.findLast(record=>record.url===editPath);assert.equal(record.method,'POST');assert.equal(record.headers.authorization,undefined);
   assert.equal(record.body.model,'synthetic-editor');assert.equal(record.body.tools.length,1);assert.equal(record.body.tools[0].function.name,'propose_draft_edit');
   assert.deepEqual(JSON.parse(record.body.messages.findLast(message=>message.role==='user').content),{draft:request.draft,spoken:request.spoken,selection:request.selection||{start:request.draft.length,end:request.draft.length}});
  }
  await c.close();
 }
});

test('native voice edit: source validation and exact model proposal errors',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native);await f.configureEditor(c);const before=f.records.length;
  for(const [patch,message] of [
   [{draft:null},'Invalid draft'],[{draft:'🌸'.repeat(16001)},'Invalid draft'],
   [{spoken:' \n\t '},'spoken text: 1–8000 characters required'],[{spoken:'x'.repeat(8001)},'spoken text: 1–8000 characters required'],
   [{utteranceId:''},'utterance id: 1–200 characters required'],[{utteranceId:'🌸'.repeat(101)},'utterance id: 1–200 characters required'],
   [{baseRevision:-1},'Invalid draft revision'],[{baseRevision:0.5},'Invalid draft revision'],[{baseRevision:'7'},'Invalid draft revision'],
   [{selection:{start:-1,end:0}},'Invalid text selection'],[{selection:{start:0.5,end:1}},'Invalid text selection'],
   [{selection:{start:3,end:2}},'Invalid text selection'],[{selection:{start:0,end:input.draft.length+1}},'Invalid text selection'],[{selection:{}},'Invalid text selection'],
  ])await error(c,'/api/voice/edit',{...input,...patch},400,message);
  assert.equal(f.records.length,before,'invalid source input must not call the model');
  for(const [answer,status,message] of [
   [modelAnswer([]),422,'The local editor did not return a draft edit'],
   [modelAnswer([editCall(),{...editCall(),id:'synthetic-second'}]),422,'The local editor did not return a draft edit'],
   [modelAnswer([editCall(proposal,'other_proposal')]),422,'The local editor did not return a draft edit'],
   [modelAnswer([editCall('{')]),500,'Invalid edit JSON'],
   [modelAnswer([editCall({...proposal,start:-1})]),422,'Invalid edit range'],
   [modelAnswer([editCall({...proposal,end:input.draft.length+1})]),422,'Invalid edit range'],
   [modelAnswer([editCall({...proposal,start:4.5})]),422,'Invalid edit range'],
   [modelAnswer([editCall({...proposal,expectedText:'予約'})]),409,'The edit did not match its original text'],
   [modelAnswer([editCall({...proposal,expectedText:null})]),409,'The edit did not match its original text'],
   [modelAnswer([editCall({...proposal,replacement:42})]),413,'Replacement exceeds draft budget'],
   [modelAnswer([editCall({...proposal,replacement:'🌸'.repeat(16001)})]),413,'Replacement exceeds draft budget'],
   [modelAnswer([editCall({...proposal,replacement:'x'.repeat(32000)})]),413,'Replacement exceeds draft budget'],
  ]){f.setEdit(answer);await error(c,'/api/voice/edit',input,status,message);}
  f.setEdit(modelAnswer());assert.deepEqual(await c.json('/api/voice/edit','POST',input),expectedEdit(input));await c.close();
 }
});

test('native voice edit: only one pending draft edit is admitted and completion releases it',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native);await f.configureEditor(c);f.holds.add(editPath);const index=f.held.length;
  const pending=c.json('/api/voice/edit','POST',input);await wait(()=>f.held.length===index+1,'pending local edit');
  const count=f.records.length;await error(c,'/api/voice/edit',{...input,utteranceId:'second'},429,'Another draft edit is running');assert.equal(f.records.length,count);
  f.reply(f.held[index].res,200,modelAnswer());assert.deepEqual(await pending,expectedEdit(input));f.holds.delete(editPath);
  assert.deepEqual(await c.json('/api/voice/edit','POST',input),expectedEdit(input));await c.close();
 }
});

test('native voice edit: source-parity twelve-second deadline drains and releases the edit slot',{timeout:45000},async t=>{
 const f=await fixture(t),clients=[await f.start(false),await f.start(true)];
 for(const c of clients)await f.configureEditor(c);
 f.holds.add(editPath);
 const pending=clients.map(c=>error(c,'/api/voice/edit',input,500,'The operation was aborted due to timeout'));
 await wait(()=>f.held.length===2,'both deadline-held editor calls');
 await Promise.all(pending);await wait(()=>f.held.every(call=>call.closed),'deadline-cancelled editor transports');
 for(const call of f.held)f.reply(call.res,200,modelAnswer([editCall({...proposal,replacement:'LATE RESULT'})]));
 f.holds.clear();
 for(const c of clients){assert.deepEqual(await c.json('/api/voice/edit','POST',input),expectedEdit(input));await c.close();}
});

test('native voice transcribe: source-parity multipart bytes, fields and upstream errors',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native),before=f.records.length;
  await error(c,'/api/voice/transcribe',syntheticAudio,409,'音声モデルが未接続です。接続設定でASRサーバーを指定してください。');assert.equal(f.records.length,before);
  await f.configureAsr(c);await c.json('/api/settings','PATCH',{voiceEnabled:false});
  for(const bytes of [syntheticAudio,Buffer.alloc(0)]){
   f.setAsr({text:'合成音声🌸の文字起こし'});assert.deepEqual(await c.json('/api/voice/transcribe','POST',bytes),{text:'合成音声🌸の文字起こし'});
   const record=f.records.findLast(record=>record.url===asrPath);assert.equal(record.method,'POST');assert.equal(record.headers.authorization,undefined);
   assert.match(record.headers['content-type'],/^multipart\/form-data; boundary=/);
   const form=await new Response(record.raw,{headers:{'Content-Type':record.headers['content-type']}}).formData();
   assert.deepEqual([...form.keys()].sort(),['file','language','model','response_format']);
   assert.equal(form.get('file').name,'recording.wav');assert.equal(form.get('file').type,'audio/wav');assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()),bytes);
   assert.equal(form.get('model'),'synthetic-asr');assert.equal(form.get('language'),'ja');assert.equal(form.get('response_format'),'json');
  }
  f.setAsr({text:'synthetic upstream failure'},503);await error(c,'/api/voice/transcribe',syntheticAudio,502,'ASR returned HTTP 503');
  for(const body of [{},{text:null},{text:42},{text:['synthetic']}]){f.setAsr(body);await error(c,'/api/voice/transcribe',syntheticAudio,502,'ASR did not return text');}
  f.setAsr({text:''});assert.deepEqual(await c.json('/api/voice/transcribe','POST',syntheticAudio),{text:''});await c.close();
 }
});

test('native voice routes: workspace-only mode remains effect-free',{timeout:40000},async t=>{
 const f=await fixture(t),c=await f.start(true,{agent:false});
 for(const [route,body] of [['edit',input],['transcribe',syntheticAudio]])await c.json('/api/voice/'+route,'POST',body,503);
 assert.equal(f.records.length,0);await c.close();
});

// Native-only defensive limits are intentionally tighter than the source ASR.
test('native voice transcribe: bounded response bytes and UTF-16 transcript size',{timeout:40000},async t=>{
 const f=await fixture(t),c=await f.start(true);await f.configureAsr(c);
 const text='🌸'.repeat(16000);f.setAsr({text});assert.deepEqual(await c.json('/api/voice/transcribe','POST',syntheticAudio),{text});
 f.setAsr({text:text+'x'});await error(c,'/api/voice/transcribe',syntheticAudio,413,'ASR transcript exceeds text budget');
 f.setAsr({text:'synthetic',padding:'x'.repeat(256000)});
 const result=await c.json('/api/voice/transcribe','POST',syntheticAudio,502);assert.match(result.error,/response-size limit|Response exceeds budget/);
 f.setAsr({text:'recovered'});assert.deepEqual(await c.json('/api/voice/transcribe','POST',syntheticAudio),{text:'recovered'});await c.close();
});

test('native voice routes: Stop All, tray Stop and shutdown drain calls and reject late results',{timeout:90000},async t=>{
 const f=await fixture(t);
 for(const stop of ['http','tray','shutdown']){
  let c=await f.start(true);await f.configureEditor(c);await f.configureAsr(c);
  f.holds.add(editPath);f.holds.add(asrPath);const index=f.held.length;
  const pending=[['/api/voice/edit',input],['/api/voice/transcribe',syntheticAudio]].map(([route,body])=>c.request(route,'POST',body).then(async response=>({status:response.status,body:await response.json()})).catch(error=>({error})));
  await wait(()=>f.held.length===index+2,'pending edit and ASR');const held=f.held.slice(index);
  if(stop==='http')await c.json('/api/stop','POST',{});else if(stop==='tray')c.trayStop();else await c.close();
  await wait(()=>held.every(call=>call.closed),'cancelled provider transports');
  for(const result of await Promise.all(pending)){
   if(stop==='shutdown')shutdownResult(result);
   else{assert.equal(result.status,499,JSON.stringify(result));assert.equal(typeof result.body.error,'string');}
  }
  for(const call of held)f.reply(call.res,200,call.url===editPath?modelAnswer([editCall({...proposal,replacement:'LATE RESULT'})]):{text:'LATE RESULT'});
  f.holds.clear();
  if(stop==='shutdown'){
   const count=f.records.length;c=await f.start(true,{data:c.data});await pause(100);assert.equal(f.records.length,count,'restart must not replay cancelled edit or ASR work');
  }
  assert.deepEqual(await c.json('/api/voice/edit','POST',input),expectedEdit(input));
  assert.deepEqual(await c.json('/api/voice/transcribe','POST',syntheticAudio),{text:'合成音声🌸の文字起こし'});await c.close();
 }
});

test('native voice routes: held speech cleanup does not delay edit or ASR cancellation',{timeout:90000},async t=>{
 const f=await fixture(t);
 for(const stop of ['http','tray','shutdown']){
  const c=await f.start(true);await f.configureEditor(c);await f.configureAsr(c);await f.configureStream(c);await c.json('/api/voice/start','POST');
  for(const route of [editPath,asrPath,'/api/cancel'])f.holds.add(route);
  const index=f.held.length;
  const pending=[['/api/voice/edit',input],['/api/voice/transcribe',syntheticAudio]].map(([route,body])=>c.request(route,'POST',body).then(async response=>({status:response.status,body:await response.json()})).catch(error=>({error})));
  await wait(()=>f.held.length===index+2,'edit and ASR before held speech cleanup');const held=f.held.slice(index);
  let done=false,stopping;
  if(stop==='http')stopping=c.json('/api/stop','POST',{}).then(()=>{done=true;});else if(stop==='tray'){c.trayStop();stopping=Promise.resolve();}else stopping=c.close().then(()=>{done=true;});
  try{
   if(stop!=='shutdown')await wait(()=>f.held.slice(index+2).some(call=>call.url==='/api/cancel'),'held speech cancel');
   await wait(()=>held.every(call=>call.closed),'voice transports cancelled before speech cleanup');
   if(stop==='http')assert.equal(done,false,'Stop All is still draining the held speech cleanup');
  }finally{
   for(const call of f.held.slice(index+2))if(call.url==='/api/cancel')f.reply(call.res,200,{cancelled:true});
   f.holds.clear();
  }
  await stopping;
  for(const result of await Promise.all(pending)){if(stop==='shutdown')shutdownResult(result);else assert.equal(result.status,499,JSON.stringify(result));}
  for(const call of held)f.reply(call.res,200,call.url===editPath?modelAnswer():{text:'LATE RESULT'});
  await c.close();
 }
});
