import {escape,btn} from './ui.mjs';
const setupGiB=n=>(n/1e9).toFixed(1)+' GB';
/** First-run UI; state comes from the service and survives UI close/reopen. */
export function createOnboarding({bridge,openSheet,closeSheet,isOpen,notice,onConnected,advanced}){
 let snapshot=null,loading=false,lastError='';
 function statusHTML(t){
  if(!t)return '';
  const busy=['downloading','checking'].includes(t.status),percent=t.totalBytes?Math.min(99,Math.round(100*t.completedBytes/t.totalBytes)):null;
  return `<section class="setup-progress" aria-live="polite"><strong>${escape(t.model)}</strong><p>${escape(t.note)}</p>
   ${busy?`<progress ${percent===null?'':`value="${percent}" max="100"`} aria-label="モデル取得"></progress><small>${setupGiB(t.completedBytes||0)}${t.totalBytes?' / '+setupGiB(t.totalBytes):' · サイズを確認中'}</small>`:''}
   ${t.recovery?`<small>${escape(t.recovery)}</small>`:''}${busy?btn('setup-stop','取得を中断する','','button secondary'):''}</section>`;
 }
 function content(){
  if(!snapshot)return '<p role="status">現在の状態を確認しています。</p>';
  const connected=snapshot.verified;
  const candidates=(snapshot.candidates||[]).map(c=>`<button class="setup-choice" data-action="setup-select" data-id="${escape(c.id)}" ${loading?'disabled':''}><span><strong>${escape(c.model)}</strong><small>${escape(c.name)} · このPC${c.bytes?' · '+setupGiB(c.bytes):''}</small></span><span>確認して使う →</span></button>`).join('');
  const engines=snapshot.engines||[],transfer=snapshot.transfer,busy=loading||['downloading','checking'].includes(transfer?.status);
  return `<p class="setup-lead">${connected?'つながりました。今度は、あなたの用事を一つ。':'AIの準備はここで。まず、このPCで使えるものを探します。'}</p>
   <div id="setup-error" class="setup-error" role="alert" ${lastError?'':'hidden'}>${escape(lastError)}</div>
   ${connected?`<section class="setup-connected"><span aria-hidden="true">✓</span><div><strong>${escape(snapshot.model)}</strong><p>道具を呼び、戻り値を利用できることを確認しました。仕事の品質は結果で確かめます。</p></div></section>
    <div class="onboard-actions">${btn('setup-done','自分の依頼を始める','arrow','button')}${btn('setup-first-file','メモを添えて頼む','file','button secondary')}</div>`:''}
   <div class="setup-options">${btn('setup-scan',loading?'確認しています…':'このPCのAIを探す','refresh','button secondary',loading?'disabled':'')}${btn('setup-advanced','自分の接続先を使う','','text-button')}</div>
   ${candidates?`<div class="setup-candidates">${candidates}</div>`:snapshot.scanned?'<p class="small-text">起動済みのモデルが見つかりませんでした。既存のAIアプリを起動して、もう一度探せます。</p>':''}
   ${engines.length&&!connected?`<details class="setup-download" ${candidates?'':'open'}><summary>ローカルモデルを取得する</summary><p>Ollamaのライブラリから取得します。個人の会話やファイルは送りません。保存先・取得済み部分はOllamaが管理します。</p>
    <small>現在のメモリ: 約${snapshot.ramGiB} GiB。取得サイズと推論に必要なメモリは異なります。以下はサイズの選択肢で、性能評価の順位ではありません。</small>
    ${snapshot.catalog.map(c=>`<div class="setup-download-option"><div><strong>${escape(c.label)}</strong><small>${escape(c.model)} · 約${setupGiB(c.approxBytes)}</small></div>${btn('setup-install',`約${setupGiB(c.approxBytes)}を取得する`,'download','button secondary',`data-engine="${escape(engines[0].id)}" data-catalog="${escape(c.id)}" ${busy?'disabled':''}`)}</div>`).join('')}
    </details>`:''}
   <div id="setup-progress">${statusHTML(transfer)}</div>
   ${!engines.length&&!candidates&&!connected?`<div class="setup-install-help"><p>AIを動かすアプリがない場合、初回だけOllamaなどの導入が必要です。この版は、OSへの自動インストールまでは行いません。</p>${btn('setup-install-help','Ollamaの公式導入ページを開く','external','text-button')}</div>`:''}
   <div class="setup-footer">${btn('setup-dismiss','今は時計として使う','','text-button')}<small>接続、マイク、添付ファイルの利用は、それぞれ必要なときに選べます。</small></div>`;
 }
 function paint(){if(isOpen())openSheet('Teporaを使い始める',content(),'setup');}
 async function run(fn){loading=true;lastError='';paint();try{await fn();}catch(e){lastError=e.message||'準備を完了できませんでした。';}finally{loading=false;paint();}}
 async function open(){openSheet('Teporaを使い始める',content(),'setup');await run(async()=>{snapshot=await bridge.request('/api/setup');});}
 const actions={
  'setup-scan':()=>run(async()=>{snapshot={...await bridge.request('/api/setup/scan','POST',{}),scanned:true};}),
  'setup-select':el=>run(async()=>{await bridge.request('/api/setup/select','POST',{candidateId:el.dataset.id,consentTest:true});snapshot=await bridge.request('/api/setup');await onConnected(snapshot);}),
  'setup-install':el=>run(async()=>{await bridge.request('/api/setup/install','POST',{engineId:el.dataset.engine,catalogId:el.dataset.catalog,consentDownload:true});snapshot=await bridge.request('/api/setup');}),
  'setup-stop':()=>run(async()=>{await bridge.request('/api/setup/stop','POST',{});snapshot=await bridge.request('/api/setup');}),
  'setup-dismiss':async()=>{await bridge.request('/api/setup/dismiss','POST',{});closeSheet();},
  'setup-done':async()=>{await bridge.request('/api/setup/dismiss','POST',{});closeSheet();document.querySelector('#composer-input')?.focus();},
  'setup-first-file':async()=>{await bridge.request('/api/setup/dismiss','POST',{});closeSheet();document.querySelector('[data-action=attach]')?.click();},
  'setup-advanced':()=>advanced(),
  'setup-install-help':()=>run(async()=>{const r=await bridge.request('/api/setup/install-help','POST',{});notice(r.note);})
 };
 document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b||!isOpen()||!actions[b.dataset.action])return;Promise.resolve(actions[b.dataset.action](b)).catch(e=>notice(e.message));});
 bridge.on(e=>{
  if(e.type==='setup.updated'){snapshot={...e.data,scanned:snapshot?.scanned};paint();}
  if(e.type==='setup.transfer'){
   if(snapshot)snapshot.transfer=e.data;
   const host=isOpen()?document.querySelector('#setup-progress'):null;if(host)host.innerHTML=statusHTML(e.data);
  }
 });
 return {open};
}
