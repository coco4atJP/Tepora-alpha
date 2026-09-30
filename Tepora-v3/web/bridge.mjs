import { DISPLAY_DEFAULT, validateDisplay } from './display-model.mjs';
import { demoArtifact } from './demo.mjs';
/** One transport contract, two explicit implementations: live localhost and offline visual preview. */
export const previewMode=location.protocol==='file:' || window.__TEPORA_PREVIEW__===true;
let csrfToken='', stream=null;
const listeners=new Set();
const dispatch=e=>{for(const fn of listeners)fn(e);};
const previewDefaults={companion:'Tepora',provider:'llama.cpp',baseUrl:'http://127.0.0.1:8080/v1',model:'',asrUrl:'',asrStreamUrl:'',asrModel:'Qwen/Qwen3-ASR-1.7B',decisionUrl:'',decisionModel:'multilingual',allowCloud:false,allowNetwork:false,shareMemory:false,voiceEnabled:true,autoAmbient:false,concurrency:2,maxSteps:64,maxTokens:2048,weatherCity:'',newsUrl:'',apiKeyEnv:'',runtimeBinary:'',modelPath:'',bravePath:''};
let saved;try{saved=JSON.parse(localStorage.getItem('tepora-preview-v3')||'null');}catch{}
let previewState={seq:0,jobs:[],artifacts:[],memories:[],messages:[],skills:[],mcp:[],settings:previewDefaults,...saved,preview:true,platform:'preview',workspace:'プレビュー内のみ'};
previewState.display=previewState.display||structuredClone(DISPLAY_DEFAULT);
previewState.companion||={revision:0,focusJobId:null,returnStack:[]};
previewState.displayHistory=[];previewState.routines=[];previewState.plans=[];
previewState.capabilities||={schema:1,revision:0,profiles:[],routes:{}};previewState.mediaJobs=[];
previewState.network||={schema:1,revision:0,mode:'online',internetTools:false};
previewState.providers||={schema:1,revision:0,profiles:[],routes:{},offlineFloor:{configured:false,verified:false,providers:[]}};
previewState.computer||={config:{schema:1,revision:0,enabled:false,controller:'both',backend:'browser',python:'python',browserExecutable:'',headless:false,allowedOrigins:[],windowHandle:null,maxActions:100},active:null};
previewState.settings={...previewDefaults,...previewState.settings};
previewState.jobs=previewState.jobs.map(j=>['queued','running','waiting_approval'].includes(j.status)?{...j,status:'interrupted',note:'プレビューを再読み込みしました。'}:j);
const uid=()=>globalThis.crypto?.randomUUID?.()||`preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const previewTimers=new Map(),toolImportPreviews=new Map();let previewCatalog=[];
function savePreview(){try{localStorage.setItem('tepora-preview-v3',JSON.stringify({...previewState,inputs:[]}));}catch{ /* file:// storage can be unavailable; keep the preview usable in memory. */ }}
function emitPreview(type,data){dispatch({seq:++previewState.seq,type,data,at:new Date().toISOString()});savePreview();}
const upsertPreview=(list,doc)=>{const index=previewState[list].findIndex(x=>x.id===doc.id);if(index>=0)previewState[list][index]=doc;else previewState[list].unshift(doc);};

async function previewRequest(p,method,b){
 if(p==='/api/companion')return structuredClone(previewState.companion);
 if(p==='/api/companion/focus'||p==='/api/companion/return'){
  const current=previewState.companion;
  if(current.revision!==b.expectedRevision)throw new Error('対象が変わりました。送り先を確認してください。');
  let focusJobId=b.jobId,returnStack=[...current.returnStack];
  if(p.endsWith('/return'))focusJobId=returnStack.pop()||null;
  else {if(focusJobId&&!previewState.jobs.some(j=>j.id===focusJobId))throw new Error('仕事が見つかりません。');returnStack=returnStack.filter(id=>id!==focusJobId);if(b.pushReturn&&current.focusJobId&&current.focusJobId!==focusJobId)returnStack.push(current.focusJobId);}
  previewState.companion={revision:current.revision+1,focusJobId,returnStack};emitPreview('companion.updated',previewState.companion);return structuredClone(previewState.companion);
 }
 if(p.startsWith('/api/companion/'))throw new Error('画面プレビューでは意図の判断やAIの実行は行いません。');
 if(p==='/api/capabilities'){
  if(method==='GET')return structuredClone(previewState.capabilities);
  if(b.expectedRevision!==previewState.capabilities.revision)throw Error('接続設定が更新されています。');
  const protocols={'system-one':'decision','openai-embeddings':'embedding','ollama-embed':'embedding','openai-speech':'tts','openai-images':'image','openai-image-edit':'image_edit','xai-video':'video'};
  const profiles=b.config.profiles.map(p=>{if(!protocols[p.protocol]||!p.id||!p.name||!p.model)throw Error('接続ID・名前・モデルを入力してください。');new URL(p.baseUrl);return {...p,role:protocols[p.protocol],identity:uid(),enabled:p.enabled!==false,keyPresent:false};});
  for(const [role,id]of Object.entries(b.config.routes)){if(!profiles.some(p=>p.id===id&&p.role===role&&p.enabled))throw Error('役割に対応した接続を選んでください。');}
  previewState.capabilities={schema:1,revision:b.expectedRevision+1,profiles,routes:b.config.routes};emitPreview('capabilities.updated',previewState.capabilities);return structuredClone(previewState.capabilities);
 }
 if(/^\/api\/capabilities\/[^/]+\/key$/.test(p)){throw Error('画面プレビューにはAPIキーを入力しないでください。実サービスで接続ごとに管理します。');}
 if(p==='/api/media/jobs'&&method==='GET')return {jobs:[]};
 if(p==='/api/media/jobs'&&method==='POST')throw Error('この画面はプレビューです。生成・読み上げモデルは呼びません。');
 if(p==='/api/semantic/search'){const query=String(b.query).toLowerCase();return {hits:previewState.memories.filter(m=>m.confirmed&&m.content.toLowerCase().includes(query)),note:'プレビューのキーワード検索（埋め込み推論なし）',indexed:0,total:previewState.memories.length};}
 if(p==='/api/semantic/index')throw Error('意味索引の生成は実サービスで行います。プレビューは推論しません。');
 if(p==='/api/tools/import/preview'){
  if(!b.mcpServers||typeof b.mcpServers!=='object'||Object.keys(b.mcpServers).length>100)throw Error('mcpServers形式を指定してください。');
  const items=Object.entries(b.mcpServers).map(([name,v])=>({name,transport:v.url?'http':'stdio',url:v.url,command:v.command,args:v.args||[],enabled:false,secretNames:Object.keys(v.env||{})})),id=uid();
  toolImportPreviews.set(id,items);return {id,items,note:'画面プレビューです。コマンドを起動せず、秘密情報の値は保存しません。'};
 }
 if(p==='/api/tools/import/apply'){
  if(!b.consent||!toolImportPreviews.has(b.id))throw Error('取込プレビューを確認してください。');const items=toolImportPreviews.get(b.id);toolImportPreviews.delete(b.id);
  for(const item of items){const m={...item,id:uid()};previewState.mcp.push(m);emitPreview('mcp.updated',m);}return {created:items.length,enabled:false};
 }
 if(p==='/api/tools/connect/preview'){
  if(!Array.isArray(b.ids)||!b.ids.length||b.ids.length>12)throw Error('1〜12接続を選んでください。');
  return {id:uid(),connections:b.ids.map(id=>({...previewState.mcp.find(m=>m.id===id),secretNames:[]})),note:'画面プレビューはプロセスを起動しません。実サービスでは選択した接続が起動します。'};
 }
 if(p==='/api/tools/connect/apply')throw Error('画面プレビューは接続しません。実サービスで内容を確認して接続できます。');
 if(p==='/api/tools/search')return {tools:[],note:'実サービスで接続して一覧を取得すると検索できます。'};
 if(/^\/api\/tools\/[^/]+\/discover$/.test(p))throw Error('プレビューでは道具のプロセスやHTTP接続を起動しません。');
 if(p==='/api/model-catalog/import'){
  previewCatalog=[];for(const [providerId,v]of Object.entries(b))for(const [modelId,m]of Object.entries(v.models||{}))previewCatalog.push({provider:v.name||providerId,name:m.name||modelId,modelId,input:m.modalities?.input||[],output:m.modalities?.output||[],verified:false});return {count:previewCatalog.length};
 }
 if(p.startsWith('/api/model-catalog')&&method==='GET'){const q=new URL(p,'https://preview.invalid').searchParams.get('q')||'';return {models:previewCatalog.filter(m=>(m.name+' '+m.modelId).toLowerCase().includes(q.toLowerCase())).slice(0,80),count:previewCatalog.length,at:null};}
 if(p==='/api/model-catalog/refresh')throw Error('画面プレビューは外部の一覧を取得しません。JSONの読込みは使えます。');
 if(p==='/api/codex/login'&&method==='GET')return {phase:'idle'};
 if(p.startsWith('/api/codex/login'))throw Error('画面プレビューではCodexの認証を開始しません。');

 if(p==='/api/network'){
  if(method==='GET')return structuredClone(previewState.network);
  if(b.expectedRevision!==previewState.network.revision)throw Error('通信設定が更新されています。');
  if(b.patch.mode&&!['online','trusted-lan','offline'].includes(b.patch.mode))throw Error('Invalid mode');
  previewState.network={...previewState.network,...b.patch,revision:b.expectedRevision+1};emitPreview('network.updated',previewState.network);return structuredClone(previewState.network);
 }
 if(p==='/api/providers'){
  if(method==='GET')return structuredClone(previewState.providers);
  if(b.expectedRevision!==previewState.providers.revision)throw Error('接続設定が更新されています。');
  const profiles=b.config.profiles.map(p=>({...p,enabled:p.enabled!==false,capabilities:{text:true,tools:null,vision:null,structured:null,...p.capabilities},identity:uid(),keyPresent:false,probe:null,health:null}));
  if(new Set(profiles.map(p=>p.id)).size!==profiles.length||profiles.length>32)throw Error('接続IDは一意にしてください。');
  for(const route of Object.values(b.config.routes))for(const id of [route.primary,...route.fallbacks])if(!profiles.some(p=>p.id===id))throw Error('存在しない接続先です。');
  const chain=b.config.routes.work||b.config.routes.main;
  const floor=chain?profiles.filter(p=>p.domain==='device'&&p.capabilities.tools===true&&[chain.primary,...chain.fallbacks].includes(p.id)).map(p=>p.id):[];
  previewState.providers={...b.config,profiles,schema:1,revision:b.expectedRevision+1,resources:[],offlineFloor:{configured:!!floor.length,verified:false,providers:floor}};
  emitPreview('providers.updated',previewState.providers);return structuredClone(previewState.providers);
 }
 if(p.startsWith('/api/providers/'))throw Error('プレビューでは認証情報を保存せず、実モデルを呼びません。');
 if(p==='/api/computer'){
  if(method==='GET')return structuredClone(previewState.computer);
  if(b.expectedRevision!==previewState.computer.config.revision)throw Error('Computer Use設定が更新されています。');
  previewState.computer={config:{...previewState.computer.config,...b.patch,revision:b.expectedRevision+1},active:null};
  emitPreview('computer.updated',previewState.computer);return structuredClone(previewState.computer);
 }
 if(p==='/api/computer/release')return {released:true};
 if(p.startsWith('/api/computer/'))throw Error('このプレビューはPCの画面を取得・操作しません。');
 if(p==='/api/display'&&method==='GET')return structuredClone(previewState.display);
 if(p==='/api/display/export'){const {schema,revision,...settings}=previewState.display;return {format:'tepora-display',version:1,settings};}
 if(['/api/display','/api/display/undo','/api/display/reset','/api/display/import'].includes(p)) {
  const old=previewState.display;
  if(old.revision!==b.expectedRevision)throw new Error('表示が更新されています。開き直してください。');
  let next;
  if(p.endsWith('/undo')){
   if(!previewState.displayHistory.length)throw new Error('戻せる変更がありません。');
   next=previewState.displayHistory.pop();
  }else{
   let patch=b.patch;
   if(p.endsWith('/reset')){const {schema,revision,...value}=DISPLAY_DEFAULT;patch=value;}
   if(p.endsWith('/import')){
    if(b.preset?.format!=='tepora-display'||b.preset.version!==1||Object.keys(b.preset).some(k=>!['format','version','settings'].includes(k)))throw new Error('表示専用のプリセットではありません。');
    patch=b.preset.settings;
   }
   next=validateDisplay(patch,old);previewState.displayHistory.push(old);previewState.displayHistory=previewState.displayHistory.slice(-20);
  }
  previewState.display={...next,revision:old.revision+1};
  emitPreview('display.updated',previewState.display);return previewState.display;
 }
 if(p==='/api/routines'&&method==='POST'){
  const r={...b,id:uid(),enabled:false,status:'proposed',revision:1};previewState.routines.unshift(r);emitPreview('routine.updated',r);return r;
 }
 if(p==='/api/plans'&&method==='POST'){
  const plan={...b,id:uid(),status:'proposed',revision:1,jobs:{},nodes:b.nodes.map(n=>({...n,dependsOn:n.dependsOn||[]}))};previewState.plans.unshift(plan);emitPreview('plan.updated',plan);return plan;
 }
 if(/^\/api\/(routines|plans)\//.test(p))throw new Error('このプレビューでは実行予約や実際の仕事を開始しません。');
 if(p==='/api/setup')return {dismissed:true,configured:false,verified:false,model:'',provider:'',stage:'connect',candidates:[],engines:[],catalog:[],ramGiB:0,preview:true,transfer:null};
 if(p==='/api/setup/scan')throw new Error('操作プレビューではPC内の接続先を検索しません。実サービスでこの流れを使えます。');
 if(p==='/api/setup/dismiss')return {dismissed:true};
 if(p.startsWith('/api/setup/'))throw new Error('操作プレビューではモデルの取得・接続・インストーラー起動は行いません。');
 if(p.startsWith('/api/requests/context'))return {id:'preview',engine:'builtin',remote:false,label:'画面プレビュー',note:'モデルを呼びません。'};
 if(p==='/api/requests')throw new Error('添付は画面内にありますが、プレビューではAIに送信しません。実サービスで依頼してください。');
 if(p==='/api/inputs'&&method==='POST'){
  if(!Array.isArray(b.files)||b.files.length>6)throw new Error('添付は6件までです。');
  previewState.inputs||=[];const added=b.files.map(f=>({id:uid(),name:f.name,kind:f.base64?'image':'text',bytes:f.base64?atob(f.base64).length:new TextEncoder().encode(f.content).length,createdAt:new Date().toISOString()}));previewState.inputs.push(...added);
  return {files:added.map(({content,...meta})=>meta)};
 }
 if(p.startsWith('/api/inputs/')&&method==='DELETE'){previewState.inputs=(previewState.inputs||[]).filter(f=>f.id!==p.split('/').at(-1));return {deleted:true};}
 if(p==='/api/bootstrap')return structuredClone(previewState);
 if(p==='/api/settings'){const {sessionKey,...settings}=b;Object.assign(previewState.settings,settings);emitPreview('settings.updated',previewState.settings);return previewState.settings;}
 if(p==='/api/jobs'){
  if(b.kind!=='demo')throw new Error('これは画面プレビューです。自由な依頼と音声認識は、ソース版を起動してモデルを接続すると使えます。');
  const j={id:uid(),title:'はじめてのワークスペース',input:b.input,kind:'demo',status:'running',note:'依頼を受け取りました',step:0,output:'',createdAt:new Date().toISOString()};upsertPreview('jobs',j);emitPreview('job.updated',j);
  const aid=uid();let phase=0;const tick=()=>{if(j.status==='cancelled')return;phase++;j.step=phase;j.note=['構成をつくっています','内容を整えています','仕上げています'][phase-1];const a={id:aid,jobId:j.id,title:'はじめてのワークスペース',kind:'html',content:demoArtifact(phase),version:phase,updatedAt:new Date().toISOString()};upsertPreview('artifacts',a);emitPreview('artifact.updated',a);if(phase===3){j.status='completed';j.note='体験用タスクが完了しました';j.output='3回の成果物更新が完了しました。外部モデルを呼ばない、画面操作と非同期更新の体験用サンプルです。';previewTimers.delete(j.id);}else previewTimers.set(j.id,setTimeout(tick,850));emitPreview('job.updated',j);};previewTimers.set(j.id,setTimeout(tick,700));return j;
 }
 if(p==='/api/stop'){for(const j of previewState.jobs)if(j.status==='running'){j.status='cancelled';j.note='停止しました';clearTimeout(previewTimers.get(j.id));emitPreview('job.updated',j);}return {stopped:true};}
 let m=p.match(/^\/api\/jobs\/([^/]+)\/cancel$/);if(m){const j=previewState.jobs.find(x=>x.id===m[1]);if(j){j.status='cancelled';j.note='停止しました';clearTimeout(previewTimers.get(j.id));emitPreview('job.updated',j);}return j;}
 if(p==='/api/memories'){const d={id:uid(),content:b.content,title:b.title||'',scope:b.scope||'private',confirmed:true,source:'user',createdAt:new Date().toISOString()};upsertPreview('memories',d);emitPreview('memory.updated',d);return d;}
 m=p.match(/^\/api\/memories\/([^/]+)$/);if(m){if(method==='DELETE'){previewState.memories=previewState.memories.filter(x=>x.id!==m[1]);emitPreview('memory.deleted',{id:m[1]});return {deleted:true};}const d=previewState.memories.find(x=>x.id===m[1]);Object.assign(d,b);emitPreview('memory.updated',d);return d;}
 if(p==='/api/context/export')return {format:'tepora-v3-context',version:1,memories:previewState.memories,artifacts:previewState.artifacts,skills:previewState.skills};
 if(p==='/api/context/import'){if(b.format!=='tepora-v3-context'||!Array.isArray(b.memories)||b.memories.length>500)throw new Error('Teporaのコンテキストファイルを選んでください。');for(const entry of b.memories){if(typeof entry.content!=='string'||entry.content.length>32000)throw new Error('記憶データが不正です。');const d={id:uid(),content:entry.content,title:entry.title||'',scope:'private',confirmed:false,source:'import',createdAt:new Date().toISOString()};upsertPreview('memories',d);emitPreview('memory.updated',d);}return {imported:b.memories.length};}
 if(p==='/api/skills'){const d={...b,id:uid(),createdAt:new Date().toISOString()};upsertPreview('skills',d);emitPreview('skill.updated',d);return d;}
 if(p==='/api/mcp'){const d={...b,id:uid()};upsertPreview('mcp',d);emitPreview('mcp.updated',d);return d;}
 m=p.match(/^\/api\/(mcp|skills)\/([^/]+)$/);if(m){const list=m[1]==='skills'?'skills':'mcp';if(method==='DELETE'){previewState[list]=previewState[list].filter(x=>x.id!==m[2]);emitPreview(`${m[1]==='skills'?'skill':'mcp'}.deleted`,{id:m[2]});}else{const d=previewState[list].find(x=>x.id===m[2]);Object.assign(d,b);emitPreview('mcp.updated',d);}return {ok:true};}
 throw new Error('画面プレビューでは外部接続やPC操作を行いません。実機用ソース版で利用してください。');
}
export const bridge={
 preview:previewMode,
 on(fn){listeners.add(fn);return()=>listeners.delete(fn);},
 async init(){const snapshot=await this.request('/api/bootstrap');csrfToken=snapshot.csrf||'';if(!previewMode){stream=new EventSource(`/api/events?since=${snapshot.seq}`);stream.onmessage=e=>{try{dispatch(JSON.parse(e.data));}catch{}};stream.onerror=()=>dispatch({type:'transport.status',data:{online:false}});stream.onopen=()=>dispatch({type:'transport.status',data:{online:true}});}return snapshot;},
 async request(p,method='GET',value){if(previewMode){try{return await previewRequest(p,method,value);}catch(e){e.status||=409;throw e;}}const opts={method,credentials:'same-origin',headers:{'X-Tepora-CSRF':csrfToken}};if(value!==undefined){if(value instanceof Blob){opts.body=value;opts.headers['Content-Type']='audio/wav';}else{opts.body=JSON.stringify(value);opts.headers['Content-Type']='application/json';}}const r=await fetch(p,opts);let result;try{result=await r.json();}catch{throw new Error(`HTTP ${r.status}: 応答が読み取れません。`);}if(!r.ok)throw Object.assign(new Error(result.error||`HTTP ${r.status}`),{status:r.status});return result;},
 close(){stream?.close();}
};
