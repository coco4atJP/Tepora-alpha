import { demoArtifact } from './demo.mjs';
/** One transport contract, two explicit implementations: live localhost and offline visual preview. */
export const previewMode=location.protocol==='file:' || window.__TEPORA_PREVIEW__===true;
let csrfToken='', stream=null;
const listeners=new Set();
const dispatch=e=>{for(const fn of listeners)fn(e);};
const previewDefaults={companion:'Tepora',provider:'llama.cpp',baseUrl:'http://127.0.0.1:8080/v1',model:'',asrUrl:'',asrModel:'Qwen/Qwen3-ASR-1.7B',decisionUrl:'',decisionModel:'diffusiongemma',allowCloud:false,allowNetwork:false,shareMemory:false,voiceEnabled:true,autoAmbient:false,concurrency:2,maxSteps:8,maxTokens:2048,weatherCity:'',newsUrl:'',apiKeyEnv:'',runtimeBinary:'',modelPath:'',bravePath:''};
let saved;try{saved=JSON.parse(localStorage.getItem('tepora-preview-v3')||'null');}catch{}
let previewState={seq:0,jobs:[],artifacts:[],memories:[],messages:[],skills:[],mcp:[],settings:previewDefaults,...saved,preview:true,platform:'preview',workspace:'プレビュー内のみ'};
previewState.settings={...previewDefaults,...previewState.settings};
previewState.jobs=previewState.jobs.map(j=>['queued','running','waiting_approval'].includes(j.status)?{...j,status:'interrupted',note:'プレビューを再読み込みしました。'}:j);
const uid=()=>globalThis.crypto?.randomUUID?.()||`preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const previewTimers=new Map();
function savePreview(){try{localStorage.setItem('tepora-preview-v3',JSON.stringify(previewState));}catch{ /* file:// storage can be unavailable; keep the preview usable in memory. */ }}
function emitPreview(type,data){dispatch({seq:++previewState.seq,type,data,at:new Date().toISOString()});savePreview();}
const upsertPreview=(list,doc)=>{const index=previewState[list].findIndex(x=>x.id===doc.id);if(index>=0)previewState[list][index]=doc;else previewState[list].unshift(doc);};

async function previewRequest(p,method,b){
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
 async request(p,method='GET',value){if(previewMode)return previewRequest(p,method,value);const opts={method,credentials:'same-origin',headers:{'X-Tepora-CSRF':csrfToken}};if(value!==undefined){if(value instanceof Blob){opts.body=value;opts.headers['Content-Type']='audio/wav';}else{opts.body=JSON.stringify(value);opts.headers['Content-Type']='application/json';}}const r=await fetch(p,opts);let result;try{result=await r.json();}catch{throw new Error(`HTTP ${r.status}: 応答が読み取れません。`);}if(!r.ok)throw new Error(result.error||`HTTP ${r.status}`);return result;},
 close(){stream?.close();}
};
