import {createPiSettings} from './pi-settings.mjs';
import {createAuthBrowser} from './auth-browser.mjs';
import {PROVIDER_PRESETS,editableProvider,providerRouteChoices,providerFallbackChoices,providerConnectionStatus} from './provider-presets.mjs';
import {escape,icon,btn,field,toggle,isTrustedForm} from './ui.mjs';
/** Progressive disclosure: all provider details live in this sheet, not on the ambient home. */
export function createProviderSettings({bridge,openSheet,closeSheet,notice,previewMode,onChanged,legacySettings,localSetup,navigate=fn=>fn()}){
 let config=null,network=null,selected=null,revision=0,computer=null;
 const $=(q)=>document.querySelector(q);
 const editable=editableProvider;
 const piSettings=createPiSettings({bridge,openSheet,notice,previewMode,onBack:()=>navigate(open),onSaved:async(next,result)=>{config=next;onChanged?.({providers:next});await open();if(result?.needsKey)await keySheet(result.id);}});
 const options=(list,value)=>list.map(([v,label])=>`<option value="${escape(v)}" ${value===v?'selected':''}>${escape(label)}</option>`).join('');
 const presets=PROVIDER_PRESETS;
 let authPoll=null,authPending=null,authGeneration=0,modelRevision=0;
 const authBrowser=createAuthBrowser({bridge,endpoint:'/api/provider-auth/open',hostId:'provider-auth-browser',action:'provider-auth-browser',previewMode,visible:()=>!!$('#provider-auth-panel')});
 const roleNames={main:'いつものAI',chat:'会話用',work:'仕事用',vision:'画像を読むAI',dictation:'音声の言い直しを整えるAI'};
 async function refresh(){[config,network]=await Promise.all([bridge.request('/api/providers'),bridge.request('/api/network')]);onChanged?.({providers:config,network});}
 const networkNote=()=>network.mode==='offline'?'同一PCの推論・ファイル・隔離計算を継続します。LAN・クラウド・外部サイト・通信を封じ込められないCLI等は停止します。':network.mode==='trusted-lan'?'このPCと、登録したIP・ポート・API範囲のLAN推論機だけを使います。LAN全体は許可しません。':'登録したAIの中で、許可した接続先だけを使います。';
 function methods(){return `<div class="connection-methods">
  <section class="connection-method">${icon('user')}<h3>アカウントでログイン</h3><p>対応するサービスのアカウントを使います。利用できる機能や上限はサービスごとに異なります。</p>${btn('pi-auth-open','サービスを選ぶ','','button secondary')}</section>
  <section class="connection-method">${icon('connect')}<h3>APIキーを使う</h3><p>サービスで発行した接続用のキーを使います。APIの利用料金がかかる場合があります。</p>${btn('pi-open','AIサービスを選ぶ','','button secondary')}</section>
  <section class="connection-method">${icon('monitor')}<h3>このPCのAIを使う</h3><p>OllamaやLM Studioなど、このPCで動くAIにつなぎます。</p>${btn('provider-local','このPCのAIを探す','','button secondary')}${btn('provider-new','URLを指定して接続','','text-button')}</section>
 </div>`;}
 function fallbackHTML(role,values,primary){
  const candidates=providerFallbackChoices(config.profiles,role,primary);
  return `<input type="hidden" name="${role}-fallbacks" value="${escape(values.filter(Boolean).join(', '))}"><ol class="connection-fallback-list">${values.map((id,index)=>`<li><span class="connection-order" aria-hidden="true">${index+1}</span><label><span class="visually-hidden">${roleNames[role]}の代わり ${index+1}</span><select data-action="route-fallback-select" data-role="${role}"><option value="">AIを選んでください</option>${!candidates.some(p=>p.id===id)&&id?`<option value="${escape(id)}" selected>${escape(config.profiles.find(p=>p.id===id)?.name||id)}（現在は選べません）</option>`:''}${candidates.map(p=>`<option value="${escape(p.id)}" ${id===p.id?'selected':''} ${values.includes(p.id)&&p.id!==id?'disabled':''}>${escape(p.name)}</option>`).join('')}</select></label>${btn('route-fallback-up','順番を上げる','back','icon-button',`data-role="${role}" data-index="${index}" aria-label="${roleNames[role]}の代わり ${index+1}を上へ" ${index===0?'disabled':''}`)}${btn('route-fallback-remove','外す','close','icon-button',`data-role="${role}" data-index="${index}" aria-label="${roleNames[role]}の代わり ${index+1}を外す"`)}</li>`).join('')}</ol>
  ${btn('route-fallback-add','代わりのAIを追加','plus','text-button',`data-role="${role}" ${values.length>=7||!candidates.some(p=>!values.includes(p.id))?'disabled':''}`)}${!candidates.length?'<p class="small-text">同じ認証・課金の範囲で使える、別のAIを登録すると選べます。</p>':''}`;
 }
 function routeRow(role){
  const route=config.routes[role],primary=route?.primary||'',choices=providerRouteChoices(config.profiles,role);
  return `<section class="connection-route"><label>${roleNames[role]}<select name="${role}" data-action="route-primary" data-role="${role}"><option value="">${role==='main'?'役割ごとに指定する':role==='vision'?'使わない':role==='dictation'?'使わない（このPCのAIのみ）':'いつものAIを使う'}</option>${options(choices.map(p=>[p.id,p.name]),primary)}</select></label><details class="connection-fallbacks"><summary>使えないときの代わりを指定</summary><p class="small-text">追加した順番で切り替えます。代わりのAIにも依頼や会話の内容が届きます。送信してよいAIだけ選んでください。</p><div data-fallback-role="${role}">${fallbackHTML(role,route?.fallbacks||[],primary)}</div></details></section>`;
 }
 function updateFallbacks(role,change){
  const host=$(`[data-fallback-role="${role}"]`);if(!host)return;
  const active=document.activeElement,restore=host.contains(active),selects=[...host.querySelectorAll('select')];
  let index=active.dataset?.index===undefined?selects.indexOf(active):Number(active.dataset.index);if(active.dataset?.action==='route-fallback-up')index--;
  const values=[...host.querySelectorAll('select')].map(el=>el.value),primary=$('#route-form').elements[role].value;
  change?.(values);host.innerHTML=fallbackHTML(role,values,primary);
  if(restore){const next=[...host.querySelectorAll('select')];(next[Math.max(0,Math.min(index,next.length-1))]||host.querySelector('button'))?.focus({preventScroll:true});}
 }
 function draw(){
  if(!config)return;
  const main=config.profiles.find(p=>p.id===config.routes.main?.primary),hasProfiles=config.profiles.length>0;
  openSheet('AIの接続',`<div class="connection-hub"><header class="connection-intro"><p class="connection-eyebrow">${hasProfiles?'登録したAIを管理':'はじめての接続'}</p><h3>${hasProfiles?'使うAIを、ここで選べます。':'どのAIを使いますか？'}</h3><p>${hasProfiles?'登録内容と確認状況を見ながら、使うAIを変更できます。':'使いたい方法を1つ選んでください。あとから別のAIを追加することもできます。'}</p></header>
  ${previewMode?'<p class="connection-preview-note">画面プレビューです。登録は設定例として保存されます。実際のログイン・APIキーの保存・AIの呼び出しは行いません。</p>':''}
  ${hasProfiles?`<section class="connection-section"><div class="connection-section-head"><h3>登録したAI</h3><span>${config.profiles.length}件</span></div><div class="provider-list connection-profiles">${config.profiles.map(p=>{const status=providerConnectionStatus(p);return `<article><div class="connection-profile-info"><div class="connection-profile-name"><strong>${escape(p.name)}</strong>${main?.id===p.id?'<span class="chip">いつものAI</span>':''}</div><p>${escape(p.model)} · ${{device:'このPC',lan:'指定したLAN',cloud:'クラウド'}[p.domain]||''}</p><p class="connection-state tone-${status.tone}"><i class="dot dot-${status.tone}"></i>${status.label}</p></div><div class="connection-profile-actions">${btn('provider-key',p.authMode==='chatgpt'||p.authMode?.startsWith('pi-')?'アカウントを管理':'APIキーを設定','','button secondary',`data-id="${escape(p.id)}"`)}${btn('provider-probe','接続をテスト','','text-button',`data-id="${escape(p.id)}"`)}</div><details class="connection-profile-details"><summary>接続の詳細・編集</summary><p class="small-text">${escape(p.baseUrl)}<br>${p.engine==='pi-ai'?'pi-ai / '+escape(p.piProvider):escape(p.protocol)}</p><div class="provider-toolbar">${btn('provider-edit','接続を編集','','button secondary',`data-id="${escape(p.id)}"`)}${btn('provider-models','モデルを変更','','text-button',`data-id="${escape(p.id)}"`)}</div></details></article>`;}).join('')}</div><p class="small-text">登録だけでは接続や応答を確認できません。「接続をテスト」は短いAIの呼び出しを行うため、料金がかかる場合があります。</p></section>
  <form id="route-form" class="connection-section"><h3>会話と仕事に使うAI</h3><p class="small-text">基本は「いつものAI」1つで使えます。変更は保存後の依頼から反映します。</p>${routeRow('main')}<details class="connection-role-options"><summary>会話・仕事・画像ごとに使い分ける</summary><div class="connection-role-grid">${Object.keys(roleNames).filter(role=>role!=='main').map(routeRow).join('')}</div></details><p class="small-text">別アカウントや、アカウント接続とAPIキー接続の間では、自動で切り替えません。</p><button class="button" type="submit">使うAIを保存</button></form>
  <details class="connection-add"><summary>別のAIを追加する</summary>${methods()}</details>`:methods()}
  <details class="connection-network"><summary>通信・オフラインの設定</summary><p class="small-text">通信モードは切り替えるとすぐに反映します。</p><div class="network-options" role="group" aria-label="通信モード">${[['online','オンライン'],['trusted-lan','信頼LANだけ'],['offline','完全オフライン']].map(([v,l])=>`<button type="button" data-action="network-mode" data-mode="${v}" aria-pressed="${network.mode===v}">${l}</button>`).join('')}</div>
  <p class="small-text" id="network-mode-note">${networkNote()}</p>
  <div class="network-web-option"><label class="toggle-row"><span><strong>インターネットを使う道具</strong><small>Web取得・専用ブラウザ・天気などの通信です。切り替えるとすぐに反映します。</small></span><input class="switch" type="checkbox" role="switch" id="internet-tools" ${network.internetTools?'checked':''}></label></div>
  <div class="offline-floor"><strong>${config.offlineFloor?.configured?'インターネットなしで使うAIを登録済み':'インターネットなしで使いたいとき'}</strong><p>${config.offlineFloor?.verified?'道具の往復検査を確認済み。モデルの品質・速度保証ではありません。':'このPCのAIを登録し、オフラインにする前に接続をテストしておくと安心です。'}</p></div>
  <p class="small-text">Teporaが管理する通信だけに適用します。OS全体のファイアウォールではありません。既存アプリや推論サーバー自身の転送は別管理です。進行中の仕事の送信先を無断で増やしません。</p></details>
  <details class="connection-legacy"><summary>以前の接続・カスタム設定</summary><p class="small-text">以前から使っている設定を続けたいときに利用できます。</p><div class="provider-toolbar">${btn('provider-new','ローカル / カスタム接続','','button secondary')}${btn('provider-auth-open','従来のChatGPT接続','connect','button secondary')}${legacySettings()?.model?btn('provider-import-legacy','以前の接続設定を取り込む','','text-button'):''}</div></details></div>`,'providers');
 }
 async function open(){await refresh();draw();}
 function editor(id=null){
  if(config.profiles.find(p=>p.id===id)?.engine==='pi-ai')return piSettings.open({id});
  selected=id;revision=config.revision;
  const p=config.profiles.find(p=>p.id===id)||{id:'connection-'+Date.now().toString(36),name:'',protocol:'chat-completions',baseUrl:'http://127.0.0.1:8080/v1',model:'',domain:'device',capabilities:{tools:null,vision:null,structured:null},maxParallel:1,maxTokens:4096,contextTokens:null,timeoutMs:60000,resource:'',enabled:true};
  openSheet(id?'接続先を編集':'URLを指定してAIを接続',`<section class="connection-editor"><header class="connection-intro"><h3>${id?'登録した接続を調整します。':'このPCや、指定したURLのAIにつなぎます。'}</h3><p>AIを動かすアプリ側で、サーバーを起動してから設定してください。</p></header><form id="provider-form"><input type="hidden" name="authMode" value="${escape(p.authMode||'api-key')}"><input type="hidden" name="accountId" value="${escape(p.accountId||'')}">${p.authMode==='chatgpt'?'<p class="small-text">ChatGPTプランの接続です。別のアカウントを使うときは、接続の一覧から追加してください。送信先とAPI形式は固定です。</p>':''}<label>使っているアプリ・サービス<select id="provider-preset"><option value="">自分で設定する</option>${options(Object.entries(presets).map(([id,p])=>[id,p[0]]),'')}</select></label>${field('このAIの名前','name',p.name,'例：このPCの会話用')}
  ${field('APIベースURL','baseUrl',p.baseUrl)}${field('モデルID','model',p.model)}
  <details class="connection-advanced"><summary>詳しい接続設定</summary>${field('接続ID（半角英数字・ハイフン）','id',p.id)}<div class="form-grid"><label>API形式<select name="protocol">${options([['chat-completions','OpenAI互換 / Ollama / llama.cpp / vLLM'],['responses','OpenAI Responses'],['anthropic','Anthropic Messages'],['gemini','Gemini generateContent']],p.protocol)}</select></label><label>信頼する範囲<select name="domain">${options([['device','このPC'],['lan','特定のLAN推論機'],['cloud','クラウド']],p.domain)}</select></label></div>
  <div class="form-grid">${field('LANの固定IP（LAN指定時）','pinnedAddress',p.pinnedAddress||'','192.168.1.20')}${field('APIキー環境変数名（任意）','apiKeyEnv',p.apiKeyEnv||'')}</div>
  ${toggle('LANの平文HTTPを明示的に許可','allowPlainHttp',p.allowPlainHttp,'同じネットワーク上で通信が読まれる可能性があります。HTTPSを優先します。')}
  <div class="form-grid">${['tools','vision','structured'].map(k=>`<label>${{tools:'道具呼び出し',vision:'画像入力',structured:'構造化出力'}[k]}<select name="cap-${k}">${options([['unknown','未確認'],['true','対応'],['false','非対応']],p.capabilities[k]===null?'unknown':String(p.capabilities[k]))}</select></label>`).join('')}</div>
  <details><summary>スループットと実行予算</summary><div class="form-grid">${field('同時推論数','maxParallel',p.maxParallel,'','number')}${field('共有資源の名前','resource',p.resource||p.id,'gpu-main')}${field('最大出力トークン','maxTokens',p.maxTokens,'','number')}${field('文脈トークン数（空欄で検出・推定）','contextTokens',p.contextTokens??'','','number')}${field('応答待ち上限（ms）','timeoutMs',p.timeoutMs,'','number')}</div><p class="small-text">同じGPUを使うモデルには同じ資源名を付けます。ソフトウェア上の入場制御であり、GPUの強制割込みやASR遅延保証ではありません。</p></details>
  ${toggle('この接続先を有効にする','enabled',p.enabled,'役割に使用中の接続は、先に役割を変更してから無効にしてください。')}${id?btn('provider-delete','この接続先を削除','','text-button',`data-id="${escape(id)}"`):''}</details><p class="small-text">登録だけではAIを呼び出しません。APIキーが必要な場合は、登録後に設定できます。</p><div class="connection-form-footer"><button type="submit" class="button">${id?'変更を保存':'登録する'}</button></div></form></section>`,'provider-edit');
  if(id)$('[name=id]').readOnly=true;
  if(p.authMode==='chatgpt')$('[name=baseUrl]').readOnly=true;
 }
 async function keySheet(id){const p=config.profiles.find(p=>p.id===id);if(p.authMode?.startsWith('pi-'))return piSettings.auth(p.piProvider);if(p.authMode==='chatgpt')return authSheet();selected=id;
  openSheet('APIキーを設定',`<section class="connection-editor"><header class="connection-intro"><h3>${escape(p.name)}</h3><p>${escape(new URL(p.baseUrl).origin)}</p></header>${previewMode?'<p class="connection-preview-note">プレビューではAPIキーを入力・保存できません。実際のAPIキーは入力しないでください。</p>':''}<form id="provider-key-form" data-identity="${p.identity}"><label class="field"><span>このAI専用のAPIキー</span><input name="key" type="password" autocomplete="off" ${previewMode?'disabled placeholder="実サービスで設定できます"':''}></label><p class="small-text">この接続先だけで使い、別のAIには再利用しません。${p.keyPresent?'空欄で保存すると、現在のAPIキーが削除されます。':''}</p><div class="connection-form-footer"><button type="submit" class="button" ${previewMode?'disabled':''}>この接続先だけに設定</button></div></form><details><summary>保存・削除について</summary><p class="small-text">空欄で送信すると保存したキーを削除します。環境変数を指定した場合は、その値を参照します。APIキーはこのPCのSQLiteに保存され、OSキーチェーン暗号化は未対応です。</p></details></section>`,'provider-key');
 }
 async function authSheet(state=null,g=authGeneration){
  clearTimeout(authPoll);
  if(previewMode)throw Error('プレビューではOAuthログインや実アカウント接続は行いません。');
  if(!state){g=++authGeneration;authBrowser.reset();try{state=await bridge.request('/api/provider-auth');}catch{throw Error('このホストではChatGPT認証を利用できません。通常の npm start またはデスクトップ版を使用してください。');}}
  if(g!==authGeneration)return;authPending=state.pending;
  const pending=state.pending,busy=['pending','exchanging'].includes(pending?.status);
  openSheet('ChatGPTプランの接続',`<section id="provider-auth-panel"><p>${escape(state.note)}</p>
  <p class="small-text">Tepora自身のツール実行・記憶・会話を使います。Codexの認証ファイルは読み取りません。認証情報はこのPCの専用ファイルに保存し、画面・エクスポート・ログには含めません。</p>
  ${state.supported&&!busy?btn('provider-auth-start','Continue with ChatGPT','connect','button'):''}
  ${busy?`<p role="status">${pending.status==='exchanging'?'アカウントと利用権限を確認しています。':'ブラウザーでログインと利用権限の許可を完了してください。'}</p><div id="provider-auth-browser"></div>${btn('provider-auth-cancel','ログインを取り消す','','text-button')}`:''}
  ${pending?.error?`<p role="status">${escape(pending.error)}</p>`:''}
  <div class="provider-list">${state.accounts.map(a=>`<article><div><strong>${escape(a.label)}</strong><small>${a.connected?'ChatGPTプランに接続済み':'未接続'}${a.error?' · '+escape(a.error):''}</small></div><div>${a.connected?btn('provider-auth-models','モデルを選ぶ','','button secondary',`data-id="${escape(a.id)}"`):''}${!busy?btn('provider-auth-start','再ログイン','','text-button',`data-id="${escape(a.id)}"`):''}${a.connected?btn('provider-auth-disconnect','ログアウト','','text-button',`data-id="${escape(a.id)}"`):''}</div></article>`).join('')}</div>
  <p class="small-text">ログアウトしても登録IDを保持し、同じ登録で再ログインできます。ChatGPT内の利用上限やクレジット設定はChatGPT側で管理します。ローカル資格情報は暗号化キーチェーンではありません。OSユーザー領域のアクセス権で保護してください。</p></section>`,'provider-auth');
  authBrowser.update(pending,pending?.canOpenBrowser);
  if(busy)authPoll=setTimeout(async()=>{if(g!==authGeneration||!$('#provider-auth-panel'))return;try{const next=await bridge.request('/api/provider-auth');if(g===authGeneration&&$('#provider-auth-panel'))await authSheet(next,g);}catch(e){notice(e.message);}},1500);
 }
 async function modelSheet({accountId=null,profileId=null}={}){
  if(previewMode)throw Error('プレビューではモデル一覧の外部取得は行いません。');
  await refresh();modelRevision=config.revision;const p=profileId?config.profiles.find(p=>p.id===profileId):null;
  const response=profileId?await bridge.request(`/api/providers/${profileId}/models`,'POST',{consent:true,identity:p.identity}):await bridge.request(`/api/provider-auth/${accountId}/models`,'POST',{consent:true});
  const models=response.models||[];
  openSheet('接続先のモデルを選ぶ',`<p class="small-text">${escape(response.note||'一覧は能力・利用資格の保証ではありません。')}</p>${models.length?`<form id="provider-model-form" data-profile="${escape(profileId||'')}" data-account="${escape(accountId||p?.accountId||'')}"><label>利用するモデル<select name="model" required>${options(models.map(m=>[m.id,m.name+' · '+m.id]),p?.model||models[0].id)}</select></label>${field('接続先の表示名','name',p?.name||'ChatGPTプラン')}<button type="submit" class="button">このモデルを登録</button></form>`:'<p>表示できるモデルがありません。アカウントの利用条件・権限を確認してください。</p>'}`,'provider-model');
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
  'provider-local':()=>localSetup?localSetup():editor(),
  'route-fallback-add':el=>updateFallbacks(el.dataset.role,values=>values.push('')),
  'route-fallback-remove':el=>updateFallbacks(el.dataset.role,values=>values.splice(Number(el.dataset.index),1)),
  'route-fallback-up':el=>updateFallbacks(el.dataset.role,values=>{const i=Number(el.dataset.index);if(i>0)[values[i-1],values[i]]=[values[i],values[i-1]];}),
  'provider-auth-open':()=>authSheet(),
  'provider-auth-start':async el=>{if(previewMode)throw Error('プレビューではログインしません。');const g=authGeneration,panel=$('#provider-auth-panel'),result=await bridge.request('/api/provider-auth/start','POST',{consent:true,accountId:el.dataset.id||null});if(g!==authGeneration||$('#provider-auth-panel')!==panel)return;authBrowser.started(result.id);const state=await bridge.request('/api/provider-auth');if(g===authGeneration&&$('#provider-auth-panel'))await authSheet(state,g);},
  'provider-auth-browser':()=>authBrowser.open(),
  'provider-auth-cancel':async()=>{authBrowser.reset();const g=authGeneration;try{await bridge.request('/api/provider-auth/cancel','POST',{id:authPending?.id});if(g===authGeneration&&$('#provider-auth-panel')){const state=await bridge.request('/api/provider-auth');if(g===authGeneration&&$('#provider-auth-panel'))await authSheet(state,g);}}finally{if(g===authGeneration&&$('#provider-auth-panel'))authBrowser.update(authPending,authPending?.canOpenBrowser);}},
  'provider-auth-models':el=>modelSheet({accountId:el.dataset.id}),
  'provider-auth-disconnect':async el=>{const result=await bridge.request(`/api/provider-auth/${el.dataset.id}/disconnect`,'POST',{});await authSheet();notice(result.note);},
  'provider-models':el=>config.profiles.find(p=>p.id===el.dataset.id)?.engine==='pi-ai'?piSettings.open({id:el.dataset.id}):modelSheet({profileId:el.dataset.id}),
  'providers-open':()=>navigate(open),'provider-new':()=>editor(),'provider-edit':el=>editor(el.dataset.id),'provider-key':el=>keySheet(el.dataset.id),
  'network-mode':async el=>{network=await bridge.request('/api/network','PATCH',{expectedRevision:network.revision,patch:{mode:el.dataset.mode}});onChanged?.({network});document.querySelectorAll('[data-action=network-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===network.mode)));const note=$('#network-mode-note');if(note)note.textContent=networkNote();},
  'network-web':async()=>{network=await bridge.request('/api/network','PATCH',{expectedRevision:network.revision,patch:{internetTools:$('#internet-tools').checked}});onChanged?.({network});},
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
  if(e.target.dataset?.action==='route-fallback-select')updateFallbacks(e.target.dataset.role);
  if(e.target.dataset?.action==='route-primary')updateFallbacks(e.target.dataset.role,values=>{for(let i=values.length-1;i>=0;i--)if(values[i]===e.target.value)values.splice(i,1);});
  if(e.target.id==='provider-preset'&&presets[e.target.value]){
  const [name,protocol,domain,url]=presets[e.target.value],form=$('#provider-form');
  form.elements.authMode.value='api-key';form.elements.accountId.value='';form.elements.baseUrl.readOnly=false;form.elements.apiKeyEnv.value='';
  form.elements.protocol.value=protocol;form.elements.domain.value=domain;form.elements.baseUrl.value=url;
  if(!selected)form.elements.id.value=e.target.value+'-'+(config.profiles.length+1);
  form.elements.name.value=name;
 }});
 document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&actions[el.dataset.action])Promise.resolve().then(()=>actions[el.dataset.action](el)).catch(err=>notice(err.message));});
 document.addEventListener('submit',e=>{const form=e.target,formId=form.getAttribute('id');if(!['provider-form','provider-key-form','provider-model-form','route-form','computer-form'].includes(formId))return;e.preventDefault();
  if(!isTrustedForm(form))return;
  (async()=>{
   const d=Object.fromEntries(new FormData(form));
   if(formId==='provider-form'){
    const previous=config.profiles.find(x=>x.id===selected)||{};
    const p={...editable(previous),authMode:d.authMode,...(d.authMode==='chatgpt'?{accountId:d.accountId}:{accountId:undefined}),id:d.id,name:d.name,protocol:d.protocol,domain:d.domain,baseUrl:d.baseUrl,model:d.model,pinnedAddress:d.pinnedAddress,apiKeyEnv:d.apiKeyEnv,allowPlainHttp:!!d.allowPlainHttp,enabled:!!d.enabled,capabilities:{text:true,tools:d['cap-tools']==='unknown'?null:d['cap-tools']==='true',vision:d['cap-vision']==='unknown'?null:d['cap-vision']==='true',structured:d['cap-structured']==='unknown'?null:d['cap-structured']==='true'},maxParallel:Number(d.maxParallel),maxTokens:Number(d.maxTokens),contextTokens:d.contextTokens.trim()?Number(d.contextTokens):null,timeoutMs:Number(d.timeoutMs),resource:d.resource||d.id};
    const profiles=config.profiles.filter(x=>x.id!==selected).map(editable);profiles.push(p);
    config=await bridge.request('/api/providers','PUT',{expectedRevision:revision,config:{profiles,routes:config.profiles.length?config.routes:{main:{primary:p.id,fallbacks:[]}}}});
   }else if(formId==='provider-model-form'){
    const existing=config.profiles.find(p=>p.id===form.dataset.profile);
    const id=existing?.id||'chatgpt-'+Date.now().toString(36);
    const p=existing?{...editable(existing),name:d.name,model:d.model}:{id,name:d.name,model:d.model,authMode:'chatgpt',accountId:form.dataset.account,protocol:'responses',baseUrl:'https://api.openai.com/v1',domain:'cloud'};
    config=await bridge.request('/api/providers','PUT',{expectedRevision:modelRevision,config:{profiles:[...config.profiles.filter(x=>x.id!==id).map(editable),p],routes:config.profiles.length?config.routes:{main:{primary:id,fallbacks:[]}}}});
   }else if(formId==='provider-key-form'){await bridge.request(`/api/providers/${selected}/key`,'POST',{key:d.key,identity:form.dataset.identity});$('[name=key]').value='';await refresh();}
   else if(formId==='route-form'){
    if(!d.main&&!d.chat&&!d.work)throw Error('いつものAIを選ぶか、会話用・仕事用のAIを指定してください。');
    const routes=Object.fromEntries(Object.entries(config.routes).filter(([role])=>!Object.hasOwn(roleNames,role)));for(const role of Object.keys(roleNames))if(d[role])routes[role]={primary:d[role],fallbacks:d[`${role}-fallbacks`].split(',').map(x=>x.trim()).filter(Boolean)};
    config=await bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:config.profiles.map(editable),routes}});
   }else if(formId==='computer-form'){
    computer=await bridge.request('/api/computer','PATCH',{expectedRevision:computer.config.revision,patch:{enabled:!!d.enabled,control:d.control,headless:!!d.headless,browserExecutable:d.browserExecutable||'',desktop:!!d.desktop,maxSteps:Math.max(1,Math.min(60,Number(d.maxSteps)||12))}});onChanged?.({computer});closeSheet();return;
   }
   onChanged?.({providers:config});draw();
  })().catch(err=>notice(err.message));
 });
 return {open,computer:computerSheet};
}
