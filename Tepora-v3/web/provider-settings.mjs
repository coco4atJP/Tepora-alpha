import {escape,btn,field,toggle,isTrustedForm} from './ui.mjs';
/** Progressive disclosure: all provider details live in this sheet, not on the ambient home. */
export function createProviderSettings({bridge,openSheet,closeSheet,notice,previewMode,onChanged,legacySettings}){
 let config=null,network=null,selected=null,revision=0,computer=null;
 const $=(q)=>document.querySelector(q);
 const editable=p=>Object.fromEntries(['id','name','protocol','baseUrl','model','domain','pinnedAddress','allowPlainHttp','privateContext','enabled','apiKeyEnv','capabilities','maxTokens','contextChars','timeoutMs','maxParallel','resource','reasoningEffort'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
 const options=(list,value)=>list.map(([v,label])=>`<option value="${escape(v)}" ${value===v?'selected':''}>${escape(label)}</option>`).join('');
 const presets={ollama:['Ollama','chat-completions','device','http://127.0.0.1:11434/v1'],llama:['llama.cpp','chat-completions','device','http://127.0.0.1:8080/v1'],vllm:['vLLM','chat-completions','device','http://127.0.0.1:8000/v1'],lmstudio:['LM Studio','chat-completions','device','http://127.0.0.1:1234/v1'],openai:['OpenAI','responses','cloud','https://api.openai.com/v1'],anthropic:['Anthropic','anthropic','cloud','https://api.anthropic.com/v1'],gemini:['Google Gemini','gemini','cloud','https://generativelanguage.googleapis.com/v1beta'],opencodego:['OpenCode Go','chat-completions','cloud','https://opencode.ai/zen/go/v1']};
 const roleNames={main:'主モデル',chat:'会話',work:'仕事',vision:'画像の読み取り',dictation:'ローカル音声編集'};
 async function refresh(){[config,network]=await Promise.all([bridge.request('/api/providers'),bridge.request('/api/network')]);onChanged?.({providers:config,network});}
 function draw(){
  if(!config)return;
  openSheet('知能と通信の使い分け',`<div class="network-options" role="group" aria-label="通信モード">${[['online','オンライン'],['trusted-lan','信頼LANだけ'],['offline','完全オフライン']].map(([v,l])=>`<button data-action="network-mode" data-mode="${v}" aria-pressed="${network.mode===v}">${l}</button>`).join('')}</div>
  <p class="small-text">${network.mode==='offline'?'同一PCの推論・ファイル・隔離計算を継続します。LAN・クラウド・外部サイト・通信を封じ込められないCLI等は停止します。':network.mode==='trusted-lan'?'このPCと、登録したIP・ポート・API範囲のLAN推論機だけを使います。LAN全体は許可しません。':'主モデル・代替・画像担当を自由に選べます。登録した代替先以外へは切り替えません。'}</p>
  <div class="network-web-option"><label class="toggle-row"><span><strong>インターネットを使う道具</strong><small>Web取得・専用ブラウザ・天気などの通信です。切り替えるとすぐに反映します。</small></span><input class="switch" type="checkbox" role="switch" id="internet-tools" ${network.internetTools?'checked':''}></label></div>
  <div class="offline-floor"><strong>${config.offlineFloor?.configured?'ローカルの継続先があります':'ローカルの継続先を追加してください'}</strong><p>${config.offlineFloor?.verified?'道具の往復検査を確認済み。モデルの品質・速度保証ではありません。':'オフラインになる前にモデル・依存を導入し、接続試験を行ってください。'}</p></div>
  <div class="provider-toolbar">${btn('provider-new','接続先を追加','plus','button')}${btn('provider-import-legacy','現在の単一接続を取り込む','','text-button')}</div>
  <div class="provider-list">${config.profiles.map(p=>`<article><div><strong>${escape(p.name)}</strong><small>${escape(p.model)} · ${{device:'このPC',lan:'信頼LAN',cloud:'クラウド'}[p.domain]}</small><small>${escape(p.protocol)} · ${p.probe?.ok?'道具の往復確認済み':'能力未検証'}</small></div><div>${btn('provider-edit','編集','','text-button',`data-id="${p.id}"`)}${btn('provider-probe','接続試験','','text-button',`data-id="${p.id}"`)}${btn('provider-key','認証','','text-button',`data-id="${p.id}"`)}</div></article>`).join('')||'<p class="empty-copy">名前を付けた接続先を登録すると、APIキーと能力を別々に管理できます。</p>'}</div>
  ${config.profiles.length?`<form id="route-form"><h3>役割と代替の順番</h3><p class="small-text">代替先にも依頼・文脈が届きます。画像の説明文も個人情報です。Visionの「対応」は実モデルに合わせて指定してください。</p>${Object.entries(roleNames).map(([role,label])=>{const route=config.routes[role];return `<div class="route-row"><label>${label}<select name="${role}">${role==='main'?'':'<option value="">'+(role==='vision'?'未設定':role==='dictation'?'未設定（同一PCのみ）':'主モデルを使う')+'</option>'}${options(config.profiles.filter(p=>p.enabled&& (role!=='vision'||p.capabilities.vision===true)&&(role!=='dictation'||p.domain==='device')).map(p=>[p.id,p.name]),route?.primary)}</select></label><label>許可する代替（IDをカンマ区切り）<input name="${role}-fallbacks" value="${escape(route?.fallbacks.join(', ')||'')}" placeholder="local-backup, lan-server"></label></div>`;}).join('')}<button class="button" type="submit">この経路を使う</button></form>`:''}
  <p class="small-text">通信モードはTepora管理の呼び出しに適用します。OS全体のファイアウォールではありません。既存アプリや推論サーバー自身の外部転送は別管理です。設定を変更しても進行中の仕事の送信先を無断で増やしません。</p>`,'providers');
 }
 async function open(){await refresh();draw();}
 function editor(id=null){
  selected=id;revision=config.revision;
  const p=config.profiles.find(p=>p.id===id)||{id:'',name:'',protocol:'chat-completions',baseUrl:'http://127.0.0.1:8080/v1',model:'',domain:'device',capabilities:{tools:null,vision:null,structured:null},maxParallel:1,maxTokens:4096,contextChars:96000,timeoutMs:60000,resource:'',enabled:true};
  openSheet(id?'接続先を編集':'接続先を追加',`<form id="provider-form"><label>接続のひな形<select id="provider-preset"><option value="">カスタム設定</option>${options(Object.entries(presets).map(([id,p])=>[id,p[0]]),'')}</select></label><div class="form-grid">${field('接続ID（半角英数字・ハイフン）','id',p.id)}${field('表示名','name',p.name)}
  <label>API形式<select name="protocol">${options([['chat-completions','OpenAI互換 / Ollama / llama.cpp / vLLM'],['responses','OpenAI Responses'],['anthropic','Anthropic Messages'],['gemini','Gemini generateContent']],p.protocol)}</select></label><label>信頼する範囲<select name="domain">${options([['device','このPC'],['lan','特定のLAN推論機'],['cloud','クラウド']],p.domain)}</select></label></div>
  ${field('APIベースURL','baseUrl',p.baseUrl)}${field('モデルID','model',p.model)}
  <div class="form-grid">${field('LANの固定IP（LAN指定時）','pinnedAddress',p.pinnedAddress||'','192.168.1.20')}${field('APIキー環境変数名（任意）','apiKeyEnv',p.apiKeyEnv||'')}</div>
  ${toggle('LANの平文HTTPを明示的に許可','allowPlainHttp',p.allowPlainHttp,'同じネットワーク上で通信が読まれる可能性があります。HTTPSを優先します。')}${toggle('所有LAN機に非共有の記憶を渡すことも許可','privateContext',p.domain==='lan'&&p.privateContext)}
  <div class="form-grid">${['tools','vision','structured'].map(k=>`<label>${{tools:'道具呼び出し',vision:'画像入力',structured:'構造化出力'}[k]}<select name="cap-${k}">${options([['unknown','未確認'],['true','対応'],['false','非対応']],p.capabilities[k]===null?'unknown':String(p.capabilities[k]))}</select></label>`).join('')}</div>
  <details><summary>スループットと実行予算</summary><div class="form-grid">${field('同時推論数','maxParallel',p.maxParallel,'','number')}${field('共有資源の名前','resource',p.resource||p.id,'gpu-main')}${field('最大出力トークン','maxTokens',p.maxTokens,'','number')}${field('文脈の文字数予算','contextChars',p.contextChars,'','number')}${field('応答待ち上限（ms）','timeoutMs',p.timeoutMs,'','number')}</div><p class="small-text">同じGPUを使うモデルには同じ資源名を付けます。ソフトウェア上の入場制御であり、GPUの強制割込みやASR遅延保証ではありません。</p></details>
  ${toggle('この接続先を有効にする','enabled',p.enabled,'役割に使用中の接続は、先に役割を変更してから無効にしてください。')}<button type="submit" class="button">登録する</button>${id?btn('provider-delete','この接続先を削除','','text-button',`data-id="${id}"`):''}<p class="small-text">APIキーは登録後に、この接続先専用として入力できます。保存しただけでは呼び出しません。</p></form>`,'provider-edit');
  if(id)$('[name=id]').readOnly=true;
 }
 async function keySheet(id){const p=config.profiles.find(p=>p.id===id);selected=id;
  openSheet('この接続先の認証',`<p><strong>${escape(p.name)}</strong><br>${escape(new URL(p.baseUrl).origin)}</p><form id="provider-key-form" data-identity="${p.identity}">${field('APIキー（起動中のメモリだけに保持）','key','','','password')}<button type="submit" class="button">この接続先だけに設定</button></form><p>空欄で送信するとセッションキーを削除します。環境変数を指定した場合は、その値を参照します。別の接続先へ再利用しません。</p>`,'provider-key');
 }
 async function computerSheet(){computer=await bridge.request('/api/computer');const c=computer.config;
  openSheet('コンピューター操作',`<form id="computer-form">${toggle('コンピューター操作を使う','enabled',c.enabled,'作業担当がブラウザ（とMacのアプリ）を、人と同じように操作します。')}
  <label>操作のしかた<select name="control">${options([['both','判断モデルが優先・必要なら直接操作（おすすめ）'],['decision','判断モデルだけが操作する'],['direct','作業担当が直接操作する']],c.control)}</select></label>
  <p class="small-text">判断モデル: ${computer.decision?'接続済み':'未接続 — つなぐまでは、作業担当のモデルが同じ候補から操作を選びます'}。判断モデルは画面にある操作から選ぶだけで、文章は書きません。</p>
  ${toggle('ブラウザを見えないまま動かす','headless',c.headless,'見える状態にすると操作の様子を見られ、ログインを手で済ませられます。ログインは見えないときにも引き継がれます。')}
  ${field('ブラウザの場所（空なら自動）','browserExecutable',c.browserExecutable||'',computer.browser.executable?`自動: ${computer.browser.executable}`:'Chrome / Edge / Brave / Chromium が見つかりません')}
  ${computer.desktop.supported?toggle('Macのアプリも操作する','desktop',c.desktop,'アクセシビリティの許可が必要です（システム設定 → プライバシーとセキュリティ → アクセシビリティで、Teporaを動かしているアプリを許可）。初回は操作用の小さなプログラムを組み立てます（Xcodeコマンドラインツールが必要）。'):''}
  ${field('ひとつの目標の最大手数','maxSteps',c.maxSteps,'','number')}
  <button class="button" type="submit">設定を保存</button></form><div class="sheet-actions">${btn('computer-release','ブラウザを閉じる','stop','button secondary')}${computer.desktop.supported?btn('computer-permissions','Macの許可を確かめる','','button secondary'):''}</div><div id="computer-permissions"></div>`,'computer');
 }
 const actions={
  'providers-open':open,'provider-new':()=>editor(),'provider-edit':el=>editor(el.dataset.id),'provider-key':el=>keySheet(el.dataset.id),
  'network-mode':async el=>{network=await bridge.request('/api/network','PATCH',{expectedRevision:network.revision,patch:{mode:el.dataset.mode}});onChanged?.({network});draw();},
  'network-web':async()=>{network=await bridge.request('/api/network','PATCH',{expectedRevision:network.revision,patch:{internetTools:$('#internet-tools').checked}});onChanged?.({network});draw();},
  'provider-delete':async el=>{const id=el.dataset.id;const roles=Object.entries(config.routes).filter(([,r])=>[r.primary,...r.fallbacks].includes(id)).map(([r])=>roleNames[r]);if(roles.length)throw Error('先に役割を変更してください: '+roles.join('、'));config=await bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:config.profiles.filter(p=>p.id!==id).map(editable),routes:config.routes}});onChanged?.({providers:config});draw();},
  'provider-probe':async el=>{if(previewMode)throw Error('プレビューでは実際の推論は呼びません。');notice('短い道具の往復を確認しています。');const result=await bridge.request(`/api/providers/${el.dataset.id}/probe`,'POST',{consent:true});await refresh();draw();notice(result.ok?'この接続で道具の往復を確認しました。':'確認できませんでした。');},
  'provider-import-legacy':async()=>{const s=legacySettings();if(!s.model)throw Error('先に単一接続のモデルを選んでください。');await refresh();
   const id='imported-'+(config.profiles.length+1),domain=['localhost','127.0.0.1','[::1]'].includes(new URL(s.baseUrl).hostname)?'device':'cloud';
   const p={id,name:s.model,model:s.model,baseUrl:s.baseUrl,protocol:'chat-completions',domain,apiKeyEnv:s.apiKeyEnv||'',capabilities:{text:true,tools:null,vision:null,structured:null}};
   config=await bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:[...config.profiles.map(editable),p],routes:config.profiles.length?config.routes:{main:{primary:id,fallbacks:[]}}}});onChanged?.({providers:config});draw();},
  'computer-settings':computerSheet,'computer-release':async()=>{await bridge.request('/api/computer/release','POST',{});notice('操作権を解放しました。');},
  'computer-permissions':async()=>{const r=await bridge.request('/api/computer/status','POST',{});const p=r.permissions||{};$('#computer-permissions').innerHTML=`<p class="small-text">${p.error?escape(p.error):`アクセシビリティ: ${p.trusted?'許可済み':'未許可'} · 画面収録: ${p.screen?'許可済み':'未許可（スクリーンショットに必要）'}`}</p>`;}
 };
 document.addEventListener('change',e=>{if(e.target.id==='internet-tools'){actions['network-web']().catch(err=>{e.target.checked=!e.target.checked;notice(err.message);});return;}
  if(e.target.id==='provider-preset'&&presets[e.target.value]){
  const [name,protocol,domain,url]=presets[e.target.value],form=$('#provider-form');
  form.elements.protocol.value=protocol;form.elements.domain.value=domain;form.elements.baseUrl.value=url;
  if(!selected)form.elements.id.value=e.target.value+'-'+(config.profiles.length+1);
  form.elements.name.value=name;
 }});
 document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&actions[el.dataset.action])Promise.resolve().then(()=>actions[el.dataset.action](el)).catch(err=>notice(err.message));});
 document.addEventListener('submit',e=>{const form=e.target,formId=form.getAttribute('id');if(!['provider-form','provider-key-form','route-form','computer-form'].includes(formId))return;e.preventDefault();
  if(!isTrustedForm(form))return;
  (async()=>{
   const d=Object.fromEntries(new FormData(form));
   if(formId==='provider-form'){
    const p={id:d.id,name:d.name,protocol:d.protocol,domain:d.domain,baseUrl:d.baseUrl,model:d.model,pinnedAddress:d.pinnedAddress,apiKeyEnv:d.apiKeyEnv,allowPlainHttp:!!d.allowPlainHttp,privateContext:!!d.privateContext,enabled:!!d.enabled,capabilities:{text:true,tools:d['cap-tools']==='unknown'?null:d['cap-tools']==='true',vision:d['cap-vision']==='unknown'?null:d['cap-vision']==='true',structured:d['cap-structured']==='unknown'?null:d['cap-structured']==='true'},maxParallel:Number(d.maxParallel),maxTokens:Number(d.maxTokens),contextChars:Number(d.contextChars),timeoutMs:Number(d.timeoutMs),resource:d.resource||d.id};
    const profiles=config.profiles.filter(x=>x.id!==selected).map(editable);profiles.push(p);
    config=await bridge.request('/api/providers','PUT',{expectedRevision:revision,config:{profiles,routes:config.profiles.length?config.routes:{main:{primary:p.id,fallbacks:[]}}}});
   }else if(formId==='provider-key-form'){await bridge.request(`/api/providers/${selected}/key`,'POST',{key:d.key,identity:form.dataset.identity});$('[name=key]').value='';await refresh();}
   else if(formId==='route-form'){
    const routes={};for(const role of Object.keys(roleNames))if(d[role])routes[role]={primary:d[role],fallbacks:d[`${role}-fallbacks`].split(',').map(x=>x.trim()).filter(Boolean)};
    config=await bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:config.profiles.map(editable),routes}});
   }else if(formId==='computer-form'){
    computer=await bridge.request('/api/computer','PATCH',{expectedRevision:computer.config.revision,patch:{enabled:!!d.enabled,control:d.control,headless:!!d.headless,browserExecutable:d.browserExecutable||'',desktop:!!d.desktop,maxSteps:Math.max(1,Math.min(60,Number(d.maxSteps)||12))}});onChanged?.({computer});closeSheet();return;
   }
   onChanged?.({providers:config});draw();
  })().catch(err=>notice(err.message));
 });
 return {open,computer:computerSheet};
}
